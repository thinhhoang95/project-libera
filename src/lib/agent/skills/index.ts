import type { AgentSkill } from "../tools";
import { leaveReviewCommentsSkill } from "./leave-review-comments";

// The agent's skills. Each skill is one module in this folder: a name and a
// one-line description (always in the system prompt), Markdown instructions
// (sent only when the model loads the skill with the Skill tool), and
// optionally tools and a finishPass hook. To add a skill, write its module
// and list it here.

export const AGENT_SKILLS: AgentSkill[] = [leaveReviewCommentsSkill];
