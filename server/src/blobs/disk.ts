// Disk blob driver: BLOB_DIR/ab/cd/abcd… (two shard levels keep directories
// small). Writes go to a temp file in the same directory and are renamed into
// place, so a crash never leaves a truncated blob under its final name.

import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { assertBlobHash } from "./hash.js";
import type { BlobStore } from "./index.js";

export function createDiskBlobStore(directory: string): BlobStore {
  const root = resolve(directory);

  function pathFor(hash: string): string {
    assertBlobHash(hash);
    return join(root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  async function exists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  return {
    async put(hash, data) {
      const target = pathFor(hash);
      if (await exists(target)) return;
      await mkdir(dirname(target), { recursive: true });
      const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        const handle = await open(temp, "wx");
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true });
        // A concurrent upload of the same bytes may have won the rename.
        if (await exists(target)) return;
        throw error;
      }
    },
    async get(hash) {
      const path = pathFor(hash);
      if (!(await exists(path))) return null;
      return createReadStream(path);
    },
    async has(hash) {
      return exists(pathFor(hash));
    },
  };
}
