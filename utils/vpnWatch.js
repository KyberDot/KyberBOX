// Watches any number of admin-designated containers that run a VPN-guard
// script before launching their real service (see the uploaded
// kscript_vpn*.sh variants) - they refuse to start until a VPN tunnel is
// confirmed up, printing one of two fixed lines either way. Unlike
// stuckWatch.js, this is a one-shot pass/fail read each check, not a
// multi-check "same step repeating" pattern - the container's script has
// already made its own determination by the time these lines appear, so
// a single check is enough to know the current state.
//
// The two marker phrases are identical across every VPN-guard script
// variant seen so far (kscript_vpn.sh, kscript_vpn_debrid.sh,
// kscript_python_vpn.sh) despite differences elsewhere in each script -
// different shells, different final exec targets, different status
// endpoints - so they're hardcoded rather than per-container
// configurable, unlike stuck_watch_containers' success_marker.
//
// Critically, the marker only ever gets printed ONCE, right at startup -
// it's never repeated. A chatty container (Decypharr itself, once
// actually running, is a good example) can push that one line out of
// any FIXED-SIZE `docker logs --tail` window within minutes. A tail-based
// scan can never recover from that once it's happened - every future
// check keeps looking at the same (now marker-less) recent window and
// keeps finding nothing, forever, regardless of how large the tail is or
// whether repeat scans are skipped. The actual fix is to stop using
// --tail at all: since the container's real start time is already known
// (`docker inspect` State.StartedAt), the log scan is windowed to
// exactly the startup period (start time to start+30min, generous for
// the scripts' own internal retry loops) using `docker logs --since/
// --until`. That window reliably contains the marker regardless of how
// much has been logged since - UNLESS Docker's own log rotation has
// already discarded the log data from that period entirely (e.g.
// json-file driver with max-size configured), in which case there's no
// evidence left in Docker at all, and no query, however well-targeted,
// can recover it.
//
// For that case there's a fallback: every one of these scripts exits 1
// on VPN failure, which under any sane restart policy means the
// container either stays stopped or keeps restarting - neither of which
// looks like "currently running, same start time, for a long time". So
// if a container has been running continuously well past how long these
// scripts could plausibly still be waiting, and its logs show no
// evidence either way, it's inferred active rather than left flagged
// inactive forever. This is a best-effort inference for when the real
// evidence is gone, not a substitute for finding it - the direct log
// check is always tried first.
//
// Three-state model (matches what's shown on the Health page):
//   active   - container running, VPN tunnel confirmed up
//   inactive - container running (up, unhealthy, or any other running
//              state), but the VPN isn't confirmed - either the script
//              printed its failure line, or no determination could be
//              made yet/at all. The container being up at all is what
//              distinguishes this from "unknown".
//   unknown  - container isn't running. Its VPN status genuinely can't
//              be known while it's not up, so this isn't "inactive" -
//              inactive specifically means "up, but VPN isn't".

const db = require('../db');
const { runCommand } = require('./ssh');
const { notifyAdminVpnInactive } = require('./mailer');
const { getSetting } = require('./settings');
const { parseStoredDate } = require('./time');

const SUCCESS_MARKER = 'VPN tunnel confirmed UP';
const FAILURE_MARKER = 'VPN connection FAILED';
const STARTUP_WINDOW_MINUTES = 30;

// Comfortably longer than these scripts' own internal max-wait loops
// (a few minutes at most) - if a container's been running this long with
// no failure ever observed, it didn't get here by exiting 1 repeatedly.
const STABLE_UPTIME_FALLBACK_MINUTES = 20;

// Matches the container health watchdog's own threshold, for consistency.
const INACTIVE_ALERT_THRESHOLD_MS = 2 * 60 * 1000;

