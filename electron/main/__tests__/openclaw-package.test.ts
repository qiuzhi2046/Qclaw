import { afterEach, describe, expect, it } from 'vitest'
import * as openClawPackage from '../openclaw-package'
import {
  getCommandPathLookupInvocation,
  readOpenClawPackageInfo,
  resolveOpenClawBinaryPath,
  resolveOpenClawPackageRoot,
} from '../openclaw-package'
import { buildTestEnv } from './test-env'

const fs = process.getBuiltinModule('fs') as typeof import('node:fs')
const os = process.getBuiltinModule('os') as typeof import('node:os')
const path = process.getBuiltinModule('path') as typeof import('node:path')

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qclaw-openclaw-package-'))
  tempDirs.push(dir)
  return dir
}

function buildComparablePathVariants(targetPath: string): Set<string> {
  const variants = new Set<string>()
  const normalizedInput = String(targetPath || '').trim()
  if (!normalizedInput) return variants

  const addVariant = (value: string) => {
    const normalized = path.normalize(String(value || '').trim())
    if (!normalized) return
    variants.add(process.platform === 'win32' ? normalized.toLowerCase() : normalized)
  }

  addVariant(path.resolve(normalizedInput))

  try {
    addVariant(fs.realpathSync(normalizedInput))
  } catch {
    // Ignore resolution failures and keep the remaining variants.
  }

  if (typeof fs.realpathSync.native === 'function') {
    try {
      addVariant(fs.realpathSync.native(normalizedInput))
    } catch {
      // Ignore native resolution failures and keep the remaining variants.
    }
  }

  return variants
}

function expectSameResolvedLocation(actualPath: string, expectedPath: string): void {
  const actualVariants = buildComparablePathVariants(actualPath)
  const expectedVariants = buildComparablePathVariants(expectedPath)
  const sharedVariant = Array.from(actualVariants).find((candidate) => expectedVariants.has(candidate))
  expect(sharedVariant).toBeDefined()
}

function createFakeOpenClawInstall(): {
  tempDir: string
  commandPath: string
  packageRoot: string
  packageJsonPath: string
} {
  const tempDir = makeTempDir()
  const packageRoot = path.join(tempDir, 'lib', 'node_modules', 'openclaw')
  const binDir = path.join(tempDir, 'bin')
  fs.mkdirSync(packageRoot, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })

  const packageJsonPath = path.join(packageRoot, 'package.json')
  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify(
      {
        name: 'openclaw',
        version: '2026.3.8',
        bin: { openclaw: 'openclaw.mjs' },
      },
      null,
      2
    )
  )
  fs.writeFileSync(path.join(packageRoot, 'openclaw.mjs'), '#!/usr/bin/env node\nconsole.log("openclaw")\n')

  const commandPath = path.join(binDir, 'openclaw')
  fs.symlinkSync(path.join(packageRoot, 'openclaw.mjs'), commandPath)

  return { tempDir, commandPath, packageRoot, packageJsonPath }
}

