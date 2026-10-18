import { randomUUID } from "node:crypto";
import type { TokenUsage } from "@/lib/chat-token-usage";
import { runAgent, type RunLimits } from "./runner";
import { RunSnapshots } from "./snapshots";
import { addUsage, budgetExhausted, ToolError, type AgentRunConfig, type AgentTool, type ToolContext, type ToolResult } from "./tools";
import type { AgentEvent, SubagentOutcome } from "./types";

// Child runs: the agent hands self-contained jobs (checking one batch of
// sources, say) to separate runs of the same loop, a few at a time. A child
// starts from a fresh context: it sees the library and the user's drafts, but
// none of the parent's reads, tasks or skills, and it cannot change anything.
// Only its tool steps and token usage reach the parent's stream. With a
// submit tool, its result is that tool's validated arguments, never free text.

export type SubagentTask = {
  /** Shown in the activity, e.g. "Checking smith2020, lee2021". */
  label: string;
  system: string;
  /** The child's only user message. */
  prompt: string;
  /** Its tools; read-only use only (the child runs in Read Only). WebSearch is added when the run allows it. */
  tools: AgentTool[];
  /** Defaults to DEFAULT_SUBAGENT_LIMITS. */
  limits?: Partial<RunLimits>;
  /**
   * The tool the child must finish by calling. Its arguments are validated
   * against its JSON schema (`parameters`), then its own `run` may refuse
   * them with an error; either sends them back for one repair round. The
   * accepted arguments are the child's result.
   */
  submitTool?: AgentTool;
};

export type SubagentResult = {
  id: string;
  label: string;
  outcome: SubagentOutcome;
  usage: TokenUsage;
  /** The child's last text, if it wrote any. */
  finalText: string;
  /** Tool calls the child made. */
  steps: number;
} & (
  /** `value`: the submit tool's arguments, or the final text when the task has no submit tool. */
  | { ok: true; value: unknown }
  | { ok: false; reason: string }
);

export type RunSubagentsOptions = {
  /** Children running at once; default 4. */
  concurrency?: number;
  /** Model settings; default the parent's `runConfig`. */
  config?: AgentRunConfig;
};

export const DEFAULT_SUBAGENT_CONCURRENCY = 4;
export const DEFAULT_SUBAGENT_LIMITS: RunLimits = { maxIterations: 15, maxMillis: 5 * 60_000, maxInputTokens: 1_000_000 };
/** Invalid submissions sent back for repair before the child's result counts as failed. */
const SUBMIT_REPAIR_ROUNDS = 1;

/** A child never writes, so it never records undo snapshots. */
class NoSnapshots extends RunSnapshots {
  override async recordOriginal(): Promise<void> { throw new ToolError("Child runs cannot change files."); }
  override async recordWritten(): Promise<void> { throw new ToolError("Child runs cannot change files."); }
}

type Schema = Record<string, unknown>;

