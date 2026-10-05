import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import StepMediaStrip from './StepMediaStrip.vue'
import { openImageViewer } from '@renderer/services/imageViewer'

/**
 * 步骤产出的图和视频。图多了不铺满，视频不自己出声。
 */

vi.mock('@renderer/services/imageViewer', () => ({ openImageViewer: vi.fn() }))

const images = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `local-resource://${name}.png`)

describe('StepMediaStrip', () => {
  it('最多铺 4 张，最后一张叠上剩下的数', () => {
    const wrapper = mount(StepMediaStrip, { props: { images } })
    expect(wrapper.findAll('.step-thumb')).toHaveLength(4)
    expect(wrapper.find('.step-more').text()).toBe('+2')
  })

  it('max=0 不限张数', () => {
    const wrapper = mount(StepMediaStrip, { props: { images, max: 0, small: true } })
    expect(wrapper.findAll('.step-thumb.small')).toHaveLength(6)
    expect(wrapper.find('.step-more').exists()).toBe(false)
  })

  it('点开在大图里能翻到全部，包括没铺出来的那两张', async () => {
    const wrapper = mount(StepMediaStrip, { props: { images } })
    await wrapper.findAll('.step-thumb')[1].trigger('click')
    expect(openImageViewer).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1, items: expect.arrayContaining([expect.anything()]) })
    )
    const call = vi.mocked(openImageViewer).mock.calls.at(-1)?.[0]
    expect(call?.items).toHaveLength(6)
  })

  // 文件被挪走了就不留一个碎图图标
  it('加载失败的图不再占位', async () => {
    const wrapper = mount(StepMediaStrip, { props: { images: images.slice(0, 2) } })
    await wrapper.find('img').trigger('error')
    expect(wrapper.findAll('img')).toHaveLength(1)
  })

  // 时间线一路往下滚，突然出声很唐突；也不为没人点的视频拉几十兆
  it('视频带播放控件、不自动播、只预载元数据', () => {
    const wrapper = mount(StepMediaStrip, {
      props: { images: [], videos: ['local-resource://v.mp4'] }
    })
    const video = wrapper.find('video')
    expect(video.attributes('controls')).toBeDefined()
    expect(video.attributes('autoplay')).toBeUndefined()
    expect(video.attributes('preload')).toBe('metadata')
  })

  it('什么都没有就不渲染', () => {
    const wrapper = mount(StepMediaStrip, { props: { images: [] } })
    expect(wrapper.find('.step-media-strip').exists()).toBe(false)
  })
})
