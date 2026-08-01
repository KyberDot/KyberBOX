// Talks to a Tautulli instance to pull a single Plex user's watch history.
// Uses Node's built-in fetch (Node 18+) - no extra dependency needed.

const REQUEST_TIMEOUT_MS = 10000;

/**
 * Fetches one page of watch history for one Plex user (filtered
 * server-side by Tautulli itself via the "user" param, so we never see or
 * need to filter anyone else's activity). startDate, if given, only
 * returns history from that date onward ("YYYY-MM-DD") - Tautulli only
 * supports a single from-date, not a full from/to range.
 */
async function getWatchHistory(baseUrl, apiKey, plexUsername, page = 1, pageSize = 15, startDate = null) {
  if (!baseUrl || !apiKey) {
    return { ok: false, message: 'Tautulli is not configured yet.' };
  }
  if (!plexUsername) {
    return { ok: false, message: "Your Plex username hasn't been linked to your account yet - contact support to get this set up." };
  }

  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Number(pageSize) || 15;
  const start = (safePage - 1) * safePageSize;

  let url = `${baseUrl.replace(/\/$/, '')}/api/v2?apikey=${encodeURIComponent(apiKey)}&cmd=get_history&user=${encodeURIComponent(plexUsername)}&order_column=date&order_dir=desc&start=${start}&length=${safePageSize}`;
  if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    url += `&start_date=${encodeURIComponent(startDate)}`;
  }

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
      return { ok: false, message: `Tautulli returned an error (HTTP ${res.status}).` };
    }

    const json = await res.json();
    if (!json || !json.response || json.response.result !== 'success') {
      const apiMessage = json && json.response && json.response.message;
      return { ok: false, message: apiMessage || 'Tautulli request did not succeed.' };
    }

    const data = json.response.data || {};
    const rows = data.data || [];
    // recordsFiltered is the count for THIS user (after Tautulli's own
    // filtering) - recordsTotal would be every user's history combined,
    // which isn't what pagination here should be based on.
    const totalRecords = typeof data.recordsFiltered === 'number' ? data.recordsFiltered : rows.length;

    const items = rows.map((row) => ({
      title: row.grandparent_title ? `${row.grandparent_title} — ${row.title}` : row.title,
      mediaType: row.media_type || 'unknown',
      percentComplete: typeof row.percent_complete === 'number' ? row.percent_complete : null,
      // What they watched it on, e.g. device "Living Room Roku" via the
      // client app "Plex for Roku" - same fields get_activity uses.
      device: row.player || null,
      client: row.product || null,
      // Tautulli gives unix seconds; convert to ISO so the rest of the app's
      // UK-time formatter (utils/time.js) can handle it like everything else.
      watchedAtIso: row.date ? new Date(row.date * 1000).toISOString() : null,
    }));

    return {
      ok: true,
      items,
      page: safePage,
      pageSize: safePageSize,
      totalRecords,
      totalPages: Math.max(1, Math.ceil(totalRecords / safePageSize)),
    };
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'Timed out reaching Tautulli.' : `Could not reach Tautulli: ${err.message}`;
    return { ok: false, message: reason };
  }
}

/** Maps one raw Tautulli session object into the shape our routes/views use. */
function mapSession(s) {
  const episodeTag = s.media_type === 'episode' && s.parent_media_index && s.media_index
    ? `S${s.parent_media_index}E${s.media_index} — `
    : '';
  return {
    title: s.grandparent_title ? `${s.grandparent_title} — ${episodeTag}${s.title}` : s.title,
    mediaType: s.media_type || 'unknown',
    state: s.state || 'playing', // playing | paused | buffering
    progressPercent: typeof s.progress_percent === 'string' ? Number(s.progress_percent) : (s.progress_percent || 0),
    // What they're watching on, e.g. device "Living Room Roku" via the
    // client app "Plex for Roku".
    device: s.player || null,
    client: s.product || null,
    // Used to look up an approximate location - public IP for remote
    // streams, falling back to the local IP for LAN-only sessions
    // (which won't resolve to a real location, but keeps this from
    // crashing on a missing field).
    ipAddress: s.ip_address_public || s.ip_address || null,
    // The raw internal Plex image path - never send this (or the API
    // key) to the browser directly; the caller should route it through
    // our own server-side poster proxy instead. Episode-level "thumb"
    // is frequently empty in Tautulli's activity data, so fall back to
    // the season/show artwork rather than showing nothing.
    posterPath: s.thumb || s.parent_thumb || s.grandparent_thumb || null,
    // Raw Plex identifiers, kept only for matching against our own users
    // table server-side - never sent to the browser as-is.
    plexUser: s.user || null,
    plexFriendlyName: s.friendly_name || null,
  };
}

