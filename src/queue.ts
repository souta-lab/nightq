import { readFile, writeFile, appendFile, stat, open } from 'node:fs/promises';

export type State = 'TODO' | 'DOING' | 'DONE' | 'BLOCKED';
export interface QueueItem { number: number; state: State; title: string; notes: string[] }
export type QueuePart = { kind: 'text'; text: string } | { kind: 'item'; item: QueueItem };
export interface QueueDoc { items: QueueItem[]; parts: QueuePart[]; trailingNewline: boolean }
export const QUEUE_TEMPLATE = '# Queue\n\nThe single work list. A watcher monitors this file; workers take items top-down.\nOne item = one deliverable. States: TODO / DOING / DONE / BLOCKED (with a reason note).\n\n## Items\n\n';
export const LOG_TEMPLATE = '# Stream Log\n\n';

export function parseQueue(text: string): QueueDoc {
  const doc: QueueDoc = { items: [], parts: [], trailingNewline: text.endsWith('\n') };
  const lines = text.split('\n');
  if (doc.trailingNewline || text === '') lines.pop();
  let preceding: QueueItem | undefined;
  for (const line of lines) {
    const match = /^(\d+)\. \[(TODO|DOING|DONE|BLOCKED)\] (.*)$/.exec(line);
    const note = /^   - (.*)$/.exec(line);
    if (match) {
      preceding = { number: doc.items.length + 1, state: match[2] as State, title: match[3]!, notes: [] };
      doc.items.push(preceding);
      doc.parts.push({ kind: 'item', item: preceding });
    } else if (note && preceding) preceding.notes.push(note[1]!);
    else { doc.parts.push({ kind: 'text', text: line }); preceding = undefined; }
  }
  return doc;
}

export function renderQueue(doc: QueueDoc): string {
  let number = 0;
  return doc.parts.flatMap(part => {
    if (part.kind === 'text') return [part.text];
    const item = part.item;
    item.number = ++number;
    return [`${number}. [${item.state}] ${item.title}`, ...item.notes.map(note => `   - ${note}`)];
  }).join('\n') + (doc.trailingNewline ? '\n' : '');
}

