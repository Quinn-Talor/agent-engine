// 起一个本地 HTTP 服务：npm run build && node examples/chat-endpoint/main.ts
// node:http 的请求转成 Request、Response 写回；浏览器断开时取消读取，运行照常跑完，之后可以续流。

import { createServer } from 'node:http'
import { createChatApp } from './chat.ts'
import { clerkModel } from './clerk-model.ts'

const model = clerkModel()
const app = createChatApp({ providers: [model], model: model.ref })
const port = Number(process.env.PORT ?? 3000)

createServer(async (req, res) => {
  const body: Buffer[] = []
  for await (const chunk of req) body.push(chunk as Buffer)
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  const response = await app.handle(
    new Request(`http://localhost:${port}${req.url}`, {
      method: req.method ?? 'GET',
      headers,
      ...(body.length > 0 ? { body: Buffer.concat(body) } : {}),
    }),
  )
  res.writeHead(response.status, Object.fromEntries(response.headers))
  if (!response.body) return void res.end()
  const reader = response.body.getReader()
  res.on('close', () => void reader.cancel())
  for (let r = await reader.read(); !r.done; r = await reader.read()) res.write(r.value)
  res.end()
}).listen(port, () => console.log(`POST http://localhost:${port}/api/chat`))
