const jwt = require('jsonwebtoken');
const db = require('../db');
const { getSetting } = require('../utils/settings');
const { formatUK, formatUKDate, formatMoney, utcToLondonInputValue } = require('../utils/time');

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
  res.locals.currentUser = req.user;
  res.locals.siteName = getSetting('site_name', process.env.SITE_NAME || 'KyberBOX');
  // Available in every EJS template so all dates/prices render consistently
  // in UK time and the plan's chosen currency without each route wiring it up.
  res.locals.formatUK = formatUK;
  res.locals.formatUKDate = formatUKDate;
  res.locals.formatMoney = formatMoney;
  res.locals.utcToLondonInputValue = utcToLondonInputValue;
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
