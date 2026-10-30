// macOS notifications. Sent through ~/Applications/G5040 Manager.app (macos/main.swift, built by
// scripts/build-mac-app.sh), which posts them under its own name. osascript is only a fallback:
// on macOS 26 its notifications (attributed to Script Editor) are dropped silently.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MAC_APP = join(homedir(), 'Applications', 'G5040 Manager.app');

export function macAppSend(title, message) {
  return new Promise((resolve) => {
    execFile('/usr/bin/open', ['-n', '-g', '-a', MAC_APP, '--args', 'notify', String(title), String(message)], { timeout: 15000 }, (err) => resolve(err ? (err.code ?? 1) : 0));
  });
}

export function defaultSend(title, message) {
  return existsSync(MAC_APP) ? macAppSend(title, message) : osascriptSend(title, message);
}

export function appleScriptString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function osascriptSend(title, message) {
  return new Promise((resolve) => {
    const script = `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`;
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 10000 }, (err) => resolve(err ? (err.code ?? 1) : 0));
  });
}

export const CATEGORIES = {
  error: 'Printer errors and support codes',
  ink: 'Ink low or empty',
  connection: 'Printer offline or back online',
  job: 'Print jobs finished or failed',
  keepalive: 'Keep-alive nozzle checks',
  settings: 'Settings changes that failed',
};

/**
 * Pure: which notification events a status change produces. Summaries are
 * { reachable, supportCode, supportLabel, inks }. Besides notifications it emits { clear: key }
 * when a condition ends, so the same condition notifies again if it comes back later.
 */
export function statusEvents(prev, next, { unreachableStreak = 0, wasOfflineNotified = false } = {}) {
  const events = [];
  if (!next.reachable) {
    if (unreachableStreak === 2) {
      events.push({ clear: 'online' });
      events.push({ category: 'connection', key: 'offline', title: 'Printer offline', message: 'The Canon G5040 is not reachable. It may be switched off or have dropped off the network.' });
    }
    return events;
  }
  if (prev && !prev.reachable && wasOfflineNotified) {
    events.push({ clear: 'offline' });
    events.push({ category: 'connection', key: 'online', title: 'Printer back online', message: 'The Canon G5040 is reachable again.' });
  }
  if (prev?.supportCode && prev.supportCode !== next.supportCode) events.push({ clear: `code:${prev.supportCode}` });
  if (next.supportCode && next.supportCode !== prev?.supportCode) {
    events.push({ category: 'error', key: `code:${next.supportCode}`, title: `Printer error ${next.supportCode}`, message: `Support code ${next.supportCode}${next.supportLabel ? `: ${next.supportLabel}` : ''}. Open G5040 Manager for the fix.` });
  }
  const before = new Map((prev?.inks ?? []).map((i) => [i.name, i.status]));
  for (const ink of next.inks ?? []) {
    const was = before.get(ink.name);
    if ((was === 'low' || was === 'empty') && ink.status !== was) events.push({ clear: `ink-${was}:${ink.name}` });
    if ((ink.status === 'low' || ink.status === 'empty') && ink.status !== was) {
      events.push({
        category: 'ink',
        key: `ink-${ink.status}:${ink.name}`,
        title: ink.status === 'empty' ? `${ink.name} ink empty` : `${ink.name} ink low`,
        message: ink.status === 'empty' ? `Refill the ${ink.name} tank before printing.` : `${ink.name} is at ${ink.level}%. Refill soon.`,
      });
    }
  }
  return events;
}

export class Notifier {
  constructor({ send = defaultSend, now = () => new Date(), prefs = {}, log = () => {} } = {}) {
    this.send = send;
    this.now = now;
    this.log = log;
    this.prefs = { mute: false, quietStart: 21, quietEnd: 9, categories: {}, ...prefs };
    this.active = new Set(); // keys already notified while the condition lasts
  }

  enabled(category) {
    return !this.prefs.mute && this.prefs.categories[category] !== false;
  }

  inQuietHours() {
    const { quietStart, quietEnd } = this.prefs;
    if (quietStart == null || quietEnd == null || quietStart === quietEnd) return false;
    const h = this.now().getHours();
    return quietStart > quietEnd ? h >= quietStart || h < quietEnd : h >= quietStart && h < quietEnd;
  }

  /** Forget a condition so it notifies again if it comes back (e.g. a support code cleared). */
  clear(prefix) {
    for (const k of [...this.active]) if (k.startsWith(prefix)) this.active.delete(k);
  }

  async handle(event) {
    if (event.clear) {
      this.active.delete(event.clear);
      return { sent: false, reason: 'cleared' };
    }
    if (this.active.has(event.key)) return { sent: false, reason: 'already notified' };
    this.active.add(event.key);
    if (!this.enabled(event.category)) return { sent: false, reason: 'category off' };
    // Errors always get through; routine news waits for the morning.
    if (event.category !== 'error' && this.inQuietHours()) return { sent: false, reason: 'quiet hours' };
    const exitCode = await this.send(event.title, event.message);
    this.log({ ...event, exitCode });
    return { sent: exitCode === 0, exitCode };
  }
}
