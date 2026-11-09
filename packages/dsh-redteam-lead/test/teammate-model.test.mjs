/**
 * 工兵固定路由：`src/teammate-model.ts` 的接缝测试。
 *
 * 钉住五件事：
 * 1. 配置键形状：provider / model 必须非空；畸形**整份忽略**并恰好一条警告，绝不猜一个默认模型；
 * 2. 只对非 root 的团队成员生效：Lead 一个字节都不动；
 * 3. 同一作用域只 `select` 一次；成员被重建（新作用域）时必须再钉一次；
 * 4. 拿不到 `agent.model.select`、或它抛错 —— 只 warn，不拖垮安装；
 * 5. 安装器永远不抛（`apply()` 抛一次等于整行插件不激活）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TEAMMATE_MODEL_KEY,
  TEAMMATE_MODEL_LABEL,
  installTeammateModel,
  resolveTeammateModel,
  selectRoute,
  selectionOf,
} from '../dist/teammate-model.js'

/** 本次要钉的路由（测试里逐字比对）。 */
const ROUTE = { provider: 'wb-proxy', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' }

// ---------------------------------------------------------------------------
// 替身
// ---------------------------------------------------------------------------

/** 最小 Cordis 形状：`get` 探针、`on`/`emit`、可选 `effect`/`agents`/`logger`。 */
function fakeCordis({ services = {}, agents, logger, withEffect = true } = {}) {
  const listeners = []
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
    get(service) {
      return services[service]
    },
    on(event, listener) {
      listeners.push({ event, listener })
      return () => {}
    },
    emit(event, payload) {
      for (const entry of [...listeners]) {
        if (entry.event === event) entry.listener(payload)
      }
    },
  }
  if (withEffect) {
    ctx.effect = (install) => {
      const produced = install()
      let step = produced.next()
      while (step.done !== true) step = produced.next(step.value)
      return () => {}
    }
  }
  return { ctx, listeners }
}

/** 团队服务替身：`agent-lead` 是 Lead，`agent-scout` / `agent-other` 是成员，其余不认。 */
function teamService() {
  return {
    tryMembership(agent) {
      if (agent?.id === 'agent-lead') return { root: 'session-root', id: 'team-1', role: 'lead', name: 'lead' }
      if (agent?.id === 'agent-scout') return { root: 'session-root', id: 'team-1', role: 'teammate', name: 'rt-scout' }
      if (agent?.id === 'agent-other') return { root: 'session-root', id: 'team-1', role: 'other', name: 'rt-other' }
      return undefined
    },
  }
}

/** 一个带 `model.select` 的 agent 替身；`scope` 决定去重粒度（重建 = 换一个新对象）。 */
function agentStub(id, { scope = {}, selectThrows = false, noModel = false } = {}) {
  const calls = []
  const agent = { id, ctx: scope }
  if (!noModel) {
    agent.model = {
      current() {
        return undefined
      },
      select(selection) {
        if (selectThrows) throw new Error('model/selection append failed')
        calls.push(selection)
      },
    }
  }
  return { agent, calls }
}

/** 收集 `ctx.logger.warn` 的文本。 */
function captureLog() {
  const messages = []
  return { messages, logger: { warn: (message) => messages.push(String(message)) } }
}

// ---------------------------------------------------------------------------
// 1. 形状解析
// ---------------------------------------------------------------------------

test('形状：provider 与 model 必填，reasoningEffort 可选', () => {
  assert.deepEqual(selectionOf(ROUTE), { selection: ROUTE })

  const bare = selectionOf({ provider: 'p', model: 'm' })
  assert.deepEqual(bare, { selection: { provider: 'p', model: 'm' } }, '不给 effort 时不能凭空补一个')
  assert.equal('reasoningEffort' in (bare.selection ?? {}), false)

  for (const bad of [null, 'wb-proxy', [], 7]) {
    const parsed = selectionOf(bad)
    assert.equal('problem' in parsed, true, `${JSON.stringify(bad)} 必须被拒`)
  }
  assert.equal('problem' in selectionOf({ model: 'm' }), true, '缺 provider 必须被拒')
  assert.equal('problem' in selectionOf({ provider: 'p' }), true, '缺 model 必须被拒')
  assert.equal('problem' in selectionOf({ provider: '  ', model: 'm' }), true, '空白 provider 必须被拒')
  assert.equal('problem' in selectionOf({ provider: 'p', model: 'm', reasoningEffort: 3 }), true, '非字符串 effort 必须被拒')
})

