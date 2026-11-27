// Run with: node --test tests
const test = require('node:test');
const assert = require('node:assert');
const { parseLrc, lineIndexAt, layoutLine, vibrantColor, textStyleFor, TEXT_STYLES,
  isVideoId, videoIdsFrom, quotaResetAt, largestImage, isoDurationMs, rankVideos } = require('../web/app.js');

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


test('textStyleFor keeps a chosen style, and Rotate gives each song its own calm style', () => {
  assert.strictEqual(textStyleFor('abc', 'karaoke'), 'karaoke');
  const a = textStyleFor('song-1', 'auto');
  assert.ok(TEXT_STYLES.includes(a));
  assert.strictEqual(textStyleFor('song-1', 'auto'), a, 'same song keeps its style');
  assert.strictEqual(textStyleFor('', 'auto'), 'rise');
  assert.strictEqual(textStyleFor('x', 'glitch'), textStyleFor('x', 'auto'), 'removed styles rotate too');
  const seen = new Set(Array.from({ length: 60 }, (_, i) => textStyleFor('id' + i, 'auto')));
  assert.strictEqual(seen.size, TEXT_STYLES.length, 'all styles come up');
  assert.deepStrictEqual(TEXT_STYLES, ['rise', 'blur', 'karaoke', 'type']);
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

test('isoDurationMs reads YouTube durations', () => {
  assert.strictEqual(isoDurationMs('PT3M48S'), 228000);
  assert.strictEqual(isoDurationMs('PT1H2M3S'), 3723000);
  assert.strictEqual(isoDurationMs('PT45S'), 45000);
  assert.strictEqual(isoDurationMs('P1DT1M'), 86460000);
  assert.strictEqual(isoDurationMs(''), 0);
  assert.strictEqual(isoDurationMs('nonsense'), 0);
  assert.strictEqual(isoDurationMs(undefined), 0);
});

test('rankVideos drops Shorts and prefers the official video of the right length', () => {
  const v = (id, title, dur, w, h) => ({ id, snippet: { title }, contentDetails: { duration: dur }, player: { embedWidth: String(w), embedHeight: String(h) } });
  const ids = ['shortClip01', 'behindScene', 'officialAud', 'officialVid', 'lyricVideo1', 'otherSong01', 'unknownVid1'];
  const details = { items: [
    v('shortClip01', 'Lover #shorts', 'PT58S', 360, 640),
    v('behindScene', 'LOVER Song: Behind The Scenes Video', 'PT3M12S', 640, 360),
    v('officialAud', 'LOVER (Official Audio)', 'PT3M10S', 640, 360),
    v('officialVid', 'LOVER (Official Music Video)', 'PT3M8S', 640, 360),
    v('lyricVideo1', 'Lover (lyrics)', 'PT3M39S', 640, 360),
    v('otherSong01', 'G.O.A.T. (Official Music Video)', 'PT3M44S', 640, 360)] };
  const r = rankVideos(ids, details, 190000, 'Lover');
  assert.strictEqual(r[0], 'officialVid');
  assert.ok(!r.includes('shortClip01'), 'Shorts are dropped');
  assert.ok(r.indexOf('otherSong01') > r.indexOf('officialAud'), 'a different song ranks below this song');
  assert.ok(r.indexOf('behindScene') > r.indexOf('lyricVideo1'), 'behind-the-scenes ranks low');
  assert.strictEqual(r[r.length - 1], 'unknownVid1');
  assert.deepStrictEqual(rankVideos(['tallVideo01'], { items: [v('tallVideo01', 'Lover', 'PT3M8S', 360, 640)] }, 190000, 'Lover'), []);
  assert.deepStrictEqual(rankVideos(['abcdefghijk'], null, 200000, 'x'), ['abcdefghijk']);
  assert.deepStrictEqual(rankVideos([], details, 1, ''), []);
});

test('parseRequest understands what Jarvis asks for', () => {
  const { parseRequest } = require('../web/app.js');
  const k = (q) => { const r = parseRequest(q); return [r.kind, r.text, r.from, r.by, r.shuffle].join('|'); };
  assert.strictEqual(k('Kesariya'), 'any|Kesariya|||false');
  assert.strictEqual(k('play Kesariya on Spotify'), 'any|Kesariya|||false');
  assert.strictEqual(k('Lover by Diljit Dosanjh'), 'track|Lover||Diljit Dosanjh|false');
  assert.strictEqual(k('my road trip playlist'), 'playlist|road trip|||false');
  assert.strictEqual(k('Kesariya from my road trip playlist'), 'inPlaylist|Kesariya|road trip||false');
  assert.strictEqual(k('my liked songs'), 'liked||||false');
  assert.strictEqual(k('shuffle my liked songs'), 'liked||||true');
  assert.strictEqual(k('Tum Hi Ho from liked songs'), 'inLiked|Tum Hi Ho|||false');
  assert.strictEqual(k('Tum Hi Ho from my favourites'), 'inLiked|Tum Hi Ho|||false');
  assert.strictEqual(k('album Brahmastra'), 'album|Brahmastra|||false');
  assert.strictEqual(k('songs by Arijit Singh'), 'artist|Arijit Singh|||false');
  assert.strictEqual(k('shuffle my gym playlist'), 'playlist|gym|||true');
  assert.strictEqual(k('search Arijit'), 'search|Arijit|||false');
  assert.strictEqual(k('find songs like Kesariya'), 'search|songs like Kesariya|||false');
});

test('bestMatch prefers exact, then starts-with, then contains', () => {
  const { bestMatch } = require('../web/app.js');
  const items = [{ title: 'Road Trip Vibes' }, { title: 'Road trip' }, { title: 'Old road trip 2019' }, { title: 'Gym' }];
  assert.strictEqual(bestMatch(items, 'road trip').title, 'Road trip');
  assert.strictEqual(bestMatch(items, 'road trip v').title, 'Road Trip Vibes');
  assert.strictEqual(bestMatch(items, '2019').title, 'Old road trip 2019');
  assert.strictEqual(bestMatch(items, 'nothing like it'), null);
  assert.strictEqual(bestMatch([], 'x'), null);
  assert.strictEqual(bestMatch(items, ''), null);
});
