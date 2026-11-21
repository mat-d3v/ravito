// Rééchantillonnage à pas fixe et lissage de l'altitude.
// C'est l'étape qui rend les pentes fiables : l'altitude GPS brute est bruitée,
// gonfle le D+ et fait osciller la pente d'un point à l'autre.

import type { RawPoint } from './parse';

export interface Profile {
  /** Distance cumulée en mètres à chaque point. */
  dist: Float64Array;
  /** Altitude lissée en mètres. */
  ele: Float64Array;
  lat: Float64Array;
  lon: Float64Array;
  /** Temps écoulé en secondes depuis le départ, ou null si la trace n'est pas horodatée. */
  time: Float64Array | null;
  hasElevation: boolean;
}

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Comble les altitudes manquantes par interpolation linéaire (sur la distance). */
function fillElevation(cum: number[], ele: (number | null)[]): { values: number[]; any: boolean } {
  const known = ele.map((e, i) => (e == null ? -1 : i)).filter((i) => i >= 0);
  if (known.length === 0) return { values: ele.map(() => 0), any: false };
  const values = new Array<number>(ele.length);
  let k = 0;
  for (let i = 0; i < ele.length; i++) {
    while (k < known.length - 1 && known[k + 1] <= i) k++;
    const a = known[k];
    const e = ele[i];
    if (e != null) values[i] = e;
    else if (i < known[0]) values[i] = ele[known[0]]!;
    else if (k === known.length - 1) values[i] = ele[a]!;
    else {
      const b = known[k + 1];
      const f = (cum[i] - cum[a]) / Math.max(1e-9, cum[b] - cum[a]);
      values[i] = ele[a]! + f * (ele[b]! - ele[a]!);
    }
  }
  return { values, any: true };
}

/**
 * Rééchantillonne une trace tous les `step` mètres (le dernier pas peut être plus court),
 * puis lisse l'altitude par moyenne glissante sur `smoothM` mètres.
 */
export function buildProfile(points: RawPoint[], step = 25, smoothM = 150): Profile {
  const pts = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (pts.length < 2) throw new Error('trace trop courte');

  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  if (total < step) throw new Error('trace trop courte');

  const { values: eleRaw, any } = fillElevation(cum, pts.map((p) => p.ele));
  const timed = pts.filter((p) => p.time != null).length >= pts.length * 0.8;
  const t0 = timed ? pts.find((p) => p.time != null)!.time! : 0;
  // Temps manquants : on reprend la valeur précédente connue.
  let lastT = t0;
  const tRaw = pts.map((p) => {
    if (p.time != null) lastT = p.time;
    return (lastT - t0) / 1000;
  });

  const n = Math.floor(total / step) + 1 + (total % step > 1e-6 ? 1 : 0);
  const dist = new Float64Array(n);
  const ele = new Float64Array(n);
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const time = timed ? new Float64Array(n) : null;

  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.min(i * step, total);
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const span = cum[j + 1] - cum[j];
    const f = span > 0 ? (d - cum[j]) / span : 0;
    dist[i] = d;
    ele[i] = eleRaw[j] + f * (eleRaw[j + 1] - eleRaw[j]);
    lat[i] = pts[j].lat + f * (pts[j + 1].lat - pts[j].lat);
    lon[i] = pts[j].lon + f * (pts[j + 1].lon - pts[j].lon);
    if (time) time[i] = tRaw[j] + f * (tRaw[j + 1] - tRaw[j]);
  }

  return { dist, ele: smooth(ele, Math.max(1, Math.round(smoothM / step))), lat, lon, time, hasElevation: any };
}

/** Moyenne glissante centrée sur `win` points (fenêtre réduite aux bords). */
export function smooth(values: Float64Array, win: number): Float64Array {
  const n = values.length;
  const half = Math.floor(win / 2);
  if (half < 1) return values.slice();
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + values[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    out[i] = (pre[b + 1] - pre[a]) / (b - a + 1);
  }
  return out;
}

export interface Stats {
  distance: number;
  gain: number;
  loss: number;
  minEle: number;
  maxEle: number;
}

export function stats(p: Profile, from = 0, to = p.dist.length - 1): Stats {
  // Seuil d'hystérésis : une variation n'est comptée qu'au-delà de 3 m,
  // pour ne pas additionner le bruit résiduel (pratique courante des montres et sites de course).
  const TH = 3;
  let gain = 0;
  let loss = 0;
  let minEle = Infinity;
  let maxEle = -Infinity;
  let ref = p.ele[from];
  for (let i = from; i <= to; i++) {
    minEle = Math.min(minEle, p.ele[i]);
    maxEle = Math.max(maxEle, p.ele[i]);
    const d = p.ele[i] - ref;
    if (d >= TH) {
      gain += d;
      ref = p.ele[i];
    } else if (d <= -TH) {
      loss -= d;
      ref = p.ele[i];
    }
  }
  const rest = p.ele[to] - ref;
  if (rest > 0) gain += rest;
  else loss -= rest;
  return { distance: p.dist[to] - p.dist[from], gain, loss, minEle, maxEle };
}

/** Indice du premier point situé à `meters` ou au-delà. */
export function indexAt(p: Profile, meters: number): number {
  let lo = 0;
  let hi = p.dist.length - 1;
  if (meters <= 0) return 0;
  if (meters >= p.dist[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p.dist[mid] < meters - 1e-6) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Distance (m) du point de la trace le plus proche d'une coordonnée, et l'écart en mètres. */
export function project(p: Profile, lat: number, lon: number): { dist: number; offset: number } {
  let best = Infinity;
  let at = 0;
  for (let i = 0; i < p.dist.length; i++) {
    const d = haversine({ lat, lon }, { lat: p.lat[i], lon: p.lon[i] });
    if (d < best) {
      best = d;
      at = p.dist[i];
    }
  }
  return { dist: at, offset: best };
}
