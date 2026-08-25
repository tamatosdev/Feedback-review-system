const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const { DEPARTMENT_SCORES, scoreText, serviceDateOf, submissionDateOf, safeText } = require('./report');

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;

const ACCENT = '#FFF000';
const BLACK = '#111827';
const GRAY = '#6b7280';
const ROW_BG = '#f9fafb';
const BORDER = '#e5e7eb';

const SENTIMENT_COLORS = {
  Positive: { text: '#16a34a', bg: '#dcfce7' },
  Neutral: { text: '#ea580c', bg: '#ffedd5' },
  Negative: { text: '#dc2626', bg: '#fee2e2' }
};

const FONT_DIR = path.join(__dirname, 'fonts');

function registerFonts(doc) {
  const regularPath = path.join(FONT_DIR, 'Inter-Regular.ttf');
  const boldPath = path.join(FONT_DIR, 'Inter-Bold.ttf');
  const hasRegular = fs.existsSync(regularPath);
  const hasBold = fs.existsSync(boldPath);
  if (hasRegular) doc.registerFont('Inter', regularPath);
  if (hasBold) doc.registerFont('Inter-Bold', boldPath);
  doc.interFonts = {
    regular: hasRegular ? 'Inter' : 'Helvetica',
    bold: hasBold ? 'Inter-Bold' : 'Helvetica-Bold'
  };
  return doc.interFonts;
}

function findLogoPng() {
  const candidates = [
    path.join(__dirname, '..', 'public', 'assets', 'logo.png'),
    path.join(__dirname, '..', 'assets', 'logo.png'),
    path.join(__dirname, '..', 'data', 'logo.png')
  ];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function drawHeader(doc, title, subtitle) {
  doc.rect(0, 0, PAGE_W, 8).fill(ACCENT);
  doc.y = MARGIN;

  const logoPath = findLogoPng();
  const logoSize = 60;
  let textX = MARGIN;
  let textOffsetY = 2;
  if (logoPath) {
    try {
      const img = doc.openImage(logoPath);
      const imgHeight = (img.height / img.width) * logoSize;
      doc.image(img, MARGIN, doc.y, { width: logoSize });
      textX = MARGIN + logoSize + 14;
      textOffsetY = Math.max(2, (imgHeight - 24) / 2);
    } catch {
      drawPlaceholderLogo(doc, MARGIN, doc.y, logoSize);
    }
  } else {
    drawPlaceholderLogo(doc, MARGIN, doc.y, logoSize);
  }

  doc.fillColor(BLACK).font(doc.interFonts.bold).fontSize(19).text(title, textX, doc.y + textOffsetY, { width: CONTENT_W - logoSize - 14 });
  if (subtitle) {
    doc.fillColor(GRAY).font(doc.interFonts.regular).fontSize(10).text(subtitle, textX, doc.y + 4, { width: CONTENT_W - logoSize - 14 });
  }
  doc.moveDown(1.2);
  doc.strokeColor(ACCENT).lineWidth(2.5).moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).stroke();
  doc.moveDown(1.4);
  return doc;
}

function drawPlaceholderLogo(doc, x, y, size) {
  doc.save();
  doc.circle(x + size / 2, y + size / 2, size / 2).fill(ACCENT).stroke('#9ef0c0');
  doc.circle(x + size / 2, y + size / 2, size / 6.5).fill(BLACK);
  doc.restore();
}

function sectionHeading(doc, text) {
  ensureSpace(doc, 40);
  doc.moveDown(0.9);
  doc.fillColor(BLACK).font(doc.interFonts.bold).fontSize(12.5).text(text.toUpperCase(), { characterSpacing: 0.8 });
  doc.moveDown(0.4);
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > PAGE_H - MARGIN) doc.addPage();
}

function infoTable(doc, rows) {
  const pad = 8;
  const labelW = 185;
  for (const [label, value] of rows) {
    doc.font(doc.interFonts.bold).fontSize(9.5);
    const labelH = doc.heightOfString(String(label), { width: labelW - pad * 2 });
    doc.font(doc.interFonts.regular).fontSize(9.5);
    const valueH = doc.heightOfString(String(value), { width: CONTENT_W - labelW - pad * 2 });
    const rowH = Math.max(labelH, valueH) + pad * 2;
    ensureSpace(doc, rowH + 6);

    const y = doc.y;
    doc.rect(MARGIN, y, labelW, rowH).fill(ROW_BG);
    doc.strokeColor(BORDER).lineWidth(0.8);
    doc.rect(MARGIN, y, CONTENT_W, rowH).stroke();
    doc.moveTo(MARGIN + labelW, y).lineTo(MARGIN + labelW, y + rowH).stroke();

    doc.fillColor(BLACK).font(doc.interFonts.bold).fontSize(9.5);
    doc.text(String(label), MARGIN + pad, y + pad, { width: labelW - pad * 2 });
    doc.fillColor(BLACK).font(doc.interFonts.regular).fontSize(9.5);
    doc.text(String(value), MARGIN + labelW + pad, y + pad, { width: CONTENT_W - labelW - pad * 2 });

    doc.y = y + rowH;
  }
  doc.moveDown(0.3);
}

function drawStars(doc, rating) {
  const r = 7;
  const gap = 24;
  const y = doc.y + 10;
  const startX = MARGIN + 10;
  for (let i = 0; i < 5; i++) {
    const cx = startX + i * gap;
    if (i < rating) {
      doc.circle(cx, y, r).fill(ACCENT).stroke('#CCBF00');
    } else {
      doc.circle(cx, y, r).stroke('#d1d5db');
    }
  }
  doc.fillColor(BLACK).font(doc.interFonts.bold).fontSize(10).text(`${rating} / 5`, startX + 5 * gap, y - 5);
  doc.y = y + 22;
}

