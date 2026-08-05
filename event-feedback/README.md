# Event Feedback System

Branded feedback form → AI analysis (Gemini 2.5 Flash) → branded HTML/PDF report → SMTP email (Hostinger) → SQLite storage → analytics dashboard with date-range filters → date-range combined PDF reports + email.

No Google Sheets, no Slack, no Gmail. Just Node.js + Gemini + SMTP.

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

Then open:

| Page       | URL                     |
| ---------- | ----------------------- |
| Form       | http://localhost:3000/  |
| Dashboard  | http://localhost:3000/dashboard.html |

## Configure secrets (`.env`)

Copy `.env.example` → `.env` and fill in:

```ini
GEMINI_API_KEY=your_google_ai_studio_key     # AI analysis (model: gemini-2.5-flash)
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_USER=tahir@puredesigners.com
SMTP_PASS=your_smtp_password                 # Hostinger mailbox password
ADMIN_EMAIL=tahir@puredesigners.com          # organizer who receives every report
PUBLIC_URL=http://localhost:3000             # change when deployed (used for PDF links in emails)
```

- Without `GEMINI_API_KEY` the system still works using rating-based fallback analysis.
- Without `SMTP_PASS` emails are skipped (marked `emailSent: false`) — submissions still stored.

## Branding

- Official logo: `public/assets/logo.png` (form, dashboard, HTML reports, PDFs). The PDF generator embeds it automatically.
- Accent `#A6F4C5` · background white · text black — defined in `server/report.js`, `server/pdf.js`, and the two pages.

## How it works

1. `POST /api/feedback` — `server/cleanData.js` trims/normalizes (Anonymous default, email validation → `hasValidEmail`, "No comments provided" defaults, `submissionId = FB-<timestamp><random>`), then `server/gemini.js` analyzes with Gemini 2.5 (sentiment, summary, highlights, improvement suggestions, urgency — parsed safely with fallbacks), `server/report.js` builds the branded HTML, `server/pdf.js` renders the branded PDF, `server/email.js` sends it to the organizer via Hostinger SMTP (attachment + link), and `server/db.js` stores the row in SQLite.
2. `GET /api/feedback?from=&to=&sentiment=&eventName=` — filtered list.
3. `GET /api/stats` — total, average rating, sentiment counts, high-urgency count, event list.
4. `POST /api/reports/combined` `{from, to}` — fetches rows in range, Gemini produces an overall analysis (sentiment breakdown, summary, key highlights, top improvements), builds a combined PDF with one section per submission, emails it to the admin.

All generated HTML/PDF files are saved to `reports/` and served at `/reports/<file>`.

## Storage

SQLite database `data/feedback.db`, table `feedback_reports` with: `submissionId, timestamp, eventName, eventDate, attendeeName, attendeeEmail, hasValidEmail, companyName, rating, comments, suggestions, sentiment, summary, urgency, highlights (JSON), improvementSuggestions (JSON), pdfUrl, emailSent`.

To start fresh: stop the server, delete `data/feedback.db`, restart.

## Tests

```bash
npm test
```

## Notes for deploying

- Set `PUBLIC_URL` to your real domain so PDF links inside emails resolve.
- `reports/` is local storage — on a VPS you may want to point it at object storage, or attach the PDF (already attached) instead of relying on the link.
- Sample rows exist in the DB from local testing — delete `data/feedback.db` to clear.
