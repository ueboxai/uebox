/**
 * MRQ 渲出的 PNG 序列帧 → FFmpeg 合成 MP4。
 *
 * ## 为什么不用 MRQ 自己的 MP4 输出
 *
 * MRQ 的 MP4 编码器 5.6 才有，而在产的项目大多还在 5.0–5.4。先出 PNG 再合成，
 * 九个版本走同一条路；帧还留在盘上，要换码率、换格式、剪一段都不用重渲 ——
 * 重渲是按小时算的，重新编码是按秒算的。
 *
 * FFmpeg 用用户自己装的那一份（`services/ffmpegPath.ts`，不随包分发，理由见那个文件头）。
 *
 * ## 帧名怎么认
 *
 * MRQ 默认的文件名是 `{sequence_name}.{frame_number}`，帧号补零到 4 位：
 * `SQ_Intro.0000.png`。用户预设可能改过格式，所以不写死，从目录里实际的文件反推：
 * 按「前缀 + 扩展名」分组，取最大的一组，帧号的最短位数就是补零宽度
 * （帧号过了 9999 会自然变长，`%04d` 照样能对上）。
 *
 * FFmpeg 的 image2 遇到断号就停。帧号不连续时照实报出来，合成出来的视频会短一截。
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const FRAME_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.bmp']

export interface FramePattern {
  /** 传给 FFmpeg 的 `-i`，形如 `D:/out/SQ_Intro.%04d.png` */
  pattern: string
  /** 前缀去掉末尾的 `.` / `_`，用来给视频起名 */
  baseName: string
  startNumber: number
  /** 这一组实际有几帧 */
  count: number
  /** 帧号从头到尾是否连续 */
  contiguous: boolean
}

/** 从目录里的文件名反推帧序列。认不出来返回 null */
export function detectFramePattern(dir: string, fileNames: string[]): FramePattern | null {
  const groups = new Map<
    string,
    { prefix: string; ext: string; numbers: number[]; width: number }
  >()

  for (const name of fileNames) {
    const ext = path.extname(name).toLowerCase()
    if (!FRAME_EXTENSIONS.includes(ext)) continue
    const m = /^(.*?)(\d+)$/.exec(name.slice(0, -ext.length))
    if (!m) continue
    const [, prefix, digits] = m
    const key = `${prefix}\u0000${ext}`
    const group = groups.get(key) ?? { prefix, ext, numbers: [], width: digits.length }
    group.numbers.push(Number(digits))
    group.width = Math.min(group.width, digits.length)
    groups.set(key, group)
  }

  let best: { prefix: string; ext: string; numbers: number[]; width: number } | undefined
  for (const g of groups.values()) {
    if (!best || g.numbers.length > best.numbers.length) best = g
  }
  if (!best) return null

  const numbers = [...new Set(best.numbers)].sort((a, b) => a - b)
  const start = numbers[0]
  const end = numbers[numbers.length - 1]
  // FFmpeg 的 image2 pattern 里 % 是格式符，文件名里本来的 % 要写成 %%
  const escapedPrefix = best.prefix.replace(/%/g, '%%')
  const baseName = best.prefix.replace(/[._\-\s]+$/, '') || 'render'

  return {
    pattern: path.join(dir, `${escapedPrefix}%0${best.width}d${best.ext}`),
    baseName,
    startNumber: start,
    count: numbers.length,
    contiguous: end - start + 1 === numbers.length
  }
}

/**
 * FFmpeg 参数。
 *
 * - H.264 + yuv420p：随便哪个播放器、剪辑软件、网页都认
 * - CRF 18：肉眼基本看不出损失，是「交给人看」的档，不是存档的档 —— 要无损去拿 PNG
 * - pad 到偶数宽高：yuv420p 要求宽高都是偶数，用户填个 1001×563 就会直接报错
 */
export function buildFfmpegArgs(p: FramePattern, fps: string, output: string): string[] {
  return [
    '-hide_banner',
    '-y',
    '-framerate',
    fps,
    '-start_number',
    String(p.startNumber),
    '-i',
    p.pattern,
    '-frames:v',
    String(p.count),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '18',
    '-vf',
    'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    output
  ]
}

function runFfmpeg(ffmpeg: string, args: string[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, {
      windowsHide: true,
      signal,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let tail = ''
    child.stderr.on('data', (data: Buffer) => {
      tail = (tail + data.toString()).slice(-4000)
    })
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`FFmpeg 退出码 ${code}：${tail.slice(-1500)}`))
    )
  })
}

export interface ComposedVideo {
  path: string
  frames: number
  /** 帧号断开了 —— FFmpeg 只合到第一个缺口为止 */
  gapWarning?: string
}

/** 把 frameDir 里的序列帧合成 MP4，放在同一个目录 */
export async function composeVideo(options: {
  ffmpeg: string
  frameDir: string
  fps: string
  signal?: AbortSignal
}): Promise<ComposedVideo> {
  const names = await fs.readdir(options.frameDir)
  const pattern = detectFramePattern(options.frameDir, names)
  if (!pattern) {
    throw new Error(`${options.frameDir} 里没有认得出的序列帧（png / jpg / bmp）`)
  }

  const output = path.join(options.frameDir, `${pattern.baseName}.mp4`)
  await runFfmpeg(options.ffmpeg, buildFfmpegArgs(pattern, options.fps, output), options.signal)

  // 回执只说盘上真有的东西
  await fs.access(output)
  return {
    path: output,
    frames: pattern.count,
    ...(pattern.contiguous
      ? {}
      : { gapWarning: `帧号不连续（共 ${pattern.count} 帧），视频只合到第一个缺口为止` })
  }
}
