// Keep-alive nozzle check: when nothing has gone through the printer for N days, print a nozzle
// check so the ink in the head doesn't dry. Canon advises printing at least monthly; weekly is
// MegaTank-owner practice. Activity is the printer's own sheet counter (prints from any device)
// or any maintenance run, since a cleaning also fires every nozzle.

const DAY = 24 * 3600 * 1000;

/** Update { lastActivityAt, lastSheets } from one status sample. Pure. */
export function observeActivity(state, status, now) {
  if (!status?.reachable) return state;
  const next = { ...state };
  if (next.lastActivityAt == null) next.lastActivityAt = now;
  if (typeof status.totalSheets === 'number') {
    if (typeof next.lastSheets === 'number' && status.totalSheets > next.lastSheets) next.lastActivityAt = now;
    next.lastSheets = status.totalSheets;
  }
  if (status.maintenanceRunning) next.lastActivityAt = now;
  return next;
}

const hh = (h) => `${String(h).padStart(2, '0')}:00`;

/** Whether to run a keep-alive nozzle check now, and why (or why not). Pure. */
export function decideKeepAlive({ now, state, status, prefs }) {
  if (!prefs.enabled) return { run: false, reason: 'Keep-alive is switched off' };
  const intervalMs = prefs.days * DAY;
  const since = Math.max(state.lastActivityAt ?? now, state.lastRunAt ?? 0);
  if (now - since < intervalMs) {
    return { run: false, reason: `Printer used recently; next check due ${new Date(since + intervalMs).toLocaleString()}`, dueAt: since + intervalMs };
  }
  const hour = new Date(now).getHours();
  if (hour < prefs.windowStart || hour >= prefs.windowEnd) {
    return { run: false, reason: `Due, waiting for daytime (${hh(prefs.windowStart)}–${hh(prefs.windowEnd)})`, due: true };
  }
  if (!status.reachable) {
    return {
      run: false,
      due: true,
      reason: status.autoPowerOn === 'OFF'
        ? 'Due, but the printer is off and Auto power on is disabled, so it cannot be woken. Turn on Auto power on in Settings.'
        : 'Due, but the printer is not reachable',
    };
  }
  if (status.state !== 'idle' || status.maintenanceRunning) return { run: false, due: true, reason: 'Due, but the printer is busy' };
  if (status.supportCode) return { run: false, due: true, reason: `Due, but the printer shows support code ${status.supportCode}` };
  const err = (status.issues ?? []).find((i) => i.severity === 'error');
  if (err) return { run: false, due: true, reason: `Due, but the printer has an error: ${err.text}` };
  if (!status.acceptingJobs) return { run: false, due: true, reason: 'Due, but the printer is not accepting jobs' };
  if (!status.cassettePaper) return { run: false, due: true, reason: 'Due, but there is no plain paper in the cassette' };
  return { run: true, reason: `No printing for ${Math.floor((now - since) / DAY)} days` };
}
