import { describe, expect, it, vi } from 'vitest'
import { forgetSteerDraft, rememberSteerDraft, takeSteerDraft } from './steerDrafts'

describe('steerDrafts', () => {
  // 取一次就没了：同一条撤回两次不能往输入框里放两遍
  it('按号取出放回办法，只取得到一次', () => {
    const restore = vi.fn()
    rememberSteerDraft('a', restore)

    expect(takeSteerDraft('a')).toBe(restore)
    expect(takeSteerDraft('a')).toBeUndefined()
  })

  // 生效了就撤不回来，攥着附件没用
  it('生效后放掉', () => {
    rememberSteerDraft('b', vi.fn())
    forgetSteerDraft('b')

    expect(takeSteerDraft('b')).toBeUndefined()
  })

  // 一轮里插了很多次、一次都没撤时，不能一直攥着所有附件
  it('超过上限时先放掉最早的', () => {
    for (let i = 0; i < 21; i++) rememberSteerDraft(`c${i}`, vi.fn())

    expect(takeSteerDraft('c0')).toBeUndefined()
    expect(takeSteerDraft('c20')).toBeDefined()
  })
})
