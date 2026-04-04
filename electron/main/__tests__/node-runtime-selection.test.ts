import { describe, expect, it } from 'vitest'
import {
  resolveNodeInstallStrategy,
  selectPreferredNodeRuntime,
  shouldFallbackToInstallerAfterNvmInstall,
} from '../node-runtime-selection'

describe('resolveNodeInstallStrategy', () => {
  it('recognizes nvm-managed bin directories', () => {
    expect(
      resolveNodeInstallStrategy(
        '/Users/alice/.nvm/versions/node/v24.14.0/bin',
        '/Users/alice/.nvm'
      )
    ).toBe('nvm')
    expect(
      resolveNodeInstallStrategy(
        '/Users/alice/.nvm/alias/default/bin',
        '/Users/alice/.nvm'
      )
    ).toBe('nvm')
  })

  it('treats non-nvm paths as installer-managed runtimes', () => {
    expect(
      resolveNodeInstallStrategy(
        '/usr/local/bin',
        '/Users/alice/.nvm'
      )
    ).toBe('installer')
  })

  it('recognizes nvm-windows version directories on Windows', () => {
    expect(
      resolveNodeInstallStrategy(
        'C:\\Users\\Jason\\AppData\\Roaming\\nvm\\v22.17.1',
        'C:\\Users\\Jason\\AppData\\Roaming\\nvm'
      )
    ).toBe('nvm')
  })

  it('treats non-nvm Windows paths as installer-managed', () => {
    expect(
      resolveNodeInstallStrategy(
        'C:\\Program Files\\nodejs',
        'C:\\Users\\Jason\\AppData\\Roaming\\nvm'
      )
    ).toBe('installer')
  })

  it('recognizes nvm even when Windows path casing differs', () => {
    expect(
      resolveNodeInstallStrategy(
        'C:\\Users\\Jason\\AppData\\Roaming\\NVM\\v22.17.1',
        'c:\\users\\jason\\appdata\\roaming\\nvm'
      )
    ).toBe('nvm')
  })
})

describe('selectPreferredNodeRuntime', () => {
  it('prefers a newer installed nvm runtime over an older shell node', () => {
    const selected = selectPreferredNodeRuntime({
      shellNode: {
        version: 'v20.11.1',
        binDir: '/usr/local/bin',
      },
      nvmNode: {
        version: 'v24.14.0',
        binDir: '/Users/alice/.nvm/versions/node/v24.14.0/bin',
      },
      requiredVersion: '22.16.0',
      nvmDir: '/Users/alice/.nvm',
    })

    expect(selected).toEqual({
      candidate: {
        version: 'v24.14.0',
        binDir: '/Users/alice/.nvm/versions/node/v24.14.0/bin',
      },
      installStrategy: 'nvm',
    })
  })

  it('prefers nvm-windows node over an older shell node on Windows', () => {
    const selected = selectPreferredNodeRuntime({
      shellNode: {
        version: 'v20.11.1',
        binDir: 'C:\\Program Files\\nodejs',
      },
      nvmNode: {
        version: 'v24.0.0',
        binDir: 'C:\\Users\\Jason\\AppData\\Roaming\\nvm\\v24.0.0',
      },
      requiredVersion: '22.16.0',
      nvmDir: 'C:\\Users\\Jason\\AppData\\Roaming\\nvm',
    })

    expect(selected).toEqual({
      candidate: {
        version: 'v24.0.0',
        binDir: 'C:\\Users\\Jason\\AppData\\Roaming\\nvm\\v24.0.0',
      },
      installStrategy: 'nvm',
    })
  })

  it('keeps a healthy shell runtime when nvm only has an older version', () => {
    const selected = selectPreferredNodeRuntime({
      shellNode: {
        version: 'v24.14.0',
        binDir: '/usr/local/bin',
      },
      nvmNode: {
        version: 'v22.15.0',
        binDir: '/Users/alice/.nvm/versions/node/v22.15.0/bin',
      },
      requiredVersion: '22.16.0',
      nvmDir: '/Users/alice/.nvm',
    })

    expect(selected).toEqual({
      candidate: {
        version: 'v24.14.0',
        binDir: '/usr/local/bin',
      },
      installStrategy: 'installer',
    })
  })
})

describe('shouldFallbackToInstallerAfterNvmInstall', () => {
  it('does not fall back when the nvm install was canceled', () => {
    expect(shouldFallbackToInstallerAfterNvmInstall({ ok: false, canceled: true })).toBe(false)
  })

  it('falls back only for real nvm install failures', () => {
    expect(shouldFallbackToInstallerAfterNvmInstall({ ok: false, canceled: false })).toBe(true)
    expect(shouldFallbackToInstallerAfterNvmInstall({ ok: true, canceled: false })).toBe(false)
  })
})
