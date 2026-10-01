// Update-Hinweis im Bedienfeld: fragt den Viewer-Server, ob auf GitHub eine neuere
// Version liegt (der Server prüft selbst), und installiert sie auf Klick.
// Öffentlich betriebene Viewer und Server mit -no-update-check zeigen nichts.
import { t } from './i18n.js';

const box = document.getElementById('updateBox');
const POLL_MS = 10 * 60 * 1000;
let timer = 0;

async function get() {
  try {
    const r = await fetch('/api/update/status', { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function render(res) {
  box.replaceChildren();
  const st = res?.status;
  if (!res?.enabled || !st) { box.hidden = true; return; }
  const busy = ['downloading', 'installing', 'restarting'].includes(st.state);
  if (!st.available && !busy && st.state !== 'error') { box.hidden = true; return; }
  box.hidden = false;
  if (busy) {
    box.append(el('div', t('update.' + st.state), 'small'));
    return;
  }
  box.append(el('strong', t('update.available', { version: st.latest }), 'ut'));
  if (st.state === 'error') box.append(el('div', t('update.error', { error: st.error }), 'small err'));
  const row = el('div', null, 'row');
  if (st.canApply && res.admin && !st.auto) {
    const b = el('button', t('update.install'), 'primary');
    b.onclick = install;
    row.append(b);
  } else if (st.canApply && st.auto) {
    box.append(el('div', t('update.auto'), 'small muted'));
  } else if (!st.canApply) {
    box.append(el('div', t('update.manual'), 'small muted'));
  }
  if (/^https:\/\/github\.com\//.test(st.url || '')) {
    const a = el('a', t('update.notes'));
    a.href = st.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    row.append(a);
  }
  box.append(row);
}

async function install() {
  const before = (await get())?.status?.current;
  box.replaceChildren(el('div', t('update.downloading'), 'small'));
  try {
    const r = await fetch('/api/update/install', { method: 'POST', headers: { 'X-MapViewer': '1' } });
    if (!r.ok) throw new Error(await r.text());
  } catch (e) {
    box.replaceChildren(el('div', t('update.error', { error: String(e.message || e) }), 'small err'));
    return;
  }
  watch(before);
}

// Der Server startet nach der Installation neu: warten, bis er wieder da ist, dann neu laden.
// Der Neustart ist oft schneller als die Abfrage-Pause; deshalb gilt auch die geänderte Version als Zeichen.
function watch(before) {
  clearInterval(timer);
  let down = false;
  timer = setInterval(async () => {
    const res = await get();
    if (!res) { down = true; box.replaceChildren(el('div', t('update.restarting'), 'small')); return; }
    if (down || (before && res.status?.current && res.status.current !== before)) { location.reload(); return; }
    render(res);
    if (res.status?.state === 'error') { clearInterval(timer); startPolling(); }
  }, 2000);
}

function startPolling() {
  clearInterval(timer);
  const tick = async () => render(await get());
  tick();
  timer = setInterval(tick, POLL_MS);
}

export function initUpdate() { if (box) startPolling(); }
