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
	const pi = {
		on: (evt: string, h: Handler) => {
			(handlers[evt] ??= []).push(h);
		},
		sendUserMessage: async (text: string) => {
			sent.push(text);
			sentTypes.push("userMessage");
		},
		sendMessage: async (msg: { customType?: string; content?: string }, _opts: unknown) => {
			sent.push(String(msg.content ?? ""));
			sentTypes.push(String(msg.customType ?? ""));
		},
	};
	return {
		pi,
		handlers,
		sent,
		sentTypes,
		fire: async (evt: string, event: never, ctx: never = {} as never) => {
			let last: unknown;
			for (const h of handlers[evt] ?? []) last = await h(event, ctx);
			return last;
		},
	};
}

let failed = 0;
function check(name: string, actual: unknown, expect: unknown) {
	const ok = actual === expect;
	if (!ok) {
		failed++;
		console.error(`FAIL ${name}: expected ${JSON.stringify(expect)}, got ${JSON.stringify(actual)}`);
	} else {
		console.log(`ok   ${name}`);
	}
}

function userMsg(text: string) {
	return { type: "message", message: { role: "user", content: text, timestamp: "2026-08-13T00:00:00.000Z" } };
}
function toolCall(name: string, args: unknown) {
	return { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] } };
}
function toolResult(name: string, details: unknown) {
	return { type: "message", message: { role: "toolResult", toolName: name, details } };
}

// ── 场景 1：格式闸 block（无 evidence）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const input = { action: "update", id: 1, status: "completed" };
	const ret = await m.fire("tool_call", { toolName: "todo", input } as never);
	check("S1 无证据 block", (ret as { block?: boolean })?.block, true);
	check("S1 reason 含格式指南", String((ret as { reason?: string })?.reason).includes("metadata.evidence"), true);
}

// ── 场景 2：格式闸放行 + 归一化（evidence 单对象、缺 kind）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const input = { action: "update", id: 1, status: "completed", metadata: { evidence: { cmd: "npm test" } } };
	const ret = await m.fire("tool_call", { toolName: "todo", input } as never);
	check("S2 归一化放行", ret, undefined);
	const ev = (input.metadata as { evidence: { kind?: string; evidence?: unknown[] } }).evidence;
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
		toolResult("todo", { action: "create", params: {}, tasks: [{ id: 1, subject: "任务A", status: "pending" }], nextId: 2 }),
		toolCall("todo", { action: "update", id: 1, status: "in_progress" }),
		toolResult("todo", { action: "update", params: {}, tasks: [{ id: 1, subject: "任务A", status: "in_progress" }], nextId: 2 }),
	];
	await m.fire("agent_end", {} as never, { sessionManager: { getBranch: () => branch } } as never);
	check("S3 注入了一次", m.sent.length, 1);
	check("S3 文本含未完成计数", m.sent[0]?.includes("还有 1 项 todo 未完成"), true);
	check("S3 文本含任务清单", m.sent[0]?.includes("任务A"), true);
}

// ── 场景 4：创建义务注入（≥5 工具调用且未拆 todo）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("帮我实现一个复杂功能"),
		toolCall("ctx_read", { path: "a.ts" }),
		toolResult("ctx_read", {}),
		toolCall("ctx_read", { path: "b.ts" }),
		toolResult("ctx_read", {}),
		toolCall("ctx_grep", { pattern: "x" }),
		toolResult("ctx_grep", {}),
		toolCall("ctx_grep", { pattern: "y" }),
		toolResult("ctx_grep", {}),
		toolCall("ctx_read", { path: "c.ts" }),
		toolResult("ctx_read", {}),
	];
	await m.fire("agent_end", {} as never, { sessionManager: { getBranch: () => branch } } as never);
	check("S4 创建义务注入", m.sent.length, 1);
	check("S4 文本含未拆 todo", m.sent[0]?.includes("未拆 todo"), true);
	check("S4 文本含粒度规范", m.sent[0]?.includes("可独立验证"), true);
}

// ── 场景 5：L1 静态注入幂等 ──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const base = { customPrompt: "", selectedTools: [], toolSnippets: [], promptGuidelines: [], appendSystemPrompt: "", cwd: ".", contextFiles: [], skills: [] };
	const r1 = await m.fire("before_agent_start", { systemPromptOptions: { ...base } } as never);
	const g1 = (r1 as { systemPromptOptions: { promptGuidelines: string[] } }).systemPromptOptions.promptGuidelines;
	check("S5 追加了一条", g1.length, 1);
	check("S5 内容为义务摘要", g1[0]?.includes("Todo 义务"), true);
	const opts2 = { ...base, promptGuidelines: [...g1] };
	const r2 = await m.fire("before_agent_start", { systemPromptOptions: opts2 } as never);
	check("S5 幂等不重复", r2, undefined);
}

