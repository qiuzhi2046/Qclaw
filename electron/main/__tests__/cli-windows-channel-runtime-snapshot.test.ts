// @vitest-environment node

import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearCachedWindowsChannelRuntimeSnapshot,
  readCachedWindowsChannelRuntimeSnapshot,
  replaceCachedWindowsChannelRuntimeSnapshot,
} from '../platforms/windows/windows-channel-runtime-reconcile'
import type { WindowsChannelRuntimeSnapshot } from '../platforms/windows/windows-channel-runtime-snapshot'
import { buildWindowsActiveRuntimeSnapshot } from '../platforms/windows/windows-runtime-policy'
import type { WindowsActiveRuntimeSnapshot } from '../platforms/windows/windows-runtime-policy'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { fileURLToPath, pathToFileURL } = process.getBuiltinModule('node:url') as typeof import('node:url')
const vm = process.getBuiltinModule('node:vm') as typeof import('node:vm')
const { registerHooks } = process.getBuiltinModule('node:module') as typeof import('node:module') & {
  registerHooks: (hooks: {
    resolve?: (
      specifier: string,
      context: { parentURL?: string },
      nextResolve: (specifier: string, context: { parentURL?: string }) => unknown
    ) => unknown
    load?: (
      url: string,
      context: Record<string, unknown>,
      nextLoad: (url: string, context: Record<string, unknown>) => unknown
    ) => unknown
  }) => { deregister: () => void }
}

type RecordLike = Record<string, unknown>

interface CliModule {
  buildAuthoritativeWindowsChannelRuntimeSnapshot: (
    existingSnapshot?: WindowsChannelRuntimeSnapshot | null,
    dependencies?: RecordLike
  ) => Promise<WindowsChannelRuntimeSnapshot | null>
  commitSelectedWindowsActiveRuntimeSnapshot: (
    snapshot: WindowsActiveRuntimeSnapshot | null | undefined,
    dependencies?: RecordLike
  ) => Promise<WindowsActiveRuntimeSnapshot | null>
  ensureAuthoritativeWindowsChannelRuntimeSnapshot: (
    dependencies?: RecordLike
  ) => Promise<WindowsChannelRuntimeSnapshot | null>
  readAuthoritativeWindowsChannelRuntimeSnapshot: () => WindowsChannelRuntimeSnapshot | null
}

function buildGatewayOwnerSnapshotFromLauncherIntegrity(input: {
  launcherPath: string | null
  shouldReinstallService: boolean
  status: 'healthy' | 'launcher-missing' | 'service-missing' | 'unknown'
  taskName: string | null
}) {
  if (input.status === 'service-missing') {
    return {
      ownerKind: 'none',
      ownerLauncherPath: '',
      ownerTaskName: '',
    }
  }

  if (input.shouldReinstallService || input.status !== 'healthy') {
    return {
      ownerKind: 'unknown',
      ownerLauncherPath: '',
      ownerTaskName: '',
    }
  }

  if (input.launcherPath || input.taskName) {
    return {
      ownerKind: 'scheduled-task',
      ownerLauncherPath: String(input.launcherPath || ''),
      ownerTaskName: String(input.taskName || ''),
    }
  }

  return {
    ownerKind: 'unknown',
    ownerLauncherPath: '',
    ownerTaskName: '',
  }
}

let cliModulePromise: Promise<CliModule> | null = null

function resolveTypeScriptModuleUrl(
  specifier: string,
  parentURL?: string
): string | null {
  const hasKnownExtension = /\.[a-z0-9]+$/i.test(specifier)
  if (hasKnownExtension) return null

  const candidates: string[] = []
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (!parentURL?.startsWith('file:')) return null
    const parentPath = fileURLToPath(parentURL)
    const parentDir = path.dirname(parentPath)
    candidates.push(path.resolve(parentDir, `${specifier}.ts`))
    candidates.push(path.resolve(parentDir, specifier, 'index.ts'))
  } else if (path.isAbsolute(specifier)) {
    candidates.push(`${specifier}.ts`)
    candidates.push(path.join(specifier, 'index.ts'))
  }

  const match = candidates.find((candidate) => fs.existsSync(candidate))
  return match ? pathToFileURL(match).href : null
}

