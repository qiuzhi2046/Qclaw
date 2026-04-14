import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MantineThemeProvider } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import logoSrc from '@/assets/logo.png'
import Welcome from './pages/Welcome'
import StartupUpdatePrompt from './pages/StartupUpdatePrompt'
import EnvCheck from './pages/EnvCheck'
import ApiKeys, { type SetupModelContext } from './pages/ApiKeys'
import ChannelConnect, { type ChannelConnectNextPayload } from './pages/ChannelConnect'
import PairingCode from './pages/PairingCode'
import Dashboard from './pages/Dashboard'
import MainLayout from './components/MainLayout'
import ChatPage from './pages/ChatPage'
import ChannelsPage from './pages/ChannelsPage'
import ModelsPage from './pages/ModelsPage'
import SettingsPage from './pages/SettingsPage'
import SkillsPage from './pages/SkillsPage'
import AboutModal from './components/AboutModal'
import GatewayBootstrapGate from './pages/GatewayBootstrapGate'
import {
  readTooltipEnabled,
  writeTooltipEnabled,
} from './lib/tooltip-preference'
import {
  readChatComposerEnterSendMode,
  writeChatComposerEnterSendMode,
} from './lib/chat-composer-enter-send-preference'
import type { ChatComposerEnterSendMode } from './lib/chat-composer-enter-send-preference'
import { shouldCompleteChannelConnect } from './pages/channels-page-utils'
import type {
  EnvCheckReadyPayload,
  OpenClawDiscoveryResult,
} from './shared/openclaw-phase1'
import {
  resolveAppStateAfterSetupCompletion,
  resolveAppStateForPhase1Target,
} from './shared/dashboard-gateway-gate'
import type { DashboardEntrySnapshot } from './shared/dashboard-entry-bootstrap'
import {
  canOpenExternalModelsPage,
  type AppState,
} from './app-entry-gate'
import type {
  GatewayBlockingReason,
  OpenClawRuntimeReconcileStore,
  RuntimeReconcileStateCode,
} from './shared/gateway-runtime-reconcile-state'
import { describeGatewayRuntimeReasonDetail } from './shared/gateway-runtime-reason-detail'
import {
  formatOpenClawVersionLabel,
  normalizeOpenClawVersionDisplay,
} from './shared/openclaw-version-display'
import type { QClawUpdateStatus } from './shared/openclaw-phase4'
import { shouldShowQClawNewVersionButton } from './shared/qclaw-update-visibility'

type SetupStep = 'api-keys' | 'channel-connect' | 'pairing-code'

const SETUP_STEPS: { key: SetupStep; label: string }[] = [
  { key: 'api-keys', label: 'AI 提供商' },
  { key: 'channel-connect', label: '消息渠道' },
  { key: 'pairing-code', label: '配对' },
]
const MODELS_ROUTE_HASH = '#/models'
const OPENCLAW_322_NOTICE_ID = 'openclaw-3-22-main-control'
const PLUGIN_REPAIR_NOTICE_MESSAGE = '修复损坏插件并清理相关配置，不会清空其他用户数据。'
type OpenClawCapabilitiesSnapshot = Awaited<ReturnType<typeof window.api.getModelCapabilities>>
type PluginRepairOptions = Parameters<typeof window.api.repairIncompatiblePlugins>[0]
type PluginQuarantineOptions = Parameters<typeof window.api.scanIncompatiblePlugins>[0]
type PluginRepairResult = Awaited<ReturnType<typeof window.api.repairIncompatiblePlugins>>

const GLOBAL_PLUGIN_REPAIR_OPTIONS: PluginRepairOptions = {
  quarantineOfficialManagedPlugins: true,
  restoreConfiguredManagedChannels: true,
}
const GLOBAL_PLUGIN_REPAIR_REQUEST_KEY = buildPluginRepairRequestKey(GLOBAL_PLUGIN_REPAIR_OPTIONS)
const GLOBAL_PLUGIN_QUARANTINE_OPTIONS: PluginQuarantineOptions = {
  quarantineOfficialManagedPlugins: true,
}
const GLOBAL_PLUGIN_QUARANTINE_REQUEST_KEY = `scan:${buildPluginRepairRequestKey(GLOBAL_PLUGIN_QUARANTINE_OPTIONS)}`

interface ActivePluginRepairTask {
  requestKey: string
  promise: Promise<PluginRepairResult>
}

interface OpenClawEntryCompatibilitySnapshot {
  runtimeStore: OpenClawRuntimeReconcileStore | null
  capabilities: OpenClawCapabilitiesSnapshot | null
  gatewayRunning: boolean | null
}

