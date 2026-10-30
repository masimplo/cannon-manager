// Minimal IPP/1.1 client (RFC 8010 encoding, RFC 8011 semantics).
// Only what this app needs: no dependencies, plain HTTP POST to port 631.

import http from 'node:http';

export const OP = {
  PRINT_JOB: 0x0002,
  VALIDATE_JOB: 0x0004,
  CANCEL_JOB: 0x0008,
  GET_JOB_ATTRIBUTES: 0x0009,
  GET_JOBS: 0x000a,
  GET_PRINTER_ATTRIBUTES: 0x000b,
  IDENTIFY_PRINTER: 0x003c,
};

const GROUP_TAGS = { 0x01: 'operation', 0x02: 'job', 0x04: 'printer', 0x05: 'unsupported' };
const END_TAG = 0x03;

const VALUE_TAGS = {
  integer: 0x21, boolean: 0x22, enum: 0x23,
  octetString: 0x30, dateTime: 0x31, resolution: 0x32, rangeOfInteger: 0x33,
  begCollection: 0x34, endCollection: 0x37,
  text: 0x41, name: 0x42, keyword: 0x44, uri: 0x45, uriScheme: 0x46,
  charset: 0x47, naturalLanguage: 0x48, mimeMediaType: 0x49, memberAttrName: 0x4a,
};

export const STATUS = {
  0x0000: 'successful-ok',
  0x0001: 'successful-ok-ignored-or-substituted-attributes',
  0x0002: 'successful-ok-conflicting-attributes',
  0x0400: 'client-error-bad-request',
  0x0401: 'client-error-forbidden',
  0x0403: 'client-error-not-authorized',
  0x0404: 'client-error-not-possible',
  0x0405: 'client-error-timeout',
  0x0406: 'client-error-not-found',
  0x040a: 'client-error-document-format-not-supported',
  0x040b: 'client-error-attributes-or-values-not-supported',
  0x0500: 'server-error-internal-error',
  0x0501: 'server-error-operation-not-supported',
  0x0506: 'server-error-not-accepting-jobs',
  0x0507: 'server-error-busy',
  0x0508: 'server-error-job-canceled',
};

function encodeValue(type, value) {
  switch (type) {
    case 'integer':
    case 'enum': {
      const b = Buffer.alloc(4);
      b.writeInt32BE(value);
      return b;
    }
    case 'boolean':
      return Buffer.from([value ? 1 : 0]);
    default:
      return Buffer.from(String(value), 'utf8');
  }
}

function encodeAttribute(name, type, value) {
  const tag = VALUE_TAGS[type];
  if (tag === undefined) throw new Error(`Unsupported IPP value type: ${type}`);
  const values = Array.isArray(value) ? value : [value];
  const parts = values.map((v, i) => {
    const n = i === 0 ? Buffer.from(name, 'utf8') : Buffer.alloc(0);
    const val = encodeValue(type, v);
    const head = Buffer.alloc(3);
    head.writeUInt8(tag, 0);
    head.writeUInt16BE(n.length, 1);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(val.length);
    return Buffer.concat([head, n, len, val]);
  });
  return Buffer.concat(parts);
}

/**
 * Encode an IPP request. Attributes are [name, type, value] triples; a value may be an array
 * for 1setOf attributes. attributes-charset and attributes-natural-language are added first,
 * as RFC 8011 requires.
 */
export function encodeRequest(operation, requestId, operationAttrs, jobAttrs = [], data) {
  const header = Buffer.alloc(8);
  header.writeUInt8(1, 0);
  header.writeUInt8(1, 1);
  header.writeUInt16BE(operation, 2);
  header.writeUInt32BE(requestId, 4);
  const chunks = [header, Buffer.from([0x01])];
  chunks.push(encodeAttribute('attributes-charset', 'charset', 'utf-8'));
  chunks.push(encodeAttribute('attributes-natural-language', 'naturalLanguage', 'en'));
  for (const [n, t, v] of operationAttrs) chunks.push(encodeAttribute(n, t, v));
  if (jobAttrs.length) {
    chunks.push(Buffer.from([0x02]));
    for (const [n, t, v] of jobAttrs) chunks.push(encodeAttribute(n, t, v));
  }
  chunks.push(Buffer.from([END_TAG]));
  if (data) chunks.push(data);
  return Buffer.concat(chunks);
}

