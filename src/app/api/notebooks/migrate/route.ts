import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { toStorageError } from "@/lib/storage";
import { StorageError } from "@/lib/storage/errors";
import {
  acknowledgeMigration,
  listInterruptedMigrations,
  listUnacknowledgedMigrations,
  listUnreadableMigrations,
  planMigration,
  resumeMigration,
  runMigration,
  setAsideUnreadableMigration,
  type MigrationRequest,
} from "@/lib/storage/migration";

export const runtime = "nodejs";

function handleError(error: unknown) {
  const storageError = toStorageError(error);
  return NextResponse.json({ error: storageError.message }, { status: storageError.status });
}

/** Migrations that stopped before finishing, and finished ones whose result the app has not applied. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    return NextResponse.json({
      interrupted: await listInterruptedMigrations(),
      unacknowledged: await listUnacknowledgedMigrations(),
      unreadable: await listUnreadableMigrations(),
    });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * `plan`: what a migration would do (reads only). `run`: carry it out, given
 * the token of the plan the user reviewed. `resume`: continue or stop an
 * interrupted migration. `acknowledge`: the app applied a finished result.
 * `set-aside`: rename an unreadable journal so it no longer blocks migrations.
 * Field types are checked by the engine (storage/migration.ts).
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = (await request.json()) as {
      action?: "plan" | "run" | "resume" | "acknowledge" | "set-aside";
      name?: string;
      request?: MigrationRequest;
      token?: string;
      id?: string;
      mode?: "continue" | "stop";
    };

    if (body.action === "plan" && body.request) return NextResponse.json(await planMigration(body.request));
    if (body.action === "run" && body.request && typeof body.token === "string") return NextResponse.json(await runMigration(body.request, body.token));
    if (body.action === "set-aside" && typeof body.name === "string") {
      await setAsideUnreadableMigration(body.name);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "acknowledge" && typeof body.id === "string") {
      await acknowledgeMigration(body.id);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "resume" && typeof body.id === "string" && (body.mode === "continue" || body.mode === "stop")) {
      return NextResponse.json(await resumeMigration(body.id, body.mode));
    }
    throw new StorageError("Invalid migration request.", 400);
  } catch (error) {
    return handleError(error);
  }
}
