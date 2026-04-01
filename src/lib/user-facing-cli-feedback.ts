const ANSI_ESCAPE_SEQUENCE_REGEX =
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-_])/g
const NON_PRINTABLE_EXCEPT_NEWLINES_REGEX = /[\u0000-\u0008\u000B-\u001F\u007F]/g

const API_INVALID_REGEX =
  /\b(invalid api key|api[_ -]?key.+(?:invalid|incorrect|expired)|invalid credentials?|authentication failed|unauthorized|forbidden|status code 401|status code 403|token.+invalid|token mismatch|key.+无效|密钥.+无效)\b/i
const WRITE_FAILURE_REGEX =
  /\b(failed to write|write failed|cannot write|permission denied|operation not permitted|eacces|erofs|read-only file system|no space left on device|disk full|写入失败|保存失败|权限不足)\b/i
const GATEWAY_UNREADY_REGEX =
  /\b(gateway did not become reachable|not become reachable|gateway.+(?:offline|unreachable|not running)|connection refused|econnrefused|websocket.+(?:1006|1008)|gateway closed)\b/i
const CLAWHUB_RATE_LIMIT_REGEX =
  /\bclawhub\b[\s\S]*\b(?:429|rate limit exceeded|too many requests)\b/i
const CLAWHUB_RESOLUTION_FAILED_REGEX = /resolving clawhub:[\s\S]*fetch failed/i
const PLUGIN_PACKAGE_NOT_FOUND_REGEX =
  /\b(?:package not found on npm|not found - get https:\/\/registry\.npmjs\.org\/|also not a valid hook pack)\b/i
const OPENCLAW_CONFIG_COMPATIBILITY_REGEX =
  /\b(?:config invalid|unknown channel id|unknown config keys|unrecognized key|doctor --fix|doctor --repair)\b/i
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

  if (API_INVALID_REGEX.test(corpus)) {
    return 'API Key 无效、已过期或权限不足，请检查后重试。'
  }
  if (WRITE_FAILURE_REGEX.test(corpus)) {
    return '配置写入失败，请检查本机权限后重试。'
  }
  if (GATEWAY_UNREADY_REGEX.test(corpus)) {
    return 'Gateway 尚未就绪，请稍后重试。若持续失败，请重启 Gateway 后再试。'
  }
  if (CLAWHUB_RATE_LIMIT_REGEX.test(corpus)) {
    return 'ClawHub 当前请求过于频繁，已被限流，请稍后再试。'
  }
  if (CLAWHUB_RESOLUTION_FAILED_REGEX.test(corpus)) {
    return '插件源解析失败，请稍后重试。若该插件此前已安装，可直接继续绑定渠道。'
  }
  if (PLUGIN_PACKAGE_NOT_FOUND_REGEX.test(corpus)) {
    return '插件包不存在或尚未发布，请确认插件名称正确，或等待对应插件发布后再试。'
  }
  if (OPENCLAW_CONFIG_COMPATIBILITY_REGEX.test(corpus)) {
    return '当前 OpenClaw 配置与版本契约不兼容，请先执行官方配置修复后重试。'
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
