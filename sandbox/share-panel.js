// Share links in the sandbox edition. The links are issued by the share gateway (service "mvshare"
// of the MapViewer3D stack); the sandboxed page has no network, so it cannot talk to the gateway.
// The dialog here only explains where links are made: the gateway's own admin page.
const $ = (id) => document.getElementById(id);
import { t } from '../web/js/i18n.js';

export function initShare() {
  $('shareClose').onclick = () => { $('share').hidden = true; };
}

export function openShare() {
  for (const id of ['shareWait', 'shareConnect', 'shareMain', 'shareError']) $(id).hidden = true;
  $('share').querySelector('[data-i18n="share.intro"]').hidden = true; // it describes creating links in this dialog
  const box = $('shareError');
  box.textContent = '';
  const hint = document.createElement('div');
  hint.id = 'shareSandbox';
  hint.className = 'small pre';
  hint.textContent = t('share.sandbox');
  document.getElementById('shareSandbox')?.remove();
  $('shareConnect').before(hint);
  $('share').hidden = false;
}

export function forgetShare() {}
