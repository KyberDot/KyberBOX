const { Client } = require('ssh2');
const { decrypt } = require('./crypto');

const EXEC_TIMEOUT_MS = 20000;

/**
 * Opens an SSH connection to a plan's registered server, runs exactly the
 * command passed in, and returns { success, output }. The command always
 * comes from admin-configured data (plan_actions.command or a health-check
 * command built from admin-configured container names) - subscribers never
 * supply or influence the command text itself, only click a button.
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
      finish({ success: false, output: 'Timed out connecting to the server.' });
    }, EXEC_TIMEOUT_MS);

    conn
      .on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            return finish({ success: false, output: `Failed to run command: ${err.message}` });
          }
          let stdout = '';
          let stderr = '';
          stream
            .on('close', (code) => {
              clearTimeout(timer);
              finish({
                success: code === 0,
                output: (stdout + stderr).slice(-4000) || `Command exited with code ${code}`,
              });
            })
            .on('data', (data) => { stdout += data.toString(); })
            .stderr.on('data', (data) => { stderr += data.toString(); });
        });
      })
      .on('error', (err) => {
        clearTimeout(timer);
        finish({ success: false, output: `Connection error: ${err.message}` });
      })
      .connect(connConfig);
  });
}

/** Runs a plan action's fixed command (e.g. "docker compose restart plex"). */
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
  return STATUS_MAP[key] || 'unknown';
}

/**
 * Checks the live status of one or more containers on a plan's server in a
 * single SSH round trip. Returns a map of container_name -> normalized
 * status ('up' | 'starting' | 'unhealthy' | 'down' | 'unknown').
 * Falls back to the container's plain running state when it has no
 * Docker healthcheck defined.
 */
async function getContainerStatuses(target, containerNames) {
  if (!containerNames || containerNames.length === 0) return {};

  // Only allow the charset Docker itself allows for container names, since
  // these are interpolated into a shell command string.
  const safeNames = containerNames.filter((n) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(n));
  if (safeNames.length === 0) return {};

  const quoted = safeNames.map((n) => `'${n}'`).join(' ');
  const command = `docker inspect --format='{{.Name}}::{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' ${quoted} 2>&1`;

  const result = await execOnTarget(target, command);
  const statuses = {};

  if (!result.success) {
    safeNames.forEach((n) => { statuses[n] = 'unknown'; });
    return statuses;
  }

  result.output.split('\n').forEach((line) => {
    const [rawName, rawStatus] = line.split('::');
    if (!rawName) return;
    const name = rawName.replace(/^\//, '').trim();
    if (name) statuses[name] = normalizeStatus(rawStatus);
  });

  // Anything Docker didn't return a line for (container missing, etc.)
  safeNames.forEach((n) => {
    if (!(n in statuses)) statuses[n] = 'unknown';
  });

  return statuses;
}

module.exports = { runCommand, getContainerStatuses };
