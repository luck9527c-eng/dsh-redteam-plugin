/**
 * 运行期收窄小工具。
 *
 * 这些函数把「JS 里本来就在做的 `typeof x === 'object'` 判断」变成 TypeScript 认识的
 * **类型谓词**，从而在 `strict` 下读 `x.field` 时不必写 `any`，也不必到处 `as`。
 * 每个函数的行为都与它取代的那行判断**逐字等价**。
 */

/** 非 null 且非数组的对象（JSON 记录的本体形状）。 */
export type AnyRecord = Record<string, unknown>

/** 是否是「普通记录」：`typeof === 'object'` 且非 null。数组也算对象，但按记录读字段通常会错。 */
export function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null
}

/**
 * 读一个记录的字段；不是记录就给 `{}`。
 *
 * 等价于 `value && typeof value === 'object' ? value : {}` 的既有写法，
 * 只是返回值带上索引签名，后续 `view.field` 读到的类型是 `unknown` 而不是编译错误。
 */
export function recordOf(value: unknown): AnyRecord {
  return isRecord(value) ? value : {}
}

/**
 * 读一个**可选**宿主服务：先按属性直读，抛错再走 `ctx.get(name)`（LDW-20）。
 *
 * 为什么两种读法都要：宿主 ctx 是 Proxy，读一个没写进插件 `inject` 的服务时**直接抛**
 * `cannot get property "x" without inject`（`cordis/src/reflect.ts` 的 get trap）；
 * 而 `ctx.get(name)` 走 `reflect.get(name, strict)`，**不经 inject 也能读**（同一处注释的原话：
 * "Read a service from the store without the inject requirement"）。
 *
 * 20:21–23:53 那一轮就是只写了直读、又把这次抛错当成「服务缺席」：Lead 人设没装上、工兵遮罩
 * 扫不到人，两处各只留一条 warn，而 511 个测试全绿 —— 替身比宿主宽容，谁也没发现。所以这里
 * 把「读法不对」和「真的没有」分开：抛错换一种读法，两种都拿不到才算没有。
 *
 * 返回 `undefined` 表示**两种读法都拿不到**；调用方照旧 fail-open（不放宽任何闸）。
 *
 * @param ctx 本插件或 agent 的 ctx（真实 Cordis ctx 或替身都行）
 * @param name 服务名（`systemPrompt` / `agents` / `agentTeams`）
 */
export function serviceOf(ctx: unknown, name: string): unknown {
  const view = recordOf(ctx)
  try {
    const direct = view[name]
    if (direct !== undefined && direct !== null) return direct
  } catch {
    // 未 inject 的直读会抛：换 `ctx.get` 再试，别把「读法不对」当成「服务缺席」。
  }
  try {
    const get = typeof view.get === 'function' ? view.get.bind(view) : undefined
    return get === undefined ? undefined : get(name)
  } catch {
    return undefined
  }
}

/**
 * 把任意抛出物压成一句文本。
 *
 * 等价于各模块迁移前的写法 `error?.message ?? String(error)`：只要抛出物是对象且带
 * **非 null/undefined** 的 `message`，就用它的字符串形式；否则 `String(thrown)`。
 * （抛出物不一定真是 `Error` —— 宿主/脚本可能抛带 `message` 的普通对象。）
 */
export function thrownMessage(thrown: unknown): string {
  if (isRecord(thrown) && 'message' in thrown) {
    const message = thrown.message
    if (message !== undefined && message !== null) return String(message)
  }
  return String(thrown)
}

/**
 * 读抛出物上的 `code`（Node 的 `ENOENT`/`EACCES`、宿主的 `TEAM_*` 都在这里）。
 *
 * 等价于迁移前的 `error?.code`，只是把「不是字符串就当没有」写清楚。
 */
export function thrownCode(thrown: unknown): string | null {
  if (isRecord(thrown) && 'code' in thrown) {
    const code = thrown.code
    return typeof code === 'string' ? code : null
  }
  return null
}
