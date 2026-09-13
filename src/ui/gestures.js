import { ELEMENT_META, CastShape, castShapeOf } from '../config/settings.js';

/**
 * The camera mode's gesture vocabulary, as icons and as a per-ability guide.
 *
 * `HandInput` reads a handful of poses — an open palm, a fist, a point — and
 * what each one *does* depends on what is in the slot: a fist casts a line
 * ability along the arrow, drops a far cast's circle where it is, deploys a
 * summon, and holds fire once that summon is out. So the guide is built per
 * ability rather than written once, and `CameraPanel` rebuilds it whenever
 * the slot changes. The icons are drawn inline like the ability sigils, so
 * they inherit `currentColor` and can light up in the tracker's green when
 * the pose they show is the one being read.
 *
 * The hands are silhouettes rather than outlines: at the 26 px the guide
 * draws them, an outlined hand is a comb of strokes, while a filled one is
 * still a hand. Each is a palm block with the fingers as thick round-capped
 * strokes, which is one colour and no image assets.
 */

const WRAP = (body) =>
  `<svg class="gesture-svg" viewBox="0 0 100 100" aria-hidden="true" fill="currentColor"
     stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/**
 * The open hand, front on: fingers up, thumb out to the left. The fingertips
 * stand at four different heights, which is what keeps them reading as
 * fingers once the gaps between them have blurred away.
 */
const PALM = `
  <rect x="30" y="48" width="49" height="42" rx="16"/>
  <path d="M38 62V22M50 60V12M62 62V18M74 66V32M36 74L17 54" stroke-width="8"/>
`;

/**
 * The fist, knuckles to the camera: a block with four scallops along the top
 * and the thumb's bump on its side. Compact where the palm is tall.
 */
const FIST = `
  <rect x="26" y="40" width="48" height="46" rx="16"/>
  <circle cx="35" cy="41" r="8"/>
  <circle cx="48" cy="38" r="8"/>
  <circle cx="61" cy="38" r="8"/>
  <circle cx="72" cy="42" r="7.5"/>
  <circle cx="28" cy="64" r="8"/>
`;

/**
 * The pointing hand, side on: a block with the index out to the right, the
 * thumb up and the other fingers curled under. Mirrored for the other way.
 */
const POINT = `
  <rect x="12" y="34" width="42" height="44" rx="15"/>
  <path d="M46 46H90M24 38V16" stroke-width="9"/>
  <circle cx="55" cy="60" r="7"/>
  <circle cx="55" cy="72" r="6"/>
`;

/** Open palm inside a timer ring: hold it open, and the ring fills. */
const WAKE = WRAP(`
  <g transform="translate(50 52) scale(0.68) translate(-46 -49)">${PALM}</g>
  <path d="M50 6A44 44 0 1 1 6 50" fill="none" stroke-width="4.5"/>
  <path d="M1 57L6 50L11 57" fill="none" stroke-width="4.5"/>
`);

/** Open palm with a chevron either side: move it, and the aim moves. */
const AIM = WRAP(`
  <g transform="translate(50 50) scale(0.8) translate(-46 -49)">${PALM}</g>
  <path d="M14 40L5 50L14 60M86 40L95 50L86 60" fill="none" stroke-width="5"/>
`);

/** Fist with three impact ticks: close it, and the cast goes. */
const CAST = WRAP(`
  <g transform="translate(46 54) scale(0.82) translate(-50 -60)">${FIST}</g>
  <path d="M78 26L86 16M86 40L98 36M66 16L68 4" fill="none" stroke-width="5"/>
`);

/** Fist inside a dashed ring: keep it shut, and the guns keep going. */
const HOLD = WRAP(`
  <g transform="translate(50 52) scale(0.72) translate(-50 -60)">${FIST}</g>
  <circle cx="50" cy="50" r="44" fill="none" stroke-width="4" stroke-dasharray="8 7"/>
`);

const NEXT = WRAP(POINT);
const PREV = WRAP(`<g transform="matrix(-1 0 0 1 100 0)">${POINT}</g>`);

/** A small palm with a chevron on every side: push it off the centre. */
const DRIVE = WRAP(`
  <g transform="translate(50 50) scale(0.6) translate(-46 -49)">${PALM}</g>
  <path d="M42 10L50 3L58 10M90 42L97 50L90 58M42 90L50 97L58 90M10 42L3 50L10 58" fill="none" stroke-width="5"/>
`);

/** A palm over a down arrow: take the hand out of the frame. */
const LOWER = WRAP(`
  <g transform="translate(50 36) scale(0.56) translate(-46 -49)">${PALM}</g>
  <path d="M50 66V95M40 85L50 95L60 85" fill="none" stroke-width="5"/>
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
    deploy: 'deploy the drone',
    drive: 'fly the drone; near the centre it holds',
    recall: 'recall the drone',
    kind: 'Deployed · you are flying it'
  },
  monowheel: {
    deploy: 'deploy the bot',
    drive: 'drive the bot; it turns to face your palm',
    recall: 'recall the bot',
    kind: 'Deployed · you are driving it'
  }
};

const GENERIC_SUMMON = {
  deploy: 'deploy it',
  drive: 'drive it; near the centre it holds',
  recall: 'recall it',
  kind: 'Deployed · you are driving it'
};

/**
 * A row of the guide.
 *
 * `live` names the tracker reading that lights the row: `wake` (a palm seen
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

const WAKE_ROW = row(['wake'], 'Open palm', 'hold it open to engage', 'wake');
const STEP_ROW = row(['prev', 'next'], 'Point left / right', 'previous / next ability', 'point', 'other');

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
          row(['drive'], 'Push your palm off centre', copy.drive, 'aim'),
          row(['hold'], 'Hold a fist', 'fire; open it to stop', 'grab'),
          row(['prev', 'next'], 'Point either way', copy.recall, 'point', 'other'),
          row(['lower'], 'Lower your hand', 'it holds and stops firing', 'lost')
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
        row(['aim'], 'Move your hand', 'move the circle', 'aim'),
        row(['cast'], 'Close a fist', 'drop it there', 'grab'),
        STEP_ROW,
        row(['lower'], 'Lower your hand', 'cancel the cast', 'lost')
      ]
    };
  }

  return {
    kind: 'Line cast · aimed with an arrow',
    rows: [
      WAKE_ROW,
      row(['aim'], 'Move your hand', 'swing the arrow around the caster', 'aim'),
      row(['cast'], 'Close a fist', 'cast along the arrow', 'grab'),
      STEP_ROW,
      row(['lower'], 'Lower your hand', 'cancel the cast', 'lost')
    ]
  };
}

/** The guide's header for an ability: what the slot is called, and its key. */
export function gestureTitle(element) {
  const meta = ELEMENT_META[element];
  return { label: meta?.label ?? element, key: meta?.key ?? '', accent: meta?.accent ?? '' };
}
