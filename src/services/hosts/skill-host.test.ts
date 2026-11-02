import { describe, expect, it } from 'vitest'
import { isToolError } from '../../contracts/errors.js'
import type { ToolCtx } from '../../contracts/tool.js'
import { skillHost, type SkillPackage } from './skill-host.js'

const pkg = (name: string, content = `# ${name}\n步骤一`): SkillPackage => ({
  name,
  description: `${name} 的用法`,
  content,
  hash: `hash-${name}`,
})

const ctx = (runId: string) => ({ runId }) as ToolCtx

describe('skillHost', () => {
  it('AC-003 shares one activation tool per run with every skill in its enum', () => {
    const host = skillHost()
    expect(host.kind).toBe('skill')
    const a = host.register('r1', pkg('valuation'))
    const b = host.register('r1', pkg('report'))
    const other = host.register('r2', pkg('valuation'))
    expect(a.tool).toBe(b.tool)
    expect(other.tool).not.toBe(a.tool)
    expect(a.tool).toMatchObject({ name: 'activate_skill', execution: { effect: 'none' } })
    expect(a.tool.inputSchema).toEqual({
      type: 'object',
      properties: { name: { type: 'string', enum: ['valuation', 'report'] } },
      required: ['name'],
      additionalProperties: false,
    })
  })

  it('AC-004 returns the content again on re-activation with a short note', async () => {
    const host = skillHost()
    const { tool } = host.register('r1', pkg('valuation'))
    const body = '<skill name="valuation">\n# valuation\n步骤一\n</skill>'
    expect(await tool.execute({ name: 'valuation' }, ctx('r1'))).toBe(body)
    // 前文可能已被压缩：再次激活仍给出全文，开头加一句说明。
    expect(await tool.execute({ name: 'valuation' }, ctx('r1'))).toBe(
      `（skill valuation 之前已激活过，以下再次给出全文）\n${body}`,
    )
  })

  it('AC-004 truncates content over 20000 characters', async () => {
    const host = skillHost()
    const exact = 'a'.repeat(20_000)
    const long = 'b'.repeat(20_001)
    const { tool } = host.register('r1', pkg('exact', exact))
    host.register('r1', pkg('long', long))
    expect(await tool.execute({ name: 'exact' }, ctx('r1'))).toBe(
      `<skill name="exact">\n${exact}\n</skill>`,
    )
    expect(await tool.execute({ name: 'long' }, ctx('r1'))).toBe(
      `<skill name="long">\n${'b'.repeat(20_000)}\n…（已截断，原文 20001 字）\n</skill>`,
    )
  })

  it('rejects names outside the run', async () => {
    const { tool } = skillHost().register('r1', pkg('valuation'))
    const out = await tool.execute({ name: 'other' }, ctx('r1'))
    expect(isToolError(out) && out).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'skill other 不在本次运行中',
    })
    expect(isToolError(await tool.execute({ name: 'valuation' }, ctx('r9')))).toBe(true)
  })

  it('AC-006 forgets a run once every skill of it is released', async () => {
    const host = skillHost()
    const a = host.register('r1', pkg('valuation'))
    const b = host.register('r1', pkg('report'))
    const keep = host.register('r2', pkg('valuation'))
    a.release()
    a.release()
    expect(await a.tool.execute({ name: 'report' }, ctx('r1'))).toContain('<skill')
    b.release()
    expect(isToolError(await a.tool.execute({ name: 'report' }, ctx('r1')))).toBe(true)
    expect(await keep.tool.execute({ name: 'valuation' }, ctx('r2'))).toContain('<skill')
  })
})
