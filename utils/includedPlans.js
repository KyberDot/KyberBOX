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

    // Whichever specific trigger plan they actually qualify through - this
    // is what the subscription gets tagged with, so the dashboard can
    // nest it under the right parent plan's card rather than its own.
    const qualifyingTriggerId = triggerIds.find((id) => activePlanIds.has(id)) || null;
    const qualifies = qualifyingTriggerId !== null;

    const existing = db
      .prepare(`SELECT * FROM subscriptions WHERE user_id = ? AND plan_id = ? AND status = 'active'`)
      .get(userId, plan.id);

    if (qualifies && !existing) {
      db.prepare(
        `INSERT INTO subscriptions (user_id, plan_id, service, plan_name, status, renewal_mode, auto_granted_via_plan_id) VALUES (?, ?, ?, ?, 'active', 'manual', ?)`
      ).run(userId, plan.id, plan.service, plan.name, qualifyingTriggerId);
    } else if (qualifies && existing && existing.auto_granted_via_plan_id && existing.auto_granted_via_plan_id !== qualifyingTriggerId) {
      // Still qualifies, but through a different trigger plan than before
      // (e.g. the original one expired and a second trigger plan took
      // over) - update which plan it's nested under rather than leaving
      // it pointing at a trigger that's no longer active.
      db.prepare(`UPDATE subscriptions SET auto_granted_via_plan_id = ? WHERE id = ?`).run(qualifyingTriggerId, existing.id);
    } else if (!qualifies && existing && existing.auto_granted_via_plan_id) {
      // Only ever removes a copy this function granted itself - a
      // manually-assigned subscription to the same plan (auto_granted_via_plan_id
      // IS NULL) is never touched here.
      db.prepare(`UPDATE subscriptions SET status = 'expired', updated_at = datetime('now') WHERE id = ?`).run(existing.id);
    }
  });
}

module.exports = { syncIncludedPlansForUser };
