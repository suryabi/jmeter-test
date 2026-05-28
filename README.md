# BriefingIQ JMeter Runner

End-to-end local runner for `BIQ.jmx` with:

- Node.js API (`server.js`) to execute runs and expose artifacts
- Angular UI (`ui/`) to configure inputs, launch runs, monitor logs, inspect sample outcomes, and open JMeter HTML report

This tool is primarily used for **data population / workflow automation**, not classic load testing.

---

## 1) Architecture

### Components

- **JMeter Plan**: `BIQ.jmx`
- **Runner API**: `server.js` (default `http://localhost:5050`)
- **Web UI**: Angular app in `ui/` (default `http://localhost:4200`)
- **Run Artifacts**: stored under `runs/`

### High-level flow

1. UI calls `GET /parameters` to read parameter groups from `BIQ.jmx`
2. User starts a run via `POST /runs`
3. API creates run folder + run-specific JMX copy, starts JMeter non-GUI
4. UI streams logs via SSE and polls run status
5. API exposes artifacts:
   - `jmeter.log`
   - `result.jtl`
   - `html-report/` (JMeter dashboard)

---

## 2) Prerequisites

Install:

- **Node.js** (18+ recommended)
- **npm**
- **JMeter** (must be available as `jmeter` in PATH, or set `JMETER_BIN`)
- Required JMeter plugins for your plan (notably `jpgc-json` if your plan uses JSON plugin elements)

Confirm JMeter:

```bash
jmeter --version
```

---

## 3) Initial Setup

From repository root:

```bash
npm install
cd ui && npm install
```

Optional: configure UI API endpoint in:

`ui/src/environments/environment.ts`

```ts
export const environment = {
  production: false,
  runnerApiUrl: 'http://localhost:5050'
};
```

---

## 4) Run Locally (Development)

Start API (terminal 1):

```bash
cd /path/to/Jmeter
npm start
```

Start UI (terminal 2):

```bash
cd /path/to/Jmeter/ui
npm start
```

Open:

- UI: `http://localhost:4200`
- API health: `http://localhost:5050/health`

---

## 5) How to Use (UI)

1. Open **Create Run**
2. Set **Run Label**
3. Configure fields by group chip
4. Click **Start population run**
5. In **Run Detail**:
   - Follow live log
   - Track steps panel
   - Click `Passed` / `Failed` metrics for sample table
   - Open or embed HTML report
6. In **History**:
   - Open run details
   - Delete run artifacts to save space

Notes:

- `Passed/Failed` sample table comes from JTL (`/runs/:id/samples`)
- `Open report` uses static route `/runs/:id/report/`

---

## 6) API Reference

Base URL: `http://localhost:5050`

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Service status + endpoint list |
| `GET` | `/parameters` | Parsed parameter groups from `BIQ.jmx` |
| `POST` | `/runs` | Start run |
| `GET` | `/runs` | List runs (memory + hydrated from disk) |
| `GET` | `/runs/:id` | Run detail (summary, insights, log tail, artifacts) |
| `GET` | `/runs/:id/samples?status=passed\|failed&offset=0&limit=300` | JTL sample rows |
| `GET` | `/runs/:id/log?offset=0` | Incremental log polling |
| `GET` | `/runs/:id/log/stream` | SSE live logs |
| `GET` | `/runs/:id/log?download=1` | Download full JMeter log |
| `POST` | `/runs/:id/stop` | Stop active run |
| `DELETE` | `/runs/:id` | Delete run folder/artifacts |
| `GET` | `/runs/:id/report/` | JMeter HTML report (static) |

### Start run payload

```json
{
  "label": "nightly-smoke",
  "props": {
    "requestStartDate": "2026-12-10",
    "requestEndDate": "2026-12-10",
    "requestsPerDay": "1"
  }
}
```

---

## 7) Data & Artifact Layout

Each run folder under `runs/`:

- Newer format: `runs/<uuid>__<label-slug>/`
- Older format (still supported): `runs/<uuid>/`

Typical contents:

- `BIQ-run.jmx` (run-specific patched copy)
- `jmeter.log`
- `launcher.log`
- `result.jtl`
- `html-report/`
- `run.meta.json` (label + props + startedAt)

Run labels persist across restart via folder naming + `run.meta.json`.

---

## 8) Parameter Parsing Contract (Important)

The app parses **directly** from JMX `Arguments` elements by `testname`.

That means JMeter developers can add/rename groups and arguments in `BIQ.jmx` without backend code changes.

### What must remain true

- Parameters must be in standard JMeter `Arguments.arguments` entries (`Argument.name`, `Argument.value`, `Argument.desc`)
- JMeter save settings should include columns used by samples table:
  - `label`, `success`, `responseCode`, `responseMessage`, `failureMessage`, `URL`, `elapsed`, `timeStamp`

### Type inference currently

- Booleans and dates are inferred by parameter name lists in `jmx-parameters.js`
- Unknown parameters default to `text`

