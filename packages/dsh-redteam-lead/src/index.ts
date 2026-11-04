/**
 * `@local/dsh-redteam-lead` 的宿主插件入口。
 *
 * 这个包只做三件事，全部与「谁在什么位置上干活」有关：
 *
 * | 能力 | 实现 | 出口 |
 * |---|---|---|
 * | **角色闸**：会话根（Lead）不亲自调派发类工具，顺手把配置里的那几个名字从它的目录里摘掉 | `src/gate.ts` | `tools/pre-execute` 瀑布 + `tools.restrict` |
 * | **人设分离**：Lead 一份、工兵一份（工兵在自己 ctx 上盖同名段），文本全部来自本行配置 | `src/persona.ts` | `deployment:persona-prefix` |
 * | **工兵遮罩**：非 Lead 的团队成员看不到派发/建人入口 | `src/gate.ts` | `tools.restrict` |
 *
 * LDW-23：**本包原来的两个 `rt_*` 记账工具已删除**（按路线收口 / 只读核字节那对）。理由不是"不好用"，
 * 而是现场从来没调过它们：2026-11-02 那轮 3 小时 32 分的会话里 8 次封存全走
 * `reverse-project-management` skill 的 `project.py seal`，`rt_*` 调用数为 0 —— 同一件事有两套
 * 账本时，模型只会选文档更全的那套。留着它们既多一份要维护的契约（几千行校验器 + 一份 schema），
 * 又暗示"还有第二种记账方式"。**账目归 skill，本包只管位置。**
 *
 * 形状约束（E1 笔记 §C、DECISIONS D15/D17）：
 * - 只用具名导出：`name` / `inject` / `apply`（+ 本文件导出的纯函数接缝），没有 default export。
 * - `inject` 声明三项硬依赖：`agents` / `agentTeams` / `systemPrompt`（LDW-20：宿主 ctx 是 Proxy，
 *   读未注入的服务直接抛；缺服务宁可当场不激活，也不要"少装一半还照常启动"）。
 * - 本包**不注册任何工具**，所以不再需要 `tools` 注入；闸与遮罩用的 `restrict` 落在**别人的**
 *   agent ctx 上，走 `agent.ctx.tools`，与本插件的注入面无关。
 * - 现代码里**不 import 任何 `@deepseek-ai/*`**：本地 `link:` 的 bundle 按自身真实路径解析裸包名，
 *   这类 import 会 `ERR_MODULE_NOT_FOUND`，整行插件直接不激活。
 * - 三个安装器都**只降级、不抛**：任一装不上都不能让另外两个一起消失。
 *
 * @module @local/dsh-redteam-lead
 */

// —— 角色闸（LDW-1 / LDW-19 / LDW-20）与工兵遮罩（LDW-15 / LDW-21）——
import { DEFAULT_GATED_TOOLS, GATE_LABEL, installRoleGate, installTeammateMask, logAt } from './gate.js'
// —— 人设（LDW-16）：preset 层那份归 Lead，工兵在自己 ctx 上盖一份同名的 ——
import { installPresetPersona, installTeammatePersona } from './persona.js'
import { recordOf } from './guards.js'

/** 插件名（插件清单/日志用）。 */
export const name = 'redteam-lead-tools'

/**
 * 硬依赖三项，与宿主自己的团队工具行（`@deepseek-ai/dsh-experimental-tool-agent-team`）同一张表，
 * 只少一个 `tools`（本包不注册工具，见文件头）。
 *
 * LDW-20（2026-11-02 现场）：原来只写 `tools`，另外三个用 `ctx.get` 探针「可选」处理，理由是本
 * Cordis 没有 `inject: { optional }`。但宿主 ctx 是 Proxy —— **读一个没写进 `inject` 的服务直接抛**
 * （`cannot get property "x" without inject`，`cordis/src/reflect.ts`），而当时的探针把这次抛错当成
 * 「服务缺席」：Lead 人设没装上、工兵人设与遮罩没落地、安装时扫不到任何 agent，全部只留一条 warn。
 * 整轮三小时里插件对人设与遮罩的贡献是 0，而 511 个测试全绿（替身写得比宿主宽容）。
 *
 * 现在三项都是硬依赖：拿不到就**当场不激活**，而不是悄悄少装一半。
 * 探针（`guards.serviceOf`）仍然保留：它服务的是**运行时才拿到的 agent.ctx**（工兵自己那份），
 * 以及「直读抛错但 `ctx.get` 能读」这一类形状差异。
 */
export const inject = ['agents', 'agentTeams', 'systemPrompt']

/**
 * `apply` 的上下文。
 *
 * 只列**核心能力**（`on`/`effect` 是 Cordis 的，不是服务）；服务一律由 `inject` 保证，
 * 安装器内部用 `guards.serviceOf` 取，所以这里不重复声明它们的形状。
 */
interface PluginContext {
  /** 宿主事件总线：角色闸挂 `tools/pre-execute`、遮罩挂 `agent/created`/`agent/status`。 */
  on?: (event: string, listener: (payload: any, next?: any) => unknown, options?: { prepend?: boolean }) => unknown
  /** fiber 所有权：`ctx.effect(generator, label)` 让监听器随插件卸载。 */
  effect?: (install: () => Generator<unknown, void, unknown>, label?: string) => unknown
}

