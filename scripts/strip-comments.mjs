#!/usr/bin/env node
// Prints JavaScript files with their comments removed, so the package checks search code and nothing
// else. A comment marker inside a string, a template or a regular expression is not a comment ('https://x'
// must not hide what follows it on the same line). Strings are kept as they are.
//   node scripts/strip-comments.mjs <file> [file ...]
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function strip(src) {
  let out = '';
  let i = 0;
  let last = ''; // last significant (non-space) character of the code so far, to tell a regex from a division
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; else if (src[j] === '\n' && c !== '`') break; j++; }
      out += src.slice(i, j + 1);
      i = j + 1;
      last = c;
      continue;
    }
    if (c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last))) { // a regular expression literal
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      last = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const f of process.argv.slice(2)) process.stdout.write(`${strip(fs.readFileSync(f, 'utf8'))}\n`);
}
