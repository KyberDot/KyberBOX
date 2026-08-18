// A single Node process runs this whole app, so a plain in-memory Set is
// enough here - no need for anything DB-backed. Tracks container IDs (not
// names) since that's what every route already has on hand.
const activeContainerActions = new Set();

function markContainerActionStart(containerId) {
  activeContainerActions.add(Number(containerId));
}

function markContainerActionEnd(containerId) {
  activeContainerActions.delete(Number(containerId));
}

function isContainerActionActive(containerId) {
  return activeContainerActions.has(Number(containerId));
}

module.exports = { markContainerActionStart, markContainerActionEnd, isContainerActionActive };
