import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyModelConfigAction,
  getModelStatus,
  validateProviderCredential,
  scanLocalModels,
  type ModelConfigAction,
} from '../openclaw-model-config'
import type { CliCommandResult } from '../openclaw-capabilities'
import { resetOpenClawLegacyEnvWarningsForTests } from '../openclaw-legacy-env-migration'

function ok(stdout = ''): CliCommandResult {
  return { ok: true, stdout, stderr: '', code: 0 }
}

function failed(stderr: string, code = 1): CliCommandResult {
  return { ok: false, stdout: '', stderr, code }
}

function failedWithStdout(stdout: string, code = 1): CliCommandResult {
  return { ok: false, stdout, stderr: '', code }
}

beforeEach(() => {
  resetOpenClawLegacyEnvWarningsForTests()
  vi.unstubAllGlobals()
})

describe('applyModelConfigAction', () => {
  it('maps every action to expected openclaw command args', async () => {
    const cases: Array<{ action: ModelConfigAction; expected: string[]; stdout?: string }> = [
      {
        action: { kind: 'set-default-model', model: 'openai/gpt-5.1-codex' },
        expected: ['models', 'set', 'openai/gpt-5.1-codex'],
      },
      {
        action: { kind: 'set-image-model', model: 'openai/gpt-image-1' },
        expected: ['models', 'set-image', 'openai/gpt-image-1'],
      },
      {
        action: { kind: 'alias-add', alias: 'GPT', model: 'openai/gpt-5.1-codex' },
        expected: ['models', 'aliases', 'add', 'GPT', 'openai/gpt-5.1-codex'],
      },
      {
        action: { kind: 'alias-remove', alias: 'GPT' },
        expected: ['models', 'aliases', 'remove', 'GPT'],
      },
      {
        action: { kind: 'alias-list' },
        expected: ['models', 'aliases', 'list', '--json'],
        stdout: '{"GPT":"openai/gpt-5.1-codex"}',
      },
      {
        action: { kind: 'fallback-add', model: 'openai/gpt-4o' },
        expected: ['models', 'fallbacks', 'add', 'openai/gpt-4o'],
      },
      {
        action: { kind: 'fallback-remove', model: 'openai/gpt-4o' },
        expected: ['models', 'fallbacks', 'remove', 'openai/gpt-4o'],
      },
      {
        action: { kind: 'fallback-list' },
        expected: ['models', 'fallbacks', 'list', '--json'],
        stdout: '["openai/gpt-4o"]',
      },
      {
        action: { kind: 'fallback-clear' },
        expected: ['models', 'fallbacks', 'clear'],
      },
      {
        action: { kind: 'image-fallback-add', model: 'openai/gpt-image-1' },
        expected: ['models', 'image-fallbacks', 'add', 'openai/gpt-image-1'],
      },
      {
        action: { kind: 'image-fallback-remove', model: 'openai/gpt-image-1' },
        expected: ['models', 'image-fallbacks', 'remove', 'openai/gpt-image-1'],
      },
      {
        action: { kind: 'image-fallback-list' },
        expected: ['models', 'image-fallbacks', 'list', '--json'],
        stdout: '["openai/gpt-image-1"]',
      },
      {
        action: { kind: 'image-fallback-clear' },
        expected: ['models', 'image-fallbacks', 'clear'],
      },
      {
        action: {
          kind: 'scan-models',
          provider: 'openrouter',
          json: true,
          yes: true,
          noProbe: true,
          setDefault: true,
          setImage: true,
          maxCandidates: 8,
          timeoutMs: 20000,
          concurrency: 4,
          maxAgeDays: 30,
          minParams: 7,
          noInput: true,
        },
        expected: [
          'models',
          'scan',
          '--provider',
          'openrouter',
          '--json',
          '--yes',
          '--no-probe',
          '--set-default',
          '--set-image',
          '--max-candidates',
          '8',
          '--timeout',
          '20000',
          '--concurrency',
          '4',
          '--max-age-days',
          '30',
          '--min-params',
          '7',
          '--no-input',
        ],
        stdout: '{"selected":["openrouter/deepseek-v3"]}',
      },
    ]

    for (const testCase of cases) {
      const runCommand = vi.fn(async () => ok(testCase.stdout || ''))
      const result = await applyModelConfigAction(testCase.action, { runCommand })
      expect(runCommand).toHaveBeenCalledWith(testCase.expected, expect.any(Number))
      expect(result.ok).toBe(true)
    }
  })

  it('returns command_failed when command exits non-zero', async () => {
    const runCommand = vi.fn(async () => failed('permission denied', 2))
    const result = await applyModelConfigAction(
      { kind: 'set-default-model', model: 'openai/gpt-5.1-codex' },
      { runCommand }
    )
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('command_failed')
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('permission denied')
  })

  it('returns parse_error for list actions with invalid json', async () => {
    const runCommand = vi.fn(async () => ok('not-json'))
    const result = await applyModelConfigAction({ kind: 'alias-list' }, { runCommand })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('parse_error')
  })

  it('returns parse_error for scan-models when --json output is invalid', async () => {
    const runCommand = vi.fn(async () => ok('not-json'))
    const result = await applyModelConfigAction(
      { kind: 'scan-models', json: true },
      { runCommand }
    )
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('parse_error')
  })
})

