import type { ChatUsage } from '../../../src/shared/chat-panel'
import {
  CHAT_REPLY_REJECTED_PATH_PATTERN,
  sanitizeAssistantRawFallbackText,
  sanitizeAssistantVisibleText,
} from '../../../src/shared/chat-visible-text'
import type {
  ChatTransport,
  ChatTransportRunParams,
  ChatTransportRunResult,
} from './chat-transport-types'
import { assertNoSendTimeModelOverride } from '../chat-model-switching-invariant'
import { loadOpenClawGatewayRuntime } from '../openclaw-gateway-runtime'
import { buildOpenClawLegacyEnvPatch, resolveOpenClawEnvValue } from '../openclaw-legacy-env-migration'

const { randomUUID } = process.getBuiltinModule('node:crypto') as typeof import('node:crypto')

const GATEWAY_CONNECT_TIMEOUT_MS = 5_000
const GATEWAY_REQUEST_TIMEOUT_MS = 15_000
const GATEWAY_STREAM_TIMEOUT_MS = 10 * 60 * 1000

type GatewayClientMode = 'webchat' | 'ui' | 'backend'

interface GatewayChatTransportDependencies {
  readConfig: () => Promise<Record<string, any> | null>
  readEnvFile: () => Promise<Record<string, string>>
  fallbackTransport?: ChatTransport
  createSocket?: (url: string) => WebSocket
  loadGatewayRuntime?: typeof loadOpenClawGatewayRuntime
}

interface GatewayConnectionSettings {
  url: string
  token: string
  password?: string
  clientId: string
  clientMode: GatewayClientMode
  clientVersion: string
}

interface GatewayRpcCallOptions {
  clientId?: string
  clientMode?: GatewayClientMode
  clientVersion?: string
  timeoutMs?: number
}

interface PendingGatewayRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout> | null
}

interface GatewayEventFrame {
  type: 'event'
  event: string
  payload?: unknown
  seq?: number
}

interface GatewayResponseFrame {
  type: 'res'
  id: string
  ok: boolean
  payload?: unknown
  error?: {
    code?: string
    message?: string
    details?: unknown
  }
}

interface GatewayChatEventPayload {
  runId: string
  sessionKey: string
  seq: number
  state: 'delta' | 'final' | 'aborted' | 'error'
  message?: unknown
  errorMessage?: string
  usage?: unknown
  stopReason?: string
}

