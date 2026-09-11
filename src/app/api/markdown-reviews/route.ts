import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, jsonError } from "@/lib/api";
import { anchorAt, commentsKey, decideSuggestions, reviewString, startReviewRound, syncReview, undoReview, redoReview, type ReviewRange } from "@/lib/markdown-review";
import { loadReview, readReview, updateReview, moveReviewPath, listRecoverableReviews } from "@/lib/storage/markdown-reviews";
import { StorageError } from "@/lib/storage/errors";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = requireAuth(request); if (authError) return authError;
  try {
    if (request.nextUrl.searchParams.get("drafts") === "1") return NextResponse.json(await listRecoverableReviews());
    return NextResponse.json(await readReview(reviewString(request.nextUrl.searchParams.get("id"), "document ID", 100))); }
  catch (error) { return jsonError(error instanceof Error ? error.message : "Could not read review.", error instanceof StorageError ? error.status : 400); }
}
export async function POST(request: NextRequest) {
  const authError = requireAuth(request); if (authError) return authError;
  try {
    const raw = await request.text();
    if (raw.length > 2_000_000) return jsonError("Review request is too large.", 413);
    const body = JSON.parse(raw);
    const snapshot = reviewString(body.snapshot, "document snapshot", 500_000);
    if (body.action === "load") {
      const key = reviewString(body.key, "document key", 2000);
      if (!key.trim()) throw new Error("Document key is required.");
      return NextResponse.json(await loadReview(key, snapshot));
    }
    if (body.action === "migrate-path") {
      const from = reviewString(body.from, "old document key", 2000), to = reviewString(body.to, "new document key", 2000);
      if (!from || !to) throw new Error("Document keys are required.");
      await moveReviewPath(from, to); return NextResponse.json({ migrated: true });
    }
    if (!Number.isInteger(body.revision)) throw new Error("Review revision is required.");
    const result = await updateReview(reviewString(body.id, "document ID", 100), body.revision, (stored) => {
      let doc = syncReview(stored, snapshot);
      const thread = doc.threads.find((t) => t.id === body.threadId);
      const text = () => { const value = reviewString(body.text, "comment", 20_000).trim(); if (!value) throw new Error("Enter a comment."); return value; };
      const range = () => anchorAt(snapshot, body.range as ReviewRange);
      switch (body.action) {
        case "sync": break;
        case "new-round": doc = startReviewRound(doc); break;
        case "toggle": doc.enabled = body.enabled === true; break;
        case "comment": doc.threads.push({ id: randomUUID(), anchor: range(), messages: [{ id: randomUUID(), text: text(), createdAt: new Date().toISOString() }], status: "open" }); break;
        case "reply": if (!thread) throw new Error("Comment not found."); thread.messages.push({ id: randomUUID(), text: text(), createdAt: new Date().toISOString() }); break;
        case "edit": { const message = thread?.messages.find((m) => m.id === body.messageId); if (!message) throw new Error("Comment not found."); message.text = text(); break; }
        case "resolve": if (!thread) throw new Error("Comment not found."); thread.status = body.resolved === true ? "resolved" : "open"; break;
        case "reattach": if (!thread) throw new Error("Comment not found."); thread.anchor = range(); break;
        case "delete": if (!thread) throw new Error("Comment not found."); doc.threads = doc.threads.filter((t) => t.id !== thread.id); break;
        case "decision": {
          if (!Array.isArray(body.ids) || body.ids.some((id: unknown) => typeof id !== "string") || !["accept", "reject", "reopen"].includes(body.decision)) throw new Error("Invalid change decision.");
          doc = decideSuggestions(doc, body.ids, body.decision, randomUUID()); break;
        }
        case "undo": doc = undoReview(doc); break;
        case "redo": doc = redoReview(doc); break;
        case "migrate": doc.key = reviewString(body.key, "document key", 2000); break;
        default: throw new Error("Unknown review action.");
      }
      if (doc.session && !["decision", "undo", "redo", "sync", "toggle", "migrate"].includes(body.action) && commentsKey(doc.threads, doc.session.selectedIds) !== doc.session.commentsKey) {
        doc.session.phase = "stale";
        doc.session.suggestions = doc.session.suggestions.map((s) => s.status === "pending" ? { ...s, status: "conflicted" } : s);
      }
      return doc;
    });
    return NextResponse.json(result);
  } catch (error) { return jsonError(error instanceof Error ? error.message : "Review update failed.", error instanceof StorageError ? error.status : 400); }
}
