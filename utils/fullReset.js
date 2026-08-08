// Extracted from the admin Full Reset route so the background stuck-mount
// watchdog (utils/stuckWatch.js) can trigger the exact same reset flow -
// same command, same notification behavior, same logging - rather than a
// second, slightly-different copy of this logic living in two places.

const db = require('../db');
const { runCommand } = require('./ssh');
const { getAllSettings } = require('./settings');
const { startReset, endReset, getResetState } = require('./resetLock');
const { notifyResetStarted } = require('./mailer');

let fullResetState = { running: false, lastResult: null };

function getFullResetState() {
  return fullResetState;
}

// adminUserId may be null for an automated trigger (no person actually
// clicked anything) - the health log entry falls back to the earliest
// full-access admin account so the FK constraint is satisfied and there's
// still a sensible "on behalf of whom" trail, rather than requiring a
// schema change to make the column nullable for this one case.
function triggerFullReset(source, adminUserId) {
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
  const command = `cd '${safePath}' && docker compose down && docker compose pull && docker compose up -d`;

  fullResetState = { running: true, lastResult: null };
  startReset(source);

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
  notifyResetStarted(allActiveSubscribers);

  runCommand(target, command, 15 * 60 * 1000)
    .then((result) => {
      db.prepare(
        'INSERT INTO admin_health_log (admin_user_id, container_name, action, success, output) VALUES (?, ?, ?, ?, ?)'
      ).run(resolvedAdminId, 'ALL (full stack)', source, result.success ? 1 : 0, result.output);

      fullResetState = {
        running: false,
        lastResult: {
          ok: result.success,
          message: result.success
            ? 'Full reset complete: stack was taken down, images pulled, and brought back up.'
            : `Full reset failed: ${result.output}`,
        },
      };
      endReset();
    })
    .catch((err) => {
      fullResetState = { running: false, lastResult: { ok: false, message: `Full reset failed: ${err.message}` } };
      endReset();
    });

  return { ok: true, started: true, message: 'Full reset started in the background — this can take several minutes.' };
}

module.exports = { triggerFullReset, getFullResetState };
