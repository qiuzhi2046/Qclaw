/**
 * OpenClaw 版本适配层
 * 
 * 设计目标：
 * 1. 解耦版本号与功能支持，通过能力探测而非硬编码版本号
 * 2. 支持动态功能发现，自动适应新版本
 * 3. 提供优雅降级策略，未知版本不再完全限制功能
 */

// ==================== 类型定义 ====================

export type VersionAdapterStatus = 
  | 'supported'      // 完全支持
  | 'degraded'       // 降级支持（部分功能受限）
  | 'experimental'   // 实验性支持（未测试但尝试工作）
  | 'unsupported'    // 不支持（已知不兼容）

export interface VersionCapability {
  /** 功能ID */
  id: string
  /** 功能名称 */
  name: string
  /** 是否支持 */
  supported: boolean
  /** 支持程度 */
  level: 'full' | 'partial' | 'none'
  /** 降级提示（如果不完全支持） */
  degradeHint?: string
  /** 探测命令（可选，用于动态探测） */
  probeCommand?: string[]
}

export interface VersionAdapterConfig {
  /** 版本号 */
  version: string
  /** 适配器状态 */
  status: VersionAdapterStatus
  /** 支持的功能列表 */
  capabilities: VersionCapability[]
  /** 已知问题 */
  knownIssues?: string[]
  /** 工作区配置变更 */
  workspaceChanges?: Record<string, string>
}

export interface VersionProbeResult {
  /** 探测是否成功 */
  ok: boolean
  /** 探测到的版本 */
  version: string | null
  /** 探测到的功能 */
  capabilities: VersionCapability[]
  /** 探测错误 */
  error?: string
}

// ==================== 版本注册表 ====================

/**
 * 版本注册表
 * 存储已知版本的适配配置
 */
class VersionRegistry {
  private adapters = new Map<string, VersionAdapterConfig>()
  private defaultAdapter: VersionAdapterConfig | null = null

  constructor() {
    this.registerDefaults()
  }

  private registerDefaults(): void {
    // 注册已知版本的适配配置
    this.register('2026.3.22', {
      version: '2026.3.22',
      status: 'supported',
      capabilities: [
        { id: 'env-alias', name: '环境变量别名', supported: false, level: 'none', degradeHint: '3.22已移除legacy env alias' },
        { id: 'plugin-path', name: '插件路径解析', supported: true, level: 'full' },
        { id: 'clawhub', name: 'ClawHub解析', supported: true, level: 'full' },
        { id: 'doctor-fix', name: 'Doctor修复', supported: true, level: 'full' },
        { id: 'gateway-control', name: '网关控制', supported: true, level: 'full' },
        { id: 'auth-registry', name: '认证注册表', supported: true, level: 'full' },
      ],
      workspaceChanges: {
        'env-alias': 'OPENCLAW_*替代CLAWDBOT_*/MOLTBOT_*',
        'plugin-path': 'bundled plugin路径收敛',
      },
    })

    this.register('2026.3.24', {
      version: '2026.3.24',
      status: 'supported',
      capabilities: [
        { id: 'env-alias', name: '环境变量别名', supported: false, level: 'none', degradeHint: '3.22+已移除legacy env alias' },
        { id: 'plugin-path', name: '插件路径解析', supported: true, level: 'full' },
        { id: 'clawhub', name: 'ClawHub解析', supported: true, level: 'full' },
        { id: 'doctor-fix', name: 'Doctor修复', supported: true, level: 'full' },
        { id: 'gateway-control', name: '网关控制', supported: true, level: 'full' },
        { id: 'auth-registry', name: '认证注册表', supported: true, level: 'full' },
      ],
    })

    this.register('2026.3.28', {
      version: '2026.3.28',
      status: 'supported',
      capabilities: [
        { id: 'env-alias', name: '环境变量别名', supported: false, level: 'none', degradeHint: '3.22+已移除legacy env alias' },
        { id: 'plugin-path', name: '插件路径解析', supported: true, level: 'full' },
        { id: 'clawhub', name: 'ClawHub解析', supported: true, level: 'full' },
        { id: 'doctor-fix', name: 'Doctor修复', supported: true, level: 'full' },
        { id: 'gateway-control', name: '网关控制', supported: true, level: 'full' },
        { id: 'auth-registry', name: '认证注册表', supported: true, level: 'full' },
      ],
    })

    // 默认适配器：用于未知版本
    this.defaultAdapter = {
      version: 'unknown',
      status: 'experimental',
      capabilities: [
        { id: 'env-alias', name: '环境变量别名', supported: true, level: 'partial', degradeHint: '自动探测中' },
        { id: 'plugin-path', name: '插件路径解析', supported: true, level: 'partial', degradeHint: '自动探测中' },
        { id: 'clawhub', name: 'ClawHub解析', supported: true, level: 'partial', degradeHint: '自动探测中' },
        { id: 'doctor-fix', name: 'Doctor修复', supported: true, level: 'partial', degradeHint: '自动探测中' },
        { id: 'gateway-control', name: '网关控制', supported: true, level: 'partial', degradeHint: '自动探测中' },
        { id: 'auth-registry', name: '认证注册表', supported: true, level: 'partial', degradeHint: '自动探测中' },
      ],
      knownIssues: ['版本未验证，功能可能受限'],
    }
  }

