import { useEffect, useState, useRef, useCallback } from 'react'
import { Alert, ActionIcon, Button, Badge, Text, Group, Loader, Collapse, Modal, Progress, SegmentedControl, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconChevronRight, IconRefresh } from '@tabler/icons-react'
import { getChannelDefinition } from '../lib/openclaw-channel-registry'
import { getManagedChannelPluginByChannelId } from '../shared/managed-channel-plugin-registry'
import { pollWithBackoff } from '../shared/polling'
import { UI_RUNTIME_DEFAULTS, type BackoffPollingPolicy } from '../shared/runtime-policies'
import { runManagedChannelRepairFlow } from '../shared/managed-channel-repair'
import { useRepairProgress } from '../hooks/useRepairProgress'
import { runDashboardInitialLoad } from './dashboard-initial-load'
import {
  buildModelCatalogDisplaySummary,
  filterCatalogForDisplay,
  isCatalogModelAvailable,
  type ModelCatalogDisplayMode,
} from '../lib/model-catalog-display'
import { listAllModelCatalogItems } from '../lib/model-catalog-pagination'
import {
  buildEffectiveModelCatalog,
  buildModelsPageConfiguredProviders,
  filterModelsPageCatalogByConfiguredProviders,
  filterConfiguredProvidersWithVisibleModels,
  getModelsPageProviderModels,
  resolveConfiguredProviderRuntimeState,
  resolveModelsPageActiveModel,
  resolveVisibleConfiguredActiveModel,
} from './models-page-state'
import { applyDefaultModelWithGatewayReload } from '../shared/model-config-gateway'
import {
  resolveRecordedModelVerificationStateFromSwitchResult,
  type ModelVerificationRecord,
} from '../shared/model-verification-state'
import {
  getUpstreamCatalogItemsLike,
  getUpstreamModelStatusLike,
  logUpstreamModelStateFallback,
  readOpenClawUpstreamModelState,
  selectPreferredRendererCatalogItems,
} from '../shared/upstream-model-state'
import type {
  DashboardEntrySnapshot,
} from '../shared/dashboard-entry-bootstrap'
import tooltips from '@/constants/tooltips.json'

interface GatewayStatus {
  running: boolean
}

interface ChannelInfo {
  id: string
  name: string
  platform: string
}

interface ModelProvider {
  id: string
  name: string
  logo: string
}

interface CatalogModel {
  key: string
  name: string
  provider: string
  available: boolean
}

function toDashboardCatalogModel(item: {
  key: string
  provider: string
  name?: string
  available?: boolean
}): CatalogModel {
  const fallbackName = String(item.key.split('/').pop() || item.key).trim()
  return {
    key: item.key,
    name: String(item.name || '').trim() || fallbackName,
    provider: item.provider,
    available: item.available !== false,
  }
}

interface DashboardGatewayHealthLike {
  running?: boolean
  summary?: string
  stderr?: string
  raw?: string
}

type PluginRepairResult = Awaited<ReturnType<typeof window.api.repairIncompatiblePlugins>>
type PluginRepairOptions = Parameters<typeof window.api.repairIncompatiblePlugins>[0]
type WeixinInstallerSnapshot = Awaited<ReturnType<typeof window.api.getWeixinInstallerState>>
type DashboardWeixinInstallerEvent = {
  sessionId: string
  type: 'started' | 'output' | 'exit' | 'force-retry-started'
  ok?: boolean
  canceled?: boolean
  forceMode?: boolean
  newAccountIds?: string[]
}

type DashboardPluginActionId = 'feishu' | 'wecom' | 'qqbot' | 'dingtalk' | 'openclaw-weixin'
type DashboardPluginInstallKind = 'official-adapter' | 'npx' | 'package' | 'weixin-installer'

interface DashboardPluginActionDefinition {
  id: DashboardPluginActionId
  channelName: string
  buttonLabel: string
  installKind: DashboardPluginInstallKind
  installTarget: string
  expectedPluginIds?: string[]
  repairMatchPluginIds: string[]
}

export interface DashboardPluginInstallOutcome {
  ok?: boolean
  summary: string
  log: string
}

interface DashboardFeishuPluginStateLike {
  installedOnDisk: boolean
  officialPluginConfigured: boolean
  configChanged: boolean
}

export type DashboardFeishuPluginActionPlan = 'ready' | 'repair' | 'install'

export function resolveDashboardFeishuPluginActionPlan(
  state: DashboardFeishuPluginStateLike
): DashboardFeishuPluginActionPlan {
  if (state.installedOnDisk && state.officialPluginConfigured && !state.configChanged) {
    return 'ready'
  }

  if (!state.installedOnDisk) {
    return 'install'
  }

  return 'repair'
}

export function shouldReloadGatewayAfterDashboardPluginInstall(
  action: Pick<DashboardPluginActionDefinition, 'installKind'>
): boolean {
  return action.installKind === 'weixin-installer'
}

export function shouldResetDashboardPluginCenterStateOnClose(running: boolean): boolean {
  return !running
}

export function getDashboardPluginCenterTriggerLabel(running: boolean): string {
  return running ? '查看插件修复进度' : '修复插件环境'
}

export function shouldResetDashboardPluginCenterStateOnOpen(
  running: boolean,
  preserveStateOnNextOpen: boolean
): boolean {
  return !running && !preserveStateOnNextOpen
}

export const DASHBOARD_PLUGIN_ACTIONS: DashboardPluginActionDefinition[] = [
  {
    id: 'feishu',
    channelName: '飞书',
    buttonLabel: '修复飞书插件',
    installKind: 'official-adapter',
    installTarget: '@larksuite/openclaw-lark',
    expectedPluginIds: ['openclaw-lark'],
    repairMatchPluginIds: ['openclaw-lark', 'feishu', 'feishu-openclaw-plugin'],
  },
  {
    id: 'wecom',
    channelName: '企微',
    buttonLabel: '修复企微插件',
    installKind: 'npx',
    installTarget: getManagedChannelPluginByChannelId('wecom')?.npxSpecifier || '@wecom/wecom-openclaw-cli',
    expectedPluginIds: [getManagedChannelPluginByChannelId('wecom')?.pluginId || 'wecom-openclaw-plugin'],
    repairMatchPluginIds: getManagedChannelPluginByChannelId('wecom')?.cleanupPluginIds || ['wecom-openclaw-plugin', 'wecom'],
  },
  {
    id: 'qqbot',
    channelName: 'QQ',
    buttonLabel: '修复QQ插件',
    installKind: 'package',
    installTarget: getManagedChannelPluginByChannelId('qqbot')?.packageName || '@tencent-connect/openclaw-qqbot@latest',
    expectedPluginIds: ['openclaw-qqbot', 'qqbot'],
    repairMatchPluginIds: getManagedChannelPluginByChannelId('qqbot')?.cleanupPluginIds || ['qqbot', 'openclaw-qqbot'],
  },
  {
    id: 'dingtalk',
    channelName: '钉钉',
    buttonLabel: '修复钉钉插件',
    installKind: 'official-adapter',
    installTarget: getManagedChannelPluginByChannelId('dingtalk')?.packageName || '@dingtalk-real-ai/dingtalk-connector',
    expectedPluginIds: [getManagedChannelPluginByChannelId('dingtalk')?.pluginId || 'dingtalk-connector'],
    repairMatchPluginIds: getManagedChannelPluginByChannelId('dingtalk')?.cleanupPluginIds || ['dingtalk-connector', 'dingtalk'],
  },
  {
    id: 'openclaw-weixin',
    channelName: '微信',
    buttonLabel: '修复微信插件',
    installKind: 'weixin-installer',
    installTarget: '@tencent-weixin/openclaw-weixin-cli@latest',
    repairMatchPluginIds: ['openclaw-weixin'],
  },
]

