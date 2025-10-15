// Basic Navier-Stokes implementation somewhat based on the one from:
// http://graphics.cs.cmu.edu/nsp/course/15-464/Fall09/papers/StamFluidforGames.pdf
// Simplex noise implementation based on the one from:
// https://github.com/SRombauts/SimplexNoise/blob/master/src/SimplexNoise.cpp

/////////////////////////////////////////////////////
/*                ~~~ Globals ~~~                  */
/////////////////////////////////////////////////////
// Helpers to encode higher precision signed floats into the frame buffer.
// A bit hacky, but it'll have to work.
let CHANNEL_ENCODING_CONSTS = `
const highp float VBound = 0.0025;
const highp float VBoundi = (1.0 / VBound);
const highp float PBound = 20.0;
const highp float PBoundi = (1.0 / PBound);
const highp float DBound = 100.0;
const highp float DBoundi = 1.0 / DBound;
const highp float C4 = 16581375.0;
const highp float C4i = (1.0 / C4);
const highp float C3 = 65025.0;
const highp float C3i = (1.0 / C3);
const highp float C2 = 255.0;
const highp float C2i = (1.0 / C2);`
let CHANNEL_DECODING_HELPERS = `
#define fromV(i) ((from(i) - 0.5) * VBound)
#define fromP(i) ((from(i) - 0.5) * PBound)
#define fromD(i) (from(i) * DBound)
highp float from(highp vec4 v) {
    return (
        (v.r) +
        (v.g * C2i) +
        (v.b * C3i) +
        (v.a * C4i));
}`;
let CHANNEL_ENCODING_HELPERS = `
#define toV(i) (to((i * VBoundi) + 0.5))
#define toP(i) (to((i * PBoundi) + 0.5))
#define toD(i) (to(i * DBoundi))
highp vec4 to(highp float i) {
    i = clamp(i, 0.0, 1.0);
    highp float t;
    highp vec4 o = vec4(0.0, 0.0, 0.0, 0.0);
    // channel 4 (least significant)
    t = mod(i, C4i);
    i -= t;
    o.a = t * C4;
    // channel 3
    t = mod(i, C3i);
    i -= t;
    o.b = t * C3;
    // channel 2
    t = mod(i, C2i);
    i -= t;
    o.g = t * C2;
    // channel 1 (most significant)
    o.r = i;
    return o;
}`;

//////////////////////////////////////////////
/*          ~~~ Vertex Shaders ~~~          */
//////////////////////////////////////////////
window.SHADERSTR_FLUID_SIM_VERT = `#version 300 es
in vec4 aVertexPosition;
in vec2 aTextureCoord;

uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;

out highp vec2 vST;

void main() {
    gl_Position = uProjectionMatrix * uModelViewMatrix * aVertexPosition;
    vST = aTextureCoord;
}
`;

window.SHADERSTR_FLUID_DRAW_VERT = `#version 300 es
in vec4 aVertexPosition;
in vec2 aTextureCoord;

uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;

out highp vec2 vST;

void main() {
    gl_Position = uProjectionMatrix * uModelViewMatrix * aVertexPosition;
    vST = aTextureCoord;
}
`;

