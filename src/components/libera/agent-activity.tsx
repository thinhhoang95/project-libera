"use client";

import { memo, useMemo } from "react";
import { BookOpen, Bot, Check, ChevronRight, Circle, CircleDot, FilePenLine, FilePlus2, FileSearch, FileText, FolderSearch, Globe, ListChecks, LoaderCircle, MessageSquarePlus, MessagesSquare, Pencil, Search, TriangleAlert, Undo2, type LucideIcon } from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { normalizeChatResponseMarkdown } from "@/lib/document-chat";
import type { MathMarkerSettings } from "@/lib/math-markers";
import type { MarkdownMacroScope } from "@/lib/markdown-macros";
import type { AgentRunRecord, AgentStep, SubagentOutcome } from "@/lib/agent/types";

const TOOL_ICONS: Record<string, LucideIcon> = {
  Glob: FolderSearch, Grep: Search, Read: FileText, Edit: Pencil, Write: FilePlus2, TaskCreate: ListChecks, TaskUpdate: ListChecks,
  Skill: BookOpen, LeaveComment: MessageSquarePlus, ReviewComments: MessagesSquare, ReadComments: MessagesSquare, WebSearch: Globe, SuggestEdit: FilePenLine, SuggestedEdits: FilePenLine,
};

const SUBAGENT_OUTCOMES: Record<SubagentOutcome, string> = {
  completed: "done", stopped: "stopped", limit: "stopped at a limit", stuck: "stopped (repeating itself)", error: "failed", budget: "not started (token budget used up)",
};

const OUTCOME_NOTES: Record<string, string> = {
  stopped: "Stopped. Changes made so far are kept; you can undo them below.",
  limit: "The agent reached a limit for one run.",
  stuck: "The agent was repeating itself and was stopped.",
  error: "The run ended with an error.",
};

type ToolStep = Extract<AgentStep, { kind: "tool" }>;
type SubagentStep = Extract<AgentStep, { kind: "subagent" }>;

const AgentText = memo(function AgentText({ text, streaming, mathMarkers, macroScope, fontSize, onOpenFileLink }: { text: string; streaming: boolean; mathMarkers: MathMarkerSettings; macroScope?: MarkdownMacroScope; fontSize: number; onOpenFileLink: (href: string) => Promise<boolean> }) {
  const content = useMemo(() => normalizeChatResponseMarkdown(text, streaming, mathMarkers), [text, streaming, mathMarkers]);
  return <MarkdownRenderer copyAsMarkdown mathMarkers={mathMarkers} macroScope={macroScope} className="libera-chat-markdown min-w-0 break-normal"
    baseFontSize={fontSize} baseLineHeight={1.6} renderImages={false} content={content} onOpenFileLink={onOpenFileLink} />;
});

function DiffView({ diff }: { diff: { removed: string; added: string } }) {
  const lines = (text: string) => text ? text.split(/\r?\n/) : [];
  // The marks sit in a gutter so they never read as part of a Markdown list item.
  return <pre className="libera-agent-diff" aria-label="Edit">
    {lines(diff.removed).map((line, index) => <span key={`r${index}`} data-kind="removed"><span className="libera-agent-diff-mark" aria-hidden>−</span><span className="sr-only">Removed: </span>{`${line}\n`}</span>)}
    {lines(diff.added).map((line, index) => <span key={`a${index}`} data-kind="added"><span className="libera-agent-diff-mark" aria-hidden>+</span><span className="sr-only">Added: </span>{`${line}\n`}</span>)}
  </pre>;
}

function ToolLine({ step }: { step: ToolStep }) {
  const Icon = step.status === "running" ? LoaderCircle : step.status === "error" ? TriangleAlert : TOOL_ICONS[step.name] ?? FileSearch;
  const expandable = Boolean(step.detail || step.diff);
  const line = <>
    <Icon aria-hidden size={13} className="libera-agent-tool-icon" />
    <span className="libera-agent-tool-summary" title={step.summary}>{step.summary}</span>
    {step.result && <span className="libera-agent-tool-result" title={step.result}>{step.result}</span>}
    {expandable && <ChevronRight aria-hidden size={12} className="libera-agent-tool-chevron" />}
  </>;
  if (!expandable) return <li className="libera-agent-tool" data-status={step.status}><div className="libera-agent-tool-line">{line}</div></li>;
  return <li className="libera-agent-tool" data-status={step.status}>
    <details>
      <summary className="libera-agent-tool-line">{line}</summary>
      {step.diff && <DiffView diff={step.diff} />}
      {step.detail && <pre className="libera-agent-tool-detail">{step.detail}</pre>}
    </details>
  </li>;
}

