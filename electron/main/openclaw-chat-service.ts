import type {
  ChatAuthorityKind,
  ChatCapabilitySnapshot,
  ChatExternalTranscriptErrorCode,
  ChatFailureClass,
  ChatHistorySource,
  ChatMessage,
  ChatPatchSessionModelRequest,
  ChatPatchSessionModelResult,
  ChatSessionDebugSnapshot,
  ChatSendRequest,
  ChatSendResult,
  ChatSessionSummary,
  ChatStreamEvent,
  ChatThinkingLevel,
  ChatTraceEntry,
  ChatTranscript,
  ChatUsage,
  ChatCachePresence,
  DashboardChatAvailability,
  DashboardChatAvailabilityState,
} from '../../src/shared/chat-panel'
import type { OpenClawDiscoveryResult } from '../../src/shared/openclaw-phase1'
import { parseChatSessionSourceFromKey } from '../../src/shared/dashboard-chat-session-source'
import {
  CHAT_REPLY_REJECTED_PATH_PATTERN,
  sanitizeAssistantRawFallbackText,
  sanitizeAssistantVisibleText,
} from '../../src/shared/chat-visible-text'
import {
  resolveModelsPageCatalogState,
  resolveModelsPageActiveModel,
  resolveVisibleConfiguredActiveModel,
} from '../../src/shared/model-catalog-state'
import { getModelProviderAliasCandidates } from '../../src/lib/model-provider-aliases'
import {
  areRuntimeModelsEquivalent,
  findEquivalentRuntimeModelKey,
  collectRuntimeConnectedModelKeys,
  extractRuntimeDefaultModelKey,
  resolvePreferredRuntimeDefaultModelKey,
  resolveRuntimeWritableModelKey,
} from '../../src/lib/model-runtime-resolution'
import { listAllModelCatalogItems } from '../../src/lib/model-catalog-pagination'
import { readChatThinkingCompat, writeChatThinkingCompat } from './chat-thinking-compat-store'
import { pickFallbackThinkingFromError, resolveChatThinking } from './chat-thinking-policy'
import { getCliFailureMessage, parseJsonFromOutput } from './openclaw-command-output'
import {
  hasSendTimeModelOverride,
  resolveSendTimeModelOverrideErrorMessage,
} from './chat-model-switching-invariant'
import { createCliChatTransport } from './chat-transport/cli-chat-transport'
import {
  callGatewayRpcViaSocket,
  createGatewayStreamingChatTransport,
} from './chat-transport/gateway-streaming-chat-transport'
import type { ChatTransport, CliLikeResult, RunStreamingCommand } from './chat-transport/chat-transport-types'
import { loadOpenClawCapabilities, type OpenClawCapabilities } from './openclaw-capabilities'
import type { ModelConfigCommandResult } from './openclaw-model-config'
import { getModelStatus } from './openclaw-model-config'
import { getModelCatalog } from './openclaw-model-catalog'
import { gatewayHealth, readConfig, readEnvFile, runCli, runCliStreaming, type RunCliStreamOptions } from './cli'
import { discoverOpenClawInstallations } from './openclaw-install-discovery'
import {
  callGatewayRpcViaControlUiBrowser,
  runGatewayChatViaControlUiBrowser,
} from './openclaw-control-ui-rpc'
import { ensureGatewayRunning } from './openclaw-gateway-service'
import { getOpenClawUpstreamModelState } from './openclaw-upstream-model-state'
import {
  appendLocalChatMessages,
  clearLocalChatTranscript,
  ensureLocalChatSession,
  listLocalChatSessionStates,
  type LocalChatSessionState,
  readLocalChatSessionState,
  readLocalChatTranscript,
} from './qclaw-chat-store'
import { setActiveAbortController as trackActiveAbortController } from './command-control'

const { randomUUID } = process.getBuiltinModule('node:crypto') as typeof import('node:crypto')

const DEFAULT_CHAT_AGENT_ID = 'main'
const CHAT_SEND_TIMEOUT_MS = 10 * 60 * 1000
const CHAT_SESSIONS_TIMEOUT_MS = 20_000
const CHAT_EXTERNAL_TRANSCRIPT_LIMIT = 200
const CHAT_GATEWAY_CALL_TIMEOUT_MS = 20_000
const CHAT_AVAILABILITY_DEGRADED_GRACE_MS = 15_000
const CHAT_AVAILABILITY_OFFLINE_FAILURE_THRESHOLD = 2
const CHAT_AVAILABILITY_MODEL_STATUS_CACHE_TTL_MS = 12_000
const CHAT_AVAILABILITY_SELECTABLE_MODELS_CACHE_TTL_MS = 12_000
const CHAT_MODEL_SWITCH_UNSUPPORTED_MESSAGE = '当前 OpenClaw 版本还不支持在聊天窗口内切换模型，请升级 OpenClaw 后重试'
const CHAT_SESSION_MODEL_PATCH_UNAVAILABLE_MESSAGE = '当前会话还没有可切换的 OpenClaw session，请先发送一条消息后再试'
const CHAT_TRACE_HISTORY_LIMIT = 200

interface ChatSelectableModelResolution {
  connectedModels: string[]
  defaultModel?: string
}

interface ChatAvailabilityTracker {
  consecutiveGatewayFailures: number
  lastHealthyAt: number
  lastHealthyAvailability: DashboardChatAvailability | null
}

const chatAvailabilityTracker: ChatAvailabilityTracker = {
  consecutiveGatewayFailures: 0,
  lastHealthyAt: 0,
  lastHealthyAvailability: null,
}

const dashboardChatAvailabilityModelStatusCache: {
  expiresAt: number
  value: ModelConfigCommandResult<Record<string, any>> | null
  inFlight: Promise<ModelConfigCommandResult<Record<string, any>>> | null
} = {
  expiresAt: 0,
  value: null,
  inFlight: null,
}

const dashboardChatAvailabilitySelectableModelsCache: {
  expiresAt: number
  fingerprint: string
  value: ChatSelectableModelResolution | null
  inFlight: Promise<ChatSelectableModelResolution> | null
  inFlightFingerprint: string
} = {
  expiresAt: 0,
  fingerprint: '',
  value: null,
  inFlight: null,
  inFlightFingerprint: '',
}

export function resetDashboardChatAvailabilityTrackerForTests(): void {
  chatAvailabilityTracker.consecutiveGatewayFailures = 0
  chatAvailabilityTracker.lastHealthyAt = 0
  chatAvailabilityTracker.lastHealthyAvailability = null
  dashboardChatAvailabilityModelStatusCache.expiresAt = 0
  dashboardChatAvailabilityModelStatusCache.value = null
  dashboardChatAvailabilityModelStatusCache.inFlight = null
  dashboardChatAvailabilitySelectableModelsCache.expiresAt = 0
  dashboardChatAvailabilitySelectableModelsCache.fingerprint = ''
  dashboardChatAvailabilitySelectableModelsCache.value = null
  dashboardChatAvailabilitySelectableModelsCache.inFlight = null
  dashboardChatAvailabilitySelectableModelsCache.inFlightFingerprint = ''
  chatTraceStore.entries = []
  chatTraceStore.nextId = 1
}

function appendChatTrace(entry: Omit<ChatTraceEntry, 'id' | 'createdAt'>, now = Date.now()): ChatTraceEntry {
  const nextEntry: ChatTraceEntry = {
    id: `chat-trace-${chatTraceStore.nextId++}`,
    createdAt: now,
    ...entry,
  }
  chatTraceStore.entries.push(nextEntry)
  if (chatTraceStore.entries.length > CHAT_TRACE_HISTORY_LIMIT) {
    chatTraceStore.entries.splice(0, chatTraceStore.entries.length - CHAT_TRACE_HISTORY_LIMIT)
  }
  return nextEntry
}

export function listChatTraceEntries(limit = 50): ChatTraceEntry[] {
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50
  return chatTraceStore.entries.slice(-normalizedLimit).reverse()
}

interface GatewayHealthLike {
  running: boolean
  raw: string
}

interface GatewayEnsureLike extends CliLikeResult {
  running: boolean
}

interface OpenClawChatServiceOptions {
  runCommand?: (args: string[], timeout?: number) => Promise<CliLikeResult>
  runStreamingCommand?: RunStreamingCommand
  chatTransport?: ChatTransport
  callGatewayRpc?: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>
  getGatewayHealth?: () => Promise<GatewayHealthLike>
  ensureGateway?: () => Promise<GatewayEnsureLike>
  readModelStatus?: () => Promise<ModelConfigCommandResult<Record<string, any>>>
  loadCapabilities?: () => Promise<OpenClawCapabilities>
  discoverOpenClaw?: () => Promise<OpenClawDiscoveryResult>
  now?: () => number
  emit?: (event: ChatStreamEvent) => void
  chatHistoryPrimaryEnabled?: boolean
  repairAgentAuthProfiles?: (params: {
    providerIds: string[]
    agentId?: string
  }) => Promise<{
    ok: boolean
    repaired: boolean
    error?: string
    importedProfileIds?: string[]
    importedProviders?: string[]
    sourceAuthStorePaths?: string[]
    updatedAuthStorePaths?: string[]
  }>
  repairMainAuthProfiles?: (providerIds: string[]) => Promise<{
    ok: boolean
    repaired: boolean
    error?: string
    importedProfileIds?: string[]
    importedProviders?: string[]
    sourceAuthStorePaths?: string[]
  }>
}

interface ChatTraceStore {
  entries: ChatTraceEntry[]
  nextId: number
}

const chatTraceStore: ChatTraceStore = {
  entries: [],
  nextId: 1,
}

interface OpenClawSessionsPayload {
  sessions?: unknown[]
}

interface OpenClawSessionCandidate {
  sessionId: string
  sessionKey?: string
  agentId: string
  model?: string
  updatedAt: number
  kind: ChatSessionSummary['kind']
  totalTokens?: number
  contextTokens?: number
}

interface ResolvedTransportSession {
  conversationId: string
  transportSessionId: string
  shouldSeedTransport: boolean
}

interface ResolvedPatchableSessionIdentity {
  sessionKey?: string
  source: 'trusted' | 'legacy-transport' | 'none'
}

interface ExternalTranscriptLoadResult {
  ok: boolean
  messages: ChatMessage[]
  limit: number
  truncated: boolean
  source?: ChatHistorySource
  errorCode?: ChatExternalTranscriptErrorCode
  errorMessage?: string
}

interface UpstreamCreatedChatSession {
  sessionId: string
  sessionKey: string
  agentId: string
  model?: string
}

interface UpstreamCreateChatSessionResult {
  ok: boolean
  session?: UpstreamCreatedChatSession
  fallbackSafe?: boolean
  outcomeUnknown?: boolean
  message?: string
  error?: Error
}

function classifyChatFailureClass(message: string): ChatFailureClass {
  const normalized = String(message || '').trim().toLowerCase()
  if (!normalized) return 'none'
  if (/origin not allowed|missing scope:\s*operator\.admin|operator\.admin|forbidden|unauthorized|401|403/.test(normalized)) {
    return 'permission'
  }
  if (/gateway closed|1006|econnrefused|connection refused|offline|unreachable|token mismatch|auth/.test(normalized)) {
    return 'connection'
  }
  if (/session-key-missing|session key|not found|missing session|不可续写|不可继续|继续失败/.test(normalized)) {
    return 'semantic'
  }
  if (/unsupported|method not found|unknown method|不支持|版本/.test(normalized)) {
    return 'capability'
  }
  return 'unknown'
}

function resolveFailureClassFromTranscriptErrorCode(
  errorCode: ChatExternalTranscriptErrorCode | undefined
): ChatFailureClass {
  if (!errorCode) return 'none'
  if (errorCode === 'gateway-offline' || errorCode === 'gateway-auth-failed') return 'connection'
  if (errorCode === 'session-key-missing' || errorCode === 'session-not-found') return 'semantic'
  return 'unknown'
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function toError(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) return value
  const normalized = String(value || '').trim()
  return new Error(normalized || fallbackMessage)
}

function resolveCreateChatSessionFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || '创建新会话失败'
  }
  return String(error || '').trim() || '创建新会话失败'
}

function isCreateSessionFallbackSafeMessage(message: string): boolean {
  const normalized = String(message || '').trim().toLowerCase()
  if (!normalized) return false
  return /origin not allowed|missing scope:\s*operator\.admin|operator\.admin|forbidden|unauthorized|401|403/.test(
    normalized
  ) || /\bunsupported\b|\bmethod not found\b|\bunknown method\b|不支持|版本/.test(normalized)
}

function normalizeCreatedChatSession(result: unknown): UpstreamCreatedChatSession | null {
  const root = toRecord(result)
  if (!root) return null

  const entry = toRecord(root.entry)
  const session = toRecord(root.session)
  const sessionId =
    toOptionalString(root.sessionId) ||
    toOptionalString(root.id) ||
    toOptionalString(session?.sessionId) ||
    toOptionalString(session?.id) ||
    toOptionalString(entry?.sessionId) ||
    toOptionalString(entry?.id)
  const sessionKey =
    toOptionalString(root.key) ||
    toOptionalString(root.sessionKey) ||
    toOptionalString(session?.key) ||
    toOptionalString(session?.sessionKey) ||
    toOptionalString(entry?.key) ||
    toOptionalString(entry?.sessionKey)
  if (!sessionId || !sessionKey) return null

  return {
    sessionId,
    sessionKey,
    agentId:
      toOptionalString(root.agentId) ||
      toOptionalString(session?.agentId) ||
      toOptionalString(entry?.agentId) ||
      DEFAULT_CHAT_AGENT_ID,
    model:
      toOptionalString(root.model) || toOptionalString(session?.model) || toOptionalString(entry?.model) || undefined,
  }
}

function resolveChatHistorySource(params: {
  localTranscript?: ChatTranscript | null
  matchedSession?: ChatSessionSummary | null
}): ChatHistorySource {
  if (params.localTranscript?.hasLocalTranscript) return 'local-cache'
  if (String(params.matchedSession?.sessionKey || '').trim()) return 'sessions-get'
  return 'none'
}

function resolveOperationHistorySource(params: {
  localSessionState?: LocalChatSessionState | null
  localTranscript?: ChatTranscript | null
  matchedSession?: ChatSessionSummary | null
}): ChatHistorySource {
  if ((params.localSessionState?.messages.length || 0) > 0) return 'local-cache'
  return resolveChatHistorySource({
    localTranscript: params.localTranscript,
    matchedSession: params.matchedSession,
  })
}

function resolveChatAuthorityKind(params: {
  matchedSession?: ChatSessionSummary | null
  localSessionState?: LocalChatSessionState | null
  localTranscript?: ChatTranscript | null
}): ChatAuthorityKind {
  const matchedSession = params.matchedSession
  const hasLocalState = Boolean(params.localSessionState)
  const hasLocalTranscript =
    params.localTranscript?.hasLocalTranscript === true || params.localSessionState?.hasLocalTranscript === true
  const trustedSessionKey = resolveTrustedChatSessionKey({
    matchedSession,
    localSessionState: params.localSessionState,
    localTranscript: params.localTranscript,
  })
  const resolvedKind = matchedSession?.kind || params.localSessionState?.kind || 'direct'
  const hasTrustedUpstreamIdentity = Boolean(trustedSessionKey)

  if (!matchedSession || matchedSession.localOnly === true) {
    if (hasTrustedUpstreamIdentity) {
      if (isChannelBackedChatSession({ sessionKey: trustedSessionKey, kind: resolvedKind })) {
        return hasLocalTranscript ? 'mixed' : 'upstream-channel'
      }
      if (resolvedKind === 'direct') {
        return hasLocalTranscript ? 'mixed' : 'upstream-direct'
      }
      return hasLocalTranscript ? 'mixed' : 'unknown'
    }
    if (hasLocalState || hasLocalTranscript) return 'local-cache-only'
    return 'unknown'
  }

  if (isChannelBackedChatSession({ sessionKey: matchedSession.sessionKey, kind: matchedSession.kind })) {
    return hasLocalTranscript ? 'mixed' : 'upstream-channel'
  }

  if (matchedSession.kind === 'direct') {
    return hasLocalTranscript ? 'mixed' : 'upstream-direct'
  }

  return hasLocalTranscript ? 'mixed' : 'unknown'
}

function resolveChatCachePresence(params: {
  localSessionState?: LocalChatSessionState | null
  localTranscript?: ChatTranscript | null
}): ChatCachePresence {
  if (params.localTranscript?.hasLocalTranscript) {
    return 'local-transcript'
  }
  if (params.localSessionState?.upstreamConfirmed === true && params.localSessionState?.hasLocalTranscript) {
    return 'local-transcript'
  }
  if (params.localSessionState) return 'local-shell'
  return 'none'
}

function resolveChatCanContinue(params: {
  matchedSession?: ChatSessionSummary | null
  localSessionState?: LocalChatSessionState | null
  localTranscript?: ChatTranscript | null
}): boolean {
  return Boolean(
    resolveTrustedChatSessionKey({
      matchedSession: params.matchedSession,
      localSessionState: params.localSessionState,
      localTranscript: params.localTranscript,
    })
  )
}

