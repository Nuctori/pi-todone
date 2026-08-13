/**
 * pi-todone 自检：validateEvidence 格式闸 + scanTodoSnapshot 快照扫描。
 * 运行：node --experimental-strip-types src/demo.ts （Node >= 22.6）
 * 非零退出码 = 有断言失败。
 */
import { validateEvidence, normalizeEvidence, scanTodoSnapshot, unitToolStats, validateParentRef, canCompleteTree } from "./index.ts";

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

// ── validateEvidence ──
check("空值", validateEvidence(null), "evidence 缺失或非对象");
check("非对象", validateEvidence("x"), "evidence 缺失或非对象");
check("缺 kind", validateEvidence({ evidence: [] }), "kind 必须是 state|runnable|effect，实际: undefined");
check("非法 kind", validateEvidence({ kind: "magic", evidence: [] }), "kind 必须是 state|runnable|effect，实际: magic");
check("effect 放行", validateEvidence({ kind: "effect", evidence: [] }), null);
check("state 无证据", validateEvidence({ kind: "state", evidence: [] }), "state 类至少需要 1 条证据");
check("state 证据非数组", validateEvidence({ kind: "state", evidence: "x" }), "state 类至少需要 1 条证据");
check("state 缺 path", validateEvidence({ kind: "state", evidence: [{ type: "file" }] }), "file 证据缺 path");
check("state 非法 op", validateEvidence({ kind: "state", evidence: [{ type: "file", path: "a.ts", op: "touch" }] }), "file 证据 op 非法: touch");
check("state 合法", validateEvidence({ kind: "state", evidence: [{ type: "file", path: "src/a.ts", op: "edit" }] }), null);
check("state 混入 cmd 无 file", validateEvidence({ kind: "state", evidence: [{ type: "cmd", cmd: "ls" }] }), "state 类必须有 file 证据");
check("runnable 无 cmd", validateEvidence({ kind: "runnable", evidence: [{ type: "file", path: "a.ts" }] }), "runnable 类必须有 cmd 证据");
check("runnable 合法", validateEvidence({ kind: "runnable", evidence: [{ type: "cmd", cmd: "npm test", exit: 0 }] }), null);
check("runnable exit 非数字", validateEvidence({ kind: "runnable", evidence: [{ type: "cmd", cmd: "npm test", exit: "0" }] }), "cmd 证据 exit 必须为数字");
check("未知证据类型", validateEvidence({ kind: "runnable", evidence: [{ type: "curl", cmd: "x" }] }), "证据 type 必须是 file|cmd，实际: curl");

// ── scanTodoSnapshot ──
const branch = [
	{ type: "message", message: { role: "user", toolName: "", details: undefined } },
	{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [{ id: 1, subject: "旧", status: "completed" }], nextId: 2 } } },
	{ type: "message", message: { role: "toolResult", toolName: "todo", details: { details: { tasks: [{ id: 1, subject: "新", status: "in_progress" }], nextId: 2 } } } },
	{ type: "message", message: { role: "toolResult", toolName: "bash", details: {} } },
];
const snap = scanTodoSnapshot(branch as never);
check("快照取最新", snap?.tasks?.[0]?.subject, "新");
check("快照嵌套 details", snap?.tasks?.[0]?.status, "in_progress");
check("无 todo 返回 null", scanTodoSnapshot([{ type: "message", message: { role: "toolResult", toolName: "bash", details: {} } }] as never), null);

// ── unitToolStats ──
const unitBranch = [
	{ type: "message", message: { role: "user", content: [{ type: "text", text: "做 X" }] } },
	{
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", name: "ctx_grep", arguments: '{"pattern":"x"}' },
				{ type: "toolCall", name: "todo", arguments: '{"action":"create","subject":"任务A"}' },
				{ type: "toolCall", name: "todo", arguments: { action: "update", id: 1, status: "in_progress" } },
			],
		},
	},
	{ type: "message", message: { role: "toolResult", toolName: "ctx_grep", details: {} } },
];
const st = unitToolStats(unitBranch as never);
check("单元工具计数", st.toolCalls, 3);
check("单元 todo 调用", st.todoCalls, 2);
check("单元创建过 todo", st.createdTodo, true);

