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