function isProjectTypeScriptUrl(url: string): boolean {
  if (!url.startsWith('file:') || !/\.(?:ts|tsx)$/.test(url)) return false
  const filePath = fileURLToPath(url)
  const relative = path.relative(process.cwd(), filePath)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function transpileTypeScriptSource(url: string): string {
  const filePath = fileURLToPath(url)
  const source = fs.readFileSync(filePath, 'utf8')
  return ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
  }).outputText
}

async function withStubbedWindowsPlatform<T>(callback: () => Promise<T>): Promise<T> {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'win32',
  })

  try {
    return await callback()
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(process, 'platform', originalDescriptor)
    } else {
      delete (process as { platform?: string }).platform
    }
  }
}

async function loadCliModule(): Promise<CliModule> {
  if (cliModulePromise) {
    return cliModulePromise
  }

  const cliModuleUrl = pathToFileURL(path.join(process.cwd(), 'electron/main/cli.ts')).href
  cliModulePromise = (async () => {
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        const candidateUrl = resolveTypeScriptModuleUrl(specifier, context.parentURL)
        if (candidateUrl) {
          return {
            shortCircuit: true,
            url: candidateUrl,
          }
        }

        return nextResolve(specifier, context)
      },
      load(url, context, nextLoad) {
        if (isProjectTypeScriptUrl(url)) {
          return {
            format: 'module',
            shortCircuit: true,
            source: transpileTypeScriptSource(url),
          }
        }

        return nextLoad(url, context)
      },
    })

    try {
      const importModule = new vm.Script("Function('s', 'return import(s)')", {
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      }).runInThisContext() as (specifier: string) => Promise<CliModule>

      return await importModule(cliModuleUrl)
    } finally {
      hooks.deregister()
    }
  })()

  return cliModulePromise
}

function createChannelRuntimeSnapshot(input: {
  agentId: string
  runtime: WindowsActiveRuntimeSnapshot
}) {
  return {
    nodePath: input.runtime.nodePath,
    openclawPath: input.runtime.openclawPath,
    hostPackageRoot: input.runtime.hostPackageRoot,
    stateDir: input.runtime.stateDir,
    gatewayOwner: {
      ownerKind: 'scheduled-task',
      ownerLauncherPath: `${input.runtime.stateDir}\\gateway.cmd`,
      ownerTaskName: '\\OpenClaw Gateway',
    },
    managedPlugin: {
      configured: true,
      installedOnDisk: true,
      allowedInConfig: true,
      registered: true,
      loaded: true,
      ready: true,
    },
    resolvedBinding: {
      channelId: 'feishu',
      accountId: 'default',
      agentId: input.agentId,
      source: 'config-binding',
    },
  } satisfies WindowsChannelRuntimeSnapshot
}

function createGlobalRuntimeSnapshot() {
  return buildWindowsActiveRuntimeSnapshot({
    openclawExecutable: 'C:\\Program Files\\nodejs\\openclaw.cmd',
    hostPackageRoot: 'C:\\Program Files\\nodejs\\node_modules\\openclaw',
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    npmPrefix: 'C:\\Program Files\\nodejs',
    configPath: 'C:\\Users\\alice\\.openclaw\\openclaw.json',
    stateDir: 'C:\\Users\\alice\\.openclaw',
    extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
  })
}

function createPrivateRuntimeSnapshot() {
  return buildWindowsActiveRuntimeSnapshot({
    openclawExecutable:
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\openclaw.cmd',
    hostPackageRoot:
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node_modules\\openclaw',
    nodeExecutable:
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe',
    npmPrefix: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1',
    configPath: 'C:\\Users\\alice\\.openclaw\\openclaw.json',
    stateDir: 'C:\\Users\\alice\\.openclaw',
    extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
    userDataDir: 'C:\\Users\\alice\\AppData\\Local\\Qclaw',
  })
}

