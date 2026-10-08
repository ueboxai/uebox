import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../ai/store', () => ({ readSettings: vi.fn() }))

import { teamModelCandidates, type TeamModel } from '../../../../shared/agentTeam'
import type { SubAgentResult } from '../../tools/builtin/task'
import { createTeamStore, type TeamStore } from './teamStore'
import { createTeamTools, type RunMemberInput, type TeamToolDeps } from './teamTools'
import { assignMemberModel, loadTeamModels, routeMember, type TeamModels } from './teamModels'
import { buildTeamStatus } from './teamStatus'

const CLAUDE: TeamModel = { providerId: 'anthropic', modelId: 'claude-opus-5-5' }
const DEEPSEEK: TeamModel = { providerId: 'deepseek', modelId: 'deepseek-chat' }
const GPT: TeamModel = { providerId: 'openai', modelId: 'gpt-6' }

const PROVIDERS = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    kind: 'chat' as const,
    models: [
      {
        id: 'claude-opus-5-5',
        displayName: 'Claude Opus 5.5',
        supportsVision: true,
        contextWindow: 1_000_000
      }
    ]
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    kind: 'chat' as const,
    models: [
      { id: 'deepseek-chat', displayName: 'DeepSeek V4', contextWindow: 128_000 },
      // 明确标了不能调工具：队员干活全靠工具，不进名单
      { id: 'deepseek-ocr', supportsTools: false }
    ]
  },
  { id: 'openai', displayName: 'OpenAI', kind: 'chat' as const, models: [{ id: 'gpt-6' }] },
  // 不是对话类来源：不进名单
  { id: 'img', displayName: '生图', kind: 'image' as const, models: [{ id: 'flux' }] }
]

describe('队员能用的模型', () => {
  it('只收对话类来源、去掉明确不能调工具的，顺序同设置页', () => {
    const list = teamModelCandidates(PROVIDERS)
    expect(list.map((c) => c.key)).toEqual([
      'anthropic/claude-opus-5-5',
      'deepseek/deepseek-chat',
      'openai/gpt-6'
    ])
    expect(list[0]).toMatchObject({
      name: 'Claude Opus 5.5',
      providerName: 'Anthropic',
      vision: true
    })
    // 没填能力位的按「不知道」留着，展示名缺省用 id
    expect(list[2]).toMatchObject({ name: 'gpt-6', vision: false })
  })

  it('派活时模型用不了：改用制作人的，不报错', async () => {
    const models: TeamModels = {
      candidates: teamModelCandidates(PROVIDERS),
      producer: CLAUDE,
      isAvailable: async (m) => m.providerId !== 'deepseek'
    }
    const base = { name: 'A', persona: 'a', readOnly: false, hiredAt: 1 }
    await expect(
      routeMember(models, { ...base, tier: 'strong', model: DEEPSEEK })
    ).resolves.toEqual({ used: CLAUDE, fellBack: true })
    await expect(routeMember(models, { ...base, tier: 'strong', model: GPT })).resolves.toEqual({
      pin: GPT,
      used: GPT,
      fellBack: false
    })
    // 老名册：strong 跟着制作人，fast 说不准是哪个
    await expect(routeMember(models, { ...base, tier: 'strong' })).resolves.toEqual({
      used: CLAUDE,
      fellBack: false
    })
    await expect(routeMember(models, { ...base, tier: 'fast' })).resolves.toEqual({
      fellBack: false
    })
  })
})

