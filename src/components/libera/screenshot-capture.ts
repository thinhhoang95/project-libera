import type { PdfAnnotationRect } from "@/lib/types";

export const SCREENSHOT_IMAGE_TYPE = "image/png";

export function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Could not create screenshot image."));
        }
      }, SCREENSHOT_IMAGE_TYPE);
    } catch (error) {
      reject(error);
    }
  });
}

export function screenshotFileName(filePath: string, context: string) {
  const fileName = filePath.split("/").at(-1) ?? "screenshot";
  const stem = fileName.replace(/\.[^.]+$/, "") || "screenshot";
  const safeStem = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "screenshot";
  const safeContext = context
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "snip";
  const timestamp = new Date()
    .toISOString()
    .replace(/\.\d+z$/i, "")
    .replace(/[^0-9t]/gi, "");

  return `${safeStem}-${safeContext}-${timestamp}.png`;
}

export function pngFileFromBlob(blob: Blob, filePath: string, context: string) {
  return new File([blob], screenshotFileName(filePath, context), {
    type: SCREENSHOT_IMAGE_TYPE,
  });
}

export async function imageElementRectToPngFile(
  image: HTMLImageElement,
  rect: PdfAnnotationRect,
  filePath: string,
) {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) {
    throw new Error("Image is not ready for screenshot capture.");
  }

  const sourceX = Math.min(
    image.naturalWidth - 1,
    Math.round(rect.x * image.naturalWidth),
  );
  const sourceY = Math.min(
    image.naturalHeight - 1,
    Math.round(rect.y * image.naturalHeight),
  );
  const sourceWidth = Math.max(
    1,
    Math.min(
      image.naturalWidth - sourceX,
      Math.round(rect.width * image.naturalWidth),
    ),
  );
  const sourceHeight = Math.max(
    1,
    Math.min(
      image.naturalHeight - sourceY,
      Math.round(rect.height * image.naturalHeight),
    ),
  );
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Could not create screenshot canvas.");
  }

  canvas.width = sourceWidth;
  canvas.height = sourceHeight;
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );

  return pngFileFromBlob(await canvasToPngBlob(canvas), filePath, "image-snip");
}
