// Statischer Testserver nur für localhost. Liefert index.html und three/ aus diesem Ordner.
// Die Daten (Netze, UVs, Texturen, Platzierungen) lädt die Seite zur Laufzeit vom CDN-Branch (raw.githubusercontent.com).
// Optional: LOCAL_CDN=<Ordner eines lokalen cdn-Klons> liefert diesen unter /cdn/ (Aufruf mit ?cdn=local), z. B. zum Testen vor einem Push.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const localCdn = process.env.LOCAL_CDN ? path.resolve(process.env.LOCAL_CDN) : null;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };
const port = Number(process.env.PORT || 8801);

http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const isCdn = localCdn && u.startsWith('/cdn/');
  const base = isCdn ? localCdn : root;
  const file = isCdn ? path.join(localCdn, u.slice(5)) : path.join(root, u === '/' ? 'index.html' : u);
  if (u.includes('/.git') || !file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('nicht gefunden'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
