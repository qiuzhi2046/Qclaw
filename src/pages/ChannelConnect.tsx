import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Alert, Badge, Button, Card, PasswordInput, ScrollArea, SegmentedControl, Stack, Tabs, Text, TextInput, Title, Modal, Loader } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { QRCodeSVG } from 'qrcode.react'
import FeishuInstallTutorialModal from '../components/FeishuInstallTutorialModal'
import {
  applyChannelConfig,
  DEFAULT_FEISHU_CHANNEL_SETTINGS,
  getChannelDefinition,
  isChannelPluginConfigured,
  isPluginAlreadyInstalledError,
  listChannelDefinitions,
  resolveChannelPluginAllowId,
  syncWeixinChannelAccounts,
  stripLegacyOpenClawRootKeys,
  validateChannelForm,
} from '../lib/openclaw-channel-registry'
import { getManagedChannelPluginByChannelId } from '../shared/managed-channel-plugin-registry'
import type { SetupModelContext } from './ModelCenter'
import type { DingtalkOfficialSetupResult } from '../shared/dingtalk-official-setup'
import {
  addFeishuBotConfig,
  listFeishuBots,
  reconcileFeishuOfficialPluginConfig,
  sanitizeFeishuPluginConfig,
  stripFeishuOfficialPluginConfig,
} from './feishu-bots'
import { shouldShowSkipButtonForFeishuPairing } from './channel-connect-skip'
import {
  extractFeishuAsciiQr,
  extractFirstHttpUrl,
  FEISHU_OFFICIAL_GUIDE_URL,
} from '../lib/feishu-installer'
import {
  buildFeishuCreateBotConfirmationMessage,
  isFeishuCreateBotConfirmationPrompt,
  shouldDisableFeishuInstallerManualInput,
} from '../shared/feishu-installer-session'
import { toUserFacingCliFailureMessage, toUserFacingUnknownErrorMessage } from '../lib/user-facing-cli-feedback'
import type { ManagedChannelPluginStatusView } from '../shared/managed-channel-plugin-lifecycle'
import { pollWithBackoff } from '../shared/polling'
import { UI_RUNTIME_DEFAULTS } from '../shared/runtime-policies'
import type { OpenClawGuardedWriteReason, OpenClawGuardedWriteResult } from '../shared/openclaw-phase2'

type Status = 'form' | 'installing' | 'starting' | 'connected' | 'error'

export interface ChannelConnectNextPayload {
  channelId: string
  accountId?: string
  accountName?: string
  skipPairing?: boolean
}

export type ChannelConnectBindingStrategy = 'qr-binding' | 'cli-channels-add' | 'config-write'
export type ManagedPluginInstallStrategy = 'reuse-installed-plugin' | 'install-plugin'
type ManagedPluginPrepareResult = Awaited<ReturnType<typeof window.api.prepareManagedChannelPluginForSetup>>
type ManagedPluginRepairResult = Awaited<ReturnType<typeof window.api.repairManagedChannelPlugin>>
type RepairIncompatiblePluginsOptions = Parameters<typeof window.api.repairIncompatiblePlugins>[0]
type ManagedPluginInstallPreflightApi =
  Pick<typeof window.api, 'prepareManagedChannelPluginForSetup'>
type ChannelConnectGatewayReadyApi =
  Pick<typeof window.api, 'reloadGatewayAfterChannelChange'>
  & Partial<Pick<typeof window.api, 'repairManagedChannelPlugin' | 'getManagedChannelPluginStatus' | 'ensureGatewayRunning'>>
type FeishuManualBindingOpenClawHotReloadApi =
  Partial<Pick<typeof window.api, 'gatewayHealth' | 'getFeishuRuntimeStatus'>>

const CHANNELS = listChannelDefinitions()

export function resolveChannelConnectBindingStrategy(
  channel: { useQrBinding?: boolean; useCliChannelsAdd?: boolean } | null | undefined
): ChannelConnectBindingStrategy {
  if (channel?.useQrBinding) return 'qr-binding'
  if (channel?.useCliChannelsAdd) return 'cli-channels-add'
  return 'config-write'
}

export function resolveManagedPluginInstallStrategy(params: {
  pluginConfigured: boolean
  pluginInstalledOnDisk: boolean
  forceInstall?: boolean
}): ManagedPluginInstallStrategy {
  if (params.forceInstall) {
    return 'install-plugin'
  }
  if (params.pluginInstalledOnDisk) {
    return 'reuse-installed-plugin'
  }
  return 'install-plugin'
}

export function isSafeAlreadyInstalledManagedPluginInstallError(detail: string): boolean {
  return isPluginAlreadyInstalledError(detail)
    && !String(detail || '').includes('已自动隔离')
    && !String(detail || '').includes('安全修复失败')
}

