// Watches any number of admin-designated containers' recent logs for the
// "waiting on mounts/backends" pattern used by scripts like the Plex and
// Jellyfin mount-checkers: a loop of "⏳ ..." lines followed by a
// service-specific success marker once everything it depends on is
// actually up. Each watched container (see admin_page for management,
// stored in stuck_watch_containers) is checked and tracked independently
// - one container being stuck has no bearing on any other.
//
// Detecting "stuck" isn't as simple as "the tail contains a waiting
// line" - normal startup ALSO prints waiting lines while working through
// each step in turn. The real signal is the SAME step's message repeating
// across multiple checks with no progress. The scripts' messages are
// timestamped with $(date), so even genuinely stuck output never repeats
// verbatim - the signature comparison below strips everything before the
// ⏳ emoji so only the stable part of the message (the step description)
// is compared.

const db = require('../db');
const { runCommand } = require('./ssh');
const { triggerFullReset } = require('./fullReset');

const WAITING_MARKER = '⏳';

// Consecutive checks (each ~5 min apart, matching the scheduler's cadence)
// showing the exact same stuck step before a reset is triggered - roughly
// 15 minutes of zero progress, long enough that this isn't just a slow
// mount taking its normal time to come up.
const STUCK_THRESHOLD = 3;

function extractWaitingSignature(output) {
  const lines = output.trim().split('\n');
  const lastWaitingLine = lines.slice().reverse().find((l) => l.includes(WAITING_MARKER));
  if (!lastWaitingLine) return null;
  return lastWaitingLine.slice(lastWaitingLine.indexOf(WAITING_MARKER)).trim();
}

async function checkOneContainer(target, watch) {
  const safeName = watch.container_name.replace(/'/g, `'"'"'`);
  const result = await runCommand(target, `docker logs --tail 5 '${safeName}' 2>&1`, 30000);
  if (!result.success) return; // couldn't read logs this cycle (container down, SSH hiccup, etc.) - skip rather than guess, try again next cycle

  const output = result.output || '';

  if (output.includes(watch.success_marker)) {
    db.prepare(
      `UPDATE stuck_watch_containers SET consecutive_stuck_checks = 0, last_signature = NULL, last_status = 'ok', last_checked_at = datetime('now') WHERE id = ?`
    ).run(watch.id);
    return;
  }

  const signature = extractWaitingSignature(output);
  if (!signature) {
    // No clear waiting line and no success marker - ambiguous output
    // (container just restarted, unrelated log noise, etc.). Don't count
    // it as progress or as stuck; just note it and move on.
    db.prepare(`UPDATE stuck_watch_containers SET last_status = 'unknown', last_checked_at = datetime('now') WHERE id = ?`).run(watch.id);
    return;
  }

  const sameStepAsLastCheck = watch.last_signature === signature;
  const newCount = sameStepAsLastCheck ? watch.consecutive_stuck_checks + 1 : 1;

  db.prepare(
    `UPDATE stuck_watch_containers SET consecutive_stuck_checks = ?, last_signature = ?, last_status = 'waiting', last_checked_at = datetime('now') WHERE id = ?`
  ).run(newCount, signature, watch.id);

  if (newCount >= STUCK_THRESHOLD) {
    triggerFullReset(`Auto: stuck-mount watchdog (${watch.service_label})`, null, watch.service_label);
    db.prepare(
      `UPDATE stuck_watch_containers SET consecutive_stuck_checks = 0, last_signature = NULL, last_reset_triggered_at = datetime('now') WHERE id = ?`
    ).run(watch.id);
  }
}

async function checkStuckWatch() {
  const watches = db.prepare('SELECT * FROM stuck_watch_containers').all();
  if (watches.length === 0) return; // nothing configured - nothing to do

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) return; // can't check logs without SSH access configured

  // Sequential, not parallel: a stuck check that triggers a full reset
  // shouldn't race with another container's check also potentially
  // triggering one at the same moment - triggerFullReset already guards
  // against a reset starting while one's in progress, but going one at a
  // time keeps the log output and reasoning about it simpler.
  for (const watch of watches) {
    await checkOneContainer(target, watch);
  }
}

module.exports = { checkStuckWatch };
