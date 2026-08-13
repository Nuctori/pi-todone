/**
 * pi-todone — todo 状态机守护者
 *
 * 三问三答：状态迁移合法吗（硬闸）？执行高效吗（建议器）？结构清楚吗（知识层）？
 *
 * 硬闸层（tool_call，2 个，全部机械可判定）：
 * 1. evidence 格式闸：todo 标 completed 必须附 metadata.evidence（宽容归一化，无法归一化才 block）
 * 2. 树完整性：create 带 parentId 必须存在于快照；completed 时子项（parentId=自己，跳过 deleted）
 *    必须全 completed——"目标假完成"被机械拦截
 *
 * 建议层（agent_end，1 个统一注入器，customType 标记防自反馈）：
 *   按优先级给一条：停滞重审视 > 创建义务 > 并行建议（跳步确认/等待间隙）> 证明点 > 验证义务
 *
 * 知识层：L1 静态义务摘要（编译期常量，缓存安全）+ skill（~/.agents/skills/pi-todone/SKILL.md）
 *
 * 防循环：停滞终态静默、指数退避、同文本去重、交互静默、customType 排除、幂等注入。
 *
 * 配置（环境变量，只有真正会调的 3 个）：
 *   PI_TODONE_STALL_THRESHOLD   停滞几轮转卡点报告（默认 3）
 *   PI_TODONE_QUIET_AFTER_MS    最近用户消息距今小于此值则不注入 ms（默认 120_000）
 *   PI_TODONE_CREATE_THRESHOLD  本单元工具调用 ≥ 此值且未拆 todo 则注入创建义务（默认 5）
 * 退避（60s×2ⁿ 上限 10min）与验证义务开关（SEMANTIC_CHECK）是写死常量，不需要旋钮。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PKG = "pi-todone";
const SELF_TYPE = "pi-todone"; // 注入消息 customType：静默/单元统计排除自身

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
	blockedBy?: number[];
	metadata?: Record<string, unknown>;
}
interface SessionEntry {
	type?: string;
	timestamp?: string;
	message?: {
		role?: string;
		toolName?: string;
		details?: unknown;
		content?: unknown;
		customType?: string;
	};
}

const CFG = {
	stallThreshold: Number(process.env.PI_TODONE_STALL_THRESHOLD ?? 3),
	cooldownBaseMs: Number(process.env.PI_TODONE_COOLDOWN_BASE_MS ?? 60_000),
	quietAfterMs: Number(process.env.PI_TODONE_QUIET_AFTER_MS ?? 120_000),
	createThreshold: Number(process.env.PI_TODONE_CREATE_THRESHOLD ?? 5),
};
const COOLDOWN_MAX_MS = 600_000; // 退避上限（写死）
const SEMANTIC_CHECK = true; // 完成项注入验证义务（要关改这里）
const LONG_WAIT_MS = 60_000; // 命令 timeout ≥ 此值视为长等待

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
 * - 字符串 → JSON.parse（失败按裸命令处理）
 * - 顶层单条目（{cmd:...}）→ 包成 {evidence:[条目]}
 * - evidence 单对象 → 包成数组
 * - 条目缺 type → 按字段推断（有 cmd→cmd，有 path→file）
 * - 缺 kind → 按条目推断（有 cmd→runnable，有 file→state）
 */
