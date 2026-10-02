import { describe, expect, it } from 'vitest'

import { VoiceCallPresence } from './voiceCallPresence'

describe('VoiceCallPresence', () => {
  it('每个窗口看到的是别的窗口在不在通话', () => {
    const presence = new VoiceCallPresence()
    presence.set(1, true)
    expect(presence.activeElsewhere(1)).toBe(false)
    expect(presence.activeElsewhere(2)).toBe(true)
  })

  /** 小窗开口把主窗口那路抢过来，主窗口随后报「我挂了」：不能把小窗也标成没在通话 */
  it('交接时旧窗口撤自己的那份，不影响接手的窗口', () => {
    const presence = new VoiceCallPresence()
    presence.set(1, true)
    presence.set(2, true)
    presence.set(1, false)
    expect(presence.activeElsewhere(1)).toBe(true)
    expect(presence.activeElsewhere(2)).toBe(false)
  })

  it('窗口没了就撤掉它的那份；重复报同一个状态不算变化', () => {
    const presence = new VoiceCallPresence()
    expect(presence.set(1, true)).toBe(true)
    expect(presence.set(1, true)).toBe(false)
    expect(presence.remove(1)).toBe(true)
    expect(presence.activeElsewhere(2)).toBe(false)
  })
})
