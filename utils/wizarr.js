// Talks to a self-hosted Wizarr instance instead of Plex directly. Wizarr
// is invite-link based, not direct-share based: creating an "invitation"
// gives back a code/URL; the actual Plex library share only happens once
// the person visits that link and authenticates. That's a meaningfully
// different model than trying to share directly by email (which doesn't
// work well for people Plex doesn't already know about), and Wizarr's
// own team has already solved the API quirks involved.

const REQUEST_TIMEOUT_MS = 10000;

async function wizarrRequest(baseUrl, apiKey, method, path, body) {
  if (!baseUrl || !apiKey) {
    return { ok: false, message: 'Wizarr is not configured yet.' };
  }

  const url = `${baseUrl.replace(/\/$/, '')}/api${path}`;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'X-API-Key': apiKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON response */ }

    if (!res.ok) {
      const message = (data && (data.message || data.detail)) || text.slice(0, 300) || `HTTP ${res.status}`;
      return { ok: false, status: res.status, message: `Wizarr returned an error (HTTP ${res.status}): ${message}` };
    }

    return { ok: true, data };
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'Timed out reaching Wizarr.' : `Could not reach Wizarr: ${err.message}`;
    return { ok: false, message: reason };
  }
}

/** Basic connectivity/API-key check, for a "Test Connection" button. */
async function testConnection(baseUrl, apiKey) {
  const result = await wizarrRequest(baseUrl, apiKey, 'GET', '/status');
  if (!result.ok) return result;
  return { ok: true, message: 'Connected to Wizarr successfully.' };
}

/** Every user Wizarr currently manages, across all connected media servers. */
async function getUsers(baseUrl, apiKey) {
  const result = await wizarrRequest(baseUrl, apiKey, 'GET', '/users');
  if (!result.ok) return result;
  const users = Array.isArray(result.data) ? result.data : (result.data && result.data.users) || [];
  return { ok: true, users };
}

/** Every library across every connected server - used to build the picker admins choose from per plan. */
async function getLibraries(baseUrl, apiKey) {
  const result = await wizarrRequest(baseUrl, apiKey, 'GET', '/libraries');
  if (!result.ok) return result;
  const libraries = Array.isArray(result.data) ? result.data : (result.data && result.data.libraries) || [];
  return { ok: true, libraries };
}

/** Every media server Wizarr has configured - needed to pick server_ids when creating an invitation. */
async function getServers(baseUrl, apiKey) {
  const result = await wizarrRequest(baseUrl, apiKey, 'GET', '/servers');
  if (!result.ok) return result;
  const servers = Array.isArray(result.data) ? result.data : (result.data && result.data.servers) || [];
  return { ok: true, servers };
}

/**
 * Creates an invitation for specific servers/libraries. Returns whatever
 * invite code/URL Wizarr generates - the caller is responsible for
 * getting that to the person (e.g. emailing it), since this call alone
 * doesn't grant access yet, only sets up the invite for them to accept.
 */
async function createInvitation(baseUrl, apiKey, { serverIds, libraryIds, duration, expiresInDays }) {
  if (!serverIds || serverIds.length === 0) {
    return { ok: false, message: 'No server selected for this invitation.' };
  }

  const body = {
    server_ids: serverIds,
    duration: duration || 'unlimited',
  };
  if (libraryIds && libraryIds.length > 0) body.library_ids = libraryIds;
  if (expiresInDays) body.expires_in_days = expiresInDays;

  const result = await wizarrRequest(baseUrl, apiKey, 'POST', '/invitations', body);
  if (!result.ok) return result;

  const invite = result.data || {};
  return {
    ok: true,
    code: invite.code || invite.id || null,
    url: invite.url || invite.link || (invite.code ? `${baseUrl.replace(/\/$/, '')}/j/${invite.code}` : null),
  };
}

/** Removes someone from every server Wizarr granted them access to. */
async function deleteUser(baseUrl, apiKey, userId) {
  return wizarrRequest(baseUrl, apiKey, 'DELETE', `/users/${encodeURIComponent(userId)}`);
}

async function disableUser(baseUrl, apiKey, userId) {
  return wizarrRequest(baseUrl, apiKey, 'POST', `/users/${encodeURIComponent(userId)}/disable`);
}

async function enableUser(baseUrl, apiKey, userId) {
  return wizarrRequest(baseUrl, apiKey, 'POST', `/users/${encodeURIComponent(userId)}/enable`);
}

module.exports = { testConnection, getUsers, getLibraries, getServers, createInvitation, deleteUser, disableUser, enableUser };
