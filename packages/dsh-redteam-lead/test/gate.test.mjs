/**
 * LDW-1 / LDW-19 角色闸：`src/gate.ts` 的接缝测试。
 *
 * 这里断言的三层，都是宿主真的会经过的地方：
 * 1. `decideGate({tool, root})` —— 纯函数，矩阵覆盖 根/子代/未知 × 五个被禁工具 × 普通工具；
 * 2. `rootOf` —— 会话根判定（只看会话头三个字段；头缺失或读不懂 = `unknown`，绝不抛）；
 * 3. `installRoleGate` —— 真的通过 `ctx.effect` + `ctx.on('tools/pre-execute', …, {prepend:true})` 挂监听，
 *    放行时 `return next()`（不吞下游决定），拒绝时**不调用** `next()`。
 *
 * 规范：`docs/specs/lead-does-not-work.md` §变更 1。LDW-19 起判据是**会话根**，
 * 不再看 `session.header.agentPreset`（那是创建时的值，会过时）。判定只看 agent 身份，**不看命令文本**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_GATED_TOOLS,
  GATED_TOOLS,
  GATE_LABEL,
  MASK_LABEL,
  TEAMMATE_DENIED_TOOLS,
  TEAMMATE_MASK_LABEL,
  createRoleGate,
  decideGate,
  denyReason,
  installRoleGate,
  installTeammateMask,
  resolveRole,
  rootOf,
} from '../dist/gate.js'

// —— 独立的期望清单（不 import 常量来生成期望值，否则是自证）——

/** 被禁的五个工具名（ticket 原文；`job_*` 明确不在其中）。 */
const DENIED = ['bash', 'pwsh', 'subagent', 'subagent_fork', 'workflow']

/** 闸封死后 Lead 仍可用来自证的工具 + 读已派作业的工具。 */
const ALLOWED = ['read', 'grep', 'rt_hash', 'job_list', 'job_output']

// —— 纯判定矩阵 ——

test('判定矩阵：仅「会话根 + 被禁工具」拒绝；child 与 unknown 一律放行', () => {
  const roots = ['root', 'child', 'unknown']
  const tools = [...DENIED, ...ALLOWED]

  for (const root of roots) {
    for (const tool of tools) {
      const expected = root === 'root' && DENIED.includes(tool)
      const decision = decideGate({ tool, root })
      const label = `root=${root} tool=${tool}`
      if (expected) {
        assert.equal(decision.kind, 'deny', `${label} 必须拒绝`)
        assert.equal(typeof decision.reason, 'string')
        assert.ok(decision.reason.length > 0, `${label} 必须有理由`)
      } else {
        assert.equal(decision.kind, 'allow', `${label} 必须放行`)
      }
    }
  }
})

test('被禁工具名是五个，且 job_* 与 jobs 都不在其中（Lead 裁定见 DECISIONS D42）', () => {
  // 不是"与 ticket 逐字一致"：ticket 原文曾写六个（含 `jobs`），Lead 已裁定那第六个不是宿主工具名，
  // 文档已改成五个。这条用例守住的是**闸的实际清单**与 `job_*` 的放行。
  assert.deepEqual([...GATED_TOOLS].sort(), DENIED)
  for (const name of ['job_list', 'job_output', 'job_kill', 'jobs']) {
    assert.equal(decideGate({ tool: name, root: 'root' }).kind, 'allow', `${name} 不该被禁`)
  }
})

test('可配置禁表：decideGate 的 gated 参数就是唯一来源，缺省时仍是那五个', () => {
  // 默认值单独导出，并且与历史名字指向同一份清单（既有调用方与 dist 里的 `GATED_TOOLS` 都不能断）。
  assert.deepEqual([...DEFAULT_GATED_TOOLS], ['pwsh', 'bash', 'workflow', 'subagent', 'subagent_fork'], '默认禁表必须保持既有顺序')
  assert.deepEqual([...DEFAULT_GATED_TOOLS].sort(), DENIED)
  assert.deepEqual([...GATED_TOOLS], [...DEFAULT_GATED_TOOLS], 'GATED_TOOLS 是默认值的别名，不是第二份清单')

  // 窄化：只挡 workflow，pwsh 放行。
  const narrow = new Set(['workflow'])
  assert.equal(decideGate({ tool: 'workflow', root: 'root', gated: narrow }).kind, 'deny')
  assert.equal(decideGate({ tool: 'pwsh', root: 'root', gated: narrow }).kind, 'allow')

  // 放宽：配置里写了默认表以外的名字，就按配置挡（默认五个之外也一样）。
  const wide = new Set([...DEFAULT_GATED_TOOLS, 'read'])
  assert.equal(decideGate({ tool: 'read', root: 'root', gated: wide }).kind, 'deny')

  // 空表 = 一个都不挡：`gated` 必须真的被用了，不能是「空就退回默认」。
  assert.equal(decideGate({ tool: 'pwsh', root: 'root', gated: new Set() }).kind, 'allow')

  // 根判定与配置无关：子代/unknown 仍一律放行，哪怕配置里点了他手里的工具。
  assert.equal(decideGate({ tool: 'pwsh', root: 'child', gated: new Set(['pwsh']) }).kind, 'allow')
  assert.equal(decideGate({ tool: 'pwsh', root: 'unknown', gated: new Set(['pwsh']) }).kind, 'allow')

  // 拒绝理由仍然点名被拒的那个工具（配置换了名字，理由不能还写 pwsh）。
  const decision = decideGate({ tool: 'read', root: 'root', gated: new Set(['read']) })
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.reason, denyReason('read'))
})

test('拒绝理由可执行：说清 Lead 不执行、派给工兵、点名可用工具，且不提预设', () => {
  for (const tool of DENIED) {
    const decision = decideGate({ tool, root: 'root' })
    assert.equal(decision.kind, 'deny')
    const reason = decision.reason
    assert.match(reason, new RegExp(tool, 'u'), '理由必须点名被拒的工具')
    assert.match(reason, /Lead 不亲自/u, '理由必须说明 Lead 不亲自执行')
    assert.match(reason, /派给工兵/u, '理由必须告诉模型派给工兵')
    assert.match(reason, /spawn_teammate/u, '理由必须点名建人入口 spawn_teammate')
    assert.match(reason, /send_message/u, '理由必须点名派活入口 send_message')
    assert.match(reason, /team_task_/u, '理由必须点名任务入口 team_task_*')
    assert.match(reason, /project\.py/u, '理由必须把账目指向 skill 的 project.py（LDW-23 删了 rt_*）')
    assert.match(reason, /read/u, '理由必须点名可用工具 read')
    assert.match(reason, /grep/u, '理由必须点名可用工具 grep')
    // LDW-23：两个 rt_* 工具已删除 —— 拒绝理由里再点名它们，模型只会去找一个不存在的东西。
    assert.doesNotMatch(reason, /rt_conclude|rt_hash|rt_\*/u, '理由不得再提已删除的 rt_* 工具')
    // LDW-19：拒绝不再由预设判定，理由里也就不该再出现预设字样（模型会以为「换个预设就能过」）。
    assert.doesNotMatch(reason, /预设/u, '拒绝理由不得再提预设')
    // 拒绝不是错误：不能带任何"重试/稍后"之类会让模型硬撞的措辞。
    assert.doesNotMatch(reason, /重试|稍后/u)
  }
  assert.equal(denyReason('pwsh'), decideGate({ tool: 'pwsh', root: 'root' }).reason)
})

// —— LDW-19 会话根判定：只看会话头的三个字段，不需要任何服务 ——
//
// 现场：`session-1558015b` 里 Lead 调 `pwsh` 186 次、0 次被拒。旧闸还要求
// `session.header.agentPreset === 'redteam-lead'`，而那是**创建时**的预设（`standard`），
// 活组合在预设作用域里又读不到 —— 两头都判不出，闸全程沉默。根判定与预设无关。

/** 一条 `exec`：header 原样作为会话头。 */
function execWithSessionHeader(header) {
  return { name: 'pwsh', arguments: {}, agent: { id: 'agent-root', session: { header } } }
}

test('rootOf：depth=0 / 缺省 + 无 origin=subagent + 无 parentSession → root', () => {
  assert.equal(rootOf(execWithSessionHeader({})), 'root', '空会话头 = 根（三个子代证据一个都没有）')
  assert.equal(rootOf(execWithSessionHeader({ delegationDepth: 0 })), 'root')
  assert.equal(
    rootOf(execWithSessionHeader({ agentPreset: 'standard' })),
    'root',
    '创建时的预设字段不能影响根判定（这就是现场）',
  )
  assert.equal(rootOf(execWithSessionHeader({ origin: 'user' })), 'root', '只有 origin=subagent 才算子代')
  assert.equal(rootOf(execWithSessionHeader({ parentSession: '' })), 'root', '空的 parentSession 不是父子关系')
  assert.equal(rootOf(execWithSessionHeader({ parentSession: null })), 'root', 'null 的 parentSession 不是父子关系')
})

