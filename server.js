const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const {
  parseJmxParameters,
  applyParameterOverrides,
  fetchApiFieldOptions
} = require("./jmx-parameters");

const PORT = Number(process.env.PORT || 5050);
const JMETER_BIN = process.env.JMETER_BIN || "jmeter";
const PLANS_DIR = process.env.PLANS_DIR || path.join(__dirname, "plans");
// Legacy single-plan fallback for JMETER_TEST_PLAN env var.
const LEGACY_PLAN_PATH = process.env.JMETER_TEST_PLAN || null;
const RUNS_DIR = process.env.RUNS_DIR || path.join(__dirname, "runs");
const ALLOW_CONCURRENT_RUNS = process.env.ALLOW_CONCURRENT_RUNS === "true";
const DEFAULT_LOG_TAIL_LINES = Number(process.env.DEFAULT_LOG_TAIL_LINES || 100);
const MAX_LOG_CHUNK_BYTES = Number(process.env.MAX_LOG_CHUNK_BYTES || 256 * 1024);
const SSE_POLL_MS = Number(process.env.SSE_POLL_MS || 500);

// Ensure runtime directories exist.
if (!fs.existsSync(RUNS_DIR)) {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}
if (!fs.existsSync(PLANS_DIR)) {
  fs.mkdirSync(PLANS_DIR, { recursive: true });
}

// ----------------------------
// Plans helpers
// ----------------------------

const MAX_PLAN_UPLOAD_BYTES = 25 * 1024 * 1024;

function listPlans() {
  if (!fs.existsSync(PLANS_DIR)) return [];
  return fs
    .readdirSync(PLANS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".jmx"))
    .sort();
}

function getPlanMeta(file) {
  const planPath = path.join(PLANS_DIR, file);
  const stat = fs.statSync(planPath);
  return {
    file,
    name: file.replace(/\.jmx$/i, ""),
    sizeBytes: stat.size,
    updatedAt: stat.mtime.toISOString()
  };
}

function listPlanDetails() {
  return listPlans().map((file) => getPlanMeta(file));
}

function sanitizePlanFilename(name) {
  const base = path.basename(String(name || "").trim());
  if (!base || base === "." || base === "..") {
    throw new Error("Invalid plan filename.");
  }
  if (base.includes("/") || base.includes("\\")) {
    throw new Error("Invalid plan filename.");
  }
  return base.toLowerCase().endsWith(".jmx") ? base : `${base}.jmx`;
}

function planIsInUse(planFile) {
  return Array.from(runs.values()).some(
    (run) => run.status === "running" && run.planFile === planFile
  );
}

