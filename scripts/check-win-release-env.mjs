import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { LOCAL_CONFIG_PATH, readLocalPublishUrl } from './electron-builder-local-config.mjs'
import { resolvePackageVersion } from './package-version.mjs'

const args = new Set(process.argv.slice(2))
const allowPlaceholderPublish = args.has('--allow-placeholder-publish')
const skipSign = args.has('--skip-sign')

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
    fail('`release:win` 只能在 Windows 上运行。')
  }

  const localPublishUrl = await readLocalPublishUrl()
  const publishUrl =
    localPublishUrl ||
    readTrimmedEnv('QCLAW_UPDATE_PUBLISH_URL')

  if (isPlaceholderPublishUrl(publishUrl)) {
    const message = `当前自动更新源仍是占位值。正式发布前必须在 ${LOCAL_CONFIG_PATH} 或 QCLAW_UPDATE_PUBLISH_URL 中提供真实更新源。`
    if (allowPlaceholderPublish) {
      warn(message)
    } else {
      fail(`${message} 如只做本地构建测试，请改用 \`npm run package:win\`。`)
    }
  }

  if (!skipSign) {
    const cscLink = readTrimmedEnv('WIN_CSC_LINK')
    const cscPassword = readTrimmedEnv('WIN_CSC_KEY_PASSWORD')

    if (!cscLink) {
      fail(
        '未设置 WIN_CSC_LINK。请提供 .pfx 证书路径或 base64 编码内容，或使用 `npm run package:win` 构建未签名版本。'
      )
    }

    if (!cscPassword) {
      fail('未设置 WIN_CSC_KEY_PASSWORD。请提供证书密码。')
    }

    if (!cscLink.startsWith('data:') && !existsSync(resolve(cscLink))) {
      fail(`WIN_CSC_LINK 指向的证书文件不存在：${cscLink}`)
    }
  }

  const packageVersion = resolvePackageVersion()
  const signSuffix = skipSign ? '，本次仅构建，不签名' : ''
  console.log(
    `[win-release-preflight] 检查通过${signSuffix}，本次打包版本号将使用 ${packageVersion.displayVersion}（内部 semver ${packageVersion.version}）。`
  )
}

await main()
