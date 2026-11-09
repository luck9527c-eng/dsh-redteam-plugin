/**
 * LDW-1 角色闸：`redteam-lead` 的**会话根 agent** 不亲自干活。
 *
 * 依据 [`docs/specs/lead-does-not-work.md`](../../../docs/specs/lead-does-not-work.md) §变更 1：
 * 调用方是会话根 agent 时，以下工具一律拒绝并给出可执行指引（「派给工兵」）：
 * `pwsh`、`bash`、`workflow`、`subagent`、`subagent_fork`。
 * `job_*` 不在其中：派发之后读作业结果是 Lead 的核对动作，不是执行。
 *
 * **LDW-19：判据换成「会话根」，预设不再参与判定。** 这个插件只挂在 `redteam-lead` 这一个
 * preset 里，而预设作用域的监听器收到的是**整个代际**的事件 —— 它能看见的 agent 本来就都属于
 * 这个 preset，再查一遍预设是多余的。而且那份数据是错的：`session.header.agentPreset` 记的是
 * **会话创建时**的预设（现场那次是 `standard`，之后才切到 `redteam-lead`），活组合
 * `inspectCompositions` 在预设作用域里又取不到 —— 两头都判不出，闸全程沉默
 * （`session-1558015b`：`pwsh` 186 次、0 次被拒）。现在只看会话头（`rootOf`），不需要任何服务。
 *
 * 两条不变量：
 * - **只按 agent 身份判定，不解析命令文本**（`exec.arguments` 在闸里一次都不读）。
 * - **判不出来就放行**：会话头缺失/读不懂（`unknown`）、或调用方是子代 agent（`child`）—— 全部 `allow`。
 *   误伤工兵的代价远大于漏掉一次 Lead 自己动手。
 *
 * LDW-8 在同一处补**体验**：确认是 Lead 之后，顺手把同一张表从**这个 agent** 的工具目录里
 * 拿掉（`agent.ctx.tools.restrict({ deny })`）。拒绝是保证，遮罩是增强 —— `restrict` 缺席或
 * 抛错一律静默退回拒绝，只留一条诊断。
 *
 * LDW-11 把「拿哪几个名字去遮」改成**求交**：宿主的 `restrict()` 对「名字不在该 scope 的可遮
 * 名单里」是**整表**抛错（`dsh-tools:3002-3004`），五个名字里只要有一个没在这棵组合树上注册
 * （例如某个 preset 没 compose `workflow` 引擎），整块遮罩就失败、静默退回 deny-only ——
 * 工具仍然可见。所以先取该 agent scope 的可遮名单（`view(scope).restrictableNames`，即
 * `restrict()` 逐字校验的那一份；`view` 缺席时退到 `schemas(scope)` 的可见目录），与
 * `GATED_TOOLS` 求交，**只传交集**；交集为空就根本不调 `restrict`。每次尝试留一条诊断，
 * 写清「本应遮 N 个、实际遮 M 个」。
 *
 * 决策本身是纯函数（`decideGate`），单独可测；`installRoleGate` 只负责把它挂到
 * 宿主的 `tools/pre-execute` 瀑布上（兄弟 bundle `redteam-preset/index.js:453-502` 的成熟写法）。
 *
 * LDW-15 把同一段遮罩机制**再借一次**给工兵：非 Lead 的团队成员看不到四个「建人 / 派发」入口
 * （`TEAMMATE_DENIED_TOOLS`）。两边只差一张 deny 表、一个诊断主语与一个 effect label ——
 * 找 scoped ctx、与可遮名单求交、整表被拒的处置全部走 `maskToolsForAgent` 一处实现。
 * 工兵那边没有 deny 保底，所以裁不掉时只能记一条日志（`installTeammateMask`）。
 *
 * @module @local/dsh-redteam-lead/gate
 */

import { toolNamesFromSchemas } from './tool-names.js'
import { isRecord, recordOf, serviceOf, thrownMessage } from './guards.js'
import type { AnyRecord } from './guards.js'

/**
 * 默认被禁的工具名：都是「Lead 自己动手」的入口，不是核对手段。
 *
 * **五个**，且 `job_*` 故意不在表里（DECISIONS D42：`jobs` 不是宿主真实工具名；读后台作业的
 * `job_list`/`job_output`/`job_kill` 是 Lead 的核对手段，和 `read`/`grep` 同类）。
 *
 * 这份清单只是**默认值**：实际用哪几个由本包行的 `config.gatedTools` 决定（解析见
 * `src/index.ts` 的 `resolveGatedTools`），经 `decideGate` / `createRoleGate` /
 * `installRoleGate` 的 `gated` 参数逐层传进来。不传就是这一份 —— 既有调用方因此不用改。
 * 声明顺序保留（默认值与诊断文案要按人写的顺序读），语义是集合。
 */
export const DEFAULT_GATED_TOOLS: ReadonlySet<string> = new Set([
  'pwsh',
  'bash',
  'workflow',
  'subagent',
  'subagent_fork',
])

/**
 * `DEFAULT_GATED_TOOLS` 的历史名字，保留为**同一个 Set 的别名**。
 *
 * 这个名字已经随 `dist/gate.d.ts` 发出去过，既有测试与调用方 import 的就是它，删掉等于破坏性
 * 改名。但「默认值」与「本次生效的清单」是两件事：后者永远是参数 `gated`，不是这个常量 ——
 * 所以新名字叫 `DEFAULT_*`，老名字只是别名。
 */
export const GATED_TOOLS: ReadonlySet<string> = DEFAULT_GATED_TOOLS

/**
 * 调用者角色。LDW-19 起它**不参与拒绝判定**（拒绝只看 {@link rootOf}）：
 * 只剩一个用途 —— 决定要不要给这个 agent 下发 Lead 遮罩（LDW-8）。
 */
export type GateRole = 'lead' | 'teammate' | 'other' | 'unknown'

