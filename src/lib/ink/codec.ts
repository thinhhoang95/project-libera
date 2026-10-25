import {
  INK_FORMAT,
  INK_VERSION,
  isHexColor,
  isInkLineStyle,
  type InkAuthorFile,
  type InkFrame,
  type InkRect,
  type InkSample,
  type InkSource,
  type InkStroke,
} from "@/lib/ink/types";

/*
 * Packed samples: a header, then each sample as zig-zag LEB128 deltas from the
 * previous one, base64-encoded. About 5–7 bytes a sample instead of ~40 as
 * JSON objects.
 *
 *   byte 0   encoding (1)
 *   byte 1   flags: 1 = tilt, 2 = time
 *   varint   sample count
 *   per sample: dx, dy, dpressure, [dtiltX, dtiltY], [dt]
 *
 * x and y are quantized to 1/20 unit (0.05 pt on PDFs), pressure to 1/255,
 * tilt to whole degrees and time to whole milliseconds.
 */

const ENCODING = 1;
const FLAG_TILT = 1;
const FLAG_TIME = 2;
export const INK_XY_SCALE = 20;
const PRESSURE_SCALE = 255;
/** Longer strokes are refused; a minute of continuous writing is ~15,000 samples. */
export const MAX_INK_SAMPLES = 50_000;
/** Coordinates beyond this many units are corrupt, not drawn. */
const MAX_COORDINATE = 1_000_000;

export class InkCodecError extends Error {}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_INDEX = new Int16Array(128).fill(-1);
for (let index = 0; index < BASE64.length; index += 1) BASE64_INDEX[BASE64.charCodeAt(index)] = index;

function toBase64(bytes: Uint8Array) {
  let out = "";
  let index = 0;

  for (; index + 2 < bytes.length; index += 3) {
    const value = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    out += BASE64[value >> 18] + BASE64[(value >> 12) & 63] + BASE64[(value >> 6) & 63] + BASE64[value & 63];
  }

  const rest = bytes.length - index;
  if (rest === 1) {
    const value = bytes[index] << 16;
    out += `${BASE64[value >> 18]}${BASE64[(value >> 12) & 63]}==`;
  } else if (rest === 2) {
    const value = (bytes[index] << 16) | (bytes[index + 1] << 8);
    out += `${BASE64[value >> 18]}${BASE64[(value >> 12) & 63]}${BASE64[(value >> 6) & 63]}=`;
  }

  return out;
}

function fromBase64(text: string) {
  const clean = text.replace(/=+$/, "");
  if (clean.length % 4 === 1) throw new InkCodecError("Ink points are not valid base64.");
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;

  for (let index = 0; index < clean.length; index += 1) {
    const code = clean.charCodeAt(index);
    const value = code < 128 ? BASE64_INDEX[code] : -1;
    if (value < 0) throw new InkCodecError("Ink points are not valid base64.");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset] = (buffer >> bits) & 255;
      offset += 1;
    }
  }

  return bytes;
}

class ByteWriter {
  private bytes = new Uint8Array(64);
  length = 0;

  private ensure(extra: number) {
    if (this.length + extra <= this.bytes.length) return;
    const next = new Uint8Array(Math.max(this.bytes.length * 2, this.length + extra));
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
  }

  byte(value: number) {
    this.ensure(1);
    this.bytes[this.length] = value;
    this.length += 1;
  }

  unsigned(value: number) {
    this.ensure(8);
    let rest = value;
    while (rest >= 128) {
      this.bytes[this.length] = (rest % 128) | 128;
      this.length += 1;
      rest = Math.floor(rest / 128);
    }
    this.bytes[this.length] = rest;
    this.length += 1;
  }

  signed(value: number) {
    this.unsigned(value < 0 ? -value * 2 - 1 : value * 2);
  }

  done() {
    return this.bytes.subarray(0, this.length);
  }
}

class ByteReader {
  offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  byte() {
    if (this.offset >= this.bytes.length) throw new InkCodecError("Ink points end early.");
    const value = this.bytes[this.offset];
    this.offset += 1;
    return value;
  }

  unsigned() {
    let value = 0;
    let scale = 1;
    for (let count = 0; count < 8; count += 1) {
      const byte = this.byte();
      value += (byte & 127) * scale;
      if (byte < 128) return value;
      scale *= 128;
    }
    throw new InkCodecError("Ink points hold an oversized number.");
  }

  signed() {
    const value = this.unsigned();
    return value % 2 ? -(value + 1) / 2 : value / 2;
  }

  get done() {
    return this.offset === this.bytes.length;
  }
}

