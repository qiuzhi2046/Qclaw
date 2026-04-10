import type { CliCommandResult } from './openclaw-capabilities'
import { buildGeminiCliMissingMessage } from './openclaw-oauth-dependencies'
import { isConfigWarningLine } from './openclaw-config-warnings'
import {
  classifySharedCliFailure,
  normalizeCliFailureClassificationInput,
} from '../../src/shared/cli-failure-classification'

const BOX_DECORATION_LINE_REGEX = /^[\s│┃┌┐└┘├┤┬┴─╭╮╯╰═◇◆]+$/
const BOX_HEADER_LINE_REGEX = /^[◇◆].*[─╮╯╰]+$/
const OPENCLAW_BANNER_LINE_REGEX = /^🦞\s*OpenClaw\b/i
const SINGLE_CHAR_ARTIFACT_REGEX = /^[A-Za-z0-9.,:;!?-]$/
const GEMINI_CLI_MISSING_REGEX = /gemini cli not found/i
const MULTI_MODEL_FALLBACK_FAILURE_REGEX =
  /\b(all models failed|embedded agent failed before reply|followup agent failed before reply)\b/i
const NOISY_LOG_BLOB_REGEX = /\b(config overwrite|workspace ok|sessions ok|sha256|gateway did not become reachable at ws:)\b/i

function stripCliControlSequences(text: string): string {
  return normalizeCliFailureClassificationInput(text)
}

function unwrapBoxLine(line: string): string {
  return line.replace(/^[│┃]\s*/, '').replace(/\s*[│┃]$/, '').trim()
}

function normalizeCliOutputLines(text: string): string[] {
  return stripCliControlSequences(text)
    .split('\n')
    .map((line) => unwrapBoxLine(line).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((line) => !BOX_DECORATION_LINE_REGEX.test(line))
    .filter((line) => !BOX_HEADER_LINE_REGEX.test(line))
    .filter((line) => !OPENCLAW_BANNER_LINE_REGEX.test(line))
    .filter((line) => line !== '^D')
    .filter((line) => !SINGLE_CHAR_ARTIFACT_REGEX.test(line))
}

function classifyCliFailureOutput(output: string): { message: string; warningOnly: boolean; priority: number } {
  const lines = normalizeCliOutputLines(output)
  if (lines.length === 0) {
    return {
      message: '',
      warningOnly: false,
      priority: 0,
    }
  }

  const actionableLines = lines.filter((line) => !isConfigWarningLine(line))
  const warningOnly = actionableLines.length === 0
  const linesForSelection = warningOnly ? lines : actionableLines

  const combined = linesForSelection.join('\n')
  if (GEMINI_CLI_MISSING_REGEX.test(combined)) {
    return {
      message: buildGeminiCliMissingMessage(),
      warningOnly: false,
      priority: 3,
    }
  }

  const sharedFailureCode = classifySharedCliFailure(combined)
  if (sharedFailureCode) {
    const messageByCode = {
      api_invalid: 'API Key 无效、已过期或权限不足，请检查后重试。',
      write_failure: '配置写入失败，请检查本机权限后重试。',
      gateway_unready: '网关 token 已变更，请刷新后重新尝试',
      network_blocked: '网络连接异常，请检查网络或代理配置后重试。',
    } as const
    return {
      message: messageByCode[sharedFailureCode],
      warningOnly: false,
      priority: 3,
    }
  }

  if (MULTI_MODEL_FALLBACK_FAILURE_REGEX.test(combined)) {
    return {
      message: '当前模型暂时不可用，备用模型也未就绪。请稍后重试，或到模型设置中切换到已配置模型。',
      warningOnly: false,
      priority: 3,
    }
  }

  const explicitErrors = linesForSelection.filter((line) => /^error:/i.test(line))
  if (explicitErrors.length > 0) {
    const candidate = explicitErrors[explicitErrors.length - 1]
    if (NOISY_LOG_BLOB_REGEX.test(candidate) || candidate.length > 220) {
      return {
        message: '',
        warningOnly,
        priority: 0,
      }
    }
    return {
      message: candidate,
      warningOnly,
      priority: 3,
    }
  }

  const actionable = linesForSelection.filter((line) =>
    /\b(failed|not found|requires|unsupported|denied|timeout|timed out|missing|invalid|unavailable|unreachable|offline)\b/i.test(
      line
    )
  )
  if (actionable.length > 0) {
    const candidate = actionable.slice(-2).join('\n')
    if (NOISY_LOG_BLOB_REGEX.test(candidate) || candidate.length > 220) {
      return {
        message: '',
        warningOnly,
        priority: 0,
      }
    }
    return {
      message: candidate,
      warningOnly,
      priority: warningOnly ? 1 : 2,
    }
  }

  return {
    message: '',
    warningOnly,
    priority: 0,
  }
}

export function normalizeCliFailureMessage(output: string): string {
  return classifyCliFailureOutput(output).message
}

export function getCliFailureMessage(
  result: Pick<CliCommandResult, 'stdout' | 'stderr'>,
  fallback: string
): string {
  const stderr = classifyCliFailureOutput(result.stderr || '')
  const stdout = classifyCliFailureOutput(result.stdout || '')

  if (stdout.message && stdout.priority > stderr.priority) return stdout.message
  if (stderr.message) return stderr.message
  if (stdout.message) return stdout.message

  return fallback
}

function extractJsonBlockFromStart(text: string, start: number): string | null {
  const first = text[start]
  if (first !== '{' && first !== '[') return null

  let depth = 0
  let inString = false
  let escapeNext = false

  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escapeNext) {
        escapeNext = false
        continue
      }
      if (char === '\\') {
        escapeNext = true
        continue
      }
      if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') {
      depth += 1
      continue
    }
    if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }

  return null
}

export function extractFirstJsonBlock(output: string): string | null {
  const text = String(output || '').trim()
  if (!text) return null

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char !== '{' && char !== '[') continue
    const block = extractJsonBlockFromStart(text, i)
    if (!block) continue
    try {
      JSON.parse(block)
      return block
    } catch {
      // Continue scanning the next candidate index.
    }
  }

  return null
}

export function parseJsonFromOutput<T>(stdout: string): T {
  const raw = String(stdout || '').trim()
  if (!raw) return {} as T

  try {
    return JSON.parse(raw) as T
  } catch (error) {
    const extracted = extractFirstJsonBlock(raw)
    if (!extracted) throw error
    return JSON.parse(extracted) as T
  }
}

export function parseJsonFromCommandResult<T>(result: {
  stdout?: string
  stderr?: string
}): T {
  const stdout = String(result.stdout || '').trim()
  const stderr = String(result.stderr || '').trim()

  if (stdout) {
    try {
      return parseJsonFromOutput<T>(stdout)
    } catch {
      // Fall through to merged parsing below.
    }
  }

  if (stderr) {
    try {
      return parseJsonFromOutput<T>(stderr)
    } catch {
      // Fall through to merged parsing below.
    }
  }

  return parseJsonFromOutput<T>([stderr, stdout].filter(Boolean).join('\n'))
}
