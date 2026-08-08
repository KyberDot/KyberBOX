const nodemailer = require('nodemailer');
const path = require('path');
const { getAllSettings } = require('./settings');

const LOGO_PATH = path.join(__dirname, '..', 'public', 'img', 'fav.png');
const LOGO_CID = 'kyberbox-logo';

function isConfigured(settings) {
  return !!(settings.smtp_host && settings.smtp_user && settings.smtp_pass && settings.smtp_from_email);
}

function getTransporter(settings) {
  return nodemailer.createTransport({
    host: settings.smtp_host,
    port: Number(settings.smtp_port) || 587,
    secure: settings.smtp_secure === '1' || settings.smtp_secure === 'true',
    auth: { user: settings.smtp_user, pass: settings.smtp_pass },
  });
}

function wrapHtml(siteName, bodyHtml) {
  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;background:#0b0f1a;padding:32px;">
    <div style="max-width:520px;margin:0 auto;background:#111827;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:32px;color:#e2e8f0;">
      <div style="margin-bottom:20px;">
        <img src="cid:${LOGO_CID}" alt="${siteName}" height="40" style="height:40px;width:auto;display:block;">
      </div>
      ${bodyHtml}
      <p style="color:#64748b;font-size:12px;margin-top:32px;">This is an automated message from ${siteName}.</p>
    </div>
  </div>`;
}

/**
 * Sends an email using the currently configured SMTP settings.
 * Returns { sent: boolean, reason?: string } - never throws, so callers
 * (ticket creation, invites, etc.) can proceed even if mail isn't configured
 * or delivery fails.
 */
async function sendMail({ to, subject, bodyHtml }) {
  const settings = getAllSettings();

  if (!isConfigured(settings)) {
    return { sent: false, reason: 'SMTP is not configured yet (Admin -> Settings -> Mail).' };
  }

  try {
    const transporter = getTransporter(settings);
    await transporter.sendMail({
      from: `"${settings.smtp_from_name}" <${settings.smtp_from_email}>`,
      to,
      subject,
      html: wrapHtml(settings.site_name, bodyHtml),
      attachments: [
        {
          filename: 'logo.png',
          path: LOGO_PATH,
          cid: LOGO_CID,
        },
      ],
    });
    return { sent: true };
  } catch (err) {
    console.error('[mailer] send failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

/**
 * Notifies a list of {email, name} recipients that a server reset has just
 * started. Used both for an admin-triggered Full Reset (system-wide) and a
 * subscriber-triggered danger action (scoped to that plan's other
 * subscribers) - same wording either way, best-effort, never throws.
 */
async function notifyResetStarted(recipients) {
  if (!recipients || recipients.length === 0) return;

  await Promise.all(
    recipients.map((person) =>
      sendMail({
        to: person.email,
        subject: 'Scheduled Server Reset In Progress',
        bodyHtml: `
          <p>Hi ${person.name},</p>
          <p>A server reset is currently in progress. Services may be briefly interrupted while this completes.</p>
          <p>We expect to resume within <strong>5–15 minutes</strong>. Apologies for the inconvenience.</p>
        `,
      })
    )
  ).catch(() => {}); // best-effort - never let a mail hiccup affect the reset itself
}

async function notifyAutoResetStarted(recipients) {
  if (!recipients || recipients.length === 0) return;

  await Promise.all(
    recipients.map((person) =>
      sendMail({
        to: person.email,
        subject: 'Automatic Server Reset In Progress',
        bodyHtml: `
          <p>Hi ${person.name},</p>
          <p>Our monitoring detected an issue with one of the services and is automatically restarting the affected systems to fix it. Services may be briefly interrupted while this completes.</p>
          <p>We expect to resume within <strong>5–15 minutes</strong>. No action is needed on your end. Apologies for the inconvenience.</p>
        `,
      })
    )
  ).catch(() => {});
}

module.exports = { sendMail, isConfigured, getTransporter, notifyResetStarted, notifyAutoResetStarted };
