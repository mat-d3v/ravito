import { getLang, t } from './i18n';

/** 3725 s → "1:02" (h:mm). */
export function hm(sec: number): string {
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, '0')}`;
}

/** Durée signée : "+0:42" ou "−0:15". */
export function signedHm(sec: number): string {
  return (sec < 0 ? '−' : '+') + hm(Math.abs(sec));
}

/** Heure de passage : "14:05", ou "J+1 03:20" si on a changé de jour. */
export function clock(startMs: number, sec: number): string {
  const d = new Date(startMs + sec * 1000);
  const start = new Date(startMs);
  const day0 = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const day1 = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((day1 - day0) / 86_400_000);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return days > 0 ? `${t().day}+${days} ${hhmm}` : hhmm;
}

/** Allure en min/km à partir d'un temps (s) et d'une distance (km). */
export function pace(sec: number, km: number): string {
  if (km <= 0) return '–';
  const s = Math.round(sec / km);
  return `${Math.floor(s / 60)}'${String(s % 60).padStart(2, '0')}`;
}

const locale = () => (getLang() === 'fr' ? 'fr-FR' : 'en-GB');
export const num = (v: number, digits = 0) =>
  v.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const km1 = (km: number) => num(km, 1);
export const m0 = (m: number) => num(Math.round(m));

/** "6:30" ou "6h30" → secondes ; null si illisible. */
export function parseHm(s: string): number | null {
  const m = /^\s*(\d{1,3})\s*[:hH]\s*(\d{1,2})?\s*$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2] ?? 0) * 60;
}

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
