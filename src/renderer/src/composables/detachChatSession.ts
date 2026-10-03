/**
 * 把一条对话拎出去成独立窗口（侧边栏拖出、侧边栏右键「在新窗口打开」用）。
 *
 * 窗口开出来之后，主窗口里这条对话的标签一并摘掉：拎出去之后它只在小窗里显示，
 * 留着那个标签点一下也只会把小窗提上来（见 `router/chatWindowGuard.ts`），是个死标签。
 * 顺序是先开窗口、后摘标签 —— 窗口没开成的话标签还在，用户不用去找。
 */

import type { Router } from 'vue-router'

import { chatWindowAPI } from '@renderer/api/chatWindow'
import { isSessionTab } from '@renderer/common/chatRoute'
import { DEFAULT_TAB_KEY, useTabsStore } from '@renderer/store/modules/tabs'

export async function detachChatSession(
  router: Router,
  chatSid: string,
  point?: { screenX: number; screenY: number }
): Promise<boolean> {
  if (!chatSid) return false
  try {
    if (!(await chatWindowAPI.open(chatSid, point))) return false
  } catch (error) {
    console.error('[detachChatSession] 打开独立窗口失败:', error)
    return false
  }

  const tabsStore = useTabsStore()
  for (const tab of [...tabsStore.historyTabs]) {
    if (!isSessionTab(tab.key, chatSid)) continue
    const wasActive = tab.key === tabsStore.activeTab
    const next = tabsStore.removeTab(tab.key)
    if (next) {
      tabsStore.setActiveTab(next)
      await router.push(next).catch(() => undefined)
    } else if (wasActive) {
      await router.push(DEFAULT_TAB_KEY).catch(() => undefined)
    }
  }
  return true
}

/**
 * 拖动松手的位置算不算「拖出了这块区域」：出了窗口，或者离开区域右边缘够远。
 *
 * 要拉开一段距离：用户只是在列表里点住稍微晃了一下，松手不该弹出窗口。
 */
export function isDraggedOutOf(area: DOMRect, event: DragEvent, distance = 48): boolean {
  const { clientX, clientY } = event
  const outsideWindow =
    clientX < 0 || clientY < 0 || clientX > window.innerWidth || clientY > window.innerHeight
  return outsideWindow || clientX > area.right + distance
}
