import { describe, expect, it } from 'vitest'

import openClawClassifySource from '../OpenClawClassify.tsx?raw'

describe('OpenClawClassify approved copy', () => {
  it('matches the approved DOCX copy for setup and fallback branches', () => {
    expect(openClawClassifySource).toContain('这台电脑上已经安装了 OpenClaw，下一步将进入配置向导。')
    expect(openClawClassifySource).toContain('保留当前版本，可以先进入控制面板查看和使用，稍后再决定是否升级。')
    expect(openClawClassifySource).toContain('目前暂时无法确认最新版本，可能是网络连接异常。可以先进入控制面板，后续再检查更新。')
    expect(openClawClassifySource).toContain('当前状态不影响继续使用，可以先进入控制面板，后续再处理升级或修复。')
    expect(openClawClassifySource).toContain('下一步')
  })
})
