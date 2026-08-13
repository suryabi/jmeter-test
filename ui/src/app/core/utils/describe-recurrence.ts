import { ScheduleRecurrence } from '../models/runner.models';

/** "HH:MM" UTC -> viewer's local wall-clock time, e.g. "2:30 PM", for display only. */
export function utcTimeToLocalLabel(time: string): string {
  const [hours, minutes] = String(time || '00:00')
    .split(':')
    .map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return '';
  const d = new Date();
  d.setUTCHours(hours, minutes, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function describeRecurrence(recurrence: ScheduleRecurrence | null | undefined): string {
  if (!recurrence) return '—';
  if (recurrence.type === 'once') return `Once at ${new Date(recurrence.at).toLocaleString()}`;
  if (recurrence.type === 'daily') {
    const local = utcTimeToLocalLabel(recurrence.time);
    return `Daily at ${recurrence.time} UTC${local ? ` (${local} local)` : ''}`;
  }
  if (recurrence.type === 'cron') return `Cron: ${recurrence.expression} (UTC)`;
  return '—';
}
