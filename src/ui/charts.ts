// Graphiques en SVG, sans bibliothèque. Ils sont dessinés à la largeur réelle du conteneur
// (et redessinés quand elle change) pour que le texte garde sa taille sur téléphone.

import type { Curve } from '../engine/model';
import type { Profile } from '../engine/track';
import type { Plan } from '../engine/plan';
import { clock, esc, hm, km1, m0 } from './format';
import { t } from './i18n';

function niceStep(range: number, target: number): number {
  const raw = range / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

let measureCtx: CanvasRenderingContext2D | null = null;
/** Largeur d'un texte des panneaux (600 12px Barlow), pour éviter les chevauchements. */
function textWidth(s: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return s.length * 6.6;
  measureCtx.font = "600 12px Barlow, 'Helvetica Neue', Arial, sans-serif";
  return measureCtx.measureText(s).width;
}

const observed = new WeakMap<HTMLElement, () => void>();
const ro = new ResizeObserver((entries) => {
  for (const e of entries) observed.get(e.target as HTMLElement)?.();
});

/** Dessine maintenant, puis à chaque changement de largeur du conteneur. */
function responsive(el: HTMLElement, draw: (width: number) => void) {
  let last = 0;
  const run = () => {
    const w = Math.round(el.clientWidth);
    if (w && w !== last) {
      last = w;
      draw(w);
    }
  };
  observed.set(el, run);
  ro.observe(el);
  run();
}

/** Profil d'altitude façon roadbook : silhouette pleine, panneaux numérotés aux ravitos. */
export function profileChart(el: HTMLElement, course: Profile, plan: Plan | null, startMs: number) {
  responsive(el, (W) => drawProfile(el, W, course, plan, startMs));
}

function drawProfile(el: HTMLElement, W: number, course: Profile, plan: Plan | null, startMs: number) {
  const narrow = W < 560;
  const H = narrow ? 220 : 300;
  const pad = { l: narrow ? 34 : 44, r: 4, t: narrow ? 30 : 52, b: 24 };
  const n = course.dist.length;
  const total = course.dist[n - 1];
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of course.ele) {
    lo = Math.min(lo, e);
    hi = Math.max(hi, e);
  }
  const span = Math.max(50, hi - lo);
  lo -= span * 0.15;
  hi += span * 0.06;
  const x = (d: number) => pad.l + (d / total) * (W - pad.l - pad.r);
  const y = (e: number) => pad.t + (1 - (e - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const base = H - pad.b;

  const every = Math.max(1, Math.floor(n / (W * 1.5)));
  let line = '';
  for (let i = 0; i < n; i += every) line += `${i ? 'L' : 'M'}${x(course.dist[i]).toFixed(1)},${y(course.ele[i]).toFixed(1)}`;
  line += `L${x(total).toFixed(1)},${y(course.ele[n - 1]).toFixed(1)}`;
  const area = `${line}L${x(total)},${base}L${x(0)},${base}Z`;

  let grid = '';
  const es = niceStep(hi - lo, narrow ? 3 : 4);
  for (let e = Math.ceil(lo / es) * es; e <= hi; e += es)
    grid += `<line class="p-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(e)}" y2="${y(e)}"/><text class="p-axis" x="${pad.l - 6}" y="${y(e) + 4}" text-anchor="end">${m0(e)}</text>`;
  const ks = niceStep(total / 1000, narrow ? 5 : 10);
  for (let k = 0; k <= total / 1000 + 1e-9; k += ks)
    grid += `<text class="p-axis" x="${x(k * 1000)}" y="${H - 6}" text-anchor="${k === 0 ? 'start' : 'middle'}">${k}${k === 0 ? ' km' : ''}</text>`;

  // Ravitos : un trait (encre au-dessus du relief, papier dans le relief) et un panneau numéroté.
  let poles = '';
  let poleIn = '';
  let plates = '';
  if (plan) {
    // Placement des panneaux : sur la première ligne libre (2 au plus), à droite du trait
    // si la place le permet ; sinon on n'affiche que le numéro.
    const rows: [number, number][][] = [[], []];
    const free = (r: number, a: number, b: number) => rows[r].every(([c, d]) => b + 4 <= c || a >= d + 4);
    plan.segments.slice(0, -1).forEach((s, k) => {
      const xx = x(s.km1 * 1000);
      const late = s.margin != null && s.margin < 0;
      let label = narrow ? `${k + 1}` : `${k + 1}  ${s.to}`;
      let w = textWidth(label) + 10;
      let spot: { r: number; px: number } | null = null;
      for (const lbl of narrow ? [label] : [label, `${k + 1}`]) {
        w = textWidth(lbl) + 10;
        for (let r = 0; r < (narrow ? 1 : 2) && !spot; r++) {
          for (const px of [xx, xx - w]) {
            if (px >= pad.l - 2 && px + w <= W - 1 && free(r, px, px + w)) {
              spot = { r, px };
              break;
            }
          }
        }
        if (spot) {
          label = lbl;
          break;
        }
      }
      spot ??= { r: 0, px: Math.min(xx, W - w - 1) };
      rows[spot.r].push([spot.px, spot.px + w]);
      const top = pad.t - (narrow ? 26 : 46) + spot.r * 21;
      poles += `<line class="pole${late ? ' late' : ''}" x1="${xx}" x2="${xx}" y1="${top + 17}" y2="${base}"/>`;
      poleIn += `<line class="pole-in" x1="${xx}" x2="${xx}" y1="${top + 17}" y2="${base}"/>`;
      plates += `<g class="plate${late ? ' late' : ''}"><title>${esc(s.to)}</title><rect x="${spot.px}" y="${top}" width="${w}" height="17" rx="1.5"/><text x="${spot.px + 5}" y="${top + 12.5}" xml:space="preserve">${esc(label)}</text></g>`;
    });
  }

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="chart profile-chart" role="img" aria-label="${esc(t().roadbook)}">
    <defs><clipPath id="relief"><path d="${area}"/></clipPath></defs>
    ${grid}${poles}<path d="${area}" class="relief"/><g clip-path="url(#relief)">${poleIn}</g>${plates}
    <g class="hover" visibility="hidden"><line class="cursor" y1="${pad.t}" y2="${base}"/><circle class="cursor-dot" r="4.5"/></g>
  </svg><div class="tip" hidden></div>`;

  const svg = el.querySelector('svg')!;
  const hover = svg.querySelector<SVGGElement>('.hover')!;
  const cursor = hover.querySelector('line')!;
  const dot = hover.querySelector('circle')!;
  const tip = el.querySelector<HTMLDivElement>('.tip')!;
  svg.addEventListener('pointermove', (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const d = Math.max(0, Math.min(total, ((px - pad.l) / (W - pad.l - pad.r)) * total));
    const i = Math.min(n - 1, Math.round(d / (total / (n - 1))));
    const xx = x(course.dist[i]);
    hover.setAttribute('visibility', 'visible');
    cursor.setAttribute('x1', String(xx));
    cursor.setAttribute('x2', String(xx));
    dot.setAttribute('cx', String(xx));
    dot.setAttribute('cy', String(y(course.ele[i])));
    const time = plan ? `<span>${clock(startMs, plan.sim.times[i])}</span><span>${hm(plan.sim.times[i])}</span>` : '';
    tip.innerHTML = `<b>${km1(course.dist[i] / 1000)} km</b><span>${m0(course.ele[i])} m</span>${time}`;
    tip.hidden = false;
    const left = (xx / W) * r.width;
    tip.style.left = `${Math.min(r.width - tip.offsetWidth, Math.max(0, left + 10))}px`;
  });
  svg.addEventListener('pointerleave', () => {
    hover.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });
}

/** Vitesse (km/h) selon la pente : courbe perso contre modèle générique, volume de données en fond. */
export function curveChart(el: HTMLElement, personal: Curve, generic: Curve) {
  responsive(el, (W) => drawCurve(el, W, personal, generic));
}

function drawCurve(el: HTMLElement, W: number, personal: Curve, generic: Curve) {
  const H = 190;
  const pad = { l: 28, r: 6, t: 14, b: 24 };
  const g0 = -0.4;
  const g1 = 0.4;
  const vmax = Math.max(...personal.speeds, ...generic.speeds) * 3.6 * 1.08;
  const x = (g: number) => pad.l + ((g - g0) / (g1 - g0)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / vmax) * (H - pad.t - pad.b);
  const path = (c: Curve) => c.grades.map((g, k) => `${k ? 'L' : 'M'}${x(g).toFixed(1)},${y(c.speeds[k] * 3.6).toFixed(1)}`).join('');

  const maxS = Math.max(1, ...personal.samples);
  const bw = Math.max(1, (x(0.02) - x(0)) * 0.7);
  const bars = personal.samples
    .map((s, k) => {
      if (!s) return '';
      const h = Math.max(1, (s / maxS) * (H - pad.t - pad.b) * 0.3);
      return `<rect class="bar" x="${x(personal.grades[k]) - bw / 2}" y="${H - pad.b - h}" width="${bw}" height="${h}"/>`;
    })
    .join('');

  let grid = '';
  const gs = W < 320 ? 20 : 10;
  for (let g = -40; g <= 40; g += gs)
    grid += `<line class="p-grid" x1="${x(g / 100)}" x2="${x(g / 100)}" y1="${pad.t}" y2="${H - pad.b}"/><text class="p-axis" x="${x(g / 100)}" y="${H - 6}" text-anchor="middle">${g > 0 ? '+' : ''}${g} %</text>`;
  const vs = niceStep(vmax, 3);
  for (let v = vs; v < vmax; v += vs)
    grid += `<line class="p-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="p-axis" x="${pad.l - 5}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="chart" role="img" aria-label="${esc(t().curveTitle)}">
    ${grid}${bars}
    <path d="${path(generic)}" class="curve-generic"/>
    ${personal.personal ? `<path d="${path(personal)}" class="curve-you"/>` : ''}
    <text class="p-axis" x="${pad.l + 4}" y="${pad.t + 2}">km/h</text>
  </svg>
  <p class="legend">${personal.personal ? `<span class="lg-you">${esc(t().curveYou)}</span>` : ''}<span class="lg-generic">${esc(t().curveGeneric)}</span>${personal.personal ? `<span class="lg-bar">${esc(t().curveData)}</span>` : ''}</p>`;
}
