import { useEffect, useRef, useState } from 'react'
import { Alert, ActionIcon, Badge, Button, Card, Group, Paper, ScrollArea, Select, Stack, Text, Textarea, Tooltip, Transition, useComputedColorScheme, useMantineColorScheme } from '@mantine/core'
import { IconChevronDown, IconChevronUp, IconPlayerStop, IconRefresh, IconSend, IconTrash } from '@tabler/icons-react'
import type {
  ChatCapabilitySnapshot,
  ChatMessage,
  ChatSessionDebugSnapshot,
  ChatSessionSummary,
  ChatTraceEntry,
  ChatTranscript,
  ChatUsage,
  DashboardChatAvailabilityState,
} from '../../shared/chat-panel'
import {
  buildDashboardChatSessionStatus,
  buildHistorySessionSummary,
  pickDefaultActiveSession,
  resolveChatStreamSessionBinding,
  resolveCompletedSendSessionId,
  resolveDirectChatSessionAction,
} from '../../shared/dashboard-chat-routing'
import { deriveChatPanelAvailabilityView } from './chat-panel-availability'
import { advanceStreamingText } from './chat-stream-typing'
import {
  buildRenderedChatMessages,
  resolveChatMessageDisplayText,
  shouldShowFullscreenChatLoader,
} from './chat-panel-messages'
import {
  buildSessionModelOptions,
  resolveSessionModelIntentState,
  resolveSessionModelPresentation,
  resolveSessionModelSelectValue,
  resolveSessionModelSelection,
} from './chat-session-model-switching'
import {
  buildChatCapabilityIndicators,
  buildChatDebugFieldRows,
  formatChatTraceEntryLabel,
  formatChatTraceEntryMeta,
} from './chat-panel-diagnostics'
import { findEquivalentRuntimeModelKey } from '../../lib/model-runtime-resolution'
import type { ChatComposerEnterSendMode } from '../../lib/chat-composer-enter-send-preference'

const QUICK_PROMPTS = [
  '帮我确认当前模型是否可用',
  '介绍一下你现在连接的默认模型能力',
  '给我一个测试对话示例',
]

const COMPOSER_DEFAULT_HEIGHT = 160
const COMPOSER_MIN_HEIGHT = 120
const COMPOSER_MAX_HEIGHT_FALLBACK = 520

const TOKEN_FORMATTER = new Intl.NumberFormat('zh-CN')

function getComposerMaxHeight(): number {
  if (typeof window === 'undefined' || !Number.isFinite(window.innerHeight) || window.innerHeight <= 0) {
    return COMPOSER_MAX_HEIGHT_FALLBACK
  }

  return Math.max(COMPOSER_MIN_HEIGHT, Math.round(window.innerHeight * 0.5))
}

function formatSessionTime(updatedAt: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '刚刚'
  const date = new Date(updatedAt)
  if (Number.isNaN(date.getTime())) return '刚刚'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatMessageTime(createdAt: number, fallback = ''): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return fallback || '刚刚'
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return fallback || '刚刚'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function buildComposerHint(params: {
  hasSession: boolean
  canPatchModel: boolean
  enterSendMode: ChatComposerEnterSendMode
}): string {
  const enterHint: string = (() => {
    switch (params.enterSendMode) {
      case 'enter':
        return 'Enter 发送 · Shift+Enter 换行'
      case 'shiftEnter':
        return 'Shift+Enter 发送 · Enter 换行'
      case 'altEnter':
        return 'Alt+Enter 发送 · Enter 换行'
      default:
        return 'Enter 发送 · Shift+Enter 换行'
    }
  })()

  if (!params.hasSession) {
    return `发送首条消息后可切换会话模型 · ${enterHint}`
  }

  if (!params.canPatchModel) {
    return `当前会话暂不支持切换模型 · ${enterHint}`
  }

  return `模型切换仅影响当前会话 · ${enterHint}`
}

function buildEmptyTranscript(sessionId: string): ChatTranscript {
  return {
    sessionId,
    agentId: 'main',
    updatedAt: 0,
    hasLocalTranscript: false,
    messages: [],
  }
}

function mergeSessionSummary(
  sessions: ChatSessionSummary[],
  nextSession: ChatSessionSummary
): ChatSessionSummary[] {
  return [nextSession, ...sessions.filter((session) => session.sessionId !== nextSession.sessionId)].sort(
    (left, right) => right.updatedAt - left.updatedAt
  )
}

function formatUsageLabel(usage: ChatUsage | null | undefined): string {
  if (!usage) return ''
  if (Number.isFinite(usage.totalTokens)) {
    return `${TOKEN_FORMATTER.format(Number(usage.totalTokens))} tokens`
  }

  const parts = [
    Number.isFinite(usage.inputTokens) ? `输入 ${TOKEN_FORMATTER.format(Number(usage.inputTokens))}` : '',
    Number.isFinite(usage.outputTokens) ? `输出 ${TOKEN_FORMATTER.format(Number(usage.outputTokens))}` : '',
  ].filter(Boolean)
  return parts.join(' · ')
}

function formatSessionUsage(session: ChatSessionSummary | null | undefined): string {
  if (!session) return ''
  if (Number.isFinite(session.totalTokens) && Number.isFinite(session.contextTokens)) {
    return `${TOKEN_FORMATTER.format(Number(session.totalTokens))}/${TOKEN_FORMATTER.format(Number(session.contextTokens))} tokens`
  }
  if (Number.isFinite(session.totalTokens)) {
    return `${TOKEN_FORMATTER.format(Number(session.totalTokens))} tokens`
  }
  if (Number.isFinite(session.contextTokens)) {
    return `上下文 ${TOKEN_FORMATTER.format(Number(session.contextTokens))}`
  }
  return ''
}

function findLastAssistantModel(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const model = String(message.model || '').trim()
    if (model) return model
  }
  return ''
}

function resolveExternalTranscriptMessage(transcript: ChatTranscript | null): string {
  const errorCode = transcript?.externalTranscriptErrorCode
  if (errorCode === 'session-key-missing') return '当前历史会话缺少标识，请刷新后重试。'
  if (errorCode === 'gateway-offline') return '网关离线，暂时无法读取外部历史正文。'
  if (errorCode === 'gateway-auth-failed') return '网关鉴权失败，请检查网关 token 配置。'
  if (errorCode === 'session-not-found') return '上游未找到该会话，可能已被清理。'
  if (errorCode === 'messages-map-failed') return '历史消息格式暂不兼容，暂时无法展示正文。'
  if (errorCode === 'sessions-get-failed') return '读取历史正文失败，可稍后重试。'

  if (transcript?.externalTranscriptTruncated && Number.isFinite(transcript.externalTranscriptLimit)) {
    return `仅展示最近 ${TOKEN_FORMATTER.format(Number(transcript.externalTranscriptLimit))} 条历史消息。`
  }
  return ''
}

