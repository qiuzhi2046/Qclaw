import { describe, expect, it } from 'vitest'
import {
  buildWindowsManagedOpenClawRuntimeMarker,
  buildWindowsActiveRuntimeSnapshot,
  buildWindowsSelectedRuntimeSnapshotFields,
  prepareWindowsManagedOpenClawRuntimeCandidate,
  resolveRequiredWindowsOpenClawRuntimePathsForNodeExecutable,
  reuseWindowsSelectedRuntimeSnapshotFields,
  resolveWindowsPrivateOpenClawRuntimePaths,
  resolveWindowsPrivateNodeRuntimePaths,
  selectAuthoritativeWindowsActiveRuntimeSnapshot,
  WINDOWS_MANAGED_OPENCLAW_RUNTIME_MARKER_FILENAME,
  WINDOWS_PRIVATE_NODE_VERSION,
} from '../platforms/windows/windows-runtime-policy'
import { buildTestEnv } from './test-env'

describe('buildWindowsActiveRuntimeSnapshot', () => {
  it('prefers one coherent runtime over mixing global and user-owned fragments', () => {
    const snapshot = buildWindowsActiveRuntimeSnapshot({
      openclawExecutable: 'C:\\Users\\qiuzh\\AppData\\Roaming\\npm\\openclaw.cmd',
      hostPackageRoot: 'C:\\Users\\qiuzh\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node_modules\\npm\\node_modules\\openclaw',
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      npmPrefix: 'C:\\Users\\qiuzh\\AppData\\Roaming\\npm',
      configPath: 'C:\\Users\\qiuzh\\.openclaw\\config.json',
      stateDir: 'C:\\Users\\qiuzh\\.openclaw',
      extensionsDir: 'C:\\Users\\qiuzh\\.openclaw\\extensions',
    })

    expect(snapshot.openclawPath).toBe('C:\\Users\\qiuzh\\AppData\\Roaming\\npm\\openclaw.cmd')
    expect(snapshot.hostPackageRoot).toBe(
      'C:\\Users\\qiuzh\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node_modules\\npm\\node_modules\\openclaw'
    )
    expect(snapshot.nodePath).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(snapshot.npmPrefix).toBe('C:\\Users\\qiuzh\\AppData\\Roaming\\npm')
    expect(snapshot.configPath).toBe('C:\\Users\\qiuzh\\.openclaw\\config.json')
    expect(snapshot.extensionsDir).toBe('C:\\Users\\qiuzh\\.openclaw\\extensions')
    expect(snapshot.logsDir.endsWith('\\runtime\\win32\\logs')).toBe(true)
    expect(snapshot.tmpDir.endsWith('\\runtime\\win32\\tmp')).toBe(true)
  })
})

describe('resolveWindowsPrivateNodeRuntimePaths', () => {
  it('resolves the private Node runtime under a no-space LOCALAPPDATA Qclaw root', () => {
    const paths = resolveWindowsPrivateNodeRuntimePaths({
      env: buildTestEnv({
        LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
      }),
    })

    expect(WINDOWS_PRIVATE_NODE_VERSION).toBe('v24.14.1')
    expect(paths.runtimeRoot).toBe('C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32')
    expect(paths.nodeVersionDir).toBe('C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1')
    expect(paths.nodeBinDir).toBe(paths.nodeVersionDir)
    expect(paths.nodeExecutable).toBe(
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe'
    )
    expect(paths.npmExecutable).toBe(
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\npm.cmd'
    )
    expect(paths.zipStagingDir).toBe(
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\.downloads\\v24.14.1\\node-v24.14.1-win-x64'
    )
    expect(paths.installStagingDir).toBe(
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\.staging\\v24.14.1'
    )
    expect(paths.runtimeRoot).not.toContain(' ')
    expect(paths.nodeVersionDir).not.toContain(' ')
  })

  it('supports overriding the runtime root, version, and filename', () => {
    const paths = resolveWindowsPrivateNodeRuntimePaths({
      filename: 'node-v24.14.1-win-arm64.zip',
      rootDir: 'D:\\Qclaw\\runtime\\win32',
      version: '24.14.1',
    })

    expect(paths.runtimeRoot).toBe('D:\\Qclaw\\runtime\\win32')
    expect(paths.nodeVersionDir).toBe('D:\\Qclaw\\runtime\\win32\\node\\v24.14.1')
    expect(paths.zipStagingDir).toBe(
      'D:\\Qclaw\\runtime\\win32\\node\\.downloads\\v24.14.1\\node-v24.14.1-win-arm64'
    )
  })
})

