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

-- Which admin pages/sections a "limited" admin (see users.admin_access_mode)
-- is allowed into. Irrelevant for 'full' access admins, who bypass this
-- check entirely - this table only ever restricts, never grants beyond
-- what a full admin already has.
CREATE TABLE IF NOT EXISTS admin_page_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_key TEXT NOT NULL,
  UNIQUE(user_id, page_key)
);

-- Tracks the stuck-mount watchdog: which container's startup logs are
-- being monitored (see settings key stuck_watch_container_name), how many
-- consecutive checks in a row have found it stuck on the same step, and
-- when a reset was last auto-triggered because of it. Single row (id=1)
-- since only one container can be watched at a time.
-- Deprecated as of multi-container watching - superseded by
-- stuck_watch_containers below. Kept only so an existing single-container
-- setup can be migrated forward (see the migration block further down)
-- rather than silently losing it on upgrade.
CREATE TABLE IF NOT EXISTS stuck_watch_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  consecutive_stuck_checks INTEGER NOT NULL DEFAULT 0,
  last_signature TEXT,
  last_status TEXT NOT NULL DEFAULT 'unknown',
  last_checked_at TEXT,
  last_reset_triggered_at TEXT
);
INSERT OR IGNORE INTO stuck_watch_state (id) VALUES (1);

