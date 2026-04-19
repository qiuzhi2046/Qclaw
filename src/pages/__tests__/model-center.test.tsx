import { describe, expect, it, vi } from 'vitest'
import {
  AUTH_RETRY_HINT,
  DEFAULT_PROVIDER_CONFIG_EXPANDED,
  appendRetryRefreshHint,
  type OpenClawCapabilities,
  buildLocalProviderEnvUpdatesForSubmit,
  buildNextConfigWithLocalProviderSnapshot,
  buildCapabilitiesLoadingDisplay,
  refreshModelCapabilitiesData,
  buildSkipSetupContext,
  buildVerificationProviderCandidates,
  buildBusyStateDisplay,
  buildModelAuthRequest,
  resolveControlUiTimeoutProfile,
  resolveControlUiTimeoutOptions,
  resolveAuthVerificationPollPolicy,
  resolvePostAuthVerificationProfile,
  shouldIgnorePostAuthAsyncResult,
  shouldReleasePostAuthRecoveryLock,
  resolveRefreshCapabilitiesGuard,
  shouldGateRefreshDuringPostAuthRecovery,
  buildSubmitAuthResultDiagnosticDetails,
  classifyModelCenterBannerMessage,
  resolvePostAuthRecoveryLockForConfiguredCallback,
  shouldHoldPostAuthRecoveryLockUntilDeferredApply,
  executeRemoteModelAuthSubmission,
  buildProviderOptions,
  resolveNextProviderMethodSelection,
  canOpenManualOAuthUrl,
  canSubmitSelection,
  estimateCapabilitiesLoadingProgress,
  formatAuthRegistrySourceLabel,
  formatElapsedSeconds,
  getLocalDiscoveryDisplay,
  getRecommendedDependencyInstallOption,
  getProviderConfigToggleAriaLabel,
  getPhaseAfterAuthFailure,
  getPhaseAfterCancellation,
  getUnsupportedMethodReason,
  joinModelCenterNonBlockingMessages,
  mergeModelCenterNonBlockingMessagesWithPriority,
  resolveBrowserOAuthVerificationSnapshot,
  resolveModelCenterMethodDisplayCopy,
  resolveModelCenterProviderDisplayCopy,
  resolveDefaultModelForProviderCandidates,
  findConfiguredCustomProviderId,
  resolveProviderVerificationSnapshot,
  shouldSuppressModelCenterSecondaryNetworkBanner,
  shouldRenderProviderConfigContent,
  shouldShowCredentialProbeControl,
  shouldShowSkipButton,
  isProviderConfigured,
  methodRequiresBrowser,
  methodRequiresExtraOption,
  methodRequiresSecret,
  shouldPreferRuntimeModelSignalsAfterAuth,
  shouldDeferPostAuthDefaultModelApply,
  shouldRequireBlockingPostAuthVerification,
  shouldShowOAuthFallbackPanel,
  shouldShowManualOAuthLink,
} from '../ModelCenter'
import modelCenterSource from '../ModelCenter.tsx?raw'

