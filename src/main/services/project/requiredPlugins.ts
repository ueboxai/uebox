import * as fs from 'fs'
import path from 'path'
import type {
  AssetPluginInfo,
  AssetPluginRef,
  MissingPlugin,
  UnavailablePlugin
} from '../../../shared/projectImport'
import UnrealPathManagerUtil from '../../utils/UnrealPathManager'
import {
  resolveProjectEngineVersion,
  type ResolvedProjectEngineVersion
} from '../../ipc/projectEngineVersion'
import { readUeJsonFile, readUeTextFile } from '../../utils/ueTextFile'
import type { PackageAnalyzer } from './packageImports'

/**
 * 资产用到哪些引擎插件、目标工程开没开。
 *
 * 资产包的导入表里记着它引用的代码模块（`/Script/PoseSearch`）。模块属于哪个插件，
 * 看引擎和工程里各个 `.uplugin` 的 `Modules` 就知道；再对照 `.uproject` 里开着的插件，
 * 缺的就是用户要开的。不在任何插件里的模块（`/Script/Engine` 这类）是引擎本体，不用管。
 */

export type PluginEntry = {
  name: string
  friendlyName: string
  /** `.uplugin` 里的 EnabledByDefault；没写的算 undefined */
  enabledByDefault?: boolean
  /** 这个插件声明要一起开的插件。开了它，这些也会被引擎带起来 */
  dependsOn: string[]
  modules: string[]
  /**
   * 写了 DeprecatedEngineVersion 的插件。里面的类型早搬进引擎本体了（StructUtils 5.5 起
   * 并进 CoreUObject），旧资产里的 `/Script/StructUtils` 引用由引擎重定向，不用开它。
   */
  deprecated?: boolean
  versionName?: string
  marketplaceUrl?: string
  createdBy?: string
}

type UpluginFile = {
  FriendlyName?: string
  EnabledByDefault?: boolean
  DeprecatedEngineVersion?: string
  VersionName?: string
  MarketplaceURL?: string
  CreatedBy?: string
  Modules?: Array<{ Name?: string }>
  Plugins?: Array<{ Name?: string; Enabled?: boolean }>
}

export type UprojectPluginRef = { Name?: string; Enabled?: boolean }

const readPlugin = async (upluginPath: string): Promise<PluginEntry | null> => {
  try {
    const data = await readUeJsonFile<UpluginFile>(upluginPath)
    const name = path.basename(upluginPath, '.uplugin')
    return {
      name,
      friendlyName: data.FriendlyName || name,
      enabledByDefault:
        typeof data.EnabledByDefault === 'boolean' ? data.EnabledByDefault : undefined,
      dependsOn: (data.Plugins ?? [])
        .filter((p) => p?.Name && p.Enabled !== false)
        .map((p) => String(p.Name)),
      modules: (data.Modules ?? []).map((m) => String(m?.Name || '')).filter(Boolean),
      deprecated: Boolean(data.DeprecatedEngineVersion),
      versionName: data.VersionName || undefined,
      marketplaceUrl: data.MarketplaceURL || undefined,
      createdBy: data.CreatedBy || undefined
    }
  } catch {
    return null
  }
}

/**
 * 按引擎自己的规则找插件：一个目录里有 `.uplugin` 就是插件，不再往下钻。
 *
 * 不能整棵树 find：引擎 Plugins 目录几十万个文件，冷盘实测 40 多秒；
 * 照引擎的规矩停在插件目录上，只读目录结构的上面几层。
 */
export const scanPluginDirectory = async (root: string): Promise<PluginEntry[]> => {
  const found: PluginEntry[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const uplugin = entries.find((e) => e.isFile() && e.name.toLowerCase().endsWith('.uplugin'))
    if (uplugin) {
      const plugin = await readPlugin(path.join(dir, uplugin.name))
      if (plugin) found.push(plugin)
      return
    }
    await Promise.all(
      entries.filter((e) => e.isDirectory()).map((e) => walk(path.join(dir, e.name)))
    )
  }
  await walk(root)
  return found
}

/** 引擎插件一次会话里不会变，按引擎根目录缓存。扫一遍 5.7 约 800 个插件 */
const enginePluginCache = new Map<string, Promise<PluginEntry[]>>()

