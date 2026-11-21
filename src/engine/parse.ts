// Lecture des traces GPX et TCX, sans DOM (testable sous Node).

export interface RawPoint {
  lat: number;
  lon: number;
  ele: number | null;
  /** Horodatage en millisecondes (epoch), ou null si absent. */
  time: number | null;
}

export interface Waypoint {
  name: string;
  lat: number;
  lon: number;
}

export interface ParsedTrack {
  name: string | null;
  points: RawPoint[];
  waypoints: Waypoint[];
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();

function attr(attrs: string, name: string): number {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`).exec(attrs);
  return m ? Number(m[1]) : NaN;
}

function tag(body: string, name: string): string | null {
  const m = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(body);
  return m ? m[1] : null;
}

function toNum(s: string | null): number | null {
  if (s == null) return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
}

function toTime(s: string | null): number | null {
  if (s == null) return null;
  const t = Date.parse(s.trim());
  return Number.isFinite(t) ? t : null;
}

function pointsOf(xml: string, kind: 'trkpt' | 'rtept'): RawPoint[] {
  const out: RawPoint[] = [];
  const re = new RegExp(`<(?:\\w+:)?${kind}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${kind}>)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const lat = attr(m[1], 'lat');
    const lon = attr(m[1], 'lon');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const body = m[2] ?? '';
    out.push({ lat, lon, ele: toNum(tag(body, 'ele')), time: toTime(tag(body, 'time')) });
  }
  return out;
}

export function parseGPX(xml: string): ParsedTrack {
  let points = pointsOf(xml, 'trkpt');
  if (points.length === 0) points = pointsOf(xml, 'rtept');

  const waypoints: Waypoint[] = [];
  const wre = /<(?:\w+:)?wpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?wpt>)/g;
  let m: RegExpExecArray | null;
  while ((m = wre.exec(xml))) {
    const lat = attr(m[1], 'lat');
    const lon = attr(m[1], 'lon');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const name = tag(m[2] ?? '', 'name');
    waypoints.push({ name: name ? decode(name) : '', lat, lon });
  }

  const trk = tag(xml, 'trk');
  const nameSrc = (trk && tag(trk, 'name')) ?? tag(xml.replace(/<(?:\w+:)?wpt\b[\s\S]*?<\/(?:\w+:)?wpt>/g, ''), 'name');
  return { name: nameSrc ? decode(nameSrc) : null, points, waypoints };
}

export function parseTCX(xml: string): ParsedTrack {
  const points: RawPoint[] = [];
  const re = /<(?:\w+:)?Trackpoint\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Trackpoint>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const lat = toNum(tag(m[1], 'LatitudeDegrees'));
    const lon = toNum(tag(m[1], 'LongitudeDegrees'));
    if (lat == null || lon == null) continue;
    points.push({ lat, lon, ele: toNum(tag(m[1], 'AltitudeMeters')), time: toTime(tag(m[1], 'Time')) });
  }
  const name = tag(xml, 'Name');
  return { name: name ? decode(name) : null, points, waypoints: [] };
}

/** Choisit le bon lecteur d'après le contenu. */
export function parseTrackText(text: string): ParsedTrack {
  if (/<(?:\w+:)?TrainingCenterDatabase\b/.test(text)) return parseTCX(text);
  return parseGPX(text);
}
