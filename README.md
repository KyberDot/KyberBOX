# KyberBOX Client Portal

A self-hosted client portal for KyberBOX. Subscribers log in to see the
plan they're on — its features, live server/container health, and its
action buttons (like a rate-limited Plex restart) — and can raise support
tickets. Admins define Plans once, assign clients to them, answer tickets,
and manage email delivery, all from a dashboard styled to match the
existing KyberBOX site and built to work on phones as well as desktop.

## Features

- **Plans, not per-user config** — an admin defines a Plan once (e.g. "Plex
  Standard"): its feature list, the shared SSH server it acts on, which
  action buttons appear (e.g. "Restart Plex"), and which containers' live
  health is shown. Assigning a client to that plan gives them all of it
  instantly — no per-user server setup.
- **Pricing & renewal dates** — each plan can have a price in GBP, USD, or
  CAD, shown to subscribers alongside their renewal date.
- **Payment methods** — managed from Admin → Settings (name only for now,
  e.g. "Bank Transfer", "PayPal"); assign one to each client from Admin →
  Users and it shows on their dashboard.
- **Maintenance mode** — admin can flip a plan into maintenance mode with
  an expected resume time (entered in UK time); subscribers on that plan
  see a banner reading e.g. "Plex is under maintenance" and its action
  buttons are disabled until it's turned off.
- **Admin Health page** — a global, admin-only view of any container in
  your compose stack (not tied to a single plan), shown as a grid of
  compact cards. Each container can have a logo (with a choice of dark
  box, white background for transparent logos, or no border at all), an
  optional link that opens when its name/image is clicked, a live log
  snapshot viewer, Stop/Restart, and arrows to reorder them. A **Bulk
  Actions** mode lets you select several containers and stop/restart them
  all in one combined command. Its SSH access (separate from any plan's
  own) is configured once from Admin → Settings. A container that's
  genuinely down (stopped, removed) shows as **Offline**; **Unknown** is
  reserved for when the server itself can't be reached at all.
- **SSH Console** — a command runner auto-authenticated with the same
  saved server access, for one-off commands without leaving the browser.
  It runs one command per request (not a full interactive terminal), and
  keeps a history of what was run and when.
- **Nothing reloads the page** — creating/editing users, plans, and Health
  containers all happen in place via background requests, so you stay
  exactly where you were (scroll position, open sections) instead of
  bouncing back to the top of a freshly reloaded page.
- **Everything in UK time** — all dates, renewal dates, cooldown timers,
  and maintenance resume times are displayed in Europe/London time
  (handling BST/GMT automatically), regardless of server or visitor timezone.
- **Invite-only accounts** — no public signup. Admin creates each client
  account and assigns it to a Plan (or leaves it unassigned for later).
- **Live container health** — each plan can list containers (e.g. `plex`,
  `tautulli`) whose status is checked over SSH and shown to subscribers as
  Online / Starting / Unhealthy / Offline, fetched asynchronously so it
  never blocks the dashboard from loading.
- **Rate-limited action buttons** — each plan can have any number of
  action buttons (not just Plex restart) mapped to a fixed admin-defined
  command, each with its own cooldown (e.g. once every 6 hours). Subscribers
  only ever click a button; they never type or influence the command that
  runs on the server.
- **Support tickets, on their own page** — clients raise and track tickets
  from a dedicated **Support** page (next to Dashboard), separate from
  their plan cards. Admins see every ticket in one inbox and reply from
  the portal.
- **Self-service Account page** — clients can change their own password
  or email address from **Account**, without admin help.
- **Admin can edit any client's details** — name and email can be updated
  by an admin at any time from Admin → Users, not just at invite time.
- **Auto-renew / manual renew / mark expired** — when an admin sets a
  client's renewal date, they choose whether it auto-renews monthly on
  its own, needs the admin to manually renew it, or should be marked
  expired immediately.
- **Maintenance-mode email alerts** — the moment a plan is switched into
  maintenance mode, every active subscriber on it gets an email (using
  the same branded template) explaining what's affected and when it's
  expected back.
- **Custom favicon & iOS home-screen icon** — set both from Admin →
  Settings → Branding; the iOS icon is what shows when a client adds the
  site to their iPhone home screen via Safari, making it look like a
  real app.
- **Email notifications** — client invites, admin-triggered password
  resets, self-service "forgot password" links, ticket creation/replies,
  and maintenance-mode alerts are all emailed automatically once SMTP is
  configured from the in-app Settings page. Emails carry your actual logo
  (embedded directly in the email, not a hotlinked image, so it displays
  reliably across mail clients).
- **Encrypted server credentials** — SSH passwords/keys and the SMTP
  password are encrypted at rest (AES-256-GCM) with a key you control.
- **Mobile-friendly throughout** — every page (login, dashboard, admin)
  is responsive, with a collapsible menu on small screens. The login page
  is sized to fit the screen without scrolling on typical phone/desktop
  viewports.
- **Built by GitHub, deployed by Compose** — a GitHub Actions workflow
  builds the Docker image and publishes it to GitHub Container Registry
  (GHCR) on every push to `main`, so your server just pulls a ready-made
  image instead of building on the box itself.

## 1. Get it into your GitHub repo (GitHub Desktop)

1. Unzip this project on your computer.
2. In GitHub Desktop: **File → Add Local Repository**, and point it at the
   unzipped `kyberbox-portal` folder.
3. If it says the folder isn't a repository yet, click **create a
   repository** — GitHub Desktop will pick up the included `.gitignore`
   automatically (so `node_modules/`, `.env`, and the SQLite database
   never get committed).
4. Write a commit summary and click **Commit to main**, then **Publish repository**.

Publishing pushes to `main`, which automatically triggers
`.github/workflows/docker-publish.yml` on GitHub. That workflow builds the
image and pushes it to GHCR. `docker-compose.yml` in this project is
already pointed at `ghcr.io/kyberdot/kyberbox:latest` — check the
**Actions** tab on GitHub to watch the build.

## 2. Configure the server that will run it

```bash
cp .env.example .env
```

Edit `.env` and set:

- `JWT_SECRET` — random string, e.g. `openssl rand -hex 32`
- `CREDENTIAL_ENC_KEY` — a **different** random 64-char hex string, e.g.
  `openssl rand -hex 32` (run it twice — these two must not match each other)
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — your first admin login (created
  automatically on first boot, only if no admin exists yet)
- `TRUST_PROXY` — only needed if you're running this behind more than one
  reverse proxy hop; defaults to `1`, which is correct behind a single
  proxy (e.g. Authentik, Traefik, Nginx)

## 3. Run it

```bash
docker compose pull
docker compose up -d
```

Log in with the admin credentials from `.env`.

## 4. Set up your first Plan (Admin → Plans)

This replaces per-user server configuration entirely — you configure a
plan once and every subscriber on it inherits its access and features.

1. **Create the plan**: name (e.g. "Plex Standard"), service category, an
   optional description, and a features list (one bullet per line — this
   is exactly what subscribers see on their dashboard).
2. **Server / SSH Access**: host, port, username, and either a password or
   private key. This is shared by every client on this plan.
3. **Action Buttons**: add as many as you want. Each needs a label (e.g.
   "Restart Plex"), the exact command to run (e.g.
   `docker compose restart plex`), and a cooldown in hours. Subscribers
   only ever click the button — they can't see or edit the command.
4. **Container Health**: add the exact container name(s) from your compose
   file (e.g. `plex`) with a friendly label (e.g. "Plex Server"). Their
   live status shows on the subscriber's dashboard.

Then go to **Admin → Users → Invite a New Client** and assign them to
that plan — that's it, they'll see everything the plan defines the moment
they log in.

**Security tip:** scope each plan's SSH account narrowly (e.g. a restricted
key with `authorized_keys` `command=` locking it to only that plan's
actions) so a compromised portal has minimal blast radius.

