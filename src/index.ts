/**
 * pi-todone — todo 完成义务闸 + 证明点协议 + 创建义务
 *
 * 三道闸，全部挂在 pi 生命周期 hook 上，插件只做确定性格式校验：
 *
 * 1. 格式闸（tool_call）：todo 标 completed 必须附 metadata.evidence（JSON，格式校验），
 *    不合规 → block 并附 reason，AI 必须补证才能 done。
 *    语义真实性不在这里判——交给 subagent 系 LLM（agent_end 时注入验证义务）。
 *
 * 2. 证明点协议（agent_end）：agent 空闲时有 pending todo → 注入"证明本轮进展 | 说明卡点 | 继续"；
 *    已放行的完成项 → 注入"请 spawn fresh reviewer 独立验证"（一次）。
 *
 * 3. 创建义务（agent_end + before_agent_start）：
 *    - 常驻：promptGuidelines 追加静态义务摘要（L1，编译期常量，严禁动态内容——破缓存前缀）
 *    - 事后：本单元工具调用 ≥5 且未拆 todo 且无 todo 列表 → 注入"请先拆 todo"（粒度规范）
 *
 * 防循环：停滞检测（计数无进展 N 轮 → 改发卡点报告）、指数退避、同文本去重、
 *         用户最近交互时静默（不打扰正常对话）。
 *
 * 配置（环境变量，只有真正会调的 3 个）：
 *   PI_TODONE_STALL_THRESHOLD   停滞几轮转卡点报告（默认 3）
 *   PI_TODONE_QUIET_AFTER_MS    最近用户消息距今小于此值则不注入 ms（默认 120_000）
 *   PI_TODONE_CREATE_THRESHOLD  本单元工具调用 ≥ 此值且未拆 todo 则注入创建义务（默认 5）
 * 退避（60s×2ⁿ 上限 10min）与验证义务开关（SEMANTIC_CHECK）是写死常量，不需要旋钮。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PKG = "pi-todone";

interface EvidenceItem {
	type: string;
	path?: string;
	op?: string;
	cmd?: string;
	exit?: number;
}
interface Evidence {
	kind?: string;
	evidence?: EvidenceItem[];
}
interface TodoTask {
	id: number;
	subject: string;
	status: string;
}
interface SessionEntry {
	type?: string;
	timestamp?: string;
	message?: {
		role?: string;
		toolName?: string;
		details?: unknown;
		content?: unknown;
	};
}

const CFG = {
	stallThreshold: Number(process.env.PI_TODONE_STALL_THRESHOLD ?? 3),
	cooldownBaseMs: Number(process.env.PI_TODONE_COOLDOWN_BASE_MS ?? 60_000),
	quietAfterMs: Number(process.env.PI_TODONE_QUIET_AFTER_MS ?? 120_000),
	createThreshold: Number(process.env.PI_TODONE_CREATE_THRESHOLD ?? 5),
};
const COOLDOWN_MAX_MS = 600_000; // 退避上限（写死，不需要旋钮）
const SEMANTIC_CHECK = true; // 完成项注入验证义务（要关就改这里）

/** 格式闸核心：校验 evidence，合规返回 null，否则返回缺什么。纯函数，可单测。 */
export function validateEvidence(ev: unknown): string | null {
	if (!ev || typeof ev !== "object") return "evidence 缺失或非对象";
	const kind = (ev as Evidence).kind;
	const list = (ev as Evidence).evidence;
	if (kind !== "state" && kind !== "runnable" && kind !== "effect") {
		return `kind 必须是 state|runnable|effect，实际: ${String(kind)}`;
	}
	if (kind === "effect") return null; // 效果类不可硬验证，放行留人工验收
	if (!Array.isArray(list) || list.length === 0) {
		return `${kind} 类至少需要 1 条证据`;
	}
	let hasFile = false;
	let hasCmd = false;
	for (const e of list) {
		if (!e || typeof e !== "object") return "证据条目必须是对象";
		if (e.type === "file") {
			if (typeof e.path !== "string" || !e.path) return "file 证据缺 path";
			if (e.op && !["write", "edit", "delete"].includes(e.op)) {
				return `file 证据 op 非法: ${e.op}`;
			}
			hasFile = true;
		} else if (e.type === "cmd") {
			if (typeof e.cmd !== "string" || !e.cmd) return "cmd 证据缺 cmd";
			if (e.exit !== undefined && typeof e.exit !== "number") {
				return "cmd 证据 exit 必须为数字";
			}
			hasCmd = true;
		} else {
			return `证据 type 必须是 file|cmd，实际: ${String(e.type)}`;
		}
	}
	if (kind === "state" && !hasFile) return "state 类必须有 file 证据";
	if (kind === "runnable" && !hasCmd) return "runnable 类必须有 cmd 证据";
	return null;
}