test('rootOf：depth≥1 / origin=subagent / 有 parentSession → child', () => {
  assert.equal(rootOf(execWithSessionHeader({ delegationDepth: 1 })), 'child')
  assert.equal(rootOf(execWithSessionHeader({ delegationDepth: 3 })), 'child')
  assert.equal(rootOf(execWithSessionHeader({ origin: 'subagent' })), 'child', '裸子代理没有 parentSession，靠 origin')
  assert.equal(rootOf(execWithSessionHeader({ parentSession: 'session-parent' })), 'child')
  assert.equal(rootOf(execWithSessionHeader({ parentSession: { id: 'session-parent' } })), 'child')
  // 工兵头通常三个字段同时在：任意一个成立就够。
  assert.equal(rootOf(execWithSessionHeader({ delegationDepth: 1, origin: 'subagent', parentSession: 'session-parent' })), 'child')
})

test('rootOf：头缺失或读不懂 → unknown（一律放行），且绝不抛', () => {
  const unreadable = [
    undefined,
    null,
    {},
    'garbage',
    42,
    { name: 'pwsh' },
    { name: 'pwsh', agent: undefined },
    { name: 'pwsh', agent: null },
    { name: 'pwsh', agent: 'agent-root' },
    { name: 'pwsh', agent: {} },
    { name: 'pwsh', agent: { session: null } },
    { name: 'pwsh', agent: { session: 'nope' } },
    { name: 'pwsh', agent: { session: {} } },
    { name: 'pwsh', agent: { session: { header: null } } },
    { name: 'pwsh', agent: { session: { header: 'standard' } } },
    { name: 'pwsh', agent: { session: { header: [] } } },
  ]
  for (const exec of unreadable) {
    assert.equal(rootOf(exec), 'unknown', `${JSON.stringify(exec)} 必须判成 unknown`)
  }
  // 字段读不懂同样不猜：深度是字符串/负数/NaN 时既不是根也不是工兵。
  assert.equal(rootOf(execWithSessionHeader({ delegationDepth: '1' })), 'unknown')
  assert.equal(rootOf(execWithSessionHeader({ delegationDepth: -1 })), 'unknown')
  assert.equal(rootOf(execWithSessionHeader({ delegationDepth: Number.NaN })), 'unknown')

  // 读会话头本身抛错（代理陷阱）：闸不能被一次头部读取带崩。
  const hostile = {
    name: 'pwsh',
    agent: {
      get session() {
        throw new Error('boom')
      },
    },
  }
  assert.equal(rootOf(hostile), 'unknown', '读头抛错必须收成 unknown，不许穿过闸')
})

// —— 角色判定：宿主 `agentTeams.tryMembership(exec.agent)`，缺席/不认 → unknown（放行）——
//
// LDW-19 起角色**不再参与拒绝判定**：它只剩一个用途 —— 决定要不要给这个 agent 下发 Lead 遮罩
// （LDW-8）。拒绝只看 `rootOf` 的结论，团队服务缺席也照样拦。

/** 最小宿主形状：`ctx.get('agentTeams')` 给出 `{ tryMembership }`。 */
function ctxWithTeam(tryMembership) {
  const calls = []
  const service = {
    tryMembership(agent) {
      calls.push(agent)
      return tryMembership(agent)
    },
  }
  return { calls, ctx: { get: (name) => (name === 'agentTeams' ? service : undefined) } }
}

const AGENT = { id: 'agent-lead', session: { header: { agentPreset: 'redteam-lead' } } }
const EXEC = { name: 'pwsh', arguments: {}, agent: AGENT }

test('resolveRole：lead / teammate / other 如实取，agent 原样交给团队服务', async () => {
  for (const [role, expected] of [['lead', 'lead'], ['teammate', 'teammate'], ['other', 'other'], ['admin', 'other']]) {
    const { ctx, calls } = ctxWithTeam(() => ({ root: 'session-root', id: 'team-1', role, name: 'rt-x' }))
    assert.equal(await resolveRole(ctx, EXEC), expected)
    assert.deepEqual(calls, [AGENT], '身份只能来自 exec.agent，不接受自报')
  }
})

test('resolveRole：服务缺席、返回 undefined、抛异常、无 exec.agent → 一律 unknown（放行）', async () => {
  assert.equal(await resolveRole({ get: () => undefined }, EXEC), 'unknown')
  assert.equal(await resolveRole({}, EXEC), 'unknown')
  assert.equal(await resolveRole(ctxWithTeam(() => undefined).ctx, EXEC), 'unknown')
  assert.equal(
    await resolveRole(
      ctxWithTeam(() => {
        throw new Error('stale identity')
      }).ctx,
      EXEC,
    ),
    'unknown',
  )
  assert.equal(await resolveRole(ctxWithTeam(() => ({ role: 'lead' })).ctx, { name: 'pwsh' }), 'unknown')
  assert.equal(await resolveRole(undefined, EXEC), 'unknown')
})

test('resolveRole：兼容异步 tryMembership，也接受 ctx.agentTeams 直挂服务', async () => {
  const { ctx } = ctxWithTeam(async () => ({ role: 'lead' }))
  assert.equal(await resolveRole(ctx, EXEC), 'lead')

  const direct = { agentTeams: { tryMembership: () => ({ role: 'teammate' }) } }
  assert.equal(await resolveRole(direct, EXEC), 'teammate')
})

test('探针自己抛错时闸不炸：resolveRole 判 unknown（角色不再影响拒绝）', async () => {
  const broken = {
    get() {
      throw new Error('service lookup 在这个 scope 不允许')
    },
  }
  assert.equal(await resolveRole(broken, EXEC), 'unknown')
  assert.equal(rootOf(EXEC), 'root', '根判定不经过 ctx：服务全炸也判得出根')
})

// —— 挂载：真的走 ctx.effect + ctx.on('tools/pre-execute', …, {prepend:true})，放行时 return next() ——

/**
 * 最小 Cordis 形状的假 ctx：`get` 探针、`on` 记录监听器、`effect` 收下 disposer。
 * 和真实 Cordis 一样，`effect` 的生成器体在**注册时**就执行到第一个 yield；
 * 直接返回函数的 shape（`ctx.effect(() => () => …)`，宿主自己的写法）也支持。
 *
 * `agents` / `logger` / `tools` 是本包在 ctx 上会触碰的三个面（LDW-8 遮罩用）。
 */
function fakeCordis({ services = {}, agents, logger, tools } = {}) {
  const listeners = []
  const effects = []
  // `agents` 在这里写成声明式的「活的 agent 列表」，但 ctx 上挂的是**宿主的形状**：
  // AgentRegistry 的 `get(id)` / `list()`（见 `liveAgentById` 的注释）。
  const registry = agents === undefined || (typeof agents.get === 'function' && typeof agents.list === 'function')
    ? agents
    : {
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
    ...(tools === undefined ? {} : { tools }),
    get(service) {
      return services[service]
    },
    /** 宿主事件总线的最小模型：按注册顺序同步派发（`agent/created` 等）。 */
    emit(event, payload) {
      for (const entry of [...listeners]) {
        if (entry.event === event) entry.listener(payload)
      }
    },
    on(event, listener, options) {
      const dispose = () => {
        const index = listeners.findIndex((entry) => entry.listener === listener)
        if (index >= 0) listeners.splice(index, 1)
      }
      listeners.push({ event, listener, options, dispose })
      return dispose
    },
    effect(install, label) {
      const produced = install()
      if (typeof produced === 'function') {
        effects.push({ label, dispose: produced })
        return produced
      }
      let step = produced.next()
      while (step.done !== true) {
        step = produced.next(step.value)
      }
      effects.push({ label, dispose: undefined })
      return () => {}
    },
  }
  return { ctx, listeners, effects }
}

/**
 * 一条 `exec`：`header` 是会话头（宿主创建会话时写下的那三四个字段）。默认是**会话根**，
 * 且 `agentPreset: 'standard'` —— 这正是现场的形状：预设停在创建时那一份（`standard`），
 * 之后切到 `redteam-lead` 时 header 不会跟着变。
 */
function preExecute(tool, { header = { agentPreset: 'standard' }, agent = { id: 'agent-lead' } } = {}) {
  return { name: tool, arguments: {}, agent: { ...agent, session: { header } } }
}

