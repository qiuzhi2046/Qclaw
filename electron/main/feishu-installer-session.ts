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
  cancelActiveProcess,
  clearActiveProcessIfMatch,
  consumeCanceledProcess,
  setActiveProcess,
} from './command-control'
import { buildFeishuInstallerPromptHookScript } from './feishu-installer-prompt-hook'
import { readConfig } from './cli'
import { probePlatformCommandCapability } from './command-capabilities'
import { ensureFeishuOfficialPluginReady } from './feishu-official-plugin-state'
import { buildInstallerCommandEnv } from './installer-command-env'
import { applyConfigPatchGuarded } from './openclaw-config-coordinator'
import {
  FEISHU_OFFICIAL_PLUGIN_ID,
  prepareFeishuInstallerConfig,
} from './feishu-installer-config'
import { stopGatewayIfOwned } from './gateway-lifecycle-controller'
import { resolveOpenClawPathsForRead } from './openclaw-runtime-readonly'
import { MAIN_RUNTIME_POLICY } from './runtime-policy'
import { resolveSafeWorkingDirectory } from './runtime-working-directory'
import { cleanupIsolatedNpmCacheEnv, createIsolatedNpmCacheEnv } from './npm-cache-env'

const childProcess = process.getBuiltinModule('node:child_process') as typeof import('node:child_process')
const net = process.getBuiltinModule('node:net') as typeof import('node:net')
const { spawn } = childProcess

const FEISHU_INSTALLER_CONTROL_DOMAIN = 'feishu-installer'
const FEISHU_INSTALLER_PACKAGE = '@larksuite/openclaw-lark-tools'
const FEISHU_OFFICIAL_PLUGIN_MANIFEST = 'openclaw.plugin.json'
const FEISHU_PROMPT_BRIDGE_HOST = '127.0.0.1'

interface FeishuPromptBridgeRequest {
  type: 'prompt'
  sessionToken: string
  promptId: string
  promptName: string
  promptType: string
  defaultValue?: boolean | null
  appId?: string
}

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

async function prepareConfigForFeishuInstaller(): Promise<void> {
  const config = await readConfig().catch(() => null)
  const openClawPaths = await resolveOpenClawPathsForRead().catch(() => null)
  const homeDir = String(openClawPaths?.homeDir || '').trim()
  const pluginInstallPath = homeDir ? path.join(homeDir, 'extensions', FEISHU_OFFICIAL_PLUGIN_ID) : ''
  const pluginInstalledOnDisk = homeDir
    ? await isFeishuOfficialPluginInstalledOnDisk().catch(() => false)
    : false

  const result = prepareFeishuInstallerConfig(config, {
    pluginInstalledOnDisk,
    installPath: pluginInstallPath,
  })

  if (result.changed) {
    const writeResult = await applyConfigPatchGuarded({
      beforeConfig: config,
      afterConfig: result.config,
      reason: 'channel-connect-onboard-prepare',
    }, undefined, {
      applyGatewayPolicy: false,
    })
    if (!writeResult.ok) {
      throw new Error(writeResult.message || '准备飞书安装器配置失败')
    }
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

export interface FeishuInstallerSessionSnapshot {
  active: boolean
  sessionId: string | null
  phase: 'idle' | 'running' | 'exited'
  output: string
  code: number | null
  ok: boolean
  canceled: boolean
  command: string[]
  pendingPrompt: FeishuInstallerPendingPrompt | null
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
  npmCacheDir: string
  emit: (event: FeishuInstallerSessionEvent) => void
  pendingPrompt: FeishuInstallerPendingPrompt | null
  pendingPromptSocket: Socket | null
  promptBridgeServer: Server | null
  promptSessionToken: string
  gatewayStoppedForInstall: boolean
}

let activeSession: ActiveFeishuInstallerSession | null = null

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
      pendingPrompt: null,
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
    pendingPrompt: activeSession.pendingPrompt,
  }
}

function emitPendingPrompt(session: ActiveFeishuInstallerSession, pendingPrompt: FeishuInstallerPendingPrompt | null) {
  session.emit({
    sessionId: session.id,
    type: 'prompt',
    pendingPrompt,
  })
}

