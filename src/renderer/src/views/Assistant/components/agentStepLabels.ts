/**
 * 步骤行上的人话：工具名翻成动作，毫秒翻成「12.3s」「1 分 12 秒」。
 *
 * 工具名的查法是两张表 + 回退：
 *   1. `assistant.agentProcess.tools.*` —— 过程里常见的那些，包括只读的（搜索、查看、截图）
 *   2. `assistant.changes.tools.*` —— 「本轮改动」那张表，写操作都在里面，不再抄一份
 *   3. 都没有就原样显示工具名
 * 漏配一个的表现是「显示得糙一点」，不是 undefined。
 */

type Translate = (key: string, named?: Record<string, unknown>) => string
type HasKey = (key: string) => boolean

/** 外接的引擎工具集（MCP）。名字是服务器自己起的，翻不了，去掉前缀照原样说 */
const MCP_PREFIX = 'mcp_'

export function resolveToolLabel(toolName: string, t: Translate, te: HasKey): string {
  if (!toolName) return t('assistant.agentProcess.unknownTool')
  for (const key of [
    `assistant.agentProcess.tools.${toolName}`,
    `assistant.changes.tools.${toolName}`
  ]) {
    if (te(key)) return t(key)
  }
  return toolName.startsWith(MCP_PREFIX) ? toolName.slice(MCP_PREFIX.length) : toolName
}

/** 一分钟以内带一位小数（跟原来的计时一致），再往上只说到秒、到分 */
export function formatStepDuration(ms: number, t: Translate): string {
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 60) return t('assistant.agentProcess.steps.seconds', { s: seconds.toFixed(1) })
  const whole = Math.round(seconds)
  if (whole < 3600) {
    return t('assistant.agentProcess.steps.minutes', {
      m: Math.floor(whole / 60),
      s: whole % 60
    })
  }
  return t('assistant.agentProcess.steps.hours', {
    h: Math.floor(whole / 3600),
    m: Math.floor((whole % 3600) / 60)
  })
}
