import { describe, expect, it } from 'vitest'

import cliSource from '../cli.ts?raw'

describe('plugin repair API boundaries', () => {
  it('exposes a pure scan path that does not restore managed channels', () => {
    const scanStart = cliSource.indexOf('export async function scanIncompatibleExtensionPlugins(')
    const repairStart = cliSource.indexOf('export async function repairIncompatibleExtensionPlugins(', scanStart)

    expect(scanStart).toBeGreaterThan(-1)
    expect(repairStart).toBeGreaterThan(scanStart)

    const scanBlock = cliSource.slice(scanStart, repairStart)
    expect(scanBlock).not.toContain('restoreConfiguredManagedChannelPlugins')
    expect(scanBlock).not.toContain('restoreConfiguredManagedChannels === true')
    expect(scanBlock).toContain('scanIncompatibleExtensionPluginsOnDisk')
    expect(scanBlock).not.toContain('repairIncompatibleExtensionPluginsOnDisk')
  })

  it('resolves plugin repair paths from readonly runtime state first and then falls back safely', () => {
    const helperStart = cliSource.indexOf('async function resolveOpenClawPluginRepairPaths(): Promise<OpenClawPaths | null> {')
    const homeDirHelperStart = cliSource.indexOf('async function resolveOpenClawPluginRepairHomeDir(): Promise<string | null> {', helperStart)

    expect(helperStart).toBeGreaterThan(-1)
    expect(homeDirHelperStart).toBeGreaterThan(helperStart)

    const helperBlock = cliSource.slice(helperStart, homeDirHelperStart)
    expect(helperBlock).toContain('resolveWindowsActiveRuntimeSnapshotForRead()')
    expect(helperBlock).toContain('readAuthoritativeWindowsChannelRuntimeSnapshot()')
    expect(helperBlock).toContain('getOpenClawPathsForRead(activeRuntimeSnapshot || undefined)')
    expect(helperBlock).toContain('await getOpenClawPaths().catch(() => null)')
    expect(helperBlock).not.toContain('await resolveOpenClawPluginRepairHomeDir()')
  })

  it('keeps startup plugin repair on readonly path resolution before scan', () => {
    const repairStart = cliSource.indexOf('export async function repairIncompatibleExtensionPlugins(')
    const nextFunction = cliSource.indexOf('async function openUrlInSystemBrowser(', repairStart)

    expect(repairStart).toBeGreaterThan(-1)
    expect(nextFunction).toBeGreaterThan(repairStart)

    const repairBlock = cliSource.slice(repairStart, nextFunction)
    expect(repairBlock).not.toContain('await getOpenClawPathsForRead().catch(() => null)')
    expect(repairBlock).toContain('await resolveOpenClawPluginRepairPaths()')
    expect(repairBlock).toContain("await readConfig({ configPath }).catch(() => null)")
    expect(repairBlock).toContain('repairIncompatibleExtensionPluginsOnDisk')
  })
})
