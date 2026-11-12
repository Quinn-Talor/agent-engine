# 示例：聊天端点

把会话每一轮的运行转成 AI SDK 的 UI message stream，前端用 `useChat` 直接接上；页面刷新或断网后从运行日志续上。场景是律所的文书助理：用户让它发律师函，发函要委托人审批。

## 运行

需要 Node.js 22.18 及以上（直接执行 TypeScript）。

```bash
npm run build && node examples/chat-endpoint/main.ts
```

另开一个终端发起一轮：

```bash
curl -N -X POST localhost:3000/api/chat -H 'content-type: application/json' -d '{"id":"c1","messages":[{"id":"u1","role":"user","parts":[{"type":"text","text":"给星河科技发律师函"}]}]}'
```

场景测试（不联网）：

```bash
npx vitest run examples/chat-endpoint
```

演示用一个脚本化的模型（[clerk-model.ts](clerk-model.ts)），只看请求里的对话做决定，所以审批、续流都会真实发生。

## 端点

| 端点                                      | 做什么                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `POST /api/chat`，正文 `{ id, messages }` | 用会话 `id` 开一轮，返回这一轮的 UI message stream。最后一条消息是带审批答复的助手消息时，先记下答复再开下一轮         |
| `GET /api/chat/:id/stream`                | 续流：这一轮还在跑时返回流，否则 204。不带 `Last-Event-ID` 时从头回放（`useChat` 的 `resume`）；带上时从下一条事件续上 |

处理函数是 `Request → Response`（[chat.ts](chat.ts)），可以直接挂到 Next.js 路由、Hono 等；[main.ts](main.ts) 用 `node:http` 包了一层。浏览器断开只解除订阅，运行照常跑完。要让用户停止生成，另给一个端点调用 `run.abort()`。

## 前端

```tsx
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai'
import type { RunUIMessage } from '@talor/agent-engine/adapters/ai-sdk'

const { messages, sendMessage, addToolApprovalResponse } = useChat<RunUIMessage>({
  id: chatId,
  resume: true,
  transport: new DefaultChatTransport({ api: '/api/chat' }),
  // 委托人答复审批后自动发起下一次请求。
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
})
```

- 文字与推理是 `text`、`reasoning` 部件，引擎的每一步是一个 `step-start`。
- 工具调用是 `tool-<工具名>` 部件。审批人稍后答复时部件停在 `approval-requested`，按钮里调用 `addToolApprovalResponse({ id: part.approval.id, approved })`。下一轮里模型重新发起这次调用，执行结果出现在新的工具部件上，答复过的那个部件停在 `approval-responded`。
- 运行的结局在 `message.metadata`：`status`、`code`、`intent`（例如 `ask_user` 的问题）、`output`、`error`。
- 工具进度是瞬时的 `data-tool-progress`，在 `onData` 里收到，不进消息。
- 流里会出现 `reset-step`（预览与日志对不上、草稿被退回时整步重发），前端的 `ai` 要认识这个片段；7.0.164 已验证。

## 换成真实模型

```ts
import { anthropic } from '@ai-sdk/anthropic'
import { aiSdkProvider } from '@talor/agent-engine/adapters/ai-sdk'

const provider = aiSdkProvider({
  id: 'firm',
  models: {
    clerk: {
      model: anthropic('claude-sonnet-5-5'),
      vendor: 'anthropic',
      capabilities: { contextLimit: 200_000 },
    },
  },
})
const app = createChatApp({ providers: [provider], model: 'firm:clerk' })
```

需要另外安装 `ai` 和厂商包。
