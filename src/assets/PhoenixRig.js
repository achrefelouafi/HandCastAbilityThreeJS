import { AnimationMixer, Box3, Group, LoopRepeat, Vector3 } from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

/**
 * Turns the authored phoenix (`phoenix_bird.glb`, a Sketchfab FBX conversion:
 * one skinned body, one flap cycle, bones in centimetres) into the frame the
 * Serpent Tide Field flies.
 *
 * Nothing downstream is allowed to know the file's numbers. What the ability
 * is handed is a **canonical bird**:
 *
 *   - the origin is the spine — the root of the wings — so hovering, banking
 *     and turning are all measured from where the body actually is, not from
 *     the centre of a bounding box that is two thirds tail;
 *   - the beak points down local **+Z**, whichever axis the export used, so a
 *     yaw of zero faces a target straight down the cast line;
 *   - `wingspan` metres tip to tip, so a size in the editor is a size on the
 *     stage;
 *   - the beak, the head and the feet are found by bone name and handed over
 *     as names, because a *clone* has its own bones and the ability reads the
 *     world position off its own copy every frame.
 *
 * The result is a template. `PhoenixAbility` clones it per instance through
 * `SkeletonUtils.clone` — a plain `Object3D#clone` leaves a skinned mesh bound
 * to the *template's* skeleton — and every clone gets its own mixer, so two
 * phoenixes on stage flap out of step.
 */

const BONES = Object.freeze({
  spine: 'B_Spine_02',
  head: 'b_Head_06',
  jaw: 'B_Jaw_07',
  leftFoot: 'b_Left_Foot_037',
  rightFoot: 'b_Right_Foot_039',
  tail: 'B_Tail_5_034'
});

const _box = new Box3();
const _meshBox = new Box3();
const _size = new Vector3();
const _point = new Vector3();
const _spine = new Vector3();
const _head = new Vector3();

/**
 * @param {object} gltf the parsed glTF ({ scene, animations })
 * @param {object} [options]
 * @param {number} [options.wingspan] metres, wing tip to wing tip
 * @returns {{
 *   source: Group,
 *   clip: import('three').AnimationClip|null,
 *   bones: typeof BONES,
 *   wingspan: number,
 *   length: number,
 *   height: number,
 *   beak: Vector3,
 *   feet: Vector3
 * }}
 */
