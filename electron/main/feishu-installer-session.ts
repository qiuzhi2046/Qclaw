import type { ChildProcess } from 'node:child_process'
import type { Server, Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type {
  FeishuInstallerPendingPrompt,
  FeishuInstallerPromptResolution,
} from '../../src/shared/feishu-installer-session'
import {
  createIdleChannelInstallerGuardrailStatus,
  failChannelInstallerGuardrailStatus,
  mergeChannelInstallerGuardrailStatus,
  type ChannelInstallerGuardrailStatus,
  type ChannelInstallerGatewayRecoveryStatus,
} from '../../src/shared/channel-installer-session'
import {
  cancelActiveProcess,
  clearActiveProcessIfMatch,
  consumeCanceledProcess,
  setActiveProcess,
} from './command-control'
import { buildFeishuInstallerPromptHookScript } from './feishu-installer-prompt-hook'
import { probePlatformCommandCapability } from './command-capabilities'
import { ensureFeishuOfficialPluginReady } from './feishu-official-plugin-state'
import { buildInstallerCommandEnv } from './installer-command-env'
import { FEISHU_OFFICIAL_PLUGIN_ID } from './feishu-installer-config'
import type {
  GatewayInstallerStopSnapshot,
  GatewayRecoveryResult,
} from './gateway-lifecycle-controller'
import {
  recoverGatewayForInstaller,
  stopGatewayForInstaller,
} from './gateway-lifecycle-controller'
import {
  resolveOpenClawPathsForRead,
  resolveWindowsActiveRuntimeSnapshotForRead,
} from './openclaw-runtime-readonly'
import { resolveSafeWorkingDirectory } from './runtime-working-directory'
import { cleanupIsolatedNpmCacheEnv, createIsolatedNpmCacheEnv } from './npm-cache-env'
import {
  isManagedOperationLockBusy,
  tryAcquireManagedOperationLease,
  type ManagedOperationLease,
} from './managed-operation-lock'
import type { WindowsActiveRuntimeSnapshot } from './platforms/windows/windows-runtime-policy'
import { resolveWindowsChannelRuntimeContext } from './platforms/windows/windows-channel-runtime-context'

const childProcess = process.getBuiltinModule('node:child_process') as typeof import('node:child_process')
const net = process.getBuiltinModule('node:net') as typeof import('node:net')
const { spawn } = childProcess

const FEISHU_INSTALLER_CONTROL_DOMAIN = 'feishu-installer'
const FEISHU_MANAGED_CHANNEL_ID = 'feishu'
const FEISHU_INSTALLER_PACKAGE = '@larksuite/openclaw-lark-tools'
const FEISHU_OFFICIAL_PLUGIN_MANIFEST = 'openclaw.plugin.json'
const FEISHU_PROMPT_BRIDGE_HOST = '127.0.0.1'
const FEISHU_MANAGED_CHANNEL_LOCK_KEY = 'managed-channel-plugin:feishu'
const FEISHU_MANAGED_CHANNEL_BUSY_MESSAGE = '官方飞书插件正在执行安装、修复或配置同步，请稍后重试。'

interface FeishuPromptBridgePromptRequest {
  type: 'prompt'
  sessionToken: string
  promptId: string
  promptName: string
  promptType: string
  defaultValue?: boolean | null
  appId?: string
}

interface FeishuPromptBridgeAuthResultRequest {
  type: 'auth-result'
  sessionToken: string
  appId?: string
  openId?: string
  isExisting?: boolean
  domain?: string
}

type FeishuPromptBridgeRequest =
  | FeishuPromptBridgePromptRequest
  | FeishuPromptBridgeAuthResultRequest

interface FeishuPromptBridgeAnswer {
  type: 'prompt-answer'
  promptId: string
  answer: boolean
}

interface FeishuPromptBridgeAbort {
  type: 'prompt-abort'
  promptId: string
  message: string
}

type FeishuPromptBridgeMessage = FeishuPromptBridgeAnswer | FeishuPromptBridgeAbort

function resolveFeishuInstallerNpmCacheDir(): string {
  return path.join(app.getPath('userData'), 'npm-cache')
}

function resolveFeishuOfficialPluginManifestPath(homeDir: string): string {
  return path.join(homeDir, 'extensions', FEISHU_OFFICIAL_PLUGIN_ID, FEISHU_OFFICIAL_PLUGIN_MANIFEST)
}

function resolveFeishuInstallerPromptHookPath(): string {
  return path.join(app.getPath('userData'), 'runtime', 'feishu-installer-prompt-hook.cjs')
}

async function resolveFeishuInstallerDiagLogPath(): Promise<string> {
  const openClawPaths = await resolveOpenClawPathsForRead().catch(() => null)
  const homeDir = String(openClawPaths?.homeDir || '').trim()
  if (homeDir) {
    return path.join(homeDir, 'logs', 'qclaw-feishu-installer-diag.jsonl')
  }
  return path.join(app.getPath('userData'), 'logs', 'qclaw-feishu-installer-diag.jsonl')
}

function isFeishuInstallerDiagEnabled(): boolean {
  return String(process.env.QCLAW_FEISHU_DIAG || '').trim() === '1'
}

async function appendFeishuInstallerDiag(
  event: string,
  fields: Record<string, unknown> = {}
): Promise<void> {
  try {
    if (!isFeishuInstallerDiagEnabled()) return
    const logPath = await resolveFeishuInstallerDiagLogPath()
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true })
    const payload = {
      ts: new Date().toISOString(),
      pid: process.pid,
      source: 'qclaw-main',
      event: String(event || '').trim() || 'unknown',
      ...fields,
    }
    await fs.promises.appendFile(logPath, `${JSON.stringify(payload)}\n`, 'utf8')
  } catch {
    // Best effort only; diagnostics must never break installer flow.
  }
}
async function ensureFeishuInstallerPromptHookFile(): Promise<string> {
  const hookPath = resolveFeishuInstallerPromptHookPath()
  await fs.promises.mkdir(path.dirname(hookPath), { recursive: true })
  await fs.promises.writeFile(hookPath, buildFeishuInstallerPromptHookScript(), 'utf8')
  return hookPath
}

