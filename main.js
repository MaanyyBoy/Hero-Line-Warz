import * as THREE from 'https://unpkg.com/three@0.170.0/build/three.module.js';

// ============================================================
// THREE.JS GRUND-SETUP
// ============================================================

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14202c);
scene.fog = new THREE.Fog(0x14202c, 30, 75);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);

// Bloom-postprocessing borttagen tillfälligt — three.js' addons använder bare-specifier
// 'three' internt vilket kräver importmap som inte funkar i alla browsers.
// Återinförs när vi har ett mer browser-säkert sätt (esm.sh eller liknande).
const bloomComposer = null;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ============================================================
// STATIC SCENE (mark, väggar, lanes, baser, torn, ljus)
// ============================================================

const towerMeshes = {};         // mappar sida → fontän-rig (kvar i gamla namnet pga refs i renderloop)
const campfires = {};           // sida → lägereld-rig (för flame-animation)
const FOUNTAIN_AURA_RADIUS = 4.5; // meter — närhet till egen fontän för aura
const FOUNTAIN_AURA_RADIUS_SQ = FOUNTAIN_AURA_RADIUS * FOUNTAIN_AURA_RADIUS;
const FOUNTAIN_AURA_REGEN_PCT = 0.02; // 2% av maxHp per sekund
const FOUNTAIN_AURA_PCT = 0.10;
const FOUNTAIN_DMG_MUL = 1 + FOUNTAIN_AURA_PCT;
const FOUNTAIN_DMG_REDUCTION_MUL = 1 - FOUNTAIN_AURA_PCT;
const FOUNTAIN_CDR_MUL = 1 + FOUNTAIN_AURA_PCT;
const FOUNTAIN_AS_MUL = 1 + FOUNTAIN_AURA_PCT;

// ---- Procedurella canvas-texturer ----

