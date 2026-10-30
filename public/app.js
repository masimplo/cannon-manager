const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const MEDIA_LABELS = {
  iso_a4_210x297mm: 'A4', na_letter_8: 'Letter', iso_a5_148x210mm: 'A5', jis_b5_182x257mm: 'B5', na_legal_8: 'Legal',
  'na_index-4x6_4x6in': '4×6 in photo', na_5x7_5x7in: '5×7 in photo', 'oe_photo-l_3.5x5in': '3.5×5 in (L)', 'na_govt-letter_8x10in': '8×10 in',
};
const mediaLabel = (m) => MEDIA_LABELS[m] ?? MEDIA_LABELS[m.split('.')[0]] ?? m.replace(/^[a-z]+_/, '').replace(/_/g, ' ');

let state = { status: null, config: null, maintenance: {} };

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status, body });
  return body;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 8000 : 4500);
}

function confirmDialog(title, body, okLabel = 'Continue', danger = false) {
  return new Promise((resolve) => {
    const d = $('#confirm');
    $('#confirmTitle').textContent = title;
    $('#confirmBody').textContent = body;
    $('#confirmOk').textContent = okLabel;
    $('#confirmOk').className = danger ? 'danger' : '';
    d.onclose = () => resolve(d.returnValue === 'ok');
    d.showModal();
  });
}

// ---- tabs
function showTab(name) {
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== name));
  location.hash = name;
  if (name === 'jobs') loadJobs();
  if (name === 'history') loadHistory();
  if (name === 'print') loadPrints();
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
// Back/forward and edited URLs switch tabs too.
window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if ($(`[data-panel="${CSS.escape(name)}"]`) && $(`[data-panel="${CSS.escape(name)}"]`).hidden) showTab(name);
});
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) showTab(g.dataset.goto);
});

// ---- status
function fmtUptime(s) {
  if (typeof s !== 'number') return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

function renderStatus({ host, summary: s, remoteUiError, at }) {
  $('#banner').hidden = true;
  $('#printerName').textContent = s.name ?? 'Canon printer';
  $('#printerSub').textContent = `${host} · firmware ${s.firmware ?? '?'}`;
  $('#healthDot').className = `dot ${s.health}`;
  $('#healthDot').title = s.health;
  $('#headline').textContent = s.headline;
  $('#updatedAt').textContent = `Updated ${new Date(at).toLocaleTimeString()}`;
  $('#remoteUiLink').href = `http://${host}/`;
  const facts = [
    ['State', s.state],
    ['Accepting jobs', s.acceptingJobs ? 'Yes' : 'No'],
    ['Jobs queued', s.queuedJobs ?? 0],
    ['Paper loaded', [...new Set(s.mediaReady)].map(mediaLabel).join(', ') || '—'],
    ['On for', fmtUptime(s.upTimeSeconds)],
  ];
  if (remoteUiError) facts.push(['Printer web page', `Not responding (${remoteUiError})`]);
  $('#facts').innerHTML = facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('#issues').innerHTML = s.issues.length
    ? s.issues.map((i) => `<li class="${esc(i.severity)}">${esc(i.text)}</li>`).join('')
    : '<li>No problems reported.</li>';
  $('#inks').innerHTML = s.inks.map((i) => `
    <div class="tank ${esc(i.status)}">
      <div class="glass" aria-label="${esc(i.name)} ${i.level}%">
        <div class="fill" style="height:${Math.max(0, i.level)}%;background:${esc(i.color)}"></div>
        <div class="lowline" style="bottom:${i.low}%" title="Low mark (${i.low}%)"></div>
      </div>
      <span class="pct">${i.level < 0 ? '?' : `${i.level}%`}</span>
      <span class="label">${esc(i.name)}</span>
    </div>`).join('');
  const usage = [];
  for (const t of s.trays ?? []) usage.push([t.source, `${mediaLabel(t.size ?? '')} · ${PAPER_TYPES[t.type] ?? (t.type?.replace(/^custom-media-type-canon-(\d+)$/, 'Canon media type $1') ?? '?')}`]);
  for (const [src, n] of Object.entries(s.sheetsFed ?? {})) usage.push([`Sheets fed, ${src.toLowerCase()}`, n.toLocaleString()]);
  if (s.totalSheets !== undefined) usage.push(['Sheets fed, total', s.totalSheets.toLocaleString()]);
  if (s.headReplacements) usage.push(['Print head replacements', Object.entries(s.headReplacements).map(([k, v]) => `${k} ${v}`).join(', ')]);
  if (s.supportCode) usage.push(['Support code', s.supportCode]);
  $('#usage').innerHTML = usage.length
    ? usage.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')
    : `<dt class="muted">Not available</dt><dd class="muted">${esc(state.status?.chmpError ?? '')}</dd>`;
  renderMaintCards();
  loadMacQueues();
}

const PAPER_TYPES = { stationery: 'Plain paper', photographic: 'Photo paper', envelope: 'Envelope' };

async function loadMacQueues() {
  try {
    const queues = await api('/api/mac-queues');
    $('#macQueues').innerHTML = queues.length
      ? queues.map((q) => `
        <p><b>${esc(q.name)}</b>: ${q.enabled ? 'running' : '<span style="color:var(--err)">paused</span>'}${q.jobs.length ? ` · ${q.jobs.length} job(s) waiting` : ' · no jobs waiting'}</p>
        ${q.jobs.length ? `<ul class="small muted">${q.jobs.map((j) => `<li>${esc(j)}</li>`).join('')}</ul>` : ''}
        ${q.enabled ? '' : `<p class="small muted">macOS pauses a queue when a job fails. Resuming sends any waiting jobs to the printer.</p><button data-resume="${esc(q.name)}">Resume queue</button>`}`).join('')
      : '<p>No macOS print queue points at this printer. Add it in System Settings → Printers &amp; Scanners.</p>';
  } catch (e) {
    $('#macQueues').textContent = e.message;
  }
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-resume]');
  if (!b) return;
  const name = b.dataset.resume;
  const waiting = $('#macQueues').querySelectorAll('li').length;
  if (!(await confirmDialog(`Resume ${name}`, waiting ? `This will send the ${waiting} waiting job(s) to the printer right away.` : 'The queue will accept and print jobs again.', 'Resume'))) return;
  try {
    const q = await api('/api/mac-queues/resume', { method: 'POST', body: JSON.stringify({ name }) });
    toast(q?.enabled ? `${name} resumed.` : `${name} is still paused.`, !q?.enabled);
    loadMacQueues();
  } catch (err) {
    toast(err.message, true);
  }
});

