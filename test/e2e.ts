/**
 * pi-todone mock E2E：用 mock ExtensionAPI 驱动完整扩展事件流。
 * 无模型、无网络依赖，CI 可跑。运行：node --experimental-strip-types test/e2e.ts
 * 覆盖：格式闸 block/放行/归一化、证明点注入、创建义务注入、L1 幂等。
 */
import todoneExtension from "../src/index.ts";

type Handler = (event: never, ctx: never) => unknown;

function mockPi() {
	const handlers: Record<string, Handler[]> = {};
	const sent: string[] = [];
	const sentTypes: string[] = [];
	const sentDeliverAs: (string | undefined)[] = [];
	const sentTriggerTurn: (boolean | undefined)[] = [];
	const pi = {
		on: (evt: string, h: Handler) => {
			(handlers[evt] ??= []).push(h);
		},
		sendUserMessage: async (text: string) => {
			sent.push(text);
			sentTypes.push("userMessage");
		},
		sendMessage: async (
			msg: { customType?: string; content?: string },
			opts: { deliverAs?: string; triggerTurn?: boolean } = {},
		) => {
			sent.push(String(msg.content ?? ""));
			sentTypes.push(String(msg.customType ?? ""));
			sentDeliverAs.push(opts.deliverAs);
			sentTriggerTurn.push(opts.triggerTurn);
		},
	};
	return {
		pi,
		handlers,
		sent,
		sentTypes,
		sentDeliverAs,
		sentTriggerTurn,
		fire: async (evt: string, event: never, ctx: never = {} as never) => {
			let last: unknown;
			for (const h of handlers[evt] ?? []) last = await h(event, ctx);
			return last;
		},
	};
}

/** 跑一个完整回合（agent_start + turn_end），模拟回合内注入时机。 */
function turnCtx(branch: unknown[]) {
	return { sessionManager: { getBranch: () => branch } } as never;
}
async function fireRound(
	m: ReturnType<typeof mockPi>,
	branch: unknown[],
	turnIndex: number,
) {
	await m.fire("agent_start", {} as never);
	await m.fire(
		"turn_end",
		{ turnIndex, message: {}, toolResults: [] } as never,
		turnCtx(branch),
	);
}

let failed = 0;
function check(name: string, actual: unknown, expect: unknown) {
	const ok = actual === expect;
	if (!ok) {
		failed++;
		console.error(
			`FAIL ${name}: expected ${JSON.stringify(expect)}, got ${JSON.stringify(actual)}`,
		);
	} else {
		console.log(`ok   ${name}`);
	}
}

/** timestamp 放 entry 顶层（与 pi SessionEntryBase 一致，e2e mock 曾错放 message 内致 quiet 分支成盲区）；
 * 默认远古时间戳 = 恒不触发交互静默（不依赖墙钟）；传最近时间戳可测 quiet 抑制。 */
function userMsg(text: string, timestamp = "2000-01-01T00:00:00.000Z") {
	return {
		type: "message",
		timestamp,
		message: { role: "user", content: text },
	};
}
function toolCall(name: string, args: unknown) {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", name, arguments: args }],
		},
	};
}
function toolResult(name: string, details: unknown) {
	return {
		type: "message",
		message: { role: "toolResult", toolName: name, details },
	};
}

// ── 场景 1：格式闸 block（无 evidence）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const input = { action: "update", id: 1, status: "completed" };
	const ret = await m.fire("tool_call", { toolName: "todo", input } as never);
	check("S1 无证据 block", (ret as { block?: boolean })?.block, true);
	check(
		"S1 reason 含格式指南",
		String((ret as { reason?: string })?.reason).includes("metadata.evidence"),
		true,
	);
}

