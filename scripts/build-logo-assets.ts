import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const source = process.argv[2];
if (!source) {
  console.error("Usage: npm run logo:build -- <path to the logo image>");
  process.exit(1);
}

/** Lightest channel at or above the floor counts as background, fading to fully clear at the ceiling (JPEG white is ~252, not 255). */
const BACKGROUND_FLOOR = 200;
const BACKGROUND_CEILING = 245;

/**
 * The badge sits on a white field and its banner sticks out past the round frame, so a circular
 * mask would clip it. Instead, flood-fill the light background inward from the image border and
 * make it transparent, fading partially-light edge pixels to keep the antialiasing.
 */
async function badge(size: number): Promise<Buffer> {
  const { data, info } = await sharp(await readFile(source))
    .trim({ background: "#ffffff", threshold: 20 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const lightness = (p: number) => Math.min(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  for (let x = 0; x < width; x++) stack.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y++) stack.push(y * width, y * width + width - 1);
  while (stack.length) {
    const p = stack.pop()!;
    if (seen[p] || lightness(p) < BACKGROUND_FLOOR) continue;
    seen[p] = 1;
    data[p * 4 + 3] = Math.round((Math.max(0, BACKGROUND_CEILING - lightness(p)) / (BACKGROUND_CEILING - BACKGROUND_FLOOR)) * 255);
    const x = p % width;
    if (x > 0) stack.push(p - 1);
    if (x < width - 1) stack.push(p + 1);
    if (p >= width) stack.push(p - width);
    if (p < width * (height - 1)) stack.push(p + width);
  }
  return sharp(data, { raw: { width, height, channels: 4 } })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** ICO with embedded PNG images (supported by every current browser). */
function ico(pngs: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

async function main() {
  const full = await badge(1024);
  await writeFile("public/logo.png", full);
  await writeFile("public/logo.webp", await sharp(full).resize(640).webp({ quality: 78, alphaQuality: 80, effort: 6 }).toBuffer());

  await writeFile("src/app/icon.png", await sharp(full).resize(192).png({ compressionLevel: 9 }).toBuffer());
  // iOS fills transparency with black, so the touch icon gets the site's paper background.
  await writeFile(
    "src/app/apple-icon.png",
    await sharp({ create: { width: 180, height: 180, channels: 4, background: "#faf7f2" } })
      .composite([{ input: await sharp(full).resize(164).png().toBuffer(), gravity: "center" }])
      .png({ compressionLevel: 9 })
      .toBuffer(),
  );
  const sizes = [16, 32, 48];
  await writeFile(
    "src/app/favicon.ico",
    ico(await Promise.all(sizes.map(async (size) => ({ size, data: await sharp(full).resize(size).png().toBuffer() })))),
  );
  console.info("Wrote public/logo.png, public/logo.webp, src/app/icon.png, src/app/apple-icon.png, src/app/favicon.ico");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
