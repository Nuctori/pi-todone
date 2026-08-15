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

// ── 场景 8：并行就绪建议（依赖未完成就 in_progress → 注入确认；v0.4.8 起真触发 ③ 分支）──
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
	// 必须先 fire tool_call：pendingParallel 由硬闸 in_progress 分支填充（否则 ③ 不执行，旧版是空转测试）
	await m.fire(
		"tool_call",
		{
			toolName: "todo",
			input: { action: "update", id: 2, status: "in_progress" },
		} as never,
		turnCtx(branch),
	);
	await fireRound(m, branch, 1);
	check("S8 并行确认注入", m.sent.length, 1);
	check("S8 文本含前置未完成", m.sent[0]?.includes("前置 #1 未完成"), true);
	check(
		"S8 文本为③专属",
		m.sent[0]?.includes("以下任务在前置未完成时已开始"),
		true,
	);
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

// ── 场景 14：agent_settled 兜底（无未完成 todo 时补一次，走 followUp 不 triggerTurn；v0.6.0 起 ⑦ 只拦未完成）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("做任务"),
		toolResult("todo", {
			action: "update",
			params: {},
			tasks: [{ id: 1, subject: "任务A", status: "completed" }],
			nextId: 2,
		}),
	];
	// 先放行完成项进 pendingVerify（⑥ 验证义务触发条件；全完成则 ⑦ 不拦）
	const ret = await m.fire(
		"tool_call",
		{
			toolName: "todo",
			input: {
				action: "update",
				id: 1,
				status: "completed",
				metadata: {
					evidence: {
						kind: "runnable",
						evidence: [{ type: "cmd", cmd: "echo", exit: 0 }],
					},
				},
			},
		} as never,
		turnCtx(branch),
	);
	check("S14 放行", ret, undefined);
	await m.fire("agent_start", {} as never);
	await m.fire("agent_settled", {} as never, turnCtx(branch));
	check("S14 settled 兜底注入", m.sent.length, 1);
	check("S14 兜底走 followUp", m.sentDeliverAs[0], "followUp");
	check("S14 兜底不 triggerTurn", m.sentTriggerTurn[0], false);
}

// ── 场景 15：settled 最后通牒（turn_end 已提示，收尾仍 ⑦ 强制；已通知后静默；v0.6.0）──
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
	check("S15 settled 最后通牒", m.sent.length, 2);
	check("S15 通牒文本含禁止收尾", m.sent[1]?.includes("禁止直接收尾"), true);
	await m.fire("agent_settled", {} as never, turnCtx(branch));
	check("S15 已通知后静默", m.sent.length, 2);
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
	const ret = await m.fire("tool_call", {
		toolName: "todo",
		input: {
			action: "update",
			id: 1,
			status: "completed",
			metadata: { evidence },
		},
	} as never);
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
	check(
		"S24 无停滞报告",
		m.sent.some((t) => t.includes("重新审视")),
		false,
	);
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
	const r1 = (await m.fire("tool_call", {
		toolName: "todo",
		input: noEvidence,
	} as never)) as {
		block?: boolean;
		reason?: string;
	};
	check("S27 第 1 次 block", r1.block, true);
	check(
		"S27 第 1 次无风暴提示",
		String(r1.reason).includes("第2次拦截"),
		false,
	);
	const r2 = (await m.fire("tool_call", {
		toolName: "todo",
		input: noEvidence,
	} as never)) as {
		block?: boolean;
		reason?: string;
	};
	check("S27 第 2 次仍 block", r2.block, true);
	check(
		"S27 第 2 次附风暴提示",
		String(r2.reason).includes("第2次拦截同一调用"),
		true,
	);
	check("S27 提示含逃生口", String(r2.reason).includes("标回 pending"), true);
	const r3 = (await m.fire("tool_call", {
		toolName: "todo",
		input: noEvidence,
	} as never)) as {
		block?: boolean;
		reason?: string;
	};
	check(
		"S27 第 3 次计数递增",
		String(r3.reason).includes("第3次拦截同一调用"),
		true,
	);
	// 非 block 的状态变更 → 计数复位
	const ok = await m.fire("tool_call", {
		toolName: "todo",
		input: { action: "update", id: 1, status: "pending" },
	} as never);
	check("S27 pending 回退放行", (ok as { block?: boolean })?.block, undefined);
	const r4 = (await m.fire("tool_call", {
		toolName: "todo",
		input: noEvidence,
	} as never)) as {
		block?: boolean;
		reason?: string;
	};
	check("S27 复位后从 1 计", String(r4.reason).includes("第2次拦截"), false);
}

