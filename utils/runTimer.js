// Run timer for the Minecraft death counter widget - a simple pause/
// resume stopwatch per plan. Rather than storing a single "start time"
// that gets wiped on every pause (losing prior elapsed time), this
// splits elapsed time into two parts: accumulated_seconds (time banked
// from previous running segments) plus, if currently running, the time
// since started_at. Stopping banks the current segment into
// accumulated_seconds and clears started_at; starting again resumes from
// the banked total rather than losing it.

const db = require('../db');
const { parseStoredDate } = require('./time');

function computeElapsedSeconds(plan) {
  let total = plan.run_timer_accumulated_seconds || 0;
  if (plan.run_timer_status === 'running' && plan.run_timer_started_at) {
    const started = parseStoredDate(plan.run_timer_started_at);
    if (started) {
      total += Math.max(0, Math.floor((Date.now() - started.getTime()) / 1000));
    }
  }
  return total;
}

function startTimer(planId) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!plan || plan.run_timer_status === 'running') return; // already running - starting again would just reset started_at and lose nothing, but there's nothing to do
  db.prepare(`UPDATE plans SET run_timer_status = 'running', run_timer_started_at = datetime('now') WHERE id = ?`).run(planId);
}

function stopTimer(planId) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!plan || plan.run_timer_status !== 'running') return; // already stopped - nothing to bank
  const elapsed = computeElapsedSeconds(plan);
  db.prepare(`UPDATE plans SET run_timer_status = 'stopped', run_timer_started_at = NULL, run_timer_accumulated_seconds = ? WHERE id = ?`).run(elapsed, planId);
}

function restartTimer(planId) {
  db.prepare(`UPDATE plans SET run_timer_status = 'running', run_timer_started_at = datetime('now'), run_timer_accumulated_seconds = 0 WHERE id = ?`).run(planId);
}

// Called after a plan action completes successfully - if that action is
// the one this plan's timer is linked to, the run resets and starts
// fresh, same as an admin manually hitting Restart.
function resetIfLinkedAction(planId, actionId) {
  const plan = db.prepare('SELECT run_timer_linked_action_id FROM plans WHERE id = ?').get(planId);
  if (plan && plan.run_timer_linked_action_id === actionId) {
    restartTimer(planId);
  }
}

// Container actions (Health page, admin-only) aren't scoped to a single
// plan the way plan_actions are - a container isn't inherently "owned"
// by one plan, so unlike resetIfLinkedAction this has to check every
// plan for a matching link rather than being handed a single plan_id to
// check. In practice this is normally just one plan, but nothing stops
// more than one from linking to the same container action.
function resetIfLinkedContainerAction(containerActionId) {
  const linkedPlans = db.prepare('SELECT id FROM plans WHERE run_timer_linked_container_action_id = ?').all(containerActionId);
  linkedPlans.forEach((p) => restartTimer(p.id));
}

module.exports = { computeElapsedSeconds, startTimer, stopTimer, restartTimer, resetIfLinkedAction, resetIfLinkedContainerAction };
