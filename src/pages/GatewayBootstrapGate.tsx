import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Text } from '@mantine/core'
import logoSrc from '@/assets/logo.png'
import {
  createDashboardEntryBootstrapState,
  resolveDashboardEntryBootstrapCopy,
  resolveDashboardEntryBootstrapProgress,
  type DashboardEntryPairingSummary,
  type DashboardEntrySnapshot,
  type DashboardEntryBootstrapState,
  type DashboardEntryBootstrapTaskKey,
  type DashboardEntryBootstrapTaskStatus,
} from '../shared/dashboard-entry-bootstrap'
import {
  type GatewayBootstrapFailureView,
} from '../shared/gateway-bootstrap-diagnostics'
import {
  getUpstreamModelStatusLike,
  readOpenClawUpstreamModelState,
} from '../shared/upstream-model-state'
import { listFeishuBots, sanitizeFeishuPluginConfig } from './feishu-bots'

interface FeishuRuntimeStatusSummary {
  runtimeState: 'online' | 'offline' | 'degraded' | 'disabled'
  summary: string
  issues: string[]
}

export interface DashboardEntryBootstrapApi {
  ensureGatewayRunning: (options?: { skipRuntimePrecheck?: boolean }) => Promise<{
    ok?: boolean
    running?: boolean
    summary?: string
    stderr?: string
    stdout?: string
  }>
  gatewayHealth: () => Promise<GatewayHealthCheckResult>
  readConfig: () => Promise<Record<string, any> | null>
  getModelUpstreamState: () => Promise<Awaited<ReturnType<typeof window.api.getModelUpstreamState>>>
  getModelStatus: () => Promise<{ ok: boolean; data?: Record<string, any> | null }>
  pairingFeishuStatus: (accountIds: string[]) => Promise<Record<string, { pairedCount: number; pairedUsers: string[] }>>
  getFeishuRuntimeStatus: () => Promise<Record<string, FeishuRuntimeStatusSummary>>
}

interface GatewayHealthCheckResult {
  running: boolean
  summary?: string
}

export interface DashboardEntryBootstrapFlowResult {
  snapshot: DashboardEntrySnapshot
  softWarnings: string[]
}

type TaskDetailState = Record<DashboardEntryBootstrapTaskKey, string>

interface DashboardEntryBootstrapFlowOptions {
  onTaskUpdate?: (
    key: DashboardEntryBootstrapTaskKey,
    status: DashboardEntryBootstrapTaskStatus,
    detail: string
  ) => void
  gatewayEnsureTimeoutMs?: number
  modelBootstrapTimeoutMs?: number
  pairingBootstrapTimeoutMs?: number
}

const INITIAL_TASK_STATE = createDashboardEntryBootstrapState()
const DASHBOARD_BOOTSTRAP_GATEWAY_ENSURE_TIMEOUT_MS = 3_000
const DASHBOARD_BOOTSTRAP_MODEL_TIMEOUT_MS = 750
const DASHBOARD_BOOTSTRAP_PAIRING_TIMEOUT_MS = 750

const INITIAL_TASK_DETAILS: TaskDetailState = {
  gateway: '读取当前网关状态，运行状态问题会在控制面板内继续处理。',
  config: '读取控制面板首屏所需的配置快照。',
  pairing: '汇总渠道接通、飞书运行状态和配对状态。',
}

function createTaskDetailState(): TaskDetailState {
  return { ...INITIAL_TASK_DETAILS }
}

async function withTimeoutFallback<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function createGenericFailureView(
  title: string,
  detail: string,
  hints: string[] = []
): GatewayBootstrapFailureView {
  return { title, detail, hints }
}

function summarizeConfig(config: Record<string, any> | null): string {
  if (!config || typeof config !== 'object') {
    return '当前配置为空，已按空配置快照继续。'
  }

  const channelCount = Object.keys(config.channels || {}).length
  const providerCount = Object.keys(config.models || {}).length
  return `已读取当前配置，发现 ${channelCount} 个渠道配置、${providerCount} 个模型提供商配置。`
}

