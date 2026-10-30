// Canon IJ (PIXMA G-series) specifics: BJL maintenance jobs sent over raw port 9100,
// and the status the printer's own Remote UI publishes in JS_MDL/model.js.
//
// Command strings come from the *%CNMaintenanceCommand lines in Canon's cnijfilter2 PPDs
// (G3000/G4000 and 29 other models). The job framing follows Canon's cmdtocanonij2 filter
// (ESC [ K ... BJLSTART / BJLEND) wrapped in the IVEC StartJob/EndJob envelope that
// Gutenprint uses for the same printer family (print-canon.h prexml_iP2700/postxml_iP2700).

import net from 'node:net';
import http from 'node:http';

export const MAINTENANCE = {
  'nozzle-check': {
    command: '@TestPrint=NozzleCheck',
    label: 'Nozzle check',
    description: 'Prints the nozzle check pattern on one sheet of plain A4/Letter paper. Use it to see whether any nozzles are clogged.',
    paper: true,
  },
  cleaning: {
    command: '@Cleaning=1ALL',
    label: 'Print head cleaning',
    description: 'Runs a standard cleaning of all colours. Uses some ink. Print a nozzle check afterwards to confirm the result.',
    paper: false,
  },
  'auto-align': {
    command: '@TestPrint=Regi_Auto1',
    label: 'Automatic print head alignment',
    description: 'Prints an alignment pattern and adjusts the head. Listed in 13 of 31 Canon IJ driver files; the G5000 may ignore it if it only supports manual alignment.',
    paper: true,
    experimental: true,
  },
};

const XML_HEAD = '<?xml version="1.0" encoding="utf-8" ?>';
const NS_IVEC = 'xmlns:ivec="http://www.canon.com/ns/cmd/2008/07/common/"';
const NS_VCN = 'xmlns:vcn="http://www.canon.com/ns/cmd/2008/07/canon/"';
const JOB_ID = '00000001';

const START_JOB =
  `${XML_HEAD}<cmd ${NS_IVEC}><ivec:contents><ivec:operation>StartJob</ivec:operation>` +
  `<ivec:param_set servicetype="print"><ivec:jobID>${JOB_ID}</ivec:jobID><ivec:bidi>0</ivec:bidi></ivec:param_set></ivec:contents></cmd>`;
const MODE_SHIFT =
  `${XML_HEAD}<cmd ${NS_IVEC} ${NS_VCN}><ivec:contents><ivec:operation>VendorCmd</ivec:operation>` +
  `<ivec:param_set servicetype="print"><vcn:ijoperation>ModeShift</vcn:ijoperation><vcn:ijmode>1</vcn:ijmode>` +
  `<ivec:jobID>${JOB_ID}</ivec:jobID></ivec:param_set></ivec:contents></cmd>`;
const END_JOB =
  `${XML_HEAD}<cmd ${NS_IVEC}><ivec:contents><ivec:operation>EndJob</ivec:operation>` +
  `<ivec:param_set servicetype="print"><ivec:jobID>${JOB_ID}</ivec:jobID></ivec:param_set></ivec:contents></cmd>`;

const BJL_ENTER = Buffer.from([0x1b, 0x5b, 0x4b, 0x02, 0x00, 0x00, 0x1f]);

/** Build the byte stream for one BJL maintenance command, ready to send to port 9100. */
export function buildMaintenanceJob(command) {
  if (typeof command !== 'string' || command.trim() === '') throw new Error('Command is empty');
  if (/[\r\n]/.test(command)) throw new Error('Command must be a single line');
  if (!/^[\x20-\x7e]+$/.test(command)) throw new Error('Command must be printable ASCII');
  return Buffer.concat([
    Buffer.from(START_JOB + MODE_SHIFT, 'latin1'),
    BJL_ENTER,
    Buffer.from(`BJLSTART\nControlMode=Common\n${command.trim()}\nBJLEND\n`, 'latin1'),
    Buffer.from(END_JOB, 'latin1'),
  ]);
}

/** Write a buffer to the printer's raw socket (JetDirect / port 9100) and wait for it to close. */
export function sendRaw(host, data, { port = 9100, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error(`Raw port ${port} timed out after ${timeoutMs} ms`)));
    sock.on('error', reject);
    sock.on('connect', () => sock.end(data));
    sock.on('close', (hadError) => {
      if (!hadError) resolve({ bytes: data.length, ms: Date.now() - started });
    });
    sock.resume();
  });
}

// From the Remote UI's own top.js (dispPrintInfo) and LANG/messID.js (English strings).
const BUSY_STATES = {
  0: 'Ready to print',
  1: 'The printer is executing another task.',
  2: 'The printer is in operation.',
  3: 'An error has occurred.',
  4: 'Check the printer',
  5: 'Cleaning in progress',
  6: 'Test printing in progress',
  // 7 maps to MES0604, which this firmware's English string table does not define.
  8: 'Preparing SSL/TLS. Please wait a while and try loading again.',
};

/** Parse the `var g_x = ...;` assignments in the Remote UI's model.js. */
export function parseRemoteUiModel(source) {
  const vars = {};
  const re = /var\s+(g_[A-Za-z0-9_]+)\s*=\s*('([^']*)'|(-?\d+))\s*;/g;
  for (const m of source.matchAll(re)) {
    vars[m[1]] = m[3] !== undefined ? m[3] : Number(m[4]);
  }
  const busyState = vars.g_bst_st !== undefined ? String(vars.g_bst_st) : null;
  return {
    vars,
    busyState,
    busyStateText: busyState === null ? null : (BUSY_STATES[busyState] ?? `Unknown state (${busyState})`),
    errorMessageId: vars.g_err_msg_id ?? null,
  };
}

/** Fetch a path from the printer's built-in web server. */
export function fetchPrinterHttp(host, path, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.get({ host, port: 80, path, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), ms: Date.now() - started }));
    });
    req.on('timeout', () => req.destroy(new Error(`HTTP ${path} timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
  });
}

export async function getRemoteUiStatus(host) {
  const res = await fetchPrinterHttp(host, '/JS_MDL/model.js');
  if (res.status !== 200) throw new Error(`Remote UI model.js returned HTTP ${res.status}`);
  return parseRemoteUiModel(res.body.toString('utf8'));
}
