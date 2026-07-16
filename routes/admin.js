const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { encrypt } = require('../utils/crypto');
const { getAllSettings, setSetting, getSiteBaseUrl } = require('../utils/settings');
const { sendMail, isConfigured } = require('../utils/mailer');

const router = express.Router();

function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
}

function loadUsersPageData() {
  const users = db.prepare("SELECT * FROM users WHERE role = 'subscriber' ORDER BY created_at DESC").all();

  const subsByUser = {};
  db.prepare('SELECT * FROM subscriptions').all().forEach((s) => {
    (subsByUser[s.user_id] = subsByUser[s.user_id] || []).push(s);
  });

  const sshByUser = {};
  db.prepare('SELECT user_id, host, port, username, auth_type, restart_command FROM ssh_targets')
    .all()
    .forEach((t) => { sshByUser[t.user_id] = t; });

  return { users, subsByUser, sshByUser };
}

router.get('/admin', (req, res) => {
  const userCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'subscriber'").get().c;
  const openTickets = db.prepare("SELECT COUNT(*) c FROM tickets WHERE status != 'closed'").get().c;
  const activeSubs = db.prepare("SELECT COUNT(*) c FROM subscriptions WHERE status = 'active'").get().c;
  const recentRestarts = db
    .prepare(
      `SELECT r.*, u.name, u.email FROM restart_log r JOIN users u ON u.id = r.user_id
       ORDER BY r.requested_at DESC LIMIT 8`
    )
    .all();
  const mailConfigured = isConfigured(getAllSettings());

  res.render('admin-overview', { userCount, openTickets, activeSubs, recentRestarts, mailConfigured });
});

// ---------- Users ----------

router.get('/admin/users', (req, res) => {
  res.render('admin-users', { ...loadUsersPageData(), newUser: null });
});

router.post('/admin/users/invite', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').toLowerCase().trim();
  const service = String(req.body.service || 'docker').trim();
  const planName = String(req.body.plan_name || 'Standard').trim();

  if (!name || !email) return res.status(400).redirect('/admin/users');

  const tempPassword = generateTempPassword();
  const hash = bcrypt.hashSync(tempPassword, 12);

  try {
    const info = db
      .prepare(
        `INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES (?, ?, ?, 'subscriber', 1)`
      )
      .run(name, email, hash);

    db.prepare(
      `INSERT INTO subscriptions (user_id, service, plan_name, status) VALUES (?, ?, ?, 'active')`
    ).run(info.lastInsertRowid, service, planName);

    const siteName = getAllSettings().site_name;
    const loginUrl = `${getSiteBaseUrl(req)}/login`;
    const emailResult = await sendMail({
      to: email,
      subject: `Your ${siteName} account is ready`,
      bodyHtml: `
        <p>Hi ${name},</p>
        <p>An account has been created for you on ${siteName}. Here are your sign-in details:</p>
        <p style="background:#0b1220;border-radius:10px;padding:16px;">
          <strong>Email:</strong> ${email}<br>
          <strong>Temporary password:</strong> ${tempPassword}
        </p>
        <p>You'll be asked to set your own password the first time you sign in.</p>
        <p><a href="${loginUrl}" style="display:inline-block;background:#0ea5e9;color:#0b0f1a;font-weight:700;padding:12px 20px;border-radius:10px;text-decoration:none;">Sign In</a></p>
      `,
    });

    return res.render('admin-users', {
      ...loadUsersPageData(),
      newUser: { name, email, tempPassword, emailSent: emailResult.sent, emailReason: emailResult.reason },
    });
  } catch (err) {
    return res.status(400).render('error', {
      message: err.message.includes('UNIQUE') ? 'A user with that email already exists.' : 'Could not create user.',
    });
  }
});

