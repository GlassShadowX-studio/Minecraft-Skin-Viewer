import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let scene, camera, renderer, controls, playerModel, capeMesh;
let currentAction = 'idle';
let clock = new THREE.Clock();
let parts = {};
let currentSkinCanvas = null;
let currentCapeCanvas = null;
let isLegacySkin = false;

const toastEl = document.getElementById('toast');
function showToast(msg, type = '') {
    toastEl.textContent = msg;
    toastEl.className = 'toast show ' + type;
    setTimeout(() => { toastEl.className = 'toast'; }, 3000);
}

function loadTexture(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = url.startsWith('data:') ? undefined : 'anonymous';
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width; canvas.height = img.height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(img, 0, 0);
            resolve({ canvas: canvas });
        };
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = url;
    });
}

function detectModel(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const scaleU = canvas.width / 64;
    const scaleV = canvas.height / 64;
    let maxU = 0;
    for (let y = 16; y < 20; y++) {
        for (let x = 44; x < 56; x++) {
            if (ctx.getImageData(Math.round(x * scaleU), Math.round(y * scaleV), 1, 1).data[3] > 0 && x > maxU) maxU = x;
        }
    }
    return maxU >= 50 ? 'classic' : 'slim';
}

async function getPlayerData(id) {
    try {
        const profileRes = await fetch(`/api/profile/${id}`);
        if (!profileRes.ok) return null;
        const profile = await profileRes.json();
        const sessionRes = await fetch(`/api/session/${profile.id}`);
        if (!sessionRes.ok) return null;
        return await sessionRes.json();
    } catch (e) { return null; }
}

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf8f9fa);
    camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    document.getElementById('canvas-container').appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 12, 0);
    controls.minDistance = 20;
    controls.maxDistance = 80;
    controls.maxPolarAngle = Math.PI / 1.8;
    controls.autoRotate = document.getElementById('toggle-rotate').checked;
    controls.autoRotateSpeed = 1.5;

    const hemiLight = new THREE.HemisphereLight(0xffeedd, 0x8899aa, 0.7);
    hemiLight.position.set(0, 1, 0);
    scene.add(hemiLight);
    scene.add(new THREE.AmbientLight(0xffffff, 0.65));

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
    dirLight.position.set(8, 16, 12);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(2048, 2048);
    dirLight.shadow.camera.top = 20;
    dirLight.shadow.camera.bottom = -20;
    dirLight.shadow.camera.left = -20;
    dirLight.shadow.camera.right = 20;
    dirLight.shadow.bias = -0.0005;
    dirLight.shadow.normalBias = 0.02;
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0x8899cc, 0.25);
    fillLight.position.set(-5, 4, -8);
    scene.add(fillLight);

    window.addEventListener('resize', onWindowResize);
    onWindowResize();
    animate();
}

function onWindowResize() {
    const container = document.getElementById('canvas-container');
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
}

const FULL_BOX = (() => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    return { pos: geo.attributes.position.array, norm: geo.attributes.normal.array, idx: geo.index.array, vCount: geo.attributes.position.count };
})();

