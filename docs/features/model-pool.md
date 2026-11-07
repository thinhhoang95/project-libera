# Model Pool

The Model Pool is one list of models shared by AI Formatting, AI Rewrite, Write with AI, AI Chat and the Agent, Agentic Review and Generate Definitions. It sits at the top of **Preferences → AI**.

## The pool

Add a model by searching OpenRouter's catalogue, or by typing a slug, such as `anthropic/claude-sonnet-4.5` or a [local alias](local-llms.md) like `local/myllm`. Each row shows the model's name, context length and price where OpenRouter lists them, and chips for the features that use it as their default. A default cannot be removed: choose another model for that feature first.

Each pool feature has a **Default model** list, which holds exactly the pool. The other features (AI Image to Markdown, Convert PDF to Markdown, Convert Markdown to LaTeX/PDF, Recording Live Recap, References and Where Was I) still name their own model, outside the pool.

The pool replaced AI Chat's alternative models. A config from before it keeps them: they become the pool, joined by the models the pool's features are set to. A feature's model always stays in the pool, including when a backup is imported or the file is edited by hand. The pool holds up to 50 models.

Changes to the pool, Generate Definitions, local endpoints and custom system prompts apply without restarting. A feature's default model, reasoning effort and prompt caching are read when the server starts, so changing them asks for a restart, as before.

## Choosing a model in the editors

In the right-click menu of the Markdown editors and the LaTeX editor, AI Format, AI Rewrite and Write with AI each have a small label under them with the model and reasoning effort. Click it to pick another pool model or effort for that action. A dot on the label marks a choice that differs from the default; **Use default** drops it.

The choice is kept on this device, one per action, until you change it or the action's default changes in Preferences. Requests name only what differs from the default, and the server refuses a model that is not in the pool. A model removed from the pool drops out of the choice by itself.

## Generate Definitions

**Preferences → AI → Generate Definitions** sets the model and reasoning effort the Agent starts with for [Generate definitions](definitions.md). The model comes from the pool. Left on **Same as the AI panel**, the run uses the AI panel's current choice, as it did before this setting existed. The run uses AI Chat's routing.

## Custom system prompts

Every function's card has a **Custom system prompt**, and a **Set** tag shows which ones hold something. Libera adds the text after its own instructions, which keep setting the output format, so a prompt cannot break a feature that parses the reply (Agentic Review's JSON, for example). **Load from file** fills it from a text file.

Write with AI uses AI Rewrite's prompt until it has its own. While the two match, a run of both on one document keeps one cached thread; different prompts mean a cache miss, not a wrong result. Generate Definitions' prompt goes with its skill, so it applies to runs started from the Definitions tab, not to asking the agent in your own words.

## Implementation

- `electron/ai-preferences.cjs`: `normalizeModelPool`, the migration from `chat.alternativeModels`, `normalizeDefinitionsPreferences`, and `aiPreferencesNeedingRestart`.
- `src/lib/ai-preferences.ts`: `getAiModelPool`, `getAiTaskOptions` (checks a menu's choice against the pool), `getDefinitionsOptions`, `getAiCustomInstruction` and `withAiCustomInstruction`. The pool, the definitions settings and the prompts are read from the config file on each request.
- `src/app/api/ai-models/route.ts`: the pool and each action's default, for the editors.
- `src/components/libera/ai-model-picker.tsx`: the label, its popover, the stored choices and `aiTaskRequestOptions`, which the request sites spread into their bodies.
- `src/app/api/agent/route.ts`: applies the Generate Definitions settings when a run preloads the `extract-definitions` skill.
- `electron/setup.html`: the Preferences page.

## Checks

`node --test scripts/lib/ai-preferences.test.cjs`, and `scripts/editor/local-llm.test.ts` for a menu's choice reaching the routes.
