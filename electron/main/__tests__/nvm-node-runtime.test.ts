import { describe, expect, it } from 'vitest'

const path = process.getBuiltinModule('node:path') as typeof import('node:path')
import {
  buildNvmInstallCommand,
  buildNvmNodeBinDir,
  buildNvmUseCommand,
  detectNvmDir,
  detectNvmWindowsDir,
  listInstalledNvmNodeBinDirs,
  listInstalledNvmWindowsNodeExePaths,
} from '../nvm-node-runtime'

const TEST_ENV_BASE = {
  APP_ROOT: '/tmp/qclaw-test-app-root',
  VITE_PUBLIC: '/tmp/qclaw-test-public',
} as NodeJS.ProcessEnv

describe('listInstalledNvmNodeBinDirs', () => {
  it('sorts installed nvm Node versions from newest to oldest', async () => {
    const dirs = await listInstalledNvmNodeBinDirs('/Users/alice/.nvm', {
      readdir: async () => [
        { name: 'v22.22.1', isDirectory: () => true },
        { name: 'alias', isDirectory: () => true },
        { name: 'v24.14.0', isDirectory: () => true },
        { name: 'v18.20.8', isDirectory: () => true },
      ],
      pathModule: path.posix,
    })

    expect(dirs).toEqual([
      '/Users/alice/.nvm/versions/node/v24.14.0/bin',
      '/Users/alice/.nvm/versions/node/v22.22.1/bin',
      '/Users/alice/.nvm/versions/node/v18.20.8/bin',
    ])
  })
})

describe('buildNvmInstallCommand', () => {
  it('installs and uses the requested version without mutating the default alias', () => {
    const command = buildNvmInstallCommand('/Users/alice/.nvm', 'v22.22.1')

    expect(command).toContain("source '/Users/alice/.nvm/nvm.sh'")
    expect(command).toContain("nvm install '22.22.1'")
    expect(command).toContain("nvm use '22.22.1'")
    expect(command).not.toContain('alias default')
  })
})

describe('buildNvmUseCommand', () => {
  it('activates an explicit version instead of relying on default alias', () => {
    const command = buildNvmUseCommand('/Users/alice/.nvm', '24.14.0')

    expect(command).toContain("nvm use '24.14.0'")
    expect(command).not.toContain('default')
  })
})

describe('buildNvmNodeBinDir', () => {
  it('normalizes versions to the nvm directory layout', () => {
    expect(buildNvmNodeBinDir('/Users/alice/.nvm', '24.14.0', path.posix)).toBe(
      '/Users/alice/.nvm/versions/node/v24.14.0/bin'
    )
  })
})

describe('detectNvmWindowsDir', () => {
  it('prefers NVM_HOME from the environment', async () => {
    await expect(
      detectNvmWindowsDir({
        env: {
          ...TEST_ENV_BASE,
          NVM_HOME: 'C:\\Users\\Jason\\AppData\\Roaming\\nvm',
        },
      })
    ).resolves.toBe('C:\\Users\\Jason\\AppData\\Roaming\\nvm')
  })

  it('falls back to %APPDATA%\\nvm when NVM_HOME is absent and the directory exists', async () => {
    await expect(
      detectNvmWindowsDir({
        env: {
          ...TEST_ENV_BASE,
          APPDATA: 'C:\\Users\\Jason\\AppData\\Roaming',
        },
        access: async () => undefined,
        pathModule: path.win32,
      })
    ).resolves.toBe('C:\\Users\\Jason\\AppData\\Roaming\\nvm')
  })

  it('returns null when NVM_HOME is absent and %APPDATA%\\nvm does not exist', async () => {
    await expect(
      detectNvmWindowsDir({
        env: {
          ...TEST_ENV_BASE,
          APPDATA: 'C:\\Users\\Jason\\AppData\\Roaming',
        },
        access: async () => {
          throw new Error('ENOENT')
        },
        pathModule: path.win32,
      })
    ).resolves.toBeNull()
  })

  it('returns null when both NVM_HOME and APPDATA are absent', async () => {
    await expect(detectNvmWindowsDir({ env: TEST_ENV_BASE })).resolves.toBeNull()
  })
})

describe('listInstalledNvmWindowsNodeExePaths', () => {
  it('returns node.exe paths sorted from newest to oldest version', async () => {
    const paths = await listInstalledNvmWindowsNodeExePaths(
      'C:\\Users\\Jason\\AppData\\Roaming\\nvm',
      {
        readdir: async () => [
          { name: 'v22.17.1', isDirectory: () => true },
          { name: 'v18.20.8', isDirectory: () => true },
          { name: 'v24.0.0', isDirectory: () => true },
          { name: 'settings.txt', isDirectory: () => false },
        ],
        pathModule: path.win32,
      }
    )

    expect(paths).toEqual([
      'C:\\Users\\Jason\\AppData\\Roaming\\nvm\\v24.0.0\\node.exe',
      'C:\\Users\\Jason\\AppData\\Roaming\\nvm\\v22.17.1\\node.exe',
      'C:\\Users\\Jason\\AppData\\Roaming\\nvm\\v18.20.8\\node.exe',
    ])
  })

  it('returns an empty array when the directory cannot be read', async () => {
    const paths = await listInstalledNvmWindowsNodeExePaths(
      'C:\\Users\\Jason\\AppData\\Roaming\\nvm',
      {
        readdir: async () => {
          throw new Error('ENOENT')
        },
        pathModule: path.win32,
      }
    )

    expect(paths).toEqual([])
  })
})

describe('detectNvmDir', () => {
  it('prefers NVM_DIR from the environment', async () => {
    await expect(
      detectNvmDir({
        env: {
          ...TEST_ENV_BASE,
          NVM_DIR: '/Users/alice/.nvm',
        },
      })
    ).resolves.toBe('/Users/alice/.nvm')
  })

  it('derives the root from NVM_BIN when NVM_DIR is missing', async () => {
    await expect(
      detectNvmDir({
        env: {
          ...TEST_ENV_BASE,
          NVM_BIN: '/Users/alice/.nvm/versions/node/v24.14.0/bin',
        },
      })
    ).resolves.toBe('/Users/alice/.nvm')
  })

  it('falls back to ~/.nvm when nvm.sh exists', async () => {
    await expect(
      detectNvmDir({
        env: TEST_ENV_BASE,
        homedir: () => '/Users/alice',
        access: async () => undefined,
        pathModule: path.posix,
      })
    ).resolves.toBe('/Users/alice/.nvm')
  })
})
