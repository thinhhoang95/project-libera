// The wire protocol and shared types live in the app at
// src/lib/collab/protocol/ (no runtime dependencies). The server imports them
// from here so there is one place to change if the path moves. Each file is
// re-exported on its own: the app's files load as CommonJS under tsx, and
// Node only sees named exports declared directly in a module.
export * from "../../src/lib/collab/protocol/actor.js";
export * from "../../src/lib/collab/protocol/api.js";
export * from "../../src/lib/collab/protocol/codec.js";
export * from "../../src/lib/collab/protocol/local.js";
export * from "../../src/lib/collab/protocol/messages.js";
export * from "../../src/lib/collab/protocol/roles.js";
export * from "../../src/lib/collab/protocol/schema.js";
export * from "../../src/lib/collab/protocol/version.js";
