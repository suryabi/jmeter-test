const fs = require("fs");
const path = require("path");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function encodeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const API_FIELD_VARIABLES_TITLE = "API Field Variables";
const DEFAULT_PARAMETER_COLS = 4;

/** Fields referenced via header.field:* that are resolved server-side when absent from form props. */
const AUTO_RESOLVE_FIELDS = {
  customerId: {
    endpoint: "/${contextname}/api/tenants?verbose=false&active=true",
    itemsPath: "_embedded.tenants",
    valueField: "uniqueId"
  }
};

function inferType(description) {
  const desc = String(description || "").trim();
  // Type tags at the start of Argument.desc (e.g. "BOOLEAN. ...", "DATE, REQUIRED. ...")
  if (/^DROPDOWN,\s*API/i.test(desc)) {
    return /,\s*MULTI\b/i.test(desc) ? "multiselect" : "dropdown";
  }
  if (/^BOOLEAN[,.]/i.test(desc)) return "boolean";
  if (/^DATE[,.]/i.test(desc)) return "date";
  return "text";
}

/**
 * Strip type/required markers from the description so they don't show in the UI.
 * e.g. "DATE, REQUIRED. Start date for the run" → "Start date for the run"
 */
function isHiddenParameter(description) {
  return /\bHIDE\b/i.test(String(description || ""));
}

function parseParameterLabel(description) {
  const match = String(description || "").match(/\bLABEL=([a-zA-Z][a-zA-Z0-9_]*)\b/);
  return match ? match[1] : null;
}

function parseParameterCols(description) {
  const match = String(description || "").match(/\bCOLS=(\d+)\b/i);
  if (!match) return DEFAULT_PARAMETER_COLS;
  const cols = Number.parseInt(match[1], 10);
  if (!Number.isFinite(cols) || cols < 1 || cols > 12) {
    return DEFAULT_PARAMETER_COLS;
  }
  return cols;
}

function cleanDescription(description) {
  return String(description || "")
    .replace(/\bLABEL=[a-zA-Z][a-zA-Z0-9_]*\s*[,.]?\s*/gi, "")
    .replace(/\bCOLS=\d+\s*[,.]?\s*/gi, "")
    .replace(/\bHIDE\b\s*[,.]?\s*/gi, "")
    .replace(/,\s*,/g, ",")
    .replace(/^,\s*/, "")
    .replace(/^[,.]+\s*/, "")
    .replace(/^(DROPDOWN,\s*API)(,\s*MULTI)?(,\s*REQUIRED)?[,.]\s*/i, "")
    .replace(/^(DATE|BOOLEAN)(,\s*REQUIRED|,\s*)?[,.]\s*/i, "")
    .replace(/^REQUIRED[,.]\s*/i, "")
    .trim();
}

function parseApiFieldMapping(description) {
  const mapping = {};
  const requestHeaders = {};
  for (const segment of String(description || "").trim().split(/\s+/)) {
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const key = segment.slice(0, eq);
    const value = segment.slice(eq + 1);
    if (key.startsWith("header.")) {
      requestHeaders[key.slice("header.".length)] = value;
    } else {
      mapping[key] = value;
    }
  }
  return { mapping, requestHeaders };
}

function resolveApiHeaderSource(sourceSpec, props) {
  const spec = String(sourceSpec ?? "").trim();
  if (!spec) return "";
  if (spec.startsWith("literal:")) {
    return spec.slice("literal:".length).trim();
  }
  const fieldName = spec.startsWith("field:") ? spec.slice("field:".length).trim() : spec;
  return String(props[fieldName] ?? "").trim();
}

function applyApiFieldHeaders(headers, apiConfig, props) {
  for (const [headerName, sourceSpec] of Object.entries(apiConfig.requestHeaders || {})) {
    const value = resolveApiHeaderSource(sourceSpec, props);
    if (value) {
      headers[headerName] = value;
    }
  }
}

