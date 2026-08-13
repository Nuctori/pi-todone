# pi-todone

todo 完成义务闸 + 证明点协议。针对 AI 长自主任务偷懒（提前停、空转、随便 done）的最小干预：

- **格式闸**：`todo` 标 `completed` 必须附 `metadata.evidence`（JSON），格式不合规 → **block**，AI 必须补证才能 done
- **证明点协议**：agent 空闲且有 pending todo → 注入"证明本轮进展 | 说明卡点 | 继续"；连续无进展 → 改发卡点报告（中间态交付）
- **语义验证外包**：格式合规的完成项 → 注入"请 spawn fresh reviewer 独立验证"义务，由 subagent 系 LLM 做语义判断（插件不做语义，保持确定性）

插件只做格式校验（零 LLM 成本、永不幻觉）。语义真实性验证 → 独立 subagent（防共谋，dag-core 同款模式）。

## 安装

```bash
pi install D:\node\pi-todone   # 或发布后 pi install npm:pi-todone
```

## 证明格式

todo 标 completed 时在 `metadata.evidence` 提交：

```json
{ "kind": "state",    "evidence": [{"type": "file", "path": "src/a.ts", "op": "edit"}] }
{ "kind": "runnable", "evidence": [{"type": "cmd",  "cmd": "npm test", "exit": 0}] }
{ "kind": "effect",   "evidence": [] }
```

| kind | 含义 | 格式闸 |
|---|---|---|
| `state` | "X 文件已改" | ≥1 条 file 证据（path 必填，op ∈ write/edit/delete） |
| `runnable` | "测试通过/构建成功" | ≥1 条 cmd 证据（cmd 必填，exit 可选数字） |
| `effect` | "性能提升/更清晰" | 不拦截，打标留人工验收 |

不合规 → `tool_call` 被 block，reason 说明缺什么。

## 防循环

- 停滞检测：todo 计数连续 N 轮不变（默认 3）→ 停止"继续"催促，改发卡点报告
- 指数退避：注入间隔 60s ×2ⁿ，上限 10min
- 同文本去重：相同注入不重复
- 交互静默：最近 2 分钟有用户消息时不注入（不打扰正常对话）

## 配置（环境变量）

| 变量 | 默认 | 含义 |
|---|---|---|
| `PI_TODONE_STALL_THRESHOLD` | 3 | 停滞几轮转卡点报告 |
| `PI_TODONE_COOLDOWN_BASE_MS` | 60000 | 注入退避基数 |
| `PI_TODONE_COOLDOWN_MAX_MS` | 600000 | 退避上限 |
| `PI_TODONE_SEMANTIC_CHECK` | 1 | 完成项是否注入验证义务 |
| `PI_TODONE_QUIET_AFTER_MS` | 120000 | 最近用户消息静默窗口 |

## 自检

```bash
npm test   # node --experimental-strip-types src/demo.ts
```

## 设计边界（诚实说明）

- 格式闸拦不住"格式合规的假证据"（编造的 file/cmd 也合规）——语义真实性靠 subagent 验证，这是分层的原因
- 插件不能程序化调用 subagent 工具（pi 扩展 API 限制），验证义务通过注入交给主 agent spawn
- todo 状态是 AI 自报的——本插件管"完成义务"，管不了"todo 之外的漏做"，那是第二层声称审计的事
