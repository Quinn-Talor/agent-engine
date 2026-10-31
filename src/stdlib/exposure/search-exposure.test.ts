import { describe, expect, it } from 'vitest'
import type { ComponentCtx, ToolboxState } from '../../contracts/component.js'
import type { ToolCtx } from '../../contracts/tool.js'
import { runInfo } from '../capabilities/prepare.fixture.js'
import { searchExposure } from './search-exposure.js'

const prepared: ToolboxState['prepared'] = [
  { name: 'a', capability: 'core', exposure: 'eager', description: 'always there' },
  { name: 'crm_lookup', capability: 'crm', exposure: 'deferred', description: '查询客户档案' },
  { name: 'erp_orders', capability: 'erp', exposure: 'deferred', description: 'list orders' },
  { name: 'search_tool', capability: 'exposure', exposure: 'eager', description: 'find tools' },
]
const state = (
  step: number,
  calls: ToolboxState['calls'] = [],
  tools = prepared,
): ToolboxState => ({
  step,
  prepared: tools,
  calls,
})
const ctx = {} as ComponentCtx

function setup(runId = 'r1') {
  const exposure = searchExposure()
  const instance = exposure.start({ ...runInfo(), runId }, ctx)
  const searchTool = exposure.tools![0]!
  const search = (query?: string) =>
    searchTool.execute(query === undefined ? {} : { query }, { runId } as ToolCtx)
  return { exposure, instance, search }
}

describe('searchExposure', () => {
  it('provides search_tool as a system tool', () => {
    const { exposure } = setup()
    expect(exposure).toMatchObject({ id: 'search', version: '1' })
    expect(exposure.tools!.map((t) => [t.name, t.execution?.effect])).toEqual([
      ['search_tool', 'none'],
    ])
  })

  it('AC-008 shows eager tools and search_tool first', () => {
    expect(setup().instance.visible(state(1))).toEqual(['a', 'search_tool'])
  })

  it('AC-009 expands every deferred tool after search_tool was called', () => {
    const { instance } = setup()
    const after = state(3, [{ step: 2, name: 'search_tool' }])
    expect(instance.visible(after)).toEqual(['a', 'crm_lookup', 'erp_orders', 'search_tool'])
    expect(instance.visible(state(9, [{ step: 2, name: 'search_tool' }]))).toHaveLength(4)
  })

  it('keeps a deferred tool visible once it has been called', () => {
    const { instance } = setup()
    expect(instance.visible(state(4, [{ step: 3, name: 'erp_orders' }]))).toEqual([
      'a',
      'erp_orders',
      'search_tool',
    ])
  })

  it('AC-010 hides search_tool when nothing is deferred', () => {
    const eagerOnly = prepared.filter((p) => p.exposure === 'eager')
    expect(setup().instance.visible(state(1, [], eagerOnly))).toEqual(['a'])
  })

  it('AC-011 lists matching deferred tools for the run', async () => {
    const { instance, search } = setup()
    instance.visible(state(1))
    expect(await search('客户')).toBe('以下工具下一步可用：\n- crm_lookup — 查询客户档案')
    expect(await search()).toBe(
      '以下工具下一步可用：\n- crm_lookup — 查询客户档案\n- erp_orders — list orders',
    )
    expect(await search('Orders LIST')).toBe('以下工具下一步可用：\n- erp_orders — list orders')
    expect(await search('weather')).toBe(
      '没有匹配"weather"的工具。可用的延后工具：crm_lookup、erp_orders',
    )
  })

  it('answers for an unknown run', async () => {
    const { search } = setup('never-seen')
    expect(await search('x')).toBe('没有匹配"x"的工具。可用的延后工具：无')
  })
})
