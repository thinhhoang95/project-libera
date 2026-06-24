import type { FormEvent } from "react";
import { WindowControls } from "@/components/libera/window-controls";

type LoginScreenProps = {
  authError: string;
  busy: boolean;
  password: string;
  onLogin: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onPasswordChange: (password: string) => void;
};

export function LoginScreen({
  authError,
  busy,
  password,
  onLogin,
  onPasswordChange,
}: LoginScreenProps) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10 text-foreground">
      <div className="fixed right-3 top-3 z-50">
        <WindowControls />
      </div>
      <section className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-sm">
        <p className="text-sm font-medium text-muted-foreground">Libera</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Sign in</h1>
        <form className="mt-6 space-y-4" onSubmit={onLogin}>
          <label className="block text-sm font-medium text-foreground" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="h-11 w-full rounded-xl border border-input px-3 text-sm outline-none transition focus:border-ring"
            type="password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            autoFocus
          />
          {authError ? <p className="text-sm text-destructive">{authError}</p> : null}
          <button
            className="h-11 w-full rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            type="submit"
            disabled={busy}
          >
            {busy ? "Signing in" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
