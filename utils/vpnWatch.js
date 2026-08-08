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
// actually running, is a good example) can easily push that one line out
// of even a fairly large `docker logs --tail` window within minutes,
// which would make a naive "re-scan the tail every check" approach
// eventually and incorrectly report "unknown" for a container that's
// been fine the whole time. Fixed by tracking each container's observed
// start time (`docker inspect` State.StartedAt) - once a status has been
// determined, it's left alone on every subsequent check until the
// container's start time actually changes (i.e. it restarted), which is
// the only time the script would run its check again for real.

const db = require('../db');
const { runCommand } = require('./ssh');
const { notifyAdminVpnFailure } = require('./mailer');

const SUCCESS_MARKER = 'VPN tunnel confirmed UP';
const FAILURE_MARKER = 'VPN connection FAILED';

async function checkOneContainer(target, watch) {
  const safeName = watch.container_name.replace(/'/g, `'"'"'`);

  const startedResult = await runCommand(target, `docker inspect --format='{{.State.StartedAt}}' '${safeName}' 2>&1`, 15000);
  if (!startedResult.success) return; // container not found / SSH hiccup - skip, try again next cycle
  const startedAt = (startedResult.output || '').trim();

  const containerRestarted = watch.last_container_start_at !== startedAt;

  // Already have a real determination and the container hasn't restarted
  // since - nothing new could have happened, since the script only ever
  // runs its check once per container lifetime. Skip re-scanning logs
  // entirely rather than risk the marker having scrolled out of view.
  if (!containerRestarted && (watch.last_status === 'connected' || watch.last_status === 'failed')) {
    db.prepare(`UPDATE vpn_watch_containers SET last_checked_at = datetime('now') WHERE id = ?`).run(watch.id);
    return;
  }

  const result = await runCommand(target, `docker logs --tail 50 '${safeName}' 2>&1`, 30000);
  if (!result.success) return;

  const output = result.output || '';

  let newStatus;
  if (output.includes(FAILURE_MARKER)) {
    newStatus = 'failed';
  } else if (output.includes(SUCCESS_MARKER)) {
    newStatus = 'connected';
  } else {
    // Neither marker present yet - still waiting on the tunnel this run,
    // or this container's script never had WAIT_FOR_VPN=true set at all.
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
