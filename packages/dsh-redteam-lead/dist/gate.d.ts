/**
 * LDW-1 角色闸：`redteam-lead` 的**会话根 agent** 不亲自干活。
 *
 * 依据 [`docs/specs/lead-does-not-work.md`](../../../docs/specs/lead-does-not-work.md) §变更 1：
 * 调用方是会话根 agent 时，以下工具一律拒绝并给出可执行指引（「派给工兵」）：
 * `pwsh`、`bash`、`workflow`、`subagent`、`subagent_fork`。
 * `job_*` 不在其中：派发之后读作业结果是 Lead 的核对动作，不是执行。
 *
 * **LDW-19：判据换成「会话根」，预设不再参与判定。** 这个插件只挂在 `redteam-lead` 这一个
 * preset 里，而预设作用域的监听器收到的是**整个代际**的事件 —— 它能看见的 agent 本来就都属于
 * 这个 preset，再查一遍预设是多余的。而且那份数据是错的：`session.header.agentPreset` 记的是
 * **会话创建时**的预设（现场那次是 `standard`，之后才切到 `redteam-lead`），活组合
 * `inspectCompositions` 在预设作用域里又取不到 —— 两头都判不出，闸全程沉默
 * （`session-1558015b`：`pwsh` 186 次、0 次被拒）。现在只看会话头（`rootOf`），不需要任何服务。
 *
 * 两条不变量：
 * - **只按 agent 身份判定，不解析命令文本**（`exec.arguments` 在闸里一次都不读）。
 * - **判不出来就放行**：会话头缺失/读不懂（`unknown`）、或调用方是子代 agent（`child`）—— 全部 `allow`。
 *   误伤工兵的代价远大于漏掉一次 Lead 自己动手。
 *
 * LDW-8 在同一处补**体验**：确认是 Lead 之后，顺手把同一张表从**这个 agent** 的工具目录里
 * 拿掉（`agent.ctx.tools.restrict({ deny })`）。拒绝是保证，遮罩是增强 —— `restrict` 缺席或
 * 抛错一律静默退回拒绝，只留一条诊断。
 *
 * LDW-11 把「拿哪几个名字去遮」改成**求交**：宿主的 `restrict()` 对「名字不在该 scope 的可遮
 * 名单里」是**整表**抛错（`dsh-tools:3002-3004`），五个名字里只要有一个没在这棵组合树上注册
 * （例如某个 preset 没 compose `workflow` 引擎），整块遮罩就失败、静默退回 deny-only ——
 * 工具仍然可见。所以先取该 agent scope 的可遮名单（`view(scope).restrictableNames`，即
 * `restrict()` 逐字校验的那一份；`view` 缺席时退到 `schemas(scope)` 的可见目录），与
 * `GATED_TOOLS` 求交，**只传交集**；交集为空就根本不调 `restrict`。每次尝试留一条诊断，
 * 写清「本应遮 N 个、实际遮 M 个」。
 *
 * 决策本身是纯函数（`decideGate`），单独可测；`installRoleGate` 只负责把它挂到
 * 宿主的 `tools/pre-execute` 瀑布上（兄弟 bundle `redteam-preset/index.js:453-502` 的成熟写法）。
 *
 * LDW-15 把同一段遮罩机制**再借一次**给工兵：非 Lead 的团队成员看不到四个「建人 / 派发」入口
 * （`TEAMMATE_DENIED_TOOLS`）。两边只差一张 deny 表、一个诊断主语与一个 effect label ——
 * 找 scoped ctx、与可遮名单求交、整表被拒的处置全部走 `maskToolsForAgent` 一处实现。
 * 工兵那边没有 deny 保底，所以裁不掉时只能记一条日志（`installTeammateMask`）。
 *
 * @module @local/dsh-redteam-lead/gate
 */
