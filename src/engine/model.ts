// Courbe vitesse/pente : un modèle générique, recalé sur l'historique du coureur.

import type { RawPoint } from './parse';
import { buildProfile } from './track';

export const GRADE_MIN = -0.4;
export const GRADE_MAX = 0.4;
export const BIN = 0.02;

/** Coût énergétique de la course selon la pente (Minetti et al. 2002), J/kg/m. */
export function minettiCost(i: number): number {
  return 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
}

/**
 * Vitesse relative à la vitesse sur le plat, pour une pente donnée (fraction : 0.1 = 10 %).
 * Montée : inverse du coût de Minetti, adouci (exposant 0.9) car on marche dans les fortes pentes.
 * Descente : gain plafonné à +10 % vers -8 %, puis ralentissement progressif (terrain technique, freinage).
 */
export function baselineFactor(g: number): number {
  const i = Math.max(-0.45, Math.min(0.45, g));
  if (i >= 0) return (minettiCost(0) / minettiCost(i)) ** 0.9;
  const a = -i;
  if (a <= 0.08) return 1 + 1.25 * a;
  return 1.1 - ((a - 0.08) / (0.4 - 0.08)) * (1.1 - 0.55);
}

export interface Curve {
  /** Centre de chaque classe de pente (fraction). */
  grades: number[];
  /** Vitesse en m/s pour chaque classe. */
  speeds: number[];
  /** Temps de données personnelles par classe, en secondes (0 pour la courbe générique). */
  samples: number[];
  /** Vitesse équivalente sur le plat, m/s. */
  flat: number;
  personal: boolean;
}

export function gradeBins(): number[] {
  const out: number[] = [];
  const n = Math.round((GRADE_MAX - GRADE_MIN) / BIN);
  for (let k = 0; k <= n; k++) out.push(Math.round((GRADE_MIN + k * BIN) * 1000) / 1000);
  return out;
}

export function baselineCurve(flat: number, baseline: (g: number) => number = baselineFactor): Curve {
  const grades = gradeBins();
  return { grades, speeds: grades.map((g) => flat * baseline(g)), samples: grades.map(() => 0), flat, personal: false };
}

/** Vitesse (m/s) pour une pente, par interpolation linéaire entre classes. */
export function speedAt(c: Curve, g: number): number {
  const { grades, speeds } = c;
  if (g <= grades[0]) return speeds[0];
  const last = grades.length - 1;
  if (g >= grades[last]) return speeds[last];
  const k = Math.min(last - 1, Math.floor((g - grades[0]) / BIN));
  const f = (g - grades[k]) / (grades[k + 1] - grades[k]);
  return speeds[k] + f * (speeds[k + 1] - speeds[k]);
}

export interface Sample {
  grade: number;
  speed: number;
  /** Durée en secondes. */
  dur: number;
  /** Début de la sortie (ms epoch), pour pondérer les sorties récentes. */
  when?: number;
}

export interface ActivitySummary {
  samples: Sample[];
  distance: number;
  duration: number;
  /** Début de la sortie (ms epoch), ou null si inconnu. */
  start: number | null;
  skipped: string | null;
}

const CHUNK = 100; // mètres par échantillon
const STEP = 25;

/** Découpe une sortie horodatée en morceaux de 100 m (pente, vitesse, durée), pauses exclues. */
export function samplesFromActivity(points: RawPoint[], opts: { keepWalks?: boolean } = {}): ActivitySummary {
  const start = points.find((pt) => pt.time != null)?.time ?? null;
  const empty = (skipped: string): ActivitySummary => ({ samples: [], distance: 0, duration: 0, start, skipped });
  if (points.length < 10) return empty('trop peu de points');
  let p;
  try {
    p = buildProfile(points, STEP, 100);
  } catch {
    return empty('trace trop courte');
  }
  if (!p.time) return empty('pas d’horodatage');
  if (!p.hasElevation) return empty('pas d’altitude');
  const t = p.time;
  const n = p.dist.length;
  const total = p.dist[n - 1];
  const moving = t[n - 1] - t[0];
  if (moving <= 0) return empty('horodatage invalide');
  if (total / moving > 6) return empty('trop rapide pour de la course à pied');

  const per = Math.round(CHUNK / STEP);
  const samples: Sample[] = [];
  let duration = 0;
  for (let i = 0; i + per < n; i += per) {
    let stopped = false;
    for (let k = i; k < i + per; k++) {
      const ds = p.dist[k + 1] - p.dist[k];
      const dt = t[k + 1] - t[k];
      if (dt <= 0 || ds / dt < 0.2) stopped = true;
    }
    if (stopped) continue;
    const d = p.dist[i + per] - p.dist[i];
    const dur = t[i + per] - t[i];
    const speed = d / dur;
    if (speed > 7) continue;
    samples.push({ grade: (p.ele[i + per] - p.ele[i]) / d, speed, dur, when: start ?? undefined });
    duration += dur;
  }
  if (!samples.length) return { samples, distance: total, duration, start, skipped: 'aucun passage exploitable' };
  if (!opts.keepWalks && looksLikeWalk(samples)) return { samples: [], distance: total, duration: 0, start, skipped: 'marche plutôt que course' };
  return { samples, distance: total, duration, start, skipped: null };
}

/** Vitesse médiane sur terrain roulant en dessous de laquelle une sortie est de la marche (1,8 m/s = 6,5 km/h). */
export const WALK_SPEED = 1.8;

