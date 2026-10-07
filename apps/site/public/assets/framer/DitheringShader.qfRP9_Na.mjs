import{t as e}from"./rolldown-runtime.Dh6celcD.mjs?br=12.0";import{b as t,o as n,s as r,w as i,y as a}from"./react.CKky1o2r.mjs?br=12.0";import{A as o,Y as s,n as c,o as l}from"./framer.ZMYI__yC.mjs?br=12.0";function u(e){let t=c(e);return[t.r/255,t.g/255,t.b/255,t.a]}function d(e,t,n){let r=e.createShader(t);return r?(e.shaderSource(r,n),e.compileShader(r),e.getShaderParameter(r,e.COMPILE_STATUS)?r:(console.error(`An error occurred compiling the shaders: `+e.getShaderInfoLog(r)),e.deleteShader(r),null)):null}function f(e,t,n){let r=d(e,e.VERTEX_SHADER,t),i=d(e,e.FRAGMENT_SHADER,n);if(!r||!i)return null;let a=e.createProgram();return a?(e.attachShader(a,r),e.attachShader(a,i),e.linkProgram(a),e.getProgramParameter(a,e.LINK_STATUS)?a:(console.error(`Unable to initialize the shader program: `+e.getProgramInfoLog(a)),e.deleteProgram(a),null)):null}function p(e){let{colorBack:r=`#000000`,colorFront:i=`#ffffff`,shape:o=`warp`,type:s=`8x8`,pxSize:c=4,speed:l=1}=e,d=t(null),p=t(),m=t(null),h=t(null),g=t({}),_=t(Date.now()),S=t(null);return a(()=>{let e=d.current,t=S.current;if(!e||!t)return;let n=e.getContext(`webgl2`);if(!n){console.error(`WebGL2 not supported`);return}h.current=n;let a=f(n,v,y);if(!a)return;m.current=a,g.current={u_time:n.getUniformLocation(a,`u_time`),u_resolution:n.getUniformLocation(a,`u_resolution`),u_colorBack:n.getUniformLocation(a,`u_colorBack`),u_colorFront:n.getUniformLocation(a,`u_colorFront`),u_shape:n.getUniformLocation(a,`u_shape`),u_type:n.getUniformLocation(a,`u_type`),u_pxSize:n.getUniformLocation(a,`u_pxSize`)};let C=n.getAttribLocation(a,`a_position`),w=n.createBuffer();n.bindBuffer(n.ARRAY_BUFFER,w),n.bufferData(n.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),n.STATIC_DRAW),n.enableVertexAttribArray(C),n.vertexAttribPointer(C,2,n.FLOAT,!1,0,0);let T=()=>{let t=(Date.now()-_.current)*.001*l,n=h.current,a=m.current;if(!n||!a)return;n.clear(n.COLOR_BUFFER_BIT),n.useProgram(a);let d=g.current;d.u_time&&n.uniform1f(d.u_time,t),d.u_resolution&&n.uniform2f(d.u_resolution,e.width,e.height),d.u_colorBack&&n.uniform4fv(d.u_colorBack,u(r)),d.u_colorFront&&n.uniform4fv(d.u_colorFront,u(i)),d.u_shape&&n.uniform1f(d.u_shape,b[o]),d.u_type&&n.uniform1f(d.u_type,x[s]),d.u_pxSize&&n.uniform1f(d.u_pxSize,c),n.drawArrays(n.TRIANGLES,0,6),l!==0&&(p.current=requestAnimationFrame(T))},E=new ResizeObserver(t=>{for(let r of t){let{width:t,height:i}=r.contentRect;e.width=t,e.height=i,n.viewport(0,0,t,i),l===0&&T()}});return E.observe(t),p.current=requestAnimationFrame(T),()=>{E.disconnect(),p.current&&cancelAnimationFrame(p.current),h.current&&m.current&&h.current.deleteProgram(m.current)}},[r,i,o,s,c,l]),n(`div`,{ref:S,style:{position:`relative`,width:`100%`,height:`100%`,overflow:`hidden`},children:n(`canvas`,{ref:d,style:{display:`block`,width:`100%`,height:`100%`}})})}var m,h,g,_,v,y,b,x,S=e((()=>{r(),i(),s(),m=`
#define TWO_PI 6.28318530718
#define PI 3.14159265358979323846
`,h=`
  float hash11(float p) {
    p = fract(p * 0.3183099) + 0.1;
    p *= p + 19.19;
    return fract(p * p);
  }
`,g=`
  float hash21(vec2 p) {
    p = fract(p * vec2(0.3183099, 0.3678794)) + 0.1;
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
  }
`,_=`
vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
    -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1;
  i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
    + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
      dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
`,v=`#version 300 es
precision mediump float;

layout(location = 0) in vec4 a_position;

void main() {
  gl_Position = a_position;
}
`,y=`#version 300 es
precision mediump float;

uniform float u_time;
uniform vec2 u_resolution;
uniform vec4 u_colorBack;
uniform vec4 u_colorFront;
uniform float u_shape;
uniform float u_type;
uniform float u_pxSize;

out vec4 fragColor;

${_}
${m}
${h}
${g}

float getSimplexNoise(vec2 uv, float t) {
  float noise = .5 * snoise(uv - vec2(0., .3 * t));
  noise += .5 * snoise(2. * uv + vec2(0., .32 * t));
  return noise;
}

const int bayer2x2[4] = int[4](0, 2, 3, 1);
const int bayer4x4[16] = int[16](
  0,  8,  2, 10,
 12,  4, 14,  6,
  3, 11,  1,  9,
 15,  7, 13,  5
);

const int bayer8x8[64] = int[64](
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21
);

float getBayerValue(vec2 uv, int size) {
  ivec2 pos = ivec2(mod(uv, float(size)));
  int index = pos.y * size + pos.x;

  if (size == 2) {
    return float(bayer2x2[index]) / 4.0;
  } else if (size == 4) {
    return float(bayer4x4[index]) / 16.0;
  } else if (size == 8) {
    return float(bayer8x8[index]) / 64.0;
  }
  return 0.0;
}

void main() {
  float t = .5 * u_time;
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  uv -= .5;
  
  // Apply pixelization
  float pxSize = u_pxSize;
  vec2 pxSizeUv = gl_FragCoord.xy;
  pxSizeUv -= .5 * u_resolution;
  pxSizeUv /= pxSize;
  vec2 pixelizedUv = floor(pxSizeUv) * pxSize / u_resolution.xy;
  pixelizedUv += .5;
  pixelizedUv -= .5;
  
  vec2 shape_uv = pixelizedUv;
  vec2 dithering_uv = pxSizeUv;
  vec2 ditheringNoise_uv = uv * u_resolution;

  float shape = 0.;
  if (u_shape < 1.5) {
    // Warp
    shape_uv *= .003;
    for (float i = 1.0; i < 6.0; i++) {
      shape_uv.x += 0.6 / i * cos(i * 2.5 * shape_uv.y + t);
      shape_uv.y += 0.6 / i * cos(i * 1.5 * shape_uv.x + t);
    }
    shape = .15 / abs(sin(t - shape_uv.y - shape_uv.x));
    shape = smoothstep(0.02, 1., shape);

  } else if (u_shape < 2.5) {
    // Sine wave
    shape_uv *= 4.;
    float wave = cos(.5 * shape_uv.x - 2. * t) * sin(1.5 * shape_uv.x + t) * (.75 + .25 * cos(3. * t));
    shape = 1. - smoothstep(-1., 1., shape_uv.y + wave);

  } else if (u_shape < 3.5) {
    // Ripple
    float dist = length(shape_uv);
    float waves = sin(pow(dist, 1.7) * 7. - 3. * t) * .5 + .5;
    shape = waves;

  } else if (u_shape < 4.5) {
    // Swirl
    float l = length(shape_uv);
    float angle = 6. * atan(shape_uv.y, shape_uv.x) + 4. * t;
    float twist = 1.2;
    float offset = pow(l, -twist) + angle / TWO_PI;
    float mid = smoothstep(0., 1., pow(l, twist));
    shape = mix(0., fract(offset), mid);

  } else if (u_shape < 5.5) {
    // Flow
    shape_uv *= 1.5;
    vec2 q = vec2(0.);
    q.x = snoise(shape_uv + vec2(0.0, 1.0));
    q.y = snoise(shape_uv + vec2(5.2, 1.3));
    vec2 r = vec2(0.);
    r.x = snoise(shape_uv + 1.0*q + vec2(1.7, 9.2) + 0.15*t);
    r.y = snoise(shape_uv + 1.0*q + vec2(8.3, 2.8) + 0.126*t);
    shape = snoise(shape_uv + r);
    shape = smoothstep(0.2, 0.8, shape * 0.5 + 0.5);

  } else if (u_shape < 6.5) {
    // Glitch
    vec2 g_uv = shape_uv;
    float noise_wave = snoise(vec2(0., g_uv.y * 10. + t * 5.));
    g_uv.x += noise_wave * 0.1 * step(0.8, fract(g_uv.y * 5. + t));
    float block = snoise(floor(g_uv * 8.) + t);
    shape = smoothstep(0.4, 0.6, block);

  } else if (u_shape < 7.5) {
    // Kaleidoscope
    vec2 k_uv = shape_uv;
    float angle = atan(k_uv.y, k_uv.x);
    float radius = length(k_uv);
    angle = mod(angle, PI / 3.0);
    angle = abs(angle - PI / 6.0);
    vec2 mapped_uv = vec2(cos(angle), sin(angle)) * radius;
    shape = snoise(mapped_uv * 5.0 - t);
    shape = smoothstep(0.3, 0.7, shape * 0.5 + 0.5);

  } else {
    // Liquid
    vec2 l_uv = shape_uv * 2.0;
    float v = 0.0;
    v += sin(l_uv.x * 4.0 + t);
    v += sin(l_uv.y * 4.0 + t * 0.5);
    v += sin((l_uv.x + l_uv.y) * 4.0 + t);
    vec2 c = l_uv + vec2(sin(t), cos(t));
    v += sin(length(c) * 4.0);
    shape = 0.5 + 0.5 * sin(v);
  }

  int type = int(floor(u_type));
  float dithering = 0.0;

  switch (type) {
    case 1: {
      dithering = step(hash21(ditheringNoise_uv), shape);
    } break;
    case 2:
      dithering = getBayerValue(dithering_uv, 2);
      break;
    case 3:
      dithering = getBayerValue(dithering_uv, 4);
      break;
    default:
      dithering = getBayerValue(dithering_uv, 8);
      break;
  }

  dithering -= .5;
  float res = step(.5, shape + dithering);

  vec3 fgColor = u_colorFront.rgb * u_colorFront.a;
  float fgOpacity = u_colorFront.a;
  vec3 bgColor = u_colorBack.rgb * u_colorBack.a;
  float bgOpacity = u_colorBack.a;

  vec3 color = fgColor * res;
  float opacity = fgOpacity * res;

  color += bgColor * (1. - opacity);
  opacity += bgOpacity * (1. - opacity);

  fragColor = vec4(color, opacity);
}
`,b={warp:1,wave:2,ripple:3,swirl:4,flow:5,glitch:6,kaleidoscope:7,liquid:8},x={random:1,"2x2":2,"4x4":3,"8x8":4},o(p,{colorBack:{type:l.Color,title:`Background`,defaultValue:`#000000`},colorFront:{type:l.Color,title:`Foreground`,defaultValue:`#ffffff`},shape:{type:l.Enum,title:`Shape`,options:Object.keys(b),optionTitles:Object.keys(b).map(e=>e.charAt(0).toUpperCase()+e.slice(1)),defaultValue:`warp`},type:{type:l.Enum,title:`Dither Type`,options:Object.keys(x),defaultValue:`8x8`},pxSize:{type:l.Number,title:`Pixel Size`,defaultValue:4,min:1,max:20,step:1},speed:{type:l.Number,title:`Speed`,defaultValue:1,min:0,max:5,step:.1}})}));export{S as n,p as t};
//# sourceMappingURL=DitheringShader.qfRP9_Na.mjs.map