/** 这个 agent 在会话里的位置。**只有 `root` 会被角色闸拦住**；`unknown` 与 `child` 一样放行。 */
export type AgentRoot = 'root' | 'child' | 'unknown'

/**
 * 读会话头（`exec.agent.session.header`）；`undefined` = 头读不出来。
 *
 * `isRecord` 对数组同样成立，而数组不是合法的头，所以这里显式排除：
 * 「读不懂」必须是 `unknown`，不能退化成「没有子代证据 = 根」。
 */
function sessionHeaderOf(exec: unknown): AnyRecord | undefined {
  const agent = recordOf(exec).agent
  if (!isRecord(agent) || Array.isArray(agent)) return undefined
  const session = agent.session
  if (!isRecord(session) || Array.isArray(session)) return undefined
  const header = session.header
  if (!isRecord(header) || Array.isArray(header)) return undefined
  return header
}

/** 父子会话标记：非空字符串或记录都算「有」；空串 / `null` / 缺省都不算。 */
function hasParentSession(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0
  return isRecord(value)
}

/**
 * LDW-19：从**会话头**判「是不是会话根」，不需要任何服务。
 *
 * 三个字段，任一子代证据成立就是 `child`：
 * - `origin === 'subagent'`（裸子代理没有 `parentSession`，只有这一条）；
 * - 有 `parentSession`（非空字符串或记录）；
 * - `delegationDepth >= 1`。
 *
 * 都没有、且 `delegationDepth` 是 0 或缺省 → `root`。
 * 头缺失、头不是普通对象、或深度读不懂（字符串 / 负数 / NaN）→ `unknown`。
 * **绝不抛**：会话头是活的宿主对象，读字段本身可能抛（已销毁的 session），一律收成 `unknown`。
 */
export function rootOf(exec: unknown): AgentRoot {
  try {
    const header = sessionHeaderOf(exec)
    if (header === undefined) return 'unknown'

    // 先认子代证据：任意一条成立就是 child，其余字段再脏也不影响。
    if (header.origin === 'subagent') return 'child'
    if (hasParentSession(header.parentSession)) return 'child'

    const depth = header.delegationDepth
    if (depth === undefined || depth === null) return 'root'
    if (typeof depth !== 'number' || !Number.isFinite(depth) || depth < 0) return 'unknown'
    return depth >= 1 ? 'child' : 'root'
  } catch {
    return 'unknown'
  }
}

/**
 * LDW-15：工兵被裁掉的四个入口 —— 建人与派发。
 *
 * spec §变更 3 的判据：派发权靠「契约里写一句不许」是软的，能力拿掉才是硬的。
 * 这张表**只管入口**，不碰干活的手段：`pwsh`、`send_message`、`team_task_*`、`list_agents`、
 * 一个都不在表里（工兵要能干活、能回报、能自查）。
 *
 * 与 {@link GATED_TOOLS} 的关系：三个名字（`subagent`/`subagent_fork`/`workflow`）两边都挡
 * —— 语义不同但结论一样（Lead 不自己开、工兵不往下派）；`spawn_teammate` 只在这张表里，
 * 它是 Lead 的建人入口，绝不能被角色闸挡掉。
 */
export const TEAMMATE_DENIED_TOOLS: ReadonlySet<string> = new Set([
  'spawn_teammate',
  'subagent',
  'subagent_fork',
  'workflow',
])

/** 判定语义：`tryMembership` 认得出、且不是 Lead，就是这张表要服务的对象（bare subagent 不算）。 */
export function isTeammateRole(role: GateRole): boolean {
  return role === 'teammate' || role === 'other'
}

/** 纯判定的入参：工具名与会话位置都已经由可测的探针解析好。 */
export interface GateInput {
  /** 即将执行的工具名（`exec.name`）。 */
  tool: string
  /** 调用方在会话里的位置；判不出来就是 `'unknown'`。 */
  root: AgentRoot
  /**
   * 本次生效的禁表；缺省 = {@link DEFAULT_GATED_TOOLS}。
   *
   * 空集是合法的（「一个都不挡」）—— 正是为此才不能用「空就退回默认」的写法：那会让一次
   * 有意的收窄变成静默的放宽。
   */
  gated?: ReadonlySet<string>
  /**
   * 按工具定制的拒绝理由；缺省走 {@link denyReason} 的通用文案。
   *
   * 只有**同时**在 `gated` 里的名字才会被拒，所以这里多写几个键是无害的（不会凭空扩大禁表）。
   */
  reasons?: GatedToolReasons
}

/** 判定结果：只有 `deny` 带理由（宿主把它原样交给模型）。 */
export type GateDecision = { kind: 'allow' } | { kind: 'deny', reason: string }

/**
 * 按工具定制的拒绝理由：键是工具名，值是**要追加的正文**（统一前缀由 {@link denyReason} 加）。
 *
 * 为什么需要它：同一条闸挡两类完全不同的东西 —— 一类是「自执行/派发入口」，理由该说「派给工兵」；
 * 另一类是「等同伴」这类**根本不该做**的动作（`wait_agent`：成员完成会自己唤醒你），
 * 拿「派给工兵」去解释它，模型只会困惑或换个工具硬撞。
 */
export type GatedToolReasons = Readonly<Record<string, string>>

const ALLOW: GateDecision = Object.freeze({ kind: 'allow' })

/**
 * 拒绝理由。三件事必须同时说到，否则模型会原地重试或换个工具硬撞：
 * 1. Lead 不亲自执行（这是身份约束，不是工具坏了）；
 * 2. 该怎么做 —— 用底座的 `spawn_teammate` 建人并手写开场简报，派活用 `send_message`；
 * 3. 还能用什么 —— `read` / `grep` 核对，`job_*` 读已派作业。
 *
 * LDW-23：原文还挂着两个本包的 `rt_*` 记账工具，它们已经删了 —— 拒绝理由里指一个不存在的
 * 工具，模型只会去找它、然后卡住。账目走 `reverse-project-management` skill 的 `project.py`。
 *
 * 措辞里刻意不出现「重试」「稍后」这类把拒绝说成暂时故障的词。
 */
