// The write guard: every Libera code path that writes into a notebook
// refuses a shared notebook with 409 `shared-document` (SharedDocumentError
// for server-side callers), and keeps working for ordinary notebooks.
//
// WRITERS lists each writer found in the audit; the test runs every one of
// them against a shared notebook and checks the folder did not change.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { NextRequest } from "next/server";

import {
  SharedDocumentError,
  invalidateSharedNotebookCache,
  isSharedDocumentError,
  isSharedNotebookPath,
  sharedManifestPath,
} from "../../src/lib/collab/shared-notebook";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import {
  archiveFile,
  archiveFolder,
  copyFileToDirectory,
  createFolder,
  createMarkdownFile,
  deleteFile,
  deleteFolder,
  deleteMarkdownImageSource,
  deleteNotebook,
  moveFile,
  moveFileToDirectory,
  pruneUnusedMarkdownImageAssets,
  renameFolder,
  renameNotebook,
  saveEditedImageCopy,
  updateMarkdownFile,
  writeMarkdownImageAsset,
  writeUploadedFile,
} from "../../src/lib/storage";
import { NO_EDITS } from "../../src/lib/photo-edits";
import { ALL_TOOLS, type ToolContext } from "../../src/lib/agent/tools";
import { RunSnapshots, hashContent, undoRun } from "../../src/lib/agent/snapshots";
import type { AgentPermission } from "../../src/lib/agent/types";
import { PATCH as FILES_PATCH, POST as FILES_POST, DELETE as FILES_DELETE } from "../../src/app/api/files/route";
import { POST as FOLDERS_POST } from "../../src/app/api/folders/route";
import { POST as UPLOADS_POST } from "../../src/app/api/uploads/route";
import { POST as ASSETS_POST } from "../../src/app/api/markdown-assets/route";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function marker(revoked = false) {
  return JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString(), ...(revoked ? { revoked: true } : {}) });
}

function seedNotebook(root: string, name: string) {
  const files: Record<string, string | Buffer> = {
    "a.md": "# A\n\n![pic](_assets/a/pic.png)\n",
    "sub/b.md": "b\n",
    "paper.tex": "\\section{x}\n",
    "pic.png": PNG,
    "_assets/a/pic.png": PNG,
    "_archive/old.md": "old\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, name, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** Every file and folder in the notebook with its bytes, so a refused write provably changed nothing. */
function fingerprint(root: string): string {
  const lines: string[] = [];
  const visit = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = `${prefix}/${name}`;
      if (statSync(absolute).isDirectory()) {
        lines.push(`${relative}/`);
        visit(absolute, relative);
      } else lines.push(`${relative} ${hashContent(readFileSync(absolute).toString("base64"))}`);
    }
  };
  visit(root, "");
  return lines.join("\n");
}

function agentContext(permission: AgentPermission = "notebook"): ToolContext {
  return {
    permission,
    skills: [],
    loadedSkills: new Set(),
    skillState: new Map(),
    notebook: "Shared",
    notebooks: ["Local", "Revoked", "Shared"],
    openFiles: new Set(["Shared/a.md"]),
    drafts: new Map(),
    fileState: new Map(),
    tasks: [],
    snapshots: new RunSnapshots(`run-${Math.random().toString(36).slice(2, 12)}`),
    changed: new Map(),
    maxResultChars: 40_000,
    signal: new AbortController().signal,
    emit: () => {},
  } as ToolContext;
}

async function agentTool(name: string, args: Record<string, unknown>, context = agentContext()) {
  const tool = ALL_TOOLS.find((candidate) => candidate.name === name);
  assert.ok(tool, name);
  return tool.run(args, context);
}