  register(version: string, config: VersionAdapterConfig): void {
    this.adapters.set(this.normalizeVersion(version), config)
  }

  get(version: string): VersionAdapterConfig | null {
    const normalized = this.normalizeVersion(version)
    const config = this.adapters.get(normalized)
    if (config) return config
    
    // 返回默认适配器时，使用传入的版本号
    if (this.defaultAdapter) {
      return {
        ...this.defaultAdapter,
        version: normalized,
      }
    }
    return null
  }

  has(version: string): boolean {
    return this.adapters.has(this.normalizeVersion(version))
  }

  private normalizeVersion(version: string): string {
    return String(version || '').trim().replace(/^v/i, '')
  }
}

// ==================== 版本适配器 ====================

/**
 * 版本适配器
 * 根据版本提供统一的功能访问接口
 */
export class VersionAdapter {
  private registry: VersionRegistry
  private config: VersionAdapterConfig
  private probeCache = new Map<string, VersionProbeResult>()

  constructor(version: string, registry?: VersionRegistry) {
    this.registry = registry || new VersionRegistry()
    this.config = this.registry.get(version) || this.createFallbackConfig(version)
  }

  private createFallbackConfig(version: string): VersionAdapterConfig {
    return {
      version,
      status: 'experimental',
      capabilities: [],
      knownIssues: [`版本 ${version} 未在注册表中找到`],
    }
  }

  /**
   * 获取适配器状态
   */
  getStatus(): VersionAdapterStatus {
    return this.config.status
  }

  /**
   * 获取版本号
   */
  getVersion(): string {
    return this.config.version
  }

  /**
   * 检查功能是否支持
   */
  isCapabilitySupported(capabilityId: string): boolean {
    const capability = this.config.capabilities.find(c => c.id === capabilityId)
    return capability?.supported ?? false
  }

  /**
   * 获取功能降级提示
   */
  getCapabilityDegradeHint(capabilityId: string): string | null {
    const capability = this.config.capabilities.find(c => c.id === capabilityId)
    return capability?.degradeHint ?? null
  }

  /**
   * 获取所有功能
   */
  getCapabilities(): VersionCapability[] {
    return [...this.config.capabilities]
  }

  /**
   * 获取已知问题
   */
  getKnownIssues(): string[] {
    return this.config.knownIssues || []
  }

  /**
   * 获取工作区配置变更
   */
  getWorkspaceChanges(): Record<string, string> {
    return this.config.workspaceChanges || {}
  }

