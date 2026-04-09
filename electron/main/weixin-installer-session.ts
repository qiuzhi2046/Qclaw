import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { cancelActiveProcess } from './command-control'
import { getOpenClawPaths, readConfig, runShellStreaming } from './cli'
import { probePlatformCommandCapability } from './command-capabilities'
import { applyConfigPatchGuarded } from './openclaw-config-coordinator'
import { MAIN_RUNTIME_POLICY } from './runtime-policy'
import { resolveSafeWorkingDirectory } from './runtime-working-directory'
import { listWeixinAccountState } from './weixin-account-state'
import { prepareWeixinInstallerConfig } from './weixin-installer-config'
import { cleanupIsolatedNpmCacheEnv } from './npm-cache-env'
import { ensureManagedOpenClawNpmRuntime } from './openclaw-npm-runtime'
import {
  runOpenClawNpmRegistryFallback,
  type OpenClawCommandResultLike,
  type OpenClawNpmCommandOptions,
  type OpenClawNpmRegistryMirror,
} from './openclaw-download-fallbacks'

const WEIXIN_INSTALLER_CONTROL_DOMAIN = 'weixin-installer'
const WEIXIN_INSTALLER_PACKAGE = '@tencent-weixin/openclaw-weixin-cli@latest'
const WEIXIN_INSTALLER_COMMAND = ['npx', '-y', WEIXIN_INSTALLER_PACKAGE, 'install'] as const

function resolveWeixinOfficialPluginInstallPath(homeDir: string): string {
  return path.join(homeDir, 'extensions', 'openclaw-weixin')
}

function buildWeixinInstallerArgs(
  registryUrl: string | null | undefined,
  options: OpenClawNpmCommandOptions
): string[] {
  const args: string[] = []
  const userConfigPath = String(options.userConfigPath || '').trim()
  const globalConfigPath = String(options.globalConfigPath || '').trim()
  const cachePath = String(options.cachePath || '').trim()
  const fetchTimeoutMs = Number(options.fetchTimeoutMs)
  const fetchRetries = Number(options.fetchRetries)
  const normalizedRegistryUrl = String(registryUrl || '').trim()

  if (userConfigPath) {
    args.push(`--userconfig=${userConfigPath}`)
  }
  if (globalConfigPath) {
    args.push(`--globalconfig=${globalConfigPath}`)
  }
  if (cachePath) {
    args.push(`--cache=${cachePath}`)
  }
  if (Number.isFinite(fetchTimeoutMs) && fetchTimeoutMs > 0) {
    args.push(`--fetch-timeout=${Math.floor(fetchTimeoutMs)}`)
  }
  if (Number.isFinite(fetchRetries) && fetchRetries >= 0) {
    args.push(`--fetch-retries=${Math.floor(fetchRetries)}`)
  }
  if (normalizedRegistryUrl) {
    args.push(`--registry=${normalizedRegistryUrl}`)
  }
  if (options.noAudit !== false) {
    args.push('--no-audit')
  }
  if (options.noFund !== false) {
    args.push('--no-fund')
  }

  return [...args, '-y', WEIXIN_INSTALLER_PACKAGE, 'install']
}

function buildWeixinInstallerRetryMessage(mirror: OpenClawNpmRegistryMirror | null | undefined): string {
  const label = String(mirror?.label || '下一个来源').trim()
  return `\n[Qclaw] 个人微信安装器启动失败，正在切换到 ${label} 重试...\n`
}

async function isWeixinPluginInstalledOnDisk(): Promise<boolean> {
  const openClawPaths = await getOpenClawPaths().catch(() => null)
  const homeDir = String(openClawPaths?.homeDir || '').trim()
  if (!homeDir) return false

  try {
    await fs.promises.access(resolveWeixinOfficialPluginInstallPath(homeDir))
    return true
  } catch {
    return false
  }
}

async function prepareConfigForWeixinInstaller(): Promise<void> {
  const [config, pluginInstalledOnDisk] = await Promise.all([
    readConfig().catch(() => null),
    isWeixinPluginInstalledOnDisk().catch(() => false),
  ])

  const result = prepareWeixinInstallerConfig(config, {
    pluginInstalledOnDisk,
  })
  if (!result.changed) return

  const writeResult = await applyConfigPatchGuarded(
    {
      beforeConfig: config,
      afterConfig: result.config,
      reason: 'channel-connect-onboard-prepare',
    },
    undefined,
    { applyGatewayPolicy: false }
  )
  if (!writeResult.ok) {
    throw new Error(writeResult.message || '准备个人微信安装器配置失败')
  }
}