// ── 场景 2：格式闸放行 + 归一化（evidence 单对象、缺 kind）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const input = {
		action: "update",
		id: 1,
		status: "completed",
		metadata: { evidence: { cmd: "npm test" } },
	};
	const ret = await m.fire("tool_call", { toolName: "todo", input } as never);
	check("S2 归一化放行", ret, undefined);
	const ev = (
		input.metadata as { evidence: { kind?: string; evidence?: unknown[] } }
	).evidence;
	check("S2 kind 推断 runnable", ev.kind, "runnable");
	check("S2 条目补 type", (ev.evidence?.[0] as { type?: string })?.type, "cmd");
}

// ── 场景 3：证明点注入（有 pending todo，空闲）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("做这个任务"),
		toolCall("todo", { action: "create", subject: "任务A" }),
		toolResult("todo", {
			action: "create",
			params: {},
			tasks: [{ id: 1, subject: "任务A", status: "pending" }],
			nextId: 2,
		}),
		toolCall("todo", { action: "update", id: 1, status: "in_progress" }),
		toolResult("todo", {
			action: "update",
			params: {},
			tasks: [{ id: 1, subject: "任务A", status: "in_progress" }],
			nextId: 2,
		}),
	];
	await fireRound(m, branch, 1);
	check("S3 注入了一次", m.sent.length, 1);
	check(
		"S3 文本含未完成计数",
		m.sent[0]?.includes("还有 1 项 todo 未完成"),
		true,
	);
	check("S3 文本含任务清单", m.sent[0]?.includes("任务A"), true);
}

// ── 场景 4：创建义务注入（≥200 工具调用且未拆 todo）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch: unknown[] = [userMsg("帮我实现一个复杂功能")];
	for (let i = 0; i < 200; i++) {
		branch.push(
			toolCall("ctx_read", { path: `${i}.ts` }),
			toolResult("ctx_read", {}),
		);
	}
	await fireRound(m, branch, 1);
	check("S4 创建义务注入", m.sent.length, 1);
	check("S4 文本含未拆 todo", m.sent[0]?.includes("未拆 todo"), true);
	check("S4 文本含粒度规范", m.sent[0]?.includes("可独立验证"), true);
}

// ── 场景 5：L1 静态注入幂等 ──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const base = {
		customPrompt: "",
		selectedTools: [],
		toolSnippets: [],
		promptGuidelines: [],
		appendSystemPrompt: "",
		cwd: ".",
		contextFiles: [],
		skills: [],
	};
	const r1 = await m.fire("before_agent_start", {
		systemPromptOptions: { ...base },
	} as never);
	const g1 = (r1 as { systemPromptOptions: { promptGuidelines: string[] } })
		.systemPromptOptions.promptGuidelines;
	check("S5 追加了一条", g1.length, 1);
	check("S5 内容为义务摘要", g1[0]?.includes("Todo 义务"), true);
	const opts2 = { ...base, promptGuidelines: [...g1] };
	const r2 = await m.fire("before_agent_start", {
		systemPromptOptions: opts2,
	} as never);
	check("S5 幂等不重复", r2, undefined);
}

// ── 场景 6：小任务豁免（1 次工具调用不注入）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("改一行"),
		toolCall("edit", { path: "a.ts" }),
		toolResult("edit", {}),
	];
	await fireRound(m, branch, 1);
	check("S6 小任务不注入", m.sent.length, 0);
}

