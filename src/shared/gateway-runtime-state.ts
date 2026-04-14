export const DEFAULT_GATEWAY_PORT = 18789

export type GatewayRuntimeStateCode =
  | 'healthy'
  | 'service_missing'
  | 'service_install_failed'
  | 'service_loaded_but_stale'
  | 'gateway_not_running'
  | 'port_conflict_same_gateway'
  | 'port_conflict_foreign_process'
  | 'token_mismatch'
  | 'websocket_1006'
  | 'auth_missing'
  | 'plugin_allowlist_warning'
  | 'plugin_load_failure'
  | 'config_invalid'
  | 'network_blocked'
  | 'unknown_runtime_failure'

export type GatewayRecoveryAction =
  | 'prepare-runtime'
  | 'install-plugin'
  | 'install-service'
  | 'start-gateway'
  | 'restart-gateway'
  | 'stop-gateway'
  | 'migrate-port'
  | 'wait-ready'
  | 'run-doctor'

export type GatewayRecoveryOutcome =
  | 'not-needed'
  | 'recovered'
  | 'blocked'
  | 'failed'
  | 'degraded'

export type GatewayPortOwnerKind = 'none' | 'gateway' | 'openclaw' | 'foreign' | 'unknown'

export interface GatewayPortOwner {
  kind: GatewayPortOwnerKind
  port: number
  pid?: number | null
  processName?: string
  command?: string
  source: 'lsof' | 'powershell' | 'unknown'
}

export interface GatewayControlUiAppDiagnostics {
  source: 'control-ui-app'
  connected: boolean
  hasClient: boolean
  lastError?: string
  appKeys: string[]
}

export interface GatewayRuntimeReasonDetail {
  source: 'control-ui-app' | 'service-install'
  code: string
  message: string
  rawMessage?: string
}

export interface GatewayRuntimeEvidence {
  source:
    | 'health'
    | 'start'
    | 'restart'
    | 'doctor'
    | 'port-owner'
    | 'config'
    | 'service'
    | 'control-ui-app'
  message: string
  detail?: string
  port?: number
  owner?: GatewayPortOwner | null
}

export interface GatewayRuntimeClassification {
  stateCode: GatewayRuntimeStateCode
  summary: string
  safeToRetry: boolean
  evidence: GatewayRuntimeEvidence[]
  reasonDetail?: GatewayRuntimeReasonDetail | null
}

export function resolveGatewayConfiguredPort(config: Record<string, any> | null | undefined): number {
  const rawPort = config?.gateway?.port
  const normalizedPort =
    typeof rawPort === 'number'
      ? rawPort
      : typeof rawPort === 'string'
      ? Number.parseInt(rawPort, 10)
      : Number.NaN

  if (Number.isInteger(normalizedPort) && normalizedPort > 0 && normalizedPort <= 65535) {
    return normalizedPort
  }

  return DEFAULT_GATEWAY_PORT
}

export function isManagedGatewayPort(
  config: Record<string, any> | null | undefined,
  port = resolveGatewayConfiguredPort(config)
): boolean {
  const rawPort = config?.gateway?.port
  return rawPort == null || String(rawPort).trim() === '' || port === DEFAULT_GATEWAY_PORT
}
