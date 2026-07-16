const express = require('express');
const db = require('../db');
const { runCommand, getContainerStatuses } = require('../utils/ssh');
const { sendMail } = require('../utils/mailer');
const { getAllSettings, getSiteBaseUrl } = require('../utils/settings');

const router = express.Router();

function adminEmails() {
  return db.prepare("SELECT email FROM users WHERE role = 'admin'").all().map((r) => r.email);
}

async function notifyAdminsOfTicket(req, { id, subject }, message, isNew) {
  const siteName = getAllSettings().site_name;
  const ticketUrl = `${getSiteBaseUrl(req)}/admin/tickets/${id}`;
  const recipients = adminEmails();
  if (recipients.length === 0) return;

  await sendMail({
    to: recipients.join(','),
    subject: `${isNew ? 'New ticket' : 'Ticket reply'}: ${subject}`,
    bodyHtml: `
      <p>${req.user.name} (${req.user.email}) ${isNew ? 'opened a new ticket' : 'replied to a ticket'} on ${siteName}:</p>
      <p style="background:#0b1220;border-radius:10px;padding:16px;white-space:pre-wrap;">${message}</p>
      <p><a href="${ticketUrl}" style="display:inline-block;background:#0ea5e9;color:#0b0f1a;font-weight:700;padding:12px 20px;border-radius:10px;text-decoration:none;">View Ticket</a></p>
    `,
  });
}

/** Loads everything the dashboard needs for one active subscription's plan. */
function buildPlanView(subscription, userId) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(subscription.plan_id);
  if (!plan) return null;

  const ssh = db.prepare('SELECT id FROM plan_ssh WHERE plan_id = ?').get(plan.id);
  const actions = db
    .prepare('SELECT * FROM plan_actions WHERE plan_id = ? ORDER BY sort_order ASC, id ASC')
    .all(plan.id);
  const containers = db
    .prepare('SELECT * FROM plan_containers WHERE plan_id = ? ORDER BY sort_order ASC, id ASC')
    .all(plan.id);

  const actionsWithCooldown = actions.map((action) => {
    const lastRun = db
      .prepare('SELECT * FROM action_log WHERE user_id = ? AND plan_action_id = ? ORDER BY requested_at DESC LIMIT 1')
      .get(userId, action.id);

    let nextAllowedAt = null;
    if (lastRun && action.cooldown_hours > 0) {
      const last = new Date(lastRun.requested_at + 'Z').getTime();
      const next = last + action.cooldown_hours * 60 * 60 * 1000;
      if (next > Date.now()) nextAllowedAt = new Date(next).toISOString();
    }

    return { ...action, nextAllowedAt };
  });

  return {
    subscription,
    plan,
    hasSsh: !!ssh,
    actions: actionsWithCooldown,
    containers,
  };
}

router.get('/dashboard', (req, res) => {
  const subscriptions = db
    .prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user.id);

  const planViews = subscriptions
    .filter((s) => s.plan_id && s.status === 'active')
    .map((s) => buildPlanView(s, req.user.id))
    .filter(Boolean);

  const legacySubscriptions = subscriptions.filter((s) => !s.plan_id);

  const tickets = db
    .prepare('SELECT * FROM tickets WHERE user_id = ? ORDER BY updated_at DESC')
    .all(req.user.id);

  res.render('dashboard', { subscriptions, planViews, legacySubscriptions, tickets });
});

// Container health is checked over SSH, so it's fetched asynchronously
// after the page loads rather than blocking the initial render.
router.get('/dashboard/plans/:planId/health', async (req, res) => {
  const subscription = db
    .prepare("SELECT * FROM subscriptions WHERE user_id = ? AND plan_id = ? AND status = 'active'")
    .get(req.user.id, req.params.planId);
  if (!subscription) return res.status(403).json({ ok: false, message: 'No active subscription to this plan.' });

  const containers = db.prepare('SELECT * FROM plan_containers WHERE plan_id = ?').all(req.params.planId);
  if (containers.length === 0) return res.json({ ok: true, containers: [] });

  const target = db.prepare('SELECT * FROM plan_ssh WHERE plan_id = ?').get(req.params.planId);
  if (!target) {
    return res.json({
      ok: true,
      containers: containers.map((c) => ({ label: c.label, container_name: c.container_name, status: 'unknown' })),
    });
  }

  const statuses = await getContainerStatuses(target, containers.map((c) => c.container_name));

  res.json({
    ok: true,
    containers: containers.map((c) => ({
      label: c.label,
      container_name: c.container_name,
      status: statuses[c.container_name] || 'unknown',
    })),
  });
});

