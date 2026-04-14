import { describe, expect, it } from 'vitest'

const { readFile } = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

function extractCheckOpenClawSource(cliSource: string): string {
  const start = cliSource.indexOf('export async function checkOpenClaw(): Promise<OpenClawCheckResult> {')
  const end = cliSource.indexOf('export async function installOpenClaw(): Promise<CliResult> {', start)
  if (start < 0 || end < 0) {
    throw new Error('checkOpenClaw source block not found')
  }
  return cliSource.slice(start, end)
}

function extractDiscoverWindowsActiveRuntimeSnapshotSource(cliSource: string): string {
  const start = cliSource.indexOf('async function discoverWindowsActiveRuntimeSnapshot(): Promise<WindowsActiveRuntimeSnapshot | null> {')
  const end = cliSource.indexOf('async function ensureSelectedWindowsActiveRuntimeSnapshot(): Promise<WindowsActiveRuntimeSnapshot | null> {', start)
  if (start < 0 || end < 0) {
    throw new Error('discoverWindowsActiveRuntimeSnapshot source block not found')
  }
  return cliSource.slice(start, end)
}

function extractInspectSelectedRuntimeCompletenessSource(cliSource: string): string {
  const start = cliSource.indexOf('async function inspectSelectedWindowsOpenClawRuntimeCompleteness(): Promise<boolean> {')
  const end = cliSource.indexOf('async function resolveSelectedWindowsNodeExecutablePath(): Promise<string> {', start)
  if (start < 0 || end < 0) {
    throw new Error('inspectSelectedWindowsOpenClawRuntimeCompleteness source block not found')
  }
  return cliSource.slice(start, end)
}

function extractDiscoverOpenClawForEnvCheckSource(cliSource: string): string {
  const start = cliSource.indexOf('export async function discoverOpenClawForEnvCheck(): Promise<OpenClawDiscoveryResult> {')
  const end = cliSource.indexOf('export async function installOpenClaw(): Promise<CliResult> {', start)
  if (start < 0 || end < 0) {
    throw new Error('discoverOpenClawForEnvCheck source block not found')
  }
  return cliSource.slice(start, end)
}

function extractRunCliStreamingOnceSource(cliSource: string): string {
  const start = cliSource.indexOf('async function runCliStreamingOnce(args: string[], options: RunCliStreamOptions = {}): Promise<CliResult> {')
  const end = cliSource.indexOf('export async function runCliStreaming(args: string[], options: RunCliStreamOptions = {}): Promise<CliResult> {', start)
  if (start < 0 || end < 0) {
    throw new Error('runCliStreamingOnce source block not found')
  }
  return cliSource.slice(start, end)
}

function extractIsReadOnlyCommandSource(cliSource: string): string {
  const start = cliSource.indexOf('function isReadOnlyCommand(controlDomain: CommandControlDomain, args: string[]): boolean {')
  const end = cliSource.indexOf('export async function runCliWithBinary(', start)
  if (start < 0 || end < 0) {
    throw new Error('isReadOnlyCommand source block not found')
  }
  return cliSource.slice(start, end)
}

function extractEnsureOpenClawConfigRepairPreflightSource(cliSource: string): string {
  const start = cliSource.indexOf('async function ensureOpenClawConfigRepairPreflight(): Promise<void> {')
  const end = cliSource.indexOf('export interface CliResult {', start)
  if (start < 0 || end < 0) {
    throw new Error('ensureOpenClawConfigRepairPreflight source block not found')
  }
  return cliSource.slice(start, end)
}

function extractGatewayHealthSource(cliSource: string): string {
  const start = cliSource.indexOf('export async function gatewayHealth(): Promise<GatewayHealthCheckResult> {')
  const end = cliSource.indexOf('export async function gatewayStart(', start)
  if (start < 0 || end < 0) {
    throw new Error('gatewayHealth source block not found')
  }
  return cliSource.slice(start, end)
}

function extractReadConfigSource(cliSource: string): string {
  const start = cliSource.indexOf('export async function readConfig(')
  const end = cliSource.indexOf('export async function writeConfig(config: Record<string, any>): Promise<void> {', start)
  if (start < 0 || end < 0) {
    throw new Error('readConfig source block not found')
  }
  return cliSource.slice(start, end)
}

function extractGatewayStartSource(cliSource: string): string {
  const start = cliSource.indexOf('export async function gatewayStart(')
  const end = cliSource.indexOf('// Singleflight lock to prevent concurrent restart operations', start)
  if (start < 0 || end < 0) {
    throw new Error('gatewayStart source block not found')
  }
  return cliSource.slice(start, end)
}

