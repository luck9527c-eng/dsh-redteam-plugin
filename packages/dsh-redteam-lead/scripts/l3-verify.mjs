#!/usr/bin/env node
/**
 * 第三层（真 `ctx.agentTeams` 会话）验收的**只读**辅助脚本。
 *
 * 为什么要有这个脚本：第三层不能塞进 `node --test`（宿主包只在打包的 `app.asar` 里，裸 `node`
 * 无法 require），只能由一个人在一次性的 DSH 会话里照着清单跑一遍。人在会话里能看到的只有
 * 「工具返回了什么」；至于「这一步到底往项目里写了什么」需要另外取证。本脚本只做三件事：
 *
 *   collect   --project <root> --out <file>   把项目侧证据文件的 路径 + 字节 SHA-256 + mtime 收成 JSON
 *   diff      --before <f> --after <f> [--out <file>]
 *                                             对比两次 collect，报新增 / 变更 / 删除
 *   checklist --out <file>                    生成七步验收清单 markdown（含可观察断言与 A 编号）
 *
 * 硬约束（与 ticket T9 一致）：
 * - **零依赖**：只用 Node 内置模块，不 import 任何 `@deepseek-ai/*` 或第三方包。
 * - **对项目只读**：不创建、不修改、不删除项目内任何文件；唯一的写入是 `--out` 指定的路径，
 *   且**拒绝**把 `--out` 落到 `--project` 之内（否则「只读」就成了空话）。
 * - **不联网**、不启动分析工具、不调用宿主。
 * - **确定性**：同一棵目录树连跑两次，输出逐字节相同；只有文件真的变了才会出现 mtime 差异。
 *   （所以输出里没有 `generated_at` 之类的时间戳——时间属于记录模板，不属于证据。）
 * - 缺失目录/文件是**显式缺口**（`gaps`），不是崩溃。
 *
 * 用法见 `docs/verify/README.md`；清单正文见 `docs/verify/l3-checklist.md`（由本脚本生成）。
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, readlink, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { argv, platform, stderr, stdout } from 'node:process'

/** collect 输出格式版本；改形状时 +1，diff 会拒绝跨版本比较。 */
const SCHEMA_VERSION = 1

/** 三个子命令各自的 kind，防止把 checklist 当 collect 喂给 diff。 */
const KIND_COLLECT = 'l3-evidence-collect'
const KIND_DIFF = 'l3-evidence-diff'

/** 单个目标最多收多少个文件（防止把巨大的 work/ 或 receipts/ 拖死）。 */
const MAX_FILES_PER_TARGET = 20000
/** 递归深度上限（正常 `re/seals/**` 只有两三层）。 */
const MAX_DEPTH = 16

/**
 * 收集目标表。
 *
 * `expectation: 'required'` = 本包（或 skill）一定会写的记录；缺了要在 `gaps` 里点名。
 * `expectation: 'optional'` = 说话才算数的声明类/残留类文件（草稿、锁、工具清单）。它们缺失本身
 * 就是一条有意义的证据，所以只记 `absent`，不算缺口。
 *
 * 路径常量与实现保持一致：`src/conclude.ts`（work/receipts）、`src/audit.ts`（audit.jsonl）、
 * `src/operation.ts`（operations）、`src/lock.ts`（lock）、`src/project-adapter.ts`（routes/seals）。
 *
 * LDW-13/14/17 删除的目录不再收：`re/team/binding.json`、`roster.json`、`resources.json`、
 * `dispatches/`、`attempts/`、`baselines/`、`capabilities.json` —— 它们不会再出现，收它们只会让
 * 每次 collect 都报一堆假的"缺口"。
 */
const TARGETS = [
  { id: 'audit', kind: 'file', path: 're/team/audit.jsonl', expectation: 'required', label: '审计（append-only）' },
  { id: 'receipts', kind: 'tree', path: 're/team/receipts', expectation: 'required', label: '收口回执' },
  { id: 'routes', kind: 'glob', path: 're/routes', expectation: 'required', label: '路线记录（skill 写）' },
  { id: 'seals', kind: 'tree', path: 're/seals', expectation: 'required', label: '封存记录' },
  { id: 'work', kind: 'tree', path: 're/team/work', expectation: 'optional', label: '路线草稿区（子目录名 = route-id）' },
  { id: 'lock', kind: 'file', path: 're/team/lock', expectation: 'optional', label: '项目锁（残留即证据）' },
  { id: 'operations', kind: 'glob', path: 're/team/operations', expectation: 'optional', label: '操作台账（重放证据）' },
  { id: 'env-tools', kind: 'file', path: 're/env/tools.json', expectation: 'optional', label: '工具清单（无生产者，D11）' },
]

class UsageError extends Error {}

/* -------------------------------------------------------------------------- */
/* 参数解析                                                                    */
/* -------------------------------------------------------------------------- */

const USAGE = `用法：
  node scripts/l3-verify.mjs collect --project <项目根> --out <文件>
  node scripts/l3-verify.mjs diff --before <collect.json> --after <collect.json> [--out <文件>]
  node scripts/l3-verify.mjs checklist --out <文件>

  collect    收项目侧证据文件的 路径 + 字节 SHA-256 + mtime（只读项目；缺目录报 gaps 不崩）
  diff       对比两次 collect，报新增 / 变更 / 删除（默认把 JSON 打到 stdout）
  checklist  生成七步验收清单 markdown（含可观察断言与 A 编号）

  公共：--help 打印本说明；--debug 出错时附带堆栈。`