export function applyLiveOpenClawVersionToRuntimeStore(
  runtimeStore: OpenClawRuntimeReconcileStore | null,
  liveVersion: string | null | undefined
): OpenClawRuntimeReconcileStore | null {
  if (!runtimeStore) return runtimeStore
  const normalizedLiveVersion = normalizeOpenClawVersionDisplay(liveVersion)
  if (!normalizedLiveVersion || runtimeStore.lastCompatibility.currentVersion === normalizedLiveVersion) {
    return runtimeStore
  }

  return {
    ...runtimeStore,
    lastSeenOpenClawVersion: normalizedLiveVersion,
    lastCompatibility: {
      ...runtimeStore.lastCompatibility,
      currentVersion: normalizedLiveVersion,
    },
  }
}

function resolveOpenClawNoticeTitleBase(
  currentVersion: string | null | undefined,
  is322Band: boolean
): string {
  if (is322Band) return 'OpenClaw 3.22'
  return formatOpenClawVersionLabel(currentVersion)
}

function isHealthDerivedRuntimeBlock(reason: GatewayBlockingReason): boolean {
  return (
    reason === 'upgrade_incompatible_config' ||
    reason === 'provider_plugin_not_ready' ||
    reason === 'control_ui_handshake_failed' ||
    reason === 'service_generation_stale'
  )
}

function describeRuntimeStateCode(stateCode: RuntimeReconcileStateCode): string {
  switch (stateCode) {
    case 'pending':
      return '待消费'
    case 'in_progress':
      return '收敛中'
    case 'degraded':
      return '降级'
    case 'blocked':
      return '阻塞'
    case 'ready':
      return '已就绪'
    default:
      return '空闲'
  }
}

function describeBlockingReason(reason: GatewayBlockingReason): string {
  switch (reason) {
    case 'upgrade_incompatible_config':
      return '升级后的配置尚未完全兼容'
    case 'machine_local_auth_missing':
      return '本机认证资料缺失'
    case 'runtime_token_stale':
      return '当前生效的令牌仍是旧值'
    case 'provider_plugin_not_ready':
      return '提供商插件还未完成就绪'
    case 'control_ui_handshake_failed':
      return '控制界面与网关握手失败'
    case 'service_generation_stale':
      return '守护进程仍在使用旧 generation'
    case 'legacy_env_alias_detected':
      return '仍存在 legacy env alias 漂移'
    case 'unknown_future_version':
      return '当前 OpenClaw 版本超出已审计范围'
    case 'unknown_runtime_state':
      return '运行状态仍无法可靠确认'
    default:
      return '无'
  }
}

export function buildOpenClaw322Notice(
  snapshot: OpenClawEntryCompatibilitySnapshot
): { title: string; message: string; color: 'blue' | 'yellow' | 'red'; showElevationAction?: boolean } | null {
  const runtimeStore = snapshot.runtimeStore
  const runtime = runtimeStore?.runtime || null
  const compatibility = runtimeStore?.lastCompatibility || null
  const capabilities = snapshot.capabilities
  const gatewayRunning = snapshot.gatewayRunning === true
  const messageParts: string[] = []
  let title = 'OpenClaw 3.22 兼容提示'
  let color: 'blue' | 'yellow' | 'red' = 'yellow'
  let showElevationAction = false

  const displayVersion = normalizeOpenClawVersionDisplay(compatibility?.currentVersion)
  const is322Band = compatibility?.currentBand === 'openclaw_2026_3_22'
  const titleBase = resolveOpenClawNoticeTitleBase(displayVersion, is322Band)
  const shouldSuppressStaleRuntimeAttention = Boolean(
    gatewayRunning && runtime && isHealthDerivedRuntimeBlock(runtime.blockingReason)
  )
  const runtimeNeedsAttention =
    !shouldSuppressStaleRuntimeAttention && (
      runtime?.stateCode === 'pending' ||
      runtime?.stateCode === 'in_progress' ||
      runtime?.stateCode === 'degraded' ||
      runtime?.stateCode === 'blocked'
    )
  const startupFallbackActive = Boolean(runtime?.launcherMode === 'startup-fallback')
  const authRegistryDegraded = Boolean(
    capabilities && (!capabilities.authRegistry.ok || String(capabilities.authRegistry.message || '').trim())
  )

  if (!is322Band && !runtimeNeedsAttention && !authRegistryDegraded && !startupFallbackActive) {
    return null
  }

  if (displayVersion) {
    messageParts.push(`当前检测到 OpenClaw ${displayVersion}。`)
  }

  if (runtimeNeedsAttention && runtime) {
    if (runtime.stateCode === 'blocked') {
      title = is322Band ? 'OpenClaw 3.22 收敛被阻塞' : `${titleBase} 运行状态被阻塞`
      color = 'red'
    } else if (runtime.stateCode === 'degraded') {
      title = is322Band ? 'OpenClaw 3.22 收敛存在降级项' : `${titleBase} 运行状态存在降级项`
      color = 'yellow'
    } else {
      title = is322Band ? 'OpenClaw 3.22 正在收敛运行状态' : `${titleBase} 正在收敛运行状态`
      color = 'blue'
    }

    const runtimeSummary = String(runtime.lastReconcileSummary || compatibility?.summary || '').trim()
    if (runtimeSummary) {
      messageParts.push(`运行状态：${describeRuntimeStateCode(runtime.stateCode)}。${runtimeSummary}`)
    } else {
      messageParts.push(`运行状态：${describeRuntimeStateCode(runtime.stateCode)}。`)
    }

    if (runtime.blockingReason !== 'none') {
      const blockingDetail = describeGatewayRuntimeReasonDetail(runtime.blockingDetail)
      messageParts.push(
        `当前归因：${blockingDetail || describeBlockingReason(runtime.blockingReason)}。`
      )
    }
  }

  if (is322Band) {
    messageParts.push('3.22 steady-state 已只读取 OPENCLAW_*；若机器上仍设置 CLAWDBOT_* 或 MOLTBOT_*，请尽快迁移。')
    messageParts.push('provider 与 skill discovery 已按 bundled plugin 路径收敛；裸 plugins install 的解析顺序也已变化。')
  }

  if (authRegistryDegraded && capabilities) {
    const registryMessage = String(capabilities.authRegistry.message || '').trim()
    messageParts.push(
      registryMessage || '当前 OpenClaw 认证元数据不完整，模型中心会按可识别结果降级展示认证方式。'
    )
    if (color === 'blue') {
      color = 'yellow'
      title = is322Band ? 'OpenClaw 3.22 兼容提示' : `${titleBase} 兼容提示`
    }
  }

  if (startupFallbackActive) {
    if (!runtimeNeedsAttention) {
      title = `${titleBase} 使用临时启动器运行`
      color = 'yellow'
    }
    messageParts.push(
      '网关当前通过 Windows Startup 启动器运行，建议升级为计划任务以获得更稳定的体验。'
    )
    showElevationAction = true
  }

  return {
    title,
    message: messageParts.join(' '),
    color,
    showElevationAction,
  }
}

