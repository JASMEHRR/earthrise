// Run with: node --test tests
const test = require('node:test');
const assert = require('node:assert');
const { hostAllowed, isLoopback, clientIdFromEnv, sha256 } = require('../link/earthrise-link.js');

test('hostAllowed accepts IPs and localhost only, so other domains cannot reach the link server', () => {
  assert.strictEqual(hostAllowed('127.0.0.1:5173'), true);
  assert.strictEqual(hostAllowed('192.168.1.20:5173'), true);
  assert.strictEqual(hostAllowed('localhost:5173'), true);
  assert.strictEqual(hostAllowed('[::1]:5173'), true);
  assert.strictEqual(hostAllowed('evil.example.com:5173'), false);
  assert.strictEqual(hostAllowed('127.0.0.1.nip.io'), false);
  assert.strictEqual(hostAllowed(''), false);
  assert.strictEqual(hostAllowed(undefined), false);
});

test('isLoopback recognises this laptop only', () => {
  assert.ok(isLoopback('127.0.0.1') && isLoopback('::1') && isLoopback('::ffff:127.0.0.1'));
  assert.ok(!isLoopback('192.168.1.5') && !isLoopback('::ffff:192.168.1.5') && !isLoopback(undefined));
});

test('clientIdFromEnv reads a 32-character Client ID line', () => {
  assert.strictEqual(clientIdFromEnv('# c\nSPOTIFY_CLIENT_ID=5eae3d5d4aed429daabfca97e4720896\nYOUTUBE_API_KEY=x\n'), '5eae3d5d4aed429daabfca97e4720896');
  assert.strictEqual(clientIdFromEnv('SPOTIFY_CLIENT_ID=\n'), '');
  assert.strictEqual(clientIdFromEnv('SPOTIFY_CLIENT_ID=nothex'), '');
  assert.strictEqual(clientIdFromEnv(undefined), '');
});

test('sha256 is stable hex', () => {
  assert.strictEqual(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
