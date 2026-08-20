const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
const { getAllSettings, setSetting, getSiteBaseUrl } = require('../utils/settings');
const { sendMail, isConfigured, notifyResetStarted } = require('../utils/mailer');
const { testConnection: testTautulliConnection, getWatchHistory, getNowWatching, getAllActivity, getGeoLookup, fetchPosterImage } = require('../utils/tautulli');
const { syncIncludedPlansForUser } = require('../utils/includedPlans');
const { londonInputToUtcIso, formatUK, formatUKForEmail } = require('../utils/time');
const { serviceLabel } = require('../utils/labels');
const { runCommand, getContainerStatuses } = require('../utils/ssh');
const { checkVpnWatch } = require('../utils/vpnWatch');
const { checkStuckWatch } = require('../utils/stuckWatch');
const { upload } = require('../utils/uploads');
const { startReset, endReset, getResetState } = require('../utils/resetLock');
const { markContainerActionStart, markContainerActionEnd } = require('../utils/containerActionLock');
const { requireFullAdmin } = require('../middleware/auth');
const { triggerFullReset, getFullResetState, dismissFullResetResult } = require('../utils/fullReset');
const s3 = require('../utils/s3');
const { computeElapsedSeconds, startTimer, stopTimer, restartTimer, resetIfLinkedContainerAction } = require('../utils/runTimer');
const { BOSSES, columnForBossKey } = require('../utils/bosses');
const { getProviderStatus, clearProviderCache } = require('../utils/providerChecks');
const sftpStorage = require('../utils/sftpStorage');
const { bucketUpload } = require('../utils/uploads');

const router = express.Router();
const brandingUpload = upload.fields([{ name: 'favicon', maxCount: 1 }, { name: 'apple_icon', maxCount: 1 }]);
const containerLogoUpload = upload.single('logo');

function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
}

function loadPlans() {
  const plans = db.prepare('SELECT * FROM plans ORDER BY created_at ASC').all();
  plans.forEach((p) => { p.runTimerElapsedSeconds = computeElapsedSeconds(p); });

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

  const subscriberCountByPlan = {};
  db.prepare(`SELECT plan_id, COUNT(*) AS count FROM subscriptions WHERE status = 'active' GROUP BY plan_id`).all().forEach((row) => {
    subscriberCountByPlan[row.plan_id] = row.count;
  });

  const deathCounterPlayersByPlan = {};
  db.prepare('SELECT * FROM plan_death_counter_players ORDER BY death_count DESC, player_name ASC').all().forEach((p) => {
    (deathCounterPlayersByPlan[p.plan_id] = deathCounterPlayersByPlan[p.plan_id] || []).push(p);
  });

  const allContainerActions = db.prepare(
    `SELECT aca.id, aca.label, ahc.label AS container_label
     FROM admin_container_actions aca
     JOIN admin_health_containers ahc ON ahc.id = aca.container_id
     ORDER BY ahc.label ASC, aca.sort_order ASC`
  ).all();

  return { plans, sshByPlan, actionsByPlan, containersByPlan, subscriberCountByPlan, deathCounterPlayersByPlan, allContainerActions, BOSSES };
}

function loadUsersPageData() {
  const users = db.prepare("SELECT * FROM users WHERE role = 'subscriber' ORDER BY created_at DESC").all();

  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');

  const subsByUser = {};
  db.prepare(
    `SELECT s.*, p.name AS plan_display_name FROM subscriptions s
     LEFT JOIN plans p ON p.id = s.plan_id`
  ).all().forEach((s) => {
    // Precomputed here (rather than in the view) so the same "3 days"
    // window used for the actual warning email/nav badge stays in sync
    // with what admins see on this page - one source of truth.
    if (s.status === 'active' && s.renewal_mode === 'manual' && s.expires_at) {
      const expiry = new Date(String(s.expires_at).slice(0, 10) + 'T00:00:00Z');
      const daysLeft = Math.round((expiry - today) / (1000 * 60 * 60 * 24));
      s.daysUntilExpiry = daysLeft;
      s.inGracePeriod = daysLeft >= 0 && daysLeft <= 3;
    } else {
      s.daysUntilExpiry = null;
      s.inGracePeriod = false;
    }
    (subsByUser[s.user_id] = subsByUser[s.user_id] || []).push(s);
  });

  const plans = db.prepare('SELECT * FROM plans ORDER BY name ASC').all();
  const paymentMethods = db.prepare('SELECT * FROM payment_methods ORDER BY name ASC').all();

  // Every action available to a user through their active subscriptions,
  // regardless of the action's own plan-wide enabled flag - admin needs
  // to see and manage the per-user override independently of that.
  const actionsByUser = {};
  db.prepare(
    `SELECT pa.*, s.user_id, p.name AS plan_display_name
     FROM plan_actions pa
     JOIN plans p ON p.id = pa.plan_id
     JOIN subscriptions s ON s.plan_id = pa.plan_id AND s.status = 'active'
     ORDER BY p.name ASC, pa.sort_order ASC, pa.id ASC`
  ).all().forEach((a) => {
    (actionsByUser[a.user_id] = actionsByUser[a.user_id] || []).push(a);
  });

  const overridesByUser = {};
  db.prepare('SELECT user_id, plan_action_id, enabled FROM user_disabled_actions').all().forEach((row) => {
    (overridesByUser[row.user_id] = overridesByUser[row.user_id] || {})[row.plan_action_id] = !!row.enabled;
  });
  Object.keys(actionsByUser).forEach((userId) => {
    const overrides = overridesByUser[userId] || {};
    actionsByUser[userId].forEach((a) => {
      a.hasOverride = Object.prototype.hasOwnProperty.call(overrides, a.id);
      a.overrideEnabled = a.hasOverride ? overrides[a.id] : null;
      a.effectivelyEnabled = a.hasOverride ? overrides[a.id] : !!a.enabled;
    });
  });

  // "Approved" once we've matched their Plex account (used to show/lookup
  // their watch history via Tautulli); "Pending" if they're on a Plex
  // plan but haven't been matched yet; null if Plex isn't relevant to
  // them at all.
  users.forEach((u) => {
    const onPlexPlan = (subsByUser[u.id] || []).some(
      (s) => s.status === 'active' && (s.service === 'plex' || s.service === 'multiple')
    );
    u.plexStatus = u.plex_username ? 'approved' : (onPlexPlan ? 'pending' : null);
  });

  return { users, subsByUser, plans, paymentMethods, actionsByUser };
}

function loadSettingsPageData() {
  const settings = getAllSettings();
  const healthSsh = db.prepare('SELECT id, host, port, username, auth_type FROM admin_ssh LIMIT 1').get();
  const paymentMethods = db.prepare('SELECT * FROM payment_methods ORDER BY name ASC').all();

  const admins = db.prepare("SELECT id, name, email, admin_access_mode, created_at FROM users WHERE role = 'admin' ORDER BY created_at ASC").all();
  const accessByAdmin = {};
  db.prepare('SELECT user_id, page_key FROM admin_page_access').all().forEach((row) => {
    (accessByAdmin[row.user_id] = accessByAdmin[row.user_id] || []).push(row.page_key);
  });
  admins.forEach((a) => { a.pages = accessByAdmin[a.id] || []; });

  const stuckWatches = db.prepare('SELECT * FROM stuck_watch_containers ORDER BY created_at ASC').all();
  const vpnWatches = db.prepare('SELECT * FROM vpn_watch_containers ORDER BY created_at ASC').all();

  const healthContainers = db.prepare('SELECT id, label, container_name FROM admin_health_containers WHERE is_active = 1 ORDER BY sort_order ASC, id ASC').all();
  const watchedContainerIds = new Set(db.prepare('SELECT container_id FROM container_watchdog_selected').all().map((r) => r.container_id));

  return { settings, healthSsh, paymentMethods, admins, stuckWatches, vpnWatches, healthContainers, watchedContainerIds };
}

router.get('/admin', (req, res) => {
  const userCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'subscriber'").get().c;
  const openTickets = db.prepare("SELECT COUNT(*) c FROM tickets WHERE status != 'closed'").get().c;
  const activeSubs = db.prepare("SELECT COUNT(*) c FROM subscriptions WHERE status = 'active'").get().c;
  const planCount = db.prepare('SELECT COUNT(*) c FROM plans').get().c;
  const healthContainerCount = db.prepare('SELECT COUNT(*) c FROM admin_health_containers WHERE is_active = 1').get().c;
  const recentActions = db
    .prepare(
      `SELECT al.*, u.name, u.email, pa.label AS action_label FROM action_log al
       JOIN users u ON u.id = al.user_id
       JOIN plan_actions pa ON pa.id = al.plan_action_id
       ORDER BY al.requested_at DESC LIMIT 25`
    )
    .all();
  const mailConfigured = isConfigured(getAllSettings());

  res.render('admin-overview', { userCount, openTickets, activeSubs, planCount, healthContainerCount, recentActions, mailConfigured });
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
  const pricingMode = ['paid', 'free', 'included_with'].includes(req.body.pricing_mode) ? req.body.pricing_mode : 'paid';
  const includedWithPlanIds = pricingMode === 'included_with'
    ? (Array.isArray(req.body.included_with_plan_ids) ? req.body.included_with_plan_ids : [req.body.included_with_plan_ids].filter(Boolean)).join(',')
    : null;
  const serverConnectionInfo = String(req.body.server_connection_info || '').trim() || null;

  if (!name) return res.status(400).render('error', { message: 'Missing required fields - please fill in everything marked required and try again.' });

  const info = db
    .prepare('INSERT INTO plans (name, service, description, features, price, currency, pricing_mode, included_with_plan_ids, server_connection_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(name, service, description, features, price, currency, pricingMode, includedWithPlanIds, serverConnectionInfo);

  // A brand-new plan with trigger plans already checked needs everyone
  // who currently qualifies synced immediately - this didn't happen
  // before, so a newly-created "included with" plan never actually
  // reached anyone until something else happened to trigger a sync.
  if (pricingMode === 'included_with' && includedWithPlanIds) {
    const affectedUserIds = db.prepare(`SELECT DISTINCT user_id FROM subscriptions WHERE status = 'active'`).all().map((r) => r.user_id);
    affectedUserIds.forEach((userId) => syncIncludedPlansForUser(userId));
  }

  res.render('admin-plans', { ...loadPlans(), newPlanId: info.lastInsertRowid });
});

router.post('/admin/plans/:id/update', (req, res) => {
  const name = String(req.body.name || '').trim();
  const service = String(req.body.service || 'docker').trim();
  const description = String(req.body.description || '').trim();
  const features = String(req.body.features || '').trim();
  const price = req.body.price ? Number(req.body.price) : null;
  const currency = String(req.body.currency || 'GBP').trim();
  const pricingMode = ['paid', 'free', 'included_with'].includes(req.body.pricing_mode) ? req.body.pricing_mode : 'paid';
  // Guard against a plan being set to include itself - meaningless and
  // would make the "included with" label loop back on itself in the UI.
  const includedWithPlanIds = pricingMode === 'included_with'
    ? (Array.isArray(req.body.included_with_plan_ids) ? req.body.included_with_plan_ids : [req.body.included_with_plan_ids].filter(Boolean))
        .map(Number)
        .filter((id) => id && id !== Number(req.params.id))
        .join(',')
    : null;
  const serverConnectionInfo = String(req.body.server_connection_info || '').trim() || null;

  db.prepare(
    `UPDATE plans SET name = ?, service = ?, description = ?, features = ?, price = ?, currency = ?, pricing_mode = ?, included_with_plan_ids = ?, server_connection_info = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(name, service, description, features, price, currency, pricingMode, includedWithPlanIds, serverConnectionInfo, req.params.id);

  // The trigger list (or pricing mode) may have just changed, so
  // everyone's inclusion needs re-checking - not just people on the
  // trigger plans, but also anyone currently holding an auto-granted copy
  // of THIS plan who might no longer qualify.
  const affectedUserIds = db
    .prepare(`SELECT DISTINCT user_id FROM subscriptions WHERE status = 'active'`)
    .all()
    .map((r) => r.user_id);
  affectedUserIds.forEach((userId) => syncIncludedPlansForUser(userId));

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
    const resumeLine = resumeAtUtc ? `We expect to resume by <strong>${formatUKForEmail(resumeAtUtc)}</strong>.` : '';

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
  if (!host || !username) return res.status(400).render('error', { message: 'Missing required fields - please fill in everything marked required and try again.' });

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
    if (!secret) return res.status(400).render('error', { message: 'Missing required fields - please fill in everything marked required and try again.' });
    db.prepare(
      `INSERT INTO plan_ssh (plan_id, host, port, username, auth_type, secret_encrypted) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(req.params.id, host, port || 22, username, auth_type || 'password', encrypt(secret));
  }

  res.redirect('/admin/plans');
});

// Curated set of icons offered in the picker - keeps the icon field a
// closed choice instead of free text, so it can no longer end up holding
// a command (or vice versa) by mistake.
const ACTION_ICONS = [
  'fa-rotate', 'fa-arrows-rotate', 'fa-power-off', 'fa-play', 'fa-stop',
  'fa-triangle-exclamation', 'fa-download', 'fa-broom', 'fa-wrench',
  'fa-server', 'fa-database', 'fa-terminal', 'fa-circle-play', 'fa-gear',
];

function sanitizeActionIcon(value) {
  return ACTION_ICONS.includes(value) ? value : 'fa-rotate';
}

// Only stored for danger-style actions - a warning-style action never
// triggers the reset banner at all, so this field is meaningless for it.
// Mirrors the admin Full Reset feature's own binary choice exactly - a
// simple "+Update" checkbox, not a 3-way pick. Unchecked defaults to the
// same 4-8 minute estimate as Restart Only; checked matches Reset & Update's
// 5-15 minutes. Only meaningful for danger-style actions (a warning-style
// action never triggers the reset banner at all).
function sanitizeBannerEstimate(withUpdateChecked, style) {
  if (style !== 'danger') return null;
  return withUpdateChecked ? '5-15' : '4-8';
}

// Catches the specific mistake that caused "fa-exclamation-triangle: command
// not found" - someone pasted an icon class into the Command field. Command
// text should never be just a bare "fa-..." token.
function looksLikeIconNotCommand(command) {
  return /^fa[-\s][a-z0-9-]+$/i.test(command.trim());
}

router.post('/admin/plans/:id/actions', (req, res) => {
  const label = String(req.body.label || '').trim();
  const command = String(req.body.command || '').trim();
  const icon = sanitizeActionIcon(String(req.body.icon || 'fa-rotate').trim());
  const style = req.body.style === 'danger' ? 'danger' : 'warning';
  const bannerTimeEstimate = sanitizeBannerEstimate(req.body.banner_with_update === '1', style);
  const cooldownHours = Math.max(0, parseInt(req.body.cooldown_hours, 10) || 6);

  if (!label || !command) return res.status(400).render('error', { message: 'Missing required fields - please fill in everything marked required and try again.' });
  if (looksLikeIconNotCommand(command)) {
    return res.status(400).render('error', { message: `"${command}" looks like an icon name, not a command - check the Command and Icon fields weren't swapped.` });
  }

  const maxOrder = db.prepare('SELECT MAX(sort_order) AS m FROM plan_actions WHERE plan_id = ?').get(req.params.id).m || 0;
  db.prepare(
    'INSERT INTO plan_actions (plan_id, label, command, icon, style, banner_time_estimate, cooldown_hours, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.params.id, label, command, icon, style, bannerTimeEstimate, cooldownHours, maxOrder + 1);

  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/actions/:actionId/update', (req, res) => {
  const label = String(req.body.label || '').trim();
  const command = String(req.body.command || '').trim();
  const icon = sanitizeActionIcon(String(req.body.icon || 'fa-rotate').trim());
  const style = req.body.style === 'danger' ? 'danger' : 'warning';
  const bannerTimeEstimate = sanitizeBannerEstimate(req.body.banner_with_update === '1', style);
  const cooldownHours = Math.max(0, parseInt(req.body.cooldown_hours, 10) || 6);

  if (!label || !command) return res.status(400).render('error', { message: 'Missing required fields - please fill in everything marked required and try again.' });
  if (looksLikeIconNotCommand(command)) {
    return res.status(400).render('error', { message: `"${command}" looks like an icon name, not a command - check the Command and Icon fields weren't swapped.` });
  }

  db.prepare(
    'UPDATE plan_actions SET label = ?, command = ?, icon = ?, style = ?, banner_time_estimate = ?, cooldown_hours = ? WHERE id = ? AND plan_id = ?'
  ).run(label, command, icon, style, bannerTimeEstimate, cooldownHours, req.params.actionId, req.params.id);

  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/actions/:actionId/delete', (req, res) => {
  db.prepare('DELETE FROM plan_actions WHERE id = ? AND plan_id = ?').run(req.params.actionId, req.params.id);
  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/actions/:actionId/toggle-enabled', (req, res) => {
  db.prepare('UPDATE plan_actions SET enabled = NOT enabled WHERE id = ? AND plan_id = ?').run(req.params.actionId, req.params.id);
  // A plan-wide change makes any existing per-user exception stale - clear
  // them so everyone follows the new state, rather than leaving an old
  // "force enabled" or "force disabled" override quietly still in effect.
  db.prepare('DELETE FROM user_disabled_actions WHERE plan_action_id = ?').run(req.params.actionId);
  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/actions/:actionId/move', (req, res) => {
  const direction = req.body.direction === 'up' ? 'up' : 'down';
  const actions = db.prepare('SELECT * FROM plan_actions WHERE plan_id = ? ORDER BY sort_order ASC, id ASC').all(req.params.id);
  const index = actions.findIndex((a) => a.id === Number(req.params.actionId));
  if (index === -1) return res.redirect('/admin/plans');

  const swapIndex = direction === 'up' ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= actions.length) return res.redirect('/admin/plans');

  const current = actions[index];
  const swap = actions[swapIndex];
  const update = db.prepare('UPDATE plan_actions SET sort_order = ? WHERE id = ?');
  update.run(swap.sort_order, current.id);
  update.run(current.sort_order, swap.id);

  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/containers', (req, res) => {
  const containerName = String(req.body.container_name || '').trim();
  const label = String(req.body.label || containerName).trim();
  const linkUrl = String(req.body.link_url || '').trim();

  if (!containerName) return res.status(400).render('error', { message: 'Missing required fields - please fill in everything marked required and try again.' });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName)) {
    return res.status(400).render('error', { message: 'Container name can only contain letters, numbers, dots, dashes, and underscores.' });
  }

  const maxOrder = db.prepare('SELECT MAX(sort_order) AS m FROM plan_containers WHERE plan_id = ?').get(req.params.id).m || 0;
  db.prepare('INSERT INTO plan_containers (plan_id, container_name, label, sort_order, link_url) VALUES (?, ?, ?, ?, ?)').run(
    req.params.id,
    containerName,
    label,
    maxOrder + 1,
    linkUrl || null
  );

  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/containers/:containerId/update', (req, res) => {
  const containerName = String(req.body.container_name || '').trim();
  const label = String(req.body.label || containerName).trim();
  const linkUrl = String(req.body.link_url || '').trim();

  if (!containerName) return res.status(400).render('error', { message: 'Missing required fields - please fill in everything marked required and try again.' });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName)) {
    return res.status(400).render('error', { message: 'Container name can only contain letters, numbers, dots, dashes, and underscores.' });
  }

  db.prepare('UPDATE plan_containers SET container_name = ?, label = ?, link_url = ? WHERE id = ? AND plan_id = ?').run(
    containerName,
    label,
    linkUrl || null,
    req.params.containerId,
    req.params.id
  );

  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/containers/:containerId/delete', (req, res) => {
  db.prepare('DELETE FROM plan_containers WHERE id = ? AND plan_id = ?').run(req.params.containerId, req.params.id);
  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/containers/:containerId/move', (req, res) => {
  const direction = req.body.direction === 'up' ? 'up' : 'down';
  const containers = db.prepare('SELECT * FROM plan_containers WHERE plan_id = ? ORDER BY sort_order ASC, id ASC').all(req.params.id);
  const index = containers.findIndex((c) => c.id === Number(req.params.containerId));
  if (index === -1) return res.redirect('/admin/plans');

  const swapIndex = direction === 'up' ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= containers.length) return res.redirect('/admin/plans');

  const current = containers[index];
  const swap = containers[swapIndex];
  const update = db.prepare('UPDATE plan_containers SET sort_order = ? WHERE id = ?');
  update.run(swap.sort_order, current.id);
  update.run(current.sort_order, swap.id);

  res.redirect('/admin/plans');
});

