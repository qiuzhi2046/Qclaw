import type { GatewayPortOwner } from '../../../../src/shared/gateway-runtime-state'
import type { WindowsGatewayOwnerSnapshot } from './windows-channel-runtime-snapshot'
import { runShell, type CliResult } from '../../cli'
import { MAIN_RUNTIME_POLICY } from '../../runtime-policy'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')

interface RunShellLike {
  (
    command: string,
    args: string[],
    timeout?: number,
    options?: Parameters<typeof runShell>[3]
  ): Promise<CliResult>
}

interface ProbeWindowsPortOwnerDependencies {
  runShell?: RunShellLike
}

interface InspectWindowsGatewayLauncherIntegrityDependencies {
  appDataDir?: string
  fileExists?: (targetPath: string) => boolean | Promise<boolean>
  homeDir: string
  readFile?: (targetPath: string) => string | Promise<string>
  runShell?: RunShellLike
}

interface CleanupWindowsGatewayStartupLauncherDependencies
  extends InspectWindowsGatewayLauncherIntegrityDependencies {
  launcherIntegrity?: WindowsGatewayLauncherIntegrity | null
  unlinkFile?: (targetPath: string) => Promise<void>
}

interface EnsureWindowsStartupLauncherHiddenDependencies {
  appDataDir?: string
  fileExists?: (targetPath: string) => boolean | Promise<boolean>
  homeDir: string
  launcherIntegrity?: WindowsGatewayLauncherIntegrity | null
  readFile?: (targetPath: string) => string | Promise<string>
  writeFile?: (targetPath: string, content: string) => Promise<void>
}

interface EnsureWindowsStartupLauncherHiddenResult {
  changed: boolean
  reason: 'already-hidden' | 'launcher-missing' | 'missing' | 'patched' | 'unmanaged'
  launcherPath: string | null
  startupEntryPath: string | null
}

export interface WindowsGatewayLauncherIntegrity {
  launcherPath: string | null
  shouldReinstallService: boolean
  status: 'healthy' | 'launcher-missing' | 'service-missing' | 'unknown'
  taskName: string | null
}

interface WindowsGatewayPreflightInput {
  gatewayOwner?: WindowsGatewayOwnerSnapshot | null
  launcherIntegrity?: WindowsGatewayLauncherIntegrity | null
  portOwner?: GatewayPortOwner | null
}

interface WindowsGatewayPreflight {
  shouldAttachToExistingOwner: boolean
  shouldAttemptPortRecovery: boolean
  shouldReinstallService: boolean
}

interface WindowsListeningPortRecord {
  LocalAddress?: string
  LocalPort?: number | string
  OwningProcess?: number | string
  State?: string
}

interface WindowsProcessInfoRecord {
  CommandLine?: string | null
  Name?: string | null
}

type WindowsStartupLauncherMode = 'hidden-powershell' | 'legacy-minimized-cmd' | 'unknown'

interface WindowsStartupLauncherClassification {
  managed: boolean
  mode: WindowsStartupLauncherMode
}

const WINDOWS_HIDDEN_STARTUP_LAUNCHER_MARKER =
  'rem qclaw patched: keep startup fallback compatible while hiding the long-lived shell window.'

function extractScheduledTaskField(stdout: string, fieldName: string): string | null {
  const pattern = new RegExp(`^${fieldName}:\\s*(.+)$`, 'im')
  const match = String(stdout || '').match(pattern)
  return match?.[1]?.trim() || null
}

function extractLauncherPath(taskToRun: string | null): string | null {
  const trimmed = String(taskToRun || '').trim()
  if (!trimmed) return null

  const quotedMatch = trimmed.match(/^"([^"]+)"/)
  if (quotedMatch?.[1]) return quotedMatch[1]

  const pathMatch = trimmed.match(/^[A-Za-z]:\\.+?\.(?:bat|cmd|exe|mjs|ps1)\b/i)
  return pathMatch?.[0] || null
}

async function defaultFileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function defaultReadFile(targetPath: string): Promise<string> {
  return fs.promises.readFile(targetPath, 'utf8')
}

