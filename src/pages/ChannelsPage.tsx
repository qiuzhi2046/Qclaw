import { useEffect, useState, useRef } from 'react'
import { Button, Card, Badge, ScrollArea, Modal, Group, Text, Loader, Alert, Select } from '@mantine/core'
import { getChannelDefinition, removeWeixinChannelAccountConfig } from '../lib/openclaw-channel-registry'
import { createPageDataCache } from '../lib/page-data-cache'
import ChannelConnect, { type ChannelConnectNextPayload } from './ChannelConnect'
import PairingCode from './PairingCode'
import FeishuDiagnosticsModal from '../components/FeishuDiagnosticsModal'
import {
  getConfigModalTitle,
  getPairingIntroCopy,
  resolveChannelConnectAdvance,
  type ChannelPairingTarget,
} from './channels-page-utils'
import {
  listFeishuBots,
  listResidualLegacyFeishuAgentIds,
  removeFeishuBotConfigForPluginState,
  sanitizeFeishuPluginConfig,
} from './feishu-bots'
import {
  applyAgentPrimaryModelWithGatewayReload,
  extractPrimaryModelFromModelStatusPayload,
} from '../shared/model-config-gateway'
import {
  ensureModelSelectOption,
  loadReadyModelSelectOptions,
  type ModelSelectOption,
} from './channels-page-model-options'
import type { ManagedChannelPluginStatusView } from '../shared/managed-channel-plugin-lifecycle'
import {
  getOfficialChannelStageColor,
  getOfficialChannelStageLabel,
  getOfficialChannelStageStateLabel,
} from '../shared/official-channel-status-view'
import { runManagedChannelRepairFlow } from '../shared/managed-channel-repair'
import { resolveManagedChannelIdentity } from '../shared/managed-channel-identity'
import { getManagedChannelPluginByChannelId } from '../shared/managed-channel-plugin-registry'
import { readOpenClawUpstreamModelState } from '../shared/upstream-model-state'

interface ChannelInfo {
  id: string
  channelId: string
  configChannelId: string
  name: string
  platform: string
  enabled: boolean
  credentials: Record<string, string>
  pairingRequired: boolean
  pairingState: 'paired' | 'pending' | 'not_required'
  pairedCount: number
  pairingUsers: string[]
  pairingAccountId?: string
  accountName?: string
  agentId?: string
  isFeishuBot?: boolean
  runtimeState?: FeishuRuntimeStatusState
  runtimeSummary?: string
  runtimeIssues?: string[]
  pluginStatus?: ManagedChannelPluginStatusView | null
}

type FeishuRuntimeStatusState = 'online' | 'offline' | 'degraded' | 'disabled'
interface ChannelsPageSnapshot {
  channels: ChannelInfo[]
}

type FeishuRuntimeStatusRecord = Record<
  string,
  {
    runtimeState: FeishuRuntimeStatusState
    summary: string
    issues: string[]
  }
>

function getRuntimeBadgeColor(state: FeishuRuntimeStatusState | undefined): string {
  if (state === 'online') return 'teal'
  if (state === 'degraded') return 'yellow'
  if (state === 'disabled') return 'gray'
  return 'red'
}

function getRuntimeLabel(state: FeishuRuntimeStatusState | undefined): string {
  if (state === 'online') return '在线'
  if (state === 'degraded') return '待修复'
  if (state === 'disabled') return '已禁用'
  return '离线'
}

export function getChannelEnabledLabel(enabled: boolean): string {
  return enabled ? '已启用' : '已禁用'
}

export function shouldShowPluginStatus(channel: Pick<ChannelInfo, 'pluginStatus'>): boolean {
  return Boolean(channel.pluginStatus)
}

export function shouldShowFeishuPluginRepairAction(
  channel: Pick<ChannelInfo, 'channelId' | 'pairingAccountId'>
): boolean {
  return channel.channelId === 'feishu' && Boolean(channel.pairingAccountId)
}

export function shouldReuseModelOptionsCache(options?: {
  forceRefresh?: boolean
  mode?: 'available' | 'all'
}): boolean {
  return !options?.forceRefresh && options?.mode !== 'all'
}

const CHANNELS_PAGE_CACHE_TTL_MS = 60 * 1000
const channelsPageCache = createPageDataCache<ChannelsPageSnapshot>({ ttlMs: CHANNELS_PAGE_CACHE_TTL_MS })