function makeNoiseTexture(baseColor, variance = 0.15, opts = {}) {
  const w = opts.w || 128;
  const h = opts.h || 128;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    // Två oktaver av additivt brus → mjukare variation
    const v = 1 - variance + (Math.random() * 0.5 + Math.random() * 0.5) * variance * 2;
    img.data[i*4]   = Math.min(255, Math.max(0, baseColor[0] * v));
    img.data[i*4+1] = Math.min(255, Math.max(0, baseColor[1] * v));
    img.data[i*4+2] = Math.min(255, Math.max(0, baseColor[2] * v));
    img.data[i*4+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // Detalj-specks
  const specks = opts.specks ?? Math.floor(w * h / 25);
  const sc = opts.speckColor || [baseColor[0]+30, baseColor[1]+45, baseColor[2]+20];
  for (let i = 0; i < specks; i++) {
    const x = Math.random() * w | 0, y = Math.random() * h | 0;
    ctx.fillStyle = `rgba(${sc[0]|0},${sc[1]|0},${sc[2]|0},${(0.3 + Math.random()*0.4).toFixed(2)})`;
    ctx.fillRect(x, y, 1, opts.streaks ? 2 : 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(opts.repeatX || 4, opts.repeatY || 4);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Öken-lane med trampad stig i mitten — sandbas, mörkare dirt-band, stenar, gräs, hovmärken.
// Tecknas i lane-aspekt (long×wide). Används med repeat=(1,1) per lane så ingen synlig kakling.
function makeDesertLaneTexture(seed = 1) {
  // Pseudo-random med deterministisk seed så varje lane ser likadan ut mellan reloads
  let s = seed * 2654435761 >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s >>> 0) / 0xFFFFFFFF; };
  const W = 2048, H = 384;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  // 1) Sandbas — varm tan med gradient + noise
  const sandGrad = ctx.createLinearGradient(0, 0, 0, H);
  sandGrad.addColorStop(0, '#c9a872');
  sandGrad.addColorStop(0.5, '#d4b682');
  sandGrad.addColorStop(1, '#c9a872');
  ctx.fillStyle = sandGrad;
  ctx.fillRect(0, 0, W, H);
  // Sand-noise (små prickar)
  for (let i = 0; i < 6000; i++) {
    const x = rnd() * W, y = rnd() * H;
    const a = 0.04 + rnd() * 0.10;
    const tone = rnd() < 0.5 ? '255, 240, 200' : '120, 90, 50';
    ctx.fillStyle = `rgba(${tone}, ${a})`;
    ctx.fillRect(x, y, 1 + rnd() * 1.5, 1 + rnd() * 1.5);
  }

  // 2) Trampad stig — mörkare dirt-band genom mitten, oregelbundna kanter
  const pathCenterY = H * 0.5;
  const pathHalfH = H * 0.18; // ca 36% av höjden = ~2.2m bred stig på 6m lane
  // Rita med segment där kanten "wobblar" lite
  ctx.save();
  ctx.beginPath();
  const segments = 80;
  ctx.moveTo(0, pathCenterY - pathHalfH);
  for (let i = 0; i <= segments; i++) {
    const x = (i / segments) * W;
    const wob = (rnd() - 0.5) * H * 0.06;
    ctx.lineTo(x, pathCenterY - pathHalfH + wob);
  }
  for (let i = segments; i >= 0; i--) {
    const x = (i / segments) * W;
    const wob = (rnd() - 0.5) * H * 0.06;
    ctx.lineTo(x, pathCenterY + pathHalfH + wob);
  }
  ctx.closePath();
  ctx.fillStyle = '#7a5a36';
  ctx.fill();
  // Inre tonvariation på stigen
  ctx.clip();
  for (let i = 0; i < 800; i++) {
    const x = rnd() * W, y = pathCenterY + (rnd() - 0.5) * pathHalfH * 2.2;
    const a = 0.10 + rnd() * 0.20;
    const dark = rnd() < 0.4;
    ctx.fillStyle = dark ? `rgba(45, 28, 12, ${a})` : `rgba(180, 140, 90, ${a * 0.6})`;
    const r = 1 + rnd() * 3;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  // Hovmärken — små mörka ellipser, oftast i par längs stigen
  for (let i = 0; i < 120; i++) {
    const x = rnd() * W;
    const y = pathCenterY + (rnd() - 0.5) * pathHalfH * 1.6;
    const rot = (rnd() - 0.5) * 0.6;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.fillStyle = `rgba(30, 18, 8, ${0.35 + rnd() * 0.25})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, 4 + rnd() * 2, 2.5 + rnd() * 1.5, 0, 0, Math.PI * 2);
    ctx.fill();
    // Liten "U-form" som hov-tryck
    ctx.fillStyle = `rgba(20, 12, 5, ${0.45})`;
    ctx.beginPath();
    ctx.ellipse(0, -1, 3, 1.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  // 3) Stenar — spridda över hela lane med fler vid stigens kant
  for (let i = 0; i < 90; i++) {
    const x = rnd() * W;
    // Bias mot kanterna men tillåt överallt
    const yRand = rnd();
    const y = yRand * H;
    const r = 2 + rnd() * 5;
    const grey = 90 + Math.floor(rnd() * 70);
    // Stenkropp
    ctx.fillStyle = `rgb(${grey}, ${grey - 5}, ${grey - 15})`;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.7 + rnd() * 0.4), rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
    // Highlight ovanpå
    ctx.fillStyle = `rgba(255, 250, 230, 0.25)`;
    ctx.beginPath();
    ctx.ellipse(x - r * 0.3, y - r * 0.3, r * 0.5, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    // Skugga
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.beginPath();
    ctx.ellipse(x + r * 0.2, y + r * 0.5, r * 0.9, r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 4) Gräs-tofsar — slumpvis, mest vid kanterna (utanför stigen)
  for (let i = 0; i < 70; i++) {
    const x = rnd() * W;
    // Bias mot top/bottom-kanterna
    const edge = rnd() < 0.5 ? rnd() * (pathCenterY - pathHalfH - 4) : (pathCenterY + pathHalfH + 4) + rnd() * (H - (pathCenterY + pathHalfH + 4));
    const y = edge;
    // Liten klump av gräsblad
    const blades = 4 + Math.floor(rnd() * 5);
    for (let b = 0; b < blades; b++) {
      const bx = x + (rnd() - 0.5) * 6;
      const by = y + (rnd() - 0.5) * 3;
      const len = 3 + rnd() * 5;
      const sway = (rnd() - 0.5) * 1.5;
      const green = 80 + Math.floor(rnd() * 70);
      ctx.strokeStyle = `rgb(${60 + Math.floor(rnd()*30)}, ${green}, ${40 + Math.floor(rnd()*20)})`;
      ctx.lineWidth = 1 + rnd();
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + sway, by - len);
      ctx.stroke();
    }
  }

  // 5) Lite ljust damm/dust kvar på sanden runt stigen
  for (let i = 0; i < 200; i++) {
    const x = rnd() * W;
    const y = pathCenterY + (rnd() < 0.5 ? -1 : 1) * (pathHalfH + rnd() * H * 0.12);
    const a = 0.06 + rnd() * 0.10;
    ctx.fillStyle = `rgba(160, 130, 90, ${a})`;
    ctx.beginPath();
    ctx.arc(x, y, 2 + rnd() * 4, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Bas-camp golv — mörk packad jord matchande stig-färgen, med grus och slitage
function makeCampGroundTexture(seed = 99) {
  let s = seed * 2654435761 >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s >>> 0) / 0xFFFFFFFF; };
  const W = 1024, H = 768;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  // Mörk dirt-bas (matchar stigen) — radial fade till lite ljusare vid ytterkanten
  const grad = ctx.createRadialGradient(W / 2, H / 2, 50, W / 2, H / 2, Math.max(W, H));
  grad.addColorStop(0, '#6b4d2c');
  grad.addColorStop(0.5, '#7a5a36');
  grad.addColorStop(1, '#8a6840');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Tonvariation — fläckar i ljusare/mörkare nyanser
  for (let i = 0; i < 90; i++) {
    const x = rnd() * W, y = rnd() * H;
    const r = 10 + rnd() * 40;
    const dark = rnd() < 0.5;
    ctx.fillStyle = dark
      ? `rgba(40, 26, 12, ${0.15 + rnd() * 0.15})`
      : `rgba(180, 140, 90, ${0.06 + rnd() * 0.08})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  // Grus & småsten
  for (let i = 0; i < 280; i++) {
    const x = rnd() * W, y = rnd() * H;
    const r = 1.5 + rnd() * 3;
    const grey = 90 + Math.floor(rnd() * 70);
    ctx.fillStyle = `rgb(${grey}, ${grey - 5}, ${grey - 12})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255, 250, 230, 0.22)';
    ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.4, 0, Math.PI * 2); ctx.fill();
  }

  // Noise
  for (let i = 0; i < 4000; i++) {
    const x = rnd() * W, y = rnd() * H;
    ctx.fillStyle = `rgba(${rnd() < 0.5 ? '255, 230, 180' : '30, 18, 8'}, ${0.04 + rnd() * 0.08})`;
    ctx.fillRect(x, y, 1.2, 1.2);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Trail-extension med alpha-fade — placeras ovanpå basgolvet där stigen kommer ut ur en lane
function makeTrailFadeTexture(seed = 7) {
  let s = seed * 2654435761 >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s >>> 0) / 0xFFFFFFFF; };
  const W = 512, H = 192;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  // Bas: stigens dirt-färg
  ctx.fillStyle = '#7a5a36';
  ctx.fillRect(0, 0, W, H);

  // Lite tonvariation
  for (let i = 0; i < 200; i++) {
    const x = rnd() * W, y = rnd() * H;
    const r = 2 + rnd() * 6;
    const dark = rnd() < 0.5;
    ctx.fillStyle = dark
      ? `rgba(35, 20, 8, ${0.2 + rnd() * 0.25})`
      : `rgba(170, 130, 80, ${0.1 + rnd() * 0.15})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  // Hovmärken — tunnare och mer utspridda mot slutet
  for (let i = 0; i < 30; i++) {
    const x = rnd() * W;
    const y = H * 0.5 + (rnd() - 0.5) * H * 0.6;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((rnd() - 0.5) * 0.6);
    ctx.fillStyle = `rgba(25, 14, 5, ${0.4 + rnd() * 0.25})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, 4 + rnd() * 2, 2.5 + rnd() * 1.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ALPHA FADE — opaque vänster (mot lanen), helt transparent höger (in i basen)
  // Använder destination-out så vi raderar enligt alpha-gradient
  const fade = ctx.createLinearGradient(0, 0, W, 0);
  fade.addColorStop(0.0, 'rgba(0,0,0,0.0)');   // ingen radering vänster (full opacity)
  fade.addColorStop(0.4, 'rgba(0,0,0,0.2)');   // börjar fade:a
  fade.addColorStop(0.8, 'rgba(0,0,0,0.85)');  // nästan borta
  fade.addColorStop(1.0, 'rgba(0,0,0,1.0)');   // helt transparent höger
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';

  // Mjuka även top/bottom-kanten lite (så stigens kant smälter)
  const vfade = ctx.createLinearGradient(0, 0, 0, H);
  vfade.addColorStop(0.0, 'rgba(0,0,0,0.6)');
  vfade.addColorStop(0.15, 'rgba(0,0,0,0.0)');
  vfade.addColorStop(0.85, 'rgba(0,0,0,0.0)');
  vfade.addColorStop(1.0, 'rgba(0,0,0,0.6)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = vfade;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Elven sten-textur med flowing leaf/swirl-etsningar — för Rivendell-fontänen
function makeElvenStoneTexture(seed = 33) {
  let s = seed * 2654435761 >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s >>> 0) / 0xFFFFFFFF; };
  const W = 512, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  // Bas: kall ljus sten (silver/blå-vit)
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#d8dde5');
  grad.addColorStop(0.5, '#c0c8d2');
  grad.addColorStop(1, '#a8b3c0');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Subtil marmor-ådring
  for (let i = 0; i < 12; i++) {
    ctx.strokeStyle = `rgba(180, 190, 205, ${0.18 + rnd() * 0.12})`;
    ctx.lineWidth = 1 + rnd() * 1.5;
    ctx.beginPath();
    let x = rnd() * W, y = rnd() * H;
    ctx.moveTo(x, y);
    for (let k = 0; k < 8; k++) {
      x += (rnd() - 0.5) * 80;
      y += (rnd() - 0.5) * 80;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Subtil noise
  for (let i = 0; i < 3000; i++) {
    const x = rnd() * W, y = rnd() * H;
    ctx.fillStyle = `rgba(${rnd() < 0.5 ? '255, 255, 255' : '90, 100, 120'}, ${0.05 + rnd() * 0.09})`;
    ctx.fillRect(x, y, 1.4, 1.4);
  }

  // Etsade flowing swirl/leaf-mönster — tunna mörkblå linjer
  ctx.strokeStyle = 'rgba(60, 90, 140, 0.55)';
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';

  // Tre stora vågor av mönster (kommer från olika hörn)
  function drawSwirl(cx, cy, scale, rotation) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    ctx.scale(scale, scale);

    // Huvudkurva (S-form)
    ctx.beginPath();
    ctx.moveTo(-40, -30);
    ctx.bezierCurveTo(-20, -60, 20, -40, 30, -10);
    ctx.bezierCurveTo(35, 10, 20, 20, 0, 25);
    ctx.bezierCurveTo(-20, 30, -30, 15, -20, 0);
    ctx.stroke();

    // Bladdetalj
    ctx.beginPath();
    ctx.moveTo(20, -15);
    ctx.quadraticCurveTo(35, -20, 40, -5);
    ctx.quadraticCurveTo(30, 0, 20, -15);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-5, 18);
    ctx.quadraticCurveTo(-15, 25, -22, 14);
    ctx.quadraticCurveTo(-12, 10, -5, 18);
    ctx.stroke();

    // Liten kvist
    ctx.beginPath();
    ctx.moveTo(30, -10);
    ctx.lineTo(45, -18);
    ctx.moveTo(28, -8);
    ctx.lineTo(36, 4);
    ctx.stroke();

    ctx.restore();
  }
  // Sprid swirls med olika rotation/scale
  for (let i = 0; i < 8; i++) {
    const cx = rnd() * W;
    const cy = rnd() * H;
    const sc = 0.7 + rnd() * 1.2;
    drawSwirl(cx, cy, sc, rnd() * Math.PI * 2);
  }

  // Liten star/sparkle ovanpå mönstret för Elven-feel
  ctx.fillStyle = 'rgba(180, 210, 240, 0.6)';
  for (let i = 0; i < 18; i++) {
    const x = rnd() * W, y = rnd() * H;
    const sz = 1.5 + rnd() * 2;
    ctx.beginPath();
    ctx.moveTo(x, y - sz * 2);
    ctx.lineTo(x + sz * 0.4, y - sz * 0.4);
    ctx.lineTo(x + sz * 2, y);
    ctx.lineTo(x + sz * 0.4, y + sz * 0.4);
    ctx.lineTo(x, y + sz * 2);
    ctx.lineTo(x - sz * 0.4, y + sz * 0.4);
    ctx.lineTo(x - sz * 2, y);
    ctx.lineTo(x - sz * 0.4, y - sz * 0.4);
    ctx.closePath();
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const TEXTURES = {
  groundGrass: () => makeNoiseTexture([42, 60, 32], 0.2, { repeatX: 14, repeatY: 7, streaks: true }),
  desertLane: (seed) => makeDesertLaneTexture(seed),
  campGround: (seed) => makeCampGroundTexture(seed),
  trailFade: (seed) => makeTrailFadeTexture(seed),
  elvenStone: (seed) => makeElvenStoneTexture(seed),
  stoneWall: () => makeNoiseTexture([90, 84, 75], 0.18, { repeatX: 8, repeatY: 1.2, speckColor: [50, 45, 40] }),
  stoneTower: () => makeNoiseTexture([135, 130, 120], 0.14, { repeatX: 3, repeatY: 2, speckColor: [180, 175, 165] }),
};

(function buildStaticScene() {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(140, 70),
    new THREE.MeshStandardMaterial({ map: TEXTURES.groundGrass(), color: 0xaaaaaa, roughness: 1.0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Bas-camp: packad sandig jord runt fontänen
  function makeBaseFloor(cz, seed) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 14),
      new THREE.MeshStandardMaterial({ map: TEXTURES.campGround(seed), color: 0xffffff, roughness: 0.95 })
    );
    mesh.rotation.x = -Math.PI / 2; mesh.position.set(19, 0.02, cz);
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  makeBaseFloor(7.5, 11);
  makeBaseFloor(-7.5, 23);

  // Lane: öken med trampad stig. Unik seed per lane så de skiljer sig något.
  function makeLane(cx, cz, length, width, seed) {
    const lane = new THREE.Mesh(
      new THREE.PlaneGeometry(length, width),
      new THREE.MeshStandardMaterial({ map: TEXTURES.desertLane(seed), color: 0xffffff, roughness: 0.95 })
    );
    lane.rotation.x = -Math.PI / 2; lane.position.set(cx, 0.02, cz);
    lane.receiveShadow = true;
    scene.add(lane);
  }
  // Lane-mesh slutar exakt vid bas-golvets västkant (x=10) — undviker z-fight i overlappet
  makeLane(-9, 12, 38, 6, 1);
  makeLane(-9, 4,  38, 6, 2);
  makeLane(-9, -4, 38, 6, 3);
  makeLane(-9, -12, 38, 6, 4);

  const wallTex = TEXTURES.stoneWall();
  function makeWall(cx, cz, w, d, h = 1.2) {
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ map: wallTex, color: 0xffffff, roughness: 0.85 })
    );
    wall.position.set(cx, h / 2, cz);
    wall.castShadow = true;
    wall.receiveShadow = true;
    scene.add(wall);
  }
  makeWall(-1, 15.15, 58, 0.3);     // Norra yttervägg
  makeWall(-1, -15.15, 58, 0.3);    // Södra yttervägg
  makeWall(28.15, 0, 0.3, 30.6);    // Östra bakvägg
  makeWall(-28.15, 0, 0.3, 30.6);   // Västra bakvägg
  makeWall(0, 0, 56.6, 0.3);        // MITTVÄGG (separerar arenor)
  makeWall(-8.5, 8, 39, 0.3);       // Skiljevägg sida 1
  makeWall(-8.5, -8, 39, 0.3);      // Skiljevägg sida 2

  // Sten-textur för dekor (lägereld, portaler) — varmare sten-look
  const towerStoneTex = TEXTURES.stoneTower();
  // Rivendell-fontän — bredare basin, slanka kolonner, central spira med band, översta skål med kristall.
  // Eleven sten-textur med ranka/leaf-etsningar.
  const elvenStoneTex = TEXTURES.elvenStone(33);
  const elvenStoneTexDark = TEXTURES.elvenStone(58);
  function makeFountain(x, z, glowColor) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);

    const stoneLight = new THREE.MeshStandardMaterial({ map: elvenStoneTex, color: 0xffffff, roughness: 0.55, metalness: 0.05 });
    const stoneMid = new THREE.MeshStandardMaterial({ map: elvenStoneTex, color: 0xd0d8e2, roughness: 0.65, metalness: 0.05 });
    const stoneDeep = new THREE.MeshStandardMaterial({ map: elvenStoneTexDark, color: 0xa8b3c4, roughness: 0.7 });
    const silver = new THREE.MeshStandardMaterial({ color: 0xe2e8ef, metalness: 0.6, roughness: 0.3 });

    // === BASIN ===
    // Sokkel (steg)
    const step = new THREE.Mesh(new THREE.CylinderGeometry(2.35, 2.55, 0.18, 32), stoneDeep);
    step.position.y = 0.09; step.castShadow = true; step.receiveShadow = true;
    grp.add(step);
    // Yttre basin-vägg
    const basinOuter = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.15, 0.55, 32), stoneLight);
    basinOuter.position.y = 0.455; basinOuter.castShadow = true; basinOuter.receiveShadow = true;
    grp.add(basinOuter);
    // Inre rim (något smalare så vattnet ligger i en "skål")
    const basinRim = new THREE.Mesh(new THREE.CylinderGeometry(1.95, 1.95, 0.22, 32), stoneMid);
    basinRim.position.y = 0.83; basinRim.castShadow = true; basinRim.receiveShadow = true;
    grp.add(basinRim);
    // Dekorativ kant ovanpå rim
    const cornice = new THREE.Mesh(new THREE.CylinderGeometry(2.02, 1.96, 0.08, 32), silver);
    cornice.position.y = 0.94;
    grp.add(cornice);

    // 8 små dekor-knoppar runt rim (silver) — som elven-detaljer
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), silver);
      knob.position.set(Math.cos(ang) * 1.98, 0.98, Math.sin(ang) * 1.98);
      knob.castShadow = true;
      grp.add(knob);
    }

    // Vatten i basin — emissive
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x4a9ee0, emissive: glowColor, emissiveIntensity: 0.55,
      roughness: 0.2, metalness: 0.15, transparent: true, opacity: 0.92,
    });
    const water = new THREE.Mesh(new THREE.CircleGeometry(1.88, 40), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.93;
    grp.add(water);

    // === KOLONNER (4 slanka pelare runt central pillar) ===
    const colMat = stoneMid;
    const colCapMat = silver;
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + Math.PI / 4; // diagonalt mot kameran
      const r = 1.05;
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 1.6, 12), colMat);
      col.position.set(Math.cos(ang) * r, 1.8, Math.sin(ang) * r);
      col.castShadow = true; col.receiveShadow = true;
      grp.add(col);
      // Kapitäl (toppdel)
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.09, 0.12, 12), colCapMat);
      cap.position.set(Math.cos(ang) * r, 2.65, Math.sin(ang) * r);
      grp.add(cap);
      // Bas
      const baseCap = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.1, 12), colCapMat);
      baseCap.position.set(Math.cos(ang) * r, 1.05, Math.sin(ang) * r);
      grp.add(baseCap);
    }

    // === CENTRAL SPIRA ===
    // Bred sockel kring spirans bas (under vattnet, sticker upp över)
    const spireBase = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.55, 0.4, 16), stoneLight);
    spireBase.position.y = 1.18; spireBase.castShadow = true;
    grp.add(spireBase);
    // Smal kolumn upp
    const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 1.6, 16), stoneMid);
    spire.position.y = 2.2; spire.castShadow = true; spire.receiveShadow = true;
    grp.add(spire);
    // Dekor-band mitt på spiran (silver)
    const band1 = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.06, 16), silver);
    band1.position.y = 2.2;
    grp.add(band1);
    const band2 = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 16), silver);
    band2.position.y = 1.6;
    grp.add(band2);
    const band3 = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 16), silver);
    band3.position.y = 2.8;
    grp.add(band3);

    // === ÖVRE SKÅL (mellan-tier) ===
    const midBowl = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.6, 0.18, 24), stoneLight);
    midBowl.position.y = 3.05; midBowl.castShadow = true; midBowl.receiveShadow = true;
    grp.add(midBowl);
    const midBowlInner = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.55, 0.08, 24), stoneMid);
    midBowlInner.position.y = 3.13;
    grp.add(midBowlInner);
    // Vatten i mid-bowl
    const midWaterMat = new THREE.MeshStandardMaterial({
      color: 0x6abae8, emissive: glowColor, emissiveIntensity: 0.7,
      roughness: 0.15, transparent: true, opacity: 0.95,
    });
    const topWater = new THREE.Mesh(new THREE.CircleGeometry(0.78, 28), midWaterMat);
    topWater.rotation.x = -Math.PI / 2;
    topWater.position.y = 3.19;
    grp.add(topWater);

    // === KRISTALL/STJÄRNA PÅ TOPPEN ===
    const finialStem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.4, 10), silver);
    finialStem.position.y = 3.4;
    grp.add(finialStem);
    const crystal = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.18, 0),
      new THREE.MeshStandardMaterial({
        color: 0xb8e4ff, emissive: glowColor, emissiveIntensity: 1.2,
        metalness: 0.4, roughness: 0.15, transparent: true, opacity: 0.92,
      })
    );
    crystal.position.y = 3.78;
    grp.add(crystal);

    // === VATTENSTRÅLAR ===
    // Från mid-bowl ner till basin (4 trådar)
    const streamMat = new THREE.MeshStandardMaterial({
      color: 0xa8dcf6, emissive: glowColor, emissiveIntensity: 0.55,
      transparent: true, opacity: 0.6,
    });
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2;
      const r = 0.7;
      const stream = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 2.1, 6), streamMat);
      stream.position.set(Math.cos(ang) * r, 2.0, Math.sin(ang) * r);
      grp.add(stream);
    }

    // === LJUS ===
    const light = new THREE.PointLight(glowColor, 1.0, 7, 2);
    light.position.set(0, 3.0, 0);
    grp.add(light);

    // === AURA-RING ===
    const auraRing = new THREE.Mesh(
      new THREE.RingGeometry(FOUNTAIN_AURA_RADIUS - 0.08, FOUNTAIN_AURA_RADIUS, 56),
      new THREE.MeshBasicMaterial({ color: glowColor, transparent: true, opacity: 0.25, side: THREE.DoubleSide })
    );
    auraRing.rotation.x = -Math.PI / 2;
    auraRing.position.y = 0.03;
    grp.add(auraRing);

    scene.add(grp);
    return { group: grp, water, topWater, light, auraRing, crystal };
  }
  towerMeshes[1] = makeFountain(24, 8,  0x4aa0ff);   // sida 1 = blå glöd
  towerMeshes[2] = makeFountain(24, -8, 0xff5a4a);   // sida 2 = varm glöd

  // === TRAIL-FADE — stigar som fortsätter in i basen ===
  function makeTrailExtension(cx, cz, len = 5, w = 2.4, seed = 1) {
    const tex = TEXTURES.trailFade(seed);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(len, w),
      new THREE.MeshStandardMaterial({
        map: tex, color: 0xffffff, roughness: 0.95,
        transparent: true, depthWrite: false,
      })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(cx, 0.025, cz); // strax över basgolvet (0.02) för att undvika z-fight
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  // Stigar in i sida 1:s bas vid z=12 och z=4 (lane-mittpunkterna)
  makeTrailExtension(12.5, 12, 5, 2.4, 11);
  makeTrailExtension(12.5,  4, 5, 2.4, 12);
  // Sida 2 mirror
  makeTrailExtension(12.5, -4, 5, 2.4, 13);
  makeTrailExtension(12.5, -12, 5, 2.4, 14);

  // Lägereld — stenring + loggar + flame-cones + varm punktljus
  function makeCampfire(x, z) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    // Stenring
    const stoneMat = new THREE.MeshStandardMaterial({ map: towerStoneTex, color: 0x888888, roughness: 0.9 });
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2 + 0.2;
      const r = 0.6;
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.18 + Math.random() * 0.07, 8, 6), stoneMat);
      s.position.set(Math.cos(ang) * r, 0.12, Math.sin(ang) * r);
      s.castShadow = true; s.receiveShadow = true;
      grp.add(s);
    }
    // Loggar — 3 cylindrar som korsar
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x4a2e15, roughness: 0.95 });
    const woodMatDark = new THREE.MeshStandardMaterial({ color: 0x2a1808, roughness: 0.95 });
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI;
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.0, 8), i % 2 === 0 ? woodMat : woodMatDark);
      log.rotation.z = Math.PI / 2;
      log.rotation.y = ang;
      log.position.y = 0.12;
      log.castShadow = true; log.receiveShadow = true;
      grp.add(log);
    }
    // Glöd-bädd
    const ember = new THREE.Mesh(
      new THREE.CircleGeometry(0.38, 16),
      new THREE.MeshStandardMaterial({ color: 0xff3a0a, emissive: 0xff5012, emissiveIntensity: 1.2, transparent: true, opacity: 0.9 })
    );
    ember.rotation.x = -Math.PI / 2;
    ember.position.y = 0.21;
    grp.add(ember);
    // Lågor — 3 koner
    const flameMatOuter = new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff6010, emissiveIntensity: 1.3, transparent: true, opacity: 0.85 });
    const flameMatInner = new THREE.MeshStandardMaterial({ color: 0xffd84a, emissive: 0xffb020, emissiveIntensity: 1.5, transparent: true, opacity: 0.9 });
    const flames = [];
    for (let i = 0; i < 3; i++) {
      const outer = new THREE.Mesh(new THREE.ConeGeometry(0.22 - i * 0.04, 0.55 - i * 0.1, 8), i === 0 ? flameMatOuter : flameMatInner);
      outer.position.set((Math.random() - 0.5) * 0.15, 0.4 + i * 0.1, (Math.random() - 0.5) * 0.15);
      grp.add(outer);
      flames.push(outer);
    }
    // Varm pointlight
    const fireLight = new THREE.PointLight(0xff7a2a, 0.7, 5, 2);
    fireLight.position.set(0, 0.6, 0);
    grp.add(fireLight);
    scene.add(grp);
    return { group: grp, flames, light: fireLight };
  }

  // Halv-trasigt tält — två sluttande paneler med en pol i mitten, ena sidan lutar/saggar
  function makeBrokenTent(x, z, rotY = 0) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    grp.rotation.y = rotY;

    const canvasMat = new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 0.95, side: THREE.DoubleSide });
    const canvasDark = new THREE.MeshStandardMaterial({ color: 0x6a4226, roughness: 0.95, side: THREE.DoubleSide });
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a2818, roughness: 0.9 });

    // Vänster panel — står upp normalt
    const left = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.3), canvasMat);
    left.rotation.y = Math.PI / 2;
    left.rotation.z = Math.PI / 7; // sluttar inåt
    left.position.set(-0.45, 0.55, 0);
    left.castShadow = true; left.receiveShadow = true;
    grp.add(left);

    // Höger panel — kollapsad, ligger mer plant
    const right = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.1), canvasDark);
    right.rotation.y = Math.PI / 2;
    right.rotation.z = -Math.PI / 2.4; // nästan flat
    right.position.set(0.55, 0.35, 0);
    right.castShadow = true; right.receiveShadow = true;
    grp.add(right);

    // Stödpåle (vänster sida står)
    const poleL = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.1, 8), poleMat);
    poleL.position.set(-0.7, 0.55, -0.65);
    poleL.castShadow = true;
    grp.add(poleL);
    const poleL2 = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.1, 8), poleMat);
    poleL2.position.set(-0.7, 0.55, 0.65);
    poleL2.castShadow = true;
    grp.add(poleL2);

    // Trasig påle på höger sida (kortare och lutar)
    const poleR = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.5, 8), poleMat);
    poleR.position.set(0.6, 0.22, 0.65);
    poleR.rotation.z = -0.4;
    poleR.castShadow = true;
    grp.add(poleR);

    // Spill av canvas på marken
    const debris = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.45), canvasDark);
    debris.rotation.x = -Math.PI / 2;
    debris.position.set(0.9, 0.03, -0.4);
    grp.add(debris);

    scene.add(grp);
    return { group: grp };
  }

  // Camp-dekor: lägereld i NE-hörnet, tält i SE-hörnet (mot östra bakväggen + norra/södra ytterväggen).
  // Bas-bounds: x∈[10,28], z∈[0.5,14.5] (sida 1), spegelvänt för sida 2.
  // Östra bakväggen x≈28 och ytterväggarna z≈±15.15 bildar riktiga hörn att tucka in props i.
  campfires[1] = makeCampfire(26.7, 13.5);
  campfires[2] = makeCampfire(26.7, -13.5);
  makeBrokenTent(26.7, 2.0, Math.PI);   // tält i SE-hörnet, vänd så standing-sidan pekar in mot campen
  makeBrokenTent(26.7, -2.0, Math.PI);  // sida 2 mirror

  // Spawn-portaler — stenring med glödande runa-mitt
  function makePortal(x, z) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.95, 0.18, 10, 24),
      new THREE.MeshStandardMaterial({ map: towerStoneTex, color: 0x888888, roughness: 0.8 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.18;
    ring.castShadow = true; ring.receiveShadow = true;
    grp.add(ring);
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(0.78, 24),
      new THREE.MeshStandardMaterial({
        color: 0xff5522, emissive: 0xff3311, emissiveIntensity: 1.2,
        transparent: true, opacity: 0.85, side: THREE.DoubleSide,
      })
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.12;
    grp.add(glow);
    scene.add(grp);
  }
  makePortal(-27, 12); makePortal(-27, 4);
  makePortal(-27, -4); makePortal(-27, -12);

  // === DUEL-ARENA (separat zon på z=35, utanför huvudkartan) ===
  (function buildDuelArena() {
    const ax = 0, az = 35;
    const radius = 9;
    // Stenplattform — låg cylinder
    const platMat = new THREE.MeshStandardMaterial({ map: towerStoneTex, color: 0xc8b890, roughness: 0.85 });
    const platform = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius + 0.3, 0.3, 48), platMat);
    platform.position.set(ax, 0.15, az);
    platform.receiveShadow = true;
    platform.castShadow = true;
    scene.add(platform);
    // Inre golv (något ljusare/mörkare för visuell variation)
    const innerMat = new THREE.MeshStandardMaterial({ map: towerStoneTex, color: 0xa89868, roughness: 0.9 });
    const inner = new THREE.Mesh(new THREE.CircleGeometry(radius - 0.5, 48), innerMat);
    inner.rotation.x = -Math.PI / 2;
    inner.position.set(ax, 0.32, az);
    inner.receiveShadow = true;
    scene.add(inner);
    // Stenring-vägg runt kanten — låga klossar i cirkel
    const wallMat = new THREE.MeshStandardMaterial({ map: towerStoneTex, color: 0x988868, roughness: 0.85 });
    const blocks = 24;
    for (let i = 0; i < blocks; i++) {
      const ang = (i / blocks) * Math.PI * 2;
      const r = radius - 0.05;
      const block = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6 + (i % 2) * 0.15, 1.4), wallMat);
      block.position.set(ax + Math.cos(ang) * r, 0.3 + 0.35, az + Math.sin(ang) * r);
      block.rotation.y = -ang;
      block.castShadow = true;
      block.receiveShadow = true;
      scene.add(block);
    }
    // 4 facklor (glödande poler) på 0°, 90°, 180°, 270°
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const r = radius - 0.6;
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.1, 1.6, 8),
        new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 0.9 })
      );
      pole.position.set(ax + Math.cos(ang) * r, 0.3 + 0.8, az + Math.sin(ang) * r);
      pole.castShadow = true;
      scene.add(pole);
      const flame = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 12, 10),
        new THREE.MeshStandardMaterial({ color: 0xff8030, emissive: 0xff5010, emissiveIntensity: 1.4, transparent: true, opacity: 0.95 })
      );
      flame.position.set(ax + Math.cos(ang) * r, 0.3 + 1.7, az + Math.sin(ang) * r);
      scene.add(flame);
      const light = new THREE.PointLight(0xff7a30, 0.6, 6, 2);
      light.position.set(ax + Math.cos(ang) * r, 0.3 + 1.7, az + Math.sin(ang) * r);
      scene.add(light);
    }
    // Centrum-runa på golvet (cirkel med glödande mönster)
    const runeMat = new THREE.MeshStandardMaterial({
      color: 0xffa040, emissive: 0xff6020, emissiveIntensity: 0.6,
      transparent: true, opacity: 0.65, side: THREE.DoubleSide,
    });
    const rune = new THREE.Mesh(new THREE.RingGeometry(1.8, 2.2, 32), runeMat);
    rune.rotation.x = -Math.PI / 2;
    rune.position.set(ax, 0.34, az);
    scene.add(rune);
  })();

  // Hemisphere: himmel ovanifrån + jord-bounce nedifrån
  const hemi = new THREE.HemisphereLight(0xc4dcff, 0x3a2b1a, 0.55);
  hemi.position.set(0, 50, 0);
  scene.add(hemi);

  // Sol: varm directional med skuggor
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.4);
  sun.position.set(18, 28, 14);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 28;
  sun.shadow.camera.bottom = -28;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 70;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);

  // Rim: kall ton från motsatt riktning, ingen skugga
  const rim = new THREE.DirectionalLight(0x6b8fc4, 0.45);
  rim.position.set(-16, 12, -12);
  scene.add(rim);

  // ---- Dekorativa props (utanför spelytan) ----
  let propSeed = 31337;
  const pr = () => {
    propSeed = (propSeed * 1103515245 + 12345) >>> 0;
    return (propSeed >>> 8) / 0xFFFFFF;
  };

  function makeTree(x, z, scale = 1) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18 * scale, 0.24 * scale, 1.1 * scale, 8),
      new THREE.MeshStandardMaterial({ color: 0x4a2e1a, roughness: 0.95 })
    );
    trunk.position.y = 0.55 * scale;
    grp.add(trunk);
    const leaves = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.7 * scale, 0),
      new THREE.MeshStandardMaterial({ color: 0x355926 + (pr() * 0x101 | 0), roughness: 0.9 })
    );
    leaves.position.y = 1.5 * scale;
    leaves.scale.set(1, 0.85, 1);
    leaves.rotation.y = pr() * Math.PI * 2;
    grp.add(leaves);
    // En liten extra kluster
    const leaves2 = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.45 * scale, 0),
      new THREE.MeshStandardMaterial({ color: 0x466a32, roughness: 0.9 })
    );
    leaves2.position.set(0.25 * scale, 1.2 * scale, 0.15 * scale);
    leaves2.scale.set(1, 0.9, 1);
    grp.add(leaves2);
    setShadow(grp, true, false);
    return grp;
  }

  function makeRock(x, z, scale = 1) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    const r = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.4 * scale, 0),
      new THREE.MeshStandardMaterial({ color: 0x6e6258 + (pr() * 0x111 | 0), roughness: 0.92 })
    );
    r.position.y = 0.22 * scale;
    r.rotation.set(pr() * 6, pr() * 6, pr() * 6);
    r.scale.set(1, 0.7 + pr() * 0.4, 1);
    grp.add(r);
    setShadow(grp, true, true);
    return grp;
  }

  function makeBush(x, z, scale = 1) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    const b = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.32 * scale, 0),
      new THREE.MeshStandardMaterial({ color: 0x3d6428, roughness: 0.95 })
    );
    b.position.y = 0.27 * scale;
    b.scale.set(1.1, 0.8, 1.1);
    grp.add(b);
    const b2 = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.22 * scale, 0),
      new THREE.MeshStandardMaterial({ color: 0x4a7330, roughness: 0.95 })
    );
    b2.position.set(0.25 * scale, 0.2 * scale, -0.1 * scale);
    grp.add(b2);
    setShadow(grp, true, true);
    return grp;
  }

  // Trädring runt spelytan
  const treeSpots = [
    // norra raden
    [-38, 22], [-30, 25], [-18, 27], [-6, 26], [8, 25], [20, 24], [32, 22],
    // södra raden
    [-38, -22], [-30, -25], [-18, -27], [-6, -26], [8, -25], [20, -24], [32, -22],
    // östra
    [40, 16], [42, 8], [42, -8], [40, -16],
    // västra
    [-38, 16], [-40, 6], [-40, -6], [-38, -16],
  ];
  for (const [x, z] of treeSpots) {
    const jx = (pr() - 0.5) * 3;
    const jz = (pr() - 0.5) * 3;
    const sc = 0.9 + pr() * 0.6;
    scene.add(makeTree(x + jx, z + jz, sc));
  }

  // Stenar spridda
  for (let i = 0; i < 22; i++) {
    let x, z;
    do {
      x = (pr() - 0.5) * 90;
      z = (pr() - 0.5) * 60;
    } while (Math.abs(x) < 32 && Math.abs(z) < 17);  // håll bort från spelytan
    const sc = 0.6 + pr() * 1.0;
    scene.add(makeRock(x, z, sc));
  }

  // Buskar spridda runt utanför
  for (let i = 0; i < 18; i++) {
    let x, z;
    do {
      x = (pr() - 0.5) * 80;
      z = (pr() - 0.5) * 56;
    } while (Math.abs(x) < 31 && Math.abs(z) < 16.5);
    scene.add(makeBush(x, z, 0.8 + pr() * 0.8));
  }
})();

// ============================================================
// SIDE CONFIG
// ============================================================

const SIDE_CFG = {
  1: {
    arenaSign: 1,
    laneZ: { 1: 12, 2: 4 },          // egna monsters spawnar här
    oppLaneZ: { 1: -4, 2: -12 },     // egna playerCreeps spawnar här (i opp's arena)
    spawnX: -27,
    baseZRange: [0.5, 14.55],
    tower: { x: 24, z: 8 },
    heroSpawn: { x: 15, z: 8 },
    heroColor: 0xff5533,
    gruntColor: 0x3388dd,
    gruntEmissive: 0x112244,
  },
  2: {
    arenaSign: -1,
    laneZ: { 1: -4, 2: -12 },
    oppLaneZ: { 1: 12, 2: 4 },
    spawnX: -27,
    baseZRange: [-14.55, -0.5],
    tower: { x: 24, z: -8 },
    heroSpawn: { x: 15, z: -8 },
    heroColor: 0x33ddaa,
    gruntColor: 0xdd6644,
    gruntEmissive: 0x441a14,
  },
};

// ============================================================
// GAMEPLAY-KONSTANTER
// ============================================================

const HERO_R = 0.45;
const TOWER_R = 1.6;
const HERO_MAX_HP = 100;
const HERO_BASE_MOVE_SPEED = 6;
const HERO_BASE_ATTACK_DMG = 5;
const HERO_ATTACK_RANGE = 4.0;
const HERO_ATTACK_INTERVAL = 1.0;

// Per-hero baseline stats (matchar server/game-engine.js HERO_DEFS).
const HERO_DEFS = {
  magiker: { name: 'Gandulf', baseHp: 100, baseDmg: 5, attackRange: 4.0, attackInterval: 1.0, baseMoveSpeed: 6.0 },
  legolas: { name: 'Legolus', baseHp: 85,  baseDmg: 6, attackRange: 6.0, attackInterval: 0.7, baseMoveSpeed: 7.0 },
  gimlu:   { name: 'Gimlu',   baseHp: 140, baseDmg: 7, attackRange: 2.5, attackInterval: 1.2, baseMoveSpeed: 5.0 },
};
function heroDef(heroId) { return HERO_DEFS[heroId] || HERO_DEFS.magiker; }
const PROJECTILE_SPEED = 18;
const PASSIVE_EVERY = 4;
const PASSIVE_AOE_RADIUS = 2.0;

const MONSTER_AGGRO_RANGE = 5.0;
const MONSTER_LEASH_RANGE = 7.5;
const TOWER_REACH = 2.3;
const MONSTER_MELEE_DAMAGE = 8;

// === Wave-system (matchar server) ===
const MAX_WAVES = 50;
const INITIAL_PREP_TIME = 10;
const WAVE_GAP_TIME = 10;
const WAVE_COUNT_PER_LANE = 10;
const WAVE_CLUMP_COLS_Z = [-1.5, 0, 1.5];
const WAVE_CLUMP_ROW_SPACING = 1.0;
const WAVE_NAMES = ['Soldiers', 'Knights', 'Berserkers', 'Demons', 'Drakätt'];
const BOSS_NAMES = ['Captain', 'General', 'Warlord', 'Demon Prince', 'Drakkonungen'];
const WAVE_TYPE_PATTERN = ['melee', 'mix', 'range', 'melee', 'mix', 'melee', 'range', 'melee', 'mix', 'boss'];
const RANGE_MONSTER_RANGE = 4.5;
const RANGE_MONSTER_INTERVAL = 1.5;
const RANGE_MONSTER_SPEED_RATIO = 0.75;
const RANGE_MONSTER_HP_RATIO = 0.80;

function getWaveDef(waveNum) {
  if (waveNum < 1 || waveNum > MAX_WAVES) return null;
  const tierIdx = Math.min(4, Math.floor((waveNum - 1) / 10));
  const waveType = WAVE_TYPE_PATTERN[(waveNum - 1) % 10];
  const isBoss = waveType === 'boss';
  if (isBoss) {
    return {
      number: waveNum,
      name: BOSS_NAMES[tierIdx],
      isBoss: true,
      waveType: 'boss',
      count: 1,
      monsterHp: 200 + tierIdx * 250,
      monsterDmg: 18 + tierIdx * 6,
      monsterSpeed: 1.8,
    };
  }
  const inTier = ((waveNum - 1) % 10) + 1;
  return {
    number: waveNum,
    name: WAVE_NAMES[tierIdx],
    isBoss: false,
    waveType,
    count: WAVE_COUNT_PER_LANE * 2,
    monsterHp: Math.round(10 + tierIdx * 12 + inTier * 1.5),
    monsterDmg: Math.round((8 + tierIdx * 4 + inTier * 0.6) * 10) / 10,
    monsterSpeed: 2.0 + tierIdx * 0.05,
  };
}
const MONSTER_MELEE_INTERVAL = 1.0;
const GOLD_PER_KILL = 5;
const RESPAWN_TIME = 5.0;

// Wave-monsters vs minions (när auto-spawn-monstren attackerar opp:s minions i sin arena)
const CREEP_VS_CREEP_DAMAGE = 5;
const CREEP_VS_CREEP_RANGE = 1.5;
const CREEP_VS_CREEP_INTERVAL = 1.5;

// ---- Income ----
const INCOME_BASE = 2;            // start-income (gold per tick)
const INCOME_INTERVAL = 15.0;     // sekunder mellan tick
const INCOME_MINION_RATIO = 0.2;  // 20% av minion-kostnaden går till income-boost

// ---- Tier-unlocks (sekventiellt) ----
const TIER_UNLOCK_COST = { 2: 200, 3: 500, 4: 1000, 5: 2000 };

// ---- Minion-arketyper och tiers ----
// 6 arketyper × 5 tiers = 30 unika minions.
const ARCHETYPE_BASE = {
  slasher:  { cost: 10, hp: 18, speed: 1.6, damage: 3, range: 1.0, interval: 0.8, attackType: 'melee' },
  archer:   { cost: 14, hp: 15, speed: 1.4, damage: 4, range: 3.5, interval: 1.2, attackType: 'arrow' },
  bruiser:  { cost: 18, hp: 32, speed: 1.3, damage: 5, range: 1.2, interval: 1.3, attackType: 'melee' },
  mage:     { cost: 22, hp: 20, speed: 1.3, damage: 5, range: 3.5, interval: 1.5, attackType: 'magic', aoeRadius: 1.6 },
  tank:     { cost: 26, hp: 60, speed: 1.15, damage: 2, range: 1.0, interval: 1.4, attackType: 'melee' },
  champion: { cost: 35, hp: 48, speed: 1.3, damage: 8, range: 1.5, interval: 1.5, attackType: 'melee' },
};
const ARCHETYPE_ORDER = ['slasher', 'archer', 'bruiser', 'mage', 'tank', 'champion'];
const ARCHETYPE_NAMES = {
  slasher: 'Knivman', archer: 'Bågskytt', bruiser: 'Krossare',
  mage: 'Mystiker', tank: 'Sköldbärare', champion: 'Hövding',
};

const TIER_MULT = { 1: 1.0, 2: 2.0, 3: 4.0, 4: 7.0, 5: 11.0 };
const TIER_NAMES = { 1: 'Goblin', 2: 'Ork', 3: 'Vandöd', 4: 'Demon', 5: 'Drakätt' };
const TIER_SCALE = { 1: 1.0, 2: 1.08, 3: 1.14, 4: 1.20, 5: 1.28 };
const TIER_PALETTE = {
  1: { body: 0x4d6e3a, armor: 0x5a4f3a, accent: 0x2c3a1a, eye: 0x222222, glow: 0 },
  2: { body: 0x35462a, armor: 0x2a2520, accent: 0x8a3a3a, eye: 0xff5522, glow: 0.35 },
  3: { body: 0x8a8a96, armor: 0x3a3a44, accent: 0x55ddff, eye: 0x66e0ff, glow: 0.9 },
  4: { body: 0x6a2a26, armor: 0x1a0a08, accent: 0xff7733, eye: 0xff5511, glow: 1.1 },
  5: { body: 0xc4a050, armor: 0x4a3a1a, accent: 0xffaa22, eye: 0xffcc44, glow: 0.7 },
};

// Generera MINION_TYPES från arketyp × tier
const MINION_TYPES = {};
for (const tier of [1, 2, 3, 4, 5]) {
  for (const arch of ARCHETYPE_ORDER) {
    const base = ARCHETYPE_BASE[arch];
    const mult = TIER_MULT[tier];
    const id = `T${tier}_${arch}`;
    MINION_TYPES[id] = {
      id, tier, archetype: arch,
      name: `${TIER_NAMES[tier]} ${ARCHETYPE_NAMES[arch]}`,
      cost: Math.round(base.cost * mult),
      hp: Math.round(base.hp * mult),
      speed: base.speed,
      damage: Math.round(base.damage * mult),
      range: base.range,
      interval: base.interval,
      attackType: base.attackType,
      aoeRadius: base.aoeRadius || 0,
    };
  }
}

// Kill-bounty för opp's minion = 20% av dess kostnad
const MINION_KILL_RATIO = 0.2;

// Level-system 1–30 (matchar server/game-engine.js)
const MAX_LEVEL = 30;
const LEVEL_DMG_PCT = 0.04;
const LEVEL_HP_PCT = 0.04;
const LEVEL_MS_PCT = 0.01;
function xpForLevel(level) { return 50 * level; }
const MONSTER_XP_REWARD = 10;
const CREEP_XP_RATIO = 0.6;

// Creep-projektil-hastigheter
const ARROW_SPEED = 14;
const MAGIC_PROJ_SPEED = 10;

// Gandulf-skills omskrivna — Fire Wave / Frost Nova target / Black Hole
const FIREWAVE_LENGTH = 5;
const FIREWAVE_HALF_ANGLE = Math.PI / 4;
const FIREWAVE_DIRECT_DMG = 18;
const FIREWAVE_DOT_DPS = 6;
const FIREWAVE_DOT_DURATION = 3.0;
const FIREWAVE_EFFECT_LIFE = 0.6;
const NOVA_RADIUS = 3.8;
const NOVA_DAMAGE = 10;
const NOVA_FREEZE_TIME = 2.0;
const NOVA_CAST_DISTANCE = 6;
const SHATTER_RADIUS = 2.5;
const SHATTER_DAMAGE = 15;
const BLACKHOLE_RADIUS = 3.5;
const BLACKHOLE_PULL_SPEED = 2.5;
const BLACKHOLE_DURATION = 3.0;
const BLACKHOLE_EXPLOSION_RADIUS = 4.0;
const BLACKHOLE_EXPLOSION_DMG = 30;
const BLACKHOLE_CAST_DISTANCE = 8;
// Legolus
const VINE_TRAP_RADIUS = 3.0;
const VINE_TRAP_DURATION = 3.0;
const VINE_TRAP_DOT_DPS = 8;
const VINE_TRAP_CAST_DISTANCE = 7;
const VINE_TRAP_ROOT_REFRESH = 0.25;
const LEGOLUS_BUFF_DURATION = 5.0;
const LEGOLUS_BUFF_DMG_PCT = 0.10;
const LEGOLUS_BUFF_CRIT_PCT = 0.10;
const LEGOLUS_BUFF_CRIT_DMG_PCT = 0.30;
const LEGOLUS_DASH_DISTANCE = 4.0;
const LEGOLUS_DASH_LIFESTEAL = 0.20;
// Gimlu
const TAUNT_RADIUS = 5.5;
const TAUNT_DURATION = 3.0;
const TAUNT_DMG_REDUCTION = 0.30;
const TAUNT_HEAL_PCT = 0.20;
const IRON_WILL_DURATION = 3.0;
const IRON_WILL_EXPLOSION_RADIUS = 6.0;
const HAMMER_SPEED = 12;
const HAMMER_RANGE = 9;
const HAMMER_RADIUS = 0.8;
const HAMMER_DAMAGE = 25;
const HAMMER_LIFESTEAL = 0.50;
const HAMMER_RETURN_DMG_MUL = 0.5;
// Bakåtkompabilitet
const ELDKLOT_SPEED = 16;
const ELDKLOT_DAMAGE = FIREWAVE_DIRECT_DMG;
const ELDKLOT_RANGE = FIREWAVE_LENGTH;
const ELDKLOT_RADIUS = 0.6;
const NOVA_SLOW_MUL = 0.6;
const NOVA_SLOW_TIME = 2.0;
const BLINK_RANGE = 6.0;
const TOWER_MAX_HP = 50;

// ============================================================
// WALK-CHECKS
// ============================================================

function inLane(x, z, centerZ) {
  return x >= -27.95 && x <= 11 && z >= centerZ - 2.85 && z <= centerZ + 2.85;
}
function inSideLanes(idx, x, z) {
  const cfg = SIDE_CFG[idx];
  return inLane(x, z, cfg.laneZ[1]) || inLane(x, z, cfg.laneZ[2]);
}
function inSideBase(idx, x, z) {
  const [zMin, zMax] = SIDE_CFG[idx].baseZRange;
  return x >= 10.6 && x <= 27.55 && z >= zMin && z <= zMax;
}
function isHeroWalkable(idx, x, z) {
  const cfg = SIDE_CFG[idx];
  const dx = x - cfg.tower.x, dz = z - cfg.tower.z;
  if (dx * dx + dz * dz < (TOWER_R + HERO_R) * (TOWER_R + HERO_R)) return false;
  return inSideBase(idx, x, z) || inSideLanes(idx, x, z);
}
// Creeps får röra sig i den arena där de befinner sig (sin egen eller motståndarens).
// En enkel check: tillåt bas + alla 4 lanes (men inte mittvägg).
function isCreepPos(x, z) {
  if (x >= 10.6 && x <= 27.55 && z >= 0.5 && z <= 14.55) return true;
  if (x >= 10.6 && x <= 27.55 && z >= -14.55 && z <= -0.5) return true;
  // Utvidgade bakåt (x ned till -45) så monster-spawn-kolumn ryms.
  const inLaneWide = (cz) => x >= -45 && x <= 11 && z >= cz - 2.85 && z <= cz + 2.85;
  return inLaneWide(12) || inLaneWide(4) || inLaneWide(-4) || inLaneWide(-12);
}

// ============================================================
// MESH-FABRIKER (composite groups, origin vid fötter, forward = +z)
// ============================================================

function setShadow(obj, cast = true, recv = false) {
  obj.traverse(o => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = recv; }});
}

// ---- HP-bar (Sprite med canvas-textur, billboardar automatiskt mot kameran) ----

function createHpBar(hero = false) {
  const canvas = document.createElement('canvas');
  canvas.width = 100; canvas.height = 14;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(hero ? 1.2 : 0.85, hero ? 0.17 : 0.13, 1);
  sprite.renderOrder = 999;
  sprite.userData.canvas = canvas;
  sprite.userData.tex = tex;
  sprite.userData.lastPct = -1;
  return sprite;
}

function drawHpBar(sprite, pct) {
  pct = Math.max(0, Math.min(1, pct));
  if (Math.abs(pct - sprite.userData.lastPct) < 0.004) return;
  sprite.userData.lastPct = pct;
  const ctx = sprite.userData.canvas.getContext('2d');
  ctx.clearRect(0, 0, 100, 14);
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, 0, 100, 14);
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, 99, 13);
  ctx.fillStyle = pct > 0.35 ? '#2bd054' : (pct > 0.15 ? '#d5a52a' : '#d04a2a');
  ctx.fillRect(1.5, 1.5, 97 * pct, 11);
  sprite.userData.tex.needsUpdate = true;
}

function attachHpBar(meshGroup, yOffset, hero = false) {
  if (!meshGroup) return null;
  const bar = createHpBar(hero);
  bar.position.y = yOffset;
  meshGroup.add(bar);
  meshGroup.userData = meshGroup.userData || {};
  meshGroup.userData.hpBar = bar;
  meshGroup.userData.hpBarHero = !!hero;
  return bar;
}

function updateEntityHpBar(mesh, hp, maxHp, now) {
  if (!mesh?.userData?.hpBar) return;
  const bar = mesh.userData.hpBar;
  const prev = mesh.userData.prevHp;
  if (prev !== undefined && hp < prev) mesh.userData.lastHurtTime = now;
  mesh.userData.prevHp = hp;
  const pct = maxHp > 0 ? hp / maxHp : 0;
  const damaged = (now - (mesh.userData.lastHurtTime || -10)) < 3.0;
  const lowHp = pct < 1.0;
  const showAlways = !!mesh.userData.hpBarHero;
  bar.visible = (showAlways || damaged || lowHp) && pct > 0;
  if (bar.visible) drawHpBar(bar, pct);
}

function tickAllHpBars() {
  const now = performance.now() / 1000;
  // Heroes
  for (const idx of [1, 2]) {
    const s = sides[idx];
    if (!s || !s.mesh) continue;
    updateEntityHpBar(s.mesh, s.hero.hp, s.hero.maxHp, now);
    if (s.mesh.userData.hpBar) s.mesh.userData.hpBar.visible = !s.hero.dead && s.mesh.userData.hpBar.visible;
  }
  if (APP.mode === 'solo') {
    for (const idx of [1, 2]) {
      const s = sides[idx];
      if (!s) continue;
      for (const m of s.monsters) updateEntityHpBar(m.mesh, m.hp, 10, now);
      for (const c of s.playerCreeps) updateEntityHpBar(c.mesh, c.hp, c.maxHp, now);
    }
  } else {
    for (const idx of [1, 2]) {
      const monMap = clientMeshes.monsters && clientMeshes.monsters.get(idx);
      if (monMap) for (const mesh of monMap.values()) {
        const hp = mesh.userData?.curHp ?? 0;
        const mh = mesh.userData?.maxHp ?? 1;
        updateEntityHpBar(mesh, hp, mh, now);
      }
      const crpMap = clientMeshes.playerCreeps && clientMeshes.playerCreeps.get(idx);
      if (crpMap) for (const mesh of crpMap.values()) {
        const hp = mesh.userData?.curHp ?? 0;
        const mh = mesh.userData?.maxHp ?? 1;
        updateEntityHpBar(mesh, hp, mh, now);
      }
      const hcMap = clientMeshes.heroCopies && clientMeshes.heroCopies.get(idx);
      if (hcMap) for (const mesh of hcMap.values()) {
        const hp = mesh.userData?.curHp ?? 0;
        const mh = mesh.userData?.maxHp ?? 1;
        updateEntityHpBar(mesh, hp, mh, now);
      }
    }
  }
}

// ---- Humanoid rig: capsule-lemmar med pivot-grupper för animation ----
// Ben/armar är pivot-Groups vid leden; capsule-meshen hänger som barn nedanför.
// Att rotera pivoten roterar lemmen kring leden, som anatomi. Pivoter sparas i
// grp.userData.rig så animation-loopen hittar dem.

function buildHumanoidRig(grp, opts = {}) {
  const bodyMat = opts.bodyMat || new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.85 });
  const armorMat = opts.armorMat || bodyMat;
  const skinMat = opts.skinMat || bodyMat;
  const limbMat = opts.limbMat || bodyMat;
  const legMat = opts.legMat || armorMat;

  const legR = opts.legR ?? 0.10;
  const legH = opts.legH ?? 0.34;        // capsule-cylinderlängd (exklusive cap-rundning)
  const armR = opts.armR ?? 0.085;
  const armH = opts.armH ?? 0.36;
  const torsoR = opts.torsoR ?? 0.21;
  const torsoH = opts.torsoH ?? 0.46;
  const headR = opts.headR ?? 0.17;
  const torsoShape = opts.torsoShape || 'capsule'; // 'capsule' | 'cylinder'

  // Höft-höjd = total ben-längd (cylinder + 2 caps)
  const hipY = legH + legR * 2;
  // Torson sitter ovanpå höften
  const torsoBottom = hipY;
  const torsoCenterY = torsoBottom + torsoH / 2 + (torsoShape === 'capsule' ? torsoR : 0);
  const torsoTopY = torsoCenterY + torsoH / 2 + (torsoShape === 'capsule' ? torsoR : 0);
  const shoulderY = torsoTopY - 0.05;
  const headY = torsoTopY + headR + 0.04;

  // ----- Ben (pivot vid höft, geometri hänger ned) -----
  const legGeo = new THREE.CapsuleGeometry(legR, legH, 6, 12);

  function makeLeg(side) {
    const pivot = new THREE.Group();
    pivot.position.set(side * (legR + 0.03), hipY, 0);
    const mesh = new THREE.Mesh(legGeo, legMat);
    mesh.position.y = -(legH / 2 + legR);   // foten vid pivot-y - hela ben-höjden
    pivot.add(mesh);
    grp.add(pivot);
    return pivot;
  }
  const leftLeg = makeLeg(-1);
  const rightLeg = makeLeg(1);

  // ----- Torso -----
  let torsoGeo;
  if (torsoShape === 'capsule') {
    torsoGeo = new THREE.CapsuleGeometry(torsoR, torsoH, 6, 14);
  } else {
    torsoGeo = new THREE.CylinderGeometry(torsoR * 0.92, torsoR, torsoH, 14);
  }
  const torso = new THREE.Mesh(torsoGeo, bodyMat);
  torso.position.y = torsoCenterY;
  grp.add(torso);

  // ----- Armar (pivot vid axel, geometri hänger ned) -----
  const armGeo = new THREE.CapsuleGeometry(armR, armH, 6, 10);

  function makeArm(side) {
    const pivot = new THREE.Group();
    pivot.position.set(side * (torsoR + armR + 0.02), shoulderY, 0);
    const mesh = new THREE.Mesh(armGeo, limbMat);
    mesh.position.y = -(armH / 2 + armR);
    pivot.add(mesh);
    grp.add(pivot);
    return pivot;
  }
  const leftArm = makeArm(-1);
  const rightArm = makeArm(1);

  // ----- Huvud -----
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(headR, 18, 14),
    skinMat
  );
  head.position.y = headY;
  grp.add(head);

  const rig = { leftLeg, rightLeg, torso, leftArm, rightArm, head,
                hipY, torsoCenterY, torsoTopY, shoulderY, headY, headR, torsoR,
                bodyMat, armorMat, skinMat, limbMat };
  grp.userData.rig = rig;
  return rig;
}

function addGlowingEyes(grp, headY, eyeColor, intensity = 1.0) {
  const mat = new THREE.MeshStandardMaterial({ color: eyeColor, emissive: eyeColor, emissiveIntensity: intensity });
  const r = 0.04;
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), mat);
    eye.position.set(side * 0.06, headY + 0.02, 0.14);
    grp.add(eye);
  }
}

function addOwnerPlume(grp, headY, plumeColor) {
  const plume = new THREE.Mesh(
    new THREE.ConeGeometry(0.05, 0.16, 8),
    new THREE.MeshStandardMaterial({ color: plumeColor, emissive: plumeColor, emissiveIntensity: 0.5 })
  );
  plume.position.set(0, headY + 0.17, -0.04);
  grp.add(plume);
}

// Hero-kopia: klon av hero-mesh + glödande röd aura/halo så den syns som "fiendens dubbelgångare".
function makeHeroCopyMesh(ownerSideIdx, heroId) {
  const grp = makeHeroMesh(ownerSideIdx, heroId);
  // Lägg på en glödande aura runt fötterna
  const aura = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.62, 24),
    new THREE.MeshBasicMaterial({ color: 0xff3322, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
  );
  aura.rotation.x = -Math.PI / 2;
  aura.position.y = 0.05;
  grp.add(aura);
  // Glow-bal i bröstet
  const heart = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xff5533, emissive: 0xff2211, emissiveIntensity: 1.5, transparent: true, opacity: 0.85 })
  );
  heart.position.y = 1.15;
  grp.add(heart);
  // Pointlight ovanför
  const light = new THREE.PointLight(0xff4422, 0.7, 4, 2);
  light.position.y = 1.6;
  grp.add(light);
  grp.userData.copyAura = aura;
  grp.userData.copyHeart = heart;
  return grp;
}

// Hero-mesh-dispatcher per heroId. Default Gandulf (magiker).
function makeHeroMesh(idx, heroId) {
  if (heroId === 'legolas') return makeLegolasMesh(idx);
  if (heroId === 'gimlu') return makeGimluMesh(idx);
  return makeGandulfMesh(idx);
}

function makeGandulfMesh(idx) {
  const cfg = SIDE_CFG[idx];
  const grp = new THREE.Group();
  grp.userData.heroId = 'magiker';

  const robeColor = idx === 1 ? 0x2a2456 : 0x3a1f3a;
  const trimColor = cfg.heroColor;
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xe6c7a5, roughness: 0.55 });
  const robeMat = new THREE.MeshStandardMaterial({ color: robeColor, roughness: 0.82 });
  const robeDarkMat = new THREE.MeshStandardMaterial({ color: 0x1a1640, roughness: 0.85 });
  const bootMat = new THREE.MeshStandardMaterial({ color: 0x2a1a0d, roughness: 0.9 });

  const rig = buildHumanoidRig(grp, {
    legR: 0.10, legH: 0.30, armR: 0.085, armH: 0.34,
    torsoR: 0.22, torsoH: 0.46, headR: 0.18,
    torsoShape: 'capsule',
    bodyMat: robeMat, armorMat: robeMat, skinMat,
    limbMat: robeMat, legMat: bootMat,
  });

  // Bälte runt torson
  const belt = new THREE.Mesh(
    new THREE.TorusGeometry(rig.torsoR * 1.02, 0.045, 10, 22),
    new THREE.MeshStandardMaterial({ color: 0x4a2810, roughness: 0.7, metalness: 0.2 })
  );
  belt.rotation.x = Math.PI / 2;
  belt.position.y = rig.hipY + 0.08;
  grp.add(belt);

  // Robe-hem (extra "kjol" runt höften så roben hänger ut över byxorna)
  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(rig.torsoR * 1.05, rig.torsoR * 1.45, 0.34, 16, 1, true),
    robeMat
  );
  skirt.position.y = rig.hipY + 0.05;
  grp.add(skirt);

  // Trim på roben (glödande accent-rand)
  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(rig.torsoR * 1.42, 0.045, 10, 22),
    new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.5, emissive: trimColor, emissiveIntensity: 0.4 })
  );
  trim.rotation.x = Math.PI / 2;
  trim.position.y = rig.hipY - 0.10;
  grp.add(trim);

  // Krage runt nacken
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, rig.torsoR, 0.16, 14),
    robeMat
  );
  collar.position.y = rig.torsoTopY - 0.05;
  grp.add(collar);

  // Skägg
  const beard = new THREE.Mesh(
    new THREE.ConeGeometry(0.13, 0.22, 12),
    new THREE.MeshStandardMaterial({ color: 0xdde2e8, roughness: 0.9 })
  );
  beard.position.set(0, rig.headY - 0.13, 0.11);
  beard.rotation.x = Math.PI;
  grp.add(beard);

  // Trollkarlshatt — brim + cone + stjärna
  const hatBrim = new THREE.Mesh(
    new THREE.TorusGeometry(0.26, 0.055, 10, 22),
    robeMat
  );
  hatBrim.rotation.x = Math.PI / 2;
  hatBrim.position.y = rig.headY + 0.16;
  grp.add(hatBrim);
  const hatCone = new THREE.Mesh(
    new THREE.ConeGeometry(0.21, 0.5, 16),
    robeMat
  );
  hatCone.position.y = rig.headY + 0.42;
  hatCone.rotation.x = -0.10;
  grp.add(hatCone);
  const hatStar = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.06),
    new THREE.MeshStandardMaterial({ color: trimColor, emissive: trimColor, emissiveIntensity: 0.9, roughness: 0.3 })
  );
  hatStar.position.set(0, rig.headY + 0.36, 0.18);
  grp.add(hatStar);

  // Stav: fäst som barn på höger arm-pivot så den rör sig med armen
  const staff = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 1.5, 10),
    new THREE.MeshStandardMaterial({ color: 0x2c1d10, roughness: 0.85 })
  );
  staff.position.set(0.05, -0.55, 0.05);    // relativt arm-pivot
  rig.rightArm.add(staff);

  // Glödande kristall i toppen av staven (fäst på samma arm)
  const orb = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.13, 0),
    new THREE.MeshStandardMaterial({
      color: trimColor, emissive: trimColor, emissiveIntensity: 1.4,
      roughness: 0.2,
    })
  );
  orb.position.set(0.05, -1.25, 0.05);
  rig.rightArm.add(orb);

  setShadow(grp, true, false);
  return grp;
}

// Legolas — agile archer. Skogsgrön/läder-look, blont hår, pilbåge + koger.
function makeLegolasMesh(idx) {
  const cfg = SIDE_CFG[idx];
  const grp = new THREE.Group();
  grp.userData.heroId = 'legolas';

  const trimColor = cfg.heroColor;
  const tunicColor = 0x3a5028;       // skogsgrön
  const leatherColor = 0x5a3a1a;     // brun läder
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xefd4b0, roughness: 0.5 });
  const tunicMat = new THREE.MeshStandardMaterial({ color: tunicColor, roughness: 0.85 });
  const leatherMat = new THREE.MeshStandardMaterial({ color: leatherColor, roughness: 0.7 });
  const bootMat = new THREE.MeshStandardMaterial({ color: 0x2a1a0d, roughness: 0.9 });

  const rig = buildHumanoidRig(grp, {
    legR: 0.085, legH: 0.32, armR: 0.075, armH: 0.36,
    torsoR: 0.20, torsoH: 0.46, headR: 0.16,
    torsoShape: 'capsule',
    bodyMat: tunicMat, armorMat: leatherMat, skinMat,
    limbMat: tunicMat, legMat: bootMat,
  });

  // Bälte
  const belt = new THREE.Mesh(
    new THREE.TorusGeometry(rig.torsoR * 1.03, 0.04, 10, 22),
    new THREE.MeshStandardMaterial({ color: 0x3a2410, roughness: 0.8 })
  );
  belt.rotation.x = Math.PI / 2;
  belt.position.y = rig.hipY + 0.05;
  grp.add(belt);

  // Lätt brigandine-väst ovanpå tunikan (mörkare grön)
  const vest = new THREE.Mesh(
    new THREE.CylinderGeometry(rig.torsoR * 1.06, rig.torsoR * 1.06, rig.torsoH * 0.7, 12, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x223a18, roughness: 0.8 })
  );
  vest.position.y = rig.hipY + rig.torsoH * 0.35;
  grp.add(vest);

  // Trim (lyser i sidans färg) — diskret rand över bröstet
  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(rig.torsoR * 1.07, 0.025, 8, 22),
    new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.5, emissive: trimColor, emissiveIntensity: 0.4 })
  );
  trim.rotation.x = Math.PI / 2;
  trim.position.y = rig.torsoTopY - 0.05;
  grp.add(trim);

  // Långt hår — bakåt-hängande, blont
  const hairColor = 0xeed8a8;
  const hairMat = new THREE.MeshStandardMaterial({ color: hairColor, roughness: 0.7 });
  // Hjälmkapsel ovanpå huvudet (hair-shell)
  const hairTop = new THREE.Mesh(new THREE.SphereGeometry(rig.headR * 1.06, 14, 12, 0, Math.PI * 2, 0, Math.PI / 2.2), hairMat);
  hairTop.position.y = rig.headY + rig.headR * 0.05;
  grp.add(hairTop);
  // Långt hår bak (cylindrar)
  const hairBack = new THREE.Mesh(new THREE.CylinderGeometry(rig.headR * 0.7, rig.headR * 0.45, 0.32, 10), hairMat);
  hairBack.position.set(0, rig.headY - 0.08, -rig.headR * 0.55);
  hairBack.rotation.x = 0.15;
  grp.add(hairBack);

  // Båge — TorusGeometry halv-cirkel i höger hand
  const bowMat = new THREE.MeshStandardMaterial({ color: 0x6b4a20, roughness: 0.7, metalness: 0.05 });
  const bow = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.025, 8, 18, Math.PI), bowMat);
  bow.position.set(0.08, -0.40, 0.08);
  bow.rotation.set(0, Math.PI / 2, Math.PI / 2);
  rig.rightArm.add(bow);
  // Bågsträng (tunn linje)
  const stringMat = new THREE.MeshStandardMaterial({ color: 0xeeeacf, roughness: 0.6 });
  const string = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.64, 6), stringMat);
  string.position.set(0.08, -0.40, 0.08);
  string.rotation.set(0, 0, Math.PI / 2);
  rig.rightArm.add(string);

  // Koger på rygg (med pilar)
  const quiver = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.06, 0.34, 10),
    new THREE.MeshStandardMaterial({ color: 0x4a2818, roughness: 0.8 })
  );
  quiver.position.set(-0.10, rig.torsoTopY - 0.18, -0.18);
  quiver.rotation.x = -0.4;
  quiver.rotation.z = -0.25;
  grp.add(quiver);
  // Pilar i kogret (några ConeGeometry-toppar som syns över skuldran)
  for (let i = 0; i < 4; i++) {
    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.012, 0.18, 6),
      new THREE.MeshStandardMaterial({ color: 0xddc680, roughness: 0.6 })
    );
    arrow.position.set(-0.07 - i * 0.022, rig.torsoTopY + 0.05, -0.18);
    arrow.rotation.x = -0.4;
    arrow.rotation.z = -0.25;
    grp.add(arrow);
  }

  // Diskret aura under fötterna (visuell agility-feel)
  const aura = new THREE.Mesh(
    new THREE.RingGeometry(0.32, 0.46, 24),
    new THREE.MeshBasicMaterial({ color: 0x66ff88, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
  );
  aura.rotation.x = -Math.PI / 2;
  aura.position.y = 0.02;
  grp.add(aura);

  setShadow(grp, true, false);
  return grp;
}

// Gimlu — stor tjock dvärg. Bred rig, kort men inte kortare än andra heroes
// (kompenseras med längre torso). Järnhjälm, lång brun beard, plåtrustning, yxa.
function makeGimluMesh(idx) {
  const cfg = SIDE_CFG[idx];
  const grp = new THREE.Group();
  grp.userData.heroId = 'gimlu';

  const trimColor = cfg.heroColor;
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd9a878, roughness: 0.55 });
  const armorMat = new THREE.MeshStandardMaterial({ color: 0x6a6e72, roughness: 0.55, metalness: 0.35 });
  const armorDarkMat = new THREE.MeshStandardMaterial({ color: 0x4a4e54, roughness: 0.6, metalness: 0.4 });
  const beltMat = new THREE.MeshStandardMaterial({ color: 0x3a2818, roughness: 0.8 });
  const bootMat = new THREE.MeshStandardMaterial({ color: 0x2a1a0d, roughness: 0.9 });

  // Bredare rig + kortare lemmar, men torso lite längre för att kompensera höjden.
  const rig = buildHumanoidRig(grp, {
    legR: 0.115, legH: 0.26, armR: 0.10, armH: 0.30,
    torsoR: 0.30, torsoH: 0.52, headR: 0.20,
    torsoShape: 'capsule',
    bodyMat: armorMat, armorMat: armorDarkMat, skinMat,
    limbMat: armorMat, legMat: bootMat,
  });

  // Bred bälte
  const belt = new THREE.Mesh(
    new THREE.TorusGeometry(rig.torsoR * 1.04, 0.08, 12, 26),
    beltMat
  );
  belt.rotation.x = Math.PI / 2;
  belt.position.y = rig.hipY + 0.05;
  grp.add(belt);
  // Bälte-spänne (i sidans färg)
  const buckle = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.10, 0.06),
    new THREE.MeshStandardMaterial({ color: trimColor, metalness: 0.6, roughness: 0.4, emissive: trimColor, emissiveIntensity: 0.25 })
  );
  buckle.position.set(0, rig.hipY + 0.05, rig.torsoR * 1.05);
  grp.add(buckle);

  // Bröstplåt (en aning större än torso, lyser i sidans accent)
  const chest = new THREE.Mesh(
    new THREE.CylinderGeometry(rig.torsoR * 1.04, rig.torsoR * 1.04, rig.torsoH * 0.65, 14, 1, true),
    armorDarkMat
  );
  chest.position.y = rig.hipY + rig.torsoH * 0.4;
  grp.add(chest);
  const chestTrim = new THREE.Mesh(
    new THREE.TorusGeometry(rig.torsoR * 1.05, 0.04, 10, 22),
    new THREE.MeshStandardMaterial({ color: trimColor, metalness: 0.5, roughness: 0.4, emissive: trimColor, emissiveIntensity: 0.35 })
  );
  chestTrim.rotation.x = Math.PI / 2;
  chestTrim.position.y = rig.torsoTopY - 0.08;
  grp.add(chestTrim);

  // Axel-pauldrons (klotformade)
  for (const sx of [-1, 1]) {
    const pauld = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      armorDarkMat
    );
    pauld.position.set(sx * (rig.torsoR + 0.05), rig.torsoTopY - 0.02, 0);
    grp.add(pauld);
  }

  // Stort skägg (chestnut brown) — hänger ner från ansiktet, längre än Gandulfs
  const beardMat = new THREE.MeshStandardMaterial({ color: 0x6e3a18, roughness: 0.85 });
  const beard = new THREE.Mesh(new THREE.ConeGeometry(0.20, 0.45, 14), beardMat);
  beard.position.set(0, rig.headY - 0.20, 0.10);
  beard.rotation.x = Math.PI;
  grp.add(beard);
  // Mustasch-cylinder under näsan
  const mustache = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.20, 10), beardMat);
  mustache.rotation.z = Math.PI / 2;
  mustache.position.set(0, rig.headY - 0.02, 0.16);
  grp.add(mustache);

  // Järnhjälm — kort cylinder + dome ovanpå + näspar (kort cylinder framåt)
  const helmMat = new THREE.MeshStandardMaterial({ color: 0x686c70, metalness: 0.45, roughness: 0.5 });
  const helmRing = new THREE.Mesh(new THREE.CylinderGeometry(rig.headR * 1.05, rig.headR * 1.05, 0.16, 16), helmMat);
  helmRing.position.y = rig.headY + 0.04;
  grp.add(helmRing);
  const helmDome = new THREE.Mesh(new THREE.SphereGeometry(rig.headR * 1.05, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2.1), helmMat);
  helmDome.position.y = rig.headY + 0.12;
  grp.add(helmDome);
  // Spik/horn på toppen
  const helmSpike = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.18, 8), new THREE.MeshStandardMaterial({ color: trimColor, metalness: 0.6, roughness: 0.4, emissive: trimColor, emissiveIntensity: 0.4 }));
  helmSpike.position.y = rig.headY + 0.32;
  grp.add(helmSpike);
  // Näspar (vertikal strip ner i pannan)
  const nasal = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.04), helmMat);
  nasal.position.set(0, rig.headY - 0.02, rig.headR * 0.95);
  grp.add(nasal);

  // Yxa i höger hand — skaft + dubbel-egg blade
  const haftMat = new THREE.MeshStandardMaterial({ color: 0x3a2410, roughness: 0.9 });
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0x9da0a4, metalness: 0.55, roughness: 0.35 });
  const haft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.70, 10), haftMat);
  haft.position.set(0.05, -0.30, 0.05);
  rig.rightArm.add(haft);
  // Blade huvud (box som vänder ut från skaftet)
  const bladeHead = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.26, 0.04), bladeMat);
  bladeHead.position.set(0.05, -0.55, 0.05);
  bladeHead.rotation.z = Math.PI / 2;
  rig.rightArm.add(bladeHead);

  // Liten subtil tank-aura (gråblå glow vid fötterna)
  const aura = new THREE.Mesh(
    new THREE.RingGeometry(0.36, 0.52, 24),
    new THREE.MeshBasicMaterial({ color: 0x8fa0b5, transparent: true, opacity: 0.20, side: THREE.DoubleSide })
  );
  aura.rotation.x = -Math.PI / 2;
  aura.position.y = 0.02;
  grp.add(aura);

  setShadow(grp, true, false);
  return grp;
}

function makeMonsterMesh() {
  const grp = new THREE.Group();
  const skinMat = new THREE.MeshStandardMaterial({ color: 0x3d2b1a, roughness: 0.9 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a1c10, roughness: 0.9 });

  const rig = buildHumanoidRig(grp, {
    legR: 0.10, legH: 0.30, armR: 0.09, armH: 0.32,
    torsoR: 0.22, torsoH: 0.40, headR: 0.20,
    torsoShape: 'capsule',
    bodyMat: skinMat, armorMat: darkMat, skinMat,
    limbMat: skinMat, legMat: darkMat,
  });

  // Glödande röda ögon
  addGlowingEyes(grp, rig.headY, 0xff4422, 1.3);

  // Horn
  const hornMat = new THREE.MeshStandardMaterial({ color: 0x1c130a, roughness: 0.8 });
  for (const side of [-1, 1]) {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.18, 10), hornMat);
    horn.position.set(side * 0.12, rig.headY + 0.16, 0);
    horn.rotation.z = side * 0.30;
    grp.add(horn);
  }

  // Hängande klor på högerarmen så monsterets attack känns hotfullt
  const claw = new THREE.Mesh(
    new THREE.ConeGeometry(0.04, 0.18, 6),
    new THREE.MeshStandardMaterial({ color: 0xddd0c0, roughness: 0.5 })
  );
  claw.position.set(0, -0.52, 0);
  claw.rotation.x = Math.PI;
  rig.rightArm.add(claw);

  setShadow(grp, true, false);
  return grp;
}

// ---- Minion-mesh-fabriker ----
// Varje arketyp har en distinkt silhuett. Tier-paletten ger färg/glow.
// Plym/accent på huvudet använder ägar-sidans färg så det syns vems minion det är.

// Material-fabrik för en arketyp + tier-palette
function makePaletteMats(palette) {
  const bodyMat = new THREE.MeshStandardMaterial({
    color: palette.body, roughness: 0.82,
    emissive: palette.glow > 0.6 ? palette.body : 0x000000,
    emissiveIntensity: palette.glow > 0.6 ? 0.08 : 0,
  });
  const armorMat = new THREE.MeshStandardMaterial({
    color: palette.armor, roughness: 0.5, metalness: 0.4,
  });
  const skinMat = bodyMat;
  return { bodyMat, armorMat, skinMat };
}

function buildSlasherBody(grp, palette, plumeColor) {
  const mats = makePaletteMats(palette);
  const rig = buildHumanoidRig(grp, {
    legR: 0.085, legH: 0.30, armR: 0.07, armH: 0.32,
    torsoR: 0.17, torsoH: 0.36, headR: 0.15,
    bodyMat: mats.bodyMat, armorMat: mats.armorMat, skinMat: mats.skinMat,
    limbMat: mats.bodyMat, legMat: mats.armorMat,
  });
  // Två dolkar — en på varje arm
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0xcdd0d8, roughness: 0.3, metalness: 0.85 });
  const hiltMat = new THREE.MeshStandardMaterial({ color: 0x2a1810, roughness: 0.9 });
  for (const arm of [rig.leftArm, rig.rightArm]) {
    const hilt = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.08, 8), hiltMat);
    hilt.position.set(0, -0.50, 0.06);
    arm.add(hilt);
    const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.005, 0.18, 6), bladeMat);
    blade.position.set(0, -0.63, 0.06);
    arm.add(blade);
  }
  if (palette.glow > 0) addGlowingEyes(grp, rig.headY, palette.eye, palette.glow);
  addOwnerPlume(grp, rig.headY, plumeColor);
}

function buildArcherBody(grp, palette, plumeColor) {
  const mats = makePaletteMats(palette);
  const rig = buildHumanoidRig(grp, {
    legR: 0.09, legH: 0.32, armR: 0.075, armH: 0.34,
    torsoR: 0.19, torsoH: 0.40, headR: 0.16,
    bodyMat: mats.bodyMat, armorMat: mats.armorMat, skinMat: mats.skinMat,
    limbMat: mats.bodyMat, legMat: mats.armorMat,
  });
  // Båge i vänster hand
  const bowMat = new THREE.MeshStandardMaterial({ color: 0x6a4020, roughness: 0.8 });
  const bow = new THREE.Mesh(
    new THREE.TorusGeometry(0.22, 0.022, 8, 20, Math.PI),
    bowMat
  );
  bow.position.set(0.02, -0.50, 0.06);
  bow.rotation.set(0, 0, -Math.PI / 2);
  rig.leftArm.add(bow);
  const string = new THREE.Mesh(
    new THREE.CylinderGeometry(0.003, 0.003, 0.44, 4),
    new THREE.MeshStandardMaterial({ color: 0xddd0b0, roughness: 0.7 })
  );
  string.position.set(0.02, -0.50, 0.06);
  rig.leftArm.add(string);
  // Koger på rygg
  const quiver = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.05, 0.26, 10),
    new THREE.MeshStandardMaterial({ color: 0x4a2818, roughness: 0.8 })
  );
  quiver.position.set(0.08, rig.torsoCenterY + 0.05, -0.16);
  quiver.rotation.x = -0.3;
  grp.add(quiver);
  if (palette.glow > 0) addGlowingEyes(grp, rig.headY, palette.eye, palette.glow);
  addOwnerPlume(grp, rig.headY, plumeColor);
}

function buildBruiserBody(grp, palette, plumeColor) {
  const mats = makePaletteMats(palette);
  const rig = buildHumanoidRig(grp, {
    legR: 0.105, legH: 0.34, armR: 0.095, armH: 0.36,
    torsoR: 0.24, torsoH: 0.48, headR: 0.18,
    bodyMat: mats.bodyMat, armorMat: mats.armorMat, skinMat: mats.skinMat,
    limbMat: mats.bodyMat, legMat: mats.armorMat,
  });
  // Yxa i höger hand (skaft + blad)
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 0.55, 8),
    new THREE.MeshStandardMaterial({ color: 0x4a2e1a, roughness: 0.9 })
  );
  handle.position.set(0.02, -0.45, 0.06);
  rig.rightArm.add(handle);
  const axHead = new THREE.Mesh(
    new THREE.BoxGeometry(0.20, 0.18, 0.045),
    new THREE.MeshStandardMaterial({ color: 0xa0a8b0, roughness: 0.4, metalness: 0.75 })
  );
  axHead.position.set(0.13, -0.65, 0.06);
  rig.rightArm.add(axHead);
  // Skulderplåtar
  const shMat = new THREE.MeshStandardMaterial({ color: palette.armor, roughness: 0.4, metalness: 0.55 });
  for (const side of [-1, 1]) {
    const sh = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), shMat);
    sh.position.set(side * (rig.torsoR + 0.05), rig.shoulderY + 0.05, 0);
    sh.scale.set(1, 0.55, 1);
    grp.add(sh);
  }
  if (palette.glow > 0) addGlowingEyes(grp, rig.headY, palette.eye, palette.glow);
  addOwnerPlume(grp, rig.headY, plumeColor);
}

function buildMageBody(grp, palette, plumeColor) {
  const mats = makePaletteMats(palette);
  const rig = buildHumanoidRig(grp, {
    legR: 0.085, legH: 0.28, armR: 0.075, armH: 0.32,
    torsoR: 0.18, torsoH: 0.42, headR: 0.16,
    bodyMat: mats.bodyMat, armorMat: mats.armorMat, skinMat: mats.skinMat,
    limbMat: mats.bodyMat, legMat: mats.armorMat,
  });
  // Lång hood
  const hoodMat = new THREE.MeshStandardMaterial({ color: palette.armor, roughness: 0.85 });
  const hood = new THREE.Mesh(new THREE.ConeGeometry(0.20, 0.42, 14), hoodMat);
  hood.position.set(0, rig.headY + 0.12, 0);
  hood.rotation.x = -0.1;
  grp.add(hood);
  // Stav i höger hand
  const staff = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, 0.95, 10),
    new THREE.MeshStandardMaterial({ color: 0x3a2410, roughness: 0.85 })
  );
  staff.position.set(0.04, -0.40, 0.05);
  rig.rightArm.add(staff);
  // Orb på toppen av staven
  const orb = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.10, 0),
    new THREE.MeshStandardMaterial({
      color: palette.accent, emissive: palette.accent, emissiveIntensity: 1.2,
      roughness: 0.2,
    })
  );
  orb.position.set(0.04, -0.92, 0.05);
  rig.rightArm.add(orb);
  if (palette.glow > 0) addGlowingEyes(grp, rig.headY, palette.eye, palette.glow);
  addOwnerPlume(grp, rig.headY + 0.18, plumeColor);
}

function buildTankBody(grp, palette, plumeColor) {
  const mats = makePaletteMats(palette);
  const rig = buildHumanoidRig(grp, {
    legR: 0.11, legH: 0.30, armR: 0.09, armH: 0.32,
    torsoR: 0.25, torsoH: 0.50, headR: 0.18,
    bodyMat: mats.bodyMat, armorMat: mats.armorMat, skinMat: mats.skinMat,
    limbMat: mats.bodyMat, legMat: mats.armorMat,
  });
  // Stor sköld på vänsterarm
  const shieldMat = new THREE.MeshStandardMaterial({
    color: palette.accent, roughness: 0.45, metalness: 0.6,
    emissive: palette.accent, emissiveIntensity: palette.glow * 0.3,
  });
  const shield = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.50, 0.38), shieldMat);
  shield.position.set(-0.02, -0.45, 0.08);
  rig.leftArm.add(shield);
  // Sköldknopp
  const boss = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xd4af37, roughness: 0.4, metalness: 0.7 })
  );
  boss.position.set(-0.05, -0.45, 0.08);
  rig.leftArm.add(boss);
  // Bröstpansar
  const chest = new THREE.Mesh(
    new THREE.CylinderGeometry(rig.torsoR * 1.05, rig.torsoR * 1.0, 0.42, 16),
    new THREE.MeshStandardMaterial({ color: palette.armor, roughness: 0.45, metalness: 0.65 })
  );
  chest.position.y = rig.torsoCenterY;
  grp.add(chest);
  // Mace i höger hand
  const maceHandle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 0.45, 8),
    new THREE.MeshStandardMaterial({ color: 0x3a2410, roughness: 0.9 })
  );
  maceHandle.position.set(0.02, -0.42, 0.05);
  rig.rightArm.add(maceHandle);
  const maceHead = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.10, 0),
    new THREE.MeshStandardMaterial({ color: 0x666c70, roughness: 0.5, metalness: 0.6 })
  );
  maceHead.position.set(0.02, -0.70, 0.05);
  rig.rightArm.add(maceHead);
  if (palette.glow > 0) addGlowingEyes(grp, rig.headY, palette.eye, palette.glow);
  addOwnerPlume(grp, rig.headY, plumeColor);
}

function buildChampionBody(grp, palette, plumeColor) {
  const mats = makePaletteMats(palette);
  const rig = buildHumanoidRig(grp, {
    legR: 0.11, legH: 0.36, armR: 0.10, armH: 0.40,
    torsoR: 0.26, torsoH: 0.52, headR: 0.20,
    bodyMat: mats.bodyMat, armorMat: mats.armorMat, skinMat: mats.skinMat,
    limbMat: mats.bodyMat, legMat: mats.armorMat,
  });
  // Hjälm
  const helmMat = new THREE.MeshStandardMaterial({
    color: palette.armor, roughness: 0.35, metalness: 0.7,
    emissive: palette.accent, emissiveIntensity: palette.glow * 0.2,
  });
  const helm = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 16, 10, 0, Math.PI * 2, 0, Math.PI / 1.5),
    helmMat
  );
  helm.position.y = rig.headY + 0.02;
  grp.add(helm);
  // Crest på toppen
  const crest = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.10, 0.30),
    new THREE.MeshStandardMaterial({ color: palette.accent, emissive: palette.accent, emissiveIntensity: 0.6 })
  );
  crest.position.set(0, rig.headY + 0.20, 0);
  grp.add(crest);
  // Stort tvåhandssvärd i höger arm
  const hilt = new THREE.Mesh(
    new THREE.BoxGeometry(0.055, 0.16, 0.055),
    new THREE.MeshStandardMaterial({ color: 0x3a2410, roughness: 0.85 })
  );
  hilt.position.set(0.02, -0.42, 0.05);
  rig.rightArm.add(hilt);
  const crossguard = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 0.04, 0.06),
    new THREE.MeshStandardMaterial({ color: 0xc0a050, roughness: 0.4, metalness: 0.6 })
  );
  crossguard.position.set(0.02, -0.52, 0.05);
  rig.rightArm.add(crossguard);
  const blade = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.72, 0.018),
    new THREE.MeshStandardMaterial({ color: 0xe0e6ec, roughness: 0.25, metalness: 0.9 })
  );
  blade.position.set(0.02, -0.92, 0.05);
  rig.rightArm.add(blade);
  // Cape bak (statisk för nu)
  const cape = new THREE.Mesh(
    new THREE.PlaneGeometry(0.55, 0.65),
    new THREE.MeshStandardMaterial({ color: palette.accent, roughness: 0.7, side: THREE.DoubleSide })
  );
  cape.position.set(0, rig.torsoCenterY - 0.05, -0.22);
  cape.rotation.x = 0.1;
  grp.add(cape);
  if (palette.glow > 0) addGlowingEyes(grp, rig.headY, palette.eye, palette.glow);
  addOwnerPlume(grp, rig.headY + 0.22, plumeColor);
}

const ARCHETYPE_BUILDERS = {
  slasher: buildSlasherBody,
  archer: buildArcherBody,
  bruiser: buildBruiserBody,
  mage: buildMageBody,
  tank: buildTankBody,
  champion: buildChampionBody,
};

function makeMinionMesh(typeId, ownerIdx) {
  const def = MINION_TYPES[typeId];
  if (!def) {
    console.warn('Unknown minion type', typeId);
    return new THREE.Group();
  }
  const palette = TIER_PALETTE[def.tier];
  const scale = TIER_SCALE[def.tier];
  const ownerCfg = SIDE_CFG[ownerIdx];
  const grp = new THREE.Group();
  ARCHETYPE_BUILDERS[def.archetype](grp, palette, ownerCfg.gruntColor);
  grp.scale.setScalar(scale);
  setShadow(grp, true, false);
  return grp;
}

// Behåll gamla namnet som alias så client/host-reconcile inte kraschar
// om vi nånsin saknar typeId. Default = T1 bruiser.
function makePlayerCreepMesh(ownerIdx, typeId) {
  return makeMinionMesh(typeId || 'T1_bruiser', ownerIdx);
}

// ============================================================
// APP-STATE
// ============================================================

const RELAY_URL = 'wss://hero-line-warz.onrender.com';

const APP = {
  mode: 'lobby',          // 'lobby' | 'solo' | 'host' | 'client'
  localSide: 1,           // 1 eller 2 — vilken sida den lokala spelaren styr
  twoSides: false,        // singleplayer = false, multiplayer = true
  ws: null,               // WebSocket till relay-servern (host + client)
  // Klient-input som ska skickas
  pendingEvents: [],
  lastInputSent: 0,
  lastStateSent: 0,
  // Mottagen client-input (bara host använder)
  remoteInputs: null,
  // Senast mottagen state (bara client använder för render)
  lastStateRecv: null,
};

function wsOpen() { return APP.ws && APP.ws.readyState === WebSocket.OPEN; }
function wsSendEnvelope(obj) {
  if (!wsOpen()) return;
  try { APP.ws.send(JSON.stringify(obj)); } catch (_) {}
}
function sendGameMsg(msg) { wsSendEnvelope({ t: 'msg', d: msg }); }

// nextEntityId är globalt på host/solo. Klient läser bara id från state.
let nextEntityId = 1;

const sides = { 1: null, 2: null };

// ============================================================
// SIDE-STATE-FABRIK
// ============================================================

function createSide(idx) {
  const cfg = SIDE_CFG[idx];
  const heroMesh = makeHeroMesh(idx);
  heroMesh.position.set(cfg.heroSpawn.x, 0, cfg.heroSpawn.z);
  attachHpBar(heroMesh, 2.0, true);
  scene.add(heroMesh);

  const side = {
    idx,
    mesh: heroMesh,
    // Hjälte
    hero: {
      x: cfg.heroSpawn.x, z: cfg.heroSpawn.z,
      hp: HERO_MAX_HP, maxHp: HERO_MAX_HP,
      facingX: -1, facingZ: 0,
      dead: false,
      respawnTimer: 0,
    },
    moveSpeed: HERO_BASE_MOVE_SPEED,
    attackDmg: HERO_BASE_ATTACK_DMG,
    attackCd: 0,
    attackCounter: 0,
    // Multiplikatorer från items + active buffar (sätts av recomputeSideStats)
    attackSpeedMul: 1,
    skillDmgMul: 1,
    cdrMul: 1,
    dmgReductionMul: 1,
    heroFountainAura: false,
    aaActive: false,
    targetId: 0,
    targetType: '',
    targetX: 0,
    targetZ: 0,
    level: 1,
    xp: 0,
    xpToNext: xpForLevel(1),
    vineTraps: [],
    legolusBuffRemaining: 0,
    legolusDashBuffPending: false,
    critDmgMul: 2.0,
    titansTauntRemaining: 0,
    ironWillRemaining: 0,
    ironWillStored: 0,
    hammers: [],
    ironWillExplosions: [],
    // Resurser
    gold: 0,
    income: INCOME_BASE,
    incomeTimer: 0,
    incomeTickCount: 0,
    inventory: [],   // [{ itemId, variantId?, level, activeRemaining, activeCd }] max 4
    tierUnlocks: { 1: true, 2: false, 3: false, 4: false, 5: false },
    // Skills
    skills: {
      q: { cd: 0, max: SKILL_BASE_CD.q },
      f: { cd: 0, max: SKILL_BASE_CD.f },
      e: { cd: 0, max: SKILL_BASE_CD.e },
    },
    // Torn
    tower: { hp: TOWER_MAX_HP, maxHp: TOWER_MAX_HP },
    // Mobile entities
    monsters: [],            // inkommande hot mot detta torn
    playerCreeps: [],        // egna minions (befinner sig i opp's arena, marscherar mot opp's torn)
    projectiles: [],         // hjältens auto-attack
    fireballs: [],           // Q (Eldklot)
    novaEffects: [],         // F (Frostnova) visuell ring
    creepProjectiles: [],    // pilar/magi från MINA minions (i opp's arena)
    // Wave-system
    wave: {
      current: 0,
      active: false,
      betweenTimer: INITIAL_PREP_TIME,
      name: '',
      isBoss: false,
      bannerPulse: 0,
    },
  };
  recomputeSideStats(side);
  return side;
}

function removeSide(side) {
  if (!side) return;
  scene.remove(side.mesh);
  for (const m of side.monsters) scene.remove(m.mesh);
  for (const c of side.playerCreeps) scene.remove(c.mesh);
  for (const p of side.projectiles) scene.remove(p.mesh);
  for (const f of side.fireballs) scene.remove(f.mesh);
  for (const n of side.novaEffects) scene.remove(n.mesh);
  for (const cp of side.creepProjectiles) scene.remove(cp.mesh);
}

// ============================================================
// SPAWNING (host/solo)
// ============================================================

function hostSpawnMonster(side, lane) {
  const cfg = SIDE_CFG[side.idx];
  const z = cfg.laneZ[lane];
  const mesh = makeMonsterMesh();
  attachHpBar(mesh, 1.7);
  mesh.position.set(cfg.spawnX, 0, z);
  scene.add(mesh);
  side.monsters.push({
    id: nextEntityId++, lane, hp: 10, speed: 2.0, pathIndex: 0,
    atkCd: 0, slowTime: 0, slowMul: 1.0, chasing: false,
    mesh,
  });
}

function hostSpawnMinion(side, typeId, lane) {
  const def = MINION_TYPES[typeId];
  if (!def) return;
  const oppIdx = 3 - side.idx;
  const oppCfg = SIDE_CFG[oppIdx];
  const z = oppCfg.laneZ[lane];
  const mesh = makeMinionMesh(typeId, side.idx);
  attachHpBar(mesh, 1.7);
  mesh.position.set(oppCfg.spawnX, 0, z);
  scene.add(mesh);
  side.playerCreeps.push({
    id: nextEntityId++,
    typeId,
    lane,
    hp: def.hp, maxHp: def.hp,
    speed: def.speed,
    damage: def.damage,
    range: def.range,
    interval: def.interval,
    attackType: def.attackType,
    aoeRadius: def.aoeRadius || 0,
    cost: def.cost,
    pathIndex: 0, atkCd: 0,
    mesh,
  });
}

// Spawnar en creep-projektil (pil eller magisk glob) från en minion.
function hostSpawnCreepProjectile(ownerSide, creep, target, targetType) {
  const isMagic = creep.attackType === 'magic';
  const mesh = isMagic
    ? new THREE.Mesh(
        new THREE.SphereGeometry(0.15, 10, 8),
        new THREE.MeshStandardMaterial({
          color: 0xaa44ff, emissive: 0xaa44ff, emissiveIntensity: 1.0,
          roughness: 0.3,
        })
      )
    : new THREE.Mesh(
        new THREE.ConeGeometry(0.045, 0.35, 6),
        new THREE.MeshStandardMaterial({ color: 0x6a4020, roughness: 0.7 })
      );
  mesh.position.set(creep.mesh.position.x, 1.0, creep.mesh.position.z);
  scene.add(mesh);
  ownerSide.creepProjectiles.push({
    id: nextEntityId++,
    mesh,
    target,
    targetType,         // 'monster' | 'hero'
    damage: creep.damage,
    aoeRadius: creep.aoeRadius || 0,
    speed: isMagic ? MAGIC_PROJ_SPEED : ARROW_SPEED,
    kind: isMagic ? 'magic' : 'arrow',
  });
}

// ============================================================
// SIDE-SIMULERING (host/solo)
// ============================================================

function updateWaves(side, dt) {
  const w = side.wave;
  if (w.current >= MAX_WAVES && !w.active) return;
  if (!w.active) {
    w.betweenTimer = Math.max(0, w.betweenTimer - dt);
    if (w.betweenTimer <= 0 && w.current < MAX_WAVES) {
      w.current += 1;
      const def = getWaveDef(w.current);
      w.name = def.name;
      w.isBoss = def.isBoss;
      w.active = true;
      w.bannerPulse = (w.bannerPulse || 0) + 1;
      hostSpawnWaveAtOnce(side, def);
    }
    return;
  }
  if (side.monsters.length === 0) {
    w.active = false;
    w.betweenTimer = WAVE_GAP_TIME;
  }
}

function clumpPositions(spawnX, laneZ, count) {
  const out = [];
  let row = 0, col = 0;
  while (out.length < count) {
    out.push({
      x: spawnX - row * WAVE_CLUMP_ROW_SPACING,
      z: laneZ + WAVE_CLUMP_COLS_Z[col],
    });
    col++;
    if (col >= WAVE_CLUMP_COLS_Z.length) { col = 0; row++; }
  }
  return out;
}

function hostSpawnWaveAtOnce(side, def) {
  if (def.isBoss) {
    hostSpawnMonsterFromDef(side, 1, def, null, 'melee');
    return;
  }
  const cfg = SIDE_CFG[side.idx];
  for (const lane of [1, 2]) {
    const positions = clumpPositions(cfg.spawnX, cfg.laneZ[lane], WAVE_COUNT_PER_LANE);
    let melee, range;
    if (def.waveType === 'range') { melee = 0; range = WAVE_COUNT_PER_LANE; }
    else if (def.waveType === 'mix') { melee = Math.ceil(WAVE_COUNT_PER_LANE / 2); range = WAVE_COUNT_PER_LANE - melee; }
    else { melee = WAVE_COUNT_PER_LANE; range = 0; }
    let i = 0;
    for (; i < melee; i++) hostSpawnMonsterFromDef(side, lane, def, positions[i], 'melee');
    for (let j = 0; j < range; j++) hostSpawnMonsterFromDef(side, lane, def, positions[melee + j], 'range');
  }
}

function hostSpawnMonsterFromDef(side, lane, def, pos, attackType) {
  const cfg = SIDE_CFG[side.idx];
  const x = pos ? pos.x : cfg.spawnX;
  const z = pos ? pos.z : cfg.laneZ[lane];
  const isRange = attackType === 'range';
  const hp = isRange ? Math.round(def.monsterHp * RANGE_MONSTER_HP_RATIO) : def.monsterHp;
  const speed = isRange ? def.monsterSpeed * RANGE_MONSTER_SPEED_RATIO : def.monsterSpeed;
  const mesh = makeMonsterMesh();
  if (def.isBoss) mesh.scale.set(1.6, 1.7, 1.6);
  if (isRange) {
    // Range-monster tintat grönaktigt så de syns annorlunda från melee
    mesh.traverse(o => {
      if (o.material && o.material.color && o.isMesh) {
        o.material = o.material.clone();
        o.material.color.setHex(0x5a7a4a);
      }
    });
  }
  attachHpBar(mesh, def.isBoss ? 2.4 : 1.7);
  mesh.position.set(x, 0, z);
  scene.add(mesh);
  side.monsters.push({
    id: nextEntityId++,
    lane,
    hp, maxHp: hp,
    speed,
    damage: def.monsterDmg,
    attackType: attackType || 'melee',
    attackRange: isRange ? RANGE_MONSTER_RANGE : 1.2,
    attackInterval: isRange ? RANGE_MONSTER_INTERVAL : 1.0,
    pathIndex: 0,
    atkCd: 0, slowTime: 0, slowMul: 1.0, chasing: false,
    isBoss: !!def.isBoss,
    mesh,
  });
}

function updateMonsters(side, dt) {
  // Side's monsters lever i side's egen arena. De jagar side's hjälte och attackerar
  // motståndarens playerCreeps (som är i samma arena).
  const oppIdx = 3 - side.idx;
  const opp = sides[oppIdx];
  const heroX = side.hero.x, heroZ = side.hero.z;
  const heroAlive = !side.hero.dead;
  const towerPos = SIDE_CFG[side.idx].tower;

  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];

    // DoT-tick (Fire Wave)
    if ((m.dotRemaining || 0) > 0) {
      m.dotRemaining -= dt;
      m.hp -= (m.dotPerSec || 0) * dt;
      if (m.hp <= 0) { hostKillMonster(side, i, side); continue; }
    }
    // Frusen: hoppa över movement + attack
    if ((m.frozenTime || 0) > 0) {
      m.frozenTime -= dt;
      continue;
    }
    // Taunted: tvinga chase
    if ((m.tauntedTime || 0) > 0) { m.tauntedTime -= dt; m.chasing = true; }

    // Nått tornet?
    const dxT = towerPos.x - m.mesh.position.x;
    const dzT = towerPos.z - m.mesh.position.z;
    if (dxT * dxT + dzT * dzT < TOWER_REACH * TOWER_REACH) {
      side.tower.hp = Math.max(0, side.tower.hp - 1);
      scene.remove(m.mesh);
      side.monsters.splice(i, 1);
      continue;
    }

    // Aggro mot hjälten
    const dxh = heroX - m.mesh.position.x;
    const dzh = heroZ - m.mesh.position.z;
    const distHero = Math.hypot(dxh, dzh);
    if (!heroAlive) m.chasing = false;
    else if (!m.chasing && distHero < MONSTER_AGGRO_RANGE) m.chasing = true;
    else if (m.chasing && distHero > MONSTER_LEASH_RANGE) m.chasing = false;

    m.atkCd = Math.max(0, m.atkCd - dt);
    const mAtkRange = m.attackRange || 1.2;
    const mAtkInterval = m.attackInterval || MONSTER_MELEE_INTERVAL;
    if (heroAlive && distHero < mAtkRange && m.atkCd <= 0) {
      damageHero(side, m.damage || MONSTER_MELEE_DAMAGE);
      m.atkCd = mAtkInterval;
    }

    // Om inte jagar hjälten — leta efter opp's playerCreeps i samma arena
    if (!m.chasing && opp) {
      let nearest = null, bestDist = CREEP_VS_CREEP_RANGE;
      for (const pc of opp.playerCreeps) {
        const dx = pc.mesh.position.x - m.mesh.position.x;
        const dz = pc.mesh.position.z - m.mesh.position.z;
        const d = Math.hypot(dx, dz);
        if (d < bestDist) { bestDist = d; nearest = pc; }
      }
      if (nearest) {
        if (m.atkCd <= 0) {
          nearest.hp -= CREEP_VS_CREEP_DAMAGE;
          m.atkCd = CREEP_VS_CREEP_INTERVAL;
          if (nearest.hp <= 0) {
            const idx2 = opp.playerCreeps.indexOf(nearest);
            if (idx2 >= 0) { scene.remove(nearest.mesh); opp.playerCreeps.splice(idx2, 1); side.gold += minionBounty(nearest); gainXp(side, minionXp(nearest)); }
          }
        }
        const dx = nearest.mesh.position.x - m.mesh.position.x;
        const dz = nearest.mesh.position.z - m.mesh.position.z;
        m.mesh.rotation.y = Math.atan2(dx, dz);
        continue;
      }
    }

    let dirX, dirZ;
    if (m.chasing) {
      const stopDist = m.attackType === 'range' ? Math.max(0.7, (m.attackRange || 4.5) - 0.5) : 0.7;
      if (distHero < stopDist) continue;
      dirX = dxh / distHero;
      dirZ = dzh / distHero;
    } else {
      const cfg = SIDE_CFG[side.idx];
      const path = [{ x: 10, z: cfg.laneZ[m.lane] }, { x: cfg.tower.x, z: cfg.tower.z }];
      const idx2 = Math.min(m.pathIndex, path.length - 1);
      const tgt = path[idx2];
      const dx = tgt.x - m.mesh.position.x;
      const dz = tgt.z - m.mesh.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.3 && m.pathIndex < path.length - 1) { m.pathIndex++; continue; }
      dirX = dx / d; dirZ = dz / d;
    }

    if (m.slowTime > 0) {
      m.slowTime -= dt;
      if (m.slowTime <= 0) m.slowMul = 1.0;
    }

    const step = m.speed * (m.slowMul || 1.0) * dt;
    const nx = m.mesh.position.x + dirX * step;
    const nz = m.mesh.position.z + dirZ * step;
    if (isCreepPos(nx, nz)) { m.mesh.position.x = nx; m.mesh.position.z = nz; }
    else if (isCreepPos(nx, m.mesh.position.z)) m.mesh.position.x = nx;
    else if (isCreepPos(m.mesh.position.x, nz)) m.mesh.position.z = nz;
    m.mesh.rotation.y = Math.atan2(dirX, dirZ);
  }
}

function updatePlayerCreeps(side, dt) {
  // Side's playerCreeps (minions) lever i opp's arena, marscherar mot opp's torn.
  // De kan attackera opp's monsters OCH opp's hjälte.
  const oppIdx = 3 - side.idx;
  const opp = sides[oppIdx];
  const oppCfg = SIDE_CFG[oppIdx];

  for (let i = side.playerCreeps.length - 1; i >= 0; i--) {
    const c = side.playerCreeps[i];

    // DoT-tick
    if ((c.dotRemaining || 0) > 0) {
      c.dotRemaining -= dt;
      c.hp -= (c.dotPerSec || 0) * dt;
      if (c.hp <= 0) { scene.remove(c.mesh); side.playerCreeps.splice(i, 1); continue; }
    }
    // Frusen — hoppa över
    if ((c.frozenTime || 0) > 0) {
      c.frozenTime -= dt;
      continue;
    }
    // Taunt-tick (förändrar inte movement-logiken här i solo,
    // men i solo finns ingen opp-hero så creeps anfaller monsters som vanligt)
    if ((c.tauntedTime || 0) > 0) c.tauntedTime -= dt;

    // Nått opp's torn?
    const dxT = oppCfg.tower.x - c.mesh.position.x;
    const dzT = oppCfg.tower.z - c.mesh.position.z;
    if (dxT * dxT + dzT * dzT < TOWER_REACH * TOWER_REACH) {
      if (opp) opp.tower.hp = Math.max(0, opp.tower.hp - 1);
      scene.remove(c.mesh);
      side.playerCreeps.splice(i, 1);
      continue;
    }

    c.atkCd = Math.max(0, c.atkCd - dt);

    // Hitta närmaste fiende inom c.range — prio: hjälten om i räckvidd, annars närmsta monster
    let target = null;
    let targetType = null;
    let bestDist = c.range;

    if (opp && !opp.hero.dead) {
      const dx = opp.hero.x - c.mesh.position.x;
      const dz = opp.hero.z - c.mesh.position.z;
      const d = Math.hypot(dx, dz);
      if (d < bestDist) { bestDist = d; target = opp.hero; targetType = 'hero'; }
    }
    if (opp) {
      for (const m of opp.monsters) {
        const dx = m.mesh.position.x - c.mesh.position.x;
        const dz = m.mesh.position.z - c.mesh.position.z;
        const d = Math.hypot(dx, dz);
        if (d < bestDist) { bestDist = d; target = m; targetType = 'monster'; }
      }
    }

    if (target) {
      // Riktning mot mål
      const tx = (targetType === 'hero') ? target.x : target.mesh.position.x;
      const tz = (targetType === 'hero') ? target.z : target.mesh.position.z;
      c.mesh.rotation.y = Math.atan2(tx - c.mesh.position.x, tz - c.mesh.position.z);

      if (c.atkCd <= 0) {
        if (c.attackType === 'melee') {
          // Direkt skada
          if (targetType === 'hero') {
            damageHero(opp, c.damage);
          } else {
            target.hp -= c.damage;
            if (target.hp <= 0) hostKillMonster(opp, opp.monsters.indexOf(target), side);
          }
        } else {
          // arrow / magic — spawna projektil
          hostSpawnCreepProjectile(side, c, target, targetType);
        }
        c.atkCd = c.interval;
      }
      continue;  // stå still och slåss
    }

    // Walk mot opp:s torn (genom opp's lane c.lane)
    const path = [{ x: 10, z: oppCfg.laneZ[c.lane] }, { x: oppCfg.tower.x, z: oppCfg.tower.z }];
    const idx2 = Math.min(c.pathIndex, path.length - 1);
    const tgt = path[idx2];
    const dx = tgt.x - c.mesh.position.x;
    const dz = tgt.z - c.mesh.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.3 && c.pathIndex < path.length - 1) { c.pathIndex++; continue; }
    const dirX = dx / d, dirZ = dz / d;
    const step = c.speed * dt;
    const nx = c.mesh.position.x + dirX * step;
    const nz = c.mesh.position.z + dirZ * step;
    if (isCreepPos(nx, nz)) { c.mesh.position.x = nx; c.mesh.position.z = nz; }
    else if (isCreepPos(nx, c.mesh.position.z)) c.mesh.position.x = nx;
    else if (isCreepPos(c.mesh.position.x, nz)) c.mesh.position.z = nz;
    c.mesh.rotation.y = Math.atan2(dirX, dirZ);
  }
}

function updateCreepProjectiles(side, dt) {
  const oppIdx = 3 - side.idx;
  const opp = sides[oppIdx];
  for (let i = side.creepProjectiles.length - 1; i >= 0; i--) {
    const p = side.creepProjectiles[i];
    // Kolla att mål finns kvar
    let alive = false;
    let tx, tz, ty;
    if (p.targetType === 'hero') {
      alive = opp && !opp.hero.dead;
      if (alive) { tx = opp.hero.x; tz = opp.hero.z; ty = 0.9; }
    } else {
      alive = opp && opp.monsters.includes(p.target);
      if (alive) { tx = p.target.mesh.position.x; tz = p.target.mesh.position.z; ty = 0.9; }
    }
    if (!alive) {
      scene.remove(p.mesh);
      side.creepProjectiles.splice(i, 1);
      continue;
    }
    const dx = tx - p.mesh.position.x;
    const dy = ty - p.mesh.position.y;
    const dz = tz - p.mesh.position.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.4) {
      // Träff
      if (p.targetType === 'hero') {
        damageHero(opp, p.damage);
      } else {
        p.target.hp -= p.damage;
        if (p.target.hp <= 0) hostKillMonster(opp, opp.monsters.indexOf(p.target), side);
      }
      // AoE-splash (magic)
      if (p.aoeRadius > 0) {
        const ix = tx, iz = tz;
        // Hjälten också om i radien
        if (opp && !opp.hero.dead) {
          if (Math.hypot(opp.hero.x - ix, opp.hero.z - iz) < p.aoeRadius) {
            damageHero(opp, p.damage);
          }
        }
        if (opp) for (let k = opp.monsters.length - 1; k >= 0; k--) {
          const m = opp.monsters[k];
          if (m === p.target) continue;
          if (Math.hypot(m.mesh.position.x - ix, m.mesh.position.z - iz) < p.aoeRadius) {
            m.hp -= p.damage;
            if (m.hp <= 0) hostKillMonster(opp, k, side);
          }
        }
      }
      scene.remove(p.mesh);
      side.creepProjectiles.splice(i, 1);
      continue;
    }
    const step = p.speed * dt;
    p.mesh.position.x += (dx / dist) * step;
    p.mesh.position.y += (dy / dist) * step;
    p.mesh.position.z += (dz / dist) * step;
    // Rotera pilen så den pekar mot målet (arrow only)
    if (p.kind === 'arrow') {
      p.mesh.rotation.x = Math.atan2(dy, Math.hypot(dx, dz)) - Math.PI / 2;
      p.mesh.rotation.y = Math.atan2(dx, dz);
    } else {
      p.mesh.rotation.y += dt * 6;  // mageglob snurrar
    }
  }
}

function hostKillMonster(side, idx, byPlayerSide) {
  const m = side.monsters[idx];
  if (!m) return;
  scene.remove(m.mesh);
  side.monsters.splice(idx, 1);
  if (byPlayerSide) { byPlayerSide.gold += GOLD_PER_KILL; gainXp(byPlayerSide, MONSTER_XP_REWARD); }
  else { side.gold += GOLD_PER_KILL; gainXp(side, MONSTER_XP_REWARD); }
}

function minionBounty(creep) {
  return Math.max(1, Math.floor((creep.cost || 10) * MINION_KILL_RATIO));
}
function minionXp(creep) {
  return Math.max(1, Math.floor((creep.cost || 10) * CREEP_XP_RATIO));
}

// Lägg XP, level-up om threshold nås. Stannar vid MAX_LEVEL.
function gainXp(side, amount) {
  if (!side || amount <= 0) return;
  if (side.level >= MAX_LEVEL) return;
  side.xp += amount;
  let leveled = false;
  while (side.level < MAX_LEVEL && side.xp >= side.xpToNext) {
    side.xp -= side.xpToNext;
    side.level += 1;
    side.xpToNext = xpForLevel(side.level);
    leveled = true;
  }
  if (side.level >= MAX_LEVEL) {
    side.xp = 0;
    side.xpToNext = 0;
  }
  if (leveled) recomputeSideStats(side);
}

function killHero(side) {
  if (side.hero.dead) return;
  side.hero.dead = true;
  side.hero.respawnTimer = RESPAWN_TIME;
  side.mesh.visible = false;
}

function respawnHero(side) {
  const cfg = SIDE_CFG[side.idx];
  side.hero.dead = false;
  side.hero.hp = side.hero.maxHp;
  side.hero.x = cfg.heroSpawn.x;
  side.hero.z = cfg.heroSpawn.z;
  side.mesh.position.set(side.hero.x, 0, side.hero.z);
  side.mesh.visible = true;
}

// ============================================================
// HJÄLTENS AUTO-ATTACK
// ============================================================

function findClosestHostile(side, x, z, maxDist) {
  // Hjälten attackerar fientliga entiteter i sin egen arena:
  // - side.monsters (egen inkommande wave)
  // - opp.playerCreeps (motståndarens skickade grunts som är i denna arena)
  let best = null, bestDist = maxDist;
  for (const m of side.monsters) {
    const d = Math.hypot(m.mesh.position.x - x, m.mesh.position.z - z);
    if (d < bestDist) { bestDist = d; best = { entity: m, isMonster: true }; }
  }
  const opp = sides[3 - side.idx];
  if (opp) {
    for (const c of opp.playerCreeps) {
      const d = Math.hypot(c.mesh.position.x - x, c.mesh.position.z - z);
      if (d < bestDist) { bestDist = d; best = { entity: c, isMonster: false, ownerSide: opp }; }
    }
  }
  return best;
}

// Slå upp target-entitet från side.targetId/Type (solo mode — entiteterna har .mesh)
function resolveTargetEntity(side, opp) {
  if (!side.targetId) return null;
  if (side.targetType === 'monster') {
    for (const m of side.monsters) if (m.id === side.targetId) return m;
    return null;
  }
  if (side.targetType === 'creep' && opp) {
    for (const c of opp.playerCreeps) if (c.id === side.targetId) return c;
    return null;
  }
  return null;
}

function maintainTargetLock(side) {
  const opp = sides[3 - side.idx];
  if (!side.aaActive || side.hero.dead) {
    if (side.hero.dead) {
      side.aaActive = false;
      side.targetId = 0; side.targetType = '';
    }
    return null;
  }
  let target = resolveTargetEntity(side, opp);
  let isMonster = side.targetType === 'monster';
  const range = side.attackRange || HERO_ATTACK_RANGE;
  if (target) {
    const tx = target.mesh.position.x, tz = target.mesh.position.z;
    const d = Math.hypot(tx - side.hero.x, tz - side.hero.z);
    if (d > range) target = null;
  }
  if (!target) {
    const t = findClosestHostile(side, side.hero.x, side.hero.z, range);
    if (t) {
      target = t.entity;
      isMonster = t.isMonster;
      side.targetId = target.id;
      side.targetType = isMonster ? 'monster' : 'creep';
    } else {
      side.targetId = 0; side.targetType = '';
      // Behåll aaActive — väntar tills fiende dyker upp
      return null;
    }
  }
  side.targetX = target.mesh.position.x;
  side.targetZ = target.mesh.position.z;
  return { entity: target, isMonster };
}

function updateHeroAttack(side, dt) {
  side.attackCd = Math.max(0, side.attackCd - dt);
  if (side.hero.dead || !side.aaActive) return;
  const target = maintainTargetLock(side);
  if (!target || side.attackCd > 0) return;
  side.attackCounter++;
  const isAoE = side.attackCounter % PASSIVE_EVERY === 0;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(isAoE ? 0.28 : 0.18, 12, 8),
    new THREE.MeshStandardMaterial({
      color: isAoE ? 0xff66ff : 0xffdd55,
      emissive: isAoE ? 0x882288 : 0x886611,
      emissiveIntensity: isAoE ? 1.2 : 0.8,
    })
  );
  mesh.position.set(side.hero.x, 1.5, side.hero.z);
  scene.add(mesh);
  const auraDmg = side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1;
  const auraAs = side.heroFountainAura ? FOUNTAIN_AS_MUL : 1;
  const buffActive = (side.legolusBuffRemaining || 0) > 0;
  const buffDmgMul = buffActive ? (1 + LEGOLUS_BUFF_DMG_PCT) : 1;
  let critChance = (side.critChancePct || 0) + (buffActive ? LEGOLUS_BUFF_CRIT_PCT : 0);
  let critMulBase = (side.critDmgMul || 2.0) + (buffActive ? LEGOLUS_BUFF_CRIT_DMG_PCT : 0);
  const dashBuffed = !!side.legolusDashBuffPending;
  if (dashBuffed) { critChance = 1.0; side.legolusDashBuffPending = false; }
  const isCrit = critChance > 0 && Math.random() < critChance;
  const critMul = isCrit ? critMulBase : 1;
  side.projectiles.push({
    mesh, target: target.entity, targetIsMonster: target.isMonster,
    ownerSide: target.isMonster ? side : sides[3 - side.idx] || side,
    damage: side.attackDmg * auraDmg * buffDmgMul * critMul, isAoE, isCrit,
    lifestealRatio: dashBuffed ? LEGOLUS_DASH_LIFESTEAL : 0,
    legolusBuffed: dashBuffed,
  });
  const interval = side.attackInterval || HERO_ATTACK_INTERVAL;
  side.attackCd = interval / ((side.attackSpeedMul || 1) * auraAs);
}

function updateProjectiles(side, dt) {
  const opp = sides[3 - side.idx];
  for (let i = side.projectiles.length - 1; i >= 0; i--) {
    const p = side.projectiles[i];
    // Target lever?
    const targetAlive = p.targetIsMonster
      ? side.monsters.includes(p.target)
      : (opp && opp.playerCreeps.includes(p.target));
    if (!targetAlive) {
      scene.remove(p.mesh); side.projectiles.splice(i, 1); continue;
    }
    const tp = p.target.mesh.position;
    const dx = tp.x - p.mesh.position.x;
    const dy = (tp.y + 0.9) - p.mesh.position.y;
    const dz = tp.z - p.mesh.position.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.4) {
      const ix = tp.x, iz = tp.z;
      p.target.hp -= p.damage;
      let killedTarget = false;
      if (p.target.hp <= 0) {
        killedTarget = true;
        if (p.targetIsMonster) {
          const k = side.monsters.indexOf(p.target);
          if (k >= 0) hostKillMonster(side, k, side);
        } else {
          const k = opp.playerCreeps.indexOf(p.target);
          if (k >= 0) { scene.remove(p.target.mesh); opp.playerCreeps.splice(k, 1); side.gold += minionBounty(p.target); gainXp(side, minionXp(p.target)); }
        }
      }
      // Legolus dash-buffed AA: 20% lifesteal + reset E-cd om kill
      if ((p.lifestealRatio || 0) > 0 && !side.hero.dead) {
        side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + p.damage * p.lifestealRatio);
      }
      if (p.legolusBuffed && killedTarget) {
        side.skills.e.cd = 0;
      }
      if (p.isAoE) {
        // AoE-skada till andra monsters runt träffpunkten
        for (let k = side.monsters.length - 1; k >= 0; k--) {
          const m = side.monsters[k];
          if (m === p.target) continue;
          if (Math.hypot(m.mesh.position.x - ix, m.mesh.position.z - iz) < PASSIVE_AOE_RADIUS) {
            m.hp -= p.damage;
            if (m.hp <= 0) hostKillMonster(side, k, side);
          }
        }
        if (opp) for (let k = opp.playerCreeps.length - 1; k >= 0; k--) {
          const c = opp.playerCreeps[k];
          if (c === p.target) continue;
          if (Math.hypot(c.mesh.position.x - ix, c.mesh.position.z - iz) < PASSIVE_AOE_RADIUS) {
            c.hp -= p.damage;
            if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(k, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
          }
        }
      }
      scene.remove(p.mesh); side.projectiles.splice(i, 1); continue;
    }
    const step = PROJECTILE_SPEED * dt;
    p.mesh.position.x += (dx / dist) * step;
    p.mesh.position.y += (dy / dist) * step;
    p.mesh.position.z += (dz / dist) * step;
  }
}

// ============================================================
// SKILLS (host/solo)
// ============================================================

// Solo skill-helpers
function soloResolveSkillGroundTarget(side, ev, defaultDistance) {
  if (ev && ev.tap === true && side.targetId) {
    const opp = sides[3 - side.idx];
    const t = resolveTargetEntity(side, opp);
    if (t && t.mesh) return { x: t.mesh.position.x, z: t.mesh.position.z };
  }
  let dx = (ev && ev.dx) || 0, dz = (ev && ev.dz) || 0;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) { dx = side.hero.facingX; dz = side.hero.facingZ; }
  else { dx /= len; dz /= len; }
  return { x: side.hero.x + dx * defaultDistance, z: side.hero.z + dz * defaultDistance };
}

function soloShatter(side, opp, x, z) {
  // Visuell shatter-ring som fade:as
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.2, SHATTER_RADIUS, 32),
    new THREE.MeshBasicMaterial({ color: 0xbbe7ff, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.10, z);
  scene.add(ring);
  side.shatters = side.shatters || [];
  side.shatters.push({ mesh: ring, life: 0.5, maxLife: 0.5 });
  // Damage runt punkten
  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    if (Math.hypot(m.mesh.position.x - x, m.mesh.position.z - z) < SHATTER_RADIUS) {
      m.hp -= SHATTER_DAMAGE;
      if (m.hp <= 0) hostKillMonster(side, i, side);
    }
  }
  if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
    const c = opp.playerCreeps[i];
    if (Math.hypot(c.mesh.position.x - x, c.mesh.position.z - z) < SHATTER_RADIUS) {
      c.hp -= SHATTER_DAMAGE;
      if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(i, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
    }
  }
}

function soloApplySkillDmgToMonster(side, opp, mIdx, dmg) {
  const m = side.monsters[mIdx];
  if (!m || m.hp <= 0) return;
  if ((m.frozenTime || 0) > 0) {
    soloShatter(side, opp, m.mesh.position.x, m.mesh.position.z);
    m.frozenTime = 0;
  }
  m.hp -= dmg;
  if (m.hp <= 0) hostKillMonster(side, mIdx, side);
}
function soloApplySkillDmgToCreep(side, opp, c, dmg) {
  if ((c.frozenTime || 0) > 0) {
    soloShatter(side, opp, c.mesh.position.x, c.mesh.position.z);
    c.frozenTime = 0;
  }
  c.hp -= dmg;
}

// Fire Wave (Q): triangulär cone framför hero. Direct dmg + 3s DoT.
function hostCastEldklot(side, dirX, dirZ) {
  if (side.hero.dead || side.skills.q.cd > 0) return;
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.01) { dirX = side.hero.facingX; dirZ = side.hero.facingZ; }
  else { dirX /= len; dirZ /= len; }
  side.skills.q.cd = side.skills.q.max;
  const opp = sides[3 - side.idx];
  const directDmg = FIREWAVE_DIRECT_DMG * (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1);
  const dotDps = FIREWAVE_DOT_DPS * (side.skillDmgMul || 1);
  // Cone-mesh (ConeGeometry) — pekar i dx/dz, fade:as
  const coneMat = new THREE.MeshBasicMaterial({ color: 0xff7a30, transparent: true, opacity: 0.6, side: THREE.DoubleSide });
  const coneMesh = new THREE.Mesh(new THREE.ConeGeometry(FIREWAVE_LENGTH * Math.tan(FIREWAVE_HALF_ANGLE), FIREWAVE_LENGTH, 16, 1, true), coneMat);
  // ConeGeometry pekar uppåt. Rotera ner till horisontellt + rikta enligt dirX/dz.
  coneMesh.rotation.x = -Math.PI / 2;
  coneMesh.rotation.z = Math.atan2(-dirZ, dirX) + Math.PI / 2;
  coneMesh.position.set(side.hero.x + dirX * (FIREWAVE_LENGTH / 2), 0.6, side.hero.z + dirZ * (FIREWAVE_LENGTH / 2));
  scene.add(coneMesh);
  side.fireWaves = side.fireWaves || [];
  side.fireWaves.push({ mesh: coneMesh, life: FIREWAVE_EFFECT_LIFE, maxLife: FIREWAVE_EFFECT_LIFE });
  // Skada alla i cone
  const inCone = (ex, ez) => {
    const ddx = ex - side.hero.x, ddz = ez - side.hero.z;
    const d = Math.hypot(ddx, ddz);
    if (d > FIREWAVE_LENGTH || d < 0.001) return false;
    const dot = (ddx * dirX + ddz * dirZ) / d;
    return Math.acos(Math.max(-1, Math.min(1, dot))) < FIREWAVE_HALF_ANGLE;
  };
  for (let j = side.monsters.length - 1; j >= 0; j--) {
    const m = side.monsters[j];
    if (!inCone(m.mesh.position.x, m.mesh.position.z)) continue;
    soloApplySkillDmgToMonster(side, opp, j, directDmg);
    if (m.hp > 0) { m.dotRemaining = FIREWAVE_DOT_DURATION; m.dotPerSec = dotDps; }
  }
  if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
    const c = opp.playerCreeps[j];
    if (!inCone(c.mesh.position.x, c.mesh.position.z)) continue;
    soloApplySkillDmgToCreep(side, opp, c, directDmg);
    if (c.hp > 0) { c.dotRemaining = FIREWAVE_DOT_DURATION; c.dotPerSec = dotDps; }
    else { scene.remove(c.mesh); opp.playerCreeps.splice(j, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
  }
}

function updateFireballs(side, dt) {
  const opp = sides[3 - side.idx];
  for (let i = side.fireballs.length - 1; i >= 0; i--) {
    const f = side.fireballs[i];
    const step = ELDKLOT_SPEED * dt;
    f.mesh.position.x += f.dx * step;
    f.mesh.position.z += f.dz * step;
    f.traveled += step;
    // Hit-check mot egna monsters
    for (let j = side.monsters.length - 1; j >= 0; j--) {
      const m = side.monsters[j];
      if (f.hit.has(m)) continue;
      const d = Math.hypot(m.mesh.position.x - f.mesh.position.x, m.mesh.position.z - f.mesh.position.z);
      if (d < ELDKLOT_RADIUS + 0.45) {
        f.hit.add(m);
        m.hp -= f.damage;
        if (m.hp <= 0) hostKillMonster(side, j, side);
      }
    }
    // Hit-check mot opp's playerCreeps (i denna arena)
    if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
      const c = opp.playerCreeps[j];
      if (f.hit.has(c)) continue;
      const d = Math.hypot(c.mesh.position.x - f.mesh.position.x, c.mesh.position.z - f.mesh.position.z);
      if (d < ELDKLOT_RADIUS + 0.45) {
        f.hit.add(c);
        c.hp -= f.damage;
        if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(j, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
      }
    }
    if (f.traveled > ELDKLOT_RANGE) {
      scene.remove(f.mesh); side.fireballs.splice(i, 1);
    }
  }
}

// Frost Nova (F): target-AoE freeze + shatter.
function hostCastFrostnova(side, ev) {
  if (side.hero.dead || side.skills.f.cd > 0) return;
  side.skills.f.cd = side.skills.f.max;
  const opp = sides[3 - side.idx];
  const center = soloResolveSkillGroundTarget(side, ev || {}, NOVA_CAST_DISTANCE);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.3, NOVA_RADIUS, 36),
    new THREE.MeshBasicMaterial({ color: 0x88ddff, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(center.x, 0.08, center.z);
  scene.add(ring);
  side.novaEffects.push({ mesh: ring, life: 0.6, maxLife: 0.6 });
  const novaDmg = NOVA_DAMAGE * (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1);
  for (let j = side.monsters.length - 1; j >= 0; j--) {
    const m = side.monsters[j];
    if (Math.hypot(m.mesh.position.x - center.x, m.mesh.position.z - center.z) < NOVA_RADIUS) {
      const wasFrozen = (m.frozenTime || 0) > 0;
      soloApplySkillDmgToMonster(side, opp, j, novaDmg);
      // Om monstret fortfarande lever och inte var fruset — frys
      const stillExists = side.monsters[j] === m;
      if (stillExists && m.hp > 0 && !wasFrozen) m.frozenTime = NOVA_FREEZE_TIME;
    }
  }
  if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
    const c = opp.playerCreeps[j];
    if (Math.hypot(c.mesh.position.x - center.x, c.mesh.position.z - center.z) < NOVA_RADIUS) {
      const wasFrozen = (c.frozenTime || 0) > 0;
      soloApplySkillDmgToCreep(side, opp, c, novaDmg);
      if (c.hp > 0 && !wasFrozen) c.frozenTime = NOVA_FREEZE_TIME;
      else if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(j, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
    }
  }
}

function updateNovaEffects(side, dt) {
  for (let i = side.novaEffects.length - 1; i >= 0; i--) {
    const n = side.novaEffects[i];
    n.life -= dt;
    n.mesh.material.opacity = 0.7 * (n.life / n.maxLife);
    if (n.life <= 0) { scene.remove(n.mesh); side.novaEffects.splice(i, 1); }
  }
  // Fire Wave-cone fade ut
  if (side.fireWaves) for (let i = side.fireWaves.length - 1; i >= 0; i--) {
    const fw = side.fireWaves[i];
    fw.life -= dt;
    if (fw.mesh.material) fw.mesh.material.opacity = 0.6 * (fw.life / fw.maxLife);
    if (fw.life <= 0) { scene.remove(fw.mesh); side.fireWaves.splice(i, 1); }
  }
  // Shatter-effekter
  if (side.shatters) for (let i = side.shatters.length - 1; i >= 0; i--) {
    const s = side.shatters[i];
    s.life -= dt;
    if (s.mesh.material) s.mesh.material.opacity = 0.8 * (s.life / s.maxLife);
    if (s.life <= 0) { scene.remove(s.mesh); side.shatters.splice(i, 1); }
  }
}

// Black Hole (E): spawnar black hole vid target. Suger in 3s + explosion vid slut.
function hostCastBlink(side, ev) {
  if (side.hero.dead || side.skills.e.cd > 0) return;
  side.skills.e.cd = side.skills.e.max;
  const center = soloResolveSkillGroundTarget(side, ev || {}, BLACKHOLE_CAST_DISTANCE);
  const sphereMat = new THREE.MeshStandardMaterial({ color: 0x080012, emissive: 0x442288, emissiveIntensity: 0.9, roughness: 0.3, transparent: true, opacity: 0.95 });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.8, 24, 16), sphereMat);
  sphere.position.set(center.x, 0.8, center.z);
  scene.add(sphere);
  // Yttre swirl-ring (visuell)
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(BLACKHOLE_RADIUS - 0.3, BLACKHOLE_RADIUS, 48),
    new THREE.MeshBasicMaterial({ color: 0x9966ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(center.x, 0.05, center.z);
  scene.add(ring);
  side.blackHoles = side.blackHoles || [];
  side.blackHoles.push({
    sphere, ring,
    x: center.x, z: center.z,
    life: BLACKHOLE_DURATION, maxLife: BLACKHOLE_DURATION,
    explosionDmg: BLACKHOLE_EXPLOSION_DMG * (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1),
  });
}

function updateBlackHolesSolo(side, dt) {
  if (!side.blackHoles || side.blackHoles.length === 0) return;
  const opp = sides[3 - side.idx];
  for (let i = side.blackHoles.length - 1; i >= 0; i--) {
    const bh = side.blackHoles[i];
    bh.life -= dt;
    const pull = BLACKHOLE_PULL_SPEED * dt;
    // Sug in monsters + creeps
    for (const m of side.monsters) {
      const dx = bh.x - m.mesh.position.x, dz = bh.z - m.mesh.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.15 && d < BLACKHOLE_RADIUS) {
        const f = 1 - d / BLACKHOLE_RADIUS;
        m.mesh.position.x += (dx / d) * pull * (0.4 + f * 0.6);
        m.mesh.position.z += (dz / d) * pull * (0.4 + f * 0.6);
      }
    }
    if (opp) for (const c of opp.playerCreeps) {
      const dx = bh.x - c.mesh.position.x, dz = bh.z - c.mesh.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.15 && d < BLACKHOLE_RADIUS) {
        const f = 1 - d / BLACKHOLE_RADIUS;
        c.mesh.position.x += (dx / d) * pull * (0.4 + f * 0.6);
        c.mesh.position.z += (dz / d) * pull * (0.4 + f * 0.6);
      }
    }
    // Snurra sfär
    bh.sphere.rotation.y += dt * 4;
    bh.ring.rotation.z += dt * 2;
    // Pulse sphere scale based on life
    const t = 1 - bh.life / bh.maxLife;
    bh.sphere.scale.setScalar(1 + 0.3 * Math.sin(t * 20));
    if (bh.life <= 0) {
      // Explosion
      for (let j = side.monsters.length - 1; j >= 0; j--) {
        const m = side.monsters[j];
        if (Math.hypot(m.mesh.position.x - bh.x, m.mesh.position.z - bh.z) < BLACKHOLE_EXPLOSION_RADIUS) {
          soloApplySkillDmgToMonster(side, opp, j, bh.explosionDmg);
        }
      }
      if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
        const c = opp.playerCreeps[j];
        if (Math.hypot(c.mesh.position.x - bh.x, c.mesh.position.z - bh.z) < BLACKHOLE_EXPLOSION_RADIUS) {
          soloApplySkillDmgToCreep(side, opp, c, bh.explosionDmg);
          if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(j, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
        }
      }
      scene.remove(bh.sphere);
      scene.remove(bh.ring);
      side.blackHoles.splice(i, 1);
    }
  }
}

// === Legolus skills (solo) ===
function hostCastLegolusVineTrap(side, ev) {
  if (side.hero.dead || side.skills.q.cd > 0) return;
  side.skills.q.cd = side.skills.q.max;
  const center = soloResolveSkillGroundTarget(side, ev || {}, VINE_TRAP_CAST_DISTANCE);
  // Visuell brun rot-ring + spinkar
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(VINE_TRAP_RADIUS * 0.85, VINE_TRAP_RADIUS, 36),
    new THREE.MeshBasicMaterial({ color: 0x4a8030, transparent: true, opacity: 0.65, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(center.x, 0.07, center.z);
  scene.add(ring);
  // Småspikar/rötter på marken
  const spikes = [];
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    const r = VINE_TRAP_RADIUS * 0.6;
    const sp = new THREE.Mesh(
      new THREE.ConeGeometry(0.08, 0.35, 6),
      new THREE.MeshStandardMaterial({ color: 0x3a5018, roughness: 0.85 })
    );
    sp.position.set(center.x + Math.cos(ang) * r, 0.17, center.z + Math.sin(ang) * r);
    scene.add(sp);
    spikes.push(sp);
  }
  side.vineTraps = side.vineTraps || [];
  side.vineTraps.push({
    ring, spikes,
    x: center.x, z: center.z,
    life: VINE_TRAP_DURATION, maxLife: VINE_TRAP_DURATION,
    dotPerSec: VINE_TRAP_DOT_DPS * (side.skillDmgMul || 1),
    radius: VINE_TRAP_RADIUS,
  });
}

function hostCastLegolusBuff(side) {
  if (side.hero.dead || side.skills.f.cd > 0) return;
  side.skills.f.cd = side.skills.f.max;
  side.legolusBuffRemaining = LEGOLUS_BUFF_DURATION;
}

function hostCastLegolusDash(side, ev) {
  if (side.hero.dead || side.skills.e.cd > 0) return;
  let dx = (ev && ev.dx) || 0, dz = (ev && ev.dz) || 0;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) { dx = side.hero.facingX; dz = side.hero.facingZ; }
  else { dx /= len; dz /= len; }
  let dist = LEGOLUS_DASH_DISTANCE, nx, nz;
  while (dist >= 0.5) {
    nx = side.hero.x + dx * dist;
    nz = side.hero.z + dz * dist;
    if (isHeroWalkable(side.idx, nx, nz)) break;
    dist -= 0.5;
  }
  if (dist < 0.5) return;
  side.skills.e.cd = side.skills.e.max;
  side.hero.x = nx; side.hero.z = nz;
  side.mesh.position.x = nx; side.mesh.position.z = nz;
  side.legolusDashBuffPending = true;
}

function updateVineTrapsSolo(side, dt) {
  if (!side.vineTraps || side.vineTraps.length === 0) return;
  const opp = sides[3 - side.idx];
  for (let i = side.vineTraps.length - 1; i >= 0; i--) {
    const vt = side.vineTraps[i];
    vt.life -= dt;
    const r2 = vt.radius * vt.radius;
    // Apply DoT + root på entiteter i radien
    for (let j = side.monsters.length - 1; j >= 0; j--) {
      const m = side.monsters[j];
      const dx = m.mesh.position.x - vt.x, dz = m.mesh.position.z - vt.z;
      if (dx * dx + dz * dz < r2) {
        m.frozenTime = Math.max(m.frozenTime || 0, VINE_TRAP_ROOT_REFRESH);
        m.hp -= vt.dotPerSec * dt;
        if (m.hp <= 0) { hostKillMonster(side, j, side); }
      }
    }
    if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
      const c = opp.playerCreeps[j];
      const dx = c.mesh.position.x - vt.x, dz = c.mesh.position.z - vt.z;
      if (dx * dx + dz * dz < r2) {
        c.frozenTime = Math.max(c.frozenTime || 0, VINE_TRAP_ROOT_REFRESH);
        c.hp -= vt.dotPerSec * dt;
        if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(j, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
      }
    }
    // Fade ring + spikar
    if (vt.ring && vt.ring.material) vt.ring.material.opacity = 0.65 * (vt.life / vt.maxLife);
    if (vt.life <= 0) {
      if (vt.ring) scene.remove(vt.ring);
      if (vt.spikes) for (const sp of vt.spikes) scene.remove(sp);
      side.vineTraps.splice(i, 1);
    }
  }
}

// === Gimlu skills (solo) ===
function hostCastGimluTaunt(side) {
  if (side.hero.dead || side.skills.q.cd > 0) return;
  side.skills.q.cd = side.skills.q.max;
  side.titansTauntRemaining = TAUNT_DURATION;
  const r2 = TAUNT_RADIUS * TAUNT_RADIUS;
  for (const m of side.monsters) {
    const dx = m.mesh.position.x - side.hero.x, dz = m.mesh.position.z - side.hero.z;
    if (dx * dx + dz * dz < r2) {
      m.tauntedTime = TAUNT_DURATION;
      m.chasing = true;
    }
  }
  const opp = sides[3 - side.idx];
  if (opp) for (const c of opp.playerCreeps) {
    const dx = c.mesh.position.x - side.hero.x, dz = c.mesh.position.z - side.hero.z;
    if (dx * dx + dz * dz < r2) c.tauntedTime = TAUNT_DURATION;
  }
  // Visuell taunt-ring
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(TAUNT_RADIUS - 0.4, TAUNT_RADIUS, 48),
    new THREE.MeshBasicMaterial({ color: 0xffaa55, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(side.hero.x, 0.1, side.hero.z);
  scene.add(ring);
  side.novaEffects.push({ mesh: ring, life: 0.7, maxLife: 0.7 });
}

function hostCastGimluIronWill(side) {
  if (side.hero.dead || side.skills.f.cd > 0) return;
  side.skills.f.cd = side.skills.f.max;
  side.ironWillRemaining = IRON_WILL_DURATION;
  side.ironWillStored = 0;
}

function updateIronWillSolo(side, dt) {
  if (!side.ironWillRemaining || side.ironWillRemaining <= 0) return;
  side.ironWillRemaining -= dt;
  if (side.ironWillRemaining <= 0) {
    const dmg = side.ironWillStored || 0;
    side.ironWillStored = 0;
    side.ironWillRemaining = 0;
    if (dmg > 0) {
      const r2 = IRON_WILL_EXPLOSION_RADIUS * IRON_WILL_EXPLOSION_RADIUS;
      const opp = sides[3 - side.idx];
      for (let i = side.monsters.length - 1; i >= 0; i--) {
        const m = side.monsters[i];
        const ddx = m.mesh.position.x - side.hero.x, ddz = m.mesh.position.z - side.hero.z;
        if (ddx * ddx + ddz * ddz < r2) {
          m.hp -= dmg;
          if (m.hp <= 0) hostKillMonster(side, i, side);
        }
      }
      if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
        const c = opp.playerCreeps[i];
        const ddx = c.mesh.position.x - side.hero.x, ddz = c.mesh.position.z - side.hero.z;
        if (ddx * ddx + ddz * ddz < r2) {
          c.hp -= dmg;
          if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(i, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
        }
      }
      // Stor explosion-ring
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.5, IRON_WILL_EXPLOSION_RADIUS, 56),
        new THREE.MeshBasicMaterial({ color: 0xff7733, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(side.hero.x, 0.12, side.hero.z);
      scene.add(ring);
      side.novaEffects.push({ mesh: ring, life: 0.8, maxLife: 0.8 });
    }
  }
}

function hostCastGimluHammer(side, dirX, dirZ) {
  if (side.hero.dead) return;
  // Teleport om hammer redan ute
  if (side.hammers && side.hammers.length > 0) {
    const h = side.hammers[0];
    if (isHeroWalkable(side.idx, h.mesh.position.x, h.mesh.position.z)) {
      side.hero.x = h.mesh.position.x;
      side.hero.z = h.mesh.position.z;
      side.mesh.position.x = side.hero.x;
      side.mesh.position.z = side.hero.z;
    }
    scene.remove(h.mesh);
    side.hammers.splice(0, 1);
    return;
  }
  if (side.skills.e.cd > 0) return;
  side.skills.e.cd = side.skills.e.max;
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.01) { dirX = side.hero.facingX; dirZ = side.hero.facingZ; }
  else { dirX /= len; dirZ /= len; }
  // Hammar-mesh: cylinder skaft + box huvud
  const grp = new THREE.Group();
  const haft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.6, 8), new THREE.MeshStandardMaterial({ color: 0x3a2410, roughness: 0.85 }));
  haft.rotation.z = Math.PI / 2;
  grp.add(haft);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.22), new THREE.MeshStandardMaterial({ color: 0x808488, metalness: 0.55, roughness: 0.35 }));
  head.position.x = 0.3;
  grp.add(head);
  grp.position.set(side.hero.x, 1.0, side.hero.z);
  scene.add(grp);
  side.hammers = side.hammers || [];
  side.hammers.push({
    mesh: grp,
    dx: dirX, dz: dirZ,
    traveled: 0,
    returning: false,
    hit: new Set(),
    damage: HAMMER_DAMAGE * (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1),
  });
}

function updateHammersSolo(side, dt) {
  if (!side.hammers || side.hammers.length === 0) return;
  const opp = sides[3 - side.idx];
  for (let i = side.hammers.length - 1; i >= 0; i--) {
    const h = side.hammers[i];
    const step = HAMMER_SPEED * dt;
    if (!h.returning) {
      h.mesh.position.x += h.dx * step;
      h.mesh.position.z += h.dz * step;
      h.traveled += step;
      if (h.traveled >= HAMMER_RANGE) {
        h.returning = true;
        h.hit = new Set();
      }
    } else {
      const ddx = side.hero.x - h.mesh.position.x, ddz = side.hero.z - h.mesh.position.z;
      const d = Math.hypot(ddx, ddz);
      if (d < 0.6) {
        scene.remove(h.mesh);
        side.hammers.splice(i, 1);
        continue;
      }
      h.mesh.position.x += (ddx / d) * step;
      h.mesh.position.z += (ddz / d) * step;
    }
    h.mesh.rotation.y += dt * 12; // spinn
    const dmgMul = h.returning ? HAMMER_RETURN_DMG_MUL : 1;
    const dmg = h.damage * dmgMul;
    for (let j = side.monsters.length - 1; j >= 0; j--) {
      const m = side.monsters[j];
      if (h.hit.has(m.id)) continue;
      if (Math.hypot(m.mesh.position.x - h.mesh.position.x, m.mesh.position.z - h.mesh.position.z) < HAMMER_RADIUS) {
        h.hit.add(m.id);
        m.hp -= dmg;
        if (!side.hero.dead) side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + dmg * HAMMER_LIFESTEAL);
        if (m.hp <= 0) hostKillMonster(side, j, side);
      }
    }
    if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
      const c = opp.playerCreeps[j];
      if (h.hit.has(c.id)) continue;
      if (Math.hypot(c.mesh.position.x - h.mesh.position.x, c.mesh.position.z - h.mesh.position.z) < HAMMER_RADIUS) {
        h.hit.add(c.id);
        c.hp -= dmg;
        if (!side.hero.dead) side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + dmg * HAMMER_LIFESTEAL);
        if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(j, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
      }
    }
  }
}

function updateSkillCooldowns(side, dt) {
  const eff = dt * (side.heroFountainAura ? FOUNTAIN_CDR_MUL : 1);
  side.skills.q.cd = Math.max(0, side.skills.q.cd - eff);
  side.skills.f.cd = Math.max(0, side.skills.f.cd - eff);
  side.skills.e.cd = Math.max(0, side.skills.e.cd - eff);
}

// ============================================================
// HOST: APPLICERA INPUT FÖR EN SIDA
// ============================================================

// ============================================================
// HJÄLTE-ITEMS (6 st, max level 10)
// Placeholder — användaren fyller i statsAtLevel-funktionerna senare.
//
// statsAtLevel(level) returnerar ett objekt med några av:
//   attackDmg, moveSpeed, maxHp
// Värden ADDERAS till hjältens bas-stats. Bas är:
//   attackDmg = 5, moveSpeed = 6, maxHp = 100
//
// Exempel hur ni fyller i:
//   item1: { ..., statsAtLevel: (level) => ({ attackDmg: 3 * level, maxHp: 15 * level }) }
//   → Level 3 ger då +9 skada och +45 max HP
// ============================================================

// Per-level-scaling-formel: 10% * 1.2^(level-1). Lvl1=10%, lvl2=12%, ..., lvl10=51.6%.
const bootsPct = (level) => 0.10 * Math.pow(1.2, level - 1);
const gloveBigPct = (level) => 0.10 * Math.pow(1.2, level - 1);
const gloveHealPct = (level) => 0.01 * Math.pow(1.2, level - 1);

const ITEM_TYPES = {
  item1: {
    id: 'item1',
    name: 'Boots',
    icon: '👢',
    description: '3 stilar att välja mellan',
    variants: {
      speed: {
        id: 'speed', parentId: 'item1', name: 'Boots of Speed', icon: '⚡',
        description: 'Snabbare rörelse och attacker',
        statsAtLevel: (level) => {
          const v = bootsPct(level);
          return { moveSpeedPct: v, attackSpeedPct: v };
        },
        activeAtMax: {
          duration: 5, cooldown: 30,
          description: '+50% rörelse och attackfart i 5s',
          stats: { moveSpeedPct: 0.5, attackSpeedPct: 0.5 },
        },
      },
      magic: {
        id: 'magic', parentId: 'item1', name: 'Boots of Magic', icon: '✨',
        description: 'Förstärker skills och kortar cooldowns',
        statsAtLevel: (level) => {
          const v = bootsPct(level);
          return { skillDmgPct: v, cdrPct: v };
        },
        activeAtMax: {
          duration: 5, cooldown: 30,
          description: '+50% skill-skada och CDR i 5s',
          stats: { skillDmgPct: 0.5, cdrPct: 0.5 },
        },
      },
      tank: {
        id: 'tank', parentId: 'item1', name: 'Boots of Tank', icon: '🛡',
        description: 'Mer HP och mindre inkommande skada',
        statsAtLevel: (level) => {
          const v = bootsPct(level);
          return { dmgReductionPct: v, maxHpPct: v };
        },
        activeAtMax: {
          duration: 5, cooldown: 30,
          description: '+50% skadereduktion och max HP i 5s',
          stats: { dmgReductionPct: 0.5, maxHpPct: 0.5 },
        },
      },
    },
  },
  item2: {
    id: 'item2',
    name: 'Glove of Haste',
    icon: '🧤',
    description: '3 stilar att välja mellan',
    variants: {
      haste: {
        id: 'haste', parentId: 'item2', name: 'Glove of Haste', icon: '⚡',
        description: 'Snabbare AA + chans till crit',
        statsAtLevel: (level) => {
          const v = gloveBigPct(level);
          return { attackSpeedPct: v, critChancePct: v };
        },
        activeAtMax: {
          duration: 5, cooldown: 30,
          description: '+50% attackfart och crit chans i 5s',
          stats: { attackSpeedPct: 0.5, critChancePct: 0.5 },
        },
      },
      spell: {
        id: 'spell', parentId: 'item2', name: 'Glove of Spell', icon: '🔮',
        description: 'Mer skill-skada och CDR',
        statsAtLevel: (level) => {
          const v = gloveBigPct(level);
          return { skillDmgPct: v, cdrPct: v };
        },
        activeAtMax: {
          duration: 5, cooldown: 30,
          description: '+50% skill-skada och CDR i 5s',
          stats: { skillDmgPct: 0.5, cdrPct: 0.5 },
        },
      },
      tank: {
        id: 'tank', parentId: 'item2', name: 'Glove of Tank', icon: '🛡',
        description: 'Skadereduktion + passiv HP-regen',
        statsAtLevel: (level) => {
          const v = gloveBigPct(level);
          const h = gloveHealPct(level);
          return { dmgReductionPct: v, healPerSecPct: h };
        },
        activeAtMax: {
          duration: 5, cooldown: 30,
          description: '+50% skadereduktion och 5%/s heal i 5s',
          stats: { dmgReductionPct: 0.5, healPerSecPct: 0.05 },
        },
      },
    },
  },
  item3: { id: 'item3', name: 'Item 3', icon: '③', description: '(stats TBD)', statsAtLevel: (level) => ({}) },
  item4: { id: 'item4', name: 'Item 4', icon: '④', description: '(stats TBD)', statsAtLevel: (level) => ({}) },
  item5: { id: 'item5', name: 'Item 5', icon: '⑤', description: '(stats TBD)', statsAtLevel: (level) => ({}) },
  item6: { id: 'item6', name: 'Item 6', icon: '⑥', description: '(stats TBD)', statsAtLevel: (level) => ({}) },
};
const ITEM_ORDER = ['item1', 'item2', 'item3', 'item4', 'item5', 'item6'];
const ITEM_BUY_COST = 200;
const ITEM_MAX_LEVEL = 10;
const INVENTORY_SLOTS = 4;

function itemUpgradeCost(currentLevel) {
  // 1->2 = 500, 2->3 = 1000, ..., 9->10 = 128000
  return 500 * Math.pow(2, currentLevel - 1);
}

// Bas-cooldowns per skill (modifieras av CDR i recompute)
const SKILL_BASE_CD = { q: 4.0, f: 8.0, e: 10.0 };

// Active-buff-parametrar
const ACTIVE_DURATION = 5;       // sek
const ACTIVE_COOLDOWN = 30;      // sek mellan aktiveringar

// Hämtar item-definitionen för en inventory-rad — variant prioriteras
function itemDefForEntry(entry) {
  const root = ITEM_TYPES[entry.itemId];
  if (!root) return null;
  if (entry.variantId && root.variants && root.variants[entry.variantId]) {
    return root.variants[entry.variantId];
  }
  return root;
}

// Räknar om hjältens stats från bas + alla items i inventoryn + aktiva buffar.
function recomputeSideStats(side) {
  const def = heroDef(side.heroId);
  side.attackRange = def.attackRange;
  side.attackInterval = def.attackInterval;
  let attackDmg = def.baseDmg;
  let moveSpeedFlat = def.baseMoveSpeed;
  let maxHpFlat = def.baseHp;
  let attackSpeedPct = 0;
  let moveSpeedPct = 0;
  let skillDmgPct = 0;
  let cdrPct = 0;
  let dmgReductionPct = 0;
  let maxHpPct = 0;
  let critChancePct = 0;
  let healPerSecPct = 0;

  const addStats = (stats) => {
    if (!stats) return;
    attackDmg += stats.attackDmg || 0;
    moveSpeedFlat += stats.moveSpeed || 0;
    maxHpFlat += stats.maxHp || 0;
    attackSpeedPct += stats.attackSpeedPct || 0;
    moveSpeedPct += stats.moveSpeedPct || 0;
    skillDmgPct += stats.skillDmgPct || 0;
    cdrPct += stats.cdrPct || 0;
    dmgReductionPct += stats.dmgReductionPct || 0;
    maxHpPct += stats.maxHpPct || 0;
    critChancePct += stats.critChancePct || 0;
    healPerSecPct += stats.healPerSecPct || 0;
  };

  for (const entry of side.inventory) {
    const def = itemDefForEntry(entry);
    if (!def) continue;
    if (def.statsAtLevel) addStats(def.statsAtLevel(entry.level));
    // Active buff aktiv just nu? Lägg på dess stats också.
    if ((entry.activeRemaining || 0) > 0 && def.activeAtMax && def.activeAtMax.stats) {
      addStats(def.activeAtMax.stats);
    }
  }

  // Level-skalning ovanpå items (matchar server-engine)
  const lvl = (side.level || 1) - 1;
  const levelDmgMul = 1 + LEVEL_DMG_PCT * lvl;
  const levelHpMul = 1 + LEVEL_HP_PCT * lvl;
  const levelMsMul = 1 + LEVEL_MS_PCT * lvl;
  side.attackDmg = attackDmg * levelDmgMul;
  side.moveSpeed = moveSpeedFlat * (1 + moveSpeedPct) * levelMsMul;
  side.attackSpeedMul = 1 + attackSpeedPct;
  side.skillDmgMul = (1 + skillDmgPct) * levelDmgMul;
  side.cdrMul = Math.max(0.1, 1 - cdrPct);
  side.dmgReductionMul = Math.max(0.0, 1 - dmgReductionPct);
  side.critChancePct = Math.min(1, critChancePct);
  side.healPerSecPct = Math.max(0, healPerSecPct);

  // Max HP — räkna ny topp, behåll relativ HP vid förändring
  const newMaxHp = Math.round(maxHpFlat * (1 + maxHpPct) * levelHpMul);
  if (newMaxHp !== side.hero.maxHp) {
    const delta = newMaxHp - side.hero.maxHp;
    side.hero.maxHp = newMaxHp;
    if (delta > 0) side.hero.hp = Math.min(newMaxHp, side.hero.hp + delta);
    else if (side.hero.hp > newMaxHp) side.hero.hp = newMaxHp;
  }

  // Skill-cooldown-cap räknas via CDR (max-värdet sätts om så castcd sätter rätt)
  side.skills.q.max = SKILL_BASE_CD.q * side.cdrMul;
  side.skills.f.max = SKILL_BASE_CD.f * side.cdrMul;
  side.skills.e.max = SKILL_BASE_CD.e * side.cdrMul;
}

// Skada till hjälten — applicerar dmgReductionMul från items + fontän-aura.
function damageHero(side, amount) {
  if (side.hero.dead) return;
  const auraMul = side.heroFountainAura ? FOUNTAIN_DMG_REDUCTION_MUL : 1;
  const tauntMul = (side.titansTauntRemaining || 0) > 0 ? (1 - TAUNT_DMG_REDUCTION) : 1;
  const final = amount * (side.dmgReductionMul ?? 1) * auraMul * tauntMul;
  side.hero.hp = Math.max(0, side.hero.hp - final);
  if ((side.titansTauntRemaining || 0) > 0 && side.hero.hp > 0) {
    side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + final * TAUNT_HEAL_PCT);
  }
  if ((side.ironWillRemaining || 0) > 0) {
    side.ironWillStored = (side.ironWillStored || 0) + final;
  }
  if (side.hero.hp <= 0) killHero(side);
}

// Tickar aktiv-buf och cooldown per item i inventoryn. Triggar recompute vid expire.
function updateActiveBuffs(side, dt) {
  let buffEnded = false;
  for (const entry of side.inventory) {
    if ((entry.activeRemaining || 0) > 0) {
      entry.activeRemaining -= dt;
      if (entry.activeRemaining <= 0) {
        entry.activeRemaining = 0;
        buffEnded = true;
      }
    }
    if ((entry.activeCd || 0) > 0) {
      entry.activeCd -= dt;
      if (entry.activeCd < 0) entry.activeCd = 0;
    }
  }
  if (buffEnded) recomputeSideStats(side);
}

function activateInventoryItem(side, slotIdx) {
  const entry = side.inventory[slotIdx];
  if (!entry) return;
  const def = itemDefForEntry(entry);
  if (!def || !def.activeAtMax) return;
  if (entry.level < ITEM_MAX_LEVEL) return;
  if ((entry.activeCd || 0) > 0) return;
  if ((entry.activeRemaining || 0) > 0) return;
  entry.activeRemaining = def.activeAtMax.duration ?? ACTIVE_DURATION;
  entry.activeCd = def.activeAtMax.cooldown ?? ACTIVE_COOLDOWN;
  recomputeSideStats(side);
}

function applyMovement(side, joyX, joyZ, dt) {
  if (side.hero.dead) return;
  const mag = Math.hypot(joyX, joyZ);
  if (mag < 0.05) return;
  const strength = Math.min(1, mag);
  const ndx = joyX / mag, ndz = joyZ / mag;
  side.hero.facingX = ndx;
  side.hero.facingZ = ndz;
  const nx = side.hero.x + ndx * side.moveSpeed * strength * dt;
  const nz = side.hero.z + ndz * side.moveSpeed * strength * dt;
  if (isHeroWalkable(side.idx, nx, nz)) { side.hero.x = nx; side.hero.z = nz; }
  else if (isHeroWalkable(side.idx, nx, side.hero.z)) side.hero.x = nx;
  else if (isHeroWalkable(side.idx, side.hero.x, nz)) side.hero.z = nz;
  side.mesh.position.x = side.hero.x;
  side.mesh.position.z = side.hero.z;
  side.mesh.rotation.y = Math.atan2(ndx, ndz);
}

function applyEvent(side, ev) {
  if (ev.type === 'cheat') {
    if (ev.cmd === 'gold' && typeof ev.amount === 'number') {
      const amt = Math.max(0, Math.min(10_000_000, Math.floor(ev.amount)));
      side.gold += amt;
    }
    return;
  }
  if (ev.type === 'aa') {
    if (side.hero.dead) return;
    side.aaActive = true;
    const t = findClosestHostile(side, side.hero.x, side.hero.z, side.attackRange || HERO_ATTACK_RANGE);
    if (t) {
      side.targetId = t.entity.id;
      side.targetType = t.isMonster ? 'monster' : 'creep';
      side.targetX = t.entity.mesh.position.x;
      side.targetZ = t.entity.mesh.position.z;
    } else {
      side.targetId = 0; side.targetType = '';
    }
    return;
  }
  if (ev.type === 'aa-cancel') {
    side.aaActive = false;
    side.targetId = 0; side.targetType = '';
    return;
  }
  if (ev.type === 'skill') {
    let dx = ev.dx, dz = ev.dz;
    if (ev.tap === true && side.targetId) {
      const opp = sides[3 - side.idx];
      const t = resolveTargetEntity(side, opp);
      if (t) {
        const ddx = t.mesh.position.x - side.hero.x;
        const ddz = t.mesh.position.z - side.hero.z;
        const m = Math.hypot(ddx, ddz);
        if (m > 0.01) { dx = ddx / m; dz = ddz / m; }
      }
    }
    const isLegolus = side.heroId === 'legolas';
    const isGimlu = side.heroId === 'gimlu';
    if (ev.key === 'q') {
      if (isLegolus) hostCastLegolusVineTrap(side, ev);
      else if (isGimlu) hostCastGimluTaunt(side);
      else hostCastEldklot(side, dx, dz);
    } else if (ev.key === 'f') {
      if (isLegolus) hostCastLegolusBuff(side);
      else if (isGimlu) hostCastGimluIronWill(side);
      else hostCastFrostnova(side, ev);
    } else if (ev.key === 'e') {
      if (isLegolus) hostCastLegolusDash(side, ev);
      else if (isGimlu) hostCastGimluHammer(side, dx, dz);
      else hostCastBlink(side, ev);
    }
    return;
  }
  if (ev.type === 'activate') {
    if (side.hero.dead) return;
    activateInventoryItem(side, ev.slot);
    return;
  }
  if (ev.type !== 'shop') return;
  if (side.hero.dead) return;
  if (!inSideBase(side.idx, side.hero.x, side.hero.z)) return;

  if (ev.kind === 'item') {
    const def = ITEM_TYPES[ev.item];
    if (!def) return;
    const existing = side.inventory.find(it => it.itemId === ev.item);
    if (!existing) {
      // Köp lvl 1 — om itemet har varianter måste en variant väljas
      if (def.variants) {
        if (!ev.variant || !def.variants[ev.variant]) return;
      }
      if (side.inventory.length >= INVENTORY_SLOTS) return;
      if (side.gold < ITEM_BUY_COST) return;
      side.gold -= ITEM_BUY_COST;
      const entry = {
        itemId: ev.item,
        level: 1,
        activeRemaining: 0,
        activeCd: 0,
      };
      if (def.variants && ev.variant) entry.variantId = ev.variant;
      side.inventory.push(entry);
    } else {
      // Uppgradera till nästa level
      if (existing.level >= ITEM_MAX_LEVEL) return;
      const cost = itemUpgradeCost(existing.level);
      if (side.gold < cost) return;
      side.gold -= cost;
      existing.level += 1;
    }
    recomputeSideStats(side);
  } else if (ev.kind === 'minion') {
    const def = MINION_TYPES[ev.minionType];
    if (!def || !side.tierUnlocks[def.tier]) return;
    if (side.gold < def.cost) return;
    if (ev.lane !== 1 && ev.lane !== 2) return;
    side.gold -= def.cost;
    side.income += Math.floor(def.cost * INCOME_MINION_RATIO);
    hostSpawnMinion(side, ev.minionType, ev.lane);
  } else if (ev.kind === 'unlock') {
    const tier = ev.tier;
    if (!TIER_UNLOCK_COST[tier] || side.tierUnlocks[tier]) return;
    // Sekventiellt: alla tiers under måste redan vara upplåsta
    for (let t = 2; t < tier; t++) if (!side.tierUnlocks[t]) return;
    const cost = TIER_UNLOCK_COST[tier];
    if (side.gold < cost) return;
    side.gold -= cost;
    side.tierUnlocks[tier] = true;
  }
}

// ============================================================
// CLIENT: APPLICERA MOTTAGEN STATE
// ============================================================

const clientMeshes = {
  monsters: new Map(),     // sideIdx -> Map(id -> mesh)
  playerCreeps: new Map(),
  fireballs: new Map(),
  projectiles: new Map(),
  novaEffects: new Map(),
  creepProjectiles: new Map(),
  heroCopies: new Map(),
  heroCopyFireballs: new Map(),
  fireWaves: new Map(),
  blackHoles: new Map(),
  shatters: new Map(),
  vineTraps: new Map(),
  hammers: new Map(),
  ironWillExplosions: new Map(),
};

// Entiteter där interpolation gör störst nytta (karaktärer) — snabbflygande projektiler snappar.
const INTERPOLATED_KEYS = new Set(['monsters', 'playerCreeps', 'heroCopies']);

function clientReconcileEntities(sideIdx, key, list, makeMesh) {
  if (!clientMeshes[key].has(sideIdx)) clientMeshes[key].set(sideIdx, new Map());
  const map = clientMeshes[key].get(sideIdx);
  const seen = new Set();
  const interpolate = INTERPOLATED_KEYS.has(key);
  for (const e of list) {
    seen.add(e.id);
    let mesh = map.get(e.id);
    const fresh = !mesh;
    if (fresh) {
      mesh = makeMesh(e);
      scene.add(mesh);
      map.set(e.id, mesh);
      // Initial snap
      mesh.position.x = e.x;
      mesh.position.z = e.z;
      if (e.y !== undefined) mesh.position.y = e.y;
      if (e.ry !== undefined) mesh.rotation.y = e.ry;
    }
    if (interpolate) {
      mesh._target = { x: e.x, z: e.z };
      if (e.ry !== undefined) mesh._target.ry = e.ry;
    } else {
      // Snap (projektiler/effekter)
      mesh.position.x = e.x;
      mesh.position.z = e.z;
      if (e.y !== undefined) mesh.position.y = e.y;
      if (e.ry !== undefined) mesh.rotation.y = e.ry;
    }
    if (e.life !== undefined && mesh.material && mesh.material.opacity !== undefined) {
      mesh.material.opacity = 0.7 * Math.max(0, e.life);
    }
    // HP-tracking (för hpBar i MP) — markera lastHurtTime när hp sjunker
    if (e.hp !== undefined) {
      mesh.userData = mesh.userData || {};
      const prev = mesh.userData.curHp;
      if (prev !== undefined && e.hp < prev) mesh.userData.lastHurtTime = performance.now() / 1000;
      mesh.userData.curHp = e.hp;
      mesh.userData.maxHp = e.mh || mesh.userData.maxHp || 1;
    }
  }
  for (const [id, mesh] of map) {
    if (!seen.has(id)) {
      scene.remove(mesh);
      map.delete(id);
    }
  }
}

// Lerpar interpolerande meshes mot sitt _target varje frame.
function smoothEntityMeshes(dt) {
  const k = 1 - Math.pow(0.5, dt / 0.06);  // ~60 ms halflife
  // Hero-meshes (båda sidor)
  for (const sideIdx of [1, 2]) {
    const side = sides[sideIdx];
    if (!side || !side.mesh._target) continue;
    smoothMeshToTarget(side.mesh, k);
  }
  // Karaktär-meshes (monsters + creeps) på båda sidor
  for (const key of INTERPOLATED_KEYS) {
    const tier = clientMeshes[key];
    if (!tier) continue;
    for (const map of tier.values()) {
      for (const mesh of map.values()) smoothMeshToTarget(mesh, k);
    }
  }
}

function smoothMeshToTarget(mesh, k) {
  const t = mesh._target;
  if (!t) return;
  mesh.position.x += (t.x - mesh.position.x) * k;
  mesh.position.z += (t.z - mesh.position.z) * k;
  if (t.ry !== undefined) {
    let d = t.ry - mesh.rotation.y;
    if (d > Math.PI) d -= 2 * Math.PI;
    else if (d < -Math.PI) d += 2 * Math.PI;
    mesh.rotation.y += d * k;
  }
}

// ============================================================
// Karaktärsanimation: walk-cykel + hero-attack-thrust
// Detekterar rörelse via position-delta, driver pivot-rotation
// på ben/armar i userData.rig. Ersätter den gamla idle-bob:en.
// ============================================================

const WALK_AMPLITUDE = 0.55;     // hur långt benen svingar (radianer)
const ATTACK_DURATION = 0.4;     // sek per attack-thrust
const HERO_ATTACK_DURATION = 0.4;
const CREEP_ATTACK_DURATION = 0.3;

function animateCharacter(mesh, dt, side, type) {
  const rig = mesh.userData && mesh.userData.rig;
  if (!rig) return;

  let st = mesh._animState;
  if (!st) {
    st = mesh._animState = {
      lastX: mesh.position.x,
      lastZ: mesh.position.z,
      walkPhase: Math.random() * Math.PI * 2,
      idlePhase: Math.random() * Math.PI * 2,
      attackTimer: 0,
      attackTotal: ATTACK_DURATION,
    };
  }

  // Velocity från positionsdelta
  const dx = mesh.position.x - st.lastX;
  const dz = mesh.position.z - st.lastZ;
  const dist = Math.hypot(dx, dz);
  const vel = dist / Math.max(dt, 0.001);
  st.lastX = mesh.position.x;
  st.lastZ = mesh.position.z;

  const moving = vel > 0.4;
  if (moving) st.walkPhase += dt * Math.min(vel * 2.2, 12);

  // Walk-pose: armar svingar i motsatt fas mot ben
  const swing = moving ? Math.sin(st.walkPhase) * WALK_AMPLITUDE : 0;
  if (rig.leftLeg) rig.leftLeg.rotation.x = swing;
  if (rig.rightLeg) rig.rightLeg.rotation.x = -swing;
  if (rig.leftArm) rig.leftArm.rotation.x = -swing * 0.55;
  if (rig.rightArm) rig.rightArm.rotation.x = swing * 0.55;

  // Body-bounce vid gång; idle-breath stilla
  if (moving) {
    mesh.position.y = Math.abs(Math.cos(st.walkPhase)) * 0.04;
  } else {
    const t = performance.now() / 1000;
    mesh.position.y = Math.sin(t * 1.6 + st.idlePhase) * 0.012;
  }

  // Hero-attack-detektion: attackCounter-delta från state + skill-CD-hopp
  if (side && type === 'hero') {
    if (side._lastAttackCounter === undefined) side._lastAttackCounter = side.attackCounter || 0;
    if ((side.attackCounter || 0) > side._lastAttackCounter) {
      side._lastAttackCounter = side.attackCounter;
      st.attackTimer = HERO_ATTACK_DURATION;
      st.attackTotal = HERO_ATTACK_DURATION;
    }
    if (!side._lastSkillCd) side._lastSkillCd = { q: 0, f: 0, e: 0 };
    for (const k of ['q', 'f', 'e']) {
      const cur = (side.skills && side.skills[k]) ? side.skills[k].cd : 0;
      if (cur > side._lastSkillCd[k] + 0.5 && cur > 0.5) {
        st.attackTimer = HERO_ATTACK_DURATION;
        st.attackTotal = HERO_ATTACK_DURATION;
      }
      side._lastSkillCd[k] = cur;
    }
  }

  // Attack-thrust: ersätt höger arm-rotation med framåt-pose
  if (st.attackTimer > 0) {
    st.attackTimer -= dt;
    const total = st.attackTotal || ATTACK_DURATION;
    const t = Math.max(0, Math.min(1, 1 - st.attackTimer / total));
    const intensity = Math.sin(t * Math.PI);  // 0 → 1 → 0
    if (rig.rightArm) {
      const walkRot = swing * 0.55;
      rig.rightArm.rotation.x = -1.15 * intensity + walkRot * (1 - intensity);
    }
  }
}

function animateAllCharacters(dt) {
  if (APP.mode === 'lobby') return;
  // Hero-meshes (båda sidor om de finns)
  for (const sideIdx of [1, 2]) {
    const side = sides[sideIdx];
    if (!side || !side.mesh) continue;
    if (!side.mesh.visible) continue;
    animateCharacter(side.mesh, dt, side, 'hero');
  }
  // Solo: monster/creep-meshes ligger på side.monsters/playerCreeps direkt
  if (APP.mode === 'solo') {
    for (const sideIdx of [1, 2]) {
      const side = sides[sideIdx];
      if (!side) continue;
      for (const m of side.monsters) if (m.mesh) animateCharacter(m.mesh, dt, null, 'monster');
      for (const c of side.playerCreeps) if (c.mesh) animateCharacter(c.mesh, dt, null, 'minion');
    }
  }
  // MP: meshes från clientMeshes
  if (APP.mode === 'host' || APP.mode === 'client') {
    for (const key of ['monsters', 'playerCreeps']) {
      const tier = clientMeshes[key];
      if (!tier) continue;
      const type = key === 'monsters' ? 'monster' : 'minion';
      for (const map of tier.values()) {
        for (const mesh of map.values()) animateCharacter(mesh, dt, null, type);
      }
    }
  }
}

function applyRemoteState(state) {
  APP.lastStateRecv = state;
  // Hero pick-fas sync
  if (state.ph !== undefined) handleRemotePickState(state);
  // Duel-state
  const wasActive = duelState.active;
  duelState.active = !!state.dA;
  duelState.timer = state.dT || 0;
  duelState.matchTimer = state.dM || 0;
  duelState.count = state.dC || 0;
  duelState.lastWinner = state.dW || 0;
  duelState.announceTimer = state.dAn || 0;
  // Trigga "DUEL!"-bannern i 3s när active går från false → true
  if (duelState.active && !wasActive) {
    duelState.startBannerMs = performance.now() + 3000;
  }
  for (const idx of [1, 2]) {
    const sData = state.s[idx];
    if (!sData) continue;
    const side = sides[idx];
    if (!side) continue;
    // Hero pick info per side
    if (sData.hid !== undefined) side.heroId = sData.hid;
    if (sData.hpc !== undefined) side.heroPickConfirmed = !!sData.hpc;
    // Hjälte
    side.hero.x = sData.h.x;
    side.hero.z = sData.h.z;
    side.hero.hp = sData.h.hp;
    side.hero.maxHp = sData.h.mh;
    side.hero.facingX = sData.h.fx;
    side.hero.facingZ = sData.h.fz;
    side.hero.dead = !!sData.h.d;
    side.hero.respawnTimer = sData.h.rt;
    const heroRy = Math.atan2(sData.h.fx, sData.h.fz);
    if (!side.mesh._target) {
      side.mesh.position.x = sData.h.x;
      side.mesh.position.z = sData.h.z;
      side.mesh.rotation.y = heroRy;
    }
    side.mesh._target = { x: sData.h.x, z: sData.h.z, ry: heroRy };
    side.mesh.visible = !sData.h.d;
    // Resurser
    side.gold = sData.g;
    side.income = sData.inc ?? side.income;
    side.incomeTimer = sData.incT ?? side.incomeTimer;
    if (sData.incC !== undefined) side.incomeTickCount = sData.incC;
    if (sData.tu) side.tierUnlocks = sData.tu;
    if (sData.inv) side.inventory = sData.inv.map(e => ({
      itemId: e.id,
      variantId: e.vt || null,
      level: e.lv,
      activeRemaining: e.ar || 0,
      activeCd: e.ac || 0,
    }));
    side.moveSpeed = sData.ms;
    side.attackDmg = sData.ad;
    side.attackCounter = sData.ac;
    // Torn
    side.tower.hp = sData.tw.hp;
    side.tower.maxHp = sData.tw.mh;
    // Fontän-aura (för HUD-indikator)
    side.heroFountainAura = !!sData.fa;
    // AA + target-lock
    side.aaActive = !!sData.aa;
    side.targetId = sData.tg || 0;
    side.targetType = sData.tt || '';
    side.targetX = sData.tx || 0;
    side.targetZ = sData.tz || 0;
    // Level + XP
    side.level = sData.lv || 1;
    side.xp = sData.xp || 0;
    side.xpToNext = sData.xpN || 0;
    // Legolus buff-status
    side.legolusBuffRemaining = sData.lbuf || 0;
    side.legolusDashBuffPending = !!sData.ldash;
    // Gimlu buff-status
    side.titansTauntRemaining = sData.taunt || 0;
    side.ironWillRemaining = sData.iw || 0;
    side.ironWillStored = sData.iwS || 0;
    // Skills
    side.skills.q.cd = sData.sk.q;
    side.skills.f.cd = sData.sk.f;
    side.skills.e.cd = sData.sk.e;
    // Wave (för HUD)
    side.wave.current = sData.w.c;
    side.wave.active = !!sData.w.a;
    side.wave.betweenTimer = sData.w.bt;
    side.wave.name = sData.w.n || '';
    side.wave.isBoss = !!sData.w.b;
    side.wave.bannerPulse = sData.w.p || 0;
    // Entiteter
    clientReconcileEntities(idx, 'monsters', sData.M, (e) => {
      const m = makeMonsterMesh();
      if (e && e.boss) m.scale.set(1.6, 1.7, 1.6);
      if (e && e.r) {
        // Range-monster grön-tintat
        m.traverse(o => {
          if (o.material && o.material.color && o.isMesh) {
            o.material = o.material.clone();
            o.material.color.setHex(0x5a7a4a);
          }
        });
      }
      attachHpBar(m, (e && e.boss) ? 2.4 : 1.7);
      return m;
    });
    clientReconcileEntities(idx, 'playerCreeps', sData.C, (e) => {
      const m = makeMinionMesh(e.typeId || 'T1_bruiser', idx);
      attachHpBar(m, 1.7);
      return m;
    });
    clientReconcileEntities(idx, 'fireballs', sData.F, () => new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 14, 10),
      new THREE.MeshStandardMaterial({ color: 0xff5a18, emissive: 0xcc2200, emissiveIntensity: 1.0 })
    ));
    clientReconcileEntities(idx, 'projectiles', sData.P, (e) => new THREE.Mesh(
      new THREE.SphereGeometry(e.aoe ? 0.28 : 0.18, 12, 8),
      new THREE.MeshStandardMaterial({
        color: e.aoe ? 0xff66ff : 0xffdd55,
        emissive: e.aoe ? 0x882288 : 0x886611,
        emissiveIntensity: e.aoe ? 1.2 : 0.8,
      })
    ));
    clientReconcileEntities(idx, 'novaEffects', sData.N, () => {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.3, NOVA_RADIUS, 36),
        new THREE.MeshBasicMaterial({ color: 0x88ddff, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      return ring;
    });
    clientReconcileEntities(idx, 'creepProjectiles', sData.CP || [], (e) => {
      if (e.kind === 'magic') {
        return new THREE.Mesh(
          new THREE.SphereGeometry(0.15, 10, 8),
          new THREE.MeshStandardMaterial({ color: 0xaa44ff, emissive: 0xaa44ff, emissiveIntensity: 1.0 })
        );
      }
      return new THREE.Mesh(
        new THREE.ConeGeometry(0.045, 0.35, 6),
        new THREE.MeshStandardMaterial({ color: 0x6a4020, roughness: 0.7 })
      );
    });
    clientReconcileEntities(idx, 'heroCopies', sData.HC || [], (e) => {
      const m = makeHeroCopyMesh(e.owner || idx, e.heroId || 'magiker');
      attachHpBar(m, 2.0);
      return m;
    });
    clientReconcileEntities(idx, 'heroCopyFireballs', sData.HCF || [], () => new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 14, 10),
      new THREE.MeshStandardMaterial({ color: 0xff5a18, emissive: 0xff3010, emissiveIntensity: 1.4, transparent: true, opacity: 0.9 })
    ));
    // Fire Wave-cones från server
    clientReconcileEntities(idx, 'fireWaves', sData.FW || [], (e) => {
      const mat = new THREE.MeshBasicMaterial({ color: 0xff7a30, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
      const cone = new THREE.Mesh(new THREE.ConeGeometry(FIREWAVE_LENGTH * Math.tan(FIREWAVE_HALF_ANGLE), FIREWAVE_LENGTH, 16, 1, true), mat);
      cone.rotation.x = -Math.PI / 2;
      if (e && typeof e.dx === 'number') cone.rotation.z = Math.atan2(-e.dz, e.dx) + Math.PI / 2;
      return cone;
    });
    // Position FW vid hero.x + dir × len/2 — uppdatera varje frame via mesh.position
    const fwMap = clientMeshes.fireWaves && clientMeshes.fireWaves.get(idx);
    if (fwMap && sData.FW) for (const fw of sData.FW) {
      const m = fwMap.get(fw.id);
      if (m) {
        m.position.set(fw.x + fw.dx * (FIREWAVE_LENGTH / 2), 0.6, fw.z + fw.dz * (FIREWAVE_LENGTH / 2));
        if (m.material) m.material.opacity = 0.55 * fw.life;
      }
    }
    // Black Holes
    clientReconcileEntities(idx, 'blackHoles', sData.BH || [], () => {
      const grp = new THREE.Group();
      const sph = new THREE.Mesh(
        new THREE.SphereGeometry(0.8, 24, 16),
        new THREE.MeshStandardMaterial({ color: 0x080012, emissive: 0x442288, emissiveIntensity: 0.9, roughness: 0.3, transparent: true, opacity: 0.95 })
      );
      sph.position.y = 0.8;
      grp.add(sph);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(BLACKHOLE_RADIUS - 0.3, BLACKHOLE_RADIUS, 48),
        new THREE.MeshBasicMaterial({ color: 0x9966ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      grp.add(ring);
      grp.userData.bhSphere = sph;
      grp.userData.bhRing = ring;
      return grp;
    });
    // Vine Trap-zoner (Legolus Q)
    clientReconcileEntities(idx, 'vineTraps', sData.VT || [], () => {
      const grp = new THREE.Group();
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(VINE_TRAP_RADIUS * 0.85, VINE_TRAP_RADIUS, 36),
        new THREE.MeshBasicMaterial({ color: 0x4a8030, transparent: true, opacity: 0.65, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.07;
      grp.add(ring);
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2;
        const r = VINE_TRAP_RADIUS * 0.6;
        const sp = new THREE.Mesh(
          new THREE.ConeGeometry(0.08, 0.35, 6),
          new THREE.MeshStandardMaterial({ color: 0x3a5018, roughness: 0.85 })
        );
        sp.position.set(Math.cos(ang) * r, 0.17, Math.sin(ang) * r);
        grp.add(sp);
      }
      grp.userData.vtRing = ring;
      return grp;
    });
    const vtMap = clientMeshes.vineTraps && clientMeshes.vineTraps.get(idx);
    if (vtMap && sData.VT) for (const vt of sData.VT) {
      const m = vtMap.get(vt.id);
      if (m && m.userData.vtRing) m.userData.vtRing.material.opacity = 0.65 * vt.life;
    }
    // Gimlu Hammers
    clientReconcileEntities(idx, 'hammers', sData.HM || [], () => {
      const grp = new THREE.Group();
      const haft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.6, 8), new THREE.MeshStandardMaterial({ color: 0x3a2410, roughness: 0.85 }));
      haft.rotation.z = Math.PI / 2;
      grp.add(haft);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.22), new THREE.MeshStandardMaterial({ color: 0x808488, metalness: 0.55, roughness: 0.35 }));
      head.position.x = 0.3;
      grp.add(head);
      grp.position.y = 1.0;
      return grp;
    });
    const hmMap = clientMeshes.hammers && clientMeshes.hammers.get(idx);
    if (hmMap) for (const mesh of hmMap.values()) mesh.rotation.y += 0.2;
    // Iron Will Explosions
    clientReconcileEntities(idx, 'ironWillExplosions', sData.IWE || [], () => {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.5, IRON_WILL_EXPLOSION_RADIUS, 56),
        new THREE.MeshBasicMaterial({ color: 0xff7733, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.12;
      return ring;
    });
    const iweMap = clientMeshes.ironWillExplosions && clientMeshes.ironWillExplosions.get(idx);
    if (iweMap && sData.IWE) for (const ie of sData.IWE) {
      const m = iweMap.get(ie.id);
      if (m && m.material) m.material.opacity = 0.85 * ie.life;
    }
    // Shatter-ringar
    clientReconcileEntities(idx, 'shatters', sData.SH || [], () => {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.2, SHATTER_RADIUS, 32),
        new THREE.MeshBasicMaterial({ color: 0xbbe7ff, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.10;
      return ring;
    });
    const shMap = clientMeshes.shatters && clientMeshes.shatters.get(idx);
    if (shMap && sData.SH) for (const s of sData.SH) {
      const m = shMap.get(s.id);
      if (m && m.material) m.material.opacity = 0.8 * s.life;
    }
  }
  matchState.gameOver = !!state.m.o;
  matchState.gameWon = !!state.m.w;
  matchState.winner = state.m.win || 0;
}

// ============================================================
// SERIALISERA STATE (host)
// ============================================================

function serializeSide(side) {
  return {
    h: {
      x: side.hero.x, z: side.hero.z,
      hp: side.hero.hp, mh: side.hero.maxHp,
      fx: side.hero.facingX, fz: side.hero.facingZ,
      d: side.hero.dead, rt: side.hero.respawnTimer,
    },
    g: side.gold,
    inc: side.income,
    incT: +side.incomeTimer.toFixed(2),
    incC: side.incomeTickCount || 0,
    tu: side.tierUnlocks,
    inv: side.inventory.map(it => ({
      id: it.itemId,
      vt: it.variantId || null,
      lv: it.level,
      ar: +(it.activeRemaining || 0).toFixed(2),
      ac: +(it.activeCd || 0).toFixed(2),
    })),
    ms: side.moveSpeed,
    ad: side.attackDmg,
    ac: side.attackCounter,
    tw: { hp: side.tower.hp, mh: side.tower.maxHp },
    sk: { q: side.skills.q.cd, f: side.skills.f.cd, e: side.skills.e.cd },
    w: { c: side.wave.current, a: side.wave.active, bt: side.wave.betweenTimer },
    M: side.monsters.map(m => ({ id: m.id, x: m.mesh.position.x, z: m.mesh.position.z, ry: m.mesh.rotation.y })),
    C: side.playerCreeps.map(c => ({ id: c.id, typeId: c.typeId, x: c.mesh.position.x, z: c.mesh.position.z, ry: c.mesh.rotation.y })),
    F: side.fireballs.map((f, i) => ({ id: 'f' + side.idx + '_' + i, x: f.mesh.position.x, y: 1.0, z: f.mesh.position.z })),
    P: side.projectiles.map((p, i) => ({ id: 'p' + side.idx + '_' + i, x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z, aoe: p.isAoE })),
    N: side.novaEffects.map((n, i) => ({ id: 'n' + side.idx + '_' + i, x: n.mesh.position.x, z: n.mesh.position.z, life: n.life / n.maxLife })),
    CP: side.creepProjectiles.map(p => ({ id: p.id, x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z, kind: p.kind })),
  };
}

function serializeState() {
  return {
    t: 'st',
    m: { o: matchState.gameOver, w: matchState.gameWon, win: matchState.winner },
    s: {
      1: serializeSide(sides[1]),
      2: sides[2] ? serializeSide(sides[2]) : null,
    },
  };
}

// ============================================================
// MATCH-STATE
// ============================================================

const matchState = { gameOver: false, gameWon: false, winner: 0 };

function checkMatchEnd() {
  if (matchState.gameOver) return;
  if (sides[1] && sides[1].tower.hp <= 0) {
    matchState.gameOver = true;
    matchState.winner = 2;
  } else if (sides[2] && sides[2].tower.hp <= 0) {
    matchState.gameOver = true;
    matchState.winner = 1;
  }
  // I singleplayer räknas hens torn-fall som vinst
  if (matchState.gameOver) matchState.gameWon = matchState.winner === APP.localSide;
}

// ============================================================
// KAMERA
// ============================================================

const cameraOffset = new THREE.Vector3(0, 12, 9.3);
const cameraTarget = new THREE.Vector3();

function updateCamera(dt) {
  if (!sides[APP.localSide]) return;
  const hero = sides[APP.localSide].hero;
  // Klient (sida 2) = kamera spegelvänd
  const sign = (APP.localSide === 2) ? -1 : 1;
  const desiredX = hero.x + cameraOffset.x * sign;
  const desiredY = cameraOffset.y;
  const desiredZ = hero.z + cameraOffset.z * sign;
  // ~50 ms halflife — kameran följer responsivt men utan ryck
  const lerpK = 1 - Math.pow(0.5, dt / 0.05);
  camera.position.x += (desiredX - camera.position.x) * lerpK;
  camera.position.y += (desiredY - camera.position.y) * lerpK;
  camera.position.z += (desiredZ - camera.position.z) * lerpK;
  cameraTarget.x += (hero.x - cameraTarget.x) * lerpK;
  cameraTarget.y += (0.8 - cameraTarget.y) * lerpK;
  cameraTarget.z += (hero.z - cameraTarget.z) * lerpK;
  camera.lookAt(cameraTarget);
}

// ============================================================
// HUD
// ============================================================

const hudEl = document.getElementById('hud');
const statusEl = document.getElementById('status');
const endgameEl = document.getElementById('endgame');
const endgameTitle = document.getElementById('endgame-title');
const endgameInfo = document.getElementById('endgame-info');
document.getElementById('restart-btn').addEventListener('click', () => location.reload());

function fmtCd(s) { return s <= 0 ? 'redo' : s.toFixed(1) + 's'; }

function updateHud() {
  const side = sides[APP.localSide];
  if (!side) return;
  if (matchState.gameOver) {
    endgameEl.classList.add('visible');
    const won = matchState.winner === APP.localSide;
    endgameEl.classList.toggle('win', won);
    endgameEl.classList.toggle('lose', !won);
    endgameTitle.textContent = won ? 'VINST!' : 'FÖRLUST';
    endgameInfo.textContent = won
      ? `Du krossade motståndarens torn på wave ${side.wave.current}.`
      : `Ditt torn föll på wave ${side.wave.current}.`;
    return;
  }
  const opp = sides[3 - APP.localSide];
  const heroLine = side.hero.dead
    ? `<span style="color:#ff6666">DÖD — respawn om ${side.hero.respawnTimer.toFixed(1)}s</span>`
    : `HP: ${Math.round(side.hero.hp)}/${Math.round(side.hero.maxHp)}`;
  const top = [
    heroLine,
    `Guld: ${side.gold}`,
    `<span style="color:#88aaff">Du: ${side.tower.hp}/${side.tower.maxHp}</span>`,
    `<span style="color:#ff8888">Motst: ${opp ? opp.tower.hp + '/' + opp.tower.maxHp : '–'}</span>`,
  ];
  if (side.wave.active) top.push(`Wave ${side.wave.current}`);
  else top.push(`Wave ${side.wave.current + 1} om: ${side.wave.betweenTimer.toFixed(1)}s`);
  const nextAoe = PASSIVE_EVERY - (side.attackCounter % PASSIVE_EVERY);
  const bottom = [
    `Q: ${fmtCd(side.skills.q.cd)}`,
    `F: ${fmtCd(side.skills.f.cd)}`,
    `E: ${fmtCd(side.skills.e.cd)}`,
    `AoE: ${nextAoe}`,
  ];
  if (APP.mode === 'host') bottom.push('HOST');
  else if (APP.mode === 'client') bottom.push('CLIENT');
  statusEl.innerHTML = top.join(' | ') + '<br>' + bottom.join(' | ');
  updateLevelUI(side);
}

const duelInfoEl = document.getElementById('duel-info');
const duelInfoTimerEl = document.getElementById('duel-info-timer');
const duelBannerEl = document.getElementById('duel-banner');
const duelBannerTitleEl = document.getElementById('duel-banner-title');
const duelBannerSubEl = document.getElementById('duel-banner-sub');

function fmtMs(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

function updateDuelHud() {
  if (!duelInfoEl || !duelBannerEl) return;
  if (APP.mode === 'lobby') {
    duelInfoEl.classList.add('hidden');
    duelBannerEl.classList.add('hidden');
    return;
  }
  // Solo: duel triggas inte men timern kör ändå (atmosfärisk countdown)
  if (APP.mode === 'solo') {
    duelBannerEl.classList.add('hidden');
    if (duelState.timer > 0) {
      duelInfoEl.classList.remove('hidden');
      duelInfoTimerEl.textContent = fmtMs(duelState.timer);
      duelInfoEl.classList.toggle('urgent', duelState.timer <= 10);
    } else {
      duelInfoEl.classList.add('hidden');
    }
    return;
  }
  // När duel just startat: visa banner i 3s, sen göm under själva fighten.
  if (duelState.active && duelState.startBannerMs > performance.now()) {
    duelInfoEl.classList.add('hidden');
    duelBannerEl.classList.remove('hidden');
    duelBannerTitleEl.textContent = `DUEL ${duelState.count + 1}`;
    duelBannerSubEl.textContent = 'Sista mannen kvar vinner';
  } else if (duelState.active) {
    // Pågående duel: göm banner + info så skärmen är fri
    duelInfoEl.classList.add('hidden');
    duelBannerEl.classList.add('hidden');
  } else if (duelState.announceTimer > 0) {
    duelInfoEl.classList.add('hidden');
    duelBannerEl.classList.remove('hidden');
    if (duelState.lastWinner === 0) {
      duelBannerTitleEl.textContent = 'DUELN OAVGJORD';
      duelBannerSubEl.textContent = '';
    } else if (duelState.lastWinner === APP.localSide) {
      duelBannerTitleEl.textContent = 'DU VANN DUELN!';
      const rewards = [500, 1500, 5000, 10000];
      const r = rewards[Math.min(duelState.count - 1, 3)] || 0;
      duelBannerSubEl.textContent = `+${r} guld · +1 level`;
    } else {
      duelBannerTitleEl.textContent = 'DU FÖRLORADE DUELN';
      duelBannerSubEl.textContent = 'Bättre lycka nästa gång';
    }
  } else if (duelState.count < 4 && duelState.timer > 0) {
    duelBannerEl.classList.add('hidden');
    duelInfoEl.classList.remove('hidden');
    duelInfoTimerEl.textContent = fmtMs(duelState.timer);
    duelInfoEl.classList.toggle('urgent', duelState.timer <= 10);
  } else {
    duelInfoEl.classList.add('hidden');
    duelBannerEl.classList.add('hidden');
  }
}

// Wave-banner: visa stor notis när ny wave startar (server signalerar via bannerPulse)
const waveBannerEl = document.getElementById('wave-banner');
const waveBannerTitleEl = document.getElementById('wave-banner-title');
const waveBannerSubEl = document.getElementById('wave-banner-sub');
const waveBannerState = { lastSeenPulse: 0, hideTimeout: null };

function showWaveBanner(waveNum, name, isBoss) {
  if (!waveBannerEl) return;
  if (isBoss) {
    waveBannerEl.classList.add('boss');
    waveBannerTitleEl.textContent = `BOSS — WAVE ${waveNum}`;
    waveBannerSubEl.textContent = name || '???';
  } else {
    waveBannerEl.classList.remove('boss');
    waveBannerTitleEl.textContent = `WAVE ${waveNum}`;
    waveBannerSubEl.textContent = name || '';
  }
  // Restart animation
  waveBannerEl.classList.remove('hidden');
  waveBannerEl.style.animation = 'none';
  // eslint-disable-next-line no-unused-expressions
  void waveBannerEl.offsetWidth;
  waveBannerEl.style.animation = '';
  if (waveBannerState.hideTimeout) clearTimeout(waveBannerState.hideTimeout);
  waveBannerState.hideTimeout = setTimeout(() => {
    waveBannerEl.classList.add('hidden');
  }, 2600);
}

function checkWaveBanner() {
  if (APP.mode === 'lobby') return;
  const side = sides[APP.localSide];
  if (!side || !side.wave) return;
  const pulse = side.wave.bannerPulse || 0;
  if (pulse > waveBannerState.lastSeenPulse) {
    waveBannerState.lastSeenPulse = pulse;
    showWaveBanner(side.wave.current, side.wave.name, side.wave.isBoss);
  }
}

const levelBadgeEl = document.getElementById('level-badge');
const xpFillEl = document.getElementById('xp-fill');
const xpTextEl = document.getElementById('xp-text');
function updateLevelUI(side) {
  if (!levelBadgeEl) return;
  const lv = side.level || 1;
  levelBadgeEl.textContent = 'Lv ' + lv;
  if (lv >= MAX_LEVEL) {
    xpFillEl.style.width = '100%';
    xpTextEl.textContent = 'MAX';
  } else {
    const pct = side.xpToNext > 0 ? Math.min(100, (side.xp / side.xpToNext) * 100) : 0;
    xpFillEl.style.width = pct.toFixed(1) + '%';
    xpTextEl.textContent = `${side.xp} / ${side.xpToNext}`;
  }
}

// ============================================================
// SIKT-INDIKATORER
// ============================================================

const aimLine = new THREE.Mesh(
  new THREE.PlaneGeometry(ELDKLOT_RANGE, 0.45),
  new THREE.MeshBasicMaterial({ color: 0xff7733, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
);
aimLine.rotation.x = -Math.PI / 2;
aimLine.visible = false;
scene.add(aimLine);

const aimDot = new THREE.Mesh(
  new THREE.CircleGeometry(0.9, 24),
  new THREE.MeshBasicMaterial({ color: 0xaa88ff, transparent: true, opacity: 0.65, side: THREE.DoubleSide })
);
aimDot.rotation.x = -Math.PI / 2;
aimDot.visible = false;
scene.add(aimDot);

// Generic AoE-aim-ring (skalas + tintas per skill)
const aimCircle = new THREE.Mesh(
  new THREE.RingGeometry(0.85, 1.0, 48),
  new THREE.MeshBasicMaterial({ color: 0x88ddff, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
);
aimCircle.rotation.x = -Math.PI / 2;
aimCircle.visible = false;
scene.add(aimCircle);

// Target-ring under låst fiende — pulserar lätt
const targetRing = new THREE.Mesh(
  new THREE.RingGeometry(0.55, 0.7, 32),
  new THREE.MeshBasicMaterial({ color: 0xff5533, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
);
targetRing.rotation.x = -Math.PI / 2;
targetRing.visible = false;
scene.add(targetRing);

function updateTargetIndicator() {
  const side = sides[APP.localSide];
  if (!side || !side.aaActive || !side.targetId) {
    targetRing.visible = false;
    return;
  }
  // Försök hämta target's mesh-position (solo) eller server-skickad targetX/Z (MP)
  let tx = side.targetX, tz = side.targetZ;
  if (APP.mode === 'solo') {
    const opp = sides[3 - side.idx];
    const t = resolveTargetEntity(side, opp);
    if (t && t.mesh) { tx = t.mesh.position.x; tz = t.mesh.position.z; }
  }
  if (!tx && !tz) { targetRing.visible = false; return; }
  targetRing.position.set(tx, 0.06, tz);
  const t = performance.now() / 1000;
  const s = 1.0 + 0.08 * Math.sin(t * 5);
  targetRing.scale.set(s, s, 1);
  targetRing.visible = true;
}

function updateAimIndicators() {
  const side = sides[APP.localSide];
  aimLine.visible = false;
  aimDot.visible = false;
  aimCircle.visible = false;
  if (!side || !aimState.key || !aimState.active) return;

  const w = screenToWorld(aimState.dx, aimState.dz);
  const dragging = aimState.dragMag > AIM_THRESHOLD;

  // Returnerar cast-position för en target-baserad skill given drag-distance.
  // Drag: hero + drag-dir × dist. Tap-on-target: target's position. Annars: hero + facing × dist.
  function castGround(dist) {
    if (dragging) return { x: side.hero.x + w.x * dist, z: side.hero.z + w.z * dist };
    if (side.targetId && side.targetType) {
      if (APP.mode === 'solo') {
        const opp = sides[3 - side.idx];
        const t = resolveTargetEntity(side, opp);
        if (t && t.mesh) return { x: t.mesh.position.x, z: t.mesh.position.z };
      } else if (side.targetX || side.targetZ) {
        return { x: side.targetX, z: side.targetZ };
      }
    }
    return { x: side.hero.x + side.hero.facingX * dist, z: side.hero.z + side.hero.facingZ * dist };
  }
  function showCircle(x, z, radius, color) {
    aimCircle.visible = true;
    aimCircle.position.set(x, 0.06, z);
    aimCircle.scale.set(radius, radius, 1);
    aimCircle.material.color.setHex(color);
  }
  function showLine(dirX, dirZ, length) {
    aimLine.visible = true;
    aimLine.position.set(side.hero.x + dirX * (length / 2), 0.06, side.hero.z + dirZ * (length / 2));
    aimLine.rotation.y = -Math.atan2(dirZ, dirX);
  }

  const heroId = side.heroId || 'magiker';
  const dirX = dragging ? w.x : side.hero.facingX;
  const dirZ = dragging ? w.z : side.hero.facingZ;

  if (aimState.key === 'q') {
    if (heroId === 'legolas') {
      const p = castGround(VINE_TRAP_CAST_DISTANCE);
      showCircle(p.x, p.z, VINE_TRAP_RADIUS, 0x4a8030);
    } else if (heroId === 'gimlu') {
      showCircle(side.hero.x, side.hero.z, TAUNT_RADIUS, 0xffaa55);
    } else {
      showLine(dirX, dirZ, ELDKLOT_RANGE);
    }
  } else if (aimState.key === 'f') {
    if (heroId === 'legolas') {
      // Self-buff — visa ring runt hero
      showCircle(side.hero.x, side.hero.z, 1.2, 0xddff55);
    } else if (heroId === 'gimlu') {
      // Iron Will — visa explosionsradien runt hero
      showCircle(side.hero.x, side.hero.z, IRON_WILL_EXPLOSION_RADIUS, 0xff7733);
    } else {
      // Gandulf Frost Nova — cirkel där novan kastas
      const p = castGround(NOVA_CAST_DISTANCE);
      showCircle(p.x, p.z, NOVA_RADIUS, 0x88ddff);
    }
  } else if (aimState.key === 'e') {
    if (heroId === 'legolas') {
      // Dash — liten dot på destinationen
      const p = castGround(LEGOLUS_DASH_DISTANCE);
      showCircle(p.x, p.z, 0.6, 0xddc680);
    } else if (heroId === 'gimlu') {
      // Hammer — line längs banan
      showLine(dirX, dirZ, HAMMER_RANGE);
    } else {
      // Gandulf Black Hole — cirkel med blackhole-radien
      const p = castGround(BLACKHOLE_CAST_DISTANCE);
      showCircle(p.x, p.z, BLACKHOLE_RADIUS, 0x9966ff);
    }
  }
}

// ============================================================
// INPUTS (joystick, knappar, shop)
// ============================================================

const joyEl = document.getElementById('joy');
const joyKnobEl = document.getElementById('joy-knob');
const aaBtnEl = document.getElementById('aa-btn');
const skillEls = {
  q: document.getElementById('skill-q'),
  f: document.getElementById('skill-f'),
  e: document.getElementById('skill-e'),
};

function triggerAA() {
  if (APP.mode === 'lobby') return;
  const side = sides[APP.localSide];
  if (!side || side.hero.dead) return;
  sendOrApplyEvent({ type: 'aa' });
}

const joyState = {
  touchId: null, cx: 0, cy: 0, dx: 0, dz: 0, radius: 70,
};
const aimState = {
  touchId: null, key: null, active: false,
  btnCx: 0, btnCy: 0, dx: 0, dz: 0, dragMag: 0,
};
const AIM_THRESHOLD = 16;
const SKILL_AIMABLE = { q: true, e: true, f: true };

const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (APP.mode === 'lobby') return;
  const side = sides[APP.localSide];
  if (!side) return;
  if (e.code === 'KeyQ') castLocalSkill('q', side.hero.facingX, side.hero.facingZ, true);
  if (e.code === 'KeyE') castLocalSkill('e', side.hero.facingX, side.hero.facingZ, true);
  if (e.code === 'KeyR' || e.code === 'KeyF') castLocalSkill('f', 0, 0, true);
  if (e.code === 'Space' || e.code === 'KeyA') { e.preventDefault?.(); triggerAA(); }
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

function rectOf(el) { return el.getBoundingClientRect(); }

function startJoystick(touch) {
  const r = rectOf(joyEl);
  joyState.touchId = touch.identifier;
  joyState.cx = r.left + r.width / 2;
  joyState.cy = r.top + r.height / 2;
  joyState.radius = r.width / 2;
  moveJoystick(touch);
}
function moveJoystick(touch) {
  const dx = touch.clientX - joyState.cx;
  const dy = touch.clientY - joyState.cy;
  const mag = Math.hypot(dx, dy);
  const clamped = Math.min(mag, joyState.radius);
  const ndx = mag > 0 ? dx / mag : 0;
  const ndy = mag > 0 ? dy / mag : 0;
  joyKnobEl.style.transform = `translate(${ndx * clamped}px, ${ndy * clamped}px)`;
  const strength = clamped / joyState.radius;
  joyState.dx = ndx * strength;
  joyState.dz = ndy * strength;
}
function endJoystick() {
  joyState.touchId = null;
  joyState.dx = 0; joyState.dz = 0;
  joyKnobEl.style.transform = 'translate(0px, 0px)';
}

function skillKeyFromTarget(target) {
  let el = target;
  while (el && el !== document.body) {
    if (el.dataset && el.dataset.key) return el.dataset.key;
    el = el.parentElement;
  }
  return null;
}

function startSkillTouch(touch, key) {
  const side = sides[APP.localSide];
  if (!side || side.skills[key].cd > 0) return;
  const r = rectOf(skillEls[key]);
  aimState.touchId = touch.identifier;
  aimState.key = key;
  aimState.active = SKILL_AIMABLE[key];
  aimState.btnCx = r.left + r.width / 2;
  aimState.btnCy = r.top + r.height / 2;
  aimState.dx = side.hero.facingX;
  aimState.dz = side.hero.facingZ;
  aimState.dragMag = 0;
  skillEls[key].classList.add('active');
}
function moveSkillTouch(touch) {
  if (!aimState.key) return;
  const dx = touch.clientX - aimState.btnCx;
  const dy = touch.clientY - aimState.btnCy;
  const mag = Math.hypot(dx, dy);
  aimState.dragMag = mag;
  if (mag > AIM_THRESHOLD && aimState.active) {
    aimState.dx = dx / mag;
    aimState.dz = dy / mag;
  }
}
function endSkillTouch(touch, cancelled) {
  const key = aimState.key;
  if (!key) return;
  skillEls[key].classList.remove('active');
  const side = sides[APP.localSide];
  if (!cancelled && side) {
    let dx, dz;
    const isDrag = SKILL_AIMABLE[key] && aimState.dragMag > AIM_THRESHOLD;
    if (isDrag) {
      const w = screenToWorld(aimState.dx, aimState.dz);
      dx = w.x; dz = w.z;
    } else {
      dx = side.hero.facingX; dz = side.hero.facingZ;
    }
    // tap=true om INTE drag — låter applyEvent leta upp target-aim
    castLocalSkill(key, dx, dz, !isDrag);
  }
  aimState.touchId = null;
  aimState.key = null;
  aimState.active = false;
}

function onTouchStart(e) {
  for (const touch of e.changedTouches) {
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    if (!target) continue;
    if (joyState.touchId === null && (target === joyEl || target === joyKnobEl || joyEl.contains(target))) {
      e.preventDefault();
      startJoystick(touch);
      continue;
    }
    if (target === aaBtnEl || (aaBtnEl && aaBtnEl.contains(target))) {
      e.preventDefault();
      triggerAA();
      continue;
    }
    const key = skillKeyFromTarget(target);
    if (key && aimState.touchId === null) {
      e.preventDefault();
      startSkillTouch(touch, key);
      continue;
    }
  }
}
function onTouchMove(e) {
  for (const touch of e.changedTouches) {
    if (touch.identifier === joyState.touchId) { e.preventDefault(); moveJoystick(touch); }
    else if (touch.identifier === aimState.touchId) { e.preventDefault(); moveSkillTouch(touch); }
  }
}
function onTouchEnd(e) {
  for (const touch of e.changedTouches) {
    if (touch.identifier === joyState.touchId) { e.preventDefault(); endJoystick(); }
    else if (touch.identifier === aimState.touchId) { e.preventDefault(); endSkillTouch(touch, e.type === 'touchcancel'); }
  }
}
window.addEventListener('touchstart', onTouchStart, { passive: false });
window.addEventListener('touchmove', onTouchMove, { passive: false });
window.addEventListener('touchend', onTouchEnd, { passive: false });
window.addEventListener('touchcancel', onTouchEnd, { passive: false });

// Desktop: mouse click på AA-knappen
if (aaBtnEl) {
  aaBtnEl.addEventListener('click', (e) => { e.preventDefault(); triggerAA(); });
}

// ---- Shop (lokal UI-state + populate + refresh) ----

const shopContainerEl = document.getElementById('shop-container');
const shopHeroEl = document.getElementById('shop-hero');
const shopMinionEl = document.getElementById('shop-minion');
const shopState = { selectedTier: 1, selectedLane: 1, variantPickerOpenFor: null };

// Rollup-knapparna: klick på header togglar expanded på sin panel.
// Klick på själva body/innehåll bubblar inte upp (header är syskon till body),
// så köp/tier-klick stänger inte panelen.
document.querySelectorAll('.shop-header').forEach((h) => {
  h.addEventListener('click', () => {
    const panel = h.closest('.shop-panel');
    if (panel) panel.classList.toggle('expanded');
  });
});

function collapseShopPanels() {
  if (shopHeroEl) shopHeroEl.classList.remove('expanded');
  if (shopMinionEl) shopMinionEl.classList.remove('expanded');
  shopState.variantPickerOpenFor = null;
}
const shopRefs = { heroBtns: [], laneBtns: [], tierBtns: [], minionBtns: [] };

function getNextLockedTier(side) {
  for (let t = 2; t <= 5; t++) if (!side.tierUnlocks[t]) return t;
  return null;
}

function populateShop() {
  // ITEMS (6 st). Items med varianter får en inline variant-picker.
  const heroRow = document.getElementById('shop-hero-row');
  heroRow.innerHTML = '';
  shopRefs.heroBtns = [];
  shopRefs.heroCells = [];
  shopRefs.heroVariantBtns = [];
  for (const itemId of ITEM_ORDER) {
    const def = ITEM_TYPES[itemId];
    const cell = document.createElement('div');
    cell.className = 'item-cell';
    cell.dataset.item = itemId;

    const primary = document.createElement('button');
    primary.className = 'shop-btn item-btn primary';
    primary.dataset.item = itemId;
    primary.addEventListener('click', () => onItemPrimaryClick(itemId));
    cell.appendChild(primary);

    if (def.variants) {
      const picker = document.createElement('div');
      picker.className = 'variant-picker';
      for (const [vid] of Object.entries(def.variants)) {
        const vb = document.createElement('button');
        vb.className = 'shop-btn item-btn variant';
        vb.dataset.item = itemId;
        vb.dataset.variant = vid;
        vb.addEventListener('click', () => onVariantClick(itemId, vid));
        picker.appendChild(vb);
        shopRefs.heroVariantBtns.push(vb);
      }
      const cancel = document.createElement('button');
      cancel.className = 'shop-btn item-btn variant-cancel';
      cancel.textContent = '×';
      cancel.addEventListener('click', closeVariantPicker);
      picker.appendChild(cancel);
      cell.appendChild(picker);
    }

    heroRow.appendChild(cell);
    shopRefs.heroBtns.push(primary);
    shopRefs.heroCells.push(cell);
  }

  // Lane-toggle
  const laneRow = document.getElementById('shop-lane-row');
  laneRow.innerHTML = '';
  shopRefs.laneBtns = [];
  for (const lane of [1, 2]) {
    const btn = document.createElement('button');
    btn.className = 'lane-btn' + (shopState.selectedLane === lane ? ' active' : '');
    btn.dataset.lane = String(lane);
    btn.textContent = lane === 1 ? '▲ Övre' : '▼ Nedre';
    btn.addEventListener('click', () => { shopState.selectedLane = lane; refreshShopUI(); });
    laneRow.appendChild(btn);
    shopRefs.laneBtns.push(btn);
  }

  // Tier-tabs
  const tierRow = document.getElementById('shop-tier-row');
  tierRow.innerHTML = '';
  shopRefs.tierBtns = [];
  for (const tier of [1, 2, 3, 4, 5]) {
    const btn = document.createElement('button');
    btn.className = 'tier-btn';
    btn.dataset.tier = String(tier);
    btn.addEventListener('click', () => onTierClick(tier));
    tierRow.appendChild(btn);
    shopRefs.tierBtns.push(btn);
  }

  // Minion-grid (6 slots, label byts vid tier-byte)
  const grid = document.getElementById('shop-minion-grid');
  grid.innerHTML = '';
  shopRefs.minionBtns = [];
  for (let i = 0; i < ARCHETYPE_ORDER.length; i++) {
    const btn = document.createElement('button');
    btn.className = 'shop-btn minion-btn minion-' + ARCHETYPE_ORDER[i];
    btn.dataset.slot = String(i);
    btn.addEventListener('click', () => onMinionClick(i));
    grid.appendChild(btn);
    shopRefs.minionBtns.push(btn);
  }
}

function onItemPrimaryClick(itemId) {
  const side = sides[APP.localSide];
  if (!side) return;
  const def = ITEM_TYPES[itemId];
  if (!def) return;
  const existing = side.inventory.find(it => it.itemId === itemId);
  if (!existing && def.variants) {
    // Öppna variant-picker
    shopState.variantPickerOpenFor = itemId;
    refreshShopUI();
    return;
  }
  // Ej variant-item, eller redan ägt → buy/upgrade direkt
  sendOrApplyEvent({ type: 'shop', kind: 'item', item: itemId });
}

function onVariantClick(itemId, variantId) {
  sendOrApplyEvent({ type: 'shop', kind: 'item', item: itemId, variant: variantId });
  shopState.variantPickerOpenFor = null;
  refreshShopUI();
}

function closeVariantPicker() {
  shopState.variantPickerOpenFor = null;
  refreshShopUI();
}

function onTierClick(tier) {
  const side = sides[APP.localSide];
  if (!side) return;
  if (side.tierUnlocks[tier]) {
    shopState.selectedTier = tier;
    refreshShopUI();
    return;
  }
  // Locked tier — försök låsa upp om det är nästa i tur och har råd
  const next = getNextLockedTier(side);
  if (tier === next && side.gold >= TIER_UNLOCK_COST[tier]) {
    sendOrApplyEvent({ type: 'shop', kind: 'unlock', tier });
  }
}

function onMinionClick(slot) {
  const side = sides[APP.localSide];
  if (!side) return;
  const tier = shopState.selectedTier;
  if (!side.tierUnlocks[tier]) return;
  const arch = ARCHETYPE_ORDER[slot];
  const typeId = `T${tier}_${arch}`;
  sendOrApplyEvent({ type: 'shop', kind: 'minion', minionType: typeId, lane: shopState.selectedLane });
}

function refreshShopUI() {
  const side = sides[APP.localSide];
  if (!side) return;
  const inBase = !side.hero.dead && inSideBase(side.idx, side.hero.x, side.hero.z);

  // Auto-byt till lägsta upplåsta tier om vald är låst
  if (!side.tierUnlocks[shopState.selectedTier]) {
    for (let t = 5; t >= 1; t--) if (side.tierUnlocks[t]) { shopState.selectedTier = t; break; }
  }

  // Item-knappar + variant-picker + cells
  const invFull = side.inventory.length >= INVENTORY_SLOTS;
  for (const cell of shopRefs.heroCells) {
    const itemId = cell.dataset.item;
    const def = ITEM_TYPES[itemId];
    if (!def) continue;
    const existing = side.inventory.find(it => it.itemId === itemId);
    const subDef = existing ? itemDefForEntry(existing) : null;
    const pickerOpen = !existing && shopState.variantPickerOpenFor === itemId;
    cell.classList.toggle('picker-open', pickerOpen);

    const primary = cell.querySelector('.primary');
    primary.classList.remove('owned', 'maxlvl');
    if (!existing) {
      // Visa generisk knapp; klick öppnar picker (om varianter), annars köper direkt
      primary.innerHTML = `${def.icon} ${def.name}<small>${invFull ? 'Inventory full' : (def.variants ? 'Välj — köp ' + ITEM_BUY_COST + 'g' : 'Köp ' + ITEM_BUY_COST + 'g')}</small>`;
      primary.disabled = side.hero.dead || invFull || side.gold < ITEM_BUY_COST;
    } else if (existing.level >= ITEM_MAX_LEVEL) {
      primary.classList.add('owned', 'maxlvl');
      const name = subDef ? subDef.name : def.name;
      const icon = subDef ? subDef.icon : def.icon;
      primary.innerHTML = `${icon} ${name}<small>MAX (lvl ${existing.level})</small>`;
      primary.disabled = true;
    } else {
      primary.classList.add('owned');
      const cost = itemUpgradeCost(existing.level);
      const name = subDef ? subDef.name : def.name;
      const icon = subDef ? subDef.icon : def.icon;
      primary.innerHTML = `${icon} ${name}<small>Lvl ${existing.level} → ${existing.level+1} · ${cost}g</small>`;
      primary.disabled = side.hero.dead || side.gold < cost;
    }
  }
  // Variant-knapparna (samma data hela tiden, men disable beror på gold/full)
  for (const vb of shopRefs.heroVariantBtns) {
    const itemId = vb.dataset.item;
    const variantId = vb.dataset.variant;
    const def = ITEM_TYPES[itemId];
    const vdef = def && def.variants && def.variants[variantId];
    if (!vdef) continue;
    vb.innerHTML = `${vdef.icon} ${vdef.name}<small>${ITEM_BUY_COST}g</small>`;
    vb.disabled = side.hero.dead || invFull || side.gold < ITEM_BUY_COST;
  }

  // Lane-knappar
  for (const btn of shopRefs.laneBtns) {
    btn.classList.toggle('active', +btn.dataset.lane === shopState.selectedLane);
  }

  // Tier-tabs
  const next = getNextLockedTier(side);
  for (const btn of shopRefs.tierBtns) {
    const tier = +btn.dataset.tier;
    const unlocked = !!side.tierUnlocks[tier];
    const isActive = tier === shopState.selectedTier;
    const isNext = tier === next;
    btn.classList.toggle('active', unlocked && isActive);
    btn.classList.toggle('locked', !unlocked);
    const cost = TIER_UNLOCK_COST[tier];
    const canUnlock = !unlocked && isNext && side.gold >= cost;
    btn.classList.toggle('can-unlock', canUnlock);
    if (unlocked) {
      btn.innerHTML = `Tier ${tier}`;
      btn.disabled = false;
    } else if (isNext) {
      btn.innerHTML = `Tier ${tier}<small>Lås upp ${cost}g</small>`;
      btn.disabled = !canUnlock || side.hero.dead;
    } else {
      btn.innerHTML = `Tier ${tier}<small>Låst</small>`;
      btn.disabled = true;
    }
  }

  // Minion-knappar (6 för vald tier)
  for (const btn of shopRefs.minionBtns) {
    const slot = +btn.dataset.slot;
    const arch = ARCHETYPE_ORDER[slot];
    const typeId = `T${shopState.selectedTier}_${arch}`;
    const def = MINION_TYPES[typeId];
    btn.innerHTML = `${ARCHETYPE_NAMES[arch]} (${def.cost}g)<small>HP ${def.hp} · DMG ${def.damage}${def.attackType === 'arrow' ? ' · pil' : def.attackType === 'magic' ? ' · AoE' : ''}</small>`;
    const unlocked = !!side.tierUnlocks[shopState.selectedTier];
    btn.disabled = !unlocked || side.gold < def.cost || side.hero.dead;
  }

  if (shopContainerEl) shopContainerEl.classList.toggle('visible', inBase);
  if (!inBase) collapseShopPanels();
}

populateShop();

function updateShop() { refreshShopUI(); }

// ============================================================
// INVENTORY (4 slots längst ner i mitten) + tooltip
// ============================================================

const inventorySlotEls = Array.from(document.querySelectorAll('.inventory-slot'));
const tooltipEl = document.getElementById('item-tooltip');
const tooltipNameEl = tooltipEl ? tooltipEl.querySelector('.tt-name') : null;
const tooltipLevelEl = tooltipEl ? tooltipEl.querySelector('.tt-level') : null;
const tooltipStatsEl = tooltipEl ? tooltipEl.querySelector('.tt-stats') : null;
const tooltipCostEl = tooltipEl ? tooltipEl.querySelector('.tt-cost') : null;
const tooltipActiveEl = tooltipEl ? tooltipEl.querySelector('.tt-active') : null;
const tooltipActiveDescEl = tooltipActiveEl ? tooltipActiveEl.querySelector('.desc') : null;
const tooltipActiveStatusEl = tooltipActiveEl ? tooltipActiveEl.querySelector('.status') : null;

const STAT_LABELS = {
  attackDmg: 'skada',
  moveSpeed: 'rörelsehastighet',
  maxHp: 'max HP',
  attackSpeedPct: 'attackfart',
  moveSpeedPct: 'rörelsehastighet',
  skillDmgPct: 'skill-skada',
  cdrPct: 'cooldown reduction',
  dmgReductionPct: 'skadereduktion',
  maxHpPct: 'max HP',
  critChancePct: 'crit chans',
  healPerSecPct: 'HP regen/s',
};

function formatStat(key, val) {
  if (!val) return '';
  if (key.endsWith('Pct')) {
    const pct = Math.round(val * 1000) / 10;  // 1 decimal
    const sign = val > 0 ? '+' : '';
    return `${sign}${pct}% ${STAT_LABELS[key] || key}`;
  }
  const sign = val > 0 ? '+' : '';
  return `${sign}${val} ${STAT_LABELS[key] || key}`;
}

function showItemTooltipForSlot(slotEl) {
  if (!tooltipEl) return;
  const side = sides[APP.localSide];
  if (!side) return;
  const slotIdx = +slotEl.dataset.slot;
  const entry = side.inventory[slotIdx];
  if (!entry) return;
  const def = itemDefForEntry(entry);
  if (!def) return;
  const level = entry.level;
  // Namn + level
  tooltipNameEl.textContent = def.name;
  tooltipLevelEl.textContent = `Level ${level} / ${ITEM_MAX_LEVEL}`;
  // Stats
  const stats = def.statsAtLevel ? (def.statsAtLevel(level) || {}) : {};
  tooltipStatsEl.innerHTML = '';
  const keys = Object.keys(stats).filter(k => stats[k]);
  if (keys.length === 0) {
    const d = document.createElement('div');
    d.className = 'stat empty';
    d.textContent = '(stats fylls i senare)';
    tooltipStatsEl.appendChild(d);
  } else {
    for (const k of keys) {
      const d = document.createElement('div');
      d.className = 'stat';
      d.textContent = formatStat(k, stats[k]);
      tooltipStatsEl.appendChild(d);
    }
  }
  // Active-sektion (om def.activeAtMax finns)
  if (def.activeAtMax && tooltipActiveEl) {
    tooltipActiveEl.classList.remove('hidden');
    tooltipActiveDescEl.textContent = def.activeAtMax.description || '';
    if (level < ITEM_MAX_LEVEL) {
      tooltipActiveStatusEl.innerHTML = `<span>Låses upp vid level ${ITEM_MAX_LEVEL}</span>`;
    } else if ((entry.activeRemaining || 0) > 0) {
      tooltipActiveStatusEl.innerHTML = `<span class="ready">AKTIV: ${entry.activeRemaining.toFixed(1)}s</span>`;
    } else if ((entry.activeCd || 0) > 0) {
      tooltipActiveStatusEl.innerHTML = `<span class="cd">Klar om ${entry.activeCd.toFixed(1)}s</span>`;
    } else {
      tooltipActiveStatusEl.innerHTML = `<span class="ready">Tap för att aktivera</span>`;
    }
  } else if (tooltipActiveEl) {
    tooltipActiveEl.classList.add('hidden');
  }
  // Cost-rad
  if (level >= ITEM_MAX_LEVEL) {
    tooltipCostEl.textContent = 'MAX LEVEL';
    tooltipCostEl.classList.add('max');
  } else {
    tooltipCostEl.classList.remove('max');
    tooltipCostEl.textContent = `Uppgradera till lvl ${level + 1}: ${itemUpgradeCost(level)}g`;
  }
  // Position ovanför slot
  tooltipEl.classList.remove('hidden');
  const rect = slotEl.getBoundingClientRect();
  const ttRect = tooltipEl.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - ttRect.width / 2;
  let top = rect.top - ttRect.height - 8;
  left = Math.max(8, Math.min(window.innerWidth - ttRect.width - 8, left));
  if (top < 8) top = rect.bottom + 8;
  tooltipEl.style.left = left + 'px';
  tooltipEl.style.top = top + 'px';
}

function hideItemTooltip() {
  if (tooltipEl) tooltipEl.classList.add('hidden');
}

let tooltipPinnedSlot = null;
for (const slotEl of inventorySlotEls) {
  // Desktop hover
  slotEl.addEventListener('mouseenter', () => {
    if (!slotEl.dataset.itemId) return;
    if (tooltipPinnedSlot) return; // pinned mode tar över
    showItemTooltipForSlot(slotEl);
  });
  slotEl.addEventListener('mouseleave', () => {
    if (tooltipPinnedSlot) return;
    hideItemTooltip();
  });
  // Tap: aktivera om max-level + active ready, annars toggla tooltip
  slotEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!slotEl.dataset.itemId) return;
    const side = sides[APP.localSide];
    if (!side) return;
    const slotIdx = +slotEl.dataset.slot;
    const entry = side.inventory[slotIdx];
    if (!entry) return;
    const def = itemDefForEntry(entry);
    if (def && def.activeAtMax && entry.level >= ITEM_MAX_LEVEL && (entry.activeRemaining || 0) <= 0 && (entry.activeCd || 0) <= 0 && !side.hero.dead) {
      // Trigga active
      sendOrApplyEvent({ type: 'activate', slot: slotIdx });
      hideItemTooltip();
      tooltipPinnedSlot = null;
      return;
    }
    // Annars: toggle tooltip
    if (tooltipPinnedSlot === slotEl) {
      tooltipPinnedSlot = null;
      hideItemTooltip();
    } else {
      tooltipPinnedSlot = slotEl;
      showItemTooltipForSlot(slotEl);
    }
  });
}
// Klick utanför stänger pinned tooltip
document.addEventListener('click', () => {
  if (tooltipPinnedSlot) {
    tooltipPinnedSlot = null;
    hideItemTooltip();
  }
});

function updateInventoryDisplay() {
  const side = sides[APP.localSide];
  if (!side) {
    for (const slotEl of inventorySlotEls) {
      slotEl.classList.add('empty');
      slotEl.classList.remove('owned', 'active-ready', 'active-running', 'active-cooldown');
      slotEl.innerHTML = '';
      slotEl.dataset.itemId = '';
      slotEl.dataset.level = '';
    }
    return;
  }
  for (let i = 0; i < INVENTORY_SLOTS; i++) {
    const slotEl = inventorySlotEls[i];
    if (!slotEl) continue;
    const entry = side.inventory[i];
    if (entry) {
      const def = itemDefForEntry(entry);
      const icon = def ? def.icon : '?';
      slotEl.classList.remove('empty');
      slotEl.classList.add('owned');
      slotEl.dataset.itemId = entry.itemId;
      slotEl.dataset.level = String(entry.level);
      // Active-state-flaggor
      const hasActive = def && def.activeAtMax && entry.level >= ITEM_MAX_LEVEL;
      const running = (entry.activeRemaining || 0) > 0;
      const onCd = (entry.activeCd || 0) > 0;
      slotEl.classList.toggle('active-running', !!running);
      slotEl.classList.toggle('active-cooldown', !!(hasActive && !running && onCd));
      slotEl.classList.toggle('active-ready', !!(hasActive && !running && !onCd));
      // CD-overlay (visar siffror när active är på cooldown)
      let overlayHtml = '';
      if (hasActive && !running && onCd) {
        overlayHtml = `<div class="cd-overlay">${Math.ceil(entry.activeCd)}</div>`;
      }
      slotEl.innerHTML = `${icon}<span class="level-badge">${entry.level}</span>${overlayHtml}`;
      if (tooltipPinnedSlot === slotEl) showItemTooltipForSlot(slotEl);
    } else {
      slotEl.classList.add('empty');
      slotEl.classList.remove('owned', 'active-ready', 'active-running', 'active-cooldown');
      slotEl.innerHTML = '';
      slotEl.dataset.itemId = '';
      slotEl.dataset.level = '';
      if (tooltipPinnedSlot === slotEl) {
        tooltipPinnedSlot = null;
        hideItemTooltip();
      }
    }
  }
}

// ============================================================
// CHEAT-KOD: skriv "guld+N" och tryck Enter
// ============================================================
let cheatBuffer = '';
let cheatBufferTimer = null;

function showCheatNotification(text) {
  const el = document.createElement('div');
  el.className = 'income-popup';
  el.style.color = '#ff66ff';
  el.style.top = '92px';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => { try { el.remove(); } catch (_) {} }, 1700);
}

window.addEventListener('keydown', (e) => {
  if (APP.mode === 'lobby') return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;

  if (e.key === 'Enter') {
    const m = cheatBuffer.match(/guld\s*\+\s*(\d+)\s*$/i);
    if (m) {
      const amount = Math.max(0, Math.min(10_000_000, parseInt(m[1], 10)));
      if (amount > 0) {
        sendOrApplyEvent({ type: 'cheat', cmd: 'gold', amount });
        showCheatNotification(`Cheat +${amount}g`);
      }
    }
    cheatBuffer = '';
    return;
  }

  if (e.key === 'Backspace') {
    cheatBuffer = cheatBuffer.slice(0, -1);
    return;
  }

  if (e.key.length === 1) {
    cheatBuffer += e.key;
    if (cheatBuffer.length > 40) cheatBuffer = cheatBuffer.slice(-40);
  }

  if (cheatBufferTimer) clearTimeout(cheatBufferTimer);
  cheatBufferTimer = setTimeout(() => { cheatBuffer = ''; }, 3000);
});

function updateSkillButtonStyles() {
  const side = sides[APP.localSide];
  for (const key of ['q', 'f', 'e']) {
    const el = skillEls[key];
    const cd = side ? side.skills[key].cd : 0;
    if (cd > 0) {
      el.classList.add('cooling');
      el.querySelector('.cd').textContent = cd.toFixed(1);
    } else {
      el.classList.remove('cooling');
      el.querySelector('.cd').textContent = '';
    }
  }
  if (aaBtnEl) {
    const hasTarget = !!(side && side.aaActive && side.targetId);
    aaBtnEl.classList.toggle('has-target', hasTarget);
  }
}

// ============================================================
// LOKAL → HOST: events och input
// ============================================================

// Klientens kamera är speglad 180° runt Y, så screen-koords (joystick, drag-aim)
// måste konverteras till world-koords. Hjälte-facing lagras redan i world-koords.
function screenToWorld(sx, sz) {
  if (APP.localSide === 2) return { x: -sx, z: -sz };
  return { x: sx, z: sz };
}

// castLocalSkill tar EMOT world-koord-riktning. tap=true betyder "ingen drag — använd target som aim om finns".
function castLocalSkill(key, worldDx, worldDz, tap = false) {
  const side = sides[APP.localSide];
  if (!side || side.skills[key].cd > 0 || side.hero.dead) return;
  sendOrApplyEvent({ type: 'skill', key, dx: worldDx, dz: worldDz, tap });
}

function sendOrApplyEvent(ev) {
  if (APP.mode === 'solo') {
    applyEvent(sides[APP.localSide], ev);
  } else if (APP.mode === 'host' || APP.mode === 'client') {
    // Server är auktoritativ i multiplayer — alla events går via relay
    APP.pendingEvents.push(ev);
    flushClientInput();
  }
}

function readLocalJoystick() {
  // Tangentbord
  let kx = 0, kz = 0;
  if (keys['KeyW'] || keys['ArrowUp']) kz -= 1;
  if (keys['KeyS'] || keys['ArrowDown']) kz += 1;
  if (keys['KeyA'] || keys['ArrowLeft']) kx -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) kx += 1;
  const klen = Math.hypot(kx, kz);
  if (klen > 0) { kx /= klen; kz /= klen; }
  // Joystick prioriteras
  if (Math.hypot(joyState.dx, joyState.dz) > 0.05) return { x: joyState.dx, z: joyState.dz };
  if (klen > 0) return { x: kx, z: kz };
  return { x: 0, z: 0 };
}

// ============================================================
// NÄTVERK
// ============================================================

let lastInputJoy = { x: 0, z: 0 };
const INPUT_SEND_INTERVAL = 1 / 30;   // 30 Hz input
const STATE_SEND_INTERVAL = 1 / 20;   // 20 Hz state

function isMpMode() { return APP.mode === 'host' || APP.mode === 'client'; }

function flushClientInput() {
  if (!isMpMode() || !wsOpen()) return;
  const raw = readLocalJoystick();
  const dir = screenToWorld(raw.x, raw.z);
  const evs = APP.pendingEvents;
  APP.pendingEvents = [];
  sendGameMsg({ t: 'in', j: { x: dir.x, z: dir.z }, ev: evs });
  lastInputJoy = dir;
}

function maybeSendClientInput(now) {
  if (!isMpMode() || !wsOpen()) return;
  if (now - APP.lastInputSent < INPUT_SEND_INTERVAL && APP.pendingEvents.length === 0) return;
  APP.lastInputSent = now;
  flushClientInput();
}

function handleNetworkMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'st' && isMpMode()) {
    applyRemoteState(msg);
  }
}

// ---- Hero pick-skärm ----
// 10 hjältar — endast Magikern available just nu.
// Duel-state speglas från server (eller default i solo)
const duelState = {
  active: false, timer: 0, matchTimer: 0, count: 0, lastWinner: 0, announceTimer: 0,
  startBannerMs: 0,
};

const HEROES = [
  { id: 'magiker',   name: 'Gandulf',     role: 'Mage',         initial: 'G',   available: true  },
  { id: 'legolas',   name: 'Legolus',     role: 'Archer',       initial: 'L',   available: true  },
  { id: 'gimlu',     name: 'Gimlu',       role: 'Tank',         initial: 'Gi',  available: true  },
  { id: 'hero-4',    name: '? ? ?',       role: 'Coming Soon',  initial: '?',   available: false },
  { id: 'hero-5',    name: '? ? ?',       role: 'Coming Soon',  initial: '?',   available: false },
  { id: 'hero-6',    name: '? ? ?',       role: 'Coming Soon',  initial: '?',   available: false },
  { id: 'hero-7',    name: '? ? ?',       role: 'Coming Soon',  initial: '?',   available: false },
  { id: 'hero-8',    name: '? ? ?',       role: 'Coming Soon',  initial: '?',   available: false },
  { id: 'hero-9',    name: '? ? ?',       role: 'Coming Soon',  initial: '?',   available: false },
  { id: 'hero-10',   name: '? ? ?',       role: 'Coming Soon',  initial: '?',   available: false },
];

// Hero-info för Heroes-browsern (skill-beskrivningar + passiver + ikoner)
const HERO_INFO = {
  magiker: {
    skills: {
      q: { name: 'Fire Wave', icon: '🔥', desc: 'Skickar ut en triangulär eldvåg framför hjälten (45° vinkel, 5 m lång). Träffar alla fiender i konen med direkt damage och applicerar 3 sekunders DoT (damage over time).' },
      f: { name: 'Frost Nova', icon: '❄', desc: 'AoE-explosion (3.8 m radie) vid target eller drag-position. Skadar och fryser fiender i 2 sekunder. Om en frusen fiende träffas av en ny skill splittras isen (shatter) och skickar ut shards som skadar närliggande fiender.' },
      e: { name: 'Black Hole', icon: '⚫', desc: 'Spawnar en black hole vid target/drag-position som lever i 3 sekunder. Suger in fiender mot mitten. Vid slutet exploderar den i AoE-damage (4 m radie).' },
    },
    passive: { name: 'Arcane Echo', icon: '✦', desc: 'Var 4:e auto-attack är en AoE-pulse som skadar fiender runt träffpunkten.' },
  },
  legolas: {
    skills: {
      q: { name: 'Vine Trap Rain', icon: '🌿', desc: 'Skjuter en pil i luften som regnar ner pilar över en 3 m radie zon i 3 sekunder. Gör inget direkt damage — bara DoT och rotar fiender på plats medan de är i zonen.' },
      f: { name: 'Hunter\'s Focus', icon: '🎯', desc: '5 sekunders self-buff: +10% auto-attack damage, +10% crit chans, +30% crit damage.' },
      e: { name: 'Shadow Dash', icon: '💨', desc: 'Snabb dash framåt (4 m). Nästa auto-attack är garanterat crit + 20% lifesteal. Om den buffade AA dödar fienden, resetas dash-cooldown så du kan kedja.' },
    },
    passive: null,
  },
  gimlu: {
    skills: {
      q: { name: 'Titan\'s Taunt', icon: '📢', desc: 'Skrik som tauntar alla fiender inom 5.5 m i 3 sekunder — de tvingas attackera Gimlu (auto-attack bara, inga skills). Under buffen får Gimlu 30% damage reduction och healas 20% av all skada han tar.' },
      f: { name: 'Iron Will', icon: '🛡', desc: '3 sekunders aktiveringsfönster. All damage Gimlu tar lagras i en mätare. Vid slutet exploderar han i AoE (6 m radie) och gör damage = den lagrade summan till alla fiender runt.' },
      e: { name: 'Hammer Throw', icon: '🔨', desc: 'Kastar hammaren i en rak sträcka (9 m) som sedan flyger tillbaka. Full damage på vägen ut, halv damage på vägen tillbaka. Gimlu healas 50% av damage done. Tryck E igen medan hammaren är ute för att teleportera till den.' },
    },
    passive: null,
  },
};

// Inline-SVG-porträtt per hero (används i Heroes-browser och hero-pick).
function heroPortraitSVG(heroId) {
  if (heroId === 'magiker') return `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs><radialGradient id="bg-mg" cx="50%" cy="40%"><stop offset="0%" stop-color="#5a48a8"/><stop offset="100%" stop-color="#15102a"/></radialGradient></defs>
      <rect width="100" height="100" fill="url(#bg-mg)"/>
      <path d="M 8 100 Q 50 62 92 100 Z" fill="#241845"/>
      <circle cx="50" cy="56" r="13" fill="#e6c7a5"/>
      <path d="M 38 62 Q 50 90 62 62 Q 60 78 50 80 Q 40 78 38 62 Z" fill="#eaeaea"/>
      <ellipse cx="50" cy="55" rx="2.6" ry="2" fill="#eaeaea"/>
      <ellipse cx="50" cy="36" rx="22" ry="4" fill="#241845"/>
      <path d="M 32 34 L 50 6 L 68 34 Z" fill="#3a2c70"/>
      <circle cx="50" cy="22" r="2.8" fill="#ffe0a0"/>
      <circle cx="44" cy="55" r="1.4" fill="#1a1430"/>
      <circle cx="56" cy="55" r="1.4" fill="#1a1430"/>
    </svg>`;
  if (heroId === 'legolas') return `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs><radialGradient id="bg-lg" cx="50%" cy="40%"><stop offset="0%" stop-color="#345528"/><stop offset="100%" stop-color="#0c1808"/></radialGradient></defs>
      <rect width="100" height="100" fill="url(#bg-lg)"/>
      <path d="M 5 100 Q 50 65 95 100 Z" fill="#3a5028"/>
      <path d="M 18 80 L 24 100 L 6 100 Z" fill="#5a3a1a"/>
      <line x1="74" y1="42" x2="93" y2="20" stroke="#ddc680" stroke-width="2.5"/>
      <polygon points="92,18 88,24 96,22" fill="#bbb"/>
      <circle cx="50" cy="54" r="14" fill="#efd4b0"/>
      <path d="M 36 50 Q 50 32 64 50 L 66 64 Q 50 50 34 64 Z" fill="#eed8a8"/>
      <path d="M 30 52 Q 50 22 70 52 L 70 60 Q 50 36 30 60 Z" fill="#223a18" opacity="0.65"/>
      <circle cx="44" cy="55" r="1.5" fill="#2a1a08"/>
      <circle cx="56" cy="55" r="1.5" fill="#2a1a08"/>
      <ellipse cx="50" cy="60" rx="3" ry="1" fill="#a48060"/>
    </svg>`;
  if (heroId === 'gimlu') return `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs><radialGradient id="bg-gm" cx="50%" cy="40%"><stop offset="0%" stop-color="#6a4a32"/><stop offset="100%" stop-color="#1a1208"/></radialGradient></defs>
      <rect width="100" height="100" fill="url(#bg-gm)"/>
      <path d="M 5 100 Q 50 58 95 100 Z" fill="#4a4e54"/>
      <path d="M 50 100 L 32 78 L 68 78 Z" fill="#5a5e64" opacity="0.6"/>
      <circle cx="50" cy="60" r="16" fill="#d9a878"/>
      <path d="M 30 50 Q 50 32 70 50 L 70 56 L 30 56 Z" fill="#686c70"/>
      <ellipse cx="50" cy="44" rx="21" ry="14" fill="#586064"/>
      <polygon points="50,18 47,32 53,32" fill="#9fa3a7"/>
      <rect x="48" y="52" width="4" height="10" fill="#5a5e62"/>
      <path d="M 32 66 Q 50 96 68 66 Q 64 84 50 86 Q 36 84 32 66 Z" fill="#6e3a18"/>
      <ellipse cx="50" cy="66" rx="11" ry="2.4" fill="#6e3a18"/>
      <circle cx="43" cy="60" r="1.6" fill="#1a1208"/>
      <circle cx="57" cy="60" r="1.6" fill="#1a1208"/>
    </svg>`;
  return null; // placeholder → caller använder fallback (initial)
}

const heroPickEl = document.getElementById('hero-pick');
const hpTimerEl = document.getElementById('hp-timer');
const hpGridEl = document.getElementById('hp-grid');
const hpStatusEl = document.getElementById('hp-status');
const hpOppStatusEl = document.getElementById('hp-opp-status');
const hpConfirmBtn = document.getElementById('hp-confirm');

const heroPickState = {
  active: false,
  mode: null,           // 'solo' | 'host' | 'client'
  selected: null,       // egen heroId
  confirmed: false,     // egen confirm
  timer: 60,
  timerHandle: null,
  oppSelected: null,    // andras heroId (MP)
  oppConfirmed: false,
};

// === Heroes-browser (huvudmenyn) ===
const heroesBrowserContent = document.getElementById('heroes-browser-content');
const itemsBrowserContent = document.getElementById('items-browser-content');
const heroDetailModal = document.getElementById('hero-detail-modal');
const heroDetailBody = document.getElementById('hero-detail-body');
const itemDetailModal = document.getElementById('item-detail-modal');
const itemDetailBody = document.getElementById('item-detail-body');
let heroesBrowserSkillKey = null;

function renderHeroesBrowser() {
  if (!heroesBrowserContent) return;
  heroesBrowserContent.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'browser-grid';
  for (const h of HEROES) {
    const card = document.createElement('div');
    card.className = 'browser-card' + (h.available ? '' : ' locked');
    const portrait = heroPortraitSVG(h.id);
    const portraitHtml = portrait ? portrait : h.initial;
    card.innerHTML = `<div class="card-icon">${portraitHtml}</div><div class="card-name">${h.name}</div><div class="card-role">${h.role}</div>`;
    if (h.available) card.addEventListener('click', () => openHeroDetailModal(h.id));
    grid.appendChild(card);
  }
  heroesBrowserContent.appendChild(grid);
}

function openHeroDetailModal(heroId) {
  const hero = HEROES.find(h => h.id === heroId);
  const info = HERO_INFO[heroId];
  const def = HERO_DEFS[heroId] || HERO_DEFS.magiker;
  if (!hero || !info || !heroDetailModal) return;
  heroesBrowserSkillKey = null;
  renderHeroDetail(heroId, hero, info, def);
  heroDetailModal.classList.remove('hidden');
}
function closeHeroDetailModal() { if (heroDetailModal) heroDetailModal.classList.add('hidden'); }

function renderHeroDetail(heroId, hero, info, def) {
  const portrait = heroPortraitSVG(heroId) || `<div style="font:800 36px/100px sans-serif;text-align:center;color:#ffd34a">${hero.initial}</div>`;
  const statRows = [
    ['HP', def.baseHp],
    ['AA-dmg', def.baseDmg],
    ['AA-range', def.attackRange.toFixed(1) + ' m'],
    ['AA-interval', def.attackInterval.toFixed(2) + ' s'],
    ['Move-speed', def.baseMoveSpeed.toFixed(1)],
  ].map(([l, v]) => `<div class="stat-row"><span class="stat-label">${l}</span><span class="stat-val">${v}</span></div>`).join('');
  const skillItems = ['q', 'f', 'e'].map(key => {
    const s = info.skills[key];
    return `<div class="skill-item${heroesBrowserSkillKey === key ? ' expanded' : ''}" data-skill="${key}">
      <div class="skill-head"><div class="skill-key ${key}">${s.icon || key.toUpperCase()}</div><span>${key.toUpperCase()} · ${s.name}</span></div>
      <div class="skill-desc">${s.desc}</div>
    </div>`;
  }).join('');
  const passive = info.passive
    ? `<div class="skill-item${heroesBrowserSkillKey === 'p' ? ' expanded' : ''}" data-skill="p">
        <div class="skill-head"><div class="skill-key p">${info.passive.icon || 'P'}</div><span>Passiv · ${info.passive.name}</span></div>
        <div class="skill-desc">${info.passive.desc}</div>
      </div>`
    : '';
  heroDetailBody.innerHTML = `
    <div class="hero-modal-head">
      <div class="hero-modal-portrait">${portrait}</div>
      <div>
        <h2>${hero.name}</h2>
        <div class="sub-role">${hero.role}</div>
      </div>
    </div>
    <div class="stat-grid">${statRows}</div>
    <div class="skill-list">${skillItems}${passive}</div>
  `;
  heroDetailBody.querySelectorAll('.skill-item').forEach(el => {
    el.addEventListener('click', () => {
      const k = el.dataset.skill;
      heroesBrowserSkillKey = (heroesBrowserSkillKey === k) ? null : k;
      renderHeroDetail(heroId, hero, info, def);
    });
  });
}

// === Items-browser ===
function openItemDetailModal(itemId) {
  const def = ITEM_TYPES[itemId];
  if (!def || !def.variants || !itemDetailModal) return;
  renderItemDetail(itemId, def);
  itemDetailModal.classList.remove('hidden');
}
function closeItemDetailModal() { if (itemDetailModal) itemDetailModal.classList.add('hidden'); }

function renderItemDetail(itemId, def) {
  const variantBlocks = Object.values(def.variants).map(v => {
    const sample = v.statsAtLevel(1);
    const statKeys = Object.keys(sample);
    const thead = `<th>Lvl</th>${statKeys.map(k => `<th>${STAT_LABELS[k] || k}</th>`).join('')}`;
    const rows = [];
    for (let lvl = 1; lvl <= 10; lvl++) {
      const s = v.statsAtLevel(lvl);
      rows.push(`<tr><td class="lv">${lvl}</td>${statKeys.map(k => `<td>${fmtStatVal(k, s[k])}</td>`).join('')}</tr>`);
    }
    const activeHtml = v.activeAtMax
      ? `<div class="variant-active"><b>Active (lvl 10):</b> ${v.activeAtMax.description || ''} — ${v.activeAtMax.duration}s effekt, ${v.activeAtMax.cooldown}s cd</div>`
      : '';
    return `<div class="variant-block">
      <div class="variant-name">${v.icon || ''} ${v.name}</div>
      <div class="variant-desc">${v.description || ''}</div>
      <table class="tier-table"><thead><tr>${thead}</tr></thead><tbody>${rows.join('')}</tbody></table>
      ${activeHtml}
    </div>`;
  }).join('');
  itemDetailBody.innerHTML = `<h3 style="color:#ffd34a;margin:0 0 4px;font-size:24px">${def.icon || ''} ${def.name}</h3>
    <div class="sub-role">${def.description || ''}</div>
    <div class="sub-role" style="margin-bottom:10px">Köp: ${ITEM_BUY_COST}g · Uppgradering lvl N: 500×2^(N-1) guld · Max level 10</div>
    <div class="variant-list">${variantBlocks}</div>`;
}

let itemsBrowserSelected = null;

function fmtStatVal(key, val) {
  if (!val) return '';
  if (key.endsWith('Pct')) {
    const pct = Math.round(val * 1000) / 10;
    return `${pct}%`;
  }
  return String(val);
}

function renderItemsBrowser() {
  if (!itemsBrowserContent) return;
  itemsBrowserContent.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'browser-grid';
  for (const itemId of ITEM_ORDER) {
    const def = ITEM_TYPES[itemId];
    if (!def) continue;
    const hasVariants = !!def.variants;
    const card = document.createElement('div');
    card.className = 'browser-card' + (hasVariants ? '' : ' locked');
    card.innerHTML = `<div class="card-icon" style="font-size:34px;background:linear-gradient(135deg,#2a2456,#15102a)">${def.icon || '?'}</div><div class="card-name">${def.name}</div><div class="card-role">${hasVariants ? 'Klicka för detaljer' : 'Coming Soon'}</div>`;
    if (hasVariants) card.addEventListener('click', () => openItemDetailModal(itemId));
    grid.appendChild(card);
  }
  itemsBrowserContent.appendChild(grid);
}

function renderHeroGrid() {
  hpGridEl.innerHTML = '';
  for (const h of HEROES) {
    const card = document.createElement('div');
    card.className = 'hp-card' + (h.available ? '' : ' locked');
    card.dataset.heroId = h.id;
    const portrait = heroPortraitSVG(h.id);
    const portraitHtml = portrait ? portrait : h.initial;
    card.innerHTML = `<div class="hp-portrait">${portraitHtml}</div><div class="hp-name">${h.name}</div><div class="hp-role">${h.role}</div>`;
    if (h.available) {
      card.addEventListener('click', () => selectHero(h.id));
    }
    hpGridEl.appendChild(card);
  }
}

function selectHero(heroId) {
  if (heroPickState.confirmed) return;
  const hero = HEROES.find(h => h.id === heroId);
  if (!hero || !hero.available) return;
  heroPickState.selected = heroId;
  refreshHeroCardUI();
  hpConfirmBtn.disabled = false;
  hpStatusEl.textContent = `Vald: ${hero.name}`;
  if (heroPickState.mode === 'host' || heroPickState.mode === 'client') {
    sendOrApplyEvent({ type: 'hero-pick', heroId });
  }
}

function refreshHeroCardUI() {
  for (const card of hpGridEl.querySelectorAll('.hp-card')) {
    const id = card.dataset.heroId;
    card.classList.toggle('selected', id === heroPickState.selected);
    card.classList.toggle('opp-selected', !!heroPickState.oppSelected && id === heroPickState.oppSelected && id !== heroPickState.selected);
  }
}

function confirmHero() {
  if (!heroPickState.selected || heroPickState.confirmed) return;
  heroPickState.confirmed = true;
  hpConfirmBtn.disabled = true;
  hpConfirmBtn.classList.add('confirmed');
  if (heroPickState.mode === 'solo') {
    hpConfirmBtn.textContent = 'Startar...';
    finishHeroPick();
  } else {
    hpConfirmBtn.textContent = 'Väntar på motståndaren...';
    sendOrApplyEvent({ type: 'hero-confirm' });
  }
}

function finishHeroPick() {
  if (heroPickState.timerHandle) {
    clearInterval(heroPickState.timerHandle);
    heroPickState.timerHandle = null;
  }
  heroPickState.active = false;
  heroPickState.mode = null;
  enterPlayPhase();
}

function showHeroPick(mode) {
  setupMatch(mode);  // Skapa sidor + sätt APP.mode INNAN pick visas
  heroPickState.active = true;
  heroPickState.mode = mode;
  heroPickState.selected = null;
  heroPickState.confirmed = false;
  heroPickState.timer = 60;
  heroPickState.oppSelected = null;
  heroPickState.oppConfirmed = false;
  hpConfirmBtn.disabled = true;
  hpConfirmBtn.classList.remove('confirmed');
  hpConfirmBtn.textContent = 'Confirm';
  hpStatusEl.textContent = 'Välj en hjälte';
  hpOppStatusEl.textContent = (mode === 'solo') ? '' : 'Motståndaren väljer...';
  hpTimerEl.textContent = '60';
  hpTimerEl.classList.remove('urgent');
  renderHeroGrid();
  lobbyEl.classList.add('hidden');
  heroPickEl.classList.remove('hidden');

  if (heroPickState.timerHandle) clearInterval(heroPickState.timerHandle);
  // Solo: lokal timer. MP: server driver timern via state.pT.
  if (mode === 'solo') {
    heroPickState.timerHandle = setInterval(() => {
      heroPickState.timer -= 1;
      if (heroPickState.timer <= 0) {
        heroPickState.timer = 0;
        if (!heroPickState.selected) heroPickState.selected = 'magiker';
        if (!heroPickState.confirmed) confirmHero();
      }
      hpTimerEl.textContent = String(heroPickState.timer);
      hpTimerEl.classList.toggle('urgent', heroPickState.timer <= 10);
    }, 1000);
  }
}

if (hpConfirmBtn) hpConfirmBtn.addEventListener('click', confirmHero);

// MP: hantera server-state under hero-pick. Synkronisera timer + motståndarens val/confirm + transition.
function handleRemotePickState(state) {
  if (!heroPickState.active || heroPickState.mode === 'solo') return;
  // Server-timer auktoritativ
  if (state.pT !== undefined) {
    const t = Math.ceil(state.pT);
    heroPickState.timer = t;
    hpTimerEl.textContent = String(t);
    hpTimerEl.classList.toggle('urgent', t <= 10);
  }
  // Motståndarens val + confirm-status
  const oppIdx = 3 - APP.localSide;
  const oppData = state.s && state.s[oppIdx];
  if (oppData) {
    heroPickState.oppSelected = oppData.hid || null;
    heroPickState.oppConfirmed = !!oppData.hpc;
    refreshHeroCardUI();
    if (heroPickState.oppConfirmed) {
      const oppHero = HEROES.find(h => h.id === heroPickState.oppSelected);
      hpOppStatusEl.textContent = `Motståndaren klar: ${oppHero ? oppHero.name : heroPickState.oppSelected}`;
    } else if (heroPickState.oppSelected) {
      const oppHero = HEROES.find(h => h.id === heroPickState.oppSelected);
      hpOppStatusEl.textContent = `Motståndaren tittar på: ${oppHero ? oppHero.name : '...'}`;
    } else {
      hpOppStatusEl.textContent = 'Motståndaren väljer...';
    }
  }
  // Transition till spel
  if (state.ph === 'game') {
    finishHeroPick();
  }
}

// ---- Lobby logic ----

const lobbyEl = document.getElementById('lobby');
const lobbyMainEl = document.getElementById('lobby-main');
const lobbyHostingEl = document.getElementById('lobby-hosting');
const lobbyJoiningEl = document.getElementById('lobby-joining');
const lobbyCodeDisplayEl = document.getElementById('lobby-code-display');
const lobbyHostMsgEl = document.getElementById('lobby-host-msg');
const lobbyJoinMsgEl = document.getElementById('lobby-join-msg');
const lobbyCodeInputEl = document.getElementById('lobby-code-input');

const lobbyHeroesEl = document.getElementById('lobby-heroes');
const lobbyItemsEl = document.getElementById('lobby-items');
function showLobbyPanel(which) {
  for (const el of [lobbyMainEl, lobbyHostingEl, lobbyJoiningEl, lobbyHeroesEl, lobbyItemsEl]) {
    if (el) el.classList.remove('visible');
  }
  if (which === 'main') lobbyMainEl.classList.add('visible');
  else if (which === 'hosting') lobbyHostingEl.classList.add('visible');
  else if (which === 'joining') lobbyJoiningEl.classList.add('visible');
  else if (which === 'heroes') lobbyHeroesEl.classList.add('visible');
  else if (which === 'items') lobbyItemsEl.classList.add('visible');
}

function showLobbyError(msg) {
  lobbyHostMsgEl.innerHTML = `<span class="err">${msg}</span>`;
  lobbyJoinMsgEl.innerHTML = `<span class="err">${msg}</span>`;
}

// ---- WebSocket relay-anslutning ----
// Öppnar en WS till relay-servern och registrerar en envelope-handler.
// Server-protokoll:
//   client → server : { t: 'host' } | { t: 'join', code } | { t: 'msg', d } | { t: 'leave' }
//   server → client : { t: 'hosted', code } | { t: 'joined', code } | { t: 'join-error', msg }
//                     | { t: 'peer-joined' } | { t: 'peer-left' } | { t: 'msg', d }
function openRelay() {
  return new Promise((resolve, reject) => {
    if (wsOpen()) { resolve(APP.ws); return; }
    let ws;
    try { ws = new WebSocket(RELAY_URL); }
    catch (e) { reject(e); return; }
    let settled = false;
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (_) {}
      reject(new Error(msg));
    };
    const to = setTimeout(() => fail('Tog för lång tid att nå relay-servern'), 60000);
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      APP.ws = ws;
      ws.onmessage = handleRelayEnvelope;
      ws.onclose = onRelayClose;
      ws.onerror = (err) => { console.warn('WS error', err); };
      resolve(ws);
    };
    ws.onerror = (err) => { console.warn('WS error pre-open', err); fail('Kunde inte ansluta till relay-servern'); };
    ws.onclose = () => { fail('Anslutningen stängdes innan den öppnades'); };
  });
}

function handleRelayEnvelope(e) {
  let env;
  try { env = JSON.parse(e.data); } catch (_) { return; }
  if (!env || typeof env !== 'object') return;
  if (env.t === 'hosted') {
    onHosted(env.code);
  } else if (env.t === 'joined') {
    onJoined(env.code);
  } else if (env.t === 'join-error') {
    showLobbyError(env.msg || 'Kunde inte ansluta.');
    closeRelay();
  } else if (env.t === 'peer-joined') {
    onPeerJoined();
  } else if (env.t === 'peer-left') {
    if (APP.mode === 'host' || APP.mode === 'client') {
      showLobbyError('Motståndaren lämnade matchen.');
      returnToLobby();
    }
  } else if (env.t === 'msg') {
    handleNetworkMessage(env.d);
  }
}

function onRelayClose() {
  console.log('WS closed');
  if (APP.mode === 'host' || APP.mode === 'client') {
    showLobbyError('Anslutningen till servern tappades.');
    returnToLobby();
  }
}

function closeRelay() {
  if (APP.ws) {
    try { APP.ws.onclose = null; APP.ws.close(); } catch (_) {}
    APP.ws = null;
  }
}

let pendingHostCode = null;

function onHosted(code) {
  pendingHostCode = code;
  lobbyCodeDisplayEl.textContent = code;
  lobbyHostMsgEl.textContent = 'Väntar på spelare...';
}

function onPeerJoined() {
  if (APP.mode !== 'lobby') return;
  showHeroPick('host');
}

function onJoined(code) {
  if (APP.mode !== 'lobby') return;
  showHeroPick('client');
}

async function hostGame() {
  showLobbyPanel('hosting');
  lobbyHostMsgEl.textContent = 'Ansluter till server (kan ta ~30 s om servern sover)...';
  try {
    await openRelay();
  } catch (err) {
    showLobbyError('Kunde inte nå servern: ' + (err.message || 'okänt fel'));
    return;
  }
  wsSendEnvelope({ t: 'host' });
  lobbyHostMsgEl.textContent = 'Skapar rum...';
}

function cancelHosting() {
  closeRelay();
  pendingHostCode = null;
  lobbyCodeDisplayEl.textContent = '----';
  lobbyHostMsgEl.textContent = '';
  showLobbyPanel('main');
}

async function joinGame() {
  const code = lobbyCodeInputEl.value.trim().toUpperCase();
  if (code.length !== 4) {
    lobbyJoinMsgEl.innerHTML = '<span class="err">Koden måste vara 4 tecken.</span>';
    return;
  }
  lobbyJoinMsgEl.textContent = 'Ansluter till server (kan ta ~30 s om servern sover)...';
  try {
    await openRelay();
  } catch (err) {
    showLobbyError('Kunde inte nå servern: ' + (err.message || 'okänt fel'));
    return;
  }
  lobbyJoinMsgEl.textContent = 'Söker rummet...';
  wsSendEnvelope({ t: 'join', code });
}

function setupMatch(mode) {
  APP.mode = mode;
  if (mode === 'solo') {
    APP.localSide = 1;
    APP.twoSides = false;
    sides[1] = createSide(1);
    sides[2] = null;
  } else if (mode === 'host') {
    APP.localSide = 1;
    APP.twoSides = true;
    sides[1] = createSide(1);
    sides[2] = createSide(2);
  } else if (mode === 'client') {
    APP.localSide = 2;
    APP.twoSides = true;
    sides[1] = createSide(1);
    sides[2] = createSide(2);
  }
  matchState.gameOver = false;
  matchState.gameWon = false;
  matchState.winner = 0;
  resetIncomeTickTracking();
  lobbyEl.classList.add('hidden');
}
function startMatch(mode) {
  setupMatch(mode);
  enterPlayPhase();
}
function enterPlayPhase() {
  document.body.classList.add('in-game');
  if (heroPickEl) heroPickEl.classList.add('hidden');
  // Starta duel-timer (5 min) så fort matchen börjar. MP får detta från servern;
  // i solo tickas den lokalt via simulateAll/tick.
  duelState.timer = 300;
  duelState.count = 0;
  duelState.active = false;
  duelState.matchTimer = 0;
  duelState.announceTimer = 0;
  duelState.lastWinner = 0;
  // Reset wave-banner tracking
  waveBannerState.lastSeenPulse = 0;
  if (waveBannerState.hideTimeout) { clearTimeout(waveBannerState.hideTimeout); waveBannerState.hideTimeout = null; }
  if (waveBannerEl) waveBannerEl.classList.add('hidden');
  // Sätt heroId och byt mesh om hjälten skiljer från default.
  // Solo: läs från heroPickState.selected. MP: side.heroId är redan satt via clientReconcileSide.
  for (const idx of [1, 2]) {
    const s = sides[idx];
    if (!s) continue;
    if (APP.mode === 'solo' && idx === APP.localSide && heroPickState.selected) {
      s.heroId = heroPickState.selected;
    }
    swapHeroMeshIfNeeded(s);
  }
  // Recompute stats för solo (MP får från servern)
  if (APP.mode === 'solo') {
    if (sides[1]) recomputeSideStats(sides[1]);
  }
}

function swapHeroMeshIfNeeded(side) {
  const wantedHeroId = side.heroId || 'magiker';
  const currentHeroId = side.mesh?.userData?.heroId || 'magiker';
  if (wantedHeroId === currentHeroId) return;
  // Behåll position, rotation och hp-bar-state
  const oldMesh = side.mesh;
  const newMesh = makeHeroMesh(side.idx, wantedHeroId);
  newMesh.position.copy(oldMesh.position);
  newMesh.rotation.y = oldMesh.rotation.y;
  newMesh.visible = oldMesh.visible;
  attachHpBar(newMesh, 2.0, true);
  scene.add(newMesh);
  scene.remove(oldMesh);
  side.mesh = newMesh;
}

function returnToLobby() {
  closeRelay();
  pendingHostCode = null;
  if (sides[1]) { removeSide(sides[1]); sides[1] = null; }
  if (sides[2]) { removeSide(sides[2]); sides[2] = null; }
  for (const key of ['monsters', 'playerCreeps', 'fireballs', 'projectiles', 'novaEffects', 'creepProjectiles']) {
    for (const m of clientMeshes[key].values()) for (const mesh of m.values()) scene.remove(mesh);
    clientMeshes[key].clear();
  }
  endgameEl.classList.remove('visible');
  document.body.classList.remove('in-game');
  // Avbryt hero-pick om aktiv
  if (heroPickEl) heroPickEl.classList.add('hidden');
  if (heroPickState.timerHandle) {
    clearInterval(heroPickState.timerHandle);
    heroPickState.timerHandle = null;
  }
  heroPickState.active = false;
  heroPickState.mode = null;
  lobbyEl.classList.remove('hidden');
  showLobbyPanel('main');
  APP.mode = 'lobby';
  resetIncomeTickTracking();
}

document.getElementById('btn-host').addEventListener('click', hostGame);
document.getElementById('btn-host-cancel').addEventListener('click', cancelHosting);
document.getElementById('btn-join').addEventListener('click', () => {
  lobbyJoinMsgEl.textContent = '';
  showLobbyPanel('joining');
  setTimeout(() => lobbyCodeInputEl.focus(), 50);
});
document.getElementById('btn-join-back').addEventListener('click', () => {
  closeRelay();
  showLobbyPanel('main');
});
document.getElementById('btn-join-connect').addEventListener('click', joinGame);
lobbyCodeInputEl.addEventListener('input', () => {
  lobbyCodeInputEl.value = lobbyCodeInputEl.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
});
lobbyCodeInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinGame();
});
lobbyCodeDisplayEl.addEventListener('click', () => {
  const code = lobbyCodeDisplayEl.textContent.trim();
  if (code && code !== '----' && navigator.clipboard) {
    navigator.clipboard.writeText(code).then(() => {
      lobbyHostMsgEl.textContent = `Kopierat: ${code} — väntar på spelare...`;
    });
  }
});
document.getElementById('btn-solo').addEventListener('click', () => showHeroPick('solo'));
document.getElementById('btn-heroes').addEventListener('click', () => { renderHeroesBrowser(); showLobbyPanel('heroes'); });
document.getElementById('btn-items').addEventListener('click', () => { renderItemsBrowser(); showLobbyPanel('items'); });
document.getElementById('btn-heroes-back').addEventListener('click', () => showLobbyPanel('main'));
document.getElementById('btn-items-back').addEventListener('click', () => showLobbyPanel('main'));
const btnHeroDetailBack = document.getElementById('btn-hero-detail-back');
if (btnHeroDetailBack) btnHeroDetailBack.addEventListener('click', closeHeroDetailModal);
const btnItemDetailBack = document.getElementById('btn-item-detail-back');
if (btnItemDetailBack) btnItemDetailBack.addEventListener('click', closeItemDetailModal);
// Klick på modal-bakgrund stänger också
if (heroDetailModal) heroDetailModal.addEventListener('click', (e) => { if (e.target === heroDetailModal) closeHeroDetailModal(); });
if (itemDetailModal) itemDetailModal.addEventListener('click', (e) => { if (e.target === itemDetailModal) closeItemDetailModal(); });

// ============================================================
// HUVUDLOOP
// ============================================================

const clock = new THREE.Clock();

function simulateAll(dt) {
  // Lokal duel-timer (bara HUD, ingen duel triggas i solo). Stannar vid 0.
  if (duelState.timer > 0) duelState.timer = Math.max(0, duelState.timer - dt);
  // Hjälte-respawn
  for (const side of [sides[1], sides[2]]) {
    if (!side) continue;
    if (side.hero.dead) {
      side.hero.respawnTimer -= dt;
      if (side.hero.respawnTimer <= 0) respawnHero(side);
    }
  }
  // Applicera input för lokal sida
  if (sides[APP.localSide]) {
    const raw = readLocalJoystick();
    const dir = screenToWorld(raw.x, raw.z);
    applyMovement(sides[APP.localSide], dir.x, dir.z, dt);
  }
  // (Multiplayer-fjärrsidans input hanteras av servern numera — denna funktion
  // kör bara i solo-mode där sides[2] inte existerar.)
  // Fontän-aura: compute närhet till egen fontän + regen, innan andra updates
  for (const side of [sides[1], sides[2]]) {
    if (!side) continue;
    const cfg = SIDE_CFG[side.idx];
    if (side.hero.dead) {
      side.heroFountainAura = false;
    } else {
      const dx = side.hero.x - cfg.tower.x;
      const dz = side.hero.z - cfg.tower.z;
      side.heroFountainAura = (dx * dx + dz * dz) < FOUNTAIN_AURA_RADIUS_SQ;
      if (side.heroFountainAura && side.hero.hp < side.hero.maxHp) {
        side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + side.hero.maxHp * FOUNTAIN_AURA_REGEN_PCT * dt);
      }
      if ((side.healPerSecPct || 0) > 0 && side.hero.hp < side.hero.maxHp) {
        side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + side.hero.maxHp * side.healPerSecPct * dt);
      }
    }
  }
  // Per-sida simulering
  for (const side of [sides[1], sides[2]]) {
    if (!side) continue;
    updateSkillCooldowns(side, dt);
    updateWaves(side, dt);
    updateMonsters(side, dt);
    updatePlayerCreeps(side, dt);
    updateCreepProjectiles(side, dt);
    if (!side.hero.dead) updateHeroAttack(side, dt);
    updateProjectiles(side, dt);
    updateFireballs(side, dt);
    updateBlackHolesSolo(side, dt);
    updateVineTrapsSolo(side, dt);
    updateHammersSolo(side, dt);
    updateIronWillSolo(side, dt);
    if ((side.legolusBuffRemaining || 0) > 0) side.legolusBuffRemaining = Math.max(0, side.legolusBuffRemaining - dt);
    if ((side.titansTauntRemaining || 0) > 0) side.titansTauntRemaining = Math.max(0, side.titansTauntRemaining - dt);
    updateNovaEffects(side, dt);
    updateActiveBuffs(side, dt);
    tickIncome(side, dt);
  }
  checkMatchEnd();
}

function tickIncome(side, dt) {
  side.incomeTimer += dt;
  while (side.incomeTimer >= INCOME_INTERVAL) {
    side.incomeTimer -= INCOME_INTERVAL;
    side.gold += side.income;
    side.incomeTickCount = (side.incomeTickCount || 0) + 1;
  }
}

// ---- Income-display + tick-notiser ----

const incomeDisplayEl = document.getElementById('income-display');

function updateIncomeDisplay() {
  if (!incomeDisplayEl) return;
  const side = sides[APP.localSide];
  if (!side) return;
  incomeDisplayEl.textContent = `Income: ${side.income}g / 15s`;
}

function showIncomeNotification(amount) {
  const el = document.createElement('div');
  el.className = 'income-popup';
  el.textContent = `Income +${amount}g`;
  document.body.appendChild(el);
  setTimeout(() => { try { el.remove(); } catch (_) {} }, 1700);
}

let lastSeenIncomeTickCount = null;
function resetIncomeTickTracking() { lastSeenIncomeTickCount = null; }

function checkIncomeTickNotifications() {
  const side = sides[APP.localSide];
  if (!side) return;
  const cur = side.incomeTickCount || 0;
  if (lastSeenIncomeTickCount === null) {
    lastSeenIncomeTickCount = cur;
    return;
  }
  if (cur > lastSeenIncomeTickCount) {
    const delta = cur - lastSeenIncomeTickCount;
    showIncomeNotification(side.income * delta);
    lastSeenIncomeTickCount = cur;
  }
}

function animateSceneProps(dt, now) {
  // Fontäner: pulsera emissive på vattnet, bobba övre skålens vattenyta
  for (const idx of [1, 2]) {
    const f = towerMeshes[idx];
    if (!f) continue;
    const pulse = 0.5 + 0.18 * Math.sin(now * 1.6 + idx);
    if (f.water && f.water.material) {
      f.water.material.emissiveIntensity = pulse;
    }
    if (f.topWater) {
      f.topWater.position.y = 2.14 + Math.sin(now * 2.2 + idx) * 0.012;
      if (f.topWater.material) f.topWater.material.emissiveIntensity = 0.65 + 0.2 * Math.sin(now * 2.4 + idx * 0.7);
    }
    if (f.light) f.light.intensity = 0.85 + 0.25 * Math.sin(now * 1.3 + idx);
    if (f.crystal) {
      f.crystal.rotation.y = now * 0.6 + idx;
      f.crystal.position.y = 3.78 + Math.sin(now * 1.4 + idx) * 0.04;
      if (f.crystal.material) f.crystal.material.emissiveIntensity = 1.0 + 0.35 * Math.sin(now * 1.7 + idx * 0.6);
    }
    if (f.auraRing) {
      const inAura = !!(sides[idx] && sides[idx].heroFountainAura);
      const base = inAura ? 0.55 : 0.18;
      const amp = inAura ? 0.20 : 0.07;
      f.auraRing.material.opacity = base + amp * Math.sin(now * (inAura ? 3.4 : 1.8) + idx);
    }
  }
  // Lägereld: flammor flickrar i höjd och belysning
  for (const idx of [1, 2]) {
    const c = campfires[idx];
    if (!c) continue;
    if (c.flames) {
      for (let i = 0; i < c.flames.length; i++) {
        const fl = c.flames[i];
        const k = 0.9 + 0.18 * Math.sin(now * (7 + i * 1.4) + idx);
        fl.scale.set(1, k, 1);
        fl.position.x = (Math.sin(now * (5 + i) + i) * 0.05);
        fl.position.z = (Math.cos(now * (4.2 + i) + i) * 0.05);
      }
    }
    if (c.light) c.light.intensity = 0.55 + 0.25 * Math.sin(now * 9.0 + idx * 1.7) + 0.1 * Math.sin(now * 17 + idx);
  }
}

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now() / 1000;

  if (APP.mode === 'solo') {
    if (!matchState.gameOver) simulateAll(dt);
  } else if (isMpMode()) {
    // Servern simulerar — klienten skickar bara input och renderar mottagen state
    maybeSendClientInput(now);
    smoothEntityMeshes(dt);
  }

  animateAllCharacters(dt);
  animateSceneProps(dt, now);
  tickAllHpBars();

  updateHud();
  updateDuelHud();
  checkWaveBanner();
  updateIncomeDisplay();
  checkIncomeTickNotifications();
  updateSkillButtonStyles();
  updateAimIndicators();
  updateTargetIndicator();
  updateShop();
  updateInventoryDisplay();
  updateCamera(dt);

  if (bloomComposer) bloomComposer.render();
  else renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