function collectReferencedFields(apiConfig) {
  const refs = new Set(apiConfig.depends || []);
  for (const sourceSpec of Object.values(apiConfig.requestHeaders || {})) {
    const spec = String(sourceSpec ?? "").trim();
    if (spec.startsWith("field:")) {
      refs.add(spec.slice("field:".length).trim());
    } else if (!spec.startsWith("literal:") && spec) {
      refs.add(spec);
    }
  }
  return refs;
}

async function resolveAutoField(xml, fieldName, props, contextFieldName) {
  const config = AUTO_RESOLVE_FIELDS[fieldName];
  if (!config) return "";

  const url = buildApiUrl(config.endpoint, props);
  const headers = buildRequestHeaders(xml, props);
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw formatUpstreamApiError(fieldName, response.status, body);
  }

  const json = await response.json();
  const items = getByPath(json, config.itemsPath);
  if (!Array.isArray(items) || !items.length) {
    throw new Error(
      `Could not resolve ${fieldName} for ${contextFieldName}: no items at ${config.itemsPath}`
    );
  }

  return String(items[0]?.[config.valueField] ?? "").trim();
}

async function enrichPropsForApiField(xml, props, apiConfig, fieldName) {
  const enriched = { ...props };
  const refs = collectReferencedFields(apiConfig);

  for (const ref of refs) {
    if (String(enriched[ref] ?? "").trim()) continue;
    if (!AUTO_RESOLVE_FIELDS[ref]) continue;
    enriched[ref] = await resolveAutoField(xml, ref, enriched, fieldName);
  }

  return enriched;
}

function parseApiFieldVariables(xml) {
  const re = new RegExp(
    `<Arguments\\b[^>]*testname="${API_FIELD_VARIABLES_TITLE}"[^>]*>[\\s\\S]*?<collectionProp name="Arguments\\.arguments">([\\s\\S]*?)<\\/collectionProp>`,
    "i"
  );
  const match = xml.match(re);
  if (!match) return {};

  const blockXml = match[1] || "";
  const fields = {};
  const entryRe = /<elementProp name="([^"]+)" elementType="Argument">([\s\S]*?)<\/elementProp>/g;
  let entry;
  while ((entry = entryRe.exec(blockXml)) !== null) {
    const inner = entry[2];
    const name =
      inner.match(/<stringProp name="Argument.name">([^<]*)<\/stringProp>/)?.[1] || entry[1];
    const endpoint = decodeXml(
      inner.match(/<stringProp name="Argument.value">([^<]*)<\/stringProp>/)?.[1] || ""
    );
    const description = decodeXml(
      inner.match(/<stringProp name="Argument.desc">([^<]*)<\/stringProp>/)?.[1] || ""
    );
    const { mapping, requestHeaders } = parseApiFieldMapping(description);
    fields[name] = {
      endpoint,
      itemsPath: mapping.items || "",
      displayField: mapping.display || "name",
      valueField: mapping.value || "id",
      depends: (mapping.depends || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
      ignore: (mapping.ignore || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
      requestHeaders,
      multi: String(mapping.multi || "").toLowerCase() === "true",
      defaultPopulateFirstElement:
        String(mapping.defaultPopulateFirstElement || "").toLowerCase() === "true"
    };
  }

  return fields;
}

function substituteTemplate(template, vars) {
  return String(template || "").replace(/\$\{([^}]+)\}/g, (_, key) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function getByPath(obj, path) {
  if (!path) return obj;
  return String(path)
    .split(".")
    .filter(Boolean)
    .reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function fieldFromItem(item, fieldPath) {
  if (!fieldPath) return "";
  const value = fieldPath.includes(".")
    ? getByPath(item, fieldPath)
    : item?.[fieldPath];
  return value == null ? "" : String(value);
}

function enrichParameter(param, apiFieldMap) {
  if (param.type !== "dropdown" && param.type !== "multiselect") return param;
  const apiConfig = apiFieldMap[param.name];
  if (!apiConfig) return param;
  return { ...param, apiConfig };
}

function sectionIdFromTestname(testname, fallbackIndex) {
  const slug = String(testname || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `group-${fallbackIndex + 1}`;
}

function parseArgumentsSections(xml) {
  const sections = [];
  const re =
    /<Arguments\b[^>]*testname="([^"]+)"[^>]*>[\s\S]*?<collectionProp name="Arguments\.arguments">([\s\S]*?)<\/collectionProp>[\s\S]*?<\/Arguments>/g;

  let match;
  while ((match = re.exec(xml)) !== null) {
    const testname = decodeXml(match[1] || "").trim();
    const blockXml = match[2] || "";
    sections.push({
      id: sectionIdFromTestname(testname, sections.length),
      title: testname || `Group ${sections.length + 1}`,
      parameters: parseArgumentsBlock(blockXml)
    });
  }

  return sections;
}

function parseArgumentsBlock(blockXml) {
  const params = [];
  const re = /<elementProp name="([^"]+)" elementType="Argument">([\s\S]*?)<\/elementProp>/g;

  let match;
  while ((match = re.exec(blockXml)) !== null) {
    const inner = match[2];
    const name =
      inner.match(/<stringProp name="Argument.name">([^<]*)<\/stringProp>/)?.[1] || match[1];
    const defaultValue = decodeXml(
      inner.match(/<stringProp name="Argument.value">([^<]*)<\/stringProp>/)?.[1] || ""
    );
    const description = decodeXml(
      inner.match(/<stringProp name="Argument.desc">([^<]*)<\/stringProp>/)?.[1] || ""
    );
    const label = parseParameterLabel(description);
    const cols = parseParameterCols(description);
    params.push({
      name,
      defaultValue,
      description: cleanDescription(description),
      type: inferType(description),
      required: /REQUIRED/i.test(description),
      hidden: isHiddenParameter(description),
      cols,
      ...(label ? { label } : {}),
      kind: "argument"
    });
  }

  return params;
}

