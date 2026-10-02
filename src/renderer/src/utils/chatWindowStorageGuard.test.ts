import { beforeEach, describe, expect, it } from 'vitest'

import { guardPersistForChatWindow, readOnlyStorage } from './chatWindowStorageGuard'

describe('chatWindowStorageGuard', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('只读包装：读得到，写不进去', () => {
    localStorage.setItem('tabs-store', '{"a":1}')
    const storage = readOnlyStorage(localStorage)
    expect(storage.getItem('tabs-store')).toBe('{"a":1}')
    storage.setItem('tabs-store', '{"b":2}')
    storage.removeItem('tabs-store')
    expect(localStorage.getItem('tabs-store')).toBe('{"a":1}')
  })

  it('落到 localStorage 的持久化换成只读的，包括没写 storage 的缺省情况', () => {
    const explicit = { persist: { key: 'tabs-store', storage: localStorage } }
    const implicit = { persist: true as const }
    const list = { persist: [{ key: 'a' }, { key: 'b', storage: localStorage }] }
    for (const options of [explicit, implicit, list]) {
      guardPersistForChatWindow(options as never)
    }

    localStorage.setItem('tabs-store', 'keep')
    ;(explicit.persist.storage as Storage).setItem('tabs-store', 'overwritten')
    expect(localStorage.getItem('tabs-store')).toBe('keep')
    expect((implicit.persist as unknown as { storage: Storage }).storage).not.toBe(localStorage)
    for (const entry of list.persist as Array<{ storage: Storage }>) {
      expect(entry.storage).not.toBe(localStorage)
    }
  })

  it('别的后端（磁盘上的对话历史）不动', () => {
    const disk = { getItem: () => null, setItem: () => {} }
    const options = { persist: { key: 'chat-sessions', storage: disk } }
    guardPersistForChatWindow(options as never)
    expect(options.persist.storage).toBe(disk)
  })
})