describe('招人挑模型、派活用模型', () => {
  let dir: string
  let store: TeamStore
  let runs: RunMemberInput[]
  const ok = (text: string): SubAgentResult => ({ text, messageCount: 1 })

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'team-models-'))
    store = createTeamStore({ stateDir: join(dir, 'state'), workspaceDir: join(dir, 'ws') })
    await store.ensure()
    runs = []
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function teamModels(over: Partial<TeamModels> = {}): TeamModels {
    return {
      candidates: teamModelCandidates(PROVIDERS),
      producer: CLAUDE,
      isAvailable: async () => true,
      ...over
    }
  }

  function tools(over: Partial<TeamToolDeps> = {}): {
    byName: Record<string, ReturnType<typeof createTeamTools>[number]>
    call: (name: string, args: unknown) => Promise<string>
  } {
    const list = createTeamTools({
      store,
      objective: '做一个跳台关卡',
      namespaces: ['ue.actor'],
      runMember: async (input) => {
        runs.push(input)
        return ok('好了')
      },
      runAcceptance: async () => 'VERDICT: PASS',
      ...over
    })
    const byName = Object.fromEntries(list.map((tool) => [tool.name, tool]))
    const call = async (name: string, args: unknown): Promise<string> => {
      const result = await byName[name]!.execute('call-1', args as never)
      return result.content.map((c) => ('text' in c ? c.text : '')).join('')
    }
    return { byName, call }
  }

  it('只有一个模型：参数里没有 model，新人钉成制作人的模型', async () => {
    const { byName, call } = tools({
      models: teamModels({ candidates: teamModelCandidates(PROVIDERS.slice(2, 3)), producer: GPT })
    })
    const schema = JSON.stringify(byName.team_hire!.parameters)
    expect(schema).not.toMatch(/model/)
    expect(byName.team_hire!.description).not.toMatch(/可用模型/)
    await expect(call('team_hire', { name: '搭建', role: '搭' })).resolves.toMatch(/已招入 搭建。/)
    expect(await store.findMember('搭建')).toMatchObject({ model: GPT, modelBy: 'producer' })
  })

  it('多个模型：说明里列出候选和事实，标出制作人自己用的', () => {
    const { byName } = tools({ models: teamModels() })
    const description = byName.team_hire!.description
    expect(description).toMatch(
      /- anthropic\/claude-opus-5-5：Claude Opus 5\.5（Anthropic，能看图，上下文 1M） ← 你自己用的/
    )
    expect(description).toMatch(
      /- deepseek\/deepseek-chat：DeepSeek V4（DeepSeek，看不了图，上下文 128k）\n/
    )
    expect(description).not.toMatch(/deepseek-ocr/)
  })

  it('挑了和制作人不同的模型要写理由；挑一样的不用', async () => {
    const { call } = tools({ models: teamModels() })
    await expect(
      call('team_hire', { name: '搭建', role: '搭', model: 'deepseek/deepseek-chat' })
    ).rejects.toThrow(/model_reason/)
    await expect(
      call('team_hire', {
        name: '搭建',
        role: '搭',
        model: 'deepseek/deepseek-chat',
        model_reason: '活多量大，用便宜的'
      })
    ).resolves.toMatch(/已招入 搭建（DeepSeek V4：活多量大，用便宜的）/)
    await expect(
      call('team_hire', { name: '策划', role: '想', model: 'anthropic/claude-opus-5-5' })
    ).resolves.toMatch(/已招入 策划（Claude Opus 5\.5）/)
    expect(await store.findMember('搭建')).toMatchObject({
      model: DEEPSEEK,
      modelReason: '活多量大，用便宜的',
      modelBy: 'producer'
    })
  })

  it('填了名单外的模型：报出可选的', async () => {
    const { call } = tools({ models: teamModels() })
    await expect(
      call('team_hire', { name: 'A', role: 'a', model: 'deepseek/deepseek-ocr', model_reason: 'x' })
    ).rejects.toThrow(/没有「deepseek\/deepseek-ocr」.*可选：anthropic\/claude-opus-5-5、deepseek/)
  })

  it('改设定不提模型：模型、理由、谁定的都不变', async () => {
    const { call } = tools({ models: teamModels() })
    await store.putMember({
      name: '审核',
      persona: '旧',
      tier: 'strong',
      model: GPT,
      modelBy: 'user',
      readOnly: true,
      hiredAt: 1
    })
    await expect(call('team_hire', { name: '审核', role: '新', read_only: true })).resolves.toMatch(
      /已更新 审核（gpt-6，用户定的；只读）/
    )
    expect(await store.findMember('审核')).toMatchObject({
      persona: '新',
      model: GPT,
      modelBy: 'user',
      hiredAt: 1
    })
  })

  it('用户换了制作人的模型，已招的队员不跟着换', async () => {
    const first = tools({ models: teamModels() })
    await first.call('team_hire', { name: '搭建', role: '搭' })
    const later = tools({ models: teamModels({ producer: GPT }) })
    await later.call('team_send', { to: '搭建', message: '搭一段' })
    expect(runs[0]!.pin).toEqual(CLAUDE)
  })

  it('派活钉上它的模型，回话抬头说是谁干的，并记进账', async () => {
    const { call } = tools({ models: teamModels() })
    await store.putMember({
      name: '搭建',
      persona: 'a',
      tier: 'strong',
      model: DEEPSEEK,
      readOnly: false,
      hiredAt: 1
    })
    await expect(call('team_send', { to: '搭建', message: '搭一段\n细节' })).resolves.toMatch(
      /^搭建（DeepSeek V4） 回话：\n好了/
    )
    expect(runs[0]!.pin).toEqual(DEEPSEEK)
    expect(await store.activity()).toEqual([
      expect.objectContaining({ who: '搭建', what: '搭一段', model: DEEPSEEK })
    ])
  })

  it('它的模型用不了：不钉，这件活用制作人的，回话里说一声', async () => {
    const { call } = tools({
      models: teamModels({ isAvailable: async (m) => m.providerId !== 'deepseek' })
    })
    await store.putMember({
      name: '搭建',
      persona: 'a',
      tier: 'strong',
      model: DEEPSEEK,
      readOnly: false,
      hiredAt: 1
    })
    await expect(call('team_send', { to: '搭建', message: '搭' })).resolves.toMatch(
      /^搭建（它的模型 DeepSeek V4 现在用不了，这件活改用你的模型） 回话：/
    )
    expect(runs[0]!.pin).toBeUndefined()
    expect((await store.activity())[0]!.model).toEqual(CLAUDE)
  })

  it('排队期间用户换了模型：轮到它时用新的', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { call } = tools({
      models: teamModels(),
      runMember: async (input) => {
        runs.push(input)
        if (runs.length === 1) await gate
        return ok('好了')
      }
    })
    await store.putMember({
      name: '搭建',
      persona: 'a',
      tier: 'strong',
      model: DEEPSEEK,
      readOnly: false,
      hiredAt: 1
    })
    const first = call('team_send', { to: '搭建', message: '一' })
    const second = call('team_send', { to: '搭建', message: '二' })
    await new Promise((r) => setTimeout(r, 10))
    const member = (await store.findMember('搭建'))!
    await store.putMember({ ...member, model: GPT, modelBy: 'user' })
    release()
    await Promise.all([first, second])
    expect(runs.map((r) => r.pin)).toEqual([DEEPSEEK, GPT])
  })
})

