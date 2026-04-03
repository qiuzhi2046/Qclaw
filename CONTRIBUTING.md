# 参与贡献

非常感谢你有意愿为 Qclaw 做出贡献！🎉

## 目录

<details>
<summary>点击展开</summary>
<ul>
  <li><a href="#简介">简介</a></li>
  <li><a href="#我们现在最需要什么">我们现在最需要什么</a>
    <ul>
      <li><a href="#贡献者将">贡献者将：</a></li>
      <li><a href="#我们承诺">我们承诺</a></li>
    </ul>
  </li>
  <li><a href="#现在可以领的简单任务">现在可以领的简单任务</a></li>
  <li><a href="#开发环境搭建">开发环境搭建</a>
    <ul>
      <li><a href="#前置要求">前置要求</a></li>
      <li><a href="#三步跑起来">三步跑起来</a></li>
    </ul>
  </li>
  <li><a href="#提交-pr-的流程">提交 PR 的流程</a>
    <ul>
      <li><a href="#分支命名">分支命名</a></li>
      <li><a href="#pr-描述">PR 描述</a></li>
    </ul>
  </li>
  <li><a href="#项目结构速览">项目结构速览</a></li>
  <li><a href="#代码规范">代码规范</a></li>
  <li><a href="#我们不欢迎的">我们不欢迎的</a></li>
  <li><a href="#联系我们">联系我们</a></li>
</ul>
</details>

---

## 简介

> Qclaw——你的"龙虾管家"，不用命令行，小白也能轻松玩转 OpenClaw。

目前 Qclaw 已实现安装配置、网关管理、模型切换、IM 渠道对接、skills 管理等核心功能。但我们都知道，OpenClaw 的强大远远没有被大多数人用好，原因往往是它操作太复杂。

在大家的共同开发下，Qclaw 有机会拓展并成长为最易用、最好用的 OpenClaw 开源管理工具，包括但不限于：**更直观的子 Agent 管理**、**可视化的记忆管理**、**与其他前沿 Agent 框架的打通**。

### 加入贡献者交流群

> **我们欢迎每一个致力于让前沿 AI Agent 变得更好用的朋友加入贡献者行列！**

<img src="/docs/images/feishu_contributor.png" alt="飞书贡献者交流群二维码" width="200" />


👉 扫码加入贡献者交流群，也可以在飞书上直接找我们聊。

## 我们现在最需要什么

<table>
  <tr>
    <td width="33%" valign="top">
      <h4>🪟 Windows 兼容优化</h4>
      <p>QClaw 在 Windows 上还有不少问题（路径、权限、环境检测），如果你是 Windows 用户 + 开发者，你的贡献价值巨大。</p>
    </td>
    <td width="33%" valign="top">
      <h4>🎨 UI/UX 改进</h4>
      <p>我们用 Mantine + Tailwind，有很多文案、布局、交互细节需要打磨。设计感好的前端开发者来了直接起飞。</p>
    </td>
    <td width="33%" valign="top">
      <h4>🌍 多语言 & 文档</h4>
      <p>多语言界面、国际化文档、使用教程——帮更多人用上 Qclaw。</p>
    </td>
  </tr>
</table>


### 🎁贡献者将：

- 进入核心开发者群，直接参与产品方向讨论

- Release Notes 署名致谢，秋芝 2046 团队官号致谢

- 有机会加入全职团队（我们正在招人）

- 你的每一个被合并的 PR 都会在 Changelog 里被记录，出现在 README 贡献者墙


### 🤝我们承诺

✅ 48 小时内给出第一次 Review

✅ Review 意见会具体说明原因和建议

✅ 不会让你的 PR 石沉大海


## 现在可以领的简单任务
开始前查看群里的多维表格，确保这个任务没有被其他人领取，然后在群里@任意管理员说一声，就可以开干了。

| 分类 | 可选任务 |
| --- | --- |
| 📄 文档改进 | <ul><li>README 添加常见问题 FAQ</li><li>README 添加Star History组件</li><li>补充核心函数 JSDoc 注释</li></ul> |
| 🖼️ UI 小改进 | <ul><li>按钮添加 Loading 状态</li><li>优化空状态提示文案</li><li>优化报错文案和展示</li></ul> |
| ⚙️ 小功能 | <ul><li>添加「复制日志」按钮</li><li>飞书、微信扫码创建机器人改进（改为react-qr-code）</li></ul> |
| 🔧 Bug 修复 | <ul><li>深色模式下部分文字不可见</li><li>窗口大小不记住（重启后复原）</li><li>模型添加页面，Anthropic 无法输入token</li><li>Windows 支持优化</li></ul> |

