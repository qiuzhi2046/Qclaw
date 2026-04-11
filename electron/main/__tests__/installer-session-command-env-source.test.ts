import { afterEach, describe, expect, it } from 'vitest'
import { clearDetectedNodeBinDir, setDetectedNodeBinDir } from '../detected-node-bin'
import { probePlatformCommandCapability, resetCommandCapabilityCacheForTests } from '../command-capabilities'
import { buildInstallerCommandEnv } from '../installer-command-env'
import { buildWindowsActiveRuntimeSnapshot } from '../platforms/windows/windows-runtime-policy'
import {
  clearSelectedWindowsActiveRuntimeSnapshot,
  setSelectedWindowsActiveRuntimeSnapshot,
} from '../windows-active-runtime'
import { buildTestEnv } from './test-env'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('installer session command env behavior', () => {
  afterEach(() => {
    clearDetectedNodeBinDir()
    clearSelectedWindowsActiveRuntimeSnapshot()
    resetCommandCapabilityCacheForTests()
  })

  it('allows Windows npx probing through the selected runtime snapshot npm prefix', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qclaw-installer-snapshot-'))
    const npmPrefix = path.join(runtimeRoot, 'npm')
    const nodeBinDir = path.join(runtimeRoot, 'node')
    fs.mkdirSync(npmPrefix, { recursive: true })
    fs.mkdirSync(nodeBinDir, { recursive: true })

    const npxPath = path.join(npmPrefix, 'npx.cmd')
    fs.writeFileSync(npxPath, '@echo off\r\necho shim\r\n')

    setSelectedWindowsActiveRuntimeSnapshot(
      buildWindowsActiveRuntimeSnapshot({
        openclawExecutable: path.join(npmPrefix, 'openclaw.cmd'),
        nodeExecutable: path.join(nodeBinDir, 'node.exe'),
        npmPrefix,
        configPath: 'C:\\Users\\alice\\.openclaw\\openclaw.json',
        stateDir: 'C:\\Users\\alice\\.openclaw',
        extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
      })
    )

    try {
      const env = buildInstallerCommandEnv({
        platform: 'win32',
        env: buildTestEnv({ PATH: 'C:\\Windows\\System32' }),
      })

      const capability = await probePlatformCommandCapability('npx', {
        platform: 'win32',
        env,
      })

      expect(capability.available).toBe(true)
      expect(capability.resolvedPath?.toLowerCase()).toBe(npxPath.toLowerCase())
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true })
    }
  })

  it('allows Windows npx probing through the detected node bin directory hint', async () => {
    const nodeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qclaw-installer-detected-node-'))
    const npxPath = path.join(nodeBinDir, 'npx.cmd')
    fs.writeFileSync(npxPath, '@echo off\r\necho shim\r\n')
    setDetectedNodeBinDir(nodeBinDir)

    try {
      const env = buildInstallerCommandEnv({
        platform: 'win32',
        env: buildTestEnv({ PATH: 'C:\\Windows\\System32' }),
      })

      const capability = await probePlatformCommandCapability('npx', {
        platform: 'win32',
        env,
      })

      expect(capability.available).toBe(true)
      expect(capability.resolvedPath?.toLowerCase()).toBe(npxPath.toLowerCase())
    } finally {
      fs.rmSync(nodeBinDir, { recursive: true, force: true })
    }
  })
})
