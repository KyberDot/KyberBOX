const jwt = require('jsonwebtoken');
const db = require('../db');
const { getSetting } = require('../utils/settings');
const { formatUK, formatUKDate, formatMoney, utcToLondonInputValue } = require('../utils/time');
const { serviceLabel } = require('../utils/labels');
const { applyAutoRenewals } = require('../utils/renewals');
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
    } catch (err) {
      console.error('[auto-renew] failed:', err.message);
    }
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
