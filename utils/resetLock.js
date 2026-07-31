// A single, app-wide "is something resetting the server right now" flag.
// Deliberately global rather than scoped per-plan/per-SSH-target: resets are
// disruptive enough (and this app runs as a single process) that the safest
// default is "only one at a time, anywhere, blocking everyone" rather than
// trying to reason about which targets might overlap.
let state = { active: false, source: null, startedAt: null, expectedResumeBy: null };

function startReset(source) {
  state = {
    active: true,
    source,
    startedAt: new Date().toISOString(),
    // Conservative upper bound shown to people while it's running - actual
    // completion is whatever it is, this is just what the banner promises.
    expectedResumeBy: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
}

function endReset() {
  state = { active: false, source: null, startedAt: null, expectedResumeBy: null };
}

function getResetState() {
  return state;
}

module.exports = { startReset, endReset, getResetState };
