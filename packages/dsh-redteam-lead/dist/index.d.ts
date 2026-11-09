/**
 * `@local/dsh-redteam-lead` 的宿主插件入口。
 *
 * 这个包只做三件事，全部与「谁在什么位置上干活」有关：
 *
 * | 能力 | 实现 | 出口 |
 * |---|---|---|
 * | **角色闸**：会话根（Lead）不亲自调派发类工具，顺手把配置里的那几个名字从它的目录里摘掉 | `src/gate.ts` | `tools/pre-execute` 瀑布 + `tools.restrict` |
 * | **人设分离**：Lead 一份、工兵一份（工兵在自己 ctx 上盖同名段），文本全部来自本行配置 | `src/persona.ts` | `deployment:persona-prefix` |
 * | **工兵遮罩**：非 Lead 的团队成员看不到派发/建人入口 | `src/gate.ts` | `tools.restrict` |
 * | **工兵固定路由**：非 root 成员建出来后钉住 provider/model/effort，Lead 自己选什么都不受影响 | `src/teammate-model.ts` | `agent.model.select` |
 *
 * LDW-23：**本包原来的两个 `rt_*` 记账工具已删除**（按路线收口 / 只读核字节那对）。理由不是"不好用"，
 * 而是现场从来没调过它们：2026-11-02 那轮 3 小时 32 分的会话里 8 次封存全走
 * `reverse-project-management` skill 的 `project.py seal`，`rt_*` 调用数为 0 —— 同一件事有两套
 * 账本时，模型只会选文档更全的那套。留着它们既多一份要维护的契约（几千行校验器 + 一份 schema），
 * 又暗示"还有第二种记账方式"。**账目归 skill，本包只管位置。**
 *
 * 形状约束（E1 笔记 §C、DECISIONS D15/D17）：
 * - 只用具名导出：`name` / `inject` / `apply`（+ 本文件导出的纯函数接缝），没有 default export。
 * - `inject` 声明三项硬依赖：`agents` / `agentTeams` / `systemPrompt`（LDW-20：宿主 ctx 是 Proxy，
 *   读未注入的服务直接抛；缺服务宁可当场不激活，也不要"少装一半还照常启动"）。
 * - 本包**不注册任何工具**，所以不再需要 `tools` 注入；闸与遮罩用的 `restrict` 落在**别人的**
 *   agent ctx 上，走 `agent.ctx.tools`，与本插件的注入面无关。
 * - 现代码里**不 import 任何 `@deepseek-ai/*`**：本地 `link:` 的 bundle 按自身真实路径解析裸包名，
 *   这类 import 会 `ERR_MODULE_NOT_FOUND`，整行插件直接不激活。
 * - 三个安装器都**只降级、不抛**：任一装不上都不能让另外两个一起消失。
 *
 * @module @local/dsh-redteam-lead
 */
/** 插件名（插件清单/日志用）。 */
export declare const name = "redteam-lead-tools";
/**
 * 硬依赖三项，与宿主自己的团队工具行（`@deepseek-ai/dsh-experimental-tool-agent-team`）同一张表，
 * 只少一个 `tools`（本包不注册工具，见文件头）。
 *
 * LDW-20（2026-11-02 现场）：原来只写 `tools`，另外三个用 `ctx.get` 探针「可选」处理，理由是本
 * Cordis 没有 `inject: { optional }`。但宿主 ctx 是 Proxy —— **读一个没写进 `inject` 的服务直接抛**
 * （`cannot get property "x" without inject`，`cordis/src/reflect.ts`），而当时的探针把这次抛错当成
 * 「服务缺席」：Lead 人设没装上、工兵人设与遮罩没落地、安装时扫不到任何 agent，全部只留一条 warn。
 * 整轮三小时里插件对人设与遮罩的贡献是 0，而 511 个测试全绿（替身写得比宿主宽容）。
 *
 * 现在三项都是硬依赖：拿不到就**当场不激活**，而不是悄悄少装一半。
 * 探针（`guards.serviceOf`）仍然保留：它服务的是**运行时才拿到的 agent.ctx**（工兵自己那份），
 * 以及「直读抛错但 `ctx.get` 能读」这一类形状差异。
 */
