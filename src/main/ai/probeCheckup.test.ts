/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const complete = vi.hoisted(() => vi.fn())
const completeText = vi.hoisted(() => vi.fn())
vi.mock('./piCompletion', () => ({
  complete,
  completeText,
  userMessage: (text: string) => ({ role: 'user', content: text, timestamp: 0 })
}))

import { checkupChatModel } from './probe'
import type { ProviderConfig } from './types'

const provider = (supportsVision: boolean): ProviderConfig =>
  ({
    id: 'gw',
    displayName: 'GW',
    kind: 'chat',
    protocol: 'openai-completions',
    baseUrl: 'https://gw.example/v1',
    models: [{ id: 'm', supportsVision }]
  }) as unknown as ProviderConfig

const calls = { content: [{ type: 'toolCall', id: 't', name: 'ping', arguments: {} }] }
const talks = { content: [{ type: 'text', text: '好的，我来调用 ping' }] }

describe('入职体检', () => {
  beforeEach(() => {
    complete.mockReset()
    completeText.mockReset()
  })

  it('调了工具就过；不声称能看图的不查看图', async () => {
    complete.mockResolvedValue(calls)
    await expect(checkupChatModel(provider(false), 'm', () => 1)).resolves.toEqual({
      at: 1,
      reachable: true,
      tools: 'ok'
    })
    expect(complete).toHaveBeenCalledOnce()
    expect(complete.mock.calls[0][2].tools[0].name).toBe('ping')
    expect(completeText).not.toHaveBeenCalled()
  })

  it('第一次只说话不调，再问一次；两次都不调才算没过', async () => {
    complete.mockResolvedValueOnce(talks).mockResolvedValueOnce(calls)
    await expect(checkupChatModel(provider(false), 'm')).resolves.toMatchObject({ tools: 'ok' })
    complete.mockReset()
    complete.mockResolvedValue(talks)
    await expect(checkupChatModel(provider(false), 'm')).resolves.toMatchObject({
      reachable: true,
      tools: 'fail'
    })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('请求不通：带上归好类的原因', async () => {
    complete.mockRejectedValue(new Error('401 Unauthorized'))
    await expect(checkupChatModel(provider(true), 'm')).resolves.toMatchObject({
      reachable: false,
      tools: 'fail',
      failure: { code: 'unauthorized' }
    })
  })

  it('声称能看图：说得出红色才算看得见；说不出、带图被拒都算看不见', async () => {
    complete.mockResolvedValue(calls)
    completeText.mockResolvedValueOnce('Red.')
    await expect(checkupChatModel(provider(true), 'm')).resolves.toMatchObject({ vision: 'ok' })
    const sent = completeText.mock.calls[0][2].messages[0].content
    expect(sent[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })

    completeText.mockResolvedValueOnce('I cannot see any image.')
    await expect(checkupChatModel(provider(true), 'm')).resolves.toMatchObject({
      tools: 'ok',
      vision: 'fail'
    })
    completeText.mockRejectedValueOnce(new Error('400 image input not supported'))
    await expect(checkupChatModel(provider(true), 'm')).resolves.toMatchObject({
      tools: 'ok',
      vision: 'fail'
    })
  })
})
