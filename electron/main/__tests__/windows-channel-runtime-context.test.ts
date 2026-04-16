import { afterEach, describe, expect, it } from 'vitest'

import { resolveWindowsChannelRuntimeContext } from '../platforms/windows/windows-channel-runtime-context'
import { buildWindowsActiveRuntimeSnapshot } from '../platforms/windows/windows-runtime-policy'
import {
  clearSelectedWindowsActiveRuntimeSnapshot,
  setSelectedWindowsActiveRuntimeSnapshot,
} from '../windows-active-runtime'

const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { tmpdir } = process.getBuiltinModule('node:os') as typeof import('node:os')
const { mkdtemp, mkdir, rm, writeFile } =
  process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')

const tempDirs: string[] = []
const itOnWindows = process.platform === 'win32' ? it : it.skip

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function writeHostOpenClawPackage(rootDir: string, version = '2026.4.12'): Promise<void> {
  await mkdir(path.join(rootDir, 'dist', 'plugin-sdk'), { recursive: true })
  await writeFile(
    path.join(rootDir, 'package.json'),
    JSON.stringify({
      name: 'openclaw',
      version,
      type: 'module',
      exports: {
        './plugin-sdk': './dist/plugin-sdk/index.js',
      },
    })
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

describe('resolveWindowsChannelRuntimeContext', () => {
  itOnWindows('freezes a single selected Windows runtime context for channel preflight', async () => {
    const stateDir = await createTempDir('qclaw-win-runtime-context-')
    const hostRootParent = await createTempDir('qclaw-win-runtime-context-host-')
    const hostPackageRoot = path.join(hostRootParent, 'node_modules', 'openclaw')
    await writeHostOpenClawPackage(hostPackageRoot)

    const snapshot = buildWindowsActiveRuntimeSnapshot({
      configPath: path.join(stateDir, 'openclaw.json'),
      extensionsDir: path.join(stateDir, 'extensions'),
      hostPackageRoot,
      nodeExecutable: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe',
      npmPrefix: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1',
      openclawExecutable: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\openclaw.cmd',
      stateDir,
    })
    setSelectedWindowsActiveRuntimeSnapshot(snapshot)

    const result = await resolveWindowsChannelRuntimeContext({
      caller: 'channel-preflight',
      platform: 'win32',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.context).toMatchObject({
      configPath: snapshot.configPath,
      homeDir: snapshot.stateDir,
      hostPackageRoot: snapshot.hostPackageRoot,
      nodePath: snapshot.nodePath,
      npmPrefix: snapshot.npmPrefix,
      openclawPath: snapshot.openclawPath,
      openclawVersion: '2026.4.12',
      stateDir: snapshot.stateDir,
      privateNodeEnv: {
        pathPrefix: snapshot.npmPrefix,
      },
    })
    expect(result.context.bridge).toMatchObject({
      ok: true,
      diagnosticSeverity: 'none',
      packageVersion: '2026.4.12',
    })
  })

  itOnWindows('returns a hard channel-preflight failure when the bridge is invalid', async () => {
    const stateDir = await createTempDir('qclaw-win-runtime-context-fail-')
    const hostRootParent = await createTempDir('qclaw-win-runtime-context-host-fail-')
    const hostPackageRoot = path.join(hostRootParent, 'node_modules', 'openclaw')
    await writeHostOpenClawPackage(hostPackageRoot, '2026.3.24')

    const snapshot = buildWindowsActiveRuntimeSnapshot({
      configPath: path.join(stateDir, 'openclaw.json'),
      extensionsDir: path.join(stateDir, 'extensions'),
      hostPackageRoot,
      nodeExecutable: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe',
      npmPrefix: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1',
      openclawExecutable: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\openclaw.cmd',
      stateDir,
    })

    const result = await resolveWindowsChannelRuntimeContext({
      caller: 'channel-preflight',
      platform: 'win32',
      snapshot,
    })

    expect(result).toMatchObject({
      ok: false,
      context: null,
      bridge: {
        ok: false,
        diagnosticSeverity: 'error',
        failureKind: 'version_mismatch',
        packageVersion: '2026.3.24',
      },
    })
  })

  itOnWindows('rejects an otherwise valid runtime snapshot when command paths are incomplete', async () => {
    const stateDir = await createTempDir('qclaw-win-runtime-context-incomplete-')
    const hostRootParent = await createTempDir('qclaw-win-runtime-context-host-incomplete-')
    const hostPackageRoot = path.join(hostRootParent, 'node_modules', 'openclaw')
    await writeHostOpenClawPackage(hostPackageRoot)

    const snapshot = buildWindowsActiveRuntimeSnapshot({
      configPath: path.join(stateDir, 'openclaw.json'),
      extensionsDir: path.join(stateDir, 'extensions'),
      hostPackageRoot,
      nodeExecutable: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe',
      npmPrefix: '',
      openclawExecutable: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\openclaw.cmd',
      stateDir,
    })

    const result = await resolveWindowsChannelRuntimeContext({
      caller: 'channel-preflight',
      platform: 'win32',
      snapshot,
    })

    expect(result).toMatchObject({
      ok: false,
      context: null,
      bridge: {
        ok: true,
      },
    })
    if (result.ok) throw new Error('expected incomplete runtime context failure')
    expect(result.message).toContain('npmPrefix')
  })
})