const CAPABILITIES: OpenClawCapabilities = {
  version: 'OpenClaw 2026.3.8',
  discoveredAt: '2026-03-12T00:00:00.000Z',
  authRegistrySource: 'openclaw-internal-registry',
  authRegistry: {
    ok: true,
    source: 'openclaw-internal-registry',
    providers: [
      {
        id: 'openai',
        label: 'OpenAI Official',
        hint: 'Use your OpenAI account or API key.',
        methods: [
          {
            authChoice: 'openai-api-key',
            label: 'Official API Key',
            hint: 'Stored through OpenClaw onboard route.',
            kind: 'apiKey',
            route: {
              kind: 'onboard',
              cliFlag: '--openai-api-key',
              requiresSecret: true,
            },
          },
          {
            authChoice: 'openai-codex',
            label: 'OpenAI Codex OAuth',
            hint: 'Launches your browser for approval.',
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
        id: 'minimax',
        label: 'MiniMax',
        hint: 'Choose the region-specific OAuth entry.',
        methods: [
          {
            authChoice: 'minimax-portal',
            label: 'MiniMax Portal OAuth',
            hint: 'Select Global or CN below.',
            kind: 'oauth',
            route: {
              kind: 'models-auth-login',
              providerId: 'minimax-portal',
              pluginId: 'minimax-portal-auth',
              requiresBrowser: true,
              extraOptions: [
                { id: 'oauth', label: 'Global', hint: 'Use the international portal.' },
                { id: 'oauth-cn', label: 'CN', hint: 'Use the China portal.' },
              ],
            },
          },
          {
            authChoice: 'minimax-unsupported',
            label: 'Legacy MiniMax Auth',
            hint: 'This OpenClaw build does not support it.',
            kind: 'unknown',
            route: {
              kind: 'unsupported',
            },
          },
        ],
      },
    ],
  },
  authChoices: [
    {
      id: 'openai-api-key',
      providerId: 'openai',
      methodType: 'apiKey',
      source: 'onboard-help',
    },
  ],
  onboardFlags: ['--auth-choice', '--openai-api-key'],
  modelsCommands: ['list', 'status', 'auth'],
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
    modelsAuthLoginGitHubCopilot: false,
    aliases: false,
    fallbacks: false,
    imageFallbacks: false,
    modelsScan: false,
  },
}

const CUSTOM_CAPABILITIES: OpenClawCapabilities = {
  ...CAPABILITIES,
  authRegistry: {
    ...CAPABILITIES.authRegistry,
    providers: [
      ...CAPABILITIES.authRegistry.providers,
      {
        id: 'custom',
        label: 'Custom Provider',
        hint: 'Any OpenAI or Anthropic compatible endpoint.',
        methods: [
          {
            authChoice: 'custom-api-key',
            label: 'Custom Provider',
            kind: 'custom',
            route: {
              kind: 'onboard-custom',
              providerId: 'custom',
            } as any,
          } as any,
        ],
      },
    ],
  },
}

describe('buildProviderOptions', () => {
  it('builds providers and methods from auth registry labels and hints', () => {
    const providers = buildProviderOptions(CAPABILITIES, { openai: 'Should Not Win' })
    expect(providers.map((provider) => provider.id)).toEqual(['openai', 'minimax'])
    expect(providers[0]).toMatchObject({
      id: 'openai',
      name: 'OpenAI',
      hint: 'Use your OpenAI account or API key.',
    })
    expect(providers[0].methods[0]).toMatchObject({
      id: 'openai-api-key',
      label: 'Official API Key',
      hint: 'Stored through OpenClaw onboard route.',
    })
  })

  it('keeps rendering recognized providers when auth metadata is marked degraded', () => {
    const degradedProviders = buildProviderOptions({
      ...CAPABILITIES,
      authRegistry: {
        ...CAPABILITIES.authRegistry,
        ok: false,
      },
    })

    expect(degradedProviders.map((provider) => provider.id)).toEqual(['openai', 'minimax'])
  })

  it('renames the custom provider copy so it is distinct from local compatible endpoints', () => {
    const providers = buildProviderOptions(CUSTOM_CAPABILITIES)
    const customProvider = providers.find((provider) => provider.id === 'custom')

    expect(customProvider).toMatchObject({
      id: 'custom',
      name: '手动配置兼容 API',
      hint: '手动填写接口地址、Model ID 和认证信息，适合通用 OpenAI / Anthropic 兼容接口。',
    })
    expect(customProvider?.methods[0]).toMatchObject({
      id: 'custom-api-key',
      label: '手动填写接口信息',
      hint: '填写接口地址、Model ID 和认证信息后，按兼容协议写入 OpenClaw。',
    })
  })

  it('keeps unsupported methods visible with a clear disabled reason', () => {
    const providers = buildProviderOptions(CAPABILITIES)
    const unsupportedMethod = providers[1]?.methods.find((method) => method.id === 'minimax-unsupported')
    expect(unsupportedMethod).toBeTruthy()
    expect(unsupportedMethod?.supported).toBe(false)
    expect(unsupportedMethod?.disabledReason).toContain('unsupported')
  })

  it('marks plugin oauth methods unsupported when the current build lacks plugins enable', () => {
    const providers = buildProviderOptions({
      ...CAPABILITIES,
      supports: {
        ...CAPABILITIES.supports,
        pluginsEnable: false,
      },
    })
    const pluginMethod = providers[1]?.methods.find((method) => method.id === 'minimax-portal')

    expect(pluginMethod?.supported).toBe(false)
    expect(pluginMethod?.disabledReason).toContain('plugins enable')
  })

  it('marks onboard api key methods unsupported when the required cli flag is unavailable', () => {
    const providers = buildProviderOptions({
      ...CAPABILITIES,
      onboardFlags: ['--auth-choice'],
    })
    const apiKeyMethod = providers[0]?.methods.find((method) => method.id === 'openai-api-key')

    expect(apiKeyMethod?.supported).toBe(false)
    expect(apiKeyMethod?.disabledReason).toContain('命令行参数')
  })
})

describe('ModelCenter source copy cleanup', () => {
  it('does not keep the redundant provider setup helper copy in the page source', () => {
    expect(modelCenterSource).not.toContain('从 OpenClaw 能力中动态加载提供商与认证方式')
    expect(modelCenterSource).not.toContain('元数据来源：')
  })

  it('does not render provider and auth hint helper text below the selects', () => {
    expect(modelCenterSource).not.toMatch(/\{selectedProvider\?\.hint && <Text/)
    expect(modelCenterSource).not.toMatch(/\{selectedMethod\?\.hint && <Text/)
    expect(modelCenterSource).not.toMatch(/\.extraOptions\.find\(\(option\) => normalizeMethodId\(option\.id\) === normalizeMethodId\(selectedExtraOption\)\)\s*\?\.hint/)
  })

  it('wires the refresh action through the post-auth recovery guard before enabling the button again', () => {
    expect(modelCenterSource).toContain('const refreshGuard = resolveRefreshCapabilitiesGuard({')
    expect(modelCenterSource).toContain("setStatusText(refreshGuard.statusText || '正在同步认证结果，请稍候...')")
    expect(modelCenterSource).toMatch(/disabled=\{refreshGuard\.disabled\}/)
  })

  it('guards long post-auth async branches with attempt checks before mutating current UI state', () => {
    expect(modelCenterSource).toContain('const shouldDropAsyncResult = () =>')
    expect(modelCenterSource).toContain('const shouldReleaseRecoveryLock = () =>')
    expect(modelCenterSource).toContain('if (shouldDropAsyncResult()) return')
  })

  it('wires verification polling through a derived post-auth profile policy instead of the fixed default budget', () => {
    expect(modelCenterSource).toContain('const verificationPollPolicy = resolveAuthVerificationPollPolicy(')
    expect(modelCenterSource).toContain('verificationPollPolicy,')
    expect(modelCenterSource).toContain('options?.pollPolicy || UI_RUNTIME_DEFAULTS.authVerification.poll')
  })

  it('wires post-auth upstream reads and writes through derived control-ui timeout overrides', () => {
    expect(modelCenterSource).toContain('const controlUiTimeoutProfile = resolveControlUiTimeoutProfile(')
    expect(modelCenterSource).toContain('const controlUiTimeoutOptions = resolveControlUiTimeoutOptions(controlUiTimeoutProfile)')
    expect(modelCenterSource).toContain('window.api.getModelUpstreamState(controlUiTimeoutOptions)')
    expect(modelCenterSource).toContain('window.api.applyModelConfigViaUpstream({')
    expect(modelCenterSource).toContain('...controlUiTimeoutOptions,')
  })

  it('reuses the derived control-ui timeout budget when resolving a preferred model during post-auth recovery', () => {
    expect(modelCenterSource).toContain(
      'timeoutMs: controlUiTimeoutOptions?.timeoutMs || DEFAULT_MODEL_APPLY_TIMEOUT_MS'
    )
  })

  it('lets default-model apply use the helper confirmation budget instead of wrapping it in a fixed 6 second timeout', () => {
    expect(modelCenterSource).toContain('confirmationPolicy: verificationPollPolicy,')
    expect(modelCenterSource).not.toMatch(/withTimeout\(\s*applyDefaultModelWithGatewayReload\(/)
  })

  it('wires secondary network suppress through the shared banner priority helper before mutating warnings and oauth errors', () => {
    expect(modelCenterSource).toContain('shouldSuppressModelCenterSecondaryNetworkBanner({')
    expect(modelCenterSource).toContain('mergeModelCenterNonBlockingMessagesWithPriority({')
    expect(modelCenterSource).toContain("event: 'secondary-network-banner-suppressed'")
  })

  it('keeps deferred default-model apply responsible for recovery-lock release when stayOnConfigured is still on screen', () => {
    expect(modelCenterSource).toContain(
      'const holdPostAuthRecoveryLockUntilDeferredApply = shouldHoldPostAuthRecoveryLockUntilDeferredApply({'
    )
    expect(modelCenterSource).toMatch(
      /if \(!holdPostAuthRecoveryLockUntilDeferredApply && shouldReleaseRecoveryLock\(\)\) \{\s*setPostAuthRecoveryRefreshLocked\(false\)/
    )
    expect(modelCenterSource).toMatch(
      /finally \{\s*if \(holdPostAuthRecoveryLockUntilDeferredApply && shouldReleaseRecoveryLock\(\)\) \{\s*setPostAuthRecoveryRefreshLocked\(false\)/
    )
  })

  it('derives the callback banner suppression lock inside the rejection path so deferred unlocks are observed', () => {
    expect(modelCenterSource).toContain(
      'const releasedBeforeCallback = !holdPostAuthRecoveryLockUntilDeferredApply && shouldReleaseRecoveryLock()'
    )
    expect(modelCenterSource).toContain(
      'const callbackPostAuthRecoveryLocked = resolvePostAuthRecoveryLockForConfiguredCallback({'
    )
    expect(modelCenterSource).toMatch(/const callbackPostAuthRecoveryLocked = resolvePostAuthRecoveryLockForConfiguredCallback\(\{/)
    expect(modelCenterSource).toMatch(/postAuthRecoveryLocked:\s*postAuthRecoveryRefreshLockedRef\.current,/)
    expect(modelCenterSource).toContain('releasedBeforeCallback,')
    expect(modelCenterSource).toMatch(/postAuthRecoveryLocked:\s*callbackPostAuthRecoveryLocked,/)
  })
})

describe('buildNextConfigWithLocalProviderSnapshot', () => {
  it('persists local custom-openai provider details and scanned models into models.providers', () => {
    expect(
      buildNextConfigWithLocalProviderSnapshot({
        currentConfig: null,
        providerId: 'custom-openai',
        baseUrl: 'http://192.168.31.139:12995/v1',
        selectedModelKey: 'custom-openai/gpt-4',
        discoveredModels: [
          { key: 'custom-openai/gpt-4', name: 'gpt-4' },
          { key: 'custom-openai/gpt-4.1', name: 'gpt-4.1' },
        ],
      })
    ).toEqual({
      models: {
        providers: {
          'custom-openai': {
            baseUrl: 'http://192.168.31.139:12995/v1',
            models: [
              { id: 'gpt-4', name: 'gpt-4' },
              { id: 'gpt-4.1', name: 'gpt-4.1' },
            ],
          },
        },
      },
    })
  })
})

describe('shouldShowCredentialProbeControl', () => {
  it('keeps the setup flow free of realtime API-key probe controls', () => {
    expect(shouldShowCredentialProbeControl('openai', 'openai-api-key')).toBe(false)
    expect(shouldShowCredentialProbeControl('openai', 'openai-codex')).toBe(false)
  })
})

describe('resolveNextProviderMethodSelection', () => {
  it('keeps current provider and method when both still exist after refresh', () => {
    const providers = buildProviderOptions(CAPABILITIES)
    expect(
      resolveNextProviderMethodSelection(providers, {
        providerId: 'openai',
        methodId: 'openai-codex',
      })
    ).toEqual({
      providerId: 'openai',
      methodId: 'openai-codex',
    })
  })

  it('keeps provider but falls back to the first method when previous method disappears', () => {
    const providers = buildProviderOptions(CAPABILITIES)
    expect(
      resolveNextProviderMethodSelection(providers, {
        providerId: 'openai',
        methodId: 'removed-method',
      })
    ).toEqual({
      providerId: 'openai',
      methodId: 'openai-api-key',
    })
  })

  it('falls back to the first supported method when the previous selection becomes capability-blocked', () => {
    const providers = buildProviderOptions({
      ...CAPABILITIES,
      supports: {
        ...CAPABILITIES.supports,
        modelsAuthLogin: false,
      },
    })

    expect(
      resolveNextProviderMethodSelection(providers, {
        providerId: 'openai',
        methodId: 'openai-codex',
      })
    ).toEqual({
      providerId: 'openai',
      methodId: 'openai-api-key',
    })
  })

  it('falls back to first provider and method when previous provider disappears', () => {
    const providers = buildProviderOptions(CAPABILITIES)
    expect(
      resolveNextProviderMethodSelection(providers, {
        providerId: 'removed-provider',
        methodId: 'removed-method',
      })
    ).toEqual({
      providerId: 'openai',
      methodId: 'openai-api-key',
    })
  })

  it('returns empty selection when no providers are available', () => {
    expect(
      resolveNextProviderMethodSelection([], {
        providerId: 'openai',
        methodId: 'openai-codex',
      })
    ).toEqual({
      providerId: '',
      methodId: '',
    })
  })
})

describe('descriptor driven ui helpers', () => {
  it('appends the retry and refresh hint to auth failures', () => {
    expect(appendRetryRefreshHint('认证失败，请检查 API Key 或认证配置。')).toBe(
      `认证失败，请检查 API Key 或认证配置。\n（${AUTH_RETRY_HINT}）`
    )
    expect(appendRetryRefreshHint(`认证失败，请检查 API Key 或认证配置。\n（${AUTH_RETRY_HINT}）`)).toBe(
      `认证失败，请检查 API Key 或认证配置。\n（${AUTH_RETRY_HINT}）`
    )
  })

  it('uses route descriptors to decide whether secret/browser/extra selector is required', () => {
    const providers = buildProviderOptions(CAPABILITIES)
    const apiKeyMethod = providers[0]?.methods[0]
    const oauthMethod = providers[0]?.methods[1]
    const minimaxMethod = providers[1]?.methods[0]

    expect(methodRequiresSecret(apiKeyMethod)).toBe(true)
    expect(methodRequiresBrowser(apiKeyMethod)).toBe(false)
    expect(methodRequiresExtraOption(apiKeyMethod)).toBe(false)

    expect(methodRequiresSecret(oauthMethod)).toBe(false)
    expect(methodRequiresBrowser(oauthMethod)).toBe(true)
    expect(methodRequiresExtraOption(oauthMethod)).toBe(false)

    expect(methodRequiresBrowser(minimaxMethod)).toBe(true)
    expect(methodRequiresExtraOption(minimaxMethod)).toBe(true)
  })

  it('shows oauth fallback UI only for browser routes', () => {
    const providers = buildProviderOptions(CAPABILITIES)
    const apiKeyMethod = providers[0]?.methods[0]
    const oauthMethod = providers[0]?.methods[1]

    expect(shouldShowOAuthFallbackPanel('authing', oauthMethod)).toBe(true)
    expect(shouldShowOAuthFallbackPanel('authing', apiKeyMethod)).toBe(false)
    expect(shouldShowOAuthFallbackPanel('verifying', oauthMethod)).toBe(false)
  })

  it('only shows manual OAuth link when browser route has a verification url', () => {
    const providers = buildProviderOptions(CAPABILITIES)
    const apiKeyMethod = providers[0]?.methods[0]
    const oauthMethod = providers[0]?.methods[1]

    expect(shouldShowManualOAuthLink('authing', oauthMethod, 'https://auth.openai.com/oauth/authorize?x=1')).toBe(true)
    expect(shouldShowManualOAuthLink('authing', oauthMethod, '')).toBe(false)
    expect(shouldShowManualOAuthLink('authing', apiKeyMethod, 'https://auth.openai.com/oauth/authorize?x=1')).toBe(false)
  })

  it('disables manual-open button until verification url exists', () => {
    expect(canOpenManualOAuthUrl('', false)).toBe(false)
    expect(canOpenManualOAuthUrl('https://auth.openai.com/oauth/authorize?x=1', true)).toBe(false)
    expect(canOpenManualOAuthUrl('https://auth.openai.com/oauth/authorize?x=1', false)).toBe(true)
  })

  it('blocks submit for unsupported methods and missing required descriptor inputs', () => {
    const providers = buildProviderOptions(CAPABILITIES)
    const apiKeyMethod = providers[0]?.methods[0]
    const minimaxMethod = providers[1]?.methods[0]
    const unsupportedMethod = providers[1]?.methods[1]

    expect(canSubmitSelection({ phase: 'ready', providerId: 'openai', method: apiKeyMethod, secret: '' })).toBe(false)
    expect(canSubmitSelection({ phase: 'ready', providerId: 'openai', method: apiKeyMethod, secret: 'sk-live' })).toBe(true)
    expect(
      canSubmitSelection({
        phase: 'ready',
        providerId: 'minimax',
        method: minimaxMethod,
        selectedExtraOption: '',
      })
    ).toBe(false)
    expect(
      canSubmitSelection({
        phase: 'ready',
        providerId: 'minimax',
        method: minimaxMethod,
        selectedExtraOption: 'oauth-cn',
      })
    ).toBe(true)
    expect(canSubmitSelection({ phase: 'ready', providerId: 'minimax', method: unsupportedMethod })).toBe(false)
    expect(getUnsupportedMethodReason(unsupportedMethod)).toContain('unsupported')
  })

  it('requires custom provider descriptor inputs before submit becomes available', () => {
    const providers = buildProviderOptions(CUSTOM_CAPABILITIES)
    const customMethod = providers.find((provider) => provider.id === 'custom')?.methods[0]

    expect(
      canSubmitSelection({
        phase: 'ready',
        providerId: 'custom',
        method: customMethod,
      } as any)
    ).toBe(false)
    expect(
      canSubmitSelection({
        phase: 'ready',
        providerId: 'custom',
        method: customMethod,
        customConfig: {
          baseUrl: 'https://gateway.example.com/v1',
          modelId: 'acme-chat',
          compatibility: 'openai',
        },
      } as any)
    ).toBe(true)
  })

  it('prefers runtime model signals for api-key routes during post-auth verification', () => {
    const providers = buildProviderOptions(CAPABILITIES)
    const apiKeyMethod = providers[0]?.methods[0]
    const oauthMethod = providers[0]?.methods[1]
    const customMethod = buildProviderOptions(CUSTOM_CAPABILITIES).find((provider) => provider.id === 'custom')?.methods[0]

    expect(shouldPreferRuntimeModelSignalsAfterAuth(apiKeyMethod)).toBe(true)
    expect(shouldPreferRuntimeModelSignalsAfterAuth(oauthMethod)).toBe(false)
    expect(shouldDeferPostAuthDefaultModelApply(apiKeyMethod)).toBe(true)
    expect(shouldDeferPostAuthDefaultModelApply(oauthMethod)).toBe(false)
    expect(shouldDeferPostAuthDefaultModelApply(customMethod)).toBe(false)
    expect(shouldRequireBlockingPostAuthVerification(apiKeyMethod)).toBe(false)
    expect(shouldRequireBlockingPostAuthVerification(oauthMethod)).toBe(true)
    expect(shouldRequireBlockingPostAuthVerification(customMethod)).toBe(true)
    expect(
      shouldPreferRuntimeModelSignalsAfterAuth({
        kind: 'token',
        route: {
          kind: 'models-auth-setup-token',
        },
      })
    ).toBe(false)
  })

  it('picks the recommended dependency install option when one is available', () => {
    expect(
      getRecommendedDependencyInstallOption({
        dependencyId: 'gemini-cli',
        title: '安装 Gemini CLI',
        message: 'missing',
        commandName: 'gemini',
        recommendedMethod: 'npm',
        installOptions: [
          { method: 'npm', label: 'npm', commandPreview: 'npm install -g @google/gemini-cli' },
          { method: 'brew', label: 'brew', commandPreview: 'brew install gemini-cli' },
        ],
      })
    ).toEqual({
      method: 'npm',
      label: 'npm',
      commandPreview: 'npm install -g @google/gemini-cli',
    })
  })
})

describe('buildModelAuthRequest', () => {
  it('builds registry-driven login request for api key methods', () => {
    const providers = buildProviderOptions(CAPABILITIES)
    const apiKeyMethod = providers[0]?.methods[0]
    const action = buildModelAuthRequest({
      providerId: 'openai',
      method: apiKeyMethod,
      secret: 'sk-live-123',
    })

    expect(action).toEqual({
      kind: 'login',
      providerId: 'openai',
      methodId: 'openai-api-key',
      secret: 'sk-live-123',
      setDefault: true,
    })
  })

  it('passes selected extra options for multi-method oauth routes', () => {
    const providers = buildProviderOptions(CAPABILITIES)
    const minimaxMethod = providers[1]?.methods[0]
    const action = buildModelAuthRequest({
      providerId: 'minimax',
      method: minimaxMethod,
      selectedExtraOption: 'oauth-cn',
    })

    expect(action).toEqual({
      kind: 'login',
      providerId: 'minimax',
      methodId: 'minimax-portal',
      selectedExtraOption: 'oauth-cn',
      setDefault: true,
    })
  })

  it('passes custom provider inputs through the auth action payload', () => {
    const providers = buildProviderOptions(CUSTOM_CAPABILITIES)
    const customMethod = providers.find((provider) => provider.id === 'custom')?.methods[0]
    const action = buildModelAuthRequest({
      providerId: 'custom',
      method: customMethod,
      secret: 'sk-custom-123',
      customConfig: {
        baseUrl: 'https://gateway.example.com/v1',
        modelId: 'acme-chat',
        providerId: 'acme-gateway',
        compatibility: 'anthropic',
      },
    } as any)

    expect(action).toEqual({
      kind: 'login',
      providerId: 'custom',
      methodId: 'custom-api-key',
      secret: 'sk-custom-123',
      setDefault: true,
      customConfig: {
        baseUrl: 'https://gateway.example.com/v1',
        modelId: 'acme-chat',
        providerId: 'acme-gateway',
        compatibility: 'anthropic',
      },
    })
  })
})

describe('refreshModelCapabilitiesData', () => {
  it('forces a fresh capability rediscovery when the user refreshes model capabilities', async () => {
    const refreshModelData = vi.fn(async () => ({
      capabilities: CAPABILITIES,
      status: {
        ok: true,
        action: 'status' as const,
        command: ['openclaw', 'models', 'status'],
        stdout: '',
        stderr: '',
        code: 0,
        data: {},
      },
    }))

    await refreshModelCapabilitiesData(refreshModelData)

    expect(refreshModelData).toHaveBeenCalledWith({
      includeCapabilities: true,
      includeStatus: true,
      includeCatalog: false,
      forceCapabilitiesRefresh: true,
    })
  })
})

describe('executeRemoteModelAuthSubmission', () => {
  it('submits api-key methods through runModelAuth using the official auth request payload', async () => {
    const providers = buildProviderOptions(CAPABILITIES)
    const apiKeyMethod = providers[0]?.methods[0]
    const startModelOAuth = vi.fn()
    const runModelAuth = vi.fn(async () => ({ ok: true }))

    await executeRemoteModelAuthSubmission(
      {
        providerId: 'openai',
        method: apiKeyMethod!,
        secret: 'sk-live-123',
      },
      {
        startModelOAuth,
        runModelAuth,
      }
    )

    expect(startModelOAuth).not.toHaveBeenCalled()
    expect(runModelAuth).toHaveBeenCalledWith({
      kind: 'login',
      providerId: 'openai',
      methodId: 'openai-api-key',
      secret: 'sk-live-123',
      setDefault: true,
    })
  })

  it('passes through unknown auth result fields from runModelAuth unchanged', async () => {
    const providers = buildProviderOptions(CAPABILITIES)
    const apiKeyMethod = providers[0]?.methods[0]
    const startModelOAuth = vi.fn()
    const authResult = {
      ok: true,
      action: 'login',
      stdout: '',
      stderr: '',
      code: 0,
      fallbackUsed: false,
      postAuthRuntime: {
        tokenRotated: true,
        gatewayApplyAction: 'restart',
      },
    }
    const runModelAuth = vi.fn(async () => authResult)

    const result = await executeRemoteModelAuthSubmission(
      {
        providerId: 'openai',
        method: apiKeyMethod!,
        secret: 'sk-live-123',
      },
      {
        startModelOAuth,
        runModelAuth,
      }
    )

    expect(startModelOAuth).not.toHaveBeenCalled()
    expect(result).toEqual(authResult)
  })

  it('keeps browser oauth methods on the dedicated oauth launcher path', async () => {
    const providers = buildProviderOptions(CAPABILITIES)
    const oauthMethod = providers[1]?.methods[0]
    const startModelOAuth = vi.fn(async () => ({ ok: true }))
    const runModelAuth = vi.fn()

    await executeRemoteModelAuthSubmission(
      {
        providerId: 'minimax',
        method: oauthMethod!,
        selectedExtraOption: 'oauth-cn',
      },
      {
        startModelOAuth,
        runModelAuth,
      }
    )

    expect(runModelAuth).not.toHaveBeenCalled()
    expect(startModelOAuth).toHaveBeenCalledWith({
      providerId: 'minimax',
      methodId: 'minimax-portal',
      selectedExtraOption: 'oauth-cn',
      setDefault: true,
    })
  })

  it('passes through unknown oauth launcher result fields unchanged', async () => {
    const providers = buildProviderOptions(CAPABILITIES)
    const oauthMethod = providers[1]?.methods[0]
    const oauthResult = {
      ok: true,
      providerId: 'minimax',
      methodId: 'minimax-portal',
      loginProviderId: 'minimax-portal',
      stdout: '',
      stderr: '',
      code: 0,
      postAuthRuntime: {
        tokenRotated: false,
      },
    }
    const startModelOAuth = vi.fn(async () => oauthResult)
    const runModelAuth = vi.fn()

    const result = await executeRemoteModelAuthSubmission(
      {
        providerId: 'minimax',
        method: oauthMethod!,
        selectedExtraOption: 'oauth-cn',
      },
      {
        startModelOAuth,
        runModelAuth,
      }
    )

    expect(runModelAuth).not.toHaveBeenCalled()
    expect(result).toEqual(oauthResult)
  })
})

describe('buildSubmitAuthResultDiagnosticDetails', () => {
  it('keeps the legacy auth result diagnostic shape when post-auth runtime context is absent', () => {
    expect(
      buildSubmitAuthResultDiagnosticDetails({
        ok: true,
        fallbackUsed: false,
        errorCode: 'none',
        message: 'ok',
      })
    ).toEqual({
      ok: true,
      fallbackUsed: false,
      errorCode: 'none',
      message: 'ok',
    })
  })

  it('records optional post-auth runtime context without changing the base auth result fields', () => {
    expect(
      buildSubmitAuthResultDiagnosticDetails({
        ok: true,
        fallbackUsed: false,
        errorCode: undefined,
        message: 'ok',
        postAuthRuntime: {
          tokenRotated: true,
          gatewayApplyAction: 'restart',
          gatewayConfirmed: true,
          recoveryReason: 'gateway-token-rotated',
          recommendedVerificationProfile: 'post-auth-recovery',
        },
      })
    ).toEqual({
      ok: true,
      fallbackUsed: false,
      errorCode: undefined,
      message: 'ok',
      postAuthRuntime: {
        tokenRotated: true,
        gatewayApplyAction: 'restart',
        gatewayConfirmed: true,
        recoveryReason: 'gateway-token-rotated',
        recommendedVerificationProfile: 'post-auth-recovery',
      },
    })
  })
})

describe('shouldGateRefreshDuringPostAuthRecovery', () => {
  it('returns false when no post-auth runtime recovery signal is present', () => {
    expect(shouldGateRefreshDuringPostAuthRecovery(undefined)).toBe(false)
    expect(
      shouldGateRefreshDuringPostAuthRecovery({
        tokenRotated: false,
        gatewayApplyAction: 'none',
        gatewayConfirmed: true,
        recoveryReason: 'none',
        recommendedVerificationProfile: 'default',
      })
    ).toBe(false)
  })

  it('returns true when auth runtime signals a token rotation or gateway recovery apply action', () => {
    expect(
      shouldGateRefreshDuringPostAuthRecovery({
        tokenRotated: true,
        gatewayApplyAction: 'none',
        gatewayConfirmed: true,
        recoveryReason: 'none',
        recommendedVerificationProfile: 'default',
      })
    ).toBe(true)

    expect(
      shouldGateRefreshDuringPostAuthRecovery({
        tokenRotated: false,
        gatewayApplyAction: 'restart',
        gatewayConfirmed: true,
        recoveryReason: 'gateway-recovery',
        recommendedVerificationProfile: 'post-auth-recovery',
      })
    ).toBe(true)
  })
})

describe('resolveRefreshCapabilitiesGuard', () => {
  it('blocks refresh with the post-auth recovery copy when only the recovery lock is active', () => {
    expect(
      resolveRefreshCapabilitiesGuard({
        interactionLocked: false,
        refreshingCapabilities: false,
        phase: 'ready',
        postAuthRecoveryRefreshLocked: true,
      })
    ).toEqual({
      blocked: true,
      disabled: true,
      statusText: '正在同步认证结果，请稍候...',
    })
  })

  it('preserves existing refresh blocking reasons without forcing the post-auth recovery copy', () => {
    expect(
      resolveRefreshCapabilitiesGuard({
        interactionLocked: true,
        refreshingCapabilities: false,
        phase: 'ready',
        postAuthRecoveryRefreshLocked: false,
      })
    ).toEqual({
      blocked: true,
      disabled: true,
      statusText: '',
    })

    expect(
      resolveRefreshCapabilitiesGuard({
        interactionLocked: false,
        refreshingCapabilities: false,
        phase: 'loading',
        postAuthRecoveryRefreshLocked: false,
      })
    ).toEqual({
      blocked: true,
      disabled: true,
      statusText: '',
    })
  })

  it('leaves refresh available when neither the core lock nor the recovery lock is active', () => {
    expect(
      resolveRefreshCapabilitiesGuard({
        interactionLocked: false,
        refreshingCapabilities: false,
        phase: 'ready',
        postAuthRecoveryRefreshLocked: false,
      })
    ).toEqual({
      blocked: false,
      disabled: false,
      statusText: '',
    })
  })
})

describe('shouldIgnorePostAuthAsyncResult', () => {
  it('drops results from stale attempts, unmounted views, or canceled flows', () => {
    expect(
      shouldIgnorePostAuthAsyncResult({
        attemptId: 2,
        currentAttemptId: 3,
        mounted: true,
        cancelRequested: false,
      })
    ).toBe(true)

    expect(
      shouldIgnorePostAuthAsyncResult({
        attemptId: 2,
        currentAttemptId: 2,
        mounted: false,
        cancelRequested: false,
      })
    ).toBe(true)

    expect(
      shouldIgnorePostAuthAsyncResult({
        attemptId: 2,
        currentAttemptId: 2,
        mounted: true,
        cancelRequested: true,
      })
    ).toBe(true)
  })

  it('keeps results from the current mounted uncanceled attempt', () => {
    expect(
      shouldIgnorePostAuthAsyncResult({
        attemptId: 4,
        currentAttemptId: 4,
        mounted: true,
        cancelRequested: false,
      })
    ).toBe(false)
  })
})

describe('shouldReleasePostAuthRecoveryLock', () => {
  it('releases the recovery lock only for the current mounted attempt', () => {
    expect(
      shouldReleasePostAuthRecoveryLock({
        attemptId: 5,
        currentAttemptId: 5,
        mounted: true,
      })
    ).toBe(true)
  })

  it('does not release the recovery lock for stale or unmounted attempts', () => {
    expect(
      shouldReleasePostAuthRecoveryLock({
        attemptId: 5,
        currentAttemptId: 6,
        mounted: true,
      })
    ).toBe(false)

    expect(
      shouldReleasePostAuthRecoveryLock({
        attemptId: 5,
        currentAttemptId: 5,
        mounted: false,
      })
    ).toBe(false)
  })
})

describe('shouldHoldPostAuthRecoveryLockUntilDeferredApply', () => {
  it('holds the recovery lock only while a visible configured view still has deferred post-auth work pending', () => {
    expect(
      shouldHoldPostAuthRecoveryLockUntilDeferredApply({
        postAuthRecoveryLocked: true,
        stayOnConfigured: true,
        shouldQueueDeferredDefaultModelApply: true,
      })
    ).toBe(true)

    expect(
      shouldHoldPostAuthRecoveryLockUntilDeferredApply({
        postAuthRecoveryLocked: false,
        stayOnConfigured: true,
        shouldQueueDeferredDefaultModelApply: true,
      })
    ).toBe(false)
  })

  it('does not hold the recovery lock when the configured view is leaving or no deferred apply is scheduled', () => {
    expect(
      shouldHoldPostAuthRecoveryLockUntilDeferredApply({
        postAuthRecoveryLocked: true,
        stayOnConfigured: false,
        shouldQueueDeferredDefaultModelApply: true,
      })
    ).toBe(false)

    expect(
      shouldHoldPostAuthRecoveryLockUntilDeferredApply({
        postAuthRecoveryLocked: true,
        stayOnConfigured: true,
        shouldQueueDeferredDefaultModelApply: false,
      })
    ).toBe(false)
  })
})

describe('resolvePostAuthRecoveryLockForConfiguredCallback', () => {
  it('forces callback banner suppression to observe an unlocked state once the lock was released before the callback', () => {
    expect(
      resolvePostAuthRecoveryLockForConfiguredCallback({
        postAuthRecoveryLocked: true,
        releasedBeforeCallback: true,
      })
    ).toBe(false)
  })

  it('preserves the current recovery lock when deferred post-auth work still owns the lock', () => {
    expect(
      resolvePostAuthRecoveryLockForConfiguredCallback({
        postAuthRecoveryLocked: true,
        releasedBeforeCallback: false,
      })
    ).toBe(true)

    expect(
      resolvePostAuthRecoveryLockForConfiguredCallback({
        postAuthRecoveryLocked: false,
        releasedBeforeCallback: false,
      })
    ).toBe(false)
  })
})

describe('resolvePostAuthVerificationProfile', () => {
  it('defaults to the legacy profile when no post-auth runtime context exists', () => {
    expect(resolvePostAuthVerificationProfile(undefined)).toBe('default')
  })

  it('reuses the structured post-auth runtime recommendation when provided', () => {
    expect(
      resolvePostAuthVerificationProfile({
        tokenRotated: true,
        gatewayApplyAction: 'restart',
        gatewayConfirmed: true,
        recoveryReason: 'gateway-token-rotated',
        recommendedVerificationProfile: 'post-auth-recovery',
      })
    ).toBe('post-auth-recovery')

    expect(
      resolvePostAuthVerificationProfile({
        tokenRotated: false,
        gatewayApplyAction: 'none',
        gatewayConfirmed: true,
        recoveryReason: 'runtime-stale',
        recommendedVerificationProfile: 'slow-path',
      })
    ).toBe('slow-path')
  })
})

describe('resolveAuthVerificationPollPolicy', () => {
  it('keeps the legacy polling budget for the default profile', () => {
    expect(resolveAuthVerificationPollPolicy('default')).toEqual({
      timeoutMs: 20_000,
      initialIntervalMs: 2_000,
      maxIntervalMs: 4_000,
      backoffFactor: 1.5,
    })
  })

  it('expands only the timeout budget for post-auth recovery and slow-path verification', () => {
    expect(resolveAuthVerificationPollPolicy('post-auth-recovery')).toEqual({
      timeoutMs: 45_000,
      initialIntervalMs: 2_000,
      maxIntervalMs: 4_000,
      backoffFactor: 1.5,
    })

    expect(resolveAuthVerificationPollPolicy('slow-path')).toEqual({
      timeoutMs: 60_000,
      initialIntervalMs: 2_000,
      maxIntervalMs: 4_000,
      backoffFactor: 1.5,
    })
  })
})

describe('resolveControlUiTimeoutProfile', () => {
  it('defaults to the legacy control-ui profile when no post-auth runtime context exists', () => {
    expect(resolveControlUiTimeoutProfile(undefined)).toBe('default')
  })

  it('reuses the structured post-auth runtime recommendation when provided', () => {
    expect(
      resolveControlUiTimeoutProfile({
        recommendedVerificationProfile: 'post-auth-recovery',
      })
    ).toBe('post-auth-recovery')

    expect(
      resolveControlUiTimeoutProfile({
        recommendedVerificationProfile: 'slow-path',
      })
    ).toBe('slow-path')
  })
})

describe('resolveControlUiTimeoutOptions', () => {
  it('keeps the legacy control-ui load/request budgets for the default profile', () => {
    expect(resolveControlUiTimeoutOptions('default')).toEqual({
      loadTimeoutMs: 15_000,
      timeoutMs: 20_000,
    })
  })

  it('expands control-ui budgets for post-auth recovery and slow-path profiles', () => {
    expect(resolveControlUiTimeoutOptions('post-auth-recovery')).toEqual({
      loadTimeoutMs: 30_000,
      timeoutMs: 35_000,
    })

    expect(resolveControlUiTimeoutOptions('slow-path')).toEqual({
      loadTimeoutMs: 30_000,
      timeoutMs: 40_000,
    })
  })
})

describe('formatAuthRegistrySourceLabel', () => {
  it('formats the metadata source for display', () => {
    expect(formatAuthRegistrySourceLabel('openclaw-internal-registry')).toContain('OpenClaw 官方注册表')
    expect(formatAuthRegistrySourceLabel('unsupported-openclaw-layout')).toContain('不受支持')
  })
})

describe('isProviderConfigured', () => {
  it('detects configured provider from auth status', () => {
    const configured = isProviderConfigured(
      {
        auth: {
          providers: [{ provider: 'openai', status: 'ok' }],
        },
      },
      'openai'
    )
    expect(configured).toBe(true)
  })

  it('detects configured provider from allowed model list fallback', () => {
    const configured = isProviderConfigured({ allowed: ['qwen/qwen3-coder'] }, 'qwen')
    expect(configured).toBe(true)
  })

  it('returns false when provider is missing', () => {
    const configured = isProviderConfigured({ auth: { providers: [{ provider: 'openai', status: 'missing' }] } }, 'qwen')
    expect(configured).toBe(false)
  })

  it('supports provider alias matching for oauth auth providers', () => {
    const configured = isProviderConfigured(
      {
        auth: {
          providers: [{ provider: 'openai-codex', status: 'ok' }],
        },
      },
      'openai',
      ['openai-codex']
    )
    expect(configured).toBe(true)
  })

  it('supports provider alias matching for allowed model fallback', () => {
    const configured = isProviderConfigured({ allowed: ['openai-codex/gpt-5'] }, 'openai', ['openai-codex'])
    expect(configured).toBe(true)
  })

  it('does not treat allowed models as auth success during strict post-auth verification', () => {
    const configured = isProviderConfigured(
      {
        allowed: ['openai/gpt-5.4'],
        auth: {
          oauth: {
            providers: [{ provider: 'openai', status: 'missing', profiles: [] }],
          },
        },
      },
      'openai',
      [],
      {
        allowModelListFallback: false,
      }
    )

    expect(configured).toBe(false)
  })

  it('reads provider readiness from auth.oauth.providers when auth.providers is absent', () => {
    const configured = isProviderConfigured(
      {
        auth: {
          oauth: {
            providers: [{ provider: 'openai', status: 'static', profiles: [{ profileId: 'openai:global' }] }],
          },
        },
      },
      'openai',
      [],
      {
        allowModelListFallback: false,
      }
    )

    expect(configured).toBe(true)
  })
})

describe('findConfiguredCustomProviderId', () => {
  it('recognizes custom providers when OpenClaw stores model ids as strings', () => {
    const configuredProviderId = findConfiguredCustomProviderId(
      {
        models: {
          providers: {
            'acme-gateway': {
              baseUrl: 'https://gateway.example.com/v1',
              models: ['acme-chat'],
            },
          },
        },
      },
      {
        baseUrl: 'https://gateway.example.com/v1',
        modelId: 'acme-chat',
        providerId: 'acme-gateway',
        compatibility: 'openai',
      }
    )

    expect(configuredProviderId).toBe('acme-gateway')
  })

  it('recognizes custom providers from flat models config layouts', () => {
    const configuredProviderId = findConfiguredCustomProviderId(
      {
        models: {
          'acme-gateway': {
            baseUrl: 'https://gateway.example.com/v1',
            models: ['acme-chat'],
          },
        },
      },
      {
        baseUrl: 'https://gateway.example.com/v1',
        modelId: 'acme-chat',
        providerId: 'acme-gateway',
        compatibility: 'openai',
      }
    )

    expect(configuredProviderId).toBe('acme-gateway')
  })

  it('recognizes custom providers when model entries are stored as keyed records', () => {
    const configuredProviderId = findConfiguredCustomProviderId(
      {
        models: {
          providers: {
            'acme-gateway': {
              baseUrl: 'https://gateway.example.com/v1',
              models: [{ key: 'acme-gateway/acme-chat' }],
            },
          },
        },
      },
      {
        baseUrl: 'https://gateway.example.com/v1',
        modelId: 'acme-chat',
        providerId: 'acme-gateway',
        compatibility: 'openai',
      }
    )

    expect(configuredProviderId).toBe('acme-gateway')
  })

  it('prefers an explicit custom provider id when multiple providers share the same endpoint and model', () => {
    const configuredProviderId = findConfiguredCustomProviderId(
      {
        models: {
          providers: {
            'acme-gateway-a': {
              baseUrl: 'https://gateway.example.com/v1',
              models: ['acme-chat'],
            },
            'acme-gateway-b': {
              baseUrl: 'https://gateway.example.com/v1',
              models: ['acme-chat'],
            },
          },
        },
      },
      {
        baseUrl: 'https://gateway.example.com/v1',
        modelId: 'acme-chat',
        providerId: 'acme-gateway-b',
        compatibility: 'openai',
      }
    )

    expect(configuredProviderId).toBe('acme-gateway-b')
  })

  it('does not heuristic-match when an explicit custom provider id does not match the configured provider', () => {
    const configuredProviderId = findConfiguredCustomProviderId(
      {
        models: {
          providers: {
            'acme-gateway-a': {
              baseUrl: 'https://gateway.example.com/v1',
              models: ['acme-chat'],
            },
          },
        },
      },
      {
        baseUrl: 'https://gateway.example.com/v1',
        modelId: 'acme-chat',
        providerId: 'acme-gateway-b',
        compatibility: 'openai',
      }
    )

    expect(configuredProviderId).toBe('')
  })

  it('does not guess when multiple custom providers share the same endpoint and model without an explicit provider id', () => {
    const configuredProviderId = findConfiguredCustomProviderId(
      {
        models: {
          providers: {
            'acme-gateway-a': {
              baseUrl: 'https://gateway.example.com/v1',
              models: ['acme-chat'],
            },
            'acme-gateway-b': {
              baseUrl: 'https://gateway.example.com/v1',
              models: ['acme-chat'],
            },
          },
        },
      },
      {
        baseUrl: 'https://gateway.example.com/v1',
        modelId: 'acme-chat',
        compatibility: 'openai',
      }
    )

    expect(configuredProviderId).toBe('')
  })

  it('ignores local custom-openai snapshots when resolving manual custom providers', () => {
    const configuredProviderId = findConfiguredCustomProviderId(
      {
        models: {
          providers: {
            'custom-openai': {
              baseUrl: 'https://gateway.example.com/v1',
              models: ['acme-chat'],
            },
          },
        },
      },
      {
        baseUrl: 'https://gateway.example.com/v1',
        modelId: 'acme-chat',
        compatibility: 'openai',
      }
    )

    expect(configuredProviderId).toBe('')
  })
})

describe('buildVerificationProviderCandidates', () => {
  it('includes both selected provider id and route provider id when they differ', () => {
    const providers = buildProviderOptions(CAPABILITIES)
    const oauthMethod = providers[0]?.methods[1]
    expect(buildVerificationProviderCandidates('openai', oauthMethod)).toEqual(['openai', 'openai-codex'])
  })

  it('preserves cross-provider onboard verification candidates for mixed provider groups', () => {
    expect(
      buildVerificationProviderCandidates('moonshot', {
        route: {
          kind: 'onboard',
          providerId: 'kimi-coding',
          cliFlag: '--kimi-code-api-key',
          requiresSecret: true,
        },
      })
    ).toEqual(['moonshot', 'kimi-coding'])
  })

  it('includes provider aliases for minimax oauth routes', () => {
    const providers = buildProviderOptions(CAPABILITIES)
    const oauthMethod = providers[1]?.methods.find((method) => method.id === 'minimax-portal')
    expect(buildVerificationProviderCandidates('minimax', oauthMethod)).toEqual(['minimax', 'minimax-portal'])
  })
})

describe('resolveProviderVerificationSnapshot', () => {
  it('uses upstream control ui truth first for browser-oauth providers', async () => {
    const getModelStatus = vi.fn(async () => ({
      ok: true,
      data: {
        auth: {
          providers: [{ provider: 'minimax', status: 'ok' }],
        },
      },
    }))

    const result = await resolveProviderVerificationSnapshot(['minimax', 'minimax-portal'], {
      getModelUpstreamState: async () => ({
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
            auth: {
              oauth: {
                providers: [{ provider: 'minimax-portal', status: 'ok' }],
              },
            },
          },
        },
      }),
      getModelStatus,
    })

    expect(result).toEqual({
      configured: true,
      source: 'upstream',
      upstreamUnavailable: false,
    })
    expect(getModelStatus).not.toHaveBeenCalled()
  })

  it('falls back to cli status only when upstream state is unavailable', async () => {
    const getModelStatus = vi.fn(async () => ({
      ok: true,
      data: {
        auth: {
          providers: [{ provider: 'openai-codex', status: 'ok' }],
        },
      },
    }))

    const result = await resolveProviderVerificationSnapshot(['openai', 'openai-codex'], {
      getModelUpstreamState: async () => ({
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
      }),
      getModelStatus,
    })

    expect(result).toEqual({
      configured: true,
      source: 'cli',
      upstreamUnavailable: true,
    })
    expect(getModelStatus).toHaveBeenCalledTimes(1)
  })

  it('accepts runtime-ready model signals for env-backed api-key flows even when auth status is stale', async () => {
    const getModelStatus = vi.fn(async () => ({
      ok: true,
      data: {
        defaultModel: 'zai/glm-5',
        allowed: ['zai/glm-5'],
        auth: {
          providers: [{ provider: 'zai', status: 'missing' }],
        },
      },
    }))

    const result = await resolveProviderVerificationSnapshot(['zai'], {
      getModelUpstreamState: async () => ({
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
            defaultModel: 'zai/glm-5',
            allowed: ['zai/glm-5'],
            auth: {
              providers: [{ provider: 'zai', status: 'missing' }],
            },
          },
        },
      }),
      getModelStatus,
    }, {
      preferRuntimeModelSignals: true,
    })

    expect(result).toEqual({
      configured: true,
      source: 'cli',
      upstreamUnavailable: false,
    })
    expect(getModelStatus).toHaveBeenCalledTimes(1)
  })

  it('falls back to cli auth status when upstream control-ui snapshot is stale for env-backed api-key flows', async () => {
    const getModelStatus = vi.fn(async () => ({
      ok: true,
      data: {
        defaultModel: 'anthropic/claude-opus-4-6',
        allowed: ['minimax-portal/MiniMax-M2.5'],
        auth: {
          providers: [
            {
              provider: 'zai',
              effective: {
                kind: 'env',
                detail: 'env: ZAI_API_KEY',
              },
              env: {
                source: 'env: ZAI_API_KEY',
              },
            },
          ],
          oauth: {
            providers: [{ provider: 'zai', status: 'missing', profiles: [] }],
          },
        },
      },
    }))

    const result = await resolveProviderVerificationSnapshot(['zai'], {
      getModelUpstreamState: async () => ({
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
            defaultModel: 'anthropic/claude-opus-4-6',
            allowed: ['minimax-portal/MiniMax-M2.5'],
            auth: {
              oauth: {
                providers: [{ provider: 'zai', status: 'missing', profiles: [] }],
              },
            },
          },
        },
      }),
      getModelStatus,
    }, {
      preferRuntimeModelSignals: true,
    })

    expect(result).toEqual({
      configured: true,
      source: 'cli',
      upstreamUnavailable: false,
    })
    expect(getModelStatus).toHaveBeenCalledTimes(1)
  })

  it('prefers cli status before upstream inspection for runtime-model api-key verification', async () => {
    const getModelStatus = vi.fn(async () => ({
      ok: true,
      data: {
        defaultModel: 'zai/glm-5',
        allowed: ['zai/glm-5'],
        auth: {
          oauth: {
            providers: [{ provider: 'zai', status: 'missing', profiles: [] }],
          },
        },
      },
    }))
    const getModelUpstreamState = vi.fn(async () => ({
      ok: true,
      source: 'control-ui-app' as const,
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
        source: 'control-ui-app' as const,
        connected: true,
        hasClient: true,
        appKeys: [],
        modelStatusLike: {
          auth: {
            oauth: {
              providers: [{ provider: 'zai', status: 'missing', profiles: [] }],
            },
          },
        },
      },
    }))

    const result = await resolveProviderVerificationSnapshot(
      ['zai'],
      {
        getModelUpstreamState,
        getModelStatus,
      },
      {
        preferRuntimeModelSignals: true,
      }
    )

    expect(result).toEqual({
      configured: true,
      source: 'cli',
      upstreamUnavailable: false,
    })
    expect(getModelStatus).toHaveBeenCalledTimes(1)
    expect(getModelUpstreamState).not.toHaveBeenCalled()
  })
})

describe('resolveBrowserOAuthVerificationSnapshot', () => {
  it('falls back to oauth persistence when upstream state is temporarily unavailable', async () => {
    const checkOAuthComplete = vi.fn(async (providerKey: string) => providerKey === 'minimax-portal')

    const result = await resolveBrowserOAuthVerificationSnapshot(['minimax', 'minimax-portal'], {
      getModelUpstreamState: async () => ({
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
      }),
      checkOAuthComplete,
    })

    expect(result).toEqual({
      configured: true,
      source: 'oauth-persistence',
      upstreamUnavailable: true,
    })
    expect(checkOAuthComplete).toHaveBeenCalledWith('minimax')
    expect(checkOAuthComplete).toHaveBeenCalledWith('minimax-portal')
  })

  it('falls back to oauth persistence when upstream is available but missing matching auth readiness', async () => {
    const checkOAuthComplete = vi.fn(async (providerKey: string) => providerKey === 'openai-codex')

    const result = await resolveBrowserOAuthVerificationSnapshot(['openai', 'openai-codex'], {
      getModelUpstreamState: async () => ({
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
          hasModelCatalogState: true,
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
          },
        },
      }),
      checkOAuthComplete,
    })

    expect(result).toEqual({
      configured: true,
      source: 'oauth-persistence',
      upstreamUnavailable: false,
    })
    expect(checkOAuthComplete).toHaveBeenCalledWith('openai')
    expect(checkOAuthComplete).toHaveBeenCalledWith('openai-codex')
  })

  it('keeps explicit upstream missing auth state authoritative for browser oauth verification', async () => {
    const checkOAuthComplete = vi.fn(async () => true)

    const result = await resolveBrowserOAuthVerificationSnapshot(['openai', 'openai-codex'], {
      getModelUpstreamState: async () => ({
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
            auth: {
              oauth: {
                providers: [{ provider: 'openai-codex', status: 'missing', profiles: [] }],
              },
            },
          },
        },
      }),
      checkOAuthComplete,
    })

    expect(result).toEqual({
      configured: false,
      source: 'upstream',
      upstreamUnavailable: false,
    })
    expect(checkOAuthComplete).not.toHaveBeenCalled()
  })
})

