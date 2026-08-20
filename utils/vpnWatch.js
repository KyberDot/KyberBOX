// Watches admin-designated containers that route through Gluetun (or a
// similar VPN sidecar), using nothing but the container's own Docker
// health status - no log scanning, no marker scripts, no startup windows,
// no "did it restart" tracking. A single `docker inspect` per check is
// enough, since Docker's own health status already reflects the current,
// live state at all times - there's nothing stale to work around the way
// a one-shot log line was.
//
// Docker health status is one of: no healthcheck defined at all,
// "starting" (still running its first check), "healthy", or "unhealthy".
// Combined with whether the container is running, that reduces cleanly
// to this app's three states:
//
//   active   - container running, and Docker reports it healthy (or has
//              no healthcheck defined at all, in which case simply
//              running is treated as active - there's nothing else to
//              check in that case).
//   inactive - container running, but Docker reports it unhealthy or
//              still starting up.
//   unknown  - container isn't running at all. Health status is
//              meaningless while stopped, so this isn't "inactive" -
//              inactive specifically means "up, but not healthy".

const db = require('../db');
const { runCommand } = require('./ssh');
const { notifyAdminVpnInactive } = require('./mailer');
const { getSetting } = require('./settings');
const { parseStoredDate } = require('./time');

// Matches the container health watchdog's own threshold, for consistency.
const INACTIVE_ALERT_THRESHOLD_MS = 2 * 60 * 1000;

// Sends the admin alert once a watch's inactive episode has been running
// long enough, if it hasn't already been sent for this episode. Safe to
// call on every check regardless of whether anything just changed - time
// passing is the trigger here, not a fresh determination, so this has to
// be re-evaluated every pass even when the status itself is unchanged.
async function maybeAlertInactive(watch) {
  if (getSetting('vpn_watchdog_enabled', '1') !== '1') return;
  if (!watch.first_seen_inactive_at || watch.inactive_alert_sent_at) return;

  const firstSeen = parseStoredDate(watch.first_seen_inactive_at);
  if (!firstSeen || Date.now() - firstSeen.getTime() < INACTIVE_ALERT_THRESHOLD_MS) return;

  const admins = db.prepare("SELECT name, email FROM users WHERE role = 'admin'").all();
  await notifyAdminVpnInactive(admins, watch.service_label, watch.container_name).catch(() => {});
  db.prepare(`UPDATE vpn_watch_containers SET inactive_alert_sent_at = datetime('now') WHERE id = ?`).run(watch.id);
}

// Clears episode tracking and updates last_status/last_checked_at for a
// transition into 'active' or 'unknown' - both are "nothing to alert on"
// outcomes, just with a different resulting status.
function recordNonInactiveStatus(watch, newStatus) {
  if (watch.last_status !== newStatus || watch.first_seen_inactive_at || watch.inactive_alert_sent_at) {
    db.prepare(
      `UPDATE vpn_watch_containers SET last_status = ?, first_seen_inactive_at = NULL, inactive_alert_sent_at = NULL, last_checked_at = datetime('now') WHERE id = ?`
    ).run(newStatus, watch.id);
  } else {
    db.prepare(`UPDATE vpn_watch_containers SET last_checked_at = datetime('now') WHERE id = ?`).run(watch.id);
  }
}

async function checkOneContainer(target, watch) {
  const safeName = watch.container_name.replace(/'/g, `'"'"'`);

  // {{if .State.Health}} guards against containers with no healthcheck
  // defined at all - accessing .Status directly on a nil Health object
  // would otherwise error out the whole command.
  const result = await runCommand(
    target,
    `docker inspect --format='{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' '${safeName}' 2>&1`,
    15000
  );
  if (!result.success) return; // container not found / SSH hiccup - skip, try again next cycle

  const [runningStr, health] = (result.output || '').trim().split('|');
  const isRunning = runningStr === 'true';

  let newStatus;
  if (!isRunning) {
    newStatus = 'unknown';
  } else if (health === 'unhealthy' || health === 'starting') {
    newStatus = 'inactive';
  } else {
    // health === 'healthy', or 'none' (no healthcheck defined) - simply
    // running is treated as active in that case.
    newStatus = 'active';
  }

  if (newStatus !== 'inactive') {
    recordNonInactiveStatus(watch, newStatus);
    return;
  }

  if (watch.last_status === 'inactive' && watch.first_seen_inactive_at) {
    // Continuing an existing inactive episode - keep its original episode
    // timer, just re-check whether it's crossed the alert threshold yet.
    db.prepare(`UPDATE vpn_watch_containers SET last_checked_at = datetime('now') WHERE id = ?`).run(watch.id);
    await maybeAlertInactive(watch);
    return;
  }

  // Freshly became inactive (was active or unknown before) - start a new episode.
  db.prepare(
    `UPDATE vpn_watch_containers SET last_status = 'inactive', first_seen_inactive_at = datetime('now'), inactive_alert_sent_at = NULL, last_checked_at = datetime('now') WHERE id = ?`
  ).run(watch.id);
}

async function checkVpnWatch() {
  const watches = db.prepare('SELECT * FROM vpn_watch_containers').all();
  if (watches.length === 0) return; // nothing configured - nothing to do

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) return; // can't check without SSH access configured

  for (const watch of watches) {
    await checkOneContainer(target, watch);
  }
}

module.exports = { checkVpnWatch };
