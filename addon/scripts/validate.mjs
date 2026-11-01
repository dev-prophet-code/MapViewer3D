#!/usr/bin/env node
// Prüft das Addon-Paket: Manifest, Berechtigungen, Sandbox-Tauglichkeit (kein Netzwerk) und Geheimnisse.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (m) => { console.error('Validierung fehlgeschlagen: ' + m); process.exit(1); };
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'addon.json'), 'utf8'));
const version = fs.readFileSync(path.join(root, '..', 'VERSION'), 'utf8').trim();
const ALLOWED = { players: ['read'], ops: ['read'], database: ['read', 'write'], admin: ['grant-items'], rewards: ['grant'], server: ['status', 'restart'], files: ['addon-data'], broadcast: ['send'], scheduler: ['server'] };

for (const k of ['id', 'name', 'description', 'author', 'version']) if (typeof manifest[k] !== 'string' || !manifest[k].trim()) fail(k + ' fehlt');
if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(manifest.id)) fail('id ungültig');
if (manifest.version !== version) fail(`Version ${manifest.version} ≠ VERSION ${version}`);
if (manifest.type !== 'ui' || manifest.schemaVersion !== 1) fail('type/schemaVersion');
const entry = manifest.entry && manifest.entry.path;
if (typeof entry !== 'string' || entry.startsWith('/') || entry.split('/').some((p) => p === '..' || p === '.')) fail('entry.path ungültig');
for (const [ns, acts] of Object.entries(manifest.permissions || {})) for (const a of acts) if (!(ALLOWED[ns] || []).includes(a)) fail(`unbekannte Berechtigung ${ns}:${a}`);
if (!manifest.permissions || typeof manifest.permissions !== 'object') fail('permissions fehlt');
if ((manifest.permissions.database || []).includes('write')) fail('database:write ist für dieses Addon nicht erlaubt (nur lesen)');

const full = fs.readFileSync(path.join(root, entry), 'utf8');
// three.js / OrbitControls (Fremdcode, MIT) sind eingebettet; geprüft wird der eigene Code. Die Bibliothek ruft ohne Loader kein fetch auf.
const page = full.replace(/<script>(?:(?!<\/script>)[\s\S])*?globalThis\.(?:THREE|OrbitControls)\s*=[\s\S]*?<\/script>/g, '<!-- vendor -->');
if (full.length - page.length < 1000000) fail('Fremdcode nicht erkannt');
if (Buffer.byteLength(full) > 20 * 1048576) fail('Seite größer als 20 MiB');
// Die Console-Sandbox erlaubt weder Netzwerk noch nachgeladene Dateien.
const FORBIDDEN = [/\bfetch\s*\(/, /XMLHttpRequest/, /new\s+WebSocket/, /new\s+EventSource/, /navigator\.sendBeacon/, /importScripts/, /<(script|link|img|iframe|source)[^>]+(src|href)\s*=\s*["']?(https?:)?\/\//i, /localStorage|sessionStorage/, /\beval\s*\(/, /new\s+Function\s*\(/];
for (const re of FORBIDDEN) if (re.test(page)) fail('Sandbox-Verstoß: ' + re);
if (/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/.test(page)) fail('unsicheres HTML-Einfügen im eigenen Code');
const SECRETS = [/github_pat_[A-Za-z0-9_]{20,}/, /ghp_[A-Za-z0-9]{30,}/, /dak_[A-Za-z0-9_-]{16,}/, /\b(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
for (const re of SECRETS) { const m = full.match(re); if (m) fail('mögliches Geheimnis im Paket: ' + m[0].slice(0, 12) + '…'); }
console.log(`OK: ${manifest.id} ${manifest.version} (${(Buffer.byteLength(full) / 1048576).toFixed(1)} MiB)`);