describe('getModelStatus', () => {
  it('runs status through a read-only auth store env by default', async () => {
    const runCommandWithEnv = vi.fn(async () =>
      ok(
        JSON.stringify({
          defaultModel: 'openai/gpt-5.1-codex',
        })
      )
    )

    const result = await getModelStatus({}, { runCommandWithEnv })

    expect(runCommandWithEnv).toHaveBeenCalledWith(
      ['models', 'status', '--json'],
      expect.any(Number),
      expect.objectContaining({
        OPENCLAW_AUTH_STORE_READONLY: '1',
      })
    )
    expect(result.ok).toBe(true)
    expect((result.data as any).defaultModel).toBe('openai/gpt-5.1-codex')
  })

  it('maps probe-related options and parses JSON status', async () => {
    const runCommand = vi.fn(async () =>
      ok(
        JSON.stringify({
          defaultModel: 'openai/gpt-5.1-codex',
          fallbacks: ['openai/gpt-4o'],
          aliases: { GPT: 'openai/gpt-5.1-codex' },
        })
      )
    )

    const result = await getModelStatus(
      {
        probe: true,
        probeProvider: 'openai',
        probeTimeoutMs: 5000,
        probeConcurrency: 3,
        probeMaxTokens: 256,
        probeProfile: ['openai:default', 'openai:staging'],
        check: true,
      },
      { runCommand }
    )

    expect(runCommand).toHaveBeenCalledWith(
      [
        'models',
        'status',
        '--json',
        '--probe',
        '--probe-provider',
        'openai',
        '--probe-timeout',
        '5000',
        '--probe-concurrency',
        '3',
        '--probe-max-tokens',
        '256',
        '--probe-profile',
        'openai:default',
        '--probe-profile',
        'openai:staging',
        '--check',
      ],
      expect.any(Number)
    )
    expect(result.ok).toBe(true)
    expect((result.data as any).defaultModel).toBe('openai/gpt-5.1-codex')
  })

  it('passes agent-scoped status requests through to the CLI', async () => {
    const runCommand = vi.fn(async () =>
      ok(
        JSON.stringify({
          defaultModel: 'minimax/MiniMax-M2.5',
        })
      )
    )

    const result = await getModelStatus(
      {
        agentId: 'feishu-work',
      },
      { runCommand }
    )

    expect(runCommand).toHaveBeenCalledWith(
      ['models', 'status', '--json', '--agent', 'feishu-work'],
      expect.any(Number)
    )
    expect(result.ok).toBe(true)
    expect((result.data as any).defaultModel).toBe('minimax/MiniMax-M2.5')
  })

  it('returns command_failed when status command fails', async () => {
    const runCommand = vi.fn(async () => failed('gateway unreachable', 1))
    const result = await getModelStatus({}, { runCommand })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('command_failed')
  })

  it('returns parse_error when status output is invalid JSON', async () => {
    const runCommand = vi.fn(async () => ok('{oops'))
    const result = await getModelStatus({}, { runCommand })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('parse_error')
  })

  it('parses status json when stdout contains log lines before the json payload', async () => {
    const runCommand = vi.fn(async () =>
      ok(
        [
          '[plugins] feishu_doc: Registered feishu_doc',
          '[plugins] feishu_chat: Registered feishu_chat tool',
          JSON.stringify({
            defaultModel: 'openai/gpt-5.1-codex',
            auth: {
              providers: [{ provider: 'openai', status: 'ok' }],
            },
          }),
        ].join('\n')
      )
    )
    const result = await getModelStatus({}, { runCommand })
    expect(result.ok).toBe(true)
    expect((result.data as any).defaultModel).toBe('openai/gpt-5.1-codex')
  })

  it('retries status reads once after stale plugin repair removes upstream-confirmed stale ids', async () => {
    const repairStalePluginConfigFromCommandResult = vi
      .fn()
      .mockResolvedValueOnce({
        stalePluginIds: ['fake-stale-plugin'],
        changed: true,
        removedPluginIds: ['fake-stale-plugin'],
      })
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(ok('Config warnings:\n- plugins.allow: plugin not found: fake-stale-plugin (stale config entry ignored; remove it from plugins config)'))
      .mockResolvedValueOnce(
        ok(
          JSON.stringify({
            defaultModel: 'openai/gpt-5.1-codex',
            auth: {
              providers: [{ provider: 'openai', status: 'ok' }],
            },
          })
        )
      )

    const result = await getModelStatus({}, { runCommand, repairStalePluginConfigFromCommandResult })

    expect(runCommand).toHaveBeenCalledTimes(2)
    expect(repairStalePluginConfigFromCommandResult).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect((result.data as any).defaultModel).toBe('openai/gpt-5.1-codex')
  })

  it('falls back to the original status result when stale plugin repair throws', async () => {
    const repairStalePluginConfigFromCommandResult = vi.fn(async () => {
      throw new Error('repair failed')
    })
    const runCommand = vi.fn(async () =>
      ok('Config warnings:\n- plugins.allow: plugin not found: fake-stale-plugin (stale config entry ignored; remove it from plugins config)')
    )

    const result = await getModelStatus({}, { runCommand, repairStalePluginConfigFromCommandResult })

    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('parse_error')
  })
})

