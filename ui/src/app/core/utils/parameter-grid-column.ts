import { ParameterDef } from '../models/runner.models';

export const DEFAULT_PARAMETER_COLS = 4;

/** Tailwind md:col-span-* classes (must be static for JIT). */
const MD_COL_SPAN_CLASS: Record<number, string> = {
  1: 'md:col-span-1',
  2: 'md:col-span-2',
  3: 'md:col-span-3',
  4: 'md:col-span-4',
  5: 'md:col-span-5',
  6: 'md:col-span-6',
  7: 'md:col-span-7',
  8: 'md:col-span-8',
  9: 'md:col-span-9',
  10: 'md:col-span-10',
  11: 'md:col-span-11',
  12: 'md:col-span-12'
};

export function parameterGridColumnClass(cols = DEFAULT_PARAMETER_COLS): string {
  const normalized = cols >= 1 && cols <= 12 ? cols : DEFAULT_PARAMETER_COLS;
  return `col-span-12 ${MD_COL_SPAN_CLASS[normalized]}`;
}

export function parameterFieldColumnClass(param: Pick<ParameterDef, 'cols'>): string {
  return parameterGridColumnClass(param.cols ?? DEFAULT_PARAMETER_COLS);
}
