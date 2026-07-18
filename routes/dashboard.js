const express = require('express');
const db = require('../db');
const { runCommand, getContainerStatuses } = require('../utils/ssh');

const router = express.Router();

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
    nextAllowedAt: result.success && action.cooldown_hours > 0
      ? new Date(Date.now() + action.cooldown_hours * 60 * 60 * 1000).toISOString()
      : null,
  });
});

module.exports = router;
