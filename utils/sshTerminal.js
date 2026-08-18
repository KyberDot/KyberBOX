const { WebSocketServer } = require('ws');
const { parseCookie } = require('cookie');
const jwt = require('jsonwebtoken');
const { Client } = require('ssh2');
const db = require('../db');
const { decrypt } = require('./crypto');

const TERMINAL_PATH = '/admin/ssh-console/ws';

// Mirrors requireAdmin's checks (middleware/auth.js) since a raw HTTP
// upgrade request never passes through Express's normal middleware chain -
// cookies aren't parsed, req.user isn't attached, none of it. Anyone
// allowed to open the SSH Console page under limited-admin access
// ('overview' page key, same as the HTTP route falls back to) should be
// able to open a terminal here too, and nobody else.
function authenticateUpgrade(req) {
  const cookies = parseCookie(req.headers.cookie || '');
  const token = cookies.kb_session;
  if (!token) return null;

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.prepare('SELECT id, name, role, admin_access_mode FROM users WHERE id = ?').get(payload.id);
    if (!user || user.role !== 'admin') return null;

    if (user.admin_access_mode === 'limited') {
      const allowed = db.prepare("SELECT 1 FROM admin_page_access WHERE user_id = ? AND page_key = 'overview'").get(user.id);
      if (!allowed) return null;
    }

    return user;
  } catch (_) {
    return null;
  }
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

// Attaches the WebSocket upgrade handler to the existing HTTP server -
// called once from server.js alongside app.listen(), rather than running
// a second server on a different port.
function attachSshTerminal(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_) {
      socket.destroy();
      return;
    }
    if (pathname !== TERMINAL_PATH) return; // not ours - leave the socket alone

    const user = authenticateUpgrade(req);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, user);
    });
  });

  wss.on('connection', (ws, req, user) => {
    const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
    if (!target) {
      send(ws, { type: 'error', message: 'No admin SSH access configured yet. Set it up in Settings first.' });
      ws.close();
      return;
    }

    const conn = new Client();
    let secret;
    try {
      secret = decrypt(target.secret_encrypted);
    } catch (err) {
      send(ws, { type: 'error', message: 'Could not decrypt the stored SSH credential.' });
      ws.close();
      return;
    }

    const connConfig = {
      host: target.host,
      port: target.port || 22,
      username: target.username,
      readyTimeout: 10000,
    };
    if (target.auth_type === 'key') connConfig.privateKey = secret;
    else connConfig.password = secret;

    let sshStream = null;
    let sessionLogged = false;
    const sessionStartedAt = Date.now();

    function logSessionEnd(note) {
      if (sessionLogged) return; // closing one side triggers closing the other, in either order - only log once
      sessionLogged = true;
      const seconds = Math.round((Date.now() - sessionStartedAt) / 1000);
      try {
        db.prepare('INSERT INTO ssh_console_log (admin_user_id, command, success, output) VALUES (?, ?, ?, ?)').run(
          user.id,
          '[Interactive Terminal Session]',
          1,
          `Session lasted ${seconds}s. ${note}`.trim()
        );
      } catch (_) {
        // best-effort audit log - never let a logging failure affect the actual session
      }
    }

    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
        if (err) {
          send(ws, { type: 'error', message: `Failed to open shell: ${err.message}` });
          ws.close();
          return;
        }

        sshStream = stream;
        send(ws, { type: 'ready' });

        stream.on('data', (data) => send(ws, { type: 'data', data: data.toString('utf8') }));
        stream.stderr.on('data', (data) => send(ws, { type: 'data', data: data.toString('utf8') }));

        stream.on('close', () => {
          logSessionEnd('Closed by remote shell.');
          try { conn.end(); } catch (_) {}
          if (ws.readyState === ws.OPEN) ws.close();
        });
      });
    });

    conn.on('error', (err) => {
      send(ws, { type: 'error', message: `Connection error: ${err.message}` });
      try { ws.close(); } catch (_) {}
    });

    conn.connect(connConfig);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_) {
        return;
      }
      if (!sshStream) return;

      if (msg.type === 'input' && typeof msg.data === 'string') {
        sshStream.write(msg.data);
      } else if (msg.type === 'resize' && Number.isInteger(msg.rows) && Number.isInteger(msg.cols)) {
        sshStream.setWindow(msg.rows, msg.cols);
      }
    });

    ws.on('close', () => {
      if (sshStream) logSessionEnd('Closed by browser.');
      try { if (sshStream) sshStream.end(); } catch (_) {}
      try { conn.end(); } catch (_) {}
    });
  });
}

module.exports = { attachSshTerminal };
