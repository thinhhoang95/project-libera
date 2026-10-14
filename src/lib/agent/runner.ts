import { StorageError } from "@/lib/storage/errors";
import { callModel, type AgentMessage, type ModelProfile, type ToolCall } from "./model";
import { activeTools, hasOpenTasks, toolSchemas, ToolError, type AgentTool, type ToolContext } from "./tools";
import type { AgentEvent, AgentOutcome } from "./types";

// The agent loop: ask the model, run every tool it calls, append the results,
// and repeat until it answers without calling tools. Tools never throw into
// the loop; every call gets exactly one result, in order.

export type RunLimits = { maxIterations: number; maxMillis: number; maxInputTokens: number };

export const DEFAULT_RUN_LIMITS: RunLimits = { maxIterations: 50, maxMillis: 20 * 60_000, maxInputTokens: 5_000_000 };

const MAX_CALLS_PER_REPLY = 40;
const RECENT_TOOL_RESULTS_KEPT = 8;
const SOFT_REPEAT_LIMIT = 3;
const HARD_REPEAT_LIMIT = 5;
/** Times a skill may send its pass back for fixes before it settles with what it has. */
const SKILL_FEEDBACK_ROUNDS = 3;

export type RunAgentOptions = {
  model: string;
  profile: ModelProfile;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  promptCaching?: boolean;
  sessionId?: string;
  system: string;
  /** Earlier turns and the new request; the system prompt is added here. */
  messages: AgentMessage[];
  tools: AgentTool[];
  context: ToolContext;
  limits?: Partial<RunLimits>;
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
};

export type RunResult = { outcome: AgentOutcome; message?: string };

type PreparedCall = { call: ToolCall; tool?: AgentTool; args: Record<string, unknown>; error?: string };

