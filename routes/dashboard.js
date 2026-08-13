const express = require('express');
const db = require('../db');
const { runCommand, getContainerStatuses } = require('../utils/ssh');
const { startReset, endReset, getResetState } = require('../utils/resetLock');
const { notifyResetStarted, sendMail } = require('../utils/mailer');
const { getWatchHistory, getNowWatching, getGeoLookup, fetchPosterImage } = require('../utils/tautulli');
const { getAllSettings, getSiteBaseUrl } = require('../utils/settings');
const { formatUK } = require('../utils/time');
const { resetIfLinkedAction, computeElapsedSeconds } = require('../utils/runTimer');
const { BOSSES } = require('../utils/bosses');

const router = express.Router();

// Tracks in-progress background danger-style actions, keyed by "userId:actionId".
// Single-process app, so in-memory is fine - same pattern as the admin
// Full Reset job tracker.
const dangerActionState = {};

/** Loads everything the dashboard needs for one active subscription's plan. */
function buildPlanView(subscription, userId) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(subscription.plan_id);
  if (!plan) return null;

  if (plan.pricing_mode === 'included_with' && plan.included_with_plan_ids) {
    const triggerIds = String(plan.included_with_plan_ids).split(',').map((id) => Number(id.trim())).filter(Boolean);
    if (triggerIds.length > 0) {
      const placeholders = triggerIds.map(() => '?').join(',');
      const triggerPlans = db.prepare(`SELECT name FROM plans WHERE id IN (${placeholders})`).all(...triggerIds);
      plan.includedWithPlanName = triggerPlans.map((p) => p.name).join(' or ');
    }
  }

  const hasPendingSeedReset = plan.service === 'minecraft'
    ? !!db.prepare(
        `SELECT 1 FROM tickets WHERE user_id = ? AND plan_id = ? AND category = 'minecraft_seed_reset' AND status != 'closed' LIMIT 1`
      ).get(userId, plan.id)
    : false;

  const ssh = db.prepare('SELECT id FROM plan_ssh WHERE plan_id = ?').get(plan.id);
  const actions = db
    .prepare('SELECT * FROM plan_actions WHERE plan_id = ? ORDER BY sort_order ASC, id ASC')
    .all(plan.id);
  const containers = db
    .prepare('SELECT * FROM plan_containers WHERE plan_id = ? ORDER BY sort_order ASC, id ASC')
    .all(plan.id);

  const deathCounterPlayers = plan.service === 'minecraft'
    ? db.prepare('SELECT * FROM plan_death_counter_players WHERE plan_id = ? ORDER BY death_count DESC, player_name ASC').all(plan.id)
    : [];
  const runTimerElapsedSeconds = plan.service === 'minecraft' ? computeElapsedSeconds(plan) : 0;

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

    const override = db.prepare('SELECT enabled FROM user_disabled_actions WHERE user_id = ? AND plan_action_id = ?').get(userId, action.id);
    const effectivelyEnabled = override ? !!override.enabled : !!action.enabled;

    return { ...action, nextAllowedAt, disabledForUser: !effectivelyEnabled };
  });

  return {
    subscription,
    plan,
    hasSsh: !!ssh,
    actions: actionsWithCooldown,
    containers,
    hasPendingSeedReset,
    deathCounterPlayers,
    runTimerElapsedSeconds,
  };
}

