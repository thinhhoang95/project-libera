const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  assertNewerVersion,
  collectReleaseFiles,
  getTarget,
  parseUpdateMetadata,
  safeArtifactName,
} = require("./electron-release-utils.cjs");

test("uses independent native build targets", () => {
  assert.deepEqual(getTarget("mac").builderArgs, ["--mac", "--arm64"]);
  assert.equal(getTarget("mac").feedDirectory, "stable/mac/arm64");
  assert.deepEqual(getTarget("win").builderArgs, ["--win", "--x64"]);
  assert.equal(getTarget("win").feedDirectory, "stable/win/x64");
});

test("requires a strictly newer stable semantic version", () => {
  assert.doesNotThrow(() => assertNewerVersion("1.2.4", "1.2.3"));
  assert.throws(() => assertNewerVersion("1.2.3", "1.2.3"), /must be newer/);
  assert.throws(() => assertNewerVersion("1.2.2", "1.2.3"), /must be newer/);
  assert.throws(() => assertNewerVersion("1.3.0-beta.1", "1.2.3"), /stable semantic/);
});

test("rejects traversal and shell characters in artifact names", () => {
  assert.equal(safeArtifactName("Libera-1.0.0-mac-arm64.zip"), "Libera-1.0.0-mac-arm64.zip");
  assert.throws(() => safeArtifactName("../release.zip"), /Unsafe/);
  assert.throws(() => safeArtifactName("release;touch.zip"), /Unsafe/);
});

test("validates metadata checksums and includes blockmaps", (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "libera-release-test-"));
  context.after(() => fs.rmSync(temporaryDirectory, { force: true, recursive: true }));
  const artifactName = "Libera-1.0.0-mac-arm64.zip";
  const artifact = Buffer.from("test update artifact");
  const sha512 = crypto.createHash("sha512").update(artifact).digest("base64");
  fs.writeFileSync(path.join(temporaryDirectory, artifactName), artifact);
  fs.writeFileSync(path.join(temporaryDirectory, `${artifactName}.blockmap`), "blockmap");
  fs.writeFileSync(
    path.join(temporaryDirectory, "latest-mac.yml"),
    `version: 1.0.0\nfiles:\n  - url: ${artifactName}\n    sha512: ${sha512}\n`,
  );

  const release = collectReleaseFiles(temporaryDirectory, "latest-mac.yml", "1.0.0");
  assert.deepEqual(
    release.paths.map((filePath) => path.basename(filePath)),
    [artifactName, `${artifactName}.blockmap`, "latest-mac.yml"],
  );

  fs.writeFileSync(path.join(temporaryDirectory, artifactName), "tampered");
  assert.throws(
    () => collectReleaseFiles(temporaryDirectory, "latest-mac.yml", "1.0.0"),
    /SHA-512 mismatch/,
  );
});

test("requires files and a matching metadata version", () => {
  assert.throws(() => parseUpdateMetadata("version: 1.0.0\n", "1.0.0"), /does not reference/);
  assert.throws(
    () =>
      parseUpdateMetadata(
        "version: 1.0.1\nfiles:\n  - url: app.zip\n    sha512: abc\n",
        "1.0.0",
      ),
    /does not match/,
  );
});
