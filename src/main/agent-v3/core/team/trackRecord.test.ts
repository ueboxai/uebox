import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { TeamModel, TrackRecordEntry } from '../../../../shared/agentTeam'
import { createTrackRecord, summarizeTrackRecord } from './trackRecord'

const DEEPSEEK: TeamModel = { providerId: 'deepseek', modelId: 'v4' }
const GPT: TeamModel = { providerId: 'openai', modelId: 'gpt-6' }

describe('履历', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'track-record-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('只追加，并行写不串行；写坏的半行跳过，不影响其余的', async () => {
    const file = join(dir, 'nested', 'track-record.jsonl')
    const record = createTrackRecord(file)
    await Promise.all(
      [1, 2, 3].map((at) => record.add({ kind: 'task', at, model: DEEPSEEK, outcome: 'done' }))
    )
    appendFileSync(file, '{"kind":"task","at":4,"mod')
    expect((await record.all()).map((e) => e.at)).toEqual([1, 2, 3])
    expect(await createTrackRecord(join(dir, 'none.jsonl')).all()).toEqual([])
  })

  it('一行话：按岗位类型分开、多的在前，打回和没干完照实写，本工程单独标', () => {
    const entries: TrackRecordEntry[] = [
      ...Array.from({ length: 3 }, (_, i) => ({
        kind: 'task' as const,
        at: i,
        model: DEEPSEEK,
        roleType: '搭建',
        outcome: 'done' as const,
        project: i === 0 ? 'D:/A' : 'D:/B'
      })),
      {
        kind: 'task',
        at: 9,
        model: DEEPSEEK,
        roleType: '搭建',
        outcome: 'unfinished',
        project: 'D:/B'
      },
      { kind: 'reopened', at: 10, model: DEEPSEEK, roleType: '搭建', project: 'D:/A' },
      { kind: 'task', at: 11, model: DEEPSEEK, outcome: 'done' },
      { kind: 'task', at: 12, model: GPT, roleType: '审核', outcome: 'done' }
    ]
    expect(summarizeTrackRecord(entries, DEEPSEEK, 'D:/A')).toBe(
      '搭建 4 件（被用户打回 1，没干完 1），本工程 1 件（被用户打回 1）；未分类 1 件'
    )
    // 全在本工程，就不重复标
    expect(summarizeTrackRecord(entries, GPT, undefined)).toBe('审核 1 件')
    expect(summarizeTrackRecord(entries, { providerId: 'x', modelId: 'y' })).toBe('')
  })
})
