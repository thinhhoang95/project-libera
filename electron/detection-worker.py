# Libera's YOLOE-26 worker: runs Ultralytics in the Python runtime Libera
# installs (src/lib/detection/runtime.ts). The Next server starts it with the
# weights folder as its working directory and sends one JSON request per line
# on stdin; each reply is one JSON line on stdout. Ultralytics' own output is
# moved to stderr so it never mixes with the replies.
#
# Requests:
#   {"id": 1, "op": "info"}
#   {"id": 2, "op": "detect", "weights": "yoloe-26s-seg.pt", "device": "cpu",
#    "image": "/tmp/photo.jpg", "imageSize": 640, "confidence": 0.25, "iou": 0.7,
#    "maxDetections": 300,
#    "prompts": [{"type": "text", "text": "red blood cell"},
#                {"type": "visual", "image": "/tmp/ref.png", "boxes": [[x1, y1, x2, y2]]}]}
#
# Each prompt becomes one class: its index in "prompts" is the "cls" of the
# detections it finds. Text prompts are embedded with MobileCLIP2-B; a visual
# prompt's boxes are examples of one object in its reference image, embedded
# together by YOLOE's visual prompt encoder.

import json
import os
import sys
import time
import traceback

replies = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr
# -I ignores PYTHONIOENCODING; Windows would read prompts in its ANSI code page.
sys.stdin.reconfigure(encoding="utf-8")

os.environ.setdefault("YOLO_AUTOINSTALL", "false")
os.environ.setdefault("YOLO_OFFLINE", "true")


def reply(message):
    replies.write(json.dumps(message, separators=(",", ":")) + "\n")
    replies.flush()


def main():
    import cv2
    import numpy as np
    import torch
    import ultralytics
    from ultralytics import YOLOE
    from ultralytics.models.yolo.yoloe import YOLOEVPSegPredictor

    try:
        from ultralytics import settings

        settings.update({"sync": False})
    except Exception:
        pass

    models = {}
    text_embeddings = {}

    def load(weights, device):
        key = (weights, device)
        if key not in models:
            # One model in memory at a time: switching variants frees the last.
            models.clear()
            text_embeddings.clear()
            model = YOLOE(weights)
            model.model.to(device)
            models[key] = model
        return models[key]

    def embed_texts(model, weights, texts):
        missing = [text for text in dict.fromkeys(texts) if (weights, text) not in text_embeddings]
        if missing:
            embeddings = model.get_text_pe(missing)
            for index, text in enumerate(missing):
                text_embeddings[(weights, text)] = embeddings[:, index : index + 1].detach()
        return [text_embeddings[(weights, text)] for text in texts]

    def embed_visual(model, device, prompt):
        boxes = np.array(prompt["boxes"], dtype=np.float32).reshape(-1, 4)
        if not len(boxes):
            raise ValueError("A visual prompt needs at least one box.")
        predictor = YOLOEVPSegPredictor(
            overrides={"task": "segment", "mode": "predict", "save": False, "batch": 1, "verbose": False, "device": device}
        )
        predictor.set_prompts({"bboxes": boxes, "cls": np.zeros(len(boxes), dtype=np.int64)})
        predictor.setup_model(model=model.model, verbose=False)
        return predictor.get_vpe(prompt["image"]).detach()

    def simplify(polygon):
        if len(polygon) < 8:
            return polygon
        contour = polygon.reshape(-1, 1, 2).astype(np.float32)
        return cv2.approxPolyDP(contour, 0.75, True).reshape(-1, 2)

    def detect(request):
        device = request.get("device") or "cpu"
        if device == "mps" and not torch.backends.mps.is_available():
            raise ValueError("Apple's GPU (MPS) is not available to PyTorch on this computer. Choose the CPU in Preferences.")
        if device == "cuda" and not torch.cuda.is_available():
            raise ValueError("No NVIDIA GPU (CUDA) is available to PyTorch on this computer. Choose the CPU in Preferences.")
        weights = request["weights"]
        prompts = request["prompts"]
        if not prompts:
            raise ValueError("Add at least one prompt.")

        started = time.perf_counter()
        model = load(weights, device)
        loaded = time.perf_counter()

        embeddings = [None] * len(prompts)
        texts = [(index, prompt["text"]) for index, prompt in enumerate(prompts) if prompt["type"] == "text"]
        if texts:
            for (index, _), embedding in zip(texts, embed_texts(model, weights, [text for _, text in texts])):
                embeddings[index] = embedding
        for index, prompt in enumerate(prompts):
            if prompt["type"] == "visual":
                embeddings[index] = embed_visual(model, device, prompt)
        reference = embeddings[0]
        prompt_embeddings = torch.cat([embedding.to(reference.device, reference.dtype) for embedding in embeddings], dim=1)
        model.set_classes([f"prompt{index}" for index in range(len(prompts))], prompt_embeddings)
        embedded = time.perf_counter()

        result = model.predict(
            request["image"],
            conf=float(request.get("confidence", 0.25)),
            iou=float(request.get("iou", 0.7)),
            imgsz=int(request.get("imageSize", 640)),
            max_det=int(request.get("maxDetections", 300)),
            device=device,
            verbose=False,
        )[0]
        finished = time.perf_counter()

        detections = []
        boxes = result.boxes
        polygons = result.masks.xy if result.masks is not None else []
        for index in range(len(boxes)):
            polygon = simplify(polygons[index]) if index < len(polygons) else np.zeros((0, 2))
            detections.append(
                {
                    "cls": int(boxes.cls[index].item()),
                    "confidence": round(float(boxes.conf[index].item()), 4),
                    "box": [round(float(value), 2) for value in boxes.xyxy[index].tolist()],
                    "polygon": [[round(float(x), 1), round(float(y), 1)] for x, y in polygon.tolist()],
                }
            )
        height, width = result.orig_shape
        return {
            "width": int(width),
            "height": int(height),
            "detections": detections,
            "timing": {
                "loadMs": round((loaded - started) * 1000, 1),
                "promptMs": round((embedded - loaded) * 1000, 1),
                "inferenceMs": round((finished - embedded) * 1000, 1),
                "speed": {key: round(float(value), 1) for key, value in (result.speed or {}).items()},
            },
        }

    def info(_request):
        return {
            "ultralytics": ultralytics.__version__,
            "torch": torch.__version__,
            "python": sys.version.split()[0],
            "mps": bool(torch.backends.mps.is_available()),
            "cuda": bool(torch.cuda.is_available()),
        }

    handlers = {"detect": detect, "info": info}
    reply({"id": 0, "ok": True, "result": {"ready": True}})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = {}
        try:
            request = json.loads(line)
            handler = handlers.get(request.get("op"))
            if handler is None:
                raise ValueError(f"Unknown request: {request.get('op')}")
            reply({"id": request.get("id"), "ok": True, "result": handler(request)})
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            reply({"id": request.get("id"), "ok": False, "error": str(error) or type(error).__name__})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        reply({"id": 0, "ok": False, "error": f"The detection runtime could not start: {error}"})
        sys.exit(1)
