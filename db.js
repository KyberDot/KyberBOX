const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'kyberbox.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'subscriber', -- 'admin' | 'subscriber'
  must_change_password INTEGER NOT NULL DEFAULT 0,
  payment_method_id INTEGER REFERENCES payment_methods(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A Plan is the admin-defined bundle a subscriber is assigned to: it owns
-- the feature list shown on login, the SSH target used for its actions,
-- which containers' health is displayed, which action buttons appear,
-- pricing, and maintenance-mode state.
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  service TEXT NOT NULL, -- docker | plex | stream | indexers | hosting | multiple
  description TEXT,
  features TEXT,         -- one feature per line, shown as a bullet list to subscribers
  price REAL,
  currency TEXT NOT NULL DEFAULT 'GBP', -- GBP | USD | CAD
  maintenance_mode INTEGER NOT NULL DEFAULT 0,
  maintenance_resume_at TEXT,  -- UTC datetime string; shown to subscribers in UK time
  maintenance_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One SSH target per plan (not per user) - every subscriber on a plan shares
-- the same underlying server access for that plan's actions/health checks.
CREATE TABLE IF NOT EXISTS plan_ssh (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL UNIQUE REFERENCES plans(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'password', -- password | key
  secret_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Admin-defined action buttons available to subscribers on a plan
-- (e.g. "Restart Plex" -> docker compose restart plex). The command is
-- always admin-supplied, never user input - subscribers only ever click
-- a button, they never type or influence the command that runs.
CREATE TABLE IF NOT EXISTS plan_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  command TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'fa-rotate',
  cooldown_hours INTEGER NOT NULL DEFAULT 6,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Containers whose live health/status is shown to subscribers on a plan's
-- dashboard card (e.g. the "plex" container from the compose stack).
CREATE TABLE IF NOT EXISTS plan_containers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  container_name TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  service TEXT NOT NULL,        -- docker | plex | stream | indexers | hosting | multiple
  plan_name TEXT NOT NULL DEFAULT 'Standard',
  status TEXT NOT NULL DEFAULT 'active', -- active | suspended | expired
  renewal_mode TEXT NOT NULL DEFAULT 'manual', -- auto | manual | expired
  expires_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Rate-limits and audits every time a subscriber clicks a plan action button.
CREATE TABLE IF NOT EXISTS action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_action_id INTEGER NOT NULL REFERENCES plan_actions(id) ON DELETE CASCADE,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  success INTEGER NOT NULL DEFAULT 0,
  output TEXT
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general', -- general | plex | docker | stream | indexers | hosting
  status TEXT NOT NULL DEFAULT 'open',      -- open | answered | closed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL, -- admin | subscriber
  sender_name TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-row key/value store for admin-configurable settings (SMTP, site URL, etc.)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Admin-wide SSH target used only by the Admin Health page - separate from
-- any per-plan SSH target, since the health page can monitor the entire
-- compose stack rather than just one plan's containers.
CREATE TABLE IF NOT EXISTS admin_ssh (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'password',
  secret_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The list of containers shown on the Admin Health page (independent of
-- any plan's own container list, though the same container can appear in both).
CREATE TABLE IF NOT EXISTS admin_health_containers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  container_name TEXT NOT NULL,
  label TEXT NOT NULL,
  logo_path TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audits every Stop/Restart click on the Admin Health page.
CREATE TABLE IF NOT EXISTS admin_health_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  container_name TEXT NOT NULL,
  action TEXT NOT NULL, -- stop | restart
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  success INTEGER NOT NULL DEFAULT 0,
  output TEXT
);

-- Deprecated as of the Plans feature - kept only so existing installs don't
-- error out on startup. No longer read from or written to by the app;
-- server access is now configured per-Plan via plan_ssh/plan_actions instead.
CREATE TABLE IF NOT EXISTS ssh_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'password',
  secret_encrypted TEXT NOT NULL,
  restart_command TEXT NOT NULL DEFAULT 'docker compose restart plex',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS restart_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  success INTEGER NOT NULL DEFAULT 0,
  output TEXT
);
`);

// ---- Migrations for installs created before newer columns existed ----

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

ensureColumn('subscriptions', 'plan_id', 'plan_id INTEGER REFERENCES plans(id)');
ensureColumn('plans', 'price', 'price REAL');
ensureColumn('plans', 'currency', "currency TEXT NOT NULL DEFAULT 'GBP'");
ensureColumn('plans', 'maintenance_mode', 'maintenance_mode INTEGER NOT NULL DEFAULT 0');
ensureColumn('plans', 'maintenance_resume_at', 'maintenance_resume_at TEXT');
ensureColumn('plans', 'maintenance_message', 'maintenance_message TEXT');
ensureColumn('users', 'payment_method_id', 'payment_method_id INTEGER REFERENCES payment_methods(id)');
ensureColumn('subscriptions', 'renewal_mode', "renewal_mode TEXT NOT NULL DEFAULT 'manual'"); // auto | manual | expired
ensureColumn('admin_health_containers', 'logo_path', 'logo_path TEXT');

// Bootstrap the first admin account from env vars if no admin exists yet.
function ensureBootstrapAdmin() {
  const existingAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existingAdmin) return;

  const email = (process.env.ADMIN_EMAIL || 'admin@kyberbox.app').toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD || 'change_this_password';
  const hash = bcrypt.hashSync(password, 12);

  db.prepare(
    `INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES (?, ?, ?, 'admin', 0)`
  ).run('KyberBOX Admin', email, hash);

  console.log(`[bootstrap] Admin account created: ${email}`);
  console.log(`[bootstrap] If you didn't set ADMIN_PASSWORD in .env, change the default password immediately.`);
}

ensureBootstrapAdmin();

module.exports = db;
