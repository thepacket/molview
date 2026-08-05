/**
 * Projects in a link.
 *
 * The serialiser already produces a complete session; this compresses that
 * document into the URL fragment. A fragment never reaches a server, so a
 * shared link discloses nothing to anyone but the recipient — which is the
 * whole reason this app can do it and a desktop tool cannot.
 */

import { parseProject, serialiseProject, type ProjectDocument } from './project';

const HASH_KEY = 'p';
/** Beyond this, some chat clients and mail gateways start truncating. */
export const COMFORTABLE_URL_LENGTH = 8000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hasCompression(): boolean {
  return typeof CompressionStream !== 'undefined'
    && typeof DecompressionStream !== 'undefined';
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * `z` marks a deflated payload; `u` an uncompressed one, for the rare browser
 * without the Compression Streams API.
 */
export async function encodeProject(doc: ProjectDocument): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  if (!hasCompression()) return `u${toBase64Url(json)}`;
  return `z${toBase64Url(await deflate(json))}`;
}

export async function decodeProject(payload: string): Promise<ProjectDocument> {
  const kind = payload[0];
  const body = fromBase64Url(payload.slice(1));
  const json = kind === 'z' ? await inflate(body) : body;
  return parseProject(new TextDecoder().decode(json));
}

export interface ShareLink {
  url: string;
  /** Compressed payload size relative to the raw document. */
  bytes: number;
  rawBytes: number;
  tooLong: boolean;
}

export async function buildShareLink(): Promise<ShareLink> {
  const doc = serialiseProject();
  const raw = JSON.stringify(doc);
  const payload = await encodeProject(doc);
  const url = `${location.origin}${location.pathname}#${HASH_KEY}=${payload}`;
  return {
    url,
    bytes: payload.length,
    rawBytes: raw.length,
    tooLong: url.length > COMFORTABLE_URL_LENGTH,
  };
}

/** Reads a project out of the current URL fragment, if there is one. */
export function projectPayloadFromLocation(): string | null {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return null;
  for (const part of hash.split('&')) {
    const [key, value] = part.split('=');
    if (key === HASH_KEY && value) return value;
  }
  return null;
}

/**
 * Drops the fragment once its project is live. Leaving it would claim the URL
 * still describes the session after the first edit, which it would not.
 */
export function clearProjectPayload(): void {
  history.replaceState(null, '', location.pathname + location.search);
}