export function denyReason(tool: string, reasons?: GatedToolReasons): string {
  const custom = reasons === undefined ? undefined : reasons[tool]
  if (typeof custom === 'string' && custom.trim().length > 0) {
    return `[redteam-lead] 拒绝执行 ${tool}：${custom.trim()}`
  }
  return (
    `[redteam-lead] 拒绝执行 ${tool}：Lead 不亲自执行。` +
    '把这件事派给工兵——用底座的 spawn_teammate 建人（一条路线一个人，开场简报手写），派活与追问用 send_message，任务用 team_task_*；' +
    '项目账目同样派出去：project.py 的 seal / index / check / impact 交给一名工兵按你的指令原样执行（只跑命令、不改判断），输出交回你核对；' +
    '核对与验证用 read / grep，已派出的后台作业用 job_list / job_output 读结果。'
  )
}

/**
 * 纯判定：**只有**「调用方是会话根」且「工具在禁表里」时拒绝。子代与 `unknown` 一律放行（fail-open）。
 *
 * 为什么不再看预设（LDW-19）：本插件只挂在 `redteam-lead` 这一个 preset 里，预设作用域的监听器
 * 收到的是整个代际的事件 —— 看得见的 agent 本来就都属于这个 preset；而
 * `session.header.agentPreset` 记的是**创建时**的预设，切过预设后就是过期值。再查一遍既多余、
 * 又只会查错（现场就是这么沉默的）。
 *
 * 为什么也不看角色：根判定已经把 Lead 与工兵分开了；再叠一层团队服务，会把「服务缺席」
 * 重新变成漏拦 —— 而团队查询只该决定遮罩（体验），不该决定拒绝（保证）。
 *
 * 禁表是**参数**（`gated`），不是模块常量：同一份判定逻辑要被「默认五个」与「本包行配置的那几个」
 * 共用，前者只是后者的缺省值。
 */
export function decideGate({ tool, root, gated, reasons }: GateInput): GateDecision {
  if (root !== 'root') return ALLOW
  if (!(gated ?? DEFAULT_GATED_TOOLS).has(tool)) return ALLOW
  return { kind: 'deny', reason: denyReason(tool, reasons) }
}

/**
 * 用执行上下文里的 agent 查团队成员身份。
 *
 * 唯一身份来源是 `exec.agent` + `ctx.agentTeams.tryMembership`（宿主形状，见
 * `dsh-team` 的 `tryMembership(agent)`：认不出的 agent 返回 `undefined`，不抛）。
 * 服务缺席、返回 `undefined`、抛异常、`exec.agent` 缺失 —— 一律 `unknown`：结果只影响
 * 「要不要遮罩」（`createRoleGate` 里角色是 `lead` 才遮），不影响放行/拒绝。
 * `tryMembership` 在宿主里是同步的；`memberRoleOf` 对 Promise 也能等（替身/其它实现）。
 */
export async function resolveRole(ctx: unknown, exec: unknown): Promise<GateRole> {
  return await memberRoleOf(ctx, recordOf(exec).agent)
}

/** thenable 判定：只认带函数 `then` 的记录（宿主不一定用原生 Promise）。 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof (value as { then?: unknown }).then === 'function'
}

/** 成员对象 → 角色。宿主只有 `lead` / `teammate`；表里其它角色算 `other`（仍是成员）。 */
function roleOfMember(member: unknown): GateRole {
  const role = recordOf(member).role
  if (role === 'lead') return 'lead'
  if (role === 'teammate') return 'teammate'
  return member === undefined || member === null ? 'unknown' : 'other'
}

/**
 * 同一套探针，入参直接是 agent（`agent/created` 那条路没有 `exec`）。
 *
 * **同步优先**：宿主的 `tryMembership` 是同步的，而 `agent/created` 的监听器也是同步回调 ——
 * 中间多一个 microtask，就会出现「人已经建好、工具目录还没裁」的窗口。只有当替身实现返回
 * Promise 时才等它。
 */
export function memberRoleOf(ctx: unknown, agent: unknown): GateRole | Promise<GateRole> {
  if (!agent) return 'unknown'

  // LDW-20：直读未注入的服务会抛，`serviceOf` 会退到 `ctx.get('agentTeams')`。
  // 原来这里把「直读抛错」当成「团队服务缺席」，于是工兵人设与工兵遮罩在真实会话里静默跳过。
  const service = recordOf(serviceOf(ctx, 'agentTeams'))
  const tryMembership = service.tryMembership
  const fallback = service.membership
  const query = typeof tryMembership === 'function' ? tryMembership : (typeof fallback === 'function' ? fallback : undefined)
  if (query === undefined) return 'unknown'

  let member: unknown
  try {
    member = query.call(service, agent)
  } catch {
    return 'unknown'
  }
  if (isThenable(member)) return Promise.resolve(member).then(roleOfMember, () => 'unknown' as const)
  return roleOfMember(member)
}

/** 瀑布监听器的 `next()`：不接管决定时必须**原样**返回它的结果。 */
export type PreExecuteNext = () => unknown

/** 挂进 `tools/pre-execute` 的监听器形状（宿主：`async (exec, next) => decision`）。 */
export type PreExecuteListener = (exec: unknown, next: PreExecuteNext) => Promise<unknown>

/** `ctx.effect` 的 label：fiber 归属与 HMR 清理的可读标记。 */
export const GATE_LABEL = 'redteam-lead/role-gate'

/** 宿主的瀑布事件名。 */
const PRE_EXECUTE_EVENT = 'tools/pre-execute'

/** 宿主建 agent 时广播的事件（`@deepseek-ai/experimental-tool-agent-team` 的同一处）。 */
const AGENT_CREATED_EVENT = 'agent/created'

