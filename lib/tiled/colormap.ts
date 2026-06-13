// Shared colormap LUT and a NaN-aware canvas painter for client-side rendering.
//
// We fetch raw float bytes from Tiled (rather than a server-rendered PNG) so
// NaNs survive the trip and can be drawn fully transparent. The LUT is the
// same one used by array-viewer for its grayscale-PNG → viridis pass.

// 256 RGB triples — index by grayscale value (0-255).
export const VIRIDIS_LUT: [number, number, number][] = [
  [68,1,84],[68,2,86],[69,4,87],[69,5,89],[70,7,90],[70,8,92],[70,10,93],[70,11,94],
  [71,13,96],[71,14,97],[71,16,99],[71,17,100],[71,19,101],[72,20,103],[72,22,104],[72,23,105],
  [72,24,106],[72,26,108],[72,27,109],[72,28,110],[72,29,111],[72,31,112],[72,32,113],[72,33,115],
  [72,35,116],[72,36,117],[72,37,118],[72,38,119],[72,40,120],[72,41,121],[71,42,122],[71,44,122],
  [71,45,123],[71,46,124],[71,47,125],[70,48,126],[70,50,126],[70,51,127],[69,52,128],[69,53,129],
  [69,55,129],[68,56,130],[68,57,131],[68,58,131],[67,60,132],[67,61,132],[66,62,133],[66,63,133],
  [66,64,134],[65,66,134],[65,67,135],[64,68,135],[64,69,136],[63,71,136],[63,72,137],[62,73,137],
  [62,74,137],[62,76,138],[61,77,138],[61,78,138],[60,79,139],[60,80,139],[59,81,139],[59,82,139],
  [58,83,140],[58,84,140],[57,85,140],[57,86,140],[56,88,140],[56,89,141],[55,90,141],[55,91,141],
  [54,92,141],[54,93,141],[53,94,141],[53,95,142],[52,96,142],[52,97,142],[51,98,142],[51,99,142],
  [50,100,142],[50,101,142],[49,102,142],[49,103,142],[49,104,142],[48,105,142],[48,106,142],[47,107,142],
  [47,108,142],[46,109,142],[46,110,142],[45,111,142],[45,112,142],[44,113,142],[44,114,142],[44,115,142],
  [43,116,142],[43,117,142],[42,118,142],[42,119,142],[41,120,142],[41,121,142],[40,122,142],[40,122,142],
  [40,123,142],[39,124,142],[39,125,142],[38,126,142],[38,127,142],[37,128,142],[37,129,142],[36,130,142],
  [36,131,141],[35,132,141],[35,133,141],[35,134,141],[34,135,141],[34,136,141],[33,137,141],[33,138,141],
  [32,139,141],[32,140,140],[32,141,140],[31,142,140],[31,143,140],[30,144,140],[30,145,139],[30,146,139],
  [29,147,139],[29,148,139],[29,149,139],[28,150,138],[28,151,138],[28,152,138],[27,153,138],[27,154,137],
  [27,155,137],[27,156,137],[26,157,136],[26,158,136],[26,159,136],[26,160,135],[26,161,135],[25,162,135],
  [25,163,134],[25,164,134],[25,165,134],[25,166,133],[25,167,133],[25,168,132],[25,169,132],[26,170,131],
  [26,171,131],[26,172,130],[26,173,130],[27,174,129],[27,175,129],[27,176,128],[28,177,128],[28,178,127],
  [29,179,127],[29,180,126],[30,181,125],[30,182,125],[31,183,124],[32,184,124],[32,185,123],[33,186,122],
  [34,187,122],[35,188,121],[35,189,120],[36,190,120],[37,191,119],[38,192,118],[39,193,118],[40,194,117],
  [41,195,116],[42,196,115],[44,197,115],[45,198,114],[46,199,113],[47,200,112],[49,201,111],[50,202,110],
  [52,203,110],[53,204,109],[55,205,108],[56,206,107],[58,207,106],[60,208,105],[61,209,104],[63,210,103],
  [65,210,102],[67,211,101],[69,212,100],[71,213,99],[73,214,98],[75,215,97],[77,215,96],[79,216,95],
  [81,217,93],[83,218,92],[86,218,91],[88,219,90],[90,220,88],[92,221,87],[95,221,86],[97,222,84],
  [99,223,83],[102,223,82],[104,224,80],[107,225,79],[109,225,78],[112,226,76],[114,227,75],[117,227,73],
  [119,228,72],[122,228,71],[125,229,69],[127,229,68],[130,230,66],[133,230,65],[135,231,63],[138,231,62],
  [141,232,60],[143,232,59],[146,233,57],[149,233,56],[152,234,54],[154,234,53],[157,234,51],[160,235,50],
  [163,235,48],[166,236,47],[168,236,45],[171,236,44],[174,237,42],[177,237,41],[180,238,39],[182,238,38],
  [185,238,36],[188,239,35],[191,239,34],[193,239,32],[196,240,31],[199,240,30],[201,240,29],[204,241,27],
  [207,241,26],[209,241,25],[212,242,24],[215,242,24],[217,242,23],[220,243,22],[222,243,22],[225,243,21],
];

