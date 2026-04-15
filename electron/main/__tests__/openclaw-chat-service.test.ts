import { beforeEach, describe, expect, it, vi } from 'vitest'
const {
  runCliMock,
  runCliStreamingMock,
  gatewayHealthMock,
  ensureGatewayRunningMock,
  getModelCatalogMock,
  getModelStatusMock,
  getOpenClawUpstreamModelStateMock,
  discoverOpenClawMock,
  readConfigMock,
  readEnvFileMock,
  callGatewayRpcViaControlUiBrowserMock,
  runGatewayChatViaControlUiBrowserMock,
} = vi.hoisted(() => ({
  runCliMock: vi.fn(),
  runCliStreamingMock: vi.fn(),
  gatewayHealthMock: vi.fn(),
  ensureGatewayRunningMock: vi.fn(),
  getModelCatalogMock: vi.fn(),
  getModelStatusMock: vi.fn(),
  getOpenClawUpstreamModelStateMock: vi.fn(),
  discoverOpenClawMock: vi.fn(),
  readConfigMock: vi.fn(),
  readEnvFileMock: vi.fn(),
  callGatewayRpcViaControlUiBrowserMock: vi.fn(),
  runGatewayChatViaControlUiBrowserMock: vi.fn(),
}))

vi.mock('../cli', () => ({
  gatewayHealth: gatewayHealthMock,
  runCli: runCliMock,
  runCliStreaming: runCliStreamingMock,
  readConfig: readConfigMock,
  readEnvFile: readEnvFileMock,
}))

vi.mock('../openclaw-model-config', () => ({
  getModelStatus: getModelStatusMock,
}))

vi.mock('../openclaw-model-catalog', () => ({
  getModelCatalog: getModelCatalogMock,
}))

vi.mock('../openclaw-upstream-model-state', () => ({
  getOpenClawUpstreamModelState: getOpenClawUpstreamModelStateMock,
}))

vi.mock('../openclaw-install-discovery', () => ({
  discoverOpenClawInstallations: discoverOpenClawMock,
}))

vi.mock('../openclaw-gateway-service', () => ({
  ensureGatewayRunning: ensureGatewayRunningMock,
}))

vi.mock('../openclaw-control-ui-rpc', () => ({
  callGatewayRpcViaControlUiBrowser: callGatewayRpcViaControlUiBrowserMock,
  runGatewayChatViaControlUiBrowser: runGatewayChatViaControlUiBrowserMock,
}))

import {
  buildDashboardChatAvailabilityFromStatus,
  clearChatTranscript,
  createChatSession,
  createLocalChatSession,
  getChatCapabilitySnapshot,
  getChatSessionDebugSnapshot,
  getDashboardChatAvailability,
  getChatTranscript,
  listChatSessions,
  listChatTraceEntries,
  patchChatSessionModel,
  parseAgentReplyOutput,
  resetDashboardChatAvailabilityTrackerForTests,
  sendChatMessage,
  shouldPreferControlUiBrowserChatTransportForSend,
} from '../openclaw-chat-service'
import type { OpenClawCapabilities } from '../openclaw-capabilities'
import { executeAuthRoute } from '../openclaw-auth-executor'
import type { OpenClawAuthMethodDescriptor } from '../openclaw-auth-registry'
import { createOpenClawAuthRegistry } from '../openclaw-auth-registry'
import { appendLocalChatMessages } from '../qclaw-chat-store'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { mkdtemp, mkdir, readFile, rm, writeFile } = fs.promises