/** 按 `--key value` / `--key=value` 解析；未知开关由各子命令自己拒绝。 */
function parseArgv(tokens) {
  const options = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) throw new UsageError(`多余的参数：${token}`)
    const equals = token.indexOf('=')
    if (equals !== -1) {
      options[token.slice(2, equals)] = token.slice(equals + 1)
      continue
    }
    const key = token.slice(2)
    const value = tokens[index + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${key} 缺少值`)
    options[key] = value
    index += 1
  }
  return options
}

function requireOption(options, key) {
  const value = options[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new UsageError(`缺少必需参数 --${key}（用 --help 看用法）`)
  }
  return value
}

function assertKnownOptions(options, allowed) {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw new UsageError(`未知参数 --${key}（用 --help 看用法）`)
  }
}

/* -------------------------------------------------------------------------- */
/* 路径与小工具                                                                */
/* -------------------------------------------------------------------------- */

/** 项目内路径一律 `/` 分隔（与插件写出的相对路径同形）。 */
function toPosix(relativePath) {
  return relativePath.split(sep).join('/')
}

/** 大小写无关的比较：Windows 上 `Re` 与 `re` 是同一棵树（DECISIONS 路径规则）。 */
function foldForCompare(value) {
  return platform === 'win32' ? value.toLowerCase() : value
}

/** `child` 是否就是 `parent` 或在它内部（不做 realpath，调用方已规范化）。 */
function isInside(child, parent) {
  const from = foldForCompare(resolve(parent))
  const to = foldForCompare(resolve(child))
  if (to === from) return true
  const rel = relative(from, to)
  if (rel === '' || isAbsolute(rel)) return false
  return !(rel === '..' || rel.startsWith(`..${sep}`))
}

/** 稳定的字节序排序：不用 localeCompare（不同机器的区域设置会改顺序）。 */
function compareText(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 错误码：只取 `code`，绝不把 message 塞进确定性输出（message 含本机绝对路径）。 */
function errorCode(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string') return error.code
  return 'UNKNOWN'
}

/* -------------------------------------------------------------------------- */
/* collect                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 流式算一个文件的证据：字节数、SHA-256、mtime、以及 `.jsonl` 的行数。
 *
 * 行数是「审计多一条」的唯一机读判据（SHA 变了说明不了多了几条），所以顺手数掉。
 * 用流而不是 `readFile`：收口回执里可能带着几 MB 的提交产物。
 */
async function describeFile(root, relativePath) {
  const absolute = join(root, ...relativePath.split('/'))
  const stats = await lstat(absolute)
  const hash = createHash('sha256')
  let bytes = 0
  let newlines = 0
  const countLines = relativePath.endsWith('.jsonl')
  for await (const chunk of createReadStream(absolute)) {
    hash.update(chunk)
    bytes += chunk.length
    if (countLines) {
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] === 0x0a) newlines += 1
      }
    }
  }
  const record = {
    path: relativePath,
    type: 'file',
    bytes,
    sha256: hash.digest('hex'),
    mtime: new Date(stats.mtimeMs).toISOString(),
  }
  if (countLines) record.lines = newlines
  return record
}

async function describeSymbolicLink(root, relativePath) {
  const absolute = join(root, ...relativePath.split('/'))
  const stats = await lstat(absolute)
  let target = null
  try {
    target = await readlink(absolute)
  } catch {
    target = null
  }
  return {
    path: relativePath,
    type: 'symlink',
    bytes: null,
    sha256: null,
    mtime: new Date(stats.mtimeMs).toISOString(),
    link_target: target,
  }
}

/** 递归（`tree`）或单层（`glob`）列出目标下所有条目；符号链接只记录不跟随。 */
async function walk(root, relativeDir, targetId, gaps, depth, state, recursive) {
  if (depth > MAX_DEPTH) {
    gaps.push({ target: targetId, path: relativeDir, reason: 'TRUNCATED', detail: `深度超过 ${MAX_DEPTH}` })
    return
  }
  let entries
  try {
    entries = await readdir(join(root, ...relativeDir.split('/')), { withFileTypes: true })
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    gaps.push({ target: targetId, path: relativeDir, reason: 'UNREADABLE', detail: code })
    return
  }
  entries.sort((a, b) => compareText(a.name, b.name))
  for (const entry of entries) {
    if (state.entries.length >= MAX_FILES_PER_TARGET) {
      gaps.push({
        target: targetId,
        path: relativeDir,
        reason: 'TRUNCATED',
        detail: `条目超过 ${MAX_FILES_PER_TARGET}`,
      })
      return
    }
    const childRelative = `${relativeDir}/${entry.name}`
    if (entry.isSymbolicLink()) {
      state.entries.push(await describeSymbolicLink(root, childRelative))
      continue
    }
    if (entry.isDirectory()) {
      if (!recursive) continue
      if (depth + 1 > MAX_DEPTH) {
        gaps.push({ target: targetId, path: childRelative, reason: 'TRUNCATED', detail: `深度超过 ${MAX_DEPTH}` })
        continue
      }
      await walk(root, childRelative, targetId, gaps, depth + 1, state, recursive)
      continue
    }
    if (!entry.isFile()) {
      state.entries.push({ path: childRelative, type: 'other', bytes: null, sha256: null, mtime: null })
      continue
    }
    try {
      state.entries.push(await describeFile(root, childRelative))
    } catch (error) {
      state.entries.push({ path: childRelative, type: 'file', bytes: null, sha256: null, mtime: null })
      gaps.push({ target: targetId, path: childRelative, reason: 'READ_FAILED', detail: errorCode(error) })
    }
  }
}

/** 收一个目标。永远不抛：任何读取失败都变成 `gaps` 里的一行。 */
async function collectTarget(root, target) {
  const summary = {
    id: target.id,
    label: target.label,
    kind: target.kind,
    path: target.path,
    expectation: target.expectation,
    status: 'present',
    files: 0,
    bytes: 0,
  }
  const entries = []
  const gaps = []
  const absolute = join(root, ...target.path.split('/'))

  if (target.kind === 'file') {
    let stats
    try {
      stats = await lstat(absolute)
    } catch (error) {
      const code = errorCode(error)
      summary.status = 'absent'
      gaps.push({
        target: target.id,
        path: target.path,
        reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'MISSING' : 'UNREADABLE',
        detail: code,
      })
      return { summary, entries, gaps }
    }
    if (stats.isDirectory()) {
      summary.status = 'absent'
      gaps.push({ target: target.id, path: target.path, reason: 'UNREADABLE', detail: 'EXPECTED_FILE_GOT_DIR' })
      return { summary, entries, gaps }
    }
    if (stats.isSymbolicLink()) {
      entries.push(await describeSymbolicLink(root, target.path))
    } else {
      try {
        entries.push(await describeFile(root, target.path))
      } catch (error) {
        entries.push({ path: target.path, type: 'file', bytes: null, sha256: null, mtime: null })
        gaps.push({ target: target.id, path: target.path, reason: 'READ_FAILED', detail: errorCode(error) })
      }
    }
    summary.files = entries.length
    summary.bytes = entries.reduce((total, entry) => total + (entry.bytes ?? 0), 0)
    return { summary, entries, gaps }
  }

  // glob / tree：目录缺失 = 显式缺口；目录存在但没有文件 = empty（也是证据）。
  let dirStats
  try {
    dirStats = await lstat(absolute)
  } catch (error) {
    const code = errorCode(error)
    summary.status = 'absent'
    gaps.push({
      target: target.id,
      path: target.path,
      reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'MISSING' : 'UNREADABLE',
      detail: code,
    })
    return { summary, entries, gaps }
  }
  if (!dirStats.isDirectory()) {
    summary.status = 'absent'
    gaps.push({ target: target.id, path: target.path, reason: 'UNREADABLE', detail: 'EXPECTED_DIR_GOT_FILE' })
    return { summary, entries, gaps }
  }

  const state = { entries }
  await walk(root, target.path, target.id, gaps, 0, state, target.kind === 'tree')
  if (state.entries.length === 0) summary.status = 'empty'
  summary.files = state.entries.length
  summary.bytes = state.entries.reduce((total, entry) => total + (entry.bytes ?? 0), 0)
  return { summary, entries, gaps }
}

/**
 * 证据摘要：只覆盖 (path, bytes, sha256)，**不含 mtime**。
 * 于是「两次 collect 摘要相同」= 内容没变，而 mtime 差异不影响这个判定。
 */
function evidenceDigest(files) {
  const canonical = files.map((file) => [file.path, file.bytes, file.sha256])
  return sha256Hex(Buffer.from(JSON.stringify(canonical), 'utf8'))
}

async function readProjectRoot(raw) {
  const absolute = resolve(raw)
  let canonical
  try {
    canonical = await realpath(absolute)
  } catch (error) {
    throw new UsageError(`项目根无法解析（${errorCode(error)}）：${raw}`)
  }
  let stats
  try {
    stats = await stat(canonical)
  } catch (error) {
    throw new UsageError(`项目根无法读取（${errorCode(error)}）：${canonical}`)
  }
  if (!stats.isDirectory()) throw new UsageError(`项目根不是目录：${canonical}`)
  return canonical
}

/**
 * 把输出路径折算成「真实路径」：找到最深的已存在祖先做 `realpath`，再把还不存在的尾段拼回去。
 *
 * 必须这么做的原因：Windows 上同一个目录可能同时以长名（`...\Administrator\...`）与 8.3 短名
 * （`...\ADMINI~1\...`）出现，纯字符串比较会把「项目内」误判成「项目外」——那样"只读项目"的
 * 守卫就等于没有。**不创建任何目录**，所以不会在项目里留下痕迹。
 */
async function canonicalizeTarget(absolute) {
  let current = absolute
  const tail = []
  for (;;) {
    try {
      const real = await realpath(current)
      return join(real, ...tail.reverse())
    } catch (error) {
      const code = errorCode(error)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return absolute
      const parent = dirname(current)
      if (parent === current) return absolute
      tail.push(basename(current))
      current = parent
    }
  }
}

async function prepareOutputPath(rawOutput, projectRoot) {
  const absolute = resolve(rawOutput)
  const canonical = await canonicalizeTarget(absolute)
  if (projectRoot !== null && isInside(canonical, projectRoot)) {
    throw new UsageError(
      `--out 不能落在 --project 之内：本脚本对项目只读（项目根 ${projectRoot}，输出 ${canonical}）`,
    )
  }
  await mkdir(dirname(absolute), { recursive: true })
  return absolute
}

async function writeJsonFile(absolute, value) {
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function commandCollect(options) {
  assertKnownOptions(options, ['project', 'out'])
  const projectRoot = await readProjectRoot(requireOption(options, 'project'))
  const outPath = await prepareOutputPath(requireOption(options, 'out'), projectRoot)

  const targets = []
  const files = []
  const gaps = []

  for (const target of TARGETS) {
    const collected = await collectTarget(projectRoot, target)
    targets.push(collected.summary)
    files.push(...collected.entries)
    gaps.push(...collected.gaps)
  }

  files.sort((a, b) => compareText(a.path, b.path))
  gaps.sort((a, b) => compareText(`${a.target}\u0000${a.path}\u0000${a.reason}`, `${b.target}\u0000${b.path}\u0000${b.reason}`))
  targets.sort((a, b) => compareText(a.id, b.id))

  const present = targets.filter((target) => target.status === 'present').length
  const empty = targets.filter((target) => target.status === 'empty').length
  const absent = targets.filter((target) => target.status === 'absent').length
  const requiredMissing = gaps.filter((gap) => {
    const target = TARGETS.find((candidate) => candidate.id === gap.target)
    return target?.expectation === 'required'
  }).length

  const evidence = {
    schema_version: SCHEMA_VERSION,
    kind: KIND_COLLECT,
    project: { root: projectRoot },
    digest: { algorithm: 'sha256', scope: 'files[path,bytes,sha256]', value: evidenceDigest(files) },
    targets,
    files,
    gaps,
    summary: {
      targets: targets.length,
      present,
      empty,
      absent,
      files: files.length,
      bytes: files.reduce((total, file) => total + (file.bytes ?? 0), 0),
      gaps: gaps.length,
      required_gaps: requiredMissing,
    },
  }

  await writeJsonFile(outPath, evidence)
  stdout.write(
    `collect：目标 ${targets.length}（present ${present} / empty ${empty} / absent ${absent}），` +
      `文件 ${files.length}，缺口 ${gaps.length}（其中 required ${requiredMissing}）\n` +
      `        证据摘要 ${evidence.digest.value.slice(0, 16)}… → ${outPath}\n`,
  )
  return 0
}

/* -------------------------------------------------------------------------- */
/* diff                                                                        */
/* -------------------------------------------------------------------------- */

async function readCollectFile(rawPath) {
  const absolute = resolve(rawPath)
  let text
  try {
    text = await readFile(absolute, 'utf8')
  } catch (error) {
    throw new UsageError(`读不到 collect 文件（${errorCode(error)}）：${absolute}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new UsageError(`不是合法 JSON：${absolute}（${error.message}）`)
  }
  if (!parsed || typeof parsed !== 'object' || parsed.kind !== KIND_COLLECT) {
    throw new UsageError(`不是本脚本 collect 的产物（kind 应为 ${KIND_COLLECT}）：${absolute}`)
  }
  if (parsed.schema_version !== SCHEMA_VERSION) {
    throw new UsageError(
      `collect 格式版本不一致（文件 ${String(parsed.schema_version)}，脚本 ${SCHEMA_VERSION}）：请用同一版本重新 collect`,
    )
  }
  if (!Array.isArray(parsed.files)) throw new UsageError(`collect 文件缺 files 数组：${absolute}`)
  return { path: absolute, evidence: parsed }
}

