const fs = require("node:fs");
const path = require("node:path");

// A separate journal avoids racing the Next server's queued metadata writes.
// The server validates and reads whichever snapshot is newer at next sign-in.
function writeWorkspaceRecovery(adminRoot, body) {
  if (typeof body !== "string") throw new Error("Invalid workspace checkpoint.");
  const value = JSON.parse(body);
  if (value?.version !== 1 || !Number.isFinite(value.updatedAt) || !Array.isArray(value.workspaces)) {
    throw new Error("Invalid workspace checkpoint.");
  }
  fs.mkdirSync(adminRoot, { recursive: true });
  const target = path.join(adminRoot, ".libera-workspaces-recovery.json");
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
}
module.exports = { writeWorkspaceRecovery };