function resolveLegacySemanticsActive(params: {
  localSessionState?: LocalChatSessionState | null
  localTranscript?: ChatTranscript | null
  matchedSession?: ChatSessionSummary | null
}): boolean {
  const localSessionState = params.localSessionState
  if (!localSessionState) return false
  const localTransportSessionId = String(localSessionState.transportSessionId || '').trim()
  const trustedSessionKey = resolveTrustedChatSessionKey({
    matchedSession: params.matchedSession,
    localSessionState,
    localTranscript: params.localTranscript,
  })
  if (localTransportSessionId && !trustedSessionKey) return true
  if (params.localTranscript?.hasLocalTranscript && params.matchedSession?.hasLocalTranscript !== true && localTransportSessionId) {
    return true
  }
  return false
}

function isTransportDerivedSessionKey(params: {
  sessionKey?: string
  transportSessionId?: string
  agentId?: string
}): boolean {
  const sessionKey = String(params.sessionKey || '').trim()
  const transportSessionId = String(params.transportSessionId || '').trim()
  if (!sessionKey || !transportSessionId) return false
  return sessionKey === buildGatewayChatSessionKey(params.agentId || DEFAULT_CHAT_AGENT_ID, transportSessionId)
}

function resolveTrustedChatSessionKey(params: {
  matchedSession?: ChatSessionSummary | null
  localSessionState?: LocalChatSessionState | null
  localTranscript?: ChatTranscript | null
}): string | undefined {
  const matchedSessionKey = String(params.matchedSession?.sessionKey || '').trim()
  const localTransportSessionId = String(params.localSessionState?.transportSessionId || '').trim()
  const agentId =
    params.localSessionState?.agentId || params.matchedSession?.agentId || params.localTranscript?.agentId || DEFAULT_CHAT_AGENT_ID

  if (matchedSessionKey) {
    if (params.matchedSession?.localOnly !== true) return matchedSessionKey
    if (params.localSessionState?.upstreamConfirmed === true) {
      return matchedSessionKey
    }
    if (
      !isTransportDerivedSessionKey({
        sessionKey: matchedSessionKey,
        transportSessionId: localTransportSessionId,
        agentId,
      })
    ) {
      return matchedSessionKey
    }
  }

  const localSessionKey = String(params.localSessionState?.sessionKey || params.localTranscript?.sessionKey || '').trim()
  if (!localSessionKey) return undefined
  if (params.localSessionState?.upstreamConfirmed === true) {
    return localSessionKey
  }
  if (
    isTransportDerivedSessionKey({
      sessionKey: localSessionKey,
      transportSessionId: localTransportSessionId,
      agentId,
    })
  ) {
    return undefined
  }
  return localSessionKey
}

function resolveLegacyTransportBridgeSessionKey(params: {
  matchedSession?: ChatSessionSummary | null
  localSessionState?: LocalChatSessionState | null
  localTranscript?: ChatTranscript | null
}): string | undefined {
  const trustedSessionKey = resolveTrustedChatSessionKey(params)
  if (trustedSessionKey) return undefined

  const localSessionState = params.localSessionState
  const localTransportSessionId = String(localSessionState?.transportSessionId || '').trim()
  if (!localTransportSessionId) return undefined
  if ((localSessionState?.messages.length || 0) <= 0) return undefined

  return (
    buildGatewayChatSessionKey(
      localSessionState?.agentId || params.matchedSession?.agentId || params.localTranscript?.agentId || DEFAULT_CHAT_AGENT_ID,
      localTransportSessionId
    ) || undefined
  )
}

function buildUnifiedChatSemantics(params: {
  matchedSession?: ChatSessionSummary | null
  localSessionState?: LocalChatSessionState | null
  localTranscript?: ChatTranscript | null
  externalTranscriptErrorCode?: ChatExternalTranscriptErrorCode
}): Pick<
  ChatSessionSummary,
  | 'canPatchModel'
  | 'canContinue'
  | 'authorityKind'
  | 'cachePresence'
  | 'legacySemanticsActive'
  | 'modelSwitchBlockedReason'
> {
  const matchedSession = params.matchedSession || null
  const localSessionState = params.localSessionState || null
  const localTranscript = params.localTranscript || null
  const hasLocalTranscript =
    localTranscript?.hasLocalTranscript === true || localSessionState?.hasLocalTranscript === true
  const trustedSessionKey = resolveTrustedChatSessionKey({
    matchedSession,
    localSessionState,
    localTranscript,
  })
  const legacyTransportBridgeSessionKey = resolveLegacyTransportBridgeSessionKey({
    matchedSession,
    localSessionState,
    localTranscript,
  })
  const modelSwitchState = resolveChatModelSwitchState({
    sessionKey: trustedSessionKey,
    hasLocalTranscript,
    localOnly: matchedSession?.localOnly ?? (!matchedSession && Boolean(localSessionState || localTranscript)),
    kind: matchedSession?.kind || localSessionState?.kind || 'direct',
    externalTranscriptErrorCode: params.externalTranscriptErrorCode,
    hasLegacyTransportBridge: Boolean(legacyTransportBridgeSessionKey),
  })

  return {
    canPatchModel: modelSwitchState.canPatchModel,
    modelSwitchBlockedReason: modelSwitchState.modelSwitchBlockedReason,
    canContinue: resolveChatCanContinue({
      matchedSession,
      localSessionState,
      localTranscript,
    }),
    authorityKind: resolveChatAuthorityKind({
      matchedSession,
      localSessionState,
      localTranscript,
    }),
    cachePresence: resolveChatCachePresence({
      localSessionState,
      localTranscript,
    }),
    legacySemanticsActive: resolveLegacySemanticsActive({
      matchedSession,
      localSessionState,
      localTranscript,
    }),
  }
}

export async function getChatCapabilitySnapshot(
  options: OpenClawChatServiceOptions = {}
): Promise<ChatCapabilitySnapshot> {
  const loadCapabilities = options.loadCapabilities ?? loadOpenClawCapabilities
  try {
    const capabilities = await loadCapabilities()
    const supportsChatHistory =
      resolveChatHistoryPrimaryEnabled(options) && inferSupportsChatHistory(capabilities)
    return {
      version: capabilities.version,
      discoveredAt: capabilities.discoveredAt,
      supportsSessionsPatch: capabilities.supports.chatInThreadModelSwitch,
      supportsChatHistory,
      supportsGatewayChatSend: true,
      supportsGatewayRpc: true,
      notes: [
        'Phase 0 contract inventory: sessions.patch is supported when chatInThreadModelSwitch is true.',
        supportsChatHistory
          ? 'chat.history primary path is enabled behind the current history flag and capability gate.'
          : 'chat.history remains disabled until both the history flag and capability gate are satisfied.',
        'gateway chat.send and gateway call based flows are implemented in Qclaw main process today.',
      ],
    }
  } catch (error) {
    return {
      supportsSessionsPatch: false,
      supportsChatHistory: false,
      supportsGatewayChatSend: true,
      supportsGatewayRpc: true,
      notes: [
        `Failed to load OpenClaw capabilities: ${error instanceof Error ? error.message : String(error)}`,
      ],
    }
  }
}

export async function getChatSessionDebugSnapshot(
  sessionId: string,
  options: OpenClawChatServiceOptions = {}
): Promise<ChatSessionDebugSnapshot> {
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedSessionId) {
    throw new Error('sessionId is required')
  }

  const resolved = await resolveMergedChatSessions(options)
  const scopeKey = resolved.scopeKey
  const matchedSession = resolved.sessions.find((session) => session.sessionId === normalizedSessionId) || null
  const localSessionState = await readLocalChatSessionState(scopeKey, normalizedSessionId)
  const localTranscript = await readLocalChatTranscript(scopeKey, normalizedSessionId)
  const historySource = resolveChatHistorySource({
    localTranscript,
    matchedSession,
  })
  const unifiedSemantics = buildUnifiedChatSemantics({
    matchedSession,
    localSessionState,
    localTranscript,
  })
  const failureClass = resolveFailureClassFromTranscriptErrorCode(localTranscript?.externalTranscriptErrorCode)
  const notes: string[] = []

  if (unifiedSemantics.authorityKind === 'mixed') {
    notes.push('This session currently mixes upstream metadata with local cache state.')
  }
  if (unifiedSemantics.authorityKind === 'local-cache-only') {
    notes.push('This session currently resolves from Qclaw local cache state without upstream authority.')
  }
  if (unifiedSemantics.cachePresence === 'local-transcript') {
    notes.push('Local transcript cache exists and can currently influence transcript reads.')
  }
  if (unifiedSemantics.legacySemanticsActive) {
    notes.push('Legacy transport/session fallback semantics are active for this session.')
  }

  return {
    requestedSessionId: normalizedSessionId,
    trackedSessionId: normalizedSessionId,
    resolvedSessionId: matchedSession?.sessionId || localSessionState?.sessionId || normalizedSessionId,
    resolvedSessionKey:
      String(matchedSession?.sessionKey || '').trim() ||
      String(localSessionState?.sessionKey || '').trim() ||
      undefined,
    historySource,
    confirmedModel:
      String(matchedSession?.model || '').trim() ||
      String(localSessionState?.model || '').trim() ||
      undefined,
    intentSelectedModel: String(localSessionState?.selectedModel || '').trim() || undefined,
    canPatchModel: Boolean(unifiedSemantics.canPatchModel),
    canContinue: Boolean(unifiedSemantics.canContinue),
    authorityKind: unifiedSemantics.authorityKind || 'unknown',
    cachePresence: unifiedSemantics.cachePresence || 'none',
    failureClass,
    legacySemanticsActive: Boolean(unifiedSemantics.legacySemanticsActive),
    updatedAt: Math.max(matchedSession?.updatedAt || 0, localSessionState?.updatedAt || 0, localTranscript?.updatedAt || 0),
    fieldStates: {
      requestedSessionId: 'intent',
      trackedSessionId: 'derived',
      resolvedSessionId: 'confirmed',
      resolvedSessionKey: 'confirmed',
      historySource: 'derived',
      confirmedModel: 'confirmed',
      intentSelectedModel: 'intent',
      canPatchModel: 'derived',
      canContinue: 'derived',
      authorityKind: 'derived',
      cachePresence: 'cache',
      failureClass: 'derived',
      legacySemanticsActive: 'derived',
    },
    notes,
  }
}

function normalizeModelList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
}

function isModelAllowedByStatus(model: string, allowedModels: Iterable<string>): boolean {
  const normalizedModel = String(model || '').trim()
  if (!normalizedModel) return false
  const candidates = Array.from(allowedModels)
  if (candidates.includes(normalizedModel)) return true
  return Boolean(findEquivalentRuntimeModelKey(normalizedModel, candidates))
}

export function buildDashboardChatAvailabilityFromStatus(params: {
  gatewayRunning: boolean
  modelStatus: ModelConfigCommandResult<Record<string, any>>
  connectedModelsOverride?: unknown
  defaultModelOverride?: unknown
}): DashboardChatAvailability {
  const connectedModels = Array.isArray(params.connectedModelsOverride)
    ? normalizeModelList(params.connectedModelsOverride)
    : (params.modelStatus.ok ? collectRuntimeConnectedModelKeys(params.modelStatus.data || {}) : [])
  const defaultModelOverride = String(params.defaultModelOverride || '').trim()
  const defaultModel = defaultModelOverride
    || (params.modelStatus.ok
      ? resolvePreferredRuntimeDefaultModelKey(params.modelStatus.data || {}) || undefined
      : undefined)

  if (!params.modelStatus.ok) {
    return {
      state: 'error',
      ready: false,
      canSend: false,
      reason: 'model-status-error',
      gatewayRunning: params.gatewayRunning,
      connectedModels,
      defaultModel,
      agentId: DEFAULT_CHAT_AGENT_ID,
      message: params.modelStatus.message || params.modelStatus.stderr || '读取模型状态失败',
    }
  }

  if (connectedModels.length === 0) {
    return {
      state: 'no-model',
      ready: false,
      canSend: false,
      reason: 'no-configured-model',
      gatewayRunning: params.gatewayRunning,
      connectedModels,
      defaultModel,
      agentId: DEFAULT_CHAT_AGENT_ID,
      message: '当前还没有可直接对话的模型',
    }
  }

  if (!params.gatewayRunning) {
    return {
      state: 'offline',
      ready: false,
      canSend: false,
      reason: 'gateway-offline',
      gatewayRunning: false,
      connectedModels,
      defaultModel,
      agentId: DEFAULT_CHAT_AGENT_ID,
      message: '模型已配置，但网关当前未运行',
    }
  }

  return {
    state: 'ready',
    ready: true,
    canSend: true,
    reason: 'ready',
    gatewayRunning: true,
    connectedModels,
    defaultModel,
    agentId: DEFAULT_CHAT_AGENT_ID,
  }
}

async function resolveChatSelectableModelsFromModelsPage(params: {
  modelStatus: ModelConfigCommandResult<Record<string, any>> | null
  config: Record<string, any> | null
  envVars: Record<string, string> | null
}): Promise<ChatSelectableModelResolution> {
  const { config, envVars } = params
  const [catalogResult] = await Promise.allSettled([
    listAllModelCatalogItems(
      (query) => getModelCatalog({ query }),
      { includeUnavailable: true }
    ),
  ])
  const catalog = catalogResult.status === 'fulfilled' ? catalogResult.value : []
  const statusData = params.modelStatus?.ok ? params.modelStatus.data || {} : null
  const activeModelHint = resolveModelsPageActiveModel(statusData, config)

  if (catalog.length === 0) {
    return {
      connectedModels: [],
      defaultModel: activeModelHint || undefined,
    }
  }

  const catalogState = resolveModelsPageCatalogState({
    catalog,
    envVars,
    config,
    statusData,
    preferredModelKey: activeModelHint,
    mode: 'available',
  })
  const connectedModels = normalizeModelList(catalogState.visibleCatalog.map((item) => item.key))
  const defaultModel = resolveVisibleConfiguredActiveModel({
    statusData,
    configData: config,
    configuredProviders: catalogState.configuredProviders,
    visibleCatalog: catalogState.visibleCatalog,
    fullCatalog: catalogState.scopedCatalog,
  }) || activeModelHint || undefined

  return {
    connectedModels,
    defaultModel,
  }
}

async function readAvailabilitySelectableModelsCacheContext(params: {
  modelStatus: ModelConfigCommandResult<Record<string, any>> | null
}): Promise<{
  config: Record<string, any> | null
  envVars: Record<string, string> | null
  fingerprint: string
}> {
  const [configResult, envResult] = await Promise.allSettled([readConfig(), readEnvFile()])
  const config = configResult.status === 'fulfilled' ? configResult.value : null
  const envVars = envResult.status === 'fulfilled' ? envResult.value : null
  const fingerprint = JSON.stringify({
    config,
    envKeys: Object.entries(envVars || {})
      .filter(([, value]) => Boolean(String(value || '').trim()))
      .map(([key]) => key)
      .sort(),
    statusData: params.modelStatus?.ok ? params.modelStatus.data || {} : null,
  })

  return {
    config,
    envVars,
    fingerprint,
  }
}

async function readCachedAvailabilitySelectableModels(params: {
  currentTime: number
  fingerprint: string
  resolver: () => Promise<ChatSelectableModelResolution>
}): Promise<ChatSelectableModelResolution> {
  if (
    dashboardChatAvailabilitySelectableModelsCache.value
    && dashboardChatAvailabilitySelectableModelsCache.fingerprint === params.fingerprint
    && params.currentTime < dashboardChatAvailabilitySelectableModelsCache.expiresAt
  ) {
    return dashboardChatAvailabilitySelectableModelsCache.value
  }

  if (
    dashboardChatAvailabilitySelectableModelsCache.inFlight
    && dashboardChatAvailabilitySelectableModelsCache.inFlightFingerprint === params.fingerprint
  ) {
    return dashboardChatAvailabilitySelectableModelsCache.inFlight
  }

  const inFlight = params.resolver()
    .then((result) => {
      if (dashboardChatAvailabilitySelectableModelsCache.inFlightFingerprint === params.fingerprint) {
        dashboardChatAvailabilitySelectableModelsCache.value = result
        dashboardChatAvailabilitySelectableModelsCache.expiresAt =
          params.currentTime + CHAT_AVAILABILITY_SELECTABLE_MODELS_CACHE_TTL_MS
        dashboardChatAvailabilitySelectableModelsCache.fingerprint = params.fingerprint
      }
      return result
    })
    .finally(() => {
      if (dashboardChatAvailabilitySelectableModelsCache.inFlight === inFlight) {
        dashboardChatAvailabilitySelectableModelsCache.inFlight = null
        dashboardChatAvailabilitySelectableModelsCache.inFlightFingerprint = ''
      }
    })

  dashboardChatAvailabilitySelectableModelsCache.inFlight = inFlight
  dashboardChatAvailabilitySelectableModelsCache.inFlightFingerprint = params.fingerprint
  return inFlight
}

