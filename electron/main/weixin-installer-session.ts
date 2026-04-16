import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { app } from 'electron'
import {
  cancelActiveProcess,
  clearActiveProcessIfMatch,
  consumeCanceledProcess,
  setActiveProcess,
} from './command-control'
import { probePlatformCommandCapability } from './command-capabilities'
import { buildInstallerCommandEnv } from './installer-command-env'
import { resolveWindowsActiveRuntimeSnapshotForRead } from './openclaw-runtime-readonly'
import { MAIN_RUNTIME_POLICY } from './runtime-policy'
import { resolveSafeWorkingDirectory } from './runtime-working-directory'
import { listWeixinAccountState } from './weixin-account-state'
import { cleanupIsolatedNpmCacheEnv, createIsolatedNpmCacheEnv } from './npm-cache-env'
import { prepareManagedChannelPluginForSetup } from './managed-channel-plugin-lifecycle'
import type { WindowsActiveRuntimeSnapshot } from './platforms/windows/windows-runtime-policy'
import { resolveWindowsChannelRuntimeContext } from './platforms/windows/windows-channel-runtime-context'
import {
  createIdleChannelInstallerGuardrailStatus,
  failChannelInstallerGuardrailStatus,
  mergeChannelInstallerGuardrailStatus,
  type ChannelInstallerGuardrailStatus,
} from '../../src/shared/channel-installer-session'
import {
  isManagedOperationLockBusy,
  tryAcquireManagedOperationLease,
  type ManagedOperationLease,
} from './managed-operation-lock'

const childProcess = process.getBuiltinModule('node:child_process') as typeof import('node:child_process')
const { spawn } = childProcess

const WEIXIN_MANAGED_CHANNEL_ID = 'openclaw-weixin'
const WEIXIN_MANAGED_CHANNEL_LOCK_KEY = 'managed-channel-plugin:openclaw-weixin'
const WEIXIN_INSTALLER_CONTROL_DOMAIN = 'weixin-installer'
const WEIXIN_INSTALLER_PACKAGE = '@tencent-weixin/openclaw-weixin-cli@latest'
const WEIXIN_INSTALLER_COMMAND = ['npx', '-y', WEIXIN_INSTALLER_PACKAGE, 'install'] as const
const WEIXIN_MANAGED_CHANNEL_BUSY_MESSAGE = '个人微信官方插件正在执行安装、修复或配置同步，请稍后重试。'

function resolveWeixinInstallerNpmCacheDir(): string {
  return path.join(app.getPath('userData'), 'npm-cache')
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
  guardrail: ChannelInstallerGuardrailStatus
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
  guardrail?: ChannelInstallerGuardrailStatus
  beforeAccountIds?: string[]
  afterAccountIds?: string[]
  newAccountIds?: string[]
}

interface ActiveWeixinInstallerSession {
  id: string
  process: ChildProcess
  phase: WeixinInstallerSessionSnapshot['phase']
  output: string
  code: number | null
  ok: boolean
  canceled: boolean
  command: string[]
  guardrail: ChannelInstallerGuardrailStatus
  beforeAccountIds: string[]
  afterAccountIds: string[]
  newAccountIds: string[]
  npmCacheDir: string
  managedOperationLease: ManagedOperationLease
}

type WeixinInstallerPreflightResult =
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

let activeSession: ActiveWeixinInstallerSession | null = null

function hasRunningWeixinInstallerSession(): boolean {
  return activeSession?.phase === 'running'
}

function createWeixinInstallerGuardrail(
  patch: Parameters<typeof mergeChannelInstallerGuardrailStatus>[1] = {}
): ChannelInstallerGuardrailStatus {
  return mergeChannelInstallerGuardrailStatus(
    createIdleChannelInstallerGuardrailStatus(WEIXIN_MANAGED_CHANNEL_ID),
    patch
  )
}

function buildExitedSnapshot(params: {
  code?: number | null
  guardrail?: ChannelInstallerGuardrailStatus
  output: string
  sessionId?: string | null
}): WeixinInstallerSessionSnapshot {
  return {
    active: false,
    sessionId: params.sessionId || randomUUID(),
    phase: 'exited',
    output: params.output,
    code: params.code ?? 1,
    ok: false,
    canceled: false,
    command: [...WEIXIN_INSTALLER_COMMAND],
    guardrail: params.guardrail || createIdleChannelInstallerGuardrailStatus(WEIXIN_MANAGED_CHANNEL_ID),
    beforeAccountIds: [],
    afterAccountIds: [],
    newAccountIds: [],
  }
}