-- One row per container being watched for the "stuck waiting on
-- mounts/backends" pattern (see utils/stuckWatch.js). success_marker is
-- the exact line the container's script prints once it's actually
-- healthy and past the waiting loop - different per service (e.g. Plex's
-- script prints "Starting Plex Media Server", Jellyfin's prints "Starting
-- Jellyfin Media Server"), so each watch tracks its own.
CREATE TABLE IF NOT EXISTS stuck_watch_containers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  container_name TEXT NOT NULL UNIQUE,
  service_label TEXT NOT NULL,
  success_marker TEXT NOT NULL,
  consecutive_stuck_checks INTEGER NOT NULL DEFAULT 0,
  last_signature TEXT,
  last_status TEXT NOT NULL DEFAULT 'unknown',
  last_checked_at TEXT,
  last_reset_triggered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per container being watched for the VPN-guard pattern (see
-- utils/vpnWatch.js): scripts that refuse to start their real service
-- until a VPN tunnel is confirmed up, printing one of two fixed lines
-- either way. Unlike stuck_watch_containers, this is a one-shot
-- pass/fail determination each check, not a multi-check "same step
-- repeating" pattern - the markers are identical across every VPN-guard
-- script variant seen so far, so they're hardcoded rather than
-- per-container configurable.
CREATE TABLE IF NOT EXISTS vpn_watch_containers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  container_name TEXT NOT NULL UNIQUE,
  service_label TEXT NOT NULL,
  last_status TEXT NOT NULL DEFAULT 'unknown', -- unknown | connected | failed
  last_checked_at TEXT,
  last_alert_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- S3-compatible object storage connections (Hetzner Object Storage, AWS
-- S3, Backblaze B2, DigitalOcean Spaces, Cloudflare R2, MinIO, etc. -
-- anything speaking the standard S3 API) that admins can browse and
-- manage files within. Credentials encrypted the same way as SSH/SMTP
-- secrets elsewhere in this app (see utils/crypto.js).
CREATE TABLE IF NOT EXISTS storage_buckets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'auto',
  bucket_name TEXT NOT NULL,
  access_key_encrypted TEXT NOT NULL,
  secret_key_encrypted TEXT NOT NULL,
  force_path_style INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- SFTP-based storage connections (Hetzner Storage Box and similar plain
-- SFTP/SSH-only storage that doesn't speak S3). Separate table from
-- storage_buckets since the connection fields and file operations are
-- genuinely different (host/port/username/password-or-key vs
-- endpoint/region/access-key/secret-key), even though both show up
-- together on the same Storage page.
CREATE TABLE IF NOT EXISTS sftp_storage_boxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'password', -- password | key
  secret_encrypted TEXT NOT NULL, -- password or private key, depending on auth_type
  root_path TEXT NOT NULL DEFAULT '/',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Custom admin-defined actions per health container (e.g. "Reset World
-- Seed" running a specific docker exec command) - separate from
-- plan_actions, which are subscriber-facing actions tied to a plan rather
-- than admin-facing actions tied to a specific container.
CREATE TABLE IF NOT EXISTS admin_container_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  container_id INTEGER NOT NULL REFERENCES admin_health_containers(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'fa-bolt',
  command TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
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
  style TEXT NOT NULL DEFAULT 'warning', -- warning (amber) | danger (red, for slow/destructive actions)
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
ensureColumn('plans', 'pricing_mode', "pricing_mode TEXT NOT NULL DEFAULT 'paid'"); // paid | free | included_with
ensureColumn('plans', 'included_with_plan_id', 'included_with_plan_id INTEGER REFERENCES plans(id)'); // deprecated, superseded by included_with_plan_ids below
ensureColumn('plans', 'included_with_plan_ids', 'included_with_plan_ids TEXT'); // comma-separated plan ids - having an active sub to ANY of these auto-grants this plan
ensureColumn('plans', 'server_connection_info', 'server_connection_info TEXT'); // e.g. a Minecraft server address, shown to subscribers
ensureColumn('subscriptions', 'auto_granted_via_plan_id', 'auto_granted_via_plan_id INTEGER REFERENCES plans(id)'); // set when this subscription was auto-added because of another plan's inclusion, not manually assigned - lets it be safely auto-removed later
ensureColumn('users', 'payment_method_id', 'payment_method_id INTEGER REFERENCES payment_methods(id)');
ensureColumn('users', 'plex_username', 'plex_username TEXT');
ensureColumn('users', 'plex_user_id', 'plex_user_id TEXT'); // Plex.tv account id, matched by email - used for Tautulli watch history/now-watching only
ensureColumn('plan_containers', 'link_url', 'link_url TEXT');
ensureColumn('vpn_watch_containers', 'last_container_start_at', 'last_container_start_at TEXT');
ensureColumn('stuck_watch_containers', 'last_container_start_at', 'last_container_start_at TEXT');
ensureColumn('storage_buckets', 'total_capacity_bytes', 'total_capacity_bytes INTEGER');
ensureColumn('sftp_storage_boxes', 'total_capacity_bytes', 'total_capacity_bytes INTEGER');
ensureColumn('storage_buckets', 'color', "color TEXT NOT NULL DEFAULT 'sky'");
ensureColumn('sftp_storage_boxes', 'color', "color TEXT NOT NULL DEFAULT 'amber'");
ensureColumn('users', 'plex_link_attempted_at', 'plex_link_attempted_at TEXT');
ensureColumn('users', 'admin_access_mode', "admin_access_mode TEXT NOT NULL DEFAULT 'full'"); // full | limited - only meaningful when role = 'admin'; limited admins are gated per-page via admin_page_access

// Backfill: rows inserted before per-action ordering was tracked all share
// sort_order=0 within their group. Swapping two equal values during a
// reorder is a no-op, so without this, "move up/down" would silently do
// nothing for any action that existed before this fix - only ever working
// for brand new ones. Assigns sequential values based on current id order
// (i.e. creation order) within each affected group. Runs on every boot but
// is a no-op after the first, since HAVING only matches groups that still
// have duplicate sort_order values.
function backfillActionOrder(table, groupColumn) {
  const groups = db
    .prepare(`SELECT ${groupColumn} AS g FROM ${table} GROUP BY ${groupColumn} HAVING COUNT(*) > COUNT(DISTINCT sort_order)`)
    .all();
  const update = db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`);
  groups.forEach(({ g }) => {
    const rows = db.prepare(`SELECT id FROM ${table} WHERE ${groupColumn} = ? ORDER BY id ASC`).all(g);
    rows.forEach((row, i) => update.run(i, row.id));
  });
}
backfillActionOrder('plan_actions', 'plan_id');
backfillActionOrder('admin_container_actions', 'container_id');
backfillActionOrder('plan_containers', 'plan_id');

// One-time migration: the stuck-mount watchdog used to support only a
// single hardcoded-to-Plex container (settings key
// stuck_watch_container_name + the single-row stuck_watch_state table).
// If that old setup has a value and hasn't been migrated yet, carry it
// forward into the new multi-container table - including its
// accumulated state, so an in-progress stuck streak isn't silently reset
// to zero on upgrade. Runs on every boot but is a no-op after the first,
// since it only acts when the old setting still has a value.
(function migrateStuckWatchToMultiContainer() {
  const oldContainerName = db.prepare("SELECT value FROM settings WHERE key = 'stuck_watch_container_name'").get()?.value;
  if (!oldContainerName) return;

  const alreadyMigrated = db.prepare('SELECT 1 FROM stuck_watch_containers WHERE container_name = ?').get(oldContainerName);
  if (!alreadyMigrated) {
    const oldState = db.prepare('SELECT * FROM stuck_watch_state WHERE id = 1').get();
    db.prepare(
      `INSERT INTO stuck_watch_containers
         (container_name, service_label, success_marker, consecutive_stuck_checks, last_signature, last_status, last_checked_at, last_reset_triggered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      oldContainerName,
      'Plex', // the old single-container watcher was always hardcoded to Plex's marker specifically
      'Starting Plex Media Server',
      oldState?.consecutive_stuck_checks || 0,
      oldState?.last_signature || null,
      oldState?.last_status || 'unknown',
      oldState?.last_checked_at || null,
      oldState?.last_reset_triggered_at || null
    );
  }

  // Clear the old setting so it's unambiguous going forward that
  // stuck_watch_containers is the single source of truth.
  db.prepare("DELETE FROM settings WHERE key = 'stuck_watch_container_name'").run();
})();

ensureColumn('subscriptions', 'renewal_mode', "renewal_mode TEXT NOT NULL DEFAULT 'manual'"); // auto | manual | expired
ensureColumn('subscriptions', 'expiry_warning_sent_at', 'expiry_warning_sent_at TEXT');
ensureColumn('tickets', 'plan_id', 'plan_id INTEGER REFERENCES plans(id)'); // set for plan-specific tickets, e.g. a Minecraft world seed reset request
ensureColumn('admin_health_containers', 'logo_path', 'logo_path TEXT');
ensureColumn('admin_health_containers', 'link_url', 'link_url TEXT');
ensureColumn('admin_health_containers', 'logo_bg', "logo_bg TEXT NOT NULL DEFAULT 'default'"); // default | white | none
ensureColumn('plan_actions', 'style', "style TEXT NOT NULL DEFAULT 'warning'"); // warning | danger

db.exec(`
CREATE TABLE IF NOT EXISTS ssh_console_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0,
  output TEXT,
  requested_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

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
