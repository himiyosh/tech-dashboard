import { deflateSync } from "node:zlib";

import {
  SOCIAL_IMAGE_HEIGHT,
  SOCIAL_IMAGE_WIDTH,
} from "../../lib/social-metadata.ts";

export const prerender = true;

type Color = readonly [number, number, number, number];

const GLYPHS: Record<string, readonly string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function blendPixel(
  pixels: Uint8Array,
  x: number,
  y: number,
  color: Color,
): void {
  if (x < 0 || y < 0 || x >= SOCIAL_IMAGE_WIDTH || y >= SOCIAL_IMAGE_HEIGHT) return;
  const offset = (y * SOCIAL_IMAGE_WIDTH + x) * 4;
  const alpha = color[3] / 255;
  pixels[offset] = Math.round((pixels[offset] ?? 0) * (1 - alpha) + color[0] * alpha);
  pixels[offset + 1] = Math.round((pixels[offset + 1] ?? 0) * (1 - alpha) + color[1] * alpha);
  pixels[offset + 2] = Math.round((pixels[offset + 2] ?? 0) * (1 - alpha) + color[2] * alpha);
  pixels[offset + 3] = 255;
}

function fillRect(
  pixels: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
  color: Color,
): void {
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) blendPixel(pixels, px, py, color);
  }
}

function drawRing(
  pixels: Uint8Array,
  centerX: number,
  centerY: number,
  radius: number,
  thickness: number,
  color: Color,
): void {
  const outer = radius + thickness / 2;
  const inner = radius - thickness / 2;
  for (let y = Math.floor(centerY - outer); y <= Math.ceil(centerY + outer); y += 1) {
    for (let x = Math.floor(centerX - outer); x <= Math.ceil(centerX + outer); x += 1) {
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance >= inner && distance <= outer) blendPixel(pixels, x, y, color);
    }
  }
}

function drawLine(
  pixels: Uint8Array,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  thickness: number,
  color: Color,
): void {
  const steps = Math.max(Math.abs(endX - startX), Math.abs(endY - startY));
  for (let step = 0; step <= steps; step += 1) {
    const progress = steps === 0 ? 0 : step / steps;
    const x = Math.round(startX + (endX - startX) * progress);
    const y = Math.round(startY + (endY - startY) * progress);
    fillRect(
      pixels,
      x - Math.floor(thickness / 2),
      y - Math.floor(thickness / 2),
      thickness,
      thickness,
      color,
    );
  }
}

function drawText(
  pixels: Uint8Array,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: Color,
): void {
  let cursor = x;
  for (const character of text) {
    const glyph = GLYPHS[character] ?? GLYPHS[" "];
    glyph?.forEach((row, rowIndex) => {
      [...row].forEach((bit, columnIndex) => {
        if (bit === "1") {
          fillRect(
            pixels,
            cursor + columnIndex * scale,
            y + rowIndex * scale,
            scale,
            scale,
            color,
          );
        }
      });
    });
    cursor += scale * 6;
  }
}

export function generateSocialCardPng(): Uint8Array {
  const pixels = new Uint8Array(SOCIAL_IMAGE_WIDTH * SOCIAL_IMAGE_HEIGHT * 4);
  for (let y = 0; y < SOCIAL_IMAGE_HEIGHT; y += 1) {
    for (let x = 0; x < SOCIAL_IMAGE_WIDTH; x += 1) {
      const offset = (y * SOCIAL_IMAGE_WIDTH + x) * 4;
      const vertical = y / SOCIAL_IMAGE_HEIGHT;
      const horizontal = x / SOCIAL_IMAGE_WIDTH;
      pixels[offset] = Math.round(11 + vertical * 5 + horizontal * 2);
      pixels[offset + 1] = Math.round(31 + vertical * 27 + horizontal * 8);
      pixels[offset + 2] = Math.round(29 + vertical * 25 + horizontal * 7);
      pixels[offset + 3] = 255;
    }
  }

  const grid: Color = [94, 234, 212, 18];
  for (let x = 0; x < SOCIAL_IMAGE_WIDTH; x += 60) {
    fillRect(pixels, x, 0, 1, SOCIAL_IMAGE_HEIGHT, grid);
  }
  for (let y = 0; y < SOCIAL_IMAGE_HEIGHT; y += 60) {
    fillRect(pixels, 0, y, SOCIAL_IMAGE_WIDTH, 1, grid);
  }

  const teal: Color = [94, 234, 212, 255];
  const tealSoft: Color = [94, 234, 212, 76];
  const gold: Color = [251, 191, 36, 255];
  const white: Color = [245, 245, 244, 255];
  const muted: Color = [184, 178, 172, 255];
  const radarX = 955;
  const radarY = 315;

  fillRect(pixels, 78, 114, 8, 408, teal);
  drawText(pixels, "TECH", 116, 142, 18, teal);
  drawText(pixels, "DASHBOARD", 116, 304, 10, white);
  drawText(pixels, "PULSE OF THE AI ECOSYSTEM", 119, 448, 4, muted);

  drawRing(pixels, radarX, radarY, 82, 5, tealSoft);
  drawRing(pixels, radarX, radarY, 158, 5, tealSoft);
  drawRing(pixels, radarX, radarY, 234, 5, tealSoft);
  drawLine(pixels, radarX, radarY, 1_110, 125, 6, gold);
  drawRing(pixels, radarX, radarY, 20, 7, tealSoft);
  drawRing(pixels, radarX, radarY, 8, 12, teal);

  const raw = Buffer.alloc((SOCIAL_IMAGE_WIDTH * 4 + 1) * SOCIAL_IMAGE_HEIGHT);
  for (let y = 0; y < SOCIAL_IMAGE_HEIGHT; y += 1) {
    const rawOffset = y * (SOCIAL_IMAGE_WIDTH * 4 + 1);
    raw[rawOffset] = 0;
    raw.set(
      pixels.subarray(
        y * SOCIAL_IMAGE_WIDTH * 4,
        (y + 1) * SOCIAL_IMAGE_WIDTH * 4,
      ),
      rawOffset + 1,
    );
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(SOCIAL_IMAGE_WIDTH, 0);
  header.writeUInt32BE(SOCIAL_IMAGE_HEIGHT, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function GET(): Response {
  const png = generateSocialCardPng();
  const body = new ArrayBuffer(png.byteLength);
  new Uint8Array(body).set(png);
  return new Response(body, {
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
