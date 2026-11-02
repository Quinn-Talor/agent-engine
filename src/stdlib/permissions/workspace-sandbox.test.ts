import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ComponentCtx, RunInfo, ToolCallView } from '../../sdk.js'
import { runInfo } from '../capabilities/prepare.fixture.js'
import { BUILT_IN_SENSITIVE, workspaceSandbox } from './workspace-sandbox.js'

let root: string
let ws: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sandbox-')))
  ws = join(root, 'ws')
  await mkdir(join(ws, 'sub'), { recursive: true })
  await mkdir(join(root, 'ws-evil'), { recursive: true })
  await mkdir(join(root, 'outside'), { recursive: true })
  await writeFile(join(root, 'outside', 'file.txt'), 'x')
  await symlink(join(root, 'outside'), join(ws, 'link'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const call = (access?: ToolCallView['access']): ToolCallView => ({
  callId: 'c1',
  toolName: 'fs_tool',
  capability: 'core',
  input: {},
  ...(access ? { access } : {}),
  risk: 'low',
  effect: 'side_effect',
})
const run = (workspace?: string): RunInfo => ({
  ...runInfo(),
  task: workspace ? { scope: { workspace } } : {},
})

function setup(opts?: Parameters<typeof workspaceSandbox>[0]) {
  const records: string[] = []
  const ctx = {
    record: async <T>(name: string, fn: () => Promise<T>) => {
      records.push(name)
      return fn()
    },
  } as unknown as ComponentCtx
  const rule = workspaceSandbox(opts)
  return { rule, records, permit: (c: ToolCallView, r = run(ws)) => rule.permit(c, r, ctx) }
}

describe('workspaceSandbox', () => {
  it('AC-022 identifies itself', () => {
    expect(workspaceSandbox({ sensitive: ['/data/secret'] })).toMatchObject({
      id: 'workspace-sandbox',
      version: '1',
      config: { sensitive: ['/data/secret'], granted: null },
    })
    expect(BUILT_IN_SENSITIVE).toContain('~/.ssh')
  })

  it('F19 AC-010 keeps the built-in sensitive list immutable at runtime', async () => {
    const list = BUILT_IN_SENSITIVE as string[]
    expect(() => list.push('/tmp/not-sensitive')).toThrow(TypeError)
    expect(() => {
      list[0] = '/tmp/replaced'
    }).toThrow(TypeError)
    expect(BUILT_IN_SENSITIVE).toContain('~/.ssh')
    const { permit } = setup()
    expect(await permit(call({ read: ['~/.ssh/id_rsa'] }))).toEqual({
      deny: '敏感路径不可访问：~/.ssh/id_rsa',
    })
  })

  it('AC-012 allows calls that declare no paths', async () => {
    const { permit, records } = setup()
    expect(await permit(call())).toBe('allow')
    expect(await permit(call({ read: [], write: [], network: true }))).toBe('allow')
    expect(records).toEqual([])
  })

  it('AC-013 denies sensitive paths, including names and appended entries', async () => {
    const { permit } = setup({ sensitive: [join(root, 'secrets')] })
    expect(await permit(call({ read: ['~/.ssh/id_rsa'] }))).toEqual({
      deny: '敏感路径不可访问：~/.ssh/id_rsa',
    })
    expect(await permit(call({ read: ['.env'] }))).toEqual({ deny: '敏感路径不可访问：.env' })
    expect(await permit(call({ write: ['keys/server.pem'] }))).toMatchObject({
      deny: expect.any(String),
    })
    expect(await permit(call({ read: [join(root, 'secrets', 'a')] }))).toMatchObject({
      deny: expect.stringContaining('secrets'),
    })
    expect(await permit(call({ read: ['.env.example', 'sub/id_rsa.pub'] }))).toBe('allow')
  })

  it('AC-014 allows the workspace and asks for anything outside it', async () => {
    const { permit } = setup()
    expect(await permit(call({ read: ['sub/a.txt', join(ws, 'b.txt'), ws] }))).toBe('allow')
    expect(await permit(call({ read: [join(root, 'ws-evil', 'x')] }))).toEqual({
      ask: {
        summary: 'fs_tool 要访问工作区外的路径',
        risk: 'low',
        detail: { paths: [join(root, 'ws-evil', 'x')], reason: `不在工作区 ${ws} 内` },
      },
    })
    expect(await permit(call({ read: ['link/file.txt'] }))).toMatchObject({
      ask: { detail: { paths: [join(root, 'outside', 'file.txt')] } },
    })
  })

  it('AC-015 allows granted paths and asks with high risk for writes outside', async () => {
    const shared = join(root, 'shared')
    const { permit, records } = setup({ granted: async () => [shared] })
    expect(await permit(call({ read: [join(shared, 'a.csv')] }))).toBe('allow')
    expect(await permit(call({ write: [join(root, 'elsewhere', 'b')] }))).toMatchObject({
      ask: { risk: 'high', detail: { paths: [join(root, 'elsewhere', 'b')] } },
    })
    expect(records).toEqual(['realpath', 'granted', 'realpath', 'granted'])
  })

  it('follows a symlink before applying .., like the OS does', async () => {
    await mkdir(join(root, 'outside', 'inner'))
    await writeFile(join(root, 'outside', 'secret.txt'), 'x')
    await symlink(join(root, 'outside', 'inner'), join(ws, 'inner-link'))
    const { permit } = setup()
    expect(await permit(call({ read: ['inner-link/../secret.txt'] }))).toMatchObject({
      ask: { detail: { paths: [join(root, 'outside', 'secret.txt')] } },
    })
    expect(await permit(call({ read: ['sub/../sub/a.txt'] }))).toBe('allow')
  })

  it('follows a dangling symlink to where a write would land', async () => {
    await symlink(join(root, 'outside', 'new.txt'), join(ws, 'dangling'))
    const { permit } = setup()
    expect(await permit(call({ write: ['dangling'] }))).toMatchObject({
      ask: { risk: 'high', detail: { paths: [join(root, 'outside', 'new.txt')] } },
    })
  })

  it('matches sensitive and granted entries by their real paths', async () => {
    await mkdir(join(root, 'real', 'secrets'), { recursive: true })
    await symlink(join(root, 'real'), join(root, 'alias'))
    const { permit } = setup({
      sensitive: [join(root, 'alias', 'secrets')],
      granted: async () => [join(root, 'alias')],
    })
    expect(await permit(call({ read: [join(root, 'real', 'secrets', 'k')] }))).toMatchObject({
      deny: expect.any(String),
    })
    expect(await permit(call({ read: [join(root, 'alias', 'a.txt')] }))).toBe('allow')
    expect(await permit(call({ read: [join(root, 'real', 'a.txt')] }))).toBe('allow')
  })

  it('denies the added built-in credential locations', async () => {
    expect(BUILT_IN_SENSITIVE).toEqual(
      expect.arrayContaining([
        '~/.config/gh',
        '~/.azure',
        '/private/var/root',
        '/etc/master.passwd',
      ]),
    )
    const { permit } = setup()
    expect(await permit(call({ read: ['.envrc'] }))).toEqual({ deny: '敏感路径不可访问：.envrc' })
    expect(await permit(call({ read: ['~/.azure/accessTokens.json'] }))).toMatchObject({
      deny: expect.any(String),
    })
    expect(await permit(call({ read: ['~/.config/gh/hosts.yml'] }))).toMatchObject({
      deny: expect.any(String),
    })
    expect(await permit(call({ read: ['/etc/master.passwd'] }))).toMatchObject({
      deny: expect.any(String),
    })
  })

  it('treats every path as outside when the task has no workspace', async () => {
    const { permit } = setup()
    expect(await permit(call({ read: [join(root, 'outside', 'file.txt')] }), run())).toMatchObject({
      ask: { detail: { reason: '任务没有设置工作区' } },
    })
    expect(await permit(call({ read: ['~/.aws/credentials'] }), run())).toMatchObject({
      deny: expect.any(String),
    })
  })
})
