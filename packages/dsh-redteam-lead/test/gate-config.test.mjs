/**
 * `config.gatedTools`：本包行声明的禁表（角色闸挡哪几个名字）。
 *
 * 解析规则（`src/index.ts` 的 `resolveGatedTools`）：
 * - **缺省**（没写这个键，或写成 `undefined`）→ `DEFAULT_GATED_TOOLS`，一条警告都不记；
 * - **合法**：非空数组，且每个元素都是去掉首尾空白后非空的字符串 → 去首尾空白、按首次出现去重后使用；
 * - **畸形**：字符串、空数组、含非字符串/空白串元素的数组、对象…… → 退回 `DEFAULT_GATED_TOOLS`
 *   并记**恰好一条关于本配置的** `ctx.logger.warn`（显式空数组也算畸形：要「什么都不挡」得删名字，
 *   不能靠空值）。遮罩自己那条「本应遮 N 个」的诊断是另一件事，不在这里计数。
 *
 * 这些用例一律走 **`apply()`**，不是直接调解析函数：配置错了在宿主里的表现就是「闸宽了」或
 * 「没有警告」，只有从入口装配一遍、再拿装到 `tools/pre-execute` 上的那条监听器去调，
 * 才能证明配置真的穿到了判定与遮罩两处。
 *
 * 判据来自 `docs/specs/lead-does-not-work.md` §变更 1（LDW-1）与 LDW-8/11 的遮罩约定。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as index from '../dist/index.js'
import { DEFAULT_GATED_TOOLS } from '../dist/gate.js'

/** 宿主会写下的那张默认表（独立写一遍，不从被测常量生成期望值）。 */
const DEFAULT_NAMES = ['bash', 'pwsh', 'subagent', 'subagent_fork', 'workflow']

/** 人设文本：给了它，`apply()` 里的人设装配就不吭声，警告只可能来自被测的配置解析。 */
const PERSONAS = { leadPersona: '你是指挥。', teammatePersona: '你是工兵。' }

/** 团队服务替身：只有 `agent-lead` 是 Lead。 */
const TEAM = {
  tryMembership(agent) {
    return agent?.id === 'agent-lead' ? { role: 'lead', name: 'lead' } : undefined
  },
}

/**
 * 一个会话根的 Lead agent，带宿主那三个面里本包用到的两个：
 * `tools.view(scope).restrictableNames`（restrict 逐字校验的那一份）与 `tools.restrict`。
 *
 * `restrictable` 默认是宿主真实形状的一个子集：五个默认名字 + Lead 的核对手段。
 */
