/**
 * 语音任务对话的 id 规则：从说话那条对话的 id 加灶名派生。
 *
 * 放在 shared 是因为主进程也要认它：独立聊天窗口里开的通话，派出去的任务对话
 * 归那个窗口管（同步、审批），主进程得能从 id 认出它是哪条对话派生的。
 * 为什么这么派生，见 `renderer/.../composables/voiceSessions.ts` 文件头。
 */

/**
 * 这通电话某个灶的活落在哪条对话上。
 *
 * 从说话那条的 id 加灶名派生，所以是纯函数、不用另存一份对应关系。
 * 前缀写死，普通会话 id 是 base36 时间戳，撞不上。
 */
export const VOICE_TASK_PREFIX = 'voice-tasks-'

/**
 * 灶名和 chatSid 之间的分隔符。
 *
 * `::` 而不是 `-`：普通会话 id 是 base36 时间戳，里面不会有它，
 * 而灶名归一之后可能带连字符（`content-cleanup`）—— 用 `-` 分的话切不回来。
 */
export const WORKER_SEPARATOR = '::'

export function voiceTaskSessionId(chatSid: string, workerKey: string): string {
  return `${VOICE_TASK_PREFIX}${chatSid}${WORKER_SEPARATOR}${workerKey}`
}

/** 这条对话是某通电话的任务对话吗 */
export function isVoiceTaskSessionId(sessionId: string): boolean {
  return sessionId.startsWith(VOICE_TASK_PREFIX)
}

/** 这条任务对话属于哪通电话。不是任务对话就返回空串 */
export function voiceTaskOwnerSid(sessionId: string): string {
  if (!isVoiceTaskSessionId(sessionId)) return ''
  const rest = sessionId.slice(VOICE_TASK_PREFIX.length)
  const at = rest.lastIndexOf(WORKER_SEPARATOR)
  return at === -1 ? rest : rest.slice(0, at)
}

/** 这条对话是 `chatSid` 本身，或者是它那通电话派生出来的任务对话 */
export function belongsToChat(sessionId: string, chatSid: string): boolean {
  return Boolean(chatSid) && (sessionId === chatSid || voiceTaskOwnerSid(sessionId) === chatSid)
}
