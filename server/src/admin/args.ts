// Command-line parsing for the admin CLI: positionals plus --flag value,
// --flag=value and boolean switches.

import { CliError } from "./history.js";

/** Switches that take no value. */
const BOOLEAN_FLAGS = new Set(["json", "dry-run", "yes", "follow", "include-deleted", "server-stopped", "help", "blobs"]);

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
    } else if (BOOLEAN_FLAGS.has(body)) {
      flags.set(body, true);
    } else {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new CliError(`--${body} needs a value.`);
      flags.set(body, value);
      index += 1;
    }
  }
  return { positionals, flags };
}

export class Args {
  constructor(readonly parsed: ParsedArgs) {}

  has(name: string): boolean {
    return this.parsed.flags.get(name) === true || typeof this.parsed.flags.get(name) === "string";
  }

  string(name: string): string | undefined {
    const value = this.parsed.flags.get(name);
    if (value === true) throw new CliError(`--${name} needs a value.`);
    return value;
  }

  required(name: string): string {
    const value = this.string(name);
    if (value === undefined || value === "") throw new CliError(`--${name} is required.`);
    return value;
  }

  int(name: string, fallback: number): number {
    const value = this.string(name);
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) throw new CliError(`--${name} must be a whole number.`);
    return Number(value);
  }

  positional(index: number, name: string): string {
    const value = this.parsed.positionals[index];
    if (value === undefined) throw new CliError(`Missing ${name}.`);
    return value;
  }
}
