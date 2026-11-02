import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

// 依赖方向规则（BR-001）：用真实的 eslint.config.js 对虚拟文件做 lint，只看 error 级结果。
const eslint = new ESLint({ cwd: process.cwd() })

async function lintImport(filePath: string, specifier: string): Promise<string[]> {
  const code = `import { x } from '${specifier}'\nexport const y = x\n`
  const [result] = await eslint.lintText(code, { filePath })
  return result.messages.filter((m) => m.severity === 2).map((m) => m.ruleId ?? 'fatal')
}

const DENIED = ['no-restricted-imports']

describe('dependency direction', () => {
  it('AC-003 core must not import executor', async () => {
    expect(await lintImport('src/core/a.ts', '../executor/b.js')).toEqual(DENIED)
  })

  it('AC-004 core may import node:crypto, contracts and zod', async () => {
    expect(await lintImport('src/core/a.ts', 'node:crypto')).toEqual([])
    expect(await lintImport('src/core/a.ts', '../contracts/b.js')).toEqual([])
    expect(await lintImport('src/core/a.ts', 'zod')).toEqual([])
  })

  it('AC-005 core must not import other node built-ins', async () => {
    expect(await lintImport('src/core/a.ts', 'node:fs')).toEqual(DENIED)
  })

  it('AC-006 contracts must not import core or external packages', async () => {
    expect(await lintImport('src/contracts/a.ts', '../core/b.js')).toEqual(DENIED)
    expect(await lintImport('src/contracts/a.ts', 'lodash')).toEqual(DENIED)
  })

  it('AC-007 engine must not import stdlib but may import executor', async () => {
    expect(await lintImport('src/engine/a.ts', '../stdlib/b.js')).toEqual(DENIED)
    expect(await lintImport('src/engine/a.ts', '../executor/b.js')).toEqual([])
  })

  it('AC-008 stdlib may import api only', async () => {
    expect(await lintImport('src/stdlib/a.ts', '../api.js')).toEqual([])
    expect(await lintImport('src/stdlib/a.ts', '../core/b.js')).toEqual(DENIED)
    expect(await lintImport('src/stdlib/a.ts', '../index.js')).toEqual(DENIED)
  })

  it('AC-009 each adapter may import only its own external library', async () => {
    expect(await lintImport('src/adapters/ai-sdk/a.ts', 'ai')).toEqual([])
    expect(await lintImport('src/adapters/sqlite/a.ts', 'ai')).toEqual(DENIED)
  })

  it('lets an adapter import package paths that end in index.js or api.js', async () => {
    const sdk = '@modelcontextprotocol/sdk/client/index.js'
    expect(await lintImport('src/adapters/mcp-stdio/a.ts', sdk)).toEqual([])
    expect(
      await lintImport('src/adapters/mcp-stdio/a.ts', '@modelcontextprotocol/sdk/x/api.js'),
    ).toEqual([])
    expect(await lintImport('src/adapters/mcp-stdio/a.ts', '../../index.js')).toEqual(DENIED)
    expect(await lintImport('src/core/a.ts', '../api.js')).toEqual(DENIED)
  })

  it('AC-010 no layer may import electron', async () => {
    for (const file of [
      'src/core/a.ts',
      'src/engine/a.ts',
      'src/stdlib/a.ts',
      'src/adapters/sqlite/a.ts',
    ]) {
      expect(await lintImport(file, 'electron')).toEqual(DENIED)
    }
  })

  it('allows relative imports within the same layer', async () => {
    expect(await lintImport('src/core/a.ts', './b.js')).toEqual([])
  })

  it('test files may import test tooling but still respect layer direction', async () => {
    expect(await lintImport('src/core/a.test.ts', 'vitest')).toEqual([])
    expect(await lintImport('src/core/a.test.ts', '../executor/b.js')).toEqual(DENIED)
  })

  it('api.ts must not import stdlib', async () => {
    expect(await lintImport('src/api.ts', './stdlib/b.js')).toEqual(DENIED)
    expect(await lintImport('src/api.ts', './engine/b.js')).toEqual([])
  })

  it('AC-016 test files may import the testing toolkit, source files may not', async () => {
    expect(await lintImport('src/core/a.test.ts', '../testing/fake-clock.js')).toEqual([])
    expect(await lintImport('src/core/a.ts', '../testing/fake-clock.js')).toEqual(DENIED)
  })

  it('AC-014 api.ts may import platform services', async () => {
    expect(await lintImport('src/api.ts', './services/b.js')).toEqual([])
  })
})