describe('team_status 的名册', () => {
  let dir: string
  let store: TeamStore

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'team-models-status-'))
    store = createTeamStore({ stateDir: join(dir, 'state'), workspaceDir: join(dir, 'ws') })
    await store.ensure()
    await store.putMember({
      name: '审核',
      persona: 'a',
      tier: 'strong',
      model: GPT,
      modelBy: 'user',
      readOnly: true,
      hiredAt: 1
    })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('标出各自用哪个模型、哪个是用户定的；只有一个模型时不标', async () => {
    const models: TeamModels = {
      candidates: teamModelCandidates(PROVIDERS),
      producer: CLAUDE,
      isAvailable: async () => true
    }
    await expect(buildTeamStatus({ store, sessionId: 's1', models })).resolves.toMatch(
      /- 审核（gpt-6，用户定的）：空闲/
    )
    await expect(
      buildTeamStatus({
        store,
        sessionId: 's1',
        models: { ...models, candidates: models.candidates.slice(0, 1) }
      })
    ).resolves.toMatch(/- 审核：空闲/)
  })
})

describe('用户在任务板上换模型', () => {
  let dir: string
  let store: TeamStore
  const candidates = teamModelCandidates(PROVIDERS)

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'team-models-assign-'))
    store = createTeamStore({ stateDir: join(dir, 'state'), workspaceDir: join(dir, 'ws') })
    await store.ensure()
    await store.putMember({
      name: '搭建',
      persona: 'a',
      tier: 'strong',
      model: DEEPSEEK,
      modelReason: '活多量大',
      modelBy: 'producer',
      readOnly: false,
      hiredAt: 1
    })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('记成用户定的，清掉制作人原来的理由', async () => {
    await expect(assignMemberModel(store, candidates, '搭建', GPT)).resolves.toEqual({
      success: true
    })
    const member = await store.findMember('搭建')
    expect(member).toMatchObject({ model: GPT, modelBy: 'user' })
    expect(member?.modelReason).toBeUndefined()
  })

  it('名单外的模型、不存在的队员都拒掉，名册不动', async () => {
    await expect(
      assignMemberModel(store, candidates, '搭建', {
        providerId: 'deepseek',
        modelId: 'deepseek-ocr'
      })
    ).resolves.toMatchObject({ success: false })
    await expect(assignMemberModel(store, candidates, '没这人', GPT)).resolves.toMatchObject({
      success: false
    })
    expect(await store.findMember('搭建')).toMatchObject({ model: DEEPSEEK, modelBy: 'producer' })
  })

  it('和另一个 store 实例同时改名册：两边的改动都在', async () => {
    const other = createTeamStore({ stateDir: join(dir, 'state'), workspaceDir: join(dir, 'ws') })
    await Promise.all([
      assignMemberModel(store, candidates, '搭建', GPT),
      other.putMember({ name: '审核', persona: 'b', tier: 'strong', readOnly: true, hiredAt: 2 })
    ])
    const roster = await store.roster()
    expect(roster.map((m) => m.name).sort()).toEqual(['审核', '搭建'])
    expect(roster.find((m) => m.name === '搭建')?.model).toEqual(GPT)
  })
})