describe('resolveWindowsPrivateOpenClawRuntimePaths', () => {
  it('places the private openclaw package and shim under the selected private Node runtime root', () => {
    const paths = resolveWindowsPrivateOpenClawRuntimePaths({
      env: buildTestEnv({
        LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
      }),
    })

    expect(paths.npmPrefix).toBe('C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1')
    expect(paths.openclawExecutable).toBe(
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\openclaw.cmd'
    )
    expect(paths.hostPackageRoot).toBe(
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node_modules\\openclaw'
    )
    expect(paths.installStagingDir).toBe(
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\openclaw\\.staging\\v24.14.1'
    )
    expect(paths.packageJsonPath).toBe(
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node_modules\\openclaw\\package.json'
    )
    expect(paths.runtimeMarkerPath).toBe(
      `C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node_modules\\openclaw\\${WINDOWS_MANAGED_OPENCLAW_RUNTIME_MARKER_FILENAME}`
    )
  })
})

describe('resolveRequiredWindowsOpenClawRuntimePathsForNodeExecutable', () => {
  it('requires the private openclaw host when the selected node executable is the private runtime', () => {
    const env = buildTestEnv({
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
    })
    const privateNodePaths = resolveWindowsPrivateNodeRuntimePaths({ env })

    const paths = resolveRequiredWindowsOpenClawRuntimePathsForNodeExecutable(
      privateNodePaths.nodeExecutable,
      { env }
    )

    expect(paths).toEqual({
      installStagingDir:
        'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\openclaw\\.staging\\v24.14.1',
      npmPrefix: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1',
      openclawExecutable:
        'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\openclaw.cmd',
      hostPackageRoot:
        'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node_modules\\openclaw',
      packageJsonPath:
        'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node_modules\\openclaw\\package.json',
      runtimeMarkerPath:
        `C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node_modules\\openclaw\\${WINDOWS_MANAGED_OPENCLAW_RUNTIME_MARKER_FILENAME}`,
    })
  })

  it('does not require a private host when the selected node executable is global', () => {
    const paths = resolveRequiredWindowsOpenClawRuntimePathsForNodeExecutable(
      'C:\\Program Files\\nodejs\\node.exe',
      {
        env: buildTestEnv({
          LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        }),
      }
    )

    expect(paths).toBeNull()
  })
})

describe('buildWindowsActiveRuntimeSnapshot with private Node runtime', () => {
  it('carries the private Node executable and keeps runtime roots under LOCALAPPDATA\\Qclaw\\runtime\\win32', () => {
    const paths = resolveWindowsPrivateNodeRuntimePaths({
      env: buildTestEnv({
        LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
      }),
    })

    const snapshot = buildWindowsActiveRuntimeSnapshot({
      configPath: 'C:\\Users\\alice\\.openclaw\\config.json',
      extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
      hostPackageRoot: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node_modules\\npm\\node_modules\\openclaw',
      nodeExecutable: paths.nodeExecutable,
      npmPrefix: 'C:\\Users\\alice\\AppData\\Roaming\\npm',
      openclawExecutable: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw.cmd',
      stateDir: 'C:\\Users\\alice\\.openclaw',
      userDataDir: 'C:\\Users\\alice\\AppData\\Local\\Qclaw',
    })

    expect(snapshot.nodePath).toBe(paths.nodeExecutable)
    expect(snapshot.hostPackageRoot).toBe(
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node_modules\\npm\\node_modules\\openclaw'
    )
    expect(snapshot.logsDir).toBe('C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\logs')
    expect(snapshot.tmpDir).toBe('C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\tmp')
  })
})

