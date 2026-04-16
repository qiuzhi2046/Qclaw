export const OPENCLAW_412_CHANNEL_FIXTURE_VERSION = '2026.4.12' as const

export const ORIGIN_MAIN_324_CHANNEL_GUARDRAIL_REFERENCES = {
  versionPolicy: {
    referenceOnly: 'origin/main pins OpenClaw 2026.3.24 and must not be copied into Windows.',
    windowsTarget: OPENCLAW_412_CHANNEL_FIXTURE_VERSION,
  },
  reusableLogic: [
    'managed-plugin-config-reconciler dry-run/apply/caller/scope shape',
    'managed-channel lifecycle reconcileConfig and managed operation lock ideas',
    'personal Weixin only prunes plugin config after the official plugin is confirmed installed',
    'Feishu legacy plugin cleanup, official openclaw-lark sync, and multi-bot isolation preservation',
  ],
} as const

export const openClaw412FeishuMultiBotConfig = {
  channels: {
    feishu: {
      enabled: true,
      name: '默认 Bot',
      appId: 'cli_default',
      appSecret: {
        source: 'file',
        provider: 'lark-secrets',
        id: '/feishu/default/appSecret',
      },
      domain: 'feishu',
      dmPolicy: 'pairing',
      groupPolicy: 'open',
      streaming: true,
      blockStreaming: true,
      accounts: {
        work: {
          enabled: true,
          name: '工作机器人',
          appId: 'cli_work',
          appSecret: 'work-secret',
          blockStreaming: false,
        },
      },
    },
  },
  plugins: {
    allow: ['feishu', 'feishu-openclaw-plugin', 'openclaw-lark'],
    entries: {
      feishu: {
        enabled: true,
      },
      'feishu-openclaw-plugin': {
        enabled: true,
      },
      'openclaw-lark': {
        enabled: true,
      },
    },
  },
  session: {
    dmScope: 'per-account-channel-peer',
  },
  agents: {
    list: [
      {
        id: 'feishu-default',
        name: '机器人 Agent',
        workspace: '~/.openclaw/workspace-feishu-default',
      },
      {
        id: 'feishu-work',
        name: '工作机器人 Agent',
        workspace: '~/.openclaw/workspace-feishu-work',
      },
      {
        id: 'custom-agent',
        name: 'Custom Agent',
        workspace: '~/.openclaw/custom',
      },
    ],
  },
  bindings: [
    {
      agentId: 'feishu-default',
      match: {
        channel: 'feishu',
        accountId: 'default',
      },
    },
    {
      agentId: 'feishu-work',
      match: {
        channel: 'feishu',
        accountId: 'work',
      },
    },
    {
      agentId: 'custom-agent',
      match: {
        channel: 'discord',
      },
    },
  ],
} as const

export const openClaw412PersonalWeixinConfig = {
  channels: {
    'openclaw-weixin': {
      enabled: true,
      accounts: {
        personal: {
          enabled: true,
          name: '个人微信',
        },
      },
    },
  },
  plugins: {
    allow: ['openclaw-weixin'],
    entries: {
      'openclaw-weixin': {
        enabled: true,
      },
    },
  },
} as const

export const openClaw412DingtalkFallbackConfig = {
  gateway: {
    auth: {
      mode: 'token',
      token: 'gateway-token',
    },
    http: {
      endpoints: {
        chatCompletions: {
          enabled: true,
        },
      },
    },
  },
  channels: {
    'dingtalk-connector': {
      enabled: true,
      clientId: 'ding_client',
      clientSecret: 'ding-secret',
    },
  },
  plugins: {
    allow: ['dingtalk-connector'],
    installs: {
      'dingtalk-connector': {
        installPath: 'C:/Users/demo/.openclaw/extensions/dingtalk-connector',
      },
    },
  },
} as const
