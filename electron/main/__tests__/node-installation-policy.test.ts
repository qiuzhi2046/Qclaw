import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BUNDLED_NODE_REQUIREMENT,
  DEFAULT_NODE_DIST_BASE_URL,
  detectNativeWindowsArch,
  extractMinNodeVersionFromRange,
  resetNodeInstallationPolicyCache,
  resolveNodeInstallPlan,
  resolveOpenClawNodeRequirement,
} from '../node-installation-policy'
import { buildTestEnv } from './test-env'

describe('extractMinNodeVersionFromRange', () => {
  it('extracts the minimum version from supported node engine range shapes', () => {
    expect(extractMinNodeVersionFromRange('>=22.16.0')).toBe('22.16.0')
    expect(extractMinNodeVersionFromRange('>=22.16.0 <25')).toBe('22.16.0')
    expect(extractMinNodeVersionFromRange('^22.16.0')).toBe('22.16.0')
    expect(extractMinNodeVersionFromRange('22.x')).toBe('22.0.0')
    expect(extractMinNodeVersionFromRange('22')).toBe('22.0.0')
  })

  it('returns null when the range cannot be parsed', () => {
    expect(extractMinNodeVersionFromRange('latest')).toBeNull()
    expect(extractMinNodeVersionFromRange('')).toBeNull()
  })
})

describe('detectNativeWindowsArch', () => {
  it('detects arm64 native hardware even when process.arch is x64', () => {
    expect(
      detectNativeWindowsArch(
        'x64',
        buildTestEnv({
          PROCESSOR_ARCHITECTURE: 'AMD64',
          PROCESSOR_ARCHITEW6432: 'ARM64',
        })
      )
    ).toBe('arm64')
  })

  it('falls back to process.arch when native env markers are absent', () => {
    expect(detectNativeWindowsArch('ia32', buildTestEnv())).toBe('x86')
    expect(detectNativeWindowsArch('x64', buildTestEnv())).toBe('x64')
  })
})

describe('resolveOpenClawNodeRequirement', () => {
  it('prefers env override when provided explicitly', async () => {
    const result = await resolveOpenClawNodeRequirement({
      env: buildTestEnv({
        QCLAW_NODE_MIN_VERSION: '20.0.0',
      }),
    })

    expect(result).toEqual({
      minVersion: '20.0.0',
      source: 'env-override',
    })
  })

  it('floors lower OpenClaw package metadata to Qclaw Node 22.19 minimum', async () => {
    const result = await resolveOpenClawNodeRequirement({
      readInstalledOpenClawPackageJson: async () => ({
        engines: {
          node: '>=22.16.0',
        },
      }),
      fetchOpenClawMetadata: async () => ({
        engines: {
          node: '>=24.0.0',
        },
      }),
    })

    expect(result).toEqual({
      minVersion: DEFAULT_BUNDLED_NODE_REQUIREMENT,
      source: 'installed-openclaw-package',
    })
  })

  it('keeps OpenClaw package metadata when it is stricter than Qclaw minimum', async () => {
    const result = await resolveOpenClawNodeRequirement({
      readInstalledOpenClawPackageJson: async () => ({
        engines: {
          node: '>=24.4.0',
        },
      }),
      fetchOpenClawMetadata: async () => ({
        engines: {
          node: '>=24.0.0',
        },
      }),
    })

    expect(result).toEqual({
      minVersion: '24.4.0',
      source: 'installed-openclaw-package',
    })
  })

  it('falls back to bundled requirement when no metadata source is available', async () => {
    const result = await resolveOpenClawNodeRequirement({
      readInstalledOpenClawPackageJson: async () => null,
      fetchOpenClawMetadata: async () => {
        throw new Error('offline')
      },
    })

    expect(result).toEqual({
      minVersion: DEFAULT_BUNDLED_NODE_REQUIREMENT,
      source: 'bundled-fallback',
    })
  })
})