/**
 * Une sortie étiquetée « course » peut être une marche ou une rando (erreur fréquente sur Strava).
 * On regarde la vitesse médiane sur les passages roulants (pente entre -5 et +5 %), là où un coureur court :
 * marcher dans les fortes montées, normal en trail, n'est donc pas pénalisé.
 */
export function looksLikeWalk(samples: Sample[]): boolean {
  const rolling = samples.filter((s) => Math.abs(s.grade) < 0.05);
  const secs = rolling.reduce((a, s) => a + s.dur, 0);
  if (secs < 5 * 60) return false;
  return weightedMedian(rolling.map((s) => s.speed), rolling.map((s) => s.dur)) < WALK_SPEED;
}

function weightedMedian(values: number[], weights: number[]): number {
  const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const half = weights.reduce((s, w) => s + w, 0) / 2;
  let acc = 0;
  for (const i of idx) {
    acc += weights[i];
    if (acc >= half) return values[i];
  }
  return values[idx[idx.length - 1]];
}

/** En dessous de ce volume total, l'historique est jugé insuffisant. */
export const MIN_MINUTES = 20;

export interface FitOptions {
  /** Minutes de données au-delà desquelles une classe fait davantage confiance aux données qu'au modèle. */
  priorMin?: number;
  /** Modèle générique utilisé comme a priori (vitesse relative au plat selon la pente). */
  baseline?: (g: number) => number;
  /** Demi-vie (jours) de la pondération des sorties récentes ; null = toutes les sorties comptent pareil. */
  halfLifeDays?: number | null;
  /** Date de référence (ms) pour la pondération ; par défaut la sortie la plus récente. */
  now?: number;
}

// Demi-vie de 60 jours : retenue sur un banc d'essai réel (scripts/backtest.ts), où elle réduit l'erreur
// de prédiction sur les sorties futures (4,8 % → 4,3 % d'erreur médiane) en suivant l'évolution de la forme.
export const DEFAULT_FIT: Required<Omit<FitOptions, 'now'>> = { priorMin: 10, baseline: baselineFactor, halfLifeDays: 60 };

/**
 * Recale la courbe sur l'historique :
 * 1. vitesse équivalente plat = médiane pondérée des vitesses sur le plat (ou de vitesse / facteur générique) ;
 * 2. pour chaque classe de pente, médiane pondérée des vitesses observées,
 *    mélangée avec le modèle générique selon le volume de données ;
 * 3. en montée, la vitesse ne peut pas remonter quand la pente augmente.
 */
export function fitCurve(samples: Sample[], options: FitOptions = {}): Curve | null {
  const { priorMin, baseline, halfLifeDays } = { ...DEFAULT_FIT, ...options };
  const total = samples.reduce((s, x) => s + x.dur, 0);
  if (total < MIN_MINUTES * 60) return null;

  // Poids = durée, éventuellement atténuée pour les sorties anciennes.
  let weight = (s: Sample) => s.dur;
  if (halfLifeDays) {
    const now = options.now ?? Math.max(...samples.map((s) => s.when ?? -Infinity));
    if (Number.isFinite(now)) {
      const k = Math.LN2 / (halfLifeDays * 86_400_000);
      weight = (s) => s.dur * (s.when != null ? Math.exp(-k * Math.max(0, now - s.when)) : 1);
    }
  }

  // Vitesse sur le plat : mesurée directement si on a assez de terrain plat,
  // sinon déduite de toutes les pentes via le modèle générique.
  const flatOnes = samples.filter((s) => Math.abs(s.grade) < 0.03);
  const useFlat = flatOnes.reduce((s, x) => s + x.dur, 0) >= priorMin * 60;
  const src = useFlat ? flatOnes : samples;
  const flat = weightedMedian(
    src.map((s) => s.speed / baseline(s.grade)),
    src.map(weight),
  );
  const grades = gradeBins();
  const speeds: number[] = [];
  const counts: number[] = [];
  for (const c of grades) {
    const inBin = samples.filter((s) => s.grade >= c - BIN / 2 && s.grade < c + BIN / 2);
    const secs = inBin.reduce((s, x) => s + x.dur, 0);
    const base = flat * baseline(c);
    counts.push(secs);
    if (secs === 0) {
      speeds.push(base);
      continue;
    }
    const w = inBin.map(weight);
    const obs = weightedMedian(inBin.map((s) => s.speed), w);
    // Le volume compte en minutes « effectives » (pondérées), comparé à l'a priori.
    const n = (w.reduce((a, b) => a + b, 0) / Math.max(1e-9, inBin.reduce((a, s) => a + s.dur, 0))) * (secs / 60);
    speeds.push((n * obs + priorMin * base) / (n + priorMin));
  }

  // Lissage léger (3 classes), puis contrainte de monotonie en montée.
  const sm = speeds.map((v, k) => {
    const a = speeds[Math.max(0, k - 1)];
    const b = speeds[Math.min(speeds.length - 1, k + 1)];
    return (a + 2 * v + b) / 4;
  });
  const zero = grades.findIndex((g) => Math.abs(g) < 1e-9);
  for (let k = zero + 1; k < sm.length; k++) sm[k] = Math.min(sm[k], sm[k - 1]);

  return { grades, speeds: sm, samples: counts, flat, personal: true };
}