// ---------- Minecraft Death Counter ----------

router.post('/admin/plans/:id/death-counter/toggle-enabled', (req, res) => {
  db.prepare('UPDATE plans SET death_counter_enabled = NOT death_counter_enabled WHERE id = ?').run(req.params.id);
  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/death-counter/title', (req, res) => {
  const title = String(req.body.death_counter_title || '').trim();
  db.prepare('UPDATE plans SET death_counter_title = ? WHERE id = ?').run(title || null, req.params.id);
  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/death-counter/players', (req, res) => {
  const playerName = String(req.body.player_name || '').trim();
  if (!playerName) return res.redirect('/admin/plans');
  db.prepare('INSERT INTO plan_death_counter_players (plan_id, player_name, death_count) VALUES (?, ?, 0)').run(req.params.id, playerName);
  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/death-counter/players/:playerId/increment', (req, res) => {
  db.prepare('UPDATE plan_death_counter_players SET death_count = death_count + 1 WHERE id = ? AND plan_id = ?').run(req.params.playerId, req.params.id);
  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/death-counter/players/:playerId/decrement', (req, res) => {
  // Deaths can't go negative - clamps at 0 rather than allowing an
  // accidental extra click to wrap into a nonsensical negative count.
  db.prepare('UPDATE plan_death_counter_players SET death_count = MAX(0, death_count - 1) WHERE id = ? AND plan_id = ?').run(req.params.playerId, req.params.id);
  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/death-counter/players/:playerId/update', (req, res) => {
  const playerName = String(req.body.player_name || '').trim();
  const deathCount = Math.max(0, parseInt(req.body.death_count, 10) || 0);
  if (!playerName) return res.redirect('/admin/plans');
  db.prepare('UPDATE plan_death_counter_players SET player_name = ?, death_count = ? WHERE id = ? AND plan_id = ?').run(playerName, deathCount, req.params.playerId, req.params.id);
  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/death-counter/players/:playerId/delete', (req, res) => {
  db.prepare('DELETE FROM plan_death_counter_players WHERE id = ? AND plan_id = ?').run(req.params.playerId, req.params.id);
  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/run-timer/link', (req, res) => {
  const actionId = req.body.action_id ? Number(req.body.action_id) : null;
  // Only actually link if the action genuinely belongs to this plan -
  // otherwise a stray/forged id could point the timer at another plan's
  // action entirely.
  if (actionId) {
    const action = db.prepare('SELECT id FROM plan_actions WHERE id = ? AND plan_id = ?').get(actionId, req.params.id);
    if (!action) return res.redirect('/admin/plans');
  }
  db.prepare('UPDATE plans SET run_timer_linked_action_id = ? WHERE id = ?').run(actionId, req.params.id);
  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/run-timer/link-container-action', (req, res) => {
  const actionId = req.body.container_action_id ? Number(req.body.container_action_id) : null;
  // Container actions aren't scoped to a plan the way plan_actions are -
  // just confirm the id genuinely exists rather than checking ownership.
  if (actionId) {
    const action = db.prepare('SELECT id FROM admin_container_actions WHERE id = ?').get(actionId);
    if (!action) return res.redirect('/admin/plans');
  }
  db.prepare('UPDATE plans SET run_timer_linked_container_action_id = ? WHERE id = ?').run(actionId, req.params.id);
  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/run-timer/start', (req, res) => {
  startTimer(req.params.id);
  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/run-timer/stop', (req, res) => {
  stopTimer(req.params.id);
  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/run-timer/restart', (req, res) => {
  restartTimer(req.params.id);
  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/bosses/toggle-enabled', (req, res) => {
  db.prepare('UPDATE plans SET bosses_beaten_enabled = NOT bosses_beaten_enabled WHERE id = ?').run(req.params.id);
  res.redirect('/admin/plans');
});

router.post('/admin/plans/:id/bosses/:bossKey/toggle', (req, res) => {
  const column = columnForBossKey(req.params.bossKey);
  if (!column) return res.redirect('/admin/plans'); // unrecognized key - ignore rather than error, since this can only happen from a tampered request anyway
  // Column name comes from the fixed whitelist above, never from request
  // input directly, so this interpolation is safe despite not being a
  // bound parameter - SQL doesn't support parameterizing column names.
  db.prepare(`UPDATE plans SET ${column} = NOT ${column} WHERE id = ?`).run(req.params.id);
  res.redirect('/admin/plans');
});



const STORAGE_COLORS = ['sky', 'amber', 'emerald', 'violet', 'rose', 'cyan', 'fuchsia', 'lime'];

// Guards against a field arriving as an array when only a single value
// was ever intended (e.g. two same-named inputs both submitted because a
// disabled-toggle didn't apply) - String(['', '']) silently produces the
// non-empty string "," rather than throwing, which is exactly the kind
// of bug that can overwrite a working credential with garbage. This
// takes the first genuinely non-empty entry instead of joining them.
function singleFieldValue(value) {
  if (Array.isArray(value)) return value.find((v) => v && String(v).trim()) || '';
  return value;
}

function loadStorageLists() {
  const buckets = db.prepare('SELECT id, label, endpoint, region, bucket_name, force_path_style, total_capacity_bytes, color, created_at FROM storage_buckets ORDER BY created_at ASC').all();
  const sftpBoxes = db.prepare('SELECT id, label, host, port, username, auth_type, root_path, total_capacity_bytes, color, created_at FROM sftp_storage_boxes ORDER BY created_at ASC').all();
  return { buckets, sftpBoxes };
}

router.get('/admin/storage', (req, res) => {
  res.render('admin-storage', { ...loadStorageLists(), addResult: null });
});

