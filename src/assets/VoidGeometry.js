import {
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Sphere,
  Vector3
} from 'three';
import { hash11 } from '../utils/math.js';

/**
 * Geometry for the Linear Void Slash — the matter half of it.
 *
 * The breakdown's first two panels are both made of the same thing: **flakes
 * of black glass**. The shadow core beam is a lance built out of them — packed
 * tight at the point like the scales of an arrowhead, loosening and lifting
 * toward its rear until they come away — and the particle debris is the ones
 * that have come away, tumbling back down the wake. One buffer serves both,
 * drawn twice with two materials: `materials/VoidSlashMaterials.js` lays the
 * lance's copies out as shingles on a pointed envelope and flies the debris'
 * copies as a stateless wake, all in the vertex stage.
 *
 * ## What is in the buffer
 *
 * A **unit** flake: a knapped chip of obsidian. Its outline is an irregular
 * polygon in the XZ plane — girdle radius 1, one vertex pushed out along +x
 * into a nose so the chip has a leading end — and it is given thickness by a
 * low ridge on each face: an apex a little above the plane and one a little
 * below, both **off-centre**, so the two faces are unequal fans rather than a
 * symmetrical lozenge. Long axis x, thickness y, width z; nothing here is in
 * metres, the material scales each instance.
 *
 * Non-indexed, like the ice crystals: every triangle carries its own face
 * normal, so the shading is flat without `flatShading` (raw ShaderMaterial,
 * no such flag) and each vertex carries a barycentric coordinate, which is how
 * the violet hairline along every facet edge is drawn — a screen-space-constant
 * line where the smallest barycentric goes to zero.
 */

/** Everything is placed in world space by the vertex stage. Cull by hand. */
const HUGE_BOUNDS = /* @__PURE__ */ new Sphere(new Vector3(), 1e4);

const _e1 = /* @__PURE__ */ new Vector3();
const _e2 = /* @__PURE__ */ new Vector3();
const _n = /* @__PURE__ */ new Vector3();

/** The three barycentric corners, cycled per triangle. */
const BARY = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1]
];

/**
 * A field of obsidian flakes as one instanced chip.
 *
 * @param {object} options
 * @param {number} [options.sides]    corners on the outline - 6 reads as a chip,
 *                                    5 with a long nose as a sliver
 * @param {number} [options.nose]     how far the leading corner is pushed out
 *                                    along +x, girdle radii
 * @param {number} [options.thick]    height of the ridge on each face, girdle
 *                                    radii - low: this is a flake, not a gem
 * @param {number} [options.jitter]   how unequal the corners are, 0..1
 * @param {number} [options.seed]     which jitter
 * @param {number} [options.capacity] instance ceiling; the live count is the
 *                                    geometry's `instanceCount`
 * @param {number} [options.indexOffset] where this variant's instance indices
 *                                    start. Two variants drawn against the same
 *                                    material must not overlap, or the chip and
 *                                    the sliver hash to the same rolls and fly
 *                                    the same arc inside each other
 */
export function createVoidFlakeGeometry({
  sides = 6,
  nose = 1.3,
  thick = 0.14,
  jitter = 0.35,
  seed = 5,
  capacity = 256,
  indexOffset = 0
} = {}) {
  const n = Math.max(3, Math.round(sides));
  const count = Math.max(1, Math.round(capacity));

  /* ---- the outline, knapped ---- */
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    // In and out by a hashed fraction of the radius, so no two edges are the
    // same length - a regular hexagon reads as a machined tile.
    const r = 1 + (hash11(seed * 13.7 + i * 2.3) - 0.5) * 2 * jitter;
    // The corner at angle 0 is the nose: pulled out along +x into a point.
    const stretch = i === 0 ? nose : 1;
    ring.push(new Vector3(Math.cos(a) * r * stretch, 0, Math.sin(a) * r));
  }

  // The ridge apexes sit off-centre, and not over each other, so the upper and
  // lower faces are two different fans of unequal facets. A chip with a
  // centred ridge is a lozenge, and a lozenge is a bead.
  const ax = (hash11(seed * 3.1 + 0.7) - 0.5) * 0.7;
  const az = (hash11(seed * 5.3 + 1.9) - 0.5) * 0.5;
  const apexTop = new Vector3(ax, thick, az);
  const apexBottom = new Vector3(-ax * 0.6, -thick * 0.7, -az * 0.6);

  /* ---- two fans of triangles, one per apex ---- */
  const triangles = n * 2;
  const positions = new Float32Array(triangles * 3 * 3);
  const normals = new Float32Array(triangles * 3 * 3);
  const barys = new Float32Array(triangles * 3 * 3);

  let p = 0;

  const pushTriangle = (a, b, c) => {
    _e1.subVectors(b, a);
    _e2.subVectors(c, a);
    _n.crossVectors(_e1, _e2).normalize();
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
      p += 3;
    }
  };

  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    // Wound so both fans face outward - the upper face counter to the lower.
    pushTriangle(a, apexTop, b);
    pushTriangle(b, apexBottom, a);
  }

  const flakeIndex = new Float32Array(count);
  for (let i = 0; i < count; i++) flakeIndex[i] = i + indexOffset;

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('aBary', new BufferAttribute(barys, 3));
  geometry.setAttribute('aFlake', new InstancedBufferAttribute(flakeIndex, 1));
  geometry.instanceCount = count;
  // Every flake is positioned in world space by the vertex stage, so the
  // buffer's own bounds are a unit ball at the origin and mean nothing. The
  // mesh must set `frustumCulled = false`.
  geometry.boundingSphere = HUGE_BOUNDS;
  return geometry;
}

/**
 * A field of camera-facing sprites as one instanced quad - the energy sparks
 * and the lingering motes.
 *
 * The quad runs -1..1 on x and y; the material lays it out in view space
 * around a centre it computes per instance, so the buffer holds no metres.
 *
 * @param {number} capacity instance ceiling
 * @param {number} indexOffset where this draw's instance indices start
 */
export function createVoidSpriteGeometry(capacity = 256, indexOffset = 0) {
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
