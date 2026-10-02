// Einrichtung der Verbindung (Server + API-Token) und Benennen der Serverinstanzen.
// Der Token wird nur einmal zum Server geschickt und danach nie wieder angezeigt.
import { api } from './api.js';
import { t } from './i18n.js';

// Fehlermeldung zum Code des Servers, sonst dessen Text
const errorText = (ex) => (ex.code ? t(`err.${ex.code}`, { detail: ex.detail ?? '' }) : ex.message);

const $ = (id) => document.getElementById(id);

// Zeigt den Einrichtungsdialog; löst auf, sobald die Verbindung steht.
export function askForSetup({ cancellable = false } = {}) {
  return new Promise((resolve) => {
    const modal = $('setup');
    const form = $('setupForm');
    const err = $('setupError');
    $('setupToken').value = '';
    $('setupPin').value = '';
    $('setupCancel').hidden = !cancellable;
    err.hidden = true;
    modal.hidden = false;
    $('setupServer').focus();
    const close = (result) => {
      modal.hidden = true;
      $('setupToken').value = '';
      form.onsubmit = null;
      $('setupCancel').onclick = null;
      resolve(result);
    };
    $('setupCancel').onclick = () => close(null);
    form.onsubmit = async (e) => {
      e.preventDefault();
      err.hidden = true;
      $('setupSubmit').disabled = true;
      $('setupSubmit').textContent = t('setup.checking');
      try {
        const status = await api.setupSave($('setupServer').value, +$('setupPort').value || 8088, $('setupToken').value, $('setupPin').value.trim());
        close(status);
      } catch (ex) {
        err.textContent = errorText(ex);
        err.hidden = false;
        // fremdes Zertifikat: Fingerabdruck vorschlagen – erst nach Vergleich auf dem Server verbinden
        if (ex.code === 'cert_untrusted' && ex.detail && !$('setupPin').value) $('setupPin').value = ex.detail;
      } finally {
        $('setupSubmit').disabled = false;
        $('setupSubmit').textContent = t('setup.connect');
      }
    };
  });
}

// Dialog zum Benennen der Serverinstanzen
export async function editNames() {
  const rows = await api.labels();
  const list = $('namesList');
  list.replaceChildren(...rows.map((r) => {
    const l = document.createElement('label');
    l.textContent = `${r.map} · Partition ${r.partition} (${r.internal})`;
    const input = Object.assign(document.createElement('input'), {
      type: 'text', value: r.custom ?? '', placeholder: r.auto, maxLength: 40,
    });
    input.dataset.partition = r.partition;
    l.append(input);
    return l;
  }));
  if (!rows.length) list.textContent = t('names.none');
  return new Promise((resolve) => {
    const modal = $('names');
    const err = $('namesError');
    err.hidden = true;
    modal.hidden = false;
    const close = (changed) => { modal.hidden = true; $('namesForm').onsubmit = null; resolve(changed); };
    $('namesCancel').onclick = () => close(false);
    $('namesForm').onsubmit = async (e) => {
      e.preventDefault();
      const labels = {};
      for (const i of list.querySelectorAll('input')) if (i.value.trim()) labels[i.dataset.partition] = i.value.trim();
      try {
        await api.saveLabels(labels);
        close(true);
      } catch (ex) {
        err.textContent = errorText(ex);
        err.hidden = false;
      }
    };
  });
}

// Serverliste: gespeicherte Server, Umschalten im laufenden Programm.
// Löst mit true auf, wenn auf einen anderen Server gewechselt wurde.
export function switchServer() {
  return new Promise((resolve) => {
    const modal = $('servers');
    const list = $('serversList');
    const err = $('serversError');
    const close = (changed) => {
      modal.hidden = true;
      $('serversClose').onclick = null;
      $('serversAdd').onclick = null;
      resolve(changed);
    };
    const fail = (ex) => { err.textContent = errorText(ex); err.hidden = false; };
    const render = (rows) => {
      list.replaceChildren(...rows.map((r) => {
        const li = document.createElement('li');
        li.classList.toggle('active', r.active);
        const name = Object.assign(document.createElement('span'), { className: 'srv-name', textContent: r.server });
        const meta = Object.assign(document.createElement('span'), {
          className: 'muted small',
          textContent: (r.https ? 'HTTPS' : 'HTTP') + (r.pinned ? ` · ${t('servers.pinned')}` : ''),
        });
        const use = Object.assign(document.createElement('button'), {
          type: 'button', className: r.active ? '' : 'primary', disabled: r.active,
          textContent: r.active ? t('servers.active') : t('servers.use'),
        });
        use.onclick = async () => {
          err.hidden = true;
          use.disabled = true;
          use.textContent = t('setup.checking');
          try {
            await api.serverUse(r.id);
            close(true);
          } catch (ex) {
            fail(ex);
            use.disabled = false;
            use.textContent = t('servers.use');
          }
        };
        const del = Object.assign(document.createElement('button'), {
          type: 'button', className: 'li-close', textContent: '×', title: t('servers.delete'),
        });
        del.hidden = r.active;
        del.onclick = async () => {
          if (!confirm(t('servers.delete.confirm', { server: r.server }))) return;
          try { render(await api.serverDelete(r.id)); } catch (ex) { fail(ex); }
        };
        li.append(name, meta, use, del);
        return li;
      }));
      if (!rows.length) list.textContent = t('servers.none');
    };
    err.hidden = true;
    modal.hidden = false;
    api.servers().then(render, fail);
    $('serversClose').onclick = () => close(false);
    $('serversAdd').onclick = async () => {
      modal.hidden = true;
      const status = await askForSetup({ cancellable: true });
      if (status) close(true);
      else modal.hidden = false;
    };
  });
}

export function showConnection(status) {
  const admin = status.admin !== false;
  $('connInfo').textContent = !admin
    ? t(status.configured ? 'conn.remote' : 'conn.none')
    : status.stored
      ? t('conn.info', { server: status.server, fp: status.fingerprint })
      : t('conn.none');
  // Besucher eines öffentlichen Viewers dürfen nichts umstellen
  for (const id of ['connSwitch', 'connNames', 'connChange', 'connDelete']) $(id).hidden = !admin;
}
