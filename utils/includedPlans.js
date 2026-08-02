// Keeps "included with another plan" subscriptions (e.g. a Minecraft plan
// bundled free with a Plex plan) in sync with whatever else a user is
// actively subscribed to. Only ever touches subscriptions it created
// itself (marked via auto_granted_via_plan_id) - anything an admin
// manually assigned is left alone even if it happens to match a plan
// that's also configured as "included with" something.

const db = require('../db');

/**
 * Re-evaluates every "included with" plan for one user: grants it if
 * they now qualify (an active subscription to any of its trigger plans)
 * and don't already have it, or expires it if they no longer qualify and
 * their copy was one this function granted in the first place. Safe to
 * call any time a user's subscriptions change - idempotent, so calling it
 * repeatedly with no actual change does nothing.
 */
function syncIncludedPlansForUser(userId) {
  const activePlanIds = new Set(
    db
      .prepare(`SELECT plan_id FROM subscriptions WHERE user_id = ? AND status = 'active' AND plan_id IS NOT NULL`)
      .all(userId)
      .map((r) => r.plan_id)
  );

  const includablePlans = db
    .prepare(`SELECT * FROM plans WHERE pricing_mode = 'included_with' AND included_with_plan_ids IS NOT NULL AND included_with_plan_ids != ''`)
    .all();

  includablePlans.forEach((plan) => {
    const triggerIds = String(plan.included_with_plan_ids)
      .split(',')
      .map((id) => Number(id.trim()))
      .filter(Boolean);

    const qualifies = triggerIds.some((id) => activePlanIds.has(id));

    const existing = db
      .prepare(`SELECT * FROM subscriptions WHERE user_id = ? AND plan_id = ? AND status = 'active'`)
      .get(userId, plan.id);

    if (qualifies && !existing) {
      db.prepare(
        `INSERT INTO subscriptions (user_id, plan_id, service, plan_name, status, renewal_mode, auto_granted_via_plan_id) VALUES (?, ?, ?, ?, 'active', 'manual', ?)`
      ).run(userId, plan.id, plan.service, plan.name, plan.id);
    } else if (!qualifies && existing && existing.auto_granted_via_plan_id) {
      // Only ever removes a copy this function granted itself - a
      // manually-assigned subscription to the same plan (auto_granted_via_plan_id
      // IS NULL) is never touched here.
      db.prepare(`UPDATE subscriptions SET status = 'expired', updated_at = datetime('now') WHERE id = ?`).run(existing.id);
    }
  });
}

module.exports = { syncIncludedPlansForUser };
