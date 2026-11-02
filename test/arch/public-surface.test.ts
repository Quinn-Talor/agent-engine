// 包的公开面（设计 §14）：核心函数只在 sdk 入口，不进包入口；各入口的运行时导出记在快照里，
// 增删导出都会出现在 diff 里，由评审决定是不是要对应用做这个承诺。

import { describe, expect, it } from 'vitest'

const keysOf = async (entry: Promise<Record<string, unknown>>) => Object.keys(await entry).sort()

describe('public surface', () => {
  it('keeps the component-author helpers out of the package entry', async () => {
    const [api, sdk, index] = await Promise.all([
      keysOf(import('../../src/api.js')),
      keysOf(import('../../src/sdk.js')),
      keysOf(import('../../src/index.js')),
    ])
    expect(sdk).toEqual(expect.arrayContaining(api))
    expect(index).toEqual(expect.arrayContaining(api))
    const sdkOnly = sdk.filter((k) => !api.includes(k))
    expect(sdkOnly.length).toBeGreaterThan(0)
    expect(index.filter((k) => sdkOnly.includes(k))).toEqual([])
  })

  it('keeps the test tooling out of the package entry', async () => {
    const [testing, index] = await Promise.all([
      keysOf(import('../../src/testing.js')),
      keysOf(import('../../src/index.js')),
    ])
    expect(index.filter((k) => testing.includes(k))).toEqual([])
  })

  it('records every entry point’s runtime exports', async () => {
    const [api, sdk, index, testing] = await Promise.all([
      keysOf(import('../../src/api.js')),
      keysOf(import('../../src/sdk.js')),
      keysOf(import('../../src/index.js')),
      keysOf(import('../../src/testing.js')),
    ])
    expect({
      'agent-engine': index,
      'agent-engine/sdk (beyond the app API)': sdk.filter((k) => !api.includes(k)),
      'agent-engine/testing': testing,
    }).toMatchSnapshot()
  })
})
