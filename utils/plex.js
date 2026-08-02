// Talks to plex.tv directly (not your Plex Media Server itself) to list the
// accounts your server's libraries are currently shared with. Used only to
// match a subscriber's Plex username to their portal account (so their
// watch history / now-watching via Tautulli works) - this module does not
// manage actual Plex library access.

const REQUEST_TIMEOUT_MS = 10000;

/**
 * Fetches everyone your Plex server is currently shared with (Plex calls
 * these "friends" - people outside your own Plex Home who you've granted
 * library access to). Returns each one's Plex user id, username, and
 * email, so the caller can match them against portal accounts.
 */
async function getSharedUsers(plexToken) {
  if (!plexToken) {
    return { ok: false, message: 'A Plex account token is not configured yet.' };
  }

  try {
    // This particular endpoint (unlike Plex's newer v2 API) ignores
    // Accept: application/json in practice and always returns XML, so
    // it's parsed as XML directly rather than assuming JSON.
    const res = await fetch('https://plex.tv/api/users', {
      headers: { 'X-Plex-Token': plexToken },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const reason = res.status === 401 ? 'Plex rejected that token - it may be expired or wrong.' : `Plex returned an error (HTTP ${res.status}).`;
      return { ok: false, message: reason };
    }

    const xmlText = await res.text();
    const rawUsers = parseXmlUserTags(xmlText);

    const users = rawUsers
      .map((u) => ({
        id: u.id != null ? String(u.id) : null,
        username: u.username || u.title || null,
        email: u.email ? u.email.toLowerCase().trim() : null,
      }))
      .filter((u) => u.id);

    return { ok: true, users };
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'Timed out reaching Plex.' : `Could not reach Plex: ${err.message}`;
    return { ok: false, message: reason };
  }
}

/**
 * Lightweight attribute extraction for Plex's simple <User id="..."
 * username="..." email="..."/> XML tags - avoids pulling in a full XML
 * parsing dependency for what's just a flat list of attributes.
 */
function parseXmlUserTags(xmlText) {
  const users = [];
  const userTagRegex = /<User\b([^>]*?)\/?>/g;
  const attrRegex = /([\w-]+)="([^"]*)"/g;
  let tagMatch;

  while ((tagMatch = userTagRegex.exec(xmlText)) !== null) {
    const attrs = {};
    let attrMatch;
    attrRegex.lastIndex = 0;
    while ((attrMatch = attrRegex.exec(tagMatch[1])) !== null) {
      attrs[attrMatch[1]] = decodeXmlEntities(attrMatch[2]);
    }
    users.push(attrs);
  }

  return users;
}

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

module.exports = { getSharedUsers };