If JMeter adds new boolean/date variables, update inference sets or accept text input.

---

## 9) Environment Variables (API)

- `PORT` (default `5050`)
- `JMETER_BIN` (default `jmeter`)
- `JMETER_TEST_PLAN` (default `./BIQ.jmx`)
- `RUNS_DIR` (default `./runs`)
- `ALLOW_CONCURRENT_RUNS` (`true|false`, default `false`)
- `DEFAULT_LOG_TAIL_LINES` (default `100`)
- `MAX_LOG_CHUNK_BYTES` (default `262144`)
- `SSE_POLL_MS` (default `500`)

Example:

```bash
PORT=5051 JMETER_BIN=/opt/jmeter/bin/jmeter npm start
```

---

## 10) Build & Deploy

The application has two deployable artifacts:

- **API** — Node.js process that runs JMeter (`server.js`)
- **UI** — Angular static bundle (`ui/dist/biq-runner-ui/browser/`)

Both must be reachable for the app to work. The UI talks to the API over HTTP/SSE.

### 10.1 Pick a deployment topology

Choose one before deploying:

| Topology | UI URL | API URL | When to use |
|---|---|---|---|
| Same domain via reverse proxy (recommended) | `https://runner.yourcompany.com/` | `https://runner.yourcompany.com/api/` | Simpler CORS, single TLS cert, easiest auth gateway |
| Separate subdomain | `https://runner.yourcompany.com/` | `https://runner-api.yourcompany.com/` | When API and UI live on different hosts/teams |
| Containerized | UI container | API container | Cloud / Kubernetes / Docker Compose |

### 10.2 Configure UI environment for production

The UI uses Angular file replacements. Two files exist:

- `ui/src/environments/environment.ts` (dev — default)
- `ui/src/environments/environment.prod.ts` (production)

For production, **edit only `environment.prod.ts`**:

```ts
export const environment = {
  production: true,
  runnerApiUrl: 'https://runner.yourcompany.com/api'
};
```

Then build:

```bash
cd ui
npm install
npm run build      # uses environment.prod.ts automatically
```

Output: `ui/dist/biq-runner-ui/browser/` — serve this folder via nginx/CDN/static host.

### 10.3 Deploy the API

On the target server:

```bash
# 1. Install Node 18+, JMeter, required plugins
# 2. Copy the repo (excluding ui/node_modules and runs/)
# 3. Install API deps
npm install

# 4. Set environment variables (see Section 9)
export PORT=5050
export JMETER_BIN=/opt/jmeter/bin/jmeter
export JMETER_TEST_PLAN=/srv/biq/BIQ.jmx
export RUNS_DIR=/srv/biq/runs

# 5. Start with a process manager
#    pm2 example:
pm2 start server.js --name biq-runner-api
pm2 save
```

Health check from the server:

```bash
curl http://127.0.0.1:5050/health
```

### 10.4 Sample nginx config (same domain, recommended)

```nginx
server {
  listen 443 ssl http2;
  server_name runner.yourcompany.com;

  # TLS certs go here
  # ssl_certificate / ssl_certificate_key ...

  root /srv/biq/ui;
  index index.html;

  # Static UI files
  location / {
    try_files $uri $uri/ /index.html;
  }

  # API + SSE proxied under /api/
  location /api/ {
    proxy_pass http://127.0.0.1:5050/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;

    # Required for live log SSE streaming
    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_set_header Connection '';
  }
}
```

With this nginx setup, set:

```ts
runnerApiUrl: 'https://runner.yourcompany.com/api'
```

### 10.5 Sample nginx config (separate subdomain)

UI host:

```nginx
server {
  listen 443 ssl http2;
  server_name runner.yourcompany.com;
  root /srv/biq/ui;
  index index.html;
  location / { try_files $uri $uri/ /index.html; }
}
```

API host:

```nginx
server {
  listen 443 ssl http2;
  server_name runner-api.yourcompany.com;

  location / {
    proxy_pass http://127.0.0.1:5050/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_set_header Connection '';
  }
}
```

In this mode, the API must allow CORS from the UI origin (currently `*` for dev — restrict in production).

### 10.6 Containerized deployment (optional)

- Build an API image with: Node, JMeter, plugins, `BIQ.jmx`, `server.js`, `jmx-parameters.js`
- Build a UI image with: nginx serving `ui/dist/biq-runner-ui/browser/`
- Mount a persistent volume at `RUNS_DIR` so runs survive container restarts
- Use the same nginx routing patterns above between containers

---

## 11) Production Considerations

- **CORS**: currently open (`*`). Restrict to UI origin in production (edit `setCors` in `server.js`).
- **Auth**: app has no built-in auth. Put it behind SSO/reverse-proxy auth (OIDC, OAuth2 proxy, nginx basic auth, VPN, etc.).
- **TLS**: terminate TLS at nginx/load balancer.
- **Disk usage**: `runs/` grows over time. Set a retention/cleanup policy or use UI’s delete-run feature.
- **Secrets**: JMeter Bearer tokens / env config live in `BIQ.jmx` — manage that file carefully (treat like a secret).
- **Backups**: back up `runs/` if you need historical audit.
- **Concurrency**: `ALLOW_CONCURRENT_RUNS=false` by default — enable only if your JMeter host can handle parallel runs.