interface ParsedGatewayChatMessage {
  text: string | null
  mode: 'delta' | 'snapshot'
  model?: string
  usage?: ChatUsage
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

function normalizeRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function toOptionalString(value: unknown): string | undefined {
  const normalized = String(value || '').trim()
  return normalized || undefined
}

function toOptionalTokenCount(value: unknown): number | undefined {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return parsed
}

function parseUsageCandidate(value: unknown): ChatUsage | undefined {
  const record = normalizeRecord(value)
  if (!record) return undefined

  const usage: ChatUsage = {}
  usage.inputTokens = [
    record.inputTokens,
    record.input_tokens,
    record.promptTokens,
    record.prompt_tokens,
  ]
    .map(toOptionalTokenCount)
    .find((candidate): candidate is number => candidate != null)
  usage.outputTokens = [
    record.outputTokens,
    record.output_tokens,
    record.completionTokens,
    record.completion_tokens,
    record.replyTokens,
  ]
    .map(toOptionalTokenCount)
    .find((candidate): candidate is number => candidate != null)
  usage.totalTokens = [record.totalTokens, record.total_tokens]
    .map(toOptionalTokenCount)
    .find((candidate): candidate is number => candidate != null)
  usage.reasoningTokens = [record.reasoningTokens, record.reasoning_tokens, record.thinkingTokens]
    .map(toOptionalTokenCount)
    .find((candidate): candidate is number => candidate != null)

  return Object.values(usage).some((candidate) => candidate != null) ? usage : undefined
}

function parseUsageFromPayload(value: unknown): ChatUsage | undefined {
  const record = normalizeRecord(value)
  if (!record) return undefined

  const candidates: unknown[] = [
    record,
    record.usage,
    record.message,
    record.response,
    record.result,
  ]

  for (const candidate of candidates) {
    const usage = parseUsageCandidate(candidate)
    if (usage) return usage
  }
  return undefined
}

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

function selectPreferredLeaf(leaves: StringLeaf[], matcher: RegExp, rejectedPath?: RegExp): string | undefined {
  for (const leaf of leaves) {
    if (!matcher.test(leaf.path)) continue
    if (rejectedPath?.test(leaf.path)) continue
    return leaf.value
  }
  return undefined
}

function selectBestReplyLeaf(leaves: StringLeaf[]): string | undefined {
  const preferredPath =
    /\b(response\.text|reply\.text|result\.text|message\.content|message\.text|assistant\.text|content|text)\b/i
  const preferred = selectPreferredLeaf(leaves, preferredPath, CHAT_REPLY_REJECTED_PATH_PATTERN)
  if (preferred) return preferred

  return leaves.find((leaf) => {
    if (CHAT_REPLY_REJECTED_PATH_PATTERN.test(leaf.path)) return false
    if (isExplicitAssistantTextPath(leaf.path)) return true
    return Boolean(sanitizeAssistantRawFallbackText(leaf.value))
  })?.value
}

function findFirstStringField(value: unknown, keys: string[]): string | undefined {
  const record = normalizeRecord(value)
  if (!record) return undefined
  for (const key of keys) {
    const nested = record[key]
    if (typeof nested === 'string' && nested.trim()) return nested.trim()
  }
  return undefined
}

function applyStreamTextUpdate(
  currentText: string,
  incomingText: string,
  mode: 'delta' | 'snapshot'
): { nextText: string; delta: string } {
  const normalizedCurrent = String(currentText || '')
  const normalizedIncoming = String(incomingText || '')
  if (!normalizedIncoming) {
    return {
      nextText: normalizedCurrent,
      delta: '',
    }
  }

  if (mode === 'delta') {
    if (normalizedCurrent.endsWith(normalizedIncoming)) {
      return {
        nextText: normalizedCurrent,
        delta: '',
      }
    }
    if (normalizedIncoming.startsWith(normalizedCurrent)) {
      return {
        nextText: normalizedIncoming,
        delta: normalizedIncoming.slice(normalizedCurrent.length),
      }
    }
    return {
      nextText: `${normalizedCurrent}${normalizedIncoming}`,
      delta: normalizedIncoming,
    }
  }

  if (normalizedIncoming === normalizedCurrent) {
    return {
      nextText: normalizedCurrent,
      delta: '',
    }
  }

  if (normalizedIncoming.startsWith(normalizedCurrent)) {
    return {
      nextText: normalizedIncoming,
      delta: normalizedIncoming.slice(normalizedCurrent.length),
    }
  }

  if (!normalizedCurrent) {
    return {
      nextText: normalizedIncoming,
      delta: normalizedIncoming,
    }
  }

  return {
    nextText: normalizedIncoming,
    delta: '',
  }
}

function buildGatewayChatSessionKey(agentId: string, transportSessionId: string): string {
  const normalizedAgentId = String(agentId || 'main').trim().toLowerCase() || 'main'
  const normalizedSessionId = String(transportSessionId || '').trim().toLowerCase()
  return `agent:${normalizedAgentId}:${normalizedSessionId}`
}

function toProcessEnvRecord(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

function mergeGatewayEnv(envFile: Record<string, string>): Record<string, string> {
  const baseEnv: Record<string, string | undefined> = {
    ...envFile,
    ...toProcessEnvRecord(),
  }
  const mergedEnv: Record<string, string | undefined> = {
    ...baseEnv,
    ...buildOpenClawLegacyEnvPatch(baseEnv),
  }
  const normalizedEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(mergedEnv)) {
    if (typeof value === 'string') {
      normalizedEnv[key] = value
    }
  }
  return normalizedEnv
}

function resolveGatewayUrl(config: Record<string, any> | null, env: Record<string, string>): string | null {
  const envUrl = resolveOpenClawEnvValue(env, 'OPENCLAW_GATEWAY_URL').value
  if (envUrl) return envUrl

  const gateway = normalizeRecord(config?.gateway)
  const remote = normalizeRecord(gateway?.remote)
  const mode = String(gateway?.mode || '').trim().toLowerCase()
  if (mode === 'remote') {
    return toOptionalString(remote?.url) || null
  }

  const port = Number(gateway?.port)
  const normalizedPort = Number.isFinite(port) && port > 0 ? Math.floor(port) : 18789
  const tlsEnabled = gateway?.tls && typeof gateway.tls === 'object' && (gateway.tls as Record<string, unknown>).enabled === true
  return `${tlsEnabled ? 'wss' : 'ws'}://127.0.0.1:${normalizedPort}`
}

function resolveGatewayToken(config: Record<string, any> | null, env: Record<string, string>): string | null {
  const configGateway = normalizeRecord(config?.gateway)
  const auth = normalizeRecord(configGateway?.auth)
  const explicitToken = typeof auth?.token === 'string' ? auth.token.trim() : ''
  if (explicitToken) return explicitToken

  const envToken = resolveOpenClawEnvValue(env, 'OPENCLAW_GATEWAY_TOKEN').value
  return envToken || null
}

async function resolveGatewayConnectionSettings(
  config: Record<string, any> | null,
  env: Record<string, string>,
  loadGatewayRuntime: typeof loadOpenClawGatewayRuntime
): Promise<GatewayConnectionSettings | null> {
  const mergedEnv = mergeGatewayEnv(env)
  try {
    const runtime = await loadGatewayRuntime()
    if (runtime) {
      const details = runtime.buildGatewayConnectionDetails({
        config,
      })
      const auth = await runtime.resolveGatewayConnectionAuth({
        config,
        env: mergedEnv as NodeJS.ProcessEnv,
      })
      const url = toOptionalString(details?.url)
      const token = toOptionalString(auth?.token)
      if (url && token) {
        return {
          url,
          token,
          password: toOptionalString(auth?.password),
          clientId: 'qclaw-ui',
          clientMode: 'ui',
          clientVersion: 'qclaw-lite',
        }
      }
    }
  } catch {
    // Fall back to Qclaw's lightweight resolver when OpenClaw internals are unavailable.
  }

  const url = resolveGatewayUrl(config, mergedEnv)
  const token = resolveGatewayToken(config, mergedEnv)
  if (!url || !token) return null

  return {
    url,
    token,
    clientId: 'qclaw-ui',
    clientMode: 'ui',
    clientVersion: 'qclaw-lite',
  }
}

function overrideGatewayConnectionSettings(
  settings: GatewayConnectionSettings,
  options: GatewayRpcCallOptions = {}
): GatewayConnectionSettings {
  return {
    ...settings,
    clientId: String(options.clientId || settings.clientId || 'qclaw-lite').trim() || 'qclaw-lite',
    clientMode: options.clientMode || settings.clientMode,
    clientVersion:
      String(options.clientVersion || settings.clientVersion || 'qclaw-lite').trim() || 'qclaw-lite',
  }
}

function isGatewayEventFrame(value: unknown): value is GatewayEventFrame {
  const record = normalizeRecord(value)
  return record?.type === 'event' && typeof record.event === 'string'
}

function isGatewayResponseFrame(value: unknown): value is GatewayResponseFrame {
  const record = normalizeRecord(value)
  return record?.type === 'res' && typeof record.id === 'string' && typeof record.ok === 'boolean'
}

function isGatewayChatEventPayload(value: unknown): value is GatewayChatEventPayload {
  const record = normalizeRecord(value)
  const state = String(record?.state || '').trim()
  return (
    typeof record?.runId === 'string' &&
    typeof record?.sessionKey === 'string' &&
    typeof record?.seq === 'number' &&
    (state === 'delta' || state === 'final' || state === 'aborted' || state === 'error')
  )
}

function parseGatewayChatMessage(message: unknown, state: GatewayChatEventPayload['state']): ParsedGatewayChatMessage {
  if (typeof message === 'string') {
    const normalized = sanitizeAssistantRawFallbackText(message)
    return {
      text: normalized || null,
      mode: state === 'delta' ? 'delta' : 'snapshot',
    }
  }

  const leaves = collectStringLeaves(message, '')
  const explicitDelta =
    selectPreferredLeaf(leaves, /\b(delta|textDelta|contentDelta|replyDelta)\b/i, CHAT_REPLY_REJECTED_PATH_PATTERN) || undefined
  const snapshotText = sanitizeAssistantVisibleText(selectBestReplyLeaf(leaves) || '') || undefined

  return {
    text: sanitizeAssistantVisibleText(explicitDelta || snapshotText || '') || null,
    mode: explicitDelta || state === 'delta' ? 'delta' : 'snapshot',
    model:
      findFirstStringField(message, ['model', 'modelName']) ||
      (message && typeof message === 'object'
        ? findFirstStringField((message as Record<string, unknown>).message, ['model', 'modelName'])
        : undefined),
    usage: parseUsageFromPayload(message),
  }
}

function toGatewayRequestFrame(id: string, method: string, params: unknown): string {
  return JSON.stringify({
    type: 'req',
    id,
    method,
    params,
  })
}

function getSocketOpenState(socket: WebSocket): number {
  const constructorOpen = (socket as { constructor?: { OPEN?: unknown } }).constructor?.OPEN
  return typeof constructorOpen === 'number' ? constructorOpen : 1
}

class MinimalGatewaySocketClient {
  private socket: WebSocket | null = null
  private connectRequestId: string | null = null
  private connectNonce: string | null = null
  private pending = new Map<string, PendingGatewayRequest>()
  private connectPromise: Promise<void> | null = null
  private cleanupConnectTimeout: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly settings: GatewayConnectionSettings,
    private readonly createSocket: (url: string) => WebSocket,
    private readonly onEvent: (frame: GatewayEventFrame) => void
  ) {}

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise

    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        if (this.cleanupConnectTimeout) {
          clearTimeout(this.cleanupConnectTimeout)
          this.cleanupConnectTimeout = null
        }
        if (error) reject(error instanceof Error ? error : new Error(String(error)))
        else resolve()
      }

      const socket = this.createSocket(this.settings.url)
      this.socket = socket

      this.cleanupConnectTimeout = setTimeout(() => {
        finish(new Error('gateway connect challenge timeout'))
        this.close()
      }, GATEWAY_CONNECT_TIMEOUT_MS)

      socket.addEventListener('message', (event) => {
        this.handleIncomingMessage(String(event.data || ''), finish)
      })
      socket.addEventListener('error', () => {
        finish(new Error('gateway websocket error'))
      })
      socket.addEventListener('close', () => {
        if (!settled) {
          finish(new Error('gateway websocket closed before connect finished'))
        }
        this.rejectAllPending(new Error('gateway websocket closed'))
      })
    })

    return this.connectPromise
  }

  async request(method: string, params: unknown, timeoutMs = GATEWAY_REQUEST_TIMEOUT_MS): Promise<unknown> {
    await this.connect()
    const socket = this.socket
    if (!socket || socket.readyState !== getSocketOpenState(socket)) {
      throw new Error('gateway not connected')
    }

    const id = randomUUID()
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeoutId =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new Error(`gateway request timeout for ${method}`))
            }, timeoutMs)
          : null

      this.pending.set(id, {
        resolve,
        reject,
        timeoutId,
      })
    })

    socket.send(toGatewayRequestFrame(id, method, params))
    return promise
  }

  close(): void {
    const socket = this.socket
    this.socket = null
    if (this.cleanupConnectTimeout) {
      clearTimeout(this.cleanupConnectTimeout)
      this.cleanupConnectTimeout = null
    }
    if (socket && socket.readyState === getSocketOpenState(socket)) {
      socket.close()
    }
    this.rejectAllPending(new Error('gateway client closed'))
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      if (pending.timeoutId) clearTimeout(pending.timeoutId)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private handleIncomingMessage(raw: string, finishConnect: (error?: unknown) => void): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }

    if (isGatewayEventFrame(parsed)) {
      if (parsed.event === 'connect.challenge') {
        const payload = normalizeRecord(parsed.payload)
        const nonce = typeof payload?.nonce === 'string' ? payload.nonce.trim() : ''
        if (!nonce) {
          finishConnect(new Error('gateway connect challenge missing nonce'))
          this.close()
          return
        }
        this.connectNonce = nonce
        this.sendConnect()
        return
      }

      this.onEvent(parsed)
      return
    }

    if (!isGatewayResponseFrame(parsed)) return

    if (this.connectRequestId && parsed.id === this.connectRequestId) {
      this.connectRequestId = null
      if (!parsed.ok) {
        finishConnect(new Error(parsed.error?.message || 'gateway connect failed'))
        this.close()
        return
      }
      finishConnect()
      return
    }

    const pending = this.pending.get(parsed.id)
    if (!pending) return

    this.pending.delete(parsed.id)
    if (pending.timeoutId) clearTimeout(pending.timeoutId)
    if (parsed.ok) pending.resolve(parsed.payload)
    else pending.reject(new Error(parsed.error?.message || 'gateway request failed'))
  }

  private sendConnect(): void {
    const socket = this.socket
    if (!socket || socket.readyState !== getSocketOpenState(socket)) {
      throw new Error('gateway socket is not open')
    }

    if (!String(this.connectNonce || '').trim()) throw new Error('gateway connect challenge missing nonce')

    const connectId = randomUUID()
    this.connectRequestId = connectId
    socket.send(
      toGatewayRequestFrame(connectId, 'connect', {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: this.settings.clientId,
          displayName: 'Qclaw',
          version: this.settings.clientVersion,
          platform: process.platform,
          mode: this.settings.clientMode,
        },
        role: 'operator',
        scopes: ['operator.admin', 'operator.read', 'operator.write'],
        auth: {
          token: this.settings.token,
          ...(this.settings.password ? { password: this.settings.password } : {}),
        },
        device: undefined,
      })
    )
  }
}

