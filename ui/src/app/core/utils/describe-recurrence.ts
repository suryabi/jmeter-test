import { ScheduleRecurrence } from '../models/runner.models';

export function describeRecurrence(recurrence: ScheduleRecurrence | null | undefined): string {
  if (!recurrence) return '—';
  if (recurrence.type === 'once') return `Once at ${new Date(recurrence.at).toLocaleString()}`;
  if (recurrence.type === 'daily') return `Daily at ${recurrence.time}`;
  if (recurrence.type === 'cron') return `Cron: ${recurrence.expression}`;
  return '—';
}