function indexFiles(files) {
  const map = new Map()
  for (const file of files) {
    if (!file || typeof file.path !== 'string') continue
    map.set(file.path, file)
  }
  return map
}

function describeSide(side) {
  const summary = side.evidence.summary ?? {}
  return {
    file: side.path,
    root: side.evidence.project?.root ?? null,
    digest: side.evidence.digest?.value ?? null,
    files: Array.isArray(side.evidence.files) ? side.evidence.files.length : 0,
    bytes: typeof summary.bytes === 'number' ? summary.bytes : null,
    required_gaps: typeof summary.required_gaps === 'number' ? summary.required_gaps : null,
  }
}

async function commandDiff(options) {
  assertKnownOptions(options, ['before', 'after', 'out'])
  const before = await readCollectFile(requireOption(options, 'before'))
  const after = await readCollectFile(requireOption(options, 'after'))

  const beforeFiles = indexFiles(before.evidence.files)
  const afterFiles = indexFiles(after.evidence.files)

  const added = []
  const removed = []
  const changed = []

  for (const [path, file] of afterFiles) {
    const previous = beforeFiles.get(path)
    if (previous === undefined) {
      added.push({ path, bytes: file.bytes, sha256: file.sha256, mtime: file.mtime, lines: file.lines ?? null })
      continue
    }
    const contentChanged = previous.sha256 !== file.sha256 || previous.bytes !== file.bytes
    const mtimeChanged = previous.mtime !== file.mtime
    if (!contentChanged && !mtimeChanged) continue
    changed.push({
      path,
      content_changed: contentChanged,
      bytes: [previous.bytes, file.bytes],
      sha256: [previous.sha256, file.sha256],
      mtime: [previous.mtime, file.mtime],
      lines: [previous.lines ?? null, file.lines ?? null],
    })
  }
  for (const [path, file] of beforeFiles) {
    if (afterFiles.has(path)) continue
    removed.push({ path, bytes: file.bytes, sha256: file.sha256, mtime: file.mtime, lines: file.lines ?? null })
  }

  const gapKey = (gap) => `${gap.target}\u0000${gap.path}\u0000${gap.reason}`
  const beforeGaps = new Map((before.evidence.gaps ?? []).map((gap) => [gapKey(gap), gap]))
  const afterGaps = new Map((after.evidence.gaps ?? []).map((gap) => [gapKey(gap), gap]))
  const gapsAdded = [...afterGaps.keys()].filter((key) => !beforeGaps.has(key)).sort(compareText).map((key) => afterGaps.get(key))
  const gapsRemoved = [...beforeGaps.keys()].filter((key) => !afterGaps.has(key)).sort(compareText).map((key) => beforeGaps.get(key))

  added.sort((a, b) => compareText(a.path, b.path))
  removed.sort((a, b) => compareText(a.path, b.path))
  changed.sort((a, b) => compareText(a.path, b.path))

  const result = {
    schema_version: SCHEMA_VERSION,
    kind: KIND_DIFF,
    before: describeSide(before),
    after: describeSide(after),
    added,
    removed,
    changed,
    unchanged: afterFiles.size - added.length - changed.length,
    gaps: { added: gapsAdded, removed: gapsRemoved },
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      changed_content: changed.filter((entry) => entry.content_changed).length,
      changed_mtime_only: changed.filter((entry) => !entry.content_changed).length,
      unchanged: afterFiles.size - added.length - changed.length,
    },
  }

  if (typeof options.out === 'string') {
    const outPath = await prepareOutputPath(options.out, null)
    await writeJsonFile(outPath, result)
    stdout.write(
      `diff：新增 ${result.summary.added} / 变更 ${result.summary.changed}` +
        `（内容 ${result.summary.changed_content}，仅 mtime ${result.summary.changed_mtime_only}）/ ` +
        `删除 ${result.summary.removed} → ${outPath}\n`,
    )
    return 0
  }

  stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}

/* -------------------------------------------------------------------------- */
/* checklist                                                                   */
/* -------------------------------------------------------------------------- */

/** 断言标记：判据能不能直接读到，决定这条能不能算「通过」。 */
const TAGS = {
  direct: '〔可观察〕',
  construct: '〔需构造〕',
  unobservable: '〔不可观察〕',
}

/**
 * 七步验收内容。
 *
 * 这里就是清单的唯一真相：`docs/verify/l3-checklist.md` 由本脚本生成并提交，
 * 别手改生成物（要改断言就改这里，然后重新生成 + 提交）。
 *
 * 每条断言的 tag 是**诚实性**的一部分：
 * - direct    —— 人在本会话就能从工具原始返回或 collect 的 JSON 里读到；
 * - construct —— 必须先构造一个额外条件（改坏一个字段、开第二个会话、故意等超时）；
 * - unobservable —— 现有工具面产不出该判据，只能记 not-run 并写清为什么。
 */
