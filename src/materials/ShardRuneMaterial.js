import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The ground rune — layer 1 of the Corrupted Shard Spawn, the mark the
 * crystals are drawn up through.
 *
 * One quad on the floor, everything in it a signed distance field, and every
 * dimension in **metres from the centre** rather than in quad space — the same
 * decision the nature sigil hangs off, for the same reason: drag the footprint
 * while the spawn is standing and the rune re-scales around it with its
 * strokes the same physical width and the same number of glyphs per metre of
 * arc. In quad space it would read as a texture being zoomed.
 *
 * ## What is actually drawn
 *
 * The sheet's first panel is a *geometer's* circle where the growth's was a
 * gardener's: no filigree, no wander, everything true. Outward from the middle:
 * a hub, six spokes, a **hexagram** inscribed in the mid rail with a hexagon
 * through its points and a small circle on each of them, the inner rail, a
 * band of generated glyphs, and a **doubled** outer rail with graduations. The
 * whole thing turns slowly one way and the star turns the other.
 *
 * ## Aliasing
 *
 * A floor full of thin bright rings seen at a grazing angle is a bolt of white
 * speckle unless every band's width is floored at the pixel footprint and its
 * brightness scaled by how far it was widened, and unless the fine detail —
 * glyphs, ticks, grain — fades out as one pixel outgrows it. Both are here;
 * `rail()` is the function that matters.
 */