router.get('/dashboard', (req, res) => {
  const subscriptions = db
    .prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user.id);

  const allPlanViews = subscriptions
    .filter((s) => s.plan_id && s.status === 'active')
    .map((s) => buildPlanView(s, req.user.id))
    .filter(Boolean);

  // Anything auto-granted (e.g. a Minecraft plan bundled with a Plex plan)
  // gets nested under whichever plan actually triggered it, rather than
  // shown as its own separate top-level card - "under their included
  // plan, not over it". Falls back to showing it standalone only if its
  // trigger plan isn't in the list for some reason (shouldn't normally
  // happen, but better to show it than silently hide something they have
  // access to).
  const extrasByParentPlanId = {};
  const planViews = [];

  allPlanViews.forEach((pv) => {
    const parentPlanId = pv.subscription.auto_granted_via_plan_id;
    if (parentPlanId) {
      (extrasByParentPlanId[parentPlanId] = extrasByParentPlanId[parentPlanId] || []).push(pv);
    } else {
      planViews.push(pv);
    }
  });

  planViews.forEach((pv) => {
    pv.includedExtras = extrasByParentPlanId[pv.plan.id] || [];
    delete extrasByParentPlanId[pv.plan.id];
  });

  // Any leftover extras whose trigger plan isn't in the active list at all.
  Object.values(extrasByParentPlanId).forEach((orphaned) => planViews.push(...orphaned));

  const legacySubscriptions = subscriptions.filter((s) => !s.plan_id);

  const userRecord = db
    .prepare(
      `SELECT u.*, pm.name AS payment_method_name FROM users u
       LEFT JOIN payment_methods pm ON pm.id = u.payment_method_id
       WHERE u.id = ?`
    )
    .get(req.user.id);

  res.render('dashboard', {
    subscriptions,
    planViews,
    legacySubscriptions,
    paymentMethodName: userRecord ? userRecord.payment_method_name : null,
    BOSSES,
  });
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

  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(action.plan_id);
  if (plan && plan.maintenance_mode) {
    return res.status(423).json({
      ok: false,
      message: `This plan is currently in scheduled maintenance. Actions are unavailable until it's resolved.`,
    });
  }

  const override = db.prepare('SELECT enabled FROM user_disabled_actions WHERE user_id = ? AND plan_action_id = ?').get(req.user.id, action.id);
  const effectivelyEnabled = override ? !!override.enabled : !!action.enabled;
  if (!effectivelyEnabled) {
    const message = override
      ? `"${action.label}" has been disabled for your account and is currently unavailable.`
      : `"${action.label}" has been disabled by an admin and is currently unavailable.`;
    return res.status(423).json({ ok: false, message });
  }

  const globalResetState = getResetState();
  if (globalResetState.active) {
    return res.status(409).json({
      ok: false,
      message: `A server reset is already in progress (${globalResetState.source || 'elsewhere'}) - please wait for it to finish before running anything else.`,
    });
  }

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
        nextAllowedAt: new Date(last + cooldownMs).toISOString(),
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

  const nextAllowedAt = action.cooldown_hours > 0
    ? new Date(Date.now() + action.cooldown_hours * 60 * 60 * 1000).toISOString()
    : null;

  // Danger-style actions are meant for slow operations (e.g. a full
  // "docker compose down/pull/up" reset), which can take several minutes.
  // Waiting on that synchronously is exactly the kind of long-lived request
  // a reverse proxy/tunnel in front of this app tends to cut off early -
  // so it runs in the background instead, and the dashboard polls for the
  // real result. Quick actions (restarts, etc.) stay synchronous as before.
  if (action.style === 'danger') {
    const key = `${req.user.id}:${action.id}`;

    // Cooldown starts the moment the action is triggered, not when it
    // finishes, and this same row also blocks a second click while running.
    const info = db.prepare('INSERT INTO action_log (user_id, plan_action_id, success, output) VALUES (?, ?, 0, ?)').run(
      req.user.id,
      action.id,
      '(still running)'
    );

    dangerActionState[key] = { running: true, lastResult: null };
    // Deliberately just the action label, not who triggered it - this string
    // flows straight into the site-wide banner and the "already in progress"
    // messages other people see, which shouldn't expose someone's name.
    startReset(action.label);

    const otherSubscribers = db
      .prepare(
        `SELECT DISTINCT u.id, u.email, u.name FROM subscriptions s
         JOIN users u ON u.id = s.user_id
         WHERE s.plan_id = ? AND s.status = 'active' AND u.id != ?`
      )
      .all(action.plan_id, req.user.id);
    notifyResetStarted(otherSubscribers);

    runCommand(target, action.command, 15 * 60 * 1000)
      .then((result) => {
        db.prepare('UPDATE action_log SET success = ?, output = ? WHERE id = ?').run(
          result.success ? 1 : 0,
          result.output,
          info.lastInsertRowid
        );
        if (result.success) {
          resetIfLinkedAction(action.plan_id, action.id);
        }
        dangerActionState[key] = {
          running: false,
          lastResult: {
            ok: result.success,
            message: result.success ? `"${action.label}" completed successfully.` : `"${action.label}" failed: ${result.output}`,
          },
        };
        endReset();
      })
      .catch((err) => {
        db.prepare('UPDATE action_log SET success = 0, output = ? WHERE id = ?').run(err.message, info.lastInsertRowid);
        dangerActionState[key] = { running: false, lastResult: { ok: false, message: `"${action.label}" failed: ${err.message}` } };
        endReset();
      });

    return res.json({
      ok: true,
      started: true,
      message: `"${action.label}" started in the background — this can take several minutes.`,
      nextAllowedAt,
    });
  }

  const result = await runCommand(target, action.command);

  db.prepare('INSERT INTO action_log (user_id, plan_action_id, success, output) VALUES (?, ?, ?, ?)').run(
    req.user.id,
    action.id,
    result.success ? 1 : 0,
    result.output
  );

  if (result.success) {
    resetIfLinkedAction(action.plan_id, action.id);
  }

  res.json({
    ok: result.success,
    message: result.success
      ? `"${action.label}" completed successfully.`
      : `"${action.label}" failed: ${result.output}`,
    nextAllowedAt: result.success ? nextAllowedAt : null,
  });
});

