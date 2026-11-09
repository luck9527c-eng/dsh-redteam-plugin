/**
 * 工兵的固定路由（2026-11-09）。
 *
 * 为什么需要这一层：子 agent **创建时继承 Lead 那一刻的路由**。`spawn_teammate` 的请求里没有
 * model 字段，团队服务 `startActivation` 也不传 `agentOptions`，于是 `dsh-subagent` 的
 * `resolveChildAgentOptions(parent, undefined, depth)` 从父的 `requestHeader().config` 里取
 * provider / model / reasoningEffort。想「Lead 用贵的、工兵用便宜的」，过去只能在每次 spawn 前
 * 手动把 Lead 切过去、spawn 完再切回来 —— 忘一次就漏一个工兵。
 *
 * 这里把工兵那条**钉死**：非 root 成员建出来后替它 `agent.model.select(...)` 一次。
 *
 * 三条形状约束：
 * 1. **`Agent.model` 是公开属性**（`readonly model: Model`，`Model.select(selection): void`）。
 *    `select()` 同步、无业务异常，内容相同直接 return，不同则往该 agent 自己的会话日志里
 *    append 一条 `model/selection` —— 所以这是**持久、可审计**的选择，不是内存里的临时补丁。
 * 2. **只碰非 root 的团队成员**（{@link isTeammateRole}）：Lead 一个字节都不动，它自己选什么模型
 *    完全不受影响。
 * 3. **按 `agent.ctx` 去重**：同一 scope 只钉一次；成员被宿主重建时是新 scope，会再钉一次 ——
 *    这正是「固定」的语义（手工改只活到下一次重建）。
 *
 * 与其它安装器一样**只降级、不抛**：路由是增强，装不上就一条 warn，绝不能让角色闸、
 * 两套人设和工兵遮罩跟着一起消失。
 *
 * @module @local/dsh-redteam-lead/teammate-model
 */

import { isTeammateRole, liveAgents, logAt, memberRoleOf } from './gate.js'
import type { GateRole } from './gate.js'
import { isRecord, recordOf, serviceOf, thrownMessage } from './guards.js'

/** 配置键：工兵固定使用的路由。缺了它就不钉（工兵继续继承 Lead 的路由）。 */
export const TEAMMATE_MODEL_KEY = 'teammateModel'

/** 诊断与 effect 的 label。 */
export const TEAMMATE_MODEL_LABEL = 'redteam-lead/teammate-model'

/** 监听器自己的 effect label（与逐 agent 的 select 分开：卸载顺序与诊断都要能分辨）。 */
export const TEAMMATE_MODEL_INSTALL_LABEL = 'redteam-lead/teammate-model:install'

/** 宿主建 agent 与每次状态切换时广播的事件（与遮罩、人设同一组 seam）。 */
const AGENT_CREATED_EVENT = 'agent/created'
const AGENT_STATUS_EVENT = 'agent/status'

/** 一条路由：与宿主 `ModelSelection` 同形，但本包不认识它的类型（不能 import `@deepseek-ai/*`）。 */
export interface TeammateModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** 形状解析结果：要么给出路由，要么给出一句「哪里不对」。 */
type Parsed = { selection: TeammateModelSelection } | { problem: string }

/** 非空白字符串才算配了；空白串在宿主的 schema 里等同于没写。 */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** 畸形配置的诊断里「实际是什么」：只说形状，不把整份配置倒进日志。 */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `数组（${value.length} 项）`
  if (typeof value === 'string') return `字符串（${value.length} 字符）`
  if (typeof value === 'object') return '对象'
  return typeof value
}

/** thenable 判定：只认带函数 `then` 的对象（宿主不一定用原生 Promise）。 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

/**
 * 纯形状解析：`provider` 与 `model` 必须是非空字符串，`reasoningEffort` 给了也必须非空。
 *
 * 不在这里记日志：{@link resolveTeammateModel} 才持有 ctx，纯函数更好测。
 */
