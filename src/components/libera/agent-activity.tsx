"use client";

import { memo, useMemo } from "react";
import { useTranslations } from "next-intl";
import { BookOpen, Bot, Check, ChevronRight, Circle, CircleDot, FilePenLine, FilePlus2, FileSearch, FileText, FolderSearch, Globe, ListChecks, LoaderCircle, MessageSquarePlus, MessagesSquare, Pencil, Search, TriangleAlert, Undo2, type LucideIcon } from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { normalizeChatResponseMarkdown } from "@/lib/document-chat";
import type { MathMarkerSettings } from "@/lib/math-markers";
import type { MarkdownMacroScope } from "@/lib/markdown-macros";
import type { AgentRunRecord, AgentStep } from "@/lib/agent/types";

const TOOL_ICONS: Record<string, LucideIcon> = {
  Glob: FolderSearch, Grep: Search, Read: FileText, Edit: Pencil, Write: FilePlus2, TaskCreate: ListChecks, TaskUpdate: ListChecks,
  Skill: BookOpen, LeaveComment: MessageSquarePlus, ReviewComments: MessagesSquare, ReadComments: MessagesSquare, WebSearch: Globe, SuggestEdit: FilePenLine, SuggestedEdits: FilePenLine,
};

const OUTCOME_NOTE_KEYS = new Set(["stopped", "limit", "stuck", "error"]);
const TASK_STATUS_KEYS = new Set(["completed", "in_progress", "pending"]);

type ToolStep = Extract<AgentStep, { kind: "tool" }>;
type SubagentStep = Extract<AgentStep, { kind: "subagent" }>;

const AgentText = memo(function AgentText({ text, streaming, mathMarkers, macroScope, fontSize, onOpenFileLink }: { text: string; streaming: boolean; mathMarkers: MathMarkerSettings; macroScope?: MarkdownMacroScope; fontSize: number; onOpenFileLink: (href: string) => Promise<boolean> }) {
  const content = useMemo(() => normalizeChatResponseMarkdown(text, streaming, mathMarkers), [text, streaming, mathMarkers]);
  return <MarkdownRenderer copyAsMarkdown mathMarkers={mathMarkers} macroScope={macroScope} className="libera-chat-markdown min-w-0 wrap-anywhere"
    baseFontSize={fontSize} baseLineHeight={1.6} renderImages={false} content={content} onOpenFileLink={onOpenFileLink} />;
});