function appendDashboardLog(current: string, nextLine: string): string {
  const prefix = current ? current.replace(/\s+$/, '') + '\n' : ''
  return `${prefix}${nextLine.trimEnd()}\n`
}

function isDashboardPluginCenterRepairableReloadState(stateCode: unknown): boolean {
  return stateCode === 'plugin_load_failure' || stateCode === 'config_invalid'
}

function hasVerifiedManagedChannelInstall(status: { stages: Array<{ id: string; state: string }> }): boolean {
  return status.stages.some((stage) => stage.id === 'installed' && stage.state === 'verified')
    && status.stages.some((stage) => stage.id === 'registered' && stage.state === 'verified')
}

function buildWeixinInstallerOutcome(accountCount: number): DashboardPluginInstallOutcome {
  return {
    summary: accountCount > 0
      ? `微信官方安装器已完成，并新增 ${accountCount} 个微信账号。`
      : '微信官方安装器已完成。',
    log: accountCount > 0
      ? `✅ 微信官方安装器已完成，新增 ${accountCount} 个微信账号`
      : '✅ 微信官方安装器已完成',
  }
}

export function selectDashboardPluginRepairResult(
  propResult: PluginRepairResult | null | undefined,
  localResult: PluginRepairResult | null
): PluginRepairResult | null {
  return localResult || propResult || null
}

export function buildDashboardPluginRepairOptions(
  action: Pick<DashboardPluginActionDefinition, 'repairMatchPluginIds'>
): { scopePluginIds: string[]; quarantineOfficialManagedPlugins: boolean } {
  return {
    scopePluginIds: Array.from(
      new Set(action.repairMatchPluginIds.map((value) => String(value || '').trim()).filter(Boolean))
    ),
    quarantineOfficialManagedPlugins: true,
  }
}

interface DashboardWeixinInstallerApi {
  getWeixinInstallerState: () => Promise<WeixinInstallerSnapshot>
  startWeixinInstaller: () => Promise<WeixinInstallerSnapshot>
  onWeixinInstallerEvent: (listener: (payload: DashboardWeixinInstallerEvent) => void) => () => void
}

export async function waitForDashboardWeixinInstallerCompletion(
  api: DashboardWeixinInstallerApi
): Promise<DashboardPluginInstallOutcome> {
  return await new Promise<DashboardPluginInstallOutcome>((resolve, reject) => {
    let settled = false
    let targetSessionId = ''
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let unsubscribe = () => {}

    const cleanup = () => {
      unsubscribe()
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    const finishResolve = (outcome: DashboardPluginInstallOutcome) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(outcome)
    }

    const finishReject = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    const resolveFromSnapshot = (snapshot: WeixinInstallerSnapshot): boolean => {
      if (!snapshot.sessionId) return false
      if (targetSessionId && snapshot.sessionId !== targetSessionId) return false
      targetSessionId = snapshot.sessionId
      if (snapshot.phase !== 'exited') return false

      if (snapshot.ok && !snapshot.canceled) {
        finishResolve(buildWeixinInstallerOutcome(snapshot.newAccountIds.length))
      } else {
        finishReject(new Error(snapshot.output || '个人微信安装器未完成，请重试。'))
      }
      return true
    }

    const pollInstallerState = async () => {
      if (!targetSessionId || settled) return
      const snapshot = await api.getWeixinInstallerState().catch(() => null)
      if (!snapshot) return
      resolveFromSnapshot(snapshot)
    }

    const ensurePolling = () => {
      if (pollTimer || !targetSessionId) return
      pollTimer = setInterval(() => {
        void pollInstallerState()
      }, 250)
    }

    unsubscribe = api.onWeixinInstallerEvent((payload) => {
      if (payload.type === 'started' && payload.sessionId && !targetSessionId) {
        targetSessionId = payload.sessionId
        ensurePolling()
        return
      }

      if (!targetSessionId || payload.sessionId !== targetSessionId) return
      if (payload.type !== 'exit') return

      if (payload.ok && !payload.canceled) {
        finishResolve(buildWeixinInstallerOutcome(payload.newAccountIds?.length || 0))
        return
      }

      void pollInstallerState().then(() => {
        if (!settled) {
          finishReject(new Error('个人微信安装器未完成，请重试。'))
        }
      })
    })

    void (async () => {
      try {
        const currentSnapshot = await api.getWeixinInstallerState()
        if (currentSnapshot.active && currentSnapshot.sessionId) {
          targetSessionId = currentSnapshot.sessionId
          ensurePolling()
          if (!resolveFromSnapshot(currentSnapshot)) {
            void pollInstallerState()
          }
          return
        }

        const startedSnapshot = await api.startWeixinInstaller()
        if (!startedSnapshot.sessionId) {
          finishReject(new Error(startedSnapshot.output || '个人微信安装器启动失败'))
          return
        }

        targetSessionId = startedSnapshot.sessionId
        ensurePolling()

        if (resolveFromSnapshot(startedSnapshot)) {
          return
        }

        if (!startedSnapshot.active && startedSnapshot.phase !== 'running') {
          finishReject(new Error(startedSnapshot.output || '个人微信安装器启动失败'))
          return
        }

        void pollInstallerState()
      } catch (error) {
        finishReject(error)
      }
    })()
  })
}

export async function waitForDashboardGatewayRunning(
  api: {
    gatewayHealth: () => Promise<DashboardGatewayHealthLike>
  },
  options: {
    policy?: BackoffPollingPolicy
  } = {}
): Promise<{ ok: true; health: DashboardGatewayHealthLike } | { ok: false; message: string }> {
  let lastHealth: DashboardGatewayHealthLike | null = null
  const readiness = await pollWithBackoff({
    policy: options.policy || UI_RUNTIME_DEFAULTS.gatewayReadiness.poll,
    execute: async () => {
      lastHealth = await api.gatewayHealth().catch(() => ({
        running: false,
        summary: '网关暂时不可用',
      }))
      return lastHealth
    },
    isSuccess: (value) => value?.running === true,
  })

  if (readiness.ok && readiness.value) {
    return {
      ok: true,
      health: readiness.value,
    }
  }

  const failedHealth = readiness.value || lastHealth
  return {
    ok: false,
    message:
      String(failedHealth?.summary || '').trim() ||
      String(failedHealth?.stderr || '').trim() ||
      String(failedHealth?.raw || '').trim() ||
      '网关暂时不可用',
  }
}

function resolveDashboardActionErrorMessage(
  error: unknown,
  fallbackMessage: string,
  safeUiMessages: string[] = []
): string {
  if (error instanceof Error && safeUiMessages.includes(error.message)) {
    return error.message
  }

  return fallbackMessage
}

const DEFAULT_MODEL_SWITCH_FAILURE_MESSAGE = '默认模型切换失败，请稍后重试。'
const DASHBOARD_PLUGIN_CENTER_FAILURE_MESSAGE = '插件处理失败，请稍后重试。'