export function buildPhoenixRig(gltf, { wingspan = 4.0 } = {}) {
  const scene = gltf.scene;
  const clip = gltf.animations?.[0] ?? null;
  if (!clip) console.warn('[PhoenixRig] the export carries no flap cycle — the bird will hold its bind pose');

  scene.updateMatrixWorld(true);

  const skinned = [];
  scene.traverse((node) => {
    if (node.isSkinnedMesh) skinned.push(node);
  });
  if (skinned.length === 0) console.warn('[PhoenixRig] no skinned mesh found');

  /* ---- measure the *posed* bird ---- */
  // A skinned mesh's geometry bounds are the bind-space cage, which for this
  // export is nowhere near the pose. `SkinnedMesh#computeBoundingBox` runs the
  // vertices through the skeleton, and that is the box the wings are in.
  _box.makeEmpty();
  for (const mesh of skinned) {
    mesh.computeBoundingBox();
    _meshBox.copy(mesh.boundingBox).applyMatrix4(mesh.matrixWorld);
    _box.union(_meshBox);
  }
  if (_box.isEmpty()) _box.setFromObject(scene);

  /* ---- which way is forward ---- */
  const spineNode = scene.getObjectByName(BONES.spine);
  const headNode = scene.getObjectByName(BONES.head);
  if (spineNode) spineNode.getWorldPosition(_spine);
  else _box.getCenter(_spine);
  if (headNode) headNode.getWorldPosition(_head);
  else _head.copy(_spine).add(new Vector3(1, 0, 0));

  const fx = _head.x - _spine.x;
  const fz = _head.z - _spine.z;
  // The yaw that carries the beak onto +Z. A Y-rotation by theta sends
  // (x, z) to (x cos + z sin, -x sin + z cos), so the heading's x has to go
  // in negated — atan2(fx, fz) lands an X-facing export on -Z, flipped.
  const yaw = Math.atan2(-fx, fz);

  /* ---- the span, measured across the heading ---- */
  // Rotate the box's corners onto the canonical frame (the same Y-rotation
  // the wrapper applies), then read x for the span and z for the length.
  // Eight points; no need for a matrix.
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? _box.max.x : _box.min.x;
    const z = i & 2 ? _box.max.z : _box.min.z;
    const rx = x * cosY + z * sinY;
    const rz = -x * sinY + z * cosY;
    minX = Math.min(minX, rx);
    maxX = Math.max(maxX, rx);
    minZ = Math.min(minZ, rz);
    maxZ = Math.max(maxZ, rz);
  }
  const measuredSpan = Math.max(1e-3, maxX - minX);
  const scale = wingspan / measuredSpan;
  _box.getSize(_size);

  /* ---- the wrapper ---- */
  // Wrap rather than mutate: the glTF nodes keep their own transforms (the
  // skin depends on them) and the wrapper does the normalising. Rotate about
  // the spine, then put the spine on the origin.
  const pivot = new Group();
  pivot.name = 'PhoenixPivot';
  pivot.position.set(-_spine.x, -_spine.y, -_spine.z);
  pivot.add(scene);

  const source = new Group();
  source.name = 'PhoenixBird';
  source.scale.setScalar(scale);
  source.rotation.y = yaw;
  source.add(pivot);
  source.updateMatrixWorld(true);

  /* ---- landmarks, in rig space ---- */
  const beak = new Vector3(0, 0.4, 0.9);
  const jawNode = scene.getObjectByName(BONES.jaw) ?? headNode;
  if (jawNode) {
    jawNode.getWorldPosition(_point);
    source.worldToLocal(_point);
    beak.copy(_point);
  }
  const feet = new Vector3(0, -0.3, -0.2);
  const lf = scene.getObjectByName(BONES.leftFoot);
  const rf = scene.getObjectByName(BONES.rightFoot);
  if (lf && rf) {
    lf.getWorldPosition(_point);
    source.worldToLocal(_point);
    feet.copy(_point);
    rf.getWorldPosition(_point);
    source.worldToLocal(_point);
    feet.add(_point).multiplyScalar(0.5);
  }

  for (const mesh of skinned) {
    // A flapping wing leaves the bind-space bounds far behind.
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
  }

  return {
    source,
    clip,
    bones: BONES,
    wingspan,
    length: (maxZ - minZ) * scale,
    height: _size.y * scale,
    beak,
    feet
  };
}

/**
 * One bird off the template: its own skeleton, its own mixer, the flap
 * cycle already playing.
 *
 * @param {ReturnType<typeof buildPhoenixRig>} rig
 * @returns {{ root: Group, mixer: AnimationMixer, action: import('three').AnimationAction|null,
 *   meshes: import('three').SkinnedMesh[], jaw: import('three').Object3D|null,
 *   head: import('three').Object3D|null, feet: import('three').Object3D[] }}
 */
export function instancePhoenix(rig) {
  const root = cloneSkeleton(rig.source);
  root.name = 'Phoenix';
  const mixer = new AnimationMixer(root);
  let action = null;
  if (rig.clip) {
    action = mixer.clipAction(rig.clip);
    action.setLoop(LoopRepeat, Infinity);
    action.play();
  }

  const meshes = [];
  root.traverse((node) => {
    if (node.isSkinnedMesh) meshes.push(node);
  });

  const feet = [];
  const lf = root.getObjectByName(rig.bones.leftFoot);
  const rf = root.getObjectByName(rig.bones.rightFoot);
  if (lf) feet.push(lf);
  if (rf) feet.push(rf);

  return {
    root,
    mixer,
    action,
    meshes,
    jaw: root.getObjectByName(rig.bones.jaw) ?? root.getObjectByName(rig.bones.head),
    head: root.getObjectByName(rig.bones.head),
    feet
  };
}
