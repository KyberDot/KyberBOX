// Talks to a Tautulli instance to pull a single Plex user's watch history.
// Uses Node's built-in fetch (Node 18+) - no extra dependency needed.

const REQUEST_TIMEOUT_MS = 10000;

/**
 * Fetches one page of watch history for one Plex user (filtered
 * server-side by Tautulli itself via the "user" param, so we never see or
 * need to filter anyone else's activity).
 */
async function getWatchHistory(baseUrl, apiKey, plexUsername, page = 1, pageSize = 15) {
  if (!baseUrl || !apiKey) {
    return { ok: false, message: 'Tautulli is not configured yet.' };
  }
  if (!plexUsername) {
    return { ok: false, message: "Your Plex username hasn't been linked to your account yet - contact support to get this set up." };
  }

  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Number(pageSize) || 15;
  const start = (safePage - 1) * safePageSize;

  const url = `${baseUrl.replace(/\/$/, '')}/api/v2?apikey=${encodeURIComponent(apiKey)}&cmd=get_history&user=${encodeURIComponent(plexUsername)}&start=${start}&length=${safePageSize}`;

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

  const url = `${baseUrl.replace(/\/$/, '')}/api/v2?apikey=${encodeURIComponent(apiKey)}&cmd=get_activity`;

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

    const sessions = (json.response.data && json.response.data.sessions) || [];
    const mine = sessions.filter((s) => s.user === plexUsername || s.friendly_name === plexUsername);

    const items = mine.map((s) => {
      const episodeTag = s.media_type === 'episode' && s.parent_media_index && s.media_index
        ? `S${s.parent_media_index}E${s.media_index} — `
        : '';
      return {
        title: s.grandparent_title ? `${s.grandparent_title} — ${episodeTag}${s.title}` : s.title,
        mediaType: s.media_type || 'unknown',
        state: s.state || 'playing', // playing | paused | buffering
        progressPercent: typeof s.progress_percent === 'string' ? Number(s.progress_percent) : (s.progress_percent || 0),
        // The raw internal Plex image path - never send this (or the API
        // key) to the browser directly; the caller should route it through
        // our own server-side poster proxy instead.
        posterPath: s.thumb || null,
      };
    });

    return { ok: true, items };
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

module.exports = { getWatchHistory, getNowWatching, fetchPosterImage, testConnection };