function createNestedBinaryOpenClawInstall(): {
  tempDir: string
  commandPath: string
  packageRoot: string
  packageJsonPath: string
} {
  const tempDir = makeTempDir()
  const packageRoot = path.join(tempDir, 'lib', 'node_modules', 'openclaw')
  const nestedBinDir = path.join(packageRoot, 'bin')
  const shimDir = path.join(tempDir, 'bin')
  fs.mkdirSync(packageRoot, { recursive: true })
  fs.mkdirSync(nestedBinDir, { recursive: true })
  fs.mkdirSync(shimDir, { recursive: true })

  const packageJsonPath = path.join(packageRoot, 'package.json')
  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify(
      {
        name: 'openclaw',
        version: '2026.3.8',
        bin: { openclaw: 'bin/openclaw.mjs' },
      },
      null,
      2
    )
  )
  fs.writeFileSync(path.join(nestedBinDir, 'openclaw.mjs'), '#!/usr/bin/env node\nconsole.log("openclaw")\n')

  const commandPath = path.join(shimDir, 'openclaw')
  fs.symlinkSync(path.join(nestedBinDir, 'openclaw.mjs'), commandPath)

  return { tempDir, commandPath, packageRoot, packageJsonPath }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveOpenClawBinaryPath', () => {
  it('resolves the binary path via command lookup', async () => {
    const install = createFakeOpenClawInstall()

    const resolved = await resolveOpenClawBinaryPath({
      commandPathResolver: async (commandName) => {
        expect(commandName).toBe('openclaw')
        return install.commandPath
      },
    })

    expect(resolved).toBe(install.commandPath)
  })

  it('falls back to the Windows APPDATA npm shim when where.exe lookup fails', async () => {
    const fallbackBinary = 'C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw.cmd'

    const resolved = await resolveOpenClawBinaryPath({
      commandPathResolver: async () => {
        throw new Error('INFO: Could not find files for the given pattern(s).')
      },
      platform: 'win32',
      env: buildTestEnv({
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
      }),
      fileExists: (candidate: string) => candidate === fallbackBinary,
    })

    expect(resolved).toBe(fallbackBinary)
  })

  it('returns an actionable message when command lookup cannot find openclaw', async () => {
    await expect(
      resolveOpenClawBinaryPath({
        commandPathResolver: async () => {
          throw new Error('INFO: Could not find files for the given pattern(s).')
        },
        platform: 'win32',
        env: buildTestEnv(),
        fileExists: () => false,
      })
    ).rejects.toThrow(/Unable to locate the openclaw command/i)
  })

  it('prefers npm prefix bins before static fallback directories when command lookup misses', async () => {
    const resolved = await resolveOpenClawBinaryPath({
      commandPathResolver: async () => {
        throw new Error('openclaw: command not found')
      },
      npmPrefixResolver: async () => '/Users/alice/.volta/tools/image',
      platform: 'darwin',
      env: buildTestEnv({
        HOME: '/Users/alice',
      }),
      fileExists: (candidate: string) => candidate === '/Users/alice/.volta/tools/image/bin/openclaw',
    })

    expect(resolved).toBe('/Users/alice/.volta/tools/image/bin/openclaw')
  })

  it('derives a deterministic openclaw binary path directly from an npm global prefix', async () => {
    const install = createFakeOpenClawInstall()

    const resolved = await (openClawPackage as any).resolveOpenClawBinaryPathFromNpmPrefix({
      npmPrefix: install.tempDir,
      platform: 'darwin',
      env: buildTestEnv({
        HOME: '/Users/alice',
      }),
    })

    expect(resolved.replaceAll('/', path.sep)).toBe(install.commandPath)
  })
})

describe('getCommandPathLookupInvocation', () => {
  it('uses where.exe on Windows instead of /bin/sh', () => {
    const invocation = getCommandPathLookupInvocation('openclaw', 'win32')
    expect(invocation).toEqual({
      command: 'where.exe',
      args: ['openclaw'],
      shell: false,
    })
  })

  it('uses POSIX shell command lookup on non-Windows platforms', () => {
    const invocation = getCommandPathLookupInvocation('openclaw', {
      platform: 'darwin',
      env: buildTestEnv({ SHELL: '/bin/zsh' }),
    })
    expect(invocation.command).toBe('/bin/zsh')
    expect(invocation.args[0]).toBe('-lc')
    expect(invocation.args[1]).toContain('command -v')
    expect(invocation.shell).toBe(false)
  })
})

describe('resolveOpenClawPackageRoot', () => {
  it('resolves the package root from the actual openclaw binary path', async () => {
    const install = createFakeOpenClawInstall()

    const packageRoot = await resolveOpenClawPackageRoot({
      binaryPath: install.commandPath,
    })

    expectSameResolvedLocation(packageRoot, install.packageRoot)
  })

  it('walks parent directories when the resolved binary lives under a package bin subdirectory', async () => {
    const install = createNestedBinaryOpenClawInstall()

    const packageRoot = await resolveOpenClawPackageRoot({
      binaryPath: install.commandPath,
    })

    expectSameResolvedLocation(packageRoot, install.packageRoot)
  })

  it('rejects malformed layouts that do not contain an adjacent openclaw package.json', async () => {
    const tempDir = makeTempDir()
    const fakeBinary = path.join(tempDir, 'openclaw')
    fs.writeFileSync(fakeBinary, '#!/usr/bin/env node\n')

    await expect(
      resolveOpenClawPackageRoot({
        binaryPath: fakeBinary,
      })
    ).rejects.toThrow(/package\.json/i)
  })
})

describe('readOpenClawPackageInfo', () => {
  it('reads version information from the resolved package.json', async () => {
    const install = createFakeOpenClawInstall()

    const info = await readOpenClawPackageInfo({
      binaryPath: install.commandPath,
    })

    expect(info.name).toBe('openclaw')
    expect(info.version).toBe('2026.3.8')
    expect(info.binaryPath).toBe(install.commandPath)
    expectSameResolvedLocation(info.packageRoot, install.packageRoot)
    expectSameResolvedLocation(info.packageJsonPath, install.packageJsonPath)
    expectSameResolvedLocation(info.resolvedBinaryPath, path.join(install.packageRoot, 'openclaw.mjs'))
  })
})
