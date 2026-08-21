#!/usr/bin/env node
/**
 * generate-icons.js
 * Generates all image assets from logo.png, bg.png, and fav.png
 *
 * Usage: node scripts/generate-icons.js
 *
 * Outputs:
 *   build-resources/icon.ico        - Windows icon (16/32/48/64/128/256)
 *   build-resources/sidebar.bmp     - NSIS installer sidebar
 *   build-resources/uninstaller.bmp - NSIS uninstaller sidebar
 *   src/renderer/assets/tray-32.png - System tray icon (32x32)
 *   src/renderer/assets/favicon-16.png - Browser favicon 16x16
 *   src/renderer/assets/favicon-32.png - Browser favicon 32x32
 *   src/renderer/assets/favicon-48.png - Browser favicon 48x48
 *   src/renderer/assets/push-64.png - Push notification icon (64x64)
 *   src/renderer/assets/push-128.png - Push notification icon (128x128)
 *   src/renderer/assets/logo-small.png - Logo for titlebar (24x24)
 *   src/renderer/assets/bg-render.png - Background for renderer
 */

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const LOGO_PATH = path.join(ROOT, 'logo.png');
const FAV_PATH = path.join(ROOT, 'fav.png');
const BG_PATH = path.join(ROOT, 'bg.png');
const BUILD_RES = path.join(ROOT, 'build-resources');
const ASSETS_DIR = path.join(ROOT, 'src', 'renderer', 'assets');

// ─── Resize (nearest-neighbor) ───
function resizeImage(png, targetWidth, targetHeight) {
  const dst = new PNG({ width: targetWidth, height: targetHeight });
  const srcW = png.width;
  const srcH = png.height;
  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const srcX = Math.min(Math.floor(x * srcW / targetWidth), srcW - 1);
      const srcY = Math.min(Math.floor(y * srcH / targetHeight), srcH - 1);
      const srcIdx = (srcY * srcW + srcX) << 2;
      const dstIdx = (y * targetWidth + x) << 2;
      dst.data[dstIdx] = png.data[srcIdx];
      dst.data[dstIdx + 1] = png.data[srcIdx + 1];
      dst.data[dstIdx + 2] = png.data[srcIdx + 2];
      dst.data[dstIdx + 3] = png.data[srcIdx + 3];
    }
  }
  return dst;
}

// ─── Center-crop to square ───
function centerCrop(png, size) {
  const srcW = png.width;
  const srcH = png.height;
  const dst = new PNG({ width: size, height: size });
  const cropSize = Math.min(srcW, srcH);
  const cropX = Math.floor((srcW - cropSize) / 2);
  const cropY = Math.floor((srcH - cropSize) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const srcX = Math.min(cropX + Math.floor(x * cropSize / size), srcW - 1);
      const srcY = Math.min(cropY + Math.floor(y * cropSize / size), srcH - 1);
      const srcIdx = (srcY * srcW + srcX) << 2;
      const dstIdx = (y * size + x) << 2;
      dst.data[dstIdx] = png.data[srcIdx];
      dst.data[dstIdx + 1] = png.data[srcIdx + 1];
      dst.data[dstIdx + 2] = png.data[srcIdx + 2];
      dst.data[dstIdx + 3] = png.data[srcIdx + 3];
    }
  }
  return dst;
}

// ─── Create ICO file ───
function createICO(png, sizes) {
  const images = sizes.map(size => {
    const cropped = centerCrop(png, size);
    return { size, data: Buffer.from(cropped.data) };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let dataOffset = 6 + 16 * images.length;
  const dirEntries = [];
  const imageData = [];
  for (const img of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(img.size > 255 ? 0 : img.size, 0);
    entry.writeUInt8(img.size > 255 ? 0 : img.size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    const p = new PNG({ width: img.size, height: img.size });
    p.data = Buffer.from(img.data);
    const pngBuf = PNG.sync.write(p);
    entry.writeUInt32LE(pngBuf.length, 8);
    entry.writeUInt32LE(dataOffset, 12);
    dirEntries.push(entry);
    imageData.push(pngBuf);
    dataOffset += pngBuf.length;
  }
  return Buffer.concat([header, ...dirEntries, ...imageData]);
}

// ─── Create BMP ───
function createBMP(width, height, rgbaData) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelDataSize = rowSize * height;
  const bmp = Buffer.alloc(54 + pixelDataSize);
  bmp.write('BM', 0);
  bmp.writeUInt32LE(54 + pixelDataSize, 2);
  bmp.writeUInt32LE(0, 6);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(0, 30);
  bmp.writeUInt32LE(pixelDataSize, 34);
  bmp.writeInt32LE(2835, 38);
  bmp.writeInt32LE(2835, 42);
  bmp.writeUInt32LE(0, 46);
  bmp.writeUInt32LE(0, 50);
  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const srcIdx = (srcY * width + x) << 2;
      const dstIdx = 54 + (y * rowSize) + (x * 3);
      bmp[dstIdx] = rgbaData[srcIdx + 2];
      bmp[dstIdx + 1] = rgbaData[srcIdx + 1];
      bmp[dstIdx + 2] = rgbaData[srcIdx];
    }
  }
  return bmp;
}

