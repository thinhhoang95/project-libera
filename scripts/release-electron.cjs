const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  assertNewerVersion,
  assertReleaseVersion,
  collectReleaseFiles,
  getTarget,
  parseUpdateMetadata,
} = require("./lib/electron-release-utils.cjs");

const projectRoot = path.resolve(__dirname, "..");
const outputDirectory = path.join(projectRoot, "dist-electron");
const DEFAULT_SSH_TARGET = "root@185.214.135.181";
const DEFAULT_REMOTE_ROOT = "/srv/libera-updates";
const DEFAULT_BASE_URL = "https://libera.intuelle.com";
const KEEP_RELEASES = 5;

function parseArguments(argv) {
  const platformIndex = argv.indexOf("--platform");

  return {
    allowDirty: argv.includes("--allow-dirty"),
    dryRun: argv.includes("--dry-run"),
    platform: platformIndex >= 0 ? argv[platformIndex + 1] : "",
  };
}

function expandHome(filePath) {
  return filePath === "~"
    ? os.homedir()
    : filePath.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), filePath.slice(2))
      : filePath;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: options.capture ? "utf8" : undefined,
    env: options.env ?? process.env,
    input: options.input,
    stdio: options.capture ? ["pipe", "pipe", "pipe"] : "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const detail = options.capture ? (result.stderr || result.stdout || "").trim() : "";
    throw new Error(`${command} failed with exit code ${result.status}.${detail ? ` ${detail}` : ""}`);
  }

  return options.capture ? result.stdout : "";
}

function assertSafeRemoteValue(value, label, pattern) {
  if (!pattern.test(value)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
}

function assertReleaseCredentials(target) {
  if (target.platform === "mac") {
    if (!process.env.CSC_LINK && !process.env.CSC_NAME) {
      throw new Error("Set CSC_LINK (or CSC_NAME) for the Developer ID Application certificate.");
    }

    const apiKeyReady =
      process.env.APPLE_API_KEY &&
      process.env.APPLE_API_KEY_ID &&
      process.env.APPLE_API_ISSUER &&
      process.env.APPLE_TEAM_ID;
    const appleIdReady =
      process.env.APPLE_ID &&
      process.env.APPLE_APP_SPECIFIC_PASSWORD &&
      process.env.APPLE_TEAM_ID;
    const keychainReady = process.env.APPLE_KEYCHAIN_PROFILE;

    if (!apiKeyReady && !appleIdReady && !keychainReady) {
      throw new Error("Configure Apple API-key, Apple ID, or keychain-profile notarization credentials.");
    }
  } else {
    if (!process.env.WIN_CSC_LINK && !process.env.CSC_LINK) {
      throw new Error("Set WIN_CSC_LINK for the Windows Authenticode certificate.");
    }

    if (!process.env.WIN_CSC_KEY_PASSWORD && !process.env.CSC_KEY_PASSWORD) {
      throw new Error("Set WIN_CSC_KEY_PASSWORD for the Windows Authenticode certificate.");
    }
  }
}

function assertCleanWorktree(allowDirty) {
  if (allowDirty) {
    return;
  }

  const status = run("git", ["status", "--porcelain", "--untracked-files=no"], {
    capture: true,
  });

  if (status.trim()) {
    throw new Error("Tracked files are modified. Commit them or pass --allow-dirty intentionally.");
  }
}

function buildRelease(target, baseUrl) {
  fs.rmSync(outputDirectory, { force: true, recursive: true });
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const publishUrl = `${baseUrl}/stable/\${os}/\${arch}`;
  const args = [
    "run",
    "electron:dist",
    "--",
    ...target.builderArgs,
    "-c.forceCodeSigning=true",
    `-c.publish.url=${publishUrl}`,
  ];

  run(npmCommand, args);
}

function findMacApp() {
  const candidates = [
    path.join(outputDirectory, "mac-arm64"),
    path.join(outputDirectory, "mac"),
  ];

  for (const directory of candidates) {
    if (!fs.existsSync(directory)) {
      continue;
    }

    const appName = fs.readdirSync(directory).find((name) => name.endsWith(".app"));

    if (appName) {
      return path.join(directory, appName);
    }
  }

  throw new Error("Could not find the packaged macOS application for signature validation.");
}

function validatePlatformSignature(target, releasePaths) {
  if (target.platform === "mac") {
    const appPath = findMacApp();
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
    run("spctl", ["--assess", "--verbose", "--type", "exec", appPath]);
    run("xcrun", ["stapler", "validate", appPath]);
    return;
  }

  const installer = releasePaths.find((filePath) => filePath.endsWith(".exe"));

  if (!installer) {
    throw new Error("Could not find the Windows installer for signature validation.");
  }

  const escapedPath = installer.replace(/'/g, "''");
  const command = `$signature = Get-AuthenticodeSignature -LiteralPath '${escapedPath}'; if ($signature.Status -ne 'Valid') { Write-Error $signature.StatusMessage; exit 1 }`;
  const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand]);
}

