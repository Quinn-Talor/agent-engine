import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url))

export default defineConfig({
  // 示例按应用的写法 import 包名；测试时指向源码，不必先构建。
  resolve: {
    alias: [
      { find: /^@talor\/agent-engine$/, replacement: src('index.ts') },
      { find: /^@talor\/agent-engine\/sdk$/, replacement: src('sdk.ts') },
      { find: /^@talor\/agent-engine\/testing$/, replacement: src('testing.ts') },
      {
        find: /^@talor\/agent-engine\/adapters\/ai-sdk$/,
        replacement: src('adapters/ai-sdk/ai-sdk-provider.ts'),
      },
    ],
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'examples/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.fixture.ts'],
    },
  },
})
