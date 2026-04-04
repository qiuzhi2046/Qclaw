/**
 * OpenClaw 版本适配器集成模块
 * 
 * 负责在应用启动时初始化版本适配器，并将其集成到现有系统中
 */

import { setVersionAdapter } from '../../src/shared/openclaw-version-policy'
import {
  type VersionAdapter,
  createVersionAdapter,
  createVersionAdapterWithProbe,
} from '../../src/shared/openclaw-version-adapter'
import { runCli } from './cli'

// 全局版本适配器实例
let globalVersionAdapter: VersionAdapter | null = null

// 初始化锁，防止并发初始化
let initPromise: Promise<VersionAdapter | null> | null = null

/**
 * 获取全局版本适配器
 */
export function getGlobalVersionAdapter(): VersionAdapter | null {
  return globalVersionAdapter
}

/**
 * 初始化版本适配器
 * @param version OpenClaw版本号（可选，如果不提供会自动探测）
 */
export async function initVersionAdapter(version?: string): Promise<VersionAdapter | null> {
  // 如果已经在初始化中，等待完成
  if (initPromise) {
    return initPromise
  }

  initPromise = doInitVersionAdapter(version)
  
  try {
    return await initPromise
  } finally {
    initPromise = null
  }
}

async function doInitVersionAdapter(version?: string): Promise<VersionAdapter | null> {
  try {
    // 如果提供了版本号，直接使用
    if (version) {
      globalVersionAdapter = createVersionAdapter(version)
    } else {
      // 否则自动探测版本
      globalVersionAdapter = await createVersionAdapterWithProbe(async (args) => {
        const result = await runCli(args, undefined, 'version-probe')
        return {
          ok: result.ok,
          stdout: result.stdout,
          stderr: result.stderr,
        }
      })
    }

    // 设置到版本策略中
    setVersionAdapter(globalVersionAdapter)

    const adapterVersion = globalVersionAdapter.getVersion()
    const adapterStatus = globalVersionAdapter.getStatus()
    console.log(`[version-adapter] 已初始化版本适配器: ${adapterVersion} (状态: ${adapterStatus})`)

    return globalVersionAdapter
  } catch (error) {
    console.error('[version-adapter] 初始化失败:', error)
    globalVersionAdapter = null
    setVersionAdapter(null)
    return null
  }
}

/**
 * 重新初始化版本适配器
 * 当检测到OpenClaw版本变化时调用
 */
export async function reinitVersionAdapter(newVersion: string): Promise<VersionAdapter | null> {
  const currentVersion = globalVersionAdapter?.getVersion()
  
  // 如果版本没有变化，不需要重新初始化
  if (currentVersion === newVersion) {
    return globalVersionAdapter
  }

  console.log(`[version-adapter] 检测到版本变化: ${currentVersion} -> ${newVersion}`)
  return initVersionAdapter(newVersion)
}

/**
 * 清理版本适配器
 */
export function cleanupVersionAdapter(): void {
  globalVersionAdapter = null
  setVersionAdapter(null)
  console.log('[version-adapter] 已清理版本适配器')
}

/**
 * 检查功能是否支持
 * @returns 如果适配器未初始化返回null，否则返回功能支持状态
 */
export function checkCapabilitySupported(capabilityId: string): boolean | null {
  if (!globalVersionAdapter) {
    return null // 适配器未初始化，状态未知
  }
  return globalVersionAdapter.isCapabilitySupported(capabilityId)
}

/**
 * 获取功能降级提示
 */
export function getCapabilityHint(capabilityId: string): string | null {
  if (!globalVersionAdapter) {
    return null
  }
  return globalVersionAdapter.getCapabilityDegradeHint(capabilityId)
}

/**
 * 获取所有功能
 */
export function getAllCapabilities() {
  if (!globalVersionAdapter) {
    return []
  }
  return globalVersionAdapter.getCapabilities()
}

/**
 * 获取已知问题
 */
export function getKnownIssues(): string[] {
  if (!globalVersionAdapter) {
    return []
  }
  return globalVersionAdapter.getKnownIssues()
}
