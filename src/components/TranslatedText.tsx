import { Text, Tooltip, Skeleton, Group, Badge } from '@mantine/core'
import { useTranslation } from '@/hooks/useTranslation'

interface TranslatedTextProps {
  /** Text to translate */
  text: string
  /** Text size */
  size?: 'xs' | 'sm' | 'md' | 'lg'
  /** Additional class name */
  className?: string
  /** Additional style */
  style?: React.CSSProperties
  /** Enable translation (default: true) */
  enableTranslation?: boolean
  /** Show tooltip with original text when translated */
  showTooltip?: boolean
  /** Show loading skeleton */
  showLoading?: boolean
  /** Text color */
  c?: string
  /** Font weight */
  fw?: number | string
  /** Truncate text */
  truncate?: boolean | 'end' | 'start'
  /** Show translation badge */
  showBadge?: boolean
}

/**
 * Component that displays translated text with optional tooltip showing original text
 */
export function TranslatedText({
  text,
  size = 'sm',
  className,
  style,
  enableTranslation = true,
  showTooltip = true,
  showLoading = true,
  c,
  fw,
  truncate,
  showBadge = false,
}: TranslatedTextProps) {
  const { translated, loading, original, isTranslated } = useTranslation(text, {
    enabled: enableTranslation,
  })

  // Show skeleton while loading
  if (loading && showLoading) {
    return <Skeleton height={16} width="60%" />
  }

  const content = (
    <Text
      size={size}
      className={className}
      style={{
        ...style,
        opacity: loading ? 0.6 : 1,
      }}
      c={c}
      fw={fw}
      truncate={truncate}
    >
      {translated}
      {showBadge && isTranslated && (
        <Badge size="xs" variant="light" color="blue" ml={4}>
          已译
        </Badge>
      )}
    </Text>
  )

  // Show tooltip with original text if translated
  if (showTooltip && isTranslated && translated !== original) {
    return (
      <Tooltip
        label={
          <div>
            <Text size="xs" c="dimmed">
              原文:
            </Text>
            <Text size="xs">{original}</Text>
          </div>
        }
        withArrow
        multiline
        maw={320}
      >
        {content}
      </Tooltip>
    )
  }

  return content
}

interface TranslatedTextWithLabelProps extends TranslatedTextProps {
  /** Label to show before the text */
  label?: string
  /** Label size */
  labelSize?: 'xs' | 'sm' | 'md'
  /** Label color */
  labelC?: string
  /** Label font weight */
  labelFw?: number | string
}

/**
 * Component that displays a label followed by translated text
 */
export function TranslatedTextWithLabel({
  text,
  label,
  labelSize = 'sm',
  labelC = 'dimmed',
  labelFw = 500,
  size = 'sm',
  enableTranslation = true,
  showTooltip = true,
  className,
  style,
}: TranslatedTextWithLabelProps) {
  return (
    <div className={className} style={style}>
      {label && (
        <Text size={labelSize} c={labelC} fw={labelFw} mb={4}>
          {label}
        </Text>
      )}
      <TranslatedText
        text={text}
        size={size}
        enableTranslation={enableTranslation}
        showTooltip={showTooltip}
      />
    </div>
  )
}

/**
 * Component that displays translated text with original in a collapsible section
 */
export function TranslatedTextWithOriginal({
  text,
  size = 'sm',
  enableTranslation = true,
  className,
  style,
}: TranslatedTextProps) {
  const { translated, loading, original, isTranslated } = useTranslation(text, {
    enabled: enableTranslation,
  })

  if (loading) {
    return <Skeleton height={16} width="80%" />
  }

  return (
    <div className={className} style={style}>
      <Text size={size}>{translated}</Text>
      {isTranslated && translated !== original && (
        <Text size="xs" c="dimmed" mt={4}>
          原文: {original}
        </Text>
      )}
    </div>
  )
}
