import { isChatFontSize } from "@/lib/chat-preferences";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { getAiFunctionOptions } from "@/lib/ai-preferences";
import { validateChatStore } from "@/lib/document-chat";
import { readChatState, writeChatState } from "@/lib/storage/document-chat";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const [history, panel, fontSize] = await Promise.all([readChatState("history"), readChatState("panel"), readChatState("font-size")]);
    return NextResponse.json({ history, panel, fontSize, defaultReasoningEffort: getAiFunctionOptions("chat").reasoning.effort });
  } catch { return jsonError("Could not read saved document chats.", 500); }
}
export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const body = await request.json();
    if (body?.kind === "history") {
      if (!validateChatStore(body.value)) return jsonError("Invalid chat history.");
    } else if (body?.kind === "font-size") {
      if (!isChatFontSize(body.value)) return jsonError("Invalid chat font size.");
    } else if (body?.kind === "panel") {
      if (!body.value || !Number.isFinite(body.value.width) || body.value.width < 280 || body.value.width > 560 || typeof body.value.collapsed !== "boolean") return jsonError("Invalid panel preferences.");
    } else return jsonError("Invalid chat state.");
    await writeChatState(body.kind, body.value);
    return NextResponse.json({ saved: true });
  } catch { return jsonError("Could not save document chats.", 500); }
}