/**
 * 默认被禁的工具名：都是「Lead 自己动手」的入口，不是核对手段。
 *
 * **五个**，且 `job_*` 故意不在表里（DECISIONS D42：`jobs` 不是宿主真实工具名；读后台作业的
 * `job_list`/`job_output`/`job_kill` 是 Lead 的核对手段，和 `read`/`grep` 同类）。
 *
 * 这份清单只是**默认值**：实际用哪几个由本包行的 `config.gatedTools` 决定（解析见
 * `src/index.ts` 的 `resolveGatedTools`），经 `decideGate` / `createRoleGate` /
 * `installRoleGate` 的 `gated` 参数逐层传进来。不传就是这一份 —— 既有调用方因此不用改。
 * 声明顺序保留（默认值与诊断文案要按人写的顺序读），语义是集合。
 */
export declare const DEFAULT_GATED_TOOLS: ReadonlySet<string>;
/**
 * `DEFAULT_GATED_TOOLS` 的历史名字，保留为**同一个 Set 的别名**。
 *
 * 这个名字已经随 `dist/gate.d.ts` 发出去过，既有测试与调用方 import 的就是它，删掉等于破坏性
 * 改名。但「默认值」与「本次生效的清单」是两件事：后者永远是参数 `gated`，不是这个常量 ——
 * 所以新名字叫 `DEFAULT_*`，老名字只是别名。
 */
export declare const GATED_TOOLS: ReadonlySet<string>;
/**
 * 调用者角色。LDW-19 起它**不参与拒绝判定**（拒绝只看 {@link rootOf}）：
 * 只剩一个用途 —— 决定要不要给这个 agent 下发 Lead 遮罩（LDW-8）。
 */
export type GateRole = 'lead' | 'teammate' | 'other' | 'unknown';
/** 这个 agent 在会话里的位置。**只有 `root` 会被角色闸拦住**；`unknown` 与 `child` 一样放行。 */
export type AgentRoot = 'root' | 'child' | 'unknown';
/**
 * LDW-19：从**会话头**判「是不是会话根」，不需要任何服务。
 *
 * 三个字段，任一子代证据成立就是 `child`：
 * - `origin === 'subagent'`（裸子代理没有 `parentSession`，只有这一条）；
 * - 有 `parentSession`（非空字符串或记录）；
 * - `delegationDepth >= 1`。
 *
 * 都没有、且 `delegationDepth` 是 0 或缺省 → `root`。
 * 头缺失、头不是普通对象、或深度读不懂（字符串 / 负数 / NaN）→ `unknown`。
 * **绝不抛**：会话头是活的宿主对象，读字段本身可能抛（已销毁的 session），一律收成 `unknown`。
 */
export declare function rootOf(exec: unknown): AgentRoot;
/**
 * LDW-15：工兵被裁掉的四个入口 —— 建人与派发。
 *
 * spec §变更 3 的判据：派发权靠「契约里写一句不许」是软的，能力拿掉才是硬的。
 * 这张表**只管入口**，不碰干活的手段：`pwsh`、`send_message`、`team_task_*`、`list_agents`、
 * 一个都不在表里（工兵要能干活、能回报、能自查）。
 *
 * 与 {@link GATED_TOOLS} 的关系：三个名字（`subagent`/`subagent_fork`/`workflow`）两边都挡
 * —— 语义不同但结论一样（Lead 不自己开、工兵不往下派）；`spawn_teammate` 只在这张表里，
 * 它是 Lead 的建人入口，绝不能被角色闸挡掉。
 */
export declare const TEAMMATE_DENIED_TOOLS: ReadonlySet<string>;
/** 判定语义：`tryMembership` 认得出、且不是 Lead，就是这张表要服务的对象（bare subagent 不算）。 */
export declare function isTeammateRole(role: GateRole): boolean;
/**
 * **非 root 团队成员**的禁表（2026-11-10）。
 *
 * 只有 `wait_agent` 一个，理由各不相同：
 * - 它在团队工具插件里是**按 agent 自己的 ctx** 注册的（own 层），`tools.restrict` 摘不掉 —— 遮罩永远够不着；
 * - 服务层也**不拦**：`waitForChange` 只解析成员身份、不做角色校验，工兵调它是合法的；
 * - 现场（`session-4a879223` 的 `sapper-runtime`）：37 次调用、**0 次超时**、累计阻塞 **1087 秒**。
 *   它等的是「Lead 放行」，可 `wait_agent` 等的是「团队里任意变化」——同一队里别人写任务板、
 *   另一个成员切状态，都会把它叫醒，醒来发现不是要的东西，再等一次 → 自旋。
 *
 * `spawn_teammate` 故意**不**放进来：服务层已经用 `TEAM_LEAD_REQUIRED` 拒了它，
 * 闸再拦一次只是多一条重复理由，而挡不住的那部分（own 层注册）两边一样挡不住。
 */
