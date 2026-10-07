// The exact validation the dashboard's "Generate Consolidated Report" button
// runs before POSTing /api/reports/combined. Kept in its own file so the tests
// can exercise the real decision instead of a copy of it - dashboard.html
// loads this as /reportRange.js and the tests require() it from public/.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReportRange = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const ALL_TIME_RANGE = 'alltime';

  // A deliberate selection is either:
  //   - the "All Time" chip, which carries no dates at all because it means
  //     "no filter", or
  //   - both custom From/To dates filled (quick ranges also fill these).
  // Anything else - nothing picked, or half of a custom range - must not reach
  // the API, and the user is told to pick something first.
  function validate(from, to, range) {
    const hasFrom = !!from;
    const hasTo = !!to;

    if (range === ALL_TIME_RANGE && !hasFrom && !hasTo) {
      return { ok: true, allTime: true, error: null };
    }
    if (hasFrom && hasTo) {
      return { ok: true, allTime: false, error: null };
    }
    return {
      ok: false,
      allTime: false,
      error: 'Pick a date range first - use a quick-range button (All Time is one) or the custom From/To dates.'
    };
  }

  return { validate, ALL_TIME_RANGE };
});