async function runFallbackTransport(
  fallbackTransport: ChatTransport | undefined,
  input: ChatTransportRunParams,
  error?: unknown
): Promise<ChatTransportRunResult> {
  const explicitSessionKey = typeof input.sessionKey === 'string' ? input.sessionKey.trim() : ''
  const derivedSessionKey = buildGatewayChatSessionKey('main', input.transportSessionId)
  if (explicitSessionKey && explicitSessionKey !== derivedSessionKey) {
    return {
      ok: false,
      stdout: '',
      stderr:
        'gateway transport unavailable and CLI fallback cannot safely continue an explicit external session key',
      code: 1,
      streamedText: '',
    }
  }

  if (fallbackTransport) {
    return fallbackTransport.run(input)
  }

  return {
    ok: false,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error || 'gateway transport unavailable'),
    code: 1,
    streamedText: '',
  }
}

export function createGatewayStreamingChatTransport(
  deps: GatewayChatTransportDependencies
): ChatTransport {
  const readConfig = deps.readConfig
  const readEnvFile = deps.readEnvFile
  const fallbackTransport = deps.fallbackTransport
  const createSocket = deps.createSocket || ((url) => new WebSocket(url))
  const loadGatewayRuntime = deps.loadGatewayRuntime || loadOpenClawGatewayRuntime

  return {
    async run(input: ChatTransportRunParams): Promise<ChatTransportRunResult> {
      assertNoSendTimeModelOverride(input, 'Gateway 聊天 transport')
      const [config, envFile] = await Promise.all([readConfig(), readEnvFile()])
      const settings = await resolveGatewayConnectionSettings(config, envFile, loadGatewayRuntime)
      if (!settings) {
        return runFallbackTransport(fallbackTransport, input, new Error('gateway streaming config unavailable'))
      }

      const sessionKey =
        (typeof input.sessionKey === 'string' ? input.sessionKey.trim() : '') ||
        buildGatewayChatSessionKey('main', input.transportSessionId)
      const idempotencyKey = randomUUID()
      let activeClient: MinimalGatewaySocketClient | undefined

      let streamedText = ''
      let streamedModel: string | undefined
      let streamedUsage: ChatUsage | undefined
      let finalPayload: GatewayChatEventPayload | null = null
      let terminalState: GatewayChatEventPayload['state'] | null = null
      let runId = ''
      let accepted = false
      let hasGatewayStreamActivity = false
      const abortSignal = input.signal

      const completion = new Promise<GatewayChatEventPayload>((resolve, reject) => {
        let settled = false
        const timeoutId = setTimeout(() => {
          if (settled) return
          settled = true
          reject(new Error('gateway streaming timeout'))
        }, GATEWAY_STREAM_TIMEOUT_MS)
        const finalizeResolve = (payload: GatewayChatEventPayload) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutId)
          resolve(payload)
        }
        const finalizeReject = (error: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutId)
          reject(error)
        }
        const abortGatewayRun = () => {
          terminalState = 'aborted'
          hasGatewayStreamActivity = true
          const abortError = new Error('chat aborted')
          const client = activeClient
          if (!client) {
            finalizeReject(abortError)
            return
          }

          void client
            .request(
              'chat.abort',
              {
                sessionKey,
                ...(runId ? { runId } : {}),
              },
              2_000
            )
            .catch(() => {})
            .finally(() => {
              finalizeReject(abortError)
              client.close()
            })
        }

        if (abortSignal?.aborted) {
          abortGatewayRun()
          return
        }

        const handleAbort = () => {
          abortGatewayRun()
        }
        abortSignal?.addEventListener('abort', handleAbort, { once: true })

        activeClient = new MinimalGatewaySocketClient(settings, createSocket, (frame) => {
          const payload = frame.payload
          if (!isGatewayChatEventPayload(payload)) return
          if (payload.sessionKey !== sessionKey) return
          if (runId && payload.runId !== runId) return

          hasGatewayStreamActivity = true
          if (!runId) runId = payload.runId

          const parsedMessage = parseGatewayChatMessage(payload.message, payload.state)
          streamedModel = parsedMessage.model || streamedModel
          streamedUsage = parseUsageFromPayload(payload.usage) || parsedMessage.usage || streamedUsage

          if (parsedMessage.text) {
            const update = applyStreamTextUpdate(streamedText, parsedMessage.text, parsedMessage.mode)
            streamedText = update.nextText
            if (update.delta) {
              input.onAssistantDelta?.({
                text: streamedText,
                delta: update.delta,
                model: streamedModel,
                usage: streamedUsage,
              })
            }
          }

          if (payload.state === 'final') {
            finalPayload = payload
            terminalState = payload.state
            finalizeResolve(payload)
            activeClient?.close()
            return
          }

          if (payload.state === 'error' || payload.state === 'aborted') {
            finalPayload = payload
            terminalState = payload.state
            finalizeReject(new Error(payload.errorMessage || payload.stopReason || payload.state))
            activeClient?.close()
          }
        })

        activeClient
          .connect()
          .then(async () => {
            const response = (await activeClient?.request('chat.send', {
              sessionKey,
              message: input.messageText,
              thinking: input.thinking,
              deliver: false,
              timeoutMs: GATEWAY_STREAM_TIMEOUT_MS,
              idempotencyKey,
            })) as Record<string, unknown> | null

            accepted = true
            runId = String(response?.runId || runId || idempotencyKey).trim()
          })
          .catch((error) => {
            finalizeReject(error instanceof Error ? error : new Error(String(error)))
            activeClient?.close()
          })
      })

      try {
        const resolvedPayload = await completion
        const finalMessage = parseGatewayChatMessage(resolvedPayload.message, resolvedPayload.state)
        const finalText = String(finalMessage.text || streamedText || '').trim()
        return {
          ok: true,
          stdout: JSON.stringify({
            runId,
            sessionKey,
            response: {
              text: finalText,
            },
            model: streamedModel,
            usage: streamedUsage,
          }),
          stderr: '',
          code: 0,
          streamedText: finalText,
          streamedModel,
          streamedUsage,
        }
      } catch (error) {
        const canceledBySignal = terminalState === 'aborted' || abortSignal?.aborted === true
        const shouldFallback = !canceledBySignal && !accepted && !hasGatewayStreamActivity
        if (shouldFallback) {
          return runFallbackTransport(fallbackTransport, input, error)
        }

        return {
          ok: false,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          code: 1,
          streamedText,
          streamedModel,
          streamedUsage,
          canceled: canceledBySignal,
        }
      } finally {
        activeClient?.close()
      }
    },
  }
}

export async function callGatewayRpcViaSocket(
  deps: GatewayChatTransportDependencies,
  method: string,
  params: unknown,
  options: GatewayRpcCallOptions = {}
): Promise<unknown> {
  const readConfig = deps.readConfig
  const readEnvFile = deps.readEnvFile
  const createSocket = deps.createSocket || ((url) => new WebSocket(url))
  const loadGatewayRuntime = deps.loadGatewayRuntime || loadOpenClawGatewayRuntime
  const [config, envFile] = await Promise.all([readConfig(), readEnvFile()])
  const settings = await resolveGatewayConnectionSettings(config, envFile, loadGatewayRuntime)
  if (!settings) {
    throw new Error('gateway streaming config unavailable')
  }

  const client = new MinimalGatewaySocketClient(
    overrideGatewayConnectionSettings(settings, {
      clientId: options.clientId || 'qclaw-ui',
      clientMode: options.clientMode || 'ui',
      clientVersion: options.clientVersion || 'qclaw-lite',
    }),
    createSocket,
    () => {}
  )

  try {
    await client.connect()
    return await client.request(method, params, options.timeoutMs)
  } finally {
    client.close()
  }
}