function buildManagedChannelBusySnapshot(): WeixinInstallerSessionSnapshot {
  return buildExitedSnapshot({
    output: WEIXIN_MANAGED_CHANNEL_BUSY_MESSAGE,
    guardrail: createWeixinInstallerGuardrail({
      preflight: {
        state: 'skipped',
        message: WEIXIN_MANAGED_CHANNEL_BUSY_MESSAGE,
      },
      lock: {
        state: 'running',
        key: WEIXIN_MANAGED_CHANNEL_LOCK_KEY,
        message: WEIXIN_MANAGED_CHANNEL_BUSY_MESSAGE,
      },
    }),
  })
}

async function resolveWeixinInstallerRuntimeSnapshotPureFailure(): Promise<{
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
      message: 'Windows OpenClaw 运行时尚未就绪，无法安全启动个人微信安装器。',
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
      message: 'Windows OpenClaw 运行时信息不完整，无法安全启动个人微信安装器。',
      snapshot,
    }
  }

  return {
    message: null,
    snapshot,
  }
}

async function resolveWeixinInstallerPreflightRuntimeContext(
  activeRuntimeSnapshot?: WindowsActiveRuntimeSnapshot | null
): Promise<WeixinInstallerPreflightResult> {
  if (process.platform !== 'win32') {
    return {
      ok: true,
      guardrail: createWeixinInstallerGuardrail({
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
    const message = runtimeResult.message || 'Windows OpenClaw 运行时预检查失败，无法安全启动个人微信安装器。'
    return {
      ok: false,
      code: 1,
      guardrail: failChannelInstallerGuardrailStatus({
        channelId: WEIXIN_MANAGED_CHANNEL_ID,
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
    guardrail: createWeixinInstallerGuardrail({
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

function formatWeixinPrepareFailure(result: { error?: string; reason?: string; kind?: string }): string {
  return [
    result.error,
    result.reason,
    result.kind ? `prepare result: ${result.kind}` : '',
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('\n\n') || '个人微信插件预检查失败，已阻止启动安装器以避免旧插件或旧配置导致失败。'
}

async function runWeixinInstallerPreflight(options: {
  assumeOperationLock?: boolean
  activeRuntimeSnapshot?: WindowsActiveRuntimeSnapshot | null
} = {}): Promise<WeixinInstallerPreflightResult> {
  const runtimeContextResult = await resolveWeixinInstallerPreflightRuntimeContext(
    options.activeRuntimeSnapshot
  )
  if (!runtimeContextResult.ok) {
    return runtimeContextResult
  }

  const prepareResult = await prepareManagedChannelPluginForSetup(WEIXIN_MANAGED_CHANNEL_ID, {
    assumeOperationLock: options.assumeOperationLock === true,
    runtimeContext: runtimeContextResult.runtimeContext,
  })
  const prepareKind = String(prepareResult.kind || '')
  if (
    prepareKind === 'prepare-failed'
    || prepareKind === 'repair-failed'
    || prepareKind === 'quarantine-failed'
    || prepareKind === 'capability-blocked'
    || prepareKind === 'install-failed'
    || prepareKind === 'gateway-reload-failed'
  ) {
    const output = formatWeixinPrepareFailure(prepareResult)
    return {
      ok: false,
      code: 1,
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
        lock: {
          state: 'ok',
          key: WEIXIN_MANAGED_CHANNEL_LOCK_KEY,
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

  return {
    ...runtimeContextResult,
    guardrail: mergeChannelInstallerGuardrailStatus(runtimeContextResult.guardrail, {
      preflight: { state: 'ok' },
      config: {
        state: 'ok',
        message: '个人微信插件预检查已完成。',
      },
      lock: {
        state: 'ok',
        key: WEIXIN_MANAGED_CHANNEL_LOCK_KEY,
      },
    }),
  }
}

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
      guardrail: createIdleChannelInstallerGuardrailStatus(WEIXIN_MANAGED_CHANNEL_ID),
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
    guardrail: activeSession.guardrail,
    beforeAccountIds: [...activeSession.beforeAccountIds],
    afterAccountIds: [...activeSession.afterAccountIds],
    newAccountIds: [...activeSession.newAccountIds],
  }
}

function emitWeixinInstallerEvent(
  emit: (event: WeixinInstallerSessionEvent) => void,
  event: WeixinInstallerSessionEvent
): void {
  try {
    emit(event)
  } catch {
    // Renderer delivery is best-effort; cleanup must not depend on IPC listeners.
  }
}

function appendOutput(stream: 'stdout' | 'stderr', chunk: string, emit: (event: WeixinInstallerSessionEvent) => void) {
  if (!activeSession) return
  activeSession.output += chunk
  emitWeixinInstallerEvent(emit, {
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
  if (activeSession.phase === 'exited') return
  const session = activeSession
  const npmCacheDirForCleanup = session.npmCacheDir

  if (params.extraOutput) {
    session.output += params.extraOutput
  }

  const afterAccountIds = await collectAccountIds().catch(() => [])
  const beforeSet = new Set(session.beforeAccountIds)
  const newAccountIds = afterAccountIds.filter((accountId) => !beforeSet.has(accountId))

  session.phase = 'exited'
  session.code = params.code
  session.ok = params.ok
  session.canceled = params.canceled
  session.afterAccountIds = afterAccountIds
  session.newAccountIds = newAccountIds

  try {
    emitWeixinInstallerEvent(emit, {
      sessionId,
      type: 'exit',
      phase: 'exited',
      code: params.code,
      ok: params.ok,
      canceled: params.canceled,
      beforeAccountIds: [...session.beforeAccountIds],
      afterAccountIds: [...afterAccountIds],
      newAccountIds: [...newAccountIds],
      guardrail: session.guardrail,
    })
  } finally {
    session.managedOperationLease.release()
    await cleanupIsolatedNpmCacheEnv(npmCacheDirForCleanup)
  }
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

  if (isManagedOperationLockBusy(WEIXIN_MANAGED_CHANNEL_LOCK_KEY)) {
    return buildManagedChannelBusySnapshot()
  }

  const runtimeSnapshotCheck = await resolveWeixinInstallerRuntimeSnapshotPureFailure()
  if (runtimeSnapshotCheck.message) {
    return buildExitedSnapshot({
      guardrail: failChannelInstallerGuardrailStatus({
        channelId: WEIXIN_MANAGED_CHANNEL_ID,
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
        channelId: WEIXIN_MANAGED_CHANNEL_ID,
        step: 'environment',
        code: 'env-build-failed',
        message,
      }),
      output: message,
    })
  }

  const capability = await probePlatformCommandCapability('npx', {
    platform: process.platform,
    env: commandEnv,
  })
  if (!capability.available) {
    const message = capability.message || 'npx 命令不可用，无法启动个人微信安装器。'
    return buildExitedSnapshot({
      guardrail: failChannelInstallerGuardrailStatus({
        channelId: WEIXIN_MANAGED_CHANNEL_ID,
        step: 'command',
        code: 'command-unavailable',
        message,
        patch: {
          environment: { state: 'ok' },
        },
      }),
      output: message,
    })
  }

  const operationLease = tryAcquireManagedOperationLease(WEIXIN_MANAGED_CHANNEL_LOCK_KEY)
  if (!operationLease) {
    return buildManagedChannelBusySnapshot()
  }
  let keepOperationLease = false
  try {
    if (hasRunningWeixinInstallerSession()) {
      return buildSnapshot()
    }

    const preflightResult = await runWeixinInstallerPreflight({
      activeRuntimeSnapshot: runtimeSnapshotCheck.snapshot,
      assumeOperationLock: true,
    })
    if (!preflightResult.ok) {
      return buildExitedSnapshot({
        code: preflightResult.code ?? 1,
        guardrail: mergeChannelInstallerGuardrailStatus(preflightResult.guardrail, {
          environment: { state: 'ok' },
          command: { state: 'ok' },
        }),
        output: preflightResult.output,
      })
    }

    const beforeAccountIds = await collectAccountIds().catch(() => [])
    const sessionId = randomUUID()
    let isolatedNpmCache: Awaited<ReturnType<typeof createIsolatedNpmCacheEnv>> | null = null
    let proc: ChildProcess

    try {
      const npmCacheDir = resolveWeixinInstallerNpmCacheDir()
      isolatedNpmCache = await createIsolatedNpmCacheEnv(npmCacheDir)
      proc = spawn(WEIXIN_INSTALLER_COMMAND[0], WEIXIN_INSTALLER_COMMAND.slice(1), {
        cwd: resolveSafeWorkingDirectory({
          env: process.env,
          platform: process.platform,
        }),
        env: {
          ...commandEnv,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          ...isolatedNpmCache.env,
        },
        detached: process.platform !== 'win32',
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      if (isolatedNpmCache) {
        void cleanupIsolatedNpmCacheEnv(isolatedNpmCache.cacheDir)
      }
      const message = error instanceof Error ? error.message : String(error)
      return buildExitedSnapshot({
        sessionId,
        guardrail: mergeChannelInstallerGuardrailStatus(preflightResult.guardrail, {
          environment: { state: 'ok' },
          command: { state: 'ok' },
          spawn: {
            state: 'failed',
            code: 'spawn-failed',
            message,
          },
          failure: {
            code: 'spawn-failed',
            message,
            step: 'spawn',
          },
        }),
        output: message,
      })
    }

    activeSession = {
      id: sessionId,
      process: proc,
      phase: 'running',
      output: '',
      code: null,
      ok: false,
      canceled: false,
      command: [...WEIXIN_INSTALLER_COMMAND],
      guardrail: mergeChannelInstallerGuardrailStatus(preflightResult.guardrail, {
        environment: { state: 'ok' },
        command: { state: 'ok' },
        spawn: { state: 'ok' },
      }),
      beforeAccountIds,
      afterAccountIds: [],
      newAccountIds: [],
      npmCacheDir: isolatedNpmCache.cacheDir,
      managedOperationLease: operationLease,
    }
    keepOperationLease = true
    setActiveProcess(proc, WEIXIN_INSTALLER_CONTROL_DOMAIN)

    emitWeixinInstallerEvent(emit, {
      sessionId,
      type: 'started',
      phase: 'running',
      command: [...WEIXIN_INSTALLER_COMMAND],
      guardrail: activeSession.guardrail,
      beforeAccountIds: [...beforeAccountIds],
    })

    proc.stdout?.on('data', (chunk) => {
      appendOutput('stdout', String(chunk), emit)
    })

    proc.stderr?.on('data', (chunk) => {
      appendOutput('stderr', String(chunk), emit)
    })

    proc.on('close', (code) => {
      if (!activeSession || activeSession.id !== sessionId) return
      clearActiveProcessIfMatch(proc, WEIXIN_INSTALLER_CONTROL_DOMAIN)
      const canceled = consumeCanceledProcess(proc, WEIXIN_INSTALLER_CONTROL_DOMAIN)
      void finalizeSession(sessionId, emit, {
        code: canceled ? null : code,
        ok: code === 0 && !canceled,
        canceled,
      })
    })

    proc.on('error', (error) => {
      if (!activeSession || activeSession.id !== sessionId) return
      activeSession.guardrail = mergeChannelInstallerGuardrailStatus(activeSession.guardrail, {
        spawn: {
          state: 'failed',
          code: 'spawn-failed',
          message: error instanceof Error ? error.message : String(error),
        },
        failure: {
          code: 'spawn-failed',
          message: error instanceof Error ? error.message : String(error),
          step: 'spawn',
        },
      })
      clearActiveProcessIfMatch(proc, WEIXIN_INSTALLER_CONTROL_DOMAIN)
      const canceled = consumeCanceledProcess(proc, WEIXIN_INSTALLER_CONTROL_DOMAIN)
      void finalizeSession(sessionId, emit, {
        code: canceled ? null : 1,
        ok: false,
        canceled,
        extraOutput: `\n${error instanceof Error ? error.message : String(error)}`,
      })
    })

    return buildSnapshot()
  } finally {
    if (!keepOperationLease) {
      operationLease.release()
    }
  }
}

export async function stopWeixinInstallerSession(): Promise<{ ok: boolean }> {
  if (!activeSession || activeSession.phase !== 'running') {
    return { ok: true }
  }
  const proc = activeSession.process
  const ok = await cancelActiveProcess(WEIXIN_INSTALLER_CONTROL_DOMAIN)

  if (process.platform !== 'win32' && typeof proc.pid === 'number' && proc.pid > 0) {
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
