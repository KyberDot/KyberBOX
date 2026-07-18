const db = require('../db');

/**
 * For any active subscription set to auto-renew whose expiry date has
 * passed, pushes the expiry forward a month at a time until it's back in
 * the future. This is the entire "auto-renew" behaviour in the absence of
 * real payment processing - it just keeps rolling the date forward.
 * Cheap to call on every request: the WHERE clause does the filtering, so
 * this is a no-op query when nothing is due.
 */
function applyAutoRenewals() {
  const due = db
    .prepare(
      `SELECT id, expires_at FROM subscriptions
       WHERE renewal_mode = 'auto' AND status = 'active' AND expires_at IS NOT NULL AND expires_at < date('now')`
    )
    .all();

  if (due.length === 0) return;

  const update = db.prepare(`UPDATE subscriptions SET expires_at = ?, updated_at = datetime('now') WHERE id = ?`);
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');

  due.forEach((sub) => {
    let d = new Date(String(sub.expires_at).slice(0, 10) + 'T00:00:00Z');
    if (isNaN(d.getTime())) return;
    let guard = 0;
    while (d < today && guard < 240) { // safety cap: 20 years of monthly rollovers
      d.setUTCMonth(d.getUTCMonth() + 1);
      guard += 1;
    }
    update.run(d.toISOString().slice(0, 10), sub.id);
  });
}

module.exports = { applyAutoRenewals };