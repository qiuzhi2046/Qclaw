const ANSI_ESCAPE_SEQUENCE_REGEX =
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-_])/g
const NON_PRINTABLE_EXCEPT_NEWLINES_REGEX = /[\u0000-\u0008\u000B-\u001F\u007F]/g

const API_INVALID_REGEX =
  /\b(invalid api key|api[_ -]?key.+(?:invalid|incorrect|expired)|invalid credentials?|authentication failed|unauthorized|forbidden|status code 401|status code 403|token.+invalid|token mismatch|key.+无效|密钥.+无效)\b/i
const TOKEN_MISMATCH_REGEX = /\b(token mismatch|gateway auth token mismatch|gateway token mismatch)\b/i
const WRITE_FAILURE_REGEX =
  /\b(failed to write|write failed|cannot write|permission denied|operation not permitted|eacces|erofs|read-only file system|no space left on device|disk full|写入失败|保存失败|权限不足)\b/i
const GATEWAY_UNREADY_REGEX =
  /\b(gateway did not become reachable|not become reachable|gateway.+(?:offline|unreachable|not running)|connection refused|econnrefused|websocket.+(?:1006|1008)|gateway closed)\b/i
const NETWORK_BLOCKED_REGEX =
  /\b(timeout|timed out|network|dns|proxy|certificate|tls|ssl|socket hang up|econnreset|enotfound|fetch failed)\b/i

export type SharedCliFailureCode =
  | 'api_invalid'
  | 'write_failure'
  | 'gateway_unready'
  | 'network_blocked'

export function normalizeCliFailureClassificationInput(text: string): string {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(ANSI_ESCAPE_SEQUENCE_REGEX, '')
    .replace(NON_PRINTABLE_EXCEPT_NEWLINES_REGEX, '')
}

export function buildCliFailureClassificationCorpus(...parts: Array<string | undefined>): string {
  return parts
    .map((part) => normalizeCliFailureClassificationInput(String(part || '')).trim())
    .filter(Boolean)
    .join('\n')
}

export function classifySharedCliFailure(corpus: string): SharedCliFailureCode | null {
  const normalized = normalizeCliFailureClassificationInput(corpus).trim()
  if (!normalized) return null

  if (TOKEN_MISMATCH_REGEX.test(normalized)) {
    return 'gateway_unready'
  }
  if (API_INVALID_REGEX.test(normalized)) {
    return 'api_invalid'
  }
  if (WRITE_FAILURE_REGEX.test(normalized)) {
    return 'write_failure'
  }
  if (GATEWAY_UNREADY_REGEX.test(normalized)) {
    return 'gateway_unready'
  }
  if (NETWORK_BLOCKED_REGEX.test(normalized)) {
    return 'network_blocked'
  }

  return null
}
