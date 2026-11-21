// Simulation de la course point par point : pente, fatigue, arrêts aux ravitos.

import { speedAt, type Curve } from './model';
import { indexAt, stats, type Profile } from './track';

export interface AidStation {
  name: string;
  /** Position en kilomètres depuis le départ. */
  km: number;
  /** Temps d'arrêt prévu, en minutes. */
  stopMin: number;
  /** Barrière horaire en heures depuis le départ, ou null. */
  cutoffH: number | null;
}

export interface PlanOptions {
  /** Multiplicateur d'allure : 1 = l'allure de tes sorties, 1.1 = 10 % plus vite. */
  effort: number;
  /** Sensibilité à la fatigue : 0 = aucune baisse, 0.15 = défaut, 0.3 = forte. */
  endurance: number;
  aid: AidStation[];
}

/** Durée (h) en deçà de laquelle on considère que tes sorties d'entraînement incluent déjà la fatigue. */
const FATIGUE_REF_H = 1.5;

/** Multiplicateur de vitesse après `hours` heures d'effort. */
export function fatigue(hours: number, beta: number): number {
  if (hours <= FATIGUE_REF_H || beta <= 0) return 1;
  return ((1 + hours) / (1 + FATIGUE_REF_H)) ** -beta;
}

export interface Simulation {
  /** Temps (s) au passage de chaque point, arrêts précédents compris. */
  times: Float64Array;
  /** Index du point de chaque ravito (dans l'ordre de `aid` trié). */
  aidIndex: number[];
  /** Heure d'arrivée (s) à chaque ravito, avant l'arrêt. */
  arrive: number[];
  total: number;
}

function sortedAid(course: Profile, aid: AidStation[]): AidStation[] {
  const max = course.dist[course.dist.length - 1] / 1000;
  return aid.filter((a) => a.km > 0 && a.km < max).sort((a, b) => a.km - b.km);
}

export function simulate(course: Profile, curve: Curve, opts: PlanOptions): Simulation {
  const aid = sortedAid(course, opts.aid);
  const aidIndex = aid.map((a) => indexAt(course, a.km * 1000));
  const n = course.dist.length;
  const times = new Float64Array(n);
  const arrive: number[] = [];
  let t = 0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const d = course.dist[i] - course.dist[i - 1];
      const g = d > 0 ? (course.ele[i] - course.ele[i - 1]) / d : 0;
      const v = speedAt(curve, g) * opts.effort * fatigue(t / 3600, opts.endurance);
      t += d / Math.max(0.05, v);
    }
    while (next < aidIndex.length && aidIndex[next] === i) {
      arrive.push(t);
      t += aid[next].stopMin * 60;
      next++;
    }
    times[i] = t;
  }
  return { times, aidIndex, arrive, total: t };
}

/** Trouve l'effort qui donne le temps total visé (en secondes), par dichotomie. */
export function solveEffort(course: Profile, curve: Curve, opts: Omit<PlanOptions, 'effort'>, targetSec: number): number {
  let lo = 0.2;
  let hi = 4;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    const total = simulate(course, curve, { ...opts, effort: mid }).total;
    if (total > targetSec) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface Segment {
  from: string;
  to: string;
  km0: number;
  km1: number;
  gain: number;
  loss: number;
  /** Temps de déplacement sur le tronçon (s), sans l'arrêt. */
  moving: number;
  /** Arrivée au point d'arrivée du tronçon (s depuis le départ). */
  arrive: number;
  /** Arrêt prévu au point d'arrivée (s). */
  stop: number;
  cutoff: number | null;
  /** Marge sur la barrière (s), négative si dépassée. */
  margin: number | null;
}

export interface Split {
  km: number;
  /** Temps du kilomètre (s), arrêts compris. */
  sec: number;
  /** Temps cumulé à la fin du kilomètre (s). */
  at: number;
  gain: number;
  loss: number;
}

export interface Plan {
  sim: Simulation;
  segments: Segment[];
  splits: Split[];
  effort: number;
}

export function buildPlan(course: Profile, curve: Curve, opts: PlanOptions, startName = 'Départ', finishName = 'Arrivée'): Plan {
  const sim = simulate(course, curve, opts);
  const aid = sortedAid(course, opts.aid);
  const last = course.dist.length - 1;

  const points = [
    { name: startName, idx: 0, arrive: 0, stop: 0, cutoff: null as number | null },
    ...aid.map((a, k) => ({ name: a.name, idx: sim.aidIndex[k], arrive: sim.arrive[k], stop: a.stopMin * 60, cutoff: a.cutoffH })),
    { name: finishName, idx: last, arrive: sim.total, stop: 0, cutoff: null },
  ];
  const segments: Segment[] = [];
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    const s = stats(course, a.idx, b.idx);
    const cutoff = b.cutoff != null ? b.cutoff * 3600 : null;
    segments.push({
      from: a.name,
      to: b.name,
      km0: course.dist[a.idx] / 1000,
      km1: course.dist[b.idx] / 1000,
      gain: s.gain,
      loss: s.loss,
      moving: b.arrive - (a.arrive + a.stop),
      arrive: b.arrive,
      stop: b.stop,
      cutoff,
      margin: cutoff != null ? cutoff - b.arrive : null,
    });
  }

  const splits: Split[] = [];
  const total = course.dist[last];
  let prevIdx = 0;
  let prevT = 0;
  for (let km = 1; prevIdx < last; km++) {
    // Un reliquat de moins de 100 m est rattaché au dernier kilomètre.
    const idx = km * 1000 >= total - 100 ? last : indexAt(course, km * 1000);
    const s = stats(course, prevIdx, idx);
    const at = sim.times[idx];
    splits.push({ km: course.dist[idx] / 1000, sec: at - prevT, at, gain: s.gain, loss: s.loss });
    prevIdx = idx;
    prevT = at;
  }

  return { sim, segments, splits, effort: opts.effort };
}
