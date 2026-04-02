import type {
  GatewayControlUiAppDiagnostics,
  GatewayRuntimeReasonDetail,
} from './gateway-runtime-state'

function normalizeReasonCode(value: unknown): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null

  const snakeCaseMatch = raw.match(/\b([a-z]+(?:_[a-z0-9]+)+)\b/)
  if (snakeCaseMatch) {
    return snakeCaseMatch[1]
  }

  if (/device token mismatch/i.test(raw)) return 'device_token_mismatch'
  if (/gateway auth token mismatch/i.test(raw)) return 'gateway_auth_token_mismatch'
  if (/token mismatch/i.test(raw)) return 'token_mismatch'
  if (/connection timeout|timed out/i.test(raw)) return 'control_ui_connection_timeout'

  return null
}

export function describeGatewayRuntimeReasonDetail(
  detail: GatewayRuntimeReasonDetail | null | undefined
): string | null {
  if (!detail) return null

  switch (detail.code) {
    case 'device_token_mismatch':
      return '控制界面与本地网关的 device token 不一致'
    case 'gateway_auth_token_mismatch':
    case 'token_mismatch':
      return '控制界面与网关的 auth token 不一致'
    case 'control_ui_connection_timeout':
      return '控制界面连接网关超时'
    default:
      if (detail.rawMessage && detail.rawMessage !== detail.code) {
        return `OpenClaw Control UI 返回：${detail.rawMessage}`
      }
      return `OpenClaw Control UI 返回：${detail.code}`
  }
}

export function buildGatewayRuntimeReasonDetailFromControlUi(
  diagnostics: GatewayControlUiAppDiagnostics | null | undefined
): GatewayRuntimeReasonDetail | null {
  const rawMessage = String(diagnostics?.lastError || '').trim()
  if (!rawMessage) return null

  const code = normalizeReasonCode(rawMessage) || 'control_ui_error'
  return {
    source: 'control-ui-app',
    code,
    message:
      describeGatewayRuntimeReasonDetail({
        source: 'control-ui-app',
        code,
        message: rawMessage,
        rawMessage,
      }) || rawMessage,
    rawMessage,
  }
}

export function sanitizeGatewayRuntimeReasonDetail(
  value: unknown
): GatewayRuntimeReasonDetail | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const source = String(record.source || '').trim()
  const code = String(record.code || '').trim()
  const message = String(record.message || '').trim()
  const rawMessage = String(record.rawMessage || '').trim()

  if (source !== 'control-ui-app' || !code || !message) {
    return null
  }

  return {
    source: 'control-ui-app',
    code,
    message,
    rawMessage: rawMessage || undefined,
  }
}