const STEPS = [
  {
    n: 1,
    title: '安装、一次性会话、两个工具的参数面与 Lead 遮罩（含同名工具归属与 doctor）',
    goal:
      '证明「红队指挥」preset 真的挂上了团队服务、两个 rt 工具与团队工具都可用，**Lead 遮罩**真的挡住了 Lead 自执行，' +
      '并且**同名工具确实是团队版**；另证明在没有团队服务的环境里 `bin/doctor.mjs` 仍然可达。',
    a: ['A01', 'A02'],
    setup: [
      '按 `docs/verify/README.md` 的「前置」装好 bundle（`link:` 进 profile + 写进 `dsh.profile.bundles`，顺序在团队 profile 之后），重启 DSH。',
      '新建**一次性**会话，模式选「红队指挥」（preset id `redteam-lead`）。已有会话保留它启动时的 preset，**必须新开**。',
      '在普通 shell（不是会话内）跑一次 `node <仓库根>/packages/dsh-redteam-lead/bin/doctor.mjs --profile %USERPROFILE%\\.dsh\\profiles\\desktop --project <临时项目根>`，记下完整 JSON 与退出码。',
      '在会话里先跑 `collect --project <临时项目根> --out <证据目录>\\s1-before.json`。',
      '角色闸探针：在会话里依次调 `pwsh({command:"echo hi"})`、`read`、`grep`、`rt_hash`，把四条原始返回都贴回来（被拒的那条要原样保留拒绝文本）。',
      '确认 `rt_roster` / `rt_dispatch` 已经**不存在**：直接点名调一次，期望"未知工具"而不是参数错误。',
    ],
    observe: [
      '会话里直接问：`list_agents` 的原始返回（`members[]` 的 `name`/`role`/`status`），Lead 伪行必须在第一行且 `role=lead`。',
      '工具参数面：故意少传一个必填字段（`rt_conclude` 只传 `project_root`、`rt_hash` 只传 `project_root`）→ 判据是 `INVALID_ARGUMENT` 的具体报错文本，而不是"工具存在"。再传一个已删除的字段（`rt_conclude` 带 `dispatch_id`/`attempt_id`/`task_id`/`expected_revision`）→ 期望同样是 `INVALID_ARGUMENT`（未知字段）。',
      '角色闸：被拒工具的原始返回（宿主把闸的 `reason` 原样交给模型；错误码由宿主决定，记原文即可），以及 `read`/`grep`/`rt_hash` 的成功返回作对照。',
      '同名归属：用**不存在的成员名**做探针，保证零投递（见下面的断言）。',
      'doctor：看 `status`/`code`/`diagnostics[]`/`data.configuration_ready`/`data.runtime_ready`/`data.profile.bundle_listed`/`bundle_linked` 与退出码。',
    ],
    asserts: [
      { tag: 'direct', text: '`list_agents` 返回团队名册（含 Lead 伪行 `role=lead`、`name=lead`），说明 `ctx.agentTeams` 真的在，不是替身。' },
      { tag: 'direct', text: '**只有两个 rt 工具**：`rt_conclude` 必填 `project_root/route_id/operation_id/conclusion/anchors/review`（没有 `dispatch_id`/`attempt_id`/`task_id`/`expected_revision`，传了按未知字段拒）；`rt_hash` 必填 `project_root/path`。少传必填字段得到 `INVALID_ARGUMENT`。' },
      { tag: 'direct', text: '`rt_roster` / `rt_dispatch` 调用返回"未知工具"（LDW-13 删除），不是 `INVALID_ARGUMENT` —— 后者会说明工具还在、只是参数不对。' },
      { tag: 'direct', text: '**Lead 遮罩**：Lead（会话根、preset=redteam-lead）调 `pwsh`/`bash`/`subagent`/`subagent_fork`/`workflow` 各一次 → 全部 `deny`，理由里出现「派给工兵」并点名 `read`/`grep`/`rt_hash`/`job_*`；同一会话的 `read`/`grep`/`rt_hash` 正常执行。若能在 `request/header.tools`（或工具目录视图）里读到本 agent 的工具名，**不应**含那五个（LDW-8 遮罩生效）；不含也仍以 deny 为准（遮罩是体验，拒绝是保证）。' },
      { tag: 'direct', text: '诊断只有一条：同一次会话里遮罩对同一个 agent 只记一条日志（「本应遮 N 个、实际遮 M 个」），不随每次工具调用刷屏；M<N 时同一行里点名这个 scope 没有的名字。' },
      { tag: 'direct', text: '团队工具按**成员身份**注册（不是按 preset）：Lead 调 `team_task_list` 能拿到 `tasks[]`（空数组也算可用），`team_task_get`/`team_task_create`/`team_task_update`/`spawn_teammate`/`wait_agent` 在工具表里可见。' },
      { tag: 'direct', text: '同名工具归属（**不能只看名字**）：`send_message({target:"nobody-xyz",message:"probe"})` → 期望 `TEAM_MEMBER_NOT_FOUND`（参数名是团队版的 `target`，且零投递）；`send_message({agent_id:"nobody-xyz",message:"probe"})` → 期望参数校验失败（`agent_id` 不是本工具字段）。' },
      { tag: 'direct', text: '`interrupt_agent({target:"nobody-xyz"})` → 期望 `TEAM_MEMBER_NOT_FOUND`；`interrupt_agent({agent_id:"nobody-xyz"})` → 期望参数校验失败。两条合起来才证明挂载的是团队版而非 `tool-subagent-control` 版。' },
      { tag: 'direct', text: 'A01：`bin/doctor.mjs` 在**没有团队服务**的普通 shell 里可达：输出同一信封形状，`data.runtime_ready` 恒为字符串 `"unknown"`（不得是 `true`），`data.configuration_ready` 只反映离线配置，退出码 0（无硬阻塞）或 1（有硬阻塞）。' },
      { tag: 'direct', text: 'A01：doctor 的诊断带 `next_step`，且当本 bundle 未安装/未列进 `dsh.profile.bundles` 时，`[profile.bundle-listed]`/`[profile.bundle-declared]`/`[profile.bundle-linked]` 三条各给一条具体修复路径。' },
    ],
    codes: [
      ['少传必填字段（任一个 rt 工具）', '`INVALID_ARGUMENT`', '参数面证据'],
      ['传已删除的 dispatch_id/attempt_id/task_id/expected_revision', '`INVALID_ARGUMENT`（未知字段）', '路线级收口'],
      ['调已删除的 rt_roster / rt_dispatch', '未知工具（宿主错误）', '不是 `INVALID_ARGUMENT`'],
      ['`send_message` / `interrupt_agent` 指向不存在的成员', '`TEAM_MEMBER_NOT_FOUND`', '团队版参数名与零投递'],
      ['`send_message` 传 `agent_id`', '参数校验失败（无 `code`）', '证明不是 subagent-control 版'],
      ['在无团队服务的会话里调 rt_conclude', '`TEAM_SERVICE_UNAVAILABLE`', '诊断必须指向 doctor'],
    ],
    evidence: [
      '`list_agents` 原始返回（整段 JSON）。',
      '两个工具的参数面探针（少传必填 / 传已删除字段 / 点名已删工具）的原始返回与报错文本。',
      '两个团队工具探针（两个 `send_message`、两个 `interrupt_agent`）的原始返回与报错文本。',
      '`bin/doctor.mjs` 的完整 stdout + 退出码（`$LASTEXITCODE`）。',
      '`s1-before.json`（`collect` 产物）与它的 SHA-256。',
    ],
    gaps: [
      '「同名工具」在本 preset 下的另一半（`tool-subagent-control` 的 `send_message/list_agents/interrupt_agent`）**已被 patch 行删除**，所以会话里不存在两个活着的同名工具可供对比。能观察的只有「留下的这个的参数面/行为属于团队版」+「被删的那行确实不在 patch 里」。这是本步的如实边界，不是失败。',
      '`list_agents` 的确切字段名以实际返回为准；若与 `name/role/status` 不同，照抄原始输出，不要按预期改写。',
    ],
  },
  {
    n: 2,
    title: '原生建人与派活：工兵的独立人设与裁剪后的工具面',
    goal:
      '证明「建人/派活」真的回到了宿主原生工具（Lead 手写开场简报），并且工兵拿到的是**它自己的**人设与裁剪过的工具面 —— ' +
      '这一层没有任何本包的工具参与，本包只在 `agent/created` 上盖人设、裁工具。',
    a: ['S1', 'S2', 'S4'],
    setup: [
      '`collect --out <证据目录>\\s2-before.json`。',
      'Lead 调 `spawn_teammate` 建一个工兵（名字建议 `rt-<route>`）：开场简报**手写**，写清路线 id、目标、必需锚点、草稿区 `re/team/work/<route-id>/`、五段式回报格式、以及「你没有建人权，缺人报回来」。',
      '`team_task_create`（`subject` 放摘要、`description` 放要点）→ `team_task_update action=reassign` 指派给该工兵 → `send_message` 把简报要点再发一次。',
      '立刻 `collect --out <证据目录>\\s2-after.json`，`diff` 出变化。',
      '让该工兵把它**自己的**工具名清单与系统提示词里的身份段（工兵那份人设的开头两行）贴回来。',
    ],
    observe: [
      '`spawn_teammate` 的原始返回（成员 `id`/`name`/`role`/`status`），以及 `list_agents` 里新增的那一行。',
      '`team_task_list` 里该任务的 `task_id`/`status`/`ownerName`。',
      '工兵回传的工具名清单：应当**没有** `spawn_teammate`/`subagent`/`subagent_fork`/`workflow`，应当**有** `send_message`/`team_task_*`/`list_agents`/`rt_hash`/`pwsh`。',
      '工兵回传的人设开头：应当出现「工兵」一类身份词，且**不含**「指挥」。',
      '`diff`：建人与派活只应当改变宿主侧状态（成员/任务），**不应当**在 `re/team/` 下多出任何文件（本包不参与这一步）。',
    ],
    asserts: [
      { tag: 'direct', text: 'S1：建人走的是宿主 `spawn_teammate`，`list_agents` 新行 `role=teammate`、`status` 合理；本包的 `re/team/` 下没有新增任何文件（`diff` 里 `re/team/**` 无 added）。' },
      { tag: 'direct', text: 'S1：任务能用 `team_task_create` + `team_task_update action=reassign` 走到 `in_progress` 且 `ownerName` 就是该成员 —— 这条链上没有任何 `rt_*` 调用。' },
      { tag: 'direct', text: 'S2：工兵的工具表里**缺** `spawn_teammate`/`subagent`/`subagent_fork`/`workflow`（LDW-15 遮罩），且 `send_message`/`team_task_*`/`list_agents`/`rt_hash`/`pwsh` 仍在。若能在 `request/header.tools` 读到它的工具名，以那里为准；读不到就以它自己的实际调用结果为准。' },
      { tag: 'direct', text: 'S4：工兵的系统提示词与 Lead 那份**不同**（人设文本来自 `teammatePersona`），且工兵那份**不含**「指挥」字样；Lead 那份仍含它自己的准则段。两份都不得把 runtime context 吃掉（组装结果里仍有 `cwd` 一类 required context）。' },
      { tag: 'direct', text: '工兵回传「我没有建人权」这句时，它是**从简报里读到**的，不是从工具面推断的 —— 记录里要贴简报原文，证明 Lead 手写了它。' },
      { tag: 'construct', text: 'S2：遮罩只遮交集 —— 若该 scope 的可遮名单取不到或与 deny 表交集为空，日志里应出现「本应遮 N 个、实际遮 M 个（M<N）」，而**不是**整表被拒。构造方式：在工兵建好后重装一次插件（HMR/重载），看 `agent/created` 是否重放一次且不重复报错。' },
    ],
    codes: [
      ['建人时名字违规（大写/含空格/叫 lead/超长）', '宿主 `TEAM_INVALID_MEMBER_NAME` 一类错误', '本包不介入'],
      ['工兵调 `spawn_teammate`', '服务层拒绝（`TEAM_LEAD_REQUIRED`）', '遮罩是体验，服务层是保证'],
      ['工兵调 `subagent`/`subagent_fork`', 'depth 拒绝（宿主错误，非本包码）', '不得记成本包拒绝'],
    ],
    evidence: [
      '`spawn_teammate` 与 `team_task_*` 的原始返回；`list_agents` / `team_task_list` 前后快照。',
      '工兵回传的工具名清单原文（不是复述）。',
      '工兵回传的人设开头两行 + Lead 自己的人设开头两行（并排对比）。',
      '`s2-before.json` / `s2-after.json` / `diff`（证明 `re/team/` 没被写）。',
    ],
    gaps: [
      '系统提示词的「组装结果」在会话里读不到全文：只能让两边各自贴身份段开头，或由 Lead 用宿主日志核对。本包侧的回归由 `test/bundle.test.mjs` 的 runtime-context 用例钉住，不能拿它冒充 L3 证据。',
      '「工兵看不到那四个名字」也可能因为宿主版本不提供 `restrict` 而退化成 deny-only；这种情况下要用**实际调用**（被拒）当证据，并在记录里写明退化原因。',
    ],
  },
  {
    n: 3,
    title: '真实 teammate 越权被拒 + 下一层创建受限',
    goal:
      '用**真实成员身份**证明：teammate 调 `rt_conclude` 被身份拒绝且零副作用；' +
      '同时用真实 teammate 观察下一层创建受限，并把「裸子代理被拒」与「工具不存在」区分开。',
    a: ['A03', 'A08'],
    setup: [
      '在会话里给该成员派一个**只读探针任务**（或用 `send_message` 让它执行下列探针），要求它把原始返回贴回来。',
      '让 teammate 依次调用：`rt_conclude`（用真实的 `route_id`/`operation_id`）、`subagent({prompt:"probe"})`、`workflow`（**不要真跑**，见 gaps）。',
      '`collect --out s3-before.json`（在 teammate 探针之前）与 `s3-after.json`（之后），`diff` 必须为空。',
      '**裸子代理那一路在本 preset 下已经不可由 Lead 发起**（LDW-1 角色闸挡住 `subagent`）：改为把 Lead 调 `subagent` 的**拒绝原文**贴回来，作为「闸生效」的证据；A08 的「工具不存在 vs 身份拒绝」只能记 not-run。',
    ],
    observe: [
      'teammate 的原始工具返回：`status`/`code`/`reason`（`reason` 里应点出当前角色是 `teammate`）。',
      '`diff` 是否为空——这是"无副作用"的唯一机读判据。',
      'Lead 调 `subagent` 的拒绝原文（角色闸的 `reason`：派给工兵 + 可用工具清单）。',
      '**记 not-run**：裸子代理的错误形状（`TEAM_SERVICE_UNAVAILABLE` vs 工具不存在）在本 preset 里造不出来。',
    ],
    asserts: [
      { tag: 'direct', text: 'A03：teammate 调 `rt_conclude` → `code=ROLE_REQUIRED`（身份来自 `ctx.exec.agent` + 团队服务，不接受入参自报），`reason` 点名 `teammate`；`diff` 为零 → 无回执、无审计、无台账新增。' },
      { tag: 'direct', text: 'A03：`rt_hash` 对真实成员是**允许**的（只读、不做角色判定）：给它一个项目内相对路径，返回 `kind=file` 或 `kind=dir`，不返回 `ROLE_REQUIRED`。' },
      { tag: 'direct', text: '下一层创建受限（真实 teammate）：`subagent` 与 `subagent_fork` 都被 depth 策略挡住（错误文本提到 depth/maxDepth），且**没有**真的建出孙代（`list_agents` 的成员数不变）。' },
      { tag: 'direct', text: 'Lead 侧对照：同样这两个工具对 Lead 是「角色闸拒绝」而不是 depth 拒绝——两种拒绝理由必须分开记，不能混成一条。' },
      { tag: 'unobservable', text: 'A08：把「裸子代理看不到团队工具」与「看得见但被身份拒绝」分开记——本 preset 下 Lead 已经开不出裸子代理（闸拒绝），所以这一条只能记 not-run 并写明原因；**不要**用 Lead 的闸拒绝冒充「裸子代理拿不到团队工具」。' },
      { tag: 'unobservable', text: '`workflow` 不受 depth 限制（D5）：它传 `parent` 但从不传 `maxDepth`。**不要**为了验收真跑 `workflow`——那会真的开出孙代并烧掉 activation 名额。这一条只能按 D5 的静态结论与代码引用记录，标记为已知限制（工兵侧另有遮罩，见第 2 步）。' },
    ],
    codes: [
      ['teammate 调 `rt_conclude`', '`ROLE_REQUIRED`', '零副作用'],
      ['teammate 调 `rt_hash`', '正常返回（不做角色判定）', '只读核对手段对工兵开放'],
      ['teammate 调 `subagent`/`subagent_fork`', 'depth 拒绝（宿主错误，非本包码）', '不得记成本包拒绝'],
      ['Lead 调 `subagent`/`subagent_fork`/`workflow`', '角色闸拒绝（本包 `gate.ts`）', '与 depth 拒绝分开记'],
      ['裸子代理调 `rt_conclude`', 'not-run（本 preset 下 Lead 开不出裸子代理）', '不要用闸拒绝冒充'],
    ],
    evidence: [
      'teammate 回传的**原始**工具返回（不要复述，要原文）。',
      '`s3-before.json` / `s3-after.json` / `diff`（空的 diff 也要贴）。',
      'Lead 调 `subagent` 的拒绝原文。',
      '`list_agents` 在探针前后的输出（证明没有孙代、没有新成员）。',
    ],
    gaps: [
      '`workflow` 的逃逸口**不可安全观察**：真要验证就得让它开出孙代。按要求只记录 D5 + 代码位置，列为已知限制。',
      '「下一层创建受限」只在 `subagent`/`subagent_fork` 路径上成立；把它写成"平台挡住一切下一层创建"是错的（D5 已更正）。',
    ],
  },
  {
    n: 4,
    title: '`rt_hash`：核对交付字节（只读、可复算）',
    goal:
      '证明闸封死 shell 之后，Lead 真的能用 `rt_hash` 核对工兵回报里点名的字节：单文件摘要、目录清单摘要、截断与路径围栏都可观察。',
    a: [],
    setup: [
      '让工兵在草稿区写一个文件（`re/team/work/<route-id>/note.md`）与一个子目录（两三个文件）。',
      'Lead 调 `rt_hash`：单文件一次（`path` 指到那个文件），目录一次（`path` 指到草稿区）。',
      '再调一次同样的目录 `rt_hash`，比对两次 `sha256` 是否相同（确定性）。',
      '构造越界：传绝对路径、`..`、以及一条穿过 junction 的路径各一次。',
    ],
    observe: [
      '单文件的 `data`：`kind=file` + `path`/`bytes`/`sha256`。',
      '目录的 `data`：`kind=dir` + `sha256`/`file_count`/`truncated`/`files[]`（按 path 排序、相对被哈希目录）。',
      '两次目录摘要相同；用系统 `Get-FileHash` 对同一个文件算一次，和 `rt_hash` 的 `sha256` 对上（外部独立来源）。',
      '越界三种的原始报错文本。',
    ],
    asserts: [
      { tag: 'direct', text: '单文件：`kind=file`，`bytes` 等于文件实际字节数，`sha256` 与外部工具（`Get-FileHash` / `sha256sum`）算出的值**逐字相同** —— 这是唯一不依赖本包的交叉验证。' },
      { tag: 'direct', text: '目录：`kind=dir`，`files[]` 的 `path` 相对被哈希目录且按字典序，`file_count` 等于 `files.length`；同一棵树连调两次 `sha256` 相同。' },
      { tag: 'direct', text: '越界与链接：绝对路径、含 `..` 的路径、穿过 symlink/junction 的路径都被 `PATH_INVALID` 拒；拒绝理由点明是路径问题，不是"文件不存在"。' },
      { tag: 'construct', text: '截断：在草稿区放 >1000 个文件（或超过 32 层），期望 `truncated=true` 且 `sha256` 只覆盖已列出的条目；记录里要写明构造方式，否则不算。' },
      { tag: 'direct', text: '`rt_hash` 不写任何东西：调用前后 `collect` 的 `digest` 相同（它没有 `operation_id`、不落台账）。' },
    ],
    codes: [
      ['绝对路径 / `..` / 盘符 / 反斜杠', '`PATH_INVALID`', '路径围栏'],
      ['穿过 symlink/junction', '`PATH_INVALID`', '不跟随链接'],
      ['缺 `path`', '`INVALID_ARGUMENT`', '参数面'],
    ],
    evidence: [
      '两次 `rt_hash` 的原始返回（单文件 + 目录）。',
      '外部工具算出的同一文件 sha256（`Get-FileHash` 输出）。',
      '越界三次的原始报错。',
      '调用前后的 `collect` 与它们的 `digest`。',
    ],
    gaps: [
      '超过 1000 条/32 层的截断需要真实构造，正常项目里可能永远不触发；不构造就记 not-run。',
    ],
  },
  {
    n: 5,
    title: '`rt_conclude` 主路径：路线级收口、真实归档/封存/校验、审计 +1',
    goal:
      '证明收口是**按路线**（不是按派发尝试）真的经项目 skill 归档、封存、跑检查后才写回执；并且草稿区、锚点闭集、promote 与审计都可观察。',
    a: ['A17', 'A19', 'A27'],
    setup: [
      '成员按**五段式 Markdown** 回报（结论 / 锚点 / 未解 / 草稿路径 / 下一步），过程证据写进**路线草稿区** `re/team/work/<route-id>/`。**不要求**任何提交文件；草稿区可以空。',
      '先用 `rt_hash` 核对成员回报里点名的字节（单文件或目录），把摘要贴回来——这是「凭据」的一半。',
      '`collect --out s5-before.json`。',
      '调 `rt_conclude`：`project_root` + `route_id` + `operation_id`（新值）+ `conclusion`（Leader 自己的结论正文）+ `anchors`（锚点集合）+ `review`（八字段）；按需给 `draft_paths`、`state_recovery_ref`、`promote:[{from,to}]`。**不要传** `dispatch_id`/`attempt_id`/`task_id`/`expected_revision`。',
      '`collect --out s5-after.json`，`diff`。',
    ],
    observe: [
      '`rt_conclude` 返回 `status=ok`，`data` 含 `route_id`/`phase="completed"`/`outcome`/`route_status`/`receipt_ref`/`draft_manifest`/`checks[]`/`audit_written`。',
      '`diff`：`re/team/receipts/<route>-<operation>/` 新增 `receipt.json` 与 `mapping.json`、`re/team/audit.jsonl` 的 `lines` 增加、`re/routes/<R>.json` 的状态更新；给了 `promote` 时 `re/runs/**` 出现对应文件。',
      '`mapping.json` 的 `conclusion` 与入参正文、`anchors.total` 与入参条数、`draft_manifest.sha256` 与 `rt_hash` 的目录摘要。',
    ],
    asserts: [
      { tag: 'direct', text: 'A17：`rt_conclude` 成功后 `data.receipt_ref` 指向 `re/team/receipts/<route>-<operation>/receipt.json` 下真实存在的文件；`mapping.json` 里的 `conclusion` 与入参正文逐字一致，`anchors.total` 等于入参 `anchors` 的条数。**不需要任何 submission 文件、不需要 dispatch/attempt 身份**。' },
      { tag: 'direct', text: 'A17：锚点闭集真的在跑 —— 路线记录里的 `anchors_required`/`evidence_required` 是唯一门槛：给的锚点类型齐全才通过；把某条锚点的 `path` 改成不在该 RUN `artifacts` 里的路径会被拒（见第 6 步的构造）。' },
      { tag: 'direct', text: '真实 skill 归档：`mapping.json` 的 `artifacts[]` 每项有 `path`/`sha256`/`origin`，且 `origin=pre-existing` 的项能在 `collect` 里找到该路径、字节哈希一致——不是"复制了个名字"。' },
      { tag: 'direct', text: '(LDW-10) 提升：给了 `promote` 时，`to` 指向的文件在 `collect` 里出现且 SHA-256 与 `from` 的草稿字节相同；`mapping.json` 里对应项的 `origin=promoted`。没给 `promote` 时草稿区的文件**不会**出现在 `re/runs/**`。' },
      { tag: 'direct', text: '草稿清单：`data.draft_manifest` 有 `dir`（`re/team/work/<route-id>`）/`sha256`/`file_count`；同一棵树重算得到同一摘要；草稿区为空时它是空清单摘要而不是 `null`。' },
      { tag: 'direct', text: 'A19：真实 skill 封存：若 `review.evidence_run_ids` 非空，`re/seals/runs/<RUN>.json` 出现（`collect` 的 `seals` 目标新增文件），receipt 的 `seals[]` 给出 `action`（如 `created`/`alreadySealed`）与 `path`；已有封存不被重写（第二次收口只复用）。' },
      { tag: 'direct', text: '真实 skill 校验：receipt 的 `checks[]` 每项有 `name`/`output_ref`/`exit_code`，成功路径全部 `exit_code === 0`；路线记录 `status` == `data.route_status`。' },
      { tag: 'direct', text: 'A27：审计多一条：`diff` 里 `re/team/audit.jsonl` 出现在 `changed` 且 `content_changed=true`、`lines` 递增；`data.audit_written === true`。审计写失败时仍是 `ok` + `audit_written=false` + `AUDIT_WRITE_FAILED` 诊断（构造方式：收口期间把 `audit.jsonl` 设成只读）。' },
      { tag: 'construct', text: '收口写不成回执 → `partial`：把 `re/team/receipts/` 设成只读后再收口，期望 `status=partial` + `RECOVERY_REQUIRED`，且 `preliminary.json` 已落盘（检查通过的事实仍可读）。**不得**报 ok。' },
    ],
    codes: [
      ['锚点不合规（不在该 RUN 的 artifacts 里 / 缺该类锚点）', '`SUBMISSION_INVALID`', '路线记录是唯一门槛来源'],
      ['promote 越界 / 目标冲突 / 源缺失', '`INVALID_ARGUMENT`（写盘前拒绝）', '一个字节都不写'],
      ['skill 检查失败', '`CHECK_FAILED`', '不降门槛、不改序'],
      ['回执写不成', '`partial` + `RECOVERY_REQUIRED`', '业务已成功但不得报 ok'],
      ['审计写失败', '仍 `ok` + `audit_written=false`', '诊断 `AUDIT_WRITE_FAILED`'],
    ],
    evidence: [
      '`rt_conclude` 的完整成功返回（含 `draft_manifest` 与 `checks[]`）。',
      '`re/team/receipts/<route>-<operation>/` 下 `receipt.json` 与 `mapping.json` 的全文。',
      '`rt_hash` 的返回（成员回报点名的字节）+ 提升后 `re/runs/**` 对应文件的哈希。',
      '`s5-before.json` / `s5-after.json` / `diff`（审计 `lines` 与 `routes` 的变化就在里面）。',
    ],
    gaps: [
      '`checks[]` 的具体 `name` 由项目 skill 决定，本地不同副本可能不同；判据是"每项都有退出码且成功路径全 0"，不是固定名字列表。',
      '「成员真的先写草稿再收口」只能证明"产物存在且哈希对得上"，不能证明模型内部时序；这是可观察性的上限。',
    ],
  },
  {
    n: 6,
    title: '`rt_conclude` 的拒绝路径：越界、锚点不合规、重放与冲突',
    goal:
      '证明收口的每一条拒绝都在**写盘之前**发生，并且同一个 `operation_id` 能重放、换内容能冲突。',
    a: ['A17', 'A32'],
    setup: [
      '`collect --out s6-before.json`。',
      '构造越界：把 `promote.to` 指到 `re/runs` 之外（或指到一个已存在且内容不同的文件），用**新的** `operation_id` 重投。',
      '构造锚点不合规：把 `anchors` 里某项的 `path` 改成不在该 RUN `artifacts` 里的路径，再投一次（新的 `operation_id`）。',
      '重放：把第 5 步那次成功的调用**逐字重发**（同 `operation_id`、同输入）。',
      '冲突：同 `operation_id`、改一个字段（例如 `conclusion` 加一句）再发。',
      '`collect --out s6-after.json`，`diff` 必须为空（四次都不该写正式字节）。',
    ],
    observe: [
      '四次的 `status`/`code`/`diagnostics[]`，以及 `replayed` 是否为 true。',
      '`diff`：`re/runs/**`、`re/routes/**`、`re/team/receipts/**` 都没有新增/变更（台账 `re/team/operations/**` 可能有，那是幂等簿记，不算正式字节）。',
    ],
    asserts: [
      { tag: 'direct', text: 'A17：`promote.to` 越出 `re/runs`（或目标已存在且内容不同）→ `code=INVALID_ARGUMENT` 且**在写任何字节之前**失败：`re/runs` 无新增、路线未被改写、无成功回执。' },
      { tag: 'direct', text: 'A17：锚点 `path` 不在该 RUN `artifacts` 里 → 闭集校验拒绝（`SUBMISSION_INVALID`），且拒绝理由点名是哪一条锚点、缺什么。' },
      { tag: 'direct', text: 'A32：同 `operation_id` 逐字重发 → `replayed=true`，返回**原回执**（`receipt_ref` 不变、`checks[]` 不变），不重复归档、不重复封存、不重复写审计。' },
      { tag: 'direct', text: 'A32：同 `operation_id` 改输入 → `OPERATION_CONFLICT`（`status=blocked`），台账不被覆盖，`data.phase` 只取 `preflight|prepared|integrating|facts_committed|needs_recovery` 之一（LDW-17 收窄）。' },
      { tag: 'direct', text: '路线状态不可收口（例如已 `validated`/`falsified`）→ `PROJECT_NOT_CONFIGURED` 或 `RECOVERY_REQUIRED`，且零副作用。' },
    ],
    codes: [
      ['promote 越界 / 目标冲突', '`INVALID_ARGUMENT`', '写盘前拒绝'],
      ['锚点不合规', '`SUBMISSION_INVALID`', '点名锚点'],
      ['同 operation_id 改内容', '`OPERATION_CONFLICT`', '不覆盖台账'],
      ['路线状态不可收口', '`PROJECT_NOT_CONFIGURED` / `RECOVERY_REQUIRED`', '零副作用'],
    ],
    evidence: [
      '四次拒绝/重放的完整返回。',
      '`s6-before.json` / `s6-after.json` / `diff`（证明没写正式字节）。',
    ],
    gaps: [
      '`re/team/operations/**` 会在重放/冲突路径上变化，这是幂等簿记而不是正式记录；记录里要写清这个区分，否则 diff 不为空会被误判成失败。',
    ],
  },
  {
    n: 7,
    title: '`interrupt_agent` 与带 nonce 的唤醒',
    goal:
      '证明中断只改状态、不释放席位与任务；再用带 nonce 的 `send_message` 唤醒，并证明成员真的收到（回报里出现 nonce）。',
    a: ['A34'],
    setup: [
      '在任务开始后（成员 `status=running`）调 `interrupt_agent({target:"<成员名>"})`。',
      '立刻 `list_agents` + `team_task_list`，`collect --out s7-before.json`。',
      '生成一个 32 位十六进制 nonce，`send_message({target:"<成员名>", message:"唤醒探针 nonce=<nonce>；请原样回报该 nonce 与当前任务 id"})`。',
      '等成员回复（`wait_agent` 或直接读它发来的团队消息），记下回报原文。',
    ],
    observe: [
      '`interrupt_agent` 返回 `{previousStatus}`，取值只能是 `running` 或 `inactive`（枚举外的值即失败）。',
      '`list_agents` 里该成员仍在名册（`status` 变 `inactive`），`role=teammate` 行数不变。',
      '成员回报里出现 nonce 原文；`team_task_list` 的 `task_id`/`ownerName` 未被中断改写。',
    ],
    asserts: [
      { tag: 'direct', text: '`interrupt_agent` 返回 `previousStatus ∈ {running, inactive}`（D10：`provisioning`/`failed` 不可能出现）；调用者必须是 Lead，teammate 调用得到 `TEAM_LEAD_REQUIRED`。' },
      { tag: 'direct', text: '成员仍留在名册：`list_agents` 仍有该 `name`，`role=teammate` 计数不变（席位不因中断释放）。' },
      { tag: 'direct', text: '中断不释放任务：`team_task_list` 里该任务仍是原 `task_id`、原状态、`ownerName` 不变。' },
      { tag: 'direct', text: '带 nonce 的 `send_message` 投递成功，且**成员回报里出现该 nonce 原文**——这是"真的醒了"的唯一可观察判据（投递确认不等于它处理了）。' },
      { tag: 'direct', text: 'A34：收尾停止条件可读——所有任务 `completed` 或已显式交接，Lead 不再新开路线；每轮先 `list_agents` + `team_task_list` 再决定动作（30 秒控制点回读），空闲等待是有界 `wait_agent` 而不是无限轮询。' },
      { tag: 'unobservable', text: 'A34 的"不承诺自动唤醒"是行为约束，不是单次调用能观察到的字段；只能以记录里"没有无限轮询/没有新开路线"的旁证支撑。' },
    ],
    codes: [
      ['teammate 调 `interrupt_agent`', '`TEAM_LEAD_REQUIRED`', '服务层拒绝'],
      ['中断不存在/非 active 的成员', '`TEAM_MEMBER_NOT_FOUND`', '不是"已中断"'],
      ['唤醒消息超 65536 字节', '`TEAM_MESSAGE_TOO_LARGE`', '含信封前缀计量'],
    ],
    evidence: [
      '`interrupt_agent` 的原始返回。',
      '中断前后的 `list_agents` 与 `team_task_list`。',
      '`send_message` 的投递确认 + 成员回报原文（nonce 高亮）。',
      '`s7-before.json` 与它之后的 `diff`（证明中断本身没写项目文件）。',
    ],
    gaps: [
      '`send_message` 的工具返回只是投递确认（不是对方的答复），所以 nonce 必须从**后续团队消息**里读到，不能从 `send_message` 的返回里读到。',
      '中断与唤醒的时序受模型调度影响；记录里要写清两次调用之间的实际间隔，否则"它没回 nonce"无法归因。',
    ],
  },
]

