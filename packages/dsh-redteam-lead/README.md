# @local/dsh-redteam-lead — 红队指挥

DSH bundle：给模式列表加一个 **红队指挥**（preset id `redteam-lead`，`order: 6`）预设。
它**不注册任何工具**，只做三件与「谁在什么位置上干活」有关的事：

| 能力 | 作用 |
|---|---|
| **角色闸** | 会话根（Lead）调配置里的那几个工具（shipped：`workflow` / `subagent` / `subagent_fork`）在 `tools/pre-execute` 上被拒，并顺手从它的工具目录里摘掉 |
| **工兵遮罩** | 非 Lead 的团队成员看不到那组派发/建人入口 |
| **两套人设** | Lead 一份、工兵一份；原生 DSH 下两者共用同一份（只差 `team:identity` 一句），这是本包存在的核心理由 |

**建人与派活不在本包里**：建工兵用宿主原生的 `spawn_teammate`（Lead 手写开场简报），派活/追问用
`send_message`，任务用 `team_task_create` / `team_task_update`，名册用 `list_agents`。
**账目也不在本包里**：项目记录、封存、验收全部走 `reverse-project-management` skill 的 `project.py`。

> **LDW-23（2026-11-03）**：原先的两个记账工具 `rt_conclude` / `rt_hash` 已删除。现场 8 次封存全走
> skill、`rt_*` 调用数为 0 —— 同一件事有两套账本时，模型只会选文档更全的那套。设计记录见本地
> `docs/impl/ARCHITECTURE.md` §6（`docs/` 不随仓库发布）。

零运行时依赖、纯 ESM、**不 import 任何 `@deepseek-ai/*`**：本地 `link:` 安装的 bundle 按自身真实
路径解析裸包名，宿主能力一律经注入的 `ctx` 取（`inject = ['agents', 'agentTeams', 'systemPrompt']`）。

> **当前交付状态**：preset、角色闸、工兵遮罩、两套人设均已实现并在真实会话里验证
> （Lead 的目录 273 → 270；工兵的目录 270 且两轮都不反弹）。源码 `src/*.ts`，发货字节 `dist/` 随仓库
> 提交。自动门禁：`node --test` 全绿 + `tsc --noEmit` 干净。

## 前置

1. **团队 profile bundle 必须启用**：`@deepseek-ai/dsh-experimental-agent-team-profile`。它随安装
   提供但默认关闭，而且**没有**按 bundle 的 `disabled` 字段——唯一的启用方式是把它列进 profile 的
   `dsh.profile.bundles`。没有它就没有 `ctx.agentTeams`：角色闸仍按会话头判定（不依赖服务），
   但工兵遮罩与工兵人设会静默失效 —— 这也是本包把它列进 `inject` 的原因（缺服务当场不激活，
   不要"少装一半"）。
2. **分析项目**需要接好项目内 `reverse-project-management` 副本（含**团队规则**段）与可用的
   Python。

## 安装

本包按 `link:` 装进 profile（和既有 `@local/dsh-rea-plugin` 同形态），不是发布包。
以 `desktop` profile 为例（`%USERPROFILE%\.dsh\profiles\desktop`）：

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add "link:D:\workSpace\dsh-redteam-plugin\packages\dsh-redteam-lead"   # 换成你自己的 checkout 路径
```

然后编辑该目录的 `package.json`，把本包加进 `dsh.profile.bundles`（放在团队 profile 之后）：

```json
{
  "dependencies": {
    "@local/dsh-redteam-lead": "link:D:\\workSpace\\dsh-redteam-plugin\\packages\\dsh-redteam-lead"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-experimental-plugin-market-bundle",
        "@deepseek-ai/dsh-experimental-agent-team-profile",
        "@local/dsh-redteam-lead"
      ]
    }
  }
}
```

重启 DSH 后，模式列表会多出「红队指挥」。**已有会话保留它启动时的 preset 版本**，新建会话才用新组合。

- 只改 `dependencies` 不改 `dsh.profile.bundles`，patch 层不会生效：`bundles` 决定哪些 bundle 贡献 patch。
- patch 写错插件名在宿主里是 **WARN + SKIP**（不报错、也不生效）；离线检查的检查项与
  `test/bundle.test.mjs` 的 id 清单断言就是用来兜住这一点的。

## 卸载

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
# 1) 从 package.json 的 dsh.profile.bundles 里删掉 "@local/dsh-redteam-lead"
# 2) pnpm remove @local/dsh-redteam-lead
```

