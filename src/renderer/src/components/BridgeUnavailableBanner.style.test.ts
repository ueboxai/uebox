import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')
const banner = read('src/renderer/src/components/BridgeUnavailableBanner.vue')
const layout = read('src/renderer/src/layout/MainLayout.vue')

/*
 * 横幅以前挂在最外层 <Layout> 下 —— 那一层是横向一排（侧边栏 | 内容列），
 * 横幅成了第三列，1630 宽的窗口里内容区被挤到只剩 135px。
 */
describe('BridgeUnavailableBanner 的位置', () => {
  it('挂在内容列里，位于内容区之前', () => {
    const column = layout.slice(
      layout.indexOf('class="layout-container"'),
      layout.indexOf('<Content')
    )
    expect(column).toContain('<BridgeUnavailableBanner />')
    expect(layout.match(/<BridgeUnavailableBanner \/>/g)).toHaveLength(1)
  })

  it('在纵向的内容列里不被内容区压扁', () => {
    expect(banner).toMatch(/\.bridge-banner\s*{[^}]*flex-shrink:\s*0/s)
  })
})
