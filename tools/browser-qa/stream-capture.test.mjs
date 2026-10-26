import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapture } from './stream-capture.mjs';

const secret = 'SYNTHETIC_CAPTURE_SECRET';

test('safe output is retained exactly, including whitespace and Unicode', () => {
  const capture = createCapture([secret]);
  capture.push('  first\r\n');
  capture.push(Buffer.from('中文 😀\n'));
  capture.push('last\t');
  assert.equal(capture.text, '  first\r\n中文 😀\nlast\t');
  assert.equal(capture.secretExposed, false);
});

test('ASCII secret is detected across every possible two-chunk boundary', () => {
  for (let cut = 1; cut < secret.length; cut++) {
    const capture = createCapture([secret], { maxChars: 4 });
    capture.push(Buffer.from('before ' + secret.slice(0, cut)));
    assert.equal(capture.secretExposed, false);
    capture.push(Buffer.from(secret.slice(cut) + ' after'));
    assert.equal(capture.secretExposed, true, 'split at ' + cut);
    assert.equal(capture.text, 'fter');
  }
});

test('a marker longer than the display limit is detected one character at a time', () => {
  const capture = createCapture(['tiny', secret], { maxChars: 1 });
  for (const character of secret) capture.push(character);
  assert.equal(capture.secretExposed, true);
  assert.equal(capture.text, secret.at(-1));
});

test('early exposure stays true after subsequent output has evicted the secret', () => {
  const capture = createCapture([secret], { maxChars: 32 });
  capture.push(secret);
  assert.equal(capture.secretExposed, true);
  capture.push('safe output '.repeat(1000));
  assert.equal(capture.text.includes(secret), false);
  assert.equal(capture.text.length, 32);
  assert.equal(capture.secretExposed, true);
});

test('secret inside one oversized chunk is detected before truncation', () => {
  const capture = createCapture([secret], { maxChars: 8 });
  capture.push(Buffer.from('prefix ' + secret + ' ' + 'x'.repeat(10000)));
  assert.equal(capture.text, 'xxxxxxxx');
  assert.equal(capture.secretExposed, true);
});

test('similar fragments separated by actual content do not become a secret', () => {
  const capture = createCapture([secret], { maxChars: 8 });
  capture.push('SYNTHETIC_CAPTURE_');
  capture.push('not-the-marker');
  capture.push('SECRET');
  assert.equal(capture.secretExposed, false);
});

test('UTF-8 characters split between Buffer chunks are decoded without corruption', () => {
  const capture = createCapture([secret]);
  const expected = '中文 😀 café\r\n';
  const bytes = Buffer.from(expected);
  for (const byte of bytes) capture.push(Buffer.from([byte]));
  assert.equal(capture.text, expected);
  assert.equal(capture.text.includes('\ufffd'), false);
  assert.equal(capture.secretExposed, false);
});

test('truncation does not retain a broken half of a Unicode surrogate pair', () => {
  const capture = createCapture([secret], { maxChars: 2 });
  capture.push(Buffer.from('A😀B'));
  assert.equal(capture.text, 'B');
  assert.ok(capture.text.length <= 2);
  capture.push('中');
  assert.equal(capture.text, 'B中');
});

test('string pushes preserve strings and terminate a preceding partial byte sequence', () => {
  const capture = createCapture([secret]);
  capture.push(Buffer.from([0xe4]));
  assert.equal(capture.text, '');
  capture.push('plain\r\n');
  assert.equal(capture.text, '\ufffdplain\r\n');
  capture.push(Buffer.from('中文'));
  assert.equal(capture.text, '\ufffdplain\r\n中文');
});

test('empty output budget still detects secrets without retaining log text', () => {
  const capture = createCapture([secret], { maxChars: 0 });
  capture.push(secret.slice(0, 5));
  capture.push(secret.slice(5));
  assert.equal(capture.text, '');
  assert.equal(capture.secretExposed, true);
});

test('empty marker list is allowed, but empty, non-ASCII and non-string markers are rejected', () => {
  const capture = createCapture([]);
  capture.push('safe');
  assert.equal(capture.text, 'safe');
  assert.equal(capture.secretExposed, false);
  for (const markers of [[''], [secret, ''], ['秘密'], [null], [42], 'not-an-array']) {
    assert.throws(() => createCapture(markers), TypeError);
  }
});

test('invalid output limits and push input types are rejected', () => {
  for (const maxChars of [-1, 0.5, NaN, Infinity, '8', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createCapture([secret], { maxChars }), RangeError);
  }
  const capture = createCapture([secret]);
  for (const value of [null, undefined, 12, {}, new Uint8Array([65])]) {
    assert.throws(() => capture.push(value), TypeError);
  }
});

test('stdout and stderr instances do not combine fragments or share exposure state', () => {
  const stdout = createCapture([secret]);
  const stderr = createCapture([secret]);
  stdout.push('SYNTHETIC_CAPTURE_');
  stderr.push('SECRET');
  assert.equal(stdout.secretExposed, false);
  assert.equal(stderr.secretExposed, false);
  stdout.push('SECRET');
  assert.equal(stdout.secretExposed, true);
  assert.equal(stderr.secretExposed, false);
  assert.equal(stderr.text, 'SECRET');
});

test('marker inputs are snapshotted rather than changed by caller mutation', () => {
  const markers = [secret];
  const capture = createCapture(markers);
  markers[0] = 'different';
  markers.push('safe');
  capture.push('safe');
  assert.equal(capture.secretExposed, false);
  capture.push(secret);
  assert.equal(capture.secretExposed, true);
});
