import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Safe number formatting - returns '0' for NaN/null/undefined/Infinity */
export function fmtNum(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '0';
  return value.toLocaleString();
}

/** Safe percentage - returns '0%' for NaN/division by zero */
export function fmtPct(numerator: number | null | undefined, denominator: number | null | undefined): string {
  if (numerator == null || denominator == null || denominator === 0 || Number.isNaN(numerator) || Number.isNaN(denominator)) return '0%';
  return ((numerator / denominator) * 100).toFixed(1) + '%';
}
