import type { FormEvent } from "react";

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
    <main className="flex min-h-screen items-center justify-center bg-zinc-100 px-6 py-10 text-zinc-950">
      <section className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-zinc-500">Libera</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Sign in</h1>
        <form className="mt-6 space-y-4" onSubmit={onLogin}>
          <label className="block text-sm font-medium text-zinc-700" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="h-11 w-full rounded-md border border-zinc-300 px-3 text-sm outline-none transition focus:border-zinc-950"
            type="password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            autoFocus
          />
          {authError ? <p className="text-sm text-red-600">{authError}</p> : null}
          <button
            className="h-11 w-full rounded-md bg-zinc-950 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
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