function DiffView({ diff }: { diff: { removed: string; added: string } }) {
  const t = useTranslations("agentActivity");
  const lines = (text: string) => text ? text.split(/\r?\n/) : [];
  // The marks sit in a gutter so they never read as part of a Markdown list item.
  return <pre className="libera-agent-diff" aria-label={t("editLabel")}>
    {lines(diff.removed).map((line, index) => <span key={`r${index}`} data-kind="removed"><span className="libera-agent-diff-mark" aria-hidden>−</span><span className="sr-only">{t("removedPrefix")}</span>{`${line}\n`}</span>)}
    {lines(diff.added).map((line, index) => <span key={`a${index}`} data-kind="added"><span className="libera-agent-diff-mark" aria-hidden>+</span><span className="sr-only">{t("addedPrefix")}</span>{`${line}\n`}</span>)}
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
  const t = useTranslations("agentActivity");
  const running = step.status === "running";
  const failed = !running && step.outcome !== "completed";
  const Icon = running ? LoaderCircle : failed ? TriangleAlert : Bot;
  const latest = step.steps.at(-1);
  const progress = running
    ? (latest ? t("subagentLatest", { count: step.stepCount, latest: latest.summary }) : t("subagentStarting", { count: step.stepCount }))
    : t("subagentFinished", { count: step.stepCount, outcome: t(`outcome.${step.outcome ?? "completed"}`) });
  return <li className="libera-agent-tool libera-agent-subagent" data-status={running ? "running" : failed ? "error" : "ok"}>
    <details>
      <summary className="libera-agent-tool-line" aria-label={t("subagentAriaLabel", { label: step.label, progress })}>
        <Icon aria-hidden size={13} className="libera-agent-tool-icon" />
        <span className="libera-agent-tool-summary" title={step.label}>{step.label}</span>
        <span className="libera-agent-tool-result" title={progress}>{progress}</span>
        <ChevronRight aria-hidden size={12} className="libera-agent-tool-chevron" />
      </summary>
      {step.steps.length ? <ol className="libera-agent-tools pl-4" aria-label={t("stepsOfLabel", { label: step.label })}>
        {step.stepCount > step.steps.length && <li className="text-xs text-muted-foreground">{t("earlierStepsNotShown", { count: step.stepCount - step.steps.length })}</li>}
        {step.steps.map((child) => <ToolLine key={child.id} step={{ kind: "tool", ...child }} />)}
      </ol> : <p className="pl-4 text-xs text-muted-foreground">{t("noStepsYet")}</p>}
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
  const t = useTranslations("agentActivity");
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
      : <ol key={block.index} className="libera-agent-tools" aria-label={t("agentActivityLabel")}>{block.steps.map((step) => step.kind === "subagent" ? <SubagentLine key={step.id} step={step} /> : <ToolLine key={step.id} step={step} />)}</ol>)}
    {working && <p role="status" className="libera-chat-thinking w-fit text-sm text-muted-foreground">{t("working")}</p>}
    {!!run.tasks.length && <section className="libera-agent-tasks" aria-label={t("tasksLabel")}>
      <h3><ListChecks aria-hidden size={13} />{t("tasksHeading")} <span>{done}/{run.tasks.length}</span></h3>
      <ul>{run.tasks.map((task) => {
        const Icon = task.status === "completed" ? Check : task.status === "in_progress" ? CircleDot : Circle;
        return <li key={task.id} data-status={task.status}><Icon aria-hidden size={12} /><span>{task.subject}</span><span className="sr-only">{TASK_STATUS_KEYS.has(task.status) ? t(`taskStatus.${task.status}`) : task.status}</span></li>;
      })}</ul>
    </section>}
    {!!run.changes.length && <section className="libera-agent-changes" aria-label={t("changedFiles")}>
      <h3>
        <Pencil aria-hidden size={13} />{t("changedFiles")} <span>{run.changes.length}</span>
        {pendingChanges.length > 1 && !streaming && <button type="button" className="libera-agent-undo" disabled={undoing} onClick={() => onUndo()}><Undo2 aria-hidden size={12} />{t("undoAll")}</button>}
      </h3>
      <ul>{run.changes.map((change) => <li key={change.path} data-reverted={change.reverted || undefined}>
        <button type="button" className="libera-agent-file" title={t("openFileTitle", { path: change.path })} disabled={change.reverted && change.created} onClick={() => onOpenFile(change.path)}>{change.path}</button>
        {change.created && <span className="libera-agent-badge">{t("newBadge")}</span>}
        {change.suggested && <span className="libera-agent-badge" title={t("suggestedBadgeTitle")}>{t("suggestedBadge")}</span>}
        {change.reverted ? <span className="libera-agent-badge">{change.suggested ? t("withdrawnBadge") : t("undoneBadge")}</span>
          : !streaming && <button type="button" className="libera-agent-undo" disabled={undoing} aria-label={t("undoChangesLabel", { path: change.path })} title={change.suggested ? t("withdrawTitle") : change.created ? t("deleteNewFileTitle") : t("restoreFileTitle")} onClick={() => onUndo([change.path])}><Undo2 aria-hidden size={12} />{t("undo")}</button>}
      </li>)}</ul>
    </section>}
    {!!run.comments?.some((entry) => entry.count) && <section className="libera-agent-changes" aria-label={t("reviewComments")}>
      <h3><MessagesSquare aria-hidden size={13} />{t("reviewComments")} <span>{run.comments.reduce((sum, entry) => sum + entry.count, 0)}</span></h3>
      <ul>{run.comments.filter((entry) => entry.count).map((entry) => <li key={entry.path}>
        <button type="button" className="libera-agent-file" title={t("openCommentsTitle", { path: entry.path })} onClick={() => onOpenFile(entry.path)}>{entry.path}</button>
        <span className="libera-agent-badge">{t("commentCount", { count: entry.count })}</span>
      </li>)}</ul>
    </section>}
    {!!run.suggestions?.some((entry) => entry.count) && <section className="libera-agent-changes" aria-label={t("suggestedEdits")}>
      <h3><FilePenLine aria-hidden size={13} />{t("suggestedEdits")} <span>{run.suggestions.reduce((sum, entry) => sum + entry.count, 0)}</span></h3>
      <ul>{run.suggestions.filter((entry) => entry.count).map((entry) => <li key={entry.path}>
        <button type="button" className="libera-agent-file" title={t("openSuggestionsTitle", { path: entry.path })} onClick={() => onOpenFile(entry.path)}>{entry.path}</button>
        <span className="libera-agent-badge">{t("suggestionCount", { count: entry.count })}</span>
      </li>)}</ul>
    </section>}
    {run.outcome && OUTCOME_NOTE_KEYS.has(run.outcome) && <p className="text-xs text-muted-foreground">{t(`outcomeNote.${run.outcome}`)}</p>}
  </div>;
}
