// Runs recurring maintenance on a plain interval, inside this same Node
// process. Everything here used to only happen as a side effect of some
// specific person loading some specific page - which meant none of it
// actually ran if nobody visited the site for a while. This makes it a
// genuine background job instead, independent of anyone logging in.

const { applyAutoRenewals, applyManualExpirations, applyExpiryWarnings } = require('./renewals');
const { checkStuckWatch } = require('./stuckWatch');

const INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

async function runMaintenanceCycle() {
  try {
    applyAutoRenewals();
    applyManualExpirations();
  } catch (err) {
    console.error('[scheduler] renewals failed:', err.message);
  }

  try {
    await applyExpiryWarnings();
  } catch (err) {
    console.error('[scheduler] expiry warnings failed:', err.message);
  }

  try {
    await checkStuckWatch();
  } catch (err) {
    console.error('[scheduler] stuck-watch check failed:', err.message);
  }
}

function startScheduler() {
  // Run once shortly after boot (not instantly, so the app finishes
  // starting up first), then on a fixed interval forever after.
  setTimeout(() => { runMaintenanceCycle(); }, 15000);
  setInterval(() => { runMaintenanceCycle(); }, INTERVAL_MS);
  console.log(`[scheduler] background maintenance running every ${INTERVAL_MS / 60000} minutes`);
}

module.exports = { startScheduler };