本包**不写**任何项目内文件之外的全局状态，也不改既有 `redteam` preset 或 `@local/dsh-rea-plugin`
的任何文件与配置；卸载不需要回滚别的东西。若 `re/team/**` 下已有收据/台账，它们留在项目里，由
项目 skill 的记录规则与 Lead 的恢复流程处理（本包不再写 `binding.json`）。

## 工具面与边界

- 工具面 = 宿主 `standard` preset 的 `config.plugins` **整段手抄副本**，只做五处改动（第 0 条见 LDW-22）：
  删掉 `tool-subagent-control` / `tool-subagent-list-agents`（它们提供的
  `send_message` / `interrupt_agent` / `list_agents` 与团队服务按 agent 注册的同名工具冲突且语义不同），
  删掉 `persona` 行（人设改由本包行的 `leadPersona` / `teammatePersona` 提供，见下），追加本包行。
  保留 `tool-subagent` / `tool-subagent-fork` / `workflow-ptc` / `tool-workflow`（保留给工兵；Lead 侧由
  角色闸挡住、工兵侧由工兵遮罩挡住，见下条）。
- **角色闸（LDW-1 / LDW-8 / LDW-11 / LDW-19）**：本包在 `tools/pre-execute` 上装两个遮罩，判据都是 agent 身份、
  **不读 `exec.arguments`**：
  - **Lead 遮罩**：调用方是**会话根 agent**（`session.header` 里 `delegationDepth` 为 0/缺省、没有
    `origin: 'subagent'`、没有 `parentSession`）时，`pwsh` / `bash` / `workflow` /
    `subagent` / `subagent_fork` 一律拒绝；理由直接告诉模型「把这件事派给工兵」，并点名仍可用的核对
    手段（`read` / `grep`，已派作业用 `job_list` / `job_output` 读）。
  - **工兵遮罩（LDW-15）**：`role=teammate` 的成员看不到 `spawn_teammate` / `subagent` / `subagent_fork` /
    `workflow`；`send_message` / `team_task_*` / `list_agents` / `pwsh` 照常保留（前三个在 own 层，遮不掉但宿主会拒）。
  - 两者都**先遮后判**：命中后用 `agent.ctx.tools.restrict({ deny })` 把这几个名字从**该 agent** 的工具
    目录里拿掉（只传 `DENY_TOOLS ∩ 该 scope 的可遮名单`，交集为空就不调用）；遮罩失败、名单取不到或
    `restrict` 缺席，一律静默退回 deny-only 并留一条诊断。会话头读不出来（或调用方本来就是子代 agent）
    就放行（fail-open 在这里是对的：误伤工兵的代价远大于漏掉一次 Lead 自己动手）。预设**不参与判定**：
    `session.header.agentPreset` 是会话创建时的值，切过预设之后就是过期数据（LDW-19 的现场就栽在
    这里）。`job_*` 故意不在禁表里。
    见本地 `docs/specs/lead-does-not-work.md`（`docs/` 不随仓库发布）。
    既有 `@local/dsh-rea-plugin` 的拦截与审计照旧工作（它的 `scopePresets` 白名单不含 `redteam-lead`，
    所以拦截与影子模式提示在本 preset 下不生效——那是有意的边界，不是本包能改的）。
- **人设分两份（LDW-16）**：preset 里不再有 `dsh-persona` 行（同一作用域注册同名段会直接抛
  `already registered`）。文本都在本包行的 `config` 里：
  - `leadPersona` —— 注册在插件自己的 ctx（= preset 作用域），Lead 读它，它同时是全队兜底；
  - `teammatePersona` —— 在每个工兵自己的 ctx 上注册同名段 `deployment:persona-prefix`，只覆盖它自己。
  要改文案就改 `cordis.patch.yml` 里这两项，代码里没有默认值。角色仍由 runtime context
  （`team:identity` 一类的 `You are ...`）注入，人设不重复声明；两份都**不带** `complete` 语义，
  也不抑制 runtime context（有回归用例钉着）。
- **preset 里不声明 sandbox / approval 设置**：提供服务的插件若随 preset 泄漏到 root realm，注册表会把
  整棵 preset 判成 `broken`；权限属于 host 平面，不是本包职责。