function quoteNodeOptionValue(value: string): string {
  return JSON.stringify(String(value || ''))
}

function appendNodeRequireOption(nodeOptions: string | undefined, requirePath: string): string {
  const segments = [String(nodeOptions || '').trim(), `--require=${quoteNodeOptionValue(requirePath)}`]
    .filter(Boolean)
  return segments.join(' ').trim()
}

function buildPromptBridgeMessageLine(message: FeishuPromptBridgeMessage): string {
  return `${JSON.stringify(message)}\n`
}

function sendPromptBridgeMessage(socket: Socket | null | undefined, message: FeishuPromptBridgeMessage) {
  if (!socket || socket.destroyed || !socket.writable) return
  socket.write(buildPromptBridgeMessageLine(message))
}

async function writePromptBridgeMessage(
  socket: Socket | null | undefined,
  message: FeishuPromptBridgeMessage
): Promise<boolean> {
  if (!socket || socket.destroyed || !socket.writable) return false

  return await new Promise((resolve) => {
    socket.write(buildPromptBridgeMessageLine(message), (error) => {
      resolve(!error)
    })
  })
}

function normalizePendingPrompt(input: Partial<FeishuInstallerPendingPrompt> & { promptId: string }): FeishuInstallerPendingPrompt {
  return {
    promptId: input.promptId,
    kind: 'useExisting',
    action: 'confirm-create-bot',
    promptType: 'confirm',
    appId: String(input.appId || '').trim() || undefined,
    defaultValue: typeof input.defaultValue === 'boolean' ? input.defaultValue : null,
  }
}

export async function isFeishuOfficialPluginInstalledOnDisk(): Promise<boolean> {
  const openClawPaths = await resolveOpenClawPathsForRead().catch(() => null)
  const homeDir = String(openClawPaths?.homeDir || '').trim()
  if (!homeDir) return false

  try {
    await fs.promises.access(resolveFeishuOfficialPluginManifestPath(homeDir))
    return true
  } catch {
    return false
  }
}

function resolveBundledFeishuInstallerPackage(): string | null {
  const envOverride = String(process.env.QCLAW_FEISHU_INSTALLER_TGZ || '').trim()
  if (envOverride && fs.existsSync(envOverride)) {
    return envOverride
  }

  return null
}

function buildFeishuInstallerCommand() {
  const bundledPackagePath = resolveBundledFeishuInstallerPackage()
  const packageSpecifier = bundledPackagePath || FEISHU_INSTALLER_PACKAGE
  const command = ['npx', '-y', packageSpecifier, 'install']
  return {
    command,
    bundledPackagePath,
    packageSpecifier,
  }
}

function buildExitedSnapshot(params: {
  code?: number | null
  command?: string[]
  guardrail?: ChannelInstallerGuardrailStatus
  output: string
  sessionId?: string | null
}): FeishuInstallerSessionSnapshot {
  return {
    active: false,
    sessionId: params.sessionId || randomUUID(),
    phase: 'exited',
    output: params.output,
    code: params.code ?? 1,
    ok: false,
    canceled: false,
    command: [...(params.command || buildFeishuInstallerCommand().command)],
    guardrail: params.guardrail || createIdleChannelInstallerGuardrailStatus(FEISHU_MANAGED_CHANNEL_ID),
    pendingPrompt: null,
    authResults: [],
  }
}

function buildManagedChannelBusySnapshot(): FeishuInstallerSessionSnapshot {
  return buildExitedSnapshot({
    code: 1,
    output: FEISHU_MANAGED_CHANNEL_BUSY_MESSAGE,
    guardrail: createFeishuInstallerGuardrail({
      preflight: {
        state: 'skipped',
        message: FEISHU_MANAGED_CHANNEL_BUSY_MESSAGE,
      },
      lock: {
        state: 'running',
        key: FEISHU_MANAGED_CHANNEL_LOCK_KEY,
        message: FEISHU_MANAGED_CHANNEL_BUSY_MESSAGE,
      },
    }),
  })
}

async function resolveFeishuInstallerRuntimeSnapshotPureFailure(): Promise<{
  message: string | null
  snapshot: WindowsActiveRuntimeSnapshot | null
}> {
  if (process.platform !== 'win32') {
    return {
      message: null,
      snapshot: null,
    }
  }

  const snapshot = await resolveWindowsActiveRuntimeSnapshotForRead({
    platform: process.platform,
  })
  if (!snapshot) {
    return {
      message: 'Windows OpenClaw 运行时尚未就绪，无法安全启动飞书官方安装器。',
      snapshot: null,
    }
  }

  if (
    !snapshot.stateDir
    || !snapshot.configPath
    || !snapshot.hostPackageRoot
    || !snapshot.nodePath
    || !snapshot.npmPrefix
    || !snapshot.openclawPath
  ) {
    return {
      message: 'Windows OpenClaw 运行时信息不完整，无法安全启动飞书官方安装器。',
      snapshot,
    }
  }

  return {
    message: null,
    snapshot,
  }
}

