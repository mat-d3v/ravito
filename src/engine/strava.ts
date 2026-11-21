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
