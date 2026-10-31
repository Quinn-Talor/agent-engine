// skill 目录解析（设计 §11 格式解析）：读取 SKILL.md 的 frontmatter（name、description）与正文。
// 只解析标准格式：单行 `key: value`（可带引号）与 `>`、`|` 块（可带缩进与截尾标记，例如 `>-`、`|+`，
// 字段值统一不带结尾换行）；其他键忽略。兼容 CRLF 换行。读哪个目录由应用决定。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256Hex, type SkillPackage } from '../../api.js'

/** 块标量的头：`>` 或 `|`，后面可跟截尾标记（`+`、`-`）与缩进数字，顺序不限。 */
const BLOCK_HEADER = /^([>|])(?:[+-]?[1-9]?|[1-9][+-])$/

const unquote = (v: string) =>
  v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0] ? v.slice(1, -1) : v

function parseFrontmatter(lines: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]!)
    if (!match) continue
    const key = match[1]!
    const value = match[2]!.trim()
    const header = BLOCK_HEADER.exec(value)
    if (header) {
      const block: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) block.push(lines[++i]!.trim())
      fields[key] = block.join(header[1] === '>' ? ' ' : '\n')
    } else {
      fields[key] = unquote(value)
    }
  }
  return fields
}

/** 拆出开头 `---` 之间的 frontmatter 与正文；没有 frontmatter 时字段为空（插件的 agent、命令也用它）。 */
export function splitFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const lines = text.split(/\r?\n/)
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end > 0) {
      return {
        fields: parseFrontmatter(lines.slice(1, end)),
        body: lines.slice(end + 1).join('\n'),
      }
    }
  }
  return { fields: {}, body: text }
}

export async function parseSkill(dir: string): Promise<SkillPackage> {
  let text: string
  try {
    text = await readFile(join(dir, 'SKILL.md'), 'utf8')
  } catch (error) {
    throw new Error(`${dir} 没有 SKILL.md`, { cause: error })
  }
  const { fields, body } = splitFrontmatter(text)
  if (!fields.name) throw new Error('SKILL.md 缺少 name')
  if (!fields.description) throw new Error('SKILL.md 缺少 description')
  return {
    name: fields.name,
    description: fields.description,
    content: body.trim(),
    hash: sha256Hex(text),
    dir,
  }
}
