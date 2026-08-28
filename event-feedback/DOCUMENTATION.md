# Service Feedback System — Technical Documentation (A–Z)

**Stack:** Node.js · Express · SQLite (`better-sqlite3`) · Google Gemini AI · Nodemailer (Hostinger SMTP) · PDFKit · node-cron

**Version:** 1.2
**Prepared for:** PureDesigners (admin: tahir@puredesigners.com)

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Terminology: Event → Service](#2-terminology-event--service)
3. [Architecture](#3-architecture)
4. [Tech Stack](#4-tech-stack)
5. [Folder Structure](#5-folder-structure)
6. [Configuration & Environment Variables](#6-configuration--environment-variables)
7. [Database Schema](#7-database-schema)
8. [Feature 1 — Feedback Form & Submission API](#8-feature-1--feedback-form--submission-api)
9. [Feature 2 — Data Cleaning Rules](#9-feature-2--data-cleaning-rules)
10. [Feature 3 — AI Analysis (Gemini)](#10-feature-3--ai-analysis-gemini)
11. [Feature 4 — PDF Report Generation](#11-feature-4--pdf-report-generation)
12. [Feature 5 — Email Delivery (Hostinger SMTP)](#12-feature-5--email-delivery-hostinger-smtp)
13. [Feature 6 — Dashboard & Analytics](#13-feature-6--dashboard--analytics)
14. [Feature 7 — Date-Range Combined Report](#14-feature-7--date-range-combined-report)
15. [Feature 8 — Monthly Auto-Send to Clients](#15-feature-8--monthly-auto-send-to-clients)
16. [Feature 9 — 6-Month Combined AI Trend Report (Cron)](#16-feature-9--6-month-combined-ai-trend-report-cron)
17. [Feature 10 — Client Management Admin Page](#17-feature-10--client-management-admin-page)
18. [API Reference Summary](#18-api-reference-summary)
19. [Error Handling & Edge Cases](#19-error-handling--edge-cases)
20. [Testing](#20-testing)
21. [Deployment Notes](#21-deployment-notes)
22. [Future Improvements](#22-future-improvements)

---

## 1. System Overview

The Service Feedback System automatically collects, analyzes, and reports client feedback for services rendered. It replaces manual feedback collection with a fully automated pipeline:

1. **Every month, on a fixed date**, the system emails a unique feedback-form link to all **active clients** (planned cron job).
2. Each client opens the link and submits feedback through a **branded web form**.
3. The submission is **cleaned** (normalized), **analyzed by AI (Gemini)** for sentiment/summary/urgency, converted into a **branded HTML + PDF report**, and **emailed to the admin**.
4. All submissions are stored in a **SQLite database** and shown on an **analytics dashboard** with date-range, sentiment, and service filters.
5. On demand (and eventually on a fixed schedule), the system aggregates all feedback in a period, runs it through AI for a **combined trend report** (sentiment breakdown, overall summary, top highlights, top improvements), generates a PDF, and emails it to the admin.

**No manual triggering is required for form distribution** — the monthly send and the periodic combined report run on scheduled jobs.

**What is implemented today:** the entire pipeline in step 1–5 (scheduled monthly sends → form → clean → AI → PDF → email → DB → dashboard → combined report).

**Phase 2 (implemented):** the automation layer — `clients` table, monthly cron send with per-month token links, `feedback_requests` tracking, and a scheduled 6-month trend report. See Sections 15 and 16.

---

## 2. Terminology: Event → Service

The system is being recalibrated from an **event feedback** framework to a **service feedback** framework. Conceptually nothing changes; only the naming:

| Old (current code) | New (target) | Notes |
|---|---|---|
| `eventName` | `serviceName` / `serviceType` | The service rendered (e.g. "Branding Package", "Website Revamp") |
| `eventDate` | *(replaced by `month`)* | Feedback is tied to the monthly cycle it was requested in, not an event date |
| Feedback sent for events | Feedback sent monthly for services | Form is emailed on a fixed date each month, not after an event |

**DB migration (Phase 2 — done):**

- `feedback_reports.eventName` → `feedback_reports.serviceType` (new submissions store the service name the form was pre-filled with via the client's record).
- `feedback_reports.eventDate` → `feedback_reports.month` (e.g. `"2026-08"`), populated from the `feedback_requests` row that issued the link. Legacy full-date values (`"2026-08-10"`) are preserved and still match `from`/`to` filters.
- A nullable `client_id` column links each row back to `clients`.
- The migration runs automatically at startup (`migrateFeedbackReports()` in `server/db.js`) and is backward compatible: existing rows are kept with their data, and the legacy `eventName` query-filter parameter still works (alias for `serviceType`).

The submission pipeline's internal record shape still uses `eventName`/`eventDate` (from `server/cleanData.js`); only the database columns were renamed.

---

## 3. Architecture

### 3.1 Current pipeline (implemented)

```
Client fills form (public/index.html)
        │  POST /api/feedback
        ▼
server/cleanData.js ── trim/normalize → cleanedData
        ▼
server/gemini.js ── Gemini 2.5 Flash → sentiment, summary, highlights,
                    improvementSuggestions, urgency  (fallback if no API key)
        ▼
server/report.js ── branded HTML report
        ▼
server/pdf.js ── PDFKit renders branded PDF (reports/<submissionId>.pdf)
        ▼
server/email.js ── Nodemailer → Hostinger SMTP → admin (PDF attached + link)
        ▼
server/db.js ── row stored in SQLite (data/feedback.db → feedback_reports)
        ▼
public/dashboard.html ── GET /api/feedback + GET /api/stats (filters)
        │
        └── POST /api/reports/combined ── Gemini aggregate → combined PDF → admin email
```

### 3.2 Automation layer (Phase 2 — implemented)

```
Cron 1 (monthly, e.g. 28th @ 09:00)          Cron 2 (every 6 months, e.g. Jan & Jul)
        │                                          │
        ▼                                          ▼
SELECT * FROM clients WHERE status='active'   SELECT * FROM feedback_reports
        │                                          WHERE month BETWEEN start AND end
        ▼                                          │
for each client:                                  ▼
  token = crypto.randomUUID()                  Gemini combined analysis
  INSERT feedback_requests(client_id, month,    (chunked map-reduce if large)
    token, submitted=0)                         ▼
  email link https://<domain>/feedback/<token> branded HTML → PDF
        │                                          ▼
        ▼                                     email combined report to admin
Client opens link → form pre-filled from client record
        │
        ▼
POST /api/feedback (token validated; feedback_requests.submitted → 1)
        │
        ▼
existing pipeline (clean → AI → PDF → admin email → DB)
```

---

## 4. Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Backend runtime | Node.js ≥ 18, Express 5 | `server/index.js` |
| Database | SQLite via `better-sqlite3` | File at `data/feedback.db`, WAL mode |
| AI analysis | `@google/generative-ai` (Gemini) | Model default `gemini-3.6-flash`, override with `GEMINI_MODEL` |
| Email | Nodemailer → Hostinger SMTP | Port 465, SSL/TLS |
| PDF generation | PDFKit | Branded, Inter fonts, logo embedding |
| Scheduling | `node-cron` | Two jobs: monthly send + 6-month report |
| Admin sessions | Signed httpOnly cookie (`crypto` HMAC-SHA256, no extra dependency) | Single fixed login via `ADMIN_USERNAME`/`ADMIN_PASSWORD`/`SESSION_SECRET` |
| Frontend | Static HTML + Tailwind | `public/index.html` (form), `public/dashboard.html`, `public/admin-clients.html` (internal), `public/login.html` |
| Secrets | `dotenv` | `.env` file |

---

## 5. Folder Structure

```
event-feedback/
├── server/
│   ├── index.js          # Express app: all routes, orchestration, static files, cron registration
│   ├── cleanData.js      # Input normalization + submissionId
│   ├── gemini.js         # AI analysis (single + combined), fallbacks, sentiment colors
│   ├── report.js         # Branded HTML report builders
│   ├── pdf.js            # PDFKit renderers (single + combined)
│   ├── email.js          # Nodemailer transports + email bodies (admin + client)
│   ├── db.js             # SQLite connection, schema, migration, queries, stats, clients/requests CRUD
│   ├── storage.js        # Report storage driver: disk | supabase | memory (+ on-demand regen)
│   ├── jobs/
│   │   ├── monthlySend.js    # Cron 1: email feedback links to active clients (tokenized)
│   │   └── sixMonthReport.js # Cron 2: 6-month combined trend report (+ chunked map-reduce)
│   ├── fonts/            # Inter-Regular.ttf, Inter-Bold.ttf (PDF fonts)
│   └── tests/
│       ├── cleanData.test.js
│       └── phase2.test.js # tokens, idempotency, 6-month range, migration, map-reduce
├── public/
│   ├── index.html        # Feedback form (generic)
│   ├── dashboard.html    # Analytics dashboard
│   ├── admin-clients.html # Internal client management page (admin session required)
│   ├── login.html         # Admin sign-in page (session login)
│   └── assets/logo.png   # Official logo (form, dashboard, reports, PDFs)
├── reports/              # Generated HTML + PDF files (local dev, disk driver only)
├── data/                 # SQLite database (feedback.db)
├── .env                  # Secrets (never committed)
├── .env.example
├── package.json
└── README.md
```

---

## 6. Configuration & Environment Variables

Copy `.env.example` → `.env` and fill in. **Never commit `.env`.**

| Variable | Purpose | Default |
|---|---|---|
| `GEMINI_API_KEY` | Google AI Studio API key for analysis | *(empty → fallback analysis)* |
| `GEMINI_MODEL` | Gemini model name | `gemini-3.6-flash` |
| `SMTP_HOST` | Hostinger SMTP host | `smtp.hostinger.com` |
| `SMTP_PORT` | SMTP port | `465` |
| `SMTP_USER` | Mailbox address (sender) | `tahir@puredesigners.com` |
| `SMTP_PASS` | Mailbox password | *(empty → emails skipped)* |
| `ADMIN_EMAIL` | **Optional.** Organizer/team copy of every per-submission report + recipient of internal alerts (no-response, low-score). If unset, no admin email is sent — but the client's Account Manager and `LEADERSHIP_EMAILS` (on low scores) still receive the report normally. | *(empty)* |
| `LEADERSHIP_EMAILS` | Comma-separated leadership addresses that also receive the **full report email (with PDF)** when a submission's overall score (`agency_leadership_score`) is below `ALERT_LOW_SCORE_THRESHOLD`; blank = none, entries trimmed, empty entries ignored, de-duplicated against `ADMIN_EMAIL`/`account_manager_email` | *(empty)* |
| `PUBLIC_URL` | Public base URL for links in emails/PDFs | `http://localhost:3000` |
| `PORT` | Server port | `3000` |
| `DB_PATH` | Path to SQLite file (relative to project root) | `data/feedback.db` |
| `APP_BASE_URL` | Base URL used to build `/feedback/<token>` links | `PUBLIC_URL` |
| `MONTHLY_SEND_CRON` | Cron expression for the monthly form send | `0 9 28 * *` |
| `SIX_MONTH_REPORT_CRON` | Cron expression for the 6-month report | `0 9 1 1,7 *` |
| `CRON_SECRET` | Optional secret for external cron-trigger endpoints (`x-cron-secret` header) | *(empty → no auth check)* |
| `ALERT_NO_RESPONSE_DAYS` | Days an unanswered monthly feedback request may age before the client gets a "Gentle Reminder" email and (if `ADMIN_EMAIL`/`ALERT_EMAIL` is set) an internal alert | `5` |
| `ADMIN_USERNAME` | Admin login username (single fixed account — no registration) | *(empty → auth disabled + startup warning)* |
| `SUPABASE_URL` | Supabase project URL — with `SUPABASE_SERVICE_ROLE_KEY` enables the `supabase` storage driver | *(empty → driver auto-detected)* |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (storage uploads; keep secret) | *(empty → driver auto-detected)* |
| `SUPABASE_REPORTS_BUCKET` | Storage bucket name for generated reports | `reports` |
| `STORAGE_DRIVER` | Force a report storage driver: `disk`, `supabase`, or `memory` | *(auto-detect)* |
| `ADMIN_PASSWORD` | Admin login password (single fixed account — no registration) | *(empty → auth disabled + startup warning)* |
| `SESSION_SECRET` | Random secret that signs the admin session cookie (HMAC-SHA256) | *(empty → auth disabled + startup warning)* |
| `SYNC_SECRET` | Static secret for the Google Sheets sync endpoint (`X-Sync-Secret` header, `POST /api/clients/sync`) | *(empty → sync endpoint rejects all requests — fail closed)* |
| `SHEET_CSV_URL` | **Machine-readable pull source** — public read-only CSV link of the client Google Sheet (File → Share → Publish to web → CSV). Used by the "Sync from Google Sheet" button (`POST /api/clients/sync-from-sheet`) to pull clients server-side | *(empty → sync-from-sheet returns a clear error — fail closed)* |
| `SHEET_EDIT_URL` | **Human link to open and edit the sheet** — the normal shareable Google Sheets URL, e.g. `https://docs.google.com/spreadsheets/d/<sheet-id>/edit`. Rendered as the "Open Google Sheet" link on the admin client page (new tab, via session-protected `GET /api/config/sheet`); not used for data. Clickers need edit access in Google | *(empty → link hidden, small note shown instead)* |

All variables have safe defaults — the app runs with nothing but the optional secrets set.

Behavior without secrets:

- Without `GEMINI_API_KEY` → rating-based fallback analysis (`usedAi: false`).
- Without `SMTP_PASS` → emails skipped, rows still stored (`emailSent: false`).

---

## 7. Database Schema

SQLite file: `data/feedback.db`. WAL mode enabled. Schema is created automatically at startup (`CREATE TABLE IF NOT EXISTS`).

### 7.1 `feedback_reports`

One row per completed submission.

| Column | Type | Notes |
|---|---|---|
| `submissionId` | TEXT PK | `FB-<base36 timestamp><random hex>` |
| `timestamp` | TEXT | ISO 8601 |
| `serviceType` | TEXT | Service rendered (renamed from `eventName` by the Phase 2 migration) |
| `month` | TEXT | Request month, e.g. `2026-08`; legacy rows keep full dates (`2026-08-10`) |
| `client_id` | INTEGER | Nullable FK → `clients.id` (set when submitted via a token link) |
| `attendeeName` | TEXT | Defaults to `Anonymous` |
| `attendeeEmail` | TEXT | |
| `hasValidEmail` | INTEGER | `0/1` |
| `companyName` | TEXT | Optional |
| `rating` | INTEGER | 1–5 |
| `comments` | TEXT | Default `No comments provided` |
| `suggestions` | TEXT | Default `No suggestions provided` |
| `sentiment` | TEXT | `Positive` / `Neutral` / `Negative` |
| `summary` | TEXT | AI-generated |
| `urgency` | TEXT | `Low` / `Medium` / `High` |
| `highlights` | TEXT | JSON array |
| `improvementSuggestions` | TEXT | JSON array |
| `pdfUrl` | TEXT | Link to generated PDF |
| `emailSent` | INTEGER | `0/1` |
| `created_at` | TEXT | SQLite default `datetime('now')` |

### 7.2 `clients`

All clients who receive the monthly form.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `name` | TEXT | Client name (the single "Client Name" — this is what the app collects, displays, and pre-fills everywhere) |
| `email` | TEXT | Client email |
| `company_name` | TEXT | Legacy column kept in the schema — **unused**; the app no longer reads/writes it |
| `service_type` | TEXT | Legacy column kept in the schema — **unused**; the app no longer reads/writes it (the "Service Type" client field was removed) |
| `status` | TEXT | `active` / `inactive` |
| `account_manager_email` | TEXT | **Account Manager Email** — receives a copy of this client's feedback notification. Optional, nullable, and validated against the same `^[^\s@]+@[^\s@]+\.[^\s@]+$` rule as the client email (invalid values are rejected by the API and skipped during Sheets sync). |
| `created_at` | TEXT | ISO timestamp |

> The legacy `account_manager` (Account Manager **Name**) column is retained in the database schema for backward compatibility but is no longer read, written, or displayed by the app — only `account_manager_email` is used.

### 7.3 `feedback_requests`

Tracks each monthly form-send per client — prevents duplicate sends and shows who has/hasn't responded.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `client_id` | INTEGER FK | → `clients.id` |
| `month` | TEXT | e.g. `"2026-08"` |
| `token` | TEXT | Unique token in the feedback link (one per month) |
| `sent_at` | TEXT | ISO timestamp |
| `submitted` | INTEGER | `0` = not submitted, `1` = submitted |

`UNIQUE(client_id, month)` guarantees one request per client per month (idempotency); `token` is `UNIQUE`.

**Why a new token every month:** prevents link reuse across months, ties each submission to the correct client and month automatically (the form doesn't need to ask "who are you"), and a token can only be submitted once.

---

## 8. Feature 1 — Feedback Form & Submission API

### 8.1 The form (`public/index.html`)

Fields:

- Service / Project name (text)
- Attendee name (text)
- Attendee email (text)
- Company name (optional)
- Rating (1–5)
- Feedback / comments (long text)
- Suggestions / improvements (long text)

### 8.2 Endpoint: `POST /api/feedback`

Receives raw form JSON, then orchestrates the whole pipeline:

1. `cleanData(raw)` → `cleanedData` (Section 9).
2. `analyzeFeedback(cleanedData)` → Gemini analysis (Section 10), or fallback when no API key / on failure.
3. `sentimentColor(sentiment)` → badge colors for display.
4. `reportHTML(record)` → branded HTML, saved via the storage driver (Section 18) — `reports/<submissionId>.html` locally.
5. `buildPdf(record)` → branded PDF via the storage driver; `pdfUrl` is the storage URL (or `/reports/<file>` fallback that regenerates on demand).
6. `sendFeedbackEmail(...)` → SMTP email to admin with PDF attached and link (skipped if no `SMTP_PASS`; failure logged, not fatal).
7. `insertFeedback(record)` → row stored in `feedback_reports` **even if email/AI failed**.

**Response (201):** `{ ok, submissionId, timestamp, eventName, serviceType, month, tokenUsed, rating, sentiment, sentimentColor, urgency, summary, usedAi, emailSent, emailError, pdfUrl, pdfFileName, pdfSize }`.

### 8.3 Token-based access (Phase 2 — implemented)

- Link format: `https://<domain>/feedback/<token>`.
- Server validates the token against `feedback_requests` (not already `submitted = 1`).
- Form is pre-filled from the client's record (name, email, service type).
- On successful submission the matching row is marked `submitted = 1`; the `month` is carried into `feedback_reports` along with `client_id`.
- Duplicate attempts with the same token are rejected with a friendly message (HTTP 409).
- Invalid/expired/already-used tokens show a friendly "link invalid or already used" page.
- Untokened `POST /api/feedback` continues to work unchanged (manual/testing submissions).

---

## 9. Feature 2 — Data Cleaning Rules

Implemented in `server/cleanData.js`:

| Rule | Behavior |
|---|---|
| Trim strings | Leading/trailing whitespace removed from all text fields |
| Empty name | Defaults to `"Anonymous"` |
| Invalid email | `hasValidEmail = false` — submission still accepted |
| Rating | Must be integer 1–5, else defaults to `3` |
| Empty comments | Defaults to `"No comments provided"` |
| Empty suggestions | Defaults to `"No suggestions provided"` |
| `submissionId` | `FB-` + base36 timestamp + 4 random hex bytes |
| `timestamp` | ISO 8601 |

Output is `cleanedData`, passed to the AI step.

---

## 10. Feature 3 — AI Analysis (Gemini)

Implemented in `server/gemini.js`.

### 10.1 Single submission — `analyzeFeedback`

**Prompt instruction:** return **strictly** the following JSON — no markdown fences, no explanation:

```json
{
  "sentiment": "Positive | Neutral | Negative",
  "summary": "2-3 sentence summary",
  "highlights": ["point 1", "point 2"],
  "improvementSuggestions": ["point 1", "point 2"],
  "urgency": "Low | Medium | High"
}
```

Inputs sent to the model: service/project name, rating, comments, suggestions.

**Post-processing:**

- `parseGeminiJson()` strips markdown fences and extracts the JSON object; wrapped in try/catch.
- `normalizeAnalysis()` validates each field and falls back to `fallbackAnalysis(data)` for anything missing/invalid:
  - sentiment from rating: ≥ 4 → Positive, 3 → Neutral, else Negative
  - urgency: Negative → High, Neutral → Medium, else Low
- Sentiment → badge colors:
  - Positive → green (`#16a34a` on `#dcfce7`)
  - Neutral → orange (`#ea580c` on `#ffedd5`)
  - Negative → red (`#dc2626` on `#fee2e2`)
- Final record = `cleanedData` + AI output + colors + `submissionId` + `timestamp`.

### 10.2 Combined analysis — `analyzeCombined`

Input: all rows in the requested range, formatted as `#N Project/Service | Rating | Feedback | Suggestions`.

**Prompt instruction:** strict JSON:

```json
{
  "overallSentimentBreakdown": { "positive": 0, "neutral": 0, "negative": 0 },
  "overallSummary": "2-3 sentence summary across the range",
  "keyHighlights": ["point 1", "point 2"],
  "topImprovementSuggestions": ["point 1", "point 2"]
}
```

Fallback (no API key / failure): counts computed from stored sentiments, summary generated from row count, highlights from the first 3 rows.

### 10.3 Chunked map-reduce (Phase 2 — implemented in `server/jobs/sixMonthReport.js`)

If a 6-month period yields a large volume (~40–50+ rows), the single prompt may exceed the model's input limit. The job does:

1. **Map:** split rows into chunks (~20 each) and ask Gemini to summarize each chunk.
2. **Reduce:** feed all chunk summaries back to Gemini for one final combined report (per-chunk sentiment counts are summed across chunks for the final breakdown).

---

## 11. Feature 4 — PDF Report Generation

Implemented in `server/pdf.js` using **PDFKit** (not puppeteer — no headless browser dependency).

- Page: A4 (`595.28 × 841.89` pt), 48 pt margins.
- Branding: accent bar `#FFF000`, headings `#4ade80`, body black `#111827`, muted gray, row backgrounds `#f9fafb`.
- Fonts: `server/fonts/Inter-Regular.ttf` + `Inter-Bold.ttf` (fallback Helvetica if missing).
- Logo: automatically embedded if `public/assets/logo.png` exists.
- Single report sections: service info, attendee info, rating stars, sentiment badge, AI summary, highlights, improvement suggestions, original comments, timestamp & submission ID.
- Combined report: one section per submission plus the aggregate analysis.
- Output files land in `reports/` and are served at `/reports/<file>`.

### 11.1 Report storage drivers (`server/storage.js`)

HTML/PDF files never *require* local disk. `server/storage.js` exposes `saveReport`, `getReport`, `reportUrl`, and `fallbackReportUrl` behind a pluggable driver:

| Driver | When used | Behavior |
|---|---|---|
| `disk` | local dev (default without `VERCEL`) | Writes to `reports/` exactly as before; `/reports/<file>` serves from disk |
| `supabase` | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set | Uploads to the `SUPABASE_REPORTS_BUCKET` bucket (public); `pdfUrl` becomes the direct storage object URL |
| `memory` | `VERCEL` set without Supabase credentials | Nothing is written; `pdfUrl` falls back to `/reports/<file>`, and every `/reports/<file>` request that isn't found (or was never saved) is **regenerated on demand** from the database (`getFeedbackReport` for single reports, `queryFeedback` + `analyzeCombined` for `combined-<from>-to-<to>` files) |

`STORAGE_DRIVER=disk|supabase|memory` forces a driver. If a save fails (e.g. readonly FS), the submission still succeeds: the PDF is emailed as an in-memory attachment and `pdfUrl` falls back to the regenerating `/reports/<file>` link.

---

## 12. Feature 5 — Email Delivery (Hostinger SMTP)

Implemented in `server/email.js` with Nodemailer.

| Setting | Value |
|---|---|
| Host | `smtp.hostinger.com` |
| Port | `465` |
| Security | SSL/TLS (`secure: true`) |
| Username | `tahir@puredesigners.com` |
| Password | `SMTP_PASS` from `.env` |

- **Recipient:** the admin (`ADMIN_EMAIL`, if set) and any `account_manager_email` / `LEADERSHIP_EMAILS` (low score) — never the client. If `ADMIN_EMAIL` is unset, the report still goes to the Account Manager / leadership; if there is no recipient at all, the email is skipped with a log (no crash).
- **Account Manager copy:** if the submitting client has a non-empty, valid `account_manager_email`, the **same** single-submission email is also sent to that address (added as an extra recipient, not a separate template). If `account_manager_email` is blank/unset for that client, the copy is silently skipped — it never causes a blank-recipient error or crash.
- **Single submission email:** subject `New Client Feedback – <Service Name> (<Rating>/5)`; body has summary, rating, sentiment, urgency, PDF link, submission ID, timestamp; PDF attached as `<submissionId>.pdf`.
- **Combined email:** subject `Combined Client Feedback Report <from> to <to> (<count> submissions)`; body has overall summary, sentiment breakdown, key highlights, top improvements, PDF link; PDF attached.
- Sending failures are caught and logged; the row is still stored.

### 12.1 Monthly client email (Phase 2 — implemented)

`sendClientFeedbackRequest(config, client, link)` in `server/email.js` sends each **client** (not the admin) a personalized email:

- Subject e.g. `Your feedback matters — <Company> service update`
- Body includes the unique link `https://<domain>/feedback/<token>` and a friendly note.
- The monthly job loops over all active clients; logs per-client success/failure; skips clients with missing/invalid emails.
- `sendNoFeedbackEmail(config, from, to)` notifies the admin when a 6-month period had zero submissions.

---

## 13. Feature 6 — Dashboard & Analytics

`public/dashboard.html` + two endpoints.

### `GET /api/feedback?from=&to=&sentiment=&eventName=`

Returns `{ ok, count, data: [...] }`. Each row includes `sentimentColor` and `htmlUrl`. Filters:

| Filter | Behavior |
|---|---|---|
| `from` / `to` | `YYYY-MM-DD`; matched against `month` (prefix match, so `2026-08` rows match `2026-08-01`–`2026-08-31`) |
| `sentiment` | Exact match (`Positive` / `Neutral` / `Negative`) |
| `serviceType` | Exact match (new name) |
| `eventName` | Legacy alias for `serviceType` — still accepted for old callers |

### `GET /api/stats?from=&to=`

Returns `{ ok, data }`:

- `total` — feedback count
- `avgRating` — 2-decimal average
- `sentimentCounts` — `{ Positive, Neutral, Negative }`
- `highUrgency` — count of `urgency === 'High'`
- `events` — sorted unique service list (populated from `serviceType`)
- `from`, `to`

### `GET /api/health`

`{ ok, geminiConfigured, smtpConfigured }` — useful for uptime checks.

### Admin auth (session login)

`public/login.html` is a branded, fetch-based sign-in page (no browser Basic Auth popup). `POST /api/login` checks `ADMIN_USERNAME` / `ADMIN_PASSWORD` (both compared with `crypto.timingSafeEqual`, constant-time; wrong username or password returns a generic 401 `Invalid credentials.`) and on success issues a signed **httpOnly** session cookie.

**Session mechanism:** a lightweight signed cookie (HMAC-SHA256 over `payload.signature` using `SESSION_SECRET`, verified with `timingSafeEqual`), payload `{ u, exp }` with a 24-hour expiry — deliberately no extra dependency (the project already uses `crypto` for tokens/verification). Cookie flags: `httpOnly`, `SameSite=Lax`, `Path=/`. `POST /api/logout` clears the cookie **and** revokes the token server-side (in-memory denylist, cleared on restart).

**Middleware (`requireAdminSession`):** applied to `/dashboard.html`, `/admin-clients.html`, `/api/clients`, `GET /api/feedback`, `/api/stats`, `/api/reports/combined`, and `/api/cron/*`. Without a valid session, `.html` page requests are redirected (302) to `/login.html`; API/XHR requests get `401 { ok: false, error: 'Not authenticated.' }`. If any of `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `SESSION_SECRET` is unset, auth is disabled and a warning is logged at startup. `POST /api/feedback`, `/`, and `/feedback/<token>` remain open.

---

## 14. Feature 7 — Date-Range Combined Report

### `POST /api/reports/combined` `{ from, to }`

1. Both dates required (`YYYY-MM-DD`), else 400.
2. `queryFeedback({ from, to })` — no rows → 404 with message.
3. `analyzeCombined(rows)` → aggregate analysis (Section 10.2).
4. `combinedHTML(meta, rows)` → saved as `reports/combined-<from>-to-<to>.html`.
5. `buildCombinedPdf(meta, rows)` → `reports/combined-<from>-to-<to>.pdf`.
6. `sendCombinedEmail(...)` → admin email with PDF attached.
7. Response includes `count`, `emailSent`, `emailError`, `pdfUrl`, `overallAnalysis`.

**Phase 2 note:** this is also the body of Cron 2 (Section 16) — the cron calls the same logic, but with `from`/`to` computed from the 6-month window, plus map-reduce for large volumes.

---

## 15. Feature 8 — Monthly Auto-Send to Clients

**Implemented in `server/jobs/monthlySend.js`** (`sendMonthlyFeedbackForms()`), registered with `node-cron` in `server/index.js`.

**Goal:** on a fixed date every month, automatically email the feedback form link to every active client.

### Logic

1. Cron triggers on the configured date (default **28th of every month at 09:00**, `MONTHLY_SEND_CRON`).
2. `SELECT * FROM clients WHERE status = 'active'`.
3. For each client:
   - Generate a unique token: `crypto.randomUUID()`.
   - Insert `feedback_requests { client_id, month: currentMonth ('YYYY-MM'), token, sent_at: now, submitted: 0 }` — skipped if a row for this (client, month) already exists.
   - Build link: `https://<domain>/feedback/<token>` from `APP_BASE_URL`.
   - Send the email via SMTP (`sendClientFeedbackRequest`, Section 12.1).
4. Log completion: how many emailed, how many failed/skipped. Missing/invalid emails are skipped (logged), never fatal to the batch.

### Cron registration (`node-cron`)

```js
// 09:00 on the 28th of every month
cron.schedule(process.env.MONTHLY_SEND_CRON || '0 9 28 * *', async () => {
  await sendMonthlyFeedbackForms({ smtpConfig, appBaseUrl: APP_BASE_URL });
});
```

The same logic is exposed for external schedulers at `POST /api/cron/monthly-send` (guarded by `CRON_SECRET` when set).

### Failure-safety

- Idempotent: the `feedback_requests` row per (client, month) prevents double-send if the cron re-runs.
- Skip + log clients with invalid/missing email.
- If the server was down at cron time, the missed month is detectable via the table (no row for that `month`).

---

## 16. Feature 9 — 6-Month Combined AI Trend Report (Cron)

**Implemented in `server/jobs/sixMonthReport.js`** (`generateSixMonthReport()`), registered with `node-cron` in `server/index.js`.

**Goal:** every 6 months, automatically summarize all feedback collected in the period into one trend report and email it to the admin — no manual button click.

### Logic

1. Cron triggers every 6 months (default **1st of January and July at 09:00**, `SIX_MONTH_REPORT_CRON`).
2. Compute the window: last 6 months inclusive (`sixMonthRange()` → `fromMonth`/`toMonth` as `YYYY-MM`), then `SELECT * FROM feedback_reports WHERE month` in that range (`queryFeedbackByMonth`).
3. **Zero rows** → skip the AI call and send a simple "no feedback received this period" notice (`sendNoFeedbackEmail`) instead.
4. Small volume (≤ ~45 rows) → single Gemini prompt with all rows (`analyzeCombined`).
5. Large volume → chunked map-reduce (`analyzeLarge`, Section 10.3): chunks of ~20 rows.
6. Build branded HTML + PDF (`combinedHTML`, `buildCombinedPdf`) and email the combined report to the admin (`sendCombinedEmail`) — the exact same functions as `POST /api/reports/combined`.

### Cron registration

```js
// 09:00 on the 1st of January and July (every 6 months)
cron.schedule(process.env.SIX_MONTH_REPORT_CRON || '0 9 1 1,7 *', async () => {
  await generateSixMonthReport({ smtpConfig, geminiApiKey, reportUrl, savePdf, saveHtml, fallbackReportUrl });
});
```

The same logic is exposed for external schedulers at `POST /api/cron/six-month-report` (guarded by `CRON_SECRET` when set).

---

## 17. Feature 10 — Client Management Admin Page

**Implemented in `public/admin-clients.html`** (internal tool, linked from the dashboard header) with CRUD endpoints in `server/index.js` and helpers in `server/db.js`.

**Purpose:** manage the `clients` table without touching the database directly — add clients, flip active/inactive status, or delete test data.

### Page behavior

- **Add form:** Client Name (required), Email (required, validated), Status dropdown (default `active`), and **Account Manager Email** (optional; validated against `^[^\s@]+@[^\s@]+\.[^\s@]+$`). Client-side validation mirrors the server.
- **Table:** all clients, newest first — Client Name, Email, Account Manager Email, Status badge, Created timestamp, and per-row actions. Each row is **inline-editable** (Edit button) so an assigned Account Manager Email can be added/changed after the fact.
- **Toggle:** `PATCH /api/clients/:id` flips the status badge between `active`/`inactive` — client history is never deleted by this action.
- **Delete:** `DELETE /api/clients/:id` after a `confirm()` prompt.
- All actions use `fetch` and re-render the table in place — no full page reload; a success/error line appears above the table.

### Sync from Google Sheet (button on the admin page)

The page has a **Sync from Google Sheet** card above the add form (no file inputs). It calls `POST /api/clients/sync-from-sheet` (admin session required), which fetches the published CSV from `SHEET_CSV_URL` server-side and **upserts** clients by email — no browser upload, no Google API/OAuth needed.

**Expected column format** (header row required; column order flexible, header names matched case-insensitively with spaces/underscores ignored):

| Column | Required | Notes |
|---|---|---|
| `Name` (or `Client Name`) | yes | Skipped with a reason if blank |
| `Email` | yes | Must match `^[^\s@]+@[^\s@]+\.[^\s@]+$`; duplicates (already in DB **or** earlier in the same sync) are updated/skipped per the behavior below |
| `Status` | no | `active` / `inactive` (case-insensitive); blank defaults to `active`, anything else skips the row with a reason |
| `Account Manager Email` | no | Optional; when present must match `^[^\s@]+@[^\s@]+\.[^\s@]+$`, otherwise the row is skipped with reason `invalid account manager email format` (the rest of the row is still validated first) |

**Behavior — UPSERT by email (identical to `POST /api/clients/sync`):**

  - Email already in clients ? the existing row is **updated** (
ame, status, and ccount_manager_email when that column is present in the row); no new row.
- Email not in `clients` → a new client is **inserted**.
- Duplicate email **within the same sheet** → later rows skipped (`duplicate email`), first one wins.
- Rows failing validation (`missing name`, `missing email`, `invalid email format`, `invalid account manager email format`, bad status) → skipped with `{ row, reason }`; the batch continues.
- Response: `{ ok, inserted, updated, skipped: [{ row, reason }], total }`; the page renders the summary inline and refreshes the clients table — no page reload.
- Limits: sheet CSV ≤ 5 MB, ≤ 500 data rows → any violation returns a clear 400 without touching the DB.
- **Fail closed:** if `SHEET_CSV_URL` is unset, the endpoint returns `400` with instructions to configure it (no crash, no partial sync).

**How to publish your Google Sheet to the web as CSV (one-time setup):**

1. Open the client sheet in Google Sheets.
2. **File → Share → Publish to the web…**
3. In the dialog:
   - **Link** tab, "Entire document" or the specific sheet tab you sync from.
   - **"Comma-separated values (.csv)"** in the embed/publish format dropdown → click **Publish** (confirm if prompted).
4. Copy the link it gives you — it looks like `https://docs.google.com/spreadsheets/d/e/2PACX-.../pub?output=csv`. That URL is your `SHEET_CSV_URL`.
5. Set it in the environment (`SHEET_CSV_URL=...` in `.env` locally, or in the Vercel dashboard) and redeploy/restart.
6. Optional: to keep the sheet private-ish, note that a published link is **publicly readable** — don't include any columns you must never share (emails are fine here since this sheet is your client list, but verify it's the intended scope). Unpublish anytime via the same dialog.

The published CSV is fetched server-side with a 20-second timeout; if the sheet isn't published (or the link changes), the endpoint returns a clear `502` explaining how to re-publish.

**Two sheet URLs — don't confuse them:**

- `SHEET_CSV_URL` — **machine-readable pull source** (published CSV, used by the sync endpoint). Starts with `https://docs.google.com/spreadsheets/d/e/2PACX-…/pub?output=csv`.
- `SHEET_EDIT_URL` — **human link to open and edit the sheet** (the normal shareable URL, `…/spreadsheets/d/<sheet-id>/edit`). The admin page shows it as an **Open Google Sheet** link (new tab, `rel="noopener noreferrer"`) next to the sync button; it is delivered through the admin-session-protected `GET /api/config/sheet` endpoint so the sheet link is never exposed publicly. If it's unset, the link is hidden and a small "not configured" note is shown instead — the page never breaks.

Workflow: admin clicks **Open Google Sheet** → edits rows in Google → either clicks the sheet's own **Client Sync → Sync Now** (Apps Script, `SYNC_SECRET`) or clicks **Sync from Google Sheet** on the admin page (`SHEET_CSV_URL`) — both push/pull the same client data.

### Google Sheets Sync (Sync Now button)

`POST /api/clients/sync` lets a Google Sheet push its rows straight into the `clients` table — no file download/upload. It is **auth-gated by a static secret** (`X-Sync-Secret` header matching the `SYNC_SECRET` env var, constant-time comparison), not the admin session — Google Apps Script can't hold a browser session cookie. **Fail closed:** if `SYNC_SECRET` is unset the endpoint rejects everything (401), and a startup warning is logged.

**Behavior — UPSERT by email (identical to sync-from-sheet):**

  - Email already in clients ? the existing row is **updated** (
ame, status, and ccount_manager_email when that column is present in the row); no new row.
- Email not in `clients` → a new client is **inserted**.
- Duplicate email **within the same payload** → later rows skipped (`duplicate email`), first one wins.
- Rows failing validation (`missing name`, `missing email`, `invalid email format`, `invalid account manager email format`, bad status) → skipped with `{ row, reason }`; the batch continues.
- Response: `{ ok, inserted, updated, skipped: [{ row, reason }], total }`.
- Same sanity limits as sync-from-sheet (≤ 500 rows, ≤ 5 MB payload via `Content-Length` check).

Setup in the sheet (see the Apps Script code in the "Google Sheets Sync" section of the docs — copy from the code block in point 2 of the feature implementation):

1. **Extensions → Apps Script**, paste the provided script, save it.
2. **File → Project properties → Script properties** and add exactly two properties:
   - `APP_URL` — the app's public base URL, e.g. `https://feedback.puredesigners.com` (Apps Script runs on Google's servers — `localhost` won't work; use the deployed domain or a tunnel during development).
   - `SYNC_SECRET` — the exact same random value as `SYNC_SECRET` in the app's `.env` (generate with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`).
3. Reload the sheet — a **Client Sync → Sync Now** menu appears; clicking it POSTs all non-blank data rows (header row skipped, same columns as the upload template: Name, Email, Status, Account Manager Email) and shows an alert with `inserted / updated / skipped` counts or a clear error.

### API endpoints

| Method | Path | Body | Behavior |
|---|---|---|---|
| `POST` | `/api/clients` | `{ name, email, status, accountManagerEmail }` | Validates `name` (required) and `email` (required + valid format) → 400 with a clear message otherwise; `status` defaults to `active` and only accepts `active`/`inactive`. `accountManagerEmail` is optional; if present it must be a valid email (else 400). Returns the created row (201). |
| `GET` | `/api/clients` | — | All clients, newest first (`ORDER BY id DESC`), including `status` and `accountManagerEmail`. Returns `{ ok, count, data }`. |
| `PATCH` | `/api/clients/:id` | `{ status?, accountManagerEmail? }` | Updates whichever of `status` / `accountManagerEmail` are provided (400 if none). `accountManagerEmail` must be a valid email when present (else 400); `status` only accepts `active`/`inactive`. 404 if the client doesn't exist. Returns the updated row. |
| `DELETE` | `/api/clients/:id` | — | Deletes the client row **and** all their `feedback_requests` rows (tokens become unresolvable — their links show the invalid/expired page). **`feedback_reports` rows are kept** with `client_id` preserved so dashboards and PDF history are never destroyed. 404 if not found. |

### db.js helpers added

- `listClients()` — all clients, newest first
- `updateClientStatus(id, status)` — status-only update; returns the updated row or `null`
- `updateClient(id, fields)` — generic client update; only the provided keys (`name`, `email`, `status`, `accountManagerEmail`) are written; returns the updated row or `null`
- `insertClient({ name, email, status, accountManagerEmail })` — inserts a client with the optional Account Manager Email
- `upsertClientByEmail({ name, email, status, accountManagerEmail })` — upserts by email; updates `account_manager_email` when that key is present in the call (existing value preserved when omitted)
- `deleteClient(id)` — removes `feedback_requests` for the client, then the client row; returns `{ deleted, removedRequests }`

### Security note (important)

The page and the `/api/clients/*` endpoints are protected by a **server-side admin session**: sign in at `/login.html` (`POST /api/login` with `ADMIN_USERNAME` / `ADMIN_PASSWORD`), held in a signed httpOnly cookie. This is a single fixed account — deliberately **no user accounts and no sign-up/registration** (self-registration would let anyone create an admin account). If any of `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `SESSION_SECRET` is unset, auth is disabled and a warning is logged at startup; never run that way in production.

The public feedback form (`/`, `POST /api/feedback`, `GET /feedback/<token>`) is intentionally **not** protected — clients must reach it without credentials.

### Supabase Data API lockdown (important)

The app talks to Postgres **only** through a direct `node-postgres` connection (`DATABASE_URL`, the Supabase pooler string) — it never uses the Supabase JS client (`@supabase/supabase-js` is not even a dependency), the anon key, or the auto-generated REST/GraphQL API. The Supabase **Data API (PostgREST)** is therefore disabled / locked down on the project:

- **Primary fix — disable the Data API:** Supabase Dashboard → **Integrations → Data API** → toggle **Enable Data API** **off**. With it off, no `/rest/v1/*` endpoint responds at all, regardless of grants or RLS ([Supabase docs — Securing your API](https://supabase.com/docs/guides/api/securing-your-api)).
- **Defense in depth — RLS + revoked grants:** `server/sql/lockdown_data_api.sql` enables Row-Level Security on `clients`, `feedback_reports`, and `feedback_requests` with an explicit default-deny policy for the `anon` / `authenticated` roles, and revokes table privileges from `anon` / `authenticated` / `service_role` (including future-default privileges). This is safe even with the toggle left on and clears Supabase's `rls_disabled_in_public` and `sensitive_columns_exposed` findings.
- **Why the app is unaffected:** the pooler connection role owns these tables, and RLS never applies to a table owner (no `FORCE ROW LEVEL SECURITY` is used). Direct `pg` queries keep working; if the app is ever moved to a non-owner role, the SQL file includes a permissive policy template for that role.
- **Verification:** `curl "https://<project-ref>.supabase.co/rest/v1/clients" -H "apikey: <anon key>" -H "Authorization: Bearer <anon key>"` must return `401/403/404` instead of rows. Re-run Supabase's security check afterwards to confirm both flags are cleared.
- The storage driver's `/storage/v1/...` uploads (only active when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set) use the Storage service, not the Data API, and are unaffected.

---

## 18. API Reference Summary

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/login` | Admin login `{ username, password }` → sets signed httpOnly session cookie (generic 401 `Invalid credentials.` on failure; 503 if auth not configured) |
| `POST` | `/api/logout` | Clears the admin session cookie |
| `POST` | `/api/feedback` | Submit feedback (full pipeline; optional `token` for client-link submissions) — **open, no auth** |
| `GET` | `/api/feedback` | List with `from`, `to`, `sentiment`, `serviceType` filters (`eventName` accepted as legacy alias) *(admin session)* |
| `GET` | `/api/stats` | Dashboard stats (`from`, `to`) *(admin session)* |
| `POST` | `/api/reports/combined` | Date-range combined report `{ from, to }` *(admin session)* |
| `POST` | `/api/clients/sync-from-sheet` | Pull clients from the published Google Sheet CSV (`SHEET_CSV_URL`) and upsert by email — `{ inserted, updated, skipped, total }`; clear 400 if `SHEET_CSV_URL` unset or the sheet is empty *(admin session)*. Optional `Account Manager Email` column is mapped (invalid manager email → row skipped with reason). |
| `POST` | `/api/clients/sync` | Google Sheets sync `{ clients: [...] }` — **UPSERT by email** (update existing / insert new), `X-Sync-Secret` header; `{ inserted, updated, skipped, total }` (no admin session needed). Optional `Account Manager Email` column is mapped (invalid manager email → row skipped with reason). |
| `POST` | `/api/clients` | Add a client (name + valid email required; 400 otherwise; optional `accountManagerEmail`) *(admin session)* |
| `GET` | `/api/clients` | List all clients, newest first *(admin session)* |
| `PATCH` | `/api/clients/:id` | Update client status `{ status: 'active' \| 'inactive' }` *(admin session)* |
| `DELETE` | `/api/clients/:id` | Delete client + their `feedback_requests` (feedback report history kept) *(admin session)* |
| `GET` | `/api/health` | Health / config check — open |
| `GET` | `/feedback/<token>` | Token-validated feedback form (pre-filled; invalid/already-used → friendly page) — **open, no auth** |
| `POST` | `/api/cron/monthly-send` | External cron trigger for the monthly send (requires `x-cron-secret` if `CRON_SECRET` set; admin session) |
| `POST` | `/api/cron/six-month-report` | External cron trigger for the 6-month report (requires `x-cron-secret` if `CRON_SECRET` set; admin session) |
| `GET` | `/reports/<file>` | Served generated HTML/PDF files — from the storage driver if saved, otherwise regenerated on demand from the database (single or `combined-<from>-to-<to>` files) |
| `GET` | `/` | Public feedback form — **open, no auth** |
| `GET` | `/login.html` | Admin sign-in page — open (only renders; APIs stay locked) |
| `GET` | `/dashboard.html`, `/admin-clients.html` | Dashboard, internal client management — **redirect to `/login.html` without a valid session** |

---

## 19. Error Handling & Edge Cases

| Case | Handling |
|---|---|
| Gemini API fails / malformed JSON | Fall back to rating-based defaults; log raw response; submission is still saved |
| SMTP send fails | Log error; retry once; feedback still stored so nothing is lost |
| No `GEMINI_API_KEY` / no `SMTP_PASS` | Graceful degradation — fallback analysis / email skipped, `usedAi`/`emailSent` flags reflect it |
| Duplicate submission attempt (same token) | Rejected with friendly message (HTTP 409); `submitted` already `1` |
| Client missing/invalid email | Skip send, log for manual follow-up |
| No feedback in a 6-month period | Skip AI call; send "no feedback received" notice |
| Large feedback volume | Chunked map-reduce summarization |
| PDF generation fails | Log error; email an HTML/plain-text fallback instead of blocking the flow |
| Server restart during cron | `feedback_requests` rows make the job idempotent per month |
| Host sleeps/restarts | Use an external hosted cron hitting a protected API endpoint instead of relying on a long-running process |

---

## 20. Testing

```bash
npm test
```

Runs Node's built-in test runner against `server/tests/*.test.js` (`cleanData.test.js` + `phase2.test.js`).

`phase2.test.js` covers: token generation/lookup, `feedback_requests` idempotency (no duplicate row for the same client+month), the 6-month report window computation, the old-schema migration, and chunked map-reduce shape. Tests run against a throwaway SQLite file (`DB_PATH` pointed at a temp path) — the real database is untouched.

---

## 21. Deploying to Vercel

The app is a normal long-running Express server **and** a Vercel serverless function:

- `vercel.json` rewrites all paths (`/(.*)` → `/api`) into the `api/index.js` function, which simply exports the Express app (`server/index.js`). Without it, Vercel serves static files only and every `/api/*` request returns its HTML 404 page ("The page c…" — the exact symptom seen in the Google Sheets sync failure).
- `server/index.js` guards `app.listen()` and `node-cron` with `require.main === module`, so the function only handles requests; cron runs only in long-running mode. Use **Vercel Cron** (or an external cron) hitting `POST /api/cron/monthly-send` and `POST /api/cron/six-month-report` with `x-cron-secret` if `CRON_SECRET` is set.
- **Database:** SQLite cannot persist on serverless (ephemeral FS; `/tmp` fallback is used when `VERCEL` and no `DB_PATH`). For production set `DATABASE_URL` (Postgres — e.g. Neon/Supabase); `server/db.js` then runs in Postgres mode (same row shapes — column names are normalized), otherwise it uses local `better-sqlite3`.
- **Reports:** the serverless filesystem is not writable, so `server/storage.js` picks a driver per environment — `disk` (local dev), `supabase` (when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set), or `memory` (Vercel without storage credentials — nothing is written, and `/reports/<file>` regenerates the HTML/PDF on demand from the database). Storage failures never fail a submission — the PDF is always emailed as an in-memory attachment and `pdfUrl` falls back to `/reports/<file>`.
- Every env var must be added in the Vercel dashboard (Vercel does not read the local `.env`): `GEMINI_API_KEY`, `GEMINI_MODEL`, `SMTP_*`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `SYNC_SECRET`, `DATABASE_URL`, `PUBLIC_URL`/`APP_BASE_URL` (live domain), `CRON_SECRET`, `SHEET_CSV_URL`, `SHEET_EDIT_URL`, and optionally `ADMIN_EMAIL` (organizer copy of reports + internal alerts — leave unset for no admin emails; `LEADERSHIP_EMAILS` still works) and optionally `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_REPORTS_BUCKET` (report files on Supabase Storage).

---

## 21. Deployment Notes

- Set `PUBLIC_URL` / `APP_BASE_URL` to the real domain so links inside emails resolve.
- `reports/` is only written locally (disk driver). In production, links resolve from Supabase Storage (if configured) or regenerate on demand via `/reports/<file>` — no local disk needed. See Section 11.1 (report storage).
- Sample rows may exist in `data/feedback.db` from local testing — delete the file to start fresh (the Phase 2 migration only runs if the table still has the old column names).
- Keep `.env` out of version control; rotate `SMTP_PASS`/`GEMINI_API_KEY`/`ADMIN_PASSWORD`/`SESSION_SECRET` if leaked.
- **Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `SESSION_SECRET` before deploying** — dashboard, client admin page, and admin APIs are protected by session login. Without all three the app starts but logs a warning that admin routes are unprotected. Sessions are 24h httpOnly signed cookies; if stronger security is needed later, replace the fixed account with per-user auth.
- For always-on scheduling, a Node process with `node-cron` works; on platforms that sleep, prefer an external cron service hitting the protected endpoints (`/api/cron/*` with `CRON_SECRET` and admin session login).
- Uptime monitoring: hit `/api/health`.

---

## 22. Future Improvements

- **Reminder job:** resend the form to clients who haven't submitted after `ALERT_NO_RESPONSE_DAYS` days (default **5**), sending a "Gentle Reminder | Client Feedback" email with the tokenized `/feedback/<token>` link plus an internal `ALERT: No response` email to `ADMIN_EMAIL`/`ALERT_EMAIL` (only if one is configured; the client reminder always sends regardless).
- **Per-service-type breakdown** inside the 6-month report.
- **Per-user admin accounts / role-based access** (currently a single fixed admin login).
- **Client opt-out / unsubscribe** mechanism (link-level preference stored in `clients`).
- **Additional storage backends** for reports (e.g. S3) behind the `storage.js` driver interface (Supabase Storage + on-demand regeneration already supported).
- **Read receipts / response-rate metrics** per monthly cycle from `feedback_requests`.
- **Email templates** (HTML branding) for both client and admin emails.
