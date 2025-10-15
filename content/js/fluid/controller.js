// Control script for the WebGL background!

//////////////////////////////////////////////////
/*          ~~~ Global Definitions ~~~          */
//////////////////////////////////////////////////

// Constants/Parameters
const canvasScale = 1.0 / 3.0;
const canvasSizeMin = 128;
const canvasSizeMax = 1024;
const canvasInactiveColor = "#8EFEFE"
const RENDER_FRAME_INTERVAL = 2; // renders every N frames
const RENDER_PFRAMES = false; // whether or not to interpolate on the off frame
const MIN_IFRAME_DIST_REALTIME_MS = 1000.0 / 25.0; // except it's more common on very low refresh-rate screens
const SIM_SPEED_MULTIPLIER = 1.6; // just make it a bit more chaotic, to show off :)
const SIMID_D_DIFFUSE = 1;
const SIMID_D_ADVECT = 2;
const SIMID_V_DIFFUSE = 4;
const SIMID_V_PROJECT_G = 8; // gradient
const SIMID_V_PROJECT_R = 16; // relax
const SIMID_V_PROJECT_A = 32; // apply
const SIMID_V_ADVECT = 64;
const SIMID_INPUTS = 128;
const SIM_INPUTS_COUNT = 1; // # of iterations after these finish
const SIM_V_DIFFUSE_COUNT = 2 + SIM_INPUTS_COUNT;
const SIM_V_PROJECT1_G_COUNT = 1 + SIM_V_DIFFUSE_COUNT;
const SIM_V_PROJECT1_R_COUNT = 3 + SIM_V_PROJECT1_G_COUNT;
const SIM_V_PROJECT1_A_COUNT = 1 + SIM_V_PROJECT1_R_COUNT;
const SIM_V_ADVECT_COUNT = 1 + SIM_V_PROJECT1_A_COUNT;
const SIM_V_PROJECT2_G_COUNT = 1 + SIM_V_ADVECT_COUNT;
const SIM_V_PROJECT2_R_COUNT = 3 + SIM_V_PROJECT2_G_COUNT;
const SIM_V_PROJECT2_A_COUNT = 1 + SIM_V_PROJECT2_R_COUNT;
const MOUSE_ARGS_BUFFER_SIZE = RENDER_FRAME_INTERVAL;
const MOUSE_POS_BUFFER_SIZE = MOUSE_ARGS_BUFFER_SIZE + 1;
const DEBUG_VERBOSITY = 0;
// Plain Globals
var canvas;
var gl;
var shaders = {
    sim: {
        program: null,
        vert: null,
        frag: null,
        attributeLocs: null,
        uniformLocs: null,
    },
    draw: {
        program: null,
        vert: null,
        frag: null,
        attributeLocs: null,
        uniformLocs: null,
    },
    vertexbuffers: {
        positions: null,
        st: null,
    },
    simTexVX1: null,
    simTexVX2: null,
    simTexVY1: null,
    simTexVY2: null,
    simTexVTempX1: null, // extra buffer for intermediate values used in the velocity calculations
    simTexVTempX2: null,
    simTexVTempY1: null,
    simTexVTempY2: null,
    simTexD1: null,
    simTexD2: null,
    simTexDTemp: null,
    simFB: null,
}
var enabled;
var curCanvW = null;
var curCanvH = null;
var curSimW = null;
var curSimH = null;
var timeSim = -1; // ms it's been running
var timePrev = document.timeline.currentTime;
var timePrevIFrame = timePrev;
var simTexDPrev = null;
var simTexDNext = null;
var simTexVXPrev = null;
var simTexVXNext = null;
var simTexVYPrev = null;
var simTexVYNext = null;
var simTexVTempXPrev = null;
var simTexVTempXNext = null;
var simTexVTempYPrev = null;
var simTexVTempYNext = null;
var firstRender = true;
var lastTimeDelta;
var mousePosBuffer = Array(MOUSE_POS_BUFFER_SIZE).fill(null);
var mousePosIndexTop = 0;
var mousePosArrSize = 0;
var curMousePos = null;
var focused = true;
var frameParity = 0;
var animMutex = false;