// Compute the p-th percentile of finite values in a typed array.
function percentile(
  data: Float32Array | Float64Array | Uint16Array | Uint8Array,
  p: number,
  mask?: Uint8Array,
): number {
  const vals: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (mask && !mask[i]) continue;
    const v = data[i];
    if (!Number.isNaN(v) && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length === 0) return 0;
  vals.sort((a, b) => a - b);
  const idx = Math.min(Math.floor((p / 100) * vals.length), vals.length - 1);
  return vals[idx];
}

type NumArray = Float32Array | Float64Array | Uint16Array | Uint8Array;

// Bounding box of the "meaningful" (non-background) region of an image, or
// null if the image fills its frame (so cropping would be a no-op) or is
// empty. Used to crop a sparse reconstruction — e.g. a streaming iterative
// object that occupies a small off-center strip of a canvas sized for the
// full scan — down to the region that actually carries signal, so it fills
// the display panel instead of sitting in a sea of empty background.
function meaningfulBBox(
  data: NumArray,
  width: number,
  height: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
  // Background = median of the finite border-ring pixels (the frame edge is
  // almost always background for a sparse recon; for a full-frame image it's
  // just a representative value and the coverage guard below bails anyway).
  const border: number[] = [];
  for (let x = 0; x < width; x++) {
    const t = data[x];
    const b = data[(height - 1) * width + x];
    if (Number.isFinite(t)) border.push(t);
    if (Number.isFinite(b)) border.push(b);
  }
  for (let y = 0; y < height; y++) {
    const l = data[y * width];
    const r = data[y * width + width - 1];
    if (Number.isFinite(l)) border.push(l);
    if (Number.isFinite(r)) border.push(r);
  }
  let bg = 0;
  if (border.length) {
    border.sort((a, b) => a - b);
    bg = border[border.length >> 1];
  }
  // A pixel is "meaningful" if it's finite and deviates from background by
  // more than 2% of the data's robust (p1..p99) range.
  const p1 = percentile(data, 1);
  const p99 = percentile(data, 99);
  const scale = Number.isFinite(p99) && Number.isFinite(p1) && p99 > p1 ? p99 - p1 : 1;
  const thr = 0.02 * scale;

  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x];
      if (!Number.isFinite(v) || Math.abs(v - bg) <= thr) continue;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return null;        // nothing meaningful
  if (count / (width * height) > 0.85) return null;    // ~full frame — no crop
  // Add a small margin so the recon isn't flush against the panel edge.
  const mx = Math.round((maxX - minX + 1) * 0.04);
  const my = Math.round((maxY - minY + 1) * 0.04);
  return {
    x0: Math.max(0, minX - mx),
    y0: Math.max(0, minY - my),
    x1: Math.min(width - 1, maxX + mx),
    y1: Math.min(height - 1, maxY + my),
  };
}

// Paint a 2D numeric array onto `canvas` with viridis. Normalises contrast
// using 1st/99th percentile of the central 50% of the image (matching offline
// analysis behaviour). NaN pixels are written with alpha=0 so the underlying
// surface shows through. The canvas is resized to (width, height) — CSS
// handles display scaling.
//
// Float arrays carry NaN through; integer arrays (e.g. uint16 detector
// frames) are always finite, so the NaN check is a no-op for them. One
// signature handles both so callers don't have to fork on dtype.
//
// `autoCrop` first trims the array to its meaningful (non-background) bounding
// box. Use it for sparse reconstructions (the iterative object/phase) so a
// recon covering a small strip of a full-scan-sized canvas fills the panel —
// and so the central-50% normalisation window lands on real signal instead of
// empty background. Leave it off for full-frame images (probe, detector).
export function paintFloatArrayToCanvas(
  canvas: HTMLCanvasElement,
  data: NumArray,
  width: number,
  height: number,
  autoCrop = false,
): void {
  if (autoCrop) {
    const bb = meaningfulBBox(data, width, height);
    if (bb) {
      const cw = bb.x1 - bb.x0 + 1;
      const ch = bb.y1 - bb.y0 + 1;
      const Ctor = data.constructor as { new (n: number): NumArray };
      const cropped = new Ctor(cw * ch);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          cropped[y * cw + x] = data[(bb.y0 + y) * width + (bb.x0 + x)];
        }
      }
      data = cropped;
      width = cw;
      height = ch;
    }
  }
  // Build a mask for the central 50% of the image (middle half in each dim)
  const y0 = Math.floor(height / 4);
  const y1 = Math.floor((3 * height) / 4);
  const x0 = Math.floor(width / 4);
  const x1 = Math.floor((3 * width) / 4);
  const centralMask = new Uint8Array(data.length);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      centralMask[y * width + x] = 1;
    }
  }
  let min = percentile(data, 1, centralMask);
  let max = percentile(data, 99, centralMask);
  // Fall back to global range if central region is all-NaN or constant
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    min = percentile(data, 1);
    max = percentile(data, 99);
  }
  // All-NaN or constant arrays: avoid divide-by-zero / non-finite range.
  const range = Number.isFinite(min) && max > min ? max - min : 1;
  const safeMin = Number.isFinite(min) ? min : 0;

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const imageData = ctx.createImageData(width, height);
  const out = imageData.data;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    const o = i * 4;
    if (Number.isNaN(v)) {
      out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
      continue;
    }
    let norm = Math.round(((v - safeMin) / range) * 255);
    if (norm < 0) norm = 0;
    else if (norm > 255) norm = 255;
    const [r, g, b] = VIRIDIS_LUT[norm];
    out[o]     = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
}