async function defaultWriteFile(targetPath: string, content: string): Promise<void> {
  await fs.promises.writeFile(targetPath, content, 'utf8')
}

async function defaultUnlinkFile(targetPath: string): Promise<void> {
  await fs.promises.unlink(targetPath)
}

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replace(/'/g, "''")
}

function escapeBatchPercent(value: string): string {
  return value.replace(/%/g, '%%')
}

function normalizeBatchEscapesForComparison(value: string): string {
  return value.replace(/%%/g, '%')
}

function normalizeWindowsLauncherPath(value: string | null | undefined): string {
  return normalizeBatchEscapesForComparison(String(value || '').trim()).toLowerCase()
}

function extractManagedWindowsStartupLauncherCommand(scriptContent: string): string | null {
  const commandLines = String(scriptContent || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^@echo\s+off$/i.test(line))
    .filter((line) => !/^rem\s+/i.test(line))

  if (commandLines.length !== 1) return null
  return commandLines[0] || null
}

function extractHiddenWindowsStartupLauncherTarget(scriptContent: string): string | null {
  const lines = String(scriptContent || '').split(/\r?\n/)
  for (const line of lines) {
    const match = line.match(/^\s*rem\s+QClaw startup launcher target:\s*(.+?)\s*$/i)
    if (match?.[1]) return match[1].trim()
  }
  return null
}

function extractWindowsStartupLauncherDescription(scriptContent: string): string | null {
  const lines = String(scriptContent || '').split(/\r?\n/)
  for (const line of lines) {
    const match = line.match(/^\s*rem\s+(.+?)\s*$/i)
    if (match?.[1]) return match[1].trim()
  }
  return null
}

function buildHiddenWindowsStartupLauncherTargetMarker(scriptPath: string): string {
  return `rem QClaw startup launcher target: ${scriptPath}`
}

function quoteWindowsBatchScriptPath(scriptPath: string): string {
  return `"${escapeBatchPercent(scriptPath).replace(/"/g, '""')}"`
}

function resolvePortOwnerKind(processName: string, command: string): GatewayPortOwner['kind'] {
  const corpus = `${processName}\n${command}`.toLowerCase()
  if (/\bopenclaw\b/.test(corpus)) return 'openclaw'
  if (/\bgateway\b/.test(corpus)) return 'gateway'
  return 'foreign'
}

function parsePowershellJson<T>(stdout: string): T | null {
  const trimmed = String(stdout || '').trim()
  if (!trimmed || trimmed === 'null') return null
  try {
    return JSON.parse(trimmed) as T
  } catch {
    return null
  }
}

function extractListeningPortRecord(stdout: string, port: number): WindowsListeningPortRecord | null {
  const parsed =
    parsePowershellJson<WindowsListeningPortRecord | WindowsListeningPortRecord[]>(stdout)

  const candidates = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
  for (const candidate of candidates) {
    const localPort =
      typeof candidate.LocalPort === 'number'
        ? candidate.LocalPort
        : Number.parseInt(String(candidate.LocalPort || ''), 10)
    if (localPort === port) return candidate
  }

  return null
}

function extractProcessInfo(stdout: string): { command: string; processName: string } {
  const parsed =
    parsePowershellJson<WindowsProcessInfoRecord | WindowsProcessInfoRecord[]>(stdout)
  const record = Array.isArray(parsed) ? parsed[0] : parsed
  return {
    command: String(record?.CommandLine || '').trim(),
    processName: String(record?.Name || '').trim(),
  }
}

function buildListeningPortCommand(port: number): string {
  return [
    `$connection = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1 OwningProcess,LocalAddress,LocalPort,State`,
    `if ($null -eq $connection) { 'null' } else { $connection | ConvertTo-Json -Compress }`,
  ].join('; ')
}

function buildProcessInfoCommand(pid: number): string {
  return [
    `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue | Select-Object -First 1 Name,CommandLine`,
    `if ($null -eq $process) { 'null' } else { $process | ConvertTo-Json -Compress }`,
  ].join('; ')
}

