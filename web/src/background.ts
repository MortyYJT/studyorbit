import { migrateBackgroundImage, NEW_IMAGE_DB } from './storage-prefix.js';
/** Page background preferences. The settings live in localStorage; an uploaded image lives only in IndexedDB. */
export const backgroundModes = ['gradient', 'solid', 'image'] as const;
export type BackgroundMode = (typeof backgroundModes)[number];
export type BackgroundSettings = {
  mode: BackgroundMode;
  /** How much of the image shows through the ground-coloured scrim, 0–100 (%). */
  visibility: number;
  /** Gaussian blur on the image, 0–24 (px). */
  blur: number;
  /** Opacity of cards, panels, the sidebar and dialogs in image mode, 70–100 (%). Text never sits on less than 70%. */
  cardOpacity: number;
};

export const backgroundStorageKey = 'studyorbit.background';
export const defaultBackground: BackgroundSettings = { mode: 'gradient', visibility: 70, blur: 0, cardOpacity: 94 };
export const backgroundLimits = { visibility: [0, 100], blur: [0, 24], cardOpacity: [70, 100] } as const;
/** Raw upload limit before the image is downscaled and re-encoded in the browser. */
export const maxBackgroundBytes = 15 * 1024 * 1024;
const backgroundTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** Longest edge kept after downscaling. */
const maxBackgroundEdge = 2560;

function clamp(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

/** Reads stored settings; unknown fields are ignored, out-of-range numbers are clamped, anything malformed falls back. */
export function parseBackground(raw: string | null | undefined): BackgroundSettings {
  let value: unknown;
  try { value = raw ? JSON.parse(raw) : undefined; } catch { value = undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaultBackground };
  const stored = value as Record<string, unknown>;
  return {
    mode: backgroundModes.find(mode => mode === stored.mode) ?? defaultBackground.mode,
    visibility: clamp(stored.visibility, backgroundLimits.visibility, defaultBackground.visibility),
    blur: clamp(stored.blur, backgroundLimits.blur, defaultBackground.blur),
    cardOpacity: clamp(stored.cardOpacity, backgroundLimits.cardOpacity, defaultBackground.cardOpacity),
  };
}

/** Why an upload is refused before it is decoded, or null when it may be processed. */
export function backgroundFileProblem(file: { type: string; size: number }): 'type' | 'size' | null {
  if (!(backgroundTypes as readonly string[]).includes(file.type)) return 'type';
  if (file.size > maxBackgroundBytes) return 'size';
  return null;
}

/** Output size that keeps the aspect ratio and fits the longest edge within `maxBackgroundEdge`. */
export function fitWithin(width: number, height: number, edge = maxBackgroundEdge): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Card opacity applies only over an image; gradient and solid backgrounds keep fully opaque surfaces. */
export function surfaceAlpha(settings: BackgroundSettings): number {
  return settings.mode === 'image' ? settings.cardOpacity : 100;
}

// ---- Browser-only helpers (IndexedDB and canvas). Not called at import, so the parser stays testable in Node. ----

const storeName = 'background', imageKey = 'image';

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(name: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb(name);
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const request = run(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

const readImage = async (name: string) => { const value = await withStore<unknown>(name, 'readonly', store => store.get(imageKey)); return value instanceof Blob ? value : undefined; };
let imageMigration: Promise<unknown> | undefined;
/** Moves an image saved under the former database name once per page load before any read or write (storage-prefix.ts). */
function migrated(): Promise<unknown> {
  imageMigration ??= migrateBackgroundImage({
    read: readImage,
    write: async (name, blob) => { await withStore(name, 'readwrite', store => store.put(blob, imageKey)); },
    remove: name => new Promise<void>(resolve => { const request = indexedDB.deleteDatabase(name); request.onsuccess = request.onerror = request.onblocked = () => resolve(); }),
  }).catch(() => 'failed');
  return imageMigration;
}

export async function loadBackgroundImage(): Promise<Blob | undefined> { await migrated(); return readImage(NEW_IMAGE_DB); }
export async function saveBackgroundImage(blob: Blob): Promise<void> { await migrated(); await withStore(NEW_IMAGE_DB, 'readwrite', store => store.put(blob, imageKey)); }
export async function removeBackgroundImage(): Promise<void> { await migrated(); await withStore(NEW_IMAGE_DB, 'readwrite', store => store.delete(imageKey)); }

/** Decodes, downscales and re-encodes an upload as WebP (JPEG where WebP encoding is unavailable). */
export async function prepareBackgroundImage(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const size = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const encode = (type: string) => new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, 0.85));
    const webp = await encode('image/webp');
    if (webp && webp.type === 'image/webp') return webp;
    const jpeg = await encode('image/jpeg');
    if (!jpeg) throw new Error('encode');
    return jpeg;
  } finally { bitmap.close(); }
}
