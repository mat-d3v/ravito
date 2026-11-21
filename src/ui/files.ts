// Lecture des fichiers déposés : GPX, TCX, FIT, versions .gz, et archive d'export Strava (.zip).
// Tout se passe dans le navigateur ; aucun fichier n'est envoyé nulle part.

import { unzipSync } from 'fflate';
// @ts-expect-error : la bibliothèque n'a pas de types
import FitParser from 'fit-file-parser';
import { parseTrackText, type ParsedTrack, type RawPoint } from '../engine/parse';
import { activityTypes, fileBase } from '../engine/strava';

const TRACK_EXT = /\.(gpx|tcx|fit)(\.gz)?$/i;

async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

function parseFit(buf: ArrayBuffer): Promise<ParsedTrack> {
  return new Promise((resolve, reject) => {
    const parser = new (FitParser.default ?? FitParser)({ force: true, mode: 'list', lengthUnit: 'm', speedUnit: 'm/s' });
    parser.parse(buf, (err: unknown, data: { records?: Record<string, unknown>[] }) => {
      if (err) return reject(new Error(String(err)));
      const points: RawPoint[] = [];
      for (const r of data.records ?? []) {
        const lat = r.position_lat as number | undefined;
        const lon = r.position_long as number | undefined;
        if (typeof lat !== 'number' || typeof lon !== 'number') continue;
        const ele = (r.enhanced_altitude ?? r.altitude) as number | undefined;
        const ts = r.timestamp as Date | string | undefined;
        points.push({
          lat,
          lon,
          ele: typeof ele === 'number' ? ele : null,
          time: ts ? new Date(ts).getTime() : null,
        });
      }
      resolve({ name: null, points, waypoints: [] });
    });
  });
}

async function parseBuffer(name: string, buf: ArrayBuffer): Promise<ParsedTrack> {
  let n = name.toLowerCase();
  if (n.endsWith('.gz')) {
    buf = await gunzip(buf);
    n = n.slice(0, -3);
  }
  if (n.endsWith('.fit')) return parseFit(buf);
  return parseTrackText(new TextDecoder().decode(buf));
}

export interface LoadedTrack {
  file: string;
  track: ParsedTrack;
  /** Type d'activité Strava si activities.csv était fourni ("Run", "Walk"…). */
  type?: string;
}

const CSV_NAME = /(^|\/)activities\.csv$/i;

// Types d'activité vus dans un activities.csv, conservés d'un dépôt à l'autre.
const knownTypes = new Map<string, string>();
const remember = (m: Map<string, string>) => m.forEach((v, k) => knownTypes.set(k, v));

/** Lit un ou plusieurs fichiers, y compris le contenu d'une archive .zip. Les erreurs sont listées, pas bloquantes. */
export async function readTrackFiles(
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ tracks: LoadedTrack[]; errors: string[] }> {
  const entries: { name: string; load: () => Promise<ArrayBuffer> }[] = [];
  const errors: string[] = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      try {
        const zip = unzipSync(new Uint8Array(await f.arrayBuffer()), { filter: (e) => TRACK_EXT.test(e.name) || CSV_NAME.test(e.name) });
        for (const [name, data] of Object.entries(zip)) {
          if (CSV_NAME.test(name)) remember(activityTypes(new TextDecoder().decode(data)));
          else entries.push({ name, load: async () => data.slice().buffer as ArrayBuffer });
        }
      } catch (e) {
        errors.push(`${f.name} : ${(e as Error).message}`);
      }
    } else if (CSV_NAME.test(f.name)) {
      remember(activityTypes(await f.text()));
    } else if (TRACK_EXT.test(f.name)) {
      entries.push({ name: f.name, load: () => f.arrayBuffer() });
    } else {
      errors.push(`${f.name} : format non pris en charge`);
    }
  }
  const tracks: LoadedTrack[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    try {
      tracks.push({ file: e.name, track: await parseBuffer(e.name, await e.load()), type: knownTypes.get(fileBase(e.name)) });
    } catch (err) {
      errors.push(`${e.name} : ${(err as Error).message}`);
    }
    if (i % 10 === 0) {
      onProgress?.(i + 1, entries.length);
      await new Promise((r) => setTimeout(r));
    }
  }
  onProgress?.(entries.length, entries.length);
  return { tracks, errors };
}
