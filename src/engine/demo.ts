// Données de démonstration entièrement synthétiques : un parcours de montagne imaginaire
// et un coureur fictif. Aucune trace de course réelle n'est redistribuée.

import type { RawPoint } from './parse';
import { baselineFactor } from './model';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const M_PER_DEG_LAT = 111_195;

/** Avance le long d'un chemin sinueux et renvoie des points tous les `step` mètres. */
function walk(lengthM: number, step: number, ele: (x: number) => number, seed: number, lat0 = 45.9, lon0 = 6.9) {
  const rand = rng(seed);
  const pts: { lat: number; lon: number; ele: number; x: number }[] = [];
  let lat = lat0;
  let lon = lon0;
  const phase = rand() * 10;
  for (let x = 0; x <= lengthM; x += step) {
    pts.push({ lat, lon, ele: ele(x), x });
    const heading = Math.sin(x / 2300 + phase) * 1.6 + x / 9000;
    lat += (Math.cos(heading) * step) / M_PER_DEG_LAT;
    lon += (Math.sin(heading) * step) / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  }
  return pts;
}

export const DEMO_AID = [
  { name: 'Refuge des Aiguilles', km: 11.2 },
  { name: 'Col du Loup', km: 21.5 },
  { name: 'Chalet de la Combe', km: 32.4 },
];

function courseEle(x: number): number {
  const k = x / 1000;
  return 1050 + 420 * Math.sin((2 * Math.PI * k) / 15 - 1.2) + 160 * Math.sin((2 * Math.PI * k) / 5.6 + 0.6) + 45 * Math.sin((2 * Math.PI * k) / 1.9);
}

/** Parcours de démo au format GPX (le parcours passe par toute la chaîne d'import). */
export function demoCourseGPX(): string {
  const pts = walk(42_300, 15, courseEle, 7);
  const rand = rng(99);
  const trk = pts
    .map((p) => `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>${(p.ele + (rand() - 0.5) * 6).toFixed(1)}</ele></trkpt>`)
    .join('\n');
  const wpts = DEMO_AID.map((a) => {
    const p = pts[Math.round((a.km * 1000) / 15)];
    return `<wpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><name>${a.name}</name></wpt>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Ravito demo" xmlns="http://www.topografix.com/GPX/1/1">
${wpts}
<trk><name>Trail des Aiguilles (démo)</name><trkseg>
${trk}
</trkseg></trk></gpx>`;
}

/** Courbe « réelle » du coureur fictif : bon grimpeur, descendeur prudent. */
export function demoTrueFactor(g: number): number {
  return baselineFactor(g) * (g > 0 ? 1.15 : g < -0.06 ? 0.88 : 1);
}
export const DEMO_FLAT = 3.0; // m/s, soit 10,8 km/h

/** Sorties d'entraînement synthétiques et horodatées du coureur fictif. */
export function demoActivities(count = 14): RawPoint[][] {
  const rand = rng(2024);
  const out: RawPoint[][] = [];
  for (let a = 0; a < count; a++) {
    const len = 8000 + rand() * 18000;
    const amp = 80 + rand() * 380;
    const per = 2000 + rand() * 5000;
    const ph = rand() * 6;
    const ele = (x: number) => 600 + amp * Math.sin((2 * Math.PI * x) / per + ph) + 25 * Math.sin(x / 300);
    const pts = walk(len, 10, ele, 1000 + a);
    let t = Date.UTC(2026, 5, 1 + a * 3, 7, 0, 0);
    const track: RawPoint[] = [];
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) {
        const g = (pts[i].ele - pts[i - 1].ele) / 10;
        const v = DEMO_FLAT * demoTrueFactor(g) * (0.94 + rand() * 0.12);
        t += (10 / v) * 1000;
        // Une pause photo de temps en temps.
        if (rand() < 0.0008) t += 180_000;
      }
      track.push({ lat: pts[i].lat, lon: pts[i].lon, ele: pts[i].ele + (rand() - 0.5) * 4, time: t });
    }
    out.push(track);
  }
  return out;
}
