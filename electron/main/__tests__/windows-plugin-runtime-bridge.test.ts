import { afterEach, describe, expect, it } from 'vitest'

import {
  ensureWindowsPluginHostRuntimeBridge,
  ensureWindowsPluginHostRuntimeBridgeForRuntimeSnapshot,
} from '../platforms/windows/windows-plugin-runtime-bridge'
import { buildWindowsActiveRuntimeSnapshot } from '../platforms/windows/windows-runtime-policy'
import {
  clearSelectedWindowsActiveRuntimeSnapshot,
  setSelectedWindowsActiveRuntimeSnapshot,
} from '../windows-active-runtime'

const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { tmpdir } = process.getBuiltinModule('node:os') as typeof import('node:os')
const { mkdtemp, mkdir, readFile, realpath, rm, writeFile } =
  process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')

const tempDirs: string[] = []
const itOnWindows = process.platform === 'win32' ? it : it.skip

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function writeHostOpenClawPackage(rootDir: string): Promise<void> {
  await mkdir(path.join(rootDir, 'dist', 'plugin-sdk'), { recursive: true })
  await writeFile(
    path.join(rootDir, 'package.json'),
    JSON.stringify(
      {
        name: 'openclaw',
        type: 'module',
        exports: {
          './plugin-sdk': './dist/plugin-sdk/index.js',
        },
      },
      null,
      2
    )
  )
  await writeFile(
    path.join(rootDir, 'dist', 'plugin-sdk', 'index.js'),
    'export const pluginSdkReady = true\n'
  )
}

afterEach(async () => {
  clearSelectedWindowsActiveRuntimeSnapshot()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('ensureWindowsPluginHostRuntimeBridge', () => {
  itOnWindows('creates ~/.openclaw/node_modules/openclaw as a junction to the active host package root', async () => {
    const homeDir = await createTempDir('qclaw-win-plugin-home-')
    const hostRootParent = await createTempDir('qclaw-win-plugin-host-')
    const hostOpenClawPackageRoot = path.join(hostRootParent, 'node_modules', 'openclaw')
    await writeHostOpenClawPackage(hostOpenClawPackageRoot)

    const result = await ensureWindowsPluginHostRuntimeBridge({
      homeDir,
      hostOpenClawPackageRoot,
    })

    const bridgePath = path.join(homeDir, 'node_modules', 'openclaw')
    expect(result.ok).toBe(true)
    expect(result.bridgePath).toBe(bridgePath)
    expect(await realpath(bridgePath)).toBe(await realpath(hostOpenClawPackageRoot))

    const pluginSdkSource = await readFile(path.join(bridgePath, 'dist', 'plugin-sdk', 'index.js'), 'utf8')
    expect(pluginSdkSource).toContain('pluginSdkReady')
  })

  itOnWindows('uses the selected Windows runtime snapshot host package root when no explicit host path is provided', async () => {
    const homeDir = await createTempDir('qclaw-win-plugin-home-selected-')
    const hostRootParent = await createTempDir('qclaw-win-plugin-host-selected-')
    const hostOpenClawPackageRoot = path.join(hostRootParent, 'node_modules', 'openclaw')
    await writeHostOpenClawPackage(hostOpenClawPackageRoot)

    setSelectedWindowsActiveRuntimeSnapshot(
      buildWindowsActiveRuntimeSnapshot({
        configPath: path.join(homeDir, 'config.json'),
        extensionsDir: path.join(homeDir, 'extensions'),
        hostPackageRoot: hostOpenClawPackageRoot,
        nodeExecutable: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe',
        npmPrefix: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1',
        openclawExecutable: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw.cmd',
        stateDir: homeDir,
      })
    )

    const result = await ensureWindowsPluginHostRuntimeBridge({
      homeDir,
    })

    const bridgePath = path.join(homeDir, 'node_modules', 'openclaw')
    expect(result.ok).toBe(true)
    expect(result.bridgePath).toBe(bridgePath)
    expect(await realpath(bridgePath)).toBe(await realpath(hostOpenClawPackageRoot))
  })

  itOnWindows('repoints an existing junction when the selected runtime snapshot changes host package root', async () => {
    const homeDir = await createTempDir('qclaw-win-plugin-home-repoint-')
    const oldHostRootParent = await createTempDir('qclaw-win-plugin-host-old-')
    const newHostRootParent = await createTempDir('qclaw-win-plugin-host-new-')
    const oldHostOpenClawPackageRoot = path.join(oldHostRootParent, 'node_modules', 'openclaw')
    const newHostOpenClawPackageRoot = path.join(newHostRootParent, 'node_modules', 'openclaw')
    await writeHostOpenClawPackage(oldHostOpenClawPackageRoot)
    await writeHostOpenClawPackage(newHostOpenClawPackageRoot)

    await ensureWindowsPluginHostRuntimeBridge({
      homeDir,
      hostOpenClawPackageRoot: oldHostOpenClawPackageRoot,
    })

    const result = await ensureWindowsPluginHostRuntimeBridgeForRuntimeSnapshot(
      buildWindowsActiveRuntimeSnapshot({
        configPath: path.join(homeDir, 'config.json'),
        extensionsDir: path.join(homeDir, 'extensions'),
        hostPackageRoot: newHostOpenClawPackageRoot,
        nodeExecutable: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe',
        npmPrefix: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1',
        openclawExecutable: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\openclaw.cmd',
        stateDir: homeDir,
      }),
      {
        platform: 'win32',
      }
    )

    const bridgePath = path.join(homeDir, 'node_modules', 'openclaw')
    expect(result.ok).toBe(true)
    expect(await realpath(bridgePath)).toBe(await realpath(newHostOpenClawPackageRoot))
  })
})