// 内层 & 披风：普通长方体 + 贴图 (6个面拼合)
function buildBasePlanes(facesConfig, canvas, texH) {
    const group = new THREE.Group();
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    
    const mat = new THREE.MeshLambertMaterial({ 
        map: tex, 
        transparent: true,
        alphaTest: 0.1, 
        side: THREE.DoubleSide 
    });

    const imgW = canvas.width;
    const imgH = canvas.height;

    facesConfig.forEach(face => {
        if (!face.uv) return;
        const [ox, oy, oz] = face.o3;
        const [ux, uy, uz] = face.uA;
        const [vx, vy, vz] = face.vA;
        const [u0, v0] = face.uv;
        const [w, h] = face.s;
        
        let u_min = u0 / imgW;
        let u_max = (u0 + w) / imgW;
        const v_min = 1.0 - (v0 + h) / imgH; 
        const v_max = 1.0 - v0 / imgH;       
        
        // 核心修复 1：披风 Back 面 UV 翻转，解决图案镜像/在里面的问题
        if (face.flipU) {
            [u_min, u_max] = [u_max, u_min];
        }
        
        const positions = new Float32Array(12);
        const normals = new Float32Array(12);
        const uvs = new Float32Array(8);
        
        positions[0] = ox; positions[1] = oy; positions[2] = oz;
        uvs[0] = u_min; uvs[1] = v_max;
        
        positions[3] = ox + w * ux; positions[4] = oy + w * uy; positions[5] = oz + w * uz;
        uvs[2] = u_max; uvs[3] = v_max;
        
        positions[6] = ox + h * vx; positions[7] = oy + h * vy; positions[8] = oz + h * vz;
        uvs[4] = u_min; uvs[5] = v_min;
        
        positions[9] = ox + w * ux + h * vx; positions[10] = oy + w * uy + h * vy; positions[11] = oz + w * uz + h * vz;
        uvs[6] = u_max; uvs[7] = v_min;
        
        const [nx, ny, nz] = face.n;
        for(let i=0; i<4; i++) {
            normals[i*3] = nx; normals[i*3+1] = ny; normals[i*3+2] = nz;
        }
        
        const indices = new Uint16Array([0, 2, 1, 1, 2, 3]);
        
        const planeGeo = new THREE.BufferGeometry();
        planeGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        planeGeo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        planeGeo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        planeGeo.setIndex(new THREE.BufferAttribute(indices, 1));
        
        const mesh = new THREE.Mesh(planeGeo, mat);
        mesh.castShadow = true;
        group.add(mesh);
    });
    
    return group;
}

// 外覆层：保持小方块 (Voxel) 渲染
function buildLayer(canvas, facesConfig, texH, boxTemplate, layerProp) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const positions = [], normals = [], colors = [], indices = [];
    let vertexOffset = 0;
    const bPos = boxTemplate.pos;
    const bNorm = boxTemplate.norm;
    const bIdx = boxTemplate.idx;

    const scaleU = canvas.width / 64;
    const scaleV = canvas.height / (texH || 64);

    function addVoxel(cx, cy, cz, r, g, b) {
        for (let i = 0; i < bPos.length; i += 3) {
            positions.push(bPos[i] + cx, bPos[i + 1] + cy, bPos[i + 2] + cz);
            normals.push(bNorm[i], bNorm[i + 1], bNorm[i + 2]);
            colors.push(r, g, b);
        }
        for (let i = 0; i < bIdx.length; i++) indices.push(bIdx[i] + vertexOffset);
        vertexOffset += boxTemplate.vCount;
    }

    facesConfig.forEach(face => {
        const uv = layerProp === 'base' ? face.uv : face.uvO;
        if (!uv) return;
        const offset = layerProp === 'base' ? (face.baseOffset != null ? face.baseOffset : 0) : (face.overlayOffset != null ? face.overlayOffset : 0);
        const [ox, oy, oz] = face.o3;
        const [ux, uy, uz] = face.uA;
        const [vx, vy, vz] = face.vA;
        const [nx, ny, nz] = face.n;
        const [u0, v0] = uv;
        const [w, h] = face.s;

        for (let i = 0; i < w; i++) {
            for (let j = 0; j < h; j++) {
                const u = u0 + i;
                const v = v0 + j;
                if (v >= texH) continue;
                const ru = Math.round(u * scaleU);
                const rv = Math.round(v * scaleV);
                const px = ctx.getImageData(ru, rv, 1, 1).data;
                if (px[3] < 10) continue;

                const cx = ox + (i + 0.5) * ux + (j + 0.5) * vx + offset * nx;
                const cy = oy + (i + 0.5) * uy + (j + 0.5) * vy + offset * ny;
                const cz = oz + (i + 0.5) * uz + (j + 0.5) * vz + offset * nz;

                // 核心修复 3：移除 Gamma 校正，直接传入 sRGB 值，解决外覆层颜色过暗问题
                const r = px[0] / 255;
                const g = px[1] / 255;
                const b = px[2] / 255;
                
                addVoxel(cx, cy, cz, r, g, b);
            }
        }
    });

    if (positions.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    return mesh;
}