////////////////////////////////////////////////
/*          ~~~ Fragment Shaders ~~~          */
////////////////////////////////////////////////
window.SHADERSTR_FLUID_SIM_FRAG = `#version 300 es
layout(location = 0) out highp vec4 outVelocityX;
layout(location = 1) out highp vec4 outVelocityY;
layout(location = 2) out highp vec4 outVelocityTempX;
layout(location = 3) out highp vec4 outVelocityTempY;
layout(location = 4) out highp vec4 outDensity;
layout(location = 5) out highp vec4 outDensityTemp;

in highp vec2 vST;

uniform bool uInitializeFields;
uniform lowp uint uSimID;
const lowp uint SIMID_D_DIFFUSE = 1u;
const lowp uint SIMID_D_ADVECT = 2u;
const lowp uint SIMID_V_DIFFUSE = 4u;
const lowp uint SIMID_V_PROJECT_G = 8u; // gradient
const lowp uint SIMID_V_PROJECT_R = 16u; // relax
const lowp uint SIMID_V_PROJECT_A = 32u; // apply
const lowp uint SIMID_V_ADVECT = 64u;
const lowp uint SIMID_INPUTS = 128u;

uniform sampler2D uTexVX;
uniform sampler2D uTexVY;
uniform sampler2D uTexVTempX;
uniform sampler2D uTexVTempY;
uniform sampler2D uTexD;
uniform sampler2D uTexDTemp;
uniform mediump int uTexWidth;
uniform mediump int uTexHeight;
uniform highp float uAspect;

uniform highp float uDeltaTime;
uniform highp float uTime;

#define MOUSE_BUFFER_SIZE 2
uniform highp vec2 uMouseStart[MOUSE_BUFFER_SIZE];
uniform highp vec2 uMouseDir[MOUSE_BUFFER_SIZE];
uniform highp float uMouseMag[MOUSE_BUFFER_SIZE];

const highp vec2 INIT_VELOCITY = vec2(0.0, 0.0);
const highp float INIT_DENSITY_HIGH = 10.0;
const highp float INIT_DENSITY_LOW = 1.0;

const highp float DENSITY_DIFFUSION = 1.25;
const highp float VELOCITY_DIFFUSION = 1.75;
const highp float DENSITY_NOISE_SOURCE = 0.4;
const highp float VELOCITY_NOISE_SOURCE = 0.00000075;

const highp float MOUSE_MAX_DIST = 0.015;
const highp float MOUSE_AWAY_AMOUNT = 0.8;
const highp float MOUSE_STRENGTH = 0.7;
const highp float MOUSE_FALLOFF_EXP = 8.5; // must be high or the low-precision side effect of a hollow mouse influence is visible

const highp float NOISE_SCALE = 3.6;
const highp vec3 NOISE_PER_AXIS_SCALE = vec3(1.0, 1.0, 1.0);
const highp float NOISE_CHANGE_SPEED = 0.05;
const highp float NOISE_TORUS_WIDTH = 2.0;

const highp float PI = 3.14159; // put more digits in pi here!!!!!!!!!!!!!~~~~~~~~~~~~~~~~~~~~~~~~TODO
const highp float TAU = 2.0 * 3.14159;

//#define ROUNDED_MOUSE_START
#define ROUNDED_MOUSE_END
//#define NOISE_TORUS_MAPPING
${CHANNEL_ENCODING_CONSTS}
${CHANNEL_DECODING_HELPERS}
${CHANNEL_ENCODING_HELPERS}

// Simplex perlin noise randomization table (got via Wikipedia)
const mediump int perm[256] = int[256](
    151, 160, 137,  91,  90,  15, 131,  13, 201,  95,  96,  53, 194, 233,   7, 225,
    140,  36, 103,  30,  69, 142,   8,  99,  37, 240,  21,  10,  23, 190,   6, 148,
    247, 120, 234,  75,   0,  26, 197,  62,  94, 252, 219, 203, 117,  35,  11,  32,
     57, 177,  33,  88, 237, 149,  56,  87, 174,  20, 125, 136, 171, 168,  68, 175,
     74, 165,  71, 134, 139,  48,  27, 166,  77, 146, 158, 231,  83, 111, 229, 122,
     60, 211, 133, 230, 220, 105,  92,  41,  55,  46, 245,  40, 244, 102, 143,  54,
     65,  25,  63, 161,   1, 216,  80,  73, 209,  76, 132, 187, 208,  89,  18, 169,
    200, 196, 135, 130, 116, 188, 159,  86, 164, 100, 109, 198, 173, 186,   3,  64,
     52, 217, 226, 250, 124, 123,   5, 202,  38, 147, 118, 126, 255,  82,  85, 212,
    207, 206,  59, 227,  47,  16,  58,  17, 182, 189,  28,  42, 223, 183, 170, 213,
    119, 248, 152,   2,  44, 154, 163,  70, 221, 153, 101, 155, 167,  43, 172,   9,
    129,  22,  39, 253,  19,  98, 108, 110,  79, 113, 224, 232, 178, 185, 112, 104,
    218, 246,  97, 228, 251,  34, 242, 193, 238, 210, 144,  12, 191, 179, 162, 241,
     81,  51, 145, 235, 249,  14, 239, 107,  49, 192, 214,  31, 181, 199, 106, 157,
    184,  84, 204, 176, 115, 121,  50,  45, 127,   4, 150, 254, 138, 236, 205,  93,
    222, 114,  67,  29,  24,  72, 243, 141, 128, 195,  78,  66, 215,  61, 156, 180
);

mediump int hash(int i) {
    return perm[i & 255];
}
highp float grad(int hash, highp vec3 pos) {
    hash &= 15;
    highp float u = hash < 8 ? pos.x : pos.y;
    highp float v = hash < 4 ? pos.y : hash == 12 || hash == 14 ? pos.x : pos.z;
    return (((hash & 1) == 1) ? -u : u) + (((hash & 2) == 2) ? -v : v);
}

const highp float F3 = 1.0 / 3.0;
const highp float G3 = 1.0 / 6.0;
const highp float G3x2 = 2.0 * G3;
const highp float G3x3m1 = 3.0 * G3 - 1.0;
highp float simplex(highp vec3 pos) {    
    // Calculate enclosing cell
    highp float s = (pos.x + pos.y + pos.z) * F3;
    mediump ivec3 ijk = ivec3(int(pos.x + s), int(pos.y + s), int(pos.z + s)); // cell index
    highp float t = float(ijk.x + ijk.y + ijk.z) * G3;
    highp vec3 origin = vec3(float(ijk.x) - t, float(ijk.y) - t, float(ijk.z) - t); // cell origin
    highp vec3 disp = pos - origin; // displacement within cell

    // Get offsets of simplex shape
    mediump ivec3 ijk1;
    mediump ivec3 ijk2;
    if (disp.x >= disp.y) {
        if (disp.y >= disp.z) {
            ijk1 = ivec3(1, 0, 0);
            ijk2 = ivec3(1, 1, 0);
        } else if (disp.x >= disp.z) {
            ijk1 = ivec3(1, 0, 0);
            ijk2 = ivec3(1, 0, 1);
        } else {
            ijk1 = ivec3(0, 0, 1);
            ijk2 = ivec3(1, 0, 1);
        }
    } else { // disp.x < disp.y
        if (disp.y < disp.z) {
            ijk1 = ivec3(0, 0, 1);
            ijk2 = ivec3(0, 1, 1);
        } else if (disp.x < disp.z) {
            ijk1 = ivec3(0, 1, 0);
            ijk2 = ivec3(0, 1, 1);
        } else {
            ijk1 = ivec3(0, 1, 0);
            ijk2 = ivec3(1, 1, 0);
        }
    }

    // Apply those offsets
    highp vec3 disp1 = disp + vec3(G3 - float(ijk1.x), G3 - float(ijk1.y), G3 - float(ijk1.z));
    highp vec3 disp2 = disp + vec3(G3x2 - float(ijk2.x), G3x2 - float(ijk2.y), G3x2 - float(ijk2.z));
    highp vec3 disp3 = disp + vec3(G3x3m1, G3x3m1, G3x3m1);

    // Hash based on corners
    mediump ivec4 gi = ivec4(
        hash(ijk.x + hash(ijk.y + hash(ijk.z))),
        hash(ijk.x + ijk1.x + hash(ijk.y + ijk1.y + hash(ijk.z + ijk1.z))),
        hash(ijk.x + ijk2.x + hash(ijk.y + ijk2.y + hash(ijk.z + ijk2.z))),
        hash(ijk.x + 1 + hash(ijk.y + 1 + hash(ijk.z + 1)))
    );

    // Calculate corner contributions
    highp float n0, n1, n2, n3;
    t = 0.6 - disp.x*disp.x - disp.y*disp.y - disp.z*disp.z;
    if (t < 0.0) n0 = 0.0;
    else {
        t *= t;
        n0 = t * t * grad(gi.x, disp);
    }
    t = 0.6 - disp1.x*disp1.x - disp1.y*disp1.y - disp1.z*disp1.z;
    if (t < 0.0) n1 = 0.0;
    else {
        t *= t;
        n1 = t * t * grad(gi.y, disp1);
    }
    t = 0.6 - disp2.x*disp2.x - disp2.y*disp2.y - disp2.z*disp2.z;
    if (t < 0.0) n2 = 0.0;
    else {
        t *= t;
        n2 = t * t * grad(gi.z, disp2);
    }
    t = 0.6 - disp3.x*disp3.x - disp3.y*disp3.y - disp3.z*disp3.z;
    if (t < 0.0) n3 = 0.0;
    else {
        t *= t;
        n3 = t * t * grad(gi.w, disp3);
    }

    // Combine corners and normalize to [-1, 1] for final value
    return (n0 + n1 + n2 + n3) * 32.0;
}

void main() {
    // Noise calculation
    // sample noise on surface of torus (so it loops in both directions)
    highp vec3 noisePos;
    #ifdef NOISE_TORUS_MAPPING
    noisePos = vec3(
        vST.x * TAU + 3.75,
        vST.y * TAU, 0.0);
    noisePos = vec3(
        sin(noisePos.y),
        (cos(noisePos.y) + NOISE_TORUS_WIDTH) * sin(noisePos.x) * uAspect,
        (cos(noisePos.y) + NOISE_TORUS_WIDTH) * cos(noisePos.x) * uAspect);

    // somehow fit uAspect in to this!!!!!! after trig functions!!!!!!!!!!!~~~~~~~~~~~~~~~~TODO
    // if the torus mapping even looks good...

    #else
    noisePos = vec3(vST.x * uAspect, vST.y, 0.0);
    #endif
    highp float noise = simplex(
        noisePos * NOISE_PER_AXIS_SCALE * NOISE_SCALE
        + vec3(0.0, 0.0, uTime * NOISE_CHANGE_SPEED));

    if (uInitializeFields) {
        outVelocityX = toV(INIT_VELOCITY.x);
        outVelocityY = toV(INIT_VELOCITY.y);
        outDensity = toD((noise * 0.5 + 0.5) * (10.0));
        return;
    }

    // Common calculations
    highp vec2 newV = vec2(fromV(texture(uTexVX, vST)), fromV(texture(uTexVY, vST)));
    highp float w = uAspect / float(uTexWidth);
    highp float h = 1.0 / float(uTexHeight);

    // Velocity calculation
    {
        // Get velocities around current for & projection
        // (n is -1, p is +1)
        // ((clipping isn't a problem b/c of wrapping))
        highp vec2 c_0n = vec2(fromV(texture(uTexVX, vST + vec2(0.0, -h))), fromV(texture(uTexVY, vST + vec2(0.0, -h))));
        highp vec2 c_n0 = vec2(fromV(texture(uTexVX, vST + vec2(-w, 0.0))), fromV(texture(uTexVY, vST + vec2(-w, 0.0))));
        highp vec2 c_p0 = vec2(fromV(texture(uTexVX, vST + vec2(w, 0.0))), fromV(texture(uTexVY, vST + vec2(w, 0.0))));
        highp vec2 c_0p = vec2(fromV(texture(uTexVX, vST + vec2(0.0, h))), fromV(texture(uTexVY, vST + vec2(0.0, h))));
        
        // Sample nearby "projected" values
        highp float p_0n = fromP(texture(uTexVTempY, vST + vec2(0.0, -h)));
        highp float p_n0 = fromP(texture(uTexVTempY, vST + vec2(-w, 0.0)));
        highp float p_p0 = fromP(texture(uTexVTempY, vST + vec2(w, 0.0)));
        highp float p_0p = fromP(texture(uTexVTempY, vST + vec2(0.0, h)));

        if ((uSimID & SIMID_INPUTS) == SIMID_INPUTS) {
            // Mouse calculation
            highp float proxCur, prox = MOUSE_MAX_DIST, mag = 0.0;
            highp vec2 disp, mousePushDir = vec2(0.0, 0.0), mouseDir = vec2(0.0, 0.0);
            for (lowp int i = 0; i < MOUSE_BUFFER_SIZE; ++i) {
                // Get proximity to mouse (line)
                disp = vST - uMouseStart[i]; // relative offset
                disp.x /= uAspect;
                proxCur = dot(disp, uMouseDir[i]); // shadow on line
                proxCur = proxCur >= 0.0 && proxCur < uMouseMag[i]
                    ? abs(dot(disp, vec2(uMouseDir[i].y * uAspect, -uMouseDir[i].x))) // dist along normal of movement vector
                    : MOUSE_MAX_DIST;
                if (proxCur < prox) {
                    prox = proxCur;
                    mousePushDir = disp / proxCur;
                    mag = uMouseMag[i];
                    mouseDir = uMouseDir[i];
                }

                // Get min of that and circular ends proximity
                #ifdef ROUNDED_MOUSE_START
                disp = vST - uMouseStart[i];
                proxCur = length(vec2(disp.x * uAspect, disp.y));
                if (proxCur < prox) {
                    prox = proxCur;
                    mousePushDir = disp / proxCur;
                    mag = uMouseMag[i];
                    mouseDir = uMouseDir[i];
                }
                #endif
                #ifdef ROUNDED_MOUSE_END
                disp = vST - (uMouseStart[i] + uMouseDir[i] * uMouseMag[i]);
                proxCur = length(vec2(disp.x * uAspect, disp.y));
                if (proxCur < prox) {
                    prox = proxCur;
                    mousePushDir = disp / proxCur;
                    mag = uMouseMag[i];
                    mouseDir = uMouseDir[i];
                }
                #endif
            }
            if (prox == 0.0) mousePushDir = vec2(1.0, 0.0); // divide by 0 protection!

            // Calculate influence based on proximity
            highp float mouseInfluence = max(0.0, 1.0 - prox / MOUSE_MAX_DIST);
            mouseInfluence = pow(mouseInfluence, MOUSE_FALLOFF_EXP) * uDeltaTime * mag * MOUSE_STRENGTH;

            // Add in the mouse movement, some pushing away, some going with mouse movement
            newV += mouseInfluence * (mousePushDir * MOUSE_AWAY_AMOUNT + mouseDir);

            // Add in some (very slight) noise-based velocity
            highp float noiseAng = noise * TAU + 1.827384; // with a random offset so it's not too regular
            newV += vec2(sin(noiseAng), cos(noiseAng)) * VELOCITY_NOISE_SOURCE * uDeltaTime;

            // Save initial velocity for diffuse step
            outVelocityTempX = toV(newV.x);
            outVelocityTempY = toV(newV.y);
        }

        else if ((uSimID & SIMID_V_DIFFUSE) == SIMID_V_DIFFUSE) {
            highp vec4 initialVelX = texture(uTexVTempX, vST);
            highp vec4 initialVelY = texture(uTexVTempY, vST);

            highp float vel_diffusion = VELOCITY_DIFFUSION * uDeltaTime;
            newV = (vec2(fromV(initialVelX), fromV(initialVelY)) + vel_diffusion * (c_0n + c_n0 + c_p0 + c_0p)) / (1.0 + 4.0 * vel_diffusion);

            // Pass on start-of-step velocity to next diffuse iteration
            outVelocityTempX = initialVelX;
            outVelocityTempY = initialVelY;
        }

        else if ((uSimID & SIMID_V_PROJECT_G) == SIMID_V_PROJECT_G) {
            // Find velocity gradient around/at pixel
            highp vec4 grad = toP(50000.0 * (c_p0.x - c_n0.x + c_0p.y - c_0n.y));
            // Output as initial values of projection variables (gradient, project)
            // (reused velocity packing code)
            outVelocityTempX = grad;
            outVelocityTempY = grad; // (in the model code, project starts at 0.0. I think this is more efficient for fewer iterations)
        }

        else if ((uSimID & SIMID_V_PROJECT_R) == SIMID_V_PROJECT_R) {
            highp vec4 grad = texture(uTexVTempX, vST);

            // Iteratively relax each projected value to be 25% more than the average of its gradients
            // and neighboring projected values? I don't really understand this one if I'm honest
            highp float newP = (fromP(grad) + p_0n + p_n0 + p_p0 + p_0p) * 0.25;

            outVelocityTempX = grad;
            outVelocityTempY = toP(newP);
        }

        else if ((uSimID & SIMID_V_PROJECT_A) == SIMID_V_PROJECT_A) {
            // Finally, move each pixel's velocity away from the gradient of its projected values
            newV.x += 0.000005 * (p_p0 - p_n0);
            newV.y += 0.000005 * (p_0p - p_0n);
        }

        else if ((uSimID & SIMID_V_ADVECT) == SIMID_V_ADVECT) {
            // Get velocity around sample for advection
            // Interpolation is already done for us!
            highp vec2 samplePos = vST - newV * uDeltaTime / vec2(w, h);
            newV = vec2(fromV(texture(uTexVX, samplePos)), fromV(texture(uTexVY, samplePos)));
        }

        outVelocityX = toV(newV.x);
        outVelocityY = toV(newV.y);
    }

    // Density calculation
    {
        highp float newD = fromD(texture(uTexD, vST));

        if ((uSimID & SIMID_INPUTS) == SIMID_INPUTS) {
            // Target density is based on changing noise map
            newD += noise * DENSITY_NOISE_SOURCE * uDeltaTime;

            // Write initial density for diffusion steps to use
            outDensityTemp = toD(newD);
        }

        else if ((uSimID & SIMID_D_DIFFUSE) == SIMID_D_DIFFUSE) {
            // Get density around current for diffusion
            // (n is -1, p is +1)
            // ((clipping isn't a problem b/c of wrapping))
            highp float c_0n = fromD(texture(uTexD, vST + vec2(0.0, -h)));
            highp float c_n0 = fromD(texture(uTexD, vST + vec2(-w, 0.0)));
            highp float c_p0 = fromD(texture(uTexD, vST + vec2(w, 0.0)));
            highp float c_0p = fromD(texture(uTexD, vST + vec2(0.0, h)));

            highp float dens_diffusion = DENSITY_DIFFUSION * uDeltaTime;
            newD = (fromD(texture(uTexDTemp, vST)) + dens_diffusion * (c_0n + c_n0 + c_p0 + c_0p)) / (1.0 + 4.0 * dens_diffusion);
        }

        else if ((uSimID & SIMID_D_ADVECT) == SIMID_D_ADVECT) {
            // Get density around sample for advection
            // Interpolation is already done for us!
            // (velocity sample is safe to use because sampled after done relaxing)
            newD = fromD(texture(uTexD, vST - newV * uDeltaTime / vec2(w, h)));
        }

        outDensity = toD(newD);
    }
}`;

