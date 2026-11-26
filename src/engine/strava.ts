import type { RawPoint } from './parse';

// Lecture de activities.csv (export Strava) pour connaître le type de chaque sortie.

/** Découpe un CSV (guillemets, virgules et retours à la ligne dans les champs). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const base = (p: string) => p.split('/').pop() ?? p;

/** Nom de fichier (sans dossier) → type d'activité Strava ("Run", "Walk"…). */
export function activityTypes(csv: string): Map<string, string> {
  const rows = parseCsv(csv.replace(/^﻿/, ''));
  const out = new Map<string, string>();
  if (!rows.length) return out;
  const head = rows[0];
  const ti = head.indexOf('Activity Type');
  const fi = head.indexOf('Filename');
  if (ti < 0 || fi < 0) return out;
  for (const r of rows.slice(1)) if (r[fi]) out.set(base(r[fi]), r[ti]);
  return out;
}

/** Types retenus pour calibrer la course à pied. */
export const RUN_TYPES = new Set(['Run', 'Trail Run']);

export const fileBase = base;

// ---------- API Strava (version locale) ----------


/** Types d'activité de l'API Strava (champ sport_type) retenus pour la course à pied. */
export const API_RUN_TYPES = new Set(['Run', 'TrailRun']);

export interface StravaStreams {
  latlng?: { data: [number, number][] };
  altitude?: { data: number[] };
  time?: { data: number[] };
}

/**
 * Convertit les flux d'une activité Strava (requête streams avec key_by_type=true)
 * en points horodatés. `startMs` est la date de départ de l'activité (start_date).
 */
export function pointsFromStreams(startMs: number, streams: StravaStreams): RawPoint[] {
  const ll = streams.latlng?.data ?? [];
  const alt = streams.altitude?.data;
  const time = streams.time?.data;
  const out: RawPoint[] = [];
  for (let i = 0; i < ll.length; i++) {
    const [lat, lon] = ll[i];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      lat,
      lon,
      ele: alt && Number.isFinite(alt[i]) ? alt[i] : null,
      time: time && Number.isFinite(time[i]) ? startMs + time[i] * 1000 : null,
    });
  }
  return out;
}

export interface RateLimit {
  /** Requêtes autorisées sur 15 minutes et sur la journée. */
  limit15: number;
  limitDay: number;
  used15: number;
  usedDay: number;
}

/**
 * Lit les quotas renvoyés par Strava. Les en-têtes de lecture (x-readratelimit-*) sont
 * plus stricts que les en-têtes généraux : on garde le plus contraignant des deux.
 */
export function parseRateLimit(get: (name: string) => string | null): RateLimit | null {
  const pair = (s: string | null) => {
    const m = s ? s.split(',').map((x) => Number(x.trim())) : [];
    return m.length === 2 && m.every(Number.isFinite) ? (m as [number, number]) : null;
  };
  let best: RateLimit | null = null;
  for (const prefix of ['x-ratelimit', 'x-readratelimit']) {
    const lim = pair(get(`${prefix}-limit`));
    const use = pair(get(`${prefix}-usage`));
    if (!lim || !use) continue;
    const r = { limit15: lim[0], limitDay: lim[1], used15: use[0], usedDay: use[1] };
    const slack = (x: RateLimit) => Math.min(x.limit15 - x.used15, x.limitDay - x.usedDay);
    if (!best || slack(r) < slack(best)) best = r;
  }
  return best;
}

/** Début de la prochaine fenêtre de 15 minutes (Strava remet les compteurs à 0, 15, 30 et 45). */
export function nextQuarterHour(now: number): number {
  const q = 15 * 60_000;
  return Math.floor(now / q) * q + q;
}
