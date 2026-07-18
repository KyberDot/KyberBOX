const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { encrypt } = require('../utils/crypto');
const { getAllSettings, setSetting, getSiteBaseUrl } = require('../utils/settings');
const { sendMail, isConfigured } = require('../utils/mailer');
const { londonInputToUtcIso, formatUK } = require('../utils/time');
const { serviceLabel } = require('../utils/labels');
const { runCommand, getContainerStatuses } = require('../utils/ssh');
const { upload } = require('../utils/uploads');

const router = express.Router();
const brandingUpload = upload.fields([{ name: 'favicon', maxCount: 1 }, { name: 'apple_icon', maxCount: 1 }]);
const containerLogoUpload = upload.single('logo');

function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
}

function loadPlans() {
  const plans = db.prepare('SELECT * FROM plans ORDER BY created_at ASC').all();

  const sshByPlan = {};
  db.prepare('SELECT plan_id, host, port, username, auth_type FROM plan_ssh').all().forEach((s) => {
    sshByPlan[s.plan_id] = s;
  });

  const actionsByPlan = {};
  db.prepare('SELECT * FROM plan_actions ORDER BY sort_order ASC, id ASC').all().forEach((a) => {
    (actionsByPlan[a.plan_id] = actionsByPlan[a.plan_id] || []).push(a);
  });

  const containersByPlan = {};
  db.prepare('SELECT * FROM plan_containers ORDER BY sort_order ASC, id ASC').all().forEach((c) => {
    (containersByPlan[c.plan_id] = containersByPlan[c.plan_id] || []).push(c);
  });

  return { plans, sshByPlan, actionsByPlan, containersByPlan };
}

function loadUsersPageData() {
  const users = db.prepare("SELECT * FROM users WHERE role = 'subscriber' ORDER BY created_at DESC").all();

  const subsByUser = {};
  db.prepare(
    `SELECT s.*, p.name AS plan_display_name FROM subscriptions s
     LEFT JOIN plans p ON p.id = s.plan_id`
  ).all().forEach((s) => {
    (subsByUser[s.user_id] = subsByUser[s.user_id] || []).push(s);
  });

  const plans = db.prepare('SELECT * FROM plans ORDER BY name ASC').all();
  const paymentMethods = db.prepare('SELECT * FROM payment_methods ORDER BY name ASC').all();

  return { users, subsByUser, plans, paymentMethods };
}

router.get('/admin', (req, res) => {
  const userCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'subscriber'").get().c;
  const openTickets = db.prepare("SELECT COUNT(*) c FROM tickets WHERE status != 'closed'").get().c;
  const activeSubs = db.prepare("SELECT COUNT(*) c FROM subscriptions WHERE status = 'active'").get().c;
  const planCount = db.prepare('SELECT COUNT(*) c FROM plans').get().c;
  const recentActions = db
    .prepare(
      `SELECT al.*, u.name, u.email, pa.label AS action_label FROM action_log al
       JOIN users u ON u.id = al.user_id
       JOIN plan_actions pa ON pa.id = al.plan_action_id
       ORDER BY al.requested_at DESC LIMIT 8`
    )
    .all();
  const mailConfigured = isConfigured(getAllSettings());

  res.render('admin-overview', { userCount, openTickets, activeSubs, planCount, recentActions, mailConfigured });
});

// ---------- Plans ----------

router.get('/admin/plans', (req, res) => {
  res.render('admin-plans', { ...loadPlans(), newPlanId: null });
});

