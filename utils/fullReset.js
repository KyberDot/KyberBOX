// Extracted from the admin Full Reset route so the background stuck-mount
// watchdog (utils/stuckWatch.js) can trigger the exact same reset flow -
// same command, same notification behavior, same logging - rather than a
// second, slightly-different copy of this logic living in two places.

const db = require('../db');
const { runCommand } = require('./ssh');
const { getAllSettings } = require('./settings');
const { startReset, endReset, getResetState } = require('./resetLock');
const { notifyResetStarted, notifyAutoResetStarted } = require('./mailer');

const PULL_MAX_ATTEMPTS = 5;

// phase is null when idle, otherwise 'down' | 'pull' | 'up' - lets the
// frontend show exactly what's happening right now (including which pull
// attempt it's on) rather than just a generic "running" spinner, and lets
// it resume showing the right thing on page load/reload rather than only
// ever knowing about a reset it personally started.
let fullResetState = { running: false, phase: null, pullAttempt: 0, pullMaxAttempts: PULL_MAX_ATTEMPTS, lastResult: null };

function getFullResetState() {
  return fullResetState;
}

// Lets the admin manually clear a finished result from the banner. Only
// touches lastResult - if a reset is somehow currently running (shouldn't
// be reachable from the UI, which hides the dismiss button in that case,
// but defend against it anyway), this leaves that alone rather than
// clobbering an in-progress reset's state.
function dismissFullResetResult() {
  if (fullResetState.running) return;
  fullResetState = { ...fullResetState, lastResult: null };
}

// Runs down, then (if withUpdate) pull with up to PULL_MAX_ATTEMPTS
// retries, then up -d - always, regardless of whether pull ultimately
// succeeded. Previously this was one combined shell command
// ("down && pull && up"); running each step as its own SSH call is what
// makes the pull retry loop possible, since each attempt's success/failure
// needs to be inspected individually to decide whether to try again.
async function runResetSequence(target, safePath, withUpdate) {
  let combinedOutput = '';

  fullResetState = { running: true, phase: 'down', pullAttempt: 0, pullMaxAttempts: PULL_MAX_ATTEMPTS, lastResult: null, withUpdate };
  const downResult = await runCommand(target, `cd '${safePath}' && docker compose down`, 5 * 60 * 1000);
  combinedOutput += downResult.output;
  if (!downResult.success) {
    return { success: false, output: combinedOutput, pullFailedAfterRetries: false };
  }

  let pullFailedAfterRetries = false;
  if (withUpdate) {
    let pullSucceeded = false;
    for (let attempt = 1; attempt <= PULL_MAX_ATTEMPTS; attempt++) {
      fullResetState = { running: true, phase: 'pull', pullAttempt: attempt, pullMaxAttempts: PULL_MAX_ATTEMPTS, lastResult: null, withUpdate };
      const pullResult = await runCommand(target, `cd '${safePath}' && docker compose pull`, 10 * 60 * 1000);
      combinedOutput += `\n\n--- Pull attempt ${attempt}/${PULL_MAX_ATTEMPTS} ---\n${pullResult.output}`;
      if (pullResult.success) {
        pullSucceeded = true;
        break;
      }
      // Otherwise fall through and try again, up to PULL_MAX_ATTEMPTS -
      // most retry failures here are transient (registry timeout, rate
      // limit) and later layers are usually already cached locally from
      // the previous attempt, so retries are typically much faster than
      // the first one.
    }
    if (!pullSucceeded) pullFailedAfterRetries = true;
  }

  fullResetState = { running: true, phase: 'up', pullAttempt: 0, pullMaxAttempts: PULL_MAX_ATTEMPTS, lastResult: null, withUpdate };
  const upResult = await runCommand(target, `cd '${safePath}' && docker compose up -d`, 5 * 60 * 1000);
  combinedOutput += `\n\n--- Up ---\n${upResult.output}`;

  return { success: upResult.success, output: combinedOutput, pullFailedAfterRetries };
}