function addMinutes(isoString, minutes) {
  const d = new Date(isoString);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

function minutesSince(isoString) {
  return (Date.now() - new Date(isoString).getTime()) / 60000;
}

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

async function checkOneContainer(target, watch) {
  const safeName = watch.container_name.replace(/'/g, `'"'"'`);

  const startedResult = await runCommand(target, `docker inspect --format='{{.State.StartedAt}}|{{.State.Running}}' '${safeName}' 2>&1`, 15000);
  if (!startedResult.success) return; // container not found / SSH hiccup - skip, try again next cycle
  const [startedAt, runningStr] = (startedResult.output || '').trim().split('|');
  const isRunning = runningStr === 'true';

  // A stopped container has no active VPN tunnel, full stop, regardless of
  // whatever it last reported while it was actually running - and "how
  // long has it been inactive" no longer applies either, since that's
  // specifically about a running-but-unconfirmed container. This has to
  // be checked before the "already have a determination" shortcut below -
  // docker inspect's StartedAt doesn't change when a container is merely
  // stopped (only when it's actually restarted), so without this check
  // that shortcut would keep treating a stopped container as if nothing
  // had changed and leave a stale "active" showing indefinitely.
  if (!isRunning) {
    if (watch.last_status !== 'unknown' || watch.first_seen_inactive_at || watch.inactive_alert_sent_at) {
      db.prepare(
        `UPDATE vpn_watch_containers SET last_status = 'unknown', first_seen_inactive_at = NULL, inactive_alert_sent_at = NULL, last_checked_at = datetime('now') WHERE id = ?`
      ).run(watch.id);
    } else {
      db.prepare(`UPDATE vpn_watch_containers SET last_checked_at = datetime('now') WHERE id = ?`).run(watch.id);
    }
    return;
  }

  const containerRestarted = watch.last_container_start_at !== startedAt;

  // Already have a real determination and the container hasn't restarted
  // since - nothing new could have happened, since the script only ever
  // runs its check once per container lifetime. Still re-checks the
  // inactive alert threshold though, since that's driven by time passing,
  // not by anything a fresh log scan could reveal.
  if (!containerRestarted && (watch.last_status === 'active' || watch.last_status === 'inactive')) {
    db.prepare(`UPDATE vpn_watch_containers SET last_checked_at = datetime('now') WHERE id = ?`).run(watch.id);
    if (watch.last_status === 'inactive') await maybeAlertInactive(watch);
    return;
  }

  const until = addMinutes(startedAt, STARTUP_WINDOW_MINUTES);
  const result = await runCommand(target, `docker logs --since '${startedAt}' --until '${until}' '${safeName}' 2>&1`, 30000);
  if (!result.success) return;

  const output = result.output || '';

  let newStatus;
  if (output.includes(SUCCESS_MARKER)) {
    newStatus = 'active';
  } else if (output.includes(FAILURE_MARKER)) {
    newStatus = 'inactive';
  } else if (minutesSince(startedAt) >= STABLE_UPTIME_FALLBACK_MINUTES) {
    // No direct evidence either way, most likely because Docker's own
    // log retention has already discarded the startup-period logs for a
    // long-running container - but it's been running continuously for
    // well longer than the script could still be waiting, with no
    // failure ever seen, so it's safe to infer success.
    newStatus = 'active';
  } else {
    // Neither marker present in the startup window, and the container
    // hasn't been running long enough yet for the stable-uptime fallback
    // to apply - the container is up but the VPN isn't confirmed, which
    // is exactly what "inactive" means under the new model.
    newStatus = 'inactive';
  }

  if (newStatus === 'active') {
    db.prepare(
      `UPDATE vpn_watch_containers SET last_status = 'active', last_container_start_at = ?, first_seen_inactive_at = NULL, inactive_alert_sent_at = NULL, last_checked_at = datetime('now') WHERE id = ?`
    ).run(startedAt, watch.id);
    return;
  }

  // newStatus === 'inactive'. This code path is only ever reached for a
  // genuinely new situation (the very first check for this watch, or the
  // container having just (re)started) - any continuation of an existing
  // inactive episode is handled by the shortcut above instead - so this
  // always starts a fresh episode timer rather than trying to preserve one.
  db.prepare(
    `UPDATE vpn_watch_containers SET last_status = 'inactive', last_container_start_at = ?, first_seen_inactive_at = datetime('now'), inactive_alert_sent_at = NULL, last_checked_at = datetime('now') WHERE id = ?`
  ).run(startedAt, watch.id);
}

async function checkVpnWatch() {
  const watches = db.prepare('SELECT * FROM vpn_watch_containers').all();
  if (watches.length === 0) return; // nothing configured - nothing to do

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) return; // can't check logs without SSH access configured

  for (const watch of watches) {
    await checkOneContainer(target, watch);
  }
}

module.exports = { checkVpnWatch };