async function resolveFeishuInstallerPreflightRuntimeContext(
  activeRuntimeSnapshot?: WindowsActiveRuntimeSnapshot | null
): Promise<FeishuInstallerPreflightResult> {
  if (process.platform !== 'win32') {
    return {
      ok: true,
      guardrail: createFeishuInstallerGuardrail({
        preflight: { state: 'running' },
        runtime: {
          state: 'skipped',
          contextResolved: false,
          platform: process.platform,
          message: '非 Windows 平台无需 Windows runtime bridge 预检。',
        },
        bridge: {
          state: 'skipped',
          message: '非 Windows 平台无需 Windows runtime bridge 预检。',
        },
      }),
    }
  }

  const runtimeResult = await resolveWindowsChannelRuntimeContext({
    caller: 'channel-preflight',
    platform: process.platform,
    snapshot: activeRuntimeSnapshot,
  })
  if (!runtimeResult.ok) {
    const message = runtimeResult.message || 'Windows OpenClaw 运行时预检查失败，无法安全启动飞书官方安装器。'
    return {
      ok: false,
      code: 1,
      guardrail: failChannelInstallerGuardrailStatus({
        channelId: FEISHU_MANAGED_CHANNEL_ID,
        step: 'runtime',
        code: 'runtime-context-failed',
        message,
        patch: {
          runtime: {
            state: 'failed',
            contextResolved: false,
            platform: process.platform,
            code: 'runtime-context-failed',
            message,
          },
          bridge: {
            state: runtimeResult.bridge.ok ? 'ok' : 'failed',
            code: runtimeResult.bridge.ok ? undefined : 'runtime-context-failed',
            message: runtimeResult.bridge.message,
          },
        },
      }),
      output: message,
    }
  }

  return {
    ok: true,
    guardrail: createFeishuInstallerGuardrail({
      preflight: { state: 'running' },
      runtime: {
        state: 'ok',
        contextResolved: true,
        platform: process.platform,
      },
      bridge: {
        state: 'ok',
        message: runtimeResult.context.bridge.message,
      },
    }),
    runtimeContext: {
      configPath: runtimeResult.context.configPath,
      homeDir: runtimeResult.context.homeDir,
    },
  }
}

async function runFeishuInstallerPreflight(
  activeRuntimeSnapshot?: WindowsActiveRuntimeSnapshot | null
): Promise<FeishuInstallerPreflightResult> {
  await appendFeishuInstallerDiag('preflight-start')
  const runtimeContextResult = await resolveFeishuInstallerPreflightRuntimeContext(
    activeRuntimeSnapshot
  )
  if (!runtimeContextResult.ok) {
    await appendFeishuInstallerDiag('preflight-failed', {
      reason: 'runtime-context',
      message: runtimeContextResult.output,
    })
    return runtimeContextResult
  }

  const readyResult = await ensureFeishuOfficialPluginReady({
    runtimeContext: runtimeContextResult.runtimeContext,
  })
  if (!readyResult.ok) {
    const details = [readyResult.message, readyResult.stderr, readyResult.stdout]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join('\n\n')
    const output = details || '飞书官方插件预检查失败，已阻止启动安装器以避免旧插件或旧配置导致新建机器人失败。'
    await appendFeishuInstallerDiag('preflight-failed', {
      reason: 'official-plugin-ready',
      code: readyResult.code ?? 1,
      message: readyResult.message || null,
    })
    return {
      ok: false,
      code: readyResult.code ?? 1,
      guardrail: mergeChannelInstallerGuardrailStatus(runtimeContextResult.guardrail, {
        preflight: {
          state: 'failed',
          code: 'plugin-preflight-failed',
          message: output,
        },
        config: {
          state: 'failed',
          code: 'plugin-preflight-failed',
          message: output,
        },
        failure: {
          code: 'plugin-preflight-failed',
          message: output,
          step: 'config',
        },
      }),
      output,
    }
  }

  await appendFeishuInstallerDiag('preflight-ok', {
    installedThisRun: readyResult.installedThisRun,
  })
  return {
    ...runtimeContextResult,
    guardrail: mergeChannelInstallerGuardrailStatus(runtimeContextResult.guardrail, {
      preflight: { state: 'ok' },
      config: {
        state: 'ok',
        message: readyResult.message,
      },
    }),
  }
}

export interface FeishuInstallerSessionSnapshot {
  active: boolean
  sessionId: string | null
  phase: 'idle' | 'running' | 'exited'
  output: string
  code: number | null
  ok: boolean
  canceled: boolean
  command: string[]
  guardrail: ChannelInstallerGuardrailStatus
  pendingPrompt: FeishuInstallerPendingPrompt | null
  authResults: FeishuInstallerAuthResult[]
}

export interface FeishuInstallerSessionEvent {
  sessionId: string
  type: 'started' | 'output' | 'prompt' | 'exit'
  stream?: 'stdout' | 'stderr'
  chunk?: string
  phase?: FeishuInstallerSessionSnapshot['phase']
  code?: number | null
  ok?: boolean
  canceled?: boolean
  command?: string[]
  guardrail?: ChannelInstallerGuardrailStatus
  pendingPrompt?: FeishuInstallerPendingPrompt | null
}

interface ActiveFeishuInstallerSession {
  id: string
  process: ChildProcess
  phase: FeishuInstallerSessionSnapshot['phase']
  output: string
  code: number | null
  ok: boolean
  canceled: boolean
  command: string[]
  guardrail: ChannelInstallerGuardrailStatus
  npmCacheDir: string
  emit: (event: FeishuInstallerSessionEvent) => void
  pendingPrompt: FeishuInstallerPendingPrompt | null
  authResults: FeishuInstallerAuthResult[]
  pendingPromptSocket: Socket | null
  promptBridgeServer: Server | null
  promptSessionToken: string
  managedOperationLease: ManagedOperationLease
  gatewayRecoveryAttempted: boolean
  gatewayRecoveryResult: GatewayRecoveryResult | null
  gatewayStoppedForInstall: boolean
  gatewayStopSnapshot: GatewayInstallerStopSnapshot | null
}

type FeishuInstallerPreflightResult =
  | {
      ok: true
      guardrail: ChannelInstallerGuardrailStatus
      runtimeContext?: {
        configPath?: string
        homeDir?: string
      }
    }
  | {
      ok: false
      code?: number | null
      guardrail: ChannelInstallerGuardrailStatus
      output: string
}

let activeSession: ActiveFeishuInstallerSession | null = null

export interface FeishuInstallerAuthResult {
  appId: string
  openId: string
  isExisting?: boolean
  domain?: string
}

