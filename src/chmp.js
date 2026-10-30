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

/** Send one IVEC command and read its reply over a single keep-alive connection. */
export function chmpCommand(host, xml, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port: 80 });
    let buf = Buffer.alloc(0);
    let phase = 'post';
    const fail = (e) => {
      sock.destroy();
      reject(e);
    };
    sock.setTimeout(timeoutMs, () => fail(new Error(`CHMP timed out after ${timeoutMs} ms`)));
    sock.on('error', fail);
    const headers = (method, len) =>
      `${method} ${CONTROL} HTTP/1.1\r\nHost: ${host}\r\nX-CHMP-Version: 1.1.0\r\nConnection: Keep-Alive\r\n` +
      (len !== undefined ? `Content-Type: application/octet-stream\r\nContent-Length: ${len}\r\n` : '') + '\r\n';
    sock.on('connect', () => {
      const body = Buffer.from(xml, 'utf8');
      sock.write(Buffer.concat([Buffer.from(headers('POST', body.length), 'latin1'), body]));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const res = parseResponse(buf);
      if (!res) return;
      buf = buf.subarray(res.length);
      if (phase === 'post') {
        if (res.status !== 200) return fail(new Error(`CHMP command rejected with HTTP ${res.status}`));
        phase = 'get';
        sock.write(headers('GET'));
      } else {
        sock.end();
        if (res.status !== 200) return reject(new Error(`CHMP reply failed with HTTP ${res.status}`));
        resolve(res.body.toString('utf8'));
      }
    });
  });
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
