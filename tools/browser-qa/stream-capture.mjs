import { StringDecoder } from 'node:string_decoder';

/**
 * Capture a bounded log tail while remembering any ASCII marker ever observed.
 * Buffer chunks form a UTF-8 stream; incomplete characters wait for more bytes.
 * A string is already-decoded text and ends any preceding partial byte sequence.
 * maxChars counts UTF-16 code units, without retaining a cut surrogate pair.
 * Text is not redacted here: the caller controls final diagnostic redaction.
 */
export function createCapture(markers, { maxChars = 65536 } = {}) {
  if (!Array.isArray(markers) || markers.some(marker =>
    typeof marker !== 'string' || !/^[\x00-\x7f]+$/.test(marker))) {
    throw new TypeError('markers must be an array of non-empty ASCII strings');
  }
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
    throw new RangeError('maxChars must be a non-negative safe integer');
  }
  const needles = [...markers];
  const overlapLength = needles.reduce((longest, marker) => Math.max(longest, marker.length - 1), 0);
  let decoder = new StringDecoder('utf8');
  let text = '', overlap = '', secretExposed = false;

  function append(decoded) {
    if (!decoded) return;
    // Scan before trimming the displayed log, including the prior possible prefix.
    if (!secretExposed && needles.length) {
      const searchable = overlap + decoded;
      secretExposed = needles.some(marker => searchable.includes(marker));
      overlap = !secretExposed && overlapLength ? searchable.slice(-overlapLength) : '';
    }
    const combined = text + decoded;
    let start = Math.max(0, combined.length - maxChars);
    if (start > 0 && combined.charCodeAt(start) >= 0xdc00 && combined.charCodeAt(start) <= 0xdfff &&
        combined.charCodeAt(start - 1) >= 0xd800 && combined.charCodeAt(start - 1) <= 0xdbff) {
      start += 1;
    }
    text = combined.slice(start);
  }

  return Object.freeze({
    push(chunk) {
      if (Buffer.isBuffer(chunk)) append(decoder.write(chunk));
      else if (typeof chunk === 'string') {
        append(decoder.end());
        decoder = new StringDecoder('utf8');
        append(chunk);
      } else throw new TypeError('capture.push expects a Buffer or string');
    },
    get text() { return text; },
    get secretExposed() { return secretExposed; },
  });
}
