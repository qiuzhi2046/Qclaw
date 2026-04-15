import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOpenClawAuthRegistry } from '../openclaw-auth-registry'
import { startModelOAuthFlow } from '../model-oauth'
import { buildGeminiProjectEnvFailureMessage } from '../openclaw-oauth-dependencies'
import type { OpenClawCapabilities } from '../openclaw-capabilities'

const fs = (process.getBuiltinModule('node:fs') as typeof import('node:fs')).promises
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

function createRegistry() {
  return createOpenClawAuthRegistry({
    source: 'openclaw-internal-registry',
    providers: [
      {
        id: 'openai',
        label: 'OpenAI',
        methods: [
          {
            authChoice: 'openai-codex',
            label: 'OAuth · openai-codex',
            kind: 'oauth',
            route: {
              kind: 'models-auth-login',
              providerId: 'openai-codex',
              requiresBrowser: true,
            },
          },
        ],
      },
      {
        id: 'qwen',
        label: 'Qwen',
        methods: [
          {
            authChoice: 'qwen-portal',
            label: 'OAuth · qwen-portal',
            kind: 'oauth',
            route: {
              kind: 'models-auth-login',
              providerId: 'qwen-portal',
              methodId: 'device',
              pluginId: 'qwen-portal-auth',
              requiresBrowser: true,
            },
          },
        ],
      },
      {
        id: 'minimax',
        label: 'MiniMax',
        methods: [
          {
            authChoice: 'minimax-portal',
            label: 'OAuth · minimax-portal',
            kind: 'oauth',
            route: {
              kind: 'models-auth-login',
              providerId: 'minimax-portal',
              pluginId: 'minimax-portal-auth',
              requiresBrowser: true,
              extraOptions: [
                { id: 'oauth', label: 'Global' },
                { id: 'oauth-cn', label: 'CN' },
              ],
            },
          },
        ],
      },
      {
        id: 'google',
        label: 'Google',
        methods: [
          {
            authChoice: 'google-gemini-cli',
            label: 'OAuth · google-gemini-cli',
            kind: 'oauth',
            route: {
              kind: 'models-auth-login',
              providerId: 'google-gemini-cli',
              methodId: 'oauth',
              pluginId: 'google-gemini-cli-auth',
              requiresBrowser: true,
            },
          },
        ],
      },
    ],
  })
}

function createCapabilities(authRegistry = createRegistry()): OpenClawCapabilities {
  return {
    version: 'OpenClaw 2026.3.8',
    discoveredAt: '2026-03-23T00:00:00.000Z',
    authRegistry,
    authRegistrySource: authRegistry.source,
    authChoices: [],
    rootCommands: ['onboard', 'models', 'plugins'],
    onboardFlags: [
      '--auth-choice',
      '--non-interactive',
      '--accept-risk',
      '--no-install-daemon',
      '--skip-channels',
      '--skip-health',
      '--skip-skills',
      '--skip-ui',
    ],
    modelsCommands: ['auth', 'list', 'status'],
    modelsAuthCommands: ['login', 'paste-token', 'setup-token', 'order', 'login-github-copilot'],
    pluginsCommands: ['enable', 'install'],
    commandFlags: {
      onboard: [
        '--auth-choice',
        '--non-interactive',
        '--accept-risk',
        '--no-install-daemon',
        '--skip-channels',
        '--skip-health',
        '--skip-skills',
        '--skip-ui',
      ],
      'models auth login': ['--provider', '--method'],
      'models auth paste-token': ['--provider'],
      'models auth setup-token': ['--provider'],
    },
    supports: {
      onboard: true,
      plugins: true,
      pluginsInstall: true,
      pluginsEnable: true,
      chatAgentModelFlag: false,
      chatGatewaySendModel: false,
      chatInThreadModelSwitch: false,
      modelsListAllJson: true,
      modelsStatusJson: true,
      modelsAuthLogin: true,
      modelsAuthAdd: true,
      modelsAuthPasteToken: true,
      modelsAuthSetupToken: true,
      modelsAuthOrder: true,
      modelsAuthLoginGitHubCopilot: true,
      aliases: false,
      fallbacks: false,
      imageFallbacks: false,
      modelsScan: false,
    },
  }
}

