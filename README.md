# KyberBOX Client Portal

A self-hosted client portal for KyberBOX. Subscribers log in to see their
subscription status, self-service restart their Plex server (rate-limited),
and raise support tickets. Admins invite clients, assign subscriptions,
configure server access, answer tickets, and manage email delivery — all in
one dashboard, styled to match the existing KyberBOX site.

## Features

- **Invite-only accounts** — no public signup. Admin creates each client
  account and assigns their subscription(s): Docker Hosting, Plex, Stream
  Addons, Indexers, Web Hosting, or Multiple Services.
- **Client dashboard** — subscription status/plan/expiry at a glance.
- **Plex self-service restart** — one click, with a confirmation dialog,
  runs a fixed `docker compose restart plex` command over SSH against the
  client's own server. Limited to once every 6 hours per account.
- **Support tickets** — clients can raise a ticket, admins see every ticket
  in one inbox and reply from the portal.
- **Email notifications** — client invites, admin-triggered password
  resets, self-service "forgot password" links, and ticket
  creation/replies are all emailed automatically once SMTP is configured
  from the in-app Settings page.
- **Encrypted server credentials** — SSH passwords/keys and the SMTP
  password are encrypted at rest (AES-256-GCM) with a key you control. The
  restart button only ever runs the single fixed command configured for
  that account — there is no free-form remote command execution anywhere
  in the app.
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
4. Write a commit summary (e.g. "Initial commit") and click **Commit to main**.
5. Click **Publish repository**. Set the name to `kyberbox`, make sure it's
   published under your **KyberDot** account, then click **Publish**.

That's it — no terminal/git commands needed. Publishing pushes to `main`,
which automatically triggers `.github/workflows/docker-publish.yml` on
GitHub. That workflow builds the image and pushes it to:

```
ghcr.io/kyberdot/kyberbox:latest
```

`docker-compose.yml` in this project is already set to that exact path, so
you don't need to edit it. Go to the **Actions** tab on
`github.com/KyberDot/kyberbox` to watch the build — first one takes a
couple of minutes.

> **Make the package pullable:** after the first successful build, go to
> your GitHub profile → **Packages** → the `kyberbox` package → **Package
> settings**, and set visibility to **Public** (simplest for a single
> server you control). If you'd rather keep it private, you'll instead
> need to `docker login ghcr.io` on the server with a
> [Personal Access Token](https://github.com/settings/tokens) that has
> `read:packages` scope before running `docker compose pull`.

## 2. Configure the server that will run it

```bash
cp .env.example .env
```

Edit `.env` and set:

- `JWT_SECRET` — random string, e.g. `openssl rand -hex 32`
- `CREDENTIAL_ENC_KEY` — random 64-char hex string, e.g. `openssl rand -hex 32`
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — your first admin login (created
  automatically on first boot, only if no admin exists yet)

`docker-compose.yml` already points at `ghcr.io/kyberdot/kyberbox:latest`,
so nothing else to change here unless you rename the repo later.

## 3. Run it

```bash
docker compose pull
docker compose up -d
```

The portal will be available at `http://<your-server>:3000`. Log in with
the admin credentials from `.env`, then immediately set a new password
when prompted.

To deploy an update after pushing new code to `main` (and waiting for the
Actions build to finish):

```bash
docker compose pull
docker compose up -d
```

Your data (users, subscriptions, tickets, settings) lives in the
`kyberbox-data` Docker volume and survives rebuilds/restarts/pulls.

**Prefer to build locally instead of pulling from GHCR?** (e.g. for local
development, or if you don't want to use GitHub Actions at all):

```bash
docker compose -f docker-compose.build.yml up -d --build
```

## 4. Set up email (Admin → Settings)

Nothing is emailed until you configure SMTP. Log in as admin, go to
**Settings**, and fill in:

- **General**: site name and public site URL (used to build links inside
  emails — e.g. `https://portal.kyberbox.app`). If left blank, the app
  guesses it from the incoming request.
- **Mail (SMTP)**: host, port, username, password, and the "from" name/
  address. Works with any standard SMTP provider (Gmail app password,
  SendGrid, Mailgun, Amazon SES, your own mail server, etc). Use the
  **Send Test Email to Myself** button to confirm it works before relying
  on it.

Once configured, these are sent automatically:

| Event | Email sent to |
|---|---|
| Admin invites a client | The new client (account + temp password) |
| Admin resets a client's password | That client |
| Client uses "Forgot password?" | That client (time-limited reset link) |
| Client opens a ticket | All admin accounts |
| Client replies to a ticket | All admin accounts |
| Admin replies to a ticket | That client |

If SMTP isn't configured yet, the portal still works — invite/reset
passwords are shown once on-screen for you to copy, and the admin overview
page shows a banner reminding you to finish mail setup.

## 5. Day-to-day admin workflow

1. **Admin → Users → Invite a New Client**: enter their name, email, and
   initial subscription. A temporary password is generated and, once mail
   is set up, emailed to them directly (also shown on-screen as a
   fallback).
2. **Server / SSH Access**: on that same user row, expand "Server / SSH
   Access" and enter the host, SSH username, and either a password or a
   private key, plus the exact restart command to run (defaults to
   `docker compose restart plex`). This is what the client's "Restart
   Plex" button triggers — nothing else.
3. **Tickets**: any ticket a client raises shows up under **Admin →
   Tickets** and triggers an email to all admins. Reply and mark it
   answered/closed from there — the client gets emailed your reply.

## 6. Security notes

- Credentials (SSH + SMTP) are encrypted at rest, but whoever holds
  `CREDENTIAL_ENC_KEY` and access to the running container can decrypt
  them — treat that key and your server the same way you'd treat any
  other secrets store.
- Put this behind HTTPS (e.g. a reverse proxy like Caddy or Nginx with a
  TLS certificate) before exposing it publicly — login cookies are only
  marked `secure` when served over HTTPS.
- Each client's SSH account should ideally be scoped to only run the
  restart command (e.g. via a restricted shell or `authorized_keys`
  `command=` directive) so that even a compromised portal server has
  minimal blast radius.
- Password reset links expire after 30 minutes and can only be used once.
- Rotate a client's temporary password immediately if you suspect it was
  seen by the wrong person — "Reset Password" on their row generates a
  fresh one instantly (and emails it, if mail is set up).

## 7. Project structure

```
kyberbox-portal/
├── .github/workflows/docker-publish.yml   # builds & pushes image to GHCR
├── server.js              # Express app entry point
├── db.js                  # SQLite schema + bootstrap admin
├── middleware/auth.js     # session/auth guards, injects site name
├── utils/crypto.js        # AES-256-GCM encrypt/decrypt for secrets
├── utils/ssh.js           # runs the one allowed restart command via SSH
├── utils/mailer.js        # nodemailer wrapper, reads settings from DB
├── utils/settings.js      # admin-configurable settings (SMTP, site URL)
├── routes/auth.js         # login / logout / password change / forgot-reset
├── routes/dashboard.js    # client dashboard, restart, tickets
├── routes/admin.js        # invite users, subscriptions, SSH, tickets, settings
├── views/                 # EJS templates matching the KyberBOX design
├── public/                # static assets (logo, favicon, CSS)
├── Dockerfile
├── docker-compose.yml         # production - pulls prebuilt image from GHCR
└── docker-compose.build.yml   # alternative - builds the image locally
```

## 8. Local development (without Docker)

```bash
npm install
cp .env.example .env   # fill it in
npm start
```
