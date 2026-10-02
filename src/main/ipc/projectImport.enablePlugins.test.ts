/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

const { callRequest, liveProjects } = vi.hoisted(() => ({
  callRequest: vi.fn(),
  liveProjects: [] as Array<{ connectionId: string; projectPath: string }>
}))

vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))
vi.mock('../sqliteDataBase', () => ({ getVaultDatabase: () => ({}) }))
vi.mock('../sqliteDataBase/VaultManager', () => ({
  VaultManager: { getInstance: () => ({ getCurrentVault: () => null }) },
  VaultType: { REFERENCE: 'reference', BACKUP: 'backup', NETWORK: 'network' }
}))
vi.mock('../utils/UnrealPathManager', () => ({ default: {} }))
vi.mock('../services', () => ({
  serviceManager: { getWebSocketService: () => ({ callRequest }) }
}))
vi.mock('../services/project', () => ({
  projectManager: { getInteractiveProjects: () => liveProjects }
}))

import { enablePluginsForImport } from './projectImport'

describe('弹窗里点「开启插件」', () => {
  let dir = ''
  let uproject = ''

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ue-enable-ipc-'))
    uproject = path.join(dir, 'Game.uproject')
    await writeFile(uproject, JSON.stringify({ FileVersion: 3, Plugins: [] }))
    callRequest.mockReset()
    liveProjects.length = 0
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const pluginsOnDisk = async (): Promise<unknown> =>
    JSON.parse(await readFile(uproject, 'utf-8')).Plugins

  it('工程关着：不找编辑器，直接写文件', async () => {
    const result = await enablePluginsForImport(uproject, ['PoseSearch'])
    expect(result).toEqual({ success: true, enabled: ['PoseSearch'] })
    expect(callRequest).not.toHaveBeenCalled()
    expect(await pluginsOnDisk()).toEqual([{ Name: 'PoseSearch', Enabled: true }])
  })

  it('工程开着：先让编辑器自己开，免得它下次改插件时把文件冲掉', async () => {
    liveProjects.push({ connectionId: 'c1', projectPath: dir })
    // 新插件包：编辑器自己落盘
    callRequest.mockImplementation(async (_m: string, args: { plugin_name: string }) => {
      const data = JSON.parse(await readFile(uproject, 'utf-8'))
      data.Plugins.push({ Name: args.plugin_name, Enabled: true })
      await writeFile(uproject, JSON.stringify(data))
      return { plugin_name: args.plugin_name, is_enabled: true }
    })

    const result = await enablePluginsForImport(uproject, ['PoseSearch', 'MotionWarping'])
    expect(result).toEqual({ success: true, enabled: ['PoseSearch', 'MotionWarping'] })
    expect(callRequest).toHaveBeenCalledWith(
      'system.manage_plugin',
      { plugin_name: 'PoseSearch', action: 'Enable' },
      'c1',
      30000
    )
    // 盒子兜底那一步没有重复追加
    expect(await pluginsOnDisk()).toEqual([
      { Name: 'PoseSearch', Enabled: true },
      { Name: 'MotionWarping', Enabled: true }
    ])
  })

  it('老插件包只改内存不落盘、或者编辑器那边出错：盒子补写文件', async () => {
    liveProjects.push({ connectionId: 'c1', projectPath: dir })
    callRequest
      .mockResolvedValueOnce({ is_enabled: true })
      .mockRejectedValueOnce(new Error('timeout'))

    const result = await enablePluginsForImport(uproject, ['PoseSearch', 'MotionWarping'])
    expect(result.success).toBe(true)
    expect(await pluginsOnDisk()).toEqual([
      { Name: 'PoseSearch', Enabled: true },
      { Name: 'MotionWarping', Enabled: true }
    ])
  })
})