## 5. Set up email (Admin → Settings)

Nothing is emailed until you configure SMTP here: host, port, username,
password, and the "from" name/address. Works with any standard SMTP
provider. Use **Send Test Email to Myself** to confirm it works.

| Event | Email sent to |
|---|---|
| Admin invites a client | The new client (account + temp password) |
| Admin resets a client's password | That client |
| Client uses "Forgot password?" | That client (time-limited reset link) |
| Client opens a ticket | All admin accounts |
| Client replies to a ticket | All admin accounts |
| Admin replies to a ticket | That client |

If SMTP isn't configured, the portal still works — invite/reset passwords
are shown once on-screen for you to copy, and the admin overview page
shows a banner reminding you to finish mail setup.

## 6. Security notes

- Credentials (SSH + SMTP) are encrypted at rest, but whoever holds
  `CREDENTIAL_ENC_KEY` and access to the running container can decrypt
  them — treat that key and your server the same way you'd treat any
  other secrets store.
- Put this behind HTTPS before exposing it publicly — login cookies are
  only marked `secure` when served over HTTPS.
- Action commands and container names are always admin-supplied.
  Subscribers can only trigger a predefined action; they never type or
  influence any command that reaches a server.
- Password reset links expire after 30 minutes and can only be used once.

## 7. Project structure

```
kyberbox-portal/
├── .github/workflows/docker-publish.yml   # builds & pushes image to GHCR
├── server.js              # Express app entry point (trust proxy, uploads static mount)
├── db.js                  # SQLite schema: users, plans, subscriptions, tickets, settings
├── middleware/auth.js     # session/auth guards, injects site name/branding/formatters
├── utils/crypto.js        # AES-256-GCM encrypt/decrypt for secrets
├── utils/ssh.js           # runs plan/admin actions + container health checks over SSH
├── utils/mailer.js        # nodemailer wrapper with embedded logo
├── utils/settings.js      # admin-configurable settings (SMTP, site URL, branding)
├── utils/time.js          # UK (Europe/London) date/time and currency formatting
├── utils/renewals.js      # auto-renew logic for subscriptions
├── utils/labels.js        # friendly service-category labels (for maintenance banners etc.)
├── utils/uploads.js       # multer config for favicon/apple-touch-icon uploads
├── routes/auth.js         # login / logout / password change / forgot-reset
├── routes/dashboard.js    # client dashboard: plan features, health checks, actions
├── routes/support.js      # client Support page: tickets list, raise/reply to tickets
├── routes/account.js      # client self-service: change password / email
├── routes/admin.js        # Plans, Users, Payment Methods, Tickets, Settings, Health
├── views/                 # EJS templates (mobile-responsive, matching KyberBOX design)
├── public/                # static assets (logo, default favicon, CSS)
│   └── js/admin-ajax.js   # shared no-page-refresh form handling for the admin panel
├── Dockerfile
├── docker-compose.yml         # production - pulls prebuilt image from GHCR
└── docker-compose.build.yml   # alternative - builds the image locally
```

Admin-uploaded branding (favicon, Apple touch icon) and the SQLite database
both live in the `data/` directory inside the container, which is the
`kyberbox-data` Docker volume — so they persist across image rebuilds and
redeploys, unlike anything under `public/`.

## 8. Local development (without Docker)

```bash
npm install
cp .env.example .env   # fill it in
npm start
```
