// @vitest-environment node

import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

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

interface CliModule {
  buildAuthoritativeWindowsChannelRuntimeSnapshot: (
    existingSnapshot?: null,
    dependencies?: {
      buildGatewayOwnerSnapshotFromLauncherIntegrity?: (input: {
        launcherPath: string | null
        shouldReinstallService: boolean
        status: 'healthy' | 'launcher-missing' | 'service-missing' | 'unknown'
        taskName: string | null
      }) => {
        ownerKind: string
        ownerLauncherPath: string
        ownerTaskName: string
      }
      inspectGatewayLauncherIntegrity?: (input: { homeDir: string }) => Promise<{
        launcherPath: string | null
        shouldReinstallService: boolean
        status: 'healthy' | 'launcher-missing' | 'service-missing' | 'unknown'
        taskName: string | null
      }>
      isPluginInstalledOnDisk?: (pluginId: string) => Promise<boolean>
      listRegisteredPlugins?: (input: {
        activeRuntimeSnapshot: WindowsActiveRuntimeSnapshot | null
      }) => Promise<string[] | null>
      readConfig?: () => Promise<Record<string, unknown> | null>
      readSelectedRuntimeSnapshot?: () => Promise<WindowsActiveRuntimeSnapshot | null>
    }
  ) => Promise<Record<string, unknown> | null>
}

function buildGatewayOwnerSnapshotFromLauncherIntegrity(input: {
  launcherPath: string | null
  shouldReinstallService: boolean
  status: 'healthy' | 'launcher-missing' | 'service-missing' | 'unknown'
  taskName: string | null
}) {
  if (input.launcherPath || input.taskName) {
    return {
      ownerKind: 'scheduled-task',
      ownerLauncherPath: String(input.launcherPath || ''),
      ownerTaskName: String(input.taskName || ''),
    }
  }

  return {
    ownerKind: 'none',
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

describe('buildAuthoritativeWindowsChannelRuntimeSnapshot runtime binding', () => {
  it('passes the selected runtime snapshot to plugin registration lookup', async () => {
    const selectedRuntimeSnapshot = createPrivateRuntimeSnapshot()
    let capturedRuntimeSnapshot: WindowsActiveRuntimeSnapshot | null = null

    await withStubbedWindowsPlatform(async () => {
      const cliModule = await loadCliModule()
      const snapshot = await cliModule.buildAuthoritativeWindowsChannelRuntimeSnapshot(null, {
        buildGatewayOwnerSnapshotFromLauncherIntegrity,
        inspectGatewayLauncherIntegrity: async () => ({
          launcherPath: null,
          shouldReinstallService: false,
          status: 'service-missing',
          taskName: null,
        }),
        isPluginInstalledOnDisk: async () => false,
        listRegisteredPlugins: async (input) => {
          capturedRuntimeSnapshot = input.activeRuntimeSnapshot
          return []
        },
        readConfig: async () => null,
        readSelectedRuntimeSnapshot: async () => selectedRuntimeSnapshot,
      })

      expect(snapshot).toMatchObject({
        nodePath: selectedRuntimeSnapshot.nodePath,
        openclawPath: selectedRuntimeSnapshot.openclawPath,
      })
    })

    expect(capturedRuntimeSnapshot).toMatchObject({
      nodePath: selectedRuntimeSnapshot.nodePath,
      openclawPath: selectedRuntimeSnapshot.openclawPath,
      hostPackageRoot: selectedRuntimeSnapshot.hostPackageRoot,
    })
  })
})