function hasRunningFeishuInstallerSession(): boolean {
  return activeSession?.phase === 'running'
}

function buildGatewayRecoveryTimeoutResult(): GatewayRecoveryResult {
  return {
    ok: false,
    recovered: false,
    skipped: false,
    message: '网关恢复超时，退出清理不会继续等待。',
  }
}

function createFeishuInstallerGuardrail(
  patch: Parameters<typeof mergeChannelInstallerGuardrailStatus>[1] = {}
): ChannelInstallerGuardrailStatus {
  return mergeChannelInstallerGuardrailStatus(
    createIdleChannelInstallerGuardrailStatus(FEISHU_MANAGED_CHANNEL_ID),
    patch
  )
}

function toInstallerGatewayRecoveryStatus(
  result: GatewayRecoveryResult
): ChannelInstallerGatewayRecoveryStatus {
  return {
    ok: result.ok,
    recovered: result.recovered,
    skipped: result.skipped,
    code: result.code ?? null,
    message: result.message,
  }
}

function formatGatewayRecoveryFailure(result: GatewayRecoveryResult): string {
  return [
    result.message,
    result.stderr,
    result.stdout,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('\n\n') || '安装器结束后网关恢复失败。'
}

function releaseSessionManagedOperationLease(session: ActiveFeishuInstallerSession): void {
  session.managedOperationLease.release()
}

async function runGatewayRecoveryWithTimeout(
  snapshot: GatewayInstallerStopSnapshot | null | undefined,
  reason: string,
  timeoutMs?: number
): Promise<GatewayRecoveryResult> {
  const recovery = recoverGatewayForInstaller(snapshot, reason)
  const normalizedTimeoutMs = Number(timeoutMs || 0)
  if (!Number.isFinite(normalizedTimeoutMs) || normalizedTimeoutMs <= 0) {
    return recovery
  }

  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(buildGatewayRecoveryTimeoutResult())
    }, normalizedTimeoutMs)
    recovery.then(
      (result) => {
        clearTimeout(timeout)
        resolve(result)
      },
      (error) => {
        clearTimeout(timeout)
        resolve({
          ok: false,
          recovered: false,
          skipped: false,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    )
  })
}

async function recoverGatewayForSession(
  session: ActiveFeishuInstallerSession,
  reason: string,
  options: { timeoutMs?: number } = {}
): Promise<GatewayRecoveryResult> {
  if (session.gatewayRecoveryAttempted) {
    return session.gatewayRecoveryResult || {
      ok: true,
      recovered: false,
      skipped: true,
      message: '本次安装器会话已请求过网关恢复。',
    }
  }

  session.gatewayRecoveryAttempted = true
  const result = await runGatewayRecoveryWithTimeout(
    session.gatewayStopSnapshot,
    reason,
    options.timeoutMs
  )
  session.gatewayRecoveryResult = result
  session.guardrail = mergeChannelInstallerGuardrailStatus(session.guardrail, {
    gateway: {
      recovery: toInstallerGatewayRecoveryStatus(result),
    },
    ...(result.ok
      ? {}
      : {
          failure: {
            code: 'gateway-recovery-failed' as const,
            message: formatGatewayRecoveryFailure(result),
            step: 'gateway-recovery' as const,
          },
        }),
  })
  if (!result.ok) {
    session.output += `\n${formatGatewayRecoveryFailure(result)}`
  }
  void appendFeishuInstallerDiag('gateway-recovery-finished', {
    sessionId: session.id,
    reason,
    ok: result.ok,
    recovered: result.recovered,
    skipped: result.skipped,
  })
  return result
}

function buildSnapshot(): FeishuInstallerSessionSnapshot {
  const commandResolution = buildFeishuInstallerCommand()
  if (!activeSession) {
    return {
      active: false,
      sessionId: null,
      phase: 'idle',
      output: '',
      code: null,
      ok: false,
      canceled: false,
      command: [...commandResolution.command],
      guardrail: createIdleChannelInstallerGuardrailStatus(FEISHU_MANAGED_CHANNEL_ID),
      pendingPrompt: null,
      authResults: [],
    }
  }

  return {
    active: activeSession.phase === 'running',
    sessionId: activeSession.id,
    phase: activeSession.phase,
    output: activeSession.output,
    code: activeSession.code,
    ok: activeSession.ok,
    canceled: activeSession.canceled,
    command: activeSession.command,
    guardrail: activeSession.guardrail,
    pendingPrompt: activeSession.pendingPrompt,
    authResults: [...activeSession.authResults],
  }
}

