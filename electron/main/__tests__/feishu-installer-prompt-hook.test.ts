import { describe, expect, it } from 'vitest'

import { buildFeishuInstallerPromptHookScript } from '../feishu-installer-prompt-hook'

describe('buildFeishuInstallerPromptHookScript', () => {
  it('returns syntactically valid hook code for the useExisting confirm prompt bridge', () => {
    const script = buildFeishuInstallerPromptHookScript()

    expect(script).toContain("question.name === 'useExisting'")
    expect(script).toContain("promptType: 'confirm'")
    expect(script).toContain("message.type === 'prompt-answer'")
    expect(script).toContain("message.type === 'prompt-abort'")
    expect(script).toContain("type: 'auth-result'")
    expect(script).toContain('sendInstallerEvent({')
    expect(script).toContain('QCLAW_FEISHU_DIAG')
    expect(script).toContain('QCLAW_FEISHU_DIAG_LOG_PATH')
    expect(script).toContain("'config-write-start'")
    expect(() => new Function(script)).not.toThrow()
  })
})
