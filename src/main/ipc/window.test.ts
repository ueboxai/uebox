/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (...args: unknown[]) => void>(),
  appQuit: vi.fn()
}))

vi.mock('electron', () => ({
  app: { quit: () => mocks.appQuit() },
  BrowserWindow: { getFocusedWindow: () => null, fromWebContents: () => null },
  ipcMain: {
    on: (channel: string, cb: (...args: unknown[]) => void) => mocks.listeners.set(channel, cb)
  }
}))
vi.mock('../appWindows', () => ({ findMainWindow: () => undefined, getAppWindows: () => [] }))

import { setQuitGuard } from '../tray/quitGuard'
import { registerWindowIPC } from './window'

/** 界面的 `app-quit` 和托盘「退出」过同一道关 */
describe('app-quit', () => {
  beforeEach(() => {
    mocks.listeners.clear()
    mocks.appQuit.mockClear()
    registerWindowIPC()
  })
  afterEach(() => setQuitGuard(null))

  it('先交给退出确认，不直接 app.quit；确认了才退', () => {
    let proceed: () => void = () => {}
    const guard = vi.fn((next: () => void) => (proceed = next))
    setQuitGuard(guard)

    mocks.listeners.get('app-quit')!()
    expect(guard).toHaveBeenCalledWith(expect.any(Function), 'quit')
    expect(mocks.appQuit).not.toHaveBeenCalled()

    proceed()
    expect(mocks.appQuit).toHaveBeenCalledTimes(1)
  })

  it('托盘没起来：照原样直接退', () => {
    mocks.listeners.get('app-quit')!()
    expect(mocks.appQuit).toHaveBeenCalledTimes(1)
  })
})