// ── 场景 7：树完整性硬闸 ──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	// create 挂不存在的父 → block
	const branch = [
		userMsg("做任务"),
		toolCall("todo", { action: "create", subject: "根", metadata: {} }),
		toolResult("todo", {
			action: "create",
			params: {},
			tasks: [{ id: 1, subject: "根", status: "pending" }],
			nextId: 2,
		}),
	];
	const input = { action: "create", subject: "子", metadata: { parentId: 99 } };
	const ret = await m.fire(
		"tool_call",
		{ toolName: "todo", input } as never,
		{
			sessionManager: { getBranch: () => branch },
		} as never,
	);
	check("S7 挂不存在父 block", (ret as { block?: boolean })?.block, true);
	// 父 completed 子 pending → block
	const branch2 = [
		userMsg("做任务"),
		toolCall("todo", {
			action: "update",
			id: 1,
			status: "completed",
			metadata: {
				evidence: {
					kind: "runnable",
					evidence: [{ type: "cmd", cmd: "echo", exit: 0 }],
				},
			},
		}),
		toolResult("todo", {
			action: "update",
			params: {},
			tasks: [
				{ id: 1, subject: "父", status: "in_progress" },
				{ id: 2, subject: "子", status: "pending", metadata: { parentId: 1 } },
			],
			nextId: 3,
		}),
	];
	const input2 = {
		action: "update",
		id: 1,
		status: "completed",
		metadata: {
			evidence: {
				kind: "runnable",
				evidence: [{ type: "cmd", cmd: "echo", exit: 0 }],
			},
		},
	};
	const ret2 = await m.fire(
		"tool_call",
		{ toolName: "todo", input: input2 } as never,
		{
			sessionManager: { getBranch: () => branch2 },
		} as never,
	);
	check("S7 父完成子未完成 block", (ret2 as { block?: boolean })?.block, true);
	// 子全完成 → 放行（无树错误，走 evidence 闸）
	const branch3 = [
		userMsg("做任务"),
		toolResult("todo", {
			action: "update",
			params: {},
			tasks: [
				{ id: 1, subject: "父", status: "in_progress" },
				{
					id: 2,
					subject: "子",
					status: "completed",
					metadata: { parentId: 1 },
				},
			],
			nextId: 3,
		}),
	];
	const ret3 = await m.fire(
		"tool_call",
		{ toolName: "todo", input: { ...input2 } } as never,
		{
			sessionManager: { getBranch: () => branch3 },
		} as never,
	);
	check("S7 子全完成放行", ret3, undefined);
}

// ── 场景 8：并行就绪建议（依赖未完成就 in_progress → 注入确认）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("干活"),
		toolCall("todo", { action: "update", id: 2, status: "in_progress" }),
		toolResult("todo", {
			action: "update",
			params: {},
			tasks: [
				{ id: 1, subject: "前置", status: "pending" },
				{ id: 2, subject: "下游", status: "in_progress", blockedBy: [1] },
			],
			nextId: 3,
		}),
	];
	await fireRound(m, branch, 1);
	check("S8 并行确认注入", m.sent.length, 1);
	check("S8 文本含前置未完成", m.sent[0]?.includes("前置"), true);
}

// ── 场景 9：等待间隙建议（subagent 长等待 + 可并行 pending → 注入）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("干活"),
		toolCall("subagent", { async: true }),
		toolResult("subagent", {}),
		toolCall("todo", { action: "create", subject: "目标A" }),
		toolResult("todo", {
			action: "create",
			params: {},
			tasks: [
				{ id: 1, subject: "目标A", status: "pending" },
				{ id: 2, subject: "可并行项", status: "pending" },
			],
			nextId: 3,
		}),
	];
	await fireRound(m, branch, 1);
	check("S9 等待间隙注入", m.sent.length, 1);
	check("S9 文本含可并行", m.sent[0]?.includes("可并行"), true);
}

// ── 场景 10：注入走 customType（防自反馈）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("做任务"),
		toolCall("todo", { action: "create", subject: "任务A" }),
		toolResult("todo", {
			action: "create",
			params: {},
			tasks: [{ id: 1, subject: "任务A", status: "pending" }],
			nextId: 2,
		}),
	];
	await fireRound(m, branch, 1);
	check("S10 注入一次", m.sent.length, 1);
	check("S10 走 sendMessage customType", m.sentTypes[0], "pi-todone");
	check("S10 注入走 steer（回合内投递）", m.sentDeliverAs[0], "steer");
	check("S10 不 triggerTurn（不产生新回合）", m.sentTriggerTurn[0], false);
}

