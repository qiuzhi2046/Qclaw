import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const source = fs.readFileSync(
  path.join(process.cwd(), 'electron/main/feishu-installer-session.ts'),
  'utf8'
)

describe('feishu installer session source', () => {
  it('runs Feishu preflight before stopping gateway or spawning the installer', () => {
    const startSessionIndex = source.indexOf('export async function startFeishuInstallerSession')
    const findInStartSession = (needle: string) => source.indexOf(needle, startSessionIndex)
    const capabilityIndex = findInStartSession("probePlatformCommandCapability('npx'")
    const runtimeSnapshotIndex = findInStartSession('resolveFeishuInstallerRuntimeSnapshotPureFailure()')
    const busyIndex = findInStartSession('isManagedOperationLockBusy(FEISHU_MANAGED_CHANNEL_LOCK_KEY)')
    const lockIndex = findInStartSession('tryAcquireManagedOperationLease(FEISHU_MANAGED_CHANNEL_LOCK_KEY)')
    const preflightIndex = findInStartSession('const preflightResult = await runFeishuInstallerPreflight(runtimeSnapshotCheck.snapshot)')
    const preflightFailureIndex = findInStartSession('if (!preflightResult.ok)')
    const stopGatewayIndex = findInStartSession("stopGatewayForInstaller('feishu-installer-start')")
    const spawnIndex = findInStartSession('spawn(commandResolution.command[0]')
    const activeSessionIndex = findInStartSession('activeSession = {')

    expect(startSessionIndex).toBeGreaterThan(-1)
    expect(capabilityIndex).toBeGreaterThan(-1)
    expect(runtimeSnapshotIndex).toBeGreaterThan(-1)
    expect(busyIndex).toBeGreaterThan(-1)
    expect(lockIndex).toBeGreaterThan(-1)
    expect(preflightIndex).toBeGreaterThan(-1)
    expect(preflightFailureIndex).toBeGreaterThan(-1)
    expect(stopGatewayIndex).toBeGreaterThan(-1)
    expect(spawnIndex).toBeGreaterThan(-1)
    expect(activeSessionIndex).toBeGreaterThan(-1)
    expect(busyIndex).toBeLessThan(runtimeSnapshotIndex)
    expect(busyIndex).toBeLessThan(lockIndex)
    expect(runtimeSnapshotIndex).toBeLessThan(capabilityIndex)
    expect(capabilityIndex).toBeLessThan(lockIndex)
    expect(runtimeSnapshotIndex).toBeLessThan(lockIndex)
    expect(lockIndex).toBeLessThan(preflightIndex)
    expect(preflightFailureIndex).toBeLessThan(stopGatewayIndex)
    expect(preflightIndex).toBeLessThan(stopGatewayIndex)
    expect(stopGatewayIndex).toBeLessThan(spawnIndex)
    expect(preflightIndex).toBeLessThan(activeSessionIndex)
  })

  it('uses the Windows channel-preflight runtime context for Feishu official sync', () => {
    expect(source).toContain('resolveWindowsActiveRuntimeSnapshotForRead')
    expect(source).toContain('activeRuntimeSnapshot: runtimeSnapshotCheck.snapshot || undefined')
    expect(source).toContain("caller: 'channel-preflight'")
    expect(source).toContain('resolveWindowsChannelRuntimeContext')
    expect(source).toContain('snapshot: activeRuntimeSnapshot')
    expect(source).toContain('ensureFeishuOfficialPluginReady({')
    expect(source).toContain('runtimeContext: runtimeContextResult.runtimeContext')
    expect(source).toContain('runtimeContext: preflightResult.runtimeContext')
    expect(source).toContain("stopGatewayForInstaller('feishu-installer-start')")
  })

  it('recovers only the gateway snapshot stopped for the Feishu installer on terminal paths', () => {
    expect(source).toContain('gatewayStopSnapshot: stopGatewayResult.snapshot')
    expect(source).toContain('gatewayStoppedForInstall: stopGatewayResult.stopped')
    expect(source).toContain("recoverGatewayForSession(session, 'feishu-installer-close')")
    expect(source).toContain("recoverGatewayForSession(session, 'feishu-installer-error')")
    expect(source).toContain('runGatewayRecoveryWithTimeout')
    expect(source).toContain('stopGatewayResult.snapshot')
    expect(source).toContain("'feishu-installer-start-failed'")
    expect(source).toContain("recoverGatewayForSession(session, 'feishu-installer-stop'")
  })

  it('surfaces structured guardrail state in snapshots and events', () => {
    expect(source).toContain('guardrail: ChannelInstallerGuardrailStatus')
    expect(source).toContain('createIdleChannelInstallerGuardrailStatus(FEISHU_MANAGED_CHANNEL_ID)')
    expect(source).toContain('failChannelInstallerGuardrailStatus({')
    expect(source).toContain('mergeChannelInstallerGuardrailStatus(preflightResult.guardrail')
    expect(source).toContain('guardrail: activeSession.guardrail')
    expect(source).toContain('managedOperationLease: operationLease')
    expect(source).toContain('releaseSessionManagedOperationLease(session)')
    expect(source).toContain("lock: {\n        state: 'running',\n        key: FEISHU_MANAGED_CHANNEL_LOCK_KEY")
    expect(source).toContain('gateway: {')
    expect(source).toContain('finalSync: {')
  })

  it('captures installer auth results for auto-pairing the scanned bot owner', () => {
    expect(source).toContain("type: 'auth-result'")
    expect(source).toContain('authResults: [...activeSession.authResults]')
    expect(source).toContain('recordFeishuInstallerAuthResult(activeSession, payload)')
  })

  it('does not attach a fixed timeout to the interactive installer process', () => {
    expect(source).toContain('spawn(commandResolution.command[0]')
    expect(source).not.toContain('timeout: MAIN_RUNTIME_POLICY.cli.pluginInstallNpxTimeoutMs')
  })
})
