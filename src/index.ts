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
 * 配置（环境变量，非法值一律回退默认并告警）：
 *   PI_TODONE_STALL_THRESHOLD   停滞几轮转卡点报告（默认 3）
 *   PI_TODONE_QUIET_AFTER_MS    最近用户消息距今小于此值则不注入 ms（默认 120_000）
 *   PI_TODONE_CREATE_THRESHOLD  本单元工具调用 ≥ 此值且未拆 todo 则注入创建义务（默认 200）
 *   PI_TODONE_COOLDOWN_BASE_MS  退避基数 60s×2ⁿ（默认 60_000；上限 10min 写死）
 * 验证义务开关（SEMANTIC_CHECK）是写死常量，不需要旋钮。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PKG = "pi-todone";
const SELF_TYPE = "pi-todone"; // 注入消息 customType：静默/单元统计排除自身
const registered = new WeakSet<ExtensionAPI>(); // 模块级幂等：热重载/重复加载 → 双 handler → 双份闭包 → 每回合双注入

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

/** 读环境变量数值：缺省/非法（NaN、负数、空串）回退默认并告警——非法值静默禁用守卫是配置泄露。 */
export function envNumber(name: string, dflt: number): number {
	const raw = process.env[name];
	if (raw === undefined) return dflt;
	if (raw.trim() === "") {
		// 纯空白串 Number() 得 0 会静默变零值——按非法回退并告警
		console.warn(
			`[${PKG}] 环境变量 ${name}=${JSON.stringify(raw)} 非法（空白），回退默认 ${dflt}`,
		);
		return dflt;
	}
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) {
		console.warn(
			`[${PKG}] 环境变量 ${name}=${JSON.stringify(raw)} 非法，回退默认 ${dflt}`,
		);
		return dflt;
	}
	return n;
}

const CFG = {
	stallThreshold: envNumber("PI_TODONE_STALL_THRESHOLD", 3),
	cooldownBaseMs: envNumber("PI_TODONE_COOLDOWN_BASE_MS", 60_000),
	quietAfterMs: envNumber("PI_TODONE_QUIET_AFTER_MS", 120_000),
	createThreshold: envNumber("PI_TODONE_CREATE_THRESHOLD", 200),
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
	if (kind === "effect") {
		// 效果类不可硬验证，仅要求证据数组形态（可空），留人工验收
		return Array.isArray(list) ? null : "effect 类 evidence 必须是数组";
	}
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
export function normalizeEvidence(raw: unknown): {
	evidence: Evidence | null;
	error: string | null;
} {
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
	if (!ev || typeof ev !== "object")
		return { evidence: null, error: "evidence 缺失或非对象" };
	// 顶层就是单条目（{cmd:...} 或 {type:"file",path:...}）→ 包成 {evidence:[条目]}
	const asObj = ev as Record<string, unknown>;
	if (
		!("evidence" in asObj) &&
		("cmd" in asObj || "path" in asObj || "type" in asObj)
	) {
		ev = { evidence: [ev] };
	}
	const e = ev as Evidence;
	let list = e.evidence;
	if (list && typeof list === "object" && !Array.isArray(list)) {
		// 单对象（AI 最常见偏差：{cmd:...} 或 {type:"file",path:...}）→ 包成数组
		list = [list];
	}
	if (!Array.isArray(list))
		return { evidence: null, error: "evidence.evidence 必须是数组" };
	// 条目缺 type → 推断。全部构建新对象：纯函数，绝不修改输入（输入可能被冻结/共享）
	const items = list.map((item): EvidenceItem => {
		if (!item || typeof item !== "object") return item as EvidenceItem;
		const src = item as unknown as Record<string, unknown>;
		if (typeof src.type === "string") return item as EvidenceItem;
		const type =
			typeof src.cmd === "string"
				? "cmd"
				: typeof src.path === "string"
					? "file"
					: undefined;
		return type ? ({ ...src, type } as EvidenceItem) : (item as EvidenceItem);
	});
	// 缺 kind → 推断
	let kind = e.kind;
	if (!kind) {
		const hasCmd = items.some((it) => it && it.type === "cmd");
		const hasFile = items.some((it) => it && it.type === "file");
		if (hasCmd) kind = "runnable";
		else if (hasFile) kind = "state";
	}
	const norm: Evidence = { ...e, kind, evidence: items };
	const err = validateEvidence(norm);
	return err ? { evidence: null, error: err } : { evidence: norm, error: null };
}

const EVIDENCE_GUIDE = `todo 标 completed 必须附 metadata.evidence（JSON），格式：
  {"kind":"state","evidence":[{"type":"file","path":"src/a.ts","op":"edit"}]}
  {"kind":"runnable","evidence":[{"type":"cmd","cmd":"npm test","exit":0}]}
  {"kind":"effect","evidence":[]}   ← 不可硬验证，仅声明，留人工验收`;

/** L1 常驻义务摘要：编译期常量，严禁任何动态内容（字节变化会破 system prompt 缓存前缀）。 */
const TODO_DUTY_LINE =
	"Todo 义务（pi-todone）：复杂任务（多文件/3+ 步骤/长任务）开始前先拆 todo，每项是一个可独立验证的结果（≤ 一句话）；小任务（单文件小改/问答）无需列。标 todo completed 必须附 metadata.evidence（state→file 证据 / runnable→cmd 证据 / effect 留人工验收）；树形任务：父 completed 前子项必须全 completed；详见 pi-todone skill。";

/** 扫描会话分支，返回最新 todo 工具结果快照（todo-enforcer 同款模式，纯读）。 */
export function scanTodoSnapshot(
	branch: SessionEntry[],
): { tasks: TodoTask[] } | null {
	// 反向扫描：最新 todo 工具结果即最新快照，命中即停（O(本单元) 而非 O(整个会话)，
	// 每次 todo 调用都会走此函数，长会话避免 O(n²)）
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
		let d = msg.details as
			| { tasks?: unknown }
			| { details?: { tasks?: unknown } }
			| undefined;
		if (
			d &&
			!Array.isArray((d as { tasks?: unknown }).tasks) &&
			(d as { details?: unknown }).details
		) {
			d = (d as { details?: { tasks?: unknown } }).details as {
				tasks?: unknown;
			};
		}
		if (d && Array.isArray((d as { tasks?: unknown }).tasks)) {
			return d as { tasks: TodoTask[] };
		}
	}
	return null;
}

