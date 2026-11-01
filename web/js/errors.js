// Errors carry a code the UI translates (err.<code> in i18n.js) and an optional detail.
export function fail(code, detail = '') {
  const e = new Error(`${code}: ${detail}`);
  e.code = code;
  e.detail = detail;
  return e;
}
