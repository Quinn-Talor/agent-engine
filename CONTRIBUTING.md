# Contributing

English | [简体中文](#参与贡献)

Thanks for helping improve agent-engine. Bug reports, design discussions and pull requests are all welcome.

## Before you start

- For a bug, open an issue with the smallest run that reproduces it. A run log (`archive.read(runId)`) or a failing test with the scripted `fakeModel` from `@talor/agent-engine/testing` helps the most.
- For a new feature or a change in behaviour, open an issue first. The loop is fixed on purpose; most extensions belong in a component slot, not in the engine. The design is in [`docs/agent-engine-design.md`](docs/agent-engine-design.md) (in Chinese).

## Development

Node.js 22 or later.

```bash
npm install
```

Every pull request must pass the same checks as CI:

```bash
npm run lint
```

```bash
npm run format:check
```

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```

## Rules the code follows

- **Dependencies point one way:** `contracts → core → executor / services → engine → api.ts`. `stdlib`, `testing` and `adapters` use the engine only through its public API. `eslint.config.js` enforces this.
- **The run log is the single source of truth.** Anything a run decides or does must be written as an event before state changes; projections (state, trace, retrospective, statistics) are pure functions of the log.
- **Invariants are enforced by the engine** (design §7). A change must not let any component break them; `assertInvariants(events)` checks a run log.
- **Tests come with the change.** Unit tests sit next to the source as `*.test.ts`; engine-level flows go in `test/integration/`. Write the failing test first.
- **No new runtime dependencies** without discussing them in an issue. External libraries are optional peer dependencies behind adapters.

## Pull requests

- Keep one concern per pull request.
- Write commit messages as a plain sentence in the imperative that says what changes, for example `Catch execution claims with words between 已 and the verb`.
- Update the docs when behaviour changes: the design document, the feature catalog and, for user-facing changes, both READMEs.
- Add an entry under `Unreleased` in [CHANGELOG.md](CHANGELOG.md).

## Releasing (maintainers)

1. Move the `Unreleased` entries in `CHANGELOG.md` under the new version.
2. Bump `version` in `package.json` and `CLIENT_INFO.version` in `src/adapters/mcp-stdio/mcp-client.ts`.
3. Commit, tag `vX.Y.Z` and push the tag.
4. `npm publish` (runs lint, format check, typecheck and tests, then builds a clean `dist`).

---

# 参与贡献

[English](#contributing) | 简体中文

欢迎报告问题、讨论设计和提交 PR。

## 开始之前

- 报告 bug：提 issue，附上能复现问题的最小运行。最有用的是运行日志（`archive.read(runId)`），或者用 `@talor/agent-engine/testing` 里脚本化的 `fakeModel` 写一个失败的测试。
- 新功能或行为变化：先提 issue 讨论。流程是有意固定的，多数扩展应该做成组件填进槽位，而不是改引擎。设计见 [`docs/agent-engine-design.md`](docs/agent-engine-design.md)。

## 开发

需要 Node.js 22 及以上。

```bash
npm install
```

每个 PR 都要通过和 CI 相同的检查：

```bash
npm run lint
```

```bash
npm run format:check
```

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```

## 代码遵守的规则

- **依赖单向**：`contracts → core → executor / services → engine → api.ts`；`stdlib`、`testing`、`adapters` 只经公开 API 取用引擎能力。由 `eslint.config.js` 强制。
- **运行日志是唯一的事实来源**：运行做出的判断和动作，先写成事件再改状态；投影（状态、trace、复盘、统计）都是日志的纯函数。
- **不变量由引擎强制**（设计 §7）：改动不能让任何组件破坏它们；`assertInvariants(events)` 可以检查一份运行日志。
- **改动带测试**：单测与源文件同目录，命名 `*.test.ts`；引擎级流程放 `test/integration/`。先写失败的测试。
- **不随意加运行时依赖**：要加先在 issue 里讨论。外部库都放在适配器后面，作为可选的 peer 依赖。

## 提交 PR

- 一个 PR 只做一件事。
- 提交信息用一句祈使句说清改了什么，例如 `Catch execution claims with words between 已 and the verb`。
- 行为有变化时同步更新文档：设计文档、功能清单；面向用户的变化同时更新中英文 README。
- 在 [CHANGELOG.md](CHANGELOG.md) 的 `Unreleased` 下加一条。

## 发布（维护者）

1. 把 `CHANGELOG.md` 里 `Unreleased` 的条目移到新版本下。
2. 改 `package.json` 的 `version` 和 `src/adapters/mcp-stdio/mcp-client.ts` 里的 `CLIENT_INFO.version`。
3. 提交，打标签 `vX.Y.Z` 并推送标签。
4. `npm publish`（会先跑 lint、格式检查、类型检查和测试，再构建干净的 `dist`）。
