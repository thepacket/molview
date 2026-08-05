/**
 * Projects in a link.
 *
 * The serialiser already produces a complete session; this compresses that
 * document into the URL fragment. A fragment never reaches a server, so a
 * shared link discloses nothing to anyone but the recipient — which is the
 * whole reason this app can do it and a desktop tool cannot.
 */

import { pack, unpack } from './codec';
import { parseProject, serialiseProject, type ProjectDocument } from './project';

const HASH_KEY = 'p';
/** Beyond this, some chat clients and mail gateways start truncating. */
export const COMFORTABLE_URL_LENGTH = 8000;

export async function encodeProject(doc: ProjectDocument): Promise<string> {
  return pack(new TextEncoder().encode(JSON.stringify(doc)));
}

export async function decodeProject(payload: string): Promise<ProjectDocument> {
  return parseProject(new TextDecoder().decode(await unpack(payload)));
}

export interface ShareLink {
  url: string;
  /** Compressed payload size relative to the raw document. */
  bytes: number;
  rawBytes: number;
  tooLong: boolean;
}

export async function buildShareLink(): Promise<ShareLink> {
  // Never embed local-file coordinates in a link: megabytes of base64 would
  // not survive being pasted anywhere.
  const doc = serialiseProject({ includeCoordinates: false });
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