describe('resolveDefaultModelForProviderCandidates', () => {
  it('prefers a matching default model from status before querying the catalog', async () => {
    const getModelStatus = vi.fn(async () => ({
      ok: true,
      data: {
        defaultModel: 'openai/gpt-5.1-codex',
        allowed: ['openai/gpt-4o'],
      },
    }))
    const listCatalog = vi.fn(async () => ({
      total: 1,
      items: [{ key: 'openai/gpt-4.1-mini' }],
    }))

    const resolved = await resolveDefaultModelForProviderCandidates(['openai'], {
      getModelUpstreamState: async () => null,
      getModelStatus,
      listCatalog,
      timeoutMs: 50,
      pageSize: 2,
    })

    expect(resolved).toBe('openai/gpt-5.1-codex')
    expect(listCatalog).not.toHaveBeenCalled()
  })

  it('prefers the 3.22 nested default model from status before querying the catalog', async () => {
    const getModelStatus = vi.fn(async () => ({
      ok: true,
      data: {
        agents: {
          defaults: {
            model: {
              primary: 'openai/gpt-5.1-codex',
            },
          },
        },
        allowed: ['openai/gpt-4o'],
      },
    }))
    const listCatalog = vi.fn(async () => ({
      total: 1,
      items: [{ key: 'openai/gpt-4.1-mini' }],
    }))

    const resolved = await resolveDefaultModelForProviderCandidates(['openai'], {
      getModelUpstreamState: async () => null,
      getModelStatus,
      listCatalog,
      timeoutMs: 50,
      pageSize: 2,
    })

    expect(resolved).toBe('openai/gpt-5.1-codex')
    expect(listCatalog).not.toHaveBeenCalled()
  })

  it('falls back to provider-matching status collections when defaultModel is absent', async () => {
    const listCatalog = vi.fn(async () => ({
      total: 0,
      items: [],
    }))

    const resolved = await resolveDefaultModelForProviderCandidates(['openai'], {
      getModelUpstreamState: async () => null,
      getModelStatus: async () => ({
        ok: true,
        data: {
          allowed: ['anthropic/claude-sonnet-4-6', 'openai/gpt-4o'],
          aliases: {
            coding: 'openai/gpt-5.1-codex',
          },
        },
      }),
      listCatalog,
      timeoutMs: 50,
      pageSize: 2,
    })

    expect(resolved).toBe('openai/gpt-4o')
    expect(listCatalog).not.toHaveBeenCalled()
  })

  it('checks alias provider catalogs when the primary provider catalog has no usable match', async () => {
    const calls: Array<Record<string, unknown>> = []
    const resolved = await resolveDefaultModelForProviderCandidates(['openai'], {
      getModelUpstreamState: async () => null,
      getModelStatus: async () => ({
        ok: false,
        data: null,
      }),
      listCatalog: async (query) => {
        calls.push({ ...(query || {}) })
        if (query?.provider === 'openai') {
          return {
            total: 2,
            items: [
              { key: 'invalid-model-key' },
              { key: 'still-not-a-provider-model' },
            ],
          }
        }
        if (query?.provider === 'openai-codex' && query?.page === 1) {
          return {
            total: 3,
            items: [
              { key: 'not/provider-shaped' },
              { key: 'another-invalid-key' },
            ],
          }
        }
        return {
          total: 3,
          items: [{ key: 'openai-codex/gpt-5.1-codex' }],
        }
      },
      timeoutMs: 50,
      pageSize: 2,
    })

    expect(resolved).toBe('openai-codex/gpt-5.1-codex')
    expect(calls).toEqual([
      { provider: 'openai', includeUnavailable: false, page: 1, pageSize: 2 },
      { provider: 'openai-codex', includeUnavailable: false, page: 1, pageSize: 2 },
      { provider: 'openai-codex', includeUnavailable: false, page: 2, pageSize: 2 },
    ])
  })

  it('returns empty string when neither status nor catalog yields a provider match', async () => {
    const resolved = await resolveDefaultModelForProviderCandidates(['google'], {
      getModelUpstreamState: async () => null,
      getModelStatus: async () => ({
        ok: true,
        data: {
          defaultModel: 'openai/gpt-5.1-codex',
          allowed: ['anthropic/claude-sonnet-4-6'],
        },
      }),
      listCatalog: async () => ({
        total: 1,
        items: [{ key: 'model-without-provider-prefix' }],
      }),
      timeoutMs: 50,
      pageSize: 2,
    })

    expect(resolved).toBe('')
  })

  it('prefers upstream-derived candidate priority over stale local status defaults after oauth success', async () => {
    const getModelStatus = vi.fn(async () => ({
      ok: true,
      data: {
        defaultModel: 'minimax/MiniMax-M2.1',
        allowed: ['minimax/MiniMax-M2.1'],
      },
    }))
    const listCatalog = vi.fn(async () => ({
      total: 1,
      items: [{ key: 'minimax/MiniMax-M2.1' }],
    }))

    const resolved = await resolveDefaultModelForProviderCandidates(['minimax'], {
      getModelUpstreamState: async () => ({
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
          hasModelCatalogState: true,
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
          },
          catalogItemsLike: [
            {
              key: 'minimax/MiniMax-M2.5',
              provider: 'minimax',
              available: true,
            },
          ],
        },
      }),
      getModelStatus,
      listCatalog,
      timeoutMs: 50,
      pageSize: 2,
    })

    expect(resolved).toBe('minimax-portal/MiniMax-M2.5')
    expect(getModelStatus).not.toHaveBeenCalled()
    expect(listCatalog).not.toHaveBeenCalled()
  })

  it('falls back to local status and catalog when upstream candidate data is unavailable', async () => {
    const getModelStatus = vi.fn(async () => ({
      ok: true,
      data: {
        defaultModel: 'openai/gpt-5.1-codex',
      },
    }))

    const resolved = await resolveDefaultModelForProviderCandidates(['openai'], {
      getModelUpstreamState: async () => ({
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
        },
      }),
      getModelStatus,
      listCatalog: async () => ({
        total: 0,
        items: [],
      }),
      timeoutMs: 50,
      pageSize: 2,
    })

    expect(resolved).toBe('openai/gpt-5.1-codex')
    expect(getModelStatus).toHaveBeenCalledTimes(1)
  })

  it('prefers the locally saved provider model over a stale runtime default after api-key setup', async () => {
    const getModelStatus = vi.fn(async () => ({
      ok: true,
      data: {
        defaultModel: 'zai/glm-4.5-flash',
        allowed: ['zai/glm-4.5-flash'],
      },
    }))
    const listCatalog = vi.fn(async () => ({
      total: 1,
      items: [{ key: 'zai/glm-4.5-flash' }],
    }))

    const resolved = await resolveDefaultModelForProviderCandidates(['zai'], {
      getModelUpstreamState: async () => null,
      getModelStatus,
      listCatalog,
      readConfig: async () => ({
        models: {
          providers: {
            zai: {
              models: [
                {
                  id: 'glm-4.6',
                  name: 'glm-4.6',
                },
              ],
            },
          },
        },
      }),
      timeoutMs: 50,
      pageSize: 2,
    } as any)

    expect(resolved).toBe('zai/glm-4.6')
    expect(getModelStatus).not.toHaveBeenCalled()
    expect(listCatalog).not.toHaveBeenCalled()
  })

  it('prefers an explicit configured default model over the first provider-scoped model entry', async () => {
    const getModelStatus = vi.fn(async () => ({
      ok: true,
      data: {
        defaultModel: 'openai/gpt-4o',
      },
    }))
    const listCatalog = vi.fn(async () => ({
      total: 1,
      items: [{ key: 'openai/gpt-4o' }],
    }))

    const resolved = await resolveDefaultModelForProviderCandidates(['openai'], {
      getModelUpstreamState: async () => null,
      getModelStatus,
      listCatalog,
      readConfig: async () => ({
        defaultModel: 'openai/gpt-5.4-pro',
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: 'gpt-4o',
                  name: 'GPT-4o',
                },
                {
                  id: 'gpt-5.4-pro',
                  name: 'GPT-5.4 Pro',
                },
              ],
            },
          },
        },
      }),
      timeoutMs: 50,
      pageSize: 2,
    } as any)

    expect(resolved).toBe('openai/gpt-5.4-pro')
    expect(getModelStatus).not.toHaveBeenCalled()
    expect(listCatalog).not.toHaveBeenCalled()
  })
})