export declare const inject: string[];
/**
 * `apply` 的上下文。
 *
 * 只列**核心能力**（`on`/`effect` 是 Cordis 的，不是服务）；服务一律由 `inject` 保证，
 * 安装器内部用 `guards.serviceOf` 取，所以这里不重复声明它们的形状。
 */
interface PluginContext {
    /** 宿主事件总线：角色闸挂 `tools/pre-execute`、遮罩挂 `agent/created`/`agent/status`。 */
    on?: (event: string, listener: (payload: any, next?: any) => unknown, options?: {
        prepend?: boolean;
    }) => unknown;
    /** fiber 所有权：`ctx.effect(generator, label)` 让监听器随插件卸载。 */
    effect?: (install: () => Generator<unknown, void, unknown>, label?: string) => unknown;
}
/**
 * 解析 `config.gatedTools`：本包行实际要挡哪几个工具名。
 *
 * 规则（**只有这四条**，畸形即整份退回默认，不做部分采纳）：
 * 1. 键缺失、或显式写 `undefined` → {@link DEFAULT_GATED_TOOLS}，**不记警告**（这是正常态）；
 * 2. 必须是**非空数组**，且每个元素都是字符串、去掉首尾空白后非空；
 * 3. 每个名字去掉首尾空白，按**首次出现**去重（`['pwsh',' pwsh ']` 只算一个）；
 * 4. 其它一切都是畸形（字符串、空数组、含 `null`/数字/空串的数组、对象、数字…）→ 退回
 *    {@link DEFAULT_GATED_TOOLS}，并记**恰好一条** `ctx.logger.warn`：
 *    「什么都不挡」必须是**有意删掉名字**的结果，不能靠一个空值意外达成 —— 那会让一次手滑
 *    静默地关掉整道闸。
 *
 * 为什么是整份退回、不是「挑出合法元素」：配置只有几行，作者看得见；而被悄悄丢掉的那个名字
 * 会让闸少挡一个入口，且日志里看不出少了谁。退回默认至少是**更严**的方向。
 *
 * @param config 本包行的 `config`（读 `gatedTools`）
 * @param ctx 插件 ctx（诊断走它的 logger）
 * @returns 本次生效的禁表（默认值或配置值）；绝不抛
 */
export declare function resolveGatedTools(config: unknown, ctx?: unknown): ReadonlySet<string>;
/**
 * 解析 `config.gatedReasons`：**按工具定制拒绝理由**。
 *
 * 与 `gatedTools` 的规则故意不同：这里**逐条采纳**，坏条目丢掉、其余照常生效，并记一条警告。
 * 理由只换措辞、不决定挡不挡得住，所以没必要因为一个错字把其它几条好理由一起废掉。
 *
 * - 键或值不是「去掉首尾空白后非空」的字符串 → 丢这一条；
 * - 整个值不是对象 → 全按通用理由，记一条警告（通常是缩进写错）。
 *
 * @param config 本包行的 `config`（读 `gatedReasons`）
 * @param ctx 插件 ctx（诊断走它的 logger）
 * @returns 工具名 → 理由正文；没配或全坏就是 `undefined`。绝不抛。
 */
export declare function resolveGatedReasons(config: unknown, ctx?: unknown): Record<string, string> | undefined;
/**
 * 装上三件事。在 `apply` 里调用，让 fiber 拥有 disposer。
 *
 * 三件事都**只降级、不抛**（各自的安装器内部吞掉一切）：任一件装不上都不能让另外两件消失 ——
 * `apply()` 抛一次等于整行插件不激活。
 *
 * @param ctx Cordis 上下文（需要 `ctx.on` / `ctx.effect`；服务由 `inject` 保证）
 * @param config 本包行的 `config`（读 `gatedTools` / `leadPersona` / `teammatePersona`）
 */
export declare function apply(ctx: PluginContext, config?: Record<string, unknown>): void;
export {};