export function normalizeEvidence(raw: unknown): { evidence: Evidence | null; error: string | null } {
	let ev = raw;
	if (typeof raw === "string") {
		const t = raw.trim();
		if (!t) return { evidence: null, error: "evidence 缺失或非对象" };
		try {
			ev = JSON.parse(t);
		} catch {
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
	"Todo 义务（pi-todone）：复杂任务（多文件/3+ 步骤/长任务）开始前先拆 todo，每项是一个可独立验证的结果（≤ 一句话）；小任务（单文件小改/问答）无需列。标 todo completed 必须附 metadata.evidence（state→file 证据 / runnable→cmd 证据 / effect 留人工验收）；树形任务：父 completed 前子项必须全 completed；详见 pi-todone skill。";

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

/** 树完整性：create 引用校验。parentId 必须存在于快照。纯函数，可单测。 */
export function validateParentRef(tasks: TodoTask[], parentId: unknown): string | null {
	if (parentId === undefined || parentId === null) return null; // 根节点合法
	if (typeof parentId !== "number") return `parentId 必须是数字，实际: ${String(parentId)}`;
	if (!tasks.some((t) => t.id === parentId)) return `parentId 引用的任务 #${parentId} 不存在`;
	return null;
}

/** 树完整性：完成闭包。子项（parentId=自己，跳过 deleted）全 completed 才允许 completed。纯函数。 */
export function canCompleteTree(tasks: TodoTask[], id: unknown): string | null {
	if (typeof id !== "number") return null;
	const children = tasks.filter((t) => t.metadata?.parentId === id && t.status !== "deleted");
	if (children.length === 0) return null;
	const unfinished = children.filter((t) => t.status !== "completed");
	if (unfinished.length > 0) {
		return `子任务 ${unfinished.map((t) => `#${t.id} ${t.subject}`).join("、")} 未完成，父任务不能宣告 completed`;
	}
	return null;
}

/** 统计本单元（最近真实 user 消息之后）的工具调用、todo 创建与长等待。纯函数，可单测。 */
export function unitToolStats(branch: SessionEntry[]): {
	toolCalls: number;
	todoCalls: number;
	createdTodo: boolean;
	hasLongWait: boolean;
} {
	let lastUser = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		if (msg.customType === SELF_TYPE) continue; // 排除自身注入
		if (msg.role === "user") {
			lastUser = i;
			break;
		}
	}
	let toolCalls = 0;
	let todoCalls = 0;
	let createdTodo = false;
	let hasLongWait = false;
	for (let i = lastUser + 1; i < branch.length; i++) {
		const entry = branch[i];
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		if (msg.customType === SELF_TYPE) continue;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const c of msg.content as Array<Record<string, unknown>>) {
			if (!c || c.type !== "toolCall") continue;
			toolCalls++;
			if (c.name === "subagent") hasLongWait = true;
			if (c.name === "shell" || c.name === "pwsh" || c.name === "bash") {
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
				if (args && typeof args.timeout === "number" && args.timeout >= LONG_WAIT_MS) {
					hasLongWait = true;
				}
			}
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
	return { toolCalls, todoCalls, createdTodo, hasLongWait };
}

/** 最新一条真实 user 消息时间戳（用于交互静默；排除自身注入消息），无则返回 0。 */
function lastUserMessageAt(branch: SessionEntry[]): number {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		if (msg.customType === SELF_TYPE) continue;
		if (msg.role === "user" && entry.timestamp) {
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
	const pendingParallel = new Set<number>(); // 依赖未完成就 in_progress 的任务 id（待确认）

	/** 注入一条建议（customType 标记：静默/统计排除自身，防自反馈循环）。 */
	async function inject(text: string, now: number): Promise<void> {
		if (text === lastInjectionText) return; // 同文本去重
		lastInjectionText = text;
		lastInjectionAt = now;
		injectionStreak++;
		await pi.sendMessage(
			{ customType: SELF_TYPE, content: text, display: true },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

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

	// ── 硬闸层（tool_call）──
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "todo") return;
		const input = event.input as Record<string, unknown> | undefined;
		if (!input) return;
		const branch = ctx.sessionManager?.getBranch?.();
		const snapshot = Array.isArray(branch) ? scanTodoSnapshot(branch) : null;
		const tasks = snapshot ? snapshot.tasks : [];

		if (input.action === "create") {
			// 树完整性：parentId 引用必须存在
			const meta = input.metadata as Record<string, unknown> | undefined;
			const err = validateParentRef(tasks, meta?.parentId);
			if (err) {
				return { block: true, reason: `${PKG}: ${err}。树形任务：父节点必须先创建，子节点用 metadata.parentId 挂载。` };
			}
			return;
		}
		if (input.action !== "update") return;

		if (input.status === "completed") {
			// 树完整性：子项（跳过 deleted）全 completed 才能 completed
			const treeErr = canCompleteTree(tasks, input.id);
			if (treeErr) {
				return { block: true, reason: `${PKG}: ${treeErr}。先完成子任务，或将其标回 pending/deleted。` };
			}
			// evidence 格式闸
			let meta = input.metadata as Record<string, unknown> | undefined;
			if (!meta || typeof meta !== "object") {
				meta = input.evidence !== undefined ? { evidence: input.evidence } : { evidence: meta ?? undefined };
				input.metadata = meta;
			}
			const { evidence, error } = normalizeEvidence(meta.evidence);
			if (error) {
				return { block: true, reason: `${PKG}: 完成证明缺失（${error}）。${EVIDENCE_GUIDE}` };
			}
			meta.evidence = evidence; // 规范化后写回，落库的是干净格式
			if (typeof input.id === "number") {
				pendingVerify.add(input.id); // 格式合规，但语义未验证
			}
			return;
		}
		if (input.status === "in_progress") {
			// 并行就绪：blockedBy 未完成 → 记入待确认（建议层提示，不 block）
			const task = tasks.find((t) => t.id === input.id);
			if (task && typeof input.id === "number") {
				const deps = (task.blockedBy ?? []).filter((d) => {
					const dep = tasks.find((t) => t.id === d);
					return dep && dep.status !== "completed" && dep.status !== "deleted";
				});
				if (deps.length > 0) pendingParallel.add(input.id);
			}
			return;
		}
	});

	// ── 建议层（agent_end，统一注入器）──
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

		// ① 停滞 → 重新审视树结构（终态通知，不重复；计数变化或用户介入后复位）
		if (stagnantRounds >= CFG.stallThreshold && !stalledNotified) {
			stalledNotified = true;
			injectionStreak = 0;
			text = `${PKG}: 已连续 ${stagnantRounds} 轮无进展。请先重新审视 todo 树结构（目标节点对照用户原话仍成立吗？拆错/顺序/死路？），更新后再继续；若确已无法推进，标回 pending 并说明。`;
		}
		// ② 创建义务：任务复杂但完全没拆 todo
		else if (
			stats.toolCalls >= CFG.createThreshold &&
			!stats.createdTodo &&
			stats.todoCalls === 0 &&
			tasks.length === 0
		) {
			text = `${PKG}: 本单元已使用 ${stats.toolCalls} 次工具但未拆 todo——任务比你预期的复杂。请先拆 todo 再继续：
- 粒度：每项是一个可独立验证的结果（≤ 一句话），如"加 idempotency key 去重 + 回归测试"
- 树形：复杂任务先建根节点（目标，对照用户原话），子任务用 metadata.parentId 挂载
（小任务豁免——若你认为这是小任务，回复一句原因即可继续）`;
		}
		// ③ 并行建议：跳步确认（依赖未完成就 in_progress）
		else if (pendingParallel.size > 0) {
			const ids = [...pendingParallel];
			pendingParallel.clear();
			const lines = ids
				.slice(0, 3)
				.map((id) => {
					const t = tasks.find((x) => x.id === id);
					const deps = (t?.blockedBy ?? [])
						.filter((d) => tasks.some((x) => x.id === d && x.status !== "completed"))
						.map((d) => `#${d}`);
					return `#${id} ${t?.subject ?? ""}（前置 ${deps.join("、")} 未完成）`;
				})
				.join("\n");
			text = `${PKG}: 以下任务在前置未完成时已开始：
${lines}
若是有意并行（前置项不影响本项），忽略此提示；否则先完成前置，或解除 blockedBy。`;
		}
		// ④ 等待间隙：有长等待（subagent/长命令）+ 有可并行 pending → 趁等待推进
		else if (stats.hasLongWait) {
			const parallelizable = incomplete.filter((t) => {
				const deps = (t.blockedBy ?? []).filter((d) => tasks.some((x) => x.id === d && x.status !== "completed"));
				return deps.length === 0;
			});
			if (parallelizable.length > 0) {
				const list = parallelizable
					.slice(0, 3)
					.map((t) => `#${t.id} ${t.subject}`)
					.join("\n");
				text = `${PKG}: 本单元发起了长等待（subagent/长命令）。等待期间可并行推进（无依赖）：
${list}
不必干等——异步发出后继续做这些，或至少说明等待期间的计划。`;
			}
		}
		// ⑤ 证明点：有 pending todo
		else if (incomplete.length > 0) {
			const list = incomplete
				.slice(0, 5)
				.map((t) => `#${t.id} ${t.subject}`)
				.join("\n");
			text = `${PKG}: 还有 ${incomplete.length} 项 todo 未完成：
${list}
三选一继续：① 证明本轮进展（附 evidence）② 说明卡点并交付中间态 ③ 直接继续工作。`;
		}
		// ⑥ 验证义务：全部完成 + 有待语义验证项
		else if (SEMANTIC_CHECK && pendingVerify.size > 0) {
			const ids = [...pendingVerify].join(", ");
			pendingVerify.clear();
			text = `${PKG}: 任务 #${ids} 已标记完成（格式闸通过）。完成 ≠ 验证：请 spawn 一个 fresh-context reviewer
subagent 独立验证（只读检查文件/测试，对照 evidence 声称），发现缺口当场修复后再收尾。`;
		}
		if (!text) return;
		await inject(text, now);
	});
}