// Angular FormGroup keys cannot contain "." — use "__" between prefix and header name.
const HEADER_PARAM_PREFIX = "header__";

function threadGroupScopeEnd(xml) {
  const idx = xml.search(/<HTTPSamplerProxy\b/);
  return idx > 0 ? idx : xml.length;
}

function isVariableReference(value) {
  return /^\$\{[^}]+\}$/.test(String(value || "").trim());
}

function parseHeadersBlock(blockXml) {
  const params = [];
  const re = /<elementProp name="[^"]*" elementType="Header">([\s\S]*?)<\/elementProp>/g;

  let match;
  while ((match = re.exec(blockXml)) !== null) {
    const inner = match[1];
    const headerName = decodeXml(
      inner.match(/<stringProp name="Header.name">([^<]*)<\/stringProp>/)?.[1] || ""
    );
    const defaultValue = decodeXml(
      inner.match(/<stringProp name="Header.value">([^<]*)<\/stringProp>/)?.[1] || ""
    );
    params.push({
      name: `${HEADER_PARAM_PREFIX}${headerName}`,
      headerName,
      defaultValue,
      description: isVariableReference(defaultValue)
        ? `References ${defaultValue}`
        : `HTTP header`,
      type: "text",
      required: false,
      kind: "header"
    });
  }

  return params;
}

function parseHeaderManagerSections(xml) {
  const scope = xml.slice(0, threadGroupScopeEnd(xml));
  const sections = [];
  const re =
    /<HeaderManager\b[^>]*testname="([^"]+)"[^>]*>[\s\S]*?<collectionProp name="HeaderManager\.headers">([\s\S]*?)<\/collectionProp>[\s\S]*?<\/HeaderManager>/g;

  let match;
  while ((match = re.exec(scope)) !== null) {
    const testname = decodeXml(match[1] || "").trim();
    const blockXml = match[2] || "";
    sections.push({
      id: sectionIdFromTestname(testname, sections.length),
      title: testname || `Headers ${sections.length + 1}`,
      parameters: parseHeadersBlock(blockXml)
    });
  }

  return sections;
}