- **注册用的 schema 有两条宿主约束**（`packages/core/tools/src/json-schema.ts`）：
  1. `output.schema` 只接受 `type / oneOf / properties / required / additionalProperties / items /
     enum / const` + 注解这个子集；`$ref`、`allOf`、`anyOf`、`if/then/else`、`pattern`、类型数组
     都会让注册直接抛 `UNSUPPORTED_SCHEMA`、整行插件不激活。所以注册的是
     `src/tool-schema.ts` 里的 `resultOutput`（`$defs.result` 的子集投影），完整条件约束仍由
     `src/envelope.ts` 与入口的严格校验保证。
  2. `parameters` 会直接进模型上下文，所以注册前把 `$ref` 就地展开（`concludeParameters` /
     `hashParameters`），不留悬空引用。
     这两条都有测试守卫（含宿主校验器的等价实现），改 schema 时先跑 `test/bundle.test.mjs`。

## 已知限制

1. **`workflow` 对工兵是遮罩挡的、不是 depth 策略挡的**（DECISIONS D5）：`subagent` / `subagent_fork`
   会被 depth 策略挡住，而 `workflow` 传了 `parent` 却没传 `maxDepth`。补偿控制是**工兵遮罩**
   （LDW-15：把这四个建人/派发入口从工兵的工具目录里拿掉）+ 团队服务自身的 `TEAM_LEAD_REQUIRED`。
   遮罩失败时只退回日志，不声称平台挡住了下一层创建。Lead 侧这五个名字由角色闸挡住（见上）。
   同时列为待实测项（见本地 `docs/verify/`，不随仓库发布）。
2. **工具面是手抄副本、没有 extends**：宿主升级改名或改 Config 时，表现是 preset 挂载失败（roster 里
   仍在、带 `broken` 诊断），不会自动跟随。基线固定在 **rc.3**（`docs/impl/baseline/standard.patch.rc3.yml`），
   复核方式是重新从 asar 抽 `standard.patch.yml` 与本包的 `cordis.patch.yml` 逐行 diff。
3. **locale 只影响显示名**：宿主只消费 `locale/*.json` 的 `meta.title` / `meta.description`；
   **工具描述不做本地化**（`description` 是裸字符串，直接进模型上下文），所以工具文案只有英文一份。
4. **诊断只有 `ctx.logger.warn`**：本包没有落盘通道，宿主也还没给出可读的运行期诊断出口。
5. **没有容量规划，也没有容量码**（T23 / DECISIONS D41 / LDW-17）：宿主不提供任何上限读数 ——
   `maxMembers` 是 `TeamService` 的构造函数参数（没有 getter），`maxActiveSubagents` 在团队服务里根本
   不存在。建人既然回到宿主原生的 `spawn_teammate`，席位满就由宿主直接回给调用者：本包不再有
   `CAPACITY_UNKNOWN` / `CAPACITY_EXHAUSTED`，也不读私有字段、不猜常数、不靠 spawn 试探。
6. **`re/env/tools.json` 目前没有生产者**（DECISIONS D11）：skill 侧没有生成命令，本机零个真实实例。
   本包没有任何工具消费这份清单（派发时代的能力匹配已删）；`projectAdapter.probe()` 只在项目副本缺
   `references/tool-inventory.md` 时报一条**非阻塞**的缺口，且它不会自己扫描或生成清单。

## 开发

在**仓库根**执行（唯一门禁命令）：

```powershell
node scripts/build.mjs
node --test "packages/dsh-redteam-lead/test/**/*.test.mjs"
node node_modules\typescript\bin\tsc -p packages/dsh-redteam-lead/tsconfig.json --noEmit
```

- 这台机器上 **`npm` / `npx` 被 PowerShell 执行策略挡住**（`npm.ps1` / `npx.ps1` 不可执行），所以构建
  直接用 `node scripts/build.mjs`、类型检查直接用 `node node_modules/typescript/bin/tsc`；`dist/` 必须
  重建并随源码一起提交（D28）。
- 门禁命令必须写成显式 glob（DECISIONS D20）：裸 `node --test` 会把 `test/helpers/*.mjs` 也当测试文件跑；
  `node --test <目录>` 在 Node 24 上直接失败（位置参数按 glob 解释，不展开目录）。
- 只跑测试文件：`node --test "packages/dsh-redteam-lead/test/*.test.mjs"`（须带 glob，理由同上）。
- 测试不依赖真实 Python、真实团队会话或外网；需要外部前置的用例一律 `t.skip(具体原因)`，不会假通过。
