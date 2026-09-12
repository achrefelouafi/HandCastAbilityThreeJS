import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Matrix3,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3
} from 'three';
import { LAYER } from '../core/Layers.js';
import { randRange } from '../utils/math.js';

/** Cells a body may be cut into. Sized into the statue shader's uniform arrays. */
export const ICE_MAX_CHUNKS = 48;

const _v = new Vector3();
const _n = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _e1 = new Vector3();
const _e2 = new Vector3();
const _axis = new Vector3();
const _turn = new Quaternion();
const _q = new Quaternion();
const _m3 = new Matrix3();
const _m4 = new Matrix4();
const _skinIndex = [0, 0, 0, 0];
const _skinWeight = [0, 0, 0, 0];

/**
 * A body turned to ice, and then to pieces of ice.
 *
 * `Dummy` stops the animation and hands over the pose; this bakes that pose
 * once — every skinned vertex pushed through its bones on the CPU — into a
 * plain world-space mesh that stands exactly where the body was, and the body
 * is hidden. From then on the statue is the thing on stage, and it carries in
 * its buffer everything the shatter needs so that the break costs nothing at
 * the moment it happens:
 *
 *  - **the cells.** A handful of seed points are scattered over the body and
 *    every triangle is given to its nearest — a Voronoi fracture of the
 *    surface. `aCell` names the piece, `aPivot` is where that piece turns
 *    about, and each piece is a rigid body the frame integrates: one offset,
 *    one quaternion, gravity, a floor to land on, and a scale for the melt.
 *    The vertex shader reads its piece's transform out of a uniform array, so
 *    forty pieces are still one draw.
 *  - **the cracks.** `aEdge` is the distance to the *second* nearest seed less
 *    the distance to the nearest — zero exactly on the boundary between two
 *    pieces, growing away from it. Drawn as a glowing hairline before the
 *    break, and cut out as a gap once the pieces are moving, so the seams the
 *    ice comes apart along are the same lines that were seen spreading across
 *    it a moment before.
 *  - **two normals.** The smooth normal the body was shaded with, skinned along
 *    with the position, and the flat normal of the triangle. The statue wears
 *    the smooth one — a frozen body is still the body — and the pieces wear
 *    the flat one, because a shard of ice has facets.
 *
 * The buffer is grown once to the rig's size and reused for every body after
 * that, so freezing a second cast allocates nothing.
 */
export class IceStatue {
  /**
   * @param {import('three').Material} material from
   *   `GlacialMaterials#createIceBodyMaterial` — carries `userData.uniforms`
   *   with the chunk arrays this writes, and `userData.depth` for the shadow
   */
  constructor(material) {
    this.material = material;
    this.uniforms = material.userData.uniforms;

    this.geometry = null;
    this.capacity = 0;
    this.mesh = null;
    this.mesh = new Mesh(this._allocate(3), material);
    this.mesh.name = 'IceStatue';
    this.mesh.customDepthMaterial = material.userData.depth;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // Placed by its own vertex stage, in world space: out of the depth
    // prepass (which would rasterise the standing body under the flying
    // pieces), into the shadow map through the depth material.
    this.mesh.layers.set(LAYER.SHAPED);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;

    /** The body this stands in for, while it does. */
    this.dummy = null;
    /** Seconds since it was baked. */
    this.age = 0;
    /** The feet, the crown and the axis of the body it was baked from, world. */
    this.base = 0;
    this.top = 1.8;
    this.centre = new Vector3();
    /** How many pieces it was cut into. */
    this.chunks = 0;
    /** True once the pieces have been thrown. */
    this.shattered = false;
    /** How many are still moving. */
    this.flying = 0;

    /* ---- one rigid body per piece ---- */
    const N = ICE_MAX_CHUNKS;
    this.pivot = new Float32Array(N * 3);
    this.radius = new Float32Array(N);
    this.offset = new Float32Array(N * 3);
    this.velocity = new Float32Array(N * 3);
    this.rotation = new Float32Array(N * 4);
    this.spinAxis = new Float32Array(N * 3);
    this.spinRate = new Float32Array(N);
    this.resting = new Uint8Array(N);
    /** Scratch during the bake: triangle area and centroid sums per cell. */
    this._area = new Float32Array(N);
    this._sum = new Float32Array(N * 3);
    this._seeds = new Float32Array(N * 3);

    this._meshes = [];
    this._posed = new Float32Array(0);
    this._normals = new Float32Array(0);
  }

  get visible() {
    return this.mesh.visible;
  }

  /* ------------------------------------------------------------------ */
  /* the bake                                                            */
  /* ------------------------------------------------------------------ */