function logAndReturnUiWarning(logLabel: string, uiMessage: string, error: unknown): string {
  console.warn(logLabel, error)
  return uiMessage
}

function resolveGatewayBootstrapSummary(input: {
  ensureResult?: {
    ok?: boolean
    running?: boolean
    summary?: string
    stderr?: string
    stdout?: string
  } | null
  health?: GatewayHealthCheckResult | null
}): string {
  return String(
    input.ensureResult?.summary
      || input.ensureResult?.stderr
      || input.ensureResult?.stdout
      || input.health?.summary
      || ''
  ).trim()
}

async function resolveBootstrapModelStatus(
  api: DashboardEntryBootstrapApi,
  timeoutMs: number,
  softWarnings: string[]
): Promise<Record<string, any> | null> {
  const deadlineAt = Date.now() + timeoutMs
  const readWithinBudget = async <T,>(promise: Promise<T>) => {
    const remainingMs = Math.max(1, deadlineAt - Date.now())
    return withTimeoutFallback(promise, remainingMs)
  }

  const upstreamStateResult = await readWithinBudget(
    readOpenClawUpstreamModelState(api.getModelUpstreamState)
  )
  if (upstreamStateResult.timedOut) {
    softWarnings.push('模型状态整理仍在后台继续，控制面板先按当前已知配置打开。')
    return null
  }

  const upstreamModelState = upstreamStateResult.value
  const upstreamModelStatus = getUpstreamModelStatusLike(upstreamModelState)
  if (upstreamModelState.fallbackUsed && upstreamModelState.fallbackReason) {
    softWarnings.push(logAndReturnUiWarning(
      'model upstream state fallback used',
      '暂时无法读取最新模型状态，当前先按已有配置显示模型信息。',
      upstreamModelState.fallbackReason
    ))
  }
  if (upstreamModelStatus) {
    return upstreamModelStatus
  }

  const modelStatusResult = await readWithinBudget(api.getModelStatus().catch(() => null))
  if (modelStatusResult.timedOut) {
    softWarnings.push('模型状态整理仍在后台继续，控制面板先按当前已知配置打开。')
    return null
  }

  const resolvedModelStatus = modelStatusResult.value?.ok
    ? ((modelStatusResult.value.data as Record<string, any>) || null)
    : null
  if (!resolvedModelStatus) {
    softWarnings.push('模型状态暂时不可用，稍后可在控制面板中刷新。')
  }
  return resolvedModelStatus
}

async function resolveBootstrapPairingSummary(
  api: DashboardEntryBootstrapApi,
  config: Record<string, any> | null,
  timeoutMs: number,
  notify: (
    key: DashboardEntryBootstrapTaskKey,
    status: DashboardEntryBootstrapTaskStatus,
    detail: string
  ) => void,
  softWarnings: string[]
): Promise<DashboardEntryPairingSummary | null> {
  notify('pairing', 'active', '正在整理配对状态...')
  const pairingSummaryResult = await withTimeoutFallback(summarizePairing(api, config), timeoutMs)
  if (pairingSummaryResult.timedOut) {
    notify('pairing', 'warning', '连接状态整理仍在后台继续，进入控制面板后可刷新。')
    softWarnings.push('连接状态整理仍在后台继续，控制面板先按当前已知状态打开。')
    return null
  }

  const pairingSummary = pairingSummaryResult.value
  if (pairingSummary.warnings.length > 0) {
    notify('pairing', 'warning', pairingSummary.summary)
    softWarnings.push(...pairingSummary.warnings)
  } else {
    notify('pairing', 'done', pairingSummary.summary)
  }
  return pairingSummary.data
}

