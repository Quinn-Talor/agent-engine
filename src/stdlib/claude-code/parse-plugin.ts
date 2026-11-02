// 插件解析（设计 §4.2 插件表）：Claude Code 格式的插件由格式解析器拆开——skills/ → skill 包，
// agents/ → Agent 定义，.mcp.json → MCP 规格，hooks/hooks.json → hook 规格，commands/ → 斜杠命令。
// 用在哪、启用哪些由应用决定；`${CLAUDE_PLUGIN_ROOT}` 替换为插件目录。

import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AgentDef, HookSpec, McpServerSpec, SkillPackage } from '../../api.js'
import { parseMcpConfig } from './parse-mcp-config.js'
import { parseSkill, splitFrontmatter } from './parse-skill.js'

const PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}'
const HOOK_EVENTS = new Set<HookSpec['event']>([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'Notification',
])

export interface ParsedPlugin {
  name: string
  version?: string
  description?: string
  skills: SkillPackage[]
  agents: Array<{ def: AgentDef; description: string; tools?: string[] }>
  mcpServers: McpServerSpec[]
  hooks: HookSpec[]
  commands: Array<{ name: string; description?: string; content: string }>
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 目录下的条目，按名字排序；目录不存在时为空。 */
async function entries(dir: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
  try {
    const list = await readdir(dir, { withFileTypes: true })
    return list
      .map((d) => ({ name: d.name, isDirectory: d.isDirectory() }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

async function markdownFiles(dir: string) {
  const files = (await entries(dir)).filter((e) => !e.isDirectory && e.name.endsWith('.md'))
  return Promise.all(
    files.map(async (f) => ({
      name: f.name.slice(0, -'.md'.length),
      ...splitFrontmatter((await readText(join(dir, f.name))) ?? ''),
    })),
  )
}

function parseHooks(json: unknown, dir: string, source: string): HookSpec[] {
  const byEvent = isObject(json) && isObject(json.hooks) ? json.hooks : {}
  const specs: HookSpec[] = []
  for (const [event, groups] of Object.entries(byEvent)) {
    if (!HOOK_EVENTS.has(event as HookSpec['event']) || !Array.isArray(groups)) continue
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue
      const matcher = typeof group.matcher === 'string' && group.matcher ? group.matcher : undefined
      for (const hook of group.hooks) {
        if (!isObject(hook) || hook.type !== 'command' || typeof hook.command !== 'string') continue
        specs.push({
          event: event as HookSpec['event'],
          ...(matcher ? { matcher } : {}),
          command: hook.command.replaceAll(PLUGIN_ROOT, dir),
          ...(typeof hook.timeout === 'number' ? { timeoutMs: hook.timeout * 1000 } : {}),
          source,
        })
      }
    }
  }
  return specs
}

export async function parsePlugin(dir: string): Promise<ParsedPlugin> {
  const manifestText = await readText(join(dir, '.claude-plugin', 'plugin.json'))
  const manifest: Record<string, unknown> = manifestText ? JSON.parse(manifestText) : {}
  const name = typeof manifest.name === 'string' ? manifest.name : basename(dir)

  const skillDirs = (await entries(join(dir, 'skills'))).filter((e) => e.isDirectory)
  const skills = await Promise.all(skillDirs.map((d) => parseSkill(join(dir, 'skills', d.name))))

  const agents = (await markdownFiles(join(dir, 'agents'))).map(({ name: file, fields, body }) => {
    const tools = fields.tools
      ?.split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    return {
      def: {
        id: fields.name ?? file,
        instructions: [
          { role: 'system' as const, parts: [{ type: 'text' as const, text: body.trim() }] },
        ],
      },
      description: fields.description ?? '',
      ...(tools && tools.length > 0 ? { tools } : {}),
    }
  })

  const mcpText = await readText(join(dir, '.mcp.json'))
  const mcpServers = mcpText
    ? parseMcpConfig(mcpText.replaceAll(PLUGIN_ROOT, JSON.stringify(dir).slice(1, -1)))
    : []

  const hooksText = await readText(join(dir, 'hooks', 'hooks.json'))
  const hooks = hooksText ? parseHooks(JSON.parse(hooksText), dir, `plugin:${name}`) : []

  const commands = (await markdownFiles(join(dir, 'commands'))).map(
    ({ name: file, fields, body }) => ({
      name: file,
      ...(fields.description ? { description: fields.description } : {}),
      content: body.trim(),
    }),
  )

  return {
    name,
    ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
    ...(typeof manifest.description === 'string' ? { description: manifest.description } : {}),
    skills,
    agents,
    mcpServers,
    hooks,
    commands,
  }
}
