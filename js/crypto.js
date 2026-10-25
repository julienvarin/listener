// Mirrors scripts/build_data.py: "LSN1" | uint32 iterations | salt(16) | iv(12) | AES-GCM(gzip(json))

const KEY_STORE = 'listener.key';

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function parseBundle(buffer) {
  const bytes = new Uint8Array(buffer);
  if (new TextDecoder().decode(bytes.slice(0, 4)) !== 'LSN1') throw new Error('Unknown bundle format');
  return {
    iterations: new DataView(buffer).getUint32(4),
    salt: bytes.slice(8, 24),
    iv: bytes.slice(24, 36),
    ct: bytes.slice(36),
  };
}

export async function deriveKey(password, bundle) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: bundle.salt, iterations: bundle.iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    true,
    ['decrypt'],
  );
}

export async function openBundle(bundle, key) {
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bundle.iv }, key, bundle.ct);
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

export async function rememberKey(key, bundle) {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  try {
    localStorage.setItem(KEY_STORE, JSON.stringify({ salt: b64(bundle.salt), key: b64(raw) }));
  } catch {}
}

export async function recallKey(bundle) {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY_STORE) || 'null');
    if (!saved || saved.salt !== b64(bundle.salt)) return null;
    return await crypto.subtle.importKey('raw', unb64(saved.key), 'AES-GCM', false, ['decrypt']);
  } catch {
    return null;
  }
}

export function forgetKey() {
  try { localStorage.removeItem(KEY_STORE); } catch {}
}
