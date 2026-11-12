// 完成审查（设计 §10.6）：先做确定性的风险打分，≥ 3 分才调用模型；模型判定未完成、置信度 ≥ 0.5
// 并列出未完成项，才算不通过。验收只给出问题和提示，不改写交付内容。
// 委托人联系不上时，回答里向委托人提问的交付也要审查：没有人会回答，这样的"完成"是假完成。
// 回答只预告动作（"我先查一下"）就结束的，同样是假完成。createEngine 默认带上这项验收。

import { canonicalJson } from '../../sdk.js'
import type { Candidate, Check, CheckMode, Corpus, ModelRef } from '../../sdk.js'
import { PLAN_PROGRESS } from '../capabilities/planning.js'

const RISK_THRESHOLD = 3
const MIN_CONFIDENCE = 0.5
const MAX_FIELD_CHARS = 3000

/**
 * 要求执行操作。预订只认具体的说法（预订、订购、订票、下单，或"订"后不远处跟着票、酒店、房间），
 * 不认修订、制订、订单一类；英文 order 不认 "in order to"、"order of"。
 */
const ACTION_REQUEST =
  /(写入|创建|新建|删除|修改|发送|提交|保存|执行|运行|部署|更新|上传|预订|订购|订票|订酒店|订机票|下单|(?<![修校审制签装])订(?!单)[^，。！？,.!?\n]{0,8}?(?:票|酒店|房间)|预约|购买|支付|转账|取消|\b(?:write|create|delete|update|send|submit|save|run|execute|deploy|upload|book|buy|pay|purchase|cancel|reserve)\b|(?<!\bin\s)\border\b(?!\s+of\b))/i
/**
 * 要求查找信息：查 / 查询 / 查找 / 搜索 / 检索 / 核实一类，不认检查、审查、调查；英文 look up、search、
 * find、fetch。没调用任何工具就作答，要么是凭空给出，要么是只说了要去查。
 */
const LOOKUP_REQUEST =
  /((?<![检审调排])查(?!重)|搜索|搜一下|检索|核实|核对|\b(?:look up|search|find|fetch)\b)/i
/**
 * 回答在预告动作而不是给出结果：我先 / 我来 / 让我 / 稍等 / 接下来…后面不远处跟着查、找、调用一类的动词；
 * 英文 let me / I'll / I will / I'm going to 后面三个词以内跟着 check、look、search 一类的动词。
 * 只看回答结尾一段：开头的"让我总结一下"后面跟着完整答案的，不算。
 */
const ANNOUNCE =
  /((?:我(?:先|来|去|马上|立即|立刻|这就|现在|接下来|将|会)|让我|稍等|请稍候|请稍等|接下来|下一步)[^。！？!?\n]{0,10}?(?:查|搜|找|看|调用|获取|读取|打开|执行|运行|写|生成|下单|预订|订|发送|提交|计算|确认|核实|尝试)|\b(?:let me|i'll|i will|i am going to|i'm going to)\s+(?:\w+\s+){0,3}?(?:check|look|search|find|fetch|get|run|call|query|book|order|create|write|open|try|pull|retrieve)\b)/i
const ANNOUNCE_TAIL_CHARS = 40
/** 只读的提问：问号或"吗"结尾、或以疑问词开头，且没有"帮我""请""please"一类的请求。 */
const QUESTION =
  /([?？]\s*$|吗\s*$|^\s*(?:怎么|怎样|如何|为什么|是否|(?:how|what|why|when|where|which|who|is|are|does|do|should)\b))/i
const REQUEST_MARKER =
  /(帮我|替我|给我|请(?!问)|麻烦|\b(?:please|help me|can you|could you|would you)\b)/i
const WRITE_CLAIM =
  /(已(?:经)?(?:写入|保存|创建|发送|提交|更新|删除|上传|部署|办理|退款|支付|转账|下单|取消|修改)|\b(?:saved|written|created|sent|submitted|updated|deleted|uploaded|deployed)\b)/i
const ALL_DONE_CLAIM =
  /(全部完成|都已完成|已全部完成|均已完成|\ball (?:tasks |steps |items )?(?:are )?(?:done|completed|finished)\b)/i
const LIST_ITEM = /^\s*(?:\d+[.、)）]|[-*•])\s*\S/
/**
 * 回答在向委托人要信息：问句，或请对方提供 / 告知 / 确认。全角问号都算；半角问号只认句末
 * （后面是空白、结尾或右引号、右括号），不认 URL 里的 `?`。
 */