function buildAvailabilitySnapshot(params: {
  state: DashboardChatAvailabilityState
  ready: boolean
  canSend: boolean
  reason: DashboardChatAvailability['reason']
  gatewayRunning: boolean
  connectedModels?: string[]
  defaultModel?: string
  message?: string
  transient?: boolean
  lastHealthyAt?: number
  consecutiveGatewayFailures?: number
}): DashboardChatAvailability {
  return {
    state: params.state,
    ready: params.ready,
    canSend: params.canSend,
    reason: params.reason,
    gatewayRunning: params.gatewayRunning,
    connectedModels: params.connectedModels || [],
    defaultModel: params.defaultModel,
    agentId: DEFAULT_CHAT_AGENT_ID,
    message: params.message,
    transient: params.transient,
    lastHealthyAt: params.lastHealthyAt,
    consecutiveGatewayFailures: params.consecutiveGatewayFailures,
  }
}

function toAvailabilityMetadata(availability: DashboardChatAvailability): Pick<
  DashboardChatAvailability,
  'connectedModels' | 'defaultModel'
> {
  return {
    connectedModels: availability.connectedModels,
    defaultModel: availability.defaultModel,
  }
}

async function defaultRunCommand(args: string[], timeout?: number): Promise<CliLikeResult> {
  return runCli(args, timeout, 'chat')
}

async function defaultRunStreamingCommand(
  args: string[],
  options: RunCliStreamOptions = {}
): Promise<CliLikeResult> {
  return runCliStreaming(args, {
    ...options,
    controlDomain: options.controlDomain ?? 'chat',
  })
}

async function defaultReadModelStatus(): Promise<ModelConfigCommandResult<Record<string, any>>> {
  const upstreamState = await getOpenClawUpstreamModelState().catch(() => null)
  const upstreamStatus = upstreamState?.ok
    ? ((upstreamState.data?.modelStatusLike as Record<string, any> | null) || null)
    : null
  if (upstreamStatus) {
    return {
      ok: true,
      action: 'status',
      command: ['control-ui-app', 'model-status'],
      stdout: '',
      stderr: '',
      code: 0,
      data: upstreamStatus,
    }
  }
  return getModelStatus()
}

async function defaultRepairAgentAuthProfiles(params: {
  providerIds: string[]
  agentId?: string
}): Promise<{
  ok: boolean
  repaired: boolean
  error?: string
  importedProfileIds?: string[]
  importedProviders?: string[]
  sourceAuthStorePaths?: string[]
  updatedAuthStorePaths?: string[]
}> {
  const { repairAgentAuthProfilesFromOtherAgentStores } = await import('./local-model-probe')
  return repairAgentAuthProfilesFromOtherAgentStores({
    providerIds: params.providerIds,
    ...(params.agentId ? { targetAgentIds: [params.agentId] } : {}),
  })
}

async function defaultRepairMainAuthProfiles(providerIds: string[]): Promise<{
  ok: boolean
  repaired: boolean
  error?: string
  importedProfileIds?: string[]
  importedProviders?: string[]
  sourceAuthStorePaths?: string[]
}> {
  const { repairMainAuthProfilesFromOtherAgentStores } = await import('./local-model-probe')
  return repairMainAuthProfilesFromOtherAgentStores({ providerIds })
}

async function noopRepairAgentAuthProfiles(): Promise<{
  ok: boolean
  repaired: boolean
  importedProfileIds: string[]
  importedProviders: string[]
  sourceAuthStorePaths: string[]
  updatedAuthStorePaths: string[]
}> {
  return {
    ok: true,
    repaired: false,
    importedProfileIds: [],
    importedProviders: [],
    sourceAuthStorePaths: [],
    updatedAuthStorePaths: [],
  }
}

async function noopRepairMainAuthProfiles(): Promise<{
  ok: boolean
  repaired: boolean
  importedProfileIds: string[]
  importedProviders: string[]
  sourceAuthStorePaths: string[]
}> {
  return {
    ok: true,
    repaired: false,
    importedProfileIds: [],
    importedProviders: [],
    sourceAuthStorePaths: [],
  }
}

function extractProviderIdFromModelRef(modelRef: string | undefined): string {
  const normalized = String(modelRef || '').trim()
  if (!normalized) return ''
  const separatorIndex = normalized.indexOf('/')
  if (separatorIndex <= 0) return ''
  return normalized.slice(0, separatorIndex).trim().toLowerCase()
}

function resolveScopedAuthRepairProviderCandidates(providerId: unknown): string[] {
  const normalized = String(providerId || '').trim().toLowerCase()
  if (!normalized) return []
  if (normalized === 'minimax' || normalized === 'minimax-portal') {
    return getModelProviderAliasCandidates(normalized).filter(
      (candidate) => candidate === 'minimax' || candidate === 'minimax-portal'
    )
  }
  return [normalized]
}

function isMiniMaxAuthRepairProvider(providerId: unknown): boolean {
  const normalized = String(providerId || '').trim().toLowerCase()
  return normalized === 'minimax' || normalized === 'minimax-portal'
}

function resolveAuthRepairProviderIds(params: {
  modelStatus?: ModelConfigCommandResult<Record<string, any>> | null
  targetModel?: string
}): string[] {
  const unique = new Set<string>()
  const missingProvidersInUse = Array.isArray(params.modelStatus?.data?.auth?.missingProvidersInUse)
    ? params.modelStatus?.data?.auth?.missingProvidersInUse
    : []

  for (const providerId of missingProvidersInUse) {
    for (const candidate of resolveScopedAuthRepairProviderCandidates(providerId)) {
      unique.add(candidate)
    }
  }

  const targetProviderId = extractProviderIdFromModelRef(params.targetModel)
  for (const candidate of resolveScopedAuthRepairProviderCandidates(targetProviderId)) {
    unique.add(candidate)
  }

  return Array.from(unique)
}

async function readCachedAvailabilityModelStatus(
  readModelStatusFn: () => Promise<ModelConfigCommandResult<Record<string, any>>>,
  now: number
): Promise<ModelConfigCommandResult<Record<string, any>>> {
  if (readModelStatusFn !== defaultReadModelStatus) {
    return readModelStatusFn()
  }

  if (
    dashboardChatAvailabilityModelStatusCache.value &&
    now < dashboardChatAvailabilityModelStatusCache.expiresAt
  ) {
    return dashboardChatAvailabilityModelStatusCache.value
  }

  if (dashboardChatAvailabilityModelStatusCache.inFlight) {
    return dashboardChatAvailabilityModelStatusCache.inFlight
  }

  const request = defaultReadModelStatus()
    .then((result) => {
      dashboardChatAvailabilityModelStatusCache.value = result
      dashboardChatAvailabilityModelStatusCache.expiresAt = Date.now() + CHAT_AVAILABILITY_MODEL_STATUS_CACHE_TTL_MS
      return result
    })
    .finally(() => {
      dashboardChatAvailabilityModelStatusCache.inFlight = null
    })

  dashboardChatAvailabilityModelStatusCache.inFlight = request
  return request
}

async function defaultCallGatewayRpc(
  method: string,
  params: unknown,
  timeoutMs?: number
): Promise<unknown> {
  try {
    return await callGatewayRpcViaControlUiBrowser(
      {
        readConfig,
        readEnvFile,
      },
      method,
      params,
      {
        timeoutMs,
      }
    )
  } catch (controlUiError) {
    if (!shouldFallbackToSocketGatewayCall(controlUiError)) {
      throw controlUiError
    }
  }

  return callGatewayRpcViaSocket(
    {
      readConfig,
      readEnvFile,
    },
    method,
    params,
    {
      clientId: 'qclaw-ui',
      clientMode: 'ui',
      clientVersion: 'qclaw-lite',
      timeoutMs,
    }
  )
}

async function tryResolveCreateChatSessionDefaultModel(
  options: OpenClawChatServiceOptions = {}
): Promise<string | undefined> {
  const readModelStatusFn = options.readModelStatus ?? defaultReadModelStatus
  try {
    const modelStatus = await readModelStatusFn()
    return resolveDefaultModelFromStatus(modelStatus)
  } catch {
    return undefined
  }
}

async function ensureGatewayForCreateSession(
  options: OpenClawChatServiceOptions = {}
): Promise<{ ok: true } | { ok: false; message: string }> {
  const ensureGatewayFn = options.ensureGateway ?? ensureGatewayRunning
  try {
    const result = await ensureGatewayFn()
    if (result?.ok && result?.running) {
      return { ok: true }
    }
    return {
      ok: false,
      message: getCliFailureMessage(
        result || {
          ok: false,
          stdout: '',
          stderr: '',
          code: 1,
        },
        '网关当前不可用，暂时无法创建新会话'
      ),
    }
  } catch (error) {
    return {
      ok: false,
      message: resolveCreateChatSessionFailureMessage(error),
    }
  }
}

async function createUpstreamDirectChatSession(
  params: {
    model?: string
    options?: OpenClawChatServiceOptions
  } = {}
): Promise<UpstreamCreateChatSessionResult> {
  const options = params.options ?? {}
  const callGatewayRpc = options.callGatewayRpc ?? defaultCallGatewayRpc
  const requestPayload = {
    agentId: DEFAULT_CHAT_AGENT_ID,
    ...(String(params.model || '').trim() ? { model: String(params.model || '').trim() } : {}),
  }

  try {
    const result = await callGatewayRpc('sessions.create', requestPayload, CHAT_GATEWAY_CALL_TIMEOUT_MS)
    const rpcFailure = toRecord(result)
    if (rpcFailure?.ok === false) {
      const message =
        toOptionalString(rpcFailure.message) ||
        toOptionalString(rpcFailure.error) ||
        '创建上游会话失败'
      return {
        ok: false,
        fallbackSafe: isCreateSessionFallbackSafeMessage(message),
        outcomeUnknown: !isCreateSessionFallbackSafeMessage(message),
        message,
        error: new Error(message),
      }
    }

    const session = normalizeCreatedChatSession(result)
    if (!session) {
      return {
        ok: false,
        fallbackSafe: false,
        outcomeUnknown: true,
        message: 'sessions.create 已返回，但结果缺少可确认的 sessionId 或 sessionKey',
        error: new Error('sessions.create returned an unrecognized payload'),
      }
    }

    return {
      ok: true,
      session,
    }
  } catch (error) {
    const message = resolveCreateChatSessionFailureMessage(error)
    const fallbackSafe = isCreateSessionFallbackSafeMessage(message)
    return {
      ok: false,
      fallbackSafe,
      outcomeUnknown: !fallbackSafe,
      message,
      error: toError(error, message),
    }
  }
}

async function createLocalFallbackChatSession(
  scopeKey: string,
  updatedAt: number
): Promise<ChatSessionSummary> {
  const sessionId = randomUUID()
  await ensureLocalChatSession({
    scopeKey,
    sessionId,
    agentId: DEFAULT_CHAT_AGENT_ID,
    kind: 'direct',
    updatedAt,
  })
  const localSessionState = await readLocalChatSessionState(scopeKey, sessionId)

  const unifiedSemantics = buildUnifiedChatSemantics({
    matchedSession: {
      sessionId,
      agentId: DEFAULT_CHAT_AGENT_ID,
      updatedAt,
      kind: 'direct',
      hasLocalTranscript: false,
      localOnly: true,
    },
    localSessionState,
  })
  return {
    sessionId,
    agentId: DEFAULT_CHAT_AGENT_ID,
    ...unifiedSemantics,
    updatedAt,
    kind: 'direct',
    hasLocalTranscript: false,
    localOnly: true,
  }
}

async function commitUpstreamCreatedChatSession(params: {
  scopeKey: string
  session: UpstreamCreatedChatSession
  updatedAt: number
}): Promise<ChatSessionSummary> {
  await ensureLocalChatSession({
    scopeKey: params.scopeKey,
    sessionId: params.session.sessionId,
    sessionKey: params.session.sessionKey,
    upstreamConfirmed: true,
    agentId: params.session.agentId,
    model: params.session.model,
    selectedModel: params.session.model,
    kind: 'direct',
    updatedAt: params.updatedAt,
  })
  const localSessionState = await readLocalChatSessionState(params.scopeKey, params.session.sessionId)

  const matchedSession: ChatSessionSummary = {
    sessionId: params.session.sessionId,
    sessionKey: params.session.sessionKey,
    agentId: params.session.agentId,
    model: params.session.model,
    selectedModel: params.session.model,
    updatedAt: params.updatedAt,
    kind: 'direct',
    hasLocalTranscript: false,
    localOnly: false,
  }
  return {
    ...matchedSession,
    ...buildUnifiedChatSemantics({
      matchedSession,
      localSessionState,
    }),
  }
}

async function resolveChatScopeKey(
  discoverOpenClawFn: () => Promise<OpenClawDiscoveryResult>
): Promise<string> {
  try {
    const discovery = await discoverOpenClawFn()
    const candidates = Array.isArray(discovery?.candidates) ? discovery.candidates : []
    const activeCandidate =
      candidates.find((candidate) => candidate.candidateId === discovery.activeCandidateId) ||
      candidates.find((candidate) => candidate.isPathActive) ||
      candidates[0] ||
      null
    return String(activeCandidate?.installFingerprint || 'default').trim() || 'default'
  } catch {
    return 'default'
  }
}

function normalizeChatSessionKind(value: unknown): ChatSessionSummary['kind'] {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'direct') return 'direct'
  if (normalized === 'channel') return 'channel'
  return 'unknown'
}

function toNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function toOptionalTokenCount(value: unknown): number | undefined {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return parsed
}

function toOptionalString(value: unknown): string | undefined {
  const normalized = String(value || '').trim()
  return normalized || undefined
}

function sanitizeExternalSession(value: unknown): OpenClawSessionCandidate | null {
  if (!value || typeof value !== 'object') return null
  const session = value as Record<string, unknown>
  const sessionId = String(session.sessionId || '').trim()
  if (!sessionId) return null

  return {
    sessionId,
    sessionKey: toOptionalString(session.key) || toOptionalString(session.sessionKey),
    agentId: String(session.agentId || DEFAULT_CHAT_AGENT_ID).trim() || DEFAULT_CHAT_AGENT_ID,
    model: String(session.model || '').trim() || undefined,
    updatedAt: toNumber(session.updatedAt, Date.now()),
    kind: normalizeChatSessionKind(session.kind),
    totalTokens: toOptionalTokenCount(session.totalTokens),
    contextTokens: toOptionalTokenCount(session.contextTokens),
  }
}

function buildGatewayChatSessionKey(agentId: string, transportSessionId: string): string {
  const normalizedAgentId = String(agentId || DEFAULT_CHAT_AGENT_ID).trim().toLowerCase() || DEFAULT_CHAT_AGENT_ID
  const normalizedSessionId = String(transportSessionId || '').trim().toLowerCase()
  if (!normalizedSessionId) return ''
  return `agent:${normalizedAgentId}:${normalizedSessionId}`
}

function isChannelBackedChatSession(params: {
  sessionKey?: string
  kind?: ChatSessionSummary['kind']
}): boolean {
  if (params.kind === 'channel') return true
  return parseChatSessionSourceFromKey(params.sessionKey).sourceType === 'channel'
}

function isExternalOnlyChatSession(params: {
  hasLocalTranscript: boolean
  localOnly?: boolean
}): boolean {
  return params.localOnly !== true && params.hasLocalTranscript !== true
}

function isUnsupportedChatModelSwitchFailure(result: CliLikeResult | null | undefined): boolean {
  const merged = `${result?.stdout || ''}\n${result?.stderr || ''}`.toLowerCase()
  if (!merged) return false
  const mentionsMethod =
    /\bsessions\.patch\b/.test(merged) || (/\bmethod\b/.test(merged) && /\b(session|model)\b/.test(merged))
  if (!mentionsMethod) return false
  return /\b(unknown method|unrecognized method|method not found|unsupported(?:\s+\w+)?(?:\s+method)?|does not support)\b/.test(
    merged
  )
}

function toCliLikeFailureResult(error: unknown): CliLikeResult {
  return {
    ok: false,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
    code: 1,
  }
}

function shouldFallbackToCliGatewayCall(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return /gateway (?:streaming|control ui) config unavailable/i.test(message)
}

function shouldFallbackToSocketGatewayCall(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return /gateway control ui config unavailable|control ui page load timeout|openclaw-app not found/i.test(message)
}

function shouldFallbackToSocketGatewaySend(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return /gateway control ui config unavailable|control ui page load timeout|openclaw-app not found|control ui connection timeout/i.test(
    message
  )
}

