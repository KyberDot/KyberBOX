const db = require('../db');
const { encrypt, decrypt } = require('./crypto');

const SECRET_KEYS = new Set(['smtp_pass', 'tautulli_api_key']);

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row || row.value === null || row.value === undefined) return fallback;
  if (SECRET_KEYS.has(key)) {
    try {
      return decrypt(row.value);
    } catch (_) {
      return fallback;
    }
  }
  return row.value;
}

function setSetting(key, value) {
  const stored = SECRET_KEYS.has(key) && value ? encrypt(value) : value;
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, stored);
}

function getSiteBaseUrl(req) {
  const configured = getSetting('site_url', '');
  if (configured) return configured.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function getAllSettings() {
  return {
    site_name: getSetting('site_name', process.env.SITE_NAME || 'KyberBOX'),
    site_url: getSetting('site_url', ''),
    smtp_host: getSetting('smtp_host', ''),
    smtp_port: getSetting('smtp_port', '587'),
    smtp_secure: getSetting('smtp_secure', '0'),
    smtp_user: getSetting('smtp_user', ''),
    smtp_pass: getSetting('smtp_pass', ''), // decrypted value, for internal use only
    smtp_from_name: getSetting('smtp_from_name', 'KyberBOX'),
    smtp_from_email: getSetting('smtp_from_email', ''),
    compose_path: getSetting('compose_path', ''),
    tautulli_url: getSetting('tautulli_url', ''),
    tautulli_api_key: getSetting('tautulli_api_key', ''), // decrypted value, for internal use only
    provider_expiry_notifications_enabled: getSetting('provider_expiry_notifications_enabled', '1'),
    container_watchdog_enabled: getSetting('container_watchdog_enabled', '0'),
    container_watchdog_mode: getSetting('container_watchdog_mode', 'all'), // all | selected
    vpn_watchdog_enabled: getSetting('vpn_watchdog_enabled', '1'),
    library_data_order: getSetting('library_data_order', '[]'),
  };
}

module.exports = { getSetting, setSetting, getAllSettings, getSiteBaseUrl };