router.post('/admin/users/:id/subscription', (req, res) => {
  const { service, plan_name, status, expires_at, notes } = req.body;
  const existing = db.prepare('SELECT id FROM subscriptions WHERE user_id = ? AND service = ?').get(req.params.id, service);

  if (existing) {
    db.prepare(
      `UPDATE subscriptions SET plan_name = ?, status = ?, expires_at = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(plan_name, status, expires_at || null, notes || null, existing.id);
  } else {
    db.prepare(
      `INSERT INTO subscriptions (user_id, service, plan_name, status, expires_at, notes) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(req.params.id, service, plan_name, status, expires_at || null, notes || null);
  }

  res.redirect('/admin/users');
});

router.post('/admin/users/:id/subscription/:subId/delete', (req, res) => {
  db.prepare('DELETE FROM subscriptions WHERE id = ? AND user_id = ?').run(req.params.subId, req.params.id);
  res.redirect('/admin/users');
});

router.post('/admin/users/:id/ssh', (req, res) => {
  const { host, port, username, auth_type, secret, restart_command } = req.body;
  if (!host || !username || !secret) return res.status(400).redirect('/admin/users');

  const encryptedSecret = encrypt(secret);
  const existing = db.prepare('SELECT id FROM ssh_targets WHERE user_id = ?').get(req.params.id);

  if (existing) {
    db.prepare(
      `UPDATE ssh_targets SET host = ?, port = ?, username = ?, auth_type = ?, secret_encrypted = ?, restart_command = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(host, port || 22, username, auth_type || 'password', encryptedSecret, restart_command || 'docker compose restart plex', existing.id);
  } else {
    db.prepare(
      `INSERT INTO ssh_targets (user_id, host, port, username, auth_type, secret_encrypted, restart_command) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(req.params.id, host, port || 22, username, auth_type || 'password', encryptedSecret, restart_command || 'docker compose restart plex');
  }

  res.redirect('/admin/users');
});

router.post('/admin/users/:id/reset-password', async (req, res) => {
  const tempPassword = generateTempPassword();
  const hash = bcrypt.hashSync(tempPassword, 12);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, req.params.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  const siteName = getAllSettings().site_name;
  const loginUrl = `${getSiteBaseUrl(req)}/login`;

  const emailResult = await sendMail({
    to: user.email,
    subject: `Your ${siteName} password has been reset`,
    bodyHtml: `
      <p>Hi ${user.name},</p>
      <p>An admin has reset your password. Here's your new temporary password:</p>
      <p style="background:#0b1220;border-radius:10px;padding:16px;"><strong>${tempPassword}</strong></p>
      <p>You'll be asked to set your own password the next time you sign in.</p>
      <p><a href="${loginUrl}" style="display:inline-block;background:#0ea5e9;color:#0b0f1a;font-weight:700;padding:12px 20px;border-radius:10px;text-decoration:none;">Sign In</a></p>
    `,
  });

  res.render('admin-users', {
    ...loadUsersPageData(),
    newUser: { name: user.name, email: user.email, tempPassword, emailSent: emailResult.sent, emailReason: emailResult.reason },
  });
});

router.post('/admin/users/:id/delete', (req, res) => {
  db.prepare("DELETE FROM users WHERE id = ? AND role = 'subscriber'").run(req.params.id);
  res.redirect('/admin/users');
});

// ---------- Tickets ----------

router.get('/admin/tickets', (req, res) => {
  const tickets = db
    .prepare(
      `SELECT t.*, u.name AS user_name, u.email AS user_email FROM tickets t
       JOIN users u ON u.id = t.user_id ORDER BY
       CASE t.status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END, t.updated_at DESC`
    )
    .all();
  res.render('admin-tickets', { tickets });
});

router.get('/admin/tickets/:id', (req, res) => {
  const ticket = db
    .prepare(
      `SELECT t.*, u.name AS user_name, u.email AS user_email FROM tickets t
       JOIN users u ON u.id = t.user_id WHERE t.id = ?`
    )
    .get(req.params.id);
  if (!ticket) return res.status(404).render('error', { message: 'Ticket not found.' });

  const messages = db
    .prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC')
    .all(ticket.id);

  res.render('ticket-thread', {
    ticket,
    messages,
    backUrl: '/admin/tickets',
    canReply: true,
    replyAction: `/admin/tickets/${ticket.id}/reply`,
    isAdminView: true,
  });
});

router.post('/admin/tickets/:id/reply', async (req, res) => {
  const ticket = db
    .prepare(`SELECT t.*, u.email AS user_email, u.name AS user_name FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?`)
    .get(req.params.id);
  if (!ticket) return res.status(404).render('error', { message: 'Ticket not found.' });

  const message = String(req.body.message || '').trim();
  const newStatus = String(req.body.status || 'answered');

  if (message) {
    db.prepare(
      'INSERT INTO ticket_messages (ticket_id, sender_role, sender_name, message) VALUES (?, ?, ?, ?)'
    ).run(ticket.id, 'admin', req.user.name, message);
  }
  db.prepare("UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, ticket.id);

  if (message) {
    const siteName = getAllSettings().site_name;
    const ticketUrl = `${getSiteBaseUrl(req)}/dashboard/tickets/${ticket.id}`;
    await sendMail({
      to: ticket.user_email,
      subject: `Re: ${ticket.subject}`,
      bodyHtml: `
        <p>Hi ${ticket.user_name},</p>
        <p>Support replied to your ticket "<strong>${ticket.subject}</strong>":</p>
        <p style="background:#0b1220;border-radius:10px;padding:16px;white-space:pre-wrap;">${message}</p>
        <p><a href="${ticketUrl}" style="display:inline-block;background:#0ea5e9;color:#0b0f1a;font-weight:700;padding:12px 20px;border-radius:10px;text-decoration:none;">View Ticket</a></p>
      `,
    });
  }

  res.redirect(`/admin/tickets/${ticket.id}`);
});

// ---------- Settings ----------

router.get('/admin/settings', (req, res) => {
  const settings = getAllSettings();
  res.render('admin-settings', { settings, saved: null, testResult: null });
});

router.post('/admin/settings/general', (req, res) => {
  setSetting('site_name', String(req.body.site_name || 'KyberBOX').trim());
  setSetting('site_url', String(req.body.site_url || '').trim());
  res.render('admin-settings', { settings: getAllSettings(), saved: 'general', testResult: null });
});

router.post('/admin/settings/mail', (req, res) => {
  const { smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from_name, smtp_from_email } = req.body;

  setSetting('smtp_host', String(smtp_host || '').trim());
  setSetting('smtp_port', String(smtp_port || '587').trim());
  setSetting('smtp_secure', smtp_secure ? '1' : '0');
  setSetting('smtp_user', String(smtp_user || '').trim());
  setSetting('smtp_from_name', String(smtp_from_name || 'KyberBOX').trim());
  setSetting('smtp_from_email', String(smtp_from_email || '').trim());

  // Only overwrite the stored password if a new one was actually typed in -
  // the settings form always shows this field blank for security.
  if (smtp_pass) setSetting('smtp_pass', smtp_pass);

  res.render('admin-settings', { settings: getAllSettings(), saved: 'mail', testResult: null });
});

router.post('/admin/settings/test-email', async (req, res) => {
  const result = await sendMail({
    to: req.user.email,
    subject: 'Test email from your portal',
    bodyHtml: `<p>If you're reading this, your SMTP settings are working correctly.</p>`,
  });
  res.render('admin-settings', { settings: getAllSettings(), saved: null, testResult: result });
});

module.exports = router;
