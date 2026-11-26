import '@fontsource/barlow/400.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import './style.css';
import { parseGPX, type Waypoint } from './engine/parse';
import { buildProfile, project, stats, type Profile } from './engine/track';
import { baselineCurve, fitCurve, samplesFromActivity, type Curve, type Sample } from './engine/model';
import { buildPlan, solveEffort, type AidStation, type Plan } from './engine/plan';
import { demoActivities, demoCourseGPX } from './engine/demo';
import { RUN_TYPES } from './engine/strava';
import { readTrackFiles } from './ui/files';
import { curveChart, profileChart } from './ui/charts';
import { clock, esc, hm, km1, m0, num, pace, parseHm, signedHm } from './ui/format';
import { getLang, setLang, t } from './ui/i18n';
import * as store from './ui/store';

interface AidRow {
  name: string;
  km: number;
  stopMin: number;
  /** Heure d'horloge "HH:MM" de la barrière, ou "". */
  cutoff: string;
}

const state = {
  course: null as null | { name: string; profile: Profile },
  history: null as null | { samples: Sample[]; used: number; skipped: number; seconds: number },
  /** Temps de référence sur route, utilisé tant qu'on n'a pas de sorties. */
  refKm: 10,
  refTime: '0:55',
  start: defaultStart(),
  mode: 'predict' as 'predict' | 'target',
  effort: 1,
  target: '6:00',
  endurance: 0.15,
  aid: [] as AidRow[],
  busy: '' as '' | 'course' | 'history',
  error: '',
};

