const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const sshTarget = process.env.LIBERA_UPDATE_SSH_TARGET || "root@185.214.135.181";
const remoteRoot = process.env.LIBERA_UPDATE_REMOTE_ROOT || "/srv/libera-updates";
const identityFile = (process.env.LIBERA_UPDATE_SSH_KEY || "~/.ssh/id_ed25519").replace(
  /^~(?=\/|\\)/,
  os.homedir(),
);
const nginxDirectory = path.join(projectRoot, "ops", "nginx");
const httpConfig = path.join(nginxDirectory, "libera.intuelle.com-http.conf");
const httpsConfigTemplate = path.join(nginxDirectory, "libera.intuelle.com.conf");
const remoteTemporaryHttp = `/tmp/libera.intuelle.com-http-${process.pid}.conf`;
const remoteTemporaryHttps = `/tmp/libera.intuelle.com-${process.pid}.conf`;
const remoteSite = "/etc/nginx/sites-available/libera.intuelle.com.conf";
const sshArgs = [
  "-i",
  identityFile,
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "BatchMode=yes",
];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: "inherit" });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}.`);
  }
}

function assertSafe(value, label, pattern) {
  if (!pattern.test(value)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
}

function main() {
  assertSafe(sshTarget, "SSH target", /^[A-Za-z0-9_.@:-]+$/);
  assertSafe(remoteRoot, "Remote root", /^\/[A-Za-z0-9._/-]+$/);

  if (!fs.existsSync(identityFile)) {
    throw new Error(`SSH identity file was not found: ${identityFile}.`);
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "libera-update-server-"));
  const httpsConfig = path.join(temporaryDirectory, "libera.intuelle.com.conf");

  try {
    const renderedConfig = fs
      .readFileSync(httpsConfigTemplate, "utf8")
      .replace("/srv/libera-updates", remoteRoot);
    fs.writeFileSync(httpsConfig, renderedConfig, { mode: 0o600 });
    run("scp", [
      ...sshArgs,
      httpConfig,
      `${sshTarget}:${remoteTemporaryHttp}`,
    ]);
    run("scp", [
      ...sshArgs,
      httpsConfig,
      `${sshTarget}:${remoteTemporaryHttps}`,
    ]);
    run("ssh", [
      ...sshArgs,
      sshTarget,
      [
        "set -e",
        `install -d -m 0755 '${remoteRoot}' '${remoteRoot}/stable/mac/arm64' '${remoteRoot}/stable/win/x64' /var/www/acme`,
        `if ! test -s /etc/letsencrypt/live/libera.intuelle.com/fullchain.pem; then install -m 0644 '${remoteTemporaryHttp}' '${remoteSite}'; ln -sfn '${remoteSite}' /etc/nginx/sites-enabled/libera.intuelle.com.conf; nginx -t; systemctl reload nginx; certbot certonly --webroot --webroot-path /var/www/acme --cert-name libera.intuelle.com --domains libera.intuelle.com --non-interactive --agree-tos --keep-until-expiring; fi`,
        `install -m 0644 '${remoteTemporaryHttps}' '${remoteSite}'`,
        `ln -sfn '${remoteSite}' /etc/nginx/sites-enabled/libera.intuelle.com.conf`,
        "nginx -t",
        "systemctl reload nginx",
        "healthy=0; for attempt in 1 2 3 4 5; do if curl --fail --silent --show-error https://libera.intuelle.com/health; then healthy=1; break; fi; sleep 1; done; test \"$healthy\" = 1",
        `rm -f '${remoteTemporaryHttp}' '${remoteTemporaryHttps}'`,
      ].join(" && "),
    ]);
    console.log("The Libera update server is configured and healthy.");
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