function normalizeControlUiChatSendResult(value: unknown): {
  stdout: string
  streamedText: string
  streamedModel?: string
  streamedUsage?: ChatUsage
} {
  const result = toRecord(value)
  const payload = toRecord(result?.payload)
  const model =
    findFirstStringField(payload, ['model', 'modelName']) ||
    findFirstStringField(payload?.message, ['model', 'modelName']) ||
    findFirstStringField(payload?.response, ['model', 'modelName']) ||
    findFirstStringField(result, ['model', 'modelName'])
  const usage = parseUsageFromPayload(payload) || parseUsageFromPayload(result)
  const text = sanitizeAssistantVisibleText(
    selectBestReplyLeaf(collectStringLeaves(payload?.message, 'message')) ||
      selectBestReplyLeaf(collectStringLeaves(payload, 'payload')) ||
      selectBestReplyLeaf(collectStringLeaves(result, 'result')) ||
      ''
  )

  return {
    stdout: JSON.stringify({
      runId: toOptionalString(result?.runId),
      sessionKey: toOptionalString(result?.sessionKey),
      response: {
        text,
      },
      model,
      usage,
      payload,
    }),
    streamedText: text,
    streamedModel: model,
    streamedUsage: usage,
  }
}

function createControlUiBrowserChatTransport(params: { fallbackTransport: ChatTransport }): ChatTransport {
  const { fallbackTransport } = params

  return {
    async run(input) {
      if (!input.sessionKey) {
        return fallbackTransport.run(input)
      }
      if (input.signal?.aborted) {
        return {
          ok: false,
          stdout: '',
          stderr: 'chat aborted',
          code: null,
          canceled: true,
          streamedText: '',
        }
      }

      try {
        const result = await runGatewayChatViaControlUiBrowser(
          {
            readConfig,
            readEnvFile,
          },
          {
            sessionKey: input.sessionKey,
            message: input.messageText,
            thinking: input.thinking,
            timeoutMs: CHAT_SEND_TIMEOUT_MS,
          }
        )
        const normalized = normalizeControlUiChatSendResult(result)
        if (normalized.streamedText) {
          input.onAssistantDelta?.({
            text: normalized.streamedText,
            delta: normalized.streamedText,
            model: normalized.streamedModel,
            usage: normalized.streamedUsage,
          })
        }
        return {
          ok: true,
          stdout: normalized.stdout,
          stderr: '',
          code: 0,
          streamedText: normalized.streamedText,
          streamedModel: normalized.streamedModel,
          streamedUsage: normalized.streamedUsage,
        }
      } catch (error) {
        if (shouldFallbackToSocketGatewaySend(error)) {
          return fallbackTransport.run(input)
        }
        return {
          ...toCliLikeFailureResult(error),
          streamedText: '',
        }
      }
    },
  }
}

function resolveChatModelSwitchFailureMessage(result: CliLikeResult): string {
  const merged = `${result.stdout || ''}\n${result.stderr || ''}`.toLowerCase()
  if (isUnsupportedChatModelSwitchFailure(result)) {
    return CHAT_MODEL_SWITCH_UNSUPPORTED_MESSAGE
  }
  const modelNotAllowedMatch = `${result.stderr || ''}\n${result.stdout || ''}`.match(/model not allowed:\s*([^\s]+)/i)
  if (modelNotAllowedMatch) {
    return `当前 OpenClaw 未启用模型 ${modelNotAllowedMatch[1]}，请先在 OpenClaw 中配置并允许该模型后再试`
  }
  if (/origin not allowed/i.test(merged)) {
    return '网关 Control UI 拒绝了当前来源，暂时无法切换会话模型，请检查 gateway.controlUi.allowedOrigins 配置'
  }
  if (/missing scope:\s*operator\.admin/i.test(merged)) {
    return '当前网关连接缺少 operator.admin 权限，暂时无法切换会话模型'
  }
  return getCliFailureMessage(result, '切换当前会话模型失败')
}

function resolveChatModelSwitchState(params: {
  sessionKey?: string
  hasLocalTranscript: boolean
  localOnly?: boolean
  kind?: ChatSessionSummary['kind']
  externalTranscriptErrorCode?: ChatExternalTranscriptErrorCode
  hasLegacyTransportBridge?: boolean
}): {
  canPatchModel: boolean
  modelSwitchBlockedReason?: string
} {
  if (
    isExternalOnlyChatSession({
      hasLocalTranscript: params.hasLocalTranscript,
      localOnly: params.localOnly,
    }) &&
    isChannelBackedChatSession({
      sessionKey: params.sessionKey,
      kind: params.kind,
    })
  ) {
    return {
      canPatchModel: false,
      modelSwitchBlockedReason: '当前渠道会话暂不支持在这里原地切模型',
    }
  }

  if (String(params.sessionKey || '').trim()) {
    return { canPatchModel: true }
  }

  if (params.externalTranscriptErrorCode === 'session-key-missing') {
    return {
      canPatchModel: false,
      modelSwitchBlockedReason: '当前会话缺少可续写标识，暂不支持原地切模型',
    }
  }

  if (params.hasLegacyTransportBridge && params.hasLocalTranscript) {
    return {
      canPatchModel: false,
      modelSwitchBlockedReason: '当前会话仍处于旧 transport 兼容态，请先发送新消息创建确认会话后再切模型',
    }
  }

  if (params.localOnly) {
    return {
      canPatchModel: false,
      modelSwitchBlockedReason: '请先发送第一条消息，再切换当前会话模型',
    }
  }

  return {
    canPatchModel: false,
    modelSwitchBlockedReason: '当前会话暂不支持原地切模型',
  }
}

export function mergeChatSessionSummaries(
  externalSessions: OpenClawSessionCandidate[],
  localSessionStates: LocalChatSessionState[]
): ChatSessionSummary[] {
  const merged = new Map<string, ChatSessionSummary>()
  const localSessionStateById = new Map<string, LocalChatSessionState>()
  const localSessionIdByTrustedSessionKey = new Map<string, string>()

  for (const local of localSessionStates) {
    const trustedSessionKey = resolveTrustedChatSessionKey({
      localSessionState: local,
    })
    localSessionStateById.set(local.sessionId, local)
    if (trustedSessionKey && !localSessionIdByTrustedSessionKey.has(trustedSessionKey)) {
      localSessionIdByTrustedSessionKey.set(trustedSessionKey, local.sessionId)
    }
    merged.set(local.sessionId, {
      sessionId: local.sessionId,
      sessionKey: local.sessionKey,
      agentId: local.agentId,
      model: local.model,
      selectedModel: local.selectedModel,
      updatedAt: local.updatedAt,
      kind: local.kind,
      hasLocalTranscript: local.hasLocalTranscript,
      localOnly: !trustedSessionKey,
    })
  }

  for (const external of externalSessions) {
    const mergeSessionId =
      merged.has(external.sessionId)
        ? external.sessionId
        : (external.sessionKey ? localSessionIdByTrustedSessionKey.get(external.sessionKey) : undefined)
          || external.sessionId
    const existing = merged.get(mergeSessionId)
    merged.set(mergeSessionId, {
      sessionId: existing?.sessionId || mergeSessionId,
      sessionKey: external.sessionKey || existing?.sessionKey,
      agentId: external.agentId || existing?.agentId || DEFAULT_CHAT_AGENT_ID,
      model: external.model || existing?.model,
      selectedModel: existing?.selectedModel,
      updatedAt: Math.max(external.updatedAt, existing?.updatedAt || 0),
      kind: external.kind || existing?.kind || 'unknown',
      hasLocalTranscript: existing?.hasLocalTranscript || false,
      totalTokens: external.totalTokens ?? existing?.totalTokens,
      contextTokens: external.contextTokens ?? existing?.contextTokens,
      localOnly: false,
    })
  }

  return Array.from(merged.values())
    .map((session) => ({
      ...session,
      ...buildUnifiedChatSemantics({
        matchedSession: session,
        localSessionState: localSessionStateById.get(session.sessionId) || null,
      }),
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

async function resolveMergedChatSessions(
  options: OpenClawChatServiceOptions = {}
): Promise<{
  scopeKey: string
  sessions: ChatSessionSummary[]
}> {
  const runCommand = options.runCommand ?? defaultRunCommand
  const discoverOpenClawFn = options.discoverOpenClaw ?? discoverOpenClawInstallations
  const scopeKey = await resolveChatScopeKey(discoverOpenClawFn)
  const localSessionStates = await listLocalChatSessionStates(scopeKey)
  const localSessions = mergeChatSessionSummaries([], localSessionStates)

  try {
    const result = await runCommand(['sessions', '--json', '--all-agents'], CHAT_SESSIONS_TIMEOUT_MS)
    if (!result.ok) {
      return {
        scopeKey,
        sessions: localSessions.sort((left, right) => right.updatedAt - left.updatedAt),
      }
    }

    const parsed = parseJsonFromOutput<OpenClawSessionsPayload>(result.stdout)
    const externalSessions = Array.isArray(parsed?.sessions)
      ? parsed.sessions
          .map(sanitizeExternalSession)
          .filter((session): session is OpenClawSessionCandidate => Boolean(session))
      : []
    return {
      scopeKey,
      sessions: mergeChatSessionSummaries(externalSessions, localSessionStates),
    }
  } catch {
    return {
      scopeKey,
      sessions: localSessions.sort((left, right) => right.updatedAt - left.updatedAt),
    }
  }
}

interface StringLeaf {
  path: string
  value: string
}

const EXPLICIT_ASSISTANT_TEXT_PATHS = new Set([
  'text',
  'content',
  'content[].text',
  'message.text',
  'message.content',
  'message.content[].text',
  'assistant.text',
  'response.text',
  'response.content',
  'response.content[].text',
  'reply.text',
  'reply.content',
  'reply.content[].text',
])

function collectStringLeaves(value: unknown, path: string, depth = 0): StringLeaf[] {
  if (depth > 4 || value == null) return []
  if (typeof value === 'string') {
    const normalized = value.trim()
    return normalized ? [{ path, value: normalized }] : []
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectStringLeaves(item, `${path}[${index}]`, depth + 1))
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
      collectStringLeaves(nested, path ? `${path}.${key}` : key, depth + 1)
    )
  }
  return []
}

function normalizeAssistantLeafPath(path: string): string {
  let normalized = String(path || '').trim().replace(/\[\d+\]/g, '[]').toLowerCase()
  for (const prefix of ['payload.', 'result.']) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length)
    }
  }
  return normalized
}

function isExplicitAssistantTextPath(path: string): boolean {
  return EXPLICIT_ASSISTANT_TEXT_PATHS.has(normalizeAssistantLeafPath(path))
}

function selectBestReplyLeaf(leaves: StringLeaf[]): string | null {
  if (leaves.length === 0) return null

  const preferred = leaves
    .filter((leaf) => isExplicitAssistantTextPath(leaf.path) && !CHAT_REPLY_REJECTED_PATH_PATTERN.test(leaf.path))
    .sort((left, right) => right.value.length - left.value.length)
  if (preferred.length > 0) return preferred[0].value

  const fallback = leaves
    .filter((leaf) => {
      if (CHAT_REPLY_REJECTED_PATH_PATTERN.test(leaf.path)) return false
      if (isExplicitAssistantTextPath(leaf.path)) return true
      return Boolean(sanitizeAssistantRawFallbackText(leaf.value))
    })
    .sort((left, right) => right.value.length - left.value.length)
  if (fallback.length > 0) return fallback[0].value

  return null
}

function findFirstStringField(value: unknown, fieldNames: string[]): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  for (const fieldName of fieldNames) {
    const raw = (value as Record<string, unknown>)[fieldName]
    const normalized = String(raw || '').trim()
    if (normalized) return normalized
  }
  return undefined
}

function parseUsageCandidate(value: unknown): ChatUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const usage: ChatUsage = {}

  usage.inputTokens = [
    record.inputTokens,
    record.input_tokens,
    record.promptTokens,
    record.prompt_tokens,
  ]
    .map(toOptionalTokenCount)
    .find((value): value is number => value != null)

  usage.outputTokens = [
    record.outputTokens,
    record.output_tokens,
    record.completionTokens,
    record.completion_tokens,
    record.replyTokens,
  ]
    .map(toOptionalTokenCount)
    .find((value): value is number => value != null)

  usage.totalTokens = [record.totalTokens, record.total_tokens]
    .map(toOptionalTokenCount)
    .find((value): value is number => value != null)

  usage.reasoningTokens = [record.reasoningTokens, record.reasoning_tokens, record.thinkingTokens]
    .map(toOptionalTokenCount)
    .find((value): value is number => value != null)

  return Object.values(usage).some((value) => value != null) ? usage : undefined
}

function parseUsageFromPayload(value: unknown): ChatUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const candidates: unknown[] = [
    record,
    record.usage,
    record.message,
    record.response,
    record.result,
    record.result && typeof record.result === 'object' ? (record.result as Record<string, unknown>).usage : null,
    record.result && typeof record.result === 'object' ? (record.result as Record<string, unknown>).response : null,
    record.message && typeof record.message === 'object' ? (record.message as Record<string, unknown>).usage : null,
    record.response && typeof record.response === 'object' ? (record.response as Record<string, unknown>).usage : null,
  ]

  for (const candidate of candidates) {
    const usage = parseUsageCandidate(candidate)
    if (usage) return usage
  }

  return undefined
}

function selectPreferredLeaf(leaves: StringLeaf[], preferredPattern: RegExp, rejectedPattern: RegExp): string | null {
  const preferred = leaves
    .filter((leaf) => preferredPattern.test(leaf.path) && !rejectedPattern.test(leaf.path))
    .sort((left, right) => right.value.length - left.value.length)
  if (preferred.length > 0) return preferred[0].value
  return null
}

function normalizeExternalMessageRole(value: unknown): ChatMessage['role'] | null {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'user') return 'user'
  if (normalized === 'assistant') return 'assistant'
  if (normalized === 'system') return 'system'
  return null
}

function normalizeExternalMessageTimestamp(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  if (parsed < 1_000_000_000_000) return Math.floor(parsed * 1000)
  return Math.floor(parsed)
}

function looksLikeEncryptedReasoningPayload(text: string): boolean {
  const normalized = String(text || '').trim()
  if (!normalized) return false
  if (!normalized.startsWith('{') || !normalized.endsWith('}')) return false
  if (!/"encrypted_content"\s*:/.test(normalized)) return false

  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>
    const encryptedContent = typeof parsed.encrypted_content === 'string' ? parsed.encrypted_content.trim() : ''
    if (!encryptedContent) return false
    const type = String(parsed.type || '').trim().toLowerCase()
    return type === 'reasoning' || /^rs_/i.test(String(parsed.id || ''))
  } catch {
    return /"type"\s*:\s*"reasoning"/i.test(normalized)
  }
}

function sanitizeExternalMetadataWrappedText(rawText: string): string {
  const normalized = String(rawText || '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (!normalized) return ''

  let cleaned = normalized
    .replace(/\[\[\s*reply_to_current\s*\]\]/gi, ' ')
    .replace(/^\s*\[message_id:\s*[^\]]+\]\s*$/gim, '')
    .replace(/^\s*ou_[a-z0-9_-]+\s*:\s*\d+\s*$/gim, '')
    .trim()

  if (looksLikeEncryptedReasoningPayload(cleaned)) {
    return ''
  }

  cleaned = cleaned
    .replace(/\{[\s\S]*?"encrypted_content"\s*:\s*"[^"]+"[\s\S]*?\}\s*/gi, '')
    .trim()

  if (looksLikeEncryptedReasoningPayload(cleaned)) {
    return ''
  }

  const hasUntrustedMetadata = /\b(?:Conversation info|Sender)\s*\(untrusted metadata\):/i.test(normalized)
  const hasSystemPrefix = /^\s*System:/i.test(normalized)
  if (!hasUntrustedMetadata && !hasSystemPrefix) {
    return cleaned
  }

  if (hasUntrustedMetadata) {
    const fencePattern = /```[\s\S]*?```/g
    let lastFenceEnd = -1
    for (const match of cleaned.matchAll(fencePattern)) {
      const start = match.index ?? -1
      if (start >= 0) {
        lastFenceEnd = start + match[0].length
      }
    }
    if (lastFenceEnd >= 0) {
      const tail = cleaned.slice(lastFenceEnd).trim()
      if (tail && !/\b(?:Conversation info|Sender)\s*\(untrusted metadata\):/i.test(tail)) {
        cleaned = tail
      }
    }

    cleaned = cleaned
      .replace(
        /(?:^|\n)\s*Conversation info\s*\(untrusted metadata\):[\s\S]*?(?=(?:\n\s*Sender\s*\(untrusted metadata\):)|$)/gi,
        '\n'
      )
      .replace(/(?:^|\n)\s*Sender\s*\(untrusted metadata\):[\s\S]*$/gi, '\n')
      .trim()
  }

  cleaned = cleaned
    .replace(/^\s*System:[^\n]*\n(?:\s*ou_[^\n]*\n)?(?:\s*\[msg:[^\n]*\]\n)?/i, '')
    .trim()

  return cleaned
}

function extractExternalMessageText(record: Record<string, unknown>): string | null {
  const directText = findFirstStringField(record, ['text'])
  if (directText) return directText

  const candidates: unknown[] = [record.content, record.message, record.response, record.result, record]

  for (const candidate of candidates) {
    if (!candidate) continue
    if (typeof candidate === 'string') {
      const normalized = candidate.trim()
      if (normalized) return normalized
      continue
    }
    const leaves = collectStringLeaves(candidate, '')
    const preferred = selectPreferredLeaf(
      leaves,
      /(^|\.)(text|content)$|(^|\.)(message|assistant|response|reply)\.(text|content)$|(^|\.)(message\.)?content\[\d+\]\.text$/i,
      CHAT_REPLY_REJECTED_PATH_PATTERN
    )
    if (preferred) return preferred
    const fallback = selectBestReplyLeaf(leaves)
    if (fallback) return fallback
  }

  return null
}

function mapExternalSessionMessage(
  value: unknown,
  index: number,
  fallbackCreatedAt: number
): ChatMessage | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const role = normalizeExternalMessageRole(record.role)
  if (!role) return null

  const rawText = extractExternalMessageText(record)
  if (!rawText) return null
  const text = role === 'assistant'
    ? sanitizeAssistantVisibleText(sanitizeExternalMetadataWrappedText(rawText))
    : sanitizeExternalMetadataWrappedText(rawText)
  if (!text) return null

  const createdAt = normalizeExternalMessageTimestamp(
    record.createdAt ?? record.created_at ?? record.timestamp ?? record.ts ?? record.time,
    fallbackCreatedAt + index
  )
  const model =
    findFirstStringField(record, ['model', 'modelName']) ||
    (record.message && typeof record.message === 'object'
      ? findFirstStringField(record.message, ['model', 'modelName'])
      : undefined)

  return buildChatMessage({
    id: toOptionalString(record.id) || undefined,
    role,
    text,
    createdAt,
    status: 'sent',
    model,
    usage: parseUsageFromPayload(record),
  })
}

function extractMessagesFromGatewayCallPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []

  const record = value as Record<string, unknown>
  const directCandidates = [record.messages, record.history, record.items, record.entries]
  for (const candidate of directCandidates) {
    if (Array.isArray(candidate)) return candidate
  }

  const nestedCandidates: unknown[] = [
    record.payload,
    record.result,
    record.response,
    record.data,
  ]
  for (const nested of nestedCandidates) {
    if (!nested || typeof nested !== 'object') continue
    const nestedRecord = nested as Record<string, unknown>
    const nestedArrays = [nestedRecord.messages, nestedRecord.history, nestedRecord.items, nestedRecord.entries]
    for (const nestedMessages of nestedArrays) {
      if (Array.isArray(nestedMessages)) return nestedMessages
    }
  }

  return []
}

function resolveChatHistoryPrimaryEnabled(options: OpenClawChatServiceOptions = {}): boolean {
  if (typeof options.chatHistoryPrimaryEnabled === 'boolean') {
    return options.chatHistoryPrimaryEnabled
  }
  const raw = String(process.env.QCLAW_CHAT_USE_HISTORY_PRIMARY || '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function inferSupportsChatHistory(capabilities: OpenClawCapabilities): boolean {
  return capabilities.supports.chatGatewaySendModel === true
}

async function shouldPreferChatHistory(params: {
  session: ChatSessionSummary
  options: OpenClawChatServiceOptions
}): Promise<boolean> {
  const sessionKey = String(params.session.sessionKey || '').trim()
  if (!sessionKey) return false
  if (params.session.kind !== 'direct') return false
  if (isChannelBackedChatSession({ sessionKey, kind: params.session.kind })) return false
  if (!resolveChatHistoryPrimaryEnabled(params.options)) return false

  const loadCapabilities = params.options.loadCapabilities ?? loadOpenClawCapabilities
  try {
    const capabilities = await loadCapabilities()
    return inferSupportsChatHistory(capabilities)
  } catch {
    return false
  }
}

function classifyExternalTranscriptErrorCode(message: string): ChatExternalTranscriptErrorCode {
  const normalized = String(message || '').trim().toLowerCase()
  if (!normalized) return 'sessions-get-failed'
  if (
    /gateway closed|1006|econnrefused|connection refused|not running|offline|unreachable|尚未就绪|not become reachable|did not become reachable/.test(normalized)
  ) {
    return 'gateway-offline'
  }
  if (/auth|unauthorized|forbidden|token|401|403/.test(normalized)) {
    return 'gateway-auth-failed'
  }
  if (/session/.test(normalized) && /not found|missing|unknown/.test(normalized)) {
    return 'session-not-found'
  }
  return 'sessions-get-failed'
}

function buildExternalTranscriptErrorResult(
  message: string,
  limit = CHAT_EXTERNAL_TRANSCRIPT_LIMIT,
  source: ChatHistorySource = 'sessions-get'
): ExternalTranscriptLoadResult {
  return {
    ok: false,
    messages: [],
    limit,
    truncated: false,
    source,
    errorCode: classifyExternalTranscriptErrorCode(message),
    errorMessage: message,
  }
}

async function loadExternalTranscriptMessages(
  sessionKey: string,
  updatedAt: number,
  options: OpenClawChatServiceOptions = {}
): Promise<ExternalTranscriptLoadResult> {
  const runCommand = options.runCommand ?? defaultRunCommand
  const limit = CHAT_EXTERNAL_TRANSCRIPT_LIMIT
  try {
    const result = await runCommand(
      [
        'gateway',
        'call',
        'sessions.get',
        '--json',
        '--params',
        JSON.stringify({
          key: sessionKey,
          limit,
        }),
        '--timeout',
        String(CHAT_GATEWAY_CALL_TIMEOUT_MS),
      ],
      CHAT_GATEWAY_CALL_TIMEOUT_MS
    )

    if (!result.ok) {
      return buildExternalTranscriptErrorResult(
        getCliFailureMessage(result, '读取外部历史失败'),
        limit,
        'sessions-get'
      )
    }

    const parsed = parseJsonFromOutput<unknown>(result.stdout)
    const rawMessages = extractMessagesFromGatewayCallPayload(parsed)
    const fallbackCreatedAt = Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now()
    const messages = rawMessages
      .map((message, index) => mapExternalSessionMessage(message, index, fallbackCreatedAt))
      .filter((message): message is ChatMessage => Boolean(message))
    const truncated = rawMessages.length >= limit

    if (rawMessages.length > 0 && messages.length === 0) {
      return {
        ok: false,
        messages: [],
        limit,
        truncated,
        source: 'sessions-get',
        errorCode: 'messages-map-failed',
        errorMessage: '历史消息解析失败',
      }
    }

    return {
      ok: true,
      messages,
      limit,
      truncated,
      source: 'sessions-get',
    }
  } catch {
    return buildExternalTranscriptErrorResult('读取外部历史失败', limit, 'sessions-get')
  }
}

async function loadChatHistoryMessages(
  sessionKey: string,
  updatedAt: number,
  options: OpenClawChatServiceOptions = {}
): Promise<ExternalTranscriptLoadResult> {
  const runCommand = options.runCommand ?? defaultRunCommand
  const limit = CHAT_EXTERNAL_TRANSCRIPT_LIMIT
  try {
    const result = await runCommand(
      [
        'gateway',
        'call',
        'chat.history',
        '--json',
        '--params',
        JSON.stringify({
          key: sessionKey,
          limit,
        }),
        '--timeout',
        String(CHAT_GATEWAY_CALL_TIMEOUT_MS),
      ],
      CHAT_GATEWAY_CALL_TIMEOUT_MS
    )

    if (!result.ok) {
      return buildExternalTranscriptErrorResult(
        getCliFailureMessage(result, '读取会话历史失败'),
        limit,
        'chat-history'
      )
    }

    const parsed = parseJsonFromOutput<unknown>(result.stdout)
    const rawMessages = extractMessagesFromGatewayCallPayload(parsed)
    const fallbackCreatedAt = Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now()
    const messages = rawMessages
      .map((message, index) => mapExternalSessionMessage(message, index, fallbackCreatedAt))
      .filter((message): message is ChatMessage => Boolean(message))
    const truncated = rawMessages.length >= limit

    if (rawMessages.length > 0 && messages.length === 0) {
      return {
        ok: false,
        messages: [],
        limit,
        truncated,
        source: 'chat-history',
        errorCode: 'messages-map-failed',
        errorMessage: '会话历史解析失败',
      }
    }

    return {
      ok: true,
      messages,
      limit,
      truncated,
      source: 'chat-history',
    }
  } catch {
    return buildExternalTranscriptErrorResult('读取会话历史失败', limit, 'chat-history')
  }
}

export function parseAgentReplyOutput(stdout: string): { text: string | null; model?: string; usage?: ChatUsage } {
  const rawStdout = String(stdout || '').trim()
  if (!rawStdout) {
      return { text: null }
  }

  try {
    const parsed = parseJsonFromOutput<unknown>(rawStdout)
    if (typeof parsed === 'string') {
      const normalized = sanitizeAssistantRawFallbackText(parsed)
      return { text: normalized || null }
    }

    const leaves = collectStringLeaves(parsed, '')
    const text = sanitizeAssistantVisibleText(selectBestReplyLeaf(leaves) || '') || null
    const model =
      findFirstStringField(parsed, ['model', 'modelName']) ||
      (parsed && typeof parsed === 'object'
        ? findFirstStringField((parsed as Record<string, unknown>).message, ['model', 'modelName'])
        : undefined)
    const usage = parseUsageFromPayload(parsed)

    return {
      text,
      model,
      usage,
    }
  } catch {
    return {
      text: sanitizeAssistantRawFallbackText(rawStdout) || null,
    }
  }
}

function buildChatMessage(params: {
  id?: string
  role: ChatMessage['role']
  text: string
  createdAt: number
  status?: ChatMessage['status']
  model?: string
  usage?: ChatUsage
}): ChatMessage {
  return {
    id: String(params.id || randomUUID()).trim() || randomUUID(),
    role: params.role,
    text: String(params.text || '').trim(),
    createdAt: params.createdAt,
    status: params.status || 'sent',
    model: String(params.model || '').trim() || undefined,
    requestedModel: undefined,
    transportSessionId: undefined,
    usage: params.usage,
  }
}

function formatSeedMessageEntry(message: ChatMessage): string {
  const roleLabel = message.role === 'assistant' ? '助手' : message.role === 'system' ? '系统' : '用户'
  const modelSuffix =
    message.role === 'assistant' && message.model ? `（模型：${message.model}）` : ''
  return `${roleLabel}${modelSuffix}：${message.text}`
}

function buildSeededTurnMessage(messages: ChatMessage[], nextUserText: string): string {
  const recentMessages = messages.filter((message) => String(message.text || '').trim()).slice(-8)
  if (recentMessages.length === 0) return nextUserText

  const historyText = recentMessages.map(formatSeedMessageEntry).join('\n\n').slice(-6_000)
  return [
    '以下是当前对话最近的上下文，请直接延续回答，不要重复总结规则。',
    '',
    historyText,
    '',
    '当前用户新消息：',
    nextUserText,
  ].join('\n')
}

function classifySendErrorCode(message: string): Exclude<ChatSendResult['errorCode'], undefined> {
  const normalized = String(message || '').trim().toLowerCase()
  if (!normalized) return 'command-failed'
  if (/timeout|timed out/.test(normalized)) return 'timeout'
  if (/gateway/.test(normalized) && /offline|unreachable|failed|not running|not loaded/.test(normalized)) {
    return 'gateway-offline'
  }
  return 'command-failed'
}

export async function getDashboardChatAvailability(
  options: OpenClawChatServiceOptions = {}
): Promise<DashboardChatAvailability> {
  const getGatewayHealthFn = options.getGatewayHealth ?? gatewayHealth
  const readModelStatusFn = options.readModelStatus ?? defaultReadModelStatus
  const now = options.now ?? Date.now

  try {
    const currentTime = now()
    const [healthResult, modelStatusResult] = await Promise.allSettled([
      getGatewayHealthFn(),
      readCachedAvailabilityModelStatus(readModelStatusFn, currentTime),
    ])
    const health = healthResult.status === 'fulfilled' ? healthResult.value : null
    const modelStatus = modelStatusResult.status === 'fulfilled' ? modelStatusResult.value : null
    const selectableModelsCacheContext = await readAvailabilitySelectableModelsCacheContext({ modelStatus })
    const selectableModelResolution = await readCachedAvailabilitySelectableModels({
      currentTime,
      fingerprint: selectableModelsCacheContext.fingerprint,
      resolver: () =>
        resolveChatSelectableModelsFromModelsPage({
          modelStatus,
          config: selectableModelsCacheContext.config,
          envVars: selectableModelsCacheContext.envVars,
        }),
    })
    const availabilityOverrides = {
      connectedModelsOverride: selectableModelResolution.connectedModels,
      defaultModelOverride: selectableModelResolution.defaultModel,
    }

    if (health?.running) {
      chatAvailabilityTracker.consecutiveGatewayFailures = 0
      chatAvailabilityTracker.lastHealthyAt = currentTime

      const availability = buildDashboardChatAvailabilityFromStatus({
        gatewayRunning: true,
        modelStatus:
          modelStatus ||
          ({
            ok: false,
            action: 'status',
            command: ['models', 'status', '--json'],
            stdout: '',
            stderr: '',
            code: 1,
            errorCode: 'command_failed',
            message:
              modelStatusResult.status === 'rejected'
                ? modelStatusResult.reason instanceof Error
                  ? modelStatusResult.reason.message
                  : String(modelStatusResult.reason)
                : '读取模型状态失败',
          } satisfies ModelConfigCommandResult<Record<string, any>>),
        ...availabilityOverrides,
      })

      if (availability.state === 'ready') {
        chatAvailabilityTracker.lastHealthyAvailability = availability
      } else if (availability.connectedModels.length > 0 || availability.defaultModel) {
        chatAvailabilityTracker.lastHealthyAvailability = availability
      }

      return {
        ...availability,
        transient: false,
        lastHealthyAt: chatAvailabilityTracker.lastHealthyAt || undefined,
        consecutiveGatewayFailures: chatAvailabilityTracker.consecutiveGatewayFailures,
      }
    }

    chatAvailabilityTracker.consecutiveGatewayFailures += 1
    const lastHealthyAt = chatAvailabilityTracker.lastHealthyAt || undefined
    const withinGraceWindow =
      Boolean(lastHealthyAt) && currentTime - Number(lastHealthyAt) <= CHAT_AVAILABILITY_DEGRADED_GRACE_MS
    const isTransientFailure =
      chatAvailabilityTracker.consecutiveGatewayFailures < CHAT_AVAILABILITY_OFFLINE_FAILURE_THRESHOLD ||
      withinGraceWindow

    if (modelStatus) {
      const availability = buildDashboardChatAvailabilityFromStatus({
        gatewayRunning: false,
        modelStatus,
        ...availabilityOverrides,
      })

      if (availability.state === 'offline' && isTransientFailure) {
        return buildAvailabilitySnapshot({
          state: 'degraded',
          ready: false,
          canSend: true,
          reason: 'gateway-offline',
          gatewayRunning: false,
          connectedModels: availability.connectedModels,
          defaultModel: availability.defaultModel,
          message: '网关连接不稳定，正在自动恢复',
          transient: true,
          lastHealthyAt,
          consecutiveGatewayFailures: chatAvailabilityTracker.consecutiveGatewayFailures,
        })
      }

      return {
        ...availability,
        transient: false,
        lastHealthyAt,
        consecutiveGatewayFailures: chatAvailabilityTracker.consecutiveGatewayFailures,
      }
    }

    const fallbackMetadata = toAvailabilityMetadata(
      chatAvailabilityTracker.lastHealthyAvailability ||
        buildAvailabilitySnapshot({
          state: 'error',
          ready: false,
          canSend: false,
          reason: 'chat-service-error',
          gatewayRunning: false,
          message: '聊天状态读取失败',
        })
    )

    if (isTransientFailure && (fallbackMetadata.connectedModels.length > 0 || fallbackMetadata.defaultModel)) {
      return buildAvailabilitySnapshot({
        state: 'degraded',
        ready: false,
        canSend: true,
        reason: 'gateway-offline',
        gatewayRunning: false,
        connectedModels: fallbackMetadata.connectedModels,
        defaultModel: fallbackMetadata.defaultModel,
        message: '网关连接不稳定，正在自动恢复',
        transient: true,
        lastHealthyAt,
        consecutiveGatewayFailures: chatAvailabilityTracker.consecutiveGatewayFailures,
      })
    }

    return buildAvailabilitySnapshot({
      state: 'error',
      ready: false,
      canSend: false,
      reason: 'chat-service-error',
      gatewayRunning: false,
      connectedModels: fallbackMetadata.connectedModels,
      defaultModel: fallbackMetadata.defaultModel,
      message:
        modelStatusResult.status === 'rejected'
          ? modelStatusResult.reason instanceof Error
            ? modelStatusResult.reason.message
            : String(modelStatusResult.reason)
          : healthResult.status === 'rejected'
            ? healthResult.reason instanceof Error
              ? healthResult.reason.message
              : String(healthResult.reason)
            : '聊天状态读取失败',
      transient: false,
      lastHealthyAt,
      consecutiveGatewayFailures: chatAvailabilityTracker.consecutiveGatewayFailures,
    })
  } catch (error) {
    return buildAvailabilitySnapshot({
      state: 'error',
      ready: false,
      canSend: false,
      reason: 'chat-service-error',
      gatewayRunning: false,
      message: error instanceof Error ? error.message : String(error),
      connectedModels: chatAvailabilityTracker.lastHealthyAvailability?.connectedModels || [],
      defaultModel: chatAvailabilityTracker.lastHealthyAvailability?.defaultModel,
      transient: false,
      lastHealthyAt: chatAvailabilityTracker.lastHealthyAt || undefined,
      consecutiveGatewayFailures: chatAvailabilityTracker.consecutiveGatewayFailures,
    })
  }
}

export async function listChatSessions(
  options: OpenClawChatServiceOptions = {}
): Promise<ChatSessionSummary[]> {
  const resolved = await resolveMergedChatSessions(options)
  return resolved.sessions
}

export async function getChatTranscript(
  sessionId: string,
  options: OpenClawChatServiceOptions = {}
): Promise<ChatTranscript> {
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedSessionId) {
    throw new Error('sessionId is required')
  }

  const resolved = await resolveMergedChatSessions(options)
  const scopeKey = resolved.scopeKey
  const localTranscript = await readLocalChatTranscript(scopeKey, normalizedSessionId)
  const localSessionState = await readLocalChatSessionState(scopeKey, normalizedSessionId)
  let matchedSession = resolved.sessions.find((session) => session.sessionId === normalizedSessionId)
  const localCacheOnly =
    localTranscript?.hasLocalTranscript &&
    (!matchedSession || matchedSession.localOnly === true || !String(matchedSession.sessionKey || '').trim())
  if (localCacheOnly) {
    const unifiedSemantics = buildUnifiedChatSemantics({
      matchedSession,
      localSessionState,
      localTranscript,
    })
    appendChatTrace({
      operation: 'transcript',
      stage: 'return-local-cache',
      sessionId: normalizedSessionId,
      sessionKey: String(localTranscript.sessionKey || '').trim() || undefined,
      historySource: 'local-cache',
      confirmedModel: localTranscript.model,
      intentSelectedModel: localTranscript.selectedModel,
      failureClass: resolveFailureClassFromTranscriptErrorCode(localTranscript.externalTranscriptErrorCode),
      message: 'Returning local transcript cache before loading upstream history.',
    })
    return {
      ...localTranscript,
      historySource: 'local-cache',
      ...unifiedSemantics,
    }
  }
  if (localTranscript && !matchedSession) {
    const unifiedSemantics = buildUnifiedChatSemantics({
      localSessionState,
      localTranscript,
    })
    appendChatTrace({
      operation: 'transcript',
      stage: 'return-local-shell',
      sessionId: normalizedSessionId,
      sessionKey: String(localTranscript.sessionKey || '').trim() || undefined,
      historySource: 'local-cache',
      confirmedModel: localTranscript.model,
      intentSelectedModel: localTranscript.selectedModel,
      failureClass: resolveFailureClassFromTranscriptErrorCode(localTranscript.externalTranscriptErrorCode),
      message: 'Returning local transcript because no merged upstream session was found.',
    })
    return {
      ...localTranscript,
      historySource: 'local-cache',
      ...unifiedSemantics,
    }
  }

  if (matchedSession) {
    if (!matchedSession.sessionKey) {
      const refreshed = await resolveMergedChatSessions(options)
      const refreshedMatch = refreshed.sessions.find((session) => session.sessionId === normalizedSessionId)
      if (refreshedMatch) {
        matchedSession = refreshedMatch
      }
    }

    if (!matchedSession.sessionKey) {
      const unifiedSemantics = buildUnifiedChatSemantics({
        matchedSession,
        localSessionState,
        localTranscript,
        externalTranscriptErrorCode: matchedSession.localOnly ? undefined : 'session-key-missing',
      })
      appendChatTrace({
        operation: 'transcript',
        stage: 'missing-session-key',
        sessionId: matchedSession.sessionId,
        confirmedModel: matchedSession.model,
        intentSelectedModel: localTranscript?.selectedModel,
        historySource: 'none',
        failureClass: 'semantic',
        message: 'Merged session is missing a reusable sessionKey.',
      })
      return {
        sessionId: matchedSession.sessionId,
        selectedModel: localTranscript?.selectedModel,
        historySource: 'none',
        agentId: matchedSession.agentId,
        model: matchedSession.model,
        ...unifiedSemantics,
        updatedAt: matchedSession.updatedAt,
        hasLocalTranscript: false,
        messages: [],
        externalTranscriptErrorCode: 'session-key-missing',
        externalTranscriptErrorMessage: '当前会话缺少 sessionKey，请刷新后重试',
      }
    }

    let externalResult: ExternalTranscriptLoadResult | null = null
    let attemptedChatHistory = false
    if (await shouldPreferChatHistory({ session: matchedSession, options })) {
      attemptedChatHistory = true
      const chatHistoryResult = await loadChatHistoryMessages(
        matchedSession.sessionKey,
        matchedSession.updatedAt,
        options
      )
      appendChatTrace({
        operation: 'transcript',
        stage: chatHistoryResult.ok ? 'return-chat-history' : 'chat-history-error',
        sessionId: matchedSession.sessionId,
        sessionKey: matchedSession.sessionKey,
        historySource: 'chat-history',
        confirmedModel: matchedSession.model,
        intentSelectedModel: localTranscript?.selectedModel,
        failureClass:
          chatHistoryResult.ok ? 'none' : resolveFailureClassFromTranscriptErrorCode(chatHistoryResult.errorCode),
        message: chatHistoryResult.ok
          ? 'Loaded transcript through chat.history primary path.'
          : chatHistoryResult.errorMessage || 'Failed to load transcript through chat.history.',
      })
      if (chatHistoryResult.ok) {
        externalResult = chatHistoryResult
      }
    }

    if (!externalResult) {
      externalResult = await loadExternalTranscriptMessages(
        matchedSession.sessionKey,
        matchedSession.updatedAt,
        options
      )
    }
    if (externalResult.source === 'sessions-get') {
      appendChatTrace({
        operation: 'transcript',
        stage: externalResult.ok ? 'return-sessions-get' : 'sessions-get-error',
        sessionId: matchedSession.sessionId,
        sessionKey: matchedSession.sessionKey,
        historySource: 'sessions-get',
        confirmedModel: matchedSession.model,
        intentSelectedModel: localTranscript?.selectedModel,
        failureClass:
          externalResult.ok ? 'none' : resolveFailureClassFromTranscriptErrorCode(externalResult.errorCode),
        message: externalResult.ok
          ? 'Loaded transcript through gateway sessions.get fallback path.'
          : externalResult.errorMessage || 'Failed to load transcript through sessions.get.',
      })
    }

    if (!externalResult.ok && localTranscript?.hasLocalTranscript) {
      const unifiedSemantics = buildUnifiedChatSemantics({
        matchedSession,
        localSessionState,
        localTranscript,
        externalTranscriptErrorCode: externalResult.errorCode,
      })
      appendChatTrace({
        operation: 'transcript',
        stage: attemptedChatHistory ? 'fallback-local-cache-after-upstream-error' : 'return-local-cache',
        sessionId: normalizedSessionId,
        sessionKey: String(localTranscript.sessionKey || matchedSession.sessionKey || '').trim() || undefined,
        historySource: 'local-cache',
        confirmedModel: localTranscript.model || matchedSession.model,
        intentSelectedModel: localTranscript.selectedModel,
        failureClass: resolveFailureClassFromTranscriptErrorCode(externalResult.errorCode),
        message: 'Falling back to local transcript cache after upstream history read failed.',
      })
      return {
        ...localTranscript,
        historySource: 'local-cache',
        sessionKey: localTranscript.sessionKey || matchedSession.sessionKey,
        ...unifiedSemantics,
        externalTranscriptErrorCode: externalResult.errorCode,
        externalTranscriptErrorMessage: externalResult.errorMessage,
      }
    }

    const unifiedSemantics = buildUnifiedChatSemantics({
      matchedSession,
      localSessionState,
      localTranscript,
      externalTranscriptErrorCode: externalResult.errorCode,
    })
    return {
      sessionId: matchedSession.sessionId,
      sessionKey: matchedSession.sessionKey,
      selectedModel: localTranscript?.selectedModel,
      historySource: externalResult.source,
      agentId: matchedSession.agentId,
      model: matchedSession.model,
      ...unifiedSemantics,
      updatedAt: matchedSession.updatedAt,
      hasLocalTranscript: false,
      messages: externalResult.messages,
      externalTranscriptLimit: externalResult.limit,
      externalTranscriptTruncated: externalResult.truncated,
      externalTranscriptErrorCode: externalResult.errorCode,
      externalTranscriptErrorMessage: externalResult.errorMessage,
    }
  }

  const unifiedSemantics = buildUnifiedChatSemantics({
    localSessionState,
    localTranscript,
  })
  appendChatTrace({
    operation: 'transcript',
    stage: 'return-empty',
    sessionId: normalizedSessionId,
    historySource: 'none',
    failureClass: 'none',
    message: 'Returning empty transcript shell.',
  })
  return {
    sessionId: normalizedSessionId,
    historySource: 'none',
    agentId: DEFAULT_CHAT_AGENT_ID,
    ...unifiedSemantics,
    updatedAt: 0,
    hasLocalTranscript: false,
    messages: [],
  }
}

