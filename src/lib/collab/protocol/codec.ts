// Minimal binary codec for the collaboration wire protocol.
//
// This module is shared by the renderer, the collab host and the server, so it
// has no runtime dependencies (not even lib0). Numbers are unsigned varints
// built with arithmetic rather than bit operators, so values up to
// Number.MAX_SAFE_INTEGER round-trip (server sequence numbers are bigint in
// Postgres but stay far below 2^53).

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodecError";
  }
}

export class Writer {
  private chunks: Uint8Array[] = [];
  private buffer = new Uint8Array(256);
  private position = 0;

  private ensure(size: number): void {
    if (this.position + size <= this.buffer.length) return;
    this.chunks.push(this.buffer.subarray(0, this.position));
    this.buffer = new Uint8Array(Math.max(256, size, this.buffer.length * 2));
    this.position = 0;
  }

  uint8(value: number): this {
    this.ensure(1);
    this.buffer[this.position++] = value & 0xff;
    return this;
  }

  varUint(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new CodecError(`varUint out of range: ${value}`);
    }
    this.ensure(8);
    let remaining = value;
    while (remaining >= 0x80) {
      this.buffer[this.position++] = (remaining % 0x80) + 0x80;
      remaining = Math.floor(remaining / 0x80);
    }
    this.buffer[this.position++] = remaining;
    return this;
  }

  bool(value: boolean): this {
    return this.uint8(value ? 1 : 0);
  }

  bytes(value: Uint8Array): this {
    this.varUint(value.length);
    this.ensure(value.length);
    this.buffer.set(value, this.position);
    this.position += value.length;
    return this;
  }

  string(value: string): this {
    return this.bytes(textEncoder.encode(value));
  }

  json(value: unknown): this {
    return this.string(value === undefined ? "" : JSON.stringify(value));
  }

  finish(): Uint8Array {
    const parts = [...this.chunks, this.buffer.subarray(0, this.position)];
    const length = parts.reduce((total, part) => total + part.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }
}

export class Reader {
  private position = 0;

  constructor(private readonly data: Uint8Array) {}

  get done(): boolean {
    return this.position >= this.data.length;
  }

  uint8(): number {
    if (this.position >= this.data.length) throw new CodecError("Unexpected end of message");
    return this.data[this.position++];
  }

  varUint(): number {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 8; index += 1) {
      const byte = this.uint8();
      value += (byte & 0x7f) * multiplier;
      if (byte < 0x80) {
        if (!Number.isSafeInteger(value)) throw new CodecError("varUint overflow");
        return value;
      }
      multiplier *= 0x80;
    }
    throw new CodecError("varUint too long");
  }

  bool(): boolean {
    return this.uint8() !== 0;
  }

  bytes(): Uint8Array {
    const length = this.varUint();
    if (this.position + length > this.data.length) throw new CodecError("Byte array exceeds message");
    const value = this.data.slice(this.position, this.position + length);
    this.position += length;
    return value;
  }

  string(): string {
    try {
      return textDecoder.decode(this.bytes());
    } catch (error) {
      if (error instanceof CodecError) throw error;
      throw new CodecError("Invalid UTF-8 string");
    }
  }

  json<T>(): T | undefined {
    const text = this.string();
    if (text === "") return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CodecError("Invalid JSON field");
    }
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
