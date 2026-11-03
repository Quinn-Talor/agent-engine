// Claude Code 格式的 PreToolUse hook（由 Node 直接执行）：律师函必须写明收件人。
// 从标准输入读 { tool_name, tool_input }；退出码 2 表示拒绝，标准错误是拒绝理由。
// 律所已有的 hook 脚本可以原样接进引擎：adaptHooks 把它翻译成执行环境的权限规则。

let raw = ''
for await (const chunk of process.stdin) raw += String(chunk)
const { tool_input: input } = JSON.parse(raw) as { tool_input?: { recipient?: string } }
if (!input?.recipient?.trim()) {
  process.stderr.write('律师函必须写明收件人（对方单位全称）')
  process.exit(2)
}

export {}
