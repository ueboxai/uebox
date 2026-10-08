/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9' } }))

import { isOpenCodeEndpoint, openCodeHeaders } from './opencode'

describe('OpenCode 请求头', () => {
  it('按域名认 Go 与 Zen，别家不认', () => {
    expect(isOpenCodeEndpoint('https://opencode.ai/zen/go/v1')).toBe(true)
    expect(isOpenCodeEndpoint('https://opencode.ai/zen/v1')).toBe(true)
    expect(isOpenCodeEndpoint('https://api.openai.com/v1')).toBe(false)
    expect(isOpenCodeEndpoint('https://notopencode.ai/v1')).toBe(false)
    expect(isOpenCodeEndpoint('')).toBe(false)
  })

  it('带专属 User-Agent，会话 id 给了就用、没给就现生成', () => {
    expect(openCodeHeaders('agent-v3:1:s1:e0')).toEqual({
      'User-Agent': 'uebox/9.9.9',
      'x-opencode-session': 'agent-v3:1:s1:e0'
    })
    const a = openCodeHeaders()['x-opencode-session']
    const b = openCodeHeaders()['x-opencode-session']
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(a).not.toBe(b)
  })
})
