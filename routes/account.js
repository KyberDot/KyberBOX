const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();

router.get('/account', (req, res) => {
  res.render('account', { passwordError: null, passwordSuccess: false, emailError: null, emailSuccess: false });
});

router.post('/account/password', (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (!bcrypt.compareSync(current_password || '', user.password_hash)) {
    return res.status(400).render('account', { passwordError: 'Current password is incorrect.', passwordSuccess: false, emailError: null, emailSuccess: false });
  }
  if (!new_password || new_password.length < 8) {
    return res.status(400).render('account', { passwordError: 'New password must be at least 8 characters.', passwordSuccess: false, emailError: null, emailSuccess: false });
  }
  if (new_password !== confirm_password) {
    return res.status(400).render('account', { passwordError: 'New passwords do not match.', passwordSuccess: false, emailError: null, emailSuccess: false });
  }

  const hash = bcrypt.hashSync(new_password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);

  res.render('account', { passwordError: null, passwordSuccess: true, emailError: null, emailSuccess: false });
});

router.post('/account/email', (req, res) => {
  const newEmail = String(req.body.new_email || '').toLowerCase().trim();
  const currentPassword = req.body.current_password || '';
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(400).render('account', { passwordError: null, passwordSuccess: false, emailError: 'Current password is incorrect.', emailSuccess: false });
  }
  if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return res.status(400).render('account', { passwordError: null, passwordSuccess: false, emailError: 'Please enter a valid email address.', emailSuccess: false });
  }

  try {
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(newEmail, user.id);
    res.render('account', { passwordError: null, passwordSuccess: false, emailError: null, emailSuccess: true });
  } catch (err) {
    const message = err.message.includes('UNIQUE') ? 'That email address is already in use.' : 'Could not update email.';
    res.status(400).render('account', { passwordError: null, passwordSuccess: false, emailError: message, emailSuccess: false });
  }
});

module.exports = router;
