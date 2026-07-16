const nodemailer = require('nodemailer');
const { getAllSettings } = require('./settings');

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
      <h2 style="color:#38bdf8;margin-top:0;">${siteName}</h2>
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
    });
    return { sent: true };
  } catch (err) {
    console.error('[mailer] send failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendMail, isConfigured, getTransporter };