/**
 * 归一化 evidence：宽容修复常见格式偏差（AI 嵌套 JSON 构造能力弱），
 * 无法归一化才返回 error。
 * - 字符串 → JSON.parse
 * - 缺 kind → 按证据条目推断（有 cmd→runnable，有 file→state）
 * - 条目缺 type → 有 cmd 字段即 cmd，有 path 即 file
 */
export function normalizeEvidence(raw: unknown): { evidence: Evidence | null; error: string | null } {
	let ev = raw;
	if (typeof raw === "string") {
		const t = raw.trim();
		if (!t) return { evidence: null, error: "evidence 缺失或非对象" };
		try {
			ev = JSON.parse(t);
		} catch {
			// 不是 JSON 字符串：可能是裸命令文本 → 包成 cmd 证据
			ev = { kind: "runnable", evidence: [{ type: "cmd", cmd: t }] };
		}
	}
	if (!ev || typeof ev !== "object") return { evidence: null, error: "evidence 缺失或非对象" };
	// 顶层就是单条目（{cmd:...} 或 {type:"file",path:...}）→ 包成 {evidence:[条目]}
	const asObj = ev as Record<string, unknown>;
	if (!("evidence" in asObj) && ("cmd" in asObj || "path" in asObj || "type" in asObj)) {
		ev = { evidence: [ev] };
	}
	const e = ev as Evidence;
	let list = e.evidence;
	if (list && typeof list === "object" && !Array.isArray(list)) {
		// 单对象（AI 最常见偏差：{cmd:...} 或 {type:"file",path:...}）→ 包成数组
		list = [list];
		e.evidence = list;
	}
	if (!Array.isArray(list)) return { evidence: null, error: "evidence.evidence 必须是数组" };
	// 条目缺 type → 推断
	for (const item of list) {
		if (item && typeof item === "object" && !item.type) {
			if (typeof item.cmd === "string") item.type = "cmd";
			else if (typeof item.path === "string") item.type = "file";
		}
	}
	// 缺 kind → 推断
	if (!e.kind) {
		const hasCmd = list.some((it) => it && it.type === "cmd");
		const hasFile = list.some((it) => it && it.type === "file");
		if (hasCmd) e.kind = "runnable";
		else if (hasFile) e.kind = "state";
	}
	const err = validateEvidence(e);
	return err ? { evidence: null, error: err } : { evidence: e, error: null };
}

const EVIDENCE_GUIDE = `todo 标 completed 必须附 metadata.evidence（JSON），格式：
  {"kind":"state","evidence":[{"type":"file","path":"src/a.ts","op":"edit"}]}
  {"kind":"runnable","evidence":[{"type":"cmd","cmd":"npm test","exit":0}]}
  {"kind":"effect","evidence":[]}   ← 不可硬验证，仅声明，留人工验收`;

/** L1 常驻义务摘要：编译期常量，严禁任何动态内容（字节变化会破 system prompt 缓存前缀）。 */
const TODO_DUTY_LINE =
	"Todo 义务（pi-todone）：复杂任务（多文件/3+ 步骤/长任务）开始前先拆 todo，每项是一个可独立验证的结果（≤ 一句话）；小任务（单文件小改/问答）无需列。标 todo completed 必须附 metadata.evidence（state→file 证据 / runnable→cmd 证据 / effect 留人工验收）；详见 pi-todone skill。";