afterEach(() => {
  cliModulePromise = null
  vi.resetModules()
  vi.restoreAllMocks()
})

async function invokeBuilder(params: {
  config: Record<string, unknown> | null
  existingSnapshot?: WindowsChannelRuntimeSnapshot | null
  gatewayLauncherIntegrity: {
    launcherPath: string | null
    shouldReinstallService: boolean
    status: 'healthy' | 'launcher-missing' | 'service-missing' | 'unknown'
    taskName: string | null
  }
  installedOnDisk: boolean
  registeredPlugins: string[] | null
  selectedRuntimeSnapshot: WindowsActiveRuntimeSnapshot | null
}) {
  return withStubbedWindowsPlatform(async () => {
    const cliModule = await loadCliModule()
    return cliModule.buildAuthoritativeWindowsChannelRuntimeSnapshot(params.existingSnapshot ?? null, {
      buildGatewayOwnerSnapshotFromLauncherIntegrity,
      inspectGatewayLauncherIntegrity: async () => params.gatewayLauncherIntegrity,
      isPluginInstalledOnDisk: async () => params.installedOnDisk,
      listRegisteredPlugins: async () => params.registeredPlugins,
      readConfig: async () => params.config,
      readSelectedRuntimeSnapshot: async () => params.selectedRuntimeSnapshot,
    })
  })
}

