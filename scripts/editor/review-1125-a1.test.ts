import assert from "node:assert/strict";
import fs from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { applyNotebookCleanup, planNotebookCleanup } from "../../src/lib/storage/cleanup";
import { verifyNotebook } from "../../src/lib/storage/integrity";
import { cleanupMarkdownImageAssets, isInOwnedFolder, rawEmbedsInOtherNotebooks, unreferencedMarkdownAssets } from "../../src/lib/storage/markdown-assets";
import { getAdminRoot, notebookPath } from "../../src/lib/storage/paths";
import { assertNotebookSound, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

const require = createRequire(import.meta.url);
const { directoryModeStatePath, writeDirectoryModeState } = require("../../electron/directory-mode.cjs");

// Review 2026-11-25, package A1: image assets are compared by the round's one
// name rule (NFC and case folding per segment). NTFS keeps NFC and NFD
// spellings apart, so the macOS case is simulated: the file is written under
// its NFD name and the note says it in NFC.

const NFC = "café.png";
const NFD = "café.png";
assert.notEqual(NFC, NFD);
const exists = (target: string) => stat(target).then(() => true, () => false);
const assetFile = (notebook: string, ...parts: string[]) => path.join(notebookPath(notebook), "_assets", ...parts);

test("E-C1: an NFD file named by an NFC embed is not unused, and Acknowledge keeps it", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/n.md", `# N\n\n![cafe](_assets/shared/${NFC})\n`);
  const image = assetFile("Nb", "shared", NFD);
  await writeAt(image, "png");

  assert.deepEqual(await unreferencedMarkdownAssets("Nb"), []);

  const report = await verifyNotebook("Nb");
  assert.ok(report.findings.every((finding) => !finding.clear?.some((action) => "path" in action && action.path.includes("shared"))), "no clear action on an image a note names");
  const plan = await planNotebookCleanup("Nb");
  assert.deepEqual(plan.items.filter((item) => item.path.includes("_assets")), []);
  await applyNotebookCleanup("Nb", plan.token);
  assert.ok(await exists(image), "the image stays");
  // NTFS keeps the two spellings apart, so the note shows a missing image here; on macOS they are one file.
  await assertNotebookSound("Nb", { severities: ["error", "warning", "info"], allow: ["images: Nb/n.md"] });
}));

test("E-C1: a note save does not prune an NFD image that another note embeds in NFC", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.md", `![x](_assets/shared/${NFC})\n`);
  await writeLibraryFile("Nb/b.md", "# B\n");
  const image = assetFile("Nb", "shared", NFD);
  await writeAt(image, "png");
  // b.md had embedded it (spelled as the disk has it) and no longer does.
  await cleanupMarkdownImageAssets("Nb", [{ documentPath: "Nb/b.md", content: `![x](_assets/shared/${NFD})\n` }]);
  assert.ok(await exists(image), "a.md still shows it");
}));

test("E-C1: an address embed from another notebook in NFC protects an NFD image", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await writeLibraryFile("Nb/b.md", "# B\n");
  await writeLibraryFile("Other/o.md", `![x](/api/files/raw/Nb/_assets/shared/${NFC})\n`);
  const image = assetFile("Nb", "shared", NFD);
  await writeAt(image, "png");
  const embeds = await rawEmbedsInOtherNotebooks("Nb");
  assert.ok(embeds);
  await cleanupMarkdownImageAssets("Nb", [{ documentPath: "Nb/b.md", content: `![x](_assets/shared/${NFD})\n` }]);
  assert.ok(await exists(image));
}));

test("E-C1: the check agrees with the unused scan about an image a note embeds by its raw address", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/n.md", "![x](/api/files/raw/Nb/_assets/shared/chart.png)\n");
  const image = assetFile("Nb", "shared", "chart.png");
  await writeAt(image, "png");
  assert.deepEqual(await unreferencedMarkdownAssets("Nb"), []);
  const plan = await planNotebookCleanup("Nb");
  assert.deepEqual(plan.items, []);
  // The check still words a raw _assets address as unreadable (not this package); it must not offer the image.
  await assertNotebookSound("Nb", { severities: ["error", "warning", "info"], allow: ["can't be read"] });
}));

test("E-C1: an image the check can't tell from an unreadable embed address is not offered for deletion", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/n.md", "![x](_assets/%E0%A4%A.png)\n");
  const image = assetFile("Nb", "shared", "stray.png");
  await writeAt(image, "png");
  const report = await verifyNotebook("Nb");
  const finding = report.findings.find((item) => item.path === "Nb/_assets/shared/stray.png");
  assert.ok(!finding?.clear?.length, "no clear action while a note's image address can't be read");
}));

test("E-H7: folded equality of an owned folder is not identity on a case-sensitive volume", async () => {
  const owned = [{ prefix: "_assets/analysis.md" }];
  // The folder a note owns is `analysis.md`; the code sits in `Analysis.md`.
  assert.equal(await isInOwnedFolder("_assets/Analysis.md/Analysis.py", owned, async () => false), false, "a different folder on a case-sensitive disk is not owned");
  assert.equal(await isInOwnedFolder("_assets/Analysis.md/Analysis.py", owned, async () => true), true, "the same folder on a case-insensitive disk is");
  assert.equal(await isInOwnedFolder("_assets/Analysis.md/Analysis.py", owned, async () => null), true, "an unknown answer keeps it");
  assert.equal(await isInOwnedFolder("_assets/analysis.md/a.py", owned, async () => { throw new Error("not asked"); }), true, "an exact spelling needs no question");
  assert.equal(await isInOwnedFolder("_assets/other/a.py", owned, async () => true), false);
});

test("E-H7: on a case-insensitive disk a case-only renamed note still owns its folder", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/analysis.md", "# A\n");
  await writeAt(assetFile("Nb", "Analysis.md", "Analysis.py"), "print(1)\n");
  const same = await stat(assetFile("Nb", "analysis.md")).then(() => true, () => false);
  if (!same) return; // case-sensitive volume: the code is reported, covered by the unit test above.
  assert.deepEqual(await unreferencedMarkdownAssets("Nb"), []);
}));

test("E-M5: an offline linked folder is 'can't tell', so images are protected", () => withTemporaryLibrary(["Nb"], async () => {
  const adminRoot = getAdminRoot();
  writeDirectoryModeState(adminRoot, { version: 3, folders: [{ name: "Away", path: path.join(adminRoot, "..", "away-folder"), locations: { "some-other-computer": path.join(adminRoot, "..", "away-folder") } }], recent: [] });
  assert.ok(fs.existsSync(directoryModeStatePath(adminRoot)));
  await writeLibraryFile("Nb/b.md", "# B\n");
  const image = assetFile("Nb", "shared", "chart.png");
  await writeAt(image, "png");
  assert.equal(await rawEmbedsInOtherNotebooks("Nb"), null, "an unreachable folder can't be searched");
  const held = await cleanupMarkdownImageAssets("Nb", [{ documentPath: "Nb/b.md", content: "![x](_assets/shared/chart.png)\n" }]);
  assert.equal(held, false);
  assert.ok(await exists(image), "the image is kept");
}));
