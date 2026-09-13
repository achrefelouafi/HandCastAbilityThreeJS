import { ELEMENT_META, CastShape, castShapeOf } from '../config/settings.js';

/**
 * The camera mode's gesture vocabulary, as hand shapes and as a per-ability
 * guide.
 *
 * `HandInput` reads a handful of poses — an open palm, a fist, a point — and
 * what each one *does* depends on what is in the slot: a fist casts a line
 * ability along the arrow, drops a far cast's circle where it is, deploys a
 * summon, and holds fire once that summon is out. So the guide is built per
 * ability rather than written once, and `CameraPanel` rebuilds it whenever
 * the slot changes. The hands are drawn inline like the ability sigils, so
 * they inherit `currentColor` and can light up in the tracker's green when
 * the pose they show is the one being read.
 *
 * The hands are silhouettes with the seams carved out. A one-colour hand
 * loses everything inside its outline — the thumb lying across a fist, the
 * fingers curled under a point — and without those it is a blob with bumps.
 * So each hand carries a mask that cuts thin transparent lines where the
 * fingers meet, and the panel behind shows through them. The cuts are
 * transparency rather than a painted colour so the same hand sits on the
 * plain tile and on the lit one without a halo.
 */

const WRAP = (body) =>
  `<svg class="gesture-svg" viewBox="0 0 100 100" aria-hidden="true" fill="currentColor"
     stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/**
 * A hand: its silhouette, masked by its seams. The mask ids repeat across the
 * page — every open palm on it is the same open palm — and a repeated id
 * resolves to the first one, which draws the same cuts. That is fine.
 *
 * @param {string} id     mask id
 * @param {string} seams  the cuts, as black strokes over a white field
 * @param {string} body   the silhouette
 */
const HAND = (id, seams, body) => `
  <mask id="${id}" maskUnits="userSpaceOnUse" x="-10" y="-10" width="120" height="120">
    <rect x="-10" y="-10" width="120" height="120" fill="#fff" stroke="none"/>
    <g fill="none" stroke="#000" stroke-width="3.5" stroke-linecap="round">${seams}</g>
  </mask>
  <g mask="url(#${id})">${body}</g>
`;

/**
 * The open hand, front on: fingers up and spread, thumb out to the left, a
 * stub of wrist below. The fingertips stand at four heights and the fingers
 * fan apart, which is what keeps them reading as five once they are small;
 * the seams between them run from the knuckles to where the gaps open.
 * Centre (48, 50).
 */
const PALM = HAND(
  'gm-palm',
  `<path d="M45 52L42.5 17M57.5 51L58.5 15M70 55L75 30"/>`,
  `<rect x="30" y="40" width="50" height="50" rx="17" stroke="none"/>
   <rect x="40" y="82" width="30" height="18" rx="7" stroke="none"/>
   <path d="M39 50L34 14M51 47L50 6M64 49L67 12M76 55L83 27M37 66L14 44" stroke-width="12"/>`
);

/**
 * The fist, knuckles to the camera: a block with four knuckles standing off
 * the top, the thumb lying across the front with a seam around it, and the
 * wrist below. The seam is what makes it a fist — without it the thumb is
 * lost in the block and the block is a mitten. Centre (51, 61).
 */
const FIST = HAND(
  'gm-fist',
  `<path d="M40.5 24V46M53.5 22V46M66 24V47"/>
   <path d="M28 68L60 64" stroke-width="23"/>
   <path d="M28 68L60 64" stroke="#fff" stroke-width="16"/>`,
  `<rect x="24" y="34" width="54" height="54" rx="18" stroke="none"/>
   <circle cx="34" cy="36" r="10" stroke="none"/>
   <circle cx="47" cy="32" r="10" stroke="none"/>
   <circle cx="60" cy="32" r="10" stroke="none"/>
   <circle cx="72" cy="37" r="9" stroke="none"/>
   <path d="M28 68L60 64" stroke-width="16"/>
   <rect x="36" y="82" width="30" height="18" rx="7" stroke="none"/>`
);

/**
 * The pointing hand, side on: the index out to the right, the thumb up, and
 * the other three curled under the index as a stack of knuckles, each with a
 * seam above it. Mirrored for the other direction. Centre (47, 50).
 */
const POINT = HAND(
  'gm-point',
  `<path d="M42 55H64M42 68H63M42 79.5H60"/>`,
  `<rect x="12" y="38" width="44" height="46" rx="15" stroke="none"/>
   <rect x="0" y="48" width="16" height="30" rx="6" stroke="none"/>
   <path d="M44 48H88M24 42V16" stroke-width="13"/>
   <circle cx="56" cy="62" r="8" stroke="none"/>
   <circle cx="55" cy="74" r="7.5" stroke="none"/>
   <circle cx="52" cy="84" r="6.5" stroke="none"/>`
);

/** Place a hand: its centre at (x, y), scaled by `s`. */
const at = (hand, cx, cy, x, y, s) => `<g transform="translate(${x} ${y}) scale(${s}) translate(${-cx} ${-cy})">${hand}</g>`;
const palm = (x, y, s) => at(PALM, 48, 50, x, y, s);
const fist = (x, y, s) => at(FIST, 51, 61, x, y, s);

/** Open palm inside a timer ring: hold it open, and the ring fills. */
const WAKE = WRAP(`
  ${palm(50, 51, 0.64)}
  <path d="M50 7A43 43 0 1 1 7 50" fill="none" stroke-width="5"/>
  <path d="M1 57L7 50L13 57" fill="none" stroke-width="5"/>