describe('selectAuthoritativeWindowsActiveRuntimeSnapshot', () => {
  it('prefers a complete external runtime over a complete private runtime', async () => {
    const externalSnapshot = buildWindowsActiveRuntimeSnapshot({
      configPath: 'C:\\Users\\alice\\.openclaw\\config.json',
      extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
      hostPackageRoot: 'C:\\Program Files\\nodejs\\node_modules\\openclaw',
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      npmPrefix: 'C:\\Program Files\\nodejs',
      openclawExecutable: 'C:\\Program Files\\nodejs\\openclaw.cmd',
      stateDir: 'C:\\Users\\alice\\.openclaw',
    })
    const privateSnapshot = buildWindowsActiveRuntimeSnapshot({
      configPath: 'C:\\Users\\alice\\.openclaw\\config.json',
      extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
      hostPackageRoot: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node_modules\\openclaw',
      nodeExecutable: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe',
      npmPrefix: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1',
      openclawExecutable: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\openclaw.cmd',
      stateDir: 'C:\\Users\\alice\\.openclaw',
      userDataDir: 'C:\\Users\\alice\\AppData\\Local\\Qclaw',
    })

    await expect(
      selectAuthoritativeWindowsActiveRuntimeSnapshot(
        [
          { snapshot: privateSnapshot, isPathActive: false },
          { snapshot: externalSnapshot, isPathActive: true },
        ],
        {
          env: buildTestEnv({
            LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
          }),
          isSnapshotComplete: async () => true,
        }
      )
    ).resolves.toEqual(externalSnapshot)
  })

  it('treats an older Qclaw-managed runtime version under the managed runtime root as private', async () => {
    const externalSnapshot = buildWindowsActiveRuntimeSnapshot({
      configPath: 'C:\\Users\\alice\\.openclaw\\config.json',
      extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
      hostPackageRoot: 'C:\\Program Files\\nodejs\\node_modules\\openclaw',
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      npmPrefix: 'C:\\Program Files\\nodejs',
      openclawExecutable: 'C:\\Program Files\\nodejs\\openclaw.cmd',
      stateDir: 'C:\\Users\\alice\\.openclaw',
    })
    const olderPrivateSnapshot = buildWindowsActiveRuntimeSnapshot({
      configPath: 'C:\\Users\\alice\\.openclaw\\config.json',
      extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
      hostPackageRoot: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v22.9.0\\node_modules\\openclaw',
      nodeExecutable: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v22.9.0\\node.exe',
      npmPrefix: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v22.9.0',
      openclawExecutable: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v22.9.0\\openclaw.cmd',
      stateDir: 'C:\\Users\\alice\\.openclaw',
      userDataDir: 'C:\\Users\\alice\\AppData\\Local\\Qclaw',
    })

    await expect(
      selectAuthoritativeWindowsActiveRuntimeSnapshot(
        [
          { snapshot: olderPrivateSnapshot, isPathActive: true },
          { snapshot: externalSnapshot, isPathActive: false },
        ],
        {
          env: buildTestEnv({
            LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
          }),
          isSnapshotComplete: async () => true,
        }
      )
    ).resolves.toEqual(externalSnapshot)
  })
})

