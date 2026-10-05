/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))
vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import {
  assetGuidelinesTool,
  describeGuidelinesForImport,
  guidelineScanRoots,
  summarizeGuidelineCheck,
  type GuidelineApplyResponse,
  type GuidelineCheckResponse
} from './assetGuidelines'

const VT_MISSING: GuidelineCheckResponse = {
  guidelines: [
    {
      name: 'CitySampleVehicleGuideline_VT',
      asset: '/Game/CitySampleVehicles/AssetGuidelines/CitySampleVehicleGuideline_VT',
      class: '/Game/CitySampleVehicles/AssetGuidelines/CitySampleVehicleGuideline_VT.CitySampleVehicleGuideline_VT_C',
      settings: [
        {
          section: '/Script/Engine.RendererSettings',
          key: 'r.VirtualTextures',
          required: 'True',
          file: '/Config/DefaultEngine.ini',
          live: '0',
          status: 'missing'
        }
      ],
      plugins: []
    },
    {
      name: 'AlreadyFine',
      asset: '/Game/Other/AlreadyFine',
      class: '/Script/UnrealEd.AssetGuideline',
      settings: [
        {
          section: '/Script/Engine.RendererSettings',
          key: 'r.SkinCache.CompileShaders',
          required: 'True',
          file: '/Config/DefaultEngine.ini',
          current: 'True',
          live: '1',
          status: 'ok'
        }
      ],
      plugins: []
    }
  ],
  unmet_settings: 1,
  unmet_plugins: 0,
  pending_restart: 0,
  scanned_packages: 120
}