describe('buildAuthoritativeWindowsChannelRuntimeSnapshot', () => {
  it('lets a complete global runtime win over a complete private runtime', async () => {
    const globalSnapshot = createGlobalRuntimeSnapshot()
    const privateSnapshot = createPrivateRuntimeSnapshot()

    const snapshot = await invokeBuilder({
      config: {
        channels: {
          feishu: {
            appId: 'cli-app',
            appSecret: 'secret',
          },
        },
        plugins: {
          allow: ['openclaw-lark'],
        },
        bindings: [
          {
            match: {
              channel: 'feishu',
              accountId: 'default',
            },
            agentId: 'feishu-default',
          },
        ],
      },
      gatewayLauncherIntegrity: {
        launcherPath: null,
        shouldReinstallService: false,
        status: 'service-missing',
        taskName: null,
      },
      installedOnDisk: true,
      registeredPlugins: ['openclaw-lark'],
      selectedRuntimeSnapshot: globalSnapshot,
      existingSnapshot: {
        nodePath: privateSnapshot.nodePath,
        openclawPath: privateSnapshot.openclawPath,
        hostPackageRoot: privateSnapshot.hostPackageRoot,
        stateDir: privateSnapshot.stateDir,
        gatewayOwner: {
          ownerKind: 'none',
          ownerLauncherPath: '',
          ownerTaskName: '',
        },
        managedPlugin: {
          configured: false,
          installedOnDisk: false,
          allowedInConfig: false,
          registered: false,
          loaded: false,
          ready: false,
        },
        resolvedBinding: {
          channelId: '',
          accountId: '',
          agentId: '',
          source: '',
        },
      },
    })

    expect(snapshot).toMatchObject({
      nodePath: globalSnapshot.nodePath,
      openclawPath: globalSnapshot.openclawPath,
      hostPackageRoot: globalSnapshot.hostPackageRoot,
      stateDir: globalSnapshot.stateDir,
    })
  })

  it('lets the private runtime win when the global runtime is incomplete', async () => {
    const privateSnapshot = createPrivateRuntimeSnapshot()

    const snapshot = await invokeBuilder({
      config: {
        channels: {
          feishu: {
            appId: 'cli-app',
          },
        },
      },
      gatewayLauncherIntegrity: {
        launcherPath: null,
        shouldReinstallService: false,
        status: 'service-missing',
        taskName: null,
      },
      installedOnDisk: false,
      registeredPlugins: [],
      selectedRuntimeSnapshot: privateSnapshot,
    })

    expect(snapshot).toMatchObject({
      nodePath: privateSnapshot.nodePath,
      openclawPath: privateSnapshot.openclawPath,
      hostPackageRoot: privateSnapshot.hostPackageRoot,
      stateDir: privateSnapshot.stateDir,
    })
  })

  it('reuses existing selected runtime snapshot fields when the selected runtime is unchanged', async () => {
    const privateSnapshot = createPrivateRuntimeSnapshot()

    const snapshot = await invokeBuilder({
      config: null,
      existingSnapshot: {
        nodePath: privateSnapshot.nodePath.toUpperCase(),
        openclawPath: privateSnapshot.openclawPath.toUpperCase(),
        hostPackageRoot: privateSnapshot.hostPackageRoot.toUpperCase(),
        stateDir: `${privateSnapshot.stateDir}\\`,
        gatewayOwner: {
          ownerKind: 'none',
          ownerLauncherPath: '',
          ownerTaskName: '',
        },
        managedPlugin: {
          configured: false,
          installedOnDisk: false,
          allowedInConfig: false,
          registered: false,
          loaded: false,
          ready: false,
        },
        resolvedBinding: {
          channelId: '',
          accountId: '',
          agentId: '',
          source: '',
        },
      },
      gatewayLauncherIntegrity: {
        launcherPath: null,
        shouldReinstallService: false,
        status: 'service-missing',
        taskName: null,
      },
      installedOnDisk: false,
      registeredPlugins: [],
      selectedRuntimeSnapshot: {
        ...privateSnapshot,
        nodePath: privateSnapshot.nodePath.toLowerCase(),
        openclawPath: privateSnapshot.openclawPath.toLowerCase(),
        hostPackageRoot: privateSnapshot.hostPackageRoot.toLowerCase(),
        stateDir: `${privateSnapshot.stateDir}\\`,
      },
    })

    expect(snapshot).toMatchObject({
      nodePath: privateSnapshot.nodePath.toUpperCase(),
      openclawPath: privateSnapshot.openclawPath.toUpperCase(),
      hostPackageRoot: privateSnapshot.hostPackageRoot.toUpperCase(),
      stateDir: `${privateSnapshot.stateDir}\\`,
    })
  })

  it('derives the gateway owner from the scheduled task launcher integrity probe when present', async () => {
    const privateSnapshot = createPrivateRuntimeSnapshot()

    const snapshot = await invokeBuilder({
      config: null,
      gatewayLauncherIntegrity: {
        status: 'healthy',
        launcherPath: 'C:\\Users\\alice\\.openclaw\\gateway.cmd',
        shouldReinstallService: false,
        taskName: '\\OpenClaw Gateway',
      },
      installedOnDisk: false,
      registeredPlugins: [],
      selectedRuntimeSnapshot: privateSnapshot,
    })

    expect(snapshot).toMatchObject({
      gatewayOwner: {
        ownerKind: 'scheduled-task',
        ownerLauncherPath: 'C:\\Users\\alice\\.openclaw\\gateway.cmd',
        ownerTaskName: '\\OpenClaw Gateway',
      },
    })
  })

  it('does not derive a managed gateway owner when launcher integrity requires reinstall', async () => {
    const privateSnapshot = createPrivateRuntimeSnapshot()

    const snapshot = await invokeBuilder({
      config: null,
      gatewayLauncherIntegrity: {
        status: 'launcher-missing',
        launcherPath: 'C:\\Users\\alice\\.openclaw\\gateway.cmd',
        shouldReinstallService: true,
        taskName: '\\OpenClaw Gateway',
      },
      installedOnDisk: false,
      registeredPlugins: [],
      selectedRuntimeSnapshot: privateSnapshot,
    })

    expect(snapshot).toMatchObject({
      gatewayOwner: {
        ownerKind: 'unknown',
        ownerLauncherPath: '',
        ownerTaskName: '',
      },
    })
  })
})

