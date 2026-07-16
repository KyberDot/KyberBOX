const { Client } = require('ssh2');
const { decrypt } = require('./crypto');

const EXEC_TIMEOUT_MS = 20000;

/**
 * Connects to a subscriber's registered server and runs ONLY the fixed
 * restart command stored for that target. There is no free-form command
 * execution path anywhere in this app - this function is the single,
 * narrow point where a command ever reaches a remote server.
 */
function runRestartCommand(target) {
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
        conn.exec(target.restart_command, (err, stream) => {
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

module.exports = { runRestartCommand };
