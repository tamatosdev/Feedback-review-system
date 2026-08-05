const test = require('node:test');
const assert = require('node:assert');
const { cleanData } = require('../cleanData');
const { parseGeminiJson, fallbackAnalysis } = require('../gemini');

test('cleanData trims strings and applies defaults', () => {
  const c = cleanData({
    eventName: '  Product Launch  ',
    eventDate: ' 2026-08-10 ',
    attendeeName: '   ',
    attendeeEmail: 'not-an-email',
    companyName: '  Acme  ',
    rating: '4',
    comments: '   ',
    suggestions: '   '
  });
  assert.strictEqual(c.eventName, 'Product Launch');
  assert.strictEqual(c.eventDate, '2026-08-10');
  assert.strictEqual(c.attendeeName, 'Anonymous');
  assert.strictEqual(c.hasValidEmail, false);
  assert.strictEqual(c.companyName, 'Acme');
  assert.strictEqual(c.rating, 4);
  assert.strictEqual(c.comments, 'No comments provided');
  assert.strictEqual(c.suggestions, 'No suggestions provided');
  assert.match(c.submissionId, /^FB-/);
  assert.ok(!Number.isNaN(Date.parse(c.timestamp)));
});

test('cleanData accepts valid email and rating bounds', () => {
  const c = cleanData({ attendeeEmail: 'a@b.com', rating: '9' });
  assert.strictEqual(c.hasValidEmail, true);
  assert.strictEqual(c.rating, 3);
});

test('parseGeminiJson strips markdown fences and extra text', () => {
  const out = parseGeminiJson('Here you go:\n```json\n{"sentiment":"Positive","summary":"ok","highlights":["a"],"improvementSuggestions":["b"],"urgency":"Low"}\n```\nDone.');
  assert.deepStrictEqual(out, {
    sentiment: 'Positive', summary: 'ok', highlights: ['a'], improvementSuggestions: ['b'], urgency: 'Low'
  });
});

test('fallbackAnalysis derives sentiment and urgency from rating', () => {
  const data = fallbackAnalysis({ rating: 2, comments: 'bad', suggestions: '' });
  assert.strictEqual(data.sentiment, 'Negative');
  assert.strictEqual(data.urgency, 'High');
  assert.ok(data.summary.includes('2/5'));
});