async function refresh() {
  try {
    state.status = await api('/api/status');
    renderStatus(state.status);
  } catch (e) {
    $('#healthDot').className = 'dot error';
    $('#headline').textContent = 'Printer not reachable';
    $('#banner').hidden = false;
    $('#banner').innerHTML = e.status === 409
      ? `${esc(e.message)} <button class="ghost" data-goto="settings">Open settings</button>`
      : /EHOSTUNREACH/.test(e.message)
        ? `macOS is blocking this app from the local network (${esc(e.message)}). Open System Settings → Privacy &amp; Security → Local Network and turn on <b>node</b>, then reload.`
        : `Can't reach the printer: ${esc(e.message)}. Check that it is switched on and connected, then run <a href="#diagnostics" data-goto="diagnostics">Diagnostics</a>.`;
  }
}
$('#refreshBtn').addEventListener('click', refresh);

// ---- maintenance
function renderMaintCards() {
  const blocked = state.status?.summary?.maintenanceBlocked;
  $('#maintCards').innerHTML = Object.entries(state.maintenance).map(([id, m]) => `
    <article class="card maint">
      <h2>${esc(m.label)} ${m.heavy ? '<span class="tag">Uses a lot of ink</span>' : ''}</h2>
      <p>${esc(m.description)}</p>
      <p class="small">${m.sheets ? `Prints ${m.sheets} sheet${m.sheets > 1 ? 's' : ''} of plain paper from the cassette.` : 'No paper needed.'}</p>
      <button data-maint="${esc(id)}" ${blocked ? `title="${esc(blocked)}"` : ''}>${esc(m.label)}</button>
    </article>`).join('');
}

