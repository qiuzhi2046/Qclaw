import { readConfig, readEnvFile } from './cli'
import { callGatewayRpcViaControlUiBrowser } from './openclaw-control-ui-rpc'
import {
  buildNextConfigWithAgentPrimaryModel,
  buildNextConfigWithDefaultModel,
} from '../../src/shared/model-config-gateway'
import { summarizeModelAuthDiagnosticState } from '../../src/shared/model-auth-diagnostic'
import { appendModelAuthDiagnosticLog } from './model-auth-diagnostic-log'

export interface UpstreamModelConfigWriteRequest {
  kind: 'default' | 'agent-primary'
  model: string
  agentId?: string
}

export interface UpstreamModelConfigWriteResult {
  ok: boolean
  wrote: boolean
  gatewayReloaded: boolean
  source: 'control-ui-config.apply'
  fallbackUsed: boolean
  fallbackReason?: string
  message?: string
}

interface UpstreamConfigSnapshotLike {
  config?: Record<string, any> | null
  hash?: string
  baseHash?: string
  valid?: boolean
  exists?: boolean
  raw?: string
}

function normalizeRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, any>
}

function resolveSnapshotHash(snapshot: UpstreamConfigSnapshotLike | null): string {
  return String(snapshot?.baseHash ?? snapshot?.hash ?? '').trim()
}

function resolveSnapshotConfig(snapshot: UpstreamConfigSnapshotLike | null): Record<string, any> | null {
  const config = normalizeRecord(snapshot?.config)
  return config ? JSON.parse(JSON.stringify(config)) as Record<string, any> : null
}

function describeUpstreamWriteFailure(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || '').trim()
  return message || fallback
}

function extractProviderIdFromModelKey(model: string): string {
  return String(model || '').trim().split('/')[0] || ''
}

async function getUpstreamConfigSnapshot(): Promise<UpstreamConfigSnapshotLike> {
  return await callGatewayRpcViaControlUiBrowser(
    {
      readConfig,
      readEnvFile,
    },
    'config.get',
    {},
  ) as UpstreamConfigSnapshotLike
}

export async function applyModelConfigViaUpstreamControlUi(
  request: UpstreamModelConfigWriteRequest
): Promise<UpstreamModelConfigWriteResult> {
  const model = String(request.model || '').trim()
  const agentId = String(request.agentId || '').trim()
  const providerId = extractProviderIdFromModelKey(model)
  await appendModelAuthDiagnosticLog({
    source: 'main:upstream-model-write',
    event: 'upstream-model-write-start',
    providerId,
    details: {
      kind: request.kind,
      model,
      agentId: agentId || undefined,
    },
  }).catch(() => null)
  if (!model) {
    return {
      ok: false,
      wrote: false,
      gatewayReloaded: false,
      source: 'control-ui-config.apply',
      fallbackUsed: true,
      fallbackReason: 'model-empty',
      message: '模型不能为空',
    }
  }
  if (request.kind === 'agent-primary' && !agentId) {
    return {
      ok: false,
      wrote: false,
      gatewayReloaded: false,
      source: 'control-ui-config.apply',
      fallbackUsed: true,
      fallbackReason: 'agent-id-empty',
      message: 'Agent ID 不能为空',
    }
  }

  let snapshot: UpstreamConfigSnapshotLike | null = null
  try {
    snapshot = await getUpstreamConfigSnapshot()
  } catch (error) {
    await appendModelAuthDiagnosticLog({
      source: 'main:upstream-model-write',
      event: 'upstream-model-write-config-get-failed',
      providerId,
      details: {
        kind: request.kind,
        model,
        message: describeUpstreamWriteFailure(error, '读取 OpenClaw 上游配置失败'),
      },
    }).catch(() => null)
    return {
      ok: false,
      wrote: false,
      gatewayReloaded: false,
      source: 'control-ui-config.apply',
      fallbackUsed: true,
      fallbackReason: 'config.get-failed',
      message: describeUpstreamWriteFailure(error, '读取 OpenClaw 上游配置失败'),
    }
  }

  if (snapshot?.valid === false) {
    return {
      ok: false,
      wrote: false,
      gatewayReloaded: false,
      source: 'control-ui-config.apply',
      fallbackUsed: true,
      fallbackReason: 'config.get-invalid',
      message: 'OpenClaw 上游配置当前无效，暂不通过 Control UI 写入',
    }
  }

  const baseHash = resolveSnapshotHash(snapshot)
  const baseConfig = resolveSnapshotConfig(snapshot)
  await appendModelAuthDiagnosticLog({
    source: 'main:upstream-model-write',
    event: 'upstream-model-write-config-get',
    providerId,
    details: {
      kind: request.kind,
      model,
      hasBaseHash: Boolean(baseHash),
      snapshotSummary: summarizeModelAuthDiagnosticState({
        providerId,
        config: baseConfig,
      }),
    },
  }).catch(() => null)
  if (!baseHash || !baseConfig) {
    return {
      ok: false,
      wrote: false,
      gatewayReloaded: false,
      source: 'control-ui-config.apply',
      fallbackUsed: true,
      fallbackReason: !baseHash ? 'config-hash-missing' : 'config-snapshot-missing',
      message: 'OpenClaw 上游配置快照不完整，暂不通过 Control UI 写入',
    }
  }

  let nextConfig: Record<string, any>
  try {
    nextConfig = request.kind === 'default'
      ? buildNextConfigWithDefaultModel(baseConfig, model)
      : buildNextConfigWithAgentPrimaryModel(baseConfig, agentId, model)
  } catch (error) {
    return {
      ok: false,
      wrote: false,
      gatewayReloaded: false,
      source: 'control-ui-config.apply',
      fallbackUsed: true,
      fallbackReason: 'next-config-build-failed',
      message: describeUpstreamWriteFailure(error, '准备上游模型配置失败'),
    }
  }

  try {
    await callGatewayRpcViaControlUiBrowser(
      {
        readConfig,
        readEnvFile,
      },
      'config.apply',
      {
        raw: `${JSON.stringify(nextConfig, null, 2)}\n`,
        baseHash,
      },
    )
    await appendModelAuthDiagnosticLog({
      source: 'main:upstream-model-write',
      event: 'upstream-model-write-success',
      providerId,
      details: {
        kind: request.kind,
        model,
        nextSummary: summarizeModelAuthDiagnosticState({
          providerId,
          config: nextConfig,
        }),
      },
    }).catch(() => null)
    return {
      ok: true,
      wrote: true,
      gatewayReloaded: true,
      source: 'control-ui-config.apply',
      fallbackUsed: false,
    }
  } catch (error) {
    await appendModelAuthDiagnosticLog({
      source: 'main:upstream-model-write',
      event: 'upstream-model-write-failed',
      providerId,
      details: {
        kind: request.kind,
        model,
        message: describeUpstreamWriteFailure(error, '通过 OpenClaw 上游配置写入模型失败'),
        nextSummary: summarizeModelAuthDiagnosticState({
          providerId,
          config: nextConfig,
        }),
      },
    }).catch(() => null)
    return {
      ok: false,
      wrote: false,
      gatewayReloaded: false,
      source: 'control-ui-config.apply',
      fallbackUsed: true,
      fallbackReason: 'config.apply-failed',
      message: describeUpstreamWriteFailure(error, '通过 OpenClaw 上游配置写入模型失败'),
    }
  }
}
