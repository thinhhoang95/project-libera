const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const semver = require("semver");

const TARGETS = {
  mac: {
    arch: "arm64",
    builderArgs: ["--mac", "--arm64"],
    feedDirectory: "stable/mac/arm64",
    hostPlatform: "darwin",
    metadataFile: "latest-mac.yml",
  },
  win: {
    arch: "x64",
    builderArgs: ["--win", "--x64"],
    feedDirectory: "stable/win/x64",
    hostPlatform: "win32",
    metadataFile: "latest.yml",
  },
};

function getTarget(platform) {
  const target = TARGETS[platform];

  if (!target) {
    throw new Error(`Unsupported release platform: ${platform || "(missing)"}.`);
  }

  return { platform, ...target };
}

function assertReleaseVersion(version) {
  if (!semver.valid(version) || semver.prerelease(version)) {
    throw new Error(`Release version ${JSON.stringify(version)} must be a stable semantic version.`);
  }

  return version;
}

function assertNewerVersion(localVersion, remoteVersion) {
  assertReleaseVersion(localVersion);

  if (!remoteVersion) {
    return;
  }

  if (!semver.valid(remoteVersion)) {
    throw new Error(`Remote update metadata has invalid version ${JSON.stringify(remoteVersion)}.`);
  }

  if (!semver.gt(localVersion, remoteVersion)) {
    throw new Error(
      `Release version ${localVersion} must be newer than remote version ${remoteVersion}.`,
    );
  }
}

function safeArtifactName(url) {
  const decoded = decodeURIComponent(String(url ?? ""));
  const name = path.posix.basename(decoded);

  if (!name || name !== decoded || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`Unsafe update artifact name: ${JSON.stringify(decoded)}.`);
  }

  return name;
}

function parseUpdateMetadata(contents, expectedVersion) {
  const metadata = yaml.load(contents);

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Update metadata must be a YAML object.");
  }

  if (expectedVersion && metadata.version !== expectedVersion) {
    throw new Error(
      `Update metadata version ${JSON.stringify(metadata.version)} does not match ${expectedVersion}.`,
    );
  }

  if (typeof metadata.version !== "string" || !semver.valid(metadata.version)) {
    throw new Error("Update metadata contains an invalid version.");
  }

  if (!Array.isArray(metadata.files) || metadata.files.length === 0) {
    throw new Error("Update metadata does not reference any artifacts.");
  }

  const files = metadata.files.map((file) => {
    if (!file || typeof file !== "object") {
      throw new Error("Update metadata contains an invalid artifact entry.");
    }

    const name = safeArtifactName(file.url);
    const sha512 = typeof file.sha512 === "string" ? file.sha512.trim() : "";

    if (!sha512) {
      throw new Error(`Update artifact ${name} has no SHA-512 checksum.`);
    }

    return { name, sha512 };
  });

  return { metadata, files };
}

function sha512File(filePath) {
  const hash = crypto.createHash("sha512");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("base64");
}

function collectReleaseFiles(outputDirectory, metadataFile, expectedVersion) {
  const metadataPath = path.join(outputDirectory, metadataFile);

  if (!fs.existsSync(metadataPath)) {
    throw new Error(`Missing update metadata: ${metadataPath}.`);
  }

  const parsed = parseUpdateMetadata(fs.readFileSync(metadataPath, "utf8"), expectedVersion);
  const fileNames = new Set([metadataFile]);

  for (const file of parsed.files) {
    const artifactPath = path.join(outputDirectory, file.name);

    if (!fs.existsSync(artifactPath)) {
      throw new Error(`Missing update artifact: ${artifactPath}.`);
    }

    if (sha512File(artifactPath) !== file.sha512) {
      throw new Error(`SHA-512 mismatch for ${file.name}.`);
    }

    fileNames.add(file.name);
    const blockmapName = `${file.name}.blockmap`;

    if (fs.existsSync(path.join(outputDirectory, blockmapName))) {
      fileNames.add(blockmapName);
    }
  }

  return {
    metadata: parsed.metadata,
    paths: [...fileNames].sort().map((name) => path.join(outputDirectory, name)),
  };
}

module.exports = {
  assertNewerVersion,
  assertReleaseVersion,
  collectReleaseFiles,
  getTarget,
  parseUpdateMetadata,
  safeArtifactName,
};
