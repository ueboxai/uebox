/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))
vi.mock('../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import { dataTableTools, formatDescribe, formatEdit, type DescribeResponse } from './index'

const tool = (name: string): ReturnType<typeof dataTableTools>[number] =>
  dataTableTools().find((t) => t.name === name)!
const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map((c) => c.text ?? '').join('')

beforeEach(() => callRequest.mockReset())

describe('数据表工具', () => {
  // 读工具不弹审批、能并发；写工具要审批、串行 —— 两次改同一张表不能交错
  it('一读一写', () => {
    const tools = dataTableTools()
    expect(tools.map((t) => [t.name, t.unrealBox.risk])).toEqual([
      ['ue_datatable_describe', 'safe'],
      ['ue_datatable_edit', 'mutating']
    ])
    expect((tool('ue_datatable_edit') as { executionMode?: string }).executionMode).toBe(
      'sequential'
    )
  })

  it('edit 把整批原样交给引擎', async () => {
    callRequest.mockResolvedValueOnce({
      ok: true,
      asset_path: '/Game/DT_Weapons.DT_Weapons',
      applied: 2,
      row_count: 3,
      rows: { Bow_Long: { Damage: 30 } }
    })
    const ops = [
      { op: 'add', row: 'Bow_Long', copy_from: 'Bow', values: { Damage: 30 } },
      { op: 'remove', row: 'Sword_Old' }
    ]
    const result = await tool('ue_datatable_edit').execute('c1', {
      asset_path: '/Game/DT_Weapons',
      ops
    })
    expect(callRequest.mock.calls[0][0]).toBe('datatable.edit')
    expect(callRequest.mock.calls[0][1]).toEqual({ asset_path: '/Game/DT_Weapons', ops })
    expect(text(result)).toContain('2 条操作全部成功')
  })

  // 缺字段在盒子这一侧就拦下，不去引擎跑一趟
  it('set 没有 values、rename 没有 new_name 当场报', async () => {
    await expect(
      tool('ue_datatable_edit').execute('c1', {
        asset_path: '/Game/DT',
        ops: [{ op: 'set', row: 'A' }]
      })
    ).rejects.toThrow()
    await expect(
      tool('ue_datatable_edit').execute('c1', {
        asset_path: '/Game/DT',
        ops: [{ op: 'rename', row: 'A' }]
      })
    ).rejects.toThrow()
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('引擎报错时整句传给模型', async () => {
    callRequest.mockResolvedValueOnce({
      ok: false,
      error: "ops[0] (set Sword) failed: column 'Damge': no column 'Damge'. Did you mean: Damage?"
    })
    await expect(
      tool('ue_datatable_edit').execute('c1', {
        asset_path: '/Game/DT',
        ops: [{ op: 'set', row: 'Sword', values: { Damge: 1 } }]
      })
    ).rejects.toThrow(/Did you mean: Damage/)
  })
})

describe('读表的排版', () => {
  const base: DescribeResponse = {
    asset_path: '/Game/DT_Weapons.DT_Weapons',
    row_struct: { name: 'WeaponRow', path: '/Game/WeaponRow.WeaponRow', user_defined: true },
    row_count: 3,
    columns: [
      { name: 'Damage', type: 'float' },
      { name: 'Rarity', type: 'ERarity', enum_values: ['Common', 'Rare'] }
    ],
    row_names: ['Sword', 'Bow', 'Axe'],
    rows: { Sword: { Damage: 10, Rarity: 'Common' } }
  }

  it('列类型和枚举可选值都写出来，没展开的行给行名', () => {
    const out = formatDescribe(base)
    expect(out).toContain('蓝图结构体')
    expect(out).toContain('- Rarity：ERarity，可选 Common / Rare')
    expect(out).toContain('Sword, Bow, Axe')
    expect(out).toContain('"Damage": 10')
  })

  // 重新导入会盖掉编辑器里的改动，这件事得让模型先问用户
  it('有源文件时提醒先问用户', () => {
    const out = formatDescribe({
      ...base,
      source_file: 'D:/Data/weapons.csv',
      source_file_exists: true
    })
    expect(out).toContain('D:/Data/weapons.csv')
    expect(out).toContain('先问用户')
    expect(
      formatEdit({ asset_path: base.asset_path, applied: 1, row_count: 3, source_file: 'D:/x.csv' })
    ).toContain('先问用户')
  })

  it('合并表说明要去改父表', () => {
    const out = formatDescribe({ ...base, composite: true, parent_tables: ['/Game/DT_A.DT_A'] })
    expect(out).toContain('合并表')
    expect(out).toContain('/Game/DT_A.DT_A')
  })
})
