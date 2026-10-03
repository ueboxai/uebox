import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const open = vi.fn()
vi.mock('@renderer/api/chatWindow', () => ({
  chatWindowAPI: { open: (...a: unknown[]) => open(...a) }
}))

import { useTabsStore } from '@renderer/store/modules/tabs'
import { detachChatSession, isDraggedOutOf } from './detachChatSession'

const area = { right: 240 } as DOMRect
const drag = (clientX: number, clientY = 300): DragEvent => ({ clientX, clientY }) as DragEvent

describe('isDraggedOutOf', () => {
  it('拖到右边内容区够远、或者拖出窗口：算拖出去', () => {
    expect(isDraggedOutOf(area, drag(400))).toBe(true)
    expect(isDraggedOutOf(area, drag(-5))).toBe(true)
  })

  it('在列表里晃一下就松手：不算', () => {
    expect(isDraggedOutOf(area, drag(200))).toBe(false)
    expect(isDraggedOutOf(area, drag(270))).toBe(false)
  })
})

describe('detachChatSession', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    open.mockReset()
  })

  it('窗口开出来之后摘掉这条对话的标签，正开着的话切到别的标签', async () => {
    open.mockResolvedValue(true)
    const tabs = useTabsStore()
    tabs.historyTabs = [
      { key: '/', title: 'home', path: '/', sort: 1, isCanDelete: true },
      {
        key: '/dev-assistant?sid=s1',
        title: 'chat',
        path: '/dev-assistant?sid=s1',
        sort: 2,
        isCanDelete: true
      }
    ]
    tabs.setActiveTab('/')
    tabs.setActiveTab('/dev-assistant?sid=s1')
    const router = { push: vi.fn(async () => undefined) }

    expect(await detachChatSession(router as never, 's1')).toBe(true)
    expect(tabs.historyTabs.map((tab) => tab.key)).toEqual(['/'])
    expect(router.push).toHaveBeenCalledWith('/')
  })

  it('窗口没开成：标签留着', async () => {
    open.mockResolvedValue(false)
    const tabs = useTabsStore()
    tabs.historyTabs = [
      {
        key: '/dev-assistant?sid=s1',
        title: 'chat',
        path: '/dev-assistant?sid=s1',
        sort: 1,
        isCanDelete: true
      }
    ]
    const router = { push: vi.fn() }
    expect(await detachChatSession(router as never, 's1')).toBe(false)
    expect(tabs.historyTabs).toHaveLength(1)
  })
})
