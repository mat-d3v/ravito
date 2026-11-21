// Modèles génériques candidats (vitesse relative au plat selon la pente, en fraction : 0.1 = 10 %).

import { baselineFactor, minettiCost } from '../src/engine/model';

const clamp = (g: number) => Math.max(-0.45, Math.min(0.45, g));
const uphillMinetti = (g: number) => (minettiCost(0) / minettiCost(g)) ** 0.9;

/**
 * Descente façon modèle Strava 2017 (fréquence cardiaque, 6 millions de sorties) :
 * vitesse maximale vers -9 % (allure × 0,88, soit vitesse × 1,136), retour à la vitesse du plat vers -18 %,
 * puis baisse continue sur la même pente (cohérent avec l'étude belge de 2026 : pic vers -8 %, chute au-delà).
 */
function stravaLike(g: number): number {
  const i = clamp(g);
  if (i >= 0) return uphillMinetti(i);
  const a = -i;
  const peak = 1 / 0.88;
  const slope = (peak - 1) / 0.09;
  return a <= 0.09 ? 1 + slope * a : Math.max(0.45, peak - slope * (a - 0.09));
}

/**
 * Ultrapacer : facteur d'allure = 0,0021·g² + 0,034·g + 1 (g en %), linéaire au-delà de -22 % et +16 %.
 * La vitesse relative est l'inverse du facteur d'allure.
 */
function ultrapacer(g: number): number {
  const p = clamp(g) * 100;
  const f = (x: number) => 0.0021 * x * x + 0.034 * x + 1;
  const df = (x: number) => 0.0042 * x + 0.034;
  let pace: number;
  if (p < -22) pace = f(-22) + df(-22) * (p + 22);
  else if (p > 16) pace = f(16) + df(16) * (p - 16);
  else pace = f(p);
  return 1 / Math.max(0.3, pace);
}

export const BASELINES = { current: baselineFactor, strava: stravaLike, ultrapacer };
