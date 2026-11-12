# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/). Until 1.0, minor versions may change the public API.

## Unreleased

## 0.1.0 - 2026-11-12

First public release.

### Added

- A fixed run loop: compose, reason, act (permissions, approvals, concurrent tools), evaluate (observation, guard opinions, verdict) and deliver (output contract, checks, fallback). Every run ends.
- An event-sourced run log as the single source of truth, with in-memory and SQLite archives, content-addressed blobs, retention, pinning and session deletion.
- Projections of the log: run state, transcript, trace, retrospective, supervision statistics, side effects and run summaries; strict and regression replay.
- Capabilities: tools, MCP servers over stdio and Streamable HTTP, skills, subagents, planning and intent tools (`ask_user`, `propose`, `report_blocked`).
- Claude Code plugin support: skills, agents, MCP configuration and hooks.
- Sessions: continuation, cross-turn compaction, a side-effect ledger, branching and window preview.
- Multimodal input: images and files in task input and tool results, checked against the model's input modalities.
- Supervision with standard guards and an optional model advisor; delivery checks with completion review against what was executed and grounding checks.
- Permissions: workspace sandbox and risk-based approval with approvers that answer now or later.
- AI SDK integration: a model provider adapter and a UI message stream for `useChat` with resumable SSE.
- OpenTelemetry and Langfuse exporters that group session turns and mark failed checks.
- A test kit: fake model, tools and MCP server, chaos injection, component conformance suites, invariant assertions and archive contract tests.

---

# 更新日志

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。1.0 之前，次版本号可能改变公开 API。

## 0.1.0 - 2026-11-12

首个公开版本：固定的运行流程；事件溯源的运行日志与内存、SQLite 档案；日志的各类投影与严格、回归重放；工具、MCP、skill、子 agent、计划与意图工具；Claude Code 插件；会话；多模态输入；监督与交付验收；权限与审批；AI SDK 模型适配与 `useChat` 前端流；OpenTelemetry 与 Langfuse 导出；测试工具。详见上方英文条目。