describe('reuseWindowsSelectedRuntimeSnapshotFields', () => {
  it('keeps the existing selected snapshot fields when the runtime has not changed', () => {
    const runtimeSnapshot = buildWindowsActiveRuntimeSnapshot({
      configPath: 'C:\\Users\\alice\\.openclaw\\config.json',
      extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
      hostPackageRoot: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node_modules\\openclaw',
      nodeExecutable: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe',
      npmPrefix: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1',
      openclawExecutable: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\openclaw.cmd',
      stateDir: 'C:\\Users\\alice\\.openclaw',
      userDataDir: 'C:\\Users\\alice\\AppData\\Local\\Qclaw',
    })

    expect(
      reuseWindowsSelectedRuntimeSnapshotFields(runtimeSnapshot, {
        ...buildWindowsSelectedRuntimeSnapshotFields(runtimeSnapshot),
        nodePath: runtimeSnapshot.nodePath.toUpperCase(),
        openclawPath: runtimeSnapshot.openclawPath.toUpperCase(),
        hostPackageRoot: runtimeSnapshot.hostPackageRoot.toUpperCase(),
        stateDir: `${runtimeSnapshot.stateDir}\\`,
      })
    ).toEqual({
      hostPackageRoot: runtimeSnapshot.hostPackageRoot.toUpperCase(),
      nodePath: runtimeSnapshot.nodePath.toUpperCase(),
      openclawPath: runtimeSnapshot.openclawPath.toUpperCase(),
      stateDir: `${runtimeSnapshot.stateDir}\\`,
    })
  })
})

describe('prepareWindowsManagedOpenClawRuntimeCandidate', () => {
  it('produces a verifiable managed runtime candidate without touching selected runtime state', async () => {
    const env = buildTestEnv({
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
      QCLAW_USER_DATA_DIR: 'C:\\Users\\alice\\AppData\\Local\\Qclaw',
    })
    const expectedPaths = resolveWindowsPrivateOpenClawRuntimePaths({ env })
    const expectedMarker = buildWindowsManagedOpenClawRuntimeMarker({ env })

    const result = await prepareWindowsManagedOpenClawRuntimeCandidate(
      {
        configPath: 'C:\\Users\\alice\\.openclaw\\openclaw.json',
        env,
        stateDir: 'C:\\Users\\alice\\.openclaw',
      },
      {
        access: async () => undefined,
        probeVersion: async () => 'OpenClaw 2026.3.24 (cff6dc9)',
        readTextFile: async (targetPath: string) => {
          if (targetPath === expectedPaths.packageJsonPath) {
            return JSON.stringify({
              name: 'openclaw',
              version: '2026.3.24',
            })
          }
          if (targetPath === expectedPaths.runtimeMarkerPath) {
            return JSON.stringify(expectedMarker)
          }
          throw new Error(`unexpected read: ${targetPath}`)
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(result.version).toBe('2026.3.24')
    expect(result.marker).toEqual(expectedMarker)
    expect(result.paths).toEqual(expectedPaths)
    expect(result.snapshot).toMatchObject({
      configPath: 'C:\\Users\\alice\\.openclaw\\openclaw.json',
      extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
      hostPackageRoot: expectedPaths.hostPackageRoot,
      nodePath: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe',
      npmPrefix: expectedPaths.npmPrefix,
      openclawPath: expectedPaths.openclawExecutable,
      stateDir: 'C:\\Users\\alice\\.openclaw',
    })
  })

  it('rejects incomplete managed runtime layouts instead of treating them as healthy', async () => {
    const env = buildTestEnv({
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
    })
    const expectedPaths = resolveWindowsPrivateOpenClawRuntimePaths({ env })
    const missingPath = expectedPaths.runtimeMarkerPath

    const result = await prepareWindowsManagedOpenClawRuntimeCandidate(
      {
        configPath: 'C:\\Users\\alice\\.openclaw\\openclaw.json',
        env,
        stateDir: 'C:\\Users\\alice\\.openclaw',
      },
      {
        access: async (targetPath: string) => {
          if (targetPath === missingPath) {
            throw new Error('missing')
          }
        },
      }
    )

    expect(result.ok).toBe(false)
    expect(result.snapshot).toBeNull()
    expect(result.version).toBeNull()
    expect(result.missingPaths).toContain(missingPath)
  })
})
