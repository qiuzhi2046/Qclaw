import { readConfig, runCli, runShell, type CliResult } from './cli'
import { getSelectedWindowsActiveRuntimeSnapshot } from './windows-active-runtime'
import { classifyGatewayRuntimeState } from '../../src/shared/gateway-runtime-diagnostics'
import {
  DEFAULT_GATEWAY_PORT,
  type GatewayPortOwner,
  type GatewayPortOwnerKind,
  type GatewayRuntimeStateCode,
  resolveGatewayConfiguredPort,
} from '../../src/shared/gateway-runtime-state'
import { probeWindowsPortOwner } from './platforms/windows/windows-platform-ops'

const { createServer } = process.getBuiltinModule('node:net') as typeof import('node:net')
const GATEWAY_SERVICE_NOT_LOADED_PATTERN = /\bgateway service (?:not loaded|missing)\b/i

export interface GatewayHealthProbeResult extends CliResult {
  stateCode: GatewayRuntimeStateCode
  summary: string
}

function resolvePortOwnerKind(processName: string, command: string): GatewayPortOwnerKind {
  const corpus = `${processName}\n${command}`.toLowerCase()
  if (/\bopenclaw\b/.test(corpus)) return 'openclaw'
  if (/\bgateway\b/.test(corpus)) return 'gateway'
  return 'foreign'
}

export function parseLsofPortOwnerOutput(stdout: string, port: number): GatewayPortOwner {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length <= 1) {
    return {
      kind: 'none',
      port,
      source: 'lsof',
    }
  }

  for (const line of lines.slice(1)) {
    if (!line.includes(`:${port}`)) continue
    const parts = line.split(/\s+/)
    const processName = String(parts[0] || '').trim()
    const pid = Number.parseInt(String(parts[1] || ''), 10)
    if (!processName) continue
    return {
      kind: resolvePortOwnerKind(processName, line),
      port,
      pid: Number.isFinite(pid) ? pid : null,
      processName,
      command: line,
      source: 'lsof',
    }
  }

  return {
    kind: 'unknown',
    port,
    source: 'lsof',
    command: lines.slice(1).join('\n'),
  }
}

export async function probeGatewayServiceInstalled(): Promise<boolean> {
  const result = await runCli(['gateway', 'restart'], undefined, 'gateway')
  return !GATEWAY_SERVICE_NOT_LOADED_PATTERN.test(`${result.stderr}\n${result.stdout}`)
}

export async function probeGatewayHealthRaw(): Promise<GatewayHealthProbeResult> {
  const result = await runCli(['health', '--json'], undefined, 'gateway', {
    activeRuntimeSnapshot: getSelectedWindowsActiveRuntimeSnapshot() || undefined,
    skipConfigRepairPreflight: true,
    skipPermissionAutoRepair: true,
  })
  const classification = classifyGatewayRuntimeState(result)
  return {
    ...result,
    stateCode: classification.stateCode,
    summary: classification.summary,
  }
}

export async function probeGatewayPortOwner(port = DEFAULT_GATEWAY_PORT): Promise<GatewayPortOwner> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return {
      kind: 'unknown',
      port,
      source: 'unknown',
    }
  }

  if (process.platform === 'win32') {
    return probeWindowsPortOwner(port)
  }

  const result = await runShell('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], undefined, 'gateway')
  if (!result.ok && !String(result.stdout || '').trim() && !String(result.stderr || '').trim()) {
    return {
      kind: 'none',
      port,
      source: 'lsof',
    }
  }

  if (/not found|command not found/i.test(String(result.stderr || ''))) {
    return {
      kind: 'unknown',
      port,
      source: 'unknown',
      command: String(result.stderr || '').trim(),
    }
  }

  return parseLsofPortOwnerOutput(result.stdout, port)
}

export async function probeGatewayTokenFromConfig(): Promise<string | null> {
  const config = await readConfig().catch(() => null)
  const token = String(config?.gateway?.auth?.token || '').trim()
  return token || null
}

export async function findAvailableLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a loopback port')))
        return
      }
      const port = address.port
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

export async function readConfiguredGatewayPort(): Promise<number> {
  const config = await readConfig().catch(() => null)
  return resolveGatewayConfiguredPort(config)
}