test('缺键 = 不钉（正常态，不记警告）', () => {
  const log = captureLog()
  assert.equal(resolveTeammateModel({}, { logger: log.logger }), undefined)
  assert.deepEqual(log.messages, [], '没配就不是错误')
})

test('畸形配置：整份忽略，恰好一条警告，绝不猜默认模型', () => {
  const log = captureLog()
  const bogus = [{ provider: 'p' }, { provider: 'p', model: '' }, 'deepseek-v4.1-flash', null, 42]
  for (const value of bogus) {
    log.messages.length = 0
    assert.equal(resolveTeammateModel({ [TEAMMATE_MODEL_KEY]: value }, { logger: log.logger }), undefined)
    assert.equal(log.messages.length, 1, `${JSON.stringify(value)}：必须恰好一条警告`)
    assert.match(log.messages[0], /teammateModel/u, '警告必须点名配置键')
    assert.match(log.messages[0], /继承 Lead/u, '警告必须说清退回的是继承行为')
  }
})

// ---------------------------------------------------------------------------
// 2. 只钉工兵
// ---------------------------------------------------------------------------

test('工兵被钉住：select 收到的就是配置那条路由，逐字一致', () => {
  const scout = agentStub('agent-scout')
  const lead = agentStub('agent-lead')
  const { ctx } = fakeCordis({ services: { agentTeams: teamService() }, agents: [lead.agent, scout.agent] })

  assert.equal(installTeammateModel(ctx, { [TEAMMATE_MODEL_KEY]: ROUTE }), true)

  assert.deepEqual(scout.calls, [ROUTE], '工兵恰好钉一次，参数逐字一致')
  assert.deepEqual(lead.calls, [], 'Lead 一个字节都不动')
})

test('other（非 Lead 的团队角色）也钉；团队不认的 agent 不动', () => {
  const other = agentStub('agent-other')
  const stranger = agentStub('agent-stranger')
  const { ctx } = fakeCordis({
    services: { agentTeams: teamService() },
    agents: [other.agent, stranger.agent],
  })

  installTeammateModel(ctx, { [TEAMMATE_MODEL_KEY]: ROUTE })

  assert.deepEqual(other.calls, [ROUTE])
  assert.deepEqual(stranger.calls, [], '判不出成员身份就不动（继续继承 Lead 的路由）')
})

// ---------------------------------------------------------------------------
// 3. 去重与重建
// ---------------------------------------------------------------------------

test('先装后建：agent/created 接管；同一作用域重复事件只钉一次', () => {
  const scout = agentStub('agent-scout')
  const { ctx } = fakeCordis({ services: { agentTeams: teamService() }, agents: [] })
  installTeammateModel(ctx, { [TEAMMATE_MODEL_KEY]: ROUTE })

  assert.deepEqual(scout.calls, [], '安装时还没有这个成员')
  ctx.emit('agent/created', { agent: scout.agent })
  assert.deepEqual(scout.calls, [ROUTE])
  ctx.emit('agent/created', { agent: scout.agent })
  ctx.emit('agent/status', { agent: scout.agent })
  assert.equal(scout.calls.length, 1, '同一作用域不能反复 select')
})

test('续轮重建（同 id、新作用域）必须重新钉一次', () => {
  const first = agentStub('agent-scout', { scope: { epoch: 1 } })
  const { ctx } = fakeCordis({ services: { agentTeams: teamService() }, agents: [first.agent] })
  installTeammateModel(ctx, { [TEAMMATE_MODEL_KEY]: ROUTE })
  assert.equal(first.calls.length, 1)

  const rebuilt = agentStub('agent-scout', { scope: { epoch: 2 } })
  ctx.emit('agent/status', { agent: rebuilt.agent })
  assert.equal(rebuilt.calls.length, 1, '重建后的新作用域必须再钉一次（否则「固定」只固定一轮）')
})