describe('validateProviderCredential', () => {
  it('validates the current secret with an isolated OpenClaw home', async () => {
    const runCommandWithEnv = vi.fn(async () =>
      ok(
        JSON.stringify({
          probe: {
            openai: {
              ok: true,
              status: 'ok',
            },
          },
        })
      )
    )
    const createTempDir = vi.fn(async () => '/tmp/qclaw-provider-validate-test')
    const removeTempDir = vi.fn(async () => {})

    const result = await validateProviderCredential(
      {
        providerId: 'openai',
        methodId: 'openai-api-key',
        secret: 'sk-openai-test',
        timeoutMs: 5000,
      },
      {
        runCommandWithEnv,
        createTempDir,
        removeTempDir,
      }
    )

    expect(result.ok).toBe(true)
    expect(result.validated).toBe(true)
    expect(result.message).toContain('API Key 有效')
    expect(runCommandWithEnv).toHaveBeenCalledWith(
      [
        'models',
        'status',
        '--json',
        '--probe',
        '--probe-provider',
        'openai',
        '--probe-timeout',
        '5000',
        '--check',
      ],
      expect.any(Number),
      expect.objectContaining({
        ANTHROPIC_API_KEY: undefined,
        CLAWDBOT_CONFIG_PATH: undefined,
        CLAWDBOT_GATEWAY_TOKEN: undefined,
        CLAWDBOT_GATEWAY_URL: undefined,
        CLAWDBOT_STATE_DIR: undefined,
        MOLTBOT_CONFIG_PATH: undefined,
        MOLTBOT_GATEWAY_TOKEN: undefined,
        MOLTBOT_GATEWAY_URL: undefined,
        MOLTBOT_STATE_DIR: undefined,
        OPENAI_API_KEY: 'sk-openai-test',
        OPENAI_BASE_URL: undefined,
        OPENCLAW_HOME: '/tmp/qclaw-provider-validate-test',
        OPENCLAW_AUTH_STORE_READONLY: '1',
      })
    )
    expect(removeTempDir).toHaveBeenCalledWith('/tmp/qclaw-provider-validate-test')
  })

  it('fails closed when probe results are missing even if the command itself succeeds', async () => {
    const runCommandWithEnv = vi.fn(async () => ok(JSON.stringify({ auth: { providers: [{ provider: 'openai', status: 'ok' }] } })))

    const result = await validateProviderCredential(
      {
        providerId: 'openai',
        methodId: 'openai-api-key',
        secret: 'sk-test',
      },
      {
        runCommandWithEnv,
        createTempDir: async () => '/tmp/qclaw-provider-validate-empty',
        removeTempDir: async () => {},
      }
    )

    expect(result.ok).toBe(false)
    expect(result.validated).toBe(false)
    expect(result.message).toContain('未返回可判定的探测结果')
  })

  it('interprets structured probe json on non-zero exit instead of surfacing raw json', async () => {
    const runCommandWithEnv = vi.fn(async () =>
      failedWithStdout(
        JSON.stringify({
          probe: {
            openai: {
              status: 'missing',
            },
          },
        })
      )
    )

    const result = await validateProviderCredential(
      {
        providerId: 'openai',
        methodId: 'openai-api-key',
        secret: 'sk-test',
      },
      {
        runCommandWithEnv,
        createTempDir: async () => '/tmp/qclaw-provider-validate-missing',
        removeTempDir: async () => {},
      }
    )

    expect(result.ok).toBe(false)
    expect(result.validated).toBe(false)
    expect(result.message).toBe('API Key 校验失败，请检查凭证是否正确或账户是否已开通对应模型权限。')
  })

  it('returns unsupported when the auth method has no env-based realtime validation route', async () => {
    const createTempDir = vi.fn(async () => '/tmp/should-not-run')

    const result = await validateProviderCredential(
      {
        providerId: 'synthetic',
        methodId: 'synthetic-api-key',
        secret: 'sk-test',
      },
      {
        createTempDir,
      }
    )

    expect(result.ok).toBe(false)
    expect(result.validated).toBe(false)
    expect(result.message).toContain('暂不支持无歧义的实时 API Key 校验')
    expect(createTempDir).not.toHaveBeenCalled()
  })

  it('returns unsupported for ambiguous auth choices that share one provider env key', async () => {
    const createTempDir = vi.fn(async () => '/tmp/should-not-run')

    const result = await validateProviderCredential(
      {
        providerId: 'moonshot',
        methodId: 'kimi-code-api-key',
        secret: 'sk-test',
      },
      {
        createTempDir,
      }
    )

    expect(result.ok).toBe(false)
    expect(result.validated).toBe(false)
    expect(result.message).toContain('暂不支持无歧义的实时 API Key 校验')
    expect(createTempDir).not.toHaveBeenCalled()
  })
})