export interface WeixinInstallerSessionSnapshot {
  active: boolean
  sessionId: string | null
  phase: 'idle' | 'running' | 'exited'
  output: string
  code: number | null
  ok: boolean
  canceled: boolean
  command: string[]
  beforeAccountIds: string[]
  afterAccountIds: string[]
  newAccountIds: string[]
}

export interface WeixinInstallerSessionEvent {
  sessionId: string
  type: 'started' | 'output' | 'exit'
  stream?: 'stdout' | 'stderr'
  chunk?: string
  phase?: WeixinInstallerSessionSnapshot['phase']
  code?: number | null
  ok?: boolean
  canceled?: boolean
  command?: string[]
  beforeAccountIds?: string[]
  afterAccountIds?: string[]
  newAccountIds?: string[]
}

interface ActiveWeixinInstallerSession {
  id: string
  process: ChildProcess | null
  phase: WeixinInstallerSessionSnapshot['phase']
  output: string
  code: number | null
  ok: boolean
  canceled: boolean
  command: string[]
  beforeAccountIds: string[]
  afterAccountIds: string[]
  newAccountIds: string[]
  npmCacheDir: string
}

let activeSession: ActiveWeixinInstallerSession | null = null

function buildSnapshot(): WeixinInstallerSessionSnapshot {
  if (!activeSession) {
    return {
      active: false,
      sessionId: null,
      phase: 'idle',
      output: '',
      code: null,
      ok: false,
      canceled: false,
      command: [...WEIXIN_INSTALLER_COMMAND],
      beforeAccountIds: [],
      afterAccountIds: [],
      newAccountIds: [],
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
    beforeAccountIds: [...activeSession.beforeAccountIds],
    afterAccountIds: [...activeSession.afterAccountIds],
    newAccountIds: [...activeSession.newAccountIds],
  }
}

function appendOutput(stream: 'stdout' | 'stderr', chunk: string, emit: (event: WeixinInstallerSessionEvent) => void) {
  if (!activeSession) return
  activeSession.output += chunk
  emit({
    sessionId: activeSession.id,
    type: 'output',
    stream,
    chunk,
  })
}

async function collectAccountIds(): Promise<string[]> {
  const accounts = await listWeixinAccountState().catch(() => [])
  return accounts.map((account) => account.accountId)
}

async function finalizeSession(
  sessionId: string,
  emit: (event: WeixinInstallerSessionEvent) => void,
  params: { code: number | null; ok: boolean; canceled: boolean; extraOutput?: string }
): Promise<void> {
  if (!activeSession || activeSession.id !== sessionId) return
  const npmCacheDirForCleanup = activeSession.npmCacheDir

  if (params.extraOutput) {
    activeSession.output += params.extraOutput
  }

  const afterAccountIds = await collectAccountIds().catch(() => [])
  const beforeSet = new Set(activeSession.beforeAccountIds)
  const newAccountIds = afterAccountIds.filter((accountId) => !beforeSet.has(accountId))

  activeSession.phase = 'exited'
  activeSession.code = params.code
  activeSession.ok = params.ok
  activeSession.canceled = params.canceled
  activeSession.afterAccountIds = afterAccountIds
  activeSession.newAccountIds = newAccountIds

  emit({
    sessionId,
    type: 'exit',
    phase: 'exited',
    code: params.code,
    ok: params.ok,
    canceled: params.canceled,
    beforeAccountIds: [...activeSession.beforeAccountIds],
    afterAccountIds: [...afterAccountIds],
    newAccountIds: [...newAccountIds],
  })
  await cleanupIsolatedNpmCacheEnv(npmCacheDirForCleanup)
}

export async function getWeixinInstallerSessionSnapshot(): Promise<WeixinInstallerSessionSnapshot> {
  return buildSnapshot()
}

export async function startWeixinInstallerSession(
  emit: (event: WeixinInstallerSessionEvent) => void
): Promise<WeixinInstallerSessionSnapshot> {
  if (activeSession?.phase === 'running') {
    return buildSnapshot()
  }

  const capability = await probePlatformCommandCapability('npx', {
    platform: process.platform,
    env: process.env,
  })
  if (!capability.available) {
    const errorSessionId = activeSession?.id || randomUUID()
    return {
      active: false,
      sessionId: errorSessionId,
      phase: 'exited',
      output: capability.message || 'npx 命令不可用，无法启动个人微信安装器。',
      code: 1,
      ok: false,
      canceled: false,
      command: [...WEIXIN_INSTALLER_COMMAND],
      beforeAccountIds: [],
      afterAccountIds: [],
      newAccountIds: [],
    }
  }

  await prepareConfigForWeixinInstaller()

  const workingDirectory = resolveSafeWorkingDirectory({
    env: process.env,
    platform: process.platform,
  })
  const runtime = await ensureManagedOpenClawNpmRuntime({
    workingDirectory,
  })
  const beforeAccountIds = await collectAccountIds().catch(() => [])
  const sessionId = randomUUID()
  activeSession = {
    id: sessionId,
    process: null,
    phase: 'running',
    output: '',
    code: null,
    ok: false,
    canceled: false,
    command: [...WEIXIN_INSTALLER_COMMAND],
    beforeAccountIds,
    afterAccountIds: [],
    newAccountIds: [],
    npmCacheDir: String(runtime.commandOptions.cachePath || '').trim(),
  }
  const runAttempt = (
    mirror: OpenClawNpmRegistryMirror,
    emitStarted: boolean
  ): Promise<OpenClawCommandResultLike> => {
    if (!activeSession || activeSession.id !== sessionId) {
      return Promise.resolve({
        ok: false,
        stdout: '',
        stderr: 'weixin installer session is no longer active',
        code: 1,
        canceled: true,
      })
    }

    if (emitStarted) {
      emit({
        sessionId,
        type: 'started',
        phase: 'running',
        command: [...WEIXIN_INSTALLER_COMMAND],
        beforeAccountIds: [...beforeAccountIds],
      })
    } else {
      appendOutput('stderr', buildWeixinInstallerRetryMessage(mirror), emit)
    }

    return runShellStreaming(
      'npx',
      buildWeixinInstallerArgs(mirror.registryUrl, runtime.commandOptions),
      0,
      {
        cwd: workingDirectory,
        controlDomain: WEIXIN_INSTALLER_CONTROL_DOMAIN,
        detached: process.platform !== 'win32',
        shell: process.platform === 'win32',
        env: {
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
        onSpawn: (proc) => {
          if (!activeSession || activeSession.id !== sessionId) return
          activeSession.process = proc
        },
        onStdout: (chunk) => {
          appendOutput('stdout', chunk, emit)
        },
        onStderr: (chunk) => {
          appendOutput('stderr', chunk, emit)
        },
      }
    )
  }

  void (async () => {
    try {
      let emitStarted = true
      const { result } = await runOpenClawNpmRegistryFallback(async (mirror) => {
        const currentResult = await runAttempt(mirror, emitStarted)
        emitStarted = false
        return currentResult
      })

      await finalizeSession(sessionId, emit, {
        code: result.code,
        ok: result.ok,
        canceled: Boolean(result.canceled),
      })
    } catch (error) {
      await finalizeSession(sessionId, emit, {
        code: 1,
        ok: false,
        canceled: false,
        extraOutput: `\n${error instanceof Error ? error.message : String(error)}`,
      })
    }
  })()

  return buildSnapshot()
}

export async function stopWeixinInstallerSession(): Promise<{ ok: boolean }> {
  if (!activeSession || activeSession.phase !== 'running') {
    return { ok: true }
  }
  const proc = activeSession.process
  activeSession.phase = 'exited'
  const ok = await cancelActiveProcess(WEIXIN_INSTALLER_CONTROL_DOMAIN)

  if (process.platform !== 'win32' && proc && typeof proc.pid === 'number' && proc.pid > 0) {
    try {
      process.kill(-proc.pid, 'SIGTERM')
    } catch {
      // Ignore best-effort process tree termination failures.
    }
    setTimeout(() => {
      try {
        process.kill(-proc.pid!, 'SIGKILL')
      } catch {
        // Ignore if the process group already exited.
      }
    }, MAIN_RUNTIME_POLICY.processControl.cancelGracePeriodMs)
  }

  return { ok }
}
