/**
 * 托盘菜单的生命周期。
 *
 * 右键事件各平台行为不一致（macOS 的托盘菜单是系统自己弹的），所以菜单
 * 常驻在 `setContextMenu` 上，靠两路信号做防抖重建：界面报上来的最近会话
 * 变了、语言变了。
 *
 * ## 点了菜单项之后
 *
 * 菜单项本身只会把主窗口叫到前台、把动作存进 `pending`，再发一句不带
 * 负载的 `tray:action` 提醒 —— 界面走 `tray:take-pending` 取走本体
 * （取走即清）再处理，这是唯一的送达路径。跳到那条会话、开新对话是
 * 界面的事（`layout/composables/trayBridge.ts`）。
 */
import { app, ipcMain, Menu, Tray } from 'electron'

import {
  TRAY_ACTION_CHANNEL,
  TRAY_PENDING_TTL_MS,
  TRAY_SET_RECENT_SESSIONS_CHANNEL,
  TRAY_TAKE_PENDING_CHANNEL,
  type TrayAction,
  type TrayRecentSession
} from '../../shared/trayActions'
import { findMainWindow, sendToWindow } from '../appWindows'
import { mt, onLanguageChanged } from '../i18n'
import { logger } from '../services'

import { createPendingSlot } from './pendingSlot'
import { sanitizeTrayRecentSessions } from './recentSessions'
import { buildTrayMenuTemplate } from './trayMenu'

export interface TrayControllerDeps {
  /**
   * 托盘「打开虚幻盒子」和非 darwin 左键共用的那个动作，含「窗口没了就地重建」
   * —— `createWindow` 是 index.ts 的局部函数，反向 import 会绕成环，只能注入
   */
  showMainWindow: () => void
}

/** 菜单重建做 200ms 防抖 —— 会话上报是一串一串来的 */
const REBUILD_DEBOUNCE_MS = 200

/** 把托盘菜单挂到 `tray` 上。只调一次（托盘本来就只建一次）。 */
export function startTrayMenuController(tray: Tray, deps: TrayControllerDeps): void {
  /** 界面最近一次报上来的「最近对话」前三条 */
  let recentSessions: TrayRecentSession[] = []

  /** 还没送到界面手里的那条托盘动作。取走即清，理由见文件头 */
  const pendingSlot = createPendingSlot<TrayAction>({ ttlMs: TRAY_PENDING_TTL_MS })

  /*
   * 把一条动作送到界面：先把主窗口叫到前台，再存一份、发一句「来拿」。
   * 提醒是投出去就不管的，渲染进程没挂好就蒸发；存着的那份由界面收到
   * 提醒 / 挂上来时走 `tray:take-pending` 取走，取走即清。
   */
  function sendTrayAction(action: TrayAction): void {
    deps.showMainWindow()
    pendingSlot.put(action)
    // sendToWindow 查的是窗口 + webContents 两个销毁标记：关窗过程中
    // webContents 先死、窗口还活着，单查窗口标记 send 照样抛（见 appWindows.ts）
    sendToWindow(findMainWindow(), TRAY_ACTION_CHANNEL)
  }

  let rebuildTimer: NodeJS.Timeout | null = null
  const scheduleRebuild = (): void => {
    if (rebuildTimer) clearTimeout(rebuildTimer)
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null
      rebuildMenu()
    }, REBUILD_DEBOUNCE_MS)
  }
  const rebuildMenu = (): void => {
    try {
      tray.setContextMenu(buildMenu())
    } catch (error) {
      logger.warn('[托盘] 重建菜单失败:', error)
    }
  }

  const handlers = {
    openMainWindow: () => deps.showMainWindow(),
    newSession: () => sendTrayAction({ type: 'new-session' }),
    openSession: (sessionId: string) => sendTrayAction({ type: 'open-session', sessionId }),
    // __forceQuit__ 不用在这里置：app.quit() 先触发 before-quit，
    // index.ts 的处理器在那里已经把它设上了
    quit: () => app.quit()
  }

  const buildMenu = (): Menu =>
    Menu.buildFromTemplate(buildTrayMenuTemplate({ recentSessions }, handlers, mt))

  // 悬停提示和菜单一样是一次性交给操作系统的，语言变了要重设
  tray.setToolTip(mt('tray.tooltip'))
  rebuildMenu()

  onLanguageChanged(() => {
    tray.setToolTip(mt('tray.tooltip'))
    scheduleRebuild()
  })

  // 界面报「最近对话」变了
  ipcMain.handle(TRAY_SET_RECENT_SESSIONS_CHANNEL, (_event, payload: unknown) => {
    recentSessions = sanitizeTrayRecentSessions(payload)
    scheduleRebuild()
    return { success: true }
  })

  /*
   * 唯一的送达路径：取走即清。`tray:action` 提醒和挂载补取可能各来
   * 一次，主进程串行处理 handle，第二次取到的是 null。
   */
  ipcMain.handle(TRAY_TAKE_PENDING_CHANNEL, () => pendingSlot.take())
}
