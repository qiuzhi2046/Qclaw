import type { GatewayRuntimeEvidence } from '../../src/shared/gateway-runtime-state'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

const OPENCLAW_LOG_FILE_PATTERN = /^openclaw-.*\.log$/i
const PLUGIN_LOAD_FAILURE_PATTERN =
  /(?:\[plugins?\].*failed to load|failed to load plugin|plugin not found|failed to load from|manifest invalid|export id)/i
const DEVICE_REQUIRED_PATTERN =
  /(?:cause":"device-required"|device identity required|not[_ -]?paired|pairing auto-approved)/i
const MAX_LOG_CANDIDATES = 4
const MAX_LOG_TAIL_BYTES = 64 * 1024
const MAX_MATCH_LINES = 6

interface GatewayLogSearchOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  tmpDir?: string
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)))
}

function resolveWindowsManagedGatewayLogRoot(env: NodeJS.ProcessEnv): string {
  const userDataDir = String(env.QCLAW_USER_DATA_DIR || '').trim()
  if (!userDataDir) return ''
  return path.win32.join(userDataDir, 'runtime', 'win32', 'logs')
}

export function buildGatewayLogSearchRoots(options: GatewayLogSearchOptions = {}): string[] {
  const platform = options.platform || process.platform
  const env = options.env || process.env
  const tempDir = options.tmpDir || os.tmpdir()
  const filesystemRoot = path.parse(tempDir).root || path.sep

  return uniqueStrings([
    platform === 'win32' ? resolveWindowsManagedGatewayLogRoot(env) : '',
    path.join(filesystemRoot, 'tmp', 'openclaw'),
    path.join(tempDir, 'openclaw'),
  ])
}

async function listGatewayLogCandidates(rootDir: string): Promise<Array<{ filePath: string; mtimeMs: number }>> {
  const entries = await fs.promises.readdir(rootDir, {
    withFileTypes: true,
  }).catch(() => [])

  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && OPENCLAW_LOG_FILE_PATTERN.test(entry.name))
      .map(async (entry) => {
        const filePath = path.join(rootDir, entry.name)
        const stats = await fs.promises.stat(filePath).catch(() => null)
        if (!stats?.isFile()) return null
        return {
          filePath,
          mtimeMs: stats.mtimeMs,
        }
      })
  )

  return candidates.filter((candidate): candidate is { filePath: string; mtimeMs: number } => Boolean(candidate))
}

async function readLogTail(filePath: string): Promise<string> {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const stats = await handle.stat()
    const bytesToRead = Math.min(stats.size, MAX_LOG_TAIL_BYTES)
    const start = Math.max(0, stats.size - bytesToRead)
    const buffer = Buffer.alloc(bytesToRead)
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close().catch(() => {
      // Best effort only.
    })
  }
}

function extractPluginLoadFailureDetail(logText: string): string {
  const matchingLines = String(logText || '')
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line && PLUGIN_LOAD_FAILURE_PATTERN.test(line))

  return matchingLines.slice(-MAX_MATCH_LINES).join('\n').slice(0, 2000)
}

function extractDeviceRequiredDetail(logText: string): string {
  const matchingLines = String(logText || '')
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line && DEVICE_REQUIRED_PATTERN.test(line))

  return matchingLines.slice(-MAX_MATCH_LINES).join('\n').slice(0, 2000)
}

export async function detectGatewayPluginLoadFailureEvidence(
  options: GatewayLogSearchOptions = {}
): Promise<GatewayRuntimeEvidence | null> {
  const candidates = (
    await Promise.all(
      buildGatewayLogSearchRoots(options).map((rootDir) => listGatewayLogCandidates(rootDir))
    )
  )
    .flat()
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, MAX_LOG_CANDIDATES)

  for (const candidate of candidates) {
    const detail = extractPluginLoadFailureDetail(await readLogTail(candidate.filePath).catch(() => ''))
    if (!detail) continue
    return {
      source: 'service',
      message: '网关日志显示扩展插件加载失败',
      detail,
    }
  }

  return null
}

export async function detectGatewayDeviceRequiredEvidence(
  options: GatewayLogSearchOptions = {}
): Promise<GatewayRuntimeEvidence | null> {
  const candidates = (
    await Promise.all(
      buildGatewayLogSearchRoots(options).map((rootDir) => listGatewayLogCandidates(rootDir))
    )
  )
    .flat()
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, MAX_LOG_CANDIDATES)

  for (const candidate of candidates) {
    const detail = extractDeviceRequiredDetail(await readLogTail(candidate.filePath).catch(() => ''))
    if (!detail) continue
    return {
      source: 'service',
      message: '网关日志显示本地设备身份仍在配对，握手尚未就绪',
      detail,
    }
  }

  return null
}
