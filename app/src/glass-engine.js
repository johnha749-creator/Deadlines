/*!
 * glass-engine.js
 * ----------------------------------------------------------------------------
 * One WebGL context that paints an animated, wind-swept painted background
 * (with drifting cherry-blossom petals) on a fixed full-viewport canvas, and
 * Apple-style "liquid glass" surfaces for every DOM element marked
 * [data-glass]. Plain script, no dependencies, no build step:
 *   <script src="src/glass-engine.js"></script>  ->  window.GlassEngine
 *
 * Glass shading adapted from liquid-glass-js by dashersw, MIT License.
 *   https://github.com/dashersw/liquid-glass-js
 * Kept from its container.js / button.js shaders: rounded / pill / circle
 * shape SDFs and detection, edge / rim / base / corner / ripple refraction,
 * the white-to-grey tint gradient, the sampled row gradient and the raised
 * (nested) gradient. Changed: one shared context, a live scene instead of an
 * html2canvas snapshot, a blur pyramid instead of 13x13 loops, an SDF normal
 * for rounded rects, rim light and interaction states.
 *
 * liquid-glass-js license:
 *   MIT License
 *   Copyright (c) 2025 Armagan Amcalar
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the
 *   "Software"), to deal in the Software without restriction, including
 *   without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to permit
 *   persons to whom the Software is furnished to do so, subject to the
 *   following conditions:
 *
 *   The above copyright notice and this permission notice shall be included
 *   in all copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 *   OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 *   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
 *   NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 *   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 *   USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * Frame: 1) scene = wind-displaced painting + petals -> texture (graded);
 * 2) blur pyramid (1/2 res, ~css/5, ~css/20 for the intro); 3) every visible
 * [data-glass] element is drawn into a slot of the default framebuffer, then
 * drawImage()d into its own <canvas class="glass-canvas"> so DOM stacking
 * stays right; 4) the scene is drawn full-screen as the visible background.
 * ----------------------------------------------------------------------------
 */
