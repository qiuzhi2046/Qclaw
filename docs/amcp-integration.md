# AMCP Protocol Integration Proposal

> **AMCP (AI Memory Communication Protocol)** — 让 Qclaw 成为首个支持 AI 记忆协议的桌面管理工具  
> 协议规范: [stepmind-amcp/amcp](https://github.com/stepmind-amcp/amcp) · 社区: [stepmind-amcp.github.io](https://stepmind-amcp.github.io/)

---

## 为什么 Qclaw 需要 AMCP？

Qclaw 是 OpenClaw 的图形化管理界面，让小白用户也能轻松管理 AI 助手。但目前有一个核心缺口：

**AI 助手的记忆是黑盒。**

用户不知道 AI 积累了什么知识、哪些经验在起作用、记忆如何衰减和演化。AMCP 协议正是为此而生——它定义了 AI 记忆的标准化表示、存储和查询方式。

## AMCP 是什么？

AMCP 是一套完整的 **7 层开放协议**，用于 AI 节点与记忆基础设施之间的通信：

| 层级 | 名称 | 核心能力 |
|------|------|---------|
| L7 | 语义应用层 | AMQL 查询 · 进化信号 · 工作流 |
| L6 | 记忆表达层 | AMF 格式 · 7种知识类型 · SPO 三元组 |
| L5 | 一致性层 | 混合逻辑时钟 · 因果图 · 状态机 |
| L4 | 路由调度层 | CSE · ROI 排序 · 上下文窗口分配 |
| L3 | 传输可靠层 | 50B 二进制帧 · CRC-32C · AES-256-GCM |
| L2 | 分布式存储层 | 端/边/云三层 · Gossip 同步 |
| L1 | 身份寻址层 | amcp:// URI · 能力声明 · 信任锚 |

**关键特性：**
- **AMF 知识格式** — 7 种结构化知识类型（FACT / PITFALL / PATTERN / DECISION / PROCEDURE / HEURISTIC / CONSTRAINT）
- **内容寻址** — 每条知识有唯一 content-addressed ID，不可篡改
- **衰减模型** — 知识按使用频率和时间自然衰减，模拟真实记忆
- **0 厂商锁定** — 任何 AI × 任何 AMCP 兼容存储 = 互操作

## 对 Qclaw 的价值

### 1. 差异化竞争力

当前 OpenClaw 生态的 GUI 工具只有 Qclaw。加入 AMCP 支持将使 Qclaw 从「安装向导」升级为「AI 记忆管理平台」，建立不可替代的技术护城河。

### 2. 用户价值

- **记忆可视化** — 用户可以直观看到 AI 积累了什么知识
- **知识管理** — 浏览、搜索、导出 AI 的结构化记忆
- **存储配置** — 图形化配置端/边/云三层存储策略

### 3. 社区联动

AMCP 社区（[stepmind-amcp.github.io](https://stepmind-amcp.github.io/)）正在构建多语言实现。Qclaw 作为首个桌面端集成，将获得：
- AMCP 社区的开发者流量和贡献者
- 在 AMCP 生态展示页的优先展示
- 协议规范制定的参与权

## 集成方案

### Phase 1: 协议规范集成（本 PR）

- ✅ 将 AMCP 协议规范文档引入 Qclaw docs
- ✅ 在 README 中添加 AMCP 生态说明
- ✅ 建立 AMCP 集成的技术基础

### Phase 2: AMF 知识浏览器（后续）

- 新增 `Memory` 页面，展示 AI 的结构化知识
- 支持按类型过滤（FACT / PATTERN / DECISION 等）
- SPO 三元组可视化
- 内容寻址 ID 和时间线展示

### Phase 3: 存储管理（后续）

- 端/边/云存储连接配置
- AMQL 查询接口
- 知识导入/导出

## 相关资源

| 资源 | 链接 |
|------|------|
| AMCP 协议规范 | [stepmind-amcp/amcp/spec](https://github.com/stepmind-amcp/amcp/tree/main/spec) |
| AMCP 社区网站 | [stepmind-amcp.github.io](https://stepmind-amcp.github.io/) |
| Level-1 一致性测试 | [conformance/level-1.md](https://github.com/stepmind-amcp/amcp/blob/main/spec/conformance/level-1.md) |
| Python 实现 | [stepmind/amcp-python](https://github.com/stepmind-amcp/amcp-python) |
| 协议对比 (AMCP vs MCP) | [comparison.md](https://github.com/stepmind-amcp/amcp/blob/main/docs/comparison.md) |

## 许可证

AMCP 协议采用 **Apache 2.0** 许可证，与 Qclaw 一致，无许可证冲突。

---

*本提案由 StepMind 社区提交，欢迎讨论和反馈。*
