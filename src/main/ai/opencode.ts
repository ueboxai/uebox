import { randomUUID } from 'crypto'
import { app } from 'electron'

/**
 * OpenCode Go / Zen 的请求头。
 *
 * 官方要求第三方客户端带自己的 User-Agent（不能是通用 SDK 名），每段对话在
 * `x-opencode-session` 里带一个稳定的会话 id，缺了直接 400 MissingSessionID。
 * 见 https://opencode.ai/docs/go/#where-can-i-use-it
 *
 * 按 baseUrl 认，不按 provider id：用户自己建的自定义来源指到这里也要带。
 */
export function isOpenCodeEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname
    return host === 'opencode.ai' || host.endsWith('.opencode.ai')
  } catch {
    return false
  }
}

/**
 * 不传 sessionId 时每次生成一个：取标题、压缩摘要这类一次性请求本来就只有一轮。
 * Agent 那条路在 streamFn 里用对话的缓存键覆盖它，见 core/streamFn.ts。
 */
export function openCodeHeaders(sessionId?: string): Record<string, string> {
  return {
    'User-Agent': `uebox/${appVersion()}`,
    'x-opencode-session': sessionId || randomUUID()
  }
}

function appVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return 'dev'
  }
}