/** 生成 markdown。故意不写时间戳：清单是判据，不是记录。 */
function renderChecklist() {
  const lines = []
  const totalAsserts = STEPS.reduce((total, step) => total + step.asserts.length, 0)
  const totalDirect = STEPS.reduce(
    (total, step) => total + step.asserts.filter((assertion) => assertion.tag === 'direct').length,
    0,
  )

  lines.push('# 第三层验收清单（真 `ctx.agentTeams` 团队会话）')
  lines.push('')
  lines.push('> 本文件由 `node packages/dsh-redteam-lead/scripts/l3-verify.mjs checklist --out <path>` 生成。')
  lines.push('> **不要手改**：要改断言就改脚本里的 `STEPS`，重新生成并提交。')
  lines.push('>')
  lines.push('> **状态：未执行。** 截至本文件生成时，第三层一次都没有跑过。本文件是待办与判定标准，**不是通过结论**；')
  lines.push('> 通过与否只由 `docs/verify/` 下填好的记录文件决定（见 `l3-record-template.md`）。')
  lines.push('')
  lines.push(`七步共 ${totalAsserts} 条断言，其中 ${totalDirect} 条可直接观察；其余标了「需构造」或「不可观察」——`)
  lines.push('**不要**用"看起来对"去填这三类里的后两类。')
  lines.push('')
  lines.push('> **LDW-13/14/17 之后这份清单只剩两个工具**：`rt_roster` / `rt_dispatch` 已删除，建人与派活回到宿主原生的')
  lines.push('> `spawn_teammate` / `send_message` / `team_task_*`。原来覆盖这两个工具的断言（A04/A06/A07/A10–A13/A22/A26/A31/A40/A44 等）')
  lines.push('> 已在文末表格里**标明废止**，不再算作"待通过"；清单的断言总数就是当前真正要判的行数。')
  lines.push('')
  lines.push('## 执行顺序：`1 → 2 → 3 → 4 → 5 → 6 → 7`')
  lines.push('')
  lines.push('第 5 步（收口主路径）需要第 2 步建出的工兵与它写下的草稿；第 6 步（拒绝路径）复用第 5 步那个成功的')
  lines.push('`operation_id` 验重放，所以 5 必须在 6 之前。第 3、4 步彼此独立，可以在第 2 步之后任意时点插入。')
  lines.push('')
  lines.push('省力技巧：第 5 步的第一次收口用 `outcome="blocked"` + `evidence_run_ids: []` + 一个真实的')
  lines.push('`state_recovery_ref`（工兵报"缺某项能力"），收口路径照样完整走一遍但不需要真跑实验、不需要封存；')
  lines.push('真实 `seal` + `check --hashes` 留给第二轮（交 `finding`，带真 RUN 与 `artifact_locator` 锚点）。')
  lines.push('')
  lines.push('## 标记约定')
  lines.push('')
  lines.push('| 标记 | 含义 | 能不能算通过 |')
  lines.push('|---|---|---|')
  lines.push('| 〔可观察〕 | 本会话的原始工具返回或 `collect` 的 JSON 里能直接读到判据 | 能，贴原文即可 |')
  lines.push('| 〔需构造〕 | 必须先造一个额外条件（改坏一个字段、开第二个会话、故意等超时） | 能，但必须写清构造方式，否则不算 |')
  lines.push('| 〔不可观察〕 | 现有工具面产不出该判据 | **不能**。记 `not-run` + 为什么 |')
  lines.push('')
  lines.push('## 开始之前')
  lines.push('')
  lines.push('1. 读完 `docs/verify/README.md` 的「前置」；四项缺一项就不要开始（团队 profile bundle、bundle 已 `link:` 安装并列进 `dsh.profile.bundles`、临时分析项目已接 skill、Python 可达）。')
  lines.push('2. 复制 `docs/verify/l3-record-template.md` 成一份记录，填好会话 id 与开始时间。')
  lines.push('3. **一次性会话**：验收完即丢。席位按会话计，丢弃即释放；重跑要在新会话里重新建成员。')
  lines.push('4. 每一步都做「`collect` → 操作 → `collect` → `diff`」，diff 是"这一步到底写了什么"的唯一机读证据。')
  lines.push('')
  lines.push('每一步的取证命令固定是这三条（`<证据目录>` 必须**在项目根之外**，脚本会拒绝把 `--out` 写进项目）：')
  lines.push('')
  lines.push('```powershell')
  lines.push('node <仓库根>/packages/dsh-redteam-lead/scripts/l3-verify.mjs collect --project <项目根> --out <证据目录>\\sN-before.json')
  lines.push('node <仓库根>/packages/dsh-redteam-lead/scripts/l3-verify.mjs collect --project <项目根> --out <证据目录>\\sN-after.json')
  lines.push('node <仓库根>/packages/dsh-redteam-lead/scripts/l3-verify.mjs diff --before <证据目录>\\sN-before.json --after <证据目录>\\sN-after.json --out <证据目录>\\sN-diff.json')
  lines.push('```')
  lines.push('')
  lines.push('`collect` 的输出里有 `digest`（只覆盖 path/bytes/sha256，不含 mtime）：两次 `collect` 的 `digest` 相同 = 项目内容没变。')
  lines.push('')

  for (const step of STEPS) {
    lines.push(`## 第 ${step.n} 步 — ${step.title}`)
    lines.push('')
    lines.push(`**目标**：${step.goal}`)
    lines.push('')
    lines.push(`**本步覆盖的 A 编号**：${step.a.map((id) => `\`${id}\``).join('、')}`)
    lines.push('')
    lines.push('### 怎么做')
    lines.push('')
    step.setup.forEach((item, index) => {
      lines.push(`${index + 1}. ${item}`)
    })
    lines.push('')
    lines.push('### 看哪里')
    lines.push('')
    for (const item of step.observe) lines.push(`- ${item}`)
    lines.push('')
    lines.push('### 可观察断言')
    lines.push('')
    for (const assertion of step.asserts) {
      lines.push(`- [ ] ${TAGS[assertion.tag]}${assertion.text}`)
    }
    lines.push('')
    lines.push('### 期望错误码')
    lines.push('')
    lines.push('| 触发 | 期望 `code` / 状态 | 备注 |')
    lines.push('|---|---|---|')
    for (const [trigger, code, note] of step.codes) lines.push(`| ${trigger} | ${code} | ${note} |`)
    lines.push('')
    lines.push('### 本步要贴的证据')
    lines.push('')
    for (const item of step.evidence) lines.push(`- ${item}`)
    lines.push('')
    if (step.gaps.length > 0) {
      lines.push('### 本步不可观察 / 有边界的项（记 `not-run`，不要编）')
      lines.push('')
      for (const item of step.gaps) lines.push(`- ${item}`)
      lines.push('')
    }
  }

  lines.push('## A 编号 → 步骤 → 可观察性')
  lines.push('')
  lines.push('| A 编号 | 步骤 | 能否在本会话观察 |')
  lines.push('|---|---|---|')
  const coverage = [
    ['A01', 1, '可观察（doctor 在普通 shell 跑）'],
    ['A02', 1, '部分：只能证明留下的是团队版，另一半已被 patch 删除'],
    ['A03', 3, '可观察（真实 teammate 的原始返回 + 空 diff；`rt_hash` 对成员放行）'],
    ['A08', 3, '部分：成员身份拒绝可观察；裸子代理那一路在本 preset 下不可由 Lead 发起（闸拒绝），记 not-run'],
    ['A17', '5、6', '可观察（锚点闭集按路线记录的门槛判；越界/不合规都在写盘前拒）'],
    ['A19', 5, '可观察（`re/seals/runs/<RUN>.json` 新增；已有封存只复用）'],
    ['A27', 5, '可观察（审计 `lines` 递增）；写失败那条需构造（设只读）'],
    ['A32', 6, '可观察（同 operation_id 重放 `replayed=true`；改内容 `OPERATION_CONFLICT`）'],
    ['A34', 7, '部分：停止条件与有界等待可读，"不承诺自动唤醒"只能旁证'],
  ]
  for (const [id, step, note] of coverage) lines.push(`| \`${id}\` | 第 ${step} 步 | ${note} |`)
  lines.push('')
  lines.push('### 规格验收（`team-v2-simplify`）→ 步骤')
  lines.push('')
  lines.push('| 编号 | 步骤 | 判据 |')
  lines.push('|---|---|---|')
  const specCoverage = [
    ['S1', '2', '工具表只剩两个 `rt_*`；`rt_dispatch`/`rt_roster` 调用是未知工具'],
    ['S2', '2', '工兵工具表里没有 `spawn_teammate`/`subagent`/`subagent_fork`/`workflow`；`send_message`/`team_task_*`/`rt_hash`/`pwsh` 仍在'],
    ['S3', '5、6', '`rt_conclude` 用 `route_id` + 结论 + 锚点即可收口；`promote` 从 `re/team/work/<route>/` 取源'],
    ['S4', '2', '两份人设不同，工兵那份不含「指挥」'],
  ]
  for (const [id, step, note] of specCoverage) lines.push(`| \`${id}\` | 第 ${step} 步 | ${note} |`)
  lines.push('')
  lines.push('### 已随工具删除的断言（不再作为验收项）')
  lines.push('')
  lines.push('| 原编号 | 原判据 | 现状 |')
  lines.push('|---|---|---|')
  const retired = [
    ['A04', 'inspect / bind / takeover', '`rt_roster` 已删除；项目绑定不再由本包维护'],
    ['A06 / A07', '岗位名额与能力族匹配', '岗位目录与 `capability_needs` 匹配已删除'],
    ['A09', '容量余额', '已废止（T23/D41）；`CAPACITY_*` 码也在 LDW-17 删除'],
    ['A10', '派发契约落盘 + `contract_sha256`', '`rt_dispatch` 已删除；简报写在 `spawn_teammate` 消息里'],
    ['A11', '同成员复用 / `MEMBER_BUSY`', '派活由 Lead 与宿主决定，本包不再排队或拒绝'],
    ['A12', '交付失败带已有身份 / 超长拒绝', '本包不再投递契约；`send_message` 的长度限制属宿主'],
    ['A13', '`start.json` 与两个时间盒', '本包不再跟踪 attempt 生命周期'],
    ['A22', '资源租用与别名互斥', '`resources.json` 与 `rt_dispatch` 一起删除'],
    ['A26', '收口时 task revision 冲突', '收口不再带 `expected_revision`，也不改任务板'],
    ['A31', '会话接管 / epoch 归档', '`binding.json` 与 takeover 已删除'],
    ['A40 / A44', '`rt_roster` 的 project_id 与缺口去重', '`rt_roster` 已删除'],
  ]
  for (const [id, before, now] of retired) lines.push(`| \`${id}\` | ${before} | ${now} |`)
  lines.push('')
  lines.push('## 全表判定怎么写')
  lines.push('')
  lines.push('- 每步只允许三种判定：`pass`（本步所有〔可观察〕断言都有原文证据）、`fail`（任一条断言与期望不符，写清第几条）、`not-run`（没执行或只执行了部分，写清缺什么）。')
  lines.push('- 〔需构造〕断言没构造就是 `not-run`，不能算 `pass`。')
  lines.push('- 〔不可观察〕断言永远不进 `pass`；它们进 `docs/verify/acceptance-status.md` 的 `not-run` 并附原因。')
  lines.push('')
  lines.push('## 跑完要交的东西')
  lines.push('')
  lines.push('1. 填好的记录（从 `l3-record-template.md` 复制），命名 `<YYYYMMDD>-<会话 id 前 8 位>.md`，放在 `docs/verify/records/`。')
  lines.push('2. 每一步的 `collect` JSON + `diff` JSON，放在 `docs/verify/records/<同名>/`，并在记录里写出每个文件的 SHA-256。')
  lines.push('3. 一条结论：整层 `pass` / `fail` / `not-run`，以及**没有覆盖到的 A 编号**（对照上面两张覆盖表，别把已废止的算成 not-run）。')
  lines.push('')
  return `${lines.join('\n')}\n`
}