/** 一个工兵的会话头：三个子代证据齐全（宿主建子代理时写的就是这一组）。 */
const CHILD_HEADER = { delegationDepth: 1, origin: 'subagent', parentSession: 'session-root' }

/**
 * 给替身 agent 补上宿主的 `session.header`（`rootOf` 只从这一处判根/子代）。
 *
 * 真 agent 一定带这个字段；`fakeAgent` 只造 `{ id, ctx }`，所以事件那几条用例要自己套一层。
 * 注意返回的是**浅拷贝**：`ctx` 仍是同一个对象，`restrict` 落在同一份 tools 上，
 * 所以断言还是对着原来那个 `fakeAgent` 的 `calls` 看。
 */
function withSession(agent, header = { agentPreset: 'standard' }) {
  return { ...agent, session: { header } }
}

/** 团队服务替身：`agent.id === 'agent-lead'` 是 Lead，`agent-scout` 是工兵，`agent-admin` 是别的角色（`other`），其余不认。 */
function teamService() {
  return {
    tryMembership(agent) {
      if (agent?.id === 'agent-lead') return { root: 'session-root', id: 'team-1', role: 'lead', name: 'lead' }
      if (agent?.id === 'agent-scout') return { root: 'session-root', id: 'team-1', role: 'teammate', name: 'rt-scout' }
      if (agent?.id === 'agent-admin') return { root: 'session-root', id: 'team-1', role: 'admin', name: 'admin' }
      return undefined
    },
  }
}

test('installRoleGate：一个 effect 里挂三条监听器（pre-execute + created + status），只有闸那条 prepend', () => {
  const { ctx, listeners, effects } = fakeCordis({ services: { agentTeams: teamService() } })
  installRoleGate(ctx)

  // LDW-24：pre-execute 是拒绝面；created/status 是「会话根重建后不必等第一次调工具」的补遮面。
  assert.deepEqual(listeners.map((entry) => entry.event), ['tools/pre-execute', 'agent/created', 'agent/status'])
  assert.deepEqual(listeners[0].options, { prepend: true }, '必须 prepend：闸要先于下游判定看到这次调用')
  assert.deepEqual(listeners[1].options, undefined, '补遮不该 prepend（它不改任何决定）')
  assert.deepEqual(listeners[2].options, undefined, '补遮不该 prepend（它不改任何决定）')
  for (const entry of listeners) assert.equal(typeof entry.listener, 'function')
  assert.equal(typeof GATE_LABEL, 'string')
  assert.ok(GATE_LABEL.length > 0)
  assert.deepEqual(effects.map((entry) => entry.label), [GATE_LABEL], 'label 是 fiber 的归属标记，不能空')
})

test('installRoleGate：宿主缺 ctx.on / ctx.effect 时降级并记一条，绝不抛', () => {
  // LDW-8 的失败策略：增强失败时静默退回 deny 保底并记一条诊断。装闸同理 —— 少一道闸是运营问题，
  // 整行插件不激活（`apply()` 抛）是产品事故。
  const missingOn = captureLogger()
  assert.equal(
    installRoleGate({ tools: {}, logger: missingOn.logger }),
    false,
    '没有 ctx.on 就无处挂闸：返回 false，但绝不抛',
  )
  assert.equal(missingOn.messages.length, 1, '降级必须留下一条诊断')
  assert.match(missingOn.messages[0], /ctx\.on/u, '诊断必须点明缺的是 ctx.on')

  // 有 ctx.on、没有 ctx.effect：闸照挂（deny 保底仍然生效），只是监听器不归本插件 fiber 所有。
  const missingEffect = captureLogger()
  const { ctx, listeners } = fakeCordis({ services: { agentTeams: teamService() }, logger: missingEffect.logger })
  delete ctx.effect
  assert.equal(installRoleGate(ctx), true, '有 ctx.on 就能装闸')
  assert.deepEqual(listeners.map((entry) => entry.event), ['tools/pre-execute', 'agent/created', 'agent/status'], '缺 ctx.effect 不影响挂监听器')
  assert.deepEqual(listeners[0].options, { prepend: true }, '降级后仍然必须 prepend')
  assert.equal(missingEffect.messages.length, 1, '缺 fiber 所有权也要记一条')
  assert.match(missingEffect.messages[0], /ctx\.effect/u, '诊断必须点明缺的是 ctx.effect')

  // 两条诊断都走宿主日志通道，并且带闸的 label：否则日志里认不出是谁在降级。
  for (const message of [...missingOn.messages, ...missingEffect.messages]) {
    assert.ok(message.startsWith(`[${GATE_LABEL}]`), `诊断必须带 [${GATE_LABEL}] 前缀：${message}`)
  }
})

/** 收集 `ctx.logger.warn` 的文本（闸的诊断只走宿主日志，不新开文件格式）。 */
function captureLogger() {
  const messages = []
  return {
    messages,
    logger: {
      warn(message) {
        messages.push(String(message))
      },
    },
  }
}

test('监听器：会话根 × 被禁工具 → deny，且不调用 next、不读 arguments', async () => {
  const { ctx, listeners } = fakeCordis({ services: { agentTeams: teamService() } })
  installRoleGate(ctx)
  const listener = listeners[0].listener

  // 根的判定与团队服务无关：认得的 Lead 与认不出的 agent 都是会话根，都拦。
  const roots = [
    ['团队服务认得的 Lead', { id: 'agent-lead' }],
    ['团队服务不认的 agent', { id: 'agent-ghost' }],
  ]
  for (const tool of DENIED) {
    for (const [label, agent] of roots) {
      const exec = preExecute(tool, { agent })
      // 「不解析命令文本」是可验证的：闸一旦读 arguments 就炸。
      Object.defineProperty(exec, 'arguments', {
        get() {
          throw new Error('角色闸不得读取 exec.arguments')
        },
      })
      let nextCalls = 0
      const decision = await listener(exec, () => {
        nextCalls += 1
        return { kind: 'accept', content: [] }
      })
      assert.equal(nextCalls, 0, `${label} × ${tool}：拒绝后不得继续往下走`)
      assert.equal(decision.kind, 'deny', `${label} × ${tool}：会话根必须拒绝`)
      assert.equal(decision.reason, denyReason(tool))
    }
  }
})

test('回归（LDW-19 现场）：header.agentPreset 还是创建时的 standard、预设服务也读不到，会话根仍被拒绝', async () => {
  // 现场 `session-1558015b`：Lead 调 pwsh 186 次、0 次被拒。旧闸要求
  // `presetFor(...).id === 'redteam-lead'` —— header 停在 'standard'，活组合在预设作用域里
  // `ctx.get('agentPresets')` 取不到，两头都判不出 → fail-open → 闸全程沉默。
  // 这里把两个坏条件都摆上（header 过期 + 没有任何服务），根判定必须照样拦住。
  const { ctx, listeners } = fakeCordis({ services: {} })
  installRoleGate(ctx)
  const listener = listeners[0].listener

  for (const tool of DENIED) {
    const exec = preExecute(tool, { header: { agentPreset: 'standard', delegationDepth: 0 } })
    const decision = await listener(exec, () => 'downstream')
    assert.equal(decision.kind, 'deny', `${tool}：会话根必须拒绝，与 header 里过期的预设无关`)
    assert.equal(decision.reason, denyReason(tool))
  }
  // 对照：同一份会话头下，普通核对工具照常放行。
  assert.equal(await listener(preExecute('read'), () => 'downstream'), 'downstream')
})

test('监听器：工兵（depth 1 + origin + parentSession）× 五个门禁工具 → 全部放行', async () => {
  const { ctx, listeners } = fakeCordis({ services: { agentTeams: teamService() } })
  installRoleGate(ctx)

  for (const tool of DENIED) {
    const exec = preExecute(tool, { header: CHILD_HEADER, agent: { id: 'agent-scout' } })
    assert.equal(await listeners[0].listener(exec, () => 'downstream'), 'downstream', `${tool}：工兵不得被拦`)
  }
})