const RAW_GEMINI_PTY_FAILURE = `\u001b[?25l│
◇  Gemini CLI OAuth ─╮
│  B                 │
│  r                 │
│  o                 │
│  w                 │
│  s                 │
│  e                 │
│  r                 │
├────────────────────╯
\r\u001b[2K◇  Gemini CLI OAuth failed
\u001b[?25h│
◇  OAuth help ─╮
│  T           │
│  r           │
│  o           │
│  u           │
│  b           │
│  l           │
│  e           │
├──────────────╯
Error: Gemini CLI not found. Install it first: brew install gemini-cli (or npm install -g @google/gemini-cli), or set GEMINI_CLI_OAUTH_CLIENT_ID.
\u001b[0m\u001b[?25h`

const RAW_STALE_PLUGIN_WARNING =
  'Config warnings:\n- plugins.entries.MiniMax-M2.5: plugin not found: MiniMax-M2.5 (stale config entry ignored; remove it from plugins config)'

describe('startModelOAuthFlow', () => {
  const originalUserDataDir = process.env.QCLAW_USER_DATA_DIR
  let userDataDir = ''

  beforeEach(async () => {
    if (userDataDir) {
      await fs.rm(userDataDir, { recursive: true, force: true })
    }
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qclaw-model-oauth-'))
    process.env.QCLAW_USER_DATA_DIR = userDataDir
  })

  afterEach(async () => {
    if (userDataDir) {
      await fs.rm(userDataDir, { recursive: true, force: true })
      userDataDir = ''
    }
    if (originalUserDataDir === undefined) {
      delete process.env.QCLAW_USER_DATA_DIR
      return
    }
    process.env.QCLAW_USER_DATA_DIR = originalUserDataDir
  })

  it('uses the registry descriptor for qwen plugin enable and device login', async () => {
    const emitted: Array<{ channel: string; payload: Record<string, any> }> = []
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'plugins') {
        return {
          ok: true,
          stdout: 'Enabled plugin "qwen-portal-auth".',
          stderr: '',
          code: 0,
        }
      }
      return { ok: true, stdout: '', stderr: '', code: 0 }
    })
    const runStreamingCommand = vi.fn(async (_args: string[], options?: Record<string, any>) => {
      options?.onStdout?.(`
◇  Qwen OAuth ────────────────────────────────────────────────────────────╮
│  Open https://chat.qwen.ai/authorize?user_code=BF0Q6UX9&client=qwen-code │
│  If prompted, enter the code BF0Q6UX9.                                  │
╰──────────────────────────────────────────────────────────────────────────╯
`)
      return { ok: true, stdout: 'OAuth complete', stderr: '', code: 0 }
    })

    const result = await startModelOAuthFlow(
      { providerId: 'qwen', methodId: 'qwen-portal', setDefault: true },
      {
        loadAuthRegistry: async () => createRegistry(),
        emit: (channel, payload) => emitted.push({ channel, payload }),
        runCommand,
        runStreamingCommand,
        inspectOAuthDependency: async () => ({ ready: true }),
      }
    )

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      ['plugins', 'enable', 'qwen-portal-auth'],
      expect.any(Number)
    )
    expect(runStreamingCommand).toHaveBeenNthCalledWith(
      1,
      ['models', 'auth', 'login', '--provider', 'qwen-portal', '--method', 'device', '--set-default'],
      expect.objectContaining({ autoOpenOAuth: false, onStdout: expect.any(Function) })
    )
    expect(result.loginProviderId).toBe('qwen-portal')
    expect(result.ok).toBe(true)
    expect(emitted.some((entry) => entry.channel === 'oauth:success')).toBe(true)
  }, 20_000)

  it('recovers from a stale gateway provider list by restarting the gateway once and retrying', async () => {
    const emitted: Array<{ channel: string; payload: Record<string, any> }> = []
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'plugins') {
        return {
          ok: true,
          stdout: 'Enabled plugin "qwen-portal-auth". Restart the gateway to apply.',
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'gateway') {
        return { ok: true, stdout: 'Gateway restarted', stderr: '', code: 0 }
      }
      return { ok: true, stdout: '', stderr: '', code: 0 }
    })
    const runStreamingCommand = vi
      .fn()
      .mockImplementationOnce(async () => ({
        ok: false,
        stdout: '',
        stderr: 'Error: Unknown provider "qwen-portal". Loaded providers: ollama, vllm.',
        code: 1,
      }))
      .mockImplementationOnce(async (_args: string[], options?: Record<string, any>) => {
        options?.onStdout?.(
          'Open: https://chat.qwen.ai/authorize?user_code=BF0Q6UX9&client=qwen-code\n'
        )
        return { ok: true, stdout: 'OAuth complete', stderr: '', code: 0 }
      })

    const result = await startModelOAuthFlow(
      { providerId: 'qwen', methodId: 'qwen-portal' },
      {
        loadAuthRegistry: async () => createRegistry(),
        emit: (channel, payload) => emitted.push({ channel, payload }),
        runCommand,
        runStreamingCommand,
        inspectOAuthDependency: async () => ({ ready: true }),
      }
    )

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      ['plugins', 'enable', 'qwen-portal-auth'],
      expect.any(Number)
    )
    expect(runCommand).toHaveBeenNthCalledWith(2, ['gateway', 'restart'], expect.any(Number))
    expect(runStreamingCommand).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
    expect(result.loginProviderId).toBe('qwen-portal')
    expect(emitted.some((entry) => entry.channel === 'oauth:success')).toBe(true)
    expect(emitted.some((entry) => entry.channel === 'oauth:error')).toBe(false)
  })

  it('uses the registry descriptor for openai-codex login provider instead of onboard quickstart', async () => {
    const runCommand = vi.fn(async () => {
      throw new Error('plugin enable should not be called for openai-codex')
    })
    const runStreamingCommand = vi.fn(async (_args: string[], options?: Record<string, any>) => {
      options?.onStdout?.(
        'Open: https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&state=abc123\n'
      )
      return { ok: true, stdout: 'OAuth complete', stderr: '', code: 0 }
    })

    const result = await startModelOAuthFlow(
      { providerId: 'openai', methodId: 'openai-codex' },
      {
        loadAuthRegistry: async () => createRegistry(),
        runCommand,
        runStreamingCommand,
        probeOpenAICallbackPort: async () => ({ staleListenerDetected: false }),
        inspectOAuthDependency: async () => ({ ready: true }),
      }
    )

    expect(runCommand).not.toHaveBeenCalled()
    expect(runStreamingCommand).toHaveBeenNthCalledWith(
      1,
      ['models', 'auth', 'login', '--provider', 'openai-codex'],
      expect.objectContaining({
        autoOpenOAuth: true,
        onOAuthUrl: expect.any(Function),
        onStdout: expect.any(Function),
      })
    )
    expect(result.loginProviderId).toBe('openai-codex')
    expect(result.ok).toBe(true)
  })

  it('prefers recovered capability registry descriptors when raw auth metadata is unavailable', async () => {
    const loadAuthRegistry = vi.fn(async () =>
      createOpenClawAuthRegistry({
        ok: false,
        source: 'unsupported-openclaw-layout',
        message: 'unsupported layout',
      })
    )
    const recoveredRegistry = createOpenClawAuthRegistry({
      ok: false,
      source: 'unsupported-openclaw-layout',
      message: 'recovered from onboard help',
      providers: [
        {
          id: 'openai',
          label: 'OpenAI',
          methods: [
            {
              authChoice: 'openai-codex',
              label: 'OpenAI Codex OAuth',
              kind: 'oauth',
              route: {
                kind: 'models-auth-login',
                providerId: 'openai-codex',
                requiresBrowser: true,
              },
            },
          ],
        },
      ],
    })
    const runCommand = vi.fn(async () => {
      throw new Error('plugin enable should not be called for openai-codex')
    })
    const runStreamingCommand = vi.fn(async (_args: string[], options?: Record<string, any>) => {
      options?.onStdout?.(
        'Open: https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&state=abc123\n'
      )
      return { ok: true, stdout: 'OAuth complete', stderr: '', code: 0 }
    })

    const result = await startModelOAuthFlow(
      { providerId: 'openai', methodId: 'openai-codex' },
      {
        capabilities: createCapabilities(recoveredRegistry),
        loadAuthRegistry,
        runCommand,
        runStreamingCommand,
        probeOpenAICallbackPort: async () => ({ staleListenerDetected: false }),
        inspectOAuthDependency: async () => ({ ready: true }),
      }
    )

    expect(loadAuthRegistry).not.toHaveBeenCalled()
    expect(runStreamingCommand).toHaveBeenNthCalledWith(
      1,
      ['models', 'auth', 'login', '--provider', 'openai-codex'],
      expect.objectContaining({
        autoOpenOAuth: true,
        onOAuthUrl: expect.any(Function),
        onStdout: expect.any(Function),
      })
    )
    expect(result.loginProviderId).toBe('openai-codex')
    expect(result.ok).toBe(true)
  })

  it('executes recovered onboard OAuth fallbacks when detailed registry metadata is unavailable', async () => {
    const loadAuthRegistry = vi.fn(async () =>
      createOpenClawAuthRegistry({
        ok: false,
        source: 'unsupported-openclaw-layout',
        message: 'unsupported layout',
      })
    )
    const recoveredRegistry = createOpenClawAuthRegistry({
      ok: false,
      source: 'unsupported-openclaw-layout',
      message: 'recovered from onboard help',
      providers: [
        {
          id: 'google',
          label: 'Google',
          methods: [
            {
              authChoice: 'google-gemini-cli',
              label: 'Google Gemini CLI OAuth',
              kind: 'oauth',
              route: {
                kind: 'onboard',
                providerId: 'google',
                requiresBrowser: true,
              },
            },
          ],
        },
      ],
    })
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'OAuth complete', stderr: '', code: 0 }))
    const runStreamingCommand = vi.fn(async () => {
      throw new Error('streaming login should not be used for onboard fallback routes')
    })

    const result = await startModelOAuthFlow(
      { providerId: 'google', methodId: 'google-gemini-cli' },
      {
        capabilities: createCapabilities(recoveredRegistry),
        loadAuthRegistry,
        runCommand,
        runStreamingCommand,
        inspectOAuthDependency: async () => ({ ready: true }),
      }
    )

    expect(loadAuthRegistry).not.toHaveBeenCalled()
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      [
        'onboard',
        '--non-interactive',
        '--auth-choice',
        'google-gemini-cli',
        '--accept-risk',
        '--no-install-daemon',
        '--skip-channels',
        '--skip-health',
        '--skip-skills',
        '--skip-ui',
      ],
      expect.any(Number)
    )
    expect(runStreamingCommand).not.toHaveBeenCalled()
    expect(result.loginProviderId).toBe('google')
    expect(result.ok).toBe(true)
  })

  it('requires a selected extra option for multimethod providers like minimax portal', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 }))
    const runStreamingCommand = vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 }))

    const result = await startModelOAuthFlow(
      { providerId: 'minimax', methodId: 'minimax-portal' },
      {
        loadAuthRegistry: async () => createRegistry(),
        runCommand,
        runStreamingCommand,
        inspectOAuthDependency: async () => ({ ready: true }),
      }
    )

    expect(result.ok).toBe(false)
    expect(result.message).toContain('requires selecting one of')
    expect(runCommand).not.toHaveBeenCalled()
    expect(runStreamingCommand).not.toHaveBeenCalled()
  })

  it('fails early with a clear message when openai callback port 1455 is already occupied', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 }))
    const runStreamingCommand = vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 }))

    const result = await startModelOAuthFlow(
      { providerId: 'openai', methodId: 'openai-codex' },
      {
        loadAuthRegistry: async () => createRegistry(),
        runCommand,
        runStreamingCommand,
        probeOpenAICallbackPort: async () => ({
          staleListenerDetected: true,
          message: '检测到本地 OAuth 回调端口 1455 已被旧会话占用（State mismatch）。请关闭旧的 openclaw 登录会话后重试。',
        }),
        inspectOAuthDependency: async () => ({ ready: true }),
      }
    )

    expect(result.ok).toBe(false)
    expect(result.message).toContain('1455')
    expect(result.message).toContain('State mismatch')
    expect(runCommand).not.toHaveBeenCalled()
    expect(runStreamingCommand).not.toHaveBeenCalled()
  })

  it('surfaces callback probe messages without assuming localhost-only wording', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 }))
    const runStreamingCommand = vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 }))

    const result = await startModelOAuthFlow(
      { providerId: 'openai', methodId: 'openai-codex' },
      {
        loadAuthRegistry: async () => createRegistry(),
        runCommand,
        runStreamingCommand,
        probeOpenAICallbackPort: async () => ({
          staleListenerDetected: true,
          message: '检测到本地 OAuth 回调地址 127.0.0.1:2455 已被占用（HTTP 409）。请关闭旧的 openclaw 登录会话后重试。',
        }),
        inspectOAuthDependency: async () => ({ ready: true }),
      }
    )

    expect(result.ok).toBe(false)
    expect(result.message).toContain('127.0.0.1:2455')
    expect(runCommand).not.toHaveBeenCalled()
    expect(runStreamingCommand).not.toHaveBeenCalled()
  })

  it('fails preflight with an install action when Gemini CLI is unavailable', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 }))
    const runStreamingCommand = vi.fn(async () => ({
      ok: false,
      stdout: RAW_GEMINI_PTY_FAILURE,
      stderr: '',
      code: 1,
    }))

    const result = await startModelOAuthFlow(
      { providerId: 'google', methodId: 'google-gemini-cli' },
      {
        loadAuthRegistry: async () => createRegistry(),
        runCommand,
        runStreamingCommand,
        inspectOAuthDependency: async () => ({
          ready: false,
          action: {
            dependencyId: 'gemini-cli',
            title: '安装 Gemini 命令行工具',
            message: '未检测到 Gemini 命令行工具。',
            commandName: 'gemini',
            recommendedMethod: 'npm',
            installOptions: [
              {
                method: 'npm',
                label: '使用 npm 全局安装',
                commandPreview: 'npm install -g @google/gemini-cli',
              },
            ],
          },
        }),
      }
    )

    expect(result.ok).toBe(false)
    expect(result.message).toContain('未检测到 Gemini 命令行工具')
    expect(result.preflightAction?.dependencyId).toBe('gemini-cli')
    expect(runCommand).not.toHaveBeenCalled()
    expect(runStreamingCommand).not.toHaveBeenCalled()
  })

  it('still normalizes Gemini CLI failures reported by the downstream command after preflight passes', async () => {
    const emitted: Array<{ channel: string; payload: Record<string, any> }> = []
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'plugins') {
        return {
          ok: true,
          stdout: 'Enabled plugin "google-gemini-cli-auth".',
          stderr: '',
          code: 0,
        }
      }
      return { ok: true, stdout: '', stderr: '', code: 0 }
    })
    const runStreamingCommand = vi.fn(async () => ({
      ok: false,
      stdout: RAW_GEMINI_PTY_FAILURE,
      stderr: '',
      code: 1,
    }))

    const result = await startModelOAuthFlow(
      { providerId: 'google', methodId: 'google-gemini-cli' },
      {
        loadAuthRegistry: async () => createRegistry(),
        emit: (channel, payload) => emitted.push({ channel, payload }),
        runCommand,
        runStreamingCommand,
        inspectOAuthDependency: async () => ({ ready: true }),
        verifyProviderPersistence: async () => false,
      }
    )

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      ['plugins', 'enable', 'google-gemini-cli-auth'],
      expect.any(Number)
    )
    expect(runStreamingCommand).toHaveBeenNthCalledWith(
      1,
      ['models', 'auth', 'login', '--provider', 'google-gemini-cli', '--method', 'oauth'],
      expect.objectContaining({ autoOpenOAuth: true, onOAuthUrl: expect.any(Function) })
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('未检测到 Gemini 命令行工具')
    expect(result.message).not.toContain('[?25h')
    expect(emitted.find((entry) => entry.channel === 'oauth:error')?.payload.stderr).toContain('未检测到 Gemini 命令行工具')
  })

  it('upgrades generic Gemini OAuth failures into a project-env specific message when preflight warned about GOOGLE_CLOUD_PROJECT', async () => {
    const emitted: Array<{ channel: string; payload: Record<string, any> }> = []
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'plugins') {
        return {
          ok: true,
          stdout: 'Enabled plugin "google-gemini-cli-auth".',
          stderr: '',
          code: 0,
        }
      }
      return { ok: true, stdout: '', stderr: '', code: 0 }
    })
    const runStreamingCommand = vi.fn(async () => ({
      ok: false,
      stdout: '◇ Gemini CLI OAuth failed',
      stderr: '',
      code: 1,
    }))

    const result = await startModelOAuthFlow(
      { providerId: 'google', methodId: 'google-gemini-cli' },
      {
        loadAuthRegistry: async () => createRegistry(),
        emit: (channel, payload) => emitted.push({ channel, payload }),
        runCommand,
        runStreamingCommand,
        inspectOAuthDependency: async () => ({
          ready: true,
          warnings: [
            {
              id: 'google-cloud-project-missing',
              title: '可能需要 Google Cloud 项目 ID',
              message: '缺少 GOOGLE_CLOUD_PROJECT。',
            },
          ],
        }),
        verifyProviderPersistence: async () => false,
      }
    )

    expect(result.ok).toBe(false)
    expect(result.message).toBe(buildGeminiProjectEnvFailureMessage())
    expect(result.preflightWarnings).toEqual([
      expect.objectContaining({
        id: 'google-cloud-project-missing',
      }),
    ])
    expect(emitted.find((entry) => entry.channel === 'oauth:error')?.payload.stderr).toBe(
      buildGeminiProjectEnvFailureMessage()
    )
  })

  it('treats browser auth as successful when credentials are verified after a noisy command failure', async () => {
    const emitted: Array<{ channel: string; payload: Record<string, any> }> = []
    const pruneStalePluginEntries = vi.fn(async () => ({
      changed: true,
      removedPluginIds: ['MiniMax-M2.5'],
    }))
    const verifyProviderPersistence = vi.fn(async () => true)
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'plugins') {
        return {
          ok: true,
          stdout: 'Enabled plugin "google-gemini-cli-auth".',
          stderr: '',
          code: 0,
        }
      }
      return { ok: true, stdout: '', stderr: '', code: 0 }
    })
    const runStreamingCommand = vi.fn(async () => ({
      ok: false,
      stdout: '◇ Gemini CLI OAuth failed',
      stderr: RAW_STALE_PLUGIN_WARNING,
      code: 1,
    }))

    const result = await startModelOAuthFlow(
      { providerId: 'google', methodId: 'google-gemini-cli' },
      {
        loadAuthRegistry: async () => createRegistry(),
        emit: (channel, payload) => emitted.push({ channel, payload }),
        runCommand,
        runStreamingCommand,
        inspectOAuthDependency: async () => ({ ready: true }),
        verifyProviderPersistence,
        pruneStalePluginEntries,
      }
    )

    expect(result.ok).toBe(true)
    expect(result.loginProviderId).toBe('google-gemini-cli')
    expect(verifyProviderPersistence).toHaveBeenCalledWith(['google', 'google-gemini-cli'])
    expect(pruneStalePluginEntries).toHaveBeenCalledWith(['MiniMax-M2.5'])
    expect(emitted.some((entry) => entry.channel === 'oauth:success')).toBe(true)
    expect(emitted.some((entry) => entry.channel === 'oauth:error')).toBe(false)
  })
})
