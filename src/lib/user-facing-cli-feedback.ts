import {
  buildCliFailureClassificationCorpus,
  classifySharedCliFailure,
} from '../shared/cli-failure-classification'

const CLAWHUB_RATE_LIMIT_REGEX =
  /\bclawhub\b[\s\S]*\b(?:429|rate limit exceeded|too many requests)\b/i
const CLAWHUB_RESOLUTION_FAILED_REGEX = /resolving clawhub:[\s\S]*fetch failed/i
const PLUGIN_QUARANTINE_REGEX =
  /\b(smoke test|quarantin(?:e|ed)|qclaw-quarantined-extensions|compatibility check)\b|已自动隔离|兼容性校验|隔离.*插件/i
const PLUGIN_INSTALL_PERMISSION_MARKER = 'QCLAW_PLUGIN_INSTALL_PERMISSION_DENIED'
const PERMISSION_REPAIR_MARKER = 'QCLAW_PERMISSION_REPAIR'
const SKILL_MUTATION_BUSY_MARKER = 'QCLAW_SKILL_MUTATION_BUSY'

function buildCorpus(stderr?: string, stdout?: string): string {
  return buildCliFailureClassificationCorpus(String(stderr || ''), String(stdout || ''))
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

  const sharedFailureCode = classifySharedCliFailure(corpus)
  if (sharedFailureCode === 'api_invalid') return 'API Key 无效、已过期或权限不足，请检查后重试。'
  if (sharedFailureCode === 'write_failure') return '配置写入失败，请检查本机权限后重试。'
  if (sharedFailureCode === 'gateway_unready') return '网关 token 已变更，请刷新后重新尝试'
  if (CLAWHUB_RATE_LIMIT_REGEX.test(corpus)) {
    return 'ClawHub 当前请求过于频繁，已被限流，请稍后再试。'
  }
  if (CLAWHUB_RESOLUTION_FAILED_REGEX.test(corpus)) {
    return '插件源解析失败，请稍后重试。若该插件此前已安装，可直接继续绑定渠道。'
  }
  if (PLUGIN_QUARANTINE_REGEX.test(corpus)) {
    return '插件安装后未通过兼容性校验，已被自动隔离。请升级 Qclaw 或官方插件后重试。'
  }
  if (sharedFailureCode === 'network_blocked') return '网络连接异常，请检查网络或代理配置后重试。'

  return fallback
}

export function toUserFacingUnknownErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || '')
  return toUserFacingCliFailureMessage({
    stderr: message,
    fallback,
  })
}
