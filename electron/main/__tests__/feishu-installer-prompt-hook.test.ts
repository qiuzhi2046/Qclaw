import { describe, expect, it } from 'vitest'

import { buildFeishuInstallerPromptHookScript } from '../feishu-installer-prompt-hook'

describe('buildFeishuInstallerPromptHookScript', () => {
  it('returns syntactically valid hook code for the useExisting confirm prompt bridge', () => {
    const script = buildFeishuInstallerPromptHookScript()

    expect(script).toContain("question.name === 'useExisting'")
    expect(script).toContain("promptType: 'confirm'")
    expect(script).toContain("message.type === 'prompt-answer'")
    expect(script).toContain("message.type === 'prompt-abort'")
    expect(() => new Function(script)).not.toThrow()
  })
})
