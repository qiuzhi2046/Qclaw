import type {
  FeishuBotDiagnosticListenRequest,
  FeishuBotDiagnosticListenResult,
  FeishuBotDiagnosticSendRequest,
  FeishuBotDiagnosticSendResult,
  FeishuDiagnosticActivityKind,
  FeishuDiagnosticMessageTextInput,
} from '../../src/shared/feishu-diagnostics'

export const DEFAULT_ACCOUNT_ID = 'default'
export const DEFAULT_LISTEN_TIMEOUT_MS = 60_000
export const DEFAULT_POLL_INTERVAL_MS = 2_000

export interface JsonRequestResult {
  ok: boolean
  status: number
  data: any
}

export interface FeishuCredentials {
  appId: string
  appSecret: string
  baseUrl: string
}

export interface FeishuDiagnosticActivitySourceSnapshot {
  kind: Exclude<FeishuDiagnosticActivityKind, 'none'>
  exists: boolean
  latestMtimeMs: number
  latestPath?: string
}

export interface FeishuDiagnosticActivitySnapshot {
  sources: FeishuDiagnosticActivitySourceSnapshot[]
}

export interface FeishuBotDiagnosticListenDeps {
  now?: () => number
  wait?: (ms: number) => Promise<void>
  takeSnapshot?: (accountId: string) => Promise<FeishuDiagnosticActivitySnapshot>
  isCanceled?: () => boolean
}

export interface FeishuBotDiagnosticSendDeps {
  nowIso?: () => string
  createTraceId?: () => string
  getMachineLabel?: () => string
  resolveCredentials?: (accountId: string) => Promise<FeishuCredentials | null>
  requestJson?: (
    method: 'GET' | 'POST',
    url: string,
    headers?: Record<string, string>,
    body?: string
  ) => Promise<JsonRequestResult>
}

export function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeAccountId(accountId?: string): string {
  const normalized = String(accountId || '').trim()
  return normalized || DEFAULT_ACCOUNT_ID
}

export function sanitizeStoreKey(input: string): string {
  const safe = String(input || '').trim().toLowerCase().replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_')
  if (!safe || safe === '_') {
    throw new Error('Invalid channel/account identifier')
  }
  return safe
}

export function resolveFeishuOpenBase(domain?: string): string {
  const normalized = String(domain || 'feishu').trim().toLowerCase()
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    return normalized.replace(/\/+$/, '')
  }
  if (normalized === 'lark') return 'https://open.larksuite.com'
  return 'https://open.feishu.cn'
}

export function getManagedFeishuAgentId(accountId: string): string {
  return `feishu-${accountId === DEFAULT_ACCOUNT_ID ? DEFAULT_ACCOUNT_ID : sanitizeStoreKey(accountId)}`
}

export function getBotLabel(accountId: string, botLabel?: string): string {
  const normalized = normalizeText(botLabel)
  if (normalized) {
    if (accountId === DEFAULT_ACCOUNT_ID && /^默认\s*bot$/i.test(normalized)) return '默认机器人'
    const normalizedAccountId = normalizeText(accountId)
    if (normalizedAccountId && normalized.toLowerCase() === `bot ${normalizedAccountId}`.toLowerCase()) {
      return `机器人 ${normalizedAccountId}`
    }
    return normalized
  }
  return accountId === DEFAULT_ACCOUNT_ID ? '默认机器人' : `机器人 ${accountId}`
}

function safeGetManagedFeishuAgentId(accountId: string): string {
  try {
    return getManagedFeishuAgentId(accountId)
  } catch {
    return 'unknown-agent'
  }
}

export function buildFeishuDiagnosticMessageText(input: FeishuDiagnosticMessageTextInput): string {
  return [
    'Qclaw 故障排查定位消息',
    `机器人: ${input.botLabel}`,
    `accountId: ${input.accountId}`,
    `agentId: ${input.agentId}`,
    `机器: ${input.machineLabel}`,
    `时间: ${input.sentAt}`,
    `traceId: ${input.traceId}`,
    '如果你收到这条消息，说明当前这台机器可以主动通过这个机器人给你发消息。',
  ].join('\n')
}

function buildListenSuccessResult(params: {
  accountId: string
  activityKind: Exclude<FeishuDiagnosticActivityKind, 'none'>
  evidencePath?: string
  startedAt: string
  endedAt: string
  timeoutMs: number
  waitedMs: number
}): FeishuBotDiagnosticListenResult {
  return {
    ok: true,
    detected: true,
    accountId: params.accountId,
    activityKind: params.activityKind,
    summary:
      params.activityKind === 'pairing-store'
        ? '已在当前机器检测到新的配对授权痕迹。'
        : '已在当前机器检测到该机器人的本地活动。',
    evidencePath: params.evidencePath,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    timeoutMs: params.timeoutMs,
    waitedMs: params.waitedMs,
    code: 0,
  }
}

