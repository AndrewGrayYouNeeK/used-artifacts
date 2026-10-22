import { randomUUID } from "node:crypto";
import sharp from "sharp";

export interface ObjectStorage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Only the local driver can read back; S3/R2 objects are served from their public URL. */
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): string;
}

export const MAX_PHOTOS = 8;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_EDGE = 2000;
const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp", "heif", "avif"]);

export interface PreparedPhoto {
  storageKey: string;
  /** The stored WebP, kept in memory for the photo analyzer. */
  bytes: Uint8Array;
  pHash: string;
  width: number;
  height: number;
}

export type PhotoError = "TOO_LARGE" | "NOT_AN_IMAGE";

/**
 * 64-bit difference hash of the image: robust to resizing and re-encoding, so
 * a re-uploaded photo of the same item matches (self-reselling checks).
 */
export async function differenceHash(bytes: Uint8Array): Promise<string> {
  const pixels = await sharp(bytes).rotate().grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (pixels[y * 9 + x] > pixels[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

export function hammingDistance(a: string, b: string): number {
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

/**
 * Re-encodes an upload as WebP: applies EXIF orientation, drops all metadata
 * (GPS locations of find sites must never leak), and caps the size.
 */
export async function processPhoto(
  bytes: Uint8Array,
): Promise<{ ok: true; webp: Uint8Array; width: number; height: number; pHash: string } | { ok: false; reason: PhotoError }> {
  if (bytes.byteLength > MAX_PHOTO_BYTES) return { ok: false, reason: "TOO_LARGE" };
  let format: string | undefined;
  try {
    format = (await sharp(bytes).metadata()).format;
  } catch {
    return { ok: false, reason: "NOT_AN_IMAGE" };
  }
  if (!format || !ACCEPTED_FORMATS.has(format)) return { ok: false, reason: "NOT_AN_IMAGE" };
  const { data, info } = await sharp(bytes)
    .rotate()
    .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  return { ok: true, webp: new Uint8Array(data), width: info.width, height: info.height, pHash: await differenceHash(data) };
}

export async function storePhotos(
  storage: ObjectStorage,
  files: Uint8Array[],
): Promise<{ ok: true; photos: PreparedPhoto[] } | { ok: false; reason: PhotoError | "TOO_MANY"; index: number }> {
  if (files.length > MAX_PHOTOS) return { ok: false, reason: "TOO_MANY", index: MAX_PHOTOS };
  const processed = [];
  for (const [index, file] of files.entries()) {
    const result = await processPhoto(file);
    if (!result.ok) return { ok: false, reason: result.reason, index };
    processed.push(result);
  }
  const photos: PreparedPhoto[] = [];
  for (const p of processed) {
    const storageKey = `listings/${randomUUID()}.webp`;
    await storage.put(storageKey, p.webp);
    photos.push({ storageKey, bytes: p.webp, pHash: p.pHash, width: p.width, height: p.height });
  }
  return { ok: true, photos };
}
