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
import { isTeammateRole, liveAgents, logAt, memberRoleOf, ownDisposal } from './gate.js';
import { recordOf, isRecord, serviceOf, thrownMessage } from './guards.js';
/**
 * 宿主 `PERSONA_PREFIX_SECTION` 的字面值。
 *
 * 为什么不是 import：见文件头第 1 条。这里写死的是**行为契约**（同名段才叫覆盖），
 * `test/persona.test.mjs` 逐字钉住它，宿主改名时测试会先炸。
 */
export const PERSONA_SECTION = 'deployment:persona-prefix';
/** 宿主 `PromptSectionOrderName` 里的键名：只用来问顺序，不参与任何拼装。 */
export const PERSONA_ORDER_KEY = 'DEPLOYMENT_PERSONA_PREFIX';
/** 诊断与 effect 的 label（日志里认得出是谁在动手）。 */
export const PERSONA_LABEL = 'redteam-lead/teammate-persona';
/** 监听器自己的 effect label（与逐 agent 的段注册分开：卸载顺序与诊断都要能分辨）。 */
export const PERSONA_INSTALL_LABEL = 'redteam-lead/teammate-persona:install';
/** 宿主建 agent 时广播的事件（与 LDW-15 同一个 seam）。 */
const AGENT_CREATED_EVENT = 'agent/created';
/**
 * 宿主的 agent 状态事件：**每一轮状态切换都会来**（LDW-21）。
 *
 * 只挂 `agent/created` 不够 —— 可续轮的工兵在续轮时会被宿主重建（新 agent 对象、新 scope），
 * created 不会再来一次，于是重建的那份退回共享人设（Lead 那份）。status 每轮都来，
 * 配合按 scope 的去重记号，正好补上这个缺口。
 */
const AGENT_STATUS_EVENT = 'agent/status';
/** 配置项名：工兵人设文本。缺了它就不装（退回共享人设），不静默装一个空段。 */
export const TEAMMATE_PERSONA_KEY = 'teammatePersona';
/**
 * 配置项名：Lead 的人设文本。
 *
 * 它同时是 preset 层的**共享人设**：register 在插件自己的 ctx 上（= preset 作用域），
 * 所以 Lead、以及任何没被单独覆盖的 agent（bare subagent、注册失败的工兵）读到的都是它。
 * 这一份以前写在 `dsh-persona` 行的 `config.prefix` 里；LDW-16 把它搬进本包配置，
 * 让「Lead 人设 / 工兵人设」只有一个可编辑的地方。
 */