  /** A buffer for `corners` vertices, every attribute the shader reads. */
  _allocate(corners) {
    const geometry = new BufferGeometry();
    const add = (name, size) => {
      const attribute = new BufferAttribute(new Float32Array(corners * size), size);
      attribute.setUsage(DynamicDrawUsage);
      geometry.setAttribute(name, attribute);
    };
    add('position', 3);
    add('normal', 3);
    add('aFlat', 3);
    add('aPivot', 3);
    add('aCell', 1);
    add('aEdge', 1);
    geometry.setDrawRange(0, 0);
    this.capacity = corners;
    this.geometry?.dispose();
    this.geometry = geometry;
    if (this.mesh) this.mesh.geometry = geometry;
    return geometry;
  }

  /**
   * Take the body's pose and stand the statue up in it.
   *
   * @param {import('../combat/Dummy.js').Dummy} dummy already `freeze()`d, so
   *   its skeleton's world matrices are current
   * @param {number} chunks pieces to cut it into
   * @param {number} seed
   * @returns {boolean} false if the rig had nothing to bake
   */
  bake(dummy, chunks, seed) {
    const meshes = dummy.skinnedMeshes(this._meshes);
    if (meshes.length === 0) return false;

    /* ---- how much geometry, and room for it ---- */
    let vertices = 0;
    let corners = 0;
    for (const mesh of meshes) {
      const geometry = mesh.geometry;
      vertices += geometry.attributes.position.count;
      corners += geometry.index ? geometry.index.count : geometry.attributes.position.count;
    }
    if (corners > this.capacity) this._allocate(corners);
    if (this._posed.length < vertices * 3) {
      this._posed = new Float32Array(vertices * 3);
      this._normals = new Float32Array(vertices * 3);
    }

    /* ---- every vertex through its bones, once ---- */
    const posed = this._posed;
    const normals = this._normals;
    let minY = Infinity;
    let maxY = -Infinity;
    let cx = 0;
    let cz = 0;
    let base = 0;
    for (const mesh of meshes) {
      const count = mesh.geometry.attributes.position.count;
      const normal = mesh.geometry.attributes.normal;
      for (let i = 0; i < count; i++) {
        mesh.getVertexPosition(i, _v).applyMatrix4(mesh.matrixWorld);
        const k = (base + i) * 3;
        posed[k] = _v.x;
        posed[k + 1] = _v.y;
        posed[k + 2] = _v.z;
        if (_v.y < minY) minY = _v.y;
        if (_v.y > maxY) maxY = _v.y;
        cx += _v.x;
        cz += _v.z;
        if (normal) {
          skinnedNormal(mesh, i, _n);
          normals[k] = _n.x;
          normals[k + 1] = _n.y;
          normals[k + 2] = _n.z;
        } else {
          normals[k] = 0;
          normals[k + 1] = 1;
          normals[k + 2] = 0;
        }
      }
      base += count;
    }
    this.base = minY;
    this.top = maxY;
    this.centre.set(cx / vertices, (minY + maxY) * 0.5, cz / vertices);

    /* ---- the seeds: scattered over the surface, no two on top of each other ---- */
    const N = Math.max(1, Math.min(ICE_MAX_CHUNKS, Math.round(chunks)));
    const seeds = this._seeds;
    const height = Math.max(0.1, maxY - minY);
    // Roughly the spacing N patches would have over a body this tall.
    const minSep = Math.sqrt((height * 1.1) / N) * 0.55;
    let placed = 0;
    let rng = seed * 7.31 + 0.17;
    const next = () => {
      rng = (rng * 9301 + 49297) % 233280;
      return rng / 233280;
    };
    for (let s = 0; s < N; s++) {
      let best = -1;
      for (let attempt = 0; attempt < 24 && best < 0; attempt++) {
        const i = Math.floor(next() * vertices);
        const x = posed[i * 3];
        const y = posed[i * 3 + 1];
        const z = posed[i * 3 + 2];
        let clear = true;
        for (let j = 0; j < placed; j++) {
          const dx = seeds[j * 3] - x;
          const dy = seeds[j * 3 + 1] - y;
          const dz = seeds[j * 3 + 2] - z;
          if (dx * dx + dy * dy + dz * dz < minSep * minSep) {
            clear = false;
            break;
          }
        }
        if (clear || attempt === 23) best = i;
      }
      seeds[placed * 3] = posed[best * 3];
      seeds[placed * 3 + 1] = posed[best * 3 + 1];
      seeds[placed * 3 + 2] = posed[best * 3 + 2];
      placed++;
    }
    this.chunks = placed;

    /* ---- the triangles: written out, cut into cells ---- */
    const geometry = this.geometry;
    const position = geometry.attributes.position.array;
    const smooth = geometry.attributes.normal.array;
    const flat = geometry.attributes.aFlat.array;
    const pivotAttr = geometry.attributes.aPivot.array;
    const cellAttr = geometry.attributes.aCell.array;
    const edgeAttr = geometry.attributes.aEdge.array;
    this._area.fill(0);
    this._sum.fill(0);

    let written = 0;
    base = 0;
    for (const mesh of meshes) {
      const geo = mesh.geometry;
      const count = geo.attributes.position.count;
      const index = geo.index;
      const triangles = index ? index.count / 3 : count / 3;

      for (let t = 0; t < triangles; t++) {
        const ia = base + (index ? index.getX(t * 3) : t * 3);
        const ib = base + (index ? index.getX(t * 3 + 1) : t * 3 + 1);
        const ic = base + (index ? index.getX(t * 3 + 2) : t * 3 + 2);
        _a.fromArray(posed, ia * 3);
        _b.fromArray(posed, ib * 3);
        _c.fromArray(posed, ic * 3);

        _e1.subVectors(_b, _a);
        _e2.subVectors(_c, _a);
        _n.crossVectors(_e1, _e2);
        const area = _n.length() * 0.5;
        if (area > 1e-12) _n.multiplyScalar(1 / (area * 2));
        else _n.set(0, 1, 0);

        // Nearest seed to the centroid owns the triangle.
        const mx = (_a.x + _b.x + _c.x) / 3;
        const my = (_a.y + _b.y + _c.y) / 3;
        const mz = (_a.z + _b.z + _c.z) / 3;
        const cell = nearestSeed(seeds, placed, mx, my, mz);
        this._area[cell] += area;
        this._sum[cell * 3] += mx * area;
        this._sum[cell * 3 + 1] += my * area;
        this._sum[cell * 3 + 2] += mz * area;

        for (let corner = 0; corner < 3; corner++) {
          const vi = corner === 0 ? ia : corner === 1 ? ib : ic;
          const k = written * 3;
          position[k] = posed[vi * 3];
          position[k + 1] = posed[vi * 3 + 1];
          position[k + 2] = posed[vi * 3 + 2];
          smooth[k] = normals[vi * 3];
          smooth[k + 1] = normals[vi * 3 + 1];
          smooth[k + 2] = normals[vi * 3 + 2];
          flat[k] = _n.x;
          flat[k + 1] = _n.y;
          flat[k + 2] = _n.z;
          cellAttr[written] = cell;
          edgeAttr[written] = edgeDistance(seeds, placed, position[k], position[k + 1], position[k + 2]);
          written++;
        }
      }
      base += count;
    }

    /* ---- where each piece turns, and how big it is ---- */
    for (let i = 0; i < placed; i++) {
      const area = this._area[i];
      if (area > 1e-9) {
        this.pivot[i * 3] = this._sum[i * 3] / area;
        this.pivot[i * 3 + 1] = this._sum[i * 3 + 1] / area;
        this.pivot[i * 3 + 2] = this._sum[i * 3 + 2] / area;
      } else {
        this.pivot[i * 3] = seeds[i * 3];
        this.pivot[i * 3 + 1] = seeds[i * 3 + 1];
        this.pivot[i * 3 + 2] = seeds[i * 3 + 2];
      }
      this.radius[i] = 0.02;
    }
    for (let v = 0; v < written; v++) {
      const cell = cellAttr[v];
      const k = v * 3;
      pivotAttr[k] = this.pivot[cell * 3];
      pivotAttr[k + 1] = this.pivot[cell * 3 + 1];
      pivotAttr[k + 2] = this.pivot[cell * 3 + 2];
      const dx = position[k] - pivotAttr[k];
      const dy = position[k + 1] - pivotAttr[k + 1];
      const dz = position[k + 2] - pivotAttr[k + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > this.radius[cell]) this.radius[cell] = d;
    }

    for (const name of ['position', 'normal', 'aFlat', 'aPivot', 'aCell', 'aEdge']) {
      geometry.attributes[name].needsUpdate = true;
    }
    geometry.setDrawRange(0, written);

    /* ---- whole, still, standing ---- */
    this.offset.fill(0);
    this.velocity.fill(0);
    this.resting.fill(0);
    this.spinRate.fill(0);
    for (let i = 0; i < ICE_MAX_CHUNKS; i++) {
      this.rotation[i * 4] = 0;
      this.rotation[i * 4 + 1] = 0;
      this.rotation[i * 4 + 2] = 0;
      this.rotation[i * 4 + 3] = 1;
    }
    this.shattered = false;
    this.flying = 0;
    this.age = 0;
    this.dummy = dummy;
    this._writeChunks(1, 0);

    const u = this.uniforms;
    u.uSeed.value = seed;
    u.uBaseY.value = minY;
    u.uTopY.value = maxY;
    u.uFreeze.value = 0;
    u.uFrostLine.value = minY - 0.2;
    u.uCrack.value = 0;
    u.uShatter.value = 0;
    u.uMelt.value = 0;
    this.mesh.visible = true;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* the break                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Throw the pieces.
   *
   * Each leaves along the line from the body's own axis through its pivot —
   * a statue bursts *outward* — with a share of `away` on top, which is the
   * direction out of the aura the cast wants the debris scattered in, and a
   * random lift so the pieces arc rather than slide.
   *
   * @param {import('three').Vector3} away unit, flat: out of the circle
   * @param {{speed: number, lift: number, out: number, spin: number}} p
   */
  shatter(away, p) {
    if (this.shattered) return;
    this.shattered = true;
    this.uniforms.uShatter.value = 1;
    this.uniforms.uCrack.value = 0;

    for (let i = 0; i < this.chunks; i++) {
      const k = i * 3;
      let dx = this.pivot[k] - this.centre.x;
      let dz = this.pivot[k + 2] - this.centre.z;
      const len = Math.hypot(dx, dz);
      if (len > 1e-4) {
        dx /= len;
        dz /= len;
      } else {
        dx = away.x;
        dz = away.z;
      }
      // Higher pieces are thrown a little harder: the top of a statue is
      // what flies, the feet mostly fall.
      const up = (this.pivot[k + 1] - this.base) / Math.max(0.1, this.top - this.base);
      const speed = p.speed * randRange(0.55, 1.35) * (0.7 + 0.6 * up);
      this.velocity[k] = (dx + away.x * p.out) * speed;
      this.velocity[k + 1] = p.lift * randRange(0.3, 1.2) * (0.5 + 0.7 * up);
      this.velocity[k + 2] = (dz + away.z * p.out) * speed;

      _axis.set(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1)).normalize();
      this.spinAxis[k] = _axis.x;
      this.spinAxis[k + 1] = _axis.y;
      this.spinAxis[k + 2] = _axis.z;
      this.spinRate[i] = randRange(0.4, 1) * p.spin * (Math.random() < 0.5 ? -1 : 1);
      this.resting[i] = 0;
    }
    this.flying = this.chunks;
  }

