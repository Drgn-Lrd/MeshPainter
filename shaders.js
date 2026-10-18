/**
 * Per-face colouring without per-face vertex data: the mesh is drawn
 * non-indexed, so gl_VertexID / 3 is the face index. The face's filament is
 * looked up in a R8UI texture (one byte per face) and its colour in a palette
 * uniform. Flat normals come from screen-space derivatives.
 *
 * Face byte: bits 0-5 filament index (1-based, already resolved for unpainted
 * faces), bit 6 highlight, bit 7 subdivided (drawn by the overlay instead).
 */

export const PALETTE_SIZE = 34;

const SHADE = /* glsl */ `
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }
vec3 shade(vec3 srgb, vec3 view) {
  vec3 n = normalize(cross(dFdx(view), dFdy(view)));
  vec3 v = normalize(-view);
  if (dot(n, v) < 0.0) n = -n;
  vec3 base = toLinear(srgb);
  vec3 key = normalize(vec3(-0.45, 0.65, 0.6));
  float kd = max(dot(n, key), 0.0);
  float hd = max(dot(n, v), 0.0);
  float rim = pow(1.0 - hd, 3.0);
  vec3 h = normalize(key + v);
  float spec = pow(max(dot(n, h), 0.0), 40.0) * 0.12;
  vec3 c = base * (0.16 + 0.55 * kd + 0.38 * hd) + vec3(spec) + base * rim * 0.12;
  return toSrgb(c);
}
`;

export const meshVertex = /* glsl */ `
precision highp float;
precision highp int;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform int uFaceOffset;
in vec3 position;
flat out int vFace;
out vec3 vView;
void main() {
  vFace = uFaceOffset + gl_VertexID / 3;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

export const meshFragment = /* glsl */ `
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uState;
uniform int uTexW;
uniform vec3 uPalette[${PALETTE_SIZE}];
uniform int uHover;
uniform vec3 uHoverColor;
uniform vec3 uHighlightColor;
flat in int vFace;
in vec3 vView;
out vec4 outColor;
${SHADE}
void main() {
  uint s = texelFetch(uState, ivec2(vFace % uTexW, vFace / uTexW), 0).r;
  if ((s & 128u) != 0u) discard;
  vec3 col = shade(uPalette[int(s & 63u)], vView);
  if ((s & 64u) != 0u) col = mix(col, uHighlightColor, 0.55);
  if (vFace == uHover) col = mix(col, uHoverColor, 0.6);
  outColor = vec4(col, 1.0);
}
`;

export const pickFragment = /* glsl */ `
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uState;
uniform int uTexW;
flat in int vFace;
in vec3 vView;
out vec4 outColor;
void main() {
  uint s = texelFetch(uState, ivec2(vFace % uTexW, vFace / uTexW), 0).r;
  if ((s & 128u) != 0u) discard;
  uint id = uint(vFace + 1);
  outColor = vec4(float(id & 255u), float((id >> 8) & 255u), float((id >> 16) & 255u), float((id >> 24) & 255u)) / 255.0;
}
`;

export const overlayVertex = /* glsl */ `
precision highp float;
precision highp int;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
in float aColor;
in float aFace;
flat out int vColor;
flat out int vFace;
out vec3 vView;
void main() {
  vColor = int(aColor + 0.5);
  vFace = int(aFace + 0.5);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

export const overlayFragment = /* glsl */ `
precision highp float;
precision highp int;
uniform vec3 uPalette[${PALETTE_SIZE}];
uniform int uHover;
uniform vec3 uHoverColor;
flat in int vColor;
flat in int vFace;
in vec3 vView;
out vec4 outColor;
${SHADE}
void main() {
  vec3 col = shade(uPalette[vColor], vView);
  if (vFace == uHover) col = mix(col, uHoverColor, 0.35);
  outColor = vec4(col, 1.0);
}
`;

export const overlayPickFragment = /* glsl */ `
precision highp float;
precision highp int;
flat in int vColor;
flat in int vFace;
in vec3 vView;
out vec4 outColor;
void main() {
  uint id = uint(vFace + 1);
  outColor = vec4(float(id & 255u), float((id >> 8) & 255u), float((id >> 16) & 255u), float((id >> 24) & 255u)) / 255.0;
}
`;