describe('joinModelCenterNonBlockingMessages', () => {
  it('joins non-empty warnings with a stable separator', () => {
    expect(
      joinModelCenterNonBlockingMessages(
        '认证已完成，但默认模型尚未完全生效。',
        '模型信息已保存，但状态刷新失败：timeout'
      )
    ).toBe('认证已完成，但默认模型尚未完全生效。；另外模型信息已保存，但状态刷新失败：timeout')
  })

  it('skips empty warning fragments', () => {
    expect(joinModelCenterNonBlockingMessages('', '模型信息已保存')).toBe('模型信息已保存')
  })
})

describe('classifyModelCenterBannerMessage', () => {
  it('classifies shared raw stderr/stdout failures before falling back to localized copy', () => {
    expect(classifyModelCenterBannerMessage({ stderr: 'connection refused' })).toBe('gateway_unready')
    expect(classifyModelCenterBannerMessage({ stderr: 'fetch failed via proxy timeout' })).toBe('network_blocked')
  })

  it('recognizes existing localized copy so legacy messages still participate in priority checks', () => {
    expect(classifyModelCenterBannerMessage({ message: '网关 token 已变更，请刷新后重新尝试' })).toBe('gateway_unready')
    expect(classifyModelCenterBannerMessage({ message: '网络连接异常，请检查网络或代理配置后重试。' })).toBe(
      'network_blocked'
    )
  })
})