// ── 场景 11：同回合多轮 turn_end 只注入一次（回合级去重）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("做任务"),
		toolCall("todo", { action: "create", subject: "任务A" }),
		toolResult("todo", {
			action: "create",
			params: {},
			tasks: [{ id: 1, subject: "任务A", status: "pending" }],
			nextId: 2,
		}),
	];
	await m.fire("agent_start", {} as never);
	await m.fire(
		"turn_end",
		{ turnIndex: 1, message: {}, toolResults: [] } as never,
		turnCtx(branch),
	);
	check("S11 首轮注入一次", m.sent.length, 1);
	await m.fire(
		"turn_end",
		{ turnIndex: 2, message: {}, toolResults: [] } as never,
		turnCtx(branch),
	);
	check("S11 同回合第二轮不重复注入", m.sent.length, 1);
}

// ── 场景 12：无 todo 停滞不触发（4 回合无注入）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("问一个问题"),
		toolCall("ctx_read", { path: "a.ts" }),
		toolResult("ctx_read", {}),
	];
	for (let r = 1; r <= 4; r++) {
		await fireRound(m, branch, r);
	}
	check("S12 无 todo 停滞不触发", m.sent.length, 0);
}

// ── 场景 13：有 todo 停滞 4 回合触发重新审视（跨回合计数）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("干活"),
		toolCall("todo", { action: "create", subject: "任务A" }),
		toolResult("todo", {
			action: "create",
			params: {},
			tasks: [{ id: 1, subject: "任务A", status: "pending" }],
			nextId: 2,
		}),
	];
	const realNow = Date.now;
	let fakeNow = realNow();
	Date.now = () => fakeNow;
	try {
		for (let r = 1; r <= 4; r++) {
			await fireRound(m, branch, r);
			fakeNow += r === 1 ? 130_000 : 1_000; // 回合 1 注入证明点后，越过 120s 退避窗口
		}
	} finally {
		Date.now = realNow;
	}
	check("S13 证明点先注入，停滞后注入", m.sent.length, 2);
	check("S13 文本含重新审视", m.sent[1]?.includes("重新审视"), true);
}

// ── 场景 14：agent_settled 兜底（单轮回合未注入时补一次，走 followUp 不 triggerTurn）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("做任务"),
		toolCall("todo", { action: "create", subject: "任务A" }),
		toolResult("todo", {
			action: "create",
			params: {},
			tasks: [{ id: 1, subject: "任务A", status: "pending" }],
			nextId: 2,
		}),
	];
	await m.fire("agent_start", {} as never);
	await m.fire("agent_settled", {} as never, turnCtx(branch));
	check("S14 settled 兜底注入", m.sent.length, 1);
	check("S14 兜底走 followUp", m.sentDeliverAs[0], "followUp");
	check("S14 兜底不 triggerTurn", m.sentTriggerTurn[0], false);
}

// ── 场景 15：已注入的回合 settled 不重复兜底 ──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("做任务"),
		toolCall("todo", { action: "create", subject: "任务A" }),
		toolResult("todo", {
			action: "create",
			params: {},
			tasks: [{ id: 1, subject: "任务A", status: "pending" }],
			nextId: 2,
		}),
	];
	await fireRound(m, branch, 1);
	check("S15 turn_end 已注入", m.sent.length, 1);
	await m.fire("agent_settled", {} as never, turnCtx(branch));
	check("S15 settled 不重复注入", m.sent.length, 1);
}

// ── 场景 16：注入失败不提交状态，下轮重试（v0.4.2：效果成功才提交去重/退避）──
{
	const m = mockPi();
	let fail = true;
	const origSend = m.pi.sendMessage;
	m.pi.sendMessage = async (msg, opts) => {
		if (fail) throw new Error("transport down");
		return origSend(msg, opts);
	};
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("做任务"),
		toolCall("todo", { action: "create", subject: "任务A" }),
		toolResult("todo", {
			action: "create",
			params: {},
			tasks: [{ id: 1, subject: "任务A", status: "pending" }],
			nextId: 2,
		}),
	];
	await fireRound(m, branch, 1);
	check("S16 失败不注入", m.sent.length, 0);
	fail = false;
	await fireRound(m, branch, 2);
	check("S16 下轮重试成功", m.sent.length, 1);
	check("S16 文本为证明点", m.sent[0]?.includes("还有 1 项 todo 未完成"), true);
}

