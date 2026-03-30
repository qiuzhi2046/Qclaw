import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { LOCAL_CONFIG_PATH, readLocalPublishUrl } from './electron-builder-local-config.mjs'
import { resolvePackageVersion } from './package-version.mjs'

const args = new Set(process.argv.slice(2))
const allowPlaceholderPublish = args.has('--allow-placeholder-publish')

function fail(message) {
  console.error(`[win-release-preflight] ${message}`)
  process.exit(1)
}

function warn(message) {
  console.warn(`[win-release-preflight] ${message}`)
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

  const builderConfigPath = resolve('electron-builder.json')
  const rawConfig = await readFile(builderConfigPath, 'utf8')
  const config = JSON.parse(rawConfig)

  const appId = String(config.appId || '').trim()
  if (!appId || appId === 'YourAppID') {
    fail('请先把 electron-builder.json 里的 appId 改成正式的应用 ID，不能继续使用 `YourAppID`。')
  }

  const win = config.win || {}
  const targets = Array.isArray(win.target) ? win.target : [win.target]
  const hasNsis = targets.some((t) => {
    const target = typeof t === 'string' ? t : t?.target
    return target === 'nsis' || target === 'portable'
  })
  if (!hasNsis) {
    fail('electron-builder.json 的 win.target 必须包含 nsis 或 portable。')
  }

  const localPublishUrl = await readLocalPublishUrl()
  const publishUrl =
    localPublishUrl ||
    readTrimmedEnv('QCLAW_UPDATE_PUBLISH_URL') ||
    (typeof config.publish === 'string'
      ? config.publish
      : String(config.publish?.url || '').trim())

  if (isPlaceholderPublishUrl(publishUrl)) {
    const message = `当前自动更新源仍是占位值。继续打本地包可以，但正式发布前必须在 ${LOCAL_CONFIG_PATH} 或 QCLAW_UPDATE_PUBLISH_URL 中提供真实更新源。`
    if (allowPlaceholderPublish) {
      warn(message)
    } else {
      fail(`${message} 如只做本地测试，请改用 \`npm run package:win\`。`)
    }
  }

  const { version, displayVersion } = resolvePackageVersion()
  console.log(`[win-release-preflight] 版本号：${displayVersion}（semver ${version}）`)
  console.log('[win-release-preflight] Windows 发布环境检查通过。')
}

main().catch((error) => {
  console.error(`[win-release-preflight] 未预期的错误：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
