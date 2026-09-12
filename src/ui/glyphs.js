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
 * Ward — a barrel of blood with a monolith standing in it.
 *
 * The third sigil built around a shape you look *into*, and the only one that is
 * a closed vessel: two rims joined by walls that bow out at the waist, which is
 * the silhouette the membrane actually makes. Inside it, the two things the ward
 * contains — a slab of obsidian and the flare burning beside it.
 */
const WARD = WRAP(`
  <ellipse cx="50" cy="28" rx="33" ry="11"/>
  <ellipse cx="50" cy="74" rx="33" ry="11"/>
  <path d="M17 28C12 43 12 59 17 74"/>
  <path d="M83 28C88 43 88 59 83 74"/>
  <path d="M36 72L44 41L53 48L57 72"/>
  <path d="M67 60V42M58 51H76"/>
`);

/**
 * Acid — a ring with gas climbing out of it.
 *
 * The fourth sigil built around a circle you look *into*, and the only one
 * whose contents leave the frame: two strands of mist curl up out of the ring
 * and off the top of the box, with bubbles rising between them and getting
 * smaller as they go. Where the Ward is a closed vessel, this one is open —
 * which is the one thing that separates the two green-and-glowing slots at a
 * glance.
 */
const ACID = WRAP(`
  <ellipse cx="50" cy="78" rx="36" ry="12"/>
  <path d="M27 72C22 57 32 50 28 38C25 29 33 23 30 12"/>
  <path d="M73 72C78 57 68 50 72 38C75 29 67 23 70 12"/>
  <path d="M50 68C47 55 55 48 50 36"/>
  <circle cx="41" cy="50" r="5.4"/>
  <circle cx="61" cy="36" r="3.8"/>
  <circle cx="49" cy="23" r="2.6"/>
`);

/**
 * Growth — a bloom standing in a nest, over a circle you look into.
 *
 * The fifth sigil built around an ellipse, because it is the fifth far cast and
 * that is the first thing the slot has to say. What separates it from the other
 * four is that its contents *grow*: four tendrils rise out of the ring at
 * uneven heights and a six-petal flower opens above them, which is the whole
 * ability in one silhouette. Where the Ward is a closed vessel and the Acid an
 * open one, this one is a thing standing in the circle rather than filling it.
 */
const GROWTH = WRAP(`
  <ellipse cx="50" cy="84" rx="32" ry="9"/>
  <path d="M22 82C16 67 28 59 24 46"/>
  <path d="M78 82C84 67 72 59 76 46"/>
  <path d="M37 85C35 74 43 68 41 58"/>
  <path d="M63 85C65 74 57 68 59 58"/>
  <g>
    <path d="M50 44C44 35 44 25 50 18C56 25 56 35 50 44Z"/>
    <path d="M50 44C44 35 44 25 50 18C56 25 56 35 50 44Z" transform="rotate(60 50 44)"/>
    <path d="M50 44C44 35 44 25 50 18C56 25 56 35 50 44Z" transform="rotate(120 50 44)"/>
    <path d="M50 44C44 35 44 25 50 18C56 25 56 35 50 44Z" transform="rotate(180 50 44)"/>
    <path d="M50 44C44 35 44 25 50 18C56 25 56 35 50 44Z" transform="rotate(240 50 44)"/>
    <path d="M50 44C44 35 44 25 50 18C56 25 56 35 50 44Z" transform="rotate(300 50 44)"/>
  </g>
  <circle cx="50" cy="44" r="6"/>
`);

/**
 * Cyber Serpent — a serpent drawn as a trace on a board.
 *
 * The body is one continuous run with a wedge head, and it *terminates* the way
 * a trace does: right-angle stubs into vias at both ends, with a pad on the
 * spine. At 34px the slot reads as a circuit that happens to be alive, which is
 * the whole ability — the other sigils are creatures or weapons, this one is a
 * thing that was compiled.
 */
const CYBER = WRAP(`
  <path d="M18 80C34 80 28 58 46 56C64 54 58 32 74 28"/>
  <path d="M74 28L86 18L94 30L82 40Z"/>
  <path d="M18 80H10V66"/>
  <path d="M94 30H98"/>
  <path d="M6 96H34M46 96H92"/>
  <circle cx="10" cy="61" r="4"/>
  <circle cx="40" cy="96" r="5"/>
  <circle cx="46" cy="56" r="4.5"/>
  <path d="M88 26L91 29"/>
`);

