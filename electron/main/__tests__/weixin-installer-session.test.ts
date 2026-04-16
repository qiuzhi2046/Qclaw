import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('weixin installer session', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'electron', 'main', 'weixin-installer-session.ts'),
    'utf-8'
  )

  it('does not attach a fixed timeout to the interactive personal WeChat installer', () => {
    expect(source).toContain('spawn(WEIXIN_INSTALLER_COMMAND[0]')
    expect(source).not.toContain('timeout: MAIN_RUNTIME_POLICY.cli.pluginInstallNpxTimeoutMs')
  })

  it('runs pure checks and managed preflight before creating npm cache or spawning', () => {
    const startSessionIndex = source.indexOf('export async function startWeixinInstallerSession')
    const findInStartSession = (needle: string) => source.indexOf(needle, startSessionIndex)
    const buildEnvIndex = findInStartSession('commandEnv = buildInstallerCommandEnv({')
    const capabilityIndex = findInStartSession("probePlatformCommandCapability('npx'")
    const runtimeSnapshotIndex = findInStartSession('resolveWeixinInstallerRuntimeSnapshotPureFailure()')
    const busyIndex = findInStartSession('isManagedOperationLockBusy(WEIXIN_MANAGED_CHANNEL_LOCK_KEY)')
    const lockIndex = findInStartSession('tryAcquireManagedOperationLease(WEIXIN_MANAGED_CHANNEL_LOCK_KEY)')
    const preflightIndex = findInStartSession('const preflightResult = await runWeixinInstallerPreflight({')
    const cacheIndex = findInStartSession('createIsolatedNpmCacheEnv(npmCacheDir)')
    const spawnIndex = findInStartSession('spawn(WEIXIN_INSTALLER_COMMAND[0]')
    const activeSessionIndex = findInStartSession('activeSession = {')

    expect(startSessionIndex).toBeGreaterThan(-1)
    expect(buildEnvIndex).toBeGreaterThan(-1)
    expect(capabilityIndex).toBeGreaterThan(-1)
    expect(runtimeSnapshotIndex).toBeGreaterThan(-1)
    expect(busyIndex).toBeGreaterThan(-1)
    expect(lockIndex).toBeGreaterThan(-1)
    expect(preflightIndex).toBeGreaterThan(-1)
    expect(cacheIndex).toBeGreaterThan(-1)
    expect(spawnIndex).toBeGreaterThan(-1)
    expect(activeSessionIndex).toBeGreaterThan(-1)
    expect(busyIndex).toBeLessThan(runtimeSnapshotIndex)
    expect(busyIndex).toBeLessThan(lockIndex)
    expect(runtimeSnapshotIndex).toBeLessThan(buildEnvIndex)
    expect(buildEnvIndex).toBeLessThan(capabilityIndex)
    expect(runtimeSnapshotIndex).toBeLessThan(capabilityIndex)
    expect(runtimeSnapshotIndex).toBeLessThan(lockIndex)
    expect(lockIndex).toBeLessThan(preflightIndex)
    expect(preflightIndex).toBeLessThan(cacheIndex)
    expect(cacheIndex).toBeLessThan(spawnIndex)
    expect(preflightIndex).toBeLessThan(activeSessionIndex)
  })

  it('uses the Windows channel-preflight context for personal Weixin prepare', () => {
    expect(source).toContain('resolveWindowsActiveRuntimeSnapshotForRead')
    expect(source).toContain('activeRuntimeSnapshot: runtimeSnapshotCheck.snapshot')
    expect(source).toContain('activeRuntimeSnapshot: runtimeSnapshotCheck.snapshot || undefined')
    expect(source).toContain("caller: 'channel-preflight'")
    expect(source).toContain('resolveWindowsChannelRuntimeContext')
    expect(source).toContain('snapshot: activeRuntimeSnapshot')
    expect(source).toContain("prepareManagedChannelPluginForSetup(WEIXIN_MANAGED_CHANNEL_ID")
    expect(source).toContain('runtimeContext: runtimeContextResult.runtimeContext')
    expect(source).toContain('assumeOperationLock: options.assumeOperationLock === true')
  })

  it('cleans isolated npm cache when setup fails before an active process is registered', () => {
    expect(source).toContain('let isolatedNpmCache')
    expect(source).toContain('void cleanupIsolatedNpmCacheEnv(isolatedNpmCache.cacheDir)')
    expect(source).toContain('return buildExitedSnapshot({')
  })

  it('surfaces structured guardrail state in snapshots and events', () => {
    expect(source).toContain('guardrail: ChannelInstallerGuardrailStatus')
    expect(source).toContain('createIdleChannelInstallerGuardrailStatus(WEIXIN_MANAGED_CHANNEL_ID)')
    expect(source).toContain('failChannelInstallerGuardrailStatus({')
    expect(source).toContain('mergeChannelInstallerGuardrailStatus(preflightResult.guardrail')
    expect(source).toContain('guardrail: activeSession.guardrail')
    expect(source).toContain('managedOperationLease: operationLease')
    expect(source).toContain('session.managedOperationLease.release()')
    expect(source).toContain("lock: {\n        state: 'running',\n        key: WEIXIN_MANAGED_CHANNEL_LOCK_KEY")
    expect(source).toContain('key: WEIXIN_MANAGED_CHANNEL_LOCK_KEY')
  })
})
