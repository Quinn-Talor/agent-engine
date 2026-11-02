// 工作区沙箱（设计 §11、方案 D6）：只对声明了 access 的调用生效。敏感路径直接拒绝（内置名单不可删除，
// 配置只能追加）；工作区内放行；工作区外先查授权，没授权就询问。路径分两个阶段解析：先按工作区得到字面路径，
// 再按操作系统的语义逐段取真实路径（先跟随符号链接，再应用 `..`）；敏感判断对两者都做，工作区判断只用真实路径，
// 符号链接逃不出去。敏感名单与授权范围也取真实路径后再比较（例如 macOS 的 /tmp → /private/tmp）。

import { readlink, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import type { PermissionRule, RunInfo } from '../../sdk.js'

/** 内置敏感名单（不可删除，运行时冻结，方案 D6）：凭据、密钥与账号目录。 */
export const BUILT_IN_SENSITIVE: readonly string[] = Object.freeze([
  '~/.ssh',
  '~/.gnupg',
  '~/.aws',
  '~/.kube',
  '~/.docker',
  '~/.netrc',
  '~/.npmrc',
  '~/.pypirc',
  '~/.git-credentials',
  '~/.config/gcloud',
  '~/.config/gh',
  '~/.azure',
  '~/Library/Keychains',
  '/etc/shadow',
  '/etc/master.passwd',
  '/etc/sudoers',
  '/etc/ssh',
  '/private/etc/shadow',
  '/private/etc/master.passwd',
  '/private/etc/sudoers',
  '/private/etc/ssh',
  '/root',
  '/var/root',
  '/private/var/root',
])

const SENSITIVE_NAMES: readonly RegExp[] = [
  /^\.env$/,
  /^\.envrc$/,
  /^\.env\.(?!example$|sample$|template$).+$/,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/,
  /\.(?:pem|key|p12|pfx)$/i,
]

/** macOS 默认文件系统大小写不敏感：比较前统一转小写。 */
const fold = (p: string) => (process.platform === 'darwin' ? p.toLowerCase() : p)

function within(path: string, root: string): boolean {
  const p = fold(path)
  const r = fold(root)
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep)
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

/** 跟随符号链接的最大层数，与常见系统的 SYMLOOP_MAX 一致。 */
const MAX_LINKS = 40

/**
 * 按操作系统的语义逐段解析未规范化的绝对路径：每一段先取 realpath（跟随符号链接），`..` 作用于已解析的父目录；
 * 悬空的符号链接按链接目标继续解析（写入会落在目标上）；不存在的部分按字面接上。
 */
async function realDeep(path: string, links = 0): Promise<string> {
  const { root } = parse(path)
  let current = root
  for (const segment of path.slice(root.length).split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      current = dirname(current)
      continue
    }
    const next = join(current, segment)
    try {
      current = await realpath(next)
    } catch {
      const target = links < MAX_LINKS ? await readlink(next).catch(() => undefined) : undefined
      current =
        target === undefined
          ? next
          : await realDeep(isAbsolute(target) ? target : current + sep + target, links + 1)
    }
  }
  return current
}

/** 按 base 得到未规范化的绝对路径，`..` 留给 realDeep 按操作系统的语义处理。 */
const rawPath = (base: string, p: string) => {
  const expanded = expandHome(p)
  return isAbsolute(expanded) ? expanded : base + sep + expanded
}

interface ResolvedPaths {
  workspace: string | null
  paths: Array<{ input: string; lexical: string; real: string; write: boolean }>
  /** 敏感名单的真实路径。 */
  sensitive: string[]
}

async function resolvePaths(
  workspace: string | undefined,
  read: readonly string[],
  write: readonly string[],
  sensitive: readonly string[],
): Promise<ResolvedPaths> {
  const base = workspace ? resolve(workspace) : homedir()
  const entries = [
    ...read.map((p) => ({ p, write: false })),
    ...write.map((p) => ({ p, write: true })),
  ]
  return {
    workspace: workspace ? await realDeep(resolve(workspace)) : null,
    paths: await Promise.all(
      entries.map(async ({ p, write: isWrite }) => ({
        input: p,
        lexical: resolve(base, expandHome(p)),
        real: await realDeep(rawPath(base, p)),
        write: isWrite,
      })),
    ),
    sensitive: await Promise.all(sensitive.map((r) => realDeep(r))),
  }
}

export function workspaceSandbox(
  opts: { sensitive?: string[]; granted?: (run: RunInfo) => Promise<readonly string[]> } = {},
): PermissionRule {
  const sensitive = opts.sensitive ?? []
  const roots = [...BUILT_IN_SENSITIVE, ...sensitive].map((r) => resolve(expandHome(r)))
  const isSensitive = (p: string, realRoots: readonly string[]) =>
    [...roots, ...realRoots].some((r) => within(p, r)) ||
    SENSITIVE_NAMES.some((re) => re.test(basename(p)))

  return {
    id: 'workspace-sandbox',
    version: '1',
    config: { sensitive, granted: opts.granted ? 'custom' : null },
    async permit(call, run, ctx) {
      const read = call.access?.read ?? []
      const write = call.access?.write ?? []
      if (read.length + write.length === 0) return 'allow'
      const workspace = run.task.scope?.workspace
      const resolved = await ctx.record('realpath', () =>
        resolvePaths(workspace, read, write, roots),
      )
      const grantedFn = opts.granted
      const granted = grantedFn
        ? await ctx.record('granted', async () =>
            Promise.all((await grantedFn(run)).map((g) => realDeep(resolve(expandHome(g))))),
          )
        : []

      const denied: string[] = []
      const outside: Array<{ real: string; write: boolean }> = []
      for (const p of resolved.paths) {
        if (isSensitive(p.lexical, resolved.sensitive) || isSensitive(p.real, resolved.sensitive))
          denied.push(p.input)
        else if (resolved.workspace && within(p.real, resolved.workspace)) continue
        else if (granted.some((g) => within(p.real, g))) continue
        else outside.push({ real: p.real, write: p.write })
      }
      if (denied.length > 0) return { deny: `敏感路径不可访问：${denied.join(', ')}` }
      if (outside.length > 0) {
        return {
          ask: {
            summary: `${call.toolName} 要访问工作区外的路径`,
            risk: outside.some((o) => o.write) ? 'high' : 'low',
            detail: {
              paths: outside.map((o) => o.real),
              reason: resolved.workspace
                ? `不在工作区 ${resolved.workspace} 内`
                : '任务没有设置工作区',
            },
          },
        }
      }
      return 'allow'
    },
  }
}