`);

/** Open palm with a chevron either side: move it, and the aim moves. */
const AIM = WRAP(`
  ${palm(50, 50, 0.8)}
  <path d="M12 40L3 50L12 60M88 40L97 50L88 60" fill="none" stroke-width="5.5"/>
`);

/** Fist with three impact ticks: close it, and the cast goes. */
const CAST = WRAP(`
  ${fist(46, 54, 0.86)}
  <path d="M79 28L88 18M87 42L99 38M66 16L68 3" fill="none" stroke-width="5.5"/>
`);

/** Fist inside a dashed ring: keep it shut, and the guns keep going. */
const HOLD = WRAP(`
  ${fist(50, 51, 0.7)}
  <circle cx="50" cy="50" r="45" fill="none" stroke-width="4.5" stroke-dasharray="9 7.6"/>
`);

const NEXT = WRAP(POINT);
const PREV = WRAP(`<g transform="matrix(-1 0 0 1 100 0)">${POINT}</g>`);

/** A smaller palm with a chevron on every side: push it off the centre. */
const DRIVE = WRAP(`
  ${palm(50, 50, 0.62)}
  <path d="M42 10L50 2L58 10M90 42L98 50L90 58M42 90L50 98L58 90M10 42L2 50L10 58" fill="none" stroke-width="5.5"/>
`);

/** A palm over a down arrow: take the hand out of the frame. */
const LOWER = WRAP(`
  ${palm(50, 33, 0.58)}
  <path d="M50 64V96M38 84L50 96L62 84" fill="none" stroke-width="6"/>
