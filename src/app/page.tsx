import { cookies } from "next/headers";
import { LiberaApp } from "@/components/libera-app";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { getConfiguredMarkdownPreferences } from "@/lib/markdown-preferences-config";
import { getConfiguredQuickPrompts } from "@/lib/quick-prompts-config";

export const dynamic = "force-dynamic";

export default async function Home() {
  const cookieStore = await cookies();
  const initialAuthenticated = verifySessionToken(
    cookieStore.get(SESSION_COOKIE_NAME)?.value,
  );
  const markdownPreferences = getConfiguredMarkdownPreferences();

  return (
    <LiberaApp
      yourName={process.env.LIBERA_YOUR_NAME?.trim() ?? ""}
      initialAuthenticated={initialAuthenticated}
      markdownPreferences={markdownPreferences}
      quickPrompts={getConfiguredQuickPrompts()}
    />
  );
}
