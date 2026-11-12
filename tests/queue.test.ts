import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addItem, appendLog, checkWatch, loadQueue, parseDuration, parseLogTime, parseQueue, QUEUE_TEMPLATE, renderQueue, runCli, saveQueue, setState } from '../src/queue.ts';

let dir: string, queue: string, log: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nightq-test-'));
  queue = join(dir, 'QUEUE.md'); log = join(dir, 'stream-log.md');
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const silent = (_text: string) => {};
async function cli(...args: string[]) { return runCli(['--queue', queue, ...args, '--log', log], silent); }

test('add, claim, and done persist transitions and append logs', async () => {
  await cli('add', 'Ship release');
  expect((await loadQueue(queue)).items[0]?.state).toBe('TODO');
  expect(await readFile(queue, 'utf8')).toContain('1. [TODO] Ship release');
  await cli('claim', '1');
  expect((await loadQueue(queue)).items[0]?.state).toBe('DOING');
  await cli('done', '1', '--note', 'Released');
  expect((await loadQueue(queue)).items[0]?.state).toBe('DONE');
  expect((await loadQueue(queue)).items[0]?.notes).toEqual(['Released']);
  expect((await readFile(log, 'utf8')).match(/^- \[/gm)).toHaveLength(3);
});
test('add note directly beneath item', async () => {
  await cli('add', 'Draft', '--note', 'See docs/draft.md');
  expect(await readFile(queue, 'utf8')).toContain('1. [TODO] Draft\n   - See docs/draft.md\n');
});
test('blocking replaces reason while preserving other notes', async () => {
  await cli('add', 'Deploy', '--note', 'Keep this');
  await cli('block', '1', 'Waiting', 'for access');
  expect((await loadQueue(queue)).items[0]).toMatchObject({ state: 'BLOCKED', notes: ['Keep this', 'BLOCKED: Waiting for access'] });
  await cli('block', '1', 'Approval needed');
  expect((await loadQueue(queue)).items[0]?.notes).toEqual(['Keep this', 'BLOCKED: Approval needed']);
  expect(await readFile(log, 'utf8')).toContain('Item 1 blocked: Deploy — Approval needed');
});
test('claiming DONE and invalid ranges fail', async () => {
  const doc = parseQueue('1. [DONE] Finished\n');
  expect(() => setState(doc, 1, 'DOING')).toThrow('DONE');
  for (const n of [0, 2, -1, NaN, 1.5]) expect(() => setState(doc, n, 'DONE')).toThrow('out of range');
});

describe('watch', () => {
  const now = new Date(2026, 5, 15, 12, 0, 0);
  async function fixture(state: string, logMinutes: number, fresh = false) {
    await writeFile(queue, `# Queue\n\n1. [${state}] Work\n`);
    const timestamp = new Date(now.getTime() - logMinutes * 60_000);
    await appendLog(log, 'Progress', timestamp);
    const mtime = fresh ? now : new Date(now.getTime() - 60 * 60_000);
    await utimes(queue, mtime, mtime);
    return checkWatch(queue, log, 20 * 60_000, now);
  }
  test('old queue and log stall DOING', async () => {
    const result = await fixture('DOING', 30);
    expect(result.stalled).toBe(true);
    expect(result.doingCount).toBe(1);
    expect(result.ageMs).toBe(30 * 60_000);
  });
  test('recent log prevents stall', async () => { expect((await fixture('DOING', 5)).stalled).toBe(false); });
  test('no DOING always OK', async () => { expect((await fixture('TODO', 30)).stalled).toBe(false); });
  test('fresh queue mtime prevents stall', async () => { expect((await fixture('DOING', 30, true)).stalled).toBe(false); });
  test('latest log timestamp wins regardless of line order', async () => {
    await fixture('DOING', 5);
    await appendLog(log, 'Older entry', new Date(now.getTime() - 50 * 60_000));
    expect((await checkWatch(queue, log, 20 * 60_000, now)).ageMs).toBe(5 * 60_000);
  });
  test('threshold is strictly greater', async () => { expect((await fixture('DOING', 20)).stalled).toBe(false); });
  test('missing files fail', async () => { await expect(checkWatch(queue, log, 100, now)).rejects.toThrow(); });
});

test('round trip preserves prose and blank lines and resequences', () => {
  const original = '# Queue\n\nIntro\n9. [TODO] One\n   - Note\n\nBetween\n42. [DOING] Two\n\nFooter\n';
  const doc = parseQueue(original);
  expect(renderQueue(doc)).toBe(original.replace('9.', '1.').replace('42.', '2.'));
  addItem(doc, 'Three');
  expect(renderQueue(doc)).toContain('2. [DOING] Two\n3. [TODO] Three\n\nFooter');
});
test('orphan notes and unterminated text round trip', () => {
  const text = '# Heading\n   - orphan\n1. [TODO] Work\n\n   - separated\nTail';
  expect(renderQueue(parseQueue(text))).toBe(text);
});
test('parse durations and reject invalid values', () => {
  for (const [input, expected] of [['20m', 1_200_000], ['90s', 90_000], ['1h', 3_600_000], ['45', 45_000]] as const) expect(parseDuration(input)).toBe(expected);
  for (const value of ['', '-1', '20x', 'Infinity', '1m junk']) expect(() => parseDuration(value)).toThrow();
});
test('log formatting uses local supplied time and inserts missing newline', async () => {
  await writeFile(log, '# Stream Log');
  await appendLog(log, 'Hello', new Date(2026, 1, 1, 1, 3));
  expect(await readFile(log, 'utf8')).toBe('# Stream Log\n- [01:03] Hello\n');
  expect(parseLogTime('- [25:00] invalid')).toBeNull();
});
test('init creates templates and never overwrites', async () => {
  await cli('init');
  expect(await readFile(queue, 'utf8')).toBe(QUEUE_TEMPLATE);
  await writeFile(queue, 'Custom text');
  await cli('init');
  expect(await readFile(queue, 'utf8')).toBe('Custom text');
});
test('missing queue fails for list but log can create its file', async () => {
  await expect(cli('list')).rejects.toThrow();
  await cli('log', 'Hello', 'world');
  expect(await readFile(log, 'utf8')).toContain('Hello world');
});
test('library save/load retains notes', async () => {
  const doc = parseQueue(QUEUE_TEMPLATE);
  addItem(doc, 'Work', 'A note');
  await saveQueue(queue, doc);
  expect((await loadQueue(queue)).items[0]?.notes).toEqual(['A note']);
});
