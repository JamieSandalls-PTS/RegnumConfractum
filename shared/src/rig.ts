/**
 * The imported character rig, and the map that lets somebody else's
 * animations drive it (D-555).
 *
 * The Synty Sidekick skeleton is the Unreal Engine humanoid — `pelvis`,
 * `spine_01..03`, `clavicle_l`, `thigh_r` and so on. Mixamo's is its own
 * naming (`mixamorigHips`). Retargeting one onto the other is a bone-name
 * dictionary and nothing else, so it lives here as data: written once,
 * tested, and never touched again when a new animation is dropped in.
 *
 * Direction matters. `RIG_FROM_MIXAMO` is keyed by the TARGET (our rig) and
 * valued by the SOURCE (Mixamo), because that is the direction
 * `SkeletonUtils.retargetClip` looks names up in.
 */

/** The bone the hips hang from. Nothing above it is animated. */
export const RIG_ROOT = 'root';

/** The hip bone — the only one that carries translation in a retarget. */
export const RIG_HIP = 'pelvis';

/** Mixamo's hip, the source-side name of {@link RIG_HIP}. */
export const MIXAMO_HIP = 'mixamorigHips';

/**
 * Where a held thing goes. The Sidekick skeleton ships these sockets, which
 * is why a weapon can be a child of a bone rather than a mesh welded into
 * the character (D-547's paperdoll wants to swap them at runtime).
 */
export const PROP_SOCKETS = { rightHand: 'prop_r', leftHand: 'prop_l' } as const;

/**
 * Sockets for worn gear, one per attachment point the modular parts use.
 * Nothing reads these yet; they are named so that the day something does,
 * it is not guessing at strings found in a mesh dump.
 */
export const ATTACH_SOCKETS = [
  'headAttach',
  'faceAttach',
  'backAttach',
  'hipAttachFront',
  'hipAttachBack',
  'hipAttach_l',
  'hipAttach_r',
  'shoulderAttach_l',
  'shoulderAttach_r',
  'elbowAttach_l',
  'elbowAttach_r',
  'kneeAttach_l',
  'kneeAttach_r',
] as const;

const side = (l: string, m: string): Record<string, string> => ({
  [`${l}_l`]: `mixamorigLeft${m}`,
  [`${l}_r`]: `mixamorigRight${m}`,
});

const digits = (rig: string, mixamo: string): Record<string, string> => ({
  ...side(`${rig}_01`, `Hand${mixamo}1`),
  ...side(`${rig}_02`, `Hand${mixamo}2`),
  ...side(`${rig}_03`, `Hand${mixamo}3`),
});

/**
 * Target bone name → source bone name.
 *
 * Deliberately partial. Twist bones (`calf_twist_01_l`), the IK chain
 * (`ik_foot_l`) and the attachment sockets have no Mixamo equivalent, and a
 * bone with no entry keeps its rest orientation relative to its parent —
 * which is exactly right for all three. Inventing a mapping for them is how
 * you get an elbow that rotates twice.
 */
export const RIG_FROM_MIXAMO: Readonly<Record<string, string>> = Object.freeze({
  [RIG_HIP]: MIXAMO_HIP,
  spine_01: 'mixamorigSpine',
  spine_02: 'mixamorigSpine1',
  spine_03: 'mixamorigSpine2',
  neck_01: 'mixamorigNeck',
  head: 'mixamorigHead',
  ...side('clavicle', 'Shoulder'),
  ...side('upperarm', 'Arm'),
  ...side('lowerarm', 'ForeArm'),
  ...side('hand', 'Hand'),
  ...digits('thumb', 'Thumb'),
  ...digits('index', 'Index'),
  ...digits('middle', 'Middle'),
  ...digits('ring', 'Ring'),
  ...digits('pinky', 'Pinky'),
  ...side('thigh', 'UpLeg'),
  ...side('calf', 'Leg'),
  ...side('foot', 'Foot'),
  ...side('ball', 'ToeBase'),
});

/**
 * The bones an animation must actually move for the result to read as a
 * human being. Fingers are omitted on purpose: a clip with no finger tracks
 * is a fist, not a bug.
 */
export const RIG_CORE_BONES: readonly string[] = Object.freeze([
  RIG_HIP,
  'spine_01',
  'spine_02',
  'spine_03',
  'neck_01',
  'head',
  'clavicle_l',
  'clavicle_r',
  'upperarm_l',
  'upperarm_r',
  'lowerarm_l',
  'lowerarm_r',
  'hand_l',
  'hand_r',
  'thigh_l',
  'thigh_r',
  'calf_l',
  'calf_r',
  'foot_l',
  'foot_r',
]);