async function fetchActivitySessions(baseUrl, apiKey) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v2?apikey=${encodeURIComponent(apiKey)}&cmd=get_activity`;

  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) {
    return { ok: false, message: `Tautulli returned an error (HTTP ${res.status}).` };
  }

  const json = await res.json();
  if (!json || !json.response || json.response.result !== 'success') {
    const apiMessage = json && json.response && json.response.message;
    return { ok: false, message: apiMessage || 'Tautulli request did not succeed.' };
  }

  return { ok: true, sessions: (json.response.data && json.response.data.sessions) || [] };
}

/**
 * Fetches currently-active Plex sessions and filters down to just this
 * user's own stream(s) - same server-side filtering principle as watch
 * history, just against live activity instead of past history.
 */
async function getNowWatching(baseUrl, apiKey, plexUsername) {
  if (!baseUrl || !apiKey) {
    return { ok: false, message: 'Tautulli is not configured yet.' };
  }
  if (!plexUsername) {
    return { ok: false, message: "Your Plex username hasn't been linked to your account yet - contact support to get this set up." };
  }

  try {
    const result = await fetchActivitySessions(baseUrl, apiKey);
    if (!result.ok) return result;

    const mine = result.sessions.filter((s) => s.user === plexUsername || s.friendly_name === plexUsername);
    return { ok: true, items: mine.map(mapSession) };
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'Timed out reaching Tautulli.' : `Could not reach Tautulli: ${err.message}`;
    return { ok: false, message: reason };
  }
}

/**
 * Fetches every currently-active Plex session, system-wide - unlike
 * getNowWatching, this isn't filtered to one person. Used for the admin
 * overview's "who's watching right now" view, where the caller matches
 * each session's plexUser/plexFriendlyName back to a portal account.
 */
async function getAllActivity(baseUrl, apiKey) {
  if (!baseUrl || !apiKey) {
    return { ok: false, message: 'Tautulli is not configured yet.' };
  }

  try {
    const result = await fetchActivitySessions(baseUrl, apiKey);
    if (!result.ok) return result;

    return { ok: true, items: result.sessions.map(mapSession) };
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'Timed out reaching Tautulli.' : `Could not reach Tautulli: ${err.message}`;
    return { ok: false, message: reason };
  }
}

/**
 * Fetches a poster image's raw bytes from Tautulli's own Plex image proxy,
 * server-side, so the API key is never exposed to the browser. Returns the
 * bytes plus content-type, or null on any failure (caller falls back to a
 * placeholder rather than erroring the whole page out).
 */
async function fetchPosterImage(baseUrl, apiKey, imgPath) {
  if (!baseUrl || !apiKey || !imgPath) return null;

  const url = `${baseUrl.replace(/\/$/, '')}/pms_image_proxy?apikey=${encodeURIComponent(apiKey)}&img=${encodeURIComponent(imgPath)}&width=300&height=450&fallback=poster`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!contentType.startsWith('image/')) return null;
    return { buffer, contentType };
  } catch (_) {
    return null;
  }
}

/** Quick connectivity/API-key check for the "Test Connection" button in Settings. */
async function testConnection(baseUrl, apiKey) {
  if (!baseUrl || !apiKey) {
    return { ok: false, message: 'Enter a Tautulli URL and API key first.' };
  }

  const url = `${baseUrl.replace(/\/$/, '')}/api/v2?apikey=${encodeURIComponent(apiKey)}&cmd=get_server_friendly_name`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, message: `Tautulli returned an error (HTTP ${res.status}).` };

    const json = await res.json();
    if (!json || !json.response || json.response.result !== 'success') {
      return { ok: false, message: (json && json.response && json.response.message) || 'Connection failed - check the URL and API key.' };
    }

    const name = json.response.data;
    return { ok: true, message: `Connected successfully — Plex server "${name}".` };
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'Timed out reaching Tautulli.' : `Could not reach Tautulli: ${err.message}`;
    return { ok: false, message: reason };
  }
}

/** Resolves an IP address to an approximate city/region/country via Tautulli's own geo database. */
async function getGeoLookup(baseUrl, apiKey, ipAddress) {
  if (!baseUrl || !apiKey || !ipAddress) return null;

  const url = `${baseUrl.replace(/\/$/, '')}/api/v2?apikey=${encodeURIComponent(apiKey)}&cmd=get_geoip_lookup&ip_address=${encodeURIComponent(ipAddress)}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) return null;

    const json = await res.json();
    if (!json || !json.response || json.response.result !== 'success') return null;

    const data = json.response.data || {};
    const parts = [data.city, data.region, data.country].filter(Boolean);
    if (parts.length === 0) return null;

    return parts.join(', ');
  } catch (_) {
    return null; // location is a nice-to-have, never worth failing the whole card over
  }
}

module.exports = { getWatchHistory, getNowWatching, getAllActivity, getGeoLookup, fetchPosterImage, testConnection };