export async function createChatSession(
  options: OpenClawChatServiceOptions = {}
): Promise<ChatSessionSummary> {
  const discoverOpenClawFn = options.discoverOpenClaw ?? discoverOpenClawInstallations
  const now = options.now ?? Date.now
  const scopeKey = await resolveChatScopeKey(discoverOpenClawFn)
  const updatedAt = now()
  const defaultModel = await tryResolveCreateChatSessionDefaultModel(options)
  appendChatTrace({
    operation: 'create',
    stage: 'start',
    historySource: 'none',
    confirmedModel: defaultModel,
    intentSelectedModel: defaultModel,
    failureClass: 'none',
    message: 'Starting direct chat session creation.',
  }, updatedAt)
  const ensuredGateway = await ensureGatewayForCreateSession(options)
  if (!ensuredGateway.ok) {
    const fallbackSession = await createLocalFallbackChatSession(scopeKey, updatedAt)
    appendChatTrace({
      operation: 'create',
      stage: 'local-fallback',
      sessionId: fallbackSession.sessionId,
      historySource: 'none',
      confirmedModel: defaultModel,
      intentSelectedModel: defaultModel,
      failureClass: classifyChatFailureClass(ensuredGateway.message),
      message: ensuredGateway.message,
    }, updatedAt)
    return fallbackSession
  }

  const createResult = await createUpstreamDirectChatSession({
    model: defaultModel,
    options,
  })
  if (createResult.ok && createResult.session) {
    const committedSession = await commitUpstreamCreatedChatSession({
      scopeKey,
      session: createResult.session,
      updatedAt,
    })
    appendChatTrace({
      operation: 'create',
      stage: 'upstream-created',
      sessionId: committedSession.sessionId,
      sessionKey: committedSession.sessionKey,
      historySource: 'none',
      confirmedModel: committedSession.model,
      intentSelectedModel: committedSession.selectedModel,
      failureClass: 'none',
      message: 'Created direct chat session through sessions.create.',
    }, updatedAt)
    return committedSession
  }

  if (createResult.fallbackSafe) {
    const fallbackSession = await createLocalFallbackChatSession(scopeKey, updatedAt)
    appendChatTrace({
      operation: 'create',
      stage: 'local-fallback',
      sessionId: fallbackSession.sessionId,
      historySource: 'none',
      confirmedModel: defaultModel,
      intentSelectedModel: defaultModel,
      failureClass: classifyChatFailureClass(createResult.message || ''),
      message: createResult.message || 'Fell back to local shell after a safe upstream create failure.',
    }, updatedAt)
    return fallbackSession
  }

  appendChatTrace({
    operation: 'create',
    stage: 'outcome-unknown',
    historySource: 'none',
    confirmedModel: defaultModel,
    intentSelectedModel: defaultModel,
    failureClass: classifyChatFailureClass(createResult.message || ''),
    message: createResult.message || 'Upstream create outcome is ambiguous.',
  }, updatedAt)
  throw createResult.error ?? new Error(createResult.message || '新会话创建结果不确定，请刷新会话列表后重试')
}

export async function createLocalChatSession(
  options: OpenClawChatServiceOptions = {}
): Promise<ChatSessionSummary> {
  const discoverOpenClawFn = options.discoverOpenClaw ?? discoverOpenClawInstallations
  const now = options.now ?? Date.now
  const scopeKey = await resolveChatScopeKey(discoverOpenClawFn)
  const updatedAt = now()
  const defaultModel = await tryResolveCreateChatSessionDefaultModel(options)
  const session = await createLocalFallbackChatSession(scopeKey, updatedAt)
  appendChatTrace(
    {
      operation: 'create',
      stage: 'local-fallback',
      sessionId: session.sessionId,
      historySource: 'none',
      confirmedModel: defaultModel,
      intentSelectedModel: defaultModel,
      failureClass: 'none',
      message: 'Created a local-only chat shell explicitly from the UI new-chat action.',
    },
    updatedAt
  )
  return session
}

export async function patchChatSessionModel(
  request: ChatPatchSessionModelRequest,
  options: OpenClawChatServiceOptions = {}
): Promise<ChatPatchSessionModelResult> {
  const normalizedSessionId = String(request.sessionId || '').trim()
  const normalizedModel = String(request.model || '').trim()
  if (!normalizedSessionId || !normalizedModel) {
    return {
      ok: false,
      sessionId: normalizedSessionId,
      model: normalizedModel || undefined,
      messageText: '会话 ID 和模型不能为空',
    }
  }

  const runCommand = options.runCommand ?? defaultRunCommand
  const callGatewayRpc = options.callGatewayRpc ?? defaultCallGatewayRpc
  const readModelStatusFn = options.readModelStatus ?? defaultReadModelStatus
  const discoverOpenClawFn = options.discoverOpenClaw ?? discoverOpenClawInstallations
  const scopeKey = await resolveChatScopeKey(discoverOpenClawFn)
  const localSessionState = await readLocalChatSessionState(scopeKey, normalizedSessionId)
  const matchedSessions = await resolveMergedChatSessions(options)
  const matchedSession =
    matchedSessions.sessions.find((session) => session.sessionId === normalizedSessionId) || null
  const patchIdentity = resolvePatchableSessionKey({
    matchedSession,
    localSessionState,
  })
  const sessionKey = patchIdentity.sessionKey
  const traceHistorySource = resolveOperationHistorySource({
    localSessionState,
    matchedSession,
  })

  appendChatTrace({
    operation: 'patch',
    stage: 'start',
    sessionId: normalizedSessionId,
    sessionKey: sessionKey || undefined,
    historySource: traceHistorySource,
    confirmedModel: String(matchedSession?.model || localSessionState?.model || '').trim() || undefined,
    intentSelectedModel: normalizedModel,
    failureClass: 'none',
    message: 'Starting session model patch via sessions.patch.',
  })

  if (!sessionKey) {
    appendChatTrace({
      operation: 'patch',
      stage: 'unavailable',
      sessionId: normalizedSessionId,
      historySource: traceHistorySource,
      confirmedModel: String(matchedSession?.model || localSessionState?.model || '').trim() || undefined,
      intentSelectedModel: normalizedModel,
      failureClass: 'semantic',
      message: CHAT_SESSION_MODEL_PATCH_UNAVAILABLE_MESSAGE,
    })
    return {
      ok: false,
      sessionId: normalizedSessionId,
      model: normalizedModel,
      messageText: CHAT_SESSION_MODEL_PATCH_UNAVAILABLE_MESSAGE,
    }
  }

  const modelStatus = await readModelStatusFn().catch(() => null)
  const allowedModels = new Set<string>(
    [
      ...(modelStatus?.ok ? normalizeModelList(modelStatus.data?.allowed) : []),
      modelStatus?.ok ? String(modelStatus.data?.defaultModel ?? modelStatus.data?.model ?? '').trim() : '',
    ].filter(Boolean)
  )
  if (allowedModels.size > 0 && !isModelAllowedByStatus(normalizedModel, allowedModels)) {
    appendChatTrace({
      operation: 'patch',
      stage: 'model-not-allowed',
      sessionId: normalizedSessionId,
      sessionKey,
      historySource: traceHistorySource,
      confirmedModel: String(matchedSession?.model || localSessionState?.model || '').trim() || undefined,
      intentSelectedModel: normalizedModel,
      failureClass: 'capability',
      message: `Target model ${normalizedModel} is not enabled in current OpenClaw status.allowed.`,
    })
    return {
      ok: false,
      sessionId: normalizedSessionId,
      sessionKey,
      model: normalizedModel,
      messageText: `当前 OpenClaw 未启用模型 ${normalizedModel}，请先在 OpenClaw 中配置并允许该模型后再试`,
    }
  }

  let patchFailure: CliLikeResult | null = null
  try {
    await callGatewayRpc(
      'sessions.patch',
      {
        key: sessionKey,
        model: normalizedModel,
      },
      CHAT_GATEWAY_CALL_TIMEOUT_MS
    )
  } catch (error) {
    if (shouldFallbackToCliGatewayCall(error)) {
      patchFailure = await runCommand(
        [
          'gateway',
          'call',
          'sessions.patch',
          '--json',
          '--params',
          JSON.stringify({
            key: sessionKey,
            model: normalizedModel,
          }),
          '--timeout',
          String(CHAT_GATEWAY_CALL_TIMEOUT_MS),
        ],
        CHAT_GATEWAY_CALL_TIMEOUT_MS
      ).catch((runError) => toCliLikeFailureResult(runError))
    } else {
      patchFailure = toCliLikeFailureResult(error)
    }
  }

  if (patchFailure && !patchFailure.ok) {
    const failureMessage = resolveChatModelSwitchFailureMessage(patchFailure)
    appendChatTrace({
      operation: 'patch',
      stage: 'failed',
      sessionId: normalizedSessionId,
      sessionKey,
      historySource: traceHistorySource,
      confirmedModel: String(matchedSession?.model || localSessionState?.model || '').trim() || undefined,
      intentSelectedModel: normalizedModel,
      failureClass: classifyChatFailureClass(failureMessage),
      message: failureMessage,
    })
    return {
      ok: false,
      sessionId: normalizedSessionId,
      sessionKey,
      model: normalizedModel,
      messageText: failureMessage,
    }
  }

  await ensureLocalChatSession({
    scopeKey,
    sessionId: normalizedSessionId,
    sessionKey: patchIdentity.source === 'trusted' ? sessionKey : undefined,
    upstreamConfirmed: patchIdentity.source === 'trusted' ? true : localSessionState?.upstreamConfirmed,
    agentId: matchedSession?.agentId || localSessionState?.agentId || DEFAULT_CHAT_AGENT_ID,
    model: normalizedModel,
    selectedModel: normalizedModel,
    transportSessionId: localSessionState?.transportSessionId,
    transportModel: normalizedModel,
    kind: matchedSession?.kind || localSessionState?.kind || 'direct',
    updatedAt: Date.now(),
  })

  appendChatTrace({
    operation: 'patch',
    stage: 'succeeded',
    sessionId: normalizedSessionId,
    sessionKey,
    historySource: traceHistorySource,
    confirmedModel: normalizedModel,
    intentSelectedModel: normalizedModel,
    failureClass: 'none',
    message: 'Session model patch completed successfully.',
  })

  return {
    ok: true,
    sessionId: normalizedSessionId,
    sessionKey: patchIdentity.source === 'trusted' ? sessionKey : undefined,
    model: normalizedModel,
  }
}

