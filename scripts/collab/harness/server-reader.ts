// Reads what the server holds for a document, independently of any host: a
// fresh WebSocket straight to the server (never through the chaos proxy),
// hello, open with empty state vectors, and the `opened` diffs applied to
// new Y.Docs. Convergence checks compare hosts against this, so a bug that
// makes every host agree on something the server does not have still fails.

import { randomBytes } from "node:crypto";

import * as Y from "yjs";

import {
  decodeMessage,
  encodeMessage,
  MessageType,
  type ClientMessage,
  type OpenedMessage,
  type ServerMessage,
} from "../../../src/lib/collab/protocol/messages";
import type { Subdoc } from "../../../src/lib/collab/protocol/roles";
import { ApiRoutes } from "../../../src/lib/collab/protocol/api";
import { ContentKeys } from "../../../src/lib/collab/protocol/schema";
import { PROTOCOL_VERSION } from "../../../src/lib/collab/protocol/version";

export interface ServerDocState {
  text: string;
  /** Content state vector, decoded (Yjs client id → clock). */
  stateVector: Map<number, number>;
  serverSeq: number;
  role: string;
  schemaVersion: number;
}

type SocketLike = {
  binaryType: string;
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
};

function socketConstructor(): new (url: string) => SocketLike {
  const constructor = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  if (!constructor) throw new Error("This Node has no global WebSocket (Node 22+ is required)");
  return constructor;
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error("Unexpected text frame from the sync server");
}

export function syncUrlOf(httpUrl: string): string {
  const url = new URL(ApiRoutes.sync, httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Opens `docId` as `token`'s account and returns the server's state. */
export async function readServerDoc(serverUrl: string, token: string, docId: string, timeoutMs = 15_000): Promise<ServerDocState> {
  const Socket = socketConstructor();
  const socket = new Socket(syncUrlOf(serverUrl));
  socket.binaryType = "arraybuffer";
  const send = (message: ClientMessage) => socket.send(encodeMessage(message));
  try {
    const opened = await new Promise<OpenedMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server reader timed out opening ${docId}`)), timeoutMs);
      socket.onopen = () =>
        send({
          type: MessageType.Hello,
          protocolVersion: PROTOCOL_VERSION,
          appVersion: "harness-reader",
          token,
          clientId: `reader_${randomBytes(9).toString("base64url")}`,
        });
      socket.onmessage = (event) => {
        const message = decodeMessage(toBytes(event.data)) as ServerMessage;
        if (message.type === MessageType.Welcome) {
          send({ type: MessageType.Open, docId, subdocs: [] });
        } else if (message.type === MessageType.Opened && message.docId === docId) {
          clearTimeout(timer);
          resolve(message);
        } else if (message.type === MessageType.Closed && message.docId === docId) {
          clearTimeout(timer);
          reject(new Error(`Server refused to open ${docId}: ${message.reason}`));
        }
      };
      socket.onclose = (event) => {
        clearTimeout(timer);
        reject(new Error(`Server reader socket closed (${event.code} ${event.reason})`));
      };
      socket.onerror = () => undefined;
    });
    const docs = new Map<Subdoc, Y.Doc>();
    for (const entry of opened.subdocs) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, entry.diff);
      docs.set(entry.subdoc, doc);
    }
    const content = docs.get("content") ?? new Y.Doc();
    const state: ServerDocState = {
      text: content.getText(ContentKeys.source).toString(),
      stateVector: Y.decodeStateVector(Y.encodeStateVector(content)),
      serverSeq: opened.serverSeq,
      role: opened.role,
      schemaVersion: opened.schemaVersion,
    };
    for (const doc of docs.values()) doc.destroy();
    return state;
  } finally {
    socket.onclose = null;
    socket.onmessage = null;
    try {
      socket.close(1000, "reader done");
    } catch {
      // Already closed.
    }
  }
}
