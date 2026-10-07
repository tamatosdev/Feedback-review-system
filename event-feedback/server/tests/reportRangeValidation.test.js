const test = require('node:test');
const assert = require('node:assert');

// The same file dashboard.html loads as /reportRange.js, so these assertions
// cover the decision the button actually makes rather than a reimplementation.
const { validate, ALL_TIME_RANGE } = require('../../public/reportRange');

test('All Time is a valid, deliberate choice even with no dates', () => {
  const res = validate('', '', ALL_TIME_RANGE);
  assert.strictEqual(res.ok, true, 'All Time must not be rejected as "nothing selected"');
  assert.strictEqual(res.allTime, true, 'the caller is told to expect an unfiltered report');
  assert.strictEqual(res.error, null);
});

test('All Time with empty strings (as the date inputs report them) passes', () => {
  assert.strictEqual(validate('', '', 'alltime').ok, true);
});

test('quick-range buttons fill both dates and pass', () => {
  for (const range of ['currm', '1m', '3m', '6m', 'year']) {
    const res = validate('2026-04-07', '2026-10-07', range);
    assert.strictEqual(res.ok, true, `${range} should be accepted`);
    assert.strictEqual(res.allTime, false, `${range} is a bounded range`);
  }
});

test('custom From/To dates pass with no quick range active', () => {
  const res = validate('2026-01-01', '2026-06-30', '');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.allTime, false);
});

test('a genuinely empty selection is still blocked', () => {
  const res = validate('', '', '');
  assert.strictEqual(res.ok, false, 'no chip and no dates must not reach the API');
  assert.strictEqual(res.allTime, false);
  assert.ok(res.error && res.error.length > 0, 'the user is told what to do');
});

test('a half-filled custom range is still blocked', () => {
  assert.strictEqual(validate('2026-01-01', '', '').ok, false, 'From without To');
  assert.strictEqual(validate('', '2026-06-30', '').ok, false, 'To without From');
});

test('typing one date clears the All Time chip, so it is blocked again', () => {
  // dashboard.html sets state.range = '' as soon as a date input changes.
  assert.strictEqual(validate('2026-01-01', '', ALL_TIME_RANGE).ok, false);
  assert.strictEqual(validate('', '2026-01-01', ALL_TIME_RANGE).ok, false);
});