window.SHADERSTR_FLUID_DRAW_FRAG = `#version 300 es
layout(location = 0) out mediump vec4 outColor;

in mediump vec2 vST;

uniform sampler2D uTexVX;
uniform sampler2D uTexVY;
uniform sampler2D uTexD;
uniform mediump int uTexWidth;
uniform mediump int uTexHeight;

uniform mediump float uDeltaTime;
uniform mediump float uAspect;

const mediump vec3 COL_LOW = vec3(0.614, 0.84, 0.19);
const mediump vec3 COL_HIGH = vec3(0.503, 1.0, 0.67);
const mediump float COL_TINT_HUE = 0.8;

const mediump float UPRIGHTNESS = 0.00025; // how much the normals tend upwards

const mediump vec3 LIGHT_DIR = normalize(vec3(-1.0, -1.0, 0.0));
const mediump float LIGHT_LIGHTNESS_STRENGTH = 0.6;
const mediump float LIGHT_TINTING_STRENGTH = 0.9;

//#define FUTURE_INTERPOLATION
//#define VELOCITY_TINTING
${CHANNEL_ENCODING_CONSTS}
${CHANNEL_DECODING_HELPERS}

mediump vec3 hsl2rgb(mediump vec3 hsl)
{
    mediump float c = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
    mediump float slice = hsl.x * 6.0;
    mediump float x = c * (1.0 - abs(mod(slice, 2.0) - 1.0));
    mediump float m = hsl.z - c * 0.5;

    return vec3(
        slice < 1.0 ? vec3(c, x, 0.0) :
        slice < 2.0 ? vec3(x, c, 0.0) :
        slice < 3.0 ? vec3(0.0, c, x) :
        slice < 4.0 ? vec3(0.0, x, c) :
        slice < 5.0 ? vec3(x, 0.0, c) :
                      vec3(c, 0.0, x))
        + vec3(m, m, m);
}

void main() {
    // Sample simulation at pixel
    // but first do a forward-looking advect step in case we're future-interpolating
    mediump vec2 vel;
    mediump float density;
    vel = vec2(fromV(texture(uTexVX, vST)), fromV(texture(uTexVY, vST)));
    #ifdef FUTURE_INTERPOLATION
    mediump vec2 vel2TextureCoords = vec2(float(uTexWidth) / uAspect, float(uTexHeight)) * uDeltaTime;
    vel *= vel2TextureCoords;
    vel = vec2(fromV(texture(uTexVX, vST + vel)), fromV(texture(uTexVY, vST + vel)));
    density = fromD(texture(uTexD, vST + vel * vel2TextureCoords));
    #else
    density = fromD(texture(uTexD, vST));
    #endif

    // Create a normal of the fluid's surface
    mediump vec3 n = normalize(vec3(vel.x, vel.y, UPRIGHTNESS));

    // Calculate lighting
    mediump float l = dot(-LIGHT_DIR, n);

    mediump vec3 col = mix(COL_LOW, COL_HIGH, max(0.0, min(1.0, pow(density * 0.105, 1.825))));
    #ifdef VELOCITY_TINTING
    col.r = mix(col.r, COL_TINT_HUE, pow(abs(l), 0.6) * LIGHT_TINTING_STRENGTH);
    #else
    col.z *= 1.0 + l * LIGHT_LIGHTNESS_STRENGTH;
    col.z = max(0.0, min(1.0, col.z));
    #endif
    outColor = vec4(hsl2rgb(col), 1.0);
}`;