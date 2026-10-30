import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const source = process.argv[2];
if (!source) {
  console.error("Usage: npm run logo:build -- <path to the logo image>");
  process.exit(1);
}

/** The badge sits on a white field; trim it and mask to a circle so the corners are transparent. */
async function badge(size: number): Promise<Buffer> {
  const trimmed = await sharp(await readFile(source))
    .trim({ background: "#ffffff", threshold: 20 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const mask = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`);
  return sharp(trimmed).ensureAlpha().composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
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
  await writeFile("public/logo.webp", await sharp(full).resize(640).webp({ quality: 80 }).toBuffer());

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
