/**
 * pi-todone 自检：validateEvidence 格式闸 + scanTodoSnapshot 快照扫描。
 * 运行：node --experimental-strip-types src/demo.ts （Node >= 22.6）
 * 非零退出码 = 有断言失败。
 */
import { validateEvidence, scanTodoSnapshot } from "./index.ts";

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

if (failed > 0) {
	console.error(`\n${failed} 断言失败`);
	process.exit(1);
}
console.log("\n全部通过");
