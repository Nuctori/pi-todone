# pi-todone

Todo completion duty gate + proof-point protocol. Minimal intervention against AI laziness in long autonomous tasks (early stop, idling, marking things done without doing them, skipping task breakdown).

- **Format gate**: marking a `todo` `completed` requires `metadata.evidence` (JSON). Non-conforming → **blocked**, the AI must supply proof before `done`. Consecutive blocks for the same task & reason (≥2) prepend a strong hint (stop retrying the same shape / escape hatch: set status back to `pending`) — prevents burning the tool budget on repeated identical violations
- **Proof-point protocol**: when the agent idles with pending todos → inject "prove this round's progress | explain the blocker | continue"; on prolonged stagnation → trigger re-examination (blocker report).
- **Creation duty**: complex units (≥200 tool calls) that never created any todo → inject "break down todos first" (with granularity rules); small tasks exempt.
- **Verification duty**: format-valid completions → inject "spawn a fresh reviewer subagent" for semantic verification by the subagent family of LLMs.
- **Hard gate (gate primitive)**: declare `metadata.gate` at create time (`{"test":true}` / `"audit"` / `["test","audit"]`); `test` → completion evidence must include a cmd entry with explicit `exit: 0`; `audit` → must include a review evidence entry (agent+path); otherwise → **blocked**. Declared is obliged — prevents "forgetting this node needs special proof" (stops forgetting/format errors, not lying — truthfulness is re-checked by the verification-duty fresh reviewer)
- **Settled ultimatum (⑦)**: when the agent settles with unfinished todos → push back one round with `triggerTurn` and demand: explain the blocker (which item, why, next step) and settle, or finish the remaining items. One notice is enough (anti-loop); reset on progress or user intervention

The plugin performs **deterministic format validation only** (zero LLM cost, never hallucinates). Semantic verification → independent subagents (collusion-resistant).

## Design Philosophy

### One tool, one job

pi-todone's semantic boundary is a single one: **the completion duty of todos**. Everything else around todos is deliberately left outside:

| Responsibility | Semantics | Where it lives |
| --- | --- | --- |
| Completion duty (evidence format, idle injection, stagnation detection) | mechanical, decidable | **this plugin** (hard gate) |
| Structure norms (result-oriented, explicit dependencies, re-plan on blockers) | semantic, undecidable | **pi-todone skill** (norm layer, AI follows voluntarily) |
| Goal understanding (what the user wants, what counts as done) | semantic, needs decision chain | **decision-audit layer** (e.g. pi-pair decision-auditor) |

Boundary principle: **what can be enforced goes into the tool; what cannot be enforced goes into the norm layer; semantic understanding stays with the AI and auditors.** Turning undecidable structure/goal rules into a "gate" is a fake gate — heuristics will misfire, and true judgment needs an LLM (which makes it an auditor, not a plugin).

### Burden of proof on the AI side

- The plugin **does not verify truthfulness, only format**: the AI must submit proof before `done`, and the proof content (path/cmd) is the AI's own responsibility.
- The format gate cannot stop "format-valid fake evidence" — semantic truth is checked by independent subagents (fresh-context isolation, against same-model collusion).
- **Lenient normalization**: models are weak at constructing nested JSON args; common deviations (single object, string, missing kind, bare command) are auto-fixed; only un-normalizable input is blocked. A teaching loop must not degrade into a trial-and-error loop.

### Cache safety

- The L1 persistent duty injection is a **compile-time constant**: stable bytes → system-prompt cache hits (cacheRead), ~0.1× cost per turn.
- Dynamic content (task ids, counts, timestamps) goes through the message channel (`sendUserMessage`) **only, never touching the system prompt** — any dynamic injection breaks the cache prefix.

### Small-task exemption

The completion duty applies only to todos that exist; the creation duty triggers only for complex tasks. This avoids both extremes: never using todos (data: flash used todos in only 8% of units) and noise (todos for every tiny task).

### Honest boundaries

- Todo state is AI self-reported — this plugin enforces the completion duty, not "work done outside todos" (that is claim-audit territory).
- The `effect` kind is an **honest exit**: blocking it is pointless (the model would fabricate a `state` proof instead); giving it a non-fabricating path is better.
- Stagnation detection is a *trigger*, not *teaching*: on stall the AI is asked to re-examine the todo structure; how to re-plan lives in the skill.

## Three-layer knowledge architecture (cache-safe)

| Layer | Channel | Content | Cache impact |
| --- | --- | --- | --- |
| L1 persistent | `before_agent_start` → `promptGuidelines` append of a **compile-time constant** | 2-line duty summary | ✅ static bytes → cache hit |
| L2 on-demand | `~/.agents/skills/pi-todone/SKILL.md` | full rules: granularity, evidence format, structure norms, verification flow | ✅ not loaded until triggered |
| L3 enforcement | block reason + agent_end injection (`sendUserMessage`) | teaches the format on violation | ✅ message channel, never touches system prompt |

## Install

```bash
pi install npm:pi-todone
```

## Proof format

When marking a todo `completed`, submit `metadata.evidence`:

