# G5040 Manager

A local web app to diagnose, run and maintain a Canon PIXMA G5040 (reports itself as "G5000 series") from a Mac, where Canon ships no management software.

```bash
npm start            # http://localhost:4280 (Node 22, no dependencies)
npm test
PRINTER_HOST=192.168.1.178 npm start   # skip Bonjour discovery
```

It binds to 127.0.0.1 only: there is no login, and the API can start cleanings and prints. Settings and history live in `data/` (gitignored).

### Run at login

```bash
scripts/install-login-item.sh      # LaunchAgent com.masimplo.g5040-manager, restarts on crash
scripts/uninstall-login-item.sh    # stop and remove it (add --remove-printer to also remove the capture printer)
```

Logs go to `~/Library/Logs/g5040-manager/`. macOS must allow **node** under System Settings → Privacy & Security → Local Network, otherwise the login item gets `EHOSTUNREACH` talking to the printer (a terminal-started copy works without it).

## Mac print capture

The app also runs an IPP printer on `ipp://127.0.0.1:8631/ipp/print` (`src/ipp-proxy.js`). The macOS printer **Canon G5040 (via Manager)** points at it, so every job printed from any Mac app is saved in Recent prints (with a page-1 preview decoded from the URF raster) and then forwarded unchanged to the real printer as a single Print-Job.

Set up (done once):

```bash
cp /etc/cups/ppd/Canon_G5000_series.ppd data/capture-queue.ppd
lpadmin -p Canon_G5040_Manager -v ipp://127.0.0.1:8631/ipp/print -P data/capture-queue.ppd \
  -D "Canon G5040 (via Manager)" -o printer-error-policy=retry-job -E
lpoptions -d Canon_G5040_Manager    # make it the default; lpoptions -d Canon_G5000_series to undo
```

How it behaves (from CUPS's ipp backend): macOS sends Validate-Job, then Create-Job and a chunked Send-Document. The proxy spools the document to disk, answers at once, and forwards it; the printer aborts Create-Job jobs whose document takes more than 60 s, so it never streams. A busy or unreachable printer is retried for up to 24 hours. Refusals end the job as `aborted` (macOS drops it without pausing the queue); the proxy never answers `server-error-internal-error`, which would pause it. If the app is not running, macOS keeps the job and retries for up to 7 days. The direct queue `Canon_G5000_series` keeps working without the app.

Re-printing a captured job replays the stored URF pages with the job's original IPP settings byte-for-byte; only the copy count can change. History keeps the newest 30 prints and at most 500 MB.

## What it does

- **Overview**: state in plain English, ink tanks, paper per tray, sheets fed, print head replacement counts, Canon support codes, and this Mac's CUPS queue (with a resume button, since macOS pauses the queue when a job fails).
- **Maintenance**: nozzle check, cleaning, deep cleaning, alignment check print, automatic head alignment. Refused while the printer is busy.
- **Print**: images and single-page PDFs (converted to JPEG with `sips`), a colour test page, and **Recent prints**: the last 30 prints from the app or the Mac, with preview and re-print.
- **Settings**: the printer's own settings (quiet mode and schedule, auto power on/off, ink drying wait, paper abrasion), read with IVEC `GetConfiguration` and written with `SetConfiguration` inside StartJob/EndJob (servicetype `device`), each change read back and logged. Alignment values and ink detection are never written. Also: Mac print capture status, notifications and keep-alive.
- **Keep-alive nozzle check**: after 7 idle days (by the printer's own sheet counter, or any maintenance), between 09:00 and 21:00, only when the printer is ready and the cassette has plain paper. Needs Auto power on enabled if Auto power off is on, otherwise the printer is off and unreachable.
- **G5040 Manager.app** (`macos/main.swift`, `scripts/build-mac-app.sh` installs it in `~/Applications`): opening it opens the web UI; the server runs it to post notifications under its own name. `osascript` is only a fallback, because its notifications are dropped on macOS 26.
- **Notifications** through that app: support codes, ink low/empty, offline/online, jobs, keep-alive, failed settings changes. Quiet hours (errors still show), per-category switches, mute.
- **Support codes**: `src/support-codes.json` maps every G5000 code to a short category in our own words and a link to Canon's page (Canon's text may not be reproduced).
- **Jobs**, **Diagnostics** (ports, IPP, Remote UI assets, HTTPS certificate, printer clock, macOS queue), **History** (status changes, ink over time, actions).

## How it talks to the printer

| Channel | Used for |
|---|---|
| IPP, port 631 (`src/ipp.js`) | status, ink, jobs, printing JPEG, Identify-Printer |
| CHMP, port 80 (`src/chmp.js`) | IVEC XML: `GetStatus` (device/print/maintenance) and maintenance jobs |
| Remote UI `JS_MDL/model.js` | the printer's own busy-state code |
| IPP server, 127.0.0.1:8631 (`src/ipp-proxy.js`) | receives Mac print jobs (capture printer) |

CHMP: POST an IVEC command to `/canon/ij/command2/port1`, then GET the same path **on the same keep-alive connection** for the reply. A maintenance job is `StartJob` → `TestPrint`/`Cleaning` (servicetype `maintenance`) → `EndJob`, all on one connection; on another connection the printer answers `NotStart`.

The older BJL maintenance commands (`@TestPrint=NozzleCheck` over port 9100 or IPP) are accepted and silently ignored by this model; Canon moved the G5000 series to IVEC maintenance (`cmdtocanonij3` in cnijfilter2 6.81).

The printer reports which maintenance types it supports via `GetCapability` (servicetype `maintenance`): Cleaning `regular`, `deep`, `choke`; TestPrint `nozzle_check`, `auto_registration`, `manual_registration`, `regi_check`, all from `inputbin_p2` (cassette) on A4/Letter plain paper. `choke` (system flush) and manual alignment are deliberately not offered.

Verified on hardware (fw 1.060): nozzle check; `SetConfiguration` (a no-op drying-level write, then Auto power on OFF → ON, both confirmed by read-back). Ink counter reset after a refill is a `VendorCmd` `ResetCounter` (servicetype device), verified by fixma-pixma on a G7020; not built yet. Cleaning, deep cleaning and alignment use the same job shape and are listed by the printer's capability, but have not been run from this app yet.