/** A child run: one line with its progress, expanding to its own steps. */
function SubagentLine({ step }: { step: SubagentStep }) {
  const running = step.status === "running";
  const failed = !running && step.outcome !== "completed";
  const Icon = running ? LoaderCircle : failed ? TriangleAlert : Bot;
  const count = `${step.stepCount} ${step.stepCount === 1 ? "step" : "steps"}`;
  const latest = step.steps.at(-1);
  const progress = running ? `${count}${latest ? ` · ${latest.summary}` : " · starting"}` : `${count} · ${SUBAGENT_OUTCOMES[step.outcome ?? "completed"]}`;
  return <li className="libera-agent-tool libera-agent-subagent" data-status={running ? "running" : failed ? "error" : "ok"}>
    <details>
      <summary className="libera-agent-tool-line" aria-label={`${step.label}: ${progress}`}>
        <Icon aria-hidden size={13} className="libera-agent-tool-icon" />
        <span className="libera-agent-tool-summary" title={step.label}>{step.label}</span>
        <span className="libera-agent-tool-result" title={progress}>{progress}</span>
        <ChevronRight aria-hidden size={12} className="libera-agent-tool-chevron" />
      </summary>
      {step.steps.length ? <ol className="libera-agent-tools pl-4" aria-label={`Steps of ${step.label}`}>
        {step.stepCount > step.steps.length && <li className="text-xs text-muted-foreground">{step.stepCount - step.steps.length} earlier steps not shown</li>}
        {step.steps.map((child) => <ToolLine key={child.id} step={{ kind: "tool", ...child }} />)}
      </ol> : <p className="pl-4 text-xs text-muted-foreground">No steps yet.</p>}
    </details>
  </li>;
}