function buildPart(canvas, facesConfig, texH, showOverlay, isLegacy) {
    const group = new THREE.Group();
    const baseMesh = buildBasePlanes(facesConfig, canvas, texH);
    if (baseMesh) group.add(baseMesh);

    if (showOverlay && !isLegacy) {
        const hasOverlay = facesConfig.some(f => f.uvO);
        if (hasOverlay) {
            const overlayMesh = buildLayer(canvas, facesConfig, texH, FULL_BOX, 'overlay');
            if (overlayMesh) group.add(overlayMesh);
        }
    }
    return group.children.length > 0 ? group : null;
}

function buildModel(canvas, isSlim, capeCanvas) {
    capeMesh = null;
    if (playerModel) {
        scene.remove(playerModel);
        playerModel.traverse(obj => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) obj.material.dispose();
        });
    }
    isLegacySkin = canvas.height === 32;
    const texH = isLegacySkin ? 32 : 64;
    const showOverlay = document.getElementById('toggle-overlay').checked;
    const armW = isSlim ? 3 : 4;

    const BO = 0.0;
    const OO = 0.5;
    
    const hw = armW / 2; 

    const headFaces = [
        { o3: [-4, 4, 4], uA: [1, 0, 0], vA: [0, -1, 0], n: [0, 0, 1], uv: [8, 8], s: [8, 8], uvO: [40, 8], baseOffset: BO, overlayOffset: OO },
        { o3: [4, 4, -4], uA: [-1, 0, 0], vA: [0, -1, 0], n: [0, 0, -1], uv: [24, 8], s: [8, 8], uvO: [56, 8], baseOffset: BO, overlayOffset: OO },
        { o3: [-4, 4, -4], uA: [0, 0, 1], vA: [0, -1, 0], n: [-1, 0, 0], uv: [0, 8], s: [8, 8], uvO: [32, 8], baseOffset: BO, overlayOffset: OO, flipU: true },
        { o3: [4, 4, 4], uA: [0, 0, -1], vA: [0, -1, 0], n: [1, 0, 0], uv: [16, 8], s: [8, 8], uvO: [48, 8], baseOffset: BO, overlayOffset: OO },
        { o3: [-4, 4, -4], uA: [1, 0, 0], vA: [0, 0, 1], n: [0, 1, 0], uv: [8, 0], s: [8, 8], uvO: [40, 0], baseOffset: BO, overlayOffset: OO },
        { o3: [-4, -4, -4], uA: [1, 0, 0], vA: [0, 0, 1], n: [0, -1, 0], uv: [16, 0], s: [8, 8], uvO: [48, 0], baseOffset: BO, overlayOffset: OO }
    ];

    const bodyFaces = [
        { o3: [-4, 6, 2], uA: [1, 0, 0], vA: [0, -1, 0], n: [0, 0, 1], uv: [20, 20], s: [8, 12], uvO: [20, 36], baseOffset: BO, overlayOffset: OO },
        { o3: [4, 6, -2], uA: [-1, 0, 0], vA: [0, -1, 0], n: [0, 0, -1], uv: [32, 20], s: [8, 12], uvO: [32, 36], baseOffset: BO, overlayOffset: OO },
        { o3: [-4, 6, -2], uA: [0, 0, 1], vA: [0, -1, 0], n: [-1, 0, 0], uv: [16, 20], s: [4, 12], uvO: [16, 36], baseOffset: BO, overlayOffset: OO, flipU: true },
        { o3: [4, 6, 2], uA: [0, 0, -1], vA: [0, -1, 0], n: [1, 0, 0], uv: [28, 20], s: [4, 12], uvO: [28, 36], baseOffset: BO, overlayOffset: OO },
        { o3: [-4, 6, -2], uA: [1, 0, 0], vA: [0, 0, 1], n: [0, 1, 0], uv: [20, 16], s: [8, 4], uvO: [20, 32], baseOffset: BO, overlayOffset: OO },
        { o3: [-4, -6, -2], uA: [1, 0, 0], vA: [0, 0, 1], n: [0, -1, 0], uv: [28, 16], s: [8, 4], uvO: [28, 32], baseOffset: BO, overlayOffset: OO }
    ];

    const rArmFaces = [
        { o3: [-hw, 0, 2], uA: [1, 0, 0], vA: [0, -1, 0], n: [0, 0, 1], uv: [44, 20], s: [armW, 12], uvO: [44, 36], baseOffset: BO, overlayOffset: OO },
        { o3: [hw, 0, -2], uA: [-1, 0, 0], vA: [0, -1, 0], n: [0, 0, -1], uv: [44 + armW * 2, 20], s: [armW, 12], uvO: [44 + armW * 2, 36], baseOffset: BO, overlayOffset: OO },
        { o3: [-hw, 0, -2], uA: [0, 0, 1], vA: [0, -1, 0], n: [-1, 0, 0], uv: [40, 20], s: [4, 12], uvO: [40, 36], baseOffset: BO, overlayOffset: OO, flipU: true },
        { o3: [hw, 0, 2], uA: [0, 0, -1], vA: [0, -1, 0], n: [1, 0, 0], uv: [44 + armW, 20], s: [4, 12], uvO: [44 + armW, 36], baseOffset: BO, overlayOffset: OO },
        { o3: [-hw, 0, -2], uA: [1, 0, 0], vA: [0, 0, 1], n: [0, 1, 0], uv: [44, 16], s: [armW, 4], uvO: [44, 32], baseOffset: BO, overlayOffset: OO },
        { o3: [-hw, -12, -2], uA: [1, 0, 0], vA: [0, 0, 1], n: [0, -1, 0], uv: [44 + armW, 16], s: [armW, 4], uvO: [44 + armW, 32], baseOffset: BO, overlayOffset: OO }
    ];

    const lArmFaces = isLegacySkin
        ? [ 
            { o3: [-hw, 0, 2], uA: [1, 0, 0], vA: [0, -1, 0], n: [0, 0, 1], uv: [44, 20], s: [armW, 12], uvO: null, baseOffset: BO, overlayOffset: OO },
            { o3: [hw, 0, -2], uA: [-1, 0, 0], vA: [0, -1, 0], n: [0, 0, -1], uv: [44 + armW * 2, 20], s: [armW, 12], uvO: null, baseOffset: BO, overlayOffset: OO },
            { o3: [-hw, 0, -2], uA: [0, 0, 1], vA: [0, -1, 0], n: [-1, 0, 0], uv: [40, 20], s: [4, 12], uvO: null, baseOffset: BO, overlayOffset: OO, flipU: true },
            { o3: [hw, 0, 2], uA: [0, 0, -1], vA: [0, -1, 0], n: [1, 0, 0], uv: [44 + armW, 20], s: [4, 12], uvO: null, baseOffset: BO, overlayOffset: OO },
            { o3: [-hw, 0, -2], uA: [1, 0, 0], vA: [0, 0, 1], n: [0, 1, 0], uv: [44, 16], s: [armW, 4], uvO: null, baseOffset: BO, overlayOffset: OO },
            { o3: [-hw, -12, -2], uA: [1, 0, 0], vA: [0, 0, 1], n: [0, -1, 0], uv: [44 + armW, 16], s: [armW, 4], uvO: null, baseOffset: BO, overlayOffset: OO }
          ]
        : [ 
            { o3: [-hw, 0, 2], uA: [1, 0, 0], vA: [0, -1, 0], n: [0, 0, 1], uv: [36, 52], s: [armW, 12], uvO: [52, 52], baseOffset: BO, overlayOffset: OO },
            { o3: [hw, 0, -2], uA: [-1, 0, 0], vA: [0, -1, 0], n: [0, 0, -1], uv: [36 + armW + 4, 52], s: [armW, 12], uvO: [52 + armW + 4, 52], baseOffset: BO, overlayOffset: OO },
            { o3: [-hw, 0, -2], uA: [0, 0, 1], vA: [0, -1, 0], n: [-1, 0, 0], uv: [32, 52], s: [4, 12], uvO: [48, 52], baseOffset: BO, overlayOffset: OO, flipU: true },
            { o3: [hw, 0, 2], uA: [0, 0, -1], vA: [0, -1, 0], n: [1, 0, 0], uv: [36 + armW, 52], s: [4, 12], uvO: [52 + armW, 52], baseOffset: BO, overlayOffset: OO },
            { o3: [-hw, 0, -2], uA: [1, 0, 0], vA: [0, 0, 1], n: [0, 1, 0], uv: [36, 48], s: [armW, 4], uvO: [52, 48], baseOffset: BO, overlayOffset: OO },
            { o3: [-hw, -12, -2], uA: [1, 0, 0], vA: [0, 0, 1], n: [0, -1, 0], uv: [36 + armW, 48], s: [armW, 4], uvO: [52 + armW, 48], baseOffset: BO, overlayOffset: OO }
          ];

    const rLegFaces = [
        { o3: [-2, 0, 2], uA: [1, 0, 0], vA: [0, -1, 0], n: [0, 0, 1], uv: [4, 20], s: [4, 12], uvO: [4, 36], baseOffset: BO, overlayOffset: OO },
        { o3: [2, 0, -2], uA: [-1, 0, 0], vA: [0, -1, 0], n: [0, 0, -1], uv: [12, 20], s: [4, 12], uvO: [12, 36], baseOffset: BO, overlayOffset: OO },
        { o3: [-2, 0, -2], uA: [0, 0, 1], vA: [0, -1, 0], n: [-1, 0, 0], uv: [0, 20], s: [4, 12], uvO: [0, 36], baseOffset: BO, overlayOffset: OO, flipU: true },
        { o3: [2, 0, 2], uA: [0, 0, -1], vA: [0, -1, 0], n: [1, 0, 0], uv: [8, 20], s: [4, 12], uvO: [8, 36], baseOffset: BO, overlayOffset: OO },
        { o3: [-2, 0, -2], uA: [1, 0, 0], vA: [0, 0, 1], n: [0, 1, 0], uv: [4, 16], s: [4, 4], uvO: [4, 32], baseOffset: BO, overlayOffset: OO },
        { o3: [-2, -12, -2], uA: [1, 0, 0], vA: [0, 0, 1], n: [0, -1, 0], uv: [8, 16], s: [4, 4], uvO: [8, 32], baseOffset: BO, overlayOffset: OO }
    ];

    const lLegFaces = [
        { o3: [-2, 0, 2], uA: [1, 0, 0], vA: [0, -1, 0], n: [0, 0, 1], uv: isLegacySkin ? [4, 20] : [20, 52], s: [4, 12], uvO: isLegacySkin ? null : [4, 52], baseOffset: BO, overlayOffset: OO },
        { o3: [2, 0, -2], uA: [-1, 0, 0], vA: [0, -1, 0], n: [0, 0, -1], uv: isLegacySkin ? [12, 20] : [28, 52], s: [4, 12], uvO: isLegacySkin ? null : [12, 52], baseOffset: BO, overlayOffset: OO },
        { o3: [-2, 0, -2], uA: [0, 0, 1], vA: [0, -1, 0], n: [-1, 0, 0], uv: isLegacySkin ? [0, 20] : [16, 52], s: [4, 12], uvO: isLegacySkin ? null : [0, 52], baseOffset: BO, overlayOffset: OO, flipU: true },
        { o3: [2, 0, 2], uA: [0, 0, -1], vA: [0, -1, 0], n: [1, 0, 0], uv: isLegacySkin ? [8, 20] : [24, 52], s: [4, 12], uvO: isLegacySkin ? null : [8, 52], baseOffset: BO, overlayOffset: OO },
        { o3: [-2, 0, -2], uA: [1, 0, 0], vA: [0, 0, 1], n: [0, 1, 0], uv: isLegacySkin ? [4, 16] : [20, 48], s: [4, 4], uvO: isLegacySkin ? null : [4, 48], baseOffset: BO, overlayOffset: OO },
        { o3: [-2, -12, -2], uA: [1, 0, 0], vA: [0, 0, 1], n: [0, -1, 0], uv: isLegacySkin ? [8, 16] : [24, 48], s: [4, 4], uvO: isLegacySkin ? null : [8, 48], baseOffset: BO, overlayOffset: OO }
    ];

    playerModel = new THREE.Group();

    // 核心修复 2：手臂 Pivot 向身体内部微调 0.1，消除共面 Z-fighting 导致的透明缝隙
    const PIVOTS = {
        head: [0, 28, 0],
        body: [0, 18, 0],
        rightLeg: [-2, 12, 0],
        leftLeg: [2, 12, 0],
        rightArm: [-(4 + hw - 0.1), 24, 0], 
        leftArm: [(4 + hw - 0.1), 24, 0]
    };

    parts.headGroup = new THREE.Group();
    const headPart = buildPart(canvas, headFaces, texH, showOverlay, isLegacySkin);
    if (headPart) parts.headGroup.add(headPart);
    parts.headGroup.position.set(...PIVOTS.head);
    playerModel.add(parts.headGroup);

    parts.bodyGroup = new THREE.Group();
    const bodyPart = buildPart(canvas, bodyFaces, texH, showOverlay, isLegacySkin);
    if (bodyPart) parts.bodyGroup.add(bodyPart);
    parts.bodyGroup.position.set(...PIVOTS.body);
    playerModel.add(parts.bodyGroup);

    parts.rightArm = new THREE.Group();
    const rArmPart = buildPart(canvas, rArmFaces, texH, showOverlay, isLegacySkin);
    if (rArmPart) parts.rightArm.add(rArmPart);
    parts.rightArm.position.set(...PIVOTS.rightArm);
    playerModel.add(parts.rightArm);

    parts.leftArm = new THREE.Group();
    const lArmPart = buildPart(canvas, lArmFaces, texH, showOverlay, isLegacySkin);
    if (lArmPart) parts.leftArm.add(lArmPart);
    parts.leftArm.position.set(...PIVOTS.leftArm);
    playerModel.add(parts.leftArm);

    parts.rightLeg = new THREE.Group();
    const rLegPart = buildPart(canvas, rLegFaces, texH, showOverlay, isLegacySkin);
    if (rLegPart) parts.rightLeg.add(rLegPart);
    parts.rightLeg.position.set(...PIVOTS.rightLeg);
    playerModel.add(parts.rightLeg);

    parts.leftLeg = new THREE.Group();
    const lLegPart = buildPart(canvas, lLegFaces, texH, showOverlay, isLegacySkin);
    if (lLegPart) parts.leftLeg.add(lLegPart);
    parts.leftLeg.position.set(...PIVOTS.leftLeg);
    playerModel.add(parts.leftLeg);

    if (capeCanvas) {
        const capeH = capeCanvas.height;
        const capeFaces = [
            { o3: [-5, 0, 0.5], uA: [1, 0, 0], vA: [0, -1, 0], n: [0, 0, -1], uv: [12, 1], s: [10, 16], flipU: true }, // Front
            { o3: [5, 0, -0.5], uA: [-1, 0, 0], vA: [0, -1, 0], n: [0, 0, 1], uv: [1, 1], s: [10, 16] }, // Back
            { o3: [5, 0, 0.5], uA: [0, 0, -1], vA: [0, -1, 0], n: [1, 0, 0], uv: [0, 1], s: [1, 16] }, // Right
            { o3: [-5, 0, -0.5], uA: [0, 0, 1], vA: [0, -1, 0], n: [-1, 0, 0], uv: [11, 1], s: [1, 16] }, // Left
            { o3: [-5, 0, -0.5], uA: [1, 0, 0], vA: [0, 0, 1], n: [0, 1, 0], uv: [1, 0], s: [10, 1] }, // Top
            { o3: [-5, -16, 0.5], uA: [1, 0, 0], vA: [0, 0, -1], n: [0, -1, 0], uv: [12, 0], s: [10, 1] } // Bottom
        ];
        const capePart = buildBasePlanes(capeFaces, capeCanvas, capeH);
        if (capePart) {
            capePart.position.set(0, 4, -2.5);
            parts.bodyGroup.add(capePart);
            capeMesh = capePart;
        }
    }
    playerModel.position.y = -14;
    scene.add(playerModel);
}