/**
 * The slot a modular part fills, read off the Synty filename.
 *
 * Sidekick names every mesh `SK_<theme>_<set>_<nn>_<code>_HU01`, where the
 * code is a two-digit order plus a four-letter slot: `10TORS`, `18LEGL`,
 * `22AHED`. The order prefix is what makes the outfit layer land on top of
 * the body layer, so it is kept rather than stripped.
 */
export interface PartName {
  readonly theme: string;
  readonly set: string;
  readonly slot: string;
  readonly file: string;
}

const PART_RE = /^SK_([A-Z]+)_([A-Z]+)_(\d+)_(\d{2}[A-Z]{4})_HU\d+$/;

export function parsePartName(file: string): PartName | null {
  const stem = file.replace(/\.fbx$/i, '');
  const m = PART_RE.exec(stem);
  if (!m) return null;
  return { theme: m[1]!, set: `${m[2]}_${m[3]}`, slot: m[4]!, file };
}

/**
 * Slots that REPLACE the body underneath them rather than adding to it.
 *
 * Sidekick's own slot codes, not ours — the canonical vocabulary lives in
 * `characters.ts`. Kept because the Sidekick reader still speaks it.
 *
 * A knight's torso is not worn over the bare chest, it is instead of it —
 * leaving both in produces the z-fighting shimmer that reads as a broken
 * model. Attachment slots (the `2x`/`3x` codes) are additive and are
 * absent from this list.
 */
export const SIDEKICK_BODY_SLOTS: readonly string[] = Object.freeze([
  '01HEAD',
  '02HAIR',
  '03EBRL',
  '04EBRR',
  '05EYEL',
  '06EYER',
  '07EARL',
  '08EARR',
  '09FCHR',
  '10TORS',
  '11AUPL',
  '12AUPR',
  '13ALWL',
  '14ALWR',
  '15HNDL',
  '16HNDR',
  '17HIPS',
  '18LEGL',
  '19LEGR',
  '20FOTL',
  '21FOTR',
  '35NOSE',
  '36TETH',
  '37TONG',
  '38WRAP',
]);

/**
 * The rigs the importer knows how to drive.
 *
 * `unreal` is the Sidekick/Unreal humanoid (`pelvis`, `spine_01`,
 * `clavicle_l`). `mixamo` is Mixamo's own (`mixamorigHips`) — a character
 * downloaded from Mixamo with its skin arrives on that rig, and since the
 * animations do too, driving it needs no translation at all.
 *
 * This exists so the pipeline is not tied to one vendor. If the Synty
 * licence ever lapses, `mixamo` (and anything else added here) still builds.
 */
export type RigKind = 'unreal' | 'mixamo' | 'polytope';

/**
 * Polytope Studio's rig is Mixamo's, renamed.
 *
 * Every bone is `mixamorigX` with the prefix swapped for `PT_`, which makes
 * the dictionary a transformation rather than a list — except for four
 * joints where their naming genuinely differs, and those are spelled out
 * here rather than pattern-matched. Deriving the rest from
 * {@link RIG_FROM_MIXAMO} means a bone added there cannot be forgotten here.
 *
 * The bones this leaves unmapped are the ones that SHOULD be unmapped:
 * `PT_LeftArmTwist`, the five-bone cape chains and the front/back cloth
 * chains. No Mixamo clip drives them, and the cape and skirt are exactly
 * what D-519's cloth system already simulates.
 */
const POLYTOPE_RENAMES: Readonly<Record<string, string>> = Object.freeze({
  // Mixamo counts Spine, Spine1, Spine2; Polytope counts Spine, Spine2,
  // Spine3. Mapping these by pattern would silently shift the whole chain.
  mixamorigSpine1: 'PT_Spine2',
  mixamorigSpine2: 'PT_Spine3',
  mixamorigLeftToeBase: 'PT_LeftToe',
  mixamorigRightToeBase: 'PT_RightToe',
});

/** A Mixamo bone name in Polytope's spelling. */
function polytopeName(mixamo: string): string {
  return POLYTOPE_RENAMES[mixamo] ?? mixamo.replace(/^mixamorig/, 'PT_');
}

/** Bones that identify a rig beyond doubt, one set per kind. */
const RIG_SIGNATURES: Readonly<Record<RigKind, readonly string[]>> = Object.freeze({
  unreal: ['pelvis', 'spine_01', 'clavicle_l', 'thigh_r'],
  mixamo: [MIXAMO_HIP, 'mixamorigSpine', 'mixamorigLeftShoulder', 'mixamorigRightUpLeg'],
  polytope: ['PT_Hips', 'PT_Spine', 'PT_LeftShoulder', 'PT_RightUpLeg'],
});

