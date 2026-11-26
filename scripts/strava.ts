// Ravito avec Strava, en local.
//
//   npm run strava
//
// Lance un petit serveur sur ta machine (127.0.0.1 uniquement) qui :
// 1. sert l'application Ravito ;
// 2. te connecte à Strava avec TA propre application API (identifiant et clé secrète restent chez toi) ;
// 3. télécharge tes sorties de course récentes et les transmet à Ravito, déjà découpées.
//
// Rien ne passe par un serveur tiers. Les jetons et le cache sont dans ~/.config/ravito
// (ou dans le dossier indiqué par RAVITO_HOME). `npm run strava -- --forget` efface tout.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { build } from 'vite';
import { samplesFromActivity, type Sample } from '../src/engine/model';
import { API_RUN_TYPES, nextQuarterHour, parseRateLimit, pointsFromStreams, type StravaStreams } from '../src/engine/strava';

// ---------- Réglages ----------

const PORT = Number(process.env.RAVITO_PORT ?? 5180);
const HOST = '127.0.0.1';
const ORIGIN = `http://${HOST}:${PORT}`;
const HOME = process.env.RAVITO_HOME ?? join(homedir(), '.config', 'ravito');
const CONF = join(HOME, 'strava.json');
const CACHE = join(HOME, 'cache');
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const maxArg = process.argv.find((a) => a.startsWith('--max='));
/** Nombre de sorties de course récentes à analyser. */
const MAX_RUNS = maxArg ? Math.max(1, Number(maxArg.slice(6)) || 200) : 200;

const fr = (process.env.LANG ?? '').toLowerCase().startsWith('fr');
const say = (frText: string, enText: string) => console.log(fr ? frText : enText);

interface Token {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  firstname?: string;
}
interface Config {
  clientId: string;
  clientSecret: string;
  token?: Token;
}

function readConfig(): Config | null {
  try {
    return JSON.parse(readFileSync(CONF, 'utf8')) as Config;
  } catch {
    return null;
  }
}

function writeConfig(c: Config) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(CONF, JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(CONF, 0o600);
}

if (process.argv.includes('--forget')) {
  rmSync(HOME, { recursive: true, force: true });
  say(`Effacé : ${HOME} (identifiants, jetons et cache).`, `Deleted ${HOME} (credentials, tokens and cache).`);
  process.exit(0);
}

async function setup(): Promise<Config> {
  const existing = readConfig();
  const envId = process.env.STRAVA_CLIENT_ID;
  const envSecret = process.env.STRAVA_CLIENT_SECRET;
  if (envId && envSecret) {
    const c = { ...existing, clientId: envId, clientSecret: envSecret };
    if (existing && existing.clientId !== envId) delete c.token;
    writeConfig(c);
    return c;
  }
  if (existing?.clientId && existing.clientSecret) return existing;

  say(
    `
Première utilisation : il te faut ta propre application API Strava (2 minutes, gratuit).
  1. Ouvre https://www.strava.com/settings/api
  2. Nom : ce que tu veux (par exemple « Ravito perso »), catégorie : Training, site : ${ORIGIN}
  3. « Authorization Callback Domain » : 127.0.0.1
  4. Copie ci-dessous le Client ID et le Client Secret.
Ils restent sur ta machine, dans ${CONF}.
`,
    `
First run: you need your own Strava API application (2 minutes, free).
  1. Open https://www.strava.com/settings/api
  2. Name: anything (for example "Ravito personal"), category: Training, website: ${ORIGIN}
  3. "Authorization Callback Domain": 127.0.0.1
  4. Paste the Client ID and Client Secret below.
They stay on your machine, in ${CONF}.
`,
  );
  const rl = createInterface({ input: stdin, output: stdout });
  const clientId = (await rl.question('Client ID : ')).trim();
  const clientSecret = (await rl.question('Client Secret : ')).trim();
  rl.close();
  if (!/^\d+$/.test(clientId) || clientSecret.length < 20) {
    say('Identifiants invalides, relance la commande.', 'Invalid credentials, run the command again.');
    process.exit(1);
  }
  const c = { clientId, clientSecret };
  writeConfig(c);
  return c;
}