async function commandChecklist(options) {
  assertKnownOptions(options, ['out'])
  const outPath = await prepareOutputPath(requireOption(options, 'out'), null)
  const markdown = renderChecklist()
  await writeFile(outPath, markdown, 'utf8')
  const asserts = STEPS.reduce((total, step) => total + step.asserts.length, 0)
  stdout.write(`checklist：${STEPS.length} 步 / ${asserts} 条断言 → ${outPath}\n`)
  return 0
}

/* -------------------------------------------------------------------------- */
/* 入口                                                                        */
/* -------------------------------------------------------------------------- */

async function main(tokens) {
  if (tokens.length === 0 || tokens.includes('--help') || tokens.includes('-h') || tokens[0] === 'help') {
    stdout.write(`${USAGE}\n`)
    return 0
  }
  const command = tokens[0]
  const options = parseArgv(tokens.slice(1))
  if (command === 'collect') return commandCollect(options)
  if (command === 'diff') return commandDiff(options)
  if (command === 'checklist') return commandChecklist(options)
  throw new UsageError(`未知子命令：${command}（用 --help 看用法）`)
}

const debug = argv.includes('--debug')
const tokens = argv.slice(2).filter((token) => token !== '--debug')

try {
  const code = await main(tokens)
  if (code !== 0) process.exitCode = code
} catch (error) {
  if (error instanceof UsageError) {
    stderr.write(`l3-verify: ${error.message}\n\n${USAGE}\n`)
    process.exitCode = 2
  } else {
    stderr.write(`l3-verify: 未预期的失败：${error?.message ?? String(error)}\n`)
    if (debug && typeof error?.stack === 'string') stderr.write(`${error.stack}\n`)
    process.exitCode = 1
  }
}
