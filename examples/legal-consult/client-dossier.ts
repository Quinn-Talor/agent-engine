// 自定义能力：客户档案。一个能力可以同时带来工具、能力说明和自己的守卫：
// - read_dossier：读结构化档案；read_client_file：读客户工作区里的材料（声明访问路径，交给沙箱判断）；
// - 能力说明：告诉模型这位客户是谁；
// - 守卫：运行中档案被改了，就停止运行（code stale_dossier），免得按旧事实出意见。

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { Capability, Guard, ToolDef } from 'agent-engine'
import type { DossierStore } from './domain.ts'

export function clientDossier(store: DossierStore): Capability {
  return {
    id: 'client-dossier',
    version: '1',
    kind: 'client-dossier',
    async prepare(ctx) {
      const clientId = ctx.run.task.context?.clientId
      const dossier = typeof clientId === 'string' ? store.get(clientId) : undefined
      // 没有建档的散客：不提供档案工具，模型需要向委托人询问事实。
      if (typeof clientId !== 'string' || !dossier) {
        return { tools: [], snapshot: { fingerprint: 'no-dossier' } }
      }
      const readDossier: ToolDef = {
        name: 'read_dossier',
        description: '读取客户档案：雇主、入职日期、月工资、欠薪月数。',
        inputSchema: z.object({}),
        execution: { effect: 'none' },
        async execute() {
          const d = store.get(clientId)
          if (!d) return '档案不存在'
          return `客户 ${d.name}，雇主 ${d.employer}，入职时间 ${d.hiredAt}，月薪 ${d.monthlySalary} 元，已欠 ${d.unpaidMonths} 个月工资。`
        },
      }
      const readClientFile: ToolDef = {
        name: 'read_client_file',
        description: '读取客户工作区里的材料，路径相对于工作区。',
        inputSchema: z.object({ path: z.string() }),
        execution: { effect: 'none' },
        // 声明要读的路径：工作区沙箱据此放行、询问或拒绝（相对路径按任务的工作区解析）。
        safety: { access: (input) => ({ read: [(input as { path: string }).path] }) },
        async execute(input, toolCtx) {
          const workspace = toolCtx.scope.workspace ?? '.'
          return readFile(resolve(workspace, (input as { path: string }).path), 'utf8')
        },
      }
      return {
        tools: [readDossier, readClientFile],
        description: [
          {
            role: 'system',
            parts: [{ type: 'text', text: `本次咨询的客户档案编号 ${clientId}，事实以档案为准。` }],
          },
        ],
        guards: [staleDossierGuard(store, clientId, dossier.version)],
        exposure: 'eager',
        snapshot: { fingerprint: `${clientId}@v${dossier.version}` },
      }
    },
  }
}

/** 能力自带的守卫（来源 capability:client-dossier）：档案版本变了就停止，code 为 stale_dossier。 */
function staleDossierGuard(store: DossierStore, clientId: string, version: number): Guard {
  return {
    id: 'stale-dossier',
    version: '1',
    start: () => ({
      check: () =>
        store.version(clientId) === version
          ? undefined
          : { end: { as: 'stop', code: 'stale_dossier' }, detail: `档案 ${clientId} 已被修改` },
    }),
  }
}