function nudge(text: string): AgentMessage {
  return { role: "user", content: `[Libera] ${text}` };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function prepare(call: ToolCall, tools: AgentTool[], context: ToolContext): PreparedCall {
  const name = call.function.name.trim();
  const tool = tools.find((candidate) => candidate.name === name) ?? tools.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (!tool) {
    const skill = context.skills.find((candidate) => candidate.tools?.some((skillTool) => skillTool.name.toLowerCase() === name.toLowerCase()));
    if (skill) return { call, args: {}, error: `${name} belongs to the ${skill.name} skill. ${context.loadedSkills.has(skill.name) ? "It is loaded now; call" : `Load it with Skill first, then call`} ${name} in your next reply.` };
    return { call, args: {}, error: `There is no tool named "${name}". Available tools: ${tools.map((candidate) => candidate.name).join(", ")}.` };
  }
  const raw = call.function.arguments.trim();
  let args: unknown = {};
  if (raw) {
    try { args = JSON.parse(raw); }
    catch (error) {
      return { call, tool, args: {}, error: `Could not parse the ${tool.name} arguments as JSON (${error instanceof Error ? error.message : "invalid JSON"}). Send a single JSON object with the parameters: ${Object.keys((tool.parameters.properties ?? {}) as object).join(", ")}.` };
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return { call, tool, args: {}, error: `${tool.name} arguments must be a JSON object.` };
  return { call, tool, args: args as Record<string, unknown> };
}

function shorten(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
}

async function runPrepared(prepared: PreparedCall, context: ToolContext, emit: (event: AgentEvent) => void): Promise<string> {
  const { call, tool } = prepared;
  const name = tool?.name ?? call.function.name;
  const summary = tool && !prepared.error ? tool.describe(prepared.args) : `Calling ${name}`;
  const diff = tool?.name === "Edit" && typeof prepared.args.old_string === "string" && typeof prepared.args.new_string === "string"
    ? { removed: shorten(prepared.args.old_string, 4_000), added: shorten(prepared.args.new_string, 4_000) }
    : undefined;
  emit({ type: "tool_started", id: call.id, name, summary, ...(diff ? { diff } : {}) });
  if (prepared.error || !tool) {
    const message = prepared.error ?? "Unknown tool.";
    emit({ type: "tool_finished", id: call.id, status: "error", result: message.split("\n")[0].slice(0, 300), detail: message });
    return `Error: ${message}`;
  }
  try {
    const result = await tool.run(prepared.args, context);
    const text = result.text.length > context.maxResultChars + 2_000
      ? `${result.text.slice(0, context.maxResultChars)}\n\n[Output truncated; narrow the request.]`
      : result.text;
    emit({ type: "tool_finished", id: call.id, status: result.isError ? "error" : "ok", result: result.result, ...(result.detail ? { detail: shorten(result.detail, 4_000) } : {}) });
    return result.isError ? `Error: ${text}` : text;
  } catch (error) {
    if (context.signal.aborted) throw error;
    const message = error instanceof ToolError || error instanceof StorageError ? error.message
      : `${tool.name} failed: ${error instanceof Error ? error.message : "unknown error"}`;
    emit({ type: "tool_finished", id: call.id, status: "error", result: message.split("\n")[0].slice(0, 300), detail: shorten(message, 4_000) });
    return `Error: ${message}`;
  }
}

/** Run calls in the order given: consecutive reads together, each write alone. */
async function executeToolCalls(calls: ToolCall[], tools: AgentTool[], context: ToolContext, emit: (event: AgentEvent) => void) {
  const prepared = calls.map((call, index) => index < MAX_CALLS_PER_REPLY ? prepare(call, tools, context)
    : { call, args: {}, error: `Too many tool calls in one reply; make at most ${MAX_CALLS_PER_REPLY}.` });
  const results: string[] = [];
  let index = 0;
  while (index < prepared.length) {
    // Changes run alone, in order; consecutive reads run together.
    if (prepared[index].tool && prepared[index].tool!.kind !== "read" && !prepared[index].error) {
      results.push(await runPrepared(prepared[index], context, emit));
      index++;
      continue;
    }
    const group: PreparedCall[] = [];
    while (index < prepared.length && !(prepared[index].tool && prepared[index].tool!.kind !== "read" && !prepared[index].error)) group.push(prepared[index++]);
    results.push(...await Promise.all(group.map((item) => runPrepared(item, context, emit))));
  }
  return results;
}

/** Replace older tool outputs with short stubs; the newest results stay intact. */
function compactToolResults(messages: AgentMessage[], toolNames: Map<string, string>) {
  const toolIndices = messages.flatMap((message, index) => message.role === "tool" ? [index] : []);
  let removed = 0;
  for (const index of toolIndices.slice(0, -RECENT_TOOL_RESULTS_KEPT)) {
    const message = messages[index] as Extract<AgentMessage, { role: "tool" }>;
    if (typeof message.content !== "string" || message.content.length < 400) continue;
    removed += message.content.length;
    const name = toolNames.get(message.tool_call_id) ?? "tool";
    messages[index] = { ...message, content: `[Earlier ${name} output removed to save space. Run the tool again if you need it.]` };
  }
  return removed;
}

/** Let loaded skills check the work of this pass; returns their feedback for the model, if any. */
async function finishSkillPass(context: ToolContext, final: boolean) {
  const feedback: string[] = [];
  for (const skill of context.skills) {
    if (!context.loadedSkills.has(skill.name) || !skill.finishPass) continue;
    const text = await skill.finishPass(context, { final });
    if (text && !final) feedback.push(text);
  }
  return feedback.join("\n\n");
}

export async function runAgent(options: RunAgentOptions): Promise<RunResult> {
  try {
    return await runLoop(options);
  } finally {
    // Whatever ended the run, skills keep the work that is ready, as edits are kept.
    try { await finishSkillPass(options.context, true); }
    catch (error) {
      // Report as a step: an "error" event would end the client's stream before "done".
      const id = `skills-${Date.now()}`;
      options.emit({ type: "tool_started", id, name: "Skill", summary: "Finishing skills" });
      options.emit({ type: "tool_finished", id, status: "error", result: error instanceof Error ? error.message.slice(0, 300) : "A skill could not finish." });
    }
  }
}

async function runLoop(options: RunAgentOptions): Promise<RunResult> {
  const limits = { ...DEFAULT_RUN_LIMITS, ...options.limits };
  const { context, emit, signal } = options;
  const messages: AgentMessage[] = [{ role: "system", content: options.system }, ...options.messages];
  const toolNames = new Map<string, string>();
  const started = Date.now();
  let inputTokens = 0;
  let lastPromptTokens = 0;
  let nudgedAboutTasks = false;
  let skillFeedbackRounds = 0;
  let repeat = { signature: "", count: 0, nudged: false };
  let textOpen = false;

  try {
    for (let iteration = 0; iteration < limits.maxIterations; iteration++) {
      if (signal.aborted) return { outcome: "stopped" };
      if (Date.now() - started > limits.maxMillis) return { outcome: "limit", message: `Stopped after ${Math.round(limits.maxMillis / 60_000)} minutes, the time limit for one run.` };
      if (inputTokens > limits.maxInputTokens) return { outcome: "limit", message: `Stopped after using ${inputTokens.toLocaleString("en")} input tokens, the limit for one run.` };
      if (lastPromptTokens > options.profile.contextLength * 0.7) {
        const removed = compactToolResults(messages, toolNames);
        if (!removed && lastPromptTokens > options.profile.contextLength * 0.92) {
          return { outcome: "limit", message: "Stopped because the conversation no longer fits in the model's context window. Start a new chat to continue." };
        }
      }

      // Loading a skill adds its tools from the next reply on.
      const tools = activeTools(options.tools, context);
      let firstDelta = true;
      const reply = await callModel({
        model: options.model,
        messages,
        tools: toolSchemas(tools),
        profile: options.profile,
        reasoningEffort: options.reasoningEffort,
        promptCaching: options.promptCaching,
        sessionId: options.sessionId,
        signal,
        onTextDelta: (text) => {
          // Separate this turn's text from text shown before a nudge.
          if (firstDelta && textOpen) emit({ type: "text_delta", text: "\n\n" });
          firstDelta = false;
          textOpen = true;
          emit({ type: "text_delta", text });
        },
      });
      messages.push(reply.message);
      if (reply.usage) {
        inputTokens += reply.usage.inputTokens;
        lastPromptTokens = reply.usage.inputTokens;
        emit({ type: "usage", usage: reply.usage });
      }
      for (const call of reply.toolCalls) toolNames.set(call.id, call.function.name);

      if (reply.finishReason === "length") {
        // Never run calls whose arguments may have been cut off.
        if (reply.toolCalls.length) {
          for (const call of reply.toolCalls) {
            messages.push({ role: "tool", tool_call_id: call.id, content: "Error: Your reply was cut off before this call was complete, so it was not run. Retry in smaller steps; for a long file, Write a shorter first version and extend it with Edit." });
          }
        } else messages.push(nudge("Your reply was cut off by the output limit. Continue from where you stopped, in smaller steps."));
        continue;
      }

      if (!reply.toolCalls.length) {
        if (hasOpenTasks(context) && !nudgedAboutTasks) {
          nudgedAboutTasks = true;
          const open = context.tasks.filter((task) => task.status !== "completed").map((task) => `#${task.id} ${task.subject}`).join("; ");
          messages.push(nudge(`You still have open tasks (${open}). Continue with them, or mark them completed or deleted with TaskUpdate if they are done or no longer needed.`));
          continue;
        }
        const feedback = await finishSkillPass(context, skillFeedbackRounds >= SKILL_FEEDBACK_ROUNDS);
        if (feedback) {
          skillFeedbackRounds++;
          messages.push(nudge(feedback));
          continue;
        }
        return { outcome: "completed" };
      }

      textOpen = false;
      const results = await executeToolCalls(reply.toolCalls, tools, context, emit);
      reply.toolCalls.forEach((call, index) => messages.push({ role: "tool", tool_call_id: call.id, content: results[index] }));

      for (const call of reply.toolCalls) {
        const signature = `${call.function.name}:${(() => { try { return canonical(JSON.parse(call.function.arguments || "{}")); } catch { return call.function.arguments; } })()}`;
        repeat = signature === repeat.signature ? { ...repeat, count: repeat.count + 1 } : { signature, count: 1, nudged: false };
      }
      if (repeat.count >= HARD_REPEAT_LIMIT) return { outcome: "stuck", message: "Stopped because the agent kept repeating the same step." };
      if (repeat.count >= SOFT_REPEAT_LIMIT && !repeat.nudged) {
        repeat.nudged = true;
        messages.push(nudge("You are repeating the same tool call with the same arguments. It will not give a different result; try a different approach, or answer with what you have."));
      }
    }
    return { outcome: "limit", message: `Stopped after ${limits.maxIterations} steps, the limit for one run. Ask the agent to continue if there is more to do.` };
  } catch (error) {
    if (signal.aborted) return { outcome: "stopped" };
    return { outcome: "error", message: error instanceof Error ? error.message : "The agent run failed." };
  }
}
