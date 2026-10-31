import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 项目规范（vibe/project/）与仓库实际配置保持一致，防止文档随时间漂移。
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function section(doc: string, heading: string): string {
  const start = doc.indexOf(`\n${heading}\n`)
  if (start < 0) return ''
  const rest = doc.slice(start + heading.length + 2)
  const next = rest.search(/\n## /)
  return next < 0 ? rest : rest.slice(0, next)
}

function commandNames(text: string): string[] {
  return [...text.matchAll(/`npm (?:run ([\w:-]+)|(test))[^`]*`/g)].map((m) => m[1] ?? m[2])
}

describe('project docs', () => {
  it('AC-011 every command in overview exists in package.json scripts', () => {
    const scripts = Object.keys(JSON.parse(read('package.json')).scripts as Record<string, string>)
    const names = commandNames(section(read('vibe/project/overview.md'), '## 常用命令'))
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n) => !scripts.includes(n))).toEqual([])
  })

  it('command extraction ignores non-script npm commands', () => {
    expect(commandNames('`npm install` `npm test` `npm run lint` `npm run build`')).toEqual([
      'test',
      'lint',
      'build',
    ])
  })

  it('AC-012 standards has §S.1–§S.5 and patterns indexes at least 6 patterns', () => {
    const standards = read('vibe/project/standards.md')
    for (const n of [1, 2, 3, 4, 5]) {
      expect(standards).toMatch(new RegExp(`^## §S\\.${n} `, 'm'))
    }
    const index = section(read('vibe/project/patterns.md'), '## 模式索引')
    expect(index.match(/^\| P\d+ \|/gm)?.length ?? 0).toBeGreaterThanOrEqual(6)
  })
})
