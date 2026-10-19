// Pure helpers of the share dialog (no DOM, testable in Node).

// The address of the share gateway as an origin. Empty = the page's own origin (the gateway sits
// behind the same reverse proxy as the console). Plain http is accepted only for this machine, because
// the admin secret and every link would travel unencrypted.
export function normalizeGateway(input, pageOrigin) {
  const raw = String(input ?? '').trim();
  if (!raw) return pageOrigin;
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
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