export declare const TEAMMATE_GATED_TOOLS: ReadonlySet<string>;
/**
 * 工兵侧的拒绝理由。
 *
 * 与 Lead 那条（"成员完成会唤醒你"）**不同**：工兵不是指挥，它等的是「放行」，
 * 而它没有对等同伴可等。真正该做的是把状态报回 Lead、结束回合 —— Lead 一说话就把它唤醒。
 */
export declare function teammateDenyReason(tool: string): string;
/** 纯判定的入参：工具名与会话位置都已经由可测的探针解析好。 */
export interface GateInput {
    /** 即将执行的工具名（`exec.name`）。 */
    tool: string;
    /** 调用方在会话里的位置；判不出来就是 `'unknown'`。 */
    root: AgentRoot;
    /**
     * 本次生效的禁表；缺省 = {@link DEFAULT_GATED_TOOLS}。
     *
     * 空集是合法的（「一个都不挡」）—— 正是为此才不能用「空就退回默认」的写法：那会让一次
     * 有意的收窄变成静默的放宽。
     */
    gated?: ReadonlySet<string>;
    /**
     * 按工具定制的拒绝理由；缺省走 {@link denyReason} 的通用文案。
     *
     * 只有**同时**在 `gated` 里的名字才会被拒，所以这里多写几个键是无害的（不会凭空扩大禁表）。
     */
    reasons?: GatedToolReasons;
    /** 非 root 团队成员的禁表；缺省 = {@link TEAMMATE_GATED_TOOLS}。 */
    teammateGated?: ReadonlySet<string>;
    /**
     * 调用方在团队里的角色。
     *
     * 只在 `root === 'child'` 时参与判定（非 root 团队成员的禁表）；`'unknown'` 一律放行 ——
     * bare subagent 不在团队里，不归这条闸管。
     */
    role?: GateRole;
}
/** 判定结果：只有 `deny` 带理由（宿主把它原样交给模型）。 */
export type GateDecision = {
    kind: 'allow';
} | {
    kind: 'deny';
    reason: string;
};
/**
 * 按工具定制的拒绝理由：键是工具名，值是**要追加的正文**（统一前缀由 {@link denyReason} 加）。
 *
 * 为什么需要它：同一条闸挡两类完全不同的东西 —— 一类是「自执行/派发入口」，理由该说「派给工兵」；
 * 另一类是「等同伴」这类**根本不该做**的动作（`wait_agent`：成员完成会自己唤醒你），
 * 拿「派给工兵」去解释它，模型只会困惑或换个工具硬撞。
 */
export type GatedToolReasons = Readonly<Record<string, string>>;
/**
 * 拒绝理由。三件事必须同时说到，否则模型会原地重试或换个工具硬撞：
 * 1. Lead 不亲自执行（这是身份约束，不是工具坏了）；
 * 2. 该怎么做 —— 用底座的 `spawn_teammate` 建人并手写开场简报，派活用 `send_message`；
 * 3. 还能用什么 —— `read` / `grep` 核对，`job_*` 读已派作业。
 *
 * LDW-23：原文还挂着两个本包的 `rt_*` 记账工具，它们已经删了 —— 拒绝理由里指一个不存在的
 * 工具，模型只会去找它、然后卡住。账目走 `reverse-project-management` skill 的 `project.py`。
 *
 * 措辞里刻意不出现「重试」「稍后」这类把拒绝说成暂时故障的词。
 */
