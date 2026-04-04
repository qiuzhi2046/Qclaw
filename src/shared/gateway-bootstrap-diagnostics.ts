import {
  type GatewayRuntimeStateCode,
  type GatewayRuntimeEvidence,
} from './gateway-runtime-state'
import { classifyGatewayRuntimeState } from './gateway-runtime-diagnostics'
import { describeGatewayRuntimeReasonDetail } from './gateway-runtime-reason-detail'

export interface GatewayBootstrapFailureView {
  title: string
  detail: string
  hints: string[]
}

function joinNonEmpty(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n')
}

function buildSearchCorpus(result: unknown): string {
  if (!result || typeof result !== 'object') return ''

  const typed = result as {
    stdout?: string
    stderr?: string
    diagnostics?: {
      lastHealth?: {
        raw?: string
        stderr?: string
      } | null
      doctor?: {
        stdout?: string
        stderr?: string
      } | null
    }
  }

  return joinNonEmpty([
    typed.stderr,
    typed.stdout,
    typed.diagnostics?.lastHealth?.stderr,
    typed.diagnostics?.lastHealth?.raw,
    typed.diagnostics?.doctor?.stderr,
    typed.diagnostics?.doctor?.stdout,
  ]).toLowerCase()
}

function createView(title: string, detail: string, hints: string[]): GatewayBootstrapFailureView {
  return { title, detail, hints }
}

function describePortOwner(evidence: GatewayRuntimeEvidence[] = []): string {
  const ownerEvidence = evidence.find((item) => item.source === 'port-owner' && item.owner)
  const owner = ownerEvidence?.owner
  if (!owner) return '当前还没识别到占用端口的进程'

  const parts = [owner.processName, owner.pid ? `PID ${owner.pid}` : '', owner.command]
    .map((part) => String(part || '').trim())
    .filter(Boolean)

  return parts.length > 0 ? `检测到占用端口的进程：${parts.join(' / ')}` : '已识别到端口被其他进程占用'
}

function resolveReasonDetailFailureView(reasonCode: string | undefined): GatewayBootstrapFailureView | null {
  if (reasonCode === 'device_token_mismatch') {
    return createView(
      '控制界面与本地网关的设备令牌不一致',
      '系统已直接复用 OpenClaw Control UI 的连接结果，确认当前控制界面连接本机网关时被 device token 不一致拒绝。这更像是本机控制面与运行中的网关状态错位，不是远端模型上游故障。',
      [
        '先点“重试启动网关”，让程序重新加载当前机器上的运行状态令牌。',
        '如果这是换机后的首次运行，建议点“重新配置引导”，在本机重新完成认证与初始化。',
        '若仍反复出现，优先排查是否还存在旧网关进程、旧 user data 或旧 token 注入。',
      ]
    )
  }

  if (reasonCode === 'gateway_auth_token_mismatch' || reasonCode === 'token_mismatch') {
    return createView(
      '控制界面与网关的 auth token 不一致',
      '系统已直接复用 OpenClaw Control UI 的连接结果，确认当前控制界面握手时使用的 auth token 与运行中的网关不一致。',
      [
        '先点“重试启动网关”，让程序重新加载当前机器上的配置和网关 token。',
        '如果最近改过配置文件、环境变量或执行过升级，建议重新走一次本机配置流程。',
        '若问题反复出现，优先检查是否有旧网关服务还在消费旧 token。',
      ]
    )
  }

  return null
}

