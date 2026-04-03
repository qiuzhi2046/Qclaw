export type FeishuInstallerPendingPromptKind = 'useExisting'
export type FeishuInstallerPendingPromptAction = 'confirm-create-bot'

export interface FeishuInstallerPendingPrompt {
  promptId: string
  kind: FeishuInstallerPendingPromptKind
  action: FeishuInstallerPendingPromptAction
  promptType: 'confirm'
  appId?: string
  defaultValue?: boolean | null
}

export type FeishuInstallerPromptResolution = 'confirm' | 'cancel'

export function isFeishuCreateBotConfirmationPrompt(
  prompt: FeishuInstallerPendingPrompt | null | undefined
): prompt is FeishuInstallerPendingPrompt {
  return Boolean(
    prompt
    && prompt.kind === 'useExisting'
    && prompt.action === 'confirm-create-bot'
    && prompt.promptType === 'confirm'
  )
}

export function shouldDisableFeishuInstallerManualInput(
  prompt: FeishuInstallerPendingPrompt | null | undefined
): boolean {
  return Boolean(prompt)
}

export function buildFeishuCreateBotConfirmationMessage(
  prompt: FeishuInstallerPendingPrompt | null | undefined
): string {
  void prompt
  return '确认新建机器人？'
}
