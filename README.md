# BriefingIQ JMeter Runner

End-to-end local runner for BriefingIQ JMeter test plans with:

- **Node.js API** (`server.js`, `jmx-parameters.js`) — plan management, parameter parsing, API-backed dropdowns, JMeter execution, artifacts
- **Angular UI** (`ui/`) — configure runs per plan, launch population workflows, monitor logs, inspect samples, open HTML reports, manage plans

This tool is primarily used for **data population / workflow automation**, not classic load testing.

---

## 1) Architecture

### Repository layout

| Path | Role |
|------|------|
| `plans/` | JMeter test plans (`.jmx`) used by the runner — **primary location for plan files** |
| `plans/BIQ.jmx` | Main BriefingIQ population plan (active development target) |
| `BIQ.jmx` | Legacy root copy; prefer `plans/BIQ.jmx` for new work |
| `server.js` | HTTP API, run lifecycle, static report hosting |
| `jmx-parameters.js` | JMX parsing, parameter patching, BriefingIQ API field-option proxy |
| `ui/` | Angular 21 SPA (PrimeNG + Tailwind) |
| `runs/` | Per-run artifacts (gitignored) |
| `scripts/init.js` | First-time dependency install + prerequisite checks |

### High-level flow

1. UI loads available plans via `GET /plans` and parameters via `GET /parameters?plan=<file>`
2. API-driven dropdown fields resolve options via `POST /field-options` (calls BriefingIQ using plan env + form props)
3. User starts a run via `POST /runs` with `planFile` + `props`
4. API patches a run-specific JMX copy, starts JMeter non-GUI, streams logs via SSE
5. UI shows JTL samples, parsed insights, and JMeter HTML dashboard

---

## 2) Prerequisites

Install and verify everything below **before** running `npm run init` or `npm run dev`.

### Required software

| Requirement | Version / notes |
|-------------|-----------------|
| **Node.js** | **20.19+** or **22.12+** (required by Angular 21 CLI). Node 18 is not supported for the UI build. |
| **npm** | **10+** (ships with Node 20/22) |
| **Java (JRE/JDK)** | **8+** minimum; **11 or 17** recommended for JMeter 5.4.x. The runner prefers Java from JMeter's own launcher (`jmeter.bat` / `setenv.bat`) over system `JAVA_HOME`. |
| **Apache JMeter** | **5.4+** (plans are saved for JMeter 5.4.1). Must be on `PATH` as `jmeter`, or set `JMETER_BIN`. |

### JMeter plugins

`plans/BIQ.jmx` uses elements from the **JMeter Plugins** ecosystem (jpgc-json). The repo vendors
these JARs under `vendor/jmeter-plugins/` so you can install them without the Plugins Manager UI:

```bash
npm run install:jmeter-plugins
```

This copies the plugin and its dependencies into your JMeter `lib/ext` and `lib` folders. `npm run init`
runs this automatically after dependency install.

