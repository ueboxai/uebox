/**
 * 履历：每个模型在用户自己的项目里干过什么、结果怎样。
 *
 * 公开榜单说不出「在你的 UE 项目里谁蓝图连线靠谱」，这份账说得出（设计稿 5.5 节）。
 * 只记机器能确定的事实：交没交回来、用户有没有打回。不打综合分，不设自动换人的阈值 ——
 * 它是给制作人和用户看的证据，不是开关。
 *
 * 存在 `<userData>/team-models/track-record.jsonl`，一行一笔，只追加。
 * 跟着用户走、不跟着某个团队走：跨团队、跨工程攒起来才有样本。
 */

import { promises as fs } from 'fs'
import { dirname } from 'path'

import { sameTeamModel, type TeamModel, type TrackRecordEntry } from '../../../../shared/agentTeam'

export interface TrackRecord {
  add: (entry: TrackRecordEntry) => Promise<void>
  all: () => Promise<TrackRecordEntry[]>
}

export function createTrackRecord(file: string): TrackRecord {
  // 并行派活时几件活同时交回来，追加串起来，免得两行写进同一行
  let chain: Promise<unknown> = Promise.resolve()
  return {
    add: (entry) => {
      const next = chain.then(async () => {
        await fs.mkdir(dirname(file), { recursive: true })
        await fs.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
      })
      chain = next.catch(() => undefined)
      return next
    },
    all: async () => {
      let text = ''
      try {
        text = await fs.readFile(file, 'utf8')
      } catch {
        return []
      }
      const entries: TrackRecordEntry[] = []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          entries.push(JSON.parse(line) as TrackRecordEntry)
        } catch {
          // 写到一半断电留下的半行：跳过，别让整份账读不出来
        }
      }
      return entries
    }
  }
}

interface Tally {
  tasks: number
  reopened: number
  unfinished: number
}

function tallyOf(entries: TrackRecordEntry[]): Tally {
  return {
    tasks: entries.filter((e) => e.kind === 'task').length,
    reopened: entries.filter((e) => e.kind === 'reopened').length,
    unfinished: entries.filter((e) => e.kind === 'task' && e.outcome === 'unfinished').length
  }
}

function formatTally(t: Tally): string {
  const notes = [
    ...(t.reopened ? [`被用户打回 ${t.reopened}`] : []),
    ...(t.unfinished ? [`没干完 ${t.unfinished}`] : [])
  ]
  return `${t.tasks} 件${notes.length ? `（${notes.join('，')}）` : ''}`
}

/**
 * 一个模型的履历，一行话：按岗位类型分开（难的活干砸了不等于模型差），
 * 本工程的单独标出来（换了工程，经验不一定还管用）。没有记录给空串。
 *
 * 例：「搭建 12 件（被用户打回 2），本工程 5 件；审核 3 件」
 */
export function summarizeTrackRecord(
  entries: TrackRecordEntry[],
  model: TeamModel,
  project?: string
): string {
  const mine = entries.filter((e) => sameTeamModel(e.model, model))
  if (mine.length === 0) return ''
  const byRole = new Map<string, TrackRecordEntry[]>()
  for (const entry of mine) {
    const role = entry.roleType?.trim() || '未分类'
    byRole.set(role, [...(byRole.get(role) ?? []), entry])
  }
  return [...byRole.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([role, list]) => {
      const here = project ? list.filter((e) => e.project === project) : []
      const local =
        here.length && here.length < list.length ? `，本工程 ${formatTally(tallyOf(here))}` : ''
      return `${role} ${formatTally(tallyOf(list))}${local}`
    })
    .join('；')
}
