const net = require('net');

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // providerId -> { data, checkedAt }

function checkTcp(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ status: 'online', latency_ms: Date.now() - start }));
    socket.once('timeout', () => finish({ status: 'offline', error: 'Connection timed out' }));
    socket.once('error', (err) => finish({ status: 'offline', error: err.message }));

    socket.connect(port, host);
  });
}

async function checkRealDebrid(apiKey) {
  if (!apiKey) return { status: 'unknown', error: 'No API key configured' };
  const start = Date.now();
  try {
    const res = await fetch('https://api.real-debrid.com/rest/1.0/user', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    const latency_ms = Date.now() - start;
    if (res.ok) {
      const data = await res.json();
      return {
        status: 'online',
        latency_ms,
        username: data.username,
        premium_until: data.expiration ? String(data.expiration).slice(0, 10) : null,
      };
    }
    return { status: 'degraded', http_code: res.status, latency_ms };
  } catch (err) {
    return { status: 'offline', error: err.message };
  }
}

async function checkAllDebrid(apiKey) {
  if (!apiKey) return { status: 'unknown', error: 'No API key configured' };
  const start = Date.now();
  try {
    const res = await fetch('https://api.alldebrid.com/v4/user', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    const latency_ms = Date.now() - start;
    if (res.ok) {
      const data = await res.json();
      if (data.status === 'success') {
        const user = (data.data && data.data.user) || {};
        return {
          status: user.isPremium ? 'online' : 'degraded',
          latency_ms,
          username: user.username,
          premium_until: user.premiumUntil ? new Date(user.premiumUntil * 1000).toISOString().slice(0, 10) : null,
        };
      }
      return { status: 'degraded', error: (data.error && data.error.message) || 'API Error', latency_ms };
    }
    return { status: 'degraded', http_code: res.status, latency_ms };
  } catch (err) {
    return { status: 'offline', error: err.message };
  }
}

async function checkEasynews(username, password) {
  if (!username || !password) return { status: 'unknown', error: 'No credentials configured' };
  const start = Date.now();
  try {
    const params = new URLSearchParams({
      fly: '2', gps: 'test', sb: '1', pno: '1', pby: '1', u: '1', st: 'basic',
    });
    params.append('fty[]', 'VIDEO');
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const res = await fetch(`https://members.easynews.com/2.0/search/solr-search/?${params}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(20000),
    });
    const latency_ms = Date.now() - start;
    if (res.ok) {
      return { status: 'online', latency_ms, username: username.split('@')[0] };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: 'degraded', error: 'Auth failed', latency_ms };
    }
    return { status: 'degraded', http_code: res.status, latency_ms };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      const result = await checkTcp('members.easynews.com', 443, 8000);
      result.username = username.split('@')[0];
      return result;
    }
    return { status: 'offline', error: err.message };
  }
}

async function checkHttpPing(url) {
  if (!url) return { status: 'unknown', error: 'No URL configured' };
  try {
    const start = Date.now();
    // HEAD first since it's cheaper - some servers reject it outright
    // though, so GET is the fallback rather than a hard failure. Any
    // response at all (including 4xx/5xx) still proves the endpoint is
    // reachable, since this is measuring connectivity/latency, not
    // checking whether the request itself succeeded.
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
    return { status: 'online', latency_ms: Date.now() - start };
  } catch (err) {
    try {
      const start2 = Date.now();
      await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
      return { status: 'online', latency_ms: Date.now() - start2 };
    } catch (err2) {
      return { status: 'offline', error: err2.message };
    }
  }
}

// provider: a row from admin_providers, with credentials already decrypted
// onto plaintext fields (apiKey / username / password) by the caller -
// this module never touches the encrypted columns directly.
async function checkProvider(provider) {
  switch (provider.check_type) {
    case 'real_debrid':
      return checkRealDebrid(provider.apiKey);
    case 'alldebrid':
      return checkAllDebrid(provider.apiKey);
    case 'easynews':
      return checkEasynews(provider.username, provider.password);
    case 'tcp':
      if (!provider.host || !provider.port) return { status: 'unknown', error: 'Host/port not configured' };
      return checkTcp(provider.host, provider.port);
    case 'http_ping':
      return checkHttpPing(provider.link);
    case 'none':
    default:
      return null; // no live check for this provider - purely manual tracking
  }
}

async function getProviderStatus(provider, force = false) {
  if (provider.check_type === 'none') return null;

  if (!force) {
    const cached = cache.get(provider.id);
    if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const data = await checkProvider(provider);
  cache.set(provider.id, { data, checkedAt: Date.now() });
  return data;
}

function clearProviderCache(providerId) {
  cache.delete(providerId);
}

module.exports = { checkTcp, checkRealDebrid, checkAllDebrid, checkEasynews, checkHttpPing, checkProvider, getProviderStatus, clearProviderCache };