async function summarizePairing(
  api: DashboardEntryBootstrapApi,
  config: Record<string, any> | null
): Promise<{
  summary: string
  data: DashboardEntryPairingSummary | null
  warnings: string[]
}> {
  const normalizedConfig = sanitizeFeishuPluginConfig(config)
  const feishuBots = listFeishuBots(normalizedConfig)
  const otherChannelCount = Object.keys(config?.channels || {}).filter((id) => id !== 'feishu').length

  if (feishuBots.length === 0) {
    return {
      summary:
        otherChannelCount > 0
          ? `已整理 ${otherChannelCount} 个非飞书渠道状态，当前没有飞书机器人需要汇总配对状态。`
          : '当前没有需要汇总的渠道配对状态。',
      data: {
        feishuBotCount: 0,
        pairedBotCount: 0,
        degradedBotCount: 0,
        offlineBotCount: 0,
        otherChannelCount,
      },
      warnings: [],
    }
  }

  const accountIds = feishuBots.map((bot) => bot.accountId)
  const warnings: string[] = []
  const [pairingStatus, runtimeStatus] = await Promise.all([
    api.pairingFeishuStatus(accountIds).catch((error) => {
      warnings.push(logAndReturnUiWarning('feishu pairing status read failed during bootstrap', '飞书连接状态读取失败。', error))
      return null
    }),
    api.getFeishuRuntimeStatus().catch((error) => {
      warnings.push(logAndReturnUiWarning('feishu runtime status read failed during bootstrap', '飞书插件信息读取失败。', error))
      return null
    }),
  ])

  if (!pairingStatus || !runtimeStatus) {
    return {
      summary: `已读取 ${feishuBots.length} 个飞书机器人的基础配置，但配对状态或运行状态暂不可用。`,
      data: null,
      warnings,
    }
  }

  const pairedCount = feishuBots.filter((bot) => Number(pairingStatus[bot.accountId]?.pairedCount || 0) > 0).length
  const degradedCount = feishuBots.filter((bot) => runtimeStatus[bot.accountId]?.runtimeState === 'degraded').length
  const offlineCount = feishuBots.filter((bot) => runtimeStatus[bot.accountId]?.runtimeState === 'offline').length

  return {
    summary: `已整理 ${feishuBots.length} 个飞书机器人的状态，其中 ${pairedCount} 个已配对，${degradedCount} 个待修复，${offlineCount} 个离线。`,
    data: {
      feishuBotCount: feishuBots.length,
      pairedBotCount: pairedCount,
      degradedBotCount: degradedCount,
      offlineBotCount: offlineCount,
      otherChannelCount,
    },
    warnings,
  }
}

