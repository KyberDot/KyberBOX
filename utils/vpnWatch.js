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
// evidence either way, it's inferred connected rather than left stuck on
// unknown forever. This is a best-effort inference for when the real
// evidence is gone, not a substitute for finding it - the direct log
// check is always tried first.

const db = require('../db');
const { runCommand } = require('./ssh');
const { notifyAdminVpnFailure } = require('./mailer');

const SUCCESS_MARKER = 'VPN tunnel confirmed UP';
const FAILURE_MARKER = 'VPN connection FAILED';
const STARTUP_WINDOW_MINUTES = 30;

// Comfortably longer than these scripts' own internal max-wait loops
// (a few minutes at most) - if a container's been running this long with
// no failure ever observed, it didn't get here by exiting 1 repeatedly.
const STABLE_UPTIME_FALLBACK_MINUTES = 20;

function addMinutes(isoString, minutes) {
  const d = new Date(isoString);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

function minutesSince(isoString) {
  return (Date.now() - new Date(isoString).getTime()) / 60000;
}

async function checkOneContainer(target, watch) {
  const safeName = watch.container_name.replace(/'/g, `'"'"'`);

  const startedResult = await runCommand(target, `docker inspect --format='{{.State.StartedAt}}|{{.State.Running}}' '${safeName}' 2>&1`, 15000);
  if (!startedResult.success) return; // container not found / SSH hiccup - skip, try again next cycle
  const [startedAt, runningStr] = (startedResult.output || '').trim().split('|');
  const isRunning = runningStr === 'true';

  const containerRestarted = watch.last_container_start_at !== startedAt;

  // Already have a real determination and the container hasn't restarted
  // since - nothing new could have happened, since the script only ever
  // runs its check once per container lifetime.
  if (!containerRestarted && (watch.last_status === 'connected' || watch.last_status === 'failed')) {
    db.prepare(`UPDATE vpn_watch_containers SET last_checked_at = datetime('now') WHERE id = ?`).run(watch.id);
    return;
  }

  const until = addMinutes(startedAt, STARTUP_WINDOW_MINUTES);
  const result = await runCommand(target, `docker logs --since '${startedAt}' --until '${until}' '${safeName}' 2>&1`, 30000);
  if (!result.success) return;

  const output = result.output || '';

  let newStatus;
  if (output.includes(FAILURE_MARKER)) {
    newStatus = 'failed';
  } else if (output.includes(SUCCESS_MARKER)) {
    newStatus = 'connected';
  } else if (isRunning && minutesSince(startedAt) >= STABLE_UPTIME_FALLBACK_MINUTES) {
    // No direct evidence either way, most likely because Docker's own
    // log retention has already discarded the startup-period logs for a
    // long-running container - but it's been running continuously for
    // well longer than the script could still be waiting, with no
    // failure ever seen, so it's safe to infer success.
    newStatus = 'connected';
  } else {
    // Neither marker present in the startup window, and the container
    // hasn't been running long enough yet for the stable-uptime fallback
    // to apply - still genuinely unresolved.
    newStatus = 'unknown';
  }

  const wasAlreadyFailing = !containerRestarted && watch.last_status === 'failed';
  db.prepare(
    `UPDATE vpn_watch_containers SET last_status = ?, last_container_start_at = ?, last_checked_at = datetime('now') WHERE id = ?`
  ).run(newStatus, startedAt, watch.id);

  // Only alert on the transition INTO failed, not on every check while it
  // stays failed - otherwise a VPN that's been down for a day would mean
  // an email every 5 minutes for the same ongoing issue.
  if (newStatus === 'failed' && !wasAlreadyFailing) {
    const admins = db.prepare("SELECT name, email FROM users WHERE role = 'admin'").all();
    notifyAdminVpnFailure(admins, watch.service_label, watch.container_name);
    db.prepare(`UPDATE vpn_watch_containers SET last_alert_sent_at = datetime('now') WHERE id = ?`).run(watch.id);
  }
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