/** 横向滑块主题切换，左月亮右太阳 */
function LightSwitch() {
  const { setColorScheme } = useMantineColorScheme()
  const computed = useComputedColorScheme('dark')
  const isDark = computed === 'dark'

  return (
    <Tooltip label={isDark ? '切换亮色' : '切换暗色'} withArrow>
      <ActionIcon
        variant="subtle"
        color="surface"
        size="lg"
        onClick={() => setColorScheme(isDark ? 'light' : 'dark')}
        style={{ width: 52, overflow: 'hidden', position: 'relative' }}
      >
        {/* 月亮 */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={isDark ? '#fbbf24' : 'var(--app-text-faint)'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 6, transition: 'stroke .2s' }}>
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
        {/* 太阳 */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={isDark ? 'var(--app-text-faint)' : '#f59e0b'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', right: 6, transition: 'stroke .2s' }}>
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
        {/* 滑块指示器 */}
        <span
          style={{
            position: 'absolute',
            top: 4,
            left: isDark ? 3 : 29,
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: isDark ? 'rgba(59,130,246,.2)' : 'rgba(245,158,11,.2)',
            transition: 'left .25s cubic-bezier(.4,0,.2,1), background .2s',
            pointerEvents: 'none',
          }}
        />
      </ActionIcon>
    </Tooltip>
  )
}

export default function DashboardChatPanel({
  availabilityState,
  canSend,
  gatewayRunning,
  connectedModels,
  defaultModel,
  availabilityMessage,
  onOpenSettings,
  onEnsureGatewayRunning,
  enterSendMode,
}: {
  availabilityState: DashboardChatAvailabilityState
  canSend: boolean
  gatewayRunning: boolean
  connectedModels: string[]
  defaultModel?: string
  availabilityMessage?: string
  onOpenSettings: () => void
  onEnsureGatewayRunning: () => Promise<boolean>
  enterSendMode: ChatComposerEnterSendMode
}) {
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState('')
  const [transcript, setTranscript] = useState<ChatTranscript | null>(null)
  const [draft, setDraft] = useState('')
  const [loadingTranscript, setLoadingTranscript] = useState(false)
  const [panelError, setPanelError] = useState('')
  const [sending, setSending] = useState(false)
  const [pendingUserText, setPendingUserText] = useState('')
  const [streamingAssistantText, setStreamingAssistantText] = useState('')
  const [visibleStreamingAssistantText, setVisibleStreamingAssistantText] = useState('')
  const [streamingAssistantModel, setStreamingAssistantModel] = useState('')
  const [streamingAssistantUsage, setStreamingAssistantUsage] = useState<ChatUsage | undefined>(undefined)
  const [assistantStreamStarted, setAssistantStreamStarted] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [chatModelSwitching, setChatModelSwitching] = useState(false)
  const [clearingTranscript, setClearingTranscript] = useState(false)
  const [lastRetryText, setLastRetryText] = useState('')
  const [copiedMessageId, setCopiedMessageId] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [composerHeight, setComposerHeight] = useState(COMPOSER_DEFAULT_HEIGHT)
  const [showComposerModelPicker, setShowComposerModelPicker] = useState(false)
  const [inFlightPatchState, setInFlightPatchState] = useState<{ sessionId: string; targetModel: string } | null>(null)
  const [showDiagnostics] = useState(false)
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)
  const [diagnosticsError, setDiagnosticsError] = useState('')
  const [capabilitySnapshot, setCapabilitySnapshot] = useState<ChatCapabilitySnapshot | null>(null)
  const [sessionDebugSnapshot, setSessionDebugSnapshot] = useState<ChatSessionDebugSnapshot | null>(null)
  const [traceEntries, setTraceEntries] = useState<ChatTraceEntry[]>([])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const activeSendSessionIdRef = useRef('')
  const sessionsRequestIdRef = useRef(0)
  const transcriptRequestIdRef = useRef(0)
  const diagnosticsRequestIdRef = useRef(0)
  const lastAutoSelectedModelRef = useRef('')
  const lastModelSelectionContextRef = useRef('')
  const composerResizeStateRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const composerResizeCleanupRef = useRef<(() => void) | null>(null)

  const canLoadChatData = true
  const canBrowseHistory = !loadingSessions && !sending

  const activeSession = sessions.find((session) => session.sessionId === activeSessionId) || null
  const activeTranscriptMatchesSession = transcript?.sessionId === activeSession?.sessionId
  const activeTranscript = activeTranscriptMatchesSession ? transcript : null
  const activeSessionCanPatchModel =
    activeTranscript?.canPatchModel ??
    activeSession?.canPatchModel ??
    false
  const activeSessionModelSwitchBlockedReason =
    activeTranscript?.modelSwitchBlockedReason ??
    activeSession?.modelSwitchBlockedReason ??
    ''
  const activeSessionStatus = buildDashboardChatSessionStatus({
    defaultModel,
    session: activeSession,
  })
  const sessionModelSelectionEnabled = Boolean(activeSession) && activeSessionCanPatchModel
  const normalizedDefaultModel = String(defaultModel || '').trim()
  const normalizedSessionModel = String(activeTranscript?.model || activeSession?.model || '').trim()
  const normalizedLocalSelectedModel = String(selectedModel || '').trim()
  const resolvedSelectedModel = resolveSessionModelSelection({
    selectedModel: selectedModel || activeTranscript?.selectedModel || activeSession?.selectedModel,
    sessionModel: normalizedSessionModel,
    defaultModel: normalizedDefaultModel,
    connectedModels,
  })
  const currentSessionModelLabel = activeSession
    ? normalizedSessionModel || (normalizedDefaultModel ? `默认模型（${normalizedDefaultModel}）` : '默认路由')
    : '未选择会话'
  const currentSessionModelSourceLabel = activeSession
    ? normalizedSessionModel
      ? '当前会话记录'
      : normalizedDefaultModel
        ? '当前会话未单独设置，跟随默认模型'
        : '当前会话尚未记录模型'
    : '选择一个会话后显示'
  const lastAssistantModel = String(
    streamingAssistantModel || findLastAssistantModel(activeTranscript?.messages || [])
  ).trim()
  const referenceModel = normalizedSessionModel || normalizedDefaultModel
  const selectionOwnedByUser =
    Boolean(normalizedLocalSelectedModel)
    && normalizedLocalSelectedModel !== String(lastAutoSelectedModelRef.current || '').trim()
  const sessionModelIntentState = resolveSessionModelIntentState({
    hasSession: Boolean(activeSession),
    canPatchModel: activeSessionCanPatchModel,
    inFlightTargetModel:
      activeSession && inFlightPatchState?.sessionId === activeSession.sessionId
        ? inFlightPatchState.targetModel
        : '',
    selectedModel: resolvedSelectedModel,
    confirmedModel: referenceModel,
    selectionOwnedByUser,
  })
  const pendingTargetModel = sessionModelIntentState.pendingTargetModel
  const unconfirmedSelectionModel = sessionModelIntentState.unconfirmedSelectionModel
  const sessionModelPresentation = resolveSessionModelPresentation({
    hasSession: Boolean(activeSession),
    pendingTargetModel,
    unconfirmedSelectionModel,
    canPatchModel: activeSessionCanPatchModel,
    blockedReason: activeSessionModelSwitchBlockedReason,
  })
  const sessionModelSelectValue = resolveSessionModelSelectValue({
    selectedModel: resolvedSelectedModel,
    confirmedModel: referenceModel,
    pendingTargetModel,
    unconfirmedSelectionModel,
    connectedModels,
    selectionOwnedByUser,
  })
  const sessionModelHelperText = sessionModelPresentation.helperText
  const modelOptions = buildSessionModelOptions({
    selectedModel: resolvedSelectedModel,
    sessionModel: normalizedSessionModel,
    defaultModel: normalizedDefaultModel,
    connectedModels,
  })
  const sessionModelSummaryItems = [
    { label: '当前会话模型', value: currentSessionModelLabel, color: 'brand' as const },
    { label: '默认模型', value: normalizedDefaultModel || '未设置', color: 'gray' as const },
    { label: '最近回复模型', value: lastAssistantModel || '暂无', color: 'teal' as const },
    ...(pendingTargetModel
      ? [
          {
            label: sessionModelPresentation.targetLabel,
            value: pendingTargetModel,
            color: 'orange' as const,
          },
        ]
      : []),
    ...(unconfirmedSelectionModel
      ? [
          {
            label: sessionModelPresentation.targetLabel,
            value: unconfirmedSelectionModel,
            color: 'gray' as const,
          },
        ]
      : []),
    ...(activeSession
      ? [
          {
            label: '应用方式',
            value: sessionModelPresentation.modeLabel,
            color: sessionModelPresentation.modeTone,
          },
        ]
      : []),
  ]
  const renderedMessages: ChatMessage[] = buildRenderedChatMessages({
    baseMessages: activeTranscript?.messages || [],
    pendingUserText,
    pendingAssistant: {
      sending,
      started: assistantStreamStarted,
      stopping,
      text: visibleStreamingAssistantText,
      model: streamingAssistantModel,
      usage: streamingAssistantUsage,
    },
  })
  const showFullscreenLoader = shouldShowFullscreenChatLoader({
    loadingSessions,
    loadingTranscript,
    renderedMessageCount: renderedMessages.length,
  })
  const composerHint = buildComposerHint({
    hasSession: Boolean(activeSession),
    canPatchModel: sessionModelSelectionEnabled,
    enterSendMode,
  })
  const externalTranscriptMessage = resolveExternalTranscriptMessage(activeTranscript)
  const capabilityIndicators = buildChatCapabilityIndicators(capabilitySnapshot)
  const debugFieldRows = buildChatDebugFieldRows(sessionDebugSnapshot)

  const stopComposerResize = () => {
    composerResizeStateRef.current = null
    composerResizeCleanupRef.current?.()
    composerResizeCleanupRef.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  const handleComposerResizePointerDown = (clientY: number) => {
    composerResizeCleanupRef.current?.()
    composerResizeStateRef.current = {
      startY: clientY,
      startHeight: composerHeight,
    }
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (event: PointerEvent) => {
      const resizeState = composerResizeStateRef.current
      if (!resizeState) return
      const nextHeight = resizeState.startHeight - (event.clientY - resizeState.startY)
      const boundedHeight = Math.min(getComposerMaxHeight(), Math.max(COMPOSER_MIN_HEIGHT, Math.round(nextHeight)))
      setComposerHeight(boundedHeight)
    }

    const handlePointerUp = () => {
      stopComposerResize()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp, { once: true })
    composerResizeCleanupRef.current = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }

  const loadDiagnostics = async (
    sessionId: string | undefined,
    options: { silent?: boolean; preserveError?: boolean } = {}
  ) => {
    const normalizedSessionId = String(sessionId || '').trim()
    const requestId = diagnosticsRequestIdRef.current + 1
    diagnosticsRequestIdRef.current = requestId
    if (!options.silent) {
      setDiagnosticsLoading(true)
    }
    if (!options.preserveError) {
      setDiagnosticsError('')
    }

    const [capabilityResult, traceResult, debugResult] = await Promise.allSettled([
      window.api.getChatCapabilitySnapshot(),
      window.api.listChatTraceEntries(8),
      normalizedSessionId ? window.api.getChatSessionDebugSnapshot(normalizedSessionId) : Promise.resolve(null),
    ])

    if (requestId !== diagnosticsRequestIdRef.current) return

    const nextErrors: string[] = []

    if (capabilityResult.status === 'fulfilled') {
      setCapabilitySnapshot(capabilityResult.value)
    } else {
      nextErrors.push(
        capabilityResult.reason instanceof Error
          ? capabilityResult.reason.message
          : String(capabilityResult.reason || 'capability-read-failed')
      )
    }

    if (traceResult.status === 'fulfilled') {
      setTraceEntries(Array.isArray(traceResult.value) ? traceResult.value : [])
    } else {
      nextErrors.push(
        traceResult.reason instanceof Error
          ? traceResult.reason.message
          : String(traceResult.reason || 'trace-read-failed')
      )
    }

    if (debugResult.status === 'fulfilled') {
      setSessionDebugSnapshot(debugResult.value)
    } else {
      nextErrors.push(
        debugResult.reason instanceof Error
          ? debugResult.reason.message
          : String(debugResult.reason || 'debug-snapshot-read-failed')
      )
    }

    if (nextErrors.length > 0) {
      setDiagnosticsError(nextErrors.join('；'))
    }
    setDiagnosticsLoading(false)
  }

  const loadSessions = async (
    preferredSessionId?: string,
    options: { silent?: boolean; preservePanelError?: boolean } = {}
  ) => {
    const requestId = sessionsRequestIdRef.current + 1
    sessionsRequestIdRef.current = requestId
    if (!options.silent) {
      setLoadingSessions(true)
    }
    if (!options.preservePanelError) {
      setPanelError('')
    }
    try {
      const nextSessions = await window.api.listChatSessions()
      if (requestId !== sessionsRequestIdRef.current) return
      setSessions(nextSessions)
      const nextActiveSessionId = pickDefaultActiveSession({
        sessions: nextSessions,
        preferredSessionId,
        currentActiveSessionId: activeSessionId,
      })
      setActiveSessionId(nextActiveSessionId)
      if (!nextActiveSessionId) {
        setTranscript(null)
      }
    } catch (error) {
      if (requestId !== sessionsRequestIdRef.current) return
      if (!options.preservePanelError) {
        setPanelError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (requestId !== sessionsRequestIdRef.current) return
      setLoadingSessions(false)
    }
  }

  const loadTranscript = async (
    sessionId: string,
    options: { silent?: boolean; preservePanelError?: boolean } = {}
  ) => {
    const normalizedSessionId = String(sessionId || '').trim()
    const requestId = transcriptRequestIdRef.current + 1
    transcriptRequestIdRef.current = requestId
    if (!normalizedSessionId) {
      if (requestId === transcriptRequestIdRef.current) {
        setTranscript(null)
      }
      return
    }
    if (!options.silent) {
      setLoadingTranscript(true)
      setTranscript((current) =>
        current?.sessionId === normalizedSessionId ? current : buildEmptyTranscript(normalizedSessionId)
      )
    }
    if (!options.preservePanelError) {
      setPanelError('')
    }
    try {
      const nextTranscript = await window.api.getChatTranscript(normalizedSessionId)
      if (requestId !== transcriptRequestIdRef.current) return
      setTranscript(nextTranscript)
    } catch (error) {
      if (requestId !== transcriptRequestIdRef.current) return
      setTranscript(buildEmptyTranscript(normalizedSessionId))
      if (!options.preservePanelError) {
        setPanelError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (requestId !== transcriptRequestIdRef.current) return
      setLoadingTranscript(false)
    }
  }

  const handleRefreshChatData = async () => {
    if (!canBrowseHistory) return
    const currentSessionId = String(activeSessionId || '').trim()
    await loadSessions(currentSessionId || undefined)
    if (currentSessionId) {
      await loadTranscript(currentSessionId, { silent: true })
    }
  }

  const reconcileSessionView = async (sessionId: string) => {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return
    await Promise.all([
      loadTranscript(normalizedSessionId, { silent: true, preservePanelError: true }),
      loadSessions(normalizedSessionId, { silent: true, preservePanelError: true }),
    ])
  }

  const handleCreateSession = async () => {
    setPanelError('')
    try {
      const session = await window.api.createChatSession()
      setSessions((current) => mergeSessionSummary(current, session))
      setActiveSessionId(session.sessionId)
      setTranscript(buildEmptyTranscript(session.sessionId))
      setShowHistory(false)
      return session.sessionId
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error))
      return ''
    }
  }

  const handleSend = async (rawText?: string) => {
    const text = String(rawText ?? draft).trim()
    if (!text || sending || chatModelSwitching) return

    setPanelError('')
    let sessionId = String(activeSessionId || '').trim()
    if (resolveDirectChatSessionAction({ activeSessionId: sessionId }) === 'create') {
      sessionId = await handleCreateSession()
      if (!sessionId) return
    }

    if (!gatewayRunning) {
      const ready = await onEnsureGatewayRunning()
      if (!ready) {
        setPanelError('网关启动失败，暂时无法发送消息')
        return
      }
    }

    const nextDraft = text
    activeSendSessionIdRef.current = sessionId
    setPendingUserText(text)
    setStreamingAssistantText('')
    setVisibleStreamingAssistantText('')
    setStreamingAssistantModel('')
    setStreamingAssistantUsage(undefined)
    setAssistantStreamStarted(false)
    setStopping(false)
    setLastRetryText(text)
    setDraft('')
    setSending(true)
    try {
      const result = await window.api.sendChatMessage({
        sessionId,
        text,
      })
      if (!result.ok) {
        const failedSessionId = String(activeSendSessionIdRef.current || result.sessionId || sessionId).trim()
        if (result.errorCode !== 'canceled') {
          setDraft(nextDraft)
          setPanelError(result.messageText || '聊天发送失败')
        }
        await reconcileSessionView(failedSessionId)
        return
      }
      const resolvedSessionId = resolveCompletedSendSessionId({
        requestedSessionId: sessionId,
        resultSessionId: result.sessionId,
      })
      if (resolvedSessionId && resolvedSessionId !== sessionId) {
        activeSendSessionIdRef.current = resolvedSessionId
        setActiveSessionId(resolvedSessionId)
        setTranscript((current) =>
          current?.sessionId === resolvedSessionId ? current : buildEmptyTranscript(resolvedSessionId)
        )
      }
      setLastRetryText('')
      await Promise.all([
        loadTranscript(resolvedSessionId, { silent: true }),
        loadSessions(resolvedSessionId, { silent: true }),
      ])
    } catch (error) {
      setDraft(nextDraft)
      setPanelError(error instanceof Error ? error.message : String(error))
      await reconcileSessionView(String(activeSendSessionIdRef.current || sessionId).trim())
    } finally {
      activeSendSessionIdRef.current = ''
      setPendingUserText('')
      setStreamingAssistantText('')
      setVisibleStreamingAssistantText('')
      setStreamingAssistantModel('')
      setStreamingAssistantUsage(undefined)
      setAssistantStreamStarted(false)
      setSending(false)
      setStopping(false)
    }
  }

  const handleCancelSend = async () => {
    if (!sending || stopping) return

    setStopping(true)
    setPanelError('')
    try {
      const canceled = await window.api.cancelChatMessage()
      if (!canceled) {
        setStopping(false)
        setPanelError('当前没有可停止的聊天任务')
      }
    } catch (error) {
      setStopping(false)
      setPanelError(error instanceof Error ? error.message : String(error))
    }
  }

  const handleRetry = async () => {
    if (!lastRetryText || sending) return
    await handleSend(lastRetryText)
  }

  const handleClearLocalTranscript = async () => {
    if (!activeSession) return
    if (!activeSession.hasLocalTranscript || clearingTranscript) return

    const confirmed = window.confirm('确认清空这个会话在 Qclaw 本地保存的聊天记录吗？OpenClaw 原始会话不会被删除。')
    if (!confirmed) return

    setClearingTranscript(true)
    setPanelError('')
    try {
      const result = await window.api.clearChatTranscript(activeSession.sessionId)
      if (!result.ok) {
        setPanelError('清空本地聊天记录失败')
        return
      }
      await Promise.all([loadTranscript(activeSession.sessionId), loadSessions(activeSession.sessionId)])
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error))
    } finally {
      setClearingTranscript(false)
    }
  }

  const handleSessionModelChange = async (value: string | null) => {
    const nextModel = String(value || '').trim()
    if (!nextModel) return

    const sessionId = String(activeSession?.sessionId || '').trim()
    if (!sessionId) {
      setPanelError('请先创建或选择一个会话，再切换当前会话模型')
      return
    }

    if (!activeSessionCanPatchModel) {
      setPanelError(activeSessionModelSwitchBlockedReason || '当前会话暂不支持原地切模型')
      return
    }

    const allowedModels = new Set(connectedModels.map((item) => String(item || '').trim()).filter(Boolean))
    if (
      allowedModels.size > 0
      && !allowedModels.has(nextModel)
      && !findEquivalentRuntimeModelKey(nextModel, [...allowedModels])
    ) {
      setPanelError(`当前 OpenClaw 未启用模型 ${nextModel}，请先在 OpenClaw 中配置并允许该模型后再试`)
      return
    }

    const currentModel = String(normalizedSessionModel || normalizedDefaultModel || '').trim()
    const previousSelection = resolvedSelectedModel
    setSelectedModel(nextModel)
    setPanelError('')

    if (nextModel === currentModel) {
      return
    }

    setInFlightPatchState({
      sessionId,
      targetModel: nextModel,
    })
    setChatModelSwitching(true)
    try {
      const result = await window.api.patchChatSessionModel({
        sessionId,
        model: nextModel,
      })
      if (!result.ok) {
        setSelectedModel(previousSelection)
        setPanelError(result.messageText || '切换当前会话模型失败')
        await reconcileSessionView(sessionId)
        return
      }
      await Promise.all([
        loadTranscript(sessionId, { silent: true }),
        loadSessions(sessionId, { silent: true }),
      ])
    } catch (error) {
      setSelectedModel(previousSelection)
      setPanelError(error instanceof Error ? error.message : String(error))
      await reconcileSessionView(sessionId)
    } finally {
      setInFlightPatchState((current) =>
        current?.sessionId === sessionId && current.targetModel === nextModel ? null : current
      )
      setChatModelSwitching(false)
    }
  }

  useEffect(() => {
    if (!canLoadChatData) return
    void loadSessions(activeSessionId || undefined)
  }, [canLoadChatData])

  useEffect(() => {
    return () => {
      composerResizeCleanupRef.current?.()
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [])

  useEffect(() => {
    if (!canLoadChatData || !activeSessionId) return
    void loadTranscript(activeSessionId)
  }, [canLoadChatData, activeSessionId])

  useEffect(() => {
    const nextSelectedModel = resolveSessionModelSelection({
      selectedModel: activeTranscript?.selectedModel || activeSession?.selectedModel,
      sessionModel: normalizedSessionModel,
      defaultModel: normalizedDefaultModel,
      connectedModels,
    })
    const selectionContextKey = `${activeSessionId}:${activeTranscript?.sessionId || ''}`
    const selectionContextChanged = lastModelSelectionContextRef.current !== selectionContextKey
    lastModelSelectionContextRef.current = selectionContextKey
    setSelectedModel((current) => {
      const normalizedCurrent = String(current || '').trim()
      const currentStillSelectable = modelOptions.some((option) => option.value === normalizedCurrent)
      if (!nextSelectedModel) {
        lastAutoSelectedModelRef.current = ''
        return currentStillSelectable ? normalizedCurrent : ''
      }
      const shouldAutoSync =
        selectionContextChanged || !normalizedCurrent || normalizedCurrent === lastAutoSelectedModelRef.current
      if (!shouldAutoSync && currentStillSelectable) {
        return normalizedCurrent
      }
      lastAutoSelectedModelRef.current = nextSelectedModel
      return nextSelectedModel
    })
  }, [
    activeSession?.selectedModel,
    activeSessionId,
    activeTranscript?.selectedModel,
    activeTranscript?.sessionId,
    connectedModels,
    modelOptions,
    normalizedDefaultModel,
    normalizedSessionModel,
  ])

  useEffect(() => {
    if (!scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [renderedMessages.length, sending, transcript?.updatedAt, visibleStreamingAssistantText])

  useEffect(() => {
    if (visibleStreamingAssistantText === streamingAssistantText) return

    const timer = window.setTimeout(() => {
      setVisibleStreamingAssistantText((current) => advanceStreamingText(current, streamingAssistantText))
    }, 16)

    return () => {
      window.clearTimeout(timer)
    }
  }, [streamingAssistantText, visibleStreamingAssistantText])

  useEffect(() => {
    const unsubscribe = window.api.onChatStream((payload) => {
      const nextTrackedSessionId = resolveChatStreamSessionBinding({
        trackedSessionId: activeSendSessionIdRef.current,
        incomingSessionId: payload.sessionId,
        eventType: payload.type,
      })
      if (!nextTrackedSessionId) return
      if (nextTrackedSessionId !== activeSendSessionIdRef.current) {
        activeSendSessionIdRef.current = nextTrackedSessionId
        setActiveSessionId(nextTrackedSessionId)
        setTranscript((current) =>
          current?.sessionId === nextTrackedSessionId ? current : buildEmptyTranscript(nextTrackedSessionId)
        )
      }
      if (payload.sessionId !== activeSendSessionIdRef.current) return

      if (payload.type === 'assistant-start') {
        setAssistantStreamStarted(true)
        setStreamingAssistantModel(payload.model || '')
        return
      }

      if (payload.type === 'assistant-delta') {
        setAssistantStreamStarted(true)
        setStreamingAssistantText(payload.text)
        setStreamingAssistantModel(payload.model || '')
        setStreamingAssistantUsage(payload.usage)
        return
      }

      if (payload.type === 'assistant-complete') {
        setAssistantStreamStarted(true)
        setStreamingAssistantText(payload.message.text)
        setStreamingAssistantModel(payload.message.model || '')
        setStreamingAssistantUsage(payload.message.usage)
        return
      }

      if (payload.type === 'assistant-error' && payload.errorCode !== 'canceled') {
        setPanelError(payload.messageText)
      }
    })

    return () => {
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!copiedMessageId) return
    const timer = window.setTimeout(() => {
      setCopiedMessageId('')
    }, 1600)
    return () => {
      window.clearTimeout(timer)
    }
  }, [copiedMessageId])

  useEffect(() => {
    if (!showDiagnostics) return
    void loadDiagnostics(activeSessionId || undefined, {
      silent: true,
      preserveError: true,
    })
  }, [showDiagnostics, activeSessionId, activeTranscript?.updatedAt, activeSession?.updatedAt])

  const handleCopyMessage = async (message: ChatMessage) => {
    const text = String(message.text || '').trim()
    if (!text) return

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('当前环境不支持复制')
      }
      await navigator.clipboard.writeText(text)
      setCopiedMessageId(message.id)
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error))
    }
  }

  const hasTranscriptMessages = (activeTranscript?.messages.length || 0) > 0
  const shouldPreserveConversation = Boolean(
    sending || pendingUserText || streamingAssistantText || activeSession || hasTranscriptMessages
  )
  const {
    isReady,
    isDegraded,
    isModelUnavailable,
    resolvedAvailabilityMessage,
    showAvailabilityBanner,
    showAvailabilityEmptyState,
    statusDetail,
    headerBadgeColor,
    headerBadgeLabel,
  } = deriveChatPanelAvailabilityView({
    availabilityState,
    canSend,
    connectedModels,
    availabilityMessage,
    preserveConversation: shouldPreserveConversation,
  })

  return (
    <Card h="100%" p="sm" withBorder shadow="xl" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
        <div>
          <Group gap="xs">
            <Text size="sm" fw={600}>直接对话</Text>
            <Badge
              variant="light"
              color={headerBadgeColor}
              size="sm"
            >
              {headerBadgeLabel}
            </Badge>
          </Group>
        </div>

        <ActionIcon.Group>
          <LightSwitch />
          <Tooltip label="刷新会话" withArrow>
            <ActionIcon
              variant="subtle"
              color="surface"
              size="lg"
              onClick={() => void handleRefreshChatData()}
              loading={loadingSessions || loadingTranscript}
              disabled={!canBrowseHistory}
            >
              <IconRefresh size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={showHistory ? '收起历史' : `历史${sessions.length > 0 ? ` (${sessions.length})` : ''}`} withArrow>
            <ActionIcon
              variant="subtle"
              color="surface"
              size="lg"
              onClick={() => setShowHistory((current) => !current)}
              disabled={!canBrowseHistory}
            >
              {/* 历史图标 */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </ActionIcon>
          </Tooltip>
          <Tooltip label="新对话" withArrow>
            <ActionIcon
              variant="subtle"
              color="surface"
              size="lg"
              onClick={() => void handleCreateSession()}
              disabled={!canSend || sending}
            >
              {/* 加号图标 */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </ActionIcon>
          </Tooltip>
        </ActionIcon.Group>
      </Group>

      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {showDiagnostics && (
            <Paper withBorder p="xs" mt="sm" radius="md" style={{ flex: '0 0 auto' }}>
              <Group gap={6} wrap="wrap">
                {sessionModelSummaryItems.map((item) => (
                  <Group key={`${item.label}:${item.value}`} gap={6} wrap="nowrap">
                    <Badge size="xs" variant="light" color={item.color}>{item.label}</Badge>
                    <Text size="xs">{item.value}</Text>
                  </Group>
                ))}
              </Group>
              <Text size="xs" c="dimmed" mt={6}>
                {currentSessionModelSourceLabel}
                {' · '}
                {sessionModelHelperText}
                {chatModelSwitching
                  ? ' 正在切换当前会话模型...'
                  : pendingTargetModel
                    ? ' 正在把当前会话切到该目标模型。'
                    : ''}
              </Text>
              {activeSession && !sessionModelSelectionEnabled && activeSessionModelSwitchBlockedReason && (
                <Text size="xs" c="dimmed" mt={4}>
                  {activeSessionModelSwitchBlockedReason}
                </Text>
              )}
            </Paper>
          )}

          <Transition mounted={!!panelError} transition="slide-down" duration={200}>
            {(styles) => (
              <Alert color="danger" variant="light" className="mt-3" style={styles}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{panelError}</span>
                  {lastRetryText && (
                    <Button variant="light" color="brand" size="compact-xs" onClick={() => void handleRetry()} disabled={sending}>
                      重试上一条
                    </Button>
                  )}
                </div>
              </Alert>
            )}
          </Transition>

          {externalTranscriptMessage &&
            (activeSessionStatus.sessionOrigin === 'channel' || activeSessionStatus.willForkOnSend) && (
            <Alert
              color={transcript?.externalTranscriptErrorCode ? 'warning' : 'blue'}
              variant="light"
              className="mt-3"
            >
              <Text size="xs">{externalTranscriptMessage}</Text>
            </Alert>
            )}

          {showAvailabilityBanner && (
            <Alert color={isDegraded || isModelUnavailable ? 'warning' : 'danger'} variant="light" className="mt-3">
              <Text size="xs">{statusDetail}</Text>
            </Alert>
          )}

          {showDiagnostics && (
            <Paper withBorder p="sm" mt="sm" radius="lg" style={{ flex: '0 0 auto' }}>
              <Group justify="space-between" gap="sm" align="flex-start">
                <div>
                  <Text size="xs" fw={500}>会话诊断</Text>
                  <Text size="xs" c="dimmed" mt={4}>
                    用于核对当前 capability、会话 authority 语义以及最近一次主流程 trace。
                  </Text>
                </div>
                <Button
                  variant="light"
                  color="brand"
                  size="xs"
                  onClick={() => void loadDiagnostics(activeSessionId || undefined)}
                  loading={diagnosticsLoading}
                >
                  刷新诊断
                </Button>
              </Group>

              <ScrollArea.Autosize mah="min(48vh, 520px)" mt="sm" type="auto" offsetScrollbars>
                {diagnosticsError && (
                  <Alert color="warning" variant="light">
                    <Text size="xs">{diagnosticsError}</Text>
                  </Alert>
                )}

                <Group gap={6} wrap="wrap" mt={diagnosticsError ? 'sm' : 0}>
                  {capabilityIndicators.map((item) => (
                    <Badge key={item.label} size="xs" variant="light" color={item.tone}>
                      {item.label}: {item.value}
                    </Badge>
                  ))}
                </Group>

                {(capabilitySnapshot?.version || capabilitySnapshot?.discoveredAt) && (
                  <Text size="xs" c="dimmed" mt={6}>
                    {capabilitySnapshot?.version || '未知版本'}
                    {capabilitySnapshot?.discoveredAt ? ` · ${capabilitySnapshot.discoveredAt}` : ''}
                  </Text>
                )}

                {capabilitySnapshot?.notes?.length ? (
                  <Stack gap={4} mt="sm">
                    {capabilitySnapshot.notes.slice(0, 3).map((note) => (
                      <Text key={note} size="xs" c="dimmed">
                        {note}
                      </Text>
                    ))}
                  </Stack>
                ) : null}

                <Paper withBorder p="xs" radius="md" mt="sm">
                  <Text size="xs" fw={500}>当前会话语义</Text>
                  {sessionDebugSnapshot ? (
                    <Stack gap={4} mt="xs">
                      {debugFieldRows.map((row) => (
                        <Group key={row.label} gap={6} wrap="nowrap" align="flex-start">
                          <Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>
                            {row.label}
                          </Badge>
                          <Text size="xs" style={{ wordBreak: 'break-word' }}>
                            {row.value}
                          </Text>
                        </Group>
                      ))}
                      {sessionDebugSnapshot.notes.length > 0 && (
                        <Stack gap={4} mt={4}>
                          {sessionDebugSnapshot.notes.map((note) => (
                            <Text key={note} size="xs" c="dimmed">
                              {note}
                            </Text>
                          ))}
                        </Stack>
                      )}
                    </Stack>
                  ) : (
                    <Text size="xs" c="dimmed" mt="xs">
                      当前未选中可诊断会话；发送第一条消息或选中历史会话后会显示这里。
                    </Text>
                  )}
                </Paper>

                <Paper withBorder p="xs" radius="md" mt="sm">
                  <Text size="xs" fw={500}>最近 Trace</Text>
                  {traceEntries.length > 0 ? (
                    <Stack gap={6} mt="xs">
                      {traceEntries.slice(0, 5).map((entry) => (
                        <Paper key={entry.id} withBorder p="xs" radius="md">
                          <Group justify="space-between" gap="xs" wrap="wrap">
                            <Badge size="xs" variant="light" color="brand">
                              {formatChatTraceEntryLabel(entry)}
                            </Badge>
                            <Text size="xs" c="dimmed">
                              {new Date(entry.createdAt).toLocaleTimeString('zh-CN', {
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                              })}
                            </Text>
                          </Group>
                          {formatChatTraceEntryMeta(entry) && (
                            <Text size="xs" c="dimmed" mt={4}>
                              {formatChatTraceEntryMeta(entry)}
                            </Text>
                          )}
                          {entry.message && (
                            <Text size="xs" mt={4}>
                              {entry.message}
                            </Text>
                          )}
                        </Paper>
                      ))}
                    </Stack>
                  ) : (
                    <Text size="xs" c="dimmed" mt="xs">
                      当前还没有可显示的 trace 记录。
                    </Text>
                  )}
                </Paper>
              </ScrollArea.Autosize>
            </Paper>
          )}

          {showHistory && (
            <Paper withBorder p="sm" mt="sm" radius="lg" style={{ flex: '0 0 auto', minHeight: 0 }}>
              <Group justify="space-between" gap="sm">
                <div>
                  <Text size="xs" fw={500}>最近会话</Text>
                  <Text size="xs" c="dimmed" mt={4}>
                    展示最近 OpenClaw / Qclaw 会话，并明确区分本地会话与历史来源会话。
                  </Text>
                </div>
                <Button
                  variant="light" color="brand"
                  size="xs"
                  onClick={() => void handleRefreshChatData()}
                  loading={loadingSessions}
                  disabled={!canBrowseHistory}
                >
                  刷新
                </Button>
              </Group>

              <ScrollArea.Autosize mah="min(42vh, 420px)" mt="sm" type="auto" offsetScrollbars>
                <Stack gap="xs">
                  {sessions.length > 0 ? (
                    sessions.map((session) => {
                      const active = session.sessionId === activeSessionId
                      const historySummary = buildHistorySessionSummary(session)
                      return (
                        <Paper
                          key={session.sessionId}
                          withBorder
                          p="xs"
                          radius="md"
                          onClick={() => {
                            if (!canBrowseHistory) return
                            setTranscript(buildEmptyTranscript(session.sessionId))
                            setActiveSessionId(session.sessionId)
                            setShowHistory(false)
                          }}
                          style={{
                            cursor: canBrowseHistory ? 'pointer' : 'not-allowed',
                            borderColor: active ? 'var(--app-text-success)' : undefined,
                            backgroundColor: active ? 'var(--app-bg-bubble-user)' : undefined,
                          }}
                        >
                          <Group justify="space-between" align="flex-start" gap="sm" wrap="nowrap">
                            <div style={{ minWidth: 0 }}>
                              <Text size="xs" truncate>
                                {session.model || '默认模型'}
                              </Text>
                              <Text size="xs" c="dimmed" mt={2}>
                                {formatSessionTime(session.updatedAt)} · {session.sessionId.slice(0, 8)}
                                {formatSessionUsage(session) ? ` · ${formatSessionUsage(session)}` : ''}
                              </Text>
                              {historySummary.modelDetail && (
                                <Text size="xs" c="dimmed" mt={2}>{historySummary.modelDetail}</Text>
                              )}
                              {(() => {
                                const rowIntentState = resolveSessionModelIntentState({
                                  hasSession: true,
                                  canPatchModel: Boolean(session.canPatchModel),
                                  inFlightTargetModel:
                                    inFlightPatchState?.sessionId === session.sessionId
                                      ? inFlightPatchState.targetModel
                                      : '',
                                  selectedModel: session.selectedModel,
                                  confirmedModel: session.model,
                                  selectionOwnedByUser: false,
                                })
                                const firstSendTarget =
                                  session.localOnly && !session.canPatchModel && !session.hasLocalTranscript
                                    ? String(session.selectedModel || '').trim()
                                    : ''

                                if (rowIntentState.pendingTargetModel) {
                                  return (
                                    <Text size="xs" c="dimmed" mt={2}>
                                      {`待切换目标：${rowIntentState.pendingTargetModel}`}
                                    </Text>
                                  )
                                }

                                if (firstSendTarget) {
                                  return (
                                    <Text size="xs" c="dimmed" mt={2}>
                                      {`首发目标：${firstSendTarget}`}
                                    </Text>
                                  )
                                }

                                if (rowIntentState.unconfirmedSelectionModel) {
                                  return (
                                    <Text size="xs" c="dimmed" mt={2}>
                                      {`最近选择：${rowIntentState.unconfirmedSelectionModel}`}
                                    </Text>
                                  )
                                }

                                return null
                              })()}
                              {!session.canPatchModel && session.modelSwitchBlockedReason && (
                                <Text size="xs" c="dimmed" mt={2}>{session.modelSwitchBlockedReason}</Text>
                              )}
                            </div>
                            <Group gap={4} wrap="wrap" justify="flex-end" style={{ flexShrink: 0 }}>
                              <Badge
                                size="xs"
                                variant="light"
                                color={
                                  historySummary.originBadge === '本地记录'
                                    ? 'success'
                                    : historySummary.originBadge === '本地创建'
                                      ? 'blue'
                                      : historySummary.originBadge === 'OpenClaw 历史'
                                        ? active
                                          ? 'teal'
                                          : 'surface'
                                        : historySummary.originBadge.endsWith('会话')
                                        ? 'warning'
                                        : active
                                          ? 'teal'
                                          : 'surface'
                                }
                              >
                                {historySummary.originBadge}
                              </Badge>
                              {historySummary.secondaryBadge && (
                                <Badge size="xs" variant="light" color="brand">
                                  {historySummary.secondaryBadge}
                                </Badge>
                              )}
                              {active && historySummary.originBadge !== '本地记录' && (
                                <Badge size="xs" variant="light" color="teal">
                                  当前浏览
                                </Badge>
                              )}
                              {active && historySummary.originBadge === '本地记录' && (
                                <Badge size="xs" variant="light" color="teal">
                                  当前会话
                                </Badge>
                              )}
                            </Group>
                          </Group>
                        </Paper>
                      )
                    })
                  ) : (
                    <Paper withBorder p="sm" radius="md">
                      <Text size="xs" c="dimmed">
                        当前还没有最近会话。你发送第一条消息后，这里会自动出现历史记录。
                      </Text>
                    </Paper>
                  )}
                </Stack>
              </ScrollArea.Autosize>
            </Paper>
          )}

          <div
            ref={scrollRef as React.RefObject<HTMLDivElement>}
            style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 'var(--mantine-spacing-sm)' }}
          >
            <Paper withBorder p="sm" radius="lg" style={{ minHeight: '100%' }}>
            {showAvailabilityEmptyState ? (
              <div style={{ display: 'flex', height: '100%', minHeight: 150, flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center' }}>
                <Text size="sm">{resolvedAvailabilityMessage}</Text>
                <Text size="xs" c="dimmed" mt={4}>
                  {availabilityState === 'loading'
                    ? '正在读取当前模型与网关状态，请稍候。'
                    : isModelUnavailable
                    ? '先完成 AI 提供商配置后，这里就可以直接验证模型是否真正可用。'
                    : '启动网关后，这里会直接复用当前 OpenClaw 路由进行本地对话。'}
                </Text>
                {availabilityState !== 'loading' && (
                  <Group mt="sm" gap="xs">
                    {isModelUnavailable ? (
                    <Button variant="light" color="success" size="xs" onClick={onOpenSettings}>
                      去 AI 设置
                    </Button>
                  ) : (
                    <Button variant="light" color="warning" size="xs" onClick={() => void onEnsureGatewayRunning()}>
                      {isDegraded ? '重试连接' : '启动网关'}
                    </Button>
                    )}
                  </Group>
                )}
              </div>
            ) : showFullscreenLoader ? (
              <div style={{ display: 'flex', height: '100%', minHeight: 150, alignItems: 'center', justifyContent: 'center' }}>
                <Text size="xs" c="dimmed">正在准备聊天环境...</Text>
              </div>
            ) : renderedMessages.length > 0 ? (
              <Stack gap="md">
                {renderedMessages.map((message) => {
                  const displayText = resolveChatMessageDisplayText(message.text)
                  const messageText = displayText.body
                  if (!messageText) return null
                  const canCopyMessage = message.status !== 'pending' && Boolean(messageText.trim())
                  const usageLabel = formatUsageLabel(message.usage)
                  const statusLabel =
                    message.status === 'pending'
                      ? message.role === 'assistant'
                        ? '生成中'
                        : '发送中'
                      : message.status === 'error'
                        ? '发送失败'
                        : ''
                  const metaItems = [
                    formatMessageTime(message.createdAt, displayText.embeddedTimestamp),
                    statusLabel,
                    message.role === 'assistant' ? String(message.model || '').trim() : '',
                    message.role === 'assistant' ? usageLabel : '',
                  ].filter(Boolean)

                  return (
                    <div
                      key={message.id}
                      style={{ display: 'flex', justifyContent: message.role === 'user' ? 'flex-end' : 'flex-start' }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: message.role === 'user' ? 'flex-end' : 'flex-start',
                          gap: 6,
                          maxWidth: '82%',
                        }}
                      >
                        <Paper
                          radius="lg"
                          px="md"
                          py="sm"
                          maw="100%"
                          style={
                            message.role === 'user'
                              ? {
                                  backgroundColor: 'var(--app-bg-bubble-user)',
                                  color: 'var(--app-text-bubble-user)',
                                  border: message.status === 'pending' ? '1px solid var(--mantine-color-default-border)' : undefined,
                                }
                              : message.status === 'error'
                                ? {
                                    backgroundColor: 'rgba(239,68,68,0.1)',
                                    color: 'var(--app-text-danger)',
                                    border: '1px solid rgba(239,68,68,0.2)',
                                  }
                                : {
                                    backgroundColor: 'var(--app-bg-bubble-assistant)',
                                    color: 'var(--app-text-bubble-assistant)',
                                    border: message.status === 'pending' ? '1px solid var(--mantine-color-default-border)' : undefined,
                                    opacity: message.status === 'pending' ? 0.7 : undefined,
                                  }
                          }
                        >
                          <Text
                            size="sm"
                            lh={1.7}
                            style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                          >
                            {messageText}
                          </Text>
                        </Paper>

                        {(metaItems.length > 0 || canCopyMessage) && (
                          <Group
                            gap={8}
                            wrap="wrap"
                            justify={message.role === 'user' ? 'flex-end' : 'flex-start'}
                          >
                            {metaItems.map((item, index) => (
                              <Text key={`${message.id}:${index}:${item}`} size="xs" c="dimmed">
                                {item}
                              </Text>
                            ))}
                            {canCopyMessage && (
                              <Button
                                variant="subtle"
                                color="gray"
                                size="compact-xs"
                                onClick={() => void handleCopyMessage(message)}
                              >
                                {copiedMessageId === message.id ? '已复制' : '复制'}
                              </Button>
                            )}
                          </Group>
                        )}
                      </div>
                    </div>
                  )
                })}
              </Stack>
            ) : (
              <div style={{ display: 'flex', height: '100%', minHeight: 150, flexDirection: 'column', justifyContent: 'center' }}>
                <Text size="sm">
                  {activeSessionStatus.sessionOrigin === 'external-direct'
                    ? activeSessionStatus.willForkOnSend
                      ? '这是一个已有 OpenClaw 历史会话，但当前缺少可续写标识。'
                      : '这是一个已有 OpenClaw 历史会话，Direct Chat 会继续写入该会话。'
                    : activeSessionStatus.sessionOrigin === 'channel'
                      ? activeSessionStatus.willForkOnSend
                        ? '这是一个渠道来源的历史会话，Direct Chat 不会直接续写它。'
                        : '这是一个渠道来源会话，Direct Chat 会继续写入该会话。'
                      : activeSession
                        ? '这是当前 Qclaw 本地 direct 会话，新的消息会继续写入本地 transcript。'
                        : '这里会直接复用当前默认模型，让您快速验证模型是否正常响应。'}
                </Text>
                <Text size="xs" c="dimmed" mt={4}>
                  {activeSession
                    ? '您可以继续发送消息，确认 provider、模型和网关都已经打通。'
                    : '您可以先发一句简单问题，确认 provider、模型和网关都已经打通。'}
                </Text>
                {!activeSession && (
                  <Group mt="sm" gap="xs">
                    {QUICK_PROMPTS.map((prompt) => (
                      <Button
                        key={prompt}
                        variant="light"
                        size="xs"
                        onClick={() => {
                          setDraft(prompt)
                          void handleSend(prompt)
                        }}
                        disabled={sending}
                      >
                        {prompt}
                      </Button>
                    ))}
                  </Group>
                )}
              </div>
            )}
            </Paper>
          </div>

          <div
            style={{
              marginTop: 'var(--mantine-spacing-sm)',
              border: '1px solid var(--app-border)',
              borderRadius: 'var(--mantine-radius-lg)',
              backgroundColor: 'var(--app-bg-input)',
              transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
              overflow: 'hidden',
            }}
            onFocusCapture={(e) => {
              const container = e.currentTarget
              container.style.borderColor = 'var(--app-hover-border)'
              container.style.boxShadow = '0 0 8px var(--app-hover-glow)'
            }}
            onBlurCapture={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                const container = e.currentTarget
                container.style.borderColor = 'var(--app-border)'
                container.style.boxShadow = ''
              }
            }}
          >
            <div
              onPointerDown={(event) => {
                event.preventDefault()
                handleComposerResizePointerDown(event.clientY)
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '6px 0',
                cursor: 'ns-resize',
                touchAction: 'none',
                borderBottom: '1px solid var(--app-border)',
                background:
                  'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0) 100%)',
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 4,
                  borderRadius: '999px',
                  backgroundColor: 'var(--app-border-light)',
                }}
              />
            </div>
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                const shouldSend = enterSendMode === 'enter'
                  ? !event.shiftKey && !event.altKey
                  : enterSendMode === 'shiftEnter'
                    ? event.shiftKey
                    : event.altKey
                if (!shouldSend) return
                event.preventDefault()
                void handleSend()
              }}
              placeholder="输入消息"
              disabled={sending || !canSend}
              rows={4}
              variant="unstyled"
              styles={{
                input: {
                  padding: '14px 16px 12px',
                  fontSize: 'var(--mantine-font-size-sm)',
                  lineHeight: 1.6,
                  height: composerHeight,
                  minHeight: COMPOSER_MIN_HEIGHT,
                  maxHeight: getComposerMaxHeight(),
                  resize: 'none',
                  overflowY: 'auto',
                },
              }}
            />
            <div style={{ borderTop: '1px solid var(--app-border)', padding: '10px 12px' }}>
              <Stack gap={8}>
                {modelOptions.length > 0 && showComposerModelPicker && (
                  <Group gap="xs" wrap="nowrap" align="center">
                    <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>会话模型</Text>
                    <Select
                      size="xs"
                      variant="unstyled"
                      style={{ flex: 1, minWidth: 0 }}
                      data={modelOptions}
                      value={sessionModelSelectValue || null}
                      placeholder={
                        activeSession
                          ? sessionModelPresentation.modeLabel
                          : '发送首条消息后可切换'
                      }
                      onChange={(value) => void handleSessionModelChange(value)}
                      disabled={!canSend || sending || chatModelSwitching || !sessionModelSelectionEnabled}
                      aria-label="切换此会话模型"
                      comboboxProps={{ withinPortal: false }}
                      styles={{
                        input: {
                          minHeight: 32,
                          padding: '0 12px',
                          borderRadius: '999px',
                          border: '1px solid var(--app-border)',
                          backgroundColor: 'var(--app-bg-bubble-assistant)',
                          fontSize: 'var(--mantine-font-size-xs)',
                        },
                      }}
                    />
                  </Group>
                )}

                <Group justify="space-between" align="center" wrap="nowrap" gap="sm">
                  <Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 0 }} lineClamp={2}>
                    {composerHint}
                  </Text>

                  <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
                    {modelOptions.length > 0 && (
                      <Tooltip label={showComposerModelPicker ? '收起会话模型' : '展开会话模型'} withArrow>
                        <ActionIcon
                          variant="subtle"
                          size="sm"
                          color="gray"
                          onClick={() => setShowComposerModelPicker((current) => !current)}
                        >
                          {showComposerModelPicker ? <IconChevronUp size={15} /> : <IconChevronDown size={15} />}
                        </ActionIcon>
                      </Tooltip>
                    )}
                    {lastRetryText && !sending && (
                      <Tooltip label="重试上一条" withArrow>
                        <ActionIcon variant="subtle" size="sm" color="brand" onClick={() => void handleRetry()}>
                          <IconRefresh size={15} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                    {activeSession?.hasLocalTranscript && (
                      <Tooltip label="清空本地记录" withArrow>
                        <ActionIcon
                          variant="subtle"
                          size="sm"
                          color="brand"
                          onClick={() => void handleClearLocalTranscript()}
                          loading={clearingTranscript}
                          disabled={sending}
                        >
                          <IconTrash size={15} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                    {sending ? (
                      <ActionIcon
                        variant="filled"
                        color="warning"
                        size="lg"
                        radius="xl"
                        onClick={() => void handleCancelSend()}
                        disabled={stopping}
                        loading={stopping}
                      >
                        <IconPlayerStop size={16} />
                      </ActionIcon>
                    ) : (
                      <ActionIcon
                        variant="filled"
                        color="brand"
                        size="lg"
                        radius="xl"
                        onClick={() => void handleSend()}
                        disabled={!draft.trim() || !canSend || chatModelSwitching}
                      >
                        <IconSend size={16} />
                      </ActionIcon>
                    )}
                  </Group>
                </Group>
              </Stack>
            </div>
          </div>
      </div>
    </Card>
  )
}