  /**
   * 动态探测功能支持
   * 当静态配置不完整时，尝试通过运行命令探测
   */
  async probeCapability(
    capabilityId: string,
    runCommand: (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>
  ): Promise<VersionProbeResult> {
    // 检查缓存
    if (this.probeCache.has(capabilityId)) {
      return this.probeCache.get(capabilityId)!
    }

    const capability = this.config.capabilities.find(c => c.id === capabilityId)
    if (!capability?.probeCommand) {
      return { ok: false, version: this.config.version, capabilities: [], error: 'No probe command configured' }
    }

    try {
      const result = await runCommand(capability.probeCommand)
      const probeResult: VersionProbeResult = {
        ok: result.ok,
        version: this.config.version,
        capabilities: [{
          ...capability,
          supported: result.ok,
          level: result.ok ? 'full' : 'none',
        }],
      }
      this.probeCache.set(capabilityId, probeResult)
      return probeResult
    } catch (error) {
      const probeResult: VersionProbeResult = {
        ok: false,
        version: this.config.version,
        capabilities: [],
        error: error instanceof Error ? error.message : String(error),
      }
      this.probeCache.set(capabilityId, probeResult)
      return probeResult
    }
  }

  /**
   * 批量探测功能
   */
  async probeCapabilities(
    capabilityIds: string[],
    runCommand: (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>
  ): Promise<Map<string, VersionProbeResult>> {
    const results = new Map<string, VersionProbeResult>()
    for (const id of capabilityIds) {
      results.set(id, await this.probeCapability(id, runCommand))
    }
    return results
  }

  /**
   * 更新配置（用于动态发现）
   */
  updateConfig(updates: Partial<VersionAdapterConfig>): void {
    this.config = { ...this.config, ...updates }
  }

  /**
   * 合并探测结果到配置
   */
  mergeProbeResults(probeResults: Map<string, VersionProbeResult>): void {
    const updatedCapabilities = this.config.capabilities.map(cap => {
      const probe = probeResults.get(cap.id)
      if (probe?.ok) {
        const probedCap = probe.capabilities[0]
        if (probedCap) {
          return { ...cap, supported: probedCap.supported, level: probedCap.level }
        }
      }
      return cap
    })

    this.config = {
      ...this.config,
      capabilities: updatedCapabilities,
    }
  }
}

// ==================== 版本探测器 ====================

/**
 * 版本探测器
 * 负责探测OpenClaw版本和功能
 */
export class VersionProbe {
  /**
   * 探测OpenClaw版本
   */
  static async detectVersion(
    runCommand: (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>
  ): Promise<VersionProbeResult> {
    try {
      const result = await runCommand(['--version'])
      if (!result.ok) {
        return { ok: false, version: null, capabilities: [], error: result.stderr }
      }

      const version = this.parseVersion(result.stdout)
      return { ok: true, version, capabilities: [] }
    } catch (error) {
      return {
        ok: false,
        version: null,
        capabilities: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * 解析版本号
   */
  private static parseVersion(output: string): string | null {
    const lines = output.split('\n')
    for (const line of lines) {
      const match = line.match(/(\d{4}\.\d+\.\d+)/)
      if (match) {
        return match[1]
      }
    }
    return null
  }

  /**
   * 探测功能支持
   */
  static async detectCapabilities(
    runCommand: (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>
  ): Promise<VersionCapability[]> {
    const capabilities: VersionCapability[] = []

    // 探测help命令
    const helpResult = await runCommand(['--help'])
    if (helpResult.ok) {
      // 分析help输出，探测支持的命令
      const helpText = helpResult.stdout + helpResult.stderr
      
      // 检查常见命令
      const commands = [
        { id: 'gateway', name: '网关控制', keywords: ['gateway', 'start', 'stop', 'restart'] },
        { id: 'models', name: '模型管理', keywords: ['models', 'list', 'status', 'auth'] },
        { id: 'plugins', name: '插件管理', keywords: ['plugins', 'install', 'uninstall'] },
        { id: 'doctor', name: '诊断修复', keywords: ['doctor', 'fix'] },
        { id: 'onboard', name: '配置向导', keywords: ['onboard'] },
      ]

      for (const cmd of commands) {
        const supported = cmd.keywords.some(kw => helpText.toLowerCase().includes(kw))
        capabilities.push({
          id: cmd.id,
          name: cmd.name,
          supported,
          level: supported ? 'full' : 'none',
        })
      }
    }

    return capabilities
  }
}

// ==================== 工厂函数 ====================

/**
 * 创建版本适配器
 */
export function createVersionAdapter(
  version: string,
  registry?: VersionRegistry
): VersionAdapter {
  return new VersionAdapter(version, registry)
}

/**
 * 创建版本适配器（异步，带探测）
 */
export async function createVersionAdapterWithProbe(
  runCommand: (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>,
  registry?: VersionRegistry
): Promise<VersionAdapter> {
  const probeResult = await VersionProbe.detectVersion(runCommand)
  if (!probeResult.ok || !probeResult.version) {
    return createVersionAdapter('unknown', registry)
  }

  const adapter = createVersionAdapter(probeResult.version, registry)
  
  // 探测功能
  const capabilities = await VersionProbe.detectCapabilities(runCommand)
  if (capabilities.length > 0) {
    adapter.updateConfig({ capabilities })
  }

  return adapter
}