function resolveWindowsAppDataDir(
  homeDir: string,
  appDataDir?: string
): string {
  const normalizedAppDataDir = String(appDataDir || process.env.APPDATA || '').trim()
  if (normalizedAppDataDir) return normalizedAppDataDir

  const userProfileDir = String(homeDir || '').trim().replace(/[\\\/]\.openclaw$/i, '')
  if (!userProfileDir) return ''
  return `${userProfileDir}\\AppData\\Roaming`
}

function resolveWindowsStartupLauncherPath(
  homeDir: string,
  appDataDir?: string
): string | null {
  const resolvedAppDataDir = resolveWindowsAppDataDir(homeDir, appDataDir)
  if (!resolvedAppDataDir) return null

  return `${resolvedAppDataDir}\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\OpenClaw Gateway.cmd`
}

export async function cleanupWindowsStartupLauncherIfScheduledTaskHealthy(
  dependencies: CleanupWindowsGatewayStartupLauncherDependencies
): Promise<boolean> {
  const startupLauncherPath = resolveWindowsStartupLauncherPath(
    dependencies.homeDir,
    dependencies.appDataDir
  )
  if (!startupLauncherPath) return false

  const fileExists = dependencies.fileExists || defaultFileExists
  if (!(await fileExists(startupLauncherPath))) return false

  const launcherIntegrity =
    dependencies.launcherIntegrity || await inspectWindowsGatewayLauncherIntegrity(dependencies)
  if (launcherIntegrity.status !== 'healthy' || !launcherIntegrity.taskName) return false

  const unlinkFile = dependencies.unlinkFile || defaultUnlinkFile
  await unlinkFile(startupLauncherPath)
  return true
}

