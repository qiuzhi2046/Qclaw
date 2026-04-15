import { Alert, Button, Group, Loader, Text, Title } from '@mantine/core'

interface StartupUpdatePromptProps {
  availableVersion?: string | null
  checking?: boolean
  error?: string
  onLater: () => void
  onUpdateNow: () => void
  updating?: boolean
}

export function resolveStartupUpdateVersionLabel(availableVersion?: string | null): string {
  return String(availableVersion || '').trim()
}

export default function StartupUpdatePrompt({
  availableVersion,
  checking = false,
  error = '',
  onLater,
  onUpdateNow,
  updating = false,
}: StartupUpdatePromptProps) {
  const versionLabel = resolveStartupUpdateVersionLabel(availableVersion)

  if (checking) {
    return (
      <div className="flex w-full max-w-md flex-col items-center justify-center gap-4 px-6 py-12 text-center">
        <Loader size="sm" color="orange" />
        <Text size="sm" className="app-text-secondary">
          正在检查 Qclaw 新版本...
        </Text>
      </div>
    )
  }

  return (
    <div className="flex w-full max-w-xl flex-col items-center justify-center px-6 py-12 text-center">
      <Title order={1} className="app-text-primary text-[28px] font-semibold tracking-tight">
        已发现 Qclaw 新版本
      </Title>
      <Text size="xl" mt="xl" className="app-text-muted">
        新版本：{versionLabel || '—'}
      </Text>
      <Group mt={36} gap="md" justify="center">
        <Button
          variant="default"
          size="md"
          radius="md"
          className="min-w-[120px]"
          onClick={onLater}
          disabled={updating}
        >
          稍后再说
        </Button>
        <Button
          size="md"
          radius="md"
          className="min-w-[120px]"
          onClick={onUpdateNow}
          loading={updating}
        >
          立即更新
        </Button>
      </Group>
      {error && (
        <Alert color="red" variant="light" mt="xl" className="w-full text-left">
          <Text size="sm">{error}</Text>
        </Alert>
      )}
    </div>
  )
}