// ─── Create sidebar image ───
function createSidebarImage(logo, width, height) {
  const result = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    result[i * 4] = 0x1a; result[i * 4 + 1] = 0x1a; result[i * 4 + 2] = 0x2e; result[i * 4 + 3] = 255;
  }
  for (let y = 0; y < height; y++) {
    const factor = 1 - (y / height) * 0.3;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      result[idx] = Math.min(255, Math.round(result[idx] * factor + 20 * (1 - factor)));
      result[idx + 1] = Math.min(255, Math.round(result[idx + 1] * factor + 20 * (1 - factor)));
      result[idx + 2] = Math.min(255, Math.round(result[idx + 2] * factor + 40 * (1 - factor)));
    }
  }
  const logoMaxSize = Math.floor(Math.min(width * 0.75, height * 0.35));
  const logoCropped = centerCrop(logo, logoMaxSize);
  const logoX = Math.floor((width - logoMaxSize) / 2);
  const logoY = Math.floor(height * 0.12);
  for (let y = 0; y < logoMaxSize && (logoY + y) < height; y++) {
    for (let x = 0; x < logoMaxSize && (logoX + x) < width; x++) {
      const srcIdx = (y * logoMaxSize + x) << 2;
      const dstX = logoX + x, dstY = logoY + y;
      const dstIdx = (dstY * width + dstX) << 2;
      const alpha = logoCropped.data[srcIdx + 3] / 255;
      if (alpha > 0.1) {
        result[dstIdx] = Math.round(result[dstIdx] * (1 - alpha) + logoCropped.data[srcIdx] * alpha);
        result[dstIdx + 1] = Math.round(result[dstIdx + 1] * (1 - alpha) + logoCropped.data[srcIdx + 1] * alpha);
        result[dstIdx + 2] = Math.round(result[dstIdx + 2] * (1 - alpha) + logoCropped.data[srcIdx + 2] * alpha);
      }
    }
  }
  const textY = logoY + logoMaxSize + 15;
  const textHeight = 40;
  for (let y = textY; y < Math.min(textY + textHeight, height); y++) {
    for (let x = 10; x < width - 10; x++) {
      const idx = (y * width + x) * 4;
      result[idx] = Math.round(result[idx] * 0.3 + 0x0f * 0.7);
      result[idx + 1] = Math.round(result[idx + 1] * 0.3 + 0x0f * 0.7);
      result[idx + 2] = Math.round(result[idx + 2] * 0.3 + 0x1a * 0.7);
    }
  }
  const lineY = textY + textHeight + 5;
  for (let x = 20; x < width - 20; x++) {
    for (let dy = 0; dy < 2; dy++) {
      if (lineY + dy < height) {
        const idx = ((lineY + dy) * width + x) * 4;
        result[idx] = 0x6c; result[idx + 1] = 0x5c; result[idx + 2] = 0xe7; result[idx + 3] = 200;
      }
    }
  }
  return result;
}

