import type { CliCommandResult } from './openclaw-capabilities'
import { buildGeminiCliMissingMessage } from './openclaw-oauth-dependencies'
import { isConfigWarningLine } from './openclaw-config-warnings'

const ANSI_ESCAPE_SEQUENCE_REGEX =
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-_])/g
const NON_PRINTABLE_EXCEPT_NEWLINES_REGEX = /[\u0000-\u0008\u000B-\u001F\u007F]/g
const BOX_DECORATION_LINE_REGEX = /^[\s│┃┌┐└┘├┤┬┴─╭╮╯╰═◇◆]+$/
const BOX_HEADER_LINE_REGEX = /^[◇◆].*[─╮╯╰]+$/
const OPENCLAW_BANNER_LINE_REGEX = /^🦞\s*OpenClaw\b/i
const SINGLE_CHAR_ARTIFACT_REGEX = /^[A-Za-z0-9.,:;!?-]$/
const GEMINI_CLI_MISSING_REGEX = /gemini cli not found/i
const API_INVALID_REGEX =
  /\b(invalid api key|api[_ -]?key.+(?:invalid|incorrect|expired)|invalid credentials?|authentication failed|unauthorized|forbidden|status code 401|status code 403|token.+invalid|token mismatch|key.+无效|密钥.+无效)\b/i
const WRITE_FAILURE_REGEX =
  /\b(failed to write|write failed|cannot write|permission denied|operation not permitted|eacces|erofs|read-only file system|no space left on device|disk full|写入失败|保存失败|权限不足)\b/i
const GATEWAY_UNREADY_REGEX =
  /\b(gateway did not become reachable|not become reachable|gateway.+(?:offline|unreachable|not running)|connection refused|econnrefused|websocket.+(?:1006|1008)|gateway closed)\b/i
const NETWORK_BLOCKED_REGEX =
  /\b(timeout|timed out|network|dns|proxy|certificate|tls|ssl|socket hang up|econnreset|enotfound|fetch failed)\b/i
const MULTI_MODEL_FALLBACK_FAILURE_REGEX =
  /\b(all models failed|embedded agent failed before reply|followup agent failed before reply)\b/i
const NOISY_LOG_BLOB_REGEX = /\b(config overwrite|workspace ok|sessions ok|sha256|gateway did not become reachable at ws:)\b/i

function stripCliControlSequences(text: string): string {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(ANSI_ESCAPE_SEQUENCE_REGEX, '')
    .replace(NON_PRINTABLE_EXCEPT_NEWLINES_REGEX, '')
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

  if (API_INVALID_REGEX.test(combined)) {
    return {
      message: 'API Key 无效、已过期或权限不足，请检查后重试。',
      warningOnly: false,
      priority: 3,
    }
  }

  if (WRITE_FAILURE_REGEX.test(combined)) {
    return {
      message: '配置写入失败，请检查本机权限后重试。',
      warningOnly: false,
      priority: 3,
    }
  }

  if (GATEWAY_UNREADY_REGEX.test(combined)) {
    return {
      message: '网关尚未就绪，请稍后重试。若持续失败，请重启网关后再试。',
      warningOnly: false,
      priority: 3,
    }
  }

  if (NETWORK_BLOCKED_REGEX.test(combined)) {
    return {
      message: '网络连接异常，请检查网络或代理配置后重试。',
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
