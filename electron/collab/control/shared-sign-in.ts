// Automatic sign-in on the person's other computers.
//
// The data folder is usually synced between one person's computers (OneDrive
// and the like). When this computer is signed in to the collaboration server
// and the Libera master password is known (the person just unlocked Libera),
// the host asks the server for a device grant and writes it to
// <library>/.libera/collab-sign-in.json, encrypted with a key derived from the
// master password (scrypt, AES-256-GCM). Another computer with the same
// master password that is not signed in decrypts it on unlock and starts its
// own session with the grant.
//
// Why a grant and not the refresh token: refresh tokens rotate on every use
// and the server revokes the whole session when a rotated token comes back,
// so two computers sharing one would sign each other out. A grant never
// rotates; each computer that uses it gets its own session.
//
// Rules that keep computers from fighting over the file:
// - A computer only replaces a file it cannot read (another master password,
//   or a different account) when the person signed in here by hand. Otherwise
//   it would undo the other computer's choice on every unlock.
// - "Stop automatic sign-in on other computers" revokes the grants on the
//   server and leaves a tombstone, so signed-in computers do not mint a new
//   grant behind the person's back. Only a sign-in by hand replaces it.
// - Signing out by hand turns automatic sign-in off on this computer until the
//   person signs in by hand again, or chooses "Continue as ..." for the account
//   the file offers (userData/collab/auto-sign-in.json; not synced).
// - A sign-in by hand is remembered on disk (userData/collab/share-intent.json)
//   until the file reflects it, so a restart before the next unlock keeps it.
// - A file that exists but cannot be read right now (an online-only placeholder
//   while offline, a sync lock) is left alone; only a missing file is created.
//
// The master password and the derived key stay in this process's memory until
// it stops (the password is needed when another computer rewrote the file
// with a new salt). They never reach disk.

import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback, type ScryptOptions } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ContinueSharedSignInRequest, SharedSignInOffer } from "../../../src/lib/collab/local-api";
import type { AuthResponse } from "../../../src/lib/collab/protocol/api";
import { ApiClientError, type ApiClient } from "../core/api-client";
import type { Clock, Logger, TimerHandle } from "../core/clock";
import { consoleLogger, systemClock } from "../core/clock";
import { normalizeServerUrl, type AccountManager } from "./account";

export const SHARED_SIGN_IN_FILE = path.join(".libera", "collab-sign-in.json");
const OPT_OUT_FILE = "auto-sign-in.json";
const INTENT_FILE = "share-intent.json";
const FORMAT = "libera-collab-sign-in";

/** ~0.3 s and 128 MiB per derivation: slows guessing of a stolen file. */
const KDF = { N: 2 ** 17, r: 8, p: 1 };
/** Files from elsewhere may ask for more; refuse parameters that would exhaust memory. */
const KDF_LIMITS = { minN: 2 ** 14, maxN: 2 ** 20, maxR: 16, maxP: 4 };
const MAX_KDF_MEMORY = 128 * 1024 * 1024;
const MAX_KDF_WORK = KDF.N * KDF.r;
const MAX_FILE_BYTES = 16 * 1024;
/** A signed-in computer replaces the grant when it has less than this left. */
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
/** How often a computer that is not signed in looks for a synced file. */
const POLL_MS = 60_000;

interface KdfParams {
  name: "scrypt";
  N: number;
  r: number;
  p: number;
  /** base64 */
  salt: string;
}

interface SharedFile {
  format: typeof FORMAT;
  version: 1;
  kdf: KdfParams;
  /** base64; absent in a tombstone. */
  iv?: string;
  /** base64 AES-256-GCM ciphertext followed by the 16-byte tag. */
  data?: string;
  /** Automatic sign-in was turned off for every computer at this ISO time. */
  disabledAt?: string;
}

export interface SharedPayload {
  serverUrl: string;
  accountId: string;
  email: string;
  grant: string;
  /** ISO time the grant expires on the server. */
  expiresAt: string;
}

