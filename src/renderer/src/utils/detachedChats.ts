/**
 * 主窗口这边记着：哪些对话现在开在独立窗口里。
 *
 * 只有一个用处 —— 主窗口里任何「打开这条对话」（点侧边栏、点系统通知、对话里的链接）
 * 都改成把那个独立窗口提到前面，而不是在主窗口里再开一个标签。路由守卫读它
 * （见 `router/index.ts`），由 `chatWindowSync.ts` 按主进程的通知维护。
 */

const detached = new Set<string>()

export function setDetachedChats(chatSids: readonly string[]): void {
  detached.clear()
  for (const sid of chatSids) if (sid) detached.add(sid)
}

export function isDetachedChat(chatSid: unknown): chatSid is string {
  return typeof chatSid === 'string' && chatSid !== '' && detached.has(chatSid)
}
