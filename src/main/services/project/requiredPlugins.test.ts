import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import {
  enablePluginsInUproject,
  findMissingPlugins,
  describeUnavailable,
  findUnknownModules,
  parseAssetPluginInfo,
  toFabUrl,
  readPackageScriptModules,
  scanPluginDirectory,
  type PluginEntry
} from './requiredPlugins'

const plugin = (
  name: string,
  modules: string[],
  extra: Partial<PluginEntry> = {}
): PluginEntry => ({ name, friendlyName: name, dependsOn: [], modules, ...extra })

// 照 5.7 的真实声明：PoseSearch 依赖 AnimationWarping、BlendStack、Chooser
const engine = [
  plugin('PoseSearch', ['PoseSearch', 'PoseSearchEditor'], {
    friendlyName: 'Pose Search',
    dependsOn: ['AnimationWarping', 'BlendStack', 'Chooser']
  }),
  plugin('AnimationWarping', ['AnimationWarpingRuntime', 'AnimationWarpingEditor']),
  plugin('BlendStack', ['BlendStack', 'BlendStackEditor']),
  plugin('Chooser', ['Chooser', 'ChooserUncooked']),
  plugin('MotionWarping', ['MotionWarping']),
  plugin('EnhancedInput', ['EnhancedInput'], { enabledByDefault: true })
]

describe('findMissingPlugins', () => {
  it('CBP_SandboxCharacter 导进空工程：只列最上层的插件，引擎本体模块不管', () => {
    const missing = findMissingPlugins({
      modules: [
        'Engine',
        'CoreUObject',
        'PoseSearch',
        'Chooser',
        'AnimationWarpingRuntime',
        'BlendStack',
        'MotionWarping',
        'EnhancedInput'
      ],
      uprojectPlugins: [{ Name: 'UnrealAgentLink', Enabled: true }],
      enginePlugins: engine,
      projectPlugins: []
    })
    // Chooser / AnimationWarping / BlendStack 开了 PoseSearch 就会被带起来；EnhancedInput 默认就开
    expect(missing).toEqual([
      { name: 'MotionWarping', friendlyName: 'MotionWarping' },
      { name: 'PoseSearch', friendlyName: 'Pose Search' }
    ])
  })

  it('已经开了的不报，靠依赖带起来的也算开着', () => {
    const missing = findMissingPlugins({
      modules: ['PoseSearch', 'Chooser', 'BlendStack'],
      uprojectPlugins: [{ Name: 'PoseSearch', Enabled: true }],
      enginePlugins: engine,
      projectPlugins: []
    })
    expect(missing).toEqual([])
  })

  it('默认开着的插件被 .uproject 显式关掉了，照样要报', () => {
    const missing = findMissingPlugins({
      modules: ['EnhancedInput'],
      uprojectPlugins: [{ Name: 'EnhancedInput', Enabled: false }],
      enginePlugins: engine,
      projectPlugins: []
    })
    expect(missing.map((p) => p.name)).toEqual(['EnhancedInput'])
  })

  it('.uproject 里的插件名大小写不一样也认（引擎不区分大小写）', () => {
    const missing = findMissingPlugins({
      modules: ['PoseSearch', 'MotionWarping'],
      uprojectPlugins: [
        { Name: 'posesearch', Enabled: true },
        { Name: 'motionwarping', Enabled: true }
      ],
      enginePlugins: engine,
      projectPlugins: []
    })
    expect(missing).toEqual([])
  })

  it('废弃插件不报：类型已经并进引擎，旧引用靠重定向', () => {
    const missing = findMissingPlugins({
      modules: ['StructUtils'],
      uprojectPlugins: [],
      enginePlugins: [...engine, plugin('StructUtils', ['StructUtils'], { deprecated: true })],
      projectPlugins: []
    })
    expect(missing).toEqual([])
  })

  it('工程 Plugins 目录里的插件默认算开着', () => {
    const missing = findMissingPlugins({
      modules: ['MyTools'],
      uprojectPlugins: [],
      enginePlugins: engine,
      projectPlugins: [plugin('MyTools', ['MyTools'])]
    })
    expect(missing).toEqual([])
  })
})

describe('findUnknownModules', () => {
  it('引擎本体、已装插件、工程自己的模块都不算；剩下的是本机没有的', () => {
    const unknown = findUnknownModules({
      modules: ['Engine', 'PoseSearch', 'MyGame', 'KawaiiPhysics', 'DoubaoRealtimeVoice'],
      coreModules: new Set(['Engine', 'CoreUObject']),
      plugins: engine,
      projectModules: ['MyGame']
    })
    expect(unknown).toEqual(['DoubaoRealtimeVoice', 'KawaiiPhysics'])
  })
})

