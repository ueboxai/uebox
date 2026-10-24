/** @vitest-environment node */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import type { UnrealAgentTool } from '../../tools/defineTool'
import type { SubAgentResult } from '../../tools/builtin/task'
import type { RunMemberInput, TeamToolDeps } from './teamTools'
import { editorKeyActive } from './editorKey'
import { createExternalTeamRegistry, type ExternalTeamRegistry } from './externalTeam'
import { createExternalTeamSession } from './externalTeamTools'
import {
  createHybridTeamHost,
  HYBRID_SEND_WAIT_MS,
  hybridParentContext,
  type HybridTeamDeps,
  type HybridTeamHost
} from './hybridTeam'
import { createHybridProducerTools, withProducerMailbox } from './hybridTeamTools'
import { buildProducerBrief } from './teamPrompt'
import { createTeamStore, PRODUCER, type TeamStore } from './teamStore'

/**
 * 混合团队的宿主（docs/混合团队设计-2026-10-24.md 第 2 节）：制作人在外部客户端，
 * 队员是盒子里的子 Agent。模型怎么干活不在这里测（假的 runMember 代替），
 * 量的是宿主这一侧：后台派活、等结果、信箱、当场插话、写工程作废验收、取消不杀队员。
 */

let dir: string
let registry: ExternalTeamRegistry
let store: TeamStore
let noted: string[]
const hosts: HybridTeamHost[] = []

/** 一件活怎么跑由用例定。默认：立刻交回 */
let behave: (input: RunMemberInput) => Promise<SubAgentResult>
let seen: Array<{ parent: { sessionId: string; externalClient?: boolean }; editorKey: boolean }>

const done = (text: string): SubAgentResult => ({ text, messageCount: 1 })

function deps(): HybridTeamDeps {
  return {
    store,
    namespaces: ['ue.level'],
    jobScope: async () => ({
      parent: hybridParentContext({
        shellAvailable: true,
        userInstructions: '',
        uiLanguage: 'zh-CN',
        editorScreenshotEnabled: true,
        ueConnected: false,
        runtime: { runtimeScopeId: 'rt-test', observedAt: 'now', engineLink: 'none' }
      }),
      run: (fn) => fn()
    }),
    runTool: (_record, fn) => fn(),
    runners: (parentOf): Pick<TeamToolDeps, 'runMember' | 'runAcceptance'> => ({
      runMember: async (input) => {
        seen.push({ parent: parentOf(), editorKey: editorKeyActive() })
        return behave(input)
      },
      runAcceptance: async () => 'VERDICT: PASS — ok'
    }),
    noteWrite: async (id) => {
      noted.push(id)
    }
  }
}

async function open(): Promise<HybridTeamHost> {
  const record = await registry.create({ objective: '做一个塔防', members: 'box' })
  store = createTeamStore(registry.dirsFor(record.id))
  const host = await createHybridTeamHost(record, deps())
  hosts.push(host)
  await host.call('team_hire', { name: '策划', role: '写设计文档' })
  return host
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hybrid-team-'))
  registry = createExternalTeamRegistry({
    dirsFor: (id) => ({ stateDir: join(dir, `${id}.team`), workspaceDir: join(dir, id, 'ws') }),
    stateRoot: () => dir
  })
  noted = []
  seen = []
  behave = async (input) => done(`做完了：${input.message.split('\n').at(-1)}`)
})

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.dispose()))
  rmSync(dir, { recursive: true, force: true })
})

