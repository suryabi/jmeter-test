const fs = require("fs");
const path = require("path");

/** Load project-root `.env` into process.env (does not override existing env vars). */
function loadEnvFile(envPath = path.join(__dirname, "..", ".env")) {
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function formatEnvValue(value) {
  const text = String(value ?? "");
  if (/[\s#]/.test(text)) return `"${text}"`;
  return text;
}

/** Create or update keys in project-root `.env` (preserves other lines and comments). */
function upsertEnvFile(envPath = path.join(__dirname, "..", ".env"), updates = {}) {
  let lines = [];
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  }

  const remaining = new Set(Object.keys(updates));
  const out = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }

    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      out.push(line);
      continue;
    }

    const key = trimmed.slice(0, eq).trim();
    if (remaining.has(key)) {
      out.push(`${key}=${formatEnvValue(updates[key])}`);
      remaining.delete(key);
    } else {
      out.push(line);
    }
  }

  for (const key of remaining) {
    out.push(`${key}=${formatEnvValue(updates[key])}`);
  }

  const body = out.join("\n");
  fs.writeFileSync(envPath, body ? `${body}\n` : "", "utf8");
}

module.exports = { loadEnvFile, upsertEnvFile, formatEnvValue };
