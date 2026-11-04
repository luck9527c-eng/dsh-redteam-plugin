/**
 * LDW-20：**未注入的服务在宿主 ctx 上直读会抛**，探针必须退到 `ctx.get(name)`。
 *
 * 现场（session-59a823a8，2026-11-02 20:21–23:53）：整轮人设没送达、工兵遮罩没落地，
 * 而 511 个测试全绿、插件也正常注册了两个 `rt_*`。原因不在功能代码，在**替身比宿主宽容**：
 * 所有 fake 都写成 `ctx.systemPrompt` 可以直接读，而真实 Cordis 的 ctx 是 Proxy，读一个
 * 没写进 `inject` 的服务时抛 `cannot get property "x" without inject`
 * （`cordis/src/reflect.ts` 的 get trap）。
 *
 * 本包的三个探针当时都是「直读优先，抛了就当服务缺席」：
 * - `src/persona.ts` 的 `promptOf`：直读抛 → `unavailable` → 只 warn 一句 → 人设静默不上；
 * - `src/gate.ts` 的 `memberRoleOf`：直读抛 → `unknown` → 工兵人设与工兵遮罩一起静默跳过；
 * - `src/gate.ts` 的 `agentRegistry`：直读抛 → 空表 → 安装时扫不到任何 agent。
 *
 * 这个文件用**真实形状**的替身钉住三件事：直读抛错时三个探针仍能取到服务；两种读法都没有时
 * 仍按原样 fail-open（不放宽任何闸）。
 *
 * 配套的契约（`inject` 里必须有哪几个名字）由 `test/bundle.test.mjs` 钉住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { liveAgents, memberRoleOf } from '../dist/gate.js'
import { installPresetPersona, PRESET_PERSONA_LABEL } from '../dist/persona.js'

/** 宿主代理的报错原文形状（`cordis/src/reflect.ts`）。 */
function withoutInject(prop) {
  return new Error(`cannot get property "${String(prop)}" without inject`)
}

/**
 * 一个**照真实 Cordis 形状**说话的 ctx：
 * - 核心面（`on`/`effect`/`logger`）照旧直接可读 —— 它们不是服务，不需要 inject；
 * - 其它任何属性（含未注入的服务）**直读一律抛**；
 * - `ctx.get(name)` 不走 inject，能读到服务（`reflect.get(name, strict)`）。
 */
function strictCtx({ services = {}, logger, ...plain } = {}) {
  const target = {
    on() {},
    effect(install) {
      return runEffect(install)
    },
    logger: logger ?? { warn() {} },
    ...plain,
    get(name) {
      return services[name]
    },
  }
  return new Proxy(target, {
    get(object, prop) {
      if (prop in object) return object[prop]
      throw withoutInject(prop)
    },
    has(object, prop) {
      return prop in object
    },
  })
}

/** 团队服务替身：`agent-scout` 是工兵，`agent-lead` 是 Lead，其余不认（与宿主同一套语义）。 */
function teamService() {
  return {
    tryMembership(agent) {
      if (agent?.id === 'agent-lead') return { root: 'session-root', id: 'team-1', role: 'lead', name: 'lead' }
      if (agent?.id === 'agent-scout') return { root: 'session-root', id: 'team-1', role: 'teammate', name: 'rt-scout' }
      return undefined
    },
  }
}

/** `systemPrompt` 面：只认宿主给的两个方法。 */
function promptStub({ order = 7 } = {}) {
  const sections = []
  return {
    sections,
    systemPrompt: {
      getSectionOrder() {
        return order
      },
      section(entry) {
        sections.push(entry)
        return () => {}
      },
    },
  }
}

/** 收集 `ctx.logger.warn`。 */
function captureLog() {
  const messages = []
  return { messages, logger: { warn: (message) => messages.push(String(message)) } }
}

