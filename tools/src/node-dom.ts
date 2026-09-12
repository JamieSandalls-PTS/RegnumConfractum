/**
 * The three lines of browser that a loader written for browsers insists on
 * (D-555).
 *
 * `FBXLoader` reaches for `document.createElementNS` to build an `<img>` for
 * every embedded texture. We do not want those textures — Sidekick ships a
 * 32x32 palette that the client generates per character at runtime, and the
 * FBX carries a `.psd` nothing could decode anyway — so the stub is
 * deliberately inert: it returns something with the surface an `ImageLoader`
 * touches and never fires `load`.
 *
 * Import this for its side effect BEFORE any three loader runs. In a real
 * browser it does nothing, so the same modules work either side.
 */
interface FakeElement {
  src: string;
  width: number;
  height: number;
  addEventListener(): void;
  removeEventListener(): void;
}

function fakeElement(): FakeElement {
  return {
    src: '',
    width: 0,
    height: 0,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

const g = globalThis as Record<string, unknown>;

if (typeof g.document === 'undefined') {
  g.document = {
    createElementNS: () => fakeElement(),
    createElement: () => fakeElement(),
  };
}

if (typeof g.URL !== 'undefined' && typeof (g.URL as typeof URL).createObjectURL !== 'function') {
  (g.URL as unknown as { createObjectURL: () => string }).createObjectURL = () => '';
}

// Parts that embed a texture go through `window.URL.createObjectURL`, whose
// result then feeds the inert image above. The blob URL is never fetched.
if (typeof g.window === 'undefined') {
  g.window = { URL: { createObjectURL: () => '', revokeObjectURL: () => {} } };
}

/**
 * `GLTFExporter` finishes a binary export by reading its assembled `Blob`
 * through a `FileReader`. Node has the Blob but not the reader, so this is
 * the minimum that satisfies the one call site: read the bytes, set
 * `result`, fire `onloadend`. Real enough for the exporter, and deliberately
 * not a general implementation of the interface.
 */
if (typeof g.FileReader === 'undefined') {
  class NodeFileReader {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    readAsArrayBuffer(blob: Blob): void {
      blob
        .arrayBuffer()
        .then((buf) => {
          this.result = buf;
          this.onloadend?.();
        })
        .catch((e: unknown) => this.onerror?.(e));
    }
  }
  g.FileReader = NodeFileReader;
}

export const nodeDomInstalled = true;