function singleLine(value: string, label: string): void {
  if (!value.trim() || /[\r\n]/.test(value)) throw new Error(`${label} must be nonempty and on one line`);
}
export function addItem(doc: QueueDoc, title: string, note?: string): QueueItem {
  singleLine(title, 'Title');
  if (note !== undefined) singleLine(note, 'Note');
  const item: QueueItem = { number: doc.items.length + 1, state: 'TODO', title, notes: note === undefined ? [] : [note] };
  let position = doc.parts.length;
  for (let i = doc.parts.length - 1; i >= 0; i--) {
    if (doc.parts[i]!.kind === 'item') { position = i + 1; break; }
  }
  doc.parts.splice(position, 0, { kind: 'item', item });
  doc.items.push(item);
  doc.trailingNewline = true;
  return item;
}
export function setState(doc: QueueDoc, n: number, state: State, note?: string): QueueItem {
  if (!Number.isSafeInteger(n) || n < 1 || n > doc.items.length) throw new Error(`Item ${n} is out of range`);
  const item = doc.items[n - 1]!;
  if (state === 'DOING' && item.state === 'DONE') throw new Error(`Item ${n} is DONE and cannot be claimed`);
  if (note !== undefined) singleLine(note, state === 'BLOCKED' ? 'Reason' : 'Note');
  if (state === 'BLOCKED' && note === undefined) throw new Error('A block reason is required');
  item.state = state;
  if (state === 'BLOCKED') {
    const index = item.notes.findIndex(value => value.startsWith('BLOCKED: '));
    item.notes = item.notes.filter(value => !value.startsWith('BLOCKED: '));
    item.notes.splice(index < 0 ? item.notes.length : index, 0, `BLOCKED: ${note}`);
  } else if (note !== undefined) item.notes.push(note);
  return item;
}
export async function loadQueue(path: string): Promise<QueueDoc> { return parseQueue(await readFile(path, 'utf8')); }
export async function saveQueue(path: string, doc: QueueDoc): Promise<void> { await writeFile(path, renderQueue(doc)); }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
async function createFile(path: string, text: string): Promise<boolean> {
  try {
    const file = await open(path, 'wx');
    try { await file.writeFile(text); } finally { await file.close(); }
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
}
function time(now: Date): string { return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`; }
export async function appendLog(logPath: string, message: string, now = new Date()): Promise<void> {
  singleLine(message, 'Message');
  await createFile(logPath, LOG_TEMPLATE);
  const existing = await readFile(logPath, 'utf8');
  await appendFile(logPath, `${existing.length && !existing.endsWith('\n') ? '\n' : ''}- [${time(now)}] ${message}\n`);
}
export function parseLogTime(line: string, now = new Date()): Date | null {
  const match = /^- \[(\d{2}):(\d{2})\] /.exec(line);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  const date = new Date(now);
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return date;
}
export function parseDuration(s: string): number {
  const match = /^(\d+(?:\.\d+)?)([smh]?)$/.exec(s);
  if (!match) throw new Error(`Invalid duration: ${s}`);
  const duration = Number(match[1]) * ({ s: 1000, m: 60_000, h: 3_600_000, '': 1000 }[match[2]!]!);
  if (!Number.isFinite(duration)) throw new Error(`Invalid duration: ${s}`);
  return duration;
}
export async function checkWatch(queuePath: string, logPath: string, stallMs: number, now = new Date()): Promise<{ stalled: boolean; doingCount: number; lastUpdate: Date | null; ageMs: number | null }> {
  const [doc, info, log] = await Promise.all([loadQueue(queuePath), stat(queuePath), readFile(logPath, 'utf8')]);
  let lastUpdate = info.mtime;
  for (const line of log.split('\n')) {
    const timestamp = parseLogTime(line, now);
    if (timestamp && timestamp > lastUpdate) lastUpdate = timestamp;
  }
  const doingCount = doc.items.filter(item => item.state === 'DOING').length;
  const ageMs = now.getTime() - lastUpdate.getTime();
  return { stalled: doingCount > 0 && ageMs > stallMs, doingCount, lastUpdate, ageMs };
}

export const HELP = `Usage: nightq [--queue <path>] [--log <path>] <command>
Commands:
  init                          Create missing queue and log files
  add "<title>" [--note <text>]   Add a TODO item
  list                          List items and state counts
  claim <n>                     Set an item to DOING
  done <n> [--note <text>]        Complete an item
  block <n> <reason...>          Block an item with a reason
  log <message...>              Append a stream log entry
  watch [--stall <dur>]          Check for stalled work (default 20m)
  help, --help                  Show help
Global flags --queue and --log may appear anywhere (defaults: QUEUE.md, stream-log.md).
Durations: 20m, 90s, 1h, or seconds such as 45.`;

export async function runCli(argv: string[], print: (text: string) => void = console.log): Promise<number> {
  let queue = 'QUEUE.md', log = 'stream-log.md';
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--queue' || arg === '--log') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`);
      if (arg === '--queue') queue = value; else log = value;
    } else args.push(arg);
  }
  if (!args.length || args.includes('--help') || args[0] === 'help') { print(HELP); return 0; }
  const command = args.shift()!;
  function option(flag: string): string | undefined {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    args.splice(index, 2); return value;
  }
  if (command === 'init') {
    if (args.length) throw new Error('init takes no arguments');
    if (await createFile(queue, QUEUE_TEMPLATE)) print(`Created ${queue}`);
    if (await createFile(log, `${LOG_TEMPLATE}- [${time(new Date())}] Queue initialized\n`)) print(`Created ${log}`);
    return 0;
  }
  if (command === 'log') { await appendLog(log, args.join(' ')); return 0; }
  if (command === 'watch') {
    const stall = parseDuration(option('--stall') ?? '20m');
    if (args.length) throw new Error('Unexpected watch arguments');
    const result = await checkWatch(queue, log, stall);
    const age = result.ageMs === null ? 'unknown' : `${Math.floor(Math.max(0, result.ageMs) / 60_000)}m`;
    print(`${result.stalled ? 'STALLED' : 'OK'}: ${result.doingCount} item(s) in DOING, no update for ${age}`);
    return result.stalled ? 1 : 0;
  }
  if (!['add', 'list', 'claim', 'done', 'block'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const note = command === 'add' || command === 'done' ? option('--note') : undefined;
  let doc: QueueDoc;
  try { doc = await loadQueue(queue); }
  catch (error) { if (command === 'add' && isMissing(error)) doc = parseQueue(QUEUE_TEMPLATE); else throw error; }
  if (command === 'list') {
    if (args.length) throw new Error('list takes no arguments');
    for (const item of doc.items) print(`${item.number}. [${item.state}] ${item.title}`);
    const count = (state: State) => doc.items.filter(item => item.state === state).length;
    print(`— ${count('TODO')} todo, ${count('DOING')} doing, ${count('DONE')} done, ${count('BLOCKED')} blocked`);
    return 0;
  }
  let item: QueueItem;
  if (command === 'add') {
    if (args.length !== 1) throw new Error('Usage: add "<title>" [--note <text>]');
    item = addItem(doc, args[0]!, note);
  } else {
    const raw = args.shift() ?? '';
    if (!/^[1-9]\d*$/.test(raw)) throw new Error('Item number must be a positive integer');
    if (command !== 'block' && args.length) throw new Error(`Unexpected ${command} arguments`);
    item = setState(doc, Number(raw), command === 'claim' ? 'DOING' : command === 'done' ? 'DONE' : 'BLOCKED', command === 'block' ? args.join(' ') : note);
  }
  await saveQueue(queue, doc);
  const verb = command === 'add' ? 'added' : command === 'claim' ? 'claimed' : command === 'done' ? 'done' : 'blocked';
  await appendLog(log, `Item ${item.number} ${verb}: ${item.title}${command === 'block' ? ` — ${args.join(' ')}` : ''}`);
  print(command === 'add' ? `Added #${item.number}: ${item.title}` : `Item ${item.number} ${verb}: ${item.title}`);
  return 0;
}
