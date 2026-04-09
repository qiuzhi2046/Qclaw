import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, exposeInMainWorldMock, onMock, removeListenerMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => ({})),
  exposeInMainWorldMock: vi.fn(),
  onMock: vi.fn(),
  removeListenerMock: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: invokeMock,
    on: onMock,
    removeListener: removeListenerMock,
  },
  contextBridge: {
    exposeInMainWorld: exposeInMainWorldMock,
  },
}))

import { api } from './index'

describe('preload api model channels', () => {
  beforeEach(() => {
    invokeMock.mockClear()
    onMock.mockClear()
    removeListenerMock.mockClear()
  })

  it('exposes api to renderer', () => {
    expect(exposeInMainWorldMock).toHaveBeenCalledWith('api', api)
    expect('gatewayStart' in api).toBe(false)
    expect('gatewayRestart' in api).toBe(false)
    expect('writeConfig' in api).toBe(false)
    expect('writeEnvFile' in api).toBe(false)
  })

  it('maps new model APIs to expected IPC channels', async () => {
    await api.quitApp()
    expect(invokeMock).toHaveBeenLastCalledWith('app:quit')

    await api.getOpenClawPaths()
    expect(invokeMock).toHaveBeenLastCalledWith('paths:openclaw:get')

    await api.getOpenClawRuntimeReconcileState()
    expect(invokeMock).toHaveBeenLastCalledWith('gateway:runtime-reconcile:state:get')

    await api.resolveNodeInstallPlan()
    expect(invokeMock).toHaveBeenLastCalledWith('env:resolveNodeInstallPlan')

    await api.inspectNodeInstaller('/tmp/node-v22.pkg')
    expect(invokeMock).toHaveBeenLastCalledWith('env:inspectNodeInstaller', '/tmp/node-v22.pkg')

    await api.getOpenClawDataGuard()
    expect(invokeMock).toHaveBeenLastCalledWith('openclaw:data-guard:get', undefined)

    await api.prepareManagedOpenClawConfigWrite()
    expect(invokeMock).toHaveBeenLastCalledWith('openclaw:config:prepare', undefined)

    await api.writeConfigGuarded({
      config: {
        providers: {
          openai: {
            apiKey: 'sk-test',
          },
        },
      },
      reason: 'unknown',
    })
    expect(invokeMock).toHaveBeenLastCalledWith('openclaw:config:guarded-write', {
      config: {
        providers: {
          openai: {
            apiKey: 'sk-test',
          },
        },
      },
      reason: 'unknown',
    }, undefined)

    await api.applyConfigPatchGuarded({
      beforeConfig: {
        channels: {
          feishu: { enabled: true },
        },
      },
      afterConfig: {
        channels: {},
      },
      reason: 'channels-remove-channel',
    })
    expect(invokeMock).toHaveBeenLastCalledWith('openclaw:config:apply-patch', {
      beforeConfig: {
        channels: {
          feishu: { enabled: true },
        },
      },
      afterConfig: {
        channels: {},
      },
      reason: 'channels-remove-channel',
    }, undefined)

    await api.getOpenClawOwnership('fingerprint-1')
    expect(invokeMock).toHaveBeenLastCalledWith('openclaw:ownership:get', 'fingerprint-1')

    await api.listOpenClawOwnershipChanges('fingerprint-1')
    expect(invokeMock).toHaveBeenLastCalledWith('openclaw:ownership:list-changes', 'fingerprint-1')

    await api.previewOpenClawCleanup({
      actionType: 'remove-openclaw',
      backupBeforeDelete: true,
    })
    expect(invokeMock).toHaveBeenLastCalledWith('openclaw:cleanup:preview', {
      actionType: 'remove-openclaw',
      backupBeforeDelete: true,
    })

    await api.runOpenClawCleanup({
      actionType: 'remove-openclaw',
      backupBeforeDelete: false,
    })
    expect(invokeMock).toHaveBeenLastCalledWith('openclaw:cleanup:run', {
      actionType: 'remove-openclaw',
      backupBeforeDelete: false,
    })

    await api.listOpenClawBackups()
    expect(invokeMock).toHaveBeenLastCalledWith('openclaw:backup:list')

    await api.getOpenClawBackupRoot()
    expect(invokeMock).toHaveBeenLastCalledWith('openclaw:backup:get-root')

    await api.runOpenClawManualBackup()
    expect(invokeMock).toHaveBeenLastCalledWith('openclaw:backup:run-manual')

    await api.previewOpenClawRestore('backup-1')
    expect(invokeMock).toHaveBeenLastCalledWith('openclaw:restore:preview', 'backup-1')

    await api.runOpenClawRestore('backup-1', 'config')
    expect(invokeMock).toHaveBeenLastCalledWith('openclaw:restore:run', 'backup-1', 'config')

    await api.checkOpenClawUpgrade()
    expect(invokeMock).toHaveBeenLastCalledWith('openclaw:upgrade:check')

    await api.runOpenClawUpgrade()
    expect(invokeMock).toHaveBeenLastCalledWith('openclaw:upgrade:run')

    await api.getQClawUpdateStatus()
    expect(invokeMock).toHaveBeenLastCalledWith('qclaw:update:status')

    await api.checkQClawUpdate()
    expect(invokeMock).toHaveBeenLastCalledWith('qclaw:update:check')

    await api.downloadQClawUpdate()
    expect(invokeMock).toHaveBeenLastCalledWith('qclaw:update:download')

    await api.installQClawUpdate()
    expect(invokeMock).toHaveBeenLastCalledWith('qclaw:update:install')

    await api.openQClawUpdateDownloadUrl()
    expect(invokeMock).toHaveBeenLastCalledWith('qclaw:update:open-download-url')

    await api.checkCombinedUpdate()
    expect(invokeMock).toHaveBeenLastCalledWith('combined:update:check')

    await api.runCombinedUpdate()
    expect(invokeMock).toHaveBeenLastCalledWith('combined:update:run')

    await api.getModelCapabilities()
    expect(invokeMock).toHaveBeenLastCalledWith('models:capabilities:get')

    await api.listModelCatalog({ provider: 'openai', search: 'gpt' })
    expect(invokeMock).toHaveBeenLastCalledWith('models:catalog:list', {
      provider: 'openai',
      search: 'gpt',
    })

    await api.getModelStatus({ probe: true })
    expect(invokeMock).toHaveBeenLastCalledWith('models:status:get', { probe: true })

    await api.getModelUpstreamState()
    expect(invokeMock).toHaveBeenLastCalledWith('models:upstream-state:get')

    await api.syncModelVerificationState({
      statusData: {
        allowed: ['openai/gpt-5.4-pro'],
      },
    })
    expect(invokeMock).toHaveBeenLastCalledWith('models:verification:sync', {
      statusData: {
        allowed: ['openai/gpt-5.4-pro'],
      },
    })

    await api.recordModelVerification({
      modelKey: 'openai/gpt-4.1',
      verificationState: 'verified-unavailable',
    })
    expect(invokeMock).toHaveBeenLastCalledWith('models:verification:record', {
      modelKey: 'openai/gpt-4.1',
      verificationState: 'verified-unavailable',
    })

    await api.applyModelConfigViaUpstream({ kind: 'default', model: 'openai/gpt-5.4-pro' })
    expect(invokeMock).toHaveBeenLastCalledWith('models:upstream-write:apply', {
      kind: 'default',
      model: 'openai/gpt-5.4-pro',
    })

    await api.patchChatSessionModel({ sessionId: 'session-1', model: 'openai/gpt-5.4-pro' })
    expect(invokeMock).toHaveBeenLastCalledWith('chat:session:model:patch', {
      sessionId: 'session-1',
      model: 'openai/gpt-5.4-pro',
    })

    await api.createLocalChatSession()
    expect(invokeMock).toHaveBeenLastCalledWith('chat:session:create:local')

    await api.getChatCapabilitySnapshot()
    expect(invokeMock).toHaveBeenLastCalledWith('chat:capabilities:get')

    await api.getChatSessionDebugSnapshot('session-1')
    expect(invokeMock).toHaveBeenLastCalledWith('chat:debug-snapshot:get', 'session-1')

    await api.listChatTraceEntries(25)
    expect(invokeMock).toHaveBeenLastCalledWith('chat:trace:list', 25)

    await api.validateProviderCredential({
      providerId: 'openai',
      methodId: 'openai-api-key',
      secret: 'sk-test',
    })
    expect(invokeMock).toHaveBeenLastCalledWith('models:provider:validate', {
      providerId: 'openai',
      methodId: 'openai-api-key',
      secret: 'sk-test',
    })

    await api.applyModelConfig({ kind: 'alias-list' })
    expect(invokeMock).toHaveBeenLastCalledWith('models:config:apply', { kind: 'alias-list' })

    await api.runModelAuth({ kind: 'login', providerId: 'openai', methodId: 'openai-codex' })
    expect(invokeMock).toHaveBeenLastCalledWith('models:auth:run', {
      kind: 'login',
      providerId: 'openai',
      methodId: 'openai-codex',
    })

    await api.appendModelAuthDiagnosticLog({
      source: 'renderer:test',
      event: 'sample',
      providerId: 'zai',
    })
    expect(invokeMock).toHaveBeenLastCalledWith('model-auth:diagnostic:append', {
      source: 'renderer:test',
      event: 'sample',
      providerId: 'zai',
    })

    await api.refreshModelData({
      catalogQuery: { provider: 'openai' },
      statusOptions: { probe: true },
    })
    expect(invokeMock).toHaveBeenLastCalledWith('models:refresh', {
      catalogQuery: { provider: 'openai' },
      statusOptions: { probe: true },
    })

    await api.getLatestOAuthUrl()
    expect(invokeMock).toHaveBeenLastCalledWith('oauth:latest-url:get')

    await api.openOAuthUrl('https://auth.openai.com/oauth/authorize?state=manual')
    expect(invokeMock).toHaveBeenLastCalledWith('oauth:url:open', 'https://auth.openai.com/oauth/authorize?state=manual')

    await api.inspectOAuthDependency('google-gemini-cli')
    expect(invokeMock).toHaveBeenLastCalledWith('oauth:dependency:inspect', 'google-gemini-cli')

    await api.installOAuthDependency({ dependencyId: 'gemini-cli', method: 'brew' })
    expect(invokeMock).toHaveBeenLastCalledWith('oauth:dependency:install', {
      dependencyId: 'gemini-cli',
      method: 'brew',
    })

    await api.clearModelAuthProfiles({
      providerIds: ['openai', 'openai-codex'],
      authStorePath: '/tmp/openclaw/agents/main/agent/auth-profiles.json',
    })
    expect(invokeMock).toHaveBeenLastCalledWith('local-models:clear-auth-profiles', {
      providerIds: ['openai', 'openai-codex'],
      authStorePath: '/tmp/openclaw/agents/main/agent/auth-profiles.json',
    })

    await api.inspectModelAuthProfiles({
      providerIds: ['openai', 'openai-codex'],
      authStorePath: '/tmp/openclaw/agents/main/agent/auth-profiles.json',
    })
    expect(invokeMock).toHaveBeenLastCalledWith('local-models:inspect-auth-profiles', {
      providerIds: ['openai', 'openai-codex'],
      authStorePath: '/tmp/openclaw/agents/main/agent/auth-profiles.json',
    })

    await api.clearExternalProviderAuth({
      providerIds: ['openai', 'openai-codex'],
    })
    expect(invokeMock).toHaveBeenLastCalledWith('local-models:clear-external-auth', {
      providerIds: ['openai', 'openai-codex'],
    })

    await api.ensureGatewayRunning()
    expect(invokeMock).toHaveBeenLastCalledWith('gateway:ensure-running', undefined)

    await api.ensureGatewayRunning({ skipRuntimePrecheck: true, requestId: 'req-bootstrap-1' })
    expect(invokeMock).toHaveBeenLastCalledWith('gateway:ensure-running', {
      skipRuntimePrecheck: true,
      requestId: 'req-bootstrap-1',
    })

    await api.reloadGatewayAfterModelChange()
    expect(invokeMock).toHaveBeenLastCalledWith('gateway:reload-after-model-change')

    await api.reloadGatewayAfterChannelChange()
    expect(invokeMock).toHaveBeenLastCalledWith('gateway:reload-after-channel-change')

    await api.reloadGatewayManual()
    expect(invokeMock).toHaveBeenLastCalledWith('gateway:reload-manual')

    await api.getFeishuInstallerState()
    expect(invokeMock).toHaveBeenLastCalledWith('feishu:installer:state:get')

    await api.getFeishuOfficialPluginState()
    expect(invokeMock).toHaveBeenLastCalledWith('plugins:feishu-state')

    await api.ensureFeishuOfficialPluginReady()
    expect(invokeMock).toHaveBeenLastCalledWith('plugins:feishu-ensure-ready')

    await api.listenFeishuBotDiagnosticActivity('default', 45000, 'listen-1')
    expect(invokeMock).toHaveBeenLastCalledWith('feishu:diagnostics:listen', 'default', 45000, 'listen-1')

    await api.cancelFeishuBotDiagnosticListen('listen-1')
    expect(invokeMock).toHaveBeenLastCalledWith('feishu:diagnostics:cancel-listen', 'listen-1')

    await api.sendFeishuDiagnosticMessage({
      accountId: 'default',
      openId: 'ou_123',
      recipientName: 'Alice',
      botLabel: '默认 Bot',
    })
    expect(invokeMock).toHaveBeenLastCalledWith('feishu:diagnostics:send', {
      accountId: 'default',
      openId: 'ou_123',
      recipientName: 'Alice',
      botLabel: '默认 Bot',
    })

    await api.isPluginInstalledOnDisk('openclaw-qqbot')
    expect(invokeMock).toHaveBeenLastCalledWith('plugins:installed-on-disk', 'openclaw-qqbot')

    await api.uninstallPlugin('qqbot')
    expect(invokeMock).toHaveBeenLastCalledWith('plugins:uninstall', 'qqbot')

    await api.startFeishuInstaller()
    expect(invokeMock).toHaveBeenLastCalledWith('feishu:installer:start')

    await api.sendFeishuInstallerInput('session-1', '\n')
    expect(invokeMock).toHaveBeenLastCalledWith('feishu:installer:input', 'session-1', '\n')

    await api.answerFeishuInstallerPrompt('session-1', 'prompt-1', 'confirm')
    expect(invokeMock).toHaveBeenLastCalledWith('feishu:installer:prompt:answer', 'session-1', 'prompt-1', 'confirm')

    await api.stopFeishuInstaller()
    expect(invokeMock).toHaveBeenLastCalledWith('feishu:installer:stop')

    await api.validateFeishuCredentials('cli_test', 'secret', 'feishu')
    expect(invokeMock).toHaveBeenLastCalledWith('feishu:credentials:validate', 'cli_test', 'secret', 'feishu')

    await api.cancelChatMessage()
    expect(invokeMock).toHaveBeenLastCalledWith('chat:cancel')

    await api.cancelCommand()
    expect(invokeMock).toHaveBeenLastCalledWith('command:cancel')

    await api.cancelCommandDetailed()
    expect(invokeMock).toHaveBeenLastCalledWith('command:cancel-detailed')

    await api.cancelCommandDomain('oauth')
    expect(invokeMock).toHaveBeenLastCalledWith('command:cancel-domain', 'oauth')

    await api.cancelCommands(['chat', 'oauth'])
    expect(invokeMock).toHaveBeenLastCalledWith('command:cancel-batch', ['chat', 'oauth'])
  })

  it('exposes model oauth start/cancel commands, chat events, and oauth event subscriptions', async () => {
    const offChat = api.onChatStream(() => {})
    expect(onMock).toHaveBeenCalledWith('chat:stream', expect.any(Function))

    const offGatewayBootstrap = api.onGatewayBootstrapState(() => {})
    expect(onMock).toHaveBeenCalledWith('gateway:bootstrap:state', expect.any(Function))

    const offFeishuInstaller = api.onFeishuInstallerEvent(() => {})
    expect(onMock).toHaveBeenCalledWith('feishu:installer:event', expect.any(Function))

    const offState = api.onOAuthState(() => {})
    expect(onMock).toHaveBeenCalledWith('oauth:state', expect.any(Function))

    const offCode = api.onOAuthCode(() => {})
    expect(onMock).toHaveBeenCalledWith('oauth:code', expect.any(Function))

    const offSuccess = api.onOAuthSuccess(() => {})
    expect(onMock).toHaveBeenCalledWith('oauth:success', expect.any(Function))

    const offError = api.onOAuthError(() => {})
    expect(onMock).toHaveBeenCalledWith('oauth:error', expect.any(Function))

    offChat()
    offGatewayBootstrap()
    offFeishuInstaller()
    offState()
    offCode()
    offSuccess()
    offError()
    expect(removeListenerMock).toHaveBeenCalledTimes(7)

    await api.startModelOAuth({ providerId: 'qwen', methodId: 'qwen-portal', setDefault: true })
    expect(invokeMock).toHaveBeenLastCalledWith('models:oauth:start', {
      providerId: 'qwen',
      methodId: 'qwen-portal',
      setDefault: true,
    })

    await api.cancelModelOAuth()
    expect(invokeMock).toHaveBeenLastCalledWith('models:oauth:cancel')
  })
})
