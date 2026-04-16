import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, ActionIcon, Badge, Button, Group, Modal, ScrollArea, Stack, Text, TextInput, Tooltip } from '@mantine/core'
import { IconRefresh } from '@tabler/icons-react'
import { QRCodeSVG } from 'qrcode.react'
import FeishuInstallTutorialModal from './FeishuInstallTutorialModal'
import {
  detectFeishuIsolationDrift,
  listFeishuBots,
  normalizeFeishuOfficialPluginConfig,
  reconcileFeishuOfficialPluginConfig,
  removeFeishuBotConfigForPluginState,
  sanitizeFeishuPluginConfig,
  type FeishuBotItem,
} from '../pages/feishu-bots'
import {
  captureFeishuBotConfigSnapshot,
  ensureGatewayReadyForChannelConnect,
  mergeFeishuCreateModeBots,
  mergeFeishuPairingAllowFromUsersIntoConfig,
  resolveFeishuInstallerAutoPairOpenId,
} from '../pages/ChannelConnect'
import { applyFeishuMultiBotIsolation } from '../lib/feishu-multi-bot-routing'
import {
  extractFeishuAsciiQr,
  extractFirstHttpUrl,
  FEISHU_OFFICIAL_GUIDE_URL,
  FEISHU_OFFICIAL_INSTALL_COMMAND,
} from '../lib/feishu-installer'
import {
  buildFeishuCreateBotConfirmationMessage,
  isFeishuCreateBotConfirmationPrompt,
  shouldDisableFeishuCreateInstallerButton,
  shouldDisableFeishuInstallerManualInput,
} from '../shared/feishu-installer-session'
import { resolveChannelInstallerGuardrailView } from '../lib/channel-installer-guardrail'
import type { ChannelInstallerGuardrailStatus } from '../shared/channel-installer-session'

interface FeishuBotManagerModalProps {
  opened: boolean
  onClose: () => void
}

type PairingStatusMap = Record<string, { pairedCount: number; pairedUsers: string[] }>
type FeishuRuntimeStatusState = 'online' | 'offline' | 'degraded' | 'disabled'
type FeishuManagerSessionOwnerSource = 'started-here' | 'resumed-running'
type RuntimeStatusMap = Record<
  string,
  {
    accountId: string
    agentId: string
    workspace: string
    enabled: boolean
    credentialsComplete: boolean
    gatewayRunning: boolean
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

function normalizeFeishuManagerSessionId(sessionId?: string | null): string {
  return String(sessionId || '').trim()
}

export function hasOwnedFeishuManagerCreateSession(params: {
  ownedSessionId?: string | null
  ownerSource?: FeishuManagerSessionOwnerSource | null
}): boolean {
  return normalizeFeishuManagerSessionId(params.ownedSessionId) !== '' && Boolean(params.ownerSource)
}

function isOwnedFeishuManagerCreateSession(params: {
  ownedSessionId?: string | null
  ownerSource?: FeishuManagerSessionOwnerSource | null
  sessionId?: string | null
}): boolean {
  if (!hasOwnedFeishuManagerCreateSession(params)) return false

  const ownedSessionId = normalizeFeishuManagerSessionId(params.ownedSessionId)
  const sessionId = normalizeFeishuManagerSessionId(params.sessionId)
  return ownedSessionId !== '' && ownedSessionId === sessionId
}

export function shouldRetainOwnedFeishuManagerCreateSessionWhileHidden(params: {
  setupMode: 'create' | 'link'
  ownedSessionId?: string | null
  ownerSource?: FeishuManagerSessionOwnerSource | null
  installerRunning: boolean
  installerExitCode: number | null
  installerCanceled: boolean
}): boolean {
  if (params.setupMode !== 'create') return false
  if (!hasOwnedFeishuManagerCreateSession(params)) return false
  if (params.installerRunning) return true
  return !params.installerCanceled && params.installerExitCode === 0
}

export function shouldRetainExitedOwnedFeishuManagerCreateSession(params: {
  snapshotMatchesOwnedSession: boolean
  installerRunning: boolean
  installerExitCode: number | null
  installerCanceled: boolean
}): boolean {
  return params.snapshotMatchesOwnedSession
    && !params.installerRunning
    && !params.installerCanceled
    && params.installerExitCode === 0
}

function resolveLatestFeishuInstallerAuthAppId(
  authResults: Array<{ appId?: unknown }> | null | undefined
): string {
  const results = Array.isArray(authResults) ? authResults : []
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const appId = String(results[index]?.appId || '').trim()
    if (appId) return appId
  }
  return ''
}