function emitFeishuInstallerEvent(
  emit: (event: FeishuInstallerSessionEvent) => void,
  event: FeishuInstallerSessionEvent
): void {
  try {
    emit(event)
  } catch (error) {
    void appendFeishuInstallerDiag('emit-failed', {
      sessionId: event.sessionId,
      type: event.type,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function emitPendingPrompt(session: ActiveFeishuInstallerSession, pendingPrompt: FeishuInstallerPendingPrompt | null) {
  emitFeishuInstallerEvent(session.emit, {
    sessionId: session.id,
    type: 'prompt',
    pendingPrompt,
  })
}

function appendOutput(stream: 'stdout' | 'stderr', chunk: string, emit: (event: FeishuInstallerSessionEvent) => void) {
  if (!activeSession) return
  activeSession.output += chunk
  emitFeishuInstallerEvent(emit, {
    sessionId: activeSession.id,
    type: 'output',
    stream,
    chunk,
  })
}

function closePromptBridgeServer(session: ActiveFeishuInstallerSession) {
  session.promptBridgeServer?.close()
  session.promptBridgeServer = null
}

function clearPendingPrompt(session: ActiveFeishuInstallerSession, options?: {
  notify?: boolean
  abortMessage?: string
}) {
  const previousPrompt = session.pendingPrompt
  const previousSocket = session.pendingPromptSocket
  session.pendingPrompt = null
  session.pendingPromptSocket = null

  if (previousPrompt && previousSocket) {
    if (options?.abortMessage) {
      sendPromptBridgeMessage(previousSocket, {
        type: 'prompt-abort',
        promptId: previousPrompt.promptId,
        message: options.abortMessage,
      })
    }
    if (!previousSocket.destroyed) {
      previousSocket.end()
    }
  }

  if (previousPrompt && options?.notify !== false) {
    emitPendingPrompt(session, null)
  }
}

function normalizeFeishuInstallerAuthResult(
  payload: FeishuPromptBridgeAuthResultRequest | null | undefined
): FeishuInstallerAuthResult | null {
  const appId = String(payload?.appId || '').trim()
  const openId = String(payload?.openId || '').trim()
  if (!appId || !openId) return null

  const domain = String(payload?.domain || '').trim()
  return {
    appId,
    openId,
    ...(typeof payload?.isExisting === 'boolean' ? { isExisting: payload.isExisting } : {}),
    ...(domain ? { domain } : {}),
  }
}

function recordFeishuInstallerAuthResult(
  session: ActiveFeishuInstallerSession,
  payload: FeishuPromptBridgeAuthResultRequest
): void {
  const normalized = normalizeFeishuInstallerAuthResult(payload)
  if (!normalized) return

  const existingIndex = session.authResults.findIndex((item) =>
    item.appId.toLowerCase() === normalized.appId.toLowerCase()
    && item.openId === normalized.openId
  )
  if (existingIndex >= 0) {
    session.authResults[existingIndex] = {
      ...session.authResults[existingIndex],
      ...normalized,
    }
  } else {
    session.authResults.push(normalized)
  }

  void appendFeishuInstallerDiag('auth-result-received', {
    sessionId: session.id,
    appId: normalized.appId,
    openId: normalized.openId,
    isExisting: normalized.isExisting ?? null,
    domain: normalized.domain || '',
  })
}

async function createPromptBridgeServer(
  sessionToken: string
): Promise<Server> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8')
      let buffer = ''

      socket.on('data', (chunk) => {
        buffer += String(chunk || '')
        let newlineIndex = buffer.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim()
          buffer = buffer.slice(newlineIndex + 1)
          if (line) {
            let payload: FeishuPromptBridgeRequest | null = null
            try {
              payload = JSON.parse(line) as FeishuPromptBridgeRequest
            } catch {
              socket.destroy()
              return
            }

            if (!activeSession || activeSession.promptSessionToken !== sessionToken || activeSession.phase !== 'running') {
              if (payload?.type === 'auth-result') {
                socket.end()
                return
              }
              sendPromptBridgeMessage(socket, {
                type: 'prompt-abort',
                promptId: String(payload?.promptId || ''),
                message: 'Feishu installer session is no longer active.',
              })
              socket.end()
              return
            }

            if (payload?.type === 'auth-result') {
              if (payload.sessionToken === sessionToken) {
                recordFeishuInstallerAuthResult(activeSession, payload)
              }
              socket.end()
              return
            }

            const promptPayload = payload?.type === 'prompt' ? payload : null
            if (
              !promptPayload
              || promptPayload.sessionToken !== sessionToken
              || promptPayload.promptName !== 'useExisting'
              || String(promptPayload.promptType || '').toLowerCase() !== 'confirm'
            ) {
              sendPromptBridgeMessage(socket, {
                type: 'prompt-abort',
                promptId: String(promptPayload?.promptId || ''),
                message: 'Unsupported Feishu installer prompt payload.',
              })
              socket.end()
              return
            }

            if (activeSession.pendingPrompt) {
              sendPromptBridgeMessage(socket, {
                type: 'prompt-abort',
                promptId: promptPayload.promptId,
                message: 'Another Feishu installer prompt is already pending.',
              })
              socket.end()
              return
            }

            activeSession.pendingPrompt = normalizePendingPrompt({
              promptId: promptPayload.promptId,
              appId: promptPayload.appId,
              defaultValue: promptPayload.defaultValue,
            })
            activeSession.pendingPromptSocket = socket
            emitPendingPrompt(activeSession, activeSession.pendingPrompt)
          }
          newlineIndex = buffer.indexOf('\n')
        }
      })

      socket.on('close', () => {
        if (!activeSession || activeSession.pendingPromptSocket !== socket) return
        clearPendingPrompt(activeSession, { notify: true })
      })
    })

    server.once('error', reject)
    server.listen(0, FEISHU_PROMPT_BRIDGE_HOST, () => {
      server.removeListener('error', reject)
      resolve(server)
    })
  })
}

function resolvePromptBridgePort(server: Server): number {
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('飞书安装器确认桥接端口解析失败')
  }
  return address.port
}

export async function getFeishuInstallerSessionSnapshot(): Promise<FeishuInstallerSessionSnapshot> {
  return buildSnapshot()
}

