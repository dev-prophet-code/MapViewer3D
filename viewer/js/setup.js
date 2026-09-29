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
        const status = await api.setupSave($('setupServer').value, +$('setupPort').value || 8088, $('setupToken').value);
        close(status);
      } catch (ex) {
        err.textContent = errorText(ex);
        err.hidden = false;
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

export function showConnection(status) {
  const admin = status.admin !== false;
  $('connInfo').textContent = !admin
    ? t(status.configured ? 'conn.remote' : 'conn.none')
    : status.stored
      ? t('conn.info', { server: status.server, fp: status.fingerprint })
      : t('conn.none');
  // Besucher eines öffentlichen Viewers dürfen nichts umstellen
  for (const id of ['connNames', 'connChange', 'connDelete']) $(id).hidden = !admin;
}
