import path from 'path'
import { describe, expect, it } from 'vitest'

// 第三方解析器是 vendored 的 JS，没有类型声明
import { analyzeFromFile } from './uasset-reader-new'

/**
 * 烘焙光照的 _BuiltData 把光照贴图直接序列化在导出对象体内，BulkDataStartOffset 贴着
 * 文件尾，按它算出来的"元数据"就是整个文件（实测 1.8GB），超过读取上限就整包报错，
 * 导入时弹「资产导入出错」。依赖信息都在包头里，超限时应退回只读包头。
 *
 * 这里拿仓库里的贴图，把上限压到包头和 BulkData 起点之间，模拟同样的处境。
 */
const fixture = path.resolve(
  __dirname,
  '../../../plugin/UnrealAgentLink/Content/Textures/T_Bricks_Albedo.uasset'
)

describe('analyzeFromFile 元数据超限', () => {
  it('BulkData 起点超过上限时只读包头，依赖照样解析出来', async () => {
    const full = await analyzeFromFile(fixture)
    expect(full).not.toBeInstanceOf(Error)

    const headerSize = full.header.TotalHeaderSize
    const bulkStart = Number(full.header.BulkDataStartOffset)
    expect(bulkStart).toBeGreaterThan(headerSize)

    const limited = await analyzeFromFile(fixture, { maxMetadataSize: headerSize })
    expect(limited).not.toBeInstanceOf(Error)
    expect(limited.imports).toEqual(full.imports)
    expect(limited.softPackageReferences).toEqual(full.softPackageReferences)
  })

  it('连包头都放不下时仍然报超限', async () => {
    const result = await analyzeFromFile(fixture, { maxMetadataSize: 100 })
    expect(result).toBeInstanceOf(Error)
    expect(String(result)).toContain('Metadata too large')
  })
})