/** 工兵裁剪的监听器 effect label（与逐 agent 的遮罩分开：卸载顺序与诊断都要能分辨）。 */
export const TEAMMATE_INSTALL_LABEL = 'redteam-lead/teammate-mask:install'

/** 遮罩的 `ctx.effect` label：遮罩本身归 agent，解除它的清理归本插件 fiber。 */
export const MASK_LABEL = 'redteam-lead/role-gate:restrict'

/** LDW-15 工兵裁剪的 effect label（与 Lead 的遮罩分开：卸载时要能分辨谁是谁）。 */
export const TEAMMATE_MASK_LABEL = 'redteam-lead/teammate-mask:restrict'

/**
 * 宿主的 agent 状态事件（`@deepseek-ai/dsh-experimental-agent-team` 用的同一个）。
 *
 * LDW-21：可续轮的工兵在**每一轮开始时会被宿主重建**（新的 agent 对象、新的 scope），而
 * `agent/created` 只在第一次建人时发。只挂 created 会让续轮那次拿不到遮罩与人设，所以
 * 再挂一条 status —— 它在每一轮状态切换时都会来。
 */
const AGENT_STATUS_EVENT = 'agent/status'

/**
 * 一次遮罩尝试的结果。
 *
 * **只喂诊断**：闸的决定永远由 `decideGate` 单独做出，遮罩成不成功都不改变放行/拒绝。
 * 「本应遮几个」不是这里的字段 —— 它等于**调用方传进来的那张表**的大小（默认
 * {@link DEFAULT_GATED_TOOLS}.size，配置了 `gatedTools` 就是配置的大小），只在写诊断时引用。
 */
export interface MaskOutcome {
  /** 结果分类；`repeat` = 这个 agent 已经试过了。 */
  kind: 'masked' | 'empty' | 'unknown-names' | 'unavailable' | 'failed' | 'repeat'
  /** 实际成功下发遮罩的名字。 */
  masked: readonly string[]
  /** 本应遮、这次没遮到的名字（不可见的、或因整表被拒而一个都没落地的）。 */
  skipped: readonly string[]
  /** `kind: 'failed'`：`restrict` 抛出的原文（宿主整表拒绝时会点名是哪个名字）。 */
  error?: string
}

/** `restrict` 的调用面：方法要带着它的 receiver 调（宿主实现靠 `this.ctx` 找调用方 scope）。 */
interface ScopedTools {
  /** `agent.ctx.tools` 本体，`restrict` 的 receiver。 */
  tools: AnyRecord
  restrict: (filter: { deny: string[] }) => unknown
}

/**
 * 那个 agent **自己的** scoped tools —— `restrict` 唯一合法的调用面。
 *
 * 宿主契约：`restrict()` 把遮罩写进**调用方那一层**，能盖住预设（祖先）层注册的工具；
 * 从预设自己的 ctx 调会抛 `unknown global tool` 且波及整个代际。所以这里只认 `agent.ctx`。
 */
function scopedToolsOf(agent: unknown): ScopedTools | undefined {
  const tools = recordOf(recordOf(agent).ctx).tools
  const holder = recordOf(tools)
  const restrict = holder.restrict
  if (typeof restrict !== 'function') return undefined
  return { tools: holder, restrict: restrict as ScopedTools['restrict'] }
}

/**
 * 按 id 从 `ctx.agents`（宿主 AgentRegistry：`get(id)` / `list()`）找活的 agent。
 *
 * `exec.agent` 在宿主里就是 Agent 本体（自带 `ctx`），这是首选；这条是兜底路由
 * （ticket 点名的 `ctx.agents` → Lead 的 `agent.ctx.tools.restrict`）。
 * 服务缺席、探针抛错、返回形状不合、找不到 —— 一律 `undefined`，绝不猜。
 */
function agentRegistry(ctx: unknown): AnyRecord {
  // LDW-20：同上 —— 直读未注入的 `agents` 会抛，`serviceOf` 退到 `ctx.get('agents')`。
  // 原来这里把抛错当成「服务缺席」，于是安装时那一遍 `ctx.agents.list()` 恒为空表。
  return recordOf(serviceOf(ctx, 'agents'))
}

/** 活的 agent 列表（`AgentRegistry.list()`）；拿不到就是空表，绝不猜。 */
export function liveAgents(ctx: unknown): unknown[] {
  const registry = agentRegistry(ctx)
  const list = registry.list
  if (typeof list !== 'function') return []
  try {
    const agents = list.call(registry)
    return Array.isArray(agents) ? agents : []
  } catch {
    return []
  }
}

function liveAgentById(ctx: unknown, id: string): unknown {
  const registry = agentRegistry(ctx)

  const byId = registry.get
  if (typeof byId === 'function') {
    try {
      const found = byId.call(registry, id)
      if (found !== undefined && found !== null) return found
    } catch {
      // `get` 在这个 scope 不可用：继续试 `list`。
    }
  }

  const list = registry.list
  if (typeof list !== 'function') return undefined
  try {
    const agents = list.call(registry)
    if (!Array.isArray(agents)) return undefined
    return agents.find((candidate) => recordOf(candidate).id === id)
  } catch {
    return undefined
  }
}

/**
 * 可迭代的「一串东西」（`Set` / 数组 / 自定义可迭代）；不是就给 `undefined`。
 *
 * 用 `Reflect.get` 读 `Symbol.iterator`：`AnyRecord` 没有符号索引签名，直接取值在 strict 下
 * 读不出来（与 `capability.ts` 的 `isIterable` 同一写法）。
 */
function iterableEntriesOf(value: unknown): Iterable<unknown> | undefined {
  if (Array.isArray(value)) return value
  if (isRecord(value) && typeof Reflect.get(value, Symbol.iterator) === 'function') return value as unknown as Iterable<unknown>
  return undefined
}