```json
{ "kind": "state",    "evidence": [{"type": "file", "path": "src/a.ts", "op": "edit"}] }
{ "kind": "runnable", "evidence": [{"type": "cmd",  "cmd": "npm test", "exit": 0}] }
{ "kind": "effect",   "evidence": [] }
```

| kind | Meaning | Gate rule |
| --- | --- | --- |
| `state` | "file changed" | ≥1 file evidence (path required, op ∈ write/edit/delete) |
| `runnable` | "tests/build pass" | ≥1 cmd evidence (cmd required, exit optional number) |
| `effect` | subjective ("faster", "cleaner") | not blocked; left for human acceptance |
| review | cross-audit (for gate.audit) | agent+path required; attach alongside cmd/file evidence in state/runnable, or alone via effect (declaration only, human acceptance) |

Common deviations are auto-normalized: evidence as single object, string JSON, missing kind (inferred from entries), bare command text, entries missing `type`. Only un-normalizable input is blocked (reason carries the full format).

## Hard gate (gate primitive)

When a node needs a **hard proof duty** (tests must pass / cross-audit required), declare it at create time; the plugin checks mechanically on completion:

```json
{ "action": "create", "subject": "Implement X", "metadata": { "gate": {"test": true, "audit": true} } }
```

| gate | completion evidence requirement |
| --- | --- |
| `test` | ≥1 cmd evidence with explicit `exit: 0` (plain runnable only requires exit to be a number; gate tightens it) |
| `audit` | ≥1 `{"type":"review","agent":"<reviewer>","path":"<review artifact>"}` (alongside cmd/file in state/runnable, or alone via effect) |

- Not satisfied → **blocked** (stacked on the evidence format gate and tree integrity)
- When a gated node completes, the verification-duty injection **escalates to mandatory re-check** (names the gate duty); a fresh-context reviewer verifies the test/audit evidence truthfulness
- Gate is orthogonal to `blockedBy`: blockedBy governs order (dependency readiness), gate governs completion conditions (proof duty) — together they are the workflow inside todos
- Anti-forgery boundary: the gate is a mechanical check — it stops "forgot the evidence / format errors", not "lied about exit 0" — truthfulness is backed by the verification-duty independent review (the plugin never verifies truthfulness, see Design Philosophy)

## Settled ultimatum (⑦)

With unfinished todos the agent cannot just wrap up: at `agent_settled` (the final point where Pi stops auto-continuing), if any todo is still pending/in_progress → inject an ultimatum with `triggerTurn` to push back one round, choosing one of:

1. **Explain the blocker** (which item is stuck, why, next step) and settle — the legitimate exit; one explanation is honored
2. **Finish the remaining items** and settle afterwards

Anti-loop: one notice (`settledForced`) is enough; reset on progress (unfinished count change) or user intervention. Unlike ⑤ proof-point (soft in-round hint), ⑦ fires at the settle point and bypasses the "already injected this round" guard (the ultimatum applies even if turn_end hinted). ⑦ does not use the exponential backoff (the ultimatum is the last resort at the settle point, outside ⑤/⑥ scheduling); same-text dedup still applies (the same settle content is not pushed twice).

## Loop protection

- Stagnation detection: todo count unchanged for N rounds (default 3) → inject re-examination (**terminal notice**; then silent until user intervention or progress — no repeated nagging)
- Exponential backoff: injection interval 60s ×2ⁿ, capped at 10 min
- Same-text dedup: identical injections are not repeated
- Interaction silence: no injection within 2 minutes of the latest user message (never interrupt a live conversation)
- Idempotent injection: identical promptGuidelines line is not appended twice
- Block-storm suppression: consecutive identical blocks per task are counted; from the 2nd on, the reason is prefixed with `[#N same-call blocks]` + escape hatch (fix evidence & retry / set status back to `pending`); any non-blocked update resets the counter

## Configuration (env vars)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_TODONE_STALL_THRESHOLD` | 3 | rounds of no progress before re-examination trigger |
| `PI_TODONE_QUIET_AFTER_MS` | 120000 | silence window after latest user message |
| `PI_TODONE_CREATE_THRESHOLD` | 200 | tool calls in unit without any todo → creation-duty injection |
| `PI_TODONE_COOLDOWN_BASE_MS` | 60000 | backoff base 60s ×2ⁿ (10 min cap hard-coded) |

The verification-duty switch (SEMANTIC_CHECK) is hard-coded (edit source to change).

## Tests

```bash
npm test    # demo self-check (84 assertions) + mock E2E (34 scenarios, 103 assertions, no model needed)
```

CI (GitHub Actions): `test` job always runs; `real-e2e` job requires repo variable `RUN_REAL_E2E=true` + secret `PI_E2E_API_KEY`.

## Honest limitations

- The format gate cannot stop "format-valid fake evidence" — semantic truth relies on subagent verification; that is why the layers exist.
- The plugin cannot programmatically invoke subagent tools (pi extension API limit); the verification duty is injected for the main agent to spawn.
- Todo state is AI self-reported — this plugin enforces the completion duty, not work outside todos (claim-audit territory).
- The creation duty targets units that never created any todo; coarse-grained todo lists are corrected by the skill's granularity norms (the plugin does not judge semantics).
- Structure norms (result-oriented / dependencies / re-planning) live in the skill layer, not the plugin — see "One tool, one job".

## License

MIT
