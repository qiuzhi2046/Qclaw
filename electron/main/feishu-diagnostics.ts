import type {
  FeishuBotDiagnosticListenRequest,
  FeishuBotDiagnosticListenResult,
  FeishuBotDiagnosticSendRequest,
  FeishuBotDiagnosticSendResult,
} from '../../src/shared/feishu-diagnostics'
import type {
  FeishuCredentials,
  FeishuDiagnosticActivitySnapshot,
  JsonRequestResult,
} from './feishu-diagnostics-core'
import {
  buildFeishuDiagnosticMessageText,
  DEFAULT_ACCOUNT_ID,
  listenForFeishuBotDiagnosticActivity as listenForFeishuBotDiagnosticActivityCore,
  normalizeAccountId,
  resolveFeishuOpenBase,
  sanitizeStoreKey,
  sendFeishuDiagnosticMessage as sendFeishuDiagnosticMessageCore,
} from './feishu-diagnostics-core'
import { resolveOpenClawPathsForRead } from './openclaw-runtime-readonly'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const https = process.getBuiltinModule('node:https') as typeof import('node:https')
const { randomUUID } = process.getBuiltinModule('node:crypto') as typeof import('node:crypto')

const MAX_SCAN_ENTRIES = 4_000
const activeListenRequests = new Map<string, { canceled: boolean; listeners: Set<() => void> }>()

async function loadCliModule(): Promise<typeof import('./cli')> {
  return import('./cli')
}

