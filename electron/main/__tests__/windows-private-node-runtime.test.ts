import { describe, expect, it, vi } from 'vitest'
import {
  ensureWindowsPrivateNodeRuntime,
  verifyNodeZipChecksum,
  type WindowsPrivateNodeInstallPlan,
} from '../platforms/windows/windows-private-node-runtime'
import { buildTestEnv } from './test-env'

function makePlan(): WindowsPrivateNodeInstallPlan {
  return {
    artifactKind: 'zip',
    detectedArch: 'x64',
    distBaseUrl: 'https://nodejs.org/dist',
    filename: 'node-v24.14.1-win-x64.zip',
    installerArch: 'x64',
    platform: 'win32',
    requiredVersion: '24.14.1',
    requirementSource: 'bundled-fallback',
    source: 'bundled-fallback',
    url: 'https://nodejs.org/dist/v24.14.1/node-v24.14.1-win-x64.zip',
    version: 'v24.14.1',
  }
}

describe('verifyNodeZipChecksum', () => {
  it('rejects a zip when the checksum does not match', () => {
    const ok = verifyNodeZipChecksum({
      filename: 'node-v24.14.1-win-x64.zip',
      shaSumsText:
        '0000000000000000000000000000000000000000000000000000000000000000  node-v24.14.1-win-x64.zip',
      zipSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })

    expect(ok).toBe(false)
  })

  it('accepts a zip when the checksum matches', () => {
    const ok = verifyNodeZipChecksum({
      filename: 'node-v24.14.1-win-x64.zip',
      shaSumsText:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v24.14.1-win-x64.zip',
      zipSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })

    expect(ok).toBe(true)
  })
})

describe('ensureWindowsPrivateNodeRuntime', () => {
  it('returns an existing private node runtime without downloading again', async () => {
    const downloadFile = vi.fn(async () => {
      throw new Error('download should not be called')
    })
    const runPowerShell = vi.fn(async () => {
      throw new Error('powershell should not be called')
    })

    const result = await ensureWindowsPrivateNodeRuntime(
      {
        plan: makePlan(),
        downloadFile,
        env: buildTestEnv({
          LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        }),
        runPowerShell,
        timeoutMs: 1,
      },
      {
        access: async () => undefined,
      }
    )

    expect(result.ok).toBe(true)
    expect(result.nodeBinDir).toBe('C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1')
    expect(result.nodeExecutable).toBe(
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe'
    )
    expect(result.npmExecutable).toBe(
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\npm.cmd'
    )
    expect(result.pathPrefix).toBe(
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1'
    )
    expect(downloadFile).not.toHaveBeenCalled()
    expect(runPowerShell).not.toHaveBeenCalled()
  })

  it('rejects a corrupt zip when the checksum entry does not match', async () => {
    const downloadFile = vi.fn(async () => undefined)
    const runPowerShell = vi.fn(async () => {
      throw new Error('powershell should not be called')
    })
    const access = vi.fn(async () => {
      throw new Error('missing')
    })

    const result = await ensureWindowsPrivateNodeRuntime(
      {
        plan: makePlan(),
        downloadFile,
        env: buildTestEnv({
          LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        }),
        runPowerShell,
        timeoutMs: 1,
      },
      {
        access,
        mkdir: vi.fn(async () => undefined),
        readTextFile: vi.fn(async () =>
          '0000000000000000000000000000000000000000000000000000000000000000  node-v24.14.1-win-x64.zip'
        ),
        rename: vi.fn(async () => undefined),
        rm: vi.fn(async () => undefined),
        sha256File: vi.fn(async () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      }
    )

    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('checksum mismatch')
    expect(runPowerShell).not.toHaveBeenCalled()
  })

  it('extracts and publishes the private node runtime into the Qclaw runtime root', async () => {
    const downloadFile = vi.fn(async () => undefined)
    const runPowerShell = vi.fn(async (command: string, args: string[]) => {
      expect(command).toBe('powershell')
      expect(args.join(' ')).toContain('Expand-Archive')
      return {
        ok: true,
        stdout: '',
        stderr: '',
        code: 0,
      }
    })
    let accessCount = 0
    const access = vi.fn(async () => {
      accessCount += 1
      if (accessCount === 1) {
        throw new Error('missing')
      }
      return undefined
    })
    const rename = vi.fn(async () => undefined)
    const rm = vi.fn(async () => undefined)
    const mkdir = vi.fn(async () => undefined)

    const result = await ensureWindowsPrivateNodeRuntime(
      {
        plan: makePlan(),
        downloadFile,
        env: buildTestEnv({
          LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        }),
        runPowerShell,
        timeoutMs: 1,
      },
      {
        access,
        mkdir,
        readTextFile: vi.fn(async () =>
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v24.14.1-win-x64.zip'
        ),
        rename,
        rm,
        sha256File: vi.fn(async () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      }
    )

    expect(result.ok).toBe(true)
    expect(result.nodeBinDir).toBe('C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1')
    expect(result.nodeExecutable).toBe(
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe'
    )
    expect(result.npmExecutable).toBe(
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\npm.cmd'
    )
    expect(downloadFile).toHaveBeenCalledTimes(2)
    expect(runPowerShell).toHaveBeenCalledTimes(1)
    expect(mkdir).toHaveBeenCalledWith(
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\.staging',
      { recursive: true }
    )
    expect(rename).toHaveBeenNthCalledWith(
      1,
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\.downloads\\v24.14.1\\node-v24.14.1-win-x64\\node-v24.14.1-win-x64',
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\.staging\\v24.14.1'
    )
    expect(rename).toHaveBeenNthCalledWith(
      2,
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\.staging\\v24.14.1',
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1'
    )
    expect(rm).toHaveBeenCalledWith(
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1',
      { force: true, recursive: true }
    )
  })

  it('rejects non-zip plans with a clear error', async () => {
    const result = await ensureWindowsPrivateNodeRuntime(
      {
        plan: {
          ...makePlan(),
          artifactKind: 'pkg',
        },
        downloadFile: vi.fn(async () => undefined),
        env: buildTestEnv({
          LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        }),
        runPowerShell: vi.fn(async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
        })),
        timeoutMs: 1,
      },
      {
        access: vi.fn(async () => undefined),
      }
    )

    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('requires a zip plan')
  })
})