const quantize = (value: number, scale: number) => Math.round(value * scale);

/** Packs samples. Tilt and time are kept only when every sample has them. */
export function encodeInkSamples(samples: readonly InkSample[]) {
  if (samples.length > MAX_INK_SAMPLES) throw new InkCodecError("The stroke has too many samples.");
  const tilt = samples.length > 0 && samples.every((sample) => Number.isFinite(sample.tiltX) && Number.isFinite(sample.tiltY));
  const time = samples.length > 0 && samples.every((sample) => Number.isFinite(sample.t));
  const writer = new ByteWriter();
  writer.byte(ENCODING);
  writer.byte((tilt ? FLAG_TILT : 0) | (time ? FLAG_TIME : 0));
  writer.unsigned(samples.length);
  let x = 0;
  let y = 0;
  let pressure = 0;
  let tiltX = 0;
  let tiltY = 0;
  let t = 0;

  for (const sample of samples) {
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y) || Math.abs(sample.x) > MAX_COORDINATE || Math.abs(sample.y) > MAX_COORDINATE) {
      throw new InkCodecError("A stroke sample is out of range.");
    }
    const nextX = quantize(sample.x, INK_XY_SCALE);
    const nextY = quantize(sample.y, INK_XY_SCALE);
    const nextPressure = quantize(Math.min(1, Math.max(0, Number.isFinite(sample.pressure) ? sample.pressure : 0.5)), PRESSURE_SCALE);
    writer.signed(nextX - x);
    writer.signed(nextY - y);
    writer.signed(nextPressure - pressure);
    x = nextX;
    y = nextY;
    pressure = nextPressure;

    if (tilt) {
      const nextTiltX = Math.round(Math.min(90, Math.max(-90, sample.tiltX!)));
      const nextTiltY = Math.round(Math.min(90, Math.max(-90, sample.tiltY!)));
      writer.signed(nextTiltX - tiltX);
      writer.signed(nextTiltY - tiltY);
      tiltX = nextTiltX;
      tiltY = nextTiltY;
    }

    if (time) {
      // Coalesced events can arrive out of order by a fraction of a millisecond.
      const nextT = Math.max(t, Math.round(sample.t!));
      writer.unsigned(nextT - t);
      t = nextT;
    }
  }

  return toBase64(writer.done());
}

export function decodeInkSamples(packed: string): InkSample[] {
  if (typeof packed !== "string" || !packed) throw new InkCodecError("A stroke has no points.");
  const reader = new ByteReader(fromBase64(packed));
  if (reader.byte() !== ENCODING) throw new InkCodecError("Ink points use an unknown encoding.");
  const flags = reader.byte();
  const count = reader.unsigned();
  if (count > MAX_INK_SAMPLES) throw new InkCodecError("The stroke has too many samples.");
  const tilt = (flags & FLAG_TILT) !== 0;
  const time = (flags & FLAG_TIME) !== 0;
  const samples: InkSample[] = new Array(count);
  let x = 0;
  let y = 0;
  let pressure = 0;
  let tiltX = 0;
  let tiltY = 0;
  let t = 0;

  for (let index = 0; index < count; index += 1) {
    x += reader.signed();
    y += reader.signed();
    pressure += reader.signed();
    if (Math.abs(x) > MAX_COORDINATE * INK_XY_SCALE || Math.abs(y) > MAX_COORDINATE * INK_XY_SCALE || pressure < 0 || pressure > PRESSURE_SCALE) {
      throw new InkCodecError("A stroke sample is out of range.");
    }
    const sample: InkSample = { x: x / INK_XY_SCALE, y: y / INK_XY_SCALE, pressure: pressure / PRESSURE_SCALE };
    if (tilt) {
      tiltX += reader.signed();
      tiltY += reader.signed();
      sample.tiltX = tiltX;
      sample.tiltY = tiltY;
    }
    if (time) {
      t += reader.unsigned();
      sample.t = t;
    }
    samples[index] = sample;
  }

  if (!reader.done) throw new InkCodecError("Ink points have trailing bytes.");
  return samples;
}

const decoded = new WeakMap<InkStroke, InkSample[]>();

/** A stroke's samples, decoded once per stroke object. */
export function strokeSamples(stroke: InkStroke) {
  let samples = decoded.get(stroke);
  if (!samples) {
    samples = decodeInkSamples(stroke.points);
    decoded.set(stroke, samples);
  }
  return samples;
}

