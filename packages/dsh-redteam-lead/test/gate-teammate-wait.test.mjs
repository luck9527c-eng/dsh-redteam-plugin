/**
 * 工兵侧的 `wait_agent` 闸（2026-11-10）。
 *
 * 现场（`session-4a879223` 的 `sapper-runtime`）：37 次 `wait_agent`、0 次超时、累计阻塞 **1087 秒**。
 * 它要等的是「Lead 放行」，而 `wait_agent` 等的是「团队里任意变化」——同一队里别人写任务板、
 * 另一个成员切状态都会把它叫醒，醒来发现不是要的东西，再等一次 → 自旋。
 *
 * 这条闸补的是遮罩永远够不着的那一块：`wait_agent` 注册在 agent **自己的 ctx**（own 层），
 * `tools.restrict` 摘不掉；服务层也不拦（`waitForChange` 没有角色校验）。
 *
 * 钉住五件事：
 * 1. 非 root 团队成员调 `wait_agent` → 拒，且理由说的是「你没有对等同伴」那套；
 * 2. bare subagent（判不出团队成员身份）→ 放行，这条闸不适用于它；
 * 3. 工兵的其它工具（read / pwsh / send_message）一律不受影响；
 * 4. Lead 侧不变：仍走 `gatedTools` + `gatedReasons` 那道，两条理由不能串；
 * 5. 会话头读不出来（`unknown`）→ 放行（fail-open，与既有取向一致）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TEAMMATE_GATED_TOOLS,
  createRoleGate,
  decideGate,
  teammateDenyReason,
} from '../dist/gate.js'

// ---------------------------------------------------------------------------
// 替身
// ---------------------------------------------------------------------------

/** 团队服务替身：`lead-1` 是 Lead，`teammate-1` 是工兵，其余不认（= bare subagent）。 */
function teamService() {
  return {
    tryMembership(agent) {
      if (agent?.id === 'lead-1') return { root: 'session-root', id: 'team-1', role: 'lead', name: 'lead' }
      if (agent?.id === 'teammate-1') return { root: 'session-root', id: 'team-1', role: 'teammate', name: 'rt-a' }
      return undefined
    },
  }
}

/** 最小 ctx：`get('agentTeams')` + 一个 logger（`serviceOf` 会先试直读、再退 `get`）。 */
function fakeCtx() {
  const warnings = []
  return {
    warnings,
    ctx: {
      logger: { warn: (message) => warnings.push(String(message)) },
      get: (service) => (service === 'agentTeams' ? teamService() : undefined),
    },
  }
}

/** 一条 exec。`header` 决定 `rootOf`：给 `delegationDepth: 1` 就是子代。 */
function exec(tool, agentId, header = {}) {
  return { name: tool, arguments: {}, agent: { id: agentId, session: { header } } }
}

/** 子代（工兵/裸子代理）的会话头。 */
const CHILD = { delegationDepth: 1 }
/** 会话根的会话头。 */
const ROOT = {}

// ---------------------------------------------------------------------------
// 1. 纯判定
// ---------------------------------------------------------------------------

test('禁表只有 wait_agent 一个（spawn_teammate 交给服务层的 TEAM_LEAD_REQUIRED）', () => {
  assert.deepEqual([...TEAMMATE_GATED_TOOLS], ['wait_agent'])
})

test('工兵调 wait_agent：拒，理由是"没有对等同伴"那一套', () => {
  const decision = decideGate({ tool: 'wait_agent', root: 'child', role: 'teammate' })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /没有对等同伴/u)
  assert.match(decision.reason, /send_message/u, '必须给出替代动作')
  assert.match(decision.reason, /结束回合/u, '必须说清"结束回合就够"')
  assert.match(decision.reason, /唤醒/u, '必须说清 Lead 一说话会唤醒它')
  assert.doesNotMatch(decision.reason, /派给工兵/u, '不能串用 Lead 那条理由')
})

test('`other` 角色（非 Lead 的成员）同样被拒', () => {
  const decision = decideGate({ tool: 'wait_agent', root: 'child', role: 'other' })
  assert.equal(decision.kind, 'deny')
})

test('bare subagent（判不出成员身份）放行：它不在团队里', () => {
  const decision = decideGate({ tool: 'wait_agent', root: 'child', role: 'unknown' })
  assert.equal(decision.kind, 'allow')
})

test('会话头读不出来（unknown 位置）放行 —— fail-open', () => {
  const decision = decideGate({ tool: 'wait_agent', root: 'unknown', role: 'teammate' })
  assert.equal(decision.kind, 'allow')
})

test('工兵的其它工具不受影响：read / pwsh / send_message / spawn_teammate 都放行', () => {
  for (const tool of ['read', 'pwsh', 'send_message', 'team_task_list', 'spawn_teammate']) {
    const decision = decideGate({ tool, root: 'child', role: 'teammate' })
    assert.equal(decision.kind, 'allow', `${tool} 不该被这条闸拦`)
  }
})

test('Lead 侧不变：仍走 gated + gatedReasons 那一套，两条理由不串', () => {
  const leadReason = '不需要等待：成员完成会唤醒你。'
  const decision = decideGate({
    tool: 'wait_agent',
    root: 'root',
    role: 'lead',
    gated: new Set(['wait_agent']),
    reasons: { wait_agent: leadReason },
  })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /^\[redteam-lead\] 拒绝执行 wait_agent：/u)
  assert.match(decision.reason, /成员完成会唤醒你/u, 'Lead 用的是配置那条理由')
  assert.doesNotMatch(decision.reason, /没有对等同伴/u, '不能混进工兵那条')
})

test('Lead 没把 wait_agent 写进 gatedTools 时，Lead 侧放行（禁表仍是参数）', () => {
  const decision = decideGate({ tool: 'wait_agent', root: 'root', role: 'lead', gated: new Set(['workflow']) })
  assert.equal(decision.kind, 'allow')
})

// ---------------------------------------------------------------------------
// 2. 装配路径（createRoleGate）
// ---------------------------------------------------------------------------

/** 跑一次闸：返回决定，或下游的返回值。 */
async function run(gate, tool, agentId, header) {
  return await gate(exec(tool, agentId, header), () => 'downstream')
}

test('装配后：工兵的 wait_agent 被拒，它的 read 仍然放行', async () => {
  const { ctx } = fakeCtx()
  const gate = createRoleGate(ctx, new Set(['pwsh']))

  const denied = await run(gate, 'wait_agent', 'teammate-1', CHILD)
  assert.equal(denied.kind, 'deny')
  assert.equal(denied.reason, teammateDenyReason('wait_agent'), '理由必须与导出的构造器逐字一致')

  assert.equal(await run(gate, 'read', 'teammate-1', CHILD), 'downstream')
  assert.equal(await run(gate, 'pwsh', 'teammate-1', CHILD), 'downstream', '工兵的 shell 不在禁表里')
})

test('装配后：bare subagent（团队不认）的 wait_agent 放行', async () => {
  const { ctx } = fakeCtx()
  const gate = createRoleGate(ctx, new Set(['pwsh']))
  assert.equal(await run(gate, 'wait_agent', 'bare-subagent', CHILD), 'downstream')
})

test('装配后：Lead 的 wait_agent 仍由 gated 拦（与工兵那条互不干扰）', async () => {
  const { ctx } = fakeCtx()
  const gate = createRoleGate(ctx, new Set(['wait_agent']), new WeakSet(), { wait_agent: '不需要等待。' })

  const decision = await run(gate, 'wait_agent', 'lead-1', ROOT)
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /不需要等待/u)
  assert.doesNotMatch(decision.reason, /没有对等同伴/u)
})
