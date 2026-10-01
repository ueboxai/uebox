/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

import { buildTrayMenuTemplate, type TrayMenuHandlers, type TrayMenuState } from './trayMenu'

/**
 * 托盘菜单的结构是纯函数产物，这块要守的几件事：
 * - 顺序固定：新对话 / 最近对话 / 打开 / 退出（应用级动作沉底）
 * - 空分组整组省略，绝不挂出多余分隔线
 * - 动态标签截断到 30 字，`&` 转义成 `&&`（Windows 会把它当助记符）
 */

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}(${Object.values(params).join(',')})` : key

function handlers(): TrayMenuHandlers {
  return {
    openMainWindow: vi.fn(),
    newSession: vi.fn(),
    openSession: vi.fn(),
    quit: vi.fn()
  }
}

function state(partial: Partial<TrayMenuState> = {}): TrayMenuState {
  return { recentSessions: [], ...partial }
}

const labels = (items: ReturnType<typeof buildTrayMenuTemplate>): Array<string | undefined> =>
  items.map((item): string | undefined => (item.type === 'separator' ? '---' : item.label))

describe('托盘菜单模板', () => {
  it('完整顺序：新对话 / 最近对话 / 打开 / 退出', () => {
    const items = buildTrayMenuTemplate(
      state({
        recentSessions: [{ id: 's1', title: '会话一' }]
      }),
      handlers(),
      t
    )

    expect(labels(items)).toEqual([
      'tray.newChat',
      '---',
      'tray.recentChats',
      '会话一',
      '---',
      'tray.open',
      'tray.quit'
    ])
  })

  it('分组标题是灰的，只是个标记不让点', () => {
    const items = buildTrayMenuTemplate(
      state({
        recentSessions: [{ id: 's1', title: 'a' }]
      }),
      handlers(),
      t
    )

    const headers = items.filter((item) => item.label === 'tray.recentChats')
    expect(headers).toHaveLength(1)
    expect(headers.every((item) => item.enabled === false)).toBe(true)
  })

  it('没有最近会话：新对话 + 沉底的打开/退出和一条分隔线', () => {
    const items = buildTrayMenuTemplate(state(), handlers(), t)

    expect(labels(items)).toEqual(['tray.newChat', '---', 'tray.open', 'tray.quit'])
  })

  it('标签超过 30 字截断补省略号', () => {
    const long = 'x'.repeat(40)
    const items = buildTrayMenuTemplate(
      state({ recentSessions: [{ id: 's1', title: long }] }),
      handlers(),
      t
    )

    expect(items[3].label).toBe(`${'x'.repeat(30)}…`)
  })

  it('标签里的 & 转义成 &&，不然 Windows 把它吃成助记符', () => {
    const items = buildTrayMenuTemplate(
      state({ recentSessions: [{ id: 's1', title: 'R&D' }] }),
      handlers(),
      t
    )

    expect(items[3].label).toBe('R&&D')
  })

  it('截断发生在转义之前：末尾的 && 不会被劈成半个转义', () => {
    // 第 30 个字符正好是 &：截断后它在第 30 位，转义成 && 后不会被切成孤 &
    const title = `${'x'.repeat(29)}&more`
    const items = buildTrayMenuTemplate(
      state({ recentSessions: [{ id: 's1', title }] }),
      handlers(),
      t
    )

    expect(items[3].label).toBe(`${'x'.repeat(29)}&&…`)
  })

  it('截断按码点不按码元：emoji 不会被劈成半个代理对', () => {
    // 29 个字符 + 一个 emoji 正好占满 30 个字符位 —— 按码元切会只留 emoji 的上半个代理
    const title = `${'x'.repeat(29)}🚀tail`
    const items = buildTrayMenuTemplate(
      state({ recentSessions: [{ id: 's1', title }] }),
      handlers(),
      t
    )

    expect(items[3].label).toBe(`${'x'.repeat(29)}🚀…`)
  })

  it('点会话项把它的 id 传回去', () => {
    const h = handlers()
    const items = buildTrayMenuTemplate(
      state({ recentSessions: [{ id: 'sid-42', title: 'a' }] }),
      h,
      t
    )

    const entry = items[3]
    // @ts-expect-error 菜单项 click 是 Electron 的签名，测试直接调
    entry.click()
    expect(h.openSession).toHaveBeenCalledWith('sid-42')
  })

  it('打开 / 新对话 / 退出各自回到对应回调', () => {
    const h = handlers()
    const items = buildTrayMenuTemplate(state(), h, t)

    // @ts-expect-error 菜单项 click 是 Electron 的签名，测试里无参直接调
    items[0].click()
    // @ts-expect-error 菜单项 click 是 Electron 的签名，测试里无参直接调
    items[2].click()
    // @ts-expect-error 菜单项 click 是 Electron 的签名，测试里无参直接调
    items[3].click()

    expect(h.newSession).toHaveBeenCalledTimes(1)
    expect(h.openMainWindow).toHaveBeenCalledTimes(1)
    expect(h.quit).toHaveBeenCalledTimes(1)
  })
})