// ---------- Strava ----------

let config: Config;
const status = {
  state: 'idle' as 'idle' | 'syncing' | 'ready' | 'error',
  done: 0,
  total: 0,
  waitUntil: 0,
  error: '',
};
let result: { used: number; skipped: number; seconds: number; samples: Sample[] } | null = null;
let syncing: Promise<void> | null = null;
let rateWaitUntil = 0;

async function tokenRequest(params: Record<string, string>): Promise<Token> {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...params }),
  });
  if (!res.ok) throw new Error(`Strava OAuth ${res.status}`);
  const j = (await res.json()) as Token & { athlete?: { firstname?: string } };
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_at,
    firstname: j.athlete?.firstname ?? config.token?.firstname,
  };
}

async function accessToken(): Promise<string> {
  const t = config.token;
  if (!t) throw new Error('not connected');
  if (t.expires_at - 120 > Date.now() / 1000) return t.access_token;
  config.token = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  writeConfig(config);
  return config.token.access_token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Appel à l'API, en respectant les quotas : on attend la fenêtre suivante plutôt que de se faire bloquer. */
async function api<T>(path: string): Promise<T> {
  for (;;) {
    if (rateWaitUntil > Date.now()) {
      status.waitUntil = rateWaitUntil;
      await sleep(rateWaitUntil - Date.now());
      status.waitUntil = 0;
    }
    const res = await fetch(`https://www.strava.com/api/v3${path}`, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    const rl = parseRateLimit((n) => res.headers.get(n));
    if (rl && (rl.used15 >= rl.limit15 - 1 || rl.usedDay >= rl.limitDay - 1)) {
      // Quota journalier épuisé : on reprend demain ; sinon à la prochaine fenêtre de 15 minutes.
      rateWaitUntil = rl.usedDay >= rl.limitDay - 1 ? new Date().setUTCHours(24, 0, 30, 0) : nextQuarterHour(Date.now()) + 30_000;
    }
    if (res.status === 429) {
      rateWaitUntil = Math.max(rateWaitUntil, nextQuarterHour(Date.now()) + 30_000);
      continue;
    }
    if (res.status === 401) {
      delete config.token;
      writeConfig(config);
      throw new Error('unauthorized');
    }
    if (!res.ok) throw new Error(`Strava API ${res.status}`);
    return (await res.json()) as T;
  }
}

interface ActivitySummary {
  id: number;
  sport_type?: string;
  type?: string;
  start_date: string;
  manual?: boolean;
}

interface Cached {
  start: number;
  samples: Sample[];
  seconds: number;
}

async function sync() {
  status.state = 'syncing';
  status.done = 0;
  status.total = 0;
  status.error = '';
  try {
    // 1. Liste des sorties de course récentes (200 par page).
    const runs: ActivitySummary[] = [];
    for (let page = 1; runs.length < MAX_RUNS && page <= 20; page++) {
      const list = await api<ActivitySummary[]>(`/athlete/activities?per_page=200&page=${page}`);
      if (!list.length) break;
      for (const a of list) if (API_RUN_TYPES.has(a.sport_type ?? a.type ?? '') && !a.manual) runs.push(a);
    }
    runs.splice(MAX_RUNS);
    status.total = runs.length;

    // 2. Flux GPS de chaque sortie, gardés en cache (une sortie ne se télécharge qu'une fois).
    mkdirSync(CACHE, { recursive: true, mode: 0o700 });
    const agg = { used: 0, skipped: 0, seconds: 0, samples: [] as Sample[] };
    for (const a of runs) {
      const file = join(CACHE, `${a.id}.json`);
      let c: Cached;
      if (existsSync(file)) c = JSON.parse(readFileSync(file, 'utf8')) as Cached;
      else {
        const start = Date.parse(a.start_date);
        const streams = await api<StravaStreams>(`/activities/${a.id}/streams?keys=latlng,altitude,time&key_by_type=true`);
        const s = samplesFromActivity(pointsFromStreams(start, streams));
        c = { start, samples: s.samples, seconds: s.duration };
        writeFileSync(file, JSON.stringify(c), { mode: 0o600 });
      }
      if (c.samples.length) {
        agg.used++;
        agg.seconds += c.seconds;
        agg.samples.push(...c.samples);
      } else agg.skipped++;
      status.done++;
    }
    result = agg;
    status.state = 'ready';
    say(
      `Strava : ${agg.used} sorties analysées (${agg.skipped} écartées).`,
      `Strava: ${agg.used} runs analysed (${agg.skipped} left out).`,
    );
  } catch (e) {
    status.state = 'error';
    status.error = (e as Error).message;
    say(`Strava : erreur (${status.error}).`, `Strava: error (${status.error}).`);
  }
}

function startSync() {
  syncing ??= sync().finally(() => {
    syncing = null;
  });
}

// ---------- Serveur HTTP ----------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

let oauthState = '';

function send(res: ServerResponse, code: number, body: string | Buffer, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
const json = (res: ServerResponse, data: unknown) => send(res, 200, JSON.stringify(data), 'application/json');
const redirect = (res: ServerResponse, to: string) => send(res, 302, '', 'text/plain', { Location: to });

function serveStatic(path: string, res: ServerResponse) {
  const rel = normalize(decodeURIComponent(path.replace(/^\/ravito\/?/, ''))).replace(/^([/\\])+/, '');
  let file = join(DIST, rel || 'index.html');
  if (!file.startsWith(DIST + sep) && file !== DIST) return send(res, 403, 'Forbidden');
  if (!existsSync(file) || !extname(file)) file = join(DIST, 'index.html');
  send(res, 200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  // Protection contre le « DNS rebinding » : on ne répond qu'à notre propre adresse.
  const host = req.headers.host ?? '';
  if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return send(res, 421, 'Misdirected request');
  const url = new URL(req.url ?? '/', ORIGIN);
  const p = url.pathname;

  if (p === '/' || p === '/ravito') return redirect(res, '/ravito/?strava=local');

  if (p === '/strava/login') {
    oauthState = randomBytes(16).toString('hex');
    const auth = new URL('https://www.strava.com/oauth/authorize');
    auth.search = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: `${ORIGIN}/strava/callback`,
      approval_prompt: 'auto',
      scope: 'activity:read_all',
      state: oauthState,
    }).toString();
    return redirect(res, auth.toString());
  }

  if (p === '/strava/callback') {
    const code = url.searchParams.get('code');
    const scope = url.searchParams.get('scope') ?? '';
    if (!oauthState || url.searchParams.get('state') !== oauthState) return send(res, 400, 'Invalid state');
    oauthState = '';
    if (!code || !/activity:read/.test(scope)) return redirect(res, '/ravito/?strava=local&strava_error=denied');
    try {
      config.token = await tokenRequest({ grant_type: 'authorization_code', code });
      writeConfig(config);
      startSync();
    } catch {
      return redirect(res, '/ravito/?strava=local&strava_error=token');
    }
    return redirect(res, '/ravito/?strava=local');
  }

  if (p === '/strava/status') {
    return json(res, { connected: !!config.token, athlete: config.token?.firstname ?? null, ...status });
  }

  if (p === '/strava/samples') {
    if (!result) return send(res, 404, 'Not ready');
    return json(res, result);
  }

  if (p === '/strava/sync' && req.method === 'POST') {
    if (!config.token) return send(res, 401, 'Not connected');
    startSync();
    return json(res, { ok: true });
  }

  if (p.startsWith('/ravito')) return serveStatic(p, res);
  send(res, 404, 'Not found');
}

// ---------- Démarrage ----------

config = await setup();
say('Construction de Ravito…', 'Building Ravito…');
await build({ root: ROOT, logLevel: 'warn' });

createServer((req, res) => {
  handle(req, res).catch((e) => send(res, 500, String((e as Error).message)));
}).listen(PORT, HOST, () => {
  const url = `${ORIGIN}/ravito/?strava=local`;
  say(`\nRavito tourne sur ${url}\nCtrl+C pour arrêter.\n`, `\nRavito is running at ${url}\nPress Ctrl+C to stop.\n`);
  if (config.token) startSync();
  if (!process.argv.includes('--no-open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
    exec(`${opener} "${url}"`);
  }
});