function resolvePlanPath(planFile) {
  // If a legacy env override is set and no planFile is specified, honour it.
  if (!planFile && LEGACY_PLAN_PATH) return LEGACY_PLAN_PATH;

  const file = planFile || (listPlans()[0] ?? null);
  if (!file) throw new Error("No JMX plans found in the plans/ directory.");

  // Reject path traversal.
  if (file.includes("/") || file.includes("\\")) {
    throw new Error("Invalid plan name.");
  }

  const resolved = path.join(PLANS_DIR, file);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Plan not found: ${file}`);
  }
  return resolved;
}

const RUN_META_FILE = "run.meta.json";
const RUN_DIR_UUID_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:__(.+))?$/i;

// In-memory run index. Hydrated from disk on-demand.
const runs = new Map();

// ----------------------------
// Run directory + metadata helpers
// ----------------------------

function slugifyLabel(label) {
  if (!label || !String(label).trim()) return "";
  return String(label)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function runDirNameFor(id, label) {
  const slug = slugifyLabel(label);
  return slug ? `${id}__${slug}` : id;
}

function parseRunDirName(dirName) {
  const match = dirName.match(RUN_DIR_UUID_RE);
  if (!match) {
    return { id: dirName, slug: "", label: "" };
  }
  const slug = match[2] || "";
  return {
    id: match[1],
    slug,
    label: slug ? labelFromSlug(slug) : ""
  };
}

function labelFromSlug(slug) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function findRunDir(id) {
  const exact = path.join(RUNS_DIR, id);
  if (fs.existsSync(exact) && fs.statSync(exact).isDirectory()) {
    return exact;
  }

  const prefix = `${id}__`;
  if (!fs.existsSync(RUNS_DIR)) return null;

  for (const name of fs.readdirSync(RUNS_DIR)) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(RUNS_DIR, name);
    if (fs.statSync(full).isDirectory()) return full;
  }

  return null;
}

function readRunMeta(runDir) {
  const metaPath = path.join(runDir, RUN_META_FILE);
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

function writeRunMeta(runDir, meta) {
  fs.writeFileSync(
    path.join(runDir, RUN_META_FILE),
    JSON.stringify(meta, null, 2),
    "utf-8"
  );
}

// ----------------------------
// HTTP helpers
// ----------------------------

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, body) {
  setCors(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function readBodyBuffer(req, maxBytes = MAX_PLAN_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendPlanDownload(res, planPath, fileName) {
  setCors(res);
  res.writeHead(200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Content-Disposition": `attachment; filename="${fileName}"`
  });
  res.end(fs.readFileSync(planPath));
}

async function handlePlanUpload(req, url, res) {
  let fileName;
  try {
    fileName = sanitizePlanFilename(url.searchParams.get("filename") || "");
  } catch (err) {
    return sendJson(res, 400, { error: err.message || "Invalid plan filename" });
  }

  let buffer;
  try {
    buffer = await readBodyBuffer(req);
  } catch (err) {
    return sendJson(res, 413, { error: err.message || "Upload too large" });
  }

  if (!buffer.length) {
    return sendJson(res, 400, { error: "Empty file" });
  }

  const dest = path.join(PLANS_DIR, fileName);
  const existed = fs.existsSync(dest);
  fs.writeFileSync(dest, buffer);

  return sendJson(res, existed ? 200 : 201, {
    plan: getPlanMeta(fileName),
    replaced: existed
  });
}

function handlePlanDelete(planFile, res) {
  let fileName;
  try {
    fileName = sanitizePlanFilename(planFile);
  } catch (err) {
    return sendJson(res, 400, { error: err.message || "Invalid plan filename" });
  }

  if (planIsInUse(fileName)) {
    return sendJson(res, 409, {
      error: `Plan "${fileName}" is used by a running test and cannot be deleted.`
    });
  }

  const planPath = path.join(PLANS_DIR, fileName);
  if (!fs.existsSync(planPath)) {
    return sendJson(res, 404, { error: `Plan not found: ${fileName}` });
  }

  fs.unlinkSync(planPath);
  return sendJson(res, 200, { deleted: true, file: fileName });
}

// ----------------------------
// File/log utilities
// ----------------------------

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function tailFromOffset(filePath, fromByte) {
  if (!fs.existsSync(filePath)) {
    return { chunk: "", nextOffset: fromByte, size: 0 };
  }
  const size = fileSize(filePath);
  const start = Math.min(Math.max(0, fromByte), size);
  if (start >= size) {
    return { chunk: "", nextOffset: size, size };
  }
  const toRead = Math.min(size - start, MAX_LOG_CHUNK_BYTES);
  const buffer = Buffer.alloc(toRead);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, toRead, start);
  } finally {
    fs.closeSync(fd);
  }
  return { chunk: buffer.toString("utf-8"), nextOffset: start + toRead, size };
}

function lastLines(text, maxLines) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-maxLines);
}

function readCombinedLogTail(run, maxLines) {
  const runDir = path.dirname(run.logFile);
  const launcherLog = path.join(runDir, "launcher.log");
  const parts = [];
  if (fs.existsSync(launcherLog)) {
    parts.push(fs.readFileSync(launcherLog, "utf-8"));
  }
  if (fs.existsSync(run.logFile)) {
    parts.push(fs.readFileSync(run.logFile, "utf-8"));
  }
  return lastLines(parts.join("\n"), maxLines);
}

// ----------------------------
// JTL parsing
// ----------------------------

function getContextNameFromRun(run) {
  const props = run?.props || {};
  const name = String(props.contextname || props.contextName || "").trim();
  return name || null;
}

/** Label/dummy HTTP samplers hit only /{contextName}/api with no resource path. */
function isDummyLabelApiUrl(url, contextName) {
  if (!url || url === "null") return false;
  try {
    const pathname = new URL(url).pathname.replace(/\/+$/, "") || "/";
    if (contextName) {
      return pathname.toLowerCase() === `/${String(contextName).trim().toLowerCase()}/api`;
    }
    return /^\/[^/]+\/api$/i.test(pathname);
  } catch {
    return false;
  }
}

function parseJtlSummary(jtlFile, contextName = null) {
  if (!fs.existsSync(jtlFile)) return null;
  try {
    const raw = fs.readFileSync(jtlFile, "utf-8");
    const lines = raw.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return { samples: 0, success: 0, failed: 0 };
    const header = splitCsvLine(lines[0]);
    const successIdx = header.indexOf("success");
    const urlIdx = header.indexOf("URL");
    let success = 0;
    let failed = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = splitCsvLine(lines[i]);
      const apiUrl = urlIdx >= 0 ? cols[urlIdx] || "" : "";
      if (isDummyLabelApiUrl(apiUrl, contextName)) continue;
      const ok = successIdx >= 0 && cols[successIdx]?.toLowerCase() === "true";
      if (ok) success++;
      else failed++;
    }
    return { samples: success + failed, success, failed };
  } catch {
    return null;
  }
}

// Minimal CSV parser for JTL lines, including quoted values.
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// Returns filtered sample rows used by the Passed/Failed drill-down table.
function parseJtlSamples(jtlFile, { status = "all", offset = 0, limit = 200, contextName = null } = {}) {
  if (!fs.existsSync(jtlFile)) {
    return { total: 0, offset, limit, rows: [] };
  }

  const normalizedStatus =
    status === "passed" || status === "success"
      ? "passed"
      : status === "failed"
        ? "failed"
        : "all";
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));

  try {
    const raw = fs.readFileSync(jtlFile, "utf-8");
    const lines = raw.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) {
      return { total: 0, offset: safeOffset, limit: safeLimit, rows: [] };
    }

    const header = splitCsvLine(lines[0]);
    const idx = {
      timeStamp: header.indexOf("timeStamp"),
      elapsed: header.indexOf("elapsed"),
      label: header.indexOf("label"),
      responseCode: header.indexOf("responseCode"),
      responseMessage: header.indexOf("responseMessage"),
      failureMessage: header.indexOf("failureMessage"),
      success: header.indexOf("success"),
      threadName: header.indexOf("threadName"),
      url: header.indexOf("URL")
    };

    const filtered = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = splitCsvLine(lines[i]);
      const apiUrl = idx.url >= 0 ? cols[idx.url] || "" : "";
      if (isDummyLabelApiUrl(apiUrl, contextName)) continue;

      const ok = idx.success >= 0 && String(cols[idx.success] || "").toLowerCase() === "true";
      const rowStatus = ok ? "passed" : "failed";
      if (normalizedStatus !== "all" && rowStatus !== normalizedStatus) continue;

      filtered.push({
        status: rowStatus,
        timeStamp: idx.timeStamp >= 0 ? Number(cols[idx.timeStamp]) || null : null,
        elapsed: idx.elapsed >= 0 ? Number(cols[idx.elapsed]) || null : null,
        label: idx.label >= 0 ? cols[idx.label] || "" : "",
        apiUrl,
        responseCode: idx.responseCode >= 0 ? cols[idx.responseCode] || "" : "",
        responseMessage: idx.responseMessage >= 0 ? cols[idx.responseMessage] || "" : "",
        failureMessage: idx.failureMessage >= 0 ? cols[idx.failureMessage] || "" : "",
        threadName: idx.threadName >= 0 ? cols[idx.threadName] || "" : ""
      });
    }

    return {
      total: filtered.length,
      offset: safeOffset,
      limit: safeLimit,
      rows: filtered.slice(safeOffset, safeOffset + safeLimit)
    };
  } catch {
    return { total: 0, offset: safeOffset, limit: safeLimit, rows: [] };
  }
}

// ----------------------------
// Log insight extraction (business-level events from raw logs)
// ----------------------------

const INSIGHTS_UUID =
  "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}";

function parseJmeterLogTimestamp(line) {
  const m = String(line).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}),(\d{3})/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}.${m[3]}`);
  return Number.isFinite(ms) ? ms : null;
}

