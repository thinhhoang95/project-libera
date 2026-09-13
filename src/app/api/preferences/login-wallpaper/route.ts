import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { getAdminRoot } from "@/lib/storage/paths";
import { LIBERA_SYSTEM_DIR } from "@/lib/storage/constants";

export const runtime = "nodejs";
const MAX_BYTES = 10 * 1024 * 1024;
const wallpaperPath = () => path.join(getAdminRoot(), LIBERA_SYSTEM_DIR, "login-wallpaper.webp");

// Available before sign-in by design; exposes only this decorative image.
export async function GET() {
  try {
    return new Response(new Uint8Array(await readFile(wallpaperPath())), {
      headers: { "Content-Type": "image/webp", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    return Response.json({ error: "Wallpaper unavailable." }, { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500 });
  }
}

export async function POST(request: Request) {
  // Login customization is public, but other sites must not be able to change it.
  // NextURL normalizes loopback IPs to localhost. Host retains the actual
  // browser-facing address (including Electron's dynamically assigned port).
  const expectedOrigin = new URL(request.url);
  expectedOrigin.host = request.headers.get("host") ?? expectedOrigin.host;
  if (request.headers.get("origin") !== expectedOrigin.origin) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }
  if (!/^(image\/(png|jpeg|webp))$/.test(request.headers.get("content-type") ?? "")) {
    return Response.json({ error: "Choose a PNG, JPEG, or WebP image." }, { status: 415 });
  }
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "Choose an image." }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      return Response.json({ error: "Choose an image smaller than 10 MB." }, { status: 413 });
    }
    chunks.push(value);
  }
  let image: Buffer;
  try {
    image = await sharp(Buffer.concat(chunks), { limitInputPixels: 40_000_000 })
      .rotate().resize(2560, 2560, { fit: "inside", withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
  } catch {
    return Response.json({ error: "This image could not be opened. Try another PNG, JPEG, or WebP." }, { status: 400 });
  }
  const target = wallpaperPath();
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(temporary, image, { mode: 0o600 });
    await rename(temporary, target);
    return Response.json({ saved: true });
  } catch {
    return Response.json({ error: "Could not save your wallpaper. Please try again." }, { status: 500 });
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