export async function startFeishuInstallerSession(
  emit: (event: FeishuInstallerSessionEvent) => void
): Promise<FeishuInstallerSessionSnapshot> {
  if (activeSession?.phase === 'running') {
    return buildSnapshot()
  }

  if (isManagedOperationLockBusy(FEISHU_MANAGED_CHANNEL_LOCK_KEY)) {
    return buildManagedChannelBusySnapshot()
  }

  const runtimeSnapshotCheck = await resolveFeishuInstallerRuntimeSnapshotPureFailure()
  if (runtimeSnapshotCheck.message) {
    return buildExitedSnapshot({
      guardrail: failChannelInstallerGuardrailStatus({
        channelId: FEISHU_MANAGED_CHANNEL_ID,
        step: 'runtime',
        code: 'runtime-snapshot-unavailable',
        message: runtimeSnapshotCheck.message,
        patch: {
          runtime: {
            state: 'failed',
            contextResolved: false,
            platform: process.platform,
            code: 'runtime-snapshot-unavailable',
            message: runtimeSnapshotCheck.message,
          },
        },
      }),
      output: runtimeSnapshotCheck.message,
      command: [...buildFeishuInstallerCommand().command],
    })
  }

  let commandEnv: NodeJS.ProcessEnv
  try {
    commandEnv = buildInstallerCommandEnv({
      activeRuntimeSnapshot: runtimeSnapshotCheck.snapshot || undefined,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return buildExitedSnapshot({
      guardrail: failChannelInstallerGuardrailStatus({
        channelId: FEISHU_MANAGED_CHANNEL_ID,
        step: 'environment',
        code: 'env-build-failed',
        message,
      }),
      output: message,
      command: [...buildFeishuInstallerCommand().command],
    })
  }

  const capability = await probePlatformCommandCapability('npx', {
    platform: process.platform,
    env: commandEnv,
  })
  if (!capability.available) {
    const message = capability.message || 'npx 命令不可用，无法启动飞书官方安装器。'
    return buildExitedSnapshot({
      guardrail: failChannelInstallerGuardrailStatus({
        channelId: FEISHU_MANAGED_CHANNEL_ID,
        step: 'command',
        code: 'command-unavailable',
        message,
        patch: {
          environment: { state: 'ok' },
        },
      }),
      output: message,
      command: [...buildFeishuInstallerCommand().command],
    })
  }

  const operationLease = tryAcquireManagedOperationLease(FEISHU_MANAGED_CHANNEL_LOCK_KEY)
  if (!operationLease) {
    return buildManagedChannelBusySnapshot()
  }
  let keepOperationLease = false
  try {
    if (hasRunningFeishuInstallerSession()) {
      return buildSnapshot()
    }

    const preflightResult = await runFeishuInstallerPreflight(runtimeSnapshotCheck.snapshot)
    if (!preflightResult.ok) {
      return buildExitedSnapshot({
        code: preflightResult.code ?? 1,
        guardrail: mergeChannelInstallerGuardrailStatus(preflightResult.guardrail, {
          environment: { state: 'ok' },
          command: { state: 'ok' },
          lock: {
            state: 'ok',
            key: FEISHU_MANAGED_CHANNEL_LOCK_KEY,
          },
        }),
        output: preflightResult.output,
        command: [...buildFeishuInstallerCommand().command],
      })
    }

    const stopGatewayResult = await stopGatewayForInstaller('feishu-installer-start')
    const guardrailAfterGatewayStop = mergeChannelInstallerGuardrailStatus(preflightResult.guardrail, {
      environment: { state: 'ok' },
      command: { state: 'ok' },
      lock: {
        state: 'ok',
        key: FEISHU_MANAGED_CHANNEL_LOCK_KEY,
      },
      gateway: {
        stop: {
          state: stopGatewayResult.ok ? 'ok' : 'failed',
          stopped: stopGatewayResult.stopped,
          skipped: stopGatewayResult.skipped,
          ...(stopGatewayResult.ok
            ? {}
            : {
                code: 'gateway-stop-failed' as const,
                message: stopGatewayResult.stopResult?.stderr
                  || stopGatewayResult.stopResult?.stdout
                  || 'Failed to stop gateway before starting the Feishu installer.',
              }),
        },
      },
      ...(stopGatewayResult.ok
        ? {}
        : {
            failure: {
              code: 'gateway-stop-failed' as const,
              message: stopGatewayResult.stopResult?.stderr
                || stopGatewayResult.stopResult?.stdout
                || 'Failed to stop gateway before starting the Feishu installer.',
              step: 'gateway-stop' as const,
            },
          }),
    })
    if (!stopGatewayResult.ok) {
      return buildExitedSnapshot({
        guardrail: guardrailAfterGatewayStop,
        output: stopGatewayResult.stopResult?.stderr
          || stopGatewayResult.stopResult?.stdout
          || 'Failed to stop gateway before starting the Feishu installer.',
        code: stopGatewayResult.stopResult?.code ?? 1,
        command: [...buildFeishuInstallerCommand().command],
      })
    }

    const sessionToken = randomUUID()
    let isolatedNpmCache: Awaited<ReturnType<typeof createIsolatedNpmCacheEnv>> | null = null
    let promptBridgeServer: Server | null = null

    try {
      const npmCacheDir = resolveFeishuInstallerNpmCacheDir()
      isolatedNpmCache = await createIsolatedNpmCacheEnv(npmCacheDir)
      const commandResolution = buildFeishuInstallerCommand()
      const promptHookPath = await ensureFeishuInstallerPromptHookFile()
      promptBridgeServer = await createPromptBridgeServer(sessionToken)
      const promptBridgePort = resolvePromptBridgePort(promptBridgeServer)
      const sessionId = randomUUID()
      const diagEnabled = isFeishuInstallerDiagEnabled()
      const diagLogPath = diagEnabled ? await resolveFeishuInstallerDiagLogPath() : ''

      const proc = spawn(commandResolution.command[0], commandResolution.command.slice(1), {
        cwd: resolveSafeWorkingDirectory({
          env: process.env,
          platform: process.platform,
        }),
        env: {
          ...commandEnv,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          NODE_OPTIONS: appendNodeRequireOption(process.env.NODE_OPTIONS, promptHookPath),
          QCLAW_FEISHU_PROMPT_PORT: String(promptBridgePort),
          QCLAW_FEISHU_PROMPT_SESSION_TOKEN: sessionToken,
          ...(diagEnabled
            ? {
                QCLAW_FEISHU_DIAG: '1',
                QCLAW_FEISHU_DIAG_LOG_PATH: diagLogPath,
                QCLAW_FEISHU_DIAG_SESSION_ID: sessionId,
              }
            : {}),
          ...isolatedNpmCache.env,
        },
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      activeSession = {
        id: sessionId,
        process: proc,
        phase: 'running',
        output: commandResolution.bundledPackagePath
          ? `[Qclaw] 使用应用内预置飞书安装器包: ${commandResolution.bundledPackagePath}\n`
          : '',
        code: null,
        ok: false,
        canceled: false,
        command: [...commandResolution.command],
        guardrail: mergeChannelInstallerGuardrailStatus(guardrailAfterGatewayStop, {
          spawn: { state: 'ok' },
        }),
        npmCacheDir: isolatedNpmCache.cacheDir,
        emit,
        pendingPrompt: null,
        authResults: [],
        pendingPromptSocket: null,
        promptBridgeServer,
        promptSessionToken: sessionToken,
        managedOperationLease: operationLease,
        gatewayRecoveryAttempted: false,
        gatewayRecoveryResult: null,
        gatewayStoppedForInstall: stopGatewayResult.stopped,
        gatewayStopSnapshot: stopGatewayResult.snapshot,
      }
      keepOperationLease = true
      setActiveProcess(proc, FEISHU_INSTALLER_CONTROL_DOMAIN)

      emitFeishuInstallerEvent(emit, {
        sessionId,
        type: 'started',
        phase: 'running',
        command: [...commandResolution.command],
        guardrail: activeSession.guardrail,
        pendingPrompt: null,
      })
      void appendFeishuInstallerDiag('session-started', {
        sessionId,
        command: [...commandResolution.command],
        promptBridgePort,
        diagLogPath,
        npmCacheDir: isolatedNpmCache.cacheDir,
        gatewayStoppedForInstall: stopGatewayResult.stopped,
      })

      proc.stdout?.on('data', (chunk) => {
        appendOutput('stdout', String(chunk), emit)
      })

      proc.stderr?.on('data', (chunk) => {
        appendOutput('stderr', String(chunk), emit)
      })

      proc.on('close', async (code) => {
        if (!activeSession || activeSession.id !== sessionId) return
        const session = activeSession
        if (session.phase === 'exited') return
        const npmCacheDirForCleanup = session.npmCacheDir
        clearPendingPrompt(session, {
          notify: false,
          abortMessage: 'Feishu installer session has exited.',
        })
        closePromptBridgeServer(session)
        clearActiveProcessIfMatch(proc, FEISHU_INSTALLER_CONTROL_DOMAIN)
        const canceled = consumeCanceledProcess(proc, FEISHU_INSTALLER_CONTROL_DOMAIN)
        session.phase = 'exited'
        session.code = canceled ? null : code
        session.ok = code === 0 && !canceled
        session.canceled = canceled
        if (session.ok) {
          const finalizeResult = await ensureFeishuOfficialPluginReady({
            runtimeContext: preflightResult.runtimeContext,
          }).catch((error) => ({
            ok: false,
            installedThisRun: false,
            state: null,
            stdout: '',
            stderr: error instanceof Error ? error.message : String(error),
            code: 1,
            message: '飞书官方插件最终同步失败',
          }))
          if (!finalizeResult.ok) {
            const details = [finalizeResult.message, finalizeResult.stderr, finalizeResult.stdout]
              .map((value) => String(value || '').trim())
              .filter(Boolean)
              .join('\n\n')
            if (details) {
              session.output += `\n${details}`
            }
            session.ok = false
            session.code = finalizeResult.code ?? 1
            session.guardrail = mergeChannelInstallerGuardrailStatus(session.guardrail, {
              finalSync: {
                state: 'failed',
                code: 'final-sync-failed',
                message: details || '飞书官方插件最终同步失败。',
              },
              failure: {
                code: 'final-sync-failed',
                message: details || '飞书官方插件最终同步失败。',
                step: 'final-sync',
              },
            })
          } else {
            session.guardrail = mergeChannelInstallerGuardrailStatus(session.guardrail, {
              finalSync: {
                state: 'ok',
                message: finalizeResult.message,
              },
            })
          }
        }
        const recoveryResult = await recoverGatewayForSession(session, 'feishu-installer-close')
        if (!recoveryResult.ok) {
          session.ok = false
          session.code = session.code ?? 1
        }
        emitFeishuInstallerEvent(emit, {
          sessionId,
          type: 'exit',
          phase: 'exited',
          code: session.code,
          ok: session.ok,
          canceled,
          guardrail: session.guardrail,
          pendingPrompt: null,
        })
        void appendFeishuInstallerDiag('session-exit', {
          sessionId,
          code: session.code,
          ok: session.ok,
          canceled,
          gatewayRecoveryOk: recoveryResult.ok,
        })
        releaseSessionManagedOperationLease(session)
        void cleanupIsolatedNpmCacheEnv(npmCacheDirForCleanup)
      })

      proc.on('error', async (error) => {
        if (!activeSession || activeSession.id !== sessionId) return
        const session = activeSession
        if (session.phase === 'exited') return
        const npmCacheDirForCleanup = session.npmCacheDir
        clearPendingPrompt(session, {
          notify: false,
          abortMessage: 'Feishu installer session failed before answering the pending prompt.',
        })
        closePromptBridgeServer(session)
        clearActiveProcessIfMatch(proc, FEISHU_INSTALLER_CONTROL_DOMAIN)
        const canceled = consumeCanceledProcess(proc, FEISHU_INSTALLER_CONTROL_DOMAIN)
        session.output += `\n${error instanceof Error ? error.message : String(error)}`
        session.phase = 'exited'
        session.code = canceled ? null : 1
        session.ok = false
        session.canceled = canceled
        const recoveryResult = await recoverGatewayForSession(session, 'feishu-installer-error')
        if (!recoveryResult.ok) {
          session.code = session.code ?? 1
        }
        emitFeishuInstallerEvent(emit, {
          sessionId,
          type: 'exit',
          phase: 'exited',
          code: session.code,
          ok: false,
          canceled,
          guardrail: session.guardrail,
          pendingPrompt: null,
        })
        void appendFeishuInstallerDiag('session-error', {
          sessionId,
          code: session.code,
          canceled,
          message: error instanceof Error ? error.message : String(error),
          gatewayRecoveryOk: recoveryResult.ok,
        })
        releaseSessionManagedOperationLease(session)
        void cleanupIsolatedNpmCacheEnv(npmCacheDirForCleanup)
      })

      return buildSnapshot()
    } catch (error) {
      if (promptBridgeServer) {
        promptBridgeServer.close()
      }
      if (isolatedNpmCache) {
        void cleanupIsolatedNpmCacheEnv(isolatedNpmCache.cacheDir)
      }
      const message = error instanceof Error ? error.message : String(error)
      const recoveryResult = await runGatewayRecoveryWithTimeout(
        stopGatewayResult.snapshot,
        'feishu-installer-start-failed'
      )
      const recoveryFailure = recoveryResult.ok ? '' : `\n${formatGatewayRecoveryFailure(recoveryResult)}`
      const guardrail = mergeChannelInstallerGuardrailStatus(guardrailAfterGatewayStop, {
        spawn: {
          state: 'failed',
          code: 'spawn-failed',
          message: message || '飞书官方安装器启动失败',
        },
        gateway: {
          recovery: toInstallerGatewayRecoveryStatus(recoveryResult),
        },
        failure: {
          code: recoveryResult.ok ? 'spawn-failed' : 'gateway-recovery-failed',
          message: recoveryResult.ok
            ? message || '飞书官方安装器启动失败'
            : formatGatewayRecoveryFailure(recoveryResult),
          step: recoveryResult.ok ? 'spawn' : 'gateway-recovery',
        },
      })
      return {
        active: false,
        sessionId: randomUUID(),
        phase: 'exited',
        output: `${message || '飞书官方安装器启动失败'}${recoveryFailure}`,
        code: 1,
        ok: false,
        canceled: false,
        command: [...buildFeishuInstallerCommand().command],
        guardrail,
        pendingPrompt: null,
        authResults: [],
      }
    }
  } finally {
    if (!keepOperationLease) {
      operationLease.release()
    }
  }
}

export async function writeFeishuInstallerSessionInput(
  sessionId: string,
  input: string
): Promise<{ ok: boolean; message?: string }> {
  if (!activeSession || activeSession.id !== sessionId || activeSession.phase !== 'running') {
    return { ok: false, message: '飞书官方安装器当前未运行。' }
  }

  if (activeSession.pendingPrompt) {
    return { ok: false, message: '当前正在等待你确认是否新建机器人，请先完成确认弹窗。' }
  }

  const normalizedInput = String(input || '')
  if (!normalizedInput) {
    return { ok: false, message: '输入内容不能为空。' }
  }

  const stdin = activeSession.process.stdin
  if (!stdin || stdin.destroyed || !stdin.writable) {
    return { ok: false, message: '安装器当前不可写入，请重新启动。' }
  }

  return await new Promise((resolve) => {
    stdin.write(normalizedInput, (error) => {
      if (error) {
        resolve({ ok: false, message: error.message })
        return
      }
      resolve({ ok: true })
    })
  })
}

export async function answerFeishuInstallerSessionPrompt(
  sessionId: string,
  promptId: string,
  resolution: FeishuInstallerPromptResolution
): Promise<{ ok: boolean; message?: string }> {
  if (!activeSession || activeSession.id !== sessionId || activeSession.phase !== 'running') {
    return { ok: false, message: '飞书官方安装器当前未运行。' }
  }

  const pendingPrompt = activeSession.pendingPrompt
  if (!pendingPrompt || pendingPrompt.promptId !== String(promptId || '').trim()) {
    return { ok: false, message: '当前没有匹配的飞书安装器确认请求。' }
  }

  if (resolution === 'cancel') {
    clearPendingPrompt(activeSession, {
      notify: true,
      abortMessage: 'User canceled the pending Feishu bot creation prompt.',
    })
    const ok = await cancelActiveProcess(FEISHU_INSTALLER_CONTROL_DOMAIN)
    return {
      ok,
      message: ok ? undefined : '飞书官方安装器取消失败，请稍后重试。',
    }
  }

  if (resolution !== 'confirm') {
    return { ok: false, message: '未知的飞书安装器确认动作。' }
  }

  const delivered = await writePromptBridgeMessage(activeSession.pendingPromptSocket, {
    type: 'prompt-answer',
    promptId: pendingPrompt.promptId,
    answer: false,
  })
  if (!delivered) {
    return { ok: false, message: '飞书官方安装器确认写入失败，请重试。' }
  }
  clearPendingPrompt(activeSession, { notify: true })
  return { ok: true }
}

export interface StopFeishuInstallerSessionOptions {
  recoverGateway?: boolean
  recoveryTimeoutMs?: number
}

export interface StopFeishuInstallerSessionResult {
  gatewayRecovery?: GatewayRecoveryResult
  ok: boolean
}

export async function stopFeishuInstallerSession(
  options: StopFeishuInstallerSessionOptions = {}
): Promise<StopFeishuInstallerSessionResult> {
  if (!activeSession || activeSession.phase !== 'running') {
    return { ok: true }
  }
  const session = activeSession
  const sessionId = session.id
  void appendFeishuInstallerDiag('stop-requested', { sessionId })
  clearPendingPrompt(session, {
    notify: true,
    abortMessage: 'Feishu installer session was canceled by Qclaw.',
  })
  const ok = await cancelActiveProcess(FEISHU_INSTALLER_CONTROL_DOMAIN)
  const gatewayRecovery = options.recoverGateway
    ? await recoverGatewayForSession(session, 'feishu-installer-stop', {
        timeoutMs: options.recoveryTimeoutMs,
      })
    : undefined
  void appendFeishuInstallerDiag('stop-finished', {
    sessionId,
    ok,
    gatewayRecoveryOk: gatewayRecovery?.ok ?? null,
  })
  return {
    gatewayRecovery,
    ok: ok && (gatewayRecovery ? gatewayRecovery.ok : true),
  }
}