export default function ChannelsPage() {
  const initialSnapshotRef = useRef<ChannelsPageSnapshot | null>(channelsPageCache.get()?.data || null)
  const initialSnapshot = initialSnapshotRef.current
  const [channels, setChannels] = useState<ChannelInfo[]>(initialSnapshot?.channels || [])
  const [loading, setLoading] = useState(!initialSnapshot)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [showConfigModal, setShowConfigModal] = useState(false)
  const [showPairingModal, setShowPairingModal] = useState(false)
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)
  const [selectedConfigTarget, setSelectedConfigTarget] = useState<ChannelPairingTarget | null>(null)
  const [selectedPairingChannel, setSelectedPairingChannel] = useState<ChannelInfo | null>(null)
  const [selectedDiagnosticsChannel, setSelectedDiagnosticsChannel] = useState<ChannelInfo | null>(null)
  const [showDiagnosticsModal, setShowDiagnosticsModal] = useState(false)
  const [configStep, setConfigStep] = useState<'channel-connect' | 'pairing-code'>('channel-connect')
  const [togglingChannelId, setTogglingChannelId] = useState<string | null>(null)
  const [repairingPluginChannelId, setRepairingPluginChannelId] = useState<string | null>(null)
  const [legacyFeishuAgentIds, setLegacyFeishuAgentIds] = useState<string[]>([])
  const [showModelModal, setShowModelModal] = useState(false)
  const [selectedModelChannel, setSelectedModelChannel] = useState<ChannelInfo | null>(null)
  const [modelOptions, setModelOptions] = useState<ModelSelectOption[]>([])
  const [selectedModelValue, setSelectedModelValue] = useState<string | null>(null)
  const [currentRuntimeModel, setCurrentRuntimeModel] = useState('')
  const [modelModalError, setModelModalError] = useState('')
  const [loadingModelContext, setLoadingModelContext] = useState(false)
  const [savingModel, setSavingModel] = useState(false)
  const modelOptionsCacheRef = useRef<ModelSelectOption[]>([])
  const pairingIntro = getPairingIntroCopy(selectedConfigTarget)

  const loadModelOptions = async (options?: {
    forceRefresh?: boolean
    mode?: 'available' | 'all'
    envVars?: Record<string, string> | null
    configData?: Record<string, any> | null
    statusData?: Record<string, any> | null
    preferredModelKey?: string
  }): Promise<ModelSelectOption[]> => {
    if (shouldReuseModelOptionsCache(options) && modelOptionsCacheRef.current.length > 0) {
      return modelOptionsCacheRef.current
    }

    const nextOptions = await loadReadyModelSelectOptions(window.api.listModelCatalog, {
      ...options,
      readUpstreamState: () => readOpenClawUpstreamModelState(),
    })
    modelOptionsCacheRef.current = nextOptions
    return nextOptions
  }

  const fetchChannels = async (options?: { background?: boolean }) => {
    const background = Boolean(options?.background)
    if (!background) {
      setLoading(true)
    }

    try {
      setError('')
      const [config, feishuPluginState, weixinAccounts] = await Promise.all([
        window.api.readConfig(),
        window.api.getFeishuOfficialPluginState().catch(() => null),
        window.api.listWeixinAccounts().catch(() => []),
      ])
      if (!config) {
        setChannels([])
        setLegacyFeishuAgentIds([])
        channelsPageCache.set({ channels: [] })
        return
      }

      const channelList: ChannelInfo[] = []
      const pluginStatusCache: Partial<Record<string, ManagedChannelPluginStatusView | null>> = {}
      const loadManagedPluginStatus = async (
        channelId: string
      ): Promise<ManagedChannelPluginStatusView | null> => {
        if (channelId in pluginStatusCache) {
          return pluginStatusCache[channelId] ?? null
        }

        const status = await window.api.getManagedChannelPluginStatus(channelId).catch(() => null)
        pluginStatusCache[channelId] = status
        return status
      }
      const feishuRuntimeStatus: FeishuRuntimeStatusRecord = await window.api
        .getFeishuRuntimeStatus()
        .catch(() => ({} as FeishuRuntimeStatusRecord))

      const normalizedConfig = feishuPluginState?.normalizedConfig || sanitizeFeishuPluginConfig(config)
      if (feishuPluginState?.configChanged) {
        void window.api.applyConfigPatchGuarded({
          beforeConfig: config,
          afterConfig: normalizedConfig,
          reason: 'unknown',
        }).catch(() => {
          // Keep listing channels even if the background healing write fails.
        })
      }
      setLegacyFeishuAgentIds(listResidualLegacyFeishuAgentIds(normalizedConfig))

      if (normalizedConfig.channels?.feishu) {
        const feishuPluginStatus = await loadManagedPluginStatus('feishu')
        const feishuBots = listFeishuBots(normalizedConfig)
        try {
          const feishuPairingStatus = await window.api.pairingFeishuStatus(feishuBots.map((bot) => bot.accountId))
          for (const bot of feishuBots) {
            const pairing = feishuPairingStatus[bot.accountId]
            const pairedCount = Number(pairing?.pairedCount || 0)
            channelList.push({
              id: `feishu:${bot.accountId}`,
              channelId: 'feishu',
              configChannelId: 'feishu',
              name: bot.name,
              accountName: bot.name,
              platform: 'feishu',
              enabled: bot.enabled,
              credentials: {},
              pairingRequired: true,
              pairingState: pairedCount > 0 ? 'paired' : 'pending',
              pairedCount,
              pairingUsers: pairing?.pairedUsers || [],
              pairingAccountId: bot.accountId,
              agentId: bot.agentId,
              isFeishuBot: true,
              runtimeState: feishuRuntimeStatus[bot.accountId]?.runtimeState,
              runtimeSummary: feishuRuntimeStatus[bot.accountId]?.summary,
              runtimeIssues: feishuRuntimeStatus[bot.accountId]?.issues || [],
              pluginStatus: feishuPluginStatus,
            })
          }
        } catch {
          for (const bot of feishuBots) {
            channelList.push({
              id: `feishu:${bot.accountId}`,
              channelId: 'feishu',
              configChannelId: 'feishu',
              name: bot.name,
              accountName: bot.name,
              platform: 'feishu',
              enabled: bot.enabled,
              credentials: {},
              pairingRequired: true,
              pairingState: 'pending',
              pairedCount: 0,
              pairingUsers: [],
              pairingAccountId: bot.accountId,
              agentId: bot.agentId,
              isFeishuBot: true,
              runtimeState: feishuRuntimeStatus[bot.accountId]?.runtimeState,
              runtimeSummary: feishuRuntimeStatus[bot.accountId]?.summary,
              runtimeIssues: feishuRuntimeStatus[bot.accountId]?.issues || [],
              pluginStatus: feishuPluginStatus,
            })
          }
        }
      }

      const weixinConfig = config.channels?.['openclaw-weixin']
      if (weixinAccounts.length > 0 || (weixinConfig && typeof weixinConfig === 'object')) {
        const weixinPluginStatus = await loadManagedPluginStatus('openclaw-weixin')
        const weixinConfigAccounts =
          weixinConfig && typeof weixinConfig === 'object' && !Array.isArray(weixinConfig)
            ? (weixinConfig.accounts as Record<string, any> | undefined)
            : undefined
        const accountIds = new Set<string>(weixinAccounts.map((account) => account.accountId))
        if (weixinConfigAccounts && typeof weixinConfigAccounts === 'object') {
          for (const accountId of Object.keys(weixinConfigAccounts)) {
            if (accountId.trim()) accountIds.add(accountId.trim())
          }
        }

        for (const accountId of accountIds) {
          const state = weixinAccounts.find((account) => account.accountId === accountId)
          const configEntry =
            weixinConfigAccounts && typeof weixinConfigAccounts === 'object'
              ? (weixinConfigAccounts[accountId] as Record<string, any> | undefined)
              : undefined
          const enabled =
            typeof configEntry?.enabled === 'boolean'
              ? configEntry.enabled
              : state?.enabled !== false

          channelList.push({
            id: `openclaw-weixin:${accountId}`,
            channelId: 'openclaw-weixin',
            configChannelId: 'openclaw-weixin',
            name: String(configEntry?.name || state?.name || accountId).trim() || accountId,
            accountName: String(configEntry?.name || state?.name || accountId).trim() || accountId,
            platform: 'openclaw-weixin',
            enabled,
            credentials: {},
            pairingRequired: false,
            pairingState: 'not_required',
            pairedCount: 0,
            pairingUsers: [],
            pairingAccountId: accountId,
            pluginStatus: weixinPluginStatus,
          })
        }
      }

      for (const [id, cfg] of Object.entries(config.channels || {})) {
        if (id === 'feishu' || id === 'openclaw-weixin') continue
        const channelConfig = (cfg || {}) as Record<string, any>
        const normalizedPlatform =
          (typeof channelConfig.domain === 'string' && channelConfig.domain.trim()) ||
          (id === 'dingtalk-connector' ? 'dingtalk' : id)
        const identity = resolveManagedChannelIdentity({
          configChannelId: id,
          platform: normalizedPlatform,
        })
        const channelDef = getChannelDefinition(identity.channelId) || getChannelDefinition(identity.platform)
        const pairingRequired = !channelDef?.skipPairing
        const pairingState: ChannelInfo['pairingState'] = !pairingRequired
          ? 'not_required'
          : 'pending'
        const pluginStatus = getManagedChannelPluginByChannelId(identity.channelId)
          ? await loadManagedPluginStatus(identity.channelId)
          : null

        channelList.push({
          id,
          channelId: identity.channelId,
          configChannelId: identity.configChannelId,
          name: channelConfig.name || channelDef?.name || identity.channelId || id,
          platform: identity.platform,
          enabled: channelConfig.enabled !== false,
          credentials: channelConfig.credentials || {},
          pairingRequired,
          pairingState,
          pairedCount: 0,
          pairingUsers: [],
          pairingAccountId: undefined,
          pluginStatus,
        })
      }

      setChannels(channelList)
      channelsPageCache.set({ channels: channelList })
    } catch (e) {
      setError('读取配置失败: ' + (e as Error).message)
    } finally {
      if (!background) {
        setLoading(false)
      }
    }
  }

  const closeModelModal = (options?: { force?: boolean }) => {
    if (savingModel && !options?.force) return
    setShowModelModal(false)
    setSelectedModelChannel(null)
    setModelOptions([])
    setSelectedModelValue(null)
    setCurrentRuntimeModel('')
    setModelModalError('')
    setLoadingModelContext(false)
  }

  const handleOpenModelConfig = async (channel: ChannelInfo) => {
    if (channel.channelId !== 'feishu' || !channel.agentId) return

    setSelectedModelChannel(channel)
    setShowModelModal(true)
    setModelModalError('')
    setLoadingModelContext(true)
    setCurrentRuntimeModel('')
    setSelectedModelValue(null)

    try {
      const [statusResult, envVars, configData] = await Promise.all([
        window.api.getModelStatus({ agentId: channel.agentId }),
        window.api.readEnvFile().catch(() => null),
        window.api.readConfig().catch(() => null),
      ])
      let nextOptions = modelOptionsCacheRef.current
      let nextRuntimeModel = ''
      const errors: string[] = []
      const statusData = statusResult.ok
        ? ((statusResult.data || null) as Record<string, any> | null)
        : null

      if (statusResult.ok) {
        nextRuntimeModel = extractPrimaryModelFromModelStatusPayload(statusData)
      } else {
        errors.push(statusResult.message || statusResult.stderr || '读取当前机器人模型失败')
      }

      try {
        nextOptions = await loadModelOptions({
          mode: 'all',
          envVars,
          configData,
          statusData,
          preferredModelKey: nextRuntimeModel,
        })
      } catch (reason) {
        errors.push(`读取模型目录失败: ${reason instanceof Error ? reason.message : 'unknown error'}`)
      }

      if (!nextOptions.length) {
        errors.push('模型目录为空，暂时无法为这个机器人选择模型')
      }

      nextOptions = ensureModelSelectOption(nextOptions, nextRuntimeModel)
      setModelOptions(nextOptions)
      setCurrentRuntimeModel(nextRuntimeModel)
      setSelectedModelValue(nextRuntimeModel || nextOptions[0]?.value || null)
      setModelModalError(errors.join('；'))
    } finally {
      setLoadingModelContext(false)
    }
  }

  const handleSaveBotModel = async () => {
    if (!selectedModelChannel?.agentId) {
      setModelModalError('当前飞书机器人缺少 Agent ID，无法配置模型')
      return
    }

    const model = String(selectedModelValue || '').trim()
    if (!model) {
      setModelModalError('请选择要应用到这个飞书机器人的模型')
      return
    }

    setSavingModel(true)
    setModelModalError('')
    try {
      const result = await applyAgentPrimaryModelWithGatewayReload({
        agentId: selectedModelChannel.agentId,
        model,
        readConfig: () => window.api.readConfig(),
        applyUpstreamModelWrite: (request) => window.api.applyModelConfigViaUpstream(request),
        applyConfigPatchGuarded: (request) => window.api.applyConfigPatchGuarded(request),
        getModelStatus: () => window.api.getModelStatus({ agentId: selectedModelChannel.agentId }),
        reloadGatewayAfterModelChange: () => window.api.reloadGatewayAfterModelChange(),
      })

      if (!result.ok) {
        setModelModalError(result.message || '飞书机器人模型切换失败')
        return
      }

      closeModelModal({ force: true })
      await fetchChannels({ background: true })
    } catch (e) {
      setModelModalError('飞书机器人模型切换失败: ' + (e as Error).message)
    } finally {
      setSavingModel(false)
    }
  }

  const handleRefreshChannels = async () => {
    setRefreshing(true)
    try {
      await fetchChannels({ background: true })
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void fetchChannels({ background: Boolean(initialSnapshot) })
  }, [initialSnapshot])

  const handleConfigDone = async () => {
    setShowConfigModal(false)
    setSelectedChannelId(null)
    setSelectedConfigTarget(null)
    setConfigStep('channel-connect')
    await fetchChannels({ background: true })
  }

  const handleOpenPairing = (channel: ChannelInfo) => {
    if (!channel.pairingRequired) return
    setSelectedPairingChannel(channel)
    setShowPairingModal(true)
  }

  const handlePairingClose = () => {
    setShowPairingModal(false)
    setSelectedPairingChannel(null)
  }

  const handlePairingDone = async () => {
    setShowPairingModal(false)
    setSelectedPairingChannel(null)
    await fetchChannels({ background: true })
  }

  const handleOpenDiagnostics = (channel: ChannelInfo) => {
    if (channel.channelId !== 'feishu' || !channel.pairingAccountId) return
    setSelectedDiagnosticsChannel(channel)
    setShowDiagnosticsModal(true)
  }

  const handleRepairFeishuPlugin = async (channel: ChannelInfo) => {
    if (!shouldShowFeishuPluginRepairAction(channel)) return

    setRepairingPluginChannelId(channel.channelId)
    setError('')

    try {
      const outcome = await runManagedChannelRepairFlow({
        getManagedChannelPluginStatus: (channelId) => window.api.getManagedChannelPluginStatus(channelId),
        repairManagedChannelPlugin: (channelId) => window.api.repairManagedChannelPlugin(channelId),
      }, channel.channelId)

      if (!outcome.ok) {
        throw new Error(outcome.summary || '飞书插件修复失败')
      }

      await fetchChannels({ background: true })
    } catch (e) {
      setError('飞书插件修复失败: ' + (e as Error).message)
    } finally {
      setRepairingPluginChannelId(null)
    }
  }

  const handleDiagnosticsClose = () => {
    setShowDiagnosticsModal(false)
    setSelectedDiagnosticsChannel(null)
  }

  const handleChannelConfigBack = () => {
    setShowConfigModal(false)
    setSelectedChannelId(null)
    setSelectedConfigTarget(null)
    setConfigStep('channel-connect')
  }

  const handleRemoveChannel = async (channel: ChannelInfo) => {
    if (!confirm(`确定要删除 ${channel.name} 吗？`)) return
    try {
      const config = sanitizeFeishuPluginConfig(await window.api.readConfig())
      if (config) {
        const feishuPluginState = await window.api.getFeishuOfficialPluginState()
        const beforeConfig = JSON.parse(JSON.stringify(config)) as Record<string, any>
        let nextConfig = JSON.parse(JSON.stringify(config)) as Record<string, any>
        if (channel.channelId === 'feishu' && channel.pairingAccountId) {
          nextConfig = removeFeishuBotConfigForPluginState(
            config,
            channel.pairingAccountId,
            feishuPluginState.installedOnDisk
          )
        } else if (channel.channelId === 'openclaw-weixin' && channel.pairingAccountId) {
          const removeStateResult = await window.api.removeWeixinAccount(channel.pairingAccountId)
          if (!removeStateResult.ok) {
            throw new Error(`删除个人微信账号失败: ${channel.pairingAccountId}`)
          }
          nextConfig = removeWeixinChannelAccountConfig(config, channel.pairingAccountId)
        } else {
          if (!nextConfig.channels || typeof nextConfig.channels !== 'object') {
            nextConfig.channels = {}
          }
          delete nextConfig.channels[channel.configChannelId]
        }
        const writeResult = await window.api.applyConfigPatchGuarded({
          beforeConfig,
          afterConfig: nextConfig,
          reason: 'channels-remove-channel',
        })
        if (!writeResult.ok) {
          throw new Error(writeResult.message || '配置文件写入失败')
        }
        await fetchChannels({ background: true })
      }
    } catch (e) {
      setError('删除失败: ' + (e as Error).message)
    }
  }

  const handleToggleChannelEnabled = async (channel: ChannelInfo) => {
    if (togglingChannelId && togglingChannelId !== channel.id) {
      return
    }
    setTogglingChannelId(channel.id)
    setError('')
    try {
      const config = sanitizeFeishuPluginConfig(await window.api.readConfig())
      if (!config || typeof config !== 'object') {
        throw new Error('未找到可更新的渠道配置')
      }

      const beforeConfig = JSON.parse(JSON.stringify(config)) as Record<string, any>
      const nextConfig = JSON.parse(JSON.stringify(config)) as Record<string, any>
      const nextEnabled = !channel.enabled

      if (!nextConfig.channels || typeof nextConfig.channels !== 'object') {
        nextConfig.channels = {}
      }

      if (channel.channelId === 'feishu' && channel.pairingAccountId) {
        if (!nextConfig.channels.feishu || typeof nextConfig.channels.feishu !== 'object') {
          throw new Error('未找到飞书渠道配置')
        }

        if (channel.pairingAccountId === 'default') {
          nextConfig.channels.feishu.enabled = nextEnabled
        } else {
          const accounts = nextConfig.channels.feishu.accounts as Record<string, any> | undefined
          if (!accounts || typeof accounts !== 'object' || !accounts[channel.pairingAccountId]) {
            throw new Error(`未找到飞书机器人账号: ${channel.pairingAccountId}`)
          }
          const accountConfig = accounts[channel.pairingAccountId]
          if (!accountConfig || typeof accountConfig !== 'object' || Array.isArray(accountConfig)) {
            throw new Error(`飞书机器人账号配置异常: ${channel.pairingAccountId}`)
          }
          accountConfig.enabled = nextEnabled
        }
      } else if (channel.channelId === 'openclaw-weixin' && channel.pairingAccountId) {
        const existingWeixinChannel = nextConfig.channels['openclaw-weixin'] as Record<string, any> | undefined
        const weixinChannel =
          existingWeixinChannel && typeof existingWeixinChannel === 'object' && !Array.isArray(existingWeixinChannel)
            ? existingWeixinChannel
            : {
                enabled: true,
                accounts: {},
              }
        nextConfig.channels['openclaw-weixin'] = weixinChannel
        const accounts =
          weixinChannel.accounts && typeof weixinChannel.accounts === 'object' && !Array.isArray(weixinChannel.accounts)
            ? (weixinChannel.accounts as Record<string, any>)
            : {}
        if (!accounts[channel.pairingAccountId]) {
          accounts[channel.pairingAccountId] = {
            enabled: channel.enabled,
            name: channel.accountName || channel.name,
          }
        }
        weixinChannel.accounts = accounts
        const accountConfig = accounts[channel.pairingAccountId]
        if (!accountConfig || typeof accountConfig !== 'object' || Array.isArray(accountConfig)) {
          throw new Error(`个人微信账号配置异常: ${channel.pairingAccountId}`)
        }
        accountConfig.enabled = nextEnabled
      } else {
        const targetChannel = nextConfig.channels[channel.configChannelId] as Record<string, any> | undefined
        if (!targetChannel || typeof targetChannel !== 'object' || Array.isArray(targetChannel)) {
          throw new Error(`未找到渠道配置: ${channel.configChannelId}`)
        }
        targetChannel.enabled = nextEnabled
      }

      const writeResult = await window.api.applyConfigPatchGuarded({
        beforeConfig,
        afterConfig: nextConfig,
        reason: 'unknown',
      })
      if (!writeResult.ok) {
        throw new Error(writeResult.message || '配置文件写入失败')
      }
      await fetchChannels({ background: true })
    } catch (e) {
      setError(`${channel.enabled ? '禁用' : '启用'}失败: ${(e as Error).message}`)
    } finally {
      setTogglingChannelId(null)
    }
  }

  const getPlatformInfo = (channelId: string, platform: string) => {
    const channelDef = getChannelDefinition(platform) || getChannelDefinition(channelId)
    return {
      logo: channelDef?.logo || null,
      name: channelDef?.name || platform,
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader size="lg" />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <Group justify="space-between">
        <div>
          <Text size="xl" fw={700}>IM 渠道管理</Text>
          <Text size="sm" c="dimmed" mt={4}>
            配置和管理飞书、企微、钉钉、QQ 等 IM 渠道
          </Text>
        </div>
        <Group gap="sm">
          <Button
            variant="default"
            onClick={() => {
              void handleRefreshChannels()
            }}
            loading={refreshing}
            size="md"
            className="cursor-pointer"
          >
            刷新
          </Button>
          <Button
            onClick={() => {
              setSelectedChannelId(null)
              setSelectedConfigTarget(null)
              setConfigStep('channel-connect')
              setShowConfigModal(true)
            }}
            size="md"
            className="cursor-pointer"
          >
            添加渠道
          </Button>
        </Group>
      </Group>

      {error && (
        <Alert color="red" title="错误" onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {legacyFeishuAgentIds.length > 0 && (
        <Alert color="yellow" title="检测到历史遗留飞书 Agent">
          检测到未绑定当前飞书渠道配置的独立 Agent：{legacyFeishuAgentIds.join('、')}。它们不会出现在“每个飞书机器人单独配置模型”的当前入口里，避免误操作到历史残留配置。
        </Alert>
      )}

      <ScrollArea h="calc(100vh - 200px)">
        <div className="space-y-4">
          {channels.length === 0 ? (
            <Card padding="xl" withBorder className="text-center">
              <Text size="sm" c="dimmed">
                暂无配置的 IM 渠道，点击"添加渠道"开始配置
              </Text>
            </Card>
          ) : (
            channels.map((channel) => {
              const platformInfo = getPlatformInfo(channel.id, channel.platform)
              const isToggling = togglingChannelId === channel.id
              const togglingAnyChannel = Boolean(togglingChannelId)
              const togglingAnotherChannel = Boolean(togglingChannelId && togglingChannelId !== channel.id)
              return (
                <Card
                  key={channel.id}
                  padding="lg"
                  withBorder
                  className={`transition-colors duration-200 ${
                    channel.pairingRequired ? 'cursor-pointer' : ''
                  }`}
                  style={channel.pairingRequired ? { '--hover-bg': 'var(--app-bg-tertiary)' } as React.CSSProperties : undefined}
                  onMouseEnter={(e) => {
                    if (channel.pairingRequired) e.currentTarget.style.backgroundColor = 'var(--app-bg-tertiary)'
                  }}
                  onMouseLeave={(e) => {
                    if (channel.pairingRequired) e.currentTarget.style.backgroundColor = ''
                  }}
                  onClick={channel.pairingRequired ? () => handleOpenPairing(channel) : undefined}
                >
                  <Group justify="space-between" align="flex-start">
                    <Group gap="md" align="flex-start">
                      {platformInfo.logo
                        ? <img src={platformInfo.logo} alt={platformInfo.name} style={{ width: 32, height: 32 }} />
                        : <Text size="2xl">❓</Text>
                      }
                      <div>
                        <Group gap="xs">
                          <Text size="lg" fw={600}>{channel.name}</Text>
                          <Badge variant="light" size="sm">
                            {platformInfo.name}
                          </Badge>
                        </Group>
                        <Text size="xs" c="dimmed" mt={4}>
                          ID: {channel.id}
                        </Text>
                        {!channel.isFeishuBot && channel.configChannelId !== channel.channelId && (
                          <Text size="xs" c="dimmed" mt={4}>
                            渠道标识：{channel.channelId}
                          </Text>
                        )}
                        {channel.agentId && (
                          <Text size="xs" c="dimmed" mt={4}>
                            Agent: {channel.agentId}
                          </Text>
                        )}
                        <Group gap="xs" mt={8}>
                          <Badge variant="light" size="sm" color={channel.enabled ? 'teal' : 'gray'}>
                            {getChannelEnabledLabel(channel.enabled)}
                          </Badge>
                          {channel.channelId === 'feishu' && (
                            <Badge
                              variant="light"
                              size="sm"
                              color={getRuntimeBadgeColor(channel.runtimeState)}
                            >
                              {getRuntimeLabel(channel.runtimeState)}
                            </Badge>
                          )}
                        </Group>
                        <Text size="xs" c="dimmed" mt={6}>
                          {channel.pairingRequired
                            ? channel.channelId === 'openclaw-weixin'
                              ? '点击卡片可为这个个人微信账号批准其他用户的配对授权。'
                              : '点击卡片可进入这个机器人的配对管理。'
                            : channel.channelId === 'openclaw-weixin'
                              ? '当前个人微信仅支持扫码登录的这个微信账号使用，暂不支持给其他微信用户做配对授权。'
                            : `${platformInfo.name} 渠道接入后无需额外配对。`}
                        </Text>
                        {channel.channelId === 'feishu' && channel.runtimeSummary && (
                          <Text size="xs" c="dimmed" mt={6}>
                            运行状态：{channel.runtimeSummary}
                          </Text>
                        )}
                        {shouldShowPluginStatus(channel) && channel.pluginStatus && (
                          <div className="mt-3 space-y-2">
                            <Text size="xs" c="dimmed">
                              插件状态：{channel.pluginStatus.summary}
                            </Text>
                            <Group gap="xs">
                              {channel.pluginStatus.stages.map((stage) => (
                                <Badge
                                  key={`${channel.id}:${stage.id}`}
                                  variant="light"
                                  size="sm"
                                  color={getOfficialChannelStageColor(stage.state)}
                                >
                                  {getOfficialChannelStageLabel(stage.id)} · {getOfficialChannelStageStateLabel(stage.state)}
                                </Badge>
                              ))}
                            </Group>
                          </div>
                        )}
                      </div>
                    </Group>
                    <Group gap="xs">
                      {channel.channelId === 'feishu' && channel.agentId && (
                        <Button
                          variant="light"
                          size="sm"
                          disabled={togglingAnyChannel}
                          onClick={(event) => {
                            event.stopPropagation()
                            void handleOpenModelConfig(channel)
                          }}
                          className="cursor-pointer"
                        >
                          配置模型
                        </Button>
                      )}
                      <Button
                        color={channel.enabled ? 'orange' : 'teal'}
                        variant="light"
                        size="sm"
                        disabled={togglingAnotherChannel}
                        loading={isToggling}
                        onClick={(event) => {
                          event.stopPropagation()
                          void handleToggleChannelEnabled(channel)
                        }}
                        className="cursor-pointer"
                      >
                        {channel.enabled ? '禁用' : '启用'}
                      </Button>
                      {channel.pairingRequired && (
                        <Button
                          variant="light"
                          size="sm"
                          disabled={togglingAnyChannel}
                          onClick={(event) => {
                            event.stopPropagation()
                            handleOpenPairing(channel)
                          }}
                          className="cursor-pointer"
                        >
                          配对管理
                        </Button>
                      )}
                      {channel.channelId === 'feishu' && channel.pairingAccountId && (
                        <Button
                          variant="light"
                          size="sm"
                          disabled={togglingAnyChannel}
                          onClick={(event) => {
                            event.stopPropagation()
                            handleOpenDiagnostics(channel)
                          }}
                          className="cursor-pointer"
                        >
                          故障排查
                        </Button>
                      )}
                      {shouldShowFeishuPluginRepairAction(channel) && (
                        <Button
                          variant="light"
                          size="sm"
                          disabled={togglingAnyChannel || (Boolean(repairingPluginChannelId) && repairingPluginChannelId !== channel.channelId)}
                          loading={repairingPluginChannelId === channel.channelId}
                          onClick={(event) => {
                            event.stopPropagation()
                            void handleRepairFeishuPlugin(channel)
                          }}
                          className="cursor-pointer"
                        >
                          修复飞书插件
                        </Button>
                      )}
                      <Button
                        color="red"
                        variant="light"
                        size="sm"
                        disabled={togglingAnyChannel}
                        onClick={(event) => {
                          event.stopPropagation()
                          void handleRemoveChannel(channel)
                        }}
                        className="cursor-pointer"
                      >
                        删除
                      </Button>
                    </Group>
                  </Group>
                </Card>
              )
            })
          )}
        </div>
      </ScrollArea>

      {/* 配置渠道 Modal */}
      <Modal
        opened={showConfigModal}
        onClose={handleChannelConfigBack}
        title={getConfigModalTitle(configStep, selectedConfigTarget)}
        size={
          (configStep === 'channel-connect' && selectedChannelId === 'openclaw-weixin')
          || selectedConfigTarget?.channelId === 'openclaw-weixin'
            ? '92vw'
            : 'xl'
        }
        styles={{
          body: {
            maxHeight: 'calc(100vh - 120px)',
            overflowY: 'auto',
          },
        }}
      >
        {configStep === 'channel-connect' && (
          <ChannelConnect
            initialChannelId={selectedChannelId ?? undefined}
            onNext={(payload: ChannelConnectNextPayload) => {
              const advance = resolveChannelConnectAdvance({
                channelId: payload.channelId,
                accountId: payload.accountId,
                accountName: payload.accountName,
                skipPairing: payload.skipPairing,
              })

              if (advance.shouldComplete) {
                void handleConfigDone()
                return
              }

              setSelectedChannelId(advance.selectedTarget?.channelId || null)
              setSelectedConfigTarget(advance.selectedTarget)
              setConfigStep(advance.nextStep)
            }}
            onBack={handleChannelConfigBack}
            onSkip={handleConfigDone}
            setupModelContext={null}
          />
        )}
        {configStep === 'pairing-code' && selectedConfigTarget?.channelId && (
          <div className="space-y-4">
            <Alert
              color="success"
              variant="light"
              title={pairingIntro.title}
            >
              {pairingIntro.message}
            </Alert>

            <PairingCode
              channel={selectedConfigTarget.channelId}
              accountId={selectedConfigTarget.accountId || undefined}
              accountName={selectedConfigTarget.accountName || undefined}
              onBack={() => setConfigStep('channel-connect')}
              onComplete={handleConfigDone}
              onSkip={handleConfigDone}
              completeLabel="完成配置"
            />
          </div>
        )}
        {configStep === 'pairing-code' && !selectedConfigTarget?.channelId && (
          <Alert color="warning" variant="light" title="未找到刚完成接入的渠道">
            当前无法继续配对。请关闭这个窗口后重新进入“添加渠道”，再次完成飞书接入。
          </Alert>
        )}
      </Modal>

      <Modal
        opened={showPairingModal}
        onClose={handlePairingClose}
        title={selectedPairingChannel ? `${selectedPairingChannel.name} 配对` : '渠道配对'}
        size="lg"
      >
        {selectedPairingChannel && (
          <div className="space-y-4">
            <Group gap="xs">
              <Badge variant="light" size="sm" color={selectedPairingChannel.enabled ? 'teal' : 'gray'}>
                {getChannelEnabledLabel(selectedPairingChannel.enabled)}
              </Badge>
              {selectedPairingChannel.channelId === 'feishu' && (
                <Badge
                  variant="light"
                  size="sm"
                  color={getRuntimeBadgeColor(selectedPairingChannel.runtimeState)}
                >
                  {getRuntimeLabel(selectedPairingChannel.runtimeState)}
                </Badge>
              )}
            </Group>

            <Text size="sm" c="dimmed">
              {selectedPairingChannel.pairedCount > 0
                ? `当前机器人已有 ${selectedPairingChannel.pairedCount} 个账户完成配对。你也可以继续输入新的配对码，为更多用户授权。`
                : `当前机器人已经接入 OpenClaw，但还没有用户完成配对。请先在${selectedPairingChannel.name}中给机器人发送消息，再把返回的配对码粘贴到这里。`}
            </Text>
            {selectedPairingChannel.channelId === 'feishu' && selectedPairingChannel.runtimeSummary && (
              <Alert
                color={selectedPairingChannel.runtimeState === 'online' ? 'green' : selectedPairingChannel.runtimeState === 'degraded' ? 'yellow' : 'red'}
                variant="light"
                title="当前运行状态"
              >
                {selectedPairingChannel.runtimeSummary}
              </Alert>
            )}

            <PairingCode
              channel={selectedPairingChannel.channelId}
              accountId={selectedPairingChannel.pairingAccountId}
              accountName={selectedPairingChannel.accountName}
              surface="dashboard"
              onBack={handlePairingClose}
              onComplete={handlePairingDone}
              showSkip={false}
              backLabel="关闭"
              completeLabel="完成"
            />
          </div>
        )}
      </Modal>

      <Modal
        opened={showModelModal}
        onClose={closeModelModal}
        title={selectedModelChannel ? `${selectedModelChannel.name} 模型配置` : '飞书机器人模型配置'}
        size="lg"
      >
        <div className="space-y-4">
          {selectedModelChannel?.agentId && (
            <Text size="sm" c="dimmed">
              Agent: {selectedModelChannel.agentId}
            </Text>
          )}

          {currentRuntimeModel && (
            <Alert color="blue" variant="light" title="当前运行模型">
              {currentRuntimeModel}
            </Alert>
          )}

          {modelModalError && (
            <Alert color="red" variant="light" title="模型配置提示">
              {modelModalError}
            </Alert>
          )}

          {loadingModelContext ? (
            <div className="flex items-center justify-center py-8">
              <Loader size="md" />
            </div>
          ) : (
            <Select
              label="主模型"
              placeholder="选择要绑定到这个飞书机器人的模型"
              data={modelOptions}
              value={selectedModelValue}
              onChange={setSelectedModelValue}
              searchable
              nothingFoundMessage="没有匹配的模型"
            />
          )}

          <Group justify="flex-end">
            <Button variant="default" onClick={() => closeModelModal()} disabled={savingModel}>
              取消
            </Button>
            <Button onClick={() => void handleSaveBotModel()} loading={savingModel} disabled={loadingModelContext}>
              保存
            </Button>
          </Group>
        </div>
      </Modal>

      {selectedDiagnosticsChannel?.pairingAccountId && (
        <FeishuDiagnosticsModal
          opened={showDiagnosticsModal}
          onClose={handleDiagnosticsClose}
          accountId={selectedDiagnosticsChannel.pairingAccountId}
          botLabel={selectedDiagnosticsChannel.accountName || selectedDiagnosticsChannel.name}
          agentId={selectedDiagnosticsChannel.agentId}
        />
      )}
    </div>
  )
}