function drawBadge(doc, sentiment) {
  const c = SENTIMENT_COLORS[sentiment] || SENTIMENT_COLORS.Neutral;
  const y0 = doc.y;
  doc.font(doc.interFonts.bold).fontSize(10);
  const w = doc.widthOfString(sentiment) + 28;
  const h = 24;
  doc.roundedRect(MARGIN + 10, y0, w, h, 12).fill(c.bg);
  doc.fillColor(c.text).text(sentiment, MARGIN + 10 + 14, y0 + 7);
  doc.y = y0 + h + 6;
}

function drawBullets(doc, items, label) {
  ensureSpace(doc, 20);
  doc.fillColor(BLACK).font(doc.interFonts.bold).fontSize(10).text(label);
  doc.moveDown(0.2);
  doc.fillColor(BLACK).font(doc.interFonts.regular).fontSize(9.5);
  for (const item of items) {
    ensureSpace(doc, 30);
    doc.circle(MARGIN + 5, doc.y + 4.5, 2.2).fill(BLACK);
    doc.fillColor(BLACK).font(doc.interFonts.regular).fontSize(9.5);
    doc.text(String(item), MARGIN + 16, doc.y, { width: CONTENT_W - 16 });
    doc.moveDown(0.25);
  }
}

function drawLabeledLine(doc, label, value) {
  ensureSpace(doc, 24);
  doc.fillColor(BLACK).font(doc.interFonts.bold).fontSize(10).text(label);
  doc.moveDown(0.15);
  doc.fillColor(BLACK).font(doc.interFonts.regular).fontSize(9.5).text(String(value), MARGIN + 16, doc.y, { width: CONTENT_W - 16 });
  doc.moveDown(0.4);
}

function writeFeedbackSection(doc, r, index, fullPage = true) {
  const dateVal = safeText(serviceDateOf(r));
  const submissionDate = safeText(submissionDateOf(r));
  const title = fullPage ? 'Client Feedback Report' : `#${index}`;
  drawHeader(doc, fullPage ? title : title, fullPage ? '' : `${r.attendeeName} · ${dateVal} · ${r.submissionId}`);

  sectionHeading(doc, 'Feedback Information');
  infoTable(doc, [
    ['Form Submission Date', submissionDate],
    ['Overall Rating', `${r.rating} / 5`],
    ['Urgency', r.urgency]
  ]);
  drawBadge(doc, r.sentiment);

  sectionHeading(doc, 'Department Ratings');
  infoTable(doc, DEPARTMENT_SCORES.map(([key, label]) => [label, scoreText(r[key])]));

  sectionHeading(doc, 'Client Information');
  infoTable(doc, [
    ['Name', r.attendeeName],
    ['Email Address', r.attendeeEmail && r.hasValidEmail !== false ? r.attendeeEmail : 'Not provided'],
    ['Company', r.companyName || 'Not provided']
  ]);

  sectionHeading(doc, 'Overall Rating');
  ensureSpace(doc, 40);
  drawStars(doc, r.rating);

  sectionHeading(doc, 'AI Analysis');
  drawLabeledLine(doc, 'AI Summary:', r.summary);
  drawBullets(doc, r.highlights, 'Highlights:');
  drawBullets(doc, r.improvementSuggestions, 'Improvement Suggestions:');

  sectionHeading(doc, 'Original Client Feedback');
  drawLabeledLine(doc, 'Client Feedback / Comments:', r.comments);
  if (r.suggestions && r.suggestions !== 'No suggestions provided') {
    drawLabeledLine(doc, 'Suggestions / Recommendations:', r.suggestions);
  }

  ensureSpace(doc, 30);
  doc.fillColor(GRAY).font(doc.interFonts.regular).fontSize(8.5)
    .text(`Submission ID: ${r.submissionId}   ·   Submitted: ${r.timestamp}`, MARGIN, PAGE_H - MARGIN - 20, { width: CONTENT_W });
}

function buildPdf(record) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
    registerFonts(doc);
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    writeFeedbackSection(doc, record);

    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      drawFooter(doc, i + 1, pages.count);
    }
    doc.end();
  });
}

function buildCombinedPdf(meta, rows) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
    registerFonts(doc);
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawHeader(doc, 'Combined Client Feedback Report', `Date range: ${meta.from} → ${meta.to} · ${rows.length} submission(s)`);

    sectionHeading(doc, 'Overall AI Analysis');
    drawLabeledLine(doc, 'Overall Summary:', meta.overallSummary);
    const b = meta.overallSentimentBreakdown;
    drawBullets(doc, [
      `Positive: ${b.positive}`,
      `Neutral: ${b.neutral}`,
      `Negative: ${b.negative}`
    ], 'Sentiment Breakdown:');
    drawBullets(doc, meta.keyHighlights, 'Key Highlights:');
    drawBullets(doc, meta.topImprovementSuggestions, 'Top Improvement Suggestions:');

    rows.forEach((r, i) => {
      doc.addPage();
      writeFeedbackSection(doc, r, i + 1, false);
    });

    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      drawFooter(doc, i + 1, pages.count);
    }
    doc.end();
  });
}

function drawFooter(doc, pageNum, total) {
  doc.fillColor(GRAY).font(doc.interFonts.regular).fontSize(8)
    .text(`Page ${pageNum} of ${total}`, MARGIN, PAGE_H - MARGIN, { width: CONTENT_W, align: 'right' });
}

module.exports = { buildPdf, buildCombinedPdf };