router.get('/dashboard/actions/:actionId/status', (req, res) => {
  const key = `${req.user.id}:${req.params.actionId}`;
  res.json(dangerActionState[key] || { running: false, lastResult: null });
});

// Dedicated page (not embedded in the dashboard) - just renders the shell;
// the actual data comes from the JSON endpoint below via fetch.
router.get('/watch-history', (req, res) => {
  res.render('watch-history');
});

// Plex watch history via Tautulli, scoped to just this subscriber's own
// Plex username - the API key never leaves the server.
router.get('/dashboard/plex/history', async (req, res) => {
  if (!res.locals.hasPlexPlan) {
    return res.json({ ok: false, message: 'This is only available on a Plex plan.' });
  }

  const userRecord = db.prepare('SELECT plex_username FROM users WHERE id = ?').get(req.user.id);
  const settings = getAllSettings();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const afterDate = typeof req.query.after === 'string' ? req.query.after.trim() : null;

  const result = await getWatchHistory(settings.tautulli_url, settings.tautulli_api_key, userRecord ? userRecord.plex_username : null, page, 15, afterDate);

  if (result.ok) {
    result.items = result.items.map((item) => ({
      ...item,
      watchedAtLabel: item.watchedAtIso ? formatUK(item.watchedAtIso) : '',
    }));
  }

  res.json(result);
});

// Currently-playing session(s) for this subscriber only, for the "Now
// Watching" card on the dashboard homepage.
router.get('/dashboard/plex/now-watching', async (req, res) => {
  if (!res.locals.hasPlexPlan) {
    return res.json({ ok: false, message: 'This is only available on a Plex plan.' });
  }

  const userRecord = db.prepare('SELECT plex_username FROM users WHERE id = ?').get(req.user.id);
  const settings = getAllSettings();

  const result = await getNowWatching(settings.tautulli_url, settings.tautulli_api_key, userRecord ? userRecord.plex_username : null);

  if (result.ok) {
    result.items = await Promise.all(
      result.items.map(async (item) => ({
        ...item,
        // The browser never talks to Tautulli directly (that would mean
        // exposing the API key), so every poster is served through our own
        // proxy route below instead of Tautulli's URL.
        posterUrl: item.posterPath ? `/dashboard/plex/poster?path=${encodeURIComponent(item.posterPath)}` : null,
        location: await getGeoLookup(settings.tautulli_url, settings.tautulli_api_key, item.ipAddress),
      }))
    );
  }

  res.json(result);
});

