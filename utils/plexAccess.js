// Keeps a subscriber's Plex library access in sync with their subscription
// state, via Wizarr rather than talking to Plex's sharing API directly -
// direct Plex invites by email don't reliably work for people Plex
// doesn't already know about, and Wizarr's own team has already solved
// the quirks involved (it uses an invite-link-and-accept model: creating
// an invitation doesn't grant access immediately, the person has to visit
// the link and authenticate with Plex first).
//
// Called whenever something that could change what someone should have
// access to happens: a plan gets assigned, a subscription is renewed, or
// one expires - plus periodically in the background, to notice once a
// pending invite has actually been accepted.

const db = require('../db');
const { getAllSettings } = require('./settings');
const { getSharedUsers } = require('./plex');
const wizarr = require('./wizarr');
const { sendMail } = require('./mailer');

// Don't hit Plex/Wizarr more than this often for the same pending case -
// someone who hasn't accepted their invite yet will fail this lookup on
// every visit otherwise, and there's no need to hammer either API over it.
const LINK_RETRY_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Recomputes what library access `userId` should have right now, based on
 * their active subscriptions, and makes Wizarr match that - creating (and
 * emailing) an invitation if they should have access and don't yet,
 * confirming/no-op-ing if they've already accepted with the right
 * libraries, or removing them from Wizarr if access should be revoked.
 * Safe to call any time; does nothing if Wizarr isn't configured or the
 * user isn't on any Plex-service plan.
 */