function fakeLead({ id = 'agent-lead', restrictable = [...DEFAULT_NAMES, 'read', 'grep'] } = {}) {
  const calls = []
  const agent = {
    id,
    ctx: {
      tools: {
        view() {
          return { restrictableNames: new Set(restrictable) }
        },
        restrict(filter) {
          const unknown = [...(filter.deny ?? [])].filter((name) => !restrictable.includes(name))
          if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool "${unknown[0]}"`)
          calls.push(filter)
          return () => {}
        },
      },
    },
  }
  return { agent, calls }
}

/**
 * 最小 Cordis 形状的假 ctx + 一次真的 `apply()`。
 *
 * `systemPrompt` / 人设文本都给齐，所以除配置解析与遮罩诊断外不会有别的 warn。
 * `configWarnings` 只留「提到 gatedTools」的那几条 —— 被测对象只有这个键。
 */
function install(config, { lead = fakeLead() } = {}) {
  const warnings = []
  const listeners = []
  const effects = []
  const ctx = {
    logger: {
      warn(message) {
        warnings.push(String(message))
      },
    },
    systemPrompt: {
      getSectionOrder: () => 0,
      section() {
        return () => {}
      },
    },
    agents: {
      list: () => [lead.agent],
      get: (id) => (id === lead.agent.id ? lead.agent : undefined),
    },
    get(service) {
      if (service === 'tools') return ctx.tools
      if (service === 'agentTeams') return TEAM
      return undefined
    },
    on(event, listener, options) {
      listeners.push({ event, listener, options })
      return () => {}
    },
    effect(produce) {
      const iterator = produce()
      let step = iterator.next()
      while (step.done !== true) step = iterator.next(step.value)
      effects.push({ label: 'effect' })
      return () => {}
    },
    tools: {
      register() {
        return () => {}
      },
    },
  }

  index.apply(ctx, { defaults: {}, ...PERSONAS, ...config })

  const gate = listeners.find((entry) => entry.event === 'tools/pre-execute')
  assert.ok(gate, 'apply() 必须装上角色闸，否则这些用例测的就不是真实装配路径')
  const configWarnings = warnings.filter((message) => message.includes('gatedTools'))
  return { ctx, lead, warnings, configWarnings, gate: gate.listener, listeners, effects }
}

/** 一条会话根的 `exec`（会话头空 = 根）。 */
function rootExec(tool, agent) {
  return { name: tool, arguments: {}, agent: { ...agent, session: { header: {} } } }
}

/** 跑一次监听器，返回决定（放行时返回下游的原值）。 */
async function decide(gate, tool, agent) {
  return await gate(rootExec(tool, agent), () => 'downstream')
}

// —— 缺省：不写这个键，行为与改动前完全一样 ——

test('缺省不配 gatedTools：五个默认名字照旧被拒，且没有配置警告', async () => {
  const { lead, configWarnings, gate } = install({})

  for (const tool of DEFAULT_NAMES) {
    assert.equal((await decide(gate, tool, lead.agent)).kind, 'deny', `${tool}：缺省必须仍是默认禁表`)
  }
  assert.equal(await decide(gate, 'read', lead.agent), 'downstream', '核对手段必须放行')

  assert.equal(lead.calls.length, 1, '遮蔽照旧只下发一次')
  assert.deepEqual([...lead.calls[0].deny].sort(), DEFAULT_NAMES, '缺省时遮罩仍是那五个')
  assert.deepEqual(configWarnings, [], '没写配置就不是错误：一条配置警告都不能有')
})

// —— 窄化：验证配置能把默认五个收窄（shipped 已不再用窄表，仍是五个全挡） ——

test('窄化配置：pwsh 放行、workflow 仍拒；遮罩只遮配置里的名字', async () => {
  const { lead, configWarnings, gate } = install({ gatedTools: ['workflow'] })

  assert.equal(await decide(gate, 'pwsh', lead.agent), 'downstream', 'pwsh 不在配置里 → 会话根也放行')
  assert.equal(await decide(gate, 'bash', lead.agent), 'downstream', 'bash 同样放行')

  const denied = await decide(gate, 'workflow', lead.agent)
  assert.equal(denied.kind, 'deny', '配置里点名的 workflow 必须拒绝')
  assert.match(denied.reason, /workflow/u)

  assert.equal(lead.calls.length, 1, '遮罩在第一次调用时就落地')
  assert.deepEqual(lead.calls[0].deny, ['workflow'], '遮罩的名字 = 配置里的名字 ∩ 可遮名单')
  assert.deepEqual(configWarnings, [], '合法配置不是错误，不该有警告')
})

// —— 放宽：显式把五个都写回去（「怎么把 shell 加回来」的配置形态） ——

test('放宽配置：显式写全五个，shell 重新被拒，遮罩也回到五个', async () => {
  const { lead, configWarnings, gate } = install({ gatedTools: [...DEFAULT_NAMES] })

  for (const tool of DEFAULT_NAMES) {
    assert.equal((await decide(gate, tool, lead.agent)).kind, 'deny', `${tool}：写回配置后必须重新被拒`)
  }
  assert.equal(await decide(gate, 'read', lead.agent), 'downstream')

  assert.deepEqual([...lead.calls[0].deny].sort(), DEFAULT_NAMES)
  assert.deepEqual(configWarnings, [])
})

test('放宽到默认表以外的名字：配置写了什么就挡什么', async () => {
  // 可遮名单里带上 rt_hash：证明「配置里多出来的名字」也会被遮罩，不只是默认那五个。
  const lead = fakeLead({ restrictable: [...DEFAULT_NAMES, 'read', 'grep', 'rt_hash'] })
  const { gate } = install({ gatedTools: ['workflow', 'rt_hash'] }, { lead })

  assert.equal((await decide(gate, 'rt_hash', lead.agent)).kind, 'deny', '配置是唯一来源，默认表之外的名字照样生效')
  assert.equal((await decide(gate, 'rt_conclude', lead.agent)), 'downstream', '没配置的名字一律放行')

  assert.deepEqual(lead.calls[0].deny, ['workflow', 'rt_hash'], '遮罩 = 配置里的名字 ∩ 可遮名单，不掺默认表')
})

// —— 去重与空白：合法输入的正常化 ——

test('合法配置会去重：重复的名字只算一次', async () => {
  const { lead, configWarnings, gate } = install({ gatedTools: ['workflow', 'workflow', 'pwsh'] })

  assert.equal((await decide(gate, 'pwsh', lead.agent)).kind, 'deny')
  assert.deepEqual(lead.calls[0].deny, ['workflow', 'pwsh'], 'deny 里不许出现重复名字')
  assert.deepEqual(configWarnings, [], '重复不是畸形：去重即可，不用报警')
})

// —— 畸形：退回默认 + 恰好一条警告 ——

test('畸形 gatedTools：退回默认五个，并且恰好记一条配置警告', async () => {
  const cases = [
    ['字符串（不是数组）', 'workflow'],
    ['显式空数组（「什么都不挡」不是靠空值表达的）', []],
    ['元素里有非字符串', ['workflow', 1]],
    ['元素里有 null', ['workflow', null]],
    ['元素有空串', ['workflow', '']],
    ['元素只有空白', ['workflow', '   ']],
    ['对象（不是数组）', { workflow: true }],
    ['数字', 5],
  ]

  for (const [label, gatedTools] of cases) {
    const { lead, configWarnings, gate } = install({ gatedTools })

    assert.equal(configWarnings.length, 1, `${label}：畸形只该记一条配置警告，实际 ${configWarnings.length} 条`)
    assert.match(configWarnings[0], /gatedTools/u, `${label}：警告必须点名是哪个配置键`)
    assert.match(configWarnings[0], /pwsh/u, `${label}：警告要说清退回了哪份默认表`)

    assert.equal((await decide(gate, 'pwsh', lead.agent)).kind, 'deny', `${label}：必须退回默认禁表（pwsh 仍被拒）`)
    assert.equal((await decide(gate, 'bash', lead.agent)).kind, 'deny', `${label}：bash 也仍在默认表里`)

    assert.equal(lead.calls.length, 1, `${label}：遮罩也要用默认表`)
    assert.deepEqual([...lead.calls[0].deny].sort(), DEFAULT_NAMES, `${label}：遮罩必须回到五个`)
  }
})

test('畸形配置的警告带本包的 label，且默认表就是导出的那一份', async () => {
  const { configWarnings } = install({ gatedTools: 'pwsh' })
  assert.equal(configWarnings.length, 1)
  assert.match(configWarnings[0], /^\[redteam-lead\/role-gate\]/u, '警告要走既有诊断通道并带 label')
  assert.deepEqual([...DEFAULT_GATED_TOOLS].sort(), DEFAULT_NAMES, '退回的那份表就是导出的 DEFAULT_GATED_TOOLS')
})

test('畸形数组的警告点名的是**出错那一项**，不会被前面的重复名字带偏', async () => {
  // 第 3 项才是坏的；如果按「已收下的名字个数 + 1」算位置，前面重复过一次就会误报第 2 项。
  const { configWarnings } = install({ gatedTools: ['workflow', 'workflow', 5] })
  assert.equal(configWarnings.length, 1)
  assert.match(configWarnings[0], /第 3 项/u, `警告必须指向第 3 项，实际：${configWarnings[0]}`)
})
