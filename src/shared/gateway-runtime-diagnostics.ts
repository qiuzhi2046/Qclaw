import {
  type GatewayControlUiAppDiagnostics,
  type GatewayPortOwner,
  type GatewayRuntimeClassification,
  type GatewayRuntimeEvidence,
  type GatewayRuntimeReasonDetail,
  type GatewayRuntimeStateCode,
} from './gateway-runtime-state'
import {
  buildGatewayRuntimeReasonDetailFromControlUi,
  sanitizeGatewayRuntimeReasonDetail,
} from './gateway-runtime-reason-detail'

interface GatewayRuntimeLike {
  ok?: boolean
  running?: boolean
  stdout?: string
  stderr?: string
  summary?: string
  stateCode?: GatewayRuntimeStateCode
  reasonDetail?: GatewayRuntimeReasonDetail | null
  evidence?: GatewayRuntimeEvidence[]
  diagnostics?: {
    lastHealth?: {
      raw?: string
      stderr?: string
      stateCode?: GatewayRuntimeStateCode
      summary?: string
    } | null
    doctor?: {
      stdout?: string
      stderr?: string
    } | null
    controlUiApp?: GatewayControlUiAppDiagnostics | null
  }
  portOwner?: GatewayPortOwner | null
}

function joinNonEmpty(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n')
}

function resolveExplicitSummary(input: GatewayRuntimeLike): string {
  const reasonDetail =
    sanitizeGatewayRuntimeReasonDetail(input.reasonDetail) ||
    buildGatewayRuntimeReasonDetailFromControlUi(input.diagnostics?.controlUiApp)
  return (
    String(input.summary || '').trim() ||
    String(reasonDetail?.message || '').trim() ||
    String(input.diagnostics?.lastHealth?.summary || '').trim() ||
    '网关运行状态已结构化识别'
  )
}

function buildCorpus(input: GatewayRuntimeLike): string {
  return joinNonEmpty([
    input.stderr,
    input.stdout,
    input.diagnostics?.lastHealth?.stderr,
    input.diagnostics?.lastHealth?.raw,
    input.diagnostics?.doctor?.stderr,
    input.diagnostics?.doctor?.stdout,
    input.diagnostics?.controlUiApp?.lastError,
  ]).toLowerCase()
}

function isPluginAllowlistWarning(corpus: string): boolean {
  return (
    /plugins?\.allow is empty/i.test(corpus) &&
    /discovered non-bundled plugins may auto-load/i.test(corpus)
  )
}

function hasHighConfidenceConfigInvalidSignal(corpus: string): boolean {
  return (
    /\bconfig invalid\b/i.test(corpus) ||
    /unknown channel id/i.test(corpus) ||
    /gateway aborted: config is invalid/i.test(corpus)
  )
}

function hasFilesystemPermissionSignal(corpus: string): boolean {
  return /\beacces\b|\beperm\b|permission denied|operation not permitted/i.test(corpus)
}

function buildEvidence(
  input: GatewayRuntimeLike,
  stateCode: GatewayRuntimeStateCode,
  summary: string,
  reasonDetail: GatewayRuntimeReasonDetail | null
): GatewayRuntimeEvidence[] {
  const evidence: GatewayRuntimeEvidence[] = []

  if (input.stderr || input.stdout) {
    evidence.push({
      source: input.running ? 'health' : 'start',
      message: summary,
      detail: joinNonEmpty([input.stderr, input.stdout]).slice(0, 2000),
    })
  }

  if (input.diagnostics?.doctor?.stderr || input.diagnostics?.doctor?.stdout) {
    evidence.push({
      source: 'doctor',
      message: `doctor 命中了 ${stateCode}`,
      detail: joinNonEmpty([
        input.diagnostics?.doctor?.stderr,
        input.diagnostics?.doctor?.stdout,
      ]).slice(0, 2000),
    })
  }

  if (input.diagnostics?.controlUiApp?.lastError || reasonDetail) {
    evidence.push({
      source: 'control-ui-app',
      message: reasonDetail?.message || 'OpenClaw Control UI 返回了结构化连接错误',
      detail: joinNonEmpty([
        input.diagnostics?.controlUiApp?.lastError,
        Array.isArray(input.diagnostics?.controlUiApp?.appKeys) &&
        input.diagnostics?.controlUiApp?.appKeys.length > 0
          ? `appKeys=${input.diagnostics?.controlUiApp?.appKeys.join(',')}`
          : '',
        typeof input.diagnostics?.controlUiApp?.connected === 'boolean'
          ? `connected=${String(input.diagnostics?.controlUiApp?.connected)}`
          : '',
        typeof input.diagnostics?.controlUiApp?.hasClient === 'boolean'
          ? `hasClient=${String(input.diagnostics?.controlUiApp?.hasClient)}`
          : '',
      ]).slice(0, 2000),
    })
  }

  if (input.portOwner) {
    evidence.push({
      source: 'port-owner',
      message: '检测到网关端口占用进程',
      detail: joinNonEmpty([
        input.portOwner.processName,
        input.portOwner.command,
        input.portOwner.pid ? `pid=${input.portOwner.pid}` : '',
      ]),
      port: input.portOwner.port,
      owner: input.portOwner,
    })
  }

  if (Array.isArray(input.evidence) && input.evidence.length > 0) {
    evidence.push(...input.evidence)
  }

  return evidence
}

function buildClassification(
  input: GatewayRuntimeLike,
  stateCode: GatewayRuntimeStateCode,
  summary: string,
  safeToRetry: boolean,
  reasonDetail: GatewayRuntimeReasonDetail | null = null
): GatewayRuntimeClassification {
  return {
    stateCode,
    summary,
    safeToRetry,
    evidence: buildEvidence(input, stateCode, summary, reasonDetail),
    reasonDetail,
  }
}

