import { describe, expect, it } from 'vitest';
import { parseGPX, parseTCX, type RawPoint } from './parse';
import { buildProfile, stats, project } from './track';
import { baselineCurve, baselineFactor, fitCurve, samplesFromActivity, speedAt } from './model';
import { buildPlan, fatigue, simulate, solveEffort } from './plan';
import { DEMO_AID, DEMO_FLAT, demoActivities, demoCourseGPX, demoTrueFactor } from './demo';

const M_PER_DEG = 111_195;

/** Ligne droite vers le nord, un point tous les `step` m, altitude donnée par `ele`. */
function line(lengthM: number, ele: (x: number) => number, step = 10, speed?: (g: number) => number): RawPoint[] {
  const pts: RawPoint[] = [];
  let t = 0;
  for (let x = 0; x <= lengthM; x += step) {
    if (speed && x > 0) t += step / speed((ele(x) - ele(x - step)) / step);
    pts.push({ lat: 45 + x / M_PER_DEG, lon: 6, ele: ele(x), time: speed ? t * 1000 : null });
  }
  return pts;
}

const opts = { effort: 1, endurance: 0, aid: [] };

describe('lecture des fichiers', () => {
  it('lit un GPX avec attributs dans le désordre, espaces de noms et waypoints', () => {
    const gpx = `<gpx:gpx><gpx:wpt lon="6.1" lat="45.1"><gpx:name>Ravito &amp; soupe</gpx:name></gpx:wpt>
      <gpx:trk><gpx:name>Ma course</gpx:name><gpx:trkseg>
      <gpx:trkpt lon="6.0" lat="45.0"><gpx:ele>1000</gpx:ele><gpx:time>2026-01-01T08:00:00Z</gpx:time></gpx:trkpt>
      <gpx:trkpt lat="45.001" lon="6.0"/>
      </gpx:trkseg></gpx:trk></gpx:gpx>`;
    const t = parseGPX(gpx);
    expect(t.name).toBe('Ma course');
    expect(t.points).toHaveLength(2);
    expect(t.points[0]).toEqual({ lat: 45, lon: 6, ele: 1000, time: Date.UTC(2026, 0, 1, 8) });
    expect(t.points[1].ele).toBeNull();
    expect(t.waypoints[0].name).toBe('Ravito & soupe');
  });

  it('lit un TCX', () => {
    const tcx = `<TrainingCenterDatabase><Activities><Activity><Lap><Track>
      <Trackpoint><Time>2026-01-01T08:00:00Z</Time><Position><LatitudeDegrees>45</LatitudeDegrees><LongitudeDegrees>6</LongitudeDegrees></Position><AltitudeMeters>500</AltitudeMeters></Trackpoint>
      <Trackpoint><Time>2026-01-01T08:00:05Z</Time><HeartRateBpm><Value>120</Value></HeartRateBpm></Trackpoint>
      </Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
    const t = parseTCX(tcx);
    expect(t.points).toHaveLength(1);
    expect(t.points[0].ele).toBe(500);
  });
});

describe('profil', () => {
  it('mesure correctement la distance', () => {
    const p = buildProfile(line(10_000, () => 0));
    expect(stats(p).distance).toBeCloseTo(10_000, -1);
  });

  it('le lissage enlève l’essentiel du D+ fantôme dû au bruit GPS', () => {
    let s = 1;
    const noise = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 8;
    const p = buildProfile(line(10_000, () => 1000 + noise(), 5));
    expect(stats(p).gain).toBeLessThan(40);
  });

  it('conserve le D+ d’une vraie montée', () => {
    const p = buildProfile(line(5000, (x) => x * 0.1));
    expect(stats(p).gain).toBeGreaterThan(480);
  });

  it('projette un waypoint sur la trace', () => {
    const p = buildProfile(line(5000, () => 0));
    const r = project(p, 45 + 2000 / M_PER_DEG, 6.0001);
    expect(r.dist).toBeCloseTo(2000, -2);
    expect(r.offset).toBeLessThan(20);
  });
});

describe('modèle vitesse/pente', () => {
  it('vaut 1 sur le plat', () => expect(baselineFactor(0)).toBeCloseTo(1, 6));

  it('ralentit toujours quand la montée s’accentue', () => {
    for (let g = 0; g < 0.4; g += 0.01) expect(baselineFactor(g + 0.01)).toBeLessThan(baselineFactor(g));
  });

  it('plafonne le gain en descente et ralentit dans les pentes raides', () => {
    for (let g = -0.4; g <= 0; g += 0.01) expect(baselineFactor(g)).toBeLessThanOrEqual(1.1 + 1e-9);
    expect(baselineFactor(-0.4)).toBeLessThan(baselineFactor(-0.1));
  });

  it('retrouve la courbe d’un coureur à partir de ses sorties', () => {
    const samples = demoActivities().flatMap((a) => samplesFromActivity(a).samples);
    const c = fitCurve(samples)!;
    expect(c).not.toBeNull();
    expect(c.flat).toBeGreaterThan(DEMO_FLAT * 0.9);
    expect(c.flat).toBeLessThan(DEMO_FLAT * 1.1);
    for (const g of [-0.12, -0.06, 0, 0.06, 0.12]) {
      expect(speedAt(c, g) / (DEMO_FLAT * demoTrueFactor(g))).toBeGreaterThan(0.9);
      expect(speedAt(c, g) / (DEMO_FLAT * demoTrueFactor(g))).toBeLessThan(1.1);
    }
  });

  it('ignore les pauses', () => {
    const pts = line(3000, () => 0, 10, () => 3);
    // pause de 10 minutes au milieu
    for (let i = 150; i < pts.length; i++) pts[i].time! += 600_000;
    const s = samplesFromActivity(pts);
    for (const x of s.samples) expect(x.speed).toBeGreaterThan(2.7);
  });

  it('écarte les sorties à vélo', () => {
    const s = samplesFromActivity(line(20_000, () => 0, 10, () => 9));
    expect(s.samples).toHaveLength(0);
    expect(s.skipped).toMatch(/rapide/);
  });

  it('refuse un historique trop maigre', () => {
    expect(fitCurve([{ grade: 0, speed: 3, dur: 600 }])).toBeNull();
  });
});

describe('simulation', () => {
  const flat = baselineCurve(3);

  it('sur le plat sans fatigue : temps = distance / vitesse', () => {
    const p = buildProfile(line(10_000, () => 0));
    expect(simulate(p, flat, opts).total).toBeCloseTo(10_000 / 3, -1);
  });

  it('la montée est plus lente que le plat', () => {
    const plat = simulate(buildProfile(line(5000, () => 0)), flat, opts).total;
    const montee = simulate(buildProfile(line(5000, (x) => x * 0.1)), flat, opts).total;
    expect(montee).toBeGreaterThan(plat * 1.3);
  });

  it('plus de sensibilité à la fatigue = plus lent, sans effet sur une sortie courte', () => {
    const long = buildProfile(line(80_000, () => 0));
    const a = simulate(long, flat, { ...opts, endurance: 0.05 }).total;
    const b = simulate(long, flat, { ...opts, endurance: 0.2 }).total;
    expect(b).toBeGreaterThan(a);
    expect(fatigue(1, 0.3)).toBe(1);
  });

  it('trouve l’effort qui donne le temps visé', () => {
    const p = buildProfile(line(20_000, (x) => 300 * Math.sin(x / 2000)));
    const e = solveEffort(p, flat, { endurance: 0.15, aid: [] }, 3 * 3600);
    expect(simulate(p, flat, { effort: e, endurance: 0.15, aid: [] }).total).toBeCloseTo(3 * 3600, -1);
  });

  it('ajoute les arrêts aux ravitos et calcule la marge sur la barrière', () => {
    const p = buildProfile(line(10_000, () => 0));
    const aid = [
      { name: 'B', km: 6, stopMin: 5, cutoffH: 0.5 },
      { name: 'A', km: 3, stopMin: 2, cutoffH: null },
    ];
    const plan = buildPlan(p, flat, { effort: 1, endurance: 0, aid });
    expect(plan.segments.map((s) => s.to)).toEqual(['A', 'B', 'Arrivée']);
    expect(plan.sim.total).toBeCloseTo(10_000 / 3 + 7 * 60, -1);
    expect(plan.segments[0].arrive).toBeCloseTo(1000, -1);
    expect(plan.segments[1].moving).toBeCloseTo(1000, -1);
    expect(plan.segments[1].margin).toBeCloseTo(1800 - (2000 + 120), -1);
    expect(plan.splits).toHaveLength(10);
    expect(plan.splits.at(-1)!.at).toBeCloseTo(plan.sim.total, 3);
  });
});

describe('démo', () => {
  it('le parcours de démo se lit et ressemble à un trail de montagne', () => {
    const t = parseGPX(demoCourseGPX());
    const p = buildProfile(t.points);
    const s = stats(p);
    expect(s.distance / 1000).toBeGreaterThan(41);
    expect(s.gain).toBeGreaterThan(1800);
    expect(s.gain).toBeLessThan(4000);
    expect(t.waypoints.map((w) => w.name)).toEqual(DEMO_AID.map((a) => a.name));
    expect(project(p, t.waypoints[1].lat, t.waypoints[1].lon).dist / 1000).toBeCloseTo(DEMO_AID[1].km, 0);
  });
});

describe('export Strava', () => {
  it('lit le type de chaque sortie dans activities.csv, malgré les champs entre guillemets', async () => {
    const { activityTypes } = await import('./strava');
    const csv = '﻿Activity ID,Activity Name,Activity Type,Activity Description,Filename\n' +
      '1,"Sortie, du matin",Run,"Ligne 1\nLigne ""2""",activities/1.fit.gz\n' +
      '2,Balade,Walk,,activities/2.gpx\n3,Tapis,Workout,,\n';
    const m = activityTypes(csv);
    expect(m.get('1.fit.gz')).toBe('Run');
    expect(m.get('2.gpx')).toBe('Walk');
    expect(m.size).toBe(2);
  });
});

describe('historique : marches et récence', () => {
  it('écarte une marche étiquetée « course », mais pas une sortie trail où l’on marche en montée', async () => {
    const { samplesFromActivity } = await import('./model');
    const walk = samplesFromActivity(line(6000, () => 0, 10, () => 1.4));
    expect(walk.samples).toHaveLength(0);
    expect(walk.skipped).toMatch(/marche/);
    // Montée raide marchée (0,8 m/s), puis replat couru (3 m/s) : c'est bien une sortie de course.
    const trail = samplesFromActivity(line(8000, (x) => (x < 3000 ? x * 0.2 : 600), 10, (g) => (g > 0.1 ? 0.8 : 3)));
    expect(trail.samples.length).toBeGreaterThan(0);
  });

  it('donne plus de poids aux sorties récentes', () => {
    const day = 86_400_000;
    const old = Array.from({ length: 60 }, () => ({ grade: 0, speed: 2.5, dur: 60, when: 0 }));
    const recent = Array.from({ length: 60 }, () => ({ grade: 0, speed: 3.2, dur: 60, when: 365 * day }));
    const c = fitCurve([...old, ...recent])!;
    expect(c.flat).toBeCloseTo(3.2, 1);
    const flatWeights = fitCurve([...old, ...recent], { halfLifeDays: null })!;
    expect(flatWeights.flat).toBeLessThan(3.2);
  });
});
