/**
 * LDW-16 工兵独立人设：`src/persona.ts` 的接缝测试。
 *
 * 现场（spec §起因 3）：`dsh-persona` 挂在 preset 上，工兵继承同一个 preset，于是两边系统提示词
 * 11731 字一字不差 —— 人设里那句「你是技术决策者」直接让工兵以为自己是指挥。修法不是改人设文案，
 * 而是在**工兵自己的 ctx** 上注册同名 section（`deployment:persona-prefix`），覆盖 preset 那份。
 *
 * 这里钉住四件事：
 * 1. 段名与 order 的来源 —— 名字是本包写死的字符串（不能 import `@deepseek-ai/*`），order 必须
 *    向宿主问（`getSectionOrder`），不许硬编码；
 * 2. 只落在非 Lead 的团队成员身上：Lead 与 bare subagent 都不动；
 * 3. 文本原样来自配置（一个字都不改）；
 * 4. 失败不静默、也不拖垮 `apply()`：一条日志 + 退回共享人设。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LEAD_PERSONA_KEY,
  PERSONA_LABEL,
  PERSONA_ORDER_KEY,
  PERSONA_SECTION,
  PRESET_PERSONA_LABEL,
  TEAMMATE_PERSONA_KEY,
  installPresetPersona,
  installTeammatePersona,
} from '../dist/persona.js'

/** 宿主常量在本包里的**唯一**合法写法：段名写死 + order 名字去问宿主。 */
const SECTION = 'deployment:persona-prefix'
const ORDER_KEY = 'DEPLOYMENT_PERSONA_PREFIX'

/** 一段有辨识度的配置文本（含换行与 Markdown 标题：必须逐字落地，不能被折行/裁剪）。 */
const CONFIG_TEXT = '你是这支红队的一名工兵，负责一条路线。\n\n## 你的活\n- 技术路线、工具、取舍由你定，结论由你背。'

// ---------------------------------------------------------------------------
// 替身：Cordis 的四个面 + 一个带 systemPrompt 的 agent
// ---------------------------------------------------------------------------

