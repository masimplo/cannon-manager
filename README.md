# G5040 Manager

A local web app to diagnose, run and maintain a Canon PIXMA G5040 (reports itself as "G5000 series") from a Mac, where Canon ships no management software.

```bash
npm start            # http://localhost:4280 (Node 22, no dependencies)
npm test
PRINTER_HOST=192.168.1.178 npm start   # skip Bonjour discovery
```

It binds to 127.0.0.1 only: there is no login, and the API can start cleanings and prints. Settings and history live in `data/` (gitignored).

## What it does

- **Overview**: state in plain English, ink tanks, paper per tray, sheets fed, print head replacement counts, Canon support codes, and this Mac's CUPS queue (with a resume button, since macOS pauses the queue when a job fails).
- **Maintenance**: nozzle check, cleaning, deep cleaning, alignment check print, automatic head alignment. Refused while the printer is busy.
- **Print**: images and single-page PDFs (converted to JPEG with `sips`), plus a colour test page.
- **Jobs**, **Diagnostics** (ports, IPP, Remote UI assets, HTTPS certificate, printer clock, macOS queue), **History** (status changes, ink over time, actions).

## How it talks to the printer

| Channel | Used for |
|---|---|
| IPP, port 631 (`src/ipp.js`) | status, ink, jobs, printing JPEG, Identify-Printer |
| CHMP, port 80 (`src/chmp.js`) | IVEC XML: `GetStatus` (device/print/maintenance) and maintenance jobs |
| Remote UI `JS_MDL/model.js` | the printer's own busy-state code |

CHMP: POST an IVEC command to `/canon/ij/command2/port1`, then GET the same path **on the same keep-alive connection** for the reply. A maintenance job is `StartJob` → `TestPrint`/`Cleaning` (servicetype `maintenance`) → `EndJob`, all on one connection; on another connection the printer answers `NotStart`.

The older BJL maintenance commands (`@TestPrint=NozzleCheck` over port 9100 or IPP) are accepted and silently ignored by this model; Canon moved the G5000 series to IVEC maintenance (`cmdtocanonij3` in cnijfilter2 6.81).

The printer reports which maintenance types it supports via `GetCapability` (servicetype `maintenance`): Cleaning `regular`, `deep`, `choke`; TestPrint `nozzle_check`, `auto_registration`, `manual_registration`, `regi_check`, all from `inputbin_p2` (cassette) on A4/Letter plain paper. `choke` (system flush) and manual alignment are deliberately not offered.

Verified on hardware (fw 1.060): nozzle check. Cleaning, deep cleaning and alignment use the same job shape and are listed by the printer's capability, but have not been run from this app yet.
