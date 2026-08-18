const db = require('../db');
const { sendMail, notifyAdminProviderExpiring } = require('./mailer');
const { getAllSettings, getSetting } = require('./settings');
const { syncIncludedPlansForUser } = require('./includedPlans');

/**
 * For any active subscription set to auto-renew whose expiry date has
 * passed, pushes the expiry forward a month at a time until it's back in
 * the future. This is the entire "auto-renew" behaviour in the absence of
 * real payment processing - it just keeps rolling the date forward, and
 * status stays "active" throughout, so nothing (including Plex access)
 * ever gets revoked for these.
 */
function applyAutoRenewals() {
  const due = db
    .prepare(
      `SELECT id, expires_at FROM subscriptions
       WHERE renewal_mode = 'auto' AND status = 'active' AND expires_at IS NOT NULL AND expires_at < date('now')`
    )
    .all();

  if (due.length === 0) return;

  const update = db.prepare(`UPDATE subscriptions SET expires_at = ?, updated_at = datetime('now') WHERE id = ?`);
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');

  due.forEach((sub) => {
    let d = new Date(String(sub.expires_at).slice(0, 10) + 'T00:00:00Z');
    if (isNaN(d.getTime())) return;
    let guard = 0;
    while (d < today && guard < 240) { // safety cap: 20 years of monthly rollovers
      d.setUTCMonth(d.getUTCMonth() + 1);
      guard += 1;
    }
    update.run(d.toISOString().slice(0, 10), sub.id);
  });
}

/**
 * The other half of "expiry revokes access unless renewed": a subscription
 * on manual renewal that nobody has renewed by its expiry date flips to
 * "expired" here. Auto-renew subscriptions are excluded by the WHERE
 * clause - they're handled entirely by applyAutoRenewals() above and
 * never expire this way.
 */
function applyManualExpirations() {
  const due = db
    .prepare(
      `SELECT id, user_id FROM subscriptions
       WHERE renewal_mode = 'manual' AND status = 'active' AND expires_at IS NOT NULL AND expires_at < date('now')`
    )
    .all();

  if (due.length === 0) return;

  const update = db.prepare(`UPDATE subscriptions SET status = 'expired', updated_at = datetime('now') WHERE id = ?`);
  const affectedUserIds = new Set();

  due.forEach((sub) => {
    update.run(sub.id);
    affectedUserIds.add(sub.user_id);
  });

  // A plan that just expired might have been what qualified someone for
  // an auto-granted "included with" plan (e.g. a Minecraft plan bundled
  // with a Plex plan) - re-check so that gets revoked too, not left
  // dangling now that its trigger is gone.
  affectedUserIds.forEach((userId) => {
    try {
      syncIncludedPlansForUser(userId);
    } catch (err) {
      console.error('[renewals] included-plan sync failed:', err.message);
    }
  });
}

/**
 * Sends a "renew soon or you'll lose access" email once for any manual-
 * renewal subscription entering its final 3 days before expiry - never
 * repeats for the same subscription (expiry_warning_sent_at gates that),
 * and only fires for subscriptions that could actually still be saved by
 * renewing (auto-renew ones never enter this state at all). Renewing
 * (routes/admin.js clears expiry_warning_sent_at when expires_at changes)
 * lets a fresh warning fire again if it approaches expiry a second time.
 */
async function applyExpiryWarnings() {
  const due = db
    .prepare(
      `SELECT s.id, s.plan_name, s.expires_at, u.name, u.email
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE s.renewal_mode = 'manual' AND s.status = 'active'
         AND s.expires_at IS NOT NULL
         AND s.expires_at >= date('now')
         AND s.expires_at <= date('now', '+3 days')
         AND s.expiry_warning_sent_at IS NULL`
    )
    .all();

  if (due.length === 0) return;

  const markSent = db.prepare(`UPDATE subscriptions SET expiry_warning_sent_at = datetime('now') WHERE id = ?`);
  const siteName = getAllSettings().site_name;
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');

  await Promise.all(
    due.map(async (sub) => {
      const expiry = new Date(String(sub.expires_at).slice(0, 10) + 'T00:00:00Z');
      const daysLeft = Math.max(0, Math.round((expiry - today) / (1000 * 60 * 60 * 24)));
      const dayWord = daysLeft === 1 ? 'day' : 'days';

      await sendMail({
        to: sub.email,
        subject: `Your ${siteName} subscription expires in ${daysLeft} ${dayWord}`,
        bodyHtml: `
          <p>Hi ${sub.name},</p>
          <p>Your <strong>${sub.plan_name}</strong> subscription is due to expire in <strong>${daysLeft} ${dayWord}</strong>.</p>
          <p>If it isn't renewed by then, access will be automatically revoked.</p>
          <p>To keep things running, please renew before it expires. If you've already arranged this with us, you can ignore this message.</p>
        `,
      }).catch(() => {}); // best-effort - never let a mail hiccup block marking this as handled

      markSent.run(sub.id);
    })
  );
}

/**
 * Admin equivalent of applyExpiryWarnings above, but for Providers page
 * entries tracking an actual expiry date (plan_status = 'date') rather
 * than subscriber subscriptions. Same idea: warn 2 days out, once, and
 * don't re-send until the tracked date itself changes (see the tracking
 * route, which clears expiry_warning_sent_at whenever it's edited).
 */
async function applyProviderExpiryWarnings() {
  if (getSetting('provider_expiry_notifications_enabled', '1') !== '1') return;

  const due = db
    .prepare(
      `SELECT * FROM admin_providers
       WHERE plan_status = 'date'
         AND tracking_value IS NOT NULL
         AND tracking_value <= date('now', '+2 days')
         AND expiry_warning_sent_at IS NULL`
    )
    .all();

  if (due.length === 0) return;

  const admins = db.prepare("SELECT name, email FROM users WHERE role = 'admin'").all();
  if (admins.length === 0) return;

  const markSent = db.prepare(`UPDATE admin_providers SET expiry_warning_sent_at = datetime('now') WHERE id = ?`);
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');

  await Promise.all(
    due.map(async (provider) => {
      const expiry = new Date(String(provider.tracking_value).slice(0, 10) + 'T00:00:00Z');
      const daysLeft = Math.round((expiry - today) / (1000 * 60 * 60 * 24));

      await notifyAdminProviderExpiring(admins, provider, daysLeft).catch(() => {}); // best-effort - never let a mail hiccup block marking this as handled

      markSent.run(provider.id);
    })
  );
}

module.exports = { applyAutoRenewals, applyManualExpirations, applyExpiryWarnings, applyProviderExpiryWarnings };
