/**
 * 两个窗口之间的对话同步：两个 pinia 当两个窗口，中间接一根假的主进程。
 *
 * 假主进程按真主进程的规矩转发（`main/chatWindowRegistry.ts` 的 `relayTargets`）：
 * 主窗口的补丁只给开着那条的独立窗口，独立窗口的只给主窗口；
 * 独立窗口要全量时去问主窗口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'

import type { ChatSyncPatch } from '@core/shared/chatWindowSync'
import { belongsToChat } from '@core/shared/voiceTaskSession'
import { useAgentStreamStore } from '@renderer/store/modules/agentStream'
import { useChatMessagesStore } from '@renderer/store/modules/chatMessages'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'

import {
  CHAT_SYNC_FLUSH_MS,
  createChatWindowSync,
  type ChatWindowSyncBridge,
  type ChatWindowSyncRole
} from './chatWindowSync'

vi.mock('@renderer/api/agentV3', () => ({ agentV3API: {} }))

interface FakeWindow {
  pinia: Pinia
  role: ChatWindowSyncRole
  ownSid: string
  apply: Array<(patch: ChatSyncPatch) => void>
  snapshot: Array<(args: { sid: string }) => void>
  changed: Array<(sids: string[]) => void>
  runs: Array<(ids: string[]) => void>
  closed: boolean
}

interface Bus {
  boot: (role: ChatWindowSyncRole, ownSid?: string) => FakeWindow
  detach: (sid: string) => FakeWindow
}

function createBus(): Bus {
  const windows: FakeWindow[] = []
  let detached: string[] = []
  const main = (): FakeWindow | undefined => windows.find((w) => w.role === 'main')

  function bridgeFor(self: FakeWindow): ChatWindowSyncBridge {
    return {
      push: (patch) => {
        const targets =
          self.role === 'main'
            ? windows.filter((w) => w.role === 'chat-window' && belongsToChat(patch.sid, w.ownSid))
            : belongsToChat(patch.sid, self.ownSid)
              ? windows.filter((w) => w.role === 'main')
              : []
        for (const target of targets) for (const cb of target.apply) cb(patch)
      },
      onApply: (cb) => {
        self.apply.push(cb)
        return () => {}
      },
      list: async () => detached,
      onChanged: (cb) => {
        self.changed.push(cb)
        return () => {}
      },
      requestSnapshot: (sid) => {
        for (const cb of main()?.snapshot ?? []) cb({ sid })
      },
      onSnapshotRequest: (cb) => {
        self.snapshot.push(cb)
        return () => {}
      },
      bindAgentSession: () => {},
      resendApprovals: async () => 0,
      runsElsewhere: async () => [],
      onRunsElsewhere: (cb) => {
        self.runs.push(cb)
      }
    }
  }

  function boot(role: ChatWindowSyncRole, ownSid = ''): FakeWindow {
    const self: FakeWindow = {
      pinia: createPinia(),
      role,
      ownSid,
      apply: [],
      snapshot: [],
      changed: [],
      runs: [],
      closed: false
    }
    windows.push(self)
    setActivePinia(self.pinia)
    createChatWindowSync({
      role,
      ownSid,
      bridge: bridgeFor(self),
      closeWindow: () => {
        self.closed = true
      }
    })
    return self
  }

  /** 主进程开出一个独立窗口：先登记（主窗口开始同步这条），再起渲染进程 */
  function detach(sid: string): FakeWindow {
    detached = [...detached, sid]
    for (const cb of main()?.changed ?? []) cb(detached)
    return boot('chat-window', sid)
  }

  return { boot, detach }
}

/** 在某个窗口里干活 */
function inWindow<T>(win: FakeWindow, fn: () => T): T {
  setActivePinia(win.pinia)
  return fn()
}

interface WindowStores {
  messages: ReturnType<typeof useChatMessagesStore>
  sessions: ReturnType<typeof useChatSessionsStore>
  stream: ReturnType<typeof useAgentStreamStore>
}

