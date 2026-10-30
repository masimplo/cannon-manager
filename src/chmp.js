// Canon CHMP: IVEC XML commands over HTTP on port 80 (the printer advertises _canon-chmp._tcp
// and SOJ:CHMP in its device ID). Verified on the G5040: POST the command to
// /canon/ij/command2/port1, then GET the same path on the SAME keep-alive connection to read
// the reply. A GET on a new connection returns 409.

import net from 'node:net';

const NS = 'xmlns:ivec="http://www.canon.com/ns/cmd/2008/07/common/"';
const XML_HEAD = '<?xml version="1.0" encoding="utf-8" ?>';
const CONTROL = '/canon/ij/command2/port1';

// inputbin_p1/p2 → names. Inferred, not documented: p1 has 19 sheets fed and a Canon photo
// media type, p2 has 5,821 sheets of plain paper, which matches rear tray vs cassette.
const BINS = { inputbin_p1: 'Rear tray', inputbin_p2: 'Cassette' };

export function getStatusCommand(serviceType) {
  return `${XML_HEAD}<cmd ${NS}><ivec:contents><ivec:operation>GetStatus</ivec:operation><ivec:param_set servicetype="${serviceType}"></ivec:param_set></ivec:contents></cmd>`;
}

export function decodeChunked(buf) {
  const out = [];
  let pos = 0;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd < 0) break;
    const size = parseInt(buf.toString('latin1', pos, lineEnd), 16);
    if (!size) break;
    out.push(buf.subarray(lineEnd + 2, lineEnd + 2 + size));
    pos = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(out);
}

/** Parse one complete HTTP response from the start of buf, or return null if more bytes are needed. */
function parseResponse(buf) {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd < 0) return null;
  const head = buf.toString('latin1', 0, headEnd);
  const status = Number(/^HTTP\/1\.\d (\d+)/.exec(head)?.[1]);
  const rest = buf.subarray(headEnd + 4);
  if (/transfer-encoding:\s*chunked/i.test(head)) {
    const end = rest.indexOf('\r\n0\r\n\r\n');
    if (end < 0 && !rest.subarray(0, 5).equals(Buffer.from('0\r\n\r\n'))) return null;
    const total = end < 0 ? 5 : end + 7;
    return { status, body: decodeChunked(rest.subarray(0, total)), length: headEnd + 4 + total };
  }
  const len = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
  if (rest.length < len) return null;
  return { status, body: rest.subarray(0, len), length: headEnd + 4 + len };
}

/**
 * One keep-alive connection to the CHMP control channel. The printer ties a job to the
 * connection that started it: StartJob on one connection and TestPrint on another fails
 * with response_detail NotStart (verified on the G5040), so a maintenance job must use
 * one session from StartJob to EndJob.
 */
export class ChmpSession {
  constructor(host, { timeoutMs = 10000 } = {}) {
    this.host = host;
    this.timeoutMs = timeoutMs;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.waiter = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: this.host, port: 80 });
      sock.once('connect', () => {
        this.sock = sock;
        resolve(this);
      });
      sock.on('error', (e) => (this.waiter ? this.waiter.reject(e) : reject(e)));
      sock.on('close', () => this.waiter?.reject(new Error('CHMP connection closed by the printer')));
      sock.on('data', (d) => {
        this.buf = Buffer.concat([this.buf, d]);
        const res = parseResponse(this.buf);
        if (!res || !this.waiter) return;
        this.buf = this.buf.subarray(res.length);
        const w = this.waiter;
        this.waiter = null;
        w.resolve(res);
      });
    });
  }

  #exchange(raw) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`CHMP timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.waiter = {
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (e) => (clearTimeout(timer), (this.waiter = null), reject(e)),
      };
      this.sock.write(raw);
    });
  }

  #headers(method, len) {
    return `${method} ${CONTROL} HTTP/1.1\r\nHost: ${this.host}\r\nX-CHMP-Version: 1.3.0\r\nConnection: Keep-Alive\r\n` +
      (len !== undefined ? `Content-Type: application/octet-stream\r\nContent-Length: ${len}\r\n` : '') + '\r\n';
  }

  /** POST an IVEC command, then GET its reply on the same connection. Resolves with the reply XML. */
  async command(xml) {
    const body = Buffer.from(xml, 'utf8');
    const posted = await this.#exchange(Buffer.concat([Buffer.from(this.#headers('POST', body.length), 'latin1'), body]));
    if (posted.status !== 200) throw new Error(`CHMP command rejected with HTTP ${posted.status}`);
    const reply = await this.#exchange(Buffer.from(this.#headers('GET'), 'latin1'));
    if (reply.status !== 200) throw new Error(`CHMP reply failed with HTTP ${reply.status}`);
    return reply.body.toString('utf8');
  }

  close() {
    this.sock?.end();
  }
}

