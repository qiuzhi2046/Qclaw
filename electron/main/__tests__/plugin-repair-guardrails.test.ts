import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

function readMainSource(filename: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'electron', 'main', filename), 'utf8')
}

describe('plugin repair guardrails', () => {
  it('keeps plugin smoke tests off Electron process.execPath', () => {
    const pluginSafetySource = readMainSource('plugin-install-safety.ts')
    const nodeRuntimeSource = readMainSource('node-subprocess-runtime.ts')

    expect(pluginSafetySource).not.toContain('process.execPath')
    expect(pluginSafetySource).toContain('runNodeEvalWithQualifiedRuntime')
    expect(nodeRuntimeSource).toContain('process.execPath points at the Electron host binary')
  })

  it('keeps CLI/plugin repair preflight best-effort', () => {
    const cliSource = readMainSource('cli.ts')
    const preflightSource = readMainSource('plugin-repair-preflight.ts')

    expect(cliSource).toContain('runPluginRepairPreflight')
    expect(cliSource).toContain('repairKnownProviderConfigGapsOnDisk')
    expect(preflightSource).toContain('best-effort')
    expect(preflightSource).toContain('.catch(() => undefined)')
  })

  it('does not reintroduce ELECTRON_RUN_AS_NODE as the plugin smoke-test strategy', () => {
    const pluginSafetySource = readMainSource('plugin-install-safety.ts')
    const nodeRuntimeSource = readMainSource('node-subprocess-runtime.ts')

    expect(pluginSafetySource).not.toContain('ELECTRON_RUN_AS_NODE')
    expect(nodeRuntimeSource).not.toContain('ELECTRON_RUN_AS_NODE')
  })

  it('keeps dry-run plugin scans separate from entry smoke tests and writes', () => {
    const pluginSafetySource = readMainSource('plugin-install-safety.ts')
    const scanStart = pluginSafetySource.indexOf('export async function scanIncompatibleExtensionPlugins(')
    const repairStart = pluginSafetySource.indexOf('export function buildIncompatiblePluginRepairSummary', scanStart)

    expect(scanStart).toBeGreaterThan(-1)
    expect(repairStart).toBeGreaterThan(scanStart)

    const scanBlock = pluginSafetySource.slice(scanStart, repairStart)
    expect(scanBlock).toContain('findPotentialIncompatibleExtensionPlugins')
    expect(scanBlock).not.toContain('smokeTestPluginEntry')
    expect(scanBlock).not.toContain('quarantinePlugins')
    expect(scanBlock).not.toContain('pruneStalePluginConfigEntries')
  })

  it('keeps IPC plugin repair options aligned with the CLI repair contract', () => {
    const cliSource = readMainSource('cli.ts')
    const ipcHandlersSource = readMainSource('ipc-handlers.ts')

    expect(cliSource).toContain('export interface RepairIncompatibleExtensionPluginsOptions')
    expect(ipcHandlersSource).toContain('type RepairIncompatibleExtensionPluginsOptions')
    expect(ipcHandlersSource).toContain("options?: RepairIncompatibleExtensionPluginsOptions")
    expect(ipcHandlersSource).not.toContain("options?: { scopePluginIds?: string[] }")
  })
})