describe('shouldSuppressModelCenterSecondaryNetworkBanner', () => {
  it('suppresses secondary generic network banners when a gateway recovery warning is already primary', () => {
    expect(
      shouldSuppressModelCenterSecondaryNetworkBanner({
        postAuthRecoveryLocked: true,
        primaryMessage: '网关 token 已变更，请刷新后重新尝试',
        candidateStderr: 'fetch failed: proxy timeout',
      })
    ).toBe(true)
  })

  it('does not suppress outside the post-auth recovery window or for non-network candidates', () => {
    expect(
      shouldSuppressModelCenterSecondaryNetworkBanner({
        postAuthRecoveryLocked: false,
        primaryMessage: '网关 token 已变更，请刷新后重新尝试',
        candidateStderr: 'fetch failed: proxy timeout',
      })
    ).toBe(false)

    expect(
      shouldSuppressModelCenterSecondaryNetworkBanner({
        postAuthRecoveryLocked: true,
        primaryMessage: '网关 token 已变更，请刷新后重新尝试',
        candidateMessage: 'API Key 无效、已过期或权限不足，请检查后重试。',
      })
    ).toBe(false)
  })
})

describe('mergeModelCenterNonBlockingMessagesWithPriority', () => {
  it('keeps the primary gateway recovery warning when the candidate is only a secondary network failure', () => {
    expect(
      mergeModelCenterNonBlockingMessagesWithPriority({
        currentMessage: '网关 token 已变更，请刷新后重新尝试',
        candidateMessage: '网络连接异常，请检查网络或代理配置后重试。',
        postAuthRecoveryLocked: true,
      })
    ).toEqual({
      message: '网关 token 已变更，请刷新后重新尝试',
      suppressed: true,
    })
  })

  it('still joins warnings when no suppress rule applies', () => {
    expect(
      mergeModelCenterNonBlockingMessagesWithPriority({
        currentMessage: '认证已完成，但默认模型尚未完全生效。',
        candidateMessage: '模型信息已保存，但状态刷新失败：timeout',
        postAuthRecoveryLocked: true,
      })
    ).toEqual({
      message: '认证已完成，但默认模型尚未完全生效。；另外模型信息已保存，但状态刷新失败：timeout',
      suppressed: false,
    })
  })
})