/** Send one IVEC command on a fresh connection and return the reply XML. */
export async function chmpCommand(host, xml, opts) {
  const session = await new ChmpSession(host, opts).open();
  try {
    return await session.command(xml);
  } finally {
    session.close();
  }
}

const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1].trim() : null;
};
const tagsWithAttr = (xml, name, attr) =>
  [...xml.matchAll(new RegExp(`<${name}\\s+${attr}="([^"]*)"[^>]*>([^<]*)</${name}>`, 'g'))].map((m) => [m[1], m[2].trim()]);
const cdata = (s) => s?.replace(/^<!\[CDATA\[|\]\]>$/g, '') ?? null;

export function parseDeviceStatus(xml) {
  const sheetsFed = Object.fromEntries(tagsWithAttr(xml, 'vcn:total_paper_num', 'physicalinputbin').map(([bin, n]) => [BINS[bin] ?? bin, Number(n)]));
  const interfaces = [...xml.matchAll(/<ivec:interface_set id="([^"]+)">([\s\S]*?)<\/ivec:interface_set>/g)].map((m) => ({
    id: m[1],
    mac: cdata(tag(m[2], 'ivec:hwaddress')),
    modes: [...m[2].matchAll(/<vcn:item>([^<]+)<\/vcn:item>/g)].map((x) => x[1]),
  }));
  return {
    response: tag(xml, 'ivec:response'),
    sheetsFed,
    totalSheets: Object.values(sheetsFed).reduce((a, b) => a + b, 0),
    headReplacements: Object.fromEntries(tagsWithAttr(xml, 'vcn:head_replacement_count', 'color').map(([c, n]) => [c, Number(n)])),
    interfaces,
  };
}

export function parsePrintStatus(xml) {
  const sizes = Object.fromEntries(tagsWithAttr(xml, 'ivec:currentpapersize', 'physicalinputbin'));
  const types = Object.fromEntries(tagsWithAttr(xml, 'ivec:currentpapertype', 'physicalinputbin'));
  const bins = [...new Set([...Object.keys(sizes), ...Object.keys(types)])];
  const inks = [...xml.matchAll(/<ivec:ink>([\s\S]*?)<\/ivec:ink>/g)].map((m) => ({
    color: tag(m[1], 'ivec:color'),
    level: Number(tag(m[1], 'ivec:level')),
    icon: tag(m[1], 'ivec:icon'),
  }));
  return {
    response: tag(xml, 'ivec:response'),
    status: tag(xml, 'ivec:status'),
    statusDetail: tag(xml, 'ivec:status_detail') || null,
    supportCode: tag(xml, 'ivec:current_support_code') || null,
    trays: bins.map((b) => ({ source: BINS[b] ?? b, size: sizes[b] ?? null, type: types[b] ?? null })),
    inks,
    jobInfo: tag(xml, 'ivec:jobinfo') || null,
  };
}

export async function getChmpStatus(host) {
  const device = parseDeviceStatus(await chmpCommand(host, getStatusCommand('device')));
  const print = parsePrintStatus(await chmpCommand(host, getStatusCommand('print')));
  return { device, print };
}
