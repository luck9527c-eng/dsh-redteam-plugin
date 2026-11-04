/**
 * bundle 形状测试：包清单、patch 行、plugin 导出接缝、以及「两个 `rt_*` 真的没了」（LDW-23）。
 *
 * 这些断言针对**文件与注册接缝**，不针对内部函数名：patch 写错一个插件名在宿主里是
 * WARN + SKIP（DECISIONS D14），所以这里把关键事实解析出来再比对，而不是「文件里有这一行」。
 *
 * LDW-23 之后本包**不注册任何工具**，所以这个文件不再有工具 schema 漂移、handler 表、
 * 结果信封那些断言 —— 那些代码已经删了。这里留下的只有「行还在不在」「导出的形状对不对」
 * 「有没有偷偷把工具加回来」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT))

const PATCH = readFileSync(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))

/** 基线里被删掉的三行：两行与团队工具同名、语义不同；`persona` 行在 LDW-16 删（文本搬进本包配置）。 */
const REMOVED_ROWS = ['tool-subagent-control', 'tool-subagent-list-agents', 'persona']

/** 基线里必须保留的裸委派行。 */
const KEPT_DELEGATION_ROWS = ['tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow']

/** 本包追加的行 id。 */
const ADDED_ROW = 'redteam-lead-tools'

/** patch 里 `- id: X` 的顶层/嵌套行 id（顺序无关；重复由断言另行检查）。 */
function rowIds() {
  return [...PATCH.matchAll(/^\s*-\s+id:\s*([A-Za-z0-9_@./-]+)\s*$/gmu)].map((match) => match[1])
}

/** 取块标量正文：`<key>: |-` 之后直到下一个同级或更浅缩进的非空行。 */
function blockScalar(key) {
  const lines = PATCH.split('\n')
  const start = lines.findIndex((line) => new RegExp(`^\\s*${key}:\\s*[|>][+-]?\\s*$`, 'u').test(line))
  if (start < 0) return undefined
  const indent = lines[start].length - lines[start].trimStart().length
  const body = []
  for (const line of lines.slice(start + 1)) {
    const lineIndent = line.length - line.trimStart().length
    if (line.trim() !== '' && lineIndent <= indent) break
    body.push(line)
  }
  return body.join('\n')
}

/** dist 下所有 `.js`（构建产物，测试跑之前必须先 build）。 */
function distFiles(dir = join(PACKAGE_ROOT, 'dist'), out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) distFiles(path, out)
    else if (entry.endsWith('.js')) out.push(path)
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. 包清单
// ---------------------------------------------------------------------------

test('包清单：不发布 bin/，且没有运行时依赖（测试自带 YAML 断言，不引第三方解析器）', () => {
  assert.equal(MANIFEST.dependencies, undefined, '零运行时依赖：bundle 按真实路径解析裸包名')
  assert.equal(MANIFEST.bin, undefined, 'doctor 已随工具面删除（LDW-23）')
  assert.ok(!MANIFEST.files.includes('bin'), 'files 里不能还挂着不存在的 bin/')
  assert.deepEqual(MANIFEST.files.sort(), ['cordis.patch.yml', 'dist', 'icon.svg', 'locale'].sort())
  assert.equal(MANIFEST.dsh?.bundle?.patch, './cordis.patch.yml')
})

test('locale 里每个 json 都能解析（exports 声明了 ./locale/*.json）', () => {
  const dir = join(PACKAGE_ROOT, 'locale')
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  assert.ok(files.length > 0, 'locale 目录不能空：meta.title / meta.description 从这里读')
  for (const file of files) {
    const meta = JSON.parse(readFileSync(join(dir, file), 'utf8')).meta
    assert.equal(typeof meta?.title, 'string')
    assert.ok(meta.title.length > 0)
  }
})

// ---------------------------------------------------------------------------
// 2. patch 行清单
// ---------------------------------------------------------------------------

test('patch：preset 行与本包行都在，且行 id 不重复', () => {
  const ids = rowIds()
  assert.ok(ids.includes('preset-redteam-lead'), 'preset 行必须在')
  assert.ok(ids.includes(ADDED_ROW), '本包行必须在')
  assert.equal(new Set(ids).size, ids.length, '行 id 不得重复（宿主按 id 去重，重复会静默吞掉一行）')
})

test('patch：基线里被删的三行确实不在（删了才是现在的能力面）', () => {
  const ids = rowIds()
  for (const removed of REMOVED_ROWS) assert.ok(!ids.includes(removed), `${removed} 不应再出现`)
})

test('patch：裸委派行四行仍在（Lead 的零碎活靠它们）', () => {
  const ids = rowIds()
  for (const kept of KEPT_DELEGATION_ROWS) assert.ok(ids.includes(kept), `${kept} 必须保留`)
})

test('patch（LDW-22）：tool-subagent 不再声明 modelSelectionSettings，subagent 才可遮', () => {
  // 只允许出现在注释里：真正的配置键必须没有。
  const lines = PATCH.split('\n').filter((line) => /^\s*modelSelectionSettings\s*:/u.test(line))
  assert.deepEqual(lines, [], '这个开关会让 subagent 注册在 own 层，遮罩永远遮不掉')
})

