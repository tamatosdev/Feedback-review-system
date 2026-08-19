const test = require('node:test');
const assert = require('node:assert');
const { cleanData } = require('../cleanData');
const { parseGeminiJson, fallbackAnalysis } = require('../gemini');

const VALID_SCORES = {
  accountManagementScore: 5,
  strategyScore: 4,
  creativeScore: 3,
  designContentScore: 2,
  socialContentScore: 4,
  agencyLeadershipScore: 5
};

test('cleanData trims strings, applies defaults, keeps all six department scores', () => {
  const c = cleanData({
    eventName: '  Product Launch  ',
    eventDate: ' 2026-08-10 ',
    attendeeName: '   ',
    attendeeEmail: 'not-an-email',
    companyName: '  Acme  ',
    ...VALID_SCORES,
    comments: '   '
  });
  assert.strictEqual(c.eventName, 'Product Launch');
  assert.strictEqual(c.eventDate, '2026-08-10');
  assert.strictEqual(c.attendeeName, 'Anonymous');
  assert.strictEqual(c.hasValidEmail, false);
  assert.strictEqual(c.companyName, 'Acme');
  assert.strictEqual(c.accountManagementScore, 5);
  assert.strictEqual(c.strategyScore, 4);
  assert.strictEqual(c.creativeScore, 3);
  assert.strictEqual(c.designContentScore, 2);
  assert.strictEqual(c.socialContentScore, 4);
  assert.strictEqual(c.agencyLeadershipScore, 5);
  assert.strictEqual(c.comments, 'No comments provided');
  assert.strictEqual(c.suggestions, undefined, 'cleanData no longer reads or returns a suggestions field');
  assert.match(c.submissionId, /^FB-/);
  assert.ok(!Number.isNaN(Date.parse(c.timestamp)));
});

test('cleanData sets legacy rating equal to agencyLeadershipScore', () => {
  const c = cleanData({ ...VALID_SCORES, agencyLeadershipScore: 3 });
  assert.strictEqual(c.rating, 3);
});

test('cleanData accepts valid email and string score values', () => {
  const c = cleanData({
    attendeeEmail: 'a@b.com',
    accountManagementScore: '4',
    strategyScore: 2,
    creativeScore: '5',
    designContentScore: 1,
    socialContentScore: '3',
    agencyLeadershipScore: 4
  });
  assert.strictEqual(c.hasValidEmail, true);
  assert.strictEqual(c.accountManagementScore, 4);
  assert.strictEqual(c.socialContentScore, 3);
});

test('cleanData rejects when any of the six scores is missing', () => {
  const { agencyLeadershipScore, ...withoutOverall } = VALID_SCORES;
  assert.throws(
    () => cleanData(withoutOverall),
    (err) => {
      assert.strictEqual(err.status, 400);
      assert.match(err.message, /Agency Leadership/);
      assert.match(err.message, /required/);
      assert.ok(err.validation.missing.includes('Agency Leadership'));
      return true;
    }
  );
});

test('cleanData rejects out-of-range, non-integer and empty score values', () => {
  const badVariants = [
    { ...VALID_SCORES, accountManagementScore: 0 },
    { ...VALID_SCORES, strategyScore: 6 },
    { ...VALID_SCORES, creativeScore: 3.5 },
    { ...VALID_SCORES, designContentScore: 'abc' },
    { ...VALID_SCORES, socialContentScore: '' },
    { ...VALID_SCORES, agencyLeadershipScore: null }
  ];
  for (const variant of badVariants) {
    assert.throws(() => cleanData(variant), (err) => err.status === 400 && /1 to 5/.test(err.message));
  }
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