export default function FeishuBotManagerModal({
  opened,
  onClose,
}: FeishuBotManagerModalProps) {
  const [feishuBots, setFeishuBots] = useState<FeishuBotItem[]>([])
  const [pairingStatusByBot, setPairingStatusByBot] = useState<PairingStatusMap>({})
  const [runtimeStatusByBot, setRuntimeStatusByBot] = useState<RuntimeStatusMap>({})
  const [selectedLinkedFeishuBotId, setSelectedLinkedFeishuBotId] = useState('')
  const [feishuOfficialPluginInstalled, setFeishuOfficialPluginInstalled] = useState(false)
  const [feishuBotSetupMode, setFeishuBotSetupMode] = useState<'create' | 'link'>('create')
  const [feishuInstallerSessionId, setFeishuInstallerSessionId] = useState('')
  const [ownedFeishuCreateSessionId, setOwnedFeishuCreateSessionId] = useState('')
  const [ownedFeishuCreateSessionSource, setOwnedFeishuCreateSessionSource] =
    useState<FeishuManagerSessionOwnerSource | null>(null)
  const [feishuInstallerRunning, setFeishuInstallerRunning] = useState(false)
  const [feishuInstallerOutput, setFeishuInstallerOutput] = useState('')
  const [feishuInstallerExitCode, setFeishuInstallerExitCode] = useState<number | null>(null)
  const [feishuInstallerCanceled, setFeishuInstallerCanceled] = useState(false)
  const [feishuInstallerBusy, setFeishuInstallerBusy] = useState(false)
  const [feishuInstallerInput, setFeishuInstallerInput] = useState('')
  const [feishuInstallerNotice, setFeishuInstallerNotice] = useState('')
  const [feishuConfigNotice, setFeishuConfigNotice] = useState('')
  const [feishuInstallerGuardrail, setFeishuInstallerGuardrail] =
    useState<ChannelInstallerGuardrailStatus | null>(null)
  const [feishuInstallerPendingPrompt, setFeishuInstallerPendingPrompt] =
    useState<Awaited<ReturnType<typeof window.api.getFeishuInstallerState>>['pendingPrompt']>(null)
  const [showFeishuInstallTutorial, setShowFeishuInstallTutorial] = useState(false)
  const [botError, setBotError] = useState('')
  const [botListRefreshing, setBotListRefreshing] = useState(false)
  const [deletingBotId, setDeletingBotId] = useState('')
  const [repairingIsolation, setRepairingIsolation] = useState(false)
  const [isolationDrift, setIsolationDrift] = useState(() => detectFeishuIsolationDrift(null))

  const feishuInstallerHandledPromptIdRef = useRef('')
  const previousOpenedRef = useRef(opened)
  const feishuCreateStartConfigSnapshotRef = useRef<Record<string, any> | null>(null)
  const handledOwnedFeishuCreateSessionIdRef = useRef('')
  const finalizeFeishuCreateInFlightRef = useRef(false)

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
  const selectedLinkedFeishuBot =
    feishuBotsOrdered.find((bot) => bot.accountId === selectedLinkedFeishuBotId) || feishuBotsOrdered[0] || null
  const feishuInstallerAsciiQr = useMemo(
    () => extractFeishuAsciiQr(feishuInstallerOutput),
    [feishuInstallerOutput]
  )
  const feishuInstallerQrUrl = useMemo(
    () => extractFirstHttpUrl(feishuInstallerOutput) || FEISHU_OFFICIAL_GUIDE_URL,
    [feishuInstallerOutput]
  )
  const feishuInstallerHasLiveQr =
    feishuInstallerAsciiQr.length > 0 || feishuInstallerQrUrl !== FEISHU_OFFICIAL_GUIDE_URL
  const showOwnedFeishuCreateSessionSurface =
    feishuBotSetupMode === 'create'
    && isOwnedFeishuManagerCreateSession({
      ownedSessionId: ownedFeishuCreateSessionId,
      ownerSource: ownedFeishuCreateSessionSource,
      sessionId: feishuInstallerSessionId,
    })
  const feishuInstallerManualInputBlocked = shouldDisableFeishuInstallerManualInput(feishuInstallerPendingPrompt)
  const feishuCreateInstallerButtonDisabled = shouldDisableFeishuCreateInstallerButton({
    installerRunning: feishuInstallerRunning,
    installerBusy: feishuInstallerBusy,
  })
  const feishuGuardrailView = useMemo(
    () => resolveChannelInstallerGuardrailView(feishuInstallerGuardrail),
    [feishuInstallerGuardrail]
  )

  const applyFeishuInstallerSnapshot = useCallback(
    (snapshot: Awaited<ReturnType<typeof window.api.getFeishuInstallerState>>) => {
      setFeishuInstallerSessionId(snapshot.sessionId || '')
      setFeishuInstallerRunning(snapshot.active)
      setFeishuInstallerOutput(snapshot.output || '')
      setFeishuInstallerExitCode(snapshot.code ?? null)
      setFeishuInstallerCanceled(Boolean(snapshot.canceled))
      setFeishuInstallerPendingPrompt(snapshot.pendingPrompt || null)
      setFeishuInstallerGuardrail(snapshot.guardrail || null)
    },
    []
  )

  const clearFeishuCreateSessionOwnership = useCallback(() => {
    setOwnedFeishuCreateSessionId('')
    setOwnedFeishuCreateSessionSource(null)
  }, [])

  const rememberFeishuCreateSessionOwnership = useCallback(
    (sessionId: string | null | undefined, source: FeishuManagerSessionOwnerSource) => {
      const normalizedSessionId = normalizeFeishuManagerSessionId(sessionId)
      if (!normalizedSessionId) return
      setOwnedFeishuCreateSessionId(normalizedSessionId)
      setOwnedFeishuCreateSessionSource(source)
    },
    []
  )

  const refreshFeishuBotsFromConfig = useCallback(async () => {
    const pluginState = await window.api.getFeishuOfficialPluginState()
    const normalizedConfig = pluginState.normalizedConfig
    if (pluginState.configChanged && pluginState.configAvailable !== false) {
      setFeishuConfigNotice('检测到飞书官方插件配置需要同步。请使用“修复隔离配置”或重新运行新建机器人流程完成显式修复。')
    } else {
      setFeishuConfigNotice('')
    }

    const bots = listFeishuBots(normalizedConfig)
    const drift = detectFeishuIsolationDrift(normalizedConfig)
    setFeishuOfficialPluginInstalled(pluginState.installedOnDisk)
    setFeishuBots(bots)
    setIsolationDrift(drift)
    setSelectedLinkedFeishuBotId((current) => {
      if (current && bots.some((bot) => bot.accountId === current)) return current
      return bots[0]?.accountId || ''
    })

    if (bots.length === 0) {
      setPairingStatusByBot({})
      setRuntimeStatusByBot({})
      return
    }

    const [pairingStatus, runtimeStatus] = await Promise.all([
      window.api.pairingFeishuStatus(bots.map((bot) => bot.accountId)),
      window.api.getFeishuRuntimeStatus().catch(() => ({} as RuntimeStatusMap)),
    ])
    setPairingStatusByBot(pairingStatus)
    setRuntimeStatusByBot(runtimeStatus)
  }, [])

  const hydrateFeishuPairingAllowFromConfig = useCallback(async (config: Record<string, any>) => {
    const bots = listFeishuBots(config)
    if (bots.length === 0) return config

    const settledUsers = await Promise.allSettled(
      bots.map(async (bot) => {
        const users = await window.api.pairingAllowFromUsers('feishu', bot.accountId)
        return [bot.accountId, users] as const
      })
    )

    const pairingUsersByAccount: Record<string, Array<{ senderId: string }>> = {}
    for (const result of settledUsers) {
      if (result.status !== 'fulfilled') continue
      const [accountId, users] = result.value
      pairingUsersByAccount[accountId] = users
    }

    return mergeFeishuPairingAllowFromUsersIntoConfig(config, pairingUsersByAccount)
  }, [])

  const finalizeOwnedFeishuCreateSession = useCallback(async (sessionId: string) => {
    const normalizedSessionId = normalizeFeishuManagerSessionId(sessionId)
    if (!normalizedSessionId) return
    if (finalizeFeishuCreateInFlightRef.current) return

    finalizeFeishuCreateInFlightRef.current = true
    handledOwnedFeishuCreateSessionIdRef.current = normalizedSessionId
    setFeishuInstallerBusy(true)
    setBotError('')

    try {
      const [installerSnapshot, beforeConfig] = await Promise.all([
        window.api.getFeishuInstallerState().catch(() => null),
        window.api.readConfig(),
      ])
      if (installerSnapshot) {
        applyFeishuInstallerSnapshot(installerSnapshot)
      }

      const sanitizedConfig = sanitizeFeishuPluginConfig(beforeConfig)
      const mergedCreateResult = mergeFeishuCreateModeBots({
        currentConfig: sanitizedConfig,
        previousFeishuConfigSnapshot: feishuCreateStartConfigSnapshotRef.current,
      })
      let nextConfig = reconcileFeishuOfficialPluginConfig(mergedCreateResult.nextConfig)
      nextConfig = await hydrateFeishuPairingAllowFromConfig(nextConfig)

      const writeResult = await window.api.applyConfigPatchGuarded({
        beforeConfig: sanitizedConfig,
        afterConfig: nextConfig,
        reason: 'dashboard-add-feishu-bot',
      })
      if (!writeResult.ok) {
        throw new Error(writeResult.message || '飞书机器人创建收尾失败')
      }

      const nextBots = listFeishuBots(nextConfig)
      const latestAuthAppId = resolveLatestFeishuInstallerAuthAppId(installerSnapshot?.authResults).toLowerCase()
      const createdBot =
        mergedCreateResult.addedBots[0]
        || nextBots.find((bot) => bot.appId.trim().toLowerCase() === latestAuthAppId)
        || null

      let autoPaired = false
      if (createdBot?.appId) {
        const scannedOpenId = resolveFeishuInstallerAutoPairOpenId({
          authResults: installerSnapshot?.authResults,
          targetAppId: createdBot.appId,
        })

        if (scannedOpenId) {
          const pairResult = await window.api.pairingAddAllowFrom(
            'feishu',
            scannedOpenId,
            createdBot.accountId
          )
          autoPaired = pairResult.ok
          if (!pairResult.ok) {
            setFeishuInstallerNotice('已完成机器人创建，但自动配对失败，请在列表中继续手动配对。')
          }
        } else {
          setFeishuInstallerNotice('已完成机器人创建，但未识别到扫码账号，新机器人将显示为待配对。')
        }
      }

      const gatewayReady = await ensureGatewayReadyForChannelConnect(window.api, () => {}, {
        channelId: 'feishu',
      })
      if (!gatewayReady.ok) {
        throw new Error(gatewayReady.message || '网关启动失败')
      }

      await refreshFeishuBotsFromConfig()
      feishuCreateStartConfigSnapshotRef.current = captureFeishuBotConfigSnapshot(nextConfig)
      setFeishuInstallerNotice((current) =>
        current
        || (createdBot
          ? autoPaired
            ? `已完成 ${createdBot.accountName || createdBot.accountId} 的创建并自动配对。`
            : `已完成 ${createdBot.accountName || createdBot.accountId} 的创建。`
          : '已完成飞书机器人创建。')
      )
      clearFeishuCreateSessionOwnership()
    } catch (e: any) {
      setBotError(e?.message || '飞书机器人创建收尾失败')
    } finally {
      finalizeFeishuCreateInFlightRef.current = false
      setFeishuInstallerBusy(false)
    }
  }, [
    applyFeishuInstallerSnapshot,
    clearFeishuCreateSessionOwnership,
    hydrateFeishuPairingAllowFromConfig,
    refreshFeishuBotsFromConfig,
  ])

  const refreshBotModalState = useCallback(async () => {
    setBotListRefreshing(true)
    setBotError('')
    try {
      const snapshot = await window.api.getFeishuInstallerState()
      applyFeishuInstallerSnapshot(snapshot)
      const snapshotSessionId = normalizeFeishuManagerSessionId(snapshot.sessionId)
      const snapshotMatchesOwnedSession = isOwnedFeishuManagerCreateSession({
        ownedSessionId: ownedFeishuCreateSessionId,
        ownerSource: ownedFeishuCreateSessionSource,
        sessionId: snapshotSessionId,
      })
      if (snapshot.active && snapshotSessionId) {
        rememberFeishuCreateSessionOwnership(snapshot.sessionId, 'resumed-running')
      } else if (!shouldRetainExitedOwnedFeishuManagerCreateSession({
        snapshotMatchesOwnedSession,
        installerRunning: snapshot.active,
        installerExitCode: snapshot.code ?? null,
        installerCanceled: Boolean(snapshot.canceled),
      })) {
        clearFeishuCreateSessionOwnership()
      }
      await refreshFeishuBotsFromConfig()
    } catch (e: any) {
      setBotError(e?.message || '刷新飞书机器人列表失败')
    } finally {
      setBotListRefreshing(false)
    }
  }, [
    applyFeishuInstallerSnapshot,
    clearFeishuCreateSessionOwnership,
    ownedFeishuCreateSessionId,
    ownedFeishuCreateSessionSource,
    refreshFeishuBotsFromConfig,
    rememberFeishuCreateSessionOwnership,
  ])

  useEffect(() => {
    const unsubscribe = window.api.onFeishuInstallerEvent((payload) => {
      if (payload.type === 'started') {
        setFeishuInstallerSessionId(payload.sessionId || '')
        rememberFeishuCreateSessionOwnership(payload.sessionId, 'started-here')
        setFeishuInstallerRunning(true)
        setFeishuInstallerExitCode(null)
        setFeishuInstallerCanceled(false)
        setFeishuInstallerPendingPrompt(payload.pendingPrompt || null)
        setFeishuInstallerGuardrail(payload.guardrail || null)
        return
      }

      if (payload.type === 'output') {
        setFeishuInstallerOutput((current) => current + String(payload.chunk || ''))
        return
      }

      if (payload.type === 'prompt') {
        setFeishuInstallerPendingPrompt(payload.pendingPrompt || null)
        if (payload.guardrail) {
          setFeishuInstallerGuardrail(payload.guardrail)
        }
        return
      }

      if (payload.type === 'exit') {
        setFeishuInstallerRunning(false)
        setFeishuInstallerExitCode(payload.code ?? null)
        setFeishuInstallerCanceled(Boolean(payload.canceled))
        setFeishuInstallerPendingPrompt(null)
        setFeishuInstallerGuardrail(payload.guardrail || null)
        void refreshFeishuBotsFromConfig().catch(() => {
          // Ignore refresh failure after installer exit.
        })
      }
    })

    return unsubscribe
  }, [refreshFeishuBotsFromConfig, rememberFeishuCreateSessionOwnership])

  useEffect(() => {
    if (!opened) return
    void refreshBotModalState()
  }, [opened, refreshBotModalState])

  useEffect(() => {
    if (!opened) return
    if (feishuBotSetupMode !== 'create') return
    if (!showOwnedFeishuCreateSessionSurface) return
    if (feishuInstallerRunning) return
    if (feishuInstallerCanceled) return
    if (feishuInstallerExitCode !== 0) return

    const sessionId = normalizeFeishuManagerSessionId(feishuInstallerSessionId)
    if (!sessionId) return
    if (handledOwnedFeishuCreateSessionIdRef.current === sessionId) return

    void finalizeOwnedFeishuCreateSession(sessionId)
  }, [
    feishuBotSetupMode,
    feishuInstallerCanceled,
    feishuInstallerExitCode,
    feishuInstallerRunning,
    feishuInstallerSessionId,
    finalizeOwnedFeishuCreateSession,
    opened,
    showOwnedFeishuCreateSessionSurface,
  ])

  useEffect(() => {
    const wasOpened = previousOpenedRef.current
    previousOpenedRef.current = opened

    if (!opened) {
      if (wasOpened && isFeishuCreateBotConfirmationPrompt(feishuInstallerPendingPrompt)) {
        void window.api.stopFeishuInstaller().catch(() => {
          // Best effort only; modal reopen will re-sync installer state.
        })
      }
      setShowFeishuInstallTutorial(false)
      feishuInstallerHandledPromptIdRef.current = ''
      if (!shouldRetainOwnedFeishuManagerCreateSessionWhileHidden({
        setupMode: feishuBotSetupMode,
        ownedSessionId: ownedFeishuCreateSessionId,
        ownerSource: ownedFeishuCreateSessionSource,
        installerRunning: feishuInstallerRunning,
        installerExitCode: feishuInstallerExitCode,
        installerCanceled: feishuInstallerCanceled,
      })) {
        clearFeishuCreateSessionOwnership()
      }
    }
  }, [
    clearFeishuCreateSessionOwnership,
    feishuBotSetupMode,
    feishuInstallerCanceled,
    feishuInstallerExitCode,
    feishuInstallerPendingPrompt,
    feishuInstallerRunning,
    opened,
    ownedFeishuCreateSessionId,
    ownedFeishuCreateSessionSource,
  ])

  useEffect(() => {
    if (!opened) return
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
        setBotError(result.message || (confirmed ? '继续新建机器人失败' : '取消新建机器人失败'))
        return
      }

      setFeishuInstallerPendingPrompt(null)
      setFeishuInstallerNotice(
        confirmed
          ? '已确认新建机器人，Qclaw 正在继续官方安装器流程。'
          : '已取消新建机器人；当前安装流程已停止，你可以稍后重新发起。'
      )
      setBotError('')
    }).catch((e: any) => {
      feishuInstallerHandledPromptIdRef.current = ''
      setBotError(e?.message || (confirmed ? '继续新建机器人失败' : '取消新建机器人失败'))
    })
  }, [opened, feishuInstallerPendingPrompt, feishuInstallerSessionId])

  const sendFeishuInstallerInput = async (input: string) => {
    const sessionId = String(feishuInstallerSessionId || '').trim()
    if (!sessionId) {
      setBotError('飞书官方安装器尚未启动。')
      return false
    }

    const result = await window.api.sendFeishuInstallerInput(sessionId, input)
    if (!result.ok) {
      setBotError(result.message || '写入飞书官方安装器失败')
      return false
    }

    setBotError('')
    return true
  }

  const startFeishuInstallerFlow = async (mode: 'create' | 'link') => {
    setFeishuBotSetupMode(mode)
    if (mode !== 'create') {
      clearFeishuCreateSessionOwnership()
    }
    setFeishuInstallerBusy(true)
    setBotError('')
    setFeishuInstallerNotice('')
    setFeishuInstallerGuardrail(null)
    try {
      if (mode === 'create') {
        const config = sanitizeFeishuPluginConfig(await window.api.readConfig())
        feishuCreateStartConfigSnapshotRef.current = captureFeishuBotConfigSnapshot(config)
        handledOwnedFeishuCreateSessionIdRef.current = ''
      }

      const current = await window.api.getFeishuInstallerState()
      if (current.active) {
        applyFeishuInstallerSnapshot(current)
        if (mode === 'create') {
          rememberFeishuCreateSessionOwnership(current.sessionId, 'resumed-running')
        }
        return
      }

      const snapshot = await window.api.startFeishuInstaller()
      applyFeishuInstallerSnapshot(snapshot)
      if (mode === 'create') {
        rememberFeishuCreateSessionOwnership(snapshot.sessionId, 'started-here')
      }
      if (!snapshot.sessionId || !snapshot.active) {
        throw new Error(snapshot.output || '飞书官方安装器启动失败')
      }
    } catch (e: any) {
      setBotError(e?.message || '启动飞书官方安装器失败')
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

  const handleDeleteBot = async (bot: FeishuBotItem) => {
    setDeletingBotId(bot.accountId)
    setBotError('')
    try {
      const config = sanitizeFeishuPluginConfig(await window.api.readConfig())
      const pluginState = await window.api.getFeishuOfficialPluginState()
      const normalizedConfig = removeFeishuBotConfigForPluginState(
        config,
        bot.accountId,
        pluginState.installedOnDisk
      )
      const writeResult = await window.api.applyConfigPatchGuarded({
        beforeConfig: config,
        afterConfig: normalizedConfig,
        reason: 'dashboard-delete-feishu-bot',
      })
      if (!writeResult.ok) {
        throw new Error(writeResult.message || '删除飞书机器人配置失败')
      }
      await refreshFeishuBotsFromConfig()
    } catch (e: any) {
      setBotError(e?.message || '删除飞书机器人失败')
    } finally {
      setDeletingBotId('')
    }
  }

  const handleRepairIsolation = async () => {
    setRepairingIsolation(true)
    setBotError('')
    try {
      const config = sanitizeFeishuPluginConfig(await window.api.readConfig())
      const pluginState = await window.api.getFeishuOfficialPluginState()
      const nextConfig = applyFeishuMultiBotIsolation(config)
      const normalizedConfig = normalizeFeishuOfficialPluginConfig(
        nextConfig,
        pluginState.installedOnDisk
      )
      const writeResult = await window.api.applyConfigPatchGuarded({
        beforeConfig: config,
        afterConfig: normalizedConfig,
        reason: 'unknown',
      })
      if (!writeResult.ok) {
        throw new Error(writeResult.message || '修复飞书多机器人隔离写入失败')
      }
      await refreshFeishuBotsFromConfig()
    } catch (e: any) {
      setBotError(e?.message || '修复飞书多机器人隔离失败')
    } finally {
      setRepairingIsolation(false)
    }
  }

  const handleClose = () => {
    setBotError('')
    setFeishuInstallerNotice('')
    setFeishuConfigNotice('')
    setFeishuInstallerGuardrail(null)
    setFeishuInstallerInput('')
    onClose()
  }

  const visibleFeishuInstallerRunning = showOwnedFeishuCreateSessionSurface && feishuInstallerRunning
  const visibleFeishuInstallerExitCode = showOwnedFeishuCreateSessionSurface ? feishuInstallerExitCode : null
  const visibleFeishuInstallerCanceled = showOwnedFeishuCreateSessionSurface && feishuInstallerCanceled
  const visibleFeishuInstallerOutput = showOwnedFeishuCreateSessionSurface ? feishuInstallerOutput : ''
  const visibleFeishuInstallerAsciiQr = showOwnedFeishuCreateSessionSurface ? feishuInstallerAsciiQr : ''
  const visibleFeishuInstallerHasLiveQr = showOwnedFeishuCreateSessionSurface && feishuInstallerHasLiveQr

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      size="xl"
      title={
        <Group gap="xs">
          <Text size="sm" fw={600}>飞书机器人管理</Text>
          <Tooltip label="刷新列表" withArrow>
            <ActionIcon
              variant="subtle"
              size="sm"
              onClick={() => void refreshBotModalState()}
              loading={botListRefreshing}
              disabled={deletingBotId !== '' || repairingIsolation}
            >
              <IconRefresh size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
      }
    >
      <div className="space-y-3">
        {/* 机器人列表 */}
        <ScrollArea.Autosize mah={200}>
          <div className="space-y-1.5">
            {feishuBotsOrdered.length === 0 && (
              <Text size="xs" c="dimmed" ta="center" py="md">还没有已配置的飞书机器人</Text>
            )}

            {feishuBotsOrdered.map((bot) => {
              const pairing = pairingStatusByBot[bot.accountId]
              const pairedCount = pairing?.pairedCount || 0
              const runtime = runtimeStatusByBot[bot.accountId]
              return (
                <Group
                  key={bot.accountId}
                  justify="space-between"
                  wrap="nowrap"
                  gap="sm"
                  py={6}
                  px="xs"
                  className="border app-border rounded-lg"
                  style={{ transition: 'border-color 0.15s ease' }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--app-hover-border)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = '' }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Group gap="xs" wrap="nowrap">
                      <Text size="xs" fw={500} className="app-text-primary" lineClamp={1}>{bot.name}</Text>
                      {bot.isDefault && <Badge size="xs" variant="light" color="blue">默认</Badge>}
                      <Badge size="xs" variant="light" color={pairedCount > 0 ? 'teal' : 'yellow'}>
                        {pairedCount > 0 ? `${pairedCount} 已配对` : '待配对'}
                      </Badge>
                      <Badge size="xs" variant="light" color={getRuntimeBadgeColor(runtime?.runtimeState)}>
                        {getRuntimeLabel(runtime?.runtimeState)}
                      </Badge>
                    </Group>
                    <Text size="xs" c="dimmed" lineClamp={1} mt={2}>
                      {bot.accountId} · Agent: {bot.agentId}
                    </Text>
                    {runtime?.issues?.[0] && (
                      <Text size="xs" c="yellow" mt={2}>{runtime.issues[0]}</Text>
                    )}
                  </div>
                  <Button
                    variant="light"
                    color="red"
                    size="compact-xs"
                    onClick={() => void handleDeleteBot(bot)}
                    loading={deletingBotId === bot.accountId}
                    disabled={repairingIsolation || feishuInstallerBusy}
                  >
                    删除
                  </Button>
                </Group>
              )
            })}
          </div>
        </ScrollArea.Autosize>

        {/* 多机器人隔离 */}
        <Group justify="space-between" wrap="nowrap" className="border app-border rounded-lg px-3 py-2.5">
          <div style={{ minWidth: 0, flex: 1 }}>
            <Text size="xs" fw={500} className="app-text-primary">多机器人隔离状态</Text>
            <Text size="xs" c="dimmed">
              {isolationDrift.needsRepair
                ? '检测到隔离配置不完整'
                : '已按多账号并行模式写入隔离路由'}
            </Text>
          </div>
          <Button
            variant={isolationDrift.needsRepair ? 'filled' : 'light'}
            size="compact-xs"
            onClick={() => void handleRepairIsolation()}
            loading={repairingIsolation}
            disabled={deletingBotId !== '' || feishuInstallerBusy}
          >
            修复隔离
          </Button>
        </Group>

        {isolationDrift.needsRepair && (
          <Alert color="yellow" variant="light" title="检测到配置漂移" styles={{ title: { fontSize: 'var(--mantine-font-size-xs)' } }}>
            <Text size="xs">
              {!isolationDrift.dmScopeCorrect ? 'session.dmScope 尚未切到 per-account-channel-peer。' : ''}
              {isolationDrift.missingAgentIds.length > 0 ? ` 缺少 Agent：${isolationDrift.missingAgentIds.join('、')}。` : ''}
              {isolationDrift.workspaceMismatches.length > 0 ? ` workspace 未隔离：${isolationDrift.workspaceMismatches.join('、')}。` : ''}
              {isolationDrift.missingBindingAccountIds.length > 0 ? ` 缺少 bindings：${isolationDrift.missingBindingAccountIds.join('、')}。` : ''}
              {isolationDrift.conflictingBindingAccountIds.length > 0 ? ` 绑定冲突：${isolationDrift.conflictingBindingAccountIds.join('、')}。` : ''}
            </Text>
          </Alert>
        )}

        {/* 安装器操作 */}
        <Group gap="xs">
          <Button
            variant="light"
            size="xs"
            onClick={() => void startFeishuInstallerFlow('create')}
            loading={feishuInstallerBusy && feishuBotSetupMode === 'create'}
            disabled={feishuCreateInstallerButtonDisabled}
          >
            新建机器人
          </Button>
          <Button
            variant="subtle"
            size="xs"
            onClick={() => setShowFeishuInstallTutorial(true)}
          >
            查看教程
          </Button>
          <Button
            variant="subtle"
            color="red"
            size="xs"
            onClick={() => void stopFeishuInstallerFlow()}
            disabled={!feishuInstallerRunning || feishuInstallerBusy}
          >
            中止安装
          </Button>
        </Group>

        {feishuBotSetupMode === 'create' ? (
          <div className="border app-border rounded-lg p-3 space-y-3">
            <div className="flex flex-col items-center gap-2">
              {showOwnedFeishuCreateSessionSurface ? (
                visibleFeishuInstallerAsciiQr ? (
                <div className="w-full overflow-auto rounded-lg p-2" style={{ backgroundColor: 'var(--app-bg-inset)' }}>
                  <Group justify="space-between" mb={4}>
                    <Text size="xs" c="dimmed">安装器生成的二维码</Text>
                    <Badge size="xs" variant="light" color="teal">已刷新</Badge>
                  </Group>
                  <pre className="whitespace-pre font-mono text-[8px] leading-[1.1] app-text-primary">
                    {visibleFeishuInstallerAsciiQr}
                  </pre>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <Group gap="xs">
                    <Text size="xs" c="dimmed">
                      {visibleFeishuInstallerHasLiveQr ? '安装器二维码' : '官网兜底二维码'}
                    </Text>
                    <Badge
                      size="xs"
                      variant="light"
                      color={visibleFeishuInstallerHasLiveQr ? 'teal' : visibleFeishuInstallerRunning ? 'yellow' : 'gray'}
                    >
                      {visibleFeishuInstallerHasLiveQr ? '已刷新' : visibleFeishuInstallerRunning ? '等待中' : '未刷新'}
                    </Badge>
                  </Group>
                  <QRCodeSVG value={feishuInstallerQrUrl} size={160} includeMargin />
                  {visibleFeishuInstallerRunning && !visibleFeishuInstallerHasLiveQr && (
                    <Text size="xs" c="yellow" ta="center">等待安装器生成新建机器人的二维码</Text>
                  )}
                </div>
              )) : (
                <Text size="xs" c="dimmed" ta="center">
                  当前没有正在进行的飞书新建会话。点击上方“新建机器人”后，这里才会展示本次会话的二维码。
                </Text>
              )}
              <Text
                size="xs"
                c="dimmed"
                component="a"
                href={FEISHU_OFFICIAL_GUIDE_URL}
                target="_blank"
                rel="noreferrer"
                style={{ textDecoration: 'underline', cursor: 'pointer' }}
              >
                打开飞书官网使用指南
              </Text>
            </div>
            <Text size="xs" c="dimmed">
              兜底命令：<code style={{ fontSize: '10px' }}>{FEISHU_OFFICIAL_INSTALL_COMMAND}</code>
            </Text>
          </div>
        ) : (
          <div className="border app-border rounded-lg p-3 space-y-2">
            <Text size="xs" className="app-text-secondary">请选择 OpenClaw 已关联的机器人</Text>
            {feishuBotsOrdered.length === 0 ? (
              <Text size="xs" c="dimmed">当前还没有已关联的飞书机器人，请先新建一个。</Text>
            ) : (
              <>
                <div className="space-y-1.5">
                  {feishuBotsOrdered.map((bot) => {
                    const selected = selectedLinkedFeishuBot?.accountId === bot.accountId
                    const pairing = pairingStatusByBot[bot.accountId]
                    const pairedCount = pairing?.pairedCount || 0
                    return (
                      <Group
                        key={`select-${bot.accountId}`}
                        justify="space-between"
                        wrap="nowrap"
                        py={6}
                        px="xs"
                        className="border rounded-md cursor-pointer"
                        style={{
                          borderColor: selected ? 'var(--app-hover-border)' : 'var(--app-border)',
                          backgroundColor: selected ? 'var(--app-bg-tertiary)' : undefined,
                          transition: 'border-color 0.15s ease, background-color 0.15s ease',
                        }}
                        onClick={() => setSelectedLinkedFeishuBotId(bot.accountId)}
                      >
                        <div style={{ minWidth: 0 }}>
                          <Text size="xs" fw={500} className="app-text-primary" lineClamp={1}>{bot.name}</Text>
                          <Text size="xs" c="dimmed" lineClamp={1}>{bot.accountId}</Text>
                        </div>
                        <Badge size="xs" variant="light" color={pairedCount > 0 ? 'teal' : 'yellow'}>
                          {pairedCount > 0 ? `${pairedCount} 已配对` : '待配对'}
                        </Badge>
                      </Group>
                    )
                  })}
                </div>

                {selectedLinkedFeishuBot && (
                  <Text size="xs" c="dimmed">
                    已选择 {selectedLinkedFeishuBot.name}。
                    {feishuOfficialPluginInstalled
                      ? '已确认飞书官方插件在当前环境可用，会优先复用已有配置。'
                      : '如果当前环境缺少飞书官方插件，进入关联流程前会先自动补装。'}
                  </Text>
                )}
              </>
            )}
          </div>
        )}

        {/* 安装器控制台 */}
        <div className="border app-border rounded-lg p-3 space-y-2">
          <Group justify="space-between">
            <div>
              <Text size="xs" fw={500} className="app-text-primary">安装器控制台</Text>
              <Text size="xs" c="dimmed">
                {visibleFeishuInstallerRunning
                  ? '安装器运行中'
                  : visibleFeishuInstallerExitCode === null
                    ? '尚未启动'
                    : visibleFeishuInstallerCanceled
                      ? '已中止'
                      : visibleFeishuInstallerExitCode === 0
                        ? '已结束'
                        : `已退出 (${visibleFeishuInstallerExitCode ?? ''})`}
              </Text>
            </div>
            <Badge size="xs" variant="light" color={visibleFeishuInstallerRunning ? 'teal' : 'gray'}>
              {visibleFeishuInstallerRunning ? '运行中' : '未运行'}
            </Badge>
          </Group>

          <Group gap={4}>
            <Button variant="light" size="compact-xs" onClick={() => void sendFeishuInstallerInput('\u001b[A')} disabled={!visibleFeishuInstallerRunning || feishuInstallerManualInputBlocked}>上移</Button>
            <Button variant="light" size="compact-xs" onClick={() => void sendFeishuInstallerInput('\u001b[B')} disabled={!visibleFeishuInstallerRunning || feishuInstallerManualInputBlocked}>下移</Button>
            <Button variant="light" size="compact-xs" onClick={() => void sendFeishuInstallerInput('\r')} disabled={!visibleFeishuInstallerRunning || feishuInstallerManualInputBlocked}>确认</Button>
            <Button variant="subtle" size="compact-xs" color="red" onClick={() => void sendFeishuInstallerInput('\u0003')} disabled={!visibleFeishuInstallerRunning || feishuInstallerManualInputBlocked}>Ctrl+C</Button>
          </Group>

          <ScrollArea.Autosize mah={180} className="rounded-md" style={{ backgroundColor: 'var(--app-bg-inset)' }}>
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 app-text-secondary px-3 py-2">
              {visibleFeishuInstallerOutput || '安装器输出会显示在这里。'}
            </pre>
          </ScrollArea.Autosize>

          <Group gap="xs">
            <TextInput
              size="xs"
              style={{ flex: 1 }}
              value={feishuInstallerInput}
              onChange={(e) => setFeishuInstallerInput(e.currentTarget.value)}
              placeholder="向安装器发送自定义输入"
              disabled={!visibleFeishuInstallerRunning || feishuInstallerManualInputBlocked}
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
              disabled={!visibleFeishuInstallerRunning || feishuInstallerManualInputBlocked || !feishuInstallerInput.trim()}
            >
              发送
            </Button>
          </Group>
        </div>

        {feishuConfigNotice && (
          <Alert color="yellow" variant="light" styles={{ title: { fontSize: 'var(--mantine-font-size-xs)' } }} title="需要显式同步飞书配置">
            <Text size="xs">{feishuConfigNotice}</Text>
          </Alert>
        )}

        {feishuGuardrailView && (
          <Alert color={feishuGuardrailView.color} variant="light" styles={{ title: { fontSize: 'var(--mantine-font-size-xs)' } }} title={feishuGuardrailView.title}>
            <Stack gap={4}>
              {feishuGuardrailView.lines.map((line, index) => (
                <Text key={`${index}:${line}`} size="xs">{line}</Text>
              ))}
            </Stack>
          </Alert>
        )}

        {feishuInstallerNotice && (
          <Alert color="blue" variant="light" styles={{ title: { fontSize: 'var(--mantine-font-size-xs)' } }} title="安装器提示">
            <Text size="xs">{feishuInstallerNotice}</Text>
          </Alert>
        )}

        {botError && (
          <Alert color="red" variant="light" withCloseButton onClose={() => setBotError('')}>
            <Text size="xs">{botError}</Text>
          </Alert>
        )}
      </div>

      <FeishuInstallTutorialModal
        opened={showFeishuInstallTutorial}
        onClose={() => setShowFeishuInstallTutorial(false)}
      />
    </Modal>
  )
}
