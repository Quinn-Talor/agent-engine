# agent-engine

[![npm](https://img.shields.io/npm/v/@talor/agent-engine)](https://www.npmjs.com/package/@talor/agent-engine)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/node/v/@talor/agent-engine)](package.json)

English | [简体中文](README.zh-CN.md)

agent-engine is a TypeScript library for running AI agents reliably. The application defines an agent, builds a task and starts a run in an environment; the engine drives the run through one fixed loop until it ends and returns the result together with a complete, append-only run log.

**The engine hosts and runs; the application configures and chooses.** The engine does not decide which MCP servers, plugins or capabilities an agent gets, and it does not own the product side of conversations (session ids, access, lists), the UI, business data or prompt content. It does own a session's context: continuing a conversation, the next turn's window, compaction across turns and the ledger of side effects.

- **Every run ends.** Budgets, guard thresholds, bounded retries and a single fallback delivery mean failures of models, tools and components are bounded, degraded and recoverable.
- **Predictable and replayable.** The run log is the single source of truth. State, transcript, trace, statistics and retrospective are all projections of it, and runs can be replayed strictly or against new components.
- **Extensible without forks.** The loop is fixed; every stage exposes component slots. Business logic plugs in without changing the engine.

## Features

| Area                | What you get                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loop                | Compose → reason → act (permissions, approvals, concurrent tools) → evaluate (observation → guard opinions → verdict) → deliver (output contract → checks → fallback) |
| Capabilities        | Tools, MCP servers (stdio and Streamable HTTP), skills, subagents, planning, and intent tools (`ask_user`, `propose`, `report_blocked`)                               |
| Claude Code plugins | Load a plugin's skills, agents, MCP config and hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Stop`, …)                                                    |
| Sessions            | Multi-turn conversations with carry-over, cross-turn compaction, a side-effect ledger, branching and a window preview                                                 |
| Multimodal input    | Images and files in task input and tool results, checked against the model's input modalities before a run starts                                                     |
| Supervision         | Guards (roadblocks, failure streaks, no new information, silent progress, pressure) with hints and blocks, plus an optional model advisor                             |
| Delivery            | Text or structured output, completion review against what was actually executed, grounding checks, fallback delivery                                                  |
| Permissions         | Workspace sandbox, risk-based approval, approvers that answer now or later                                                                                            |
| Frontend            | Stream a run to the AI SDK UI message protocol for `useChat`, with resumable SSE                                                                                      |
| Observability       | OpenTelemetry and Langfuse exporters grouped by session; trace, retrospective and supervision statistics as projections                                               |
| Persistence         | In-memory or SQLite run archive with content-addressed blobs, retention, pinning and session deletion                                                                 |
| Testing             | Fake model, tool and MCP server, chaos injection, conformance suites for components, invariant assertions, replay                                                     |

## Install

Requires Node.js 22 or later. The package is ESM only.

The package is not on the npm registry. Install it from a release tag on GitHub:

```bash
npm install github:Quinn-Talor/agent-engine#v0.1.1 zod
```

npm clones the tag and builds `dist` with the package's `prepare` script, so the first install takes a little longer. Imports use the package name, `@talor/agent-engine`. npm 11 may warn that this `prepare` script is not covered by `allowScripts`; the build still runs. To allow it and silence the warning, add this to your project's `package.json` (`npm approve-scripts` does not handle git dependencies):

```json
"allowScripts": { "github:Quinn-Talor/agent-engine": true }
```

To work against a local checkout instead, run `npm install` there (it builds `dist`) and then `npm install <path to the checkout>` in your project.

The engine uses `zod` v4, and so do your schemas; one copy is installed when the major versions match. Everything else is an optional peer dependency, so install only what you use:

| You want to                                                  | Install                                         | Import from                                                 |
| ------------------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------- |
| Call models through the [Vercel AI SDK](https://ai-sdk.dev)  | `ai` and a provider such as `@ai-sdk/anthropic` | `aiSdkProvider` from `@talor/agent-engine/adapters/ai-sdk`  |
| Keep runs in SQLite (otherwise an in-memory archive is used) | `better-sqlite3`                                | `sqliteArchive` from `@talor/agent-engine/adapters/sqlite`  |
| Connect MCP servers                                          | `@modelcontextprotocol/sdk`                     | `mcpHost()` from the package root loads it on first connect |

Entry points: `@talor/agent-engine` (application API, standard components, `createEngine`), `@talor/agent-engine/sdk` (core functions for component and adapter authors), `@talor/agent-engine/testing` (test kit), and the adapters above.

## Quick start

```ts
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import {
  createEngine,
  defineAgent,
  defineTask,
  intents,
  modelHub,
  tools,
  type ToolDef,
} from '@talor/agent-engine'
import { aiSdkProvider } from '@talor/agent-engine/adapters/ai-sdk'
import { sqliteArchive } from '@talor/agent-engine/adapters/sqlite'

// 1. Engine: platform services (models, run archive, …). Memory, supervision and
//    delivery default to the standard components, including completion review.
const provider = aiSdkProvider({
  id: 'anthropic',
  models: {
    sonnet: {
      model: anthropic('claude-sonnet-5-5'),
      vendor: 'anthropic',
      capabilities: { contextLimit: 200_000 },
    },
  },
})
const engine = createEngine({
  services: {
    models: modelHub({ providers: [provider], default: 'anthropic:sonnet' }),
    archive: sqliteArchive({ file: 'runs.db' }),
  },
})

// 2. Environment: the rules every agent here follows. With a reachable principal,
//    the agent may ask_user and propose.
const interactive = engine.environment({ name: 'interactive', principal: { reachable: true } })

// 3. Agent: who does the work — instructions and capabilities.
const weather: ToolDef = {
  name: 'weather',
  description: 'Look up the weather in a city',
  inputSchema: z.object({ city: z.string() }),
  execution: { effect: 'none' },
  async execute(input) {
    const { city } = input as { city: string }
    return `${city}: sunny, 20°C`
  },
}
const assistant = defineAgent({
  id: 'assistant',
  instructions: [
    { role: 'system', parts: [{ type: 'text', text: 'You are a travel assistant.' }] },
  ],
  capabilities: [intents(), tools([weather])],
})

// 4. Task: what to do this time, and how far to go.
const task = defineTask({
  input: [
    { role: 'user', parts: [{ type: 'text', text: 'Do I need an umbrella in Tokyo tomorrow?' }] },
  ],
  budget: { maxSteps: 10, maxTotalMs: 120_000 },
})

// 5. Run: subscribe for live output, then await the result.
const run = interactive.start(assistant, task)
run.subscribe({
  onNotice: (n) => void (n.t === 'text_delta' && process.stdout.write(n.text)),
  onEvent: (e) => void (e.t === 'tool_finished' && console.log(`\n[tool] ${e.callId}`)),
})
const result = await run.result
console.log(result.status, result.code, result.text, result.intent)
```

`result.status` is how the run ended: `completed` (delivered), `awaiting_input` (needs the principal's reply), `finalized` (not done, delivered what it had), `stopped`, `failed` or `aborted`. `result.code` says why; when the run ends on an intent tool, `result.intent` carries that call (for example the question of `ask_user`).

## Sessions

Pass a session id on every turn. The engine derives the context each turn starts with from the session's log — continuation, compaction across turns, the ledger of side effects and how the previous turn ended — so the application only manages the id and the UI.

```ts
const first = interactive.start(assistant, ask('My employer owes me three months of salary.'), {
  session: 'case-1024',
})
await first.result // awaiting_input: the agent asks when you started and your salary

// The principal's answer is the next turn; the task no longer carries history.
const second = interactive.start(assistant, ask('Since 2021, 12,000 a month.'), {
  session: 'case-1024',
})

// Edit an earlier message or regenerate: branch from a given turn; continues: null starts over.
interactive.start(assistant, ask('Let me rephrase.'), {
  session: 'case-1024',
  continues: first.runId,
})

await engine.previewWindow({ session: 'case-1024' }) // what the next turn would carry, no model call
await engine.deleteSession('case-1024') // the whole session, child runs included
```

A session runs one turn at a time; a second turn is refused with `session_busy` (retryable). Use `run.steer(text)` to add guidance to a running turn and `run.abort()` to cancel it. A turn interrupted by a crash is closed when the engine starts again, and the next turn continues normally with the outcome noted and any possibly executed side effects in the ledger.

## Streaming to a chat UI

`runToUIMessageStreamResponse` turns a run into the AI SDK UI message stream that `useChat` consumes, as SSE with event ids so a reconnecting client can resume:

```ts
import { runToUIMessageStreamResponse } from '@talor/agent-engine/adapters/ai-sdk'

export async function POST(req: Request): Promise<Response> {
  const { id, text } = (await req.json()) as { id: string; text: string }
  const run = interactive.start(
    assistant,
    defineTask({ input: [{ role: 'user', parts: [{ type: 'text', text }] }] }),
    { session: id },
  )
  return runToUIMessageStreamResponse(run, { archive })
}
```

See [`examples/chat-endpoint`](examples/chat-endpoint/README.md) for resuming streams and approvals answered in the page.

## Images and files

Task input accepts image and file parts. Before a run starts, the engine checks them against the model's declared input modalities and refuses what the model cannot take.

```ts
const look = defineTask({
  input: [
    {
      role: 'user',
      parts: [
        { type: 'text', text: 'What is wrong with this invoice?' },
        { type: 'image', image: await readFile('invoice.png'), mediaType: 'image/png' },
      ],
    },
  ],
})
```

## Observability and evaluation

Exporters are run subscribers; they only build data, and you supply `send`:

```ts
import { otelExporter } from '@talor/agent-engine'

run.subscribe(otelExporter({ send: (spans) => collector.export(spans) }), { children: true })
```

A session turn is tagged with `gen_ai.conversation.id` in OpenTelemetry and `sessionId` in Langfuse, so platforms group turns by conversation. Failed delivery checks are marked (`agent.pass = false`, Langfuse level `WARNING`). Only metadata is exported, never prompt or reply content.

Evaluating quality — judging, scoring, aggregating across runs, experiments — belongs to the application or your observability platform. The engine guarantees the facts are there: `retrospective(events)` gives the timeline (guard signals, interventions, approvals, model failures, compactions), model attempts and tool outcomes per step, every check verdict per delivery, side effects, usage and timing; `buildTrace(events)` gives the timing tree.

## Core concepts

| Object      | Responsibility                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Engine      | Platform services (models, capability hosts, run archive, credentials, clock, admission) and run mechanics (memory, supervision) |
| Environment | Rules every agent working here must follow: principal, notices, permissions, policies, required checks, limits                   |
| Agent       | Who does the work: instructions, capabilities, default deliverable, model preference                                             |
| Task        | What to do this time: input, history (without a session), scope, deliverable, constraints, budget                                |
| Run         | One execution; its log is append-only and the single source of truth                                                             |

Facts, opinions and verdicts are recorded separately, and every verdict can be traced to its source.

## Components and adapters

Components fill the slots of the loop; the application chooses them.

| Slot                            | Standard components                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| Capabilities                    | `tools`, `tool`, `bundle`, `intents`, `planning`, `skill`, `subagent`, `mcp`                       |
| Memory                          | `compactingMemory`                                                                                 |
| Tool exposure                   | `searchExposure`                                                                                   |
| Supervision                     | `standardGuards`, `roadblock`, `thresholdGuard`, `modelAdvisor`, `progressGuard`                   |
| Delivery                        | `text`, `structured`, `standardFallback`                                                           |
| Checks                          | `groundingCheck`, `completionReview` (on by default in `createEngine`)                             |
| Permissions                     | `workspaceSandbox` (built-in sensitive-path deny list; configuration can only add), `riskApproval` |
| Plugins                         | `parsePlugin`, `parseSkill`, `parseMcpConfig`, `adaptHooks`                                        |
| Retrospective and observability | `retrospect.brief`, `otelExporter`, `langfuseExporter`                                             |

Adapters connect external dependencies to ports: `aiSdkProvider` (models), `sqliteArchive` (run archive), `mcpHost` (MCP connection pool over stdio or Streamable HTTP), `hookRunner` (hook processes) and `consoleLogger` (diagnostics).

## Test kit

Import from `@talor/agent-engine/testing`:

| Tool                                                         | Purpose                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `fakeModel`, `fakeTool`, `fakeMcpServer`, `FakeClock`        | Scripted model, tools, MCP server and a controllable clock                                  |
| `runToEnd(run)`                                              | Run to the end; returns the result and the events received                                  |
| `assertInvariants(events)`                                   | Assert the run log satisfies the engine's invariants, listing every violation               |
| `replay(archive, runId, 'strict')`                           | Strictly replay an archived run; `{ mode: 'regression', … }` replays it with new components |
| `chaos({ seed, rate, faults, clock })`                       | Wrap model providers, the archive, MCP connections and hooks to inject seeded faults        |
| `conformance.guard / memory / exposure / check / permission` | Conformance suites for your components                                                      |
| `archiveStoreContract(make)`                                 | Contract tests every `ArchiveStore` implementation must pass                                |

Suites return test cases for your own test runner:

```ts
import { conformance } from '@talor/agent-engine/testing'

for (const c of conformance.memory(myMemory)) it(c.name, () => c.run())
```

## Examples

- [`examples/legal-consult`](examples/legal-consult/README.md): a law firm's labour-dispute consultation platform that uses every kind of component, mostly custom, with nine runnable scenarios (`npm run demo:legal`).
- [`examples/chat-endpoint`](examples/chat-endpoint/README.md): a chat endpoint for `useChat` with resumable streams and approvals.

## Documentation

The design documents are written in Chinese:

- [`docs/agent-engine-design.md`](docs/agent-engine-design.md): the full design (objects, loop, extension architecture, run log, invariants, standard library)
- [`docs/session-design.md`](docs/session-design.md): sessions
- [`docs/guard-mechanism.md`](docs/guard-mechanism.md): guards
- [`docs/feature-catalog.md`](docs/feature-catalog.md): features, where they live and how they are tested

## Development

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run build
```

The dependency direction (`contracts → core → executor / services → engine → api.ts`; `stdlib`, `testing` and `adapters` use the engine only through its public API) is enforced by `eslint.config.js`. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[MIT](LICENSE)
