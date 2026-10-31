import { describe, expect, it, vi } from 'vitest'
import type { SkillHost, SkillPackage } from '../../api.js'
import { skillHost } from '../../api.js'
import { prepareCtx } from './prepare.fixture.js'
import { skill } from './skill.js'

const valuation: SkillPackage = {
  name: 'valuation',
  description: '估值方法',
  content: '# 估值\n先找锚',
  hash: 'sha-valuation',
}

describe('skill', () => {
  it('AC-014 identifies itself by name and content hash', () => {
    expect(skill(valuation)).toMatchObject({
      id: 'skill:valuation',
      version: '1',
      kind: 'skill',
      config: { name: 'valuation', hash: 'sha-valuation' },
    })
  })

  it('AC-003 registers with the skill host and lists itself in the notes', async () => {
    const host = skillHost()
    const register = vi.spyOn(host, 'register')
    const prepared = await skill(valuation).prepare(
      prepareCtx({ host: <T>(kind: string) => (kind === 'skill' ? host : undefined) as T }),
    )
    expect(register).toHaveBeenCalledWith('r1', valuation)
    expect(prepared.tools.map((t) => t.name)).toEqual(['activate_skill'])
    expect(prepared.snapshot).toEqual({ fingerprint: 'sha-valuation' })
    expect(prepared.description).toEqual([
      {
        role: 'system',
        parts: [
          {
            type: 'text',
            text: '可用的 skill：valuation — 估值方法。需要时调用 activate_skill 读取完整说明。',
          },
        ],
      },
    ])
    prepared.release!()
  })

  it('fails to prepare without a skill host', async () => {
    const ctx = prepareCtx({
      host: () => {
        throw new Error('能力宿主不存在：skill')
      },
    })
    await expect(skill(valuation).prepare(ctx)).rejects.toThrow('能力宿主不存在：skill')
  })

  it('registers before its first await so the enum is complete when merged', () => {
    const host: SkillHost = skillHost()
    const register = vi.spyOn(host, 'register')
    void skill(valuation).prepare(prepareCtx({ host: <T>() => host as T }))
    expect(register).toHaveBeenCalledTimes(1)
  })
})
