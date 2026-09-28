// Single source of truth for the public base URL used in every link we put in
// an email or store in the DB (tokenized feedback links, dashboard links,
// report links, and the cron's self-URL).
//
// Resolution order:
//   1. APP_BASE_URL
//   2. PUBLIC_URL
//   3. http://localhost:$PORT  (local development only)
//
// The bug this prevents: steps 1-2 are read once at import, so if the variable
// is missing, renamed, or typo'd in the Vercel project, every link silently
// degrades to `http://localhost:3000` and clients receive a dead link. That is
// exactly what happened in a manual test. In production we now REFUSE any
// loopback value and fall back to the canonical domain, loudly, instead of
// emailing broken links.

const CANONICAL_BASE_URL = 'https://feedback.craftsmenmedia.com';

// localhost / 127.0.0.1 / 0.0.0.0 / [::1], with or without scheme and port.
const LOOPBACK_RE = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i;

function isProduction(env = process.env) {
  return env.VERCEL === '1' || env.NODE_ENV === 'production';
}

function isLoopback(value) {
  return LOOPBACK_RE.test(String(value || '').trim());
}

function stripTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

// Resolve from the environment. Never returns a loopback value in production.
function resolveBaseUrl(env = process.env) {
  const production = isProduction(env);
  const configured = [env.APP_BASE_URL, env.PUBLIC_URL].map(stripTrailingSlash).filter(Boolean);

  for (const value of configured) {
    if (!isLoopback(value)) return value;
    if (production) {
      console.warn(`[baseUrl] Ignoring loopback ${value === configured[0] ? 'APP_BASE_URL' : 'PUBLIC_URL'}="${value}" in production.`);
    }
  }

  if (production) {
    console.warn(`[baseUrl] No usable APP_BASE_URL/PUBLIC_URL in production; falling back to ${CANONICAL_BASE_URL}. Set APP_BASE_URL in the Vercel project.`);
    return CANONICAL_BASE_URL;
  }

  // Local dev: honour a loopback value if given, otherwise default.
  return configured[0] || `http://localhost:${Number(env.PORT) || 3000}`;
}

// Same, for a value passed in by a caller (e.g. appBaseUrl from a job). An
// explicit non-loopback value always wins so tests/dev can point anywhere; a
// loopback or missing value is only honoured outside production.
function coerceBaseUrl(value, env = process.env) {
  const v = stripTrailingSlash(value);
  if (v && !isLoopback(v)) return v;
  if (isProduction(env)) {
    if (v) console.warn(`[baseUrl] Refusing loopback base URL "${v}" in production; using ${CANONICAL_BASE_URL}.`);
    return CANONICAL_BASE_URL;
  }
  return v || `http://localhost:${Number(env.PORT) || 3000}`;
}

module.exports = { CANONICAL_BASE_URL, resolveBaseUrl, coerceBaseUrl, isLoopback, isProduction, stripTrailingSlash };
