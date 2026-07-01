import { FieldOption, ParameterDef, RunProps } from '../models/runner.models';
import { formatRunParameterDisplayValue } from './format-run-parameter-value';

export function isApiOptionsField(param: ParameterDef): boolean {
  return (param.type === 'dropdown' || param.type === 'multiselect') && !!param.apiConfig;
}

export function apiDependenciesReady(param: ParameterDef, props: RunProps): boolean {
  const deps = param.apiConfig?.depends ?? [];
  return deps.every((dep) => String(props[dep] ?? '').trim());
}

export function findOptionLabel(options: FieldOption[], token: string): string | undefined {
  const needle = token.trim();
  if (!needle) return undefined;

  const normalized = needle.toLowerCase();
  const hit = options.find(
    (option) =>
      option.value === needle ||
      (option.value != null &&
        (option.value.toLowerCase() === normalized ||
          option.label.toLowerCase() === normalized ||
          option.label.toLowerCase().replace(/\s+/g, '') === normalized.replace(/\s+/g, '')))
  );

  return hit?.label;
}

export function resolveApiFieldDisplayValue(
  param: ParameterDef | undefined,
  raw: string,
  options: FieldOption[] | undefined
): string {
  const base = formatRunParameterDisplayValue(param, raw);
  if (base === '—' || !param || !isApiOptionsField(param) || !options?.length) {
    return base;
  }

  if (param.type === 'multiselect') {
    const values = raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (!values.length) return '—';
    return values.map((value) => findOptionLabel(options, value) ?? value).join(', ');
  }

  return findOptionLabel(options, raw) ?? base;
}
