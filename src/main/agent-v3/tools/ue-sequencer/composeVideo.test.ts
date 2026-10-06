/** @vitest-environment node */
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildFfmpegArgs, detectFramePattern } from './composeVideo'

const DIR = 'D:/out'

describe('detectFramePattern', () => {
  it('认 MRQ 默认的「序列名.帧号」，帧号补零宽度照文件名来', () => {
    const p = detectFramePattern(DIR, [
      'SQ_Intro.0000.png',
      'SQ_Intro.0001.png',
      'SQ_Intro.0002.png'
    ])
    expect(p).toEqual({
      pattern: path.join(DIR, 'SQ_Intro.%04d.png'),
      baseName: 'SQ_Intro',
      startNumber: 0,
      count: 3,
      contiguous: true
    })
  })

  it('只渲一段时从实际的第一帧开始', () => {
    const p = detectFramePattern(DIR, ['A.0100.png', 'A.0101.png'])
    expect(p?.startNumber).toBe(100)
  })

  it('帧号过了 9999 变长，补零宽度取最短的', () => {
    const p = detectFramePattern(DIR, ['A.9999.png', 'A.10000.png'])
    expect(p?.pattern).toBe(path.join(DIR, 'A.%04d.png'))
    expect(p?.contiguous).toBe(true)
  })

  it('断号照实报出来', () => {
    expect(detectFramePattern(DIR, ['A.0000.png', 'A.0002.png'])?.contiguous).toBe(false)
  })

  it('目录里混着别的文件时取帧最多的那一组', () => {
    const p = detectFramePattern(DIR, [
      'notes.txt',
      'thumb1.jpg',
      'S.0000.png',
      'S.0001.png',
      'S.0002.png'
    ])
    expect(p?.baseName).toBe('S')
    expect(p?.count).toBe(3)
  })

  it('文件名里的 % 转义成 %%，不被 FFmpeg 当成格式符', () => {
    expect(detectFramePattern(DIR, ['100%.0000.png'])?.pattern).toBe(
      path.join(DIR, '100%%.%04d.png')
    )
  })

  it('没有序列帧（只有 exr 或别的）返回 null', () => {
    expect(detectFramePattern(DIR, ['A.0000.exr', 'readme.md'])).toBeNull()
  })
})

describe('buildFfmpegArgs', () => {
  it('按序列帧率、起始帧和帧数出 H.264，宽高补成偶数', () => {
    const p = detectFramePattern(DIR, ['A.0010.png', 'A.0011.png'])!
    const args = buildFfmpegArgs(p, '30000/1001', 'D:/out/A.mp4')
    expect(args).toEqual(
      expect.arrayContaining(['-framerate', '30000/1001', '-start_number', '10', '-frames:v', '2'])
    )
    expect(args.join(' ')).toContain('-c:v libx264 -pix_fmt yuv420p')
    expect(args.join(' ')).toContain('pad=ceil(iw/2)*2:ceil(ih/2)*2')
    expect(args.at(-1)).toBe('D:/out/A.mp4')
  })
})
