// 宿主 `tools.schemas(scope)` 的返回值 → 完整工具名集合（纯函数）。
//
// LDW-23：原先这一套住在 `capability.ts`（能力族匹配，服务 `rt_dispatch` 的能力核对）。
// 派发工具删除后只有这一个函数还有消费者 —— 角色闸的遮罩拿它做「拿不到可遮名单时的退路」
// （`gate.ts` 的 `restrictableNamesOf`）。剩下的能力族体系随工具一起删除。
import { isRecord } from './guards.js'

/** 非空字符串判定（只在本文件用）。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * 从一个条目里读工具名：`{name}`（宿主 schema 的真实形状）或 `{function:{name}}` 变体。
 * 认不出来 → null（调用方丢弃这一项；字符串元素不算条目）。
 */
function toolNameOfEntry(entry: unknown): string | null {
  if (!isRecord(entry) || Array.isArray(entry)) return null
  if (isNonEmptyString(entry.name)) return entry.name
  const fn = entry.function
  if (isRecord(fn) && !Array.isArray(fn) && isNonEmptyString(fn.name)) return fn.name
  return null
}

/** 去重 + 排序，作为 {@link toolNamesFromSchemas} 的稳定输出。 */
function sortedNames(candidates: readonly (string | null)[]): string[] {
  const names = new Set<string>()
  for (const candidate of candidates) {
    if (candidate !== null) names.add(candidate)
  }
  return [...names].sort()
}

/**
 * 是否实现了迭代协议（`Set`/generator/自定义可迭代）。
 *
 * 用 `Reflect.get` 读 `Symbol.iterator`：`Record<string, unknown>` 没有符号索引签名，
 * 直接 `value[Symbol.iterator]` 在 strict 下读不出来。
 */
function isIterable(value: unknown): value is Iterable<unknown> {
  return isRecord(value) && typeof Reflect.get(value, Symbol.iterator) === 'function'
}

/**
 * `tools.schemas(scope)` 的返回值 → 完整工具名集合（去重、排序）。
 *
 * 宿主真实形状是**schema 对象数组**（`_dsh-tools.js` 的 `schemas(scope)` 对每个可见定义
 * 调 `schemaOf()`，名字在元素的 `.name` 上）。旧实现对这个返回值做 `Object.keys()`，
 * 数组上只会得到 `["0","1",…]`，于是「可遮名单」永远为空、遮罩整块不落地（T15 的真会话事故）。
 * 因此规则是「先按条目取名字，再谈容器」：
 *
 * 1. 值本身就是一个条目（`{name}` / `{function:{name}}`，即单个 schema）→ 单个名字；
 * 2. 数组 → 逐个元素取 `.name`（**绝不** `Object.keys` 数组）；
 * 3. 任意可迭代（`Set`/generator…）→ 逐项取 `.name`；
 * 4. 按名字为键的对象（测试替身与旧形状）→ 键；
 * 5. 其余（null/数字/字符串/没有名字的条目）→ 空集：保持「未核对」降级语义，**不抛**。
 *
 * @param schemas `tools.schemas(scope)` 的原始返回值（未知形状）
 * @returns 去重并排序的完整工具名
 */
export function toolNamesFromSchemas(schemas: unknown): string[] {
  const direct = toolNameOfEntry(schemas)
  if (direct !== null) return [direct]
  if (Array.isArray(schemas)) return sortedNames(schemas.map((entry) => toolNameOfEntry(entry)))
  if (isIterable(schemas)) return sortedNames([...schemas].map((entry) => toolNameOfEntry(entry)))
  if (isRecord(schemas)) return sortedNames(Object.keys(schemas))
  return []
}
