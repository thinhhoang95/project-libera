import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readFileSignature } from "@/lib/storage/file-signature";

const fingerprints = new Map<string, { signature: string; hash: string }>();

/** Hash every byte, including the tail of large photos and model weight files. */
export async function contentHash(filePath: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(filePath)) hash.update(bytes);
  return hash.digest("hex");
}

async function cachedContentHash(filePath: string) {
  const signature = await readFileSignature(filePath);
  const cached = fingerprints.get(filePath);
  if (cached?.signature === signature) return cached.hash;
  const hash = await contentHash(filePath);
  if (await readFileSignature(filePath) !== signature) throw new Error("Model files changed while being read. Try again.");
  fingerprints.set(filePath, { signature, hash });
  return hash;
}

/** Portable model identity, including external tensor data and processor configs. */
export async function weightsSignature(filePath: string, includeProcessor = false) {
  if (!filePath) return "";
  const directory = path.dirname(filePath);
  const name = path.basename(filePath);
  const files = [filePath];
  const entries = await readdir(directory);
  files.push(...entries.filter((entry) => entry.startsWith(`${name}_data`)).sort().map((entry) => path.join(directory, entry)));
  if (includeProcessor) {
    for (const candidate of [directory, path.dirname(directory)]) {
      if (!(await stat(path.join(candidate, "tokenizer.json")).catch(() => null)) ||
          !(await stat(path.join(candidate, "config.json")).catch(() => null))) continue;
      files.push(...["config.json", "tokenizer.json", "tokenizer_config.json", "processor_config.json", "preprocessor_config.json", "special_tokens_map.json"]
        .filter((entry) => entry !== name).map((entry) => path.join(candidate, entry)));
      break;
    }
  }
  const parts: string[] = [];
  for (const file of files) {
    try {
      parts.push(`${path.basename(file)}:${await cachedContentHash(file)}`);
    } catch (error) {
      if (file === filePath || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      parts.push(`${path.basename(file)}:missing`);
    }
  }
  return `${name}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}
