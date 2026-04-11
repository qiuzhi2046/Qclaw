import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { LOCAL_CONFIG_PATH, readLocalPublishUrl } from './electron-builder-local-config.mjs'
import { resolvePackageVersion } from './package-version.mjs'

const args = new Set(process.argv.slice(2))
const allowPlaceholderPublish = args.has('--allow-placeholder-publish')
const allowUnsigned = args.has('--unsigned')

function fail(message) {
  console.error(`[win-package-preflight] ${message}`)
  process.exit(1)
}

function warn(message) {
  console.warn(`[win-package-preflight] ${message}`)
}

function readTrimmedEnv(name) {
  return String(process.env[name] || '').trim()
}

function isPlaceholderPublishUrl(value) {
  const normalized = String(value || '').trim()
  return (
    !normalized ||
    /example\.invalid/i.test(normalized) ||
    /example\.com/i.test(normalized) ||
    /electron-vite-react/i.test(normalized) ||
    /releases\/download\/v0\.9\.9/i.test(normalized)
  )
}

async function main() {
  if (process.platform !== 'win32') {
    fail('`package:win` 只能在 Windows 上运行。')
  }

  if (process.arch !== 'x64') {
    fail(`当前仅支持在 Windows x64 上打包，检测到架构：${process.arch}`)
  }

  const builderConfigPath = resolve('electron-builder.json')
  const rawConfig = await readFile(builderConfigPath, 'utf8')
  const config = JSON.parse(rawConfig)

  const appId = String(config.appId || '').trim()
  if (!appId || appId === 'YourAppID') {
    fail('请先把 electron-builder.json 里的 appId 改成正式的应用 id，不能继续使用占位值。')
  }

  const winTarget = Array.isArray(config.win?.target) ? config.win.target : []
  const hasNsisTarget = winTarget.some((entry) => {
    if (typeof entry === 'string') return entry === 'nsis'
    return String(entry?.target || '').trim() === 'nsis'
  })
  if (!hasNsisTarget) {
    fail('electron-builder.json 当前没有配置 Windows NSIS 目标，无法执行标准自动更新链路验证。')
  }

  if (config.forceCodeSigning === true && !allowUnsigned) {
    fail('当前全局启用了 forceCodeSigning。如需本地 unsigned 打包，请传入 --unsigned。')
  }

  const localPublishUrl = await readLocalPublishUrl()
  const publishUrl =
    localPublishUrl ||
    readTrimmedEnv('QCLAW_UPDATE_PUBLISH_URL') ||
    (typeof config.publish === 'string'
      ? config.publish
      : String(config.publish?.url || '').trim())

  if (isPlaceholderPublishUrl(publishUrl)) {
    const message = `当前自动更新源仍是占位值。允许继续做本地 smoke 打包；正式接通前请在 ${LOCAL_CONFIG_PATH} 或 QCLAW_UPDATE_PUBLISH_URL 中提供真实更新源。`
    if (allowPlaceholderPublish) {
      warn(message)
    } else {
      fail(message)
    }
  }

  const packageVersion = resolvePackageVersion()
  console.log(
    `[win-package-preflight] 检查通过：Windows x64，本次打包版本号将使用 ${packageVersion.displayVersion}（内部 semver ${packageVersion.version}）。`
  )
}

await main()
