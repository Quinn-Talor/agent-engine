import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256Hex } from '../../api.js'
import { parseSkill, splitFrontmatter } from './parse-skill.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skill-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const write = (text: string) => writeFile(join(dir, 'SKILL.md'), text, 'utf8')

describe('parseSkill', () => {
  it('AC-001 reads name, description and body from SKILL.md', async () => {
    const text = [
      '---',
      'name: "valuation"',
      'description: >',
      '  估值方法：',
      '  先找锚再推算',
      'allowed-tools: Read',
      '---',
      '',
      '# 估值',
      '1. 找锚',
      '',
    ].join('\n')
    await write(text)
    expect(await parseSkill(dir)).toEqual({
      name: 'valuation',
      description: '估值方法： 先找锚再推算',
      content: '# 估值\n1. 找锚',
      hash: sha256Hex(text),
      dir,
    })
  })

  it('AC-001 keeps line breaks of literal blocks and single quotes', async () => {
    await write(
      ['---', "name: 'report'", 'description: |', '  第一行', '  第二行', '---', 'body'].join('\n'),
    )
    expect(await parseSkill(dir)).toMatchObject({
      name: 'report',
      description: '第一行\n第二行',
      content: 'body',
    })
  })

  it('reads a SKILL.md with CRLF line endings', async () => {
    await write(
      ['---', 'name: crlf', 'description: |', '  a', '  b', '---', 'body', ''].join('\r\n'),
    )
    expect(await parseSkill(dir)).toMatchObject({
      name: 'crlf',
      description: 'a\nb',
      content: 'body',
    })
  })

  it.each([
    ['>-', '折叠 文本'],
    ['>+', '折叠 文本'],
    ['|-', '折叠\n文本'],
    ['|+', '折叠\n文本'],
    ['|2', '折叠\n文本'],
    ['>2-', '折叠 文本'],
  ])('reads a block scalar with indicator %s', (indicator, expected) => {
    const text = ['---', `description: ${indicator}`, '  折叠', '  文本', 'name: a', '---', 'b']
    expect(splitFrontmatter(text.join('\n')).fields).toEqual({ description: expected, name: 'a' })
  })

  it.each([
    ['name', '---\ndescription: x\n---\nbody', 'SKILL.md 缺少 name'],
    ['description', '---\nname: x\n---\nbody', 'SKILL.md 缺少 description'],
    ['frontmatter', '# just a body', 'SKILL.md 缺少 name'],
  ])('AC-002 rejects a SKILL.md without %s', async (_what, text, message) => {
    await write(text)
    await expect(parseSkill(dir)).rejects.toThrow(message)
  })

  it('AC-002 rejects a directory without SKILL.md', async () => {
    await expect(parseSkill(dir)).rejects.toThrow(`${dir} 没有 SKILL.md`)
  })
})