// ── 场景 17：冻结输入 completed 不崩且放行（v0.4.2：写回尽力而为）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const input = Object.freeze({
		action: "update",
		id: 1,
		status: "completed",
		metadata: Object.freeze({ evidence: { cmd: "npm test" } }),
	});
	const ret = await m.fire("tool_call", { toolName: "todo", input } as never);
	check("S17 冻结输入放行", ret, undefined);
}

// ── 场景 18：metadata 存在 + 顶层 evidence 回退（v0.4.2：回退与 metadata 缺失时一致）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const input = {
		action: "update",
		id: 1,
		status: "completed",
		metadata: { note: "x" },
		evidence: {
			kind: "runnable",
			evidence: [{ type: "cmd", cmd: "echo", exit: 0 }],
		},
	};
	const ret = await m.fire("tool_call", { toolName: "todo", input } as never);
	check("S18 顶层 evidence 回退放行", ret, undefined);
	check(
		"S18 规范化写回 metadata",
		(input.metadata as { evidence?: { kind?: string } }).evidence?.kind,
		"runnable",
	);
}

// ── 场景 19：⑤证明点注入不清 pendingVerify，⑥ 之后仍触发（v0.4.3：集合交叉清理回归）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("干活"),
		toolResult("todo", {
			action: "update",
			params: {},
			tasks: [
				{ id: 1, subject: "任务A", status: "completed" },
				{ id: 2, subject: "任务B", status: "pending" },
			],
			nextId: 3,
		}),
	];
	// 任务 A 已完成（格式闸放行 → 进 pendingVerify）
	const input = {
		action: "update",
		id: 1,
		status: "completed",
		metadata: {
			evidence: {
				kind: "runnable",
				evidence: [{ type: "cmd", cmd: "echo", exit: 0 }],
			},
		},
	};
	await m.fire(
		"tool_call",
		{ toolName: "todo", input } as never,
		turnCtx(branch),
	);
	const realNow = Date.now;
	let fakeNow = realNow();
	Date.now = () => fakeNow;
	try {
		// 轮 1：B pending → ⑤ 证明点注入（优先级高于 ⑥，但不得清 pendingVerify）
		await fireRound(m, branch, 1);
		check(
			"S19 先注入证明点",
			m.sent[0]?.includes("还有 1 项 todo 未完成"),
			true,
		);
		fakeNow += 130_000; // 越过 120s 退避
		// 轮 2：全部完成 → ⑥ 验证义务必须仍触发（A 的验证义务未被冲掉）
		const branch2 = [
			userMsg("干活"),
			toolResult("todo", {
				action: "update",
				params: {},
				tasks: [
					{ id: 1, subject: "任务A", status: "completed" },
					{ id: 2, subject: "任务B", status: "completed" },
				],
				nextId: 3,
			}),
		];
		await fireRound(m, branch2, 2);
		check("S19 ⑥ 验证义务仍触发", m.sent.length, 2);
		check("S19 ⑥ 文本含已标记完成", m.sent[1]?.includes("已标记完成"), true);
	} finally {
		Date.now = realNow;
	}
}