function defaultStart(): string {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T07:00`;
}

const app = document.querySelector<HTMLDivElement>('#app')!;

// ---------- Calculs ----------

// La courbe perso ne change qu'avec l'historique : on la garde en cache (les curseurs recalculent souvent).
let fitted: { key: unknown; n: number; curve: Curve | null } | null = null;

function curve(): Curve {
  if (state.history) {
    const h = state.history;
    if (!fitted || fitted.key !== h || fitted.n !== h.samples.length) fitted = { key: h, n: h.samples.length, curve: fitCurve(h.samples) };
    if (fitted.curve) return fitted.curve;
  }
  return baselineCurve(refFlatSpeed());
}

/**
 * Vitesse sur le plat (m/s) déduite d'un temps de référence sur route.
 * La loi de Riegel (T ∝ D^1.06) ramène cette vitesse à un effort d'environ 1 h 30,
 * durée à partir de laquelle le modèle de fatigue prend le relais.
 */
function refFlatSpeed(): number {
  const sec = parseHm(state.refTime) ?? 3300;
  const v = (state.refKm * 1000) / Math.max(600, sec);
  return v * Math.pow(sec / 5400, 1 - 1 / 1.06);
}

/** Convertit les barrières "HH:MM" en heures depuis le départ, chacune après la précédente. */
function aidStations(): AidStation[] {
  const startMs = new Date(state.start).getTime();
  const sorted = [...state.aid].sort((a, b) => a.km - b.km);
  let prev = startMs;
  return sorted.map((a) => {
    let cutoffH: number | null = null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(a.cutoff.trim());
    if (m) {
      const d = new Date(prev);
      d.setHours(Number(m[1]), Number(m[2]), 0, 0);
      while (d.getTime() <= prev) d.setDate(d.getDate() + 1);
      prev = d.getTime();
      cutoffH = (d.getTime() - startMs) / 3_600_000;
    }
    return { name: a.name || '?', km: a.km, stopMin: a.stopMin, cutoffH };
  });
}

function computePlan(): Plan | null {
  if (!state.course) return null;
  const c = curve();
  const base = { endurance: state.endurance, aid: aidStations() };
  let effort = state.effort;
  if (state.mode === 'target') {
    const target = parseHm(state.target);
    if (target) effort = solveEffort(state.course.profile, c, base, target);
  }
  return buildPlan(state.course.profile, c, { ...base, effort }, t().start0, t().finish);
}

// ---------- Chargements ----------

function setCourse(name: string, points: Parameters<typeof buildProfile>[0], waypoints: Waypoint[]) {
  const profile = buildProfile(points);
  state.course = { name, profile };
  const total = profile.dist[profile.dist.length - 1];
  state.aid = waypoints
    .map((w) => ({ w, p: project(profile, w.lat, w.lon) }))
    .filter(({ p }) => p.offset < 250 && p.dist > 200 && p.dist < total - 200)
    .sort((a, b) => a.p.dist - b.p.dist)
    .map(({ w, p }) => ({ name: w.name, km: Math.round(p.dist / 100) / 10, stopMin: 5, cutoff: '' }));
  const s = stats(profile);
  state.target = hm(((s.distance / 1000 + s.gain / 100) / 6.5) * 3600);
}

async function loadCourse(files: File[]) {
  state.busy = 'course';
  state.error = '';
  render();
  const { tracks } = await readTrackFiles(files.filter((f) => !/\.(zip|csv)$/i.test(f.name)).slice(0, 1));
  state.busy = '';
  const tr = tracks[0];
  try {
    if (!tr) throw new Error();
    setCourse(tr.track.name ?? tr.file.replace(/\.[^.]+$/, ''), tr.track.points, tr.track.waypoints);
  } catch {
    state.error = t().fileError;
  }
  render();
}

async function loadHistory(files: File[]) {
  state.busy = 'history';
  render();
  const { tracks } = await readTrackFiles(files, (d, n) => {
    const el = document.querySelector('#hist-progress');
    if (el) el.textContent = `${t().reading} ${d} / ${n}`;
  });
  // Avec activities.csv (export Strava), on ne garde que la course à pied : marche, rando et vélo fausseraient la courbe.
  const runs = tracks.filter((x) => !x.type || RUN_TYPES.has(x.type));
  // Les plus récentes d'abord, 200 sorties maximum.
  const firstTime = (pts: { time: number | null }[]) => pts.find((p) => p.time != null)?.time ?? 0;
  runs.sort((a, b) => firstTime(b.track.points) - firstTime(a.track.points));
  addHistory(runs.slice(0, 200).map((x) => x.track.points));
  state.history!.skipped += tracks.length - runs.length;
  state.busy = '';
  render();
}

function addHistory(list: Parameters<typeof samplesFromActivity>[0][]) {
  const h = state.history ?? { samples: [], used: 0, skipped: 0, seconds: 0 };
  for (const pts of list) {
    const s = samplesFromActivity(pts);
    if (s.samples.length) {
      h.samples.push(...s.samples);
      h.used++;
      h.seconds += s.duration;
    } else h.skipped++;
  }
  state.history = h;
}

function loadDemo() {
  const g = parseGPX(demoCourseGPX());
  setCourse(t().demoName, g.points, g.waypoints);
  state.aid[1].cutoff = '12:30';
  state.aid[2].cutoff = '15:30';
  state.history = null;
  state.error = '';
  addHistory(demoActivities());
  render();
}

// ---------- Strava (version locale, `npm run strava`) ----------

/** Vrai quand Ravito est servi par le serveur local Strava (scripts/strava.ts). */
const STRAVA_LOCAL = new URLSearchParams(location.search).get('strava') === 'local';

interface StravaStatus {
  connected: boolean;
  athlete: string | null;
  state: 'idle' | 'syncing' | 'ready' | 'error';
  done: number;
  total: number;
  waitUntil: number;
  error: string;
}

let strava: StravaStatus | null = null;
let stravaLoaded = false;
let stravaUnreachable = false;
const stravaDenied = new URLSearchParams(location.search).has('strava_error');

function stravaBoxHtml(): string {
  const T = t();
  if (stravaUnreachable) return `<p class="warn">${esc(T.stravaError)}</p><button class="secondary" id="strava-retry">${esc(T.stravaRetry)}</button>`;
  if (!strava) return `<p class="hint">${esc(T.stravaListing)}</p>`;
  if (!strava.connected)
    return `${stravaDenied ? `<p class="warn">${esc(T.stravaDenied)}</p>` : ''}
      <a class="strava-connect" href="/strava/login">${esc(T.stravaConnect)}</a>
      <p class="hint">${esc(T.stravaIntro)}</p>`;
  if (strava.state === 'syncing') {
    const paused = strava.waitUntil > Date.now()
      ? `<p class="hint">${esc(T.stravaPaused(new Date(strava.waitUntil).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' })))}</p>`
      : '';
    return strava.total
      ? `<p>${esc(T.stravaSyncing(strava.done, strava.total))}</p><progress max="${strava.total}" value="${strava.done}"></progress>${paused}`
      : `<p>${esc(T.stravaListing)}</p>${paused}`;
  }
  if (strava.state === 'error') return `<p class="warn">${esc(T.stravaError)}</p><button class="secondary" id="strava-refresh">${esc(T.stravaRetry)}</button>`;
  if (strava.state === 'ready') return `<p>${esc(T.stravaReady(strava.athlete))}</p><button class="secondary" id="strava-refresh">${esc(T.stravaRefresh)}</button>`;
  return `<p class="hint">${esc(T.stravaListing)}</p>`;
}

/** Met à jour le seul bloc Strava (sans reconstruire la page, pour ne pas perdre le focus). */
function paintStravaBox() {
  const box = document.querySelector('#strava-box');
  if (!box) return;
  box.innerHTML = stravaBoxHtml();
  document.querySelector('#strava-refresh')?.addEventListener('click', async () => {
    stravaLoaded = false;
    await fetch('/strava/sync', { method: 'POST' }).catch(() => undefined);
    pollStrava();
  });
  document.querySelector('#strava-retry')?.addEventListener('click', () => {
    stravaUnreachable = false;
    pollStrava();
  });
}

let pollTimer = 0;
async function pollStrava() {
  clearTimeout(pollTimer);
  try {
    const res = await fetch('/strava/status', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    strava = (await res.json()) as StravaStatus;
    stravaUnreachable = false;
  } catch {
    stravaUnreachable = true;
    paintStravaBox();
    return;
  }
  if (strava.state === 'ready' && !stravaLoaded) {
    const res = await fetch('/strava/samples', { cache: 'no-store' }).catch(() => null);
    if (res?.ok) {
      const data = (await res.json()) as NonNullable<typeof state.history>;
      state.history = { samples: data.samples, used: data.used, skipped: data.skipped, seconds: data.seconds };
      stravaLoaded = true;
      render();
      scheduleSave();
    }
  }
  paintStravaBox();
  // On interroge souvent pendant le téléchargement, et pas du tout une fois les sorties chargées.
  if (strava.state === 'syncing' || (strava.state === 'ready' && !stravaLoaded)) pollTimer = window.setTimeout(pollStrava, 1500);
  else if (!strava.connected) pollTimer = window.setTimeout(pollStrava, 5000);
}

// ---------- Rendu ----------

/** Silhouette de montagne en pointillés pour la zone de dépôt du parcours. */
const REF_DISTANCES = [
  { km: 5, label: () => '5 km' },
  { km: 10, label: () => '10 km' },
  { km: 21.0975, label: () => t().half },
  { km: 42.195, label: () => t().marathon },
];

const EMPTY_RIDGE = `<svg class="ridge" viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true">
  <path d="M0 110 L60 96 L95 70 L130 82 L180 34 L215 52 L250 44 L300 92 L345 78 L380 40 L410 12 L445 48 L490 60 L530 86 L600 104"/></svg>`;

function render() {
  const T = t();
  const plan = computePlan();
  const c = curve();
  const startMs = new Date(state.start).getTime();
  const cs = state.course ? stats(state.course.profile) : null;

  app.innerHTML = `
  <header class="masthead">
    <a class="wordmark" href="./"><img src="${import.meta.env.BASE_URL}logo.svg" alt="" width="30" height="30">Ravito</a>
    <button class="lang" id="lang" lang="${getLang() === 'fr' ? 'en' : 'fr'}">${getLang() === 'fr' ? 'English' : 'Français'}</button>
  </header>

  ${
    state.course && cs
      ? `<section class="course" aria-labelledby="race-name">
          <div class="course-head">
            <h1 id="race-name">${esc(state.course.name)}</h1>
            <button class="quiet" id="clear-course">${esc(T.changeCourse)}</button>
          </div>
          <p class="facts"><span><b>${km1(cs.distance / 1000)}</b> km</span><span><b>+${m0(cs.gain)}</b> m</span><span><b>−${m0(cs.loss)}</b> m</span><span><b>${m0(cs.maxEle)}</b> m ${esc(T.max)}</span></p>
          <div id="profile" class="profile"></div>
        </section>`
      : `<section class="intro">
          <h1>${esc(T.title)}</h1>
          <p class="lede">${esc(T.intro)}</p>
          <label class="drop drop-course${state.busy === 'course' ? ' busy' : ''}" id="drop-course">
            <input type="file" accept=".gpx,.tcx,.fit,.gz" class="visually-hidden">
            ${EMPTY_RIDGE}
            <span class="drop-title">${esc(T.dropCourse)}</span>
            <span class="drop-hint">${esc(T.dropCourseHint)}</span>
          </label>
          ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ''}
          <p class="aside">${esc(T.demoPrefix)} <button class="textbtn" id="demo">${esc(T.demo)}</button></p>
          <p class="privacy">${esc(T.privacy)}</p>
        </section>`
  }

  <div class="workspace">
    <section class="plan" id="plan" aria-labelledby="h-plan">${plan ? planHtml(plan, startMs) : `<h2 id="h-plan">${esc(T.planTitle)}</h2><p class="hint">${esc(T.planEmpty)}</p>`}</section>

    <div class="settings">
      <section aria-labelledby="h-history">
        <h2 id="h-history">${esc(T.historyTitle)}</h2>
        <p class="hint">${esc(T.historyHint)}</p>
        ${STRAVA_LOCAL ? `<div id="strava-box" class="strava-box" aria-live="polite">${stravaBoxHtml()}</div>` : ''}
        <details class="how">
          <summary>${esc(T.exportHow)}</summary>
          <ol>${T.exportSteps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
          <p><a href="https://www.strava.com/account" target="_blank" rel="noopener noreferrer">${esc(T.exportLink)}</a><br><a href="https://support.strava.com/en-us/articles/15401919-how-do-i-export-my-strava-data" target="_blank" rel="noopener noreferrer">${esc(T.exportHelp)}</a></p>
        </details>
        <label class="drop drop-small${state.busy === 'history' ? ' busy' : ''}" id="drop-history">
          <input type="file" accept=".gpx,.tcx,.fit,.gz,.zip,.csv" multiple class="visually-hidden">
          <span id="hist-progress">${esc(state.busy === 'history' ? T.reading : T.dropHistory)}</span>
        </label>
        ${
          state.history
            ? `<p class="summary">${esc(T.historySummary(state.history.used, num(state.history.seconds / 3600, 1), state.history.skipped))}
                ${c.personal ? esc(T.flatMeasured(num(c.flat * 3.6, 1))) : ''}
                <button class="textbtn" id="clear-history">${esc(T.removeHistory)}</button></p>
               ${c.personal ? '' : `<p class="warn">${esc(T.notEnough)}</p>`}`
            : ''
        }
        ${
          !c.personal
            ? `<p class="hint">${esc(T.noHistory)}</p>
               <div class="ref">
                 <label class="field"><span>${esc(T.refDist)}</span>
                   <select id="ref-km">${REF_DISTANCES.map((d) => `<option value="${d.km}" ${d.km === state.refKm ? 'selected' : ''}>${esc(d.label())}</option>`).join('')}</select></label>
                 <label class="field"><span>${esc(T.refTime)}</span><input type="text" id="ref-time" value="${esc(state.refTime)}" inputmode="numeric" placeholder="0:55" size="6"></label>
               </div>
               <p class="hint">${esc(T.flatMeasured(num(c.flat * 3.6, 1)))}</p>`
            : ''
        }
        <h3>${esc(T.curveTitle)}</h3>
        <div id="curve" class="curve"></div>
      </section>

      <section aria-labelledby="h-race">
        <h2 id="h-race">${esc(T.raceTitle)}</h2>
        <label class="field"><span>${esc(T.start)}</span><input type="datetime-local" id="start" value="${state.start}"></label>
        <fieldset class="modes">
          <legend class="visually-hidden">${esc(T.raceTitle)}</legend>
          <label><input type="radio" name="mode" value="predict" ${state.mode === 'predict' ? 'checked' : ''}><span>${esc(T.modePredict)}</span></label>
          <label><input type="radio" name="mode" value="target" ${state.mode === 'target' ? 'checked' : ''}><span>${esc(T.modeTarget)}</span></label>
        </fieldset>
        ${
          state.mode === 'predict'
            ? `<label class="field"><span>${esc(T.effort)} <output id="effort-val">${Math.round(state.effort * 100)} %</output></span>
                 <input type="range" id="effort" min="0.8" max="1.25" step="0.01" value="${state.effort}" aria-valuetext="${Math.round(state.effort * 100)} %"></label>`
            : `<label class="field"><span>${esc(T.target)}</span><input type="text" id="target" value="${esc(state.target)}" inputmode="numeric" placeholder="6:30" size="6"></label>`
        }
        <label class="field"><span>${esc(T.endurance)} <output id="endu-val">${enduranceLabel()}</output></span>
          <input type="range" id="endurance" min="0" max="0.3" step="0.01" value="${state.endurance}" aria-valuetext="${enduranceLabel()}"></label>
      </section>

      <section aria-labelledby="h-aid">
        <h2 id="h-aid">${esc(T.aidTitle)}</h2>
        ${
          state.aid.length
            ? `<table class="aid-table">
                <thead><tr><th scope="col">${esc(T.aidName)}</th><th scope="col">${esc(T.aidKm)}</th><th scope="col">${esc(T.aidStop)}</th><th scope="col">${esc(T.aidCutoff)}</th><th><span class="visually-hidden">${esc(T.remove)}</span></th></tr></thead>
                <tbody>${state.aid
                  .map(
                    (a, i) => `<tr data-i="${i}">
                    <td><input data-k="name" value="${esc(a.name)}" aria-label="${esc(T.aidName)} ${i + 1}"></td>
                    <td><input data-k="km" type="number" step="0.1" min="0" value="${a.km}" aria-label="${esc(T.aidKm)} ${i + 1}"></td>
                    <td><input data-k="stopMin" type="number" step="1" min="0" value="${a.stopMin}" aria-label="${esc(T.aidStop)} ${i + 1}"></td>
                    <td><input data-k="cutoff" type="time" value="${esc(a.cutoff)}" aria-label="${esc(T.aidCutoff)} ${i + 1}"></td>
                    <td><button class="remove" data-del="${i}" aria-label="${esc(T.remove)} ${esc(a.name)}">×</button></td></tr>`,
                  )
                  .join('')}</tbody>
              </table>`
            : `<p class="hint">${esc(T.aidEmpty)}</p>`
        }
        <button class="textbtn" id="add-aid">${esc(T.addAid)}</button>
      </section>
    </div>

  </div>

  <footer>
    <p>${esc(T.model)}</p>
    <p>${esc(T.saved)} <button class="textbtn quiet-btn" id="reset">${esc(T.reset)}</button></p>
    <p>${esc(T.footer)} <a href="https://github.com/mat-d3v/ravito">${esc(T.source)}</a></p>
  </footer>
  <div class="dropover" id="dropover" hidden>
    <div class="dropover-zone" data-target="course"><b>${esc(T.overCourse)}</b><span>${esc(T.overCourseSub)}</span></div>
    <div class="dropover-zone" data-target="history"><b>${esc(T.overRuns)}</b><span>${esc(T.overRunsSub)}</span></div>
  </div>
  ${plan ? bandHtml(plan, startMs) : ''}`;

  if (state.course) profileChart(document.querySelector('#profile')!, state.course.profile, plan, startMs);
  curveChart(document.querySelector('#curve')!, c, baselineCurve(c.flat));
  bind(plan, startMs);
  scheduleSave();
}

function enduranceLabel() {
  const e = state.endurance;
  return e < 0.1 ? t().enduranceLow : e > 0.2 ? t().enduranceHigh : t().enduranceMid;
}

function planHtml(plan: Plan, startMs: number): string {
  const T = t();
  const total = plan.sim.total;
  const stops = plan.segments.reduce((s, x) => s + x.stop, 0);
  const rows = plan.segments
    .map((s, k) => {
      const late = s.margin != null && s.margin < 0;
      const last = k === plan.segments.length - 1;
      return `<tr class="${late ? 'late' : ''}${last ? ' finish' : ''}">
        <th scope="row">${last ? '' : `<span class="num-plate">${k + 1}</span>`}${esc(s.to)}</th>
        <td data-label="${esc(T.km)}" class="n">${km1(s.km1)}</td>
        <td data-label="${esc(T.climb)}" class="n">+${m0(s.gain)} / −${m0(s.loss)}</td>
        <td data-label="${esc(T.leg)}" class="n">${hm(s.moving)}</td>
        <td data-label="${esc(T.arrival)}" class="n eta"><span>${clock(startMs, s.arrive)}<small>${hm(s.arrive)}</small></span></td>
        <td data-label="${esc(T.stop)}" class="n">${s.stop ? hm(s.stop) : '–'}</td>
        <td data-label="${esc(T.cutoff)}" class="n">${s.cutoff != null ? clock(startMs, s.cutoff) : '–'}</td>
        <td data-label="${esc(T.margin)}" class="n${s.margin != null ? ' margin' : ''}">${s.margin != null ? (late ? `${signedHm(s.margin)}, ${esc(T.late)}` : signedHm(s.margin)) : '–'}</td>
      </tr>`;
    })
    .join('');
  const splits = plan.splits
    .map(
      (s, i) => `<tr><th scope="row" class="n">${km1(s.km)}</th><td class="n">${pace(s.sec, s.km - (plan.splits[i - 1]?.km ?? 0))}</td>
      <td class="n">+${m0(s.gain)} / −${m0(s.loss)}</td><td class="n">${hm(s.at)}</td><td class="n">${clock(startMs, s.at)}</td></tr>`,
    )
    .join('');
  return `<h2 id="h-plan" class="visually-hidden">${esc(T.planTitle)}</h2>
    <div class="bib">
      <p class="bib-label">${esc(T.finishAt)}</p>
      <p class="bib-time">${clock(startMs, total)}</p>
      <p class="bib-sub">${esc(T.totalTime(hm(total), hm(stops)))}</p>
    </div>
    <p class="hint effort-used">${esc(T.effortUsed(Math.round(plan.effort * 100), curve().personal))}</p>
    ${curve().personal ? '' : `<p class="nudge">${esc(T.nudgeBefore)} <button class="textbtn" id="goto-history">${esc(T.nudgeAction)}</button> ${esc(T.nudgeAfter)}</p>`}
    <h3 class="roadbook-title" id="roadbook-cap">${esc(T.roadbook)}</h3>
    <div class="table-wrap" tabindex="0" role="region" aria-labelledby="roadbook-cap">
      <table class="roadbook" aria-labelledby="roadbook-cap">
        <thead><tr><th scope="col">${esc(T.section)}</th><th scope="col" class="n">${esc(T.km)}</th><th scope="col" class="n">${esc(T.climb)}</th><th scope="col" class="n">${esc(T.leg)}</th><th scope="col" class="n">${esc(T.arrival)}</th><th scope="col" class="n">${esc(T.stop)}</th><th scope="col" class="n">${esc(T.cutoff)}</th><th scope="col" class="n">${esc(T.margin)}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="actions"><button id="print">${esc(T.printBand)}</button><button class="secondary" id="csv">${esc(T.exportCsv)}</button></div>
    <details><summary>${esc(T.splits)}</summary><div class="table-wrap" tabindex="0" role="region" aria-label="${esc(T.splits)}"><table class="splits">
      <thead><tr><th scope="col" class="n">${esc(T.km)}</th><th scope="col" class="n">${esc(T.pace)}</th><th scope="col" class="n">${esc(T.climb)}</th><th scope="col" class="n">${esc(T.elapsed)}</th><th scope="col" class="n">${esc(T.arrival)}</th></tr></thead>
      <tbody>${splits}</tbody></table></div></details>`;
}

/** Bracelet à imprimer : visible uniquement à l'impression. */
function bandHtml(plan: Plan, startMs: number): string {
  const T = t();
  const rows = plan.segments
    .map(
      (s) => `<tr><td>${esc(s.to)}</td><td>${km1(s.km1)}</td><td>+${m0(s.gain)}</td><td><b>${clock(startMs, s.arrive)}</b></td><td>${s.cutoff != null ? clock(startMs, s.cutoff) : ''}</td></tr>`,
    )
    .join('');
  return `<div id="band"><p class="band-title">${esc(state.course?.name ?? '')}</p><p class="band-sub">${esc(T.start)} ${clock(startMs, 0)}, ${esc(T.finish).toLowerCase()} ${clock(startMs, plan.sim.total)}</p>
    <table><thead><tr><th></th><th>km</th><th>D+</th><th>${esc(T.arrival)}</th><th>${esc(T.cutoff)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function exportCsv(plan: Plan, startMs: number) {
  const T = t();
  const lines = [[T.section, 'km', 'D+', 'D-', T.leg, T.arrival, T.stop, T.cutoff, T.margin].join(';')];
  for (const s of plan.segments)
    lines.push(
      [s.to, km1(s.km1), Math.round(s.gain), Math.round(s.loss), hm(s.moving), clock(startMs, s.arrive), hm(s.stop), s.cutoff != null ? clock(startMs, s.cutoff) : '', s.margin != null ? signedHm(s.margin) : '']
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(';'),
    );
  lines.push('', ['km', T.elapsed, T.arrival].join(';'));
  for (const s of plan.splits) lines.push([km1(s.km), hm(s.at), clock(startMs, s.at)].join(';'));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ravito-${(state.course?.name ?? 'plan').replace(/[^\w-]+/g, '_')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- Événements ----------

function wireDrop(id: string, onFiles: (f: File[]) => void) {
  const el = document.getElementById(id);
  if (!el) return;
  const input = el.querySelector('input')!;
  input.addEventListener('change', () => input.files?.length && onFiles([...input.files]));
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.classList.add('over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('over');
    hideOverlay();
    const files = await filesFromDrop(e);
    if (files.length) onFiles(files);
  });
}

/** Fichiers d'un dépôt, dossiers compris. Les entrées doivent être lues pendant l'événement, avant tout await. */
function filesFromDrop(e: DragEvent): Promise<File[]> {
  const entries = [...(e.dataTransfer?.items ?? [])].map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
  return entries.length ? filesFromEntries(entries) : Promise.resolve([...(e.dataTransfer?.files ?? [])]);
}

// Dépôt n'importe où sur la page : un panneau propose les deux destinations.
let dragDepth = 0;
const overlay = () => document.getElementById('dropover');
function hideOverlay() {
  dragDepth = 0;
  const o = overlay();
  if (o) o.hidden = true;
}
function wireOverlay() {
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    const o = overlay();
    if (o) o.hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideOverlay();
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.querySelectorAll('.dropover-zone').forEach((z) => z.classList.toggle('over', z.contains(e.target as Node)));
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const zone = (e.target as HTMLElement).closest<HTMLElement>('.dropover-zone');
    const files = await filesFromDrop(e);
    hideOverlay();
    if (!zone || !files.length) return;
    if (zone.dataset.target === 'course') loadCourse(files);
    else loadHistory(files);
  });
}

const WANTED = /\.(gpx|tcx|fit|gz|zip)$|(^|\/)activities\.csv$/i;

/** Parcourt récursivement les dossiers déposés (export Strava déjà décompressé, par exemple). */
async function filesFromEntries(entries: FileSystemEntry[]): Promise<File[]> {
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      if (WANTED.test(entry.name)) out.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
    } else if (entry.isDirectory) {
      if (/^(media|clubs|routes)$/i.test(entry.name)) return;
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries renvoie les entrées par paquets : on boucle jusqu'à un paquet vide.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const b of batch) await walk(b);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

/** Recalcule seulement le plan et le profil, sans reconstruire les champs (garde le focus). */
function refreshPlan() {
  const plan = computePlan();
  const startMs = new Date(state.start).getTime();
  const el = document.querySelector('#plan')!;
  if (!plan) return;
  const open = el.querySelector('details')?.open;
  el.innerHTML = planHtml(plan, startMs);
  if (open) el.querySelector('details')!.open = true;
  document.querySelector('#band')?.remove();
  app.insertAdjacentHTML('beforeend', bandHtml(plan, startMs));
  if (state.course) profileChart(document.querySelector('#profile')!, state.course.profile, plan, startMs);
  bindPlan(plan, startMs);
  scheduleSave();
}

function bindPlan(plan: Plan, startMs: number) {
  document.querySelector('#csv')?.addEventListener('click', () => exportCsv(plan, startMs));
  document.querySelector('#print')?.addEventListener('click', () => window.print());
  document.querySelector('#goto-history')?.addEventListener('click', () => {
    const zone = document.querySelector<HTMLElement>('#drop-history');
    zone?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    zone?.querySelector('input')?.focus();
  });
}

// ---------- Sauvegarde locale ----------

const SETTINGS = ['refKm', 'refTime', 'start', 'mode', 'effort', 'target', 'endurance', 'aid'] as const;
let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const settings: Record<string, unknown> = {};
    for (const k of SETTINGS) settings[k] = state[k];
    store.save({ course: state.course, history: state.history, settings });
  }, 400);
}

function restore() {
  const saved = store.load();
  if (!saved) return;
  state.course = saved.course;
  state.history = saved.history;
  const st = saved.settings as Partial<typeof state>;
  for (const k of SETTINGS) if (st[k] !== undefined) (state as Record<string, unknown>)[k] = st[k];
}

/** Remplissage de la piste des curseurs (WebKit n'a pas d'équivalent à ::-moz-range-progress). */
function syncSlider(s: HTMLInputElement) {
  s.style.setProperty('--min', s.min || '0');
  s.style.setProperty('--max', s.max || '100');
  s.style.setProperty('--val', s.value);
}

function bind(plan: Plan | null, startMs: number) {
  const $ = <E extends HTMLElement>(s: string) => document.querySelector<E>(s);
  $('#demo')?.addEventListener('click', loadDemo);
  $('#lang')?.addEventListener('click', () => {
    setLang(getLang() === 'fr' ? 'en' : 'fr');
    document.documentElement.lang = getLang();
    render();
  });
  wireDrop('drop-course', loadCourse);
  wireDrop('drop-history', loadHistory);
  $('#clear-course')?.addEventListener('click', () => {
    state.course = null;
    state.aid = [];
    render();
  });
  $('#clear-history')?.addEventListener('click', () => {
    state.history = null;
    render();
  });
  $<HTMLSelectElement>('#ref-km')?.addEventListener('change', (e) => {
    state.refKm = Number((e.target as HTMLSelectElement).value);
    render();
    $<HTMLSelectElement>('#ref-km')?.focus();
  });
  $<HTMLInputElement>('#ref-time')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLInputElement).value;
    if (parseHm(v)) state.refTime = v.trim();
    render();
    $<HTMLInputElement>('#ref-time')?.focus();
  });
  $('#reset')?.addEventListener('click', () => {
    if (!confirm(t().resetConfirm)) return;
    store.clear();
    state.course = null;
    state.history = null;
    state.aid = [];
    render();
  });
  $<HTMLInputElement>('#start')?.addEventListener('change', (e) => {
    state.start = (e.target as HTMLInputElement).value || state.start;
    refreshPlan();
  });
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) =>
    r.addEventListener('change', () => {
      const p = computePlan();
      // En changeant de mode, on repart de la valeur que donne l'autre mode.
      if (r.value === 'target' && p) state.target = hm(p.sim.total);
      if (r.value === 'predict' && p) state.effort = Math.round(p.effort * 100) / 100;
      state.mode = r.value as 'predict' | 'target';
      render();
      $<HTMLInputElement>(`input[name="mode"][value="${state.mode}"]`)?.focus();
    }),
  );
  document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(syncSlider);
  $<HTMLInputElement>('#effort')?.addEventListener('input', (e) => {
    const s = e.target as HTMLInputElement;
    state.effort = Number(s.value);
    const v = `${Math.round(state.effort * 100)} %`;
    $('#effort-val')!.textContent = v;
    s.setAttribute('aria-valuetext', v);
    syncSlider(s);
    refreshPlan();
  });
  $<HTMLInputElement>('#target')?.addEventListener('input', (e) => {
    state.target = (e.target as HTMLInputElement).value;
    if (parseHm(state.target)) refreshPlan();
  });
  $<HTMLInputElement>('#endurance')?.addEventListener('input', (e) => {
    const s = e.target as HTMLInputElement;
    state.endurance = Number(s.value);
    $('#endu-val')!.textContent = enduranceLabel();
    s.setAttribute('aria-valuetext', enduranceLabel());
    syncSlider(s);
    refreshPlan();
  });
  document.querySelectorAll<HTMLInputElement>('.aid-table input').forEach((inp) =>
    inp.addEventListener('change', () => {
      const i = Number(inp.closest('tr')!.dataset.i);
      const k = inp.dataset.k as keyof AidRow;
      const row = state.aid[i];
      if (k === 'name' || k === 'cutoff') row[k] = inp.value;
      else row[k] = Math.max(0, Number(inp.value) || 0);
      if (k === 'km') {
        state.aid.sort((a, b) => a.km - b.km);
        render();
      } else refreshPlan();
    }),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) =>
    b.addEventListener('click', () => {
      state.aid.splice(Number(b.dataset.del), 1);
      render();
    }),
  );
  $('#add-aid')?.addEventListener('click', () => {
    const total = state.course ? state.course.profile.dist[state.course.profile.dist.length - 1] / 1000 : 10;
    const lastKm = state.aid.at(-1)?.km ?? 0;
    state.aid.push({ name: `${t().section} ${state.aid.length + 1}`, km: Math.round(Math.min(total - 0.5, lastKm + 10) * 10) / 10, stopMin: 5, cutoff: '' });
    render();
    document.querySelector<HTMLInputElement>(`.aid-table tr[data-i="${state.aid.length - 1}"] input`)?.focus();
  });
  if (plan) bindPlan(plan, startMs);
  paintStravaBox();
}

// ?lang=fr|en force la langue, ?demo charge directement la démo (lien partageable).
const params = new URLSearchParams(location.search);
const langParam = params.get('lang');
if (langParam === 'fr' || langParam === 'en') setLang(langParam);
document.documentElement.lang = getLang();
if (params.has('demo')) loadDemo();
else {
  restore();
  render();
}
wireOverlay();
if (STRAVA_LOCAL) pollStrava();