function normalizeAuthorization(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

function resolveHeaderValue(rawValue, props) {
  let value = String(rawValue ?? "").trim();
  if (isVariableReference(value)) {
    value = String(props[value.slice(2, -1)] ?? "").trim();
  }
  return value;
}

function buildRequestHeaders(xml, props) {
  const headers = {};
  for (const section of parseHeaderManagerSections(xml)) {
    for (const header of section.parameters) {
      if (!header.headerName) continue;

      const propKey = `${HEADER_PARAM_PREFIX}${header.headerName}`;
      const propOverride = String(props[propKey] ?? "").trim();
      const raw = propOverride || header.defaultValue;
      let value = resolveHeaderValue(raw, props);
      if (!value) continue;

      if (header.headerName.toLowerCase() === "authorization") {
        value = normalizeAuthorization(value);
      }
      headers[header.headerName] = value;
    }
  }

  const envAuth = process.env.BIQ_AUTHORIZATION;
  if (envAuth && String(envAuth).trim()) {
    headers.Authorization = normalizeAuthorization(envAuth);
  }

  return headers;
}

function formatUpstreamApiError(fieldName, status, bodyText) {
  let detail = bodyText.slice(0, 240);
  try {
    const parsed = JSON.parse(bodyText);
    const first = parsed?.errors?.[0];
    if (first?.message) {
      detail = first.message;
      if (first.code) detail = `${first.code}: ${detail}`;
    }
  } catch {
    // keep raw snippet
  }
  const err = new Error(
    `BriefingIQ API returned ${status} for ${fieldName}: ${detail}`
  );
  err.statusCode = status === 401 || status === 403 ? 401 : 502;
  err.upstreamStatus = status;
  return err;
}

function buildApiUrl(endpoint, props) {
  const path = substituteTemplate(endpoint, props);
  const protocol = props.protocol || "https";
  const host = props.host;
  if (!host) {
    throw new Error("host is required to call API field endpoints");
  }
  const port = String(props.port || (protocol === "https" ? "443" : "80"));
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const omitPort =
    (protocol === "https" && port === "443") || (protocol === "http" && port === "80");
  return `${protocol}://${host}${omitPort ? "" : `:${port}`}${normalizedPath}`;
}

function dependenciesSatisfied(apiConfig, props = {}) {
  if (!apiConfig.depends?.length) return true;
  return apiConfig.depends.every((dep) => String(props[dep] ?? "").trim());
}

function isApiFieldDebugEnabled() {
  return String(process.env.BIQ_DEBUG_API_FIELDS || "").toLowerCase() === "true";
}

function sanitizeHeadersForLog(headers) {
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === "authorization") {
      const value = String(out[key] || "");
      out[key] = value ? `Bearer …(${value.length} chars)` : "[empty]";
    }
  }
  return out;
}

function summarizeApiFieldResponse(json, itemsPath) {
  const atPath = getByPath(json, itemsPath);
  const embedded = getByPath(json, "_embedded");
  return {
    itemsPath,
    itemsType: atPath == null ? "null" : Array.isArray(atPath) ? "array" : typeof atPath,
    itemsLength: Array.isArray(atPath) ? atPath.length : undefined,
    embeddedKeys:
      embedded && typeof embedded === "object" && !Array.isArray(embedded)
        ? Object.keys(embedded)
        : [],
    topLevelKeys: json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json) : []
  };
}

function buildApiFieldRequestLog(fieldName, apiConfig, resolvedProps, url, headers) {
  const depends = apiConfig.depends || [];
  return {
    field: fieldName,
    method: "GET",
    url,
    itemsPath: apiConfig.itemsPath,
    depends,
    resolvedDepends: Object.fromEntries(depends.map((dep) => [dep, resolvedProps[dep] ?? ""])),
    headers: sanitizeHeadersForLog(headers)
  };
}

function logApiFieldRequest(fieldName, requestLog) {
  console.log(
    `[field-options:${fieldName}] upstream request\n${JSON.stringify(requestLog, null, 2)}`
  );
}

