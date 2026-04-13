const { readdirSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed\n${output}`.trim())
  }

  return output
}

function findAppBundles(rootDir) {
  const bundles = []
  const queue = [rootDir]

  while (queue.length > 0) {
    const current = queue.pop()
    const entries = readdirSync(current, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const absolutePath = join(current, entry.name)
      if (entry.name.endsWith('.app')) {
        bundles.push(absolutePath)
        continue
      }

      queue.push(absolutePath)
    }
  }

  return bundles
}

function parseCodesignDetails(output) {
  const authorityMatches = [...output.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim())
  const teamIdentifier = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || ''
  const signature = output.match(/^Signature=(.+)$/m)?.[1]?.trim() || ''

  return {
    authorities: authorityMatches,
    teamIdentifier,
    signature,
  }
}

async function afterAllArtifactBuild(buildResult) {
  if (process.platform !== 'darwin') return []

  const appBundles = findAppBundles(buildResult.outDir)
  if (appBundles.length === 0) return []

  const teamIdentifiers = new Set()

  for (const appBundle of appBundles) {
    const detailsOutput = run('codesign', ['-dv', '--verbose=4', appBundle])
    const details = parseCodesignDetails(detailsOutput)

    if (details.signature.toLowerCase().includes('adhoc')) {
      throw new Error(`检测到 adhoc 签名：${appBundle}`)
    }

    if (!details.authorities.some((authority) => authority.startsWith('Developer ID Application:'))) {
      throw new Error(`没有检测到 Developer ID Application authority：${appBundle}`)
    }

    if (!details.teamIdentifier || details.teamIdentifier.toLowerCase() === 'not set') {
      throw new Error(`TeamIdentifier 无效：${appBundle}`)
    }

    teamIdentifiers.add(details.teamIdentifier)
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle])
  }

  if (teamIdentifiers.size > 1) {
    throw new Error(`检测到多个 TeamIdentifier：${Array.from(teamIdentifiers).join(', ')}`)
  }

  return []
}

module.exports = afterAllArtifactBuild
module.exports.default = afterAllArtifactBuild