test('patch：本包行的 config 只有 gatedTools 与人设两项（不再有工具相关键）', () => {
  const start = PATCH.indexOf(`- id: ${ADDED_ROW}`)
  assert.ok(start >= 0)
  const tail = PATCH.slice(start)
  const configStart = tail.indexOf('config:')
  assert.ok(configStart >= 0, '本包行必须有 config')
  const body = tail.slice(configStart)
  const keys = [...body.matchAll(/^\s{14}([A-Za-z][A-Za-z0-9]*):/gmu)].map((match) => match[1])
  assert.deepEqual([...new Set(keys)].sort(), ['gatedTools', 'leadPersona', 'teammatePersona'])
})

test('patch：禁表仍是 shipped 的那三个（shell 放行）', () => {
  assert.match(PATCH, /^\s*gatedTools:\s*\[workflow, subagent, subagent_fork\]\s*$/mu)
})

test('人设文本：Lead 那份不再提 rt_*（工具已删，提了就是让模型找不存在的东西）', () => {
  for (const key of ['leadPersona', 'teammatePersona']) {
    const text = blockScalar(key)
    assert.equal(typeof text, 'string', `${key} 必须是块标量`)
    assert.ok(text.length > 100, `${key} 不能是空壳`)
    assert.ok(!/rt_conclude|rt_hash|rt_\*/u.test(text), `${key} 里不能残留 rt_* 的指引`)
  }
  const lead = blockScalar('leadPersona')
  assert.match(lead, /reverse-project-management/u, '账目必须指向 skill 的 project.py')
  assert.match(lead, /不亲自跑/u, '「决策者不是打字机」这段是这一行的核心')
  // D50：拆解 + 选路线 + 不许无脑重试 —— 三条都对应 2026-11-02 那轮的真实浪费。
  assert.match(lead, /先拆目标/u, '必须要求先拆目标再选路线')
  assert.match(lead, /判别力/u, '候选路线要按代价与判别力比较，不能想到哪条干哪条')
  assert.match(lead, /无脑重试/u, '必须明说：连续两步没新信息就换路')

  // D52：工兵那份的三条要点 —— 草稿≠交付物 / 数字要口径 / 没有派发权。
  const scout = blockScalar('teammatePersona')
  assert.match(scout, /草稿不是交付物/u, '工兵只写草稿，正式记录归 Lead')
  assert.match(scout, /口径/u, '数字必须带样本量/覆盖率/对照组')
  assert.match(scout, /没有派发权/u, '角色边界要在工兵自己读的地方说全')
})

// ---------------------------------------------------------------------------
// 3. 插件导出与 apply 接缝
// ---------------------------------------------------------------------------

test('index：只导出 name / inject / apply（加上纯函数接缝），没有 default export', async () => {
  const index = await import('../dist/index.js')
  assert.equal(index.name, 'redteam-lead-tools')
  assert.deepEqual(index.inject, ['agents', 'agentTeams', 'systemPrompt'], '工具面删了，tools 不再是硬依赖')
  assert.equal(typeof index.apply, 'function')
  assert.equal(typeof index.resolveGatedTools, 'function')
  assert.equal(index.default, undefined, 'bundle 只认具名导出')
})

test('apply：不注册任何工具，只装闸 + 两套人设 + 工兵遮罩', async () => {
  const listeners = []
  const sections = []
  const agents = []
  const ctx = {
    on(event, listener, options) {
      listeners.push({ event, listener, options })
      return () => {}
    },
    effect(install) {
      const produced = install()
      if (typeof produced === 'function') return produced
      let step = produced.next()
      while (step.done !== true) step = produced.next(step.value)
      return () => {}
    },
    logger: { warn() {} },
    agents: { list: () => [...agents], get: (id) => agents.find((agent) => agent.id === id) },
    agentTeams: { tryMembership: () => undefined },
    systemPrompt: {
      getSectionOrder: () => 7,
      section(entry) {
        sections.push(entry)
        return () => {}
      },
    },
    tools: {
      register() {
        throw new Error('本包不再注册任何工具（LDW-23）')
      },
    },
  }

  const index = await import('../dist/index.js')
  index.apply(ctx, { leadPersona: '你是这支队伍的 Lead。', teammatePersona: '你是工兵。' })

  const events = listeners.map((entry) => entry.event)
  assert.ok(events.includes('tools/pre-execute'), '角色闸必须挂上')
  assert.ok(events.includes('agent/created'), '工兵遮罩与工兵人设挂 agent/created')
  assert.ok(events.includes('agent/status'), '续轮重建靠 agent/status（LDW-21）')
  assert.equal(sections.length, 1, 'preset 层只注册 Lead 那一份人设')
  assert.equal(sections[0].text, '你是这支队伍的 Lead。')
})

// ---------------------------------------------------------------------------
// 4. 「工具真的删干净了」
// ---------------------------------------------------------------------------

test('dist 里不再出现 rt_conclude / rt_hash（删工具不是只删注册那一行）', () => {
  for (const file of distFiles()) {
    const text = readFileSync(file, 'utf8')
    assert.ok(!text.includes('rt_conclude'), `${file} 里还有 rt_conclude`)
    assert.ok(!text.includes('rt_hash'), `${file} 里还有 rt_hash`)
  }
})

test('dist 里没有裸 @deepseek-ai import（link: 安装的 bundle 解析不到）', () => {
  for (const file of distFiles()) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/from\s+['"](@deepseek-ai\/[^'"]+)['"]/gu)) {
      assert.fail(`${file} import 了 ${match[1]}：会 ERR_MODULE_NOT_FOUND，整行插件不激活`)
    }
  }
})

test('工具面的契约文件已删（docs/specs/rt-tools.schema.json）', () => {
  assert.equal(existsSync(join(REPO_ROOT, 'docs', 'specs', 'rt-tools.schema.json')), false)
})
