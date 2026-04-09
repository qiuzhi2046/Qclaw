import { describe, expect, it } from 'vitest'
import { resolveManualInstallCommand } from '../managed-channel-plugin-lifecycle'

describe('resolveManualInstallCommand', () => {
  it('returns the npx installer command for feishu', () => {
    expect(resolveManualInstallCommand('feishu')).toBe('npx -y @larksuite/openclaw-lark-tools install')
  })

  it('returns the npx command for wecom', () => {
    expect(resolveManualInstallCommand('wecom')).toBe('npx @wecom/wecom-openclaw-cli')
  })

  it('returns the plugins install command for dingtalk', () => {
    expect(resolveManualInstallCommand('dingtalk')).toBe('openclaw plugins install @dingtalk-real-ai/dingtalk-connector')
  })

  it('returns the plugins install command for qqbot', () => {
    expect(resolveManualInstallCommand('qqbot')).toBe('openclaw plugins install @tencent-connect/openclaw-qqbot@latest')
  })

  it('returns the npx command for openclaw-weixin', () => {
    expect(resolveManualInstallCommand('openclaw-weixin')).toBe('npx @tencent-weixin/openclaw-weixin-cli@latest')
  })

  it('returns null for unknown channel ids', () => {
    expect(resolveManualInstallCommand('unknown-channel')).toBeNull()
    expect(resolveManualInstallCommand('')).toBeNull()
  })
})