function resetPose() {
    if (!playerModel) return;
    parts.headGroup.rotation.set(0, 0, 0);
    parts.bodyGroup.rotation.set(0, 0, 0);
    parts.rightArm.rotation.set(0, 0, 0);
    parts.leftArm.rotation.set(0, 0, 0);
    parts.rightLeg.rotation.set(0, 0, 0);
    parts.leftLeg.rotation.set(0, 0, 0);
    playerModel.position.y = -14;
}

function applyAction(action, time) {
    const t = time * 5;
    switch (action) {
        case 'idle':
            parts.headGroup.rotation.y = Math.sin(time * 1.5) * 0.1;
            parts.rightArm.rotation.x = Math.sin(time * 2) * 0.03;
            parts.leftArm.rotation.x = Math.sin(time * 2 + 1) * 0.03;
            break;
        case 'walk':
            parts.rightArm.rotation.x = Math.sin(t) * 0.8;
            parts.leftArm.rotation.x = -Math.sin(t) * 0.8;
            parts.rightLeg.rotation.x = -Math.sin(t) * 0.8;
            parts.leftLeg.rotation.x = Math.sin(t) * 0.8;
            break;
        case 'run':
            parts.bodyGroup.rotation.x = -0.2;
            parts.rightArm.rotation.x = Math.sin(t) * 1.2 - 0.5;
            parts.leftArm.rotation.x = -Math.sin(t) * 1.2 - 0.5;
            parts.rightLeg.rotation.x = -Math.sin(t) * 1.2;
            parts.leftLeg.rotation.x = Math.sin(t) * 1.2;
            break;
        case 'wave':
            parts.rightArm.rotation.z = Math.sin(t * 2) * 0.5 - 2.5;
            break;
        case 'jump':
            const jp = (time * 2) % 1;
            let jy = 0;
            if (jp < 0.2) jy = 0;
            else if (jp < 0.5) jy = Math.sin((jp - 0.2) / 0.3 * Math.PI) * 5;
            playerModel.position.y = -14 + jy;
            parts.rightArm.rotation.x = jp < 0.5 ? -2.5 : -0.5;
            parts.leftArm.rotation.x = jp < 0.5 ? -2.5 : -0.5;
            break;
        case 'dance':
            parts.rightArm.rotation.z = Math.sin(t) * 0.5 - 1.5;
            parts.leftArm.rotation.z = -Math.sin(t) * 0.5 + 1.5;
            parts.bodyGroup.rotation.y = Math.sin(t * 2) * 0.3;
            break;
        case 'fight':
            parts.rightArm.rotation.x = Math.sin(t * 4) * 0.5 - 1.5;
            parts.leftArm.rotation.x = -1.0;
            parts.leftArm.rotation.z = 0.3;
            break;
        case 'sit':
            playerModel.position.y = -22;
            parts.rightLeg.rotation.x = -1.5;
            parts.leftLeg.rotation.x = -1.5;
            parts.rightArm.rotation.x = -0.5;
            parts.leftArm.rotation.x = -0.5;
            break;
    }
}

