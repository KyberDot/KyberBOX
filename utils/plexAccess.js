// Automatically links a subscriber's Plex username, so their watch
// history / now-watching (via Tautulli) works without an admin needing to
// type it in by hand. This is the only thing this module does now -
// actual Plex library access management was removed.

const db = require('../db');
const { getAllSettings } = require('./settings');
const { getSharedUsers } = require('./plex');

// Don't hit Plex more than this often for the same unmatched user -
// someone who hasn't accepted their invite yet will fail this lookup on
// every visit otherwise, and there's no need to hammer plex.tv over it.
const LINK_RETRY_INTERVAL_MS = 5 * 60 * 1000;

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
 * Finds every Plex-plan subscriber who hasn't been linked yet and
 * attempts to link each of them (still individually rate-limited, so
 * this is cheap to call often). Used both when an admin opens the Users
 * page and by the background scheduler.
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

module.exports = { attemptAutoLinkPlexUsername, attemptAutoLinkAllPending };