function authed(url: string, init: { method: string; body?: BodyInit; json?: unknown }) {
  return new NextRequest(`http://localhost${url}`, {
    method: init.method,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
}

function upload(name: string) {
  return new File([new Uint8Array(PNG)], name, { type: "image/png" });
}

type Writer = { name: string; run: () => Promise<unknown> };

const WRITERS: Writer[] = [
  // src/lib/storage/files.ts (PATCH/POST/DELETE /api/files, /api/folders, OCR "Convert PDF to Markdown")
  { name: "updateMarkdownFile", run: () => updateMarkdownFile("Shared/a.md", "changed") },
  { name: "createMarkdownFile", run: () => createMarkdownFile("Shared", "new.md", "x") },
  { name: "createMarkdownFile (parentPath, OCR beside a PDF)", run: () => createMarkdownFile("Shared", "Paper.md", "", "Shared/sub") },
  { name: "moveFile (rename)", run: () => moveFile("Shared/a.md", "Shared", "renamed.md") },
  { name: "moveFile (into a shared notebook)", run: () => moveFile("Local/a.md", "Shared", "from-local.md") },
  { name: "moveFile (out of a shared notebook)", run: () => moveFile("Shared/a.md", "Local", "taken.md") },
  { name: "moveFileToDirectory", run: () => moveFileToDirectory("Shared/a.md", "Shared/sub") },
  { name: "moveFileToDirectory (into)", run: () => moveFileToDirectory("Local/a.md", "Shared/sub") },
  { name: "copyFileToDirectory (into)", run: () => copyFileToDirectory("Local/a.md", "Shared") },
  { name: "archiveFile", run: () => archiveFile("Shared/a.md") },
  { name: "deleteFile", run: () => deleteFile("Shared/a.md") },
  { name: "createFolder", run: () => createFolder("Shared", "new-folder") },
  { name: "renameFolder", run: () => renameFolder("Shared/sub", "renamed") },
  { name: "archiveFolder", run: () => archiveFolder("Shared/sub") },
  { name: "deleteFolder", run: () => deleteFolder("Shared/sub") },
  // Uploads, image generation and gallery saves into a notebook folder.
  { name: "writeUploadedFile", run: () => writeUploadedFile("Shared", upload("new.png")) },
  { name: "writeUploadedFile (destination folder)", run: () => writeUploadedFile("Shared", upload("new.png"), "Shared/sub") },
  { name: "saveEditedImageCopy", run: () => saveEditedImageCopy("Shared/pic.png", { ...NO_EDITS, rotate: 90 }) },
  // src/lib/storage/markdown-assets.ts (/api/markdown-assets)
  { name: "writeMarkdownImageAsset", run: () => writeMarkdownImageAsset("Shared/a.md", upload("paste.png")) },
  { name: "pruneUnusedMarkdownImageAssets", run: () => pruneUnusedMarkdownImageAssets("Shared/a.md", "no images") },
  { name: "deleteMarkdownImageSource (asset)", run: () => deleteMarkdownImageSource({ documentPath: "Shared/a.md", imageSource: "_assets/a/pic.png" }) },
  { name: "deleteMarkdownImageSource (raw file)", run: () => deleteMarkdownImageSource({ documentPath: "Shared/a.md", imageSource: "/api/files/raw/Shared/pic.png" }) },
  // src/lib/storage/notebooks.ts
  { name: "renameNotebook", run: () => renameNotebook("Shared", "Renamed") },
  { name: "deleteNotebook", run: () => deleteNotebook("Shared") },
  // src/lib/agent (writeAgentFile through the Write and Edit tools)
  { name: "agent Write (new file)", run: () => agentTool("Write", { file_path: "Shared/agent.md", content: "x" }) },
  {
    name: "agent Edit",
    run: async () => {
      const context = agentContext();
      await agentTool("Read", { file_path: "Shared/a.md" }, context);
      return agentTool("Edit", { file_path: "Shared/a.md", old_string: "# A", new_string: "# B" }, context);
    },
  },
];

async function expectRefused(writer: Writer): Promise<string> {
  try {
    const result = (await writer.run()) as { isError?: boolean; text?: string } | undefined;
    if (result && typeof result === "object" && result.isError) {
      assert.match(result.text ?? "", /shared notebook/i, `${writer.name}: refused for being shared`);
      return "tool-error";
    }
  } catch (error) {
    if (isSharedDocumentError(error)) {
      assert.ok(error instanceof SharedDocumentError, `${writer.name}: typed error`);
      assert.equal((error as SharedDocumentError).status, 409);
      return "shared-document";
    }
    if (error instanceof Error && /shared notebook/i.test(error.message)) return "tool-error";
    throw new Error(`${writer.name} failed for another reason: ${(error as Error).message}`);
  }
  throw new Error(`${writer.name} wrote to a shared notebook`);
}

test("every writer refuses a shared notebook and leaves it untouched", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "libera-guard-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = dataDir;
  try {
    const library = path.join(dataDir, "users", "admin");
    for (const name of ["Shared", "Local", "Revoked"]) seedNotebook(library, name);
    writeFileSync(path.join(library, "Shared", ".libera-shared.json"), marker());
    writeFileSync(path.join(library, "Revoked", ".libera-shared.json"), marker(true));
    invalidateSharedNotebookCache();
    const sharedRoot = path.join(library, "Shared");
    const before = fingerprint(sharedRoot);

    const outcomes: Record<string, string> = {};
    for (const writer of WRITERS) {
      // Writers that move files out of Local need a fresh source each time.
      if (!existsSync(path.join(library, "Local", "a.md"))) writeFileSync(path.join(library, "Local", "a.md"), "# A\n");
      outcomes[writer.name] = await expectRefused(writer);
      assert.equal(fingerprint(sharedRoot), before, `${writer.name} changed the shared notebook`);
    }
    for (const writer of WRITERS) {
      const expected = writer.name.startsWith("agent") ? "tool-error" : "shared-document";
      assert.equal(outcomes[writer.name], expected, writer.name);
    }

    // Direct-write routes retain the guard; creation routes require the host.
    const patch = await FILES_PATCH(authed("/api/files", { method: "PATCH", json: { path: "Shared/a.md", content: "x" } }));
    assert.equal(patch.status, 409);
    assert.deepEqual(await patch.json(), { error: "shared-document" });
    const post = await FILES_POST(authed("/api/files", { method: "POST", json: { notebook: "Shared", name: "x.md", content: "" } }));
    assert.equal(post.status, 503);
    assert.match(((await post.json()) as { error: string }).error, /shared notebook.*collaboration is not running/);
    const remove = await FILES_DELETE(authed("/api/files?path=Shared%2Fa.md", { method: "DELETE" }));
    assert.equal(remove.status, 503);
    const folder = await FOLDERS_POST(authed("/api/folders", { method: "POST", json: { parentPath: "Shared", name: "f" } }));
    assert.equal(folder.status, 503);
    const form = new FormData();
    form.set("notebook", "Shared");
    form.append("files", upload("u.png"));
    // Uploads and Markdown images into a shared notebook go through the collab
    // host (src/lib/collab/shared-writes.ts); with collaboration off they
    // answer 503 and still write nothing.
    const uploaded = await UPLOADS_POST(authed("/api/uploads", { method: "POST", body: form }));
    assert.equal(uploaded.status, 503);
    assert.match(((await uploaded.json()) as { error: string }).error, /shared notebook.*collaboration is not running/);
    const assetForm = new FormData();
    assetForm.set("documentPath", "Shared/a.md");
    assetForm.set("file", upload("p.png"));
    const asset = await ASSETS_POST(authed("/api/markdown-assets", { method: "POST", body: assetForm }));
    assert.equal(asset.status, 503);
    assert.equal(fingerprint(sharedRoot), before);

    // The local archive inside a shared notebook stays writable.
    assert.equal(isSharedNotebookPath("Shared/_archive/old.md"), false);
    await deleteFile("Shared/_archive/old.md");

    // Ordinary notebooks are unaffected.
    await updateMarkdownFile("Local/sub/b.md", "edited\n");
    assert.equal(readFileSync(path.join(library, "Local", "sub", "b.md"), "utf8"), "edited\n");
    await createMarkdownFile("Local", "fresh.md", "new");
    await writeUploadedFile("Local", upload("up.png"));
    await createFolder("Local", "made");
    const written = (await agentTool("Write", { file_path: "Local/agent.md", content: "by the agent\n" }, { ...agentContext(), notebook: "Local" })) as { isError?: boolean };
    assert.ok(!written.isError);
    assert.equal(readFileSync(path.join(library, "Local", "agent.md"), "utf8"), "by the agent\n");

    // A revoked notebook stays read-only, but its local copy can be deleted.
    await assert.rejects(updateMarkdownFile("Revoked/a.md", "x"), SharedDocumentError);
    await deleteNotebook("Revoked");
    assert.equal(existsSync(path.join(library, "Revoked")), false);
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    invalidateSharedNotebookCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an agent run made before the notebook was shared is not undone into it", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "libera-guard-undo-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = dataDir;
  try {
    const library = path.join(dataDir, "users", "admin");
    await mkdir(path.join(library, "Notes"), { recursive: true });
    await writeFile(path.join(library, "Notes", "n.md"), "original\n");
    invalidateSharedNotebookCache();
    const context = { ...agentContext(), notebook: "Notes", notebooks: ["Notes"], openFiles: new Set(["Notes/n.md"]) } as ToolContext;
    await agentTool("Read", { file_path: "Notes/n.md" }, context);
    const edited = (await agentTool("Edit", { file_path: "Notes/n.md", old_string: "original", new_string: "by agent" }, context)) as { isError?: boolean };
    assert.ok(!edited.isError);
    writeFileSync(path.join(library, "Notes", ".libera-shared.json"), marker());
    invalidateSharedNotebookCache();
    const results = await undoRun(context.snapshots.runId);
    assert.equal(results[0].status, "conflict");
    assert.equal(readFileSync(path.join(library, "Notes", "n.md"), "utf8"), "by agent\n");
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    invalidateSharedNotebookCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the guard notices a new or removed marker even when the folder mtime is unchanged", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "libera-guard-cache-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = dataDir;
  try {
    const library = path.join(dataDir, "users", "admin");
    seedNotebook(library, "Later");
    writeFileSync(path.join(library, "Later", "vulnerability-regime-analysis.pdf"), "%PDF-1.7\nlocal copy\n");
    invalidateSharedNotebookCache();
    assert.equal(isSharedNotebookPath("Later/a.md"), false);
    const folder = path.join(library, "Later");
    const original = statSync(folder);
    const markerPath = path.join(library, "Later", ".libera-shared.json");
    writeFileSync(markerPath, marker());
    // Sharing and takedown can fall within the same timestamp tick (ExFAT).
    utimesSync(folder, original.atime, original.mtime);
    assert.equal(isSharedNotebookPath("Later/a.md"), true);
    assert.deepEqual(sharedManifestPath("Later/sub/b.md"), { notebook: "Later", projectId: "prj_test", path: "sub/b.md" });
    assert.equal(sharedManifestPath("Later/_archive/x.md"), null);
    rmSync(markerPath);
    utimesSync(folder, original.atime, original.mtime);
    assert.equal(isSharedNotebookPath("Later/a.md"), false);
    // Immediately after takedown, file routes and direct writers must use
    // local storage rather than asking the host for a now-removed project.
    const renamed = await FILES_PATCH(authed("/api/files", { method: "PATCH", json: { path: "Later/vulnerability-regime-analysis.pdf", destinationNotebook: "Later", destinationName: "renamed.pdf" } }));
    assert.equal(renamed.status, 200, JSON.stringify(await renamed.json()));
    assert.equal(readFileSync(path.join(folder, "renamed.pdf"), "utf8"), "%PDF-1.7\nlocal copy\n");
    const removed = await FILES_DELETE(authed("/api/files?path=Later%2Frenamed.pdf", { method: "DELETE" }));
    assert.equal(removed.status, 200, JSON.stringify(await removed.json()));
    assert.equal(existsSync(path.join(folder, "renamed.pdf")), false);
    await updateMarkdownFile("Later/sub/b.md", "editable after takedown\n");
    assert.equal(readFileSync(path.join(folder, "sub/b.md"), "utf8"), "editable after takedown\n");
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    invalidateSharedNotebookCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
