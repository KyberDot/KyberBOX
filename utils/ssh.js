const { Client } = require('ssh2');
const { decrypt } = require('./crypto');

const EXEC_TIMEOUT_MS = 20000;

/**
 * Opens an SSH connection to a server, runs exactly the command passed in,
 * and returns { success, output, connectionFailed }. connectionFailed is
 * true only when we couldn't reach/authenticate to the server at all (as
 * opposed to the command itself exiting non-zero, e.g. because a container
 * doesn't exist) - callers use this to tell "server unreachable" (unknown)
 * apart from "container isn't running" (down/offline).
 *
 * The command always comes from admin-configured data (a plan/admin action
 * command, or a health-check command built from admin-configured container
 * names) - subscribers never supply or influence the command text itself,
 * only click a button.
 */
function execOnTarget(target, command) {
  return new Promise((resolve) => {
    const conn = new Client();
    const secret = decrypt(target.secret_encrypted);

    const connConfig = {
      host: target.host,
      port: target.port || 22,
      username: target.username,
      readyTimeout: 10000,
    };

    if (target.auth_type === 'key') {
      connConfig.privateKey = secret;
    } else {
      connConfig.password = secret;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ success: false, connectionFailed: true, output: 'Timed out connecting to the server.' });
    }, EXEC_TIMEOUT_MS);

    conn
      .on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            return finish({ success: false, connectionFailed: true, output: `Failed to run command: ${err.message}` });
          }
          let stdout = '';
          let stderr = '';
          stream
            .on('close', (code) => {
              clearTimeout(timer);
              finish({
                success: code === 0,
                connectionFailed: false,
                output: (stdout + stderr).slice(-4000) || `Command exited with code ${code}`,
              });
            })
            .on('data', (data) => { stdout += data.toString(); })
            .stderr.on('data', (data) => { stderr += data.toString(); });
        });
      })
      .on('error', (err) => {
        clearTimeout(timer);
        finish({ success: false, connectionFailed: true, output: `Connection error: ${err.message}` });
      })
      .connect(connConfig);
  });
}

/** Runs a plan/admin action's fixed command (e.g. "docker compose restart plex"). */
function runCommand(target, command) {
  return execOnTarget(target, command);
}

const STATUS_MAP = {
  healthy: 'up',
  running: 'up',
  starting: 'starting',
  unhealthy: 'unhealthy',
  paused: 'down',
  exited: 'down',
  dead: 'down',
  created: 'starting',
  restarting: 'starting',
};

function normalizeStatus(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return STATUS_MAP[key] || null;
}

/**
 * Checks the live status of one or more containers on a server in a single
 * SSH round trip. Returns a map of container_name -> normalized status:
 * 'up' | 'starting' | 'unhealthy' | 'down' | 'unknown'.
 *
 * - 'unknown' is reserved for when we genuinely couldn't reach the server
 *   at all (SSH connection/auth failure) - we have no information.
 * - 'down' (shown to users as "Offline") is used whenever the server was
 *   reachable but a specific container is stopped, removed, or otherwise
 *   doesn't exist - i.e. we DO know its state, and its state is "not up".
 */
async function getContainerStatuses(target, containerNames) {
  if (!containerNames || containerNames.length === 0) return {};

  // Only allow the charset Docker itself allows for container names, since
  // these are interpolated into a shell command string.
  const safeNames = containerNames.filter((n) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(n));
  if (safeNames.length === 0) return {};

  const quoted = safeNames.map((n) => `'${n}'`).join(' ');
  // docker inspect exits non-zero if ANY name is missing, but still prints
  // a line for every name it did find - so we parse output regardless of
  // exit code and only fall back to "unknown" if the connection itself failed.
  const command = `docker inspect --format='{{.Name}}::{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' ${quoted} 2>&1`;

  const result = await execOnTarget(target, command);
  const statuses = {};

  if (result.connectionFailed) {
    safeNames.forEach((n) => { statuses[n] = 'unknown'; });
    return statuses;
  }

  result.output.split('\n').forEach((line) => {
    const [rawName, rawStatus] = line.split('::');
    if (!rawName) return;
    const name = rawName.replace(/^\//, '').trim();
    if (name && safeNames.includes(name)) {
      statuses[name] = normalizeStatus(rawStatus) || 'down';
    }
  });

  // The server responded but gave us no line for this name at all (e.g.
  // "No such object") - we know it's not running, so it's offline, not unknown.
  safeNames.forEach((n) => {
    if (!(n in statuses)) statuses[n] = 'down';
  });

  return statuses;
}

module.exports = { runCommand, getContainerStatuses };