export async function runDashboardEntryBootstrapFlow(
  api: DashboardEntryBootstrapApi,
  options: DashboardEntryBootstrapFlowOptions = {}
): Promise<DashboardEntryBootstrapFlowResult> {
  const notify = (
    key: DashboardEntryBootstrapTaskKey,
    status: DashboardEntryBootstrapTaskStatus,
    detail: string
  ) => options.onTaskUpdate?.(key, status, detail)
  const gatewayEnsureTimeoutMs = Math.max(
    1,
    Number(options.gatewayEnsureTimeoutMs || DASHBOARD_BOOTSTRAP_GATEWAY_ENSURE_TIMEOUT_MS)
  )
  const modelBootstrapTimeoutMs = Math.max(
    1,
    Number(options.modelBootstrapTimeoutMs || DASHBOARD_BOOTSTRAP_MODEL_TIMEOUT_MS)
  )
  const pairingBootstrapTimeoutMs = Math.max(
    1,
    Number(options.pairingBootstrapTimeoutMs || DASHBOARD_BOOTSTRAP_PAIRING_TIMEOUT_MS)
  )

  notify('config', 'active', '正在读取当前配置...')
  const config = await api.readConfig().catch((error) => {
    console.warn('gateway bootstrap config read failed', error)
    notify('config', 'error', '当前无法读取必要配置，暂时不能进入控制面板。')
    throw createGenericFailureView(
      '配置暂时无法读取',
      'Qclaw 现在还不能读取进入控制面板所需的配置，请稍后重试。',
      ['先点击“重新检查”再试一次。', '如果问题仍然存在，可返回配置向导重新配置。']
    )
  })
  notify('config', 'done', summarizeConfig(config))

  const softWarnings: string[] = []
  notify('gateway', 'active', '正在读取当前网关状态...')
  const health = await api.gatewayHealth().catch((error) => {
    softWarnings.push(logAndReturnUiWarning('gateway health read failed during bootstrap', '暂时无法读取网关状态，控制面板会先按当前已知状态打开。', error))
    return null
  })
  let gatewayRunning = health?.running === true
  let gatewayEnsureResult: Awaited<ReturnType<DashboardEntryBootstrapApi['ensureGatewayRunning']>> | null = null

  if (!gatewayRunning) {
    const gatewayEnsureOutcome = await withTimeoutFallback(
      api.ensureGatewayRunning({ skipRuntimePrecheck: true }).catch((error) => {
        console.warn('gateway ensure failed during bootstrap', error)
        return null
      }),
      gatewayEnsureTimeoutMs
    )
    if (gatewayEnsureOutcome.timedOut) {
      console.warn(`gateway ensure timed out during bootstrap after ${gatewayEnsureTimeoutMs}ms`)
      softWarnings.push('网关仍在后台继续恢复，控制面板先按当前状态打开。')
    } else {
      gatewayEnsureResult = gatewayEnsureOutcome.value
      gatewayRunning = gatewayEnsureResult?.ok === true && gatewayEnsureResult?.running === true
    }
  }

  if (gatewayRunning) {
    notify(
      'gateway',
      'done',
      resolveGatewayBootstrapSummary({
        ensureResult: gatewayEnsureResult,
        health,
      }) || '网关已自动确认可用。'
    )
  } else {
    const gatewayWarning =
      resolveGatewayBootstrapSummary({
        ensureResult: gatewayEnsureResult,
        health,
      }) || '网关暂未就绪，进入控制面板后可继续处理。'
    if (health || gatewayEnsureResult) {
      softWarnings.push(`网关当前未就绪：${gatewayWarning}`)
    }
    notify('gateway', 'warning', '网关暂未就绪')
  }

  const [bootstrapModelStatus, bootstrapPairingSummaryData] = await Promise.all([
    resolveBootstrapModelStatus(api, modelBootstrapTimeoutMs, softWarnings).catch((error) => {
      softWarnings.push(logAndReturnUiWarning('bootstrap model status assembly failed', '模型状态整理失败。', error))
      return null
    }),
    resolveBootstrapPairingSummary(
      api,
      config,
      pairingBootstrapTimeoutMs,
      notify,
      softWarnings
    ).catch((error) => {
      notify('pairing', 'warning', '连接状态暂时读取失败，进入控制面板后可重新刷新。')
      softWarnings.push(logAndReturnUiWarning('pairing summary assembly failed during bootstrap', '连接状态整理失败。', error))
      return null
    }),
  ])

  return {
    snapshot: {
      gatewayRunning,
      config,
      pairingSummary: bootstrapPairingSummaryData,
      modelStatus: bootstrapModelStatus,
      loadedAt: new Date().toISOString(),
    },
    softWarnings,
  }

  const upstreamModelState = await readOpenClawUpstreamModelState(api.getModelUpstreamState)
  const upstreamModelStatus = getUpstreamModelStatusLike(upstreamModelState)
  if (upstreamModelState.fallbackUsed && upstreamModelState.fallbackReason) {
    softWarnings.push(logAndReturnUiWarning(
      'model upstream state fallback used',
      '暂时无法读取最新模型状态，当前先按已有配置显示模型信息。',
      upstreamModelState.fallbackReason
    ))
  }

  let modelStatus = upstreamModelStatus
  if (!modelStatus) {
    const modelStatusResult = await api.getModelStatus().catch(() => null)
    modelStatus = modelStatusResult?.ok
      ? ((modelStatusResult.data as Record<string, any>) || null)
      : null
  }
  if (!modelStatus) {
    softWarnings.push('模型状态暂时不可用，稍后可在控制面板中刷新。')
  }

  let pairingSummaryData: DashboardEntryPairingSummary | null = null
  notify('pairing', 'active', '正在整理配对状态...')
  try {
    const pairingSummary = await summarizePairing(api, config)
    pairingSummaryData = pairingSummary.data
    if (pairingSummary.warnings.length > 0) {
      notify('pairing', 'warning', pairingSummary.summary)
      softWarnings.push(...pairingSummary.warnings)
    } else {
      notify('pairing', 'done', pairingSummary.summary)
    }
  } catch (error) {
    notify('pairing', 'warning', '连接状态暂时读取失败，进入控制面板后可重新刷新。')
    softWarnings.push(logAndReturnUiWarning('pairing summary assembly failed during bootstrap', '连接状态整理失败。', error))
  }

  return {
    snapshot: {
      gatewayRunning,
      config,
      pairingSummary: pairingSummaryData,
      modelStatus,
      loadedAt: new Date().toISOString(),
    },
    softWarnings,
  }
}

