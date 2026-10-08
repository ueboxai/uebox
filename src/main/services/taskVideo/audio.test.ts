/** @vitest-environment node */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../../ai/store', () => ({
  readSettings: vi.fn(async () => ({
    roles: { tts: { providerId: 'voice', modelId: 'model' } },
    providers: [
      {
        id: 'voice',
        kind: 'tts',
        baseUrl: 'https://fixture.invalid',
        models: [{ id: 'model', ttsVoice: 'test' }]
      }
    ]
  }))
}))
vi.mock('../../ai/speech', () => ({
  requestSpeech: vi.fn(async (_p, _m, _t, _s, onAudio) =>
    onAudio({ base64: Buffer.alloc(5 * 48000).toString('base64') })
  )
}))
import { requestSpeech } from '../../ai/speech'
import { pcmToWav, prepareVideoAudio, resolveSpeechBinding, speakToFile } from './audio'
import { VideoStoryboard } from './schema'
const dirs: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})
it('locks actual narration duration before animation and reuses it when only visuals change', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'art-audio-'))
  dirs.push(dir)
  const board = VideoStoryboard.parse({
    title: 'art',
    mode: 'promo',
    scenes: [
      {
        id: 'one',
        kind: 'text',
        sourceNote: 'test',
        title: 'first',
        caption: '',
        narration: 'voice',
        duration: 2
      }
    ]
  })
  const first = await prepareVideoAudio(dir, board)
  expect(first.storyboard.scenes[0].duration).toBeCloseTo(5.3666667)
  expect(first.voiceUsed).toBe(true)
  const second = await prepareVideoAudio(dir, {
    ...first.storyboard,
    scenes: [
      {
        ...first.storyboard.scenes[0],
        kind: 'composition',
        source: 'C:/art.html',
        title: 'revised'
      }
    ]
  })
  expect(second.audio).toEqual(first.audio)
  expect(requestSpeech).toHaveBeenCalledTimes(1)
})

it('keeps authored composition timing when unvoiced metadata is not shown on screen', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'art-timing-'))
  dirs.push(dir)
  const board = VideoStoryboard.parse({
    title: 'art',
    mode: 'promo',
    voice: 'off',
    scenes: [
      {
        id: 'one',
        kind: 'composition',
        source: 'C:/art.html',
        sourceNote: 'test',
        title: 'metadata',
        caption: 'x'.repeat(180),
        duration: 4
      }
    ]
  })
  const result = await prepareVideoAudio(dir, board)
  expect(result.storyboard.scenes[0].duration).toBe(4)
  expect(requestSpeech).not.toHaveBeenCalled()
})

it('独立配音不需要视频工程：同样的话复用缓存，输出可播放的 WAV', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'speech-'))
  dirs.push(dir)
  const binding = (await resolveSpeechBinding())!
  const first = await speakToFile(binding, '呼叫指挥部', dir)
  const again = await speakToFile(binding, '呼叫指挥部', dir)
  expect(again).toEqual(first)
  expect(first.seconds).toBe(5)
  expect(requestSpeech).toHaveBeenCalledTimes(1)
  const wav = path.join(dir, 'line.wav')
  await pcmToWav(first.path, wav)
  const bytes = await fs.readFile(wav)
  expect(bytes.subarray(0, 4).toString()).toBe('RIFF')
  expect(bytes.readUInt32LE(24)).toBe(24000)
  expect(bytes.readUInt32LE(40)).toBe(5 * 48000)
})