export function selectionOf(value: unknown): Parsed {
  if (!isRecord(value)) return { problem: `实际是${describe(value)}，不是对象` }
  const record = recordOf(value)
  const provider = textOf(record.provider)
  if (provider === undefined) return { problem: 'provider 必须是非空字符串' }
  const model = textOf(record.model)
  if (model === undefined) return { problem: 'model 必须是非空字符串' }
  const effort = record.reasoningEffort
  if (effort !== undefined && textOf(effort) === undefined) {
    return { problem: 'reasoningEffort 要么不写，要么写成非空字符串' }
  }
  const reasoningEffort = textOf(effort)
  return { selection: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } }
}

/**
 * 解析 `config.teammateModel`：本次要钉给工兵的那条路由。
 *
 * 缺键 → `undefined`（**不记警告**：这是「不钉」的正常态，工兵回到宿主默认的继承行为）；
 * 形状畸形 → 一条 `ctx.logger.warn` + `undefined`，绝不退回任何猜出来的默认模型。
 *
 * 为什么畸形不猜一个默认：钉错模型不是「少一层增强」，而是让每个工兵在第一次请求时失败。
 * 宁可不钉、留在继承行为上，也不要拿一条没人配过的路由去跑。
 *
 * @param config 本包行的 `config`（读 `teammateModel`）
 * @param ctx 插件 ctx（诊断走它的 logger）
 * @returns 本次生效的路由；没配或配坏了就是 `undefined`。绝不抛。
 */
export function resolveTeammateModel(config: unknown, ctx?: unknown): TeammateModelSelection | undefined {
  const raw = recordOf(config)[TEAMMATE_MODEL_KEY]
  if (raw === undefined) return undefined
  const parsed = selectionOf(raw)
  if ('selection' in parsed) return parsed.selection
  logAt(
    ctx,
    TEAMMATE_MODEL_LABEL,
    `config.${TEAMMATE_MODEL_KEY} 形状不合法（${parsed.problem}）：本次不钉工兵路由，` +
      '工兵继续继承 Lead 创建时的路由',
  )
  return undefined
}

/**
 * 给一个 agent 的模型选择面下一次 `select`。
 *
 * @param modelOwner 一个持有 `model` 的对象（实际传 agent）
 * @param selection 要钉的路由（复制一份再传，宿主可能保留引用）
 * @returns `undefined` = 钉成功；否则是一句「为什么没钉上」的诊断文本。绝不抛。
 */
export function selectRoute(modelOwner: unknown, selection: TeammateModelSelection): string | undefined {
  const model = recordOf(recordOf(modelOwner).model)
  const select = model.select
  if (typeof select !== 'function') {
    return '拿不到 agent.model.select —— 工兵继续继承 Lead 的路由'
  }
  try {
    select.call(model, { ...selection })
    return undefined
  } catch (error) {
    return `agent.model.select 被拒（${thrownMessage(error)}）—— 工兵继续继承 Lead 的路由`
  }
}

/**
 * 装好后立刻做一次的**尽力**校验：配置的 provider/model 在 llm 注册表里解析得动吗？
 *
 * 只服务诊断：`select()` 本身不校验路由，写错模型要到工兵第一次请求时才会炸，而且那时看起来
 * 像「模型服务坏了」。这里提前把话说清楚。解析得动就一个字都不说。
 *
 * 拿不到 `llm`、方法不是函数、返回不是 thenable —— 一律静默返回（校验是增强）。
 */
function verifyRoute(view: Record<string, unknown>, selection: TeammateModelSelection): void {
  try {
    const llm = recordOf(serviceOf(view, 'llm'))
    const resolve = llm.resolveModelInfo
    if (typeof resolve !== 'function') return
    const pending = resolve.call(llm, selection.provider, selection.model)
    if (!isThenable(pending)) return
    void Promise.resolve(pending).then(
      () => {
        // 解析得动：什么都不用说。
      },
      (error: unknown) => {
        logAt(
          view,
          TEAMMATE_MODEL_LABEL,
          `配置的工兵路由 ${selection.provider}/${selection.model} 在 llm 注册表里解析不了` +
            `（${thrownMessage(error)}）—— 工兵第一次请求会失败，请核对 ${TEAMMATE_MODEL_KEY}`,
        )
      },
    )
  } catch {
    // 校验失败不影响钉路由本身。
  }
}