// Server-side poster image proxy - keeps the Tautulli API key off the
// client entirely. Only accepts plausible internal Plex metadata paths,
// not arbitrary strings, as basic defense in depth.
router.get('/dashboard/plex/poster', async (req, res) => {
  if (!res.locals.hasPlexPlan) return res.status(403).end();

  const path = String(req.query.path || '');
  if (!/^\/library\/metadata\/[a-zA-Z0-9/_.-]+$/.test(path) || path.includes('..')) {
    return res.status(400).end();
  }

  const settings = getAllSettings();
  const image = await fetchPosterImage(settings.tautulli_url, settings.tautulli_api_key, path);

  if (!image) return res.status(404).end();

  res.setHeader('Content-Type', image.contentType);
  res.setHeader('Cache-Control', 'private, max-age=300'); // posters don't change minute to minute
  res.send(image.buffer);
});

function adminEmails() {
  return db.prepare("SELECT email FROM users WHERE role = 'admin'").all().map((r) => r.email);
}

// Lets a Minecraft subscriber request a world seed reset without needing
// to write out a support ticket by hand - opens one automatically, tagged
// so it can be found again, and blocks a second request for the same
// plan while one's still open (avoids duplicate/conflicting resets being
// actioned at once).
router.post('/dashboard/plans/:planId/request-seed-reset', async (req, res) => {
  const subscription = db
    .prepare(`SELECT s.* FROM subscriptions s WHERE s.user_id = ? AND s.plan_id = ? AND s.status = 'active'`)
    .get(req.user.id, req.params.planId);
  if (!subscription) return res.status(403).json({ ok: false, message: 'No active subscription found for this plan.' });

  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.planId);
  if (!plan || plan.service !== 'minecraft') return res.status(400).json({ ok: false, message: 'This is only available on a Minecraft plan.' });

  const existing = db
    .prepare(
      `SELECT id FROM tickets WHERE user_id = ? AND plan_id = ? AND category = 'minecraft_seed_reset' AND status != 'closed' LIMIT 1`
    )
    .get(req.user.id, plan.id);
  if (existing) {
    return res.status(409).json({ ok: false, message: "You already have a world seed reset request pending for this plan - it hasn't been actioned yet, so a new one can't be opened until that's resolved." });
  }

  const subject = `World Seed Reset Request - ${plan.name}`;
  const message = `${req.user.name} requested a world seed reset for their "${plan.name}" plan via the dashboard.`;

  const info = db
    .prepare('INSERT INTO tickets (user_id, subject, category, status, plan_id) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, subject, 'minecraft_seed_reset', 'open', plan.id);

  db.prepare(
    'INSERT INTO ticket_messages (ticket_id, sender_role, sender_name, message) VALUES (?, ?, ?, ?)'
  ).run(info.lastInsertRowid, 'subscriber', req.user.name, message);

  const recipients = adminEmails();
  if (recipients.length > 0) {
    const siteName = getAllSettings().site_name;
    const ticketUrl = `${getSiteBaseUrl(req)}/admin/tickets/${info.lastInsertRowid}`;
    await sendMail({
      to: recipients.join(','),
      subject: `New ticket: ${subject}`,
      bodyHtml: `
        <p>${req.user.name} (${req.user.email}) requested a world seed reset on ${siteName}:</p>
        <p style="background:#0b1220;border-radius:10px;padding:16px;white-space:pre-wrap;">${message}</p>
        <p><a href="${ticketUrl}" style="display:inline-block;background:#0ea5e9;color:#0b0f1a;font-weight:700;padding:12px 20px;border-radius:10px;text-decoration:none;">View Ticket</a></p>
      `,
    }).catch(() => {});
  }

  res.json({ ok: true, message: "World seed reset requested - you'll get an email once it's actioned.", ticketId: info.lastInsertRowid });
});

module.exports = router;
