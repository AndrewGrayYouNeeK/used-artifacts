import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { storageEnv } from "@/config/env";
import type { ObjectStorage } from "@/domains/listings/photos";

const KEY_PATTERN = /^[a-z0-9][a-z0-9/_-]*\.(webp|jpg|png|pdf)$/;

export function assertSafeKey(key: string) {
  if (!KEY_PATTERN.test(key) || key.includes("..")) throw new Error(`Unsafe storage key: ${key}`);
}

const CONTENT_TYPES: Record<string, string> = {
  webp: "image/webp",
  jpg: "image/jpeg",
  png: "image/png",
  pdf: "application/pdf",
};

export function contentTypeFor(key: string): string {
  return CONTENT_TYPES[key.split(".").pop() ?? ""] ?? "application/octet-stream";
}

/** Development only: files under LOCAL_STORAGE_DIR, served by /api/files/[...key]. */
class LocalDiskStorage implements ObjectStorage {
  constructor(private readonly root: string) {}

  private file(key: string) {
    assertSafeKey(key);
    return path.join(this.root, key);
  }

  async put(key: string, bytes: Uint8Array) {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.file(key));
    } catch {
      return null;
    }
  }

  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }

  publicUrl(key: string) {
    return `/api/files/${key}`;
  }
}

/** S3 or Cloudflare R2. Photos are served from STORAGE_PUBLIC_BASE_URL (a public bucket or CDN). */
class S3Storage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    private readonly publicBase: string,
    config: { region: string; endpoint?: string; accessKeyId: string; secretAccessKey: string },
  ) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async put(key: string, bytes: Uint8Array) {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentTypeFor(key),
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
  }

  async get(): Promise<Uint8Array | null> {
    return null;
  }

  async delete(key: string) {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  publicUrl(key: string) {
    return `${this.publicBase.replace(/\/$/, "")}/${key}`;
  }
}

const globalForStorage = globalThis as unknown as { storage?: ObjectStorage };

export function storage(): ObjectStorage {
  if (globalForStorage.storage) return globalForStorage.storage;
  const env = storageEnv();
  const driver = env.STORAGE_DRIVER;
  switch (driver) {
    case "local":
      globalForStorage.storage = new LocalDiskStorage(path.resolve(env.LOCAL_STORAGE_DIR));
      break;
    case "s3":
      globalForStorage.storage = new S3Storage(env.S3_BUCKET!, env.STORAGE_PUBLIC_BASE_URL!, {
        region: env.S3_REGION,
        endpoint: env.S3_ENDPOINT,
        accessKeyId: env.S3_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      });
      break;
    default: {
      const exhaustive: never = driver;
      throw new Error(`Unknown storage driver: ${String(exhaustive)}`);
    }
  }
  return globalForStorage.storage;
}

export function photoUrl(key: string): string {
  return storage().publicUrl(key);
}
