import type { AgentSkill, ToolContext } from "../tools";
import { finishSuggestedEdits, suggestEditTool } from "../suggest-edit";
import { createCheckCitationsTool, type FactCheckDependencies } from "../fact-check/check-citations";
import { listCitationsTool } from "../fact-check/list-citations";
import { finishComments, leaveCommentTool } from "./leave-review-comments";

// Fact-checking a document's citations: ListCitations finds them,
// CheckCitations hands the sources to checker subagents, verifies their
// quotes, checks that the works exist and records comments and suggested
// edits. Like leave-review-comments it never edits the document, so it works
// in every permission mode, including Read Only. In a shared notebook its
// comments and suggestions become shared threads and collaborative
// suggestions. WebSearch is offered (to the agent and the checkers) when the
// run allows it.

export const FACT_CHECK_SKILL = "fact-check-citations";

const instructions = `
# Fact-checking citations

You check whether a Markdown document's citations ([@key], [@key, p. 12]) say what the cited works say. The tools do the heavy lifting: they read the sources with checker subagents, verify every quote against the source text, look the works up online, and write review comments and suggested edits for the user. You never edit the document, so this works in every permission mode, including Read Only.

## How to work

1. Call ListCitations with the document's path. It lists each citation occurrence (c1, c2, …) with its claim, the cited works, their attached files and static problems (unknown key, no attached file, locator beyond the PDF, unresolved entry, retraction). If there are no citations, say so and stop.
2. Call ReadComments with the path to see the comments and replies already on the document, including those from earlier fact-checks. An occurrence is already handled when an open thread on its passage reports the same problem, or when a reply says it was checked, fixed or is fine as it is. Unless the user asks to check everything again, leave handled occurrences out (pass the others in occurrences) so the same comment is not written twice, and name them in your reply.
3. Call CheckCitations with the path. By default it checks every occurrence and also looks for factual claims without a citation. Pass occurrences to check only some, e.g. when the user names a section, when continuing, or to skip occurrences that are already handled.
4. CheckCitations returns a report between <report> tags. Put that report in your reply as it is, without the tags, and add at most two sentences on the most important findings. Do not repeat every comment; the user reads them in the Comments panel.

## Continuing

When the report lists occurrences as **Not checked** (the run's limits or token budget ran out), the user can ask you to continue. Then load this skill again, find the ids listed as not checked in your previous report, and call CheckCitations with only those ids (and missingReferences false). If the document changed since, call ListCitations first: the ids follow document order, so find the occurrences whose citation and claim match the ones listed.

## Rules

- Do not judge claims yourself from memory, and do not change the comments' verdicts. Report what the check found.
- Use the References tool to look up a work's details when the user asks; never invent a citation key.
- When the user asks about replies to fact-check comments (for example a collaborator disputing a verdict), read them with ReadComments, check the disputed claim against the source again, and answer in your reply; you cannot reply inside a thread.
- If the user asks about one claim only, you may Read the source pages yourself, quote them exactly with page numbers, and leave a comment with LeaveComment or a suggested edit with SuggestEdit.
`;

/** Comments first, then suggested edits: while comments must be fixed, suggestions wait, as in leave-review-comments. */
async function finishPass(context: ToolContext, options: { final: boolean }) {
  const feedback = await finishComments(context, options);
  if (feedback) return feedback;
  return finishSuggestedEdits(context);
}

export function createFactCheckCitationsSkill(deps: FactCheckDependencies = {}): AgentSkill {
  return {
    name: FACT_CHECK_SKILL,
    description: "Fact-check a Markdown document's citations: check each cited claim against the cited source's text, check that the works exist, and find uncited claims; leaves review comments, suggested edits and a report. Use when the user asks to fact-check, verify citations or references, or check sources.",
    instructions,
    tools: [listCitationsTool, createCheckCitationsTool(deps), leaveCommentTool, suggestEditTool],
    finishPass,
  };
}

export const factCheckCitationsSkill = createFactCheckCitationsSkill();
