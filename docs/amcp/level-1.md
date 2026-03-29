# AMCP Conformance Tests — Level 1 / Level-1 一致性测试
## Basic Conformance / 基础一致性

**Requirement / 要求**: Pass all 8 tests to claim Level-1 AMCP conformance.  
通过全部8项测试以声明 Level-1 AMCP 兼容性。

**Registration / 注册**: Submit results to [`stepmind/amcp-registry`](https://github.com/stepmind/amcp-registry).  
将结果提交至 [`stepmind/amcp-registry`](https://github.com/stepmind/amcp-registry)。

---

## T1-01 — Frame Magic Bytes / 帧魔数验证

**MUST**: All frames sent by the node MUST begin with magic bytes `0x414D4350` ("AMCP").  
所有节点发送的帧必须以魔数 `0x414D4350`（"AMCP"）开头。

**Test procedure / 测试步骤**:
1. Capture any frame sent by the implementation under test  
   捕获被测实现发送的任意帧
2. Read bytes 0–3  
   读取字节 0–3
3. **PASS** if `bytes[0:4] == b'AMCP'` / 若等于 `b'AMCP'` 则**通过**

**Violation response / 违规处理**: Receiving node MUST return `0x00FF` and disconnect.  
接收节点必须返回 `0x00FF` 并断开连接。

---

## T1-02 — Capability Hello / 能力声明

**MUST**: Upon establishing a connection, the node MUST send a `CAPABILITY_HELLO` frame (MSG_TYPE `0x0040`) before any other message type.  
建立连接后，节点必须在发送任何其他消息类型之前发送 `CAPABILITY_HELLO` 帧（MSG_TYPE `0x0040`）。

**Test procedure / 测试步骤**:
1. Initiate a connection to the node under test  
   向被测节点发起连接
2. Capture the first frame received  
   捕获收到的第一帧
3. **PASS** if MSG_TYPE == `0x0040` / 若 MSG_TYPE == `0x0040` 则**通过**

**Required fields in payload / payload 必需字段**:
- `amcp_version`: string matching `^\d+\.\d+\.\d+$`
- `node_type`: one of `["ai", "db", "gateway", "bridge", "relay"]`
- `public_key`: non-empty string
- `trust_level`: one of `["local", "verified", "federated"]`

---

## T1-03 — Protocol Violation Response / 协议违规响应

**MUST**: When the node receives a frame with an invalid magic number, it MUST respond with MSG_TYPE `0x00FF` and MUST close the connection.  
当节点收到魔数无效的帧时，必须响应 MSG_TYPE `0x00FF` 并关闭连接。

**Test procedure / 测试步骤**:
1. Connect to the node  
   连接到节点
2. Send a frame with bytes `0x00000000` in place of the magic bytes  
   发送魔数位置为 `0x00000000` 的帧
3. **PASS** if: (a) response MSG_TYPE == `0x00FF`, AND (b) connection closes within 5 seconds  
   若：(a) 响应 MSG_TYPE == `0x00FF`，且 (b) 连接在5秒内关闭，则**通过**

---

## T1-04 — AMF Schema Validation / AMF 格式验证

**MUST**: The node MUST reject any MEMORY_WRITE (`0x0012`) payload that does not conform to AMF v1.0 schema.  
节点必须拒绝任何不符合 AMF v1.0 schema 的 MEMORY_WRITE（`0x0012`）payload。

**Test procedure / 测试步骤**:
1. Send a MEMORY_WRITE frame with a payload missing the required field `core.subject`  
   发送缺少必需字段 `core.subject` 的 MEMORY_WRITE 帧
2. **PASS** if response status code == `400` (MALFORMED_AMF) / 若响应状态码 == `400` 则**通过**

**Required AMF fields for PASS / 通过所需的 AMF 必需字段**:
- `knowledge_id`, `amf_version`, `type`, `core.subject`, `core.predicate`, `core.object`, `core.confidence`, `meta.created_at`, `meta.created_by`, `meta.project_scope`, `integrity.checksum`

---

## T1-05 — Knowledge Immutability / 知识不可变性

**MUST**: The node MUST reject any request to directly modify an existing knowledge record. Updates must be expressed as new records superseding old ones.  
节点必须拒绝任何直接修改现有知识记录的请求。更新必须以新记录取代旧记录的方式表达。

**Test procedure / 测试步骤**:
1. Write a knowledge record with `knowledge_id = K-abc`  
   写入一条 `knowledge_id = K-abc` 的知识记录
2. Attempt to overwrite it with a MEMORY_WRITE using the same `knowledge_id` but different `core.object`  
   尝试用相同 `knowledge_id` 但不同 `core.object` 的 MEMORY_WRITE 覆盖它
3. **PASS** if: response status == `409` (CONFLICT) OR `201` (new version created with `causal.supersedes = K-abc`)  
   若响应状态为 `409` 或 `201`（含 `causal.supersedes = K-abc` 的新版本）则**通过**

---

## T1-06 — State Machine Enforcement / 状态机约束

**MUST**: The node MUST reject requests that represent invalid state machine transitions.  
节点必须拒绝表示无效状态机转换的请求。

**Test procedure / 测试步骤**:
1. Connect to the node but do NOT complete the CAPABILITY_HELLO handshake  
   连接到节点但不完成 CAPABILITY_HELLO 握手
2. Send a MEMORY_READ (`0x0010`) frame immediately  
   立即发送 MEMORY_READ（`0x0010`）帧
3. **PASS** if response is status `702` (COLD_BOOT_REQUIRED) OR `0x00FF` (PROTOCOL_VIOLATION)  
   若响应为状态 `702` 或 `0x00FF` 则**通过**

---

## T1-07 — Checksum Silent Discard / 校验失败静默丢弃

**MUST**: Frames with invalid CRC-32C checksums MUST be silently discarded. The node MUST NOT respond with an error, to prevent amplification attacks.  
CRC-32C 校验失败的帧必须被静默丢弃。节点不得响应错误，以防止放大攻击。

**Test procedure / 测试步骤**:
1. Send a well-formed frame with the checksum field deliberately corrupted  
   发送一个格式正确但校验和字段被故意破坏的帧
2. Wait 5 seconds  
   等待5秒
3. **PASS** if no response is received within 5 seconds  
   若5秒内未收到响应则**通过**

---

## T1-08 — Content-Addressed Knowledge ID / 内容寻址知识ID

**MUST**: The `knowledge_id` of any AMF record MUST equal `K-{SHA-256(canonical_msgpack(core + meta.created_at + meta.created_by))}`.  
任何 AMF 记录的 `knowledge_id` 必须等于 `K-{SHA-256(canonical_msgpack(core + meta.created_at + meta.created_by))}`。

**Test procedure / 测试步骤**:
1. Write a knowledge record and capture the `knowledge_id` returned  
   写入一条知识记录并捕获返回的 `knowledge_id`
2. Locally compute the expected `knowledge_id` from the same payload  
   从相同 payload 本地计算期望的 `knowledge_id`
3. **PASS** if returned `knowledge_id` == locally computed value  
   若返回的 `knowledge_id` == 本地计算值则**通过**

---

## Reporting Results / 报告结果

Submit your implementation's conformance report to [`stepmind/amcp-registry`](https://github.com/stepmind/amcp-registry) as a new issue using the template provided there.  
使用提供的模板，以新 issue 形式将你的实现一致性报告提交至 [`stepmind/amcp-registry`](https://github.com/stepmind/amcp-registry)。

Include: / 包括：
- Implementation name and language / 实现名称和语言
- Repository link / 仓库链接
- Test results for each T1-XX / 每个 T1-XX 的测试结果
- Automated test runner output (if available) / 自动测试运行器输出（如有）

---

*AMCP Conformance Test Suite v1.0 · StepMind Community*
