const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { CronExpressionParser } = require("cron-parser");

const TICK_MS = 30 * 1000;

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** yyyy-MM-dd in local time, matching the UI datepicker's dataType="string" format. */
function formatDateLocal(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Next UTC-wall-clock instant at HH:MM strictly after `after`.
 * `time` is stored/interpreted as UTC (not the server host's local timezone) so
 * behavior is identical regardless of where the Node process is deployed; the UI
 * converts to/from the viewer's local time at the edit/display boundary.
 */
function nextDailyOccurrence(time, after) {
  const [hours, minutes] = String(time || "00:00")
    .split(":")
    .map((part) => Number(part));
  const candidate = new Date(after);
  candidate.setUTCHours(hours || 0, minutes || 0, 0, 0);
  if (candidate <= after) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}

function isValidCronExpression(expression) {
  try {
    CronExpressionParser.parse(String(expression || ""), { tz: "UTC" });
    return true;
  } catch {
    return false;
  }
}

function computeNextRunAt(recurrence, after = new Date()) {
  if (!recurrence) return null;
  if (recurrence.type === "once") {
    const at = new Date(recurrence.at);
    return at > after ? at : null;
  }
  if (recurrence.type === "daily") {
    return nextDailyOccurrence(recurrence.time, after);
  }
  if (recurrence.type === "cron") {
    try {
      // Fields (e.g. "0 9 * * *") are evaluated as UTC, matching the "daily" convention
      // above — deployment-host-timezone-independent. The UI shows fired-run timestamps
      // in the viewer's local time, same as it does for "Next run"/"Last run" elsewhere.
      return CronExpressionParser.parse(recurrence.expression, { currentDate: after, tz: "UTC" })
        .next()
        .toDate();
    } catch {
      return null;
    }
  }
  return null;
}

function resolveScheduledProps(baseProps, rules) {
  const props = { ...(baseProps || {}) };
  const today = new Date();
  for (const rule of rules || []) {
    if (rule.type === "dateOffset") {
      props[rule.field] = formatDateLocal(addDays(today, Number(rule.days) || 0));
    }
  }
  return props;
}

function describeRecurrence(recurrence) {
  if (!recurrence) return "—";
  if (recurrence.type === "once") return `Once at ${new Date(recurrence.at).toLocaleString()}`;
  if (recurrence.type === "daily") return `Daily at ${recurrence.time}`;
  if (recurrence.type === "cron") return `Cron: ${recurrence.expression}`;
  return "—";
}

function createSchedulerStore(schedulesDir) {
  if (!fs.existsSync(schedulesDir)) {
    fs.mkdirSync(schedulesDir, { recursive: true });
  }

  function filePathFor(id) {
    return path.join(schedulesDir, `${id}.json`);
  }

  function listSchedules() {
    return fs
      .readdirSync(schedulesDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(schedulesDir, name), "utf-8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  function getSchedule(id) {
    const filePath = filePathFor(id);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      return null;
    }
  }

  function writeSchedule(schedule) {
    fs.writeFileSync(filePathFor(schedule.id), JSON.stringify(schedule, null, 2), "utf-8");
    return schedule;
  }

  function createSchedule({ label, planFile, baseProps, rules, recurrence }) {
    const now = new Date().toISOString();
    const schedule = {
      id: randomUUID(),
      label: label || "",
      planFile,
      baseProps: baseProps || {},
      rules: rules || [],
      recurrence,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      nextRunAt: computeNextRunAt(recurrence)?.toISOString() || null,
      lastRunAt: null,
      lastRunId: null,
      lastRunStatus: null
    };
    return writeSchedule(schedule);
  }

  function updateSchedule(id, patch) {
    const existing = getSchedule(id);
    if (!existing) return null;
    const next = { ...existing, ...patch, id: existing.id, updatedAt: new Date().toISOString() };
    if (patch.recurrence) {
      next.nextRunAt = computeNextRunAt(patch.recurrence)?.toISOString() || null;
    }
    return writeSchedule(next);
  }

  function deleteSchedule(id) {
    const filePath = filePathFor(id);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  return { listSchedules, getSchedule, writeSchedule, createSchedule, updateSchedule, deleteSchedule };
}

/**
 * Fires due schedules by delegating to the host's startRun(); the caller owns
 * run lifecycle/concurrency (isBusy mirrors the same guard used for manual runs).
 */
function startScheduler({ schedulesDir, startRun, isBusy }) {
  const store = createSchedulerStore(schedulesDir);

  function fireSchedule(schedule) {
    const props = resolveScheduledProps(schedule.baseProps, schedule.rules);
    const run = startRun({
      props,
      runLabel: schedule.label,
      planFile: schedule.planFile,
      source: "schedule",
      scheduleId: schedule.id
    });

    store.updateSchedule(schedule.id, { lastRunAt: new Date().toISOString(), lastRunId: run.id, lastRunStatus: "running" });

    const finalize = () => {
      const current = store.getSchedule(schedule.id);
      if (!current) return;
      const nextAfter = new Date();

      let nextRunAt = current.nextRunAt;
      let enabled = current.enabled;
      if (current.recurrence?.type === "daily" || current.recurrence?.type === "cron") {
        nextRunAt = computeNextRunAt(current.recurrence, nextAfter)?.toISOString() || null;
      } else if (current.recurrence?.type === "once") {
        // Only consume a "once" schedule once its actual scheduled time has passed —
        // an early "run now" test-fire must not cancel the real future run.
        const due = new Date(current.recurrence.at) <= nextAfter;
        if (due) {
          nextRunAt = null;
          enabled = false;
        }
      }

      store.updateSchedule(schedule.id, { lastRunStatus: run.status, nextRunAt, enabled });
    };

    if (run.process) {
      run.process.once("close", finalize);
    } else {
      finalize();
    }

    return run;
  }

  function runScheduleNow(id) {
    const schedule = store.getSchedule(id);
    if (!schedule) throw new Error("Schedule not found");
    return fireSchedule(schedule);
  }

  function tick() {
    const now = new Date();
    for (const schedule of store.listSchedules()) {
      if (!schedule.enabled || !schedule.nextRunAt) continue;
      if (new Date(schedule.nextRunAt) > now) continue;
      if (isBusy()) continue; // retried next tick
      try {
        fireSchedule(schedule);
      } catch (err) {
        console.error(`[scheduler] Failed to fire schedule ${schedule.id}: ${err.message || err}`);
      }
    }
  }

  // If the server was down when a schedule was due, that occurrence is skipped (not
  // fired late) — just move it forward to its next natural occurrence. A "once"
  // schedule that's now overdue has no future occurrence, so it's disabled instead.
  function skipOverdueSchedules() {
    const now = new Date();
    for (const schedule of store.listSchedules()) {
      if (!schedule.enabled || !schedule.nextRunAt) continue;
      if (new Date(schedule.nextRunAt) > now) continue;
      if (schedule.recurrence?.type === "once") {
        store.updateSchedule(schedule.id, { nextRunAt: null, enabled: false });
      } else {
        store.updateSchedule(schedule.id, {
          nextRunAt: computeNextRunAt(schedule.recurrence, now)?.toISOString() || null
        });
      }
    }
  }

  skipOverdueSchedules();
  setInterval(tick, TICK_MS);

  return {
    listSchedules: store.listSchedules,
    getSchedule: store.getSchedule,
    createSchedule: store.createSchedule,
    updateSchedule: store.updateSchedule,
    deleteSchedule: store.deleteSchedule,
    runScheduleNow
  };
}

module.exports = {
  startScheduler,
  computeNextRunAt,
  resolveScheduledProps,
  describeRecurrence,
  formatDateLocal,
  isValidCronExpression
};
