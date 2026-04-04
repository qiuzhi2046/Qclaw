import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  VersionAdapter,
  VersionProbe,
  createVersionAdapter,
  createVersionAdapterWithProbe,
} from '../openclaw-version-adapter'

describe('VersionAdapter', () => {
  describe('createVersionAdapter', () => {
    it('should create adapter for known version', () => {
      const adapter = createVersionAdapter('2026.3.24')
      expect(adapter.getVersion()).toBe('2026.3.24')
      expect(adapter.getStatus()).toBe('supported')
    })

    it('should create adapter for unknown version', () => {
      const adapter = createVersionAdapter('2026.4.1')
      expect(adapter.getVersion()).toBe('2026.4.1')
      expect(adapter.getStatus()).toBe('experimental')
    })

    it('should check capability support', () => {
      const adapter = createVersionAdapter('2026.3.24')
      expect(adapter.isCapabilitySupported('gateway-control')).toBe(true)
      expect(adapter.isCapabilitySupported('env-alias')).toBe(false)
    })

    it('should get capability degrade hint', () => {
      const adapter = createVersionAdapter('2026.3.24')
      expect(adapter.getCapabilityDegradeHint('env-alias')).toBe('3.22+已移除legacy env alias')
      expect(adapter.getCapabilityDegradeHint('gateway-control')).toBeNull()
    })

    it('should get all capabilities', () => {
      const adapter = createVersionAdapter('2026.3.24')
      const capabilities = adapter.getCapabilities()
      expect(capabilities.length).toBeGreaterThan(0)
      expect(capabilities.some(c => c.id === 'gateway-control')).toBe(true)
    })

    it('should get known issues', () => {
      const adapter = createVersionAdapter('2026.4.1')
      const issues = adapter.getKnownIssues()
      expect(issues.length).toBeGreaterThan(0)
    })
  })

  describe('probeCapability', () => {
    it('should probe capability successfully when probe command is configured', async () => {
      // 创建一个带探测命令的适配器
      const adapter = createVersionAdapter('2026.3.24')
      // 手动添加一个带探测命令的功能
      adapter.updateConfig({
        capabilities: [
          { id: 'test-capability', name: 'Test', supported: true, level: 'full', probeCommand: ['test', '--help'] },
        ],
      })
      
      const mockRunCommand = vi.fn().mockResolvedValue({ ok: true, stdout: 'success', stderr: '' })
      
      const result = await adapter.probeCapability('test-capability', mockRunCommand)
      expect(result.ok).toBe(true)
      expect(result.version).toBe('2026.3.24')
    })

    it('should return error when probe command is not configured', async () => {
      const adapter = createVersionAdapter('2026.3.24')
      const mockRunCommand = vi.fn().mockRejectedValue(new Error('Command failed'))
      
      const result = await adapter.probeCapability('gateway-control', mockRunCommand)
      expect(result.ok).toBe(false)
      expect(result.error).toBe('No probe command configured')
    })

    it('should handle probe command failure', async () => {
      const adapter = createVersionAdapter('2026.3.24')
      adapter.updateConfig({
        capabilities: [
          { id: 'test-capability', name: 'Test', supported: true, level: 'full', probeCommand: ['test', '--help'] },
        ],
      })
      
      const mockRunCommand = vi.fn().mockRejectedValue(new Error('Command failed'))
      
      const result = await adapter.probeCapability('test-capability', mockRunCommand)
      expect(result.ok).toBe(false)
      expect(result.error).toBe('Command failed')
    })
  })

  describe('updateConfig', () => {
    it('should update adapter config', () => {
      const adapter = createVersionAdapter('2026.3.24')
      adapter.updateConfig({
        knownIssues: ['Test issue'],
      })
      expect(adapter.getKnownIssues()).toContain('Test issue')
    })
  })

  describe('mergeProbeResults', () => {
    it('should merge probe results', () => {
      const adapter = createVersionAdapter('2026.3.24')
      const probeResults = new Map()
      probeResults.set('gateway-control', {
        ok: true,
        version: '2026.3.24',
        capabilities: [{ id: 'gateway-control', name: 'Gateway Control', supported: true, level: 'full' }],
      })
      
      adapter.mergeProbeResults(probeResults)
      expect(adapter.isCapabilitySupported('gateway-control')).toBe(true)
    })
  })
})

describe('VersionProbe', () => {
  describe('detectVersion', () => {
    it('should detect version from output', async () => {
      const mockRunCommand = vi.fn().mockResolvedValue({
        ok: true,
        stdout: 'openclaw 2026.3.24',
        stderr: '',
      })
      
      const result = await VersionProbe.detectVersion(mockRunCommand)
      expect(result.ok).toBe(true)
      expect(result.version).toBe('2026.3.24')
    })

    it('should handle detection failure', async () => {
      const mockRunCommand = vi.fn().mockResolvedValue({
        ok: false,
        stdout: '',
        stderr: 'Command not found',
      })
      
      const result = await VersionProbe.detectVersion(mockRunCommand)
      expect(result.ok).toBe(false)
      expect(result.error).toBe('Command not found')
    })

    it('should handle exception', async () => {
      const mockRunCommand = vi.fn().mockRejectedValue(new Error('Network error'))
      
      const result = await VersionProbe.detectVersion(mockRunCommand)
      expect(result.ok).toBe(false)
      expect(result.error).toBe('Network error')
    })
  })

  describe('detectCapabilities', () => {
    it('should detect capabilities from help output', async () => {
      const helpOutput = `
Usage: openclaw [command] [options]

Commands:
  gateway    Manage gateway
  models     Manage models
  plugins    Manage plugins
  doctor     Run diagnostics
  onboard    Setup wizard
`
      const mockRunCommand = vi.fn().mockResolvedValue({
        ok: true,
        stdout: helpOutput,
        stderr: '',
      })
      
      const capabilities = await VersionProbe.detectCapabilities(mockRunCommand)
      expect(capabilities.length).toBeGreaterThan(0)
      expect(capabilities.some(c => c.id === 'gateway' && c.supported)).toBe(true)
      expect(capabilities.some(c => c.id === 'models' && c.supported)).toBe(true)
    })
  })
})

describe('createVersionAdapterWithProbe', () => {
  it('should create adapter with probe', async () => {
    const mockRunCommand = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'openclaw 2026.3.24',
        stderr: '',
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'Usage: openclaw [command]',
        stderr: '',
      })
    
    const adapter = await createVersionAdapterWithProbe(mockRunCommand)
    expect(adapter.getVersion()).toBe('2026.3.24')
  })

  it('should fallback to unknown version on probe failure', async () => {
    const mockRunCommand = vi.fn().mockRejectedValue(new Error('Probe failed'))
    
    const adapter = await createVersionAdapterWithProbe(mockRunCommand)
    expect(adapter.getVersion()).toBe('unknown')
    expect(adapter.getStatus()).toBe('experimental')
  })
})
