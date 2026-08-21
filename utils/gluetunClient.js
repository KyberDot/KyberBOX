// Shared connection logic for the VPN Monitor feature. A gluetun instance's
// configured URL (e.g. http://gluetun:8888) normally uses that container's
// own Docker service/container name as its hostname - resolvable via
// Docker's embedded DNS, but only BETWEEN containers on the same Docker
// network. It's never resolvable from the host's own shell, which is where
// every SSH command from this app actually runs.
//
// resolveGluetunHost() resolves that hostname to the container's real IP
// via `docker inspect` (daemon-level, no network DNS involved), then
// returns a curl `--resolve` flag that maps the hostname to that IP for
// connection purposes only. The request itself - including the Host header
// curl sends - still uses the original hostname, matching what a request
// from a container actually on that Docker network would look like. This
// matters because some setups react to the Host header; substituting the
// bare IP directly into the URL instead would silently change it.

const { runCommand } = require('./ssh');

async function resolveGluetunHost(target, rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    return null;
  }

  const hostname = parsed.hostname;
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');

  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return { resolveFlag: '' }; // already a plain IP - no DNS involved at all, nothing to resolve
  }

  const safeHostname = hostname.replace(/'/g, `'"'"'`);
  const result = await runCommand(
    target,
    `docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' '${safeHostname}' 2>&1`,
    10000
  );
  if (!result.success) return null;

  const ip = result.output.trim().split(/\s+/)[0];
  if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return null;

  const safeIp = ip.replace(/'/g, `'"'"'`);
  const safePort = port.replace(/'/g, `'"'"'`);
  return { resolveFlag: `--resolve '${hostname}:${safePort}:${safeIp}' ` };
}

module.exports = { resolveGluetunHost };
