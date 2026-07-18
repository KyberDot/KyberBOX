const express = require('express');
const db = require('../db');
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

router.get('/support', (req, res) => {
  const tickets = db
    .prepare('SELECT * FROM tickets WHERE user_id = ? ORDER BY updated_at DESC')
    .all(req.user.id);

  const presetCategory = typeof req.query.category === 'string' ? req.query.category : '';

  res.render('support', { tickets, presetCategory });
});

router.post('/support/tickets', async (req, res) => {
  const subject = String(req.body.subject || '').trim();
  const category = String(req.body.category || 'general').trim();
  const message = String(req.body.message || '').trim();

  if (!subject || !message) {
    return res.status(400).redirect('/support');
  }

  const info = db
    .prepare('INSERT INTO tickets (user_id, subject, category, status) VALUES (?, ?, ?, ?)')
    .run(req.user.id, subject, category, 'open');

  db.prepare(
    'INSERT INTO ticket_messages (ticket_id, sender_role, sender_name, message) VALUES (?, ?, ?, ?)'
  ).run(info.lastInsertRowid, 'subscriber', req.user.name, message);

  await notifyAdminsOfTicket(req, { id: info.lastInsertRowid, subject }, message, true);

  res.redirect('/support');
});

router.get('/support/tickets/:id', (req, res) => {
  const ticket = db
    .prepare('SELECT * FROM tickets WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!ticket) return res.status(404).render('error', { message: 'Ticket not found.' });

  const messages = db
    .prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC')
    .all(ticket.id);

  res.render('ticket-thread', { ticket, messages, backUrl: '/support', canReply: ticket.status !== 'closed', replyAction: `/support/tickets/${ticket.id}/reply` });
});

router.post('/support/tickets/:id/reply', async (req, res) => {
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
  res.redirect(`/support/tickets/${ticket.id}`);
});

module.exports = router;