/** 扫描会话分支，返回最新 todo 工具结果快照（todo-enforcer 同款模式，纯读）。 */
export function scanTodoSnapshot(branch: SessionEntry[]): { tasks: TodoTask[] } | null {
	let latest: { tasks: TodoTask[] } | null = null;
	for (const entry of branch) {
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
		let d = msg.details as { tasks?: unknown } | { details?: { tasks?: unknown } } | undefined;
		if (d && !Array.isArray((d as { tasks?: unknown }).tasks) && (d as { details?: unknown }).details) {
			d = (d as { details?: { tasks?: unknown } }).details as { tasks?: unknown };
		}
		if (d && Array.isArray((d as { tasks?: unknown }).tasks)) {
			latest = d as { tasks: TodoTask[] };
		}
	}
	return latest;
}

/** 统计本单元（最近 user 消息之后）的工具调用、todo 调用与 todo 创建。纯函数，可单测。 */
export function unitToolStats(branch: SessionEntry[]): {
	toolCalls: number;
	todoCalls: number;
	createdTodo: boolean;
} {
	let lastUser = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || !entry.message) continue;
		if (entry.message.role === "user") {
			lastUser = i;
			break;
		}
	}
	let toolCalls = 0;
	let todoCalls = 0;
	let createdTodo = false;
	for (let i = lastUser + 1; i < branch.length; i++) {
		const entry = branch[i];
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const c of msg.content as Array<Record<string, unknown>>) {
			if (!c || c.type !== "toolCall") continue;
			toolCalls++;
			if (c.name !== "todo") continue;
			todoCalls++;
			if (createdTodo) continue;
			const raw = c.arguments;
			let args: Record<string, unknown> | null = null;
			if (typeof raw === "string") {
				try {
					args = JSON.parse(raw) as Record<string, unknown>;
				} catch {
					args = null;
				}
			} else if (raw && typeof raw === "object") {
				args = raw as Record<string, unknown>;
			}
			if (args && args.action === "create") createdTodo = true;
		}
	}
	return { toolCalls, todoCalls, createdTodo };
}

/** 最新一条 user 消息时间戳（用于交互静默），无则返回 0。 */
function lastUserMessageAt(branch: SessionEntry[]): number {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || !entry.message) continue;
		if (entry.message.role === "user" && entry.timestamp) {
			const t = Date.parse(entry.timestamp);
			if (!Number.isNaN(t)) return t;
		}
	}
	return 0;
}