/**
 * 「名字清单」的两种宿主形状 → 名字集合：`Set<string>` / `string[]`（`restrictableNames`），
 * 以及 `schemas(scope)` 的 schema 对象数组（名字在 `.name` 上）。
 *
 * schema 形状的解析**只走** `capability.toolNamesFromSchemas()` 那一处（`dispatch.ts` 的同一条
 * 规矩）：数组上 `Object.keys` 只会得到 `["0","1",…]`，那是 T15 的真会话事故。
 *
 * `undefined` = **认不出形状**，与「空的集合」是两件事：调用方据此决定「别猜、别调 restrict」。
 */
function namesOf(value: unknown): ReadonlySet<string> | undefined {
  const entries = iterableEntriesOf(value)
  const direct = new Set<string>()
  if (entries !== undefined) {
    for (const entry of entries) {
      if (typeof entry === 'string' && entry.length > 0) direct.add(entry)
    }
    if (direct.size > 0) return direct
  }
  const fromSchemas = toolNamesFromSchemas(value)
  if (fromSchemas.length > 0) return new Set(fromSchemas)
  return entries === undefined ? undefined : direct
}

/**
 * 这个 agent scope 里**可遮**的工具名 —— 与宿主校验 `restrict()` 的**同一份来源**。
 *
 * 首选 `view(scope).restrictableNames`：`restrict()` 逐字校验的就是它（`dsh-tools:3002`）——
 * 只含**继承来的**名字（global + 祖先层）。本层注册的名字与 `run_code` 传进去会被整表拒绝，
 * 它们也恰好不在这一份里。
 *
 * `scope` 传的就是 agent 对象本身，不是别的代理：`restrict()` 内部是
 * `this.view(scopeOf(this.ctx))`，而 agent 的 scoped ctx 由 `createScope(loopCtx, this)` 造出来
 * （`dsh-agent-loop` 构造函数）—— scope key **就是 agent 对象**，所以 `scopeOf(agent.ctx) === agent`。
 * 两边拿到的是同一个 view。
 *
 * `view` 缺席或抛错时退到 `schemas(scope)` 的可见目录（ticket 允许的另一半来源）。它含本层
 * 注册与 `run_code`，所以这条路更宽松；只有 `view` 不可用时才走。
 *
 * 两份都拿不到 → `undefined`：绝不猜（猜错的代价是整块遮罩失败，也就是本票要修的现场）。
 */
function restrictableNamesOf(holder: AnyRecord, scope: unknown): ReadonlySet<string> | undefined {
  const view = holder.view
  if (typeof view === 'function') {
    try {
      const names = namesOf(recordOf(view.call(holder, scope)).restrictableNames)
      if (names !== undefined) return names
    } catch {
      // `view` 在这个 scope 不可用：退到 schemas。
    }
  }
  const schemas = holder.schemas
  if (typeof schemas !== 'function') return undefined
  try {
    return namesOf(schemas.call(holder, scope))
  } catch {
    return undefined
  }
}

/**
 * 把 restrict 的 disposer 交给**本插件自己的** fiber 持有。
 *
 * 遮罩的 effect 归调用方 ctx（也就是 agent），插件卸载时它不会自己消失 —— 不接管就会在
 * 别人的 scope 上留一块没人收的遮罩。宿主支持 `effect(() => () => …)` 这种直接返回清理函数
 * 的形状（`dsh-tools` 自己也这么用）；拿不到 `effect`、或 disposer 不是函数，就不挂。
 *
 * LDW-15 的遮罩与 LDW-16 的人设段都盖在**别人的 scope** 上，用的是同一个接管动作：不接管，
 * 插件卸载后那块东西还留在那儿，下一份配置就盖不上去（同名同层再注册会抛）。
 */
export function ownDisposal(ctx: unknown, dispose: unknown, label: string): void {
  if (typeof dispose !== 'function') return
  const view = recordOf(ctx)
  const effect = view.effect
  if (typeof effect !== 'function') return
  try {
    effect.call(view, () => () => {
      try {
        dispose()
      } catch {
        // 解除遮罩失败不阻塞 fiber 清理：此时 agent 多半已经先一步销毁了。
      }
    }, label)
  } catch {
    // 清理登记失败不影响已经生效的遮罩。
  }
}

/**
 * 「这个 agent 的这个 scope 已经处理过」的记号。
 *
 * **键是 `agent.ctx`，不是 agent id**（LDW-21）。可续轮的工兵在下一轮会被宿主**重建**：同一个
 * session id、同一个成员 id，但新的 agent 对象与新 scope —— 按 id 去重会让续轮那次既没有遮罩
 * 也没有人设（2026-11-03 现场：turn 1 = 271 工具、`workflow`/`subagent_fork` 已被摘掉；
 * turn 2 = 273 工具，宿主发出两条 `tool-addition` 把它们加回来）。按 scope 去重则：
 * 同一个 scope 只做一次（不撞宿主 `already registered in this scope`），scope 换了就再做一次。
 */
export type MaskAttempts = WeakSet<object>

/** 遮罩记号的键：优先 `agent.ctx`（`restrict` 的落点），退到 agent 对象本身。 */
function scopeKeyOf(agent: unknown): object | undefined {
  const scope = recordOf(agent).ctx
  if (isRecord(scope)) return scope
  return isRecord(agent) ? agent : undefined
}