function sshArguments(identityFile) {
  return [
    "-i",
    identityFile,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
  ];
}

function readRemoteVersion({ identityFile, metadataFile, remoteFeed, sshTarget }) {
  const command = `if test -f '${remoteFeed}/${metadataFile}'; then cat '${remoteFeed}/${metadataFile}'; fi`;
  const contents = run("ssh", [...sshArguments(identityFile), sshTarget, command], {
    capture: true,
  });

  if (!contents.trim()) {
    return "";
  }

  return parseUpdateMetadata(contents).metadata.version;
}

const ACTIVATE_SCRIPT = String.raw`set -euo pipefail
remote_root="$1"
staging="$2"
feed="$3"
metadata="$4"
version="$5"
keep="$6"
trap 'rm -rf "$staging"' EXIT
case "$staging" in "$remote_root"/.staging/*) ;; *) echo "Unsafe staging path" >&2; exit 1;; esac
mkdir -p "$feed" "$feed/.release-manifests"
manifest="$staging/release-manifest.txt"
test -s "$manifest"
while IFS= read -r name; do
  case "$name" in ""|*[!A-Za-z0-9._-]*) echo "Unsafe artifact name: $name" >&2; exit 1;; esac
  test -f "$staging/$name"
done < "$manifest"
while IFS= read -r name; do
  test "$name" = "$metadata" && continue
  if test -e "$feed/$name"; then
    cmp -s "$staging/$name" "$feed/$name" || { echo "Published artifact differs: $name" >&2; exit 1; }
    rm -f "$staging/$name"
  else
    mv "$staging/$name" "$feed/$name"
  fi
  chmod 0644 "$feed/$name"
done < "$manifest"
install -m 0644 "$manifest" "$feed/.release-manifests/$version.txt"
install -m 0644 "$staging/$metadata" "$feed/.$metadata.new"
mv -f "$feed/.$metadata.new" "$feed/$metadata"
find "$feed/.release-manifests" -maxdepth 1 -type f -printf '%T@ %p\n' | sort -nr | tail -n "+$((keep + 1))" | cut -d' ' -f2- | while IFS= read -r old_manifest; do
  while IFS= read -r name; do
    test "$name" = "$metadata" && continue
    case "$name" in ""|*[!A-Za-z0-9._-]*) continue;; esac
    rm -f "$feed/$name"
  done < "$old_manifest"
  rm -f "$old_manifest"
done
`;