describe('scanLocalModels', () => {
  it('enables local provider plugin before listing when plugin enabler is provided', async () => {
    const enablePluginCommand = vi.fn(async () => ok('Plugin "ollama" already enabled.'))
    const runCommand = vi.fn(async () =>
      ok(
        JSON.stringify({
          models: [{ key: 'ollama/qwen2.5:7b', name: 'Qwen 2.5 7B' }],
        })
      )
    )
    const result = await scanLocalModels(
      { provider: 'ollama' },
      {
        runCommand,
        enablePluginCommand,
      }
    )

    expect(enablePluginCommand).toHaveBeenCalledWith('ollama', expect.any(Number))
    expect(runCommand).toHaveBeenCalledWith(
      ['models', 'list', '--all', '--local', '--json', '--provider', 'ollama'],
      expect.any(Number)
    )
    expect(result.ok).toBe(true)
    expect((result.data as any).models).toEqual([
      { key: 'ollama/qwen2.5:7b', name: 'Qwen 2.5 7B' },
    ])
  })

  it('returns command_failed when enabling local provider plugin fails', async () => {
    const enablePluginCommand = vi.fn(async () => failed('permission denied'))
    const runCommand = vi.fn(async () => ok(JSON.stringify({ models: [] })))
    const result = await scanLocalModels(
      { provider: 'ollama' },
      {
        runCommand,
        enablePluginCommand,
      }
    )

    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('command_failed')
    expect(result.command).toEqual(['plugins', 'enable', 'ollama'])
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('normalizes array payload and ollama names into provider-prefixed keys', async () => {
    const runCommand = vi.fn(async () => ok(JSON.stringify([{ name: 'qwen2.5:7b' }])))
    const result = await scanLocalModels({ provider: 'ollama' }, { runCommand })

    expect(result.ok).toBe(true)
    expect((result.data as any).models).toEqual([
      { key: 'ollama/qwen2.5:7b', name: 'qwen2.5:7b' },
    ])
    expect((result.data as any).count).toBe(1)
  })

  it('normalizes object payload with data[] entries using id/model/key fallbacks', async () => {
    const runCommand = vi.fn(async () =>
      ok(
        JSON.stringify({
          data: [
            { id: 'deepseek-r1:8b' },
            { model: 'llama3.2:3b' },
            { key: 'ollama/qwen2.5:14b', name: 'Qwen 2.5 14B' },
          ],
        })
      )
    )
    const result = await scanLocalModels({ provider: 'ollama' }, { runCommand })

    expect(result.ok).toBe(true)
    expect((result.data as any).models).toEqual([
      { key: 'ollama/deepseek-r1:8b', name: 'deepseek-r1:8b' },
      { key: 'ollama/llama3.2:3b', name: 'llama3.2:3b' },
      { key: 'ollama/qwen2.5:14b', name: 'Qwen 2.5 14B' },
    ])
    expect((result.data as any).count).toBe(3)
  })

  it('treats plain-text "No models found." output as an empty successful list', async () => {
    const runCommand = vi.fn(async () => ok('No models found.'))
    const result = await scanLocalModels({ provider: 'ollama' }, { runCommand })

    expect(runCommand).toHaveBeenCalledWith(
      ['models', 'list', '--all', '--local', '--json', '--provider', 'ollama'],
      expect.any(Number)
    )
    expect(result.ok).toBe(true)
    expect(result.errorCode).toBeUndefined()
    expect((result.data as any).models).toEqual([])
    expect((result.data as any).count).toBe(0)
  })

  it('returns parse_error when output is invalid non-json text that is not a known empty-list message', async () => {
    const runCommand = vi.fn(async () => ok('something unexpected'))
    const result = await scanLocalModels({ provider: 'ollama' }, { runCommand })

    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('parse_error')
  })

  it('falls back to direct /models discovery for custom-openai when the CLI reports no models found', async () => {
    const runCommand = vi.fn(async () => ok('No models found.'))
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: 'gpt-5' },
          { id: 'gpt-4.1', display_name: 'GPT-4.1' },
        ],
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await scanLocalModels(
      {
        provider: 'custom-openai',
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: 'sk-test',
      },
      { runCommand }
    )

    expect(runCommand).toHaveBeenCalledWith(
      ['models', 'list', '--all', '--local', '--json', '--provider', 'custom-openai'],
      expect.any(Number)
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:1234/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer sk-test',
        }),
      })
    )
    expect(result.ok).toBe(true)
    expect((result.data as any).models).toEqual([
      { key: 'custom-openai/gpt-5', name: 'gpt-5' },
      { key: 'custom-openai/gpt-4.1', name: 'gpt-4.1' },
    ])
    expect((result.data as any).count).toBe(2)
  })
})
