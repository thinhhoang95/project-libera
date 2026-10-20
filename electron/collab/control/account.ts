// The collaboration account on this machine (collaboration map §4, §10).
//
// Files in userData/collab/:
// - account.json: serverUrl and the account's public fields. No secrets.
// - session.bin: the refresh token, encrypted by the main process with
//   Electron safeStorage (SecretCodec). Plaintext tokens never touch disk; if
//   encryption is unavailable the session lasts only until the host stops.
//
// The access token lives in memory only. Refresh tokens rotate on every
// refresh, so the rotated token is persisted before the new access token is
// handed out: a crash in between would otherwise strand the session.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Account, AuthResponse } from "../../../src/lib/collab/protocol/api";
import type { LocalAccount } from "../../../src/lib/collab/local-api";
import { ApiClient, ApiClientError, type FetchLike } from "../core/api-client";
import type { Clock, Logger } from "../core/clock";
import { consoleLogger, systemClock } from "../core/clock";
import type { TokenProvider } from "../core/sync-client";

/** Encrypts secrets for storage at rest (main process, safeStorage). */
export interface SecretCodec {
  /** Returns base64 ciphertext; rejects when encryption is unavailable. */
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

interface AccountFile {
  version: 1;
  serverUrl: string;
  account: Omit<LocalAccount, "serverUrl">;
}

interface SessionFile {
  version: 1;
  accountId: string;
  /** safeStorage ciphertext, base64. */
  refreshToken: string;
}

const ACCOUNT_FILE = "account.json";
const SESSION_FILE = "session.bin";
/** Refresh this long before the access token expires. */
const EXPIRY_MARGIN_MS = 30_000;

async function writeAtomic(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, contents, { mode: 0o600 });
  await rename(temp, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Normalizes a user-entered server address to an http(s) origin. */
export function normalizeServerUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Enter the collaboration server address.");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TypeError("The collaboration server address is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("The collaboration server address must start with https://.");
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

function toLocal(account: Account | Omit<LocalAccount, "serverUrl">, serverUrl: string): LocalAccount {
  return { id: account.id, email: account.email, displayName: account.displayName, color: account.color, serverUrl };
}

export interface AccountManagerOptions {
  /** userData/collab */
  dir: string;
  secrets: SecretCodec;
  fetch?: FetchLike;
  clock?: Clock;
  logger?: Logger;
}

/** Refreshes access tokens for one signed-in session. */
class Session implements TokenProvider {
  private accessToken: string | null;
  private expiresAt: number | null;
  private inFlight: Promise<string | null> | null = null;

  constructor(
    private readonly manager: AccountManager,
    private readonly api: ApiClient,
    private refreshToken: string,
    initial: { accessToken: string; expiresAt: number } | null,
  ) {
    this.accessToken = initial?.accessToken ?? null;
    this.expiresAt = initial?.expiresAt ?? null;
  }

  get currentRefreshToken(): string {
    return this.refreshToken;
  }

  /** Revokes this session's refresh-token family on the server. */
  logout(): Promise<void> {
    return this.api.logout({ refreshToken: this.refreshToken });
  }

  async getAccessToken(): Promise<string | null> {
    if (this.accessToken && (this.expiresAt === null || this.expiresAt - EXPIRY_MARGIN_MS > this.manager.now())) {
      return this.accessToken;
    }
    return this.refresh();
  }

  accessTokenExpiresAt(): number | null {
    return this.expiresAt;
  }

  refresh(): Promise<string | null> {
    // Two refreshes with one rotating token would revoke the session.
    if (!this.inFlight) {
      this.inFlight = this.doRefresh().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async doRefresh(): Promise<string | null> {
    if (this.manager.session !== this) return null;
    let auth: AuthResponse;
    try {
      auth = await this.api.refresh({ refreshToken: this.refreshToken });
    } catch (error) {
      // Network failures, 5xx and rate limits: stay signed in and retry later.
      if (error instanceof ApiClientError && error.transient) throw error;
      if (!(error instanceof ApiClientError)) throw error;
      await this.manager.sessionInvalid(this);
      return null;
    }
    if (this.manager.session !== this) return null;
    this.refreshToken = auth.refreshToken;
    this.accessToken = auth.accessToken;
    this.expiresAt = Date.parse(auth.accessTokenExpiresAt) || null;
    await this.manager.persistSession(auth.account.id, auth.refreshToken);
    await this.manager.accountRefreshed(auth.account);
    return this.accessToken;
  }
}

export type AccountChange = "signed-in" | "signed-out" | "needs-sign-in" | "updated";

export class AccountManager {
  private readonly dir: string;
  private readonly secrets: SecretCodec;
  private readonly fetchImpl?: FetchLike;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private accountValue: LocalAccount | null = null;
  private sessionValue: Session | null = null;
  private readonly listeners = new Set<(change: AccountChange) => void>();
  private persistWarned = false;

  constructor(options: AccountManagerOptions) {
    this.dir = options.dir;
    this.secrets = options.secrets;
    this.fetchImpl = options.fetch;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? consoleLogger;
  }

  now(): number {
    return this.clock.now();
  }

  get account(): LocalAccount | null {
    return this.accountValue;
  }

  /** The token provider of the current session, or null (signed out or needs sign-in). */
  get session(): (TokenProvider & { readonly currentRefreshToken: string }) | null {
    return this.sessionValue;
  }

  get needsSignIn(): boolean {
    return this.accountValue !== null && this.sessionValue === null;
  }

  on(listener: (change: AccountChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(change: AccountChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }

  private apiFor(serverUrl: string): ApiClient {
    // Auth routes are anonymous; the provider is never asked for a token.
    return new ApiClient({
      baseUrl: serverUrl,
      fetch: this.fetchImpl,
      tokenProvider: { getAccessToken: async () => null, refresh: async () => null },
    });
  }

  /** Reads account.json and the encrypted session. Never throws for missing or corrupt files. */
  async load(): Promise<void> {
    const stored = await readJson<AccountFile>(path.join(this.dir, ACCOUNT_FILE));
    if (!stored || stored.version !== 1 || typeof stored.serverUrl !== "string" || typeof stored.account?.id !== "string") {
      this.accountValue = null;
      this.sessionValue = null;
      return;
    }
    this.accountValue = toLocal(stored.account, stored.serverUrl);
    const session = await readJson<SessionFile>(path.join(this.dir, SESSION_FILE));
    if (!session || session.accountId !== stored.account.id || typeof session.refreshToken !== "string") return;
    try {
      const refreshToken = await this.secrets.decrypt(session.refreshToken);
      this.sessionValue = new Session(this, this.apiFor(stored.serverUrl), refreshToken, null);
    } catch (error) {
      this.logger.warn("Could not decrypt the collaboration session; sign in again", error);
    }
  }

  async signIn(serverUrl: string, auth: AuthResponse): Promise<void> {
    const previous = this.sessionValue;
    this.accountValue = toLocal(auth.account, serverUrl);
    this.sessionValue = new Session(this, this.apiFor(serverUrl), auth.refreshToken, {
      accessToken: auth.accessToken,
      expiresAt: Date.parse(auth.accessTokenExpiresAt) || this.now() + 10 * 60_000,
    });
    await this.writeAccount();
    await this.persistSession(auth.account.id, auth.refreshToken);
    if (previous) void this.logoutQuietly(previous);
    this.notify("signed-in");
  }

  login(request: { serverUrl: string; email: string; password: string }): Promise<AuthResponse> {
    return this.apiFor(request.serverUrl).login({ email: request.email, password: request.password, deviceName: "Libera desktop" });
  }

  register(request: { serverUrl: string; email: string; password: string; displayName: string; invitationToken?: string; registrationCode?: string }): Promise<AuthResponse> {
    return this.apiFor(request.serverUrl).register({
      email: request.email,
      password: request.password,
      displayName: request.displayName,
      ...(request.invitationToken ? { invitationToken: request.invitationToken } : {}),
      ...(request.registrationCode ? { registrationCode: request.registrationCode } : {}),
      deviceName: "Libera desktop",
    });
  }

  /** Starts a new session with a device grant from the person's other computer. */
  exchangeDeviceGrant(serverUrl: string, grant: string): Promise<AuthResponse> {
    return this.apiFor(serverUrl).deviceGrantSignIn({ grant, deviceName: "Libera desktop" });
  }

  /** Ends the session on the server (best effort) and forgets the account on this machine. */
  async signOut(): Promise<void> {
    const session = this.sessionValue;
    this.sessionValue = null;
    this.accountValue = null;
    await rm(path.join(this.dir, SESSION_FILE), { force: true });
    await rm(path.join(this.dir, ACCOUNT_FILE), { force: true });
    if (session) await this.logoutQuietly(session);
    this.notify("signed-out");
  }

  private async logoutQuietly(session: Session): Promise<void> {
    try {
      await session.logout();
    } catch (error) {
      this.logger.warn("Could not end the collaboration session on the server", error);
    }
  }

  /** Server profile changed (PATCH /v1/me, or a refresh returned new fields). */
  async accountRefreshed(account: Account): Promise<void> {
    const current = this.accountValue;
    if (!current || current.id !== account.id) return;
    const next = toLocal(account, current.serverUrl);
    if (next.email === current.email && next.displayName === current.displayName && next.color === current.color) return;
    this.accountValue = next;
    await this.writeAccount();
    this.notify("updated");
  }

  /** @internal The server refused the refresh token: keep the account, ask for sign-in. */
  async sessionInvalid(session: Session): Promise<void> {
    if (this.sessionValue !== session) return;
    this.sessionValue = null;
    await rm(path.join(this.dir, SESSION_FILE), { force: true });
    this.notify("needs-sign-in");
  }

  /** @internal Stores the (rotated) refresh token, encrypted. */
  async persistSession(accountId: string, refreshToken: string): Promise<void> {
    let ciphertext: string;
    try {
      ciphertext = await this.secrets.encrypt(refreshToken);
    } catch (error) {
      // Without safeStorage the token stays in memory: the user signs in
      // again after a restart rather than having a plaintext token on disk.
      if (!this.persistWarned) this.logger.warn("Secure storage is unavailable; the collaboration session will not be remembered", error);
      this.persistWarned = true;
      await rm(path.join(this.dir, SESSION_FILE), { force: true });
      return;
    }
    const file: SessionFile = { version: 1, accountId, refreshToken: ciphertext };
    await writeAtomic(path.join(this.dir, SESSION_FILE), JSON.stringify(file));
  }

  private async writeAccount(): Promise<void> {
    const account = this.accountValue;
    if (!account) return;
    const { serverUrl, ...fields } = account;
    const file: AccountFile = { version: 1, serverUrl, account: fields };
    await writeAtomic(path.join(this.dir, ACCOUNT_FILE), `${JSON.stringify(file, null, 2)}\n`);
  }
}
