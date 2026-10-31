// eslint.config.js — ESLint flat config
//
// 分段：
//   1. 基础：@eslint/js + typescript-eslint recommended（非 type-checked，类型由 tsc 保证）
//   2. 测试文件放宽
//   3. 依赖方向：每层只能 import 落地方案第 4 节依赖表允许的目标
//   4. Prettier：关闭所有与格式冲突的规则（放最后）

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

// ── 依赖方向 ────────────────────────────────────────────────────────
// 拒绝项分两类：structural（层与入口，测试文件同样生效）与 external（node 内置与外部包，测试文件放开）。
// 测试文件可以使用公开测试工具 testing/：它只依赖公开 API，不形成生产代码的耦合。

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const layer = (name) => ({ regex: `(^|/)${name}/`, message: `不得依赖 ${name}/` })
// 只匹配相对路径：外部包里以 index.js / api.js 结尾的子路径（如 @modelcontextprotocol/sdk/client/index.js）不受限。
const API = { regex: '^(\\.{1,2}/)+api\\.js$', message: '不得依赖 api.ts' }
const INDEX = { regex: '^(\\.{1,2}/)+index\\.js$', message: '不得依赖包入口 index.ts' }
const nodeBuiltins = (allowed = []) => ({
  regex: allowed.length ? `^node:(?!(${allowed.map(escape).join('|')})$)` : '^node:',
  message: allowed.length ? `node 内置模块只允许 ${allowed.join('、')}` : '不得依赖 node 内置模块',
})
const packages = (allowed) => ({
  regex: `^(?![./]|node:)(?!(${allowed.map(escape).join('|')})(/|$))`,
  message: `外部包只允许 ${allowed.join('、')}`,
})
const layers = (...names) => names.map(layer)

const ADAPTER_PACKAGES = {
  'ai-sdk': ['ai'],
  sqlite: ['better-sqlite3'],
  'mcp-stdio': ['@modelcontextprotocol/sdk'],
  'mcp-http': ['@modelcontextprotocol/sdk'],
  'hook-process': [],
  'console-logger': [],
}

const LAYER_RULES = [
  {
    files: ['src/contracts/**/*.ts'],
    structural: [
      ...layers('core', 'executor', 'services', 'engine', 'stdlib', 'adapters', 'testing'),
      API,
      INDEX,
    ],
    external: [nodeBuiltins(), packages(['zod'])],
  },
  {
    files: ['src/core/**/*.ts'],
    structural: [
      ...layers('executor', 'services', 'engine', 'stdlib', 'adapters', 'testing'),
      API,
      INDEX,
    ],
    external: [nodeBuiltins(['crypto']), packages(['zod'])],
  },
  {
    files: ['src/executor/**/*.ts'],
    structural: [...layers('services', 'engine', 'stdlib', 'adapters', 'testing'), API, INDEX],
    external: [nodeBuiltins(), packages(['zod'])],
  },
  {
    files: ['src/services/**/*.ts'],
    structural: [...layers('executor', 'engine', 'stdlib', 'adapters', 'testing'), API, INDEX],
    external: [nodeBuiltins(), packages(['zod'])],
  },
  {
    files: ['src/engine/**/*.ts'],
    structural: [...layers('stdlib', 'adapters', 'testing'), API, INDEX],
    external: [nodeBuiltins(), packages(['zod'])],
  },
  {
    files: ['src/stdlib/**/*.ts'],
    structural: [...layers('core', 'executor', 'services', 'engine', 'adapters', 'testing'), INDEX],
    external: [packages(['zod'])],
  },
  {
    files: ['src/testing/**/*.ts'],
    structural: [...layers('core', 'executor', 'services', 'engine', 'stdlib', 'adapters'), INDEX],
    external: [packages(['zod'])],
  },
  {
    files: ['src/adapters/*.ts'],
    structural: [...layers('core', 'executor', 'services', 'engine', 'stdlib', 'testing'), INDEX],
    external: [packages([])],
  },
  ...Object.entries(ADAPTER_PACKAGES).map(([name, allowed]) => ({
    files: [`src/adapters/${name}/**/*.ts`],
    structural: [...layers('core', 'executor', 'services', 'engine', 'stdlib', 'testing'), INDEX],
    external: [packages(allowed)],
  })),
  {
    // 公开 API 导出平台服务的工厂（modelHub、mcpHost、sqliteArchive 等，设计 §12.2）。
    files: ['src/api.ts'],
    structural: [...layers('executor', 'stdlib', 'adapters', 'testing'), INDEX],
    external: [nodeBuiltins(), packages(['zod'])],
  },
]

const restrict = (patterns) => ({ 'no-restricted-imports': ['error', { patterns }] })

const boundaryConfigs = LAYER_RULES.flatMap(({ files, structural, external }) => [
  { files, ignores: ['**/*.test.ts'], rules: restrict([...structural, ...external]) },
  {
    files: files.map((f) => f.replace(/\.ts$/, '.test.ts')),
    rules: restrict(structural.filter((p) => p.regex !== layer('testing').regex)),
  },
])

export default tseslint.config(
  // ── 忽略 ──────────────────────────────────────────────────────────
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'vibe/**', 'docs/**'],
  },

  // ── 基础 TS 规则 ──────────────────────────────────────────────────
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── 全局 language options ─────────────────────────────────────────
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // 允许 `_` 开头的未使用变量
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // 边界处用 `unknown` + 手动收窄，保留 any 的告警
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-throw-literal': 'error',
      // 只允许带描述的 ts-expect-error
      '@typescript-eslint/ban-ts-comment': [
        'warn',
        { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true },
      ],
    },
  },

  // ── 测试文件放宽 ──────────────────────────────────────────────────
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // ── 依赖方向 ──────────────────────────────────────────────────────
  ...boundaryConfigs,

  // ── Prettier（放最后，关闭格式冲突规则） ──────────────────────────
  prettier,
)