export const getEnginePlugins = (engineRoot: string): Promise<PluginEntry[]> => {
  const key = path.resolve(engineRoot).toLowerCase()
  let cached = enginePluginCache.get(key)
  if (!cached) {
    cached = scanPluginDirectory(path.join(engineRoot, 'Engine', 'Plugins'))
    cached.catch(() => enginePluginCache.delete(key))
    enginePluginCache.set(key, cached)
  }
  return cached
}

const engineCoreModuleCache = new Map<string, Promise<Set<string> | null>>()

/**
 * 引擎本体（不在任何插件里）的代码模块。
 *
 * 编辑器启动时按 `Engine/Binaries/<平台>/UnrealEditor.modules` 加载模块，这份清单就是
 * 引擎本体有哪些模块（5.7 是 517 个）。再加上 BaseEngine.ini 里 PackageRedirects 的旧名 ——
 * 改过名的模块，老资产里还是旧名字，引擎会转过去。
 *
 * 读不到清单（源码版还没编过）返回 null：分不清「引擎自带」和「本机没有」，就别乱报。
 */
export const getEngineCoreModules = (engineRoot: string): Promise<Set<string> | null> => {
  const key = path.resolve(engineRoot).toLowerCase()
  let cached = engineCoreModuleCache.get(key)
  if (!cached) {
    cached = (async () => {
      let listed: Record<string, unknown> | undefined
      for (const platform of ['Win64', 'Mac', 'Linux']) {
        try {
          const file = path.join(engineRoot, 'Engine', 'Binaries', platform, 'UnrealEditor.modules')
          listed = (await readUeJsonFile<{ Modules?: Record<string, unknown> }>(file)).Modules
          if (listed) break
        } catch {
          // 这个平台的没有，试下一个
        }
      }
      if (!listed) return null
      const modules = new Set(Object.keys(listed))
      try {
        const ini = await readUeTextFile(
          path.join(engineRoot, 'Engine', 'Config', 'BaseEngine.ini')
        )
        for (const m of ini.matchAll(/PackageRedirects=\(OldName="\/Script\/([A-Za-z0-9_]+)"/g)) {
          modules.add(m[1])
        }
      } catch {
        // 没有重定向表只是少认几个旧名字
      }
      return modules
    })()
    cached.catch(() => engineCoreModuleCache.delete(key))
    engineCoreModuleCache.set(key, cached)
  }
  return cached
}

/** 仅供测试 */
export const __clearEnginePluginCache = (): void => {
  enginePluginCache.clear()
  engineCoreModuleCache.clear()
}

const cleanName = (raw: unknown): string =>
  String(raw ?? '')
    .split(String.fromCharCode(0))
    .join('')
    .trim()

/**
 * 读一个包引用了哪些代码模块（`/Script/X` 里的 X）。
 *
 * 两处都要看：模块本身作为一条 Package 导入（objectName），以及导入对象的类所在的
 * 模块（classPackage）—— 后者能抓到「用了插件里的类、却没直接引用模块」的情况。
 * 解析失败返回 null。
 */
export const readPackageScriptModules = async (
  filePath: string,
  analyze: PackageAnalyzer
): Promise<string[] | null> => {
  let result: Awaited<ReturnType<PackageAnalyzer>>
  try {
    result = await analyze(filePath)
  } catch {
    return null
  }
  if (result instanceof Error || !result || result.stack) return null

  const modules = new Set<string>()
  const imports = (result.imports?.Imports ?? []) as Array<{
    objectName?: string
    classPackage?: string
  }>
  for (const imp of imports) {
    for (const value of [imp?.objectName, imp?.classPackage]) {
      const name = cleanName(value)
      if (name.startsWith('/Script/')) modules.add(name.slice('/Script/'.length))
    }
  }
  return Array.from(modules)
}

/**
 * 算出缺哪些插件。纯函数，IO 都在外面。
 *
 * 「开着」的判定照引擎来：`.uproject` 里显式开的；引擎插件里 EnabledByDefault 的、
 * 工程 Plugins 目录里的（除非 `.uproject` 显式关掉）；再加上这些插件声明的依赖。
 *
 * 只报**最上层**的：PoseSearch 依赖 BlendStack，两个都缺时只让用户开 PoseSearch，
 * 引擎会把 BlendStack 带起来 —— 列表短一半，也和用户在插件管理器里的操作一致。
 */
export const findMissingPlugins = (params: {
  modules: Iterable<string>
  uprojectPlugins: UprojectPluginRef[]
  enginePlugins: PluginEntry[]
  projectPlugins: PluginEntry[]
}): MissingPlugin[] => {
  const byName = new Map<string, PluginEntry>()
  // 工程里的同名插件盖掉引擎的，和引擎的加载顺序一致
  for (const p of params.enginePlugins) byName.set(p.name, p)
  for (const p of params.projectPlugins) byName.set(p.name, p)
  const projectPluginNames = new Set(params.projectPlugins.map((p) => p.name))

  const ownerOfModule = new Map<string, string>()
  for (const p of byName.values()) for (const m of p.modules) ownerOfModule.set(m, p.name)

  // 插件名引擎按不区分大小写认，手改过的 .uproject 里大小写什么样都有
  const explicit = new Map<string, boolean>()
  for (const ref of params.uprojectPlugins) {
    if (ref?.Name) explicit.set(ref.Name.toLowerCase(), ref.Enabled !== false)
  }

  const closureOf = (roots: Iterable<string>): Set<string> => {
    const seen = new Set<string>()
    const queue = Array.from(roots)
    while (queue.length > 0) {
      const name = queue.pop() as string
      if (seen.has(name)) continue
      seen.add(name)
      queue.push(...(byName.get(name)?.dependsOn ?? []))
    }
    return seen
  }

  const directlyEnabled: string[] = []
  for (const p of byName.values()) {
    const flag = explicit.get(p.name.toLowerCase())
    if (flag === true) directlyEnabled.push(p.name)
    else if (flag === undefined) {
      const defaultOn = projectPluginNames.has(p.name)
        ? p.enabledByDefault !== false
        : p.enabledByDefault === true
      if (defaultOn) directlyEnabled.push(p.name)
    }
  }
  const enabled = closureOf(directlyEnabled)

  const missing = new Set<string>()
  for (const m of params.modules) {
    const owner = ownerOfModule.get(m)
    if (owner && !enabled.has(owner) && !byName.get(owner)?.deprecated) missing.add(owner)
  }

  // 被别的缺失插件带起来的不单列
  const carried = new Set<string>()
  for (const name of missing) {
    for (const dep of closureOf(byName.get(name)?.dependsOn ?? [])) carried.add(dep)
  }

  return Array.from(missing)
    .filter((name) => !carried.has(name))
    .sort()
    .map((name) => ({ name, friendlyName: byName.get(name)?.friendlyName || name }))
}

/**
 * 本机哪儿都找不到的代码模块：不是引擎本体，不在任何已装插件里，也不是目标工程自己的 C++。
 *
 * 多半是没装的第三方插件，或者原工程自己的 C++ 模块。只能报模块名 —— 插件全名和去哪装
 * 只有原工程那边知道（见 `pluginInfo`）。
 */
export const findUnknownModules = (params: {
  modules: Iterable<string>
  coreModules: ReadonlySet<string>
  plugins: PluginEntry[]
  /** `.uproject` 里 Modules 声明的工程自己的模块 */
  projectModules: string[]
}): string[] => {
  const known = new Set<string>([...params.coreModules, ...params.projectModules])
  for (const p of params.plugins) for (const m of p.modules) known.add(m)
  return Array.from(new Set(params.modules))
    .filter((m) => !known.has(m))
    .sort()
}

/**
 * 把插件写进 `.uproject`：已有条目改成开，没有的追加。
 *
 * 写回用不带 BOM 的 UTF-8、tab 缩进 —— 和盒子装 UnrealAgentLink 时一样，
 * 引擎读得回来（见 `ueTextFile.ts` 的说明）。生效要重启编辑器。
 */
export const enablePluginsInUproject = async (
  uprojectPath: string,
  names: string[]
): Promise<{ enabled: string[] }> => {
  const data = await readUeJsonFile<{ Plugins?: UprojectPluginRef[] } & Record<string, unknown>>(
    uprojectPath
  )
  const plugins = Array.isArray(data.Plugins) ? data.Plugins : []
  const enabled: string[] = []
  for (const name of new Set(names.filter(Boolean))) {
    // 不区分大小写：已有 "posesearch" 就改它，别再追加一条 "PoseSearch"
    const existing = plugins.find((p) => p?.Name?.toLowerCase() === name.toLowerCase())
    if (existing) {
      if (existing.Enabled === true) continue
      existing.Enabled = true
    } else {
      plugins.push({ Name: name, Enabled: true })
    }
    enabled.push(name)
  }
  if (enabled.length > 0) {
    data.Plugins = plugins
    await fs.promises.writeFile(uprojectPath, JSON.stringify(data, null, '\t'), 'utf-8')
  }
  return { enabled }
}

/**
 * 工程用的是哪个引擎、装在哪。自编译引擎解析版本时已经拿到根目录；启动器装的按版本号找。
 */
export const resolveEngineRoot = async (
  projectEngine: ResolvedProjectEngineVersion
): Promise<string | null> => {
  if (projectEngine.engineRootPath) return projectEngine.engineRootPath
  const version = projectEngine.comparableVersion
  if (!version) return null
  const engines = await UnrealPathManagerUtil.findUnrealEnginePaths()
  const engine = engines.find((e) => e.version === version || e.name === `UE_${version}`)
  return engine?.rootPath ?? null
}

/**
 * `.uplugin` 里的 MarketplaceURL 换成能在浏览器打开的地址。
 *
 * Fab 插件写的是启动器协议（`com.epicgames.launcher://ue/Fab/product/<id>`），
 * 盒子只放行 http(s) 外链，换成 fab.com 的商品页。老商城的 content id 没有对应网页，不记。
 */
export const toFabUrl = (marketplaceUrl: string | undefined): string | undefined => {
  const raw = String(marketplaceUrl || '').trim()
  if (/^https?:\/\//i.test(raw)) return raw
  const fab = raw.match(/^com\.epicgames\.launcher:\/\/ue\/fab\/product\/([A-Za-z0-9-]+)/i)
  return fab ? `https://www.fab.com/listings/${fab[1]}` : undefined
}

/**
 * 原工程的「模块 → 归属」查找表。加资产进盒子时建一次，整批共用。
 *
 * 引擎本体的模块不进表 —— 哪个工程都有，不用记。
 */
export type SourcePluginLookup = (modules: Iterable<string>) => AssetPluginInfo | undefined

export const buildSourcePluginLookup = async (params: {
  /** 原工程的 .uproject */
  projectFile: string
  projectName?: string
}): Promise<SourcePluginLookup> => {
  const uproject = await readUeJsonFile<{
    EngineAssociation?: string
    Modules?: Array<{ Name?: string }>
  }>(params.projectFile)
  const projectEngine = await resolveProjectEngineVersion(
    uproject?.EngineAssociation || null,
    UnrealPathManagerUtil
  )
  const engineRoot = await resolveEngineRoot(projectEngine)
  const [enginePlugins, projectPlugins] = await Promise.all([
    engineRoot ? getEnginePlugins(engineRoot) : Promise.resolve([]),
    scanPluginDirectory(path.join(path.dirname(params.projectFile), 'Plugins'))
  ])

  const owner = new Map<string, { plugin?: PluginEntry; location?: 'engine' | 'project' }>()
  for (const p of enginePlugins)
    for (const m of p.modules) owner.set(m, { plugin: p, location: 'engine' })
  // 工程里的同名插件盖掉引擎的
  for (const p of projectPlugins)
    for (const m of p.modules) owner.set(m, { plugin: p, location: 'project' })
  const projectCode = new Set(
    (Array.isArray(uproject?.Modules) ? uproject.Modules : [])
      .map((m) => String(m?.Name || ''))
      .filter(Boolean)
  )

  return (modules) => {
    const byName = new Map<string, AssetPluginRef>()
    for (const m of new Set(modules)) {
      const hit = owner.get(m)
      if (hit?.plugin) {
        const p = hit.plugin
        const ref = byName.get(p.name) ?? {
          name: p.name,
          friendlyName: p.friendlyName,
          kind: 'plugin' as const,
          location: hit.location,
          versionName: p.versionName,
          fabUrl: toFabUrl(p.marketplaceUrl),
          createdBy: p.createdBy,
          modules: []
        }
        ref.modules.push(m)
        byName.set(p.name, ref)
      } else if (projectCode.has(m)) {
        byName.set(m, { name: m, friendlyName: m, kind: 'project-code', modules: [m] })
      }
    }
    if (byName.size === 0) return undefined
    return {
      kind: 'asset-plugins',
      sourceProject: params.projectName,
      plugins: Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
    }
  }
}

/** 读 `assetData.pluginInfo`。`.uplugin` 那种形状、坏 JSON 一律当没有 */
export const parseAssetPluginInfo = (raw: unknown): AssetPluginInfo | undefined => {
  if (typeof raw !== 'string' || !raw) return undefined
  try {
    const parsed = JSON.parse(raw) as AssetPluginInfo
    return parsed?.kind === 'asset-plugins' && Array.isArray(parsed.plugins) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 把目标机器上找不到的模块，按原工程记下的归属合并成「缺哪些插件」。
 *
 * 一个插件常有好几个模块（运行时 + 编辑器），合成一条；原工程那边也没记的模块单列为
 * `unknown`，至少把名字报出来。
 */
export const describeUnavailable = (
  unknownModules: string[],
  sources: Iterable<AssetPluginInfo>
): UnavailablePlugin[] => {
  const refOf = new Map<string, { ref: AssetPluginRef; sourceProject?: string }>()
  for (const info of sources) {
    for (const ref of info.plugins) {
      for (const m of ref.modules) {
        if (!refOf.has(m)) refOf.set(m, { ref, sourceProject: info.sourceProject })
      }
    }
  }

  const out = new Map<string, UnavailablePlugin>()
  for (const m of unknownModules) {
    const hit = refOf.get(m)
    const key = hit ? `${hit.ref.kind}:${hit.ref.name}` : `unknown:${m}`
    const existing = out.get(key)
    if (existing) {
      if (!existing.modules.includes(m)) existing.modules.push(m)
      continue
    }
    out.set(
      key,
      hit
        ? {
            name: hit.ref.name,
            friendlyName: hit.ref.friendlyName,
            kind: hit.ref.kind,
            versionName: hit.ref.versionName,
            fabUrl: hit.ref.fabUrl,
            sourceProject: hit.sourceProject,
            modules: [m]
          }
        : { name: m, friendlyName: m, kind: 'unknown', modules: [m] }
    )
  }
  return Array.from(out.values()).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 这几个插件在工程用的那个引擎、或者工程自己的 Plugins 目录里有没有。
 *
 * 往 `.uproject` 里写一个本机没有的插件，编辑器启动时会报「找不到插件」，工程直接打不开 ——
 * 比不开还糟。所以写之前必须过这一道。引擎都找不到时 `engineFound` 为 false，
 * 调用方应当拒绝写入，而不是赌一把。
 */
export const checkPluginsInstalled = async (
  projectFile: string,
  names: string[]
): Promise<{ engineFound: boolean; installed: string[]; notInstalled: string[] }> => {
  const uproject = await readUeJsonFile<{ EngineAssociation?: string }>(projectFile)
  const engineRoot = await resolveEngineRoot(
    await resolveProjectEngineVersion(uproject?.EngineAssociation || null, UnrealPathManagerUtil)
  )
  const [enginePlugins, projectPlugins] = await Promise.all([
    engineRoot ? getEnginePlugins(engineRoot) : Promise.resolve([]),
    scanPluginDirectory(path.join(path.dirname(projectFile), 'Plugins'))
  ])
  // 大小写不敏感：模型转述插件名时大小写常常不准，写进去的用规范名
  const canonical = new Map<string, string>()
  for (const p of [...enginePlugins, ...projectPlugins]) canonical.set(p.name.toLowerCase(), p.name)
  const installed: string[] = []
  const notInstalled: string[] = []
  for (const name of names) {
    const hit = canonical.get(name.toLowerCase())
    if (hit) installed.push(hit)
    else notInstalled.push(name)
  }
  return { engineFound: Boolean(engineRoot), installed, notInstalled }
}
