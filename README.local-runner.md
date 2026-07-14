# Local JMeter Runner — API quick reference

This is the quick reference for the Node API only. For setup, deployment, and team workflow docs see the repo root `README.md`.

## Start

```bash
npm start
```

Server starts on `http://localhost:5050` (override with `PORT`).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service health + endpoint list |
| `GET` | `/plans` | List `.jmx` plans in `plans/` |
| `POST` | `/plans?filename=<name.jmx>` | Upload plan (raw body) |
| `GET` | `/plans/:filename/download` | Download plan |
| `DELETE` | `/plans/:filename` | Delete plan |
| `GET` | `/parameters?plan=<file>` | JMX parameter schema for a plan |
| `POST` | `/field-options` | Resolve API dropdown options |
| `POST` | `/runs` | Start a run |
| `GET` | `/runs` | List runs (includes past runs on disk) |
| `GET` | `/runs/:id` | Run detail + log tail + insights + JTL summary |
| `GET` | `/runs/:id/samples?status=passed\|failed&offset=0&limit=300` | Per-sample rows from JTL |
| `GET` | `/runs/:id/log?offset=0` | Poll new log lines (JSON) |
| `GET` | `/runs/:id/log/stream` | Live log stream (SSE) |
| `GET` | `/runs/:id/log?download=1` | Full log download (plain text) |
| `POST` | `/runs/:id/stop` | Stop running process |
| `DELETE` | `/runs/:id` | Delete run folder (logs, JTL, HTML report) |
| `GET` | `/runs/:id/report/` | JMeter HTML dashboard (static assets under `html-report/`) |

## Start a run

```bash
curl -X POST http://localhost:5050/runs \
  -H "Content-Type: application/json" \
  -d '{
    "label": "quick-local-test",
    "planFile": "BIQ.jmx",
    "source": "terraform",
    "props": {
      "requestStartDate": "2026-12-10",
      "requestEndDate": "2026-12-10",
      "requestsPerDay": "1"
    }
  }'
```

`props` may include any JMX user-defined variable or `header__*` override. The runner writes a per-run copy at `runs/<id>/BIQ-run.jmx` with your values applied before starting JMeter.

Optional `source` is a free-form caller tag (max 128 chars) stored on the run and returned in list/detail responses — use it to mark launches from another UI (e.g. `"terraform"`). Omit it for console runs.

Fetch defaults and field descriptions:

```bash
curl "http://localhost:5050/parameters?plan=BIQ.jmx"
```

## Run detail

```bash
curl "http://localhost:5050/runs/<run-id>?logTail=150"
```

Response includes:

- `status`, timing, `props`
- `logTail` — last N lines (jmeter + launcher)
- `insights` — parsed customer, requestId, dates, state actions, steps
- `summary` — JTL sample counts (`samples`, `success`, `failed`)
- `artifacts` — paths to log, JTL, HTML report (`htmlReportUrl` for the dashboard)

## Poll logs (incremental)

```bash
curl "http://localhost:5050/runs/<run-id>/log?offset=0"
curl "http://localhost:5050/runs/<run-id>/log?offset=<nextOffset>"
```

Response:

```json
{
  "runId": "...",
  "status": "running",
  "offset": 0,
  "nextOffset": 4096,
  "fileSize": 12000,
  "complete": false,
  "lines": ["...", "..."]
}
```

## Live log stream (SSE)

```bash
curl -N "http://localhost:5050/runs/<run-id>/log/stream"
```

Events:

- `event: status` — run status
- `event: log` — `{ source, line }` per log line
- `event: complete` — final status + insights + JTL summary

Angular example:

```typescript
const es = new EventSource(`${environment.runnerApiUrl}/runs/${runId}/log/stream`);
es.addEventListener('log', (e) => {
  const { line } = JSON.parse(e.data);
  console.log(line);
});
es.addEventListener('complete', (e) => {
  const payload = JSON.parse(e.data);
  console.log('done', payload);
  es.close();
});
```

## Environment variables

- `PORT` (default `5050`)
- `JMETER_BIN` (default `jmeter`)
- `PLANS_DIR` (default `./plans`)
- `JMETER_TEST_PLAN` (optional legacy single-plan override)
- `RUNS_DIR` (default `./runs`)
- `ALLOW_CONCURRENT_RUNS` (`true|false`, default `false`)
- `DEFAULT_LOG_TAIL_LINES` (default `100`)
- `MAX_LOG_CHUNK_BYTES` (default `262144`)
- `SSE_POLL_MS` (default `500`)
- `BIQ_AUTHORIZATION` (optional Bearer for `/field-options`)
- `BIQ_DEBUG_API_FIELDS` (`true|false`, verbose field-option logging)

## Notes

- CORS is `*` for local dev. Restrict in production.
- Runs are re-loaded from `runs/<id>/` or `runs/<id>__<slug>/` after server restart.
- Each run folder includes `run.meta.json` with the display label and parameter props.
- For full deployment instructions (nginx, env, UI build, team workflows), see the repo root `README.md`.
