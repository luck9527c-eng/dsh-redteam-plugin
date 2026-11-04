/**
 * LDW-16：工兵独立人设。
 *
 * 现场（[`docs/specs/team-v2-simplify.md`](../../../docs/specs/team-v2-simplify.md) §起因 3）：
 * 工兵继承 Lead 的 preset，也就继承了 `dsh-persona` 那一段 —— 两边系统提示词一字不差，人设里
 * 那句「你是技术决策者」直接把工兵说成了指挥。修法不是改文案（改文案治不了「两个角色读同一份」），
 * 而是在**工兵自己的 ctx** 上注册同名段，把 preset 那份盖掉。
 *
 * 本模块提供两半，合起来才是「两套人设」：
 * - {@link installPresetPersona}：在**本插件自己的 ctx**（= preset 作用域）注册 Lead 那份
 *   （配置 `leadPersona`）。这以前是 preset 里 `@deepseek-ai/dsh-persona` 行的活；那一行已经删掉，
 *   否则两处会注册同一个段名（同层重复注册直接抛）。
 * - {@link installTeammatePersona}：给每个非 Lead 的团队成员在**它自己的 agent ctx** 上注册
 *   一份同名的（配置 `teammatePersona`）。scoped 段遮蔽 preset 那份，只影响它自己。
 *
 * 三个硬约束，都有出处：
 * 1. **段名写死成字符串**。本包不能 import 任何 `@deepseek-ai/*`：本地 `link:` 安装的 bundle 按
 *    自身真实路径解析裸包名，这类 import 会 `ERR_MODULE_NOT_FOUND`，整行插件直接不激活
 *    （`src/index.ts` 顶部同一条规矩，`test/bundle.test.mjs` 有全包扫描钉着）。
 * 2. **order 必须向宿主问**：`agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')`。
 *    宿主的分配表会漂移，硬编码 `0` 在下次调整后就会把这段排到别处。
 * 3. **失败不静默、也不拖垮 `apply()`**：取不到 section API 或注册抛错 → 一条 `ctx.logger.warn`
 *    + 退回共享人设（preset 那份照旧生效，工兵至少还有一套人设）。`apply()` 抛一次等于整行插件
 *    不激活，角色闸与工兵遮罩一起消失 —— 那比人设不对更糟。
 *
 * 覆盖只发生在**非 Lead 的团队成员**身上：Lead 读共享人设；bare subagent 不在团队里，不归这里管。
 *
 * @module @local/dsh-redteam-lead/persona
 */
/**
 * 宿主 `PERSONA_PREFIX_SECTION` 的字面值。
 *
 * 为什么不是 import：见文件头第 1 条。这里写死的是**行为契约**（同名段才叫覆盖），
 * `test/persona.test.mjs` 逐字钉住它，宿主改名时测试会先炸。
 */
export declare const PERSONA_SECTION = "deployment:persona-prefix";
/** 宿主 `PromptSectionOrderName` 里的键名：只用来问顺序，不参与任何拼装。 */
export declare const PERSONA_ORDER_KEY = "DEPLOYMENT_PERSONA_PREFIX";
/** 诊断与 effect 的 label（日志里认得出是谁在动手）。 */
export declare const PERSONA_LABEL = "redteam-lead/teammate-persona";
/** 监听器自己的 effect label（与逐 agent 的段注册分开：卸载顺序与诊断都要能分辨）。 */
export declare const PERSONA_INSTALL_LABEL = "redteam-lead/teammate-persona:install";
/** 配置项名：工兵人设文本。缺了它就不装（退回共享人设），不静默装一个空段。 */
export declare const TEAMMATE_PERSONA_KEY = "teammatePersona";
/**
 * 配置项名：Lead 的人设文本。
 *
 * 它同时是 preset 层的**共享人设**：register 在插件自己的 ctx 上（= preset 作用域），
 * 所以 Lead、以及任何没被单独覆盖的 agent（bare subagent、注册失败的工兵）读到的都是它。
 * 这一份以前写在 `dsh-persona` 行的 `config.prefix` 里；LDW-16 把它搬进本包配置，
 * 让「Lead 人设 / 工兵人设」只有一个可编辑的地方。
 */
export declare const LEAD_PERSONA_KEY = "leadPersona";
/** preset 层人设的 effect / 诊断 label。 */
export declare const PRESET_PERSONA_LABEL = "redteam-lead/preset-persona";
/** 一次人设注册的结果（只喂诊断；注册成不成功都不影响工具面）。 */
export interface PersonaOutcome {
    /** `unavailable` = 这个 agent 没有可用的 `systemPrompt.section`。 */
    kind: 'registered' | 'unavailable' | 'failed';
    /** `kind: 'failed'`：宿主抛出的原文（同名同层再注册会在这里出名字）。 */
    error?: string;
}
/** 取一个非空字符串配置项；空串/空白不算配了（空段在渲染时会被丢掉，等于没配）。 */
export declare function configTextOf(config: unknown, key: string): string | undefined;
/**
 * 在一个 **scoped ctx**（agent 自己的 ctx，或本插件所在的 preset ctx）上注册人设段：
 * 同名、同 order 槽位，覆盖该 scope 能看到的那一份。
 *
 * 绝不抛：拿不到 API 返回 `unavailable`，宿主拒绝返回 `failed`（带原文）。调用方负责记日志。
 *
 * @param ctx 本插件的 ctx（disposer 归它，插件卸载时把这个段收回去）
 * @param scopeCtx 段落落在哪个 ctx 的 scope 上（agent 的 ctx / 插件自己的 ctx）
 * @param text 人设文本（配置原样，一个字都不改）
 * @param label disposer 的 fiber label
 */
export declare function registerPersonaSection(ctx: unknown, scopeCtx: unknown, text: string, label?: string): PersonaOutcome;
/**
 * preset 层的人设：**Lead 读这一份**，它同时也是全队的共享兜底。
 *
 * 为什么由本插件在**自己的 ctx** 上注册：这个 ctx 就是 preset 组合树的 ctx，注册落在 preset
 * 作用域 —— 以前 `dsh-persona` 行做的正是这件事。搬过来之后，「Lead 人设」与「工兵人设」
 * 只有一个来源（本行配置的 `leadPersona` / `teammatePersona`），操作者不必在两处各改一遍。
 *
 * 工兵随后在自己的 agent ctx 上盖同名段（{@link installTeammatePersona}）：scoped 段遮蔽
 * preset 那份，只影响它自己。注册失败时它退回的「共享人设」就是这里注册的这一份。
 *
 * @param ctx 本插件的 ctx（= preset 作用域）
 * @param config 本包行配置（读 `leadPersona`）
 * @returns 是否注册成功（`apply()` 不消费：人设装不上不能影响工具与角色闸）
 */
export declare function installPresetPersona(ctx: unknown, config: unknown): boolean;
/**
 * LDW-16 的安装入口：给每个**非 Lead 的团队成员**在自己 ctx 上注册工兵人设。
 *
 * 与 LDW-15 同一条 seam，理由相同：工兵通常在建人之后才出现（`agent/created`），但插件也可能
 * 在会话中途挂上（HMR / preset 重载），那时已有的工兵必须一并处理（安装时扫一遍 `ctx.agents.list()`）。
 *
 * 返回「监听器有没有装上」；`apply()` 不消费它 —— 人设装不上不能影响工具注册与角色闸。
 */
export declare function installTeammatePersona(ctx: unknown, config: unknown): boolean;