/**
 * Venom Surge — a burst of gems with a drop held at the middle of it.
 *
 * Five blades fanning off one point, the outer pair leaning hardest, which is
 * the starburst the ability actually builds; a broken line across their feet
 * for the floor they came through; and a single droplet at the heart, because
 * at 34px the fan alone could be any crystal ability and the drop is the only
 * mark that says *venom*.
 */
const VENOM = WRAP(`
  <path d="M50 8L57 46L50 58L43 46Z"/>
  <path d="M24 22L44 50L42 62L31 55Z"/>
  <path d="M76 22L56 50L58 62L69 55Z"/>
  <path d="M8 46L36 62L37 71L24 68Z"/>
  <path d="M92 46L64 62L63 71L76 68Z"/>
  <path d="M12 84H36M46 84H58M68 84H90"/>
  <path d="M50 62C56 70 59 74 59 78A9 9 0 0 1 41 78C41 74 44 70 50 62Z"/>
`);

/**
 * Monolith Rift — three slabs standing out of a broken floor.
 *
 * The only sigil in the set with no curve and no radiating fan in it, because
 * that is the one thing this slot has to say before anything else: it is not
 * energy, it is *mass*. Each slab is a closed quadrilateral with a sheared top
 * — the snapped break that the geometry itself is built around — the middle one
 * near plumb and the outer pair canted apart, and the line under their feet is
 * broken rather than continuous so the floor reads as having failed. Two chips
 * thrown clear of the top corners are all the room there is for the shrapnel.
 */
const QUAKE = WRAP(`
  <path d="M44 82L38 26L54 18L60 80Z"/>
  <path d="M26 84L14 44L25 39L37 83Z"/>
  <path d="M66 83L74 34L86 40L78 84Z"/>
  <path d="M6 88H30M38 88H58M66 88H94"/>
  <path d="M32 88L28 96M62 88L67 96"/>
  <path d="M13 22L21 17L18 27Z"/>
  <path d="M85 15L93 20L86 26Z"/>
`);

/**
 * Sumi Tide — a loaded brush stroke curling into a drain, with a drop falling
 * into it.
 *
 * The only sigil in the set drawn as a *stroke* rather than as an outline: one
 * open spiral that starts wide and tapers, which is both the brush mark the
 * ability is painted with and the vortex it ends as. Two shorter arcs outside
 * it are the ripples running off, the disc at the centre is the throat, and the
 * teardrop above it is what is about to go down. At 34px the spiral alone reads
 * as water going somewhere, which is the one thing this slot has to say.
 */
const INK = WRAP(`
  <path d="M74 26C60 14 36 16 26 30C15 45 21 66 38 73C53 79 70 73 74 60C77 49 70 40 59 39C50 38 43 45 44 53C45 60 52 64 58 61"/>
  <circle cx="55" cy="52" r="5"/>
  <path d="M14 74C24 88 44 94 60 90"/>
  <path d="M86 44C90 58 87 73 79 84"/>
  <path d="M55 12C60 20 63 25 63 29A8 8 0 0 1 47 29C47 25 50 20 55 12Z"/>
`);

/**
 * Astral Void Blast — a shadow inside its photon ring, with the light bent
 * round it and gold thrown off the equator.
 *
 * The only sigil in the set built around a *hole*: the disc at the middle is
 * filled with the slot's own accent so it reads as solid at 34px, where a bare
 * circle would read as a bubble. The tight ring welded to its edge is the
 * photon ring, the two long arcs sweeping past above and below are the frame
 * being lensed around it — deliberately not concentric, so they read as light
 * passing rather than as more rings — and the four tapering spears on the
 * horizontal are the ejecta, kept in the plane because that is where the gas
 * is. Nothing radiates evenly: a black hole is an equator, not a star.
 */
const ASTRAL = WRAP(`
  <circle cx="50" cy="50" r="11" fill="currentColor" stroke="none"/>
  <circle cx="50" cy="50" r="15.5"/>
  <path d="M18 34C31 22 66 21 81 32"/>
  <path d="M20 68C33 79 68 78 82 66"/>
  <path d="M72 50H94M6 50H28"/>
  <path d="M69 41L88 33M69 59L88 67"/>
  <path d="M31 41L12 33M31 59L12 67"/>
`);