describe('openclaw chat service', () => {
  let userDataDir = ''

  const writeLegacyChatStore = async (store: Record<string, unknown>) => {
    const chatDir = path.join(userDataDir, 'chat')
    await mkdir(chatDir, { recursive: true })
    await writeFile(path.join(chatDir, 'transcripts.json'), JSON.stringify(store, null, 2), 'utf8')
  }

  const createDiscovery = (fingerprint: string) =>
    (async () =>
      ({
        status: 'installed',
        candidates: [
          {
            candidateId: 'candidate-1',
            binaryPath: '/usr/local/bin/openclaw',
            resolvedBinaryPath: '/usr/local/bin/openclaw',
            packageRoot: '/usr/local/lib/node_modules/openclaw',
            version: '2026.3.12',
            installSource: 'npm-global',
            isPathActive: true,
            configPath: '/Users/test/.openclaw/openclaw.json',
            stateRoot: '/Users/test/.openclaw',
            displayConfigPath: '~/.openclaw/openclaw.json',
            displayStateRoot: '~/.openclaw',
            ownershipState: 'external-preexisting',
            installFingerprint: fingerprint,
            baselineBackup: null,
            baselineBackupBypass: null,
          },
        ],
        activeCandidateId: 'candidate-1',
        hasMultipleCandidates: false,
        historyDataCandidates: [],
        errors: [],
        warnings: [],
        defaultBackupDirectory: '/tmp',
      }) as any)

  const createModelStatus = (defaultModel: string) =>
    ({
      ok: true,
      action: 'status',
      command: ['models', 'status', '--json'],
      stdout: '',
      stderr: '',
      code: 0,
      data: {
        defaultModel,
      },
    }) as any

  const createCapabilities = (
    overrides: Partial<OpenClawCapabilities['supports']> = {}
  ): OpenClawCapabilities =>
    ({
      version: 'OpenClaw 2026.3.23',
      discoveredAt: '2026-03-23T00:00:00.000Z',
      authRegistry: createOpenClawAuthRegistry({
        source: 'openclaw-internal-registry',
        providers: [],
      }),
      authRegistrySource: 'openclaw-internal-registry',
      authChoices: [],
      rootCommands: ['agent', 'models', 'plugins', 'onboard'],
      onboardFlags: [],
      modelsCommands: ['status'],
      modelsAuthCommands: [],
      pluginsCommands: [],
      commandFlags: {
        agent: ['--model'],
        'models status': ['--json'],
      },
      supports: {
        onboard: true,
        plugins: true,
        pluginsInstall: true,
        pluginsEnable: true,
        chatAgentModelFlag: true,
        chatGatewaySendModel: false,
        chatInThreadModelSwitch: true,
        modelsListAllJson: false,
        modelsStatusJson: true,
        modelsAuthLogin: false,
        modelsAuthAdd: false,
        modelsAuthPasteToken: false,
        modelsAuthSetupToken: false,
        modelsAuthOrder: false,
        modelsAuthLoginGitHubCopilot: false,
        aliases: false,
        fallbacks: false,
        imageFallbacks: false,
        modelsScan: false,
        ...overrides,
      },
    }) as OpenClawCapabilities

  const minimaxOauthMethod: OpenClawAuthMethodDescriptor = {
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
  }

  beforeEach(async () => {
    resetDashboardChatAvailabilityTrackerForTests()
    runCliMock.mockReset()
    runCliStreamingMock.mockReset()
    gatewayHealthMock.mockReset()
    ensureGatewayRunningMock.mockReset()
    getModelCatalogMock.mockReset()
    getModelStatusMock.mockReset()
    getOpenClawUpstreamModelStateMock.mockReset()
    discoverOpenClawMock.mockReset()
    readConfigMock.mockReset()
    readEnvFileMock.mockReset()
    callGatewayRpcViaControlUiBrowserMock.mockReset()
    runGatewayChatViaControlUiBrowserMock.mockReset()
    readConfigMock.mockResolvedValue(null)
    readEnvFileMock.mockResolvedValue({})
    getModelCatalogMock.mockResolvedValue({
      total: 0,
      items: [],
      providers: [],
      updatedAt: '2026-03-26T00:00:00.000Z',
      source: 'cache',
      stale: false,
    })
    getOpenClawUpstreamModelStateMock.mockResolvedValue({
      ok: false,
      source: 'control-ui-app',
      fallbackUsed: true,
      fallbackReason: 'control-ui-app-unavailable',
      diagnostics: {
        upstreamAvailable: false,
        connected: false,
        hasClient: false,
        hasHelloSnapshot: false,
        hasHealthResult: false,
        hasSessionsState: false,
        hasModelCatalogState: false,
        appKeys: [],
        lastError: 'control-ui-app-unavailable',
      },
    })
    if (userDataDir) {
      await rm(userDataDir, { recursive: true, force: true })
    }
    userDataDir = await mkdtemp(path.join(os.tmpdir(), 'qclaw-chat-service-'))
    process.env.QCLAW_USER_DATA_DIR = userDataDir
  })

  it('marks chat unavailable when no configured model is connected', () => {
    const availability = buildDashboardChatAvailabilityFromStatus({
      gatewayRunning: true,
      modelStatus: {
        ok: true,
        action: 'status',
        command: ['models', 'status', '--json'],
        stdout: '',
        stderr: '',
        code: 0,
        data: {
          allowed: [],
        },
      },
    })

    expect(availability.ready).toBe(false)
    expect(availability.state).toBe('no-model')
    expect(availability.canSend).toBe(false)
    expect(availability.reason).toBe('no-configured-model')
  })

  it('treats openai-codex auth provider as compatible with openai/* model keys', () => {
    const availability = buildDashboardChatAvailabilityFromStatus({
      gatewayRunning: true,
      modelStatus: {
        ok: true,
        action: 'status',
        command: ['models', 'status', '--json'],
        stdout: '',
        stderr: '',
        code: 0,
        data: {
          defaultModel: 'openai/gpt-5.1-codex',
          allowed: ['openai/gpt-5.1-codex'],
          auth: {
            providers: [
              {
                provider: 'openai-codex',
                status: 'ok',
              },
            ],
          },
        },
      },
    })

    expect(availability.ready).toBe(true)
    expect(availability.state).toBe('ready')
    expect(availability.canSend).toBe(true)
    expect(availability.connectedModels).toEqual(['openai/gpt-5.1-codex'])
  })

  it('treats google auth provider as compatible with gemini/* model keys', () => {
    const availability = buildDashboardChatAvailabilityFromStatus({
      gatewayRunning: true,
      modelStatus: {
        ok: true,
        action: 'status',
        command: ['models', 'status', '--json'],
        stdout: '',
        stderr: '',
        code: 0,
        data: {
          defaultModel: 'gemini/gemini-2.5-pro',
          allowed: ['gemini/gemini-2.5-pro'],
          auth: {
            providers: [
              {
                provider: 'google',
                status: 'ok',
              },
            ],
          },
        },
      },
    })

    expect(availability.ready).toBe(true)
    expect(availability.state).toBe('ready')
    expect(availability.canSend).toBe(true)
    expect(availability.connectedModels).toEqual(['gemini/gemini-2.5-pro'])
  })

  it('reuses the models page visible catalog when building chat selectable models', async () => {
    gatewayHealthMock.mockResolvedValue({ running: true, raw: 'running' })
    readEnvFileMock.mockResolvedValue({
      GEMINI_API_KEY: 'google-local',
    })
    getModelStatusMock.mockResolvedValue({
      ok: true,
      action: 'status',
      command: ['models', 'status', '--json'],
      stdout: '',
      stderr: '',
      code: 0,
      data: {
        defaultModel: 'google/gemini-3-pro-preview',
        allowed: ['google/gemini-3-pro-preview'],
        auth: {
          providers: [{ provider: 'google', status: 'ok' }],
        },
      },
    })
    getModelCatalogMock.mockResolvedValue({
      total: 4,
      items: [
        { key: 'google/gemini-3-pro-preview', provider: 'google', available: true, name: 'Gemini 3 Pro Preview' },
        { key: 'google/gemini-2.5-pro', provider: 'google', available: true, name: 'Gemini 2.5 Pro' },
        { key: 'google/gemini-1.5-flash', provider: 'google', available: false, name: 'Gemini 1.5 Flash' },
        { key: 'xai/grok-4-fast-non-reasoning', provider: 'xai', available: true, name: 'Grok 4 Fast' },
      ],
      providers: ['google', 'xai'],
      updatedAt: '2026-03-26T00:00:00.000Z',
      source: 'cache',
      stale: false,
    })

    const availability = await getDashboardChatAvailability()

    expect(availability.ready).toBe(true)
    expect(availability.state).toBe('ready')
    expect(availability.connectedModels).toEqual(['google/gemini-3-pro-preview'])
    expect(availability.defaultModel).toBe('google/gemini-3-pro-preview')
  })

  it('does not fall back to runtime allowed models when the models page catalog is intentionally empty', async () => {
    gatewayHealthMock.mockResolvedValue({ running: true, raw: 'running' })
    getModelStatusMock.mockResolvedValue({
      ok: true,
      action: 'status',
      command: ['models', 'status', '--json'],
      stdout: '',
      stderr: '',
      code: 0,
      data: {
        defaultModel: 'google/gemini-3-pro-preview',
        allowed: ['google/gemini-2.5-pro'],
        auth: {
          providers: [{ provider: 'google', status: 'ok' }],
        },
      },
    })
    getModelCatalogMock.mockResolvedValue({
      total: 0,
      items: [],
      providers: [],
      updatedAt: '2026-03-26T00:00:00.000Z',
      source: 'cache',
      stale: false,
    })

    const availability = await getDashboardChatAvailability()

    expect(availability.state).toBe('no-model')
    expect(availability.connectedModels).toEqual([])
    expect(availability.canSend).toBe(false)
    expect(availability.defaultModel).toBe('google/gemini-3-pro-preview')
  })

  it('returns a conservative phase 0 chat capability snapshot', async () => {
    const snapshot = await getChatCapabilitySnapshot({
      loadCapabilities: async () =>
        createCapabilities({
          chatInThreadModelSwitch: true,
        }),
    })

    expect(snapshot.version).toBe('OpenClaw 2026.3.23')
    expect(snapshot.supportsSessionsPatch).toBe(true)
    expect(snapshot.supportsChatHistory).toBe(false)
    expect(snapshot.supportsGatewayChatSend).toBe(true)
    expect(snapshot.supportsGatewayRpc).toBe(true)
    expect(snapshot.notes.join(' ')).toContain('chat.history')
  })

  it('reports chat.history as available only when the history flag and capability gate are both enabled', async () => {
    const snapshot = await getChatCapabilitySnapshot({
      chatHistoryPrimaryEnabled: true,
      loadCapabilities: async () =>
        createCapabilities({
          chatGatewaySendModel: true,
        }),
    })

    expect(snapshot.supportsChatHistory).toBe(true)
  })

  it('builds a debug snapshot for a local cached session without upstream authority', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-debug-local')

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-debug-local',
      sessionId: 'debug-local-session',
      agentId: 'main',
      model: 'openai/gpt-5.4-pro',
      selectedModel: 'openai/gpt-5.4-pro',
      transportSessionId: 'transport-debug-local',
      transportModel: 'openai/gpt-5.4-pro',
      kind: 'direct',
      messages: [
        {
          id: 'debug-local-msg-1',
          role: 'user',
          text: '本地缓存消息',
          createdAt: 8_000,
          status: 'sent',
        },
      ],
      updatedAt: 8_000,
    })

    const snapshot = await getChatSessionDebugSnapshot('debug-local-session', {
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({ sessions: [] }),
        stderr: '',
        code: 0,
      }),
    })

    expect(snapshot.requestedSessionId).toBe('debug-local-session')
    expect(snapshot.historySource).toBe('local-cache')
    expect(snapshot.authorityKind).toBe('local-cache-only')
    expect(snapshot.cachePresence).toBe('local-transcript')
    expect(snapshot.canContinue).toBe(false)
    expect(snapshot.legacySemanticsActive).toBe(true)
    expect(snapshot.notes.join(' ')).toContain('resolves from Qclaw local cache state without upstream authority')
    expect(snapshot.notes.join(' ')).toContain('Legacy transport/session fallback semantics')
  })

  it('migrates a legacy transport-derived sessionKey store entry into a conservative local cache record', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-store-migration-legacy')
    await writeLegacyChatStore({
      version: 2,
      sessions: [
        {
          scopeKey: 'fingerprint-store-migration-legacy',
          sessionId: 'legacy-session',
          sessionKey: 'agent:main:transport-legacy-session',
          agentId: 'main',
          model: 'zai/glm-5',
          selectedModel: 'openai/gpt-5.4-pro',
          transportSessionId: 'transport-legacy-session',
          transportModel: 'openai/gpt-5.4-pro',
          kind: 'direct',
          createdAt: 1_000,
          updatedAt: 1_100,
          messages: [
            {
              id: 'legacy-msg-1',
              role: 'user',
              text: '旧缓存消息',
              createdAt: 1_050,
              status: 'sent',
            },
          ],
        },
      ],
    })

    const sessions = await listChatSessions({
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({ sessions: [] }),
        stderr: '',
        code: 0,
      }),
    })

    expect(sessions).toHaveLength(1)
    expect(sessions[0].sessionKey).toBeUndefined()
    expect(sessions[0].selectedModel).toBe('zai/glm-5')
    expect(sessions[0].canPatchModel).toBe(false)
    expect(sessions[0].canContinue).toBe(false)
    expect(sessions[0].authorityKind).toBe('local-cache-only')

    const migratedStore = JSON.parse(
      await readFile(path.join(userDataDir, 'chat', 'transcripts.json'), 'utf8')
    ) as Record<string, any>
    expect(migratedStore.version).toBe(3)
    expect(migratedStore.sessions[0].sessionKey).toBeUndefined()
    expect(migratedStore.sessions[0].selectedModel).toBe('zai/glm-5')
    expect(migratedStore.sessions[0].transportModel).toBe('zai/glm-5')
  })

  it('does not invent transportSessionId when migrating an old store entry that never had one', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-store-migration-no-transport')
    await writeLegacyChatStore({
      version: 2,
      sessions: [
        {
          scopeKey: 'fingerprint-store-migration-no-transport',
          sessionId: 'legacy-no-transport',
          agentId: 'main',
          model: 'openai/gpt-5.4-pro',
          selectedModel: 'openai/gpt-5.4-pro',
          kind: 'direct',
          createdAt: 2_000,
          updatedAt: 2_100,
          messages: [
            {
              id: 'legacy-msg-2',
              role: 'assistant',
              text: '没有 transport 的旧记录',
              createdAt: 2_050,
              status: 'sent',
            },
          ],
        },
      ],
    })

    const transcript = await getChatTranscript('legacy-no-transport', {
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({ sessions: [] }),
        stderr: '',
        code: 0,
      }),
    })

    expect(transcript.sessionKey).toBeUndefined()
    expect(transcript.canPatchModel).toBe(false)
    expect(transcript.canContinue).toBe(false)
    expect(transcript.authorityKind).toBe('local-cache-only')

    const migratedStore = JSON.parse(
      await readFile(path.join(userDataDir, 'chat', 'transcripts.json'), 'utf8')
    ) as Record<string, any>
    expect(migratedStore.version).toBe(3)
    expect(migratedStore.sessions[0].transportSessionId).toBeUndefined()
  })

  it('preserves a trusted sessionKey while upgrading the store version', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-store-migration-trusted')
    await writeLegacyChatStore({
      version: 2,
      sessions: [
        {
          scopeKey: 'fingerprint-store-migration-trusted',
          sessionId: 'trusted-history',
          sessionKey: 'agent:main:history-direct-session',
          agentId: 'main',
          model: 'zai/glm-5',
          selectedModel: 'openai/gpt-5.4-pro',
          transportSessionId: 'transport-trusted-history',
          transportModel: 'zai/glm-5',
          kind: 'direct',
          createdAt: 3_000,
          updatedAt: 3_100,
          messages: [
            {
              id: 'legacy-msg-3',
              role: 'assistant',
              text: '可信 sessionKey 的旧记录',
              createdAt: 3_050,
              status: 'sent',
            },
          ],
        },
      ],
    })

    const sessions = await listChatSessions({
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({ sessions: [] }),
        stderr: '',
        code: 0,
      }),
    })

    expect(sessions).toHaveLength(1)
    expect(sessions[0].sessionKey).toBe('agent:main:history-direct-session')
    expect(sessions[0].selectedModel).toBe('openai/gpt-5.4-pro')

    const migratedStore = JSON.parse(
      await readFile(path.join(userDataDir, 'chat', 'transcripts.json'), 'utf8')
    ) as Record<string, any>
    expect(migratedStore.version).toBe(3)
    expect(migratedStore.sessions[0].sessionKey).toBe('agent:main:history-direct-session')
  })

  it('preserves the pending first-send model intent when migrating an empty local shell', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-store-migration-empty-shell')
    await writeLegacyChatStore({
      version: 2,
      sessions: [
        {
          scopeKey: 'fingerprint-store-migration-empty-shell',
          sessionId: 'legacy-empty-shell',
          agentId: 'main',
          selectedModel: 'openai/gpt-5.4-pro',
          transportModel: 'openai/gpt-5.4-pro',
          kind: 'direct',
          createdAt: 4_000,
          updatedAt: 4_100,
          messages: [],
        },
      ],
    })

    const sessions = await listChatSessions({
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({ sessions: [] }),
        stderr: '',
        code: 0,
      }),
    })

    expect(sessions).toHaveLength(1)
    expect(sessions[0].sessionKey).toBeUndefined()
    expect(sessions[0].selectedModel).toBe('openai/gpt-5.4-pro')
    expect(sessions[0].authorityKind).toBe('local-cache-only')

    const migratedStore = JSON.parse(
      await readFile(path.join(userDataDir, 'chat', 'transcripts.json'), 'utf8')
    ) as Record<string, any>
    expect(migratedStore.version).toBe(3)
    expect(migratedStore.sessions[0].selectedModel).toBe('openai/gpt-5.4-pro')
    expect(migratedStore.sessions[0].transportModel).toBe('openai/gpt-5.4-pro')
  })

  it('records transcript trace entries when returning local cached history', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-trace-transcript')

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-trace-transcript',
      sessionId: 'trace-transcript-session',
      agentId: 'main',
      model: 'zai/glm-5',
      transportSessionId: 'transport-trace-transcript',
      transportModel: 'zai/glm-5',
      kind: 'direct',
      messages: [
        {
          id: 'trace-transcript-msg-1',
          role: 'assistant',
          text: '本地历史',
          createdAt: 9_000,
          status: 'sent',
        },
      ],
      updatedAt: 9_000,
    })

    await getChatTranscript('trace-transcript-session', {
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({ sessions: [] }),
        stderr: '',
        code: 0,
      }),
    })

    expect(listChatTraceEntries(1)).toEqual([
      expect.objectContaining({
        operation: 'transcript',
        stage: 'return-local-cache',
        sessionId: 'trace-transcript-session',
        historySource: 'local-cache',
      }),
    ])
  })

  it('records send trace entries for a successful local send flow', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-trace-send')
    const transportRun = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        response: {
          text: '发送完成',
        },
        model: 'openai/gpt-5.4-pro',
      }),
      stderr: '',
      code: 0,
      streamedText: '发送完成',
      streamedModel: 'openai/gpt-5.4-pro',
    }))

    const result = await sendChatMessage(
      {
        sessionId: 'trace-send-session',
        text: '继续对话',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('openai/gpt-5.4-pro'),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
        chatTransport: {
          run: transportRun as any,
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(listChatTraceEntries(2)).toEqual([
      expect.objectContaining({
        operation: 'send',
        stage: 'succeeded',
        sessionId: 'trace-send-session',
      }),
      expect.objectContaining({
        operation: 'send',
        stage: 'start',
        sessionId: 'trace-send-session',
      }),
    ])
  })

  it('repairs missing main auth profiles from other agent stores before sending', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-repair-main-auth-before-send')
    const repairMainAuthProfiles = vi.fn(async () => ({
      ok: true,
      repaired: true,
      authStorePath: '/Users/test/.openclaw/agents/main/agent/auth-profiles.json',
      importedProfileIds: ['zai:default'],
      importedProviders: ['zai'],
      sourceAuthStorePaths: ['/Users/test/.openclaw/agents/feishu-default/agent/auth-profiles.json'],
    }))
    const transportRun = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        response: {
          text: '修复后可发送',
        },
        model: 'zai/glm-5-turbo',
      }),
      stderr: '',
      code: 0,
      streamedText: '修复后可发送',
      streamedModel: 'zai/glm-5-turbo',
    }))

    const result = await sendChatMessage(
      {
        sessionId: 'repair-main-auth-session',
        text: '继续发送',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () =>
          ({
            ok: true,
            action: 'status',
            command: ['models', 'status', '--json'],
            stdout: '',
            stderr: '',
            code: 0,
            data: {
              defaultModel: 'zai/glm-5-turbo',
              auth: {
                missingProvidersInUse: ['zai', 'xai'],
              },
            },
          }) as any,
        repairMainAuthProfiles: repairMainAuthProfiles as any,
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
        chatTransport: {
          run: transportRun as any,
        },
      }
    )

    expect(repairMainAuthProfiles).toHaveBeenCalledWith(['zai', 'xai'])
    expect(result.ok).toBe(true)
  })

  it('repairs minimax auth into the session owning agent before sending', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-repair-owning-agent-auth-before-send')
    const repairAgentAuthProfiles = vi.fn(async () => ({
      ok: true,
      repaired: true,
      updatedAuthStorePaths: ['/Users/test/.openclaw/agents/channel-bot/agent/auth-profiles.json'],
      importedProfileIds: ['minimax-portal:default'],
      importedProviders: ['minimax-portal'],
      sourceAuthStorePaths: ['/Users/test/.openclaw/agents/channel-default/agent/auth-profiles.json'],
    }))
    const repairMainAuthProfiles = vi.fn(async () => ({
      ok: true,
      repaired: false,
      importedProfileIds: [],
      importedProviders: [],
      sourceAuthStorePaths: [],
    }))
    const transportRun = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        response: {
          text: '修复后可继续发送',
        },
        model: 'minimax-portal/MiniMax-M2.5',
      }),
      stderr: '',
      code: 0,
      streamedText: '修复后可继续发送',
      streamedModel: 'minimax-portal/MiniMax-M2.5',
    }))

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-repair-owning-agent-auth-before-send',
      sessionId: 'channel-owned-session',
      agentId: 'channel-bot',
      model: 'minimax/MiniMax-M2.5',
      transportSessionId: 'transport-channel-owned-session',
      messages: [
        {
          id: 'msg-existing',
          role: 'user',
          text: '旧消息',
          createdAt: 1_000,
          status: 'sent',
        },
      ],
      updatedAt: 1_000,
    })

    const result = await sendChatMessage(
      {
        sessionId: 'channel-owned-session',
        text: '继续当前会话',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () =>
          ({
            ok: true,
            action: 'status',
            command: ['models', 'status', '--json'],
            stdout: '',
            stderr: '',
            code: 0,
            data: {
              defaultModel: 'minimax/MiniMax-M2.5',
              allowed: ['minimax-portal/MiniMax-M2.5'],
              auth: {
                missingProvidersInUse: ['minimax'],
                oauth: {
                  providers: [{ provider: 'minimax-portal', status: 'ok' }],
                },
              },
            },
          }) as any,
        repairAgentAuthProfiles: repairAgentAuthProfiles as any,
        repairMainAuthProfiles: repairMainAuthProfiles as any,
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
        chatTransport: {
          run: transportRun as any,
        },
      }
    )

    expect(repairAgentAuthProfiles).toHaveBeenCalledWith({
      providerIds: ['minimax', 'minimax-portal'],
      agentId: 'channel-bot',
    })
    expect(repairMainAuthProfiles).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  it('uses the target minimax model provider as an auth repair fallback before sending', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-repair-target-model-auth-before-send')
    const repairAgentAuthProfiles = vi.fn(async () => ({
      ok: true,
      repaired: true,
      updatedAuthStorePaths: ['/Users/test/.openclaw/agents/channel-bot/agent/auth-profiles.json'],
      importedProfileIds: ['minimax-portal:default'],
      importedProviders: ['minimax-portal'],
      sourceAuthStorePaths: ['/Users/test/.openclaw/agents/channel-default/agent/auth-profiles.json'],
    }))
    const repairMainAuthProfiles = vi.fn(async () => ({
      ok: true,
      repaired: false,
      importedProfileIds: [],
      importedProviders: [],
      sourceAuthStorePaths: [],
    }))
    const transportRun = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        response: {
          text: '目标模型兜底修复后可继续发送',
        },
        model: 'minimax-portal/MiniMax-M2.5',
      }),
      stderr: '',
      code: 0,
      streamedText: '目标模型兜底修复后可继续发送',
      streamedModel: 'minimax-portal/MiniMax-M2.5',
    }))

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-repair-target-model-auth-before-send',
      sessionId: 'target-model-owned-session',
      agentId: 'channel-bot',
      model: 'minimax-portal/MiniMax-M2.5',
      transportSessionId: 'transport-target-model-owned-session',
      messages: [
        {
          id: 'msg-existing-target-provider',
          role: 'user',
          text: '旧消息',
          createdAt: 1_000,
          status: 'sent',
        },
      ],
      updatedAt: 1_000,
    })

    const result = await sendChatMessage(
      {
        sessionId: 'target-model-owned-session',
        text: '继续当前会话',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () =>
          ({
            ok: true,
            action: 'status',
            command: ['models', 'status', '--json'],
            stdout: '',
            stderr: '',
            code: 0,
            data: {
              defaultModel: 'minimax-portal/MiniMax-M2.5',
              allowed: ['minimax-portal/MiniMax-M2.5'],
              auth: {
                oauth: {
                  providers: [{ provider: 'minimax-portal', status: 'ok' }],
                },
              },
            },
          }) as any,
        repairAgentAuthProfiles: repairAgentAuthProfiles as any,
        repairMainAuthProfiles: repairMainAuthProfiles as any,
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
        chatTransport: {
          run: transportRun as any,
        },
      }
    )

    expect(repairAgentAuthProfiles).toHaveBeenCalledWith({
      providerIds: ['minimax', 'minimax-portal'],
      agentId: 'channel-bot',
    })
    expect(repairMainAuthProfiles).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  it('keeps non-minimax auth repair on the main store and does not switch to agent repair', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-repair-openai-provider-only-before-send')
    const repairAgentAuthProfiles = vi.fn(async () => ({
      ok: true,
      repaired: false,
      updatedAuthStorePaths: [],
      importedProfileIds: [],
      importedProviders: [],
      sourceAuthStorePaths: [],
    }))
    const repairMainAuthProfiles = vi.fn(async () => ({
      ok: true,
      repaired: false,
      importedProfileIds: [],
      importedProviders: [],
      sourceAuthStorePaths: [],
    }))
    const transportRun = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        response: {
          text: '正常发送',
        },
        model: 'openai/gpt-5.4',
      }),
      stderr: '',
      code: 0,
      streamedText: '正常发送',
      streamedModel: 'openai/gpt-5.4',
    }))

    const result = await sendChatMessage(
      {
        sessionId: 'repair-openai-provider-only-session',
        text: '继续当前会话',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () =>
          ({
            ok: true,
            action: 'status',
            command: ['models', 'status', '--json'],
            stdout: '',
            stderr: '',
            code: 0,
            data: {
              defaultModel: 'openai/gpt-5.4',
              allowed: ['openai/gpt-5.4'],
              auth: {
                missingProvidersInUse: ['openai'],
                providers: [{ provider: 'openai-codex', status: 'ok' }],
              },
            },
          }) as any,
        repairAgentAuthProfiles: repairAgentAuthProfiles as any,
        repairMainAuthProfiles: repairMainAuthProfiles as any,
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
        chatTransport: {
          run: transportRun as any,
        },
      }
    )

    expect(repairAgentAuthProfiles).not.toHaveBeenCalled()
    expect(repairMainAuthProfiles).toHaveBeenCalledWith(['openai'])
    expect(result.ok).toBe(true)
  })

  it('returns degraded for a transient gateway health failure after a recent healthy snapshot', async () => {
    readEnvFileMock.mockResolvedValue({
      OPENAI_API_KEY: 'sk-openai',
    })
    getModelCatalogMock.mockResolvedValue({
      total: 1,
      items: [
        { key: 'openai/gpt-5.4-pro', provider: 'openai', available: true, name: 'GPT-5.4 Pro' },
      ],
      providers: ['openai'],
      updatedAt: '2026-03-26T00:00:00.000Z',
      source: 'cache',
      stale: false,
    })

    const healthy = await getDashboardChatAvailability({
      now: () => 10_000,
      getGatewayHealth: async () => ({
        running: true,
        raw: '',
      }),
      readModelStatus: async () =>
        ({
          ok: true,
          action: 'status',
          command: ['models', 'status', '--json'],
          stdout: '',
          stderr: '',
          code: 0,
          data: {
            defaultModel: 'openai/gpt-5.4-pro',
            allowed: ['openai/gpt-5.4-pro'],
            auth: {
              providers: [{ provider: 'openai', status: 'ok' }],
            },
          },
        }) as any,
    })

    expect(healthy.state).toBe('ready')

    const degraded = await getDashboardChatAvailability({
      now: () => 12_000,
      getGatewayHealth: async () => ({
        running: false,
        raw: '',
      }),
      readModelStatus: async () =>
        ({
          ok: true,
          action: 'status',
          command: ['models', 'status', '--json'],
          stdout: '',
          stderr: '',
          code: 0,
          data: {
            defaultModel: 'openai/gpt-5.4-pro',
            allowed: ['openai/gpt-5.4-pro'],
            auth: {
              providers: [{ provider: 'openai', status: 'ok' }],
            },
          },
        }) as any,
    })

    expect(degraded.state).toBe('degraded')
    expect(degraded.canSend).toBe(true)
    expect(degraded.reason).toBe('gateway-offline')
    expect(degraded.connectedModels).toEqual(['openai/gpt-5.4-pro'])
  })

  it('prefers upstream control ui model status over cli model status for chat availability', async () => {
    readEnvFileMock.mockResolvedValue({
      MINIMAX_API_KEY: 'mm-local',
    })
    getModelCatalogMock.mockResolvedValue({
      total: 1,
      items: [
        { key: 'minimax-portal/MiniMax-M2.5', provider: 'minimax-portal', available: true, name: 'MiniMax M2.5' },
      ],
      providers: ['minimax-portal'],
      updatedAt: '2026-03-26T00:00:00.000Z',
      source: 'cache',
      stale: false,
    })

    getModelStatusMock.mockResolvedValue({
      ok: true,
      action: 'status',
      command: ['models', 'status', '--json'],
      stdout: '',
      stderr: '',
      code: 0,
      data: {
        defaultModel: 'minimax/MiniMax-M2.1',
        allowed: ['minimax/MiniMax-M2.1'],
        auth: {
          providers: [{ provider: 'minimax', status: 'ok' }],
        },
      },
    })
    getOpenClawUpstreamModelStateMock.mockResolvedValue({
      ok: true,
      source: 'control-ui-app',
      fallbackUsed: false,
      diagnostics: {
        upstreamAvailable: true,
        connected: true,
        hasClient: true,
        hasHelloSnapshot: true,
        hasHealthResult: false,
        hasSessionsState: false,
        hasModelCatalogState: false,
        appKeys: [],
      },
      data: {
        source: 'control-ui-app',
        connected: true,
        hasClient: true,
        appKeys: [],
        modelStatusLike: {
          defaultModel: 'minimax-portal/MiniMax-M2.5',
          allowed: ['minimax-portal/MiniMax-M2.5'],
          auth: {
            oauth: {
              providers: [{ provider: 'minimax-portal', status: 'ok' }],
            },
          },
        },
      },
    })

    const availability = await getDashboardChatAvailability({
      now: () => 100_000,
      getGatewayHealth: async () => ({
        running: true,
        raw: '',
      }),
    })

    expect(availability.state).toBe('ready')
    expect(availability.connectedModels).toEqual(['minimax-portal/MiniMax-M2.5'])
    expect(availability.defaultModel).toBe('minimax-portal/MiniMax-M2.5')
    expect(getModelStatusMock).not.toHaveBeenCalled()
  })

  it('reuses a short-lived cached upstream status for repeated chat availability polls', async () => {
    readEnvFileMock.mockResolvedValue({
      OPENAI_API_KEY: 'sk-openai',
    })
    getModelCatalogMock.mockResolvedValue({
      total: 1,
      items: [
        { key: 'openai/gpt-5.4-pro', provider: 'openai', available: true, name: 'GPT-5.4 Pro' },
      ],
      providers: ['openai'],
      updatedAt: '2026-03-26T00:00:00.000Z',
      source: 'cache',
      stale: false,
    })

    getOpenClawUpstreamModelStateMock.mockResolvedValue({
      ok: true,
      source: 'control-ui-app',
      fallbackUsed: false,
      diagnostics: {
        upstreamAvailable: true,
        connected: true,
        hasClient: true,
        hasHelloSnapshot: true,
        hasHealthResult: false,
        hasSessionsState: false,
        hasModelCatalogState: false,
        appKeys: [],
      },
      data: {
        source: 'control-ui-app',
        connected: true,
        hasClient: true,
        appKeys: [],
        modelStatusLike: {
          defaultModel: 'openai/gpt-5.4-pro',
          allowed: ['openai/gpt-5.4-pro'],
          auth: {
            providers: [{ provider: 'openai', status: 'ok' }],
          },
        },
      },
    })

    const first = await getDashboardChatAvailability({
      now: () => 5_000,
      getGatewayHealth: async () => ({
        running: true,
        raw: '',
      }),
    })
    const second = await getDashboardChatAvailability({
      now: () => 6_000,
      getGatewayHealth: async () => ({
        running: true,
        raw: '',
      }),
    })

    expect(first.state).toBe('ready')
    expect(second.state).toBe('ready')
    expect(getOpenClawUpstreamModelStateMock).toHaveBeenCalledTimes(1)
  })

  it('reuses a short-lived cached selectable model catalog for repeated chat availability polls', async () => {
    getOpenClawUpstreamModelStateMock.mockResolvedValue({
      ok: true,
      source: 'control-ui-app',
      fallbackUsed: false,
      diagnostics: {
        upstreamAvailable: true,
        connected: true,
        hasClient: true,
        hasHelloSnapshot: true,
        hasHealthResult: false,
        hasSessionsState: false,
        hasModelCatalogState: false,
        appKeys: [],
      },
      data: {
        source: 'control-ui-app',
        connected: true,
        hasClient: true,
        appKeys: [],
        modelStatusLike: {
          defaultModel: 'openai/gpt-5.4-pro',
          allowed: ['openai/gpt-5.4-pro'],
          auth: {
            providers: [{ provider: 'openai', status: 'ok' }],
          },
        },
      },
    })
    readConfigMock.mockResolvedValue({
      defaultModel: 'openai/gpt-5.4-pro',
      models: {
        openai: {
          enabled: true,
        },
      },
    })
    getModelCatalogMock.mockResolvedValue({
      total: 1,
      items: [
        { key: 'openai/gpt-5.4-pro', provider: 'openai', available: true, name: 'GPT-5.4 Pro' },
      ],
      providers: ['openai'],
      updatedAt: '2026-03-26T00:00:00.000Z',
      source: 'cache',
      stale: false,
    })

    const first = await getDashboardChatAvailability({
      now: () => 5_000,
      getGatewayHealth: async () => ({
        running: true,
        raw: '',
      }),
    })
    const second = await getDashboardChatAvailability({
      now: () => 6_000,
      getGatewayHealth: async () => ({
        running: true,
        raw: '',
      }),
    })

    expect(first.state).toBe('ready')
    expect(second.state).toBe('ready')
    expect(getModelCatalogMock).toHaveBeenCalledTimes(1)
    expect(readConfigMock).toHaveBeenCalledTimes(2)
    expect(readEnvFileMock).toHaveBeenCalledTimes(2)
  })

  it('refreshes selectable models immediately when the current model status changes within the cache ttl', async () => {
    const readModelStatus = vi
      .fn<() => Promise<any>>()
      .mockResolvedValueOnce({
        ok: true,
        action: 'status',
        command: ['models', 'status', '--json'],
        stdout: '',
        stderr: '',
        code: 0,
        data: {
          defaultModel: 'openai/gpt-5.4-pro',
          allowed: ['openai/gpt-5.4-pro'],
          auth: {
            providers: [{ provider: 'openai', status: 'ok' }],
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        action: 'status',
        command: ['models', 'status', '--json'],
        stdout: '',
        stderr: '',
        code: 0,
        data: {
          defaultModel: 'zai/glm-5',
          allowed: ['zai/glm-5'],
          auth: {
            providers: [{ provider: 'zai', status: 'ok' }],
          },
        },
      })

    let catalogCallCount = 0
    getModelCatalogMock.mockImplementation(async () => {
      catalogCallCount += 1
      if (catalogCallCount === 1) {
        return {
          total: 1,
          items: [
            { key: 'openai/gpt-5.4-pro', provider: 'openai', available: true, name: 'GPT-5.4 Pro' },
          ],
          providers: ['openai'],
          updatedAt: '2026-03-26T00:00:00.000Z',
          source: 'cache',
          stale: false,
        }
      }

      return {
        total: 1,
        items: [{ key: 'zai/glm-5', provider: 'zai', available: true, name: 'GLM-5' }],
        providers: ['zai'],
        updatedAt: '2026-03-26T00:00:05.000Z',
        source: 'cache',
        stale: false,
      }
    })
    readConfigMock
      .mockResolvedValueOnce({
        defaultModel: 'openai/gpt-5.4-pro',
        models: {
          openai: {
            enabled: true,
          },
        },
      })
      .mockResolvedValueOnce({
        defaultModel: 'zai/glm-5',
        models: {
          zai: {
            enabled: true,
          },
        },
      })

    const first = await getDashboardChatAvailability({
      now: () => 5_000,
      readModelStatus,
      getGatewayHealth: async () => ({
        running: true,
        raw: '',
      }),
    })
    const second = await getDashboardChatAvailability({
      now: () => 6_000,
      readModelStatus,
      getGatewayHealth: async () => ({
        running: true,
        raw: '',
      }),
    })

    expect(first.connectedModels).toEqual(['openai/gpt-5.4-pro'])
    expect(second.connectedModels).toEqual(['zai/glm-5'])
    expect(getModelCatalogMock).toHaveBeenCalledTimes(2)
    expect(readConfigMock).toHaveBeenCalledTimes(2)
    expect(readEnvFileMock).toHaveBeenCalledTimes(2)
  })

  it('returns offline after repeated gateway health failures exceed the threshold', async () => {
    readEnvFileMock.mockResolvedValue({
      OPENAI_API_KEY: 'sk-openai',
    })
    getModelCatalogMock.mockResolvedValue({
      total: 1,
      items: [
        { key: 'openai/gpt-5.4-pro', provider: 'openai', available: true, name: 'GPT-5.4 Pro' },
      ],
      providers: ['openai'],
      updatedAt: '2026-03-26T00:00:00.000Z',
      source: 'cache',
      stale: false,
    })

    const firstFailure = await getDashboardChatAvailability({
      now: () => 40_000,
      getGatewayHealth: async () => ({
        running: false,
        raw: '',
      }),
      readModelStatus: async () =>
        ({
          ok: true,
          action: 'status',
          command: ['models', 'status', '--json'],
          stdout: '',
          stderr: '',
          code: 0,
          data: {
            defaultModel: 'openai/gpt-5.4-pro',
            allowed: ['openai/gpt-5.4-pro'],
            auth: {
              providers: [{ provider: 'openai', status: 'ok' }],
            },
          },
        }) as any,
    })

    expect(firstFailure.state).toBe('degraded')

    const offline = await getDashboardChatAvailability({
      now: () => 60_000,
      getGatewayHealth: async () => ({
        running: false,
        raw: '',
      }),
      readModelStatus: async () =>
        ({
          ok: true,
          action: 'status',
          command: ['models', 'status', '--json'],
          stdout: '',
          stderr: '',
          code: 0,
          data: {
            defaultModel: 'openai/gpt-5.4-pro',
            allowed: ['openai/gpt-5.4-pro'],
            auth: {
              providers: [{ provider: 'openai', status: 'ok' }],
            },
          },
        }) as any,
    })

    expect(offline.state).toBe('offline')
    expect(offline.canSend).toBe(false)
    expect(offline.reason).toBe('gateway-offline')
  })

  it('treats google-gemini-cli auth provider as compatible with google/* model keys', () => {
    const availability = buildDashboardChatAvailabilityFromStatus({
      gatewayRunning: true,
      modelStatus: {
        ok: true,
        action: 'status',
        command: ['models', 'status', '--json'],
        stdout: '',
        stderr: '',
        code: 0,
        data: {
          defaultModel: 'google/gemini-2.5-pro',
          allowed: ['google/gemini-2.5-pro'],
          auth: {
            providers: [
              {
                provider: 'google-gemini-cli',
                status: 'ok',
              },
            ],
          },
        },
      },
    })

    expect(availability.ready).toBe(true)
    expect(availability.connectedModels).toEqual(['google/gemini-2.5-pro'])
  })

  it('treats minimax-portal auth provider as compatible with minimax/* model keys', () => {
    const availability = buildDashboardChatAvailabilityFromStatus({
      gatewayRunning: true,
      modelStatus: {
        ok: true,
        action: 'status',
        command: ['models', 'status', '--json'],
        stdout: '',
        stderr: '',
        code: 0,
        data: {
          defaultModel: 'minimax/minimax-m2',
          allowed: ['minimax/minimax-m2'],
          auth: {
            providers: [
              {
                provider: 'minimax-portal',
                status: 'ok',
              },
            ],
          },
        },
      },
    })

    expect(availability.ready).toBe(true)
    expect(availability.connectedModels).toEqual(['minimax/minimax-m2'])
  })

  it('reconciles a stale minimax default model onto the connected minimax-portal runtime key', () => {
    const availability = buildDashboardChatAvailabilityFromStatus({
      gatewayRunning: true,
      modelStatus: {
        ok: true,
        action: 'status',
        command: ['models', 'status', '--json'],
        stdout: '',
        stderr: '',
        code: 0,
        data: {
          defaultModel: 'minimax/MiniMax-M2.7-highspeed',
          allowed: ['minimax-portal/MiniMax-M2.7-highspeed', 'minimax-portal/MiniMax-M2.5'],
          auth: {
            oauth: {
              providers: [{ provider: 'minimax-portal', status: 'ok' }],
            },
            missingProvidersInUse: ['minimax'],
          },
        },
      },
    })

    expect(availability.ready).toBe(true)
    expect(availability.defaultModel).toBe('minimax-portal/MiniMax-M2.7-highspeed')
    expect(availability.connectedModels).toEqual([
      'minimax-portal/MiniMax-M2.5',
      'minimax-portal/MiniMax-M2.7-highspeed',
    ])
  })

  it('extracts nested assistant text from json output', () => {
    const parsed = parseAgentReplyOutput(
      JSON.stringify({
        result: {
          response: {
            content: '你好，我已经连接好了。',
          },
        },
        model: 'openai/gpt-5.1-codex',
      })
    )

    expect(parsed.text).toBe('你好，我已经连接好了。')
    expect(parsed.model).toBe('openai/gpt-5.1-codex')
  })

  it('preserves explicit json response bodies from assistant text fields', () => {
    const parsed = parseAgentReplyOutput(
      JSON.stringify({
        response: {
          text: '{"command":"npm test","workdir":"/repo"}',
        },
        model: 'openai/gpt-5.1-codex',
      })
    )

    expect(parsed.text).toBe('{"command":"npm test","workdir":"/repo"}')
    expect(parsed.model).toBe('openai/gpt-5.1-codex')
  })

  it('ignores structured tool payloads when parsing assistant json output', () => {
    const parsed = parseAgentReplyOutput(
      JSON.stringify({
        command: 'curl -s "wttr.in/Shenzhen?format=%C"',
        workdir: '/Users/test/.openclaw/workspace',
        yieldMs: 10_000,
        timeout: 20,
      })
    )

    expect(parsed.text).toBeNull()
  })

  it('ignores stringified tool payloads when parsing assistant json output', () => {
    const parsed = parseAgentReplyOutput(
      JSON.stringify('{"path":"~/homebrew/lib/node_modules/openclaw/skills/weather/SKILL.md"}')
    )

    expect(parsed.text).toBeNull()
  })

  it('persists chat transcript after a successful send', async () => {
    const sessionId = 'session-1'
    const emittedEvents: string[] = []
    const discoverOpenClaw = async () =>
      ({
        status: 'installed',
        candidates: [
          {
            candidateId: 'candidate-1',
            binaryPath: '/usr/local/bin/openclaw',
            resolvedBinaryPath: '/usr/local/bin/openclaw',
            packageRoot: '/usr/local/lib/node_modules/openclaw',
            version: '2026.3.12',
            installSource: 'npm-global',
            isPathActive: true,
            configPath: '/Users/test/.openclaw/openclaw.json',
            stateRoot: '/Users/test/.openclaw',
            displayConfigPath: '~/.openclaw/openclaw.json',
            displayStateRoot: '~/.openclaw',
            ownershipState: 'external-preexisting',
            installFingerprint: 'fingerprint-1',
            baselineBackup: null,
            baselineBackupBypass: null,
          },
        ],
        activeCandidateId: 'candidate-1',
        hasMultipleCandidates: false,
        historyDataCandidates: [],
        errors: [],
        warnings: [],
        defaultBackupDirectory: '/tmp',
      }) as any

    const result = await sendChatMessage(
      {
        sessionId,
        text: '你好',
      },
      {
        discoverOpenClaw,
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runStreamingCommand: async (_args, streamOptions) => {
          streamOptions?.onStdout?.(`${JSON.stringify({ type: 'response.delta', delta: '你好，' })}\n`)
          streamOptions?.onStdout?.(
            `${JSON.stringify({ type: 'response.delta', delta: '我在。', model: 'openai/gpt-5.1-codex' })}\n`
          )
          return {
            ok: true,
            stdout: JSON.stringify({
              response: {
                text: '你好，我在。',
              },
              model: 'openai/gpt-5.1-codex',
              usage: {
                promptTokens: 11,
                completionTokens: 10,
                totalTokens: 21,
              },
            }),
            stderr: '',
            code: 0,
          }
        },
        now: () => 1_000,
        emit: (event) => emittedEvents.push(event.type),
      }
    )

    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(result.message?.text).toBe('你好，我在。')
    expect(result.message?.usage?.totalTokens).toBe(21)
    expect(emittedEvents).toEqual(['assistant-start', 'assistant-delta', 'assistant-delta', 'assistant-complete'])

    const transcript = await getChatTranscript(sessionId, {
      discoverOpenClaw,
    })

    expect(transcript.hasLocalTranscript).toBe(true)
    expect(transcript.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(transcript.messages[0].text).toBe('你好')
    expect(transcript.messages[1].text).toBe('你好，我在。')
    expect(transcript.messages[1].usage?.totalTokens).toBe(21)
  })

  it('does not create a local empty session when gateway ensure fails before send starts', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-gateway-offline-no-session')

    const result = await sendChatMessage(
      {
        sessionId: 'offline-before-send',
        text: '这条消息不应创建空会话',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('openai/gpt-5.1-codex'),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
        ensureGateway: async () => ({
          ok: false,
          stdout: '',
          stderr: 'gateway offline',
          code: 1,
          running: false,
        }),
      }
    )

    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('gateway-offline')

    const sessions = await listChatSessions({
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({ sessions: [] }),
        stderr: '',
        code: 0,
      }),
    })

    expect(sessions).toEqual([])
  })

  it('falls back to CLI send for a local shell when gateway ensure fails', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-local-shell-cli-fallback')
    const localSession = await createLocalChatSession({
      discoverOpenClaw,
      now: () => 12_345,
    })

    const result = await sendChatMessage(
      {
        sessionId: localSession.sessionId,
        text: '本地壳也应该能发出去',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('openai/gpt-5.1-codex'),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
        ensureGateway: async () => ({
          ok: false,
          stdout: '',
          stderr: 'gateway offline',
          code: 1,
          running: false,
        }),
        runStreamingCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({
            response: {
              text: 'CLI fallback 成功了',
            },
            model: 'openai/gpt-5.1-codex',
          }),
          stderr: '',
          code: 0,
        }),
      }
    )

    expect(result.ok).toBe(true)
    expect(result.sessionId).toBe(localSession.sessionId)

    const transcript = await getChatTranscript(localSession.sessionId, {
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({ sessions: [] }),
        stderr: '',
        code: 0,
      }),
    })

    expect(transcript.hasLocalTranscript).toBe(true)
    expect(transcript.messages.map((message) => message.text)).toEqual([
      '本地壳也应该能发出去',
      'CLI fallback 成功了',
    ])
  })

  it('forks a legacy local session even when its model matches the latest default model', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-preflight-reuse')
    const capturedCommands: string[][] = []

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-preflight-reuse',
      sessionId: 'matching-local',
      agentId: 'main',
      model: 'openai/gpt-5.1-codex',
      messages: [
        {
          id: 'msg-existing',
          role: 'user',
          text: '之前的本地消息',
          createdAt: 900,
          status: 'sent',
        },
      ],
      updatedAt: 900,
    })

    const result = await sendChatMessage(
      {
        sessionId: 'matching-local',
        text: '继续当前会话',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('openai/gpt-5.1-codex'),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runStreamingCommand: async (args) => {
          capturedCommands.push(args)
          return {
            ok: true,
            stdout: JSON.stringify({
              response: {
                text: '继续成功',
              },
              model: 'openai/gpt-5.1-codex',
            }),
            stderr: '',
            code: 0,
          }
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(result.sessionId).not.toBe('matching-local')
    expect(capturedCommands[0][0]).toBe('agent')
    expect(capturedCommands[0][1]).toBe('--json')
    expect(capturedCommands[0][2]).toBe('--session-id')
    expect(capturedCommands[0][3]).not.toBe('matching-local')
    expect(capturedCommands[0][4]).toBe('--message')
    expect(capturedCommands[0][5]).toContain('以下是当前对话最近的上下文')
    expect(capturedCommands[0][5]).toContain('之前的本地消息')
    expect(capturedCommands[0][5]).toContain('继续当前会话')
    expect(capturedCommands[0].slice(6)).toEqual([
      '--thinking',
      'off',
    ])
  })

  it('does not patch the current conversation during send when a stale selected model is present', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-preflight-patch-before-send')
    const capturedCommands: string[][] = []
    const capturedPatchPayloads: Array<{ key: string; model: string }> = []

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-preflight-patch-before-send',
      sessionId: 'stale-local',
      agentId: 'main',
      model: 'custom-open-bigmodel-cn/glm-5',
      selectedModel: 'custom-open-bigmodel-cn/glm-5',
      transportSessionId: 'transport-stale-local',
      transportModel: 'custom-open-bigmodel-cn/glm-5',
      messages: [
        {
          id: 'msg-existing',
          role: 'user',
          text: '旧模型消息',
          createdAt: 1_000,
          status: 'sent',
        },
      ],
      updatedAt: 1_000,
    })

    const result = await sendChatMessage(
      {
        sessionId: 'stale-local',
        text: '切换模型后的新消息',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('minimax/MiniMax-M2.5-highspeed'),
        runCommand: async (args) => {
          if (args[0] === 'sessions') {
            return {
              ok: true,
              stdout: JSON.stringify({ sessions: [] }),
              stderr: '',
              code: 0,
            }
          }

          if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.patch') {
            capturedPatchPayloads.push(JSON.parse(String(args[5])))
            return {
              ok: true,
              stdout: JSON.stringify({ ok: true }),
              stderr: '',
              code: 0,
            }
          }

          return {
            ok: false,
            stdout: '',
            stderr: 'unexpected command',
            code: 1,
          }
        },
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        loadCapabilities: async () =>
          createCapabilities({
            chatAgentModelFlag: true,
            chatGatewaySendModel: false,
            chatInThreadModelSwitch: true,
          }),
        callGatewayRpc: async (method, params) => {
          expect(method).toBe('sessions.patch')
          capturedPatchPayloads.push(params as { key: string; model: string })
          return { ok: true }
        },
        runStreamingCommand: async (args) => {
          capturedCommands.push(args)
          return {
            ok: true,
            stdout: JSON.stringify({
              response: {
                text: '新会话已创建',
              },
              model: 'custom-open-bigmodel-cn/glm-5',
            }),
            stderr: '',
            code: 0,
          }
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(result.sessionId).not.toBe('stale-local')
    expect(capturedPatchPayloads).toEqual([])
    expect(capturedCommands[0][0]).toBe('agent')
    expect(capturedCommands[0][3]).not.toBe('transport-stale-local')
    expect(capturedCommands[0][5]).toContain('旧模型消息')
    expect(capturedCommands[0][5]).toContain('切换模型后的新消息')
  })

  it('reconciles stale selectedModel back to the confirmed session model when send fails', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-send-failure-selection-reconcile')

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-send-failure-selection-reconcile',
      sessionId: 'failed-send-session',
      agentId: 'main',
      model: 'zai/glm-5',
      selectedModel: 'openai/gpt-5.4-pro',
      transportSessionId: 'transport-failed-send',
      transportModel: 'zai/glm-5',
      messages: [
        {
          id: 'msg-existing',
          role: 'user',
          text: '旧会话消息',
          createdAt: 1_000,
          status: 'sent',
        },
      ],
      updatedAt: 1_000,
    })

    const result = await sendChatMessage(
      {
        sessionId: 'failed-send-session',
        text: '这次发送会失败',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('minimax/MiniMax-M2.5-highspeed'),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        chatTransport: {
          run: async () => ({
            ok: false,
            stdout: '',
            stderr: 'transport failed',
            code: 1,
            streamedText: '',
          }),
        },
      }
    )

    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('command-failed')

    const transcript = await getChatTranscript('failed-send-session', {
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({ sessions: [] }),
        stderr: '',
        code: 0,
      }),
    })

    expect(transcript.model).toBe('zai/glm-5')
    expect(transcript.selectedModel).toBe('zai/glm-5')

    const sessions = await listChatSessions({
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({ sessions: [] }),
        stderr: '',
        code: 0,
      }),
    })

    expect(sessions.find((session) => session.sessionId === 'failed-send-session')?.selectedModel).toBe('zai/glm-5')
  })

  it('does not turn send-time model intent into a hidden session patch fallback', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-preflight-model-supported-via-gateway')
    const capturedPatchPayloads: Array<Record<string, unknown>> = []

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-preflight-model-supported-via-gateway',
      sessionId: 'supported-local',
      agentId: 'main',
      model: 'custom-open-bigmodel-cn/glm-5',
      transportSessionId: 'transport-supported-local',
      messages: [
        {
          id: 'msg-existing',
          role: 'user',
          text: '旧模型消息',
          createdAt: 1_000,
          status: 'sent',
        },
      ],
      updatedAt: 1_000,
    })

    const result = await sendChatMessage(
      {
        sessionId: 'supported-local',
        text: '尝试切到新模型',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('minimax/MiniMax-M2.5-highspeed'),
        runCommand: async (args) => {
          if (args[0] === 'sessions') {
            return {
              ok: true,
              stdout: JSON.stringify({ sessions: [] }),
              stderr: '',
              code: 0,
            }
          }
          if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.patch') {
            capturedPatchPayloads.push(JSON.parse(String(args[5] || '{}')))
            return {
              ok: true,
              stdout: JSON.stringify({
                ok: true,
                resolved: {
                  modelProvider: 'openai',
                  model: 'gpt-5.4-pro',
                },
              }),
              stderr: '',
              code: 0,
            }
          }
          return {
            ok: false,
            stdout: '',
            stderr: 'unexpected command',
            code: 1,
          }
        },
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        loadCapabilities: async () =>
          createCapabilities({
            chatAgentModelFlag: false,
            chatGatewaySendModel: true,
            chatInThreadModelSwitch: false,
          }),
        callGatewayRpc: async (method, params) => {
          expect(method).toBe('sessions.patch')
          capturedPatchPayloads.push(params as { key: string; model: string })
          return {
            ok: true,
            resolved: {
              modelProvider: 'openai',
              model: 'gpt-5.4-pro',
            },
          }
        },
        chatTransport: {
          run: async () => ({
            ok: true,
            stdout: JSON.stringify({
              response: {
                text: '网关 patch 后继续会话',
              },
              model: 'openai/gpt-5.4-pro',
            }),
            stderr: '',
            code: 0,
            streamedText: '网关 patch 后继续会话',
          }),
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(capturedPatchPayloads).toEqual([])
  })

  it('rejects runtime send-time model overrides before any session or gateway work starts', async () => {
    const ensureGateway = vi.fn(async () => ({
      ok: true,
      stdout: '',
      stderr: '',
      code: 0,
      running: true,
    }))
    const runCommand = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({ sessions: [] }),
      stderr: '',
      code: 0,
    }))
    const chatTransport = {
      run: vi.fn(),
    }

    const result = await sendChatMessage(
      {
        sessionId: 'runtime-override-session',
        text: '不要在发送时改模型',
        model: 'openai/gpt-4.1-mini',
      } as any,
      {
        ensureGateway,
        runCommand,
        chatTransport,
      }
    )

    expect(result).toEqual({
      ok: false,
      sessionId: 'runtime-override-session',
      errorCode: 'invalid-input',
      messageText: '聊天发送请求：禁止在发送消息时携带 model；请先通过 patchChatSessionModel()/sessions.patch 切换当前会话模型',
    })
    expect(runCommand).not.toHaveBeenCalled()
    expect(ensureGateway).not.toHaveBeenCalled()
    expect(chatTransport.run).not.toHaveBeenCalled()
  })

  it('sends the first message without a transport-level model override', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-preflight-bootstrap-model')
    const capturedCommands: string[][] = []

    const result = await sendChatMessage(
      {
        sessionId: 'bootstrap-session',
        text: '第一条消息就指定模型',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('minimax/MiniMax-M2.5-highspeed'),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        loadCapabilities: async () =>
          createCapabilities({
            chatAgentModelFlag: true,
            chatGatewaySendModel: false,
            chatInThreadModelSwitch: true,
          }),
        runStreamingCommand: async (args) => {
          capturedCommands.push(args)
          return {
            ok: true,
            stdout: JSON.stringify({
              response: {
                text: '启动兼容成功',
              },
              model: 'openai/gpt-5.4-pro',
            }),
            stderr: '',
            code: 0,
          }
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(capturedCommands[0]).not.toContain('--model')
  })

  it('does not pass a model override through gateway chat.send for the first message', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-preflight-bootstrap-gateway-model')
    const transportRun = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        response: {
          text: '网关模型切换成功',
        },
        model: 'openai/gpt-5.4-pro',
      }),
      stderr: '',
      code: 0,
      streamedText: '网关模型切换成功',
    }))

    const result = await sendChatMessage(
      {
        sessionId: 'bootstrap-gateway-session',
        text: '第一条消息就指定模型',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('minimax/MiniMax-M2.5-highspeed'),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        loadCapabilities: async () =>
          createCapabilities({
            chatAgentModelFlag: false,
            chatGatewaySendModel: true,
            chatInThreadModelSwitch: true,
          }),
        chatTransport: {
          run: transportRun,
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(transportRun).toHaveBeenCalledTimes(1)
    const firstRunArgs = (transportRun.mock.calls as any[])[0]?.[0] as Record<string, unknown> | undefined
    expect(firstRunArgs).not.toHaveProperty('model')
  })

  it('materializes a pinned upstream session before the first send when the runtime default model is stale', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-preflight-bootstrap-stale-minimax-default')
    const localSession = await createLocalChatSession({
      discoverOpenClaw,
      now: () => 12_345,
    })
    const callGatewayRpc = vi.fn(async (method: string, params: unknown) => {
      expect(method).toBe('sessions.create')
      expect(params).toEqual({
        agentId: 'main',
        model: 'minimax-portal/MiniMax-M2.7-highspeed',
      })
      return {
        key: 'agent:main:created-bootstrap-minimax',
        sessionId: 'created-bootstrap-minimax',
        entry: {
          key: 'agent:main:created-bootstrap-minimax',
          sessionId: 'created-bootstrap-minimax',
          agentId: 'main',
          model: 'minimax-portal/MiniMax-M2.7-highspeed',
        },
      }
    })
    const transportRun = vi.fn(async (params: Record<string, unknown>) => {
      expect(params.sessionKey).toBe('agent:main:created-bootstrap-minimax')
      return {
        ok: true,
        stdout: JSON.stringify({
          response: {
            text: 'MiniMax 首条消息恢复成功',
          },
          model: 'minimax-portal/MiniMax-M2.7-highspeed',
        }),
        stderr: '',
        code: 0,
        streamedText: 'MiniMax 首条消息恢复成功',
        streamedModel: 'minimax-portal/MiniMax-M2.7-highspeed',
      }
    })

    const result = await sendChatMessage(
      {
        sessionId: localSession.sessionId,
        text: '你好',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () =>
          ({
            ok: true,
            action: 'status',
            command: ['models', 'status', '--json'],
            stdout: '',
            stderr: '',
            code: 0,
            data: {
              defaultModel: 'minimax/MiniMax-M2.7-highspeed',
              allowed: ['minimax-portal/MiniMax-M2.7-highspeed', 'minimax-portal/MiniMax-M2.5'],
              auth: {
                oauth: {
                  providers: [{ provider: 'minimax-portal', status: 'ok' }],
                },
                missingProvidersInUse: ['minimax'],
              },
            },
          }) as any,
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        callGatewayRpc,
        chatTransport: {
          run: transportRun as any,
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(callGatewayRpc).toHaveBeenCalledTimes(1)

    const transcript = await getChatTranscript(localSession.sessionId, {
      discoverOpenClaw,
      runCommand: async () => ({
        ok: false,
        stdout: '',
        stderr: 'history unavailable',
        code: 1,
      }),
    })

    expect(transcript.sessionKey).toBe('agent:main:created-bootstrap-minimax')
    expect(transcript.model).toBe('minimax-portal/MiniMax-M2.7-highspeed')
    expect(transcript.messages.map((message) => message.text)).toEqual(['你好', 'MiniMax 首条消息恢复成功'])

    const sessions = await listChatSessions({
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({
          sessions: [
            {
              sessionId: 'upstream-runtime-row',
              key: 'agent:main:created-bootstrap-minimax',
              agentId: 'main',
              model: 'minimax-portal/MiniMax-M2.7-highspeed',
              updatedAt: 20_000,
              kind: 'direct',
            },
          ],
        }),
        stderr: '',
        code: 0,
      }),
    })

    expect(sessions).toHaveLength(1)
    expect(sessions[0].sessionId).toBe(localSession.sessionId)
    expect(sessions[0].sessionKey).toBe('agent:main:created-bootstrap-minimax')
    expect(sessions[0].model).toBe('minimax-portal/MiniMax-M2.7-highspeed')
  })

  it('materializes a trusted upstream session before the first send for a local shell even when the default model is already aligned', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-preflight-bootstrap-aligned-local-shell')
    const localSession = await createLocalChatSession({
      discoverOpenClaw,
      now: () => 12_345,
      readModelStatus: async () => createModelStatus('minimax-portal/MiniMax-M2.7'),
    })
    const callGatewayRpc = vi.fn(async (method: string, params: unknown) => {
      expect(method).toBe('sessions.create')
      expect(params).toEqual({
        agentId: 'main',
        model: 'minimax-portal/MiniMax-M2.7',
      })
      return {
        key: 'agent:main:created-bootstrap-aligned',
        sessionId: 'created-bootstrap-aligned',
        entry: {
          key: 'agent:main:created-bootstrap-aligned',
          sessionId: 'created-bootstrap-aligned',
          agentId: 'main',
          model: 'minimax-portal/MiniMax-M2.7',
        },
      }
    })
    const transportRun = vi.fn(async (params: Record<string, unknown>) => {
      expect(params.sessionKey).toBe('agent:main:created-bootstrap-aligned')
      return {
        ok: true,
        stdout: JSON.stringify({
          response: {
            text: '本地壳会话已升格为确认会话',
          },
          model: 'minimax-portal/MiniMax-M2.7',
        }),
        stderr: '',
        code: 0,
        streamedText: '本地壳会话已升格为确认会话',
        streamedModel: 'minimax-portal/MiniMax-M2.7',
      }
    })

    const result = await sendChatMessage(
      {
        sessionId: localSession.sessionId,
        text: 'nihao',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('minimax-portal/MiniMax-M2.7'),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        callGatewayRpc,
        chatTransport: {
          run: transportRun as any,
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(callGatewayRpc).toHaveBeenCalledTimes(1)

    const sessions = await listChatSessions({
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({ sessions: [] }),
        stderr: '',
        code: 0,
      }),
    })

    expect(sessions).toHaveLength(1)
    expect(sessions[0].sessionId).toBe(localSession.sessionId)
    expect(sessions[0].sessionKey).toBe('agent:main:created-bootstrap-aligned')
    expect(sessions[0].canPatchModel).toBe(true)
    expect(sessions[0].canContinue).toBe(true)
    expect(sessions[0].modelSwitchBlockedReason).toBeUndefined()
  })

  it('patches a trusted legacy minimax session to minimax-portal before send', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-pre-send-repair-legacy-minimax-session')
    const callOrder: string[] = []
    let upstreamSession = {
      sessionId: 'history-minimax-session',
      key: 'agent:channel-default:main',
      agentId: 'channel-default',
      model: 'minimax/MiniMax-M2.5',
      updatedAt: 10_000,
      kind: 'direct',
    }
    const callGatewayRpc = vi.fn(async (method: string, params: unknown, timeoutMs?: number) => {
      callOrder.push(`rpc:${method}`)
      expect(method).toBe('sessions.patch')
      expect(params).toEqual({
        key: 'agent:channel-default:main',
        model: 'minimax-portal/MiniMax-M2.5',
      })
      expect(timeoutMs).toBe(20_000)
      upstreamSession = {
        ...upstreamSession,
        model: 'minimax-portal/MiniMax-M2.5',
        updatedAt: 11_000,
      }
      return { ok: true }
    })
    const transportRun = vi.fn(async (params: Record<string, unknown>) => {
      callOrder.push('transport-run')
      expect(params.sessionKey).toBe('agent:channel-default:main')
      return {
        ok: true,
        stdout: JSON.stringify({
          response: {
            text: '历史会话恢复成功',
          },
          model: 'minimax-portal/MiniMax-M2.5',
        }),
        stderr: '',
        code: 0,
        streamedText: '历史会话恢复成功',
        streamedModel: 'minimax-portal/MiniMax-M2.5',
      }
    })

    const result = await sendChatMessage(
      {
        sessionId: 'history-minimax-session',
        text: '继续历史会话',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () =>
          ({
            ok: true,
            action: 'status',
            command: ['models', 'status', '--json'],
            stdout: '',
            stderr: '',
            code: 0,
            data: {
              defaultModel: 'minimax/MiniMax-M2.5',
              allowed: ['minimax-portal/MiniMax-M2.5', 'minimax-portal/MiniMax-M2.7'],
              auth: {
                oauth: {
                  providers: [{ provider: 'minimax-portal', status: 'ok' }],
                },
                missingProvidersInUse: ['minimax'],
              },
            },
          }) as any,
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        callGatewayRpc,
        runCommand: async (args: string[]) => {
          if (args[0] === 'sessions') {
            return {
              ok: true,
              stdout: JSON.stringify({
                sessions: [upstreamSession],
              }),
              stderr: '',
              code: 0,
            }
          }
          return {
            ok: false,
            stdout: '',
            stderr: 'unexpected command',
            code: 1,
          }
        },
        chatTransport: {
          run: transportRun as any,
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(callOrder).toEqual(['rpc:sessions.patch', 'transport-run'])

    const transcript = await getChatTranscript('history-minimax-session', {
      discoverOpenClaw,
      runCommand: async (args: string[]) => {
        if (args[0] === 'sessions') {
          return {
            ok: true,
            stdout: JSON.stringify({
              sessions: [upstreamSession],
            }),
            stderr: '',
            code: 0,
          }
        }

        return {
          ok: false,
          stdout: '',
          stderr: 'history unavailable',
          code: 1,
        }
      },
    })

    expect(transcript.model).toBe('minimax-portal/MiniMax-M2.5')
    expect(transcript.messages.map((message) => message.text)).toEqual(['继续历史会话', '历史会话恢复成功'])

    const sessions = await listChatSessions({
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({
          sessions: [upstreamSession],
        }),
        stderr: '',
        code: 0,
      }),
    })

    expect(sessions[0].model).toBe('minimax-portal/MiniMax-M2.5')
  })

  it('patches a trusted legacy minimax session even when allowed keeps both legacy and portal keys', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-pre-send-repair-legacy-and-portal-allowed')
    const callOrder: string[] = []
    let upstreamSession = {
      sessionId: 'history-minimax-session-both-allowed',
      key: 'agent:channel-default:main',
      agentId: 'channel-default',
      model: 'minimax/MiniMax-M2.5',
      updatedAt: 10_000,
      kind: 'direct',
    }
    const callGatewayRpc = vi.fn(async (method: string, params: unknown) => {
      callOrder.push(`rpc:${method}`)
      expect(method).toBe('sessions.patch')
      expect(params).toEqual({
        key: 'agent:channel-default:main',
        model: 'minimax-portal/MiniMax-M2.5',
      })
      upstreamSession = {
        ...upstreamSession,
        model: 'minimax-portal/MiniMax-M2.5',
        updatedAt: 11_000,
      }
      return { ok: true }
    })
    const transportRun = vi.fn(async () => {
      callOrder.push('transport-run')
      return {
        ok: true,
        stdout: JSON.stringify({
          response: {
            text: '双 key 状态下也恢复成功',
          },
          model: 'minimax-portal/MiniMax-M2.5',
        }),
        stderr: '',
        code: 0,
        streamedText: '双 key 状态下也恢复成功',
        streamedModel: 'minimax-portal/MiniMax-M2.5',
      }
    })

    const result = await sendChatMessage(
      {
        sessionId: 'history-minimax-session-both-allowed',
        text: '继续历史会话',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () =>
          ({
            ok: true,
            action: 'status',
            command: ['models', 'status', '--json'],
            stdout: '',
            stderr: '',
            code: 0,
            data: {
              defaultModel: 'minimax/MiniMax-M2.5',
              allowed: ['minimax/MiniMax-M2.5', 'minimax-portal/MiniMax-M2.5'],
              auth: {
                oauth: {
                  providers: [{ provider: 'minimax-portal', status: 'ok' }],
                },
                missingProvidersInUse: ['minimax'],
              },
            },
          }) as any,
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        callGatewayRpc,
        runCommand: async (args: string[]) => {
          if (args[0] === 'sessions') {
            return {
              ok: true,
              stdout: JSON.stringify({
                sessions: [upstreamSession],
              }),
              stderr: '',
              code: 0,
            }
          }
          return {
            ok: false,
            stdout: '',
            stderr: 'unexpected command',
            code: 1,
          }
        },
        chatTransport: {
          run: transportRun as any,
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(callOrder).toEqual(['rpc:sessions.patch', 'transport-run'])
  })

  it('keeps the pure minimax oauth -> first send -> session unlock -> model switch path green', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-minimax-oauth-first-send-unlock')
    let config: Record<string, any> = {
      models: {
        providers: {
          'minimax-portal': {
            baseUrl: 'https://api.minimax.io/anthropic',
            models: [],
          },
        },
      },
    }
    const writeConfig = vi.fn(async (nextConfig: Record<string, any>) => {
      config = JSON.parse(JSON.stringify(nextConfig))
    })
    const authRunCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'plugins') {
        return {
          ok: true,
          stdout: 'enabled',
          stderr: '',
          code: 0,
        }
      }

      return {
        ok: false,
        stdout: '',
        stderr: 'unexpected command',
        code: 1,
      }
    })
    const authRunStreamingCommand = vi.fn(async (_args: string[], options?: Record<string, any>) => {
      options?.onStdout?.('Open: https://api.minimax.io/oauth/authorize')
      return {
        ok: true,
        stdout: 'done',
        stderr: '',
        code: 0,
      }
    })

    const authResult = await executeAuthRoute(
      {
        method: minimaxOauthMethod,
        providerId: 'minimax',
        methodId: 'minimax-portal',
        selectedExtraOption: 'oauth',
      },
      {
        runCommand: authRunCommand,
        runStreamingCommand: authRunStreamingCommand,
        resolveMainAgentAuthEnv: async () => null,
        readConfig: async () => config,
        writeConfig,
        repairMiniMaxOauthAgentAuthProfiles: async () => undefined,
      }
    )

    expect(authResult.ok).toBe(true)
    expect(config.models.providers['minimax-portal'].api).toBe('anthropic-messages')
    expect(authRunCommand).toHaveBeenNthCalledWith(
      1,
      ['plugins', 'enable', 'minimax-portal-auth'],
      expect.any(Number)
    )
    expect(authRunStreamingCommand).toHaveBeenNthCalledWith(
      1,
      ['models', 'auth', 'login', '--provider', 'minimax-portal', '--method', 'oauth'],
      expect.objectContaining({ onStdout: expect.any(Function) })
    )

    const readMinimaxStatus = async () =>
      ({
        ok: true,
        action: 'status',
        command: ['models', 'status', '--json'],
        stdout: '',
        stderr: '',
        code: 0,
        data: {
          defaultModel: 'minimax-portal/MiniMax-M2.7',
          allowed: ['minimax-portal/MiniMax-M2.7', 'minimax-portal/MiniMax-M2.5-Lightning'],
          auth: {
            providers: [{ provider: 'minimax-portal', status: 'ok' }],
          },
        },
      }) as any

    const localSession = await createLocalChatSession({
      discoverOpenClaw,
      now: () => 19_000,
      readModelStatus: readMinimaxStatus,
    })

    expect(localSession.canPatchModel).toBe(false)
    expect(localSession.modelSwitchBlockedReason).toContain('请先发送第一条消息')

    let upstreamSession = {
      sessionId: 'upstream-minimax-session',
      key: 'agent:main:minimax-flow',
      agentId: 'main',
      model: 'minimax-portal/MiniMax-M2.7',
      updatedAt: 20_000,
      kind: 'direct',
    }
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'sessions') {
        return {
          ok: true,
          stdout: JSON.stringify({ sessions: [upstreamSession] }),
          stderr: '',
          code: 0,
        }
      }

      return {
        ok: false,
        stdout: '',
        stderr: 'unexpected command',
        code: 1,
      }
    })
    const callGatewayRpc = vi.fn(async (method: string, params: unknown, timeoutMs?: number) => {
      if (method === 'sessions.create') {
        expect(params).toEqual({
          agentId: 'main',
          model: 'minimax-portal/MiniMax-M2.7',
        })
        expect(timeoutMs).toBe(20_000)
        return {
          key: upstreamSession.key,
          sessionId: upstreamSession.sessionId,
          entry: {
            key: upstreamSession.key,
            sessionId: upstreamSession.sessionId,
            agentId: upstreamSession.agentId,
            model: upstreamSession.model,
          },
        }
      }

      if (method === 'sessions.patch') {
        expect(params).toEqual({
          key: upstreamSession.key,
          model: 'minimax-portal/MiniMax-M2.5-Lightning',
        })
        expect(timeoutMs).toBe(20_000)
        upstreamSession = {
          ...upstreamSession,
          model: 'minimax-portal/MiniMax-M2.5-Lightning',
          updatedAt: 21_000,
        }
        return { ok: true }
      }

      throw new Error(`unexpected gateway rpc: ${method}`)
    })
    const transportRun = vi.fn(async (params: Record<string, unknown>) => {
      expect(params.sessionKey).toBe(upstreamSession.key)
      return {
        ok: true,
        stdout: JSON.stringify({
          response: {
            text: 'MiniMax 首条消息恢复成功',
          },
          model: upstreamSession.model,
        }),
        stderr: '',
        code: 0,
        streamedText: 'MiniMax 首条消息恢复成功',
        streamedModel: upstreamSession.model,
      }
    })

    const sendResult = await sendChatMessage(
      {
        sessionId: localSession.sessionId,
        text: 'nihao',
      },
      {
        discoverOpenClaw,
        readModelStatus: readMinimaxStatus,
        runCommand,
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        callGatewayRpc,
        chatTransport: {
          run: transportRun as any,
        },
      }
    )

    expect(sendResult.ok).toBe(true)
    expect(callGatewayRpc).toHaveBeenNthCalledWith(
      1,
      'sessions.create',
      {
        agentId: 'main',
        model: 'minimax-portal/MiniMax-M2.7',
      },
      20_000
    )

    const sessionsAfterSend = await listChatSessions({
      discoverOpenClaw,
      runCommand,
    })

    expect(sessionsAfterSend).toHaveLength(1)
    expect(sessionsAfterSend[0].sessionId).toBe(localSession.sessionId)
    expect(sessionsAfterSend[0].sessionKey).toBe('agent:main:minimax-flow')
    expect(sessionsAfterSend[0].canPatchModel).toBe(true)
    expect(sessionsAfterSend[0].modelSwitchBlockedReason).toBeUndefined()

    const patchResult = await patchChatSessionModel(
      {
        sessionId: localSession.sessionId,
        model: 'minimax-portal/MiniMax-M2.5-Lightning',
      },
      {
        discoverOpenClaw,
        readModelStatus: readMinimaxStatus,
        runCommand,
        callGatewayRpc,
      }
    )

    expect(patchResult).toMatchObject({
      ok: true,
      sessionId: localSession.sessionId,
      sessionKey: 'agent:main:minimax-flow',
      model: 'minimax-portal/MiniMax-M2.5-Lightning',
    })
    expect(callGatewayRpc).toHaveBeenNthCalledWith(
      2,
      'sessions.patch',
      {
        key: 'agent:main:minimax-flow',
        model: 'minimax-portal/MiniMax-M2.5-Lightning',
      },
      20_000
    )

    const transcript = await getChatTranscript(localSession.sessionId, {
      discoverOpenClaw,
      runCommand,
    })

    expect(transcript.sessionKey).toBe('agent:main:minimax-flow')
    expect(transcript.model).toBe('minimax-portal/MiniMax-M2.5-Lightning')
    expect(transcript.selectedModel).toBe('minimax-portal/MiniMax-M2.5-Lightning')
  }, 20_000)

  it('does not patch or override the model when a fresh empty local session sends its first message', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-preflight-bootstrap-created-session')
    const capturedPatchPayloads: Array<{ key: string; model: string }> = []

    const createdSession = await createChatSession({
      discoverOpenClaw,
      now: () => 12_345,
    })
    const transportRun = vi.fn(async (params: Record<string, unknown>) => {
      expect(params.sessionKey).toBe('agent:main:created-bootstrap-created-session')
      expect(params).not.toHaveProperty('model')
      return {
        ok: true,
        stdout: JSON.stringify({
          response: {
            text: '启动兼容成功',
          },
          model: 'openai/gpt-5.4-pro',
        }),
        stderr: '',
        code: 0,
      }
    })

    const result = await sendChatMessage(
      {
        sessionId: createdSession.sessionId,
        text: '第一条消息就指定模型',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('minimax/MiniMax-M2.5-highspeed'),
        runCommand: async (args) => {
          if (args[0] === 'sessions') {
            return {
              ok: true,
              stdout: JSON.stringify({ sessions: [] }),
              stderr: '',
              code: 0,
            }
          }

          if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.patch') {
            capturedPatchPayloads.push(JSON.parse(String(args[5])))
            return {
              ok: true,
              stdout: JSON.stringify({ ok: true }),
              stderr: '',
              code: 0,
            }
          }

          return {
            ok: false,
            stdout: '',
            stderr: 'unexpected command',
            code: 1,
          }
        },
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        callGatewayRpc: async () => ({
          key: 'agent:main:created-bootstrap-created-session',
          sessionId: 'created-bootstrap-created-session',
          entry: {
            key: 'agent:main:created-bootstrap-created-session',
            sessionId: 'created-bootstrap-created-session',
            agentId: 'main',
            model: 'minimax/MiniMax-M2.5-highspeed',
          },
        }),
        loadCapabilities: async () =>
          createCapabilities({
            chatAgentModelFlag: true,
            chatGatewaySendModel: false,
            chatInThreadModelSwitch: true,
          }),
        chatTransport: {
          run: transportRun as any,
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(capturedPatchPayloads).toEqual([])
    expect(transportRun).toHaveBeenCalledTimes(1)
  })

  it('forks an external-only session into a new local session before sending', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-preflight-external')
    const capturedCommands: string[][] = []

    const result = await sendChatMessage(
      {
        sessionId: 'external-session',
        text: '从外部历史会话继续',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('openai/gpt-5.4-pro'),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({
            sessions: [
              {
                sessionId: 'external-session',
                agentId: 'main',
                model: 'openai/gpt-5.4-pro',
                updatedAt: 5_000,
                kind: 'direct',
              },
            ],
          }),
          stderr: '',
          code: 0,
        }),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runStreamingCommand: async (args) => {
          capturedCommands.push(args)
          return {
            ok: true,
            stdout: JSON.stringify({
              response: {
                text: '已转入本地会话',
              },
              model: 'openai/gpt-5.4-pro',
            }),
            stderr: '',
            code: 0,
          }
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(result.sessionId).not.toBe('external-session')
    expect(capturedCommands[0]?.[3]).not.toBe('external-session')
    expect(capturedCommands[0]?.[3]).not.toBe(result.sessionId)
  })

  it('continues an upstream channel session in place when the upstream row is typed as channel', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-preflight-channel-kind')
    const transportRun = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        response: {
          text: '渠道会话原地续写成功',
        },
        model: 'openai/gpt-5.4-pro',
      }),
      stderr: '',
      code: 0,
      streamedText: '渠道会话原地续写成功',
    }))

    const result = await sendChatMessage(
      {
        sessionId: 'channel-session',
        text: '继续渠道会话',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('openai/gpt-5.4-pro'),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({
            sessions: [
              {
                sessionId: 'channel-session',
                key: 'channel:feishu:thread-1',
                agentId: 'main',
                model: 'openai/gpt-5.4-pro',
                updatedAt: 5_000,
                kind: 'channel',
              },
            ],
          }),
          stderr: '',
          code: 0,
        }),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        chatTransport: {
          run: transportRun,
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(result.sessionId).toBe('channel-session')
    expect(transportRun).toHaveBeenCalledTimes(1)
    expect((transportRun.mock.calls as any[])[0]?.[0]).toMatchObject({
      sessionKey: 'channel:feishu:thread-1',
      transportSessionId: 'channel-session',
    })
  })

  it('continues an external direct history session in place when a continuation key is available', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-preflight-external-continue')
    const capturedCommands: string[][] = []
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'sessions') {
        return {
          ok: true,
          stdout: JSON.stringify({
            sessions: [
              {
                sessionId: 'external-openclaw-history',
                key: 'agent:main:history-direct-session',
                agentId: 'main',
                model: 'minimax/MiniMax-M2.1',
                updatedAt: 8_000,
                kind: 'direct',
              },
            ],
          }),
          stderr: '',
          code: 0,
        }
      }

      if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.patch') {
        return {
          ok: false,
          stdout: '',
          stderr: 'sessions.patch should not be called during plain send',
          code: 1,
        }
      }

      return {
        ok: false,
        stdout: '',
        stderr: 'unexpected command',
        code: 1,
      }
    })

    const result = await sendChatMessage(
      {
        sessionId: 'external-openclaw-history',
        text: '切到 OpenAI 后发第一条消息',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('openai/gpt-5'),
        runCommand,
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        loadCapabilities: async () =>
          createCapabilities({
            chatAgentModelFlag: true,
            chatGatewaySendModel: false,
            chatInThreadModelSwitch: false,
          }),
        chatTransport: {
          run: async (params) => {
            capturedCommands.push([
              'transport.run',
              String(params.transportSessionId || ''),
              String(params.sessionKey || ''),
            ])
            return {
              ok: true,
              stdout: JSON.stringify({
                response: {
                  text: '已经继续当前 OpenClaw 历史会话',
                },
                model: 'minimax/MiniMax-M2.1',
              }),
              stderr: '',
              code: 0,
              streamedText: '已经继续当前 OpenClaw 历史会话',
              streamedModel: 'minimax/MiniMax-M2.1',
            }
          },
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(result.sessionId).toBe('external-openclaw-history')
    expect(runCommand.mock.calls.some(([args]) => args[0] === 'gateway' && args[2] === 'sessions.patch')).toBe(false)
    expect(capturedCommands[0]).toEqual([
      'transport.run',
      'external-openclaw-history',
      'agent:main:history-direct-session',
    ])
  })

  it('continues a feishu channel session in-place when sessionKey is available', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-preflight-feishu')
    const capturedRunParams: any[] = []

    const result = await sendChatMessage(
      {
        sessionId: 'feishu-session',
        text: '继续在飞书会话里聊',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('zai/glm-5'),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({
            sessions: [
              {
                sessionId: 'feishu-session',
                key: 'agent:feishu-default:feishu:default:direct:ou_11ec143ee4079fad7afe9c5fa042404f',
                agentId: 'main',
                model: 'zai/glm-5',
                updatedAt: 5_000,
                kind: 'direct',
              },
            ],
          }),
          stderr: '',
          code: 0,
        }),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        chatTransport: {
          run: async (params) => {
            capturedRunParams.push(params)
            return {
              ok: true,
              stdout: JSON.stringify({
                response: {
                  text: '收到，继续当前飞书会话。',
                },
                model: 'zai/glm-5',
              }),
              stderr: '',
              code: 0,
              streamedText: '收到，继续当前飞书会话。',
              streamedModel: 'zai/glm-5',
            }
          },
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(result.sessionId).toBe('feishu-session')
    expect(capturedRunParams[0]?.sessionKey).toBe(
      'agent:feishu-default:feishu:default:direct:ou_11ec143ee4079fad7afe9c5fa042404f'
    )
  })

  it('returns the actual forked session id that receives the new transcript', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-preflight-transcript')

    const result = await sendChatMessage(
      {
        sessionId: 'remote-history',
        text: '确认真实落盘会话',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('openai/gpt-5.4-pro'),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({
            sessions: [
              {
                sessionId: 'remote-history',
                agentId: 'main',
                model: 'custom-open-bigmodel-cn/glm-5',
                updatedAt: 8_000,
                kind: 'direct',
              },
            ],
          }),
          stderr: '',
          code: 0,
        }),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runStreamingCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({
            response: {
              text: '已写入新 transcript',
            },
            model: 'openai/gpt-5.4-pro',
          }),
          stderr: '',
          code: 0,
        }),
      }
    )

    expect(result.ok).toBe(true)
    expect(result.sessionId).not.toBe('remote-history')

    const transcript = await getChatTranscript(result.sessionId, {
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({
          sessions: [],
        }),
        stderr: '',
        code: 0,
      }),
    })

    expect(transcript.sessionId).toBe(result.sessionId)
    expect(transcript.messages.at(-1)?.text).toBe('已写入新 transcript')
  })

  it('uses a safe default thinking level instead of relying on implicit low', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-thinking-safe-default')
    const capturedCommands: string[][] = []

    const result = await sendChatMessage(
      {
        sessionId: 'thinking-safe-default',
        text: '测试安全默认 thinking',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('openai/gpt-5.4-pro'),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runStreamingCommand: async (args) => {
          capturedCommands.push(args)
          return {
            ok: true,
            stdout: JSON.stringify({
              response: {
                text: '安全默认值发送成功',
              },
              model: 'openai/gpt-5.4-pro',
            }),
            stderr: '',
            code: 0,
          }
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(capturedCommands[0]).toContain('--thinking')
    expect(capturedCommands[0]?.[capturedCommands[0].indexOf('--thinking') + 1]).toBe('off')
  })

  it('learns a supported fallback thinking level from provider error and retries once', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-thinking-learn')
    const capturedCommands: string[][] = []

    const result = await sendChatMessage(
      {
        sessionId: 'thinking-learn',
        text: '学习 thinking fallback',
        thinking: 'low',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('openai/gpt-5.4-pro'),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runStreamingCommand: async (args) => {
          capturedCommands.push(args)
          const thinkingLevel = args[args.indexOf('--thinking') + 1]
          if (thinkingLevel === 'low') {
            return {
              ok: false,
              stdout: '',
              stderr:
                "400 Unsupported value: 'low' is not supported with the 'gpt-5.4-pro' model. Supported values are: 'medium', 'high', and 'xhigh'.",
              code: 1,
            }
          }

          return {
            ok: true,
            stdout: JSON.stringify({
              response: {
                text: 'fallback retry 成功',
              },
              model: 'openai/gpt-5.4-pro',
            }),
            stderr: '',
            code: 0,
          }
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(capturedCommands).toHaveLength(2)
    expect(capturedCommands[0]?.[capturedCommands[0].indexOf('--thinking') + 1]).toBe('low')
    expect(capturedCommands[1]?.[capturedCommands[1].indexOf('--thinking') + 1]).toBe('medium')

    const compatStore = JSON.parse(
      await readFile(path.join(userDataDir, 'chat', 'model-thinking-compat.json'), 'utf8')
    ) as Record<string, { fallback?: string; unsupported?: string[]; sourceError?: string }>
    expect(compatStore['openai/gpt-5.4-pro']?.fallback).toBe('medium')
    expect(compatStore['openai/gpt-5.4-pro']?.unsupported).toContain('low')
    expect(compatStore['openai/gpt-5.4-pro']?.sourceError).toContain("Unsupported value: 'low'")
  })

  it('reuses the learned fallback for subsequent sends to the same model', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-thinking-reuse-learned')
    const capturedCommands: string[][] = []
    let requestCount = 0

    const runStreamingCommand = async (args: string[]) => {
      capturedCommands.push(args)
      requestCount += 1
      const thinkingLevel = args[args.indexOf('--thinking') + 1]
      if (requestCount === 1) {
        expect(thinkingLevel).toBe('low')
        return {
          ok: false,
          stdout: '',
          stderr:
            "400 Unsupported value: 'low' is not supported with the 'gpt-5.4-pro' model. Supported values are: 'medium', 'high', and 'xhigh'.",
          code: 1,
        }
      }

      return {
        ok: true,
        stdout: JSON.stringify({
          response: {
            text: 'learned fallback 成功',
          },
          model: 'openai/gpt-5.4-pro',
        }),
        stderr: '',
        code: 0,
      }
    }

    const sharedOptions = {
      discoverOpenClaw,
      readModelStatus: async () => createModelStatus('openai/gpt-5.4-pro'),
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({ sessions: [] }),
        stderr: '',
        code: 0,
      }),
      ensureGateway: async () => ({
        ok: true,
        stdout: '',
        stderr: '',
        code: 0,
        running: true,
      }),
      runStreamingCommand,
    }

    const firstResult = await sendChatMessage(
      {
        sessionId: 'thinking-reuse-first',
        text: '第一次学习',
        thinking: 'low',
      },
      sharedOptions
    )

    expect(firstResult.ok).toBe(true)

    const secondResult = await sendChatMessage(
      {
        sessionId: 'thinking-reuse-second',
        text: '第二次直接使用 learned fallback',
      },
      sharedOptions
    )

    expect(secondResult.ok).toBe(true)
    expect(capturedCommands).toHaveLength(3)
    expect(capturedCommands[2]?.[capturedCommands[2].indexOf('--thinking') + 1]).toBe('medium')
  })

  it('preserves an explicit supported thinking level instead of replacing it with the safe default', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-thinking-explicit')
    const capturedCommands: string[][] = []

    const result = await sendChatMessage(
      {
        sessionId: 'thinking-explicit',
        text: '显式 thinking',
        thinking: 'high',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('openai/gpt-5.4-pro'),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runStreamingCommand: async (args) => {
          capturedCommands.push(args)
          return {
            ok: true,
            stdout: JSON.stringify({
              response: {
                text: '显式值发送成功',
              },
              model: 'openai/gpt-5.4-pro',
            }),
            stderr: '',
            code: 0,
          }
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(capturedCommands[0]?.[capturedCommands[0].indexOf('--thinking') + 1]).toBe('high')
  })

  it('merges local transcript sessions with external sessions list', async () => {
    const discoverOpenClaw = async () =>
      ({
        status: 'installed',
        candidates: [
          {
            candidateId: 'candidate-1',
            binaryPath: '/usr/local/bin/openclaw',
            resolvedBinaryPath: '/usr/local/bin/openclaw',
            packageRoot: '/usr/local/lib/node_modules/openclaw',
            version: '2026.3.12',
            installSource: 'npm-global',
            isPathActive: true,
            configPath: '/Users/test/.openclaw/openclaw.json',
            stateRoot: '/Users/test/.openclaw',
            displayConfigPath: '~/.openclaw/openclaw.json',
            displayStateRoot: '~/.openclaw',
            ownershipState: 'external-preexisting',
            installFingerprint: 'fingerprint-2',
            baselineBackup: null,
            baselineBackupBypass: null,
          },
        ],
        activeCandidateId: 'candidate-1',
        hasMultipleCandidates: false,
        historyDataCandidates: [],
        errors: [],
        warnings: [],
        defaultBackupDirectory: '/tmp',
      }) as any

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-2',
      sessionId: 'local-session',
      agentId: 'main',
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          text: '本地消息',
          createdAt: 2000,
          status: 'sent',
        },
      ],
      updatedAt: 2_000,
    })

    const sessions = await listChatSessions({
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({
          sessions: [
            {
              sessionId: 'local-session',
              key: 'agent:main:main',
              agentId: 'main',
              model: 'openai/gpt-5.1-codex',
              updatedAt: 3_000,
              kind: 'direct',
              totalTokens: 200,
              contextTokens: 4000,
            },
            {
              sessionId: 'remote-session',
              key: 'agent:feishu-default:feishu:default:direct:ou_123',
              agentId: 'main',
              model: 'google/gemini-2.5-pro',
              updatedAt: 1_000,
              kind: 'direct',
              totalTokens: 20,
              contextTokens: 32000,
            },
          ],
        }),
        stderr: '',
        code: 0,
      }),
    })

    expect(sessions.map((session) => session.sessionId)).toEqual(['local-session', 'remote-session'])
    expect(sessions[0].hasLocalTranscript).toBe(true)
    expect(sessions[0].model).toBe('openai/gpt-5.1-codex')
    expect(sessions[0].totalTokens).toBe(200)
    expect(sessions[0].contextTokens).toBe(4000)
    expect(sessions[0].sessionKey).toBe('agent:main:main')
    expect(sessions[0].canPatchModel).toBe(true)
    expect(sessions[0].canContinue).toBe(true)
    expect(sessions[0].authorityKind).toBe('mixed')
    expect(sessions[0].cachePresence).toBe('local-shell')
    expect(sessions[1].sessionKey).toBe('agent:feishu-default:feishu:default:direct:ou_123')
    expect(sessions[1].canPatchModel).toBe(false)
    expect(sessions[1].canContinue).toBe(true)
    expect(sessions[1].authorityKind).toBe('upstream-channel')
    expect(sessions[1].cachePresence).toBe('none')
    expect(sessions[1].modelSwitchBlockedReason).toContain('渠道会话')
  })

  it('marks a freshly created empty local conversation as not patchable yet', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-create-session')

    const session = await createChatSession({
      discoverOpenClaw,
      now: () => 12_345,
    })

    expect(session.canPatchModel).toBe(false)
    expect(session.canContinue).toBe(false)
    expect(session.authorityKind).toBe('local-cache-only')
    expect(session.cachePresence).toBe('local-shell')
    expect(session.modelSwitchBlockedReason).toContain('请先发送第一条消息')

    const transcript = await getChatTranscript(session.sessionId, {
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({ sessions: [] }),
        stderr: '',
        code: 0,
      }),
    })

    expect(transcript.canPatchModel).toBe(false)
    expect(transcript.canContinue).toBe(false)
    expect(transcript.authorityKind).toBe('local-cache-only')
    expect(transcript.cachePresence).toBe('local-shell')
    expect(transcript.modelSwitchBlockedReason).toContain('请先发送第一条消息')
  })

  it('creates a local-only chat shell directly for the explicit new-chat action', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-create-local-shell')
    const ensureGateway = vi.fn(async () => {
      throw new Error('should not be called')
    })
    const callGatewayRpc = vi.fn(async () => {
      throw new Error('should not be called')
    })

    const session = await createLocalChatSession({
      discoverOpenClaw,
      now: () => 12_345,
      ensureGateway,
      callGatewayRpc,
    })

    expect(session.localOnly).toBe(true)
    expect(session.canPatchModel).toBe(false)
    expect(session.canContinue).toBe(false)
    expect(session.authorityKind).toBe('local-cache-only')
    expect(session.cachePresence).toBe('local-shell')
    expect(ensureGateway).not.toHaveBeenCalled()
    expect(callGatewayRpc).not.toHaveBeenCalled()
  })

  it('creates an upstream direct chat session through sessions.create when gateway is ready', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-create-upstream-session')
    const callOrder: string[] = []
    const ensureGateway = vi.fn(async () => {
      callOrder.push('ensure-gateway')
      return {
        ok: true,
        running: true,
        stdout: '',
        stderr: '',
        code: 0,
      }
    })
    const callGatewayRpc = vi.fn(async (method: string, params: unknown) => {
      callOrder.push(`rpc:${method}`)
      expect(method).toBe('sessions.create')
      expect(params).toEqual({
        agentId: 'main',
        model: 'openai/gpt-5.1-codex',
      })
      return {
        key: 'agent:main:created-upstream',
        sessionId: 'created-upstream',
        entry: {
          key: 'agent:main:created-upstream',
          sessionId: 'created-upstream',
          agentId: 'main',
          model: 'openai/gpt-5.1-codex',
        },
      }
    })

    const session = await createChatSession({
      discoverOpenClaw,
      now: () => 12_345,
      ensureGateway,
      callGatewayRpc,
      readModelStatus: async () => createModelStatus('openai/gpt-5.1-codex'),
    })

    expect(callOrder).toEqual(['ensure-gateway', 'rpc:sessions.create'])
    expect(session.sessionId).toBe('created-upstream')
    expect(session.sessionKey).toBe('agent:main:created-upstream')
    expect(session.model).toBe('openai/gpt-5.1-codex')
    expect(session.selectedModel).toBe('openai/gpt-5.1-codex')
    expect(session.localOnly).toBe(false)
    expect(session.canPatchModel).toBe(true)
    expect(session.canContinue).toBe(true)
    expect(session.authorityKind).toBe('upstream-direct')
    expect(session.cachePresence).toBe('local-shell')
    expect(listChatTraceEntries(2)).toEqual([
      expect.objectContaining({
        operation: 'create',
        stage: 'upstream-created',
        sessionId: 'created-upstream',
        sessionKey: 'agent:main:created-upstream',
      }),
      expect.objectContaining({
        operation: 'create',
        stage: 'start',
      }),
    ])
  })

  it('creates an upstream direct session with the reconciled runtime model when defaultModel is stale', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-create-upstream-stale-minimax-default')
    const callGatewayRpc = vi.fn(async (method: string, params: unknown) => {
      expect(method).toBe('sessions.create')
      expect(params).toEqual({
        agentId: 'main',
        model: 'minimax-portal/MiniMax-M2.7-highspeed',
      })
      return {
        key: 'agent:main:created-upstream-minimax',
        sessionId: 'created-upstream-minimax',
        entry: {
          key: 'agent:main:created-upstream-minimax',
          sessionId: 'created-upstream-minimax',
          agentId: 'main',
          model: 'minimax-portal/MiniMax-M2.7-highspeed',
        },
      }
    })

    const session = await createChatSession({
      discoverOpenClaw,
      now: () => 12_345,
      ensureGateway: async () => ({
        ok: true,
        running: true,
        stdout: '',
        stderr: '',
        code: 0,
      }),
      callGatewayRpc,
      readModelStatus: async () =>
        ({
          ok: true,
          action: 'status',
          command: ['models', 'status', '--json'],
          stdout: '',
          stderr: '',
          code: 0,
          data: {
            defaultModel: 'minimax/MiniMax-M2.7-highspeed',
            allowed: ['minimax-portal/MiniMax-M2.7-highspeed', 'minimax-portal/MiniMax-M2.5'],
            auth: {
              oauth: {
                providers: [{ provider: 'minimax-portal', status: 'ok' }],
              },
              missingProvidersInUse: ['minimax'],
            },
          },
        }) as any,
    })

    expect(callGatewayRpc).toHaveBeenCalledTimes(1)
    expect(session.model).toBe('minimax-portal/MiniMax-M2.7-highspeed')
    expect(session.selectedModel).toBe('minimax-portal/MiniMax-M2.7-highspeed')
  })

  it('falls back to a local shell when sessions.create is unsupported', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-create-fallback-session')
    const callGatewayRpc = vi.fn(async () => {
      throw new Error('unknown method: sessions.create')
    })

    const session = await createChatSession({
      discoverOpenClaw,
      now: () => 12_345,
      ensureGateway: async () => ({
        ok: true,
        running: true,
        stdout: '',
        stderr: '',
        code: 0,
      }),
      callGatewayRpc,
    })

    expect(callGatewayRpc).toHaveBeenCalledTimes(1)
    expect(session.localOnly).toBe(true)
    expect(session.canPatchModel).toBe(false)
    expect(session.canContinue).toBe(false)
    expect(session.authorityKind).toBe('local-cache-only')
    expect(session.cachePresence).toBe('local-shell')
    expect(listChatTraceEntries(2)).toEqual([
      expect.objectContaining({
        operation: 'create',
        stage: 'local-fallback',
        sessionId: session.sessionId,
      }),
      expect.objectContaining({
        operation: 'create',
        stage: 'start',
      }),
    ])
  })

  it('does not silently fall back when sessions.create returns an ambiguous payload', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-create-ambiguous-session')

    await expect(
      createChatSession({
        discoverOpenClaw,
        now: () => 12_345,
        ensureGateway: async () => ({
          ok: true,
          running: true,
          stdout: '',
          stderr: '',
          code: 0,
        }),
        callGatewayRpc: async () => ({
          key: 'agent:main:created-upstream',
        }),
      })
    ).rejects.toThrow(/unrecognized payload|结果不确定/)

    const sessions = await listChatSessions({
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({ sessions: [] }),
        stderr: '',
        code: 0,
      }),
    })

    expect(sessions).toEqual([])
    expect(listChatTraceEntries(2)).toEqual([
      expect.objectContaining({
        operation: 'create',
        stage: 'outcome-unknown',
      }),
      expect.objectContaining({
        operation: 'create',
        stage: 'start',
      }),
    ])
  })

  it('keeps an upstream-confirmed local shadow as upstream-direct in the session list', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-upstream-shadow-list')

    await createChatSession({
      discoverOpenClaw,
      now: () => 12_345,
      ensureGateway: async () => ({
        ok: true,
        running: true,
        stdout: '',
        stderr: '',
        code: 0,
      }),
      callGatewayRpc: async () => ({
        key: 'agent:main:created-shadow',
        sessionId: 'created-shadow',
        entry: {
          key: 'agent:main:created-shadow',
          sessionId: 'created-shadow',
          agentId: 'main',
          model: 'openai/gpt-5.1-codex',
        },
      }),
      readModelStatus: async () => createModelStatus('openai/gpt-5.1-codex'),
    })

    const sessions = await listChatSessions({
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({ sessions: [] }),
        stderr: '',
        code: 0,
      }),
    })

    expect(sessions).toHaveLength(1)
    expect(sessions[0].sessionId).toBe('created-shadow')
    expect(sessions[0].sessionKey).toBe('agent:main:created-shadow')
    expect(sessions[0].localOnly).toBe(false)
    expect(sessions[0].canPatchModel).toBe(true)
    expect(sessions[0].canContinue).toBe(true)
    expect(sessions[0].authorityKind).toBe('upstream-direct')
    expect(sessions[0].cachePresence).toBe('local-shell')
  })

  it('keeps a created upstream-confirmed session trusted after the first send even when upstream session inventory is unavailable', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-created-upstream-post-send')

    const createdSession = await createChatSession({
      discoverOpenClaw,
      now: () => 12_345,
      ensureGateway: async () => ({
        ok: true,
        running: true,
        stdout: '',
        stderr: '',
        code: 0,
      }),
      callGatewayRpc: async () => ({
        key: 'agent:main:created-upstream',
        sessionId: 'created-upstream',
        entry: {
          key: 'agent:main:created-upstream',
          sessionId: 'created-upstream',
          agentId: 'main',
          model: 'openai/gpt-5.1-codex',
        },
      }),
      readModelStatus: async () => createModelStatus('openai/gpt-5.1-codex'),
    })

    const sendResult = await sendChatMessage(
      {
        sessionId: createdSession.sessionId,
        text: '创建后首条消息',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('openai/gpt-5.1-codex'),
        ensureGateway: async () => ({
          ok: true,
          running: true,
          stdout: '',
          stderr: '',
          code: 0,
        }),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
        chatTransport: {
          run: async () => ({
            ok: true,
            stdout: JSON.stringify({
              response: {
                text: '收到，继续在已确认会话内回答。',
              },
              model: 'openai/gpt-5.1-codex',
            }),
            stderr: '',
            code: 0,
            streamedText: '收到，继续在已确认会话内回答。',
            streamedModel: 'openai/gpt-5.1-codex',
          }),
        },
      }
    )

    expect(sendResult.ok).toBe(true)

    const sessions = await listChatSessions({
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({ sessions: [] }),
        stderr: '',
        code: 0,
      }),
    })

    expect(sessions).toHaveLength(1)
    expect(sessions[0].sessionId).toBe('created-upstream')
    expect(sessions[0].sessionKey).toBe('agent:main:created-upstream')
    expect(sessions[0].localOnly).toBe(false)
    expect(sessions[0].canPatchModel).toBe(true)
    expect(sessions[0].canContinue).toBe(true)
    expect(sessions[0].authorityKind).toBe('mixed')
    expect(sessions[0].cachePresence).toBe('local-transcript')
  })

  it('returns an empty upstream-direct transcript for a fresh upstream-confirmed local shadow', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-upstream-shadow-transcript')

    await createChatSession({
      discoverOpenClaw,
      now: () => 12_345,
      ensureGateway: async () => ({
        ok: true,
        running: true,
        stdout: '',
        stderr: '',
        code: 0,
      }),
      callGatewayRpc: async () => ({
        key: 'agent:main:created-shadow',
        sessionId: 'created-shadow',
        entry: {
          key: 'agent:main:created-shadow',
          sessionId: 'created-shadow',
          agentId: 'main',
          model: 'openai/gpt-5.1-codex',
        },
      }),
      readModelStatus: async () => createModelStatus('openai/gpt-5.1-codex'),
    })

    const transcript = await getChatTranscript('created-shadow', {
      discoverOpenClaw,
      runCommand: async (args) => {
        if (args[0] === 'sessions') {
          return {
            ok: true,
            stdout: JSON.stringify({ sessions: [] }),
            stderr: '',
            code: 0,
          }
        }

        if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.get') {
          return {
            ok: true,
            stdout: JSON.stringify({ messages: [] }),
            stderr: '',
            code: 0,
          }
        }

        return {
          ok: false,
          stdout: '',
          stderr: 'unexpected command',
          code: 1,
        }
      },
    })

    expect(transcript.sessionId).toBe('created-shadow')
    expect(transcript.sessionKey).toBe('agent:main:created-shadow')
    expect(transcript.messages).toEqual([])
    expect(transcript.canPatchModel).toBe(true)
    expect(transcript.canContinue).toBe(true)
    expect(transcript.authorityKind).toBe('upstream-direct')
    expect(transcript.cachePresence).toBe('local-shell')
  })

  it('keeps a local session in conservative legacy mode after merging with an external row that lacks sessionKey', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-merge-patchable-local')

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-merge-patchable-local',
      sessionId: 'shared-session',
      agentId: 'main',
      model: 'openai/gpt-5.1-codex',
      selectedModel: 'openai/gpt-5.1-codex',
      transportSessionId: 'transport-shared-session',
      transportModel: 'openai/gpt-5.1-codex',
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          text: '本地消息',
          createdAt: 2_000,
          status: 'sent',
        },
      ],
      updatedAt: 2_000,
    })

    const sessions = await listChatSessions({
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({
          sessions: [
            {
              sessionId: 'shared-session',
              agentId: 'main',
              model: 'openai/gpt-5.1-codex',
              updatedAt: 3_000,
              kind: 'direct',
            },
          ],
        }),
        stderr: '',
        code: 0,
      }),
    })

    expect(sessions).toHaveLength(1)
    expect(sessions[0].sessionId).toBe('shared-session')
    expect(sessions[0].canPatchModel).toBe(false)
    expect(sessions[0].canContinue).toBe(false)
    expect(sessions[0].authorityKind).toBe('mixed')
    expect(sessions[0].cachePresence).toBe('local-shell')
    expect(sessions[0].modelSwitchBlockedReason).toContain('旧 transport 兼容态')

    const transcript = await getChatTranscript('shared-session', {
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({
          sessions: [
            {
              sessionId: 'shared-session',
              agentId: 'main',
              model: 'openai/gpt-5.1-codex',
              updatedAt: 3_000,
              kind: 'direct',
            },
          ],
        }),
        stderr: '',
        code: 0,
      }),
    })

    expect(transcript.canPatchModel).toBe(false)
    expect(transcript.canContinue).toBe(false)
    expect(transcript.authorityKind).toBe('mixed')
    expect(transcript.cachePresence).toBe('local-transcript')
    expect(transcript.modelSwitchBlockedReason).toContain('旧 transport 兼容态')
  })

  it('keeps an external-only direct OpenClaw history session patchable when it already has a session key', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-external-direct-patchable')

    const sessions = await listChatSessions({
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({
          sessions: [
            {
              sessionId: 'external-direct-session',
              key: 'agent:main:history-direct-session',
              agentId: 'main',
              model: 'zai/glm-5',
              updatedAt: 9_000,
              kind: 'direct',
            },
          ],
        }),
        stderr: '',
        code: 0,
      }),
    })

    expect(sessions).toHaveLength(1)
    expect(sessions[0].sessionId).toBe('external-direct-session')
    expect(sessions[0].hasLocalTranscript).toBe(false)
    expect(sessions[0].sessionKey).toBe('agent:main:history-direct-session')
    expect(sessions[0].canPatchModel).toBe(true)
    expect(sessions[0].canContinue).toBe(true)
    expect(sessions[0].authorityKind).toBe('upstream-direct')
    expect(sessions[0].cachePresence).toBe('none')
    expect(sessions[0].modelSwitchBlockedReason).toBeUndefined()

    const transcript = await getChatTranscript('external-direct-session', {
      discoverOpenClaw,
      runCommand: async (args) => {
        if (args[0] === 'sessions') {
          return {
            ok: true,
            stdout: JSON.stringify({
              sessions: [
                {
                  sessionId: 'external-direct-session',
                  key: 'agent:main:history-direct-session',
                  agentId: 'main',
                  model: 'zai/glm-5',
                  updatedAt: 9_000,
                  kind: 'direct',
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.get') {
          return {
            ok: true,
            stdout: JSON.stringify({
              messages: [
                {
                  id: 'assistant-1',
                  role: 'assistant',
                  text: '外部直接历史内容',
                  createdAt: 9_001,
                  model: 'zai/glm-5',
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        return {
          ok: false,
          stdout: '',
          stderr: 'unexpected command',
          code: 1,
        }
      },
    })

    expect(transcript.sessionId).toBe('external-direct-session')
    expect(transcript.sessionKey).toBe('agent:main:history-direct-session')
    expect(transcript.hasLocalTranscript).toBe(false)
    expect(transcript.canPatchModel).toBe(true)
    expect(transcript.canContinue).toBe(true)
    expect(transcript.authorityKind).toBe('upstream-direct')
    expect(transcript.cachePresence).toBe('none')
    expect(transcript.modelSwitchBlockedReason).toBeUndefined()
  })

  it('loads external transcript via sessions.get when local transcript does not exist', async () => {
    const discoverOpenClaw = async () =>
      ({
        status: 'installed',
        candidates: [
          {
            candidateId: 'candidate-1',
            binaryPath: '/usr/local/bin/openclaw',
            resolvedBinaryPath: '/usr/local/bin/openclaw',
            packageRoot: '/usr/local/lib/node_modules/openclaw',
            version: '2026.3.12',
            installSource: 'npm-global',
            isPathActive: true,
            configPath: '/Users/test/.openclaw/openclaw.json',
            stateRoot: '/Users/test/.openclaw',
            displayConfigPath: '~/.openclaw/openclaw.json',
            displayStateRoot: '~/.openclaw',
            ownershipState: 'external-preexisting',
            installFingerprint: 'fingerprint-3',
            baselineBackup: null,
            baselineBackupBypass: null,
          },
        ],
        activeCandidateId: 'candidate-1',
        hasMultipleCandidates: false,
        historyDataCandidates: [],
        errors: [],
        warnings: [],
        defaultBackupDirectory: '/tmp',
      }) as any

    const capturedCommands: string[][] = []
    const transcript = await getChatTranscript('remote-session', {
      discoverOpenClaw,
      runCommand: async (args) => {
        capturedCommands.push(args)
        if (args[0] === 'sessions') {
          return {
            ok: true,
            stdout: JSON.stringify({
              sessions: [
                {
                  sessionId: 'remote-session',
                  key: 'agent:feishu-default:feishu:default:direct:ou_456',
                  agentId: 'main',
                  model: 'google/gemini-2.5-pro',
                  updatedAt: 9_000,
                  kind: 'direct',
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.get') {
          return {
            ok: true,
            stdout: JSON.stringify({
              messages: [
                {
                  id: 'user-1',
                  role: 'user',
                  content: [{ type: 'text', text: '在吗？' }],
                  createdAt: 9_001,
                },
                {
                  id: 'assistant-1',
                  role: 'assistant',
                  content: [{ type: 'text', text: '在的，我在这里。' }],
                  createdAt: 9_002,
                  model: 'google/gemini-2.5-pro',
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        return {
          ok: false,
          stdout: '',
          stderr: 'unexpected command',
          code: 1,
        }
      },
    })

    expect(transcript.sessionId).toBe('remote-session')
    expect(transcript.sessionKey).toBe('agent:feishu-default:feishu:default:direct:ou_456')
    expect(transcript.model).toBe('google/gemini-2.5-pro')
    expect(transcript.canPatchModel).toBe(false)
    expect(transcript.modelSwitchBlockedReason).toContain('渠道会话')
    expect(transcript.updatedAt).toBe(9_000)
    expect(transcript.hasLocalTranscript).toBe(false)
    expect(transcript.historySource).toBe('sessions-get')
    expect(transcript.messages).toHaveLength(2)
    expect(transcript.messages[0].role).toBe('user')
    expect(transcript.messages[0].text).toContain('在吗')
    expect(transcript.messages[1].role).toBe('assistant')
    expect(transcript.messages[1].model).toBe('google/gemini-2.5-pro')
    expect(transcript.externalTranscriptLimit).toBe(200)
    expect(transcript.externalTranscriptTruncated).toBe(false)
    expect(transcript.externalTranscriptErrorCode).toBeUndefined()
    expect(capturedCommands.some((args) => args[0] === 'sessions' && args.includes('--all-agents'))).toBe(true)
    expect(capturedCommands.some((args) => args[0] === 'gateway' && args[2] === 'sessions.get')).toBe(true)
  })

  it('skips external tool-call partialJson records when loading transcript history', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-external-tool-history')

    const transcript = await getChatTranscript('remote-session', {
      discoverOpenClaw,
      runCommand: async (args) => {
        if (args[0] === 'sessions') {
          return {
            ok: true,
            stdout: JSON.stringify({
              sessions: [
                {
                  sessionId: 'remote-session',
                  key: 'agent:main:history-direct-session',
                  agentId: 'main',
                  model: 'openai/gpt-5.4',
                  updatedAt: 9_000,
                  kind: 'direct',
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.get') {
          return {
            ok: true,
            stdout: JSON.stringify({
              messages: [
                {
                  id: 'user-1',
                  role: 'user',
                  content: [{ type: 'text', text: '查一下深圳天气' }],
                  createdAt: 9_001,
                },
                {
                  id: 'assistant-tool-1',
                  role: 'assistant',
                  content: [
                    {
                      type: 'toolCall',
                      partialJson: '{"path":"~/homebrew/lib/node_modules/openclaw/skills/weather/SKILL.md"}',
                    },
                  ],
                  createdAt: 9_002,
                },
                {
                  id: 'assistant-1',
                  role: 'assistant',
                  content: [{ type: 'text', text: '深圳明天有阵雨，23-24°C。' }],
                  createdAt: 9_003,
                  model: 'openai/gpt-5.4',
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        return {
          ok: false,
          stdout: '',
          stderr: 'unexpected command',
          code: 1,
        }
      },
    })

    expect(transcript.messages).toHaveLength(2)
    expect(transcript.messages[0].role).toBe('user')
    expect(transcript.messages[1].role).toBe('assistant')
    expect(transcript.messages[1].text).toBe('深圳明天有阵雨，23-24°C。')
  })

  it('prefers chat.history for direct sessions when the history flag and capability gate are enabled', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-chat-history-primary')
    const capturedCommands: string[][] = []

    const transcript = await getChatTranscript('remote-direct-history', {
      discoverOpenClaw,
      chatHistoryPrimaryEnabled: true,
      loadCapabilities: async () =>
        createCapabilities({
          chatGatewaySendModel: true,
        }),
      runCommand: async (args) => {
        capturedCommands.push(args)
        if (args[0] === 'sessions') {
          return {
            ok: true,
            stdout: JSON.stringify({
              sessions: [
                {
                  sessionId: 'remote-direct-history',
                  key: 'agent:main:history-direct-session',
                  agentId: 'main',
                  model: 'openai/gpt-5.4-pro',
                  updatedAt: 9_500,
                  kind: 'direct',
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'chat.history') {
          return {
            ok: true,
            stdout: JSON.stringify({
              history: [
                {
                  id: 'user-1',
                  role: 'user',
                  content: [{ type: 'text', text: '继续这个 direct 会话' }],
                  createdAt: 9_501,
                },
                {
                  id: 'assistant-1',
                  role: 'assistant',
                  content: [{ type: 'text', text: '好的，已通过 chat.history 读取。' }],
                  createdAt: 9_502,
                  model: 'openai/gpt-5.4-pro',
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        return {
          ok: false,
          stdout: '',
          stderr: 'unexpected command',
          code: 1,
        }
      },
    })

    expect(transcript.historySource).toBe('chat-history')
    expect(transcript.messages).toHaveLength(2)
    expect(transcript.messages[1].text).toContain('chat.history')
    expect(capturedCommands.some((args) => args[0] === 'gateway' && args[2] === 'chat.history')).toBe(true)
    expect(capturedCommands.some((args) => args[0] === 'gateway' && args[2] === 'sessions.get')).toBe(false)
  })

  it('falls back to sessions.get when chat.history primary path fails', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-chat-history-fallback')
    const capturedCommands: string[][] = []

    const transcript = await getChatTranscript('remote-direct-history', {
      discoverOpenClaw,
      chatHistoryPrimaryEnabled: true,
      loadCapabilities: async () =>
        createCapabilities({
          chatGatewaySendModel: true,
        }),
      runCommand: async (args) => {
        capturedCommands.push(args)
        if (args[0] === 'sessions') {
          return {
            ok: true,
            stdout: JSON.stringify({
              sessions: [
                {
                  sessionId: 'remote-direct-history',
                  key: 'agent:main:history-direct-session',
                  agentId: 'main',
                  model: 'openai/gpt-5.4-pro',
                  updatedAt: 9_600,
                  kind: 'direct',
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'chat.history') {
          return {
            ok: false,
            stdout: '',
            stderr: 'method not found',
            code: 1,
          }
        }

        if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.get') {
          return {
            ok: true,
            stdout: JSON.stringify({
              messages: [
                {
                  id: 'assistant-1',
                  role: 'assistant',
                  content: [{ type: 'text', text: '已通过 sessions.get 回退成功。' }],
                  createdAt: 9_601,
                  model: 'openai/gpt-5.4-pro',
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        return {
          ok: false,
          stdout: '',
          stderr: 'unexpected command',
          code: 1,
        }
      },
    })

    expect(transcript.historySource).toBe('sessions-get')
    expect(transcript.messages).toHaveLength(1)
    expect(transcript.messages[0].text).toContain('sessions.get')
    expect(capturedCommands.some((args) => args[0] === 'gateway' && args[2] === 'chat.history')).toBe(true)
    expect(capturedCommands.some((args) => args[0] === 'gateway' && args[2] === 'sessions.get')).toBe(true)
  })

  it('falls back to local cache when both upstream history paths fail but local transcript exists', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-chat-history-local-fallback')

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-chat-history-local-fallback',
      sessionId: 'remote-direct-history',
      sessionKey: 'agent:main:history-direct-session',
      agentId: 'main',
      model: 'openai/gpt-5.4-pro',
      selectedModel: 'openai/gpt-5.4-pro',
      transportSessionId: 'transport-local-history',
      transportModel: 'openai/gpt-5.4-pro',
      messages: [
        {
          id: 'local-user-1',
          role: 'user',
          text: '本地缓存正文',
          createdAt: 9_700,
          status: 'sent',
        },
      ],
      updatedAt: 9_700,
    })

    const transcript = await getChatTranscript('remote-direct-history', {
      discoverOpenClaw,
      chatHistoryPrimaryEnabled: true,
      loadCapabilities: async () =>
        createCapabilities({
          chatGatewaySendModel: true,
        }),
      runCommand: async (args) => {
        if (args[0] === 'sessions') {
          return {
            ok: true,
            stdout: JSON.stringify({
              sessions: [
                {
                  sessionId: 'remote-direct-history',
                  key: 'agent:main:history-direct-session',
                  agentId: 'main',
                  model: 'openai/gpt-5.4-pro',
                  updatedAt: 9_701,
                  kind: 'direct',
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        if (args[0] === 'gateway' && args[1] === 'call' && (args[2] === 'chat.history' || args[2] === 'sessions.get')) {
          return {
            ok: false,
            stdout: '',
            stderr: 'gateway closed',
            code: 1,
          }
        }

        return {
          ok: false,
          stdout: '',
          stderr: 'unexpected command',
          code: 1,
        }
      },
    })

    expect(transcript.historySource).toBe('local-cache')
    expect(transcript.hasLocalTranscript).toBe(true)
    expect(transcript.messages).toHaveLength(1)
    expect(transcript.externalTranscriptErrorCode).toBe('gateway-offline')
  })

  it('strips untrusted metadata wrappers from external user messages', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-3meta')
    const transcript = await getChatTranscript('remote-session', {
      discoverOpenClaw,
      runCommand: async (args) => {
        if (args[0] === 'sessions') {
          return {
            ok: true,
            stdout: JSON.stringify({
              sessions: [
                {
                  sessionId: 'remote-session',
                  key: 'agent:feishu-default:feishu:default:direct:ou_meta',
                  agentId: 'main',
                  model: 'zai/glm-5',
                  updatedAt: 9_000,
                  kind: 'direct',
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.get') {
          return {
            ok: true,
            stdout: JSON.stringify({
              messages: [
                {
                  id: 'user-meta-1',
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: `System: [2026-03-19 21:34:06 GMT+8] Feishu[default] DM | ou_11ec143ee4079fad7afe9c5fa042404f
[msg:om_x100b548bfa13b4acb2675cd2f7d7aba]

Conversation info (untrusted metadata):
\`\`\`json
{
  "message_id": "om_x100b548bfa13b4acb2675cd2f7d7aba",
  "sender_id": "ou_11ec143ee4079fad7afe9c5fa042404f"
}
\`\`\`

Sender (untrusted metadata):
\`\`\`json
{
  "id": "ou_11ec143ee4079fad7afe9c5fa042404f"
}
\`\`\`

你用的是什么模型？`,
                    },
                  ],
                  createdAt: 9_001,
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        return {
          ok: false,
          stdout: '',
          stderr: 'unexpected command',
          code: 1,
        }
      },
    })

    expect(transcript.messages).toHaveLength(1)
    expect(transcript.messages[0].role).toBe('user')
    expect(transcript.messages[0].text).toBe('你用的是什么模型？')
    expect(transcript.messages[0].text).not.toContain('untrusted metadata')
    expect(transcript.messages[0].text).not.toContain('System:')
  })

  it('hides reply markers, message_id headers, and encrypted reasoning payloads', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-3meta-hidden')
    const transcript = await getChatTranscript('remote-session', {
      discoverOpenClaw,
      runCommand: async (args) => {
        if (args[0] === 'sessions') {
          return {
            ok: true,
            stdout: JSON.stringify({
              sessions: [
                {
                  sessionId: 'remote-session',
                  key: 'agent:feishu-default:feishu:default:direct:ou_hidden',
                  agentId: 'main',
                  model: 'zai/glm-5',
                  updatedAt: 9_100,
                  kind: 'direct',
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.get') {
          return {
            ok: true,
            stdout: JSON.stringify({
              messages: [
                {
                  id: 'user-hidden-1',
                  role: 'user',
                  content: [{ type: 'text', text: '[[reply_to_current]]\n[message_id: om_x100]\nou_11ec143ee4079fad7afe9c5fa042404f: 1\n你用的是什么模型？' }],
                  createdAt: 9_101,
                },
                {
                  id: 'assistant-reasoning-1',
                  role: 'assistant',
                  content: [
                    {
                      type: 'text',
                      text: '{"id":"rs_07827d08e460d7660069bba83b377c81959d294dca56d1eb03","type":"reasoning","encrypted_content":"gAAAAABpu6g9wtd9oingfVi0EDfC4gsSdGY87PpsBt6Gr_hump4OKCT1-fk0CZUpieqy8YH_STcrUaYVF5TBbpt54wpyqi_SvxatIijsxAZbCGPGDJyEAcrV3nXv5"}',
                    },
                  ],
                  createdAt: 9_102,
                },
                {
                  id: 'assistant-final-1',
                  role: 'assistant',
                  content: [{ type: 'text', text: '我现在用的是 GLM-5。' }],
                  createdAt: 9_103,
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        return {
          ok: false,
          stdout: '',
          stderr: 'unexpected command',
          code: 1,
        }
      },
    })

    expect(transcript.messages).toHaveLength(2)
    expect(transcript.messages[0].role).toBe('user')
    expect(transcript.messages[0].text).toBe('你用的是什么模型？')
    expect(transcript.messages[0].text).not.toContain('reply_to_current')
    expect(transcript.messages[0].text).not.toContain('message_id')
    expect(transcript.messages[1].role).toBe('assistant')
    expect(transcript.messages[1].text).toBe('我现在用的是 GLM-5。')
  })

  it('still loads external transcript when a local session shell exists but has no local messages', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-3local-empty')

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-3local-empty',
      sessionId: 'remote-session',
      agentId: 'main',
      messages: [
        {
          id: 'local-msg-1',
          role: 'user',
          text: '本地临时消息',
          createdAt: 8_000,
          status: 'sent',
        },
      ],
      updatedAt: 8_000,
    })
    await clearChatTranscript('remote-session', { discoverOpenClaw })

    const transcript = await getChatTranscript('remote-session', {
      discoverOpenClaw,
      runCommand: async (args) => {
        if (args[0] === 'sessions') {
          return {
            ok: true,
            stdout: JSON.stringify({
              sessions: [
                {
                  sessionId: 'remote-session',
                  key: 'agent:feishu-default:feishu:default:direct:ou_local_empty',
                  agentId: 'main',
                  model: 'zai/glm-5',
                  updatedAt: 9_200,
                  kind: 'direct',
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.get') {
          return {
            ok: true,
            stdout: JSON.stringify({
              messages: [
                {
                  id: 'external-user-1',
                  role: 'user',
                  content: [{ type: 'text', text: '你用的是什么模型？' }],
                  createdAt: 9_201,
                },
                {
                  id: 'external-assistant-1',
                  role: 'assistant',
                  content: [{ type: 'text', text: '我现在用的是 GLM-5。' }],
                  createdAt: 9_202,
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        return {
          ok: false,
          stdout: '',
          stderr: 'unexpected command',
          code: 1,
        }
      },
    })

    expect(transcript.hasLocalTranscript).toBe(false)
    expect(transcript.messages).toHaveLength(2)
    expect(transcript.messages[0].text).toContain('你用的是什么模型')
    expect(transcript.messages[1].text).toContain('GLM-5')
  })

  it('falls back to metadata when external transcript loading fails', async () => {
    const discoverOpenClaw = async () =>
      ({
        status: 'installed',
        candidates: [
          {
            candidateId: 'candidate-1',
            binaryPath: '/usr/local/bin/openclaw',
            resolvedBinaryPath: '/usr/local/bin/openclaw',
            packageRoot: '/usr/local/lib/node_modules/openclaw',
            version: '2026.3.12',
            installSource: 'npm-global',
            isPathActive: true,
            configPath: '/Users/test/.openclaw/openclaw.json',
            stateRoot: '/Users/test/.openclaw',
            displayConfigPath: '~/.openclaw/openclaw.json',
            displayStateRoot: '~/.openclaw',
            ownershipState: 'external-preexisting',
            installFingerprint: 'fingerprint-3b',
            baselineBackup: null,
            baselineBackupBypass: null,
          },
        ],
        activeCandidateId: 'candidate-1',
        hasMultipleCandidates: false,
        historyDataCandidates: [],
        errors: [],
        warnings: [],
        defaultBackupDirectory: '/tmp',
      }) as any

    const transcript = await getChatTranscript('remote-session', {
      discoverOpenClaw,
      runCommand: async (args) => {
        if (args[0] === 'sessions') {
          return {
            ok: true,
            stdout: JSON.stringify({
              sessions: [
                {
                  sessionId: 'remote-session',
                  key: 'agent:feishu-default:feishu:default:direct:ou_789',
                  agentId: 'main',
                  model: 'google/gemini-2.5-pro',
                  updatedAt: 9_000,
                  kind: 'direct',
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        return {
          ok: false,
          stdout: '',
          stderr: 'Gateway call failed',
          code: 1,
        }
      },
    })

    expect(transcript.sessionId).toBe('remote-session')
    expect(transcript.sessionKey).toBe('agent:feishu-default:feishu:default:direct:ou_789')
    expect(transcript.hasLocalTranscript).toBe(false)
    expect(transcript.messages).toEqual([])
    expect(transcript.externalTranscriptErrorCode).toBe('sessions-get-failed')
  })

  it('patches the current conversation model through sessions.patch when a patchable session exists', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-patch-model')
    const callGatewayRpc = vi.fn(async (method: string, params: unknown, timeoutMs?: number) => {
      expect(method).toBe('sessions.patch')
      expect(params).toEqual({
        key: 'agent:main:transport-123',
        model: 'openai/gpt-5.4-pro',
      })
      expect(timeoutMs).toBe(20_000)
      return { ok: true }
    })

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-patch-model',
      sessionId: 'local-session',
      agentId: 'main',
      model: 'moonshot/kimi-k2.5',
      selectedModel: 'moonshot/kimi-k2.5',
      transportSessionId: 'transport-123',
      transportModel: 'moonshot/kimi-k2.5',
      messages: [
        {
          id: 'local-msg-1',
          role: 'user',
          text: '旧消息',
          createdAt: 5_000,
          status: 'sent',
        },
      ],
      updatedAt: 5_000,
    })

    const result = await patchChatSessionModel(
      {
        sessionId: 'local-session',
        model: 'openai/gpt-5.4-pro',
      },
      {
        discoverOpenClaw,
        loadCapabilities: async () =>
          createCapabilities({
            chatInThreadModelSwitch: true,
          }),
        callGatewayRpc,
        runCommand: async (args) => {
          if (args[0] === 'sessions') {
            return {
              ok: true,
              stdout: JSON.stringify({ sessions: [] }),
              stderr: '',
              code: 0,
            }
          }

          return {
            ok: false,
            stdout: '',
            stderr: 'unexpected command',
            code: 1,
          }
        },
      }
    )

    expect(result).toMatchObject({
      ok: true,
      sessionId: 'local-session',
      sessionKey: undefined,
      model: 'openai/gpt-5.4-pro',
    })
    expect(callGatewayRpc).toHaveBeenCalledTimes(1)

    const transcript = await getChatTranscript('local-session', {
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({ sessions: [] }),
        stderr: '',
        code: 0,
      }),
    })

    expect(transcript.sessionKey).toBeUndefined()
    expect(transcript.model).toBe('openai/gpt-5.4-pro')
    expect(transcript.selectedModel).toBe('openai/gpt-5.4-pro')
  })

  it('prefers the control ui browser rpc path when patching without an injected gateway caller', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-control-ui-default')
    callGatewayRpcViaControlUiBrowserMock.mockResolvedValue({
      ok: true,
    })

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-control-ui-default',
      sessionId: 'control-ui-session',
      agentId: 'main',
      model: 'moonshot/kimi-k2.5',
      transportSessionId: 'transport-control-ui',
      messages: [
        {
          id: 'local-msg-1',
          role: 'user',
          text: '旧消息',
          createdAt: 5_000,
          status: 'sent',
        },
      ],
      updatedAt: 5_000,
    })

    const result = await patchChatSessionModel(
      {
        sessionId: 'control-ui-session',
        model: 'openai/gpt-5.4-pro',
      },
      {
        discoverOpenClaw,
        runCommand: async (args) => {
          if (args[0] === 'sessions') {
            return {
              ok: true,
              stdout: JSON.stringify({ sessions: [] }),
              stderr: '',
              code: 0,
            }
          }

          return {
            ok: false,
            stdout: '',
            stderr: 'unexpected command',
            code: 1,
          }
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(callGatewayRpcViaControlUiBrowserMock).toHaveBeenCalledTimes(1)
    expect(callGatewayRpcViaControlUiBrowserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        readConfig: readConfigMock,
        readEnvFile: readEnvFileMock,
      }),
      'sessions.patch',
      {
        key: 'agent:main:transport-control-ui',
        model: 'openai/gpt-5.4-pro',
      },
      {
        timeoutMs: 20_000,
      }
    )
  })

  it('patches an external-only direct OpenClaw history session in place when it has a session key', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-external-direct-patch')
    const callGatewayRpc = vi.fn(async () => ({ ok: true }))

    const result = await patchChatSessionModel(
      {
        sessionId: 'external-direct-patch-session',
        model: 'openai/gpt-5.4-pro',
      },
      {
        discoverOpenClaw,
        callGatewayRpc,
        runCommand: async (args) => {
          if (args[0] === 'sessions') {
            return {
              ok: true,
              stdout: JSON.stringify({
                sessions: [
                  {
                    sessionId: 'external-direct-patch-session',
                    key: 'agent:main:history-direct-session',
                    agentId: 'main',
                    model: 'zai/glm-5',
                    updatedAt: 12_000,
                    kind: 'direct',
                  },
                ],
              }),
              stderr: '',
              code: 0,
            }
          }

          return {
            ok: false,
            stdout: '',
            stderr: 'unexpected command',
            code: 1,
          }
        },
      }
    )

    expect(result).toMatchObject({
      ok: true,
      sessionId: 'external-direct-patch-session',
      sessionKey: 'agent:main:history-direct-session',
      model: 'openai/gpt-5.4-pro',
    })
    expect(callGatewayRpc).toHaveBeenCalledWith(
      'sessions.patch',
      {
        key: 'agent:main:history-direct-session',
        model: 'openai/gpt-5.4-pro',
      },
      20_000
    )

    const transcript = await getChatTranscript('external-direct-patch-session', {
      discoverOpenClaw,
      runCommand: async (args) => {
        if (args[0] === 'sessions') {
          return {
            ok: true,
            stdout: JSON.stringify({
              sessions: [
                {
                  sessionId: 'external-direct-patch-session',
                  key: 'agent:main:history-direct-session',
                  agentId: 'main',
                  model: 'openai/gpt-5.4-pro',
                  updatedAt: 12_001,
                  kind: 'direct',
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.get') {
          return {
            ok: true,
            stdout: JSON.stringify({
              messages: [],
            }),
            stderr: '',
            code: 0,
          }
        }

        return {
          ok: false,
          stdout: '',
          stderr: 'unexpected command',
          code: 1,
        }
      },
    })

    expect(transcript.sessionKey).toBe('agent:main:history-direct-session')
    expect(transcript.canPatchModel).toBe(true)
    expect(transcript.model).toBe('openai/gpt-5.4-pro')
    expect(transcript.selectedModel).toBe('openai/gpt-5.4-pro')
  })

  it('keeps using a trusted session key even when local legacy transport state also exists', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-trusted-session-key-send')
    const transportRun = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        response: {
          text: '继续成功',
        },
        model: 'openai/gpt-5.4-pro',
      }),
      stderr: '',
      code: 0,
      streamedText: '继续成功',
      streamedModel: 'openai/gpt-5.4-pro',
    }))

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-trusted-session-key-send',
      sessionId: 'trusted-session',
      sessionKey: 'agent:main:history-direct-session',
      agentId: 'main',
      model: 'moonshot/kimi-k2.5',
      selectedModel: 'moonshot/kimi-k2.5',
      transportSessionId: 'transport-trusted-local',
      transportModel: 'moonshot/kimi-k2.5',
      messages: [
        {
          id: 'local-msg-1',
          role: 'user',
          text: '旧消息',
          createdAt: 5_000,
          status: 'sent',
        },
      ],
      updatedAt: 5_000,
    })

    const sendResult = await sendChatMessage(
      {
        sessionId: 'trusted-session',
        text: '继续当前会话',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('minimax/MiniMax-M2.5-highspeed'),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({
            sessions: [
              {
                sessionId: 'trusted-session',
                key: 'agent:main:history-direct-session',
                agentId: 'main',
                model: 'openai/gpt-5.4-pro',
                updatedAt: 6_000,
                kind: 'direct',
              },
            ],
          }),
          stderr: '',
          code: 0,
        }),
        chatTransport: {
          run: transportRun,
        },
      }
    )

    expect(sendResult.ok).toBe(true)
    expect(sendResult.sessionId).toBe('trusted-session')
    expect(transportRun).toHaveBeenCalledWith(
      expect.objectContaining({
        transportSessionId: 'transport-trusted-local',
        sessionKey: 'agent:main:history-direct-session',
      })
    )
  })

  it('prefers the control ui browser chat.send path for trusted upstream sessions by default', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-control-ui-chat-send')
    runGatewayChatViaControlUiBrowserMock.mockResolvedValue({
      runId: 'run-control-ui-1',
      sessionKey: 'agent:main:history-direct-session',
      payload: {
        state: 'final',
        runId: 'run-control-ui-1',
        sessionKey: 'agent:main:history-direct-session',
        message: {
          text: '通过网页通道发送成功',
          model: 'openai/gpt-5.4-pro',
          usage: {
            inputTokens: 12,
            outputTokens: 34,
          },
        },
      },
    })

    const sendResult = await sendChatMessage(
      {
        sessionId: 'trusted-default-control-ui',
        text: '继续当前 confirmed 会话',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('openai/gpt-5.4-pro'),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({
            sessions: [
              {
                sessionId: 'trusted-default-control-ui',
                key: 'agent:main:history-direct-session',
                agentId: 'main',
                model: 'openai/gpt-5.4-pro',
                updatedAt: 6_000,
                kind: 'direct',
              },
            ],
          }),
          stderr: '',
          code: 0,
        }),
      }
    )

    expect(sendResult.ok).toBe(true)
    expect(sendResult.message?.text).toBe('通过网页通道发送成功')
    expect(runGatewayChatViaControlUiBrowserMock).toHaveBeenCalledTimes(1)
    expect(runGatewayChatViaControlUiBrowserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        readConfig: readConfigMock,
        readEnvFile: readEnvFileMock,
      }),
      expect.objectContaining({
        sessionKey: 'agent:main:history-direct-session',
        message: '继续当前 confirmed 会话',
        thinking: 'off',
      })
    )
    expect(runCliStreamingMock).not.toHaveBeenCalled()
  })

  it('keeps confirmed local direct sessions on the socket transport path by default', () => {
    expect(
      shouldPreferControlUiBrowserChatTransportForSend({
        sessionKey: 'agent:main:trusted-local-session',
        localSessionState: {
          upstreamConfirmed: true,
          kind: 'direct',
        } as any,
      })
    ).toBe(false)
  })

  it('retries confirmed local direct sends through control ui browser when gateway transport cannot safely fall back', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-trusted-local-browser-retry')
    const transportRun = vi.fn(async () => ({
      ok: false,
      stdout: '',
      stderr: 'gateway transport unavailable and CLI fallback cannot safely continue an explicit external session key',
      code: 1,
      streamedText: '',
    }))

    runGatewayChatViaControlUiBrowserMock.mockResolvedValue({
      runId: 'run-control-ui-retry-1',
      sessionKey: 'agent:main:history-direct-session',
      payload: {
        state: 'final',
        runId: 'run-control-ui-retry-1',
        sessionKey: 'agent:main:history-direct-session',
        message: {
          text: '通过网页通道恢复发送',
          model: 'openai/gpt-5.4-pro',
        },
      },
    })

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-trusted-local-browser-retry',
      sessionId: 'trusted-local-retry-session',
      sessionKey: 'agent:main:history-direct-session',
      upstreamConfirmed: true,
      agentId: 'main',
      model: 'openai/gpt-5.4-pro',
      selectedModel: 'openai/gpt-5.4-pro',
      transportSessionId: 'transport-trusted-local-retry',
      transportModel: 'openai/gpt-5.4-pro',
      messages: [
        {
          id: 'local-msg-1',
          role: 'user',
          text: '旧消息',
          createdAt: 5_000,
          status: 'sent',
        },
      ],
      updatedAt: 5_000,
    })

    const sendResult = await sendChatMessage(
      {
        sessionId: 'trusted-local-retry-session',
        text: '继续当前会话',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('openai/gpt-5.4-pro'),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({
            sessions: [
              {
                sessionId: 'trusted-local-retry-session',
                key: 'agent:main:history-direct-session',
                agentId: 'main',
                model: 'openai/gpt-5.4-pro',
                updatedAt: 6_000,
                kind: 'direct',
              },
            ],
          }),
          stderr: '',
          code: 0,
        }),
        chatTransport: {
          run: transportRun,
        },
      }
    )

    expect(sendResult.ok).toBe(true)
    expect(sendResult.message?.text).toBe('通过网页通道恢复发送')
    expect(transportRun).toHaveBeenCalledTimes(1)
    expect(runGatewayChatViaControlUiBrowserMock).toHaveBeenCalledTimes(1)
    expect(runGatewayChatViaControlUiBrowserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        readConfig: readConfigMock,
        readEnvFile: readEnvFileMock,
      }),
      expect.objectContaining({
        sessionKey: 'agent:main:history-direct-session',
        message: '继续当前会话',
        thinking: 'off',
      })
    )
  })

  it('keeps the control ui browser retry path active when thinking fallback retries the send', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-trusted-local-browser-thinking-retry')
    const transportRun = vi.fn(async () => ({
      ok: false,
      stdout: '',
      stderr: 'gateway transport unavailable and CLI fallback cannot safely continue an explicit external session key',
      code: 1,
      streamedText: '',
    }))

    runGatewayChatViaControlUiBrowserMock
      .mockRejectedValueOnce(
        new Error(
          "400 Unsupported value: 'low' is not supported with the 'gpt-5.4-pro' model. Supported values are: 'medium', 'high', and 'xhigh'."
        )
      )
      .mockResolvedValueOnce({
        runId: 'run-control-ui-thinking-retry-2',
        sessionKey: 'agent:main:history-direct-session',
        payload: {
          state: 'final',
          runId: 'run-control-ui-thinking-retry-2',
          sessionKey: 'agent:main:history-direct-session',
          message: {
            text: 'browser thinking fallback 成功',
            model: 'openai/gpt-5.4-pro',
          },
        },
      })

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-trusted-local-browser-thinking-retry',
      sessionId: 'trusted-local-thinking-retry-session',
      sessionKey: 'agent:main:history-direct-session',
      upstreamConfirmed: true,
      agentId: 'main',
      model: 'openai/gpt-5.4-pro',
      selectedModel: 'openai/gpt-5.4-pro',
      transportSessionId: 'transport-trusted-local-thinking-retry',
      transportModel: 'openai/gpt-5.4-pro',
      messages: [
        {
          id: 'local-msg-1',
          role: 'user',
          text: '旧消息',
          createdAt: 5_000,
          status: 'sent',
        },
      ],
      updatedAt: 5_000,
    })

    const sendResult = await sendChatMessage(
      {
        sessionId: 'trusted-local-thinking-retry-session',
        text: '继续当前会话',
        thinking: 'low',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('openai/gpt-5.4-pro'),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({
            sessions: [
              {
                sessionId: 'trusted-local-thinking-retry-session',
                key: 'agent:main:history-direct-session',
                agentId: 'main',
                model: 'openai/gpt-5.4-pro',
                updatedAt: 6_000,
                kind: 'direct',
              },
            ],
          }),
          stderr: '',
          code: 0,
        }),
        chatTransport: {
          run: transportRun,
        },
      }
    )

    expect(sendResult.ok).toBe(true)
    expect(sendResult.message?.text).toBe('browser thinking fallback 成功')
    expect(transportRun).toHaveBeenCalledTimes(1)
    expect(runGatewayChatViaControlUiBrowserMock).toHaveBeenCalledTimes(2)
    expect(runGatewayChatViaControlUiBrowserMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        readConfig: readConfigMock,
        readEnvFile: readEnvFileMock,
      }),
      expect.objectContaining({
        sessionKey: 'agent:main:history-direct-session',
        message: '继续当前会话',
        thinking: 'low',
      })
    )
    expect(runGatewayChatViaControlUiBrowserMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        readConfig: readConfigMock,
        readEnvFile: readEnvFileMock,
      }),
      expect.objectContaining({
        sessionKey: 'agent:main:history-direct-session',
        message: '继续当前会话',
        thinking: 'medium',
      })
    )
  })

  it('still prefers the control ui browser path for external trusted sessions', () => {
    expect(
      shouldPreferControlUiBrowserChatTransportForSend({
        sessionKey: 'agent:main:history-direct-session',
      })
    ).toBe(true)
    expect(
      shouldPreferControlUiBrowserChatTransportForSend({
        sessionKey: 'agent:channel-default:main',
        continueWithExternalSessionKey: 'agent:channel-default:main',
        localSessionState: {
          upstreamConfirmed: true,
          kind: 'direct',
        } as any,
      })
    ).toBe(true)
  })

  it('does not promote a legacy patch bridge into a trusted session key on the next send', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-patch-send')
    const callGatewayRpc = vi.fn(async () => ({ ok: true }))
    const transportRun = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        response: {
          text: '继续成功',
        },
        model: 'openai/gpt-5.4-pro',
      }),
      stderr: '',
      code: 0,
      streamedText: '继续成功',
      streamedModel: 'openai/gpt-5.4-pro',
    }))

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-patch-send',
      sessionId: 'patched-session',
      agentId: 'main',
      model: 'moonshot/kimi-k2.5',
      selectedModel: 'moonshot/kimi-k2.5',
      transportSessionId: 'transport-456',
      transportModel: 'moonshot/kimi-k2.5',
      messages: [
        {
          id: 'local-msg-1',
          role: 'user',
          text: '旧消息',
          createdAt: 5_000,
          status: 'sent',
        },
      ],
      updatedAt: 5_000,
    })

    const patchResult = await patchChatSessionModel(
      {
        sessionId: 'patched-session',
        model: 'openai/gpt-5.4-pro',
      },
      {
        discoverOpenClaw,
        loadCapabilities: async () =>
          createCapabilities({
            chatInThreadModelSwitch: true,
          }),
        callGatewayRpc,
        runCommand: async (args) => {
          if (args[0] === 'sessions') {
            return {
              ok: true,
              stdout: JSON.stringify({ sessions: [] }),
              stderr: '',
              code: 0,
            }
          }

          return {
            ok: false,
            stdout: '',
            stderr: 'unexpected command',
            code: 1,
          }
        },
      }
    )

    expect(patchResult.ok).toBe(true)
    expect(patchResult.sessionKey).toBeUndefined()
    expect(callGatewayRpc).toHaveBeenCalledWith(
      'sessions.patch',
      {
        key: 'agent:main:transport-456',
        model: 'openai/gpt-5.4-pro',
      },
      20_000
    )

    const sendResult = await sendChatMessage(
      {
        sessionId: 'patched-session',
        text: '继续当前会话',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('minimax/MiniMax-M2.5-highspeed'),
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
        chatTransport: {
          run: transportRun,
        },
      }
    )

    expect(sendResult.ok).toBe(true)
    expect(sendResult.sessionId).not.toBe('patched-session')
    expect(transportRun).toHaveBeenCalledTimes(1)
    expect(transportRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: undefined,
      })
    )
    const firstTransportArgs = (transportRun.mock.calls as Array<unknown[]>)[0]
    const firstTransportCall = firstTransportArgs?.[0] as Record<string, unknown> | undefined
    expect(String(firstTransportCall?.transportSessionId || '')).not.toBe('transport-456')
    expect(String(firstTransportCall?.messageText || '')).toContain('以下是当前对话最近的上下文')
  })

  it('ensures the gateway once before sending and does not patch the session model during send', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-send-patch-order')
    const callOrder: string[] = []
    const ensureGateway = vi.fn(async () => {
      callOrder.push('ensure-gateway')
      return {
        ok: true,
        stdout: '',
        stderr: '',
        code: 0,
        running: true,
      }
    })
    const transportRun = vi.fn(async () => {
      callOrder.push('transport-run')
      return {
        ok: true,
        stdout: JSON.stringify({
          response: {
            text: '切换后继续成功',
          },
          model: 'openai/gpt-5.4-pro',
        }),
        stderr: '',
        code: 0,
        streamedText: '切换后继续成功',
        streamedModel: 'openai/gpt-5.4-pro',
      }
    })

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-send-patch-order',
      sessionId: 'send-patch-session',
      agentId: 'main',
      model: 'moonshot/kimi-k2.5',
      transportSessionId: 'transport-send-patch',
      messages: [
        {
          id: 'local-msg-1',
          role: 'user',
          text: '旧消息',
          createdAt: 5_000,
          status: 'sent',
        },
      ],
      updatedAt: 5_000,
    })

    const result = await sendChatMessage(
      {
        sessionId: 'send-patch-session',
        text: '继续当前会话',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => createModelStatus('moonshot/kimi-k2.5'),
        ensureGateway,
        runCommand: async (args) => {
          if (args[0] === 'sessions') {
            return {
              ok: true,
              stdout: JSON.stringify({ sessions: [] }),
              stderr: '',
              code: 0,
            }
          }

          return {
            ok: false,
            stdout: '',
            stderr: 'unexpected command',
            code: 1,
          }
        },
        chatTransport: {
          run: transportRun,
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(callOrder).toEqual(['ensure-gateway', 'transport-run'])
    expect(ensureGateway).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the current conversation has no patchable session identity', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-patch-missing')

    const result = await patchChatSessionModel(
      {
        sessionId: 'missing-session',
        model: 'openai/gpt-5.4-pro',
      },
      {
        discoverOpenClaw,
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }),
      }
    )

    expect(result.ok).toBe(false)
    expect(result.messageText).toContain('当前会话还没有可切换的 OpenClaw session')
  })

  it('surfaces gateway patch failures instead of misreporting them as unsupported', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-patch-gateway-error')

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-patch-gateway-error',
      sessionId: 'patch-error-session',
      agentId: 'main',
      model: 'openai/gpt-5.4',
      transportSessionId: 'transport-patch-error',
      messages: [
        {
          id: 'msg-existing',
          role: 'assistant',
          text: '旧回复',
          createdAt: 1_000,
          status: 'sent',
        },
      ],
      updatedAt: 1_000,
    })

    const result = await patchChatSessionModel(
      {
        sessionId: 'patch-error-session',
        model: 'openai/gpt-5.4-pro',
      },
      {
        discoverOpenClaw,
        callGatewayRpc: async () => {
          throw new Error('gateway closed (1006 abnormal closure (no close frame)): no close reason')
        },
        runCommand: async (args) => {
          if (args[0] === 'sessions') {
            return {
              ok: true,
              stdout: JSON.stringify({ sessions: [] }),
              stderr: '',
              code: 0,
            }
          }
          return {
            ok: false,
            stdout: '',
            stderr: 'unexpected command',
            code: 1,
          }
        },
      }
    )

    expect(result.ok).toBe(false)
    expect(result.messageText).not.toContain('当前 OpenClaw 版本还不支持')
    expect(result.messageText).toContain('网关尚未就绪')
  })

  it('rejects model switches early when the target model is not allowed by the current OpenClaw config', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-patch-model-not-allowed')
    const callGatewayRpc = vi.fn(async () => ({ ok: true }))

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-patch-model-not-allowed',
      sessionId: 'patch-model-not-allowed',
      agentId: 'main',
      model: 'openai/gpt-5.4',
      transportSessionId: 'transport-model-not-allowed',
      messages: [
        {
          id: 'msg-existing',
          role: 'assistant',
          text: '旧回复',
          createdAt: 1_000,
          status: 'sent',
        },
      ],
      updatedAt: 1_000,
    })

    const result = await patchChatSessionModel(
      {
        sessionId: 'patch-model-not-allowed',
        model: 'openai/gpt-4.1-mini',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => ({
          ok: true,
          action: 'status',
          command: ['models', 'status', '--json'],
          stdout: '',
          stderr: '',
          code: 0,
          data: {
            defaultModel: 'openai/gpt-5.4',
            allowed: ['openai/gpt-5.4', 'zai/glm-5'],
          },
        }),
        callGatewayRpc,
        runCommand: async (args) => {
          if (args[0] === 'sessions') {
            return {
              ok: true,
              stdout: JSON.stringify({ sessions: [] }),
              stderr: '',
              code: 0,
            }
          }
          return {
            ok: false,
            stdout: '',
            stderr: 'unexpected command',
            code: 1,
          }
        },
      }
    )

    expect(result.ok).toBe(false)
    expect(result.messageText).toContain('当前 OpenClaw 未启用模型 openai/gpt-4.1-mini')
    expect(callGatewayRpc).not.toHaveBeenCalled()
  })

  it('still attempts sessions.patch over gateway rpc when legacy capability probing says switching is unsupported', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-patch-supported-via-gateway')
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'sessions') {
        return {
          ok: true,
          stdout: JSON.stringify({ sessions: [] }),
          stderr: '',
          code: 0,
        }
      }
      return {
        ok: false,
        stdout: '',
        stderr: 'unexpected command',
        code: 1,
      }
    })
    const callGatewayRpc = vi.fn(async () => ({
      ok: true,
      resolved: {
        modelProvider: 'openai',
        model: 'gpt-5.4-pro',
      },
    }))

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-patch-supported-via-gateway',
      sessionId: 'patchable-session',
      agentId: 'main',
      model: 'minimax/MiniMax-M2.5-highspeed',
      transportSessionId: 'transport-patchable',
      messages: [
        {
          id: 'msg-existing',
          role: 'assistant',
          text: '旧回复',
          createdAt: 1_000,
          status: 'sent',
        },
      ],
      updatedAt: 1_000,
    })

    const result = await patchChatSessionModel(
      {
        sessionId: 'patchable-session',
        model: 'openai/gpt-5.4-pro',
      },
      {
        discoverOpenClaw,
        loadCapabilities: async () =>
          createCapabilities({
            chatAgentModelFlag: false,
            chatGatewaySendModel: true,
            chatInThreadModelSwitch: false,
          }),
        callGatewayRpc,
        runCommand,
      }
    )

    expect(result.ok).toBe(true)
    expect(callGatewayRpc).toHaveBeenCalledWith(
      'sessions.patch',
      {
        key: 'agent:main:transport-patchable',
        model: 'openai/gpt-5.4-pro',
      },
      20_000
    )
  })

  it('treats minimax/* requests as allowed when status.allowed only exposes minimax-portal aliases', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-patch-minimax-alias')
    const callGatewayRpc = vi.fn(async () => ({ ok: true }))

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-patch-minimax-alias',
      sessionId: 'minimax-alias-session',
      agentId: 'main',
      model: 'minimax/MiniMax-M2.5',
      transportSessionId: 'transport-minimax-alias',
      messages: [
        {
          id: 'local-msg-1',
          role: 'user',
          text: '旧消息',
          createdAt: 5_000,
          status: 'sent',
        },
      ],
      updatedAt: 5_000,
    })

    const result = await patchChatSessionModel(
      {
        sessionId: 'minimax-alias-session',
        model: 'minimax/MiniMax-M2.7',
      },
      {
        discoverOpenClaw,
        readModelStatus: async () => ({
          ok: true,
          action: 'status',
          command: ['control-ui-app', 'model-status'],
          stdout: '',
          stderr: '',
          code: 0,
          data: {
            defaultModel: 'minimax/MiniMax-M2.5',
            allowed: ['minimax-portal/MiniMax-M2.5', 'minimax-portal/MiniMax-M2.7'],
          },
        }),
        callGatewayRpc,
        runCommand: async (args) => {
          if (args[0] === 'sessions') {
            return {
              ok: true,
              stdout: JSON.stringify({ sessions: [] }),
              stderr: '',
              code: 0,
            }
          }
          return {
            ok: false,
            stdout: '',
            stderr: 'unexpected command',
            code: 1,
          }
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(callGatewayRpc).toHaveBeenCalledWith(
      'sessions.patch',
      {
        key: 'agent:main:transport-minimax-alias',
        model: 'minimax/MiniMax-M2.7',
      },
      20_000
    )
  })

  it('marks external transcript as truncated when sessions.get hits the limit', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-3c')

    const transcript = await getChatTranscript('remote-session', {
      discoverOpenClaw,
      runCommand: async (args) => {
        if (args[0] === 'sessions') {
          return {
            ok: true,
            stdout: JSON.stringify({
              sessions: [
                {
                  sessionId: 'remote-session',
                  key: 'agent:feishu-default:feishu:default:direct:ou_901',
                  agentId: 'main',
                  model: 'google/gemini-2.5-pro',
                  updatedAt: 9_000,
                  kind: 'direct',
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.get') {
          return {
            ok: true,
            stdout: JSON.stringify({
              messages: Array.from({ length: 200 }, (_, index) => ({
                id: `msg-${index}`,
                role: index % 2 === 0 ? 'user' : 'assistant',
                content: [{ type: 'text', text: `消息 ${index}` }],
                createdAt: 9_000 + index,
              })),
            }),
            stderr: '',
            code: 0,
          }
        }

        return {
          ok: false,
          stdout: '',
          stderr: 'unexpected command',
          code: 1,
        }
      },
    })

    expect(transcript.messages).toHaveLength(200)
    expect(transcript.externalTranscriptTruncated).toBe(true)
    expect(transcript.externalTranscriptLimit).toBe(200)
  })

  it('returns session-key-missing when external session lacks key after refresh', async () => {
    const discoverOpenClaw = createDiscovery('fingerprint-3d')
    const capturedCommands: string[][] = []
    const transcript = await getChatTranscript('remote-session', {
      discoverOpenClaw,
      runCommand: async (args) => {
        capturedCommands.push(args)
        if (args[0] === 'sessions') {
          return {
            ok: true,
            stdout: JSON.stringify({
              sessions: [
                {
                  sessionId: 'remote-session',
                  agentId: 'main',
                  model: 'google/gemini-2.5-pro',
                  updatedAt: 9_000,
                  kind: 'direct',
                },
              ],
            }),
            stderr: '',
            code: 0,
          }
        }

        return {
          ok: false,
          stdout: '',
          stderr: 'unexpected command',
          code: 1,
        }
      },
    })

    expect(transcript.messages).toEqual([])
    expect(transcript.externalTranscriptErrorCode).toBe('session-key-missing')
    expect(capturedCommands.filter((args) => args[0] === 'sessions')).toHaveLength(2)
  })

  it('clears local transcript without deleting the session identity', async () => {
    const discoverOpenClaw = async () =>
      ({
        status: 'installed',
        candidates: [
          {
            candidateId: 'candidate-1',
            binaryPath: '/usr/local/bin/openclaw',
            resolvedBinaryPath: '/usr/local/bin/openclaw',
            packageRoot: '/usr/local/lib/node_modules/openclaw',
            version: '2026.3.12',
            installSource: 'npm-global',
            isPathActive: true,
            configPath: '/Users/test/.openclaw/openclaw.json',
            stateRoot: '/Users/test/.openclaw',
            displayConfigPath: '~/.openclaw/openclaw.json',
            displayStateRoot: '~/.openclaw',
            ownershipState: 'external-preexisting',
            installFingerprint: 'fingerprint-4',
            baselineBackup: null,
            baselineBackupBypass: null,
          },
        ],
        activeCandidateId: 'candidate-1',
        hasMultipleCandidates: false,
        historyDataCandidates: [],
        errors: [],
        warnings: [],
        defaultBackupDirectory: '/tmp',
      }) as any

    await appendLocalChatMessages({
      scopeKey: 'fingerprint-4',
      sessionId: 'session-to-clear',
      agentId: 'main',
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          text: '要清空的消息',
          createdAt: 5_000,
          status: 'sent',
        },
      ],
      updatedAt: 5_000,
    })

    const cleared = await clearChatTranscript('session-to-clear', {
      discoverOpenClaw,
    })
    expect(cleared.ok).toBe(true)

    const transcript = await getChatTranscript('session-to-clear', {
      discoverOpenClaw,
      runCommand: async () => ({
        ok: true,
        stdout: JSON.stringify({
          sessions: [
            {
              sessionId: 'session-to-clear',
              agentId: 'main',
              model: 'openai/gpt-5.1-codex',
              updatedAt: 6_000,
              kind: 'direct',
            },
          ],
        }),
        stderr: '',
        code: 0,
      }),
    })

    expect(transcript.hasLocalTranscript).toBe(false)
    expect(transcript.messages).toEqual([])
    expect(transcript.model).toBe('openai/gpt-5.1-codex')
  })

  it('surfaces a snapshot delta before completion when the stream only exposes a partial JSON reply body', async () => {
    const discoverOpenClaw = async () =>
      ({
        status: 'installed',
        candidates: [
          {
            candidateId: 'candidate-1',
            binaryPath: '/usr/local/bin/openclaw',
            resolvedBinaryPath: '/usr/local/bin/openclaw',
            packageRoot: '/usr/local/lib/node_modules/openclaw',
            version: '2026.3.12',
            installSource: 'npm-global',
            isPathActive: true,
            configPath: '/Users/test/.openclaw/openclaw.json',
            stateRoot: '/Users/test/.openclaw',
            displayConfigPath: '~/.openclaw/openclaw.json',
            displayStateRoot: '~/.openclaw',
            ownershipState: 'external-preexisting',
            installFingerprint: 'fingerprint-5',
            baselineBackup: null,
            baselineBackupBypass: null,
          },
        ],
        activeCandidateId: 'candidate-1',
        hasMultipleCandidates: false,
        historyDataCandidates: [],
        errors: [],
        warnings: [],
        defaultBackupDirectory: '/tmp',
      }) as any

    const emittedEvents: string[] = []
    const result = await sendChatMessage(
      {
        sessionId: 'fallback-session',
        text: '测试回退',
      },
      {
        discoverOpenClaw,
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runStreamingCommand: async (_args, streamOptions) => {
          streamOptions?.onStdout?.('{\n')
          streamOptions?.onStdout?.('  "response": {\n')
          streamOptions?.onStdout?.('    "text": "最终回退成功"\n')
          streamOptions?.onStdout?.('  },\n')
          streamOptions?.onStdout?.('  "model": "openai/gpt-5.1-codex"\n')
          streamOptions?.onStdout?.('}\n')
          return {
            ok: true,
            stdout: JSON.stringify({
              response: {
                text: '最终回退成功',
              },
              model: 'openai/gpt-5.1-codex',
            }),
            stderr: '',
            code: 0,
          }
        },
        emit: (event) => emittedEvents.push(event.type),
      }
    )

    expect(result.ok).toBe(true)
    expect(result.message?.text).toBe('最终回退成功')
    expect(emittedEvents).toEqual(['assistant-start', 'assistant-delta', 'assistant-complete'])
  })

  it('returns canceled when the chat stream is stopped', async () => {
    const discoverOpenClaw = async () =>
      ({
        status: 'installed',
        candidates: [
          {
            candidateId: 'candidate-1',
            binaryPath: '/usr/local/bin/openclaw',
            resolvedBinaryPath: '/usr/local/bin/openclaw',
            packageRoot: '/usr/local/lib/node_modules/openclaw',
            version: '2026.3.12',
            installSource: 'npm-global',
            isPathActive: true,
            configPath: '/Users/test/.openclaw/openclaw.json',
            stateRoot: '/Users/test/.openclaw',
            displayConfigPath: '~/.openclaw/openclaw.json',
            displayStateRoot: '~/.openclaw',
            ownershipState: 'external-preexisting',
            installFingerprint: 'fingerprint-6',
            baselineBackup: null,
            baselineBackupBypass: null,
          },
        ],
        activeCandidateId: 'candidate-1',
        hasMultipleCandidates: false,
        historyDataCandidates: [],
        errors: [],
        warnings: [],
        defaultBackupDirectory: '/tmp',
      }) as any

    const result = await sendChatMessage(
      {
        sessionId: 'cancel-session',
        text: '停止测试',
      },
      {
        discoverOpenClaw,
        ensureGateway: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          code: 0,
          running: true,
        }),
        runStreamingCommand: async () => ({
          ok: false,
          stdout: '',
          stderr: 'Command canceled',
          code: null,
          canceled: true,
        }),
      }
    )

    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('canceled')
    expect(result.messageText).toBe('已停止回答')
  })
})