test('监听器：裸子代理 / 读不懂的会话头 / 普通工具 → return next() 原样透传', async () => {
  const cases = [
    ['工兵（只有 depth）', preExecute('pwsh', { header: { delegationDepth: 1 }, agent: { id: 'agent-scout' } }), 'accept-A'],
    ['裸子代理（只有 origin=subagent）', preExecute('pwsh', { header: { origin: 'subagent' }, agent: { id: 'agent-bare' } }), 'accept-B'],
    ['有 parentSession', preExecute('pwsh', { header: { parentSession: 'session-root' }, agent: { id: 'agent-scout' } }), 'accept-C'],
    ['会话头是 null', { name: 'pwsh', arguments: {}, agent: { id: 'agent-lead', session: { header: null } } }, 'accept-D'],
    ['没有 session', { name: 'pwsh', arguments: {}, agent: { id: 'agent-lead' } }, 'accept-E'],
    ['没有 agent', { name: 'pwsh', arguments: {} }, 'accept-F'],
    ['允许的工具 read', preExecute('read'), 'accept-G'],
    ['允许的工具 rt_hash', preExecute('rt_hash'), 'accept-H'],
    ['允许的工具 job_output', preExecute('job_output'), 'accept-I'],
  ]
  for (const [label, exec, downstream] of cases) {
    const { ctx, listeners } = fakeCordis({ services: { agentTeams: teamService() } })
    installRoleGate(ctx)
    let nextCalls = 0
    const result = await listeners[0].listener(exec, () => {
      nextCalls += 1
      return downstream
    })
    assert.equal(nextCalls, 1, `${label}：必须调用 next()`)
    assert.equal(result, downstream, `${label}：必须原样 return next()，不能改写下游决定`)
  }
})

test('createRoleGate：可以脱离 effect 单测，返回稳定监听器', async () => {
  const gate = createRoleGate({ get: (name) => (name === 'agentTeams' ? teamService() : undefined) })
  assert.equal(typeof gate, 'function')
  assert.equal(await gate(preExecute('bash', { header: CHILD_HEADER }), () => 'ok'), 'ok', '子代照常放行')
  assert.equal((await gate(preExecute('bash'), () => 'ok')).kind, 'deny', '会话根拒绝')
})

test('createRoleGate：ctx 探针全炸也不打断调用 —— 判根不需要任何服务', async () => {
  const gate = createRoleGate({
    get() {
      throw new Error('no services here')
    },
  })
  assert.equal(await gate(preExecute('pwsh', { header: CHILD_HEADER }), () => 'ok'), 'ok', '子代照常放行')
  assert.equal(
    (await gate(preExecute('pwsh'), () => 'never')).kind,
    'deny',
    '会话根照常拒绝：服务全炸也不会让闸重新沉默（旧闸正是这样漏的）',
  )
})

// —— LDW-8 遮罩：确认 Lead 之后，把五个名字从**那个 agent** 的工具目录里拿掉 ——
//
// 三条事实（ticket 已核实，这里只按它断言）：
// 1. `restrict()` 写进**调用方自己那一层**，能盖住预设（祖先）层注册的工具；
// 2. 从预设自己的 ctx 调会抛 `unknown global tool` 并波及整个代际 → 只能从 agent 的 ctx 调；
// 3. deny 是保证，遮罩是增强：restrict 缺席/抛错都必须静默退回 deny。

/** 被遮罩的五个名字（ticket 原文，独立写一遍，不从 GATED_TOOLS 生成）。 */
const MASKED = ['bash', 'pwsh', 'subagent', 'subagent_fork', 'workflow']

/** 遮罩不该动到的工具面（Lead 的核对、派发与作业读取手段）。 */
const KEPT = ['read', 'grep', 'rt_hash', 'job_list', 'job_output', 'send_message', 'send_message']

/**
 * 带 scoped `tools` 的 agent 替身，**照抄宿主（`dsh-tools`）的三个面**：
 *
 * - `view(scope).restrictableNames` —— `restrict()` **逐字校验**用的那份名单：祖先层
 *   （global + 预设）注册的名字；本层注册的名字**不在**其中，`restrict` 遮不到它们
 *   （`dsh-tools` 的 `view()`：`restrictableNames` 只收 inherited，`visible` 另加 own）。
 * - `schemas(scope)` —— 可见目录（schema 对象数组，名字在 `.name` 上），含本层注册与 `run_code`。
 * - `restrict({deny})` —— 与宿主一样**整表校验**：只要有一个名字不在可遮名单里就整块抛错，
 *   附带原文 `names unknown global tool "…"`。这就是 LDW-11 要修的现场。
 *
 * `options.restrictable` 决定这个 scope 可遮哪些名字（默认五个门禁工具 + `KEPT`）；
 * `options.ownLayer` 是本层注册（可见但不可遮）；`options.withView` / `options.withSchemas`
 * 传 `false` 可以拿掉对应的探针，覆盖「只有一份来源」与「一份都没有」的分支。
 * `options.restrict` 仍可注入替身自己的行为（抛错、返回 undefined）来覆盖失败分支。
 * `tools.filters` 只收**成功下发**的遮罩，供 `catalogFor` 的宿主可见性模型读取。
 */
function fakeAgent(id, options = {}) {
  const calls = []
  const filters = []
  const lifted = []
  const restrictable = new Set(options.restrictable ?? [...MASKED, ...KEPT])
  const ownLayer = options.ownLayer ?? []
  const visible = new Set([...restrictable, ...ownLayer, 'run_code'])
  function schemaOf(name) {
    return { name, description: `${name}（测试替身）`, parameters: {} }
  }
  const tools = {
    ...(options.withView === false ? {} : {
      view() {
        return {
          visible: new Map([...visible].map((name) => [name, schemaOf(name)])),
          knownNames: new Set([...restrictable, ...ownLayer]),
          restrictableNames: new Set(restrictable),
        }
      },
    }),
    ...(options.withSchemas === false ? {} : {
      schemas() {
        return [...visible].map((name) => schemaOf(name))
      },
    }),
    restrict(filter) {
      calls.push(filter)
      // 宿主 `restrict()` 的校验：整表拒绝，不是挑挑拣拣（`dsh-tools:3002-3004`）。
      const unknown = [...filter.deny ?? [], ...filter.allow ?? []].filter((name) => !restrictable.has(name))
      if (unknown.length > 0) {
        throw new Error(
          `tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ` +
            `${unknown.map((name) => `"${name}"`).join(', ')}; known global tools: ${[...restrictable].sort().join(', ')}`,
        )
      }
      const outcome = options.restrict === undefined ? () => lifted.push(filter) : options.restrict(filter)
      filters.push(filter)
      return outcome
    },
    filters,
  }
  return { agent: { id, ctx: { tools } }, calls, filters, lifted }
}

/**
 * 宿主可见性规则的最小模型：`layers.every(admits)` —— 任一层的 deny 命中即不可见。
 *
 * 这不是本包的实现，而是**宿主已核实的规则**（ticket「已核实」第 1 条）：
 * 遮罩之后模型侧看到的目录里就没有这些名字了。用它来断言「恰好少了五个、别的一个不少」。
 */
function catalogFor(agent, all) {
  const filters = agent.ctx.tools.filters ?? []
  const denied = new Set(filters.flatMap((filter) => filter.deny ?? []))
  return all.filter((name) => !denied.has(name))
}

test('遮罩：Lead 首调仍由 waterfall 拒绝，并在同一次调用里下发「恰好五个」的 deny', async () => {
  const lead = fakeAgent('agent-lead')
  const { ctx, listeners } = fakeCordis({ services: { agentTeams: teamService() }, agents: [lead.agent] })
  installRoleGate(ctx)

  // 未遮罩前：五个工具都在 Lead 的目录里 —— 这就是本票要修的那个现场。
  assert.deepEqual(catalogFor(lead.agent, [...MASKED, ...KEPT]), [...MASKED, ...KEPT])

  const decision = await listeners[0].listener(preExecute('pwsh', { agent: lead.agent }), () => 'downstream')
  assert.equal(decision.kind, 'deny', '首调必须仍由 waterfall 拒绝（deny 是保证）')
  assert.equal(lead.calls.length, 1, '同一次调用里必须尝试遮罩')
  assert.deepEqual(Object.keys(lead.calls[0]), ['deny'], '只传 deny，不能传 allow（allow 会变成白名单）')
  assert.deepEqual([...lead.calls[0].deny].sort(), MASKED, '遮罩的名字必须与 ticket 逐字一致')

  // 遮罩落地之后：那五个从目录里消失，其余工具一个不少。
  assert.deepEqual(catalogFor(lead.agent, [...MASKED, ...KEPT]), KEPT)
})

// —— LDW-24：会话根的遮罩不能等到它第一次调工具（2026-11-04 01:09 的现场）——
//
// 现场：会话空闲 13 小时后恢复，宿主重建了 agent —— 旧 scope 连同 restrict 一起消失，
// 三个门禁工具重新出现在目录里（271 + tool-addition ×3），一分多钟后它第一次调工具才收回。