/**
 * Cascade — a barbed four-point star inside a diamond, over a filled core.
 *
 * The one sigil in the set that is all *angles*: the star and the diamond are
 * the reference sheet's decal mark reduced to the two shapes you would still
 * recognise it by at 34px, the pair of hooks inside them are the knot at its
 * middle, and the four short strokes on the diagonals are the barbs. The disc
 * is filled with the slot's accent so the burst reads as a solid thing standing
 * in the mark rather than as another outline.
 */
const CASCADE = WRAP(`
  <path d="M50 5L60.5 39.5L95 50L60.5 60.5L50 95L39.5 60.5L5 50L39.5 39.5Z"/>
  <path d="M50 26L74 50L50 74L26 50Z"/>
  <circle cx="50" cy="50" r="5" fill="currentColor" stroke="none"/>
  <path d="M62 42C68 50 61 58 53 57"/>
  <path d="M38 58C32 50 39 42 47 43"/>
  <path d="M67 33L79 21M33 33L21 21M67 67L79 79M33 67L21 79"/>
`);

/**
 * Rend — a four-pointed star on a column, ringed twice.
 *
 * The one sigil in the set with a *vertical*: everything else here is a shape,
 * and this ability is a shaft of light with something welded to its head. So the
 * star is drawn with concave sides and a long vertical pair — the same
 * asymmetry the shader builds it from — the shaft runs out of the bottom of it
 * to the floor line, and the two ellipses crossing at its middle are the halo
 * rings, deliberately not concentric so they read as leaning rather than as a
 * target. The filled core is what keeps it legible at 34px, where the star's
 * points alone would thin out to nothing.
 */
const REND = WRAP(`
  <path d="M50 6Q53.5 34 69 44Q53.5 54 50 82Q46.5 54 31 44Q46.5 34 50 6Z"/>
  <circle cx="50" cy="44" r="4.5" fill="currentColor" stroke="none"/>
  <ellipse cx="50" cy="44" rx="33" ry="8.5" transform="rotate(-13 50 44)"/>
  <ellipse cx="50" cy="44" rx="24" ry="6.5" transform="rotate(15 50 44)"/>
  <path d="M50 82V93"/>
  <path d="M27 93H73"/>
`);

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

/**
 * Scorched Twilight — the composite read as one silhouette.
 *
 * The only sigil in the sheet that has to say *three things at once*, and the
 * order is the whole mark: a flame licking out of the bottom-left corner, two
 * strands braiding up out of it and crossing once on the way, and the crystals
 * they break into scattered off the top-right. Nothing here is symmetrical and
 * nothing is centred — this slot is a diagonal, and at 34px the diagonal is the
 * first thing that separates it from every other beam in the bar.
 */
const TWILIGHT = WRAP(`
  <path d="M17 91C10 84 13 75 23 70C20 78 27 81 27 87C27 90 21 94 17 91Z"/>
  <path d="M25 83C34 77 41 71 50 63"/>
  <path d="M21 74C29 65 35 59 43 50"/>
  <path d="M30 76C41 69 45 57 57 49C63 45 67 41 73 35"/>
  <path d="M32 71C38 61 50 59 58 47C62 41 66 37 72 31"/>
  <path d="M82 10L89 21L82 35L75 21Z"/>
  <path d="M93 32L97 39L93 48L89 39Z"/>
  <path d="M67 7L71 13L67 20L63 13Z"/>
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
 * Another far cast built around an ellipse, and what separates it from the
 * Venom slot (the other violet on the bar) is the *light*: three faceted
 * spires, the middle one tallest, and a four-pointed star drawn over the
 * place they meet — which is the whole ability, a light source standing in a
 * nest of stone.
 */
const SHARD = WRAP(`
  <ellipse cx="50" cy="80" rx="36" ry="11"/>
  <path d="M50 78L42 40L50 12L58 40Z"/>
  <path d="M34 78L27 54L36 38L43 56"/>
  <path d="M66 78L73 54L64 38L57 56"/>
  <path d="M50 36V54M41 45H59"/>
  <path d="M44 39L56 51M56 39L44 51" stroke-width="2.6"/>
`);

export const ELEMENT_SIGILS = {
  ward: WARD,
  acid: ACID,
  growth: GROWTH,
  cyber: CYBER,
  venom: VENOM,
  quake: QUAKE,
  ink: INK,
  astral: ASTRAL,
  cascade: CASCADE,
  rend: REND,
  flux: FLUX,
  twilight: TWILIGHT,
  drone: DRONE,
  phoenix: PHOENIX,
  monowheel: MONOWHEEL,
  shard: SHARD
};
