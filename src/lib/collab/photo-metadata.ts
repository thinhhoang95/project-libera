// Removes location and camera details from photos before they leave this
// device in a shared album (unless the album keeps them). Lossless: metadata
// blocks are dropped from the container, the image data is copied as it is.
// A JPEG's orientation is kept (as a minimal EXIF block), so the photo does
// not turn on its side.
//
// No dependencies, so the collab host can use it as well as Next.

const JPEG_SOI = 0xffd8;

/** JPEG markers dropped: APP1 (EXIF, XMP), APP2–APP15 except APP2 ICC and APP14 Adobe, COM. */
function dropJpegSegment(marker: number, payload: Uint8Array): boolean {
  if (marker === 0xfe) return true;
  if (marker === 0xe1) return true;
  if (marker === 0xe2) return !startsWithAscii(payload, "ICC_PROFILE\0");
  if (marker === 0xee) return false;
  return marker >= 0xe3 && marker <= 0xef;
}

function startsWithAscii(bytes: Uint8Array, text: string, offset = 0): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  return true;
}

/** EXIF orientation (1–8) from an APP1 payload, or 1. */
export function exifOrientation(payload: Uint8Array): number {
  if (!startsWithAscii(payload, "Exif\0\0")) return 1;
  const tiff = 6;
  if (payload.length < tiff + 8) return 1;
  const little = payload[tiff] === 0x49 && payload[tiff + 1] === 0x49;
  const big = payload[tiff] === 0x4d && payload[tiff + 1] === 0x4d;
  if (!little && !big) return 1;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > payload.length) return 1;
  const count = u16(ifd);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > payload.length) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** An APP1 segment (marker included) holding only the orientation tag. */
function orientationSegment(orientation: number): Uint8Array {
  // "Exif\0\0" + TIFF header (II*, offset 8) + IFD0 with one entry + next-IFD 0.
  const body = [
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00,
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ];
  const length = body.length + 2;
  return Uint8Array.from([0xff, 0xe1, length >> 8, length & 0xff, ...body]);
}

function stripJpeg(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 4 || ((bytes[0] << 8) | bytes[1]) !== JPEG_SOI) return null;
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let orientation = 1;
  let changed = false;
  let scanned = false;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    // Fill bytes before a marker.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Start of scan: the rest is image data (and anything after EOI, kept as is).
    if (marker === 0xda) {
      parts.push(bytes.subarray(offset));
      scanned = true;
      break;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(bytes.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    const payload = bytes.subarray(offset + 4, offset + 2 + length);
    if (dropJpegSegment(marker, payload)) {
      if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(payload);
      changed = true;
    } else {
      parts.push(bytes.subarray(offset, offset + 2 + length));
    }
    offset += 2 + length;
  }
  // Without image data the file is not one this understands: leave it alone.
  if (!changed || !scanned) return null;
  if (orientation !== 1) parts.splice(1, 0, orientationSegment(orientation));
  const result = concat(parts);
  // A photo stripped before holds just the orientation block it would get again.
  return sameBytes(result, bytes) ? null : result;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Text, EXIF and time chunks; image, color and animation chunks stay. */
const PNG_DROPPED = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

function stripPng(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 8 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let changed = false;
  let ended = false;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return null;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (PNG_DROPPED.has(type)) changed = true;
    else parts.push(bytes.subarray(offset, end));
    offset = end;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  return changed && ended ? concat(parts) : null;
}

function stripWebp(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 12 || !startsWithAscii(bytes, "RIFF") || !startsWithAscii(bytes, "WEBP", 8)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [];
  let changed = false;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size + (size % 2);
    if (offset + 8 + size > bytes.length) return null;
    if (type === "EXIF" || type === "XMP ") changed = true;
    else parts.push(bytes.subarray(offset, Math.min(end, bytes.length)));
    offset = end;
  }
  if (!changed) return null;
  const chunks = concat(parts);
  // VP8X flags say which optional chunks exist: clear EXIF (0x08) and XMP (0x04).
  if (startsWithAscii(chunks, "VP8X")) chunks[8] &= ~0x0c;
  const result = new Uint8Array(12 + chunks.length);
  result.set(bytes.subarray(0, 12));
  result.set(chunks, 12);
  new DataView(result.buffer).setUint32(4, result.length - 8, true);
  return result;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * The photo without location, camera and text details, or null when there
 * is nothing to remove (or the format is not one this understands: GIFs
 * carry none worth removing).
 */
export function stripPhotoMetadata(bytes: Uint8Array, mime: string): Uint8Array | null {
  try {
    switch (mime) {
      case "image/jpeg":
        return stripJpeg(bytes);
      case "image/png":
        return stripPng(bytes);
      case "image/webp":
        return stripWebp(bytes);
      default:
        return null;
    }
  } catch {
    return null;
  }
}
