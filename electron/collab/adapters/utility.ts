// The host side of the utilityProcess: speaks the parent-port protocol
// (protocol.ts) with Electron main and runs the control app.
//
// Main sends `start` with the directories, the port and the token; the host
// answers `ready` (or `fatal`). After that it forwards HostEvents, serves
// MessagePort attaches, asks main to encrypt and decrypt refresh tokens
// (safeStorage exists only in main), and flushes on `shutdown`.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { HostEvent } from "../../../src/lib/collab/local-api";
import type { Logger } from "../core/clock";
import { consoleLogger } from "../core/clock";
import { STORE_SCHEMA_VERSION } from "../core/store";
import type { SecretCodec } from "../control/account";
import { startControlApp, type ControlApp, type ControlAppOptions } from "../control";
import { adaptMessagePort, type MessagePortLike } from "./message-port";
import { PARENT_PROTOCOL_VERSION, type HostToMain, type MainToHost, type StartMessage } from "./protocol";

/** Electron's process.parentPort (an EventEmitter of MessageEvents). */
export interface ParentPortLike {
  on(event: "message", listener: (event: { data: unknown; ports?: MessagePortLike[] }) => void): unknown;
  postMessage(message: unknown): void;
}

export interface UtilityHostOptions {
  logger?: Logger;
  /** Called after shutdown-done was posted (the entry exits the process). */
  onExit?: (code: number) => void;
  /** Extra options for tests. */
  app?: Partial<ControlAppOptions>;
  secretTimeoutMs?: number;
}

/** Reads or creates userData/collab/installation.json. */
export async function installationId(collabDir: string): Promise<string> {
  const file = path.join(collabDir, "installation.json");
  try {
    const stored = JSON.parse(await readFile(file, "utf8")) as { installationId?: unknown };
    if (typeof stored.installationId === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(stored.installationId)) return stored.installationId;
  } catch {
    // Missing or unreadable: create a new one below.
  }
  const id = `inst_${randomBytes(16).toString("base64url")}`;
  await mkdir(collabDir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ installationId: id }, null, 2)}\n`);
  await rename(temp, file);
  return id;
}

export class UtilityHost {
  private readonly parent: ParentPortLike;
  private readonly logger: Logger;
  private readonly options: UtilityHostOptions;
  private app: ControlApp | null = null;
  private starting: Promise<void> | null = null;
  private stopping = false;
  private nextSecretId = 1;
  private readonly secrets = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** Attaches that arrive while the app is still starting. */
  private readonly early: Array<{ docId: string; port: MessagePortLike }> = [];

  constructor(parent: ParentPortLike, options: UtilityHostOptions = {}) {
    this.parent = parent;
    this.options = options;
    this.logger = options.logger ?? consoleLogger;
    parent.on("message", (event) => this.onMessage(event.data, event.ports ?? []));
  }

  /** The running control app (null before ready and after a failed start). */
  get controlApp(): ControlApp | null {
    return this.app;
  }

  private post(message: HostToMain): void {
    this.parent.postMessage(message);
  }

  private onMessage(data: unknown, ports: MessagePortLike[]): void {
    if (!data || typeof data !== "object") return;
    const message = data as MainToHost;
    switch (message.t) {
      case "start":
        if (!this.starting) this.starting = this.start(message);
        return;
      case "nudge":
      case "resume":
        // After sleep the socket may look open but be dead; nudge probes it.
        this.app?.runtime.nudge();
        return;
      case "suspend":
        // Every edit is already committed to SQLite before it is shown as
        // saved, so there is nothing to flush; the socket is probed on resume.
        return;
      case "shutdown":
        void this.shutdown(message.id);
        return;
      case "attach": {
        const port = ports[0];
        if (!port) return;
        if (typeof message.docId !== "string" || !message.docId) {
          port.close();
          return;
        }
        this.attach(message.docId, port);
        return;
      }
      case "secret-result": {
        const pending = this.secrets.get(message.id);
        if (!pending) return;
        this.secrets.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new Error(message.error));
        return;
      }
    }
  }

  private secret(op: "encrypt" | "decrypt", value: string): Promise<string> {
    const id = this.nextSecretId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.secrets.delete(id);
        reject(new Error("The main process did not answer a secure-storage request."));
      }, this.options.secretTimeoutMs ?? 10_000);
      this.secrets.set(id, { resolve, reject, timer });
      this.post({ t: "secret", id, op, value });
    });
  }

  private get codec(): SecretCodec {
    return {
      encrypt: (plaintext) => this.secret("encrypt", plaintext),
      decrypt: (ciphertext) => this.secret("decrypt", ciphertext),
    };
  }

  private async start(message: StartMessage): Promise<void> {
    try {
      if (message.protocol !== PARENT_PROTOCOL_VERSION) {
        throw new Error(`Main speaks parent protocol ${message.protocol}; this host speaks ${PARENT_PROTOCOL_VERSION}.`);
      }
      const collabDir = path.join(message.userData, "collab");
      await mkdir(collabDir, { recursive: true });
      const options: ControlAppOptions = {
        collabDir,
        libraryRoot: path.join(message.dataDir, "users", "admin"),
        galleryRoot: path.join(message.dataDir, "gallery"),
        appVersion: message.appVersion,
        installationId: await installationId(collabDir),
        secrets: this.codec,
        emit: (event: HostEvent) => this.post({ t: "event", event }),
        logger: this.logger,
        ...this.options.app,
        server: { token: message.token, port: message.port, logger: this.logger, ...this.options.app?.server },
      };
      let app: ControlApp;
      try {
        app = await startControlApp(options);
      } catch (error) {
        // The previous host's port can be taken by now; any port beats no
        // host (main updates the URL it gives Next).
        if ((error as NodeJS.ErrnoException)?.code !== "EADDRINUSE" || !message.port) throw error;
        this.logger.warn(`Port ${message.port} is in use; the control API moves to another port`);
        app = await startControlApp({ ...options, server: { ...options.server, port: 0 } });
      }
      this.app = app;
      this.post({ t: "ready", protocol: PARENT_PROTOCOL_VERSION, url: app.address.url, port: app.address.port, storeSchemaVersion: STORE_SCHEMA_VERSION });
      for (const { docId, port } of this.early.splice(0)) this.attach(docId, port);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.logger.error("The collab host could not start", error);
      this.post({ t: "fatal", message: text });
      for (const { port } of this.early.splice(0)) port.close();
      this.options.onExit?.(1);
    }
  }

  private attach(docId: string, port: MessagePortLike): void {
    if (this.stopping) {
      port.close();
      return;
    }
    const app = this.app;
    if (!app) {
      this.early.push({ docId, port });
      return;
    }
    try {
      const host = app.runtime.host;
      const record = host.store.getDoc(docId);
      const projectId = record?.projectId ?? host.store.getDocMeta(docId)?.projectId ?? undefined;
      host.attachReplica(docId, adaptMessagePort(port, this.logger), projectId ? { projectId } : {});
    } catch (error) {
      this.logger.warn(`Could not attach a replica for ${docId}`, error);
      port.close();
    }
  }

  private async shutdown(id: number): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    let failure: string | undefined;
    try {
      await this.starting;
      await this.app?.close();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      this.logger.error("The collab host did not stop cleanly", error);
    }
    this.post(failure ? { t: "shutdown-done", id, error: failure } : { t: "shutdown-done", id });
    this.options.onExit?.(failure ? 1 : 0);
  }
}