  /**
   * Integrate the pieces and hand the shader their transforms.
   *
   * Semi-implicit Euler, a floor at y = 0 with a bounce and a friction, and a
   * sleep threshold: a piece that has stopped is parked and only the melt
   * moves it after that, sinking it into the floor as it shrinks.
   *
   * @param {number} dt
   * @param {{gravity: number, bounce: number, friction: number}} p
   * @param {number} melt 0..1 how far the pieces have gone
   * @param {(index: number, impact: number) => void} [onLand] called for a
   *   piece hitting the floor hard enough to matter
   */
  update(dt, p, melt, onLand = null) {
    this.age += dt;
    if (!this.shattered) return;

    let flying = 0;
    for (let i = 0; i < this.chunks; i++) {
      const k = i * 3;
      const r = this.radius[i];

      if (!this.resting[i] && dt > 0) {
        this.velocity[k + 1] += p.gravity * dt;
        this.offset[k] += this.velocity[k] * dt;
        this.offset[k + 1] += this.velocity[k + 1] * dt;
        this.offset[k + 2] += this.velocity[k + 2] * dt;

        // The piece is a patch of shell about its pivot, so it stands a
        // fraction of its own reach off the floor when it lands.
        const floor = r * 0.55 - this.pivot[k + 1];
        if (this.offset[k + 1] <= floor) {
          this.offset[k + 1] = floor;
          if (this.velocity[k + 1] < 0) {
            const impact = -this.velocity[k + 1];
            this.velocity[k + 1] = impact * p.bounce;
            this.velocity[k] *= p.friction;
            this.velocity[k + 2] *= p.friction;
            this.spinRate[i] *= 0.45;
            if (impact > 2.5 && onLand) onLand(i, impact);
            const vx = this.velocity[k];
            const vy = this.velocity[k + 1];
            const vz = this.velocity[k + 2];
            if (vx * vx + vy * vy + vz * vz < 0.35) {
              this.resting[i] = 1;
              this.velocity[k] = 0;
              this.velocity[k + 1] = 0;
              this.velocity[k + 2] = 0;
              this.spinRate[i] = 0;
            }
          }
        }

        if (this.spinRate[i] !== 0) {
          _axis.fromArray(this.spinAxis, k);
          _turn.setFromAxisAngle(_axis, this.spinRate[i] * dt);
          _q.fromArray(this.rotation, i * 4).premultiply(_turn).normalize();
          _q.toArray(this.rotation, i * 4);
        }
        if (!this.resting[i]) flying++;
      }
    }
    this.flying = flying;
    this._writeChunks(1 - melt * 0.65, melt);
  }