////////////////////////////////////////////////////
/*          ~~~ Function Definitions ~~~          */
////////////////////////////////////////////////////

function clearMousePos() {
    mousePosArrSize = 0;
}
function hasMousePos() { return mousePosArrSize > 0; }
function pushMousePos(pos) {
    mousePosBuffer[mousePosIndexTop] = pos;
    let ogTop = mousePosIndexTop;
    let ogSize = mousePosArrSize;
    mousePosIndexTop = (mousePosIndexTop + 1) % MOUSE_POS_BUFFER_SIZE;
    mousePosArrSize = Math.min(mousePosArrSize + 1, MOUSE_POS_BUFFER_SIZE);
}
function getCurMousePos() {
    if (mousePosArrSize <= 0) return null;
    return [temp[0], temp[1]];
}
function getPrevMousePos(distance) {
    if (distance < 0 || distance > mousePosArrSize) return null;
    let remapped = mousePosIndexTop - 1 - i;
    if (remapped < 0) remapped = MOUSE_POS_BUFFER_SIZE - remapped;
    let temp = mousePosBuffer[remapped];
    return [temp[0], temp[1]];
}
function getPrevMousePosArr() {
    // if not full, fills with identical copies
    return Array(MOUSE_POS_BUFFER_SIZE).fill(null).map((_, i) => {
        if (mousePosArrSize <= 0)
            return [0, 0];
        let remapped = Math.min(i, mousePosArrSize - 1);
        remapped = mousePosIndexTop - 1 - remapped;
        if (remapped < 0) remapped += MOUSE_POS_BUFFER_SIZE;
        let temp = mousePosBuffer[remapped];
        return [temp[0], temp[1]];
    });
}
function nearestPowerOf2(n) {
    // adapted from: https://stackoverflow.com/a/42799104
    let down = 1 << 32 - Math.clz32(n);
    let up = 1 << 32 - Math.clz32(n << 1);
    let downDist = Math.abs(n - down);
    return Math.abs(n - up) < downDist ? up : down;
}
function pollResizeCanvas() {
    let canvasRect = canvas.getBoundingClientRect();
    let desiredW = Math.max(
        Math.min(canvasSizeMax,
            Math.max(canvasSizeMin,
                nearestPowerOf2(
                    Math.ceil(canvasRect.width * canvasScale)))));
    let desiredH = Math.max(
        Math.min(canvasSizeMax,
            Math.max(canvasSizeMin,
                nearestPowerOf2(
                    Math.ceil(canvasRect.height * canvasScale)))));

    if (// Always refresh if not been sized yet
        curCanvW === undefined || curCanvH === undefined ||
        // Otherwise, only refresh when above a certain threshold
        desiredW !== curCanvW || desiredH !== curCanvH)
    {
        if (DEBUG_VERBOSITY >= 1)
            console.log(`Trying to resize canvas from ${curCanvW}x${curCanvH} to ${desiredW}x${desiredH}`);

        refreshCanvas(desiredW, desiredH);
        return true;
    }
    return false;
}
function refreshCanvas(newWidth, newHeight) {
    // Resize the canvas
    gl.canvas.width = newWidth;
    gl.canvas.height = newHeight;

    // Resize the simulation texture
    createSimTextures(newWidth, newHeight);

    // Update tracker values
    curCanvW = newWidth;
    curCanvH = newHeight;
}
function tryUpdateRepeating(_ = null) {
    // so we don't update twice in the same frame for whatever reason
    if (animMutex)
        return;
    animMutex = true;

    try {
        let timeCur = document.timeline.currentTime;
        let timeDelta = timeCur - timePrev;
        timeSim += timeDelta;
        timePrev = timeCur;
        lastTimeDelta = timeDelta;
        let timeDeltaSinceLastIFrame = timeCur - timePrevIFrame;
    
        // Calculate if this is going to be an expensive I-Frame
        let isIFrame = --frameParity <= 0
            || firstRender
            || timeDeltaSinceLastIFrame > MIN_IFRAME_DIST_REALTIME_MS;
        if (isIFrame) {
            frameParity = RENDER_FRAME_INTERVAL;
            timePrevIFrame = timeCur;
        }
    
        // Only render every N frames (because jeez it's expensive!)
        updateSim(timeDeltaSinceLastIFrame / 1000.0 * Math.max(1, RENDER_FRAME_INTERVAL),
            timeSim / 1000.0, isIFrame);
    
        if (focused)
            requestAnimationFrame(tryUpdateRepeating);
    }
    catch (e) {
        console.error(e);
    }
    
    animMutex = false;
}
function updateSim(deltaTSinceLastIFrame, timeSim, isIFrame) {
    // On start, arbitrarily assign which sim textures are input/output
    if (firstRender) {
        simTexDPrev = shaders.simTexD1;
        simTexDNext = shaders.simTexD2;
        simTexVXPrev = shaders.simTexVX1;
        simTexVXNext = shaders.simTexVX2;
        simTexVYPrev = shaders.simTexVY1;
        simTexVYNext = shaders.simTexVY2;
        simTexVTempXPrev = shaders.simTexVTempX1;
        simTexVTempXNext = shaders.simTexVTempX2;
        simTexVTempYPrev = shaders.simTexVTempY1;
        simTexVTempYNext = shaders.simTexVTempY2;
    }

    // Only do VERY expensive sim recalculation step every once in a while
    if (isIFrame) {
        if (curMousePos !== null) pushMousePos([curMousePos[0], curMousePos[1]]);
        simStep(deltaTSinceLastIFrame, timeSim);
        clearMousePos();
    }
    
    if (curMousePos === null) clearMousePos();
    else pushMousePos([curMousePos[0], curMousePos[1]]);

    // Then render the changes
    if (isIFrame || RENDER_PFRAMES) {
        // (after final iteration, newest state is flipped to "previous" variable)
        renderScene(isIFrame ? 0.0 : deltaTSinceLastIFrame, simTexVXPrev, simTexVYPrev, simTexDPrev);
    }
}
function simStep(deltaT, timeSim) {
    // We update the sim using the simulation fragment shaders

    // Specify we render to framebuffer/ sim textures
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, shaders.simFB);
    gl.drawBuffers([
        gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, // vel
        gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3, // vel temp
        gl.COLOR_ATTACHMENT4, gl.COLOR_ATTACHMENT5  // dens + dens temp
    ]);
    gl.viewport(0, 0, curSimW, curSimH);

    // Clear framebuffer
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(1.);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    // Specify program to render with
    gl.useProgram(shaders.sim.program);

    // Provide vertex buffer
    gl.enableVertexAttribArray(shaders.sim.attributeLocs.vertexPosition);
    gl.bindBuffer(gl.ARRAY_BUFFER, shaders.vertexbuffers.positions);
    gl.vertexAttribPointer(
        shaders.sim.attributeLocs.vertexPosition,
        2, gl.FLOAT, false, 0, 0);

    // Provide texture coord buffer
    gl.enableVertexAttribArray(shaders.sim.attributeLocs.textureCoord);
    gl.bindBuffer(gl.ARRAY_BUFFER, shaders.vertexbuffers.textureCoord);
    gl.vertexAttribPointer(
        shaders.sim.attributeLocs.textureCoord,
        2, gl.FLOAT, false, 0, 0);

    // Create projection matrix
    let zClipNear = 0.1;
    let zClipFar = 20.0;
    let projMatrix = mat4.create();
    mat4.ortho(projMatrix, -1.0, 1.0, -1.0, 1.0, zClipNear, zClipFar);
    // Provide proj matrix
    gl.uniformMatrix4fv(shaders.sim.uniformLocs.projectionMatrix, false, projMatrix);

    // Create model view matrix
    let modelViewMatrix = mat4.create();
    mat4.translate(modelViewMatrix, modelViewMatrix, [0., 0., -1.]);
    // Provide model view matrix
    gl.uniformMatrix4fv(shaders.sim.uniformLocs.modelViewMatrix, false, modelViewMatrix);

    // Provide the user mouse input
    if (hasMousePos()) {
        let poses = getPrevMousePosArr();

        let starts = Array(MOUSE_ARGS_BUFFER_SIZE * 2).fill(0);
        let dirs = Array(MOUSE_ARGS_BUFFER_SIZE * 2).fill(0);
        let mags = Array(MOUSE_ARGS_BUFFER_SIZE).fill(0);

        // move back
        // first encountered is oldest pos' ending
        let dx, dy;
        for (let i = poses.length - 2; i >= 0; --i) {
            let ix = i * 2;
            let iy = ix + 1;
            starts[ix] = poses[i + 1][0];
            starts[iy] = poses[i + 1][1];
            dx = poses[i][0] - starts[ix];
            dy = poses[i][1] - starts[iy];
            mags[i] = Math.sqrt(dx * dx + dy * dy);
            if (mags[i] != 0) {
                dirs[ix] = dx / mags[i];
                dirs[iy] = dy / mags[i];
            }
        }
        
        gl.uniform2fv(shaders.sim.uniformLocs.mouseStart, starts);
        gl.uniform2fv(shaders.sim.uniformLocs.mouseDir, dirs);
        gl.uniform1fv(shaders.sim.uniformLocs.mouseMag, mags);
        if (DEBUG_VERBOSITY >= 3)
            console.log(`Sim mouse starts: ${starts}, dirs: ${dirs}, mags: ${mags}`);
    } else {
        // create dummy empty arrays if no mouse movement
        let vec2 = Array(MOUSE_ARGS_BUFFER_SIZE).fill([0, 0]);
        let single = Array(MOUSE_ARGS_BUFFER_SIZE).fill([0]);
        gl.uniform2fv(shaders.sim.uniformLocs.mouseStart, vec2);
        gl.uniform2fv(shaders.sim.uniformLocs.mouseEnd, vec2);
        gl.uniform1fv(shaders.sim.uniformLocs.mouseMag, single);
    }

    // Provide other simulation inputs
    let rect = canvas.getBoundingClientRect();
    gl.uniform1i(shaders.sim.uniformLocs.texWidth, curSimW);
    gl.uniform1i(shaders.sim.uniformLocs.texHeight, curSimH);
    gl.uniform1f(shaders.sim.uniformLocs.aspect, rect.width / rect.height);
    gl.uniform1f(shaders.sim.uniformLocs.deltaTime, deltaT * SIM_SPEED_MULTIPLIER);
    gl.uniform1f(shaders.sim.uniformLocs.simTime, timeSim);
    gl.uniform1i(shaders.sim.uniformLocs.firstRender, firstRender);

    // Do a certain number of iterative steps to make it less chaotic
    let iterations = SIM_V_PROJECT2_A_COUNT;
    for (let i = 1; i <= iterations; i++) {
        let simStepID =
            (i == SIM_INPUTS_COUNT ? SIMID_INPUTS : 0) | // handle inputs on first iteration

            (i > SIM_INPUTS_COUNT && i < iterations ? SIMID_D_DIFFUSE : 0) | // diffuse density on all but last iteration
            (i == iterations ? SIMID_D_ADVECT : 0) | // only advect density on final iteration
            
            (i > SIM_INPUTS_COUNT && i <= SIM_V_DIFFUSE_COUNT ? SIMID_V_DIFFUSE : 0) | // first vel iterations diffuse
            (i > SIM_V_DIFFUSE_COUNT && i <= SIM_V_PROJECT1_G_COUNT ? SIMID_V_PROJECT_G : 0) | // next, vel iteration projection part 1
            (i > SIM_V_PROJECT1_G_COUNT && i <= SIM_V_PROJECT1_R_COUNT ? SIMID_V_PROJECT_R : 0) | // part 2
            (i > SIM_V_PROJECT1_R_COUNT && i <= SIM_V_PROJECT1_A_COUNT ? SIMID_V_PROJECT_A : 0) | // part 3
            (i == SIM_V_ADVECT_COUNT ? SIMID_V_ADVECT : 0) | // then advect once
            (i > SIM_V_ADVECT_COUNT && i <= SIM_V_PROJECT2_G_COUNT ? SIMID_V_PROJECT_G : 0) | // final iterations project part 1
            (i > SIM_V_PROJECT2_G_COUNT && i <= SIM_V_PROJECT2_R_COUNT ? SIMID_V_PROJECT_R : 0) | // part 2
            (i > SIM_V_PROJECT2_R_COUNT && i <= SIM_V_PROJECT2_A_COUNT ? SIMID_V_PROJECT_A : 0); // part 3
        gl.uniform1ui(shaders.sim.uniformLocs.simStepID, simStepID);
        
        // output/framebuffer
        gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, simTexVXNext, 0);
        gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, simTexVYNext, 0);
        gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, simTexVTempXNext, 0);
        gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT3, gl.TEXTURE_2D, simTexVTempYNext, 0);
        gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT4, gl.TEXTURE_2D, simTexDNext, 0);
        if (i == 1) // density temp texture only written on first iteration
            gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT5, gl.TEXTURE_2D, shaders.simTexDTemp, 0);
        else
            gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT5, gl.TEXTURE_2D, null, 0);
        // input/sampler
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, simTexVXPrev);
        gl.uniform1i(shaders.sim.uniformLocs.velocitySamplerX, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, simTexVYPrev);
        gl.uniform1i(shaders.sim.uniformLocs.velocitySamplerY, 1);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, simTexVTempXPrev);
        gl.uniform1i(shaders.sim.uniformLocs.projectionSamplerX, 2);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, simTexVTempYPrev);
        gl.uniform1i(shaders.sim.uniformLocs.projectionSamplerY, 3);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, simTexDPrev);
        gl.uniform1i(shaders.sim.uniformLocs.densitySampler, 4);
        gl.activeTexture(gl.TEXTURE5);
        if (i == 1) // density temp texture can't be read on first iteration
            gl.bindTexture(gl.TEXTURE_2D, null);
        else
            gl.bindTexture(gl.TEXTURE_2D, shaders.simTexDTemp);
        gl.uniform1i(shaders.sim.uniformLocs.densityTempSampler, 5);
        // Clear framebuffer
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // Update sim
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // Swap input/output buffers
        var temp = simTexVXNext;
        simTexVXNext = simTexVXPrev;
        simTexVXPrev = temp;
        var temp = simTexVYNext;
        simTexVYNext = simTexVYPrev;
        simTexVYPrev = temp;
        temp = simTexDNext;
        simTexDNext = simTexDPrev;
        simTexDPrev = temp;
        temp = simTexVTempXNext; // temp ones only matter some of the time, but this costs nothing
        simTexVTempXNext = simTexVTempXPrev;
        simTexVTempXPrev = temp;
        temp = simTexVTempYNext;
        simTexVTempYNext = simTexVTempYPrev;
        simTexVTempYPrev = temp;

        if (firstRender)
            break;
    }

    if (firstRender) {
        if (DEBUG_VERBOSITY >= 2)
            console.log("Completed initial sim state setup with current textures");
    }
    else {
        if (DEBUG_VERBOSITY >= 3)
            console.log(`Simulation updated with timestep ${deltaT}!`);
    }

    // No longer the first render
    firstRender = false;

}
function renderScene(deltaT, texVelX, texVelY, texDens) {
    // Unbind framebuffer from simulation -- render to the canvas!
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

    // Clear all existing fragments
    gl.clearColor(0., 0., 0., 1.);
    gl.clearDepth(1.);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Specify program to render with
    gl.useProgram(shaders.draw.program);

    // Provide vertex buffer
    gl.enableVertexAttribArray(shaders.draw.attributeLocs.vertexPosition);
    gl.bindBuffer(gl.ARRAY_BUFFER, shaders.vertexbuffers.positions);
    gl.vertexAttribPointer(
        shaders.draw.attributeLocs.vertexPosition,
        2, gl.FLOAT, false, 0, 0);

    // Provide texture coord buffer
    gl.enableVertexAttribArray(shaders.draw.attributeLocs.textureCoord);
    gl.bindBuffer(gl.ARRAY_BUFFER, shaders.vertexbuffers.textureCoord);
    gl.vertexAttribPointer(
        shaders.draw.attributeLocs.textureCoord,
        2, gl.FLOAT, false, 0, 0);

    // Create projection matrix
    let zClipNear = 0.1;
    let zClipFar = 20.0;
    let projMatrix = mat4.create();
    mat4.ortho(projMatrix, -1.0, 1.0, -1.0, 1.0, zClipNear, zClipFar);
    // Provide proj matrix
    gl.uniformMatrix4fv(shaders.draw.uniformLocs.projectionMatrix, false, projMatrix);

    // Create model view matrix
    let modelViewMatrix = mat4.create();
    mat4.translate(modelViewMatrix, modelViewMatrix, [0., 0., -1.]);
    // Provide model view matrix
    gl.uniformMatrix4fv(shaders.draw.uniformLocs.modelViewMatrix, false, modelViewMatrix);

    // Provide the newly generated sim state texture as input
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texVelX);
    gl.uniform1i(shaders.draw.uniformLocs.velocitySampler, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texVelY);
    gl.uniform1i(shaders.draw.uniformLocs.velocitySampler, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, texDens);
    gl.uniform1i(shaders.draw.uniformLocs.densitySampler, 2);
    
    // Other simulation inputs
    let rect = canvas.getBoundingClientRect();
    gl.uniform1i(shaders.draw.uniformLocs.texWidth, curSimW);
    gl.uniform1i(shaders.draw.uniformLocs.texHeight, curSimH);
    gl.uniform1f(shaders.draw.uniformLocs.aspect, rect.width / rect.height);
    gl.uniform1f(shaders.draw.uniformLocs.deltaTime, deltaT * SIM_SPEED_MULTIPLIER);

    // Draw 'em!
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (DEBUG_VERBOSITY >= 3)
        console.log("Scene rendered!");
}

