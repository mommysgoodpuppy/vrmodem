// Downlink test frames: data as gray blocks, decoded in the world from the
// video player's texture. Shared by gen_downlink.ts, the offline check, and
// (by hand) unity/Downlink.shader, which must agree with it bit for bit.
//
// A frame is W x H luma. The top HEADER rows are 16 x 16 cells:
//   cell 0 white, cell 1 black       sync: tells the decoder which way is up
//   cells 2 .. 2+L-1                 calibration: gray level 0 .. L-1
//   cells 10 .. 33                   frame number, 24 bits, MSB first, white = 1
// Below it, blocks of B x B pixels, row-major from the top left, each one of
// L gray levels: symbol(frame, index) below.

export const HEADER = 16;
export const CELL = 16;
export const FRAME_BITS = 24;
export const FRAME_CELL = 10;
export const BLACK = 16;
export const WHITE = 235;

export type Layout = { w: number; h: number; block: number; levels: number; seed: number };

export function blocks(l: Layout) {
  const cols = Math.floor(l.w / l.block);
  const rows = Math.floor((l.h - HEADER) / l.block);
  return { cols, rows, count: cols * rows, bits: cols * rows * Math.log2(l.levels) };
}

export function level(l: Layout, i: number): number {
  return Math.round(BLACK + i * (WHITE - BLACK) / (l.levels - 1));
}

// lowbias32: a 32-bit integer hash with good mixing (HLSL: the same with uint).
export function hash(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

export function symbol(l: Layout, frame: number, index: number): number {
  return hash((hash((frame ^ Math.imul(l.seed, 0x9e3779b9)) >>> 0) + index) >>> 0) % l.levels;
}

// sym: each block's symbol; the test pattern by default, data for the modem.
export function render(l: Layout, frame: number, out = new Uint8Array(l.w * l.h), sym = (i: number) => symbol(l, frame, i)): Uint8Array {
  out.fill(BLACK);
  const cell = (c: number, v: number) => {
    for (let y = 0; y < HEADER; y++) out.fill(v, y * l.w + c * CELL, y * l.w + (c + 1) * CELL);
  };
  cell(0, WHITE);
  cell(1, BLACK);
  for (let i = 0; i < l.levels; i++) cell(2 + i, level(l, i));
  for (let b = 0; b < FRAME_BITS; b++) cell(FRAME_CELL + b, (frame >>> (FRAME_BITS - 1 - b)) & 1 ? WHITE : BLACK);
  const { cols, rows } = blocks(l);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = level(l, sym(r * cols + c));
      for (let y = 0; y < l.block; y++) {
        const at = (HEADER + r * l.block + y) * l.w + c * l.block;
        out.fill(v, at, at + l.block);
      }
    }
  }
  return out;
}

// Decodes an upright luma frame as the shader does (which also uses the sync to
// tell which way is up): each block's centre against the nearest calibration level.
export function decode(l: Layout, y: Uint8Array): { frame: number; errors: number } | null {
  const d = decodeSymbols(l, y);
  if (!d) return null;
  let errors = 0;
  d.symbols.forEach((s, i) => { if (s !== symbol(l, d.frame, i)) errors++; });
  return { frame: d.frame, errors };
}

// The frame number and every block's symbol.
export function decodeSymbols(l: Layout, y: Uint8Array): { frame: number; symbols: Uint8Array } | null {
  const at = (px: number, py: number) => {
    // The centre 2 x 2 of an even block, as bilinear sampling at its centre.
    const x0 = Math.floor(px - 0.5), y0 = Math.floor(py - 0.5);
    return (y[y0 * l.w + x0] + y[y0 * l.w + x0 + 1] + y[(y0 + 1) * l.w + x0] + y[(y0 + 1) * l.w + x0 + 1]) / 4;
  };
  const cellAt = (c: number) => at(c * CELL + CELL / 2, HEADER / 2);
  if (cellAt(0) - cellAt(1) < (WHITE - BLACK) / 2) return null;
  const mid = (cellAt(0) + cellAt(1)) / 2;
  let frame = 0;
  for (let b = 0; b < FRAME_BITS; b++) frame = frame * 2 + (cellAt(FRAME_CELL + b) > mid ? 1 : 0);
  const cal = Array.from({ length: l.levels }, (_, i) => cellAt(2 + i));
  const { cols, rows } = blocks(l);
  const symbols = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = at(c * l.block + l.block / 2, HEADER + r * l.block + l.block / 2);
      let best = 0;
      for (let i = 1; i < l.levels; i++) if (Math.abs(v - cal[i]) < Math.abs(v - cal[best])) best = i;
      symbols[r * cols + c] = best;
    }
  }
  return { frame, symbols };
}
