const db = require('../db');
const crypto = require('crypto');
const { encrypt, decrypt } = require('./crypto');

const SECRET_KEYS = new Set(['smtp_pass', 'tautulli_api_key', 'plex_token', 'wizarr_api_key']);

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
    plex_token: getSetting('plex_token', ''), // decrypted value, for internal use only
    plex_server_url: getSetting('plex_server_url', ''),
    plex_machine_identifier: getSetting('plex_machine_identifier', ''),
    plex_client_identifier: getOrCreateClientIdentifier(),
    wizarr_url: getSetting('wizarr_url', ''),
    wizarr_api_key: getSetting('wizarr_api_key', ''), // decrypted value, for internal use only
  };
}

// A stable identifier for "this app" as a Plex API client - Plex's sharing
// endpoints require one, but don't care what it actually is beyond being
// consistent. Generated once and reused forever after.
function getOrCreateClientIdentifier() {
  let id = getSetting('plex_client_identifier', '');
  if (!id) {
    id = crypto.randomUUID();
    setSetting('plex_client_identifier', id);
  }
  return id;
}

module.exports = { getSetting, setSetting, getAllSettings, getSiteBaseUrl };
