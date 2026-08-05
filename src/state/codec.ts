/**
 * Binary <-> text helpers shared by project export and share links.
 *
 * Both need the same thing: squeeze bytes down and make them safe to sit in
 * JSON or a URL.
 */

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  // Chunked so a large file does not blow the argument limit on apply().
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function hasCompression(): boolean {
  return typeof CompressionStream !== 'undefined'
    && typeof DecompressionStream !== 'undefined';
}

export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** `z` marks a deflated payload, `u` an uncompressed one. */
export async function pack(bytes: Uint8Array): Promise<string> {
  if (!hasCompression()) return `u${toBase64Url(bytes)}`;
  return `z${toBase64Url(await deflate(bytes))}`;
}

export async function unpack(payload: string): Promise<Uint8Array> {
  const body = fromBase64Url(payload.slice(1));
  return payload[0] === 'z' ? inflate(body) : body;
}
