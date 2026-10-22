import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { differenceHash, hammingDistance, processPhoto } from "./photos";

async function gradient(width: number, height: number, invert = false) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round(((x + y) / (width + height)) * 255);
      pixels.fill(invert ? 255 - v : v, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } });
}

describe("photo processing", () => {
  it("strips EXIF/GPS metadata and re-encodes as WebP", async () => {
    const jpeg = await (await gradient(400, 300))
      .withExif({ IFD0: { Make: "TestCam" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "38/1 15/1 0/1" } })
      .jpeg()
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const result = await processPhoto(jpeg);
    if (!result.ok) throw new Error(result.reason);
    const meta = await sharp(result.webp).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
    expect(result.width).toBe(400);
  });

  it("caps the longest edge", async () => {
    const big = await (await gradient(3000, 1000)).png().toBuffer();
    const result = await processPhoto(big);
    if (!result.ok) throw new Error(result.reason);
    expect(result.width).toBe(2000);
  });

  it("rejects non-images", async () => {
    expect(await processPhoto(new TextEncoder().encode("not an image"))).toEqual({ ok: false, reason: "NOT_AN_IMAGE" });
  });

  it("gives resized copies near-identical hashes and different images distant ones", async () => {
    const a = await differenceHash(await (await gradient(400, 300)).png().toBuffer());
    const aSmall = await differenceHash(await (await gradient(400, 300)).resize(120, 90).jpeg({ quality: 60 }).toBuffer());
    const b = await differenceHash(await (await gradient(400, 300, true)).png().toBuffer());
    expect(hammingDistance(a, aSmall)).toBeLessThanOrEqual(6);
    expect(hammingDistance(a, b)).toBeGreaterThan(20);
  });
});
