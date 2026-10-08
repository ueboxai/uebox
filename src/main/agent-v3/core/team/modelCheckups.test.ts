import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModelCheckup, TeamModel } from '../../../../shared/agentTeam'
import {
  CHECKUP_FAIL_TTL_MS,
  CHECKUP_PASS_TTL_MS,
  checkupPassed,
  loadModelCheckups
} from './modelCheckups'

const M: TeamModel = { providerId: 'gw', modelId: 'm' }
const pass = (at: number): ModelCheckup => ({ at, reachable: true, tools: 'ok' })
const fail = (at: number): ModelCheckup => ({ at, reachable: true, tools: 'fail' })

describe('入职体检的缓存', () => {
  let dir: string
  let file: string
  let clock: number
  const now = (): number => clock

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'checkups-'))
    file = join(dir, 'sub', 'model-checkups.json')
    clock = 1_000
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('过了的一个月内不重测；换了地址就重测；存盘后重开还认得', async () => {
    const run = vi.fn(async () => pass(clock))
    const checkups = await loadModelCheckups(file, now)
    await checkups.ensure({ model: M, baseUrl: 'a', run })
    clock += CHECKUP_PASS_TTL_MS - 1
    await checkups.ensure({ model: M, baseUrl: 'a', run })
    expect(run).toHaveBeenCalledOnce()
    await checkups.ensure({ model: M, baseUrl: 'b', run })
    expect(run).toHaveBeenCalledTimes(2)

    const reopened = await loadModelCheckups(file, now)
    expect(reopened.known(M)).toMatchObject({ reachable: true, tools: 'ok' })
    await reopened.ensure({ model: M, baseUrl: 'b', run })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('没过的只记一会儿：用户修好了再挑它时会重测', async () => {
    const run = vi.fn(async () => fail(clock))
    const checkups = await loadModelCheckups(file, now)
    await checkups.ensure({ model: M, baseUrl: 'a', run })
    await checkups.ensure({ model: M, baseUrl: 'a', run })
    expect(run).toHaveBeenCalledOnce()
    clock += CHECKUP_FAIL_TTL_MS
    await checkups.ensure({ model: M, baseUrl: 'a', run })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('同一个模型同时要两次只测一次', async () => {
    let release: () => void = () => undefined
    const run = vi.fn(
      () => new Promise<ModelCheckup>((resolve) => (release = () => resolve(pass(clock))))
    )
    const checkups = await loadModelCheckups(file, now)
    const both = Promise.all([
      checkups.ensure({ model: M, baseUrl: 'a', run }),
      checkups.ensure({ model: M, baseUrl: 'a', run })
    ])
    release()
    await both
    expect(run).toHaveBeenCalledOnce()
  })

  it('不通、不会调工具算没过；只是看不了图不算', () => {
    expect(checkupPassed(pass(0))).toBe(true)
    expect(checkupPassed(fail(0))).toBe(false)
    expect(checkupPassed({ at: 0, reachable: false, tools: 'fail' })).toBe(false)
    expect(checkupPassed({ ...pass(0), vision: 'fail' })).toBe(true)
  })
})