describe('原工程插件来源', () => {
  it('Fab 的启动器链接换成网页地址，老商城的和空的不记', () => {
    expect(
      toFabUrl('com.epicgames.launcher://ue/Fab/product/f870c07e-0a02-4a78-a888-e52a22794572')
    ).toBe('https://www.fab.com/listings/f870c07e-0a02-4a78-a888-e52a22794572')
    expect(toFabUrl('https://www.fab.com/listings/abc')).toBe('https://www.fab.com/listings/abc')
    expect(
      toFabUrl('com.epicgames.launcher://ue/marketplace/content/2d26886016024a6f')
    ).toBeUndefined()
    expect(toFabUrl('')).toBeUndefined()
  })

  it('只认盒子自己写的形状，.uplugin 那份和坏 JSON 都当没有', () => {
    expect(parseAssetPluginInfo('{"friendlyName":"X","modules":[]}')).toBeUndefined()
    expect(parseAssetPluginInfo('{bad')).toBeUndefined()
    expect(parseAssetPluginInfo('{"kind":"asset-plugins","plugins":[]}')?.plugins).toEqual([])
  })

  it('找不到的模块按记下的来源合并成插件，没来源的单列', () => {
    const kawaii = {
      name: 'KawaiiPhysics',
      friendlyName: 'Kawaii Physics',
      kind: 'plugin' as const,
      versionName: '1.17',
      fabUrl: 'https://www.fab.com/listings/x',
      modules: ['KawaiiPhysics', 'KawaiiPhysicsEd']
    }
    const result = describeUnavailable(
      ['KawaiiPhysics', 'KawaiiPhysicsEd', 'MyGameCore', 'Mystery'],
      [
        {
          kind: 'asset-plugins',
          sourceProject: '豆包数字人',
          plugins: [
            kawaii,
            {
              name: 'MyGameCore',
              friendlyName: 'MyGameCore',
              kind: 'project-code',
              modules: ['MyGameCore']
            }
          ]
        }
      ]
    )
    expect(result).toEqual([
      {
        name: 'KawaiiPhysics',
        friendlyName: 'Kawaii Physics',
        kind: 'plugin',
        versionName: '1.17',
        fabUrl: 'https://www.fab.com/listings/x',
        sourceProject: '豆包数字人',
        modules: ['KawaiiPhysics', 'KawaiiPhysicsEd']
      },
      {
        name: 'MyGameCore',
        friendlyName: 'MyGameCore',
        kind: 'project-code',
        versionName: undefined,
        fabUrl: undefined,
        sourceProject: '豆包数字人',
        modules: ['MyGameCore']
      },
      { name: 'Mystery', friendlyName: 'Mystery', kind: 'unknown', modules: ['Mystery'] }
    ])
  })
})

describe('readPackageScriptModules', () => {
  it('模块导入和类所在的模块都收', async () => {
    const modules = await readPackageScriptModules('x.uasset', async () => ({
      imports: {
        Imports: [
          { objectName: '/Script/PoseSearch', classPackage: '/Script/CoreUObject' },
          {
            objectName: 'Default__AnimationWarpingLibrary',
            classPackage: '/Script/AnimationWarpingRuntime'
          },
          {
            objectName: '/Game/Blueprints/ABP_SandboxCharacter',
            classPackage: '/Script/CoreUObject'
          }
        ]
      }
    }))
    expect(modules?.sort()).toEqual(['AnimationWarpingRuntime', 'CoreUObject', 'PoseSearch'])
  })

  it('解析失败返回 null', async () => {
    expect(await readPackageScriptModules('x.uasset', async () => new Error('bad'))).toBeNull()
  })
})

describe('磁盘上的插件和 .uproject', () => {
  let root = ''
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ue-plugins-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('扫到插件目录就停，不往插件里面钻', async () => {
    const poseSearch = path.join(root, 'Animation', 'PoseSearch')
    await mkdir(path.join(poseSearch, 'Nested'), { recursive: true })
    await writeFile(
      path.join(poseSearch, 'PoseSearch.uplugin'),
      JSON.stringify({ FriendlyName: 'Pose Search', Modules: [{ Name: 'PoseSearch' }] })
    )
    // 插件里面再有 .uplugin 引擎也不认，我们也不认
    await writeFile(path.join(poseSearch, 'Nested', 'Inner.uplugin'), '{}')

    const found = await scanPluginDirectory(root)
    expect(found.map((p) => p.name)).toEqual(['PoseSearch'])
    expect(found[0].modules).toEqual(['PoseSearch'])
  })

  it('写 .uproject：没有的追加，关着的打开（大小写不同也是同一条），开着的不动', async () => {
    const uproject = path.join(root, 'Game.uproject')
    await writeFile(
      uproject,
      JSON.stringify({
        FileVersion: 3,
        EngineAssociation: '5.7',
        Plugins: [
          { Name: 'chooser', Enabled: false },
          { Name: 'UnrealAgentLink', Enabled: true }
        ]
      })
    )

    const { enabled } = await enablePluginsInUproject(uproject, [
      'PoseSearch',
      'Chooser',
      'UnrealAgentLink'
    ])
    expect(enabled).toEqual(['PoseSearch', 'Chooser'])

    const written = JSON.parse(await readFile(uproject, 'utf-8'))
    expect(written.EngineAssociation).toBe('5.7')
    expect(written.Plugins).toEqual([
      { Name: 'chooser', Enabled: true },
      { Name: 'UnrealAgentLink', Enabled: true },
      { Name: 'PoseSearch', Enabled: true }
    ])
  })
})
