const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { getAllSettings, getSiteBaseUrl } = require('../utils/settings');
const { sendMail } = require('../utils/mailer');

const router = express.Router();
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts. Please try again in a few minutes.',
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many password reset requests. Please try again later.',
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/dashboard');
  res.render('login', { error: null });
});

router.post('/login', loginLimiter, (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const password = String(req.body.password || '');

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const genericError = 'Invalid email or password.';

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render('login', { error: genericError });
  }

  const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.cookie('kb_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: 12 * 60 * 60 * 1000,
  });

  if (user.must_change_password) return res.redirect('/change-password');
  res.redirect(user.role === 'admin' ? '/admin' : '/dashboard');
});

router.get('/change-password', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.render('change-password', { error: null });
});

router.post('/change-password', (req, res) => {
  if (!req.user) return res.redirect('/login');
  const { current_password, new_password, confirm_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (!bcrypt.compareSync(current_password || '', user.password_hash)) {
    return res.status(400).render('change-password', { error: 'Current password is incorrect.' });
  }
  if (!new_password || new_password.length < 8) {
    return res.status(400).render('change-password', { error: 'New password must be at least 8 characters.' });
  }
  if (new_password !== confirm_password) {
    return res.status(400).render('change-password', { error: 'New passwords do not match.' });
  }

  const hash = bcrypt.hashSync(new_password, 12);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, user.id);
  res.redirect(user.role === 'admin' ? '/admin' : '/dashboard');
});

// ---------- Forgot / reset password ----------

router.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { sent: false, error: null });
});

router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  // Always show the same message, whether or not the account exists,
  // so this endpoint can't be used to discover valid emails.
  const genericResponse = () => res.render('forgot-password', { sent: true, error: null });

  if (!user) return genericResponse();

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();

  db.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(
    user.id,
    tokenHash,
    expiresAt
  );

  const resetUrl = `${getSiteBaseUrl(req)}/reset-password/${rawToken}`;
  await sendMail({
    to: user.email,
    subject: 'Reset your password',
    bodyHtml: `
      <p>Hi ${user.name},</p>
      <p>We received a request to reset your password. This link expires in 30 minutes and can only be used once.</p>
      <p><a href="${resetUrl}" style="display:inline-block;background:#0ea5e9;color:#0b0f1a;font-weight:700;padding:12px 20px;border-radius:10px;text-decoration:none;">Reset Password</a></p>
      <p style="color:#94a3b8;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
    `,
  });

  genericResponse();
});

router.get('/reset-password/:token', (req, res) => {
  const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
  const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ?').get(tokenHash);

  if (!row || row.used || new Date(row.expires_at + 'Z').getTime() < Date.now()) {
    return res.render('reset-password', { valid: false, token: req.params.token, error: null });
  }
  res.render('reset-password', { valid: true, token: req.params.token, error: null });
});

router.post('/reset-password/:token', (req, res) => {
  const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
  const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ?').get(tokenHash);

  if (!row || row.used || new Date(row.expires_at + 'Z').getTime() < Date.now()) {
    return res.render('reset-password', { valid: false, token: req.params.token, error: 'This reset link is invalid or has expired.' });
  }

  const { new_password, confirm_password } = req.body;
  if (!new_password || new_password.length < 8) {
    return res.status(400).render('reset-password', { valid: true, token: req.params.token, error: 'Password must be at least 8 characters.' });
  }
  if (new_password !== confirm_password) {
    return res.status(400).render('reset-password', { valid: true, token: req.params.token, error: 'Passwords do not match.' });
  }

  const hash = bcrypt.hashSync(new_password, 12);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, row.user_id);
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(row.id);
  // Invalidate any other outstanding reset tokens for this user
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?').run(row.user_id);

  res.render('reset-password', { valid: false, token: null, error: null, success: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie('kb_session');
  res.redirect('/login');
});

module.exports = router;