function resolveStructuredGatewayFailureView(
  stateCode: GatewayRuntimeStateCode,
  evidence: GatewayRuntimeEvidence[]
): GatewayBootstrapFailureView | null {
  if (stateCode === 'service_missing' || stateCode === 'service_install_failed' || stateCode === 'service_loaded_but_stale') {
    return createView(
      '这台机器上的网关后台服务还没真正准备好',
      '系统已经尝试自动启动网关，但后台服务本身没有成功加载完成，当前还不能安全放行到控制面板。',
      [
        '先点“重试启动网关”再试一次，看看后台服务是否能补装并完成加载。',
        '如果这是新机器或新系统，请重新走一次配置引导，让程序重新建立本机环境。',
        '若仍反复出现，优先排查系统权限、服务安装和本机安全策略。',
      ]
    )
  }

  if (stateCode === 'port_conflict_same_gateway' || stateCode === 'port_conflict_foreign_process') {
    return createView(
      '网关启动时遇到了本机端口占用',
      `系统已经识别到网关端口冲突。${describePortOwner(evidence)}。`,
      [
        stateCode === 'port_conflict_same_gateway'
          ? '系统更像是撞上了旧的 OpenClaw/网关进程；重新启动通常有效。'
          : '如果这是别的程序占用了同一端口，建议先关闭它，或让程序自动迁移到新的本地端口。',
        '如果你之前手动运行过 OpenClaw、代理程序或旧版网关，先完全退出它们。',
        '连续重试仍失败时，再进一步检查端口占用进程和本机安全策略。',
      ]
    )
  }

  if (stateCode === 'token_mismatch' || stateCode === 'websocket_1006' || stateCode === 'auth_missing') {
    return createView(
      '这台机器上的模型认证还没准备好',
      '系统已经发出网关启动或重载指令，但当前机器上的 API Key、浏览器授权登录状态、运行中的 token，或网关握手状态还没有和最新配置保持一致。',
      [
        '点“重试启动网关”让程序重新加载当前机器上的配置和 token。',
        '如果这是换机后的首次运行，建议点“重新配置引导”，在本机重新完成模型认证。',
        '若问题反复出现，优先检查 API Key、浏览器授权登录状态，以及配置文件里的 gateway token 是否被其他进程占用了旧值。',
      ]
    )
  }

  if (stateCode === 'plugin_load_failure') {
    return createView(
      '网关依赖的插件没有正常加载',
      '当前机器上的插件文件、allowlist 或插件导出状态仍然不一致，所以网关不能安全启动。',
      [
        '先重新执行一次配置引导，让程序重新安装并校验官方插件。',
        '如果最近手动改过 `openclaw.json` 或插件目录，建议先恢复到程序管理的配置状态。',
        '若多次重试仍失败，再排查插件 manifest、allowlist 和插件导出信息是否一致。',
      ]
    )
  }

  if (stateCode === 'plugin_allowlist_warning') {
    return createView(
      '网关检测到外部插件 allowlist 提示',
      '当前更像是网关发现了未显式写入 allowlist 的外部插件，并输出了安全提示；这类日志不等于插件本身加载失败。',
      [
        '如果程序已经继续可用，可以先按当前流程继续，不必把它当成认证或启动失败。',
        '后续可让程序把受信任插件补写回 `plugins.allow`，减少同类提示反复出现。',
        '只有在同时出现“failed to load plugin”或插件功能确实不可用时，才按真正的插件故障处理。',
      ]
    )
  }

  if (stateCode === 'config_invalid') {
    return createView(
      '网关配置在这台机器上还不完整',
      '系统已经尝试启动网关，但当前配置、模型配置或提供商设置还不足以让当前机器顺利完成启动。',
      [
        '点“重新配置引导”，重新确认模型提供商、默认模型和必要配置。',
        '如果你做过换机或迁移，优先检查当前机器是否使用了正确的 OpenClaw 配置目录。',
        '完成配置修复后，再点击“重试启动网关”。',
      ]
    )
  }

  if (stateCode === 'network_blocked') {
    return createView(
      '网关更像是被网络或代理环境卡住了',
      '系统补充诊断后，问题更接近这台机器当前无法顺利访问上游服务，或者代理、证书、网络出口配置和原机器不一致。',
      [
        '先确认当前机器的网络、代理和证书环境与可正常工作的机器一致。',
        '如果公司网络或 VPN 有差异，建议先切到更稳定的网络后再试。',
        '网络恢复后，再点击“重试启动网关”。',
      ]
    )
  }

  return null
}