async function runMaint(id) {
  const m = state.maintenance[id];
  const label = m.label;
  const msg = m.op === 'Cleaning'
    ? `${m.description} Do not turn the printer off while it runs.`
    : `Prints ${m.sheets} sheet${m.sheets > 1 ? 's' : ''}. Make sure plain A4 paper is in the cassette.`;
  if (!(await confirmDialog(label, msg, 'Start', Boolean(m.heavy)))) return;
  const send = (force) => api(`/api/maintenance/${id}`, { method: 'POST', body: JSON.stringify({ force }) });
  try {
    await send(false);
    toast(`${label}: sent to the printer.`);
  } catch (e) {
    if (e.body?.blocked && (await confirmDialog('Printer is busy', `${e.message}. Sending now may be ignored or queued. Send anyway?`, 'Send anyway', true))) {
      try {
        await send(true);
        toast(`${label}: sent to the printer.`);
      } catch (e2) {
        toast(e2.message, true);
      }
    } else if (!e.body?.blocked) toast(e.message, true);
  }
  // Follow the job closely while it runs.
  for (const ms of [2000, 5000, 10000, 20000, 40000, 70000]) setTimeout(refresh, ms);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-maint]');
  if (b) runMaint(b.dataset.maint);
});

$('#identifyBtn').addEventListener('click', async () => {
  try {
    await api('/api/identify', { method: 'POST' });
    toast('The printer should be flashing its light now.');
  } catch (e) {
    toast(e.message, true);
  }
});

// ---- print
let chosenFile = null;
function setFile(f) {
  chosenFile = f;
  $('#dropText').textContent = f ? `${f.name} (${Math.round(f.size / 1024)} KB)` : 'Drop a file here or click to choose';
  $('#printBtn').disabled = !f;
}
$('#file').addEventListener('change', (e) => setFile(e.target.files[0]));
const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); setFile(e.dataTransfer.files[0]); });

function printOptions() {
  return { media: $('#media').value, sides: $('#sides').value, colorMode: $('#colorMode').value, quality: $('#quality').value, copies: $('#copies').value };
}
function reportPrint(r) {
  if (r.ok) toast(`Sent as job ${r.jobId ?? ''} (${r.jobState ?? r.status}).`);
  else toast(`Printer refused the job: ${r.status}`, true);
  loadPrints();
}
$('#printBtn').addEventListener('click', async () => {
  if (!chosenFile) return;
  const btn = $('#printBtn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const q = new URLSearchParams({ ...printOptions(), filename: chosenFile.name });
    const res = await fetch(`/api/print?${q}`, { method: 'POST', body: chosenFile, headers: { 'Content-Type': 'application/octet-stream' } });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    reportPrint(body);
  } catch (e) {
    toast(e.message, true);
    loadPrints();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Print';
  }
});
async function printTestPage() {
  if (!(await confirmDialog('Print colour test page', 'Prints one A4 page with colour bars, ramps and a line grid.', 'Print'))) return;
  try {
    reportPrint(await api('/api/test-page', { method: 'POST', body: JSON.stringify({ media: 'iso_a4_210x297mm', quality: 4 }) }));
  } catch (e) {
    toast(e.message, true);
  }
}
$('#testPageBtn').addEventListener('click', printTestPage);
$('#testPageQuick').addEventListener('click', printTestPage);

// ---- recent prints
const COLOR_LABEL = { color: 'Colour', monochrome: 'B&W', 'auto-monochrome': 'B&W', auto: 'Auto colour' };
const SIDES_LABEL = { 'one-sided': '1-sided', 'two-sided-long-edge': '2-sided', 'two-sided-short-edge': '2-sided (short)' };
const QUALITY_LABEL = { 3: 'Draft', 4: 'Standard', 5: 'High' };
let printList = [];
let openPrint = null;

function optionsSummary(o = {}) {
  return [o.media && mediaLabel(o.media), o.copies > 1 && `${o.copies} copies`, COLOR_LABEL[o.colorMode], SIDES_LABEL[o.sides], QUALITY_LABEL[o.quality]].filter(Boolean).join(' · ');
}