function typeOf(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/**
 * Checks a value against the JSON Schema subset tool parameters use: type,
 * enum, const, properties, required, additionalProperties, items, anyOf,
 * oneOf, string and array lengths, numeric bounds and patterns. Returns one
 * message per problem, at most 20.
 */
export function validateJsonSchema(schema: Schema, value: unknown, at = "arguments", errors: string[] = []): string[] {
  if (errors.length >= 20 || !schema || typeof schema !== "object") return errors;
  const fail = (message: string) => { if (errors.length < 20) errors.push(`${at} ${message}`); };
  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
    const matches = types.some((type) => type === actual || (type === "number" && actual === "integer"));
    if (!matches) { fail(`must be ${types.join(" or ")}, not ${actual}.`); return errors; }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    fail(`must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}.`);
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) fail(`must be ${JSON.stringify(schema.const)}.`);
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = schema[key];
    if (!Array.isArray(options)) continue;
    const passing = options.filter((option) => !validateJsonSchema(option as Schema, value, at).length).length;
    if (key === "anyOf" ? !passing : passing !== 1) fail(`does not match ${key === "anyOf" ? "any" : "exactly one"} of the allowed shapes.`);
  }
  if (actual === "string") {
    const text = value as string;
    if (typeof schema.minLength === "number" && text.length < schema.minLength) fail(`must be at least ${schema.minLength} characters long.`);
    if (typeof schema.maxLength === "number" && text.length > schema.maxLength) fail(`must be at most ${schema.maxLength} characters long.`);
    if (typeof schema.pattern === "string") {
      try { if (!new RegExp(schema.pattern, "u").test(text)) fail(`must match ${schema.pattern}.`); } catch { /* An invalid pattern is the schema's fault, not the model's. */ }
    }
  }
  if (actual === "number" || actual === "integer") {
    const number = value as number;
    if (typeof schema.minimum === "number" && number < schema.minimum) fail(`must be at least ${schema.minimum}.`);
    if (typeof schema.maximum === "number" && number > schema.maximum) fail(`must be at most ${schema.maximum}.`);
  }
  if (actual === "array") {
    const items = value as unknown[];
    if (typeof schema.minItems === "number" && items.length < schema.minItems) fail(`must have at least ${schema.minItems} items.`);
    if (typeof schema.maxItems === "number" && items.length > schema.maxItems) fail(`must have at most ${schema.maxItems} items.`);
    if (schema.items && typeof schema.items === "object") items.forEach((item, index) => validateJsonSchema(schema.items as Schema, item, `${at}[${index}]`, errors));
  }
  if (actual === "object") {
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const name of Array.isArray(schema.required) ? schema.required as string[] : []) {
      if (object[name] === undefined) fail(`is missing the required property "${name}".`);
    }
    for (const [name, child] of Object.entries(object)) {
      if (properties[name]) validateJsonSchema(properties[name], child, `${at}.${name}`, errors);
      else if (schema.additionalProperties === false) fail(`has an unknown property "${name}".`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") validateJsonSchema(schema.additionalProperties as Schema, child, `${at}.${name}`, errors);
    }
  }
  return errors;
}

function childContext(parent: ToolContext, emit: (event: AgentEvent) => void, runId: string): ToolContext {
  return {
    permission: "read-only",
    skills: [],
    loadedSkills: new Set(),
    skillState: new Map(),
    notebook: parent.notebook,
    notebooks: parent.notebooks,
    openFiles: parent.openFiles,
    drafts: parent.drafts,
    fileState: new Map(),
    tasks: [],
    snapshots: new NoSnapshots(runId),
    changed: new Map(),
    maxResultChars: parent.maxResultChars,
    signal: parent.signal,
    emit,
    ...(parent.model ? { model: parent.model } : {}),
    ...(parent.allowWebSearch ? { allowWebSearch: true } : {}),
    ...(parent.runConfig ? { runConfig: parent.runConfig } : {}),
    ...(parent.budget ? { budget: parent.budget } : {}),
  };
}

const zeroUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0 });

/**
 * Runs `tasks` as child agent runs, at most `concurrency` at once, and
 * returns one result per task, in order. Children share the parent's stop
 * signal and token budget; once the budget is used up, children not yet
 * started end with outcome "budget". Their usage is added to the parent's.
 */