describe('commitSelectedWindowsActiveRuntimeSnapshot', () => {
  it('invokes reconcile exactly once on runtime change and persists the authoritative snapshot alongside it', async () => {
    const previousRuntime = createGlobalRuntimeSnapshot()
    const nextRuntime = createPrivateRuntimeSnapshot()
    const reconciledSnapshot = createChannelRuntimeSnapshot({
      agentId: 'feishu-runtime-b',
      runtime: nextRuntime,
    })
    const setSelectedRuntimeSnapshot = vi.fn((snapshot: WindowsActiveRuntimeSnapshot | null | undefined) =>
      snapshot ? { ...snapshot } : null
    )
    const reconcileWindowsChannelRuntimeSelection = vi.fn(async () => ({
      changed: true,
      launcherIntegrity: null,
      reconciled: true,
      snapshot: reconciledSnapshot,
    }))
    let cachedSnapshot: WindowsChannelRuntimeSnapshot | null = null

    await withStubbedWindowsPlatform(async () => {
      const cliModule = await loadCliModule()
      const committedSnapshot = await cliModule.commitSelectedWindowsActiveRuntimeSnapshot(nextRuntime, {
        getSelectedRuntimeSnapshot: () => previousRuntime,
        readCachedWindowsChannelRuntimeSnapshot: () => cachedSnapshot,
        reconcileWindowsChannelRuntimeSelection,
        replaceCachedWindowsChannelRuntimeSnapshot: (
          snapshot: WindowsChannelRuntimeSnapshot | null | undefined
        ) => {
          cachedSnapshot = snapshot ?? null
          return cachedSnapshot
        },
        setSelectedRuntimeSnapshot,
      })

      expect(committedSnapshot).toMatchObject({
        nodePath: nextRuntime.nodePath,
        openclawPath: nextRuntime.openclawPath,
      })
      expect(reconcileWindowsChannelRuntimeSelection).toHaveBeenCalledTimes(1)
      expect(setSelectedRuntimeSnapshot).toHaveBeenCalledTimes(1)
      expect(cachedSnapshot).toEqual(reconciledSnapshot)
    })
  })

  it('rolls back the authoritative snapshot cache when selected runtime persistence fails', async () => {
    const previousRuntime = createGlobalRuntimeSnapshot()
    const nextRuntime = createPrivateRuntimeSnapshot()
    const previousSnapshot = createChannelRuntimeSnapshot({
      agentId: 'feishu-runtime-a',
      runtime: previousRuntime,
    })
    const reconciledSnapshot = createChannelRuntimeSnapshot({
      agentId: 'feishu-runtime-b',
      runtime: nextRuntime,
    })
    replaceCachedWindowsChannelRuntimeSnapshot(previousSnapshot)
    const reconcileWindowsChannelRuntimeSelection = vi.fn(async () => ({
      changed: true,
      launcherIntegrity: null,
      reconciled: true,
      snapshot: reconciledSnapshot,
    }))
    const setSelectedRuntimeSnapshot = vi.fn(() => {
      throw new Error('persist selected runtime failed')
    })
    let cachedSnapshot: WindowsChannelRuntimeSnapshot | null = previousSnapshot

    await withStubbedWindowsPlatform(async () => {
      const cliModule = await loadCliModule()

      await expect(
        cliModule.commitSelectedWindowsActiveRuntimeSnapshot(nextRuntime, {
          getSelectedRuntimeSnapshot: () => previousRuntime,
          readCachedWindowsChannelRuntimeSnapshot: () => cachedSnapshot,
          reconcileWindowsChannelRuntimeSelection,
          replaceCachedWindowsChannelRuntimeSnapshot: (
            snapshot: WindowsChannelRuntimeSnapshot | null | undefined
          ) => {
            cachedSnapshot = snapshot ?? null
            return cachedSnapshot
          },
          setSelectedRuntimeSnapshot,
        })
      ).rejects.toThrow('persist selected runtime failed')

      expect(reconcileWindowsChannelRuntimeSelection).toHaveBeenCalledTimes(1)
      expect(cachedSnapshot).toEqual(previousSnapshot)
    })
  })

  it('repairs the authoritative snapshot cache when the selected runtime is unchanged', async () => {
    const currentRuntime = createPrivateRuntimeSnapshot()
    const ensuredSnapshot = createChannelRuntimeSnapshot({
      agentId: 'feishu-runtime-b',
      runtime: currentRuntime,
    })
    let cachedSnapshot: WindowsChannelRuntimeSnapshot | null = null
    const ensureAuthoritativeWindowsChannelRuntimeSnapshot = vi.fn(async () => {
      cachedSnapshot = ensuredSnapshot
      return ensuredSnapshot
    })

    await withStubbedWindowsPlatform(async () => {
      const cliModule = await loadCliModule()
      const committedSnapshot = await cliModule.commitSelectedWindowsActiveRuntimeSnapshot(currentRuntime, {
        ensureAuthoritativeWindowsChannelRuntimeSnapshot,
        getSelectedRuntimeSnapshot: () => currentRuntime,
        readCachedWindowsChannelRuntimeSnapshot: () => cachedSnapshot,
      })

      expect(committedSnapshot).toMatchObject({
        nodePath: currentRuntime.nodePath,
        openclawPath: currentRuntime.openclawPath,
      })
      expect(ensureAuthoritativeWindowsChannelRuntimeSnapshot).toHaveBeenCalledTimes(1)
      expect(cachedSnapshot).toEqual(ensuredSnapshot)
    })
  })
})

