const INSIGHTS_UUID =
  "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}";

function parseJmeterLogTimestamp(line) {
  const m = String(line).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}),(\d{3})/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}.${m[3]}`);
  return Number.isFinite(ms) ? ms : null;
}

function emptyInsights() {
  return {
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
    requestSummary: { planned: 0, created: 0, skipped: 0, failed: 0 },
    entities: [],
    summaries: {},
    ui: []
  };
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

function createEntity(kind, { index, total, atMs, parentId = null, status = "started" } = {}) {
  const suffix =
    index != null ? String(index) : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id: `${kind}-${suffix}`,
    kind,
    index: index ?? null,
    total: total ?? null,
    parentId,
    status,
    fields: {},
    at: atMs != null ? new Date(atMs).toISOString() : null
  };
}

function resolveTemplate(token, context) {
  if (token == null || token === "") return "";
  const key = String(token);
  if (/^\d+$/.test(key)) {
    const group = context.groups?.[Number(key)];
    return group != null ? String(group) : "";
  }
  if (key in context) {
    const value = context[key];
    return value == null ? "" : String(value);
  }
  if (key.startsWith("field:")) {
    const fieldName = key.slice("field:".length);
    return context.fields?.[fieldName] != null ? String(context.fields[fieldName]) : "";
  }
  return "";
}

function renderTemplate(template, context) {
  if (!template) return "";
  return String(template).replace(/\$(\w+|\d+)/g, (_, key) => resolveTemplate(key, context));
}

function compileInsightMatch(pattern) {
  const source = String(pattern || "").trim();
  if (!source) return null;
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

function buildRuleContext(entity, match, insights = null) {
  const fields = entity?.fields || {};
  const runFields =
    insights && typeof insights === "object"
      ? {
          presentersPlanned: insights.presentersPlanned ?? "",
          customerName: insights.customerName ?? ""
        }
      : {};
  return {
    index: entity?.index ?? "",
    total: entity?.total ?? "",
    status: entity?.status ?? "",
    groups: match ? Array.from(match) : [],
    fields,
    customerName: fields.customerName ?? runFields.customerName ?? "",
    requestId: fields.requestId ?? "",
    topicName: fields.topicName ?? "",
    presenterId: fields.presenterId ?? "",
    eventDate: fields.eventDate ?? "",
    startTime: fields.startTime ?? "",
    endTime: fields.endTime ?? "",
    presentersPlanned: runFields.presentersPlanned ?? ""
  };
}

function findParentEntity(entities, stack, rule, match) {
  const parentKind = rule.parent;
  if (!parentKind) return null;

  const linkEntries = Object.entries(rule.link || {});
  if (linkEntries.length) {
    const [linkField, linkTemplate] = linkEntries[0];
    const ctx = buildRuleContext(null, match);
    const wanted = renderTemplate(linkTemplate, ctx);
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const entity = entities[stack[i]];
      if (entity.kind !== parentKind) continue;
      const candidate =
        linkField === "index"
          ? String(entity.index ?? "")
          : String(entity.fields?.[linkField] ?? "");
      if (candidate && candidate === wanted) return entity;
    }
    return null;
  }

  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const entity = entities[stack[i]];
    if (entity.kind === parentKind) return entity;
  }
  return null;
}

function finalizeEntity(entity, insights) {
  if (!entity || entity._finalized) return;
  entity._finalized = true;
  insights.entities.push(entity);
}

function finalizeBeforeScopeOpen(kind, parentKind, entities, stack, insights) {
  if (parentKind) {
    while (stack.length && entities[stack[stack.length - 1]].kind === kind) {
      finalizeEntity(entities[stack.pop()], insights);
    }
    return;
  }
  while (stack.length) {
    const top = entities[stack[stack.length - 1]];
    if (top.kind === kind || isDescendantOfKind(entities, stack, top, kind)) {
      stack.pop();
      finalizeEntity(top, insights);
    } else {
      break;
    }
  }
}

function finalizeKindFromStack(kind, entities, stack, insights) {
  while (stack.length) {
    const top = entities[stack[stack.length - 1]];
    if (top.kind !== kind && !isDescendantOfKind(entities, stack, top, kind)) break;
    stack.pop();
    finalizeEntity(top, insights);
  }
}

function isDescendantOfKind(entities, stack, entity, kind) {
  let parentId = entity.parentId;
  while (parentId) {
    const parent = entities.find((e) => e.id === parentId);
    if (!parent) return false;
    if (parent.kind === kind) return true;
    parentId = parent.parentId;
  }
  for (const idx of stack) {
    const open = entities[idx];
    if (open.id === entity.parentId) {
      if (open.kind === kind) return true;
      return isDescendantOfKind(entities, stack, open, kind);
    }
  }
  return false;
}

function setEntityField(entity, fieldName, rawValue, { append = false } = {}) {
  if (!entity || !fieldName) return;
  const value = rawValue == null ? "" : String(rawValue).trim();
  if (!value) return;

  if (fieldName === "requestId") {
    if (!value || value === "unknown" || value === "default") return;
    if (entity.fields.requestId) return;
  }

  if (append) {
    if (!Array.isArray(entity.fields[fieldName])) {
      entity.fields[fieldName] = entity.fields[fieldName]
        ? [String(entity.fields[fieldName])]
        : [];
    }
    if (!entity.fields[fieldName].includes(value)) {
      entity.fields[fieldName].push(value);
    }
    return;
  }

  entity.fields[fieldName] = value;
}

function applyFieldRule(entity, rule, match) {
  if (!entity) return;
  const fieldName = rule.set;
  if (!fieldName) return;
  if (rule.onlyIfEmpty && entity.fields[fieldName]) return;

  let value = rule.value;
  if (value == null && rule.group != null) {
    value = match[Number(rule.group)] ?? "";
  } else if (value == null && rule.template) {
    value = renderTemplate(rule.template, buildRuleContext(entity, match));
  }

  setEntityField(entity, fieldName, value, { append: rule.append });
  if (fieldName === "status" && value) {
    entity.status = String(value);
  }
}

function findScopedEntity(entities, stack, scopeKind, rule = null, match = null, insights = null) {
  if (!scopeKind || scopeKind === "run") return null;

  if (rule?.link?.index != null && match) {
    const wanted = renderTemplate(rule.link.index, buildRuleContext(null, match, insights));
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const entity = entities[stack[i]];
      if (entity.kind !== scopeKind) continue;
      if (String(entity.index ?? "") === wanted) return entity;
    }
    return null;
  }

  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const entity = entities[stack[i]];
    if (entity.kind === scopeKind) return entity;
  }
  return null;
}

function applySummaries(insights, summaryRules) {
  for (const rule of summaryRules) {
    const kind = rule.entity;
    if (!kind) continue;
    const field = rule.field || "status";
    const counts = rule.counts || ["created", "skipped", "failed", "started"];
    const matched = insights.entities.filter((entity) => entity.kind === kind);
    const summary = { planned: matched[0]?.total ?? matched.length };

    for (const status of counts) {
      summary[status] = matched.filter((entity) => {
        const value = entity.status || entity.fields?.[field];
        return String(value) === status;
      }).length;
    }

    insights.summaries[kind] = summary;

    if (kind === "request") {
      insights.requestSummary = {
        planned: summary.planned ?? 0,
        created: summary.created ?? 0,
        skipped: summary.skipped ?? 0,
        failed: summary.failed ?? 0
      };
    }
  }
}

function applyLegacyRequestMapping(insights) {
  const requestEntities = insights.entities.filter((entity) => entity.kind === "request");
  insights.requests = requestEntities.map((entity) => ({
    index: entity.index ?? 0,
    total: entity.total ?? 0,
    customerName: entity.fields.customerName ?? null,
    requestId: entity.fields.requestId ?? null,
    eventDate: entity.fields.eventDate ?? null,
    startTime: entity.fields.startTime ?? null,
    endTime: entity.fields.endTime ?? null,
    durationDays:
      entity.fields.durationDays != null ? Number(entity.fields.durationDays) : null,
    durationMinutes:
      entity.fields.durationMinutes != null ? Number(entity.fields.durationMinutes) : null,
    status: entity.status || "started",
    stateActions: Array.isArray(entity.fields.stateActions)
      ? entity.fields.stateActions
      : entity.fields.stateActions
        ? [String(entity.fields.stateActions)]
        : [],
    at: entity.at
  }));

  const created = insights.requests.filter((request) => request.status === "created");
  const primary = created[created.length - 1] || created[0] || insights.requests.at(-1);
  if (primary) {
    insights.requestId = primary.requestId;
    insights.eventDate = primary.eventDate;
    insights.startTime = primary.startTime;
    insights.endTime = primary.endTime;
    insights.durationDays = primary.durationDays;
    insights.durationMinutes = primary.durationMinutes;
  }

  const uniqueCustomers = [
    ...new Set(insights.requests.map((request) => request.customerName).filter(Boolean))
  ];
  if (uniqueCustomers.length === 0) {
    insights.customerName = insights.customerName ?? null;
  } else if (uniqueCustomers.length === 1) {
    insights.customerName = uniqueCustomers[0];
  } else {
    const createdNames = [
      ...new Set(created.map((request) => request.customerName).filter(Boolean))
    ];
    const names = createdNames.length ? createdNames : uniqueCustomers;
    insights.customerName =
      names.length <= 2 ? names.join(", ") : `${names[0]} +${names.length - 1} more`;
  }

  insights.stateActions = [
    ...new Set(insights.requests.flatMap((request) => request.stateActions))
  ];
}

function parseLogInsights(logText, config = null) {
  const insights = emptyInsights();
  if (!logText) return insights;

  const rules = config?.rules || [];
  const uiRules = config?.ui || [];
  insights.ui = uiRules;

  if (!rules.length) {
    return insights;
  }

  const scopeOpenRules = rules.filter((rule) => rule.kind === "scope_open");
  const scopeCloseRules = rules.filter((rule) => rule.kind === "scope_close");
  const fieldRules = rules.filter((rule) => rule.kind === "field");
  const stepRules = rules.filter((rule) => rule.kind === "step");
  const runFieldRules = rules.filter((rule) => rule.kind === "run_field");
  const summaryRules = rules.filter((rule) => rule.kind === "summary");

  const entities = [];
  const stack = [];
  let startTimeIso = null;
  let endTimeIso = null;

  const lines = logText.split(/\r?\n/);
  for (const line of lines) {
    const lineAtMs = parseJmeterLogTimestamp(line);

    for (const rule of scopeOpenRules) {
      if (!rule.match) continue;
      const match = line.match(rule.match);
      if (!match) continue;

      finalizeBeforeScopeOpen(rule.entity, rule.parent, entities, stack, insights);

      const ctx = buildRuleContext(null, match, insights);
      const indexRaw = rule.index ? renderTemplate(rule.index, ctx) : "";
      const totalRaw = rule.total ? renderTemplate(rule.total, ctx) : "";
      const index = indexRaw !== "" ? Number(indexRaw) : null;
      const total = totalRaw !== "" ? Number(totalRaw) : null;
      const parent = findParentEntity(entities, stack, rule, match);

      const entity = createEntity(rule.entity, {
        index: Number.isFinite(index) ? index : null,
        total: Number.isFinite(total) ? total : null,
        atMs: lineAtMs,
        parentId: parent?.id ?? null,
        status: rule.status || "started"
      });

      entities.push(entity);
      stack.push(entities.length - 1);

      if (rule.stepLabel) {
        pushStep(
          insights,
          renderTemplate(rule.stepLabel, buildRuleContext(entity, match, insights)),
          rule.stepStatus || "info",
          lineAtMs
        );
      }
      break;
    }

    for (const rule of scopeCloseRules) {
      if (!rule.match || !line.match(rule.match)) continue;
      finalizeKindFromStack(rule.entity, entities, stack, insights);
      continue;
    }

    for (const rule of runFieldRules) {
      if (!rule.match) continue;
      const match = line.match(rule.match);
      if (!match) continue;
      const fieldName = rule.set;
      if (!fieldName) continue;
      let value = rule.value;
      if (value == null && rule.template) {
        value = renderTemplate(rule.template, buildRuleContext(null, match));
      } else if (value == null && rule.group != null) {
        value = match[Number(rule.group)] ?? "";
      }
      insights[fieldName] = String(value).trim();

      if (fieldName === "startTime" && match[1] && match[2]) {
        startTimeIso = `${match[1]}T${match[2]}:00`;
      }
      if (fieldName === "endTime" && match[1] && match[2]) {
        endTimeIso = `${match[1]}T${match[2]}:00`;
      }
    }

    for (const rule of fieldRules) {
      if (!rule.match) continue;
      const match = line.match(rule.match);
      if (!match) continue;

      const entity = findScopedEntity(entities, stack, rule.entity, rule, match, insights);
      if (rule.entity !== "run" && !entity) continue;

      if (rule.entity === "run") {
        const fieldName = rule.set;
        if (!fieldName) continue;
        if (rule.onlyIfEmpty && insights[fieldName]) continue;
        let value = rule.value;
        if (value == null && rule.group != null) value = match[Number(rule.group)] ?? "";
        if (value == null && rule.template) {
          value = renderTemplate(rule.template, buildRuleContext(null, match));
        }
        insights[fieldName] = String(value).trim();
        continue;
      }

      applyFieldRule(entity, rule, match);

      if (rule.set === "startTime" && match[1] && match[2]) {
        startTimeIso = `${match[1]}T${match[2]}:00`;
      }
      if (rule.set === "endTime" && match[1] && match[2]) {
        endTimeIso = `${match[1]}T${match[2]}:00`;
      }
    }

    for (const rule of stepRules) {
      if (!rule.match || !line.match(rule.match)) continue;
      const match = line.match(rule.match);
      const scopedEntity = findScopedEntity(entities, stack, rule.scope, rule, match, insights);
      const ctx = buildRuleContext(scopedEntity, match, insights);
      const label = renderTemplate(rule.label, ctx);
      if (!label) continue;
      pushStep(insights, label, rule.status || "info", lineAtMs);
    }
  }

  while (stack.length) {
    const idx = stack.pop();
    finalizeEntity(entities[idx], insights);
  }

  applySummaries(insights, summaryRules);
  applyLegacyRequestMapping(insights);

  for (const entity of insights.entities) {
    delete entity._finalized;
  }

  if (insights.durationMinutes == null && startTimeIso && endTimeIso) {
    const startMs = Date.parse(startTimeIso);
    const endMs = Date.parse(endTimeIso);
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      insights.durationMinutes = Math.round((endMs - startMs) / 60000);
    }
  }

  return insights;
}

function normalizeInsightRules(config) {
  const rawRules = config?.rules || [];
  const ui = config?.ui || [];
  const rules = [];

  for (const raw of rawRules) {
    const kind = String(raw.kind || "").trim();
    const match = compileInsightMatch(raw.match);
    if (!match && kind !== "summary") continue;
    rules.push({ ...raw, match });
  }

  return { rules, ui };
}

module.exports = {
  INSIGHTS_UUID,
  parseLogInsights,
  normalizeInsightRules,
  emptyInsights,
  pushStep,
  compileInsightMatch
};
