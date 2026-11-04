# README_AI

> 给 AI 读的操作手册：**怎么把本插件和配套 skill 装起来，以及装完怎么确认它真的生效。**
> 只管"装"。挡哪些工具、人设文案、成员上限这类东西不在这里讲。

## 0. 顺序

1. 确认两个前提 → 2. 装插件 → 3. 接 skill → 4. 验证四条

第 4 步不能跳。本项目已经出现过"测试全绿、现场完全没效果"的情况（人设与遮罩都静默失效过），所以**没验证过的"装好了"一律按没装算**。

## 1. 先确认两个前提

**1.1 DSH 的智能体团队必须已开启。**
`@deepseek-ai/dsh-experimental-agent-team-profile` 必须已经在这个 profile 的 `dsh.profile.bundles` 里。它随 DSH 提供但默认关闭，而且没有 `disabled` 开关可翻——**唯一开启方式就是列进 `bundles`**。

本插件依赖它提供的成员、消息与任务板。没有它，插件不会激活（不是"半个能用"）。

**1.2 `dist/` 必须存在。**
包是按 `link:` 方式使用的，宿主**不会**替它编译。`dist/*.js` 随仓库提交；如果你改过 `src/`，先重建再继续（见 §5）。

## 2. 装插件

**两件事都要做，只做一件都是"看起来装了、其实没生效"。**

**2.1 把依赖指向本地 checkout**（在 profile 目录里执行）：

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add "link:<本仓库绝对路径>\packages\dsh-redteam-lead"
```

如果这台机器 PATH 上没有 `pnpm`（Windows 上常见），用 DSH 自带的那份：

```powershell
node "<DSH 安装目录>\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" add "link:<本仓库绝对路径>\packages\dsh-redteam-lead"
```

`npm` / `npx` 在 Windows 上可能被 PowerShell 执行策略挡住，别指望它们。

**2.2 把包名列进 `dsh.profile.bundles`**（编辑同一个目录的 `package.json`，**排在团队 profile 之后**）：

```json
{
  "dependencies": {
    "@local/dsh-redteam-lead": "link:<本仓库绝对路径>/packages/dsh-redteam-lead"
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

三个名字必须一字不差（写错不报错，只 WARN + SKIP，等于没装）：

| 用在哪 | 值 |
|---|---|
| profile 依赖与 `bundles` 里的包名 | `@local/dsh-redteam-lead` |
| 本插件在模式里的行名 | `redteam-lead-tools` |
| 模式 id / 列表显示名 | `redteam-lead` / 红队指挥 |

**2.3 重启 DSH。** 模式列表与 patch 层在启动时构建。**已有会话保留它启动时的模式版本**，要新开会话才看得到新组合。

## 3. 接 skill

```powershell
cd <你的分析项目目录>
git clone https://github.com/luck9527c-eng/reverse-project-management.git
```

然后按该仓库自己的说明初始化项目骨架（INDEX、`re/` 等），并确认项目内的 skill 副本**包含团队规则段**——缺这一段，工兵的草稿区和主 agent 的收口对不上。

两条边界：

- 已有的分析项目**不要重新初始化**，按差异局部合并。
- 用项目内的副本，不要用全局副本覆盖它。

## 4. 装完怎么验（四条，都要有观察值）

**V1 · 模式出现**
新建一个会话，模式列表里有「红队指挥」。

**V2 · 主 agent 被挡**
在该模式的会话里让主 agent 调 `workflow`（或 `subagent`）：
- 期望：被拒，理由指明"派给工兵"；
- 同时这个工具从主 agent 的工具目录里消失（工具总数减少）。

**V3 · 工兵被挡**
建一个成员，让它在自己会话里列出可用工具：
- 期望：`spawn_teammate` / `subagent` / `subagent_fork` / `workflow` **都不在**；
- `send_message` / `team_task_*` / `list_agents` / shell **都在**（它要能干活、能回报）。
- **让它再续一轮再看一次**：成员在续轮时会被宿主重建，遮罩必须仍然生效。这一步最容易漏。

**V4 · 两套人设**
比较主 agent 与工兵收到的系统提示词：**两份长度必须不同**（工兵那份明显更短）。若两份完全一样，工兵读到了主 agent 那份，人设没生效。

## 5. 装不上时先看这几条

| 症状 | 最可能的原因 | 怎么处置 |
|---|---|---|
| 模式列表没有「红队指挥」 | 三个名字拼错（WARN + SKIP）；或没列进 `bundles`；或依赖没装上 | 按 §2.2 的名字表逐个核 |
| 有模式，但主 agent 照样能跑 `workflow` | 不是新会话；或团队服务缺席 | 新开会话再测；确认 §1.1 |
| 工兵能看到 `spawn_teammate` | 团队服务缺席，插件没激活 | 确认团队 profile 已列进 `bundles` |
| 改了源码但行为没变 | 没重建 `dist/` | 见下 |
| 第 9 个成员建不出来 | 团队上层设置了更小的成员上限 | 这是团队那一侧的事，本插件不规划容量 |

重建 `dist/` 与自检（在仓库根）：

```powershell
node scripts/build.mjs
node --test "packages/dsh-redteam-lead/test/**/*.test.mjs"
node node_modules\typescript\bin\tsc -p packages/dsh-redteam-lead/tsconfig.json --noEmit
```

测试必须带显式 glob：裸 `node --test` 会把辅助文件也当测试跑，`node --test <目录>` 在 Node 24 上直接失败。

## 6. 三条硬规矩

1. **不要改宿主**（`app.asar`、宿主包源码）。改动只落在本仓库与 profile。
2. **不要手工造链接或复制包目录**去"修"依赖，用 `link:` 重装（§2.1）。
3. **不要在仓库里 `git add -A`**：`docs/` 是被忽略的本地资料，误提交过一次。
