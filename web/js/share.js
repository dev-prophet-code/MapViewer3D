// Share links for the 3D map: the admin creates a link that lets people who are not console users
// look at the map. The links are issued by the share gateway of the MapViewer3D stack (branch ddp,
// service "mvshare"), not by the console: the addon cannot open anything to the public by itself,
// and the console's API keys must not be handed out.
//
// What this page holds: the gateway address (not secret, kept with the instance names) and the
// gateway's admin secret (memory only, like the API key). The gateway stores only a hash of each link's
// token; the link is shown once, right after it was created.
import { store } from './store.js';
import { t, lang } from './i18n.js';
import { durationSeconds, linkUrl, normalizeGateway, SECRET_PATTERN, TOKEN_PATTERN } from './share-core.js';

const $ = (id) => document.getElementById(id);
const GATEWAY_STORE = 'share.gateway';

let origin = null;
let secret = null; // memory only

class GatewayError extends Error {
  constructor(key, detail = '') { super(key); this.key = key; this.detail = detail; }
}

async function gw(method, path, body) {
  let r;
  try {
    r = await fetch(`${origin}/share-admin/${path}`, {
      method, credentials: 'omit', cache: 'no-store',
      headers: { Authorization: `Bearer ${secret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new GatewayError('unreachable', e.message);
  }
  if (r.status === 401) throw new GatewayError('auth');
  if (r.status === 403) throw new GatewayError('origin');
  if (r.status === 429) throw new GatewayError('blocked');
  let doc = null;
  try { doc = await r.json(); } catch { /* not the gateway */ }
  if (!r.ok) throw new GatewayError('http', `${r.status}${doc?.error ? ` ${doc.error}` : ''}`);
  if (!doc || typeof doc !== 'object') throw new GatewayError('not_gateway');
  return doc;
}

const errText = (e) => (e instanceof GatewayError ? t(`share.err.${e.key}`, { detail: e.detail }) : e.message);

function fmtTime(sec) {
  return new Date(sec * 1000).toLocaleString(lang === 'de' ? 'de-DE' : undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function showError(msg) {
  const el = $('shareError');
  el.textContent = msg ?? '';
  el.hidden = !msg;
}

function renderCaps(st) {
  const yes = (v) => (v ? t('share.yes') : t('share.no'));
  const lines = [
    `${t('share.cap.key')}: ${st.keyConfigured ? (st.keyAccepted ? t('share.yes') : t('share.cap.rejected')) : t('share.cap.nokey')}`,
    `${t('share.cap.maps')}: ${yes(st.maps)}`,
    `${t('share.cap.bases')}: ${yes(st.bases)}`,
    `${t('share.cap.players')}: ${yes(st.players)}`,
    `${t('share.cap.realtime')}: ${st.realtime ? t('share.yes') : `${t('share.no')}${st.realtimeReason ? ` (${st.realtimeReason})` : ''}`}`,
  ];
  $('shareCaps').textContent = lines.join('\n');
  // the options the gateway's key cannot serve are switched off
  for (const [id, ok] of [['shareRealtime', st.realtime], ['shareBases', st.bases], ['sharePlayers', st.players]]) {
    const box = $(id);
    box.disabled = !ok;
    if (!ok) box.checked = false;
    box.closest('label').classList.toggle('off', !ok);
  }
  $('shareMake').disabled = $('shareForever').disabled = !st.maps;
}

async function refreshList() {
  const { links } = await gw('GET', 'links');
  const list = $('shareList');
  const rows = links.filter((l) => l.active || Date.now() / 1000 - l.created < 7 * 86400);
  if (!rows.length) { list.textContent = t('share.none'); return; }
  list.replaceChildren(...rows.map((l) => {
    const row = document.createElement('div');
    row.className = `sharerow${l.active ? '' : ' dead'}`;
    const opts = [l.realtime && t('share.o.realtime'), l.bases && t('share.o.bases'), l.players && t('share.o.players')].filter(Boolean).join(', ');
    const info = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = l.label || `#${l.id}`;
    const meta = document.createElement('div');
    meta.className = 'muted';
    const state = !l.active ? t('share.ended') : l.expires ? t('share.until', { when: fmtTime(l.expires) }) : t('share.never');
    meta.textContent = `${state} · ${opts || t('share.o.map')}${l.lastUsed ? ` · ${t('share.lastUsed', { when: fmtTime(l.lastUsed) })}` : ''}`;
    info.append(title, meta);
    row.append(info);
    if (l.active) {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'danger', textContent: t('share.revoke') });
      b.onclick = async () => {
        if (!confirm(t('share.revoke.confirm'))) return;
        try { await gw('DELETE', `links/${l.id}`); await refreshList(); } catch (e) { showError(errText(e)); }
      };
      row.append(b);
    }
    return row;
  }));
}

