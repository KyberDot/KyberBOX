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
async function sendMail({ to, subject, bodyHtml, audience = 'user', bypassToggle = false }) {
  const settings = getAllSettings();

  // Lets an admin temporarily silence one category of email (or both)
  // without touching anything else - all the background watchdogs,
  // renewal checks, etc keep running exactly as before; this only ever
  // affects whether the resulting email actually goes out.
  if (!bypassToggle) {
    if (audience === 'user' && settings.user_emails_enabled === '0') {
      return { sent: false, reason: 'User emails are currently disabled (Admin -> Settings -> Mail).', skippedByToggle: true };
    }
    if (audience === 'admin' && settings.admin_emails_enabled === '0') {
      return { sent: false, reason: 'Admin emails are currently disabled (Admin -> Settings -> Mail).', skippedByToggle: true };
    }
  }

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
        audience: 'user',
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
        audience: 'user',
        bodyHtml: `
          <p>Hi ${person.name},</p>
          <p>Our monitoring detected an issue ${serviceMention} and is automatically restarting the affected systems to fix it. Services may be briefly interrupted while this completes.</p>
          <p>We expect to resume within <strong>${window}</strong>. No action is needed on your end. Apologies for the inconvenience.</p>
        `,
      })
    )
  ).catch(() => {});
}

async function notifyAdminStuckMountAutoReset(admins, serviceLabel, withUpdate = false) {
  if (!admins || admins.length === 0) return;
  const window = withUpdate ? '5–15 minutes' : '4–8 minutes';

  const serviceMention = serviceLabel ? `<strong>${serviceLabel}</strong>` : 'one of the services';

  await Promise.all(
    admins.map((admin) =>
      sendMail({
        to: admin.email,
        subject: 'Stuck-Mount Watchdog: Automatic Reset In Progress',
        audience: 'admin',
        bodyHtml: `
          <p>Hi ${admin.name},</p>
          <p>Stuck-Mount detected an issue with ${serviceMention} and is automatically restarting the affected systems to fix it. Services may be briefly interrupted while this completes.</p>
          <p>We expect to resume within <strong>${window}</strong>. No action is needed on your end.</p>
        `,
      })
    )
  ).catch(() => {});
}

async function notifyAdminVpnInactive(admins, serviceLabel, containerName) {
  if (!admins || admins.length === 0) return;

  await Promise.all(
    admins.map((admin) =>
      sendMail({
        to: admin.email,
        subject: `VPN Guard: ${serviceLabel} is inactive`,
        audience: 'admin',
        bodyHtml: `
          <p>Hi ${admin.name},</p>
          <p><strong>${serviceLabel}</strong> (container: <code>${containerName}</code>) has been running for more than 2 minutes without a confirmed VPN connection - either it reported a failure, or no confirmation could be found at all.</p>
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
        audience: 'admin',
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
        audience: 'admin',
        bodyHtml: `
          <p>Hi ${admin.name},</p>
          <p><strong>${provider.name}</strong> (${provider.group_label}) ${dueText}${provider.tracking_value ? ` on <strong>${provider.tracking_value}</strong>` : ''}.</p>
          <p>Check the Providers page to renew it or update its tracked expiry date.</p>
        `,
      })
    )
  ).catch(() => {});
}

module.exports = { sendMail, isConfigured, getTransporter, notifyResetStarted, notifyAutoResetStarted, notifyAdminStuckMountAutoReset, notifyAdminVpnInactive, notifyAdminProviderExpiring, notifyAdminContainersUnhealthy };
