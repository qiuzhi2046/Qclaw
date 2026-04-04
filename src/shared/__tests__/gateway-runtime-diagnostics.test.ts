import { describe, expect, it } from 'vitest'
import { classifyGatewayRuntimeState } from '../gateway-runtime-diagnostics'

describe('classifyGatewayRuntimeState', () => {
  it('classifies service-missing failures', () => {
    const result = classifyGatewayRuntimeState({
      stderr: 'Gateway service not loaded.',
    })

    expect(result.stateCode).toBe('service_missing')
    expect(result.safeToRetry).toBe(true)
  })

  it('classifies token mismatch failures', () => {
    const result = classifyGatewayRuntimeState({
      diagnostics: {
        lastHealth: {
          stderr: 'gateway token mismatch',
        },
      },
    })

    expect(result.stateCode).toBe('token_mismatch')
  })

  it('classifies websocket 1006 failures', () => {
    const result = classifyGatewayRuntimeState({
      stderr: 'WebSocket 1006 abnormal closure',
    })

    expect(result.stateCode).toBe('websocket_1006')
  })

  it('prioritizes config_invalid when the same failure also includes a follow-up websocket 1006 closure', () => {
    const result = classifyGatewayRuntimeState({
      stderr: [
        'Config invalid',
        'File: ~/.openclaw/openclaw.json',
        'Problem:',
        '  - channels.openclaw-weixin: unknown channel id: openclaw-weixin',
        'Run: openclaw doctor --fix',
        '[openclaw] Failed to start CLI: Error: gateway closed (1006 abnormal closure (no close frame)): no close reason',
      ].join('\n'),
    })

    expect(result.stateCode).toBe('config_invalid')
    expect(result.safeToRetry).toBe(false)
  })

  it('does not treat permission failures mentioning openclaw.json as config_invalid', () => {
    const result = classifyGatewayRuntimeState({
      stderr:
        "Failed to read config at /Users/tester/.openclaw/openclaw.json Error: EACCES: permission denied, open '/Users/tester/.openclaw/openclaw.json'",
    })

    expect(result.stateCode).toBe('unknown_runtime_failure')
    expect(result.summary).toContain('权限')
    expect(result.safeToRetry).toBe(false)
  })

  it('preserves upstream control-ui reason details before collapsing to websocket wording', () => {
    const result = classifyGatewayRuntimeState({
      diagnostics: {
        controlUiApp: {
          source: 'control-ui-app',
          connected: false,
          hasClient: true,
          lastError: 'device_token_mismatch',
          appKeys: ['client', 'connected', 'lastError'],
        },
      },
    })

    expect(result.stateCode).toBe('websocket_1006')
    expect(result.summary).toBe('控制界面与本地网关的 device token 不一致')
    expect(result.reasonDetail).toMatchObject({
      source: 'control-ui-app',
      code: 'device_token_mismatch',
    })
    expect(result.evidence.some((item) => item.source === 'control-ui-app')).toBe(true)
  })

  it('downgrades known plugin allowlist warnings to a non-blocking state', () => {
    const result = classifyGatewayRuntimeState({
      stderr:
        'plugins.allow is empty; discovered non-bundled plugins may auto-load: openclaw-lark (/Users/test/.openclaw/extensions/openclaw-lark/index.js). Set plugins.allow to explicit trusted ids.',
    })

    expect(result.stateCode).toBe('plugin_allowlist_warning')
    expect(result.safeToRetry).toBe(true)
  })

  it('reuses nested health summaries for structured state codes', () => {
    const result = classifyGatewayRuntimeState({
      diagnostics: {
        lastHealth: {
          stateCode: 'websocket_1006',
          summary: 'Gateway 与上游的握手连接被异常关闭',
        },
      },
    })

    expect(result.stateCode).toBe('websocket_1006')
    expect(result.summary).toBe('Gateway 与上游的握手连接被异常关闭')
  })

  it('classifies foreign port owners as port_conflict_foreign_process', () => {
    const result = classifyGatewayRuntimeState({
      stderr: 'Port 18789 is already in use',
      portOwner: {
        kind: 'foreign',
        port: 18789,
        processName: 'python3',
        pid: 2451,
        command: 'python3 -m http.server',
        source: 'lsof',
      },
    })

    expect(result.stateCode).toBe('port_conflict_foreign_process')
    expect(result.evidence.some((item) => item.source === 'port-owner')).toBe(true)
  })
})
