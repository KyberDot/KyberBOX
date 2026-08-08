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
//
// The success marker, like the waiting lines, only ever gets printed
// once - right before the container hands off to the real service. Once
// that's happened, a chatty service (Jellyfin logging playback activity,
// library scans, etc.) can push that one line out of even a generous
// tail window within minutes, which would make a naive "always re-scan
// the tail" approach incorrectly flip a perfectly healthy container back
// to "unknown". Fixed the same way as vpnWatch.js: once a container's
// success has been confirmed, its logs are left alone on every
// subsequent check until its observed start time actually changes (i.e.
// it restarted), which is the only time the script would run its
// startup check again for real. This only applies to the confirmed-"ok"
// state - a container still in a genuine wait/stuck loop keeps getting
// checked normally every cycle, since that's exactly the multi-check
// comparison this whole feature depends on.

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

  const startedResult = await runCommand(target, `docker inspect --format='{{.State.StartedAt}}' '${safeName}' 2>&1`, 15000);
  if (!startedResult.success) return; // container not found / SSH hiccup - skip, try again next cycle
  const startedAt = (startedResult.output || '').trim();

  const containerRestarted = watch.last_container_start_at !== startedAt;

  // Already confirmed healthy and the container hasn't restarted since -
  // nothing new could have happened, since the script only ever runs its
  // check once per container lifetime. Skip re-scanning logs entirely
  // rather than risk the marker having scrolled out of view.
  if (!containerRestarted && watch.last_status === 'ok') {
    db.prepare(`UPDATE stuck_watch_containers SET last_checked_at = datetime('now') WHERE id = ?`).run(watch.id);
    return;
  }

  const result = await runCommand(target, `docker logs --tail 5 '${safeName}' 2>&1`, 30000);
  if (!result.success) return; // couldn't read logs this cycle (container down, SSH hiccup, etc.) - skip rather than guess, try again next cycle

  const output = result.output || '';

  if (output.includes(watch.success_marker)) {
    db.prepare(
      `UPDATE stuck_watch_containers SET consecutive_stuck_checks = 0, last_signature = NULL, last_status = 'ok', last_container_start_at = ?, last_checked_at = datetime('now') WHERE id = ?`
    ).run(startedAt, watch.id);
    return;
  }

  const signature = extractWaitingSignature(output);
  if (!signature) {
    // No clear waiting line and no success marker - ambiguous output
    // (container just restarted, unrelated log noise, etc.). Don't count
    // it as progress or as stuck; just note it and move on.
    db.prepare(`UPDATE stuck_watch_containers SET last_status = 'unknown', last_container_start_at = ?, last_checked_at = datetime('now') WHERE id = ?`).run(startedAt, watch.id);
    return;
  }

  // A restart resets the streak even if this check happens to land on
  // the same-looking step as before the restart - it's a fresh attempt,
  // not a continuation of the old one.
  const sameStepAsLastCheck = !containerRestarted && watch.last_signature === signature;
  const newCount = sameStepAsLastCheck ? watch.consecutive_stuck_checks + 1 : 1;

  db.prepare(
    `UPDATE stuck_watch_containers SET consecutive_stuck_checks = ?, last_signature = ?, last_status = 'waiting', last_container_start_at = ?, last_checked_at = datetime('now') WHERE id = ?`
  ).run(newCount, signature, startedAt, watch.id);

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
