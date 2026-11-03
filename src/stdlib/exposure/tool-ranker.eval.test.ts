import { describe, expect, it } from 'vitest'
import { EVAL_TOOLS } from './tool-ranker.fixture.js'
import { bm25Ranker } from './tool-ranker.js'

/** 查询与期望命中（任一进入前 8 即算命中，search_tool 一次给 8 个）。 */
const CASES: ReadonlyArray<[string, string[]]> = [
  ['天气 weather 杭州 实时天气查询', ['plugin_e2e-probe_weather__get_weather']],
  ['天气 weather forecast 城市 实时气温 湿度', ['plugin_e2e-probe_weather__get_weather']],
  ['现金流', ['tu-share__cashflow', 'tu-share__cashflow_vip']],
  ['港股 利润', ['tu-share__hk_income']],
  ['十大股东', ['tu-share__top10_holders', 'tu-share__top10_floatholders']],
  ['涨停 连板', ['tu-share__limit_step']],
  ['新闻联播', ['tu-share__cctv_news']],
  ['借贷利率', ['tu-share__wz_index', 'tu-share__gz_index']],
  ['实时分钟数据', ['tu-share__rt_min', 'tu-share__rt_etf_min', 'tu-share__rt_min_daily']],
  ['ETF 净值', ['tu-share__rt_etf_sz_iopv', 'tu-share__etf_share_size']],
  ['物价 CPI', ['tu-share__cn_cpi']],
  ['美股 财报 现金', ['tu-share__us_cashflow']],
  ['自选股组合 删除', ['tu-share__p_delete']],
]

async function rankOf(ranker: ReturnType<typeof bm25Ranker>, query: string, expected: string[]) {
  const hits = await ranker.rank(query, EVAL_TOOLS)
  return hits.findIndex((h) => expected.includes(h.name)) + 1
}

describe('bm25Ranker on real tools', () => {
  it('puts every expected tool in the first 8, an English-only tool among Chinese ones included', async () => {
    const ranker = bm25Ranker()
    const ranks = await Promise.all(CASES.map(([q, e]) => rankOf(ranker, q, e)))
    // 名次为 0 表示没有命中
    const misses = CASES.map(([q], i) => [q, ranks[i]] as const).filter(([, r]) => r < 1 || r > 8)
    expect(misses).toEqual([])
    // 改动前排第 11、被挤出前 8 的天气查询，现在进入前 3
    expect(ranks[0]).toBeLessThanOrEqual(3)
  })

  it('keeps single characters as a fallback: a query sharing only characters still finds tools', async () => {
    // "股价"与任何描述都没有共同的两字词，靠单字命中
    expect((await bm25Ranker().rank('股价', EVAL_TOOLS)).length).toBeGreaterThan(0)
  })

  it('lets Chinese words outweigh an English word when single characters count fully', async () => {
    // 单字与两字等权时（改动前），描述里反复出现"实时""查询"的工具把天气工具挤出前 8
    const equal = bm25Ranker({ unigramWeight: 1 })
    expect(await rankOf(equal, CASES[0]![0], CASES[0]![1])).toBeGreaterThan(8)
  })
})