/** 跑一个生成器式或函数式的 `ctx.effect`（宿主两种形状都有）。 */
function runEffect(install) {
  const produced = install()
  if (typeof produced === 'function') return produced
  let step = produced.next()
  while (step.done !== true) step = produced.next(step.value)
  return () => {}
}

// ---------------------------------------------------------------------------
// 1. 直读抛错时，三个探针仍然取得到服务
// ---------------------------------------------------------------------------

test('memberRoleOf：未注入的 agentTeams 直读会抛，探针应退到 ctx.get 并认出工兵', () => {
  const ctx = strictCtx({ services: { agentTeams: teamService() } })
  assert.throws(() => ctx.agentTeams, /without inject/u, '替身必须真的按宿主形状抛错')
  assert.equal(memberRoleOf(ctx, { id: 'agent-scout' }), 'teammate', '直读抛错不等于服务缺席')
  assert.equal(memberRoleOf(ctx, { id: 'agent-lead' }), 'lead')
  assert.equal(memberRoleOf(ctx, { id: 'someone-else' }), 'unknown')
})

test('liveAgents：未注入的 agents 直读会抛，探针应退到 ctx.get 并列出活的 agent', () => {
  const agents = [{ id: 'agent-lead' }, { id: 'agent-scout' }]
  const registry = {
    list: () => [...agents],
    get: (id) => agents.find((candidate) => candidate.id === id),
  }
  const ctx = strictCtx({ services: { agents: registry } })
  assert.throws(() => ctx.agents, /without inject/u)
  assert.deepEqual(
    liveAgents(ctx).map((agent) => agent.id),
    ['agent-lead', 'agent-scout'],
  )
})

test('installPresetPersona：未注入的 systemPrompt 直读会抛，人设仍必须注册（这正是 20:21 那一轮的失效点）', () => {
  const prompt = promptStub({ order: 7 })
  const ctx = strictCtx({ services: { systemPrompt: prompt.systemPrompt } })
  assert.throws(() => ctx.systemPrompt, /without inject/u)

  assert.equal(installPresetPersona(ctx, { leadPersona: '你是这支红队的 Lead。' }), true, '注册失败会让人设静默消失')
  assert.equal(prompt.sections.length, 1)
  assert.equal(prompt.sections[0].text, '你是这支红队的 Lead。')
})

// ---------------------------------------------------------------------------
// 2. 两种读法都拿不到时：保持原来的 fail-open，并且留一条诊断
// ---------------------------------------------------------------------------

test('两种读法都没有：memberRoleOf 仍是 unknown（fail-open 不变）', () => {
  const ctx = strictCtx({ services: {} })
  assert.equal(memberRoleOf(ctx, { id: 'agent-scout' }), 'unknown')
  assert.deepEqual(liveAgents(ctx), [])
})

test('两种读法都没有：preset 人设不装，且必须留下一条 warn（不许静默）', () => {
  const log = captureLog()
  const ctx = strictCtx({ services: {}, logger: log.logger })

  assert.equal(installPresetPersona(ctx, { leadPersona: '你是这支红队的 Lead。' }), false)
  assert.equal(log.messages.length, 1)
  assert.match(log.messages[0], new RegExp(PRESET_PERSONA_LABEL.replace('/', '\\/'), 'u'))
  assert.match(log.messages[0], /systemPrompt/u)
})

// ---------------------------------------------------------------------------
// 3. `ctx.effect` 必须照旧被用上（注册的 disposer 归本插件 fiber）
// ---------------------------------------------------------------------------

test('人设段落的 disposer 交给 ctx.effect 持有，而不是就地丢掉', () => {
  const prompt = promptStub()
  const labels = []
  const ctx = strictCtx({
    services: { systemPrompt: prompt.systemPrompt },
    effect(install, label) {
      labels.push(label)
      return runEffect(install)
    },
  })

  assert.equal(installPresetPersona(ctx, { leadPersona: '文本' }), true)
  assert.deepEqual(labels, [PRESET_PERSONA_LABEL], 'disposer 必须挂在本插件 fiber 上')
})
