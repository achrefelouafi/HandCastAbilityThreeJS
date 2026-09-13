import {
  BufferAttribute,
  BufferGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Sphere,
  Vector3
} from 'three';
import { hash11 } from '../utils/math.js';

/**
 * Geometry for the Glacial Shard Storm — the one piece of matter in it.
 *
 * The breakdown's first panel is a **subsurface ice mesh**: one large crystal
 * with a needle of a nose, a wide girdle, a chipped rear and a pair of smaller
 * crystals twinned onto its flanks. `materials/GlacialShardStormMaterials.js`
 * draws that buffer twice — its back faces first, which is how the facets you
 * see *through* a translucent gem are drawn at all, and then its front faces
 * over them — and on the strike takes it apart facet by facet.
 *
 * ## What is in the buffer
 *
 * A **unit** crystal. Its long axis is x, running 0 at the nose to 1 at the
 * rear, and its girdle radius is 1; the material scales the two independently.
 * Rings of vertices along that axis, each rotated half a step against its
 * neighbours so the skin between two rings is a band of triangles rather than
 * quads — an antiprism, which is what a cut gem's crown is — with every radius
 * and height jittered so no two facets are the same shape.
 *
 * Non-indexed, like every faceted solid in this project: each triangle carries
 * its own face normal (flat shading with no flag), a barycentric coordinate
 * (the hairline on every edge), its height along the axis (the nose is thin
 * and bright, the girdle thick and deep), and — what the others do not need —
 * a **face index and a face pivot**, so the vertex stage can move each facet
 * as a rigid piece when the crystal shatters.
 */

/** Everything is placed in world space by the vertex stage. Cull by hand. */
const HUGE_BOUNDS = /* @__PURE__ */ new Sphere(new Vector3(), 1e4);

const _e1 = /* @__PURE__ */ new Vector3();
const _e2 = /* @__PURE__ */ new Vector3();
const _n = /* @__PURE__ */ new Vector3();
const _c = /* @__PURE__ */ new Vector3();
const _o = /* @__PURE__ */ new Vector3();

/** The three barycentric corners, cycled per triangle. */
const BARY = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1]
];

/**
 * The profile of the main body: (height along the axis, girdle radii).
 *
 * A needle at the nose, the widest point just ahead of the middle, and a rear
 * that tapers to a chipped point - measured off the composite, where the
 * crystal's widest point sits about two fifths of the way back from its nose.
 */
const BODY_PROFILE = [
  [0.1, 0.2],
  [0.27, 0.62],
  [0.45, 1.0],
  [0.65, 0.86],
  [0.83, 0.52]
];

/**
 * A field of ice as one crystal.
 *
 * @param {object} options
 * @param {number} [options.sides]      facets around the girdle
 * @param {number} [options.jitter]     how unequal the facets are, 0..1
 * @param {number} [options.satellites] smaller crystals twinned onto the rear
 *                                      flanks, 0..4
 * @param {number} [options.seed]       which jitter
 */