function animate() {
    requestAnimationFrame(animate);
    const time = clock.getElapsedTime();
    if (playerModel) {
        resetPose();
        applyAction(currentAction, time);
        if (capeMesh) {
            capeMesh.visible = document.getElementById('toggle-cape').checked;
            if (capeMesh.visible) {
                capeMesh.rotation.y = Math.sin(time * 1.5) * 0.10;
                capeMesh.rotation.x = 0.15 + Math.sin(time * 2) * 0.1; 
            }
        }
    }
    controls.autoRotate = document.getElementById('toggle-rotate').checked;
    renderer.shadowMap.enabled = document.getElementById('toggle-shadows').checked;
    controls.update();
    renderer.render(scene, camera);
}

async function loadSkin() {
    const id = document.getElementById('player-id').value.trim();
    if (!id) return;
    showToast('正在通过 Node 代理获取官方数据...', '');
    try {
        const data = await getPlayerData(id);
        if (!data) { showToast('未找到该玩家', 'error'); return; }
        let skinUrl = data.skinUrl;
        let isSlim = data.model === 'slim';
        if (!skinUrl) skinUrl = `/api/default-skin/${isSlim ? 'slim' : 'classic'}`;
        else skinUrl = `/api/texture?url=${encodeURIComponent(skinUrl)}`;

        const skinData = await loadTexture(skinUrl);
        currentSkinCanvas = skinData.canvas;
        let capeCanvas = null;
        if (data.capeUrl) {
            try {
                const proxiedCapeUrl = `/api/texture?url=${encodeURIComponent(data.capeUrl)}`;
                const capeData = await loadTexture(proxiedCapeUrl);
                capeCanvas = capeData.canvas;
                currentCapeCanvas = capeCanvas;
            } catch (e) { console.warn('Cape load failed:', e); }
        }
        document.getElementById('toggle-slim').checked = isSlim;
        buildModel(currentSkinCanvas, isSlim, capeCanvas);
        showToast('加载成功 (Voxel 3D)', 'success');
    } catch (err) { console.error('loadSkin error:', err); showToast('皮肤加载失败: ' + (err.message || err), 'error'); }
}