function extractChannelsFromConfig(config: Record<string, any> | null): ChannelInfo[] {
  if (!config || typeof config !== 'object') return []
  return Object.entries(config.channels || {}).map(([id, cfg]: any) => ({
    id,
    name: cfg.name || id,
    platform: cfg.domain || 'unknown',
  }))
}

export default function Dashboard({
  entrySnapshot,
  onReconfigure,
  onOpenUpdateCenter,
  pluginRepairRunning = false,
  pluginRepairResult = null,
}: {
  entrySnapshot?: DashboardEntrySnapshot | null
  onReconfigure?: () => void
  onOpenUpdateCenter?: () => void
  pluginRepairRunning?: boolean
  pluginRepairResult?: PluginRepairResult | null
}) {
  const [gateway, setGateway] = useState<GatewayStatus>({ running: Boolean(entrySnapshot?.gatewayRunning) })
  const [envVars, setEnvVars] = useState<Record<string, string> | null>(null)
  const [config, setConfig] = useState<Record<string, any> | null>(entrySnapshot?.config || null)
  const [modelStatus, setModelStatus] = useState<Record<string, any> | null>(entrySnapshot?.modelStatus || null)
  const [verificationRecords, setVerificationRecords] = useState<ModelVerificationRecord[]>([])
  const [channels, setChannels] = useState<ChannelInfo[]>(() => extractChannelsFromConfig(entrySnapshot?.config || null))
  const [loading, setLoading] = useState(!entrySnapshot)
  const [restarting, setRestarting] = useState(false)
  const [forceRestarting, setForceRestarting] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [catalog, setCatalog] = useState<CatalogModel[]>([])
  const [catalogMode, setCatalogMode] = useState<ModelCatalogDisplayMode>('all')
  const [catalogRefreshing, setCatalogRefreshing] = useState(false)
  const [catalogRefreshError, setCatalogRefreshError] = useState('')
  const [catalogLastUpdatedAt, setCatalogLastUpdatedAt] = useState('')
  const [switching, setSwitching] = useState('')
  const [confirmModel, setConfirmModel] = useState('')
  const [modelError, setModelError] = useState('')
  const [pluginCenterOpened, setPluginCenterOpened] = useState(false)
  const [pluginCenterRunning, setPluginCenterRunning] = useState(false)
  const [pluginCenterPreserveStateOnNextOpen, setPluginCenterPreserveStateOnNextOpen] = useState(false)
  const [pluginCenterActionId, setPluginCenterActionId] = useState<DashboardPluginActionId | null>(null)
  const [pluginCenterPhaseTitle, setPluginCenterPhaseTitle] = useState('')
  const [pluginCenterPhaseDetail, setPluginCenterPhaseDetail] = useState('')
  const [pluginCenterProgress, setPluginCenterProgress] = useState(0)
  const [pluginCenterLog, setPluginCenterLog] = useState('')
  const [pluginCenterError, setPluginCenterError] = useState('')
  const [pluginCenterSummary, setPluginCenterSummary] = useState('')
  const [pluginCenterRepairResult, setPluginCenterRepairResult] = useState<PluginRepairResult | null>(null)

  const { activeRepairs, lastResult: repairLastResult } = useRepairProgress()

  // 用于数据变化检测
  const prevChannelsRef = useRef<string>('')
  const catalogRequestIdRef = useRef(0)
  const pluginCenterProgressRef = useRef(0)
  const pluginCenterProgressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeModelHint = resolveModelsPageActiveModel(modelStatus, config)
  const locallyConfiguredProviders = buildModelsPageConfiguredProviders({
    envVars,
    config,
    statusData: modelStatus,
  })
  const effectiveCatalog = buildEffectiveModelCatalog(catalog, {
    statusData: modelStatus,
    preferredModelKey: activeModelHint,
    configuredProviderIds: locallyConfiguredProviders.map((provider) => provider.id),
    verificationRecords,
  })
  const visibleCatalog = filterCatalogForDisplay(effectiveCatalog, catalogMode)
  const providers: ModelProvider[] = filterConfiguredProvidersWithVisibleModels(
    locallyConfiguredProviders,
    visibleCatalog,
    effectiveCatalog
  ).map((provider) => ({
    id: provider.id,
    name: provider.name,
    logo: provider.logo,
  }))
  const configuredCatalog = filterModelsPageCatalogByConfiguredProviders(effectiveCatalog, providers)
  const catalogSummary = buildModelCatalogDisplaySummary(configuredCatalog, catalogMode)
  const displayedPluginRepairResult = selectDashboardPluginRepairResult(pluginRepairResult, pluginCenterRepairResult)
  const pluginRepairErrorSummary =
    displayedPluginRepairResult && !displayedPluginRepairResult.ok
      ? String(displayedPluginRepairResult.summary || '').trim()
      : ''
  const [pluginRepairNoticeVisible, setPluginRepairNoticeVisible] =
    useState(Boolean(displayedPluginRepairResult?.repaired))
  const [pluginRepairErrorVisible, setPluginRepairErrorVisible] = useState(Boolean(pluginRepairErrorSummary))
  const pluginCenterTriggerLabel = getDashboardPluginCenterTriggerLabel(pluginCenterRunning)
  const activeModel = resolveVisibleConfiguredActiveModel({
    statusData: modelStatus,
    configData: config,
    configuredProviders: providers,
    visibleCatalog,
    fullCatalog: effectiveCatalog,
  })
  const activePluginAction = DASHBOARD_PLUGIN_ACTIONS.find((action) => action.id === pluginCenterActionId) || null

  useEffect(() => {
    setPluginRepairNoticeVisible(Boolean(displayedPluginRepairResult?.repaired))
    setPluginRepairErrorVisible(Boolean(pluginRepairErrorSummary))
  }, [displayedPluginRepairResult, pluginRepairErrorSummary])

  const fetchGatewayStatus = async () => {
    try {
      const health = await window.api.gatewayHealth()
      setGateway({ running: health.running || false })
    } catch (e) {
      console.error('获取网关状态失败:', e)
    }
  }

  const syncChannelList = (config: Record<string, any>) => {
    const channelList = extractChannelsFromConfig(config)
    const channelsJson = JSON.stringify(channelList)
    if (channelsJson !== prevChannelsRef.current) {
      setChannels(channelList)
      prevChannelsRef.current = channelsJson
    }
  }

  const fetchConfigSnapshot = async (): Promise<Record<string, any> | null> => {
    try {
      const [nextEnvVars, config] = await Promise.all([
        window.api.readEnvFile().catch(() => ({})),
        window.api.readConfig(),
      ])
      setEnvVars(nextEnvVars)
      if (config) {
        setConfig(config)
        syncChannelList(config)
        return config
      }
      setConfig(null)
      return null
    } catch (e) {
      console.error('获取配置失败:', e)
      return null
    }
  }

  const getUpstreamModelState = async () => {
    const upstreamState = await readOpenClawUpstreamModelState()
    logUpstreamModelStateFallback('Dashboard', upstreamState)
    return upstreamState
  }

  const refreshProvidersWithModelStatus = async (configSnapshot: Record<string, any> | null): Promise<void> => {
    try {
      const baseConfig = configSnapshot || (await window.api.readConfig())
      if (baseConfig) {
        setConfig(baseConfig)
      }
      const upstreamState = await getUpstreamModelState()
      const nextModelStatus = getUpstreamModelStatusLike(upstreamState)
      if (!nextModelStatus) {
        const modelStatusResult = await window.api.getModelStatus().catch(() => null)
        const resolvedModelStatus = modelStatusResult?.ok
          ? ((modelStatusResult.data as Record<string, any>) || null)
          : null
        setModelStatus(resolvedModelStatus)
        const verificationSnapshot = await window.api.syncModelVerificationState({
          statusData: resolvedModelStatus,
        }).catch(() => null)
        if (verificationSnapshot && Array.isArray(verificationSnapshot.records)) {
          setVerificationRecords(verificationSnapshot.records)
        }
        return
      }
      setModelStatus(nextModelStatus)
      const verificationSnapshot = await window.api.syncModelVerificationState({
        statusData: nextModelStatus,
      }).catch(() => null)
      if (verificationSnapshot && Array.isArray(verificationSnapshot.records)) {
        setVerificationRecords(verificationSnapshot.records)
      }
    } catch (e) {
      console.error('刷新模型状态失败:', e)
      const verificationSnapshot = await window.api.syncModelVerificationState({
        statusData: null,
      }).catch(() => null)
      if (verificationSnapshot && Array.isArray(verificationSnapshot.records)) {
        setVerificationRecords(verificationSnapshot.records)
      }
    }
  }

  const fetchConfig = async () => {
    const config = await fetchConfigSnapshot()
    await refreshProvidersWithModelStatus(config)
  }

  const updatePluginCenterProgress = useCallback((value: number | ((current: number) => number)) => {
    setPluginCenterProgress((current) => {
      const next = typeof value === 'function' ? value(current) : value
      pluginCenterProgressRef.current = next
      return next
    })
  }, [])

  const stopPluginCenterProgressTimer = useCallback((finalValue?: number) => {
    if (pluginCenterProgressTimerRef.current) {
      clearInterval(pluginCenterProgressTimerRef.current)
      pluginCenterProgressTimerRef.current = null
    }
    if (typeof finalValue === 'number') {
      updatePluginCenterProgress(finalValue)
    }
  }, [updatePluginCenterProgress])

  const startPluginCenterProgressTimer = useCallback((
    floor: number,
    ceiling: number,
    step = 2,
    intervalMs = 260
  ) => {
    stopPluginCenterProgressTimer()
    updatePluginCenterProgress((current) => Math.max(current, floor))
    pluginCenterProgressTimerRef.current = setInterval(() => {
      updatePluginCenterProgress((current) => (
        current >= ceiling
          ? current
          : Math.min(ceiling, current + step)
      ))
    }, intervalMs)
  }, [stopPluginCenterProgressTimer, updatePluginCenterProgress])

  const appendPluginCenterLog = useCallback((message: string) => {
    setPluginCenterLog((current) => appendDashboardLog(current, message))
  }, [])

  const resetPluginCenterState = useCallback(() => {
    stopPluginCenterProgressTimer(0)
    setPluginCenterRunning(false)
    setPluginCenterActionId(null)
    setPluginCenterPhaseTitle('')
    setPluginCenterPhaseDetail('')
    setPluginCenterLog('')
    setPluginCenterError('')
    setPluginCenterSummary('')
  }, [stopPluginCenterProgressTimer])

  const runDashboardPluginInstall = useCallback(async (
    action: DashboardPluginActionDefinition
  ): Promise<DashboardPluginInstallOutcome> => {
    const repairOutcome = await runManagedChannelRepairFlow({
      getManagedChannelPluginStatus: (channelId) => window.api.getManagedChannelPluginStatus(channelId),
      repairManagedChannelPlugin: (channelId) => window.api.repairManagedChannelPlugin(channelId),
    }, action.id)

    if (repairOutcome.nextAction !== 'launch-interactive-installer') {
      return repairOutcome
    }

    if (action.installKind !== 'weixin-installer') {
      throw new Error(repairOutcome.summary || `${action.channelName} 插件处理失败`)
    }

    const installOutcome = await waitForDashboardWeixinInstallerCompletion({
      getWeixinInstallerState: () => window.api.getWeixinInstallerState(),
      startWeixinInstaller: () => window.api.startWeixinInstaller(),
      onWeixinInstallerEvent: (listener) => window.api.onWeixinInstallerEvent(listener),
    })

    return {
      ok: true,
      summary: [repairOutcome.summary, installOutcome.summary].filter(Boolean).join(' '),
      log: [repairOutcome.log, installOutcome.log].filter(Boolean).join('\n'),
    }
  }, [])

  const refreshCatalog = useCallback(async (options?: { forceRefresh?: boolean }) => {
    const requestId = catalogRequestIdRef.current + 1
    catalogRequestIdRef.current = requestId
    setCatalogRefreshing(true)
    setCatalogRefreshError('')
    let upstreamItems: CatalogModel[] = []
    try {
      const upstreamState = await getUpstreamModelState()
      upstreamItems = getUpstreamCatalogItemsLike(upstreamState).map((item) => toDashboardCatalogModel(item))
      const cliItems = await listAllModelCatalogItems(window.api.listModelCatalog, {
        ...(options?.forceRefresh ? { bypassCache: true } : {}),
      })
      if (catalogRequestIdRef.current !== requestId) return
      setCatalog(selectPreferredRendererCatalogItems({
        cliLoaded: true,
        cliItems: cliItems.map((item) => toDashboardCatalogModel(item)),
        upstreamItems,
      }))
      setCatalogLastUpdatedAt(new Date().toISOString())
    } catch {
      if (catalogRequestIdRef.current !== requestId) return
      if (upstreamItems.length > 0) {
        setCatalog(selectPreferredRendererCatalogItems({
          cliLoaded: false,
          cliItems: [],
          upstreamItems,
        }))
        setCatalogLastUpdatedAt(new Date().toISOString())
        setCatalogRefreshError(options?.forceRefresh ? '模型目录强制刷新失败，已回退到上游目录快照' : '模型目录刷新失败，已回退到上游目录快照')
      } else {
        setCatalogRefreshError(options?.forceRefresh ? '模型目录强制刷新失败，已保留当前显示数据' : '模型目录刷新失败，已保留当前显示数据')
      }
    } finally {
      if (catalogRequestIdRef.current === requestId) {
        setCatalogRefreshing(false)
      }
    }
  }, [])

  const handleSwitchModel = async (modelKey: string) => {
    setConfirmModel('')
    setSwitching(modelKey)
    setModelError('')
    try {
      const result = await applyDefaultModelWithGatewayReload({
        model: modelKey,
        readConfig: () => window.api.readConfig(),
        readUpstreamState: () => window.api.getModelUpstreamState(),
        applyUpstreamModelWrite: (request) => window.api.applyModelConfigViaUpstream(request),
        applyConfigPatchGuarded: (request) => window.api.applyConfigPatchGuarded(request),
        getModelStatus: () => window.api.getModelStatus(),
        reloadGatewayAfterModelChange: () => window.api.reloadGatewayAfterModelChange(),
      })
      const verificationState = resolveRecordedModelVerificationStateFromSwitchResult(result)
      if (verificationState) {
        const snapshot = await window.api.recordModelVerification({
          modelKey,
          verificationState,
        }).catch(() => null)
        if (snapshot && Array.isArray(snapshot.records)) {
          setVerificationRecords(snapshot.records)
        }
      }
      if (!result.ok) {
        console.error('default model switch failed', result)
        setModelError(DEFAULT_MODEL_SWITCH_FAILURE_MESSAGE)
      }
      await fetchConfig()
      if (result.ok) {
        await refreshCatalog({ forceRefresh: true })
      }
    } catch (error) {
      console.error('default model switch failed', error)
      setModelError(DEFAULT_MODEL_SWITCH_FAILURE_MESSAGE)
    } finally {
      setSwitching('')
    }
  }

  const handleManualRefresh = async () => {
    await fetchConfig()
    await refreshCatalog({ forceRefresh: true })
  }

  useEffect(() => {
    if (entrySnapshot) {
      const channelList = extractChannelsFromConfig(entrySnapshot.config)
      setGateway({ running: Boolean(entrySnapshot.gatewayRunning) })
      setConfig(entrySnapshot.config)
      setModelStatus(entrySnapshot.modelStatus)
      setChannels(channelList)
      prevChannelsRef.current = JSON.stringify(channelList)
      setLoading(false)
    }
  }, [entrySnapshot])

  useEffect(() => {
    // 初始加载：首屏只等待网关 + 配置快照，模型状态改为首屏后后台刷新
    void runDashboardInitialLoad({
      fetchGatewayStatus,
      fetchConfigSnapshot,
      refreshProvidersWithModelStatus,
      setLoading,
    })

    // 模型目录非阻塞加载
    void refreshCatalog()

    // 网关状态每 10 秒轮询
    const gatewayInterval = setInterval(fetchGatewayStatus, 10000)

    // 配置每 30 秒轮询
    const configInterval = setInterval(fetchConfig, 30000)

    return () => {
      clearInterval(gatewayInterval)
      clearInterval(configInterval)
    }
  }, [refreshCatalog])

  useEffect(() => () => {
    stopPluginCenterProgressTimer()
  }, [stopPluginCenterProgressTimer])

  const catalogRefreshLabel = catalogRefreshing
    ? '正在刷新目录...'
    : catalogLastUpdatedAt
      ? `最近刷新 ${new Date(catalogLastUpdatedAt).toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}`
      : '尚未刷新目录'

  const handleRestartGateway = async () => {
    setRestarting(true)
    const notificationId = notifications.show({
      loading: true,
      autoClose: false,
      withCloseButton: false,
      title: '正在处理',
      message: '正在重新连接网关，请稍候...',
    })
    try {
      const result = await window.api.reloadGatewayManual()
      if (!result?.ok) {
        throw new Error(result?.stderr || result?.stdout || '网关重载失败')
      }
      const readyResult = await waitForDashboardGatewayRunning({
        gatewayHealth: () => window.api.gatewayHealth(),
      })
      if (!readyResult.ok) {
        throw new Error('已执行重新启动，但网关暂时不可用。')
      }
      await fetchGatewayStatus()
      notifications.hide(notificationId)
      notifications.show({
        color: 'teal',
        title: '处理完成',
        message: gateway.running ? '网关已重新启动完成' : '网关已启动完成',
        autoClose: 1800,
      })
    } catch (e) {
      console.error('重启失败:', e)
      notifications.hide(notificationId)
      notifications.show({
        color: 'red',
        title: '处理失败',
        message: resolveDashboardActionErrorMessage(e, '暂时无法重新连接网关，请稍后重试。', [
          '已执行重新启动，但网关暂时不可用。',
        ]),
        autoClose: 3500,
      })
    } finally {
      setRestarting(false)
    }
  }

  const handleOpenDashboard = async () => {
    try {
      await window.api.openDashboard()
    } catch (e) {
      console.error('打开开发者面板失败:', e)
    }
  }

  const handleOpenWorkspace = async () => {
    try {
      await window.api.openOpenClawWorkspace()
    } catch (e) {
      console.error('打开工作区失败:', e)
    }
  }

  const handleForceRestart = async () => {
    setForceRestarting(true)
    const notificationId = notifications.show({
      loading: true,
      autoClose: false,
      withCloseButton: false,
      title: '正在处理',
      message: '正在强制重启网关，请稍候...',
    })
    try {
      const result = await window.api.gatewayForceRestart()
      if (!result?.ok) {
        throw new Error(result?.stderr || result?.stdout || '强制重启失败')
      }
      const readyResult = await waitForDashboardGatewayRunning({
        gatewayHealth: () => window.api.gatewayHealth(),
      })
      if (!readyResult.ok) {
        throw new Error('已执行强制重启，但网关暂时不可用。')
      }
      await fetchGatewayStatus()
      notifications.hide(notificationId)
      notifications.show({
        color: 'teal',
        title: '处理完成',
        message: '网关已强制重启完成',
        autoClose: 1800,
      })
    } catch (e) {
      console.error('强制重启失败:', e)
      notifications.hide(notificationId)
      notifications.show({
        color: 'red',
        title: '处理失败',
        message: resolveDashboardActionErrorMessage(e, '强制重启失败，请稍后重试。', [
          '已执行强制重启，但网关暂时不可用。',
        ]),
        autoClose: 3500,
      })
    } finally {
      setForceRestarting(false)
    }
  }

  const handleSelfRepair = async () => {
    setRepairing(true)
    const notificationId = notifications.show({
      loading: true,
      autoClose: false,
      withCloseButton: false,
      title: '正在处理',
      message: '正在检查并修复网关，请稍候...',
    })
    try {
      const result = await window.api.ensureGatewayRunning()
      if (!result?.ok || !result?.running) {
        throw new Error(result?.summary || result?.stderr || result?.stdout || '自检修复未完成')
      }
      await fetchGatewayStatus()
      notifications.hide(notificationId)
      notifications.show({
        color: 'teal',
        title: '处理完成',
        message: '检查修复完成，网关已恢复可用。',
        autoClose: 1800,
      })
    } catch (e) {
      console.error('自检修复失败:', e)
      notifications.hide(notificationId)
      notifications.show({
        color: 'red',
        title: '处理失败',
        message: resolveDashboardActionErrorMessage(e, '检查修复失败，请稍后重试。'),
        autoClose: 3500,
      })
    } finally {
      setRepairing(false)
    }
  }

  const handleOpenPluginCenter = () => {
    if (shouldResetDashboardPluginCenterStateOnOpen(pluginCenterRunning, pluginCenterPreserveStateOnNextOpen)) {
      resetPluginCenterState()
    } else if (pluginCenterPreserveStateOnNextOpen && !pluginCenterRunning) {
      setPluginCenterPreserveStateOnNextOpen(false)
    }
    setPluginCenterOpened(true)
  }

  const handleClosePluginCenter = () => {
    setPluginCenterOpened(false)
    if (shouldResetDashboardPluginCenterStateOnClose(pluginCenterRunning)) {
      setPluginCenterPreserveStateOnNextOpen(false)
      resetPluginCenterState()
      return
    }
    setPluginCenterPreserveStateOnNextOpen(true)
  }

  const handleRunPluginCenterAction = async (action: DashboardPluginActionDefinition) => {
    if (pluginCenterRunning) return

    setPluginCenterOpened(true)
    setPluginCenterRunning(true)
    setPluginCenterPreserveStateOnNextOpen(false)
    setPluginCenterActionId(action.id)
    setPluginCenterPhaseTitle(`正在修复 ${action.channelName} 插件`)
    setPluginCenterPhaseDetail('先检查损坏插件环境，再安装对应官方插件。')
    setPluginCenterError('')
    setPluginCenterSummary('')
    setPluginCenterLog('')
    setPluginCenterRepairResult(null)
    updatePluginCenterProgress(6)
    appendPluginCenterLog(`开始处理 ${action.channelName} 插件`)

    try {
      setPluginCenterPhaseTitle(`正在检查 ${action.channelName} 插件状态`)
      setPluginCenterPhaseDetail(
        action.installKind === 'weixin-installer'
          ? '将优先执行托管插件修复；如遇交互式插件，会继续拉起官方安装器。'
          : '当前插件将通过统一托管生命周期执行修复与状态校验。'
      )
      startPluginCenterProgressTimer(8, 88, 2, 240)

      const installOutcome = await runDashboardPluginInstall(action)
      stopPluginCenterProgressTimer(94)
      appendPluginCenterLog(installOutcome.log)
      if (installOutcome.ok === false) {
        throw new Error(installOutcome.summary || `${action.channelName} 插件处理失败`)
      }

      setPluginCenterPhaseTitle(`正在刷新 ${action.channelName} 插件状态`)
      setPluginCenterPhaseDetail('同步控制面板中的网关和配置快照。')
      startPluginCenterProgressTimer(95, 98, 1, 220)
      if (shouldReloadGatewayAfterDashboardPluginInstall(action)) {
        const reloadResult = await window.api.reloadGatewayAfterChannelChange()
        const gatewayReady = reloadResult.ok && reloadResult.running === true
        if (!gatewayReady) {
          if (isDashboardPluginCenterRepairableReloadState(reloadResult.stateCode)) {
            appendPluginCenterLog(`⚠️ 网关重载命中可修复状态：${reloadResult.summary || reloadResult.stderr || '待继续复检'}`)
            const ensureResult = await window.api.ensureGatewayRunning({ skipRuntimePrecheck: true })
            if (!ensureResult.ok || ensureResult.running !== true) {
              throw new Error(
                ensureResult.summary
                  || ensureResult.stderr
                  || ensureResult.stdout
                  || '网关重载失败'
              )
            }
            const targetStatus = await window.api.getManagedChannelPluginStatus(action.id)
            if (!hasVerifiedManagedChannelInstall(targetStatus)) {
              throw new Error(targetStatus.summary || `${action.channelName} 插件仍未确认安装`)
            }
          } else {
            throw new Error(
              reloadResult.summary
                || reloadResult.stderr
                || reloadResult.stdout
                || '网关重载失败'
            )
          }
        }
      }
      await fetchGatewayStatus()
      await fetchConfig()
      stopPluginCenterProgressTimer(100)

      const finalSummary = installOutcome.summary || `${action.channelName} 插件处理完成。`
      setPluginCenterSummary(finalSummary)
      setPluginCenterPhaseTitle(`${action.channelName} 插件处理完成`)
      setPluginCenterPhaseDetail('你可以继续处理其他插件，或关闭当前弹窗。')
      notifications.show({
        color: 'teal',
        title: `${action.channelName} 插件已处理完成`,
        message: finalSummary,
        autoClose: 3500,
      })
    } catch (error) {
      stopPluginCenterProgressTimer()
      console.error(`${action.channelName} plugin repair failed`, error)
      setPluginCenterError(DASHBOARD_PLUGIN_CENTER_FAILURE_MESSAGE)
      setPluginCenterPhaseTitle(`${action.channelName} 插件处理失败`)
      setPluginCenterPhaseDetail('可以稍后重试；如果问题持续存在，请查看控制台日志继续排查。')
      appendPluginCenterLog(`❌ ${action.channelName} 插件处理失败，请稍后重试。`)
      notifications.show({
        color: 'red',
        title: `${action.channelName} 插件处理失败`,
        message: DASHBOARD_PLUGIN_CENTER_FAILURE_MESSAGE,
        autoClose: 4500,
      })
    } finally {
      setPluginCenterRunning(false)
    }
  }

  const [expanded, setExpanded] = useState<Record<string, boolean>>({ gateway: true, dev: true })
  const toggleSection = useCallback((key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader size="lg" />
      </div>
    )
  }

  return (
    <div className="p-4 space-y-2">
      {modelError && (
        <Alert color="red" variant="light">
          {modelError}
        </Alert>
      )}
      {catalogRefreshError && (
        <Alert color="yellow" variant="light">
          {catalogRefreshError}
        </Alert>
      )}
      {displayedPluginRepairResult?.repaired && pluginRepairNoticeVisible && (
        <Alert
          color="yellow"
          variant="light"
          title="已自动隔离损坏插件"
          withCloseButton
          onClose={() => setPluginRepairNoticeVisible(false)}
        >
          {displayedPluginRepairResult.summary}
        </Alert>
      )}
      {pluginRepairErrorSummary && pluginRepairErrorVisible && (
        <Alert
          color="red"
          variant="light"
          title="损坏插件环境修复失败"
          withCloseButton
          onClose={() => setPluginRepairErrorVisible(false)}
        >
          {pluginRepairErrorSummary}
        </Alert>
      )}

      {/* 网关状态 - 置顶 */}
      <div
        className="border app-border rounded-lg overflow-hidden"
        style={{ transition: 'border-color 0.2s ease, box-shadow 0.2s ease' }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'var(--app-hover-border)'
          e.currentTarget.style.boxShadow = '0 0 12px var(--app-hover-glow)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = ''
          e.currentTarget.style.boxShadow = ''
        }}
      >
        <Group
          justify="space-between"
          className="px-3 py-2.5 cursor-pointer select-none"
          onClick={() => toggleSection('gateway')}
        >
          <Group gap="sm">
            <IconChevronRight
              size={14}
              style={{
                transform: expanded.gateway ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s',
              }}
              className="app-text-muted"
            />
            <Text size="sm" fw={600} className="app-text-primary">网关状态</Text>
            <Badge
              color={gateway.running ? 'green' : 'red'}
              variant="dot"
              size="sm"
            >
              {gateway.running ? '运行中' : '已停止'}
            </Badge>
          </Group>
        </Group>
        <Collapse in={Boolean(expanded.gateway)}>
          <div className="px-3 pb-3 space-y-2">
            <Group gap="xs" grow>
              <Tooltip
                label={gateway.running ? tooltips.dashboard.restartGateway : tooltips.dashboard.startGateway}
                withArrow
              >
                <Button
                  onClick={handleRestartGateway}
                  loading={restarting}
                  variant="light"
                  size="xs"
                  className="cursor-pointer"
                >
                  {gateway.running ? '重启网关' : '启动网关'}
                </Button>
              </Tooltip>
              <Tooltip label={tooltips.dashboard.forceRestartGateway} withArrow>
                <Button
                  onClick={handleForceRestart}
                  loading={forceRestarting}
                  variant="light"
                  color="orange"
                  size="xs"
                  className="cursor-pointer"
                >
                  强制重启
                </Button>
              </Tooltip>
              <Tooltip label={tooltips.dashboard.selfRepair} withArrow>
                <Button
                  onClick={handleSelfRepair}
                  loading={repairing}
                  variant="light"
                  color="teal"
                  size="xs"
                  className="cursor-pointer"
                >
                  自检修复
                </Button>
              </Tooltip>
              <Tooltip label={tooltips.dashboard.repairPluginEnvironment} withArrow>
                <Button
                  onClick={handleOpenPluginCenter}
                  variant="light"
                  color="yellow"
                  size="xs"
                  className="cursor-pointer"
                  rightSection={pluginRepairRunning || pluginCenterRunning ? <Loader size={14} /> : undefined}
                >
                  {pluginCenterTriggerLabel}
                </Button>
              </Tooltip>
            </Group>
            {activeRepairs.size > 0 && (
              <Group gap="xs" mt={4}>
                {Array.from(activeRepairs.values()).map((r) => (
                  <Badge key={r.channelId} variant="light" color="blue" size="sm">
                    正在修复 {r.channelId}...
                  </Badge>
                ))}
              </Group>
            )}
            {repairLastResult && (repairLastResult.trigger === 'startup' || repairLastResult.trigger === 'gateway-self-heal') && (
              <Text size="xs" c={repairLastResult.ok ? 'teal' : 'red'} mt={4}>
                {repairLastResult.ok
                  ? `自动修复完成: ${repairLastResult.summary}`
                  : `自动修复失败: ${repairLastResult.summary}`}
              </Text>
            )}
          </div>
        </Collapse>
      </div>

      {/* 开发者面板 */}
      <div
        className="border app-border rounded-lg overflow-hidden"
        style={{ transition: 'border-color 0.2s ease, box-shadow 0.2s ease' }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'var(--app-hover-border)'
          e.currentTarget.style.boxShadow = '0 0 12px var(--app-hover-glow)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = ''
          e.currentTarget.style.boxShadow = ''
        }}
      >
        <Group
          justify="space-between"
          className="px-3 py-2.5 cursor-pointer select-none"
          onClick={() => toggleSection('dev')}
        >
          <Group gap="sm">
            <IconChevronRight
              size={14}
              style={{
                transform: expanded.dev ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s',
              }}
              className="app-text-muted"
            />
            <Text size="sm" fw={600} className="app-text-primary">开发者面板</Text>
          </Group>
        </Group>
        <Collapse in={Boolean(expanded.dev)}>
          <div className="px-3 pb-3 flex gap-2">
            <Tooltip label={tooltips.dashboard.openDeveloperPanel} withArrow className="flex-1">
              <Button
                onClick={handleOpenDashboard}
                variant="filled"
                size="xs"
                fullWidth
                className="cursor-pointer"
              >
                打开 OpenClaw 开发者面板
              </Button>
            </Tooltip>
            <Tooltip label={tooltips.dashboard.openWorkspaceFolder} withArrow className="flex-1">
              <Button
                onClick={handleOpenWorkspace}
                variant="light"
                size="xs"
                fullWidth
                className="cursor-pointer"
              >
                打开工作区文件夹 (~/.openclaw)
              </Button>
            </Tooltip>
          </div>
        </Collapse>
      </div>

      {/* AI 模型 */}
      <div
        className="border app-border rounded-lg overflow-hidden"
        style={{ transition: 'border-color 0.2s ease, box-shadow 0.2s ease' }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'var(--app-hover-border)'
          e.currentTarget.style.boxShadow = '0 0 12px var(--app-hover-glow)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = ''
          e.currentTarget.style.boxShadow = ''
        }}
      >
        <Group
          justify="space-between"
          className="px-3 py-2.5 cursor-pointer select-none"
          onClick={() => toggleSection('model')}
        >
          <Group gap="sm">
            <IconChevronRight
              size={14}
              style={{
                transform: expanded.model ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s',
              }}
              className="app-text-muted"
            />
            <Text size="sm" fw={600} className="app-text-primary">AI 模型</Text>
            <Badge variant="outline" color="gray" size="xs">
              {visibleCatalog.filter((model) => providers.some((provider) => (
                getModelsPageProviderModels(provider.id, [model]).length > 0
              ))).length}
            </Badge>
          </Group>
          {providers.length > 0 && (
            <Group gap={4}>
              {activeModel && (
                <Text size="xs" c="dimmed" lineClamp={1} maw={160}>{activeModel}</Text>
              )}
              {providers.map((provider) => (
                <Text key={provider.id} size="xs" className="app-text-secondary">
                  {provider.logo}
                </Text>
              ))}
            </Group>
          )}
        </Group>
        <Collapse in={Boolean(expanded.model)}>
          <div className="px-3 pb-3 space-y-2">
            <Group justify="space-between" align="center">
              <Group gap="xs">
                <SegmentedControl
                  size="xs"
                  value={catalogMode}
                  onChange={(value) => setCatalogMode(value as ModelCatalogDisplayMode)}
                  data={[
                    { label: '可用', value: 'available' },
                    { label: '全量', value: 'all' },
                  ]}
                />
                <Tooltip label="刷新模型目录" withArrow>
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    loading={catalogRefreshing}
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleManualRefresh()
                    }}
                  >
                    <IconRefresh size={14} />
                  </ActionIcon>
                </Tooltip>
                {activeModel && (
                  <Badge size="xs" color="blue" variant="filled">{activeModel}</Badge>
                )}
              </Group>
              <Text size="xs" c="dimmed">{catalogRefreshLabel}</Text>
            </Group>
            {providers.length > 0 ? (
              <div className="space-y-3">
                {providers.map((provider) => {
                  const models = getModelsPageProviderModels(provider.id, visibleCatalog)
                  const providerCatalog = getModelsPageProviderModels(provider.id, effectiveCatalog)
                  const providerRuntimeState = resolveConfiguredProviderRuntimeState({
                    providerId: provider.id,
                    statusData: modelStatus,
                    catalog: providerCatalog,
                  })
                  const providerAvailableCount = providerCatalog.filter((model) => isCatalogModelAvailable(model)).length
                  const providerTotalCount = providerCatalog.length
                  return (
                    <div key={provider.id} className="rounded-lg p-2.5 app-bg-tertiary">
                      <Group gap={6} mb={models.length > 0 ? 6 : 0}>
                        <Text size="xs" fw={600} className="app-text-secondary">
                          {provider.logo} {provider.name}
                        </Text>
                        <Badge size="xs" color={providerRuntimeState.color} variant="light">
                          {providerRuntimeState.label}
                        </Badge>
                        {providerTotalCount > 0 && (
                          <Text size="xs" c="dimmed">
                            {catalogMode === 'available'
                              ? `${providerAvailableCount} 可用`
                              : `${providerAvailableCount}/${providerTotalCount} 可用`}
                          </Text>
                        )}
                      </Group>
                      {models.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {models.map((model) => {
                            const isActive = activeModel === model.key
                            const isSwitching = switching === model.key
                            const isUnavailable = !isCatalogModelAvailable(model)
                            return (
                              <div
                                key={model.key}
                                className="border rounded-md px-2.5 py-1.5 cursor-pointer select-none"
                                style={{
                                  borderColor: isActive ? 'var(--mantine-color-blue-5)' : 'var(--app-border)',
                                  backgroundColor: isActive ? 'var(--mantine-color-blue-light)' : undefined,
                                  opacity: isUnavailable && !isActive ? 0.72 : 1,
                                  transition: 'border-color 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease',
                                }}
                                onMouseEnter={(e) => {
                                  if (!isActive && !isUnavailable) {
                                    e.currentTarget.style.borderColor = 'var(--app-hover-border)'
                                    e.currentTarget.style.backgroundColor = 'var(--app-bg-tertiary)'
                                  }
                                }}
                                onMouseLeave={(e) => {
                                  if (!isActive && !isUnavailable) {
                                    e.currentTarget.style.borderColor = 'var(--app-border)'
                                    e.currentTarget.style.backgroundColor = ''
                                  }
                                }}
                                onClick={() => {
                                  if (!isActive && !isSwitching && !isUnavailable) setConfirmModel(model.key)
                                }}
                              >
                                <Group gap={6} wrap="nowrap">
                                  <Text
                                    size="xs"
                                    fw={isActive ? 600 : 400}
                                    c={isActive ? 'blue' : isUnavailable ? 'dimmed' : undefined}
                                    className={isActive ? '' : 'app-text-secondary'}
                                  >
                                    {model.name || model.key}
                                  </Text>
                                  {isActive && <Badge size="xs" color="blue" variant="light">当前</Badge>}
                                  {isUnavailable && <Badge size="xs" color="gray" variant="outline">未就绪</Badge>}
                                  {isSwitching && <Loader size={10} />}
                                </Group>
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <Text size="xs" c="dimmed" pl="md">{catalogSummary.providerEmptyText}</Text>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <Text size="xs" c="dimmed">暂无配置的模型提供商</Text>
            )}
          </div>
        </Collapse>
      </div>

      {/* IM 渠道 */}
      <div
        className="border app-border rounded-lg overflow-hidden"
        style={{ transition: 'border-color 0.2s ease, box-shadow 0.2s ease' }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'var(--app-hover-border)'
          e.currentTarget.style.boxShadow = '0 0 12px var(--app-hover-glow)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = ''
          e.currentTarget.style.boxShadow = ''
        }}
      >
        <Group
          justify="space-between"
          className="px-3 py-2.5 cursor-pointer select-none"
          onClick={() => toggleSection('channel')}
        >
          <Group gap="sm">
            <IconChevronRight
              size={14}
              style={{
                transform: expanded.channel ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s',
              }}
              className="app-text-muted"
            />
            <Text size="sm" fw={600} className="app-text-primary">消息渠道</Text>
            <Badge variant="outline" color="gray" size="xs">
              {channels.length}
            </Badge>
          </Group>
          {channels.length > 0 && (
            <Group gap={4}>
              {channels.map((channel) => {
                const def = getChannelDefinition(channel.platform)
                return def ? (
                  <img key={channel.id} src={def.logo} alt={def.name} style={{ width: 14, height: 14 }} />
                ) : null
              })}
            </Group>
          )}
        </Group>
        <Collapse in={Boolean(expanded.channel)}>
          <div className="px-3 pb-3 space-y-2">
            {channels.length > 0 ? (
              <Group gap="xs">
                {channels.map((channel) => {
                  const def = getChannelDefinition(channel.platform)
                  return (
                    <Badge key={channel.id} variant="light" size="lg" style={{ overflow: 'visible' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {def && <img src={def.logo} alt={def.name} style={{ width: 18, height: 18, flexShrink: 0 }} />}
                        {def?.name || channel.name}
                      </span>
                    </Badge>
                  )
                })}
              </Group>
            ) : (
              <Text size="xs" c="dimmed">暂无配置的消息渠道</Text>
            )}
          </div>
        </Collapse>
      </div>

      {/* 切换模型确认框 */}
      <Modal
        opened={pluginCenterOpened}
        onClose={handleClosePluginCenter}
        title="插件修复中心"
        centered
        size="lg"
        closeOnClickOutside={!pluginCenterRunning}
        closeOnEscape={!pluginCenterRunning}
        withCloseButton={!pluginCenterRunning}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {DASHBOARD_PLUGIN_ACTIONS.map((action) => (
            <Button
              key={action.id}
              variant={pluginCenterActionId === action.id ? 'filled' : 'light'}
              color={pluginCenterActionId === action.id ? 'yellow' : 'gray'}
              loading={pluginCenterRunning && pluginCenterActionId === action.id}
              disabled={pluginCenterRunning && pluginCenterActionId !== action.id}
              onClick={() => void handleRunPluginCenterAction(action)}
            >
              {action.buttonLabel}
            </Button>
          ))}
        </div>

        {(activePluginAction || pluginCenterSummary || pluginCenterError) && (
          <div className="mt-4 space-y-3">
            {activePluginAction && (
              <>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Text size="sm" fw={600} className="app-text-primary">
                      {pluginCenterPhaseTitle || `${activePluginAction.channelName} 插件处理中`}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {pluginCenterPhaseDetail || '正在处理插件环境，请稍候。'}
                    </Text>
                  </div>
                  <Badge color={pluginCenterError ? 'red' : pluginCenterRunning ? 'yellow' : 'teal'} variant="light">
                    {pluginCenterError ? '失败' : pluginCenterRunning ? '处理中' : '完成'}
                  </Badge>
                </div>

                <Progress value={pluginCenterProgress} color={pluginCenterError ? 'red' : 'yellow'} radius="xl" size="lg" />
                <Group justify="space-between" gap="xs">
                  <Text size="xs" c="dimmed">
                    {pluginCenterRunning ? '正在执行修复 / 安装流程' : '流程已结束'}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {Math.round(pluginCenterProgress)}%
                  </Text>
                </Group>
              </>
            )}

            {pluginCenterSummary && (
              <Alert color="teal" variant="light" title="处理完成">
                {pluginCenterSummary}
              </Alert>
            )}

            {pluginCenterError && (
              <Alert color="red" variant="light" title="处理失败">
                {pluginCenterError}
              </Alert>
            )}

            {pluginCenterLog && (
              <div className="app-bg-tertiary border app-border rounded-lg p-3 font-mono text-xs app-text-secondary whitespace-pre-wrap max-h-56 overflow-y-auto">
                {pluginCenterLog}
                {pluginCenterRunning && (
                  <span className="inline-block w-1.5 h-3.5 bg-amber-400 animate-pulse ml-0.5" />
                )}
              </div>
            )}
          </div>
        )}

        <Group justify="space-between" align="flex-start" gap="sm" mt="md">
          <Text size="xs" c="dimmed" style={{ flex: 1 }}>
            {pluginCenterRunning ? '关闭后修复流程会继续在后台执行，你可以稍后再次打开查看进度。' : ''}
          </Text>
          <Button variant="default" size="xs" onClick={handleClosePluginCenter}>
            {pluginCenterRunning ? '关闭窗口' : '关闭'}
          </Button>
        </Group>
      </Modal>

      <Modal
        opened={Boolean(confirmModel)}
        onClose={() => setConfirmModel('')}
        title="切换模型"
        centered
        size="xs"
      >
        <Text size="sm" className="app-text-secondary" mb="md">
          确认将默认模型切换为 <Text span fw={600} className="app-text-primary">{confirmModel}</Text> ?
        </Text>
        <Group justify="flex-end" gap="xs">
          <Button variant="default" size="xs" onClick={() => setConfirmModel('')}>取消</Button>
          <Button size="xs" onClick={() => handleSwitchModel(confirmModel)} loading={Boolean(switching)}>确认切换</Button>
        </Group>
      </Modal>
    </div>
  )
}