describe('resolveNodeInstallPlan', () => {
  it('prefers the latest stable patch within the required major line', async () => {
    const plan = await resolveNodeInstallPlan({
      platform: 'darwin',
      processArch: 'arm64',
      readInstalledOpenClawPackageJson: async () => ({
        engines: {
          node: '>=22.16.0 <25',
        },
      }),
      fetchNodeDistIndex: async () => [
        { version: 'v24.14.0', lts: 'Krypton', files: ['osx-x64-pkg'] },
        { version: 'v22.22.1', lts: 'Jod', files: ['osx-x64-pkg'] },
        { version: 'v22.21.0', lts: 'Jod', files: ['osx-x64-pkg'] },
      ],
    })

    expect(plan).toMatchObject({
      version: 'v22.22.1',
      requiredVersion: DEFAULT_BUNDLED_NODE_REQUIREMENT,
      source: 'official-dist-index',
      artifactKind: 'pkg',
      installerArch: 'universal',
      filename: 'node-v22.22.1.pkg',
      url: `${DEFAULT_NODE_DIST_BASE_URL}/v22.22.1/node-v22.22.1.pkg`,
    })
  })

  it('uses the Windows x64 zip artifact for private Node runtime installs', async () => {
    const plan = await resolveNodeInstallPlan({
      platform: 'win32',
      processArch: 'x64',
      env: buildTestEnv({
        PROCESSOR_ARCHITECTURE: 'AMD64',
      }),
      readInstalledOpenClawPackageJson: async () => ({
        engines: {
          node: '>=22.16.0',
        },
      }),
    })

    expect(plan).toMatchObject({
      version: 'v24.14.1',
      requiredVersion: DEFAULT_BUNDLED_NODE_REQUIREMENT,
      source: 'bundled-fallback',
      artifactKind: 'zip',
      platform: 'win32',
      detectedArch: 'x64',
      installerArch: 'x64',
      filename: 'node-v24.14.1-win-x64.zip',
      url: `${DEFAULT_NODE_DIST_BASE_URL}/v24.14.1/node-v24.14.1-win-x64.zip`,
    })
  })

  it('uses the Windows arm64 zip artifact for private Node runtime installs', async () => {
    const plan = await resolveNodeInstallPlan({
      platform: 'win32',
      processArch: 'x64',
      env: buildTestEnv({
        PROCESSOR_ARCHITECTURE: 'AMD64',
        PROCESSOR_ARCHITEW6432: 'ARM64',
      }),
      readInstalledOpenClawPackageJson: async () => ({
        engines: {
          node: '>=22.16.0',
        },
      }),
    })

    expect(plan).toMatchObject({
      version: 'v24.14.1',
      requiredVersion: DEFAULT_BUNDLED_NODE_REQUIREMENT,
      source: 'bundled-fallback',
      artifactKind: 'zip',
      platform: 'win32',
      detectedArch: 'arm64',
      installerArch: 'arm64',
      filename: 'node-v24.14.1-win-arm64.zip',
      url: `${DEFAULT_NODE_DIST_BASE_URL}/v24.14.1/node-v24.14.1-win-arm64.zip`,
    })
  })

  it('skips dynamic OpenClaw requirement probing for Windows bootstrap install plans', async () => {
    const readInstalledOpenClawPackageJson = vi.fn(async () => {
      throw new Error('openclaw command lookup should not run')
    })
    const fetchOpenClawMetadata = vi.fn(async () => {
      throw new Error('openclaw registry lookup should not run')
    })

    const plan = await resolveNodeInstallPlan({
      platform: 'win32',
      processArch: 'x64',
      env: buildTestEnv({
        PROCESSOR_ARCHITECTURE: 'AMD64',
      }),
      readInstalledOpenClawPackageJson,
      fetchOpenClawMetadata,
      skipDynamicOpenClawRequirementProbe: true,
    })

    expect(readInstalledOpenClawPackageJson).not.toHaveBeenCalled()
    expect(fetchOpenClawMetadata).not.toHaveBeenCalled()
    expect(plan).toMatchObject({
      version: 'v24.14.1',
      requiredVersion: DEFAULT_BUNDLED_NODE_REQUIREMENT,
      requirementSource: 'bundled-fallback',
      platform: 'win32',
      artifactKind: 'zip',
      filename: 'node-v24.14.1-win-x64.zip',
    })
  })

  it('uses env overrides for version and base URL', async () => {
    const plan = await resolveNodeInstallPlan({
      platform: 'win32',
      processArch: 'x64',
      env: buildTestEnv({
        QCLAW_NODE_INSTALL_VERSION: 'v20.20.1',
        QCLAW_NODE_DIST_BASE_URL: 'https://mirror.example.com/node',
        QCLAW_NODE_MIN_VERSION: '20.0.0',
      }),
      readInstalledOpenClawPackageJson: async () => null,
    })

    expect(plan).toMatchObject({
      version: 'v20.20.1',
      requiredVersion: '20.0.0',
      source: 'env-override',
      artifactKind: 'zip',
      filename: 'node-v20.20.1-win-x64.zip',
      url: 'https://mirror.example.com/node/v20.20.1/node-v20.20.1-win-x64.zip',
    })
  })

  it('rejects Windows x86 private Node zip plans', async () => {
    await expect(
      resolveNodeInstallPlan({
        platform: 'win32',
        processArch: 'ia32',
        env: buildTestEnv({
          PROCESSOR_ARCHITECTURE: 'x86',
        }),
        readInstalledOpenClawPackageJson: async () => ({
          engines: {
            node: '>=24.14.1',
          },
        }),
      })
    ).rejects.toThrow('Unsupported Windows Node zip architecture: x86')
  })

  it('falls back to a bundled LTS release when the remote dist index is unavailable', async () => {
    const plan = await resolveNodeInstallPlan({
      platform: 'darwin',
      processArch: 'arm64',
      readInstalledOpenClawPackageJson: async () => ({
        engines: {
          node: '>=22.16.0',
        },
      }),
      fetchNodeDistIndex: async () => {
        throw new Error('nodejs.org blocked')
      },
    })

    expect(plan).toMatchObject({
      version: 'v22.22.1',
      requiredVersion: DEFAULT_BUNDLED_NODE_REQUIREMENT,
      source: 'bundled-fallback',
      artifactKind: 'pkg',
      installerArch: 'universal',
      filename: 'node-v22.22.1.pkg',
      url: `${DEFAULT_NODE_DIST_BASE_URL}/v22.22.1/node-v22.22.1.pkg`,
    })
  })

  it('refreshes the default cached plan when env overrides change after a bundled fallback', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return

    const originalInstallVersion = process.env.QCLAW_NODE_INSTALL_VERSION
    const originalMinVersion = process.env.QCLAW_NODE_MIN_VERSION
    const originalDistBaseUrl = process.env.QCLAW_NODE_DIST_BASE_URL

    resetNodeInstallationPolicyCache()
    delete process.env.QCLAW_NODE_INSTALL_VERSION
    process.env.QCLAW_NODE_MIN_VERSION = '22.16.0'
    process.env.QCLAW_NODE_DIST_BASE_URL = 'http://127.0.0.1:1'

    try {
      const fallbackPlan = await resolveNodeInstallPlan()

      if (process.platform === 'win32') {
        expect(fallbackPlan).toMatchObject({
          version: 'v24.14.1',
          source: 'bundled-fallback',
          requiredVersion: '22.16.0',
          artifactKind: 'zip',
        })
      } else {
        expect(fallbackPlan).toMatchObject({
          version: 'v22.22.1',
          source: 'bundled-fallback',
          requiredVersion: '22.16.0',
          artifactKind: 'pkg',
        })
      }

      process.env.QCLAW_NODE_INSTALL_VERSION = '24.14.0'
      const plan = await resolveNodeInstallPlan()

      expect(plan).toMatchObject({
        version: 'v24.14.0',
        source: 'env-override',
        requiredVersion: '22.16.0',
        artifactKind: process.platform === 'win32' ? 'zip' : 'pkg',
      })
    } finally {
      resetNodeInstallationPolicyCache()
      if (originalInstallVersion === undefined) {
        delete process.env.QCLAW_NODE_INSTALL_VERSION
      } else {
        process.env.QCLAW_NODE_INSTALL_VERSION = originalInstallVersion
      }
      if (originalMinVersion === undefined) {
        delete process.env.QCLAW_NODE_MIN_VERSION
      } else {
        process.env.QCLAW_NODE_MIN_VERSION = originalMinVersion
      }
      if (originalDistBaseUrl === undefined) {
        delete process.env.QCLAW_NODE_DIST_BASE_URL
      } else {
        process.env.QCLAW_NODE_DIST_BASE_URL = originalDistBaseUrl
      }
    }
  })
})
