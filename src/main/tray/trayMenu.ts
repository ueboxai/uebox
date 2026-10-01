/**
 * 托盘菜单的纯模板：进来一份状态 + 一组回调，出去一份
 * `Menu.buildFromTemplate` 能直接吃的数组。
 *
 * 只引类型不引实现，是为了能在 vitest 里直接跑 ——  Electron 的 Menu 只是
 * 消费这份模板的那一层（`trayController.ts`），不该混进来。
 */
import type { MenuItemConstructorOptions } from 'electron'

import type { TrayRecentSession } from '../../shared/trayActions'
import type { MainTranslator } from '../i18n'

export interface TrayMenuState {
  recentSessions: TrayRecentSession[]
}

export interface TrayMenuHandlers {
  openMainWindow: () => void
  newSession: () => void
  openSession: (sessionId: string) => void
  quit: () => void
}

/** 菜单项标签最多这么长，再长截断补省略号 —— 会话标题可以起得很长 */
const MAX_LABEL_LENGTH = 30

/**
 * 动态标签先截断、再转义 `&`。
 *
 * Windows 菜单把 `&` 当成助记符前缀（`&File` 画出带下划线的 F），会话标题里
 * 带 `&` 会被吃掉一个字母。要先截断再转义：反过来截的话可能正好把一个
 * `&&` 劈开，剩下半个转义照样变助记符。
 */
function menuLabel(raw: string): string {
  // Array.from 按码点切：emoji 这类代理对算一个字符 —— 按码元 slice 的话
  // 边界正好劈在代理对中间，菜单里画出一个 �
  const chars = Array.from(raw)
  const truncated =
    chars.length > MAX_LABEL_LENGTH ? `${chars.slice(0, MAX_LABEL_LENGTH).join('')}…` : raw
  return truncated.replace(/&/g, '&&')
}

/**
 * 拼托盘菜单。顺序：
 *
 *   新对话
 *   ───（有最近对话时）
 *   最近对话 + 条目
 *   ───
 *   打开虚幻盒子 / 退出
 *
 * 「打开虚幻盒子」和「退出」两个应用级动作沉在最底下是一组的：Windows 托盘
 * 菜单从图标向上弹出、底边贴着光标，上面那组列表条目数会变，只有最底下
 * 这组位置恒定，用户抬手就能点到。
 *
 * 空分组整组省略 —— 包括它的标题和分隔线：菜单没有内容时挂着一句
 * 「最近对话」再加个灰掉的空档，比不显示更费解。分隔线只出现在
 * 有内容的两个块之间，绝不出现在菜单头上、尾巴上，也不会连出两条。
 */
export function buildTrayMenuTemplate(
  state: TrayMenuState,
  handlers: TrayMenuHandlers,
  t: MainTranslator
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [
    { label: t('tray.newChat'), click: () => handlers.newSession() }
  ]

  if (state.recentSessions.length > 0) {
    items.push(
      { type: 'separator' },
      { label: t('tray.recentChats'), enabled: false },
      ...state.recentSessions.map(
        (session): MenuItemConstructorOptions => ({
          label: menuLabel(session.title),
          click: () => handlers.openSession(session.id)
        })
      )
    )
  }

  // 应用级动作沉底、共用一条分隔线 —— 上面那组注释解释了为什么钉在底下
  items.push(
    { type: 'separator' },
    { label: t('tray.open'), click: () => handlers.openMainWindow() },
    { label: t('tray.quit'), click: () => handlers.quit() }
  )

  return items
}
