require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { attachUser, requireLogin, requireAdmin } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const adminRoutes = require('./routes/admin');

if (!process.env.JWT_SECRET || !process.env.CREDENTIAL_ENC_KEY) {
  console.error('Missing JWT_SECRET or CREDENTIAL_ENC_KEY in environment. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const app = express();

// Running behind a reverse proxy (Authentik, Nginx, Traefik, etc.), so Express
// needs to know it can trust the X-Forwarded-For header for things like
// express-rate-limit and req.protocol/secure cookies to work correctly.
// TRUST_PROXY can be overridden in .env if you have more than one proxy hop
// in front of this container (e.g. TRUST_PROXY=2).
app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(attachUser);

app.get('/', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/dashboard');
  res.redirect('/login');
});

app.use(authRoutes);
app.use(requireLogin, dashboardRoutes);
app.use(requireAdmin, adminRoutes);

app.use((req, res) => {
  res.status(404).render('error', { message: 'Page not found.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KyberBOX portal listening on port ${PORT}`);
});
