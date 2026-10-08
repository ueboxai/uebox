/**
 * 一次工具调用「对什么做的」：搜的词、读的路径、建的资产。
 *
 * 渲染层的过程行（`agentSteps.ts`）和主进程的子任务进度（`createAgent.ts`
 * 的 `runSubAgent`）用同一套取法 —— 子 agent 那一路点开，每一步要和主 agent
 * 的工具行说一样的话。
 */

/**
 * 从参数里取对象，按这个顺序找第一个有字的字段。
 *
 * 只认字符串：数组和对象说不成一句话，原文在展开区里。
 */
const TARGET_KEYS = [
  'query',
  'path',
  'file_path',
  'folder',
  'asset_path',
  'assetPath',
  'url',
  'name',
  'level',
  'actor_name',
  'actor',
  'blueprint',
  'blueprint_path',
  'material',
  'material_path',
  'command',
  'pattern',
  'target',
  'label',
  'action',
  'task',
  'prompt',
  'input_text',
  'script',
  // 只说了在哪个库里做、别的什么都没给时（资产库概况），库名就是对象
  'vault'
] as const

export const STEP_TARGET_MAX_LENGTH = 60

export function oneLine(text: string, maxLength: number): string {
  const line =
    text
      .split('\n')
      .map((part) => part.trim())
      .find(Boolean) ?? ''
  const normalized = line.replace(/\s+/g, ' ')
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized
}

function readUrlTarget(value: string): string {
  try {
    const url = new URL(value)
    return `${url.hostname}${url.pathname}`.replace(/\/$/, '') || url.hostname
  } catch {
    return value
  }
}

export function pickStepTarget(args: Record<string, unknown>): string {
  for (const key of TARGET_KEYS) {
    const value = args[key]
    if (typeof value !== 'string' || !value.trim()) continue
    return oneLine(key === 'url' ? readUrlTarget(value.trim()) : value, STEP_TARGET_MAX_LENGTH)
  }
  return ''
}