type ReadResult = { source?: string } & (
  | { kind: "missing" }
  /** Exists but could not be read now (offline placeholder, lock, partial sync). */
  | { kind: "unavailable" }
  | { kind: "disabled"; file: SharedFile }
  /** Readable JSON this key cannot open (another master password, or damaged). */
  | { kind: "foreign"; file: SharedFile }
  | { kind: "ok"; file: SharedFile; payload: SharedPayload });

/** What the file offers a computer that is not signed in (the sign-in form shows it). */
export type SharedOffer = SharedSignInOffer;

export type SharedSignInErrorCode = "locked" | "nothing-shared" | "already-signed-in" | "refused" | "offer-changed" | "cancelled";

interface ShareIntent {
  version: 2;
  accountId: string;
  serverUrl: string;
  /** Binds the choice to the file seen at sign-in, including while locked. */
  sourceHash: string | null;
}

function sourceHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export class SharedSignInError extends Error {
  constructor(
    readonly code: SharedSignInErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SharedSignInError";
  }
}

interface DerivedKey {
  salt: string;
  params: { N: number; r: number; p: number };
  key: Buffer;
}

function scrypt(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r + 32 * 1024 * 1024 };
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 32, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function validKdf(value: unknown): value is KdfParams {
  if (!value || typeof value !== "object") return false;
  const kdf = value as Partial<KdfParams>;
  return (
    kdf.name === "scrypt" &&
    Number.isInteger(kdf.N) &&
    (kdf.N as number) >= KDF_LIMITS.minN &&
    (kdf.N as number) <= KDF_LIMITS.maxN &&
    ((kdf.N as number) & ((kdf.N as number) - 1)) === 0 &&
    Number.isInteger(kdf.r) &&
    (kdf.r as number) >= 1 &&
    (kdf.r as number) <= KDF_LIMITS.maxR &&
    Number.isInteger(kdf.p) &&
    (kdf.p as number) >= 1 &&
    (kdf.p as number) <= KDF_LIMITS.maxP &&
    128 * (kdf.N as number) * (kdf.r as number) <= MAX_KDF_MEMORY &&
    (kdf.N as number) * (kdf.r as number) * (kdf.p as number) <= MAX_KDF_WORK &&
    typeof kdf.salt === "string" &&
    kdf.salt.length === 24 &&
    Buffer.from(kdf.salt, "base64").length === 16 &&
    Buffer.from(kdf.salt, "base64").toString("base64") === kdf.salt
  );
}

function parseFile(text: string): SharedFile | null {
  try {
    const file = JSON.parse(text) as Partial<SharedFile>;
    if (file?.format !== FORMAT || file.version !== 1 || !validKdf(file.kdf)) return null;
    if (typeof file.disabledAt === "string") return file as SharedFile;
    if (typeof file.iv !== "string" || typeof file.data !== "string" || Buffer.from(file.iv, "base64").length !== 12) return null;
    return file as SharedFile;
  } catch {
    return null;
  }
}

/** The header is authenticated with the payload, so its parameters cannot be swapped. */
function additionalData(kdf: KdfParams): Buffer {
  return Buffer.from(JSON.stringify([FORMAT, 1, kdf.name, kdf.N, kdf.r, kdf.p, kdf.salt]));
}

function sameKdf(a: KdfParams, key: DerivedKey): boolean {
  return a.salt === key.salt && a.N === key.params.N && a.r === key.params.r && a.p === key.params.p;
}

function kdfOf(key: DerivedKey): KdfParams {
  return { name: "scrypt", N: key.params.N, r: key.params.r, p: key.params.p, salt: key.salt };
}

export function encryptPayload(key: DerivedKey, payload: SharedPayload): SharedFile {
  const kdf = kdfOf(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.key, iv);
  cipher.setAAD(additionalData(kdf));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { format: FORMAT, version: 1, kdf, iv: iv.toString("base64"), data: data.toString("base64") };
}