function extractStartupLauncherPath(scriptContent: string): string | null {
  const matches = String(scriptContent || '').match(/[A-Za-z]:\\[^"\r\n]+?\.(?:bat|cmd|exe|mjs|ps1)\b/gi)
  if (!matches?.length) return null
  return matches[matches.length - 1]?.trim() || null
}

export function classifyWindowsStartupLauncherScript(
  scriptContent: string,
  expectedLauncherPath: string
): WindowsStartupLauncherClassification {
  const command = extractManagedWindowsStartupLauncherCommand(scriptContent)
  if (!command) {
    return { managed: false, mode: 'unknown' }
  }

  const normalizedExpectedLauncherPath = normalizeWindowsLauncherPath(expectedLauncherPath)
  if (!normalizedExpectedLauncherPath) {
    return { managed: false, mode: 'unknown' }
  }

  const normalizedCommand = normalizeBatchEscapesForComparison(command).toLowerCase()
  const commandLauncherPath = normalizeWindowsLauncherPath(
    extractStartupLauncherPath(normalizeBatchEscapesForComparison(command))
  )
  const hiddenTargetLauncherPath = normalizeWindowsLauncherPath(
    extractHiddenWindowsStartupLauncherTarget(scriptContent)
  )

  if (
    hiddenTargetLauncherPath === normalizedExpectedLauncherPath &&
    commandLauncherPath === normalizedExpectedLauncherPath &&
    normalizedCommand.includes('%systemroot%\\system32\\windowspowershell\\v1.0\\powershell.exe') &&
    normalizedCommand.includes('start-process -filepath') &&
    normalizedCommand.includes('|| start "" /min cmd.exe /d /c') &&
    String(scriptContent || '').toLowerCase().includes(WINDOWS_HIDDEN_STARTUP_LAUNCHER_MARKER)
  ) {
    return { managed: true, mode: 'hidden-powershell' }
  }

  if (
    commandLauncherPath === normalizedExpectedLauncherPath &&
    normalizedCommand.startsWith('start "" /min cmd.exe /d /c')
  ) {
    return { managed: true, mode: 'legacy-minimized-cmd' }
  }

  return { managed: false, mode: 'unknown' }
}

export function buildHiddenWindowsStartupLauncherScript(params: {
  description?: string
  scriptPath: string
}): string {
  const description = String(params.description || '').trim() || 'OpenClaw Gateway'
  const escapedScriptPath = escapePowerShellSingleQuotedString(escapeBatchPercent(params.scriptPath))
  const fallbackScriptPath = quoteWindowsBatchScriptPath(params.scriptPath)

  return [
    '@echo off',
    `rem ${description}`,
    'rem QClaw patched: keep Startup fallback compatible while hiding the long-lived shell window.',
    `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$scriptPath = '${escapedScriptPath}'; Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/c',$scriptPath -WindowStyle Hidden" || start "" /min cmd.exe /d /c ${fallbackScriptPath}`,
    buildHiddenWindowsStartupLauncherTargetMarker(params.scriptPath),
    '',
  ].join('\r\n')
}

export async function ensureWindowsStartupLauncherHidden(
  dependencies: EnsureWindowsStartupLauncherHiddenDependencies
): Promise<EnsureWindowsStartupLauncherHiddenResult> {
  const startupEntryPath = resolveWindowsStartupLauncherPath(
    dependencies.homeDir,
    dependencies.appDataDir
  )
  if (!startupEntryPath) {
    return { changed: false, reason: 'missing', startupEntryPath: null, launcherPath: null }
  }

  const fileExists = dependencies.fileExists || defaultFileExists
  const readFile = dependencies.readFile || defaultReadFile
  const writeFile = dependencies.writeFile || defaultWriteFile

  if (!(await fileExists(startupEntryPath))) {
    return { changed: false, reason: 'missing', startupEntryPath, launcherPath: null }
  }

  const launcherPath =
    String(dependencies.launcherIntegrity?.launcherPath || '').trim() || `${dependencies.homeDir}\\gateway.cmd`
  if (!(await fileExists(launcherPath))) {
    return { changed: false, reason: 'launcher-missing', startupEntryPath, launcherPath }
  }

  const currentContent = await Promise.resolve(readFile(startupEntryPath)).catch(() => '')
  const classification = classifyWindowsStartupLauncherScript(currentContent, launcherPath)
  if (!classification.managed) {
    return { changed: false, reason: 'unmanaged', startupEntryPath, launcherPath }
  }

  if (classification.mode === 'hidden-powershell') {
    return { changed: false, reason: 'already-hidden', startupEntryPath, launcherPath }
  }

  const description = extractWindowsStartupLauncherDescription(currentContent) || 'OpenClaw Gateway'
  const nextContent = buildHiddenWindowsStartupLauncherScript({
    description,
    scriptPath: launcherPath,
  })
  await writeFile(startupEntryPath, nextContent)

  return { changed: true, reason: 'patched', startupEntryPath, launcherPath }
}

export async function inspectWindowsGatewayLauncherIntegrity(
  dependencies: InspectWindowsGatewayLauncherIntegrityDependencies
): Promise<WindowsGatewayLauncherIntegrity> {
  const runner = dependencies.runShell || runShell
  const fileExists = dependencies.fileExists || defaultFileExists
  const readFile = dependencies.readFile || defaultReadFile
  const queryResult = await runner(
    'schtasks',
    ['/Query', '/TN', 'OpenClaw Gateway', '/V', '/FO', 'LIST'],
    MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs,
    'gateway'
  )

  if (!queryResult.ok) {
    const startupLauncherPath = resolveWindowsStartupLauncherPath(
      dependencies.homeDir,
      dependencies.appDataDir
    )
    if (!startupLauncherPath || !(await fileExists(startupLauncherPath))) {
      return {
        launcherPath: null,
        shouldReinstallService: true,
        status: 'service-missing',
        taskName: null,
      }
    }

    const startupScriptContent = await Promise.resolve(readFile(startupLauncherPath)).catch(() => '')
    const launcherPath = extractStartupLauncherPath(startupScriptContent)
    if (!launcherPath) {
      return {
        launcherPath: null,
        shouldReinstallService: false,
        status: 'unknown',
        taskName: null,
      }
    }

    if (!(await fileExists(launcherPath))) {
      return {
        launcherPath,
        shouldReinstallService: true,
        status: 'launcher-missing',
        taskName: null,
      }
    }

    return {
      launcherPath,
      shouldReinstallService: false,
      status: 'healthy',
      taskName: null,
    }
  }

  const taskName = extractScheduledTaskField(queryResult.stdout, 'TaskName')
  const launcherPath = extractLauncherPath(
    extractScheduledTaskField(queryResult.stdout, 'Task To Run')
  )

  if (!launcherPath) {
    return {
      launcherPath: null,
      shouldReinstallService: false,
      status: 'unknown',
      taskName,
    }
  }

  if (!(await fileExists(launcherPath))) {
    return {
      launcherPath,
      shouldReinstallService: true,
      status: 'launcher-missing',
      taskName,
    }
  }

  return {
    launcherPath,
    shouldReinstallService: false,
    status: 'healthy',
    taskName,
  }
}

export async function probeWindowsPortOwner(
  port: number,
  dependencies: ProbeWindowsPortOwnerDependencies = {}
): Promise<GatewayPortOwner> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return {
      kind: 'unknown',
      port,
      source: 'unknown',
    }
  }

  const runner = dependencies.runShell || runShell
  const portProbe = await runner(
    'powershell',
    ['-NoProfile', '-Command', buildListeningPortCommand(port)],
    MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs,
    'gateway'
  )

  const listeningRecord = extractListeningPortRecord(portProbe.stdout, port)
  if (!listeningRecord) {
    return {
      kind: 'none',
      port,
      source: 'powershell',
    }
  }

  const pid =
    typeof listeningRecord.OwningProcess === 'number'
      ? listeningRecord.OwningProcess
      : Number.parseInt(String(listeningRecord.OwningProcess || ''), 10)

  if (!Number.isFinite(pid) || pid <= 0) {
    return {
      kind: 'unknown',
      port,
      source: 'powershell',
      command: String(portProbe.stdout || '').trim() || undefined,
    }
  }

  const processProbe = await runner(
    'powershell',
    ['-NoProfile', '-Command', buildProcessInfoCommand(pid)],
    MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs,
    'gateway'
  )
  const { command, processName } = extractProcessInfo(processProbe.stdout)

  return {
    kind: resolvePortOwnerKind(processName, command),
    port,
    pid,
    processName: processName || undefined,
    command: command || undefined,
    source: 'powershell',
  }
}

