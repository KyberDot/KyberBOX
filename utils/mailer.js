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
async function notifyResetStarted(recipients, withUpdate = true) {
  if (!recipients || recipients.length === 0) return;
  const window = withUpdate ? '5–15 minutes' : '4–8 minutes';
  const subject = withUpdate ? 'Scheduled Server Update In Progress' : 'Scheduled Server Reset In Progress';
  const introLine = withUpdate ? 'A server update is currently in progress.' : 'A server reset is currently in progress.';

  await Promise.all(
    recipients.map((person) =>
      sendMail({
        to: person.email,
        subject,
        bodyHtml: `
          <p>Hi ${person.name},</p>
          <p>${introLine} Services may be briefly interrupted while this completes.</p>
          <p>We expect to resume within <strong>${window}</strong>. Apologies for the inconvenience.</p>
        `,
      })
    )
  ).catch(() => {}); // best-effort - never let a mail hiccup affect the reset itself
}

async function notifyAutoResetStarted(recipients, serviceLabel, withUpdate = true) {
  if (!recipients || recipients.length === 0) return;
  const window = withUpdate ? '5–15 minutes' : '4–8 minutes';

  const serviceMention = serviceLabel ? `with <strong>${serviceLabel}</strong>` : 'with one of the services';

  await Promise.all(
    recipients.map((person) =>
      sendMail({
        to: person.email,
        subject: 'Automatic Server Reset In Progress',
        bodyHtml: `
          <p>Hi ${person.name},</p>
          <p>Our monitoring detected an issue ${serviceMention} and is automatically restarting the affected systems to fix it. Services may be briefly interrupted while this completes.</p>
          <p>We expect to resume within <strong>${window}</strong>. No action is needed on your end. Apologies for the inconvenience.</p>
        `,
      })
    )
  ).catch(() => {});
}

async function notifyAdminVpnFailure(admins, serviceLabel, containerName) {
  if (!admins || admins.length === 0) return;

  await Promise.all(
    admins.map((admin) =>
      sendMail({
        to: admin.email,
        subject: `VPN Guard Failure: ${serviceLabel}`,
        bodyHtml: `
          <p>Hi ${admin.name},</p>
          <p><strong>${serviceLabel}</strong> (container: <code>${containerName}</code>) reported a VPN connection failure and refused to start its service. It will keep retrying based on its restart policy, but the VPN tunnel itself may need attention.</p>
          <p>Check the container's logs or the Health page for more detail.</p>
        `,
      })
    )
  ).catch(() => {});
}

async function notifyAdminContainersUnhealthy(admins, items) {
  if (!admins || admins.length === 0 || !items || items.length === 0) return;

  const subject = items.length === 1
    ? `Container Watchdog: ${items[0].container.label} is ${items[0].status}`
    : `Container Watchdog: ${items.length} containers need attention`;

  const intro = items.length === 1
    ? `<p><strong>${items[0].container.label}</strong> (container: <code>${items[0].container.container_name}</code>) has been <strong>${items[0].status}</strong> for more than 2 minutes, outside of any restart or update triggered from the portal.</p>`
    : `<p>The following ${items.length} containers have each been offline or unhealthy for more than 2 minutes, outside of any restart or update triggered from the portal:</p>
       <ul>${items.map(({ container, status }) => `<li><strong>${container.label}</strong> (<code>${container.container_name}</code>) — <strong>${status}</strong></li>`).join('')}</ul>`;

  await Promise.all(
    admins.map((admin) =>
      sendMail({
        to: admin.email,
        subject,
        bodyHtml: `
          <p>Hi ${admin.name},</p>
          ${intro}
          <p>Check each container's logs or the Health page for more detail.</p>
        `,
      })
    )
  ).catch(() => {});
}

async function notifyAdminProviderExpiring(admins, provider, daysLeft) {
  if (!admins || admins.length === 0) return;
  const dayWord = daysLeft === 1 ? 'day' : 'days';
  const dueText = daysLeft <= 0 ? 'has already expired' : `expires in ${daysLeft} ${dayWord}`;

  await Promise.all(
    admins.map((admin) =>
      sendMail({
        to: admin.email,
        subject: `${provider.name} ${dueText}`,
        bodyHtml: `
          <p>Hi ${admin.name},</p>
          <p><strong>${provider.name}</strong> (${provider.group_label}) ${dueText}${provider.tracking_value ? ` on <strong>${provider.tracking_value}</strong>` : ''}.</p>
          <p>Check the Providers page to renew it or update its tracked expiry date.</p>
        `,
      })
    )
  ).catch(() => {});
}

module.exports = { sendMail, isConfigured, getTransporter, notifyResetStarted, notifyAutoResetStarted, notifyAdminVpnFailure, notifyAdminProviderExpiring, notifyAdminContainersUnhealthy };
