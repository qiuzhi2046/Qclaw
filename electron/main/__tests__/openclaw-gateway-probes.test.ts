import { describe, expect, it, vi } from 'vitest'

const { probeWindowsPortOwnerMock } = vi.hoisted(() => ({
  probeWindowsPortOwnerMock: vi.fn(),
}))

vi.mock('../cli', () => ({
  readConfig: vi.fn().mockResolvedValue(null),
  runCli: vi.fn(),
  runShell: vi.fn(),
}))

vi.mock('../platforms/windows/windows-platform-ops', () => ({
  probeWindowsPortOwner: probeWindowsPortOwnerMock,
}))

import { parseLsofPortOwnerOutput, probeGatewayPortOwner } from '../openclaw-gateway-probes'
import { runCli } from '../cli'
import { probeGatewayServiceInstalled } from '../openclaw-gateway-probes'
import { DEFAULT_GATEWAY_PORT, isManagedGatewayPort, resolveGatewayConfiguredPort } from '../../../src/shared/gateway-runtime-state'

describe('openclaw gateway probes', () => {
  it('parses OpenClaw owners from lsof output', () => {
    const owner = parseLsofPortOwnerOutput(
      [
        'COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
        'openclaw 1024 test   21u  IPv4 0x12345678      0t0  TCP 127.0.0.1:18789 (LISTEN)',
      ].join('\n'),
      18789
    )

    expect(owner.kind).toBe('openclaw')
    expect(owner.pid).toBe(1024)
  })

  it('parses foreign owners from lsof output', () => {
    const owner = parseLsofPortOwnerOutput(
      [
        'COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
        'python3  2451 test   23u  IPv4 0x12345678      0t0  TCP 127.0.0.1:18789 (LISTEN)',
      ].join('\n'),
      18789
    )

    expect(owner.kind).toBe('foreign')
    expect(owner.processName).toBe('python3')
  })

  it('returns none when lsof finds no listener', () => {
    const owner = parseLsofPortOwnerOutput(
      'COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
      18789
    )

    expect(owner.kind).toBe('none')
  })

  it('treats both legacy and current service-missing messages as not installed', async () => {
    vi.mocked(runCli)
      .mockResolvedValueOnce({
        ok: false,
        stdout: '',
        stderr: 'Gateway service not loaded.',
        code: 1,
      })
      .mockResolvedValueOnce({
        ok: false,
        stdout: '',
        stderr: 'Gateway service missing.',
        code: 1,
      })

    await expect(probeGatewayServiceInstalled()).resolves.toBe(false)
    await expect(probeGatewayServiceInstalled()).resolves.toBe(false)
  })

  it('treats restart success as service installed', async () => {
    vi.mocked(runCli).mockResolvedValueOnce({
      ok: true,
      stdout: 'restarted',
      stderr: '',
      code: 0,
    })

    await expect(probeGatewayServiceInstalled()).resolves.toBe(true)
  })

  const itOnWindows = process.platform === 'win32' ? it : it.skip

  itOnWindows('routes Windows port ownership probing through windows platform ops', async () => {
    probeWindowsPortOwnerMock.mockResolvedValue({
      kind: 'foreign',
      port: 18789,
      pid: 2451,
      processName: 'python.exe',
      command: 'python.exe -m http.server',
      source: 'powershell',
    })

    await expect(probeGatewayPortOwner(18789)).resolves.toEqual({
      kind: 'foreign',
      port: 18789,
      pid: 2451,
      processName: 'python.exe',
      command: 'python.exe -m http.server',
      source: 'powershell',
    })
    expect(probeWindowsPortOwnerMock).toHaveBeenCalledWith(18789)
  })

  it('resolves the configured gateway port and managed-port policy', () => {
    expect(resolveGatewayConfiguredPort(null)).toBe(DEFAULT_GATEWAY_PORT)
    expect(
      resolveGatewayConfiguredPort({
        gateway: {
          port: '19123',
        },
      })
    ).toBe(19123)
    expect(isManagedGatewayPort(null)).toBe(true)
    expect(
      isManagedGatewayPort({
        gateway: {
          port: 19123,
        },
      })
    ).toBe(false)
  })
})
