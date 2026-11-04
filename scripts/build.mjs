#!/usr/bin/env node
/**
 * Bundle 构建脚本。
 *
 * 只做三件事：
 *   1. 清掉旧的 `dist/`；
 *   2. 用 `tsc -p packages/dsh-redteam-lead/tsconfig.json` 把 `src/**\/*.ts` 编到 `dist/`；
 *   3. 把非 TS 资产（`src/*.json`）复制到 `dist/`，让运行期按 `import.meta.url` 相对定位时在
 *      发货形态里也找得到。
 *
 * 为什么不用 `prepare`：`link:` 安装不会触发依赖包的 prepare，所以 `dist/` 必须随仓库提交
 * （见 docs/impl/DECISIONS.md D28）。本脚本是给人/CI 手动重建用的。
 *
 * 退出码：0 成功；非 0 时保留 tsc 的原始输出，不吞诊断。
 */
import { spawn } from 'node:child_process'
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const packageRoot = join(repoRoot, 'packages', 'dsh-redteam-lead')
const srcDir = join(packageRoot, 'src')
const distDir = join(packageRoot, 'dist')
const tsconfig = join(packageRoot, 'tsconfig.json')

/** 运行一条命令并透传输出；resolve 退出码，不抛。 */
function run(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, ...options })
    child.on('error', (error) => {
      process.stderr.write(`build: 无法启动 ${command}: ${error.message}\n`)
      resolveRun(1)
    })
    child.on('close', (code) => resolveRun(code ?? 1))
  })
}

async function main() {
  await rm(distDir, { recursive: true, force: true })
  await mkdir(distDir, { recursive: true })

  // 直接用 node 跑 typescript 的 JS 入口，而不是 node_modules/.bin/tsc(.cmd)。
  // 原因：Windows 上 Node ≥18.20 出于 CVE-2024-27980 的修正在 `shell: false` 下
  // 拒绝 spawn `.cmd`/`.bat`，会抛 `spawn EINVAL`；走 JS 入口既跨平台又不需要 shell。
  const tscEntry = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  const code = await run(process.execPath, [tscEntry, '-p', tsconfig])
  if (code !== 0) {
    process.stderr.write('build: tsc 失败，dist/ 可能不完整。\n')
    return code
  }

  // 非 TS 资产：src/ 下所有 .json 平铺复制到 dist/。
  const entries = await readdir(srcDir, { withFileTypes: true })
  const copied = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    await cp(join(srcDir, entry.name), join(distDir, entry.name))
    copied.push(entry.name)
  }

  process.stdout.write(`build: dist/ 就绪（资产：${copied.length > 0 ? copied.join(', ') : '无'}）。\n`)
  return 0
}

process.exitCode = await main()
