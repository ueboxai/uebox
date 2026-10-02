import { describe, expect, it } from 'vitest'

import { findSessionUproject, isSessionProjectConnected } from './reviewOpenProject'

const rows = [
  {
    projectName: 'Shooter',
    projectPath: 'D:/UE/Shooter',
    originPath: 'D:/UE/Shooter/Shooter.uproject'
  },
  { projectName: 'Racer', projectPath: null, originPath: 'E:\\Games\\Racer\\Racer.uproject' },
  { projectName: 'NoFile', projectPath: 'F:/NoFile', originPath: null }
]

describe('findSessionUproject', () => {
  it('按目录找，大小写和斜杠方向不敏感', () => {
    expect(findSessionUproject({ projectName: 'X', projectPath: 'e:/games/racer/' }, rows)).toBe(
      'E:\\Games\\Racer\\Racer.uproject'
    )
  })

  it('没有路径的老会话按名字找', () => {
    expect(findSessionUproject({ projectName: 'Shooter' }, rows)).toBe(
      'D:/UE/Shooter/Shooter.uproject'
    )
  })

  it('没绑工程、或库里没有 .uproject 时不知道开哪个', () => {
    expect(findSessionUproject(null, rows)).toBeNull()
    expect(
      findSessionUproject({ projectName: 'NoFile', projectPath: 'F:/NoFile' }, rows)
    ).toBeNull()
  })
})

describe('isSessionProjectConnected', () => {
  const connected = [{ projectName: 'Shooter', projectPath: 'D:\\UE\\Shooter', isConnected: true }]

  it('同一个工程目录算连着', () => {
    expect(
      isSessionProjectConnected({ projectName: 'Shooter', projectPath: 'D:/UE/Shooter' }, connected)
    ).toBe(true)
  })

  it('别的工程连着不算', () => {
    expect(
      isSessionProjectConnected({ projectName: 'Racer', projectPath: 'E:/Games/Racer' }, connected)
    ).toBe(false)
  })
})
