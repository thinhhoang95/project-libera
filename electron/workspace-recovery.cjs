const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

function localWorkspaceRecoveryRoot(userDataRoot, stateRoot) {
  return path.join(userDataRoot, "workspace-recovery", createHash("sha256").update(stateRoot).digest("hex"));
}

// A separate journal avoids racing the Next server's queued metadata writes.
// The server validates and reads whichever snapshot is newer at next sign-in.
function writeWorkspaceRecovery(adminRoot, body, canonicalRoot = adminRoot) {
  if (typeof body !== "string") throw new Error("Invalid workspace checkpoint.");
  const value = JSON.parse(body);
  if (value?.version !== 1 || !Number.isFinite(value.updatedAt) || !Array.isArray(value.workspaces)) {
    throw new Error("Invalid workspace checkpoint.");
  }
  const target = path.join(adminRoot, ".libera-workspaces-recovery.json");
  const token = (snapshot) => JSON.stringify({ ...snapshot, updatedAt: 0 });
  try {
    const existing = JSON.parse(fs.readFileSync(target, "utf8"));
    if (token(existing) === token(value)) {
      // A newer normal save may have superseded this old recovery snapshot.
      // Returning to its contents still needs a fresh timestamp in that case.
      try {
        const disk = JSON.parse(fs.readFileSync(path.join(canonicalRoot, ".libera-workspaces.json"), "utf8"));
        if (disk.updatedAt <= existing.updatedAt || token(disk) === token(value)) return;
      } catch (error) { if (error.code === "ENOENT") return; if (error.code) throw error; }
    }
  } catch (error) { if (error.code && error.code !== "ENOENT") throw error; }
  fs.mkdirSync(adminRoot, { recursive: true });
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
}
module.exports = { writeWorkspaceRecovery, localWorkspaceRecoveryRoot };