Manual alternative: install via [Plugins Manager](https://jmeter-plugins.org/install/Install/) — search for **jpgc-json** (JSON Plugins).

If a run fails at compile time with unknown element classes under `com.atlantbh.jmeter.plugins...`, run `npm run install:jmeter-plugins` and retry.

### Network access

- The runner machine needs outbound HTTPS to your BriefingIQ host (`host` / `protocol` / `port` in the plan) when:
  - Executing JMeter runs
  - Resolving API dropdown options in the UI (`/field-options`)
- A valid **Bearer token** (and related headers) must be present in the plan or run props — typically `header__Authorization` and environment fields in the JMX.

### Quick verification

```bash
node --version    # expect v20.19+ or v22.12+
npm --version
java -version     # JMeter prerequisite
jmeter --version  # expect 5.4.x
```

If `jmeter` is not on PATH:

```bash
export JMETER_BIN=/path/to/apache-jmeter/bin/jmeter
```

### First-time project setup

From the repository root:

```bash
npm run init
```

This installs API + UI dependencies and runs the prerequisite checks above.

Validate only (no install):

```bash
npm run validate
```

Checks: Node 20.19+/22.12+, npm, Java (JMeter launcher vs JAVA_HOME vs PATH), JMeter (`JMETER_BIN` or PATH), jpgc-json plugins, `node_modules`, plans in `./plans`, writable `./runs`.

Install vendored JMeter plugins only:

```bash
npm run install:jmeter-plugins
```

Manual alternative:

```bash
npm install
cd ui && npm install
```

---

## 3) Run locally (development)

Start API and UI together (recommended):

```bash
npm run dev
```

| Service | URL |
|---------|-----|
| UI | http://localhost:4200 |
| API health | http://localhost:5050/health |

Stop both with `Ctrl+C`.

### Run API and UI separately

```bash
npm run start:api   # API only → http://localhost:5050
npm run start:ui    # UI only  → http://localhost:4200
```

### UI API endpoint (dev)

`ui/src/environments/environment.ts`:

```ts
export const environment = {
  production: false,
  runnerApiUrl: 'http://localhost:5050'
};
```

---

## 4) Using the UI

### Runs (home)

1. Open **Create Run**
2. Choose a **plan** (e.g. `BIQ.jmx`)
3. Set **Run label**
4. Configure parameters by group; API dropdowns load when dependencies are satisfied
5. Optional: enable **Show hidden fields** to reveal `HIDE` parameters and HTTP header fields
6. Click **Start population run**
7. Open the run from **History** for live logs, step insights, Passed/Failed samples, HTML report

### Plans

Use the **Plans** tab (`/plans`) to:

- List `.jmx` files in `plans/`
- Upload a new or replacement plan
- Download a plan
- Delete a plan (blocked while a run using it is active)

### Run detail

- **Live log** — SSE stream + poll fallback
- **Insights** — customer, request ID, dates, state actions, steps (parsed from `jmeter.log`)
- **Samples** — JTL rows with API URL and failure message
- **HTML report** — JMeter dashboard at `/runs/:id/report/`

---

## 5) Backend (API)

### Core modules

- **`server.js`** — HTTP server, run orchestration, plan CRUD, log/SSE, JTL parsing, HTML report static hosting
- **`jmx-parameters.js`** — Reads JMX `Arguments` / `HeaderManager` sections, infers field types, patches values for each run, proxies BriefingIQ APIs for dropdown options

### Plan resolution

- Plans live in `plans/` (`PLANS_DIR`, default `./plans`)
- `GET /parameters?plan=BIQ.jmx` and `POST /runs` accept `planFile`
- Legacy `JMETER_TEST_PLAN` env var still works as a single-plan fallback when `planFile` is omitted

### Run lifecycle

Each run creates `runs/<uuid>__<label-slug>/` containing:

- `BIQ-run.jmx` — patched copy for that run
- `jmeter.log`, `launcher.log`, `result.jtl`, `html-report/`
- `run.meta.json` — label, `planFile`, props, `startedAt`

---

## 6) API reference

Base URL: `http://localhost:5050`

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Service status + endpoint list |
| `GET` | `/plans` | List plans in `plans/` |
| `POST` | `/plans?filename=<name.jmx>` | Upload plan (raw `.jmx` body) |
| `GET` | `/plans/:filename/download` | Download plan file |
| `DELETE` | `/plans/:filename` | Delete plan |
| `GET` | `/parameters?plan=<file>` | Parsed parameter groups for a plan |
| `POST` | `/field-options` | Resolve API dropdown/multiselect options |
| `POST` | `/runs` | Start run |
| `GET` | `/runs` | List runs (memory + disk) |
| `GET` | `/runs/:id` | Run detail, log tail, insights, summary |
| `GET` | `/runs/:id/samples?status=passed\|failed` | JTL sample rows |
| `GET` | `/runs/:id/log?offset=0` | Incremental log poll |
| `GET` | `/runs/:id/log/stream` | SSE live logs |
| `GET` | `/runs/:id/log?download=1` | Download full log |
| `POST` | `/runs/:id/stop` | Stop active run |
| `DELETE` | `/runs/:id` | Delete run folder |
| `GET` | `/runs/:id/report/` | JMeter HTML report |

### Start run payload

```json
{
  "label": "sample-run",
  "planFile": "BIQ.jmx",
  "props": {
    "requestStartDate": "2026-12-10",
    "requestEndDate": "2026-12-10",
    "requestsPerDay": "1",
    "targetActions": "CONFIRM,HOLD,WAITLIST",
    "maxIterationCount": "2,3,4"
  }
}
```

`props` keys match JMX `Argument.name` values and `header__<Header-Name>` for HTTP headers.

### Field options payload

```json
{
  "planFile": "BIQ.jmx",
  "field": "parentCategory",
  "props": {
    "protocol": "https",
    "host": "briefings.briefingiq.com",
    "port": "443",
    "contextname": "events",
    "categoryType": "CATEGORY_TYPE_BRIEFINGS",
    "header__Authorization": "Bearer …"
  }
}
```

---

## 7) Frontend (UI)

### Stack

- **Angular 21** (standalone components, signals)
- **PrimeNG 21** + **PrimeIcons**
- **Tailwind CSS 4**

### Key areas

| Path | Purpose |
|------|---------|
| `ui/src/app/pages/runs-page/` | Home — create run + history |
| `ui/src/app/pages/plans-page/` | Plan upload / download / delete |
| `ui/src/app/pages/run-detail-page/` | Live run monitoring |
| `ui/src/app/components/start-run-form/` | Plan picker, parameter form, hidden-field toggle |
| `ui/src/app/components/run-parameters-panel/` | Reusable parameter editor with API option loading |
| `ui/src/app/core/services/runner.service.ts` | API client |
| `ui/src/app/core/models/runner.models.ts` | Shared types |

### Form behaviour

- Parameters are grouped by JMX `Arguments` `testname` (e.g. Scheduling Variables, Customer Variables)
- **Hidden fields** (`HIDE` in `Argument.desc`) and **HTTP headers** are hidden by default; toggle **Show hidden fields** to edit them
- Empty parameter groups are omitted from the form
- **Dropdown / multiselect** fields marked `DROPDOWN, API` in the JMX load options from BriefingIQ via the API
- Dependent dropdowns re-fetch when parent fields change (`depends=` in API Field Variables mapping)

### Production build

```bash
cd ui
npm run build
# Output: ui/dist/biq-runner-ui/browser/
```

Set `ui/src/environments/environment.prod.ts` → `runnerApiUrl` before building.

---

## 8) JMX parameter contract

Parameters are parsed from JMX — no backend code change needed when adding fields to existing `Arguments` groups.

### `Argument.desc` tags

| Tag / pattern | Effect |
|---------------|--------|
| `REQUIRED` | Required in UI validation |
| `DATE,` / `DATE.` | Date input |
| `BOOLEAN,` / `BOOLEAN.` | Checkbox |
| `DROPDOWN, API` | API-backed dropdown |
| `DROPDOWN, API, MULTI` | API-backed multiselect |
| `HIDE` | Hidden from UI by default (value still sent to JMeter) |
| `LABEL=camelCase` | UI display label (e.g. `LABEL=requestType`) |

### API Field Variables group

Dropdown API wiring lives in the **`API Field Variables`** `Arguments` block:

```
items=_embedded.categories display=name value=uniqueId depends=categoryType header.x-cloud-customerid=field:customerId
```

The runner substitutes `${contextname}`, `${fieldName}`, etc., and forwards request headers to BriefingIQ.

### HTTP headers

Headers from the plan's pre-thread-group `HeaderManager` appear as `header__<Name>` parameters (e.g. `header__Authorization`).

### JTL columns required by UI

Ensure JMeter saves: `label`, `success`, `responseCode`, `responseMessage`, `failureMessage`, `URL`, `elapsed`, `timeStamp`.

---

## 9) Environment variables (API)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `5050` | API listen port |
| `JMETER_BIN` | `jmeter` | JMeter executable |
| `PLANS_DIR` | `./plans` | Directory containing `.jmx` plans |
| `JMETER_TEST_PLAN` | — | Legacy single-plan path override |
| `RUNS_DIR` | `./runs` | Run artifacts directory |
| `ALLOW_CONCURRENT_RUNS` | `false` | Allow overlapping JMeter processes |
| `DEFAULT_LOG_TAIL_LINES` | `100` | Default log tail in run detail |
| `MAX_LOG_CHUNK_BYTES` | `262144` | Max log chunk per poll |
| `SSE_POLL_MS` | `500` | SSE log poll interval |
| `BIQ_AUTHORIZATION` | — | Optional Bearer override for `/field-options` calls |
| `BIQ_DEBUG_API_FIELDS` | `false` | Verbose logging for API field-option resolution |

Example:

```bash
PORT=5051 \
JMETER_BIN=/opt/jmeter/bin/jmeter \
PLANS_DIR=/srv/biq/plans \
BIQ_DEBUG_API_FIELDS=true \
npm start
```

---

## 10) Build & deploy

Two deployable artifacts:

- **API** — Node process (`server.js`) + `plans/` + JMeter on the same host
- **UI** — static files from `ui/dist/biq-runner-ui/browser/`

Both must be reachable; the UI calls the API over HTTP/SSE.

### Same-domain reverse proxy (recommended)

Proxy `/api/` → `http://127.0.0.1:5050/` with `proxy_buffering off` for SSE.

Set production UI:

```ts
runnerApiUrl: 'https://runner.yourcompany.com/api'
```

### API deployment checklist

1. Node **20.19+** or **22.12+**, Java, JMeter 5.4+ with **jpgc-json** plugins
2. Copy repo (exclude `ui/node_modules`, `runs/`)
3. `npm install` at root
4. Place plans in `PLANS_DIR`
5. Set env vars (Section 9)
6. Process manager, e.g. `pm2 start server.js --name biq-runner-api`
7. Mount persistent volume at `RUNS_DIR`

### Sample nginx (UI + API)

```nginx
server {
  listen 443 ssl http2;
  server_name runner.yourcompany.com;
  root /srv/biq/ui;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }

  location /api/ {
    proxy_pass http://127.0.0.1:5050/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_set_header Connection '';
  }
}
```

---

## 11) Production considerations

- **CORS** — open in dev (`*`); restrict to UI origin in production (`setCors` in `server.js`)
- **Auth** — no built-in auth; protect with SSO, VPN, or reverse-proxy auth
- **Secrets** — Bearer tokens in JMX / run props; use `BIQ_AUTHORIZATION` only on trusted servers
- **Disk** — `runs/` grows; delete old runs from UI or automate cleanup
- **Concurrency** — keep `ALLOW_CONCURRENT_RUNS=false` unless the host can run parallel JMeter processes

---

## 12) Troubleshooting

### API offline in UI

- Check `http://localhost:5050/health`
- Verify `ui/src/environments/environment.ts` → `runnerApiUrl`

### JMeter fails immediately

- Verify `JMETER_BIN` and `jmeter --version`
- **Windows:** set `JMETER_BIN` to the full path of `bin\jmeter.bat` (not bare `jmeter` unless it is on PATH). The API runs batch files via `shell: true` automatically when needed.
- Install vendored plugins: `npm run install:jmeter-plugins`
- Open the failed run in the UI — the red **Run failed** banner shows `launcher.log` output
- Inspect `runs/<id>/launcher.log` and `jmeter.log`

### API dropdowns empty or 401

- Ensure `header__Authorization` (or `BIQ_AUTHORIZATION`) is valid
- Fill parent fields listed in `depends=` first
- Run API with `BIQ_DEBUG_API_FIELDS=true` for upstream request logging

### Module forms skipped / no data populated

- Check `jmeter.log` for IfController / compile errors
- Confirm plan file is the updated `plans/BIQ.jmx`

### No HTML report button

- Report appears only after run completion
- Check `runs/<id>/html-report/index.html`

---

## 13) Common commands

```bash
npm run init              # first-time setup
npm run validate          # check prerequisites only
npm run install:jmeter-plugins  # copy vendored jpgc-json into JMeter
npm run dev               # API + UI (dev)
npm start                 # API only
cd ui && npm start        # UI only
cd ui && npm run build    # production UI build

curl http://localhost:5050/health
curl http://localhost:5050/plans
curl "http://localhost:5050/parameters?plan=BIQ.jmx"
curl http://localhost:5050/runs
curl -X DELETE http://localhost:5050/runs/<run-id>
```

---

## 14) Team workflows

### UI developer

- Owns `ui/`
- Local: `npm run dev`
- Production: `npm run build` → deploy `ui/dist/biq-runner-ui/browser/`
- Edit `environment.prod.ts` for API URL

### JMeter developer

- Owns `plans/*.jmx` — **primary: `plans/BIQ.jmx`**
- Add parameters under existing `Arguments` groups with `Argument.name`, `Argument.value`, `Argument.desc`
- Use `LABEL=`, `HIDE`, `DROPDOWN, API` tags as needed
- API dropdown mappings go in **API Field Variables**
- Smoke test: upload or replace plan → refresh UI → launch run → verify logs + samples

No API/UI code change is required for new plain text/boolean/date parameters.

### API / ops

- Owns `server.js`, `jmx-parameters.js`, infrastructure
- Deploy = restart Node; keep `plans/` and `RUNS_DIR` on persistent storage
- Monitor disk usage under `runs/`

---

## 15) Known limitations

- Angular build may emit non-blocking budget / Sass deprecation warnings
- Request/response headers are not shown in the samples table (JTL limitation)
- Activity-level state actions in the agenda flow use the same `targetActions` list as request state actions but only actions present in each activity's `_links` are executable

---

## 16) Related docs

- API quick reference: `README.local-runner.md`
- UI notes: `ui/README.md`
