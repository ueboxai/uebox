import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildConversationExcerpt,
  MAX_EXCERPT_CHARS,
  resetRetitleStateForTest,
  retitleSession,
  type ExcerptMessage
} from './sessionRetitle'

const generateSessionTitleFromExcerpt = vi.hoisted(() => vi.fn())
vi.mock('../api/ai', () => ({ aiAPI: { generateSessionTitleFromExcerpt } }))

const round: ExcerptMessage[] = [
  { role: 'user', content: '第一条：帮我导入 FBX' },
  { role: 'assistant', content: '已导入' },
  { role: 'user', content: '材质球怎么是白的' },
  { role: 'assistant', content: '贴图没连上 BaseColor' }
]

const roundExcerpt = [
  'User questions (in order):',
  '- 第一条：帮我导入 FBX',
  '- 材质球怎么是白的',
  'Latest answer: 贴图没连上 BaseColor'
].join('\n')

describe('buildConversationExcerpt', () => {
  it('带上所有提问和最后一条回答，不只是最后一轮', () => {
    expect(buildConversationExcerpt(round)).toBe(roundExcerpt)
  })

  it('给了当前标题就放在最前面', () => {
    expect(buildConversationExcerpt(round, '导入 FBX')).toBe(
      `Current title: 导入 FBX\n${roundExcerpt}`
    )
  })

  it('最后一条是提问（还没回答）时不带更早的回答', () => {
    const excerpt = buildConversationExcerpt([...round, { role: 'user', content: '那怎么连' }])
    expect(excerpt.endsWith('- 那怎么连')).toBe(true)
    expect(excerpt).not.toContain('Latest answer')
  })

  it('最后一轮夹着过程消息时，取收尾那条回答', () => {
    const excerpt = buildConversationExcerpt([
      { role: 'user', content: '打个包' },
      { role: 'assistant', content: '开始编译' },
      { role: 'assistant', content: '打包完成，在 Saved 目录' }
    ])
    expect(excerpt).toBe(
      'User questions (in order):\n- 打个包\nLatest answer: 打包完成，在 Saved 目录'
    )
  })

  it('多模态消息只取文本部分', () => {
    const messages: ExcerptMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image_url', text: undefined },
          { type: 'text', text: '这张图里的报错' }
        ]
      }
    ]
    expect(buildConversationExcerpt(messages)).toBe('User questions (in order):\n- 这张图里的报错')
  })

  it('提问太多时留住第一个和最近的，中间说明省掉了几个', () => {
    const messages: ExcerptMessage[] = []
    for (let i = 0; i < 60; i += 1) {
      messages.push({ role: 'user', content: `第${i}个问题${'字'.repeat(40)}` })
      messages.push({ role: 'assistant', content: `回答${i}${'答'.repeat(3000)}` })
    }
    const excerpt = buildConversationExcerpt(messages)
    expect(excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS)
    expect(excerpt).toContain('- 第0个问题')
    expect(excerpt).toContain('- 第59个问题')
    expect(excerpt).toMatch(/earlier questions omitted/)
    expect(excerpt).toContain('Latest answer: 回答59')
  })

  it('超长的提问和回答都会截短，不挤掉别的内容', () => {
    const excerpt = buildConversationExcerpt([
      { role: 'user', content: '日'.repeat(5000) },
      { role: 'assistant', content: '结论：改一下采样器' + '尾'.repeat(5000) }
    ])
    expect(excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS)
    expect(excerpt).toContain('Latest answer: 结论：改一下采样器')
  })

  it('没有任何有效文本时回空串', () => {
    expect(buildConversationExcerpt([])).toBe('')
    expect(buildConversationExcerpt([{ role: 'user', content: '   ' }])).toBe('')
  })

  it('只有助手消息时退回最后一条有内容的', () => {
    expect(buildConversationExcerpt([{ role: 'assistant', content: '打包完成' }])).toBe('打包完成')
  })
})

describe('retitleSession', () => {
  beforeEach(() => {
    generateSessionTitleFromExcerpt.mockReset()
    resetRetitleStateForTest()
  })

  it('拿到标题就落下去', async () => {
    generateSessionTitleFromExcerpt.mockResolvedValue('材质球泛白')
    const applyTitle = vi.fn()

    expect(await retitleSession('s1', round, applyTitle)).toBe('ok')
    expect(applyTitle).toHaveBeenCalledWith('材质球泛白')
    expect(generateSessionTitleFromExcerpt).toHaveBeenCalledWith({ excerpt: roundExcerpt })
  })

  it('自动那条把当前标题一起给模型，手动那条不给', async () => {
    generateSessionTitleFromExcerpt.mockResolvedValue('材质球泛白')

    await retitleSession('s1', round, vi.fn(), () => '导入 FBX', { keepCurrentTitle: true })
    expect(generateSessionTitleFromExcerpt).toHaveBeenLastCalledWith({
      excerpt: `Current title: 导入 FBX\n${roundExcerpt}`
    })

    await retitleSession('s1', round, vi.fn(), () => '导入 FBX')
    expect(generateSessionTitleFromExcerpt).toHaveBeenLastCalledWith({ excerpt: roundExcerpt })
  })

  it('没有对话内容时连模型都不打', async () => {
    const applyTitle = vi.fn()
    expect(await retitleSession('s1', [], applyTitle)).toBe('empty')
    expect(generateSessionTitleFromExcerpt).not.toHaveBeenCalled()
    expect(applyTitle).not.toHaveBeenCalled()
  })

  it('模型没配 / 调用失败不抛错，原名留着', async () => {
    generateSessionTitleFromExcerpt.mockRejectedValue(new Error('未绑定轻量任务模型'))
    const applyTitle = vi.fn()

    expect(await retitleSession('s1', round, applyTitle)).toBe('failed')
    expect(applyTitle).not.toHaveBeenCalled()
  })

  it('模型回废话（空串）也不改名', async () => {
    generateSessionTitleFromExcerpt.mockResolvedValue('')
    const applyTitle = vi.fn()

    expect(await retitleSession('s1', round, applyTitle)).toBe('failed')
    expect(applyTitle).not.toHaveBeenCalled()
  })

  // 后台起名要几秒；这期间用户手动改了名，晚到的模型名字不能把它盖掉
  it('起名期间标题被改过就不落', async () => {
    let resolveTitle: (value: string) => void = () => {}
    generateSessionTitleFromExcerpt.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveTitle = resolve
      })
    )
    const applyTitle = vi.fn()
    let current = '旧名字'

    const pending = retitleSession('s1', round, applyTitle, () => current)
    current = '用户刚改的名字'
    resolveTitle('模型起的名字')

    expect(await pending).toBe('skipped')
    expect(applyTitle).not.toHaveBeenCalled()
  })

  it('同一条会话在途时不重复发起', async () => {
    let resolveTitle: (value: string) => void = () => {}
    generateSessionTitleFromExcerpt.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveTitle = resolve
      })
    )

    const first = retitleSession('s1', round, vi.fn())
    expect(await retitleSession('s1', round, vi.fn())).toBe('skipped')

    resolveTitle('材质球泛白')
    await first
    expect(generateSessionTitleFromExcerpt).toHaveBeenCalledTimes(1)
  })
})