👉 完整清单持续更新中：[good first issues](docs/good-first-issues.md)

🙋 想做列表之外的事？ 欢迎！请先开一个 Issue 描述你的想法，或加入群聊后，跟社群管理员同步，确认方向后再动手。

---

## 开发环境搭建

### 前置要求
- Node.js >= 22.16.0
- Git

### 三步跑起来

1. **克隆项目并进入目录**
   ```bash
   git clone https://github.com/qiuzhi2046/Qclaw.git
   cd Qclaw
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **开发模式运行项目**
   ```bash
   npm run dev
   ```

> Windows 用户注意：如果 npm install 报错，大概率是缺少构建工具。请先安装 Visual Studio Build Tools，勾选 "C++ 桌面开发"。

---

## 提交 PR 的流程
1. 🍴 **Fork 仓库**：将本仓库 Fork 到你的 GitHub 账号下。

2. 🌿 **切出分支**：从主分支切出一个新的分支进行开发。

3. 💻 **本地开发**：在本地进行代码修改并完成测试。

4. 📤 **提交推送**：提交代码更改，并推送到你的 Fork 仓库。

5. 🔄 **提交 PR**：在 GitHub 上向本仓库提交 Pull Request。

6. 👀 **等待合并**：等待 Reviewer 审核并合并你的代码。

### 分支命名
使用以下格式命名分支，以便于管理和追溯：
- `fix/issue编号-简短描述 — Bug 修复`
- `feat/功能名 - 新功能`
- `docs/改了什么 - 文档`
- `ui/页面名-改了什么 - UI 调整`

### PR 描述
> 我们已经提供了[PR模板](.github/pull_request_template.md)，在提交PR时请尽量按模板填写。

请确保在 PR 描述中清晰地说明本次更改的目的、更改了什么，以及测试情况，帮助 Reviewer 更快理解你的代码，提高通过率。

---

## 项目结构速览

```text

Qclaw/
├── electron/          # Electron 主进程
│   └── main/          # IPC handlers、CLI 交互、安装逻辑
├── src/               # React 渲染层
│   ├── pages/         # 页面组件
│   ├── shared/        # 共享逻辑
│   └── lib/           # 工具库
├── scripts/           # 构建脚本
├── build/             # 打包配置
└── docs/              # 文档和图片

```

---

## 代码规范
- TypeScript 严格模式 — 不要用 any
- React 函数组件 + Hooks — 不要用 class 组件
- UI 框架：Mantine v7 + Tailwind CSS
- 避免直接改 electron/main/ 下的核心安装逻辑 — 这部分牵一发动全身，改之前先开 Issue 讨论

### Commit 提交规范
本项目遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范。提交信息请参考以下格式前缀：
- `feat:` 新增功能
- `fix:` 修复 Bug
- `docs:` 仅修改文档（如 README, CONTRIBUTING 等）
- `style:` 代码格式修改（不影响代码运行的变动，如空格、格式化、缺失的分号等）
- `refactor:` 代码重构（即不是新增功能，也不是修改 bug 的代码变动）
- `perf:` 提升性能的代码修改
- `test:` 添加或修改测试用例
- `chore:` 构建过程或辅助工具和库的变动

---

## 我们不欢迎的
- 未经讨论的大型重构 PR
- 与项目方向不符的改动
- 破坏兼容性且没有迁移方案的变更
- AI 生成的低质量 PR（我们鼓励用 AI 辅助，但请确保你理解AI生成的代码）

---

## 联系我们

<img src="/docs/images/feishu_contributor.png" alt="飞书贡献者交流群二维码" width="200" />

- GitHub Issues：[提 Bug](https://github.com/qiuzhi2046/Qclaw/issues/new?template=bug_report.yml) · [提需求](https://github.com/qiuzhi2046/Qclaw/issues/new?template=feature_request.yml) · [提问题](https://github.com/qiuzhi2046/Qclaw/issues/new?template=question.yml)

- 贡献者群：扫码加入（见上方二维码）
- 许可：提交代码即表示同意以 Apache License 2.0 开源

你的每一个 PR 都在让 Qclaw 变得更好，帮助更多人轻松驾驭 Agent。期待在 README 看到你的头像！ 🐾