describe('formatElapsedSeconds', () => {
  it('formats elapsed seconds as mm:ss', () => {
    expect(formatElapsedSeconds(0)).toBe('00:00')
    expect(formatElapsedSeconds(7)).toBe('00:07')
    expect(formatElapsedSeconds(65)).toBe('01:05')
  })
})

describe('capabilities loading helpers', () => {
  it('uses an eased progress curve that keeps moving but does not reach 100 during loading', () => {
    expect(estimateCapabilitiesLoadingProgress(0)).toBe(6)
    expect(estimateCapabilitiesLoadingProgress(1200)).toBeGreaterThan(estimateCapabilitiesLoadingProgress(400))
    expect(estimateCapabilitiesLoadingProgress(60_000)).toBe(95)
  })

  it('switches stage copy as loading progresses', () => {
    expect(buildCapabilitiesLoadingDisplay(0)).toMatchObject({
      progress: 6,
      stageLabel: '连接 OpenClaw',
    })
    expect(buildCapabilitiesLoadingDisplay(2500).stageLabel).toBe('整理认证方式')
    expect(buildCapabilitiesLoadingDisplay(7000).stageLabel).toBe('准备配置界面')
  })
})

describe('buildBusyStateDisplay', () => {
  it('returns oauth-specific message when authing browser method', () => {
    const providers = buildProviderOptions(CAPABILITIES)
    const oauthMethod = providers[0]?.methods[1]
    const display = buildBusyStateDisplay({
      phase: 'authing',
      providerId: 'openai',
      method: oauthMethod,
      elapsedSeconds: 42,
      canceling: false,
    })
    expect(display.title).toContain('浏览器授权登录')
    expect(display.elapsed).toBe('00:42')
  })

  it('returns official auth-route messaging for api-key methods', () => {
    const providers = buildProviderOptions(CAPABILITIES)
    const apiKeyMethod = providers[0]?.methods[0]
    const display = buildBusyStateDisplay({
      phase: 'authing',
      providerId: 'openai',
      method: apiKeyMethod,
      elapsedSeconds: 9,
      canceling: false,
    })

    expect(display.title).toContain('提交认证信息')
    expect(display.detail).toContain('官方认证路由')
  })

  it('returns canceling message when canceling', () => {
    const providers = buildProviderOptions(CAPABILITIES)
    const oauthMethod = providers[0]?.methods[1]
    const display = buildBusyStateDisplay({
      phase: 'verifying',
      providerId: 'openai',
      method: oauthMethod,
      elapsedSeconds: 12,
      canceling: true,
    })
    expect(display.title).toContain('正在取消')
    expect(display.detail).toContain('取消')
  })
})