describe('候选名单的 id', () => {
  it('来源和模型 id 拼出来撞上时加序号，两个都留着', () => {
    const list = teamModelCandidates([
      { id: 'or', kind: 'chat', models: [{ id: 'x/y' }] },
      { id: 'or/x', kind: 'chat', models: [{ id: 'y' }] }
    ])
    expect(list.map((c) => [c.providerId, c.modelId, c.key])).toEqual([
      ['or', 'x/y', 'or/x/y'],
      ['or/x', 'y', 'or/x/y#2']
    ])
  })
})

describe('派活时能不能用，和任务板同一条规矩', () => {
  it('标了不能调工具的模型算用不了', async () => {
    const { readSettings } = await import('../../../ai/store')
    vi.mocked(readSettings).mockResolvedValue({
      version: 1,
      roles: {},
      providers: [
        {
          id: 'deepseek',
          displayName: 'DeepSeek',
          kind: 'chat',
          models: [{ id: 'deepseek-chat' }, { id: 'deepseek-ocr', supportsTools: false }]
        }
      ]
    } as never)
    const models = (await loadTeamModels(CLAUDE))!
    await expect(models.isAvailable(DEEPSEEK)).resolves.toBe(true)
    await expect(
      models.isAvailable({ providerId: 'deepseek', modelId: 'deepseek-ocr' })
    ).resolves.toBe(false)
    await expect(models.isAvailable(GPT)).resolves.toBe(false)
  })
})
