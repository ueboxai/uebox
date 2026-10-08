/**
 * 数据表（DataTable）工具：一读一写。
 *
 * 以前改表只能让模型现写 Python。能改，但三个坑每次都要重新踩一遍：
 *
 *   - 蓝图结构体的列真名带 GUID 后缀（`Damage_2_8F3A...`），Python 里按显示名找不到；
 *   - 字段名拼错、类型写错，是脚本跑到一半才报，前面改过的行已经留在表里了；
 *   - 改出来的东西不在 agent 撤销栈上，「把 AI 刚做的撤了」撤不到它。
 *
 * 引擎侧（`datatable.describe` / `datatable.edit`）把这三件事收掉了：列名按编辑器
 * 里显示的认，写错给建议；一批改动要么全成要么全不动；整批是撤销栈上的一步。
 *
 * ## 有源文件的表
 *
 * 从 CSV / JSON 导入的表，在编辑器里改完、下次重新导入就被源文件盖掉。
 * 这件事模型自己判断不了「用户要哪个」，所以两个工具都把源文件摆出来，
 * 描述里要求先问用户。不替用户去改源文件。
 */

import { z } from 'zod'

import { defineUeTool } from '../defineUeTool'
import type { UnrealAgentTool } from '../defineTool'

const NAMESPACE = 'ue.datatable'

/** 读表时一行的值，键是列名 */
type RowValues = Record<string, unknown>

export interface DescribeResponse {
  asset_path: string
  row_struct?: { name: string; path: string; user_defined: boolean }
  row_count: number
  columns?: Array<{ name: string; type: string; enum_values?: string[] }>
  row_names?: string[]
  row_names_truncated?: boolean
  rows?: Record<string, RowValues>
  unknown_rows?: string[]
  unknown_columns?: string[]
  source_file?: string
  source_file_exists?: boolean
  composite?: boolean
  parent_tables?: string[]
}

export interface EditResponse {
  asset_path: string
  package?: string
  applied: number
  row_count: number
  rows?: Record<string, RowValues>
  removed?: string[]
  renamed?: Array<{ from: string; to: string }>
  source_file?: string
  source_file_exists?: boolean
}

/** 有源文件时给模型的那一句。两个工具共用，措辞保持一致 */
function sourceFileNote(file: string, exists: boolean | undefined): string {
  return (
    `这张表是从 ${file} 导入的${exists === false ? '（这个文件现在不在了）' : ''}。` +
    '在编辑器里改的内容，下次重新导入会被源文件覆盖。' +
    '改之前先问用户：改 UE 里这张表，还是去改源文件后重新导入。'
  )
}

export function formatDescribe(data: DescribeResponse): string {
  const lines: string[] = []
  const struct = data.row_struct
  lines.push(
    `数据表 ${data.asset_path}，共 ${data.row_count} 行` +
      (struct ? `，行结构 ${struct.name}${struct.user_defined ? '（蓝图结构体）' : ''}` : '')
  )
  if (data.composite) {
    lines.push(
      `这是合并表（Composite），行来自父表，不能直接改。要改哪一行，去改它所在的父表：` +
        (data.parent_tables?.length ? data.parent_tables.join('、') : '（没读到父表）')
    )
  }
  if (data.source_file) lines.push(sourceFileNote(data.source_file, data.source_file_exists))

  if (data.columns?.length) {
    lines.push('', '列：')
    for (const column of data.columns) {
      const options = column.enum_values?.length ? `，可选 ${column.enum_values.join(' / ')}` : ''
      lines.push(`- ${column.name}：${column.type}${options}`)
    }
  }

  if (data.unknown_columns?.length) lines.push('', `没有这些列：${data.unknown_columns.join('；')}`)
  if (data.unknown_rows?.length) lines.push('', `没有这些行：${data.unknown_rows.join('；')}`)

  const rows = data.rows ?? {}
  const shown = Object.keys(rows)
  const allNames = data.row_names ?? []
  if (allNames.length > shown.length) {
    lines.push(
      '',
      `全部行名${data.row_names_truncated ? `（前 ${allNames.length} 个，用 offset 往后翻）` : ''}：` +
        allNames.join(', ')
    )
  }
  if (shown.length) {
    lines.push('', `行值（${shown.length} 行）：`, JSON.stringify(rows, null, 1))
  }
  return lines.join('\n')
}

