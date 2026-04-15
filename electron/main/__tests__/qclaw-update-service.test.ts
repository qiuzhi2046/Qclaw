import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '2.2.0',
    getAppPath: () => 'D:/Qclaw_Dev/Qclaw',
    isPackaged: false,
  },
  shell: {
    openExternal: vi.fn(),
  },
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    getFeedURL: vi.fn(() => ''),
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}))

import {
  extractPublishUrlFromAppUpdateYaml,
  extractPublishUrlFromBuilderConfig,
  looksPlaceholderPublishUrl,
  resolveConfigurationStateFromBuilderConfig,
  resolveConfigurationStateFromPackagedYaml,
} from '../qclaw-update-config'

describe('qclaw update service configuration detection', () => {
  it('treats placeholder publish urls as not configured', () => {
    expect(looksPlaceholderPublishUrl('https://example.invalid/qclaw-lite/updates/latest')).toBe(true)
    expect(looksPlaceholderPublishUrl('https://example.com/download')).toBe(true)
    expect(looksPlaceholderPublishUrl('')).toBe(true)
  })

  it('treats non-placeholder publish urls as potentially configured', () => {
    expect(looksPlaceholderPublishUrl('https://updates.qclaw.test/releases/latest')).toBe(false)
    expect(looksPlaceholderPublishUrl('https://qclaw-lite.oss-cn-shenzhen.aliyuncs.com/beta/current/')).toBe(false)
  })

  it('extracts publish urls from builder config objects and strings', () => {
    expect(
      extractPublishUrlFromBuilderConfig({
        publish: {
          url: 'https://updates.qclaw.test/releases/latest',
        },
      })
    ).toBe('https://updates.qclaw.test/releases/latest')

    expect(
      extractPublishUrlFromBuilderConfig({
        publish: 'https://updates.qclaw.test/releases/latest',
      })
    ).toBe('https://updates.qclaw.test/releases/latest')
  })

  it('extracts and unquotes publish urls from packaged app-update yaml', () => {
    const raw = [
      'provider: generic',
      'url: "https://updates.qclaw.test/releases/latest"',
      'channel: latest',
    ].join('\n')

    expect(extractPublishUrlFromAppUpdateYaml(raw)).toBe('https://updates.qclaw.test/releases/latest')
  })

  it('marks builder config with placeholder source as not configured', () => {
    expect(
      resolveConfigurationStateFromBuilderConfig({
        appId: 'com.qclawai.qclaw',
        publish: {
          url: 'https://example.invalid/qclaw-lite/updates/latest',
        },
      })
    ).toEqual({
      supported: true,
      configured: false,
      message: '当前仍是占位发布配置，Qclaw 自动更新尚未启用。',
    })
  })

  it('marks builder config with real source as dev-only verification required', () => {
    expect(
      resolveConfigurationStateFromBuilderConfig({
        appId: 'com.qclawai.qclaw',
        publish: {
          url: 'https://updates.qclaw.test/releases/latest',
        },
      })
    ).toEqual({
      supported: true,
      configured: false,
      message: '当前为开发环境，Qclaw 自动更新需在打包产物中验证。',
    })
  })

  it('marks packaged yaml with placeholder source as not configured', () => {
    const raw = [
      'provider: generic',
      'url: https://example.invalid/qclaw-lite/updates/latest',
      'channel: latest',
    ].join('\n')

    expect(resolveConfigurationStateFromPackagedYaml(raw)).toEqual({
      supported: true,
      configured: false,
      message: '当前打包产物仍使用占位更新源，Qclaw 自动更新尚未启用。',
    })
  })

  it('marks packaged yaml with real source as configured', () => {
    const raw = [
      'provider: generic',
      'url: https://updates.qclaw.test/releases/latest',
      'channel: latest',
    ].join('\n')

    expect(resolveConfigurationStateFromPackagedYaml(raw)).toEqual({
      supported: true,
      configured: true,
      message: 'Qclaw 自动更新已就绪。',
    })
  })
})
