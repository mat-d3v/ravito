// Sauvegarde locale (dans ce navigateur uniquement) pour retrouver son plan à la visite suivante,
// par exemple quand l'export Strava arrive par e-mail quelques heures plus tard.

import type { Profile } from '../engine/track';
import type { Sample } from '../engine/model';

const KEY = 'ravito.state.v1';

export interface Saved {
  course: null | { name: string; profile: Profile };
  history: null | { samples: Sample[]; used: number; skipped: number; seconds: number };
  settings: Record<string, unknown>;
}

const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

function packProfile(p: Profile) {
  return {
    dist: Array.from(p.dist, (v) => r(v, 1)),
    ele: Array.from(p.ele, (v) => r(v, 1)),
    lat: Array.from(p.lat, (v) => r(v, 5)),
    lon: Array.from(p.lon, (v) => r(v, 5)),
    hasElevation: p.hasElevation,
  };
}

function unpackProfile(o: ReturnType<typeof packProfile>): Profile {
  return {
    dist: Float64Array.from(o.dist),
    ele: Float64Array.from(o.ele),
    lat: Float64Array.from(o.lat),
    lon: Float64Array.from(o.lon),
    time: null,
    hasElevation: o.hasElevation,
  };
}

export function save(s: Saved): void {
  try {
    const data = {
      course: s.course ? { name: s.course.name, profile: packProfile(s.course.profile) } : null,
      history: s.history
        ? {
            // Échantillons à plat : pente, vitesse, durée.
            s: s.history.samples.flatMap((x) => [r(x.grade, 4), r(x.speed, 3), r(x.dur, 1)]),
            used: s.history.used,
            skipped: s.history.skipped,
            seconds: s.history.seconds,
          }
        : null,
      settings: s.settings,
    };
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* stockage plein ou indisponible : on continue sans sauvegarde */
  }
}

export function load(): Saved | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    const samples: Sample[] = [];
    const flat: number[] = o.history?.s ?? [];
    for (let i = 0; i + 2 < flat.length; i += 3) samples.push({ grade: flat[i], speed: flat[i + 1], dur: flat[i + 2] });
    return {
      course: o.course ? { name: o.course.name, profile: unpackProfile(o.course.profile) } : null,
      history: o.history ? { samples, used: o.history.used, skipped: o.history.skipped, seconds: o.history.seconds } : null,
      settings: o.settings ?? {},
    };
  } catch {
    return null;
  }
}

export function clear(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* rien à faire */
  }
}
