# Claude Code — BriefingIQ JMeter Runner

This file guides AI assistants (Claude Code, Cursor, etc.) working in this repository.

## What this project is

A **BriefingIQ data-population runner**, not a load-testing harness:

- **Backend**: Node.js (`server.js`, `jmx-parameters.js`) manages JMeter plans, parses JMX parameters, proxies BriefingIQ API dropdowns, runs JMeter non-GUI, serves logs/reports.
- **Frontend**: Angular 21 UI (`ui/`) to pick a plan, configure parameters, start runs, monitor progress.
- **Plans**: JMeter `.jmx` files in `plans/` (primary: `plans/BIQ.jmx`).

## Prerequisites (for local runs)

| Tool | Requirement |
|------|-------------|
| Node.js | 20.19+ or 22.12+ |
| npm | 10+ |
| Java | 8+ (11/17 recommended) |
| JMeter | 5.4+ with **jpgc-json** plugins |
| Network | HTTPS to BriefingIQ host; valid Bearer in plan/props |

```bash
npm run init   # first time
npm run dev    # API :5050 + UI :4200
```

Full docs: `README.md`.

## Repository map

```
plans/              # JMX test plans (edit here)
server.js           # HTTP API + run orchestration
jmx-parameters.js   # JMX parse, patch, field-options
ui/                 # Angular app
runs/               # gitignored — per-run logs, JTL, reports
scripts/init.js     # setup helper
```

**Do not edit** root `BIQ.jmx` or `EIQ.jmx` unless the user explicitly asks. Active work is under `plans/`.

## When the user reports a bad run

1. Find folder: `runs/<uuid>__<label>/` or `runs/<uuid>/`
2. Read `run.meta.json`, `jmeter.log`, `result.jtl`, `launcher.log`
3. Distinguish compile failures (never started) vs runtime/API failures
4. Fix root cause in `plans/*.jmx` or backend/UI as appropriate

## JMX conventions (`plans/*.jmx`)

### Parameter descriptions (`Argument.desc`)

- `REQUIRED`, `DATE,`, `BOOLEAN,` — type/required inference for UI
- `DROPDOWN, API` / `DROPDOWN, API, MULTI` — BriefingIQ API dropdowns
- `HIDE` — hidden in UI; still sent to JMeter
- `LABEL=camelCase` — friendly UI label

API endpoint mappings go in the **`API Field Variables`** Arguments group.

### IfController pitfalls

Use `${__groovy(props.get("fn_matchesJourneyType")(vars))}` with `useExpression=true`.

Do **not** put comma-separated arguments inside `${__groovy(...)}` — JMeter treats commas as argument separators and compile fails.

Use single-arg closures registered in common-functions JSR223 samplers.

### State action fields

- **`maxIterationCount`**: comma-separated iteration counts (e.g. `2,3,4`); one picked at random per run; iteration 1 is always SUBMIT; `0`/empty skips state actions.
- **`targetActions`**: comma-separated **include list** for random actions after SUBMIT — not a single target with early loop exit.

### Module routing

Journey / logistics / agenda / virtual-connection blocks use `fn_matches*Type(vars)` helpers, not bucket “handled” flags that skip subsequent modules of the same type.

## Backend conventions

- Plans directory: `PLANS_DIR` (default `./plans`)
- Run payload: `{ label, planFile, props }`
- Headers in props: `header__Authorization`, etc.
- Env: `BIQ_DEBUG_API_FIELDS=true` for field-option tracing; `BIQ_AUTHORIZATION` for Bearer override
- Restart Node after `jmx-parameters.js` changes

Adding a simple text/boolean/date JMX parameter requires **no** backend change if `Argument.desc` tags are correct.

## Frontend conventions

- Angular 21 standalone + signals + PrimeNG
- **Show hidden fields** toggle: reveals `HIDE` params and HTTP headers
- API dropdowns via `RunnerService.getFieldOptions()`
- Production API URL: `ui/src/environments/environment.prod.ts`

## Coding principles

1. **Minimal diffs** — fix the reported issue; avoid unrelated refactors.
2. **Match existing style** — naming, Groovy patterns in JMX, Angular patterns in `ui/`.
3. **No secrets in git** — tokens live in JMX or local env, not commits.
4. **No proactive commits/PRs** — only when the user asks.
5. **Tests** — add only when requested or for non-trivial backend logic.

## Common pitfalls (learned from this repo)

| Symptom | Likely cause |
|---------|----------------|
| Compile error `__groovy wrong number of parameters` | Commas inside `${__groovy(...)}` |
| Modules fetch config but no forms run | IfController condition false / wrong module-type match |
| Activity `self` actions in logs | Activity `_links` lack CONFIRM/HOLD/WAITLIST; fallback random action |
| SUBMIT then HOLD at end of run | Request state loop: iter 1 always SUBMIT by design |
| API dropdowns empty | Missing Bearer, unsatisfied `depends=`, or need `BIQ_DEBUG_API_FIELDS` |

## Related files

- `README.md` — setup, API reference, deployment
- `README.local-runner.md` — API quick reference
- `.cursor/rules/` — Cursor-specific rule files