async function loadPrints() {
  try {
    printList = await api('/api/prints');
  } catch (e) {
    $('#prints').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    return;
  }
  $('#printsCount').textContent = printList.length ? `${printList.length} of 30` : '';
  $('#prints').innerHTML = printList.length
    ? printList.map((p) => `
      <button class="print-item" data-print="${p.id}" title="${esc(p.name)}">
        <span class="thumb">${p.hasThumbnail === false ? '<span class="placeholder">No preview</span>' : `<img src="/api/prints/${p.id}/thumb" alt="" loading="lazy">`}</span>
        <span class="meta">
          <b>${esc(p.name)}</b>
          <span><span class="badge ${p.source === 'mac' ? 'mac' : ''}">${p.source === 'mac' ? 'From Mac' : 'From this app'}</span>${p.options?.pages ? ` <span class="muted">${p.options.pages} page${p.options.pages > 1 ? 's' : ''}</span>` : ''}</span>
          <span class="muted">${new Date(p.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}${p.reprintOf ? ' · re-print' : ''}</span>
          ${p.ok ? `<span class="muted">${esc(optionsSummary(p.options))}</span>` : `<span class="failed">Not printed: ${esc(p.status)}</span>`}
        </span>
      </button>`).join('')
    : '<p class="muted">Nothing printed from this app yet.</p>';
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-print]');
  if (!b) return;
  openPrint = printList.find((p) => p.id === b.dataset.print);
  if (!openPrint) return;
  const o = openPrint.options ?? {};
  $('#previewImg').src = `/api/prints/${openPrint.id}/image`;
  $('#previewImg').alt = openPrint.name;
  $('#previewName').textContent = openPrint.name;
  $('#previewMeta').textContent = `${openPrint.source === 'mac' ? `From the Mac${o.user ? ` (${o.user})` : ''}${o.pages ? `, ${o.pages} page${o.pages > 1 ? 's' : ''} (preview shows page 1)` : ''} · ` : ''}${new Date(openPrint.at).toLocaleString()} · ${openPrint.ok ? `job ${openPrint.jobId ?? '?'}, ${openPrint.status}` : `not printed (${openPrint.status})`}`;
  const fromMac = openPrint.source === 'mac';
  $('#rpMacNote').hidden = !fromMac;
  for (const sel of ['#rpColor', '#rpSides', '#rpQuality', '#rpMedia']) $(sel).closest('label').hidden = fromMac;
  $('#rpCopies').value = o.copies ?? 1;
  $('#rpColor').value = o.colorMode ?? 'color';
  $('#rpSides').value = o.sides ?? 'one-sided';
  $('#rpQuality').value = String(o.quality ?? 4);
  $('#rpMedia').innerHTML = $('#media').innerHTML;
  $('#rpMedia').value = o.media ?? 'iso_a4_210x297mm';
  $('#printDialog').showModal();
});

$('#rpPrint').addEventListener('click', async () => {
  const btn = $('#rpPrint');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const body = openPrint.source === 'mac'
      ? { copies: $('#rpCopies').value }
      : { copies: $('#rpCopies').value, colorMode: $('#rpColor').value, sides: $('#rpSides').value, quality: $('#rpQuality').value, media: $('#rpMedia').value };
    const r = await api(`/api/prints/${openPrint.id}/reprint`, { method: 'POST', body: JSON.stringify(body) });
    $('#printDialog').close();
    reportPrint(r);
  } catch (e) {
    toast(e.message, true);
    loadPrints();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Print again';
  }
});

$('#rpDelete').addEventListener('click', async () => {
  try {
    await api(`/api/prints/${openPrint.id}`, { method: 'DELETE' });
    $('#printDialog').close();
    loadPrints();
  } catch (e) {
    toast(e.message, true);
  }
});

