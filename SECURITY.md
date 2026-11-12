# Security Policy

English | [简体中文](#安全策略)

## Supported versions

Security fixes go into the latest published minor version.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. Include what is affected, how to reproduce it and the impact you expect. You should get a first reply within seven days.

Areas that matter most: the permission pipeline (sandbox, approvals, deny rules), hook and MCP process handling, redaction of secrets before they reach the run log, and anything that lets a component break the engine's invariants.

---

# 安全策略

[English](#security-policy) | 简体中文

## 支持的版本

安全修复发布在最新的次版本上。

## 报告漏洞

请不要公开提 issue。请通过 GitHub 私下报告：在仓库的 **Security** 页签选择 **Report a vulnerability**，写明影响范围、复现方法和预期影响。七天内会有首次答复。

最受关注的方面：权限流水线（沙箱、审批、拒绝规则）、hook 与 MCP 进程的处理、写入运行日志前的密钥脱敏，以及任何能让组件破坏引擎不变量的问题。
