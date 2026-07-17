const TIME_ZONE = 'Europe/London';

/**
 * Parses either a SQLite datetime('now') string ("YYYY-MM-DD HH:MM:SS",
 * always UTC with no timezone marker) or a proper ISO string, and returns
 * a Date. Returns null if the input is empty or unparseable.
 */
function parseStoredDate(value) {
  if (!value) return null;
  let str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) {
    str = str.replace(' ', 'T') + 'Z';
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    // date-only values (e.g. an <input type="date"> expiry) - treat as UTC midnight
    str = str + 'T00:00:00Z';
  }
  const date = new Date(str);
  return isNaN(date.getTime()) ? null : date;
}

/** Full UK date + time, e.g. "17 Jul 2026, 14:30 BST". */
function formatUK(value) {
  const date = parseStoredDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(date);
}

/** UK date only, e.g. "17 Jul 2026" - for things like subscription expiry. */
function formatUKDate(value) {
  const date = parseStoredDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/** Formats a plan price in its currency, e.g. formatMoney(9.99, 'GBP') -> "£9.99". */
function formatMoney(amount, currency) {
  if (amount === null || amount === undefined || amount === '') return null;
  const num = Number(amount);
  if (isNaN(num)) return null;
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP' }).format(num);
  } catch (_) {
    return `${num.toFixed(2)} ${currency || ''}`.trim();
  }
}

/** Current time formatted for display in the UK timezone, e.g. for "as of" labels. */
function nowUK() {
  return formatUK(new Date().toISOString());
}

/**
 * Converts a wall-clock string from an <input type="datetime-local"> (e.g.
 * "2026-07-20T14:30", no timezone info) - which the admin filled in while
 * looking at UK time - into a correct UTC ISO string for storage, handling
 * BST/GMT automatically for that specific date.
 */
function londonInputToUtcIso(localStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(localStr || ''));
  if (!match) return null;
  const [, y, mo, d, hh, mm] = match.map(Number);

  // Step 1: treat the numbers as if they were already UTC, to get a
  // reference instant we can ask "what does London show at this moment?"
  const guess = new Date(Date.UTC(y, mo - 1, d, hh, mm));

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(guess).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

  const londonHour = parts.hour === '24' ? 0 : Number(parts.hour);
  const londonAsUtcMs = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), londonHour, Number(parts.minute), Number(parts.second));

  // Step 2: the gap between that and our guess is London's current UTC offset.
  const offsetMs = londonAsUtcMs - guess.getTime();

  // Step 3: shift the guess back by that offset to get the true UTC instant
  // that displays as the admin's intended wall-clock time in London.
  return new Date(guess.getTime() - offsetMs).toISOString();
}

/**
 * Converts a stored UTC datetime into the "YYYY-MM-DDTHH:MM" format an
 * <input type="datetime-local"> expects, expressed in UK wall-clock time -
 * the inverse of londonInputToUtcIso(), used to pre-fill admin forms.
 */
function utcToLondonInputValue(utcValue) {
  const date = parseStoredDate(utcValue);
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

module.exports = { TIME_ZONE, formatUK, formatUKDate, formatMoney, nowUK, parseStoredDate, londonInputToUtcIso, utcToLondonInputValue };