export function buildManagedPluginScopedRepairOptions(
  channel: Pick<NonNullable<ReturnType<typeof getChannelDefinition>>, 'plugin'> | null | undefined
): RepairIncompatiblePluginsOptions | null {
  const pluginAllowId = channel ? resolveChannelPluginAllowId(channel) : undefined
  const scopePluginIds = Array.from(
    new Set(
      [pluginAllowId, ...(channel?.plugin?.cleanupPluginIds || [])]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  )

  if (scopePluginIds.length === 0) return null

  return {
    scopePluginIds,
    quarantineOfficialManagedPlugins: true,
  }
}

function getManagedPluginInstalledOnDiskFromStatus(
  status: ManagedChannelPluginStatusView
): boolean {
  return status.stages.some((stage) => stage.id === 'installed' && stage.state === 'verified')
}

function hasVerifiedManagedPluginInstallAndRegistration(
  status: ManagedChannelPluginStatusView
): boolean {
  return getManagedPluginInstalledOnDiskFromStatus(status)
    && status.stages.some((stage) => stage.id === 'registered' && stage.state === 'verified')
}

function isRepairableChannelConnectGatewayStateCode(stateCode: unknown): boolean {
  return stateCode === 'plugin_load_failure' || stateCode === 'config_invalid'
}

function shouldSkipTargetedManagedRepair(channelId: string): boolean {
  return channelId === 'openclaw-weixin'
}

function getGatewayReadyFailureMessage(
  result: Partial<{
    summary: string
    stderr: string
    stdout: string
  }>,
  fallback = '网关启动失败'
): string {
  const summary = String(result.summary || '').trim()
  if (summary) return summary

  const fallbackMessage = String(result.stderr || '').trim()
    || String(result.stdout || '').trim()
    || fallback
  return toUserFacingCliFailureMessage({
    stderr: fallbackMessage,
    fallback,
  })
}

function getManagedChannelRepairFailureMessage(result: ManagedPluginRepairResult): string {
  if (result.kind === 'manual-action-required') return result.reason
  if (result.kind === 'gateway-reload-failed') return result.reloadReason
  if (result.kind === 'install-failed' || result.kind === 'repair-failed') return result.error
  if (result.kind === 'config-sync-required') return result.reason
  if (result.kind === 'plugin-ready-channel-not-ready') return result.blockingReason
  if (result.kind === 'capability-blocked') {
    return result.missingCapabilities.join('；') || result.status.summary
  }
  if (result.kind === 'quarantine-failed') {
    return result.status.summary || `插件隔离失败：${result.failureKind}`
  }
  return result.status.summary || '网关启动失败'
}

export async function resolveManagedPluginInstallPreflight(
  api: ManagedPluginInstallPreflightApi,
  params: {
    channel: Pick<NonNullable<ReturnType<typeof getChannelDefinition>>, 'id' | 'plugin'> | null | undefined
    pluginConfigured: boolean
  }
): Promise<{
  pluginInstalledOnDisk: boolean
  pluginInstallStrategy: ManagedPluginInstallStrategy
  prepareResult: ManagedPluginPrepareResult | null
}> {
  const prepareResult = params.channel
    ? await api.prepareManagedChannelPluginForSetup(params.channel.id)
    : null

  if (!prepareResult) {
    return {
      pluginInstalledOnDisk: false,
      pluginInstallStrategy: 'install-plugin',
      prepareResult: null,
    }
  }

  if (prepareResult.kind === 'prepare-failed') {
    throw new Error(prepareResult.error || '插件兼容性预检失败，请稍后重试。')
  }

  if (prepareResult.kind === 'capability-blocked') {
    throw new Error(
      prepareResult.missingCapabilities.join('；') || '当前环境暂不支持该插件安装能力。'
    )
  }

  const pluginInstalledOnDisk =
    'status' in prepareResult
      ? getManagedPluginInstalledOnDiskFromStatus(prepareResult.status)
      : false
  const forceInstall =
    prepareResult.kind === 'manual-action-required'
    || (prepareResult.kind === 'config-sync-required' && !pluginInstalledOnDisk)
    || (prepareResult.kind === 'ok' && prepareResult.action === 'install-before-setup')

  return {
    pluginInstalledOnDisk,
    pluginInstallStrategy: resolveManagedPluginInstallStrategy({
      pluginConfigured: params.pluginConfigured,
      pluginInstalledOnDisk,
      forceInstall,
    }),
    prepareResult,
  }
}

function extractAsciiQrBlock(text: string): string {
  const lines = String(text || '').split(/\r?\n/)
  let bestBlock = ''
  let currentBlock: string[] = []

  const flushCurrent = () => {
    if (currentBlock.length >= 8) {
      const candidate = currentBlock.join('\n').trimEnd()
      if (candidate.length > bestBlock.length) {
        bestBlock = candidate
      }
    }
    currentBlock = []
  }

  for (const line of lines) {
    const looksLikeQrLine = /[█▄▀]/.test(line) && line.replace(/\s/g, '').length >= 12
    if (looksLikeQrLine) {
      currentBlock.push(line)
      continue
    }

    if (currentBlock.length > 0) {
      flushCurrent()
    }
  }

  flushCurrent()
  return bestBlock
}

async function writeConfigDirect(
  config: Record<string, unknown>,
  reason: OpenClawGuardedWriteReason = 'channel-connect-configure'
): Promise<OpenClawGuardedWriteResult> {
  const result = await window.api.writeConfigGuarded({ config, reason })
  if (!result.ok) {
    throw new Error(result.message || '配置文件写入失败')
  }
  return result
}

async function writeConfigPatch(
  beforeConfig: Record<string, any> | null | undefined,
  afterConfig: Record<string, any>,
  reason: OpenClawGuardedWriteReason = 'channel-connect-configure'
) {
  const result = await window.api.applyConfigPatchGuarded({
    beforeConfig: beforeConfig || {},
    afterConfig,
    reason,
  })
  if (!result.ok) {
    throw new Error(result.message || '配置文件写入失败')
  }
}

export function buildChannelConnectCompletionCopy(
  channel: Pick<NonNullable<ReturnType<typeof getChannelDefinition>>, 'id' | 'name' | 'skipPairing'> | null | undefined
): string {
  if (!channel) return ''
  if (channel.id === 'dingtalk') {
    return [
      '⚠️ 当前只确认插件安装、最小配置补丁和网关重载已完成。',
      '钉钉 `loaded / ready` 仍待上游状态证明，当前状态按 `unknown / 未证实` 处理。',
    ].join('\n')
  }

  if (channel.skipPairing) {
    return `${channel.name} 渠道已就绪，可以开始使用了。`
  }

  return `现在请在 ${channel.name} 中给机器人发一条消息，获取配对码。`
}

export function shouldShowChannelConnectSkipButton(params: {
  canSkip: boolean
  forceShowSkip?: boolean
}): boolean {
  return Boolean(params.forceShowSkip || params.canSkip)
}

export function buildDingtalkOfficialSetupLog(result: DingtalkOfficialSetupResult): string {
  const lines: string[] = []

  for (const item of result.evidence) {
    const isGatewayFailure = item.source === 'gateway' && result.gatewayResult?.running !== true
    lines.push(`${isGatewayFailure ? '⚠️' : '✅'} ${item.message}`)
    if (item.jsonPaths && item.jsonPaths.length > 0) {
      lines.push(`变更路径：${item.jsonPaths.join(', ')}`)
    }
    lines.push('')
  }

  if (!result.ok && result.message) {
    lines.push(`❌ ${result.message}`)
    lines.push('')
  }

  return lines.join('\n')
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasOwnRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeChannelConnectText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function listPluginCleanupTargets(channel: { plugin?: { cleanupPluginIds?: string[] } } | null | undefined): string[] {
  const seen = new Set<string>()
  const cleanupTargets: string[] = []
  for (const pluginId of channel?.plugin?.cleanupPluginIds || []) {
    const normalizedPluginId = String(pluginId || '').trim()
    if (!normalizedPluginId || seen.has(normalizedPluginId)) continue
    seen.add(normalizedPluginId)
    cleanupTargets.push(normalizedPluginId)
  }
  return cleanupTargets
}

export function captureFeishuBotConfigSnapshot(
  config: Record<string, any> | null
): Record<string, any> | null {
  if (listFeishuBots(config).length === 0) return null

  const feishuConfig = config?.channels?.feishu
  if (!feishuConfig || typeof feishuConfig !== 'object' || Array.isArray(feishuConfig)) {
    return null
  }

  return cloneJsonValue(feishuConfig)
}

export function restoreCapturedFeishuBotConfig(
  config: Record<string, any> | null,
  feishuConfigSnapshot: Record<string, any> | null
): Record<string, any> {
  const nextConfig =
    config && typeof config === 'object' && !Array.isArray(config)
      ? cloneJsonValue(config)
      : {}

  if (!feishuConfigSnapshot) return nextConfig

  if (!nextConfig.channels || typeof nextConfig.channels !== 'object' || Array.isArray(nextConfig.channels)) {
    nextConfig.channels = {}
  }

  nextConfig.channels.feishu = cloneJsonValue(feishuConfigSnapshot)
  return nextConfig
}

function normalizeFeishuConfigText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isFeishuSecretRefLike(value: unknown): value is { source: string; provider: string; id: string } {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (
      (value as Record<string, unknown>).source === 'env'
      || (value as Record<string, unknown>).source === 'file'
    )
    && typeof (value as Record<string, unknown>).provider === 'string'
    && typeof (value as Record<string, unknown>).id === 'string'
}

function hasFeishuSecretInput(value: unknown): boolean {
  return normalizeFeishuConfigText(value).length > 0 || isFeishuSecretRefLike(value)
}

function cloneFeishuSecretInput<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return cloneJsonValue(value)
}

function readFeishuBotCredentials(
  config: Record<string, any> | null,
  accountId: string
): { name: string; appId: string; appSecret: unknown } | null {
  const feishu = config?.channels?.feishu
  if (!feishu || typeof feishu !== 'object' || Array.isArray(feishu)) {
    return null
  }

  if (accountId === 'default') {
    const appId = normalizeFeishuConfigText(feishu.appId)
    const appSecret = cloneFeishuSecretInput(feishu.appSecret)
    if (!appId || !hasFeishuSecretInput(appSecret)) return null
    return {
      name: normalizeFeishuConfigText(feishu.name),
      appId,
      appSecret,
    }
  }

  const account = feishu.accounts?.[accountId]
  if (!account || typeof account !== 'object' || Array.isArray(account)) {
    return null
  }

  const appId = normalizeFeishuConfigText(account.appId)
  const appSecret = cloneFeishuSecretInput(account.appSecret)
  if (!appId || !hasFeishuSecretInput(appSecret)) return null

  return {
    name: normalizeFeishuConfigText(account.name),
    appId,
    appSecret,
  }
}

export function mergeFeishuCreateModeBots(params: {
  currentConfig: Record<string, any> | null
  previousFeishuConfigSnapshot: Record<string, any> | null | undefined
}): {
  nextConfig: Record<string, any>
  addedBots: Array<{ accountId: string; accountName: string; appId: string }>
} {
  const currentConfig =
    params.currentConfig && typeof params.currentConfig === 'object' && !Array.isArray(params.currentConfig)
      ? cloneJsonValue(params.currentConfig)
      : {}
  const previousSnapshot = params.previousFeishuConfigSnapshot
    ? cloneJsonValue(params.previousFeishuConfigSnapshot)
    : null

  if (!previousSnapshot) {
    return {
      nextConfig: currentConfig,
      addedBots: [],
    }
  }

  const previousBots = listFeishuBots(wrapFeishuConfigSnapshot(previousSnapshot))
  const currentBots = listFeishuBots(currentConfig)
  if (previousBots.length === 0 || currentBots.length === 0) {
    return {
      nextConfig: currentConfig,
      addedBots: [],
    }
  }

  const previousAppIds = new Set(previousBots.map((bot) => bot.appId.trim().toLowerCase()))
  const incomingBots = currentBots.filter((bot) => !previousAppIds.has(bot.appId.trim().toLowerCase()))
  if (incomingBots.length === 0) {
    return {
      nextConfig: currentConfig,
      addedBots: [],
    }
  }

  let nextConfig = restoreCapturedFeishuBotConfig(currentConfig, previousSnapshot)
  const addedBots: Array<{ accountId: string; accountName: string; appId: string }> = []
  const mergedAppIds = new Set(previousAppIds)

  for (const bot of incomingBots) {
    const credentials = readFeishuBotCredentials(currentConfig, bot.accountId)
    if (!credentials) continue

    const normalizedAppId = credentials.appId.trim().toLowerCase()
    if (mergedAppIds.has(normalizedAppId)) continue

    const added = addFeishuBotConfig(nextConfig, {
      name: credentials.name || bot.name,
      appId: credentials.appId,
      appSecret: credentials.appSecret,
    })
    nextConfig = added.nextConfig
    const matchedBot = listFeishuBots(nextConfig).find((candidate) => candidate.accountId === added.accountId)
    addedBots.push({
      accountId: added.accountId,
      accountName: matchedBot?.name || credentials.name || bot.name || `机器人 ${added.accountId}`,
      appId: credentials.appId,
    })
    mergedAppIds.add(normalizedAppId)
  }

  return {
    nextConfig,
    addedBots,
  }
}

export function canFinishFeishuCreateMode(
  hasRecoveredBotConfig: boolean,
  installerExitedSuccessfully: boolean
): boolean {
  return hasRecoveredBotConfig && installerExitedSuccessfully
}

export function shouldAutoFinishFeishuCreateMode(params: {
  selectedChannelId?: string | null
  setupMode: 'create' | 'link'
  canFinish: boolean
  finishing: boolean
  finishStrategy: 'manual' | 'existing' | 'invalid-manual' | 'none'
}): boolean {
  return params.selectedChannelId === 'feishu'
    && params.setupMode === 'create'
    && params.canFinish
    && !params.finishing
    && params.finishStrategy !== 'invalid-manual'
}

function didFeishuInstallerExitSuccessfully(params: {
  installerRunning: boolean
  installerExitCode: number | null
  installerCanceled: boolean
}): boolean {
  return !params.installerRunning && !params.installerCanceled && params.installerExitCode === 0
}

function hasRecoveredFeishuCreateModeFromBots(params: {
  previousFeishuConfigSnapshot?: Record<string, any> | null
  nextBots: Array<{ appId: string }>
}): boolean {
  const nextAppIds = params.nextBots
    .map((bot) => normalizeFeishuConfigText(bot.appId).toLowerCase())
    .filter(Boolean)

  if (nextAppIds.length === 0) return false

  const previousBots = listFeishuBots(wrapFeishuConfigSnapshot(params.previousFeishuConfigSnapshot))
  if (previousBots.length === 0) return true

  const previousAppIds = new Set(previousBots.map((bot) => bot.appId.trim().toLowerCase()))
  return nextAppIds.some((appId) => !previousAppIds.has(appId))
}

export function resolveFeishuCreateModeRecoveryNotice(
  hasRecoveredBotConfig: boolean,
  installerRunning: boolean,
  installerExitedSuccessfully: boolean
): string {
  if (!hasRecoveredBotConfig) return ''
  return installerRunning
    ? '已检测到飞书机器人配置，正在等待飞书安装器完成收尾；安装器退出后会自动完成配置。'
    : installerExitedSuccessfully
      ? '已检测到飞书机器人配置，飞书安装器已完成；正在自动完成配置。'
      : '已检测到飞书机器人配置，但飞书安装器未正常完成；请先检查安装日志并重新运行新建流程。'
}

export function hasFeishuManualCredentialInput(formData: Record<string, string>): boolean {
  return Boolean(String(formData.appId || '').trim() || String(formData.appSecret || '').trim())
}

export function clearFeishuManualCredentialInput(formData: Record<string, string>): Record<string, string> {
  const { appId: _appId, appSecret: _appSecret, ...rest } = formData
  return rest
}

export function upsertFeishuManualBindingConfig(
  config: Record<string, any> | null,
  input: {
    name?: string
    appId: string
    appSecret: unknown
  }
): {
  nextConfig: Record<string, any>
  pairingTarget: { accountId: string; accountName: string } | null
} {
  const appId = normalizeChannelConnectText(input.appId)
  const normalizedAppId = appId.toLowerCase()
  const manualName = normalizeChannelConnectText(input.name)
  const existingBots = listFeishuBots(config)
  const existingBot = existingBots.find(
    (bot) => bot.appId.trim().toLowerCase() === normalizedAppId
  )

  if (!existingBot) {
    if (existingBots.length > 0) {
      const added = addFeishuBotConfig(config, {
        name: manualName || '飞书机器人',
        appId,
        appSecret: input.appSecret,
      })
      return {
        nextConfig: added.nextConfig,
        pairingTarget: {
          accountId: added.accountId,
          accountName: manualName || `机器人 ${added.accountId}`,
        },
      }
    }

    const nextConfig = applyChannelConfig(config, 'feishu', {
      appId,
      appSecret: String(input.appSecret || ''),
    })
    const matchedBot = listFeishuBots(nextConfig).find(
      (bot) => bot.appId.trim().toLowerCase() === normalizedAppId
    )
    return {
      nextConfig,
      pairingTarget: matchedBot
        ? {
            accountId: matchedBot.accountId,
            accountName: matchedBot.name,
          }
        : null,
    }
  }

  const nextConfig = hasOwnRecord(config) ? cloneJsonValue(config) : {}
  nextConfig.channels = hasOwnRecord(nextConfig.channels) ? nextConfig.channels : {}
  const feishu = hasOwnRecord(nextConfig.channels.feishu) ? nextConfig.channels.feishu : {}
  nextConfig.channels.feishu = feishu
  const accountName = manualName || existingBot.name || `机器人 ${existingBot.accountId}`

  if (existingBot.accountId === 'default') {
    nextConfig.channels.feishu = {
      ...feishu,
      enabled: true,
      name: accountName,
      appId,
      appSecret: input.appSecret,
      dmPolicy: normalizeChannelConnectText(feishu.dmPolicy) || DEFAULT_FEISHU_CHANNEL_SETTINGS.dmPolicy,
      domain: normalizeChannelConnectText(feishu.domain) || DEFAULT_FEISHU_CHANNEL_SETTINGS.domain,
      groupPolicy: normalizeChannelConnectText(feishu.groupPolicy) || DEFAULT_FEISHU_CHANNEL_SETTINGS.groupPolicy,
      streaming:
        typeof feishu.streaming === 'boolean'
          ? feishu.streaming
          : DEFAULT_FEISHU_CHANNEL_SETTINGS.streaming,
      blockStreaming:
        typeof feishu.blockStreaming === 'boolean'
          ? feishu.blockStreaming
          : DEFAULT_FEISHU_CHANNEL_SETTINGS.blockStreaming,
    }
  } else {
    const accounts = hasOwnRecord(feishu.accounts) ? feishu.accounts : {}
    const existingAccount = hasOwnRecord(accounts[existingBot.accountId])
      ? accounts[existingBot.accountId]
      : {}
    feishu.accounts = accounts
    feishu.accounts[existingBot.accountId] = {
      ...existingAccount,
      enabled: true,
      name: accountName,
      appId,
      appSecret: input.appSecret,
      dmPolicy:
        normalizeChannelConnectText(existingAccount.dmPolicy)
        || normalizeChannelConnectText(feishu.dmPolicy)
        || DEFAULT_FEISHU_CHANNEL_SETTINGS.dmPolicy,
      domain:
        normalizeChannelConnectText(existingAccount.domain)
        || normalizeChannelConnectText(feishu.domain)
        || DEFAULT_FEISHU_CHANNEL_SETTINGS.domain,
      groupPolicy:
        normalizeChannelConnectText(existingAccount.groupPolicy)
        || normalizeChannelConnectText(feishu.groupPolicy)
        || DEFAULT_FEISHU_CHANNEL_SETTINGS.groupPolicy,
      streaming:
        typeof existingAccount.streaming === 'boolean'
          ? existingAccount.streaming
          : typeof feishu.streaming === 'boolean'
            ? feishu.streaming
            : DEFAULT_FEISHU_CHANNEL_SETTINGS.streaming,
      blockStreaming:
        typeof existingAccount.blockStreaming === 'boolean'
          ? existingAccount.blockStreaming
          : typeof feishu.blockStreaming === 'boolean'
            ? feishu.blockStreaming
            : DEFAULT_FEISHU_CHANNEL_SETTINGS.blockStreaming,
    }
    feishu.enabled = true
  }

  return {
    nextConfig,
    pairingTarget: {
      accountId: existingBot.accountId,
      accountName,
    },
  }
}

export function resolveFeishuCreateModeFinishStrategy(
  existingBotCount: number,
  hasManualCredentialInput: boolean,
  manualCredentialsReady: boolean
): 'manual' | 'existing' | 'invalid-manual' | 'none' {
  if (hasManualCredentialInput) {
    return manualCredentialsReady ? 'manual' : 'invalid-manual'
  }

  if (existingBotCount > 0) {
    return 'existing'
  }

  return 'none'
}

export function shouldValidateFeishuManualCredentials(
  setupMode: 'create' | 'link',
  hasManualCredentialInput: boolean,
  manualCredentialsReady: boolean
): boolean {
  return setupMode === 'link' && hasManualCredentialInput && manualCredentialsReady
}

export type FeishuManualBindingPreparePhase =
  | 'idle'
  | 'checking'
  | 'syncing'
  | 'installing'
  | 'verifying'

interface FeishuManualBindingPluginStateLike {
  installedOnDisk: boolean
  officialPluginConfigured: boolean
  configChanged: boolean
  configAvailable?: boolean
}

export function isFeishuManualBindingReady(
  state: Pick<FeishuManualBindingPluginStateLike, 'installedOnDisk' | 'officialPluginConfigured'>
): boolean {
  return state.installedOnDisk && state.officialPluginConfigured
}

export function canPrepareFeishuManualBindingWithoutInstall(
  state: FeishuManualBindingPluginStateLike
): boolean {
  return state.configAvailable !== false && state.installedOnDisk && (state.officialPluginConfigured || state.configChanged)
}

const FEISHU_MANUAL_BINDING_OPENCLAW_HOT_RELOAD_INITIAL_SETTLE_MS = 700
const FEISHU_MANUAL_BINDING_OPENCLAW_HOT_RELOAD_POLL_POLICY = Object.freeze({
  timeoutMs: 6_000,
  initialIntervalMs: 500,
  maxIntervalMs: 1_000,
  backoffFactor: 1.25,
})

// OpenClaw 2026.4.x can hot-apply these paths without a full gateway restart.
const FEISHU_MANUAL_BINDING_OPENCLAW_HOT_RELOAD_PREFIXES = [
  'channels.feishu',
  'agents.defaults.heartbeat',
  'agents.defaults.models',
  'agents.defaults.model',
  'agents.list',
  'models',
  'cron',
  'gateway.channelHealthCheckMinutes',
  'gateway.channelStaleEventThresholdMinutes',
  'gateway.channelMaxRestartsPerHour',
]

const FEISHU_MANUAL_BINDING_OPENCLAW_NOOP_RELOAD_PREFIXES = [
  'gateway.remote',
  'gateway.reload',
  'diagnostics.stuckSessionWarnMs',
  'meta',
  'identity',
  'wizard',
  'logging',
  'agents',
  'tools',
  'bindings',
  'audio',
  'agent',
  'routing',
  'messages',
  'session',
  'talk',
  'skills',
  'secrets',
  'ui',
]

const FEISHU_MANUAL_BINDING_OPENCLAW_GATEWAY_RESTART_PREFIXES = [
  'plugins',
  'gateway',
  'discovery',
  'canvasHost',
]

function normalizeOpenClawJsonPath(jsonPath: unknown): string {
  let normalized = String(jsonPath || '').trim()
  if (normalized === '$') return ''
  if (normalized.startsWith('$.')) {
    normalized = normalized.slice(2)
  } else if (normalized.startsWith('$')) {
    normalized = normalized.slice(1).replace(/^\./, '')
  }
  return normalized
}

function isOpenClawJsonPathUnderPrefix(jsonPath: string, prefix: string): boolean {
  return jsonPath === prefix || jsonPath.startsWith(`${prefix}.`) || jsonPath.startsWith(`${prefix}[`)
}

export function isFeishuManualBindingOpenClawHotReloadPath(jsonPath: unknown): boolean {
  const normalizedPath = normalizeOpenClawJsonPath(jsonPath)
  if (!normalizedPath) return true
  if (
    FEISHU_MANUAL_BINDING_OPENCLAW_HOT_RELOAD_PREFIXES.some((prefix) =>
      isOpenClawJsonPathUnderPrefix(normalizedPath, prefix)
    )
  ) {
    return true
  }
  if (
    FEISHU_MANUAL_BINDING_OPENCLAW_NOOP_RELOAD_PREFIXES.some((prefix) =>
      isOpenClawJsonPathUnderPrefix(normalizedPath, prefix)
    )
  ) {
    return true
  }
  if (
    FEISHU_MANUAL_BINDING_OPENCLAW_GATEWAY_RESTART_PREFIXES.some((prefix) =>
      isOpenClawJsonPathUnderPrefix(normalizedPath, prefix)
    )
  ) {
    return false
  }
  return false
}

function resolveOpenClawGatewayReloadMode(
  config: Record<string, any> | null | undefined
): 'hot' | 'hybrid' | 'restart' | 'off' {
  const mode = normalizeChannelConnectText(config?.gateway?.reload?.mode).toLowerCase()
  if (mode === 'hot' || mode === 'hybrid' || mode === 'restart' || mode === 'off') return mode
  return 'hybrid'
}

export function canUseFeishuManualBindingOpenClawHotReload(params: {
  setupMode: 'create' | 'link'
  targetAccountId?: string | null
  pluginState?: FeishuManualBindingPluginStateLike | null
  gatewayWasRunning: boolean
  writeResult?: Pick<OpenClawGuardedWriteResult, 'wrote' | 'changedJsonPaths'> | null
  sanitizedConfigChanged?: boolean
  nextConfig?: Record<string, any> | null
}): boolean {
  if (params.setupMode !== 'link') return false
  if (!normalizeChannelConnectText(params.targetAccountId)) return false
  if (params.sanitizedConfigChanged) return false
  if (!params.gatewayWasRunning) return false
  if (!params.pluginState) return false
  if (params.pluginState.configAvailable === false) return false
  if (!params.pluginState.installedOnDisk || !params.pluginState.officialPluginConfigured) return false
  if (params.pluginState.configChanged) return false
  if (!params.writeResult) return false

  const reloadMode = resolveOpenClawGatewayReloadMode(params.nextConfig)
  if (reloadMode !== 'hot' && reloadMode !== 'hybrid') return false

  const changedJsonPaths = Array.isArray(params.writeResult.changedJsonPaths)
    ? params.writeResult.changedJsonPaths
    : []
  if (!params.writeResult.wrote && changedJsonPaths.length === 0) return true
  return changedJsonPaths.every(isFeishuManualBindingOpenClawHotReloadPath)
}

function findFeishuTargetRuntimeStatus(
  runtimeStatuses: Record<string, any> | null | undefined,
  accountId: string
): Record<string, any> | null {
  if (!hasOwnRecord(runtimeStatuses)) return null
  const keyedStatus = runtimeStatuses[accountId]
  if (hasOwnRecord(keyedStatus)) return keyedStatus
  for (const status of Object.values(runtimeStatuses)) {
    if (hasOwnRecord(status) && normalizeChannelConnectText(status.accountId) === accountId) {
      return status
    }
  }
  return null
}

async function waitForFeishuManualBindingOpenClawHotReload(
  api: FeishuManualBindingOpenClawHotReloadApi,
  params: {
    targetAccountId: string
  }
): Promise<{ ok: boolean; message?: string }> {
  if (!api.gatewayHealth || !api.getFeishuRuntimeStatus) {
    return {
      ok: false,
      message: '当前版本缺少网关热重载确认接口',
    }
  }

  await new Promise<void>((resolve) =>
    setTimeout(resolve, FEISHU_MANUAL_BINDING_OPENCLAW_HOT_RELOAD_INITIAL_SETTLE_MS)
  )

  const targetAccountId = normalizeChannelConnectText(params.targetAccountId)
  const result = await pollWithBackoff({
    policy: FEISHU_MANUAL_BINDING_OPENCLAW_HOT_RELOAD_POLL_POLICY,
    execute: async () => {
      const health = await api.gatewayHealth!().catch((error: unknown) => ({
        running: false,
        summary: error instanceof Error ? error.message : String(error),
      }))
      if (!health.running) {
        return {
          gatewayRunning: false,
          runtimeReady: false,
          message: getGatewayReadyFailureMessage(health, '网关暂未就绪'),
        }
      }

      const runtimeStatuses = await api.getFeishuRuntimeStatus!().catch((error: unknown) => ({
        __qclawRuntimeStatusError: error instanceof Error ? error.message : String(error),
      }))
      if (hasOwnRecord(runtimeStatuses) && normalizeChannelConnectText(runtimeStatuses.__qclawRuntimeStatusError)) {
        return {
          gatewayRunning: true,
          runtimeReady: false,
          message: normalizeChannelConnectText(runtimeStatuses.__qclawRuntimeStatusError),
        }
      }
      const targetRuntimeStatus = findFeishuTargetRuntimeStatus(runtimeStatuses, targetAccountId)
      if (!targetRuntimeStatus) {
        return {
          gatewayRunning: true,
          runtimeReady: false,
          message: '尚未确认 OpenClaw 已加载目标飞书账号运行态',
        }
      }
      if (targetRuntimeStatus.credentialsComplete === false) {
        return {
          gatewayRunning: true,
          runtimeReady: false,
          message: 'OpenClaw 已加载目标飞书账号，但凭据仍未完整',
        }
      }
      if (targetRuntimeStatus.gatewayRunning === false || targetRuntimeStatus.runtimeState === 'disabled') {
        return {
          gatewayRunning: true,
          runtimeReady: false,
          message: targetRuntimeStatus.summary || 'OpenClaw 目标飞书账号运行态尚未就绪',
        }
      }

      return {
        gatewayRunning: true,
        runtimeReady: true,
        message: '',
      }
    },
    isSuccess: (value) => value.gatewayRunning && value.runtimeReady,
  }).catch((error: unknown) => ({
    ok: false,
    attempts: 0,
    elapsedMs: 0,
    aborted: false,
    value: {
      gatewayRunning: false,
      runtimeReady: false,
      message: error instanceof Error ? error.message : String(error),
    },
  }))

  if (result.ok) return { ok: true }
  return {
    ok: false,
    message: result.value?.message || 'OpenClaw 配置热重载未在预期时间内完成',
  }
}

type FeishuAutoRecoveryTarget = 'wait' | 'heal-config' | 'recover-manual' | 'recover-create'

export function hasRecoveredFeishuCreateMode(params: {
  previousFeishuConfigSnapshot?: Record<string, any> | null
  nextConfig: Record<string, any> | null
}): boolean {
  return hasRecoveredFeishuCreateModeFromBots({
    previousFeishuConfigSnapshot: params.previousFeishuConfigSnapshot,
    nextBots: listFeishuBots(params.nextConfig),
  })
}

export function resolveFeishuAutoRecoveryTarget(params: {
  setupMode: 'create' | 'link'
  pluginState: FeishuManualBindingPluginStateLike
  nextConfig: Record<string, any> | null
  previousFeishuConfigSnapshot?: Record<string, any> | null
}): FeishuAutoRecoveryTarget {
  if (params.setupMode === 'create') {
    return hasRecoveredFeishuCreateMode({
      previousFeishuConfigSnapshot: params.previousFeishuConfigSnapshot,
      nextConfig: params.nextConfig,
    })
      ? 'recover-create'
      : 'wait'
  }

  if (isFeishuManualBindingReady(params.pluginState)) {
    return 'recover-manual'
  }

  if (canPrepareFeishuManualBindingWithoutInstall(params.pluginState) && params.pluginState.configChanged) {
    return 'heal-config'
  }

  return 'wait'
}

async function cancelBackgroundFeishuPluginInstall(): Promise<void> {
  try {
    await window.api.cancelCommandDomain('plugin-install')
  } catch {
    // Best effort only; the recovered UI state should not depend on process cancellation succeeding.
  }
}

async function stopBackgroundFeishuInstaller(): Promise<void> {
  try {
    await window.api.stopFeishuInstaller()
  } catch {
    // Best effort only; the recovered UI state should not depend on installer shutdown succeeding.
  }
}

export function resolveFeishuManualBindingPreparationCopy(
  phase: FeishuManualBindingPreparePhase
): { title: string; description: string; hint?: string } {
  if (phase === 'checking') {
    return {
      title: '正在检查飞书官方插件',
      description: '先确认当前机器上是否已经有可复用的飞书官方插件和必要配置。',
    }
  }

  if (phase === 'syncing') {
    return {
      title: '正在同步飞书插件配置',
      description: '检测到官方插件已存在，正在补齐 Qclaw 需要的配置，随后直接进入手动绑定。',
    }
  }

  if (phase === 'installing') {
    return {
      title: '正在安装飞书官方插件',
      description: '当前环境还没有飞书官方插件，正在通过 npx 下载并安装。',
      hint: '首次安装通常最慢，可能需要 1 到 3 分钟，请耐心等待。',
    }
  }

  if (phase === 'verifying') {
    return {
      title: '正在验证插件状态',
      description: '安装或同步已经完成，正在做最后一次状态确认，马上切到手动绑定表单。',
    }
  }

  return {
    title: '准备关联已有机器人',
    description: '正在初始化飞书官方插件检查流程。',
  }
}

function wrapFeishuConfigSnapshot(
  feishuConfigSnapshot: Record<string, any> | null | undefined
): Record<string, any> | null {
  if (!feishuConfigSnapshot) return null
  return {
    channels: {
      feishu: cloneJsonValue(feishuConfigSnapshot),
    },
  }
}

export function resolveFeishuPairingTarget(params: {
  setupMode: 'create' | 'link'
  finishStrategy: 'manual' | 'existing' | 'invalid-manual' | 'none'
  previousFeishuConfigSnapshot?: Record<string, any> | null
  nextConfig: Record<string, any> | null
  manualAppId?: string
  manualBotName?: string
  selectedAccountId?: string
}): { accountId: string; accountName: string } | null {
  const nextBots = listFeishuBots(params.nextConfig)
  if (nextBots.length === 0) return null

  if (params.setupMode === 'link') {
    const selected = nextBots.find((bot) => bot.accountId === params.selectedAccountId)
    return selected ? { accountId: selected.accountId, accountName: selected.name } : null
  }

  if (params.finishStrategy === 'manual') {
    const manualAppId = String(params.manualAppId || '').trim().toLowerCase()
    const matchedBot = nextBots.find((bot) => bot.appId.trim().toLowerCase() === manualAppId)
    if (matchedBot) {
      return { accountId: matchedBot.accountId, accountName: matchedBot.name }
    }
  }

  const previousBots = listFeishuBots(wrapFeishuConfigSnapshot(params.previousFeishuConfigSnapshot))
  const previousAccountIds = new Set(previousBots.map((bot) => bot.accountId))
  const previousAppIds = new Set(previousBots.map((bot) => bot.appId.trim().toLowerCase()))
  const newBots = nextBots.filter(
    (bot) => !previousAccountIds.has(bot.accountId) || !previousAppIds.has(bot.appId.trim().toLowerCase())
  )

  const preferredNewBot = newBots.find((bot) => !bot.isDefault) || newBots[0]
  if (preferredNewBot) {
    return { accountId: preferredNewBot.accountId, accountName: preferredNewBot.name }
  }

  const onlyBot = nextBots.length === 1 ? nextBots[0] : null
  if (onlyBot) {
    return { accountId: onlyBot.accountId, accountName: onlyBot.name }
  }

  const defaultBot = nextBots.find((bot) => bot.accountId === 'default') || nextBots[0]
  return defaultBot ? { accountId: defaultBot.accountId, accountName: defaultBot.name } : null
}

export async function ensureGatewayReadyForChannelConnect(
  api: ChannelConnectGatewayReadyApi,
  appendLog: (message: string) => void,
  options?: {
    channelId?: string
    acceptFailureResult?: (result: {
      stateCode?: string
      safeToRetry?: boolean
      summary?: string
      stderr?: string
      stdout?: string
    }) => boolean
  }
): Promise<{ ok: boolean; message?: string }> {
  const result = await api.reloadGatewayAfterChannelChange()
  const running = 'running' in result && result.running === true
  const summary =
    'summary' in result && typeof result.summary === 'string'
      ? result.summary
      : ''
  if (!result.ok || !running) {
    const managedChannelId = String(options?.channelId || '').trim()
    const managedChannel = managedChannelId
      ? getManagedChannelPluginByChannelId(managedChannelId)
      : null
    const skipTargetedManagedRepair = managedChannel
      ? shouldSkipTargetedManagedRepair(managedChannel.channelId)
      : false
    const stateCode =
      'stateCode' in result && typeof result.stateCode === 'string'
        ? result.stateCode
        : ''
    if (
      managedChannel
      && isRepairableChannelConnectGatewayStateCode(stateCode)
      && api.ensureGatewayRunning
      && api.getManagedChannelPluginStatus
      && (skipTargetedManagedRepair || api.repairManagedChannelPlugin)
    ) {
      if (!skipTargetedManagedRepair) {
        const repairResult = await api.repairManagedChannelPlugin!(managedChannel.channelId)
        if (repairResult.kind !== 'ok') {
          return {
            ok: false,
            message: getManagedChannelRepairFailureMessage(repairResult),
          }
        }
      }

      const ensureResult = await api.ensureGatewayRunning({ skipRuntimePrecheck: true })
      if (!ensureResult.ok || ensureResult.running !== true) {
        if (options?.acceptFailureResult?.(ensureResult)) {
          return { ok: true }
        }

        return {
          ok: false,
          message: getGatewayReadyFailureMessage(ensureResult),
        }
      }

      if (
        ensureResult.autoPortMigrated === true &&
        typeof ensureResult.effectivePort === 'number'
      ) {
        appendLog(`⚠️ 网关端口已自动切换到 ${ensureResult.effectivePort}，程序会继续使用新端口。\n\n`)
      }

      const status = await api.getManagedChannelPluginStatus(managedChannel.channelId).catch(() => null)
      if (!status || !hasVerifiedManagedPluginInstallAndRegistration(status)) {
        return {
          ok: false,
          message: status?.summary || '网关启动失败',
        }
      }

      return { ok: true }
    }

    if (options?.acceptFailureResult?.(result)) {
      return { ok: true }
    }

    return {
      ok: false,
      message: getGatewayReadyFailureMessage(result),
    }
  }

  if (
    'autoPortMigrated' in result &&
    result.autoPortMigrated === true &&
    'effectivePort' in result &&
    typeof result.effectivePort === 'number'
  ) {
    appendLog(`⚠️ 网关端口已自动切换到 ${result.effectivePort}，程序会继续使用新端口。\n\n`)
  }

  return { ok: true }
}

export function shouldAllowFeishuLinkPairingAfterGatewayFailure(params: {
  setupMode: 'create' | 'link'
  pairingTarget: { accountId?: string | null } | null
  gatewayFailure: {
    stateCode?: string
    safeToRetry?: boolean
  }
}): boolean {
  if (
    params.setupMode !== 'link' ||
    !String(params.pairingTarget?.accountId || '').trim()
  ) {
    return false
  }

  const stateCode = String(params.gatewayFailure.stateCode || '').trim()
  if (!stateCode) return false

  return (
    stateCode === 'websocket_1006' ||
    stateCode === 'gateway_not_running' ||
    stateCode === 'network_blocked' ||
    stateCode === 'unknown_runtime_failure'
  )
}

export function canFinalizeWeixinSetup(params: {
  configuredAccounts: Array<{ configured: boolean }>
}): boolean {
  return params.configuredAccounts.some((account) => account.configured)
}

export default function ChannelConnect({
  onNext,
  onBack,
  onSkip,
  setupModelContext,
  initialChannelId,
  forceShowSkip = false,
}: {
  onNext: (payload: ChannelConnectNextPayload) => void
  onBack: () => void
  onSkip: () => void
  setupModelContext: SetupModelContext | null
  initialChannelId?: string
  forceShowSkip?: boolean
}) {
  const [selectedChannelId, setSelectedChannelId] = useState<string>(initialChannelId || '')
  const [formData, setFormData] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<Status>('form')
  const [log, setLog] = useState('')
  const [error, setError] = useState('')
  const [canSkip, setCanSkip] = useState(false)
  const [showFieldErrors, setShowFieldErrors] = useState(false)
  const [bindingMode, setBindingMode] = useState<'qr' | 'manual'>('qr')
  const [feishuBots, setFeishuBots] = useState<ReturnType<typeof listFeishuBots>>([])
  const [pairingStatusByBot, setPairingStatusByBot] = useState<Record<string, { pairedCount: number; pairedUsers: string[] }>>({})
  const [feishuBotSetupMode, setFeishuBotSetupMode] = useState<'create' | 'link'>('create')
  const [feishuOfficialPluginInstalled, setFeishuOfficialPluginInstalled] = useState(false)
  const [feishuInstallerSessionId, setFeishuInstallerSessionId] = useState('')
  const [feishuInstallerRunning, setFeishuInstallerRunning] = useState(false)
  const [feishuInstallerOutput, setFeishuInstallerOutput] = useState('')
  const [feishuInstallerExitCode, setFeishuInstallerExitCode] = useState<number | null>(null)
  const [feishuInstallerCanceled, setFeishuInstallerCanceled] = useState(false)
  const [feishuInstallerBusy, setFeishuInstallerBusy] = useState(false)
  const [feishuInstallerInput, setFeishuInstallerInput] = useState('')
  const [feishuInstallerNotice, setFeishuInstallerNotice] = useState('')
  const [feishuInstallerPendingPrompt, setFeishuInstallerPendingPrompt] =
    useState<Awaited<ReturnType<typeof window.api.getFeishuInstallerState>>['pendingPrompt']>(null)
  const [showFeishuInstallTutorial, setShowFeishuInstallTutorial] = useState(false)
  const [showFeishuQrModal, setShowFeishuQrModal] = useState(false)
  const [finishingFeishuSetup, setFinishingFeishuSetup] = useState(false)
  const [refreshingFeishuState, setRefreshingFeishuState] = useState(false)
  const [preparingFeishuManualBinding, setPreparingFeishuManualBinding] = useState(false)
  const [feishuManualBindingPreparePhase, setFeishuManualBindingPreparePhase] =
    useState<FeishuManualBindingPreparePhase>('idle')
  const [weixinInstallerSessionId, setWeixinInstallerSessionId] = useState('')
  const [weixinInstallerRunning, setWeixinInstallerRunning] = useState(false)
  const [weixinInstallerOutput, setWeixinInstallerOutput] = useState('')
  const [weixinInstallerExitCode, setWeixinInstallerExitCode] = useState<number | null>(null)
  const [weixinInstallerCanceled, setWeixinInstallerCanceled] = useState(false)
  const [weixinInstallerBusy, setWeixinInstallerBusy] = useState(false)
  const [finishingWeixinSetup, setFinishingWeixinSetup] = useState(false)
  const [weixinInstallerNewAccountIds, setWeixinInstallerNewAccountIds] = useState<string[]>([])

  // WeChat Work QR binding state
  const [showQrModal, setShowQrModal] = useState(false)
  const [qrAuthUrl, setQrAuthUrl] = useState('')
  const [qrStatus, setQrStatus] = useState<'loading' | 'ready' | 'scanned' | 'error'>('loading')
  const qrTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const qrResolveRef = useRef<((result: { botId: string; secret: string } | null) => void) | null>(null)
  const feishuInstallerHandledPromptIdRef = useRef('')
  const feishuFinishInFlightRef = useRef(false)
  const feishuAutoFinishTriggerKeyRef = useRef('')
  const feishuCreateStartConfigSnapshotRef = useRef<Record<string, any> | null>(null)
  const feishuManualBindingRequestVersionRef = useRef(0)

  // Track completed phases so retry skips plugin install
  const pluginInstalledRef = useRef(false)

  const selectedChannel = getChannelDefinition(selectedChannelId)
  const channelValidation = validateChannelForm(selectedChannel, formData)
  const canConnect = !!selectedChannel && (
    (selectedChannel.useQrBinding && bindingMode === 'qr') ||
    channelValidation.ok
  )
  const feishuBotsOrdered = useMemo(
    () =>
      [...feishuBots].sort((left, right) => {
        const leftPaired = pairingStatusByBot[left.accountId]?.pairedCount || 0
        const rightPaired = pairingStatusByBot[right.accountId]?.pairedCount || 0
        if ((leftPaired > 0) !== (rightPaired > 0)) return leftPaired > 0 ? -1 : 1
        if (leftPaired !== rightPaired) return rightPaired - leftPaired
        if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1
        return left.name.localeCompare(right.name, 'zh-CN')
      }),
    [feishuBots, pairingStatusByBot]
  )
  const feishuInstallerAsciiQr = useMemo(
    () => extractFeishuAsciiQr(feishuInstallerOutput),
    [feishuInstallerOutput]
  )
  const weixinInstallerAsciiQr = useMemo(
    () => extractAsciiQrBlock(weixinInstallerOutput),
    [weixinInstallerOutput]
  )
  const feishuManualBindingPreparationCopy = useMemo(
    () => resolveFeishuManualBindingPreparationCopy(feishuManualBindingPreparePhase),
    [feishuManualBindingPreparePhase]
  )
  const feishuInstallerQrUrl = useMemo(
    () => extractFirstHttpUrl(feishuInstallerOutput) || FEISHU_OFFICIAL_GUIDE_URL,
    [feishuInstallerOutput]
  )
  const feishuInstallerHasLiveQr =
    feishuInstallerAsciiQr.length > 0 || feishuInstallerQrUrl !== FEISHU_OFFICIAL_GUIDE_URL
  const feishuManualCredentialsReady =
    selectedChannel?.id === 'feishu' &&
    feishuBotSetupMode === 'link' &&
    channelValidation.ok
  const feishuHasManualCredentialInput =
    selectedChannel?.id === 'feishu' &&
    hasFeishuManualCredentialInput(formData)
  const feishuCreateModeFinishStrategy = resolveFeishuCreateModeFinishStrategy(
    feishuBotsOrdered.length,
    Boolean(feishuHasManualCredentialInput),
    Boolean(feishuManualCredentialsReady)
  )
  const feishuCreateModeInstallerObserved =
    selectedChannel?.id === 'feishu'
    && feishuBotSetupMode === 'create'
    && (
      feishuInstallerRunning
      || Boolean(feishuInstallerSessionId)
      || feishuInstallerOutput.trim().length > 0
      || feishuInstallerExitCode !== null
      || feishuInstallerCanceled
    )
  const feishuCreateModeRecovered =
    feishuCreateModeInstallerObserved
    && feishuBotSetupMode === 'create'
    && hasRecoveredFeishuCreateModeFromBots({
      previousFeishuConfigSnapshot: feishuCreateStartConfigSnapshotRef.current,
      nextBots: feishuBotsOrdered,
    })
  const feishuCreateModeInstallerExitedSuccessfully = didFeishuInstallerExitSuccessfully({
    installerRunning: feishuInstallerRunning,
    installerExitCode: feishuInstallerExitCode,
    installerCanceled: feishuInstallerCanceled,
  })
  const feishuCreateModeCanFinish = canFinishFeishuCreateMode(
    feishuCreateModeRecovered,
    feishuCreateModeInstallerExitedSuccessfully
  )
  const feishuCreateModeRecoveryNotice =
    selectedChannel?.id === 'feishu' && feishuBotSetupMode === 'create'
      ? resolveFeishuCreateModeRecoveryNotice(
          feishuCreateModeRecovered,
          feishuInstallerRunning,
          feishuCreateModeInstallerExitedSuccessfully
        )
      : ''
  const showInlineFeishuManualError =
    status === 'form' &&
    selectedChannel?.id === 'feishu' &&
    feishuBotSetupMode === 'link' &&
    Boolean(error)
  const feishuInstallerManualInputBlocked = shouldDisableFeishuInstallerManualInput(feishuInstallerPendingPrompt)

  const applyFeishuInstallerSnapshot = useCallback(
    (snapshot: Awaited<ReturnType<typeof window.api.getFeishuInstallerState>>) => {
      setFeishuInstallerSessionId(snapshot.sessionId || '')
      setFeishuInstallerRunning(snapshot.active)
      setFeishuInstallerOutput(snapshot.output || '')
      setFeishuInstallerExitCode(snapshot.code ?? null)
      setFeishuInstallerCanceled(Boolean(snapshot.canceled))
      setFeishuInstallerPendingPrompt(snapshot.pendingPrompt || null)
    },
    []
  )

  const applyWeixinInstallerSnapshot = useCallback(
    (snapshot: Awaited<ReturnType<typeof window.api.getWeixinInstallerState>>) => {
      setWeixinInstallerSessionId(snapshot.sessionId || '')
      setWeixinInstallerRunning(snapshot.active)
      setWeixinInstallerOutput(snapshot.output || '')
      setWeixinInstallerExitCode(snapshot.code ?? null)
      setWeixinInstallerCanceled(Boolean(snapshot.canceled))
      setWeixinInstallerNewAccountIds(snapshot.newAccountIds || [])
    },
    []
  )

  const invalidateFeishuManualBindingRequest = useCallback(() => {
    feishuManualBindingRequestVersionRef.current += 1
  }, [])

  const loadFeishuSetupState = useCallback(async (options?: { syncConfig?: boolean }) => {
    let pluginState = await window.api.getFeishuOfficialPluginState()
    if (options?.syncConfig && pluginState.configChanged && pluginState.configAvailable !== false) {
      try {
        await writeConfigDirect(pluginState.normalizedConfig, 'channel-connect-feishu-sync-config')
        pluginState = await window.api.getFeishuOfficialPluginState()
      } catch {
        // Keep using the normalized in-memory state even if self-healing writes fail.
      }
    }

    const normalizedConfig = pluginState.normalizedConfig
    const bots = listFeishuBots(normalizedConfig)
    setFeishuOfficialPluginInstalled(pluginState.installedOnDisk)
    setFeishuBots(bots)

    if (bots.length === 0) {
      setPairingStatusByBot({})
      setCanSkip(false)
      return { pluginState, bots }
    }

    const pairingStatus = await window.api.pairingFeishuStatus(bots.map((bot) => bot.accountId)).catch(() => null)
    if (!pairingStatus) {
      setPairingStatusByBot({})
      setCanSkip(false)
      return { pluginState, bots }
    }

    setPairingStatusByBot(pairingStatus)
    setCanSkip(shouldShowSkipButtonForFeishuPairing(pairingStatus))
    return { pluginState, bots }
  }, [])

  const refreshFeishuBotsFromConfig = useCallback(async () => {
    return loadFeishuSetupState({ syncConfig: true })
  }, [loadFeishuSetupState])

  useEffect(() => {
    if (!feishuCreateModeRecoveryNotice) return
    setFeishuInstallerNotice((current) =>
      current === feishuCreateModeRecoveryNotice ? current : feishuCreateModeRecoveryNotice
    )
  }, [feishuCreateModeRecoveryNotice])

  useEffect(() => {
    if (feishuInstallerAsciiQr.length > 0) {
      setShowFeishuQrModal(true)
    }
  }, [feishuInstallerAsciiQr])

  const refreshFeishuSetupState = useCallback(
    async (options?: {
      userInitiated?: boolean
      recoverManualBindingIfReady?: boolean
    }) => {
      setRefreshingFeishuState(true)
      try {
        const [setupState, installerSnapshot] = await Promise.all([
          loadFeishuSetupState({ syncConfig: true }),
          window.api.getFeishuInstallerState().catch(() => null),
        ])

        if (installerSnapshot) {
          applyFeishuInstallerSnapshot(installerSnapshot)
        }

        if (
          options?.recoverManualBindingIfReady &&
          isFeishuManualBindingReady(setupState.pluginState)
        ) {
          invalidateFeishuManualBindingRequest()
          setPreparingFeishuManualBinding(false)
          setFeishuManualBindingPreparePhase('idle')
          setFeishuBotSetupMode('link')
          setError('')
          setShowFieldErrors(false)
          setFeishuInstallerNotice(
            '已刷新到最新状态，飞书官方插件已经可用，现在可以手动绑定已有机器人。'
          )
          void cancelBackgroundFeishuPluginInstall()
          return true
        }

        const recoveryTarget = resolveFeishuAutoRecoveryTarget({
          setupMode: feishuBotSetupMode,
          pluginState: setupState.pluginState,
          nextConfig: setupState.pluginState.normalizedConfig,
          previousFeishuConfigSnapshot: feishuCreateStartConfigSnapshotRef.current,
        })

        if (options?.userInitiated) {
          if (recoveryTarget === 'recover-create') {
            setFeishuInstallerNotice(
              resolveFeishuCreateModeRecoveryNotice(
                true,
                Boolean(installerSnapshot?.active),
                !installerSnapshot?.active
                  && !Boolean(installerSnapshot?.canceled)
                  && installerSnapshot?.code === 0
              )
            )
          } else if (setupState.pluginState.installedOnDisk) {
            setFeishuInstallerNotice(
              '已检测到飞书官方插件已经落盘；如果页面还没自动切换，可以继续点击“刷新状态”重新确认。'
            )
          } else {
            setFeishuInstallerNotice('已刷新当前状态，飞书官方插件仍在安装中，请稍后再试。')
          }
        }

        return false
      } catch (e: any) {
        if (options?.userInitiated) {
          setError(toUserFacingUnknownErrorMessage(e, '刷新飞书安装状态失败'))
        }
        return false
      } finally {
        setRefreshingFeishuState(false)
      }
    },
    [
      applyFeishuInstallerSnapshot,
      feishuBotSetupMode,
      invalidateFeishuManualBindingRequest,
      loadFeishuSetupState,
    ]
  )

  useEffect(() => {
    if (selectedChannel?.id !== 'feishu') return

    const shouldPollManualRecovery = preparingFeishuManualBinding
    const shouldPollCreateRecovery = feishuInstallerRunning && feishuBotSetupMode === 'create'
    if (!shouldPollManualRecovery && !shouldPollCreateRecovery) return

    const setupMode: 'create' | 'link' = shouldPollManualRecovery ? 'link' : 'create'
    const manualBindingRequestVersion = feishuManualBindingRequestVersionRef.current
    let disposed = false

    const pollRecoveryState = async () => {
      const result = await pollWithBackoff({
        policy: UI_RUNTIME_DEFAULTS.feishuSetupRecovery.poll,
        shouldAbort: () => disposed,
        execute: async () => {
          const installerSnapshot = await window.api.getFeishuInstallerState().catch(() => null)
          if (installerSnapshot && !disposed) {
            applyFeishuInstallerSnapshot(installerSnapshot)
          }

          let setupState = await loadFeishuSetupState({ syncConfig: false })
          let recoveryTarget = resolveFeishuAutoRecoveryTarget({
            setupMode,
            pluginState: setupState.pluginState,
            nextConfig: setupState.pluginState.normalizedConfig,
            previousFeishuConfigSnapshot: feishuCreateStartConfigSnapshotRef.current,
          })

          if (recoveryTarget === 'heal-config') {
            try {
              await writeConfigDirect(
                setupState.pluginState.normalizedConfig,
                'channel-connect-feishu-auto-recovery-heal'
              )
              if (disposed) {
                return {
                  setupState,
                  recoveryTarget: 'wait' as const,
                }
              }
              setupState = await loadFeishuSetupState({ syncConfig: false })
              recoveryTarget = resolveFeishuAutoRecoveryTarget({
                setupMode,
                pluginState: setupState.pluginState,
                nextConfig: setupState.pluginState.normalizedConfig,
                previousFeishuConfigSnapshot: feishuCreateStartConfigSnapshotRef.current,
              })
            } catch {
              recoveryTarget = 'wait'
            }
          }

          return {
            setupState,
            recoveryTarget,
          }
        },
        isSuccess: (value) =>
          value.recoveryTarget === 'recover-manual' || value.recoveryTarget === 'recover-create',
      })

      if (!result.ok || !result.value || disposed) return

      if (result.value.recoveryTarget === 'recover-manual') {
        if (feishuManualBindingRequestVersionRef.current !== manualBindingRequestVersion) return
        invalidateFeishuManualBindingRequest()
        setPreparingFeishuManualBinding(false)
        setFeishuManualBindingPreparePhase('idle')
        setFeishuBotSetupMode('link')
        setError('')
        setShowFieldErrors(false)
        setFeishuInstallerNotice('已自动检测到飞书官方插件就绪，现在可以手动绑定已有机器人。')
        void cancelBackgroundFeishuPluginInstall()
        return
      }

      if (result.value.recoveryTarget === 'recover-create') {
        setFeishuInstallerNotice(
          resolveFeishuCreateModeRecoveryNotice(true, true, false)
        )
      }
    }

    void pollRecoveryState().catch(() => {
      // Best effort only; manual refresh and installer exit still provide fallback recovery.
    })

    return () => {
      disposed = true
    }
  }, [
    applyFeishuInstallerSnapshot,
    feishuBotSetupMode,
    feishuInstallerRunning,
    invalidateFeishuManualBindingRequest,
    loadFeishuSetupState,
    preparingFeishuManualBinding,
    selectedChannel?.id,
  ])

  useEffect(() => {
    let disposed = false

    const detectSkipAvailability = async () => {
      try {
        await refreshFeishuBotsFromConfig()
      } catch {
        if (!disposed) setCanSkip(false)
      }
    }

    void detectSkipAvailability()

    return () => {
      disposed = true
    }
  }, [refreshFeishuBotsFromConfig])

  useEffect(() => {
    const unsubscribe = window.api.onFeishuInstallerEvent((payload) => {
      if (payload.type === 'started') {
        feishuAutoFinishTriggerKeyRef.current = ''
        setFeishuInstallerSessionId(payload.sessionId || '')
        setFeishuInstallerRunning(true)
        setFeishuInstallerExitCode(null)
        setFeishuInstallerCanceled(false)
        setFeishuInstallerPendingPrompt(payload.pendingPrompt || null)
        return
      }

      if (payload.type === 'output') {
        setFeishuInstallerOutput((current) => current + String(payload.chunk || ''))
        return
      }

      if (payload.type === 'prompt') {
        setFeishuInstallerPendingPrompt(payload.pendingPrompt || null)
        return
      }

      if (payload.type === 'exit') {
        setFeishuInstallerRunning(false)
        setFeishuInstallerExitCode(payload.code ?? null)
        setFeishuInstallerCanceled(Boolean(payload.canceled))
        setFeishuInstallerPendingPrompt(null)
        void refreshFeishuBotsFromConfig().catch(() => {
          // Ignore refresh failures after installer exit.
        })
      }
    })

    return unsubscribe
  }, [refreshFeishuBotsFromConfig])

  useEffect(() => {
    if (selectedChannel?.id !== 'feishu') return

    window.api
      .getFeishuInstallerState()
      .then((snapshot) => {
        applyFeishuInstallerSnapshot(snapshot)
      })
      .catch(() => {
        // Ignore preload failures.
      })
    void refreshFeishuBotsFromConfig().catch(() => {
      // Ignore refresh failures here.
    })
  }, [applyFeishuInstallerSnapshot, refreshFeishuBotsFromConfig, selectedChannel?.id])

  useEffect(() => {
    if (selectedChannel?.id !== 'feishu') return
    if (!isFeishuCreateBotConfirmationPrompt(feishuInstallerPendingPrompt)) {
      feishuInstallerHandledPromptIdRef.current = ''
      return
    }

    const promptId = feishuInstallerPendingPrompt.promptId
    if (!promptId || feishuInstallerHandledPromptIdRef.current === promptId) return

    const sessionId = String(feishuInstallerSessionId || '').trim()
    if (!sessionId) return

    feishuInstallerHandledPromptIdRef.current = promptId
    const confirmed = window.confirm(buildFeishuCreateBotConfirmationMessage(feishuInstallerPendingPrompt))

    void window.api.answerFeishuInstallerPrompt(
      sessionId,
      promptId,
      confirmed ? 'confirm' : 'cancel'
    ).then((result) => {
      if (!result.ok) {
        feishuInstallerHandledPromptIdRef.current = ''
        setError(
          toUserFacingCliFailureMessage({
            stderr: result.message,
            fallback: confirmed ? '继续新建机器人失败' : '取消新建机器人失败',
          })
        )
        return
      }

      setFeishuInstallerPendingPrompt(null)
      setFeishuInstallerNotice(
        confirmed
          ? '已确认新建机器人，Qclaw 正在继续官方安装器流程。'
          : '已取消新建机器人；如果你想复用已有机器人，请改走“关联已有机器人”流程。'
      )
      setError('')
    }).catch((e: any) => {
      feishuInstallerHandledPromptIdRef.current = ''
      setError(toUserFacingUnknownErrorMessage(e, confirmed ? '继续新建机器人失败' : '取消新建机器人失败'))
    })
  }, [feishuInstallerPendingPrompt, feishuInstallerSessionId, selectedChannel?.id])

  const handleChannelChange = (channelId: string) => {
    if (
      selectedChannel?.id === 'feishu'
      && channelId !== 'feishu'
      && isFeishuCreateBotConfirmationPrompt(feishuInstallerPendingPrompt)
    ) {
      void window.api.stopFeishuInstaller().catch(() => {
        // Best effort only; the next visit will refresh installer state again.
      })
    }

    invalidateFeishuManualBindingRequest()
    setSelectedChannelId(channelId)
    setFormData({})
    setStatus('form')
    setLog('')
    setError('')
    setShowFieldErrors(false)
    setBindingMode('qr')
    setFeishuBotSetupMode('create')
    setFeishuInstallerNotice('')
    setFeishuInstallerInput('')
    setFeishuInstallerPendingPrompt(null)
    setPreparingFeishuManualBinding(false)
    feishuInstallerHandledPromptIdRef.current = ''
    feishuAutoFinishTriggerKeyRef.current = ''
    setWeixinInstallerSessionId('')
    setWeixinInstallerRunning(false)
    setWeixinInstallerOutput('')
    setWeixinInstallerExitCode(null)
    setWeixinInstallerCanceled(false)
    setWeixinInstallerBusy(false)
    setFinishingWeixinSetup(false)
    setWeixinInstallerNewAccountIds([])
    pluginInstalledRef.current = false
  }

  const handleFieldChange = (key: string, value: string) => {
    setFormData(prev => ({ ...prev, [key]: value }))
  }

  const sendFeishuInstallerInput = async (input: string) => {
    const sessionId = String(feishuInstallerSessionId || '').trim()
    if (!sessionId) {
      setError('飞书官方安装器尚未启动。')
      return false
    }

    const result = await window.api.sendFeishuInstallerInput(sessionId, input)
    if (!result.ok) {
      setError(
        toUserFacingCliFailureMessage({
          stderr: result.message,
          fallback: '写入飞书官方安装器失败',
        })
      )
      return false
    }

    setError('')
    return true
  }

  const startFeishuInstallerFlow = async (mode: 'create' | 'link') => {
    invalidateFeishuManualBindingRequest()
    feishuAutoFinishTriggerKeyRef.current = ''
    setFeishuBotSetupMode(mode)
    if (mode === 'create') {
      setFormData(clearFeishuManualCredentialInput)
    }
    setFeishuInstallerBusy(true)
    setError('')
    setFeishuInstallerNotice('')
    try {
      if (mode === 'create') {
        const config = sanitizeFeishuPluginConfig(await window.api.readConfig())
        feishuCreateStartConfigSnapshotRef.current = captureFeishuBotConfigSnapshot(config)
      } else {
        feishuCreateStartConfigSnapshotRef.current = null
      }

      const current = await window.api.getFeishuInstallerState()
      if (current.active) {
        applyFeishuInstallerSnapshot(current)
        return
      }

      const snapshot = await window.api.startFeishuInstaller()
      applyFeishuInstallerSnapshot(snapshot)
      if (!snapshot.sessionId || !snapshot.active) {
        throw new Error(snapshot.output || '飞书官方安装器启动失败')
      }
    } catch (e: any) {
      setError(toUserFacingUnknownErrorMessage(e, '启动飞书官方安装器失败'))
    } finally {
      setFeishuInstallerBusy(false)
    }
  }

  const stopFeishuInstallerFlow = async () => {
    setFeishuInstallerBusy(true)
    try {
      await window.api.stopFeishuInstaller()
    } finally {
      setFeishuInstallerBusy(false)
    }
  }

  const startWeixinInstallerFlow = async () => {
    setWeixinInstallerBusy(true)
    setError('')
    try {
      const current = await window.api.getWeixinInstallerState()
      if (current.active) {
        applyWeixinInstallerSnapshot(current)
        return
      }

      await resolveManagedPluginInstallPreflight(window.api, {
        channel: getChannelDefinition('openclaw-weixin'),
        pluginConfigured: false,
      })

      const snapshot = await window.api.startWeixinInstaller()
      applyWeixinInstallerSnapshot(snapshot)
      if (!snapshot.sessionId || !snapshot.active) {
        throw new Error(snapshot.output || '个人微信安装器启动失败')
      }
    } catch (e: any) {
      setError(toUserFacingUnknownErrorMessage(e, '启动个人微信安装器失败'))
    } finally {
      setWeixinInstallerBusy(false)
    }
  }

  const stopWeixinInstallerFlow = async () => {
    setWeixinInstallerBusy(true)
    setError('')
    try {
      const result = await window.api.stopWeixinInstaller()
      if (!result.ok) {
        setError('终止个人微信安装器失败，请稍后重试。')
        return
      }
      setWeixinInstallerOutput((current) =>
        current.trimEnd()
          ? `${current.replace(/\s*$/, '')}\n\n[Qclaw] 已请求终止个人微信安装器，正在停止...\n`
          : '[Qclaw] 已请求终止个人微信安装器，正在停止...\n'
      )
    } finally {
      setWeixinInstallerBusy(false)
    }
  }

  const finishWeixinChannelConnect = useCallback(async (newAccountIdsInput?: string[]) => {
    setFinishingWeixinSetup(true)
    setError('')

    try {
      const existingConfig = await window.api.readConfig()
      const sanitizedConfig = stripLegacyOpenClawRootKeys(existingConfig)
      if (JSON.stringify(existingConfig || {}) !== JSON.stringify(sanitizedConfig)) {
        await writeConfigDirect(sanitizedConfig, 'channel-connect-sanitize')
      }

      const config = (await window.api.readConfig()) || {}
      const enabledConfig = applyChannelConfig(config, 'openclaw-weixin', {})
      const weixinAccounts = await window.api.listWeixinAccounts()
      const configuredAccounts = weixinAccounts.filter((account) => account.configured)
      if (!canFinalizeWeixinSetup({ configuredAccounts })) {
        throw new Error('个人微信登录结果未写入本地账号状态，请重新扫码后重试。')
      }

      const nextConfig = syncWeixinChannelAccounts(
        enabledConfig,
        configuredAccounts.map((account) => ({
          accountId: account.accountId,
          name: account.name || account.accountId,
          enabled: account.enabled,
        }))
      )
      await writeConfigDirect(nextConfig)

      const gatewayReady = await ensureGatewayReadyForChannelConnect(window.api, () => {
        // Keep the wizard focused; errors are surfaced below the form.
      }, { channelId: 'openclaw-weixin' })
      if (!gatewayReady.ok) {
        throw new Error(
          toUserFacingCliFailureMessage({
            stderr: gatewayReady.message,
            fallback: '网关启动失败',
          })
        )
      }

      const successAccountId =
        String(newAccountIdsInput?.[0] || '').trim()
        || (
          configuredAccounts.length === 1
            ? String(configuredAccounts[0]?.name || configuredAccounts[0]?.accountId || '').trim()
            : ''
        )
      notifications.show({
        color: 'teal',
        title: '个人微信接入成功',
        message: successAccountId
          ? `扫码登录已完成，账号「${successAccountId}」已同步到控制面板。`
          : '扫码登录已完成，账号已同步到控制面板。',
      })

      onNext({
        channelId: 'openclaw-weixin',
        skipPairing: true,
      })
    } catch (e: any) {
      setError(toUserFacingUnknownErrorMessage(e, '个人微信配置完成收尾失败'))
    } finally {
      setFinishingWeixinSetup(false)
    }
  }, [onNext])

  const prepareFeishuManualBinding = async () => {
    const requestVersion = feishuManualBindingRequestVersionRef.current + 1
    feishuManualBindingRequestVersionRef.current = requestVersion

    setPreparingFeishuManualBinding(true)
    setFeishuManualBindingPreparePhase('checking')
    setError('')
    setShowFieldErrors(false)
    setFeishuInstallerNotice('')

    try {
      const initialState = await window.api.getFeishuOfficialPluginState()
      if (feishuManualBindingRequestVersionRef.current !== requestVersion) return

      if (canPrepareFeishuManualBindingWithoutInstall(initialState)) {
        let readyState = initialState
        if (initialState.configChanged) {
          setFeishuManualBindingPreparePhase('syncing')
          await writeConfigDirect(
            initialState.normalizedConfig,
            'channel-connect-feishu-manual-binding-sync'
          )
          if (feishuManualBindingRequestVersionRef.current !== requestVersion) return
          readyState = await window.api.getFeishuOfficialPluginState()
          if (feishuManualBindingRequestVersionRef.current !== requestVersion) return
        }

        if (isFeishuManualBindingReady(readyState)) {
          setFeishuManualBindingPreparePhase('verifying')
          setFeishuBotSetupMode('link')
          setFeishuInstallerNotice(
            initialState.configChanged
              ? '已同步飞书官方插件配置，现在可以手动绑定已有机器人。'
              : '已确认飞书官方插件可用，现在可以手动绑定已有机器人。'
          )
          void refreshFeishuBotsFromConfig().catch(() => {
            // Keep the manual binding form available even if background refresh fails.
          })
          return
        }
      }

      setFeishuManualBindingPreparePhase('installing')
      const ensureResult = await window.api.ensureFeishuOfficialPluginReady()
      if (feishuManualBindingRequestVersionRef.current !== requestVersion) return
      if (!ensureResult.ok || !ensureResult.state.installedOnDisk) {
        throw new Error(
          ensureResult.message ||
            toUserFacingCliFailureMessage({
              stderr: ensureResult.stderr,
              stdout: ensureResult.stdout,
              fallback: '飞书官方插件尚未就绪',
            })
        )
      }

      setFeishuManualBindingPreparePhase('verifying')
      setFeishuBotSetupMode('link')
      setFeishuInstallerNotice(
        ensureResult.installedThisRun
          ? '已自动补装飞书官方插件，现在可以手动绑定已有机器人。'
          : '已确认飞书官方插件可用，现在可以手动绑定已有机器人。'
      )
      void refreshFeishuBotsFromConfig().catch(() => {
        // Keep the manual binding form available even if background refresh fails.
      })
    } catch (e: any) {
      if (feishuManualBindingRequestVersionRef.current !== requestVersion) return
      setError(toUserFacingUnknownErrorMessage(e, '准备关联已有机器人失败'))
    } finally {
      if (feishuManualBindingRequestVersionRef.current === requestVersion) {
        setFeishuManualBindingPreparePhase('idle')
        setPreparingFeishuManualBinding(false)
      }
    }
  }

  const finishFeishuChannelConnect = useCallback(async () => {
    if (feishuFinishInFlightRef.current) return
    feishuFinishInFlightRef.current = true
    setFinishingFeishuSetup(true)
    setError('')

    try {
      if (feishuBotSetupMode === 'link') {
        await stopBackgroundFeishuInstaller()
      } else if (feishuInstallerRunning) {
        throw new Error('飞书安装器仍在运行，请等待安装器退出后再继续完成配置。')
      } else if (!feishuCreateModeCanFinish) {
        throw new Error('飞书安装器尚未正常完成，请检查安装日志并重新运行新建流程。')
      }

      const existingConfig = await window.api.readConfig()
      const sanitizedConfig = stripLegacyOpenClawRootKeys(existingConfig)
      const preservedFeishuConfig = captureFeishuBotConfigSnapshot(sanitizedConfig)
      let sanitizedConfigChanged = false
      if (JSON.stringify(existingConfig || {}) !== JSON.stringify(sanitizedConfig)) {
        const sanitizeWriteResult = await writeConfigDirect(sanitizedConfig, 'channel-connect-sanitize')
        sanitizedConfigChanged = sanitizeWriteResult.wrote
      }

      const config = sanitizeFeishuPluginConfig(await window.api.readConfig())
      let nextConfig = config
      let pairingTarget: { accountId: string; accountName: string } | null = null
      let manualBindingHotReloadPreflight: {
        pluginState: FeishuManualBindingPluginStateLike | null
        gatewayWasRunning: boolean
      } | null = null

      if (feishuBotSetupMode === 'link') {
        if (!shouldValidateFeishuManualCredentials(feishuBotSetupMode, hasFeishuManualCredentialInput(formData), channelValidation.ok)) {
          setShowFieldErrors(true)
          throw new Error('手动绑定信息未填写完整，请补全 App ID 和 App Secret 后再继续。')
        }

        const credentialCheck = await window.api.validateFeishuCredentials(
          channelValidation.values.appId,
          channelValidation.values.appSecret,
          config?.channels?.feishu?.domain
        )
        if (!credentialCheck.ok) {
          throw new Error(
            toUserFacingCliFailureMessage({
              stderr: credentialCheck.stderr,
              stdout: credentialCheck.stdout,
              fallback: '飞书 App ID / App Secret 校验失败，请检查后重试。',
            })
          )
        }

        const [pluginStateBeforeWrite, gatewayHealthBeforeWrite] = await Promise.all([
          window.api.getFeishuOfficialPluginState().catch(() => null),
          window.api.gatewayHealth().catch(() => null),
        ])
        manualBindingHotReloadPreflight = {
          pluginState: pluginStateBeforeWrite,
          gatewayWasRunning: gatewayHealthBeforeWrite?.running === true,
        }

        const manualBindingConfig = upsertFeishuManualBindingConfig(config, {
          name: formData.name,
          appId: channelValidation.values.appId,
          appSecret: channelValidation.values.appSecret,
        })
        nextConfig = manualBindingConfig.nextConfig
        pairingTarget = manualBindingConfig.pairingTarget

        if (feishuInstallerRunning) {
          await window.api.stopFeishuInstaller().catch(() => {
            // Manual binding can continue even if the installer process has already exited.
          })
        }
      } else {
        const mergedCreateResult = mergeFeishuCreateModeBots({
          currentConfig: config,
          previousFeishuConfigSnapshot: feishuCreateStartConfigSnapshotRef.current,
        })
        nextConfig = mergedCreateResult.nextConfig
        if (mergedCreateResult.addedBots.length > 0) {
          pairingTarget = {
            accountId: mergedCreateResult.addedBots[0].accountId,
            accountName: mergedCreateResult.addedBots[0].accountName,
          }
        }

        if (listFeishuBots(nextConfig).length === 0) {
          throw new Error('请先完成飞书机器人创建后再继续。')
        }
      }

      nextConfig = reconcileFeishuOfficialPluginConfig(nextConfig)

      const configWriteResult = await writeConfigDirect(
        nextConfig,
        feishuBotSetupMode === 'create'
          ? 'channel-connect-feishu-finish-create'
          : 'channel-connect-feishu-finish-link'
      )
      await loadFeishuSetupState({ syncConfig: false })

      if (!pairingTarget && feishuBotSetupMode === 'create') {
        pairingTarget = resolveFeishuPairingTarget({
          setupMode: feishuBotSetupMode,
          finishStrategy: feishuCreateModeFinishStrategy,
          previousFeishuConfigSnapshot: preservedFeishuConfig,
          nextConfig,
          manualAppId: channelValidation.values.appId,
          manualBotName: formData.name,
        })
      }

      const ensureFeishuGatewayReady = () =>
        ensureGatewayReadyForChannelConnect(window.api, () => {
          // Keep the wizard UI focused; setup errors are surfaced directly below the form.
        }, {
          channelId: 'feishu',
          acceptFailureResult: (result) => shouldAllowFeishuLinkPairingAfterGatewayFailure({
            setupMode: feishuBotSetupMode,
            pairingTarget,
            gatewayFailure: result,
          }),
        })

      let gatewayReady: { ok: boolean; message?: string }
      if (
        canUseFeishuManualBindingOpenClawHotReload({
          setupMode: feishuBotSetupMode,
          targetAccountId: pairingTarget?.accountId,
          pluginState: manualBindingHotReloadPreflight?.pluginState,
          gatewayWasRunning: manualBindingHotReloadPreflight?.gatewayWasRunning === true,
          writeResult: configWriteResult,
          sanitizedConfigChanged,
          nextConfig,
        })
      ) {
        const hotReloadReady = await waitForFeishuManualBindingOpenClawHotReload(window.api, {
          targetAccountId: pairingTarget!.accountId,
        })
        gatewayReady = hotReloadReady.ok ? { ok: true } : await ensureFeishuGatewayReady()
      } else {
        gatewayReady = await ensureFeishuGatewayReady()
      }
      if (!gatewayReady.ok) {
        throw new Error(
          toUserFacingCliFailureMessage({
            stderr: gatewayReady.message,
            fallback: '网关启动失败',
          })
        )
      }

      await loadFeishuSetupState({ syncConfig: false })
      onNext({
        channelId: 'feishu',
        accountId: pairingTarget?.accountId,
        accountName: pairingTarget?.accountName,
        skipPairing: feishuBotSetupMode === 'create',
      })
    } catch (e: any) {
      setError(toUserFacingUnknownErrorMessage(e, '飞书配置完成收尾失败'))
    } finally {
      feishuFinishInFlightRef.current = false
      setFinishingFeishuSetup(false)
    }
  }, [
    channelValidation.ok,
    channelValidation.values.appId,
    channelValidation.values.appSecret,
    feishuBotSetupMode,
    feishuCreateModeCanFinish,
    feishuCreateModeFinishStrategy,
    feishuInstallerRunning,
    formData,
    loadFeishuSetupState,
    onNext,
  ])

  useEffect(() => {
    if (!shouldAutoFinishFeishuCreateMode({
      selectedChannelId: selectedChannel?.id,
      setupMode: feishuBotSetupMode,
      canFinish: feishuCreateModeCanFinish,
      finishing: finishingFeishuSetup,
      finishStrategy: feishuCreateModeFinishStrategy,
    })) {
      return
    }

    if (feishuFinishInFlightRef.current) return

    const autoFinishKey = [
      feishuInstallerSessionId || 'sessionless',
      String(feishuInstallerExitCode ?? 'no-exit'),
      feishuBotsOrdered.map((bot) => `${bot.accountId}:${bot.appId}`).join('|'),
    ].join('::')
    if (feishuAutoFinishTriggerKeyRef.current === autoFinishKey) return

    feishuAutoFinishTriggerKeyRef.current = autoFinishKey
    setFeishuInstallerNotice('已检测到飞书安装器完成收尾，正在自动完成配置。')
    void finishFeishuChannelConnect()
  }, [
    feishuBotSetupMode,
    feishuBotsOrdered,
    feishuCreateModeCanFinish,
    feishuCreateModeFinishStrategy,
    feishuInstallerExitCode,
    feishuInstallerSessionId,
    finishFeishuChannelConnect,
    finishingFeishuSetup,
    selectedChannel?.id,
  ])

  useEffect(() => {
    const unsubscribe = window.api.onWeixinInstallerEvent((payload) => {
      if (payload.type === 'started') {
        setWeixinInstallerSessionId(payload.sessionId || '')
        setWeixinInstallerRunning(true)
        setWeixinInstallerExitCode(null)
        setWeixinInstallerCanceled(false)
        setWeixinInstallerNewAccountIds([])
        return
      }

      if (payload.type === 'output') {
        setWeixinInstallerOutput((current) => current + String(payload.chunk || ''))
        return
      }

      if (payload.type === 'exit') {
        setWeixinInstallerRunning(false)
        setWeixinInstallerExitCode(payload.code ?? null)
        setWeixinInstallerCanceled(Boolean(payload.canceled))
        setWeixinInstallerNewAccountIds(payload.newAccountIds || [])

        if (payload.ok && !payload.canceled) {
          void finishWeixinChannelConnect(payload.newAccountIds || [])
          return
        }

        if (!payload.canceled) {
          setError('个人微信连接未完成，请重试。')
        }
      }
    })

    return unsubscribe
  }, [finishWeixinChannelConnect])

  useEffect(() => {
    if (selectedChannel?.id !== 'openclaw-weixin') return

    window.api
      .getWeixinInstallerState()
      .then((snapshot) => {
        applyWeixinInstallerSnapshot(snapshot)
      })
      .catch(() => {
        // Ignore preload failures.
      })
  }, [applyWeixinInstallerSnapshot, selectedChannel?.id])

  const cleanupQrPolling = useCallback(() => {
    if (qrTimerRef.current) {
      clearInterval(qrTimerRef.current)
      qrTimerRef.current = null
    }
  }, [])

  const handleQrClose = useCallback(() => {
    cleanupQrPolling()
    setShowQrModal(false)
    // If the modal is closed manually before scan completes, resolve with null
    if (qrResolveRef.current) {
      qrResolveRef.current(null)
      qrResolveRef.current = null
    }
  }, [cleanupQrPolling])

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      cleanupQrPolling()
    }
  }, [cleanupQrPolling])

  /**
   * Opens the WeChat Work QR modal and returns a Promise that resolves
   * with { botId, secret } on successful scan, or null if cancelled/timed out.
   */
  const startQrBinding = (): Promise<{ botId: string; secret: string } | null> => {
    return new Promise(async (resolve) => {
      qrResolveRef.current = resolve
      setQrStatus('loading')
      setQrAuthUrl('')
      setShowQrModal(true)

      const genResult = await window.api.wecomQrGenerate()
      if (!genResult.ok || !genResult.scode || !genResult.authUrl) {
        setQrStatus('error')
        resolve(null)
        qrResolveRef.current = null
        return
      }

      setQrAuthUrl(genResult.authUrl)
      setQrStatus('ready')

      const scode = genResult.scode
      let elapsed = 0
      const POLL_INTERVAL = 3000
      const TIMEOUT = 180000

      qrTimerRef.current = setInterval(async () => {
        elapsed += POLL_INTERVAL
        if (elapsed > TIMEOUT) {
          cleanupQrPolling()
          setQrStatus('error')
          resolve(null)
          qrResolveRef.current = null
          return
        }

        const checkResult = await window.api.wecomQrCheckResult(scode)
        if (checkResult.ok && checkResult.status === 'success' && checkResult.botId && checkResult.secret) {
          cleanupQrPolling()
          setQrStatus('scanned')
          setShowQrModal(false)
          resolve({ botId: checkResult.botId, secret: checkResult.secret })
          qrResolveRef.current = null
        } else if (!checkResult.ok || checkResult.status === 'error') {
          cleanupQrPolling()
          setQrStatus('error')
          resolve(null)
          qrResolveRef.current = null
        }
      }, POLL_INTERVAL)
    })
  }

  const doConnect = async () => {
    if (!selectedChannel) return
    if (selectedChannel.id === 'openclaw-weixin') {
      await startWeixinInstallerFlow()
      return
    }
    if (bindingMode === 'manual' && !channelValidation.ok) {
      setShowFieldErrors(true)
      return
    }

    if (selectedChannel.id === 'dingtalk') {
      setStatus('installing')
      setError('')
      setLog((prev) => prev + '正在检查并配置钉钉官方插件...\n')

      try {
        const result = await window.api.setupDingtalkOfficialChannel(formData)
        setLog((prev) => prev + buildDingtalkOfficialSetupLog(result))

        if (!result.ok) {
          setError(
            result.message ||
            toUserFacingCliFailureMessage({
              stderr: result.stderr,
              stdout: result.stdout,
              fallback: '钉钉配置失败',
            })
          )
          setStatus('error')
          return
        }

        pluginInstalledRef.current = true
        setLog(
          (prev) =>
            prev +
            `✅ ${selectedChannel.name} 配置完成！\n\n${buildChannelConnectCompletionCopy(selectedChannel)}\n`
        )
        setStatus('connected')
      } catch (e: any) {
        setError(toUserFacingUnknownErrorMessage(e, '钉钉配置失败'))
        setStatus('error')
      }
      return
    }

    // 先清理配置中的无效根级别 key，否则后续 openclaw 命令会校验失败
    let currentConfig = await window.api.readConfig().catch(() => null)

    try {
      const sanitizedConfig = stripLegacyOpenClawRootKeys(currentConfig)
      const existingSerialized = JSON.stringify(currentConfig || {})
      const sanitizedSerialized = JSON.stringify(sanitizedConfig)
      if (existingSerialized !== sanitizedSerialized) {
        await writeConfigPatch(currentConfig, sanitizedConfig, 'channel-connect-sanitize')
        currentConfig = sanitizedConfig
      }
    } catch {
      // 配置文件可能不存在，忽略
    }

    // 安装插件（如果需要且尚未安装）
    if (!pluginInstalledRef.current) {
      const pluginAlreadyConfigured = isChannelPluginConfigured(currentConfig, selectedChannel.id)
      let managedPluginInstallPreflight: Awaited<ReturnType<typeof resolveManagedPluginInstallPreflight>> | null = null

      try {
        managedPluginInstallPreflight = await resolveManagedPluginInstallPreflight(window.api, {
          channel: selectedChannel,
          pluginConfigured: pluginAlreadyConfigured,
        })
      } catch (e: any) {
        setError(toUserFacingUnknownErrorMessage(e, '插件兼容性预检失败，请稍后重试。'))
        setStatus('error')
        return
      }

      if (selectedChannel.plugin?.npxSpecifier) {
        // 官方插件通过 npx 安装
        setStatus('installing')
        const pluginInstalledOnDisk = managedPluginInstallPreflight?.pluginInstalledOnDisk || false
        const pluginInstallStrategy =
          managedPluginInstallPreflight?.pluginInstallStrategy ||
          resolveManagedPluginInstallStrategy({
            pluginConfigured: pluginAlreadyConfigured,
            pluginInstalledOnDisk,
            forceInstall: false,
          })

        if (pluginInstallStrategy === 'reuse-installed-plugin') {
          setLog(`检测到 ${selectedChannel.name} 官方插件已安装，跳过重装...\n`)
        } else if (pluginAlreadyConfigured) {
          setLog(`检测到 ${selectedChannel.name} 配置中已有安装记录，但磁盘插件缺失，准备重新安装...\n`)
        } else {
          setLog(`正在安装 ${selectedChannel.name} 官方插件...\n`)
        }
        try {
          if (pluginInstallStrategy === 'install-plugin') {
            const result = await window.api.installPluginNpx(
              selectedChannel.plugin.npxSpecifier,
              selectedChannel.plugin.allowId ? [selectedChannel.plugin.allowId] : undefined
            )
            if (!result.ok) {
              if (isSafeAlreadyInstalledManagedPluginInstallError(result.stderr || '')) {
                setLog(prev => prev + '✅ 官方插件已存在，跳过重装\n\n')
              } else {
                setError(
                  toUserFacingCliFailureMessage({
                    stderr: result.stderr,
                    stdout: result.stdout,
                    fallback: '插件安装失败，请检查网络与 npm 环境后重试。',
                  })
                )
                setStatus('error')
                return
              }
            } else {
              setLog(prev => prev + `✅ 官方插件已安装\n\n`)
            }
          } else {
            setLog(prev => prev + '✅ 已复用已安装插件\n\n')
          }
        } catch (e: any) {
          setError(toUserFacingUnknownErrorMessage(e, '插件安装失败，请检查网络与 npm 环境后重试。'))
          setStatus('error')
          return
        }
      } else if (selectedChannel.plugin?.packageName) {
        // 插件通过 openclaw plugins install 安装
        setStatus('installing')
        const pluginAllowId = resolveChannelPluginAllowId(selectedChannel)
        const pluginInstalledOnDisk = managedPluginInstallPreflight?.pluginInstalledOnDisk || false
        const pluginInstallStrategy =
          managedPluginInstallPreflight?.pluginInstallStrategy ||
          resolveManagedPluginInstallStrategy({
            pluginConfigured: pluginAlreadyConfigured,
            pluginInstalledOnDisk,
            forceInstall: false,
          })

        if (pluginInstallStrategy === 'reuse-installed-plugin') {
          setLog(`检测到 ${selectedChannel.name} 官方插件已安装，跳过重装...\n`)
        } else if (pluginAlreadyConfigured) {
          setLog(`检测到 ${selectedChannel.name} 配置中已有安装记录，但磁盘插件缺失，准备重新安装...\n`)
        } else {
          setLog(`正在安装插件 ${selectedChannel.plugin.packageName}...\n`)
        }
        try {
          if (pluginInstallStrategy === 'install-plugin') {
            const cleanupTargets = listPluginCleanupTargets(selectedChannel)
            if (cleanupTargets.length > 0) {
              setLog(prev => prev + `正在清理 ${selectedChannel.name} 历史插件残留...\n`)
              for (const pluginId of cleanupTargets) {
                try {
                  await window.api.uninstallPlugin(pluginId)
                } catch {
                  // 旧版插件不存在或当前 CLI 不支持卸载时，继续安装最新官方插件。
                }
              }
              setLog(prev => prev + '✅ 历史插件检查完成\n\n')
            }

            const result = await window.api.installPlugin(
              selectedChannel.plugin.packageName,
              selectedChannel.plugin.allowId ? [selectedChannel.plugin.allowId] : undefined
            )
            if (!result.ok) {
              // 如果是"已存在"错误，跳过安装继续
              if (isSafeAlreadyInstalledManagedPluginInstallError(result.stderr || '')) {
                setLog(prev => prev + `✅ 插件已存在，跳过安装\n\n`)
              } else {
                setError(
                  toUserFacingCliFailureMessage({
                    stderr: result.stderr,
                    stdout: result.stdout,
                    fallback: '插件安装失败，请检查网络与权限后重试。',
                  })
                )
                setStatus('error')
                return
              }
            } else {
              setLog(prev => prev + `✅ 插件已安装\n\n`)
            }
          } else {
            setLog(prev => prev + '✅ 已复用已安装插件\n\n')
          }
        } catch (e: any) {
          setError(toUserFacingUnknownErrorMessage(e, '插件安装失败，请检查网络与权限后重试。'))
          setStatus('error')
          return
        }
      }

      pluginInstalledRef.current = true
    } // end plugin install guard

    setStatus('starting')
    setError('')

    try {
      // 写入渠道配置
      const bindingStrategy = resolveChannelConnectBindingStrategy(selectedChannel)
      if (bindingStrategy === 'qr-binding' && bindingMode === 'qr') {
        // QR 扫码绑定（企业微信）
        setLog(prev => prev + `正在生成 ${selectedChannel.name} 扫码绑定二维码...\n`)
        const qrResult = await startQrBinding()
        if (!qrResult) {
          setError('扫码绑定已取消或超时')
          setStatus('error')
          return
        }
        setLog(prev => prev + `✅ 扫码绑定成功\n\n`)

        // 用扫码返回的 botId/secret 写入配置（复用 applyChannelConfig）
        setLog(prev => prev + `正在写入 ${selectedChannel.name} 配置...\n`)
        const config = (await window.api.readConfig()) || {}
        const nextConfig = applyChannelConfig(config, selectedChannel.id, {
          botId: qrResult.botId,
          secret: qrResult.secret,
        })
        await writeConfigDirect(nextConfig)
        setLog(prev => prev + `✅ ${selectedChannel.name} 配置已写入\n\n`)
      } else {
        // 合并写入 openclaw.json 配置文件
        setLog(prev => prev + `正在写入 ${selectedChannel.name} 配置...\n`)

        const config = (await window.api.readConfig()) || {}
        const prevFeishuAppId = config.channels?.feishu?.appId
        const nextConfig = applyChannelConfig(config, selectedChannel.id, formData)
        await writeConfigPatch(config, nextConfig)
        setLog(prev => prev + `✅ ${selectedChannel.name} 配置已写入\n\n`)

        if (
          selectedChannel.id === 'feishu' &&
          prevFeishuAppId &&
          prevFeishuAppId.trim() !== formData.appId?.trim()
        ) {
          setLog(
            prev =>
              prev +
              '⚠️ 检测到飞书 App ID 发生变化。请在飞书中确认你正在给”新应用对应的机器人”发消息，否则消息不会进入当前网关。\n\n'
          )
        }
      }

      // 启动或重启网关
      setLog(prev => prev + '正在启动网关...\n')
      const gatewayReady = await ensureGatewayReadyForChannelConnect(window.api, (message) => {
        setLog(prev => prev + message)
      }, { channelId: selectedChannel.id })
      if (!gatewayReady.ok) {
        setError(
          toUserFacingCliFailureMessage({
            stderr: gatewayReady.message,
            fallback: '网关启动失败',
          })
        )
        setStatus('error')
        return
      }

      setLog(prev => prev + '✅ 网关已启动\n')

      if (selectedChannel.id !== 'dingtalk') {
        // 飞书/企微等渠道需要等待长连接初始化。
        setLog(prev => prev + '正在建立与 IM 平台的连接...\n')
        await new Promise(resolve => setTimeout(resolve, 3000))
        setLog(prev => prev + '✅ 连接已建立\n\n')
      }

      setLog(
        prev =>
          prev +
          `✅ ${selectedChannel.name} 配置完成！\n\n${buildChannelConnectCompletionCopy(selectedChannel)}\n`
      )
      setStatus('connected')
    } catch (e: any) {
      setError(toUserFacingUnknownErrorMessage(e, '配置失败'))
      setStatus('error')
    }
  }

  return (
    <div className="w-full">
      <Title order={3} size="lg" fw={600} mb={4}>连接消息渠道</Title>

      {status === 'form' && (
        <>
          <Tabs
            value={selectedChannelId || null}
            onChange={(value) => handleChannelChange(value || '')}
          >
            <Tabs.List grow mb="md">
              {CHANNELS.map(channel => (
                <Tabs.Tab key={channel.id} value={channel.id} fz="sm">
                  <img src={channel.logo} alt={channel.name} style={{ width: 16, height: 16, display: 'inline-block', verticalAlign: 'middle', marginRight: 4 }} />
                  {channel.name}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs>

          {selectedChannel && (
            <div className="space-y-3 mb-4 p-3 app-bg-tertiary border app-border rounded-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <img src={selectedChannel.logo} alt={selectedChannel.name} className="w-5 h-5" />
                  <span className="text-sm font-medium app-text-primary">{selectedChannel.name}</span>
                </div>
                <a
                  href={selectedChannel.helpUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs app-text-success hover:app-text-success shrink-0"
                >
                  帮助 →
                </a>
              </div>

              {selectedChannel.id === 'feishu' ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant={feishuBotSetupMode === 'create' ? 'filled' : 'light'}
                      color="success"
                      size="xs"
                      onClick={() => void startFeishuInstallerFlow('create')}
                      loading={feishuInstallerBusy && feishuBotSetupMode === 'create'}
                      disabled={preparingFeishuManualBinding || finishingFeishuSetup}
                    >
                      新建机器人
                    </Button>
                    <Button
                      variant="light"
                      size="xs"
                      onClick={() => setShowFeishuInstallTutorial(true)}
                    >
                      查看教程
                    </Button>
                    <Button
                      variant={feishuBotSetupMode === 'link' ? 'filled' : 'light'}
                      color="success"
                      size="xs"
                      onClick={() => void prepareFeishuManualBinding()}
                      loading={preparingFeishuManualBinding}
                      disabled={feishuInstallerRunning || feishuInstallerBusy || finishingFeishuSetup}
                    >
                      关联已有机器人
                    </Button>
                    <Button
                      variant="subtle"
                      size="xs"
                      color="danger"
                      onClick={() => void stopFeishuInstallerFlow()}
                      disabled={!feishuInstallerRunning || feishuInstallerBusy || preparingFeishuManualBinding || finishingFeishuSetup}
                    >
                      中止安装
                    </Button>
                    <Button
                      variant="light"
                      size="xs"
                      onClick={() =>
                        void refreshFeishuSetupState({
                          userInitiated: true,
                          recoverManualBindingIfReady: preparingFeishuManualBinding,
                        })
                      }
                      loading={refreshingFeishuState}
                      disabled={finishingFeishuSetup}
                    >
                      刷新状态
                    </Button>
                  </div>

                  {preparingFeishuManualBinding ? (
                    <div className="rounded-xl border app-border bg-black/20 px-4 py-4">
                      <div className="flex items-start gap-3">
                        <Loader size="sm" color="teal" mt={2} />
                        <div className="space-y-1.5">
                          <Text size="sm" fw={600}>{feishuManualBindingPreparationCopy.title}</Text>
                          <Text size="xs" c="dimmed">
                            {feishuManualBindingPreparationCopy.description}
                          </Text>
                          {feishuManualBindingPreparationCopy.hint && (
                            <Text size="xs" c="dimmed">
                              {feishuManualBindingPreparationCopy.hint}
                            </Text>
                          )}
                          <Text size="xs" c="dimmed">
                            Qclaw 会自动轮询插件状态；如果插件其实已经装好、但页面还没切换，也可以点击上方"刷新状态"立即重试。
                          </Text>
                        </div>
                      </div>
                    </div>
                  ) : feishuBotSetupMode === 'link' ? (
                    <div className="space-y-3">
                      <Text size="xs" c="dimmed">
                        已确认飞书官方插件可用，现在可以手动填写已有机器人的 App ID / App Secret。
                      </Text>
                      <div className="rounded-xl border app-border bg-black/20 px-3 py-3">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <p className="text-xs font-medium app-text-secondary">手动绑定</p>
                          <Badge
                            size="xs"
                            variant="light"
                            color={feishuManualCredentialsReady ? 'success' : 'gray'}
                          >
                            {feishuManualCredentialsReady ? '可直接绑定' : '填写后可用'}
                          </Badge>
                        </div>
                        <p className="mb-3 text-[11px] leading-5 app-text-muted">
                          如果你已经拿到了已有飞书机器人的 App ID / App Secret，可以直接在这里输入，
                          然后点击下方“完成配置”。
                        </p>
                        <div className="space-y-2">
                          <TextInput
                            label="App ID"
                            value={formData.appId || ''}
                            onChange={(e) => handleFieldChange('appId', e.currentTarget.value)}
                            placeholder="cli_xxxxxxxxxx"
                            error={
                              showFieldErrors || (formData.appId || '').trim()
                                ? channelValidation.fieldErrors.appId
                                : undefined
                            }
                            size="xs"
                          />
                          <PasswordInput
                            label="App Secret"
                            value={formData.appSecret || ''}
                            onChange={(e) => handleFieldChange('appSecret', e.currentTarget.value)}
                            placeholder="应用密钥"
                            error={
                              showFieldErrors || (formData.appSecret || '').trim()
                                ? channelValidation.fieldErrors.appSecret
                                : undefined
                            }
                            size="xs"
                          />
                        </div>
                        {showInlineFeishuManualError && (
                          <Alert color="red" variant="light" title="手动绑定失败" mt="sm">
                            {error}
                          </Alert>
                        )}
                      </div>
                    </div>
                  ) : null}

                  {(feishuInstallerRunning || feishuInstallerOutput.trim() || feishuInstallerExitCode !== null) && (
                    <Card withBorder radius="md" padding="md" className="app-bg-secondary">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <Text size="sm" fw={600}>安装日志</Text>
                        <Badge
                          size="xs"
                          variant="light"
                          color={
                            feishuInstallerRunning
                              ? 'warning'
                              : feishuInstallerExitCode === 0
                                ? 'success'
                                : 'red'
                          }
                        >
                          {feishuInstallerRunning ? '运行中' : feishuInstallerExitCode === 0 ? '已完成' : '已退出'}
                        </Badge>
                      </div>

                      <ScrollArea.Autosize mah={220} type="auto" offsetScrollbars>
                        <pre className="rounded-lg bg-black/40 p-3 font-mono text-[11px] leading-6 text-zinc-200 whitespace-pre-wrap break-words">
                          {feishuInstallerOutput.trim() || '安装器已启动，正在等待输出...'}
                        </pre>
                      </ScrollArea.Autosize>

                      <div className="mt-3 flex items-center gap-2">
                        <TextInput
                          size="xs"
                          className="flex-1"
                          value={feishuInstallerInput}
                          onChange={(e) => setFeishuInstallerInput(e.currentTarget.value)}
                          placeholder="向官方安装器发送自定义输入，例如机器人名称或回车"
                          disabled={!feishuInstallerRunning || feishuInstallerManualInputBlocked}
                        />
                        <Button
                          variant="light"
                          size="xs"
                          onClick={() => {
                            const raw = feishuInstallerInput
                            if (!raw) return
                            void sendFeishuInstallerInput(raw.endsWith('\n') ? raw : `${raw}\n`).then((ok) => {
                              if (ok) setFeishuInstallerInput('')
                            })
                          }}
                          disabled={!feishuInstallerRunning || feishuInstallerManualInputBlocked || !feishuInstallerInput.trim()}
                        >
                          发送
                        </Button>
                      </div>
                    </Card>
                  )}

                  {feishuInstallerNotice && (
                    <Alert color="blue" variant="light" title="已跳过重复安装">
                      {feishuInstallerNotice}
                    </Alert>
                  )}
                </div>
              ) : selectedChannel.id === 'openclaw-weixin' ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="filled"
                      color="success"
                      size="xs"
                      onClick={() => void startWeixinInstallerFlow()}
                      loading={weixinInstallerBusy}
                      disabled={weixinInstallerRunning || finishingWeixinSetup}
                    >
                      开始连接
                    </Button>
                    <Button
                      variant="subtle"
                      size="xs"
                      color="danger"
                      onClick={() => void stopWeixinInstallerFlow()}
                      disabled={!weixinInstallerRunning || weixinInstallerBusy || finishingWeixinSetup}
                    >
                      中止安装
                    </Button>
                  </div>

                  {(weixinInstallerRunning || weixinInstallerOutput.trim() || weixinInstallerExitCode !== null) && (
                    <div className="space-y-3">
                      {weixinInstallerAsciiQr && (
                        <Card withBorder radius="md" padding="md" className="app-bg-secondary">
                          <div className="mb-3 flex items-center justify-between gap-3">
                            <div>
                              <Text size="sm" fw={600}>个人微信二维码</Text>
                              <Text size="xs" c="dimmed" mt={4}>
                                这里会优先展示当前可扫码的完整二维码，不需要在日志里滚动查找。
                              </Text>
                            </div>
                            <Badge size="xs" variant="light" color={weixinInstallerRunning ? 'success' : 'gray'}>
                              {weixinInstallerRunning ? '可扫码' : '最后一次二维码'}
                            </Badge>
                          </div>

                          <div className="rounded-lg bg-black px-4 py-4 overflow-auto">
                            <pre className="mx-auto w-fit whitespace-pre font-mono text-[8px] leading-[1.05] tracking-[-0.02em] text-zinc-100">
                              {weixinInstallerAsciiQr}
                            </pre>
                          </div>
                        </Card>
                      )}

                      <Card withBorder radius="md" padding="md" className="app-bg-secondary">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <Text size="sm" fw={600}>个人微信安装器输出</Text>
                          <Badge
                            size="xs"
                            variant="light"
                            color={
                              finishingWeixinSetup
                                ? 'blue'
                                : weixinInstallerRunning
                                  ? 'warning'
                                  : weixinInstallerExitCode === 0
                                    ? 'success'
                                    : weixinInstallerCanceled
                                      ? 'gray'
                                      : 'red'
                            }
                          >
                            {finishingWeixinSetup
                              ? '同步中'
                              : weixinInstallerRunning
                                ? '运行中'
                                : weixinInstallerCanceled
                                  ? '已取消'
                                  : weixinInstallerExitCode === 0
                                    ? '已完成'
                                    : '已退出'}
                          </Badge>
                        </div>

                        <ScrollArea.Autosize mah={420} type="auto" offsetScrollbars>
                          <pre className="rounded-lg bg-black/40 p-3 font-mono text-[11px] leading-5 text-zinc-200 whitespace-pre overflow-x-auto">
                            {weixinInstallerOutput.trim() || '安装器已启动，正在等待输出...'}
                          </pre>
                        </ScrollArea.Autosize>

                        {weixinInstallerNewAccountIds.length > 0 && (
                          <Text size="xs" c="dimmed" mt="sm">
                            新增账号：{weixinInstallerNewAccountIds.join(', ')}
                          </Text>
                        )}
                      </Card>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {selectedChannel.useQrBinding && selectedChannel.fields.length > 0 && (
                    <SegmentedControl
                      value={bindingMode}
                      onChange={(value) => setBindingMode(value as 'qr' | 'manual')}
                      data={[
                        { label: '扫码绑定', value: 'qr' },
                        { label: '手动配置', value: 'manual' },
                      ]}
                      size="xs"
                      fullWidth
                    />
                  )}

                  {bindingMode === 'qr' && selectedChannel.useQrBinding ? (
                    <Text size="xs" c="dimmed">
                      点击"连接"后将生成二维码，使用{selectedChannel.name}扫码完成绑定
                    </Text>
                  ) : (
                    selectedChannel.fields.map((field) => {
                      const fieldValue = formData[field.key] || ''
                      const fieldError =
                        showFieldErrors || fieldValue.trim()
                          ? channelValidation.fieldErrors[field.key]
                          : ''
                      const InputComponent = field.type === 'password' ? PasswordInput : TextInput
                      return (
                        <div key={field.key}>
                          <InputComponent
                            label={field.label}
                            value={fieldValue}
                            onChange={(e) => handleFieldChange(field.key, e.currentTarget.value)}
                            placeholder={field.placeholder}
                            error={fieldError || undefined}
                            size="sm"
                          />
                        </div>
                      )
                    })
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button
              onClick={onBack}
              variant="default"
              size="sm"
              className="flex-1"
            >
              返回
            </Button>
            {shouldShowChannelConnectSkipButton({ canSkip, forceShowSkip }) && (
              <Button
                onClick={onSkip}
                variant="default"
                size="sm"
                className="flex-1"
              >
                跳过
              </Button>
            )}
            {selectedChannel?.id === 'feishu' ? (
              <Button
                onClick={() => void finishFeishuChannelConnect()}
                disabled={
                  (
                    feishuBotSetupMode === 'link'
                      ? !feishuManualCredentialsReady
                      : !feishuCreateModeCanFinish || feishuCreateModeFinishStrategy === 'invalid-manual'
                  ) || finishingFeishuSetup
                }
                loading={finishingFeishuSetup}
                color="success"
                size="sm"
                className="flex-1"
              >
                完成配置
              </Button>
            ) : selectedChannel?.id === 'openclaw-weixin' ? (
              <Button
                onClick={() => void startWeixinInstallerFlow()}
                disabled={weixinInstallerRunning || weixinInstallerBusy || finishingWeixinSetup}
                loading={weixinInstallerBusy || finishingWeixinSetup}
                color="success"
                size="sm"
                className="flex-1"
              >
                开始连接
              </Button>
            ) : (
              <Button
                onClick={doConnect}
                disabled={!canConnect}
                color="success"
                size="sm"
                className="flex-1"
              >
                连接
              </Button>
            )}
          </div>
          {error && !showInlineFeishuManualError && (
            <Alert mt="sm" color="red" variant="light" title="操作失败">
              {error}
            </Alert>
          )}
        </>
      )}

      {(status === 'installing' || status === 'starting' || status === 'connected' || status === 'error') && (
        <>
          {/* 进度提示 */}
          {(status === 'installing' || status === 'starting') && (
            <div className="mb-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs app-text-tertiary">
                  {status === 'installing' ? '正在安装插件...' : '正在启动服务...'}
                </span>
                <span className="text-xs app-text-muted">请稍候</span>
              </div>
              {/* 动画进度条 */}
              <div className="h-1 app-bg-tertiary rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full animate-progress"
                  style={{
                    width: '30%',
                    animation: 'progress 2s ease-in-out infinite'
                  }}
                />
              </div>
              <style>{`
                @keyframes progress {
                  0% { width: 10%; margin-left: 0; }
                  50% { width: 40%; margin-left: 30%; }
                  100% { width: 10%; margin-left: 90%; }
                }
              `}</style>
            </div>
          )}

          <div className="app-bg-tertiary border app-border rounded-lg p-3 mb-4 font-mono text-xs app-text-secondary whitespace-pre-wrap max-h-40 overflow-y-auto">
            {log}
            {(status === 'installing' || status === 'starting') && (
              <span className="inline-block w-1.5 h-3.5 bg-emerald-400 animate-pulse ml-0.5" />
            )}
          </div>

          {status === 'connected' && (
            <Button
              onClick={() => onNext({ channelId: selectedChannelId })}
              color="success"
              size="sm"
              fullWidth
            >
              {selectedChannel?.skipPairing ? '完成配置' : '下一步：输入配对码'}
            </Button>
          )}

          {status === 'error' && (
            <div>
              <Text size="xs" c="danger" mb="sm">{error}</Text>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    setStatus('form')
                    setLog('')
                    setError('')
                    pluginInstalledRef.current = false
                  }}
                  variant="default"
                  size="sm"
                  className="flex-1"
                >
                  返回修改
                </Button>
                <Button
                  onClick={doConnect}
                  color="success"
                  size="sm"
                  className="flex-1"
                >
                  重试
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <FeishuInstallTutorialModal
        opened={showFeishuInstallTutorial}
        onClose={() => setShowFeishuInstallTutorial(false)}
      />

      <Modal
        opened={showFeishuQrModal && feishuInstallerAsciiQr.length > 0}
        onClose={() => setShowFeishuQrModal(false)}
        size="md"
        title={<Text fw={600}>飞书安装器二维码</Text>}
        centered
      >
        <div className="rounded-xl bg-black px-4 py-4 overflow-auto">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[11px] font-medium text-emerald-300">本次安装器生成的真实二维码</p>
            <Badge size="xs" variant="light" color="success">已刷新</Badge>
          </div>
          <pre className="whitespace-pre font-mono text-[8px] leading-[1.1] text-zinc-100">
            {feishuInstallerAsciiQr}
          </pre>
        </div>
      </Modal>

      <Modal
        opened={showQrModal}
        onClose={handleQrClose}
        size="sm"
        title={<Text fw={600}>企业微信扫码绑定</Text>}
        centered
      >
        <Stack align="center" gap="md" py="sm">
          {qrStatus === 'loading' && (
            <>
              <Loader size="sm" />
              <Text size="sm" c="dimmed">正在生成二维码...</Text>
            </>
          )}
          {qrStatus === 'ready' && qrAuthUrl && (
            <>
              <Text size="sm" c="dimmed">请使用企业微信扫描以下二维码</Text>
              <QRCodeSVG value={qrAuthUrl} size={220} />
              <Text size="xs" c="dimmed">二维码有效期 3 分钟</Text>
              <Loader size="sm" />
              <Text size="xs" c="dimmed">等待扫码中...</Text>
            </>
          )}
          {qrStatus === 'error' && (
            <Text size="sm" c="red">二维码生成失败或已超时，请关闭后重试</Text>
          )}
        </Stack>
      </Modal>
      <style>{`
        @keyframes feishuQrProgress {
          0% { width: 18%; margin-left: 0%; opacity: 0.88; }
          50% { width: 44%; margin-left: 28%; opacity: 1; }
          100% { width: 18%; margin-left: 82%; opacity: 0.88; }
        }
      `}</style>
    </div>
  )
}
