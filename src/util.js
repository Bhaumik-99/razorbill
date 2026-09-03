import crypto from 'node:crypto';

/** Deterministic PRNG (mulberry32) so every demo run is reproducible. */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

/** Stable key order -> same JSON bytes for the same object. Hashes depend on this. */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (secret, s) => crypto.createHmac('sha256', secret).update(s).digest('hex');
export const id = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

/** Money is always integer paise. Never floats. */
export const inr = (paise) =>
  '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const nowISO = () => new Date().toISOString();

/** Constant-time string compare for signature checks. */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