// ---- jobs
function jobRow(j, active) {
  return `<tr><td>${j['job-id']}</td><td>${esc(j['job-name'] ?? '')}</td><td>${esc(j['job-originating-user-name'] ?? '')}</td><td>${esc(j.state)}</td>
    <td>${active ? `<button class="ghost" data-cancel="${j['job-id']}">Cancel</button>` : esc(j['job-impressions-completed'] ?? '')}</td></tr>`;
}
async function loadJobs() {
  try {
    const { active, completed } = await api('/api/jobs');
    $('#jobsActive').innerHTML = active.length ? active.map((j) => jobRow(j, true)).join('') : '<tr><td colspan="5" class="muted">No jobs waiting.</td></tr>';
    $('#jobsDone').innerHTML = completed.length ? completed.slice(0, 20).map((j) => jobRow(j, false)).join('') : '<tr><td colspan="5" class="muted">None reported by the printer.</td></tr>';
  } catch (e) {
    toast(e.message, true);
  }
}
$('#jobsRefresh').addEventListener('click', loadJobs);
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cancel]');
  if (!b) return;
  try {
    await api(`/api/jobs/${b.dataset.cancel}/cancel`, { method: 'POST' });
    toast(`Job ${b.dataset.cancel} cancelled.`);
    loadJobs();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---- diagnostics
$('#diagRun').addEventListener('click', async () => {
  const btn = $('#diagRun');
  btn.disabled = true;
  btn.textContent = 'Running…';
  $('#checks').innerHTML = '<li class="muted">Checking ports, IPP, web page, certificate and macOS queue…</li>';
  try {
    const { checks } = await api('/api/diagnostics');
    $('#checks').innerHTML = checks.map((c) => `<li class="${esc(c.result)}"><span class="res">${esc(c.result)}</span><b>${esc(c.title)}</b>${esc(c.detail)}</li>`).join('');
  } catch (e) {
    $('#checks').innerHTML = `<li class="fail">${esc(e.message)}</li>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run diagnostics';
  }
});
let allAttrs = null;
$('details:has(#attrs)').addEventListener('toggle', async (e) => {
  if (!e.target.open || allAttrs) return;
  try {
    allAttrs = await api('/api/attributes');
    renderAttrs();
  } catch (err) {
    toast(err.message, true);
  }
});
function renderAttrs() {
  const f = $('#attrFilter').value.toLowerCase();
  $('#attrs').innerHTML = Object.entries(allAttrs)
    .filter(([k, v]) => !f || k.includes(f) || JSON.stringify(v).toLowerCase().includes(f))
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`).join('');
}
$('#attrFilter').addEventListener('input', () => allAttrs && renderAttrs());

// ---- history
function describe(e) {
  if (e.type === 'status') return `${e.headline ?? e.state}${e.state === 'unreachable' && e.error ? ` (${e.error})` : ''}${e.inks ? ` · ink ${Object.entries(e.inks).map(([k, v]) => `${k.split(' ')[0]} ${v}%`).join(', ')}` : ''}${e.raw ? ` · ${rawSignals(e.raw)}` : ''}`;
  if (e.type === 'action' && e.action === 'mac-print') return `Printed from the Mac: "${e.file}" → ${e.result}`;
  if (e.type === 'action' && e.action === 'reprint') return `You re-printed "${e.file}" → ${e.result}`;
  if (e.type === 'action') return `You ran: ${state.maintenance[e.action]?.label ?? e.action}${e.file ? ` "${e.file}"` : ''}${e.forced ? ' (sent while busy)' : ''}${e.result ? ` → ${e.result}` : ''}`;
  if (e.type === 'diagnostics') return e.failing.length ? `Diagnostics: failing ${e.failing.join(', ')}` : 'Diagnostics: all checks passed';
  return JSON.stringify(e);
}
function rawSignals(r) {
  return [
    `IPP ${r.ippState}${r.ippReasons?.filter((x) => x !== 'none').length ? `/${r.ippReasons.join(',')}` : ''}`,
    r.remoteUiCode != null && `UI ${r.remoteUiCode}`,
    r.chmpStatus && `CHMP ${r.chmpStatus}${r.chmpStatusDetail ? `/${r.chmpStatusDetail}` : ''}`,
    r.supportCode && `code ${r.supportCode}`,
    r.maintenance && `maint ${r.maintenance.operation}${r.maintenance.type ? `:${r.maintenance.type}` : ''}`,
    r.totalSheets != null && `${r.totalSheets} sheets`,
  ].filter(Boolean).join(' · ');
}

async function loadHistory() {
  const entries = await api('/api/history');
  $('#log').innerHTML = entries.length
    ? entries.map((e) => `<li><time>${new Date(e.at).toLocaleString()}</time><span>${esc(describe(e))}</span></li>`).join('')
    : '<li class="muted">Nothing recorded yet.</li>';
  drawInkChart(entries.filter((e) => e.type === 'status' && e.inks).reverse());
}
function drawInkChart(samples) {
  const svg = $('#inkChart');
  const W = 800, H = 220, P = 28;
  const colors = state.status?.summary?.inks?.reduce((m, i) => ({ ...m, [i.name]: i.color }), {}) ?? {};
  let out = [0, 25, 50, 75, 100].map((v) => {
    const y = H - P - ((H - 2 * P) * v) / 100;
    return `<line class="grid-line" x1="${P}" x2="${W}" y1="${y}" y2="${y}"/><text x="0" y="${y + 4}">${v}</text>`;
  }).join('');
  if (samples.length < 2) {
    svg.innerHTML = `${out}<text x="${W / 2 - 150}" y="${H / 2}">Not enough history yet. Keep the app running.</text>`;
    $('#inkLegend').innerHTML = '';
    return;
  }
  const t0 = new Date(samples[0].at).getTime();
  const t1 = new Date(samples.at(-1).at).getTime() || t0 + 1;
  const x = (t) => P + ((W - P - 4) * (new Date(t).getTime() - t0)) / Math.max(1, t1 - t0);
  const y = (v) => H - P - ((H - 2 * P) * v) / 100;
  const names = Object.keys(samples.at(-1).inks);
  for (const n of names) {
    const pts = samples.filter((s) => s.inks[n] !== undefined).map((s) => `${x(s.at).toFixed(1)},${y(s.inks[n]).toFixed(1)}`);
    out += `<polyline fill="none" stroke="${colors[n] ?? '#888'}" stroke-width="2" points="${pts.join(' ')}"/>`;
  }
  out += `<text x="${P}" y="${H - 6}">${new Date(t0).toLocaleDateString()}</text><text x="${W - 90}" y="${H - 6}">${new Date(t1).toLocaleDateString()}</text>`;
  svg.innerHTML = out;
  $('#inkLegend').innerHTML = names.map((n) => `<span style="--c:${colors[n] ?? '#888'}">${esc(n)}</span>`).join('');
}

// ---- settings
async function loadCapture() {
  try {
    const c = await api('/api/capture');
    $('#captureStatus').innerHTML = !c.running
      ? `<p style="color:var(--err)">Off: ${esc(c.error ?? 'not running')}</p>`
      : !c.queue
        ? '<p>The capture printer is running, but no macOS printer uses it yet.</p>'
        : `<p><b>On.</b> Printing to <b>Canon G5040 (via Manager)</b> saves every job in Recent prints, then sends it to the printer.${c.isDefault ? ' It is your default printer.' : ' It is not your default printer; choose it in the print dialog.'}</p>
           <p class="small muted">If this app is not running, macOS keeps those jobs waiting and sends them when it starts again. The direct queue "Canon G5000 series" still works without the app.</p>`;
  } catch (e) {
    $('#captureStatus').textContent = e.message;
  }
}

async function loadConfig() {
  loadCapture();
  state.config = await api('/api/config');
  $('#hostInput').value = state.config.host ?? '';
  $('#pollEvery').textContent = Math.round(state.config.pollMs / 1000);
}
$('#hostSave').addEventListener('click', async () => {
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify({ host: $('#hostInput').value.trim() }) });
    toast('Saved.');
    refresh();
  } catch (e) {
    toast(e.message, true);
  }
});
$('#discoverBtn').addEventListener('click', async () => {
  $('#found').innerHTML = '<li class="muted">Searching the network (about 5 seconds)…</li>';
  try {
    const found = await api('/api/discover');
    $('#found').innerHTML = found.length
      ? found.map((p) => `<li><span><b>${esc(p.name)}</b> · ${esc(p.host)}</span><button class="ghost" data-use="${esc(p.host)}">Use</button></li>`).join('')
      : '<li class="muted">No printers found. Enter the IP address manually.</li>';
  } catch (e) {
    $('#found').innerHTML = `<li class="muted">${esc(e.message)}</li>`;
  }
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-use]');
  if (b) {
    $('#hostInput').value = b.dataset.use;
    $('#hostSave').click();
  }
});

// ---- boot
async function boot() {
  const [maint] = await Promise.all([api('/api/maintenance'), loadConfig()]);
  state.maintenance = maint;
  const media = ['iso_a4_210x297mm', 'na_letter_8.5x11in', 'iso_a5_148x210mm', 'na_legal_8.5x14in', 'na_index-4x6_4x6in', 'na_5x7_5x7in', 'na_govt-letter_8x10in'];
  $('#media').innerHTML = media.map((m) => `<option value="${m}">${esc(mediaLabel(m))}</option>`).join('');
  showTab(location.hash.slice(1) || 'overview');
  await refresh();
  setInterval(() => document.visibilityState === 'visible' && refresh(), 10000);
}
boot();
