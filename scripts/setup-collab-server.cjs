// Deploys the Libera collab server to the Libera VPS (see SETUP.md §6).
//
// 1. Packs server/, the shared protocol and ops/collab from the current commit
//    with `git archive` (uncommitted changes are never deployed).
// 2. Copies it to the server, builds the Docker image there, and installs the
//    compose file and nginx site.
// 3. Obtains the TLS certificate on first run (certbot webroot), starts the
//    stack, and waits for https://<domain>/healthz.
//
// The production .env must already exist at <remote root>/.env (mode 0600);
// the script refuses to start without it. Pass --dry-run to only print the
// remote commands.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const sshTarget = process.env.LIBERA_COLLAB_SSH_TARGET || process.env.LIBERA_UPDATE_SSH_TARGET || "root@185.214.135.181";
const remoteRoot = process.env.LIBERA_COLLAB_REMOTE_ROOT || "/srv/libera-collab";
const domain = process.env.LIBERA_COLLAB_DOMAIN || "collab.libera.intuelle.com";
const identityFile = (process.env.LIBERA_COLLAB_SSH_KEY || process.env.LIBERA_UPDATE_SSH_KEY || "~/.ssh/id_ed25519").replace(
  /^~(?=\/|\\)/,
  os.homedir(),
);
const dryRun = process.argv.includes("--dry-run");
const sshArgs = ["-i", identityFile, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes"];

function run(command, args, options = {}) {
  if (dryRun && options.remote) {
    console.log(`[dry-run] ${command} ${args.join(" ")}`);
    return "";
  }
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: options.capture ? "pipe" : "inherit", encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}.`);
  return result.stdout ?? "";
}

function assertSafe(value, label, pattern) {
  if (!pattern.test(value)) throw new Error(`${label} contains unsupported characters.`);
}

function main() {
  assertSafe(sshTarget, "SSH target", /^[A-Za-z0-9_.@:-]+$/);
  assertSafe(remoteRoot, "Remote root", /^\/[A-Za-z0-9._/-]+$/);
  assertSafe(domain, "Domain", /^[A-Za-z0-9.-]+$/);
  if (!dryRun && !fs.existsSync(identityFile)) throw new Error(`SSH identity file was not found: ${identityFile}.`);

  const commit = run("git", ["rev-parse", "--short=12", "HEAD"], { capture: true }).trim();
  const image = `libera-collab:${commit}`;
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "libera-collab-deploy-"));
  const archive = path.join(temporaryDirectory, `libera-collab-${commit}.tar`);
  const remoteArchive = `/tmp/libera-collab-${commit}-${process.pid}.tar`;
  const remoteSource = `${remoteRoot}/source/${commit}`;
  const site = `/etc/nginx/sites-available/${domain}.conf`;

  try {
    run("git", ["archive", "--format=tar", "-o", archive, "HEAD", "server", "src/lib/collab/protocol", "ops/collab"]);
    run("scp", [...sshArgs, archive, `${sshTarget}:${remoteArchive}`], { remote: true });

    const steps = [
      "set -e",
      `test -s '${remoteRoot}/.env' || { echo 'Missing ${remoteRoot}/.env (copy ops/collab/.env.example and fill it in).' >&2; exit 2; }`,
      `install -d -m 0755 '${remoteSource}' /var/www/acme '${remoteRoot}/backups/wal-archive'`,
      `tar -xf '${remoteArchive}' -C '${remoteSource}'`,
      `docker build -f '${remoteSource}/server/Dockerfile' -t '${image}' '${remoteSource}'`,
      `install -m 0644 '${remoteSource}/ops/collab/docker-compose.prod.yml' '${remoteRoot}/docker-compose.prod.yml'`,
      // Backup scripts and the optional monitoring stack (SETUP.md §8, §10). Local
      // files there (metrics_token, alertmanager.yml) are kept.
      `install -d -m 0755 '${remoteRoot}/backup' '${remoteRoot}/monitoring'`,
      `cp -R '${remoteSource}/ops/collab/backup/.' '${remoteRoot}/backup/'`,
      `chmod 0755 '${remoteRoot}/backup/backup.sh' '${remoteRoot}/backup/restore-drill.sh'`,
      `cp -R '${remoteSource}/ops/collab/monitoring/.' '${remoteRoot}/monitoring/'`,
      // First run: serve the ACME challenge over plain HTTP and get a certificate.
      `if ! test -s /etc/letsencrypt/live/${domain}/fullchain.pem; then install -m 0644 '${remoteSource}/ops/collab/nginx/${domain}-http.conf' '${site}'; ln -sfn '${site}' /etc/nginx/sites-enabled/${domain}.conf; nginx -t; systemctl reload nginx; certbot certonly --webroot --webroot-path /var/www/acme --cert-name ${domain} --domains ${domain} --non-interactive --agree-tos --keep-until-expiring; fi`,
      `install -m 0644 '${remoteSource}/ops/collab/nginx/${domain}.conf' '${site}'`,
      `ln -sfn '${site}' /etc/nginx/sites-enabled/${domain}.conf`,
      "nginx -t",
      "systemctl reload nginx",
      `cd '${remoteRoot}' && COLLAB_IMAGE='${image}' docker compose -f docker-compose.prod.yml up -d --remove-orphans`,
      `healthy=0; for attempt in $(seq 1 30); do if curl --fail --silent --show-error https://${domain}/healthz; then healthy=1; break; fi; sleep 2; done; test "$healthy" = 1`,
      `echo 'COLLAB_IMAGE=${image}' > '${remoteRoot}/deployed-image'`,
      `rm -f '${remoteArchive}'`,
      // Keep the five most recent source trees.
      `ls -1dt '${remoteRoot}/source/'*/ | tail -n +6 | xargs -r rm -rf`,
    ];
    run("ssh", [...sshArgs, sshTarget, steps.join(" && ")], { remote: true });
    console.log(dryRun ? "Dry run finished." : `Collab server ${image} is deployed and healthy at https://${domain}.`);
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