test('LDW-24：会话根在 agent/created 上就被遮，不必等第一次工具调用', () => {
  const lead = fakeAgent('agent-lead')
  const { ctx, listeners } = fakeCordis({ services: { agentTeams: teamService() }, agents: [] })
  installRoleGate(ctx)

  assert.equal(lead.calls.length, 0, '安装时注册表里还没有它')

  const created = listeners.find((entry) => entry.event === 'agent/created')
  // 宿主的 agent 自带 `session.header`（`rootOf` 只认这一处）；替身要照这个形状给。
  created.listener({ agent: withSession(lead.agent) })

  assert.equal(lead.calls.length, 1, '建人那一刻就该遮：现状要等 pre-execute')
  assert.deepEqual([...lead.calls[0].deny].sort(), [...MASKED].sort())
  assert.deepEqual(catalogFor(lead.agent, [...MASKED, ...KEPT]), KEPT)
})

test('LDW-24：续轮重建的会话根（同 id、新 scope）由 agent/status 补遮 —— 这就是 flap 的回归', () => {
  const first = fakeAgent('agent-lead')
  const { ctx, listeners } = fakeCordis({ services: { agentTeams: teamService() }, agents: [] })
  installRoleGate(ctx)
  const status = listeners.find((entry) => entry.event === 'agent/status')

  status.listener({ agent: withSession(first.agent) })
  assert.equal(first.calls.length, 1)

  // 宿主重建：同一个 agent id、新 agent 对象与新 scope（旧 restrict 随旧 scope 消失）。
  const rebuilt = fakeAgent('agent-lead')
  assert.deepEqual(catalogFor(rebuilt.agent, [...MASKED, ...KEPT]), [...MASKED, ...KEPT], '重建后工具本来会重新出现')

  status.listener({ agent: withSession(rebuilt.agent) })
  assert.equal(rebuilt.calls.length, 1, '重建后必须立刻补遮，否则要等它第一次调工具')
  assert.deepEqual(catalogFor(rebuilt.agent, [...MASKED, ...KEPT]), KEPT)

  status.listener({ agent: withSession(rebuilt.agent) })
  assert.equal(rebuilt.calls.length, 1, '同一 scope 只遮一次（status 每轮都会来）')
})

test('LDW-24：补遮只认会话根 —— 工兵、读不懂的会话头都不碰', () => {
  const scout = fakeAgent('agent-scout')
  const unknown = fakeAgent('agent-lead')
  const { ctx, listeners } = fakeCordis({ services: { agentTeams: teamService() }, agents: [] })
  installRoleGate(ctx)
  const created = listeners.find((entry) => entry.event === 'agent/created')

  created.listener({ agent: { ...scout.agent, session: { header: CHILD_HEADER } } })
  created.listener({ agent: { ...unknown.agent, session: {} } })
  created.listener({})

  assert.equal(scout.calls.length, 0, '工兵归 installTeammateMask，不归这里')
  assert.equal(unknown.calls.length, 0, '会话头读不出 → fail-open')
})

// —— 可配置禁表（config.gatedTools）：判定与遮罩必须用**同一份**配置 ——

test('可配置禁表：createRoleGate 的 gated 决定拒绝面（窄化后 pwsh 放行、workflow 仍拒）', async () => {
  const narrow = new Set(['workflow'])
  const gate = createRoleGate({ get: () => teamService() }, narrow)

  assert.equal(await gate(preExecute('pwsh'), () => 'downstream'), 'downstream', '配置里没有 pwsh，它必须放行')
  const decision = await gate(preExecute('workflow'), () => 'never')
  assert.equal(decision.kind, 'deny', '配置里有的名字必须拒绝')
  assert.equal(decision.reason, denyReason('workflow'))
  assert.equal(await gate(preExecute('bash'), () => 'downstream'), 'downstream', 'bash 也不在配置里')

  // 缺省仍走默认五个：既有调用方（不传第二个参数）行为不变。
  const fallback = createRoleGate({ get: () => teamService() })
  assert.equal((await fallback(preExecute('pwsh'), () => 'never')).kind, 'deny')
})

test('可配置禁表：遮罩用配置里的名字，诊断里的「本应遮 N 个」也跟着配置走', async () => {
  // 可遮名单里五个门禁工具都在：配置窄化之后，只有配置里的两个会被遮。
  const lead = fakeAgent('agent-lead', { restrictable: ['pwsh', 'bash', 'workflow', 'read', 'grep'] })
  const warnings = []
  const { ctx, listeners } = fakeCordis({
    services: { agentTeams: teamService() },
    agents: [lead.agent],
    logger: { warn: (message) => warnings.push(String(message)) },
  })
  installRoleGate(ctx, new Set(['workflow', 'pwsh']))

  const decision = await listeners[0].listener(preExecute('pwsh', { agent: lead.agent }), () => 'downstream')
  assert.equal(decision.kind, 'deny', 'pwsh 在配置里，仍由 waterfall 拒绝')
  assert.equal(lead.calls.length, 1)
  assert.deepEqual(
    lead.calls[0].deny,
    ['workflow', 'pwsh'],
    'deny 必须恰好是「配置里的名字 ∩ 可遮名单」，按配置顺序（不是默认五个）',
  )
  assert.deepEqual(catalogFor(lead.agent, ['pwsh', 'bash', 'workflow', 'subagent', 'read', 'grep']), ['bash', 'subagent', 'read', 'grep'],
    '遮罩之后：配置里的两个名字消失；bash（可遮但没配置）与 subagent 仍然可见')

  assert.equal(warnings.length, 1, '遮罩成功也要留一条诊断（Lead 只有一两个，成功也记）')
  assert.match(warnings[0], /本应遮 2 个/u, '「本应遮 N 个」必须是配置的大小，不是默认五个')
  assert.match(warnings[0], /实际遮 2 个/u)
})

test('遮罩：同一个 Lead 跨多次调用只下发一次', async () => {
  const lead = fakeAgent('agent-lead')
  const { ctx, listeners } = fakeCordis({ services: { agentTeams: teamService() }, agents: [lead.agent] })
  installRoleGate(ctx)

  for (const tool of ['pwsh', 'bash', 'workflow', 'subagent', 'subagent_fork', 'read', 'rt_hash']) {
    await listeners[0].listener(preExecute(tool, { agent: lead.agent }), () => 'downstream')
  }
  assert.equal(lead.calls.length, 1, '每个 agent 只遮一次：重复调用是加性的，但没有理由反复撞')
})

test('遮罩：两个代际的 Lead 各自下发一次（按 agent id 记，不按会话）', async () => {
  const first = fakeAgent('agent-lead')
  const second = fakeAgent('agent-second-lead')
  const { ctx, listeners } = fakeCordis({
    services: {
      agentTeams: {
        tryMembership(agent) {
          return agent?.id === 'agent-lead' || agent?.id === 'agent-second-lead' ? { role: 'lead' } : undefined
        },
      },
    },
    agents: [first.agent, second.agent],
  })
  installRoleGate(ctx)

  await listeners[0].listener(preExecute('pwsh', { agent: first.agent }), () => 'downstream')
  await listeners[0].listener(preExecute('pwsh', { agent: second.agent }), () => 'downstream')
  await listeners[0].listener(preExecute('bash', { agent: first.agent }), () => 'downstream')

  assert.equal(first.calls.length, 1)
  assert.equal(second.calls.length, 1)
})

test('遮罩：不等 Lead 撞工具 —— 它在第一个普通工具调用（send_message）上就落地', async () => {
  const lead = fakeAgent('agent-lead')
  const { ctx, listeners } = fakeCordis({ services: { agentTeams: teamService() }, agents: [lead.agent] })
  installRoleGate(ctx)

  const result = await listeners[0].listener(preExecute('send_message', { agent: lead.agent }), () => 'downstream')
  assert.equal(result, 'downstream', '普通工具必须原样放行')
  assert.equal(lead.calls.length, 1, '遮罩不能等到第一次撞上被禁工具——那一轮已经浪费了')
  assert.deepEqual([...lead.calls[0].deny].sort(), MASKED)
})