---

## 12) Troubleshooting

### API shows offline in UI

- Ensure API process is running on `PORT`
- Check `http://localhost:5050/health`
- Verify `ui/src/environments/environment.ts`

### JMeter run fails immediately

- Verify `JMETER_BIN`
- Verify plan path (`JMETER_TEST_PLAN`)
- Check plugin availability (`jpgc-json` etc.)
- Inspect `launcher.log` and `jmeter.log`

### No HTML report button

- Report exists only after run completion
- Check `runs/<id>/html-report/index.html`

### Passed/Failed table missing API/error details

- Ensure JTL contains `URL` and `failureMessage` columns

### Labels show unnamed for old runs

- Older run folders may predate `run.meta.json`
- New runs persist labels automatically

---

## 13) Common Commands

Start API:

```bash
npm start
```

Start UI:

```bash
cd ui && npm start
```

Build UI:

```bash
cd ui && npm run build
```

Health check:

```bash
curl http://localhost:5050/health
```

List runs:

```bash
curl http://localhost:5050/runs
```

Delete a run:

```bash
curl -X DELETE http://localhost:5050/runs/<run-id>
```

---

## 14) Team Workflows

### 14.1 UI developer workflow

Owns: `ui/` (Angular app).

**Local development**

```bash
cd ui
npm install        # first time
npm start          # http://localhost:4200, expects API on http://localhost:5050
```

**Files to edit**

- Components/pages: `ui/src/app/...`
- Styles: `ui/src/styles.scss` or per-component `.scss`
- Models: `ui/src/app/core/models/`
- Services (API calls): `ui/src/app/core/services/runner.service.ts`

**API URL config**

- Dev: `ui/src/environments/environment.ts` (already set to `http://localhost:5050`)
- Prod: `ui/src/environments/environment.prod.ts` (set this once, used by `npm run build`)

**Build for production**

```bash
cd ui
npm run build
# Output: ui/dist/biq-runner-ui/browser/   -> deploy as static files
```

**Release flow**

1. Open PR against the UI files
2. Reviewer runs `npm run build` to validate
3. Merge → CI builds + uploads `ui/dist/biq-runner-ui/browser/` to UI host (nginx/CDN)
4. No restart needed for the API

### 14.2 JMeter developer workflow

Owns: `BIQ.jmx` (and only `BIQ.jmx` in most cases).

**Where edits go**

- Add or update parameters under existing `Arguments` blocks (e.g. `Global Variables`, `Configuration Variables`, `Environment Variables`).
- Use standard JMeter `Argument.name`, `Argument.value`, `Argument.desc`.
- Group names (testname on `Arguments`) become section titles in UI automatically.
- Tokens / secrets in JMX: treat as sensitive — rotate before deploy.

**JTL columns required by UI**

Make sure JMeter saves at least:

- `label`, `success`, `responseCode`, `responseMessage`, `failureMessage`, `URL`, `elapsed`, `timeStamp`

If these are turned off, the Passed/Failed sample table will lose columns.

**Local smoke test before pushing**

1. Place updated `BIQ.jmx` at repo root (replacing the old one).
2. Start API: `npm start`
3. Open UI: `http://localhost:4200`
4. Verify:
   - All parameter groups + fields appear
   - Defaults look correct
   - Launch a run, watch logs
   - Passed/Failed table opens with API + error columns
   - HTML report opens
5. Commit `BIQ.jmx`, open PR.

**Release flow**

1. JMeter dev opens PR with only `BIQ.jmx` changed.
2. App owner merges → deploy script copies new `BIQ.jmx` to server location used by `JMETER_TEST_PLAN`.
3. **No API/UI code change required** — parameters are parsed dynamically.
4. Optional restart of API if you want to drop in-memory state. Disk runs are unaffected.

### 14.3 API / Ops workflow

Owns: `server.js`, `jmx-parameters.js`, infra.

- Deploy = restart Node process (`pm2 restart biq-runner-api`)
- Plan path: keep `BIQ.jmx` at a known location and point `JMETER_TEST_PLAN` to it
- Keep `RUNS_DIR` on persistent storage
- Monitor:
  - process up/down
  - disk usage of `RUNS_DIR`
  - JMeter binary presence (`JMETER_BIN`)

---

## 15) Current Limitations / Known Warnings

- Angular build budget warnings are currently present but non-blocking
- Sass `@import` deprecation warning exists in styles
- Request/response headers are not currently captured in sample table (requires JMeter save/config changes)

---

## 16) Related Docs

- Backend/API quick notes: `README.local-runner.md`
- UI notes: `ui/README.md`