async function syncPlexAccessForUser(userId) {
  const settings = getAllSettings();
  if (!settings.wizarr_url || !settings.wizarr_api_key) {
    return { ok: false, skipped: true, message: 'Wizarr is not fully configured yet.' };
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return { ok: false, message: 'User not found.' };

  // Union of library ids across every ACTIVE plex/multiple-service
  // subscription this person has - covers the (unusual but possible) case
  // of someone on more than one Plex-granting plan at once.
  const activePlexSubs = db
    .prepare(
      `SELECT p.plex_library_section_ids FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = ? AND s.status = 'active' AND p.service IN ('plex', 'multiple')`
    )
    .all(userId);

  const planLibraryIds = [
    ...new Set(
      activePlexSubs
        .flatMap((s) => String(s.plex_library_section_ids || '').split(','))
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ];

  // A per-user override (even an empty one, meaning "none of them")
  // refines exactly which of the plan's libraries this specific person
  // gets - it only ever narrows/customizes within an existing Plex plan,
  // never grants access on its own to someone with no active plan at all.
  const hasOverride = user.plex_library_override !== null && user.plex_library_override !== undefined;
  const libraryIds = activePlexSubs.length === 0
    ? []
    : hasOverride
      ? String(user.plex_library_override).split(',').map((id) => id.trim()).filter(Boolean)
      : planLibraryIds;

  const shouldHaveAccess = libraryIds.length > 0;

  // ---------- Should NOT have access ----------
  if (!shouldHaveAccess) {
    if (user.wizarr_user_id) {
      const result = await wizarr.deleteUser(settings.wizarr_url, settings.wizarr_api_key, user.wizarr_user_id);
      if (result.ok) {
        db.prepare(
          `UPDATE users SET wizarr_user_id = NULL, wizarr_invite_code = NULL, plex_shared_server_id = NULL, plex_library_synced_sections = NULL WHERE id = ?`
        ).run(userId);
      }
      return { ok: result.ok, action: 'revoked', message: result.message };
    }
    if (user.wizarr_invite_code) {
      // Never accepted - nothing to actively revoke on Wizarr's side
      // (there's no confirmed API to delete a specific pending invite by
      // code without its invitation id, which isn't tracked), but clear
      // our own record so we stop treating it as something owed to them.
      db.prepare(`UPDATE users SET wizarr_invite_code = NULL WHERE id = ?`).run(userId);
    }
    return { ok: true, action: 'none' };
  }

  // ---------- Should have access ----------
  const currentlySynced = new Set(String(user.plex_library_synced_sections || '').split(',').map((id) => id.trim()).filter(Boolean));
  const desiredSet = new Set(libraryIds);
  const alreadyCorrect = user.wizarr_user_id && currentlySynced.size === desiredSet.size && [...desiredSet].every((id) => currentlySynced.has(id));
  if (alreadyCorrect) {
    return { ok: true, action: 'none' }; // already accepted, with the right libraries - nothing to do
  }

  if (!user.email) return { ok: false, message: 'This user has no email address to invite.' };

  // Already accepted, but the libraries they should have has changed -
  // Wizarr's API has no "update an existing user's libraries" endpoint,
  // only invite-time configuration, so this means removing and re-
  // inviting them rather than an in-place change.
  if (user.wizarr_user_id) {
    await wizarr.deleteUser(settings.wizarr_url, settings.wizarr_api_key, user.wizarr_user_id);
    db.prepare(`UPDATE users SET wizarr_user_id = NULL, plex_shared_server_id = NULL, plex_library_synced_sections = NULL WHERE id = ?`).run(userId);
  }

  const serversResult = await wizarr.getServers(settings.wizarr_url, settings.wizarr_api_key);
  if (!serversResult.ok) return { ok: false, message: serversResult.message };
  // The libraries picked determine which server(s) this invitation needs
  // to cover - derived from the servers those specific libraries belong
  // to, rather than asking an admin to separately pick a server too.
  const librariesResult = await wizarr.getLibraries(settings.wizarr_url, settings.wizarr_api_key);
  if (!librariesResult.ok) return { ok: false, message: librariesResult.message };
  const serverIds = [
    ...new Set(
      librariesResult.libraries
        .filter((lib) => libraryIds.includes(String(lib.id)))
        .map((lib) => String(lib.server_id))
        .filter(Boolean)
    ),
  ];
  if (serverIds.length === 0) return { ok: false, message: 'Could not determine which server(s) these libraries belong to.' };

  const inviteResult = await wizarr.createInvitation(settings.wizarr_url, settings.wizarr_api_key, {
    serverIds,
    libraryIds,
    duration: 'unlimited',
  });

  if (!inviteResult.ok) return { ok: false, action: 'granted', message: inviteResult.message };

  db.prepare(
    `UPDATE users SET wizarr_invite_code = ?, wizarr_invite_sent_at = datetime('now'), plex_library_synced_sections = ? WHERE id = ?`
  ).run(inviteResult.code, libraryIds.join(','), userId);

  if (inviteResult.url) {
    const siteName = settings.site_name || 'KyberBOX';
    await sendMail({
      to: user.email,
      subject: `Your Plex access is ready - ${siteName}`,
      bodyHtml: `
        <p>Hi ${user.name},</p>
        <p>You've been granted access to Plex. Click below to accept the invitation and get set up:</p>
        <p><a href="${inviteResult.url}" style="display:inline-block;background:#0ea5e9;color:#0b0f1a;font-weight:700;padding:12px 20px;border-radius:10px;text-decoration:none;">Accept Plex Invitation</a></p>
        <p>If the button doesn't work, copy this link into your browser: ${inviteResult.url}</p>
      `,
    }).catch(() => {});
  }

  return { ok: true, action: 'granted', message: 'Invitation created and emailed - access will be confirmed once they accept it.' };
}

/**
 * Checks everyone with a pending Wizarr invite against Wizarr's actual
 * current user list - once someone shows up there (matched by email),
 * their invite has been accepted and access is genuinely live, not just
 * sent. This is what makes "PLEX SYNCED" reflect reality instead of just
 * "an email went out at some point".
 */
async function checkPendingWizarrInvites() {
  const settings = getAllSettings();
  if (!settings.wizarr_url || !settings.wizarr_api_key) return;

  const pending = db.prepare(`SELECT id, email FROM users WHERE wizarr_invite_code IS NOT NULL AND wizarr_user_id IS NULL`).all();
  if (pending.length === 0) return;

  const result = await wizarr.getUsers(settings.wizarr_url, settings.wizarr_api_key);
  if (!result.ok) return;

  const byEmail = new Map();
  result.users.forEach((u) => {
    if (u.email) byEmail.set(String(u.email).toLowerCase().trim(), u);
  });

  pending.forEach((p) => {
    const match = byEmail.get(String(p.email || '').toLowerCase().trim());
    if (!match) return; // not accepted yet
    db.prepare(`UPDATE users SET wizarr_user_id = ?, wizarr_invite_code = NULL WHERE id = ?`).run(String(match.id), p.id);
  });
}

/**
 * Tries to fill in a subscriber's Plex username automatically, without an
 * admin needing to click "Sync from Plex" - this is what makes their
 * watch history / now-watching actually start working the moment they
 * accept the invite (whether that meant creating a brand-new Plex account
 * or just accepting the share on one they already had), rather than
 * requiring a manual step afterwards. Matches by email, same as the
 * manual sync. Rate-limited per user so an invite that hasn't been
 * accepted yet doesn't trigger a Plex API call on every single page load.
 */
async function attemptAutoLinkPlexUsername(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || user.plex_username) return; // already linked, or no such user - nothing to do

  if (user.plex_link_attempted_at) {
    const elapsed = Date.now() - new Date(user.plex_link_attempted_at).getTime();
    if (elapsed < LINK_RETRY_INTERVAL_MS) return; // tried too recently, skip this time
  }

  const settings = getAllSettings();
  if (!settings.plex_token || !user.email) return;

  db.prepare(`UPDATE users SET plex_link_attempted_at = datetime('now') WHERE id = ?`).run(userId);

  const result = await getSharedUsers(settings.plex_token);
  if (!result.ok) return;

  const targetEmail = user.email.toLowerCase().trim();
  const match = result.users.find((u) => u.email === targetEmail);
  if (!match) return; // not accepted yet - will try again after the retry interval

  db.prepare('UPDATE users SET plex_username = ?, plex_user_id = ? WHERE id = ?').run(match.username, match.id, userId);
}

/**
 * Finds every subscriber on an active Plex-granting plan who hasn't been
 * linked yet and attempts to link each of them (still individually
 * rate-limited, so this is cheap to call often). Used both when an admin
 * opens the Users page and by the background scheduler, so linking
 * genuinely doesn't depend on anyone visiting the site at all.
 */
async function attemptAutoLinkAllPending() {
  const unlinked = db
    .prepare(
      `SELECT DISTINCT u.id FROM users u
       JOIN subscriptions s ON s.user_id = u.id
       JOIN plans p ON p.id = s.plan_id
       WHERE u.role = 'subscriber' AND u.plex_username IS NULL
         AND s.status = 'active' AND p.service IN ('plex', 'multiple')`
    )
    .all();

  await Promise.all(unlinked.map((row) => attemptAutoLinkPlexUsername(row.id).catch(() => {})));
}

/**
 * Retries syncPlexAccessForUser for anyone whose Plex-linked account is on
 * an active Plex-granting plan - cheap to call often since the function
 * itself now no-ops instantly for anyone already correctly synced, and is
 * individually rate-limited per user so a persistently-failing account
 * (misconfiguration, Plex rejecting it, etc.) doesn't get hammered every
 * cycle. This is what makes a failed sync actually resolve itself once
 * the underlying issue is fixed, instead of staying stuck until an admin
 * happens to manually re-trigger it.
 */
async function retryPendingPlexAccessSyncs() {
  const candidates = db
    .prepare(
      `SELECT DISTINCT u.id, u.plex_sync_attempted_at FROM users u
       JOIN subscriptions s ON s.user_id = u.id
       JOIN plans p ON p.id = s.plan_id
       WHERE u.role = 'subscriber' AND u.plex_username IS NOT NULL
         AND s.status = 'active' AND p.service IN ('plex', 'multiple')`
    )
    .all();

  const due = candidates.filter((u) => {
    if (!u.plex_sync_attempted_at) return true;
    return Date.now() - new Date(u.plex_sync_attempted_at).getTime() >= LINK_RETRY_INTERVAL_MS;
  });

  await Promise.all(
    due.map(async (u) => {
      db.prepare(`UPDATE users SET plex_sync_attempted_at = datetime('now') WHERE id = ?`).run(u.id);
      await syncPlexAccessForUser(u.id).catch(() => {});
    })
  );
}

module.exports = { syncPlexAccessForUser, checkPendingWizarrInvites, attemptAutoLinkPlexUsername, attemptAutoLinkAllPending, retryPendingPlexAccessSyncs };
