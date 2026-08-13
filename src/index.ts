/**
 * pi-todone — todo 完成义务闸 + 证明点协议
 *
 * 两道闸，全部挂在 pi 生命周期 hook 上，插件只做确定性格式校验：
 *
 * 1. 格式闸（tool_call）：todo 标 completed 必须附 metadata.evidence（JSON，格式校验），
 *    不合规 → block 并附 reason，AI 必须补证才能 done。
 *    语义真实性不在这里判——交给 subagent 系 LLM（agent_end 时注入验证义务）。
 *
 * 2. 证明点协议（agent_end）：agent 空闲时有 pending todo → 注入"证明本轮进展 | 说明卡点 | 继续"；
 *    已放行的完成项 → 注入"请 spawn fresh reviewer 独立验证"（一次）。
 *
 * 防循环：停滞检测（计数无进展 N 轮 → 改发卡点报告）、指数退避、同文本去重、
 *         用户最近交互时静默（不打扰正常对话）。
 *
 * 配置（环境变量）：
 *   PI_TODONE_STALL_THRESHOLD   停滞几轮转卡点报告（默认 3）
 *   PI_TODONE_COOLDOWN_BASE_MS  注入退避基数 ms（默认 60_000，×2^n）
 *   PI_TODONE_COOLDOWN_MAX_MS   退避上限 ms（默认 600_000）
 *   PI_TODONE_SEMANTIC_CHECK    完成项是否注入验证义务 0/1（默认 1）
 *   PI_TODONE_QUIET_AFTER_MS    最近用户消息距今小于此值则不注入 ms（默认 120_000）
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
	};
}

const CFG = {
	stallThreshold: Number(process.env.PI_TODONE_STALL_THRESHOLD ?? 3),
	cooldownBaseMs: Number(process.env.PI_TODONE_COOLDOWN_BASE_MS ?? 60_000),
	cooldownMaxMs: Number(process.env.PI_TODONE_COOLDOWN_MAX_MS ?? 600_000),
	semanticCheck: (process.env.PI_TODONE_SEMANTIC_CHECK ?? "1") === "1",
	quietAfterMs: Number(process.env.PI_TODONE_QUIET_AFTER_MS ?? 120_000),
};

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

const EVIDENCE_GUIDE = `todo 标 completed 必须附 metadata.evidence（JSON），格式：
  {"kind":"state","evidence":[{"type":"file","path":"src/a.ts","op":"edit"}]}
  {"kind":"runnable","evidence":[{"type":"cmd","cmd":"npm test","exit":0}]}
  {"kind":"effect","evidence":[]}   ← 不可硬验证，仅声明，留人工验收`;

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
	const pendingVerify = new Set<number>(); // 已放行但未语义验证的任务 id

	// ── 闸 1：格式闸（tool_call，可 block）──
	pi.on("tool_call", (event) => {
		if (event.toolName !== "todo") return;
		const input = event.input as Record<string, unknown> | undefined;
		if (!input || input.action !== "update" || input.status !== "completed") return;
		const meta = input.metadata as Record<string, unknown> | undefined;
		const err = validateEvidence(meta?.evidence);
		if (err) {
			return { block: true, reason: `${PKG}: 完成证明缺失（${err}）。${EVIDENCE_GUIDE}` };
		}
		if (typeof input.id === "number") {
			pendingVerify.add(input.id); // 格式合规，但语义未验证
		}
		return;
	});

	// ── 闸 2：证明点协议（agent_end）──
	pi.on("agent_end", async (_event, ctx) => {
		const branch = ctx.sessionManager?.getBranch?.();
		if (!Array.isArray(branch)) return;
		const snapshot = scanTodoSnapshot(branch);
		if (!snapshot) return;

		const tasks = snapshot.tasks.filter((t) => t.status !== "deleted");
		const incomplete = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");

		// 停滞检测
		if (incomplete.length === lastIncompleteCount) stagnantRounds++;
		else {
			stagnantRounds = 0;
			lastIncompleteCount = incomplete.length;
		}

		// 退避 + 交互静默
		const now = Date.now();
		const cooldown = Math.min(CFG.cooldownMaxMs, CFG.cooldownBaseMs * 2 ** injectionStreak);
		if (now - lastInjectionAt < cooldown) return;
		if (now - lastUserMessageAt(branch) < CFG.quietAfterMs) return; // 用户在交互，不打扰

		let text: string | null = null;
		if (stagnantRounds >= CFG.stallThreshold) {
			// 停滞 → 卡点报告（中间态交付），重置注入节奏
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
		} else if (CFG.semanticCheck && pendingVerify.size > 0) {
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
