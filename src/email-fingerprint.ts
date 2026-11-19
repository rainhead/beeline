import { createHmac } from "node:crypto";

/**
 * A keyed fingerprint of an email address (beeline-w8ab.7).
 *
 * Beeline never writes an email address to disk (docs/architecture/ideal-logic.md),
 * yet it must tell whether the address iNaturalist reports for a person who
 * signs in is the one a registration in Ideal Logic holds. The nightly job
 * stores a fingerprint of each registration's address, and sign-in compares
 * the signed-in person's against them. The fingerprint is an HMAC under a
 * secret kept in the environment, so it cannot be turned back into an
 * address without that secret, and a person holding only the store cannot
 * test a guessed address against it.
 */

/** The shortest key accepted, in bytes after decoding. */
export const MIN_EMAIL_KEY_BYTES = 32;

/**
 * Read `REGISTRATION_EMAIL_KEY`: base64, at least 32 bytes once decoded.
 * Null for an unset or blank value, which turns the feature off. The message
 * of the error says what is wrong with the key and never quotes it.
 */
export function parseEmailKey(value: string | undefined): Buffer | null {
  const text = value?.trim();
  if (!text) return null;
  const key = Buffer.from(text, "base64");
  if (key.length < MIN_EMAIL_KEY_BYTES) {
    throw new Error(
      `REGISTRATION_EMAIL_KEY must be base64 that decodes to at least ${MIN_EMAIL_KEY_BYTES} bytes (generate one with: openssl rand -base64 48)`,
    );
  }
  return key;
}

/** HMAC-SHA256 of the address trimmed and lower-cased, as hex. */
export function fingerprintEmail(key: Buffer, email: string): string {
  return createHmac("sha256", key).update(email.trim().toLowerCase()).digest("hex");
}
