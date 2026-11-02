// Preferences → General → Homepage illustrations: the set picker, the set
// editor and the crop dialog. Loaded by setup.html, which calls load() with
// the state from main and sends payload() with the other preferences on
// Save; nothing is written before then. Images added here are cropped to the
// 3:1 cover in the renderer and sent as JPEG data URLs with the picture they
// were cut from (see electron/notebook-illustration-store.cjs).
//
// The crop is kept like the gallery's photo editor keeps it (CropRect in
// src/lib/photo-edits.ts): a rectangle of the source in 0–1 coordinates. The
// interaction differs: the 3:1 frame stays put and the picture pans and zooms
// under it, zooming about the pointer as the image viewer does.
(() => {
  const COVER_WIDTH = 2172;
  const COVER_HEIGHT = 724;
  const ASPECT = COVER_WIDTH / COVER_HEIGHT;
  const MAX_SOURCE_SIDE = 3200;
  const MAX_ZOOM = 8;
  const MAX_IMAGES = 200;

  const icon = (paths, size = 14) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICONS = {
    sparkles: icon('<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>'),
    landmark: icon('<path d="M3 22h18"/><path d="M6 18v-7"/><path d="M10 18v-7"/><path d="M14 18v-7"/><path d="M18 18v-7"/><path d="M12 2 20 7H4z"/>'),
    images: icon('<path d="M18 22H4a2 2 0 0 1-2-2V6"/><path d="m22 13-1.296-1.296a2.41 2.41 0 0 0-3.408 0L11 18"/><circle cx="12" cy="8" r="2"/><rect width="16" height="16" x="6" y="2" rx="2"/>'),
    plus: icon('<path d="M12 5v14M5 12h14"/>', 22),
    plusSmall: icon('<path d="M12 5v14M5 12h14"/>'),
    image: icon('<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>', 22),
    check: icon('<path d="M20 6 9 17l-5-5"/>', 11),
    crop: icon('<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>'),
    left: icon('<path d="m15 18-6-6 6-6"/>'),
    right: icon('<path d="m9 18 6-6-6-6"/>'),
    trash: icon('<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>'),
    upload: icon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>', 26),
  };

  const band = document.querySelector("#illustration-set-band");
  const statusLine = document.querySelector("#illustration-status");
  const setDialog = document.querySelector("#illustration-set-dialog");
  const setTitle = setDialog.querySelector("#illustration-set-title span");
  const setNameInput = document.querySelector("#illustration-set-name");
  const setCount = document.querySelector("#illustration-set-count");
  const setGrid = document.querySelector("#illustration-set-grid");
  const setError = document.querySelector("#illustration-set-error");
  const fileInput = document.querySelector("#illustration-set-files");
  const cropDialog = document.querySelector("#illustration-crop-dialog");
  const stage = document.querySelector("#illustration-crop-stage");
  const canvas = stage.querySelector("canvas");
  const zoomInput = document.querySelector("#illustration-crop-zoom");
  const zoomValue = document.querySelector("#illustration-crop-zoom-value");

  let builtIns = [];
  /** The user's sets: { id, name, images: [{ id, crop, preview, image?, source? }] }. */
  let sets = [];
  let selected = "";
  /** The default set: main sends it first among the built-ins. */
  const defaultSet = () => builtIns[0] ?? null;

  function randomId(length = 16) {
    const bytes = new Uint8Array(length / 2);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function setStatus(message) {
    statusLine.textContent = message;
  }

  const allSets = () => [...builtIns, ...sets];
  const findSet = (id) => allSets().find((set) => set.id === id);
  const plural = (count) => `${count} ${count === 1 ? "illustration" : "illustrations"}`;

  // ---- Picker ---------------------------------------------------------------

  function imageElement(src, alt = "") {
    const image = document.createElement("img");
    image.alt = alt;
    image.decoding = "async";
    image.draggable = false;
    image.src = src;
    return image;
  }

  function setPreview(set) {
    const preview = document.createElement("span");
    preview.className = "illustration-set-preview";
    preview.setAttribute("aria-hidden", "true");
    const [first, ...rest] = set.images;
    if (first) preview.append(imageElement(first.preview));
    else {
      const blank = document.createElement("span");
      blank.className = "illustration-set-blank";
      blank.innerHTML = ICONS.image;
      preview.append(blank);
    }
    if (rest.length) {
      const strip = document.createElement("span");
      strip.className = "illustration-set-strip";
      const shown = rest.length > 4 ? rest.slice(0, 3) : rest;
      for (const image of shown) strip.append(imageElement(image.preview));
      if (rest.length > 4) {
        const more = document.createElement("span");
        more.textContent = `+${rest.length - 3}`;
        strip.append(more);
      }
      preview.append(strip);
    }
    return preview;
  }

  function render() {
    const tiles = allSets().map((set) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "illustration-set-tile";
      tile.dataset.setId = set.id;
      tile.setAttribute("role", "radio");
      tile.setAttribute("aria-checked", String(set.id === selected));
      tile.setAttribute("aria-label", `${set.name}, ${plural(set.images.length)}`);
      tile.tabIndex = set.id === selected ? 0 : -1;
      tile.title = set.builtIn ? `${set.name} (built-in)` : `${set.name}. Double-click to edit; right-click for more.`;
      const meta = document.createElement("span");
      meta.className = "illustration-set-meta";
      const name = document.createElement("span");
      name.className = "illustration-set-name";
      name.textContent = set.name;
      const count = document.createElement("span");
      count.className = "illustration-set-count";
      count.textContent = String(set.images.length);
      meta.innerHTML = set.id === "vietnamese-monuments" ? ICONS.landmark : set.builtIn ? ICONS.sparkles : ICONS.images;
      meta.append(name, count);
      const check = document.createElement("span");
      check.className = "editor-theme-check";
      check.setAttribute("aria-hidden", "true");
      check.innerHTML = ICONS.check;
      tile.append(setPreview(set), meta, check);
      return tile;
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "illustration-set-tile illustration-set-add";
    add.dataset.action = "new";
    add.title = "New set from your own images";
    add.innerHTML = `<span class="illustration-set-preview" aria-hidden="true">${ICONS.plus}</span><span class="illustration-set-meta">${ICONS.plusSmall}<span class="illustration-set-name">New set</span></span>`;
    band.replaceChildren(...tiles, add);
  }

  function select(id) {
    selected = id;
    render();
    band.querySelector(`[data-set-id="${CSS.escape(id)}"]`)?.focus();
    const set = findSet(id);
    if (set) setStatus(`Notebooks will use “${set.name}” once you save.`);
  }

  function deleteSet(set) {
    sets = sets.filter((candidate) => candidate.id !== set.id);
    const wasSelected = selected === set.id;
    if (wasSelected) selected = defaultSet()?.id ?? "";
    render();
    setStatus(`Deleted “${set.name}”${wasSelected && defaultSet() ? `; notebooks go back to ${defaultSet().name}` : ""}. Its images are removed when you save.`);
  }

  // A native menu, like the editor themes': callbacks stay here, only ids cross IPC.
  async function openMenu(set, x, y, returnFocus) {
    const items = [];
    const actions = new Map();
    const item = (id, label, action) => {
      items.push({ id, label });
      actions.set(id, action);
    };
    item("use", set.id === selected ? "In Use" : "Use for Notebooks", () => select(set.id));
    if (!set.builtIn) {
      items.push({ type: "separator" });
      item("edit", "Edit…", () => openSetEditor(set));
      item("delete", "Delete", () => deleteSet(set));
    }
    let picked = null;
    try {
      picked = await window.liberaMenu?.popup({ items, x: Math.round(x), y: Math.round(y) }) ?? null;
    } catch {
      return;
    }
    actions.get(picked)?.();
    if (document.activeElement === document.body) returnFocus?.focus();
  }

  band.addEventListener("click", (event) => {
    const tile = event.target.closest(".illustration-set-tile");
    if (!tile) return;
    if (tile.dataset.action === "new") openSetEditor(null);
    else select(tile.dataset.setId);
  });
  band.addEventListener("dblclick", (event) => {
    const set = findSet(event.target.closest(".illustration-set-tile")?.dataset.setId);
    if (set && !set.builtIn) openSetEditor(set);
  });
  band.addEventListener("contextmenu", (event) => {
    const tile = event.target.closest(".illustration-set-tile[data-set-id]");
    if (!tile) return;
    event.preventDefault();
    void openMenu(findSet(tile.dataset.setId), event.clientX, event.clientY, tile);
  });
  band.addEventListener("keydown", (event) => {
    const tile = event.target.closest(".illustration-set-tile[data-set-id]");
    if (!tile) return;
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const rect = tile.getBoundingClientRect();
      void openMenu(findSet(tile.dataset.setId), rect.left, rect.bottom + 4, tile);
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && !findSet(tile.dataset.setId)?.builtIn) {
      event.preventDefault();
      deleteSet(findSet(tile.dataset.setId));
      return;
    }
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const ids = allSets().map((set) => set.id);
    select(ids[(ids.indexOf(tile.dataset.setId) + step + ids.length) % ids.length]);
  });

  // ---- Images ---------------------------------------------------------------

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("This image could not be opened."));
      image.src = src;
    });
  }

  function toJpeg(drawable, width, height, sx = 0, sy = 0, sw = drawable.width, sh = drawable.height, quality = 0.9) {
    const output = document.createElement("canvas");
    output.width = width;
    output.height = height;
    const context = output.getContext("2d");
    // Transparent pixels would turn black in a JPEG.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = "high";
    context.drawImage(drawable, sx, sy, sw, sh, 0, 0, width, height);
    return output.toDataURL("image/jpeg", quality);
  }

  /** A picked file as the source to crop from, upright and at most MAX_SOURCE_SIDE wide or tall. */
  async function readSource(file) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      throw new Error(`“${file.name}” could not be opened as an image.`);
    }
    try {
      const scale = Math.min(1, MAX_SOURCE_SIDE / Math.max(bitmap.width, bitmap.height));
      const dataUrl = toJpeg(bitmap, Math.round(bitmap.width * scale), Math.round(bitmap.height * scale), 0, 0, bitmap.width, bitmap.height, 0.92);
      return { dataUrl, image: await loadImage(dataUrl) };
    } finally {
      bitmap.close();
    }
  }

  /** The largest centered 3:1 crop, as zoom 1 shows it. */
  function centeredCrop(width, height) {
    const imageAspect = width / height;
    if (imageAspect > ASPECT) {
      const cropWidth = ASPECT / imageAspect;
      return { x: (1 - cropWidth) / 2, y: 0, width: cropWidth, height: 1 };
    }
    const cropHeight = imageAspect / ASPECT;
    return { x: 0, y: (1 - cropHeight) / 2, width: 1, height: cropHeight };
  }

  function renderCover(image, crop) {
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    return toJpeg(image, COVER_WIDTH, COVER_HEIGHT, crop.x * width, crop.y * height, crop.width * width, crop.height * height);
  }

  // ---- Set editor -------------------------------------------------------------

  /** The set being edited: a working copy, applied on "Save set". */
  let draft = null;

  function openSetEditor(set) {
    draft = set
      ? { id: set.id, isNew: false, name: set.name, images: set.images.map((image) => ({ ...image })) }
      : { id: `custom-${randomId(12)}`, isNew: true, name: "", images: [] };
    setTitle.textContent = set ? `Edit “${set.name}”` : "New illustration set";
    setNameInput.value = draft.name;
    setError.textContent = "";
    renderDraft();
    setDialog.showModal();
    setNameInput.focus();
  }

  function closeSetEditor() {
    draft = null;
    setGrid.replaceChildren();
    if (setDialog.open) setDialog.close();
  }

  function renderDraft() {
    setCount.textContent = draft.images.length
      ? `${plural(draft.images.length)}. Notebooks take one at random.`
      : "Add a few images to start the set.";
    const items = draft.images.map((image, index) => {
      const item = document.createElement("div");
      item.className = "illustration-item";
      item.dataset.index = String(index);
      const picture = imageElement(image.preview, `Illustration ${index + 1}`);
      picture.title = "Click to pan, zoom and crop";
      picture.dataset.action = "crop";
      const badge = document.createElement("span");
      badge.className = "illustration-item-badge";
      badge.textContent = String(index + 1);
      const actions = document.createElement("div");
      actions.className = "illustration-item-actions";
      const button = (action, label, svg, disabled = false) => {
        const element = document.createElement("button");
        element.type = "button";
        element.dataset.action = action;
        element.setAttribute("aria-label", label);
        element.title = label;
        element.innerHTML = svg;
        element.disabled = disabled;
        return element;
      };
      actions.append(
        button("left", "Move earlier", ICONS.left, index === 0),
        button("right", "Move later", ICONS.right, index === draft.images.length - 1),
        button("crop", "Pan, zoom and crop", ICONS.crop),
        button("remove", "Remove from set", ICONS.trash),
      );
      item.append(picture, badge, actions);
      return item;
    });
    if (!draft.images.length) {
      const drop = document.createElement("button");
      drop.type = "button";
      drop.className = "illustration-drop";
      drop.dataset.action = "add";
      drop.innerHTML = `${ICONS.upload}<strong>Drop images here, or choose files</strong><span class="field-help">PNG, JPEG, WebP, GIF or AVIF. Wide pictures work best.</span>`;
      items.push(drop);
    }
    setGrid.replaceChildren(...items);
  }

  async function addFiles(files) {
    const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    setError.textContent = "";
    const room = MAX_IMAGES - draft.images.length;
    if (room <= 0) {
      setError.textContent = `A set can hold up to ${MAX_IMAGES} illustrations.`;
      return;
    }
    const failures = [];
    const added = [];
    setCount.textContent = `Adding ${plural(Math.min(room, images.length))}…`;
    for (const file of images.slice(0, room)) {
      try {
        const source = await readSource(file);
        const crop = centeredCrop(source.image.naturalWidth, source.image.naturalHeight);
        const cover = renderCover(source.image, crop);
        const entry = { id: randomId(), crop, preview: cover, image: cover, source: source.dataUrl };
        draft?.images.push(entry);
        added.push({ entry, image: source.image });
      } catch (error) {
        failures.push(error.message);
      }
    }
    if (!draft) return;
    renderDraft();
    if (images.length > room) failures.push(`Only the first ${room} were added; a set can hold up to ${MAX_IMAGES}.`);
    setError.textContent = failures.join(" ");
    // A single picture goes straight to the crop; several are centered and can be adjusted one by one.
    if (added.length === 1) await cropImage(added[0].entry, added[0].image);
  }

  /** Opens the crop dialog for one of the draft's images. */
  async function cropImage(entry, loaded) {
    let image = loaded;
    let source = entry.source;
    let crop = entry.crop;
    if (!image) {
      try {
        if (!source) {
          const stored = await window.liberaSetup?.readNotebookIllustrationSource?.(draft.id, entry.id);
          if (!stored) throw new Error("The original picture for this illustration was not found.");
          source = stored.dataUrl;
          // Without its original, an older illustration is cropped from the cover itself.
          if (stored.cropped) crop = null;
        }
        image = await loadImage(source);
      } catch (error) {
        setError.textContent = error.message;
        return;
      }
    }
    const result = await openCropper(image, crop ?? centeredCrop(image.naturalWidth, image.naturalHeight));
    if (!result || !draft) return;
    const index = draft.images.indexOf(entry);
    if (index < 0) return;
    const cover = renderCover(image, result);
    // Main stores JPEG only.
    if (!source.startsWith("data:image/jpeg")) source = toJpeg(image, image.naturalWidth, image.naturalHeight, 0, 0, image.naturalWidth, image.naturalHeight, 0.92);
    // A new id keeps the app from showing a cached copy of the old crop.
    draft.images[index] = { id: randomId(), crop: result, preview: cover, image: cover, source };
    renderDraft();
  }

  setGrid.addEventListener("click", (event) => {
    const control = event.target.closest("[data-action]");
    if (!control || !draft) return;
    if (control.dataset.action === "add") {
      fileInput.click();
      return;
    }
    const index = Number(control.closest(".illustration-item")?.dataset.index);
    const entry = draft.images[index];
    if (!entry) return;
    switch (control.dataset.action) {
      case "crop":
        void cropImage(entry);
        break;
      case "remove":
        draft.images.splice(index, 1);
        renderDraft();
        break;
      case "left":
      case "right": {
        const target = index + (control.dataset.action === "left" ? -1 : 1);
        [draft.images[index], draft.images[target]] = [draft.images[target], draft.images[index]];
        renderDraft();
        setGrid.querySelector(`[data-index="${target}"] [data-action="${control.dataset.action}"]`)?.focus();
        break;
      }
    }
  });
  setGrid.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    setGrid.classList.add("dragging");
  });
  setGrid.addEventListener("dragleave", (event) => {
    if (!setGrid.contains(event.relatedTarget)) setGrid.classList.remove("dragging");
  });
  setGrid.addEventListener("drop", (event) => {
    event.preventDefault();
    setGrid.classList.remove("dragging");
    if (event.dataTransfer?.files.length) void addFiles(event.dataTransfer.files);
  });
  document.querySelector("#illustration-set-add").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = "";
    void addFiles(files);
  });

  function saveDraft() {
    const name = setNameInput.value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60);
    if (!name) {
      setError.textContent = "Give the set a name.";
      setNameInput.focus();
      return;
    }
    if (!draft.images.length) {
      setError.textContent = "Add at least one image.";
      return;
    }
    const saved = { id: draft.id, name, images: draft.images };
    const index = sets.findIndex((set) => set.id === draft.id);
    if (index >= 0) sets[index] = saved;
    else sets.push(saved);
    const isNew = draft.isNew;
    closeSetEditor();
    if (isNew) select(saved.id);
    else render();
    setStatus(`${isNew ? "Added" : "Updated"} “${name}”. Save Preferences to apply it.`);
  }

  document.querySelector("#illustration-set-done").addEventListener("click", saveDraft);
  document.querySelector("#illustration-set-cancel").addEventListener("click", closeSetEditor);
  document.querySelector("#illustration-set-close").addEventListener("click", closeSetEditor);
  setDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeSetEditor();
  });
  setNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveDraft();
    }
  });

  // ---- Crop dialog ----------------------------------------------------------

  /** The view: the picture's center under the frame in 0–1 coordinates, and the zoom over a cover fit. */
  let view = null;
  let resolveCrop = null;

  function frame() {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const frameWidth = Math.min(width - 48, (height - 56) * ASPECT);
    const frameHeight = frameWidth / ASPECT;
    return { x: (width - frameWidth) / 2, y: (height - frameHeight) / 2, width: frameWidth, height: frameHeight };
  }

  /** Pixels per source pixel at zoom 1: the picture just covers the frame. */
  function coverScale(rect) {
    return Math.max(rect.width / view.image.naturalWidth, rect.height / view.image.naturalHeight);
  }

  function clampView() {
    view.zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom));
    const rect = frame();
    const scale = coverScale(rect) * view.zoom;
    const halfWidth = rect.width / (view.image.naturalWidth * scale) / 2;
    const halfHeight = rect.height / (view.image.naturalHeight * scale) / 2;
    view.cx = Math.min(1 - halfWidth, Math.max(halfWidth, view.cx));
    view.cy = Math.min(1 - halfHeight, Math.max(halfHeight, view.cy));
  }

  function cropFromView() {
    const rect = frame();
    const scale = coverScale(rect) * view.zoom;
    const width = rect.width / (view.image.naturalWidth * scale);
    const height = rect.height / (view.image.naturalHeight * scale);
    const clamp = (value, size) => Math.min(1 - size, Math.max(0, value));
    return { x: clamp(view.cx - width / 2, width), y: clamp(view.cy - height / 2, height), width, height };
  }

  function drawCropper() {
    if (!view) return;
    const ratio = window.devicePixelRatio || 1;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const rect = frame();
    const scale = coverScale(rect) * view.zoom;
    const imageWidth = view.image.naturalWidth * scale;
    const imageHeight = view.image.naturalHeight * scale;
    const left = rect.x + rect.width / 2 - view.cx * imageWidth;
    const top = rect.y + rect.height / 2 - view.cy * imageHeight;
    context.imageSmoothingQuality = "high";
    context.drawImage(view.image, left, top, imageWidth, imageHeight);
    // The gallery crop's look: the outside dimmed, a white frame with a rule-of-thirds grid.
    context.fillStyle = "rgba(0, 0, 0, 0.55)";
    context.beginPath();
    context.rect(0, 0, width, height);
    context.rect(rect.x, rect.y + rect.height, rect.width, -rect.height);
    context.fill("evenodd");
    context.strokeStyle = "rgba(255, 255, 255, 0.3)";
    context.lineWidth = 1;
    context.beginPath();
    for (const fraction of [1 / 3, 2 / 3]) {
      context.moveTo(rect.x + rect.width * fraction, rect.y);
      context.lineTo(rect.x + rect.width * fraction, rect.y + rect.height);
      context.moveTo(rect.x, rect.y + rect.height * fraction);
      context.lineTo(rect.x + rect.width, rect.y + rect.height * fraction);
    }
    context.stroke();
    context.strokeStyle = "rgba(255, 255, 255, 0.92)";
    context.lineWidth = 1.5;
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    zoomInput.value = String(view.zoom);
    zoomValue.textContent = `${Math.round(view.zoom * 100)}%`;
  }

  /** Zooms keeping the picture point under (clientX, clientY), or the frame's middle, still. */
  function zoomTo(value, clientX, clientY) {
    const rect = frame();
    const bounds = stage.getBoundingClientRect();
    const pointX = clientX === undefined ? rect.x + rect.width / 2 : clientX - bounds.left;
    const pointY = clientY === undefined ? rect.y + rect.height / 2 : clientY - bounds.top;
    const before = coverScale(rect) * view.zoom;
    const imageX = view.cx + (pointX - rect.x - rect.width / 2) / (view.image.naturalWidth * before);
    const imageY = view.cy + (pointY - rect.y - rect.height / 2) / (view.image.naturalHeight * before);
    view.zoom = Math.min(MAX_ZOOM, Math.max(1, value));
    const after = coverScale(rect) * view.zoom;
    view.cx = imageX - (pointX - rect.x - rect.width / 2) / (view.image.naturalWidth * after);
    view.cy = imageY - (pointY - rect.y - rect.height / 2) / (view.image.naturalHeight * after);
    clampView();
    drawCropper();
  }

  function panBy(dx, dy) {
    const scale = coverScale(frame()) * view.zoom;
    view.cx -= dx / (view.image.naturalWidth * scale);
    view.cy -= dy / (view.image.naturalHeight * scale);
    clampView();
    drawCropper();
  }

  function openCropper(image, crop) {
    // The zoom a crop stands for does not depend on the frame's size.
    const zoom = 1 / (crop.width * image.naturalWidth * Math.max(1 / image.naturalWidth, 1 / (ASPECT * image.naturalHeight)));
    view = { image, zoom, cx: crop.x + crop.width / 2, cy: crop.y + crop.height / 2, initial: crop };
    cropDialog.showModal();
    clampView();
    drawCropper();
    stage.focus();
    return new Promise((resolve) => { resolveCrop = resolve; });
  }

  function closeCropper(result) {
    const resolve = resolveCrop;
    resolveCrop = null;
    view = null;
    if (cropDialog.open) cropDialog.close();
    resolve?.(result);
  }

  let drag = null;
  stage.addEventListener("pointerdown", (event) => {
    if (!view || event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    panBy(event.clientX - drag.x, event.clientY - drag.y);
    drag.x = event.clientX;
    drag.y = event.clientY;
  });
  const endDrag = (event) => {
    if (drag?.id === event.pointerId) drag = null;
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("wheel", (event) => {
    if (!view) return;
    event.preventDefault();
    // Pinch on a trackpad arrives as a ctrl-wheel with small deltas.
    const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0025));
    zoomTo(view.zoom * factor, event.clientX, event.clientY);
  }, { passive: false });
  stage.addEventListener("dblclick", (event) => {
    if (view) zoomTo(view.zoom < 2 ? view.zoom * 2 : 1, event.clientX, event.clientY);
  });
  stage.addEventListener("keydown", (event) => {
    if (!view) return;
    const step = event.shiftKey ? 40 : 10;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[event.key]) {
      event.preventDefault();
      panBy(...moves[event.key]);
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomTo(view.zoom * 1.2);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomTo(view.zoom / 1.2);
    } else if (event.key === "Enter") {
      event.preventDefault();
      closeCropper(cropFromView());
    }
  });
  zoomInput.addEventListener("input", () => view && zoomTo(Number(zoomInput.value)));
  document.querySelector("#illustration-crop-zoom-in").addEventListener("click", () => view && zoomTo(view.zoom * 1.25));
  document.querySelector("#illustration-crop-zoom-out").addEventListener("click", () => view && zoomTo(view.zoom / 1.25));
  document.querySelector("#illustration-crop-reset").addEventListener("click", () => {
    if (!view) return;
    view.zoom = 1;
    view.cx = 0.5;
    view.cy = 0.5;
    clampView();
    drawCropper();
  });
  document.querySelector("#illustration-crop-apply").addEventListener("click", () => closeCropper(cropFromView()));
  document.querySelector("#illustration-crop-cancel").addEventListener("click", () => closeCropper(null));
  document.querySelector("#illustration-crop-close").addEventListener("click", () => closeCropper(null));
  cropDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeCropper(null);
  });
  new ResizeObserver(() => {
    if (!view) return;
    clampView();
    drawCropper();
  }).observe(stage);

  // ---- With the rest of Preferences ------------------------------------------

  window.liberaIllustrationPreferences = {
    load(builtInSets, preferences) {
      builtIns = (Array.isArray(builtInSets) ? builtInSets : []).map((set) => ({
        ...set,
        builtIn: true,
        images: set.images.filter((image) => image.thumbnail).map((image) => ({ id: image.id, preview: image.thumbnail })),
      }));
      sets = (Array.isArray(preferences?.sets) ? preferences.sets : []).map((set) => ({
        id: set.id,
        name: set.name,
        images: set.images.map((image) => ({ id: image.id, crop: image.crop, preview: image.thumbnail })),
      }));
      selected = allSets().some((set) => set.id === preferences?.selected) ? preferences.selected : defaultSet()?.id ?? "";
      setStatus("");
      render();
    },
    /** What Save sends: new and re-cropped images carry their JPEGs. */
    payload() {
      return {
        version: 1,
        selected,
        sets: sets.map((set) => ({
          id: set.id,
          name: set.name,
          images: set.images.map(({ id, crop, image, source }) => (image ? { id, crop, image, source } : { id, crop })),
        })),
      };
    },
  };
})();
