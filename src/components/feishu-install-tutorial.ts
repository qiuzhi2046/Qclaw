import feishuStep1Overview from '../assets/feishu-tutorial/feishu1-1.png'
import feishuStep1Dialog from '../assets/feishu-tutorial/feishu1-2.png'
import feishuStep2Create from '../assets/feishu-tutorial/feishu2.png'
import feishuStep3Qr from '../assets/feishu-tutorial/feishu3.png'
import feishuStep4MobileCreate from '../assets/feishu-tutorial/feishu4.png'
import feishuStep5Review from '../assets/feishu-tutorial/feishu5.png'
import feishuStep6Finish from '../assets/feishu-tutorial/feishu6.jpeg'
import feishuStep7Chat from '../assets/feishu-tutorial/feishu7.png'

export interface FeishuInstallTutorialImage {
  alt: string
  caption?: string
  src: string
  switchLabel?: string
}

export interface FeishuInstallTutorialStep {
  title: string
  description: string
  bullets?: string[]
  images: FeishuInstallTutorialImage[]
  note?: string
}

export const FEISHU_INSTALL_TUTORIAL_STEPS: FeishuInstallTutorialStep[] = [
  {
    title: '第 1 步：进入渠道配置',
    description: '在 Qclaw Lite 向导中进入「连接消息渠道」步骤，点击顶部「飞书」标签页。',
    images: [
      {
        alt: '飞书步骤 1 图 1：进入消息渠道页并点击添加渠道',
        caption: '先进入左侧「消息渠道」，然后点击右上角「添加渠道」。',
        src: feishuStep1Overview,
        switchLabel: '入口页',
      },
      {
        alt: '飞书步骤 1 图 2：在配置渠道弹窗中切换到飞书页签',
        caption: '打开配置弹窗后，确认已经切换到「飞书」标签页。',
        src: feishuStep1Dialog,
        switchLabel: '飞书页签',
      },
    ],
  },
  {
    title: '第 2 步：启动安装器',
    description: '在飞书配置区域，点击「新建机器人」按钮，安装器将自动启动。',
    images: [
      {
        alt: '飞书步骤 2：点击新建机器人按钮',
        caption: '点击「新建机器人」，进入官方安装器创建流程。',
        src: feishuStep2Create,
      },
    ],
  },
  {
    title: '第 3 步：扫码授权',
    description: '安装器启动后会生成二维码，使用手机飞书 App 扫码授权创建机器人。',
    images: [
      {
        alt: '飞书步骤 3：扫描安装器生成的真实二维码',
        caption: '等待安装器生成本次有效二维码，再用手机飞书扫码。',
        src: feishuStep3Qr,
      },
    ],
    note:
      '如果界面先显示「官网兜底二维码」，请耐心等待状态标签从「等待刷新」变为「已刷新」后，再扫描真实二维码。',
  },
  {
    title: '第 4 步：在手机上操作',
    description: '在手机飞书里完成机器人的基础信息配置。',
    bullets: [
      '为机器人挑选头像、起个名字',
      '点击「创建」',
    ],
    images: [
      {
        alt: '飞书步骤 4：在手机上设置机器人头像和名称',
        caption: '在手机端补全头像和名称后点击「创建」。',
        src: feishuStep4MobileCreate,
      },
    ],
  },
  {
    title: '第 5 步：等待审核',
    description: '发布应用后可能需要等待企业管理员审核通过。个人测试企业可在管理后台自行审批。',
    images: [
      {
        alt: '飞书步骤 5：查看创建成功和审核中的状态',
        caption: '创建成功后会进入审核流程，待审核通过后即可继续使用。',
        src: feishuStep5Review,
      },
    ],
    note: '如果审核需要较长时间，可以先跳过，之后再回来完成配对。',
  },
  {
    title: '第 6 步：完成配置',
    description: '回到 Qclaw Lite，等待安装器完成收尾，Qclaw 会自动完成配置。',
    images: [
      {
        alt: '飞书步骤 6：在 Qclaw Lite 中等待自动完成配置',
        caption: '确认安装器输出正常后，等待 Qclaw 自动完成配置。',
        src: feishuStep6Finish,
      },
    ],
  },
  {
    title: '第 7 步：测试机器人',
    description: '在飞书搜索框搜索刚创建的机器人名字，发送一条消息，能看到回复即接入成功。',
    images: [
      {
        alt: '飞书步骤 7：在飞书里给机器人发消息并收到回复',
        caption: '搜索机器人并发送一条消息，看到回复说明接入已经成功。',
        src: feishuStep7Chat,
      },
    ],
  },
]

export function getFeishuInstallTutorialPrimaryActionLabel(
  stepIndex: number,
  totalSteps = FEISHU_INSTALL_TUTORIAL_STEPS.length
): string {
  return stepIndex >= totalSteps - 1 ? '完成' : '下一步'
}