(function (root) {
  'use strict';

  /* ==== Constants and small helpers ==== */
  var MAX_PETALS = 96;
  var REF_PX = 900; // library refraction units (snapshot UV) -> CSS px
  var STYLE_ID = 'glass-engine-css';
  // Performance tiers: petal share, glass refresh period (frames), scene
  // resolution scale, glass resolution scale.
  var TIERS = [
    { petals: 1.00, every: 1, scene: 1.00, glass: 1.00 },
    { petals: 0.75, every: 1, scene: 0.80, glass: 1.00 },
    { petals: 0.55, every: 2, scene: 0.65, glass: 0.85 },
    { petals: 0.35, every: 3, scene: 0.50, glass: 0.70 }
  ];
  // Look defaults per data-glass kind (overridden by --glass-* CSS properties).
  var KINDS = {
    button:  { tint: [1, 1, 1, 0.16], frost: 0.30, refr: 1.0, rim: 1.0 },
    chip:    { tint: [1, 1, 1, 0.20], frost: 0.45, refr: 0.9, rim: 0.9 },
    bar:     { tint: [1, 1, 1, 0.24], frost: 0.75, refr: 1.0, rim: 0.9 },
    panel:   { tint: [1, 1, 1, 0.34], frost: 0.90, refr: 0.8, rim: 0.8 },
    divider: { tint: [1, 1, 1, 0.55], frost: 1.00, refr: 0.0, rim: 1.0 }
  };
  // Wind-only frames are capped at MAX_FPS, and at IDLE_FPS (with glass
  // refreshed every 2nd frame) once nobody has touched the page for IDLE_MS.
  var MAX_FPS = 60, IDLE_FPS = 30, IDLE_MS = 3000;
  var EVENTS = ['pointerover', 'pointerout', 'pointerdown', 'pointerup', 'pointercancel', 'focusin', 'focusout',
    'keydown', 'keyup', 'transitionend', 'animationend'];
  var CSS_TEXT =
    '[data-glass]{isolation:isolate}' +
    '.glass-host-pos{position:relative}' +
    '.glass-canvas{position:absolute;left:0;top:0;width:100%;height:100%;' +
    'border-radius:inherit;pointer-events:none;z-index:-1;display:block;' +
    'margin:0;padding:0;border:0;background:none}';

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function luma(c) { return c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114; }
  function now() { return performance.now(); }

  // Parse any CSS colour (rgba(), #hex, hsl(), names...) via a 2D context.
  var colorCtx = null;
  function parseColor(str) {
    str = (str || '').trim();
    if (!str) return null;
    if (!colorCtx) colorCtx = document.createElement('canvas').getContext('2d');
    colorCtx.fillStyle = '#010203';
    colorCtx.fillStyle = str;
    var v = String(colorCtx.fillStyle);
    if (v === '#010203' && str.toLowerCase() !== '#010203') return null;
    if (v[0] === '#') {
      return [parseInt(v.substr(1, 2), 16) / 255, parseInt(v.substr(3, 2), 16) / 255, parseInt(v.substr(5, 2), 16) / 255, 1];
    }
    var m = v.match(/-?[\d.]+(e-?\d+)?/g);
    if (!m || m.length < 3) return null;
    var k = /^color\(/.test(v) ? 1 : 255;
    return [m[0] / k, m[1] / k, m[2] / k, m.length > 3 ? +m[3] : 1];
  }

  var focusVisibleOK = true;
  function matchesSafe(el, sel) {
    if (sel === ':focus-visible' && !focusVisibleOK) return false;
    try { return el.matches(sel); } catch (e) { if (sel === ':focus-visible') focusVisibleOK = false; return false; }
  }

  function injectCSS() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS_TEXT;
    var head = document.head || document.documentElement;
    head.insertBefore(s, head.firstChild); // first, so host rules win ties
  }

  /* ==== Shaders ==== */
  var PREC = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';

  var VS_QUAD =
    'attribute vec2 a_pos; varying vec2 v_uv;' +
    'void main(){ v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }';

  // Colour grade shared by scene + petals. u_grade = (dim, warmth, unused)
  var GLSL_GRADE = [
    'uniform vec3 u_grade;',
    'vec3 grade(vec3 c, vec2 s){', // s = screen uv, y down
    'float dim = u_grade.x, w = u_grade.y;',
    'c *= vec3(1.0 + 0.10 * w, 1.0 + 0.015 * w, 1.0 - 0.12 * w);',
    'float l = dot(c, vec3(0.299, 0.587, 0.114));',
    'c = mix(c, vec3(l), 0.22 * dim);',
    'vec3 dusk = mix(vec3(0.62, 0.55, 0.92), vec3(1.0, 0.72, 0.62), smoothstep(0.0, 0.9, s.y));',
    'c = mix(c, c * dusk, 0.75 * dim);',
    'vec2 q = s - 0.5;',
    'c *= (1.0 - 0.5 * dim) * (1.0 - dim * 0.55 * dot(q, q));',
    'return c;',
    '}'
  ].join('\n');

  var GLSL_NOISE = [
    'float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }',
    'float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    'return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }'
  ].join('\n');

  // Scene: cover-fitted painting displaced by wind. Mask R = sway, G = clouds,
  // B = blossom canopy. Displacement is in CSS px and low-frequency in space
  // and time so it reads as a calm breeze, never as water.
  var FS_SCENE = PREC + [
    'uniform sampler2D u_img; uniform sampler2D u_mask;',
    'uniform vec2 u_vp; uniform float u_time; uniform float u_wind;',
    'uniform vec3 u_gust;', // front (screen x 0..1), amplitude, half-width
    'uniform vec4 u_xf;', // screen uv -> texture uv (scale.xy, offset.zw)
    'varying vec2 v_uv;',
    GLSL_NOISE, GLSL_GRADE,
    'void main(){',
    'vec2 s = vec2(v_uv.x, 1.0 - v_uv.y);',
    'vec2 px = s * u_vp;',
    'vec2 tuv = s * u_xf.xy + u_xf.zw;',
    'vec3 m = texture2D(u_mask, tuv).rgb;',
    'vec2 d = vec2(0.0);',
    'if (u_wind > 0.0 && m.r + m.g + m.b > 0.004) {', // still areas skip the noise
    'float t = u_time;',
    'float gx = (s.x + (s.y - 0.5) * 0.18 - u_gust.x) / u_gust.z;',
    'float g = u_gust.y * exp(-gx * gx);',
    // grass / foliage: waves travelling left -> right, gusts lean it further
    'vec2 q = px / 95.0;',
    'float n1 = vnoise(q * vec2(0.55, 1.0) - vec2(t * 0.36, 0.0));',
    'float n2 = vnoise(q * 1.6 + vec2(-t * 0.62, t * 0.09) + 17.0);',
    'float sway = n1 * 0.65 + n2 * 0.35 - 0.5;',
    'd.x += m.r * (1.5 * sway + g * (1.6 + 1.4 * sway));',
    'd.y += m.r * 0.45 * (n2 - 0.5) * (1.0 + g);',
    // blossom canopy: larger clumps, slower sway
    'float c1 = vnoise(px / 170.0 - vec2(t * 0.21, t * 0.03));',
    'float c2 = vnoise(px / 85.0 + vec2(-t * 0.37, 3.0));',
    'd += m.b * vec2((c1 - 0.5) * 2.0 + (c2 - 0.5) * 0.7 + 1.6 * g, (c2 - 0.5) * 0.7);',
    // clouds: very slow morph and drift
    'vec2 cn = vec2(vnoise(px / 260.0 + vec2(t * 0.03, 1.3)), vnoise(px / 260.0 + vec2(5.2, -t * 0.025))) - 0.5;',
    'd += m.g * (cn * 6.0 + vec2(sin(t * 0.045) * 2.5, 0.0));',
    'd *= u_wind;',
    '}',
    'vec3 col = texture2D(u_img, tuv - (d / u_vp) * u_xf.xy).rgb;',
    'gl_FragColor = vec4(grade(col, s), 1.0);',
    '}'
  ].join('\n');

  // Petals: soft SDF cherry petal on a CPU-built quad (rotation + foreshortening)
  var VS_PETAL =
    'attribute vec2 a_pos; attribute vec2 a_uv; attribute vec3 a_p;' +
    'uniform vec2 u_vp; varying vec2 v_uv; varying vec3 v_p; varying vec2 v_s;' +
    'void main(){ v_uv = a_uv; v_p = a_p; v_s = a_pos / u_vp;' +
    'gl_Position = vec4(v_s.x * 2.0 - 1.0, 1.0 - v_s.y * 2.0, 0.0, 1.0); }';
  var FS_PETAL = PREC + [
    'varying vec2 v_uv; varying vec3 v_p; varying vec2 v_s;', // v_p = shade, alpha, edge softness
    GLSL_GRADE,
    'void main(){',
    'vec2 p = v_uv;',
    'float w = 0.92 * (0.70 + 0.30 * (p.y * 0.5 + 0.5));', // narrower at the base
    'float e = length(vec2(p.x / w, p.y / 0.96)) - 1.0;',
    'float notch = 0.2 - length(vec2(p.x * 1.25, p.y - 0.99));', // small notch at the tip
    'float dd = max(e, notch);',
    'float a = (1.0 - smoothstep(-v_p.z, v_p.z, dd)) * v_p.y;',
    'if (a < 0.003) discard;',
    'vec3 c = mix(vec3(0.93, 0.55, 0.68), vec3(1.0, 0.86, 0.91), smoothstep(-0.95, 0.7, p.y));',
    'c = mix(c, vec3(1.0, 0.96, 0.97), 0.35 * smoothstep(-0.35, 0.0, dd));',
    'c = grade(c * v_p.x, v_s);',
    'gl_FragColor = vec4(c * a, a);',
    '}'
  ].join('\n');

  // 4-tap bilinear box downsample
  var FS_DOWN = PREC + [
    'uniform sampler2D u_tex; uniform vec2 u_tx; varying vec2 v_uv;',
    'void main(){',
    'gl_FragColor = 0.25 * (texture2D(u_tex, v_uv + u_tx * vec2(-1.0, -1.0)) + texture2D(u_tex, v_uv + u_tx * vec2(1.0, -1.0))',
    '+ texture2D(u_tex, v_uv + u_tx * vec2(-1.0, 1.0)) + texture2D(u_tex, v_uv + u_tx));',
    '}'
  ].join('\n');

  // 9-tap Gaussian in 5 fetches (linear-sampling trick); u_dir = texel * spread
  var FS_BLUR = PREC + [
    'uniform sampler2D u_tex; uniform vec2 u_dir; varying vec2 v_uv;',
    'void main(){',
    'vec3 c = texture2D(u_tex, v_uv).rgb * 0.2270270;',
    'c += (texture2D(u_tex, v_uv + u_dir * 1.3846154).rgb + texture2D(u_tex, v_uv - u_dir * 1.3846154).rgb) * 0.3162162;',
    'c += (texture2D(u_tex, v_uv + u_dir * 3.2307692).rgb + texture2D(u_tex, v_uv - u_dir * 3.2307692).rgb) * 0.0702703;',
    'gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');

  // Blur-level lookup shared by present + glass: s in [0,3] blends
  // sharp -> light -> frost -> intro blur.
  var GLSL_LEVELS = [
    'uniform sampler2D u_s0; uniform sampler2D u_s1; uniform sampler2D u_s2; uniform sampler2D u_s3;',
    'uniform vec2 u_intro;', // (blur level 0..3, brightness lift 0..1)
    'vec3 lvl(vec2 uv, float s){',
    'vec3 a = texture2D(u_s0, uv).rgb;',
    'if (s <= 0.001) return a;',
    'vec3 b = texture2D(u_s1, uv).rgb;',
    'if (s <= 1.0) return mix(a, b, s);',
    'vec3 c = texture2D(u_s2, uv).rgb;',
    'if (s <= 2.0) return mix(b, c, s - 1.0);',
    'return mix(c, texture2D(u_s3, uv).rgb, s - 2.0);',
    '}',
    'vec3 lift(vec3 c){',
    'float l = dot(c, vec3(0.299, 0.587, 0.114));',
    'return mix(mix(c, vec3(l), 0.15 * u_intro.y), vec3(1.0), 0.10 * u_intro.y);',
    '}'
  ].join('\n');

  var FS_PRESENT = PREC + [
    'varying vec2 v_uv;', GLSL_LEVELS,
    'void main(){ gl_FragColor = vec4(lift(lvl(v_uv, u_intro.x)), 1.0); }'
  ].join('\n');

  // Liquid glass, adapted from liquid-glass-js (container.js / button.js).
  var FS_GLASS = PREC + [
    'varying vec2 v_uv;', GLSL_LEVELS,
    'uniform vec2 u_vp;',
    'uniform vec4 u_rect;', // element box in viewport CSS px (x, y, w, h)
    'uniform vec4 u_clip;', // rendered part, relative to the element (x, y, w, h)
    'uniform float u_radius; uniform float u_shape; uniform float u_kind; uniform float u_q;',
    'uniform vec4 u_tint;', // rgb + amount
    'uniform vec4 u_look;', // frost, refraction, rim, raised
    'uniform vec4 u_state;', // hover, press, focus, selected (eased 0..1)
    'uniform float u_libGrad;', // strength of the library tint gradient
    'vec2 tuv(vec2 px){ return vec2(px.x / u_vp.x, 1.0 - px.y / u_vp.y); }',
    // Signed distance (negative inside, CSS px) + outward normal.
    // u_shape: 0 rounded rect, 1 pill (capsule), 2 circle -- detection as in the library.
    'float shapeSD(vec2 p, vec2 size, out vec2 n){',
    'vec2 c = size * 0.5; vec2 d = p - c;',
    'if (u_shape > 1.5) {',
    'float l = length(d); n = l > 0.0 ? d / l : vec2(0.0, -1.0);',
    'return l - min(size.x, size.y) * 0.5;',
    '}',
    'float r = u_shape > 0.5 ? min(size.x, size.y) * 0.5 : u_radius;',
    'vec2 q = abs(d) - (c - r);',
    'vec2 sg = vec2(d.x < 0.0 ? -1.0 : 1.0, d.y < 0.0 ? -1.0 : 1.0);',
    'if (q.x > 0.0 && q.y > 0.0) n = sg * normalize(q);',
    'else n = q.x > q.y ? vec2(sg.x, 0.0) : vec2(0.0, sg.y);',
    'return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;',
    '}',
    'void main(){',
    'vec2 size = u_rect.zw;',
    'vec2 p = u_clip.xy + vec2(v_uv.x, 1.0 - v_uv.y) * u_clip.zw;',
    'vec2 coord = p / size;',
    'vec2 n; float sd = shapeSD(p, size, n);',
    'float aa = 0.75 / u_q;',
    'float mask = 1.0 - smoothstep(-aa, aa, sd);',
    'if (mask <= 0.0) { gl_FragColor = vec4(0.0); return; }',
    'float hover = u_state.x, press = u_state.y, focus = u_state.z, sel = u_state.w;',
    'float dIn = max(-sd, 0.0);',
    'float minDim = max(min(size.x, size.y), 1.0);',
    'vec3 col;',
    'if (u_kind > 0.5) {',
    // divider: a thin glass rod, fading out at both ends
    'float along = size.x >= size.y ? coord.x : coord.y;',
    'mask *= smoothstep(0.0, 0.12, along) * smoothstep(1.0, 0.88, along);',
    'col = lvl(tuv(u_rect.xy + p), max(2.0, u_intro.x)) * 1.08;',
    'col = mix(col, u_tint.rgb, u_tint.a);',
    'col = mix(col, vec3(1.0), 0.18 * u_look.z * (1.0 + hover));',
    '} else {',
    // --- refraction: liquid-glass-js edge / rim / base / corner / ripple terms
    'float k = 1.0 - 0.35 * press;',
    'float edgeI = exp(-dIn * 0.15 * k);',
    'float rimI = exp(-dIn * 0.8 * k);',
    'float total = 0.01 * edgeI + 0.05 * rimI;', // base (warp) term off, as library default
    'float cx = min(coord.x, 1.0 - coord.x), cy = min(coord.y, 1.0 - coord.y);',
    'float corner = exp(-max(cx, cy) * minDim * 0.3) * 0.02;',
    'vec2 perp = vec2(-n.y, n.x);',
    'float ripple = sin(dIn / minDim * 25.0) * 0.1 * rimI;',
    'vec2 refr = (n * (total + corner) + perp * ripple) * ' + REF_PX.toFixed(1) +
    '* u_look.y * (1.0 + 0.3 * hover + 0.2 * press);',
    'vec2 pc = size * 0.5 + (p - size * 0.5) * (1.0 - 0.025 * press);', // pressed: slight squash
    'float s = max(u_look.x * 2.0 * (1.0 - 0.55 * edgeI), u_intro.x);', // clearer at the rim so the bend reads
    'col = lvl(tuv(u_rect.xy + pc + refr), s);',
    // library tint: white->grey vertical gradient, then sampled row gradient
    'col = mix(col, mix(vec3(1.0), vec3(0.7), coord.y), u_libGrad);',
    'vec3 tc = vec3(0.0), mc = vec3(0.0), bc = vec3(0.0);',
    'for (int i = 0; i < 3; i++) {',
    'float fx = u_rect.x + size.x * (0.15 + 0.35 * float(i));',
    'tc += texture2D(u_s2, tuv(vec2(fx, u_rect.y + size.y * 0.1))).rgb;',
    'mc += texture2D(u_s2, tuv(vec2(fx, u_rect.y + size.y * 0.5))).rgb;',
    'bc += texture2D(u_s2, tuv(vec2(fx, u_rect.y + size.y * 0.9))).rgb;',
    '}',
    'float gp = clamp((coord.y - 0.1) / 0.8, 0.0, 1.0);',
    'vec3 sg = gp < 0.5 ? mix(tc, mc, gp * 2.0) : mix(mc, bc, gp * 2.0 - 1.0);',
    'col = mix(col, sg / 3.0, u_libGrad * 0.3);',
    // raised (nested) glass: button.js top-light / bottom-shade gradient
    'col *= mix(1.0, mix(1.08, 0.92, coord.y), u_look.w);',
    // host tint (--glass-tint), selection and interaction
    'col = mix(col, u_tint.rgb, clamp(u_tint.a * (1.0 + 0.25 * u_look.w) + 0.10 * sel, 0.0, 1.0));',
    'col += vec3(0.045) * hover;',
    'col *= 1.0 - 0.08 * press;',
    // rim light: thin specular line, strongest facing the upper-left light
    'float facing = dot(n, vec2(-0.55, -0.835));',
    'float line = exp(-dIn / max(1.1 / u_q, 0.8));',
    'float glow = exp(-dIn / 7.0);',
    'float rimS = u_look.z * (1.0 + 0.8 * hover + 0.3 * sel + 0.25 * u_look.w);',
    'float spec = line * (0.2 + 0.6 * pow(max(facing, 0.0), 2.0) + 0.3 * pow(max(-facing, 0.0), 2.0))',
    '+ glow * 0.12 * max(facing, 0.0);',
    'col = mix(col, vec3(1.0), clamp(spec * rimS, 0.0, 0.9));',
    'col *= 1.0 - 0.08 * glow * max(n.y, 0.0) * u_look.z;', // faint inner shade at the bottom
    'col = mix(col, vec3(1.0), focus * 0.6 * exp(-dIn / 2.2));', // focus ring
    '}',
    'col = lift(col);',
    'gl_FragColor = vec4(col * mask, mask);',
    '}'
  ].join('\n');

  /* ==== WebGL helpers ==== */
  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      throw new Error('[GlassEngine] shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }
  function makeProgram(gl, vs, fs, attribs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    attribs.forEach(function (a, i) { gl.bindAttribLocation(p, i, a); });
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error('[GlassEngine] link: ' + gl.getProgramInfoLog(p));
    }
    var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(p, i);
      u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    return { p: p, u: u };
  }
  function makeTexture(gl) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function makeTarget(gl, w, h) {
    var tex = makeTexture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    var fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex: tex, fb: fb, w: w, h: h };
  }
  function freeTarget(gl, t) { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); } }

  /* ==== Engine ==== */
  function Engine(o) {
    this.canvas = o.canvas;
    this.images = o.images || {};
    this.masks = o.masks || {};
    this.meta = o.meta || {};
    this.maxDpr = o.maxDpr || 1.5;
    this.allowSoftware = !!o.allowSoftware;
    this.adaptive = o.adaptive !== false;
    this.tier = clamp(o.tier | 0, 0, TIERS.length - 1);
    this.motion = o.motion !== undefined ? !!o.motion
      : !(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.items = [];
    this.map = new Map();
    this.petals = [];
    this._time = rnd(20, 200); // random wind phase
    this._gust = { t0: -1, dur: 1, amp: 0, next: this._time + rnd(1.5, 4), front: -1, a: 0, w: 0.3 };
    this._grade = { dim: 0, warmth: 0 };
    this._gradeTarget = { dim: 0, warmth: 0 };
    this._intro = null;
    this._introLevel = 0;
    this._running = false;
    this._raf = 0;
    this._last = 0;
    this._frameNo = 0;
    this._activeAt = now();
    this._idle = false;
    this._dirty = true;
    this._sceneDirty = true;
    this._forceGlass = true;
    this._pdb = !!o.preserveDrawingBuffer;
    this._tested = false;
    this._ema = 16.7; this._cpu = 0; this._slowSince = 0; this._fastSince = 0;
    this._upWait = 6000; this._lastUp = -1e9; this._lastTierChange = 0;
    this._glassCount = 0;
    this._pv = new Float32Array(MAX_PETALS * 4 * 7);
    this._frame = this._frame.bind(this);
    this._onLost = this._onLost.bind(this);
    this._onRestored = this._onRestored.bind(this);
    injectCSS();
    this._setupGL();
    this._bindEvents();
    this.refresh();
  }

  var E = Engine.prototype;

  /* ---- GL setup ---- */
  E._setupGL = function () {
    var gl = this.canvas.getContext('webgl', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: this._pdb, powerPreference: 'default',
      failIfMajorPerformanceCaveat: !this.allowSoftware
    });
    if (!gl) throw new Error('[GlassEngine] WebGL context unavailable');
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', this._onLost, false);
    this.canvas.addEventListener('webglcontextrestored', this._onRestored, false);
    this._createResources();
  };

  E._createResources = function () {
    var gl = this.gl;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    var A = ['a_pos'];
    this.P = {
      scene: makeProgram(gl, VS_QUAD, FS_SCENE, A),
      petal: makeProgram(gl, VS_PETAL, FS_PETAL, ['a_pos', 'a_uv', 'a_p']),
      down: makeProgram(gl, VS_QUAD, FS_DOWN, A),
      blur: makeProgram(gl, VS_QUAD, FS_BLUR, A),
      present: makeProgram(gl, VS_QUAD, FS_PRESENT, A),
      glass: makeProgram(gl, VS_QUAD, FS_GLASS, A)
    };
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.pvbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pvbo);
    gl.bufferData(gl.ARRAY_BUFFER, this._pv.byteLength, gl.DYNAMIC_DRAW);
    var idx = new Uint16Array(MAX_PETALS * 6);
    for (var i = 0; i < MAX_PETALS; i++) {
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    this.pibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.pibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    this.T = {};
    this.baseTex = makeTexture(gl);
    this.maskTex = makeTexture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this._ready = false;
    this._baseInfo = null;
    this._sizeKey = '';
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
  };

  E._onLost = function (e) {
    e.preventDefault();
    this._lost = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  };
  E._onRestored = function () {
    this._lost = false;
    try { this._createResources(); } catch (err) { console.warn(err); return; }
    this._forceGlass = this._sceneDirty = true;
    this.invalidate();
  };

  // Recreate the canvas with preserveDrawingBuffer:true (used only if the
  // same-task drawImage copy turns out not to work on this browser).
  E._switchToPDB = function () {
    var old = this.canvas, c = old.cloneNode(false);
    old.removeEventListener('webglcontextlost', this._onLost);
    old.removeEventListener('webglcontextrestored', this._onRestored);
    var lose = this.gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext(); // free the old context's GPU memory
    if (old.parentNode) old.parentNode.replaceChild(c, old);
    this.canvas = c;
    this._pdb = true;
    this._setupGL();
    this._forceGlass = this._sceneDirty = true;
  };

  /* ---- events ---- */
  E._bindEvents = function () {
    var self = this;
    this._inv = function () { self._activeAt = now(); self.invalidate(); };
    this._onResize = function () { self._sizeKey = ''; self.invalidate(); };
    this._onVis = function () {
      if (document.hidden) {
        if (self._raf) cancelAnimationFrame(self._raf);
        self._raf = 0;
      } else { self._last = 0; self._ema = 16.7; self._slowSince = self._fastSince = 0; self.invalidate(); }
    };
    this._onTheme = function () { self._restyleAll(); };
    root.addEventListener('resize', this._onResize);
    document.addEventListener('scroll', this._inv, { capture: true, passive: true });
    document.addEventListener('visibilitychange', this._onVis);
    EVENTS.forEach(function (t) { document.addEventListener(t, self._inv, { capture: true, passive: true }); });
    if (root.matchMedia) {
      this._mq = root.matchMedia('(prefers-color-scheme: dark)');
      if (this._mq.addEventListener) this._mq.addEventListener('change', this._onTheme);
    }
    // DOM changes: rescan on added/removed nodes (ignoring our own canvases),
    // re-render on aria/class/style changes, restyle on <html> theme changes.
    if (root.MutationObserver) {
      this._mo = new MutationObserver(function (list) {
        for (var i = 0; i < list.length; i++) {
          var m = list[i];
          if (m.type === 'childList') {
            if (!onlyOurs(m.addedNodes) || !onlyOurs(m.removedNodes)) self._needScan = true;
          } else if (m.attributeName === 'data-glass') self._needScan = true;
        }
        self.invalidate();
      });
      this._mo.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['data-glass', 'aria-pressed', 'aria-selected', 'class', 'style', 'hidden', 'open']
      });
      this._moTheme = new MutationObserver(this._onTheme);
      this._moTheme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    }
    function onlyOurs(nodes) {
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!(n.nodeType === 1 && n.classList.contains('glass-canvas')) && n.nodeType !== 3) return false;
      }
      return true;
    }
  };

  /* ---- DOM scan ---- */
  E.refresh = function () {
    if (this._failed) return this;
    var found = document.querySelectorAll('[data-glass]');
    var live = new Set();
    for (var i = 0; i < found.length; i++) live.add(found[i]);
    var self = this;
    this.items.forEach(function (rec) { if (!live.has(rec.el) || !rec.el.isConnected) self._detach(rec); });
    var list = [];
    for (var j = 0; j < found.length; j++) {
      var el = found[j], rec = this.map.get(el);
      if (!rec) rec = this._attach(el);
      this._readStyle(rec);
      list.push(rec);
    }
    this.items = list;
    this._needScan = false;
    this._forceGlass = true;
    this.invalidate();
  };

  E._attach = function (el) {
    var c = null;
    for (var k = el.firstElementChild; k; k = k.nextElementSibling) {
      if (k.classList.contains('glass-canvas')) { c = k; break; }
    }
    if (!c) {
      c = document.createElement('canvas');
      c.className = 'glass-canvas';
      c.setAttribute('aria-hidden', 'true');
      c.width = c.height = 1;
      el.insertBefore(c, el.firstChild);
    }
    var rec = {
      el: el, canvas: c, ctx: c.getContext('2d'), st: [0, 0, 0, 0], needs: true, last: '', styleKey: ''
    };
    this.map.set(el, rec);
    return rec;
  };

  E._detach = function (rec) {
    this.map.delete(rec.el);
    if (rec.canvas.parentNode) rec.canvas.parentNode.removeChild(rec.canvas);
    rec.el.classList.remove('glass-host-pos');
  };

  E._readStyle = function (rec) {
    var el = rec.el, cs = getComputedStyle(el);
    var kind = (el.getAttribute('data-glass') || 'panel').trim().toLowerCase();
    var def = KINDS[kind] || KINDS.panel;
    var num = function (name, d) { var v = parseFloat(cs.getPropertyValue(name)); return isFinite(v) ? v : d; };
    rec.kind = kind;
    rec.tint = parseColor(cs.getPropertyValue('--glass-tint')) || def.tint;
    rec.frost = clamp(num('--glass-frost', def.frost), 0, 1);
    rec.refr = Math.max(0, num('--glass-refraction', def.refr));
    rec.rim = Math.max(0, num('--glass-rim', def.rim));
    rec.libGrad = (luma(rec.tint) < 0.45 && rec.tint[3] > 0.15) ? 0.05 : 0.2;
    var r0 = (cs.borderTopLeftRadius || '0').split(' ')[0];
    rec.rPct = /%$/.test(r0) ? parseFloat(r0) : -1;
    rec.rPx = parseFloat(r0) || 0;
    rec.raised = el.parentElement && el.parentElement.closest('[data-glass]') ? 1 : 0;
    rec.bl = parseFloat(cs.borderLeftWidth) || 0; rec.bt = parseFloat(cs.borderTopWidth) || 0;
    rec.bw = rec.bl + (parseFloat(cs.borderRightWidth) || 0);
    rec.bh = rec.bt + (parseFloat(cs.borderBottomWidth) || 0);
    if (cs.position === 'static') el.classList.add('glass-host-pos');
    rec.needs = true;
    rec.styleKey = '';
  };

  E._restyleAll = function () {
    for (var i = 0; i < this.items.length; i++) this._readStyle(this.items[i]);
    this._forceGlass = true;
    this.invalidate();
  };

  /* ---- sizing + background texture ---- */
  E._checkSize = function () {
    var c = this.canvas;
    var W = c.clientWidth || root.innerWidth, H = c.clientHeight || root.innerHeight;
    var dpr = Math.min(root.devicePixelRatio || 1, this.maxDpr);
    var key = W + 'x' + H + '@' + dpr + '#' + this.tier;
    if (key === this._sizeKey) return;
    this._sizeKey = key;
    var gl = this.gl, tier = TIERS[this.tier];
    this.W = W; this.H = H; this.dpr = dpr;
    var CW = Math.max(1, Math.round(W * dpr)), CH = Math.max(1, Math.round(H * dpr));
    if (c.width !== CW) c.width = CW;
    if (c.height !== CH) c.height = CH;
    this.CW = CW; this.CH = CH;
    var SW = Math.max(1, Math.round(CW * tier.scene)), SH = Math.max(1, Math.round(CH * tier.scene));
    this._scenePx = SW / W; // scene px per CSS px
    var T = this.T;
    ['scene', 'h0', 'h1', 'q0', 'q1', 's0', 's1'].forEach(function (k) { freeTarget(gl, T[k]); });
    var L1w = Math.ceil(SW / 2), L1h = Math.ceil(SH / 2);
    var L2w = Math.max(8, Math.min(L1w, Math.ceil(W / 5))), L2h = Math.max(8, Math.min(L1h, Math.ceil(H / 5)));
    var L3w = Math.max(4, Math.ceil(W / 20)), L3h = Math.max(4, Math.ceil(H / 20));
    T.scene = makeTarget(gl, SW, SH);
    T.h0 = makeTarget(gl, L1w, L1h); T.h1 = makeTarget(gl, L1w, L1h);
    T.q0 = makeTarget(gl, L2w, L2h); T.q1 = makeTarget(gl, L2w, L2h);
    T.s0 = makeTarget(gl, L3w, L3h); T.s1 = makeTarget(gl, L3w, L3h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._glassQ = Math.min(1.25, root.devicePixelRatio || 1) * tier.glass;
    this._prepBackground();
    this._sceneDirty = this._forceGlass = true;
    for (var i = 0; i < this.items.length; i++) this.items[i].needs = true;
  };

  // Cover-fit crop of an image around a focus point, in image pixels.
  function coverCrop(iw, ih, W, H, f) {
    var s = Math.max(W / iw, H / ih), cw = W / s, ch = H / s;
    var fx = f && isFinite(f.x) ? f.x : 0.5, fy = f && isFinite(f.y) ? f.y : 0.5;
    return { x: clamp(fx * iw - cw / 2, 0, iw - cw), y: clamp(fy * ih - ch / 2, 0, ih - ch), w: cw, h: ch, iw: iw, ih: ih };
  }
  function imgReady(img) { return !!(img && img.complete && (img.naturalWidth || img.width)); }

  // Builds viewport-sized background + mask textures (resampled on a 2D
  // canvas so the GPU never minifies the painting -> no shimmer under wind).
  // During live resizes the old texture is re-mapped through u_xf and the
  // expensive rebuild is debounced.
  E._prepBackground = function () {
    var key = (this.W / this.H < 0.8) ? 'tall' : 'wide';
    var img = this.images[key] || this.images.wide || this.images.tall;
    var mask = this.masks[key] || (key === 'tall' ? this.masks.wide : this.masks.tall);
    var self = this;
    var wait = function (im, onLoad) {
      if (!im || im._glassWait) return;
      im._glassWait = true;
      im.addEventListener('load', function () { im._glassWait = false; onLoad(); }, { once: true });
      if (onLoad === again) im.addEventListener('error', function () { self._fail('background image failed to load'); }, { once: true });
    };
    var again = function () { self._sizeKey = ''; self.invalidate(); };
    if (!imgReady(img)) {
      if (!img || (img.complete && img.src)) this._fail('background image missing or broken'); else wait(img, again);
      return;
    }
    if (mask && !imgReady(mask)) wait(mask, function () { self._baseInfo = null; again(); });
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    var meta = this.meta[key] || this.meta.wide || {};
    var crop = coverCrop(iw, ih, this.W, this.H, meta.focus);
    this._crop = crop;
    this._spawns = (meta.petal_spawns || []).map(function (p) {
      return { x: (p.x * iw - crop.x) / crop.w * self.W, y: (p.y * ih - crop.y) / crop.h * self.H, r: (p.r || 0.03) * iw / crop.w * self.W };
    }).filter(function (p) { return p.x > -p.r && p.x < self.W + p.r && p.y > -p.r && p.y < self.H + p.r; });
    this._layoutPetals();
    var info = this._baseInfo;
    if (info && info.img === img && info.CW === this.CW && Math.abs(info.crop.x - crop.x) < 0.5 &&
        Math.abs(info.crop.y - crop.y) < 0.5 && Math.abs(info.crop.w - crop.w) < 0.5 && Math.abs(info.crop.h - crop.h) < 0.5) {
      this._xf = [1, 1, 0, 0]; // same crop: keep the texture
    } else if (info && info.img === img) {
      // remap the existing texture now, rebuild a moment later
      this._xf = [crop.w / info.crop.w, crop.h / info.crop.h, (crop.x - info.crop.x) / info.crop.w, (crop.y - info.crop.y) / info.crop.h];
      clearTimeout(this._prepTimer);
      this._prepTimer = setTimeout(function () { self._uploadBackground(img, mask, self._crop); }, 160);
    } else {
      this._uploadBackground(img, mask, crop);
    }
  };

  E._uploadBackground = function (img, mask, crop) {
    if (this._lost) return;
    var gl = this.gl, mt = this.maxTex;
    var bw = Math.min(this.CW, Math.ceil(crop.w), mt);
    var bh = Math.min(mt, Math.max(1, Math.round(bw * crop.h / crop.w)));
    var cv = this._prepCanvas || (this._prepCanvas = document.createElement('canvas'));
    var cx = cv.getContext('2d');
    try {
      cv.width = bw; cv.height = bh;
      cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
      cx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, bw, bh);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.bindTexture(gl.TEXTURE_2D, this.baseTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
      if (imgReady(mask)) {
        var mw = mask.naturalWidth || mask.width, mh = mask.naturalHeight || mask.height;
        var sx = mw / crop.iw, sy = mh / crop.ih;
        cv.width = Math.max(1, Math.ceil(bw / 4)); cv.height = Math.max(1, Math.ceil(bh / 4));
        cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
        cx.drawImage(mask, crop.x * sx, crop.y * sy, crop.w * sx, crop.h * sy, 0, 0, cv.width, cv.height);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      }
      cv.width = cv.height = 1; // release the scratch memory
    } catch (err) {
      // tainted canvas: cross-origin image, or a file:// page without file access
      this._fail('background image could not be uploaded (' + (err && err.name) + ')');
      return;
    }
    this._baseInfo = { img: img, CW: this.CW, crop: { x: crop.x, y: crop.y, w: crop.w, h: crop.h } };
    var c = this._crop || crop;
    this._xf = [c.w / crop.w, c.h / crop.h, (c.x - crop.x) / crop.w, (c.y - crop.y) / crop.h];
    this._ready = true;
    this._sceneDirty = this._forceGlass = true;
    this.invalidate();
  };

  /* ---- wind + petals ---- */
  // Gusts: a soft bump of extra wind that sweeps left -> right every few seconds.
  E._updateGust = function () {
    var g = this._gust, t = this._time;
    if (g.t0 < 0 && t >= g.next) { g.t0 = t; g.dur = rnd(5.5, 8.5); g.amp = rnd(0.55, 1.0); }
    if (g.t0 >= 0) {
      var p = (t - g.t0) / g.dur;
      if (p >= 1) { g.t0 = -1; g.next = t + rnd(3.5, 9); g.a = 0; g.front = -1; return; }
      g.front = -0.4 + 1.8 * p;
      g.a = g.amp * Math.sin(Math.PI * p);
    }
  };
  E._gustAt = function (xn) {
    var g = this._gust;
    if (g.a <= 0) return 0;
    var d = (xn - g.front) / g.w;
    return g.a * Math.exp(-d * d);
  };

  E._petalTarget = function () {
    var area = clamp((this.W * this.H) / (1440 * 900), 0, 1);
    return Math.min(MAX_PETALS, Math.round((36 + 30 * area) * TIERS[this.tier].petals));
  };
  E._layoutPetals = function () {
    var want = this._petalTarget(), P = this.petals;
    var scatter = !this._petalsInit; // first fill: spread over the screen
    for (var i = 0; i < P.length; i++) P[i].retire = i >= want;
    while (P.length < want) P.push(this._spawn({}, scatter));
    this._petalsInit = true;
  };

  // (Re)spawn a petal: from the upwind (left) edge, the top edge, or a canopy point.
  E._spawn = function (p, scatter) {
    var W = this.W || 1, H = this.H || 1, sp = this._spawns || [];
    p.z = Math.pow(Math.random(), 1.4); // depth: 0 far .. 1 near
    p.size = 7 + 11 * p.z + rnd(-1, 1);
    p.rot = rnd(0, Math.PI * 2); p.spin = rnd(-0.7, 0.7);
    p.flip = rnd(0, Math.PI * 2); p.flipSpeed = rnd(1.3, 3.0) * (Math.random() < 0.5 ? -1 : 1);
    p.tiltPhase = rnd(0, 6.28); p.phase = rnd(0, 6.28);
    p.bob = rnd(1.1, 2.3); p.fall = rnd(8, 17);
    p.tone = rnd(0.9, 1.06);
    p.blur = p.z > 0.85 ? (p.z - 0.85) * 1.6 : 0;
    p.maxA = 0.72 + 0.28 * p.z;
    p.age = 0; p.retire = false;
    var r = Math.random();
    if (scatter) {
      p.x = rnd(0, W); p.y = rnd(0, H); p.age = 5;
    } else if (r < 0.32 && sp.length) {
      var s = sp[(Math.random() * sp.length) | 0], ang = rnd(0, 6.28), rr = Math.sqrt(Math.random()) * s.r;
      p.x = s.x + Math.cos(ang) * rr; p.y = s.y + Math.sin(ang) * rr * 0.6;
    } else if (r < 0.52) {
      p.x = rnd(-0.1, 0.75) * W; p.y = -16;
    } else {
      p.x = -16; p.y = rnd(-0.1, 0.85) * H;
    }
    return p;
  };

  E._updatePetals = function (dt) {
    var P = this.petals, W = this.W, H = this.H, t = this._time, keep = [];
    for (var i = 0; i < P.length; i++) {
      var p = P[i];
      var g = this._gustAt(p.x / W);
      var depth = 0.55 + 0.8 * p.z;
      var n = Math.sin(p.x * 0.0061 + t * 0.31 + Math.sin(p.y * 0.0047 - t * 0.23) * 1.7) * 0.5 + Math.sin(p.y * 0.0089 + t * 0.17) * 0.5;
      var vx = (24 + 9 * n + 46 * g) * depth + 8 * Math.cos(t * 0.7 + p.phase);
      var vy = (p.fall + 9 * Math.sin(t * p.bob + p.phase)) * depth - 7 * g;
      p.x += vx * dt; p.y += vy * dt;
      p.rot += p.spin * dt * (1 + g);
      p.flip += p.flipSpeed * dt * (1 + 0.8 * g);
      p.age += dt;
      var out = p.x > W + 30 || p.y > H + 30 || p.x < -60 || p.y < -60;
      if (out) {
        if (p.retire) continue;
        this._spawn(p, false);
      }
      keep.push(p);
    }
    this.petals = keep;
  };

  // Writes petal quads (pos, uv, shade/alpha/softness) into the vertex array.
  E._buildPetals = function () {
    var P = this.petals, d = this._pv, o = 0, k = 0, dpx = this._scenePx || 1;
    for (var i = 0; i < P.length && k < MAX_PETALS; i++) {
      var p = P[i];
      var a = p.maxA * clamp(p.age / 0.8, 0, 1);
      if (a <= 0.003) continue;
      var cf = Math.cos(p.flip), ct = Math.cos(p.flip * 0.63 + p.tiltPhase);
      var fy = Math.abs(cf) < 0.18 ? (cf < 0 ? -0.18 : 0.18) : cf;  // foreshortening along the petal
      var fx = Math.max(0.35, Math.abs(ct)); // and across it
      var hy = p.size * 0.5 * fy, hx = p.size * 0.36 * fx;
      var ca = Math.cos(p.rot), sa = Math.sin(p.rot);
      var shade = (cf < 0 ? 0.88 : 1.0) * (0.8 + 0.2 * Math.abs(cf * ct)) * p.tone;
      var soft = clamp(1.3 / (Math.min(hx, Math.abs(hy)) * dpx), 0.04, 0.7) + p.blur;
      for (var c = 0; c < 4; c++) {
        var ux = (c === 0 || c === 3) ? -1 : 1, uy = c < 2 ? -1 : 1;
        var lx = ux * hx, ly = uy * hy;
        d[o++] = p.x + lx * ca - ly * sa;
        d[o++] = p.y + lx * sa + ly * ca;
        d[o++] = ux; d[o++] = uy;
        d[o++] = shade; d[o++] = a; d[o++] = soft;
      }
      k++;
    }
    return k;
  };

  /* ---- render passes ---- */
  E._quad = function () {
    var gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(1);
    gl.disableVertexAttribArray(2);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  E._bindTex = function (unit, tex) {
    var gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  };

  E._renderScene = function () {
    var gl = this.gl, T = this.T, P = this.P.scene, u = P.u, gr = this._grade, g = this._gust;
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.scene.fb);
    gl.viewport(0, 0, T.scene.w, T.scene.h);
    gl.useProgram(P.p);
    this._bindTex(0, this.baseTex); gl.uniform1i(u.u_img, 0);
    this._bindTex(1, this.maskTex); gl.uniform1i(u.u_mask, 1);
    gl.uniform2f(u.u_vp, this.W, this.H);
    gl.uniform1f(u.u_time, this._time % 10000);
    gl.uniform1f(u.u_wind, 1);
    gl.uniform3f(u.u_gust, g.front, g.a, g.w);
    var xf = this._xf || [1, 1, 0, 0];
    gl.uniform4f(u.u_xf, xf[0], xf[1], xf[2], xf[3]);
    gl.uniform3f(u.u_grade, gr.dim, gr.warmth, 0);
    this._quad();
    // petals, premultiplied alpha over the painting
    var n = this._buildPetals();
    if (n) {
      var pp = this.P.petal;
      gl.useProgram(pp.p);
      gl.uniform2f(pp.u.u_vp, this.W, this.H);
      gl.uniform3f(pp.u.u_grade, gr.dim, gr.warmth, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pvbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._pv.subarray(0, n * 28));
      gl.enableVertexAttribArray(0); gl.enableVertexAttribArray(1); gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 28, 0);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 8);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 28, 16);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.pibo);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawElements(gl.TRIANGLES, n * 6, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.BLEND);
    }
  };

  // Downsample src -> dst then blur in place (dst -> tmp -> dst).
  E._blurLevel = function (src, dst, tmp, spread) {
    var gl = this.gl, d = this.P.down, b = this.P.blur;
    var ratio = src.w / dst.w, off = Math.max(1, ratio * 0.5 - 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.useProgram(d.p);
    this._bindTex(0, src.tex); gl.uniform1i(d.u.u_tex, 0);
    gl.uniform2f(d.u.u_tx, off / src.w, off / src.h);
    this._quad();
    gl.useProgram(b.p);
    gl.uniform1i(b.u.u_tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, tmp.fb);
    this._bindTex(0, dst.tex);
    gl.uniform2f(b.u.u_dir, spread / dst.w, 0);
    this._quad();
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    this._bindTex(0, tmp.tex);
    gl.uniform2f(b.u.u_dir, 0, spread / dst.h);
    this._quad();
  };

  E._renderBlur = function (withIntro) {
    var T = this.T;
    this._blurLevel(T.scene, T.h0, T.h1, 1.0);
    this._blurLevel(T.h0, T.q0, T.q1, 1.6);
    if (withIntro) this._blurLevel(T.q0, T.s0, T.s1, 1.8);
  };

  E._bindLevels = function (prog) {
    var gl = this.gl, T = this.T, u = prog.u, lv = this._introLevel;
    this._bindTex(0, T.scene.tex); gl.uniform1i(u.u_s0, 0);
    this._bindTex(1, T.h0.tex); gl.uniform1i(u.u_s1, 1);
    this._bindTex(2, T.q0.tex); gl.uniform1i(u.u_s2, 2);
    this._bindTex(3, lv > 2 ? T.s0.tex : T.q0.tex); gl.uniform1i(u.u_s3, 3);
    gl.uniform2f(u.u_intro, lv, lv / 3);
  };

  E._present = function () {
    var gl = this.gl, P = this.P.present;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.CW, this.CH);
    gl.useProgram(P.p);
    this._bindLevels(P);
    this._quad();
  };

  /* ---- glass pass ---- */
  // Eases hover/press/focus/selected. Returns true while still animating.
  E._easeState = function (rec, dt) {
    var el = rec.el, st = rec.st;
    var dis = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    var tg0 = !dis && matchesSafe(el, ':hover') ? 1 : 0;
    var tg1 = !dis && matchesSafe(el, ':active') ? 1 : 0;
    var tg2 = matchesSafe(el, ':focus-visible') ? 1 : 0;
    var tg3 = (el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-selected') === 'true') ? 1 : 0;
    var tg = [tg0, tg1, tg2, tg3], rate = [11, 26, 14, 10], busy = false, changed = false;
    for (var i = 0; i < 4; i++) {
      var v = st[i], d = tg[i] - v;
      if (d === 0) continue;
      v = Math.abs(d) < 0.004 ? tg[i] : v + d * (1 - Math.exp(-dt * rate[i]));
      if (v !== tg[i]) busy = true;
      st[i] = v; changed = true;
    }
    rec.changed = changed;
    return busy;
  };

  E._renderGlass = function (dt, sceneChanged) {
    var items = this.items, W = this.W, H = this.H, cr = this._cr;
    var every = this.motion ? Math.max(TIERS[this.tier].every, this._idle ? 2 : 1) : 1;
    var all = this._forceGlass || (sceneChanged && this._frameNo % every === 0);
    this._forceGlass = false;
    var M = Math.min(120, 0.15 * Math.max(W, H)), budget = 1.6e6;
    var jobs = [], busy = false, dead = false;
    for (var i = 0; i < items.length; i++) {
      var rec = items[i], el = rec.el;
      if (!el.isConnected) { dead = true; continue; }
      if (rec.canvas.parentNode !== el) { el.insertBefore(rec.canvas, el.firstChild); rec.needs = true; }
      if (this._easeState(rec, dt)) busy = true;
      var r = el.getBoundingClientRect();
      var x = r.left - cr.left, y = r.top - cr.top, w = r.width, h = r.height;
      if (w < 1 || h < 0.5 || x >= W || y >= H || x + w <= 0 || y + h <= 0) continue;
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      // visible part (+ margin so fast scrolling does not reveal an unrendered edge)
      var x0 = Math.max(x, -M), y0 = Math.max(y, -M), x1 = Math.min(x + w, W + M), y1 = Math.min(y + h, H + M);
      var cw = x1 - x0, ch = y1 - y0;
      var key = x.toFixed(1) + ',' + y.toFixed(1) + ',' + w.toFixed(1) + ',' + h.toFixed(1) + ',' + x0.toFixed(0) + ',' + y0.toFixed(0) +
        ',' + el.scrollLeft + ',' + el.scrollTop;
      if (!(all || rec.needs || rec.changed || key !== rec.last)) continue;
      rec.last = key; rec.needs = false;
      var q = Math.min(this._glassQ, this.CW / cw, this.CH / ch, Math.sqrt(budget / (cw * ch)));
      jobs.push({ rec: rec, x: x, y: y, w: w, h: h, cx: x0 - x, cy: y0 - y, cw: cw, ch: ch,
        gw: Math.max(1, Math.min(this.CW, Math.ceil(cw * q))), gh: Math.max(1, Math.min(this.CH, Math.ceil(ch * q))),
        clipped: cw < w - 0.5 || ch < h - 0.5 });
    }
    if (dead) this._prune();
    this._glassCount = jobs.length;
    if (!jobs.length) return busy;

    var gl = this.gl, P = this.P.glass, u = P.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(P.p);
    this._bindLevels(P);
    gl.uniform2f(u.u_vp, W, H);
    // shelf-pack jobs into the default framebuffer; copy out when it is full
    var px = 0, py = 0, rowH = 0, batch = [];
    for (var j = 0; j < jobs.length; j++) {
      var jb = jobs[j];
      if (px + jb.gw > this.CW) { px = 0; py += rowH; rowH = 0; }
      if (py + jb.gh > this.CH) { this._flush(batch); batch = []; px = 0; py = 0; rowH = 0; }
      jb.sx = px; jb.sy = py;
      px += jb.gw; rowH = Math.max(rowH, jb.gh);
      this._drawGlass(jb, u);
      batch.push(jb);
    }
    this._flush(batch);
    return busy;
  };

  E._drawGlass = function (jb, u) {
    var gl = this.gl, rec = jb.rec, w = jb.w, h = jb.h, st = rec.st;
    var mn = Math.min(w, h);
    var rad = rec.rPct >= 0 ? rec.rPct / 100 * mn : rec.rPx;
    rad = Math.min(rad, mn / 2);
    // library shape detection: circle = ~square with r = 50%, pill = r = half the short side
    var shape = 0;
    if (Math.abs(rad - mn / 2) < 1.5 && Math.abs(w - h) < 4) shape = 2;
    else if (Math.abs(rad - mn / 2) < 2) shape = 1;
    var t = rec.tint, kind = rec.kind === 'divider' ? 1 : 0;
    gl.viewport(jb.sx, jb.sy, jb.gw, jb.gh);
    gl.uniform4f(u.u_rect, jb.x, jb.y, w, h);
    gl.uniform4f(u.u_clip, jb.cx, jb.cy, jb.cw, jb.ch);
    gl.uniform1f(u.u_radius, rad);
    gl.uniform1f(u.u_shape, shape);
    gl.uniform1f(u.u_kind, kind);
    gl.uniform1f(u.u_q, jb.gw / jb.cw);
    gl.uniform4f(u.u_tint, t[0], t[1], t[2], t[3]);
    gl.uniform4f(u.u_look, rec.frost, rec.refr, rec.rim, rec.raised);
    gl.uniform4f(u.u_state, st[0], st[1], st[2], st[3]);
    gl.uniform1f(u.u_libGrad, rec.libGrad);
    this._quad();
  };

  // Copy rendered slots from the WebGL canvas into each element's 2D canvas.
  // All slots are drawn before any copy: Chromium snapshots the drawing buffer
  // once and reuses it for consecutive drawImage() calls (measured ~15x faster
  // than interleaving draw/copy per element).
  E._flush = function (batch) {
    var src = this.canvas, CH = this.CH, test = null;
    for (var i = 0; i < batch.length; i++) {
      var jb = batch[i], rec = jb.rec, c = rec.canvas;
      if (c.width !== jb.gw) c.width = jb.gw;
      if (c.height !== jb.gh) c.height = jb.gh;
      this._placeCanvas(jb);
      var ctx = rec.ctx;
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(src, jb.sx, CH - jb.sy - jb.gh, jb.gw, jb.gh, 0, 0, jb.gw, jb.gh);
      if (!this._tested && (!test || jb.gw * jb.gh > test.gw * test.gh) && rec.kind !== 'divider') test = jb;
    }
    if (test) this._selfTest(test);
  };

  // Positions the element's canvas over the rendered part (whole box normally).
  // Scroll offsets are added so a host that scrolls its own content (overflow:
  // auto) keeps the glass pinned to its box (one frame behind while scrolling).
  E._placeCanvas = function (jb) {
    var rec = jb.rec, el = rec.el, s = rec.canvas.style, sl = el.scrollLeft, st = el.scrollTop, key;
    if (!jb.clipped) {
      key = 'f' + sl + ',' + st;
      if (rec.styleKey === key) return;
      s.left = rec.bl || sl ? sl - rec.bl + 'px' : ''; s.top = rec.bt || st ? st - rec.bt + 'px' : '';
      s.width = rec.bw ? 'calc(100% + ' + rec.bw + 'px)' : '';
      s.height = rec.bh ? 'calc(100% + ' + rec.bh + 'px)' : '';
      s.borderRadius = '';
    } else {
      var sx = el.offsetWidth ? jb.w / el.offsetWidth : 1, sy = el.offsetHeight ? jb.h / el.offsetHeight : 1;
      var l = (jb.cx / sx - rec.bl + sl).toFixed(2), t = (jb.cy / sy - rec.bt + st).toFixed(2);
      var w = (jb.cw / sx).toFixed(2), h = (jb.ch / sy).toFixed(2);
      key = l + ',' + t + ',' + w + ',' + h;
      if (rec.styleKey === key) return;
      s.left = l + 'px'; s.top = t + 'px'; s.width = w + 'px'; s.height = h + 'px';
      s.borderRadius = '0';
    }
    rec.styleKey = key;
  };

  // One-time check that drawImage(webglCanvas) in the same task sees the
  // freshly drawn pixels; otherwise switch to preserveDrawingBuffer.
  E._selfTest = function (jb) {
    this._tested = true;
    if (this._pdb) return;
    try {
      var c = document.createElement('canvas'), x;
      c.width = c.height = 1;
      x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(this.canvas, jb.sx + (jb.gw >> 1), this.CH - jb.sy - jb.gh + (jb.gh >> 1), 1, 1, 0, 0, 1, 1);
      var d = x.getImageData(0, 0, 1, 1).data;
      if (d[3] === 0) {
        console.warn('[GlassEngine] canvas copy came back empty; using preserveDrawingBuffer');
        this._needPDB = true; // switched next frame
      }
    } catch (e) { /* ignore */ }
  };

  // Unrecoverable (e.g. tainted image): tear down and hand over to CSS glass.
  E._fail = function (why) {
    console.warn('[GlassEngine] falling back to CSS glass: ' + why);
    if (this._intro) this._intro.resolve();
    this._intro = null;
    this.destroy();
    this._failed = this.fallback = true;
    document.documentElement.classList.add('glass-fallback');
  };

  E._prune = function () {
    var self = this;
    this.items = this.items.filter(function (rec) {
      if (rec.el.isConnected) return true;
      self.map.delete(rec.el);
      return false;
    });
  };

  /* ---- frame loop ---- */
  E._schedule = function () {
    if (!this._raf && !this._lost && !document.hidden && this._running) this._raf = requestAnimationFrame(this._frame);
  };

  E._frame = function (ts) {
    this._raf = 0;
    if (!this._running || this._lost) return;
    var t0 = now();
    this._idle = t0 - this._activeAt > IDLE_MS;
    if (this.motion && !this._dirty && !this._intro && this._last &&
        ts - this._last < 1000 / (this._idle ? IDLE_FPS : MAX_FPS) - 2) { this._schedule(); return; }
    var raw = this._last ? ts - this._last : 16.7;
    var dt = Math.min(raw / 1000, 0.05);
    this._last = ts;
    this._dirty = false;
    if (this._needPDB) {
      this._needPDB = false;
      try { this._switchToPDB(); } catch (e) { console.warn(e); this.stop(); return; }
    }
    if (this._needScan) this.refresh();
    this._checkSize();
    if (!this._ready || this._failed) return; // image still loading (load re-invalidates)
    this._cr = this.canvas.getBoundingClientRect();
    this._frameNo++;
    if (this.motion) { this._time += dt; this._updateGust(); this._updatePetals(dt); }
    var anim = this._updateTransitions(dt, ts);
    var sceneChanged = this.motion || this._sceneDirty || anim;
    if (sceneChanged) {
      this._renderScene();
      this._renderBlur(this._introLevel > 2);
      this._sceneDirty = false;
    }
    var busy = this._renderGlass(dt, sceneChanged);
    this._present();
    this._cpu = this._cpu * 0.9 + (now() - t0) * 0.1;
    this._govern(raw, ts);
    if (this.motion || anim || busy || this._dirty) this._schedule();
  };

  // Grade easing + intro progress. Returns true while animating.
  E._updateTransitions = function (dt, ts) {
    var anim = false, g = this._grade, gt = this._gradeTarget, k = 1 - Math.exp(-dt * 5);
    ['dim', 'warmth'].forEach(function (n) {
      var d = gt[n] - g[n];
      if (Math.abs(d) > 0.002) { g[n] += d * k; anim = true; } else g[n] = gt[n];
    });
    var it = this._intro;
    if (it) {
      if (it.start === null) it.start = ts;
      var p = clamp((ts - it.start) / it.dur, 0, 1);
      var u = Math.pow(1 - p, 2.2); // ease-out
      this._introLevel = 3 * u;
      anim = true;
      if (p >= 1) { this._introLevel = 0; this._intro = null; this._forceGlass = true; it.resolve(); }
    }
    return anim;
  };

  // Performance governor: step down a tier when frames are slow for a while,
  // step back up after a sustained fast period (with back-off if it flaps).
  E._govern = function (raw, ts) {
    if (!this.motion || raw > 250 || this._idle) return; // idle frames are slow on purpose
    this._ema = this._ema * 0.93 + raw * 0.07;
    if (!this.adaptive || ts - this._lastTierChange < 1500) return;
    if (this._ema > 25) {
      if (!this._slowSince) this._slowSince = ts;
      if (ts - this._slowSince > 1200 && this.tier < TIERS.length - 1) {
        if (ts - this._lastUp < 10000) this._upWait = Math.min(this._upWait * 2, 60000);
        this._setTier(this.tier + 1, ts);
      }
    } else this._slowSince = 0;
    if (this._ema < 18.5) {
      if (!this._fastSince) this._fastSince = ts;
      if (ts - this._fastSince > this._upWait && this.tier > 0) { this._lastUp = ts; this._setTier(this.tier - 1, ts); }
    } else this._fastSince = 0;
  };
  E._setTier = function (n, ts) {
    this.tier = n;
    this._lastTierChange = ts || now();
    this._slowSince = this._fastSince = 0;
    this._ema = 16.7;
    this._sizeKey = ''; // rebuild targets at the new scale
  };

  /* ==== Public API ==== */
  E.start = function () {
    if (this._failed) return this;
    this._running = true; this._last = 0;
    return this.invalidate();
  };
  E.stop = function () {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    return this;
  };
  E.invalidate = function () { this._dirty = true; this._schedule(); return this; };

  E.playIntro = function (ms) {
    var self = this;
    if (this._failed) return Promise.resolve();
    if (this._intro) this._intro.resolve();
    return new Promise(function (resolve) {
      self._intro = { dur: Math.max(1, ms || 1800), start: null, resolve: resolve };
      self._introLevel = 3;
      self.invalidate();
    });
  };

  E.setGrade = function (g) {
    g = g || {};
    if (g.dim !== undefined) this._gradeTarget.dim = clamp(+g.dim || 0, 0, 1);
    if (g.warmth !== undefined) this._gradeTarget.warmth = clamp(+g.warmth || 0, -1, 1);
    if (g.instant) { this._grade.dim = this._gradeTarget.dim; this._grade.warmth = this._gradeTarget.warmth; }
    this._sceneDirty = this._forceGlass = true;
    return this.invalidate();
  };

  E.setMotion = function (on) {
    this.motion = !!on;
    this._last = 0;
    this._sceneDirty = this._forceGlass = true;
    return this.invalidate();
  };

  // Adds paintings / wind masks after create() (e.g. the other orientation's,
  // fetched only once the window changes shape) and rebuilds the background.
  E.addImages = function (images, masks) {
    var k;
    for (k in images || {}) this.images[k] = images[k];
    for (k in masks || {}) this.masks[k] = masks[k];
    this._sizeKey = '';
    return this.invalidate();
  };

  E.stats = function () {
    if (this._failed) return { fallback: true };
    return {
      tier: this.tier, frameMs: +this._ema.toFixed(2), fps: +(1000 / this._ema).toFixed(1), cpuMs: +this._cpu.toFixed(2),
      petals: this.petals.length, glass: this._glassCount, elements: this.items.length,
      motion: this.motion, preserveDrawingBuffer: this._pdb, ready: !!this._ready
    };
  };

  E.destroy = function () {
    this.stop();
    var self = this, gl = this.gl;
    root.removeEventListener('resize', this._onResize);
    document.removeEventListener('scroll', this._inv, { capture: true });
    document.removeEventListener('visibilitychange', this._onVis);
    EVENTS.forEach(function (t) { document.removeEventListener(t, self._inv, { capture: true }); });
    if (this._mq && this._mq.removeEventListener) this._mq.removeEventListener('change', this._onTheme);
    if (this._mo) this._mo.disconnect();
    if (this._moTheme) this._moTheme.disconnect();
    clearTimeout(this._prepTimer);
    this.items.forEach(function (rec) { self._detach(rec); });
    this.items = [];
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    if (gl && !gl.isContextLost()) {
      var T = this.T;
      Object.keys(T).forEach(function (k) { freeTarget(gl, T[k]); });
      [this.baseTex, this.maskTex].forEach(function (t) { gl.deleteTexture(t); });
      [this.quad, this.pvbo, this.pibo].forEach(function (b) { gl.deleteBuffer(b); });
      Object.keys(this.P).forEach(function (k) { gl.deleteProgram(self.P[k].p); });
    }
    var st = document.getElementById(STYLE_ID);
    if (st) st.parentNode.removeChild(st);
  };

  /* ==== Fallback stub (no WebGL): same API, lets CSS use backdrop-filter instead ==== */
  function Stub() {
    document.documentElement.classList.add('glass-fallback');
    this.fallback = true;
  }
  ['start', 'stop', 'refresh', 'invalidate', 'setGrade', 'setMotion', 'addImages'].forEach(function (m) {
    Stub.prototype[m] = function () { return this; };
  });
  Stub.prototype.playIntro = function () { return Promise.resolve(); };
  Stub.prototype.stats = function () { return { fallback: true }; };
  Stub.prototype.destroy = function () { document.documentElement.classList.remove('glass-fallback'); };

  /* ==== Factory ==== */
  var supportCache = {};
  var GlassEngine = {
    version: '1.0.0',
    // true when a usable WebGL context can be created. Software-rendered
    // WebGL (blocklisted GPU) counts as unsupported unless allowSoftware.
    supported: function (opts) {
      var soft = !!(opts && opts.allowSoftware);
      if (supportCache[soft] !== undefined) return supportCache[soft];
      var ok = false;
      try {
        var c = document.createElement('canvas');
        var gl = c.getContext('webgl', { failIfMajorPerformanceCaveat: !soft });
        ok = !!gl && (gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0) >= 2048;
        var lose = gl && gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } catch (e) { ok = false; }
      return (supportCache[soft] = ok);
    },
    create: function (opts) {
      opts = opts || {};
      if (!opts.canvas || !GlassEngine.supported(opts)) return new Stub();
      try { return new Engine(opts); } catch (e) {
        console.warn('[GlassEngine] falling back to CSS glass:', e && e.message);
        return new Stub();
      }
    }
  };

  root.GlassEngine = GlassEngine;
})(typeof window !== 'undefined' ? window : this);
