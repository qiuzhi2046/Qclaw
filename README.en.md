<br />
<div align="center">
  <a href="https://github.com/qiuzhi2046/Qclaw">
    <img src="src/assets/logo.png" alt="Qclaw Logo" width="128" height="128">
  </a>

  <h1 align="center" style="margin-top: 0.2em;">Qclaw</h1>

  [![Electron][electron-badge]][electron-url]
  [![React][react-badge]][react-url]
  [![Vite][vite-badge]][vite-url]
  [![Mantine][mantine-badge]][mantine-url]
  [![Tailwind CSS][tailwind-badge]][tailwind-url]

  <p align="center">
    <h3>OpenClaw for everyone, without touching the command line</h3>
    <br />
    <a href="https://qclawai.com/"><strong>Visit Website &raquo;</strong></a>
    <br />
    <br />
    <a href="https://github.com/qiuzhi2046/Qclaw/blob/main/README.md">简体中文</a>
    &middot;
    <a href="https://github.com/qiuzhi2046/Qclaw/issues/new?labels=bug">Report Bug</a>
    &middot;
    <a href="https://github.com/qiuzhi2046/Qclaw/issues/new?labels=enhancement">Request Feature</a>
  </p>
</div>

<details>
  <summary>Contents</summary>
  <ol>
    <li><a href="#features">Features</a></li>
    <li><a href="#why-this-project-exists">Why This Project Exists</a></li>
    <li><a href="#quick-start">Quick Start</a></li>
    <li><a href="#development">Development</a></li>
    <li><a href="#known-issues">Known Issues</a></li>
    <li><a href="#supported-platforms">Supported Platforms</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#community">Community</a></li>
    <li><a href="#join-us">Join Us</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contributors">Contributors</a></li>
    <li><a href="#acknowledgements">Acknowledgements</a></li>
  </ol>
</details>

## Features

<p align="center">
  <img src="docs/images/config.png" alt="Visual configuration" width="280">
  <img src="docs/images/im.png" alt="Multi-channel access" width="280">
  <img src="docs/images/state_management.png" alt="State management" width="280">
</p>
<p align="center">
  <img src="docs/images/safety.png" alt="Safety and backup" width="280">
  <img src="docs/images/skills.png" alt="Skills management" width="280">
</p>

- **Environment check** — Detects Node.js and OpenClaw CLI automatically and installs missing dependencies when needed
- **Full OpenClaw model support** — Works with the complete OpenClaw model catalog and also supports custom model entries
- **Latest IM integrations** — Connect Feishu, WeChat, WeCom, DingTalk, and QQ with QR-code-driven setup, then install official plugins and write config automatically
- **Guided onboarding** — Beginner-friendly workflow with step-by-step guidance and safety reminders
- **Operations dashboard** — Monitor gateway status in real time, restart services, and repair runtime issues in one place
- **Skills management** — Manage skills from different sources
- **Backup support** — Includes automatic backup and manual backup flows
- **Cross-platform direction** — Supports macOS today, Windows is in progress, and Linux is planned
- **Update support** — Supports the latest OpenClaw releases

## Why This Project Exists

Qclaw started with a simple goal: build a practical desktop companion for OpenClaw so everyone can install it, configure it, and actually use it with confidence.

- Lower the barrier by turning complex CLI and config steps into simple desktop interactions
- Make powerful AI tooling more accessible to everyone
- Help first-time users learn by doing, with setup steps that double as a tutorial

## Quick Start

### Step 1: Download and install