const NOTHING_LEFT: GuidelineCheckResponse = {
  ...VT_MISSING,
  guidelines: [
    {
      ...VT_MISSING.guidelines[0],
      settings: [{ ...VT_MISSING.guidelines[0].settings[0], current: 'True', status: 'pending_restart' }]
    }
  ],
  unmet_settings: 0,
  pending_restart: 1
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map((c) => c.text ?? '').join('')

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('guidelineScanRoots', () => {
  it('每个资产取 /Game 下第一层目录，指南作为依赖落在别的子目录也扫得到', () => {
    expect(
      guidelineScanRoots([
        '/Game/CitySampleVehicles/vehicle01/BP_Car.BP_Car',
        '/Game/CitySampleVehicles/vehicle02/BP_Van',
        '/Game/CitySampleCrowd/Character/Male/m_001/Face/m_001_nrw_FaceMesh'
      ])
    ).toEqual(['/Game/CitySampleVehicles', '/Game/CitySampleCrowd'])
  })

  it('直接放在 /Game 下的资产只扫它自己，不扫整个工程；非 /Game 路径忽略', () => {
    expect(guidelineScanRoots(['/Game/BP_Root.BP_Root', '/MyPlugin/X/Y', ''])).toEqual(['/Game/BP_Root'])
  })
})

describe('summaries', () => {
  it('没满足的列出来源资产、要的值和现在的值，并给出下一步', () => {
    const text = summarizeGuidelineCheck(VT_MISSING)
    expect(text).toContain('CitySampleVehicleGuideline_VT')
    expect(text).toContain('r.VirtualTextures = True（现在没设）')
    expect(text).toContain('ue_asset_guidelines(action="apply")')
    expect(text).toContain('移除指南')
    // 已满足的那张不列
    expect(text).not.toContain('AlreadyFine')
  })

  it('导入回执：全都满足时不说话', () => {
    expect(
      describeGuidelinesForImport({ ...VT_MISSING, guidelines: [VT_MISSING.guidelines[1]], unmet_settings: 0 })
    ).toBeNull()
  })

  it('导入回执：只差重启时如实说已写好', () => {
    const line = describeGuidelinesForImport(NOTHING_LEFT)
    expect(line).toContain('重启编辑器后生效')
    expect(line).not.toContain('⚠️')
  })
})

describe('ue_asset_guidelines', () => {
  it('apply 改整个工程，注册为 destructive（check 由 riskFor 降成 safe）', () => {
    expect(assetGuidelinesTool.unrealBox.risk).toBe('destructive')
  })

  it('check 把 paths 原样交给插件', async () => {
    callRequest.mockResolvedValueOnce(VT_MISSING)
    const result = await assetGuidelinesTool.execute('c1', {
      action: 'check',
      paths: ['/Game/CitySampleVehicles']
    })
    expect(callRequest).toHaveBeenCalledWith(
      'project.check_asset_guidelines',
      { paths: ['/Game/CitySampleVehicles'] },
      'conn-1',
      expect.any(Number),
      undefined
    )
    expect(textOf(result)).toContain('r.VirtualTextures')
  })

  it('apply 报的是磁盘上读回来的值，不是请求的值', async () => {
    const apply: GuidelineApplyResponse = {
      results: [
        {
          guideline: 'CitySampleVehicleGuideline_VT',
          section: '/Script/Engine.RendererSettings',
          key: 'r.VirtualTextures',
          required: 'True',
          file: 'D:/P/Config/DefaultEngine.ini',
          result: 'written',
          on_disk: 'true'
        }
      ],
      plugins_to_enable: [],
      written_count: 1,
      failed_count: 0,
      guidelines_matched: 1,
      restart_required: true
    }
    callRequest.mockResolvedValueOnce(apply).mockResolvedValueOnce(NOTHING_LEFT)
    const result = await assetGuidelinesTool.execute('c1', { action: 'apply' })
    const text = textOf(result)
    expect(text.split('\n')[0]).toBe('1 项已改好 / 0 项失败。')
    expect(text).toContain('r.VirtualTextures = true')
    expect(text).toContain('ue_restart_editor')
  })

  it('部分失败：第一句就说有失败，插件没装的逐条列出来', async () => {
    const apply: GuidelineApplyResponse = {
      results: [
        {
          guideline: 'G',
          section: '/Script/Engine.RendererSettings',
          key: 'r.VirtualTextures',
          required: 'True',
          file: 'D:/P/Config/DefaultEngine.ini',
          result: 'written',
          on_disk: 'True'
        },
        {
          guideline: 'G',
          section: '/Script/Engine.RendererSettings',
          key: 'r.GPUSkin.Support16BitBoneIndex',
          required: 'True',
          file: 'D:/P/Config/DefaultEngine.ini',
          result: 'failed',
          error: 'D:/P/Config/DefaultEngine.ini is read-only (probably locked by source control)'
        }
      ],
      plugins_to_enable: [
        { name: 'HairStrands', friendly_name: 'Groom', status: 'missing', guideline: 'G' },
        { name: 'Ghost', friendly_name: 'Ghost', status: 'not_installed', guideline: 'G' }
      ],
      written_count: 1,
      failed_count: 1,
      guidelines_matched: 1,
      restart_required: true
    }
    callRequest
      .mockResolvedValueOnce(apply)
      .mockResolvedValueOnce({ ok: true, success: true, requires_restart: true })
      .mockResolvedValueOnce(VT_MISSING)
    const result = await assetGuidelinesTool.execute('c1', { action: 'apply' })
    const text = textOf(result)
    expect(text.split('\n')[0]).toBe('2 项已改好 / 2 项失败。')
    expect(text).toContain('read-only')
    expect(text).toContain('✅ 已在工程里开启插件 Groom（HairStrands）')
    expect(text).toContain('❌ 插件 Ghost：本机没装')
    // 本机没装的插件不该去调 manage_plugin
    expect(callRequest.mock.calls.filter((c) => c[0] === 'system.manage_plugin')).toHaveLength(1)
  })

  it('老插件没有这条命令：说人话，不甩 Unknown method', async () => {
    callRequest.mockResolvedValueOnce({ ok: false, error: 'Unknown method: project.check_asset_guidelines' })
    await expect(assetGuidelinesTool.execute('c1', { action: 'check' })).rejects.toThrow('插件太旧')
  })
})