// ── 场景 28：并行建议依赖复查（快照竞态误记条目依赖完成后退场，不误报；v0.4.7）──
{
	// 公共：先 fire tool_call（依赖未完成）把任务记入 pendingParallel，再以不同快照注入
	const fireStart = async (m: ReturnType<typeof mockPi>) => {
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
		await m.fire(
			"tool_call",
			{
				toolName: "todo",
				input: { action: "update", id: 2, status: "in_progress" },
			} as never,
			turnCtx(branch),
		);
	};
	// A：注入时依赖已完成（并行块竞态消解）→ 不注入
	const m = mockPi();
	todoneExtension(m.pi as never);
	await fireStart(m);
	await fireRound(
		m,
		[
			userMsg("干活"),
			toolResult("todo", {
				action: "update",
				params: {},
				tasks: [
					{ id: 1, subject: "前置", status: "completed" },
					{ id: 2, subject: "下游", status: "in_progress", blockedBy: [1] },
				],
				nextId: 3,
			}),
		],
		1,
	);
	check("S28 依赖已完成不注入", m.sent.length, 0);
	// B：注入时依赖已 deleted → 不算未完成，不注入
	const m2 = mockPi();
	todoneExtension(m2.pi as never);
	await fireStart(m2);
	await fireRound(
		m2,
		[
			userMsg("干活"),
			toolResult("todo", {
				action: "update",
				params: {},
				tasks: [
					{ id: 1, subject: "前置", status: "deleted" },
					{ id: 2, subject: "下游", status: "in_progress", blockedBy: [1] },
				],
				nextId: 3,
			}),
		],
		1,
	);
	check("S28 依赖已删除不注入", m2.sent.length, 0);
	// C：注入时依赖仍 pending → 真跳步仍提示（回归锚定 S8 语义）
	const m3 = mockPi();
	todoneExtension(m3.pi as never);
	await fireStart(m3);
	await fireRound(
		m3,
		[
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
		],
		1,
	);
	check("S28 真跳步仍提示", m3.sent.length, 1);
	check("S28 提示含依赖", m3.sent[0]?.includes("#1"), true);
}

// ── 场景 29：gate 硬门禁（声明 test/audit 的节点完成须满足对应证据；v0.5.0）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("干活"),
		toolResult("todo", {
			action: "update",
			params: {},
			tasks: [
				{
					id: 1,
					subject: "带测试门禁",
					status: "in_progress",
					metadata: { gate: { test: true } },
				},
				{
					id: 2,
					subject: "带审计门禁",
					status: "in_progress",
					metadata: { gate: "audit" },
				},
			],
			nextId: 3,
		}),
	];
	const fire = (input: unknown) =>
		m.fire("tool_call", { toolName: "todo", input } as never, turnCtx(branch));
	// test 门禁：cmd 证据 exit 1 → block
	const r1 = (await fire({
		action: "update",
		id: 1,
		status: "completed",
		metadata: {
			evidence: {
				kind: "runnable",
				evidence: [{ type: "cmd", cmd: "npm test", exit: 1 }],
			},
		},
	})) as { block?: boolean; reason?: string };
	check("S29 test 门禁 exit1 block", r1.block, true);
	check(
		"S29 提示含 test 硬门禁",
		String(r1.reason).includes("test 硬门禁"),
		true,
	);
	// 补 exit 0 → 放行
	const r2 = await fire({
		action: "update",
		id: 1,
		status: "completed",
		metadata: {
			evidence: {
				kind: "runnable",
				evidence: [{ type: "cmd", cmd: "npm test", exit: 0 }],
			},
		},
	});
	check("S29 test 门禁 exit0 放行", r2, undefined);
	// audit 门禁：无 review → block
	const r3 = (await fire({
		action: "update",
		id: 2,
		status: "completed",
		metadata: {
			evidence: {
				kind: "runnable",
				evidence: [{ type: "cmd", cmd: "npm test", exit: 0 }],
			},
		},
	})) as { block?: boolean; reason?: string };
	check("S29 audit 门禁无 review block", r3.block, true);
	check(
		"S29 提示含 audit 硬门禁",
		String(r3.reason).includes("audit 硬门禁"),
		true,
	);
	// 补 review → 放行
	const r4 = await fire({
		action: "update",
		id: 2,
		status: "completed",
		metadata: {
			evidence: {
				kind: "runnable",
				evidence: [
					{ type: "review", agent: "reviewer", path: "/tmp/r.md" },
					{ type: "cmd", cmd: "npm test", exit: 0 },
				],
			},
		},
	});
	check("S29 audit 门禁 review 放行", r4, undefined);
}