// adminUserId may be null for an automated trigger (no person actually
// clicked anything) - the health log entry falls back to the earliest
// full-access admin account so the FK constraint is satisfied and there's
// still a sensible "on behalf of whom" trail, rather than requiring a
// schema change to make the column nullable for this one case.
// serviceLabel is optional context for the auto-reset email specifically
// (e.g. "Plex", "Jellyfin") - passed explicitly by callers that know it,
// rather than parsed back out of the human-readable source string, which
// would be fragile if that wording ever changes.
// withUpdate controls whether images are pulled first (down, pull, up) or
// this is just a restart (down, up) with no pull step at all.
function triggerFullReset(source, adminUserId, serviceLabel, withUpdate = true) {
  const globalState = getResetState();
  if (globalState.active) {
    return { ok: false, message: `A reset is already in progress (${globalState.source || 'another action'}) - wait for it to finish first.` };
  }

  const settings = getAllSettings();
  const composePath = settings.compose_path;
  if (!composePath) {
    return { ok: false, message: 'Set a Docker Compose path in Settings first (e.g. /opt/media-stack).' };
  }

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) {
    return { ok: false, message: 'No admin SSH access configured yet. Set it up in Settings first.' };
  }

  const resolvedAdminId = adminUserId || db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1").get()?.id;
  if (!resolvedAdminId) {
    return { ok: false, message: 'No admin account exists to attribute this reset to.' };
  }

  const safePath = composePath.replace(/'/g, `'"'"'`);

  fullResetState = { running: true, phase: 'down', pullAttempt: 0, pullMaxAttempts: PULL_MAX_ATTEMPTS, lastResult: null, withUpdate };
  startReset(source, withUpdate);

  // Lazy-required to avoid a circular dependency - stuckWatch.js already
  // imports triggerFullReset from this file for its own auto-reset
  // feature, so importing it back at the top of this file would create a
  // real load-order cycle. Not awaited - the rest of this function needs
  // to return promptly, not wait on a live SSH-based scan.
  const { checkVpnWatch } = require('./vpnWatch');
  const { checkStuckWatch } = require('./stuckWatch');
  Promise.all([checkVpnWatch(), checkStuckWatch()]).catch(() => {});

  const allActiveSubscribers = db
    .prepare(
      `SELECT DISTINCT u.id, u.email, u.name FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE s.status = 'active'
         AND u.id NOT IN (
           SELECT s2.user_id FROM subscriptions s2
           JOIN plans p2 ON p2.id = s2.plan_id
           WHERE s2.status = 'active' AND p2.maintenance_mode = 1
         )`
    )
    .all();
  // Automated triggers (source starts with "Auto:") get a distinct email
  // explaining the system itself detected and is fixing an issue - a
  // manual reset email here would be confusing since nobody actually
  // clicked anything.
  if (source.startsWith('Auto:')) {
    notifyAutoResetStarted(allActiveSubscribers, serviceLabel, withUpdate);
  } else {
    notifyResetStarted(allActiveSubscribers, withUpdate);
  }

  runResetSequence(target, safePath, withUpdate)
    .then(async (result) => {
      db.prepare(
        'INSERT INTO admin_health_log (admin_user_id, container_name, action, success, output) VALUES (?, ?, ?, ?, ?)'
      ).run(resolvedAdminId, 'ALL (full stack)', source, result.success ? 1 : 0, result.output);

      let message;
      if (!result.success) {
        message = `Full reset failed: ${result.output}`;
      } else if (result.pullFailedAfterRetries) {
        message = `Reset complete and the stack is back up, but pulling images failed after ${PULL_MAX_ATTEMPTS} attempts (registry timeout or similar) - some containers are running their previous version. Check the log below and try again shortly to pick up the update.`;
      } else if (withUpdate) {
        message = 'Full reset complete: stack was taken down, images pulled, and brought back up.';
      } else {
        message = 'Reset complete: stack was taken down and brought back up.';
      }

      // Fresh check now that the stack is back up (or the attempt is over
      // either way) - awaited so the completion state reflects current
      // data, rather than whatever the last background cycle happened to
      // see, which could be several minutes stale by now.
      const { checkVpnWatch } = require('./vpnWatch');
      const { checkStuckWatch } = require('./stuckWatch');
      await Promise.all([checkVpnWatch(), checkStuckWatch()]).catch(() => {});

      fullResetState = { running: false, phase: null, pullAttempt: 0, pullMaxAttempts: PULL_MAX_ATTEMPTS, lastResult: { ok: result.success, message, completedAt: Date.now(), withUpdate } };
      endReset();
    })
    .catch((err) => {
      fullResetState = { running: false, phase: null, pullAttempt: 0, pullMaxAttempts: PULL_MAX_ATTEMPTS, lastResult: { ok: false, message: `Full reset failed: ${err.message}`, completedAt: Date.now(), withUpdate } };
      endReset();
    });

  return { ok: true, started: true, message: 'Reset started in the background — this can take several minutes.' };
}

module.exports = { triggerFullReset, getFullResetState, dismissFullResetResult };
