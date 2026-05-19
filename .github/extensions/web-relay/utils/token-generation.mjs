import { randomBytes } from "crypto";

const TOKEN_FALLBACK_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function randomInt(maxExclusive) {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new Error("randomInt maxExclusive must be a positive integer");
  }
  const threshold = Math.floor(256 / maxExclusive) * maxExclusive;
  while (true) {
    const value = randomBytes(1)[0];
    if (value < threshold) return value % maxExclusive;
  }
}

function generateRandomToken(length, alphabet) {
  if (!Number.isInteger(length) || length <= 0 || length > alphabet.length) {
    throw new Error("Token length must be a positive integer up to alphabet size");
  }
  const pool = alphabet.split("");
  let token = "";
  for (let i = 0; i < length; i += 1) {
    const idx = randomInt(pool.length);
    token += pool[idx];
    pool.splice(idx, 1);
  }
  return token;
}

function normalizedEntropy(value) {
  const token = String(value || "");
  if (!token.length) return 0;
  const counts = new Map();
  for (const ch of token) {
    counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  const unique = counts.size;
  if (unique <= 1) return 0;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / token.length;
    entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(unique);
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

export function generateHighEntropyToken({
  length = 16,
  minEntropy = 0.95,
  alphabet = TOKEN_FALLBACK_ALPHABET,
} = {}) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const token = generateRandomToken(length, alphabet);
    if (normalizedEntropy(token) >= minEntropy) return token;
  }
  throw new Error(`Could not generate fallback token with normalized entropy >= ${minEntropy}`);
}
