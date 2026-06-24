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

// 1st/99th percentile of a pre-collected list of finite values. Returns
// [NaN, NaN] when empty so callers can detect "no usable data".
function loHiPercentile(vals: number[]): [number, number] {
  if (vals.length === 0) return [NaN, NaN];
  vals.sort((a, b) => a - b);
  const lo = vals[Math.min(Math.floor(0.01 * vals.length), vals.length - 1)];
  const hi = vals[Math.min(Math.floor(0.99 * vals.length), vals.length - 1)];
  return [lo, hi];
}

// A crop rectangle in display (post anti-transpose) pixel coordinates. The
// painter only renders pixels inside this rectangle and computes contrast from
// it, enabling client-side zoom with per-view autoscaling.
export interface ViewRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// Paint a 2D numeric array onto `canvas` with viridis. Normalises contrast
// using 1st/99th percentile of the central 50% of the *visible region* (the
// `view` rectangle, or the whole image when omitted), matching offline analysis
// behaviour. NaN pixels are written with alpha=0 so the underlying surface
// shows through.
//
// When `rotateCCW` is true the image is rotated 90° counter-clockwise
// (pixel (x,y) → (y, W-1-x)), which also swaps the canvas dimensions. The
// `view` rectangle is expressed in these final display coordinates, so zoom
// interactions don't need to undo the transform.
//
// When `logScale` is true, values are log-compressed (log10(v+1)) before
// contrast + colormapping — useful for high-dynamic-range detector frames.
//
// Float arrays carry NaN through; integer arrays (e.g. uint16 detector
// frames) are always finite, so the NaN check is a no-op for them. One
// signature handles both so callers don't have to fork on dtype.
//
// Returns the display range (min/max) used for the colormap, the rendered view
// origin/size, and the full display dimensions, so callers can draw aligned
// axes/colorbar and clamp further zoom.
export interface PaintResult {
  // Low/high data values mapped to the bottom/top of the colormap.
  min: number;
  max: number;
  // Rendered view origin + size, in display coordinates.
  x0: number;
  y0: number;
  width: number;
  height: number;
  // Full display dimensions (post anti-transpose), independent of the view.
  fullWidth: number;
  fullHeight: number;
}

export function paintFloatArrayToCanvas(
  canvas: HTMLCanvasElement,
  data: Float32Array | Float64Array | Uint16Array | Uint8Array,
  width: number,
  height: number,
  rotateCCW: boolean = false,
  view?: ViewRect,
  logScale: boolean = false,
): PaintResult {
  // Optional log compression for high-dynamic-range data (e.g. detector
  // frames). log10(v + 1) keeps zero at zero and is monotonic; applied to both
  // the contrast sampling and the per-pixel mapping so they stay consistent.
  const tx = logScale ? (val: number) => Math.log10(Math.max(val, 0) + 1) : (val: number) => val;

  // Full display dimensions after the optional 90° CCW rotation (which swaps
  // width/height).
  const fullWidth = rotateCCW ? height : width;
  const fullHeight = rotateCCW ? width : height;

  // Resolve + clamp the view rectangle (display coords). Omitted → whole image.
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const vx0 = view ? clamp(Math.floor(view.x0), 0, fullWidth - 1) : 0;
  const vy0 = view ? clamp(Math.floor(view.y0), 0, fullHeight - 1) : 0;
  const vx1 = view ? clamp(Math.ceil(view.x1), vx0 + 1, fullWidth) : fullWidth;
  const vy1 = view ? clamp(Math.ceil(view.y1), vy0 + 1, fullHeight) : fullHeight;
  const viewW = vx1 - vx0;
  const viewH = vy1 - vy0;

  // Central 50% of the view (middle half in each dim), in display coords.
  const cx0 = vx0 + Math.floor(viewW / 4);
  const cx1 = vx0 + Math.floor((3 * viewW) / 4);
  const cy0 = vy0 + Math.floor(viewH / 4);
  const cy1 = vy0 + Math.floor((3 * viewH) / 4);

  // Single pass over the source: map each pixel to its display coordinate,
  // collect finite values inside the view (for the fallback range) and inside
  // the central region (for the primary range).
  const central: number[] = [];
  const viewAll: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (Number.isNaN(v) || !Number.isFinite(v)) continue;
    const sx = i % width;
    const sy = (i / width) | 0;
    const dx = rotateCCW ? sy : sx;
    const dy = rotateCCW ? width - 1 - sx : sy;
    if (dx < vx0 || dx >= vx1 || dy < vy0 || dy >= vy1) continue;
    const tv = tx(v);
    viewAll.push(tv);
    if (dx >= cx0 && dx < cx1 && dy >= cy0 && dy < cy1) central.push(tv);
  }
  let [min, max] = loHiPercentile(central);
  // Fall back to the whole-view range if the central region is empty/constant.
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    [min, max] = loHiPercentile(viewAll);
  }
  // All-NaN or constant arrays: avoid divide-by-zero / non-finite range.
  const range = Number.isFinite(min) && max > min ? max - min : 1;
  const safeMin = Number.isFinite(min) ? min : 0;

  // Canvas is sized to the view; pixels outside the view are simply skipped.
  const result: PaintResult = {
    min: safeMin,
    max: safeMin + range,
    x0: vx0,
    y0: vy0,
    width: viewW,
    height: viewH,
    fullWidth,
    fullHeight,
  };

  // Build the colormapped pixels at the data's native (view) resolution in an
  // offscreen buffer first.
  const src = document.createElement('canvas');
  src.width = viewW;
  src.height = viewH;
  const sctx = src.getContext('2d');
  if (!sctx) return result;
  const imageData = sctx.createImageData(viewW, viewH);
  const out = imageData.data;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    // Map the source index to display coords. A 90° CCW rotation sends source
    // (x, y) → display (y, W-1-x).
    const sx = i % width;
    const sy = (i / width) | 0;
    const dx = rotateCCW ? sy : sx;
    const dy = rotateCCW ? width - 1 - sx : sy;
    // Skip anything outside the visible view rectangle.
    if (dx < vx0 || dx >= vx1 || dy < vy0 || dy >= vy1) continue;
    const o = ((dy - vy0) * viewW + (dx - vx0)) * 4;
    if (Number.isNaN(v)) {
      out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
      continue;
    }
    let norm = Math.round(((tx(v) - safeMin) / range) * 255);
    if (norm < 0) norm = 0;
    else if (norm > 255) norm = 255;
    const [r, g, b] = VIRIDIS_LUT[norm];
    out[o]     = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = 255;
  }
  sctx.putImageData(imageData, 0, 0);

  // Supersample onto the visible canvas with high-quality (bicubic) smoothing.
  // The browser's default CSS upscale of a tiny canvas is bilinear, which looks
  // soft/blocky; rendering the backing store at a higher resolution with a
  // better resampler makes the panel-scale image blend smoothly yet look sharp.
  // Skip when the view is already large (it'll be downscaled to fit anyway).
  const SUPERSAMPLE_TARGET = 1400; // aim for ~this many px on the long side
  const longSide = Math.max(viewW, viewH);
  const factor = longSide >= SUPERSAMPLE_TARGET
    ? 1
    : Math.min(8, Math.ceil(SUPERSAMPLE_TARGET / longSide));
  canvas.width = viewW * factor;
  canvas.height = viewH * factor;
  const ctx = canvas.getContext('2d');
  if (!ctx) return result;
  if (factor === 1) {
    ctx.putImageData(imageData, 0, 0);
  } else {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, viewW, viewH, 0, 0, canvas.width, canvas.height);
  }
  return result;
}