// ── 场景 20：turn_end 注入失败 → 同轮 agent_settled 兜底重试（v0.4.3：失败释放回合占位）──
{
	const m = mockPi();
	let fail = true;
	const origSend = m.pi.sendMessage;
	m.pi.sendMessage = async (msg, opts) => {
		if (fail) throw new Error("transport down");
		return origSend(msg, opts);
	};
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("做任务"),
		toolCall("todo", { action: "create", subject: "任务A" }),
		toolResult("todo", {
			action: "create",
			params: {},
			tasks: [{ id: 1, subject: "任务A", status: "pending" }],
			nextId: 2,
		}),
	];
	await m.fire("agent_start", {} as never);
	await m.fire(
		"turn_end",
		{ turnIndex: 1, message: {}, toolResults: [] } as never,
		turnCtx(branch),
	);
	check("S20 turn_end 失败不注入", m.sent.length, 0);
	fail = false;
	await m.fire("agent_settled", {} as never, turnCtx(branch));
	check("S20 同轮 settled 兜底重试成功", m.sent.length, 1);
	check("S20 兜底走 followUp", m.sentDeliverAs[0], "followUp");
}

// ── 场景 21：pendingParallel 陈旧 id（任务已 completed）不注入（0.4.1 无存活过滤的回归锚定）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	// 任务 2 in_progress（blockedBy [1] 未完成）→ 进 pendingParallel
	const branch1 = [
		userMsg("干活"),
		toolResult("todo", {
			action: "update",
			params: {},
			tasks: [
				{ id: 1, subject: "前置", status: "pending" },
				{ id: 2, subject: "下游", status: "in_progress", blockedBy: [1] },
			],
			nextId: 3,
		}),
	];
	await m.fire(
		"tool_call",
		{
			toolName: "todo",
			input: { action: "update", id: 2, status: "in_progress" },
		} as never,
		turnCtx(branch1),
	);
	// 任务 2 已完成 → 新轮 turn_end：陈旧 id 丢弃，不注入 ③
	const branch2 = [
		userMsg("干活"),
		toolResult("todo", {
			action: "update",
			params: {},
			tasks: [
				{ id: 1, subject: "前置", status: "completed" },
				{ id: 2, subject: "下游", status: "completed", blockedBy: [1] },
			],
			nextId: 3,
		}),
	];
	await fireRound(m, branch2, 1);
	check("S21 陈旧 pendingParallel 不注入", m.sent.length, 0);
}

// ── 场景 22：畸形快照（blockedBy 标量）不崩门禁（v0.4.4：tool_call 数据边界防御）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("干活"),
		toolResult("todo", {
			action: "update",
			params: {},
			tasks: [
				{ id: 1, subject: "前置", status: "pending" },
				{ id: 2, subject: "下游", status: "in_progress", blockedBy: "1" },
			],
			nextId: 3,
		}),
	];
	const ret = await m.fire(
		"tool_call",
		{
			toolName: "todo",
			input: { action: "update", id: 2, status: "in_progress" },
		} as never,
		turnCtx(branch),
	);
	check("S22 畸形 blockedBy 不崩", ret, undefined);
}

// ── 场景 23：⑥ 验证义务注入（全完成 + 待语义验证项；v0.4.4：全完成树不判停滞，⑥ 不被 ① 饿死）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const evidence = {
		kind: "runnable",
		evidence: [{ type: "cmd", cmd: "echo", exit: 0 }],
	};
	const ret = await m.fire(
		"tool_call",
		{
			toolName: "todo",
			input: { action: "update", id: 1, status: "completed", metadata: { evidence } },
		} as never,
	);
	check("S23 evidence 放行", ret, undefined);
	const branch = [
		userMsg("做任务"),
		toolResult("todo", {
			action: "update",
			params: {},
			tasks: [{ id: 1, subject: "任务A", status: "completed" }],
			nextId: 2,
		}),
	];
	await fireRound(m, branch, 1);
	check("S23 验证义务注入", m.sent.length, 1);
	check("S23 文本含独立验证", m.sent[0]?.includes("独立验证"), true);
}

