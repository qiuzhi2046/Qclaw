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
import { MAIN_RUNTIME_POLICY } from './runtime-policy'
import { resolveSafeWorkingDirectory } from './runtime-working-directory'
import { listWeixinAccountState } from './weixin-account-state'
import { cleanupIsolatedNpmCacheEnv, createIsolatedNpmCacheEnv } from './npm-cache-env'

const childProcess = process.getBuiltinModule('node:child_process') as typeof import('node:child_process')
const { spawn } = childProcess

const WEIXIN_INSTALLER_CONTROL_DOMAIN = 'weixin-installer'
const WEIXIN_INSTALLER_PACKAGE = '@tencent-weixin/openclaw-weixin-cli@latest'
const WEIXIN_INSTALLER_COMMAND = ['npx', '-y', WEIXIN_INSTALLER_PACKAGE, 'install'] as const

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
  process: ChildProcess
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

  const commandEnv = buildInstallerCommandEnv()
  const capability = await probePlatformCommandCapability('npx', {
    platform: process.platform,
    env: commandEnv,
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

  const npmCacheDir = resolveWeixinInstallerNpmCacheDir()
  const isolatedNpmCache = await createIsolatedNpmCacheEnv(npmCacheDir)

  const beforeAccountIds = await collectAccountIds().catch(() => [])
  const sessionId = randomUUID()
  const proc = spawn(WEIXIN_INSTALLER_COMMAND[0], WEIXIN_INSTALLER_COMMAND.slice(1), {
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

  activeSession = {
    id: sessionId,
    process: proc,
    phase: 'running',
    output: '',
    code: null,
    ok: false,
    canceled: false,
    command: [...WEIXIN_INSTALLER_COMMAND],
    beforeAccountIds,
    afterAccountIds: [],
    newAccountIds: [],
    npmCacheDir: isolatedNpmCache.cacheDir,
  }
  setActiveProcess(proc, WEIXIN_INSTALLER_CONTROL_DOMAIN)

  emit({
    sessionId,
    type: 'started',
    phase: 'running',
    command: [...WEIXIN_INSTALLER_COMMAND],
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