// ---------------------------------------------------------------------------
// 4. 降级：拿不到 / 抛错 / 装不上
// ---------------------------------------------------------------------------

test('拿不到 agent.model.select：一条警告，安装器不抛', () => {
  const bare = agentStub('agent-scout', { noModel: true })
  const log = captureLog()
  const { ctx } = fakeCordis({
    services: { agentTeams: teamService() },
    agents: [bare.agent],
    logger: log.logger,
  })

  assert.equal(installTeammateModel(ctx, { [TEAMMATE_MODEL_KEY]: ROUTE }), true)
  assert.equal(log.messages.length, 1)
  assert.match(log.messages[0], /agent-scout/u, '诊断要点名是哪个成员')
  assert.match(log.messages[0], /agent\.model\.select/u)
})

test('select 抛错：只警告，且不影响同批其它成员', () => {
  const broken = agentStub('agent-scout', { selectThrows: true })
  const healthy = agentStub('agent-other')
  const log = captureLog()
  const { ctx } = fakeCordis({
    services: { agentTeams: teamService() },
    agents: [broken.agent, healthy.agent],
    logger: log.logger,
  })

  assert.doesNotThrow(() => installTeammateModel(ctx, { [TEAMMATE_MODEL_KEY]: ROUTE }))
  assert.equal(log.messages.length, 1)
  assert.match(log.messages[0], /select 被拒/u)
  assert.deepEqual(healthy.calls, [ROUTE], '一个成员失败不能连累其它成员')
})

test('缺 ctx.on：返回 false 并说明后果（不会静默地什么都不做）', () => {
  const log = captureLog()
  const ctx = { get: () => undefined, logger: log.logger }
  assert.equal(installTeammateModel(ctx, { [TEAMMATE_MODEL_KEY]: ROUTE }), false)
  assert.equal(log.messages.length, 1)
  assert.match(log.messages[0], /ctx\.on/u)
})

test('缺 ctx.effect：照常挂监听器，只留一条所有权警告', () => {
  const log = captureLog()
  const scout = agentStub('agent-scout')
  const { ctx } = fakeCordis({
    services: { agentTeams: teamService() },
    agents: [],
    logger: log.logger,
    withEffect: false,
  })

  assert.equal(installTeammateModel(ctx, { [TEAMMATE_MODEL_KEY]: ROUTE }), true)
  ctx.emit('agent/created', { agent: scout.agent })
  assert.deepEqual(scout.calls, [ROUTE], '没有 effect 也要照常生效')
  assert.match(log.messages.join('\n'), /ctx\.effect/u)
})

test('配置缺席：不钉，一条警告说明退回继承行为', () => {
  const log = captureLog()
  const scout = agentStub('agent-scout')
  const { ctx } = fakeCordis({ services: { agentTeams: teamService() }, agents: [scout.agent], logger: log.logger })

  assert.equal(installTeammateModel(ctx, {}), false)
  assert.deepEqual(scout.calls, [])
  assert.equal(log.messages.length, 1)
  assert.match(log.messages[0], new RegExp(TEAMMATE_MODEL_KEY, 'u'))
})

// ---------------------------------------------------------------------------
// 5. 纯函数接缝
// ---------------------------------------------------------------------------

test('selectRoute：成功返回 undefined；失败返回一句可读的诊断', () => {
  const ok = agentStub('agent-scout')
  assert.equal(selectRoute(ok.agent, ROUTE), undefined)
  assert.deepEqual(ok.calls, [ROUTE])

  assert.match(selectRoute({}, ROUTE) ?? '', /agent\.model\.select/u)
  assert.match(selectRoute(agentStub('agent-scout', { selectThrows: true }).agent, ROUTE) ?? '', /select 被拒/u)
})

test('label 非空（日志里认得出是谁在动手）', () => {
  assert.equal(typeof TEAMMATE_MODEL_LABEL, 'string')
  assert.ok(TEAMMATE_MODEL_LABEL.length > 0)
})