export function resolveGatewayBootstrapFailureView(result: unknown): GatewayBootstrapFailureView {
  const classification = classifyGatewayRuntimeState(result)
  const corpus = buildSearchCorpus(result)
  const reasonView = resolveReasonDetailFailureView(classification.reasonDetail?.code)
  if (reasonView) return reasonView

  if (
    (classification.stateCode === 'token_mismatch' ||
      classification.stateCode === 'websocket_1006' ||
      classification.stateCode === 'auth_missing') &&
    /gateway service not loaded|gateway service not installed|service not installed|launchctl|daemon|service failed/i.test(
      corpus
    )
  ) {
    const serviceView = resolveStructuredGatewayFailureView('service_missing', classification.evidence)
    if (serviceView) return serviceView
  }

  const reasonDetailCopy = describeGatewayRuntimeReasonDetail(classification.reasonDetail)
  if (reasonDetailCopy) {
    return createView(
      '控制界面返回了更具体的连接原因',
      `系统已直接复用 OpenClaw Control UI 的连接结果：${reasonDetailCopy}。`,
      [
        '先点“重试启动网关”，观察当前机器上的运行状态是否能重新对齐。',
        '如果这是换机或迁移后的首次运行，建议重新走一次本机配置引导。',
        '若仍失败，再结合原始日志继续排查当前机器上的本地网关运行状态。',
      ]
    )
  }

  const structuredView = resolveStructuredGatewayFailureView(
    classification.stateCode,
    classification.evidence
  )
  if (structuredView) return structuredView

  if (
    /gateway service not loaded|launchctl|daemon|service unavailable|service failed/i.test(corpus)
  ) {
    return createView(
      '这台机器上的网关后台服务还没真正准备好',
      '系统已经尝试自动启动网关，但后台服务本身没有成功加载完成，当前还不能安全放行到控制面板。',
      [
        '先点“重试启动网关”再试一次，看看后台服务是否能补装并完成加载。',
        '如果这是新机器或新系统，请重新走一次配置引导，让程序重新建立本机环境。',
        '若仍反复出现，优先排查系统权限、服务安装和本机安全策略。',
      ]
    )
  }

  if (
    /\beaddrinuse\b|address already in use|port\b.*in use|listen\b.*in use|bind\b.*failed/i.test(corpus)
  ) {
    return createView(
      '网关启动时遇到了本机端口占用',
      '系统自检更像是本机已经有别的进程占用了网关需要的端口，因此网关没有办法完成就绪确认。',
      [
        '关闭占用同一端口的程序后，再点击“重试启动网关”。',
        '如果你之前手动运行过 OpenClaw 或其他代理程序，先完全退出它们。',
        '不确定哪个进程占用时，建议先重启电脑后再重试一次。',
      ]
    )
  }

  if (
    /\bapi[_ -]?key\b|oauth|token|unauthorized|forbidden|not logged in|credential|auth(?:entication)?|login|expired/i.test(corpus)
  ) {
    return createView(
      '这台机器上的模型认证还没准备好',
      '系统已经发出网关启动指令，但补充诊断更像是当前机器缺少可用的 API Key、浏览器授权登录状态，或原有登录没有在本机生效。',
      [
        '点“重新配置引导”，在当前机器上重新完成模型登录或 API Key 配置。',
        '如果是从另一台电脑迁移过来的，请不要只复制配置文件，还要在本机重新补齐认证信息。',
        '配置完成后，再点击“重试启动网关”。',
      ]
    )
  }

  if (
    /\benotfound\b|\beconnrefused\b|\beconnreset\b|timed out|timeout|network|dns|proxy|certificate|tls|ssl|socket hang up|fetch failed|service unavailable/i.test(corpus)
  ) {
    return createView(
      '网关更像是被网络或代理环境卡住了',
      '系统补充诊断后，问题更接近这台机器当前无法顺利访问上游服务，或者代理、证书、网络出口配置和原机器不一致。',
      [
        '先确认当前机器的网络、代理和证书环境与可正常工作的机器一致。',
        '如果公司网络或 VPN 有差异，建议先切到更稳定的网络后再试。',
        '网络恢复后，再点击“重试启动网关”。',
      ]
    )
  }

  if (
    /config|openclaw\.json|provider|model|missing required|invalid|parse|json/i.test(corpus)
  ) {
    return createView(
      '网关配置在这台机器上还不完整',
      '系统已经尝试启动网关，但补充诊断显示当前配置、模型配置或提供商设置还不足以让当前机器顺利完成启动。',
      [
        '点“重新配置引导”，重新确认模型提供商、默认模型和必要配置。',
        '如果你做过换机或迁移，优先检查当前机器是否使用了正确的 OpenClaw 配置目录。',
        '完成配置修复后，再点击“重试启动网关”。',
      ]
    )
  }

  return createView(
    '网关还没有完成就绪确认',
    '系统已经执行了启动和补充诊断，但仍然没能在当前机器上确认网关已经可用。这个问题通常与本机配置、认证、网络或后台服务状态有关。',
    [
      '先点击“重试启动网关”，再观察是否能正常通过。',
      '如果这是换机后的首次运行，建议直接走一次“重新配置引导”。',
      '若多次重试仍失败，再进一步排查当前机器的网络、权限和 OpenClaw 环境。',
    ]
  )
}
