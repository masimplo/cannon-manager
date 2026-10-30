// Turns raw IPP printer attributes (plus the Remote UI status, when available)
// into a plain-English summary for the dashboard.

const MAINT_NAMES = {
  'TestPrint:nozzle_check': 'Nozzle check',
  'TestPrint:regi_check': 'Alignment check print',
  'TestPrint:auto_registration': 'Automatic head alignment',
  'Cleaning:regular': 'Cleaning',
  'Cleaning:deep': 'Deep cleaning',
  'Cleaning:choke': 'Ink flush',
};

/** "RollerCleaning" → "Roller cleaning", for operations without a known name. */
function maintenanceName({ operation, type }) {
  const known = MAINT_NAMES[`${operation}:${type}`];
  if (known) return known;
  const words = String(operation).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const STATES = { 3: 'idle', 4: 'processing', 5: 'stopped' };

// PWG 5100.x / RFC 8011 printer-state-reasons, phrased for a person standing at the printer.
const REASONS = {
  'media-empty': 'Out of paper',
  'media-needed': 'Paper needs to be loaded',
  'media-jam': 'Paper jam',
  'media-low': 'Paper is running low',
  'cover-open': 'A cover is open',
  'door-open': 'A door is open',
  'input-tray-missing': 'Paper cassette is missing',
  'marker-supply-low': 'Ink is running low',
  'marker-supply-empty': 'Ink tank is empty',
  'marker-waste-almost-full': 'Ink absorber (waste ink) is almost full',
  'marker-waste-full': 'Ink absorber (waste ink) is full; the printer needs service',
  'toner-low': 'Ink is running low',
  'toner-empty': 'Ink tank is empty',
  'spool-area-full': 'Spool area full: the printer is busy and is not taking new jobs right now',
  'paused': 'Printer is paused',
  'offline': 'Printer is offline',
  'shutdown': 'Printer is shutting down',
  'connecting-to-device': 'Printer is connecting',
  'timed-out': 'Printer timed out',
  'stopping': 'Printer is stopping',
  'other': 'Printer reported an unspecified condition',
};

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function describeReason(keyword) {
  const m = /^(.*?)(?:-(report|warning|error))?$/.exec(keyword);
  const base = m[1];
  const suffix = m[2] ?? 'error';
  const text = REASONS[base] ?? base.replace(/-/g, ' ');
  const severity = suffix === 'report' ? 'info' : suffix;
  return { severity, text, code: keyword };
}

function prettyMarkerName(name) {
  return String(name).replace(/\s*\(/, ' (');
}

export function summarize(attrs, remoteUi, maintenance = null) {
  const stateCode = attrs['printer-state'];
  const state = STATES[stateCode] ?? `unknown (${stateCode})`;
  const acceptingJobs = attrs['printer-is-accepting-jobs'] !== false;
  const issues = [];

  for (const r of asArray(attrs['printer-state-reasons'])) {
    if (r && r !== 'none') issues.push(describeReason(r));
  }
  if (!acceptingJobs) {
    issues.push({ severity: state === 'processing' ? 'info' : 'warning', text: 'Printer is not accepting jobs at the moment', code: 'not-accepting-jobs' });
  }
  const alert = attrs['printer-alert-description'];
  if (alert && !/^non-alert$/i.test(alert) && !issues.some((i) => alert.toLowerCase().includes(i.text.toLowerCase().split(':')[0]))) {
    issues.push({ severity: /critical/i.test(alert) && !/non-critical/i.test(alert) ? 'error' : 'info', text: `Printer alert: ${alert}`, code: 'printer-alert' });
  }

  const names = asArray(attrs['marker-names']);
  const levels = asArray(attrs['marker-levels']);
  const lows = asArray(attrs['marker-low-levels']);
  const colors = asArray(attrs['marker-colors']);
  const inks = names.map((n, i) => {
    const level = levels[i];
    const low = lows[i] ?? 15;
    let status = 'ok';
    if (level === undefined || level < 0) status = 'unknown';
    else if (level === 0) status = 'empty';
    else if (level <= low) status = 'low';
    return { name: prettyMarkerName(n), level, low, color: colors[i] ?? '#888', status };
  });
  for (const ink of inks) {
    if (ink.status === 'empty') issues.push({ severity: 'error', text: `${ink.name} ink is empty: refill the tank before printing`, code: 'ink-empty' });
    if (ink.status === 'low') issues.push({ severity: 'warning', text: `${ink.name} ink is low (${ink.level}%): refill soon`, code: 'ink-low' });
  }

  let health = 'ok';
  if (issues.some((i) => i.severity === 'warning')) health = 'warning';
  if (state === 'processing' && health === 'ok') health = 'busy';
  if (state === 'stopped' || issues.some((i) => i.severity === 'error')) health = 'error';

  if (maintenance?.running && health !== 'error') health = 'busy';
  let headline = maintenance?.running ? `${maintenanceName(maintenance)} in progress` : remoteUi?.busyStateText;
  if (!headline) {
    if (state === 'idle') headline = health === 'ok' ? 'Ready to print' : 'Idle, needs attention';
    else if (state === 'processing') headline = 'Printing or busy';
    else headline = 'Stopped';
  }

  return {
    name: attrs['printer-make-and-model'] ?? attrs['printer-name'],
    state,
    health,
    headline,
    acceptingJobs,
    issues,
    inks,
    firmware: attrs['printer-firmware-string-version'],
    upTimeSeconds: attrs['printer-up-time'],
    queuedJobs: attrs['queued-job-count'],
    mediaReady: asArray(attrs['media-ready']),
    deviceId: attrs['printer-device-id'],
    uuid: attrs['printer-uuid'],
    remoteUi: remoteUi ?? null,
    maintenance: maintenance ?? null,
  };
}

/** Why maintenance must not be sent right now, or null when the printer is ready for it. */
export function maintenanceBlockedReason(summary) {
  if (summary.maintenance?.running) return `The printer is busy: ${summary.headline}`;
  if (summary.state === 'stopped') return 'The printer is stopped. Clear the error on the printer first.';
  if (summary.remoteUi?.busyState && summary.remoteUi.busyState !== '0') return `The printer is busy: ${summary.remoteUi.busyStateText}`;
  if (summary.state === 'processing') return `The printer is busy: ${summary.headline}`;
  return null;
}
