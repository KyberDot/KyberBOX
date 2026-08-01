// Keeps a subscriber's Plex library access in sync with their subscription
// state. Called whenever something that could change what they should have
// access to happens: a plan gets assigned, a subscription is renewed, or
// one expires. Never called on a timer/poll - only on actual state changes,
// so normal page loads never wait on a Plex API round-trip.

const db = require('../db');
const { getAllSettings } = require('./settings');
const { shareLibraries, unshareServer, getSharedUsers } = require('./plex');

// Don't hit Plex more than this often for the same unlinked user - someone
// who hasn't accepted their invite yet will fail this lookup on every
// visit otherwise, and there's no need to hammer plex.tv over it.
const LINK_RETRY_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Recomputes what Plex library access `userId` should have right now,
 * based on their active subscriptions, and makes Plex match that -
 * granting/updating a share if they should have access, or revoking it if
 * they shouldn't. Safe to call any time; does nothing if Plex isn't
 * configured or the user isn't on any Plex-service plan.
 */
async function syncPlexAccessForUser(userId) {
  const settings = getAllSettings();
  if (!settings.plex_token || !settings.plex_machine_identifier) {
    return { ok: false, skipped: true, message: 'Plex is not fully configured yet.' };
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return { ok: false, message: 'User not found.' };

  // Union of library sections across every ACTIVE plex/multiple-service
  // subscription this person has - covers the (unusual but possible) case
  // of someone on more than one Plex-granting plan at once.
  const activePlexSubs = db
    .prepare(
      `SELECT p.plex_library_section_ids FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = ? AND s.status = 'active' AND p.service IN ('plex', 'multiple')`
    )
    .all(userId);

  const planSectionIds = [
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
  const sectionIds = activePlexSubs.length === 0
    ? []
    : hasOverride
      ? String(user.plex_library_override).split(',').map((id) => id.trim()).filter(Boolean)
      : planSectionIds;

  const shouldHaveAccess = sectionIds.length > 0;

  // Already exactly matches what's confirmed live - nothing to do. This
  // matters now that syncing can happen periodically in the background
  // (not just when something explicitly changes): without this check,
  // every retry cycle would needlessly tear down and recreate a share
  // that was already correct.
  const currentlySynced = new Set(String(user.plex_library_synced_sections || '').split(',').map((id) => id.trim()).filter(Boolean));
  const desiredSet = new Set(sectionIds);
  const alreadyCorrect = user.plex_shared_server_id && currentlySynced.size === desiredSet.size && [...desiredSet].every((id) => currentlySynced.has(id));
  if (shouldHaveAccess && alreadyCorrect) {
    return { ok: true, action: 'none' };
  }

  if (!shouldHaveAccess) {
    if (!user.plex_shared_server_id) return { ok: true, action: 'none' }; // nothing to do
    const result = await unshareServer({
      plexToken: settings.plex_token,
      clientIdentifier: settings.plex_client_identifier,
      shareId: user.plex_shared_server_id,
    });
    if (result.ok) {
      db.prepare('UPDATE users SET plex_shared_server_id = NULL, plex_library_synced_sections = NULL WHERE id = ?').run(userId);
    }
    return { ok: result.ok, action: 'revoked', message: result.message };
  }

  if (!user.email) return { ok: false, message: 'This user has no email address to invite.' };

  // Whether they already have a share or not, the simplest reliable way to
  // guarantee the section list is correct is to drop any existing share
  // and create a fresh one with the full current set - avoids depending on
  // an "update sections" endpoint this integration hasn't been built
  // against, at the cost of one extra API call when access was already
  // correct.
  if (user.plex_shared_server_id) {
    await unshareServer({
      plexToken: settings.plex_token,
      clientIdentifier: settings.plex_client_identifier,
      shareId: user.plex_shared_server_id,
    });
    // Deliberately not clearing plex_library_synced_sections here yet - if
    // the re-share below fails, "what's actually still live on Plex" is
    // now genuinely unknown (the old share is gone, the new one didn't
    // take), so it's cleared only once we know the real outcome below.
    db.prepare('UPDATE users SET plex_shared_server_id = NULL WHERE id = ?').run(userId);
  }

  const shareResult = await shareLibraries({
    plexToken: settings.plex_token,
    clientIdentifier: settings.plex_client_identifier,
    machineIdentifier: settings.plex_machine_identifier,
    sectionIds,
    invitedEmail: user.email,
  });

  if (shareResult.ok && shareResult.shareId) {
    // Only on confirmed success does plex_library_synced_sections get
    // updated to match - this (not plex_library_override, which is just
    // the configured intent) is what the admin UI shows as someone's
    // real, current Plex access.
    db.prepare('UPDATE users SET plex_shared_server_id = ?, plex_library_synced_sections = ? WHERE id = ?').run(shareResult.shareId, sectionIds.join(','), userId);
  } else {
    // The share attempt failed - whatever was live before (if anything)
    // is gone now too, since it was unshared above before retrying. Make
    // that explicit rather than leaving a stale, now-inaccurate value.
    db.prepare('UPDATE users SET plex_library_synced_sections = NULL WHERE id = ?').run(userId);
  }

  return { ok: shareResult.ok, action: 'granted', message: shareResult.message };
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

module.exports = { syncPlexAccessForUser, attemptAutoLinkPlexUsername, attemptAutoLinkAllPending, retryPendingPlexAccessSyncs };
