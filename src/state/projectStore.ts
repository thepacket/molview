/**
 * Browser-local project storage.
 *
 * IndexedDB rather than localStorage: the latter is synchronous, capped near
 * 5 MB, and stores strings only. Saving here never touches the file system —
 * that is what export is for.
 *
 * Small enough that a wrapper library would be more code than the API.
 */

import type { ProjectDocument } from './project';

const DATABASE = 'molview';
const VERSION = 1;
const STORE = 'projects';

export interface StoredProject {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  document: ProjectDocument;
}

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  entryIds: string[];
  paneCount: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('This browser has no IndexedDB, so projects cannot be saved'));
      return;
    }
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the project store'));
  });
  return dbPromise;
}

function run<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Project store request failed'));
  }));
}

function summarise(project: StoredProject): ProjectSummary {
  const panes = project.document?.panes ?? [];
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    entryIds: panes.map((p) => p.entryId).filter(Boolean) as string[],
    paneCount: panes.length,
  };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const all = await run<StoredProject[]>('readonly', (store) => store.getAll());
  return all
    .map(summarise)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadProject(id: string): Promise<StoredProject | undefined> {
  return run<StoredProject | undefined>('readonly', (store) => store.get(id));
}

export async function saveProject(
  name: string, document: ProjectDocument, id?: string,
): Promise<StoredProject> {
  const now = new Date().toISOString();
  const existing = id ? await loadProject(id) : undefined;

  const project: StoredProject = {
    id: existing?.id ?? id ?? crypto.randomUUID(),
    name: name.trim() || 'Untitled project',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    document,
  };

  await run('readwrite', (store) => store.put(project));
  return project;
}

export async function deleteProject(id: string): Promise<void> {
  await run('readwrite', (store) => store.delete(id));
}
