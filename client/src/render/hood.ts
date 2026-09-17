import partNames from '../../../content/parts/modular-fantasy-hero.json';
import { PartNamesSchema } from '@rc/shared';

/**
 * The hood, as a part swap (D-616).
 *
 * D-219's hooded presentation is a distinct silhouette that the recognition
 * system depends on being VISIBLE: a stranger under a hood is described as one
 * and the thread they build stays separate until the hood drops in view. The
 * procedural cast drew it as generated geometry. The imported cast's
 * `setPresentation` was an empty method with a comment calling itself a
 * regression, so on the cast that is actually shipping, the hood was invisible
 * and the whole mechanic silently rested on nothing.
 *
 * ⚠ It is a HEAD COVERING, not a garment, and that separation is load-bearing.
 * Garments are equipment (D-570/D-571) and equipment must never reach the
 * descriptor pipeline — D-539 refused a helm at creation precisely because it
 * would be a permanent disguise. The hood is the opposite: it is presentation,
 * the server already sends it on `presentation`, and the descriptors already
 * read it. Modelling it as a garment would have put it on the equipment path
 * and quietly broken the rule in the other direction.
 *
 * ⚠ Chosen by TAG rather than by filename. `tags` is documented as "free
 * keywords per part, for anything that wants to select on them later" — so
 * which mesh is the hood is a decision in content that somebody can change in
 * the creation tool, not a mesh name compiled into the renderer (D-110). It is
 * also not a guess from English: these parts carry names a person typed
 * (D-568's rule that English is not a classifier applies to inferring from
 * filenames, not to reading a tag somebody set).
 */
const CATALOGUE = PartNamesSchema.parse(partNames);

/** The part stem tagged `hood`, or null if nobody has tagged one. */
export function hoodStem(): string | null {
  for (const [stem, tags] of Object.entries(CATALOGUE.tags)) {
    if (tags.includes('hood')) return stem;
  }
  return null;
}

/** Which pack it comes from. One pack today; read rather than assumed. */
export function hoodPack(): string {
  return CATALOGUE.pack;
}

/**
 * The synthetic id the assembly uses for the hood.
 *
 * ⚠ Prefixed so it cannot collide with a garment id. It travels in the same
 * list the garments do — that is what makes the assembly cache and the part
 * resolution work unchanged — but it is never a garment, never equipped, and
 * never on the wire as one.
 */
export const HOOD_ID = 'presentation:hood';
