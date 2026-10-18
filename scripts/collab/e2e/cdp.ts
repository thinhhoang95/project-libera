// Minimal Chrome DevTools Protocol client for driving a Libera window in
// the e2e run (two-users.ts). Talks to the page target over Node 22's
// global WebSocket; no Playwright, no puppeteer.

import { writeFileSync } from "node:fs";

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it returns a truthy value; throws `message` (with the last value) after `timeoutMs`. */
export async function waitFor<T>(
  check: () => Promise<T> | T,
  options: { timeoutMs: number; message: string; intervalMs?: number },
): Promise<NonNullable<T>> {
  const deadline = Date.now() + options.timeoutMs;
  let last: unknown;
  let lastError: unknown;
  for (;;) {
    try {
      last = await check();
      if (last) return last as NonNullable<T>;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : last !== undefined ? ` Last value: ${JSON.stringify(last)}` : "";
      throw new TimeoutError(`Timed out after ${options.timeoutMs} ms: ${options.message}.${detail}`);
    }
    await sleep(options.intervalMs ?? 100);
  }
}

interface Target {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export async function listTargets(debugPort: number): Promise<Target[]> {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  return (await response.json()) as Target[];
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One page target (a Libera window). */
export class CdpPage {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  readonly consoleErrors: string[] = [];
  /** False for the main-process inspector, where awaited evaluations can be collected. */
  awaitPromises = true;

