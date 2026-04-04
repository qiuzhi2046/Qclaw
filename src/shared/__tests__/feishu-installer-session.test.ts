import { describe, expect, it } from 'vitest'

import {
  buildFeishuCreateBotConfirmationMessage,
  isFeishuCreateBotConfirmationPrompt,
  shouldDisableFeishuInstallerManualInput,
  type FeishuInstallerPendingPrompt,
} from '../feishu-installer-session'

function buildPrompt(overrides?: Partial<FeishuInstallerPendingPrompt>): FeishuInstallerPendingPrompt {
  return {
    promptId: 'prompt-1',
    kind: 'useExisting',
    action: 'confirm-create-bot',
    promptType: 'confirm',
    defaultValue: true,
    ...overrides,
  }
}

describe('feishu installer prompt helpers', () => {
  it('identifies the structured create-bot confirmation prompt', () => {
    expect(isFeishuCreateBotConfirmationPrompt(buildPrompt())).toBe(true)
    expect(isFeishuCreateBotConfirmationPrompt(null)).toBe(false)
    expect(
      isFeishuCreateBotConfirmationPrompt(buildPrompt({ action: 'confirm-create-bot', kind: 'useExisting' }))
    ).toBe(true)
    expect(
      isFeishuCreateBotConfirmationPrompt({
        ...buildPrompt(),
        promptType: 'input' as FeishuInstallerPendingPrompt['promptType'],
      })
    ).toBe(false)
  })

  it('blocks manual stdin input whenever a structured prompt is pending', () => {
    expect(shouldDisableFeishuInstallerManualInput(buildPrompt())).toBe(true)
    expect(shouldDisableFeishuInstallerManualInput(null)).toBe(false)
  })

  it('builds a user-facing confirmation message with the detected app id when available', () => {
    expect(buildFeishuCreateBotConfirmationMessage(buildPrompt({ appId: 'cli_existing_bot' }))).toBe('确认新建机器人？')
    expect(buildFeishuCreateBotConfirmationMessage(buildPrompt())).toBe('确认新建机器人？')
  })
})