export declare function denyReason(tool: string, reasons?: GatedToolReasons): string;
/**
 * 纯判定：**只有**「调用方是会话根」且「工具在禁表里」时拒绝。子代与 `unknown` 一律放行（fail-open）。
 *
 * 为什么不再看预设（LDW-19）：本插件只挂在 `redteam-lead` 这一个 preset 里，预设作用域的监听器
 * 收到的是整个代际的事件 —— 看得见的 agent 本来就都属于这个 preset；而
 * `session.header.agentPreset` 记的是**创建时**的预设，切过预设后就是过期值。再查一遍既多余、
 * 又只会查错（现场就是这么沉默的）。
 *
 * 为什么也不看角色：根判定已经把 Lead 与工兵分开了；再叠一层团队服务，会把「服务缺席」
 * 重新变成漏拦 —— 而团队查询只该决定遮罩（体验），不该决定拒绝（保证）。
 *
 * 禁表是**参数**（`gated`），不是模块常量：同一份判定逻辑要被「默认五个」与「本包行配置的那几个」
 * 共用，前者只是后者的缺省值。
 */
export declare function decideGate({ tool, root, gated, reasons, teammateGated, role }: GateInput): GateDecision;
/**
 * 用执行上下文里的 agent 查团队成员身份。
 *
 * 唯一身份来源是 `exec.agent` + `ctx.agentTeams.tryMembership`（宿主形状，见
 * `dsh-team` 的 `tryMembership(agent)`：认不出的 agent 返回 `undefined`，不抛）。
 * 服务缺席、返回 `undefined`、抛异常、`exec.agent` 缺失 —— 一律 `unknown`：结果只影响
 * 「要不要遮罩」（`createRoleGate` 里角色是 `lead` 才遮），不影响放行/拒绝。
 * `tryMembership` 在宿主里是同步的；`memberRoleOf` 对 Promise 也能等（替身/其它实现）。
 */
export declare function resolveRole(ctx: unknown, exec: unknown): Promise<GateRole>;
/**
 * 同一套探针，入参直接是 agent（`agent/created` 那条路没有 `exec`）。
 *
 * **同步优先**：宿主的 `tryMembership` 是同步的，而 `agent/created` 的监听器也是同步回调 ——
 * 中间多一个 microtask，就会出现「人已经建好、工具目录还没裁」的窗口。只有当替身实现返回
 * Promise 时才等它。
 */
export declare function memberRoleOf(ctx: unknown, agent: unknown): GateRole | Promise<GateRole>;
/** 瀑布监听器的 `next()`：不接管决定时必须**原样**返回它的结果。 */
export type PreExecuteNext = () => unknown;
/** 挂进 `tools/pre-execute` 的监听器形状（宿主：`async (exec, next) => decision`）。 */
export type PreExecuteListener = (exec: unknown, next: PreExecuteNext) => Promise<unknown>;
/** `ctx.effect` 的 label：fiber 归属与 HMR 清理的可读标记。 */
export declare const GATE_LABEL = "redteam-lead/role-gate";
/** 工兵裁剪的监听器 effect label（与逐 agent 的遮罩分开：卸载顺序与诊断都要能分辨）。 */
export declare const TEAMMATE_INSTALL_LABEL = "redteam-lead/teammate-mask:install";
/** 遮罩的 `ctx.effect` label：遮罩本身归 agent，解除它的清理归本插件 fiber。 */
export declare const MASK_LABEL = "redteam-lead/role-gate:restrict";
/** LDW-15 工兵裁剪的 effect label（与 Lead 的遮罩分开：卸载时要能分辨谁是谁）。 */
export declare const TEAMMATE_MASK_LABEL = "redteam-lead/teammate-mask:restrict";
/**
 * 一次遮罩尝试的结果。
 *
 * **只喂诊断**：闸的决定永远由 `decideGate` 单独做出，遮罩成不成功都不改变放行/拒绝。
 * 「本应遮几个」不是这里的字段 —— 它等于**调用方传进来的那张表**的大小（默认
 * {@link DEFAULT_GATED_TOOLS}.size，配置了 `gatedTools` 就是配置的大小），只在写诊断时引用。
 */