// ── 场景 24：全完成树 4 回合不误诊停滞（incomplete=0 不计数；v0.4.4 修复 ① 饿死 ⑥ 的根因）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("干活"),
		toolResult("todo", {
			action: "update",
			params: {},
			tasks: [{ id: 1, subject: "A", status: "completed" }],
			nextId: 2,
		}),
	];
	const realNow = Date.now;
	let fakeNow = realNow();
	Date.now = () => fakeNow;
	try {
		for (let r = 1; r <= 4; r++) {
			await fireRound(m, branch, r);
			fakeNow += 130_000; // 每次越过退避窗口：若误计数，① 会在第 3 回合触发
		}
	} finally {
		Date.now = realNow;
	}
	check("S24 无停滞报告", m.sent.some((t) => t.includes("重新审视")), false);
	check("S24 无任何注入", m.sent.length, 0);
}

// ── 场景 25：交互静默（quietAfterMs 窗口内不注入；mock timestamp 对齐后此分支可测）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const realNow = Date.now;
	let fakeNow = realNow();
	Date.now = () => fakeNow;
	try {
		const branch = [
			userMsg("做任务", new Date(fakeNow - 10_000).toISOString()),
			toolCall("todo", { action: "create", subject: "任务A" }),
			toolResult("todo", {
				action: "create",
				params: {},
				tasks: [{ id: 1, subject: "任务A", status: "pending" }],
				nextId: 2,
			}),
		];
		await fireRound(m, branch, 1);
		check("S25 静默窗口内不注入", m.sent.length, 0);
		fakeNow += 200_000; // 越过 120s 静默窗口
		await fireRound(m, branch, 2);
		check("S25 窗口过后注入", m.sent.length, 1);
	} finally {
		Date.now = realNow;
	}
}

// ── 场景 26：重复注册幂等（同实例二次加载不重复注册，防双注入；v0.4.4）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	todoneExtension(m.pi as never); // 第二次调用应被 WeakSet 守卫忽略
	const branch = [
		userMsg("做任务"),
		toolCall("todo", { action: "create", subject: "任务A" }),
		toolResult("todo", {
			action: "create",
			params: {},
			tasks: [{ id: 1, subject: "任务A", status: "pending" }],
			nextId: 2,
		}),
	];
	await fireRound(m, branch, 1);
	check("S26 重复注册只注入一次", m.sent.length, 1);
}
// ── 场景 27：block-storm 抑制（同一任务同一原因连续 block ≥2 附强提示；v0.4.6）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const noEvidence = { action: "update", id: 1, status: "completed" };
	const r1 = (await m.fire("tool_call", { toolName: "todo", input: noEvidence } as never)) as {
		block?: boolean;
		reason?: string;
	};
	check("S27 第 1 次 block", r1.block, true);
	check("S27 第 1 次无风暴提示", String(r1.reason).includes("第2次拦截"), false);
	const r2 = (await m.fire("tool_call", { toolName: "todo", input: noEvidence } as never)) as {
		block?: boolean;
		reason?: string;
	};
	check("S27 第 2 次仍 block", r2.block, true);
	check("S27 第 2 次附风暴提示", String(r2.reason).includes("第2次拦截同一调用"), true);
	check("S27 提示含逃生口", String(r2.reason).includes("标回 pending"), true);
	const r3 = (await m.fire("tool_call", { toolName: "todo", input: noEvidence } as never)) as {
		block?: boolean;
		reason?: string;
	};
	check("S27 第 3 次计数递增", String(r3.reason).includes("第3次拦截同一调用"), true);
	// 非 block 的状态变更 → 计数复位
	const ok = await m.fire(
		"tool_call",
		{ toolName: "todo", input: { action: "update", id: 1, status: "pending" } } as never,
	);
	check("S27 pending 回退放行", (ok as { block?: boolean })?.block, undefined);
	const r4 = (await m.fire("tool_call", { toolName: "todo", input: noEvidence } as never)) as {
		block?: boolean;
		reason?: string;
	};
	check("S27 复位后从 1 计", String(r4.reason).includes("第2次拦截"), false);
}

if (failed > 0) {
	console.error(`\n${failed} 断言失败`);
	process.exit(1);
}
console.log("\nE2E 全部通过");