const RUNE_VERTEX = /* glsl */ `
  varying vec2  vUv;
  varying float vViewZ;

  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const RUNE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;
  uniform float uRadius;
  uniform float uGrown;
  uniform float uFront;
  uniform float uFade;
  uniform float uSeed;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uPulse;
  uniform float uCharge;

  uniform float uRailWidth;
  uniform float uRailOuter;
  uniform float uRailTwin;
  uniform float uRailInner;
  uniform float uRailMid;
  uniform float uRailHub;
  uniform float uRailGlow;
  uniform float uSpin;

  uniform float uGlyphs;
  uniform float uGlyphBand;
  uniform float uGlyphSeat;
  uniform float uGlyphWeight;
  uniform float uGlyphStrokes;
  uniform float uGlyphSweep;
  uniform float uGlyphSweepSpeed;
  uniform float uGlyphSweepWidth;
  uniform float uGlyphFlicker;
  uniform float uGlyphGlow;

  uniform float uStar;
  uniform float uStarWidth;
  uniform float uStarSpin;
  uniform float uHex;
  uniform float uOrbits;
  uniform float uOrbitRadius;
  uniform float uSpokes;
  uniform float uSpokeWidth;
  uniform float uSpokeGlow;
  uniform float uTicks;
  uniform float uTickCount;
  uniform float uTickWidth;
  uniform float uTickLength;

  uniform float uWash;
  uniform float uWashFalloff;
  uniform float uGrain;
  uniform float uGrainScale;

  uniform vec3  uColorLine;
  uniform vec3  uColorCore;
  uniform vec3  uColorGlyph;
  uniform vec3  uColorWash;
  uniform vec3  uColorFront;

  uniform float uGlobalGlow;

  varying vec2  vUv;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  #define RTAU 6.283185307179586
  #define RPI  3.141592653589793

  /**
   * A band around a circle, antialiased and energy conserving: the width is
   * floored at the pixel footprint and the brightness scaled back by however
   * far it had to open, so a rail seen edge-on gets wider and dimmer instead of
   * breaking into sparks.
   */
  float rail(float r, float radius, float width, float aa) {
    float w = max(width, aa);
    return (1.0 - smoothstep(0.0, w, abs(r - radius))) * (width / w);
  }

  /** A line of a given width, from a signed distance. Same energy rule. */
  float stroke(float d, float width, float aa) {
    float w = max(width, aa);
    return (1.0 - smoothstep(0.0, w, abs(d))) * (width / w);
  }

  /** Distance to the outline of a regular n-gon of apothem a, in polar. */
  float polygonEdge(float r, float ang, float sides, float apothem, float rot) {
    float sector = RTAU / max(sides, 3.0);
    float a = mod(ang - rot + sector * 0.5, sector) - sector * 0.5;
    return abs(r * cos(a) - apothem);
  }

  /** Distance from p to the segment ab. */
  float segment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
  }

  /**
   * One generated glyph in a cell running -0.5..0.5 on both axes: a subset of
   * a nine-stroke alphabet, each stroke kept or dropped on its own hash of the
   * cell's id. Angular where the growth's script was round — these are cut,
   * not grown — so the bowl is dropped and a second pair of diagonals added.
   */
  float glyph(vec2 p, float id, float weight) {
    float keep = clamp(uGlyphStrokes, 0.0, 1.0);
    float d = 1e3;

    if (hash11(id * 1.7 + 0.11) < keep + 0.25) d = min(d, segment(p, vec2(0.0, -0.42), vec2(0.0, 0.42)));
    if (hash11(id * 2.3 + 0.27) < keep) d = min(d, segment(p, vec2(-0.3, -0.36), vec2(-0.3, 0.18)));
    if (hash11(id * 3.1 + 0.43) < keep) d = min(d, segment(p, vec2(0.3, -0.18), vec2(0.3, 0.36)));
    if (hash11(id * 4.7 + 0.59) < keep) d = min(d, segment(p, vec2(-0.32, 0.26), vec2(0.32, 0.26)));
    if (hash11(id * 5.3 + 0.71) < keep) d = min(d, segment(p, vec2(-0.32, -0.26), vec2(0.32, -0.26)));
    if (hash11(id * 6.1 + 0.83) < keep) d = min(d, segment(p, vec2(-0.3, -0.3), vec2(0.0, 0.05)));
    if (hash11(id * 7.9 + 0.97) < keep) d = min(d, segment(p, vec2(0.3, 0.3), vec2(0.0, -0.05)));
    if (hash11(id * 8.3 + 1.13) < keep) d = min(d, segment(p, vec2(-0.28, 0.34), vec2(0.08, 0.0)));
    if (hash11(id * 9.7 + 1.31) < keep * 0.8) d = min(d, segment(p, vec2(0.28, -0.34), vec2(-0.08, 0.0)));

    return 1.0 - smoothstep(weight * 0.5, weight, d);
  }

  void main() {
    // Metres from the centre. Everything below is in metres.
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float r = length(p);
    float ang = atan(p.y, p.x);

    float aa = fwidth(r) + 1e-4;
    float footprint = max(fwidth(p.x), fwidth(p.y));
    float detail = 1.0 - smoothstep(0.02, 0.16, footprint);

    float outer = uRadius * uRailOuter;
    if (r > outer + aa * 6.0 + 0.5) discard;

    // Cut out of the floor as the front races to the boundary.
    float open = 1.0 - smoothstep(uGrown - 0.3, uGrown + 0.12, r);
    if (open < 0.002) discard;

    float beat = 1.0 + uPulse + uCharge * 0.6;
    float spin = uTime * uSpin * RTAU;

    /* ---- the rails ---- */
    float lines = 0.0;
    lines += rail(r, outer, uRailWidth, aa) * uRailGlow;
    lines += rail(r, uRadius * uRailTwin, uRailWidth * 0.6, aa) * uRailGlow * 0.8;
    lines += rail(r, uRadius * uRailInner, uRailWidth * 1.4, aa) * uRailGlow;
    lines += rail(r, uRadius * uRailMid, uRailWidth * 0.8, aa) * uRailGlow * 0.85;
    lines += rail(r, uRadius * uRailHub, uRailWidth * 1.1, aa) * uRailGlow;

    /* ---- graduations on the outer rail ---- */
    float tickPhase = fract((ang + spin) / RTAU * max(uTickCount, 1.0));
    float tickMask = 1.0 - smoothstep(uTickWidth * 0.5, uTickWidth, abs(tickPhase - 0.5) * 2.0);
    float tickBand = rail(r, outer - uRadius * uTickLength * 0.5, uRadius * uTickLength * 0.5, aa);
    lines += tickMask * tickBand * uTicks * detail;

    /* ---- the spokes, hub to inner rail ---- */
    {
      float sides = max(floor(uSpokes), 1.0);
      float sector = RTAU / sides;
      // Offset half a sector off the star's points, so the spokes run between
      // them rather than through them.
      float a = mod(ang - spin + sector * 0.5, sector) - sector * 0.5;
      float d = abs(sin(a)) * r;
      float span = smoothstep(uRadius * uRailHub, uRadius * uRailHub + 0.1, r) *
                   (1.0 - smoothstep(uRadius * uRailInner - 0.1, uRadius * uRailInner, r));
      lines += stroke(d, uSpokeWidth, aa) * span * uSpokeGlow;
    }

    /* ---- the hexagram, the hexagon through its points, the orbits ---- */
    {
      float R = uRadius * uRailMid;
      float rot = uTime * uStarSpin * RTAU;
      // A triangle of circumradius R has apothem R/2.
      float triA = polygonEdge(r, ang, 3.0, R * 0.5, rot);
      float triB = polygonEdge(r, ang, 3.0, R * 0.5, rot + RPI / 3.0);
      float star = stroke(min(triA, triB), uStarWidth, aa);
      star *= 1.0 - smoothstep(R * 0.97, R * 1.03, r);
      lines += star * uStar;

      // The hexagon has the star's six points as its corners: apothem R cos 30.
      float hex = stroke(polygonEdge(r, ang, 6.0, R * 0.8660254, rot + RPI / 6.0), uStarWidth * 0.7, aa);
      hex *= 1.0 - smoothstep(R * 0.99, R * 1.04, r);
      lines += hex * uHex;

      // A small circle on each point.
      float sector = RTAU / 6.0;
      float a = mod(ang - rot - RPI / 6.0 + sector * 0.5, sector) - sector * 0.5;
      // Back to cartesian in the sector's own frame: the point sits at (R, 0).
      vec2 q = vec2(r * cos(a) - R, r * sin(a));
      float orbit = rail(length(q), uRadius * uOrbitRadius, uStarWidth * 0.8, aa);
      lines += orbit * uOrbits;
    }

    /* ---- the glyph band ---- */
    float band = uRadius * uGlyphSeat;
    float bandHalf = uGlyphBand * 0.5;
    float inBand = step(abs(r - band), bandHalf);
    float glyphs = 0.0;
    if (inBand > 0.5 && detail > 0.01) {
      float cells = max(floor(uGlyphs), 1.0);
      float around = fract((ang + spin) / RTAU) * cells;
      float id = floor(around) + uSeed * 17.0;
      float cellWidth = RTAU * band / cells;
      vec2 q = vec2((fract(around) - 0.5) * cellWidth / max(uGlyphBand, 1e-3), (r - band) / uGlyphBand);
      glyphs = glyph(q, id, uGlyphWeight);

      float head = fract((ang + spin) / RTAU - uTime * uGlyphSweepSpeed);
      head = 1.0 - smoothstep(0.0, max(uGlyphSweepWidth, 1e-3), min(head, 1.0 - head));
      float flicker = 1.0 - uGlyphFlicker * hash11(floor(id) + floor(uTime * 7.0) * 0.37);
      glyphs *= flicker * (1.0 + head * uGlyphSweep);
      glyphs *= detail;
    }

    /* ---- the wash of light inside it all ---- */
    float wash = pow(clamp(1.0 - r / max(uRadius, 0.05), 0.0, 1.0), max(uWashFalloff, 0.05)) * uWash;
    float grain = (snoise01(vec3(p * uGrainScale, uSeed * 3.0 + uTime * 0.2)) - 0.5) * uGrain;
    wash *= 1.0 + grain * detail;
    // The hub fills as the beam winds up: the floor under the light is lit by it.
    wash += (1.0 - smoothstep(0.0, uRadius * uRailHub * 1.6, r)) * uCharge * 1.4;

    /* ---- the front racing out to the boundary ---- */
    float front = (1.0 - smoothstep(0.0, 0.5, abs(r - uGrown))) * uFront;

    /* ---- put it together ---- */
    vec3 color = mix(uColorLine, uColorCore, clamp(lines * 0.35, 0.0, 1.0)) * lines * beat;
    color += uColorGlyph * glyphs * uGlyphGlow * beat;
    color += uColorWash * wash * beat;
    color += uColorFront * front * 2.4;

    float alpha = clamp(lines * 0.85 + glyphs * 0.9 + wash + front, 0.0, 1.0);
    alpha *= open * uFade * uOpacity;
    if (alpha < 0.004) discard;

    color *= uGlow * uGlobalGlow;
    // The soft ceiling every additive pass here ends on: the terms above are
    // independent and stack, and a glyph on a rail in the wash sums past ten.
    color /= 1.0 + color * 0.16;

    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The rune. An ability-owned mesh rather than a pooled decal, because a decal
 * captures its radius when it spawns and this one re-scales under `zoneRadius`
 * while the spawn is already standing.
 */
export function createShardRuneMaterial() {
  const material = new ShaderMaterial({
    name: 'ShardRune',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuadSize: { value: 10 },
      uRadius: { value: 3.6 },
      uGrown: { value: 0 },
      uFront: { value: 0 },
      uFade: { value: 1 },
      uSeed: { value: 0 },
      uOpacity: { value: 1 },
      uGlow: { value: 1 },
      uPulse: { value: 0 },
      uCharge: { value: 0 },

      uRailWidth: { value: 0.03 },
      uRailOuter: { value: 1.0 },
      uRailTwin: { value: 0.955 },
      uRailInner: { value: 0.84 },
      uRailMid: { value: 0.6 },
      uRailHub: { value: 0.15 },
      uRailGlow: { value: 1.8 },
      uSpin: { value: 0.018 },

      uGlyphs: { value: 42 },
      uGlyphBand: { value: 0.27 },
      uGlyphSeat: { value: 0.905 },
      uGlyphWeight: { value: 0.055 },
      uGlyphStrokes: { value: 0.55 },
      uGlyphSweep: { value: 1.6 },
      uGlyphSweepSpeed: { value: 0.17 },
      uGlyphSweepWidth: { value: 0.1 },
      uGlyphFlicker: { value: 0.28 },
      uGlyphGlow: { value: 2.4 },

      uStar: { value: 1.1 },
      uStarWidth: { value: 0.028 },
      uStarSpin: { value: -0.011 },
      uHex: { value: 0.7 },
      uOrbits: { value: 0.9 },
      uOrbitRadius: { value: 0.1 },
      uSpokes: { value: 6 },
      uSpokeWidth: { value: 0.018 },
      uSpokeGlow: { value: 0.65 },
      uTicks: { value: 0.8 },
      uTickCount: { value: 60 },
      uTickWidth: { value: 0.3 },
      uTickLength: { value: 0.05 },

      uWash: { value: 0.34 },
      uWashFalloff: { value: 2.0 },
      uGrain: { value: 0.5 },
      uGrainScale: { value: 2.4 },

      uColorLine: { value: new Color() },
      uColorCore: { value: new Color() },
      uColorGlyph: { value: new Color() },
      uColorWash: { value: new Color() },
      uColorFront: { value: new Color() }
    }),
    vertexShader: RUNE_VERTEX,
    fragmentShader: RUNE_FRAGMENT
  });

  /** @param {object} state { radius, quadSize, grown, front, pulse, charge, fade, seed } */
  material.userData.sync = (state) => {
    const c = settings.shard;
    const g = settings.global;
    const u = material.uniforms;

    u.uQuadSize.value = state.quadSize;
    u.uRadius.value = state.radius;
    u.uGrown.value = state.grown;
    u.uFront.value = state.front;
    u.uPulse.value = state.pulse * c.pulseDepth;
    u.uCharge.value = state.charge;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uRailWidth.value = c.runeRailWidth;
    u.uRailOuter.value = c.runeRailOuter;
    u.uRailTwin.value = c.runeRailTwin;
    u.uRailInner.value = c.runeRailInner;
    u.uRailMid.value = c.runeRailMid;
    u.uRailHub.value = c.runeRailHub;
    u.uRailGlow.value = c.runeRailGlow * g.shaderIntensity;
    u.uSpin.value = c.runeSpin;

    u.uGlyphs.value = Math.max(1, Math.round(c.runeGlyphs));
    u.uGlyphBand.value = c.runeGlyphBand;
    u.uGlyphSeat.value = c.runeGlyphSeat;
    u.uGlyphWeight.value = c.runeGlyphWeight;
    u.uGlyphStrokes.value = c.runeGlyphStrokes;
    u.uGlyphSweep.value = c.runeGlyphSweep;
    u.uGlyphSweepSpeed.value = c.runeGlyphSweepSpeed;
    u.uGlyphSweepWidth.value = c.runeGlyphSweepWidth;
    u.uGlyphFlicker.value = c.runeGlyphFlicker * g.randomness;
    u.uGlyphGlow.value = c.runeGlyphGlow * g.shaderIntensity;

    u.uStar.value = c.runeStar * g.shaderIntensity;
    u.uStarWidth.value = c.runeStarWidth;
    u.uStarSpin.value = c.runeStarSpin;
    u.uHex.value = c.runeHex * g.shaderIntensity;
    u.uOrbits.value = c.runeOrbits * g.shaderIntensity;
    u.uOrbitRadius.value = c.runeOrbitRadius;
    u.uSpokes.value = Math.max(1, Math.round(c.runeSpokes));
    u.uSpokeWidth.value = c.runeSpokeWidth;
    u.uSpokeGlow.value = c.runeSpokeGlow * g.shaderIntensity;
    u.uTicks.value = c.runeTicks;
    u.uTickCount.value = Math.max(1, Math.round(c.runeTickCount));
    u.uTickWidth.value = c.runeTickWidth;
    u.uTickLength.value = c.runeTickLength;

    u.uWash.value = c.runeWash;
    u.uWashFalloff.value = c.runeWashFalloff;
    u.uGrain.value = c.runeGrain * g.noiseStrength;
    u.uGrainScale.value = c.runeGrainScale * g.noiseFrequency;
    u.uOpacity.value = c.runeOpacity * g.opacity;
    u.uGlow.value = c.runeGlow * g.glow;

    u.uColorLine.value.copy(getColor(c.colorRune));
    u.uColorCore.value.copy(getColor(c.colorRuneCore));
    u.uColorGlyph.value.copy(getColor(c.colorGlyph));
    u.uColorWash.value.copy(getColor(c.colorRuneWash));
    u.uColorFront.value.copy(getColor(c.colorRuneFront));
  };

  return material;
}