router.post('/admin/plans', (req, res) => {
  const name = String(req.body.name || '').trim();
  const service = String(req.body.service || 'docker').trim();
  const description = String(req.body.description || '').trim();
  const features = String(req.body.features || '').trim();
  const price = req.body.price ? Number(req.body.price) : null;
  const currency = String(req.body.currency || 'GBP').trim();

  if (!name) return res.status(400).redirect('/admin/plans');

  const info = db
    .prepare('INSERT INTO plans (name, service, description, features, price, currency) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, service, description, features, price, currency);

  res.render('admin-plans', { ...loadPlans(), newPlanId: info.lastInsertRowid });
});

router.post('/admin/plans/:id/update', (req, res) => {
  const name = String(req.body.name || '').trim();
  const service = String(req.body.service || 'docker').trim();
  const description = String(req.body.description || '').trim();
  const features = String(req.body.features || '').trim();
  const price = req.body.price ? Number(req.body.price) : null;
  const currency = String(req.body.currency || 'GBP').trim();

  db.prepare(
    `UPDATE plans SET name = ?, service = ?, description = ?, features = ?, price = ?, currency = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(name, service, description, features, price, currency, req.params.id);

  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/maintenance', async (req, res) => {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).render('error', { message: 'Plan not found.' });

  const enable = req.body.maintenance_mode === 'on' || req.body.maintenance_mode === '1';
  const resumeAt = String(req.body.maintenance_resume_at || '').trim(); // datetime-local, UK time as entered
  const message = String(req.body.maintenance_message || '').trim();

  // <input type="datetime-local"> gives "YYYY-MM-DDTHH:MM" with no timezone.
  // The admin is filling this in while looking at UK time, so interpret it
  // as Europe/London and convert to UTC for storage.
  let resumeAtUtc = null;
  if (enable && resumeAt) {
    resumeAtUtc = londonInputToUtcIso(resumeAt);
  }

  const wasAlreadyOn = !!plan.maintenance_mode;

  db.prepare(
    `UPDATE plans SET maintenance_mode = ?, maintenance_resume_at = ?, maintenance_message = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(enable ? 1 : 0, resumeAtUtc, message || null, req.params.id);

  // Only notify on the OFF -> ON transition, not on every subsequent edit
  // while it's already on (avoids spamming subscribers).
  if (enable && !wasAlreadyOn) {
    const affected = db
      .prepare(
        `SELECT u.email, u.name FROM subscriptions s
         JOIN users u ON u.id = s.user_id
         WHERE s.plan_id = ? AND s.status = 'active'`
      )
      .all(req.params.id);

    const siteName = getAllSettings().site_name;
    const label = serviceLabel(plan.service);
    const resumeLine = resumeAtUtc ? `We expect to resume by <strong>${formatUK(resumeAtUtc)}</strong> (UK time).` : '';

    await Promise.all(
      affected.map((sub) =>
        sendMail({
          to: sub.email,
          subject: `${label} - Scheduled Maintenance`,
          bodyHtml: `
            <p>Hi ${sub.name},</p>
            <p><strong>${label}</strong> is currently undergoing scheduled maintenance on ${siteName}.</p>
            ${message ? `<p>${message}</p>` : ''}
            <p>${resumeLine}</p>
            <p style="color:#94a3b8;font-size:13px;">You may notice temporary interruptions until this is complete. Sorry for any inconvenience.</p>
          `,
        })
      )
    );
  }

  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/delete', (req, res) => {
  db.prepare('DELETE FROM plans WHERE id = ?').run(req.params.id);
  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/ssh', (req, res) => {
  const { host, port, username, auth_type, secret } = req.body;
  if (!host || !username) return res.status(400).redirect('/admin/plans');

  const existing = db.prepare('SELECT * FROM plan_ssh WHERE plan_id = ?').get(req.params.id);

  if (existing) {
    if (secret) {
      db.prepare(
        `UPDATE plan_ssh SET host = ?, port = ?, username = ?, auth_type = ?, secret_encrypted = ?, updated_at = datetime('now') WHERE plan_id = ?`
      ).run(host, port || 22, username, auth_type || 'password', encrypt(secret), req.params.id);
    } else {
      db.prepare(
        `UPDATE plan_ssh SET host = ?, port = ?, username = ?, auth_type = ?, updated_at = datetime('now') WHERE plan_id = ?`
      ).run(host, port || 22, username, auth_type || 'password', req.params.id);
    }
  } else {
    if (!secret) return res.status(400).redirect('/admin/plans');
    db.prepare(
      `INSERT INTO plan_ssh (plan_id, host, port, username, auth_type, secret_encrypted) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(req.params.id, host, port || 22, username, auth_type || 'password', encrypt(secret));
  }

  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/actions', (req, res) => {
  const label = String(req.body.label || '').trim();
  const command = String(req.body.command || '').trim();
  const icon = String(req.body.icon || 'fa-rotate').trim();
  const cooldownHours = Math.max(0, parseInt(req.body.cooldown_hours, 10) || 6);

  if (!label || !command) return res.status(400).redirect('/admin/plans');

  db.prepare(
    'INSERT INTO plan_actions (plan_id, label, command, icon, cooldown_hours) VALUES (?, ?, ?, ?, ?)'
  ).run(req.params.id, label, command, icon, cooldownHours);

  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/actions/:actionId/delete', (req, res) => {
  db.prepare('DELETE FROM plan_actions WHERE id = ? AND plan_id = ?').run(req.params.actionId, req.params.id);
  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/containers', (req, res) => {
  const containerName = String(req.body.container_name || '').trim();
  const label = String(req.body.label || containerName).trim();

  if (!containerName) return res.status(400).redirect('/admin/plans');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName)) {
    return res.status(400).render('error', { message: 'Container name can only contain letters, numbers, dots, dashes, and underscores.' });
  }

  db.prepare('INSERT INTO plan_containers (plan_id, container_name, label) VALUES (?, ?, ?)').run(
    req.params.id,
    containerName,
    label
  );

  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/containers/:containerId/delete', (req, res) => {
  db.prepare('DELETE FROM plan_containers WHERE id = ? AND plan_id = ?').run(req.params.containerId, req.params.id);
  res.redirect('/admin/plans');
});

// ---------- Users ----------

router.get('/admin/users', (req, res) => {
  res.render('admin-users', { ...loadUsersPageData(), newUser: null });
});

router.post('/admin/users/invite', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').toLowerCase().trim();
  const planId = req.body.plan_id ? Number(req.body.plan_id) : null;

  if (!name || !email) return res.status(400).redirect('/admin/users');

  const tempPassword = generateTempPassword();
  const hash = bcrypt.hashSync(tempPassword, 12);

  try {
    const info = db
      .prepare(
        `INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES (?, ?, ?, 'subscriber', 1)`
      )
      .run(name, email, hash);

    if (planId) {
      const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
      if (plan) {
        db.prepare(
          `INSERT INTO subscriptions (user_id, plan_id, service, plan_name, status) VALUES (?, ?, ?, ?, 'active')`
        ).run(info.lastInsertRowid, plan.id, plan.service, plan.name);
      }
    }

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
  const { plan_id, status, expires_at, notes, renewal_mode } = req.body;
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(plan_id);
  if (!plan) return res.status(400).redirect('/admin/users');

  const mode = ['auto', 'manual', 'expired'].includes(renewal_mode) ? renewal_mode : 'manual';
  // Choosing "Mark as Expired" as the renewal mode is a direct instruction
  // to expire the subscription now, regardless of what status was picked.
  const finalStatus = mode === 'expired' ? 'expired' : status;

  const existing = db.prepare('SELECT id FROM subscriptions WHERE user_id = ? AND plan_id = ?').get(req.params.id, plan.id);

  if (existing) {
    db.prepare(
      `UPDATE subscriptions SET service = ?, plan_name = ?, status = ?, renewal_mode = ?, expires_at = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(plan.service, plan.name, finalStatus, mode, expires_at || null, notes || null, existing.id);
  } else {
    db.prepare(
      `INSERT INTO subscriptions (user_id, plan_id, service, plan_name, status, renewal_mode, expires_at, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(req.params.id, plan.id, plan.service, plan.name, finalStatus, mode, expires_at || null, notes || null);
  }

  res.redirect('/admin/users');
});

router.post('/admin/users/:id/subscription/:subId/delete', (req, res) => {
  db.prepare('DELETE FROM subscriptions WHERE id = ? AND user_id = ?').run(req.params.subId, req.params.id);
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

router.post('/admin/users/:id/update', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').toLowerCase().trim();
  if (!name || !email) return res.status(400).redirect('/admin/users');

  try {
    db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name, email, req.params.id);
    res.redirect('/admin/users');
  } catch (err) {
    res.status(400).render('error', {
      message: err.message.includes('UNIQUE') ? 'Another user already has that email address.' : 'Could not update user.',
    });
  }
});

router.post('/admin/users/:id/delete', (req, res) => {
  db.prepare("DELETE FROM users WHERE id = ? AND role = 'subscriber'").run(req.params.id);
  res.redirect('/admin/users');
});

router.post('/admin/users/:id/payment-method', (req, res) => {
  const paymentMethodId = req.body.payment_method_id ? Number(req.body.payment_method_id) : null;
  db.prepare('UPDATE users SET payment_method_id = ? WHERE id = ?').run(paymentMethodId, req.params.id);
  res.redirect('/admin/users');
});

// ---------- Payment Methods ----------

router.post('/admin/payment-methods', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).redirect('/admin/users');
  db.prepare('INSERT INTO payment_methods (name) VALUES (?)').run(name);
  res.redirect('/admin/users');
});

router.post('/admin/payment-methods/:id/delete', (req, res) => {
  db.prepare('DELETE FROM payment_methods WHERE id = ?').run(req.params.id);
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
    const ticketUrl = `${getSiteBaseUrl(req)}/support/tickets/${ticket.id}`;
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
  const healthSsh = db.prepare('SELECT id, host, port, username, auth_type FROM admin_ssh LIMIT 1').get();
  res.render('admin-settings', { settings, healthSsh, saved: null, testResult: null });
});

router.post('/admin/settings/general', (req, res) => {
  setSetting('site_name', String(req.body.site_name || 'KyberBOX').trim());
  setSetting('site_url', String(req.body.site_url || '').trim());
  const healthSsh = db.prepare('SELECT id, host, port, username, auth_type FROM admin_ssh LIMIT 1').get();
  res.render('admin-settings', { settings: getAllSettings(), healthSsh, saved: 'general', testResult: null });
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

  const healthSsh = db.prepare('SELECT id, host, port, username, auth_type FROM admin_ssh LIMIT 1').get();
  res.render('admin-settings', { settings: getAllSettings(), healthSsh, saved: 'mail', testResult: null });
});

router.post('/admin/settings/test-email', async (req, res) => {
  const result = await sendMail({
    to: req.user.email,
    subject: 'Test email from your portal',
    bodyHtml: `<p>If you're reading this, your SMTP settings are working correctly.</p>`,
  });
  const healthSsh = db.prepare('SELECT id, host, port, username, auth_type FROM admin_ssh LIMIT 1').get();
  res.render('admin-settings', { settings: getAllSettings(), healthSsh, saved: null, testResult: result });
});

router.post('/admin/settings/branding', (req, res) => {
  brandingUpload(req, res, (err) => {
    const healthSsh = db.prepare('SELECT id, host, port, username, auth_type FROM admin_ssh LIMIT 1').get();

    if (err) {
      return res.status(400).render('admin-settings', {
        settings: getAllSettings(),
        healthSsh,
        saved: null,
        testResult: null,
        brandingError: err.message,
      });
    }

    if (req.files && req.files.favicon && req.files.favicon[0]) {
      setSetting('favicon_path', `/uploads/${req.files.favicon[0].filename}`);
    }
    if (req.files && req.files.apple_icon && req.files.apple_icon[0]) {
      setSetting('apple_icon_path', `/uploads/${req.files.apple_icon[0].filename}`);
    }

    res.render('admin-settings', { settings: getAllSettings(), healthSsh, saved: 'branding', testResult: null, brandingError: null });
  });
});

router.post('/admin/settings/health-ssh', (req, res) => {
  const { host, port, username, auth_type, secret } = req.body;
  if (!host || !username) return res.status(400).redirect('/admin/settings');

  const existing = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();

  if (existing) {
    if (secret) {
      db.prepare(
        `UPDATE admin_ssh SET host = ?, port = ?, username = ?, auth_type = ?, secret_encrypted = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(host, port || 22, username, auth_type || 'password', encrypt(secret), existing.id);
    } else {
      db.prepare(
        `UPDATE admin_ssh SET host = ?, port = ?, username = ?, auth_type = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(host, port || 22, username, auth_type || 'password', existing.id);
    }
  } else {
    if (!secret) return res.status(400).redirect('/admin/settings');
    db.prepare(
      `INSERT INTO admin_ssh (host, port, username, auth_type, secret_encrypted) VALUES (?, ?, ?, ?, ?)`
    ).run(host, port || 22, username, auth_type || 'password', encrypt(secret));
  }

  const healthSsh = db.prepare('SELECT id, host, port, username, auth_type FROM admin_ssh LIMIT 1').get();
  res.render('admin-settings', { settings: getAllSettings(), healthSsh, saved: 'health-ssh', testResult: null });
});

// ---------- Health (admin-wide container monitor) ----------

router.get('/admin/health', (req, res) => {
  const sshConfigured = !!db.prepare('SELECT id FROM admin_ssh LIMIT 1').get();
  const containers = db.prepare('SELECT * FROM admin_health_containers ORDER BY sort_order ASC, id ASC').all();
  const recentLog = db
    .prepare(
      `SELECT l.*, u.name AS admin_name FROM admin_health_log l
       JOIN users u ON u.id = l.admin_user_id
       ORDER BY l.requested_at DESC LIMIT 10`
    )
    .all();

  res.render('admin-health', { sshConfigured, containers, recentLog });
});

router.post('/admin/health/containers', (req, res) => {
  containerLogoUpload(req, res, (err) => {
    if (err) return res.status(400).render('error', { message: err.message });

    const containerName = String(req.body.container_name || '').trim();
    const label = String(req.body.label || containerName).trim();

    if (!containerName) return res.status(400).redirect('/admin/health');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName)) {
      return res.status(400).render('error', { message: 'Container name can only contain letters, numbers, dots, dashes, and underscores.' });
    }

    const maxOrder = db.prepare('SELECT MAX(sort_order) AS m FROM admin_health_containers').get().m || 0;
    const logoPath = req.file ? `/uploads/${req.file.filename}` : null;

    db.prepare('INSERT INTO admin_health_containers (container_name, label, logo_path, sort_order) VALUES (?, ?, ?, ?)').run(
      containerName,
      label,
      logoPath,
      maxOrder + 1
    );
    res.redirect('/admin/health');
  });
});

router.post('/admin/health/containers/:id/logo', (req, res) => {
  containerLogoUpload(req, res, (err) => {
    if (err) return res.status(400).render('error', { message: err.message });
    if (req.file) {
      db.prepare('UPDATE admin_health_containers SET logo_path = ? WHERE id = ?').run(`/uploads/${req.file.filename}`, req.params.id);
    }
    res.redirect('/admin/health');
  });
});

router.post('/admin/health/containers/:id/delete', (req, res) => {
  db.prepare('DELETE FROM admin_health_containers WHERE id = ?').run(req.params.id);
  res.redirect('/admin/health');
});

router.post('/admin/health/containers/:id/move', (req, res) => {
  const direction = req.body.direction === 'up' ? 'up' : 'down';
  const containers = db.prepare('SELECT * FROM admin_health_containers ORDER BY sort_order ASC, id ASC').all();
  const index = containers.findIndex((c) => c.id === Number(req.params.id));
  if (index === -1) return res.redirect('/admin/health');

  const swapIndex = direction === 'up' ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= containers.length) return res.redirect('/admin/health');

  const current = containers[index];
  const swap = containers[swapIndex];
  const update = db.prepare('UPDATE admin_health_containers SET sort_order = ? WHERE id = ?');
  update.run(swap.sort_order, current.id);
  update.run(current.sort_order, swap.id);

  res.redirect('/admin/health');
});

router.get('/admin/health/status', async (req, res) => {
  const containers = db.prepare('SELECT * FROM admin_health_containers').all();
  if (containers.length === 0) return res.json({ ok: true, containers: [] });

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) {
    return res.json({
      ok: true,
      containers: containers.map((c) => ({ id: c.id, label: c.label, container_name: c.container_name, status: 'unknown' })),
    });
  }

  const statuses = await getContainerStatuses(target, containers.map((c) => c.container_name));

  res.json({
    ok: true,
    containers: containers.map((c) => ({
      id: c.id,
      label: c.label,
      container_name: c.container_name,
      status: statuses[c.container_name] || 'unknown',
    })),
  });
});

async function handleHealthAction(req, res, action) {
  const container = db.prepare('SELECT * FROM admin_health_containers WHERE id = ?').get(req.params.id);
  if (!container) return res.status(404).json({ ok: false, message: 'Container not found.' });

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) {
    return res.status(400).json({ ok: false, message: 'No admin SSH access configured yet. Set it up in Settings first.' });
  }

  const command = `docker ${action} '${container.container_name}'`;
  const result = await runCommand(target, command);

  db.prepare(
    'INSERT INTO admin_health_log (admin_user_id, container_name, action, success, output) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.id, container.container_name, action, result.success ? 1 : 0, result.output);

  res.json({
    ok: result.success,
    message: result.success
      ? `${container.label} ${action === 'stop' ? 'stopped' : 'restarted'} successfully.`
      : `Failed to ${action} ${container.label}: ${result.output}`,
  });
}

router.post('/admin/health/containers/:id/stop', (req, res) => handleHealthAction(req, res, 'stop'));
router.post('/admin/health/containers/:id/restart', (req, res) => handleHealthAction(req, res, 'restart'));

module.exports = router;