function createRequestInsight(index, total, atMs) {
  return {
    index,
    total,
    customerName: null,
    requestId: null,
    eventDate: null,
    startTime: null,
    endTime: null,
    durationDays: null,
    durationMinutes: null,
    status: "started",
    stateActions: [],
    at: atMs != null ? new Date(atMs).toISOString() : null
  };
}

function setRequestInsightId(request, value) {
  const id = String(value || "").trim();
  if (!id || id === "unknown" || id === "default") return;
  if (!request.requestId) request.requestId = id;
}

function finalizeRequestInsight(request, insights) {
  if (!request) return;
  insights.requests.push(request);
}

function applyLegacyInsightSummary(insights) {
  const { requests } = insights;
  const created = requests.filter((r) => r.status === "created");
  const skipped = requests.filter((r) => r.status === "skipped");
  const failed = requests.filter((r) => r.status === "failed");

  insights.requestSummary = {
    planned: requests[0]?.total ?? requests.length,
    created: created.length,
    skipped: skipped.length,
    failed: failed.length
  };

  const primary = created[created.length - 1] || created[0] || requests[requests.length - 1];
  if (primary) {
    insights.requestId = primary.requestId;
    insights.eventDate = primary.eventDate;
    insights.startTime = primary.startTime;
    insights.endTime = primary.endTime;
    insights.durationDays = primary.durationDays;
    insights.durationMinutes = primary.durationMinutes;
  }

  const uniqueCustomers = [...new Set(requests.map((r) => r.customerName).filter(Boolean))];
  if (uniqueCustomers.length === 0) {
    insights.customerName = null;
  } else if (uniqueCustomers.length === 1) {
    insights.customerName = uniqueCustomers[0];
  } else {
    const createdNames = [...new Set(created.map((r) => r.customerName).filter(Boolean))];
    const names = createdNames.length ? createdNames : uniqueCustomers;
    insights.customerName =
      names.length <= 2 ? names.join(", ") : `${names[0]} +${names.length - 1} more`;
  }

  insights.stateActions = [...new Set(requests.flatMap((r) => r.stateActions))];
}