describe('混合团队的宿主', () => {
  it('派活一律后台：马上回来，结论进制作人信箱，team_wait 取得到，取过不再给', async () => {
    const host = await open()
    let finish!: () => void
    behave = () => new Promise((resolve) => (finish = () => resolve(done('设计文档写好了'))))

    expect(await host.send({ to: '策划', message: '写设计文档' })).toContain('在后台干')
    await vi.waitFor(() => expect(finish).toBeDefined())
    expect(host.live.pendingJobs().map((j) => j.member)).toEqual(['策划'])

    const waiting = host.wait(60_000)
    finish()
    const got = await waiting
    expect(got).toContain('【交活】策划')
    expect(got).toContain('设计文档写好了')
    expect(await host.drain()).toBe('')
    expect(await host.wait(1000)).toBe('没有在干的活，也没有新消息。')
  })

  it('父上下文：团队 id 当会话、不带 externalClient、自动审批、模型请求排队；队员跑在编辑器钥匙之外由 runTool 决定', async () => {
    const host = await open()
    await host.send({ to: '策划', message: '写', wait: true })
    const [{ parent }] = seen
    expect(parent.sessionId).toBe(host.teamId)
    expect(parent.externalClient).toBeUndefined()
    expect(parent).toMatchObject({
      approvalMode: 'yolo',
      pacedRequests: true,
      thinkingLevel: 'auto'
    })
    expect((parent as { team?: { store?: unknown } }).team?.store).toBe(store)
  })

  it('wait=true 等到它交回；结论在信箱里，下一次调用附上', async () => {
    const host = await open()
    expect(await host.send({ to: '策划', message: '写', wait: true })).toBe(
      '策划 交回了，结论在下面。'
    )
    expect(await host.drain()).toContain('做完了：写')
  })

  it('wait=true 等到点就回来，活接着在后台干', async () => {
    // 只假计时器和时钟：落盘是真的 I/O，要靠 setImmediate 让它走完
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    })
    try {
      const host = await open()
      behave = () => new Promise(() => undefined)
      let reply: string | undefined
      void host.send({ to: '策划', message: '写', wait: true }).then((text) => (reply = text))
      for (let minute = 0; minute < 20 && reply === undefined; minute++) {
        for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
        await vi.advanceTimersByTimeAsync(60_000)
      }
      expect(reply).toContain('还没交回')
      expect(host.live.pendingJobs()).toHaveLength(1)
      expect(Date.now()).toBeGreaterThanOrEqual(HYBRID_SEND_WAIT_MS)
    } finally {
      vi.useRealTimers()
    }
  })

  it('客户端取消这次调用不杀队员：活用宿主自己的中止信号', async () => {
    const host = await open()
    let signal: AbortSignal | undefined
    let finish!: () => void
    behave = (input) => {
      signal = input.signal
      return new Promise((resolve) => (finish = () => resolve(done('照样交回'))))
    }
    const client = new AbortController()
    const sent = host.send({ to: '策划', message: '写', wait: true }, client.signal)
    await vi.waitFor(() => expect(signal).toBeDefined())
    client.abort()
    await sent
    expect(signal!.aborted).toBe(false)
    finish()
    expect(await host.wait(60_000)).toContain('照样交回')

    // 团队结束才停
    behave = (input) => {
      signal = input.signal
      return new Promise(() => undefined)
    }
    await host.send({ to: '策划', message: '再写' })
    await vi.waitFor(() => expect(signal?.aborted).toBe(false))
    await host.dispose()
    expect(signal!.aborted).toBe(true)
  })

  it('制作人发的 team_message 当场插进正在干活的队员；队员发给制作人的进信箱，交到手上才算读到', async () => {
    const host = await open()
    let heard: string | undefined
    let finish!: () => void
    behave = async (input) => {
      // 盒子里的子 Agent 开跑时就这样登记（createAgent 的 attachTeamLive）
      const detach = host.live.attach(input.member.name, { steer: (text) => (heard = text) })
      await host.live.send(input.member.name, PRODUCER, '关卡要几层？')
      await new Promise<void>((resolve) => (finish = resolve))
      await detach()
      return done('写完了')
    }
    await host.send({ to: '策划', message: '写设计文档' })
    await vi.waitFor(() => expect(finish).toBeDefined())

    const reply = await host.call('team_message', { to: '策划', text: '三层' })
    expect(JSON.stringify(reply.content)).toContain('插进它的下一步')
    expect(heard).toContain('三层')

    const question = await host.wait(60_000)
    expect(question).toContain('关卡要几层？')
    const mail = (await store.mail()).find((m) => m.text === '关卡要几层？')
    expect(mail?.readAt).toBeDefined()
    finish()
  })

  it('队员写过工程（含停下）就记一笔，之前的验收作废；只读的活不记', async () => {
    const host = await open()
    behave = async (input) => {
      input.ledger.start('w1', 'ue_set_property', {})
      input.ledger.end('w1', true)
      return done('改好了')
    }
    await host.send({ to: '策划', message: '改', wait: true })
    expect(noted).toEqual([host.teamId])

    behave = async () => done('只看了看')
    await host.send({ to: '策划', message: '看', wait: true })
    expect(noted).toHaveLength(1)
  })

  it('用量、活的账记进团队：任务板上看得到', async () => {
    const host = await open()
    behave = async (input) => {
      input.keepUsage?.({
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        total: 120,
        cost: 0,
        unpriced: 0
      })
      return done('写好了')
    }
    await host.send({ to: '策划', message: '写设计文档', wait: true })
    const [job] = await store.jobs()
    expect(job).toMatchObject({ member: '策划', outcome: 'done' })
    expect((await store.usage()).total.total).toBe(120)
  })

  it('到点没消息：说清谁还在干', async () => {
    const host = await open()
    behave = () => new Promise(() => undefined)
    await host.send({ to: '策划', message: '写' })
    expect(await host.wait(50)).toMatch(/秒内没有新消息。还在干：策划 \(0 min\)/)
  })
})

// ── 制作人连接：门 + 精简工具集 ────────────────────────────────────────