/**
 * 给**任意一个 agent 的 ctx** 下发遮罩：每个 scope 只尝试一次，且绝不抛。
 *
 * LDW-8（Lead 的五个执行入口）与 LDW-15（工兵的四个派发入口）共用这一段 —— 两边的差别
 * 只有 deny 表、诊断主语与 effect label，其余（找 scoped ctx、求交、整表拒绝的处置）一字不差。
 *
 * 三个理由：
 * - `restrict` 可叠加，重复调用无害，但重试没有收益；
 * - 失败重试会把「宿主形状不符」变成每次工具调用一条告警；
 * - 遮罩只是体验（Lead 那边 `deny` 才是保证），所以任何异常都不能穿过这里。
 *
 * 传入的名字是**交集**：`intended ∩ 该 scope 的可遮名单`。`restrict` 对名单外的一个名字
 * 是整表拒绝，所以宁可少遮几个，也不能让整块遮罩因为一个没注册的引擎而全线失败。
 *
 * @param ctx 插件自己的 ctx（disposer 归它）
 * @param agent 被遮的 agent（`restrict` 只能落在它自己的 scoped ctx 上）
 * @param intended 本应遮的名字（调用方给出的 deny 表）
 * @param attempted 每个 scope 只做一次的记号（调用方持有；键见 {@link MaskAttempts}）
 * @param label disposer 的 fiber label
 */
export function maskToolsForAgent(
  ctx: unknown,
  agent: unknown,
  intended: readonly string[],
  attempted: MaskAttempts,
  label: string,
): MaskOutcome {
  const id = recordOf(agent).id
  if (typeof id !== 'string' || id.length === 0) return { kind: 'unavailable', masked: [], skipped: intended }

  // `exec.agent` 在宿主里就是 Agent 本体；只带 id 时从 `ctx.agents` 找同一个活的 agent。
  let scope = agent
  let holder = scopedToolsOf(scope)
  if (holder === undefined) {
    scope = liveAgentById(ctx, id)
    holder = scopedToolsOf(scope)
  }
  if (holder === undefined) return { kind: 'unavailable', masked: [], skipped: intended }

  const key = scopeKeyOf(scope)
  if (key !== undefined) {
    if (attempted.has(key)) return { kind: 'repeat', masked: [], skipped: [] }
    attempted.add(key)
  }

  const names = restrictableNamesOf(holder.tools, scope)
  if (names === undefined) return { kind: 'unknown-names', masked: [], skipped: intended }

  const deny = intended.filter((name) => names.has(name))
  const skipped = intended.filter((name) => !names.has(name))
  if (deny.length === 0) return { kind: 'empty', masked: [], skipped }

  try {
    const dispose = holder.restrict.call(holder.tools, { deny })
    ownDisposal(ctx, dispose, label)
    return { kind: 'masked', masked: deny, skipped }
  } catch (error) {
    return { kind: 'failed', masked: [], skipped: intended, error: thrownMessage(error) }
  }
}

/**
 * Lead 的遮罩面：把**本次生效的**禁表交给共用实现。
 *
 * `gated` 与 `decideGate` 收到的是同一个 Set：拒绝面与遮罩面只允许有一份来源，否则会出现
 * 「拦得住但看得见」（或反过来）这种自相矛盾的现场。工兵那张表不走这里（见
 * `installTeammateMask`）。
 */
function maskGatedTools(ctx: unknown, exec: unknown, attempted: MaskAttempts, gated: ReadonlySet<string>): MaskOutcome {
  return maskToolsForAgent(ctx, recordOf(exec).agent, [...gated], attempted, MASK_LABEL)
}

/**
 * 每个 agent 一条诊断：**本应遮 N 个、实际遮 M 个**，外加没遮到的原因。
 *
 * 用 `ctx.logger.warn`（宿主已有通道，不新开文件格式）：会少遮/没遮住是运营上必须看得见的事，
 * 而遮罩是「安全体验」的一部分 —— 一个被日志级别过滤掉的诊断等于没有诊断。
 *
 * @param id 被遮的 agent
 * @param outcome 这次尝试的结果
 * @param total 本应遮几个（调用方的 deny 表大小）
 * @param noun 主语（Lead 的「工具遮罩」/ 工兵的「工兵工具遮罩」）
 * @param fallback 遮罩没落地时的兜底文案（Lead 有 deny 保底，工兵没有）
 */
function maskDiagnostic(id: string, outcome: MaskOutcome, total: number, noun: string, fallback: string): string {
  const head = `${id} 的${noun}：本应遮 ${total} 个，实际遮 ${outcome.masked.length} 个`
  switch (outcome.kind) {
    case 'masked':
      return outcome.skipped.length === 0
        ? head
        : `${head}（这个 scope 没有：${outcome.skipped.join('、')}，已跳过）`
    case 'empty':
      return `${head}（${total} 个都不在这个 scope 的可遮名单里，未调用 restrict）`
    case 'unknown-names':
      return `${head}（拿不到这个 scope 的可遮名单，未调用 restrict）`
    case 'unavailable':
      return `${head}（拿不到 scoped tools.restrict，${fallback}）`
    case 'failed':
      return `${head}（restrict 整表被拒：${outcome.error ?? '未知错误'}；${fallback}）`
    case 'repeat':
      return head
  }
}

/** 诊断走宿主已有的 logger（`ctx.logger.warn`）：没有 logger、或它抛错，都只是少一条记录。 */
function logGate(ctx: unknown, message: string): void {
  logAt(ctx, GATE_LABEL, message)
}

/** 与 {@link logGate} 同一条通道，但带调用方自己的 label（LDW-16 的人设诊断要用）。 */
export function logAt(ctx: unknown, label: string, message: string): void {
  try {
    const logger = recordOf(recordOf(ctx).logger)
    const warn = logger.warn
    if (typeof warn === 'function') warn.call(logger, `[${label}] ${message}`)
  } catch {
    // 诊断是尽力而为。
  }
}

/** 遮罩诊断：每个 agent 一条。 */
function reportMask(ctx: unknown, message: string): void {
  logGate(ctx, message)
}

/**
 * 闸里的遮罩入口：确认是 Lead 之后调用，**吞掉一切失败**（含诊断路径自己的失败）。
 *
 * 每个 agent **恰好一条**诊断（`repeat` 不再记）：这条线是唯一能看出「遮罩是不是真的生效」的
 * 地方，所以成功也要记。
 */
