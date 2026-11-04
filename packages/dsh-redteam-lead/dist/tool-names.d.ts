/**
 * `tools.schemas(scope)` 的返回值 → 完整工具名集合（去重、排序）。
 *
 * 宿主真实形状是**schema 对象数组**（`_dsh-tools.js` 的 `schemas(scope)` 对每个可见定义
 * 调 `schemaOf()`，名字在元素的 `.name` 上）。旧实现对这个返回值做 `Object.keys()`，
 * 数组上只会得到 `["0","1",…]`，于是「可遮名单」永远为空、遮罩整块不落地（T15 的真会话事故）。
 * 因此规则是「先按条目取名字，再谈容器」：
 *
 * 1. 值本身就是一个条目（`{name}` / `{function:{name}}`，即单个 schema）→ 单个名字；
 * 2. 数组 → 逐个元素取 `.name`（**绝不** `Object.keys` 数组）；
 * 3. 任意可迭代（`Set`/generator…）→ 逐项取 `.name`；
 * 4. 按名字为键的对象（测试替身与旧形状）→ 键；
 * 5. 其余（null/数字/字符串/没有名字的条目）→ 空集：保持「未核对」降级语义，**不抛**。
 *
 * @param schemas `tools.schemas(scope)` 的原始返回值（未知形状）
 * @returns 去重并排序的完整工具名
 */
export declare function toolNamesFromSchemas(schemas: unknown): string[];
