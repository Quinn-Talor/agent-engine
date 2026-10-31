import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ToolDef } from '../contracts/tool.js'
import { prepareTool, toModelTool } from './tools.js'

const def = (inputSchema: ToolDef['inputSchema'], patch: Partial<ToolDef> = {}): ToolDef => ({
  name: 'search',
  description: 'search the web',
  inputSchema,
  execute: async () => 'ok',
  ...patch,
})

describe('prepareTool', () => {
  it('AC-001 accepts a zod schema', () => {
    const tool = prepareTool(def(z.object({ q: z.string() })), 'web')
    expect(tool.schema.safeParse({ q: 'x' }).success).toBe(true)
    expect(tool.schema.safeParse({}).success).toBe(false)
    expect(tool.jsonSchema).toMatchObject({ type: 'object', required: ['q'] })
    expect(tool.capability).toBe('web')
  })

  it('AC-001 compiles a JSON schema', () => {
    const json = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
    const tool = prepareTool(def(json), 'web')
    expect(tool.schema.safeParse({ q: 'x' }).success).toBe(true)
    expect(tool.schema.safeParse({ q: 1 }).success).toBe(false)
    expect(tool.jsonSchema).toBe(json)
  })

  it('AC-001 rejects a schema that cannot be compiled', () => {
    expect(() => prepareTool(def({ type: 'nope' }), 'web')).toThrow('search 的 schema 不能编译')
  })

  it('defaults effect to side_effect and the invalid input code to INVALID_INPUT', () => {
    const tool = prepareTool(def(z.object({})), 'web')
    expect(tool.effect).toBe('side_effect')
    expect(tool.invalidInputCode).toBe('INVALID_INPUT')
    expect(tool.available).toBeUndefined()
  })

  it('honours the declared effect and preparation options', () => {
    const available = () => true
    const tool = prepareTool(def(z.object({}), { execution: { effect: 'none' } }), 'out', {
      invalidInputCode: 'OUTPUT_INVALID',
      available,
    })
    expect(tool.effect).toBe('none')
    expect(tool.invalidInputCode).toBe('OUTPUT_INVALID')
    expect(tool.available).toBe(available)
  })

  it('converts to the model tool spec', () => {
    const tool = prepareTool(def(z.object({ q: z.string() })), 'web')
    expect(toModelTool(tool)).toEqual({
      name: 'search',
      description: 'search the web',
      inputSchema: tool.jsonSchema,
    })
  })
})
