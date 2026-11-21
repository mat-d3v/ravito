// Banc d'essai du modèle sur un export Strava réel (dossier décompressé).
//
//   npx vite-node scripts/backtest.ts "<dossier de l'export Strava>"
//
// Pour chaque sortie de course à pied, on prédit son temps de déplacement à partir des AUTRES
// sorties (validation croisée « une sortie exclue »), puis à partir des seules sorties ANTÉRIEURES
// (situation réelle : on prépare une course avec ce qu'on a déjà couru). Le script n'affiche que
// des statistiques agrégées et n'écrit aucun fichier : les données restent où elles sont.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
// @ts-expect-error : la bibliothèque n'a pas de types
import FitParserModule from 'fit-file-parser';
import { parseTrackText, type RawPoint } from '../src/engine/parse';
import { activityTypes, RUN_TYPES } from '../src/engine/strava';
import { baselineCurve, fitCurve, looksLikeWalk, samplesFromActivity, speedAt, type Curve, type FitOptions, type Sample } from '../src/engine/model';
import { fatigue } from '../src/engine/plan';
import { BASELINES } from './baselines';

const dir = process.argv[2];
if (!dir || !existsSync(join(dir, 'activities'))) {
  console.error('Usage : npx vite-node scripts/backtest.ts "<dossier de l\'export Strava>"');
  process.exit(1);
}

const FitParser = FitParserModule.default ?? FitParserModule;

function readFit(buf: Buffer): Promise<RawPoint[]> {
  return new Promise((resolve) => {
    new FitParser({ force: true, mode: 'list', lengthUnit: 'm' }).parse(buf, (_e: unknown, d: { records?: Record<string, unknown>[] }) => {
      const pts: RawPoint[] = [];
      for (const r of d?.records ?? []) {
        if (typeof r.position_lat !== 'number' || typeof r.position_long !== 'number') continue;
        const ele = (r.enhanced_altitude ?? r.altitude) as number | undefined;
        pts.push({
          lat: r.position_lat,
          lon: r.position_long,
          ele: typeof ele === 'number' ? ele : null,
          time: r.timestamp ? new Date(r.timestamp as string).getTime() : null,
        });
      }
      resolve(pts);
    });
  });
}

interface Run {
  start: number;
  samples: Sample[];
  /** Temps de déplacement réel (s). */
  actual: number;
  /** D+ par km. */
  climbPerKm: number;
  /** Marche étiquetée « course » (exclue des sorties évaluées). */
  walk: boolean;
}

async function loadRuns(): Promise<Run[]> {
  const csvPath = join(dir, 'activities.csv');
  const types = existsSync(csvPath) ? activityTypes(readFileSync(csvPath, 'utf8')) : new Map<string, string>();
  const runs: Run[] = [];
  for (const f of readdirSync(join(dir, 'activities'))) {
    const type = types.get(f);
    if (types.size && (!type || !RUN_TYPES.has(type))) continue;
    let buf = readFileSync(join(dir, 'activities', f));
    let name = f;
    if (name.endsWith('.gz')) {
      buf = gunzipSync(buf);
      name = name.slice(0, -3);
    }
    let pts: RawPoint[];
    if (name.endsWith('.fit')) pts = await readFit(buf);
    else if (/\.(gpx|tcx)$/.test(name)) pts = parseTrackText(buf.toString('utf8')).points;
    else continue;
    const s = samplesFromActivity(pts, { keepWalks: true });
    if (!s.samples.length || s.start == null) continue;
    const dist = s.samples.reduce((a, x) => a + x.speed * x.dur, 0);
    const climb = s.samples.reduce((a, x) => a + Math.max(0, x.grade * x.speed * x.dur), 0);
    const actual = s.samples.reduce((a, x) => a + x.dur, 0);
    if (actual < 10 * 60) continue;
    runs.push({ start: s.start, samples: s.samples, actual, climbPerKm: climb / (dist / 1000), walk: looksLikeWalk(s.samples) });
  }
  return runs.sort((a, b) => a.start - b.start);
}

/** Temps prédit pour les mêmes morceaux de 100 m, avec la fatigue appliquée sur le temps prédit cumulé. */
function predict(run: Run, curve: Curve, beta: number, effort = 1): number {
  let t = 0;
  for (const s of run.samples) {
    const d = s.speed * s.dur;
    t += d / (speedAt(curve, s.grade) * effort * fatigue(t / 3600, beta));
  }
  return t;
}

interface Variant {
  name: string;
  fit: FitOptions;
  beta: number;
  /** Pas de recalage : courbe générique à la vitesse plat mesurée. */
  genericOnly?: boolean;
  /** Garder les marches étiquetées « course » dans l'historique d'apprentissage (ancien comportement). */
  trainOnWalks?: boolean;
}