function appendOutput(stream: 'stdout' | 'stderr', chunk: string, emit: (event: FeishuInstallerSessionEvent) => void) {
  if (!activeSession) return
  activeSession.output += chunk
  emit({
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
              sendPromptBridgeMessage(socket, {
                type: 'prompt-abort',
                promptId: String(payload?.promptId || ''),
                message: 'Feishu installer session is no longer active.',
              })
              socket.end()
              return
            }

            if (
              payload?.type !== 'prompt'
              || payload.sessionToken !== sessionToken
              || payload.promptName !== 'useExisting'
              || String(payload.promptType || '').toLowerCase() !== 'confirm'
            ) {
              sendPromptBridgeMessage(socket, {
                type: 'prompt-abort',
                promptId: String(payload?.promptId || ''),
                message: 'Unsupported Feishu installer prompt payload.',
              })
              socket.end()
              return
            }

            if (activeSession.pendingPrompt) {
              sendPromptBridgeMessage(socket, {
                type: 'prompt-abort',
                promptId: payload.promptId,
                message: 'Another Feishu installer prompt is already pending.',
              })
              socket.end()
              return
            }

            activeSession.pendingPrompt = normalizePendingPrompt({
              promptId: payload.promptId,
              appId: payload.appId,
              defaultValue: payload.defaultValue,
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

  const commandEnv = buildInstallerCommandEnv()
  const capability = await probePlatformCommandCapability('npx', {
    platform: process.platform,
    env: commandEnv,
  })
  if (!capability.available) {
    const errorSessionId = activeSession?.id || randomUUID()
    const commandResolution = buildFeishuInstallerCommand()
    return {
      active: false,
      sessionId: errorSessionId,
      phase: 'exited',
      output: capability.message || 'npx 命令不可用，无法启动飞书官方安装器。',
      code: 1,
      ok: false,
      canceled: false,
      command: [...commandResolution.command],
      pendingPrompt: null,
    }
  }

  const stopGatewayResult = await stopGatewayIfOwned('feishu-installer-start')
  if (!stopGatewayResult.ok) {
    const errorSessionId = activeSession?.id || randomUUID()
    const commandResolution = buildFeishuInstallerCommand()
    return {
      active: false,
      sessionId: errorSessionId,
      phase: 'exited',
      output: stopGatewayResult.stderr || stopGatewayResult.stdout || 'Failed to stop gateway before starting the Feishu installer.',
      code: stopGatewayResult.code ?? 1,
      ok: false,
      canceled: false,
      command: [...commandResolution.command],
      pendingPrompt: null,
    }
  }

  await prepareConfigForFeishuInstaller().catch(() => {
    // Best effort only; installer startup should still proceed if config cleanup fails.
  })

  const npmCacheDir = resolveFeishuInstallerNpmCacheDir()
  const isolatedNpmCache = await createIsolatedNpmCacheEnv(npmCacheDir)
  const sessionToken = randomUUID()

  try {
    const commandResolution = buildFeishuInstallerCommand()
    const promptHookPath = await ensureFeishuInstallerPromptHookFile()
    const promptBridgeServer = await createPromptBridgeServer(sessionToken)
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
      timeout: MAIN_RUNTIME_POLICY.cli.pluginInstallNpxTimeoutMs,
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
      npmCacheDir: isolatedNpmCache.cacheDir,
      emit,
      pendingPrompt: null,
      pendingPromptSocket: null,
      promptBridgeServer,
      promptSessionToken: sessionToken,
      gatewayStoppedForInstall: true,
    }
    setActiveProcess(proc, FEISHU_INSTALLER_CONTROL_DOMAIN)

    emit({
      sessionId,
      type: 'started',
      phase: 'running',
      command: [...commandResolution.command],
      pendingPrompt: null,
    })
    void appendFeishuInstallerDiag('session-started', {
      sessionId,
      command: [...commandResolution.command],
      promptBridgePort,
      diagLogPath,
      npmCacheDir: isolatedNpmCache.cacheDir,
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
      if (session.ok && session.gatewayStoppedForInstall) {
        const finalizeResult = await ensureFeishuOfficialPluginReady()
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
        }
      }
      emit({
        sessionId,
        type: 'exit',
        phase: 'exited',
        code: session.code,
        ok: session.ok,
        canceled,
        pendingPrompt: null,
      })
      void appendFeishuInstallerDiag('session-exit', {
        sessionId,
        code: session.code,
        ok: session.ok,
        canceled,
      })
      void cleanupIsolatedNpmCacheEnv(npmCacheDirForCleanup)
    })

    proc.on('error', (error) => {
      if (!activeSession || activeSession.id !== sessionId) return
      const npmCacheDirForCleanup = activeSession.npmCacheDir
      clearPendingPrompt(activeSession, {
        notify: false,
        abortMessage: 'Feishu installer session failed before answering the pending prompt.',
      })
      closePromptBridgeServer(activeSession)
      clearActiveProcessIfMatch(proc, FEISHU_INSTALLER_CONTROL_DOMAIN)
      const canceled = consumeCanceledProcess(proc, FEISHU_INSTALLER_CONTROL_DOMAIN)
      activeSession.output += `\n${error instanceof Error ? error.message : String(error)}`
      activeSession.phase = 'exited'
      activeSession.code = canceled ? null : 1
      activeSession.ok = false
      activeSession.canceled = canceled
      emit({
        sessionId,
        type: 'exit',
        phase: 'exited',
        code: activeSession.code,
        ok: false,
        canceled,
        pendingPrompt: null,
      })
      void appendFeishuInstallerDiag('session-error', {
        sessionId,
        code: activeSession.code,
        canceled,
        message: error instanceof Error ? error.message : String(error),
      })
      void cleanupIsolatedNpmCacheEnv(npmCacheDirForCleanup)
    })

    return buildSnapshot()
  } catch (error) {
    void cleanupIsolatedNpmCacheEnv(isolatedNpmCache.cacheDir)
    const message = error instanceof Error ? error.message : String(error)
    return {
      active: false,
      sessionId: randomUUID(),
      phase: 'exited',
      output: message || '飞书官方安装器启动失败',
      code: 1,
      ok: false,
      canceled: false,
      command: [...buildFeishuInstallerCommand().command],
      pendingPrompt: null,
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

export async function stopFeishuInstallerSession(): Promise<{ ok: boolean }> {
  if (!activeSession || activeSession.phase !== 'running') {
    return { ok: true }
  }
  const sessionId = activeSession.id
  void appendFeishuInstallerDiag('stop-requested', { sessionId })
  clearPendingPrompt(activeSession, {
    notify: true,
    abortMessage: 'Feishu installer session was canceled by Qclaw.',
  })
  const ok = await cancelActiveProcess(FEISHU_INSTALLER_CONTROL_DOMAIN)
  void appendFeishuInstallerDiag('stop-finished', { sessionId, ok })
  return { ok }
}
