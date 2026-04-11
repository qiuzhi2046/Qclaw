import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const manifestPath = new URL('../../../install-web-v1.manifest.json', import.meta.url)

function readManifest(): any {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
}

describe('install-web-v1 policy manifest', () => {
  it('centralizes provider, skill, channel, and gateway defaults', () => {
    const manifest = readManifest()
    const providerIds = manifest.providers.map((item: any) => item.id)
    const skillIds = manifest.skills.map((item: any) => item.id)

    expect(providerIds).toEqual(
      expect.arrayContaining([
        'kimi-code',
        'moonshot',
        'minimax',
        'zai',
        'zai-global',
        'zai-cn',
        'zai-coding-global',
        'zai-coding-cn',
      ])
    )
    expect(manifest.gateway).toMatchObject({
      bind: 'loopback',
      defaultPort: 18789,
      portEnv: 'OPENCLAW_GATEWAY_PORT',
    })
    expect(manifest.desktop).toMatchObject({
      devServer: {
        defaultUrl: 'http://127.0.0.1:7777/',
      },
      window: {
        defaultWidth: 800,
        defaultHeight: 630,
        minimumWidth: 640,
        minimumHeight: 480,
        backgroundColor: '#09090b',
        safeMargin: 32,
      },
      compatibility: {
        disableHardwareAccelerationWindowsReleasePrefixes: ['6.1'],
      },
    })
    expect(manifest.desktop.loopbackHosts).toEqual(
      expect.arrayContaining(['localhost', '127.0.0.1', '::1'])
    )
    expect(manifest.desktop.oauth.openaiCodex).toMatchObject({
      defaultCallbackUrl: 'http://127.0.0.1:1455/auth/callback',
      callbackUrlEnv: 'QCLAW_OPENAI_CALLBACK_URL',
      callbackPortEnv: 'QCLAW_OPENAI_CALLBACK_PORT',
    })
    expect(manifest.channel).toMatchObject({
      id: 'feishu',
      pluginPackage: '@openclaw/feishu',
      defaultDmPolicy: 'pairing',
      dmPolicyEnv: 'OPENCLAW_FEISHU_DM_POLICY',
    })
    expect(skillIds).toEqual(
      expect.arrayContaining([
        'web-search',
        'autonomy',
        'summarize',
        'github',
        'nano-pdf',
        'openai-whisper',
      ])
    )
  })

  it('centralizes executable discovery env names and manager hints', () => {
    const manifest = readManifest()

    expect(manifest.discovery).toMatchObject({
      sharedExtraBinDirsEnv: 'QCLAW_CLI_EXTRA_BIN_DIRS',
      nodeExtraBinDirsEnv: 'QCLAW_NODE_EXTRA_BIN_DIRS',
      openclawExtraBinDirsEnv: 'QCLAW_OPENCLAW_EXTRA_BIN_DIRS',
    })
    expect(manifest.discovery.npmPrefixEnvNames).toEqual(
      expect.arrayContaining(['npm_config_prefix', 'NPM_CONFIG_PREFIX'])
    )
    expect(manifest.discovery.managerEnvNames).toMatchObject({
      nvmBin: 'NVM_BIN',
      voltaHome: 'VOLTA_HOME',
      fnmMultishellPath: 'FNM_MULTISHELL_PATH',
      asdfDataDir: 'ASDF_DATA_DIR',
      asdfDir: 'ASDF_DIR',
      pnpmHome: 'PNPM_HOME',
      miseShimsDir: 'MISE_SHIMS_DIR',
      miseDataDir: 'MISE_DATA_DIR',
      rtxBinHome: 'RTX_BIN_HOME',
    })
  })
})