async function connect() {
  showError('');
  const o = normalizeGateway($('shareGateway').value, location.origin);
  if (!o) { showError(t('share.err.address')); return; }
  const s = $('shareSecret').value.trim();
  if (!SECRET_PATTERN.test(s)) { showError(t('share.err.secret_format')); return; }
  origin = o;
  secret = s;
  $('shareConnectBtn').disabled = true;
  try {
    const st = await gw('GET', 'status');
    renderCaps(st);
    await refreshList();
    $('shareSecret').value = '';
    $('shareMain').hidden = false;
    $('shareConnect').hidden = true;
    store.put(GATEWAY_STORE, { origin: $('shareGateway').value.trim() }).catch(() => {});
  } catch (e) {
    secret = null;
    showError(errText(e));
  } finally {
    $('shareConnectBtn').disabled = false;
  }
}

async function create(never) {
  showError('');
  const body = {
    label: $('shareLabel').value.trim(),
    realtime: $('shareRealtime').checked, bases: $('shareBases').checked, players: $('sharePlayers').checked,
  };
  if (never) {
    if (!confirm(t('share.forever.confirm'))) return;
    body.never = true;
  } else {
    const s = durationSeconds($('shareDuration').value, $('shareCustomN').value, $('shareCustomUnit').value);
    if (s === null) { showError(t('share.err.duration')); return; }
    body.seconds = s;
  }
  if (body.players && !confirm(t('share.players.confirm'))) return;
  try {
    const doc = await gw('POST', 'links', body);
    if (!TOKEN_PATTERN.test(doc.token ?? '')) throw new GatewayError('not_gateway');
    $('shareLink').value = linkUrl(origin, doc.token);
    $('shareResult').hidden = false;
    $('shareLink').select();
    await refreshList();
  } catch (e) {
    showError(errText(e));
  }
}

export async function openShare() {
  const modal = $('share');
  showError('');
  $('shareResult').hidden = true;
  $('shareLink').value = '';
  if (!secret) {
    $('shareConnect').hidden = false;
    $('shareMain').hidden = true;
    const saved = await store.get(GATEWAY_STORE).catch(() => null);
    $('shareGateway').value = saved?.origin ?? '';
    $('shareSecret').value = '';
  } else {
    refreshList().catch((e) => showError(errText(e)));
  }
  modal.hidden = false;
  (secret ? $('shareLabel') : $('shareSecret')).focus();
}

export function initShare() {
  $('shareClose').onclick = () => { $('share').hidden = true; $('shareLink').value = ''; $('shareResult').hidden = true; };
  $('shareConnect').onsubmit = (e) => { e.preventDefault(); connect(); };
  $('shareDuration').onchange = () => { $('shareCustom').hidden = $('shareDuration').value !== 'custom'; };
  $('shareCreate').onsubmit = (e) => { e.preventDefault(); create(false); };
  $('shareForever').onclick = () => create(true);
  $('shareCopy').onclick = async () => {
    const v = $('shareLink').value;
    try { await navigator.clipboard.writeText(v); $('shareCopy').textContent = t('share.copied'); } catch { $('shareLink').select(); }
    setTimeout(() => { $('shareCopy').textContent = t('share.copy'); }, 1500);
  };
  // leaving the gateway forgets the secret (it is only held in memory anyway)
  $('shareLink').addEventListener('focus', () => $('shareLink').select());
}

// forget the admin secret together with the API key
export function forgetShare() { secret = null; origin = null; }