/** 树完整性：create 引用校验。parentId 必须存在于快照。纯函数，可单测。 */
export function validateParentRef(
	tasks: TodoTask[],
	parentId: unknown,
): string | null {
	if (parentId === undefined || parentId === null) return null; // 根节点合法
	if (typeof parentId !== "number")
		return `parentId 必须是数字，实际: ${String(parentId)}`;
	if (!tasks.some((t) => t && t.id === parentId))
		return `parentId 引用的任务 #${parentId} 不存在`;
	return null;
}

/** 树完整性：完成闭包。子项（parentId=自己，跳过 deleted）全 completed 才允许 completed。纯函数。 */
export function canCompleteTree(tasks: TodoTask[], id: unknown): string | null {
	if (typeof id !== "number") return `id 必须是数字，实际: ${String(id)}`; // 无法判定不放行（门禁不静默绕过）
	const children = tasks.filter(
		(t) => t && t.metadata?.parentId === id && t.status !== "deleted",
	);
	if (children.length === 0) return null;
	const unfinished = children.filter((t) => t.status !== "completed");
	if (unfinished.length > 0) {
		return `子任务 ${unfinished.map((t) => `#${t.id} ${t.subject}`).join("、")} 未完成，父任务不能宣告 completed`;
	}
	return null;
}

/** 剪枝集合：只保留在当前快照中仍处于指定状态的任务 id（就地删除，调用方持有引用不变）。
 * 纯函数，可单测。不依赖注入路径——交互静默/退避窗口内集合只增不减是无界增长。 */
export function pruneAlive(
	ids: Set<number>,
	tasks: TodoTask[],
	want: "in_progress" | "completed",
): void {
	for (const id of [...ids]) {
		const t = tasks.find((x) => x && x.id === id);
		if (!t || t.status !== want) ids.delete(id);
	}
}