`);

/** Keyed by the `icons` names a guide row carries. */
export const GESTURE_GLYPHS = {
  wake: WAKE,
  aim: AIM,
  cast: CAST,
  hold: HOLD,
  next: NEXT,
  prev: PREV,
  drive: DRIVE,
  lower: LOWER
};

/* ------------------------------------------------------------------ */
/* The guide                                                           */
/* ------------------------------------------------------------------ */

/**
 * What each summon is called in the guide, and what the drive gesture means
 * to it — the drone strafes, the bot cannot and turns to face the hand.
 */
const SUMMON_COPY = {
  drone: {
    deploy: 'deploys the drone',
    drive: 'flies the drone; centre holds',
    recall: 'recalls the drone',
    kind: 'Deployed · you are flying it'
  },
  monowheel: {
    deploy: 'deploys the bot',
    drive: 'drives the bot; it faces your palm',
    recall: 'recalls the bot',
    kind: 'Deployed · you are driving it'
  }
};

const GENERIC_SUMMON = {
  deploy: 'deploys it',
  drive: 'drives it; centre holds',
  recall: 'recalls it',
  kind: 'Deployed · you are driving it'
};

/**
 * A tile of the guide. The copy is short on purpose — a tile is a third of
 * the panel wide, and the hand does most of the telling.
 *
 * `live` names the tracker reading that lights the tile: `wake` (a palm seen
 * before engaging), `aim` (an open hand while engaged), `grab` (the debounced
 * fist), `point` (either point) and `lost` (the hand has just gone).
 *
 * @typedef {object} GestureRow
 * @property {string[]} icons  glyph names, left to right
 * @property {string}   name   the gesture
 * @property {string}   does   what it does to the ability in the slot
 * @property {'other'|null} hand  which hand, when it is not the casting one
 * @property {'wake'|'aim'|'grab'|'point'|'lost'} live
 */

const row = (icons, name, does, live, hand = null) => ({ icons, name, does, live, hand });

const WAKE_ROW = row(['wake'], 'Open palm', 'hold it to engage', 'wake');
const STEP_ROW = row(['prev', 'next'], 'Point sideways', 'previous / next ability', 'point', 'other');

/**
 * The gestures the ability in the slot answers to, in the order a presenter
 * meets them.
 *
 * @param {string} element  ability id
 * @param {object} [options]
 * @param {boolean} [options.deployed] a summon in the slot is out and holding
 *   the bar, so the fist and the palm are its controls rather than a cast's
 * @returns {{kind: string, rows: GestureRow[]}}
 */
export function gestureGuide(element, { deployed = false } = {}) {
  const shape = castShapeOf(element);

  if (shape === CastShape.SUMMON) {
    const copy = SUMMON_COPY[element] ?? GENERIC_SUMMON;
    if (deployed) {
      return {
        kind: copy.kind,
        rows: [
          row(['drive'], 'Push palm off centre', copy.drive, 'aim'),
          row(['hold'], 'Hold a fist', 'fires; open it to stop', 'grab'),
          row(['prev', 'next'], 'Point sideways', copy.recall, 'point', 'other'),
          row(['lower'], 'Lower hand', 'it holds and stops firing', 'lost')
        ]
      };
    }
    return {
      kind: 'Summon · a fist deploys it',
      rows: [WAKE_ROW, row(['cast'], 'Close a fist', copy.deploy, 'grab'), STEP_ROW]
    };
  }

  if (shape === CastShape.ZONE) {
    return {
      kind: 'Far cast · aimed with a circle',
      rows: [
        WAKE_ROW,
        row(['aim'], 'Move hand', 'moves the circle', 'aim'),
        row(['cast'], 'Close a fist', 'drops it there', 'grab'),
        STEP_ROW,
        row(['lower'], 'Lower hand', 'cancels the cast', 'lost')
      ]
    };
  }

  return {
    kind: 'Line cast · aimed with an arrow',
    rows: [
      WAKE_ROW,
      row(['aim'], 'Move hand', 'swings the arrow', 'aim'),
      row(['cast'], 'Close a fist', 'casts along the arrow', 'grab'),
      STEP_ROW,
      row(['lower'], 'Lower hand', 'cancels the cast', 'lost')
    ]
  };
}

/** The guide's header for an ability: what the slot is called, and its key. */
export function gestureTitle(element) {
  const meta = ELEMENT_META[element];
  return { label: meta?.label ?? element, key: meta?.key ?? '', accent: meta?.accent ?? '' };
}