// ─── Main ───
function main() {
  console.log('\n  CronMaster - Asset Generator\n');

  // Ensure directories
  [BUILD_RES, ASSETS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  // Read source images
  if (!fs.existsSync(LOGO_PATH)) { console.error('  [ERROR] logo.png not found'); process.exit(1); }
  const logo = PNG.sync.read(fs.readFileSync(LOGO_PATH));
  console.log(`  logo.png: ${logo.width}x${logo.height}`);

  let bg = null;
  if (fs.existsSync(BG_PATH)) {
    bg = PNG.sync.read(fs.readFileSync(BG_PATH));
    console.log(`  bg.png:   ${bg.width}x${bg.height}`);
  } else {
    console.log('  bg.png: not found, skipping');
  }

  // Use bg.png for ALL assets (icons, favicon, tray, etc.)
  const fav = bg || logo;
  console.log(`  Using bg.png for all assets: ${fav.width}x${fav.height}`);

  // ── 1. ICO (from bg.png) ──
  console.log('\n  [1/8] icon.ico (from bg.png)');
  const ico = createICO(bg || logo, [16, 32, 48, 64, 128, 256]);
  fs.writeFileSync(path.join(BUILD_RES, 'icon.ico'), ico);
  console.log(`        ${ico.length} bytes`);

  // ── 2. Sidebar BMP ──
  console.log('  [2/8] sidebar.bmp (from bg.png)');
  const sidebarRGBA = createSidebarImage(bg || logo, 164, 314);
  const sidebarBMP = createBMP(164, 314, sidebarRGBA);
  fs.writeFileSync(path.join(BUILD_RES, 'sidebar.bmp'), sidebarBMP);
  fs.writeFileSync(path.join(BUILD_RES, 'uninstaller.bmp'), sidebarBMP);
  console.log(`        ${sidebarBMP.length} bytes`);

  // ── 3. Tray icon (32x32) from bg.png ──
  console.log('  [3/8] tray-32.png (from bg.png)');
  const trayCropped = centerCrop(bg || logo, 32);
  const trayBuf = PNG.sync.write(trayCropped);
  fs.writeFileSync(path.join(ASSETS_DIR, 'tray-32.png'), trayBuf);
  console.log(`        ${trayBuf.length} bytes`);

  // ── 4. Favicon sizes ──
  console.log('  [4/8] favicon-*.png');
  const favSrc = fav;
  for (const size of [16, 32, 48]) {
    const resized = resizeImage(centerCrop(favSrc, size), size, size);
    const buf = PNG.sync.write(resized);
    fs.writeFileSync(path.join(ASSETS_DIR, `favicon-${size}.png`), buf);
    console.log(`        favicon-${size}.png: ${buf.length} bytes`);
  }

  // ── 5. Push notification icons from bg.png ──
  console.log('  [5/8] push-*.png (from bg.png)');
  for (const size of [64, 128, 256]) {
    const cropped = centerCrop(bg || logo, size);
    const buf = PNG.sync.write(cropped);
    fs.writeFileSync(path.join(ASSETS_DIR, `push-${size}.png`), buf);
    console.log(`        push-${size}.png: ${buf.length} bytes`);
  }

  // ── 6. Titlebar logo (24x24) from bg.png ──
  console.log('  [6/8] logo-24.png (from bg.png)');
  const logo24 = resizeImage(centerCrop(bg || logo, 24), 24, 24);
  const logo24Buf = PNG.sync.write(logo24);
  fs.writeFileSync(path.join(ASSETS_DIR, 'logo-24.png'), logo24Buf);
  console.log(`        ${logo24Buf.length} bytes`);

  // ── 7. Save source image as fav.png in assets ──
  console.log('  [7/8] fav.png (from source)');
  const favBuf = PNG.sync.write(fav);
  fs.writeFileSync(path.join(ASSETS_DIR, 'fav.png'), favBuf);
  console.log(`        ${favBuf.length} bytes`);

  // ── 8. Copy/process bg.png ──
  if (bg) {
    console.log('  [8/8] bg-render.png');
    // Optionally resize background to a reasonable size (1920px wide max)
    const maxW = 1920;
    if (bg.width > maxW) {
      const scale = maxW / bg.width;
      const newH = Math.round(bg.height * scale);
      const resized = resizeImage(bg, maxW, newH);
      const buf = PNG.sync.write(resized);
      fs.writeFileSync(path.join(ASSETS_DIR, 'bg-render.png'), buf);
      console.log(`        ${buf.length} bytes (${maxW}x${newH})`);
    } else {
      fs.copyFileSync(BG_PATH, path.join(ASSETS_DIR, 'bg-render.png'));
      console.log('        copied (original size)');
    }
  } else {
    console.log('  [8/8] bg-render.png (skipped)');
  }

  console.log('\n  Done! All assets generated.\n');
}

main();
