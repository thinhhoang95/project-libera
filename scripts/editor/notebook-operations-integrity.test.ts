import test from "node:test";
import {
  archiveFile,
  archiveFolder,
  copyFileToDirectory,
  createFolder,
  deleteFile,
  deleteFolder,
  moveFile,
  moveFileToDirectory,
  renameFolder,
} from "../../src/lib/storage/files";
import { setFileTagsForPath, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import { assertNotebookSound, seedNotebook, withTemporaryLibrary, writeReferenceLibrary } from "./notebook-test-helpers";

// The notebook check (storage/integrity.ts) as the oracle for the app's
// everyday file operations: after each one, on a notebook with every kind of
// side file, a star, tags and a reference attachment, nothing may be left
// pointing nowhere, broken, unreadable or unused, not even as a note.

const strict = { severities: ["error", "warning", "info"] as const };
// Except the link and citation indexes' lag: the app brings them up to date
// on its next tree load after an operation, which this sweep never does (the
// tree's upkeep would repair what the operations should have done themselves).
const sound = (notebook: string) => assertNotebookSound(notebook, { severities: [...strict.severities], allow: ["info indexes: "] });

test("every file operation leaves its notebooks sound", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await seedNotebook("Nb");
  await setStarredFilePath("Nb/papers/a.pdf", true);
  await setFileTagsForPath("Nb/notes/n.md", ["draft"]);
  await writeReferenceLibrary("Nb", [{ key: "smith2020", attachments: ["Nb/papers/a.pdf"] }]);
  await sound("Nb");

  // Within the notebook.
  await moveFile("Nb/papers/a.pdf", "Nb", "b.pdf");
  await sound("Nb");
  await createFolder("Nb", "reading");
  await moveFileToDirectory("Nb/papers/b.pdf", "Nb/reading");
  await sound("Nb");
  await renameFolder("Nb/audio", "recordings");
  await sound("Nb");
  await copyFileToDirectory("Nb/notes/n.md", "Nb/notes", "copy.md");
  await sound("Nb");
  await moveFile("Nb/notes/n.md", "Nb", "renamed.md");
  await sound("Nb");

  // Archiving.
  await archiveFile("Nb/reading/b.pdf");
  await sound("Nb");
  await archiveFolder("Nb/recordings");
  await sound("Nb");

  // To another notebook.
  await moveFileToDirectory("Nb/notes/renamed.md", "Other");
  await sound("Nb");
  await sound("Other");
  await copyFileToDirectory("Nb/notes/copy.md", "Other", "copied.md");
  await sound("Nb");
  await sound("Other");

  // Deleting.
  await deleteFile("Nb/_archive/b.pdf");
  await sound("Nb");
  await deleteFolder("Nb/_archive/recordings");
  await sound("Nb");
  await deleteFolder("Nb/notes");
  await sound("Nb");
  await sound("Other");
}));