router.post('/admin/storage/bucket', async (req, res) => {
  const label = String(req.body.label || '').trim();
  const endpoint = String(req.body.endpoint || '').trim();
  const region = String(req.body.region || '').trim() || 'auto';
  const bucketName = String(req.body.bucket_name || '').trim();
  const accessKey = String(req.body.access_key || '').trim();
  const secretKey = String(req.body.secret_key || '').trim();
  const forcePathStyle = req.body.force_path_style === 'on' || req.body.force_path_style === '1';
  const totalCapacityGb = Number(req.body.total_capacity_gb);
  const totalCapacityBytes = totalCapacityGb > 0 ? Math.round(totalCapacityGb * 1024 * 1024 * 1024) : null;
  const color = STORAGE_COLORS.includes(req.body.color) ? req.body.color : 'sky';

  if (!label || !endpoint || !bucketName || !accessKey || !secretKey) {
    return res.status(400).render('admin-storage', { ...loadStorageLists(), addResult: { ok: false, message: 'All fields except region and total capacity are required.' } });
  }

  // Tested before saving, so a typo in the endpoint or a bad key doesn't
  // silently get stored as if it worked, only to fail the first time
  // someone actually tries to browse it.
  const testBucket = {
    endpoint,
    region,
    bucket_name: bucketName,
    access_key_encrypted: encrypt(accessKey),
    secret_key_encrypted: encrypt(secretKey),
    force_path_style: forcePathStyle ? 1 : 0,
  };
  const testResult = await s3.testConnection(testBucket);
  if (!testResult.ok) {
    return res.status(400).render('admin-storage', { ...loadStorageLists(), addResult: { ok: false, message: 'Could not connect: ' + testResult.message } });
  }

  db.prepare(
    'INSERT INTO storage_buckets (label, endpoint, region, bucket_name, access_key_encrypted, secret_key_encrypted, force_path_style, total_capacity_bytes, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(label, endpoint, region, bucketName, testBucket.access_key_encrypted, testBucket.secret_key_encrypted, testBucket.force_path_style, totalCapacityBytes, color);

  res.render('admin-storage', { ...loadStorageLists(), addResult: { ok: true, message: `${label} connected successfully.` } });
});

router.post('/admin/storage/bucket/:id/update', async (req, res) => {
  const existing = db.prepare('SELECT * FROM storage_buckets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, message: 'Bucket not found.' });

  const label = String(req.body.label || '').trim();
  const endpoint = String(req.body.endpoint || '').trim();
  const region = String(req.body.region || '').trim() || 'auto';
  const bucketName = String(req.body.bucket_name || '').trim();
  const accessKey = String(req.body.access_key || '').trim();
  const secretKey = String(req.body.secret_key || '').trim();
  const forcePathStyle = req.body.force_path_style === 'on' || req.body.force_path_style === '1';
  const totalCapacityGb = Number(req.body.total_capacity_gb);
  const totalCapacityBytes = totalCapacityGb > 0 ? Math.round(totalCapacityGb * 1024 * 1024 * 1024) : null;
  const color = STORAGE_COLORS.includes(req.body.color) ? req.body.color : existing.color;

  if (!label || !endpoint || !bucketName) {
    return res.status(400).json({ ok: false, message: 'Label, endpoint, and bucket name are required.' });
  }

  // Credentials are optional on edit - blank means "keep the existing
  // ones" rather than forcing them to be re-entered every time just to
  // change the display name or color.
  const accessKeyEncrypted = accessKey ? encrypt(accessKey) : existing.access_key_encrypted;
  const secretKeyEncrypted = secretKey ? encrypt(secretKey) : existing.secret_key_encrypted;

  const testBucket = {
    endpoint,
    region,
    bucket_name: bucketName,
    access_key_encrypted: accessKeyEncrypted,
    secret_key_encrypted: secretKeyEncrypted,
    force_path_style: forcePathStyle ? 1 : 0,
  };
  const testResult = await s3.testConnection(testBucket);
  if (!testResult.ok) {
    return res.status(400).json({ ok: false, message: 'Could not connect: ' + testResult.message });
  }

  db.prepare(
    'UPDATE storage_buckets SET label = ?, endpoint = ?, region = ?, bucket_name = ?, access_key_encrypted = ?, secret_key_encrypted = ?, force_path_style = ?, total_capacity_bytes = ?, color = ? WHERE id = ?'
  ).run(label, endpoint, region, bucketName, accessKeyEncrypted, secretKeyEncrypted, testBucket.force_path_style, totalCapacityBytes, color, req.params.id);

  res.json({ ok: true });
});

router.post('/admin/storage/bucket/:id/bulk-delete', async (req, res) => {
  const bucket = db.prepare('SELECT * FROM storage_buckets WHERE id = ?').get(req.params.id);
  if (!bucket) return res.status(404).json({ ok: false, message: 'Bucket not found.' });
  const keys = Array.isArray(req.body.keys) ? req.body.keys : [req.body.keys].filter(Boolean);
  if (keys.length === 0) return res.status(400).json({ ok: false, message: 'Nothing selected.' });

  const failed = [];
  for (const key of keys) {
    try {
      if (key.endsWith('/')) {
        await s3.deleteFolder(bucket, key);
      } else {
        await s3.deleteObject(bucket, key);
      }
    } catch (err) {
      failed.push(key);
    }
  }

  if (failed.length > 0) return res.status(500).json({ ok: false, message: `${failed.length} of ${keys.length} item(s) could not be deleted.`, failed });
  res.json({ ok: true, deleted: keys.length });
});

router.post('/admin/storage/bucket/:id/bulk-move', async (req, res) => {
  const bucket = db.prepare('SELECT * FROM storage_buckets WHERE id = ?').get(req.params.id);
  if (!bucket) return res.status(404).json({ ok: false, message: 'Bucket not found.' });
  const keys = Array.isArray(req.body.keys) ? req.body.keys : [req.body.keys].filter(Boolean);
  const destination = String(req.body.destination || '').trim();
  if (keys.length === 0) return res.status(400).json({ ok: false, message: 'Nothing selected.' });
  if (!destination) return res.status(400).json({ ok: false, message: 'Destination folder is required.' });

  const destPrefix = destination.endsWith('/') ? destination : destination + '/';
  const failed = [];
  for (const key of keys) {
    try {
      if (key.endsWith('/')) {
        // A moved folder keeps its own name as a subfolder of the
        // destination, rather than dumping its contents flat into
        // whatever's already there - matching how a normal file manager
        // handles dragging a folder into another folder.
        const name = key.replace(/\/+$/, '').split('/').pop();
        await s3.moveFolder(bucket, key, destPrefix + name);
      } else {
        const filename = key.split('/').pop();
        await s3.renameObject(bucket, key, destPrefix + filename);
      }
    } catch (err) {
      failed.push(key);
    }
  }

  if (failed.length > 0) return res.status(500).json({ ok: false, message: `${failed.length} of ${keys.length} item(s) could not be moved.`, failed });
  res.json({ ok: true, moved: keys.length });
});

router.post('/admin/storage/bucket/:id/delete', (req, res) => {
  db.prepare('DELETE FROM storage_buckets WHERE id = ?').run(req.params.id);
  res.redirect('/admin/storage');
});

router.get('/admin/storage/bucket/:id', (req, res) => {
  const bucket = db.prepare('SELECT id, label, endpoint, region, bucket_name, total_capacity_bytes, color, created_at FROM storage_buckets WHERE id = ?').get(req.params.id);
  if (!bucket) return res.status(404).render('error', { message: 'Bucket not found.' });
  res.render('admin-storage-detail', { item: bucket, type: 'bucket' });
});

router.get('/admin/storage/bucket/:id/list', async (req, res) => {
  const bucket = db.prepare('SELECT * FROM storage_buckets WHERE id = ?').get(req.params.id);
  if (!bucket) return res.status(404).json({ ok: false, message: 'Bucket not found.' });

  try {
    const result = await s3.listObjects(bucket, req.query.prefix || '', req.query.token || undefined);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

router.get('/admin/storage/bucket/:id/stats', async (req, res) => {
  const bucket = db.prepare('SELECT * FROM storage_buckets WHERE id = ?').get(req.params.id);
  if (!bucket) return res.status(404).json({ ok: false, message: 'Bucket not found.' });

  try {
    const stats = await s3.getBucketStats(bucket);
    const remainingBytes = bucket.total_capacity_bytes ? Math.max(0, bucket.total_capacity_bytes - stats.totalSize) : null;
    res.json({
      ok: true,
      totalSize: stats.totalSize,
      totalSizeFormatted: s3.formatBytes(stats.totalSize),
      totalCount: stats.totalCount,
      isComplete: stats.isComplete,
      totalCapacityBytes: bucket.total_capacity_bytes,
      totalCapacityFormatted: bucket.total_capacity_bytes ? s3.formatBytes(bucket.total_capacity_bytes) : null,
      remainingBytes,
      remainingFormatted: remainingBytes !== null ? s3.formatBytes(remainingBytes) : null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

router.post('/admin/storage/bucket/:id/delete-file', async (req, res) => {
  const bucket = db.prepare('SELECT * FROM storage_buckets WHERE id = ?').get(req.params.id);
  if (!bucket) return res.status(404).json({ ok: false, message: 'Bucket not found.' });
  const key = String(req.body.key || '');
  if (!key) return res.status(400).json({ ok: false, message: 'No file specified.' });

  try {
    await s3.deleteObject(bucket, key);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

router.post('/admin/storage/bucket/:id/rename-file', async (req, res) => {
  const bucket = db.prepare('SELECT * FROM storage_buckets WHERE id = ?').get(req.params.id);
  if (!bucket) return res.status(404).json({ ok: false, message: 'Bucket not found.' });
  const oldKey = String(req.body.old_key || '');
  const newKey = String(req.body.new_key || '');
  if (!oldKey || !newKey) return res.status(400).json({ ok: false, message: 'Both the current and new name are required.' });

  try {
    await s3.renameObject(bucket, oldKey, newKey);
    res.json({ ok: true, key: newKey });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

router.get('/admin/storage/bucket/:id/download', async (req, res) => {
  const bucket = db.prepare('SELECT * FROM storage_buckets WHERE id = ?').get(req.params.id);
  if (!bucket) return res.status(404).json({ ok: false, message: 'Bucket not found.' });
  const key = String(req.query.key || '');
  if (!key) return res.status(400).json({ ok: false, message: 'No file specified.' });

  try {
    const url = await s3.getDownloadUrl(bucket, key);
    res.json({ ok: true, url });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

router.post('/admin/storage/bucket/:id/upload', (req, res) => {
  bucketUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, message: err.message });

    const bucket = db.prepare('SELECT * FROM storage_buckets WHERE id = ?').get(req.params.id);
    if (!bucket) return res.status(404).json({ ok: false, message: 'Bucket not found.' });
    if (!req.file) return res.status(400).json({ ok: false, message: 'No file provided.' });

    const prefix = String(req.body.prefix || '');
    const key = prefix + req.file.originalname;

    try {
      await s3.uploadObject(bucket, key, req.file.buffer, req.file.mimetype);
      res.json({ ok: true, key });
    } catch (uploadErr) {
      res.status(500).json({ ok: false, message: uploadErr.message });
    }
  });
});

// ---- SFTP Storage Boxes ----

router.post('/admin/storage/sftp', async (req, res) => {
  const label = String(req.body.label || '').trim();
  const host = String(req.body.host || '').trim();
  const port = Number(req.body.port) || 22;
  const username = String(req.body.username || '').trim();
  const authType = req.body.auth_type === 'key' ? 'key' : 'password';
  const secret = String(singleFieldValue(req.body.secret) || '').trim();
  const rootPath = String(req.body.root_path || '/').trim() || '/';
  const totalCapacityGb = Number(req.body.total_capacity_gb);
  const totalCapacityBytes = totalCapacityGb > 0 ? Math.round(totalCapacityGb * 1024 * 1024 * 1024) : null;
  const color = STORAGE_COLORS.includes(req.body.color) ? req.body.color : 'amber';

  if (!label || !host || !username || !secret) {
    return res.status(400).render('admin-storage', { ...loadStorageLists(), addResult: { ok: false, message: 'Label, host, username, and password/key are all required.' } });
  }

  const testBox = { host, port, username, auth_type: authType, secret_encrypted: encrypt(secret), root_path: rootPath };
  const testResult = await sftpStorage.testConnection(testBox);
  if (!testResult.ok) {
    return res.status(400).render('admin-storage', { ...loadStorageLists(), addResult: { ok: false, message: 'Could not connect: ' + testResult.message } });
  }

  db.prepare(
    'INSERT INTO sftp_storage_boxes (label, host, port, username, auth_type, secret_encrypted, root_path, total_capacity_bytes, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(label, host, port, username, authType, testBox.secret_encrypted, rootPath, totalCapacityBytes, color);

  res.render('admin-storage', { ...loadStorageLists(), addResult: { ok: true, message: `${label} connected successfully.` } });
});

router.post('/admin/storage/sftp/:id/update', async (req, res) => {
  const existing = db.prepare('SELECT * FROM sftp_storage_boxes WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, message: 'Storage box not found.' });

  const label = String(req.body.label || '').trim();
  const host = String(req.body.host || '').trim();
  const port = Number(req.body.port) || 22;
  const username = String(req.body.username || '').trim();
  const authType = req.body.auth_type === 'key' ? 'key' : 'password';
  const secret = String(singleFieldValue(req.body.secret) || '').trim();
  const rootPath = String(req.body.root_path || '/').trim() || '/';
  const totalCapacityGb = Number(req.body.total_capacity_gb);
  const totalCapacityBytes = totalCapacityGb > 0 ? Math.round(totalCapacityGb * 1024 * 1024 * 1024) : null;
  const color = STORAGE_COLORS.includes(req.body.color) ? req.body.color : existing.color;

  if (!label || !host || !username) {
    return res.status(400).json({ ok: false, message: 'Label, host, and username are required.' });
  }

  // Password/key is optional on edit - blank means "keep the existing
  // secret" rather than forcing a re-entry just to rename or recolor.
  const secretEncrypted = secret ? encrypt(secret) : existing.secret_encrypted;

  const testBox = { host, port, username, auth_type: authType, secret_encrypted: secretEncrypted, root_path: rootPath };
  const testResult = await sftpStorage.testConnection(testBox);
  if (!testResult.ok) {
    return res.status(400).json({ ok: false, message: 'Could not connect: ' + testResult.message });
  }

  db.prepare(
    'UPDATE sftp_storage_boxes SET label = ?, host = ?, port = ?, username = ?, auth_type = ?, secret_encrypted = ?, root_path = ?, total_capacity_bytes = ?, color = ? WHERE id = ?'
  ).run(label, host, port, username, authType, secretEncrypted, rootPath, totalCapacityBytes, color, req.params.id);

  res.json({ ok: true });
});

router.post('/admin/storage/sftp/:id/bulk-delete', async (req, res) => {
  const box = db.prepare('SELECT * FROM sftp_storage_boxes WHERE id = ?').get(req.params.id);
  if (!box) return res.status(404).json({ ok: false, message: 'Storage box not found.' });
  const keys = Array.isArray(req.body.keys) ? req.body.keys : [req.body.keys].filter(Boolean);
  if (keys.length === 0) return res.status(400).json({ ok: false, message: 'Nothing selected.' });

  const failed = [];
  for (const key of keys) {
    try {
      if (key.endsWith('/')) {
        await sftpStorage.deleteFolder(box, key);
      } else {
        await sftpStorage.deleteObject(box, key);
      }
    } catch (err) {
      failed.push(key);
    }
  }

  if (failed.length > 0) return res.status(500).json({ ok: false, message: `${failed.length} of ${keys.length} item(s) could not be deleted.`, failed });
  res.json({ ok: true, deleted: keys.length });
});

router.post('/admin/storage/sftp/:id/bulk-move', async (req, res) => {
  const box = db.prepare('SELECT * FROM sftp_storage_boxes WHERE id = ?').get(req.params.id);
  if (!box) return res.status(404).json({ ok: false, message: 'Storage box not found.' });
  const keys = Array.isArray(req.body.keys) ? req.body.keys : [req.body.keys].filter(Boolean);
  const destination = String(req.body.destination || '').trim();
  if (keys.length === 0) return res.status(400).json({ ok: false, message: 'Nothing selected.' });
  if (!destination) return res.status(400).json({ ok: false, message: 'Destination folder is required.' });

  const destPrefix = destination.endsWith('/') ? destination : destination + '/';
  const failed = [];
  for (const key of keys) {
    try {
      if (key.endsWith('/')) {
        // SFTP's rename works natively on directories - a moved folder
        // keeps its own name as a subfolder of the destination, matching
        // how a normal file manager handles this, rather than merging
        // its contents flat into whatever's already there.
        const name = key.replace(/\/+$/, '').split('/').pop();
        await sftpStorage.renameObject(box, key, destPrefix + name);
      } else {
        const filename = key.split('/').pop();
        await sftpStorage.renameObject(box, key, destPrefix + filename);
      }
    } catch (err) {
      failed.push(key);
    }
  }

  if (failed.length > 0) return res.status(500).json({ ok: false, message: `${failed.length} of ${keys.length} item(s) could not be moved.`, failed });
  res.json({ ok: true, moved: keys.length });
});

router.post('/admin/storage/sftp/:id/delete', (req, res) => {
  db.prepare('DELETE FROM sftp_storage_boxes WHERE id = ?').run(req.params.id);
  res.redirect('/admin/storage');
});

router.get('/admin/storage/sftp/:id', (req, res) => {
  const box = db.prepare('SELECT id, label, host, port, username, root_path, total_capacity_bytes, color, created_at FROM sftp_storage_boxes WHERE id = ?').get(req.params.id);
  if (!box) return res.status(404).render('error', { message: 'Storage box not found.' });
  res.render('admin-storage-detail', { item: box, type: 'sftp' });
});

router.get('/admin/storage/sftp/:id/list', async (req, res) => {
  const box = db.prepare('SELECT * FROM sftp_storage_boxes WHERE id = ?').get(req.params.id);
  if (!box) return res.status(404).json({ ok: false, message: 'Storage box not found.' });

  try {
    const result = await sftpStorage.listObjects(box, req.query.prefix || box.root_path);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

router.get('/admin/storage/sftp/:id/stats', async (req, res) => {
  const box = db.prepare('SELECT * FROM sftp_storage_boxes WHERE id = ?').get(req.params.id);
  if (!box) return res.status(404).json({ ok: false, message: 'Storage box not found.' });

  try {
    const stats = await sftpStorage.getBucketStats(box);
    const remainingBytes = box.total_capacity_bytes ? Math.max(0, box.total_capacity_bytes - stats.totalSize) : null;
    res.json({
      ok: true,
      totalSize: stats.totalSize,
      totalSizeFormatted: s3.formatBytes(stats.totalSize),
      totalCount: stats.totalCount,
      isComplete: stats.isComplete,
      totalCapacityBytes: box.total_capacity_bytes,
      totalCapacityFormatted: box.total_capacity_bytes ? s3.formatBytes(box.total_capacity_bytes) : null,
      remainingBytes,
      remainingFormatted: remainingBytes !== null ? s3.formatBytes(remainingBytes) : null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

router.post('/admin/storage/sftp/:id/delete-file', async (req, res) => {
  const box = db.prepare('SELECT * FROM sftp_storage_boxes WHERE id = ?').get(req.params.id);
  if (!box) return res.status(404).json({ ok: false, message: 'Storage box not found.' });
  const key = String(req.body.key || '');
  if (!key) return res.status(400).json({ ok: false, message: 'No file specified.' });

  try {
    await sftpStorage.deleteObject(box, key);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

router.post('/admin/storage/sftp/:id/rename-file', async (req, res) => {
  const box = db.prepare('SELECT * FROM sftp_storage_boxes WHERE id = ?').get(req.params.id);
  if (!box) return res.status(404).json({ ok: false, message: 'Storage box not found.' });
  const oldKey = String(req.body.old_key || '');
  const newKey = String(req.body.new_key || '');
  if (!oldKey || !newKey) return res.status(400).json({ ok: false, message: 'Both the current and new name are required.' });

  try {
    await sftpStorage.renameObject(box, oldKey, newKey);
    res.json({ ok: true, key: newKey });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

router.get('/admin/storage/sftp/:id/download', async (req, res) => {
  const box = db.prepare('SELECT * FROM sftp_storage_boxes WHERE id = ?').get(req.params.id);
  if (!box) return res.status(404).json({ ok: false, message: 'Storage box not found.' });
  const key = String(req.query.key || '');
  if (!key) return res.status(400).send('No file specified.');

  try {
    const buffer = await sftpStorage.downloadObject(box, key);
    const filename = key.split('/').pop();
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Could not download that file: ' + err.message);
  }
});

router.post('/admin/storage/sftp/:id/upload', (req, res) => {
  bucketUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, message: err.message });

    const box = db.prepare('SELECT * FROM sftp_storage_boxes WHERE id = ?').get(req.params.id);
    if (!box) return res.status(404).json({ ok: false, message: 'Storage box not found.' });
    if (!req.file) return res.status(400).json({ ok: false, message: 'No file provided.' });

    const prefix = String(req.body.prefix || box.root_path);
    const key = prefix.replace(/\/+$/, '') + '/' + req.file.originalname;

    try {
      await sftpStorage.uploadObject(box, key, req.file.buffer);
      res.json({ ok: true, key });
    } catch (uploadErr) {
      res.status(500).json({ ok: false, message: uploadErr.message });
    }
  });
});

// ---------- Users ----------

router.get('/admin/users', async (req, res) => {
  res.render('admin-users', { ...loadUsersPageData(), newUser: null });
});

router.post('/admin/users/invite', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').toLowerCase().trim();
  const planId = req.body.plan_id ? Number(req.body.plan_id) : null;
  const paymentMethodId = req.body.payment_method_id ? Number(req.body.payment_method_id) : null;
  const expiresAt = String(req.body.expires_at || '').trim() || null;
  const renewalMode = ['auto', 'manual', 'expired'].includes(req.body.renewal_mode) ? req.body.renewal_mode : 'manual';

  if (!name || !email) return res.status(400).render('error', { message: 'Missing required fields - please fill in everything marked required and try again.' });

  const tempPassword = generateTempPassword();
  const hash = bcrypt.hashSync(tempPassword, 12);

  try {
    const info = db
      .prepare(
        `INSERT INTO users (name, email, password_hash, role, must_change_password, payment_method_id) VALUES (?, ?, ?, 'subscriber', 1, ?)`
      )
      .run(name, email, hash, paymentMethodId);

    if (planId) {
      const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
      if (plan) {
        const status = renewalMode === 'expired' ? 'expired' : 'active';
        db.prepare(
          `INSERT INTO subscriptions (user_id, plan_id, service, plan_name, status, renewal_mode, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(info.lastInsertRowid, plan.id, plan.service, plan.name, status, renewalMode, expiresAt);
        syncIncludedPlansForUser(info.lastInsertRowid);
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
  if (!plan) return res.status(400).render('error', { message: 'Missing required fields - please fill in everything marked required and try again.' });

  const existing = db.prepare('SELECT * FROM subscriptions WHERE user_id = ? AND plan_id = ?').get(req.params.id, plan.id);

  // This plan is already being granted automatically because of another
  // plan this person has - managing it here would fight with that, so
  // this is blocked with an explanation rather than silently creating a
  // second, conflicting record. To change their access to it, adjust
  // which plans grant it from the plan's own settings instead.
  if (existing && existing.auto_granted_via_plan_id) {
    return res.status(400).render('error', {
      message: `${plan.name} is already automatically included for this user through one of their other active plans, so it can't be assigned separately here. To change this, edit which plans include ${plan.name} from Admin → Plans instead.`,
    });
  }

  const mode = ['auto', 'manual', 'expired'].includes(renewal_mode) ? renewal_mode : 'manual';
  // Choosing "Mark as Expired" as the renewal mode is a direct instruction
  // to expire the subscription now, regardless of what status was picked.
  const finalStatus = mode === 'expired' ? 'expired' : status;

  if (existing) {
    db.prepare(
      `UPDATE subscriptions SET service = ?, plan_name = ?, status = ?, renewal_mode = ?, expires_at = ?, notes = ?, expiry_warning_sent_at = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(plan.service, plan.name, finalStatus, mode, expires_at || null, notes || null, existing.id);
  } else {
    db.prepare(
      `INSERT INTO subscriptions (user_id, plan_id, service, plan_name, status, renewal_mode, expires_at, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(req.params.id, plan.id, plan.service, plan.name, finalStatus, mode, expires_at || null, notes || null);
  }

  syncIncludedPlansForUser(req.params.id);

  res.redirect('/admin/users');
});

router.post('/admin/users/:id/subscription/:subId/delete', (req, res) => {
  db.prepare('DELETE FROM subscriptions WHERE id = ? AND user_id = ?').run(req.params.subId, req.params.id);
  syncIncludedPlansForUser(req.params.id);
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

router.post('/admin/users/:id/reset-timers', (req, res) => {
  db.prepare('DELETE FROM action_log WHERE user_id = ?').run(req.params.id);
  res.redirect('/admin/users');
});

router.post('/admin/users/:id/update', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').toLowerCase().trim();
  if (!name || !email) return res.status(400).render('error', { message: 'Missing required fields - please fill in everything marked required and try again.' });

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

router.post('/admin/users/:id/plex-username', (req, res) => {
  const plexUsername = String(req.body.plex_username || '').trim() || null;
  db.prepare('UPDATE users SET plex_username = ? WHERE id = ?').run(plexUsername, req.params.id);
  res.redirect('/admin/users');
});

router.post('/admin/users/:id/actions/:actionId/toggle-enabled', (req, res) => {
  const action = db.prepare('SELECT * FROM plan_actions WHERE id = ?').get(req.params.actionId);
  if (!action) return res.redirect('/admin/users');

  const existing = db.prepare('SELECT id FROM user_disabled_actions WHERE user_id = ? AND plan_action_id = ?').get(req.params.id, req.params.actionId);
  if (existing) {
    // An override already exists - removing it returns this user to
    // whatever the plan-wide state currently says, rather than the table
    // needing to track a third "explicitly follows the plan" state.
    db.prepare('DELETE FROM user_disabled_actions WHERE id = ?').run(existing.id);
  } else {
    // No override yet - create one that's the opposite of the plan's
    // current effective state for this user. If the plan is enabled, this
    // creates a "force disabled" exception; if the plan is disabled, this
    // creates a "force enabled" exception - the case the confirmation
    // popup on the frontend is specifically warning about.
    db.prepare('INSERT INTO user_disabled_actions (user_id, plan_action_id, enabled) VALUES (?, ?, ?)').run(req.params.id, req.params.actionId, action.enabled ? 0 : 1);
  }
  res.redirect('/admin/users');
});

// Lets admin view any subscriber's Plex activity directly from Admin →
// Users, without needing to be that subscriber - same underlying Tautulli
// calls the subscriber's own dashboard/watch-history pages use, just
// looked up by a specific user id instead of req.user.

router.get('/admin/users/:id/plex/history', async (req, res) => {
  const user = db.prepare('SELECT plex_username FROM users WHERE id = ?').get(req.params.id);
  const settings = getAllSettings();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const result = await getWatchHistory(settings.tautulli_url, settings.tautulli_api_key, user ? user.plex_username : null, page, 10);

  if (result.ok) {
    result.items = result.items.map((item) => ({
      ...item,
      watchedAtLabel: item.watchedAtIso ? formatUK(item.watchedAtIso) : '',
    }));
  }

  res.json(result);
});

router.get('/admin/users/:id/plex/now-watching', async (req, res) => {
  const user = db.prepare('SELECT plex_username FROM users WHERE id = ?').get(req.params.id);
  const settings = getAllSettings();

  const result = await getNowWatching(settings.tautulli_url, settings.tautulli_api_key, user ? user.plex_username : null);

  if (result.ok) {
    result.items = await Promise.all(
      result.items.map(async (item) => ({
        ...item,
        posterUrl: item.posterPath ? `/admin/plex/poster?path=${encodeURIComponent(item.posterPath)}` : null,
        location: await getGeoLookup(settings.tautulli_url, settings.tautulli_api_key, item.ipAddress),
      }))
    );
  }

  res.json(result);
});

router.get('/admin/plex/poster', async (req, res) => {
  const path = String(req.query.path || '');
  if (!/^\/library\/metadata\/[a-zA-Z0-9/_.-]+$/.test(path) || path.includes('..')) {
    return res.status(400).end();
  }

  const settings = getAllSettings();
  const image = await fetchPosterImage(settings.tautulli_url, settings.tautulli_api_key, path);
  if (!image) return res.status(404).end();

  res.setHeader('Content-Type', image.contentType);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(image.buffer);
});

// Every active Plex session right now, system-wide, for the "Now Watching"
// button on the admin overview page - one Tautulli call covers everyone,
// then each session gets matched back to a portal account (by Plex
// username, falling back to Plex's own display name) so admin sees who
// it actually is, not just a raw Plex account.
router.get('/admin/plex/now-watching-all', async (req, res) => {
  const settings = getAllSettings();
  const result = await getAllActivity(settings.tautulli_url, settings.tautulli_api_key);
  if (!result.ok) return res.json(result);

  const linkedUsers = db.prepare("SELECT id, name, email, plex_username FROM users WHERE role = 'subscriber' AND plex_username IS NOT NULL").all();

  const items = await Promise.all(
    result.items.map(async (item) => {
      const match = linkedUsers.find((u) => u.plex_username === item.plexUser || u.plex_username === item.plexFriendlyName);
      return {
        ...item,
        // Falls back to whatever Plex itself calls them if this session
        // isn't tied to a portal account (e.g. the admin's own personal
        // Plex login, or a friend never invited through this portal).
        subscriberName: match ? match.name : (item.plexFriendlyName || item.plexUser || 'Unknown'),
        subscriberEmail: match ? match.email : null,
        posterUrl: item.posterPath ? `/admin/plex/poster?path=${encodeURIComponent(item.posterPath)}` : null,
        location: await getGeoLookup(settings.tautulli_url, settings.tautulli_api_key, item.ipAddress),
      };
    })
  );

  res.json({ ok: true, items });
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

router.post('/admin/tickets/:id/delete', (req, res) => {
  db.prepare('DELETE FROM tickets WHERE id = ?').run(req.params.id);
  res.redirect('/admin/tickets');
});

// ---------- Settings (General, Branding, Mail, Health SSH, Payment Methods) ----------

router.get('/admin/settings', (req, res) => {
  res.render('admin-settings', { ...loadSettingsPageData(), saved: null, testResult: null, brandingError: null, adminActionResult: null });
});

const ADMIN_PAGE_KEYS = ['overview', 'users', 'plans', 'health', 'settings', 'tickets', 'storage'];

router.post('/admin/admins/invite', requireFullAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').toLowerCase().trim();
  const accessMode = req.body.access_mode === 'limited' ? 'limited' : 'full';
  const pages = (Array.isArray(req.body.pages) ? req.body.pages : [req.body.pages].filter(Boolean)).filter((p) => ADMIN_PAGE_KEYS.includes(p));

  if (!name || !email) {
    return res.status(400).render('admin-settings', { ...loadSettingsPageData(), saved: null, testResult: null, brandingError: null, adminActionResult: { ok: false, message: 'Name and email are required.' } });
  }

  const tempPassword = generateTempPassword();
  const hash = bcrypt.hashSync(tempPassword, 12);

  try {
    const info = db
      .prepare(`INSERT INTO users (name, email, password_hash, role, must_change_password, admin_access_mode) VALUES (?, ?, ?, 'admin', 1, ?)`)
      .run(name, email, hash, accessMode);

    if (accessMode === 'limited' && pages.length > 0) {
      const insertAccess = db.prepare('INSERT INTO admin_page_access (user_id, page_key) VALUES (?, ?)');
      pages.forEach((p) => insertAccess.run(info.lastInsertRowid, p));
    }

    const siteName = getAllSettings().site_name;
    const loginUrl = `${getSiteBaseUrl(req)}/login`;
    const emailResult = await sendMail({
      to: email,
      subject: `You've been added as an admin on ${siteName}`,
      bodyHtml: `
        <p>Hi ${name},</p>
        <p>You've been given admin access on ${siteName}${accessMode === 'limited' ? ` (limited to: ${pages.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(', ') || 'nothing yet - ask for access to be granted'})` : ''}. Here are your sign-in details:</p>
        <p style="background:#0b1220;border-radius:10px;padding:16px;">
          <strong>Email:</strong> ${email}<br>
          <strong>Temporary password:</strong> ${tempPassword}
        </p>
        <p>You'll be asked to set your own password the first time you sign in.</p>
        <p><a href="${loginUrl}" style="display:inline-block;background:#0ea5e9;color:#0b0f1a;font-weight:700;padding:12px 20px;border-radius:10px;text-decoration:none;">Sign In</a></p>
      `,
    });

    res.render('admin-settings', {
      ...loadSettingsPageData(),
      saved: null,
      testResult: null,
      brandingError: null,
      adminActionResult: {
        ok: true,
        message: emailResult.sent
          ? `${name} invited as an admin - sign-in details emailed to ${email}.`
          : `${name} invited as an admin, but the email couldn't be sent (${emailResult.reason}). Temporary password: ${tempPassword}`,
      },
    });
  } catch (err) {
    const message = err.message.includes('UNIQUE') ? 'A user with that email already exists.' : 'Could not create admin.';
    res.status(400).render('admin-settings', { ...loadSettingsPageData(), saved: null, testResult: null, brandingError: null, adminActionResult: { ok: false, message } });
  }
});

router.post('/admin/admins/:id/access', requireFullAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  const accessMode = req.body.access_mode === 'limited' ? 'limited' : 'full';
  const pages = (Array.isArray(req.body.pages) ? req.body.pages : [req.body.pages].filter(Boolean)).filter((p) => ADMIN_PAGE_KEYS.includes(p));

  const target = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'admin'").get(targetId);
  if (!target) return res.status(404).render('error', { message: 'Admin not found.' });

  // Guard against ending up with nobody able to manage other admins at all.
  if (accessMode === 'limited') {
    const otherFullAdmins = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND admin_access_mode = 'full' AND id != ?").get(targetId).c;
    if (otherFullAdmins === 0) {
      return res.status(400).render('admin-settings', { ...loadSettingsPageData(), saved: null, testResult: null, brandingError: null, adminActionResult: { ok: false, message: "Can't remove full access from the last full-access admin - there'd be nobody left who could manage admin access at all." } });
    }
  }

  db.prepare('UPDATE users SET admin_access_mode = ? WHERE id = ?').run(accessMode, targetId);
  db.prepare('DELETE FROM admin_page_access WHERE user_id = ?').run(targetId);
  if (accessMode === 'limited' && pages.length > 0) {
    const insertAccess = db.prepare('INSERT INTO admin_page_access (user_id, page_key) VALUES (?, ?)');
    pages.forEach((p) => insertAccess.run(targetId, p));
  }

  res.render('admin-settings', { ...loadSettingsPageData(), saved: null, testResult: null, brandingError: null, adminActionResult: { ok: true, message: `Access updated for ${target.name}.` } });
});

router.post('/admin/admins/:id/delete', requireFullAdmin, (req, res) => {
  const targetId = Number(req.params.id);

  if (targetId === req.user.id) {
    return res.status(400).render('admin-settings', { ...loadSettingsPageData(), saved: null, testResult: null, brandingError: null, adminActionResult: { ok: false, message: "You can't remove your own admin account." } });
  }

  const target = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'admin'").get(targetId);
  if (!target) return res.status(404).render('error', { message: 'Admin not found.' });

  if (target.admin_access_mode === 'full') {
    const otherFullAdmins = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND admin_access_mode = 'full' AND id != ?").get(targetId).c;
    if (otherFullAdmins === 0) {
      return res.status(400).render('admin-settings', { ...loadSettingsPageData(), saved: null, testResult: null, brandingError: null, adminActionResult: { ok: false, message: "Can't remove the last full-access admin - there'd be nobody left who could manage anything." } });
    }
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(targetId); // admin_page_access rows cascade via ON DELETE CASCADE
  res.render('admin-settings', { ...loadSettingsPageData(), saved: null, testResult: null, brandingError: null, adminActionResult: { ok: true, message: `${target.name} removed as an admin.` } });
});

router.post('/admin/settings/general', (req, res) => {
  setSetting('site_name', String(req.body.site_name || 'KyberBOX').trim());
  setSetting('site_url', String(req.body.site_url || '').trim());
  res.render('admin-settings', { ...loadSettingsPageData(), saved: 'general', testResult: null, brandingError: null });
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

  res.render('admin-settings', { ...loadSettingsPageData(), saved: 'mail', testResult: null, brandingError: null });
});

router.post('/admin/settings/test-email', async (req, res) => {
  const result = await sendMail({
    to: req.user.email,
    subject: 'Test email from your portal',
    bodyHtml: `<p>If you're reading this, your SMTP settings are working correctly.</p>`,
  });
  res.render('admin-settings', { ...loadSettingsPageData(), saved: null, testResult: result, brandingError: null });
});

router.post('/admin/settings/branding', (req, res) => {
  brandingUpload(req, res, (err) => {
    if (err) {
      return res.status(400).render('admin-settings', { ...loadSettingsPageData(), saved: null, testResult: null, brandingError: err.message });
    }

    if (req.files && req.files.favicon && req.files.favicon[0]) {
      setSetting('favicon_path', `/uploads/${req.files.favicon[0].filename}`);
    }
    if (req.files && req.files.apple_icon && req.files.apple_icon[0]) {
      setSetting('apple_icon_path', `/uploads/${req.files.apple_icon[0].filename}`);
    }

    res.render('admin-settings', { ...loadSettingsPageData(), saved: 'branding', testResult: null, brandingError: null });
  });
});

router.post('/admin/settings/health-ssh', (req, res) => {
  const { host, port, username, auth_type, secret, compose_path } = req.body;
  if (!host || !username) return res.status(400).render('error', { message: 'Missing required fields - please fill in everything marked required and try again.' });

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
    if (!secret) return res.status(400).render('error', { message: 'Missing required fields - please fill in everything marked required and try again.' });
    db.prepare(
      `INSERT INTO admin_ssh (host, port, username, auth_type, secret_encrypted) VALUES (?, ?, ?, ?, ?)`
    ).run(host, port || 22, username, auth_type || 'password', encrypt(secret));
  }

  setSetting('compose_path', String(compose_path || '').trim());

  res.render('admin-settings', { ...loadSettingsPageData(), saved: 'health-ssh', testResult: null, brandingError: null });
});

router.post('/admin/settings/stuck-watch', (req, res) => {
  const containerName = String(req.body.container_name || '').trim();
  const serviceLabel = String(req.body.service_label || '').trim();
  const successMarker = String(req.body.success_marker || '').trim();

  if (!containerName || !serviceLabel || !successMarker) {
    return res.status(400).render('admin-settings', {
      ...loadSettingsPageData(),
      saved: null,
      testResult: null,
      brandingError: null,
      adminActionResult: { ok: false, message: 'Container name, display name, and success marker are all required.' },
    });
  }

  try {
    db.prepare('INSERT INTO stuck_watch_containers (container_name, service_label, success_marker) VALUES (?, ?, ?)').run(
      containerName,
      serviceLabel,
      successMarker
    );
    res.render('admin-settings', { ...loadSettingsPageData(), saved: 'stuck-watch', testResult: null, brandingError: null });
  } catch (err) {
    const message = err.message.includes('UNIQUE') ? `${containerName} is already being watched.` : 'Could not add that watch.';
    res.status(400).render('admin-settings', { ...loadSettingsPageData(), saved: null, testResult: null, brandingError: null, adminActionResult: { ok: false, message } });
  }
});

router.post('/admin/settings/stuck-watch/:id/delete', (req, res) => {
  db.prepare('DELETE FROM stuck_watch_containers WHERE id = ?').run(req.params.id);
  res.render('admin-settings', { ...loadSettingsPageData(), saved: 'stuck-watch', testResult: null, brandingError: null });
});

router.post('/admin/settings/vpn-watch', (req, res) => {
  const containerName = String(req.body.container_name || '').trim();
  const serviceLabel = String(req.body.service_label || '').trim();

  if (!containerName || !serviceLabel) {
    return res.status(400).render('admin-settings', {
      ...loadSettingsPageData(),
      saved: null,
      testResult: null,
      brandingError: null,
      adminActionResult: { ok: false, message: 'Container name and display name are both required.' },
    });
  }

  try {
    db.prepare('INSERT INTO vpn_watch_containers (container_name, service_label) VALUES (?, ?)').run(containerName, serviceLabel);
    res.render('admin-settings', { ...loadSettingsPageData(), saved: 'vpn-watch', testResult: null, brandingError: null });
  } catch (err) {
    const message = err.message.includes('UNIQUE') ? `${containerName} is already being watched.` : 'Could not add that watch.';
    res.status(400).render('admin-settings', { ...loadSettingsPageData(), saved: null, testResult: null, brandingError: null, adminActionResult: { ok: false, message } });
  }
});

router.post('/admin/settings/vpn-watch/:id/delete', (req, res) => {
  db.prepare('DELETE FROM vpn_watch_containers WHERE id = ?').run(req.params.id);
  res.render('admin-settings', { ...loadSettingsPageData(), saved: 'vpn-watch', testResult: null, brandingError: null });
});

// ---------- Email Watchdog Notifications ----------
// Home for provider expiry warnings' on/off switch, plus the newer
// container health watchdog - and intended as the landing spot for any
// further admin notification toggles added down the line, rather than
// each new one getting its own scattered section.

router.post('/admin/settings/provider-notifications', (req, res) => {
  setSetting('provider_expiry_notifications_enabled', req.body.enabled === '1' ? '1' : '0');
  res.render('admin-settings', { ...loadSettingsPageData(), saved: 'email-watchdog', testResult: null, brandingError: null });
});

router.post('/admin/settings/container-watchdog', (req, res) => {
  setSetting('container_watchdog_enabled', req.body.enabled === '1' ? '1' : '0');
  const mode = req.body.mode === 'selected' ? 'selected' : 'all';
  setSetting('container_watchdog_mode', mode);

  const ids = Array.isArray(req.body.container_ids) ? req.body.container_ids : [req.body.container_ids].filter(Boolean);
  db.prepare('DELETE FROM container_watchdog_selected').run();
  const insertSelected = db.prepare('INSERT OR IGNORE INTO container_watchdog_selected (container_id) VALUES (?)');
  ids.forEach((id) => { if (/^\d+$/.test(id)) insertSelected.run(Number(id)); });

  setSetting('vpn_watchdog_enabled', req.body.vpn_enabled === '1' ? '1' : '0');

  res.render('admin-settings', { ...loadSettingsPageData(), saved: 'email-watchdog', testResult: null, brandingError: null });
});

router.post('/admin/settings/payment-methods', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name) db.prepare('INSERT INTO payment_methods (name) VALUES (?)').run(name);
  res.render('admin-settings', { ...loadSettingsPageData(), saved: 'payment-method', testResult: null, brandingError: null });
});

router.post('/admin/settings/payment-methods/:id/delete', (req, res) => {
  db.prepare('DELETE FROM payment_methods WHERE id = ?').run(req.params.id);
  res.render('admin-settings', { ...loadSettingsPageData(), saved: null, testResult: null, brandingError: null });
});

router.post('/admin/settings/tautulli', (req, res) => {
  const { tautulli_url, tautulli_api_key } = req.body;

  setSetting('tautulli_url', String(tautulli_url || '').trim());
  // Only overwrite the stored key if a new one was actually typed in - the
  // settings form always shows this field blank for security, same as SMTP.
  if (tautulli_api_key) setSetting('tautulli_api_key', tautulli_api_key);

  res.render('admin-settings', { ...loadSettingsPageData(), saved: 'tautulli', testResult: null, brandingError: null });
});

router.post('/admin/settings/tautulli/test', async (req, res) => {
  const settings = getAllSettings();
  const result = await testTautulliConnection(settings.tautulli_url, settings.tautulli_api_key);
  res.render('admin-settings', { ...loadSettingsPageData(), saved: null, testResult: null, brandingError: null, tautulliTestResult: result });
});

// ---------- Health (admin-wide container monitor) ----------

router.get('/admin/health', (req, res) => {
  const sshConfigured = !!db.prepare('SELECT id FROM admin_ssh LIMIT 1').get();
  const containers = db.prepare('SELECT * FROM admin_health_containers ORDER BY sort_order ASC, id ASC').all();
  const recentLog = db
    .prepare(
      `SELECT l.*, u.name AS admin_name FROM admin_health_log l
       JOIN users u ON u.id = l.admin_user_id
       ORDER BY l.requested_at DESC LIMIT 25`
    )
    .all();

  const customActionsByContainer = {};
  db.prepare('SELECT * FROM admin_container_actions ORDER BY sort_order ASC, id ASC').all().forEach((a) => {
    (customActionsByContainer[a.container_id] = customActionsByContainer[a.container_id] || []).push(a);
  });
  containers.forEach((c) => { c.customActions = customActionsByContainer[c.id] || []; });

  const stuckWatchByContainer = {};
  db.prepare('SELECT * FROM stuck_watch_containers').all().forEach((w) => { stuckWatchByContainer[w.container_name] = w; });

  const vpnWatchByContainer = {};
  db.prepare('SELECT * FROM vpn_watch_containers').all().forEach((w) => { vpnWatchByContainer[w.container_name] = w; });

  const mounts = db.prepare('SELECT * FROM admin_mounts ORDER BY name ASC').all();
  const vpnMonitors = db.prepare('SELECT * FROM admin_vpn_monitors ORDER BY name ASC').all();

  res.render('admin-health', { sshConfigured, containers, recentLog, stuckWatchByContainer, vpnWatchByContainer, mounts, vpnMonitors });
});

router.post('/admin/health/containers', (req, res) => {
  containerLogoUpload(req, res, (err) => {
    if (err) return res.status(400).render('error', { message: err.message });

    const containerName = String(req.body.container_name || '').trim();
    const label = String(req.body.label || containerName).trim();
    const linkUrl = String(req.body.link_url || '').trim() || null;
    const logoBg = ['default', 'white', 'none'].includes(req.body.logo_bg) ? req.body.logo_bg : 'default';

    if (!containerName) return res.status(400).render('error', { message: 'Missing required fields - please fill in everything marked required and try again.' });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName)) {
      return res.status(400).render('error', { message: 'Container name can only contain letters, numbers, dots, dashes, and underscores.' });
    }

    const maxOrder = db.prepare('SELECT MAX(sort_order) AS m FROM admin_health_containers').get().m || 0;
    const logoPath = req.file ? `/uploads/${req.file.filename}` : null;

    db.prepare(
      'INSERT INTO admin_health_containers (container_name, label, logo_path, link_url, logo_bg, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(containerName, label, logoPath, linkUrl, logoBg, maxOrder + 1);
    res.redirect('/admin/health');
  });
});

router.post('/admin/health/containers/:id/update', (req, res) => {
  containerLogoUpload(req, res, (err) => {
    if (err) return res.status(400).render('error', { message: err.message });

    const containerName = String(req.body.container_name || '').trim();
    const label = String(req.body.label || '').trim();
    const linkUrl = String(req.body.link_url || '').trim() || null;
    const logoBg = ['default', 'white', 'none'].includes(req.body.logo_bg) ? req.body.logo_bg : 'default';
    const isActive = req.body.mark_inactive === '1' ? 0 : 1;

    if (!label || !containerName) return res.status(400).render('error', { message: 'Missing required fields - please fill in everything marked required and try again.' });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName)) {
      return res.status(400).render('error', { message: 'Container name can only contain letters, numbers, dots, dashes, and underscores.' });
    }

    if (req.file) {
      db.prepare('UPDATE admin_health_containers SET container_name = ?, label = ?, link_url = ?, logo_bg = ?, logo_path = ?, is_active = ? WHERE id = ?').run(
        containerName,
        label,
        linkUrl,
        logoBg,
        `/uploads/${req.file.filename}`,
        isActive,
        req.params.id
      );
    } else {
      db.prepare('UPDATE admin_health_containers SET container_name = ?, label = ?, link_url = ?, logo_bg = ?, is_active = ? WHERE id = ?').run(
        containerName,
        label,
        linkUrl,
        logoBg,
        isActive,
        req.params.id
      );
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

// ---------- Mounts ----------
// Named filesystem mounts an admin wants quick check/unmount access to
// from this page (e.g. a network share several containers depend on).
// Deliberately just a name/folder pair with no other metadata - this
// isn't trying to model mount options, filesystem type, etc, just give a
// quick "is it there" / "get it out of the way" tool.

function safeMountFolderName(value) {
  const name = String(value || '').trim();
  // Same safe-name pattern used elsewhere in this app (container names,
  // etc) - letters/numbers/dot/dash/underscore only, so this can never
  // become a path (no slashes) or carry shell metacharacters into the
  // mountpoint/umount commands built from it below.
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) ? name : null;
}

router.post('/admin/health/mounts', (req, res) => {
  const name = String(req.body.name || '').trim();
  const folderName = safeMountFolderName(req.body.folder_name);

  if (!name || !folderName) {
    return res.status(400).render('error', { message: "Missing required fields, or the folder name contains characters that aren't allowed (letters, numbers, dots, dashes, and underscores only) - please fill in everything marked required and try again." });
  }

  db.prepare('INSERT INTO admin_mounts (name, folder_name) VALUES (?, ?)').run(name, folderName);
  res.redirect('/admin/health');
});

router.post('/admin/health/mounts/:id/delete', (req, res) => {
  db.prepare('DELETE FROM admin_mounts WHERE id = ?').run(req.params.id);
  res.redirect('/admin/health');
});

router.post('/admin/health/mounts/:id/check', async (req, res) => {
  const mount = db.prepare('SELECT * FROM admin_mounts WHERE id = ?').get(req.params.id);
  if (!mount) return res.status(404).json({ ok: false, message: 'Mount not found.' });

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) return res.status(400).json({ ok: false, message: 'No admin SSH access configured yet. Set it up in Settings first.' });

  // mountpoint -q exits 0 if the path IS currently a mountpoint, non-zero
  // otherwise - runCommand's own success flag already reflects the exit
  // code, so that's the answer, no output parsing needed.
  const result = await runCommand(target, `mountpoint -q '/mnt/${mount.folder_name}'`, 15000);
  if (result.connectionFailed) {
    return res.json({ ok: false, message: 'Could not reach the server to check this mount.' });
  }

  res.json({
    ok: true,
    active: result.success,
    message: result.success ? `${mount.name} is currently mounted.` : `${mount.name} is NOT currently mounted.`,
  });
});

router.post('/admin/health/mounts/:id/unmount', async (req, res) => {
  const mount = db.prepare('SELECT * FROM admin_mounts WHERE id = ?').get(req.params.id);
  if (!mount) return res.status(404).json({ ok: false, message: 'Mount not found.' });

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) return res.status(400).json({ ok: false, message: 'No admin SSH access configured yet. Set it up in Settings first.' });

  const result = await runCommand(target, `sudo umount -l '/mnt/${mount.folder_name}'`, 30000);

  db.prepare(
    'INSERT INTO admin_health_log (admin_user_id, container_name, action, success, output) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.id, `mount:${mount.folder_name}`, 'unmount', result.success ? 1 : 0, result.output);

  res.json({
    ok: result.success,
    message: result.success ? `${mount.name} unmounted successfully.` : `Failed to unmount ${mount.name}: ${result.output}`,
  });
});

// Gluetun instances an admin wants a quick VPN-status check for from this
// page. Deliberately just a name/URL pair, same minimal approach as Mounts
// above - this isn't trying to be a full gluetun dashboard, just a quick
// "is it connected" check alongside everything else on this page.

// The hostname in a configured gluetun URL (e.g. "gluetun" in
// http://gluetun:8888) is normally that container's own Docker service/
// container name - resolvable via Docker's embedded DNS, but only BETWEEN
// containers on the same Docker network. It's never resolvable from the
// host's own shell, which is where every SSH command from this app
// actually runs - so a plain curl against that hostname would just fail
// to resolve it at all. This resolves the hostname to the container's
// real IP via `docker inspect` first (daemon-level, no network DNS
// involved) and rebuilds the URL with that IP substituted in. Returns the
// URL unchanged if the hostname is already a plain IP address (nothing to
// resolve), or null if the container can't be found/inspected at all.
async function resolveGluetunUrl(target, rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    return null;
  }

  const hostname = parsed.hostname;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return rawUrl; // already a plain IP - nothing to resolve

  const safeHostname = hostname.replace(/'/g, `'"'"'`);
  const result = await runCommand(
    target,
    `docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' '${safeHostname}' 2>&1`,
    10000
  );
  if (!result.success) return null;

  const ip = result.output.trim().split(/\s+/)[0];
  if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return null;

  parsed.hostname = ip;
  return parsed.toString();
}

router.post('/admin/health/vpn-monitors', (req, res) => {
  const name = String(req.body.name || '').trim();
  const url = String(req.body.url || '').trim();

  if (!name || !url) {
    return res.status(400).render('error', { message: 'Missing required fields - please fill in everything marked required and try again.' });
  }
  if (!/^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?(\/.*)?$/.test(url)) {
    return res.status(400).render('error', { message: 'That URL doesn\'t look valid - it should look like http://gluetun:8888 or http://gluetun-decypharr:8789.' });
  }

  db.prepare('INSERT INTO admin_vpn_monitors (name, url) VALUES (?, ?)').run(name, url);
  res.redirect('/admin/health');
});

router.post('/admin/health/vpn-monitors/:id/delete', (req, res) => {
  db.prepare('DELETE FROM admin_vpn_monitors WHERE id = ?').run(req.params.id);
  res.redirect('/admin/health');
});

router.post('/admin/health/vpn-monitors/:id/check', async (req, res) => {
  const monitor = db.prepare('SELECT * FROM admin_vpn_monitors WHERE id = ?').get(req.params.id);
  if (!monitor) return res.status(404).json({ ok: false, message: 'VPN monitor not found.' });

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) return res.status(400).json({ ok: false, message: 'No admin SSH access configured yet. Set it up in Settings first.' });

  const curlCheck = await runCommand(target, 'command -v curl 2>&1', 10000);
  if (!curlCheck.success || !curlCheck.output.trim()) {
    return res.json({ ok: false, message: 'curl isn\'t installed on the server - install it (e.g. `apt install curl`) to check VPN status.' });
  }

  const resolvedUrl = await resolveGluetunUrl(target, monitor.url);
  if (!resolvedUrl) {
    return res.json({ ok: false, message: `Could not resolve ${monitor.name}'s address on the server - is the container name in the URL correct?` });
  }

  const safeUrl = resolvedUrl.replace(/'/g, `'"'"'`);
  const marker = '::KBVPNSTATUS::';
  // Gluetun's own control server - tries the standard status endpoint
  // first. -m 5 keeps a genuinely unreachable instance from hanging the
  // whole check. The trailing HTTP code (after the marker) lets this tell
  // "reached it, but got an unexpected response" apart from "couldn't
  // reach it at all" even if the JSON body below doesn't parse as expected.
  const command = `curl -s -m 5 -o - -w '${marker}%{http_code}' '${safeUrl}/v1/vpn/status' 2>&1`;
  const result = await runCommand(target, command, 10000);

  if (result.connectionFailed) {
    return res.json({ ok: false, message: 'Could not reach the server to check this VPN.' });
  }

  const markerIndex = result.output.lastIndexOf(marker);
  const body = markerIndex === -1 ? result.output : result.output.slice(0, markerIndex);
  const httpCode = markerIndex === -1 ? null : result.output.slice(markerIndex + marker.length).trim();
  const reached = httpCode && /^2\d\d$/.test(httpCode);

  if (!reached) {
    return res.json({ ok: true, connected: false, message: `${monitor.name} is not reachable.` });
  }

  // Best-effort parse of gluetun's own JSON shape - falls back to just
  // "reached it" if the body doesn't look like what's expected, rather
  // than treating an unexpected shape as a hard failure.
  let statusText = null;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.status === 'string') statusText = parsed.status;
  } catch (e) {
    // not JSON, or not the expected shape - fall through to the generic reachable message below
  }

  const connected = statusText ? statusText.toLowerCase() === 'running' : true;
  const message = statusText
    ? `${monitor.name}: VPN is ${statusText}.`
    : `${monitor.name} is reachable (status format not recognized).`;

  res.json({ ok: true, connected, message });
});

// Full details view (status, public IP, port forwarding, DNS, settings) -
// everything gluetun's own control server exposes, fetched in one combined
// SSH round trip rather than five separate ones. Each endpoint's raw JSON
// is returned as-is (not picked apart into specific named fields) so the
// page can display whatever gluetun actually sends back, regardless of
// which fields a given gluetun version happens to include.
router.post('/admin/health/vpn-monitors/:id/details', async (req, res) => {
  const monitor = db.prepare('SELECT * FROM admin_vpn_monitors WHERE id = ?').get(req.params.id);
  if (!monitor) return res.status(404).json({ ok: false, message: 'VPN monitor not found.' });

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) return res.status(400).json({ ok: false, message: 'No admin SSH access configured yet. Set it up in Settings first.' });

  // curl isn't used anywhere else in this app - worth confirming it's
  // actually installed on the target server before blaming gluetun itself
  // for what might just be a missing dependency.
  const curlCheck = await runCommand(target, 'command -v curl 2>&1', 10000);
  if (!curlCheck.success || !curlCheck.output.trim()) {
    return res.json({ ok: false, message: 'curl isn\'t installed on the server - install it (e.g. `apt install curl`) to use VPN details.' });
  }

  const resolvedUrl = await resolveGluetunUrl(target, monitor.url);
  if (!resolvedUrl) {
    return res.json({ ok: false, message: `Could not resolve ${monitor.name}'s address on the server - is the container name in the URL correct?` });
  }

  const safeUrl = resolvedUrl.replace(/'/g, `'"'"'`);
  const segmentMarker = '::KBVPN_SEGMENT::';
  const endpoints = ['/v1/vpn/status', '/v1/publicip/ip', '/v1/portforward', '/v1/dns/status', '/v1/vpn/settings'];
  const command = endpoints
    .map((ep) => `curl -s -m 5 -w '\\nHTTP_CODE:%{http_code}' '${safeUrl}${ep}' 2>&1`)
    .join(` ; echo '${segmentMarker}' ; `);

  const result = await runCommand(target, command, 20000);
  if (result.connectionFailed) {
    return res.json({ ok: false, message: 'Could not reach the server to get VPN details.' });
  }

  const segments = result.output.split(segmentMarker).map((s) => s.trim());

  // Each segment carries its own trailing HTTP code (appended by curl -w
  // above) - split that back off so the parsed JSON body and the
  // diagnostic raw text shown on failure don't include it.
  function splitHttpCode(segment) {
    const idx = segment.lastIndexOf('HTTP_CODE:');
    if (idx === -1) return { body: segment, httpCode: null };
    return { body: segment.slice(0, idx).trim(), httpCode: segment.slice(idx + 'HTTP_CODE:'.length).trim() };
  }

  // Returns both the parsed JSON (or null if it didn't parse) and the raw
  // response text, so a genuine failure - auth required, connection
  // refused, an HTML error page, curl's own error message - is visible to
  // the admin instead of collapsing into an indistinguishable "not
  // available" the same as a field gluetun simply didn't return.
  function parseSegment(segment) {
    const { body, httpCode } = splitHttpCode(segment);
    let parsed = null;
    if (body) {
      try { parsed = JSON.parse(body); } catch (e) { /* not JSON - raw is still returned below */ }
    }
    return { parsed, raw: body || null, httpCode };
  }

  res.json({
    ok: true,
    name: monitor.name,
    status: parseSegment(segments[0]),
    publicIp: parseSegment(segments[1]),
    portForward: parseSegment(segments[2]),
    dns: parseSegment(segments[3]),
    settings: parseSegment(segments[4]),
  });
});

router.post('/admin/health/vpn-monitors/:id/:action', async (req, res) => {
  if (!['start', 'stop'].includes(req.params.action)) return res.status(404).json({ ok: false, message: 'Unknown action.' });

  const monitor = db.prepare('SELECT * FROM admin_vpn_monitors WHERE id = ?').get(req.params.id);
  if (!monitor) return res.status(404).json({ ok: false, message: 'VPN monitor not found.' });

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) return res.status(400).json({ ok: false, message: 'No admin SSH access configured yet. Set it up in Settings first.' });

  const resolvedUrl = await resolveGluetunUrl(target, monitor.url);
  if (!resolvedUrl) {
    return res.json({ ok: false, message: `Could not resolve ${monitor.name}'s address on the server - is the container name in the URL correct?` });
  }

  const desiredStatus = req.params.action === 'start' ? 'running' : 'stopped';
  const safeUrl = resolvedUrl.replace(/'/g, `'"'"'`);
  const safeBody = JSON.stringify({ status: desiredStatus }).replace(/'/g, `'"'"'`);
  const marker = '::KBVPNACTION::';
  const command = `curl -s -m 10 -X PUT -H 'Content-Type: application/json' -d '${safeBody}' -o - -w '${marker}%{http_code}' '${safeUrl}/v1/vpn/status' 2>&1`;

  const result = await runCommand(target, command, 15000);
  if (result.connectionFailed) {
    return res.json({ ok: false, message: `Could not reach the server to ${req.params.action} ${monitor.name}.` });
  }

  const markerIndex = result.output.lastIndexOf(marker);
  const httpCode = markerIndex === -1 ? null : result.output.slice(markerIndex + marker.length).trim();
  const succeeded = httpCode && /^2\d\d$/.test(httpCode);

  res.json({
    ok: succeeded,
    message: succeeded
      ? `${monitor.name} ${req.params.action === 'start' ? 'started' : 'stopped'} successfully.`
      : `Failed to ${req.params.action} ${monitor.name} (HTTP ${httpCode || 'unreachable'}).`,
  });
});

router.get('/admin/health/status', async (req, res) => {
  if (req.query.live === '1') {
    await Promise.all([checkVpnWatch(), checkStuckWatch()]);
  }

  const containers = db.prepare('SELECT * FROM admin_health_containers WHERE is_active = 1').all();

  const stuckWatchByContainer = {};
  db.prepare('SELECT * FROM stuck_watch_containers').all().forEach((w) => { stuckWatchByContainer[w.container_name] = w; });

  const vpnWatchByContainer = {};
  db.prepare('SELECT * FROM vpn_watch_containers').all().forEach((w) => { vpnWatchByContainer[w.container_name] = w; });

  if (containers.length === 0) return res.json({ ok: true, containers: [], stuckWatchByContainer, vpnWatchByContainer });

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) {
    return res.json({
      ok: true,
      containers: containers.map((c) => ({ id: c.id, label: c.label, container_name: c.container_name, status: 'unknown' })),
      stuckWatchByContainer,
      vpnWatchByContainer,
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
    stuckWatchByContainer,
    vpnWatchByContainer,
  });
});

// Basic host stats (uptime, load average, memory, disk) for the Admin
// Overview page - shown next to Container Health, above the account stats.
router.get('/admin/server-data/status', async (req, res) => {
  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) {
    return res.json({ ok: false, message: 'No admin SSH access configured yet.' });
  }

  const marker = '::';
  const command = [
    `echo "UPTIME${marker}$(uptime -p 2>/dev/null || uptime)"`,
    `echo "CPU${marker}$(top -bn1 | grep -i 'Cpu(s)' | awk '{printf "%.1f%%", 100-$8}')"`,
    `echo "MEM${marker}$(free -m 2>/dev/null | awk '/^Mem:/ {printf "%s MB / %s MB", $3, $2}')"`,
    `echo "MEMPERCENT${marker}$(free -m 2>/dev/null | awk '/^Mem:/ {printf "%.0f%%", ($3/$2)*100}')"`,
    `echo "DISK${marker}$(df -h / 2>/dev/null | awk 'NR==2 {printf "%s / %s", $3, $2}')"`,
    `echo "DISKPERCENT${marker}$(df -h / 2>/dev/null | awk 'NR==2 {print $5}')"`,
  ].join(' ; ');

  const result = await runCommand(target, command);
  if (result.connectionFailed) {
    return res.json({ ok: false, message: 'Could not reach the server.' });
  }

  const parsed = {};
  result.output.split('\n').forEach((line) => {
    const idx = line.indexOf(marker);
    if (idx === -1) return;
    parsed[line.slice(0, idx).trim()] = line.slice(idx + marker.length).trim();
  });

  res.json({
    ok: true,
    uptime: parsed.UPTIME || '—',
    cpu: parsed.CPU || '—',
    memory: parsed.MEM || '—',
    memPercent: parsed.MEMPERCENT || '—',
    disk: parsed.DISK || '—',
    diskPercent: parsed.DISKPERCENT || '—',
  });
});

// Snapshot log viewer (not a live stream) - fetches the most recent lines
// each time it's called. The page polls this on an interval to approximate
// "follow" behaviour without needing a persistent streaming connection.
router.get('/admin/health/containers/:id/logs', async (req, res) => {
  const container = db.prepare('SELECT * FROM admin_health_containers WHERE id = ?').get(req.params.id);
  if (!container) return res.status(404).json({ ok: false, message: 'Container not found.' });

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) return res.status(400).json({ ok: false, message: 'No admin SSH access configured yet. Set it up in Settings first.' });

  const command = `docker logs --tail 200 --timestamps '${container.container_name}' 2>&1`;
  const result = await runCommand(target, command);

  res.json({ ok: true, output: result.output, label: container.label });
});

async function handleHealthAction(req, res, action) {
  const globalState = getResetState();
  if (globalState.active) {
    return res.status(409).json({
      ok: false,
      message: `A reset is already in progress (${globalState.source || 'another action'}) - wait for it to finish first.`,
    });
  }

  const container = db.prepare('SELECT * FROM admin_health_containers WHERE id = ?').get(req.params.id);
  if (!container) return res.status(404).json({ ok: false, message: 'Container not found.' });

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) {
    return res.status(400).json({ ok: false, message: 'No admin SSH access configured yet. Set it up in Settings first.' });
  }

  const command = `docker ${action} '${container.container_name}'`;
  markContainerActionStart(container.id);
  let result;
  try {
    result = await runCommand(target, command);
  } finally {
    markContainerActionEnd(container.id);
  }

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

// Update = stop, pull a fresh image, then bring back up - via docker compose
// (not "docker stop/restart") so the container actually gets recreated with
// the new image rather than just restarted on the old one. Scoped to this
// one container/service only.
router.post('/admin/health/containers/:id/docker-update', async (req, res) => {
  const globalState = getResetState();
  if (globalState.active) {
    return res.status(409).json({
      ok: false,
      message: `A reset is already in progress (${globalState.source || 'another action'}) - wait for it to finish first.`,
    });
  }

  const container = db.prepare('SELECT * FROM admin_health_containers WHERE id = ?').get(req.params.id);
  if (!container) return res.status(404).json({ ok: false, message: 'Container not found.' });

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) {
    return res.status(400).json({ ok: false, message: 'No admin SSH access configured yet. Set it up in Settings first.' });
  }

  const composePath = getAllSettings().compose_path;
  if (!composePath) {
    return res.status(400).json({ ok: false, message: 'Set a Docker Compose path in Settings first (e.g. /opt/media-stack) so containers can be updated properly.' });
  }

  const safePath = composePath.replace(/'/g, `'"'"'`);
  const name = container.container_name;
  const withUpdate = req.body.with_update === '1' || req.body.with_update === undefined; // default to update, for any older cached page that posts with no body at all
  // --no-deps on the "up" step matters here: without it, docker compose
  // also starts (or even recreates) anything this container lists under
  // depends_on in the compose file - a shared VPN container, a database,
  // another *arr app, whatever it happens to be linked to - even though
  // only this one container was actually selected. stop/pull don't have
  // this cascading behavior, only up does.
  const command = withUpdate
    ? `cd '${safePath}' && docker compose stop '${name}' && docker compose pull '${name}' && docker compose up -d --no-deps '${name}'`
    : `cd '${safePath}' && docker compose stop '${name}' && docker compose up -d --no-deps '${name}'`;
  markContainerActionStart(container.id);
  let result;
  try {
    result = await runCommand(target, command, 5 * 60 * 1000); // up to 5 minutes for a single image pull
  } finally {
    markContainerActionEnd(container.id);
  }

  db.prepare(
    'INSERT INTO admin_health_log (admin_user_id, container_name, action, success, output) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.id, name, withUpdate ? 'update' : 'restart', result.success ? 1 : 0, result.output);

  res.json({
    ok: result.success,
    message: result.success
      ? `${container.label} updated (stopped, pulled, and restarted) successfully.`
      : `Failed to update ${container.label}: ${result.output}`,
  });
});

// Live resource usage for one container (CPU/memory/network/disk I/O) -
// only meaningful while it's running, so a stopped/missing container just
// reports that plainly instead of erroring oddly.
// Whole-server + every running container's stats in one shot - one SSH
// round trip covers everything, rather than looping the per-container
// usage call once per card (which would mean N separate connections for
// N containers every time this refreshes).
router.get('/admin/health/live-stats', async (req, res) => {
  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) {
    return res.json({ ok: false, message: 'No admin SSH access configured yet. Set it up in Settings first.' });
  }

  const marker = '::';
  const sectionMarker = '###CONTAINERS###';
  const command = `free -m | awk '/Mem:/{print $2"${marker}"$3}' && uptime | awk -F'load average: ' '{print $2}' && df -h / | awk 'NR==2{print $2"${marker}"$3"${marker}"$5}' && top -bn1 | grep -i 'Cpu(s)' | awk '{print 100-$8}' && echo '${sectionMarker}' && docker stats --no-stream --format '{{.Name}}${marker}{{.CPUPerc}}${marker}{{.MemUsage}}${marker}{{.MemPerc}}'`;
  const result = await runCommand(target, command);

  if (result.connectionFailed) {
    return res.json({ ok: false, message: 'Could not reach the server.' });
  }
  if (!result.success) {
    return res.json({ ok: false, message: 'Could not get live stats.' });
  }

  const lines = result.output.trim().split('\n');
  const [memTotal, memUsed] = (lines[0] || '').split(marker);
  const loadLine = (lines[1] || '').trim();
  const [diskTotal, diskUsed, diskPercent] = (lines[2] || '').split(marker);
  const cpuPercent = (lines[3] || '').trim();
  const sectionIdx = lines.indexOf(sectionMarker);
  const containerLines = sectionIdx !== -1 ? lines.slice(sectionIdx + 1) : [];

  const containers = containerLines.filter(Boolean).map((line) => {
    const [name, cpu, memUsage, memPercent] = line.split(marker);
    return { name, cpu, memUsage, memPercent };
  });

  res.json({
    ok: true,
    memTotal: memTotal || null,
    memUsed: memUsed || null,
    load: loadLine || null,
    diskTotal: diskTotal || null,
    diskUsed: diskUsed || null,
    diskPercent: diskPercent || null,
    cpuPercent: cpuPercent || null,
    containers,
  });
});

router.get('/admin/health/containers/:id/usage', async (req, res) => {
  const container = db.prepare('SELECT * FROM admin_health_containers WHERE id = ?').get(req.params.id);
  if (!container) return res.status(404).json({ ok: false, message: 'Container not found.' });

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) {
    return res.json({ ok: false, message: 'No admin SSH access configured yet. Set it up in Settings first.' });
  }

  const marker = '::';
  const command = `docker stats --no-stream --format '{{.CPUPerc}}${marker}{{.MemUsage}}${marker}{{.MemPerc}}${marker}{{.NetIO}}${marker}{{.BlockIO}}' '${container.container_name}' 2>&1`;
  const result = await runCommand(target, command);

  if (result.connectionFailed) {
    return res.json({ ok: false, message: 'Could not reach the server.' });
  }
  if (!result.success || !result.output.includes(marker)) {
    return res.json({ ok: false, message: 'Could not get usage stats — the container may not be running.' });
  }

  const parts = result.output.trim().split(marker);
  res.json({
    ok: true,
    label: container.label,
    cpu: parts[0] || '—',
    memUsage: parts[1] || '—',
    memPercent: parts[2] || '—',
    netIO: parts[3] || '—',
    blockIO: parts[4] || '—',
  });
});

// Icon choices offered in the "Add New Action" picker - kept to a fixed
// set rather than free text, so admins can't accidentally paste something
// that isn't a real Font Awesome class and get a blank icon on the button.
const CONTAINER_ACTION_ICONS = [
  'fa-bolt', 'fa-dice', 'fa-rotate', 'fa-terminal', 'fa-database', 'fa-broom',
  'fa-download', 'fa-upload', 'fa-trash', 'fa-wrench', 'fa-clock-rotate-left', 'fa-play',
];

router.post('/admin/health/containers/:id/actions', (req, res) => {
  const container = db.prepare('SELECT * FROM admin_health_containers WHERE id = ?').get(req.params.id);
  if (!container) return res.status(404).json({ ok: false, message: 'Container not found.' });

  const label = String(req.body.label || '').trim();
  const icon = CONTAINER_ACTION_ICONS.includes(req.body.icon) ? req.body.icon : 'fa-bolt';
  const command = String(req.body.command || '').trim();

  if (!label || !command) {
    return res.status(400).json({ ok: false, message: 'Both a label and a command are required.' });
  }

  const maxOrder = db.prepare('SELECT MAX(sort_order) AS m FROM admin_container_actions WHERE container_id = ?').get(container.id).m || 0;
  const info = db
    .prepare('INSERT INTO admin_container_actions (container_id, label, icon, command, sort_order) VALUES (?, ?, ?, ?, ?)')
    .run(container.id, label, icon, command, maxOrder + 1);

  res.json({ ok: true, action: { id: info.lastInsertRowid, label, icon, command } });
});

router.post('/admin/health/containers/:id/actions/:actionId/delete', (req, res) => {
  db.prepare('DELETE FROM admin_container_actions WHERE id = ? AND container_id = ?').run(req.params.actionId, req.params.id);
  res.json({ ok: true });
});

router.post('/admin/health/containers/:id/actions/:actionId/move', (req, res) => {
  const direction = req.body.direction === 'up' ? 'up' : 'down';
  const actions = db.prepare('SELECT * FROM admin_container_actions WHERE container_id = ? ORDER BY sort_order ASC, id ASC').all(req.params.id);
  const index = actions.findIndex((a) => a.id === Number(req.params.actionId));
  if (index === -1) return res.status(404).json({ ok: false, message: 'Action not found.' });

  const swapIndex = direction === 'up' ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= actions.length) return res.json({ ok: true, actions }); // already at the end - nothing to do, not an error

  const current = actions[index];
  const swap = actions[swapIndex];
  const update = db.prepare('UPDATE admin_container_actions SET sort_order = ? WHERE id = ?');
  update.run(swap.sort_order, current.id);
  update.run(current.sort_order, swap.id);

  const reordered = db.prepare('SELECT * FROM admin_container_actions WHERE container_id = ? ORDER BY sort_order ASC, id ASC').all(req.params.id);
  res.json({ ok: true, actions: reordered });
});

router.post('/admin/health/containers/:id/actions/:actionId/update', (req, res) => {
  const existing = db.prepare('SELECT * FROM admin_container_actions WHERE id = ? AND container_id = ?').get(req.params.actionId, req.params.id);
  if (!existing) return res.status(404).json({ ok: false, message: 'Action not found.' });

  const label = String(req.body.label || '').trim();
  const icon = CONTAINER_ACTION_ICONS.includes(req.body.icon) ? req.body.icon : existing.icon;
  const command = String(req.body.command || '').trim();

  if (!label || !command) {
    return res.status(400).json({ ok: false, message: 'Both a label and a command are required.' });
  }

  db.prepare('UPDATE admin_container_actions SET label = ?, icon = ?, command = ? WHERE id = ?').run(label, icon, command, existing.id);
  res.json({ ok: true, action: { id: existing.id, label, icon, command } });
});

router.post('/admin/health/containers/:id/actions/:actionId/run', async (req, res) => {
  const globalState = getResetState();
  if (globalState.active) {
    return res.status(409).json({
      ok: false,
      message: `A reset is already in progress (${globalState.source || 'another action'}) - wait for it to finish first.`,
    });
  }

  const container = db.prepare('SELECT * FROM admin_health_containers WHERE id = ?').get(req.params.id);
  if (!container) return res.status(404).json({ ok: false, message: 'Container not found.' });

  const action = db.prepare('SELECT * FROM admin_container_actions WHERE id = ? AND container_id = ?').get(req.params.actionId, req.params.id);
  if (!action) return res.status(404).json({ ok: false, message: 'Action not found.' });

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) {
    return res.status(400).json({ ok: false, message: 'No admin SSH access configured yet. Set it up in Settings first.' });
  }

  const result = await runCommand(target, action.command, 5 * 60 * 1000); // custom commands could reasonably take a while (backups, world resets, etc.)

  db.prepare(
    'INSERT INTO admin_health_log (admin_user_id, container_name, action, success, output) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.id, container.container_name, `custom: ${action.label}`, result.success ? 1 : 0, result.output);

  if (result.success) {
    resetIfLinkedContainerAction(action.id);
  }

  res.json({
    ok: result.success,
    message: result.success ? `${action.label} completed successfully.` : `${action.label} failed: ${result.output}`,
  });
});

// Bulk action - runs ONE combined command (e.g. "docker restart a b c") over
// a single SSH connection instead of one call per container.
router.post('/admin/health/containers/bulk-action', async (req, res) => {
  const globalState = getResetState();
  if (globalState.active) {
    return res.status(409).json({
      ok: false,
      message: `A reset is already in progress (${globalState.source || 'another action'}) - wait for it to finish first.`,
    });
  }

  const action = req.body.action === 'stop' ? 'stop' : 'restart';
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids].filter(Boolean);

  if (ids.length === 0) return res.status(400).json({ ok: false, message: 'No containers selected.' });

  const containers = db
    .prepare(`SELECT * FROM admin_health_containers WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);

  if (containers.length === 0) return res.status(400).json({ ok: false, message: 'No matching containers found.' });

  const target = db.prepare('SELECT * FROM admin_ssh LIMIT 1').get();
  if (!target) {
    return res.status(400).json({ ok: false, message: 'No admin SSH access configured yet. Set it up in Settings first.' });
  }

  const names = containers.map((c) => `'${c.container_name}'`).join(' ');
  const command = `docker ${action} ${names}`;
  containers.forEach((c) => markContainerActionStart(c.id));
  let result;
  try {
    result = await runCommand(target, command);
  } finally {
    containers.forEach((c) => markContainerActionEnd(c.id));
  }

  containers.forEach((c) => {
    db.prepare(
      'INSERT INTO admin_health_log (admin_user_id, container_name, action, success, output) VALUES (?, ?, ?, ?, ?)'
    ).run(req.user.id, c.container_name, action, result.success ? 1 : 0, result.output);
  });

  res.json({
    ok: result.success,
    message: result.success
      ? `${action === 'stop' ? 'Stopped' : 'Restarted'} ${containers.length} container(s) successfully.`
      : `Bulk ${action} failed: ${result.output}`,
  });
});

// Full stack reset: docker compose down, then pull, then up -d, in that
// order, at the compose path configured in Settings. Deliberately its own
// endpoint (not reusing bulk-action) since it affects the whole stack, not
// a chosen set of containers.
// In-memory tracker for the background full-reset job. This app runs as a
// single process (no horizontal scaling), so this is safe and avoids extra
// schema just to track "is a reset currently running".
router.post('/admin/health/full-reset', (req, res) => {
  const withUpdate = req.body.with_update === '1' || req.body.with_update === undefined; // default to update, in case an older cached page still posts with no body at all
  const source = withUpdate ? 'Admin: Full Reset & Update' : 'Admin: Full Reset';
  const result = triggerFullReset(source, req.user.id, null, withUpdate);
  const status = result.ok ? 200 : (result.message.includes('already in progress') ? 409 : 400);
  res.status(status).json(result);
});

router.get('/admin/health/full-reset/status', (req, res) => {
  res.json(getFullResetState());
});

router.post('/admin/health/full-reset/dismiss', (req, res) => {
  dismissFullResetResult();
  res.json({ ok: true });
});

// ---------- SSH Console ----------
// A direct command runner against the admin-wide SSH target, auto-authenticated
// with the credentials already stored in Settings - no separate login step.
// This runs one command per request (not a full interactive shell/PTY).

router.get('/admin/ssh-console', (req, res) => {
  const sshConfigured = !!db.prepare('SELECT id FROM admin_ssh LIMIT 1').get();
  const history = db
    .prepare('SELECT * FROM ssh_console_log ORDER BY requested_at DESC LIMIT 25')
    .all();
  res.render('admin-ssh-console', { sshConfigured, history });
});

// ---------- Providers ----------

const PROVIDER_CHECK_TYPES = ['real_debrid', 'alldebrid', 'easynews', 'tcp', 'http_ping', 'none'];
const PROVIDER_PLAN_STATUSES = ['unset', 'date', 'lifetime', 'free', 'billed', 'inactive', 'balance_gb', 'balance_tb'];
const PROVIDER_GROUPS = ['Infrastructure', 'Usenet', 'Torrents'];

// Mirrors the reference app's expiryLabel()/expiryStatus() logic, just
// computed server-side instead of in the browser - the view can then
// just print these directly rather than doing date math in JS.
function providerTrackingDisplay(p) {
  switch (p.plan_status) {
    case 'lifetime': return { label: 'LIFETIME', tone: 'lifetime' };
    case 'free': return { label: 'FREE', tone: 'active' };
    case 'billed': return { label: 'BILLED', tone: 'active' };
    case 'inactive': return { label: 'INACTIVE', tone: 'inactive' };
    case 'balance_gb':
    case 'balance_tb': {
      const unit = p.plan_status === 'balance_tb' ? 'TB' : 'GB';
      if (!p.tracking_value) return { label: 'SET BALANCE', tone: 'unset' };
      const gbValue = unit === 'TB' ? parseFloat(p.tracking_value) * 1024 : parseFloat(p.tracking_value);
      return { label: `${p.tracking_value} ${unit} UP`, tone: gbValue < 100 ? 'warning' : 'active' };
    }
    case 'date': {
      if (!p.tracking_value) return { label: 'SET EXPIRY', tone: 'unset' };
      const days = Math.ceil((new Date(p.tracking_value) - new Date()) / (1000 * 60 * 60 * 24));
      if (days < 0) return { label: 'EXPIRED', tone: 'inactive' };
      if (days === 0) return { label: 'EXPIRES TODAY', tone: 'warning' };
      return { label: `${days}d LEFT`, tone: days <= 7 ? 'warning' : 'active' };
    }
    default:
      return { label: 'UNSET', tone: 'unset' };
  }
}

function loadProviders() {
  const providers = db.prepare('SELECT * FROM admin_providers ORDER BY sort_order ASC, id ASC').all();
  providers.forEach((p) => { p.tracking = providerTrackingDisplay(p); });
  return {
    providers,
    infrastructureProviders: providers.filter((p) => p.group_label === 'Infrastructure'),
    usenetProviders: providers.filter((p) => p.group_label === 'Usenet'),
    torrentsProviders: providers.filter((p) => p.group_label === 'Torrents'),
  };
}

router.get('/admin/providers', (req, res) => {
  res.render('admin-providers', { ...loadProviders() });
});

router.post('/admin/providers', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).render('error', { message: 'A provider name is required.' });

  const icon = String(req.body.icon || '').trim() || '🔌';
  const groupLabel = PROVIDER_GROUPS.includes(req.body.group_label) ? req.body.group_label : 'Infrastructure';
  const typeLabel = String(req.body.type_label || '').trim() || null;
  const checkType = PROVIDER_CHECK_TYPES.includes(req.body.check_type) ? req.body.check_type : 'none';
  const link = String(req.body.link || '').trim() || null;

  const apiKey = String(req.body.api_key || '').trim();
  const username = String(req.body.username || '').trim() || null;
  const password = String(req.body.password || '').trim();
  const host = String(req.body.host || '').trim() || null;
  const port = req.body.port ? Number(req.body.port) : null;
  const activeServers = checkType === 'http_ping' && req.body.active_servers !== '' ? Number(req.body.active_servers) : null;

  const maxOrder = db.prepare('SELECT MAX(sort_order) AS m FROM admin_providers WHERE group_label = ?').get(groupLabel);
  const sortOrder = (maxOrder.m == null ? -1 : maxOrder.m) + 1;

  db.prepare(
    `INSERT INTO admin_providers (name, icon, group_label, type_label, check_type, api_key_encrypted, username, password_encrypted, host, port, link, active_servers, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name, icon, groupLabel, typeLabel, checkType,
    apiKey ? encrypt(apiKey) : null,
    username,
    password ? encrypt(password) : null,
    host, port, link, activeServers, sortOrder
  );

  res.redirect('/admin/providers');
});

router.post('/admin/providers/:id/update', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).render('error', { message: 'A provider name is required.' });

  const icon = String(req.body.icon || '').trim() || '🔌';
  const groupLabel = PROVIDER_GROUPS.includes(req.body.group_label) ? req.body.group_label : 'Infrastructure';
  const typeLabel = String(req.body.type_label || '').trim() || null;
  const checkType = PROVIDER_CHECK_TYPES.includes(req.body.check_type) ? req.body.check_type : 'none';
  const link = String(req.body.link || '').trim() || null;
  const username = String(req.body.username || '').trim() || null;
  const host = String(req.body.host || '').trim() || null;
  const port = req.body.port ? Number(req.body.port) : null;
  const activeServers = checkType === 'http_ping' && req.body.active_servers !== '' ? Number(req.body.active_servers) : null;

  // Credentials are only overwritten when a new value is actually typed -
  // leaving the field blank on an edit keeps whatever's already stored,
  // matching how every other credential form in this app behaves.
  const apiKey = String(req.body.api_key || '').trim();
  const password = String(req.body.password || '').trim();

  if (apiKey || password) {
    db.prepare(
      `UPDATE admin_providers SET name = ?, icon = ?, group_label = ?, type_label = ?, check_type = ?, link = ?, username = ?, host = ?, port = ?, active_servers = ?,
       api_key_encrypted = COALESCE(?, api_key_encrypted), password_encrypted = COALESCE(?, password_encrypted) WHERE id = ?`
    ).run(
      name, icon, groupLabel, typeLabel, checkType, link, username, host, port, activeServers,
      apiKey ? encrypt(apiKey) : null,
      password ? encrypt(password) : null,
      req.params.id
    );
  } else {
    db.prepare(
      `UPDATE admin_providers SET name = ?, icon = ?, group_label = ?, type_label = ?, check_type = ?, link = ?, username = ?, host = ?, port = ?, active_servers = ? WHERE id = ?`
    ).run(name, icon, groupLabel, typeLabel, checkType, link, username, host, port, activeServers, req.params.id);
  }

  clearProviderCache(Number(req.params.id));
  res.redirect('/admin/providers');
});

router.post('/admin/providers/:id/tracking', (req, res) => {
  const planStatus = PROVIDER_PLAN_STATUSES.includes(req.body.plan_status) ? req.body.plan_status : 'unset';
  const trackingValue = String(req.body.tracking_value || '').trim() || null;
  const customLink = String(req.body.custom_link || '').trim() || null;
  const planName = String(req.body.plan_name || '').trim() || null;
  const notes = String(req.body.notes || '').trim() || null;

  db.prepare('UPDATE admin_providers SET plan_status = ?, tracking_value = ?, custom_link = ?, plan_name = ?, notes = ?, expiry_warning_sent_at = NULL WHERE id = ?').run(
    planStatus, trackingValue, customLink, planName, notes, req.params.id
  );

  res.redirect('/admin/providers');
});

router.post('/admin/providers/:id/delete', (req, res) => {
  db.prepare('DELETE FROM admin_providers WHERE id = ?').run(req.params.id);
  clearProviderCache(Number(req.params.id));
  res.redirect('/admin/providers');
});

router.post('/admin/providers/:id/move', (req, res) => {
  const direction = req.body.direction === 'up' ? 'up' : 'down';
  const provider = db.prepare('SELECT * FROM admin_providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.redirect('/admin/providers');

  const siblings = db.prepare('SELECT * FROM admin_providers WHERE group_label = ? ORDER BY sort_order ASC, id ASC').all(provider.group_label);
  const index = siblings.findIndex((p) => p.id === provider.id);
  const swapIndex = direction === 'up' ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= siblings.length) return res.redirect('/admin/providers');

  const swap = siblings[swapIndex];
  const update = db.prepare('UPDATE admin_providers SET sort_order = ? WHERE id = ?');
  update.run(swap.sort_order, provider.id);
  update.run(provider.sort_order, swap.id);

  res.redirect('/admin/providers');
});

router.get('/admin/providers/status', async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  const providers = db.prepare('SELECT * FROM admin_providers').all();
  const results = {};

  await Promise.all(providers.map(async (p) => {
    if (p.check_type === 'none') return;
    const decrypted = {
      ...p,
      apiKey: p.api_key_encrypted ? decrypt(p.api_key_encrypted) : null,
      password: p.password_encrypted ? decrypt(p.password_encrypted) : null,
    };
    try {
      results[p.id] = await getProviderStatus(decrypted, force);
    } catch (err) {
      results[p.id] = { status: 'offline', error: err.message };
    }
  }));

  res.json({ ok: true, results, checked_at: Date.now() });
});

module.exports = router;
