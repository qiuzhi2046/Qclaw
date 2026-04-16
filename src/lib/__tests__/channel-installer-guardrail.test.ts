import { describe, expect, it } from 'vitest'
import {
  createIdleChannelInstallerGuardrailStatus,
  failChannelInstallerGuardrailStatus,
  mergeChannelInstallerGuardrailStatus,
} from '../../shared/channel-installer-session'
import { resolveChannelInstallerGuardrailView } from '../channel-installer-guardrail'

describe('channel-installer-guardrail', () => {
  it('redacts installer secrets in config preflight failures', () => {
    const view = resolveChannelInstallerGuardrailView(
      failChannelInstallerGuardrailStatus({
        channelId: 'feishu',
        step: 'config',
        code: 'config-reconcile-failed',
        message: '旧配置写入失败 appSecret=abc123 token:xyz authorization_code=code1',
      })
    )

    expect(view?.color).toBe('red')
    expect(view?.title).toBe('旧插件/旧配置预检失败')
    expect(view?.lines.join('\n')).toContain('appSecret=[已隐藏]')
    expect(view?.lines.join('\n')).toContain('token:[已隐藏]')
    expect(view?.lines.join('\n')).toContain('authorization_code=[已隐藏]')
    expect(view?.lines.join('\n')).not.toContain('abc123')
    expect(view?.lines.join('\n')).toContain('避免旧配置或旧插件')
  })

  it('redacts JSON-shaped installer secrets before rendering guardrail errors', () => {
    const view = resolveChannelInstallerGuardrailView(
      failChannelInstallerGuardrailStatus({
        channelId: 'feishu',
        step: 'config',
        code: 'config-reconcile-failed',
        message: '写入失败 {"appSecret":"abc123","token":"tok456","secret":"sec789"}',
      })
    )
    const text = view?.lines.join('\n') || ''

    expect(text).toContain('"appSecret":"[已隐藏]"')
    expect(text).toContain('"token":"[已隐藏]"')
    expect(text).toContain('"secret":"[已隐藏]"')
    expect(text).not.toContain('abc123')
    expect(text).not.toContain('tok456')
    expect(text).not.toContain('sec789')
  })

  it('summarizes running preflight state from structured fields', () => {
    const view = resolveChannelInstallerGuardrailView(
      mergeChannelInstallerGuardrailStatus(
        createIdleChannelInstallerGuardrailStatus('openclaw-weixin'),
        {
          preflight: { state: 'running' },
          environment: { state: 'ok' },
          runtime: { state: 'running', contextResolved: false, platform: 'win32' },
          config: { state: 'not-run' },
        }
      )
    )

    expect(view?.color).toBe('blue')
    expect(view?.title).toBe('正在进行启动前检查')
    expect(view?.lines).toEqual([
      '安装环境：已通过',
      'Windows runtime：进行中',
      '旧插件/旧配置：未开始',
    ])
  })

  it('surfaces managed channel operation locks as busy state', () => {
    const view = resolveChannelInstallerGuardrailView(
      mergeChannelInstallerGuardrailStatus(
        createIdleChannelInstallerGuardrailStatus('feishu'),
        {
          lock: {
            state: 'running',
            key: 'managed-channel-plugin:feishu',
            message: '飞书插件正在修复，请稍后重试。',
          },
        }
      )
    )

    expect(view).toEqual({
      color: 'blue',
      title: '正在处理官方消息渠道插件',
      lines: ['飞书插件正在修复，请稍后重试。'],
    })
  })

  it('redacts secrets from managed channel operation lock messages', () => {
    const view = resolveChannelInstallerGuardrailView(
      mergeChannelInstallerGuardrailStatus(
        createIdleChannelInstallerGuardrailStatus('feishu'),
        {
          lock: {
            state: 'running',
            key: 'managed-channel-plugin:feishu',
            message: '飞书插件正在处理 appSecret=abc123 token:tok456',
          },
        }
      )
    )
    const text = view?.lines.join('\n') || ''

    expect(text).toContain('appSecret=[已隐藏]')
    expect(text).toContain('token:[已隐藏]')
    expect(text).not.toContain('abc123')
    expect(text).not.toContain('tok456')
  })
})