function parseLogInsights(logText) {
  const insights = {
    customerName: null,
    requestId: null,
    eventDate: null,
    startTime: null,
    endTime: null,
    dateRange: null,
    durationMinutes: null,
    durationDays: null,
    stateActions: [],
    steps: [],
    requests: [],
    requestSummary: {
      planned: 0,
      created: 0,
      skipped: 0,
      failed: 0
    }
  };

  if (!logText) return insights;

  let currentRequest = null;
  let startTimeIso = null;
  let endTimeIso = null;

  const requestIdSnapshotRe = new RegExp(`existingFormData_snapshot_(${INSIGHTS_UUID})_`, "i");
  const requestIdProcessedRe = new RegExp(`processedFields_(${INSIGHTS_UUID})_`, "i");
  const requestIdActionsRe = new RegExp(`/data/(${INSIGHTS_UUID})/actions/`, "i");

  const lines = logText.split(/\r?\n/);
  for (const line of lines) {
    const lineAtMs = parseJmeterLogTimestamp(line);

    let match = line.match(/Request (\d+)\/(\d+) Creation Started/);
    if (match) {
      finalizeRequestInsight(currentRequest, insights);
      currentRequest = createRequestInsight(Number(match[1]), Number(match[2]), lineAtMs);
      pushStep(insights, `Request ${match[1]}/${match[2]} creation started`, "info", lineAtMs);
      continue;
    }

    match = line.match(/Date Range:\s*(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/);
    if (match) {
      insights.dateRange = `${match[1]} to ${match[2]}`;
    }

    if (/REQUEST CALCULATION/.test(line)) {
      pushStep(insights, "Calculated request schedule", "info", lineAtMs);
    }

    if (currentRequest) {
      match = line.match(/Day:\s*\d+\/\d+\s*\((\d{4}-\d{2}-\d{2})/);
      if (match) currentRequest.eventDate = match[1];

      match = line.match(/SUCCESS - Selected unique customer:\s*(.+)/);
      if (match) currentRequest.customerName = match[1].trim();

      match = line.match(/Using customer:\s*(.+)/);
      if (match && !currentRequest.customerName) currentRequest.customerName = match[1].trim();

      match = line.match(/Customer Name:\s*(.+)/);
      if (match) currentRequest.customerName = match[1].trim();

      match = line.match(/user-defined customer mode: customerName=(.+)/i);
      if (match && !currentRequest.customerName) currentRequest.customerName = match[1].trim();

      match = line.match(/Customer '([^']+)'.+Request creation SKIPPED/);
      if (match) {
        if (!currentRequest.customerName) currentRequest.customerName = match[1].trim();
        currentRequest.status = "skipped";
        pushStep(
          insights,
          `Request ${currentRequest.index}/${currentRequest.total}: creation skipped (duplicate customer)`,
          "warn",
          lineAtMs
        );
      }

      if (/Create Request Status PostProcessor: Status:\s*SUCCESS/.test(line)) {
        currentRequest.status = "created";
        const label = currentRequest.customerName
          ? `Request ${currentRequest.index}/${currentRequest.total}: ${currentRequest.customerName} created`
          : `Request ${currentRequest.index}/${currentRequest.total} created`;
        pushStep(insights, label, "success", lineAtMs);
      }

      if (/Create Request Status PostProcessor: Status:\s*FAILED/.test(line)) {
        currentRequest.status = "failed";
        pushStep(
          insights,
          `Request ${currentRequest.index}/${currentRequest.total}: creation failed`,
          "failed",
          lineAtMs
        );
      }

      match = line.match(/Start Time:\s*(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
      if (match) {
        currentRequest.eventDate = currentRequest.eventDate || match[1];
        currentRequest.startTime = match[2];
        startTimeIso = `${match[1]}T${match[2]}:00`;
      }

      match = line.match(/End Time:\s*(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
      if (match) {
        currentRequest.endTime = match[2];
        endTimeIso = `${match[1]}T${match[2]}:00`;
      }

      match = line.match(/(?:New Request|New Event) PreProcessor: Duration:\s*(\d+)/);
      if (match) currentRequest.durationDays = Number(match[1]);

      match = line.match(/Duration:\s*(\d+)min\b/);
      if (match && currentRequest.durationMinutes == null) {
        currentRequest.durationMinutes = Number(match[1]);
      }

      match = line.match(requestIdSnapshotRe);
      if (match) setRequestInsightId(currentRequest, match[1]);

      if (!currentRequest.requestId) {
        match = line.match(requestIdProcessedRe);
        if (match) setRequestInsightId(currentRequest, match[1]);
      }

      if (!currentRequest.requestId) {
        match = line.match(requestIdActionsRe);
        if (match) setRequestInsightId(currentRequest, match[1]);
      }

      match = line.match(/Selected Action:\s*(\w+)/);
      if (match) {
        const action = match[1];
        if (!currentRequest.stateActions.includes(action)) {
          currentRequest.stateActions.push(action);
        }
        if (action === "SUBMIT") {
          pushStep(insights, `Request ${currentRequest.index}/${currentRequest.total}: SUBMIT`, "success", lineAtMs);
        } else {
          pushStep(
            insights,
            `Request ${currentRequest.index}/${currentRequest.total}: ${action}`,
            "success",
            lineAtMs
          );
        }
      }
    } else {
      match = line.match(/SUCCESS - Selected unique customer:\s*(.+)/);
      if (match && !insights.customerName) insights.customerName = match[1].trim();

      match = line.match(requestIdSnapshotRe);
      if (match && !insights.requestId) insights.requestId = match[1];
    }

    const moduleMatch = line.match(/Module:\s*([^|]+)$/);
    if (moduleMatch && !line.includes("Handler:") && !line.includes("Configs:")) {
      pushStep(insights, `Module: ${moduleMatch[1].trim()}`, "info", lineAtMs);
    }
  }

  finalizeRequestInsight(currentRequest, insights);
  applyLegacyInsightSummary(insights);

  if (insights.durationMinutes == null && startTimeIso && endTimeIso) {
    const startMs = Date.parse(startTimeIso);
    const endMs = Date.parse(endTimeIso);
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      insights.durationMinutes = Math.round((endMs - startMs) / 60000);
    }
  }

  return insights;
}

function pushStep(insights, label, status, atMs = null) {
  const last = insights.steps[insights.steps.length - 1];
  if (last && last.label === label) return;
  insights.steps.push({
    label,
    status,
    at: atMs != null ? new Date(atMs).toISOString() : null
  });
}


// ----------------------------
// Artifact + report file serving
// ----------------------------

function getArtifacts(run) {
  const runDir = path.dirname(run.logFile);
  const launcherLog = path.join(runDir, "launcher.log");
  const htmlIndex = path.join(run.reportDir, "index.html");
  const hasHtmlReport = fs.existsSync(htmlIndex);
  return {
    logFile: run.logFile,
    launcherLog: fs.existsSync(launcherLog) ? launcherLog : null,
    jtlFile: fs.existsSync(run.jtlFile) ? run.jtlFile : null,
    htmlReport: hasHtmlReport ? htmlIndex : null,
    htmlReportUrl: hasHtmlReport ? `/runs/${run.id}/report/` : null
  };
}

const REPORT_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json"
};

function contentTypeFor(filePath) {
  return REPORT_CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function resolveReportFile(reportDir, requestPath) {
  let rel = decodeURIComponent(requestPath || "").replace(/^\/+/, "");
  if (!rel || rel.endsWith("/")) {
    rel = path.join(rel, "index.html");
  }

  const reportRoot = path.resolve(reportDir);
  const resolved = path.resolve(reportRoot, rel);
  if (!resolved.startsWith(reportRoot + path.sep) && resolved !== reportRoot) {
    return null;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return null;
  }
  return resolved;
}

function serveHtmlReport(run, requestPath, res) {
  const filePath = resolveReportFile(run.reportDir, requestPath);
  if (!filePath) {
    return sendJson(res, 404, { error: "Report file not found" });
  }

  setCors(res);
  res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
  res.end(fs.readFileSync(filePath));
}

function handleHtmlReport(runId, pathname, res) {
  const run = findRun(runId);
  if (!run) return sendJson(res, 404, { error: "Run not found" });

  const htmlIndex = path.join(run.reportDir, "index.html");
  if (!fs.existsSync(htmlIndex)) {
    return sendJson(res, 404, { error: "HTML report not available yet" });
  }

  if (pathname.endsWith("/report")) {
    setCors(res);
    res.writeHead(302, { Location: `/runs/${runId}/report/` });
    return res.end();
  }

  const prefix = `/runs/${runId}/report/`;
  const subPath = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
  return serveHtmlReport(run, subPath, res);
}

// ----------------------------
// Run object shaping + lifecycle
// ----------------------------

function getRunSummary(run) {
  return {
    id: run.id,
    label: run.label || "",
    planFile: run.planFile || null,
    status: run.status,
    pid: run.pid,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    exitCode: run.exitCode,
    signal: run.signal,
    planPath: run.planPath,
    logFile: run.logFile,
    jtlFile: run.jtlFile,
    reportDir: run.reportDir,
    jmeterArgs: run.jmeterArgs,
    props: run.props
  };
}

function getRunDetail(run, { logTailLines = DEFAULT_LOG_TAIL_LINES } = {}) {
  const logTail = readCombinedLogTail(run, logTailLines);
  const fullLogForInsights = fs.existsSync(run.logFile)
    ? fs.readFileSync(run.logFile, "utf-8")
    : logTail.join("\n");

  return {
    ...getRunSummary(run),
    artifacts: getArtifacts(run),
    summary: parseJtlSummary(run.jtlFile, getContextNameFromRun(run)),
    insights: parseLogInsights(fullLogForInsights),
    logTail,
    logSize: fileSize(run.logFile)
  };
}

// Rebuild an in-memory run from an on-disk run folder.
function hydrateRunFromDisk(id, runDirHint = null) {
  const runDir = runDirHint || findRunDir(id);
  if (!runDir || !fs.existsSync(runDir)) return null;

  const dirName = path.basename(runDir);
  const parsed = parseRunDirName(dirName);
  const meta = readRunMeta(runDir);

  const logFile = path.join(runDir, "jmeter.log");
  const jtlFile = path.join(runDir, "result.jtl");
  const reportDir = path.join(runDir, "html-report");
  const launcherLog = path.join(runDir, "launcher.log");

  let status = "unknown";
  let exitCode = null;
  if (fs.existsSync(launcherLog)) {
    const launcher = fs.readFileSync(launcherLog, "utf-8");
    const exitMatch = launcher.match(/\[launcher-exit\] code=(-?\d+)/);
    if (exitMatch) {
      exitCode = Number(exitMatch[1]);
      status = exitCode === 0 ? "succeeded" : "failed";
    }
  }

  const runPlanPath = path.join(runDir, "BIQ-run.jmx");

  const run = {
    id: parsed.id || id,
    label: meta?.label || parsed.label || "",
    planFile: meta?.planFile || null,
    status,
    pid: null,
    startedAt: meta?.startedAt || fs.statSync(runDir).birthtime.toISOString(),
    endedAt: status === "unknown" ? null : fs.statSync(logFile).mtime.toISOString(),
    exitCode,
    signal: null,
    planPath: fs.existsSync(runPlanPath) ? runPlanPath : null,
    jtlFile,
    logFile,
    reportDir,
    jmeterArgs: meta?.jmeterArgs || [],
    props: meta?.props || {},
    process: null
  };

  runs.set(run.id, run);
  return run;
}

function findRun(id) {
  if (runs.has(id)) return runs.get(id);
  return hydrateRunFromDisk(id);
}

function activeRunExists() {
  for (const run of runs.values()) {
    if (run.status === "running") return true;
  }
  return false;
}

function parseProps(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return [];
  }
  return Object.entries(input)
    .filter(([key, val]) => key && val !== undefined && val !== null)
    .map(([key, val]) => `-J${key}=${String(val)}`);
}

// Launch a JMeter non-GUI run with a per-run patched plan copy.
function startRun({ props = {}, runLabel = "", planFile = null }) {
  const sourcePlanPath = resolvePlanPath(planFile);
  const resolvedPlanFile = planFile || path.basename(sourcePlanPath);

  if (!ALLOW_CONCURRENT_RUNS && activeRunExists()) {
    throw new Error("A run is already in progress. Set ALLOW_CONCURRENT_RUNS=true to bypass.");
  }

  const id = randomUUID();
  const dirName = runDirNameFor(id, runLabel);
  const runDir = path.join(RUNS_DIR, dirName);
  fs.mkdirSync(runDir, { recursive: true });

  const jtlFile = path.join(runDir, "result.jtl");
  const logFile = path.join(runDir, "jmeter.log");
  const reportDir = path.join(runDir, "html-report");
  const runPlanPath = path.join(runDir, "BIQ-run.jmx");

  const { label: _ignoredLabel, ...parameterOverrides } = props;
  const patchedXml = applyParameterOverrides(sourcePlanPath, parameterOverrides);
  fs.writeFileSync(runPlanPath, patchedXml, "utf-8");

  const startedAt = new Date().toISOString();
  writeRunMeta(runDir, {
    id,
    label: runLabel,
    planFile: resolvedPlanFile,
    props: parameterOverrides,
    startedAt
  });

  const propArgs = parseProps(parameterOverrides);
  const jmeterArgs = [
    "-n",
    "-t",
    runPlanPath,
    "-l",
    jtlFile,
    "-j",
    logFile,
    "-e",
    "-o",
    reportDir,
    ...propArgs
  ];

  const child = spawn(JMETER_BIN, jmeterArgs, {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const run = {
    id,
    label: runLabel,
    planFile: resolvedPlanFile,
    status: "running",
    pid: child.pid,
    startedAt,
    endedAt: null,
    exitCode: null,
    signal: null,
    planPath: runPlanPath,
    jtlFile,
    logFile,
    reportDir,
    jmeterArgs,
    props: parameterOverrides,
    process: child
  };

  runs.set(id, run);

  const launcherLog = path.join(runDir, "launcher.log");
  const launcherStream = fs.createWriteStream(launcherLog, { flags: "a" });
  child.stdout.on("data", (chunk) => launcherStream.write(chunk));
  child.stderr.on("data", (chunk) => launcherStream.write(chunk));

  child.on("error", (err) => {
    run.status = "failed";
    run.endedAt = new Date().toISOString();
    run.exitCode = -1;
    launcherStream.write(`\n[launcher-error] ${err.message}\n`);
    launcherStream.end();
  });

  child.on("close", (code, signal) => {
    run.exitCode = code;
    run.signal = signal || null;
    run.endedAt = new Date().toISOString();
    run.status = code === 0 ? "succeeded" : "failed";
    run.process = null;
    launcherStream.write(`\n[launcher-exit] code=${code} signal=${signal || ""}\n`);
    launcherStream.end();
  });

  return run;
}

// Graceful stop for active runs.
function stopRun(id) {
  const run = findRun(id);
  if (!run) return { found: false };
  if (run.status !== "running" || !run.process) return { found: true, stopped: false };

  const stopped = run.process.kill("SIGTERM");
  if (stopped) {
    run.status = "cancelled";
    run.endedAt = new Date().toISOString();
    run.signal = "SIGTERM";
    run.process = null;
  }
  return { found: true, stopped };
}

// Deletes run artifacts only for non-running runs.
function deleteRun(id) {
  const run = findRun(id);
  if (!run) return { found: false };

  if (run.status === "running") {
    return {
      found: true,
      deleted: false,
      error: "Cannot delete a run that is still in progress. Stop it first."
    };
  }

  const runDir = run.logFile ? path.dirname(run.logFile) : findRunDir(id);
  runs.delete(id);

  if (runDir && fs.existsSync(runDir)) {
    fs.rmSync(runDir, { recursive: true, force: true });
  }

  return { found: true, deleted: true };
}

// ----------------------------
// Log APIs (poll + SSE streaming)
// ----------------------------

function handleLogPoll(run, url, res) {
  const offset = Number(url.searchParams.get("offset") || 0);
  const source = url.searchParams.get("source") || "jmeter";
  const download = url.searchParams.get("download") === "1";

  if (download) {
    if (!fs.existsSync(run.logFile)) {
      return sendJson(res, 404, { error: "Log not found yet" });
    }
    setCors(res);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(fs.readFileSync(run.logFile, "utf-8"));
  }

  const filePath =
    source === "launcher"
      ? path.join(path.dirname(run.logFile), "launcher.log")
      : run.logFile;

  const { chunk, nextOffset, size } = tailFromOffset(filePath, offset);
  const lines = chunk.split(/\r?\n/).filter((line, idx, arr) => !(idx === arr.length - 1 && line === ""));

  return sendJson(res, 200, {
    runId: run.id,
    status: run.status,
    source,
    offset,
    nextOffset,
    fileSize: size,
    complete: run.status !== "running" && nextOffset >= size,
    lines
  });
}

// Server-sent events stream that tails launcher + jmeter logs until completion.
function handleLogStream(run, req, res) {
  setCors(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  const runDir = path.dirname(run.logFile);
  const launcherLog = path.join(runDir, "launcher.log");
  const offsets = {
    [launcherLog]: 0,
    [run.logFile]: 0
  };

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent("status", { runId: run.id, status: run.status });

  const interval = setInterval(() => {
    for (const [filePath, fromByte] of Object.entries(offsets)) {
      const { chunk, nextOffset } = tailFromOffset(filePath, fromByte);
      offsets[filePath] = nextOffset;
      if (!chunk) continue;

      const source = filePath.endsWith("launcher.log") ? "launcher" : "jmeter";
      for (const line of chunk.split(/\r?\n/)) {
        if (line) sendEvent("log", { source, line });
      }
    }

    const done = run.status !== "running";
    const allCaughtUp = Object.entries(offsets).every(([filePath, pos]) => pos >= fileSize(filePath));

    if (done && allCaughtUp) {
      sendEvent("complete", {
        runId: run.id,
        status: run.status,
        exitCode: run.exitCode,
        summary: parseJtlSummary(run.jtlFile, getContextNameFromRun(run)),
        insights: parseLogInsights(
          fs.existsSync(run.logFile) ? fs.readFileSync(run.logFile, "utf-8") : ""
        )
      });
      clearInterval(interval);
      res.end();
    }
  }, SSE_POLL_MS);

  req.on("close", () => {
    clearInterval(interval);
  });
}

// ----------------------------
// Main HTTP router
// ----------------------------

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      setCors(res);
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "jmeter-local-runner",
        jmeterBin: JMETER_BIN,
        plansDir: PLANS_DIR,
        endpoints: {
          plans: "GET /plans",
          uploadPlan: "POST /plans?filename=<name.jmx>",
          downloadPlan: "GET /plans/:filename/download",
          deletePlan: "DELETE /plans/:filename",
          parameters: "GET /parameters?plan=<filename>",
          fieldOptions: "POST /field-options",
          runs: "GET /runs",
          startRun: "POST /runs",
          runDetail: "GET /runs/:id",
          runSamples: "GET /runs/:id/samples?status=passed|failed",
          logPoll: "GET /runs/:id/log?offset=0",
          logStream: "GET /runs/:id/log/stream",
          logDownload: "GET /runs/:id/log?download=1",
          stopRun: "POST /runs/:id/stop",
          deleteRun: "DELETE /runs/:id",
          htmlReport: "GET /runs/:id/report/"
        }
      });
    }

    const planDownloadMatch = pathname.match(/^\/plans\/([^/]+)\/download$/i);
    if (req.method === "GET" && planDownloadMatch) {
      const fileName = decodeURIComponent(planDownloadMatch[1]);
      try {
        const planPath = resolvePlanPath(fileName);
        return sendPlanDownload(res, planPath, path.basename(planPath));
      } catch (err) {
        return sendJson(res, 404, { error: err.message || "Plan not found" });
      }
    }

    const planFileMatch = pathname.match(/^\/plans\/([^/]+)$/i);
    if (req.method === "DELETE" && planFileMatch) {
      return handlePlanDelete(decodeURIComponent(planFileMatch[1]), res);
    }

    if (req.method === "POST" && pathname === "/plans") {
      return handlePlanUpload(req, url, res);
    }

    if (req.method === "GET" && pathname === "/plans") {
      return sendJson(res, 200, { plans: listPlanDetails() });
    }

    if (req.method === "GET" && pathname === "/parameters") {
      const planFile = url.searchParams.get("plan") || null;
      const planPath = resolvePlanPath(planFile);
      const schema = parseJmxParameters(planPath);
      return sendJson(res, 200, { ...schema, planFile: path.basename(planPath) });
    }

    if (req.method === "POST" && pathname === "/field-options") {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const planPath = resolvePlanPath(body.planFile || null);
      const field = String(body.field || "").trim();
      if (!field) {
        return sendJson(res, 400, { error: "field is required" });
      }
      try {
        const result = await fetchApiFieldOptions(planPath, field, body.props || {});
        return sendJson(res, 200, result);
      } catch (err) {
        const status = err.statusCode || 500;
        console.error(`[field-options] ${field} failed: ${err.message || err}`);
        return sendJson(res, status, {
          error: err.message || "Failed to load field options",
          field,
          upstreamStatus: err.upstreamStatus || null
        });
      }
    }

    if (req.method === "GET" && pathname === "/runs") {
      const diskDirs = fs.existsSync(RUNS_DIR)
        ? fs.readdirSync(RUNS_DIR).filter((name) =>
            fs.statSync(path.join(RUNS_DIR, name)).isDirectory()
          )
        : [];

      for (const dirName of diskDirs) {
        const { id } = parseRunDirName(dirName);
        if (!runs.has(id)) {
          hydrateRunFromDisk(id, path.join(RUNS_DIR, dirName));
        }
      }

      const list = Array.from(runs.values())
        .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
        .map(getRunSummary);
      return sendJson(res, 200, { runs: list });
    }

    if (req.method === "POST" && pathname === "/runs") {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const run = startRun({
        props: body.props || {},
        runLabel: body.label || "",
        planFile: body.planFile || null
      });
      return sendJson(res, 202, { run: getRunDetail(run, { logTailLines: 20 }) });
    }

    const reportMatch = pathname.match(/^\/runs\/([0-9a-f-]{36})\/report(?:\/.*)?$/i);
    if (req.method === "GET" && reportMatch) {
      return handleHtmlReport(reportMatch[1], pathname, res);
    }

    const logStreamMatch = pathname.match(/^\/runs\/([a-f0-9-]+)\/log\/stream$/i);
    if (req.method === "GET" && logStreamMatch) {
      const run = findRun(logStreamMatch[1]);
      if (!run) return sendJson(res, 404, { error: "Run not found" });
      return handleLogStream(run, req, res);
    }

    const logMatch = pathname.match(/^\/runs\/([a-f0-9-]+)\/log$/i);
    if (req.method === "GET" && logMatch) {
      const run = findRun(logMatch[1]);
      if (!run) return sendJson(res, 404, { error: "Run not found" });
      return handleLogPoll(run, url, res);
    }

    const samplesMatch = pathname.match(/^\/runs\/([a-f0-9-]+)\/samples$/i);
    if (req.method === "GET" && samplesMatch) {
      const run = findRun(samplesMatch[1]);
      if (!run) return sendJson(res, 404, { error: "Run not found" });
      const status = String(url.searchParams.get("status") || "all");
      const offset = Number(url.searchParams.get("offset") || 0);
      const limit = Number(url.searchParams.get("limit") || 200);
      const samples = parseJtlSamples(run.jtlFile, {
        status,
        offset,
        limit,
        contextName: getContextNameFromRun(run)
      });
      return sendJson(res, 200, { runId: run.id, status, ...samples });
    }

    const stopMatch = pathname.match(/^\/runs\/([a-f0-9-]+)\/stop$/i);
    if (req.method === "POST" && stopMatch) {
      const result = stopRun(stopMatch[1]);
      if (!result.found) return sendJson(res, 404, { error: "Run not found" });
      return sendJson(res, 200, result);
    }

    const runMatch = pathname.match(/^\/runs\/([a-f0-9-]+)$/i);
    if (runMatch) {
      const runId = runMatch[1];

      if (req.method === "GET") {
        const run = findRun(runId);
        if (!run) return sendJson(res, 404, { error: "Run not found" });
        const tailLines = Number(url.searchParams.get("logTail") || DEFAULT_LOG_TAIL_LINES);
        return sendJson(res, 200, { run: getRunDetail(run, { logTailLines: tailLines }) });
      }

      if (req.method === "DELETE") {
        const result = deleteRun(runId);
        if (!result.found) return sendJson(res, 404, { error: "Run not found" });
        if (!result.deleted) {
          return sendJson(res, 409, { error: result.error || "Run could not be deleted" });
        }
        return sendJson(res, 200, { deleted: true, id: runId });
      }
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`jmeter-local-runner listening on http://localhost:${PORT}`);
  const plans = listPlans();
  console.log(`Plans dir: ${PLANS_DIR} (${plans.length} plan${plans.length === 1 ? "" : "s"}: ${plans.join(", ") || "none"})`);
  if (LEGACY_PLAN_PATH) console.log(`Legacy plan override: ${LEGACY_PLAN_PATH}`);
  console.log(`Using jmeter bin: ${JMETER_BIN}`);
});
