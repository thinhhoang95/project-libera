import { NextRequest, NextResponse } from "next/server";
import { requireAuth, jsonError } from "@/lib/api";
import { generateReview } from "@/lib/markdown-review-ai";
import { reviewString, syncReview } from "@/lib/markdown-review";
import { validateChatMessages, type ChatContext } from "@/lib/document-chat";
import { readReview, updateReview } from "@/lib/storage/markdown-reviews";
import { StorageError } from "@/lib/storage/errors";
export const runtime = "nodejs";
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
    const current = syncReview(doc, snapshot);
    const ids = body.action === "plan" ? body.ids : doc.session?.selectedIds;
    if (!Array.isArray(ids) || ids.length > 200 || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) throw new Error("Invalid selected comments.");
    let references: ChatContext[] = body.action === "plan" ? body.references ?? [] : doc.session?.references ?? [];
    if (!validateChatMessages([{ id: "references", role: "user", text: "", contexts: references }]) || references.some((r) => r.kind !== "document")) throw new Error("Invalid reference files.");
    references = Array.from(new Map(references.filter((r) => r.path !== doc.key).map((r) => [r.path, r])).values());
    if (body.action !== "plan" && body.planVersion !== doc.session?.plan.version) throw new StorageError("Confirm the current plan version.", 409);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(180_000)]);
    const session = await generateReview(current, prompt, ids, references, body.action, signal, body.suggestionId);
    signal.throwIfAborted();
    const result = await updateReview(doc.id, doc.revision, () => ({ ...current, session }));
    return NextResponse.json(result);
  } catch (error) { return jsonError(error instanceof Error ? error.message : "Agentic review failed.", error instanceof StorageError ? error.status : 400); }
}
