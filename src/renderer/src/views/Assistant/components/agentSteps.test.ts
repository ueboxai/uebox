import { describe, expect, it } from 'vitest'

import type { AgentProcessItem } from './AgentProcessLog.types'
import { buildStepGroup, readStepTarget, type StepPart } from './agentSteps'

/**
 * 一段过程读成「一次工具调用一行」。
 *
 * 原来一条事件一行：调用一行、结果一行，结果那行还把写给模型的返回原文整句贴出来。
 * 用户要的是「做了什么、对什么做、结果一句话」，原文留给想排查的人点开看。
 */

function call(name: string, args: unknown, timestamp: number, id?: string): AgentProcessItem {
  return {
    type: 'tool-call',
    data: { ...(id ? { id } : {}), function: { name, arguments: JSON.stringify(args) } },
    timestamp
  }
}

function result(
  toolName: string,
  value: unknown,
  timestamp: number,
  extra: Record<string, unknown> = {}
): AgentProcessItem {
  return { type: 'tool-result', data: { toolName, result: value, ...extra }, timestamp }
}

function process(items: AgentProcessItem[], key = 'p'): StepPart {
  return { kind: 'process', key, items }
}

describe('buildStepGroup', () => {
  it('调用和它的结果合成一行', () => {
    const view = buildStepGroup([
      process([
        call('search_assets', { query: 'CBP_SandboxCharacter' }, 1, 'c1'),
        result('search_assets', { success: true, count: 2 }, 2, { toolCallId: 'c1' })
      ])
    ])

    expect(view.rows).toHaveLength(1)
    expect(view.rows[0]).toMatchObject({
      kind: 'tool',
      toolName: 'search_assets',
      target: 'CBP_SandboxCharacter',
      status: 'done',
      count: 2,
      startedAt: 1,
      endedAt: 2
    })
  })

  it('还没回结果的那一步是 running', () => {
    const view = buildStepGroup([process([call('ue_screenshot', {}, 1, 'c1')])])
    expect(view.rows[0]).toMatchObject({ kind: 'tool', status: 'running' })
  })

  // 老消息存下来时还没有 toolCallId，按工具名先进先出对上
  it('没有 toolCallId 时按工具名对上号', () => {
    const view = buildStepGroup([
      process([
        call('list_local_dir', { path: 'A' }, 1),
        call('list_local_dir', { path: 'B' }, 2),
        result('list_local_dir', { success: true }, 3),
        result('list_local_dir', { success: false, error: '没有这个目录' }, 4)
      ])
    ])

    expect(view.rows.map((row) => row.kind === 'tool' && [row.target, row.status])).toEqual([
      ['A', 'done'],
      ['B', 'failed']
    ])
  })

  it('失败的一步只留原因的第一句，计入出错次数', () => {
    const view = buildStepGroup([
      process([
        call('search_assets', { folder: '/Game/Blueprints' }, 1, 'c1'),
        result(
          'search_assets',
          { success: false, error: '所有保管库里都没有这个文件夹。\n用 library_overview 看。' },
          2,
          { toolCallId: 'c1' }
        )
      ])
    ])

    expect(view.failedCount).toBe(1)
    expect(view.rows[0]).toMatchObject({
      status: 'failed',
      error: '所有保管库里都没有这个文件夹。'
    })
  })

  it('抛错的工具即使没有 success:false 也算失败', () => {
    const view = buildStepGroup([
      process([call('x', {}, 1, 'c1'), result('x', 'boom', 2, { toolCallId: 'c1', isError: true })])
    ])
    expect(view.rows[0]).toMatchObject({ status: 'failed', error: 'boom' })
  })

  // 写给模型的那句话不上行，但展开区里原文要在
  it('返回原文和参数放进展开区', () => {
    const view = buildStepGroup([
      process([
        call('library_overview', { vault: 'A' }, 1, 'c1'),
        result(
          'library_overview',
          { success: true, message: '共 823 个资产，可以直接照着回答用户。' },
          2,
          {
            toolCallId: 'c1'
          }
        )
      ])
    ])
    const row = view.rows[0]
    if (row.kind !== 'tool') throw new Error('expected tool row')

    expect(row.argsText).toContain('"vault": "A"')
    expect(row.resultText).toBe('共 823 个资产，可以直接照着回答用户。')
  })

  it('推理和工具调用按发生顺序排在一组里', () => {
    const view = buildStepGroup([
      { kind: 'thinking', key: 't', text: '先看看资产库', at: 1 },
      process([call('library_overview', {}, 2, 'c1')])
    ])
    expect(view.rows.map((row) => row.kind)).toEqual(['thinking', 'tool'])
    expect(view.startedAt).toBe(1)
  })

  it('空白推理不占一行', () => {
    const view = buildStepGroup([{ kind: 'thinking', key: 't', text: '  \n ' }])
    expect(view.rows).toEqual([])
  })

  // 收尾信号和反问卡片自己就在别处，再各占一行就是一件事说两遍
  it('done 和 ask_user 不上行，失败的 done 例外', () => {
    const quiet = buildStepGroup([
      process([
        call('done', {}, 1, 'd1'),
        result('done', { success: true }, 2, { toolCallId: 'd1' }),
        call('ask_user', {}, 3, 'a1')
      ])
    ])
    expect(quiet.rows).toEqual([])

    const failed = buildStepGroup([
      process([result('done', { success: false, error: '格式不对' }, 1)])
    ])
    expect(failed.rows[0]).toMatchObject({ toolName: 'done', status: 'failed' })
  })

  it('工具自己报的进度挂到那一步上，不另起一行', () => {
    const view = buildStepGroup([
      process([
        call('generate_image', { prompt: '拱门' }, 1, 'c1'),
        {
          type: 'notify-users',
          data: { notifyType: 'progress', message: '正在出图（1 张）', toolCallId: 'c1' },
          timestamp: 2
        }
      ])
    ])

    expect(view.rows).toHaveLength(1)
    expect(view.rows[0]).toMatchObject({ progress: '正在出图（1 张）' })
  })

  it('不属于任何一步的通知单独成行，连着重复的只留一条', () => {
    const notify = (message: string, timestamp: number): AgentProcessItem => ({
      type: 'notify-users',
      data: { notifyType: 'info', message },
      timestamp
    })
    const view = buildStepGroup([
      process([notify('上下文已压缩', 1), notify('上下文已压缩', 2), notify('知识库命中', 3)])
    ])
    expect(view.rows.map((row) => row.kind === 'note' && row.text)).toEqual([
      '上下文已压缩',
      '知识库命中'
    ])
  })

  it('按工具统计次数，按第一次出现的顺序', () => {
    const view = buildStepGroup([
      process([
        call('search_assets', {}, 1, 'a'),
        call('library_overview', {}, 2, 'b'),
        call('search_assets', {}, 3, 'c')
      ])
    ])
    expect(view.toolCounts).toEqual([
      { toolName: 'search_assets', count: 2 },
      { toolName: 'library_overview', count: 1 }
    ])
    expect(view.toolCount).toBe(3)
  })

  /**
   * 生图出来的是交付物，铺在段落下面；截图是 agent 给自己看的，收在过程里。
   * 按工具分，不按图长什么样猜。
   */
  it('生图的图算产出，截图的图算看过的', () => {
    const view = buildStepGroup([
      process([
        call('generate_image', {}, 1, 'g'),
        result(
          'generate_image',
          { success: true, image_paths: ['C:/out/a.png', 'C:/out/b.png'] },
          2,
          {
            toolCallId: 'g'
          }
        ),
        call('ue_screenshot', {}, 3, 's'),
        result('ue_screenshot', { success: true, screenshot_path: 'C:/shots/1.png' }, 4, {
          toolCallId: 's'
        })
      ])
    ])

    expect(view.deliverableImages).toHaveLength(2)
    expect(view.viewedImageCount).toBe(1)
    const shot = view.rows[1]
    expect(shot.kind === 'tool' && shot.images).toEqual([])
    expect(shot.kind === 'tool' && shot.viewedImages).toHaveLength(1)
  })

  it('同一个文件改几次算一个', () => {
    const change = { path: 'C:/p/a.cpp', before: '', after: 'x', created: false }
    const view = buildStepGroup([
      process([
        result('edit_local_file', { success: true, fileChange: change }, 1),
        result('edit_local_file', { success: true, fileChange: { ...change, after: 'y' } }, 2)
      ])
    ])
    expect(view.fileChangeCount).toBe(1)
  })

  it('子任务按一路一行', () => {
    const view = buildStepGroup([
      process([
        {
          type: 'tool-call',
          data: { id: 'sub1', function: { name: 'task', arguments: '{"prompt":"建平台模型"}' } },
          timestamp: 1
        }
      ])
    ])
    expect(view.rows[0]).toMatchObject({ kind: 'subtask' })
    expect(view.rows[0].kind === 'subtask' && view.rows[0].lane.title).toBe('建平台模型')
  })
})

describe('readStepTarget', () => {
  it('按字段优先级取第一个有字的', () => {
    expect(readStepTarget({ vault: 'x', folder: '/Game/Blueprints', limit: 5 })).toBe(
      '/Game/Blueprints'
    )
  })

  it('只取第一行，太长就截断', () => {
    expect(readStepTarget({ script: '\nimport unreal\nprint(1)' })).toBe('import unreal')
    expect(readStepTarget({ query: 'a'.repeat(100) })).toHaveLength(60)
  })

  it('网址只留域名和路径', () => {
    expect(readStepTarget({ url: 'https://docs.unrealengine.com/5.3/en-US/?x=1' })).toBe(
      'docs.unrealengine.com/5.3/en-US'
    )
  })

  it('说不出对象就是空串，不拿 JSON 凑', () => {
    expect(readStepTarget({ limit: 5, items: ['a'] })).toBe('')
  })
})