  /** Copy the pieces' transforms into the shader's arrays. */
  _writeChunks(scale, melt) {
    const pos = this.uniforms.uChunkPos.value;
    const rot = this.uniforms.uChunkRot.value;
    for (let i = 0; i < ICE_MAX_CHUNKS; i++) {
      const k = i * 3;
      const q = i * 4;
      pos[q] = this.offset[k];
      // Melting pieces sink into the floor as they shrink.
      pos[q + 1] = this.offset[k + 1] - melt * this.radius[i] * 0.9;
      pos[q + 2] = this.offset[k + 2];
      pos[q + 3] = scale;
      rot[q] = this.rotation[q];
      rot[q + 1] = this.rotation[q + 1];
      rot[q + 2] = this.rotation[q + 2];
      rot[q + 3] = this.rotation[q + 3];
    }
  }

  /** World position of one piece right now. */
  chunkPosition(i, out) {
    const k = i * 3;
    return out.set(
      this.pivot[k] + this.offset[k],
      this.pivot[k + 1] + this.offset[k + 1],
      this.pivot[k + 2] + this.offset[k + 2]
    );
  }

  /** Off the stage. The body it stood for is the caller's to release. */
  hide() {
    this.mesh.visible = false;
    this.dummy = null;
    this.shattered = false;
    this.flying = 0;
  }

