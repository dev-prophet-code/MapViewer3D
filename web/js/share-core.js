// Pure helpers of the share dialog (no DOM, testable in Node).

// The address of the share gateway as an origin. Empty = the page's own origin (the gateway sits
// behind the same reverse proxy as the console). Plain http is accepted only for this machine, because
// the API key and every link would travel unencrypted.
export function normalizeGateway(input, pageOrigin) {
  const page = (() => { try { return new URL(pageOrigin); } catch { return null; } })();
  const raw = String(input ?? '').trim();
  if (!raw) return pageOrigin;
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  // plain http only for this machine, or for the console's own host when the console page itself is plain http
  const sameHost = page?.protocol === 'http:' && u.hostname === page.hostname;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (local || sameHost))) return null;
  if (u.username || u.password) return null;
  return u.origin;
}

export const linkUrl = (origin, token) => `${origin}/s/${token}/`;

export const TOKEN_PATTERN = /^mvs_[A-Za-z0-9_-]{43}$/;
export const SECRET_PATTERN = /^mva_[A-Za-z0-9_-]{43}$/;

const MIN_SECONDS = 60;
const MAX_SECONDS = 5 * 365 * 24 * 3600;

// Seconds for the choice in the dialog; null when the custom value is not usable.
export function durationSeconds(choice, customAmount, customUnit) {
  const s = choice === 'custom' ? Math.round(Number(customAmount) * Number(customUnit)) : Number(choice);
  return Number.isFinite(s) && s >= MIN_SECONDS && s <= MAX_SECONDS ? s : null;
}

// The addresses to try, in order, as { origin, askFirst }. The remembered address lives in the addon's
// storage, which every user of the addon can write, so it is NOT trusted silently: the administrator
// confirms it before the key is sent to it. The console's own address and port 8798 of the console's
// host are derived from the page itself and need no question.
export function gatewayCandidates({ saved, pageOrigin, protocol, hostname }) {
  const derived = [pageOrigin, `https://${hostname}:8798`];
  if (protocol === 'http:') derived.push(`http://${hostname}:8798`); // as plain as the console page itself
  const out = [];
  const seen = new Set();
  const add = (origin, askFirst) => { if (origin && !seen.has(origin)) { seen.add(origin); out.push({ origin, askFirst }); } };
  const s = saved ? normalizeGateway(saved, pageOrigin) : null;
  if (s) add(s, !derived.includes(s));
  for (const d of derived) add(d, false);
  return out;
}

// Finds the gateway among the candidate addresses. A candidate is first asked who it is, WITHOUT any
// credential (GET /mvshare: no Authorization, no cookies, no redirects); only an answer that names
// the share gateway earns the administrator's API key, which then goes with the status call. An address
// that merely answers (another service, a stray proxy) never sees the key.
//   fetchFn(url, init)   fetch-like
//   status(origin)       does the authorised status call and returns its document (throws)
// Returns { origin, doc } or { error } (the last error; undefined when nothing identified itself).
export async function findGateway(candidates, { fetchFn, status }) {
  let error;
  for (const origin of candidates) {
    let who;
    try {
      const r = await fetchFn(`${origin}/mvshare`, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
      if (!r.ok) continue;
      who = await r.json();
    } catch { continue; }
    if (!who || typeof who !== 'object' || !('mapviewer-share' in who)) continue;
    try { return { origin, doc: await status(origin) }; } catch (e) { error = e; if (e?.stop) break; }
  }
  return { error };
}
