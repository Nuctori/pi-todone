# pi-todone

todo 状态机守护：完成义务闸 + 树完整性 + 证明点协议 + 并行建议。针对 AI 长自主任务偷懒（提前停、空转、随便 done、不拆任务、埋头苦等）的最小干预。

- **格式闸**：`todo` 标 `completed` 必须附 `metadata.evidence`（JSON），格式不合规 → **block**（宽容归一化，无法归一化才 block）；同一任务同一原因连续 block ≥2 次 → block 消息附强提示（停止重试同格式 / 标回 pending 逃生口），防模型反复重试同一违规烧工具预算
- **树完整性**：子节点挂到不存在的父 → block；父 `completed` 时子任务未完成 → block（目标不能假完成）
- **证明点协议**：agent 空闲且有 pending todo → 注入"证明本轮进展 | 说明卡点 | 继续"；连续无进展 → 触发重新审视树结构
- **创建义务**：复杂任务（本单元 ≥200 次工具调用）但完全没拆 todo → 注入"请先拆 todo"（树形 + 粒度规范）；小任务豁免
- **并行建议**：依赖未完成就开工 → 确认提示；subagent/长命令等待期间 → 提示推进无依赖任务
- **验证义务**：格式合规的完成项 → 注入"请 spawn fresh reviewer 独立验证"，由 subagent 系 LLM 做语义判断
- **硬门禁（gate 原语）**：create 时可声明 `metadata.gate`（`{"test":true}` / `"audit"` / `["test","audit"]`）；test → 完成证据必须含 cmd 且 exit 显式为 0；audit → 必须含 review 交叉审计证据（agent+path）；不满足 → block。声明即义务，防"忘了这个节点要特殊证明"（拦忘记/格式错，不拦谎报——真实性由验证义务的 fresh reviewer 复核）

插件只做**确定性校验**（零 LLM 成本、永不幻觉）。语义验证 → 独立 subagent（防共谋）。

## 设计哲学

### 一个工具做一件事

pi-todone 的语义边界只有一条：**todo 的完成义务**。围绕 todo 的其他职责刻意留在外面：

| 职责 | 语义 | 归属 |
| --- | --- | --- |
| todo 义务（evidence 格式、树完整性、空闲注入、停滞检测、并行建议） | 机械、可判定 | **本插件**（硬闸 + 建议） |
| 结构规范（结果导向、依赖显式、卡点重规划） | 语义、不可判定 | **pi-todone skill**（规范层，AI 自觉） |
| 目标理解（用户要什么、什么算达成） | 语义 | **AI + 用户验收**（不依赖任何其他插件） |

边界原则：**能强制的做进工具，不能强制的放规范层，语义理解留给 AI 与审计**。把不可判定的结构/目标规则做成"门禁"是伪门禁——启发式必误报，真判定要 LLM（那就不是插件，是又一个审计 agent）。

### 证明义务在 AI 侧（burden of proof）

- 插件**不验证真实性，只校验格式**：AI 必须提交证明才能 done，证明内容（path/cmd）由 AI 自己负责
- 格式闸拦不住"格式合规的假证据"——语义真实性靠独立 subagent 验证（fresh context 隔离，防同模型共谋）
- **宽容归一化**：模型构造嵌套 JSON 参数能力弱，常见偏差（单对象、字符串、缺 kind、裸命令）自动修复；只有完全无法归一化才 block。教学循环不该退化成试错循环

### 缓存安全

- 动态内容（任务 id、计数、时间）一律走消息通道（customType 注入），**永不碰 system prompt**——任何动态注入都会破坏缓存前缀
- 注入消息带 `customType` 标记，静默/单元统计排除自身（防自反馈循环）

### 小任务豁免

完成义务只对"已创建的 todo"生效；创建义务只对复杂任务触发。避免两个极端：不列（数据：flash 仅 8% 单元用 todo）与噪音（每个小活都列）。

### 诚实边界

- todo 状态是 AI 自报的——本插件管"完成义务"，管不了"todo 之外的漏做"（那是声称审计的事）
- `effect` 类是**诚实出口**：block 它没意义（模型会改编 state 证据更糟），给一条不编造的路径反而对
- 卡点检测是"触发"不是"教学"：停滞时要求 AI 重新审视结构，怎么重规划在 skill

## 三层知识架构（缓存安全）

| 层 | 通道 | 内容 | 缓存影响 |
| --- | --- | --- | --- |
| L1 常驻 | `before_agent_start` → `promptGuidelines` 追加**编译期常量** | 2 行义务摘要 | ✅ 静态字节 → 缓存命中 |
| L2 按需 | `~/.agents/skills/pi-todone/SKILL.md` | 完整规则：粒度判定、evidence 格式、结构三原则、验证流程 | ✅ 不触发不加载 |
| L3 强制 | block reason + agent_end 注入（customType 消息，`triggerTurn` 自动继续） | 违规时现场教 + 继续义务 | ✅ 走消息通道，不碰 system prompt |