export function classifyGatewayRuntimeState(input: unknown): GatewayRuntimeClassification {
  const typed = (input && typeof input === 'object' ? input : {}) as GatewayRuntimeLike
  const reasonDetail =
    sanitizeGatewayRuntimeReasonDetail(typed.reasonDetail) ||
    buildGatewayRuntimeReasonDetailFromControlUi(typed.diagnostics?.controlUiApp)
  const explicitStateCode = typed.stateCode || typed.diagnostics?.lastHealth?.stateCode
  if (explicitStateCode && explicitStateCode !== 'unknown_runtime_failure') {
    const explicitSummary = resolveExplicitSummary(typed)
    return buildClassification(
      typed,
      explicitStateCode,
      explicitSummary,
      explicitStateCode !== 'config_invalid',
      reasonDetail
    )
  }

  if (typed.ok && (typed.running ?? true)) {
    return buildClassification(typed, 'healthy', '网关已确认可用', true, reasonDetail)
  }

  const corpus = buildCorpus(typed)
  const portOwner = typed.portOwner
  const hasPortConflictSignal =
    /\beaddrinuse\b|address already in use|port\b.*in use|listen\b.*in use|bind\b.*failed|already running locally/i.test(
      corpus
    ) || Boolean(portOwner && portOwner.kind !== 'none' && portOwner.kind !== 'unknown')

  if (hasPortConflictSignal) {
    if (portOwner?.kind === 'gateway' || portOwner?.kind === 'openclaw') {
      return buildClassification(
        typed,
        'port_conflict_same_gateway',
        '网关端口被现有 OpenClaw/网关进程占用',
        true
      )
    }

    return buildClassification(
      typed,
      'port_conflict_foreign_process',
      '网关端口被其他进程占用',
      true
    )
  }

  if (/gateway service not loaded/i.test(corpus)) {
    return buildClassification(typed, 'service_missing', '网关后台服务未安装或未加载', true)
  }

  if (/service install failed|failed to install gateway service/i.test(corpus)) {
    return buildClassification(typed, 'service_install_failed', '网关后台服务补装失败', true)
  }

  if (/service appears loaded|service failed|launchctl|daemon/i.test(corpus)) {
    return buildClassification(typed, 'service_loaded_but_stale', '网关后台服务存在但状态异常', true, reasonDetail)
  }

  if (reasonDetail?.source === 'control-ui-app') {
    if (reasonDetail.code === 'gateway_auth_token_mismatch' || reasonDetail.code === 'token_mismatch') {
      return buildClassification(typed, 'token_mismatch', reasonDetail.message, true, reasonDetail)
    }

    return buildClassification(typed, 'websocket_1006', reasonDetail.message, true, reasonDetail)
  }

  if (/gateway token mismatch|token mismatch/i.test(corpus)) {
    return buildClassification(typed, 'token_mismatch', '网关正在使用的 token 与当前配置不一致', true, reasonDetail)
  }

  if (hasFilesystemPermissionSignal(corpus)) {
    return buildClassification(typed, 'unknown_runtime_failure', '当前机器没有足够权限访问 OpenClaw 配置或运行目录', false, reasonDetail)
  }

  if (hasHighConfidenceConfigInvalidSignal(corpus)) {
    return buildClassification(typed, 'config_invalid', '网关配置不完整或格式无效', false, reasonDetail)
  }

  // Plugin load failures are checked BEFORE the broad websocket_1006 pattern (item 5).
  // A plugin crash often causes websocket_1006 as a secondary symptom; surfacing the
  // plugin error is more actionable than "abnormal closure".
  if (isPluginAllowlistWarning(corpus)) {
    return buildClassification(
      typed,
      'plugin_allowlist_warning',
      '网关检测到未显式放行的外部插件，已记录 allowlist 警告',
      true,
      reasonDetail
    )
  }

  if (/plugins?\.allow|plugin not found|failed to load plugin|failed to load from|manifest|export id/i.test(corpus)) {
    return buildClassification(typed, 'plugin_load_failure', '网关依赖的插件没有正常加载', false, reasonDetail)
  }

  if (/\b1006\b|abnormal closure|gateway closed|websocket/i.test(corpus)) {
    return buildClassification(typed, 'websocket_1006', '网关与上游的握手连接被异常关闭', true, reasonDetail)
  }

  if (
    /\bapi[_ -]?key\b|oauth|unauthorized|forbidden|not logged in|credential|auth(?:entication)?|login|expired/i.test(
      corpus
    )
  ) {
    return buildClassification(typed, 'auth_missing', '当前机器缺少可用的模型认证信息', false, reasonDetail)
  }

  if (/config|openclaw\.json|provider|model|missing required|invalid|parse|json/i.test(corpus)) {
    return buildClassification(typed, 'config_invalid', '网关配置不完整或格式无效', false, reasonDetail)
  }

  if (
    /\benotfound\b|\beconnrefused\b|\beconnreset\b|timed out|timeout|network|dns|proxy|certificate|tls|ssl|socket hang up|fetch failed|service unavailable/i.test(
      corpus
    )
  ) {
    return buildClassification(typed, 'network_blocked', '网关当前被网络或代理环境阻断', true, reasonDetail)
  }

  if (/not running|gateway not running|connection refused/i.test(corpus)) {
    return buildClassification(typed, 'gateway_not_running', '网关当前没有在本机运行', true, reasonDetail)
  }

  return buildClassification(typed, 'unknown_runtime_failure', '网关尚未完成就绪确认', true, reasonDetail)
}