/** 解析工具调用参数（字符串 JSON 或对象，宽容容错）。纯函数。 */
function parseToolArgs(raw: unknown): Record<string, unknown> | null {
	if (typeof raw === "string") {
		try {
			return JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return null;
		}
	}
	if (raw && typeof raw === "object") return raw as Record<string, unknown>;
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
				const args = parseToolArgs(c.arguments);
				if (
					args &&
					typeof args.timeout === "number" &&
					args.timeout >= LONG_WAIT_MS
				) {
					hasLongWait = true;
				}
			}
			if (c.name !== "todo") continue;
			todoCalls++;
			if (createdTodo) continue;
			const args = parseToolArgs(c.arguments);
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
	if (registered.has(pi)) return; // 幂等：同一实例重复加载不重复注册
	registered.add(pi);
	// 注入状态（防循环）
	let lastInjectionText = "";
	let lastInjectionAt = 0;
	let injectionStreak = 0;
	let lastIncompleteCount = -1;
	let stagnantRounds = 0;
	let stalledNotified = false; // 卡点报告已通知：静默等用户介入或进展，不重复催促
	const pendingVerify = new Set<number>(); // 已放行但未语义验证的任务 id
	const pendingParallel = new Set<number>(); // 依赖未完成就 in_progress 的任务 id（待确认）
	let currentRound = 0; // 回合号：agent_start 递增（回合级守卫用）
	let lastInjectedRound = -1; // 已注入的回合号（同回合多轮 turn_end 只注入一次）
	let lastStallRound = -1; // 停滞计数已更新的回合号（同回合多轮只计一次）
	// block-storm 抑制：同一任务同一原因连续 block 计数（模型反复重试同一违规烧工具预算——审计见 dag-core 19 连 block）
	const blockStorm = new Map<number, { key: string; count: number }>();
	function escalateBlock(
		id: unknown,
		key: string,
		reason: string,
	): { block: true; reason: string } {
		if (typeof id !== "number") return { block: true, reason };
		const prev = blockStorm.get(id);
		if (prev && prev.key === key) prev.count++;
		else blockStorm.set(id, { key, count: 1 });
		const n = blockStorm.get(id)!.count;
		const hint =
			n >= 2
				? `[第${n}次拦截同一调用] 停止重试同格式：按上方格式补合规 evidence 重试，或将任务标回 pending（update status=pending）。`
				: "";
		return { block: true, reason: hint + reason };
	}

	/** 注入一条建议（customType 标记：静默/统计排除自身，防自反馈循环）。
	 * deliverAs: steer=回合内投递（下次 LLM 调用前，agent 本回合消化，不产生新回合）；
	 * followUp=回合结束投递（agent_settled 兜底用）。均不 triggerTurn：避免"汇报后接短工作"。
	 * 返回 true=已投递（或同文本已提示过）；false=投递失败（去重/退避/streak 状态未提交，
	 * 调用方保留提示状态下轮重试——状态提交后置于效果成功之后，失败不污染防循环状态）。 */
	async function inject(
		text: string,
		now: number,
		deliverAs: "steer" | "followUp" = "steer",
	): Promise<boolean> {
		if (text === lastInjectionText) return true; // 同文本去重：已提示过，视为已投递
		lastInjectedRound = currentRound; // 先占回合：并发 turn_end/agent_settled 不双发
		try {
			await pi.sendMessage(
				{ customType: SELF_TYPE, content: text, display: true },
				{ deliverAs, triggerTurn: false },
			);
		} catch (err) {
			// 仅释放自身回合的占位：非顺序派发下回合 N 的失败不得误释放回合 N+1 的占位（防 settled 二次注入）
			if (lastInjectedRound === currentRound) lastInjectedRound = -1;
			console.error(`[${PKG}] 注入失败（状态未提交，可重试）:`, err);
			return false;
		}
		lastInjectionText = text;
		lastInjectionAt = now;
		injectionStreak++;
		return true;
	}

	// ── 回合级守卫：agent_start 递增回合号（turn_end 每轮触发，注入/停滞计数需按回合去重）──
	pi.on("agent_start", () => {
		currentRound++;
	});

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
				return {
					block: true,
					reason: `${PKG}: ${err}。树形任务：父节点必须先创建，子节点用 metadata.parentId 挂载。`,
				};
			}
			return;
		}
		if (input.action !== "update") return;

		if (input.status === "completed") {
			// 树完整性：子项（跳过 deleted）全 completed 才能 completed
			const treeErr = canCompleteTree(tasks, input.id);
			if (treeErr) {
				return escalateBlock(
					input.id,
					"tree",
					`${PKG}: ${treeErr}。先完成子任务，或将其标回 pending/deleted。`,
				);
			}
			// evidence 格式闸：判定用纯函数，不依赖输入可变性；顶层 evidence 与 metadata 缺失时回退一致
			const meta0 = input.metadata as Record<string, unknown> | undefined;
			const raw =
				meta0 && typeof meta0 === "object" && "evidence" in meta0
					? meta0.evidence
					: input.evidence;
			const { evidence, error } = normalizeEvidence(raw);
			if (error) {
				return escalateBlock(
					input.id,
					"evidence",
					`${PKG}: 完成证明缺失（${error}）。${EVIDENCE_GUIDE}`,
				);
			}
			// 放行：该任务 storm 计数复位（下次违规从 1 计）
			if (typeof input.id === "number") blockStorm.delete(input.id);
			// 规范化写回：尽力而为——输入可能被冻结/只读，失败只损失落库格式，不阻断放行、不抛给事件分发
			try {
				const meta = meta0 && typeof meta0 === "object" ? meta0 : {};
				meta.evidence = evidence;
				input.metadata = meta;
			} catch (err) {
				console.error(`[${PKG}] evidence 规范化写回失败（已放行）:`, err);
			}
			if (typeof input.id === "number") {
				pendingVerify.add(input.id); // 格式合规，但语义未验证
			}
			return;
		}
		if (input.status === "in_progress") {
			// 并行就绪：blockedBy 未完成 → 记入待确认（建议层提示，不 block）
			// 数据边界防御：AI 可能给 blockedBy 传标量/畸形值、快照条目非对象——门禁不崩、不直穿事件分发
			const task = tasks.find((t) => t && t.id === input.id);
			if (task && typeof input.id === "number") {
				blockStorm.delete(input.id); // 状态变更=agent 在行动，storm 计数复位
				const deps = Array.isArray(task.blockedBy)
					? task.blockedBy.filter((d) => {
							const dep = tasks.find((t) => t && t.id === d);
							return (
								dep && dep.status !== "completed" && dep.status !== "deleted"
							);
						})
					: [];
				if (deps.length > 0) pendingParallel.add(input.id);
			}
			return;
		}
		// 其他状态（pending 等）：非 block update，storm 计数复位
		if (typeof input.id === "number") blockStorm.delete(input.id);
	});

	// ── 建议层（turn_end：回合内注入——agent 消化提示后再收尾，汇报与提示一体，
	//    不产生"汇报结束后接短工作"；agent_settled 兜底：单轮回合/steer 未投递时补一次）──
	async function judgeAndInject(
		branch: SessionEntry[],
		now: number,
		deliverAs: "steer" | "followUp",
	): Promise<void> {
		const snapshot = scanTodoSnapshot(branch);
		const tasks = snapshot
			? snapshot.tasks.filter((t) => t.status !== "deleted")
			: [];
		const incomplete = tasks.filter(
			(t) => t.status === "pending" || t.status === "in_progress",
		);

		// 集合与当前快照对齐（不依赖注入路径：交互静默/退避窗口内也剪枝，防无界增长；
		// ③⑥ 分支内的过滤保留为投递路径兜底）
		pruneAlive(pendingParallel, tasks, "in_progress");
		pruneAlive(pendingVerify, tasks, "completed");

		// 停滞检测（只对有 todo 的单元计数：无 todo 时"审视 todo 树"无对象，不累积不提示；
		// 计数变化 = 有进展，复位卡点通知）
		if (
			tasks.length > 0 &&
			incomplete.length > 0 &&
			lastStallRound !== currentRound
		) {
			lastStallRound = currentRound;
			if (incomplete.length === lastIncompleteCount) stagnantRounds++;
			else {
				stagnantRounds = 0;
				lastIncompleteCount = incomplete.length;
				stalledNotified = false;
			}
		} else if (incomplete.length === 0) {
			stagnantRounds = 0;
			lastIncompleteCount = incomplete.length;
			stalledNotified = false;
		}

		// 退避 + 交互静默
		const cooldown = Math.min(
			COOLDOWN_MAX_MS,
			CFG.cooldownBaseMs * 2 ** injectionStreak,
		);
		if (now - lastInjectionAt < cooldown) return;

		const lastUserAt = lastUserMessageAt(branch);
		if (now - lastUserAt < CFG.quietAfterMs) return; // 用户在交互，不打扰
		if (lastUserAt > lastInjectionAt) stalledNotified = false; // 用户介入，解除静默
		if (stalledNotified && incomplete.length === lastIncompleteCount) return; // 已通知卡点：静默等用户/进展

		const stats = unitToolStats(branch);
		let text: string | null = null;
		let notifyStall = false;
		let consumed: "parallel" | "verify" | null = null; // 本轮提示消费的集合（tail 只清被消费的，防交叉清理）

		// ① 停滞 → 重新审视树结构（终态通知，不重复；计数变化或用户介入后复位；
		//    投递成功才置 stalledNotified/重置退避——失败保留，下轮重试）
		if (stagnantRounds >= CFG.stallThreshold && !stalledNotified) {
			notifyStall = true;
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
		// ③ 并行建议：跳步确认（依赖未完成就 in_progress；只提示仍存活的，陈旧 id 丢弃）
		else if (pendingParallel.size > 0) {
			const ids = [...pendingParallel].filter((id) =>
				tasks.some((t) => t.id === id && t.status === "in_progress"),
			);
			if (ids.length === 0) {
				pendingParallel.clear(); // 全部陈旧：直接丢弃
				return;
			}
			const lines = ids
				.slice(0, 3)
				.map((id) => {
					const t = tasks.find((x) => x.id === id);
					const deps = (t?.blockedBy ?? [])
						.filter((d) =>
							tasks.some((x) => x.id === d && x.status !== "completed"),
						)
						.map((d) => `#${d}`);
					return `#${id} ${t?.subject ?? ""}（前置 ${deps.join("、")} 未完成）`;
				})
				.join("\n");
			text = `${PKG}: 以下任务在前置未完成时已开始：
${lines}
若是有意并行（前置项不影响本项），忽略此提示；否则先完成前置，或解除 blockedBy。`;
			consumed = "parallel";
		}
		// ④ 等待间隙：有长等待（subagent/长命令）+ 有可并行 pending → 趁等待推进
		else if (stats.hasLongWait) {
			const parallelizable = incomplete.filter((t) => {
				const deps = (t.blockedBy ?? []).filter((d) =>
					tasks.some((x) => x.id === d && x.status !== "completed"),
				);
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
			// 只提示仍 completed 的；被改回 pending/deleted 的陈旧 id 直接丢弃
			const ids = [...pendingVerify].filter((id) =>
				tasks.some((t) => t.id === id && t.status === "completed"),
			);
			if (ids.length === 0) {
				pendingVerify.clear();
				return;
			}
			text = `${PKG}: 任务 #${ids.join(", ")} 已标记完成（格式闸通过）。完成 ≠ 验证：请 spawn 一个 fresh-context reviewer
subagent 独立验证（只读检查文件/测试，对照 evidence 声称），发现缺口当场修复后再收尾。`;
			consumed = "verify";
		}
		if (!text) return;
		// 投递成功才提交提示状态：失败保留（集合不清、终态不置），下轮重试。
		// 只清本轮消费的集合：⑤证明点/①停滞/②创建/④等待不清任何集合——
		// 交叉清理会把 pendingVerify 的验证义务冲掉（v0.4.3 回归修复）。
		if (await inject(text, now, deliverAs)) {
			if (consumed === "parallel") pendingParallel.clear();
			else if (consumed === "verify") pendingVerify.clear();
			if (notifyStall) {
				stalledNotified = true;
				injectionStreak = 0;
			}
		}
	}

	pi.on("turn_end", async (_event, ctx) => {
		try {
			if (lastInjectedRound === currentRound) return; // 本回合已注入
			const branch = ctx.sessionManager?.getBranch?.();
			if (!Array.isArray(branch)) return;
			await judgeAndInject(branch, Date.now(), "steer");
		} catch (err) {
			// 建议器异常不泄漏为 unhandled rejection（不打断 pi 事件分发）
			console.error(`[${PKG}] turn_end 建议器异常（已忽略）:`, err);
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			if (lastInjectedRound === currentRound) return; // 回合内已注入，不重复
			const branch = ctx.sessionManager?.getBranch?.();
			if (!Array.isArray(branch)) return;
			await judgeAndInject(branch, Date.now(), "followUp");
		} catch (err) {
			console.error(`[${PKG}] agent_settled 建议器异常（已忽略）:`, err);
		}
	});
}