export async function runSubagents(parent: ToolContext, tasks: SubagentTask[], options: RunSubagentsOptions = {}): Promise<SubagentResult[]> {
  const configured = options.config ?? parent.runConfig;
  if (!configured) throw new Error("Child runs need the run's model settings (ToolContext.runConfig).");
  const config: AgentRunConfig = configured;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_SUBAGENT_CONCURRENCY));
  const results: SubagentResult[] = new Array(tasks.length);

  async function runOne(task: SubagentTask): Promise<SubagentResult> {
    const id = `sub-${randomUUID()}`;
    const label = task.label.slice(0, 500);
    parent.emit({ type: "subagent_started", id, label });
    const notStarted = (outcome: SubagentOutcome, reason: string): SubagentResult => {
      parent.emit({ type: "subagent_finished", id, label, outcome, usage: zeroUsage() });
      return { id, label, outcome, usage: zeroUsage(), finalText: "", steps: 0, ok: false, reason };
    };
    if (parent.signal.aborted) return notStarted("stopped", "The run was stopped before this check started.");
    if (budgetExhausted(parent)) return notStarted("budget", "Not started: the run's token budget was used up.");

    // Forward tool steps and usage; the child's text stays its own.
    let steps = 0;
    const started = new Map<string, { name: string; summary: string }>();
    const emit = (event: AgentEvent) => {
      if (event.type === "tool_started") {
        steps++;
        started.set(event.id, { name: event.name, summary: event.summary });
        parent.emit({ type: "subagent_step", id, step: { id: event.id, name: event.name, summary: event.summary, status: "running" } });
      } else if (event.type === "tool_finished") {
        const step = started.get(event.id) ?? { name: "Tool", summary: "Step" };
        parent.emit({ type: "subagent_step", id, step: { id: event.id, ...step, status: event.status, result: event.result } });
      } else if (event.type === "usage") parent.emit(event);
    };
    const context = childContext(parent, emit, id.slice(0, 64));

    let submission: { ok: true; value: unknown } | { ok: false; reason: string } | undefined;
    let rejected = 0;
    const submitTool = task.submitTool;
    const submit: AgentTool | undefined = submitTool && {
      ...submitTool,
      async run(args, child): Promise<ToolResult> {
        const problems = validateJsonSchema(submitTool.parameters, args);
        let accepted: ToolResult | undefined;
        if (!problems.length) {
          try {
            accepted = await submitTool.run(args, child);
            if (accepted.isError) problems.push(accepted.text);
          } catch (error) {
            if (child.signal.aborted) throw error;
            problems.push(error instanceof Error ? error.message : "The result was refused.");
          }
        }
        if (!problems.length && accepted) {
          submission = { ok: true, value: args };
          child.finishRequested = true;
          return accepted;
        }
        rejected++;
        if (rejected > SUBMIT_REPAIR_ROUNDS) {
          submission = { ok: false, reason: `${submitTool.name} was still invalid after a repair round: ${problems.join(" ")}` };
          child.finishRequested = true;
          return { text: `${submitTool.name} was not accepted, and this run is over.`, isError: true, result: "Invalid result" };
        }
        return {
          text: `${submitTool.name} was not accepted:\n${problems.map((problem) => `- ${problem}`).join("\n")}\nFix these and call ${submitTool.name} again with the complete result.`,
          isError: true, result: "Invalid result; asked to fix it",
        };
      },
    };
    const tools = submit ? [...task.tools.filter((tool) => tool.name !== submit.name), submit] : task.tools;

    try {
      const result = await runAgent({
        model: config.model, profile: config.profile, reasoningEffort: config.reasoningEffort, promptCaching: config.promptCaching,
        system: task.system, messages: [{ role: "user", content: task.prompt }], tools, context,
        limits: { ...DEFAULT_SUBAGENT_LIMITS, ...task.limits }, emit, signal: parent.signal,
        ...(submit ? { finishTool: submit.name } : {}),
      });
      if (parent.usage) addUsage(parent.usage, result.usage);
      const outcome: SubagentOutcome = parent.signal.aborted ? "stopped" : result.outcome;
      parent.emit({ type: "subagent_finished", id, label, outcome, usage: result.usage });
      const base = { id, label, outcome, usage: result.usage, finalText: result.finalText, steps };
      if (submit) {
        if (submission) return { ...base, ...submission };
        return { ...base, ok: false, reason: outcome === "completed" ? `The check finished without calling ${submit.name}.` : `The check ended early (${outcome})${result.message ? `: ${result.message}` : "."}` };
      }
      return outcome === "completed" ? { ...base, ok: true, value: result.finalText } : { ...base, ok: false, reason: result.message ?? `The check ended early (${outcome}).` };
    } catch (error) {
      const outcome: SubagentOutcome = parent.signal.aborted ? "stopped" : "error";
      const usage = context.usage ?? zeroUsage();
      if (parent.usage) addUsage(parent.usage, usage);
      parent.emit({ type: "subagent_finished", id, label, outcome, usage });
      return { id, label, outcome, usage, finalText: "", steps, ok: false, reason: error instanceof Error ? error.message : "The check failed." };
    }
  }

  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await runOne(tasks[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}