export function sampleBounds(samples: readonly InkSample[]): InkRect {
  if (!samples.length) return { x: 0, y: 0, width: 0, height: 0 };
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const { x, y } of samples) {
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// ---- Normalizing files read from disk -------------------------------------

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const INK_ID = /^[a-z0-9_-]{1,64}$/i;

export function isInkId(value: unknown): value is string {
  return typeof value === "string" && INK_ID.test(value);
}

function normalizeRect(value: unknown): InkRect | null {
  if (!isObject(value)) return null;
  const { x, y, width, height } = value;
  return finite(x) && finite(y) && finite(width) && finite(height) && width >= 0 && height >= 0 ? { x, y, width, height } : null;
}

/**
 * A stroke as read from disk, or null when it cannot be drawn. Unknown fields
 * and brushes are kept, so a newer Libera's ink survives an older one.
 */
export function normalizeInkStroke(value: unknown): InkStroke | null {
  if (!isObject(value)) return null;
  const { id, brush, color, opacity, width, lineStyle, points, createdAt } = value;
  if (!isInkId(id) || typeof brush !== "string" || !brush || !isHexColor(color) || !finite(width) || width <= 0 || width > 10_000) return null;
  if (typeof points !== "string") return null;
  let samples: InkSample[];
  try { samples = decodeInkSamples(points); } catch { return null; }
  if (!samples.length) return null;

  const stroke: InkStroke = {
    ...value,
    id,
    brush,
    color,
    opacity: finite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1,
    width,
    lineStyle: isInkLineStyle(lineStyle) ? lineStyle : "solid",
    points,
    bounds: normalizeRect(value.bounds) ?? sampleBounds(samples),
    createdAt: typeof createdAt === "string" ? createdAt : new Date(0).toISOString(),
  } as InkStroke;
  if (value.anchor !== undefined) {
    const space = isObject(value.anchor) && typeof value.anchor.space === "string" ? value.anchor.space : undefined;
    if (space) stroke.anchor = { ...(value.anchor as Json), space };
    else delete stroke.anchor;
  }
  if (value.group !== undefined && !isInkId(value.group)) delete stroke.group;
  decoded.set(stroke, samples);
  return stroke;
}

export function normalizeInkFrame(value: unknown): InkFrame | null {
  if (!isObject(value)) return null;
  const { unit, width, height } = value;
  return (unit === "pt" || unit === "px") && finite(width) && finite(height) && width > 0 && height > 0 ? { unit, width, height } : null;
}

function normalizeSource(value: unknown): InkSource | undefined {
  if (!isObject(value)) return undefined;
  const { size, sha256 } = value;
  return finite(size) && size >= 0 && typeof sha256 === "string" && /^[0-9a-f]{64}$/i.test(sha256) ? { size, sha256: sha256.toLowerCase() } : undefined;
}

/**
 * An author file as read from disk, or null when it is not one. Malformed
 * strokes are dropped; unknown fields are kept.
 */
export function normalizeInkAuthorFile(value: unknown): InkAuthorFile | null {
  if (!isObject(value) || value.format !== INK_FORMAT || !finite(value.version) || value.version < 1) return null;
  const author = isObject(value.author) && isInkId(value.author.key) ? value.author : null;
  const frame = normalizeInkFrame(value.frame);
  if (!author || !frame) return null;
  const seen = new Set<string>();
  const strokes: InkStroke[] = [];
  for (const item of Array.isArray(value.strokes) ? value.strokes : []) {
    const stroke = normalizeInkStroke(item);
    if (stroke && !seen.has(stroke.id)) {
      seen.add(stroke.id);
      strokes.push(stroke);
    }
  }
  const erased = Array.from(new Set((Array.isArray(value.erased) ? value.erased : []).filter(isInkId)));
  const source = normalizeSource(value.source);
  const { name, ...authorRest } = author;
  const file: InkAuthorFile = {
    ...value,
    format: INK_FORMAT,
    version: value.version,
    author: { ...authorRest, key: author.key as string, ...(typeof name === "string" ? { name } : {}) },
    frame,
    strokes,
    erased,
    revision: finite(value.revision) && value.revision >= 0 ? Math.floor(value.revision) : 0,
  };
  if (source) file.source = source;
  else delete file.source;
  return file;
}

/** Whether this Libera may rewrite a file: not one written by a newer format. */
export function canWriteInkFile(file: Pick<InkAuthorFile, "version">) {
  return file.version <= INK_VERSION;
}

export function emptyInkAuthorFile(author: InkAuthorFile["author"], frame: InkFrame, source?: InkSource): InkAuthorFile {
  return { format: INK_FORMAT, version: INK_VERSION, author, ...(source ? { source } : {}), frame, strokes: [], erased: [], revision: 0 };
}