function decodeValue(tag, buf) {
  switch (tag) {
    case 0x21:
    case 0x23:
      return buf.readInt32BE(0);
    case 0x22:
      return buf[0] !== 0;
    case 0x31: {
      const y = buf.readUInt16BE(0);
      const pad = (n) => String(n).padStart(2, '0');
      const sign = String.fromCharCode(buf[8]);
      return `${y}-${pad(buf[2])}-${pad(buf[3])}T${pad(buf[4])}:${pad(buf[5])}:${pad(buf[6])}${sign}${pad(buf[9])}:${pad(buf[10])}`;
    }
    case 0x32:
      return { x: buf.readInt32BE(0), y: buf.readInt32BE(4), units: buf[8] === 3 ? 'dpi' : 'dpcm' };
    case 0x33:
      return { lower: buf.readInt32BE(0), upper: buf.readInt32BE(4) };
    default:
      if (tag >= 0x10 && tag <= 0x1f) return null; // out-of-band (no-value, unknown, ...)
      return buf.toString('utf8');
  }
}

/** Decode an IPP message. Attributes with several values become arrays; collections become objects. */
export function decodeMessage(buf) {
  if (buf.length < 9) throw new Error('IPP message truncated');
  const msg = {
    version: `${buf[0]}.${buf[1]}`,
    operation: buf.readUInt16BE(2),
    statusCode: buf.readUInt16BE(2),
    requestId: buf.readUInt32BE(4),
    groups: [],
    data: Buffer.alloc(0),
  };
  let pos = 8;
  let group = null;
  let lastName = null;
  // Stack of collections being built: each frame is { obj, member, parentName }.
  const stack = [];

  const need = (n) => {
    if (pos + n > buf.length) throw new Error('IPP message truncated');
  };
  const assign = (target, name, value) => {
    if (Object.hasOwn(target, name)) {
      const cur = target[name];
      target[name] = Array.isArray(cur) && cur.__multi ? cur : Object.assign([cur], { __multi: true });
      target[name].push(value);
    } else {
      target[name] = value;
    }
  };

  for (;;) {
    need(1);
    const tag = buf[pos++];
    if (tag === END_TAG) break;
    if (tag < 0x10) {
      group = { tag: GROUP_TAGS[tag] ?? `group-${tag}`, attrs: {} };
      msg.groups.push(group);
      continue;
    }
    need(2);
    const nameLen = buf.readUInt16BE(pos);
    pos += 2;
    need(nameLen + 2);
    const name = buf.toString('utf8', pos, pos + nameLen);
    pos += nameLen;
    const valueLen = buf.readUInt16BE(pos);
    pos += 2;
    need(valueLen);
    const raw = buf.subarray(pos, pos + valueLen);
    pos += valueLen;
    if (!group) throw new Error('IPP attribute outside of a group');

    if (stack.length) {
      const frame = stack[stack.length - 1];
      if (tag === 0x4a) {
        frame.member = raw.toString('utf8');
      } else if (tag === 0x34) {
        stack.push({ obj: {}, member: null, parentName: frame.member });
      } else if (tag === 0x37) {
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent) assign(parent.obj, frame.parentName, frame.obj);
        else assign(group.attrs, frame.parentName, frame.obj);
      } else {
        assign(frame.obj, frame.member, decodeValue(tag, raw));
      }
      continue;
    }

    const attrName = nameLen ? name : lastName;
    lastName = attrName;
    if (tag === 0x34) {
      stack.push({ obj: {}, member: null, parentName: attrName });
      continue;
    }
    assign(group.attrs, attrName, decodeValue(tag, raw));
  }
  msg.data = buf.subarray(pos);
  // Strip the internal multi-value marker so results are plain arrays.
  const clean = (o) => {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (Array.isArray(v)) {
        delete v.__multi;
        v.forEach((x) => x && typeof x === 'object' && !Array.isArray(x) && clean(x));
      } else if (v && typeof v === 'object') clean(v);
    }
  };
  msg.groups.forEach((g) => clean(g.attrs));
  return msg;
}

let nextRequestId = 1;

/** POST an IPP request to http://host:port/path and resolve with the decoded response. */
export function ippRequest({ host, port = 631, path = '/ipp/print', timeoutMs = 15000 }, operation, operationAttrs, jobAttrs, data) {
  const requestId = nextRequestId++;
  const body = encodeRequest(
    operation,
    requestId,
    [['printer-uri', 'uri', `ipp://${host}:${port}${path}`], ...operationAttrs],
    jobAttrs,
    data,
  );
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, path, method: 'POST', headers: { 'Content-Type': 'application/ipp', 'Content-Length': body.length }, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          if (res.statusCode !== 200) return reject(new Error(`IPP HTTP ${res.statusCode}`));
          try {
            const msg = decodeMessage(raw);
            msg.status = STATUS[msg.statusCode] ?? `0x${msg.statusCode.toString(16).padStart(4, '0')}`;
            msg.raw = raw;
            resolve(msg);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`IPP request timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

/** Merge all attribute groups of a given tag into one object. */
export function groupAttrs(msg, tag) {
  return Object.assign({}, ...msg.groups.filter((g) => g.tag === tag).map((g) => g.attrs));
}
