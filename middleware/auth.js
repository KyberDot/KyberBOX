const jwt = require('jsonwebtoken');
const db = require('../db');
const { getSetting } = require('../utils/settings');
const { formatUK, formatUKDate, formatMoney, utcToLondonInputValue } = require('../utils/time');
const { serviceLabel } = require('../utils/labels');
const { applyAutoRenewals, applyManualExpirations, applyExpiryWarnings } = require('../utils/renewals');
const { attemptAutoLinkPlexUsername } = require('../utils/plexAccess');
const { getResetState } = require('../utils/resetLock');

function attachUser(req, res, next) {
  const token = req.cookies.kb_session;
  req.user = null;
  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(payload.id);
      if (user) req.user = user;
    } catch (_) {
      // invalid/expired token - treat as logged out
    }
  }

  if (req.user) {
    try {
      applyAutoRenewals();
      applyManualExpirations();
    } catch (err) {
      console.error('[renewals] failed:', err.message);
    }
    // Fire-and-forget: sends emails, so it shouldn't hold up the response.
    applyExpiryWarnings().catch((err) => console.error('[expiry-warnings] failed:', err.message));
  }

  res.locals.currentUser = req.user;
  res.locals.siteName = getSetting('site_name', process.env.SITE_NAME || 'KyberBOX');
  res.locals.faviconPath = getSetting('favicon_path', '/img/fav.ico');
  res.locals.appleIconPath = getSetting('apple_icon_path', '/img/fav.png');
  // Only subscribers with an active plan on the Plex service (or a
  // "multiple services" plan that includes it) should ever see the Watch
  // History link/page - computed once here so nav.ejs and any route can
  // both rely on it without duplicating the query.
  res.locals.hasPlexPlan = req.user && req.user.role === 'subscriber'
    ? !!db.prepare(
        `SELECT 1 FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
         WHERE s.user_id = ? AND s.status = 'active' AND (p.service = 'plex' OR p.service = 'multiple')
         LIMIT 1`
      ).get(req.user.id)
    : false;
  // The soonest-expiring active manual-renewal subscription within its
  // final 3 days, if any - drives the "X days" badge in the side menu.
  // Auto-renew subscriptions never appear here since they don't expire.
  res.locals.expiringSoon = req.user && req.user.role === 'subscriber'
    ? db.prepare(
        `SELECT plan_name, expires_at FROM subscriptions
         WHERE user_id = ? AND renewal_mode = 'manual' AND status = 'active'
           AND expires_at IS NOT NULL AND expires_at >= date('now') AND expires_at <= date('now', '+3 days')
         ORDER BY expires_at ASC LIMIT 1`
      ).get(req.user.id)
    : null;
  if (res.locals.expiringSoon) {
    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
    const expiry = new Date(String(res.locals.expiringSoon.expires_at).slice(0, 10) + 'T00:00:00Z');
    res.locals.expiringSoon.days = Math.max(0, Math.round((expiry - today) / (1000 * 60 * 60 * 24)));
  }
  // Fire-and-forget: if they're on a Plex plan but haven't been linked yet
  // (they haven't accepted the invite, or did but nobody ran a manual
  // sync), try to link them by matching their email against Plex's shared
  // users - this is what makes watch history/now-watching start working
  // on its own the moment they accept, without an admin needing to do
  // anything. Internally rate-limited, so this is cheap to call on every
  // page load even before they've accepted.
  if (res.locals.hasPlexPlan) {
    attemptAutoLinkPlexUsername(req.user.id).catch(() => {});
  }
  // Available in every EJS template so all dates/prices/labels render
  // consistently in UK time and the plan's chosen currency without each
  // route wiring it up individually.
  res.locals.formatUK = formatUK;
  res.locals.formatUKDate = formatUKDate;
  res.locals.formatMoney = formatMoney;
  res.locals.utcToLondonInputValue = utcToLondonInputValue;
  res.locals.serviceLabel = serviceLabel;
  res.locals.resetInProgress = getResetState();
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') return res.status(403).render('error', { message: 'Admins only.' });
  next();
}

module.exports = { attachUser, requireLogin, requireAdmin };
