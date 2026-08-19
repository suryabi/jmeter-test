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

/** UTC "HH:MM" -> local "HH:MM", for a two-way-editable local time input. */
export function utcTimeToLocalTimeValue(time: string): string {
  const [hours, minutes] = String(time || '00:00')
    .split(':')
    .map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return '00:00';
  const d = new Date();
  d.setUTCHours(hours, minutes, 0, 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Local "HH:MM" -> UTC "HH:MM" — inverse of utcTimeToLocalTimeValue. */
export function localTimeToUtcTimeValue(time: string): string {
  const [hours, minutes] = String(time || '00:00')
    .split(':')
    .map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return '00:00';
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** "HH:MM" -> a Date carrying just that hour/minute, for a PrimeNG timeOnly picker. */
export function timeStringToPickerDate(time: string): Date {
  const [hours, minutes] = String(time || '00:00')
    .split(':')
    .map(Number);
  const d = new Date();
  d.setHours(Number.isNaN(hours) ? 0 : hours, Number.isNaN(minutes) ? 0 : minutes, 0, 0);
  return d;
}

/** Inverse of timeStringToPickerDate: reads a timeOnly picker's hour/minute back out as "HH:MM". */
export function pickerDateToTimeString(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * A real UTC instant, "dressed" as a Date whose *local* getters (getFullYear/getHours/…)
 * equal the instant's UTC fields — so a datepicker (which always reads/writes local
 * getters) displays and edits it as if the picker itself were UTC.
 */
export function utcInstantToPickerDate(utcInstant: Date): Date {
  return new Date(
    utcInstant.getUTCFullYear(),
    utcInstant.getUTCMonth(),
    utcInstant.getUTCDate(),
    utcInstant.getUTCHours(),
    utcInstant.getUTCMinutes(),
    0,
    0
  );
}

/** Inverse of utcInstantToPickerDate: reads a picker's local fields back out as a real UTC instant. */
export function pickerDateToUtcInstant(pickerDate: Date): Date {
  return new Date(
    Date.UTC(
      pickerDate.getFullYear(),
      pickerDate.getMonth(),
      pickerDate.getDate(),
      pickerDate.getHours(),
      pickerDate.getMinutes(),
      0,
      0
    )
  );
}

export function describeRecurrence(recurrence: ScheduleRecurrence | null | undefined): string {
  if (!recurrence) return '—';
  if (recurrence.type === 'once') {
    const at = new Date(recurrence.at);
    return `Once at ${at.toLocaleString(undefined, {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })} UTC`;
  }
  if (recurrence.type === 'daily') {
    const local = utcTimeToLocalLabel(recurrence.time);
    return `Daily at ${recurrence.time} UTC${local ? ` (${local} local)` : ''}`;
  }
  if (recurrence.type === 'cron') return `Cron: ${recurrence.expression} (UTC)`;
  return '—';
}