function logApiFieldFailure(fieldName, requestLog, details) {
  console.error(
    `[field-options:${fieldName}] upstream failure\n${JSON.stringify({ ...requestLog, ...details }, null, 2)}`
  );
}

async function fetchApiFieldOptions(planPath, fieldName, props = {}) {
  const xml = fs.readFileSync(planPath, "utf-8");
  const apiFields = parseApiFieldVariables(xml);
  const apiConfig = apiFields[fieldName];
  if (!apiConfig) {
    throw new Error(`No API field config for: ${fieldName}`);
  }

  const resolvedProps = await enrichPropsForApiField(xml, props, apiConfig, fieldName);

  if (!dependenciesSatisfied(apiConfig, resolvedProps)) {
    if (isApiFieldDebugEnabled()) {
      console.log(
        `[field-options:${fieldName}] skipped — dependencies not satisfied`,
        Object.fromEntries((apiConfig.depends || []).map((dep) => [dep, resolvedProps[dep] ?? ""]))
      );
    }
    return { field: fieldName, options: [] };
  }

  const url = buildApiUrl(apiConfig.endpoint, resolvedProps);
  const headers = buildRequestHeaders(xml, resolvedProps);
  applyApiFieldHeaders(headers, apiConfig, resolvedProps);
  const requestLog = buildApiFieldRequestLog(fieldName, apiConfig, resolvedProps, url, headers);

  if (isApiFieldDebugEnabled()) {
    logApiFieldRequest(fieldName, requestLog);
  }

  const response = await fetch(url, { headers });
  const bodyText = await response.text();

  if (!response.ok) {
    logApiFieldFailure(fieldName, requestLog, {
      responseStatus: response.status,
      bodyPreview: bodyText.slice(0, 1200)
    });
    throw formatUpstreamApiError(fieldName, response.status, bodyText);
  }

  let json;
  try {
    json = JSON.parse(bodyText);
  } catch (parseErr) {
    logApiFieldFailure(fieldName, requestLog, {
      responseStatus: response.status,
      parseError: parseErr.message,
      bodyPreview: bodyText.slice(0, 1200)
    });
    throw new Error(`Invalid JSON from BriefingIQ API for ${fieldName} (${url})`);
  }

  const items = getByPath(json, apiConfig.itemsPath);
  if (!Array.isArray(items)) {
    const summary = summarizeApiFieldResponse(json, apiConfig.itemsPath);
    logApiFieldFailure(fieldName, requestLog, {
      responseStatus: response.status,
      ...summary,
      bodyPreview: bodyText.slice(0, 1200)
    });
    const embeddedHint = summary.embeddedKeys.length
      ? ` _embedded keys: ${summary.embeddedKeys.join(", ")}`
      : "";
    throw new Error(
      `Expected array at ${apiConfig.itemsPath} for ${fieldName}. URL: ${url}.${embeddedHint}`
    );
  }

  const ignoreValues = new Set(
    (apiConfig.ignore || []).map((entry) => String(entry).trim().toLowerCase()).filter(Boolean)
  );
  const options = items
    .map((item) => {
      const value = fieldFromItem(item, apiConfig.valueField);
      const label = fieldFromItem(item, apiConfig.displayField) || value;
      return { label: String(label), value: String(value) };
    })
    .filter(
      (option) =>
        option.value && !ignoreValues.has(String(option.value).trim().toLowerCase())
    );

  if (isApiFieldDebugEnabled()) {
    console.log(
      `[field-options:${fieldName}] ok — ${options.length} option(s)`,
      summarizeApiFieldResponse(json, apiConfig.itemsPath)
    );
  }

  return { field: fieldName, options };
}

function parseJmxParameters(planPath) {
  const xml = fs.readFileSync(planPath, "utf-8");
  const apiFieldMap = parseApiFieldVariables(xml);
  const groups = [
    ...parseArgumentsSections(xml)
      .filter((group) => group.title !== API_FIELD_VARIABLES_TITLE)
      .map((group) => ({
        ...group,
        parameters: group.parameters.map((param) => enrichParameter(param, apiFieldMap))
      })),
    ...parseHeaderManagerSections(xml)
  ].filter((group) => group.parameters.length > 0);

  return { planPath, groups };
}