export function createGlacialCoreGeometry({ sides = 7, jitter = 0.3, satellites = 3, seed = 3 } = {}) {
  const n = Math.max(4, Math.round(sides));

  const triangles = [];

  /* ---- the main body: rings along x, each half a step against the last ---- */
  const rings = BODY_PROFILE.map(([x, r], ringIndex) => {
    const ring = [];
    const twist = (ringIndex % 2) * 0.5;
    for (let i = 0; i < n; i++) {
      const a = ((i + twist) / n) * Math.PI * 2 + (hash11(seed * 3.1 + ringIndex * 7.7 + i * 2.3) - 0.5) * (Math.PI / n) * jitter;
      // In and out, and a little fore and aft, so no facet is a clean band.
      const rr = r * (1 + (hash11(seed * 13.7 + ringIndex * 5.1 + i * 2.9) - 0.5) * 2 * jitter * 0.45);
      const xx = x + (hash11(seed * 7.9 + ringIndex * 3.3 + i * 4.1) - 0.5) * 0.06 * jitter;
      ring.push(new Vector3(xx, Math.cos(a) * rr, Math.sin(a) * rr));
    }
    return ring;
  });

  const nose = new Vector3(0, 0, 0);
  // The rear is chipped: its point sits off the axis.
  const rear = new Vector3(
    1,
    (hash11(seed * 17.3) - 0.5) * 0.3 * jitter,
    (hash11(seed * 19.7) - 0.5) * 0.3 * jitter
  );
  const bodyCentre = new Vector3(0.5, 0, 0);

  const addFan = (apex, ring, centre) => {
    for (let i = 0; i < ring.length; i++) {
      triangles.push([ring[i], ring[(i + 1) % ring.length], apex, centre]);
    }
  };
  const addBand = (lower, upper, centre) => {
    for (let i = 0; i < lower.length; i++) {
      const j = (i + 1) % lower.length;
      triangles.push([lower[i], lower[j], upper[i], centre]);
      triangles.push([lower[j], upper[j], upper[i], centre]);
    }
  };

  addFan(nose, rings[0], bodyCentre);
  for (let r = 0; r < rings.length - 1; r++) addBand(rings[r], rings[r + 1], bodyCentre);
  addFan(rear, rings[rings.length - 1], bodyCentre);

  /* ---- the satellites: smaller bipyramids twinned onto the rear flanks ---- */
  const sats = Math.max(0, Math.min(4, Math.round(satellites)));
  for (let k = 0; k < sats; k++) {
    const h = seed * 23.1 + k * 11.7;
    // Rooted on the rear half of the body, pointing back and out.
    const rootT = 0.5 + hash11(h + 1.3) * 0.25;
    const ang = (k / Math.max(sats, 1)) * Math.PI * 2 + hash11(h + 2.1) * 1.2;
    const rootR = 0.75 - (rootT - 0.5) * 1.2;
    const root = new Vector3(rootT, Math.cos(ang) * rootR * 0.85, Math.sin(ang) * rootR * 0.85);

    const outward = new Vector3(0, Math.cos(ang), Math.sin(ang));
    const axis = new Vector3(0.55 + hash11(h + 3.7) * 0.35, 0, 0).addScaledVector(outward, 0.75).normalize();
    const u = new Vector3().crossVectors(axis, new Vector3(0, 1, 0));
    if (u.lengthSq() < 1e-4) u.set(0, 0, 1);
    u.normalize();
    const v = new Vector3().crossVectors(axis, u).normalize();

    const length = 0.38 + hash11(h + 4.9) * 0.22;
    const radius = 0.16 + hash11(h + 5.3) * 0.1;
    const m = 5;
    const girdle = [];
    const girdleAt = length * 0.42;
    for (let i = 0; i < m; i++) {
      const a = (i / m) * Math.PI * 2 + (hash11(h + i * 3.1) - 0.5) * 0.5 * jitter;
      const rr = radius * (1 + (hash11(h + i * 5.7) - 0.5) * 2 * jitter * 0.5);
      girdle.push(
        new Vector3()
          .copy(root)
          .addScaledVector(axis, girdleAt)
          .addScaledVector(u, Math.cos(a) * rr)
          .addScaledVector(v, Math.sin(a) * rr)
      );
    }
    const tip = new Vector3().copy(root).addScaledVector(axis, length);
    const foot = new Vector3().copy(root).addScaledVector(axis, -length * 0.25);
    const centre = new Vector3().copy(root).addScaledVector(axis, girdleAt);
    addFan(tip, girdle, centre);
    addFan(foot, girdle, centre);
  }

  /* ---- bake ---- */
  const count = triangles.length;
  const positions = new Float32Array(count * 9);
  const normals = new Float32Array(count * 9);
  const barys = new Float32Array(count * 9);
  const axes = new Float32Array(count * 3);
  const faces = new Float32Array(count * 3);
  const pivots = new Float32Array(count * 9);

  let p = 0;
  let q = 0;
  for (let t = 0; t < count; t++) {
    let [a, b, c] = triangles[t];
    const centre = triangles[t][3];

    _e1.subVectors(b, a);
    _e2.subVectors(c, a);
    _n.crossVectors(_e1, _e2).normalize();
    _c.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    // Wound outward, whichever way the ring was walked.
    _o.subVectors(_c, centre);
    if (_n.dot(_o) < 0) {
      const swap = b;
      b = c;
      c = swap;
      _n.negate();
    }

    const tri = [a, b, c];
    for (let v = 0; v < 3; v++) {
      positions[p + 0] = tri[v].x;
      positions[p + 1] = tri[v].y;
      positions[p + 2] = tri[v].z;
      normals[p + 0] = _n.x;
      normals[p + 1] = _n.y;
      normals[p + 2] = _n.z;
      barys[p + 0] = BARY[v][0];
      barys[p + 1] = BARY[v][1];
      barys[p + 2] = BARY[v][2];
      pivots[p + 0] = _c.x;
      pivots[p + 1] = _c.y;
      pivots[p + 2] = _c.z;
      p += 3;
      axes[q] = Math.max(0, Math.min(1, tri[v].x));
      faces[q] = t;
      q += 1;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('aBary', new BufferAttribute(barys, 3));
  geometry.setAttribute('aAxis', new BufferAttribute(axes, 1));
  geometry.setAttribute('aFace', new BufferAttribute(faces, 1));
  geometry.setAttribute('aPivot', new BufferAttribute(pivots, 3));
  // Placed in world space by the vertex stage; the buffer's own bounds mean
  // nothing. The mesh must set `frustumCulled = false`.
  geometry.boundingSphere = HUGE_BOUNDS;
  return geometry;
}

/**
 * A field of camera-facing sprites as one instanced quad - the vapour
 * streaks, the snowflakes and the glints.
 *
 * The quad runs -1..1 on x and y; the material lays it out in view space
 * around a centre it computes per instance, so the buffer holds no metres.
 *
 * @param {number} capacity instance ceiling
 * @param {number} indexOffset where this draw's instance indices start
 */
export function createGlacialQuadGeometry(capacity = 256, indexOffset = 0) {
  const count = Math.max(1, Math.round(capacity));

  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

  const spriteIndex = new Float32Array(count);
  for (let i = 0; i < count; i++) spriteIndex[i] = i + indexOffset;

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aSprite', new InstancedBufferAttribute(spriteIndex, 1));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.instanceCount = count;
  geometry.boundingSphere = HUGE_BOUNDS;
  return geometry;
}
