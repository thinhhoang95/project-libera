import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MODEL_FOLDERS, defaultModelsDirectory } from "../../../electron/search-preferences.cjs";
import { getAdminRoot } from "@/lib/storage/paths";

/** One file to fetch: its URL, where it goes under the model folder, and how to check it. */
export type ModelDownloadFile = { url: string; target: string; size: number; sha256: string | null };

export type ModelDownloadProgress = {
  directory: string;
  downloadedBytes: number;
  totalBytes: number;
  error: string;
  running: boolean;
};

/**
 * The folder Libera downloads a model into when Preferences names none: in
 * its application data on this computer, outside the Master directory.
 */
export function defaultModelDirectory(model: keyof typeof MODEL_FOLDERS) {
  return path.join(defaultModelsDirectory({ adminRoot: getAdminRoot(), configPath: process.env.LIBERA_CONFIG_PATH }), MODEL_FOLDERS[model]);
}

export async function fileSize(filePath: string) {
  try {
    const info = await stat(filePath);
    return info.isFile() ? info.size : -1;
  } catch {
    return -1;
  }
}

/** A pinned Hugging Face file URL. */
export function huggingFaceUrl(repository: string, revision: string, file: string) {
  return `https://huggingface.co/${repository}/resolve/${revision}/${file.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Every file of a Hugging Face repository at a pinned revision, with sizes and,
 * for files stored in LFS, their SHA-256. For models with too many small files
 * to list by hand, such as Kokoro's espeak-ng data.
 */
export async function huggingFaceFiles(repository: string, revision: string, { skip = [] as string[], signal }: { skip?: string[]; signal?: AbortSignal } = {}) {
  const files: ModelDownloadFile[] = [];
  let next: string | null = `https://huggingface.co/api/models/${repository}/tree/${revision}?recursive=true`;
  while (next) {
    const response: Response = await fetch(next, { signal });
    if (!response.ok) throw new Error(`Could not list ${repository} on Hugging Face (HTTP ${response.status}).`);
    const entries = (await response.json()) as Array<{ type: string; path: string; size: number; lfs?: { oid?: string } }>;
    for (const entry of entries) {
      if (entry.type !== "file" || skip.includes(entry.path)) continue;
      files.push({ url: huggingFaceUrl(repository, revision, entry.path), target: entry.path, size: entry.size, sha256: entry.lfs?.oid ?? null });
    }
    next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1] ?? null;
  }
  return files;
}

type Download = ModelDownloadProgress & { controller: AbortController };

/**
 * Downloads a model's files into its folder. Each file arrives as `name.part`
 * and is renamed once its size and checksum are right, so the folder never
 * holds a broken weight file. An interrupted download resumes.
 */
export class ModelDownloader {
  private download: Download | null = null;

  /** The download into `directory`, running or finished, if there was one. */
  progress(directory: string): ModelDownloadProgress | null {
    return this.download?.directory === directory ? this.download : null;
  }

  get running() {
    return Boolean(this.download?.running);
  }

  /** `files` may be listed once the download starts; `estimatedBytes` shows until then. */
  start(directory: string, files: ModelDownloadFile[] | ((signal: AbortSignal) => Promise<ModelDownloadFile[]>), estimatedBytes = 0) {
    if (this.download?.running) return;
    const controller = new AbortController();
    const download: Download = {
      directory,
      downloadedBytes: 0,
      totalBytes: Array.isArray(files) ? files.reduce((total, file) => total + file.size, 0) : estimatedBytes,
      error: "",
      running: true,
      controller,
    };
    this.download = download;
    void (async () => {
      const list = Array.isArray(files) ? files : await files(controller.signal);
      download.totalBytes = list.reduce((total, file) => total + file.size, 0);
      await this.run(download, list);
    })().catch((error: unknown) => {
      download.error = controller.signal.aborted ? "" : error instanceof Error ? error.message : "The model download failed.";
    }).finally(() => {
      download.running = false;
    });
  }

  cancel() {
    this.download?.controller.abort();
  }

  private async run(download: Download, files: ModelDownloadFile[]) {
    const { directory, controller: { signal } } = download;
    let completedBytes = 0;

    for (const file of files) {
      const target = path.join(directory, ...file.target.split("/"));
      const partial = `${target}.part`;

      if ((await fileSize(target)) === file.size) {
        completedBytes += file.size;
        download.downloadedBytes = completedBytes;
        continue;
      }

      await mkdir(path.dirname(target), { recursive: true });
      let offset = Math.max(0, await fileSize(partial));
      if (offset > file.size) {
        await rm(partial, { force: true });
        offset = 0;
      }

      const response = offset < file.size || file.size === 0
        ? await fetch(file.url, { headers: offset ? { Range: `bytes=${offset}-` } : undefined, redirect: "follow", signal })
        : null;

      if (response) {
        if (!response.ok || !response.body) throw new Error(`Could not download ${file.target} (HTTP ${response.status}).`);
        // A server that ignores the range sends the whole file again.
        if (offset && response.status !== 206) offset = 0;
        download.downloadedBytes = completedBytes + offset;

        const counter = new Transform({
          transform: (chunk: Buffer, _encoding, callback) => {
            download.downloadedBytes += chunk.length;
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
          counter,
          createWriteStream(partial, { flags: offset ? "a" : "w" }),
          { signal },
        );
      }

      if ((await fileSize(partial)) !== file.size) {
        await rm(partial, { force: true });
        throw new Error(`${file.target} arrived with the wrong size. Try the download again.`);
      }
      if (file.sha256) {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(partial)) hash.update(chunk as Buffer);
        if (hash.digest("hex") !== file.sha256) {
          await rm(partial, { force: true });
          throw new Error(`${file.target} did not match its checksum. Try the download again.`);
        }
      }

      await rename(partial, target);
      completedBytes += file.size;
      download.downloadedBytes = completedBytes;
    }
  }
}

/** One downloader per model for the whole server, surviving hot reloads. */
export function sharedModelDownloader(name: string) {
  const store = globalThis as { [key: symbol]: ModelDownloader | undefined };
  const key = Symbol.for(`libera.modelDownloader.${name}`);
  store[key] ??= new ModelDownloader();
  return store[key];
}
