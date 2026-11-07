# Local LLMs

**Preferences → Local LLMs**, under AI, connects Libera to any OpenAI-compatible server on this computer or your network. Each endpoint has an alias, and `local/<alias>` then works wherever a model slug does: in the [Model Pool](model-pool.md), in the model fields of the other AI features, and in **Use for all**.

## Setting one up

Choose **Add endpoint**, then:

- **Alias:** the name after `local/`. Letters, numbers, dots, dashes and underscores.
- **Server:** a preset fills in the base URL: Ollama (`http://localhost:11434/v1`), LM Studio (`:1234`) or llama-server (`:8080`). **Custom** leaves it to you.
- **Base URL:** the server's OpenAI-compatible address. `http://host:1234` is read as `http://host:1234/v1`.
- **Model:** the name as the server knows it. The field lists what the server's `/v1/models` reports, and you can type a name too.
- **API key:** optional; most local servers need none. It is stored in the config file, like the OpenRouter key, and is part of a preferences backup.

**Test connection** lists the models, then asks the chosen model for one token, so a pass means a real request works. A model that has to load first can take a minute. **Add to Model Pool** puts the alias in the pool. Renaming an alias updates the pool and every feature using it; an endpoint in use cannot be removed.

## What works

Requests stream over SSE. Replies appear token by token in AI Chat and the Agent. AI Format, AI Rewrite and Write with AI stream too, so a slow model is not cut off by Node's five-minute wait for response headers, but they show the result when it is complete, as they do with OpenRouter.

AI Formatting, AI Rewrite, Write with AI, AI Chat, the Agent, Agentic Review, Generate Definitions, Convert Markdown to LaTeX/PDF, Recording Live Recap, References and Where Was I all work without an OpenRouter key when set to a local model. AI Image to Markdown works with a model that takes images.

Some things need OpenRouter:

- **Web search**, for the Agent and for References. With a local model the Agent's search falls back to the AI Chat default model.
- **Convert PDF to Markdown** with a model: pages are sent as PDF files, which local servers do not read. The on-device reader is unaffected.
- Speech, read aloud and image generation use their own models.

Reasoning effort, prompt caching and routing do not apply, and Preferences turns them off for a local model. Effort is not sent because Ollama refuses it for models that do not think. Local use is left out of Spending.

A `<think>…</think>` block at the start of a reply is dropped from chat and editor results, so a reasoning model's notes do not end up in a document.

The Agent needs a model that can call tools. Local servers do not report their context window, so the Agent assumes 32,768 tokens when deciding what to trim.

## When something goes wrong

Failures say what to do, with the steps for the server in use:

| What happened | How it shows up |
|---|---|
| Server not running | The connection is refused or the host is not found: "Could not reach Ollama at … Is the server running?" with how to start it. |
| Model not loaded | A 404 or a "not found" or "no models loaded" reply, with `ollama pull`, `lms load` or the `-m` option. |
| Context length exceeded | The wording each server uses for it, with how to send less and how to raise the limit. |
| Still loading | A 503 or "Loading model". The Agent retries this one; nothing else is retried. |
| Key rejected | A 401 or 403. |
| No tool support | Ollama's "does not support tools", suggesting another model or Chat. |
| Connection dropped | A reply that ends early, suggesting the server may have run out of memory. |
| Alias not set up | The alias is in use but has no endpoint. The Model Pool flags it too. |

## Implementation

- `electron/local-llms.cjs`: presets, normalizing endpoints, `describeLocalLlmFailure`, and the model list and connection test the main process runs for Preferences (which cross-origin rules keep from local servers itself).
- `src/lib/local-llm.ts`: reads the endpoints on each request, cleans OpenRouter's fields out of a request, streams it, and maps failures. `createOpenRouterCompletion` and `streamOpenRouterCompletion` in `openrouter.ts`, and `openStream` and `getModelProfile` in `agent/model.ts`, send `local/` models here, which is what makes every feature work with them.
- `modelAvailable` in `openrouter.ts` replaces the checks for an OpenRouter key in features that can run on a local model.

## Checks

`node --test scripts/lib/local-llms.test.cjs`

`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/local-llm.test.ts`

The second runs against a fake server: tokens arriving while the model still writes, tool calls, the failures above, and each route. They never reach OpenRouter and run without a key.