function buildPluginRepairRequestKey(options?: PluginRepairOptions): string {
  const scopedPluginIds = Array.from(
    new Set((options?.scopePluginIds || []).map((value) => String(value || '').trim()).filter(Boolean))
  )
  const officialPolicyKey = options?.quarantineOfficialManagedPlugins ? ':official' : ''
  const restorePolicyKey = options?.restoreConfiguredManagedChannels ? ':restore-configured' : ''
  return scopedPluginIds.length > 0
    ? `scope:${scopedPluginIds.join(',')}${officialPolicyKey}${restorePolicyKey}`
    : `global${officialPolicyKey}${restorePolicyKey}`
}

function App() {
  const [appState, setAppState] = useState<AppState>('startup-update')
  const [startupUpdateStatus, setStartupUpdateStatus] = useState<
    Pick<QClawUpdateStatus, 'status' | 'availableVersion'> | null
  >(null)
  const [setupStep, setSetupStep] = useState<SetupStep>('api-keys')
  const [selectedChannel, setSelectedChannel] = useState<string>('feishu')
  const [selectedPairingAccountId, setSelectedPairingAccountId] = useState<string | undefined>(undefined)
  const [selectedPairingAccountName, setSelectedPairingAccountName] = useState<string | undefined>(undefined)
  const [setupModelContext, setSetupModelContext] = useState<SetupModelContext | null>(null)
  const [envSummary, setEnvSummary] = useState<EnvCheckReadyPayload | null>(null)
  const [discoveryResult, setDiscoveryResult] = useState<OpenClawDiscoveryResult | null>(null)
  const [pendingPhase1Target, setPendingPhase1Target] = useState<'setup' | 'dashboard' | null>(null)
  const [pendingOpenUpdateCenter, setPendingOpenUpdateCenter] = useState(false)
  const [updateCenterOpen, setUpdateCenterOpen] = useState(false)
  const [dashboardEntrySnapshot, setDashboardEntrySnapshot] = useState<DashboardEntrySnapshot | null>(null)
  const [showContactModal, setShowContactModal] = useState(false)
  const [pluginRepairRunning, setPluginRepairRunning] = useState(false)
  const [pluginRepairResult, setPluginRepairResult] = useState<PluginRepairResult | null>(null)
  const [tooltipEnabled, setTooltipEnabled] = useState(() => readTooltipEnabled())
  const [chatComposerEnterSendMode, setChatComposerEnterSendMode] = useState(
    () => readChatComposerEnterSendMode()
  )
  const [entryCompatibilitySnapshot, setEntryCompatibilitySnapshot] = useState<OpenClawEntryCompatibilitySnapshot>({
    runtimeStore: null,
    capabilities: null,
    gatewayRunning: null,
  })
  const pluginRepairPromiseRef = useRef<ActivePluginRepairTask | null>(null)
  const startupRepairAttemptedRef = useRef(false)

  const applyEnvSummaryToDiscovery = (
    nextDiscoveryResult: OpenClawDiscoveryResult | null,
    nextEnvSummary: EnvCheckReadyPayload | null
  ): OpenClawDiscoveryResult | null => {
    if (!nextDiscoveryResult) return null
    if (!nextEnvSummary) return nextDiscoveryResult
    if (nextEnvSummary.hadOpenClawInstalled || !nextEnvSummary.installedOpenClawDuringCheck) {
      return nextDiscoveryResult
    }

    return {
      ...nextDiscoveryResult,
      candidates: nextDiscoveryResult.candidates.map((candidate) =>
        candidate.candidateId === nextDiscoveryResult.activeCandidateId
          ? { ...candidate, ownershipState: 'qclaw-installed' }
          : candidate
      ),
      warnings: nextDiscoveryResult.warnings.includes('本次启动已由 Qclaw 安装 OpenClaw。')
        ? nextDiscoveryResult.warnings
        : [...nextDiscoveryResult.warnings, '本次启动已由 Qclaw 安装 OpenClaw。'],
    }
  }

  const handleEnvReady = (summary: EnvCheckReadyPayload) => {
    void window.api.appendEnvCheckDiagnostic('app-env-ready', {
      sharedConfigInitialized: summary.sharedConfigInitialized,
      hadOpenClawInstalled: summary.hadOpenClawInstalled,
      installedOpenClawDuringCheck: summary.installedOpenClawDuringCheck,
      discoveryStatus: summary.discoveryResult?.status || null,
      activeCandidateId: summary.discoveryResult?.activeCandidateId || null,
    }).catch(() => undefined)
    setDashboardEntrySnapshot(null)
    setEnvSummary(summary)
    setUpdateCenterOpen(false)
    const normalizedResult = applyEnvSummaryToDiscovery(summary.discoveryResult || null, summary)
    setDiscoveryResult(normalizedResult)

    if (!summary.hadOpenClawInstalled && summary.installedOpenClawDuringCheck && normalizedResult) {
      const activeCandidate =
        normalizedResult.candidates.find((candidate) => candidate.candidateId === normalizedResult.activeCandidateId) ||
        null
      if (activeCandidate?.installFingerprint) {
        void window.api.markManagedOpenClawInstall(activeCandidate.installFingerprint)
      }
    }

    const activeCandidate =
      normalizedResult?.candidates.find((candidate) => candidate.candidateId === normalizedResult.activeCandidateId) ||
      null

    const nextTarget: 'setup' | 'dashboard' = summary.sharedConfigInitialized ? 'dashboard' : 'setup'
    setPendingPhase1Target(nextTarget)
    setPendingOpenUpdateCenter(false)

    if (activeCandidate) {
      const nextState = resolveAppStateForPhase1Target(nextTarget)
      if (nextState === 'setup') {
        void window.api.appendEnvCheckDiagnostic('app-state-transition', {
          from: 'env-check',
          to: 'setup',
          target: nextTarget,
          reason: 'handleEnvReady',
          hasActiveCandidate: true,
        }).catch(() => undefined)
        setSetupStep('api-keys')
        setSelectedPairingAccountId(undefined)
        setSelectedPairingAccountName(undefined)
        setSetupModelContext(null)
        setAppState('setup')
        return
      }

      void window.api.appendEnvCheckDiagnostic('app-state-transition', {
        from: 'env-check',
        to: nextState,
        target: nextTarget,
        reason: 'handleEnvReady',
        hasActiveCandidate: true,
      }).catch(() => undefined)
      setAppState(nextState)
      return
    }

    const nextState = resolveAppStateForPhase1Target(nextTarget)
    if (nextState === 'setup') {
      void window.api.appendEnvCheckDiagnostic('app-state-transition', {
        from: 'env-check',
        to: 'setup',
        target: nextTarget,
        reason: 'handleEnvReady',
        hasActiveCandidate: false,
      }).catch(() => undefined)
      setSetupStep('api-keys')
      setSelectedPairingAccountId(undefined)
      setSelectedPairingAccountName(undefined)
      setSetupModelContext(null)
      setAppState('setup')
      return
    }

    void window.api.appendEnvCheckDiagnostic('app-state-transition', {
      from: 'env-check',
      to: nextState,
      target: nextTarget,
      reason: 'handleEnvReady',
      hasActiveCandidate: false,
    }).catch(() => undefined)
    setAppState(nextState)
  }

  const handleSetupComplete = () => {
    setSelectedPairingAccountId(undefined)
    setSelectedPairingAccountName(undefined)
    setPendingOpenUpdateCenter(false)
    setUpdateCenterOpen(false)
    setDashboardEntrySnapshot(null)
    setAppState(resolveAppStateAfterSetupCompletion())
  }

  const handleReconfigure = () => {
    if (window.location.hash !== '#/' && window.location.hash !== '') {
      window.location.hash = '#/'
    }
    setPendingPhase1Target(null)
    setPendingOpenUpdateCenter(false)
    setSetupStep('api-keys')
    setSelectedPairingAccountId(undefined)
    setSelectedPairingAccountName(undefined)
    setSetupModelContext(null)
    setUpdateCenterOpen(false)
    setDashboardEntrySnapshot(null)
    setAppState('setup')
  }

  const handleGatewayBootstrapReady = (snapshot: DashboardEntrySnapshot) => {
    setDashboardEntrySnapshot(snapshot)
    setUpdateCenterOpen(pendingOpenUpdateCenter)
    setPendingOpenUpdateCenter(false)
    setAppState('dashboard')
  }

  const runPluginRepair = useCallback(async (
    trigger: 'startup' | 'manual' = 'manual',
    options?: PluginRepairOptions
  ): Promise<PluginRepairResult | null> => {
    if (!window.api?.repairIncompatiblePlugins) return null
    const normalizedOptions =
      options?.scopePluginIds && options.scopePluginIds.length > 0
        ? options
        : {
            ...GLOBAL_PLUGIN_REPAIR_OPTIONS,
            ...options,
          }
    const requestKey = buildPluginRepairRequestKey(normalizedOptions)

    if (trigger === 'startup' && requestKey === GLOBAL_PLUGIN_REPAIR_REQUEST_KEY && pluginRepairResult?.ok) {
      return pluginRepairResult
    }

    const activeTask = pluginRepairPromiseRef.current
    if (activeTask) {
      if (activeTask.requestKey === requestKey) {
        return activeTask.promise
      }
      await activeTask.promise.catch(() => null)
    }

    const loadingNotificationId = trigger === 'manual'
      ? notifications.show({
          loading: true,
          autoClose: false,
          withCloseButton: false,
          title: '插件修复说明',
          message: PLUGIN_REPAIR_NOTICE_MESSAGE,
        })
      : null

    if (trigger === 'startup') {
      notifications.show({
        color: 'blue',
        title: '插件修复说明',
        message: PLUGIN_REPAIR_NOTICE_MESSAGE,
        autoClose: 4000,
      })
    }

    void window.api.appendEnvCheckDiagnostic('renderer-plugin-repair-requested', {
      trigger,
      requestKey,
      restoreConfiguredManagedChannels: normalizedOptions.restoreConfiguredManagedChannels === true,
      scopePluginIds: normalizedOptions.scopePluginIds || [],
    }).catch(() => undefined)
    setPluginRepairRunning(true)
    const task = window.api.repairIncompatiblePlugins(normalizedOptions)
      .then((result) => {
        void window.api.appendEnvCheckDiagnostic('renderer-plugin-repair-result', {
          trigger,
          requestKey,
          ok: result.ok,
          repaired: result.repaired,
          summary: String(result.summary || '').trim() || null,
        }).catch(() => undefined)
        setPluginRepairResult(result)
        if (loadingNotificationId) {
          notifications.hide(loadingNotificationId)
        }

        if (result.ok && result.repaired) {
          notifications.show({
            color: 'yellow',
            title: trigger === 'startup' ? '已自动修复损坏插件环境' : '损坏插件环境已修复',
            message: result.summary,
            autoClose: 6000,
          })
        } else if (!result.ok) {
          notifications.show({
            color: 'red',
            title: trigger === 'startup' ? '启动时插件环境修复失败' : '插件环境修复失败',
            message: result.summary || result.stderr || '损坏插件环境修复失败，请稍后重试。',
            autoClose: 6000,
          })
        }

        return result
      })
      .catch((error) => {
        if (loadingNotificationId) {
          notifications.hide(loadingNotificationId)
        }
        throw error
      })
      .finally(() => {
        if (pluginRepairPromiseRef.current?.promise === task) {
          pluginRepairPromiseRef.current = null
          setPluginRepairRunning(false)
        }
      })

    pluginRepairPromiseRef.current = {
      requestKey,
      promise: task,
    }
    return task
  }, [pluginRepairResult])

  const runPluginQuarantine = useCallback(async (
    trigger: 'startup' | 'manual' = 'manual',
    options?: PluginQuarantineOptions
  ): Promise<PluginRepairResult | null> => {
    if (!window.api?.scanIncompatiblePlugins) return null
    const normalizedOptions =
      options?.scopePluginIds && options.scopePluginIds.length > 0
        ? options
        : {
            ...GLOBAL_PLUGIN_QUARANTINE_OPTIONS,
            ...options,
          }
    const requestKey = `scan:${buildPluginRepairRequestKey(normalizedOptions)}`

    if (trigger === 'startup' && requestKey === GLOBAL_PLUGIN_QUARANTINE_REQUEST_KEY && pluginRepairResult?.ok) {
      return pluginRepairResult
    }

    const activeTask = pluginRepairPromiseRef.current
    if (activeTask) {
      if (activeTask.requestKey === requestKey) {
        return activeTask.promise
      }
      await activeTask.promise.catch(() => null)
    }

    const loadingNotificationId = trigger === 'manual'
      ? notifications.show({
          loading: true,
          autoClose: false,
          withCloseButton: false,
          title: '插件修复说明',
          message: PLUGIN_REPAIR_NOTICE_MESSAGE,
        })
      : null

    if (trigger === 'startup') {
      notifications.show({
        color: 'blue',
        title: '插件修复说明',
        message: PLUGIN_REPAIR_NOTICE_MESSAGE,
        autoClose: 4000,
      })
    }

    setPluginRepairRunning(true)
    const task = window.api.scanIncompatiblePlugins(normalizedOptions)
      .then((result) => {
        setPluginRepairResult(result)
        if (loadingNotificationId) {
          notifications.hide(loadingNotificationId)
        }

        if (result.ok && result.repaired) {
          notifications.show({
            color: 'yellow',
            title: trigger === 'startup' ? '已自动修复损坏插件环境' : '损坏插件环境已修复',
            message: result.summary,
            autoClose: 6000,
          })
        } else if (!result.ok) {
          notifications.show({
            color: 'red',
            title: trigger === 'startup' ? '启动时插件环境修复失败' : '插件环境修复失败',
            message: result.summary || result.stderr || '损坏插件环境修复失败，请稍后重试。',
            autoClose: 6000,
          })
        }

        return result
      })
      .catch((error) => {
        void window.api.appendEnvCheckDiagnostic('renderer-plugin-repair-failed', {
          trigger,
          requestKey,
          message: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined)
        if (loadingNotificationId) {
          notifications.hide(loadingNotificationId)
        }
        throw error
      })
      .finally(() => {
        if (pluginRepairPromiseRef.current?.promise === task) {
          pluginRepairPromiseRef.current = null
          setPluginRepairRunning(false)
        }
      })

    pluginRepairPromiseRef.current = {
      requestKey,
      promise: task,
    }
    return task
  }, [pluginRepairResult])

  const handleToggleTooltip = useCallback(() => {
    setTooltipEnabled((current) => {
      const next = !current
      writeTooltipEnabled(next)
      return next
    })
  }, [])

  const handleChangeChatComposerEnterSendMode = useCallback((nextMode: ChatComposerEnterSendMode) => {
    setChatComposerEnterSendMode(nextMode)
    writeChatComposerEnterSendMode(nextMode)
  }, [])

  const tooltipThemeOverride = useMemo(() => ({
    components: {
      Tooltip: {
        defaultProps: {
          disabled: !tooltipEnabled,
        },
      },
    },
  }), [tooltipEnabled])

  const handlePhase1Proceed = (
    target: 'setup' | 'dashboard',
    options?: { openUpdateCenter?: boolean }
  ) => {
    const activeCandidate =
      discoveryResult?.candidates.find((candidate) => candidate.candidateId === discoveryResult.activeCandidateId) ||
      null

    if (activeCandidate) {
      setPendingPhase1Target(target)
      setPendingOpenUpdateCenter(Boolean(options?.openUpdateCenter))
      const nextState = resolveAppStateForPhase1Target(target)
      if (nextState === 'setup') {
        setPendingOpenUpdateCenter(false)
        setSetupStep('api-keys')
        setSelectedPairingAccountId(undefined)
        setSelectedPairingAccountName(undefined)
        setSetupModelContext(null)
        setUpdateCenterOpen(false)
        setAppState('setup')
        return
      }

      setUpdateCenterOpen(false)
      setAppState(nextState)
      return
    }

    const nextState = resolveAppStateForPhase1Target(target)
    if (nextState === 'setup') {
      setPendingOpenUpdateCenter(false)
      setSetupStep('api-keys')
      setSelectedPairingAccountId(undefined)
      setSelectedPairingAccountName(undefined)
      setSetupModelContext(null)
      setUpdateCenterOpen(false)
      setAppState('setup')
      return
    }

    setPendingOpenUpdateCenter(Boolean(options?.openUpdateCenter))
    setUpdateCenterOpen(false)
    setAppState(nextState)
  }

  const currentStepIndex = SETUP_STEPS.findIndex((s) => s.key === setupStep)

  useEffect(() => {
    return window.api.onOpenContactModal(() => {
      setShowContactModal(true)
    })
  }, [])

  useEffect(() => {
    if (appState !== 'startup-update' || startupUpdateStatus) return

    let cancelled = false

    void window.api.checkQClawUpdate()
      .then((status) => {
        if (cancelled) return

        const nextStatus = {
          status: status.status,
          availableVersion: status.availableVersion,
        }

        if (shouldShowQClawNewVersionButton(nextStatus)) {
          setStartupUpdateStatus(nextStatus)
          return
        }

        setAppState('welcome')
      })
      .catch(() => {
        if (!cancelled) {
          setAppState('welcome')
        }
      })

    return () => {
      cancelled = true
    }
  }, [appState, startupUpdateStatus])

  useEffect(() => {
    if (startupRepairAttemptedRef.current) return
    if (appState === 'startup-update' || appState === 'welcome' || appState === 'env-check') return
    startupRepairAttemptedRef.current = true
    void runPluginRepair('startup')
  }, [appState, runPluginRepair])

  useEffect(() => {
    return window.api.onOpenModelsPage(() => {
      setPendingOpenUpdateCenter(false)
      setUpdateCenterOpen(false)
      setAppState((current) => {
        if (!canOpenExternalModelsPage(current)) {
          return current
        }

        if (window.location.hash !== MODELS_ROUTE_HASH) {
          window.location.hash = MODELS_ROUTE_HASH
        }

        return current
      })
    })
  }, [])

  useEffect(() => {
    const shouldLoadCompatibilityEntryState =
      appState === 'setup' || appState === 'gateway-bootstrap' || appState === 'dashboard'

    if (!shouldLoadCompatibilityEntryState) {
      setEntryCompatibilitySnapshot({
        runtimeStore: null,
        capabilities: null,
        gatewayRunning: null,
      })
      return
    }

    let cancelled = false
    ;(async () => {
      const [runtimeResult, capabilitiesResult, openClawResult, gatewayHealthResult] = await Promise.allSettled([
        window.api.getOpenClawRuntimeReconcileState(),
        window.api.getModelCapabilities(),
        window.api.checkOpenClaw(),
        window.api.gatewayHealth(),
      ])
      if (cancelled) return

      const liveOpenClawVersion =
        openClawResult.status === 'fulfilled' && openClawResult.value.installed
          ? String(openClawResult.value.version || '').trim() || null
          : null
      const gatewayRunning =
        gatewayHealthResult.status === 'fulfilled' && gatewayHealthResult.value.running === true

      setEntryCompatibilitySnapshot({
        runtimeStore:
          runtimeResult.status === 'fulfilled'
            ? applyLiveOpenClawVersionToRuntimeStore(runtimeResult.value, liveOpenClawVersion)
            : null,
        capabilities: capabilitiesResult.status === 'fulfilled' ? capabilitiesResult.value : null,
        gatewayRunning,
      })
    })()

    return () => {
      cancelled = true
    }
  }, [appState])

  useEffect(() => {
    const shouldShowCompatibilityNotice =
      appState === 'setup' || appState === 'gateway-bootstrap' || appState === 'dashboard'

    if (!shouldShowCompatibilityNotice) {
      notifications.hide(OPENCLAW_322_NOTICE_ID)
      return
    }

    const notice = buildOpenClaw322Notice(entryCompatibilitySnapshot)
    if (!notice) {
      notifications.hide(OPENCLAW_322_NOTICE_ID)
      return
    }

    const noticeMessage = notice.showElevationAction
      ? (
        <>
          {notice.message}
          {' '}
          <button
            type="button"
            onClick={() => {
              void window.api.requestGatewayServiceElevation().catch(() => undefined)
            }}
            style={{
              background: 'none',
              border: 'none',
              color: 'inherit',
              textDecoration: 'underline',
              cursor: 'pointer',
              padding: 0,
              font: 'inherit',
            }}
          >
            升级为计划任务（需要管理员权限）
          </button>
        </>
      )
      : notice.message

    notifications.show({
      id: OPENCLAW_322_NOTICE_ID,
      title: notice.title,
      message: noticeMessage,
      color: notice.color,
      autoClose: false,
      withCloseButton: true,
    })
  }, [appState, entryCompatibilitySnapshot])

  const renderFrame = (content: ReactNode, scrollable = true) => (
    <div className="h-screen flex flex-col app-bg-primary app-text-primary">
      <div className="h-10 flex-shrink-0 flex items-center justify-center gap-1.5" style={{ WebkitAppRegion: 'drag' } as any}>
        <img src={logoSrc} alt="" className="w-6 h-6 select-none pointer-events-none" />
        <span className="text-xs app-text-faint select-none">Qclaw</span>
      </div>
      <div className={`flex-1 flex items-center justify-center px-6 pb-6 ${scrollable ? 'overflow-y-auto' : 'overflow-hidden'}`}>{content}</div>
    </div>
  )

  const renderWithContactModal = (content: ReactNode) => (
    <MantineThemeProvider theme={tooltipThemeOverride}>
      <>
        {content}
        <AboutModal opened={showContactModal} onClose={() => setShowContactModal(false)} />
      </>
    </MantineThemeProvider>
  )

  if (appState === 'startup-update') {
    return renderWithContactModal(renderFrame(
      <StartupUpdatePrompt
        checking={!startupUpdateStatus}
        availableVersion={startupUpdateStatus?.availableVersion}
        onLater={() => setAppState('welcome')}
        onUpdateNow={() => undefined}
      />
    , false))
  }

  if (appState === 'welcome') {
    return renderWithContactModal(renderFrame(
      <div className="w-full max-w-xl px-2 pb-6">
        <Welcome onAccept={() => setAppState('env-check')} />
      </div>
    , false))
  }

  if (appState === 'env-check') {
    return renderWithContactModal(renderFrame(
      <div className="w-full max-w-md px-2">
        <EnvCheck
          onReady={handleEnvReady}
          pluginRepairRunning={pluginRepairRunning}
          pluginRepairResult={pluginRepairResult}
          onRepairPlugins={() => (
            window.api.platform === 'win32'
              ? runPluginQuarantine('manual')
              : runPluginRepair('manual')
          )}
        />
      </div>
    ))
  }

  if (appState === 'gateway-bootstrap') {
    return renderWithContactModal(renderFrame(
      <GatewayBootstrapGate
        onReady={handleGatewayBootstrapReady}
        onReconfigure={handleReconfigure}
      />
    ))
  }

  // Dashboard — now with sidebar layout
  if (appState === 'dashboard') {
    return renderWithContactModal(
      <HashRouter>
        <Routes>
          <Route element={<MainLayout />}>
            <Route index element={
              <Dashboard
                entrySnapshot={dashboardEntrySnapshot}
                onReconfigure={handleReconfigure}
                onOpenUpdateCenter={() => setUpdateCenterOpen(true)}
                pluginRepairRunning={pluginRepairRunning}
                pluginRepairResult={pluginRepairResult}
              />
            } />
            <Route
              path="/chat"
              element={<ChatPage enterSendMode={chatComposerEnterSendMode} />}
            />
            <Route path="/channels" element={<ChannelsPage />} />
            <Route path="/models" element={<ModelsPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route
              path="/settings"
              element={
                <SettingsPage
                  onReconfigure={handleReconfigure}
                  onToggleTooltip={handleToggleTooltip}
                  tooltipEnabled={tooltipEnabled}
                  enterSendMode={chatComposerEnterSendMode}
                  onChangeEnterSendMode={handleChangeChatComposerEnterSendMode}
                />
              }
            />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    )
  }

  // Setup wizard
  const setupView = (
    <div className="h-screen app-bg-primary app-text-primary flex flex-col">
      <div className="h-8 flex-shrink-0 flex items-center justify-center gap-1.5" style={{ WebkitAppRegion: 'drag' } as any}>
        <img src={logoSrc} alt="" className="w-4 h-4 select-none pointer-events-none" />
        <span className="text-[10px] app-text-faint select-none">Qclaw</span>
      </div>

      {/* Step labels */}
      <div className="flex justify-center gap-6 pt-2 pb-4">
        {SETUP_STEPS.map((s, i) => (
          <div key={s.key} className="flex items-center gap-2">
            <div
              className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                i < currentStepIndex
                  ? 'bg-emerald-500 text-black'
                  : i === currentStepIndex
                  ? 'bg-emerald-500/20 text-emerald-400 ring-2 ring-emerald-500'
                  : 'app-bg-tertiary app-text-muted'
              }`}
            >
              {i < currentStepIndex ? '✓' : i + 1}
            </div>
            <span
              className={`text-xs transition-colors ${
                i === currentStepIndex ? 'app-text-secondary' : 'app-text-muted'
              }`}
            >
              {s.label}
            </span>
            {i < SETUP_STEPS.length - 1 && <div className="w-8 h-px app-bg-tertiary ml-2" />}
          </div>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 flex justify-center px-6 pb-6 overflow-y-auto">
        <div className="w-full max-w-lg pt-2">
          {setupStep === 'api-keys' && (
            <ApiKeys
              onNext={(context) => {
                setSetupModelContext(context)
                setSetupStep('channel-connect')
              }}
            />
          )}
          {setupStep === 'channel-connect' && (
            <ChannelConnect
              setupModelContext={setupModelContext}
              forceShowSkip
              onNext={(payload: ChannelConnectNextPayload) => {
                if (shouldCompleteChannelConnect(payload)) {
                  handleSetupComplete()
                } else {
                  setSelectedChannel(payload.channelId || 'feishu')
                  setSelectedPairingAccountId(payload.accountId)
                  setSelectedPairingAccountName(payload.accountName)
                  setSetupStep('pairing-code')
                }
              }}
              onSkip={handleSetupComplete}
              onBack={() => setSetupStep('api-keys')}
            />
          )}
          {setupStep === 'pairing-code' && (
            <PairingCode
              channel={selectedChannel}
              accountId={selectedPairingAccountId}
              accountName={selectedPairingAccountName}
              onBack={() => setSetupStep('channel-connect')}
              onComplete={handleSetupComplete}
              onSkip={handleSetupComplete}
            />
          )}
        </div>
      </div>
    </div>
  )

  return renderWithContactModal(setupView)
}

export default App