function uploadAndActivate({
  baseUrl,
  identityFile,
  metadataFile,
  releasePaths,
  remoteFeed,
  remoteRoot,
  sshTarget,
  target,
  version,
}) {
  const staging = `${remoteRoot}/.staging/${target.platform}-${target.arch}-${version}-${Date.now()}`;
  run("ssh", [
    ...sshArguments(identityFile),
    sshTarget,
    `mkdir -p '${staging}' && chmod 0700 '${staging}'`,
  ]);

  const manifestPath = path.join(outputDirectory, `release-manifest-${target.platform}.txt`);
  fs.writeFileSync(
    manifestPath,
    `${releasePaths.map((filePath) => path.basename(filePath)).join("\n")}\n`,
  );

  try {
    run("scp", [
      ...sshArguments(identityFile),
      ...releasePaths,
      manifestPath,
      `${sshTarget}:${staging}/`,
    ]);
    run(
      "ssh",
      [
        ...sshArguments(identityFile),
        sshTarget,
        "bash",
        "-s",
        "--",
        remoteRoot,
        staging,
        remoteFeed,
        metadataFile,
        version,
        String(KEEP_RELEASES),
      ],
      { input: ACTIVATE_SCRIPT },
    );
  } finally {
    fs.rmSync(manifestPath, { force: true });
  }

  const feedUrl = `${baseUrl}/${target.feedDirectory}`;
  const verifyCommand = [
    "set -e",
    `curl --fail --silent --show-error '${feedUrl}/${metadataFile}' >/dev/null`,
    ...releasePaths
      .filter((filePath) => path.basename(filePath) !== metadataFile)
      .map(
        (filePath) =>
          `curl --fail --silent --show-error --range 0-0 '${feedUrl}/${path.basename(filePath)}' >/dev/null`,
      ),
  ].join("; ");
  run("ssh", [...sshArguments(identityFile), sshTarget, verifyCommand]);
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const target = getTarget(args.platform);

  if (process.platform !== target.hostPlatform) {
    throw new Error(
      `${target.platform} releases must run on ${target.hostPlatform}; this machine is ${process.platform}.`,
    );
  }

  const appPackage = require(path.join(projectRoot, "package.json"));
  const version = assertReleaseVersion(appPackage.version);
  const sshTarget = process.env.LIBERA_UPDATE_SSH_TARGET || DEFAULT_SSH_TARGET;
  const identityFile = expandHome(
    process.env.LIBERA_UPDATE_SSH_KEY || path.join("~", ".ssh", "id_ed25519"),
  );
  const remoteRoot = process.env.LIBERA_UPDATE_REMOTE_ROOT || DEFAULT_REMOTE_ROOT;
  const baseUrl = (process.env.LIBERA_UPDATE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  const remoteFeed = `${remoteRoot}/${target.feedDirectory}`;

  assertSafeRemoteValue(sshTarget, "SSH target", /^[A-Za-z0-9_.@:-]+$/);
  assertSafeRemoteValue(remoteRoot, "Remote root", /^\/[A-Za-z0-9._/-]+$/);
  assertSafeRemoteValue(baseUrl, "Update base URL", /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/);
  assertReleaseCredentials(target);
  assertCleanWorktree(args.allowDirty);
  buildRelease(target, baseUrl);
  const release = collectReleaseFiles(outputDirectory, target.metadataFile, version);
  validatePlatformSignature(target, release.paths);

  if (args.dryRun) {
    console.log(`Dry run complete: ${target.platform}/${target.arch} ${version} is valid.`);
    return;
  }

  if (!fs.existsSync(identityFile)) {
    throw new Error(`SSH identity file was not found: ${identityFile}.`);
  }

  const remoteVersion = readRemoteVersion({
    identityFile,
    metadataFile: target.metadataFile,
    remoteFeed,
    sshTarget,
  });
  assertNewerVersion(version, remoteVersion);
  uploadAndActivate({
    baseUrl,
    identityFile,
    metadataFile: target.metadataFile,
    releasePaths: release.paths,
    remoteFeed,
    remoteRoot,
    sshTarget,
    target,
    version,
  });
  console.log(`Published Libera ${version} to ${baseUrl}/${target.feedDirectory}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
