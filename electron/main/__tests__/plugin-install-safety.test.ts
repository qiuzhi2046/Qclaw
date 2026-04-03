import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  finalizePluginInstallSafetyResult,
  repairIncompatibleExtensionPlugins,
  reconcileIncompatibleExtensionPlugins,
} from '../plugin-install-safety'

const tempDirs: string[] = []
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { tmpdir } = process.getBuiltinModule('node:os') as typeof import('node:os')
const { mkdtemp, mkdir, readFile, rm, writeFile } = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')

async function createTempHome(): Promise<string> {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'qclaw-plugin-safety-'))
  tempDirs.push(homeDir)
  await mkdir(path.join(homeDir, 'extensions'), { recursive: true })
  return homeDir
}

async function writePluginPackage(
  homeDir: string,
  pluginId: string,
  packageName: string,
  entryFile: string,
  entrySource: string
): Promise<void> {
  const pluginDir = path.join(homeDir, 'extensions', pluginId)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(
    path.join(pluginDir, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        type: 'module',
        openclaw: {
          extensions: [entryFile],
        },
      },
      null,
      2
    )
  )
  await writeFile(path.join(pluginDir, entryFile), entrySource)
}

async function writePluginFile(
  homeDir: string,
  pluginId: string,
  relativePath: string,
  source: string
): Promise<void> {
  const targetPath = path.join(homeDir, 'extensions', pluginId, relativePath)
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(targetPath, source)
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

describe('reconcileIncompatibleExtensionPlugins', () => {
  it('quarantines non-official extension plugins that cannot resolve openclaw/plugin-sdk and prunes config references', async () => {
    const homeDir = await createTempHome()
    await writePluginPackage(
      homeDir,
      'broken-sdk-plugin',
      '@demo/broken-sdk-plugin',
      'index.ts',
      'import { buildChannelConfigSchema } from "openclaw/plugin-sdk"\nexport default {}'
    )

    const writeConfig = vi.fn(async () => {})
    const result = await reconcileIncompatibleExtensionPlugins({
      homeDir,
      now: () => 123,
      readConfig: async () => ({
        plugins: {
          allow: ['broken-sdk-plugin'],
          entries: {
            'broken-sdk-plugin': { enabled: true },
          },
          installs: {
            'broken-sdk-plugin': {
              installPath: '/tmp/extensions/broken-sdk-plugin',
            },
          },
        },
      }),
      writeConfig,
    })

    expect(result.quarantinedPluginIds).toEqual(['broken-sdk-plugin'])
    expect(result.prunedPluginIds).toEqual(['broken-sdk-plugin'])
    expect(result.incompatiblePlugins).toEqual([
      expect.objectContaining({
        pluginId: 'broken-sdk-plugin',
        packageName: '@demo/broken-sdk-plugin',
      }),
    ])

    const quarantinedEntry = await readFile(
      path.join(homeDir, 'qclaw-quarantined-extensions', 'broken-sdk-plugin-123', 'package.json'),
      'utf8'
    )
    expect(quarantinedEntry).toContain('@demo/broken-sdk-plugin')

    expect(writeConfig).toHaveBeenCalledWith({
      plugins: {
        allow: [],
        entries: {},
        installs: {},
      },
    })
  })

  it('ignores plugins that do not reference the host plugin sdk', async () => {
    const homeDir = await createTempHome()
    await writePluginPackage(
      homeDir,
      'safe-plugin',
      '@demo/safe-plugin',
      'index.js',
      'export default { id: "safe-plugin" }'
    )

    const result = await reconcileIncompatibleExtensionPlugins({
      homeDir,
      readConfig: async () => null,
      writeConfig: async () => {},
    })

    expect(result).toEqual({
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: [],
    })
  })

  it('does not prune orphaned managed plugin residue during global repair', async () => {
    const homeDir = await createTempHome()
    const writeConfig = vi.fn(async () => {})

    const result = await reconcileIncompatibleExtensionPlugins({
      homeDir,
      readConfig: async () => ({
        channels: {
          'openclaw-weixin': {
            enabled: true,
          },
        },
        plugins: {
          installs: {
            'openclaw-weixin': {
              installPath: path.join(homeDir, 'extensions', 'openclaw-weixin'),
            },
          },
        },
      }),
      writeConfig,
    })

    expect(result).toEqual({
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: [],
    })
    expect(writeConfig).not.toHaveBeenCalled()
  })

  it('prunes orphaned managed plugin residue during scoped repair without deleting the channel config', async () => {
    const homeDir = await createTempHome()
    const writeConfig = vi.fn(async () => {})

    const result = await reconcileIncompatibleExtensionPlugins({
      homeDir,
      scopePluginIds: ['dingtalk-connector', 'dingtalk'],
      readConfig: async () => ({
        channels: {
          'dingtalk-connector': {
            enabled: true,
          },
        },
        plugins: {
          allow: ['dingtalk-connector'],
          installs: {
            'dingtalk-connector': {
              installPath: path.join(homeDir, 'extensions', 'dingtalk-connector'),
            },
          },
        },
      }),
      writeConfig,
    })

    expect(result).toEqual({
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: ['dingtalk-connector'],
    })
    expect(writeConfig).toHaveBeenCalledWith({
      channels: {
        'dingtalk-connector': {
          enabled: true,
        },
      },
      plugins: {
        allow: [],
        installs: {},
      },
    })
  })

  it('limits orphan cleanup to the scoped plugin ids during targeted repair', async () => {
    const homeDir = await createTempHome()
    const writeConfig = vi.fn(async () => {})

    const result = await reconcileIncompatibleExtensionPlugins({
      homeDir,
      scopePluginIds: ['dingtalk-connector', 'dingtalk'],
      readConfig: async () => ({
        channels: {
          feishu: {
            enabled: true,
          },
          'dingtalk-connector': {
            enabled: true,
          },
        },
        plugins: {
          allow: ['openclaw-lark', 'dingtalk-connector'],
          installs: {
            'openclaw-lark': {
              installPath: path.join(homeDir, 'extensions', 'openclaw-lark'),
            },
            'dingtalk-connector': {
              installPath: path.join(homeDir, 'extensions', 'dingtalk-connector'),
            },
          },
        },
      }),
      writeConfig,
    })

    expect(result).toEqual({
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: ['dingtalk-connector'],
    })
    expect(writeConfig).toHaveBeenCalledWith({
      channels: {
        feishu: {
          enabled: true,
        },
        'dingtalk-connector': {
          enabled: true,
        },
      },
      plugins: {
        allow: ['openclaw-lark'],
        installs: {
          'openclaw-lark': {
            installPath: path.join(homeDir, 'extensions', 'openclaw-lark'),
          },
        },
      },
    })
  })

  it('prunes managed plugin config that still points to a hidden install-stage directory', async () => {
    const homeDir = await createTempHome()
    const writeConfig = vi.fn(async () => {})
    const hiddenStageDir = path.join(homeDir, 'extensions', '.openclaw-install-stage-lxzem6')
    await mkdir(hiddenStageDir, { recursive: true })

    const result = await reconcileIncompatibleExtensionPlugins({
      homeDir,
      scopePluginIds: ['dingtalk-connector', 'dingtalk'],
      readConfig: async () => ({
        channels: {
          'dingtalk-connector': {
            enabled: true,
          },
        },
        plugins: {
          allow: ['dingtalk-connector'],
          entries: {
            'dingtalk-connector': {
              enabled: true,
              installPath: hiddenStageDir,
            },
          },
          installs: {
            'dingtalk-connector': {
              installPath: hiddenStageDir,
            },
          },
        },
      }),
      writeConfig,
    })

    expect(result).toEqual({
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: ['dingtalk-connector'],
    })
    expect(writeConfig).toHaveBeenCalledWith({
      channels: {
        'dingtalk-connector': {
          enabled: true,
        },
      },
      plugins: {
        allow: [],
        entries: {},
        installs: {},
      },
    })
  })

  it('catches plugin-sdk import failures hidden in secondary modules via smoke test', async () => {
    const homeDir = await createTempHome()
    await writePluginPackage(
      homeDir,
      'nested-bad-plugin',
      '@demo/nested-bad-plugin',
      'index.js',
      'export { default } from "./src/entry.js"'
    )
    await writePluginFile(
      homeDir,
      'nested-bad-plugin',
      'src/entry.js',
      'export { demo } from "./inner.js"; export default { id: "nested-bad-plugin" }'
    )
    await writePluginFile(
      homeDir,
      'nested-bad-plugin',
      'src/inner.js',
      'import "openclaw/plugin-sdk"; export const demo = true'
    )

    const result = await reconcileIncompatibleExtensionPlugins({
      homeDir,
      readConfig: async () => ({
        plugins: {
          allow: ['nested-bad-plugin'],
        },
      }),
      writeConfig: async () => {},
    })

    expect(result.quarantinedPluginIds).toEqual(['nested-bad-plugin'])
    expect(result.incompatiblePlugins[0]?.reason).toContain('smoke test')
  })

  it('does not quarantine plugins for unrelated import failures', async () => {
    const homeDir = await createTempHome()
    await writePluginPackage(
      homeDir,
      'other-bad-plugin',
      '@demo/other-bad-plugin',
      'index.js',
      'import "./broken.js"; export default { id: "other-bad-plugin" }'
    )
    await writePluginFile(
      homeDir,
      'other-bad-plugin',
      'broken.js',
      'throw new Error("other dependency failed")'
    )

    const result = await reconcileIncompatibleExtensionPlugins({
      homeDir,
      readConfig: async () => ({
        plugins: {
          allow: ['other-bad-plugin'],
        },
      }),
      writeConfig: async () => {},
    })

    expect(result).toEqual({
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: [],
    })
  })

  it('limits smoke-test quarantine to the scoped plugin ids during targeted repair', async () => {
    const homeDir = await createTempHome()
    await writePluginPackage(
      homeDir,
      'broken-sdk-plugin',
      '@demo/broken-sdk-plugin',
      'index.ts',
      'import { buildChannelConfigSchema } from "openclaw/plugin-sdk"\nexport default {}'
    )
    await writePluginPackage(
      homeDir,
      'another-broken-plugin',
      '@demo/another-broken-plugin',
      'index.ts',
      'import { buildChannelConfigSchema } from "openclaw/plugin-sdk"\nexport default {}'
    )

    const result = await reconcileIncompatibleExtensionPlugins({
      homeDir,
      scopePluginIds: ['broken-sdk-plugin'],
      readConfig: async () => ({
        plugins: {
          allow: ['broken-sdk-plugin', 'another-broken-plugin'],
        },
      }),
      writeConfig: async () => {},
    })

    expect(result.quarantinedPluginIds).toEqual(['broken-sdk-plugin'])
    await expect(
      readFile(path.join(homeDir, 'extensions', 'another-broken-plugin', 'package.json'), 'utf8')
    ).resolves.toContain('@demo/another-broken-plugin')
  })

  it('treats official managed plugin smoke test failures as diagnostic-only', async () => {
    const homeDir = await createTempHome()
    await writePluginPackage(
      homeDir,
      'dingtalk-connector',
      '@dingtalk-real-ai/dingtalk-connector',
      'index.ts',
      'import { buildChannelConfigSchema } from "openclaw/plugin-sdk"\nexport default {}'
    )

    const result = await reconcileIncompatibleExtensionPlugins({
      homeDir,
      readConfig: async () => ({
        plugins: {
          allow: ['dingtalk-connector'],
        },
      }),
      writeConfig: async () => {},
    })

    expect(result).toEqual({
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: [],
    })
  })

  it('does not quarantine diagnostic-only official managed plugins during global repair sweeps', async () => {
    const homeDir = await createTempHome()
    await writePluginPackage(
      homeDir,
      'openclaw-weixin',
      '@tencent-weixin/openclaw-weixin',
      'index.ts',
      'import { buildChannelConfigSchema } from "openclaw/plugin-sdk"\nexport default {}'
    )

    const result = await reconcileIncompatibleExtensionPlugins({
      homeDir,
      quarantineOfficialManagedPlugins: true,
      readConfig: async () => ({
        plugins: {
          allow: ['openclaw-weixin'],
        },
      }),
      writeConfig: async () => {},
    })

    expect(result).toEqual({
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: [],
    })
  })

  it('quarantines official managed plugins during explicit targeted repair', async () => {
    const homeDir = await createTempHome()
    await writePluginPackage(
      homeDir,
      'openclaw-lark',
      '@larksuite/openclaw-lark',
      'index.ts',
      'import { buildChannelConfigSchema } from "openclaw/plugin-sdk"\nexport default {}'
    )

    const writeConfig = vi.fn(async () => {})
    const result = await reconcileIncompatibleExtensionPlugins({
      homeDir,
      now: () => 0,
      scopePluginIds: ['openclaw-lark', 'feishu', 'feishu-openclaw-plugin'],
      quarantineOfficialManagedPlugins: true,
      readConfig: async () => ({
        plugins: {
          allow: ['openclaw-lark'],
          entries: {
            'openclaw-lark': { enabled: true },
          },
          installs: {
            'openclaw-lark': {
              installPath: path.join(homeDir, 'extensions', 'openclaw-lark'),
            },
          },
        },
      }),
      writeConfig,
    })

    expect(result.quarantinedPluginIds).toEqual(['openclaw-lark'])
    expect(result.prunedPluginIds).toEqual(['openclaw-lark'])
    expect(writeConfig).toHaveBeenCalledWith({
      plugins: {
        allow: [],
        entries: {},
        installs: {},
      },
    })

    const quarantinedEntry = await readFile(
      path.join(homeDir, 'qclaw-quarantined-extensions', 'openclaw-lark-0', 'package.json'),
      'utf8'
    )
    expect(quarantinedEntry).toContain('@larksuite/openclaw-lark')
  })

  it('does not quarantine the interactive-installer weixin plugin on Node smoke-test false positives', async () => {
    const homeDir = await createTempHome()
    await writePluginPackage(
      homeDir,
      'openclaw-weixin',
      '@tencent-weixin/openclaw-weixin',
      'index.ts',
      'import { buildChannelConfigSchema } from "openclaw/plugin-sdk"\nexport default {}'
    )

    const writeConfig = vi.fn(async () => {})
    const result = await reconcileIncompatibleExtensionPlugins({
      homeDir,
      now: () => 0,
      scopePluginIds: ['openclaw-weixin'],
      quarantineOfficialManagedPlugins: true,
      readConfig: async () => ({
        plugins: {
          allow: ['openclaw-weixin'],
          entries: {
            'openclaw-weixin': { enabled: true },
          },
          installs: {
            'openclaw-weixin': {
              installPath: path.join(homeDir, 'extensions', 'openclaw-weixin'),
            },
          },
        },
      }),
      writeConfig,
    })

    expect(result.quarantinedPluginIds).toEqual([])
    expect(result.prunedPluginIds).toEqual([])
    expect(writeConfig).not.toHaveBeenCalled()
    await expect(
      readFile(path.join(homeDir, 'extensions', 'openclaw-weixin', 'package.json'), 'utf8')
    ).resolves.toContain('@tencent-weixin/openclaw-weixin')
  })

  it('returns a repair summary when incompatible plugins are fixed', async () => {
    const homeDir = await createTempHome()
    await writePluginPackage(
      homeDir,
      'broken-sdk-plugin',
      '@demo/broken-sdk-plugin',
      'index.ts',
      'import { buildChannelConfigSchema } from "openclaw/plugin-sdk"\nexport default {}'
    )

    const result = await repairIncompatibleExtensionPlugins({
      homeDir,
      now: () => 456,
      readConfig: async () => ({
        plugins: {
          allow: ['broken-sdk-plugin'],
        },
      }),
      writeConfig: async () => {},
    })

    expect(result.ok).toBe(true)
    expect(result.repaired).toBe(true)
    expect(result.summary).toContain('已自动隔离')
    expect(result.quarantinedPluginIds).toEqual(['broken-sdk-plugin'])
  })

  it('surfaces permission-denied quarantine failures as a dedicated repair outcome', async () => {
    const homeDir = await createTempHome()
    await writePluginPackage(
      homeDir,
      'broken-sdk-plugin',
      '@demo/broken-sdk-plugin',
      'index.ts',
      'import { buildChannelConfigSchema } from "openclaw/plugin-sdk"\nexport default {}'
    )

    const result = await repairIncompatibleExtensionPlugins({
      homeDir,
      readConfig: async () => ({
        plugins: {
          allow: ['broken-sdk-plugin'],
        },
      }),
      writeConfig: async () => {},
      renameDirectory: async () => {
        const error = new Error('permission denied')
        ;(error as NodeJS.ErrnoException).code = 'EACCES'
        throw error
      },
    })

    expect(result.ok).toBe(false)
    expect(result.failureKind).toBe('permission-denied')
    expect(result.failedPluginIds).toEqual(['broken-sdk-plugin'])
    expect(result.quarantinedPluginIds).toEqual([])
  })

  it('stops on partial quarantine instead of silently continuing into a generic success', async () => {
    const homeDir = await createTempHome()
    await writePluginPackage(
      homeDir,
      'broken-sdk-plugin',
      '@demo/broken-sdk-plugin',
      'index.ts',
      'import { buildChannelConfigSchema } from "openclaw/plugin-sdk"\nexport default {}'
    )
    await writePluginPackage(
      homeDir,
      'another-broken-plugin',
      '@demo/another-broken-plugin',
      'index.ts',
      'import { buildChannelConfigSchema } from "openclaw/plugin-sdk"\nexport default {}'
    )

    let renameCount = 0
    const result = await repairIncompatibleExtensionPlugins({
      homeDir,
      now: () => 999,
      readConfig: async () => ({
        plugins: {
          allow: ['broken-sdk-plugin', 'another-broken-plugin'],
        },
      }),
      writeConfig: async () => {},
      renameDirectory: async (from, to) => {
        renameCount += 1
        if (renameCount === 1) {
          await process.getBuiltinModule('node:fs/promises').rename(from, to)
          return
        }
        throw new Error('rename failed')
      },
    })

    expect(result.ok).toBe(false)
    expect(result.failureKind).toBe('partial-quarantine')
    expect(result.quarantinedPluginIds).toEqual(['another-broken-plugin'])
    expect(result.failedPluginIds).toEqual(['broken-sdk-plugin'])
  })

  it('returns a repair summary when only orphaned plugin config is cleaned', async () => {
    const homeDir = await createTempHome()

    const result = await repairIncompatibleExtensionPlugins({
      homeDir,
      scopePluginIds: ['openclaw-weixin'],
      readConfig: async () => ({
        channels: {
          'openclaw-weixin': {
            enabled: true,
          },
        },
        plugins: {
          installs: {
            'openclaw-weixin': {
              installPath: path.join(homeDir, 'extensions', 'openclaw-weixin'),
            },
          },
        },
      }),
      writeConfig: async () => {},
    })

    expect(result.ok).toBe(true)
    expect(result.repaired).toBe(true)
    expect(result.summary).toContain('已自动清理')
    expect(result.prunedPluginIds).toEqual(['openclaw-weixin'])
  })

  it('does not require a Node executor when only orphaned plugin config is cleaned', async () => {
    const homeDir = await createTempHome()
    const runNodeEval = vi.fn(async () => {
      throw new Error('should not be called')
    })

    const result = await repairIncompatibleExtensionPlugins({
      homeDir,
      scopePluginIds: ['openclaw-weixin'],
      readConfig: async () => ({
        channels: {
          'openclaw-weixin': {
            enabled: true,
          },
        },
        plugins: {
          installs: {
            'openclaw-weixin': {
              installPath: path.join(homeDir, 'extensions', 'openclaw-weixin'),
            },
          },
        },
      }),
      writeConfig: async () => {},
      runNodeEval,
    })

    expect(result.ok).toBe(true)
    expect(result.prunedPluginIds).toEqual(['openclaw-weixin'])
    expect(runNodeEval).not.toHaveBeenCalled()
  })

  it('surfaces config prune failures instead of swallowing them', async () => {
    const homeDir = await createTempHome()
    await writePluginPackage(
      homeDir,
      'broken-sdk-plugin',
      '@demo/broken-sdk-plugin',
      'index.ts',
      'import { buildChannelConfigSchema } from "openclaw/plugin-sdk"\nexport default {}'
    )

    const result = await repairIncompatibleExtensionPlugins({
      homeDir,
      readConfig: async () => ({
        plugins: {
          allow: ['broken-sdk-plugin'],
        },
      }),
      writeConfig: async () => {
        throw new Error('write config failed')
      },
    })

    expect(result.ok).toBe(false)
    expect(result.summary).toBe('修复坏插件环境失败，请重试。')
    expect(result.stderr).toContain('write config failed')
  })

  it('fails safely when the Node executor is unavailable instead of quarantining plugins', async () => {
    const homeDir = await createTempHome()
    await writePluginPackage(
      homeDir,
      'openclaw-weixin',
      '@tencent-weixin/openclaw-weixin',
      'index.ts',
      'import { buildChannelConfigSchema } from "openclaw/plugin-sdk"\nexport default {}'
    )

    const result = await repairIncompatibleExtensionPlugins({
      homeDir,
      readConfig: async () => ({
        plugins: {
          allow: ['openclaw-weixin'],
        },
      }),
      writeConfig: async () => {},
      runNodeEval: async () => ({
        ok: false,
        kind: 'executor-unavailable',
        stdout: '',
        stderr: 'Node missing',
        code: null,
        runtimeFailure: {
          ok: false,
          reason: 'node-unavailable',
          message: 'Node missing',
          requiredVersion: '22.16.0',
          targetVersion: '24.14.0',
          detectedVersions: [],
        },
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.repaired).toBe(false)
    expect(result.quarantinedPluginIds).toEqual([])
    expect(result.stderr).toContain('执行器不可用')

    await expect(
      readFile(path.join(homeDir, 'extensions', 'openclaw-weixin', 'package.json'), 'utf8')
    ).resolves.toContain('@tencent-weixin/openclaw-weixin')
  })
})

describe('finalizePluginInstallSafetyResult', () => {
  it('fails the install when the requested plugin had to be quarantined', () => {
    const result = finalizePluginInstallSafetyResult(
      { ok: true, stdout: 'installed', stderr: '', code: 0 },
      {
        incompatiblePlugins: [
          {
            pluginId: 'wecom-openclaw-plugin',
            packageName: '@wecom/wecom-openclaw-plugin',
            installPath: '/tmp/home/extensions/wecom-openclaw-plugin',
            displayInstallPath: '/tmp/home/extensions/wecom-openclaw-plugin',
            reason: "插件入口依赖 'openclaw/plugin-sdk'，但在当前插件目录下无法解析宿主 SDK",
          },
        ],
        quarantinedPluginIds: ['wecom-openclaw-plugin'],
        prunedPluginIds: ['wecom-openclaw-plugin'],
      },
      ['wecom-openclaw-plugin']
    )

    expect(result.ok).toBe(false)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('已自动隔离')
  })

  it('keeps the install successful when only unrelated broken plugins were quarantined', () => {
    const result = finalizePluginInstallSafetyResult(
      { ok: true, stdout: 'installed', stderr: '', code: 0 },
      {
        incompatiblePlugins: [
          {
            pluginId: 'openclaw-weixin',
            packageName: '@tencent-weixin/openclaw-weixin',
            installPath: '/tmp/home/extensions/openclaw-weixin',
            displayInstallPath: '/tmp/home/extensions/openclaw-weixin',
            reason: "插件入口依赖 'openclaw/plugin-sdk'，但在当前插件目录下无法解析宿主 SDK",
          },
        ],
        quarantinedPluginIds: ['openclaw-weixin'],
        prunedPluginIds: ['openclaw-weixin'],
      },
      ['openclaw-lark']
    )

    expect(result.ok).toBe(true)
    expect(result.stdout).toContain('已自动隔离')
  })

  it('converts an already-installed result into a failure when the requested plugin is quarantined', () => {
    const result = finalizePluginInstallSafetyResult(
      { ok: false, stdout: '', stderr: 'Plugin already exists in manifest', code: 1 },
      {
        incompatiblePlugins: [
          {
            pluginId: 'openclaw-weixin',
            packageName: '@tencent-weixin/openclaw-weixin',
            installPath: '/tmp/home/extensions/openclaw-weixin',
            displayInstallPath: '/tmp/home/extensions/openclaw-weixin',
            reason: "插件入口依赖 'openclaw/plugin-sdk'，但在当前插件目录下无法解析宿主 SDK",
          },
        ],
        quarantinedPluginIds: ['openclaw-weixin'],
        prunedPluginIds: ['openclaw-weixin'],
      },
      ['openclaw-weixin']
    )

    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('已自动隔离')
    expect(result.stderr).not.toBe('Plugin already exists in manifest')
  })
})