export function AgentRunView({ run, streaming, mathMarkers, macroScope, fontSize, undoing, onUndo, onOpenFile, onOpenFileLink }: {
  run: AgentRunRecord;
  streaming: boolean;
  mathMarkers: MathMarkerSettings;
  /** Macros of the documents in the conversation (markdown-macros.ts). */
  macroScope?: MarkdownMacroScope;
  fontSize: number;
  undoing: boolean;
  onUndo: (paths?: string[]) => void;
  onOpenFile: (path: string) => void;
  onOpenFileLink: (href: string) => Promise<boolean>;
}) {
  // Consecutive tool steps read as one block of activity between the agent's messages.
  const blocks = useMemo(() => {
    const result: ({ kind: "text"; text: string; index: number } | { kind: "tools"; steps: (ToolStep | SubagentStep)[]; index: number })[] = [];
    run.steps.forEach((step, index) => {
      const last = result.at(-1);
      if (step.kind === "text") result.push({ kind: "text", text: step.text, index });
      else if (last?.kind === "tools") last.steps.push(step);
      else result.push({ kind: "tools", steps: [step], index });
    });
    return result;
  }, [run.steps]);
  const lastTextIndex = blocks.findLastIndex((block) => block.kind === "text");
  const lastStep = run.steps.at(-1);
  // Between steps the model is thinking; running tools and streaming text show themselves.
  const working = streaming && (!lastStep || (lastStep.kind !== "text" && lastStep.status !== "running"));
  const done = run.tasks.filter((task) => task.status === "completed").length;
  const pendingChanges = run.changes.filter((change) => !change.reverted);

  return <div className="libera-agent-run space-y-3">
    {blocks.map((block, index) => block.kind === "text"
      ? <AgentText key={block.index} text={block.text} streaming={streaming && index === lastTextIndex} mathMarkers={mathMarkers} macroScope={macroScope} fontSize={fontSize} onOpenFileLink={onOpenFileLink} />
      : <ol key={block.index} className="libera-agent-tools" aria-label="Agent activity">{block.steps.map((step) => step.kind === "subagent" ? <SubagentLine key={step.id} step={step} /> : <ToolLine key={step.id} step={step} />)}</ol>)}
    {working && <p role="status" className="libera-chat-thinking w-fit text-sm text-muted-foreground">Working…</p>}
    {!!run.tasks.length && <section className="libera-agent-tasks" aria-label="Agent tasks">
      <h3><ListChecks aria-hidden size={13} />Tasks <span>{done}/{run.tasks.length}</span></h3>
      <ul>{run.tasks.map((task) => {
        const Icon = task.status === "completed" ? Check : task.status === "in_progress" ? CircleDot : Circle;
        return <li key={task.id} data-status={task.status}><Icon aria-hidden size={12} /><span>{task.subject}</span><span className="sr-only">{task.status.replace("_", " ")}</span></li>;
      })}</ul>
    </section>}
    {!!run.changes.length && <section className="libera-agent-changes" aria-label="Changed files">
      <h3>
        <Pencil aria-hidden size={13} />Changed files <span>{run.changes.length}</span>
        {pendingChanges.length > 1 && !streaming && <button type="button" className="libera-agent-undo" disabled={undoing} onClick={() => onUndo()}><Undo2 aria-hidden size={12} />Undo all</button>}
      </h3>
      <ul>{run.changes.map((change) => <li key={change.path} data-reverted={change.reverted || undefined}>
        <button type="button" className="libera-agent-file" title={`Open ${change.path}`} disabled={change.reverted && change.created} onClick={() => onOpenFile(change.path)}>{change.path}</button>
        {change.created && <span className="libera-agent-badge">new</span>}
        {change.suggested && <span className="libera-agent-badge" title="A shared file: the change is a suggestion collaborators review; the text changes when one is accepted">suggested</span>}
        {change.reverted ? <span className="libera-agent-badge">{change.suggested ? "withdrawn" : "undone"}</span>
          : !streaming && <button type="button" className="libera-agent-undo" disabled={undoing} aria-label={`Undo changes to ${change.path}`} title={change.suggested ? "Withdraw the agent's pending suggestions in this file" : change.created ? "Delete this new file" : "Restore this file as it was before the agent changed it"} onClick={() => onUndo([change.path])}><Undo2 aria-hidden size={12} />Undo</button>}
      </li>)}</ul>
    </section>}
    {!!run.comments?.some((entry) => entry.count) && <section className="libera-agent-changes" aria-label="Review comments">
      <h3><MessagesSquare aria-hidden size={13} />Review comments <span>{run.comments.reduce((sum, entry) => sum + entry.count, 0)}</span></h3>
      <ul>{run.comments.filter((entry) => entry.count).map((entry) => <li key={entry.path}>
        <button type="button" className="libera-agent-file" title={`Open ${entry.path} to see its comments`} onClick={() => onOpenFile(entry.path)}>{entry.path}</button>
        <span className="libera-agent-badge">{entry.count} {entry.count === 1 ? "comment" : "comments"}</span>
      </li>)}</ul>
    </section>}
    {!!run.suggestions?.some((entry) => entry.count) && <section className="libera-agent-changes" aria-label="Suggested edits">
      <h3><FilePenLine aria-hidden size={13} />Suggested edits <span>{run.suggestions.reduce((sum, entry) => sum + entry.count, 0)}</span></h3>
      <ul>{run.suggestions.filter((entry) => entry.count).map((entry) => <li key={entry.path}>
        <button type="button" className="libera-agent-file" title={`Open ${entry.path} to accept or reject the suggested edits`} onClick={() => onOpenFile(entry.path)}>{entry.path}</button>
        <span className="libera-agent-badge">{entry.count} {entry.count === 1 ? "suggestion" : "suggestions"}</span>
      </li>)}</ul>
    </section>}
    {run.outcome && OUTCOME_NOTES[run.outcome] && <p className="text-xs text-muted-foreground">{OUTCOME_NOTES[run.outcome]}</p>}
  </div>;
}