function extractIsPluginInstalledOnDiskSource(cliSource: string): string {
  const start = cliSource.indexOf('export async function isPluginInstalledOnDisk(pluginId: string): Promise<boolean> {')
  const end = cliSource.indexOf('/** Add a channel via CLI: openclaw channels add --channel <name> --token <token> */', start)
  if (start < 0 || end < 0) {
    throw new Error('isPluginInstalledOnDisk source block not found')
  }
  return cliSource.slice(start, end)
}

function extractGatewayRestartImplSource(cliSource: string): string {
  const start = cliSource.indexOf('async function gatewayRestartImpl(): Promise<CliResult> {')
  const end = cliSource.indexOf('export async function gatewayRestart(): Promise<CliResult> {', start)
  if (start < 0 || end < 0) {
    throw new Error('gatewayRestartImpl source block not found')
  }
  return cliSource.slice(start, end)
}

function extractPairingApproveSource(cliSource: string): string {
  const start = cliSource.indexOf('export async function pairingApprove(')
  const end = cliSource.indexOf('function sanitizeStoreKey(input: string): string {', start)
  if (start < 0 || end < 0) {
    throw new Error('pairingApprove source block not found')
  }
  return cliSource.slice(start, end)
}

describe('checkOpenClaw selected runtime completeness gate', () => {
  it('verifies the selected Windows runtime is complete before trusting a runnable openclaw command', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const checkOpenClawSource = extractCheckOpenClawSource(cliSource)
    const completenessSource = extractInspectSelectedRuntimeCompletenessSource(cliSource)

    expect(checkOpenClawSource).toContain('inspectSelectedWindowsOpenClawRuntimeCompleteness()')
    expect(checkOpenClawSource.indexOf('inspectSelectedWindowsOpenClawRuntimeCompleteness()')).toBeLessThan(
      checkOpenClawSource.indexOf("runCli(['--version']")
    )
    expect(checkOpenClawSource).toContain('selectedRuntimeComplete')
    expect(checkOpenClawSource).toContain('activeRuntimeSnapshot: selectedRuntimeSnapshot || undefined')
    expect(completenessSource).not.toContain('ensureSelectedWindowsActiveRuntimeSnapshot()')
  })

  it('skips plugin repair preflight for the lightweight openclaw version probe', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const checkOpenClawSource = extractCheckOpenClawSource(cliSource)

    expect(checkOpenClawSource).toContain('skipConfigRepairPreflight: true')
  })

  it('selects the Windows node executable before falling back to whole-machine OpenClaw discovery', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const discoverSource = extractDiscoverWindowsActiveRuntimeSnapshotSource(cliSource)

    const selectedNodeIndex = discoverSource.indexOf('const nodeExecutable = await resolveSelectedWindowsNodeExecutablePath()')
    const installationDiscoveryIndex = discoverSource.indexOf('const discovery = await discoverOpenClawInstallations().catch(() => null)')

    expect(selectedNodeIndex).toBeGreaterThan(-1)
    expect(installationDiscoveryIndex).toBeGreaterThan(-1)
    expect(selectedNodeIndex).toBeLessThan(installationDiscoveryIndex)
  })

  it('only switches Windows runtime selection to a prepared managed candidate when the discovered install is blocking', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const discoverSource = extractDiscoverWindowsActiveRuntimeSnapshotSource(cliSource)

    expect(cliSource).toContain('function shouldSwitchWindowsRuntimeToManagedCandidate(')
    expect(cliSource).toContain('prepareManagedWindowsRuntimeSnapshotFromExistingRuntime(')
    expect(cliSource).toContain('resolveOpenClawVersionEnforcement({')
    expect(discoverSource).toContain('const activeDiscoveryCandidate = resolveDiscoveryActiveCandidate(discovery)')
    expect(discoverSource).toContain('const shouldSwitchToManaged = shouldSwitchWindowsRuntimeToManagedCandidate(activeDiscoveryCandidate)')
    expect(discoverSource).toContain('if (!shouldSwitchToManaged) {')
    expect(discoverSource).toContain('const preparedManagedRuntimeSnapshot = await prepareManagedWindowsRuntimeSnapshotFromExistingRuntime({')
    expect(discoverSource).toContain('return preparedManagedRuntimeSnapshot')
    expect(discoverSource.indexOf('if (!shouldSwitchToManaged) {')).toBeLessThan(
      discoverSource.indexOf('const preparedManagedRuntimeSnapshot = await prepareManagedWindowsRuntimeSnapshotFromExistingRuntime({')
    )
  })

  it('records managed runtime preparation and final selection diagnostics for env-check troubleshooting', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const discoverSource = extractDiscoverWindowsActiveRuntimeSnapshotSource(cliSource)

    expect(cliSource).toContain("appendEnvCheckDiagnostic('main-windows-runtime-preparing-managed-runtime'")
    expect(cliSource).toContain("appendEnvCheckDiagnostic('main-windows-runtime-verifying-managed-runtime'")
    expect(cliSource).toContain("probeVersion: async (binaryPath: string) => {")
    expect(cliSource).toContain("runCliWithBinary(")
    expect(cliSource).toContain("['--version']")
    expect(cliSource).toContain("MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs")
    expect(discoverSource).toContain("appendEnvCheckDiagnostic('main-windows-runtime-selection-decision'")
    expect(discoverSource).toContain("appendEnvCheckDiagnostic('main-windows-runtime-selection-result'")
    expect(discoverSource).toContain('activeCandidateSource: activeDiscoveryCandidate?.installSource || null')
    expect(discoverSource).toContain("reason: 'managed-runtime-prepare-failed'")
  })

  it('keeps env-check discovery on the selected runtime instead of whole-machine discovery on Windows', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const discoverSource = extractDiscoverOpenClawForEnvCheckSource(cliSource)

    expect(discoverSource).toContain('resolveSelectedWindowsOpenClawRuntimeSnapshot()')
    expect(discoverSource).toContain('const commandProbeEnv = buildCommandCapabilityEnv(selectedRuntimeSnapshot || null)')
    expect(discoverSource).toContain('resolveOpenClawBinaryPath({')
    expect(discoverSource).toContain('env: commandProbeEnv')
    expect(discoverSource).toContain('discoverOpenClawInstallationsFromKnownPaths({')
    expect(discoverSource).toContain('activeBinaryPath: resolvedOpenClawPath || null')
    expect(discoverSource).toContain('knownPaths: [selectedOpenClawPath, resolvedOpenClawPath]')
    expect(discoverSource).toContain("if (process.platform !== 'win32')")
    expect(discoverSource).toContain('return discoverOpenClawInstallations()')
  })

  it('attaches Windows gateway owner integrity to env-check discovery without triggering lifecycle side effects', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const discoverSource = extractDiscoverOpenClawForEnvCheckSource(cliSource)

    expect(discoverSource).toContain('inspectWindowsGatewayLauncherIntegrity')
    expect(discoverSource).toContain('windowsGatewayOwnerState:')
    expect(discoverSource).not.toContain('ensureGatewayRunning')
    expect(discoverSource).not.toContain("['gateway', 'install', '--force']")
  })

  it('reuses the already selected runtime when reading env data for lightweight CLI probes', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const runCliStreamingOnceSource = extractRunCliStreamingOnceSource(cliSource)

    expect(runCliStreamingOnceSource).toContain('const activeRuntimeSnapshot =')
    expect(runCliStreamingOnceSource).toContain('const envFromFile = await readEnvFile({')
    expect(runCliStreamingOnceSource).toContain('activeRuntimeSnapshot: activeRuntimeSnapshot || undefined')
    expect(runCliStreamingOnceSource.indexOf('const activeRuntimeSnapshot =')).toBeLessThan(
      runCliStreamingOnceSource.indexOf('const envFromFile = await readEnvFile({')
    )
  })

  it('hides Windows console windows for streamed CLI child processes', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const runCliStreamingOnceSource = extractRunCliStreamingOnceSource(cliSource)

    expect(runCliStreamingOnceSource).toContain("windowsHide: process.platform === 'win32'")
  })

  it('only runs config repair preflight when a command explicitly opts in', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const runCliStreamingOnceSource = extractRunCliStreamingOnceSource(cliSource)

    expect(runCliStreamingOnceSource).toContain('if (options.requireConfigRepairPreflight && !options.skipConfigRepairPreflight)')
  })

  it('clears the cached config repair preflight promise after each attempt', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const preflightSource = extractEnsureOpenClawConfigRepairPreflightSource(cliSource)

    expect(preflightSource).toContain('preferredHomeDir')
    expect(preflightSource).toContain("appendEnvCheckDiagnostic('main-config-preflight-start'")
    expect(preflightSource).toContain("appendEnvCheckDiagnostic('main-config-preflight-step-home-dir-start'")
    expect(preflightSource).toContain("appendEnvCheckDiagnostic('main-config-preflight-step-repair-start'")
    expect(preflightSource).toContain("appendEnvCheckDiagnostic('main-config-preflight-result'")
    expect(preflightSource).toContain('} finally {')
    expect(preflightSource).toContain('openClawConfigRepairPreflightPromise = null')
  })

  it('keeps gateway health read-only while gateway start and restart explicitly opt into config repair preflight', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const gatewayHealthSource = extractGatewayHealthSource(cliSource)
    const gatewayStartSource = extractGatewayStartSource(cliSource)
    const gatewayRestartImplSource = extractGatewayRestartImplSource(cliSource)
    const runCliStreamingOnceSource = extractRunCliStreamingOnceSource(cliSource)

    expect(gatewayHealthSource).not.toContain('requireConfigRepairPreflight: true')
    expect(gatewayHealthSource).toContain('skipPermissionAutoRepair: true')
    expect(gatewayHealthSource).toContain("appendEnvCheckDiagnostic('main-gateway-health-start'")
    expect(gatewayHealthSource).toContain("appendEnvCheckDiagnostic('main-gateway-health-result'")
    expect(gatewayStartSource).toContain('options.activeRuntimeSnapshot || await resolveWindowsActiveRuntimeSnapshotForRead()')
    expect(gatewayStartSource).toContain('activeRuntimeSnapshot: activeRuntimeSnapshot || undefined')
    expect(gatewayStartSource).toContain("appendEnvCheckDiagnostic('main-gateway-start-runtime-snapshot'")
    expect(gatewayStartSource).toContain('resolveGatewayMutationPreflightHomeDir()')
    expect(gatewayStartSource).toContain('configRepairPreflightHomeDir')
    expect(gatewayStartSource).toContain('requireConfigRepairPreflight: true')
    expect(gatewayRestartImplSource).toContain('requireConfigRepairPreflight: true')
    expect(gatewayRestartImplSource).toContain('activeRuntimeSnapshot: activeRuntimeSnapshot || undefined')
    expect(gatewayRestartImplSource).toContain('configRepairPreflightHomeDir')
    expect(runCliStreamingOnceSource).toContain("const isGatewayHealthProbe = controlDomain === 'gateway' && args[0] === 'health' && args[1] === '--json'")
    expect(runCliStreamingOnceSource).toContain("appendEnvCheckDiagnostic('main-gateway-health-run-cli-enter'")
    expect(runCliStreamingOnceSource).toContain("appendEnvCheckDiagnostic('main-gateway-health-run-cli-before-read-env-file'")
    expect(runCliStreamingOnceSource).toContain("appendEnvCheckDiagnostic('main-gateway-health-run-cli-after-read-env-file'")
    expect(runCliStreamingOnceSource).toContain("appendEnvCheckDiagnostic('main-gateway-health-run-cli-before-spawn'")
    expect(runCliStreamingOnceSource).toContain("appendEnvCheckDiagnostic('main-gateway-health-run-cli-close'")
    expect(runCliStreamingOnceSource).toContain("appendEnvCheckDiagnostic('main-gateway-start-run-cli-runtime-snapshot'")
  })

  it('lets commands explicitly bypass permission auto-repair and sends gateway health down that read-only path', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const runCliStreamingOnceSource = extractRunCliStreamingOnceSource(cliSource)
    const gatewayHealthSource = extractGatewayHealthSource(cliSource)
    const isReadOnlyCommandSource = extractIsReadOnlyCommandSource(cliSource)

    expect(cliSource).toContain('skipPermissionAutoRepair?: boolean')
    expect(cliSource).toContain('skipPermissionAutoRepair: options.skipPermissionAutoRepair')
    expect(cliSource).toContain('configRepairPreflightHomeDir?: string | null')
    expect(cliSource).toContain('if (options.skipPermissionAutoRepair || readOnlyCommand)')
    expect(isReadOnlyCommandSource).toContain("(args[0] === 'plugins' && args[1] === 'list' && args.includes('--json'))")
    expect(runCliStreamingOnceSource).toContain("appendEnvCheckDiagnostic('main-gateway-health-run-cli-command-resolved'")
    expect(gatewayHealthSource).toContain('skipPermissionAutoRepair: true')
  })

  it('treats generic help/version probes as read-only and bypasses permission auto-repair for them', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const isReadOnlyCommandSource = extractIsReadOnlyCommandSource(cliSource)

    expect(isReadOnlyCommandSource).toContain("args.length === 1 && args[0] === '--version'")
    expect(isReadOnlyCommandSource).toContain("lastArg === '--help'")
    expect(cliSource).toContain('const readOnlyCommand = isReadOnlyCommand(controlDomain, args)')
    expect(cliSource).toContain('if (options.skipPermissionAutoRepair || readOnlyCommand)')
  })

  it('routes gateway health and gateway status through the Windows read-only runtime helper while keeping mutation commands on ensure/reconcile', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const gatewayHealthSource = extractGatewayHealthSource(cliSource)

    expect(cliSource).toContain("from './openclaw-runtime-readonly'")
    expect(cliSource).toContain('resolveOpenClawPathsForRead(')
    expect(gatewayHealthSource).toContain('skipPermissionAutoRepair: true')
    expect(gatewayHealthSource).toContain('skipConfigRepairPreflight: true')
    expect(cliSource).toContain("runCli(['gateway', 'start']")
    expect(cliSource).toContain('requireConfigRepairPreflight: true')
    expect(cliSource).toContain('ensureSelectedWindowsActiveRuntimeSnapshot()')
  })

  it('lets the read-only runtime helper fall back to the selected private runtime without committing cached state', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')

    expect(cliSource).toContain('async function resolveWindowsActiveRuntimeSnapshotForRead(')
    expect(cliSource).toContain('const cachedRuntimeSnapshot = getCurrentWindowsActiveRuntimeSnapshot()')
    expect(cliSource).toContain('return resolveSelectedWindowsOpenClawRuntimeSnapshot()')
  })

  it('keeps read-only config/env/path queries on the read-only runtime path', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const ipcSource = await readFile(path.join(process.cwd(), 'electron/main/ipc-handlers.ts'), 'utf8')
    const readConfigSource = extractReadConfigSource(cliSource)
    const isPluginInstalledOnDiskSource = extractIsPluginInstalledOnDiskSource(cliSource)

    expect(cliSource).toContain('export async function getOpenClawPathsForRead(')
    expect(cliSource).toContain('createPermissionAutoRepairDependencies({ readOnlyPaths: true })')
    expect(cliSource).toContain(': await getOpenClawPathsForRead()')
    expect(ipcSource).toContain("ipcMain.handle('paths:openclaw:get', () => getOpenClawPathsForRead())")
    expect(readConfigSource).toContain('options.configPath')
    expect(readConfigSource).toContain('const requestedConfigPath = String(options.configPath || \'\').trim()')
    expect(readConfigSource).toContain('const configFile = requestedConfigPath')
    expect(readConfigSource).toContain('const openClawPaths = requestedConfigPath ? null : await getOpenClawPathsForRead()')
    expect(cliSource).toContain('async function resolveAllowFromStorePaths(')
    expect(cliSource).toContain('options: { readOnly?: boolean } = {}')
    expect(cliSource).toContain('? await getOpenClawPathsForRead()')
    expect(cliSource).toContain('readOnly: true,')
    expect(isPluginInstalledOnDiskSource).toContain('await getOpenClawPathsForRead().catch(() => null)')
    expect(isPluginInstalledOnDiskSource).not.toContain('await getOpenClawPaths().catch(() => null)')
  })

  it('records pairing approval diagnostics with masked input and raw command results', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const pairingApproveSource = extractPairingApproveSource(cliSource)

    expect(pairingApproveSource).toContain("appendEnvCheckDiagnostic('main-pairing-approve-start'")
    expect(pairingApproveSource).toContain("appendEnvCheckDiagnostic('main-pairing-approve-result'")
    expect(pairingApproveSource).toContain("appendEnvCheckDiagnostic('main-pairing-approve-failed'")
    expect(pairingApproveSource).toContain('maskedCode')
    expect(pairingApproveSource).toContain('truncatePairingApproveDiagnosticText(result.stdout.trim() || null)')
    expect(pairingApproveSource).toContain('truncatePairingApproveDiagnosticText(result.stderr.trim() || null)')
    expect(pairingApproveSource).toContain('canceled: result.canceled === true')
    expect(pairingApproveSource).toContain("const errorCode = result.ok ? null : resolvePairingApproveErrorCode(result) || 'unknown'")
  })

  it('does not apply a dedicated CLI timeout to pairing approval commands', async () => {
    const cliSource = await readFile(path.join(process.cwd(), 'electron/main/cli.ts'), 'utf8')
    const pairingApproveSource = extractPairingApproveSource(cliSource)

    expect(pairingApproveSource).toContain("timeoutMs: null")
    expect(pairingApproveSource).toContain('undefined,')
    expect(pairingApproveSource).toContain("'config-write'")
    expect(pairingApproveSource).not.toContain('MAIN_RUNTIME_POLICY.cli.pairingApproveTimeoutMs')
  })
})
