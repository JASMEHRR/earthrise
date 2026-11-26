// Run with: node --test tests
const test = require('node:test');
const assert = require('node:assert');
const { parseLrc, lineIndexAt, layoutLine, vibrantColor, sceneForGenres, textStyleFor, TEXT_STYLES,
  isVideoId, videoIdsFrom, quotaResetAt, largestImage } = require('../web/app.js');

function pixels(rgbList) {
  const out = [];
  rgbList.forEach(([r, g, b]) => out.push(r, g, b, 255));
  return out;
}

test('vibrantColor finds the colourful part of a cover and brightens it', () => {
  const data = pixels([...Array(50).fill([20, 20, 20]), ...Array(50).fill([200, 40, 40])]);
  const c = vibrantColor(data);
  assert.ok(c, 'returns a colour');
  assert.ok(c[0] > 200 && c[1] < 120 && c[2] < 120, `red stays red, got ${c}`);
});

test('vibrantColor returns null for grey covers', () => {
  assert.strictEqual(vibrantColor(pixels(Array(100).fill([128, 128, 128]))), null);
  assert.strictEqual(vibrantColor(pixels(Array(100).fill([0, 0, 0]))), null);
  assert.strictEqual(vibrantColor([]), null);
});

test('sceneForGenres maps genres to a background', () => {
  assert.strictEqual(sceneForGenres(['deep house', 'electro']), 'lasers');
  assert.strictEqual(sceneForGenres(['hip hop', 'trap']), 'grid');
  assert.strictEqual(sceneForGenres(['filmi', 'modern bollywood']), 'aurora');
  assert.strictEqual(sceneForGenres(['punjabi pop']), 'bokeh');
  assert.strictEqual(sceneForGenres(['lo-fi beats']), 'stars');
  assert.strictEqual(sceneForGenres(['alternative metal']), 'embers');
  assert.strictEqual(sceneForGenres(['sad rap']), 'rain');
  assert.strictEqual(sceneForGenres(['polka']), null);
  assert.strictEqual(sceneForGenres([]), null);
  assert.strictEqual(sceneForGenres(undefined), null);
});

test('textStyleFor honours a fixed choice and is stable per song in auto', () => {
  assert.strictEqual(textStyleFor('abc', 'karaoke'), 'karaoke');
  const a = textStyleFor('song-1', 'auto');
  assert.ok(TEXT_STYLES.includes(a));
  assert.strictEqual(textStyleFor('song-1', 'auto'), a, 'same song keeps its style');
  assert.strictEqual(textStyleFor('', 'auto'), 'blur');
  assert.strictEqual(textStyleFor('x', 'nonsense'), textStyleFor('x', 'auto'));
  const seen = new Set(Array.from({ length: 60 }, (_, i) => textStyleFor('id' + i, 'auto')));
  assert.ok(seen.size >= 4, 'auto spreads across several styles');
});

test('layoutLine treats Hindi filler words as small', () => {
  const flat = layoutLine('tera naam liya dil ne').flat();
  const small = flat.filter(x => !x.big).map(x => x.w);
  assert.ok(small.includes('tera') && small.includes('ne'));
  assert.ok(flat.find(x => x.w === 'naam').big);
});

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

test('videoIdsFrom keeps valid, unique video ids in order', () => {
  const json = { items: [{ id: { videoId: 'dQw4w9WgXcQ' } }, { id: { channelId: 'UC123' } }, { id: { videoId: 'bad id!' } },
    { id: { videoId: 'dQw4w9WgXcQ' } }, { id: { videoId: 'a_b-c1234XY' } }, null] };
  assert.deepStrictEqual(videoIdsFrom(json), ['dQw4w9WgXcQ', 'a_b-c1234XY']);
  assert.deepStrictEqual(videoIdsFrom({}), []);
  assert.deepStrictEqual(videoIdsFrom(null), []);
  assert.strictEqual(isVideoId('dQw4w9WgXcQ'), true);
  assert.strictEqual(isVideoId('dQw4w9WgXc'), false);
  assert.strictEqual(isVideoId(undefined), false);
});

test('quotaResetAt is the next 08:00 UTC', () => {
  assert.strictEqual(quotaResetAt(Date.UTC(2026, 10, 26, 3, 0)), Date.UTC(2026, 10, 26, 8, 0));
  assert.strictEqual(quotaResetAt(Date.UTC(2026, 10, 26, 8, 0)), Date.UTC(2026, 10, 27, 8, 0));
  assert.strictEqual(quotaResetAt(Date.UTC(2026, 11, 31, 20, 0)), Date.UTC(2027, 0, 1, 8, 0));
});

test('largestImage picks the widest photo and handles empty lists', () => {
  assert.strictEqual(largestImage([{ url: 'a', width: 160 }, { url: 'b', width: 640 }, { url: 'c', width: 320 }]), 'b');
  assert.strictEqual(largestImage([{ url: 'only' }]), 'only');
  assert.strictEqual(largestImage([]), '');
  assert.strictEqual(largestImage(undefined), '');
});