// ── 场景 30：⑥ 验证义务对 gate 节点强化措辞（必复核，点名硬门禁；v0.5.0）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("做任务"),
		toolResult("todo", {
			action: "update",
			params: {},
			tasks: [
				{
					id: 1,
					subject: "带门禁",
					status: "completed",
					metadata: { gate: { test: true, audit: true } },
				},
			],
			nextId: 2,
		}),
	];
	const evidence = {
		kind: "runnable",
		evidence: [
			{ type: "cmd", cmd: "npm test", exit: 0 },
			{ type: "review", agent: "reviewer", path: "r.md" },
		],
	};
	const ret = await m.fire(
		"tool_call",
		{
			toolName: "todo",
			input: {
				action: "update",
				id: 1,
				status: "completed",
				metadata: { evidence },
			},
		} as never,
		turnCtx(branch),
	);
	check("S30 gate 节点放行", ret, undefined);
	await fireRound(m, branch, 1);
	check("S30 ⑥ 注入一次", m.sent.length, 1);
	check("S30 强化措辞点名硬门禁", m.sent[0]?.includes("硬门禁"), true);
	check("S30 要求必复核", m.sent[0]?.includes("必须 spawn"), true);
}

// ── 场景 31：⑥ 混合批次点名（gate + 普通节点同轮 completed → 文本同时点名两者；审计 blocker 锚定）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("做任务"),
		toolResult("todo", {
			action: "update",
			params: {},
			tasks: [
				{
					id: 1,
					subject: "带门禁",
					status: "completed",
					metadata: { gate: { test: true } },
				},
				{ id: 2, subject: "普通", status: "completed" },
			],
			nextId: 3,
		}),
	];
	// 同轮先后 completed：两条都进 pendingVerify（gate + 普通混合批次）
	for (const id of [1, 2]) {
		const ret = await m.fire(
			"tool_call",
			{
				toolName: "todo",
				input: {
					action: "update",
					id,
					status: "completed",
					metadata: {
						evidence: {
							kind: "runnable",
							evidence: [{ type: "cmd", cmd: "npm test", exit: 0 }],
						},
					},
				},
			} as never,
			turnCtx(branch),
		);
		check(`S31 任务 #${id} 放行`, ret, undefined);
	}
	await fireRound(m, branch, 1);
	check("S31 ⑥ 注入一次", m.sent.length, 1);
	check("S31 同时点名 gate 与普通", m.sent[0]?.includes("任务 #1, 2"), true);
	check("S31 gated 附硬门禁强调", m.sent[0]?.includes("其中 #1"), true);
	check("S31 普通项被点名覆盖", m.sent[0]?.includes("其余完成项"), true);
}

