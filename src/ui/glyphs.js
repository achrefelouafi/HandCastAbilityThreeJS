/**
 * Ability sigils for the HUD — drawn inline so they inherit `currentColor` (the
 * slot's `--accent`) and need no image assets.
 *
 * A 100×100 box, stroke only, so the mark reads the same at 34px in the ability
 * slot as it does scaled up.
 */

const WRAP = (body) =>
  `<svg class="glyph-svg" viewBox="0 0 100 100" aria-hidden="true" fill="none"
     stroke="currentColor" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/**
 * Shimmering Flux of Chaos — a funnel with ribbons streaming out of its point,
 * a drop of blood falling off it and two glints thrown clear.
 *
 * The one sigil in the set built around a *direction*: everything else here is
 * a thing standing still, and this ability is something going somewhere at
 * speed. So the mark reads corner to corner — the mouth of the conical trail
 * at the bottom left with a second ring inside it for the mesh, the two lines
 * of the cone converging on a point at the top right, and the ribbons carrying
 * on past that point and out of the box. The teardrop is the only mark that
 * says *blood* at 34px, and without it the slot could be any beam.
 */
const FLUX = WRAP(`
  <ellipse cx="26" cy="74" rx="17" ry="6" transform="rotate(47 26 74)"/>
  <ellipse cx="47" cy="55" rx="10" ry="3.6" transform="rotate(47 47 55)"/>
  <path d="M37 86L78 26"/>
  <path d="M15 62L78 26"/>
  <path d="M16 88C38 72 44 52 66 38C76 31 84 26 93 20"/>
  <path d="M31 91C45 71 62 63 72 45C78 34 82 26 88 12"/>
  <path d="M52 74C56 80 58 83 58 86A6 6 0 0 1 46 86C46 83 48 80 52 74Z"/>
  <path d="M84 42V52M79 47H89"/>
  <path d="M62 14V22M58 18H66"/>
`);

/** Keyed by the ids in `ELEMENTS`. */
/**
 * Drone — a hexacopter seen from above, inside its ring.
 *
 * The only sigil that is a *machine*: a body with six arms and a rotor disc
 * on each, framed by the range ring the ability draws on the floor. Nothing
 * else on the bar has straight spokes, which is what separates it at a glance
 * from the organic shapes around it.
 */
const DRONE = WRAP(`
  <circle cx="50" cy="50" r="44" stroke-dasharray="6 5"/>
  <circle cx="50" cy="50" r="9"/>
  <path d="M50 41V27M57.8 45.5L70 38.5M57.8 54.5L70 61.5M50 59V73M42.2 54.5L30 61.5M42.2 45.5L30 38.5"/>
  <circle cx="50" cy="22" r="6"/>
  <circle cx="74.5" cy="36" r="6"/>
  <circle cx="74.5" cy="64" r="6"/>
  <circle cx="50" cy="78" r="6"/>
  <circle cx="25.5" cy="64" r="6"/>
  <circle cx="25.5" cy="36" r="6"/>
`);

/**
 * Phoenix — the bird rising, wings up, over the ring it burns into the floor.
 *
 * A body-and-wings mark rather than a flame, because the fire is what every
 * other hot sigil on the bar already is; what this one has that they do not
 * is the bird. The ring under it is the field, drawn open at the front so
 * the wings read as standing *in* it rather than on it.
 */
const PHOENIX = WRAP(`
  <path d="M50 78V46"/>
  <path d="M50 46C46 34 38 28 30 26C36 32 40 36 41 42C34 38 26 38 20 42C30 44 38 48 43 54"/>
  <path d="M50 46C54 34 62 28 70 26C64 32 60 36 59 42C66 38 74 38 80 42C70 44 62 48 57 54"/>
  <path d="M50 46C48 40 50 34 52 30M50 30L55 27"/>
  <path d="M50 78C44 74 38 68 36 62M50 78C56 74 62 68 64 62"/>
  <path d="M26 66C20 70 16 76 18 84C26 88 38 90 50 90C62 90 74 88 82 84C84 76 80 70 74 66"/>
`);

/**
 * Monowheel — the bot side-on: a hull straddling one big wheel, the pair of
 * guns on its nose, inside its ring.
 *
 * The other machine on the bar. Where the drone is six discs seen from above,
 * this is one disc seen from the side with a body over it — the wheel is the
 * whole point of the thing, so the wheel is most of the sigil.
 */
const MONOWHEEL = WRAP(`
  <circle cx="50" cy="50" r="44" stroke-dasharray="6 5"/>
  <circle cx="50" cy="58" r="18"/>
  <circle cx="50" cy="58" r="5"/>
  <path d="M50 40V28M50 76V70M32 58H26M74 58H68"/>
  <path d="M33 44C34 32 42 26 50 26C58 26 66 32 67 44"/>
  <path d="M60 30L76 34M60 36L76 40"/>
  <circle cx="77" cy="34" r="2.5"/>
  <circle cx="77" cy="40" r="2.5"/>