  dispose() {
    this.geometry?.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

/* ---------------------------------------------------------------------- */

/** Index of the seed nearest a point. */
function nearestSeed(seeds, count, x, y, z) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < count; i++) {
    const dx = seeds[i * 3] - x;
    const dy = seeds[i * 3 + 1] - y;
    const dz = seeds[i * 3 + 2] - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Distance to the second nearest seed less the distance to the nearest. */
function edgeDistance(seeds, count, x, y, z) {
  let d1 = Infinity;
  let d2 = Infinity;
  for (let i = 0; i < count; i++) {
    const dx = seeds[i * 3] - x;
    const dy = seeds[i * 3 + 1] - y;
    const dz = seeds[i * 3 + 2] - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < d1) {
      d2 = d1;
      d1 = d;
    } else if (d < d2) {
      d2 = d;
    }
  }
  if (d2 === Infinity) return 1;
  return Math.sqrt(d2) - Math.sqrt(d1);
}

/**
 * The mesh's own normal, skinned the way `SkinnedMesh#applyBoneTransform`
 * skins the position, in world space.
 *
 * Three offers the position and not the normal, so this mirrors it: the
 * bind matrix in, each bone's `matrixWorld × boneInverse` weighted, the bind
 * inverse back out, and the mesh's world matrix on top. Directions only, so
 * every matrix is taken as its upper 3×3 and the result is normalised — a
 * uniform scale on the rig (Mixamo's centimetres) falls out.
 */
function skinnedNormal(mesh, index, out) {
  const geometry = mesh.geometry;
  const skeleton = mesh.skeleton;
  const normal = geometry.attributes.normal;
  const skinIndex = geometry.attributes.skinIndex;
  const skinWeight = geometry.attributes.skinWeight;

  out.fromBufferAttribute(normal, index);
  _m3.setFromMatrix4(mesh.bindMatrix);
  out.applyMatrix3(_m3);

  for (let c = 0; c < 4; c++) {
    _skinIndex[c] = skinIndex.getComponent(index, c);
    _skinWeight[c] = skinWeight.getComponent(index, c);
  }

  _a.set(0, 0, 0);
  for (let c = 0; c < 4; c++) {
    const w = _skinWeight[c];
    if (w === 0) continue;
    const bone = skeleton.bones[_skinIndex[c]];
    _m4.multiplyMatrices(bone.matrixWorld, skeleton.boneInverses[_skinIndex[c]]);
    _m3.setFromMatrix4(_m4);
    _b.copy(out).applyMatrix3(_m3);
    _a.addScaledVector(_b, w);
  }

  _m3.setFromMatrix4(mesh.bindMatrixInverse);
  _a.applyMatrix3(_m3);
  _m3.setFromMatrix4(mesh.matrixWorld);
  _a.applyMatrix3(_m3);
  return out.copy(_a).normalize();
}
