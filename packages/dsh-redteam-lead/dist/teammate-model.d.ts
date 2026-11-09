/**
 * 工兵的固定路由（2026-11-09）。
 *
 * 为什么需要这一层：子 agent **创建时继承 Lead 那一刻的路由**。`spawn_teammate` 的请求里没有
 * model 字段，团队服务 `startActivation` 也不传 `agentOptions`，于是 `dsh-subagent` 的
 * `resolveChildAgentOptions(parent, undefined, depth)` 从父的 `requestHeader().config` 里取
 * provider / model / reasoningEffort。想「Lead 用贵的、工兵用便宜的」，过去只能在每次 spawn 前
 * 手动把 Lead 切过去、spawn 完再切回来 —— 忘一次就漏一个工兵。
 *
 * 这里把工兵那条**钉死**：非 root 成员建出来后替它 `agent.model.select(...)` 一次。
 *
 * 三条形状约束：
 * 1. **`Agent.model` 是公开属性**（`readonly model: Model`，`Model.select(selection): void`）。
 *    `select()` 同步、无业务异常，内容相同直接 return，不同则往该 agent 自己的会话日志里
 *    append 一条 `model/selection` —— 所以这是**持久、可审计**的选择，不是内存里的临时补丁。
 * 2. **只碰非 root 的团队成员**（{@link isTeammateRole}）：Lead 一个字节都不动，它自己选什么模型
 *    完全不受影响。
 * 3. **按 `agent.ctx` 去重**：同一 scope 只钉一次；成员被宿主重建时是新 scope，会再钉一次 ——
 *    这正是「固定」的语义（手工改只活到下一次重建）。
 *
 * 与其它安装器一样**只降级、不抛**：路由是增强，装不上就一条 warn，绝不能让角色闸、
 * 两套人设和工兵遮罩跟着一起消失。
 *
 * @module @local/dsh-redteam-lead/teammate-model
 */
/** 配置键：工兵固定使用的路由。缺了它就不钉（工兵继续继承 Lead 的路由）。 */
export declare const TEAMMATE_MODEL_KEY = "teammateModel";
/** 诊断与 effect 的 label。 */
export declare const TEAMMATE_MODEL_LABEL = "redteam-lead/teammate-model";
/** 监听器自己的 effect label（与逐 agent 的 select 分开：卸载顺序与诊断都要能分辨）。 */
export declare const TEAMMATE_MODEL_INSTALL_LABEL = "redteam-lead/teammate-model:install";
/** 一条路由：与宿主 `ModelSelection` 同形，但本包不认识它的类型（不能 import `@deepseek-ai/*`）。 */
export interface TeammateModelSelection {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
/** 形状解析结果：要么给出路由，要么给出一句「哪里不对」。 */
type Parsed = {
    selection: TeammateModelSelection;
} | {
    problem: string;
};
/**
 * 纯形状解析：`provider` 与 `model` 必须是非空字符串，`reasoningEffort` 给了也必须非空。
 *
 * 不在这里记日志：{@link resolveTeammateModel} 才持有 ctx，纯函数更好测。
 */
export declare function selectionOf(value: unknown): Parsed;
/**
 * 解析 `config.teammateModel`：本次要钉给工兵的那条路由。
 *
 * 缺键 → `undefined`（**不记警告**：这是「不钉」的正常态，工兵回到宿主默认的继承行为）；
 * 形状畸形 → 一条 `ctx.logger.warn` + `undefined`，绝不退回任何猜出来的默认模型。
 *
 * 为什么畸形不猜一个默认：钉错模型不是「少一层增强」，而是让每个工兵在第一次请求时失败。
 * 宁可不钉、留在继承行为上，也不要拿一条没人配过的路由去跑。
 *
 * @param config 本包行的 `config`（读 `teammateModel`）
 * @param ctx 插件 ctx（诊断走它的 logger）
 * @returns 本次生效的路由；没配或配坏了就是 `undefined`。绝不抛。
 */
export declare function resolveTeammateModel(config: unknown, ctx?: unknown): TeammateModelSelection | undefined;
/**
 * 给一个 agent 的模型选择面下一次 `select`。
 *
 * @param modelOwner 一个持有 `model` 的对象（实际传 agent）
 * @param selection 要钉的路由（复制一份再传，宿主可能保留引用）
 * @returns `undefined` = 钉成功；否则是一句「为什么没钉上」的诊断文本。绝不抛。
 */
export declare function selectRoute(modelOwner: unknown, selection: TeammateModelSelection): string | undefined;
/**
 * 安装入口：给每个**非 Lead 的团队成员**钉住路由。
 *
 * 与遮罩、人设同一条 seam：建人之后才出现的成员走 `agent/created`；插件也可能在会话中途挂上
 * （HMR / preset 重载），那时已有的成员必须一并处理（安装时扫一遍 `ctx.agents.list()`）。
 * `agent/status` 也挂，因为可续轮的成员在续轮时会被宿主**重建**（同一个 id、新的 agent 对象与
 * 新 scope），那时需要在新 scope 上再钉一次。
 *
 * 返回「监听器有没有装上」；`apply()` 不消费它 —— 路由钉不上不能影响角色闸与人设。
 *
 * @param ctx 本插件的 ctx
 * @param config 本包行配置（读 `teammateModel`）
 */
export declare function installTeammateModel(ctx: unknown, config: unknown): boolean;
export {};