async function loadLocalSkin(dataUrl) {
    try {
        showToast('正在加载本地皮肤...', '');
        const skinData = await loadTexture(dataUrl);
        currentSkinCanvas = skinData.canvas;
        currentCapeCanvas = null;
        const isSlim = detectModel(currentSkinCanvas) === 'slim';
        document.getElementById('toggle-slim').checked = isSlim;
        buildModel(currentSkinCanvas, isSlim, null);
        showToast('本地皮肤加载成功', 'success');
    } catch (err) { console.error('loadLocalSkin error:', err); showToast('本地皮肤加载失败: ' + (err.message || err), 'error'); }
}

document.getElementById('search-btn').addEventListener('click', loadSkin);
document.getElementById('player-id').addEventListener('keypress', (e) => { if (e.key === 'Enter') loadSkin(); });
document.getElementById('upload-btn').addEventListener('click', () => document.getElementById('file-input').click());
document.getElementById('file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => loadLocalSkin(event.target.result);
    reader.readAsDataURL(file);
});

const customSelect = document.getElementById('action-select');
const selectedDiv = customSelect.querySelector('.select-selected');
const itemsDiv = customSelect.querySelector('.select-items');
const itemDivs = itemsDiv.querySelectorAll('div');
selectedDiv.addEventListener('click', (e) => {
    e.stopPropagation();
    itemsDiv.classList.toggle('select-hide');
    customSelect.classList.toggle('active');
});
itemDivs.forEach(item => {
    item.addEventListener('click', (e) => {
        currentAction = e.target.getAttribute('data-value');
        selectedDiv.querySelector('span').textContent = e.target.textContent;
        itemsDiv.classList.add('select-hide');
        customSelect.classList.remove('active');
    });
});

const optionsBtn = document.getElementById('options-btn');
const optionsPanel = document.getElementById('options-panel');
optionsBtn.addEventListener('click', (e) => { e.stopPropagation(); optionsPanel.classList.toggle('active'); });
document.addEventListener('click', (e) => {
    if (!optionsPanel.contains(e.target) && e.target !== optionsBtn) optionsPanel.classList.remove('active');
    if (!customSelect.contains(e.target)) {
        itemsDiv.classList.add('select-hide');
        customSelect.classList.remove('active');
    }
});

document.getElementById('toggle-overlay').addEventListener('change', () => {
    if (currentSkinCanvas) buildModel(currentSkinCanvas, document.getElementById('toggle-slim').checked, currentCapeCanvas);
});
document.getElementById('toggle-slim').addEventListener('change', () => {
    if (currentSkinCanvas) buildModel(currentSkinCanvas, document.getElementById('toggle-slim').checked, currentCapeCanvas);
});

init();