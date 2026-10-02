import { describe, expect, it } from 'vitest'

import { ChatWindowRegistry } from './chatWindowRegistry'

const MAIN = 1
const CHAT = 7
const OTHER = 9

function registry(): ChatWindowRegistry {
  const value = new ChatWindowRegistry()
  value.register('sid-a', CHAT)
  return value
}

describe('ChatWindowRegistry.relayTargets', () => {
  it('主窗口改了开在独立窗口里的那条：只转给那个窗口', () => {
    expect(registry().relayTargets(MAIN, 'sid-a', MAIN)).toEqual([CHAT])
  })

  it('主窗口改了没拖出去的对话：谁也不转', () => {
    expect(registry().relayTargets(MAIN, 'sid-b', MAIN)).toEqual([])
  })

  it('独立窗口改了自己那条：转给主窗口去存盘', () => {
    expect(registry().relayTargets(CHAT, 'sid-a', MAIN)).toEqual([MAIN])
  })

  it('独立窗口替别的对话发补丁：不转（它的状态已经乱了）', () => {
    expect(registry().relayTargets(CHAT, 'sid-b', MAIN)).toEqual([])
  })

  it('MiniChat 这类不参与同步的窗口发来的：不转', () => {
    expect(registry().relayTargets(OTHER, 'sid-a', MAIN)).toEqual([])
  })

  it('主窗口没了：独立窗口的补丁没人接，也不往别处乱发', () => {
    expect(registry().relayTargets(CHAT, 'sid-a', undefined)).toEqual([])
  })
})

describe('ChatWindowRegistry.approvalMirrors', () => {
  it('独立窗口发起的一轮：主窗口也弹', () => {
    expect(registry().approvalMirrors('agent-x', CHAT, MAIN)).toEqual([MAIN])
  })

  it('主窗口发起、显示在独立窗口里的会话：独立窗口也弹', () => {
    const value = registry()
    value.bindAgentSession(CHAT, 'sid-a', 'agent-a')
    expect(value.approvalMirrors('agent-a', MAIN, MAIN)).toEqual([CHAT])
  })

  it('两边都不沾（主窗口自己的会话、MiniChat 的会话）：不镜像', () => {
    const value = registry()
    value.bindAgentSession(CHAT, 'sid-a', 'agent-a')
    expect(value.approvalMirrors('agent-b', MAIN, MAIN)).toEqual([])
    expect(value.approvalMirrors('agent-b', OTHER, MAIN)).toEqual([])
  })

  it('独立窗口自己发起、自己显示：只多给主窗口，不给自己再发一份', () => {
    const value = registry()
    value.bindAgentSession(CHAT, 'sid-a', 'agent-a')
    expect(value.approvalMirrors('agent-a', CHAT, MAIN)).toEqual([MAIN])
  })
})

describe('ChatWindowRegistry 登记', () => {
  it('只认窗口给自己那条报的内核会话 id', () => {
    const value = registry()
    value.bindAgentSession(OTHER, 'sid-a', 'agent-z')
    expect(value.webContentsOfAgentSession('agent-z')).toBeUndefined()
    value.bindAgentSession(CHAT, 'sid-a', 'agent-a')
    expect(value.webContentsOfAgentSession('agent-a')).toBe(CHAT)
    // 清空对话会换一个 id，旧的不再认
    value.bindAgentSession(CHAT, 'sid-a', 'agent-b')
    expect(value.webContentsOfAgentSession('agent-a')).toBeUndefined()
  })

  it('窗口关了就从表里摘掉，并说出它开的是哪条', () => {
    const value = registry()
    expect(value.removeByWebContents(CHAT)).toBe('sid-a')
    expect(value.chatSids()).toEqual([])
    expect(value.removeByWebContents(CHAT)).toBeUndefined()
  })
})

describe('小窗里开的语音通话派生的任务对话', () => {
  const task = 'voice-tasks-sid-a::lighting'

  it('独立窗口的任务对话补丁转给主窗口', () => {
    expect(registry().relayTargets(CHAT, task, MAIN)).toEqual([MAIN])
  })

  it('主窗口那边的改动转回管它的独立窗口', () => {
    expect(registry().relayTargets(MAIN, task, MAIN)).toEqual([CHAT])
  })

  it('别的对话派生的任务对话不归它', () => {
    expect(registry().relayTargets(CHAT, 'voice-tasks-sid-b::lighting', MAIN)).toEqual([])
  })
})
