const db = require('../db');
const { getContainerStatuses } = require('./ssh');
const { getResetState } = require('./resetLock');
const { isContainerActionActive } = require('./containerActionLock');
const { getSetting } = require('./settings');
const { notifyAdminContainerUnhealthy } = require('./mailer');
const { parseStoredDate } = require('./time');

const UNHEALTHY_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

async function checkContainerWatchdog() {
  if (getSetting('container_watchdog_enabled', '0') !== '1') return;

  // A full stack reset takes every container down at once, intentionally -
  // not something to alert on. Individual restarts/updates are guarded per-
  // container below instead (see isContainerActionActive).
  if (getResetState().active) return;

  const mode = getSetting('container_watchdog_mode', 'all');
  const containers = mode === 'selected'
    ? db.prepare(
        `SELECT ahc.* FROM admin_health_containers ahc
         JOIN container_watchdog_selected cws ON cws.container_id = ahc.id
         WHERE ahc.is_active = 1`
      ).all()
    : db.prepare('SELECT * FROM admin_health_containers WHERE is_active = 1').all();

  if (containers.length === 0) return;

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) return;

  const statuses = await getContainerStatuses(target, containers.map((c) => c.container_name));
  const admins = db.prepare("SELECT name, email FROM users WHERE role = 'admin'").all();

  for (const container of containers) {
    if (isContainerActionActive(container.id)) continue; // intentional stop/restart/update in progress - expected downtime

    const status = statuses[container.container_name] || 'unknown';
    const isUnhealthy = status === 'down' || status === 'unhealthy';

    if (!isUnhealthy) {
      // Recovered (or was never down to begin with) - clear tracking so the
      // next episode, if any, starts its own fresh 2-minute countdown
      // rather than inheriting stale state from this one.
      if (container.first_seen_unhealthy_at || container.unhealthy_alert_sent_at) {
        db.prepare('UPDATE admin_health_containers SET first_seen_unhealthy_at = NULL, unhealthy_alert_sent_at = NULL WHERE id = ?').run(container.id);
      }
      continue;
    }

    if (!container.first_seen_unhealthy_at) {
      // First time seeing this container down in the current episode - just
      // start the clock, nothing to alert on yet.
      db.prepare(`UPDATE admin_health_containers SET first_seen_unhealthy_at = datetime('now') WHERE id = ?`).run(container.id);
      continue;
    }

    if (container.unhealthy_alert_sent_at) continue; // already alerted once for this episode - don't repeat every check

    const firstSeen = parseStoredDate(container.first_seen_unhealthy_at);
    if (!firstSeen || Date.now() - firstSeen.getTime() < UNHEALTHY_THRESHOLD_MS) continue; // not down long enough yet

    await notifyAdminContainerUnhealthy(admins, container, status).catch(() => {});
    db.prepare(`UPDATE admin_health_containers SET unhealthy_alert_sent_at = datetime('now') WHERE id = ?`).run(container.id);
  }
}

module.exports = { checkContainerWatchdog, UNHEALTHY_THRESHOLD_MS };
