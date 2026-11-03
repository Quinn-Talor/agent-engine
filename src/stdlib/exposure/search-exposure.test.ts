import { describe, expect, it } from 'vitest'
import type { ComponentCtx, ToolboxState } from '../../contracts/component.js'
import type { ToolCtx } from '../../contracts/tool.js'
import { runInfo } from '../capabilities/prepare.fixture.js'
import { searchExposure, type SearchExposureOptions } from './search-exposure.js'

type Prepared = ToolboxState['prepared'][number]

const eager: Prepared[] = [
  { name: 'a', capability: 'core', exposure: 'eager', description: 'always there' },
  { name: 'b', capability: 'core', exposure: 'eager', description: 'also there' },
  { name: 'search_tool', capability: 'exposure', exposure: 'eager', description: 'find tools' },
]
const crm = (name: string, description: string): Prepared => ({
  name: `crm__${name}`,
  capability: 'mcp:crm',
  exposure: 'deferred',
  description,
})
const filler = Array.from({ length: 28 }, (_, i) => crm(`misc${i}`, `杂项工具 ${i}`))
const thirty = [
  ...eager,
  crm('daily', '日线行情 daily quotes'),
  crm('weekly', '周线行情'),
  ...filler,
]

const ctx = {} as ComponentCtx

function setup(prepared: readonly Prepared[] = thirty, opts: SearchExposureOptions = {}) {
  const exposure = searchExposure(opts)
  const instance = exposure.start({ ...runInfo(), runId: 'r1' }, ctx)
  const searchTool = exposure.tools![0]!
  const visible = (step: number, calls: ToolboxState['calls'] = []) =>
    instance.visible({ step, prepared, calls })
  const search = (input: { query?: string; server?: string }) =>
    searchTool.execute(input, { runId: 'r1' } as ToolCtx) as Promise<string>
  return { exposure, visible, search }
}

describe('searchExposure', () => {
  it('provides search_tool with a query and an optional server', () => {
    const { exposure } = setup()
    expect(exposure).toMatchObject({ id: 'search', version: '3' })
    expect(exposure.tools!.map((t) => [t.name, t.execution?.effect])).toEqual([
      ['search_tool', 'none'],
    ])
    expect(exposure.tools![0]!.description).toContain('server')
  })

  it('AC-001 shows only eager tools and search_tool before any search', () => {
    expect(setup().visible(1)).toEqual(['a', 'b', 'search_tool'])
  })

  it('AC-002 loads only the matching tools, best first', async () => {
    const { visible, search } = setup()
    visible(1)
    const text = await search({ query: '日线 行情' })
    expect(text.split('\n')[1]).toContain('crm__daily')
    expect(text).toContain('crm__weekly')
    expect(visible(2, [{ step: 1, name: 'search_tool' }])).toEqual([
      'a',
      'b',
      'search_tool',
      'crm__daily',
      'crm__weekly',
    ])
  })

  it('AC-003 loads at most topK tools and says how many more matched', async () => {
    const { visible, search } = setup()
    visible(1)
    const text = await search({ query: '杂项 工具' })
    const shown = visible(2).filter((n) => n.startsWith('crm__'))
    expect(shown).toHaveLength(8)
    expect(text).toContain('另有 20 个匹配')
  })

  it('AC-004 keeps loaded tools in load order and never drops them', async () => {
    const { visible, search } = setup()
    visible(1)
    await search({ query: '日线' })
    const step2 = visible(2, [{ step: 1, name: 'search_tool' }])
    await search({ query: '周线' })
    const calls = [
      { step: 1, name: 'search_tool' },
      { step: 2, name: 'search_tool' },
      { step: 3, name: 'crm__daily' },
    ]
    const step4 = visible(4, calls)
    expect(step2.slice(0, 4)).toEqual(['a', 'b', 'search_tool', 'crm__daily'])
    expect(step4).toEqual(['a', 'b', 'search_tool', 'crm__daily', 'crm__weekly'])
    expect(visible(5, calls)).toEqual(step4)
  })

  it('AC-005 loads nothing and lists only servers when nothing matches', async () => {
    const { visible, search } = setup()
    visible(1)
    const text = await search({ query: 'zzz' })
    expect(text).toContain('没有匹配"zzz"')
    expect(text).toContain('mcp:crm — 30 个工具')
    expect(text).not.toContain('crm__daily')
    expect(visible(2)).toEqual(['a', 'b', 'search_tool'])
    expect(await search({ query: '' })).toContain('没有匹配')
  })

  it('AC-006 limits a search to one server', async () => {
    const erp: Prepared = {
      name: 'erp__orders',
      capability: 'mcp:erp',
      exposure: 'deferred',
      description: '订单列表',
    }
    const crmOrders = crm('orders', '订单查询')
    const { visible, search } = setup([...thirty, erp, crmOrders])
    visible(1)
    const text = await search({ query: '订单', server: 'crm' })
    expect(text).toContain('crm__orders')
    expect(text).not.toContain('erp__orders')
    expect(await search({ query: '订单', server: 'nope' })).toContain('没有名为 nope 的服务器')
  })

  it('AC-007 gives every deferred tool when there are few of them', () => {
    const few = [...eager, ...filler.slice(0, 15)]
    expect(setup(few).visible(1)).toEqual(['a', 'b', ...filler.slice(0, 15).map((p) => p.name)])
    expect(setup(few, { eagerBelow: 0 }).visible(1)).toEqual(['a', 'b', 'search_tool'])
  })

  it('AC-010 uses a custom ranker, drops unknown names and falls back to BM25 on errors', async () => {
    const custom = setup(thirty, {
      ranker: {
        id: 'custom',
        rank: async () => [
          { name: 'crm__weekly', score: 1 },
          { name: 'nope', score: 1 },
        ],
      },
    })
    custom.visible(1)
    await custom.search({ query: 'anything' })
    expect(custom.visible(2).filter((n) => n.startsWith('crm__'))).toEqual(['crm__weekly'])

    const broken = setup(thirty, {
      ranker: {
        id: 'broken',
        rank: async () => {
          throw new Error('boom')
        },
      },
    })
    broken.visible(1)
    const text = await broken.search({ query: '日线' })
    expect(text).toContain('crm__daily')
    expect(text).toContain('检索器出错，已改用关键词检索')
  })

  it('evicts the earliest loaded tool that was never called when over maxLoaded', async () => {
    const { visible, search } = setup(thirty, { topK: 2, maxLoaded: 2 })
    visible(1)
    await search({ query: '日线' })
    await search({ query: '周线' })
    await search({ query: '杂项 0' })
    expect(visible(2).filter((n) => n.startsWith('crm__'))).toHaveLength(2)
  })

  it('hides search_tool when nothing is deferred', () => {
    expect(setup(eager).visible(1)).toEqual(['a', 'b'])
  })
})
