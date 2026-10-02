/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { confirmTrayQuit, requestGuardedQuit, setQuitGuard } from './quitGuard'

/** 托盘「退出」的拦截线：有任务在跑就得先问一句，没有就直接退 */

describe('托盘退出确认', () => {
  it('没有任务在跑：直接退，不问', () => {
    const askConfirm = vi.fn()
    const quit = vi.fn()
    confirmTrayQuit({ countActiveOperations: () => 0, askConfirm, quit })

    expect(quit).toHaveBeenCalledTimes(1)
    expect(askConfirm).not.toHaveBeenCalled()
  })

  it('有任务在跑：带着数目去问，自己不退', () => {
    const askConfirm = vi.fn()
    const quit = vi.fn()
    confirmTrayQuit({ countActiveOperations: () => 2, askConfirm, quit })

    expect(askConfirm).toHaveBeenCalledWith(2)
    expect(quit).not.toHaveBeenCalled()
  })
})

/** 托盘以外的退出路径（安装更新、`app-quit`）借托盘那套问法 */
describe('requestGuardedQuit', () => {
  afterEach(() => setQuitGuard(null))

  it('托盘没起来、没人挂问法：照原样直接走', () => {
    const proceed = vi.fn()
    requestGuardedQuit(proceed, 'update')

    expect(proceed).toHaveBeenCalledTimes(1)
  })

  it('挂了问法：交给它，带上为什么退；自己不先走', () => {
    const handler = vi.fn()
    setQuitGuard(handler)
    const proceed = vi.fn()
    requestGuardedQuit(proceed, 'update')

    expect(handler).toHaveBeenCalledWith(proceed, 'update')
    expect(proceed).not.toHaveBeenCalled()
  })

  it('不说为什么就按普通退出', () => {
    const handler = vi.fn()
    setQuitGuard(handler)
    requestGuardedQuit(() => {})

    expect(handler.mock.calls[0][1]).toBe('quit')
  })
})