async function requestJson(
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<JsonRequestResult> {
  return new Promise((resolve) => {
    try {
      const target = new URL(url)
      const req = https.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname}${target.search}`,
          method,
          headers,
          timeout: 15_000,
        },
        (res) => {
          let raw = ''
          res.on('data', (chunk) => {
            raw += chunk.toString()
          })
          res.on('end', () => {
            try {
              resolve({
                ok: (res.statusCode || 500) >= 200 && (res.statusCode || 500) < 300,
                status: res.statusCode || 500,
                data: raw ? JSON.parse(raw) : {},
              })
            } catch {
              resolve({
                ok: false,
                status: res.statusCode || 500,
                data: {},
              })
            }
          })
        }
      )
      req.on('error', () => resolve({ ok: false, status: 500, data: {} }))
      req.on('timeout', () => {
        req.destroy()
        resolve({ ok: false, status: 408, data: {} })
      })
      if (body) req.write(body)
      req.end()
    } catch {
      resolve({ ok: false, status: 500, data: {} })
    }
  })
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isConfigSecretRefLike(
  value: unknown
): value is { source: 'env' | 'file'; provider: string; id: string } {
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

async function resolveFeishuAccountCredentials(accountId: string): Promise<FeishuCredentials | null> {
  const { readConfig, resolveConfigSecretValue } = await loadCliModule()
  const config = await readConfig()
  const feishu = (config?.channels?.feishu || {}) as Record<string, any>
  if (!feishu || typeof feishu !== 'object') return null

  const normalizedAccountId = normalizeAccountId(accountId)
  const accountOverride =
    normalizedAccountId === DEFAULT_ACCOUNT_ID
      ? undefined
      : (feishu.accounts?.[normalizedAccountId] as Record<string, any> | undefined)
  const merged = accountOverride ? { ...feishu, ...accountOverride } : feishu

  const appId = normalizeText(merged.appId)
  const appSecret = isConfigSecretRefLike(merged.appSecret)
    ? await resolveConfigSecretValue(merged.appSecret)
    : normalizeText(merged.appSecret)
  if (!appId || !appSecret) return null

  return {
    appId,
    appSecret,
    baseUrl: resolveFeishuOpenBase(merged.domain),
  }
}

async function safeStat(targetPath: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.promises.stat(targetPath)
  } catch {
    return null
  }
}

async function snapshotPathTree(rootPath: string): Promise<{ exists: boolean; latestMtimeMs: number; latestPath?: string }> {
  const rootStat = await safeStat(rootPath)
  if (!rootStat) {
    return { exists: false, latestMtimeMs: 0 }
  }

  let latestMtimeMs = Number(rootStat.mtimeMs || 0)
  let latestPath = rootPath
  const queue = [rootPath]
  let scannedEntries = 0

  while (queue.length > 0 && scannedEntries < MAX_SCAN_ENTRIES) {
    const currentPath = queue.shift()
    if (!currentPath) continue

    let entries: import('node:fs').Dirent[] = []
    try {
      entries = await fs.promises.readdir(currentPath, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      scannedEntries += 1
      const childPath = path.join(currentPath, entry.name)
      const stat = await safeStat(childPath)
      if (stat && Number(stat.mtimeMs || 0) >= latestMtimeMs) {
        latestMtimeMs = Number(stat.mtimeMs || 0)
        latestPath = childPath
      }
      if (entry.isDirectory()) {
        queue.push(childPath)
      }
      if (scannedEntries >= MAX_SCAN_ENTRIES) break
    }
  }

  return {
    exists: true,
    latestMtimeMs,
    latestPath,
  }
}

async function snapshotPairingStore(paths: string[]): Promise<{ exists: boolean; latestMtimeMs: number; latestPath?: string }> {
  let exists = false
  let latestMtimeMs = 0
  let latestPath = ''

  for (const targetPath of paths) {
    const stat = await safeStat(targetPath)
    if (!stat) continue
    exists = true
    if (Number(stat.mtimeMs || 0) >= latestMtimeMs) {
      latestMtimeMs = Number(stat.mtimeMs || 0)
      latestPath = targetPath
    }
  }

  return {
    exists,
    latestMtimeMs,
    latestPath: latestPath || undefined,
  }
}

async function buildDefaultActivitySnapshot(accountId: string): Promise<FeishuDiagnosticActivitySnapshot> {
  const normalizedAccountId = normalizeAccountId(accountId)
  const openClawPaths = await resolveOpenClawPathsForRead()
  const openClawHome = String(openClawPaths.homeDir || '').trim() || path.join(os.homedir(), '.openclaw')
  const credentialsDir = String(openClawPaths.credentialsDir || '').trim() || path.join(openClawHome, 'credentials')
  const safeAccountId = normalizedAccountId === DEFAULT_ACCOUNT_ID ? DEFAULT_ACCOUNT_ID : sanitizeStoreKey(normalizedAccountId)
  const workspacePath = path.join(openClawHome, `workspace-feishu-${safeAccountId}`)
  const scopedAllowFromPath = path.join(credentialsDir, `feishu-${safeAccountId}-allowFrom.json`)
  const allowFromPaths =
    safeAccountId === DEFAULT_ACCOUNT_ID
      ? [scopedAllowFromPath, path.join(credentialsDir, 'feishu-allowFrom.json')]
      : [scopedAllowFromPath]

  const [workspaceSource, pairingStoreSource] = await Promise.all([
    snapshotPathTree(workspacePath),
    snapshotPairingStore(allowFromPaths),
  ])

  return {
    sources: [
      {
        kind: 'workspace',
        ...workspaceSource,
      },
      {
        kind: 'pairing-store',
        ...pairingStoreSource,
      },
    ],
  }
}

function createListenRequestControl(requestId: string): { canceled: boolean; listeners: Set<() => void> } {
  const existing = activeListenRequests.get(requestId)
  if (existing) {
    existing.canceled = true
    for (const listener of existing.listeners) {
      listener()
    }
  }

  const next = {
    canceled: false,
    listeners: new Set<() => void>(),
  }
  activeListenRequests.set(requestId, next)
  return next
}

function waitForListenPoll(ms: number, control?: { canceled: boolean; listeners: Set<() => void> }): Promise<void> {
  if (!control) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  return new Promise((resolve) => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      control.listeners.delete(finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    control.listeners.add(finish)
    if (control.canceled) {
      finish()
    }
  })
}

export { buildFeishuDiagnosticMessageText }

export async function listenForFeishuBotDiagnosticActivity(
  request: FeishuBotDiagnosticListenRequest
): Promise<FeishuBotDiagnosticListenResult> {
  const requestId = normalizeText(request.requestId)
  const control = requestId ? createListenRequestControl(requestId) : undefined

  try {
    return await listenForFeishuBotDiagnosticActivityCore(request, {
      takeSnapshot: buildDefaultActivitySnapshot,
      wait: (ms) => waitForListenPoll(ms, control),
      isCanceled: () => control?.canceled === true,
    })
  } finally {
    if (requestId && activeListenRequests.get(requestId) === control) {
      activeListenRequests.delete(requestId)
    }
  }
}

export async function cancelFeishuBotDiagnosticListen(requestId: string): Promise<{ ok: boolean }> {
  const normalizedRequestId = normalizeText(requestId)
  if (!normalizedRequestId) {
    return { ok: false }
  }

  const control = activeListenRequests.get(normalizedRequestId)
  if (!control) {
    return { ok: false }
  }

  control.canceled = true
  for (const listener of control.listeners) {
    listener()
  }
  return { ok: true }
}

export async function sendFeishuDiagnosticMessage(
  request: FeishuBotDiagnosticSendRequest
): Promise<FeishuBotDiagnosticSendResult> {
  return sendFeishuDiagnosticMessageCore(request, {
    nowIso: () => new Date().toISOString(),
    createTraceId: () => randomUUID(),
    getMachineLabel: () => os.hostname() || 'unknown-machine',
    resolveCredentials: resolveFeishuAccountCredentials,
    requestJson,
  })
}