function resolveDefaultModelFromStatus(status: ModelConfigCommandResult<Record<string, any>> | null | undefined): string | undefined {
  if (!status?.ok) return undefined
  return resolvePreferredRuntimeDefaultModelKey(status.data || {}) || undefined
}

function resolveRawDefaultModelFromStatus(
  status: ModelConfigCommandResult<Record<string, any>> | null | undefined
): string | undefined {
  if (!status?.ok) return undefined
  return extractRuntimeDefaultModelKey(status.data || {}) || undefined
}

function resolveTargetChatModel(params: {
  localSessionState?: Awaited<ReturnType<typeof readLocalChatSessionState>> | null
  matchedSession?: ChatSessionSummary | null
  defaultModel?: string
}): string | undefined {
  return (
    String(params.localSessionState?.model || '').trim() ||
    String(params.matchedSession?.model || '').trim() ||
    String(params.defaultModel || '').trim() ||
    undefined
  )
}

function isLegacyMiniMaxModel(model: unknown): boolean {
  return String(model || '').trim().toLowerCase().startsWith('minimax/')
}

function isMiniMaxPortalModel(model: unknown): boolean {
  return String(model || '').trim().toLowerCase().startsWith('minimax-portal/')
}

function findEquivalentMiniMaxPortalModelKey(targetModel: string, candidates: Array<unknown>): string {
  return candidates
    .map((candidate) => String(candidate || '').trim())
    .find((candidate) => candidate && isMiniMaxPortalModel(candidate) && areRuntimeModelsEquivalent(candidate, targetModel))
    || ''
}

function resolveLegacyMiniMaxSessionRepairTarget(params: {
  currentModel?: string
  modelStatus?: ModelConfigCommandResult<Record<string, any>> | null
}): string | undefined {
  const currentModel = String(params.currentModel || '').trim()
  if (!currentModel || !isLegacyMiniMaxModel(currentModel) || !params.modelStatus?.ok) {
    return undefined
  }

  const statusData = params.modelStatus.data || {}
  const portalTargetModel =
    [
      findEquivalentMiniMaxPortalModelKey(currentModel, [resolveRuntimeWritableModelKey(currentModel, statusData)]),
      findEquivalentMiniMaxPortalModelKey(currentModel, collectRuntimeConnectedModelKeys(statusData)),
      findEquivalentMiniMaxPortalModelKey(currentModel, normalizeModelList(statusData.allowed)),
    ]
      .map((candidate) => String(candidate || '').trim())
      .find((candidate) => candidate && isMiniMaxPortalModel(candidate) && areRuntimeModelsEquivalent(currentModel, candidate))
      || ''
  if (!portalTargetModel) {
    return undefined
  }
  if (portalTargetModel === currentModel) {
    return undefined
  }

  return portalTargetModel
}

function resolveSelectedModelForSendPrelude(params: {
  localSessionState?: Awaited<ReturnType<typeof readLocalChatSessionState>> | null
  matchedSession?: ChatSessionSummary | null
  targetModel?: string
}): string | undefined {
  const confirmedModel =
    String(params.localSessionState?.model || '').trim() ||
    String(params.matchedSession?.model || '').trim()
  if (confirmedModel) return confirmedModel

  return (
    String(params.localSessionState?.selectedModel || '').trim() ||
    String(params.targetModel || '').trim() ||
    undefined
  )
}

function resolveSelectedModelForSendCommit(params: {
  finalModel?: string
  targetModel?: string
  matchedSession?: ChatSessionSummary | null
  localSessionState?: Awaited<ReturnType<typeof readLocalChatSessionState>> | null
}): string | undefined {
  return (
    String(params.finalModel || '').trim() ||
    String(params.targetModel || '').trim() ||
    String(params.matchedSession?.model || '').trim() ||
    String(params.localSessionState?.model || '').trim() ||
    undefined
  )
}

function shouldBootstrapTrustedUpstreamSessionForSend(params: {
  trustedSessionKey?: string
  shouldForkVisibleConversation: boolean
  hasLocalSessionState: boolean
  rawDefaultModel?: string
  preferredModel?: string
}): boolean {
  if (params.trustedSessionKey) return false
  if (params.shouldForkVisibleConversation) return false

  const preferredModel = String(params.preferredModel || '').trim()
  if (!preferredModel) return false

  if (params.hasLocalSessionState) return true

  const rawDefaultModel = String(params.rawDefaultModel || '').trim()
  if (!rawDefaultModel) return true

  return rawDefaultModel !== preferredModel
}

export function shouldPreferControlUiBrowserChatTransportForSend(params: {
  sessionKey?: string
  continueWithExternalSessionKey?: string
  localSessionState?: LocalChatSessionState | null
}): boolean {
  const sessionKey = String(params.sessionKey || '').trim()
  if (!sessionKey) return false
  if (String(params.continueWithExternalSessionKey || '').trim()) return true

  if (
    params.localSessionState?.upstreamConfirmed === true &&
    (params.localSessionState.kind || 'direct') === 'direct'
  ) {
    return false
  }

  return true
}

function shouldRetryConfirmedLocalDirectViaControlUiBrowser(params: {
  result: CliLikeResult | null | undefined
  sessionKey?: string
  continueWithExternalSessionKey?: string
  localSessionState?: LocalChatSessionState | null
}): boolean {
  if (!params.result || params.result.ok || params.result.canceled) return false
  if (!String(params.sessionKey || '').trim()) return false
  if (String(params.continueWithExternalSessionKey || '').trim()) return false

  if (
    params.localSessionState?.upstreamConfirmed !== true ||
    (params.localSessionState.kind || 'direct') !== 'direct'
  ) {
    return false
  }

  const merged = `${params.result.stderr || ''}\n${params.result.stdout || ''}`
  return /cannot safely continue an explicit external session key/i.test(merged)
}

function resolvePatchableSessionKey(params: {
  matchedSession?: ChatSessionSummary | null
  localSessionState?: LocalChatSessionState | null
}): ResolvedPatchableSessionIdentity {
  const trustedSessionKey = resolveTrustedChatSessionKey({
    matchedSession: params.matchedSession,
    localSessionState: params.localSessionState,
  })
  if (
    trustedSessionKey &&
    !(
      isExternalOnlyChatSession({
        hasLocalTranscript: params.matchedSession?.hasLocalTranscript === true,
        localOnly: params.matchedSession?.localOnly,
      }) &&
      isChannelBackedChatSession({
        sessionKey: params.matchedSession?.sessionKey,
        kind: params.matchedSession?.kind,
      })
    )
  ) {
    return {
      sessionKey: trustedSessionKey,
      source: 'trusted',
    }
  }

  const legacyBridgeSessionKey = resolveLegacyTransportBridgeSessionKey({
    matchedSession: params.matchedSession,
    localSessionState: params.localSessionState,
  })
  if (legacyBridgeSessionKey) {
    return {
      sessionKey: legacyBridgeSessionKey,
      source: 'legacy-transport',
    }
  }

  return {
    source: 'none',
  }
}

function shouldForkChatSession(params: {
  session: ChatSessionSummary | null
  localSessionState?: LocalChatSessionState | null
}): boolean {
  const session = params.session
  if (!session) return Boolean(params.localSessionState?.messages.length)

  if (isChannelBackedChatSession({ sessionKey: session.sessionKey, kind: session.kind })) {
    return session.canContinue !== true
  }

  if (session.kind !== 'direct') return true

  if (session.canContinue === true) return false

  if (session.authorityKind === 'local-cache-only') {
    return Boolean(params.localSessionState?.messages.length)
  }

  return true
}

function resolveTransportSession(params: {
  requestedSessionId: string
  localSessionState: LocalChatSessionState | null
  shouldForkVisibleConversation: boolean
}): ResolvedTransportSession {
  const conversationId = params.shouldForkVisibleConversation ? randomUUID() : params.requestedSessionId
  const localTransportId = String(params.localSessionState?.transportSessionId || '').trim()

  if (!params.shouldForkVisibleConversation && localTransportId) {
    return {
      conversationId,
      transportSessionId: localTransportId,
      shouldSeedTransport: false,
    }
  }

  if (!params.shouldForkVisibleConversation) {
    return {
      conversationId,
      transportSessionId: params.requestedSessionId,
      shouldSeedTransport: false,
    }
  }

  return {
    conversationId,
    transportSessionId: randomUUID(),
    shouldSeedTransport: Boolean(params.localSessionState?.messages.length),
  }
}

export async function clearChatTranscript(
  sessionId: string,
  options: OpenClawChatServiceOptions = {}
): Promise<{ ok: boolean; sessionId: string }> {
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedSessionId) {
    throw new Error('sessionId is required')
  }

  const discoverOpenClawFn = options.discoverOpenClaw ?? discoverOpenClawInstallations
  const scopeKey = await resolveChatScopeKey(discoverOpenClawFn)
  const ok = await clearLocalChatTranscript(scopeKey, normalizedSessionId)
  return { ok, sessionId: normalizedSessionId }
}