function applyMask(ctx: unknown, exec: unknown, attempted: MaskAttempts, gated: ReadonlySet<string>): void {
  try {
    const outcome = maskGatedTools(ctx, exec, attempted, gated)
    if (outcome.kind === 'repeat') return
    const id = recordOf(recordOf(exec).agent).id
    if (typeof id !== 'string' || id.length === 0) return
    reportMask(ctx, maskDiagnostic(id, outcome, gated.size, '工具遮罩', '已退回 deny 保底'))
  } catch {
    // 遮罩是增强：任何意外都不许影响 deny。
  }
}

/**
 * 工兵的裁剪：**只记「没遮干净」的那一次**，成功不吭声。
 *
 * 与 Lead 不同：Lead 只有一两个，成功也要留痕；工兵会有一二十个，成功也记就把日志淹了，
 * 而这里要看的恰恰是「谁的遮罩没落地」。每个 agent 仍然只可能有一条。
 */
function reportTeammateMask(id: string, outcome: MaskOutcome, loggerCtx: unknown): void {
  if (outcome.kind === 'masked' && outcome.skipped.length === 0) return
  if (outcome.kind === 'repeat') return
  logGate(
    loggerCtx,
    maskDiagnostic(id, outcome, TEAMMATE_DENIED_TOOLS.size, '工兵工具遮罩', '工兵仍看得到这些入口'),
  )
}

/**
 * LDW-15：给每个**非 Lead 的团队成员**遮掉四个派发/建人入口。
 *
 * 两个入口，宿主 `@deepseek-ai/experimental-tool-agent-team` 的 `maybeInstall` 就是这个形状：
 * 1. 安装时扫一遍 `ctx.agents.list()` —— 工兵通常在 Lead 派发之后才建，但插件也可能是
 *    在会话中途挂上的（HMR/preset 重载），那时已有的工兵必须同样被裁；
 * 2. `ctx.on('agent/created', …)` —— 之后每一个新建的工兵在这里被裁。
 *
 * 不裁的对象：Lead（归角色闸的五个执行入口）、`tryMembership` 认不出的 agent（bare subagent）。
 * 裁剪是**能力**层面的：它不改变任何工具行为，只是让这四个名字从这个 agent 的目录里消失。
 *
 * 失败策略与 `installRoleGate` 一致：绝不抛（`apply()` 抛一次等于整行插件不激活，角色闸与人设
 * 工具与角色闸一起消失）；`ctx.on` 缺席时返回 `false` 并留一条可运营的诊断。
 */
export function installTeammateMask(ctx: unknown): boolean {
  const view = recordOf(ctx)
  const on = view.on
  if (typeof on !== 'function') {
    logGate(view, '工兵裁剪未安装：宿主上下文缺少 ctx.on —— 工兵仍看得到 spawn_teammate/subagent/subagent_fork/workflow')
    return false
  }

  // 每个 scope 只尝试一次（含失败）：失败重试会把「宿主形状不符」变成每建一个人一条告警；
  // scope 换了（续轮重建）会再做一次 —— 键的含义见 `MaskAttempts`。
  const attempted: MaskAttempts = new WeakSet<object>()
  const maskNow = (agent: unknown, role: GateRole): void => {
    // Lead 与认不出的 agent 都不在服务范围内；bare subagent 也走这条分支。
    if (!isTeammateRole(role)) return
    try {
      const outcome = maskToolsForAgent(view, agent, [...TEAMMATE_DENIED_TOOLS], attempted, TEAMMATE_MASK_LABEL)
      const id = recordOf(agent).id
      if (typeof id !== 'string' || id.length === 0) return
      reportTeammateMask(id, outcome, view)
    } catch {
      // 遮罩失败不改变任何工具的行为：它只是让入口不可见。
    }
  }
  const maybeMask = (agent: unknown): void => {
    try {
      const role = memberRoleOf(view, agent)
      if (isThenable(role)) {
        void Promise.resolve(role).then((resolved) => maskNow(agent, resolved), () => {
          // 身份判不出来就不裁（与角色闸同一条 fail-open 原则）。
        })
        return
      }
      maskNow(agent, role)
    } catch {
      // 同步探针炸了也不许打断建人流程。
    }
  }

  for (const agent of liveAgents(view)) maybeMask(agent)
  const listener = (payload: unknown): void => {
    maybeMask(recordOf(payload).agent)
  }
  const effect = view.effect
  if (typeof effect === 'function') {
    try {
      effect.call(view, function* installTeammateMaskSeam() {
        yield on.call(view, AGENT_CREATED_EVENT, listener)
        // LDW-21：续轮重建的工兵只有 status，没有 created —— 不补这条，续轮的工具目录会变回
        // 完整 273 个（宿主还会发 `tool-addition`），遮罩等于白做。
        yield on.call(view, AGENT_STATUS_EVENT, listener)
      }, TEAMMATE_INSTALL_LABEL)
      return true
    } catch {
      // effect 登记失败：退回直接挂监听器（裁剪照常生效，只是不随 fiber 摘除）。
    }
  }
  try {
    on.call(view, AGENT_CREATED_EVENT, listener)
    on.call(view, AGENT_STATUS_EVENT, listener)
  } catch {
    logGate(view, '工兵裁剪未安装：ctx.on 拒绝登记 agent/created 监听器')
    return false
  }
  logGate(view, '工兵裁剪没有 fiber 所有权：宿主上下文缺少 ctx.effect —— 裁剪照常生效，监听器不随插件卸载摘除')
  return true
}