//////////////////////////////////////////////
/*          ~~~ Initialization ~~~          */
//////////////////////////////////////////////

window.initFluidSim = function initFluidSim() {
    if (DEBUG_VERBOSITY >= 2) {
        console.log(`Fluid Sim Vert:\n${window.SHADERSTR_FLUID_SIM_VERT}`);
        console.log(`Fluid Sim Frag:\n${window.SHADERSTR_FLUID_SIM_FRAG}`);
        console.log(`Fluid Draw Vert:\n${window.SHADERSTR_FLUID_DRAW_VERT}`);
        console.log(`Fluid Draw Frag:\n${window.SHADERSTR_FLUID_DRAW_FRAG}`);
    }

    enabled =
        initCanvas() &&
        initGL() &&
        initShaderPrograms() &&
        initVertexBuffers() &&
        pollResizeCanvas();
    if (enabled) {
        // Start render loop
        tryUpdateRepeating();

        // Focus/unfocus performance events
        window.addEventListener("focus", () => {
            // ignore if already focused somehow
            if (focused)
                return;

            timePrev = document.timeline.currentTime - lastTimeDelta; // start counting from now!
            timePrevIFrame = timePrev;
            focused = true;
            if (DEBUG_VERBOSITY >= 2) console.log("Focused window");
            // Also reset stored mouse position so it doesn't drag from where it was long ago
            clearMousePos();
            // Also have to start the rendering loop back up again
            tryUpdateRepeating();
        })
        window.addEventListener("blur", () => {
            // This will naturally dequeue the rendering loop
            if (DEBUG_VERBOSITY >= 2) console.log("Unfocused window");
            focused = false;
        })

        // Interaction/event setup
        // Wave shader interaction
        document.documentElement.addEventListener("mousemove", (event) => {
            let x = event.clientX;
            let y = event.clientY;
            let canvRect = canvas.getBoundingClientRect();
            // if (x < canvRect.left || x > canvRect.right ||
            //     y < canvRect.top || y > canvRect.bottom)
            //     return;
            // Store mouse pos relative to canvas
            // Simulation will make waves with this
            curMousePos = [(x - canvRect.x) / canvRect.width, 1.0 - (y - canvRect.y) / canvRect.height];
        });
        // Possible resizing event
        window.addEventListener("resize", (event) => {
            pollResizeCanvas();
        });

        // Now unveil the sim itself
        window.changeSimVeilVisibility(false);
    }
}
function initCanvas() {
    canvas = document.getElementById('shader-canvas');
    if (canvas === null)
        return false;
    if (DEBUG_VERBOSITY >= 1)
        console.log("Canvas identified");
    return true;
}
function initGL() {
    gl = canvas.getContext("webgl2");
    if (gl === null) {
        console.warn("WebGL initialization failed. The background is supposed to have some portfolio-worthy shader action going on...");
        // // Just draw a plain color instead
        // let cxt = canvas.getContext("2d");
        // cxt.fillStyle = canvasInactiveColor;
        // cxt.fillRect(0, 0, canvas.offsetWidth, canvas.offsetHeight);
        return false;
    }
    // Draw a basic plain color while we wait
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (DEBUG_VERBOSITY >= 1)
        console.log("Canvas WebGL context initialized");
    return true;
}
function loadShader(name, type, source) {
    // Setup & compile shader
    let s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    // Error if failed
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error(`Shader "${name}" failed to compile.\nLog: ${gl.getShaderInfoLog(s)}`);
        return null;
    }
    if (DEBUG_VERBOSITY >= 1)
        console.log(`Shader "${name}" loaded and compiled`);
    return s;
}
function initShaderPrograms() {
    let b1 = createShaderProgram("Fluid Simulation", shaders.sim,
        window.SHADERSTR_FLUID_SIM_VERT, window.SHADERSTR_FLUID_SIM_FRAG,
        null, [
            ["simTime", "uTime"],
            ["projectionSamplerX", "uTexVTempX"],
            ["projectionSamplerY", "uTexVTempY"],
            ["densityTempSampler", "uTexDTemp"],
            ["mouseStart", "uMouseStart"],
            ["mouseDir", "uMouseDir"],
            ["mouseMag", "uMouseMag"],
            ["firstRender", "uInitializeFields"],
            ["simStepID", "uSimID"]
        ]);
    let b2 = createShaderProgram("Fluid Draw", shaders.draw,
        window.SHADERSTR_FLUID_DRAW_VERT, window.SHADERSTR_FLUID_DRAW_FRAG);
    return b1 && b2;
}
function createShaderProgram(name, storage, vertSource, fragSource,
    extraAttributes = null, extraUniforms = null)
{
    // Setup & link shader
    let vert = loadShader(`${name}: Vertex`, gl.VERTEX_SHADER, vertSource);
    if (vert === null) return false;
    let frag = loadShader(`${name}: Fragment`, gl.FRAGMENT_SHADER, fragSource);
    if (frag === null) return false;
    let program = gl.createProgram();
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);

    // Crash & burn if linking failed
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error(`${name} shader program initialization failed.\nLog: ${gl.getProgramInfoLog(program)}`);
        return false;
    }

    if (DEBUG_VERBOSITY >= 1)
        console.log(`${name} shader program successfully linked`);

    // Save location of shader variable's we'll need to manage
    let attributeLocs = {
        vertexPosition: gl.getAttribLocation(program, "aVertexPosition"),
        textureCoord:   gl.getAttribLocation(program, "aTextureCoord"),
    };
    if (extraAttributes !== null) {
        extraAttributes.forEach(a => {
            attributeLocs[a[0]] = gl.getAttribLocation(program, a[1]);
        });
    }
    let uniformLocs = {
        projectionMatrix: gl.getUniformLocation(program, "uProjectionMatrix"),
        modelViewMatrix:  gl.getUniformLocation(program, "uModelViewMatrix"),
        velocitySamplerX: gl.getUniformLocation(program, "uTexVX"),
        velocitySamplerY: gl.getUniformLocation(program, "uTexVY"),
        densitySampler:   gl.getUniformLocation(program, "uTexD"),
        texWidth:         gl.getUniformLocation(program, "uTexWidth"),
        texHeight:        gl.getUniformLocation(program, "uTexHeight"),
        aspect:           gl.getUniformLocation(program, "uAspect"),
        deltaTime:        gl.getUniformLocation(program, "uDeltaTime"),
    };
    if (extraUniforms !== null) {
        extraUniforms.forEach(u => {
            uniformLocs[u[0]] = gl.getUniformLocation(program, u[1]);
        });
    }

    // If everything succeeded, save it
    storage.program = program;
    storage.vert = vert;
    storage.frag = frag;
    storage.attributeLocs = attributeLocs;
    storage.uniformLocs = uniformLocs;
    return true;
}
function initVertexBuffers() {
    shaders.vertexbuffers.positions =
        createVertexBuffer("Positions", [-1., -1., -1., 1., 1., -1., 1., 1.]);
    shaders.vertexbuffers.textureCoord =
        createVertexBuffer("Texture Coordinates", [0., 0., 0., 1., 1., 0., 1., 1.]);
    return shaders.vertexbuffers.positions != null && shaders.vertexbuffers.textureCoord != null;
}
function createVertexBuffer(name, data) {
    // Create vertex buffer for a very boring plane
    let vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data),
        gl.STATIC_DRAW);

    if (DEBUG_VERBOSITY >= 1)
        console.log(`Vertex buffer "${name}" successfully created`);

    return vb;
}
function createSimTextures(resX, resY) {
    // Create new render textures to act as alternating simulation buffers
    shaders.simTexVX1 = createSimTex(shaders.simTexVX1, resX, resY);
    shaders.simTexVX2 = createSimTex(shaders.simTexVX2, resX, resY);
    shaders.simTexVY1 = createSimTex(shaders.simTexVY1, resX, resY);
    shaders.simTexVY2 = createSimTex(shaders.simTexVY2, resX, resY);
    shaders.simTexD1 = createSimTex(shaders.simTexD1, resX, resY);
    shaders.simTexD2 = createSimTex(shaders.simTexD2, resX, resY);
    shaders.simTexVTempX1 = createSimTex(shaders.simTexVTempX1, resX, resY);
    shaders.simTexVTempX2 = createSimTex(shaders.simTexVTempX2, resX, resY);
    shaders.simTexVTempY1 = createSimTex(shaders.simTexVTempY1, resX, resY);
    shaders.simTexVTempY2 = createSimTex(shaders.simTexVTempY2, resX, resY);
    shaders.simTexDTemp = createSimTex(shaders.simTexDTemp, resX, resY);

    // Make sure it initializes on the first render
    firstRender = true;

    // Create the framebuffer to help in rendering to the texture
    // (only create it if one not already created; doesn't need to be resized)
    if (shaders.simFB === null)
        shaders.simFB = gl.createFramebuffer();

    // Save values
    curSimW = resX;
    curSimH = resY;

    if (DEBUG_VERBOSITY >= 1)
        console.log(`Simulation textures of resolution ${resX}x${resY} created`);
}
function createSimTex(existing, resX, resY) {
    // Delete existing texture
    if (existing !== null)
        gl.deleteTexture(existing);

    let a1 = gl.TEXTURE_2D; // target
    let a2 = 0; // mipmap level
    let a3 = gl.RGBA; // internalFormat
    let a4 = resX; // width
    let a5 = resY; // height
    let a6 = 0; // border
    let a7 = gl.RGBA; // srcFormat
    let a8 = gl.UNSIGNED_BYTE; // srcType
    let a9 = //gl.canvas; // pixel source (just copy what's already drawn on the canvas)
             null; // nvm, the overloads that accept HTML elements are those that don't rescale it...
                   // providing no pixel source here makes Firefox give an erroneous warning, but whatever
    let tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(a1, a2, a3, a4, a5, a6, a7, a8, a9);
    // Wrap texture, because that'll look cool
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    // Turn on filtering, but no mipmaps!
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    return tex;
}