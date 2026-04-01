import { describe, expect, it } from 'vitest'
import { toUserFacingCliFailureMessage } from '../user-facing-cli-feedback'

describe('user-facing-cli-feedback', () => {
  it('prefers plugin permission diagnostics emitted by the main process marker', () => {
    const message = toUserFacingCliFailureMessage({
      stderr: [
        'QCLAW_PLUGIN_INSTALL_PERMISSION_DENIED',
        '检测到插件安装权限不足。',
        '- ~/.openclaw/extensions: 当前用户不可写',
        'sudo chown -R "$(id -u)":"$(id -g)" ~/.openclaw ~/.npm',
      ].join('\n'),
      fallback: '插件安装失败，请稍后重试。',
    })

    expect(message).toContain('检测到插件安装权限不足')
    expect(message).toContain('~/.openclaw/extensions')
    expect(message).toContain('chown -R')
  })

  it('keeps generic write-permission wording for untagged permission failures', () => {
    const message = toUserFacingCliFailureMessage({
      stderr: 'permission denied: failed to write',
      fallback: 'fallback',
    })

    expect(message).toBe('配置写入失败，请检查本机权限后重试。')
  })

  it('prefers unified permission repair diagnostics emitted by the main process marker', () => {
    const message = toUserFacingCliFailureMessage({
      stderr: [
        'QCLAW_PERMISSION_REPAIR',
        '检测到 OpenClaw 相关目录权限异常。',
        '- ~/.openclaw: owner uid=0',
        '当前故障路径不在 Qclaw 的安全自动修复范围内，请手动修复后重试。',
      ].join('\n'),
      fallback: 'fallback',
    })

    expect(message).toContain('检测到 OpenClaw 相关目录权限异常')
    expect(message).toContain('~/.openclaw')
    expect(message).toContain('安全自动修复范围')
  })

  it('surfaces clawhub resolution failures before falling back to generic network wording', () => {
    const message = toUserFacingCliFailureMessage({
      stderr: 'Resolving clawhub:@tencent-connect/openclaw-qqbot@latest...\nfetch failed',
      fallback: 'fallback',
    })

    expect(message).toBe('插件源解析失败，请稍后重试。若该插件此前已安装，可直接继续绑定渠道。')
  })

  it('surfaces clawhub rate limits instead of the generic fallback', () => {
    const message = toUserFacingCliFailureMessage({
      stderr: 'ClawHub /api/v1/download failed (429): Rate limit exceeded',
      fallback: '安装 Skill 失败，请稍后重试。',
    })

    expect(message).toBe('ClawHub 当前请求过于频繁，已被限流，请稍后再试。')
  })

  it('surfaces OpenClaw config compatibility failures before falling back to generic plugin install wording', () => {
    const message = toUserFacingCliFailureMessage({
      stderr: [
        'Invalid config at ~/.openclaw/openclaw.json:',
        '- channels.openclaw-weixin: unknown channel id: openclaw-weixin',
        'Run: openclaw doctor --fix',
      ].join('\n'),
      fallback: '插件安装失败，请检查网络与权限后重试。',
    })

    expect(message).toBe('当前 OpenClaw 配置与版本契约不兼容，请先执行官方配置修复后重试。')
  })

  it('surfaces missing plugin package failures before falling back to generic install wording', () => {
    const message = toUserFacingCliFailureMessage({
      stderr: [
        'Resolving clawhub:@line/openclaw-line…',
        'Downloading @line/openclaw-line…',
        'Package not found on npm: @line/openclaw-line.',
      ].join('\n'),
      fallback: '插件安装失败，请检查网络与权限后重试。',
    })

    expect(message).toBe('插件包不存在或尚未发布，请确认插件名称正确，或等待对应插件发布后再试。')
  })

  it('surfaces the busy skill mutation hint emitted by the main process marker', () => {
    const message = toUserFacingCliFailureMessage({
      stderr: [
        'QCLAW_SKILL_MUTATION_BUSY',
        '当前正在安装 Skill：token-optimizer',
        '请等待当前 Skill 操作完成，或先取消后再试。',
      ].join('\n'),
      fallback: '安装 Skill 失败，请稍后重试。',
    })

    expect(message).toContain('当前正在安装 Skill：token-optimizer')
    expect(message).toContain('请等待当前 Skill 操作完成')
  })
})
