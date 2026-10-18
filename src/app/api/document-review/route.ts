import { NextRequest, NextResponse } from "next/server";
import { requireAuth, jsonError } from "@/lib/api";
import { generateReview } from "@/lib/markdown-review-ai";
import { reviewString, syncReview, type ReviewThread } from "@/lib/markdown-review";
import { validateChatMessages, type ChatContext } from "@/lib/document-chat";
import { readReview, updateReview } from "@/lib/storage/markdown-reviews";
import { StorageError } from "@/lib/storage/errors";
export const runtime = "nodejs";

/** Shared comment threads as the window projected them, checked like any request data. */
function reviewThreads(value: unknown, snapshot: string): ReviewThread[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error("Invalid shared comments.");
  return value.map((raw): ReviewThread => {
    const thread = raw as Partial<ReviewThread> | null;
    const anchor = thread?.anchor;
    if (!thread || !anchor || typeof anchor !== "object") throw new Error("Invalid shared comment.");
    const start = Number(anchor.start), end = Number(anchor.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > snapshot.length) throw new Error("Invalid shared comment passage.");
    if (!Array.isArray(thread.messages) || !thread.messages.length || thread.messages.length > 200) throw new Error("Invalid shared comment messages.");
    return {
      id: reviewString(thread.id, "comment ID", 100),
      status: thread.status === "resolved" ? "resolved" : "open",
      anchor: {
        start, end,
        quote: reviewString(anchor.quote ?? "", "comment quote", 100_000),
        prefix: reviewString(anchor.prefix ?? "", "comment context", 1_000),
        suffix: reviewString(anchor.suffix ?? "", "comment context", 1_000),
        state: anchor.state === "attached" ? "attached" : "orphaned",
      },
      messages: thread.messages.map((message) => ({
        id: reviewString(message?.id, "message ID", 100),
        text: reviewString(message?.text ?? "", "comment", 20_000),
        createdAt: reviewString(message?.createdAt ?? "", "comment time", 100),
      })),
    };
  });
}
export async function POST(request: NextRequest) {
  const authError = requireAuth(request); if (authError) return authError;
  try {
    const raw = await request.text();
    if (raw.length > 18_000_000) return jsonError("Review context is too large.", 413);
    const body = JSON.parse(raw);
    if (!["plan", "generate", "revise"].includes(body.action)) throw new Error("Invalid review stage.");
    const doc = await readReview(reviewString(body.id, "document ID", 100));
    if (doc.revision !== body.revision) throw new StorageError("Review changed. Reload before retrying.", 409);
    const snapshot = reviewString(body.snapshot, "document snapshot", 500_000);
    const prompt = reviewString(body.prompt ?? "", "request", 20_000);
    const synced = syncReview(doc, snapshot);
    // A shared document's comments live on the collab server, so the window
    // sends them. They are planned against but never written to the local
    // review file, which keeps only this user's private session.
    const sharedThreads = body.sharedThreads === undefined ? null : reviewThreads(body.sharedThreads, snapshot);
    const current = sharedThreads ? { ...synced, threads: sharedThreads } : synced;
    const ids = body.action === "plan" ? body.ids : doc.session?.selectedIds;
    if (!Array.isArray(ids) || ids.length > 200 || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) throw new Error("Invalid selected comments.");
    let references: ChatContext[] = body.action === "plan" ? body.references ?? [] : doc.session?.references ?? [];
    if (!validateChatMessages([{ id: "references", role: "user", text: "", contexts: references }]) || references.some((r) => r.kind !== "document")) throw new Error("Invalid reference files.");
    references = Array.from(new Map(references.filter((r) => r.path !== doc.key).map((r) => [r.path, r])).values());
    if (body.action !== "plan" && body.planVersion !== doc.session?.plan.version) throw new StorageError("Confirm the current plan version.", 409);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(180_000)]);
    const session = await generateReview(current, prompt, ids, references, body.action, signal, body.suggestionId);
    signal.throwIfAborted();
    const result = await updateReview(doc.id, doc.revision, () => ({ ...synced, session }));
    return NextResponse.json(result);
  } catch (error) { return jsonError(error instanceof Error ? error.message : "Agentic review failed.", error instanceof StorageError ? error.status : 400); }
}