describe('getLocalDiscoveryDisplay', () => {
  it('prompts the user to fill the endpoint before discovery', () => {
    expect(getLocalDiscoveryDisplay({ testing: false }, false, null, false)).toEqual({
      buttonColor: 'brand',
      message: '填写接口地址后可获取本地模型',
      messageColor: 'dimmed',
    })
  })

  it('shows scanning progress while local model discovery is running', () => {
    expect(getLocalDiscoveryDisplay({ testing: false }, true, null, true)).toEqual({
      buttonColor: 'brand',
      message: '正在扫描模型...',
      messageColor: 'dimmed',
    })
  })

  it('surfaces discovered model counts after a successful scan', () => {
    expect(
      getLocalDiscoveryDisplay(
        { testing: false, result: { ok: true, reachable: true, latencyMs: 32 } },
        false,
        { ok: true, modelCount: 3, models: [{ key: 'ollama/qwen3', name: 'qwen3' }] },
        true
      )
    ).toEqual({
      buttonColor: 'teal',
      message: '连接成功，已发现 3 个本地模型',
      messageColor: 'teal',
    })
  })

  it('surfaces scan failures instead of hiding them in hover state', () => {
    expect(
      getLocalDiscoveryDisplay(
        { testing: false, result: { ok: true, reachable: true } },
        false,
        { ok: false, error: '模型扫描失败' },
        true
      )
    ).toEqual({
      buttonColor: 'red',
      message: '模型扫描失败',
      messageColor: 'red',
    })
  })
})

