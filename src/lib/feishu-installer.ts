export const FEISHU_OFFICIAL_GUIDE_URL = 'https://www.feishu.cn/content/article/7613711414611463386'
export const FEISHU_OFFICIAL_INSTALL_COMMAND = 'npx -y @larksuite/openclaw-lark-tools install'

export function extractFirstHttpUrl(text: string): string {
  const match = String(text || '').match(/https?:\/\/[^\s<>"']+/i)
  return match?.[0] || ''
}

export function extractFeishuAsciiQr(text: string): string {
  const lines = String(text || '').split(/\r?\n/)
  const scanLineIndex = lines.findIndex((line) => /scan with feishu to configure your bot/i.test(line))
  if (scanLineIndex < 0) return ''

  const qrLines: string[] = []
  for (let index = scanLineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) {
      if (qrLines.length > 0) break
      continue
    }
    if (/fetching configuration results/i.test(line)) break
    if (/[█▄▀]/.test(line)) {
      qrLines.push(line)
      continue
    }
    if (qrLines.length > 0) break
  }

  return qrLines.join('\n').trim()
}