/**
 * 造一条角色闸监听器（不注册，便于单测与复用）。
 *
 * 读的东西只有 `exec.name` 和 `exec.agent`（含它的 `session.header`），**绝不读
 * `exec.arguments`**：闸判的是「谁在调」，不是「调什么命令」，所以不存在命令文本解析与绕过。
 *
 * 顺序是「先遮后判」：会话根就是本 preset 的 Lead，确认之后顺手把**配置里的那几个**工具从
 * **这个 agent** 的目录里拿掉，再做放行/拒绝的决定。遮罩失败不影响决定（`applyMask` 自己吞掉一切）。
 *
 * 两件事刻意分开：
 * - **判根不需要服务**（`rootOf`）—— 拒绝是保证，团队服务/预设服务缺席也照样拦；
 * - **遮罩仍然问一次团队身份**（`role === 'lead'`）—— 遮罩是体验，只该落在真正的 Lead 身上。
 *   只有会话根才可能是这个 preset 的 Lead，所以子代不必为每次工具调用付一次团队查询。
 *
 * @param ctx 插件自己的 ctx（身份探针与遮罩的 disposer 归它）
 * @param gated 本次生效的禁表；缺省 = {@link DEFAULT_GATED_TOOLS}（既有调用方不用改）
 * @param attempted 去重记号（键是 agent 的 **scope**，见 {@link MaskAttempts}）。
 *   `installRoleGate` 会把它与「agent 出现 / 状态变化」那条补遮路径**共用**：谁先遮谁留下那条诊断，
 *   另一方看到 `repeat` 静默跳过。缺省自带一个，便于单测直接调用。
 */
export function createRoleGate(
  ctx: unknown,
  gated: ReadonlySet<string> = DEFAULT_GATED_TOOLS,
  attempted: MaskAttempts = new WeakSet<object>(),
  reasons?: GatedToolReasons,
): PreExecuteListener {
  return async function redteamLeadRoleGate(exec, next) {
    const view = recordOf(exec)
    const tool = typeof view.name === 'string' ? view.name : ''
    const root = rootOf(exec)
    if (root === 'root') {
      const role: GateRole = await resolveRole(ctx, exec)
      if (role === 'lead') applyMask(ctx, exec, attempted, gated)
    }
    const decision = decideGate({ tool, root, gated, reasons })
    if (decision.kind === 'deny') return decision
    return next()
  }
}

/**
 * 把角色闸挂到宿主的 `tools/pre-execute` 瀑布上，返回「闸是否真的挂上了」。
 *
 * 写法照兄弟 bundle 的成熟形状（`redteam-preset/index.js:453-502`）：
 * `ctx.effect(function* () { yield ctx.on(事件, 监听器, { prepend: true }) }, '<label>')`。
 * `prepend` 让闸先于其它策略看到这次调用；我们不接管时 `return next()`，下游决定原样保留。
 *
 * **降级而不抛**（与 LDW-8 的失败策略一致：增强失败就退回保底并记一条）：
 * - 缺 `ctx.effect`、但有 `ctx.on` ⇒ 直接挂监听器，**deny 保底照常生效**，只记一条「监听器不归本插件
 *   fiber 所有、卸载时不会自动摘」；
 * - 缺 `ctx.on` ⇒ 没有地方挂闸（deny 与遮罩都不生效），记一条**可运营的**诊断后返回 `false`。
 *
 * 这里绝不抛：`installRoleGate` 在 `apply()` 里，抛一次就等于整行插件不激活、人设与遮罩一起
 * 消失 —— 代价远大于少一道闸。
 *
 * @param ctx 插件自己的 ctx
 * @param gated 本次生效的禁表（`config.gatedTools` 解析出来的那一份）；缺省 = 默认五个
 */
export function installRoleGate(
  ctx: unknown,
  gated: ReadonlySet<string> = DEFAULT_GATED_TOOLS,
  reasons?: GatedToolReasons,
): boolean {
  const view = recordOf(ctx)
  const on = view.on
  const effect = view.effect
  if (typeof on !== 'function') {
    logGate(view, '角色闸未安装：宿主上下文缺少 ctx.on —— 这次没有任何闸（deny 与遮罩都不生效）')
    return false
  }

  const attempted: MaskAttempts = new WeakSet<object>()
  const listener = createRoleGate(view, gated, attempted, reasons)

  // LDW-24：会话根的遮罩不能等到它**第一次调工具**才下发。
  //
  // 现场（session-9b9efb94，2026-11-04 01:09）：会话空闲 13 小时后恢复，宿主把 agent 重建了
  // —— 旧 scope 连同 `restrict` 一起没了，那三个工具**重新出现在目录里**（271 + `tool-addition` ×3），
  // 直到一分多钟后它第一次调工具、pre-execute 里的 `applyMask` 才收回（268 + `tool-removal` ×3）。
  // 能力没漏（deny 是逐次判定），但"看得见"这段时间本不该存在。
  //
  // 所以在 agent 出现 / 状态变化时就把同一张遮罩补上；去重记号按 scope（与闸共用），
  // 因此同一 scope 只 `restrict` 一次、只留一条诊断。判根仍只看会话头（`rootOf`），不碰服务。
  const remaskRoot = (payload: unknown): void => {
    try {
      const agent = recordOf(payload).agent
      if (rootOf({ agent }) !== 'root') return
      applyMask(view, { agent }, attempted, gated)
    } catch {
      // 遮罩是体验：任何异常都不许穿过这里。
    }
  }

  if (typeof effect !== 'function') {
    logGate(view, '角色闸没有 fiber 所有权：宿主上下文缺少 ctx.effect —— deny 保底照常生效，监听器不随插件卸载摘除')
    on.call(view, PRE_EXECUTE_EVENT, listener, { prepend: true })
    on.call(view, AGENT_CREATED_EVENT, remaskRoot)
    on.call(view, AGENT_STATUS_EVENT, remaskRoot)
    return true
  }
  effect.call(view, function* installGate() {
    yield on.call(view, PRE_EXECUTE_EVENT, listener, { prepend: true })
    // LDW-24：这两条只服务会话根（`remaskRoot` 内部判根），补的是「agent 重建 → 首次工具调用」之间的窗口。
    yield on.call(view, AGENT_CREATED_EVENT, remaskRoot)
    yield on.call(view, AGENT_STATUS_EVENT, remaskRoot)
  }, GATE_LABEL)
  return true
}
