// Shared collaboration protocol. Keep this directory free of React, DOM,
// Next.js and yjs imports: it is bundled into the collab host and the server.
// The server imports each file directly (see server/src/protocol.ts), so a
// new file here must be added there too.

export * from "./actor";
export * from "./api";
export * from "./codec";
export * from "./local";
export * from "./messages";
export * from "./roles";
export * from "./schema";
export * from "./version";