## 安装

```bash
pi install npm:pi-todone
```

## 证明格式

todo 标 completed 时在 `metadata.evidence` 提交：

```json
{ "kind": "state",    "evidence": [{"type": "file", "path": "src/a.ts", "op": "edit"}] }
{ "kind": "runnable", "evidence": [{"type": "cmd",  "cmd": "npm test", "exit": 0}] }
{ "kind": "effect",   "evidence": [] }
```

| kind | 含义 | 格式闸 |
| --- | --- | --- |
| `state` | "X 文件已改" | ≥1 条 file 证据（path 必填，op ∈ write/edit/delete） |
| `runnable` | "测试通过/构建成功" | ≥1 条 cmd 证据（cmd 必填，exit 可选数字） |
| `effect` | "性能提升/更清晰" | 不拦截，留人工验收 |
| review | 交叉审计（gate.audit 用） | agent+path 必填；可附加在任何 kind 的证据数组里 |

常见偏差自动归一化：evidence 单对象、字符串 JSON、缺 kind（按条目推断）、裸命令文本、条目缺 type。只有完全无法归一化才 block（reason 含完整格式）。

## 硬门禁（gate 原语）

某些节点需要**硬证明义务**（必须跑通测试 / 必须交叉审计）时，create 时声明，完成时插件机械校验：

```json
{ "action": "create", "subject": "实现 X", "metadata": { "gate": {"test": true, "audit": true} } }
```

| gate | 完成证据要求 |
| --- | --- |
| `test` | ≥1 条 cmd 证据且 exit 显式为 0（普通 runnable 只要求 exit 是数字，gate 加严） |
| `audit` | ≥1 条 `{"type":"review","agent":"<复核者>","path":"<评审产物>"}` |

- 不满足 → **block**（与 evidence 格式闸、树完整性叠加）
- gate 节点完成 → 验证义务注入**提升为必复核**（点名硬门禁义务），由 fresh-context reviewer 核实测试/审计证据真实性
- gate 与 `blockedBy` 正交：blockedBy 管顺序（依赖就绪），gate 管完成条件（证明义务）——组合即 todo 里的工作流
- 防伪边界：gate 是机械校验，拦"忘记附证据/格式错"，拦不住"谎报 exit 0"——真实性靠验证义务的独立复核兜底（插件从不验证真实性，见设计哲学）

## 防循环

- 停滞检测：todo 计数连续 N 轮不变（默认 3）→ 注入重新审视树结构（**终态通知**，之后静默等用户介入或进展，不重复催促）
- 指数退避：注入间隔 60s ×2ⁿ，上限 10min
- 同文本去重：相同注入不重复
- 交互静默：最近 2 分钟有用户消息时不注入（不打扰正常对话）
- customType 排除：注入消息带 `pi-todone` 标记，静默/单元统计跳过自身（防自反馈循环）
- 幂等注入：promptGuidelines 同文本不重复追加
- block-storm 抑制：同一任务同一原因连续拦截计数，第 2 次起 block 消息前缀 `[第 N 次拦截同一调用]` + 逃生口（补 evidence 重试 / 标回 pending）；任何非 block 的 update 复位计数

## 配置（环境变量）

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `PI_TODONE_STALL_THRESHOLD` | 3 | 停滞几轮转卡点报告 |
| `PI_TODONE_QUIET_AFTER_MS` | 120000 | 最近用户消息距今小于此值则不注入（交互静默） |
| `PI_TODONE_CREATE_THRESHOLD` | 200 | 本单元工具调用 ≥ 此值且未拆 todo 则注入创建义务 |
| `PI_TODONE_COOLDOWN_BASE_MS` | 60000 | 退避基数 60s×2ⁿ（上限 10min 写死） |

验证义务开关（SEMANTIC_CHECK）是写死常量（要关改代码）。

## 测试

```bash
npm test    # demo 自检（79 断言）+ mock E2E（30 场景 81 断言，无模型依赖）
```

CI（GitHub Actions）：test job 必跑；real-e2e job 需仓库变量 `RUN_REAL_E2E=true` + secret `PI_E2E_API_KEY`。

## 设计边界（诚实说明）

- 格式闸拦不住"格式合规的假证据"（编造的 file/cmd 也合规）——语义真实性靠 subagent 验证，这是分层的原因
- 插件不能程序化调用 subagent 工具（pi 扩展 API 限制），验证义务通过注入交给主 agent spawn
- todo 状态是 AI 自报的——本插件管"完成义务"，管不了"todo 之外的漏做"，那是声称审计的事
- 创建义务只对"完全没拆过 todo 的复杂单元"注入；列了粗粒度 todo 的情况由 skill 粒度规范纠正（插件不判语义）
- 结构规范（结果导向/依赖/重规划）在 skill 层，不在插件——见设计哲学"一个工具做一件事"

## License

MIT
