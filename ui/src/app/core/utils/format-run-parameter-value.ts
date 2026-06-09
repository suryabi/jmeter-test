import { ParameterDef } from '../models/runner.models';

const SENSITIVE_NAME_RE = /authorization|password|secret|token/i;

export function isSensitiveParameter(name: string): boolean {
  return SENSITIVE_NAME_RE.test(name);
}

export function maskSensitiveValue(name: string, value: string): string {
  if (!value) return value;
  if (!isSensitiveParameter(name)) return value;

  if (/^bearer\s+/i.test(value)) {
    const token = value.replace(/^bearer\s+/i, '').trim();
    if (token.length <= 12) return 'Bearer ••••••••';
    return `Bearer ${token.slice(0, 6)}…${token.slice(-4)}`;
  }

  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function formatRunParameterDisplayValue(param: ParameterDef | undefined, raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '—';

  if (param && isSensitiveParameter(param.name)) {
    return maskSensitiveValue(param.name, trimmed);
  }

  if (param?.type === 'boolean') {
    return trimmed === 'true' ? 'Enabled' : trimmed === 'false' ? 'Disabled' : trimmed;
  }

  return trimmed;
}
