import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/api/chatWindow', () => ({
  chatWindowAPI: {},
  chatWindowSid: () => '',
  isChatWindow: () => false
}))

import { decideChatWindowNavigation } from './chatWindowGuard'

type Target = Parameters<typeof decideChatWindowNavigation>[0]
type Context = Parameters<typeof decideChatWindowNavigation>[1]

function target(path: string, name?: string, query: Record<string, unknown> = {}): Target {
  const search = new URLSearchParams(query as Record<string, string>).toString()
  return { path, name, query, fullPath: search ? `${path}?${search}` : path }
}

const inMain = (detached: string[] = []): Context => ({
  inChatWindow: false,
  ownSid: '',
  isDetached: (sid: string) => detached.includes(sid)
})

const inChatWindow = { inChatWindow: true, ownSid: 's1', isDetached: () => false }

describe('decideChatWindowNavigation', () => {
  it('主窗口打开一条开在独立窗口里的对话：把那个窗口提上来，不开标签', () => {
    expect(
      decideChatWindowNavigation(
        target('/dev-assistant', 'AssistantWelcome', { sid: 's1' }),
        inMain(['s1'])
      )
    ).toEqual({ kind: 'focus-detached', sid: 's1' })
  })

  it('主窗口打开别的对话、别的页面：照常', () => {
    expect(
      decideChatWindowNavigation(
        target('/dev-assistant', 'AssistantWelcome', { sid: 's2' }),
        inMain(['s1'])
      )
    ).toEqual({ kind: 'pass' })
    expect(decideChatWindowNavigation(target('/asset-management'), inMain(['s1']))).toEqual({
      kind: 'pass'
    })
  })

  it('独立窗口自己的路由放行', () => {
    expect(
      decideChatWindowNavigation(target('/chat-window', 'ChatWindow', { sid: 's1' }), inChatWindow)
    ).toEqual({ kind: 'pass' })
  })

  it('独立窗口里要去主界面的页面：交给主窗口，带着完整的路径和参数', () => {
    expect(
      decideChatWindowNavigation(
        target('/asset-management', 'AssetManagement', { search: 'rock' }),
        inChatWindow
      )
    ).toEqual({ kind: 'open-in-main', path: '/asset-management?search=rock' })
    expect(
      decideChatWindowNavigation(
        target('/dev-assistant', 'AssistantWelcome', { sid: 's2' }),
        inChatWindow
      )
    ).toEqual({ kind: 'open-in-main', path: '/dev-assistant?sid=s2' })
  })

  it('独立窗口里「打开我自己这条」：原地不动', () => {
    expect(
      decideChatWindowNavigation(
        target('/dev-assistant', 'AssistantWelcome', { sid: 's1' }),
        inChatWindow
      )
    ).toEqual({ kind: 'stay' })
  })
})
