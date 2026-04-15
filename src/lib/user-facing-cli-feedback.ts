const ANSI_ESCAPE_SEQUENCE_REGEX =
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-_])/g
const NON_PRINTABLE_EXCEPT_NEWLINES_REGEX = /[\u0000-\u0008\u000B-\u001F\u007F]/g

const API_INVALID_REGEX =
  /\b(invalid api key|api[_ -]?key.+(?:invalid|incorrect|expired)|invalid credentials?|authentication failed|unauthorized|forbidden|status code 401|status code 403|token.+invalid|token mismatch|key.+无效|密钥.+无效)\b/i
const LOCAL_AUTH_CONFIG_FAILURE_REGEX =
  /\b(auth[- ]?profiles?\.json|auth profile|auth store|data\s*guard)\b|同步 main agent 的 auth profile|认证流程配置写入失败|OpenClaw 模型配置失败|本地认证存储|基线备份/i
const LOCAL_AUTH_CONFIG_FAILURE_MARKER_REGEX =
  /\b(failed|failure|locked|denied|permission|eacces|erofs|read-only|cannot write|write failed)\b|失败|锁定|权限|不可写|占用/i
const WRITE_FAILURE_REGEX =
  /\b(failed to write|write failed|cannot write|permission denied|operation not permitted|eacces|erofs|read-only file system|no space left on device|disk full|写入失败|保存失败|权限不足)\b/i
const GATEWAY_UNREADY_REGEX =
  /\b(gateway did not become reachable|not become reachable|gateway.+(?:offline|unreachable|not running)|connection refused|econnrefused|websocket.+(?:1006|1008)|gateway closed)\b|网关.+(?:尚未就绪|未就绪|未运行|不可用|无法确认|无法.*加载|重启失败|可用性确认失败)|无法确认网关已加载最新模型配置/i
const CLAWHUB_RATE_LIMIT_REGEX =
  /\bclawhub\b[\s\S]*\b(?:429|rate limit exceeded|too many requests)\b/i
const CLAWHUB_RESOLUTION_FAILED_REGEX = /resolving clawhub:[\s\S]*fetch failed/i
const NETWORK_BLOCKED_REGEX =
  /\b(timeout|timed out|network|dns|proxy|certificate|tls|ssl|socket hang up|econnreset|enotfound|fetch failed)\b/i
const PLUGIN_INSTALL_PERMISSION_MARKER = 'QCLAW_PLUGIN_INSTALL_PERMISSION_DENIED'
const PERMISSION_REPAIR_MARKER = 'QCLAW_PERMISSION_REPAIR'
const SKILL_MUTATION_BUSY_MARKER = 'QCLAW_SKILL_MUTATION_BUSY'

function stripCliControlSequences(text: string): string {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(ANSI_ESCAPE_SEQUENCE_REGEX, '')
    .replace(NON_PRINTABLE_EXCEPT_NEWLINES_REGEX, '')
}

function buildCorpus(stderr?: string, stdout?: string): string {
  return [stripCliControlSequences(String(stderr || '')), stripCliControlSequences(String(stdout || ''))]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n')
}

function extractPluginInstallPermissionHint(corpus: string): string | null {
  return extractMarkerMessage(
    corpus,
    PLUGIN_INSTALL_PERMISSION_MARKER,
    '检测到插件安装权限不足。请检查 ~/.openclaw 与 ~/.npm 的目录权限后重试。'
  )
}

function extractMarkerMessage(corpus: string, marker: string, fallback: string): string | null {
  const markerIndex = corpus.indexOf(marker)
  if (markerIndex < 0) return null
  const message = corpus
    .slice(markerIndex + marker.length)
    .trim()
  return message || fallback
}

function extractPermissionRepairHint(corpus: string): string | null {
  return extractMarkerMessage(
    corpus,
    PERMISSION_REPAIR_MARKER,
    '检测到本机权限异常，请先修复相关目录权限后重试。'
  )
}

function extractSkillMutationBusyHint(corpus: string): string | null {
  return extractMarkerMessage(
    corpus,
    SKILL_MUTATION_BUSY_MARKER,
    '已有一个 Skill 安装或删除操作正在进行，请稍后再试。'
  )
}

export function toUserFacingCliFailureMessage(params: {
  stderr?: string
  stdout?: string
  fallback: string
}): string {
  const fallback = String(params.fallback || '').trim() || '操作失败，请稍后重试。'
  const corpus = buildCorpus(params.stderr, params.stdout)
  if (!corpus) return fallback

  const pluginPermissionHint = extractPluginInstallPermissionHint(corpus)
  if (pluginPermissionHint) {
    return pluginPermissionHint
  }

  const permissionRepairHint = extractPermissionRepairHint(corpus)
  if (permissionRepairHint) {
    return permissionRepairHint
  }

  const skillMutationBusyHint = extractSkillMutationBusyHint(corpus)
  if (skillMutationBusyHint) {
    return skillMutationBusyHint
  }

  if (LOCAL_AUTH_CONFIG_FAILURE_REGEX.test(corpus) && LOCAL_AUTH_CONFIG_FAILURE_MARKER_REGEX.test(corpus)) {
    return '本地 OpenClaw 认证配置写入失败，请检查配置目录权限或关闭占用后重试。'
  }
  if (API_INVALID_REGEX.test(corpus)) {
    return 'API Key 无效、已过期或权限不足，请检查后重试。'
  }
  if (WRITE_FAILURE_REGEX.test(corpus)) {
    return '配置写入失败，请检查本机权限后重试。'
  }
  if (GATEWAY_UNREADY_REGEX.test(corpus)) {
    return '网关尚未就绪，请稍后重试。若持续失败，请重启网关后再试。'
  }
  if (CLAWHUB_RATE_LIMIT_REGEX.test(corpus)) {
    return 'ClawHub 当前请求过于频繁，已被限流，请稍后再试。'
  }
  if (CLAWHUB_RESOLUTION_FAILED_REGEX.test(corpus)) {
    return '插件源解析失败，请稍后重试。若该插件此前已安装，可直接继续绑定渠道。'
  }
  if (NETWORK_BLOCKED_REGEX.test(corpus)) {
    return '网络连接异常，请检查网络或代理配置后重试。'
  }

  return fallback
}

export function toUserFacingUnknownErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || '')
  return toUserFacingCliFailureMessage({
    stderr: message,
    fallback,
  })
}
