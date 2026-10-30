// Maintenance for IVEC-era Canon IJ printers (G5000 series and newer): XML jobs with
// servicetype="maintenance" over CHMP. Verified on the G5040 (fw 1.060): a nozzle check ran.
//
// Sources: the printer's own GetCapability (servicetype maintenance) lists Cleaning types
// regular/deep/choke and TestPrint types nozzle_check/auto_registration/manual_registration/
// regi_check, all from inputbin_p2 on A4 or Letter plain paper. Command shapes follow Canon's
// cmdtocanonij3 filter (cnijfilter2 6.81) and fixma-pixma, which ran them on a G7020.
// The older BJL commands (@TestPrint=NozzleCheck) are accepted and silently ignored by this model.

import { ChmpSession } from './chmp.js';

const NS = 'xmlns:ivec="http://www.canon.com/ns/cmd/2008/07/common/"';
const JOB_ID = '00000002'; // the id Canon's own maintenance filter uses
const PAPER = { a4: 'iso_a4_210x297mm', letter: 'na_letter_8.5x11in' };

export const MAINTENANCE = {
  'nozzle-check': {
    label: 'Nozzle check',
    description: 'Prints the nozzle check pattern so you can see whether any nozzles are clogged. Takes about 15 seconds.',
    sheets: 1,
    op: 'TestPrint',
    type: 'nozzle_check',
  },
  cleaning: {
    label: 'Cleaning',
    description: 'Standard cleaning of all colours. Uses some ink and takes about a minute. Print a nozzle check afterwards.',
    sheets: 0,
    op: 'Cleaning',
    type: 'regular',
  },
  'deep-cleaning': {
    label: 'Deep cleaning',
    description: 'Stronger cleaning that uses much more ink. Only use it when regular cleaning has not helped twice in a row.',
    sheets: 0,
    op: 'Cleaning',
    type: 'deep',
    heavy: true,
  },
  'align-check': {
    label: 'Alignment check print',
    description: 'Prints the current print head alignment pattern without changing anything.',
    sheets: 1,
    op: 'TestPrint',
    type: 'regi_check',
  },
  'auto-align': {
    label: 'Automatic head alignment',
    description: 'Prints alignment patterns and adjusts the print head automatically. Takes a few minutes.',
    sheets: 2,
    op: 'TestPrint',
    type: 'auto_registration',
  },
};

function xml(operation, body) {
  return `<?xml version="1.0" encoding="utf-8"?><cmd ${NS}><ivec:contents><ivec:operation>${operation}</ivec:operation><ivec:param_set servicetype="maintenance">${body}</ivec:param_set></ivec:contents></cmd>`;
}

/** The operation command (TestPrint or Cleaning) for a maintenance action. */
export function maintenanceCommand(id, jobId, { paper = 'a4' } = {}) {
  const m = MAINTENANCE[id];
  if (!m) throw new Error(`Unknown maintenance action: ${id}`);
  const job = `<ivec:jobID>${jobId}</ivec:jobID>`;
  if (m.op === 'Cleaning') return xml('Cleaning', `${job}<ivec:type>${m.type}</ivec:type><ivec:inkgroup>all</ivec:inkgroup>`);
  const size = PAPER[paper];
  if (!size) throw new Error(`Unsupported paper "${paper}": maintenance prints use A4 or Letter`);
  return xml('TestPrint', `${job}<ivec:type>${m.type}</ivec:type><ivec:inputbin>inputbin_p2</ivec:inputbin><ivec:papersize>${size}</ivec:papersize><ivec:papertype>stationery</ivec:papertype>`);
}

const field = (x, name) => new RegExp(`<ivec:${name}>([^<]*)</ivec:${name}>`).exec(x)?.[1] ?? '';

function check(replyXml, step) {
  const response = field(replyXml, 'response');
  if (response !== 'OK') {
    const detail = field(replyXml, 'response_detail') || 'no reason given';
    throw Object.assign(new Error(`Printer refused ${step}: ${detail}`), { detail });
  }
}

/**
 * Run one maintenance action on an open session: StartJob, the operation, EndJob.
 * The printer then carries on by itself; poll getMaintenanceStatus to follow it.
 * EndJob is always sent once the job has started, so a refused operation never leaves a job open.
 */
export async function runMaintenanceJob(session, id, opts = {}) {
  try {
    const command = maintenanceCommand(id, JOB_ID, opts);
    check(await session.command(xml('StartJob', `<ivec:jobID>${JOB_ID}</ivec:jobID><ivec:bidi>1</ivec:bidi>`)), 'to start the job');
    let opError = null;
    try {
      check(await session.command(command), MAINTENANCE[id].label.toLowerCase());
    } catch (e) {
      opError = e;
    }
    const end = await session.command(xml('EndJob', `<ivec:jobID>${JOB_ID}</ivec:jobID>`));
    if (opError) throw opError;
    check(end, 'to end the job');
    return { accepted: true, action: id, jobId: JOB_ID };
  } finally {
    session.close();
  }
}

export async function runMaintenance(host, id, opts) {
  if (!MAINTENANCE[id]) throw Object.assign(new Error(`Unknown maintenance action: ${id}`), { status: 404 });
  const session = await new ChmpSession(host).open();
  return runMaintenanceJob(session, id, opts);
}

export function parseMaintenanceStatus(replyXml) {
  const info = /<ivec:jobinfo[^>]*>([\s\S]*?)<\/ivec:jobinfo>/.exec(replyXml);
  if (!info) return { running: false };
  return { running: true, operation: field(info[1], 'maintenance_operation'), type: field(info[1], 'type'), progress: field(info[1], 'jobprogress') };
}

export async function getMaintenanceStatus(host) {
  const session = await new ChmpSession(host).open();
  try {
    return parseMaintenanceStatus(await session.command(xml('GetStatus', '')));
  } finally {
    session.close();
  }
}
