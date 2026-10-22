import { contentTypeFor, storage } from "@/lib/storage/storage";

/** Serves photos for the local storage driver (development). S3/R2 photos come from their public URL. */
export async function GET(_request: Request, ctx: RouteContext<"/api/files/[...key]">) {
  const { key } = await ctx.params;
  const path = key.join("/");
  if (!path.startsWith("listings/")) return new Response("Not found", { status: 404 });
  let bytes: Uint8Array | null;
  try {
    bytes = await storage().get(path);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!bytes) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: { "Content-Type": contentTypeFor(path), "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
