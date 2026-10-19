// Helpers for the p3a-* tests (Phase 3 part A on the desktop): shared tabs on
// a wire harness with a known local account, CodeMirror views bound the way
// the editors bind them, and a recording stand-in for the decisions API.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { DecideSuggestionsLocalRequest, DecideSuggestionsLocalResponse } from "../../../src/lib/collab/local-api";
import type { DecisionOutcome } from "../../../src/lib/collab/protocol/api";
import type { Role } from "../../../src/lib/collab/protocol/roles";
import { sharedCodeMirrorSource, type SharedCodeMirrorBinding } from "../../../src/lib/collab/bindings/react-codemirror";
import type { SharedDocRegistry, SharedDocSession } from "../../../src/lib/collab/client/registry";
import { setSuggestionsDefaults } from "../../../src/lib/collab/client/suggestions";
import type { SuggestionsApi } from "../../../src/lib/collab/client/suggestions-api";
import { createHarness, type Harness } from "./wire-harness";

export const ADA = { name: "Ada", color: "#ff8800", userId: "ada" };
export const BOB = { name: "Bob", color: "#22aa66", userId: "bob" };

/** Records decisions and answers them with `outcome` (no server). */
export function recordingApi(outcome: DecisionOutcome = "applied"): SuggestionsApi & { decisions: DecideSuggestionsLocalRequest[] } {
  const decisions: DecideSuggestionsLocalRequest[] = [];
  return {
    decisions,
    async decide(_docId, body): Promise<DecideSuggestionsLocalResponse> {
      decisions.push(body);
      return {
        queued: false,
        commandId: body.commandId ?? "cmd-test",
        results: body.decisions.map((decision) => ({ suggestionId: decision.suggestionId, outcome: decision.decision === "reject" ? "rejected" : outcome, decidedBy: { id: "ada", displayName: "Ada", color: "#ff8800" } })),
        serverSeq: 1,
        checkpointRevisionId: null,
      };
    },
    async command() { return { state: "unknown" }; },
    async revert() { return { outcome: "reverted", serverSeq: 2 }; },
    async history() { return []; },
    async create() { return { suggestionIds: [], staleIndexes: [] }; },
    async withdraw() { return { withdrawn: [], skipped: [] }; },
  };
}

export interface SharedTab {
  harness: Harness;
  registry: SharedDocRegistry;
  session: SharedDocSession;
  close(): void;
}

/** A shared tab bound to a fresh harness document, with the local account set. */
export async function sharedTab(options: { text: string; role?: Role; kind?: "markdown" | "latex" | "text"; path?: string; api?: SuggestionsApi; user?: typeof ADA }): Promise<SharedTab> {
  const harness = createHarness({ text: options.text, role: options.role });
  const path = options.path ?? "Shared/note.md";
  const { registry } = harness.registry({ paths: [path], kind: options.kind ?? "markdown" });
  registry.setLocalUser(options.user ?? ADA);
  setSuggestionsDefaults({ registry, api: options.api ?? recordingApi(), subscribeEvents: () => () => {}, loadMembers: async () => [], pollMs: 50 });
  await registry.bindTab(path, path);
  const session = registry.sessionForTab(path)!;
  await session.replica.whenAttached();
  return {
    harness,
    registry,
    session,
    close() {
      setSuggestionsDefaults({});
      harness.close();
    },
  };
}

/** A CodeMirror view bound to the session the way the shared editors bind it. */
export function mountCodeMirror(session: SharedDocSession, registry: SharedDocRegistry): { view: EditorView; binding: SharedCodeMirrorBinding; destroy(): void } {
  const binding = sharedCodeMirrorSource(session, registry).create();
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: EditorState.create({ doc: binding.initialText, extensions: [binding.extension] }), parent });
  binding.attach(view);
  return {
    view,
    binding,
    destroy() {
      view.destroy();
      binding.destroy();
      parent.remove();
    },
  };
}

export const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
