/**
 * 目标模式（`/goal`）最多迭代几轮。用户在「设置 → AI」里改。
 *
 * 主进程（读设置、喂给 `createGoalLoop`）和设置页（输入框的上下限）共用一份 ——
 * 两边各写一份的话，界面上填得进 80，主进程悄悄按 50 跑，用户不会知道。
 */

/** 默认值。到顶就停下来交人，不是失败 —— 是「我尽力了」 */
export const DEFAULT_GOAL_MAX_ROUNDS = 10

/**
 * 下限 1：零轮等于不复核，那就不是目标模式了 —— 不想要就别敲 `/goal`。
 * 上限 50：每一轮都是干活加一次复核，复核还可能编译、跑 PIE。再往上不是更有耐心，
 * 是一次没人看着的长时间烧钱。
 */
export const GOAL_MAX_ROUNDS_MIN = 1
export const GOAL_MAX_ROUNDS_MAX = 50

/** 不是数就回默认；是数就取整、夹进范围。旧配置里没有这一项，走的也是默认 */
export function normalizeGoalMaxRounds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_GOAL_MAX_ROUNDS
  return Math.min(GOAL_MAX_ROUNDS_MAX, Math.max(GOAL_MAX_ROUNDS_MIN, Math.round(value)))
}