  private constructor(
    private readonly socket: WebSocket,
    readonly label: string,
  ) {
    socket.addEventListener("message", (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
      };
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
        else waiter.resolve(message.result);
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params?.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined;
        this.consoleErrors.push(details?.exception?.description ?? details?.text ?? "exception");
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
        const args = (message.params.args as Array<{ value?: unknown; description?: string }>) ?? [];
        this.consoleErrors.push(args.map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description ?? "")).join(" "));
      }
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error(`${label}: DevTools socket closed during ${waiter.method}`));
      this.pending.clear();
    });
  }

  /** Waits for the main app window (http://127.0.0.1:<port>/) and connects to it. */
  static async connect(debugPort: number, label: string, timeoutMs = 90_000): Promise<CdpPage> {
    const target = await waitFor(
      async () => {
        const targets = await listTargets(debugPort);
        return targets.find(
          (candidate) =>
            candidate.type === "page" &&
            /^http:\/\/127\.0\.0\.1:\d+\/?(\?.*)?$/.test(candidate.url) &&
            candidate.webSocketDebuggerUrl,
        );
      },
      { timeoutMs, message: `${label}: the main Libera window did not appear on DevTools port ${debugPort}`, intervalMs: 500 },
    );
    const page = await CdpPage.open(target.webSocketDebuggerUrl!, label);
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    return page;
  }

  /**
   * Connects to the Electron main process's Node inspector (`--inspect=<port>`).
   * Only Runtime.evaluate is used there (see menu stubbing in two-users.ts).
   */
  static async connectMain(inspectPort: number, label: string, timeoutMs = 60_000): Promise<CdpPage> {
    const target = await waitFor(
      async () => (await listTargets(inspectPort)).find((candidate) => candidate.webSocketDebuggerUrl),
      { timeoutMs, message: `${label}: the main-process inspector did not appear on port ${inspectPort}`, intervalMs: 300 },
    );
    const main = await CdpPage.open(target.webSocketDebuggerUrl!, label);
    main.awaitPromises = false;
    return main;
  }

  private static async open(url: string, label: string): Promise<CdpPage> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`${label}: could not open ${url}`)), { once: true });
    });
    return new CdpPage(socket, label);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TimeoutError(`${this.label}: ${method} got no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates an expression (awaiting promises) and returns its JSON value; page exceptions are thrown here. */
  async evaluate<T = unknown>(expression: string, timeoutMs = 30_000): Promise<T> {
    const response = await this.send<{
      result: { value?: unknown; description?: string };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>("Runtime.evaluate", { expression, awaitPromise: this.awaitPromises, returnByValue: true, ...(this.awaitPromises ? { userGesture: true } : {}) }, timeoutMs);
    if (response.exceptionDetails) {
      throw new Error(
        `${this.label}: page error: ${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "unknown"}`,
      );
    }
    return response.result.value as T;
  }

  async screenshot(file: string): Promise<string> {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  }

  async insertText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  /** Presses one key. `modifiers`: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
  async key(key: string, options: { code?: string; keyCode?: number; modifiers?: number; text?: string } = {}): Promise<void> {
    const base = {
      key,
      code: options.code ?? key,
      windowsVirtualKeyCode: options.keyCode ?? 0,
      nativeVirtualKeyCode: options.keyCode ?? 0,
      modifiers: options.modifiers ?? 0,
    };
    await this.send("Input.dispatchKeyEvent", { type: options.text ? "keyDown" : "rawKeyDown", ...base, ...(options.text ? { text: options.text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** Real mouse click at the centre of a rectangle (CSS pixels of the viewport). */
  async clickRect(rect: Rect): Promise<void> {
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /**
   * Clicks the element `finder` (a JS expression evaluating to an Element or
   * null) once it exists and is visible. Scrolls it into view first.
   */
  async click(finder: string, what: string, timeoutMs = 20_000, react = true): Promise<void> {
    const rect = await waitFor(
      () =>
        this.evaluate<Rect | null>(`(async () => {
          const el = (${finder});
          if (!el) return null;
          const before = el.getBoundingClientRect();
          // Scroll only when needed: scrolling can move floating UI (popovers) after we measure.
          if (before.top < 0 || before.left < 0 || before.bottom > innerHeight || before.right > innerWidth) el.scrollIntoView({ block: "center", inline: "center" });
          // Let layout settle, then measure.
          // (Not requestAnimationFrame: it does not run while the window is hidden or occluded.)
          await new Promise((resolve) => setTimeout(resolve, 60));
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return null;
          if (el.disabled) return null;
          // Server-rendered markup exists before React hydrates it; wait for its props.
          if (${react} && !Object.keys(el).some((key) => key.startsWith("__reactProps"))) return null;
          // Something else on top (an overlay, a moving popover): wait, as a user would.
          const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          if (!top || (top !== el && !el.contains(top))) return null;
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })()`),
      { timeoutMs, message: `${this.label}: could not find ${what} to click` },
    );
    await this.clickRect(rect);
  }

  /** Focuses the input `finder`, selects its content and types `text` over it (real input events). */
  async fill(finder: string, text: string, what: string, timeoutMs = 20_000): Promise<void> {
    await waitFor(
      () =>
        this.evaluate<boolean>(`(() => {
          const el = (${finder});
          if (!el || el.disabled) return false;
          if (!Object.keys(el).some((key) => key.startsWith("__reactProps"))) return false;
          el.focus();
          if (typeof el.select === "function") el.select();
          return document.activeElement === el;
        })()`),
      { timeoutMs, message: `${this.label}: could not focus ${what}` },
    );
    if (text) await this.insertText(text);
    else await this.key("Delete", { keyCode: 46 });
    const value = await this.evaluate<string>(`(${finder}).value`);
    if (value !== text) throw new Error(`${this.label}: ${what} holds ${JSON.stringify(value)} after typing, expected the typed value`);
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

/** Page-side helpers, injected as a string. All return Elements or null. */
export const DOM = {
  /** First visible element matching `selector` whose trimmed text equals (or matches) `text`. */
  byText: (selector: string, text: string | RegExp, root = "document") =>
    `[...(${root}).querySelectorAll(${JSON.stringify(selector)})].find((el) => {
      const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && ${typeof text === "string" ? `t === ${JSON.stringify(text)}` : `${text.toString()}.test(t)`};
    }) || null`,
  /** The input a <label> whose text starts with `text` points at, inside `root`. */
  byLabel: (text: string, root = "document") =>
    `(() => {
      const label = [...(${root}).querySelectorAll("label")].find((l) => (l.textContent || "").replace(/\\s+/g, " ").trim().startsWith(${JSON.stringify(text)}));
      return label && label.htmlFor ? document.getElementById(label.htmlFor) : null;
    })()`,
  /** The open modal dialog (ModalDialog renders role="dialog"). */
  dialog: (title?: string) =>
    `([...document.querySelectorAll('[role="dialog"]')].find((d) => ${title ? `(d.textContent || "").includes(${JSON.stringify(title)})` : "true"}) || null)`,
};