const noTodoBranch = [
	{ type: "message", message: { role: "user", content: "做 Y" } },
	{
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", name: "ctx_read", arguments: "{}" },
				{ type: "toolCall", name: "ctx_read", arguments: "{}" },
				{ type: "toolCall", name: "ctx_read", arguments: "{}" },
			],
		},
	},
];
const st2 = unitToolStats(noTodoBranch as never);
check("无 todo 单元计数", st2.toolCalls, 3);
check("无 todo 单元 todoCalls", st2.todoCalls, 0);
check("无 todo 单元未创建", st2.createdTodo, false);
check("无 todo 单元未创建", st2.createdTodo, false);
check("无 user 空分支", unitToolStats([] as never).toolCalls, 0);

// ── normalizeEvidence ──
const n1 = normalizeEvidence('{"kind":"runnable","evidence":[{"type":"cmd","cmd":"npm test","exit":0}]}');
check("字符串 JSON 解析", n1.error, null);
check("字符串 JSON kind", n1.evidence?.kind, "runnable");
const n2 = normalizeEvidence({ evidence: [{ type: "cmd", cmd: "echo hi" }] });
check("缺 kind 推断 runnable", n2.evidence?.kind, "runnable");
const n3 = normalizeEvidence({ evidence: [{ path: "src/a.ts" }] });
check("条目缺 type 推断 file", n3.evidence?.evidence?.[0]?.type, "file");
check("条目缺 type 推断 kind", n3.evidence?.kind, "state");
const n4 = normalizeEvidence("npm test");
check("裸命令文本包 cmd", n4.evidence?.evidence?.[0]?.cmd, "npm test");
check("裸命令文本 kind", n4.evidence?.kind, "runnable");
const n5 = normalizeEvidence(null);
check("null 无法归一化", n5.error, "evidence 缺失或非对象");
const n6 = normalizeEvidence({ kind: "magic", evidence: [] });
check("非法 kind 仍拦截", n6.error, "kind 必须是 state|runnable|effect，实际: magic");
const n7 = normalizeEvidence({ evidence: "not-array" });
check("evidence 非数组拦截", n7.error, "evidence.evidence 必须是数组");
check("归一化后写回格式合法", validateEvidence(n2.evidence), null);

// ── validateParentRef ──
const treeTasks = [
	{ id: 1, subject: "目标", status: "completed" },
	{ id: 2, subject: "子1", status: "completed", metadata: { parentId: 1 } },
	{ id: 3, subject: "子2", status: "pending", metadata: { parentId: 1 } },
	{ id: 4, subject: "孤儿", status: "pending", metadata: { parentId: 99 } },
];
check("parentRef 根节点放行", validateParentRef(treeTasks, undefined), null);
check("parentRef 存在放行", validateParentRef(treeTasks, 1), null);
check("parentRef 不存在拦截", validateParentRef(treeTasks, 99), "parentId 引用的任务 #99 不存在");
check("parentRef 非数字拦截", validateParentRef(treeTasks, "1"), "parentId 必须是数字，实际: 1");

// ── canCompleteTree ──
check("无子节点放行", canCompleteTree(treeTasks, 4), null);
check("子全完成放行", canCompleteTree(
	[{ id: 1, subject: "父", status: "in_progress" }, { id: 2, subject: "子", status: "completed", metadata: { parentId: 1 } }],
	1,
), null);
check("子未完成拦截", canCompleteTree(
	[{ id: 5, subject: "父", status: "in_progress" }, { id: 6, subject: "子", status: "pending", metadata: { parentId: 5 } }],
	5,
), "子任务 #6 子 未完成，父任务不能宣告 completed");
check("deleted 子跳过", canCompleteTree(
	[{ id: 7, subject: "父", status: "in_progress" }, { id: 8, subject: "弃", status: "deleted", metadata: { parentId: 7 } }],
	7,
), null);

// ── unitToolStats hasLongWait ──
const waitBranch = [
	{ type: "message", message: { role: "user", content: "干活" } },
	{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "subagent", arguments: "{}" }] } },
	{ type: "message", message: { role: "toolResult", toolName: "subagent", details: {} } },
	{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "shell", arguments: '{"timeout": 120}' }] } },
];
const sw = unitToolStats(waitBranch as never);
check("subagent 触发长等待", sw.hasLongWait, true);
const waitBranch2 = [
	{ type: "message", message: { role: "user", content: "干活" } },
	{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "shell", arguments: '{"timeout": 10}' }] } },
];
check("短命令不触发长等待", unitToolStats(waitBranch2 as never).hasLongWait, false);

if (failed > 0) {
	console.error(`\n${failed} 断言失败`);
	process.exit(1);
}
console.log("\n全部通过");
