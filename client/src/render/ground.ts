import * as THREE from 'three';
import { GroundMaterialSchema, type GroundMaterial } from '@rc/shared';
import { loadLayerTexture, splatMaterial, type SplatLayer } from './ground-splat';

/**
 * Painted ground (D-585).
 *
 * ⚠ ONE implementation, used by the game and by the editor, for the reason
 * D-558 gives for sharing the character assembler: a preview that draws
 * differently from the thing it previews is a preview that lies. A texture
 * painter is worth nothing if the floor it paints is not the floor that ships.
 *
 * ⚠ The floor has been flat colour since D-567 retired the painted tile art,
 * and the editor deliberately drew nothing — "the ground has to get out of the
 * way". That was right while the ground was not authored. It stops being right
 * the moment somebody is painting it: you cannot judge a surface you cannot
 * see.
 *
 * ⚠ The ground is painted over the WHOLE AREA, not a material per tile. The
 * first cut of this hung a material off the tile legend, which made painting
 * "assign a character to a square" — cheap to store and wrong for the job. A
 * tile-based floor can only have square edges, and what a person painting
 * ground wants is a brush that goes where they put it and blends where two
 * surfaces meet.
 *
 * ⚠ What is painted is a MASK, and the materials are composited from it at
 * full resolution (D-587). Baking the blend into the image was argued from the
 * palette quantiser throwing the extra detail away; D-586 removed the
 * quantiser and voided the argument, and what it cost was measured: a 1024px
 * texture covering 2.5 metres, baked at 32 pixels per metre, arrives as 80
 * pixels. Ninety-nine per cent of the art, discarded at paint time.
 */

const PAINT_DIR = 'textures/painted';
const TEXTURE_DIR = 'textures/ground';

/**
 * The ground materials, loaded at BUILD time.
 *
 * ⚠ The same channel `content/audio/sounds.json` and the animation sets use
 * (D-578): presentation content the client reads directly. What a floor looks
 * like is not a rule the server enforces, and routing it through the wire
 * would put a render decision on the protocol.
 */
const files = import.meta.glob('../../../content/ground/*.json', { eager: true }) as Record<
  string,
  { default: unknown }
>;

let cached: Map<string, GroundMaterial> | null = null;

export function groundMaterials(): Map<string, GroundMaterial> {
  if (cached) return cached;
  cached = new Map();
  for (const [path, mod] of Object.entries(files)) {
    const parsed = GroundMaterialSchema.safeParse(mod.default);
    if (!parsed.success) {
      console.warn(`[ground] ${path}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    cached.set(parsed.data.id, parsed.data);
  }
  return cached;
}

/** Where a material's own texture lives, for the brush to stamp with. */
export function materialTextureUrl(mat: GroundMaterial): string | null {
  return mat.texture ? `${TEXTURE_DIR}/${mat.texture}` : null;
}

export interface PaintedArea {
  width: number;
  height: number;
  groundPaint?: readonly string[] | undefined;
  groundMaterials?: readonly string[] | undefined;
}

/**
 * The painted ground plane for an area, or null when nothing is painted.
 *
 * ⚠ The masks are DATA, not pictures: `NoColorSpace`, or three applies an sRGB
 * decode to numbers that are weights and every blend comes out wrong in a way
 * that still looks like ground.
 *
 * ⚠ LINEAR filtering, changed with D-586. Nearest was right while everything
 * ended in a palette quantiser — bilinear mush before a hard colour snap
 * helps nothing — and it is wrong now: a soft brush edge is the whole point of
 * the painter, and nearest turns it back into a staircase.
 */
export function buildPaintedGround(
  area: PaintedArea,
  opts: { y?: number; onLoaded?: () => void } = {},
): THREE.Mesh | null {
  const names = area.groundPaint ?? [];
  if (names.length === 0) return null;
  const loader = new THREE.TextureLoader();
  const masks = names.map((name) => {
    const texture = loader.load(
      `${PAINT_DIR}/${name}`,
      () => opts.onLoaded?.(),
      undefined,
      () => {
        // CI refuses an area naming a missing image, so this only fires for art
        // that went missing after the build — and a floor that silently fails
        // to paint looks exactly like an area nobody has painted yet.
        console.warn(`painted ground '${name}' failed to load`);
      },
    );
    texture.colorSpace = THREE.NoColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  });

  const all = groundMaterials();
  const layers: (SplatLayer | null)[] = (area.groundMaterials ?? []).map((id) => {
    const material = all.get(id);
    // ⚠ A material the content no longer defines leaves its channel EMPTY and
    // KEEPS ITS PLACE. The mask's channels are positional, so dropping the
    // entry would slide every later material onto somebody else's paint —
    // a map that renders perfectly and is the wrong map.
    if (!material) {
      console.warn(`painted ground names unknown material '${id}'`);
      return null;
    }
    const url = materialTextureUrl(material);
    return { material, texture: url ? loadLayerTexture(url) : null };
  });

  const mesh = paintedPlane(area, masks[0]!, opts.y);
  mesh.material = splatMaterial(masks, layers, area);
  return mesh;
}

/** The same plane, around a texture the editor owns and repaints live. */
export function paintedPlane(
  area: { width: number; height: number },
  texture: THREE.Texture,
  y = 0.02,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(area.width, area.height),
    new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 1,
      metalness: 0,
      transparent: true,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  // ⚠ Centred on the TILE GRID, not on the corner. A tile at (0,0) is a metre
  // square centred on the origin, so the ground runs from -0.5 to width-0.5 —
  // half a tile further out on every side. Getting this wrong shifts the whole
  // painted surface half a metre off the world it describes, which reads as
  // the art being drawn badly rather than as the plane being in the wrong
  // place.
  mesh.position.set(area.width / 2 - 0.5, y, area.height / 2 - 0.5);
  mesh.receiveShadow = true;
  return mesh;
}