describe('ensureAuthoritativeWindowsChannelRuntimeSnapshot', () => {
  it('reuses the cached authoritative snapshot without rebuilding', async () => {
    const cachedSnapshot = createChannelRuntimeSnapshot({
      agentId: 'feishu-runtime-a',
      runtime: createGlobalRuntimeSnapshot(),
    })
    const readCachedWindowsChannelRuntimeSnapshot = vi.fn(() => cachedSnapshot)
    const replaceCachedWindowsChannelRuntimeSnapshot = vi.fn(
      (snapshot: WindowsChannelRuntimeSnapshot | null | undefined) => snapshot ?? null
    )
    const buildAuthoritativeWindowsChannelRuntimeSnapshot = vi.fn(async () => null)

    await withStubbedWindowsPlatform(async () => {
      const cliModule = await loadCliModule()
      const snapshot = await cliModule.ensureAuthoritativeWindowsChannelRuntimeSnapshot({
        buildAuthoritativeWindowsChannelRuntimeSnapshot,
        readCachedWindowsChannelRuntimeSnapshot,
        replaceCachedWindowsChannelRuntimeSnapshot,
      })

      expect(snapshot).toEqual(cachedSnapshot)
      expect(buildAuthoritativeWindowsChannelRuntimeSnapshot).not.toHaveBeenCalled()
      expect(replaceCachedWindowsChannelRuntimeSnapshot).not.toHaveBeenCalled()
    })
  })

  it('rebuilds and persists the authoritative snapshot when the cache is missing', async () => {
    const rebuiltSnapshot = createChannelRuntimeSnapshot({
      agentId: 'feishu-runtime-b',
      runtime: createPrivateRuntimeSnapshot(),
    })
    const buildAuthoritativeWindowsChannelRuntimeSnapshot = vi.fn(async () => rebuiltSnapshot)
    const readCachedWindowsChannelRuntimeSnapshot = vi.fn(() => null)
    const replaceCachedWindowsChannelRuntimeSnapshot = vi.fn(
      (snapshot: WindowsChannelRuntimeSnapshot | null | undefined) => snapshot ?? null
    )

    await withStubbedWindowsPlatform(async () => {
      const cliModule = await loadCliModule()
      const snapshot = await cliModule.ensureAuthoritativeWindowsChannelRuntimeSnapshot({
        buildAuthoritativeWindowsChannelRuntimeSnapshot,
        readCachedWindowsChannelRuntimeSnapshot,
        replaceCachedWindowsChannelRuntimeSnapshot,
      })

      expect(snapshot).toEqual(rebuiltSnapshot)
      expect(buildAuthoritativeWindowsChannelRuntimeSnapshot).toHaveBeenCalledTimes(1)
      expect(replaceCachedWindowsChannelRuntimeSnapshot).toHaveBeenCalledTimes(1)
    })
  })
})