describe('buildLocalProviderEnvUpdatesForSubmit', () => {
  it('preserves the existing OpenAI key namespace by only persisting baseUrl for custom-openai', () => {
    expect(
      buildLocalProviderEnvUpdatesForSubmit({
        providerId: 'custom-openai',
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: '',
      })
    ).toEqual({
      OPENAI_BASE_URL: 'http://127.0.0.1:1234/v1',
    })
  })

  it('still persists host and key fields for Ollama-style local providers', () => {
    expect(
      buildLocalProviderEnvUpdatesForSubmit({
        providerId: 'ollama',
        baseUrl: '',
        apiKey: '',
      })
    ).toEqual({
      OLLAMA_HOST: 'http://127.0.0.1:11434',
      OLLAMA_API_KEY: undefined,
    })
  })
})

describe('resolveModelCenterProviderDisplayCopy', () => {
  it('clarifies the local custom-openai entry in the provider picker', () => {
    expect(
      resolveModelCenterProviderDisplayCopy({
        providerId: 'custom-openai',
        fallbackName: '自定义 OpenAI 兼容',
      })
    ).toEqual({
      name: '本地 OpenAI 兼容端点',
      hint: '连接 LM Studio、LocalAI 或其他本地 / 自托管 OpenAI 兼容服务。',
    })
  })
})

describe('resolveModelCenterMethodDisplayCopy', () => {
  it('clarifies the custom method label for manual compatible API setup', () => {
    expect(
      resolveModelCenterMethodDisplayCopy({
        providerId: 'custom',
        methodId: 'custom-api-key',
        fallbackLabel: 'Custom Provider',
      })
    ).toEqual({
      label: '手动填写接口信息',
      hint: '填写接口地址、Model ID 和认证信息后，按兼容协议写入 OpenClaw。',
    })
  })
})

describe('phase helpers', () => {
  it('returns ready after cancellation and auth failure', () => {
    expect(getPhaseAfterCancellation()).toBe('ready')
    expect(getPhaseAfterAuthFailure()).toBe('ready')
  })
})

describe('provider config collapse helpers', () => {
  it('defaults provider config section to collapsed', () => {
    expect(DEFAULT_PROVIDER_CONFIG_EXPANDED).toBe(false)
  })

  it('returns accessible toggle labels for collapsed and expanded states', () => {
    expect(getProviderConfigToggleAriaLabel(false)).toBe('展开配置 AI 提供商')
    expect(getProviderConfigToggleAriaLabel(true)).toBe('收起配置 AI 提供商')
  })

  it('always shows provider config content when collapse is disabled', () => {
    expect(shouldRenderProviderConfigContent(false, false)).toBe(true)
    expect(shouldRenderProviderConfigContent(true, false)).toBe(true)
  })

  it('uses expanded state when collapse is enabled', () => {
    expect(shouldRenderProviderConfigContent(false, true)).toBe(false)
    expect(shouldRenderProviderConfigContent(true, true)).toBe(true)
  })
})

describe('setup skip action helpers', () => {
  it('shows skip when models status already has configured providers', () => {
    expect(
      shouldShowSkipButton(
        true,
        {
          auth: {
            providers: [{ provider: 'openai', status: 'ok' }],
          },
        },
        null
      )
    ).toBe(true)
  })

  it('shows skip when openclaw config includes model settings', () => {
    expect(shouldShowSkipButton(true, null, { model: 'openai/gpt-5.1-codex' })).toBe(true)
    expect(shouldShowSkipButton(true, null, { models: { default: 'openai/gpt-5.1-codex' } })).toBe(true)
    expect(
      shouldShowSkipButton(true, null, {
        agents: {
          defaults: {
            model: {
              primary: 'openai/gpt-5.1-codex',
            },
          },
        },
      })
    ).toBe(true)
  })

  it('shows skip when status only exposes the 3.22 nested default model structure', () => {
    expect(
      shouldShowSkipButton(
        true,
        {
          agents: {
            defaults: {
              model: {
                primary: 'openai/gpt-5.1-codex',
              },
            },
          },
        },
        null
      )
    ).toBe(true)
  })

  it('hides skip when feature is disabled or no model config exists', () => {
    expect(shouldShowSkipButton(false, { defaultModel: 'openai/gpt-5.1-codex' }, null)).toBe(false)
    expect(
      shouldShowSkipButton(
        true,
        {
          auth: {
            providers: [{ provider: 'openai', status: 'missing' }],
          },
          allowed: [],
        },
        {}
      )
    ).toBe(false)
  })

  it('builds skip context that bypasses setup initialization', () => {
    expect(buildSkipSetupContext()).toEqual({
      providerId: '',
      methodId: '',
      methodType: 'unknown',
      providerStatusIds: [],
      needsInitialization: false,
    })
  })
})