function setArgumentValue(xml, name, value) {
  const encoded = encodeXml(value);
  const re = new RegExp(
    `(<elementProp name="${escapeRegExp(name)}" elementType="Argument">\\s*<stringProp name="Argument.name">${escapeRegExp(name)}</stringProp>\\s*<stringProp name="Argument.value">)[^<]*(</stringProp>)`,
    "g"
  );
  const apiBlockRe = new RegExp(
    `<Arguments\\b[^>]*testname="${API_FIELD_VARIABLES_TITLE}"[^>]*>[\\s\\S]*?<\\/Arguments>`,
    "i"
  );
  const apiMatch = xml.match(apiBlockRe);
  const apiBlock = apiMatch ? apiMatch[0] : null;
  const apiStart = apiMatch ? apiMatch.index : -1;

  function patchSegment(segment) {
    return segment.replace(re, `$1${encoded}$2`);
  }

  if (apiBlock == null) {
    return patchSegment(xml);
  }

  const before = xml.slice(0, apiStart);
  const after = xml.slice(apiStart + apiBlock.length);
  const patched = patchSegment(before) + apiBlock + patchSegment(after);
  return re.test(before + after) ? patched : xml;
}

function setHeaderValue(xml, headerName, value) {
  const scopeEnd = threadGroupScopeEnd(xml);
  const scope = xml.slice(0, scopeEnd);
  const rest = xml.slice(scopeEnd);
  const encoded = encodeXml(value);
  const re = new RegExp(
    `(<stringProp name="Header\\.name">${escapeRegExp(headerName)}</stringProp>\\s*<stringProp name="Header\\.value">)[^<]*(</stringProp>)`
  );

  if (!re.test(scope)) {
    return xml;
  }

  return scope.replace(re, `$1${encoded}$2`) + rest;
}

const SAMPLE_DETAILS_LISTENER_TESTNAME = "Runner sample details";

/** Injects a JSR223 listener that appends per-sample request/response JSON lines at run time. */
function patchPlanForSampleDetailsListener(xml, { scriptPath } = {}) {
  if (xml.includes(`testname="${SAMPLE_DETAILS_LISTENER_TESTNAME}"`)) {
    return xml;
  }

  const groovyScriptPath =
    scriptPath || path.join(__dirname, "scripts", "jmeter-sample-detail-listener.groovy");
  const escapedPath = encodeXml(groovyScriptPath.replace(/\\/g, "/"));

  const listener = `
      <JSR223Listener guiclass="TestBeanGUI" testclass="JSR223Listener" testname="${SAMPLE_DETAILS_LISTENER_TESTNAME}" enabled="true">
        <stringProp name="scriptLanguage">groovy</stringProp>
        <stringProp name="parameters"></stringProp>
        <stringProp name="filename">${escapedPath}</stringProp>
        <stringProp name="cacheKey">true</stringProp>
        <stringProp name="script"></stringProp>
      </JSR223Listener>
      <hashTree/>`;

  const replaced = xml.replace(/<\/TestPlan>\s*<hashTree>/, (match) => `${match}${listener}`);
  return replaced;
}

function applyParameterOverrides(planPath, overrides) {
  let xml = fs.readFileSync(planPath, "utf-8");

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    if (name.startsWith(HEADER_PARAM_PREFIX)) {
      xml = setHeaderValue(xml, name.slice(HEADER_PARAM_PREFIX.length), String(value));
    } else {
      xml = setArgumentValue(xml, name, String(value));
    }
  }

  return xml;
}

module.exports = {
  parseJmxParameters,
  applyParameterOverrides,
  patchPlanForSampleDetailsListener,
  fetchApiFieldOptions,
  buildRequestHeaders,
  DEFAULT_PARAMETER_COLS,
  parseParameterCols
};