test('遮罩：工兵、别的角色、不认识的 agent —— 一律不碰（子代连团队查询都不做）', async () => {
  const scout = fakeAgent('agent-scout')
  const admin = fakeAgent('agent-admin')
  const ghost = fakeAgent('agent-ghost')
  const { ctx, listeners } = fakeCordis({
    services: { agentTeams: teamService() },
    agents: [scout.agent, admin.agent, ghost.agent],
  })
  installRoleGate(ctx)

  // 旧用例里那条「预设不是 redteam-lead 的 lead 不受本预设的闸管」已删除：
  // LDW-19 之后它正是**必须被拒绝**的现场（见上面的回归用例），不再是「不碰」的对象。
  const cases = [
    ['工兵', preExecute('pwsh', { header: CHILD_HEADER, agent: scout.agent })],
    ['别的角色（other）', preExecute('pwsh', { header: { delegationDepth: 1 }, agent: admin.agent })],
    ['团队服务不认这个 agent', preExecute('pwsh', { header: { parentSession: 'session-root' }, agent: ghost.agent })],
  ]
  for (const [label, exec] of cases) {
    const result = await listeners[0].listener(exec, () => 'downstream')
    assert.equal(result, 'downstream', `${label}：必须原样放行`)
  }
  assert.equal(scout.calls.length, 0, '工兵绝不能被遮罩')
  assert.equal(admin.calls.length, 0, '非 lead 的角色绝不能被遮罩')
  assert.equal(ghost.calls.length, 0, '认不出的 agent 不能猜着遮')
})

test('遮罩：exec.agent 只带 id 时，从 ctx.agents 找那个活的 agent 的 ctx', async () => {
  const lead = fakeAgent('agent-lead')
  const { ctx, listeners } = fakeCordis({ services: { agentTeams: teamService() }, agents: [lead.agent] })
  installRoleGate(ctx)

  // 宿主里 exec.agent 就是 Agent 本体；这里刻意只留 id，验证 ctx.agents 这条兜底路由。
  const decision = await listeners[0].listener(preExecute('pwsh', { agent: { id: 'agent-lead' } }), () => 'downstream')
  assert.equal(decision.kind, 'deny')
  assert.equal(lead.calls.length, 1, '必须能按 id 找到活的 agent 并遮它')
})

test('遮罩：绝不从预设自己的 ctx 调 restrict（那会抛 unknown global tool 并波及整个代际）', async () => {
  let presetCalls = 0
  const presetTools = {
    restrict() {
      presetCalls += 1
      throw new Error('tools.restrict() names unknown global tool "pwsh"')
    },
  }
  const lead = fakeAgent('agent-lead')
  const { ctx, listeners } = fakeCordis({
    services: { agentTeams: teamService() },
    agents: [lead.agent],
    tools: presetTools,
  })
  installRoleGate(ctx)

  await listeners[0].listener(preExecute('pwsh', { agent: lead.agent }), () => 'downstream')
  await listeners[0].listener(preExecute('read', { agent: lead.agent }), () => 'downstream')

  assert.equal(presetCalls, 0, '预设 ctx 的 restrict 一次都不能碰')
  assert.equal(lead.calls.length, 1, '只能落在 agent 自己的 ctx 上')
})

test('遮罩：restrict 抛错时静默退回 deny（不传播、不反复撞），并记一条诊断', async () => {
  const warnings = []
  const lead = fakeAgent('agent-lead', {
    restrict() {
      throw new Error('tools.restrict() names unknown global tool "bash"')
    },
  })
  const { ctx, listeners } = fakeCordis({
    services: { agentTeams: teamService() },
    agents: [lead.agent],
    logger: { warn: (message) => warnings.push(String(message)) },
  })
  installRoleGate(ctx)

  const first = await listeners[0].listener(preExecute('pwsh', { agent: lead.agent }), () => 'downstream')
  assert.equal(first.kind, 'deny', '遮罩失败不得动摇 deny 保底')
  assert.equal(lead.calls.length, 1)

  // 同一个 agent 不再重试：失败也不许把每次工具调用都变成一次抛错 + 一条告警。
  const second = await listeners[0].listener(preExecute('bash', { agent: lead.agent }), () => 'downstream')
  assert.equal(second.kind, 'deny')
  assert.equal(lead.calls.length, 1, '失败也只尝试一次')

  assert.equal(warnings.length, 1, '必须留一条诊断，否则失败是静默的')
  assert.match(warnings[0], /agent-lead/u, '诊断要点名是哪个 agent')
  assert.match(warnings[0], /bash/u, '诊断要带上原始失败信息')
})

test('遮罩：拿不到 scoped tools.restrict（或宿主没有 logger）时，安静地只剩 deny', async () => {
  // agent 没有 ctx.tools.restrict：宿主形状不符，属可预期情形，绝不能抛。
  const bare = { id: 'agent-lead' }
  const { ctx, listeners } = fakeCordis({ services: { agentTeams: teamService() }, agents: [bare] })
  installRoleGate(ctx)

  for (const tool of ['pwsh', 'read']) {
    const decision = await listeners[0].listener(preExecute(tool, { agent: bare }), () => 'downstream')
    if (tool === 'pwsh') assert.equal(decision.kind, 'deny', '拿不到 ctx 也必须继续用 deny 保底')
    else assert.equal(decision, 'downstream')
  }
  // 没有 logger 的宿主：诊断路径缺席同样不能抛（上面的循环已经不抛就是断言）。
})

test('遮罩：restrict 的 disposer 归插件 fiber，卸载时把遮罩一起解除', async () => {
  const lead = fakeAgent('agent-lead')
  const { ctx, listeners, effects } = fakeCordis({ services: { agentTeams: teamService() }, agents: [lead.agent] })
  installRoleGate(ctx)

  await listeners[0].listener(preExecute('pwsh', { agent: lead.agent }), () => 'downstream')
  const maskEffect = effects.find((entry) => entry.label === MASK_LABEL)
  assert.ok(maskEffect, '遮罩必须挂在插件 fiber 上，别在别人的 ctx 上留一块没人收的遮罩')
  assert.equal(typeof maskEffect.dispose, 'function')
  assert.equal(lead.lifted.length, 0, '插件还在跑时不得解除')

  maskEffect.dispose()
  assert.equal(lead.lifted.length, 1, '卸载插件要把自己下的遮罩解开')
})

test('遮罩：restrict 返回的不是函数也不影响流程（宿主实现可替换）', async () => {
  const lead = fakeAgent('agent-lead', { restrict: () => undefined })
  const { ctx, listeners } = fakeCordis({ services: { agentTeams: teamService() }, agents: [lead.agent] })
  installRoleGate(ctx)
  const decision = await listeners[0].listener(preExecute('pwsh', { agent: lead.agent }), () => 'downstream')
  assert.equal(decision.kind, 'deny')
  assert.equal(lead.calls.length, 1)
})

// —— LDW-11 求交：`restrict` 对「名字不在可遮名单里」是**整表**拒绝 ——
//
// 现场：五个名字里只要有一个没在这个组合树上注册（例如某个 preset 没 compose `workflow`
// 引擎），整块遮罩就抛 `unknown global tool`、静默退回 deny-only —— 工具仍然可见。
// 所以调用前先取**该 agent scope 的可遮名单**（宿主校验 restrict 用的同一份），与
// `GATED_TOOLS` 求交，只传交集；交集为空就不调用。

/** 只有三个名字可遮（缺 `subagent` / `subagent_fork`，模拟没 compose 那两个引擎的组合树）。 */
const PARTIAL = ['bash', 'pwsh', 'workflow', ...KEPT]

/** 一个门禁工具都不可遮（例如只有核对工具的最小组合）。 */
const NONE = [...KEPT]

/** 装配一个只有单个 Lead 的门 + `logger.warn` 收集器（诊断用）。 */
function gateWithLead(lead, warnings) {
  const cordis = fakeCordis({
    services: { agentTeams: teamService() },
    agents: [lead.agent],
    ...(warnings === undefined ? {} : { logger: { warn: (message) => warnings.push(String(message)) } }),
  })
  installRoleGate(cordis.ctx)
  return cordis.listeners[0].listener
}

test('遮罩（LDW-11）：只有三个名字可遮 → 只遮三个，不抛错，其余名字不进 deny', async () => {
  const lead = fakeAgent('agent-lead', { restrictable: PARTIAL })
  const listener = gateWithLead(lead)

  const decision = await listener(preExecute('read', { agent: lead.agent }), () => 'downstream')
  assert.equal(decision, 'downstream', '遮罩不改变放行')
  assert.equal(lead.calls.length, 1)
  assert.deepEqual([...lead.calls[0].deny].sort(), ['bash', 'pwsh', 'workflow'], '只传交集，不传不可遮的名字')
  assert.deepEqual(Object.keys(lead.calls[0]), ['deny'], '仍然只传 deny')

  // 三个消失，另外两个不可遮的仍在目录里（它们本来就不该被本条遮罩动到）。
  assert.deepEqual(catalogFor(lead.agent, [...MASKED, ...KEPT]), ['subagent', 'subagent_fork', ...KEPT])
})