export default function GatewayBootstrapGate({
  onReady,
  onReconfigure,
}: {
  onReady: (snapshot: DashboardEntrySnapshot) => void
  onReconfigure: () => void
}) {
  const [taskState, setTaskState] = useState<DashboardEntryBootstrapState>(INITIAL_TASK_STATE)
  const [taskDetails, setTaskDetails] = useState<TaskDetailState>(INITIAL_TASK_DETAILS)
  const [fatalError, setFatalError] = useState<GatewayBootstrapFailureView | null>(null)
  const [softWarnings, setSoftWarnings] = useState<string[]>([])
  const [bootstrapping, setBootstrapping] = useState(false)
  const activeAttemptRef = useRef(0)
  const bootstrappingRef = useRef(false)

  const progressPercent = useMemo(
    () => resolveDashboardEntryBootstrapProgress(taskState),
    [taskState]
  )
  const heroCopy = useMemo(
    () => resolveDashboardEntryBootstrapCopy(taskState),
    [taskState]
  )

  const updateTask = (
    key: DashboardEntryBootstrapTaskKey,
    status: DashboardEntryBootstrapTaskStatus,
    detail?: string
  ) => {
    setTaskState((current) => {
      return { ...current, [key]: status }
    })
    if (detail) {
      setTaskDetails((current) => ({ ...current, [key]: detail }))
    }
  }

  const runBootstrap = async () => {
    if (bootstrappingRef.current) return
    void window.api.appendEnvCheckDiagnostic('gateway-bootstrap-run-start', {
      alreadyBootstrapping: bootstrappingRef.current,
      activeAttempt: activeAttemptRef.current,
    }).catch(() => undefined)
    bootstrappingRef.current = true
    setBootstrapping(true)
    activeAttemptRef.current += 1
    const attemptId = activeAttemptRef.current
    setTaskState(createDashboardEntryBootstrapState())
    setTaskDetails(createTaskDetailState())
    setFatalError(null)
    setSoftWarnings([])

    try {
      const result = await runDashboardEntryBootstrapFlow(window.api, {
        onTaskUpdate: updateTask,
      })
      void window.api.appendEnvCheckDiagnostic('gateway-bootstrap-flow-result', {
        attemptId,
        gatewayRunning: result.snapshot.gatewayRunning,
        softWarningCount: result.softWarnings.length,
      }).catch(() => undefined)
      if (attemptId !== activeAttemptRef.current) return
      setSoftWarnings(result.softWarnings)
      window.setTimeout(() => {
        if (attemptId === activeAttemptRef.current) {
          void window.api.appendEnvCheckDiagnostic('gateway-bootstrap-ready', {
            attemptId,
            gatewayRunning: result.snapshot.gatewayRunning,
            softWarningCount: result.softWarnings.length,
          }).catch(() => undefined)
          onReady(result.snapshot)
        }
      }, 240)
    } catch (cause) {
      void window.api.appendEnvCheckDiagnostic('gateway-bootstrap-flow-failed', {
        attemptId,
        message: cause instanceof Error ? cause.message : String(cause || ''),
      }).catch(() => undefined)
      if (attemptId !== activeAttemptRef.current) return
      const fallbackView =
        cause && typeof cause === 'object' && 'title' in cause
          ? (cause as GatewayBootstrapFailureView)
          : createGenericFailureView(
              '最终检查未完成',
              '进入控制面板前的检查被中断，请重试。',
              ['先点击“重新检查”再试一次。', '如果问题仍然存在，再回到配置向导重新配置。']
            )
      setFatalError(fallbackView)
    } finally {
      if (attemptId === activeAttemptRef.current) {
        bootstrappingRef.current = false
        setBootstrapping(false)
      }
    }
  }

  useEffect(() => {
    void runBootstrap()
  }, [])

  return (
    <div className="w-full max-w-sm flex flex-col items-center gap-4">
      <img
        src={logoSrc}
        alt=""
        className="w-12 h-12 select-none pointer-events-none"
        style={{ animation: 'bounce-gentle 1.5s ease-in-out infinite' }}
      />
      <style>{`
        @keyframes bounce-gentle {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-8px); }
        }
      `}</style>
      <Text size="lg" fw={600} className="app-text-primary">正在进入控制面板</Text>

      {/* 进度条 */}
      <div className="w-full">
        <div className="flex items-center justify-between mb-1">
          <Text size="xs" c="dimmed">{heroCopy.title}</Text>
          <Text size="xs" c="dimmed">{progressPercent}%</Text>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full" style={{ backgroundColor: 'var(--app-bg-inset)' }}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${progressPercent}%`,
              backgroundColor: fatalError ? 'var(--mantine-color-red-6)' : 'var(--mantine-color-brand-5)',
            }}
          />
        </div>
      </div>

      {/* 当前步骤详情 */}
      <Text size="xs" c="dimmed" ta="center" lh={1.6}>
        {heroCopy.detail}
      </Text>

      {/* 软警告 */}
      {softWarnings.length > 0 && (
        <Alert color="yellow" variant="light" w="100%" styles={{ title: { fontSize: 'var(--mantine-font-size-xs)' } }}>
          {softWarnings.map((w) => (
            <Text key={w} size="xs">{w}</Text>
          ))}
        </Alert>
      )}

      {/* 致命错误 */}
      {fatalError && (
        <Alert color="red" variant="light" w="100%" title={fatalError.title} styles={{ title: { fontSize: 'var(--mantine-font-size-xs)' } }}>
          <Text size="xs" mb={fatalError.hints.length > 0 ? 'xs' : 0}>{fatalError.detail}</Text>
          {fatalError.hints.map((hint) => (
            <Text key={hint} size="xs" c="dimmed">• {hint}</Text>
          ))}
        </Alert>
      )}

      {/* 操作按钮 — 仅在失败或完成后显示 */}
      {(fatalError || !bootstrapping) && (
        <div className="flex gap-2">
          <Button
            onClick={() => void runBootstrap()}
            disabled={bootstrapping}
            size="xs"
          >
            {bootstrapping ? '检查中...' : fatalError ? '重试' : '重新检查'}
          </Button>
          <Button onClick={onReconfigure} variant="default" size="xs" disabled={bootstrapping}>
            重新配置
          </Button>
        </div>
      )}
    </div>
  )
}