export function buildWindowsGatewayOwnerSnapshotFromLauncherIntegrity(
  launcherIntegrity: WindowsGatewayLauncherIntegrity | null | undefined
): WindowsGatewayOwnerSnapshot {
  const candidate = launcherIntegrity || null
  if (!candidate) {
    return {
      ownerKind: 'unknown',
      ownerLauncherPath: '',
      ownerTaskName: '',
    }
  }

  if (candidate.taskName) {
    return {
      ownerKind: 'scheduled-task',
      ownerLauncherPath: String(candidate.launcherPath || '').trim(),
      ownerTaskName: String(candidate.taskName || '').trim(),
    }
  }

  if (candidate.status === 'service-missing') {
    return {
      ownerKind: 'none',
      ownerLauncherPath: '',
      ownerTaskName: '',
    }
  }

  if (candidate.launcherPath) {
    return {
      ownerKind: 'startup-folder',
      ownerLauncherPath: String(candidate.launcherPath || '').trim(),
      ownerTaskName: '',
    }
  }

  return {
    ownerKind: 'unknown',
    ownerLauncherPath: '',
    ownerTaskName: '',
  }
}

export function buildWindowsGatewayPreflight(
  input: WindowsGatewayPreflightInput
): WindowsGatewayPreflight {
  const owner = input.portOwner
  const gatewayOwner = input.gatewayOwner || null
  const launcherHealthy = input.launcherIntegrity?.status === 'healthy'
  const hasManagedGatewayOwner =
    gatewayOwner?.ownerKind === 'scheduled-task' || gatewayOwner?.ownerKind === 'startup-folder'

  return {
    shouldAttachToExistingOwner: Boolean(
      launcherHealthy &&
      hasManagedGatewayOwner &&
      (!owner || owner.kind === 'none' || owner.kind === 'gateway' || owner.kind === 'openclaw')
    ),
    shouldReinstallService: Boolean(input.launcherIntegrity?.shouldReinstallService),
    shouldAttemptPortRecovery:
      owner?.kind === 'foreign' || owner?.kind === 'gateway' || owner?.kind === 'openclaw',
  }
}
