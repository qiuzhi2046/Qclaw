import type {
  OfficialChannelStatusStage,
  OfficialChannelStatusStageState,
} from './official-channel-integration'

export function getOfficialChannelStageLabel(
  stageId: OfficialChannelStatusStage['id']
): string {
  if (stageId === 'installed') return '已安装'
  if (stageId === 'registered') return '已注册'
  if (stageId === 'loaded') return '已加载'
  if (stageId === 'ready') return '已就绪'
  return ''
}

export function getOfficialChannelStageStateLabel(
  state: OfficialChannelStatusStageState
): string {
  if (state === 'verified') return '已证实'
  if (state === 'missing') return '缺失'
  return 'unknown / 未证实'
}

export function getOfficialChannelStageColor(
  state: OfficialChannelStatusStageState
): string {
  if (state === 'verified') return 'teal'
  if (state === 'missing') return 'red'
  return 'gray'
}
