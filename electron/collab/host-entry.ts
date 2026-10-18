// Collab host entry point (Electron utilityProcess). PLACEHOLDER until the
// host core (M1.3) lands: it only reports that it started.

type ParentPort = { postMessage(message: unknown): void };

(process as unknown as { parentPort?: ParentPort }).parentPort?.postMessage({ t: "host-ready", version: 0 });