export interface MaskOutcome {
    /** 结果分类；`repeat` = 这个 agent 已经试过了。 */
    kind: 'masked' | 'empty' | 'unknown-names' | 'unavailable' | 'failed' | 'repeat';
    /** 实际成功下发遮罩的名字。 */
    masked: readonly string[];
    /** 本应遮、这次没遮到的名字（不可见的、或因整表被拒而一个都没落地的）。 */
    skipped: readonly string[];
    /** `kind: 'failed'`：`restrict` 抛出的原文（宿主整表拒绝时会点名是哪个名字）。 */
    error?: string;
}
/** 活的 agent 列表（`AgentRegistry.list()`）；拿不到就是空表，绝不猜。 */
export declare function liveAgents(ctx: unknown): unknown[];
/**
 * 把 restrict 的 disposer 交给**本插件自己的** fiber 持有。
 *
 * 遮罩的 effect 归调用方 ctx（也就是 agent），插件卸载时它不会自己消失 —— 不接管就会在
 * 别人的 scope 上留一块没人收的遮罩。宿主支持 `effect(() => () => …)` 这种直接返回清理函数
 * 的形状（`dsh-tools` 自己也这么用）；拿不到 `effect`、或 disposer 不是函数，就不挂。
 *
 * LDW-15 的遮罩与 LDW-16 的人设段都盖在**别人的 scope** 上，用的是同一个接管动作：不接管，
 * 插件卸载后那块东西还留在那儿，下一份配置就盖不上去（同名同层再注册会抛）。
 */
export declare function ownDisposal(ctx: unknown, dispose: unknown, label: string): void;
/**
 * 「这个 agent 的这个 scope 已经处理过」的记号。
 *
 * **键是 `agent.ctx`，不是 agent id**（LDW-21）。可续轮的工兵在下一轮会被宿主**重建**：同一个
 * session id、同一个成员 id，但新的 agent 对象与新 scope —— 按 id 去重会让续轮那次既没有遮罩
 * 也没有人设（2026-11-03 现场：turn 1 = 271 工具、`workflow`/`subagent_fork` 已被摘掉；
 * turn 2 = 273 工具，宿主发出两条 `tool-addition` 把它们加回来）。按 scope 去重则：
 * 同一个 scope 只做一次（不撞宿主 `already registered in this scope`），scope 换了就再做一次。
 */
export type MaskAttempts = WeakSet<object>;
/**
 * 给**任意一个 agent 的 ctx** 下发遮罩：每个 scope 只尝试一次，且绝不抛。
 *
 * LDW-8（Lead 的五个执行入口）与 LDW-15（工兵的四个派发入口）共用这一段 —— 两边的差别
 * 只有 deny 表、诊断主语与 effect label，其余（找 scoped ctx、求交、整表拒绝的处置）一字不差。
 *
 * 三个理由：
 * - `restrict` 可叠加，重复调用无害，但重试没有收益；
 * - 失败重试会把「宿主形状不符」变成每次工具调用一条告警；
 * - 遮罩只是体验（Lead 那边 `deny` 才是保证），所以任何异常都不能穿过这里。
 *
 * 传入的名字是**交集**：`intended ∩ 该 scope 的可遮名单`。`restrict` 对名单外的一个名字
 * 是整表拒绝，所以宁可少遮几个，也不能让整块遮罩因为一个没注册的引擎而全线失败。
 *
 * @param ctx 插件自己的 ctx（disposer 归它）
 * @param agent 被遮的 agent（`restrict` 只能落在它自己的 scoped ctx 上）
 * @param intended 本应遮的名字（调用方给出的 deny 表）
 * @param attempted 每个 scope 只做一次的记号（调用方持有；键见 {@link MaskAttempts}）
 * @param label disposer 的 fiber label
 */
