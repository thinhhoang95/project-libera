"use client";

import { memo, useMemo } from "react";
import { Check, ChevronRight, Circle, CircleDot, FilePlus2, FileSearch, FileText, FolderSearch, ListChecks, LoaderCircle, Pencil, Search, TriangleAlert, Undo2, type LucideIcon } from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { normalizeChatResponseMarkdown } from "@/lib/document-chat";
import type { MathMarkerSettings } from "@/lib/math-markers";
import type { AgentRunRecord, AgentStep } from "@/lib/agent/types";

const TOOL_ICONS: Record<string, LucideIcon> = {
  Glob: FolderSearch, Grep: Search, Read: FileText, Edit: Pencil, Write: FilePlus2, TaskCreate: ListChecks, TaskUpdate: ListChecks,
};

const OUTCOME_NOTES: Record<string, string> = {
  stopped: "Stopped. Changes made so far are kept; you can undo them below.",
  limit: "The agent reached a limit for one run.",
  stuck: "The agent was repeating itself and was stopped.",
  error: "The run ended with an error.",
};

type ToolStep = Extract<AgentStep, { kind: "tool" }>;

const AgentText = memo(function AgentText({ text, streaming, mathMarkers, fontSize, onOpenFileLink }: { text: string; streaming: boolean; mathMarkers: MathMarkerSettings; fontSize: number; onOpenFileLink: (href: string) => Promise<boolean> }) {
  const content = useMemo(() => normalizeChatResponseMarkdown(text, streaming, mathMarkers), [text, streaming, mathMarkers]);
  return <MarkdownRenderer copyAsMarkdown mathMarkers={mathMarkers} className="libera-chat-markdown min-w-0 break-normal"
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

export function AgentRunView({ run, streaming, mathMarkers, fontSize, undoing, onUndo, onOpenFile, onOpenFileLink }: {
  run: AgentRunRecord;
  streaming: boolean;
  mathMarkers: MathMarkerSettings;
  fontSize: number;
  undoing: boolean;
  onUndo: (paths?: string[]) => void;
  onOpenFile: (path: string) => void;
  onOpenFileLink: (href: string) => Promise<boolean>;
}) {
  // Consecutive tool steps read as one block of activity between the agent's messages.
  const blocks = useMemo(() => {
    const result: ({ kind: "text"; text: string; index: number } | { kind: "tools"; steps: ToolStep[]; index: number })[] = [];
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
  const working = streaming && (!lastStep || (lastStep.kind === "tool" && lastStep.status !== "running"));
  const done = run.tasks.filter((task) => task.status === "completed").length;
  const pendingChanges = run.changes.filter((change) => !change.reverted);

  return <div className="libera-agent-run space-y-3">
    {blocks.map((block, index) => block.kind === "text"
      ? <AgentText key={block.index} text={block.text} streaming={streaming && index === lastTextIndex} mathMarkers={mathMarkers} fontSize={fontSize} onOpenFileLink={onOpenFileLink} />
      : <ol key={block.index} className="libera-agent-tools" aria-label="Agent activity">{block.steps.map((step) => <ToolLine key={step.id} step={step} />)}</ol>)}
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
        {change.reverted ? <span className="libera-agent-badge">undone</span>
          : !streaming && <button type="button" className="libera-agent-undo" disabled={undoing} aria-label={`Undo changes to ${change.path}`} title={change.created ? "Delete this new file" : "Restore this file as it was before the agent changed it"} onClick={() => onUndo([change.path])}><Undo2 aria-hidden size={12} />Undo</button>}
      </li>)}</ul>
    </section>}
    {run.outcome && OUTCOME_NOTES[run.outcome] && <p className="text-xs text-muted-foreground">{OUTCOME_NOTES[run.outcome]}</p>}
  </div>;
}
