import { describe, expect, it } from 'vitest'
import { bm25Ranker, tokenize } from './tool-ranker.js'

const tools = [
  { name: 'crm__daily', capability: 'mcp:crm', description: '/行情数据/历史日线-获取股票日线行情' },
  { name: 'crm__weekly', capability: 'mcp:crm', description: '/行情数据/周线行情' },
  { name: 'crm__income', capability: 'mcp:crm', description: '/财务数据/利润表' },
  { name: 'web__browserClick', capability: 'mcp:web', description: 'Click an element on the page' },
]

describe('tokenize', () => {
  it('splits names, camel case and Chinese into single characters and pairs', () => {
    expect(tokenize('crm__browserClick')).toEqual(['crm', 'browser', 'click'])
    expect(tokenize('日线行情')).toEqual(['日', '日线', '线', '线行', '行', '行情', '情'])
    expect(tokenize('A股 daily')).toEqual(['a', '股', 'daily'])
  })
})

describe('bm25Ranker', () => {
  const ranker = bm25Ranker()

  it('ranks Chinese queries by overlapping words and characters', async () => {
    const hits = await ranker.rank('日线 行情', tools)
    expect(hits[0]!.name).toBe('crm__daily')
    expect(hits.map((h) => h.name)).toContain('crm__weekly')
    expect(hits.map((h) => h.name)).not.toContain('web__browserClick')
  })

  it('scores a partial match instead of requiring every word', async () => {
    const hits = await ranker.rank('利润表 不存在的词', tools)
    expect(hits.map((h) => h.name)).toEqual(['crm__income'])
  })

  it('matches English names split from camel case', async () => {
    expect((await ranker.rank('browser click', tools))[0]!.name).toBe('web__browserClick')
  })

  it('returns nothing for an empty query or no candidates', async () => {
    expect(await ranker.rank('', tools)).toEqual([])
    expect(await ranker.rank('日线', [])).toEqual([])
  })
})
