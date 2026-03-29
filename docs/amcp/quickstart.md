# Quick Start / 快速开始

Get familiar with AMCP in 15 minutes.  
15分钟了解 AMCP。

---

## Step 1: Understand the Core Concepts / 理解核心概念

AMCP has three fundamental objects: / AMCP 有三个基本对象：

**Node / 节点** — An AMCP participant. Either an AI node or a DB node.  
一个 AMCP 参与者，是 AI 节点或 DB 节点。

```
amcp://ai.myapp.v1.fp-abc123.local      ← AI node / AI节点
amcp://db.mystore.sqlite-v3.fp-def456.local ← DB node / DB节点
```

**Knowledge (AMF) / 知识** — A structured piece of information with type, SPO triple, confidence, and decay.  
一条结构化信息，包含类型、主谓宾三元组、置信度和衰减模型。

```json
{
  "knowledge_id": "K-a3f9c2...",
  "type": "KT-FACT",
  "core": {
    "subject": "Python.Division.Result",
    "predicate": "EQUALS",
    "object": "float",
    "confidence": 0.99
  },
  "meta": {
    "created_at": "2026-03-18T00:00:00Z",
    "created_by": "amcp://ai.myapp.v1.fp-abc123.local",
    "project_scope": ["*"],
    "decay_model": { "type": "none" }
  }
}
```

**Session / 会话** — A lifecycle: HANDSHAKING → COLD_BOOTING → ACTIVE → TERMINATED.  
一个生命周期：握手 → 冷启动 → 活跃 → 终止。

---

## Step 2: Read the Spec / 阅读规范

The full specification is in [`spec/AMCP_v1.0.json`](../spec/AMCP_v1.0.json).  
完整规范见 [`spec/AMCP_v1.0.json`](../spec/AMCP_v1.0.json)。

Key sections: / 关键章节：

| Section | Key content / 关键内容 |
|---------|----------------------|
| `L1_identity_addressing` | Node URI format, capability declaration / 节点URI格式、能力声明 |
| `L3_reliable_transport` | Binary frame format, MSG_TYPE enum / 二进制帧格式、MSG_TYPE枚举 |
| `L6_memory_representation` | AMF schema, 7 knowledge types / AMF schema、7种知识类型 |
| `conformance` | 24 tests across 3 levels / 3个级别共24项测试 |

---

## Step 3: Implement Level-1 / 实现 Level-1

The 8 Level-1 tests cover the bare minimum for interoperability.  
8项 Level-1 测试覆盖互操作的最低要求。

### Minimum frame encoder (Python pseudocode) / 最小帧编码器（Python伪代码）

```python
import struct
import zlib
import msgpack

AMCP_MAGIC = b'AMCP'  # 0x414D4350

def encode_frame(msg_type: int, payload: dict, session_id: bytes = b'\x00'*16) -> bytes:
    payload_bytes = msgpack.packb(payload)
    
    header = struct.pack(
        '>4sHHHI QQ 16s Q',
        AMCP_MAGIC,           # Magic (4 bytes)
        0x0100,               # Version 1.0 (2 bytes)
        msg_type,             # MSG_TYPE (2 bytes)
        0x0000,               # FLAGS (2 bytes)
        len(payload_bytes),   # PAYLOAD_LENGTH (4 bytes)
        0,                    # SEQUENCE_NUMBER (8 bytes)
        0,                    # CAUSAL_CLOCK (8 bytes) — increment per send
        session_id,           # SESSION_ID (16 bytes)
        0,                    # CHECKSUM placeholder (8 bytes, includes 4B HLC + 4B CRC)
    )
    # CRC-32C over header + payload, written into bytes 46-49
    frame = header + payload_bytes
    crc = zlib.crc32(frame) & 0xFFFFFFFF
    frame = frame[:46] + struct.pack('>I', crc) + frame[50:]  # inject CRC
    return frame

MSG_CAPABILITY_HELLO = 0x0040

capability_hello = {
    "amcp_version": "1.0.0",
    "node_type": "ai",
    "node_address": "amcp://ai.myapp.v1.fp-abc123.local",
    "public_key": "base64-ed25519-pubkey",
    "trust_level": "local",
    "capabilities": {
        "memory_read": True,
        "memory_write": True,
        "max_context_tokens": 128000,
        "supported_amf_versions": ["1.0"]
    }
}

frame = encode_frame(MSG_CAPABILITY_HELLO, capability_hello)
# Send frame on connection / 连接后发送此帧
```

---

## Step 4: Test Your Implementation / 测试你的实现

Run the conformance tests against your node:  
对你的节点运行一致性测试：

```bash
# Conformance test runner — coming in v1.0.1
# 一致性测试运行器 — v1.0.1 中发布

# For now, test manually against the definitions in:
# 目前，请对照以下定义手动测试：
cat spec/conformance/level-1.md
```

---

## Step 5: Register / 注册

When you pass all 8 Level-1 tests, open an issue in [`stepmind/amcp-registry`](https://github.com/stepmind/amcp-registry).  
通过全部8项 Level-1 测试后，在 [`stepmind/amcp-registry`](https://github.com/stepmind/amcp-registry) 开 issue 注册。

You'll receive: / 你将获得：
- Official AMCP Level-1 conformance badge / 官方 AMCP Level-1 兼容徽章
- Listing in the AMCP Registry / 在 AMCP 注册表中的列表
- Community recognition / 社区认可

---

## Next Steps / 下一步

- Read [`docs/why-amcp.md`](why-amcp.md) for design rationale / 阅读设计动机
- Read [`spec/conformance/level-2.md`](../spec/conformance/level-2.md) for the next challenge / 阅读下一个挑战
- Join [Discussions](https://github.com/stepmind/amcp/discussions) with questions / 有问题加入讨论区
- Follow [ROADMAP](../community/ROADMAP.md) for upcoming features / 关注路线图了解即将推出的功能

---

*StepMind Community · stepmind.org*
