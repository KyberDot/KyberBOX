// Watches one admin-designated container's recent logs for the specific
// "waiting on mounts/backends" pattern used by scripts like the Plex
// mount-checker (see the uploaded kscript_mnt_plex.sh for the exact
// pattern this is built against): a loop of "⏳ ..." lines followed by a
// success marker once everything it depends on is actually up.
//
// Detecting "stuck" isn't as simple as "the tail contains a waiting
// line" - normal startup ALSO prints waiting lines while working through
// each step in turn. The real signal is the SAME step's message repeating
// across multiple checks with no progress. The script's messages are
// timestamped with $(date), so even genuinely stuck output never repeats
// verbatim - the signature comparison below strips everything before the
// ⏳ emoji so only the stable part of the message (the step description)
// is compared.

const db = require('../db');
const { runCommand } = require('./ssh');
const { getAllSettings } = require('./settings');
const { triggerFullReset } = require('./fullReset');

const SUCCESS_MARKER = 'Starting Plex Media Server';
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

async function checkStuckWatch() {
  const settings = getAllSettings();
  const containerName = (settings.stuck_watch_container_name || '').trim();
  if (!containerName) return; // feature not configured - nothing to watch

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) return; // can't check logs without SSH access configured

  const safeName = containerName.replace(/'/g, `'"'"'`);
  const result = await runCommand(target, `docker logs --tail 5 '${safeName}' 2>&1`, 30000);
  if (!result.success) return; // couldn't read logs this cycle (container down, SSH hiccup, etc.) - skip rather than guess, try again next cycle

  const output = result.output || '';
  const state = db.prepare('SELECT * FROM stuck_watch_state WHERE id = 1').get();

  if (output.includes(SUCCESS_MARKER)) {
    db.prepare(
      `UPDATE stuck_watch_state SET consecutive_stuck_checks = 0, last_signature = NULL, last_status = 'ok', last_checked_at = datetime('now') WHERE id = 1`
    ).run();
    return;
  }

  const signature = extractWaitingSignature(output);
  if (!signature) {
    // No clear waiting line and no success marker - ambiguous output
    // (container just restarted, unrelated log noise, etc.). Don't count
    // it as progress or as stuck; just note it and move on.
    db.prepare(`UPDATE stuck_watch_state SET last_status = 'unknown', last_checked_at = datetime('now') WHERE id = 1`).run();
    return;
  }

  const sameStepAsLastCheck = state.last_signature === signature;
  const newCount = sameStepAsLastCheck ? state.consecutive_stuck_checks + 1 : 1;

  db.prepare(
    `UPDATE stuck_watch_state SET consecutive_stuck_checks = ?, last_signature = ?, last_status = 'waiting', last_checked_at = datetime('now') WHERE id = 1`
  ).run(newCount, signature);

  if (newCount >= STUCK_THRESHOLD) {
    triggerFullReset('Auto: stuck-mount watchdog', null);
    db.prepare(
      `UPDATE stuck_watch_state SET consecutive_stuck_checks = 0, last_signature = NULL, last_reset_triggered_at = datetime('now') WHERE id = 1`
    ).run();
  }
}

module.exports = { checkStuckWatch };
