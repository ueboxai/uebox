import { describe, expect, it } from 'vitest'

import {
  applyMessagesPatch,
  applySessionPatch,
  buildPatch,
  emptyKnownState,
  rememberPatch,
  type LocalState
} from './chatWindowSyncCore'

type Msg = { id: string; role: string; content: string; status?: string }

function local(messages: Msg[], session: Record<string, unknown> | null = null): LocalState {
  return {
    messages,
    session,
    permissionMode: null,
    draft: null,
    historySummary: null,
    compressedUserCount: null
  }
}

/** 模拟另一边：收补丁、打上去、记下来，和 chatWindowSync.ts 的 onApply 一样 */
function receive(
  current: Msg[],
  patch: NonNullable<ReturnType<typeof buildPatch>>,
  protectedId?: string
): Msg[] {
  return applyMessagesPatch(current, patch, protectedId).messages
}

describe('buildPatch', () => {
  it('第一次发：顺序和每条消息都带上', () => {
    const known = emptyKnownState()
    const messages = [
      { id: 'u1', role: 'user', content: '你好' },
      { id: 'a1', role: 'assistant', content: '在' }
    ]
    const patch = buildPatch('s', local(messages), known, 'all')
    expect(patch?.order).toEqual(['u1', 'a1'])
    expect(patch?.messages?.map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('没变就不发', () => {
    const known = emptyKnownState()
    const messages = [{ id: 'u1', role: 'user', content: '你好' }]
    buildPatch('s', local(messages), known, 'all')
    expect(buildPatch('s', local(messages), known, 'all')).toBeNull()
  })

  /**
   * 流式时消息是就地改的（`replaceTyping`），引用不变。
   * 按引用比的话正在打字的那条永远不会被发过去。
   */
  it('就地改的那一条照样认得出来，而且只发那一条、不带顺序', () => {
    const known = emptyKnownState()
    const typing = { id: 'a1', role: 'assistant', content: '', status: 'typing' }
    const messages = [{ id: 'u1', role: 'user', content: '你好' }, typing]
    buildPatch('s', local(messages), known, 'all')

    typing.content = '正在写'
    const patch = buildPatch('s', local(messages), known, new Set(['a1']))
    expect(patch?.order).toBeUndefined()
    expect(patch?.messages).toEqual([{ ...typing }])
  })

  it('发出去的是拷贝，之后再改原对象不会影响已发的补丁', () => {
    const known = emptyKnownState()
    const typing = { id: 'a1', role: 'assistant', content: '一' }
    const patch = buildPatch('s', local([typing]), known, 'all')
    typing.content = '二'
    expect(patch?.messages?.[0].content).toBe('一')
  })

  it('删了一条：只带新顺序', () => {
    const known = emptyKnownState()
    const messages = [
      { id: 'u1', role: 'user', content: '一' },
      { id: 'u2', role: 'user', content: '二' }
    ]
    buildPatch('s', local(messages), known, 'all')
    const patch = buildPatch('s', local([messages[0]]), known, 'all')
    expect(patch?.order).toEqual(['u1'])
    expect(patch?.messages).toBeUndefined()
  })

  it('全量：不管对方有没有，每样都带上', () => {
    const known = emptyKnownState()
    const messages = [{ id: 'u1', role: 'user', content: '一' }]
    buildPatch('s', local(messages, { id: 's', title: 't' }), known, 'all')
    const patch = buildPatch('s', local(messages, { id: 's', title: 't' }), known, new Set(), true)
    expect(patch?.full).toBe(true)
    expect(patch?.messages).toHaveLength(1)
    expect(patch?.session).toEqual({ exists: true, fields: { id: 's', title: 't' } })
    expect(patch).toHaveProperty('permissionMode', null)
  })
})

describe('会话记录的字段补丁', () => {
  it('只带变了的字段，拿掉的字段单独列出', () => {
    const known = emptyKnownState()
    const session: Record<string, unknown> = {
      id: 's',
      title: '旧',
      project: { projectName: 'A' }
    }
    buildPatch('s', local([], session), known, 'all')

    session.title = '新'
    delete session.project
    const patch = buildPatch('s', local([], session), known, 'all')
    expect(patch?.session).toEqual({ exists: true, fields: { title: '新' }, removed: ['project'] })
  })

  it('打上字段补丁：别的字段留着，拿掉的删掉', () => {
    const next = applySessionPatch(
      { id: 's', title: '旧', project: { projectName: 'A' }, pinned: true },
      { exists: true, fields: { title: '新' }, removed: ['project'] }
    )
    expect(next).toEqual({ id: 's', title: '新', pinned: true })
  })

  it('全量打上去：本地多出来的字段不留', () => {
    const next = applySessionPatch(
      { id: 's', title: '旧', pinned: true },
      { exists: true, fields: { id: 's', title: '新' } },
      true
    )
    expect(next).toEqual({ id: 's', title: '新' })
  })

  it('会话记录没了就是 null', () => {
    expect(applySessionPatch({ id: 's' }, { exists: false })).toBeNull()
  })
})

describe('两边来回不会把对方刚发来的原样弹回去', () => {
  it('收到的补丁记进 known 之后，同样的内容不会再发', () => {
    const known = emptyKnownState()
    const incoming = buildPatch(
      's',
      local([{ id: 'a1', role: 'assistant', content: '对面写的' }]),
      emptyKnownState(),
      'all'
    )!
    const mine = receive([], incoming)
    rememberPatch(known, incoming, local(mine))
    expect(buildPatch('s', local(mine), known, 'all')).toBeNull()
  })
})

describe('applyMessagesPatch', () => {
  it('带顺序：按顺序重排，认得的用新版本，没带的保留本地的', () => {
    const current: Msg[] = [
      { id: 'u1', role: 'user', content: '一' },
      { id: 'a1', role: 'assistant', content: '旧' }
    ]
    const { messages } = applyMessagesPatch(current, {
      order: ['u1', 'a1', 'u2'],
      messages: [
        { id: 'a1', role: 'assistant', content: '新' },
        { id: 'u2', role: 'user', content: '二' }
      ]
    })
    expect(messages.map((m) => m.content)).toEqual(['一', '新', '二'])
    expect(messages[0]).toBe(current[0])
  })

  it('不带顺序：就地换，认不得的接在后面', () => {
    const current: Msg[] = [{ id: 'u1', role: 'user', content: '一' }]
    const { messages } = applyMessagesPatch(current, {
      messages: [{ id: 'a9', role: 'assistant', content: '新来的' }]
    })
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a9'])
  })

  /**
   * 这一轮是这个窗口发起的，事件只到这里，正在打字的那条以这边为准。
   * 对方那份最多是 100 毫秒前从这里抄过去的，打上去字会往回跳一下。
   */
  it('这边正在流式写的那条不让对方覆盖，也不认对方的顺序', () => {
    const current: Msg[] = [
      { id: 'u1', role: 'user', content: '一' },
      { id: 'a1', role: 'assistant', content: '这边最新的', status: 'typing' }
    ]
    const { messages, skipped } = applyMessagesPatch(
      current,
      {
        // 对方的顺序还没有 a1
        order: ['u1', 'u2'],
        messages: [
          { id: 'a1', role: 'assistant', content: '对方旧的', status: 'typing' },
          { id: 'u2', role: 'user', content: '对方插的话' }
        ]
      },
      'a1'
    )
    expect(skipped).toEqual(new Set(['a1']))
    expect(messages.map((m) => [m.id, m.content])).toEqual([
      ['u1', '一'],
      ['a1', '这边最新的'],
      ['u2', '对方插的话']
    ])
  })

  it('全量也换不掉正在流式写的那条', () => {
    const current: Msg[] = [{ id: 'a1', role: 'assistant', content: '这边最新的' }]
    const { messages } = applyMessagesPatch(
      current,
      {
        full: true,
        order: ['u1', 'a1'],
        messages: [
          { id: 'u1', role: 'user', content: '一' },
          { id: 'a1', role: 'assistant', content: '旧的' }
        ]
      },
      'a1'
    )
    expect(messages.map((m) => m.content)).toEqual(['一', '这边最新的'])
  })
})
