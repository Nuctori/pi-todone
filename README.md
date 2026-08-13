# pi-todone

todo 完成义务闸 + 证明点协议 + 创建义务。针对 AI 长自主任务偷懒（提前停、空转、随便 done、不拆任务）的最小干预：

- **格式闸**：`todo` 标 `completed` 必须附 `metadata.evidence`（JSON），格式不合规 → **block**，AI 必须补证才能 done
- **证明点协议**：agent 空闲且有 pending todo → 注入"证明本轮进展 | 说明卡点 | 继续"；连续无进展 → 改发卡点报告（中间态交付）
- **创建义务**：复杂任务（本单元 ≥5 次工具调用）但完全没拆 todo → 注入"请先拆 todo"（带粒度规范）；小任务豁免
- **验证义务**：格式合规的完成项 → 注入"请 spawn fresh reviewer 独立验证"，由 subagent 系 LLM 做语义判断

插件只做确定性格式校验（零 LLM 成本、永不幻觉）。语义验证 → 独立 subagent（防共谋，dag-core 同款模式）。

## 三层知识架构（缓存安全）

| 层 | 通道 | 内容 | 缓存影响 |
|---|---|---|---|
| L1 常驻 | `before_agent_start` → `promptGuidelines` 追加**编译期常量** | 2 行义务摘要 | ✅ 静态字节 → system prompt 缓存命中（cacheRead） |
| L2 按需 | `~/.agents/skills/pi-todone/SKILL.md` | 完整规则：粒度判定、evidence 格式、验证流程 | ✅ 不触发不加载 |
| L3 强制 | block reason + agent_end 注入（sendUserMessage） | 违规时现场教 | ✅ 走消息通道，不碰 system prompt |

**铁律：L1 注入文本必须是编译期常量**——任何动态内容（时间戳/计数/状态）都会破坏 system prompt 缓存前缀，导致整段每轮重算。

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
| `effect` | "性能提升/更清晰" | 不拦截，留人工验收 |

## 防循环

- 停滞检测：todo 计数连续 N 轮不变（默认 3）→ 停止"继续"催促，改发卡点报告
- 指数退避：注入间隔 60s ×2ⁿ，上限 10min
- 同文本去重：相同注入不重复
- 交互静默：最近 2 分钟有用户消息时不注入（不打扰正常对话）
- 幂等注入：promptGuidelines 同文本不重复追加

## 配置（环境变量）

| 变量 | 默认 | 含义 |
|---|---|---|
| `PI_TODONE_STALL_THRESHOLD` | 3 | 停滞几轮转卡点报告（通知后静默等用户/进展，不重复催促） |
| `PI_TODONE_QUIET_AFTER_MS` | 120000 | 最近用户消息静默窗口 |
| `PI_TODONE_CREATE_THRESHOLD` | 5 | 本单元工具调用 ≥ 此值且未拆 todo 则注入创建义务 |

## 自检

```bash
npm test   # node --experimental-strip-types src/demo.ts（25 断言）
```

## 设计边界（诚实说明）

- 格式闸拦不住"格式合规的假证据"（编造的 file/cmd 也合规）——语义真实性靠 subagent 验证，这是分层的原因
- 插件不能程序化调用 subagent 工具（pi 扩展 API 限制），验证义务通过注入交给主 agent spawn
- todo 状态是 AI 自报的——本插件管"完成义务"，管不了"todo 之外的漏做"，那是声称审计的事
- 创建义务只对"完全没拆过 todo 的复杂单元"注入；列了粗粒度 todo 的情况由 skill 粒度规范纠正（插件不判语义）