`);

/**
 * Shard — a cluster of crystals standing in a circle you look into, with the
 * star blazing in the heart of them.
 *
 * A far cast built around an ellipse, and what separates it from the Void
 * Slash (the other violet on the bar) is the *light*: three faceted spires,
 * the middle one tallest, and a four-pointed star drawn over the place they
 * meet — which is the whole ability, a light source standing in a nest of
 * stone.
 */
const SHARD = WRAP(`
  <ellipse cx="50" cy="80" rx="36" ry="11"/>
  <path d="M50 78L42 40L50 12L58 40Z"/>
  <path d="M34 78L27 54L36 38L43 56"/>
  <path d="M66 78L73 54L64 38L57 56"/>
  <path d="M50 36V54M41 45H59"/>
  <path d="M44 39L56 51M56 39L44 51" stroke-width="2.6"/>
`);

/**
 * Glacial Prison — a body standing in a cylinder of ice.
 *
 * The far-cast ellipse every zone sigil stands on, and rising off it the two
 * walls of the tube, closed by a second ellipse at the top that is drawn
 * open: this is the one sigil that is a room. Inside it a figure — a head and
 * shoulders on a single stroke — with a crack running through it, and two
 * crystals growing at the foot of the wall: not a thing standing in the
 * circle but someone held in it.
 */
const FROST = WRAP(`
  <ellipse cx="50" cy="82" rx="34" ry="10"/>
  <path d="M16 82V26M84 82V26"/>
  <path d="M16 26C16 14 84 14 84 26"/>
  <path d="M16 26C16 38 84 38 84 26" stroke-dasharray="6 5"/>
  <circle cx="50" cy="44" r="7"/>
  <path d="M50 51V74M38 60L50 55L62 60"/>
  <path d="M44 62L50 68L47 74" stroke-width="2.6"/>
  <path d="M24 82L28 64L33 82M67 82L72 68L77 82"/>
`);

/**
 * Toxic Shield — a lattice dome standing on a broken floor.
 *
 * The far-cast ellipse every zone sigil stands on, and rising off it the
 * arc of the barrier: a dome, drawn as a shell rather than a room, with
 * three spars crossing over it — the lattice — and a bright node where two
 * of them meet. Under it the floor is broken: two cracks running out from
 * the middle to the rim. Where the Glacial Prison is someone held in a
 * room, this is a thing sealed under glass.
 */
const TOXIC = WRAP(`
  <ellipse cx="50" cy="82" rx="36" ry="10"/>
  <path d="M14 82C14 34 86 34 86 82"/>
  <path d="M22 60C40 52 62 50 80 62"/>
  <path d="M30 44C44 64 56 70 72 46"/>
  <path d="M38 38C50 54 50 72 48 82"/>
  <circle cx="50" cy="57" r="3.5" stroke-width="2.6"/>
  <path d="M50 82L36 88M50 82L64 90M50 82L54 74" stroke-width="2.6"/>
`);

/**
 * Void Slash — the composite read as one silhouette.
 *
 * A diagonal, like the other line casts: the lance is a dart with its point in the bottom-left corner,
 * two scales lifting off its rear, and the wake streaming up and to the right
 * out of it — two ribbons that cross once, a chip and a sliver of the glass
 * tumbling off the top, and one four-rayed spark. Its nose is a point.
 */
const VOIDSLASH = WRAP(`
  <path d="M10 90L42 58L50 66Z"/>
  <path d="M30 70L38 60M36 76L45 68"/>
  <path d="M46 62C58 58 56 42 70 36C82 30 84 22 90 12"/>
  <path d="M50 70C64 64 60 48 74 44C86 38 86 26 92 20"/>
  <path d="M72 24L78 18L82 26L75 30Z"/>
  <path d="M86 40L93 36L91 46Z"/>
  <path d="M60 22V32M55 27H65" stroke-width="2.6"/>
`);

/**
 * Glacial Shard Storm — the composite read as one silhouette.
 *
 * A diagonal like the other line casts, and the only one whose nose is a
 * gem: a faceted crystal with its point in the bottom-left corner and one
 * facet line across it, the vapour streaming up and to the right out of its
 * rear as two smooth strokes, one six-armed snowflake hanging in it and two
 * splinters thrown off the top. Where the Void Slash's nose is a dart, this
 * one is a cut stone.
 */
const GLACIAL = WRAP(`
  <path d="M10 90L24 60L44 54L52 66L36 82Z"/>
  <path d="M24 60L52 66"/>
  <path d="M46 58C58 52 62 40 76 34C84 30 88 22 92 12"/>
  <path d="M50 68C62 66 66 52 78 46C86 42 90 34 94 26"/>
  <path d="M68 62V78M61 70H75M63 65L73 75M73 65L63 75" stroke-width="2.6"/>
  <path d="M80 16L84 10L87 18L82 22Z"/>
  <path d="M60 30L66 24L67 32Z"/>
`);

export const ELEMENT_SIGILS = {
  flux: FLUX,
  glacial: GLACIAL,
  drone: DRONE,
  phoenix: PHOENIX,
  monowheel: MONOWHEEL,
  shard: SHARD,
  frost: FROST,
  toxic: TOXIC,
  voidslash: VOIDSLASH
};