/**
 * 解析 `config.gatedTools`：本包行实际要挡哪几个工具名。
 *
 * 规则（**只有这四条**，畸形即整份退回默认，不做部分采纳）：
 * 1. 键缺失、或显式写 `undefined` → {@link DEFAULT_GATED_TOOLS}，**不记警告**（这是正常态）；
 * 2. 必须是**非空数组**，且每个元素都是字符串、去掉首尾空白后非空；
 * 3. 每个名字去掉首尾空白，按**首次出现**去重（`['pwsh',' pwsh ']` 只算一个）；
 * 4. 其它一切都是畸形（字符串、空数组、含 `null`/数字/空串的数组、对象、数字…）→ 退回
 *    {@link DEFAULT_GATED_TOOLS}，并记**恰好一条** `ctx.logger.warn`：
 *    「什么都不挡」必须是**有意删掉名字**的结果，不能靠一个空值意外达成 —— 那会让一次手滑
 *    静默地关掉整道闸。
 *
 * 为什么是整份退回、不是「挑出合法元素」：配置只有几行，作者看得见；而被悄悄丢掉的那个名字
 * 会让闸少挡一个入口，且日志里看不出少了谁。退回默认至少是**更严**的方向。
 *
 * @param config 本包行的 `config`（读 `gatedTools`）
 * @param ctx 插件 ctx（诊断走它的 logger）
 * @returns 本次生效的禁表（默认值或配置值）；绝不抛
 */
export function resolveGatedTools(config: unknown, ctx?: unknown): ReadonlySet<string> {
  const raw = recordOf(config).gatedTools
  if (raw === undefined) return DEFAULT_GATED_TOOLS

  const parsed = gatedToolsOf(raw)
  if ('names' in parsed) return parsed.names

  logAt(
    ctx,
    GATE_LABEL,
    `config.gatedTools 形状不合法（${parsed.problem}）：应为非空数组、元素为非空工具名；` +
      `已退回默认 ${DEFAULT_GATED_TOOLS.size} 个（${[...DEFAULT_GATED_TOOLS].join('、')}）`,
  )
  return DEFAULT_GATED_TOOLS
}

/**
 * `gatedTools` 的纯形状解析：要么给出名字集合，要么给出一句「哪里不对」。
 *
 * 不在这里记日志：`resolveGatedTools` 才持有 ctx，纯函数更好测、也不会在没 logger 时抛。
 */
function gatedToolsOf(value: unknown): { names: ReadonlySet<string> } | { problem: string } {
  if (!Array.isArray(value)) return { problem: `实际是${describeConfigValue(value)}，不是数组` }
  if (value.length === 0) {
    return { problem: '数组为空：要关掉某个入口请把它从表里删掉，不要写空数组（空值不许表达「一个都不挡」）' }
  }

  const names = new Set<string>()
  // 位置用循环下标，不用 `names.size`：前面有重复名字时 size 不涨，诊断会指错一项。
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string') return { problem: `第 ${index + 1} 项不是字符串（是${describeConfigValue(entry)}）` }
    const name = entry.trim()
    if (name.length === 0) return { problem: `第 ${index + 1} 项是空白字符串` }
    names.add(name)
  }
  return { names }
}

/** 畸形配置诊断里的「实际是什么」：只说形状，不把整份配置倒进日志。 */
function describeConfigValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `数组（${value.length} 项）`
  if (typeof value === 'string') return `字符串（${value.length} 字符）`
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return `${typeof value}`
  if (typeof value === 'object') return '对象'
  return typeof value
}

/**
 * 装上三件事。在 `apply` 里调用，让 fiber 拥有 disposer。
 *
 * 三件事都**只降级、不抛**（各自的安装器内部吞掉一切）：任一件装不上都不能让另外两件消失 ——
 * `apply()` 抛一次等于整行插件不激活。
 *
 * @param ctx Cordis 上下文（需要 `ctx.on` / `ctx.effect`；服务由 `inject` 保证）
 * @param config 本包行的 `config`（读 `gatedTools` / `leadPersona` / `teammatePersona`）
 */
export function apply(ctx: PluginContext, config: Record<string, unknown> = {}): void {
  // 角色闸（LDW-1 / LDW-19）：本 preset 的**会话根 agent** 调配置里的那几个工具时在
  // `tools/pre-execute` 瀑布上拒绝，理由指向「派给工兵」。判据是会话头里的根/子代信息
  // （`rootOf`），不需要任何服务；头读不出来就放行（fail-open，不误伤工兵）。
  installRoleGate(ctx, resolveGatedTools(config, ctx))

  // 人设（LDW-16）：先把 preset 层的共享人设（Lead 那份）注册到本插件的 ctx 上，
  // 再让每个非 Lead 的团队成员在自己 ctx 上盖同名段（scoped 遮蔽 preset 那份，只影响自己）。
  installPresetPersona(ctx, config)
  installTeammatePersona(ctx, config)

  // 工兵遮罩（LDW-15 / LDW-21）：非 Lead 的团队成员看不到 subagent / subagent_fork / workflow。
  // 与角色闸同一个遮罩实现，只是 deny 表换成那一组派发/建人入口。
  installTeammateMask(ctx)
}
