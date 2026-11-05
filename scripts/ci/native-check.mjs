// SPDX-License-Identifier: AGPL-3.0-only
// Proves the backend's native modules load and work inside an image (ADR-026).
// Run as: docker run --rm <image> --input-type=module -e "$(cat scripts/ci/native-check.mjs)"
const { compressSync, uncompressSync } = await import('snappy');
const { hash, verify } = await import('@node-rs/argon2');

const input = Buffer.from('watchlog '.repeat(256));
const compressed = compressSync(input);
if (!uncompressSync(compressed).equals(input)) throw new Error('snappy round trip failed');

const digest = await hash('native-check', { algorithm: 2, memoryCost: 19456, timeCost: 2 });
if (!digest.startsWith('$argon2id$') || !(await verify(digest, 'native-check'))) {
  throw new Error('argon2id hash/verify failed');
}
console.log(
  `native modules ok on ${process.platform}/${process.arch}: snappy ${input.length}→${compressed.length} bytes, argon2id`,
);
