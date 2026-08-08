// Report storage abstraction.
//
// Generated reports (HTML/PDF) are never REQUIRED to live on the local disk:
//   - "disk"     (default off-Vercel): writes to ./reports as before.
//   - "supabase" (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set): uploads to a
//                Supabase Storage bucket (public); downloads use the public
//                object URL. Same project as the Postgres DB.
//   - "memory"   (on Vercel without storage credentials): nothing is written;
//                reportUrl() points at /reports/<file> and the route
//                regenerates the report on demand from the database.
// STORAGE_DRIVER=disk|supabase|memory can force a specific driver.
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_REPORTS_BUCKET = process.env.SUPABASE_REPORTS_BUCKET || 'reports';
const STORAGE_DRIVER = (process.env.STORAGE_DRIVER || '').toLowerCase();

function detectDriver() {
  if (STORAGE_DRIVER) {
    if (['disk', 'supabase', 'memory'].includes(STORAGE_DRIVER)) return STORAGE_DRIVER;
    console.warn(`[storage] unknown STORAGE_DRIVER "${STORAGE_DRIVER}", using disk`);
    return 'disk';
  }
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) return 'supabase';
  if (process.env.VERCEL) return 'memory';
  return 'disk';
}

const driver = detectDriver();

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const reportsDir = path.join(__dirname, '..', 'reports');

function ensureDiskDir() {
  try {
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  } catch (err) {
    console.warn('[storage] reports dir not writable:', err.message);
  }
}

function publicStorageUrl(fileName) {
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_REPORTS_BUCKET}/${fileName}`;
}

async function uploadToSupabase(fileName, body, contentType) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_REPORTS_BUCKET}/${fileName}?upsert=true`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'true'
    },
    body
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Supabase storage upload failed (${res.status}): ${detail.slice(0, 200)}`);
  }
}

function contentTypeFor(fileName) {
  return fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/html; charset=utf-8';
}

// Save a generated report. Returns { size }. Throws when persistence fails
// (caller should fall back to on-demand regeneration via /reports).
async function saveReport(fileName, body, contentType) {
  const size = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
  if (driver === 'disk') {
    ensureDiskDir();
    fs.writeFileSync(path.join(reportsDir, fileName), body);
    return { size };
  }
  if (driver === 'supabase') {
    await uploadToSupabase(fileName, body, contentType);
    return { size };
  }
  return { size };
}

// Read a report back (for the /reports route). Returns { buffer, contentType }
// or null when not found in the current backend.
async function getReport(fileName) {
  if (driver === 'disk') {
    try {
      return { buffer: fs.readFileSync(path.join(reportsDir, fileName)), contentType: contentTypeFor(fileName) };
    } catch {
      return null;
    }
  }
  if (driver === 'supabase') {
    try {
      const res = await fetch(publicStorageUrl(fileName));
      if (!res.ok) return null;
      return {
        buffer: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') || contentTypeFor(fileName)
      };
    } catch (err) {
      console.warn('[storage] supabase fetch failed:', err.message);
      return null;
    }
  }
  return null;
}

// Public URL for a report. In supabase mode this is the direct storage URL
// (stored in the DB as pdfUrl / used for dashboard links); otherwise it goes
// through /reports/<file>, which serves from disk or regenerates on demand.
function reportUrl(fileName) {
  if (driver === 'supabase') return publicStorageUrl(fileName);
  return `${PUBLIC_URL}/reports/${encodeURIComponent(fileName)}`;
}

// URL used when persistence failed (or is disabled): the /reports route
// regenerates the report on demand.
function fallbackReportUrl(fileName) {
  return `${PUBLIC_URL}/reports/${encodeURIComponent(fileName)}`;
}

module.exports = {
  driver,
  reportsDir,
  saveReport,
  getReport,
  reportUrl,
  fallbackReportUrl,
  contentTypeFor
};
