// Manual schema initialization / verification for the configured database.
// Usage:
//   DATABASE_URL=postgres://... node server/initDb.js
// (or just `node server/initDb.js` to check the local SQLite database)
// Creates any missing tables (clients, feedback_requests, feedback_reports)
// in dependency order and lists the existing tables.
require('dotenv').config();
const { dbMode, dbHost, pingDb, listTables } = require('./db');

(async () => {
  try {
    console.log(`DB mode: ${dbMode()}${dbHost() ? ` (${dbHost()})` : ''}`);
    const info = await pingDb(); // triggers schema init (create missing tables)
    console.log('Connection OK:', info.mode, info.ok ? '' : '(error)');
    const tables = await listTables();
    console.log('Tables in database:', tables.length ? tables.join(', ') : '(none)');
    const required = ['clients', 'feedback_requests', 'feedback_reports'];
    const missing = required.filter((t) => !tables.includes(t));
    if (missing.length) {
      console.error(`MISSING TABLES: ${missing.join(', ')} — schema init did not fully run; check the error above.`);
      process.exit(1);
    }
    console.log('All required tables present.');
    process.exit(0);
  } catch (err) {
    console.error('Schema init failed:', err.message);
    process.exit(1);
  }
})();