router.post('/dashboard/actions/:actionId/run', async (req, res) => {
  const action = db.prepare('SELECT * FROM plan_actions WHERE id = ?').get(req.params.actionId);
  if (!action) return res.status(404).json({ ok: false, message: 'Action not found.' });

  const subscription = db
    .prepare("SELECT * FROM subscriptions WHERE user_id = ? AND plan_id = ? AND status = 'active'")
    .get(req.user.id, action.plan_id);
  if (!subscription) return res.status(403).json({ ok: false, message: 'No active subscription for this action.' });

  const lastRun = db
    .prepare('SELECT * FROM action_log WHERE user_id = ? AND plan_action_id = ? ORDER BY requested_at DESC LIMIT 1')
    .get(req.user.id, action.id);

  if (lastRun && action.cooldown_hours > 0) {
    const last = new Date(lastRun.requested_at + 'Z').getTime();
    const cooldownMs = action.cooldown_hours * 60 * 60 * 1000;
    if (Date.now() - last < cooldownMs) {
      const waitMins = Math.ceil((cooldownMs - (Date.now() - last)) / 60000);
      return res.status(429).json({
        ok: false,
        message: `You can only use "${action.label}" once every ${action.cooldown_hours} hour(s). Please wait about ${waitMins} more minute(s).`,
      });
    }
  }

  const target = db.prepare('SELECT * FROM plan_ssh WHERE plan_id = ?').get(action.plan_id);
  if (!target) {
    db.prepare('INSERT INTO action_log (user_id, plan_action_id, success, output) VALUES (?, ?, 0, ?)').run(
      req.user.id,
      action.id,
      'No server access configured yet for this plan - contact support.'
    );
    return res.status(400).json({
      ok: false,
      message: 'Server access has not been configured for this plan yet. Please raise a ticket so we can set that up.',
    });
  }

  const result = await runCommand(target, action.command);

  db.prepare('INSERT INTO action_log (user_id, plan_action_id, success, output) VALUES (?, ?, ?, ?)').run(
    req.user.id,
    action.id,
    result.success ? 1 : 0,
    result.output
  );

  res.json({
    ok: result.success,
    message: result.success
      ? `"${action.label}" completed successfully.`
      : `"${action.label}" failed: ${result.output}`,
  });
});

router.post('/dashboard/tickets', async (req, res) => {
  const subject = String(req.body.subject || '').trim();
  const category = String(req.body.category || 'general').trim();
  const message = String(req.body.message || '').trim();

  if (!subject || !message) {
    return res.status(400).redirect('/dashboard#tickets');
  }

  const info = db
    .prepare('INSERT INTO tickets (user_id, subject, category, status) VALUES (?, ?, ?, ?)')
    .run(req.user.id, subject, category, 'open');

  db.prepare(
    'INSERT INTO ticket_messages (ticket_id, sender_role, sender_name, message) VALUES (?, ?, ?, ?)'
  ).run(info.lastInsertRowid, 'subscriber', req.user.name, message);

  await notifyAdminsOfTicket(req, { id: info.lastInsertRowid, subject }, message, true);

  res.redirect('/dashboard#tickets');
});

router.get('/dashboard/tickets/:id', (req, res) => {
  const ticket = db
    .prepare('SELECT * FROM tickets WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!ticket) return res.status(404).render('error', { message: 'Ticket not found.' });

  const messages = db
    .prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC')
    .all(ticket.id);

  res.render('ticket-thread', { ticket, messages, backUrl: '/dashboard', canReply: ticket.status !== 'closed', replyAction: `/dashboard/tickets/${ticket.id}/reply` });
});

router.post('/dashboard/tickets/:id/reply', async (req, res) => {
  const ticket = db
    .prepare('SELECT * FROM tickets WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!ticket) return res.status(404).render('error', { message: 'Ticket not found.' });

  const message = String(req.body.message || '').trim();
  if (message) {
    db.prepare(
      'INSERT INTO ticket_messages (ticket_id, sender_role, sender_name, message) VALUES (?, ?, ?, ?)'
    ).run(ticket.id, 'subscriber', req.user.name, message);
    db.prepare("UPDATE tickets SET status = 'open', updated_at = datetime('now') WHERE id = ?").run(ticket.id);
    await notifyAdminsOfTicket(req, ticket, message, false);
  }
  res.redirect(`/dashboard/tickets/${ticket.id}`);
});

module.exports = router;