// ── 场景 32：⑦ 收尾强制（agent_settled 时 todo 未完成 → 顶回强制交代；v0.6.0）──
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
	// 收尾（settled）时 todo 未完成 → 最后通牒强制交代
	await m.fire("agent_settled", {} as never, turnCtx(branch));
	check("S32 收尾强制注入", m.sent.length, 1);
	check("S32 文本含禁止直接收尾", m.sent[0]?.includes("禁止直接收尾"), true);
	check("S32 走 followUp", m.sentDeliverAs[0], "followUp");
	check("S32 triggerTurn 强制新回合", m.sentTriggerTurn[0], true);
	// 同回合再收尾：已强制交代过一次 → 静默放行
	await m.fire("agent_settled", {} as never, turnCtx(branch));
	check("S32 已通知过静默", m.sent.length, 1);
	// 有进展（pending→in_progress 计数变化）→ 复位 → 收尾再强制
	const branch2 = [
		...branch,
		toolResult("todo", {
			action: "update",
			params: {},
			tasks: [
				{ id: 1, subject: "任务A", status: "in_progress" },
				{ id: 2, subject: "任务B", status: "pending" },
			],
			nextId: 2,
		}),
	];
	await m.fire("agent_start", {} as never);
	await m.fire(
		"turn_end",
		{ turnIndex: 2, message: {}, toolResults: [] } as never,
		turnCtx(branch2),
	);
	await m.fire("agent_settled", {} as never, turnCtx(branch2));
	check("S32 进展后复位再强制", m.sent.length, 2);
	// 全部完成 → 收尾不强制（⑦ 负例）
	const branch3 = [
		...branch,
		toolResult("todo", {
			action: "update",
			params: {},
			tasks: [{ id: 1, subject: "任务A", status: "completed" }],
			nextId: 2,
		}),
	];
	await m.fire("agent_start", {} as never);
	await m.fire("agent_settled", {} as never, turnCtx(branch3));
	await m.fire("agent_settled", {} as never, turnCtx(branch3));
	check("S32 全完成后不强制", m.sent.length, 2);
}

// ── 场景 33：⑦ 交互静默（用户在交互时 settled 不顶回；v0.6.0）──
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
		await m.fire("agent_settled", {} as never, turnCtx(branch));
		check("S33 静默窗口内 settled 不顶回", m.sent.length, 0);
		fakeNow += 200_000; // 越过 120s 静默窗口
		await m.fire("agent_settled", {} as never, turnCtx(branch));
		check("S33 窗口过后顶回", m.sent.length, 1);
		check("S33 文本含禁止收尾", m.sent[0]?.includes("禁止直接收尾"), true);
	} finally {
		Date.now = realNow;
	}
}

// ── 场景 34：⑦ 用户介入复位（新消息后收尾再强制；v0.6.0）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const realNow = Date.now;
	let fakeNow = realNow();
	Date.now = () => fakeNow;
	try {
		const branch = [
			userMsg("做任务", new Date(fakeNow - 300_000).toISOString()),
			toolCall("todo", { action: "create", subject: "任务A" }),
			toolResult("todo", {
				action: "create",
				params: {},
				tasks: [{ id: 1, subject: "任务A", status: "pending" }],
				nextId: 2,
			}),
		];
		await m.fire("agent_settled", {} as never, turnCtx(branch));
		check("S34 首次强制", m.sent.length, 1);
		// 用户介入（新消息）→ 越过退避+静默窗口 → 复位生效 → 收尾再强制
		const branch2 = [
			...branch,
			userMsg("继续", new Date(fakeNow + 10_000).toISOString()),
		];
		fakeNow += 200_000;
		await m.fire("agent_start", {} as never);
		await m.fire(
			"turn_end",
			{ turnIndex: 2, message: {}, toolResults: [] } as never,
			turnCtx(branch2),
		);
		await m.fire("agent_settled", {} as never, turnCtx(branch2));
		check(
			"S34 用户介入后收尾再强制",
			m.sent[m.sent.length - 1]?.includes("禁止直接收尾"),
			true,
		);
	} finally {
		Date.now = realNow;
	}
}

if (failed > 0) {
	console.error(`\n${failed} 断言失败`);
	process.exit(1);
}
console.log("\nE2E 全部通过");