export async function sendChatMessage(
  request: ChatSendRequest,
  options: OpenClawChatServiceOptions = {}
): Promise<ChatSendResult> {
  // Important invariant: sending a message must never decide or override the
  // session model. OpenClaw Control UI changes models via `sessions.patch`;
  // Qclaw mirrors that contract and only sends against the session's current
  // resolved model.
  const requestedSessionId = String(request.sessionId || '').trim()
  const text = String(request.text || '').trim()
  if (hasSendTimeModelOverride(request)) {
    return {
      ok: false,
      sessionId: requestedSessionId,
      errorCode: 'invalid-input',
      messageText: resolveSendTimeModelOverrideErrorMessage('聊天发送请求'),
    }
  }
  if (!requestedSessionId || !text) {
    return {
      ok: false,
      sessionId: requestedSessionId,
      errorCode: 'invalid-input',
      messageText: '会话 ID 和消息内容不能为空',
    }
  }

  const discoverOpenClawFn = options.discoverOpenClaw ?? discoverOpenClawInstallations
  const ensureGatewayFn = options.ensureGateway ?? ensureGatewayRunning
  const readModelStatusFn = options.readModelStatus ?? defaultReadModelStatus
  const useDefaultAuthRepair = readModelStatusFn === defaultReadModelStatus
  const repairAgentAuthProfiles =
    options.repairAgentAuthProfiles ??
    (useDefaultAuthRepair ? defaultRepairAgentAuthProfiles : noopRepairAgentAuthProfiles)
  const repairMainAuthProfiles =
    options.repairMainAuthProfiles ??
    (useDefaultAuthRepair ? defaultRepairMainAuthProfiles : noopRepairMainAuthProfiles)
  const runStreamingCommand = options.runStreamingCommand ?? defaultRunStreamingCommand
  const now = options.now ?? Date.now
  const emit = options.emit ?? (() => {})
  let gatewayResult: GatewayEnsureLike | null = null
  const ensureGatewayAvailable = async (): Promise<GatewayEnsureLike> => {
    if (!gatewayResult) {
      gatewayResult = await ensureGatewayFn()
    }
    return gatewayResult
  }
  const resolvedSessions = await resolveMergedChatSessions(options)
  const scopeKey = resolvedSessions.scopeKey
  let matchedSession = resolvedSessions.sessions.find((session) => session.sessionId === requestedSessionId) || null
  let localSessionState = await readLocalChatSessionState(scopeKey, requestedSessionId)
  let defaultModel: string | undefined
  let rawDefaultModel: string | undefined
  let targetModel: string | undefined
  let modelStatus: ModelConfigCommandResult<Record<string, any>> | null = null
  try {
    modelStatus = await readModelStatusFn()
    rawDefaultModel = resolveRawDefaultModelFromStatus(modelStatus)
    defaultModel = resolveDefaultModelFromStatus(modelStatus)
    targetModel = resolveTargetChatModel({
      localSessionState,
      matchedSession,
      defaultModel,
    })
  } catch {
    targetModel = resolveTargetChatModel({
      localSessionState,
      matchedSession,
      defaultModel,
    })
  }

  const authRepairProviderIds = resolveAuthRepairProviderIds({
    modelStatus,
    targetModel,
  })
  const agentScopedAuthRepairProviderIds = authRepairProviderIds.filter((providerId) =>
    isMiniMaxAuthRepairProvider(providerId)
  )
  const mainScopedAuthRepairProviderIds = authRepairProviderIds.filter(
    (providerId) => !isMiniMaxAuthRepairProvider(providerId)
  )
  if (agentScopedAuthRepairProviderIds.length > 0) {
    try {
      const repairResult = await repairAgentAuthProfiles({
        providerIds: agentScopedAuthRepairProviderIds,
        agentId:
          String(matchedSession?.agentId || localSessionState?.agentId || DEFAULT_CHAT_AGENT_ID).trim()
          || DEFAULT_CHAT_AGENT_ID,
      })
      if (repairResult.ok && repairResult.repaired) {
        dashboardChatAvailabilityModelStatusCache.expiresAt = 0
        dashboardChatAvailabilityModelStatusCache.value = null
      }
    } catch {
      // Best-effort repair only. Chat send should continue even if repair fails.
    }
  }
  if (mainScopedAuthRepairProviderIds.length > 0) {
    try {
      const repairResult = await repairMainAuthProfiles(mainScopedAuthRepairProviderIds)
      if (repairResult.ok && repairResult.repaired) {
        dashboardChatAvailabilityModelStatusCache.expiresAt = 0
        dashboardChatAvailabilityModelStatusCache.value = null
      }
    } catch {
      // Best-effort repair only. Chat send should continue even if repair fails.
    }
  }

  const shouldForkVisibleConversation = shouldForkChatSession({
    session: matchedSession,
    localSessionState,
  })
  if (shouldForkVisibleConversation && localSessionState) {
    const reconciledSelectedModel =
      String(localSessionState.model || matchedSession?.model || '').trim() || undefined
    if (reconciledSelectedModel && reconciledSelectedModel !== String(localSessionState.selectedModel || '').trim()) {
      await ensureLocalChatSession({
        scopeKey,
        sessionId: requestedSessionId,
        sessionKey: localSessionState.sessionKey,
        agentId: localSessionState.agentId,
        model: localSessionState.model,
        selectedModel: reconciledSelectedModel,
        transportSessionId: localSessionState.transportSessionId,
        transportModel: localSessionState.transportModel,
        kind: localSessionState.kind,
        updatedAt: now(),
      })
      localSessionState = {
        ...localSessionState,
        selectedModel: reconciledSelectedModel,
      }
    }
  }
  const trustedSessionKey = resolveTrustedChatSessionKey({
    matchedSession,
    localSessionState,
  })
  const continueWithExternalSessionKey = (() => {
    const source = parseChatSessionSourceFromKey(matchedSession?.sessionKey)
    if (source.sourceType !== 'channel') return undefined
    return trustedSessionKey || undefined
  })()
  const transport = resolveTransportSession({
    requestedSessionId,
    localSessionState,
    shouldForkVisibleConversation,
  })
  const sessionId = transport.conversationId
  const transportSessionId = transport.transportSessionId
  const shouldSeedTransport =
    transport.shouldSeedTransport && Boolean(localSessionState) && !continueWithExternalSessionKey
  const effectiveMessageText =
    shouldSeedTransport && localSessionState
      ? buildSeededTurnMessage(localSessionState.messages, text)
      : text
  let persistedSessionKey =
    continueWithExternalSessionKey ||
    (!shouldForkVisibleConversation ? trustedSessionKey : '') ||
    undefined
  const cliTransport = createCliChatTransport({
    runStreamingCommand,
  })
  const defaultGatewayTransport = createGatewayStreamingChatTransport({
    readConfig,
    readEnvFile,
    fallbackTransport: cliTransport,
  })
  const browserGatewayTransport = createControlUiBrowserChatTransport({
    fallbackTransport: defaultGatewayTransport,
  })
  const resolvePreferredGatewayTransport = () =>
    shouldPreferControlUiBrowserChatTransportForSend({
      sessionKey: persistedSessionKey,
      continueWithExternalSessionKey,
      localSessionState,
    })
      ? browserGatewayTransport
      : defaultGatewayTransport
  let chatTransport =
    options.chatTransport ?? resolvePreferredGatewayTransport()
  const traceHistorySource = resolveOperationHistorySource({
    localSessionState,
    matchedSession,
  })

  appendChatTrace({
    operation: 'send',
    stage: 'start',
    sessionId,
    sessionKey: persistedSessionKey || undefined,
    historySource: traceHistorySource,
    confirmedModel: String(matchedSession?.model || localSessionState?.model || targetModel || '').trim() || undefined,
    intentSelectedModel: String(localSessionState?.selectedModel || targetModel || '').trim() || undefined,
    failureClass: 'none',
    message: 'Starting chat send with resolved session identity.',
  })

  const ensuredGateway = await ensureGatewayAvailable()
  if (!ensuredGateway.ok || !ensuredGateway.running) {
    const messageText = getCliFailureMessage(ensuredGateway, '网关当前不可用，暂时无法发送消息')
    const canSafelyFallbackToCli =
      !persistedSessionKey &&
      (Boolean(localSessionState) || matchedSession?.localOnly === true || shouldForkVisibleConversation)
    appendChatTrace({
      operation: 'send',
      stage: canSafelyFallbackToCli ? 'gateway-unavailable-cli-fallback' : 'gateway-unavailable',
      sessionId,
      sessionKey: persistedSessionKey || undefined,
      historySource: traceHistorySource,
      confirmedModel: String(matchedSession?.model || localSessionState?.model || targetModel || '').trim() || undefined,
      intentSelectedModel: String(localSessionState?.selectedModel || targetModel || '').trim() || undefined,
      failureClass: classifyChatFailureClass(messageText),
      message: canSafelyFallbackToCli
        ? `${messageText}；falling back to CLI transport for a local-safe conversation shell.`
        : messageText,
    })
    if (!canSafelyFallbackToCli) {
      return {
        ok: false,
        sessionId,
        errorCode: 'gateway-offline',
        messageText,
      }
    }
    chatTransport = cliTransport
  }

  const shouldBootstrapTrustedSession = shouldBootstrapTrustedUpstreamSessionForSend({
    trustedSessionKey: persistedSessionKey,
    shouldForkVisibleConversation,
    hasLocalSessionState: Boolean(localSessionState),
    rawDefaultModel,
    preferredModel: targetModel,
  })
  if (ensuredGateway.ok && ensuredGateway.running && shouldBootstrapTrustedSession) {
    const bootstrapResult = await createUpstreamDirectChatSession({
      model: targetModel,
      options,
    })
    if (bootstrapResult.ok && bootstrapResult.session) {
      const materializedModel = String(bootstrapResult.session.model || targetModel || '').trim() || undefined
      persistedSessionKey = bootstrapResult.session.sessionKey
      targetModel = materializedModel || targetModel
      await ensureLocalChatSession({
        scopeKey,
        sessionId,
        sessionKey: persistedSessionKey,
        upstreamConfirmed: true,
        agentId: bootstrapResult.session.agentId || matchedSession?.agentId || localSessionState?.agentId || DEFAULT_CHAT_AGENT_ID,
        model: materializedModel || localSessionState?.model || matchedSession?.model || targetModel,
        selectedModel:
          materializedModel
          || resolveSelectedModelForSendPrelude({
            localSessionState,
            matchedSession,
            targetModel,
          }),
        transportSessionId,
        transportModel: materializedModel || targetModel || localSessionState?.transportModel || matchedSession?.model,
        kind: 'direct',
        updatedAt: now(),
      })
      localSessionState = await readLocalChatSessionState(scopeKey, sessionId)
      appendChatTrace({
        operation: 'send',
        stage: 'bootstrap-session-created',
        sessionId,
        sessionKey: persistedSessionKey,
        historySource: traceHistorySource,
        confirmedModel: String(materializedModel || targetModel || '').trim() || undefined,
        intentSelectedModel: String(localSessionState?.selectedModel || targetModel || '').trim() || undefined,
        failureClass: 'none',
        message: 'Created an upstream direct session before the first send to pin the corrected runtime model.',
      })
    } else if (bootstrapResult.fallbackSafe) {
      appendChatTrace({
        operation: 'send',
        stage: 'bootstrap-session-fallback',
        sessionId,
        historySource: traceHistorySource,
        confirmedModel: String(targetModel || '').trim() || undefined,
        intentSelectedModel: String(localSessionState?.selectedModel || targetModel || '').trim() || undefined,
        failureClass: classifyChatFailureClass(bootstrapResult.message || ''),
        message: bootstrapResult.message || 'Fell back to the legacy first-send flow after sessions.create was unavailable.',
      })
    } else {
      const messageText = bootstrapResult.message || '首条消息创建上游会话失败'
      appendChatTrace({
        operation: 'send',
        stage: 'bootstrap-session-failed',
        sessionId,
        historySource: traceHistorySource,
        confirmedModel: String(targetModel || '').trim() || undefined,
        intentSelectedModel: String(localSessionState?.selectedModel || targetModel || '').trim() || undefined,
        failureClass: classifyChatFailureClass(messageText),
        message: messageText,
      })
      emit({
        type: 'assistant-error',
        sessionId,
        errorCode: classifySendErrorCode(messageText),
        messageText,
      })
      return {
        ok: false,
        sessionId,
        errorCode: classifySendErrorCode(messageText),
        messageText,
      }
    }
  }

  if (!options.chatTransport && ensuredGateway.ok && ensuredGateway.running) {
    chatTransport = resolvePreferredGatewayTransport()
  }

  const legacyMiniMaxRepairTarget =
    !shouldForkVisibleConversation
      ? resolveLegacyMiniMaxSessionRepairTarget({
          currentModel:
            String(localSessionState?.model || matchedSession?.model || targetModel || '').trim() || undefined,
          modelStatus,
        })
      : undefined
  if (legacyMiniMaxRepairTarget) {
    const patchIdentity = resolvePatchableSessionKey({
      matchedSession,
      localSessionState,
    })
    if (patchIdentity.source === 'trusted') {
      const patchResult = await patchChatSessionModel(
        {
          sessionId: requestedSessionId,
          model: legacyMiniMaxRepairTarget,
        },
        {
          ...options,
          readModelStatus: async () => modelStatus || readModelStatusFn(),
        }
      )
      if (!patchResult.ok) {
        return {
          ok: false,
          sessionId,
          errorCode: classifySendErrorCode(patchResult.messageText || '聊天消息发送失败'),
          messageText: patchResult.messageText || '聊天消息发送失败',
        }
      }

      targetModel = patchResult.model || legacyMiniMaxRepairTarget
      localSessionState = await readLocalChatSessionState(scopeKey, requestedSessionId)
      matchedSession = matchedSession
        ? {
            ...matchedSession,
            model: targetModel,
          }
        : matchedSession
    }
  }

  await ensureLocalChatSession({
    scopeKey,
    sessionId,
    sessionKey: persistedSessionKey,
    upstreamConfirmed: Boolean(persistedSessionKey),
    agentId: DEFAULT_CHAT_AGENT_ID,
    model: localSessionState?.model || matchedSession?.model || targetModel,
    selectedModel: resolveSelectedModelForSendPrelude({
      localSessionState,
      matchedSession,
      targetModel,
    }),
    transportSessionId,
    transportModel: targetModel || localSessionState?.transportModel || matchedSession?.model,
    kind: 'direct',
    updatedAt: now(),
  })

  const modelKey = String(targetModel || matchedSession?.model || '').trim()
  let learnedCompat = modelKey ? await readChatThinkingCompat(modelKey) : undefined
  let thinkingResolution = resolveChatThinking({
    requestedThinking: request.thinking,
    learnedCompat,
  })
  const attemptedThinking: ChatThinkingLevel[] = []
  let streamedText = ''
  let streamedModel: string | undefined
  let streamedUsage: ChatUsage | undefined
  const abortController = new AbortController()
  let attemptedControlUiBrowserRetry = false

  emit({
    type: 'assistant-start',
    sessionId,
  })

  let result: CliLikeResult | null = null
  trackActiveAbortController(abortController, 'chat')
  try {
    for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
      const effectiveThinking = thinkingResolution.effectiveThinking
      const runTransport = async (transport: ChatTransport) =>
        transport.run({
          transportSessionId,
          sessionKey: persistedSessionKey,
          messageText: effectiveMessageText,
          thinking: effectiveThinking,
          signal: abortController.signal,
          onAssistantDelta: ({ text, delta, model, usage }) => {
            streamedText = text
            streamedModel = model || streamedModel
            streamedUsage = usage || streamedUsage
            emit({
              type: 'assistant-delta',
              sessionId,
              textDelta: delta,
              text,
              model,
              usage,
            })
          },
        })

      result = await runTransport(chatTransport)
      if (
        !attemptedControlUiBrowserRetry &&
        shouldRetryConfirmedLocalDirectViaControlUiBrowser({
          result,
          sessionKey: persistedSessionKey,
          continueWithExternalSessionKey,
          localSessionState,
        })
      ) {
        attemptedControlUiBrowserRetry = true
        chatTransport = browserGatewayTransport
        appendChatTrace({
          operation: 'send',
          stage: 'transport-browser-retry',
          sessionId,
          sessionKey: persistedSessionKey || undefined,
          historySource: traceHistorySource,
          confirmedModel: String(streamedModel || targetModel || matchedSession?.model || '').trim() || undefined,
          intentSelectedModel: String(localSessionState?.selectedModel || targetModel || '').trim() || undefined,
          failureClass: classifyChatFailureClass(result.stderr || result.stdout || ''),
          message: 'Gateway transport could not safely reuse the trusted session; retrying through Control UI browser.',
        })
        streamedText = ''
        streamedModel = undefined
        streamedUsage = undefined
        result = await runTransport(browserGatewayTransport)
      }

      if (result.ok) {
        break
      }

      const messageText = result.canceled ? '已停止回答' : getCliFailureMessage(result, '聊天消息发送失败')
      const attemptedWithCurrent = [...attemptedThinking, effectiveThinking]
      const fallbackThinking =
        result.canceled || !modelKey
          ? undefined
          : pickFallbackThinkingFromError({
              message: messageText,
              attempted: attemptedWithCurrent,
            })

      attemptedThinking.push(effectiveThinking)
      if (attemptIndex === 0 && fallbackThinking && fallbackThinking !== effectiveThinking) {
        learnedCompat = await writeChatThinkingCompat(modelKey, {
          unsupported: effectiveThinking,
          fallback: fallbackThinking,
          learnedAt: now(),
          sourceError: messageText,
        })
        thinkingResolution = resolveChatThinking({
          requestedThinking: request.thinking,
          learnedCompat,
        })
        streamedText = ''
        streamedModel = undefined
        streamedUsage = undefined
        continue
      }

      const errorCode = result.canceled ? 'canceled' : classifySendErrorCode(messageText)
      appendChatTrace({
        operation: 'send',
        stage: result.canceled ? 'canceled' : 'failed',
        sessionId,
        sessionKey: persistedSessionKey || undefined,
        historySource: traceHistorySource,
        confirmedModel: String(streamedModel || targetModel || matchedSession?.model || '').trim() || undefined,
        intentSelectedModel: String(localSessionState?.selectedModel || targetModel || '').trim() || undefined,
        failureClass: classifyChatFailureClass(messageText),
        message: messageText,
      })
      emit({
        type: 'assistant-error',
        sessionId,
        errorCode,
        messageText,
      })
      return {
        ok: false,
        sessionId,
        errorCode,
        messageText,
      }
    }
  } finally {
    trackActiveAbortController(null, 'chat')
  }

  if (!result?.ok) {
    appendChatTrace({
      operation: 'send',
      stage: 'failed',
      sessionId,
      sessionKey: persistedSessionKey || undefined,
      historySource: traceHistorySource,
      confirmedModel: String(streamedModel || targetModel || matchedSession?.model || '').trim() || undefined,
      intentSelectedModel: String(localSessionState?.selectedModel || targetModel || '').trim() || undefined,
      failureClass: 'unknown',
      message: '聊天消息发送失败',
    })
    emit({
      type: 'assistant-error',
      sessionId,
      errorCode: 'command-failed',
      messageText: '聊天消息发送失败',
    })
    return {
      ok: false,
      sessionId,
      errorCode: 'command-failed',
      messageText: '聊天消息发送失败',
    }
  }

  const parsedReply = parseAgentReplyOutput(result.stdout)
  const replyText = String(parsedReply.text || streamedText || '').trim()
  if (!replyText) {
    appendChatTrace({
      operation: 'send',
      stage: 'parse-failed',
      sessionId,
      sessionKey: persistedSessionKey || undefined,
      historySource: traceHistorySource,
      confirmedModel: String(streamedModel || targetModel || matchedSession?.model || '').trim() || undefined,
      intentSelectedModel: String(localSessionState?.selectedModel || targetModel || '').trim() || undefined,
      failureClass: 'unknown',
      message: '聊天响应不可解析，请稍后重试',
    })
    emit({
      type: 'assistant-error',
      sessionId,
      errorCode: 'parse-failed',
      messageText: '聊天响应不可解析，请稍后重试',
    })
    return {
      ok: false,
      sessionId,
      errorCode: 'parse-failed',
      messageText: '聊天响应不可解析，请稍后重试',
    }
  }

  const createdAt = now()
  const finalModel = parsedReply.model || streamedModel
  const finalUsage = parsedReply.usage || streamedUsage
  const userMessage = buildChatMessage({
    role: 'user',
    text,
    createdAt: createdAt - 1,
  })
  userMessage.transportSessionId = transportSessionId
  const assistantMessage = buildChatMessage({
    role: 'assistant',
    text: replyText,
    createdAt,
    model: finalModel,
    usage: finalUsage,
  })
  assistantMessage.transportSessionId = transportSessionId

  await appendLocalChatMessages({
    scopeKey,
    sessionId,
    sessionKey: persistedSessionKey,
    upstreamConfirmed: Boolean(persistedSessionKey),
    agentId: DEFAULT_CHAT_AGENT_ID,
    model: finalModel,
    selectedModel: resolveSelectedModelForSendCommit({
      finalModel,
      targetModel,
      matchedSession,
      localSessionState,
    }),
    transportSessionId,
    transportModel: finalModel || targetModel,
    kind: 'direct',
    messages: [userMessage, assistantMessage],
    updatedAt: createdAt,
  })

  emit({
    type: 'assistant-complete',
    sessionId,
    message: assistantMessage,
  })

  appendChatTrace({
    operation: 'send',
    stage: 'succeeded',
    sessionId,
    sessionKey: persistedSessionKey || undefined,
    historySource: traceHistorySource,
    confirmedModel: String(finalModel || targetModel || '').trim() || undefined,
    intentSelectedModel:
      String(localSessionState?.selectedModel || matchedSession?.selectedModel || finalModel || targetModel || '').trim() ||
      undefined,
    failureClass: 'none',
    message: 'Chat send completed successfully.',
  })

  return {
    ok: true,
    sessionId,
    message: assistantMessage,
  }
}
