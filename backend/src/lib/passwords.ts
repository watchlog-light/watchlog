// SPDX-License-Identifier: AGPL-3.0-only
// Password hashing with argon2id, OWASP parameters (ADR-034).
import { hash, verify, type Algorithm, type Options } from '@node-rs/argon2';

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;

const OPTIONS: Options = {
  algorithm: 2 as Algorithm, // Algorithm.Argon2id (const enum, not available at runtime)
  memoryCost: 19_456, // KiB = 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** Spends the same time as a real verification so responses do not reveal unknown emails. */
export async function verifyDummyPassword(password: string): Promise<void> {
  dummyHash ??= hashPassword('watchlog-dummy-password');
  await verifyPassword(await dummyHash, password);
}
