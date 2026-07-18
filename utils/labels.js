const LABELS = {
  docker: 'Docker Hosting',
  plex: 'Plex',
  stream: 'Stream Addons',
  indexers: 'Indexers',
  hosting: 'Web Hosting',
  multiple: 'Your Services',
};

function serviceLabel(service) {
  return LABELS[service] || 'This service';
}

module.exports = { serviceLabel };