export default function todoneExtension(pi: ExtensionAPI): void {
	// 注入状态（防循环）
	let lastInjectionText = "";
	let lastInjectionAt = 0;
	let injectionStreak = 0;
	let lastIncompleteCount = -1;
	let stagnantRounds = 0;
	let stalledNotified = false; // 卡点报告已通知：静默等用户介入或进展，不重复催促
	const pendingVerify = new Set<number>(); // 已放行但未语义验证的任务 id

	// ── L1：常驻义务（before_agent_start，纯静态，幂等）──
	pi.on("before_agent_start", (event) => {
		const opts = event.systemPromptOptions;
		if (!opts) return;
		const lines = opts.promptGuidelines ?? [];
		if (lines.includes(TODO_DUTY_LINE)) return; // 幂等：不重复追加
		return {
			systemPromptOptions: {
				...opts,
				promptGuidelines: [...lines, TODO_DUTY_LINE],
			},
		};
	});

	// ── 闸 1：格式闸（tool_call，可 block）──
	pi.on("tool_call", (event) => {
		if (event.toolName !== "todo") return;
		const input = event.input as Record<string, unknown> | undefined;
		if (!input || input.action !== "update" || input.status !== "completed") return;
		// 1. metadata 位置修复：AI 常把 evidence 放在顶层或 metadata 传成字符串
		let meta = input.metadata as Record<string, unknown> | undefined;
		if (!meta || typeof meta !== "object") {
			meta = input.evidence !== undefined ? { evidence: input.evidence } : { evidence: meta ?? undefined };
			input.metadata = meta;
		}
		// 2. 归一化：宽容修复格式偏差，修不了才 block
		const { evidence, error } = normalizeEvidence(meta.evidence);
		if (error) {
			return { block: true, reason: `${PKG}: 完成证明缺失（${error}）。${EVIDENCE_GUIDE}` };
		}
		meta.evidence = evidence; // 规范化后写回，rpiv-todo 落库的是干净格式
		if (typeof input.id === "number") {
			pendingVerify.add(input.id); // 格式合规，但语义未验证
		}
		return;
	});

	// ── 闸 2+3：证明点协议 + 创建义务（agent_end）──
	pi.on("agent_end", async (_event, ctx) => {
		const branch = ctx.sessionManager?.getBranch?.();
		if (!Array.isArray(branch)) return;
		const snapshot = scanTodoSnapshot(branch);
		const tasks = snapshot ? snapshot.tasks.filter((t) => t.status !== "deleted") : [];
		const incomplete = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");

		// 停滞检测（计数变化 = 有进展，复位卡点通知）
		if (incomplete.length === lastIncompleteCount) stagnantRounds++;
		else {
			stagnantRounds = 0;
			lastIncompleteCount = incomplete.length;
			stalledNotified = false;
		}

		// 退避 + 交互静默
		const now = Date.now();
		const cooldown = Math.min(COOLDOWN_MAX_MS, CFG.cooldownBaseMs * 2 ** injectionStreak);
		if (now - lastInjectionAt < cooldown) return;
		if (now - lastUserMessageAt(branch) < CFG.quietAfterMs) return; // 用户在交互，不打扰

		const lastUserAt = lastUserMessageAt(branch);
		if (lastUserAt > lastInjectionAt) stalledNotified = false; // 用户介入，解除静默
		if (stalledNotified && incomplete.length === lastIncompleteCount) return; // 已通知卡点：静默等用户/进展

		const stats = unitToolStats(branch);
		let text: string | null = null;
		if (
			stats.toolCalls >= CFG.createThreshold &&
			!stats.createdTodo &&
			stats.todoCalls === 0 &&
			tasks.length === 0
		) {
			// 创建义务：任务复杂但完全没拆 todo
			text = `${PKG}: 本单元已使用 ${stats.toolCalls} 次工具但未拆 todo——任务比你预期的复杂。请先拆 todo 再继续：
- 粒度：每项是一个可独立验证的结果（≤ 一句话），如"加 idempotency key 去重 + 回归测试"
- 禁止"实现 X 模块"这类不可验证的粗任务
（小任务豁免——若你认为这是小任务，回复一句原因即可继续）`;
		} else if (stagnantRounds >= CFG.stallThreshold && !stalledNotified) {
			// 停滞 → 卡点报告（终态通知，不重复；计数变化或用户介入后复位）
			stalledNotified = true;
			injectionStreak = 0;
			text = `${PKG}: 已连续 ${stagnantRounds} 轮无进展（todo 计数未变）。请交付中间态证明：
- 已完成：列出证据（file/cmd）
- 卡点：具体阻塞点
- 恢复点：下一步从哪继续
若确已无法推进，将任务标回 pending 并说明原因。`;
		} else if (incomplete.length > 0) {
			const list = incomplete
				.slice(0, 5)
				.map((t) => `#${t.id} ${t.subject}`)
				.join("\n");
			text = `${PKG}: 还有 ${incomplete.length} 项 todo 未完成：
${list}
三选一继续：① 证明本轮进展（附 evidence）② 说明卡点并交付中间态 ③ 直接继续工作。`;
		} else if (SEMANTIC_CHECK && pendingVerify.size > 0) {
			// 全部完成 + 有待语义验证项 → 注入验证义务（一次，清空）
			const ids = [...pendingVerify].join(", ");
			pendingVerify.clear();
			text = `${PKG}: 任务 #${ids} 已标记完成（格式闸通过）。完成 ≠ 验证：请 spawn 一个 fresh-context reviewer
subagent 独立验证（只读检查文件/测试，对照 evidence 声称），发现缺口当场修复后再收尾。`;
		}
		if (!text) return;
		if (text === lastInjectionText) return; // 同文本去重
		lastInjectionText = text;
		lastInjectionAt = now;
		injectionStreak++;
		await pi.sendUserMessage(text);
	});
}
