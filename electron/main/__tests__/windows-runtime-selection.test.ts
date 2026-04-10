import { describe, expect, it } from 'vitest'
import {
  classifyWindowsActiveRuntimeSnapshotFamily,
  rankWindowsActiveRuntimeDiscoveryCandidates,
} from '../platforms/windows/windows-runtime-selection'
import type { WindowsActiveRuntimeSnapshot } from '../platforms/windows/windows-runtime-policy'
import { buildTestEnv } from './test-env'

function buildSnapshot(input: Partial<WindowsActiveRuntimeSnapshot>): WindowsActiveRuntimeSnapshot {
  return {
    configPath: 'C:\\Users\\alice\\.openclaw\\openclaw.json',
    extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
    hostPackageRoot: '',
    logsDir: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\logs',
    nodePath: '',
    npmPrefix: '',
    openclawPath: '',
    stateDir: 'C:\\Users\\alice\\.openclaw',
    tmpDir: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\tmp',
    ...input,
  }
}

describe('classifyWindowsActiveRuntimeSnapshotFamily', () => {
  it('recognizes the private runtime snapshot by its private node and host roots', () => {
    const env = buildTestEnv({
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
    })

    const family = classifyWindowsActiveRuntimeSnapshotFamily(
      buildSnapshot({
        nodePath: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe',
        openclawPath: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\openclaw.cmd',
        hostPackageRoot:
          'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node_modules\\openclaw',
      }),
      { env }
    )

    expect(family).toBe('private')
  })

  it('treats a global runtime snapshot as external', () => {
    const env = buildTestEnv({
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
    })

    const family = classifyWindowsActiveRuntimeSnapshotFamily(
      buildSnapshot({
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        openclawPath: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw.cmd',
        hostPackageRoot: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\openclaw',
      }),
      { env }
    )

    expect(family).toBe('external')
  })
})

describe('rankWindowsActiveRuntimeDiscoveryCandidates', () => {
  it('prefers a complete external runtime over an active private runtime', () => {
    const env = buildTestEnv({
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
    })

    const ranked = rankWindowsActiveRuntimeDiscoveryCandidates(
      [
        {
          isPathActive: true,
          snapshot: buildSnapshot({
            nodePath: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe',
            openclawPath: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\openclaw.cmd',
            hostPackageRoot:
              'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node_modules\\openclaw',
          }),
        },
        {
          isPathActive: false,
          snapshot: buildSnapshot({
            nodePath: 'C:\\Program Files\\nodejs\\node.exe',
            openclawPath: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw.cmd',
            hostPackageRoot: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\openclaw',
          }),
        },
      ],
      { env }
    )

    expect(classifyWindowsActiveRuntimeSnapshotFamily(ranked[0].snapshot, { env })).toBe('external')
    expect(ranked[0].snapshot.openclawPath).toBe('C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw.cmd')
    expect(classifyWindowsActiveRuntimeSnapshotFamily(ranked[1].snapshot, { env })).toBe('private')
  })
})
