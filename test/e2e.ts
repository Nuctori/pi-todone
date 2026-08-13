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
	const pi = {
		on: (evt: string, h: Handler) => {
			(handlers[evt] ??= []).push(h);
		},
		sendUserMessage: async (text: string) => {
			sent.push(text);
		},
	};
	return {
		pi,
		handlers,
		sent,
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

if (failed > 0) {
	console.error(`\n${failed} 断言失败`);
	process.exit(1);
}
console.log("\nE2E 全部通过");
