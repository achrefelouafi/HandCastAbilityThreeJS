import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';

/**
 * Parameter-space geometry for the Shimmering Flux of Chaos.
 *
 * Same construction as `RendGeometry.js` and `CascadeGeometry.js`: the buffer
 * holds no metres at all. Every vertex carries `(u, v)` — how far back down the
 * trail it is, and where it sits around it — and `materials/FluxConeMaterial.js`
 * turns that pair into a world position against the flight path each frame.
 *
 * That is what lets the cone *follow the curve the projectile actually flew*
 * rather than being a rigid cone stuck behind it, and it is why the length, the
 * flare, the mouth radius and the weave of the path itself are all live
 * sliders on a trail that is already in the air.
 *
 * Bounds are meaningless for anything placed in a shader; the mesh must set
 * `frustumCulled = false`.
 */

/** Everything is placed in world space by the vertex stage. Cull by hand. */
const HUGE_BOUNDS = /* @__PURE__ */ new Sphere(new Vector3(), 1e4);

/**
 * The conical mesh trail — layer 1 of the breakdown.
 *
 * A cylinder grid in parameter space: `u` runs 0 → 1 from the head to the mouth
 * at the far end of the trail, `v` runs 0 → 1 around the axis. The ring of
 * vertices at `v = 1` duplicates the one at `v = 0` — they land on the same
 * world position, since the shader's angle is `v · 2π` — which closes the seam
 * without the fragment stage having to know it is there.
 *
 * Both ends are left open. The head end is nearly closed by the radius profile
 * anyway, and the mouth is a mouth: this is a trail, and a trail with a lid on
 * it reads as a party hat.
 *
 * @param {number} rings    samples along the trail — the curve-following detail
 * @param {number} segments samples around it
 */
export function createConeTrailGeometry(rings = 72, segments = 36) {
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
