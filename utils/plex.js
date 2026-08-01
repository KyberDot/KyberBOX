// Talks to plex.tv directly (not your Plex Media Server itself) to list the
// accounts your server's libraries are currently shared with. Uses the
// classic, long-stable "get my users" endpoint - the same one tools like
// Wizarr and python-plexapi rely on. Node's built-in fetch (Node 18+), no
// extra dependency needed.

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

/**
 * Gets your Plex Media Server's machine identifier directly from the
 * server itself (not plex.tv) - this is what Plex's sharing endpoints use
 * to identify which server a share applies to. `/identity` doesn't
 * strictly require a token, but sending one doesn't hurt.
 */
async function getServerIdentity(serverUrl) {
  if (!serverUrl) return { ok: false, message: 'A Plex server URL is not configured yet.' };

  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, '')}/identity`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, message: `Plex server returned an error (HTTP ${res.status}).` };

    const json = await res.json();
    const machineIdentifier = json.MediaContainer && json.MediaContainer.machineIdentifier;
    if (!machineIdentifier) return { ok: false, message: "Plex server responded, but didn't include a machine identifier." };

    return { ok: true, machineIdentifier };
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'Timed out reaching your Plex server.' : `Could not reach your Plex server: ${err.message}`;
    return { ok: false, message: reason };
  }
}

/**
 * Confirms plex.tv itself (not just the PMS's own self-report) recognizes
 * this machine identifier as a server tied to this token's account - the
 * two can disagree (unclaimed server, re-claimed server, wrong URL
 * pointing at the wrong instance, etc.), and library-sharing calls happen
 * entirely on plex.tv's side, so this is the source of truth that
 * actually matters for whether sharing will work at all.
 */
async function verifyServerWithPlexTv(machineIdentifier, plexToken) {
  if (!machineIdentifier || !plexToken) return { ok: false, message: 'Missing machine identifier or token.' };

  const url = `https://plex.tv/api/servers/${encodeURIComponent(machineIdentifier)}?X-Plex-Token=${encodeURIComponent(plexToken)}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.status === 404) {
      return { ok: false, message: "Plex.tv doesn't recognize this server under your account. It may not be claimed by the same Plex account as this token, or the machine identifier may be stale." };
    }
    if (!res.ok) return { ok: false, message: `Plex.tv returned an error (HTTP ${res.status}).` };

    const xmlText = await res.text();
    const nameMatch = xmlText.match(/<Server\b[^>]*\bname="([^"]*)"/);
    return { ok: true, serverName: nameMatch ? decodeXmlEntities(nameMatch[1]) : null };
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'Timed out reaching Plex.' : `Could not reach Plex: ${err.message}`;
    return { ok: false, message: reason };
  }
}

/** Lists this server's libraries (Movies, TV Shows, etc.), for picking which ones a plan grants. */
async function getLibrarySections(serverUrl, plexToken) {
  if (!serverUrl) return { ok: false, message: 'A Plex server URL is not configured yet.' };
  if (!plexToken) return { ok: false, message: 'A Plex account token is not configured yet.' };

  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, '')}/library/sections`, {
      headers: { 'X-Plex-Token': plexToken, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, message: `Plex server returned an error (HTTP ${res.status}).` };

    const json = await res.json();
    const container = json.MediaContainer || {};
    let rawSections = container.Directory || [];
    if (!Array.isArray(rawSections)) rawSections = [rawSections];

    const sections = rawSections.map((s) => ({ key: String(s.key), title: s.title, type: s.type }));
    return { ok: true, sections };
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'Timed out reaching your Plex server.' : `Could not reach your Plex server: ${err.message}`;
    return { ok: false, message: reason };
  }
}

/**
 * Invites/shares specific library sections with someone by email - this is
 * exactly what triggers Plex's own invitation email for people who don't
 * already have access, the same as clicking "Share" in Plex's web app.
 * Returns the new share's id, needed later to revoke it.
 */
async function shareLibraries({ plexToken, clientIdentifier, machineIdentifier, sectionIds, invitedEmail }) {
  if (!plexToken || !clientIdentifier || !machineIdentifier) {
    return { ok: false, message: 'Plex is not fully configured yet (token, server, or client identifier missing).' };
  }
  if (!sectionIds || sectionIds.length === 0) {
    return { ok: false, message: 'No library sections are configured for this plan.' };
  }

  // invitedEmail goes in the query string alongside the other identity
  // params, not the JSON body - putting it in the body (as an earlier
  // version of this did) caused Plex to 404 on this endpoint, since it
  // couldn't resolve who the share request was even for.
  const url = `https://plex.tv/api/v2/shared_servers?X-Plex-Client-Identifier=${encodeURIComponent(clientIdentifier)}&X-Plex-Token=${encodeURIComponent(plexToken)}&invitedEmail=${encodeURIComponent(invitedEmail)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machineIdentifier,
        librarySectionIds: sectionIds.map(Number),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      // Plex uses 422 for "already sharing with this person" - treat that
      // as a soft failure the caller can decide how to handle, not a hard error.
      return { ok: false, alreadyShared: res.status === 422, message: `Plex declined the share (HTTP ${res.status}): ${bodyText.slice(0, 300)}` };
    }

    let json = {};
    try { json = JSON.parse(bodyText); } catch (_) { /* some responses are empty on success */ }

    return { ok: true, shareId: json.id != null ? String(json.id) : null };
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'Timed out reaching Plex.' : `Could not reach Plex: ${err.message}`;
    return { ok: false, message: reason };
  }
}

/** Revokes a previously-created share, removing that person's library access entirely. */
async function unshareServer({ plexToken, clientIdentifier, shareId }) {
  if (!plexToken || !clientIdentifier || !shareId) {
    return { ok: false, message: 'Missing Plex configuration or share id.' };
  }

  const url = `https://plex.tv/api/v2/shared_servers/${encodeURIComponent(shareId)}?X-Plex-Client-Identifier=${encodeURIComponent(clientIdentifier)}&X-Plex-Token=${encodeURIComponent(plexToken)}`;

  try {
    const res = await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    // A 404 here just means it's already gone (e.g. they removed themselves) - treat as success either way.
    if (!res.ok && res.status !== 404) {
      const bodyText = await res.text().catch(() => '');
      return { ok: false, message: `Plex declined the removal (HTTP ${res.status}): ${bodyText.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'Timed out reaching Plex.' : `Could not reach Plex: ${err.message}`;
    return { ok: false, message: reason };
  }
}

module.exports = { getSharedUsers, getServerIdentity, verifyServerWithPlexTv, getLibrarySections, shareLibraries, unshareServer };