/** 最小 Cordis 形状：`get` 探针、`on`/`emit`、`effect`、可选 `agents`/`logger`/`systemPrompt`。 */
function fakeCordis({ services = {}, agents, logger, systemPrompt } = {}) {
  const listeners = []
  const effects = []
  const registry = agents === undefined ? undefined : {
    get(id) {
      return agents.find((candidate) => candidate?.id === id)
    },
    list() {
      return [...agents]
    },
  }
  const ctx = {
    ...(registry === undefined ? {} : { agents: registry }),
    ...(logger === undefined ? {} : { logger }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    get(service) {
      return services[service]
    },
    on(event, listener, options) {
      listeners.push({ event, listener, options })
      return () => {}
    },
    emit(event, payload) {
      for (const entry of [...listeners]) {
        if (entry.event === event) entry.listener(payload)
      }
    },
    effect(install, label) {
      const produced = install()
      if (typeof produced === 'function') {
        effects.push({ label, dispose: produced })
        return produced
      }
      let step = produced.next()
      while (step.done !== true) step = produced.next(step.value)
      effects.push({ label, dispose: undefined })
      return () => {}
    },
  }
  return { ctx, listeners, effects }
}

/** 一个独立的 `systemPrompt` 面（preset ctx 与 agent ctx 用同一份替身）。 */
function promptStub({ order = 7, orderThrows = false, sectionThrows = false } = {}) {
  const sections = []
  const orders = []
  const systemPrompt = {
    getSectionOrder(name) {
      orders.push(name)
      if (orderThrows) throw new Error('getSectionOrder 在这个 scope 不可用')
      return order
    },
    section(entry) {
      if (sectionThrows) throw new Error('prompt section "deployment:persona-prefix" is already registered in this scope')
      sections.push(entry)
      return () => {
        const index = sections.indexOf(entry)
        if (index >= 0) sections.splice(index, 1)
      }
    },
  }
  return { systemPrompt, sections, orders }
}

/** 团队服务替身：`agent-lead` 是 Lead，`agent-scout` 是工兵，其余不认。 */
function teamService() {
  return {
    tryMembership(agent) {
      if (agent?.id === 'agent-lead') return { root: 'session-root', id: 'team-1', role: 'lead', name: 'lead' }
      if (agent?.id === 'agent-scout') return { root: 'session-root', id: 'team-1', role: 'teammate', name: 'rt-scout' }
      return undefined
    },
  }
}

/**
 * 一个带 `ctx.systemPrompt` 的 agent 替身。
 *
 * `order` 刻意不是 0：只有真的调用 `getSectionOrder` 才可能拿到它（硬编码的 0 会当场露馅）。
 */
function personaAgent(id, options = {}) {
  const prompt = promptStub(options)
  return { agent: { id, ctx: { systemPrompt: prompt.systemPrompt } }, sections: prompt.sections, orders: prompt.orders }
}

/** 收集 `ctx.logger.warn` 的文本。 */
function captureLog() {
  const messages = []
  return { messages, logger: { warn: (message) => messages.push(String(message)) } }
}

// ---------------------------------------------------------------------------
// 1. 段名 / order / 文本
// ---------------------------------------------------------------------------

test('段名与 order 键都是宿主的既有常量（名字写死，order 问宿主）', () => {
  assert.equal(PERSONA_SECTION, SECTION, '段名必须是 preset 那份的同名段，否则覆盖不了、只会多一段')
  assert.equal(PERSONA_ORDER_KEY, ORDER_KEY, 'order 必须按宿主登记的名字去取')
  assert.equal(typeof PERSONA_LABEL, 'string')
  assert.ok(PERSONA_LABEL.length > 0, 'effect label 不能空')
})

test('工兵：在它自己的 ctx 上注册同名段，order 取自 getSectionOrder，文本逐字来自配置', () => {
  const scout = personaAgent('agent-scout', { order: 7 })
  const { ctx } = fakeCordis({ services: { agentTeams: teamService() }, agents: [scout.agent] })

  assert.equal(installTeammatePersona(ctx, { teammatePersona: CONFIG_TEXT }), true)

  assert.deepEqual(scout.orders, [ORDER_KEY], 'order 只能向宿主问一次，名字必须与宿主一致')
  assert.equal(scout.sections.length, 1, '一个 agent 恰好一段')
  assert.deepEqual(scout.sections[0], { name: SECTION, order: 7, text: CONFIG_TEXT }, '名字/order/文本逐字对齐')
  assert.notEqual(scout.sections[0].order, 0, 'order 绝不能硬编码成 0（宿主的分配表会漂移）')
})

test('先装后建的工兵由 agent/created 接管，且每个 scope 只注册一次', () => {
  const scout = personaAgent('agent-scout')
  const { ctx } = fakeCordis({ services: { agentTeams: teamService() }, agents: [] })
  installTeammatePersona(ctx, { teammatePersona: CONFIG_TEXT })

  assert.equal(scout.sections.length, 0, '安装时还没有这个 agent')
  ctx.emit('agent/created', { agent: scout.agent })
  assert.equal(scout.sections.length, 1)
  ctx.emit('agent/created', { agent: scout.agent })
  assert.equal(scout.sections.length, 1, '重复事件不能重复注册（同名同层第二次注册会抛）')
})

test('LDW-21：续轮重建的工兵（同 id、新 scope）必须重新注册，否则退回 Lead 那份人设', () => {
  const first = personaAgent('agent-scout', { order: 7 })
  const { ctx } = fakeCordis({ services: { agentTeams: teamService() }, agents: [first.agent] })
  installTeammatePersona(ctx, { teammatePersona: CONFIG_TEXT })
  assert.equal(first.sections.length, 1)

  // 宿主续轮时重建可续轮工兵：同一个成员 id、同一个 session，但是新的 agent 对象与新 scope。
  // 现场（2026-11-03）：turn 1 系统提示词 11,055 字（工兵那份）；turn 2 变回 11,522 字（Lead 那份）。
  const rebuilt = personaAgent('agent-scout', { order: 7 })
  ctx.emit('agent/status', { agent: rebuilt.agent })
  assert.equal(rebuilt.sections.length, 1, '重建后的 scope 上没有人设 → 续轮会退回共享人设')
  assert.deepEqual(rebuilt.sections[0], { name: SECTION, order: 7, text: CONFIG_TEXT })

  ctx.emit('agent/status', { agent: rebuilt.agent })
  assert.equal(rebuilt.sections.length, 1, '同一个 scope 只注册一次（status 每轮都来）')
  assert.equal(first.sections.length, 1, '旧 scope 不会被重复处理')
})

test('Lead 与 bare subagent：一个人设段都不加（共享人设照旧由 preset 提供）', () => {
  const lead = personaAgent('agent-lead')
  const bare = personaAgent('agent-bare')
  const scout = personaAgent('agent-scout')
  const { ctx } = fakeCordis({ services: { agentTeams: teamService() }, agents: [lead.agent, bare.agent, scout.agent] })
  installTeammatePersona(ctx, { teammatePersona: CONFIG_TEXT })

  ctx.emit('agent/created', { agent: lead.agent })
  ctx.emit('agent/created', { agent: bare.agent })

  assert.equal(lead.sections.length, 0, 'Lead 读的是共享人设：再盖一层会把 Lead 也变成工兵')
  assert.equal(bare.sections.length, 0, 'bare subagent 不在团队里，不能按工兵处理')
  assert.equal(scout.sections.length, 1, '对照：真工兵必须有自己那份')
  assert.equal(scout.sections[0].text, CONFIG_TEXT)
})

// ---------------------------------------------------------------------------
// 2. 失败路径：一条日志 + 退回共享人设，绝不抛、绝不静默
// ---------------------------------------------------------------------------

test('工兵没有 systemPrompt：记一条、不抛、这个 agent 退回共享人设', () => {
  const log = captureLog()
  const bare = { id: 'agent-scout', ctx: {} }
  const { ctx } = fakeCordis({ services: { agentTeams: teamService() }, agents: [bare], logger: log.logger })

  assert.doesNotThrow(() => installTeammatePersona(ctx, { teammatePersona: CONFIG_TEXT }))
  assert.equal(log.messages.length, 1, '缺 API 必须留一条可见诊断（静默退回 = 这个 ticket 白做）')
  assert.match(log.messages[0], /agent-scout/u, '诊断要点名是哪个 agent')
  assert.match(log.messages[0], /systemPrompt/u, '诊断要点明缺的是什么')
})

test('注册抛错（同名段已在本层）：记一条、不抛，其它工兵照常注册', () => {
  const log = captureLog()
  const broken = personaAgent('agent-scout', { sectionThrows: true })
  const healthy = personaAgent('agent-healthy')
  const { ctx } = fakeCordis({
    services: {
      agentTeams: {
        tryMembership(agent) {
          if (agent?.id === 'agent-healthy') return { role: 'teammate', name: 'healthy' }
          return teamService().tryMembership(agent)
        },
      },
    },
    agents: [broken.agent, healthy.agent],
    logger: log.logger,
  })

  assert.doesNotThrow(() => installTeammatePersona(ctx, { teammatePersona: CONFIG_TEXT }))
  assert.equal(log.messages.length, 1, '失败的 agent 一条，成功的不吵')
  assert.match(log.messages[0], /agent-scout/u)
  assert.match(log.messages[0], /already registered/u, '诊断要带原始失败信息')
  assert.equal(healthy.sections.length, 1, '一个 agent 失败不能拖垮其它工兵')
})

test('配置缺 teammatePersona：安装时一条日志、不注册、不抛（退回共享人设）', () => {
  const log = captureLog()
  const scout = personaAgent('agent-scout')
  const { ctx } = fakeCordis({ services: { agentTeams: teamService() }, agents: [scout.agent], logger: log.logger })

  assert.equal(installTeammatePersona(ctx, {}), false)
  assert.equal(scout.sections.length, 0)
  assert.equal(log.messages.length, 1, '配置缺失只能记一条（不按 agent 刷屏）')
  assert.match(log.messages[0], /teammatePersona/u, '诊断要点名缺的是哪个配置项')

  // 空串同样不算有效文本：空段会在渲染时被丢掉，等于没配。
  const blank = captureLog()
  const cordis = fakeCordis({ services: { agentTeams: teamService() }, agents: [scout.agent], logger: blank.logger })
  assert.equal(installTeammatePersona(cordis.ctx, { teammatePersona: '   ' }), false)
  assert.equal(blank.messages.length, 1)
})

test('宿主缺 ctx.on：返回 false 并记一条，绝不抛', () => {
  const log = captureLog()
  const scout = personaAgent('agent-scout')
  const { ctx } = fakeCordis({ services: { agentTeams: teamService() }, agents: [scout.agent], logger: log.logger })
  delete ctx.on

  assert.equal(installTeammatePersona(ctx, { teammatePersona: CONFIG_TEXT }), false)
  assert.equal(scout.sections.length, 0, '没有 agent/created 就没有后建的工兵，宁可不装')
  assert.equal(log.messages.length, 1)
  assert.match(log.messages[0], /ctx\.on/u)
})

// ---------------------------------------------------------------------------
// 3. 归属：section 的 disposer 归插件 fiber
// ---------------------------------------------------------------------------

test('注册返回的 disposer 归插件 fiber：卸载时把这个段收回去', () => {
  const scout = personaAgent('agent-scout')
  const { ctx, effects } = fakeCordis({ services: { agentTeams: teamService() }, agents: [scout.agent] })
  installTeammatePersona(ctx, { teammatePersona: CONFIG_TEXT })

  const effect = effects.find((entry) => entry.label === PERSONA_LABEL)
  assert.ok(effect, '段注册必须在插件的 ctx.effect 上留一个可回收的 disposer')
  assert.equal(typeof effect.dispose, 'function')
  assert.equal(scout.sections.length, 1, '插件还在跑时不得收回')

  effect.dispose()
  assert.equal(scout.sections.length, 0, '插件卸载要把自己盖的那一段一起收走')
})

// ---------------------------------------------------------------------------
// 4. preset 层的 Lead 人设（`leadPersona`）：同时是全队的共享兜底
// ---------------------------------------------------------------------------
//
// 这一段以前由 preset 的 `dsh-persona` 行提供（`config.prefix`）。LDW-16 把文本搬进本包配置，
// 由本插件在**自己的 ctx**（= preset 作用域）注册同一段：Lead 读它，没被单独覆盖的 agent
// （bare subagent、注册失败的工兵）也读它。工兵那份在 agent ctx 上遮蔽它。

/** 一份 Lead 人设文本（与工兵那份必须不同，才能证明两边真的分开了）。 */
const LEAD_TEXT = '你是一名资深逆向工程师，是这支红队的技术决策者。\n\n## 红队作业准则\n- 只在已授权的目标与范围内作业。'

test('Lead 人设：注册在插件自己的 ctx 上（preset 作用域）、同名同 order、文本逐字', () => {
  const prompt = promptStub({ order: 7 })
  const { ctx, effects } = fakeCordis({ systemPrompt: prompt.systemPrompt })

  assert.equal(installPresetPersona(ctx, { leadPersona: LEAD_TEXT }), true)
  assert.deepEqual(prompt.orders, [ORDER_KEY], 'order 必须向宿主问')
  assert.deepEqual(prompt.sections, [{ name: SECTION, order: 7, text: LEAD_TEXT }])
  assert.ok(effects.some((entry) => entry.label === PRESET_PERSONA_LABEL), 'disposer 必须归插件 fiber')
})

test('Lead 人设与工兵人设是两份文本：同一个插件里各注册一次，互不覆盖', () => {
  const preset = promptStub({ order: 0 })
  const scout = personaAgent('agent-scout', { order: 0 })
  const { ctx } = fakeCordis({
    services: { agentTeams: teamService() },
    agents: [scout.agent],
    systemPrompt: preset.systemPrompt,
  })

  installPresetPersona(ctx, { leadPersona: LEAD_TEXT })
  installTeammatePersona(ctx, { teammatePersona: CONFIG_TEXT })

  assert.equal(preset.sections.length, 1, 'preset 层只有 Lead 那一份')
  assert.equal(preset.sections[0].text, LEAD_TEXT)
  assert.equal(scout.sections.length, 1, '工兵在自己那层盖一份')
  assert.equal(scout.sections[0].text, CONFIG_TEXT)
  assert.notEqual(preset.sections[0].text, scout.sections[0].text, '两边文本必须不同（这正是本票要的）')
  // spec 验收 4：工兵那份不含「指挥」字样，否则它还是会以为自己是 Lead。
  assert.ok(!scout.sections[0].text.includes('指挥'), '工兵人设里不得出现「指挥」')
})

test('Lead 人设：配置缺失 / 没有 systemPrompt / 注册抛错 —— 都只记一条、不抛', () => {
  const missingConfig = captureLog()
  const withPrompt = fakeCordis({ systemPrompt: promptStub().systemPrompt, logger: missingConfig.logger })
  assert.equal(installPresetPersona(withPrompt.ctx, {}), false)
  assert.equal(missingConfig.messages.length, 1)
  assert.match(missingConfig.messages[0], new RegExp(LEAD_PERSONA_KEY, 'u'))

  const noApi = captureLog()
  const bare = fakeCordis({ logger: noApi.logger })
  assert.doesNotThrow(() => installPresetPersona(bare.ctx, { leadPersona: LEAD_TEXT }))
  assert.equal(noApi.messages.length, 1)
  assert.match(noApi.messages[0], /systemPrompt/u)

  const rejected = captureLog()
  const broken = fakeCordis({ systemPrompt: promptStub({ sectionThrows: true }).systemPrompt, logger: rejected.logger })
  assert.doesNotThrow(() => installPresetPersona(broken.ctx, { leadPersona: LEAD_TEXT }))
  assert.equal(rejected.messages.length, 1)
  assert.match(rejected.messages[0], /already registered/u)
  // 三条诊断都必须走宿主日志通道并带自己的 label：否则日志里认不出是谁在退化。
  for (const message of [...missingConfig.messages, ...noApi.messages, ...rejected.messages]) {
    assert.ok(message.startsWith(`[${PRESET_PERSONA_LABEL}]`), `诊断必须带 [${PRESET_PERSONA_LABEL}] 前缀：${message}`)
  }
})

// ---------------------------------------------------------------------------
// 5. `apply()` 的存活：人设装不上，角色闸与工兵遮罩照旧
// ---------------------------------------------------------------------------

/** 一个够 `apply()` 跑的宿主替身：工具注册表 + 事件总线 + 一个没有 systemPrompt 的工兵。 */
function pluginWorld() {
  const registered = new Map()
  const log = captureLog()
  const scout = { id: 'agent-scout', ctx: {} }
  const cordis = fakeCordis({
    services: { agentTeams: teamService() },
    agents: [scout],
    logger: log.logger,
  })
  cordis.ctx.tools = {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
  return { ...cordis, registered, log }
}

test('apply() 在人设装不上时照常挂闸：一条日志、不抛、注册零个工具（LDW-23 后本包不再有工具）', async () => {
  const index = await import('../dist/index.js')
  const world = pluginWorld()

  // 这个宿主没有 systemPrompt：Lead 那份与工兵那份都装不上（配置是齐的）。
  assert.doesNotThrow(() => index.apply(world.ctx, { defaults: {}, leadPersona: LEAD_TEXT, teammatePersona: CONFIG_TEXT }))

  assert.deepEqual([...world.registered.keys()], [], '本包不注册任何工具：账目归 skill（LDW-23）')
  const personaNotes = world.log.messages.filter((message) => /人设/u.test(message))
  assert.equal(personaNotes.length, 2, '两条人设路径各自退化都要留痕（preset 一条 + 工兵一条）')
  assert.ok(world.listeners.some((entry) => entry.event === 'tools/pre-execute'), '角色闸照旧挂上')
  assert.ok(world.listeners.some((entry) => entry.event === 'agent/status'), '工兵遮罩/人设挂 status（LDW-21）')
})