/**
 * 安装入口：给每个**非 Lead 的团队成员**钉住路由。
 *
 * 与遮罩、人设同一条 seam：建人之后才出现的成员走 `agent/created`；插件也可能在会话中途挂上
 * （HMR / preset 重载），那时已有的成员必须一并处理（安装时扫一遍 `ctx.agents.list()`）。
 * `agent/status` 也挂，因为可续轮的成员在续轮时会被宿主**重建**（同一个 id、新的 agent 对象与
 * 新 scope），那时需要在新 scope 上再钉一次。
 *
 * 返回「监听器有没有装上」；`apply()` 不消费它 —— 路由钉不上不能影响角色闸与人设。
 *
 * @param ctx 本插件的 ctx
 * @param config 本包行配置（读 `teammateModel`）
 */
export function installTeammateModel(ctx: unknown, config: unknown): boolean {
  const view = recordOf(ctx)
  const selection = resolveTeammateModel(config, view)
  if (selection === undefined) {
    logAt(
      view,
      TEAMMATE_MODEL_LABEL,
      `工兵路由未钉：插件配置缺少有效的 ${TEAMMATE_MODEL_KEY} —— 工兵仍继承 Lead 创建时的路由`,
    )
    return false
  }
  verifyRoute(view, selection)

  const on = view.on
  if (typeof on !== 'function') {
    logAt(view, TEAMMATE_MODEL_LABEL, '工兵路由未钉：宿主上下文缺少 ctx.on —— 工兵仍继承 Lead 创建时的路由')
    return false
  }

  // 键必须是 `agent.ctx` 而不是 id：可续轮的成员在下一轮会被宿主重建（同 id、新 scope）。
  const handled = new WeakSet<object>()
  const pinNow = (agent: unknown, role: GateRole): void => {
    if (!isTeammateRole(role)) return
    const scope = recordOf(agent).ctx
    if (!isRecord(scope)) return
    if (handled.has(scope)) return
    handled.add(scope)
    const failure = selectRoute(agent, selection)
    if (failure === undefined) return
    const id = recordOf(agent).id
    logAt(view, TEAMMATE_MODEL_LABEL, `${typeof id === 'string' && id.length > 0 ? id : '工兵'} 的路由：${failure}`)
  }
  const maybePin = (agent: unknown): void => {
    try {
      const role = memberRoleOf(view, agent)
      if (isThenable(role)) {
        void Promise.resolve(role).then(
          (resolved: GateRole) => pinNow(agent, resolved),
          () => {
            // 身份判不出来就不动（工兵继续继承 Lead 的路由）。
          },
        )
        return
      }
      pinNow(agent, role as GateRole)
    } catch {
      // 同步探针炸了也不许打断建人流程。
    }
  }

  for (const agent of liveAgents(view)) maybePin(agent)
  const listener = (payload: unknown): void => {
    maybePin(recordOf(payload).agent)
  }
  const effect = view.effect
  if (typeof effect === 'function') {
    try {
      effect.call(view, function* installTeammateModelSeam() {
        yield on.call(view, AGENT_CREATED_EVENT, listener)
        yield on.call(view, AGENT_STATUS_EVENT, listener)
      }, TEAMMATE_MODEL_INSTALL_LABEL)
      return true
    } catch {
      // effect 登记失败：退回直接挂监听器（路由照常生效，只是不随 fiber 摘除）。
    }
  }
  try {
    on.call(view, AGENT_CREATED_EVENT, listener)
    on.call(view, AGENT_STATUS_EVENT, listener)
  } catch {
    logAt(view, TEAMMATE_MODEL_LABEL, '工兵路由未钉：ctx.on 拒绝登记 agent/created 监听器')
    return false
  }
  logAt(
    view,
    TEAMMATE_MODEL_LABEL,
    '工兵路由没有 fiber 所有权：宿主上下文缺少 ctx.effect —— 照常生效，监听器不随插件卸载摘除',
  )
  return true
}