export function decryptPayload(key: DerivedKey, file: SharedFile): SharedPayload | null {
  if (!file.iv || !file.data || !sameKdf(file.kdf, key)) return null;
  try {
    const data = Buffer.from(file.data, "base64");
    if (data.length < 17) return null;
    const decipher = createDecipheriv("aes-256-gcm", key.key, Buffer.from(file.iv, "base64"));
    decipher.setAAD(additionalData(file.kdf));
    decipher.setAuthTag(data.subarray(data.length - 16));
    const text = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString("utf8");
    const payload = JSON.parse(text) as Partial<SharedPayload>;
    if (
      typeof payload.serverUrl !== "string" ||
      typeof payload.accountId !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.grant !== "string" ||
      typeof payload.expiresAt !== "string"
    ) {
      return null;
    }
    if (!payload.accountId || !payload.grant || !Number.isFinite(Date.parse(payload.expiresAt))) return null;
    // A file is only as trustworthy as the master password; still refuse odd addresses.
    return { ...(payload as SharedPayload), serverUrl: normalizeServerUrl(payload.serverUrl) };
  } catch {
    return null;
  }
}

/** The key for an existing file's parameters, or for a new file (fresh salt). */
export async function deriveKey(password: string, kdf?: KdfParams, fresh: { N: number; r: number; p: number } = KDF): Promise<DerivedKey> {
  const params = kdf ? { N: kdf.N, r: kdf.r, p: kdf.p } : fresh;
  const salt = kdf ? kdf.salt : randomBytes(16).toString("base64");
  if (!validKdf({ name: "scrypt", ...params, salt })) throw new TypeError("Unsafe shared sign-in KDF parameters.");
  return { salt, params, key: await scrypt(password, Buffer.from(salt, "base64"), params) };
}