const ASKS_PRINCIPAL = /？|\?(?=[\s"'”’)）\]】]|$)|请(?:提供|告诉|告知|确认|补充)|告诉我/
const ANNOUNCE_HINT = '要做的事直接调用工具去做，不要只说明打算。'
const UNREACHABLE_HINT =
  '委托人联系不上，不会回答提问：能基于已有信息完成就直接给出结果；缺少关键信息无法继续时，用 report_blocked 说明缺什么。'

const SYSTEM = [
  '你在审查一次交付是否真正完成了任务。',
  '根据任务、交付内容、调用过的工具和计划，判断还有哪些要求没有完成。',
  '委托人联系不上时（principalReachable 为 false），回答里向委托人提问、要等对方补充信息才能继续的，算没有完成。',
  '回答只是在预告要做的事（例如"我先查一下"）而没有给出结果的，算没有完成。',
  '回答里声称已经执行、提交或办理的操作，在 executed（本轮和之前各轮实际执行过的操作）里找不到的，算没有完成；missing 里写明哪项声称不实。',
  '只回答一个 JSON 对象：{"complete": 布尔值, "confidence": 0 到 1 的数, "missing": 未完成事项的字符串数组}。',
].join('\n')

type Source = Corpus['sources'][number]

const inputOf = (corpus: Corpus) =>
  corpus.sources
    .filter((s) => s.origin === 'input')
    .map((s) => s.text)
    .join('\n')
const toolsOf = (corpus: Corpus): Source[] => corpus.sources.filter((s) => s.origin === 'tool')
/** 实际执行过的操作：本轮成功的有副作用调用，加上会话之前各轮的台账。 */
const executedOf = (corpus: Corpus): Source[] =>
  corpus.sources.filter(
    (s) =>
      s.origin === 'ledger' ||
      (s.origin === 'tool' &&
        (s.effect === 'idempotent' || s.effect === 'side_effect') &&
        s.isError !== true),
  )
const lastPlan = (tools: readonly Source[]) =>
  [...tools].reverse().find((t) => t.toolName === 'update_plan')?.text

/** 交付的回答：正文；结构化交付没有正文时是提交的结果（审查只看正文会把它当成"回答为空"）。 */
const answerOf = (candidate: Candidate): string =>
  (candidate.text ?? '').trim() === '' && candidate.output !== undefined
    ? canonicalJson(candidate.output)
    : (candidate.text ?? '')
const announces = (text: string): boolean =>
  ANNOUNCE.test([...text.trim()].slice(-ANNOUNCE_TAIL_CHARS).join(''))

/** 风险打分（设计 §10.6）。 */
export function riskScore(
  candidate: Candidate,
  corpus: Corpus,
  opts: { principalReachable?: boolean } = {},
): number {
  const input = inputOf(corpus)
  const tools = toolsOf(corpus)
  const text = answerOf(candidate)
  let score = 0
  const readOnlyQuestion = QUESTION.test(input) && !REQUEST_MARKER.test(input)
  const requested = ACTION_REQUEST.test(input) || LOOKUP_REQUEST.test(input)
  if (requested && !readOnlyQuestion && tools.length === 0) score += 5
  if (announces(text)) score += 5
  // 声称做过某事而本轮没有副作用调用：交给审查模型对照台账（之前各轮做过什么）判断，台账里有别的操作
  // 不能替这句话作证。
  const sideEffects = executedOf(corpus).filter((s) => s.origin === 'tool')
  if (WRITE_CLAIM.test(text) && sideEffects.length === 0) score += 4
  const items = input.split('\n').filter((line) => LIST_ITEM.test(line)).length
  if (items >= 3 && tools.length < items) score += 3
  if ([...input].length > 100 && [...text].length < 50) score += 2
  if (ALL_DONE_CLAIM.test(text) && candidate.step >= 5) score += 4
  const progress = PLAN_PROGRESS.exec(lastPlan(tools) ?? '')
  if (progress && Number(progress[1]) < Number(progress[2])) score += 3
  if (opts.principalReachable === false && ASKS_PRINCIPAL.test(text)) score += 3
  return score
}

/** 取回答中第一个 `{` 到最后一个 `}` 之间的 JSON 对象；不是对象时返回 undefined。 */
function parseVerdict(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1))
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export function completionReview(
  opts: { model?: ModelRef; mode?: CheckMode; maxAttempts?: number } = {},
): Check {
  return {
    id: 'completion',
    version: '5',
    mode: opts.mode ?? 'gate',
    maxAttempts: opts.maxAttempts ?? 2,
    config: { model: opts.model ?? null },
    start: (run, ctx) => ({
      async accept(candidate, corpus) {
        const reachable = run.environment.principalReachable
        if (riskScore(candidate, corpus, { principalReachable: reachable }) < RISK_THRESHOLD) {
          return { pass: true }
        }
        const tools = toolsOf(corpus)
        const plan = lastPlan(tools)
        let reply: string | undefined
        try {
          const response = await ctx.callModel({
            purpose: 'check:completion',
            system: SYSTEM,
            messages: [
              {
                role: 'user',
                content: canonicalJson({
                  task: inputOf(corpus).slice(0, MAX_FIELD_CHARS),
                  answer: answerOf(candidate).slice(0, MAX_FIELD_CHARS),
                  tools: tools.map((t) => t.toolName ?? 'tool'),
                  executed: executedOf(corpus).map((s) =>
                    s.origin === 'ledger' ? s.text : `本轮已执行 ${s.toolName ?? 'tool'}`,
                  ),
                  ...(plan !== undefined ? { plan } : {}),
                  ...(reachable ? {} : { principalReachable: false }),
                }),
              },
            ],
            maxOutputTokens: 512,
            ...(opts.model ? { model: opts.model } : {}),
          })
          reply = response?.text
        } catch (error) {
          ctx.log('warn', '完成审查调用失败', { error: String(error) })
        }
        const verdict = reply === undefined ? undefined : parseVerdict(reply)
        const missing = Array.isArray(verdict?.missing)
          ? verdict.missing.filter((m): m is string => typeof m === 'string' && m.length > 0)
          : []
        const confident =
          typeof verdict?.confidence === 'number' && verdict.confidence >= MIN_CONFIDENCE
        if (verdict?.complete !== false || !confident || missing.length === 0) return { pass: true }
        const toolHint = tools.length === 0 ? '\n缺少需要的工具时，先用 search_tool 查找。' : ''
        const announceHint = announces(answerOf(candidate)) ? `\n${ANNOUNCE_HINT}` : ''
        const reachHint = reachable ? '' : `\n${UNREACHABLE_HINT}`
        return {
          pass: false,
          issues: missing,
          hint: `以下事项还没有完成：\n${missing.map((m) => `- ${m}`).join('\n')}${toolHint}${announceHint}${reachHint}`,
        }
      },
    }),
  }
}
