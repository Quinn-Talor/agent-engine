import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parsePlugin } from './parse-plugin.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plugin-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function put(path: string, content: string) {
  await mkdir(join(dir, path, '..'), { recursive: true })
  await writeFile(join(dir, path), content, 'utf8')
}

describe('parsePlugin', () => {
  it('AC-013 splits a Claude Code plugin into its parts', async () => {
    await put(
      '.claude-plugin/plugin.json',
      JSON.stringify({ name: 'research-kit', version: '1.2.0', description: '研究工具包' }),
    )
    await put(
      'skills/valuation/SKILL.md',
      '---\nname: valuation\ndescription: 估值方法\n---\n# 估值',
    )
    await put('skills/report/SKILL.md', '---\nname: report\ndescription: 写报告\n---\n# 报告')
    await put(
      'agents/researcher.md',
      '---\nname: researcher\ndescription: 查资料\ntools: Read, Grep ,WebSearch\nmodel: sonnet\n---\n\n你负责查资料。\n',
    )
    await put('agents/writer.md', '只写正文的 agent')
    await put(
      '.mcp.json',
      JSON.stringify({
        mcpServers: {
          market: { command: '${CLAUDE_PLUGIN_ROOT}/bin/market', env: { KEY: '${MARKET_KEY}' } },
        },
      }),
    )
    await put(
      'hooks/hooks.json',
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh', timeout: 5 },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'echo done' },
                { type: 'prompt', prompt: 'ignored' },
              ],
            },
          ],
        },
      }),
    )
    await put('commands/review.md', '---\ndescription: 审查当前修改\n---\n请审查 $ARGUMENTS\n')

    const plugin = await parsePlugin(dir)
    expect(plugin).toMatchObject({
      name: 'research-kit',
      version: '1.2.0',
      description: '研究工具包',
    })
    expect(plugin.skills.map((s) => [s.name, s.content])).toEqual([
      ['report', '# 报告'],
      ['valuation', '# 估值'],
    ])
    expect(plugin.agents).toEqual([
      {
        def: {
          id: 'researcher',
          instructions: [{ role: 'system', parts: [{ type: 'text', text: '你负责查资料。' }] }],
        },
        description: '查资料',
        tools: ['Read', 'Grep', 'WebSearch'],
      },
      {
        def: {
          id: 'writer',
          instructions: [{ role: 'system', parts: [{ type: 'text', text: '只写正文的 agent' }] }],
        },
        description: '',
      },
    ])
    expect(plugin.mcpServers).toEqual([
      {
        name: 'market',
        transport: {
          kind: 'stdio',
          command: `${dir}/bin/market`,
          env: { KEY: { secret: 'MARKET_KEY' } },
        },
      },
    ])
    expect(plugin.hooks).toEqual([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command: `${dir}/hooks/guard.sh`,
        timeoutMs: 5000,
        source: 'plugin:research-kit',
      },
      { event: 'Stop', command: 'echo done', source: 'plugin:research-kit' },
    ])
    expect(plugin.commands).toEqual([
      { name: 'review', description: '审查当前修改', content: '请审查 $ARGUMENTS' },
    ])
  })

  it('AC-014 tolerates missing parts and names the plugin after its directory', async () => {
    await put('commands/hello.md', '你好')
    expect(await parsePlugin(dir)).toEqual({
      name: basename(dir),
      skills: [],
      agents: [],
      mcpServers: [],
      hooks: [],
      commands: [{ name: 'hello', content: '你好' }],
    })
  })

  it('AC-015 ignores hook entries that are not commands or are malformed', async () => {
    await put(
      'hooks/hooks.json',
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'prompt' }, { type: 'command' }] }], PostToolUse: 'bad' },
      }),
    )
    expect((await parsePlugin(dir)).hooks).toEqual([])
  })
})
