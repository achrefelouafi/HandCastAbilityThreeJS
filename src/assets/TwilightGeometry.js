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
 * Geometry for the Scorched Twilight of Rage — the ice half of it.
 *
 * The breakdown's second panel is labelled *Stylized Ice Particles*, and the
 * word that matters in it is **stylized**, not *particles*. Every crystal on
 * that sheet is drawn as a solid: flat facets that step from a deep blue face
 * to a near-white one across a hard edge, a bright line along every edge where
 * two facets meet, and a silhouette with corners in it. A camera-facing sprite
 * cannot do any of that — it has one normal, so it has one value, and a cloud
 * of them reads as confetti no matter what is painted on the quad.
 *
 * So these are real bipyramids, drawn as one instanced draw call, and
 * `materials/IceShardMaterial.js` places, tumbles and lights each one in its
 * vertex stage. That is the single biggest difference between this ability and
 * a particle system with a diamond texture on it.
 *
 * ## What is in the buffer
 *
 * A **unit** crystal: long axis on y, running −`bottom` … +`top`, girdle of
 * radius 1 at y = 0. Nothing here is in metres — the material scales each
 * instance non-uniformly, so one buffer covers the whole size and slenderness
 * range on the sheet.
 *
 * It is deliberately **non-indexed**. Every triangle carries its own three
 * vertices and its own face normal, which is what makes the shading flat
 * without `flatShading` (this is a raw ShaderMaterial, so there is no such
 * flag) and without `dFdx` in the fragment stage. Each vertex also carries a
 * barycentric coordinate, and that is how the edges are drawn: the fragment
 * stage lights up where the smallest barycentric goes to zero, which is a
 * screen-space-constant hairline along every facet boundary. Wireframe
 * rendering cannot do it — it has no width control and no antialiasing.
 *
 * ## Why the girdle is jittered
 *
 * A regular polygon girdle makes a regular bipyramid, and a regular bipyramid
 * has facets that are all the same size and all the same shade at a given
 * angle, so it reads as a machined bead. The sheet's crystals are ice: the
 * facets are visibly unequal. Pushing each girdle vertex in or out by a hashed
 * fraction of the radius, and lifting it off the equator a little, makes every
 * facet a different size and puts a different value on each — for the price of
 * two multiplies at build time.
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
 * A field of ice crystals as one instanced bipyramid.
 *
 * @param {object} options
 * @param {number} [options.sides]    facets around the girdle — 5 or 6 reads as
 *                                    a gem, 4 as a shard, 3 as a splinter
 * @param {number} [options.top]      length of the upper pyramid, girdle radii
 * @param {number} [options.bottom]   ... and the lower one. Unequal on purpose:
 *                                    a symmetric bipyramid has no "up", so a
 *                                    tumbling one never changes silhouette
 * @param {number} [options.jitter]   how unequal the facets are, 0..1
 * @param {number} [options.seed]     which jitter
 * @param {number} [options.capacity] instance ceiling; the live count is the
 *                                    geometry's `instanceCount`
 * @param {number} [options.indexOffset] where this variant's instance indices
 *                                    start. Two variants drawn against the same
 *                                    material must not overlap, or the gem and
 *                                    the splinter hash to the same rolls and fly
 *                                    the same arc inside each other
 */
export function createIceShardGeometry({
  sides = 6,
  top = 1.0,
  bottom = 0.66,
  jitter = 0.3,
  seed = 3,
  capacity = 256,
  indexOffset = 0
} = {}) {
  const n = Math.max(3, Math.round(sides));
  const count = Math.max(1, Math.round(capacity));

  /* ---- the girdle ring, jittered ---- */
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    // Two hashes: one moves the vertex in and out, one lifts it off the
    // equator. The second is what stops the girdle reading as a flat collar.
    const r = 1 + (hash11(seed * 13.7 + i * 2.3) - 0.5) * 2 * jitter;
    const y = (hash11(seed * 7.1 + i * 5.9) - 0.5) * 2 * jitter * 0.45;
    ring.push(new Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
  }

  const apexTop = new Vector3(0, top, 0);
  const apexBottom = new Vector3(0, -bottom, 0);

  /* ---- two fans of triangles, one per apex ---- */
  const triangles = n * 2;
  const positions = new Float32Array(triangles * 3 * 3);
  const normals = new Float32Array(triangles * 3 * 3);
  const barys = new Float32Array(triangles * 3 * 3);
  /** 0 on the lower pyramid, 1 on the upper — the shader's tip gradient. */
  const facing = new Float32Array(triangles * 3);

  let p = 0;
  let f = 0;

  const pushTriangle = (a, b, c, up) => {
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
      facing[f++] = up;
    }
  };

  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    // Wound so both fans face outward — the crown counter to the pavilion.
    pushTriangle(a, apexTop, b, 1);
    pushTriangle(b, apexBottom, a, 0);
  }

  const shardIndex = new Float32Array(count);
  for (let i = 0; i < count; i++) shardIndex[i] = i + indexOffset;

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('aBary', new BufferAttribute(barys, 3));
  geometry.setAttribute('aFacing', new BufferAttribute(facing, 1));
  geometry.setAttribute('aShard', new InstancedBufferAttribute(shardIndex, 1));
  geometry.instanceCount = count;
  // Every crystal is positioned in world space by the vertex stage, so the
  // buffer's own bounds are a unit ball at the origin and mean nothing. The
  // mesh must set `frustumCulled = false`.
  geometry.boundingSphere = HUGE_BOUNDS;
  return geometry;
}

/**
 * The flame cone at the leading tip — the solid half of layer 3.
 *
 * A cylinder grid in **parameter space**, exactly like `FluxGeometry.js`: the
 * buffer holds no metres at all. Every vertex carries `(u, v)` — how far back
 * from the apex it is, and where it sits around the axis — and
 * `materials/FlameConeMaterial.js` turns that pair into a world position
 * against the flight path each frame. That is what lets the cone follow the
 * curve the shot actually flew rather than being a rigid cone stuck on the
 * front of it, and it is why its length, radius and sharpness are all live
 * sliders on a tip already in the air.
 *
 * `u` runs 0 at the apex to 1 at the open base; `v` runs 0 to 1 around, with
 * the ring at `v = 1` duplicating the one at `v = 0` so the seam closes without
 * the fragment stage having to know it is there.
 *
 * Both ends are left open. The apex is closed by the radius profile going to
 * zero anyway, and the base is a mouth: this is the front of a moving thing and
 * a cone with a lid on it reads as a traffic cone.
 *
 * @param {number} rings    samples along the axis — the curve-following detail
 * @param {number} segments samples around it
 */
export function createFlameConeGeometry(rings = 40, segments = 28) {
  const rows = Math.max(2, Math.round(rings));
  const columns = Math.max(3, Math.round(segments)) + 1; // +1 closes the seam

  const positions = new Float32Array(rows * columns * 3);
  let p = 0;
  for (let i = 0; i < rows; i++) {
    const u = i / (rows - 1);
    for (let j = 0; j < columns; j++) {
      positions[p++] = u;
      positions[p++] = j / (columns - 1);
      positions[p++] = 0;
    }
  }

  const quads = (rows - 1) * (columns - 1);
  const indices = new Uint32Array(quads * 6);
  let k = 0;
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < columns - 1; j++) {
      const a = i * columns + j;
      const b = a + columns;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = a + 1;
      indices[k++] = b;
      indices[k++] = b + 1;
      indices[k++] = a + 1;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.boundingSphere = HUGE_BOUNDS;
  return geometry;
}
