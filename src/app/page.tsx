import { cookies } from "next/headers";
import { LiberaApp } from "@/components/libera-app";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const cookieStore = await cookies();
  const initialAuthenticated = verifySessionToken(
    cookieStore.get(SESSION_COOKIE_NAME)?.value,
  );

  return <LiberaApp initialAuthenticated={initialAuthenticated} />;
}