test('遮罩（LDW-11）：一个都不可遮 → 不调用 restrict（调用就是整表抛错）', async () => {
  const warnings = []
  const lead = fakeAgent('agent-lead', { restrictable: NONE })
  const listener = gateWithLead(lead, warnings)

  const decision = await listener(preExecute('read', { agent: lead.agent }), () => 'downstream')
  assert.equal(decision, 'downstream')
  assert.equal(lead.calls.length, 0, '交集为空时一次都不能调 restrict')
  assert.deepEqual(catalogFor(lead.agent, [...MASKED, ...KEPT]), [...MASKED, ...KEPT], '目录原封不动')
  assert.equal(warnings.length, 1, '不调用也要留一条诊断（否则「遮罩静默没生效」）')
  assert.match(warnings[0], /本应遮 5 个/u)
  assert.match(warnings[0], /实际遮 0 个/u)
})

test('遮罩（LDW-11）：三种可见性下 deny 决定与理由一字不差', async () => {
  const cases = [
    ['全可见', [...MASKED, ...KEPT]],
    ['三个可遮', PARTIAL],
    ['一个都不可遮', NONE],
  ]
  for (const [label, restrictable] of cases) {
    const lead = fakeAgent('agent-lead', { restrictable })
    const listener = gateWithLead(lead)

    const denied = await listener(preExecute('pwsh', { agent: lead.agent }), () => 'never')
    assert.equal(denied.kind, 'deny', `${label}：仍须拒绝`)
    assert.equal(denied.reason, denyReason('pwsh'), `${label}：拒绝理由必须一字不差`)

    const allowed = await listener(preExecute('send_message', { agent: lead.agent }), () => 'downstream')
    assert.equal(allowed, 'downstream', `${label}：普通工具原样放行`)
  }
})

test('遮罩（LDW-11）：本层注册的名字可见但不可遮 → 不进交集（否则整表被拒）', async () => {
  // `workflow` 注册在 agent 本层：宿主 `view().visible` 有它，`restrictableNames` 没有
  // （restriction 只能过滤「继承来的」工具）。照 `schemas()` 求交会把它带进 deny → 整表抛错。
  const lead = fakeAgent('agent-lead', {
    restrictable: [...MASKED, ...KEPT].filter((name) => name !== 'workflow'),
    ownLayer: ['workflow'],
  })
  const listener = gateWithLead(lead)

  const decision = await listener(preExecute('read', { agent: lead.agent }), () => 'downstream')
  assert.equal(decision, 'downstream')
  assert.equal(lead.calls.length, 1, '可遮的那四个仍然要下发')
  assert.deepEqual([...lead.calls[0].deny].sort(), ['bash', 'pwsh', 'subagent', 'subagent_fork'])
  assert.deepEqual(
    catalogFor(lead.agent, [...MASKED, ...KEPT]),
    ['workflow', ...KEPT],
    '本层注册的 workflow 遮不到，也不该假装遮到了',
  )
})

test('遮罩（LDW-11）：宿主没给 view() 时，退到 schemas(scope) 的可见目录求交', async () => {
  const lead = fakeAgent('agent-lead', { restrictable: PARTIAL, withView: false })
  const listener = gateWithLead(lead)

  await listener(preExecute('read', { agent: lead.agent }), () => 'downstream')
  assert.equal(lead.calls.length, 1)
  assert.deepEqual([...lead.calls[0].deny].sort(), ['bash', 'pwsh', 'workflow'])
})

test('遮罩（LDW-11）：两份来源都拿不到 → 不猜，不调用 restrict', async () => {
  const warnings = []
  const lead = fakeAgent('agent-lead', { withView: false, withSchemas: false })
  const listener = gateWithLead(lead, warnings)

  const decision = await listener(preExecute('pwsh', { agent: lead.agent }), () => 'never')
  assert.equal(decision.kind, 'deny', '拿不到名单也必须靠 deny 保底')
  assert.equal(lead.calls.length, 0, '认不出可遮名单时不许盲传五个名字')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /实际遮 0 个/u)
})

test('遮罩（LDW-11）：每个 agent 一条诊断，写清本应遮几个、实际遮几个', async () => {
  const warnings = []
  const lead = fakeAgent('agent-lead', { restrictable: PARTIAL })
  const listener = gateWithLead(lead, warnings)

  for (const tool of ['read', 'send_message', 'pwsh']) {
    await listener(preExecute(tool, { agent: lead.agent }), () => 'downstream')
  }
  assert.equal(warnings.length, 1, '每个 agent 只留一条（跨调用不重复）')
  assert.match(warnings[0], /agent-lead/u, '诊断要点名是哪个 agent')
  assert.match(warnings[0], /本应遮 5 个/u, '要写清本应遮几个')
  assert.match(warnings[0], /实际遮 3 个/u, '要写清实际遮了几个')
  assert.match(warnings[0], /subagent/u, '要写清哪些名字被跳过')
})

test('遮罩（LDW-11）：五个全可见时诊断写「本应遮 5 个，实际遮 5 个」', async () => {
  const warnings = []
  const lead = fakeAgent('agent-lead')
  const listener = gateWithLead(lead, warnings)

  await listener(preExecute('read', { agent: lead.agent }), () => 'downstream')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /本应遮 5 个/u)
  assert.match(warnings[0], /实际遮 5 个/u)
})

// —— LDW-15 工兵裁剪：只裁「建人 / 派发」四个入口，Lead 与 bare subagent 一概不碰 ——
//
// spec §变更 3：派发权靠「契约里写一句不许」是软的，要把能力拿掉。裁的是**入口**，不是纪律。
// 机制与 Lead 的遮罩同一条（per-agent、只做一次、先与该 scope 的可遮名单求交再 restrict），
// 所以这里断言的是同一套行为，只是 deny 表换成工兵那四个。

/** 工兵被裁的四个名字（ticket 原文，独立写一遍，不从 `TEAMMATE_DENIED_TOOLS` 生成）。 */
const TEAMMATE_DENIED = ['spawn_teammate', 'subagent', 'subagent_fork', 'workflow']

/** 工兵必须保留的工具面：干活、回报、记账、名册、自查。 */
const TEAMMATE_KEPT = [
  'pwsh',
  'send_message',
  'rt_hash',
  'rt_conclude',
  'team_task_create',
  'team_task_update',
  'team_task_list',
  'list_agents',
]

/** 一个工兵替身：可遮名单恰好是「四个被裁 + 保留清单」。 */
function teammateAgent(id = 'agent-scout', options = {}) {
  return fakeAgent(id, { restrictable: [...TEAMMATE_DENIED, ...TEAMMATE_KEPT], ...options })
}

/** 装配一个只有单个工兵的世界：安装时扫 `ctx.agents.list()`。 */
function maskWorld(agents, { services = { agentTeams: teamService() }, logger } = {}) {
  const cordis = fakeCordis({
    services,
    agents,
    ...(logger === undefined ? {} : { logger: { warn: (message) => logger.push(String(message)) } }),
  })
  return { ...cordis, installed: installTeammateMask(cordis.ctx) }
}

test('工兵裁剪：四个建人/派发入口被遮，pwsh/send_message/team_task_*/list_agents/rt_hash 仍在', () => {
  const scout = teammateAgent()
  const warnings = []
  const { installed } = maskWorld([scout.agent], { logger: warnings })

  assert.equal(installed, true, '有 ctx.on 就必须装上（遮罩失败不等于装不上）')
  assert.equal(scout.calls.length, 1, '安装时要扫一遍已有 agent（团队工具同名写法）')
  assert.deepEqual(Object.keys(scout.calls[0]), ['deny'], '只传 deny，不传 allow（allow 会变成白名单）')
  assert.deepEqual([...scout.calls[0].deny].sort(), [...TEAMMATE_DENIED].sort(), 'deny 表必须与 ticket 逐字一致')

  // 遮罩落地之后：四个消失，其余一个不少（尤其 pwsh / send_message / rt_hash）。
  assert.deepEqual(catalogFor(scout.agent, [...TEAMMATE_DENIED, ...TEAMMATE_KEPT]), TEAMMATE_KEPT)
  assert.equal(warnings.length, 0, '遮罩成功不该产生告警（工兵会有一二十个，日志要留给失败）')
})

test('工兵裁剪：先装后建的工兵由 agent/created 接管，且同一个 scope 只做一次', () => {
  const scout = teammateAgent()
  const { ctx, installed } = maskWorld([])
  assert.equal(installed, true)
  assert.equal(scout.calls.length, 0, '安装时这个世界里还没有这个 agent')

  ctx.emit('agent/created', { agent: scout.agent })
  assert.equal(scout.calls.length, 1, 'agent/created 是建人那一刻的钩子：不能等它撞工具才裁')

  ctx.emit('agent/created', { agent: scout.agent })
  assert.equal(scout.calls.length, 1, '同一个 scope 的事件重复到达也只做一次（同 scope 二次 restrict 会被宿主整表拒）')
  assert.deepEqual([...scout.calls[0].deny].sort(), [...TEAMMATE_DENIED].sort())
})

