// Libera collab admin recovery CLI (implementation plan §7, SETUP.md §9).
//
//   npm run admin -- <command> [options]                     (development)
//   docker compose exec collab node dist/admin/cli.js <command> [options]
//
// It opens DATABASE_URL directly (Postgres or PGlite; a PGlite directory can
// only be open in one process, so stop `npm run dev` first) and applies
// pending migrations. Commands that rewrite a document's storage ask the
// running server, over loopback, whether the document is loaded.
//
// Output is human-readable; --json prints one JSON document per result for
// scripts. Exit codes: 0 success, 1 failure (including verify problems),
// 2 usage errors.

import { pathToFileURL } from "node:url";

import { loadConfig, type Config } from "../config.js";
import { openDatabase, type Database } from "../db/database.js";
import { migrate } from "../db/migrate.js";
import { accountCreate, accountDisable, accountEnable, accountResetPassword, accountsList, auditTail } from "./accounts.js";
import { Args, parseArgs } from "./args.js";
import type { AdminContext, CommandResult } from "./context.js";
import { docExport, docInspect, docSnapshot, docsList, docText, projectExport } from "./documents.js";
import { CliError } from "./history.js";
import { docQuarantine } from "./quarantine.js";
import { signupCodeCreate, signupCodeList, signupCodeRevoke } from "./signup-codes.js";
import { docRebuild } from "./rebuild.js";
import { verifyCommand } from "./verify.js";

export const USAGE = `Libera collab admin CLI

Usage: npm run admin -- <command> [options]
       docker compose exec collab node dist/admin/cli.js <command> [options]

Documents
  docs list --project <projectId> [--include-deleted]
  doc inspect <docId> [--updates <from>..<to>] [--limit n]
  doc text <docId> [--at <serverSeq>]
  doc export <docId> --out <file> [--at <serverSeq>]
  doc snapshot <docId>
  doc rebuild <docId> --to <serverSeq> [--subdoc <name>] [--dry-run]
  doc quarantine <docId> --range <from>..<to> (--dry-run | --yes)    DANGER, see SETUP.md §9
  project export <projectId> --out <dir>

Accounts and audit
  accounts list
  account create <email> [--name <display name>]   prints a one-time password
  account disable <email>
  account enable <email>
  account reset-password <email>
  signup-code create [--note text] [--uses n] [--expires-days n]   prints a one-time registration code
  signup-code list
  signup-code revoke <codeId>
  audit tail [--project <projectId>] [--limit n] [--follow]

Checks
  verify [--doc <docId>] [--project <projectId>] [--include-deleted] [--expect <counts.json>] [--blobs]

Options
  --json                 Machine-readable output
  --database-url <url>   Instead of DATABASE_URL
  --server <url>         The running server for room checks (default http://127.0.0.1:$PORT)
  --server-stopped       Proceed when no server answers (only when it is really stopped)
`;

type Handler = (ctx: AdminContext, print: (result: CommandResult) => void) => Promise<CommandResult>;

const COMMANDS: Record<string, Handler> = {
  "docs list": docsList,
  "doc inspect": docInspect,
  "doc text": docText,
  "doc export": docExport,
  "doc snapshot": docSnapshot,
  "doc rebuild": docRebuild,
  "doc quarantine": docQuarantine,
  "project export": projectExport,
  "accounts list": accountsList,
  "account create": accountCreate,
  "account disable": accountDisable,
  "account enable": accountEnable,
  "account reset-password": accountResetPassword,
  "signup-code create": signupCodeCreate,
  "signup-code list": signupCodeList,
  "signup-code revoke": signupCodeRevoke,
  "audit tail": auditTail,
  verify: verifyCommand,
};

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CliOptions {
  env?: NodeJS.ProcessEnv;
  /** Use an open database instead of DATABASE_URL (tests). */
  database?: Database;
  /** Overrides on top of the environment (tests). */
  config?: Partial<Config>;
}

function findCommand(positionals: string[]): { name: string; handler: Handler } | null {
  const two = positionals.slice(0, 2).join(" ");
  if (COMMANDS[two]) return { name: two, handler: COMMANDS[two] };
  const one = positionals[0];
  if (one && COMMANDS[one]) return { name: one, handler: COMMANDS[one] };
  return null;
}

/** Runs one CLI invocation. Returns the exit code; never calls process.exit. */
export async function runCli(argv: readonly string[], io: CliIo, options: CliOptions = {}): Promise<number> {
  let args: Args;
  try {
    args = new Args(parseArgs(argv));
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return 2;
  }
  const json = args.has("json");
  const command = findCommand(args.parsed.positionals);
  if (args.has("help") || args.parsed.positionals.length === 0) {
    io.stdout(USAGE);
    return args.parsed.positionals.length === 0 && !args.has("help") ? 2 : 0;
  }
  if (!command) {
    io.stderr(`Unknown command: ${args.parsed.positionals.join(" ")}\n\n${USAGE}`);
    return 2;
  }
  // `verify` takes no sub-command, so its positionals start one earlier;
  // shift so handlers can always read their first argument at index 2.
  if (command.name === "verify") args.parsed.positionals.unshift("");

  const print = (result: CommandResult) => {
    if (json) io.stdout(`${JSON.stringify(result.data, null, 2)}\n`);
    else if (result.text.length > 0) io.stdout(`${result.text.join("\n")}\n`);
  };

  let database: Database | undefined;
  try {
    const env = options.env ?? process.env;
    const url = args.string("database-url");
    const config = loadConfig(url ? { ...env, DATABASE_URL: url } : env, options.config ?? {});
    database = options.database ?? (await openDatabase(config.DATABASE_URL));
    await migrate(database);
    const ctx: AdminContext = {
      config,
      database,
      db: database.db,
      args,
      note: (line) => io.stderr(`${line}\n`),
    };
    const result = await command.handler(ctx, print);
    print(result);
    return result.exitCode ?? 0;
  } catch (error) {
    if (error instanceof CliError) {
      if (json) io.stdout(`${JSON.stringify({ error: error.message }, null, 2)}\n`);
      io.stderr(`${error.message}\n`);
      return error.exitCode;
    }
    io.stderr(`Error: ${(error as Error).stack ?? String(error)}\n`);
    return 1;
  } finally {
    if (database && !options.database) await database.close();
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const code = await runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
  process.exitCode = code;
}
