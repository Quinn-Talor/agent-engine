// 输出契约（设计 §9.8）：判断候选交付的格式是否合格，不改写交付内容。
// text：文本交付要求非空；structured：通过 submit 提交，交付时做领域校验。

import { z, type ZodType } from 'zod'
import type { JsonValue } from '../../contracts/common.js'
import type { ComponentCtx, Corpus, OutputContract } from '../../contracts/component.js'
import type { ToolDef } from '../../contracts/tool.js'

const nameOf = (fn: ((...args: never[]) => unknown) | undefined): string | null =>
  fn ? fn.name || 'custom' : null

export function text(
  opts: { sanitize?: (text: string, corpus: Corpus) => string } = {},
): OutputContract {
  const contract: OutputContract = {
    id: 'text',
    version: '1',
    kind: 'text',
    config: { sanitize: nameOf(opts.sanitize) },
    async validate(candidate) {
      // 以完成类意图结束时，交付内容在意图的参数里，文本可以为空。
      if ((candidate.text ?? '').trim().length > 0) return { ok: true }
      if (candidate.observation.intent?.kind === 'complete') return { ok: true }
      return { ok: false, issues: ['交付文本为空'], hint: '请直接给出完整的回答文本' }
    },
  }
  if (opts.sanitize) contract.sanitize = opts.sanitize
  return contract
}

export type DomainValidate<T> = (
  output: T,
  ctx: ComponentCtx,
) => Promise<{ ok: true } | { ok: false; issues: string[]; hint: string }>

const DEFAULT_MAX_REPAIRS = 3

export function structured<T>(
  schema: ZodType<T>,
  opts: { validate?: DomainValidate<T>; maxRepairs?: number } = {},
): OutputContract & { schema: ZodType<T> } {
  const maxRepairs = opts.maxRepairs ?? DEFAULT_MAX_REPAIRS
  const submit: ToolDef = {
    name: 'submit',
    description: '提交最终的结构化结果。参数必须符合 schema；提交后由交付环节校验。',
    inputSchema: schema,
    execution: { effect: 'none' },
    semantics: { intent: { kind: 'complete', code: 'submit' } },
    execute: async () => '已提交，等待校验',
  }
  return {
    id: 'structured',
    version: '1',
    kind: 'structured',
    schema,
    maxRepairs,
    config: {
      schema: z.toJSONSchema(schema) as JsonValue,
      validate: nameOf(opts.validate),
      maxRepairs,
    },
    tools: [submit],
    async validate(candidate, ctx) {
      if (candidate.output === undefined) {
        return {
          ok: false,
          issues: ['没有调用 submit 提交结果'],
          hint: '调用 submit 提交符合 schema 的结果',
        }
      }
      return opts.validate ? opts.validate(candidate.output as T, ctx) : { ok: true }
    },
  }
}