- Download and open the Qclaw Lite client
  - Website: https://qclawai.com/
  - GitHub Releases: [Download the latest version](https://github.com/qiuzhi2046/Qclaw/releases)
- Read the safety notice and confirm before continuing

### Step 2: Prepare the environment

- Run the environment check
  - If an existing OpenClaw setup is detected, Qclaw can import it directly
- Follow the on-screen guidance to begin configuration

### Step 3: Configure models

- Open the AI provider page and wait for the model list to load
- Choose the models you want to use
  - Supports the full OpenClaw model catalog, and some models also support OAuth authorization

### Step 4: Connect IM channels (optional)

- Open the IM channels page
- Choose the platform you use most often, such as Feishu, DingTalk, QQ, or WeCom
- Follow the in-app guide to complete setup for each platform
  - [Feishu setup guide](https://my.feishu.cn/wiki/WAfWw1bqriZP02kqdNycHlvnnHb)
  - [DingTalk setup guide](https://my.feishu.cn/wiki/NUJew2DzaipVsukUvPmcZ2yvnYb)
  - [QQ setup guide](https://my.feishu.cn/wiki/AvuSwchqviAO6dkwiZycmZeInPf)
  - [WeCom setup guide](https://my.feishu.cn/wiki/TsLTwplveiqbW8kH5XOclgvYn1d)

### Step 5: Start using it

- Start conversations directly in the desktop client
- Or test your AI assistant inside the IM tools you just connected

> 💡 Closing the Qclaw Lite window does not stop OpenClaw in the background. Your IM channels continue to work normally.

## Development

### Recommended development environment

- macOS
- Qclaw (OpenClaw)
- [Codex](https://github.com/openai/codex) or [Claude Code](https://claude.ai/code)
- Node.js 24, with 22 as the minimum supported version for local development

### Install from source

```bash
# Clone the repository
git clone https://github.com/qiuzhi2046/Qclaw.git
cd Qclaw

# Install dependencies
npm install

# Start the development environment
npm run dev

# Build the production version
npm run build
```

### Common commands

| Command | Description |
|------|------|
| `npm run dev` | Start the development server |
| `npm run build` | Build and package the application |
| `npm test` | Run the test suite |
| `npm run typecheck` | Run TypeScript type checks |

### Project structure

```text
electron/
  main/             Main process: window management, CLI calls, IPC handlers
  preload/          Preload scripts and secure bridge
src/
  pages/            Page-level components: wizard steps, dashboard, chat, and more
  components/       UI components
  lib/              Business logic: channel registry, provider registry, and utilities
  shared/           Shared modules: config flow, gateway diagnostics, and policies
  assets/           Icons and static assets
docs/               Project documents, architecture notes, and changelogs
scripts/            Build and release scripts, signing, versioning, and COS publishing
build/              App icons and packaging resources
```

### Tech stack and architecture

| Layer | Technology |
|----|------|
| Desktop framework | [Electron](https://www.electronjs.org/) |
| Frontend | [React](https://reactjs.org/) + [TypeScript](https://www.typescriptlang.org/) |
| Build tooling | [Vite](https://vitejs.dev/) + vite-plugin-electron |
| UI | [Mantine](https://mantine.dev/) + [Tailwind CSS](https://tailwindcss.com/) |
| Packaging | electron-builder |

```text
┌─────────────────────────────────────────────────────────┐
│                           Qclaw                         │
│                                                         │
│  ┌──────────────────┐         ┌──────────────────────┐  │
│  │   Main Process   │         │  Renderer Process    │  │
│  │   (Node.js)      │   IPC   │  (Chromium)          │  │
│  │                  │◄───────►│                      │  │
│  │  ┌────────────┐  │         │  ┌────────────────┐  │  │
│  │  │  cli.ts    │  │         │  │  React + Vite  │  │  │
│  │  │  OpenClaw  │  │         │  │  Mantine + TW  │  │  │
│  │  │  CLI calls │  │         │  │                │  │  │
│  │  └─────┬──────┘  │         │  │  Wizard pages  │  │  │
│  │        │         │         │  │  Dashboard     │  │  │
│  │  ┌─────▼──────┐  │         │  └────────────────┘  │  │
│  │  │ System     │  │         │                      │  │
│  │  │ file I/O   │  │         └──────────────────────┘  │
│  │  │ processes  │  │                                   │
│  │  └────────────┘  │                                   │
│  └──────────────────┘                                   │
│                                                         │
│           │                                             │
│           ▼                                             │
│  ┌──────────────────┐                                   │
│  │  OpenClaw CLI    │                                   │
│  │  ~/.openclaw/    │                                   │
│  └──────────────────┘                                   │
└─────────────────────────────────────────────────────────┘
```

## Known Issues

- This document tracks the current known limitations and bugs
- Please check [Issues](https://github.com/qiuzhi2046/Qclaw/issues) for specific bug reports and feature requests

## Supported Platforms

- macOS 11 (Big Sur)+
- Windows 10+ (x64), currently in active development
- Linux, planned

## Contributing

We welcome everyone with ideas and a willingness to contribute to Qclaw. It is thanks to contributors like you that this project continues to improve.

This guide will help you understand how to get involved in the project. Whether you want to report a bug, propose a new feature, or submit code, you are very welcome here.

We also actively welcome contributions created with AI coding tools. You do not need to be a professional developer to contribute something valuable.

If Qclaw becomes your first open-source contribution, we would be happy to see it happen here.

Contribution guide:

Beginner-friendly contribution guide:

## Community

- **Qclaw open-source community group**

<p>
  <img src="docs/images/feishu_qrcode.png" alt="Qclaw community QR code" height="180">
</p>

### Community guidelines

- Respect every participant
- Keep discussions friendly and constructive
- Feel free to ask questions and help others

### Social media

[![Bilibili][bilibili-shield]][bilibili-url]
[![Douyin][douyin-shield]][douyin-url]
[![Xiaohongshu][xiaohongshu-shield]][xiaohongshu-url]
[![YouTube][youtube-shield]][youtube-url]

**WeChat official account**

<p>
  <img src="docs/images/wechat-search.png" alt="Search Qclaw on WeChat" height="120">
</p>

## Join Us

We welcome developers and related talent to join us. Please send your resume to: join@qiuzhi2046.com

We may not offer the benefits of a large company yet, but we can offer a focused environment with minimal process overhead and unrestricted access to AI tooling.

If you love AI and have a bit of a builder's spirit, do not hesitate—send us your resume.

## License

Distributed under the Apache-2.0 License. See [LICENSE](LICENSE) for details.

## Contributors

See the contributors list on GitHub:

- https://github.com/qiuzhi2046/Qclaw/graphs/contributors

## Acknowledgements

Thanks to OpenClaw. Without it, Qclaw would not exist. We are simply building a more approachable bridge on top of something powerful.

Thanks to Electron, React, Vite, Mantine, and the many open-source authors whose work makes this project possible.

Thanks to everyone who joined the internal test phase. Every bug report and suggestion helped improve the product.

<p align="center">
  <img src="src/assets/feedback10_users.png" alt="Internal test users" />
</p>

More names: [Feedback users, in no particular order](docs/feedback_users)

Finally, thanks to everyone willing to try, share, and bring more warmth to technology.

### Open-source projects used by this repository

| Repository | Author | Package |
|------|------|--------|
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | OpenClaw | openclaw (CLI) |
| [electron/electron](https://github.com/electron/electron) | Electron Community | electron |
| [facebook/react](https://github.com/facebook/react) | Meta | react, react-dom |
| [mantinedev/mantine](https://github.com/mantinedev/mantine) | Vitaly Rtishchev | @mantine/core, @mantine/modals, @mantine/notifications |
| [vitejs/vite](https://github.com/vitejs/vite) | Evan You | vite |
| [tailwindlabs/tailwindcss](https://github.com/tailwindlabs/tailwindcss) | Tailwind Labs | tailwindcss |
| [electron-userland/electron-builder](https://github.com/electron-userland/electron-builder) | Vladimir Krivosheev | electron-builder, electron-updater |

<a href="docs/quotes.md">View all referenced open-source projects &raquo;</a>

[electron-badge]: https://img.shields.io/badge/Electron-47848F?style=for-the-badge&logo=electron&logoColor=white
[electron-url]: https://www.electronjs.org/
[react-badge]: https://img.shields.io/badge/React-61DAFB?style=for-the-badge&logo=react&logoColor=black
[react-url]: https://reactjs.org/
[vite-badge]: https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white
[vite-url]: https://vitejs.dev/
[mantine-badge]: https://img.shields.io/badge/Mantine-339AF0?style=for-the-badge&logo=mantine&logoColor=white
[mantine-url]: https://mantine.dev/
[tailwind-badge]: https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white
[tailwind-url]: https://tailwindcss.com/
[bilibili-shield]: https://img.shields.io/badge/Bilibili-00A1D6?style=for-the-badge&logo=bilibili&logoColor=white
[bilibili-url]: https://space.bilibili.com/385670211
[douyin-shield]: https://img.shields.io/badge/Douyin-000000?style=for-the-badge&logo=tiktok&logoColor=white
[douyin-url]: https://www.douyin.com/user/MS4wLjABAAAAwbbVuf1W2DdgRe0xCa0oxg1ZIHbzuiTzyjq3NcOVgBuu6qIidYlMYqbL3ZFY2swu
[xiaohongshu-shield]: https://img.shields.io/badge/Xiaohongshu-FF2442?style=for-the-badge&logo=xiaohongshu&logoColor=white
[xiaohongshu-url]: https://www.xiaohongshu.com/user/profile/63b622ab00000000260066bd
[youtube-shield]: https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white
[youtube-url]: https://www.youtube.com/@qiuzhi2046
