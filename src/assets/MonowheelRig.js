import { Box3, Group, Vector3 } from 'three';

/**
 * Turns the authored monowheel bot into the chassis the Monowheel ability
 * drives.
 *
 * The same contract as `DroneRig`, for a machine that never leaves the floor.
 * The export is taken as-is — it keeps its own textures — and nothing
 * downstream is allowed to know the file's numbers. What the ability is handed
 * is a **canonical chassis**:
 *
 *   - the origin is the **contact patch**: the point on the floor directly
 *     under the tire's axle. Placing the root on the ground puts the wheel on
 *     the ground, and yawing the root pivots the bot about the one point a
 *     monowheel actually pivots about;
 *   - the nose is local **+Z** — the side the sockets were placed on;
 *   - `height` metres from the floor to the top of the hull, so a size in the
 *     editor is a size on the stage;
 *   - the **tire** is the mesh named `Tire`, its pivot already at its own hub
 *     and its axle along its own local X, so rolling it is a rotation about
 *     that axis and nothing else;
 *   - the **sockets** — two spheres the modeller left as muzzle markers, one
 *     each side of the nose — are taken out of the draw, and where they sat
 *     become the points the rounds leave from, sorted left to right so the
 *     ability can alternate them.
 *
 * The result is a template. `MonowheelAbility` clones it per instance and
 * swaps in its own material, so the reveal never leaks between two bots.
 */

const _box = new Box3();
const _size = new Vector3();
const _min = new Vector3();
const _hub = new Vector3();

/**
 * @param {import('three').Object3D} scene the parsed glTF scene
 * @param {object} [options]
 * @param {number} [options.height] metres, floor to the top of the hull
 * @returns {{
 *   source: Group,
 *   wheel: {name: string, radius: number, axle: Vector3}|null,
 *   sockets: Vector3[],
 *   height: number,
 *   length: number,
 *   width: number
 * }}
 */
export function buildMonowheelRig(scene, { height = 1.7 } = {}) {
  scene.updateMatrixWorld(true);

  let tireNode = null;
  const socketNodes = [];

  scene.traverse((node) => {
    if (!node.isMesh) return;
    // Loose on purpose: GLTFLoader strips the `.` out of `Socket.001`, so the
    // exported names never arrive intact.
    if (/Tire/i.test(node.name)) tireNode = node;
    else if (/Socket/i.test(node.name)) socketNodes.push(node);
  });
  if (!tireNode) console.warn('[MonowheelRig] no Tire mesh found — the wheel will not roll');
  if (socketNodes.length === 0) console.warn('[MonowheelRig] no Socket* meshes found — rounds will leave from the nose');

  // The sockets are markers, not parts: read them, then take them out before
  // the chassis is measured so a marker can never widen the hull. Removing
  // rather than hiding, so no warm-up pass can ever flick one back on.
  const socketWorld = socketNodes
    .map((node) => node.getWorldPosition(new Vector3()))
    .sort((a, b) => a.x - b.x);
  for (const node of socketNodes) {
    node.parent?.remove(node);
    node.geometry?.dispose();
  }

  // Measure the chassis, then find the floor and the hub. The contact patch
  // is under the hub, at the lowest point of the whole thing — which is the
  // bottom of the tire, by construction.
  _box.setFromObject(scene);
  _box.getSize(_size);
  _min.copy(_box.min);
  const measuredHeight = _size.y || 1;
  const scale = height / measuredHeight;

  if (tireNode) tireNode.getWorldPosition(_hub);
  else _box.getCenter(_hub);

  // Wrap rather than mutate: the glTF nodes keep their own transforms (the
  // tire's pivot depends on them) and the wrapper does the normalising. From
  // here on a world position read off any node *is* a rig-space position,
  // because the wrapper has no parent.
  const source = new Group();
  source.name = 'MonowheelChassis';
  source.scale.setScalar(scale);
  source.position.set(-_hub.x * scale, -_min.y * scale, -_hub.z * scale);
  source.add(scene);
  source.updateMatrixWorld(true);

  let wheel = null;
  if (tireNode) {
    _box.setFromObject(tireNode);
    _box.getSize(_size);
    wheel = {
      name: tireNode.name,
      // Half the disc's longest side, in rig metres since it is measured
      // through the wrapper.
      radius: Math.max(_size.y, _size.z) * 0.5,
      axle: tireNode.getWorldPosition(new Vector3())
    };
  }

  // The wrapper's transform applied by hand — the nodes are gone, so there is
  // nothing left to read a position off through it.
  const sockets = socketWorld.map(
    (p) => new Vector3((p.x - _hub.x) * scale, (p.y - _min.y) * scale, (p.z - _hub.z) * scale)
  );

  scene.traverse((node) => {
    if (!node.isMesh) return;
    node.castShadow = true;
    node.receiveShadow = false;
    node.frustumCulled = false;
    for (const material of [].concat(node.material)) {
      for (const map of [material.map, material.normalMap, material.metalnessMap, material.roughnessMap]) {
        if (map) map.anisotropy = 4;
      }
    }
  });

  _box.setFromObject(source);
  _box.getSize(_size);
  if (sockets.length === 0) sockets.push(new Vector3(0, height * 0.5, _size.z * 0.5));

  return {
    source,
    wheel,
    sockets,
    height,
    length: _size.z,
    width: _size.x
  };
}