function buildListenTimeoutResult(params: {
  accountId: string
  startedAt: string
  endedAt: string
  timeoutMs: number
  waitedMs: number
}): FeishuBotDiagnosticListenResult {
  return {
    ok: true,
    detected: false,
    accountId: params.accountId,
    activityKind: 'none',
    summary: '监听窗口内未检测到当前机器上的机器人本地活动。',
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    timeoutMs: params.timeoutMs,
    waitedMs: params.waitedMs,
    code: 0,
  }
}

function buildListenCanceledResult(params: {
  accountId: string
  startedAt: string
  endedAt: string
  timeoutMs: number
  waitedMs: number
}): FeishuBotDiagnosticListenResult {
  return {
    ok: true,
    detected: false,
    canceled: true,
    accountId: params.accountId,
    activityKind: 'none',
    summary: '已取消监听当前机器人活动。',
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    timeoutMs: params.timeoutMs,
    waitedMs: params.waitedMs,
    code: null,
  }
}

function findAdvancedSource(
  baseline: FeishuDiagnosticActivitySnapshot,
  current: FeishuDiagnosticActivitySnapshot
): FeishuDiagnosticActivitySourceSnapshot | null {
  for (const source of current.sources) {
    const previous = baseline.sources.find((item) => item.kind === source.kind)
    if (!previous) {
      if (source.exists || source.latestMtimeMs > 0) return source
      continue
    }

    if (source.exists && !previous.exists) return source
    if (source.latestMtimeMs > previous.latestMtimeMs) return source
  }

  return null
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getAppAccessToken(
  accountId: string,
  deps: Required<Pick<FeishuBotDiagnosticSendDeps, 'resolveCredentials' | 'requestJson'>>
): Promise<{ ok: boolean; token?: string; baseUrl?: string; code: number | null; message?: string }> {
  const credentials = await deps.resolveCredentials(accountId)
  if (!credentials) {
    return {
      ok: false,
      code: 1,
      message: '当前机器人缺少完整的飞书 App ID / App Secret。',
    }
  }

  const tokenResp = await deps.requestJson(
    'POST',
    `${credentials.baseUrl}/open-apis/auth/v3/app_access_token/internal`,
    { 'Content-Type': 'application/json' },
    JSON.stringify({
      app_id: credentials.appId,
      app_secret: credentials.appSecret,
    })
  )

  const token = String(tokenResp.data?.app_access_token || '').trim()
  const feishuCode = Number(tokenResp.data?.code ?? (tokenResp.ok ? 0 : tokenResp.status || 1))
  const feishuMessage = String(tokenResp.data?.msg || tokenResp.data?.message || '').trim()

  if (tokenResp.ok && feishuCode === 0 && token) {
    return {
      ok: true,
      token,
      baseUrl: credentials.baseUrl,
      code: 0,
    }
  }

  return {
    ok: false,
    code: tokenResp.status || feishuCode || 1,
    message: feishuMessage || '无法获取飞书访问令牌，请稍后重试。',
  }
}

export async function listenForFeishuBotDiagnosticActivity(
  request: FeishuBotDiagnosticListenRequest,
  deps: FeishuBotDiagnosticListenDeps = {}
): Promise<FeishuBotDiagnosticListenResult> {
  const now = deps.now || Date.now
  const takeSnapshot = deps.takeSnapshot || (async () => ({ sources: [] }))
  const sleep = deps.wait || wait
  const isCanceled = deps.isCanceled || (() => false)
  const accountId = normalizeAccountId(request.accountId)
  const timeoutMs = Math.max(5_000, Number(request.timeoutMs || DEFAULT_LISTEN_TIMEOUT_MS))
  const pollIntervalMs = Math.max(500, Number(request.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS))

  try {
    const startedAtMs = now()
    const startedAt = new Date(startedAtMs).toISOString()
    if (isCanceled()) {
      return buildListenCanceledResult({
        accountId,
        startedAt,
        endedAt: startedAt,
        timeoutMs,
        waitedMs: 0,
      })
    }
    const baseline = await takeSnapshot(accountId)
    if (isCanceled()) {
      const endedAtMs = now()
      return buildListenCanceledResult({
        accountId,
        startedAt,
        endedAt: new Date(endedAtMs).toISOString(),
        timeoutMs,
        waitedMs: endedAtMs - startedAtMs,
      })
    }

    let loopNowMs = startedAtMs
    while (true) {
      loopNowMs = now()
      if (isCanceled()) {
        return buildListenCanceledResult({
          accountId,
          startedAt,
          endedAt: new Date(loopNowMs).toISOString(),
          timeoutMs,
          waitedMs: loopNowMs - startedAtMs,
        })
      }
      if (loopNowMs - startedAtMs >= timeoutMs) {
        return buildListenTimeoutResult({
          accountId,
          startedAt,
          endedAt: new Date(loopNowMs).toISOString(),
          timeoutMs,
          waitedMs: loopNowMs - startedAtMs,
        })
      }

      await sleep(pollIntervalMs)
      loopNowMs = now()
      if (isCanceled()) {
        return buildListenCanceledResult({
          accountId,
          startedAt,
          endedAt: new Date(loopNowMs).toISOString(),
          timeoutMs,
          waitedMs: loopNowMs - startedAtMs,
        })
      }
      const current = await takeSnapshot(accountId)
      const advanced = findAdvancedSource(baseline, current)
      if (advanced) {
        const endedAtMs = now()
        return buildListenSuccessResult({
          accountId,
          activityKind: advanced.kind,
          evidencePath: advanced.latestPath,
          startedAt,
          endedAt: new Date(endedAtMs).toISOString(),
          timeoutMs,
          waitedMs: endedAtMs - startedAtMs,
        })
      }
    }
  } catch (error) {
    const endedAtMs = now()
    return {
      ok: false,
      detected: false,
      accountId,
      activityKind: 'none',
      summary: '监听当前机器人活动失败，请稍后重试。',
      startedAt: new Date(endedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      timeoutMs,
      waitedMs: 0,
      code: 1,
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function sendFeishuDiagnosticMessage(
  request: FeishuBotDiagnosticSendRequest,
  deps: FeishuBotDiagnosticSendDeps = {}
): Promise<FeishuBotDiagnosticSendResult> {
  const nowIso = deps.nowIso || (() => new Date().toISOString())
  const createTraceId = deps.createTraceId || (() => 'trace-unavailable')
  const getMachineLabel = deps.getMachineLabel || (() => 'unknown-machine')
  const resolveCredentials = deps.resolveCredentials || (async () => null)
  const doRequestJson = deps.requestJson || (async () => ({ ok: false, status: 500, data: {} }))

  const accountId = normalizeAccountId(request.accountId)
  const openId = String(request.openId || '').trim()
  const botLabel = getBotLabel(accountId, request.botLabel)
  const agentId = safeGetManagedFeishuAgentId(accountId)
  let machineLabel = 'unknown-machine'
  let sentAt = new Date().toISOString()
  let traceId = 'trace-unavailable'

  try {
    machineLabel = normalizeText(getMachineLabel()) || machineLabel
  } catch {
    machineLabel = 'unknown-machine'
  }
  try {
    sentAt = normalizeText(nowIso()) || sentAt
  } catch {
    sentAt = new Date().toISOString()
  }
  try {
    traceId = normalizeText(createTraceId()) || traceId
  } catch {
    traceId = 'trace-unavailable'
  }

  const baseResult = {
    accountId,
    openId,
    recipientName: normalizeText(request.recipientName) || undefined,
    botLabel,
    agentId,
    machineLabel,
    traceId,
    sentAt,
    sentText: '',
    messageId: undefined,
    stderr: undefined,
  } satisfies Omit<FeishuBotDiagnosticSendResult, 'ok' | 'summary' | 'code'>

  if (!openId) {
    return {
      ...baseResult,
      ok: false,
      summary: '请选择一个已配对的飞书用户。',
      code: 1,
      stderr: 'missing_open_id',
    }
  }

  let sentText = baseResult.sentText

  try {
    sentText = buildFeishuDiagnosticMessageText({
      botLabel,
      accountId,
      agentId,
      machineLabel,
      traceId,
      sentAt,
    })

    const enrichedBaseResult = {
      ...baseResult,
      sentText,
    }

    const tokenResult = await getAppAccessToken(accountId, {
      resolveCredentials,
      requestJson: doRequestJson,
    })
    if (!tokenResult.ok || !tokenResult.token || !tokenResult.baseUrl) {
      return {
        ...enrichedBaseResult,
        ok: false,
        summary: tokenResult.message || '获取飞书访问令牌失败。',
        code: tokenResult.code,
        stderr: tokenResult.message,
      }
    }

    const sendResp = await doRequestJson(
      'POST',
      `${tokenResult.baseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`,
      {
        Authorization: `Bearer ${tokenResult.token}`,
        'Content-Type': 'application/json',
      },
      JSON.stringify({
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text: sentText }),
      })
    )

    const feishuCode = Number(sendResp.data?.code ?? (sendResp.ok ? 0 : sendResp.status || 1))
    const feishuMessage = String(sendResp.data?.msg || sendResp.data?.message || '').trim()
    const messageId = normalizeText(sendResp.data?.data?.message_id)

    if (sendResp.ok && feishuCode === 0 && messageId) {
      return {
        ...enrichedBaseResult,
        ok: true,
        summary: `定位消息已发送给 ${normalizeText(request.recipientName) || openId}。`,
        messageId,
        code: 0,
      }
    }

    return {
      ...enrichedBaseResult,
      ok: false,
      summary: feishuMessage || '发送定位消息失败，请稍后重试。',
      code: sendResp.status || feishuCode || 1,
      stderr: feishuMessage || 'send_failed',
    }
  } catch (error) {
    return {
      ...baseResult,
      sentText,
      ok: false,
      summary: '发送定位消息失败，请稍后重试。',
      code: 1,
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}
