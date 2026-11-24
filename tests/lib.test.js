// Run with: node --test tests
const test = require('node:test');
const assert = require('node:assert');
const { parseLrc, lineIndexAt, layoutLine } = require('../web/app.js');

test('parseLrc reads timed lines and sorts them', () => {
  const lrc = '[00:12.50]Second line\n[00:01.00]First line\n[ar:Someone]\n[01:02.25]Third';
  const out = parseLrc(lrc);
  assert.deepStrictEqual(out, [
    { t: 1000, text: 'First line' },
    { t: 12500, text: 'Second line' },
    { t: 62250, text: 'Third' },
  ]);
});

test('parseLrc keeps empty instrumental lines and repeated timestamps', () => {
  const out = parseLrc('[00:05.00][00:20.00]Chorus\n[00:10.00]');
  assert.deepStrictEqual(out.map(l => [l.t, l.text]), [[5000, 'Chorus'], [10000, ''], [20000, 'Chorus']]);
});

test('parseLrc returns null for empty or invalid input', () => {
  assert.strictEqual(parseLrc(''), null);
  assert.strictEqual(parseLrc(null), null);
  assert.strictEqual(parseLrc('no timestamps here'), null);
});

test('lineIndexAt finds the line being sung', () => {
  const lines = [{ t: 1000 }, { t: 5000 }, { t: 9000 }];
  assert.strictEqual(lineIndexAt(lines, 0), -1);
  assert.strictEqual(lineIndexAt(lines, 1000), 0);
  assert.strictEqual(lineIndexAt(lines, 8999), 1);
  assert.strictEqual(lineIndexAt(lines, 100000), 2);
  assert.strictEqual(lineIndexAt([], 10), -1);
  assert.strictEqual(lineIndexAt(null, 10), -1);
});

test('layoutLine makes content words big and filler words small', () => {
  const rows = layoutLine('I want the world in my hands');
  const flat = rows.flat();
  const big = flat.filter(x => x.big).map(x => x.w);
  assert.deepStrictEqual(big, ['want', 'world', 'hands']);
  assert.ok(rows.length >= 2, 'long line wraps into rows');
});

test('layoutLine honours *big* and / markers', () => {
  const rows = layoutLine('*Connect* / *Spotify* now');
  assert.deepStrictEqual(rows, [[{ w: 'Connect', big: true }], [{ w: 'Spotify', big: true }, { w: 'now', big: false }]]);
});

test('layoutLine always has at least one big word and handles empty text', () => {
  const rows = layoutLine('oh oh oh');
  assert.strictEqual(rows.flat().filter(x => x.big).length, 1);
  assert.deepStrictEqual(layoutLine(''), []);
  assert.deepStrictEqual(layoutLine(undefined), []);
});
