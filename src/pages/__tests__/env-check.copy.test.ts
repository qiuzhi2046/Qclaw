import { describe, expect, it } from 'vitest'

import envCheckSource from '../EnvCheck.tsx?raw'
import envCheckPolicySource from '../../shared/env-check-policy.ts?raw'
import nodeInstallerIssuesSource from '../../shared/node-installer-issues.ts?raw'

describe('EnvCheck approved copy', () => {
  it('matches the DOCX-approved C-group strings', () => {
    expect(envCheckPolicySource).toContain('安装和配置速度会受到网络和电脑性能影响')
    expect(nodeInstallerIssuesSource).toContain('这台电脑的安全策略阻止了 Node.js 安装。请联系管理员处理，或改为手动安装 Node.js。')
    expect(envCheckSource).toContain('暂时无法获取 Node.js 安装信息，请检查网络后重试。')
    expect(envCheckSource).toContain('自动备份失败')
    expect(envCheckSource).toContain('未能记录手动备份确认，请稍后重试。')
    expect(envCheckSource).toContain('当前没有正在进行的操作。')
    expect(envCheckSource).toContain('OpenClaw 升级失败，请稍后重试。')
    expect(envCheckSource).toContain('OpenClaw 未能正常识别，请重启应用后重试')
    expect(envCheckSource).toContain('已自动隔离异常插件')
    expect(envCheckSource).toContain('插件问题修复失败')
    expect(envCheckSource).not.toContain('系统返回：')
    expect(envCheckSource).not.toContain('setOpenClawUpgradeError(message)')
  })
})
