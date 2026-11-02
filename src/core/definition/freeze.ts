// 不可变（设计 §1.1、I14）：业务对象创建时复制一份再冻结，之后改动传入的原对象不影响运行；
// 日志事件写入前冻结，订阅者改不了（设计 §4.4）。只处理纯对象和数组，函数、二进制数据和类实例原样保留。

const isPlain = (v: unknown): v is Record<string, unknown> | unknown[] => {
  if (Array.isArray(v)) return true
  if (typeof v !== 'object' || v === null) return false
  const proto = Object.getPrototypeOf(v) as unknown
  return proto === Object.prototype || proto === null
}

/** 逐层冻结纯对象与数组，返回同一引用。 */
export function freezeData<T>(value: T, seen = new WeakSet<object>()): T {
  if (!isPlain(value) || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) freezeData(child, seen)
  return Object.freeze(value)
}

/** 逐层复制纯对象与数组；其他值保留原引用。 */
export function copyData<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v: unknown) => copyData(v)) as T
  if (!isPlain(value)) return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyData(v)])) as T
}

/** 复制一份数据并冻结。 */
export const frozenCopy = <T>(value: T): T => freezeData(copyData(value))

/**
 * 组件列表：复制一层再冻结，组件对象本身不冻结（它们可能在实例上保存状态）。
 * 契约字段声明为可变数组，这里只在运行时冻结，所以返回类型保持 `T[]`。
 */
export function freezeList<T>(list: T[]): T[]
export function freezeList<T>(list: T[] | undefined): T[] | undefined
export function freezeList<T>(list: T[] | undefined): T[] | undefined {
  return list === undefined ? undefined : (Object.freeze([...list]) as T[])
}