/** Bound allocation before parsing files supplied by a sync provider. */
async function readSharedFile(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_FILE_BYTES) throw new Error("Shared sign-in file is too large.");
    return bytes.subarray(0, size).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function writeAtomic(file: string, contents: string, canCommit?: () => Promise<boolean>): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  await writeFile(temp, contents, { mode: 0o600 });
  // Sync clients and virus scanners hold files briefly; retry the rename.
  for (let attempt = 0; ; attempt++) {
    try {
      if (canCommit && !(await canCommit())) {
        await rm(temp, { force: true });
        return false;
      }
      await rename(temp, file);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        await rm(temp, { force: true });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

export interface SharedSignInOptions {
  /** `<LIBERA_DATA_DIR>/users/admin` (synced). */
  libraryRoot: string;
  /** userData/collab (this computer only). */
  collabDir: string;
  accounts: AccountManager;
  /** Authenticated client of the current session, or null. */
  api(): ApiClient | null;
  /** Switches the runtime to a session started with a grant. */
  signedIn(serverUrl: string, auth: AuthResponse, canAdopt: () => boolean): Promise<void>;
  clock?: Clock;
  logger?: Logger;
  pollMs?: number;
  /** Tests: cheaper scrypt. */
  kdf?: { N: number; r: number; p: number };
}

export class SharedSignIn {
  private readonly file: string;
  private readonly optOutFile: string;
  private readonly intentFile: string;
  private readonly options: SharedSignInOptions;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private key: DerivedKey | null = null;
  /** Kept only to derive keys for files another computer wrote with a new salt. */
  private password: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: TimerHandle | null = null;
  /** Grants the server refused; not tried again until the file changes. */
  private readonly refused = new Set<string>();
  /** Signed in by hand while locked: replace the file on the next unlock. */
  private pendingReplace: ShareIntent | null = null;
  private replaceCleared = false;
  private pendingRewrap: { key: DerivedKey; payload: SharedPayload; expected: ReadResult } | null = null;
  private stopped = false;
  private accountIntent = 0;

  constructor(options: SharedSignInOptions) {
    this.options = options;
    this.file = path.join(options.libraryRoot, SHARED_SIGN_IN_FILE);
    this.optOutFile = path.join(options.collabDir, OPT_OUT_FILE);
    this.intentFile = path.join(options.collabDir, INTENT_FILE);
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? consoleLogger;
  }

  get unlocked(): boolean {
    return this.password !== null;
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The person unlocked Libera with the master password. */
  unlock(password: string): Promise<void> {
    return this.serial(async () => {
      if (this.stopped) return;
      if (this.password !== password) this.key = null;
      this.password = password;
      await this.reconcile();
      this.schedule();
    });
  }

  /** The master password changed on this computer: re-encrypt for the new one. */
  masterPasswordChanged(password: string, previousPassword?: string): Promise<void> {
    return this.serial(async () => {
      if (this.stopped) return;
      // Settings can change the password before this host has received a login.
      if (previousPassword !== undefined) {
        this.password = previousPassword;
        this.key = null;
      }
      const previous = this.password !== null ? await this.read() : null;
      if (this.stopped) return;
      this.password = password;
      this.key = await deriveKey(password, undefined, this.options.kdf);
      if (this.stopped) { this.key.key.fill(0); this.key = null; return; }
      if (!(await this.optedOut()) && (previous?.kind === "ok" || (previous?.kind === "missing" && this.options.accounts.session))) {
        // Keep the grant; only the wrapping changes.
        const payload = previous.kind === "ok" ? previous.payload : await this.mint();
        if (payload && this.key) this.pendingRewrap = { key: this.key, payload, expected: previous };
      }
      await this.reconcile();
      this.schedule();
    });
  }

  /** The person signed in by hand on this computer: theirs is the newest choice. */
  signedInByHand(): Promise<void> {
    this.accountIntent++;
    return this.serial(async () => {
      if (this.stopped) return;
      await rm(this.optOutFile, { force: true });
      this.refused.clear();
      this.pendingReplace = null;
      this.replaceCleared = false;
      const account = this.options.accounts.account;
      if (account) {
        try {
          let hash: string | null;
          try { hash = sourceHash(await readSharedFile(this.file)); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            hash = null;
          }
          this.pendingReplace = { version: 2, accountId: account.id, serverUrl: account.serverUrl, sourceHash: hash };
          await writeAtomic(this.intentFile, `${JSON.stringify(this.pendingReplace, null, 2)}\n`);
        } catch (error) {
          this.logger.warn("Could not remember the collaboration sign-in for your other computers", error);
        }
      }
      await this.reconcile();
    });
  }

  /**
   * The person signs out by hand: no automatic sign-in here until they sign in
   * by hand. With `everywhere`, the grants are revoked on the server first (so
   * synced or backed-up copies of the file stop working) and the file becomes a
   * tombstone. Throws when the server cannot be reached, before anything changed.
   */
  beforeSignOut(everywhere: boolean): Promise<void> {
    this.accountIntent++;
    return this.serial(async () => {
      if (everywhere) {
        const api = this.options.api();
        if (!api) throw new Error("Sign in again to stop automatic sign-in on your other computers.");
        await api.revokeDeviceGrants();
        const current = await this.read();
        if (current.kind !== "unavailable") await this.writeTombstone(current.kind === "missing" ? null : current.file);
      }
      await writeAtomic(this.optOutFile, `${JSON.stringify({ version: 1, disabled: true }, null, 2)}\n`);
      await this.clearReplace();
    });
  }

  /** For the sign-in form: whether "Continue as ..." can be offered. Never exposes the grant. */
  offer(): Promise<SharedOffer> {
    return this.serial(async (): Promise<SharedOffer> => {
      if (this.stopped || this.options.accounts.session) return { state: "none" };
      if (!this.password) {
        let text: string;
        try {
          text = await readSharedFile(this.file);
        } catch {
          return { state: "none" };
        }
        const file = parseFile(text);
        return file && !file.disabledAt ? { state: "locked" } : { state: "none" };
      }
      const current = await this.read();
      if (current.kind !== "ok") return { state: "none" };
      const { payload } = current;
      if (this.refused.has(payload.grant) || Date.parse(payload.expiresAt) <= this.clock.now()) return { state: "none" };
      return { state: "available", accountId: payload.accountId, email: payload.email, serverUrl: payload.serverUrl };
    });
  }

  /**
   * The person chose "Continue as ...": sign in with the account the file offers.
   * An explicit choice, so it lifts this computer's opt-out and may replace a
   * remembered account. Throws SharedSignInError, or ApiClientError when the
   * server cannot be reached.
   */
  continueFromOtherComputer(expected: ContinueSharedSignInRequest): Promise<void> {
    const intent = ++this.accountIntent;
    return this.serial(async () => {
      const accounts = this.options.accounts;
      if (this.stopped) throw new SharedSignInError("nothing-shared", "Libera is closing.");
      if (accounts.session) throw new SharedSignInError("already-signed-in", "This computer is already signed in to collaboration.");
      if (!this.password) throw new SharedSignInError("locked", "Enter your Libera master password to use the sign-in from your other computer.");
      const current = await this.read();
      if (current.kind !== "ok" || Date.parse(current.payload.expiresAt) <= this.clock.now()) {
        throw new SharedSignInError("nothing-shared", "Your other computer is not offering a sign-in any more. Sign in with your email and password.");
      }
      const { payload } = current;
      if (payload.accountId !== expected.accountId || payload.serverUrl !== expected.serverUrl) {
        throw new SharedSignInError("offer-changed", "The account shared by your other computer changed. Check the new account before continuing.");
      }
      const remembered = accounts.account;
      let auth: AuthResponse;
      try {
        auth = await accounts.exchangeDeviceGrant(payload.serverUrl, payload.grant);
      } catch (error) {
        if (error instanceof ApiClientError && !error.transient) {
          this.refused.add(payload.grant);
          throw new SharedSignInError("refused", "The sign-in from your other computer is no longer valid. Sign in with your email and password.");
        }
        throw error;
      }
      if (auth.account.id !== payload.accountId) throw new SharedSignInError("refused", "The sign-in from your other computer belongs to another account.");
      const canAdopt = () => !this.stopped && this.accountIntent === intent && !accounts.session && accounts.account === remembered;
      const cancelled = () => new SharedSignInError("cancelled", "Sign-in was cancelled by another account action. Try again.");
      if (!canAdopt()) throw cancelled();
      // Persist the preference before installing the session. A locked or
      // unwritable opt-out must fail before credentials become active.
      const wasOptedOut = await this.optedOut();
      if (wasOptedOut) await writeAtomic(this.optOutFile, `${JSON.stringify({ version: 1, disabled: false })}\n`);
      const installed = () => !!accounts.session && accounts.account?.id === payload.accountId && accounts.account.serverUrl === payload.serverUrl;
      try {
        await this.options.signedIn(payload.serverUrl, auth, canAdopt);
        if (!installed()) throw cancelled();
        await this.clearReplace();
      } catch (error) {
        if (wasOptedOut && !installed()) {
          await writeAtomic(this.optOutFile, `${JSON.stringify({ version: 1, disabled: true })}\n`)
            .catch((restoreError) => this.logger.warn("Could not restore the collaboration sign-out preference", restoreError));
        }
        throw error;
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.password = null;
    this.key?.key.fill(0);
    this.pendingRewrap?.key.key.fill(0);
    this.pendingRewrap = null;
    this.key = null;
  }

  private schedule(): void {
    this.clock.clearTimeout(this.timer);
    if (this.stopped || !this.password) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.serial(() => this.reconcile())
        .catch((error) => this.logger.warn("Could not reconcile the shared collaboration sign-in", error))
        .finally(() => this.schedule());
    }, this.options.pollMs ?? POLL_MS);
  }

  /** A sign-in by hand that the file does not reflect yet (survives restarts). */
  private async replaceWanted(account: { id: string; serverUrl: string }, current: ReadResult): Promise<boolean> {
    if (this.replaceCleared) return false;
    if (current.kind === "unavailable") return false;
    try {
      const stored = this.pendingReplace ?? (JSON.parse(await readFile(this.intentFile, "utf8")) as Partial<ShareIntent> | null);
      const hash = current.kind === "missing" ? null : sourceHash(current.source!);
      if (stored?.version === 2 && stored.accountId === account.id && stored.serverUrl === account.serverUrl && stored.sourceHash === hash) return true;
      // A newer synced decision supersedes the earlier choice, even after a
      // restart. Version 1 intents have no snapshot and cannot authorize it.
      await this.clearReplace();
      return false;
    } catch {
      return false;
    }
  }

  private async clearReplace(): Promise<void> {
    this.pendingReplace = null;
    this.replaceCleared = true;
    try {
      await rm(this.intentFile, { force: true });
    } catch (error) {
      this.logger.warn("Could not clear the remembered collaboration sign-in", error);
    }
  }

  private async optedOut(): Promise<boolean> {
    try {
      const stored = JSON.parse(await readFile(this.optOutFile, "utf8")) as { version?: unknown; disabled?: unknown } | null;
      if (stored?.version !== 1 || typeof stored.disabled !== "boolean") return true;
      return stored.disabled === true;
    } catch (error) {
      // A corrupt or temporarily locked opt-out must never opt the person in.
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }

  private async read(): Promise<ReadResult> {
    let text: string;
    try {
      text = await readSharedFile(this.file);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "unavailable" };
    }
    const file = parseFile(text);
    // Half-synced or damaged: treat like a file from another password, never as missing.
    if (!file) return { kind: "foreign", source: text, file: { format: FORMAT, version: 1, kdf: { name: "scrypt", ...KDF, salt: "" } } };
    if (file.disabledAt) return { kind: "disabled", source: text, file };
    if (!this.password) return { kind: "foreign", source: text, file };
    if (!this.key || !sameKdf(file.kdf, this.key)) {
      try {
        this.key = await deriveKey(this.password, file.kdf);
        if (this.stopped) { this.key.key.fill(0); this.key = null; return { kind: "foreign", file, source: text }; }
      } catch (error) {
        this.logger.warn("Could not derive the key for the shared collaboration sign-in", error);
        return { kind: "foreign", file, source: text };
      }
    }
    const payload = decryptPayload(this.key, file);
    return payload ? { kind: "ok", file, payload, source: text } : { kind: "foreign", file, source: text };
  }

  private async write(file: SharedFile, expected: ReadResult): Promise<"written" | "changed" | "failed"> {
    try {
      // Minting and scrypt can take seconds. Preserve a newer account choice or
      // tombstone that arrived while either operation was in flight.
      const written = await writeAtomic(this.file, `${JSON.stringify(file, null, 2)}\n`, async () => {
        let source: string | undefined;
        try { source = await readSharedFile(this.file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        return !this.stopped && source === expected.source;
      });
      return written ? "written" : "changed";
    } catch (error) {
      this.logger.warn("Could not write the shared collaboration sign-in", error);
      return "failed";
    }
  }

  private async writeTombstone(previous: SharedFile | null): Promise<void> {
    const kdf = previous && validKdf(previous.kdf) ? previous.kdf : { name: "scrypt" as const, ...(this.options.kdf ?? KDF), salt: randomBytes(16).toString("base64") };
    await writeAtomic(this.file, `${JSON.stringify({ format: FORMAT, version: 1, kdf, disabledAt: new Date(this.clock.now()).toISOString() }, null, 2)}\n`);
  }

  /** A new grant for the signed-in account, or null when the server is unreachable or too old. */
  private async mint(automatic = true, previousGrant?: string): Promise<SharedPayload | null> {
    const account = this.options.accounts.account;
    const session = this.options.accounts.session;
    const api = this.options.api();
    if (!account || !api || !this.options.accounts.session) return null;
    try {
      const created = await api.createDeviceGrant({ deviceName: "Libera desktop", automatic, ...(automatic && previousGrant ? { previousGrant } : {}) });
      if (this.stopped || this.options.accounts.session !== session || this.options.accounts.account !== account) return null;
      return { serverUrl: account.serverUrl, accountId: account.id, email: account.email, grant: created.grant, expiresAt: created.expiresAt };
    } catch (error) {
      // 404 from a server without grants: nothing to share, try next unlock.
      this.logger.warn("Could not create a sign-in for your other computers", error);
      return null;
    }
  }

  private async keyForNewFile(current: ReadResult): Promise<DerivedKey | null> {
    if (!this.password) return null;
    // Keep the salt of a file this key opens, so other computers keep their derived key.
    if (current.kind === "ok" && this.key) return this.key;
    if (!this.key || current.kind !== "missing") this.key = await deriveKey(this.password, undefined, this.options.kdf);
    if (this.stopped) { this.key.key.fill(0); this.key = null; }
    return this.key;
  }

  private async reconcile(): Promise<void> {
    if (this.stopped || !this.password) return;
    if (await this.optedOut()) return;
    if (this.pendingRewrap) {
      const pending = this.pendingRewrap;
      const result = await this.write(encryptPayload(pending.key, pending.payload), pending.expected);
      if (result === "failed") return;
      this.pendingRewrap = null;
    }
    const accounts = this.options.accounts;
    const current = await this.read();
    if (this.stopped) return;
    if (accounts.session && accounts.account) await this.share(current);
    else await this.adopt(current);
  }

  /** Signed in here: make sure the file offers this session's account. */
  private async share(current: ReadResult): Promise<void> {
    const account = this.options.accounts.account!;
    const session = this.options.accounts.session;
    const byHand = await this.replaceWanted(account, current);
    if (current.kind === "unavailable") return;
    if (current.kind === "ok") {
      const same = current.payload.accountId === account.id && current.payload.serverUrl === account.serverUrl;
      const fresh = Date.parse(current.payload.expiresAt) - this.clock.now() > RENEW_BEFORE_MS;
      // A sign-in by hand always mints: the file's grant may have been revoked
      // on the server (a password change) without this computer knowing.
      if (same && fresh && !byHand && !this.refused.has(current.payload.grant)) return;
      // Another account's file stays unless the person chose this one by hand.
      if (!same && !byHand) return;
    } else if (current.kind !== "missing" && !byHand) {
      // Another master password, or a tombstone: not ours to undo.
      return;
    }
    const payload = await this.mint(!byHand, current.kind === "ok" ? current.payload.grant : undefined);
    if (!payload) return;
    const key = await this.keyForNewFile(current);
    if (!key || this.options.accounts.account !== account || this.options.accounts.session !== session) return;
    // A newer synced choice supersedes our earlier manual sign-in. An I/O
    // failure keeps that intent so the next poll can retry the write.
    if (await this.write(encryptPayload(key, payload), current) !== "failed") await this.clearReplace();
  }

  /** Not signed in here: start a session from the file when it offers one. */
  private async adopt(current: ReadResult): Promise<void> {
    if (current.kind !== "ok") return;
    const { payload } = current;
    const accounts = this.options.accounts;
    // Never switch accounts silently: a remembered account must match the file.
    const remembered = accounts.account;
    const intent = this.accountIntent;
    const canAdopt = () => !this.stopped && this.accountIntent === intent && !accounts.session && accounts.account === remembered;
    if (remembered && (remembered.id !== payload.accountId || remembered.serverUrl !== payload.serverUrl)) return;
    if (this.refused.has(payload.grant)) return;
    if (Date.parse(payload.expiresAt) <= this.clock.now()) return;
    let auth: AuthResponse;
    try {
      auth = await accounts.exchangeDeviceGrant(payload.serverUrl, payload.grant);
    } catch (error) {
      if (error instanceof ApiClientError && !error.transient) this.refused.add(payload.grant);
      this.logger.warn("Automatic collaboration sign-in did not work", error);
      return;
    }
    // The person may have signed in by hand while the request was out.
    if (!canAdopt() || await this.optedOut()) return;
    if (auth.account.id !== payload.accountId) return;
    await this.options.signedIn(payload.serverUrl, auth, canAdopt);
  }
}
