// SPDX-License-Identifier: AGPL-3.0-only
// High-entropy secrets (sessions, cluster tokens) are stored as SHA-256 hashes (ADR-025).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit random value, base64url encoded (43 characters). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