export declare function maskToolsForAgent(ctx: unknown, agent: unknown, intended: readonly string[], attempted: MaskAttempts, label: string): MaskOutcome;
/** 与 {@link logGate} 同一条通道，但带调用方自己的 label（LDW-16 的人设诊断要用）。 */
export declare function logAt(ctx: unknown, label: string, message: string): void;
/**
 * LDW-15：给每个**非 Lead 的团队成员**遮掉四个派发/建人入口。
 *
 * 两个入口，宿主 `@deepseek-ai/experimental-tool-agent-team` 的 `maybeInstall` 就是这个形状：
 * 1. 安装时扫一遍 `ctx.agents.list()` —— 工兵通常在 Lead 派发之后才建，但插件也可能是
 *    在会话中途挂上的（HMR/preset 重载），那时已有的工兵必须同样被裁；
 * 2. `ctx.on('agent/created', …)` —— 之后每一个新建的工兵在这里被裁。
 *
 * 不裁的对象：Lead（归角色闸的五个执行入口）、`tryMembership` 认不出的 agent（bare subagent）。
 * 裁剪是**能力**层面的：它不改变任何工具行为，只是让这四个名字从这个 agent 的目录里消失。
 *
 * 失败策略与 `installRoleGate` 一致：绝不抛（`apply()` 抛一次等于整行插件不激活，角色闸与人设
 * 工具与角色闸一起消失）；`ctx.on` 缺席时返回 `false` 并留一条可运营的诊断。
 */
export declare function installTeammateMask(ctx: unknown): boolean;
/**
 * 造一条角色闸监听器（不注册，便于单测与复用）。
 *
 * 读的东西只有 `exec.name` 和 `exec.agent`（含它的 `session.header`），**绝不读
 * `exec.arguments`**：闸判的是「谁在调」，不是「调什么命令」，所以不存在命令文本解析与绕过。
 *
 * 顺序是「先遮后判」：会话根就是本 preset 的 Lead，确认之后顺手把**配置里的那几个**工具从
 * **这个 agent** 的目录里拿掉，再做放行/拒绝的决定。遮罩失败不影响决定（`applyMask` 自己吞掉一切）。
 *
 * 两件事刻意分开：
 * - **判根不需要服务**（`rootOf`）—— 拒绝是保证，团队服务/预设服务缺席也照样拦；
 * - **遮罩仍然问一次团队身份**（`role === 'lead'`）—— 遮罩是体验，只该落在真正的 Lead 身上。
 *   只有会话根才可能是这个 preset 的 Lead，所以子代不必为每次工具调用付一次团队查询。
 *
 * @param ctx 插件自己的 ctx（身份探针与遮罩的 disposer 归它）
 * @param gated 本次生效的禁表；缺省 = {@link DEFAULT_GATED_TOOLS}（既有调用方不用改）
 * @param attempted 去重记号（键是 agent 的 **scope**，见 {@link MaskAttempts}）。
 *   `installRoleGate` 会把它与「agent 出现 / 状态变化」那条补遮路径**共用**：谁先遮谁留下那条诊断，
 *   另一方看到 `repeat` 静默跳过。缺省自带一个，便于单测直接调用。
 */
export declare function createRoleGate(ctx: unknown, gated?: ReadonlySet<string>, attempted?: MaskAttempts, reasons?: GatedToolReasons): PreExecuteListener;
/**
 * 把角色闸挂到宿主的 `tools/pre-execute` 瀑布上，返回「闸是否真的挂上了」。
 *
 * 写法照兄弟 bundle 的成熟形状（`redteam-preset/index.js:453-502`）：
 * `ctx.effect(function* () { yield ctx.on(事件, 监听器, { prepend: true }) }, '<label>')`。
 * `prepend` 让闸先于其它策略看到这次调用；我们不接管时 `return next()`，下游决定原样保留。
 *
 * **降级而不抛**（与 LDW-8 的失败策略一致：增强失败就退回保底并记一条）：
 * - 缺 `ctx.effect`、但有 `ctx.on` ⇒ 直接挂监听器，**deny 保底照常生效**，只记一条「监听器不归本插件
 *   fiber 所有、卸载时不会自动摘」；
 * - 缺 `ctx.on` ⇒ 没有地方挂闸（deny 与遮罩都不生效），记一条**可运营的**诊断后返回 `false`。
 *
 * 这里绝不抛：`installRoleGate` 在 `apply()` 里，抛一次就等于整行插件不激活、人设与遮罩一起
 * 消失 —— 代价远大于少一道闸。
 *
 * @param ctx 插件自己的 ctx
 * @param gated 本次生效的禁表（`config.gatedTools` 解析出来的那一份）；缺省 = 默认五个
 */
export declare function installRoleGate(ctx: unknown, gated?: ReadonlySet<string>, reasons?: GatedToolReasons): boolean;