// ── 场景 6：小任务豁免（1 次工具调用不注入）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [userMsg("改一行"), toolCall("edit", { path: "a.ts" }), toolResult("edit", {})];
	await m.fire("agent_end", {} as never, { sessionManager: { getBranch: () => branch } } as never);
	check("S6 小任务不注入", m.sent.length, 0);
}
// ── 场景 6：小任务豁免（1 次工具调用不注入）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [userMsg("改一行"), toolCall("edit", { path: "a.ts" }), toolResult("edit", {})];
	await m.fire("agent_end", {} as never, { sessionManager: { getBranch: () => branch } } as never);
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
		toolResult("todo", { action: "create", params: {}, tasks: [{ id: 1, subject: "根", status: "pending" }], nextId: 2 }),
	];
	const input = { action: "create", subject: "子", metadata: { parentId: 99 } };
	const ret = await m.fire("tool_call", { toolName: "todo", input } as never, {
		sessionManager: { getBranch: () => branch },
	} as never);
	check("S7 挂不存在父 block", (ret as { block?: boolean })?.block, true);
	// 父 completed 子 pending → block
	const branch2 = [
		userMsg("做任务"),
		toolCall("todo", { action: "update", id: 1, status: "completed", metadata: { evidence: { kind: "runnable", evidence: [{ type: "cmd", cmd: "echo", exit: 0 }] } } }),
		toolResult("todo", { action: "update", params: {}, tasks: [{ id: 1, subject: "父", status: "in_progress" }, { id: 2, subject: "子", status: "pending", metadata: { parentId: 1 } }], nextId: 3 }),
	];
	const input2 = { action: "update", id: 1, status: "completed", metadata: { evidence: { kind: "runnable", evidence: [{ type: "cmd", cmd: "echo", exit: 0 }] } } };
	const ret2 = await m.fire("tool_call", { toolName: "todo", input: input2 } as never, {
		sessionManager: { getBranch: () => branch2 },
	} as never);
	check("S7 父完成子未完成 block", (ret2 as { block?: boolean })?.block, true);
	// 子全完成 → 放行（无树错误，走 evidence 闸）
	const branch3 = [
		userMsg("做任务"),
		toolResult("todo", { action: "update", params: {}, tasks: [{ id: 1, subject: "父", status: "in_progress" }, { id: 2, subject: "子", status: "completed", metadata: { parentId: 1 } }], nextId: 3 }),
	];
	const ret3 = await m.fire("tool_call", { toolName: "todo", input: { ...input2 } } as never, {
		sessionManager: { getBranch: () => branch3 },
	} as never);
	check("S7 子全完成放行", ret3, undefined);
}

// ── 场景 8：并行就绪建议（依赖未完成就 in_progress → 注入确认）──
{
	const m = mockPi();
	todoneExtension(m.pi as never);
	const branch = [
		userMsg("干活"),
		toolCall("todo", { action: "update", id: 2, status: "in_progress" }),
		toolResult("todo", { action: "update", params: {}, tasks: [
			{ id: 1, subject: "前置", status: "pending" },
			{ id: 2, subject: "下游", status: "in_progress", blockedBy: [1] },
		], nextId: 3 }),
	];
	await m.fire("agent_end", {} as never, { sessionManager: { getBranch: () => branch } } as never);
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
		toolResult("todo", { action: "create", params: {}, tasks: [
			{ id: 1, subject: "目标A", status: "pending" },
			{ id: 2, subject: "可并行项", status: "pending" },
		], nextId: 3 }),
	];
	await m.fire("agent_end", {} as never, { sessionManager: { getBranch: () => branch } } as never);
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
		toolResult("todo", { action: "create", params: {}, tasks: [{ id: 1, subject: "任务A", status: "pending" }], nextId: 2 }),
	];
	await m.fire("agent_end", {} as never, { sessionManager: { getBranch: () => branch } } as never);
	check("S10 注入一次", m.sent.length, 1);
	check("S10 走 sendMessage customType", m.sentTypes[0], "pi-todone");
}
if (failed > 0) {
	console.error(`\n${failed} 断言失败`);
	process.exit(1);
}
console.log("\nE2E 全部通过");