export function formatEdit(data: EditResponse): string {
  const lines: string[] = [
    `已改 ${data.asset_path}：${data.applied} 条操作全部成功，现在共 ${data.row_count} 行。` +
      '整批是撤销栈上的一步。改动还没存盘，完事记得 ue_save。'
  ]
  if (data.renamed?.length) {
    lines.push(`改名：${data.renamed.map((r) => `${r.from} → ${r.to}`).join('，')}`)
  }
  if (data.removed?.length) lines.push(`删除：${data.removed.join('，')}`)
  const rows = data.rows ?? {}
  if (Object.keys(rows).length) {
    lines.push('写入后回读：', JSON.stringify(rows, null, 1))
  }
  if (data.source_file) lines.push(sourceFileNote(data.source_file, data.source_file_exists))
  return lines.join('\n')
}

const AssetPath = z
  .string()
  .min(1)
  .describe(
    '数据表资产路径，如 /Game/Data/DT_Weapons（ue_content_search 带 filter_class=DataTable 能找）'
  )

const DescribeInput = z.object({
  asset_path: AssetPath,
  rows: z
    .array(z.string())
    .optional()
    .describe('只看这几行（行名）。省略则按 offset / limit 取一段'),
  columns: z.array(z.string()).optional().describe('只看这几列。省略则给全部列'),
  offset: z.number().int().min(0).optional().describe('不点名 rows 时，从第几行开始，默认 0'),
  limit: z.number().int().min(0).max(200).optional().describe('不点名 rows 时取几行，默认 20')
})

const ValuesSchema = z
  .record(z.string(), z.unknown())
  .describe(
    '列名 → 值。列名用 ue_datatable_describe 给的；嵌套写路径，如 "Stats.Range"、"Drops[0].Item"。' +
      '资产引用写路径（/Game/Icons/T_Sword），枚举写可选值之一，结构体可以整个给对象'
  )

/**
 * 一条操作。平铺成一个对象而不是按 op 分成联合类型 —— 联合类型转出来是 anyOf，
 * 有的厂商不认。哪种 op 缺哪个字段，在下面 superRefine 里当场报。
 */
const OpSchema = z
  .object({
    op: z.enum(['set', 'add', 'remove', 'rename']),
    row: z.string().min(1).describe('行名。add 时是新行名'),
    values: ValuesSchema.optional().describe(
      'set 必填；add 可选（新行在默认值或复制来的值上再改）'
    ),
    copy_from: z.string().optional().describe('仅 add：照着哪一行复制'),
    new_name: z.string().optional().describe('仅 rename：新行名')
  })
  .superRefine((op, ctx) => {
    if (op.op === 'set' && (!op.values || Object.keys(op.values).length === 0)) {
      ctx.addIssue({ code: 'custom', message: `set ${op.row} 没有 values` })
    }
    if (op.op === 'rename' && !op.new_name) {
      ctx.addIssue({ code: 'custom', message: `rename ${op.row} 没有 new_name` })
    }
  })

const EditInput = z.object({
  asset_path: AssetPath,
  ops: z.array(OpSchema).min(1).describe('按顺序执行。任何一条失败，整批还原，表保持原样')
})

export function dataTableTools(): UnrealAgentTool<never>[] {
  return [
    defineUeTool<typeof DescribeInput, DescribeResponse>({
      name: 'ue_datatable_describe',
      namespace: NAMESPACE,
      risk: 'safe',
      description: `读 UE 数据表（DataTable，常以 DT_ 开头）：有哪些列、每列类型、枚举列的可选值、行名，以及指定行的值。只读。

改表之前先用它看列名和类型 —— ue_datatable_edit 的列名、枚举值都按这里给的写。
表大时默认只回前 20 行的值和全部行名；要看哪几行就用 rows 点名，只关心几列就用 columns。
结果里有 source_file 时，说明表是从 CSV/JSON 导入的，改之前要先问用户。`,
      input: DescribeInput,
      method: 'datatable.describe',
      toOutcome: (response) => ({ text: formatDescribe(response), details: response })
    }),
    defineUeTool<typeof EditInput, EditResponse>({
      name: 'ue_datatable_edit',
      namespace: NAMESPACE,
      concurrency: 'sequential',
      description: `改 UE 数据表（DataTable）：改格子、加行（可照某行复制）、删行、改行名，一次交一批。

- 一批按顺序执行，任何一条失败整批还原，表保持原样；整批是撤销栈上的一步
- 列名、枚举值按 ue_datatable_describe 给的写；写错会报「你是不是想写」
- 「所有剑攻击力加 10%」这类：先 describe 读出现值，算好再一次 set 回去
- 表有 source_file（从 CSV/JSON 导入）时，重新导入会盖掉这里的改动 —— 动手前先问用户
- 不能改列（列由行结构体决定），也不能改合并表（Composite），要改它的父表
- 改完不落盘，完事 ue_save`,
      input: EditInput,
      method: 'datatable.edit',
      toOutcome: (response) => ({ text: formatEdit(response), details: response })
    })
  ] as unknown as UnrealAgentTool<never>[]
}
