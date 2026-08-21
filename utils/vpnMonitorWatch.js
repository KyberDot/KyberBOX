// Background poll for each configured VPN monitor (gluetun instance) -
// records its current status into a rolling history (kept to the most
// recent 30 entries per monitor) and updates the monitor's own
// last_status/last_public_ip so the main VPN Monitor list can show a
// badge and public IP without needing a live fetch every time the list
// renders.
//
// Four-state model:
//   connected    - gluetun reports the VPN tunnel is running
//   paused       - gluetun is reachable and reports the VPN intentionally
//                  stopped (e.g. via the Stop button)
//   disconnected - gluetun's control server responded, but with an error
//                  status code or an unrecognized status value - reached
//                  it, but something's wrong
//   unknown      - couldn't reach gluetun's control server at all (DNS/
//                  connection failure, timeout, curl missing, etc) - no
//                  information available either way

const db = require('../db');
const { runCommand } = require('./ssh');
const { resolveGluetunHost } = require('./gluetunClient');

const HISTORY_LIMIT = 30;

function splitHttpCode(segment) {
  const idx = segment.lastIndexOf('HTTP_CODE:');
  if (idx === -1) return { body: segment, httpCode: null };
  return { body: segment.slice(0, idx).trim(), httpCode: segment.slice(idx + 'HTTP_CODE:'.length).trim() };
}

// Determines a single monitor's current status/public IP - no database
// writes at all, so this is safe to call from a fast on-page "refresh now"
// action as often as needed without affecting the longer-term poll
// history, as well as from the background watchdog below.
async function getLiveVpnStatus(target, monitor) {
  const hostResolution = await resolveGluetunHost(target, monitor.url);
  if (!hostResolution) return { status: 'unknown', publicIp: null };

  const curlCheck = await runCommand(target, 'command -v curl 2>&1', 10000);
  if (!curlCheck.success || !curlCheck.output.trim()) return { status: 'unknown', publicIp: null };

  const safeUrl = monitor.url.replace(/'/g, `'"'"'`);
  const segmentMarker = '::KBVPNPOLL_SEGMENT::';
  const command = [
    `curl -s -m 5 ${hostResolution.resolveFlag}-w '\\nHTTP_CODE:%{http_code}' '${safeUrl}/v1/vpn/status' 2>&1`,
    `curl -s -m 5 ${hostResolution.resolveFlag}-w '\\nHTTP_CODE:%{http_code}' '${safeUrl}/v1/publicip/ip' 2>&1`,
  ].join(` ; echo '${segmentMarker}' ; `);

  const result = await runCommand(target, command, 20000);
  if (result.connectionFailed) return { status: 'unknown', publicIp: null };

  const segments = result.output.split(segmentMarker).map((s) => s.trim());
  const statusSegment = splitHttpCode(segments[0] || '');
  const ipSegment = splitHttpCode(segments[1] || '');

  let status = 'unknown';
  if (statusSegment.httpCode && /^2\d\d$/.test(statusSegment.httpCode)) {
    try {
      const parsed = JSON.parse(statusSegment.body);
      if (parsed && typeof parsed.status === 'string') {
        const raw = parsed.status.toLowerCase();
        status = raw === 'running' ? 'connected' : (raw === 'stopped' ? 'paused' : 'disconnected');
      } else {
        status = 'disconnected'; // reached it, but the response shape wasn't what was expected
      }
    } catch (e) {
      status = 'disconnected'; // reached it, but couldn't parse the response at all
    }
  } else if (statusSegment.httpCode) {
    status = 'disconnected'; // reached it, but got an error status code
  }
  // else: no HTTP code at all means the connection itself failed - stays 'unknown'

  let publicIp = null;
  if (ipSegment.httpCode && /^2\d\d$/.test(ipSegment.httpCode)) {
    try {
      const parsed = JSON.parse(ipSegment.body);
      if (parsed && typeof parsed.public_ip === 'string') publicIp = parsed.public_ip;
    } catch (e) {
      // couldn't parse - publicIp stays null, not a reason to fail the whole poll
    }
  }

  return { status, publicIp };
}

function recordHistory(monitorId, status, publicIp) {
  db.prepare('INSERT INTO admin_vpn_monitor_history (monitor_id, status) VALUES (?, ?)').run(monitorId, status);
  db.prepare(
    `UPDATE admin_vpn_monitors SET last_status = ?, last_public_ip = ?, last_checked_at = datetime('now') WHERE id = ?`
  ).run(status, publicIp, monitorId);

  // Prune to the most recent HISTORY_LIMIT rows for this monitor - keeps
  // the table from growing unbounded, since this runs on every poll cycle
  // indefinitely.
  db.prepare(
    `DELETE FROM admin_vpn_monitor_history WHERE monitor_id = ? AND id NOT IN (
       SELECT id FROM admin_vpn_monitor_history WHERE monitor_id = ? ORDER BY id DESC LIMIT ?
     )`
  ).run(monitorId, monitorId, HISTORY_LIMIT);
}

async function pollOneMonitor(target, monitor) {
  const { status, publicIp } = await getLiveVpnStatus(target, monitor);
  recordHistory(monitor.id, status, publicIp);
}

async function checkVpnMonitors() {
  const monitors = db.prepare('SELECT * FROM admin_vpn_monitors').all();
  if (monitors.length === 0) return; // nothing configured - nothing to do

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) return; // can't check without SSH access configured

  for (const monitor of monitors) {
    await pollOneMonitor(target, monitor);
  }
}

module.exports = { checkVpnMonitors, getLiveVpnStatus };