function curveFor(train: Sample[], v: Variant, now: number): Curve | null {
  const fitted = fitCurve(train, { ...v.fit, now });
  if (!fitted) return null;
  return v.genericOnly ? baselineCurve(fitted.flat, v.fit.baseline) : fitted;
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} %`;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

function summarize(errs: { e: number; run: Run }[]) {
  const groups: [string, (r: Run) => boolean][] = [
    ['toutes', () => true],
    ['vallonnées (>20 m D+/km)', (r) => r.climbPerKm > 20],
    ['longues (>2 h)', (r) => r.actual > 7200],
  ];
  return groups.map(([label, keep]) => {
    const es = errs.filter((x) => keep(x.run)).map((x) => x.e);
    const abs = es.map(Math.abs);
    return { label, n: es.length, medAbs: median(abs), meanAbs: abs.reduce((a, b) => a + b, 0) / Math.max(1, abs.length), bias: median(es) };
  });
}

function evaluate(runs: Run[], v: Variant, mode: 'loo' | 'past') {
  const errs: { e: number; run: Run }[] = [];
  for (let i = 0; i < runs.length; i++) {
    if (runs[i].walk) continue; // on n'évalue que de vraies sorties de course
    const others = (mode === 'loo' ? runs.filter((_, j) => j !== i) : runs.slice(0, i)).filter((r) => v.trainOnWalks || !r.walk);
    const train = others.flatMap((r) => r.samples);
    const curve = curveFor(train, v, runs[i].start);
    if (!curve) continue;
    errs.push({ e: predict(runs[i], curve, v.beta) / runs[i].actual - 1, run: runs[i] });
  }
  return summarize(errs);
}

const runs = await loadRuns();
const hours = runs.reduce((a, r) => a + r.actual, 0) / 3600;
console.log(`${runs.length} sorties étiquetées course (dont ${runs.filter((r) => r.walk).length} marches), ${hours.toFixed(1)} h de déplacement, ` +
  `${runs.filter((r) => r.climbPerKm > 20).length} vallonnées, ${runs.filter((r) => r.actual > 7200).length} de plus de 2 h.\n`);

const base = { priorMin: 10, baseline: BASELINES.current, halfLifeDays: null } satisfies FitOptions;

// --detail : une ligne par sortie longue ou vallonnée (durée, distance, D+, vitesses), sans aucune position.
if (process.argv.includes('--detail')) {
  const all = runs.flatMap((r) => r.samples);
  for (const r of runs.filter((x) => x.actual > 7200 || x.climbPerKm > 20)) {
    const curve = fitCurve(runs.filter((x) => x !== r).flatMap((x) => x.samples), base)!;
    const km = r.samples.reduce((a, s) => a + s.speed * s.dur, 0) / 1000;
    const walk = r.samples.filter((s) => s.speed < 2).reduce((a, s) => a + s.dur, 0) / r.actual;
    console.log(
      `${(r.actual / 3600).toFixed(2)} h, ${km.toFixed(1)} km, ${r.climbPerKm.toFixed(0)} m D+/km, ` +
        `réel ${((km / r.actual) * 3600).toFixed(1)} km/h, prédit ${((km / predict(r, curve, 0.15)) * 3600).toFixed(1)} km/h, ` +
        `marche (<7,2 km/h) ${(walk * 100).toFixed(0)} %`,
    );
  }
  console.log(`(référence : ${all.length} morceaux de 100 m)\n`);
}
const ONLY = process.env.ONLY; // ex. ONLY=récence pour ne lancer que certaines variantes
const allVariants: Variant[] = [
  { name: 'avant : générique seul', fit: base, beta: 0.15, genericOnly: true, trainOnWalks: true },
  { name: 'avant : recalé, marches incluses', fit: base, beta: 0.15, trainOnWalks: true },
  { name: 'recalé, marches écartées', fit: base, beta: 0.15 },
  { name: 'nouveau modèle par défaut', fit: {}, beta: 0.15 },
  { name: 'descente type Strava', fit: { ...base, baseline: BASELINES.strava }, beta: 0.15 },
  { name: 'Ultrapacer', fit: { ...base, baseline: BASELINES.ultrapacer }, beta: 0.15 },
  { name: 'générique type Strava seul', fit: { ...base, baseline: BASELINES.strava }, beta: 0.15, genericOnly: true },
  { name: 'générique Ultrapacer seul', fit: { ...base, baseline: BASELINES.ultrapacer }, beta: 0.15, genericOnly: true },
  { name: 'K=5', fit: { ...base, priorMin: 5 }, beta: 0.15 },
  { name: 'K=20', fit: { ...base, priorMin: 20 }, beta: 0.15 },
  { name: 'récence 45 j', fit: { ...base, halfLifeDays: 45 }, beta: 0.15 },
  { name: 'récence 60 j', fit: { ...base, halfLifeDays: 60 }, beta: 0.15 },
  { name: 'récence 90 j', fit: { ...base, halfLifeDays: 90 }, beta: 0.15 },
  { name: 'récence 120 j', fit: { ...base, halfLifeDays: 120 }, beta: 0.15 },
  { name: 'récence 180 j', fit: { ...base, halfLifeDays: 180 }, beta: 0.15 },
  { name: 'récence 365 j', fit: { ...base, halfLifeDays: 365 }, beta: 0.15 },
  { name: 'β=0', fit: base, beta: 0 },
  { name: 'β=0.08', fit: base, beta: 0.08 },
  { name: 'β=0.25', fit: base, beta: 0.25 },
];
const variants = ONLY ? allVariants.filter((v) => v.name.includes(ONLY) || v.name.startsWith('recalé, marches') || v.name.startsWith('avant') || v.name.startsWith('nouveau')) : allVariants;

for (const mode of ['loo', 'past'] as const) {
  console.log(mode === 'loo' ? '== Une sortie exclue (prédite à partir de toutes les autres)' : '== Sorties antérieures seulement');
  console.log('variante'.padEnd(34), 'groupe'.padEnd(26), 'n'.padStart(4), 'erreur méd.'.padStart(12), 'erreur moy.'.padStart(12), 'biais méd.'.padStart(11));
  for (const v of variants) {
    for (const g of evaluate(runs, v, mode)) {
      if (!g.n) continue;
      console.log(v.name.padEnd(34), g.label.padEnd(26), String(g.n).padStart(4), pct(g.medAbs).padStart(12), pct(g.meanAbs).padStart(12), pct(g.bias).padStart(11));
    }
  }
  console.log();
}
