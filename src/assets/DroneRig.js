import { Box3, Group, Vector3 } from 'three';

/**
 * Turns the authored hexacopter into the frame the Drone ability flies.
 *
 * The export is taken as-is — it is the one asset in the project that keeps its
 * own textures, because the whole point of it is that it was *modelled* — but
 * nothing downstream is allowed to know the file's numbers. What the ability is
 * handed is a **canonical airframe**:
 *
 *   - the origin is the centre of the body, so hovering, banking and the
 *     ground ring are all measured from where the drone actually is;
 *   - the nose is local **+Z** — that is the side the `Socket` was placed on,
 *     and it is what `Object3D#lookAt` points at a target;
 *   - `span` metres from rotor tip to rotor tip, so a size in the editor is a
 *     size on the stage;
 *   - the blades are any mesh with `Blade` in its name and their pivots
 *     are already at their own hubs, so spinning one is a rotation about its
 *     local Y and nothing else;
 *   - the `Socket` — a sphere the modeller left as the muzzle marker — is
 *     hidden, and where it sat becomes the point every round leaves from.
 *
 * The result is a template. `DroneAbility` clones it per instance and swaps in
 * its own material, so the reveal and the rim never leak between two drones.
 */

const _box = new Box3();
const _size = new Vector3();
const _centre = new Vector3();

/**
 * @param {import('three').Object3D} scene the parsed glTF scene
 * @param {object} [options]
 * @param {number} [options.span] metres, rotor tip to rotor tip
 * @returns {{
 *   source: Group,
 *   blades: {name: string, position: Vector3}[],
 *   socket: Vector3,
 *   bladeRadius: number,
 *   height: number
 * }}
 */
export function buildDroneRig(scene, { span = 2.0 } = {}) {
  scene.updateMatrixWorld(true);

  const blades = [];
  let socketNode = null;

  scene.traverse((node) => {
    if (!node.isMesh) return;
    // Any mesh with `Blade` in its name. Loose on purpose: GLTFLoader strips
    // the `.` out of `Blade.001`, so the exported names never arrive intact.
    if (/Blade/i.test(node.name)) blades.push(node);
    else if (node.name === 'Socket') socketNode = node;
  });
  if (blades.length === 0) console.warn('[DroneRig] no Blade* meshes found — the rotors will not spin');
  if (!socketNode) console.warn('[DroneRig] no Socket mesh found — rounds will leave from the centre');

  // Measure the whole airframe, blades and marker included — the span the
  // editor asks for is the visible one, and the sphere is inside it anyway.
  _box.setFromObject(scene);
  _box.getSize(_size);
  _box.getCenter(_centre);
  const measuredSpan = Math.max(_size.x, _size.z) || 1;
  const scale = span / measuredSpan;
  const height = _size.y * scale;

  // Wrap rather than mutate: the glTF nodes keep their own transforms (the
  // blade pivots depend on them) and the wrapper does the normalising. From
  // here on a world position read off any node *is* a rig-space position,
  // because the wrapper has no parent.
  const source = new Group();
  source.name = 'DroneAirframe';
  source.scale.setScalar(scale);
  source.position.set(-_centre.x * scale, -_centre.y * scale, -_centre.z * scale);
  source.add(scene);
  source.updateMatrixWorld(true);

  // The socket is a marker, not a part: measure it, then take it out of the
  // draw entirely. Removing rather than hiding, so no warm-up pass can ever
  // flick it back on.
  let socket = null;
  if (socketNode) {
    socket = socketNode.getWorldPosition(new Vector3());
    socketNode.parent?.remove(socketNode);
    socketNode.geometry?.dispose();
  }

  // In order round the hub, so that "every other one" in the list is every
  // other one in space — which is what counter-rotation needs.
  const bladeInfo = blades
    .map((node) => ({
      name: node.name,
      position: node.getWorldPosition(new Vector3())
    }))
    .sort((a, b) => Math.atan2(a.position.x, a.position.z) - Math.atan2(b.position.x, b.position.z));

  // How long a blade is, for the blur disc: half its longest side, in rig
  // metres since it is measured through the wrapper.
  let bladeRadius = 0.3;
  if (blades.length) {
    _box.setFromObject(blades[0]);
    _box.getSize(_size);
    bladeRadius = Math.max(_size.x, _size.z) * 0.5;
  }

  const socketRig = socket ?? new Vector3(0, 0, 0.3 * span);

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

  return {
    source,
    blades: bladeInfo,
    socket: socketRig,
    bladeRadius,
    height,
    span
  };
}