describe('混合团队的制作人连接', () => {
  function producerConnection(): {
    call: (name: string, args?: Record<string, unknown>) => Promise<string>
    tools: UnrealAgentTool<never>[]
    hostOf: (id: string) => Promise<HybridTeamHost>
  } {
    const made = new Map<string, Promise<HybridTeamHost>>()
    const ready = new Map<string, HybridTeamHost>()
    const hostOf = (id: string): Promise<HybridTeamHost> => {
      let host = made.get(id)
      if (!host) {
        host = registry.get(id).then(async (record) => {
          store = createTeamStore(registry.dirsFor(id))
          const h = await createHybridTeamHost(record!, deps())
          hosts.push(h)
          ready.set(id, h)
          return h
        })
        made.set(id, host)
      }
      return host
    }
    const storeFor = (id: string): TeamStore => createTeamStore(registry.dirsFor(id))
    const team = createExternalTeamSession({
      registry,
      storeFor,
      namespaces: ['ue.level'],
      resolveTarget: (projectPath) => ({ projectPath }),
      hosted: {
        brief: async (record) => {
          ;(await hostOf(record.id)).update(record)
          return buildProducerBrief({
            objective: record.objective,
            workspaceDir: 'ws',
            hybrid: { teamId: record.id }
          })
        }
      }
    })
    const tools = team.guard(
      withProducerMailbox(
        [
          ...team.tools.filter((t) => ['team_open', 'team_list', 'team_gate'].includes(t.name)),
          ...createHybridProducerTools({
            teamOf: team.producerTeam,
            hostOf,
            namespaces: ['ue.level']
          })
        ],
        { teamOf: team.producerTeam, running: (id) => ready.get(id) }
      )
    )
    let seq = 0
    return {
      tools,
      hostOf,
      call: async (name, args = {}) => {
        const tool = tools.find((t) => t.name === name)
        if (!tool) throw new Error(`没有 ${name}`)
        const result = await tool.execute(`p${++seq}`, args as never)
        return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
      }
    }
  }

  it('team_open 开的是盒子托管队员的团队：须知是混合版，没有 team_deliver，记下思考档位', async () => {
    const conn = producerConnection()
    const text = await conn.call('team_open', { objective: '做一个塔防', thinking_level: 'high' })
    expect(text).toContain('team_wait')
    expect(text).not.toContain('team_deliver')
    expect(text).not.toContain('team_join')
    const [record] = await registry.list()
    expect(record).toMatchObject({ members: 'box', approvalMode: 'yolo', thinkingLevel: 'high' })
  })

  it('招人、派活、等结果；队员给制作人的话附在下一个工具结果后面', async () => {
    const conn = producerConnection()
    await conn.call('team_open', { objective: '做一个塔防' })
    expect(await conn.call('team_hire', { name: '策划', role: '写设计文档' })).toContain(
      '已招入 策划'
    )
    expect(await conn.call('team_send', { to: '策划', message: '写设计文档' })).toContain(
      'team_wait'
    )
    const result = await conn.call('team_wait', { seconds: 30 })
    expect(result).toContain('做完了：写设计文档')

    const [record] = await registry.list()
    const host = await conn.hostOf(record!.id)
    await host.live.send('策划', PRODUCER, '我把文档放进工作区了')
    expect(await conn.call('team_board', { action: 'list' })).toContain('我把文档放进工作区了')
  })

  it('混合团队不走 team_join；普通连接也开不了它', async () => {
    const conn = producerConnection()
    await conn.call('team_open', { objective: '做一个塔防' })
    await conn.call('team_hire', { name: '策划', role: '写设计文档' })
    const [record] = await registry.list()

    const plain = createExternalTeamSession({
      registry,
      storeFor: (id) => createTeamStore(registry.dirsFor(id)),
      namespaces: [],
      resolveTarget: (projectPath) => ({ projectPath })
    })
    const plainTools = plain.guard(plain.tools)
    const run = (name: string, args: Record<string, unknown>): Promise<unknown> =>
      plainTools.find((t) => t.name === name)!.execute('x', args as never)

    await expect(
      run('team_join', { team_id: record!.id, member: '策划', brief: '写' })
    ).rejects.toThrow('由盒子托管')
    await expect(run('team_open', { team_id: record!.id })).rejects.toThrow('X-Unreal-Box-Profile')
  })

  it('没进团队的连接调不了派活、等结果', async () => {
    const conn = producerConnection()
    await expect(conn.call('team_wait', {})).rejects.toThrow()
    await expect(conn.call('team_send', { to: '策划', message: 'x' })).rejects.toThrow()
  })
})

// ── 制作人须知 ──────────────────────────────────────────────────────────

describe('制作人须知', () => {
  const input = { objective: '做一个塔防 <游戏> & "x"', workspaceDir: 'C:\\ws\\team' }

  it('盒子里那一份一个字节都没变（改混合版之前量下的指纹）', () => {
    const brief = buildProducerBrief(input)
    expect(brief.length).toBe(4338)
    expect(createHash('sha256').update(brief).digest('hex')).toBe(
      '7b085343537acf2e6098b16a54981c698871c5ef3791df3cc77276a9c7975f36'
    )
  })

  it('混合版：带团队 id，派活后台 + team_wait，不提交付验收和编辑器看护', () => {
    const brief = buildProducerBrief({ ...input, hybrid: { teamId: 'ext-1' } })
    expect(brief).toContain('team id: ext-1')
    expect(brief).toContain('team_wait')
    expect(brief).toContain('`model_reason`')
    expect(brief).not.toContain('team_deliver')
    expect(brief).not.toContain('reopens the project')
    expect(brief.length).toBeLessThan(buildProducerBrief(input).length + 400)
  })
})
