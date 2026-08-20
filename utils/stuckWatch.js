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
// once - right before the container hands off to the real service. A
// chatty service (Jellyfin logging playback activity, library scans,
// etc.) can push that one line out of any FIXED-SIZE tail window within
// minutes, and once that's happened a tail-based scan can never recover
// - every future check looks at the same (now marker-less) recent window
// and keeps finding nothing. The fix: the success marker is checked via
// a time-window query anchored to the container's actual start time
// (`docker inspect` State.StartedAt to start+30min), which reliably
// contains it regardless of how much has been logged since. The small
// recent tail is still used, but only as a fallback for the genuinely
// "what's happening right now" waiting-signature comparison the stuck-
// detection logic depends on - once the success marker is confirmed via
// the time-window check, subsequent checks are skipped entirely as long
// as the container hasn't actually restarted, since nothing could have
// changed.

const db = require('../db');
const { runCommand } = require('./ssh');
const { triggerFullReset } = require('./fullReset');

const WAITING_MARKER = '⏳';
const STARTUP_WINDOW_MINUTES = 30;

// Consecutive checks (each ~5 min apart, matching the scheduler's cadence)
// showing the exact same stuck step before a reset is triggered - roughly
// 15 minutes of zero progress, long enough that this isn't just a slow
// mount taking its normal time to come up.
const STUCK_THRESHOLD = 3;

function addMinutes(isoString, minutes) {
  const d = new Date(isoString);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

function extractWaitingSignature(output) {
  const lines = output.trim().split('\n');
  const lastWaitingLine = lines.slice().reverse().find((l) => l.includes(WAITING_MARKER));
  if (!lastWaitingLine) return null;
  return lastWaitingLine.slice(lastWaitingLine.indexOf(WAITING_MARKER)).trim();
}

async function checkOneContainer(target, watch) {
  const safeName = watch.container_name.replace(/'/g, `'"'"'`);

  const startedResult = await runCommand(target, `docker inspect --format='{{.State.StartedAt}}|{{.State.Running}}' '${safeName}' 2>&1`, 15000);
  if (!startedResult.success) return; // container not found / SSH hiccup - skip, try again next cycle
  const [startedAt, runningStr] = (startedResult.output || '').trim().split('|');
  const isRunning = runningStr === 'true';

  // A stopped container isn't "stuck" or "ok" - those concepts only apply
  // while it's actually running and working through its startup steps.
  // Checked before the "already confirmed healthy" shortcut below, since
  // StartedAt alone doesn't change when a container is merely stopped
  // (only when actually restarted) - without this, a stopped container
  // that was last known 'ok' would keep showing as 'ok' indefinitely.
  if (!isRunning) {
    if (watch.last_status !== 'offline') {
      db.prepare(`UPDATE stuck_watch_containers SET last_status = 'offline', consecutive_stuck_checks = 0, last_signature = NULL, last_checked_at = datetime('now') WHERE id = ?`).run(watch.id);
    } else {
      db.prepare(`UPDATE stuck_watch_containers SET last_checked_at = datetime('now') WHERE id = ?`).run(watch.id);
    }
    return;
  }

  const containerRestarted = watch.last_container_start_at !== startedAt;

  // Already confirmed healthy and the container hasn't restarted since -
  // nothing new could have happened, since the script only ever runs its
  // check once per container lifetime. Skip re-scanning logs entirely.
  if (!containerRestarted && watch.last_status === 'ok') {
    db.prepare(`UPDATE stuck_watch_containers SET last_checked_at = datetime('now') WHERE id = ?`).run(watch.id);
    return;
  }

  // Check the startup window specifically for the success marker first -
  // this is the part that reliably finds it regardless of how chatty the
  // container has become since.
  const until = addMinutes(startedAt, STARTUP_WINDOW_MINUTES);
  const windowResult = await runCommand(target, `docker logs --since '${startedAt}' --until '${until}' '${safeName}' 2>&1`, 30000);
  if (windowResult.success && (windowResult.output || '').includes(watch.success_marker)) {
    db.prepare(
      `UPDATE stuck_watch_containers SET consecutive_stuck_checks = 0, last_signature = NULL, last_status = 'ok', last_container_start_at = ?, last_checked_at = datetime('now') WHERE id = ?`
    ).run(startedAt, watch.id);
    return;
  }

  // Not found in the startup window (yet, or the container never
  // succeeds) - fall back to a small recent tail for the ongoing "same
  // step repeating" comparison, which needs to know what's happening
  // right now, not what happened at container start.
  const result = await runCommand(target, `docker logs --tail 5 '${safeName}' 2>&1`, 30000);
  if (!result.success) return; // couldn't read logs this cycle (container down, SSH hiccup, etc.) - skip rather than guess, try again next cycle

  const output = result.output || '';

  const signature = extractWaitingSignature(output);
  if (!signature) {
    // No clear waiting line in the recent tail either - ambiguous output
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
    // withUpdate=false: a stuck startup calls for a restart (down/up), not
    // a fresh image pull - pulling wouldn't address a stuck-startup issue
    // and would only add unnecessary downtime. Explicit here since
    // triggerFullReset's own default is true, which would otherwise show
    // the wrong (5-15 min) banner for what's actually a quick restart.
    // Admins see the technical "which watchdog fired" wording; subscribers
    // get a simpler version that doesn't assume they know what a
    // stuck-mount watchdog is - same event, different audiences.
    triggerFullReset(
      `Watchdog: stuck-mount detected an issue with (${watch.service_label}) a restart`,
      null,
      watch.service_label,
      false,
      `Admin: the system has detected an issue with (${watch.service_label}) an automatic restart`
    );
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
