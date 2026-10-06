import { describe, expect, it } from 'vitest'

import {
  DEFAULT_GOAL_MAX_ROUNDS,
  GOAL_MAX_ROUNDS_MAX,
  GOAL_MAX_ROUNDS_MIN,
  normalizeGoalMaxRounds
} from './goalRounds'

describe('normalizeGoalMaxRounds', () => {
  it('范围内的整数原样用', () => {
    expect(normalizeGoalMaxRounds(25)).toBe(25)
  })

  // 旧配置里没有这一项、配置被手改坏、输入框被清空（v-model.number 给的是空串）
  it('不是数就回默认', () => {
    for (const value of [undefined, null, '', '20', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizeGoalMaxRounds(value), String(value)).toBe(DEFAULT_GOAL_MAX_ROUNDS)
    }
  })

  // 零轮等于不复核；上不封顶等于一次没人看着的长时间烧钱
  it('越界夹回范围，小数取整', () => {
    expect(normalizeGoalMaxRounds(0)).toBe(GOAL_MAX_ROUNDS_MIN)
    expect(normalizeGoalMaxRounds(-3)).toBe(GOAL_MAX_ROUNDS_MIN)
    expect(normalizeGoalMaxRounds(9999)).toBe(GOAL_MAX_ROUNDS_MAX)
    expect(normalizeGoalMaxRounds(12.6)).toBe(13)
  })
})