test('工兵裁剪（LDW-21）：续轮重建的工兵（同 id、新 scope）必须重新下遮罩', () => {
  const first = teammateAgent()
  const { ctx } = maskWorld([])
  ctx.emit('agent/created', { agent: first.agent })
  assert.equal(first.calls.length, 1)

  // 宿主续轮时重建可续轮工兵：同一个成员 id、同一个 session，但是**新的 agent 对象与新 scope**。
  // 现场（2026-11-03）：turn 1 = 271 工具；turn 2 = 273 工具，宿主还发了两条 `tool-addition`。
  const rebuilt = teammateAgent()
  ctx.emit('agent/status', { agent: rebuilt.agent })
  assert.equal(rebuilt.calls.length, 1, '重建后的 scope 上没有遮罩：不补这条，工具会以 tool-addition 回到目录')
  assert.deepEqual(catalogFor(rebuilt.agent, [...TEAMMATE_DENIED, ...TEAMMATE_KEPT]), TEAMMATE_KEPT)

  // status 每轮都来：同一个 scope 不能每轮都撞一次 restrict。
  ctx.emit('agent/status', { agent: rebuilt.agent })
  assert.equal(rebuilt.calls.length, 1, '同一个 scope 只做一次')
  assert.equal(first.calls.length, 1, '旧 scope 不会被重复处理')
})

test('工兵裁剪：Lead 与 bare subagent（不被团队服务认领）都不碰', () => {
  const lead = fakeAgent('agent-lead', { restrictable: [...TEAMMATE_DENIED, ...TEAMMATE_KEPT] })
  // bare subagent = 团队服务认不出的 agent（`subagent` 工具造出来的那种）：没有成员关系。
  const bare = teammateAgent('agent-bare')
  const scout = teammateAgent('agent-scout')
  const { ctx } = maskWorld([lead.agent, bare.agent, scout.agent])

  ctx.emit('agent/created', { agent: lead.agent })
  ctx.emit('agent/created', { agent: bare.agent })
  ctx.emit('agent/created', { agent: scout.agent })

  assert.equal(lead.calls.length, 0, 'Lead 的遮罩归角色闸（五个工具），这里一个名字都不能碰')
  assert.equal(bare.calls.length, 0, 'bare subagent 不是团队成员：不能按工兵裁')
  assert.equal(scout.calls.length, 1, '对照：真工兵必须被裁（证明上面的 0 不是没装）')
  assert.deepEqual(catalogFor(bare.agent, [...TEAMMATE_DENIED, ...TEAMMATE_KEPT]), [...TEAMMATE_DENIED, ...TEAMMATE_KEPT])
})

test('工兵裁剪：求交后才调 restrict —— 不可遮的名字不进 deny（整表拒绝的现场）', () => {
  // 组合树里没 compose `workflow` 引擎：它不在这个 scope 的可遮名单里。
  const partial = [...TEAMMATE_DENIED.filter((name) => name !== 'workflow'), ...TEAMMATE_KEPT]
  const scout = teammateAgent('agent-scout', { restrictable: partial })
  maskWorld([scout.agent])

  assert.equal(scout.calls.length, 1)
  assert.deepEqual([...scout.calls[0].deny].sort(), ['spawn_teammate', 'subagent', 'subagent_fork'], '只传交集')
  assert.deepEqual(catalogFor(scout.agent, [...TEAMMATE_DENIED, ...TEAMMATE_KEPT]), ['workflow', ...TEAMMATE_KEPT])
})

test('工兵裁剪：一个都不可遮时不调 restrict，并留一条诊断（不许静默没生效）', () => {
  const warnings = []
  const scout = teammateAgent('agent-scout', { restrictable: [...TEAMMATE_KEPT] })
  maskWorld([scout.agent], { logger: warnings })

  assert.equal(scout.calls.length, 0, '交集为空时调用 restrict 就是整表抛错')
  assert.equal(warnings.length, 1, '没遮住也必须留一条')
  assert.match(warnings[0], /agent-scout/u, '诊断要点名是哪个 agent')
  assert.match(warnings[0], /本应遮 4 个/u)
  assert.match(warnings[0], /实际遮 0 个/u)
})

test('工兵裁剪：restrict 整表被拒时吞掉异常、只记一条、不重复撞', () => {
  const warnings = []
  const scout = teammateAgent('agent-scout', {
    restrict() {
      throw new Error('tools.restrict() names unknown global tool "spawn_teammate"')
    },
  })
  const { ctx } = maskWorld([scout.agent], { logger: warnings })

  assert.equal(scout.calls.length, 1)
  ctx.emit('agent/created', { agent: scout.agent })
  assert.equal(scout.calls.length, 1, '失败也只尝试一次：重试会把每次建人都变成一次抛错')
  assert.equal(warnings.length, 1, '失败必须是可见的，而且一个 agent 只一条')
  assert.match(warnings[0], /agent-scout/u)
  assert.match(warnings[0], /spawn_teammate/u, '诊断要带上原始失败信息')
})

test('工兵裁剪：拿不到 scoped tools.restrict 时安静降级（不抛、不多条日志）', () => {
  const warnings = []
  const bareAgent = { id: 'agent-scout' } // 没有 ctx.tools：宿主形状不符
  const cordis = fakeCordis({ services: { agentTeams: teamService() }, agents: [bareAgent], logger: { warn: (m) => warnings.push(String(m)) } })
  assert.equal(installTeammateMask(cordis.ctx), true)
  assert.equal(warnings.length, 1, '拿不到工具面要留一条可见诊断')
  assert.match(warnings[0], /agent-scout/u)
})

test('工兵裁剪：宿主缺 ctx.on 时返回 false 并记一条，绝不抛（不能拖垮整个 apply）', () => {
  const warnings = []
  const { ctx } = fakeCordis({ services: { agentTeams: teamService() }, agents: [teammateAgent().agent] })
  delete ctx.on
  ctx.logger = { warn: (message) => warnings.push(String(message)) }

  assert.equal(installTeammateMask(ctx), false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /ctx\.on/u)
})

test('工兵裁剪：没有 ctx.agents 时不影响挂载，只是安装时那趟扫不到人', () => {
  const scout = teammateAgent()
  const cordis = fakeCordis({ services: { agentTeams: teamService() } })
  assert.equal(installTeammateMask(cordis.ctx), true)
  assert.equal(scout.calls.length, 0)
  cordis.ctx.emit('agent/created', { agent: scout.agent })
  assert.equal(scout.calls.length, 1, 'agent/created 这条路不依赖 ctx.agents')
})

test('工兵裁剪：遮罩的 disposer 归插件 fiber，卸载时解开', () => {
  const scout = teammateAgent()
  const { ctx, effects } = maskWorld([scout.agent])

  const effect = effects.find((entry) => entry.label === TEAMMATE_MASK_LABEL)
  assert.ok(effect, '遮罩必须挂在本插件 fiber 上，别在 agent 的 scope 上留一块没人收的遮罩')
  assert.equal(typeof effect.dispose, 'function')
  assert.equal(scout.lifted.length, 0, '插件还在跑时不得解除')

  effect.dispose()
  assert.equal(scout.lifted.length, 1)
})

test('工兵裁剪：与 Lead 的遮罩共用一个实现（同一张 deny 求交的入口，不同的表）', () => {
  // 两张表**语义不同**：Lead 那张挡的是「自己动手」，工兵这张挡的是「再派人」。
  // 交集只有三个名字（两者都该看不到），但 `spawn_teammate` 只属于工兵 —— Lead 必须留着它建人。
  assert.deepEqual([...TEAMMATE_DENIED_TOOLS].sort(), [...TEAMMATE_DENIED].sort(), '导出的 deny 表必须与 ticket 一致')
  assert.ok(!GATED_TOOLS.has('spawn_teammate'), 'spawn_teammate 是 Lead 的建人入口，绝不能进角色闸')
  for (const shared of ['subagent', 'subagent_fork', 'workflow']) {
    assert.ok(GATED_TOOLS.has(shared), `${shared} 两边都该看不到（Lead 不自己开、工兵不派）`)
    assert.ok(TEAMMATE_DENIED_TOOLS.has(shared), `${shared} 必须在工兵的 deny 表里`)
  }
})