export const LEAD_PERSONA_KEY = 'leadPersona';
/** preset 层人设的 effect / 诊断 label。 */
export const PRESET_PERSONA_LABEL = 'redteam-lead/preset-persona';
/** thenable 判定：只认带函数 `then` 的对象（宿主不一定用原生 Promise）。 */
function isThenable(value) {
    return typeof value === 'object' && value !== null && typeof value.then === 'function';
}
/** 取一个非空字符串配置项；空串/空白不算配了（空段在渲染时会被丢掉，等于没配）。 */
export function configTextOf(config, key) {
    const value = recordOf(config)[key];
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
/**
 * 这个 scope 的 `systemPrompt`，且必须同时具备 `section` 与 `getSectionOrder`。
 *
 * LDW-20：读法必须走 {@link serviceOf} —— 直读一个没写进 `inject` 的服务，宿主 Proxy 会抛
 * `cannot get property "systemPrompt" without inject`；原来这里把那次抛错当成「宿主没有这个 API」
 * 直接返回 `undefined`，于是 20:21–23:53 那一整轮 Lead 与工兵**都没有人设**，只留了一条
 * 没人看的 warn。`ctx.get('systemPrompt')` 不经 inject 也能读到同一个服务。
 */
function promptOf(scopeCtx) {
    // 读的是**调用方 ctx 的** systemPrompt：Cordis 把它绑到 shadow ctx 上，所以注册落在
    // 这个 ctx 的 scope 里（service 的方法内部用 `scopeOf(this.ctx)`）。
    const prompt = recordOf(serviceOf(scopeCtx, 'systemPrompt'));
    if (typeof prompt.section !== 'function')
        return undefined;
    if (typeof prompt.getSectionOrder !== 'function')
        return undefined;
    return prompt;
}
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
export function registerPersonaSection(ctx, scopeCtx, text, label = PERSONA_LABEL) {
    const prompt = promptOf(scopeCtx);
    if (prompt === undefined)
        return { kind: 'unavailable' };
    try {
        // order 只认宿主给的值：拿不到数字就按失败处理，绝不猜 0。
        const order = prompt.getSectionOrder.call(prompt, PERSONA_ORDER_KEY);
        if (typeof order !== 'number' || !Number.isFinite(order)) {
            return { kind: 'failed', error: `getSectionOrder("${PERSONA_ORDER_KEY}") 返回了 ${String(order)}` };
        }
        const dispose = prompt.section.call(prompt, {
            name: PERSONA_SECTION,
            order,
            text,
        });
        ownDisposal(ctx, dispose, label);
        return { kind: 'registered' };
    }
    catch (error) {
        return { kind: 'failed', error: thrownMessage(error) };
    }
}
/** 一条人设诊断：写清是哪个 agent、失败在哪、退回了什么。 */
function personaDiagnostic(id, outcome) {
    switch (outcome.kind) {
        case 'registered':
            return `${id} 的人设：已覆盖 ${PERSONA_SECTION}（工兵独立人设）`;
        case 'unavailable':
            return `${id} 的人设：拿不到 agent.ctx.systemPrompt.section —— 继续读共享人设`;
        case 'failed':
            return `${id} 的人设：注册被拒（${outcome.error ?? '未知错误'}）—— 继续读共享人设`;
    }
}
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
export function installPresetPersona(ctx, config) {
    const view = recordOf(ctx);
    const text = configTextOf(config, LEAD_PERSONA_KEY);
    if (text === undefined) {
        logAt(view, PRESET_PERSONA_LABEL, `preset 人设未安装：插件配置缺少非空的 ${LEAD_PERSONA_KEY} —— 全队退回部署级人设（Lead 与工兵会读到同一份）`);
        return false;
    }
    const outcome = registerPersonaSection(view, view, text, PRESET_PERSONA_LABEL);
    if (outcome.kind !== 'registered') {
        logAt(view, PRESET_PERSONA_LABEL, `preset 人设未安装：${presetFailure(outcome)} —— 全队退回部署级人设`);
        return false;
    }
    return true;
}
/** preset 层失败的一句话（与工兵那条分开：这里没有 agent id）。 */
function presetFailure(outcome) {
    switch (outcome.kind) {
        case 'registered':
            return '已注册';
        case 'unavailable':
            return '拿不到 ctx.systemPrompt.section';
        case 'failed':
            return `注册被拒（${outcome.error ?? '未知错误'}）`;
    }
}
/**
 * LDW-16 的安装入口：给每个**非 Lead 的团队成员**在自己 ctx 上注册工兵人设。
 *
 * 与 LDW-15 同一条 seam，理由相同：工兵通常在建人之后才出现（`agent/created`），但插件也可能
 * 在会话中途挂上（HMR / preset 重载），那时已有的工兵必须一并处理（安装时扫一遍 `ctx.agents.list()`）。
 *
 * 返回「监听器有没有装上」；`apply()` 不消费它 —— 人设装不上不能影响工具注册与角色闸。
 */
export function installTeammatePersona(ctx, config) {
    const view = recordOf(ctx);
    const text = configTextOf(config, TEAMMATE_PERSONA_KEY);
    if (text === undefined) {
        logAt(view, PERSONA_LABEL, `工兵人设未安装：插件配置缺少非空的 ${TEAMMATE_PERSONA_KEY} —— 工兵继续读共享人设（Lead 那份）`);
        return false;
    }
    const on = view.on;
    if (typeof on !== 'function') {
        logAt(view, PERSONA_LABEL, '工兵人设未安装：宿主上下文缺少 ctx.on —— 之后新建的工兵读共享人设');
        return false;
    }
    // 每 **scope** 只注册一次：同名同层第二次注册，宿主会抛 "already registered in this scope"。
    // 键必须是 `agent.ctx` 而不是 agent id —— 可续轮的工兵在下一轮会被宿主**重建**（同一个
    // session id、同一个成员 id，但新的 agent 对象与新 scope）。按 id 去重会让续轮那次退回共享
    // 人设（2026-11-03 现场：turn 1 = 11,055 字工兵人设；turn 2 = 11,522 字 Lead 人设）。
    const handled = new WeakSet();
    const registerNow = (agent, role) => {
        if (!isTeammateRole(role))
            return;
        const id = recordOf(agent).id;
        if (typeof id !== 'string' || id.length === 0)
            return;
        const scope = recordOf(agent).ctx;
        if (!isRecord(scope))
            return;
        if (handled.has(scope))
            return;
        handled.add(scope);
        try {
            const outcome = registerPersonaSection(view, scope, text);
            // 成功不吭声：一二十个工兵，日志留给失败的那几个人。
            if (outcome.kind !== 'registered')
                logAt(view, PERSONA_LABEL, personaDiagnostic(id, outcome));
        }
        catch {
            // 人设是增强：任何意外都不许穿过这里（apply() 不能因此不激活）。
        }
    };
    const maybeRegister = (agent) => {
        try {
            const role = memberRoleOf(view, agent);
            if (isThenable(role)) {
                void Promise.resolve(role).then((resolved) => registerNow(agent, resolved), () => {
                    // 身份判不出来就不动（fail-open：退回共享人设）。
                });
                return;
            }
            registerNow(agent, role);
        }
        catch {
            // 同步探针炸了也不许打断建人流程。
        }
    };
    for (const agent of liveAgents(view))
        maybeRegister(agent);
    const listener = (payload) => {
        maybeRegister(recordOf(payload).agent);
    };
    const effect = view.effect;
    if (typeof effect === 'function') {
        try {
            effect.call(view, function* installTeammatePersonaSeam() {
                yield on.call(view, AGENT_CREATED_EVENT, listener);
                // LDW-21：续轮重建的工兵只有 status，没有 created。
                yield on.call(view, AGENT_STATUS_EVENT, listener);
            }, PERSONA_INSTALL_LABEL);
            return true;
        }
        catch {
            // effect 登记失败：退回直接挂监听器（人设照常生效，只是不随 fiber 摘除）。
        }
    }
    try {
        on.call(view, AGENT_CREATED_EVENT, listener);
        on.call(view, AGENT_STATUS_EVENT, listener);
    }
    catch {
        logAt(view, PERSONA_LABEL, '工兵人设未安装：ctx.on 拒绝登记 agent/created 监听器 —— 工兵继续读共享人设');
        return false;
    }
    logAt(view, PERSONA_LABEL, '工兵人设没有 fiber 所有权：宿主上下文缺少 ctx.effect —— 照常生效，监听器不随插件卸载摘除');
    return true;
}
