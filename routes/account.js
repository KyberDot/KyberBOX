const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { getResetState } = require('../utils/resetLock');
const { encrypt, decrypt } = require('../utils/crypto');
const { newSecret, buildQrDataUrl, verifyCode, generateRecoveryCodes } = require('../utils/totp');
const { getAllSettings } = require('../utils/settings');

const router = express.Router();

// Every /account render needs the same base set of flags - previously
// each route repeated all of them by hand, which is exactly the kind of
// thing that quietly drifts out of sync as fields get added. Routes only
// need to specify what's actually different for their case.
function accountViewData(user, overrides = {}) {
  return {
    nameError: null,
    nameSuccess: false,
    passwordError: null,
    passwordSuccess: false,
    emailError: null,
    emailSuccess: false,
    twoFactorError: null,
    twoFactorQr: null,
    twoFactorManualKey: null,
    recoveryCodes: null,
    totpEnabled: !!user.totp_enabled,
    ...overrides,
  };
}

// Polled by the site-wide banner (see partials/nav.ejs) on every logged-in
// page, admin or subscriber - lets anyone see at a glance that a reset
// (admin Full Reset, or any user's danger-style action) is in progress
// anywhere in the app.
router.get('/system/reset-status', (req, res) => {
  const state = getResetState();
  if (!state.active) return res.json(state);

  const source = (req.user && req.user.role === 'admin') ? state.source : (state.subscriberSource || state.source);
  res.json({ ...state, source });
});

router.get('/account', async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  // If a setup was started but never confirmed (e.g. the page was
  // refreshed mid-flow), show the same QR code again rather than losing
  // it and forcing them to restart setup from scratch.
  if (!user.totp_enabled && user.totp_pending_secret_encrypted) {
    const secret = decrypt(user.totp_pending_secret_encrypted);
    const qr = await buildQrDataUrl(secret, user.email, getAllSettings().site_name);
    return res.render('account', accountViewData(user, { twoFactorQr: qr, twoFactorManualKey: secret }));
  }

  res.render('account', accountViewData(user));
});

router.post('/account/name', (req, res) => {
  const newName = String(req.body.new_name || '').trim();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (!newName) {
    return res.status(400).render('account', accountViewData(user, { nameError: 'Please enter a name.' }));
  }

  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(newName, req.user.id);
  req.user.name = newName; // keeps this response's nav bar (which shows currentUser.name) in sync immediately, rather than showing the old name until the next page load
  res.render('account', accountViewData(user, { nameSuccess: true }));
});

router.post('/account/password', (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (!bcrypt.compareSync(current_password || '', user.password_hash)) {
    return res.status(400).render('account', accountViewData(user, { passwordError: 'Current password is incorrect.' }));
  }
  if (!new_password || new_password.length < 8) {
    return res.status(400).render('account', accountViewData(user, { passwordError: 'New password must be at least 8 characters.' }));
  }
  if (new_password !== confirm_password) {
    return res.status(400).render('account', accountViewData(user, { passwordError: 'New passwords do not match.' }));
  }

  const hash = bcrypt.hashSync(new_password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);

  res.render('account', accountViewData(user, { passwordSuccess: true }));
});

router.post('/account/email', (req, res) => {
  const newEmail = String(req.body.new_email || '').toLowerCase().trim();
  const currentPassword = req.body.current_password || '';
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(400).render('account', accountViewData(user, { emailError: 'Current password is incorrect.' }));
  }
  if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return res.status(400).render('account', accountViewData(user, { emailError: 'Please enter a valid email address.' }));
  }

  try {
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(newEmail, user.id);
    res.render('account', accountViewData(user, { emailSuccess: true }));
  } catch (err) {
    const message = err.message.includes('UNIQUE') ? 'That email address is already in use.' : 'Could not update email.';
    res.status(400).render('account', accountViewData(user, { emailError: message }));
  }
});

// ---------- Two-Factor Authentication (optional, user-controlled) ----------

router.post('/account/2fa/setup', async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.totp_enabled) return res.redirect('/account'); // already on - nothing to set up

  const secret = newSecret();
  db.prepare('UPDATE users SET totp_pending_secret_encrypted = ? WHERE id = ?').run(encrypt(secret), user.id);

  const qr = await buildQrDataUrl(secret, user.email, getAllSettings().site_name);
  res.render('account', accountViewData(user, { twoFactorQr: qr, twoFactorManualKey: secret }));
});

router.post('/account/2fa/confirm', async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (!user.totp_pending_secret_encrypted) {
    return res.status(400).render('account', accountViewData(user, { twoFactorError: 'Start setup again before confirming.' }));
  }

  const secret = decrypt(user.totp_pending_secret_encrypted);
  const result = await verifyCode(secret, req.body.code, null);

  if (!result.valid) {
    const qr = await buildQrDataUrl(secret, user.email, getAllSettings().site_name);
    return res.status(400).render('account', accountViewData(user, {
      twoFactorError: 'Incorrect code. Please try again.',
      twoFactorQr: qr,
      twoFactorManualKey: secret,
    }));
  }

  const recoveryCodes = generateRecoveryCodes(8);
  const hashedCodes = recoveryCodes.map((c) => bcrypt.hashSync(c, 10));

  db.prepare(
    `UPDATE users SET totp_enabled = 1, totp_secret_encrypted = ?, totp_pending_secret_encrypted = NULL,
     totp_recovery_codes = ?, totp_last_time_step = ? WHERE id = ?`
  ).run(encrypt(secret), JSON.stringify(hashedCodes), result.timeStep, user.id);

  res.render('account', accountViewData({ ...user, totp_enabled: 1 }, { recoveryCodes }));
});

router.post('/account/2fa/disable', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (!bcrypt.compareSync(req.body.current_password || '', user.password_hash)) {
    return res.status(400).render('account', accountViewData(user, { twoFactorError: 'Current password is incorrect.' }));
  }

  db.prepare(
    `UPDATE users SET totp_enabled = 0, totp_secret_encrypted = NULL, totp_pending_secret_encrypted = NULL,
     totp_recovery_codes = NULL, totp_last_time_step = NULL WHERE id = ?`
  ).run(user.id);

  res.render('account', accountViewData({ ...user, totp_enabled: 0 }));
});

module.exports = router;