/**
 * Which rig a skeleton is, from its bone names alone.
 *
 * Returns null rather than guessing. A rig nobody has written a map for
 * should stop the build with a name, not be silently retargeted through the
 * wrong dictionary and exported as a folded-up character.
 */
export function detectRig(boneNames: readonly string[]): RigKind | null {
  // Case-INSENSITIVE, because one vendor is not consistent with itself.
  // Synty's Sidekick line spells the Unreal skeleton `pelvis`, `thigh_r`,
  // `upperarm_l`; their POLYGON line spells the SAME skeleton `Pelvis`,
  // `Thigh_R`, `UpperArm_L`. Matching on the exact string would have made
  // that a whole second rig with a hand-written dictionary, for no reason
  // beyond capitalisation.
  const have = new Set(boneNames.map((b) => b.toLowerCase()));
  for (const [kind, signature] of Object.entries(RIG_SIGNATURES) as [RigKind, string[]][]) {
    if (signature.every((b) => have.has(b.toLowerCase()))) return kind;
  }
  return null;
}

/**
 * The name a particular skeleton actually uses for a canonical bone.
 *
 * Returns undefined rather than the canonical name, so a caller cannot
 * quietly look up a bone that is not there.
 */
export function findBone(
  boneNames: readonly string[],
  canonical: string,
): string | undefined {
  const want = canonical.toLowerCase();
  return boneNames.find((b) => b.toLowerCase() === want);
}

/**
 * A key for the exact SPELLING of a skeleton, not just its kind.
 *
 * Retargeted clips address bones by name, so a clip cut against `pelvis`
 * silently fails to bind to a skeleton that spells it `Pelvis` — the
 * character loads, stands in its bind pose, and reports nothing. Two Synty
 * lines are the same Unreal rig with different capitalisation, so "one
 * animation file per rig" was not a fine enough grain.
 *
 * Characters sharing a variant can share a clip file; characters that do not
 * must not. Built from the CORE bones only, because those are the ones the
 * clips actually drive.
 */
export function rigVariant(boneNames: readonly string[], kind: RigKind): string {
  const core = coreBonesFor(kind);
  const spelling = core.map((c) => findBone(boneNames, c) ?? '?').join('|');
  if (spelling === core.join('|')) return kind;
  // A short, stable digest — enough to separate variants, short enough to
  // read in a filename.
  let h = 5381;
  for (let i = 0; i < spelling.length; i++) h = ((h * 33) ^ spelling.charCodeAt(i)) >>> 0;
  return `${kind}-${h.toString(36)}`;
}

/**
 * The retarget dictionary for ONE skeleton, keyed by the names that skeleton
 * really uses.
 *
 * `retargetClip` looks its `names` option up by exact bone name, so a
 * canonical map is not enough when the file spells `Pelvis` and the map says
 * `pelvis`. Resolving against the actual bone list once, here, keeps that
 * detail out of every call site — and a bone the skeleton does not have is
 * simply absent, which is what leaves twists and attachment sockets
 * correctly unmapped.
 */
export function rigNamesFor(
  boneNames: readonly string[],
  kind: RigKind,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [canonical, mixamo] of Object.entries(mixamoMapFor(kind))) {
    const actual = findBone(boneNames, canonical);
    if (actual) out[actual] = mixamo;
  }
  return out;
}

/**
 * The target-bone → Mixamo-bone dictionary for a given rig.
 *
 * For a Mixamo-rigged character this is the identity: the clip's bones and
 * the character's bones are the same names, so every entry maps a name to
 * itself. Building it from {@link RIG_FROM_MIXAMO}'s values rather than
 * writing it out keeps the two from drifting apart.
 */
export function mixamoMapFor(kind: RigKind): Readonly<Record<string, string>> {
  if (kind === 'unreal') return RIG_FROM_MIXAMO;
  const out: Record<string, string> = {};
  for (const source of Object.values(RIG_FROM_MIXAMO)) {
    // For a Mixamo-rigged character this is the identity: the clip's bones
    // and the character's bones are the same names.
    out[kind === 'polytope' ? polytopeName(source) : source] = source;
  }
  return Object.freeze(out);
}

/** The core bones of a rig, named the way that rig names them. */
export function coreBonesFor(kind: RigKind): readonly string[] {
  if (kind === 'unreal') return RIG_CORE_BONES;
  const mixamo = RIG_CORE_BONES.map((b) => RIG_FROM_MIXAMO[b]).filter((b): b is string =>
    Boolean(b),
  );
  return kind === 'polytope' ? mixamo.map(polytopeName) : mixamo;
}

/** The hip bone, named the way that rig names it. */
export function hipBoneFor(kind: RigKind): string {
  if (kind === 'unreal') return RIG_HIP;
  return kind === 'polytope' ? polytopeName(MIXAMO_HIP) : MIXAMO_HIP;
}