function stores(win: FakeWindow): WindowStores {
  return inWindow(win, () => ({
    messages: useChatMessagesStore(),
    sessions: useChatSessionsStore(),
    stream: useAgentStreamStore()
  }))
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(CHAT_SYNC_FLUSH_MS + 10)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('chatWindowSync', () => {
  it('独立窗口一打开就拿到主窗口内存里的那份，包括正在打字的那条', async () => {
    const bus = createBus()
    const main = bus.boot('main')
    const m = stores(main)
    m.sessions.createSession('s1', '拖出去的那条')
    m.sessions.createSession('s2', '留在主窗口的')
    m.messages.pushUser('s1', '帮我建个关卡')
    const typingId = m.messages.pushAssistantTyping('s1')
    m.messages.replaceTyping('s1', typingId, '正在建', false)

    const chat = bus.detach('s1')
    const c = stores(chat)

    expect(c.messages.getMessages('s1').map((msg) => msg.content)).toEqual([
      '帮我建个关卡',
      '正在建'
    ])
    expect(c.sessions.sessionById('s1')?.title).toBe('拖出去的那条')
    // 没拖出去的不发
    expect(c.sessions.sessionById('s2')).toBeNull()
  })

  it('主窗口在跑的那一轮，独立窗口跟着实时更新，写完的终稿立刻到', async () => {
    const bus = createBus()
    const main = bus.boot('main')
    const m = stores(main)
    m.sessions.createSession('s1', 't')
    const typingId = m.messages.pushAssistantTyping('s1')
    const chat = bus.detach('s1')
    const c = stores(chat)

    inWindow(main, () => m.messages.replaceTyping('s1', typingId, '第一段', false))
    await settle()
    expect(c.messages.getMessages('s1')[0].content).toBe('第一段')

    inWindow(main, () => m.messages.replaceTyping('s1', typingId, '写完了', true))
    // 终稿不等节流
    expect(c.messages.getMessages('s1')[0]).toMatchObject({ content: '写完了', status: 'done' })
  })

  it('独立窗口里发的话和改的标题交给主窗口（由主窗口存盘）', async () => {
    const bus = createBus()
    const main = bus.boot('main')
    const m = stores(main)
    m.sessions.createSession('s1', '旧标题')
    const chat = bus.detach('s1')
    const c = stores(chat)

    inWindow(chat, () => {
      c.messages.pushUser('s1', '在小窗里说的')
      c.sessions.updateTitle('s1', '新标题')
    })
    await settle()

    expect(m.messages.getMessages('s1').map((msg) => msg.content)).toEqual(['在小窗里说的'])
    expect(m.sessions.sessionById('s1')?.title).toBe('新标题')
  })

  it('独立窗口拿到全量之前不发补丁，不会拿盘上的旧版本盖掉主窗口', async () => {
    const bus = createBus()
    const main = bus.boot('main')
    const m = stores(main)
    m.sessions.createSession('s1', '主窗口的标题')

    // 主窗口没装同步（比如正在刷新）：独立窗口要不到全量
    const lonely = createBus()
    const chat = lonely.detach('s1')
    const c = stores(chat)
    inWindow(chat, () => c.sessions.createSession('s1', '盘上的旧标题'))
    await settle()

    expect(m.sessions.sessionById('s1')?.title).toBe('主窗口的标题')
  })

  it('主窗口删了这条对话，独立窗口关掉自己', async () => {
    const bus = createBus()
    const main = bus.boot('main')
    const m = stores(main)
    m.sessions.createSession('s1', 't')
    const chat = bus.detach('s1')

    inWindow(main, () => m.sessions.removeSession('s1'))
    expect(chat.closed).toBe(true)
  })

  /**
   * 独立窗口发起的一轮：事件只到独立窗口，它正在写的那条以它为准。
   * 主窗口那份同步回来时最多是 100 毫秒前的，不能让字往回跳。
   */
  it('这边在流式写的那条，不被对方同步回来的旧版本盖掉', async () => {
    const bus = createBus()
    const main = bus.boot('main')
    const m = stores(main)
    m.sessions.createSession('s1', 't')
    const chat = bus.detach('s1')
    const c = stores(chat)

    const typingId = inWindow(chat, () => {
      const id = c.messages.pushAssistantTyping('s1')
      c.stream.initStream('s1', 'agent-1', id)
      c.messages.replaceTyping('s1', id, '小窗最新的', false)
      return id
    })
    await settle()
    expect(m.messages.getMessages('s1')[0].content).toBe('小窗最新的')

    // 主窗口那边手上的这条被动了一下（比如收到了别的改动），发回来的是旧内容
    inWindow(main, () => m.messages.replaceTyping('s1', typingId, '主窗口的旧版本', false))
    await settle()
    expect(c.messages.getMessages('s1')[0].content).toBe('小窗最新的')
    // 而且把自己这份再发回去，主窗口跟上
    await settle()
    expect(m.messages.getMessages('s1')[0].content).toBe('小窗最新的')
  })

  /**
   * 通话开在小窗里：派出去的活落在派生的任务对话上，那些对话在小窗里建、在小窗里跑，
   * 得同步回主窗口存盘、进侧边栏。别的对话派生的不归它。
   */
  it('小窗里打的电话派生的任务对话同步回主窗口', async () => {
    const bus = createBus()
    const main = bus.boot('main')
    const m = stores(main)
    m.sessions.createSession('s1', 't')
    const chat = bus.detach('s1')
    const c = stores(chat)

    inWindow(chat, () => {
      c.sessions.ensureSession('voice-tasks-s1::lighting', '灯光')
      c.messages.pushUser('voice-tasks-s1::lighting', '把灯调暗')
      c.sessions.ensureSession('voice-tasks-s9::lighting', '别人的')
    })
    await settle()

    expect(m.sessions.sessionById('voice-tasks-s1::lighting')?.title).toBe('灯光')
    expect(m.messages.getMessages('voice-tasks-s1::lighting')[0]?.content).toBe('把灯调暗')
    expect(m.sessions.sessionById('voice-tasks-s9::lighting')).toBeNull()

    // 主窗口那边动了它（比如改名），也同步回小窗
    inWindow(main, () => m.sessions.updateTitle('voice-tasks-s1::lighting', '灯光组'))
    await settle()
    expect(c.sessions.sessionById('voice-tasks-s1::lighting')?.title).toBe('灯光组')
  })

  it('小窗打开时，主窗口以前打电话派生的任务对话一起给过去', async () => {
    const bus = createBus()
    const main = bus.boot('main')
    const m = stores(main)
    m.sessions.createSession('s1', 't')
    m.sessions.createSession('voice-tasks-s1::props', '道具')
    m.messages.pushUser('voice-tasks-s1::props', '摆三张桌子')

    const chat = bus.detach('s1')
    const c = stores(chat)
    expect(c.messages.getMessages('voice-tasks-s1::props')[0]?.content).toBe('摆三张桌子')
  })

  it('别的窗口在跑的对话算忙：这边发消息会排队，不会被顶回来', async () => {
    const bus = createBus()
    const main = bus.boot('main')
    const m = stores(main)
    m.sessions.createSession('s1', 't')
    m.sessions.setAgentSessionId('s1', 'agent-1')

    for (const cb of main.runs) cb(['agent-1'])
    expect(m.stream.isBusy('s1')).toBe(true)
    for (const cb of main.runs) cb([])
    expect(m.stream.isBusy('s1')).toBe(false)
  })
})
