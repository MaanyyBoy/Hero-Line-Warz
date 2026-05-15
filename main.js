import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// ============================================================
// THREE.JS GRUND-SETUP
// ============================================================

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14202c);
scene.fog = new THREE.Fog(0x14202c, 30, 75);

// Mobil-detection (touchskärm + smal viewport): sänk pixel-ratio och stäng
// av antialias för bättre FPS. På desktop (mus + bred skärm) kör vi full
// kvalitet.
const isMobileDevice = (typeof window !== 'undefined') && (
  ('ontouchstart' in window) || (navigator.maxTouchPoints > 0)
) && (window.innerWidth < 1100);
const renderer = new THREE.WebGLRenderer({
  antialias: !isMobileDevice,
  powerPreference: 'high-performance',
});
// Pixel-ratio cap 1.5 på mobil (retina-skärmar har devicePixelRatio 2-3 →
// renderar 4-9× pixlar utan visuell vinst vid spel-zoom). Desktop kör 2x.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobileDevice ? 1.5 : 2));
// getViewportSize() läser visualViewport när det finns (mer exakt på mobil vid
// rotation, adressfält som glider, pinch-zoom) och faller tillbaka på innerWidth.
function getViewportSize() {
  const vv = window.visualViewport;
  const w = Math.max(1, Math.round(vv ? vv.width : window.innerWidth));
  const h = Math.max(1, Math.round(vv ? vv.height : window.innerHeight));
  return { w, h };
}
const __vp0 = getViewportSize();
renderer.setSize(__vp0.w, __vp0.h);
renderer.shadowMap.enabled = true;
// PCFShadowMap istället för PCFSoftShadowMap: cheaper sampling (4 taps vs 16),
// ~30% snabbare shadow-pass utan synlig kvalitetsskillnad vid spel-zoom.
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(50, __vp0.w / __vp0.h, 0.1, 200);

// Bloom-postprocessing borttagen tillfälligt — three.js' addons använder bare-specifier
// 'three' internt vilket kräver importmap som inte funkar i alla browsers.
// Återinförs när vi har ett mer browser-säkert sätt (esm.sh eller liknande).
const bloomComposer = null;

function applyViewportSize() {
  const { w, h } = getViewportSize();
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', applyViewportSize);
// orientationchange firar innan innerWidth/innerHeight uppdaterats på vissa
// browsers (iOS Safari, äldre Android Chrome). Utan detta blir canvasen
// portrait-bred i landscape → höger halva svart. Re-applya på nästa frame och
// efter en kort fördröjning så vi fångar layout-settling i alla browsers.
window.addEventListener('orientationchange', () => {
  applyViewportSize();
  requestAnimationFrame(applyViewportSize);
  setTimeout(applyViewportSize, 250);
});
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', applyViewportSize);
}

// ============================================================
// ASSET PRELOADER — laddar alla GLTF-modeller + animationer innan
// lobbyn blir spelbar. Loading-screen i index.html ligger ovanpå tills
// preloadAllAssets() är klar.
// ============================================================

const ASSET_BASE = './assets/';
const CHARACTER_ASSETS = {
  // Heroes (Adventurers-pack)
  knight:    'heroes/KayKit_Adventurers_2.0_FREE/KayKit_Adventurers_2.0_FREE/Characters/gltf/Knight.glb',
  mage:      'heroes/KayKit_Adventurers_2.0_FREE/KayKit_Adventurers_2.0_FREE/Characters/gltf/Mage.glb',
  ranger:    'heroes/KayKit_Adventurers_2.0_FREE/KayKit_Adventurers_2.0_FREE/Characters/gltf/Ranger.glb',
  barbarian: 'heroes/KayKit_Adventurers_2.0_FREE/KayKit_Adventurers_2.0_FREE/Characters/gltf/Barbarian.glb',
  rogue:     'heroes/KayKit_Adventurers_2.0_FREE/KayKit_Adventurers_2.0_FREE/Characters/gltf/Rogue.glb',
  // Skeletons (wave-monster + minions)
  skel_warrior: 'enemies/KayKit_Skeletons_1.1_FREE/KayKit_Skeletons_1.1_FREE/characters/gltf/Skeleton_Warrior.glb',
  skel_mage:    'enemies/KayKit_Skeletons_1.1_FREE/KayKit_Skeletons_1.1_FREE/characters/gltf/Skeleton_Mage.glb',
  skel_rogue:   'enemies/KayKit_Skeletons_1.1_FREE/KayKit_Skeletons_1.1_FREE/characters/gltf/Skeleton_Rogue.glb',
  skel_minion:  'enemies/KayKit_Skeletons_1.1_FREE/KayKit_Skeletons_1.1_FREE/characters/gltf/Skeleton_Minion.glb',
};
// Rig_Medium_*.glb innehåller animations-clips som matchar både hero- och
// skeleton-skeletten (samma rig-naming i KayKit-paken). Vi slår ihop alla
// clips per rig-grupp.
const ANIMATION_ASSETS = {
  hero_general:  'heroes/KayKit_Adventurers_2.0_FREE/KayKit_Adventurers_2.0_FREE/Animations/gltf/Rig_Medium/Rig_Medium_General.glb',
  hero_movement: 'heroes/KayKit_Adventurers_2.0_FREE/KayKit_Adventurers_2.0_FREE/Animations/gltf/Rig_Medium/Rig_Medium_MovementBasic.glb',
  skel_general:  'enemies/KayKit_Skeletons_1.1_FREE/KayKit_Skeletons_1.1_FREE/Animations/gltf/Rig_Medium/Rig_Medium_General.glb',
  skel_movement: 'enemies/KayKit_Skeletons_1.1_FREE/KayKit_Skeletons_1.1_FREE/Animations/gltf/Rig_Medium/Rig_Medium_MovementBasic.glb',
};

const loadedCharacters = new Map();   // name → { scene, animations }
const loadedAnimationClips = {        // rig-grupp → AnimationClip[]
  hero: [],
  skel: [],
};
let assetsReady = false;

async function preloadAllAssets() {
  console.log('[asset] preloadAllAssets START');
  const loader = new GLTFLoader();
  const charEntries = Object.entries(CHARACTER_ASSETS);
  const animEntries = Object.entries(ANIMATION_ASSETS);
  const total = charEntries.length + animEntries.length;
  let done = 0;
  const fillEl = document.getElementById('al-bar-fill');
  const statusEl = document.getElementById('al-status');
  const updateProgress = (label) => {
    done++;
    if (fillEl) fillEl.style.width = `${(done / total) * 100}%`;
    if (statusEl) statusEl.textContent = `${done} / ${total} · ${label}`;
    console.log(`[asset] ${done}/${total} ${label}`);
  };

  // Safety net: dölj loading-screen efter 45s oavsett, så lobbyn alltid blir nåbar
  const safetyTimer = setTimeout(() => {
    console.warn('[asset] 45s timeout — döljer loading-screen oavsett resultat');
    const al = document.getElementById('asset-loading');
    if (al) al.classList.add('hidden');
  }, 45000);

  const charPromises = charEntries.map(([name, path]) =>
    loader.loadAsync(ASSET_BASE + path).then(gltf => {
      loadedCharacters.set(name, { scene: gltf.scene, animations: gltf.animations || [] });
      gltf.scene.traverse(o => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = false;
          if (o.material && o.material.map) {
            o.material.map.magFilter = THREE.NearestFilter;
          }
        }
      });
      updateProgress(name);
    }).catch(err => {
      console.error(`[asset] Failed character ${name} (${path}):`, err);
      updateProgress(name + ' (FAILED)');
    })
  );
  const animPromises = animEntries.map(([name, path]) =>
    loader.loadAsync(ASSET_BASE + path).then(gltf => {
      const group = name.startsWith('hero_') ? 'hero' : 'skel';
      for (const clip of (gltf.animations || [])) {
        loadedAnimationClips[group].push(clip);
      }
      updateProgress(name);
    }).catch(err => {
      console.error(`[asset] Failed anim ${name} (${path}):`, err);
      updateProgress(name + ' (FAILED)');
    })
  );
  await Promise.all([...charPromises, ...animPromises]);
  clearTimeout(safetyTimer);
  assetsReady = true;
  if (statusEl) statusEl.textContent = `${total} / ${total} · klart`;
  console.log('[asset] preloadAllAssets DONE');
  setTimeout(() => {
    const al = document.getElementById('asset-loading');
    if (al) al.classList.add('hidden');
  }, 200);
}

// Hjälpfunktion: hämta en färsk klonad instans av en laddad karaktär
// (med eget skinned-skeleton via SkeletonUtils.clone) + AnimationMixer
// + actions för alla relevanta clips.
function instantiateCharacter(charName, animGroup) {
  const entry = loadedCharacters.get(charName);
  if (!entry) {
    console.warn(`[asset] Character ${charName} ej laddad — använder placeholder`);
    return null;
  }
  const clone = SkeletonUtils.clone(entry.scene);
  clone.traverse(o => {
    if (o.isMesh || o.isSkinnedMesh) {
      o.castShadow = true;
      o.receiveShadow = false;
      o.frustumCulled = false; // skinned meshes kan ha fel bounding box
    }
  });
  // Animations-clips: ta från animGroup-poolen + ev. inbäddade i karaktären
  const clips = [
    ...(loadedAnimationClips[animGroup] || []),
    ...entry.animations,
  ];
  const mixer = new THREE.AnimationMixer(clone);
  const actions = {};
  for (const clip of clips) {
    actions[clip.name] = mixer.clipAction(clip);
  }
  clone.userData.mixer = mixer;
  clone.userData.actions = actions;
  clone.userData.clipNames = Object.keys(actions);
  clone.userData.currentAction = null;
  clone.userData.gltfCharName = charName;
  return clone;
}

// Stega alla aktiva mixers — anropas från tick().
// Auto-rensar mixers vars root inte längre är i scenen (efter scene.remove).
const activeMixers = new Set();
function tickMixers(dt) {
  if (!activeMixers.size) return;
  const toRemove = [];
  for (const m of activeMixers) {
    let cur = m.getRoot();
    let inScene = false;
    while (cur) {
      if (cur === scene) { inScene = true; break; }
      cur = cur.parent;
    }
    if (!inScene) {
      toRemove.push(m);
      continue;
    }
    m.update(dt);
  }
  for (const m of toRemove) activeMixers.delete(m);
}

// Starta preload direkt vid sidladdning (medan resten av main.js körs)
preloadAllAssets();

// ============================================================
// STATIC SCENE (mark, väggar, lanes, baser, torn, ljus)
// ============================================================

const towerMeshes = {};         // mappar sida → fontän-rig (kvar i gamla namnet pga refs i renderloop)
const portalMeshes = {};        // mappar sida → portal-rig (klassisk line-wars PvP-portal, lvl-30-gated)
// Portal-konstanter (matchar server)
const PORTAL_POS = {
  1: { x: 26, z: 13 },
  2: { x: 26, z: -13 },
};
const PORTAL_REQUIRED_LEVEL = 30;
const PORTAL_ENTER_RADIUS = 1.3;
// Klient-tracking så vi inte spammar portal-events när hero står på portalen
const portalTrigger = { lastSentMs: 0 };
const campfires = {};           // sida → lägereld-rig (för flame-animation)
const FOUNTAIN_AURA_RADIUS = 4.5; // meter — närhet till egen fontän för aura
const FOUNTAIN_AURA_RADIUS_SQ = FOUNTAIN_AURA_RADIUS * FOUNTAIN_AURA_RADIUS;
const FOUNTAIN_AURA_REGEN_PCT = 0.03; // 3% av maxHp per sekund
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

  // === PORTAL-VISUAL (lvl 30, lane-wars PvP-portal) ===
  function makePortal(cx, cz, color) {
    const grp = new THREE.Group();
    // Bas-platta
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x2a2438, roughness: 0.7, metalness: 0.4 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.4, 0.18, 24), baseMat);
    base.position.y = 0.09;
    base.castShadow = true;
    base.receiveShadow = true;
    grp.add(base);
    // Stående ring (kärna)
    const ringMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.6, metalness: 0.6, roughness: 0.25 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.10, 14, 36), ringMat);
    ring.position.y = 1.2;
    ring.rotation.x = Math.PI / 2;
    grp.add(ring);
    // Inre energi-disk (semi-transparent)
    const diskMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
    const disk = new THREE.Mesh(new THREE.CircleGeometry(0.85, 28), diskMat);
    disk.position.y = 1.2;
    disk.rotation.x = Math.PI / 2;
    grp.add(disk);
    // Yttre halo
    const haloMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.30, side: THREE.DoubleSide, depthWrite: false });
    const halo = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.20, 12, 32), haloMat);
    halo.position.y = 1.2;
    halo.rotation.x = Math.PI / 2;
    grp.add(halo);
    // Glow-light
    const light = new THREE.PointLight(color, 1.8, 6, 2);
    light.position.set(0, 1.5, 0);
    grp.add(light);
    // Mark-aura (cirkel på marken)
    const ground = new THREE.Mesh(
      new THREE.RingGeometry(1.0, 1.4, 28),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0.20;
    grp.add(ground);
    grp.position.set(cx, 0, cz);
    scene.add(grp);
    return { group: grp, ring, disk, halo, light, ground };
  }
  portalMeshes[1] = makePortal(26, 13, 0x66ccff);     // sida 1 portal i hörnet bakom torn
  portalMeshes[2] = makePortal(26, -13, 0xff6688);    // sida 2 portal

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
    const radius = 14.4;  // 20% större (12 × 1.2)
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
    const blocks = 32;
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
  const hemi = new THREE.HemisphereLight(0xc4dcff, 0x3a2b1a, 0.45);
  hemi.position.set(0, 50, 0);
  scene.add(hemi);

  // Sol: varm directional med skuggor — primärt nyckel-ljus från fram-höger
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.55);
  sun.position.set(18, 28, 14);
  sun.castShadow = true;
  // 1024 istället för 2048: 4× mindre GPU-minne (4 MB → 16 MB), märkbart
  // snabbare shadow-pass på mobil/low-end. Visuell skillnad ej synlig vid
  // spel-zoom (top-down isometrisk).
  sun.shadow.mapSize.width = 1024;
  sun.shadow.mapSize.height = 1024;
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 28;
  sun.shadow.camera.bottom = -28;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 70;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);

  // Bak-rim: kall ton bakifrån för att lyfta silhuetter (MLBB-stil rim-light)
  const rim = new THREE.DirectionalLight(0x88b0e6, 0.85);
  rim.position.set(-12, 16, -22);
  scene.add(rim);

  // Fyll-ljus från motsatt sida (mjukar upp skugg-skuggorna utan att kasta nya)
  const fill = new THREE.DirectionalLight(0xffd9a8, 0.35);
  fill.position.set(-18, 14, 10);
  scene.add(fill);

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
  // 3 & 4: placeholders för 2v2 arena (classic-fält används aldrig för dessa)
  3: {
    arenaSign: 1, laneZ: { 1: 12, 2: 4 }, oppLaneZ: { 1: -4, 2: -12 },
    spawnX: -27, baseZRange: [0.5, 14.55], tower: { x: 24, z: 8 },
    heroSpawn: { x: 15, z: 8 },
    heroColor: 0xffaa33, gruntColor: 0x66aaff, gruntEmissive: 0x223366,
  },
  4: {
    arenaSign: -1, laneZ: { 1: -4, 2: -12 }, oppLaneZ: { 1: 12, 2: 4 },
    spawnX: -27, baseZRange: [-14.55, -0.5], tower: { x: 24, z: -8 },
    heroSpawn: { x: 15, z: -8 },
    heroColor: 0x66ddff, gruntColor: 0xff6644, gruntEmissive: 0x442211,
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
  aragurn: { name: 'Aragurn', baseHp: 130, baseDmg: 8, attackRange: 2.8, attackInterval: 1.1, baseMoveSpeed: 5.5 },
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

// ===== BOSS DEFS =====
// 5 bossar (wave 10,20,30,40,50) med 3 skills var. Skills bygger på primitive-typer
// som hanteras av startBossCast/tickBossCast. Svårighet skalar med wave (snabbare
// CDs + fler hits + svårare patterns).
// Mini-bossar i vanliga waves använder 1 av kommande bossens 3 skills.
const BOSS_DEFS = {
  10: {
    name: 'Captain', scale: 3.5,
    bodyTint: 0x6a85a8, auraColor: 0x1a2434, eyeColor: 0xff5533,
    intro: 'Klubbväggen marscherar.',
    skills: [
      // Shield Bash — telegraph röd linje, sen dasha 11m fram + skada allt i linjen
      { id: 'shieldBash', kind: 'lineDash', telegraph: 1.4, length: 11, width: 3.2, execTime: 0.5, dmgMul: 2.2, cd: 7.5 },
      // Throwing Axe — skillshot
      { id: 'throwingAxe', kind: 'projectile', telegraph: 0.5, speed: 14, dmgMul: 1.8, radius: 1.0, range: 18, cd: 5.0 },
      // Battle Roar — 7m AoE runt boss
      { id: 'battleRoar', kind: 'groundCircle', telegraph: 1.4, radius: 7.5, dmgMul: 1.6, originSelf: true, slow: { dur: 2.5, mul: 0.5 }, cd: 9.0 },
    ],
  },
  20: {
    name: 'General', scale: 3.8,
    bodyTint: 0x886a40, auraColor: 0x2a1c08, eyeColor: 0xffaa44,
    intro: 'Krigsorder ekar över slagfältet.',
    skills: [
      // Lightning Strike — targetar hjältens nuvarande position
      { id: 'lightningStrike', kind: 'groundCircle', telegraph: 1.0, radius: 4.2, dmgMul: 2.4, targetHero: true, cd: 5.5 },
      // Spear Volley — 3 spjut i kon-spread
      { id: 'spearVolley', kind: 'projectileMulti', telegraph: 0.7, count: 4, spreadAngle: Math.PI / 6, speed: 18, dmgMul: 1.6, radius: 1.0, range: 18, cd: 6.5 },
      // War Stomp — STOR AoE runt boss
      { id: 'warStomp', kind: 'groundCircle', telegraph: 1.3, radius: 9, dmgMul: 2.0, originSelf: true, knockback: 3.5, cd: 10.0 },
    ],
  },
  30: {
    name: 'Warlord', scale: 4.1,
    bodyTint: 0xaa4030, auraColor: 0x331008, eyeColor: 0xffbb00,
    intro: 'Marken sviktar under hans steg.',
    skills: [
      // Cleave Wave — 90° kon framför boss, 12m lång
      { id: 'cleaveWave', kind: 'cone', telegraph: 1.0, length: 12, halfAngle: Math.PI / 3, dmgMul: 2.6, cd: 6.0 },
      // Poison Pool — kastas på hjältens pos, lämnar DoT-pöl 7s
      { id: 'poisonPool', kind: 'poolDot', telegraph: 1.0, radius: 4.5, duration: 7, dpsMul: 0.6, slow: { dur: 0.8, mul: 0.6 }, targetHero: true, cd: 7.5 },
      // Earthquake — 6 random AoE-cirklar runt boss
      { id: 'earthquake', kind: 'multiCircle', telegraph: 0.7, count: 6, spawnInterval: 0.5, radius: 3.5, dmgMul: 1.7, spread: 9, cd: 11.0 },
    ],
  },
  40: {
    name: 'Demon Prince', scale: 4.4,
    bodyTint: 0x5a30a0, auraColor: 0x180830, eyeColor: 0xff44ff,
    intro: 'Helvetet öppnar sina portar.',
    skills: [
      // Hellfire Beam — roterande sweep-beam
      { id: 'hellfireBeam', kind: 'sweepBeam', telegraph: 1.3, sweepDuration: 2.2, length: 16, halfAngle: Math.PI / 1.8, dpsMul: 1.8, cd: 10.0 },
      // Inferno Strike — snabb hero-targetad
      { id: 'infernoStrike', kind: 'groundCircle', telegraph: 0.8, radius: 3.2, dmgMul: 2.8, targetHero: true, leaveBurn: true, cd: 5.0 },
      // Meteor Shower — 6 meteorer i 4s
      { id: 'meteorShower', kind: 'multiCircle', telegraph: 0.9, count: 6, spawnInterval: 0.7, radius: 4.5, dmgMul: 2.4, spread: 13, cd: 13.0 },
    ],
  },
  50: {
    name: 'Drakkonungen', scale: 4.8,
    bodyTint: 0x2a1a1a, auraColor: 0x080404, eyeColor: 0xff7700,
    intro: 'Drakelden brinner ikapp natten.',
    skills: [
      // Dragon Breath — sustained kon-flam 2.5s, bredare
      { id: 'dragonBreath', kind: 'sustainedCone', telegraph: 1.3, sustainDuration: 2.8, length: 16, halfAngle: Math.PI / 2.8, dpsMul: 2.0, cd: 8.5 },
      // Wing Slam — STOR AoE runt med knockback
      { id: 'wingSlam', kind: 'groundCircle', telegraph: 1.0, radius: 7.5, dmgMul: 3.0, originSelf: true, knockback: 5.0, cd: 7.0 },
      // Skyfire Rain — 10 meteorer i 6s
      { id: 'skyfireRain', kind: 'multiCircle', telegraph: 0.7, count: 10, spawnInterval: 0.6, radius: 4.0, dmgMul: 2.2, spread: 15, cd: 15.0 },
    ],
  },
};

// Mappa wave-num → vilken boss kommer härnäst (för mini-bossar)
function getNextBossDef(waveNum) {
  if (waveNum % 10 === 0) return null;   // boss-wave själv
  if (waveNum >= MAX_WAVES) return null;
  const nextBossWave = (Math.floor((waveNum - 1) / 10) + 1) * 10;
  return BOSS_DEFS[nextBossWave] || null;
}

// ===== BOSS WARS — dedikerade RAID-bossar, co-op upp till 3 spelare =====
// Återanvänder BOSS_DEFS (samma 5 bossar som i wave-systemet) men med MASSIVT
// skalade HP/dmg för raid-känsla. Bossar 1–3 har 2 phases: vid 50% HP knockback +
// stun, bossen flyger upp + landar med NYA skills (revealas live, inte i beskrivning).
const BOSS_WARS_DEFS = [
  {
    tier: 1, wave: 10, name: 'Captain', diff: 'Easy', diffClass: 'easy',
    desc: 'En klubb-wieldande veteran från fronten. Förlitar sig på direkta attacker. Bra att börja med — men gå inte in oförberedd, han har en överraskning vid 50% HP.',
    hp: 5000, dmgScale: 1.5, hasPhase2: true, phaseThreshold: 0.5,
  },
  {
    tier: 2, wave: 20, name: 'General', diff: 'Medium', diffClass: 'medium',
    desc: 'Krigsstrateg som blandar ranged-attacker med AoE-stomp. Mer aggressiv än Captain. Räkna med att läget förändras mid-fight.',
    hp: 8000, dmgScale: 1.8, hasPhase2: true, phaseThreshold: 0.5,
  },
  {
    tier: 3, wave: 30, name: 'Warlord', diff: 'Hard', diffClass: 'hard',
    desc: 'Brutal närstrid + poison-zoner som denyar terräng. Tål mycket och slår hårt. Något säger oss att han inte stannar på samma skill-set hela fighten...',
    hp: 13000, dmgScale: 2.2, hasPhase2: true, phaseThreshold: 0.5,
  },
  {
    tier: 4, wave: 40, name: 'Demon Prince', diff: 'Extreme', diffClass: 'extreme',
    desc: 'Hellfire-magiker med roterande beam-attacker och meteor-bombardemang. Punishar dålig positionering hårt — straffar en miss med en stor HP-bit. Något ondskefullt aktiveras vid 30% HP.',
    hp: 20000, dmgScale: 2.8, hasPhase2: true, phaseThreshold: 0.3,
  },
  {
    tier: 5, wave: 50, name: 'Drakkonungen', diff: 'Nightmare', diffClass: 'nightmare',
    desc: 'Drak-kungen. Sustained kon-flam, AoE-knockback och ständigt fallande meteorer. Ultimate raid-test — räkna med 5+ minuter om ditt team är skickliga. När han når 30% HP utlöses apokalypsen.',
    hp: 30000, dmgScale: 3.5, hasPhase2: true, phaseThreshold: 0.3,
  },
];

// Phase 2 skill-sets för bossar 1, 2, 3. Bossen byter helt skill-array vid 50% HP.
// Nya skills behåller telegraph-feel men är hårdare/mer komplexa.
const BOSS_WARS_PHASE2_SKILLS = {
  10: [   // Captain Phase 2 — full berserk
    { id: 'berserkerCharge', kind: 'lineDash', telegraph: 0.9, length: 14, width: 3.5, execTime: 0.5, dmgMul: 3.0, cd: 5.5 },
    { id: 'whirlwindStrike', kind: 'groundCircle', telegraph: 1.0, radius: 6.5, dmgMul: 1.8, originSelf: true, slow: { dur: 1.8, mul: 0.5 }, cd: 6.5 },
    { id: 'warCry', kind: 'groundCircle', telegraph: 1.6, radius: 13, dmgMul: 2.2, originSelf: true, knockback: 3.0, cd: 12.0 },
  ],
  20: [   // General Phase 2 — storm + artillery
    { id: 'stormCall', kind: 'multiCircle', telegraph: 0.8, count: 10, spawnInterval: 0.4, radius: 4.0, dmgMul: 1.8, spread: 11, cd: 13.0 },
    { id: 'heavyArtillery', kind: 'projectileMulti', telegraph: 0.6, count: 6, spreadAngle: Math.PI / 4, speed: 20, dmgMul: 2.0, radius: 1.2, range: 22, cd: 7.5 },
    { id: 'shieldWall', kind: 'groundCircle', telegraph: 1.0, radius: 10, dmgMul: 2.4, originSelf: true, knockback: 4.5, cd: 9.0 },
  ],
  30: [   // Warlord Phase 2 — tectonic + toxic
    { id: 'tectonicSlam', kind: 'groundCircle', telegraph: 1.2, radius: 13, dmgMul: 3.0, originSelf: true, knockback: 3.0, cd: 10.0 },
    { id: 'toxicCloud', kind: 'poolDot', telegraph: 0.9, radius: 7, duration: 9, dpsMul: 0.8, slow: { dur: 1.2, mul: 0.5 }, targetHero: true, cd: 8.0 },
    { id: 'boulderHurl', kind: 'projectile', telegraph: 0.5, speed: 22, dmgMul: 2.6, radius: 2.0, range: 26, cd: 5.5 },
  ],
  40: [   // Demon Prince Phase 2 — full helvete-läge
    { id: 'demonicEruption', kind: 'multiCircle', telegraph: 0.8, count: 10, spawnInterval: 0.4, radius: 5, dmgMul: 2.8, spread: 15, cd: 12.0 },
    { id: 'soulBurn', kind: 'poolDot', telegraph: 0.7, radius: 8, duration: 10, dpsMul: 1.0, slow: { dur: 1.5, mul: 0.5 }, targetHero: true, cd: 7.0 },
    { id: 'hellfireStorm', kind: 'sweepBeam', telegraph: 1.0, sweepDuration: 3.0, length: 20, halfAngle: Math.PI / 1.6, dpsMul: 2.2, cd: 9.0 },
  ],
  50: [   // Drakkonungen Phase 2 — apokalyps
    { id: 'infernalRoar', kind: 'groundCircle', telegraph: 1.1, radius: 14, dmgMul: 3.5, originSelf: true, knockback: 6.0, cd: 8.5 },
    { id: 'dragonDive', kind: 'lineDash', telegraph: 0.8, length: 22, width: 4.0, execTime: 0.6, dmgMul: 4.0, cd: 7.0 },
    { id: 'meteorApocalypse', kind: 'multiCircle', telegraph: 0.6, count: 16, spawnInterval: 0.35, radius: 4.5, dmgMul: 2.8, spread: 18, cd: 14.0 },
  ],
};

// Hämta boss-def + skalad data för en given tier (1-5)
function getBossWarsDef(tier) {
  return BOSS_WARS_DEFS.find(b => b.tier === tier) || BOSS_WARS_DEFS[0];
}

// ===== BOSS WARS — 10 TALENTS + 10 ITEMS för prep-fasen =====
// Spelaren väljer 3 talents + 4 items innan striden. Talents stackar
// stats additivt via recomputeSideStats. Items läggs i side.inventory.
const BOSS_WARS_TALENTS = [
  { id: 'bwt_hp',       icon: '💪', name: 'Iron Body',          desc: '+25% max HP',                stats: { maxHpPct: 0.25 } },
  { id: 'bwt_as',       icon: '⚡', name: 'Quick Strikes',       desc: '+20% attack speed',          stats: { attackSpeedPct: 0.20 } },
  { id: 'bwt_dmg',      icon: '⚔', name: 'Sharp Edge',          desc: '+12 attack damage',          stats: { attackDmg: 12 } },
  { id: 'bwt_skill',    icon: '✨', name: 'Spellcraft',          desc: '+20% skill damage',          stats: { skillDmgPct: 0.20 } },
  { id: 'bwt_cdr',      icon: '⏱', name: 'Cooldown Mastery',    desc: '+15% cooldown reduction',    stats: { cdrPct: 0.15 } },
  { id: 'bwt_dr',       icon: '🛡', name: 'Iron Skin',           desc: '+18% damage reduction',      stats: { dmgReductionPct: 0.18 } },
  { id: 'bwt_ls',       icon: '🩸', name: 'Bloodthirst',         desc: '+12% lifesteal på AA',       stats: {} /* applied via aaLifestealPct */, lifestealOnAa: 0.12 },
  { id: 'bwt_crit',     icon: '🎯', name: 'Crit Master',         desc: '+15% crit chans, +25% crit dmg', stats: { critChancePct: 0.15 } /* crit dmg appliceras separat */, critDmgBonus: 0.25 },
  { id: 'bwt_ms',       icon: '💨', name: 'Swift Runner',        desc: '+15% rörelsehastighet',      stats: { moveSpeedPct: 0.15 } },
  { id: 'bwt_heal',     icon: '✚', name: 'Healing Aura',        desc: '+2% maxHP regen per sekund', stats: { healPerSecPct: 0.02 } },
];

// 10 nya items för Boss Wars. Varje item är en upgrad-version som ges direkt
// (ingen guld-kostnad — användaren väljer 4 stycken).
const BOSS_WARS_ITEMS = [
  { id: 'bwi_blade',    icon: '🗡', name: 'Slayer Blade',         desc: '+15 AA dmg + 15% AS',         stats: { attackDmg: 15, attackSpeedPct: 0.15 } },
  { id: 'bwi_helm',     icon: '⛑', name: 'Helm of Vitality',     desc: '+35% maxHP',                  stats: { maxHpPct: 0.35 } },
  { id: 'bwi_boots',    icon: '👢', name: 'Boots of Haste',       desc: '+25% rörelsehastighet',       stats: { moveSpeedPct: 0.25 } },
  { id: 'bwi_cape',     icon: '🧥', name: 'Cape of Wards',        desc: '+20% damage reduction',       stats: { dmgReductionPct: 0.20 } },
  { id: 'bwi_amulet',   icon: '🔮', name: 'Amulet of Power',      desc: '+30% skill damage',           stats: { skillDmgPct: 0.30 } },
  { id: 'bwi_ring',     icon: '💍', name: 'Ring of Mastery',      desc: '+20% CDR + 15% AS',           stats: { cdrPct: 0.20, attackSpeedPct: 0.15 } },
  { id: 'bwi_tome',     icon: '📖', name: 'Tome of Arcana',       desc: '+35% skill dmg + 15% maxHP',  stats: { skillDmgPct: 0.35, maxHpPct: 0.15 } },
  { id: 'bwi_gauntlet', icon: '🥊', name: 'Berserker Gauntlet',   desc: '+18 AA dmg + 15% lifesteal',  stats: { attackDmg: 18 }, lifestealOnAa: 0.15 },
  { id: 'bwi_crit',     icon: '💎', name: 'Crystal Eye',          desc: '+25% crit chans + 35% crit dmg', stats: { critChancePct: 0.25 }, critDmgBonus: 0.35 },
  { id: 'bwi_phoenix',  icon: '🔥', name: 'Phoenix Amulet',       desc: 'Revive en gång vid 50% HP (engångs)', stats: { maxHpPct: 0.10 }, phoenixRevive: true },
];
// Mini-bossar spawnar bara på jämna waves (2,4,6,8 / 12,14,16,18 / etc).
// Skill-rotation per tier: 1:a even-waven i tier → skill 0, 2:a → 1, 3:e → 2, 4:e → 0.
function shouldSpawnMiniBoss(waveNum) {
  if (waveNum % 10 === 0) return false;  // boss-wave
  if (waveNum % 2 !== 0) return false;   // bara jämna waves
  return true;
}
function getMiniBossSkillIdx(waveNum) {
  const waveInTier = ((waveNum - 1) % 10) + 1;   // 1..9 inom varje tier
  return Math.floor((waveInTier - 2) / 2) % 3;
}

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

// Boss Wars: skala %-max-HP-skador 10× ner mot själva bossen.
// Anledning: bossens HP är så hög att en 5%-skill annars knockar 5% i en cast,
// vilket bryter balansen för en raid. AA + flat-damage förblir oförändrad.
// Användning: vid varje call-site där dmg = target.maxHp * KONSTANT_DMG_PCT,
// multiplicera med bossWarsPctScale(target).
const BOSS_WARS_PCT_SCALE = 0.1;
function bossWarsPctScale(target) {
  if (APP.gameMode !== 'bosswars') return 1;
  return (target && target.isBossWarsBoss) ? BOSS_WARS_PCT_SCALE : 1;
}
const MONSTER_XP_REWARD = 10;
const CREEP_XP_RATIO = 0.6;

// Creep-projektil-hastigheter
const ARROW_SPEED = 14;
const MAGIC_PROJ_SPEED = 10;

// Gandulf-skills omskrivna — Soul Drain / Frost Nova target / Black Hole

// Soul Drain (Q): target-baserad channel. 5s, varje sek 5% av targets maxHP i skada
// + self-heal Gandulf samma mängd. 10% slow per sek (max 5 stacks = 50%). Slow
// ligger kvar 1s efter sista tick. Bryts om target dör eller springer >12m.
// Om en minion dör av drain → explosion AoE = 50% av damage dealt.
const SOULDRAIN_DURATION = 5.0;
const SOULDRAIN_TICK = 1.0;
const SOULDRAIN_DMG_PCT = 0.05;
const SOULDRAIN_SLOW_PER_STACK = 0.10;
const SOULDRAIN_MAX_STACKS = 5;
const SOULDRAIN_SLOW_TAIL = 1.0;
const SOULDRAIN_RANGE = 10.0;        // max räckvidd vid cast
const SOULDRAIN_BREAK_RANGE = 12.0;  // bryt-range under channel
const SOULDRAIN_EXPLOSION_RADIUS = 3.5;
const SOULDRAIN_EXPLOSION_DMG_PCT = 0.50;   // 50% av damage dealt
const SOULDRAIN_PARTICLE_INTERVAL = 0.06;   // sek mellan soul-puffs längs beamen
const FIREWAVE_LENGTH = 5;
const FIREWAVE_HALF_ANGLE = Math.PI / 4;
const FIREWAVE_DIRECT_DMG = 18;
const FIREWAVE_DOT_DPS = 6;
const FIREWAVE_DOT_DURATION = 3.0;
const FIREWAVE_EFFECT_LIFE = 0.6;
const NOVA_RADIUS = 3.8 * 1.3 * 0.8;       // +30% → -20% = 4.94 → 3.95
const NOVA_DAMAGE = 10;
const NOVA_FREEZE_TIME = 2.0;
const NOVA_CAST_DISTANCE = 6 * 1.3 * 0.8;  // +30% → -20% = 7.8 → 6.24
const SHATTER_RADIUS = 2.5;
const SHATTER_DAMAGE = 15;
const BLACKHOLE_RADIUS = 3.5 * 1.3 * 0.8;       // +30% → -20% = 4.55 → 3.64
const BLACKHOLE_PULL_SPEED = 2.5;
const BLACKHOLE_DURATION = 3.0;
const BLACKHOLE_EXPLOSION_RADIUS = 4.0;
const BLACKHOLE_EXPLOSION_DMG = 30;
const BLACKHOLE_CAST_DISTANCE = 8 * 1.3 * 0.8;  // +30% → -20% = 10.4 → 8.32
// Legolus
const VINE_TRAP_RADIUS = 3.0 * 1.3 * 0.8;        // +30% → -20% = 3.9 → 3.12
const VINE_TRAP_DURATION = 3.0;
const VINE_TRAP_DOT_DPS = 8;
const VINE_TRAP_CAST_DISTANCE = 7 * 1.3 * 0.8;   // +30% → -20% = 9.1 → 7.28
const VINE_TRAP_ROOT_REFRESH = 0.25;
const LEGOLUS_BUFF_DURATION = 5.0;
const LEGOLUS_BUFF_DMG_PCT = 0.10;
const LEGOLUS_BUFF_CRIT_PCT = 0.10;
const LEGOLUS_BUFF_CRIT_DMG_PCT = 0.30;
const LEGOLUS_BUFF_AS_PCT = 0.30;          // Hunter's Focus: +30% attack speed under buff
const LEGOLUS_DASH_DISTANCE = 4.0;
const LEGOLUS_DASH_LIFESTEAL = 0.20;
const LEGOLUS_PASSIVE_EVERY = 3;
const LEGOLUS_SPLIT_EXTRAS = 2;
const LEGOLUS_SPLIT_RANGE = 6;
const POISON_DURATION = 4.0;
const POISON_BASE_DPS = 5;
// Gimlu
const TAUNT_RADIUS = 5.5;
const TAUNT_DURATION = 3.0;
const TAUNT_DMG_REDUCTION = 0.30;
const TAUNT_HEAL_PCT = 0.20;
const TAUNT_HEAL_PER_SEC = 0.20;
const IRON_WILL_DURATION = 3.0;
const IRON_WILL_EXPLOSION_RADIUS = 6.0;
const HAMMER_SPEED = 12;
const HAMMER_RANGE = 9 * 1.3;        // +30% kast-range
const HAMMER_RADIUS = 0.8;
const HAMMER_DAMAGE = 25;
const HAMMER_LIFESTEAL = 0.50;
const HAMMER_RETURN_DMG_MUL = 0.5;
// Gimlu passive (Stalwart Resolve)
const GIMLU_PASSIVE_TIER1_HP = 0.80;
const GIMLU_PASSIVE_TIER1_DR = 0.10;       // var 0.20 — nerf 50%
const GIMLU_PASSIVE_TIER2_HP = 0.60;
const GIMLU_PASSIVE_TIER2_REGEN = 0.025;   // var 0.05 — nerf 50%
const GIMLU_PASSIVE_TIER3_HP = 0.40;
const GIMLU_PASSIVE_TIER3_DR = 0.10;       // var 0.20 — nerf 50%
const GIMLU_PASSIVE_IMMUNE_EVERY = 6;      // var 3 — nerf 50% (hälften så ofta immun)
// Gandulf passive
const GANDULF_BUFF_DURATION = 3.0;
const GANDULF_BUFF_SKILL_DMG_PER_STACK = 0.05;
const GANDULF_SHIELD_PER_HIT_PCT = 0.05;
const GANDULF_SHIELD_HITS = 3;
const GANDULF_SHIELD_PCT = 0.30;
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
  // Arena: hero rör sig fritt inom arena-bounds men inte genom cover-props
  if (APP.gameMode === 'arena1v1') {
    const b = ARENA_CFG.bounds;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return false;
    if (isArenaCoverAt(x, z)) return false;
    return true;
  }
  // Boss Wars: cirkulär platform, fri rörelse inom radius
  if (APP.gameMode === 'bosswars') {
    return isBossWarsPos(x, z);
  }
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
  // Canvas = 100 × 28 = HP-rad (rad 1) + Shield-rad (rad 2). Höjd-skalan dubblas.
  canvas.width = 100; canvas.height = 28;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  // Hero HP-bar förstorad (HUD-omfördelning — hero-HP visas nu primärt här).
  sprite.scale.set(hero ? 1.9 : 0.85, hero ? 0.52 : 0.26, 1);
  sprite.renderOrder = 999;
  sprite.userData.canvas = canvas;
  sprite.userData.tex = tex;
  sprite.userData.lastPct = -1;
  sprite.userData.lastShieldPct = -1;
  return sprite;
}

function drawHpBar(sprite, pct, shieldPct = 0) {
  pct = Math.max(0, Math.min(1, pct));
  shieldPct = Math.max(0, Math.min(1, shieldPct));
  if (Math.abs(pct - sprite.userData.lastPct) < 0.004 &&
      Math.abs(shieldPct - sprite.userData.lastShieldPct) < 0.004) return;
  sprite.userData.lastPct = pct;
  sprite.userData.lastShieldPct = shieldPct;
  const ctx = sprite.userData.canvas.getContext('2d');
  ctx.clearRect(0, 0, 100, 28);
  // HP-rad (rad 1, y=0-13)
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, 0, 100, 13);
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, 99, 12);
  ctx.fillStyle = pct > 0.35 ? '#2bd054' : (pct > 0.15 ? '#d5a52a' : '#d04a2a');
  ctx.fillRect(1.5, 1.5, 97 * pct, 10);
  // Shield-rad (rad 2, y=14-27) — bara om shieldPct > 0
  if (shieldPct > 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 15, 100, 13);
    ctx.strokeStyle = 'rgba(170,200,255,0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 15.5, 99, 12);
    // Ljusblå shield-bar
    ctx.fillStyle = '#7ec4ff';
    ctx.fillRect(1.5, 16.5, 97 * shieldPct, 10);
    // Inre highlight (toppen 3px)
    ctx.fillStyle = 'rgba(220,240,255,0.55)';
    ctx.fillRect(1.5, 16.5, 97 * shieldPct, 3);
  }
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

function updateEntityHpBar(mesh, hp, maxHp, now, shield = 0) {
  if (!mesh?.userData?.hpBar) return;
  const bar = mesh.userData.hpBar;
  const prev = mesh.userData.prevHp;
  if (prev !== undefined && hp < prev) mesh.userData.lastHurtTime = now;
  mesh.userData.prevHp = hp;
  const pct = maxHp > 0 ? hp / maxHp : 0;
  // Shield mäts ALLTID mot maxHp så halvbar = 50% av max-HP absorberat
  const shieldPct = maxHp > 0 ? Math.max(0, shield) / maxHp : 0;
  const damaged = (now - (mesh.userData.lastHurtTime || -10)) < 3.0;
  const lowHp = pct < 1.0;
  const showAlways = !!mesh.userData.hpBarHero;
  bar.visible = (showAlways || damaged || lowHp || shieldPct > 0) && pct > 0;
  if (bar.visible) drawHpBar(bar, pct, shieldPct);
}

function tickAllHpBars() {
  const now = performance.now() / 1000;
  // Heroes — skicka in shield så HP-baren ritar shield-raden
  for (const idx of [1, 2, 3, 4]) {
    const s = sides[idx];
    if (!s || !s.mesh) continue;
    const shieldTotal = (s.shield || 0) + (s.lingShieldHp || 0);
    updateEntityHpBar(s.mesh, s.hero.hp, s.hero.maxHp, now, shieldTotal);
    if (s.mesh.userData.hpBar) s.mesh.userData.hpBar.visible = !s.hero.dead && s.mesh.userData.hpBar.visible;
  }
  if (APP.mode === 'solo') {
    for (const idx of [1, 2]) {
      const s = sides[idx];
      if (!s) continue;
      for (const m of s.monsters) updateEntityHpBar(m.mesh, m.hp, m.maxHp || 10, now);
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
  const legH = opts.legH ?? 0.34;        // total ben-cylinder-längd (kvar för bakåtkompatibel höjdberäkning)
  const armR = opts.armR ?? 0.085;
  const armH = opts.armH ?? 0.36;
  const torsoR = opts.torsoR ?? 0.21;
  const torsoH = opts.torsoH ?? 0.46;
  const headR = opts.headR ?? 0.17;
  const torsoShape = opts.torsoShape || 'capsule'; // 'capsule' | 'cylinder'
  const useShoulderCaps = opts.shoulderCaps !== false; // axel-deltoider om inte opt-out

  // Höft-höjd = total ben-längd (samma formel som tidigare så alla anchor-positioner stämmer)
  const totalLegLen = legH + legR * 2;
  const hipY = totalLegLen;
  const torsoBottom = hipY;
  const torsoCenterY = torsoBottom + torsoH / 2 + (torsoShape === 'capsule' ? torsoR : 0);
  const torsoTopY = torsoCenterY + torsoH / 2 + (torsoShape === 'capsule' ? torsoR : 0);
  const shoulderY = torsoTopY - 0.05;
  const headY = torsoTopY + headR + 0.04;

  // ----- Segmenterade ben med knä + fot -----
  // Splittar totala benlängden i: lår (46%) + underben (42%) + fot (12%).
  // Höft-pivoten (rig.leftLeg / rightLeg) är samma API som förut — animeringen
  // roterar den för hip-swing. Knä-pivoten (rig.leftLegLower / rightLegLower) är
  // child av lår-pivoten och möjliggör knäböj under steg-cykeln.
  const upperLegLen = totalLegLen * 0.46;
  const lowerLegLen = totalLegLen * 0.42;
  const footH = totalLegLen - upperLegLen - lowerLegLen;

  function makeLeg(side) {
    // Lår-pivot vid höften
    const upperPivot = new THREE.Group();
    upperPivot.position.set(side * (legR + 0.03), hipY, 0);

    // Lår (cylinder som tapar mot knäet)
    const upperLeg = new THREE.Mesh(
      new THREE.CylinderGeometry(legR * 1.10, legR * 0.90, upperLegLen, 14),
      legMat
    );
    upperLeg.position.y = -upperLegLen / 2;
    upperPivot.add(upperLeg);

    // Höft-rundning (lite muskeldefinition uppe)
    const hipKnob = new THREE.Mesh(
      new THREE.SphereGeometry(legR * 1.15, 10, 8),
      legMat
    );
    hipKnob.position.y = -0.02;
    hipKnob.scale.set(1, 0.7, 1);
    upperPivot.add(hipKnob);

    // Knä-led (sfärisk leddel)
    const knee = new THREE.Mesh(
      new THREE.SphereGeometry(legR * 0.95, 12, 10),
      legMat
    );
    knee.position.y = -upperLegLen;
    upperPivot.add(knee);

    // Underben-pivot vid knäet
    const lowerPivot = new THREE.Group();
    lowerPivot.position.y = -upperLegLen;
    upperPivot.add(lowerPivot);

    // Underben (smalnar mot ankeln)
    const lowerLeg = new THREE.Mesh(
      new THREE.CylinderGeometry(legR * 0.88, legR * 0.68, lowerLegLen, 12),
      legMat
    );
    lowerLeg.position.y = -lowerLegLen / 2;
    lowerPivot.add(lowerLeg);

    // Ankel/fot — pivot vid ankeln så animation kan tilta foten oberoende
    const footPivot = new THREE.Group();
    footPivot.position.y = -lowerLegLen;
    lowerPivot.add(footPivot);

    const foot = new THREE.Mesh(
      new THREE.BoxGeometry(legR * 1.8, footH * 1.2, legR * 2.8),
      legMat
    );
    foot.position.set(0, -footH * 0.45, legR * 0.55);
    foot.castShadow = true;
    footPivot.add(foot);

    grp.add(upperPivot);
    return { upper: upperPivot, lower: lowerPivot, footPivot, foot };
  }
  const leftLegInfo = makeLeg(-1);
  const rightLegInfo = makeLeg(1);

  // ----- Torso (cylinder med taper för bredare bröst, smalare midja) -----
  let torsoGeo;
  if (torsoShape === 'capsule') {
    torsoGeo = new THREE.CapsuleGeometry(torsoR, torsoH, 6, 14);
  } else {
    torsoGeo = new THREE.CylinderGeometry(torsoR * 1.05, torsoR * 0.82, torsoH, 16);
  }
  const torso = new THREE.Mesh(torsoGeo, bodyMat);
  torso.position.y = torsoCenterY;
  grp.add(torso);

  // ----- Hals (kort cylinder mellan torso och huvud) -----
  const neckR = headR * 0.55;
  const neckLen = 0.06;
  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(neckR, neckR * 1.15, neckLen, 12),
    skinMat
  );
  neck.position.y = torsoTopY + neckLen / 2;
  grp.add(neck);

  // ----- Axel-deltoider (mjukar upp lego-kanten mellan torso och armar) -----
  if (useShoulderCaps) {
    for (const sx of [-1, 1]) {
      const sh = new THREE.Mesh(
        new THREE.SphereGeometry(armR * 1.55, 12, 10),
        bodyMat
      );
      sh.position.set(sx * (torsoR + armR * 0.35), shoulderY + 0.02, 0);
      sh.scale.set(1.05, 0.95, 1);
      sh.castShadow = true;
      grp.add(sh);
    }
  }

  // ----- Armar (single-segment så vapen/dekorations-anchors fortsätter fungera) -----
  // Capsule + handsfär vid handleden.
  const armGeo = new THREE.CapsuleGeometry(armR, armH, 6, 10);

  function makeArm(side) {
    const pivot = new THREE.Group();
    pivot.position.set(side * (torsoR + armR + 0.02), shoulderY, 0);
    const mesh = new THREE.Mesh(armGeo, limbMat);
    mesh.position.y = -(armH / 2 + armR);
    pivot.add(mesh);

    // Hand vid armens ände
    const hand = new THREE.Mesh(
      new THREE.SphereGeometry(armR * 1.18, 10, 8),
      skinMat
    );
    hand.position.y = -(armH + armR * 1.85);
    hand.scale.set(1, 0.95, 1.05);
    hand.castShadow = true;
    pivot.add(hand);

    grp.add(pivot);
    return { pivot, hand };
  }
  const leftArmInfo = makeArm(-1);
  const rightArmInfo = makeArm(1);

  // ----- Huvud (något äggformat, inte bara sfär) -----
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(headR, 20, 16),
    skinMat
  );
  head.position.y = headY;
  head.scale.set(0.95, 1.05, 1.0);
  grp.add(head);

  // ----- Käke/haka-antydan -----
  const jaw = new THREE.Mesh(
    new THREE.SphereGeometry(headR * 0.72, 12, 10, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.45),
    skinMat
  );
  jaw.position.set(0, headY - headR * 0.18, headR * 0.08);
  grp.add(jaw);

  const rig = {
    // Pivotar — samma API som tidigare så att alla decorations fortsätter funka.
    leftLeg: leftLegInfo.upper, rightLeg: rightLegInfo.upper,
    leftArm: leftArmInfo.pivot, rightArm: rightArmInfo.pivot,
    torso, head, neck,
    // Nya pivotar för knäböj + fot-tilt
    leftLegLower: leftLegInfo.lower, rightLegLower: rightLegInfo.lower,
    leftFootPivot: leftLegInfo.footPivot, rightFootPivot: rightLegInfo.footPivot,
    leftHand: leftArmInfo.hand, rightHand: rightArmInfo.hand,
    // Dimensions (oförändrade fält)
    hipY, torsoCenterY, torsoTopY, shoulderY, headY, headR, torsoR, torsoH,
    bodyMat, armorMat, skinMat, limbMat,
  };
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

// Hero-mesh-dispatcher per heroId — GLTF-laddat från KayKit Adventurers.
// Mappning: magiker→Mage, legolas→Ranger, gimlu→Barbarian.
const HERO_GLTF_MAP = {
  magiker: 'mage',
  legolas: 'ranger',
  gimlu:   'barbarian',
  aragurn: 'knight',
};
// Per-hero scale: {x,y,z}. X/Z mindre än Y → smalare silhuett (mindre lego-klump).
const HERO_GLTF_SCALE = {
  magiker: { x: 0.70, y: 0.82, z: 0.78 },
  legolas: { x: 0.70, y: 0.82, z: 0.78 },
  gimlu:   { x: 0.80, y: 0.88, z: 0.86 },  // Barbarian = lite större för tank-känsla
  aragurn: { x: 0.95, y: 1.10, z: 0.98 },  // Knight, större + längre — soldat-bygge
};
function makeHeroMesh(idx, heroId) {
  const cfg = SIDE_CFG[idx];
  const grp = new THREE.Group();
  grp.userData.heroId = heroId || 'magiker';

  const charName = HERO_GLTF_MAP[heroId] || HERO_GLTF_MAP.magiker;
  const inner = instantiateCharacter(charName, 'hero');
  if (inner) {
    const sc = HERO_GLTF_SCALE[heroId] || HERO_GLTF_SCALE.magiker;
    inner.scale.set(sc.x, sc.y, sc.z);
    grp.add(inner);
    grp.userData.inner = inner;
    grp.userData.mixer = inner.userData.mixer;
    grp.userData.actions = inner.userData.actions;
    activeMixers.add(inner.userData.mixer);
    startDefaultIdle(grp);
  } else {
    // Fallback: röd placeholder-box om asset inte laddat
    const fb = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 1.7, 0.5),
      new THREE.MeshStandardMaterial({ color: 0xff3333 })
    );
    fb.position.y = 0.85;
    grp.add(fb);
  }

  // Sido-ring under hjälten (visar färgen på ägarsidan)
  const sideColor = cfg ? cfg.heroColor : 0xffffff;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.45, 0.62, 28),
    new THREE.MeshBasicMaterial({ color: sideColor, transparent: true, opacity: 0.4, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.04;
  grp.add(ring);
  grp.userData.sideRing = ring;

  // Aragurn-specifik: alltid synligt STORT svärd (4× större) som sitter på högersidan,
  // slår med det vid AA och spinner med det vid Whirlwind.
  if ((heroId || '').toLowerCase() === 'aragurn') {
    const sword = makeAragurnSword();
    sword.scale.set(1.92, 1.92, 1.92);     // −40% från 3.2 (tidigare 4×, nu kompakt)
    sword.position.set(0.85, 1.0, 0.15);   // höger sida, högre upp pga storlek
    sword.rotation.z = -0.35;
    sword.rotation.x = 0.15;
    grp.add(sword);
    grp.userData.aragurnSword = sword;
    grp.userData.aragurnSwordDefault = {
      pos: sword.position.clone(),
      rot: sword.rotation.clone(),
      scale: sword.scale.clone(),
    };
  }

  return grp;
}

// Aragurn-svärdet: stort sword-mesh, alltid synligt.
function makeAragurnSword() {
  const grp = new THREE.Group();
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0xdadcdf, metalness: 0.75, roughness: 0.28 });
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.10, 1.5, 0.03), bladeMat);
  blade.position.y = 0.95;
  grp.add(blade);
  // Spets-tip på toppen
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.20, 6), bladeMat);
  tip.position.y = 1.80;
  grp.add(tip);
  // Hilt (parerstång)
  const guardMat = new THREE.MeshStandardMaterial({ color: 0x8a6a30, metalness: 0.6, roughness: 0.4 });
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.08, 0.10), guardMat);
  guard.position.y = 0.20;
  grp.add(guard);
  // Grip
  const gripMat = new THREE.MeshStandardMaterial({ color: 0x553311, roughness: 0.85 });
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.30, 10), gripMat);
  grip.position.y = 0.05;
  grp.add(grip);
  // Pommel
  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), guardMat);
  pommel.position.y = -0.12;
  grp.add(pommel);
  return grp;
}

// ---- GLTF-animations-hjälpare ----
function findClipName(actions, ...substrs) {
  if (!actions) return null;
  const names = Object.keys(actions);
  for (const sub of substrs) {
    const found = names.find(n => n.toLowerCase().includes(sub.toLowerCase()));
    if (found) return found;
  }
  return null;
}

function startDefaultIdle(grp) {
  const actions = grp.userData.actions;
  if (!actions) return;
  const idleName = findClipName(actions, 'Idle', 'idle');
  if (!idleName) return;
  const a = actions[idleName];
  a.reset().play();
  grp.userData.currentClipName = idleName;
}

function playGltfAction(grp, clipName, opts = {}) {
  const actions = grp.userData.actions;
  if (!actions || !clipName) return;
  const target = actions[clipName];
  if (!target) return;
  if (grp.userData.currentClipName === clipName) return;
  const prevName = grp.userData.currentClipName;
  const prev = prevName ? actions[prevName] : null;
  const fade = opts.fade ?? 0.18;
  target.reset();
  target.setLoop(opts.once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
  target.clampWhenFinished = !!opts.once;
  target.timeScale = opts.timeScale ?? 1;
  target.enabled = true;
  target.setEffectiveWeight(1);
  target.fadeIn(fade);
  target.play();
  if (prev && prev !== target) prev.fadeOut(fade);
  grp.userData.currentClipName = clipName;
}

function makeGandulfMesh(idx) {
  const cfg = SIDE_CFG[idx];
  const grp = new THREE.Group();
  grp.userData.heroId = 'magiker';

  // Mörk midnattsblå robe (eller djup violett för side 2) — mer "arch-mage"
  const robeColor = idx === 1 ? 0x1a1450 : 0x2a1238;
  const robeDeep = idx === 1 ? 0x0a0830 : 0x180624;
  const trimColor = cfg.heroColor;
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xe6c7a5, roughness: 0.55 });
  const robeMat = new THREE.MeshStandardMaterial({ color: robeColor, roughness: 0.78 });
  const robeDarkMat = new THREE.MeshStandardMaterial({ color: robeDeep, roughness: 0.85 });
  const bootMat = new THREE.MeshStandardMaterial({ color: 0x2a1a0d, roughness: 0.9 });

  const rig = buildHumanoidRig(grp, {
    legR: 0.10, legH: 0.30, armR: 0.085, armH: 0.34,
    torsoR: 0.22, torsoH: 0.46, headR: 0.18,
    torsoShape: 'capsule',
    bodyMat: robeMat, armorMat: robeDarkMat, skinMat,
    limbMat: robeMat, legMat: bootMat,
  });

  // Robe-hem (kjol som flarar ut)
  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(rig.torsoR * 1.05, rig.torsoR * 1.55, 0.42, 18, 1, true),
    robeMat
  );
  skirt.position.y = rig.hipY + 0.02;
  grp.add(skirt);

  // Inre mörkare lager (stjärnig fodrad insida)
  const skirtInner = new THREE.Mesh(
    new THREE.CylinderGeometry(rig.torsoR * 1.02, rig.torsoR * 1.48, 0.38, 18, 1, true),
    robeDarkMat
  );
  skirtInner.position.y = rig.hipY + 0.04;
  grp.add(skirtInner);

  // Glödande trim runt hemmet
  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(rig.torsoR * 1.52, 0.04, 10, 26),
    new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.4, emissive: trimColor, emissiveIntensity: 0.65 })
  );
  trim.rotation.x = Math.PI / 2;
  trim.position.y = rig.hipY - 0.18;
  grp.add(trim);

  // Bälte med spänne
  const belt = new THREE.Mesh(
    new THREE.TorusGeometry(rig.torsoR * 1.05, 0.05, 10, 22),
    new THREE.MeshStandardMaterial({ color: 0x3a2010, roughness: 0.7, metalness: 0.25 })
  );
  belt.rotation.x = Math.PI / 2;
  belt.position.y = rig.hipY + 0.10;
  grp.add(belt);
  const buckle = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.07),
    new THREE.MeshStandardMaterial({ color: trimColor, emissive: trimColor, emissiveIntensity: 0.85, metalness: 0.6, roughness: 0.3 })
  );
  buckle.position.set(0, rig.hipY + 0.10, rig.torsoR * 1.1);
  grp.add(buckle);

  // Stjärnor på roben — små glödande oktaeder
  const starMat = new THREE.MeshStandardMaterial({ color: trimColor, emissive: trimColor, emissiveIntensity: 0.8, roughness: 0.3 });
  const starPositions = [
    [ 0.12, rig.hipY + 0.30,  0.20],
    [-0.14, rig.hipY + 0.22,  0.18],
    [ 0.05, rig.hipY + 0.12,  0.22],
    [-0.10, rig.hipY - 0.02,  0.20],
    [ 0.16, rig.hipY - 0.10,  0.16],
  ];
  for (const [x, y, z] of starPositions) {
    const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.028), starMat);
    star.position.set(x, y, z);
    grp.add(star);
  }

  // Krage med "popp" — mörkare yttre lager och en uppåt-cone (lyser kvällsljus)
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13, rig.torsoR * 1.05, 0.18, 14),
    robeDarkMat
  );
  collar.position.y = rig.torsoTopY - 0.04;
  grp.add(collar);
  const collarRise = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.20, 14, 1, true),
    robeDarkMat
  );
  collarRise.position.y = rig.torsoTopY + 0.08;
  collarRise.position.z = -0.06;
  grp.add(collarRise);

  // Skägg — flera lager för flowig look. Huvudkon + tjockare bas + två sidostrips
  const beardMat = new THREE.MeshStandardMaterial({ color: 0xeef0f4, roughness: 0.92 });
  const beardCore = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.42, 14), beardMat);
  beardCore.position.set(0, rig.headY - 0.26, 0.10);
  beardCore.rotation.x = Math.PI;
  grp.add(beardCore);
  const beardWide = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2.4), beardMat);
  beardWide.rotation.x = Math.PI;
  beardWide.position.set(0, rig.headY - 0.04, 0.11);
  grp.add(beardWide);
  // Två sidostrands
  for (const sx of [-1, 1]) {
    const strand = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.30, 8), beardMat);
    strand.position.set(sx * 0.07, rig.headY - 0.22, 0.13);
    strand.rotation.x = Math.PI;
    strand.rotation.z = sx * 0.10;
    grp.add(strand);
  }
  // Mustasch
  const mustacheMat = beardMat;
  for (const sx of [-1, 1]) {
    const mus = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.10, 8), mustacheMat);
    mus.position.set(sx * 0.04, rig.headY - 0.02, 0.16);
    mus.rotation.x = Math.PI * 0.55;
    mus.rotation.z = sx * 0.5;
    grp.add(mus);
  }
  // Mörka buskiga ögonbryn
  for (const sx of [-1, 1]) {
    const brow = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xcccfd3, roughness: 0.9 })
    );
    brow.position.set(sx * 0.06, rig.headY + 0.04, 0.15);
    brow.scale.set(1.6, 0.7, 0.7);
    grp.add(brow);
  }

  // Stor brimmad trollkarlshatt — bred brim, hög svagt böjd cone, stjärnor
  const hatMat = new THREE.MeshStandardMaterial({ color: robeDeep, roughness: 0.85 });
  // Brim — flat skiva (tunn cylinder) istället för torus, ger "wide brim"-känsla
  const hatBrim = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.34, 0.04, 24),
    hatMat
  );
  hatBrim.position.y = rig.headY + 0.18;
  grp.add(hatBrim);
  // Brim trim (lyser)
  const brimTrim = new THREE.Mesh(
    new THREE.TorusGeometry(0.34, 0.018, 8, 28),
    new THREE.MeshStandardMaterial({ color: trimColor, emissive: trimColor, emissiveIntensity: 0.55, roughness: 0.5 })
  );
  brimTrim.rotation.x = Math.PI / 2;
  brimTrim.position.y = rig.headY + 0.18;
  grp.add(brimTrim);
  // Hög cone som lutar lite framåt
  const hatCone = new THREE.Mesh(
    new THREE.ConeGeometry(0.22, 0.62, 18),
    hatMat
  );
  hatCone.position.y = rig.headY + 0.52;
  hatCone.position.z = -0.02;
  hatCone.rotation.x = -0.12;
  grp.add(hatCone);
  // Liten knäck nära toppen (extra mini-cone)
  const hatTip = new THREE.Mesh(
    new THREE.ConeGeometry(0.07, 0.16, 12),
    hatMat
  );
  hatTip.position.set(0, rig.headY + 0.86, 0.04);
  hatTip.rotation.x = 0.35;
  grp.add(hatTip);
  // Bandet runt brimmens fot
  const hatBand = new THREE.Mesh(
    new THREE.CylinderGeometry(0.20, 0.22, 0.06, 16),
    new THREE.MeshStandardMaterial({ color: 0x2a1a0d, roughness: 0.85 })
  );
  hatBand.position.y = rig.headY + 0.22;
  grp.add(hatBand);
  // Glödande stjärna(or) på conen
  const starHat1 = new THREE.Mesh(new THREE.OctahedronGeometry(0.055), starMat);
  starHat1.position.set(0, rig.headY + 0.42, 0.16);
  grp.add(starHat1);
  const starHat2 = new THREE.Mesh(new THREE.OctahedronGeometry(0.035), starMat);
  starHat2.position.set(0.08, rig.headY + 0.58, 0.12);
  grp.add(starHat2);
  const starHat3 = new THREE.Mesh(new THREE.OctahedronGeometry(0.030), starMat);
  starHat3.position.set(-0.07, rig.headY + 0.66, 0.10);
  grp.add(starHat3);

  // Stav: trä-skaft med spiral, fäst på höger arm
  const staffWoodMat = new THREE.MeshStandardMaterial({ color: 0x2c1d10, roughness: 0.9 });
  const staff = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.05, 1.6, 10),
    staffWoodMat
  );
  staff.position.set(0.05, -0.55, 0.05);
  rig.rightArm.add(staff);
  // Tvinningar runt skaftet (3 ringar)
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.055, 0.012, 8, 14),
      new THREE.MeshStandardMaterial({ color: 0x4a3220, roughness: 0.8, metalness: 0.2 })
    );
    ring.position.set(0.05, -0.40 + i * 0.22, 0.05);
    rig.rightArm.add(ring);
  }
  // Toppgreppet — gaffelliknande krans som håller kristallen
  for (let k = 0; k < 4; k++) {
    const claw = new THREE.Mesh(
      new THREE.ConeGeometry(0.025, 0.18, 6),
      new THREE.MeshStandardMaterial({ color: 0x4a3220, roughness: 0.8 })
    );
    const ang = (k / 4) * Math.PI * 2;
    claw.position.set(0.05 + Math.cos(ang) * 0.08, -1.20, 0.05 + Math.sin(ang) * 0.08);
    claw.rotation.x = Math.PI;
    claw.rotation.z = Math.cos(ang) * 0.3;
    rig.rightArm.add(claw);
  }
  // Stor kristall i toppen — mer detaljerad
  const orb = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.16, 0),
    new THREE.MeshStandardMaterial({
      color: trimColor, emissive: trimColor, emissiveIntensity: 1.8,
      roughness: 0.15, metalness: 0.1,
    })
  );
  orb.position.set(0.05, -1.30, 0.05);
  rig.rightArm.add(orb);
  // Halo-ring runt kristallen
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(0.22, 0.012, 8, 28),
    new THREE.MeshBasicMaterial({ color: trimColor, transparent: true, opacity: 0.55 })
  );
  halo.position.set(0.05, -1.30, 0.05);
  halo.rotation.x = Math.PI / 2;
  rig.rightArm.add(halo);
  // Punktljus i staven så orben kastar arcane-ljus
  const staffLight = new THREE.PointLight(trimColor, 0.6, 2.5, 2);
  staffLight.position.set(0.05, -1.30, 0.05);
  rig.rightArm.add(staffLight);

  // Subtle arcane-aura under fötterna
  const aura = new THREE.Mesh(
    new THREE.RingGeometry(0.36, 0.55, 28),
    new THREE.MeshBasicMaterial({ color: trimColor, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
  );
  aura.rotation.x = -Math.PI / 2;
  aura.position.y = 0.02;
  grp.add(aura);

  setShadow(grp, true, false);
  return grp;
}

// Legolus — hooded ranger-assassin. Mörka skogsfärger, hood som skuggar ansiktet,
// rygg-cape, dolkar i bältet, koger + båge. Hunter-assassin vibe.
function makeLegolasMesh(idx) {
  const cfg = SIDE_CFG[idx];
  const grp = new THREE.Group();
  grp.userData.heroId = 'legolas';

  const trimColor = cfg.heroColor;
  const tunicColor = 0x1f2a18;       // mörk skogsgrön (nästan svart)
  const cloakColor = 0x121810;       // svart-grön cape
  const leatherColor = 0x3a2614;     // mörk läder
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd8b88a, roughness: 0.55 });
  const tunicMat = new THREE.MeshStandardMaterial({ color: tunicColor, roughness: 0.88 });
  const cloakMat = new THREE.MeshStandardMaterial({ color: cloakColor, roughness: 0.92 });
  const leatherMat = new THREE.MeshStandardMaterial({ color: leatherColor, roughness: 0.75 });
  const bootMat = new THREE.MeshStandardMaterial({ color: 0x1a0e08, roughness: 0.92 });

  const rig = buildHumanoidRig(grp, {
    legR: 0.085, legH: 0.32, armR: 0.075, armH: 0.36,
    torsoR: 0.20, torsoH: 0.46, headR: 0.16,
    torsoShape: 'capsule',
    bodyMat: tunicMat, armorMat: leatherMat, skinMat,
    limbMat: tunicMat, legMat: bootMat,
  });

  // Brigandine-väst (mörk grön/svart)
  const vest = new THREE.Mesh(
    new THREE.CylinderGeometry(rig.torsoR * 1.06, rig.torsoR * 1.06, rig.torsoH * 0.78, 14, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x0e1410, roughness: 0.88 })
  );
  vest.position.y = rig.hipY + rig.torsoH * 0.4;
  grp.add(vest);

  // Diagonal läderrem över bröstet (för dolkfäste)
  const sash = new THREE.Mesh(
    new THREE.BoxGeometry(rig.torsoR * 2.2, 0.06, 0.04),
    leatherMat
  );
  sash.position.set(0, rig.torsoTopY - 0.10, rig.torsoR * 0.6);
  sash.rotation.z = -0.35;
  grp.add(sash);

  // Bälte
  const belt = new THREE.Mesh(
    new THREE.TorusGeometry(rig.torsoR * 1.05, 0.045, 10, 22),
    leatherMat
  );
  belt.rotation.x = Math.PI / 2;
  belt.position.y = rig.hipY + 0.05;
  grp.add(belt);

  // Bröst-trim (glödande accent)
  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(rig.torsoR * 1.07, 0.02, 8, 22),
    new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.45, emissive: trimColor, emissiveIntensity: 0.5 })
  );
  trim.rotation.x = Math.PI / 2;
  trim.position.y = rig.torsoTopY - 0.05;
  grp.add(trim);

  // Bracers — läder runt underarmarna
  for (const arm of [rig.leftArm, rig.rightArm]) {
    const bracer = new THREE.Mesh(
      new THREE.CylinderGeometry(rig.armR * 1.25, rig.armR * 1.15, 0.16, 10),
      leatherMat
    );
    bracer.position.set(0, -0.26, 0);
    arm.add(bracer);
    const bracerTrim = new THREE.Mesh(
      new THREE.TorusGeometry(rig.armR * 1.28, 0.01, 6, 16),
      new THREE.MeshStandardMaterial({ color: trimColor, emissive: trimColor, emissiveIntensity: 0.55, roughness: 0.5 })
    );
    bracerTrim.position.set(0, -0.20, 0);
    bracerTrim.rotation.x = Math.PI / 2;
    arm.add(bracerTrim);
  }

  // HOOD — sphere cap som täcker huvudet och kastar shadow
  // Innre del (mörk skugga inuti hooden)
  const hoodInner = new THREE.Mesh(
    new THREE.SphereGeometry(rig.headR * 1.18, 14, 10, 0, Math.PI * 2, 0, Math.PI / 1.6),
    new THREE.MeshStandardMaterial({ color: 0x06080a, roughness: 0.95 })
  );
  hoodInner.position.set(0, rig.headY - 0.04, -0.02);
  grp.add(hoodInner);
  // Yttre hooden — något större cap, framskjuten lite så ansiktet är skuggat
  const hood = new THREE.Mesh(
    new THREE.SphereGeometry(rig.headR * 1.32, 16, 12, 0, Math.PI * 2, 0, Math.PI / 1.55),
    cloakMat
  );
  hood.position.set(0, rig.headY - 0.02, -0.02);
  grp.add(hood);
  // "Spets" på hooden bak — liten cone som hänger
  const hoodTip = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.22, 10), cloakMat);
  hoodTip.position.set(0, rig.headY + 0.10, -rig.headR * 1.0);
  hoodTip.rotation.x = -0.6;
  grp.add(hoodTip);
  // Främre kant av hooden (mörkare ring som ramar in ansiktet)
  const hoodEdge = new THREE.Mesh(
    new THREE.TorusGeometry(rig.headR * 1.12, 0.025, 8, 20, Math.PI),
    cloakMat
  );
  hoodEdge.position.set(0, rig.headY + 0.02, rig.headR * 0.35);
  hoodEdge.rotation.x = -0.2;
  hoodEdge.rotation.y = Math.PI;
  grp.add(hoodEdge);

  // Glödande ögon (subtle) inuti hooden
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(0.018, 6, 6),
      new THREE.MeshBasicMaterial({ color: trimColor })
    );
    eye.position.set(sx * 0.045, rig.headY + 0.02, rig.headR * 0.85);
    grp.add(eye);
  }

  // Mantel/cape på ryggen — PlaneGeometry (eller curved cylinder) som hänger
  const cape = new THREE.Mesh(
    new THREE.CylinderGeometry(rig.torsoR * 0.5, rig.torsoR * 1.3, rig.torsoH + 0.35, 14, 1, true, -Math.PI * 0.7, Math.PI * 1.4),
    cloakMat
  );
  cape.position.set(0, rig.hipY + rig.torsoH * 0.30, -rig.torsoR * 0.7);
  grp.add(cape);

  // Två dolkar korsade på baksidan (X-form)
  const daggerMat = new THREE.MeshStandardMaterial({ color: 0xa8acb0, metalness: 0.6, roughness: 0.3 });
  const daggerHandleMat = new THREE.MeshStandardMaterial({ color: 0x1a0e08, roughness: 0.9 });
  for (const sx of [-1, 1]) {
    // Blad
    const dagger = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.22, 8), daggerMat);
    dagger.position.set(sx * 0.10, rig.hipY + 0.04, rig.torsoR * 1.0);
    dagger.rotation.z = sx * 0.4;
    dagger.rotation.x = Math.PI / 2;
    grp.add(dagger);
    // Handtag
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.08, 8), daggerHandleMat);
    handle.position.set(sx * 0.04, rig.hipY + 0.16, rig.torsoR * 1.0);
    handle.rotation.z = sx * 0.4;
    grp.add(handle);
  }

  // Båge — TorusGeometry halv-cirkel i höger hand, mörk + recurve-känsla
  const bowMat = new THREE.MeshStandardMaterial({ color: 0x2e1d0c, roughness: 0.85 });
  const bowAccent = new THREE.MeshStandardMaterial({ color: trimColor, emissive: trimColor, emissiveIntensity: 0.4, roughness: 0.5 });
  const bow = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.022, 8, 20, Math.PI), bowMat);
  bow.position.set(0.08, -0.40, 0.08);
  bow.rotation.set(0, Math.PI / 2, Math.PI / 2);
  rig.rightArm.add(bow);
  // Accent-tips på bågen
  for (const ty of [-0.72, -0.08]) {
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.06, 8), bowAccent);
    tip.position.set(0.08, ty, 0.08);
    rig.rightArm.add(tip);
  }
  // Bågsträng
  const stringMat = new THREE.MeshStandardMaterial({ color: 0xeeeacf, roughness: 0.6 });
  const string = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.68, 6), stringMat);
  string.position.set(0.08, -0.40, 0.08);
  string.rotation.set(0, 0, Math.PI / 2);
  rig.rightArm.add(string);

  // Koger på rygg (mörkt läder, syns över axeln)
  const quiver = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.07, 0.36, 12),
    new THREE.MeshStandardMaterial({ color: 0x2a1810, roughness: 0.82 })
  );
  quiver.position.set(-0.12, rig.torsoTopY - 0.16, -0.20);
  quiver.rotation.x = -0.4;
  quiver.rotation.z = -0.25;
  grp.add(quiver);
  // Koger-trim
  const quiverTrim = new THREE.Mesh(
    new THREE.TorusGeometry(0.08, 0.012, 8, 16),
    new THREE.MeshStandardMaterial({ color: trimColor, emissive: trimColor, emissiveIntensity: 0.45, roughness: 0.5 })
  );
  quiverTrim.position.set(-0.12, rig.torsoTopY - 0.02, -0.16);
  quiverTrim.rotation.x = Math.PI / 2 - 0.4;
  quiverTrim.rotation.z = -0.25;
  grp.add(quiverTrim);
  // Pilar
  for (let i = 0; i < 5; i++) {
    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.012, 0.20, 6),
      new THREE.MeshStandardMaterial({ color: 0xccc080, roughness: 0.6 })
    );
    arrow.position.set(-0.085 - i * 0.022, rig.torsoTopY + 0.06, -0.18);
    arrow.rotation.x = -0.4;
    arrow.rotation.z = -0.25;
    grp.add(arrow);
  }

  // Aura under fötterna — mörkare grön
  const aura = new THREE.Mesh(
    new THREE.RingGeometry(0.32, 0.48, 28),
    new THREE.MeshBasicMaterial({ color: 0x3aa055, transparent: true, opacity: 0.20, side: THREE.DoubleSide })
  );
  aura.rotation.x = -Math.PI / 2;
  aura.position.y = 0.02;
  grp.add(aura);

  setShadow(grp, true, false);
  return grp;
}

// Gimlu — STOR stout dvärg. Bredare och tyngre än andra heroes, massivt
// flätat skägg, hornhjälm, plåtrustning, krigshammare med rune-glow.
function makeGimluMesh(idx) {
  const cfg = SIDE_CFG[idx];
  const grp = new THREE.Group();
  grp.userData.heroId = 'gimlu';

  const trimColor = cfg.heroColor;
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd9a878, roughness: 0.55 });
  const armorMat = new THREE.MeshStandardMaterial({ color: 0x7a7e84, roughness: 0.5, metalness: 0.4 });
  const armorDarkMat = new THREE.MeshStandardMaterial({ color: 0x4a4e54, roughness: 0.6, metalness: 0.45 });
  const beltMat = new THREE.MeshStandardMaterial({ color: 0x3a2818, roughness: 0.8 });
  const bootMat = new THREE.MeshStandardMaterial({ color: 0x2a1a0d, roughness: 0.9 });

  // BREDARE rig + kortare/tjockare lemmar för riktig dvärg-känsla.
  const rig = buildHumanoidRig(grp, {
    legR: 0.135, legH: 0.26, armR: 0.115, armH: 0.30,
    torsoR: 0.34, torsoH: 0.56, headR: 0.22,
    torsoShape: 'capsule',
    bodyMat: armorMat, armorMat: armorDarkMat, skinMat,
    limbMat: armorMat, legMat: bootMat,
  });

  // Bred bälte
  const belt = new THREE.Mesh(
    new THREE.TorusGeometry(rig.torsoR * 1.05, 0.10, 12, 28),
    beltMat
  );
  belt.rotation.x = Math.PI / 2;
  belt.position.y = rig.hipY + 0.06;
  grp.add(belt);
  // Spänne — stor stjärna
  const buckle = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.10),
    new THREE.MeshStandardMaterial({ color: trimColor, metalness: 0.7, roughness: 0.35, emissive: trimColor, emissiveIntensity: 0.5 })
  );
  buckle.position.set(0, rig.hipY + 0.06, rig.torsoR * 1.10);
  grp.add(buckle);

  // Bröstplåt — bredare och tyngre
  const chest = new THREE.Mesh(
    new THREE.CylinderGeometry(rig.torsoR * 1.08, rig.torsoR * 1.05, rig.torsoH * 0.72, 16, 1, true),
    armorDarkMat
  );
  chest.position.y = rig.hipY + rig.torsoH * 0.4;
  grp.add(chest);
  // Vertikala plåt-paneler (subtle ridges)
  for (const sx of [-1, 1]) {
    const ridge = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, rig.torsoH * 0.6, 0.03),
      armorMat
    );
    ridge.position.set(sx * rig.torsoR * 0.55, rig.hipY + rig.torsoH * 0.4, rig.torsoR * 1.0);
    grp.add(ridge);
  }
  // Bröst-trim
  const chestTrim = new THREE.Mesh(
    new THREE.TorusGeometry(rig.torsoR * 1.07, 0.05, 12, 26),
    new THREE.MeshStandardMaterial({ color: trimColor, metalness: 0.55, roughness: 0.35, emissive: trimColor, emissiveIntensity: 0.5 })
  );
  chestTrim.rotation.x = Math.PI / 2;
  chestTrim.position.y = rig.torsoTopY - 0.08;
  grp.add(chestTrim);
  // Centralt emblem på bröstet — rune-octahedron
  const emblem = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.09),
    new THREE.MeshStandardMaterial({ color: trimColor, emissive: trimColor, emissiveIntensity: 0.7, metalness: 0.6, roughness: 0.3 })
  );
  emblem.position.set(0, rig.hipY + rig.torsoH * 0.55, rig.torsoR * 1.08);
  grp.add(emblem);

  // Stora pauldrons med spikar
  for (const sx of [-1, 1]) {
    const pauld = new THREE.Mesh(
      new THREE.SphereGeometry(0.20, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      armorDarkMat
    );
    pauld.position.set(sx * (rig.torsoR + 0.07), rig.torsoTopY - 0.02, 0);
    grp.add(pauld);
    // Spikar på pauldron
    for (let k = 0; k < 3; k++) {
      const spike = new THREE.Mesh(
        new THREE.ConeGeometry(0.025, 0.10, 8),
        new THREE.MeshStandardMaterial({ color: 0xa8acb0, metalness: 0.7, roughness: 0.3 })
      );
      const ang = (k / 3) * Math.PI - Math.PI / 2;
      spike.position.set(sx * (rig.torsoR + 0.07) + Math.cos(ang) * 0.16, rig.torsoTopY + 0.04, Math.sin(ang) * 0.16);
      spike.rotation.x = Math.sin(ang) * 0.6;
      spike.rotation.z = -Math.cos(ang) * 0.6;
      grp.add(spike);
    }
  }

  // MASSIVT skägg — huvudkon + bredd-sphere + 2 flätade tails
  const beardMat = new THREE.MeshStandardMaterial({ color: 0x5a2e10, roughness: 0.88 });
  const beardBraidMat = new THREE.MeshStandardMaterial({ color: 0x4a2410, roughness: 0.88 });
  // Bred bas
  const beardBase = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2.3), beardMat);
  beardBase.rotation.x = Math.PI;
  beardBase.position.set(0, rig.headY - 0.04, 0.12);
  grp.add(beardBase);
  // Huvudkon (längre)
  const beardCore = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.65, 16), beardMat);
  beardCore.position.set(0, rig.headY - 0.32, 0.08);
  beardCore.rotation.x = Math.PI;
  grp.add(beardCore);
  // Två flätade braids
  for (const sx of [-1, 1]) {
    const braid = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.025, 0.50, 8), beardBraidMat);
    braid.position.set(sx * 0.13, rig.headY - 0.40, 0.10);
    braid.rotation.z = sx * -0.10;
    grp.add(braid);
    // Liten ring runt braiden
    const braidRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.04, 0.012, 6, 14),
      new THREE.MeshStandardMaterial({ color: trimColor, emissive: trimColor, emissiveIntensity: 0.5, metalness: 0.6, roughness: 0.3 })
    );
    braidRing.position.set(sx * 0.13, rig.headY - 0.58, 0.10);
    braidRing.rotation.x = Math.PI / 2;
    grp.add(braidRing);
  }
  // Mustasch — stor, böjda spetsar
  for (const sx of [-1, 1]) {
    const mustacheCurl = new THREE.Mesh(
      new THREE.TorusGeometry(0.07, 0.022, 8, 14, Math.PI),
      beardMat
    );
    mustacheCurl.position.set(sx * 0.08, rig.headY - 0.02, 0.18);
    mustacheCurl.rotation.y = sx * Math.PI / 2;
    mustacheCurl.rotation.z = sx * -0.3;
    grp.add(mustacheCurl);
  }

  // HORNHJÄLM — bredare cylinder + dome + 2 stora horn ut till sidorna
  const helmMat = new THREE.MeshStandardMaterial({ color: 0x787c80, metalness: 0.5, roughness: 0.45 });
  const hornMat = new THREE.MeshStandardMaterial({ color: 0xddc080, metalness: 0.4, roughness: 0.5 });
  const helmRing = new THREE.Mesh(new THREE.CylinderGeometry(rig.headR * 1.10, rig.headR * 1.10, 0.18, 18), helmMat);
  helmRing.position.y = rig.headY + 0.04;
  grp.add(helmRing);
  const helmDome = new THREE.Mesh(new THREE.SphereGeometry(rig.headR * 1.10, 18, 14, 0, Math.PI * 2, 0, Math.PI / 2.1), helmMat);
  helmDome.position.y = rig.headY + 0.13;
  grp.add(helmDome);
  // STORA horn — torus-halvor ut från sidorna
  for (const sx of [-1, 1]) {
    const horn = new THREE.Mesh(
      new THREE.TorusGeometry(0.16, 0.040, 10, 16, Math.PI),
      hornMat
    );
    horn.position.set(sx * (rig.headR * 1.05), rig.headY + 0.10, 0);
    horn.rotation.y = sx * Math.PI / 2;
    horn.rotation.z = sx * Math.PI / 2;
    grp.add(horn);
    // Spets-detalj på hornen
    const hornTip = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.10, 8), hornMat);
    hornTip.position.set(sx * (rig.headR * 1.05 + 0.16), rig.headY + 0.22, 0);
    hornTip.rotation.z = sx * Math.PI / 2;
    grp.add(hornTip);
  }
  // Mittspik på toppen
  const helmSpike = new THREE.Mesh(
    new THREE.ConeGeometry(0.07, 0.22, 10),
    new THREE.MeshStandardMaterial({ color: trimColor, metalness: 0.6, roughness: 0.4, emissive: trimColor, emissiveIntensity: 0.55 })
  );
  helmSpike.position.y = rig.headY + 0.36;
  grp.add(helmSpike);
  // Näspar
  const nasal = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.18, 0.04), helmMat);
  nasal.position.set(0, rig.headY - 0.02, rig.headR * 1.00);
  grp.add(nasal);
  // Rune-band runt hjälmen
  const helmBand = new THREE.Mesh(
    new THREE.TorusGeometry(rig.headR * 1.11, 0.02, 8, 22),
    new THREE.MeshStandardMaterial({ color: trimColor, emissive: trimColor, emissiveIntensity: 0.5, roughness: 0.5 })
  );
  helmBand.rotation.x = Math.PI / 2;
  helmBand.position.y = rig.headY + 0.10;
  grp.add(helmBand);

  // STOR krigshammare i höger hand
  const haftMat = new THREE.MeshStandardMaterial({ color: 0x3a2410, roughness: 0.9 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0x6a6e72, metalness: 0.55, roughness: 0.35 });
  const haft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.80, 12), haftMat);
  haft.position.set(0.05, -0.32, 0.05);
  rig.rightArm.add(haft);
  // Skaft-wrap (ring)
  for (let i = 0; i < 2; i++) {
    const wrap = new THREE.Mesh(
      new THREE.TorusGeometry(0.055, 0.012, 8, 14),
      new THREE.MeshStandardMaterial({ color: 0x1a0e08, roughness: 0.9 })
    );
    wrap.position.set(0.05, -0.20 + i * 0.20, 0.05);
    rig.rightArm.add(wrap);
  }
  // Hammarhuvud — stor box
  const hammerHead = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.32, 0.28), headMat);
  hammerHead.position.set(0.05, -0.74, 0.05);
  hammerHead.rotation.z = Math.PI / 2;
  rig.rightArm.add(hammerHead);
  // Hammarhuvud trim — rune-emissive linje
  const hammerRune = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.34, 0.30),
    new THREE.MeshStandardMaterial({ color: trimColor, emissive: trimColor, emissiveIntensity: 0.8, roughness: 0.4 })
  );
  hammerRune.position.set(0.05, -0.74, 0.05);
  hammerRune.rotation.z = Math.PI / 2;
  rig.rightArm.add(hammerRune);
  // Spike på hammarhuvudet
  const hammerSpike = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 10), headMat);
  hammerSpike.position.set(0.05, -0.88, 0.05);
  rig.rightArm.add(hammerSpike);

  // Tank-aura (lila/orange beroende på side)
  const aura = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.62, 28),
    new THREE.MeshBasicMaterial({ color: trimColor, transparent: true, opacity: 0.22, side: THREE.DoubleSide })
  );
  aura.rotation.x = -Math.PI / 2;
  aura.position.y = 0.02;
  grp.add(aura);

  // SKALA UPP HELA RIGGEN ~1.15x för "större än andra heroes"-känsla
  grp.scale.set(1.15, 1.15, 1.15);

  setShadow(grp, true, false);
  return grp;
}

// Hjälpfunktion: applicera tier/grupp-tint på alla KayKit-meshes
// via emissive (utan att skapa nya material per instans = bra prestanda).
function tintGltfInner(inner, tintColor, tintIntensity = 0.25) {
  if (!inner) return;
  inner.traverse(o => {
    if (o.isMesh || o.isSkinnedMesh) {
      if (!o.material._tinted) {
        // Klon-materialet en gång per mesh så vi inte påverkar andra instanser
        o.material = o.material.clone();
        o.material._tinted = true;
      }
      if (tintColor !== undefined) {
        o.material.emissive = new THREE.Color(tintColor);
        o.material.emissiveIntensity = tintIntensity;
      }
    }
  });
}

function makeMonsterMesh() {
  // Wave-monster använder Skeleton_Warrior som default. Range-monster
  // tintas grönaktigt utifrån redan i hostSpawnMonsterFromDef (se nedan).
  const grp = new THREE.Group();
  const inner = instantiateCharacter('skel_warrior', 'skel');
  if (inner) {
    inner.scale.setScalar(0.85);
    grp.add(inner);
    grp.userData.inner = inner;
    grp.userData.mixer = inner.userData.mixer;
    grp.userData.actions = inner.userData.actions;
    activeMixers.add(inner.userData.mixer);
    startDefaultIdle(grp);
  } else {
    const fb = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 1.4, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x8a3a3a })
    );
    fb.position.y = 0.7;
    grp.add(fb);
  }
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

// Mappa arketyp → KayKit Skeleton-variant. Endast 4 finns i packen,
// så några arketyper delar modell men särskiljs via scale + tier-tint.
const ARCH_TO_GLTF = {
  slasher:  'skel_rogue',
  archer:   'skel_rogue',     // skeleton-rogue dubbar som archer (saknas dedikerad)
  bruiser:  'skel_warrior',
  mage:     'skel_mage',
  tank:     'skel_warrior',
  champion: 'skel_warrior',
};
const ARCH_SCALE_BIAS = {
  slasher:  0.78,
  archer:   0.82,
  bruiser:  0.92,
  mage:     0.85,
  tank:     1.00,
  champion: 1.05,
};

function makeMinionMesh(typeId, ownerIdx) {
  const def = MINION_TYPES[typeId];
  if (!def) {
    console.warn('Unknown minion type', typeId);
    return new THREE.Group();
  }
  const palette = TIER_PALETTE[def.tier];
  const tierScale = TIER_SCALE[def.tier];
  const ownerCfg = SIDE_CFG[ownerIdx];
  const charName = ARCH_TO_GLTF[def.archetype] || 'skel_warrior';
  const archBias = ARCH_SCALE_BIAS[def.archetype] ?? 0.85;

  const grp = new THREE.Group();
  grp.userData.archetype = def.archetype;
  grp.userData.tier = def.tier;
  const inner = instantiateCharacter(charName, 'skel');
  if (inner) {
    inner.scale.setScalar(archBias * tierScale);
    grp.add(inner);
    grp.userData.inner = inner;
    grp.userData.mixer = inner.userData.mixer;
    grp.userData.actions = inner.userData.actions;
    activeMixers.add(inner.userData.mixer);
    startDefaultIdle(grp);
    // Tier-tint via emissive (gör T2+ glöda lite i sin palette-färg).
    // T1 = ingen extra glow, T5 = stark glow.
    if (palette && palette.glow > 0) {
      tintGltfInner(inner, palette.accent ?? palette.body, Math.min(0.6, palette.glow * 0.4));
    }
  } else {
    const fb = new THREE.Mesh(
      new THREE.BoxGeometry(0.35, 1.2, 0.35),
      new THREE.MeshStandardMaterial({ color: palette ? palette.body : 0x666666 })
    );
    fb.position.y = 0.6;
    grp.add(fb);
  }

  // Ägar-ring (visar vems minion det är)
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.30, 0.42, 24),
    new THREE.MeshBasicMaterial({ color: ownerCfg.gruntColor, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  grp.add(ring);

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
  gameMode: 'classic',    // 'classic' (Line Wars) | 'arena1v1'
  arenaTeamSize: 1,       // 1 (1v1) eller 2 (2v2) — antal hjältar per team
  arenaBot: { active: false, difficulty: null },  // arena solo vs AI
  bossWars: { active: false, tier: 0 },           // boss wars solo (eller 3-spelare co-op kommande)
  localSide: 1,           // 1, 2, 3 eller 4 — vilken sida den lokala spelaren styr
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
// ARENA: KONFIG + KONSTANTER (måste deklareras FÖRE arenaState som refererar dem)
// ============================================================

// Arena ligger förskjuten z=80 från classic-scenen.
// Stor öppen arena (~88x56) med varierat cover som blockerar projektiler.
// Heroes spawnar på motsatta östra/västra sidor. Orb alltid mittpunkten.
const ARENA_Z_OFFSET = 80;
const ARENA_CFG = {
  // 1v1 spawns: en hjälte per sida
  spawn1: { x: -32, z: ARENA_Z_OFFSET },
  spawn2: { x:  32, z: ARENA_Z_OFFSET },
  // 2v2 spawns: två hjältar per team, spridda i Z-axeln
  spawns2v2: {
    1: { x: -32, z: ARENA_Z_OFFSET - 10 },  // team A medlem 1
    3: { x: -32, z: ARENA_Z_OFFSET + 10 },  // team A medlem 2 (dummy/ally)
    2: { x:  32, z: ARENA_Z_OFFSET - 10 },  // team B medlem 1 (dummy)
    4: { x:  32, z: ARENA_Z_OFFSET + 10 },  // team B medlem 2 (dummy)
  },
  orb:    { x: 0,   z: ARENA_Z_OFFSET },
  bounds: { minX: -44, maxX: 44, minZ: ARENA_Z_OFFSET - 28, maxZ: ARENA_Z_OFFSET + 28 },
  // Cover-props: x/z är relativt arena-mitten. collision = AABB/cirkel som
  // blockar hero-rörelse + projektiler. Rotation påverkar utseendet men
  // collision-formen är axis-aligned (close enough för gameplay).
  // OBS: props sätts dynamiskt från ARENA_MAPS[arenaState.mapIdx]
  props: [],
  floorTint: 0x5a4a36,    // bas-färg (kan override:as per map)
};

// === ARENA MAPS — 3 olika layouts med olika hinder och teman ===
const ARENA_MAPS = [
  {
    name: 'Desert Ruins',
    desc: 'Klassisk öken-arena: stenar, murar, vagnar, fallna torn',
    floorTint: 0x5a4a36,
    props: [
      // Stenar — små punkt-cover spridda över banan
      { type: 'rock', x: -14, z:  -9, rot: 0.3, collision: { shape: 'circle', radius: 1.1 } },
      { type: 'rock', x: -12, z: -11, rot: 1.2, collision: { shape: 'circle', radius: 1.0 } },
      { type: 'rock', x:  14, z:   9, rot: -0.7, collision: { shape: 'circle', radius: 1.1 } },
      { type: 'rock', x:  12, z:  11, rot: 0.5, collision: { shape: 'circle', radius: 1.0 } },
      { type: 'rock', x:  -4, z:  22, rot: 0.2, collision: { shape: 'circle', radius: 1.1 } },
      { type: 'rock', x:   5, z: -23, rot: 0.9, collision: { shape: 'circle', radius: 1.1 } },
      { type: 'rock', x:  18, z: -20, rot: 1.4, collision: { shape: 'circle', radius: 1.0 } },
      { type: 'rock', x: -19, z:  19, rot: 0.6, collision: { shape: 'circle', radius: 1.0 } },
      // Trasiga stenmurar
      { type: 'wall', x: -18, z:  15, rot: 0.05, collision: { shape: 'box', halfX: 1.3, halfZ: 0.5 } },
      { type: 'wall', x:  18, z: -15, rot: -0.10, collision: { shape: 'box', halfX: 1.3, halfZ: 0.5 } },
      { type: 'wall', x: -26, z:  -3, rot: 1.5, collision: { shape: 'box', halfX: 0.5, halfZ: 1.3 } },
      { type: 'wall', x:  26, z:   3, rot: 1.5, collision: { shape: 'box', halfX: 0.5, halfZ: 1.3 } },
      { type: 'wall', x:   2, z: -16, rot: 0.0, collision: { shape: 'box', halfX: 1.3, halfZ: 0.5 } },
      { type: 'wall', x:  -2, z:  16, rot: 0.0, collision: { shape: 'box', halfX: 1.3, halfZ: 0.5 } },
      // Brutna pelare
      { type: 'pillar', x: -20, z: -16, rot: 0, collision: { shape: 'circle', radius: 0.8 } },
      { type: 'pillar', x:  20, z:  16, rot: 0, collision: { shape: 'circle', radius: 0.8 } },
      { type: 'pillar', x: -10, z:  22, rot: 0, collision: { shape: 'circle', radius: 0.8 } },
      { type: 'pillar', x:  10, z: -22, rot: 0, collision: { shape: 'circle', radius: 0.8 } },
      { type: 'pillar', x: -34, z:  10, rot: 0, collision: { shape: 'circle', radius: 0.8 } },
      { type: 'pillar', x:  34, z: -10, rot: 0, collision: { shape: 'circle', radius: 0.8 } },
      // Trasiga hästvagnar
      { type: 'wagon', x: -22, z:   8, rot: 0.7, collision: { shape: 'box', halfX: 1.9, halfZ: 1.0 } },
      { type: 'wagon', x:  22, z:  -8, rot: -1.0, collision: { shape: 'box', halfX: 1.9, halfZ: 1.0 } },
      { type: 'wagon', x:  -8, z: -24, rot: 1.8, collision: { shape: 'box', halfX: 1.9, halfZ: 1.0 } },
      // Fallna torn
      { type: 'fallenTower', x:  -5, z:  -3, rot: 0.25, collision: { shape: 'box', halfX: 3.2, halfZ: 1.0 } },
      { type: 'fallenTower', x:   5, z:   3, rot: 2.85, collision: { shape: 'box', halfX: 3.2, halfZ: 1.0 } },
      { type: 'fallenTower', x:   8, z:  24, rot: 1.6, collision: { shape: 'box', halfX: 1.0, halfZ: 3.2 } },
    ],
  },
  {
    name: 'Stone Maze',
    desc: 'Maze med smala korridorer av höga murar — täta cover-vinklar',
    floorTint: 0x4a4234,
    props: [
      // Centralt zigzag-maze: 6 långa murar i mönster
      { type: 'wall', x: -10, z:  -2, rot: 0, collision: { shape: 'box', halfX: 3.5, halfZ: 0.5 } },
      { type: 'wall', x:  10, z:   2, rot: 0, collision: { shape: 'box', halfX: 3.5, halfZ: 0.5 } },
      { type: 'wall', x: -20, z:   6, rot: 0, collision: { shape: 'box', halfX: 3.0, halfZ: 0.5 } },
      { type: 'wall', x:  20, z:  -6, rot: 0, collision: { shape: 'box', halfX: 3.0, halfZ: 0.5 } },
      { type: 'wall', x:  -3, z:  14, rot: 0, collision: { shape: 'box', halfX: 4.0, halfZ: 0.5 } },
      { type: 'wall', x:   3, z: -14, rot: 0, collision: { shape: 'box', halfX: 4.0, halfZ: 0.5 } },
      // Vertikala stop-murar
      { type: 'wall', x: -15, z:  -8, rot: 1.5708, collision: { shape: 'box', halfX: 0.5, halfZ: 2.5 } },
      { type: 'wall', x:  15, z:   8, rot: 1.5708, collision: { shape: 'box', halfX: 0.5, halfZ: 2.5 } },
      { type: 'wall', x: -30, z:   0, rot: 1.5708, collision: { shape: 'box', halfX: 0.5, halfZ: 3.5 } },
      { type: 'wall', x:  30, z:   0, rot: 1.5708, collision: { shape: 'box', halfX: 0.5, halfZ: 3.5 } },
      { type: 'wall', x: -16, z:  22, rot: 1.5708, collision: { shape: 'box', halfX: 0.5, halfZ: 2.5 } },
      { type: 'wall', x:  16, z: -22, rot: 1.5708, collision: { shape: 'box', halfX: 0.5, halfZ: 2.5 } },
      // Hörn-pelare som blockerar diagonala line-of-sight
      { type: 'pillar', x: -25, z: -10, rot: 0, collision: { shape: 'circle', radius: 0.8 } },
      { type: 'pillar', x:  25, z:  10, rot: 0, collision: { shape: 'circle', radius: 0.8 } },
      { type: 'pillar', x: -25, z:  18, rot: 0, collision: { shape: 'circle', radius: 0.8 } },
      { type: 'pillar', x:  25, z: -18, rot: 0, collision: { shape: 'circle', radius: 0.8 } },
      { type: 'pillar', x:  -8, z:  -8, rot: 0, collision: { shape: 'circle', radius: 0.8 } },
      { type: 'pillar', x:   8, z:   8, rot: 0, collision: { shape: 'circle', radius: 0.8 } },
      // Få stenar för variation
      { type: 'rock', x:  -2, z:  24, rot: 0.4, collision: { shape: 'circle', radius: 1.0 } },
      { type: 'rock', x:   2, z: -24, rot: 1.1, collision: { shape: 'circle', radius: 1.0 } },
    ],
  },
  {
    name: 'Open Battlefield',
    desc: 'Öppet slagfält — få stora cover-platser, hög rörelse-fokus',
    floorTint: 0x4a3a2a,
    props: [
      // 4 stora fallna torn som "kapsuler" för cover
      { type: 'fallenTower', x: -12, z:   0, rot: 0, collision: { shape: 'box', halfX: 3.2, halfZ: 1.0 } },
      { type: 'fallenTower', x:  12, z:   0, rot: Math.PI, collision: { shape: 'box', halfX: 3.2, halfZ: 1.0 } },
      { type: 'fallenTower', x:   0, z:  15, rot: 1.5708, collision: { shape: 'box', halfX: 1.0, halfZ: 3.2 } },
      { type: 'fallenTower', x:   0, z: -15, rot: 1.5708, collision: { shape: 'box', halfX: 1.0, halfZ: 3.2 } },
      // 4 vagnar i mellanavstånd
      { type: 'wagon', x: -25, z:  12, rot: 0.5, collision: { shape: 'box', halfX: 1.9, halfZ: 1.0 } },
      { type: 'wagon', x:  25, z: -12, rot: -0.5, collision: { shape: 'box', halfX: 1.9, halfZ: 1.0 } },
      { type: 'wagon', x: -25, z: -12, rot: 1.0, collision: { shape: 'box', halfX: 1.9, halfZ: 1.0 } },
      { type: 'wagon', x:  25, z:  12, rot: -1.0, collision: { shape: 'box', halfX: 1.9, halfZ: 1.0 } },
      // Enstaka stenar för line-of-sight breakage
      { type: 'rock', x: -18, z:  22, rot: 0.7, collision: { shape: 'circle', radius: 1.2 } },
      { type: 'rock', x:  18, z: -22, rot: 1.4, collision: { shape: 'circle', radius: 1.2 } },
      { type: 'rock', x:   0, z:  25, rot: 0.0, collision: { shape: 'circle', radius: 1.2 } },
      { type: 'rock', x:   0, z: -25, rot: 0.0, collision: { shape: 'circle', radius: 1.2 } },
    ],
  },
];

// Helper för att byta aktiv map (kopierar props från ARENA_MAPS[idx])
function setArenaMap(idx) {
  const safeIdx = Math.max(0, Math.min(ARENA_MAPS.length - 1, idx | 0));
  ARENA_CFG.props = ARENA_MAPS[safeIdx].props;
  ARENA_CFG.floorTint = ARENA_MAPS[safeIdx].floorTint;
  return safeIdx;
}
// Initialisera till Map 0 vid start
setArenaMap(0);

const ARENA_ORB_MAX_HP = 100;
const ARENA_ORB_SPAWN_DELAY = 0;       // spawnar direkt vid fight-start
const ARENA_ORB_RESPAWN_DELAY = 15;    // 15s respawn efter kill
const ARENA_ORB_HEAL_PCT = 0.30;
const ARENA_ORB_SHIELD_PCT = 0.30;
const ARENA_PREP_TIME = 60;
const ARENA_ROUND_END_PAUSE = 4;
const ARENA_BO5_WINS_NEEDED = 3;
const ARENA_GOLD_PER_ROUND = 250;          // alla får 250 vid round-end
const ARENA_GOLD_WIN_BONUS = 500;          // winners får 500 extra
const ARENA_GOLD_START = 400;              // start-gold per spelare i runda 1

// Team-helpers för 2v2: side 1+3 = team A, side 2+4 = team B
function arenaTeamOf(idx) { return (idx === 1 || idx === 3) ? 'A' : 'B'; }
function arenaTeamRep(team) { return team === 'A' ? 1 : 2; }
function arenaSideIdxs() {
  return APP.arenaTeamSize === 2 ? [1, 2, 3, 4] : [1, 2];
}
function arenaTeamMates(team) {
  if (APP.arenaTeamSize === 2) {
    return team === 'A' ? [1, 3] : [2, 4];
  }
  return team === 'A' ? [1] : [2];
}
function arenaOppTeamSides(side) {
  const oppTeam = arenaTeamOf(side.idx) === 'A' ? 'B' : 'A';
  return arenaTeamMates(oppTeam).map(i => sides[i]).filter(s => s);
}

// Returnerar alla aktiva sidor (filtered null). 1v1: [s1, s2]. 2v2 arena: [s1,s2,s3,s4].
function activeSides() {
  if (APP.gameMode === 'arena1v1' && APP.arenaTeamSize === 2) {
    return [sides[1], sides[2], sides[3], sides[4]].filter(s => s);
  }
  // Boss Wars MP: 3 hjältar
  if (APP.gameMode === 'bosswars' && bossMpState && bossMpState.matchActive) {
    return [sides[1], sides[2], sides[3]].filter(s => s);
  }
  return [sides[1], sides[2]].filter(s => s);
}

// ============================================================
// ARENA: TALENTS PER HERO
// ============================================================

// Pass 1: bara stat-buffar. Skill-modifierande talents (typ "Frost Nova heals")
// kommer i senare pass. Varje talent kostar 1 talent-poäng. En spelare börjar
// med 1 poäng, får +1 per runda och +1 vid runda-vinst.
const ARENA_TALENTS = {
  magiker: [
    // Stat-talents
    { id: 'm_skill',   icon: '✦', name: 'Arcane Mastery',   desc: '+10% skill damage',     stats: { skillDmgPct: 0.10 } },
    { id: 'm_cdr',     icon: '⏱', name: 'Quick Casting',     desc: '+10% cooldown reduction', stats: { cdrPct: 0.10 } },
    { id: 'm_hp',      icon: '❤', name: 'Mana Shield',       desc: '+15% max HP',           stats: { maxHpPct: 0.15 } },
    { id: 'm_dr',      icon: '🛡', name: 'Magic Resistance',  desc: '+10% damage reduction', stats: { dmgReductionPct: 0.10 } },
    { id: 'm_ms',      icon: '💨', name: 'Swift Robes',       desc: '+10% rörelsehastighet', stats: { moveSpeedPct: 0.10 } },
    // Skill-modifiers
    { id: 'm_frost_heal', icon: '❄', name: 'Frost Vampirism', desc: 'Frost Nova healar dig 15% av skadan den gör' },
    { id: 'm_drain_extend', icon: '💀', name: 'Lasting Drain',  desc: 'Soul Drain pågår 2s längre (5s → 7s)' },
    { id: 'm_bh_radius',  icon: '⚫', name: 'Singularity',     desc: 'Black Hole-radie + explosionsradie +30%' },
  ],
  legolas: [
    // Stat-talents
    { id: 'l_dmg',     icon: '🏹', name: 'Marksman Training', desc: '+5 attack damage',      stats: { attackDmg: 5 } },
    { id: 'l_as',      icon: '⚡', name: 'Quick Draw',        desc: '+15% attack speed',     stats: { attackSpeedPct: 0.15 } },
    { id: 'l_crit',    icon: '🎯', name: 'Sharpshooter',      desc: '+10% crit chans',       stats: { critChancePct: 0.10 } },
    { id: 'l_ms',      icon: '💨', name: 'Light Boots',       desc: '+10% rörelsehastighet', stats: { moveSpeedPct: 0.10 } },
    { id: 'l_cdr',     icon: '⏱', name: 'Forest Sense',      desc: '+10% cooldown reduction', stats: { cdrPct: 0.10 } },
    // Skill-modifiers
    { id: 'l_vine_dot',   icon: '🌿', name: 'Toxic Roots',     desc: 'Vine Trap DoT dubbel skada' },
    { id: 'l_focus_dur',  icon: '🎯', name: 'Patient Hunter',  desc: 'Hunter\'s Focus håller 2s längre' },
    { id: 'l_dash_buff',  icon: '💨', name: 'Phantom Dash',    desc: 'Shadow Dash lifesteal 20% → 50%' },
  ],
  gimlu: [
    // Stat-talents
    { id: 'g_hp',      icon: '💪', name: 'Iron Body',         desc: '+20% max HP',           stats: { maxHpPct: 0.20 } },
    { id: 'g_dr',      icon: '🪨', name: 'Stone Skin',        desc: '+15% damage reduction', stats: { dmgReductionPct: 0.15 } },
    { id: 'g_dmg',     icon: '🔨', name: 'Forged Strength',   desc: '+5 attack damage',      stats: { attackDmg: 5 } },
    { id: 'g_as',      icon: '⚔', name: 'Battle Rhythm',     desc: '+10% attack speed',     stats: { attackSpeedPct: 0.10 } },
    { id: 'g_regen',   icon: '✨', name: 'Stalwart Vigor',    desc: '+1% HP regen per sek',  stats: { healPerSecPct: 0.01 } },
    // Skill-modifiers
    { id: 'g_taunt_heal', icon: '📢', name: 'Vengeful Roar',   desc: 'Titan\'s Taunt heal +50% (20% → 30% av maxHP/s)' },
    { id: 'g_iron_radius',icon: '🛡', name: 'Wrath Unleashed', desc: 'Iron Will explosionsradie +30%' },
    { id: 'g_hammer_full',icon: '🔨', name: 'Mighty Throw',    desc: 'Hammer återvänder med 100% skada (var 50%)' },
  ],
  aragurn: [
    // Stat-talents
    { id: 'a_dmg',     icon: '⚔', name: 'Honed Blade',        desc: '+6 attack damage',      stats: { attackDmg: 6 } },
    { id: 'a_hp',      icon: '💪', name: 'Battle Hardened',    desc: '+15% max HP',           stats: { maxHpPct: 0.15 } },
    { id: 'a_as',      icon: '⚡', name: 'Swift Strikes',      desc: '+12% attack speed',     stats: { attackSpeedPct: 0.12 } },
    { id: 'a_dr',      icon: '🛡', name: 'Plate Mastery',      desc: '+12% damage reduction', stats: { dmgReductionPct: 0.12 } },
    { id: 'a_ms',      icon: '💨', name: 'Light Steps',        desc: '+10% rörelsehastighet', stats: { moveSpeedPct: 0.10 } },
    // Skill-modifiers
    { id: 'a_spin_extend', icon: '🌀', name: 'Endless Spin',  desc: 'Whirlwind pågår 1.5s längre (3s → 4.5s)' },
    { id: 'a_shout_radius',icon: '📣', name: 'Booming Voice', desc: 'Shout-konen +30% längre och bredare' },
    { id: 'a_leap_heal',   icon: '🩹', name: 'Battle Lust',    desc: 'Hero Leap healar +50% per träffad fiende (10%→15%)' },
  ],
};

// Helper för att kolla om sidan valt en specifik talent i arenan
function arenaHasTalent(side, talentId) {
  if (APP.gameMode !== 'arena1v1') return false;
  const t = arenaState.talents[side.idx];
  return !!(t && t.chosen && t.chosen.includes(talentId));
}

// ============================================================
// ARENA: SCEN (golv + cover-props + orb)
// ============================================================

const arenaSceneGroup = new THREE.Group();
arenaSceneGroup.visible = false;
arenaSceneGroup.userData.isArena = true;
scene.add(arenaSceneGroup);

// === BOSS WARS ARENA ===
// 5 olika maps (en per boss), 20% större än innan, olika former.
const BOSSWARS_CX = 0;
const BOSSWARS_CZ = 90;
const BOSSWARS_RADIUS = 30;   // 25 × 1.2 = 30 (20% större)

// Rum-system: hjältarna spawnar i ett separat rum, springer genom en korridor
// in i boss-rummet. När alla är inne aktiveras bossen + en gate stängs så
// ingen kan springa ut. Alla mått relativt världs-origin.
const BOSS_GATE_X = BOSSWARS_CX - BOSSWARS_RADIUS;   // -30 — boss-rummets västsida
const CORRIDOR_LENGTH = 22;
const CORRIDOR_WIDTH = 9;
const CORRIDOR_HALF_W = CORRIDOR_WIDTH / 2;
const CORRIDOR_X_MIN = BOSS_GATE_X - CORRIDOR_LENGTH;   // -52
const CORRIDOR_X_MAX = BOSS_GATE_X;                       // -30
const SPAWN_ROOM_SIZE = 24;
const SPAWN_ROOM_HALF = SPAWN_ROOM_SIZE / 2;
const SPAWN_ROOM_CX = CORRIDOR_X_MIN - SPAWN_ROOM_HALF;   // -64
const SPAWN_ROOM_CZ = BOSSWARS_CZ;                          // 90
// Gate-thickness — used for visual mesh + walkability "wall" when stängd
const GATE_THICKNESS = 0.5;
// Map-config per tier — shape, color-tema, ev. accent
const BOSSWARS_MAPS = {
  1: { name: 'Stone Arena',    shape: 'circle',  color: 0x6a5a44, edgeColor: 0x2a2218, accent: 0x9a8a6a },
  2: { name: 'Forest Hollow',  shape: 'square',  color: 0x4a5a36, edgeColor: 0x1a2410, accent: 0x6a8a4a },
  3: { name: 'Heavenly Cross', shape: 'cross',   color: 0xc8d4e0, edgeColor: 0x8090a0, accent: 0xffe8a0 },
  4: { name: 'Bloodmoon Keep', shape: 'octagon', color: 0x3a2030, edgeColor: 0x100808, accent: 0x6a0a0a },
  5: { name: 'Volcano Crater', shape: 'hexagon', color: 0x40180c, edgeColor: 0x100400, accent: 0xff5010 },
};
const bossWarsSceneGroup = new THREE.Group();
bossWarsSceneGroup.visible = false;
bossWarsSceneGroup.userData.isBossWars = true;
scene.add(bossWarsSceneGroup);

function clearBossWarsScene() {
  while (bossWarsSceneGroup.children.length) {
    const c = bossWarsSceneGroup.children[0];
    c.traverse?.(o => {
      if (o.isMesh) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
          else o.material.dispose();
        }
      }
    });
    bossWarsSceneGroup.remove(c);
  }
  bossWarsSceneGroup.userData.builtForTier = -1;
  // Rensa gate-referenser så de inte pekar på disposed meshes vid rebuild
  bossWarsSceneGroup.userData.gate = null;
  bossWarsSceneGroup.userData.gateGlow = null;
}

// Bygger en shape-yta baserat på map.shape
function makeBossWarsShapeMesh(shape, r, mat) {
  if (shape === 'square') {
    const side = r * Math.SQRT2;   // diagonal matchar circle-radius
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(side, side), mat);
    plane.rotation.x = -Math.PI / 2;
    return plane;
  }
  if (shape === 'hexagon') {
    return new THREE.Mesh(new THREE.CircleGeometry(r, 6), mat);
  }
  if (shape === 'octagon') {
    return new THREE.Mesh(new THREE.CircleGeometry(r, 8), mat);
  }
  if (shape === 'cross') {
    // Plus/cross-form med två rektanglar
    const grp = new THREE.Group();
    const armLen = r * 1.8;
    const armWidth = r * 0.85;
    const a = new THREE.Mesh(new THREE.PlaneGeometry(armLen, armWidth), mat);
    a.rotation.x = -Math.PI / 2;
    const b = new THREE.Mesh(new THREE.PlaneGeometry(armWidth, armLen), mat);
    b.rotation.x = -Math.PI / 2;
    grp.add(a); grp.add(b);
    return grp;
  }
  // Default: cirkel
  const c = new THREE.Mesh(new THREE.CircleGeometry(r, 64), mat);
  c.rotation.x = -Math.PI / 2;
  return c;
}

function buildBossWarsScene() {
  const tier = (APP.bossWars && APP.bossWars.tier) || 1;
  if (bossWarsSceneGroup.userData.builtForTier === tier) return;
  clearBossWarsScene();
  bossWarsSceneGroup.userData.builtForTier = tier;
  const map = BOSSWARS_MAPS[tier] || BOSSWARS_MAPS[1];
  const r = BOSSWARS_RADIUS;
  // Slät procedurell stentextur (LINEAR-filter mot pixel-look)
  const floorCanvas = document.createElement('canvas');
  floorCanvas.width = floorCanvas.height = 512;
  const fctx = floorCanvas.getContext('2d');
  const baseHex = '#' + map.color.toString(16).padStart(6, '0');
  fctx.fillStyle = baseHex;
  fctx.fillRect(0, 0, 512, 512);
  // Slätare golv: färre + större + mjukare radial gradients, INGA sprickor
  // (sprickorna gav synliga linjer som upplevdes "skrovligt").
  const lightenHex = (hex, amt) => {
    const r2 = Math.max(0, Math.min(255, ((hex >> 16) & 0xff) + amt * 255));
    const g2 = Math.max(0, Math.min(255, ((hex >> 8) & 0xff) + amt * 255));
    const b2 = Math.max(0, Math.min(255, (hex & 0xff) + amt * 255));
    return `rgba(${r2|0},${g2|0},${b2|0},0.22)`;   // lägre alpha = mjukare
  };
  for (let i = 0; i < 10; i++) {
    const gx = Math.random() * 512, gy = Math.random() * 512;
    const gr = 140 + Math.random() * 200;          // större blobs
    const g = fctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
    const tone = Math.random() < 0.5 ? 0.08 : -0.08;   // mindre kontrast
    g.addColorStop(0, lightenHex(map.color, tone));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    fctx.fillStyle = g;
    fctx.fillRect(0, 0, 512, 512);
  }
  const floorTex = new THREE.CanvasTexture(floorCanvas);
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  // Mindre repeat → större "klädd" yta per repeat = mindre synlig tiling
  floorTex.repeat.set(1, 1);
  floorTex.colorSpace = THREE.SRGBColorSpace;
  floorTex.magFilter = THREE.LinearFilter;
  floorTex.minFilter = THREE.LinearMipmapLinearFilter;
  floorTex.anisotropy = 16;
  // Underliggande cylinder för "tjocklek" — samma färg som edge så det inte stick ut.
  // Alla tier använder samma cirkulära platform så walkability är konsistent
  // (tidigare shape-varianter skapade gaps vid korridor-ingången → hjältarna fastnade).
  const baseR = r;
  const baseCyl = new THREE.Mesh(new THREE.CylinderGeometry(baseR, baseR + 0.5, 0.4, 48), new THREE.MeshStandardMaterial({ color: map.edgeColor, roughness: 0.92 }));
  baseCyl.position.set(BOSSWARS_CX, 0.2, BOSSWARS_CZ);
  baseCyl.receiveShadow = true;
  baseCyl.castShadow = false;
  bossWarsSceneGroup.add(baseCyl);
  // Topp-yta = cirkel oavsett map.shape (tier-distinktion via färg/accent)
  const topMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.88, metalness: 0.08 });
  const top = new THREE.Mesh(new THREE.CircleGeometry(r - 0.4, 64), topMat);
  top.rotation.x = -Math.PI / 2;
  top.position.set(BOSSWARS_CX, 0.42, BOSSWARS_CZ);
  top.receiveShadow = true;
  bossWarsSceneGroup.add(top);
  // Accent-ring/mönster för visuell smak (cirkel-emblem i mitten oavsett shape)
  const accentRing = new THREE.Mesh(
    new THREE.RingGeometry(r * 0.35, r * 0.42, 48),
    new THREE.MeshBasicMaterial({ color: map.accent, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
  );
  accentRing.rotation.x = -Math.PI / 2;
  accentRing.position.set(BOSSWARS_CX, 0.44, BOSSWARS_CZ);
  bossWarsSceneGroup.add(accentRing);
  // Inre cirkel
  const innerDot = new THREE.Mesh(
    new THREE.CircleGeometry(r * 0.18, 36),
    new THREE.MeshBasicMaterial({ color: map.accent, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
  );
  innerDot.rotation.x = -Math.PI / 2;
  innerDot.position.set(BOSSWARS_CX, 0.44, BOSSWARS_CZ);
  bossWarsSceneGroup.add(innerDot);

  // ===== SPAWN-RUM (västra) + KORRIDOR + GATE =====
  // Spawn-golvet — mörkare ton än boss-rummet så zonen visuellt skiljer sig.
  const spawnFloorMat = new THREE.MeshStandardMaterial({
    color: map.edgeColor,
    roughness: 0.92,
    metalness: 0.05,
  });
  // Bas-platta under spawn-rummet (samma tjocklek som boss-platformen)
  const spawnBase = new THREE.Mesh(
    new THREE.BoxGeometry(SPAWN_ROOM_SIZE + 1, 0.4, SPAWN_ROOM_SIZE + 1),
    new THREE.MeshStandardMaterial({ color: map.edgeColor, roughness: 0.92 })
  );
  spawnBase.position.set(SPAWN_ROOM_CX, 0.2, SPAWN_ROOM_CZ);
  spawnBase.receiveShadow = true;
  bossWarsSceneGroup.add(spawnBase);
  // Topp-yta för spawn-rummet (kvadratisk plane, samma textur som boss-rummet
  // men lite mörkare ton för att läsa som "förrum")
  const spawnTop = new THREE.Mesh(
    new THREE.PlaneGeometry(SPAWN_ROOM_SIZE, SPAWN_ROOM_SIZE),
    new THREE.MeshStandardMaterial({ map: floorTex, color: 0xb0b0b0, roughness: 0.9 })
  );
  spawnTop.rotation.x = -Math.PI / 2;
  spawnTop.position.set(SPAWN_ROOM_CX, 0.42, SPAWN_ROOM_CZ);
  spawnTop.receiveShadow = true;
  bossWarsSceneGroup.add(spawnTop);
  // Accent-ring i spawn-rumet (visuell pickup-point — säger "stå här")
  const spawnRing = new THREE.Mesh(
    new THREE.RingGeometry(2.4, 3.0, 36),
    new THREE.MeshBasicMaterial({ color: map.accent, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
  );
  spawnRing.rotation.x = -Math.PI / 2;
  spawnRing.position.set(SPAWN_ROOM_CX, 0.44, SPAWN_ROOM_CZ);
  bossWarsSceneGroup.add(spawnRing);

  // Korridor — rektangulär bas + topp
  const corrCX = (CORRIDOR_X_MIN + CORRIDOR_X_MAX) / 2;   // mid-x
  const corrBase = new THREE.Mesh(
    new THREE.BoxGeometry(CORRIDOR_LENGTH + 0.5, 0.4, CORRIDOR_WIDTH + 0.5),
    new THREE.MeshStandardMaterial({ color: map.edgeColor, roughness: 0.92 })
  );
  corrBase.position.set(corrCX, 0.2, BOSSWARS_CZ);
  corrBase.receiveShadow = true;
  bossWarsSceneGroup.add(corrBase);
  const corrTop = new THREE.Mesh(
    new THREE.PlaneGeometry(CORRIDOR_LENGTH, CORRIDOR_WIDTH),
    new THREE.MeshStandardMaterial({ map: floorTex, color: 0xc8c8c8, roughness: 0.9 })
  );
  corrTop.rotation.x = -Math.PI / 2;
  corrTop.position.set(corrCX, 0.42, BOSSWARS_CZ);
  corrTop.receiveShadow = true;
  bossWarsSceneGroup.add(corrTop);

  // GATE — synlig portal vid boss-rummets ingång. Vid match-start är gaten öppen
  // (gaten är BARA visible när stängd, dvs efter att alla heroes är inne).
  // Vi sparar referens på bossWarsSceneGroup.userData så vi kan toggla via state.
  const gateMat = new THREE.MeshStandardMaterial({
    color: 0x3a2a18,
    roughness: 0.75,
    emissive: 0x442211,
    emissiveIntensity: 0.6,
    transparent: true,
    opacity: 0.92,
  });
  const gate = new THREE.Mesh(
    new THREE.BoxGeometry(GATE_THICKNESS, 5, CORRIDOR_WIDTH + 1),
    gateMat
  );
  gate.position.set(BOSS_GATE_X, 2.5, BOSSWARS_CZ);
  gate.castShadow = false;
  gate.receiveShadow = true;
  gate.visible = false;   // dolt tills bossActivated
  bossWarsSceneGroup.add(gate);
  // Lite glödande accent på gaten (lila/rosa pulserande när stängd)
  const gateGlow = new THREE.Mesh(
    new THREE.BoxGeometry(GATE_THICKNESS + 0.4, 5.2, CORRIDOR_WIDTH + 1.4),
    new THREE.MeshBasicMaterial({ color: 0xff44aa, transparent: true, opacity: 0.18, depthWrite: false })
  );
  gateGlow.position.copy(gate.position);
  gateGlow.visible = false;
  bossWarsSceneGroup.add(gateGlow);
  bossWarsSceneGroup.userData.gate = gate;
  bossWarsSceneGroup.userData.gateGlow = gateGlow;
}

// Walkable area i boss wars = spawn-rum + korridor + boss-rum (+ gate-block om stängd).
// Boss-rum är ALLTID en cirkel oavsett tier (visuell shape är fortfarande tier-specifik
// via top-mesh, men walkability är konsistent). Tidigare hade tier 2 (square) och
// tier 3 (cross) walkable areas som lämnade gap mellan korridor-slut och boss-rumsedge
// → hjältarna fastnade vid ingången. Cirkel-walkability garanterar smooth övergång.
function isBossWarsPos(x, z) {
  // 1) Gate-block: när gaten är stängd får man INTE passera genom korridor-utgången.
  if (APP.bossWars && APP.bossWars.gateClosed) {
    const inGateBand = Math.abs(x - BOSS_GATE_X) < (GATE_THICKNESS / 2 + 0.45);
    const inGateZ = Math.abs(z - BOSSWARS_CZ) < (CORRIDOR_HALF_W + 0.4);
    if (inGateBand && inGateZ) return false;
  }
  // 2) Spawn-rum (kvadrat västra sidan)
  const sdx = x - SPAWN_ROOM_CX, sdz = z - SPAWN_ROOM_CZ;
  if (Math.abs(sdx) < SPAWN_ROOM_HALF - 0.5 && Math.abs(sdz) < SPAWN_ROOM_HALF - 0.5) return true;
  // 3) Korridor (rektangel mellan spawn-rum och boss-rum, med 6m overlap in i boss-rummet)
  if (x >= CORRIDOR_X_MIN - 0.5 && x <= CORRIDOR_X_MAX + 6 &&
      Math.abs(z - BOSSWARS_CZ) < CORRIDOR_HALF_W - 0.3) return true;
  // 4) Boss-rum: alltid cirkel oavsett tier-shape
  const dx = x - BOSSWARS_CX, dz = z - BOSSWARS_CZ;
  const r = BOSSWARS_RADIUS - 0.5;
  return (dx * dx + dz * dz) < r * r;
}

// Returnerar true om punkten är inom själva boss-rummet (för "alla inne?"-check).
// Också cirkel-baserad så det matchar isBossWarsPos.
function isInsideBossRoom(x, z) {
  const dx = x - BOSSWARS_CX, dz = z - BOSSWARS_CZ;
  const r = BOSSWARS_RADIUS - 0.5;
  return (dx * dx + dz * dz) < r * r;
}

// Spawnar boss-wars-bossen i centrum av platformen. Återanvänder BOSS_DEFS
// + boss-skill-systemet (tickBossSkills/tickBossAura) som redan funkar för waves.
// Lägger tier-specifika kosmetiska delar på boss-meshen (varulvs-öron, ängel-
// vingar, dracula-cape, drak-horn etc). Returerar gruppen så ev. animation kan
// göras senare.
function attachBossWarsAccessories(mesh, tier, scale) {
  const grp = new THREE.Group();
  // Höjd-faktor — accessoryer placeras relativt mesh-höjd (skel-warrior ~1.7m * scale)
  const h = 1.5;   // local-units (mesh skalas globalt)
  if (tier === 2) {
    // Werewolf: ulv-öron (2 cones uppåt), klor på händer, svans
    const furMat = new THREE.MeshStandardMaterial({ color: 0x3a2818, roughness: 0.95 });
    const earL = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.30, 8), furMat);
    earL.position.set(-0.14, h * 1.1, 0); earL.rotation.z = 0.2;
    grp.add(earL);
    const earR = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.30, 8), furMat);
    earR.position.set(0.14, h * 1.1, 0); earR.rotation.z = -0.2;
    grp.add(earR);
    // Svans (cylinder bakom)
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.03, 0.7, 8), furMat);
    tail.position.set(0, h * 0.4, -0.35); tail.rotation.x = 0.7;
    grp.add(tail);
    // Glow under munnen (snäcker)
    const fangs = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.14, 6),
      new THREE.MeshBasicMaterial({ color: 0xffffff }));
    fangs.position.set(0, h * 0.92, 0.18); fangs.rotation.x = Math.PI;
    grp.add(fangs);
  } else if (tier === 3) {
    // Archangel: en SVART vinge + en RÖD vinge — mindre & detaljerad med separata fjäder-pieces
    function makeWing(color, side_) {
      const w = new THREE.Group();
      const featherMat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15, side: THREE.DoubleSide });
      const innerMat = new THREE.MeshStandardMaterial({
        color, roughness: 0.7, metalness: 0.1, side: THREE.DoubleSide,
        emissive: color, emissiveIntensity: 0.12,
      });
      // Vinge-arm: smal bot-cylinder från kroppen som "vingbenet" som fjädrarna fäster på
      const armMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.7 });
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.1, 8), armMat);
      arm.position.set(side_ * 0.55, h * 0.8, -0.18);
      arm.rotation.z = side_ * 0.65;
      arm.rotation.x = -0.25;
      w.add(arm);
      // Två rader av fjädrar — yttre långa primäre fjädrar + inre korta täckfjädrar
      // Primära (yttre, 5 fjädrar): längre, lite svängda
      const primaryLengths = [1.1, 1.25, 1.35, 1.25, 1.05];
      for (let i = 0; i < primaryLengths.length; i++) {
        const len = primaryLengths[i];
        const w_ = 0.18;
        const feather = new THREE.Mesh(new THREE.PlaneGeometry(w_, len), featherMat);
        // Placera utåt-uppåt från armens spets
        const t = (i - (primaryLengths.length - 1) / 2) * 0.18;
        const angleZ = side_ * (0.95 - i * 0.05);
        feather.position.set(side_ * (0.95 + i * 0.10), h * 1.05 + t, -0.22);
        feather.rotation.z = angleZ;
        feather.rotation.y = side_ * 0.35;
        w.add(feather);
      }
      // Sekundära (inre täck-fjädrar, 4 fjädrar): kortare, närmre kroppen
      const secondaryLengths = [0.55, 0.65, 0.62, 0.5];
      for (let i = 0; i < secondaryLengths.length; i++) {
        const len = secondaryLengths[i];
        const feather = new THREE.Mesh(new THREE.PlaneGeometry(0.14, len), innerMat);
        const t = (i - (secondaryLengths.length - 1) / 2) * 0.15;
        feather.position.set(side_ * (0.4 + i * 0.10), h * 0.7 + t, -0.15);
        feather.rotation.z = side_ * (0.7 + i * 0.04);
        feather.rotation.y = side_ * 0.25;
        w.add(feather);
      }
      // Liten "shoulder"-plopp där vingen fäster i kroppen
      const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.10, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.5, metalness: 0.4 }));
      shoulder.position.set(side_ * 0.30, h * 0.7, -0.12);
      w.add(shoulder);
      return w;
    }
    grp.add(makeWing(0x141414, -1));   // vänster: djupt svart
    grp.add(makeWing(0xaa0e0e, 1));    // höger: blod-röd
    // Halo ovanför huvudet (lite mindre)
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(0.26, 0.035, 10, 24),
      new THREE.MeshBasicMaterial({ color: 0xffe8a0, transparent: true, opacity: 0.92 })
    );
    halo.position.set(0, h * 1.22, 0);
    halo.rotation.x = Math.PI / 2;
    grp.add(halo);
  } else if (tier === 4) {
    // Dracula: bat-cape bakom + 2 små horn + skarpa fangs
    const capeMat = new THREE.MeshStandardMaterial({ color: 0x110010, roughness: 0.9, side: THREE.DoubleSide });
    // Cape som triangulär plan bakom
    const cape = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.8), capeMat);
    cape.position.set(0, h * 0.55, -0.35);
    cape.rotation.x = -0.15;
    grp.add(cape);
    // Bat-wings-form (2 mindre triangulära "vingar" på sidorna)
    for (const sx of [-1, 1]) {
      const bw = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.3), capeMat);
      bw.position.set(sx * 0.7, h * 0.7, -0.25);
      bw.rotation.y = sx * 0.5;
      bw.rotation.z = sx * 0.25;
      grp.add(bw);
    }
    // 2 horn på huvudet
    const hornMat = new THREE.MeshStandardMaterial({ color: 0x282028, roughness: 0.6, metalness: 0.5 });
    const hornL = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.28, 8), hornMat);
    hornL.position.set(-0.10, h * 1.15, 0); hornL.rotation.z = 0.3;
    grp.add(hornL);
    const hornR = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.28, 8), hornMat);
    hornR.position.set(0.10, h * 1.15, 0); hornR.rotation.z = -0.3;
    grp.add(hornR);
    // Röda ögon glöd (extra punkt-ljus över befintliga aura)
    const eyeLight = new THREE.PointLight(0xff0000, 1.5, 2.5);
    eyeLight.position.set(0, h * 0.95, 0.18);
    grp.add(eyeLight);
  } else if (tier === 5) {
    // Drake: stora gröna/röda drak-vingar + horn + svans + drak-mun
    const wingMat = new THREE.MeshStandardMaterial({ color: 0x6a1a08, roughness: 0.7, side: THREE.DoubleSide });
    for (const sx of [-1, 1]) {
      // Stor drak-vinge per sida
      for (let i = 0; i < 4; i++) {
        const finger = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 2.5 - i * 0.4), wingMat);
        finger.position.set(sx * (0.8 + i * 0.3), h * 0.9, -0.1);
        finger.rotation.y = sx * 0.6;
        finger.rotation.z = sx * (0.4 + i * 0.1);
        grp.add(finger);
      }
    }
    // Stora horn
    const hornMat = new THREE.MeshStandardMaterial({ color: 0x402418, roughness: 0.5 });
    for (const sx of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.50, 10), hornMat);
      horn.position.set(sx * 0.12, h * 1.10, -0.08);
      horn.rotation.z = sx * 0.4;
      horn.rotation.x = -0.3;
      grp.add(horn);
    }
    // Svans (kedja av cylindrar)
    const tailMat = new THREE.MeshStandardMaterial({ color: 0x401810, roughness: 0.85 });
    for (let i = 0; i < 5; i++) {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.12 - i * 0.018, 0.15 - i * 0.02, 0.35, 8), tailMat);
      seg.position.set(0, h * 0.4 + i * 0.04, -0.4 - i * 0.30);
      seg.rotation.x = 0.4 + i * 0.05;
      grp.add(seg);
    }
    // Drak-mun (eldglöd)
    const fireGlow = new THREE.PointLight(0xff5010, 2.4, 3);
    fireGlow.position.set(0, h * 0.92, 0.25);
    grp.add(fireGlow);
    // Brännhet käke (orange cylinder)
    const jaw = new THREE.Mesh(
      new THREE.SphereGeometry(0.10, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xff7010, transparent: true, opacity: 0.85 })
    );
    jaw.position.set(0, h * 0.92, 0.22);
    grp.add(jaw);
  }
  mesh.add(grp);
  mesh.userData.bossWarsAccessories = grp;
  return grp;
}

function spawnBossWarsBoss(side, tier) {
  if (!side) return;
  const bossInfo = getBossWarsDef(tier);
  if (!bossInfo) return;
  const bossDef = BOSS_DEFS[bossInfo.wave];
  if (!bossDef) return;
  const mesh = makeMonsterMesh();
  // Boss 15% mindre — minska scale med 0.85x (per user request).
  const scale = bossDef.scale * 0.85;
  mesh.scale.set(scale, scale, scale);
  // Tier-specifik tint (override:ar bossDef.bodyTint för werewolf/dracula/etc)
  const tierTints = { 1: 0x6a85a8, 2: 0x6a4a30, 3: 0xeeeae0, 4: 0xc8b8c8, 5: 0x3a2018 };
  applyMonsterTint(mesh, tierTints[tier] || bossDef.bodyTint, 0.85);
  attachBossAura(mesh, bossDef.auraColor, bossDef.eyeColor, scale, false);
  attachBossWarsAccessories(mesh, tier, scale);
  attachHpBar(mesh, scale * 1.0);
  // Boss-HP-bar är alltid synlig (raid-känsla — användaren ska kunna tracka HP
  // även när bossen inte just blivit träffad).
  if (mesh.userData) mesh.userData.hpBarHero = true;
  mesh.position.set(BOSSWARS_CX, 0, BOSSWARS_CZ);
  // Lag-fix: stora boss-meshes castar inga shadows i boss-wars (för dyrt shadow-pass)
  mesh.traverse(o => {
    if (o.isMesh) o.castShadow = false;
  });
  scene.add(mesh);
  const hp = bossInfo.hp;
  // Bumpad bas-dmg: 28 → 42. Bumpad dmgScale i BOSS_WARS_DEFS (1.5–3.5).
  const dmg = Math.round(42 * bossInfo.dmgScale);
  // Speed-skalning per tier — bossar JAGAR nu på riktigt (hero base 5.5–7.0)
  const tierSpeed = { 1: 3.8, 2: 4.3, 3: 4.7, 4: 5.0, 5: 5.4 };
  const bossSpeed = tierSpeed[tier] || 4.0;
  const bossId = nextEntityId++;
  side.monsters.push({
    id: bossId,
    lane: 1,
    hp, maxHp: hp,
    speed: bossSpeed,
    damage: dmg,
    attackType: 'melee',
    attackRange: 2.4,           // bumpad så bossen kan slå utan att klistras in
    attackInterval: 0.9,        // snabbare AA (1.2 → 0.9s)
    pathIndex: 0,
    atkCd: 0, slowTime: 0, slowMul: 1.0, chasing: true,
    isBoss: true, isMiniBoss: false,
    isBossWarsBoss: true,
    bossDef,
    bossName: bossDef.name,
    bossSkills: bossDef.skills,
    skillCds: bossDef.skills.map(s => s.cd * 0.4),  // första cast snabbare
    activeCast: null,
    // 2-phase tracking (gäller alla 5 bossar nu — phase2Skills definierat per wave)
    bossTier: tier,
    bossPhase: 1,
    phase2Skills: BOSS_WARS_PHASE2_SKILLS[bossInfo.wave] || null,
    phaseThreshold: bossInfo.phaseThreshold || 0.5,
    phaseTransitionRemaining: 0,   // sek av "fly up + land"-animation (>0 = oattacker-bar)
    mesh,
  });
  side.bossWarsBossId = bossId;   // för säker check i checkMatchEnd
}

// Boss Wars: kollar om alla aktiva heroes är inne i boss-rummet → aktivera
// bossen + stäng gaten. Idempotent — sätter inte om redan aktiverad.
// Körs host-side (och solo) varje frame i simulateAll-loopen.
function checkBossWarsActivation() {
  if (APP.gameMode !== 'bosswars' || !APP.bossWars || !APP.bossWars.started) return;
  if (APP.bossWars.bossActivated) return;
  // I MP boss-wars: alla 3 peers. I solo: bara sides[1].
  const isMp = bossMpState && bossMpState.matchActive;
  const activeIdxs = isMp ? [1, 2, 3] : [1];
  let allInside = true;
  let anyAlive = false;
  for (const idx of activeIdxs) {
    const s = sides[idx];
    if (!s) { allInside = false; break; }
    if (s.hero.dead) continue;   // döda räknas inte (rare edge-case innan boss aktiverat)
    anyAlive = true;
    if (!isInsideBossRoom(s.hero.x, s.hero.z)) { allInside = false; break; }
  }
  if (!anyAlive || !allInside) return;
  // Alla inne → aktivera + stäng gate
  APP.bossWars.bossActivated = true;
  APP.bossWars.gateClosed = true;
  // Visuellt: gör gate-meshen synlig + spawna FX vid ingången
  if (bossWarsSceneGroup.userData.gate) bossWarsSceneGroup.userData.gate.visible = true;
  if (bossWarsSceneGroup.userData.gateGlow) bossWarsSceneGroup.userData.gateGlow.visible = true;
  spawnSkillCastFx(BOSS_GATE_X, BOSSWARS_CZ, 0xff44aa, 2.4);
  spawnShieldBurstFx(BOSS_GATE_X, BOSSWARS_CZ, 0xff66cc);
  triggerCameraShake(0.4, 0.4);
}

// Klient: applicera bossActivated + gateClosed från host-snapshot.
function applyBossWarsActivationFromSnap(ba, gc) {
  if (!APP.bossWars) return;
  const prevActivated = !!APP.bossWars.bossActivated;
  APP.bossWars.bossActivated = !!ba;
  APP.bossWars.gateClosed = !!gc;
  if (bossWarsSceneGroup.userData.gate) bossWarsSceneGroup.userData.gate.visible = !!gc;
  if (bossWarsSceneGroup.userData.gateGlow) bossWarsSceneGroup.userData.gateGlow.visible = !!gc;
  // Delta-trigga gate-stängnings-FX på klienten också (för "epic moment")
  if (!prevActivated && APP.bossWars.bossActivated) {
    spawnSkillCastFx(BOSS_GATE_X, BOSSWARS_CZ, 0xff44aa, 2.4);
    spawnShieldBurstFx(BOSS_GATE_X, BOSSWARS_CZ, 0xff66cc);
    triggerCameraShake(0.4, 0.4);
  }
}

// Phase 2 aura/glow per tier. Skapar transparent sphere + roterande orbs +
// pulserande pointlight runt boss-meshen. Aktiveras när bossen landar efter
// phase-transition. Idempotent — om mesh redan har userData.phase2Aura
// gör funktionen ingenting.
const BOSS_PHASE2_AURA = {
  1: { color: 0x44ccff, name: 'blue-smoke' },   // Werewolf — blå smoke
  2: { color: 0x55ff44, name: 'green-fire' },   // Forest — grön eld
  3: { color: 0xffe080, name: 'gold-halo'  },   // Angel — gyllene gloria
  4: { color: 0xcc44ff, name: 'purple-shadow' },// Dracula — lila/röd skugga
  5: { color: 0xff5520, name: 'red-fire'    },  // Dragon — orange/röd eld
};
function applyBossPhase2Glow(mesh, tier) {
  if (!mesh || mesh.userData.phase2Aura) return;
  const cfg = BOSS_PHASE2_AURA[tier] || BOSS_PHASE2_AURA[1];
  const color = cfg.color;
  const grp = new THREE.Group();
  // Stor transparent sphere (glow-aura, depthWrite false så den inte skuggar barn)
  const auraMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false,
  });
  const aura = new THREE.Mesh(new THREE.SphereGeometry(2.4, 24, 16), auraMat);
  aura.position.y = 1.6;
  grp.add(aura);
  // Inre tätare sphere (pulserar i takt)
  const coreMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
  });
  const core = new THREE.Mesh(new THREE.SphereGeometry(1.55, 20, 14), coreMat);
  core.position.y = 1.6;
  grp.add(core);
  // 3 orbiterande wisps (planes som spinner runt mesh)
  const wisps = [];
  const wispMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false,
  });
  for (let i = 0; i < 3; i++) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 1.4), wispMat);
    const ang = (i / 3) * Math.PI * 2;
    w.position.set(Math.cos(ang) * 2.0, 1.4 + (i - 1) * 0.4, Math.sin(ang) * 2.0);
    w.userData.orbitAngle = ang;
    grp.add(w);
    wisps.push(w);
  }
  // Pulserande pointlight (raid-känsla)
  const light = new THREE.PointLight(color, 2.0, 8);
  light.position.y = 1.8;
  grp.add(light);
  mesh.add(grp);
  mesh.userData.phase2Aura = { grp, aura, core, wisps, light, baseY: 1.6, color, age: 0 };
}
function tickBossPhase2Aura(mesh, dt) {
  const a = mesh && mesh.userData && mesh.userData.phase2Aura;
  if (!a) return;
  a.age += dt;
  // Pulserande opacity (2 Hz)
  const pulse = 0.5 + 0.5 * Math.sin(a.age * 4);
  if (a.aura.material) a.aura.material.opacity = 0.18 + 0.10 * pulse;
  if (a.core.material) a.core.material.opacity = 0.30 + 0.15 * pulse;
  if (a.light) a.light.intensity = 1.6 + 0.7 * pulse;
  // Wisps orbiterar
  for (let i = 0; i < a.wisps.length; i++) {
    const w = a.wisps[i];
    w.userData.orbitAngle += dt * (1.2 + i * 0.15);
    const r = 1.9 + Math.sin(a.age * 2 + i) * 0.3;
    w.position.x = Math.cos(w.userData.orbitAngle) * r;
    w.position.z = Math.sin(w.userData.orbitAngle) * r;
    w.lookAt(0, w.position.y, 0);  // Vänd alltid mot mesh-centrum (billboard-effekt)
  }
}

// Phase-transition: trigga vid 50% HP. Push back + stun heroes, boss flyger upp,
// landar med nya skills.
function triggerBossPhaseTransition(side, boss) {
  if (!boss || boss.bossPhase !== 1 || !boss.phase2Skills) return;
  boss.bossPhase = 2;
  // Avbryt eventuell pågående cast och rensa dess visuals
  if (boss.activeCast) {
    cleanupTelegraphMesh(boss.activeCast);
    cleanupExecuteMesh(boss.activeCast);
    boss.activeCast = null;
  }
  // Push-back + stun alla aktiva heroes i bossWars
  for (const idx of [1, 2, 3, 4]) {
    const s = sides[idx];
    if (!s || s.hero.dead) continue;
    // Stun 3s — använd frozenTime som hård-stun
    s.hero.frozenTime = Math.max(s.hero.frozenTime || 0, 3.0);
    // Push back 6m från bossen
    const dx = s.hero.x - boss.mesh.position.x;
    const dz = s.hero.z - boss.mesh.position.z;
    const d = Math.hypot(dx, dz) || 1;
    const nx = s.hero.x + (dx / d) * 6;
    const nz = s.hero.z + (dz / d) * 6;
    s.hero.x = nx;
    s.hero.z = nz;
    if (s.mesh) s.mesh.position.set(nx, 0, nz);
    spawnSkillCastFx(boss.mesh.position.x, boss.mesh.position.z, 0xff44aa, 4.0);
  }
  // Boss flyger upp + landar (~2.5s total). Under den tiden tar bossen ingen skada
  // (phaseTransitionRemaining > 0). Vi animerar y-pos i monster-loopen.
  boss.phaseTransitionRemaining = 2.5;
  boss.phaseTransitionTotal = 2.5;
  // Byt skill-set när transition är klar (sker i tick)
  boss._pendingPhase2 = true;
  // Visuell shake + burst
  triggerCameraShake(0.6, 0.6);
  spawnShieldBurstFx(boss.mesh.position.x, boss.mesh.position.z, 0xff44ff);
}

let arenaOrbMesh = null;     // Three.js Group för orb
let arenaOrbLight = null;
let arenaOrbBuilt = false;

function makeArenaProp(type) {
  const g = new THREE.Group();
  if (type === 'rock') {
    const r = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.9 + Math.random() * 0.4, 0),
      new THREE.MeshStandardMaterial({ color: 0x6a6660, roughness: 0.95 })
    );
    r.position.y = 0.5;
    r.scale.y = 0.85 + Math.random() * 0.3;
    r.castShadow = true;
    r.receiveShadow = true;
    g.add(r);
  } else if (type === 'wall') {
    // Trasig mur: 3 staplade stenblock med slight slumpighet
    const blockMat = new THREE.MeshStandardMaterial({ color: 0x807060, roughness: 0.88 });
    for (let i = 0; i < 3; i++) {
      const block = new THREE.Mesh(
        new THREE.BoxGeometry(2 + Math.random() * 0.3, 0.55, 0.7),
        blockMat
      );
      block.position.set((Math.random() - 0.5) * 0.3, 0.3 + i * 0.6, (Math.random() - 0.5) * 0.15);
      block.rotation.y = (Math.random() - 0.5) * 0.18;
      block.castShadow = true;
      block.receiveShadow = true;
      g.add(block);
    }
    // Krossad sten vid foten
    const rubble = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.4, 0),
      blockMat
    );
    rubble.position.set(1.1, 0.2, 0.4);
    rubble.castShadow = true;
    g.add(rubble);
  } else if (type === 'pillar') {
    // Trasig pelare
    const p = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.65, 2.2, 12),
      new THREE.MeshStandardMaterial({ color: 0x9a9a92, roughness: 0.85 })
    );
    p.position.y = 1.1;
    p.castShadow = true;
    g.add(p);
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 0.28, 1.1),
      new THREE.MeshStandardMaterial({ color: 0xaaaaa0, roughness: 0.85 })
    );
    cap.position.y = 2.34;
    cap.castShadow = true;
    g.add(cap);
    // Avbruten topp
    const broken = new THREE.Mesh(
      new THREE.ConeGeometry(0.35, 0.5, 6),
      new THREE.MeshStandardMaterial({ color: 0x888880, roughness: 0.9 })
    );
    broken.position.set(0.3, 2.7, 0);
    broken.rotation.set(0.4, 0, -0.3);
    broken.castShadow = true;
    g.add(broken);
  } else if (type === 'wagon') {
    // Övergiven krachad vagn
    const wood = new THREE.MeshStandardMaterial({ color: 0x6a4022, roughness: 0.88 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.0, 1.6), wood);
    body.position.y = 0.65;
    body.rotation.z = 0.35;
    body.castShadow = true;
    g.add(body);
    // Sidor — ger högre profile för bättre cover
    for (const dx of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.8, 1.5), wood);
      side.position.set(dx * 1.65, 1.1, 0);
      side.rotation.z = 0.35;
      side.castShadow = true;
      g.add(side);
    }
    // Bak-/framstycke
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.8, 1.5), wood);
    back.position.set(-1.65, 1.1, 0);
    back.rotation.z = 0.35;
    g.add(back);
    // Hjul
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x2a1a08, roughness: 0.85 });
    for (const [dx, dz] of [[-1.0, 0.95], [1.0, 0.95], [-1.0, -0.95]]) {
      const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.13, 8, 20), wheelMat);
      wheel.position.set(dx, 0.5, dz);
      wheel.rotation.y = Math.PI / 2;
      wheel.castShadow = true;
      g.add(wheel);
    }
    // Brutet hjul som ligger bredvid
    const brokenWheel = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.13, 8, 20), wheelMat);
    brokenWheel.position.set(1.4, 0.13, -0.95);
    brokenWheel.rotation.set(Math.PI / 2, 0, 0.2);
    brokenWheel.castShadow = true;
    g.add(brokenWheel);
    // Vält axel sticker ut
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.10, 1.6, 8), wheelMat);
    axle.position.set(1.0, 0.5, 0);
    axle.rotation.x = Math.PI / 2;
    g.add(axle);
  } else if (type === 'fallenTower') {
    // Fallet torn: lång stencylinder liggande på sidan + topp + spillrar
    const stone = new THREE.MeshStandardMaterial({ color: 0x8a7e6c, roughness: 0.88 });
    const stoneCrack = new THREE.MeshStandardMaterial({ color: 0x6e6354, roughness: 0.92 });
    // Huvud-cylinder (sektion 1)
    const sect1 = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 3.0, 14), stone);
    sect1.rotation.z = Math.PI / 2;
    sect1.position.set(-1.7, 1.0, 0);
    sect1.castShadow = true;
    sect1.receiveShadow = true;
    g.add(sect1);
    // Sektion 2 — något fristående, lite roterad
    const sect2 = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.0, 2.0, 14), stoneCrack);
    sect2.rotation.set(0, 0.08, Math.PI / 2 + 0.08);
    sect2.position.set(1.0, 0.95, 0.15);
    sect2.castShadow = true;
    g.add(sect2);
    // Sektion 3 — sista biten med taggig topp
    const sect3 = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.95, 1.2, 12), stone);
    sect3.rotation.set(0, -0.05, Math.PI / 2 - 0.12);
    sect3.position.set(2.7, 0.85, -0.10);
    sect3.castShadow = true;
    g.add(sect3);
    // Topp (krenelering — små block)
    const battleMat = new THREE.MeshStandardMaterial({ color: 0xa89e8a, roughness: 0.85 });
    for (let i = 0; i < 4; i++) {
      const block = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, 0.3), battleMat);
      block.position.set(3.25 + i * 0.05, 1.2 + (i % 2) * 0.1, -0.5 + i * 0.35);
      block.rotation.y = i * 0.4;
      block.castShadow = true;
      g.add(block);
    }
    // Spillror runt foten
    const rubMat = new THREE.MeshStandardMaterial({ color: 0x6a6258, roughness: 0.92 });
    for (let i = 0; i < 5; i++) {
      const r = new THREE.Mesh(new THREE.DodecahedronGeometry(0.25 + Math.random() * 0.15, 0), rubMat);
      r.position.set(-2.5 + i * 1.3 + (Math.random() - 0.5) * 0.4, 0.15, 0.95 + (Math.random() - 0.5) * 0.3);
      r.castShadow = true;
      g.add(r);
    }
  }
  return g;
}

// Är (x,z) inuti någon arena-cover-prop? Används för rörelse- och projektil-blocking.
function isArenaCoverAt(x, z) {
  if (APP.gameMode !== 'arena1v1') return false;
  for (const p of ARENA_CFG.props) {
    if (!p.collision) continue;
    const dx = x - p.x;
    const dz = z - (ARENA_Z_OFFSET + p.z);
    if (p.collision.shape === 'circle') {
      const r = p.collision.radius;
      if (dx * dx + dz * dz < r * r) return true;
    } else if (p.collision.shape === 'box') {
      if (Math.abs(dx) < p.collision.halfX && Math.abs(dz) < p.collision.halfZ) return true;
    }
  }
  return false;
}

function makeArenaOrbMesh() {
  const grp = new THREE.Group();
  // Core: glowing sphere
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.7, 1),
    new THREE.MeshStandardMaterial({
      color: 0x55ffcc, emissive: 0x22aa88, emissiveIntensity: 1.4,
      roughness: 0.25, metalness: 0.4,
    })
  );
  core.position.y = 1.3;
  core.castShadow = true;
  grp.add(core);
  grp.userData.core = core;
  // Outer halo
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(1.0, 18, 14),
    new THREE.MeshBasicMaterial({ color: 0x66ffdd, transparent: true, opacity: 0.18 })
  );
  halo.position.y = 1.3;
  grp.add(halo);
  grp.userData.halo = halo;
  // Pillar bas
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 0.8, 0.3, 10),
    new THREE.MeshStandardMaterial({ color: 0x556680, roughness: 0.65, metalness: 0.55 })
  );
  base.position.y = 0.15;
  base.castShadow = true;
  base.receiveShadow = true;
  grp.add(base);
  // Pointlight
  const light = new THREE.PointLight(0x66ffcc, 1.2, 8, 2);
  light.position.y = 1.3;
  grp.add(light);
  grp.userData.light = light;
  attachHpBar(grp, 2.7);
  return grp;
}

// Arena-fackla: cylindrisk stenfot + skål + flammor som flickrar
function makeArenaBrazier() {
  const grp = new THREE.Group();
  // Stenfot
  const foot = new THREE.Mesh(
    new THREE.CylinderGeometry(0.45, 0.55, 1.8, 12),
    new THREE.MeshStandardMaterial({ color: 0x4a4238, roughness: 0.9 })
  );
  foot.position.y = 0.9;
  foot.castShadow = true;
  grp.add(foot);
  // Skål
  const bowl = new THREE.Mesh(
    new THREE.CylinderGeometry(0.65, 0.45, 0.3, 14),
    new THREE.MeshStandardMaterial({ color: 0x2a221a, roughness: 0.85, metalness: 0.3 })
  );
  bowl.position.y = 1.95;
  bowl.castShadow = true;
  grp.add(bowl);
  // Coal-glow
  const coals = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.55, 0.08, 12),
    new THREE.MeshStandardMaterial({ color: 0xff5522, emissive: 0xff3311, emissiveIntensity: 1.5 })
  );
  coals.position.y = 2.12;
  grp.add(coals);
  // Flammor (3 koner) som ska animeras via animateSceneProps
  const flames = [];
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xff8a30, transparent: true, opacity: 0.85 });
  for (let i = 0; i < 3; i++) {
    const fl = new THREE.Mesh(new THREE.ConeGeometry(0.32 - i * 0.06, 0.9 + i * 0.2, 8), flameMat);
    fl.position.set((Math.random() - 0.5) * 0.18, 2.55 + i * 0.15, (Math.random() - 0.5) * 0.18);
    grp.add(fl);
    flames.push(fl);
  }
  // Pointlight som flickar
  const light = new THREE.PointLight(0xff7a30, 1.8, 18, 2);
  light.position.y = 2.6;
  grp.add(light);
  grp.userData.flames = flames;
  grp.userData.light = light;
  return grp;
}

const arenaBraziers = []; // för animation

function clearArenaScene() {
  while (arenaSceneGroup.children.length) {
    const c = arenaSceneGroup.children[0];
    c.traverse?.(o => {
      if (o.isMesh) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
          else o.material.dispose();
        }
      }
    });
    arenaSceneGroup.remove(c);
  }
  arenaBraziers.length = 0;
  arenaOrbBuilt = false;
  arenaOrbMesh = null;
  shrinkRingMesh = null;     // återskapas vid nästa shrink-tick
  shrinkSmokeMesh = null;
  arenaSceneGroup.userData.mapIdx = -1;
}

function buildArenaScene() {
  const wantedMapIdx = (arenaState && arenaState.mapIdx) || 0;
  if (arenaSceneGroup.children.length && arenaSceneGroup.userData.mapIdx === wantedMapIdx) return;
  if (arenaSceneGroup.children.length) clearArenaScene();
  setArenaMap(wantedMapIdx);
  arenaSceneGroup.userData.mapIdx = wantedMapIdx;
  // Golv — dubbel storlek (100x70) med procedurell sand/sten-textur
  const tintR = (ARENA_CFG.floorTint >> 16) & 0xff;
  const tintG = (ARENA_CFG.floorTint >> 8) & 0xff;
  const tintB = ARENA_CFG.floorTint & 0xff;
  const floorTex = makeNoiseTexture([tintR + 36, tintG + 32, tintB + 26], 0.22, {
    w: 256, h: 256, repeatX: 8, repeatY: 6,
    specks: 1800, speckColor: [40, 32, 24], streaks: false,
  });
  // Tillsätt sprickor + större stenar via 2D-canvas-overlay
  const fc = document.createElement('canvas');
  fc.width = 512; fc.height = 384;
  const fctx = fc.getContext('2d');
  // Bas-färg per map (tint från ARENA_CFG.floorTint)
  fctx.fillStyle = `#${ARENA_CFG.floorTint.toString(16).padStart(6, '0')}`;
  fctx.fillRect(0, 0, fc.width, fc.height);
  // Bas-brus
  const baseTex = floorTex.image;
  fctx.drawImage(baseTex, 0, 0, fc.width, fc.height);
  // Sprickor — slumpade tunna mörka linjer
  fctx.lineCap = 'round';
  for (let i = 0; i < 22; i++) {
    fctx.strokeStyle = `rgba(20,16,12,${0.45 + Math.random() * 0.3})`;
    fctx.lineWidth = 1 + Math.random() * 1.2;
    const x0 = Math.random() * fc.width, y0 = Math.random() * fc.height;
    const segs = 3 + (Math.random() * 4 | 0);
    let cx = x0, cy = y0;
    fctx.beginPath();
    fctx.moveTo(cx, cy);
    for (let s = 0; s < segs; s++) {
      cx += (Math.random() - 0.5) * 60;
      cy += (Math.random() - 0.5) * 60;
      fctx.lineTo(cx, cy);
    }
    fctx.stroke();
  }
  // Större stenar (mörka prickar)
  for (let i = 0; i < 60; i++) {
    const r = 2 + Math.random() * 5;
    const x = Math.random() * fc.width, y = Math.random() * fc.height;
    fctx.fillStyle = `rgba(45,35,26,${0.5 + Math.random() * 0.3})`;
    fctx.beginPath();
    fctx.arc(x, y, r, 0, Math.PI * 2);
    fctx.fill();
    // Liten highlight på toppen
    fctx.fillStyle = `rgba(140,118,90,0.4)`;
    fctx.beginPath();
    fctx.arc(x - r * 0.3, y - r * 0.3, r * 0.4, 0, Math.PI * 2);
    fctx.fill();
  }
  const detailedFloorTex = new THREE.CanvasTexture(fc);
  detailedFloorTex.wrapS = detailedFloorTex.wrapT = THREE.RepeatWrapping;
  detailedFloorTex.repeat.set(3, 2);
  detailedFloorTex.colorSpace = THREE.SRGBColorSpace;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(100, 70),
    new THREE.MeshStandardMaterial({ map: detailedFloorTex, roughness: 0.95 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, ARENA_Z_OFFSET);
  floor.receiveShadow = true;
  arenaSceneGroup.add(floor);

  // 4 facklor i arena-hörnen (innanför perimeter-väggarna)
  const brazPos = [
    [-44 + 4, ARENA_Z_OFFSET - 28 + 4],
    [ 44 - 4, ARENA_Z_OFFSET - 28 + 4],
    [-44 + 4, ARENA_Z_OFFSET + 28 - 4],
    [ 44 - 4, ARENA_Z_OFFSET + 28 - 4],
  ];
  for (const [bx, bz] of brazPos) {
    const br = makeArenaBrazier();
    br.position.set(bx, 0, bz);
    arenaSceneGroup.add(br);
    arenaBraziers.push(br);
  }
  // Perimeter (stenkant runt arenan)
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x4a4030, roughness: 0.9 });
  const wallTop = 1.2;
  const wallThickness = 1;
  const wallH = 1.8;
  const aLen = 100, aDep = 70;
  // Lång murbit norr och söder
  for (const dz of [-aDep / 2, aDep / 2]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(aLen, wallH, wallThickness), wallMat);
    w.position.set(0, wallH / 2, ARENA_Z_OFFSET + dz);
    w.castShadow = true;
    w.receiveShadow = true;
    arenaSceneGroup.add(w);
  }
  for (const dx of [-aLen / 2, aLen / 2]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(wallThickness, wallH, aDep), wallMat);
    w.position.set(dx, wallH / 2, ARENA_Z_OFFSET);
    w.castShadow = true;
    w.receiveShadow = true;
    arenaSceneGroup.add(w);
  }
  // Cover-props (slumpsådd från ARENA_CFG.props)
  for (const p of ARENA_CFG.props) {
    const m = makeArenaProp(p.type);
    m.position.set(p.x, 0, ARENA_Z_OFFSET + p.z);
    m.rotation.y = p.rot;
    arenaSceneGroup.add(m);
  }
  // Orb
  arenaOrbMesh = makeArenaOrbMesh();
  arenaOrbMesh.position.set(ARENA_CFG.orb.x, 0, ARENA_CFG.orb.z);
  arenaOrbMesh.visible = false;
  arenaSceneGroup.add(arenaOrbMesh);
  arenaOrbBuilt = true;
}

// ============================================================
// ARENA: STATE + LOGIK
// ============================================================

const arenaState = {
  phase: 'idle',      // 'idle' | 'prep' | 'fight' | 'roundEnd' | 'matchEnd'
  roundNum: 0,
  wins: { 1: 0, 2: 0 },
  prepTimer: 0,
  fightTimer: 0,
  ready: { 1: false, 2: false },
  // Per-side talents
  talents: {
    1: { points: 0, chosen: [] },  // chosen = array of talent ids
    2: { points: 0, chosen: [] },
  },
  // Orb
  orb: { hp: 0, maxHp: ARENA_ORB_MAX_HP, alive: false, spawnTimer: 0 },
  // Aktuell map — väljs innan match-start (random i solo, host väljer i MP)
  mapIdx: 0,
  // Battle-royale shrink-circle: börjar krympa 60s in i fight-fasen
  shrinkRadius: 0,        // 0 = inte aktiv ännu
  shrinkDamageAccum: 0,   // ticka skada var 0.25s utanför cirkeln
  endTimer: 0,
  roundWinner: 0,
  matchWinner: 0,
};

// Shrink-konfiguration: efter SHRINK_START_DELAY krymper circle linjärt till
// SHRINK_FINAL_RADIUS över SHRINK_DURATION sekunder. Utanför = 5% maxHP/s skada.
const SHRINK_START_DELAY = 60;       // 1 min countdown innan shrink börjar
const SHRINK_INITIAL_RADIUS = 28;    // täcker arenan (bounds 88×56 → 28 ryms)
const SHRINK_FINAL_RADIUS = 4;
const SHRINK_DURATION = 60;          // krymper över 60s
const SHRINK_DMG_PCT = 0.05;         // 5% maxHP per sek utanför
const SHRINK_TICK_INTERVAL = 0.25;

// Cache av senaste talents-listan vi recomputerade stats för. Används av
// applyArenaState för att skippa onödig recompute varje broadcast (sparar
// CPU vid 30 Hz state-tick). Deklareras här (före resetArenaState) för att
// undvika TDZ vid module-load.
let _lastRecomputedTalentsHash = '';
function resetArenaState() {
  _lastRecomputedTalentsHash = '';   // nolla så ny match recomputerar stats korrekt
  arenaState.phase = 'idle';
  arenaState.roundNum = 0;
  arenaState.wins = { 1: 0, 2: 0 };
  arenaState.prepTimer = 0;
  arenaState.fightTimer = 0;
  arenaState.shrinkRadius = 0;
  arenaState.shrinkDamageAccum = 0;
  arenaState.ready = { 1: false, 2: false, 3: false, 4: false };
  arenaState.talents = {
    1: { points: 0, chosen: [] },
    2: { points: 0, chosen: [] },
    3: { points: 0, chosen: [] },
    4: { points: 0, chosen: [] },
  };
  arenaState.orb = { hp: 0, maxHp: ARENA_ORB_MAX_HP, alive: false, spawnTimer: 0 };
  arenaState.endTimer = 0;
  arenaState.roundWinner = 0;
  arenaState.matchWinner = 0;
  arenaState.startingTimer = 0;
  arenaState.startingPhaseShown = null;
  // Rensa virtual-target-cacher (recreate on demand i findClosestHostile)
  arenaState.orbTarget = null;
  arenaState.heroTargets = { 1: null, 2: null };
}

function startArenaRound(roundNum) {
  arenaState.roundNum = roundNum;
  arenaState.phase = 'prep';
  arenaState.prepTimer = ARENA_PREP_TIME;
  arenaState.fightTimer = 0;
  arenaState.shrinkRadius = 0;
  arenaState.shrinkDamageAccum = 0;
  arenaState.ready = { 1: false, 2: false, 3: false, 4: false };
  const idxs = arenaSideIdxs();
  // Nolla shrink-circle damage-stackar vid round-start
  for (const idx of idxs) {
    if (sides[idx]) sides[idx].shrinkHitStacks = 0;
  }
  // +1 talent-poäng per runda för alla aktiva sidor
  for (const idx of idxs) {
    if (!arenaState.talents[idx]) arenaState.talents[idx] = { points: 0, chosen: [] };
    arenaState.talents[idx].points += 1;
  }
  // Bot auto-pickar talents per svårighetsgrad (easy skippar, hard maxar)
  for (const idx of idxs) {
    const s = sides[idx];
    if (!s || !s.isBot) continue;
    const diff = s.botDifficulty || 'medium';
    const skipChance = diff === 'easy' ? 1.0 : (diff === 'medium' ? 0.4 : 0.0);
    const t = arenaState.talents[idx];
    const talents = ARENA_TALENTS[s.heroId || 'magiker'] || [];
    while (t.points > 0) {
      // Random remaining talent
      const remaining = talents.filter(tl => !t.chosen.includes(tl.id));
      if (remaining.length === 0) break;
      if (Math.random() < skipChance) break;  // skip på lägre svårighet
      const pick = remaining[Math.floor(Math.random() * remaining.length)];
      t.chosen.push(pick.id);
      t.points -= 1;
    }
    if (typeof recomputeArenaSideStats === 'function') recomputeArenaSideStats(s);
  }
  // Återställ orb
  arenaState.orb = { hp: 0, maxHp: ARENA_ORB_MAX_HP, alive: false, spawnTimer: 0 };
  if (arenaOrbMesh) arenaOrbMesh.visible = false;
  // Återställ heroes till spawn + full HP, ej dead
  for (const idx of idxs) {
    const s = sides[idx];
    if (!s) continue;
    const spawn = APP.arenaTeamSize === 2
      ? ARENA_CFG.spawns2v2[idx]
      : (idx === 1 ? ARENA_CFG.spawn1 : ARENA_CFG.spawn2);
    s.hero.x = spawn.x; s.hero.z = spawn.z;
    s.hero.facingX = arenaTeamOf(idx) === 'A' ? 1 : -1;
    s.hero.facingZ = 0;
    s.hero.dead = false;
    s.hero.respawnTimer = 0;
    if (s.mesh) {
      s.mesh.position.set(spawn.x, 0, spawn.z);
      s.mesh.rotation.y = Math.atan2(s.hero.facingX, s.hero.facingZ);
      s.mesh.visible = true;  // återställ (death i förra rundan kunde lämnat den dold)
    }
    // Reset GLTF-animation-state så Death-clipen inte hänger kvar
    if (s.mesh && s.mesh._gltfState) {
      s.mesh._gltfState.attackTimer = 0;
    }
    if (s.mesh && s.mesh.userData.currentClipName &&
        s.mesh.userData.currentClipName.toLowerCase().includes('death')) {
      s.mesh.userData.currentClipName = null;  // tvinga animateGltfCharacter att välja om
    }
    recomputeArenaSideStats(s);
    s.hero.hp = s.hero.maxHp;
    s.shield = 0;
    // Reset item-stacks vid runda-start
    s.furyStacks = 0;
    s.furyTargetId = 0;
    s.titansInstanceStacks = 0;
    s.titansBlockPending = false;
    // Reset shield-state — refresh-timern triggar omedelbart vid fight-start
    s.lingShieldHp = 0;
    s.lingShieldRefreshTimer = 0.5;  // kort delay så shield-pop syns
    // Reset ALLA skill-CDs + ult-buffs/timers så varje runda startar fräsch.
    // Ult-energy BEHÅLLS mellan rundor — så om du fyllde 70% förra rundan börjar
    // du nästa med 70% (matchar MLBB-stil "ultimate stays").
    if (s.skills) {
      if (s.skills.q) s.skills.q.cd = 0;
      if (s.skills.f) s.skills.f.cd = 0;
      if (s.skills.e) s.skills.e.cd = 0;
    }
    s.legolusUltBuff = 0;
    s.legolusBuffRemaining = 0;
    s.legolusDashBuffPending = false;
    s.rageRemaining = 0;
    s.berserkRemaining = 0;
    s.whirlwindRemaining = 0;
    s.aragurnShoutBuff = 0;
    s.aragurnAllyShoutBuff = 0;
    s.aragurnShoutDebuff = 0;
    s.aragurnShoutHealRemaining = 0;
    if (s.mesh) s.mesh.scale.set(1, 1, 1);
    // Rensa kvar-stående projektiler/aktiva ult-effekter från förra rundan
    if (s.bigArrows && s.bigArrows.length) {
      for (const arr of s.bigArrows) { if (arr.mesh) scene.remove(arr.mesh); }
      s.bigArrows = [];
    }
    if (s.hammers && s.hammers.length) {
      for (const h of s.hammers) { if (h.mesh) scene.remove(h.mesh); }
      s.hammers = [];
    }
    if (s.fireballs && s.fireballs.length) {
      for (const f of s.fireballs) { if (f.mesh) scene.remove(f.mesh); }
      s.fireballs = [];
    }
    if (s.aragurnLeap) {
      if (s.aragurnLeap.indicator) {
        if (s.aragurnLeap.indicator.material) s.aragurnLeap.indicator.material.dispose();
        if (s.aragurnLeap.indicator.geometry) s.aragurnLeap.indicator.geometry.dispose();
        scene.remove(s.aragurnLeap.indicator);
      }
      s.aragurnLeap = null;
    }
    if (s.berserkSwordMesh) {
      s.berserkSwordMesh.traverse(o => {
        if (o.isMesh) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }
      });
      scene.remove(s.berserkSwordMesh);
      s.berserkSwordMesh = null;
    }
    if (s.soulDrain || s.soulDrainBeam) {
      if (typeof removeSoulDrainBeam === 'function') removeSoulDrainBeam(s);
      s.soulDrain = null;
    }
    // Arena-gold: runda 1 startar med ARENA_GOLD_START, övriga rundor får +ARENA_GOLD_PER_ROUND
    if (roundNum === 1) {
      s.gold = ARENA_GOLD_START;
    } else {
      s.gold = (s.gold || 0) + ARENA_GOLD_PER_ROUND;
    }
  }
  showArenaPrep();
}

function transitionArenaToStarting() {
  // Mellanfas mellan prep och fight: visar 3-2-1-FIGHT-banner
  arenaState.phase = 'starting';
  arenaState.startingTimer = 3.0;
  arenaState.startingPhaseShown = -1; // visa "3" först
  hideArenaPrep();
  // Säkerställ att hjältarna står på spawn-positioner med rotation
  for (const idx of arenaSideIdxs()) {
    const s = sides[idx];
    if (!s) continue;
    const spawn = APP.arenaTeamSize === 2
      ? ARENA_CFG.spawns2v2[idx]
      : (idx === 1 ? ARENA_CFG.spawn1 : ARENA_CFG.spawn2);
    s.hero.x = spawn.x; s.hero.z = spawn.z;
    s.hero.facingX = arenaTeamOf(idx) === 'A' ? 1 : -1;
    s.hero.facingZ = 0;
    if (s.mesh) {
      s.mesh.position.set(spawn.x, 0, spawn.z);
      s.mesh.rotation.y = Math.atan2(s.hero.facingX, s.hero.facingZ);
    }
  }
  showArenaCountdown('3');
}

function transitionArenaToFight() {
  arenaState.phase = 'fight';
  arenaState.fightTimer = 0;
  arenaState.shrinkRadius = 0;
  arenaState.shrinkDamageAccum = 0;
  arenaState.ready = { 1: false, 2: false, 3: false, 4: false };
  hideArenaPrep();
  hideArenaCountdown();
  // Orb spawnar direkt vid fight-start (visuell pop)
  arenaState.orb.alive = true;
  arenaState.orb.hp = arenaState.orb.maxHp;
  arenaState.orb.spawnTimer = 0;
  if (arenaOrbMesh) arenaOrbMesh.visible = true;
  spawnSkillCastFx(ARENA_CFG.orb.x, ARENA_CFG.orb.z, 0x55ffcc, 1.6);
  spawnShieldBurstFx(ARENA_CFG.orb.x, ARENA_CFG.orb.z, 0x55ffcc);
  showOrbBanner('ORB UPPENBARAR SIG', '#88ffdd');
}

function transitionArenaRoundEnd(winnerIdx) {
  arenaState.phase = 'roundEnd';
  arenaState.roundWinner = winnerIdx;
  arenaState.endTimer = ARENA_ROUND_END_PAUSE;
  if (winnerIdx > 0) {
    const winTeam = arenaTeamOf(winnerIdx);
    const repIdx = arenaTeamRep(winTeam);  // 1 eller 2 (rep för team)
    arenaState.wins[repIdx] = (arenaState.wins[repIdx] || 0) + 1;
    // Alla team-medlemmar får +1 talent-poäng + 500 gold-bonus
    for (const tidx of arenaTeamMates(winTeam)) {
      if (arenaState.talents[tidx]) arenaState.talents[tidx].points += 1;
      const ts = sides[tidx];
      if (ts) ts.gold = (ts.gold || 0) + ARENA_GOLD_WIN_BONUS;
    }
  }
  showArenaEnd(winnerIdx, false);
}

function transitionArenaMatchEnd(winnerIdx) {
  arenaState.phase = 'matchEnd';
  arenaState.matchWinner = winnerIdx;
  showArenaEnd(winnerIdx, true);
}

function checkArenaRoundEnd() {
  // Räkna levande per team. Runda slutar när ett team är helt utslaget.
  const aMembers = arenaTeamMates('A').map(i => sides[i]).filter(s => s);
  const bMembers = arenaTeamMates('B').map(i => sides[i]).filter(s => s);
  if (aMembers.length === 0 && bMembers.length === 0) return;
  const aAlive = aMembers.some(s => !s.hero.dead);
  const bAlive = bMembers.some(s => !s.hero.dead);
  if (!aAlive && !bAlive) { transitionArenaRoundEnd(0); return; }
  if (!aAlive) { transitionArenaRoundEnd(2); return; }     // team B vinner (rep idx)
  if (!bAlive && bMembers.length > 0) { transitionArenaRoundEnd(1); return; }  // team A vinner
}

// ===== SHRINK CIRCLE (battle-royale) =====
// Klient-state för visuell smoke-mesh (rebuilt per match)
let shrinkRingMesh = null;
let shrinkSmokeMesh = null;

function ensureShrinkMeshes() {
  if (shrinkRingMesh) return;
  // Boundary-ring på marken — ljusgrön ring som visar circle-edge
  const ringGeom = new THREE.RingGeometry(0.94, 1.0, 64);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x88ff77, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false,
  });
  shrinkRingMesh = new THREE.Mesh(ringGeom, ringMat);
  shrinkRingMesh.rotation.x = -Math.PI / 2;
  shrinkRingMesh.position.set(0, 0.12, ARENA_Z_OFFSET);
  shrinkRingMesh.visible = false;
  arenaSceneGroup.add(shrinkRingMesh);
  // Smoke-vägg utanför circle — hollow cylinder med ljusgrön gradient
  const smokeMat = new THREE.MeshBasicMaterial({
    color: 0x66ee55, transparent: true, opacity: 0.30, side: THREE.BackSide, depthWrite: false,
  });
  const smokeGeom = new THREE.CylinderGeometry(1.0, 1.0, 6, 48, 1, true);
  shrinkSmokeMesh = new THREE.Mesh(smokeGeom, smokeMat);
  shrinkSmokeMesh.position.set(0, 3.0, ARENA_Z_OFFSET);
  shrinkSmokeMesh.visible = false;
  arenaSceneGroup.add(shrinkSmokeMesh);
}

// Visuell uppdatering av shrink-cirkel — körs både på host och klient så att
// arena-clienten också ser cirkeln (annars syntes den bara hos host).
// Läser arenaState.shrinkRadius (synkat via a-state) och uppdaterar meshes.
function updateShrinkCircleVisual(dt) {
  const r = arenaState.shrinkRadius || 0;
  if (r <= 0) {
    if (shrinkRingMesh) shrinkRingMesh.visible = false;
    if (shrinkSmokeMesh) shrinkSmokeMesh.visible = false;
    return;
  }
  ensureShrinkMeshes();
  if (shrinkRingMesh) {
    shrinkRingMesh.visible = true;
    shrinkRingMesh.scale.set(r, r, 1);
    const pulse = 1 + 0.04 * Math.sin(performance.now() * 0.005);
    shrinkRingMesh.scale.x *= pulse;
    shrinkRingMesh.scale.y *= pulse;
  }
  if (shrinkSmokeMesh) {
    shrinkSmokeMesh.visible = true;
    shrinkSmokeMesh.scale.set(r, 1, r);
    shrinkSmokeMesh.rotation.y += (dt || 0) * 0.3;
    if (shrinkSmokeMesh.material) {
      shrinkSmokeMesh.material.opacity = 0.28 + 0.10 * Math.sin(performance.now() * 0.003);
    }
  }
}

function tickShrinkCircle(dt) {
  // Aktivera efter SHRINK_START_DELAY sekunder i fight-fasen
  const t = arenaState.fightTimer;
  if (t < SHRINK_START_DELAY) {
    arenaState.shrinkRadius = 0;
    updateShrinkCircleVisual(dt);
    return;
  }
  // Linjärt krymp från SHRINK_INITIAL_RADIUS → SHRINK_FINAL_RADIUS över SHRINK_DURATION
  const elapsed = t - SHRINK_START_DELAY;
  const u = Math.min(1, elapsed / SHRINK_DURATION);
  const r = SHRINK_INITIAL_RADIUS - (SHRINK_INITIAL_RADIUS - SHRINK_FINAL_RADIUS) * u;
  arenaState.shrinkRadius = r;
  updateShrinkCircleVisual(dt);
  // Damage-tick: spelare utanför cirkeln tar SHRINK_DMG_PCT av maxHP/sek SOM
  // BAS. Per damage-tick (var 0.25s) ökar deras "shrink-stacks" med 1 — varje
  // stack ger +1% maxHP/sek extra damage (per user request: "ska öka med 1%
  // max hp per damage taken från den"). Stackar nollställs vid round-end.
  arenaState.shrinkDamageAccum = (arenaState.shrinkDamageAccum || 0) + dt;
  while (arenaState.shrinkDamageAccum >= SHRINK_TICK_INTERVAL) {
    arenaState.shrinkDamageAccum -= SHRINK_TICK_INTERVAL;
    for (const idx of arenaSideIdxs()) {
      const s = sides[idx];
      if (!s || s.hero.dead) continue;
      const dx = s.hero.x - 0;
      const dz = s.hero.z - ARENA_Z_OFFSET;
      const d = Math.hypot(dx, dz);
      if (d > r) {
        const stacks = s.shrinkHitStacks || 0;
        const dmgPctTotal = SHRINK_DMG_PCT + stacks * 0.01;   // bas + 1% per stack
        const dmg = s.hero.maxHp * dmgPctTotal * SHRINK_TICK_INTERVAL;
        damageHero(s, dmg);
        s.shrinkHitStacks = stacks + 1;   // ökar för nästa tick
      }
    }
  }
}

function updateArenaOrb(dt) {
  const orb = arenaState.orb;
  if (!orb.alive) {
    orb.spawnTimer -= dt;
    if (orb.spawnTimer <= 0) {
      orb.alive = true;
      orb.hp = orb.maxHp;
      if (arenaOrbMesh) arenaOrbMesh.visible = true;
      // Spawn-FX: stor ring-burst + skill-cast-ring runt orb-position
      spawnSkillCastFx(ARENA_CFG.orb.x, ARENA_CFG.orb.z, 0x55ffcc, 1.6);
      spawnShieldBurstFx(ARENA_CFG.orb.x, ARENA_CFG.orb.z, 0x55ffcc);
      showOrbBanner('ORB UPPENBARAR SIG', '#88ffdd');
    }
    return;
  }
  // HP-bar update (samma format som hero/monster)
  if (arenaOrbMesh) {
    const now = performance.now() / 1000;
    updateEntityHpBar(arenaOrbMesh, orb.hp, orb.maxHp, now);
    // Orb-animation: pulserande halo + roterande core
    const t = now;
    if (arenaOrbMesh.userData.core) {
      arenaOrbMesh.userData.core.rotation.y = t * 0.8;
      arenaOrbMesh.userData.core.position.y = 1.3 + Math.sin(t * 2.4) * 0.10;
    }
    if (arenaOrbMesh.userData.halo) {
      const pulse = 0.18 + Math.sin(t * 3.2) * 0.08;
      arenaOrbMesh.userData.halo.material.opacity = pulse;
    }
    if (arenaOrbMesh.userData.light) {
      arenaOrbMesh.userData.light.intensity = 1.0 + Math.sin(t * 2.6) * 0.4;
    }
  }
}

// Helpers för att applicera AoE/cone-skills mot arena-orben.
// Heroes-vs-heroes-damage handlas separat (TODO i nästa pass).
function applyAoEDamageInArena(centerX, centerZ, radius, damage, byIdx) {
  if (APP.gameMode !== 'arena1v1' || arenaState.phase !== 'fight') return;
  if (!arenaState.orb.alive) return;
  const d = Math.hypot(ARENA_CFG.orb.x - centerX, ARENA_CFG.orb.z - centerZ);
  if (d < radius) damageArenaOrb(damage, byIdx);
}
function applyConeDamageInArena(originX, originZ, dirX, dirZ, length, halfAngle, damage, byIdx) {
  if (APP.gameMode !== 'arena1v1' || arenaState.phase !== 'fight') return;
  if (!arenaState.orb.alive) return;
  const ox = ARENA_CFG.orb.x, oz = ARENA_CFG.orb.z;
  const dx = ox - originX, dz = oz - originZ;
  const dist = Math.hypot(dx, dz);
  if (dist > length || dist < 0.01) return;
  const dot = (dx * dirX + dz * dirZ) / dist;  // cos av vinkel mellan cone-riktning och orb-riktning
  if (dot < Math.cos(halfAngle)) return;
  damageArenaOrb(damage, byIdx);
}

function damageArenaOrb(amount, byIdx) {
  const orb = arenaState.orb;
  if (!orb.alive || orb.hp <= 0) return;
  orb.hp -= amount;
  if (orb.hp <= 0) {
    orb.hp = 0;
    orb.alive = false;
    orb.spawnTimer = ARENA_ORB_RESPAWN_DELAY;
    if (arenaOrbMesh) arenaOrbMesh.visible = false;
    // Stor explosion vid orb-position + camera-shake
    spawnShieldBurstFx(ARENA_CFG.orb.x, ARENA_CFG.orb.z, 0x88ffdd);
    spawnSkillCastFx(ARENA_CFG.orb.x, ARENA_CFG.orb.z, 0xaaffee, 2.0);
    triggerCameraShake(0.4, 0.45);
    // Dödaren får heal + shield
    const winner = sides[byIdx];
    if (winner) {
      const healAmount = winner.hero.maxHp * ARENA_ORB_HEAL_PCT;
      winner.hero.hp = Math.min(winner.hero.maxHp, winner.hero.hp + healAmount);
      const shieldAmount = winner.hero.maxHp * ARENA_ORB_SHIELD_PCT;
      winner.shield = Math.max(winner.shield || 0, shieldAmount);
      spawnHealFx(winner.hero.x, winner.hero.z);
      spawnShieldBurstFx(winner.hero.x, winner.hero.z, 0x55ffcc);
    }
    // Banner visas alltid vid orb-död (även edge-case när winner saknas)
    const isLocal = byIdx === APP.localSide;
    showOrbBanner(isLocal ? 'ORB DÖDAD! +30% HP & SHIELD' :
                  (winner ? 'Motståndaren tog orben' : 'Orben dog'),
                  isLocal ? '#aaffaa' : '#ffaaaa');
  }
}

// Liten flyttbar banner som visas några sekunder för orb-händelser
function showOrbBanner(text, color = '#88ffdd') {
  let el = document.getElementById('orb-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'orb-banner';
    el.style.cssText = 'position:fixed;top:18%;left:50%;transform:translateX(-50%);'
      + 'background:rgba(0,20,30,0.78);padding:10px 22px;border-radius:10px;'
      + 'border:2px solid currentColor;color:#88ffdd;font:700 17px/1 system-ui;'
      + 'letter-spacing:1.4px;z-index:75;pointer-events:none;text-align:center;'
      + 'box-shadow:0 0 20px currentColor;'
      + 'animation:orb-banner-pop 2.6s ease-out forwards;';
    document.body.appendChild(el);
    // CSS-animation (id-guard så vi inte duplicerar style-elementet vid re-create)
    if (!document.getElementById('orb-banner-style')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'orb-banner-style';
      styleEl.textContent = `@keyframes orb-banner-pop {
        0%   { opacity: 0; transform: translate(-50%, 8px) scale(0.85); }
        12%  { opacity: 1; transform: translate(-50%, 0) scale(1.08); }
        22%  { transform: translate(-50%, 0) scale(1); }
        80%  { opacity: 1; }
        100% { opacity: 0; transform: translate(-50%, -8px) scale(0.95); }
      }`;
      document.head.appendChild(styleEl);
    }
  }
  el.textContent = text;
  el.style.color = color;
  el.style.borderColor = color;
  // Restart animation
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = 'orb-banner-pop 2.6s ease-out forwards';
}

function tickArena(dt) {
  if (APP.gameMode !== 'arena1v1') return;
  if (arenaState.phase === 'prep') {
    arenaState.prepTimer = Math.max(0, arenaState.prepTimer - dt);
    updateArenaPrepUI();
    // Start 3-2-1-countdown om timer = 0 eller alla MÄNNISKO-styrda sidor ready
    // Solo: bara localSide räknas. MP: alla connected peers.
    let allReady = true;
    const idxs = arenaSideIdxs();
    for (const idx of idxs) {
      const s = sides[idx];
      if (!s) continue;
      // I solo: bara localSide är människa, övriga sidor räknas som ready
      if (APP.mode === 'solo' && idx !== APP.localSide) continue;
      if (!arenaState.ready[idx]) { allReady = false; break; }
    }
    if (arenaState.prepTimer <= 0 || allReady) {
      transitionArenaToStarting();
    }
  } else if (arenaState.phase === 'starting') {
    // 3-2-1-FIGHT countdown — hjältarna kan inte röra sig (simulateAll pausar)
    arenaState.startingTimer = Math.max(0, arenaState.startingTimer - dt);
    const elapsed = 3.0 - arenaState.startingTimer;
    // 0-1s = "3", 1-2s = "2", 2-3s = "1", >3s = "FIGHT!"
    let label, isFight = false;
    if (elapsed < 1.0)      label = '3';
    else if (elapsed < 2.0) label = '2';
    else if (elapsed < 3.0) label = '1';
    else { label = 'FIGHT!'; isFight = true; }
    if (arenaState.startingPhaseShown !== label) {
      arenaState.startingPhaseShown = label;
      showArenaCountdown(label, isFight);
    }
    if (arenaState.startingTimer <= 0) {
      // Lås phase så vi inte triggar setTimeout flera gånger
      arenaState.phase = 'starting-end';
      // Korta extra-paus för att FIGHT-bannern hinner synas, sen fight
      setTimeout(() => {
        if (arenaState.phase === 'starting-end') transitionArenaToFight();
      }, 600);
    }
  } else if (arenaState.phase === 'fight') {
    arenaState.fightTimer += dt;
    updateArenaOrb(dt);
    tickShrinkCircle(dt);
    checkArenaRoundEnd();
  } else if (arenaState.phase === 'roundEnd') {
    arenaState.endTimer -= dt;
    if (arenaState.endTimer <= 0) {
      // Check bo5
      if (arenaState.wins[1] >= ARENA_BO5_WINS_NEEDED) {
        transitionArenaMatchEnd(1);
      } else if (arenaState.wins[2] >= ARENA_BO5_WINS_NEEDED) {
        transitionArenaMatchEnd(2);
      } else {
        hideArenaEnd();
        startArenaRound(arenaState.roundNum + 1);
      }
    }
  }
  // Uppdatera UI
  updateArenaHud();
}

// Räknar om stats inklusive arena-talents (om gameMode=arena)
function recomputeArenaSideStats(side) {
  // Klassisk stats först
  recomputeSideStats(side);
  if (APP.gameMode !== 'arena1v1') return;
  // Applicera arena-talents ovanpå
  const heroId = side.heroId || 'magiker';
  const talentList = ARENA_TALENTS[heroId] || [];
  const chosen = arenaState.talents[side.idx]?.chosen || [];
  let attackDmgFlat = 0;
  let attackSpeedPct = 0, moveSpeedPct = 0, skillDmgPct = 0, cdrPct = 0;
  let dmgReductionPct = 0, maxHpPct = 0, critChancePct = 0, healPerSecPct = 0;
  for (const id of chosen) {
    const t = talentList.find(x => x.id === id);
    if (!t || !t.stats) continue;
    if (t.stats.attackDmg) attackDmgFlat += t.stats.attackDmg;
    attackSpeedPct  += t.stats.attackSpeedPct  || 0;
    moveSpeedPct    += t.stats.moveSpeedPct    || 0;
    skillDmgPct     += t.stats.skillDmgPct     || 0;
    cdrPct          += t.stats.cdrPct          || 0;
    dmgReductionPct += t.stats.dmgReductionPct || 0;
    maxHpPct        += t.stats.maxHpPct        || 0;
    critChancePct   += t.stats.critChancePct   || 0;
    healPerSecPct   += t.stats.healPerSecPct   || 0;
  }
  // Applicera ovanpå redan computerade base+items stats
  side.attackDmg = (side.attackDmg || 0) + attackDmgFlat;
  side.attackSpeedMul = (side.attackSpeedMul || 1) * (1 + attackSpeedPct);
  side.moveSpeed = (side.moveSpeed || HERO_BASE_MOVE_SPEED) * (1 + moveSpeedPct);
  side.skillDmgMul = (side.skillDmgMul || 1) * (1 + skillDmgPct);
  side.cdrMul = (side.cdrMul || 1) * (1 - cdrPct);  // CDR shrinker cd
  side.dmgReductionMul = (side.dmgReductionMul || 1) * (1 - dmgReductionPct);
  const maxHpBefore = side.hero.maxHp;
  side.hero.maxHp = Math.round(side.hero.maxHp * (1 + maxHpPct));
  // Heal upp till nya maxHp om vi just boosta:ade
  if (side.hero.maxHp > maxHpBefore) {
    side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + (side.hero.maxHp - maxHpBefore));
  }
  side.critChance = (side.critChance || 0) + critChancePct;
  side.healPerSecPct = (side.healPerSecPct || 0) + healPerSecPct;
}

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
    legolusAaCounter: 0,
    legolusSplitPending: false,
    // Shadow Volley (Legolus ult) state — solo/arena/boss tickas lokalt,
    // line wars synkas via snap (lInv/lAa/TP).
    legolusInvisRemaining: 0,
    legolusUltAaPending: false,
    thornPoolsLocal: [],
    gimluDmgInstanceCount: 0,
    gandulfBuffStacks: 0,
    gandulfBuffRemaining: 0,
    shield: 0,
    // Ult-energy + per-ult timers (sätts av hostCast*Ult)
    ultEnergy: 0,
    laserBeam: null,           // Magiker: { remaining, dx, dz, tickAccum }
    soulDrain: null,            // Magiker Q: { remaining, tickAccum, stacks, targetId, targetType }
    soulDrainBeam: null,        // Klient-visual för Soul Drain
    rageRemaining: 0,           // Gimlu: sek kvar
    rageHealAccum: 0,           // Gimlu: damage dealt under rage (för 20% heal)
    rageTickAccum: 0,           // Gimlu: 0.5s pulse-timer
    legolusUltBuff: 0,          // Legolas: sek kvar med +30% AS efter teleport
    // Aragurn-state
    whirlwindRemaining: 0,      // Aragurn Q: sek kvar med spin (CC-immun + MS-buff + tick-skada)
    whirlwindTickAccum: 0,
    aragurnLeap: null,          // Aragurn E: { remaining, startX, startZ, targetX, targetZ }
    aragurnShoutBuff: 0,        // Aragurn F-buff på sig själv (bara DR): sek kvar
    aragurnAllyShoutBuff: 0,    // Aragurn F-buff på allierad: sek kvar (DR + MS)
    aragurnShoutDebuff: 0,      // Mottagar-buff "tar 20% mer skada" sek kvar (sätts på fiende)
    aragurnShoutHealRemaining: 0,  // HoT-timer från War Shout (2s)
    aragurnShoutHealPct: 0,        // 0.10 för Aragurn, 0.05 för allierad
    berserkRemaining: 0,        // Aragurn R: sek kvar (–50% AS, +150% AA dmg, cleave)
    berserkSwordMesh: null,     // Klient-visual: dubblat svärd + glow
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
  // Mini-boss på jämna waves: använder 1 av kommande bossens 3 skills som hint
  if (shouldSpawnMiniBoss(def.number)) {
    const nextBoss = getNextBossDef(def.number);
    if (nextBoss) {
      const miniSkill = nextBoss.skills[getMiniBossSkillIdx(def.number)];
      hostSpawnMiniBoss(side, def, nextBoss, miniSkill);
    }
  }
}

function hostSpawnMiniBoss(side, waveDef, bossDef, skill) {
  const cfg = SIDE_CFG[side.idx];
  const lane = ((waveDef.number / 2) % 2 === 0) ? 1 : 2;  // alternerar lane per mini-boss-spawn
  const x = cfg.spawnX + 1.0;
  const z = cfg.laneZ[lane];
  const mesh = makeMonsterMesh();
  const scale = 1.55;   // lagom större än vanlig minion (men inte boss-stor)
  mesh.scale.set(scale, scale, scale);
  applyMonsterTint(mesh, bossDef.bodyTint, 0.7);
  attachBossAura(mesh, bossDef.auraColor, bossDef.eyeColor, scale, true);
  attachHpBar(mesh, 1.9);
  mesh.position.set(x, 0, z);
  scene.add(mesh);
  // "Lite starkare än vanliga minions" — ~2× HP och ~1.25× dmg
  const hp = Math.round(waveDef.monsterHp * 2.2);
  side.monsters.push({
    id: nextEntityId++,
    lane,
    hp, maxHp: hp,
    speed: waveDef.monsterSpeed * 0.92,
    damage: Math.round(waveDef.monsterDmg * 1.25),
    attackType: 'melee', attackRange: 1.3, attackInterval: 1.1,
    pathIndex: 0, atkCd: 0, slowTime: 0, slowMul: 1.0, chasing: false,
    isBoss: false, isMiniBoss: true,
    bossName: bossDef.name + ' Acolyte',
    bossSkills: [skill],
    skillCds: [skill.cd * 0.5],   // första cast efter halv CD
    activeCast: null,
    bossDef,
    mesh,
  });
}

function hostSpawnMonsterFromDef(side, lane, def, pos, attackType) {
  const cfg = SIDE_CFG[side.idx];
  const x = pos ? pos.x : cfg.spawnX;
  const z = pos ? pos.z : cfg.laneZ[lane];
  const isRange = attackType === 'range';
  const hp = isRange ? Math.round(def.monsterHp * RANGE_MONSTER_HP_RATIO) : def.monsterHp;
  const speed = isRange ? def.monsterSpeed * RANGE_MONSTER_SPEED_RATIO : def.monsterSpeed;
  const mesh = makeMonsterMesh();
  // Boss-mesh: använd BOSS_DEFS för scale + tint + aura
  let bossDef = null;
  if (def.isBoss) {
    bossDef = BOSS_DEFS[def.number] || BOSS_DEFS[10];
    const scale = bossDef.scale;
    mesh.scale.set(scale, scale, scale);
    applyMonsterTint(mesh, bossDef.bodyTint, 0.85);
    attachBossAura(mesh, bossDef.auraColor, bossDef.eyeColor, scale, false);
  } else if (isRange) {
    applyMonsterTint(mesh, 0x5a7a4a, 0.85);
  }
  attachHpBar(mesh, def.isBoss ? (bossDef ? bossDef.scale * 0.85 : 2.4) : 1.7);
  mesh.position.set(x, 0, z);
  scene.add(mesh);
  const monster = {
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
    isMiniBoss: false,
    mesh,
  };
  if (def.isBoss && bossDef) {
    monster.bossDef = bossDef;
    monster.bossName = bossDef.name;
    monster.bossSkills = bossDef.skills;
    monster.skillCds = bossDef.skills.map(s => s.cd * 0.6);  // delayed initial CD
    monster.activeCast = null;
  }
  side.monsters.push(monster);
}

// Tinta en monster-mesh utan att förstöra GLTF-material delat med andra instanser.
function applyMonsterTint(mesh, colorHex, intensity = 0.85) {
  mesh.traverse(o => {
    if (o.material && o.material.color && o.isMesh) {
      o.material = o.material.clone();
      o.material.color.setHex(colorHex);
      if (intensity > 0.9) o.material.color.lerp(new THREE.Color(0x000000), 1 - intensity);
    }
  });
}

// Mörk smoke-aura runt boss/miniboss: rökig sfär + glödande ögon-light + cirkulerande
// partikel-emitter. Lagras i mesh.userData.bossAura så ticken kan animera den.
function attachBossAura(mesh, auraColor, eyeColor, scale, isMini = false) {
  const aura = new THREE.Group();
  aura.position.y = (isMini ? 0.5 : 1.0) * scale;
  // Mörk halv-transparent rök-sfär runt kroppen
  const smokeR = (isMini ? 0.6 : 1.1) * scale;
  const smoke = new THREE.Mesh(
    new THREE.SphereGeometry(smokeR, 18, 14),
    new THREE.MeshBasicMaterial({ color: auraColor, transparent: true, opacity: isMini ? 0.20 : 0.30, depthWrite: false })
  );
  aura.add(smoke);
  // Yttre rök (större, ljusare, fadar)
  const outerR = smokeR * 1.5;
  const outer = new THREE.Mesh(
    new THREE.SphereGeometry(outerR, 16, 12),
    new THREE.MeshBasicMaterial({ color: auraColor, transparent: true, opacity: isMini ? 0.08 : 0.13, depthWrite: false })
  );
  aura.add(outer);
  // Glödande ögon-light vid huvudhöjd
  const eyeLight = new THREE.PointLight(eyeColor, isMini ? 1.0 : 2.0, isMini ? 3 : 5);
  eyeLight.position.set(0, scale * 0.35, 0);
  aura.add(eyeLight);
  // Liten ground-marker — mörk fläck under boss/miniboss
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(smokeR * 0.85, 24),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -(isMini ? 0.5 : 1.0) * scale + 0.05;
  aura.add(ground);
  mesh.add(aura);
  mesh.userData.bossAura = {
    group: aura, smoke, outer, eyeLight, ground,
    puffAccum: 0,
    auraColor, eyeColor, isMini, scale,
  };
}

// ===== BOSS SKILL-SYSTEM =====
// Per frame: ticka CDs, om aktiv cast → tick. Annars välj random ready skill.
// Faser: 'telegraph' (visuell varning) → 'execute' (skada/projektil/dash/etc).
function tickBossSkills(side, m, dt) {
  // Boss inaktiv i boss wars tills alla heroes är inne i boss-rummet.
  // Stannar still, attackar inte, castar inga skills.
  if (m.isBossWarsBoss && APP.bossWars && !APP.bossWars.bossActivated) {
    if (m.activeCast) cancelBossCast(side, m);
    return;
  }
  if (m.hp <= 0 || side.hero.dead) {
    if (m.activeCast) cancelBossCast(side, m);
    return;
  }
  if (m.skillCds) {
    for (let i = 0; i < m.skillCds.length; i++) m.skillCds[i] = Math.max(0, m.skillCds[i] - dt);
  }
  if (m.activeCast) {
    tickBossCast(side, m, dt);
    return;
  }
  // Bara casta om någon hjälte är någorlunda nära. I co-op räcker det att
  // EN av de 3 är inom range; annars vänta.
  let dh = Math.hypot(side.hero.x - m.mesh.position.x, side.hero.z - m.mesh.position.z);
  if (m.isBossWarsBoss && bossMpState && bossMpState.matchActive) {
    let best = Infinity;
    for (const idx of [1, 2, 3]) {
      const s = sides[idx];
      if (!s || s.hero.dead) continue;
      const dd = Math.hypot(s.hero.x - m.mesh.position.x, s.hero.z - m.mesh.position.z);
      if (dd < best) best = dd;
    }
    dh = best;
  }
  if (dh > 18) return;  // för långt bort, vänta
  if (!m.bossSkills || !m.skillCds) return;
  // Plocka random ready-skill
  const ready = [];
  for (let i = 0; i < m.skillCds.length; i++) if (m.skillCds[i] <= 0) ready.push(i);
  if (ready.length === 0) return;
  const pick = ready[(Math.random() * ready.length) | 0];
  startBossCast(side, m, m.bossSkills[pick], pick);
}

function startBossCast(side, m, skill, skillIdx) {
  // Boss Wars co-op: cast mot närmsta levande hjälte. Solo: side.hero.
  let hero = side.hero;
  if (m.isBossWarsBoss && bossMpState && bossMpState.matchActive) {
    let best = null, bestDist = Infinity;
    for (const idx of [1, 2, 3]) {
      const s = sides[idx];
      if (!s || s.hero.dead) continue;
      const dd = (s.hero.x - m.mesh.position.x) ** 2 + (s.hero.z - m.mesh.position.z) ** 2;
      if (dd < bestDist) { bestDist = dd; best = s.hero; }
    }
    if (best) hero = best;
  }
  const bx = m.mesh.position.x, bz = m.mesh.position.z;
  const dx = hero.x - bx, dz = hero.z - bz;
  const dl = Math.hypot(dx, dz) || 1;
  const dirX = dx / dl, dirZ = dz / dl;
  const cast = {
    skill, skillIdx,
    phase: 'telegraph',
    timer: skill.telegraph,
    dirX, dirZ,
    originX: bx, originZ: bz,
    targetX: skill.targetHero ? hero.x : (skill.originSelf ? bx : bx + dirX * (skill.length || 5) / 2),
    targetZ: skill.targetHero ? hero.z : (skill.originSelf ? bz : bz + dirZ * (skill.length || 5) / 2),
    telegraphMesh: null,
    extras: null,
  };
  m.activeCast = cast;
  // Trigga attack-animation på boss-mesh — gör att den visuellt "slår" när skill cast startar
  if (m.mesh) m.mesh.userData.attackTrigger = true;
  // Boss roterar mot target under telegraph
  if (m.mesh) m.mesh.rotation.y = Math.atan2(dirX, dirZ);
  // Extra visuell feedback för boss-skill-cast i boss wars — så användaren
  // tydligt ser "bossen castar något". Lila ring runt bossen + camera shake.
  if (m.isBossWarsBoss && m.mesh) {
    spawnSkillCastFx(m.mesh.position.x, m.mesh.position.z, 0xcc44ff, 1.8);
    spawnShieldBurstFx(m.mesh.position.x, m.mesh.position.z, 0xff66dd);
    triggerCameraShake(0.18, 0.2);
    // Bumpa aaCount så klienter delta-detect:ar och triggar attack-clip lokalt
    m.aaCount = (m.aaCount || 0) + 1;
  }
  spawnBossTelegraph(side, m, cast);
}

function tickBossCast(side, m, dt) {
  const cast = m.activeCast;
  cast.timer -= dt;
  if (cast.phase === 'telegraph') {
    tickBossTelegraph(side, m, cast, dt);
    if (cast.timer <= 0) {
      // Transition: cleanup telegraph, börja execute-fas
      cleanupTelegraphMesh(cast);
      bossExecuteSkill(side, m, cast);
    }
    return;
  }
  if (cast.phase === 'execute') {
    tickBossExecute(side, m, cast, dt);
    if (cast.timer <= 0 && (!cast.extras || cast.extras.done)) {
      finishBossCast(side, m);
    }
  }
}

function cancelBossCast(side, m) {
  if (!m.activeCast) return;
  cleanupTelegraphMesh(m.activeCast);
  cleanupExecuteMesh(m.activeCast);
  m.activeCast = null;
}

function finishBossCast(side, m) {
  const cast = m.activeCast;
  if (!cast) return;
  cleanupExecuteMesh(cast);
  m.skillCds[cast.skillIdx] = cast.skill.cd;
  m.activeCast = null;
}

function cleanupTelegraphMesh(cast) {
  if (!cast.telegraphMesh) return;
  cast.telegraphMesh.traverse(o => {
    if (o.isMesh) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    }
  });
  scene.remove(cast.telegraphMesh);
  cast.telegraphMesh = null;
}

function cleanupExecuteMesh(cast) {
  if (!cast.extras) return;
  const e = cast.extras;
  if (e.meshes) for (const obj of e.meshes) {
    if (obj.traverse) {
      obj.traverse(o => {
        if (o.isMesh) {
          if (o.geometry) o.geometry.dispose();
          if (o.material) o.material.dispose();
        }
      });
    }
    scene.remove(obj);
  }
}

// ===== TELEGRAPHS =====
// Visuell röd "varning" innan skill exekverar. Pulsar/expanderar för tydlighet.
function spawnBossTelegraph(side, m, cast) {
  const s = cast.skill;
  const grp = new THREE.Group();
  scene.add(grp);
  cast.telegraphMesh = grp;
  // Y-offset: boss-wars-platformen är på y=0.42, så telegraphs måste vara ovanpå
  const gY = (APP.gameMode === 'bosswars') ? 0.48 : 0.08;
  const matRed = () => new THREE.MeshBasicMaterial({ color: 0xff3322, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
  if (s.kind === 'groundCircle' || s.kind === 'poolDot') {
    const ring = new THREE.Mesh(new THREE.RingGeometry(s.radius * 0.92, s.radius, 40), matRed());
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(cast.targetX, gY, cast.targetZ);
    grp.add(ring);
    const disk = new THREE.Mesh(new THREE.CircleGeometry(s.radius, 32),
      new THREE.MeshBasicMaterial({ color: 0xff3322, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
    disk.rotation.x = -Math.PI / 2;
    disk.position.set(cast.targetX, gY - 0.02, cast.targetZ);
    grp.add(disk);
  } else if (s.kind === 'lineDash') {
    const w = s.width, l = s.length;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, l),
      new THREE.MeshBasicMaterial({ color: 0xff3322, transparent: true, opacity: 0.50, side: THREE.DoubleSide, depthWrite: false }));
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(cast.originX + cast.dirX * l / 2, gY, cast.originZ + cast.dirZ * l / 2);
    plane.rotation.z = -Math.atan2(cast.dirX, cast.dirZ);
    grp.add(plane);
    const edge = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.15, l),
      new THREE.MeshBasicMaterial({ color: 0xff7755, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    edge.rotation.x = -Math.PI / 2;
    edge.position.copy(plane.position);
    edge.rotation.z = plane.rotation.z;
    grp.add(edge);
  } else if (s.kind === 'cone' || s.kind === 'sustainedCone') {
    const r = s.length;
    const ang = s.halfAngle;
    const segs = 14;
    const geom = new THREE.BufferGeometry();
    const verts = [0, 0, 0];
    for (let i = 0; i <= segs; i++) {
      const a = -ang + (2 * ang) * (i / segs);
      verts.push(Math.sin(a) * r, 0, Math.cos(a) * r);
    }
    const idx = [];
    for (let i = 1; i <= segs; i++) idx.push(0, i, i + 1);
    geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geom.setIndex(idx);
    geom.computeVertexNormals();
    const fan = new THREE.Mesh(geom, matRed());
    fan.position.set(cast.originX, gY, cast.originZ);
    fan.rotation.y = Math.atan2(cast.dirX, cast.dirZ);
    grp.add(fan);
  } else if (s.kind === 'projectile' || s.kind === 'projectileMulti') {
    // Liten röd "laddnings"-glow vid boss + svaga indicator-linjer per projektil
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xff5533, transparent: true, opacity: 0.7, depthWrite: false }));
    glow.position.set(cast.originX, 1.5, cast.originZ);
    grp.add(glow);
    const count = s.count || 1;
    const spread = s.spreadAngle || 0;
    for (let i = 0; i < count; i++) {
      const off = count === 1 ? 0 : (-spread / 2 + spread * i / (count - 1));
      const ang = Math.atan2(cast.dirX, cast.dirZ) + off;
      const dx = Math.sin(ang), dz = Math.cos(ang);
      const line = new THREE.Mesh(new THREE.PlaneGeometry(0.20, s.range || 14),
        new THREE.MeshBasicMaterial({ color: 0xff5533, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
      line.rotation.x = -Math.PI / 2;
      line.position.set(cast.originX + dx * (s.range || 14) / 2, gY, cast.originZ + dz * (s.range || 14) / 2);
      line.rotation.z = -ang;
      grp.add(line);
    }
  } else if (s.kind === 'sweepBeam') {
    // Båge på marken som visar svep-arean
    const r = s.length;
    const ang = s.halfAngle;
    const segs = 28;
    const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.92, r, segs, 1, -ang, 2 * ang),
      new THREE.MeshBasicMaterial({ color: 0xff3322, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(cast.originX, gY, cast.originZ);
    ring.rotation.z = Math.atan2(cast.dirX, cast.dirZ);
    grp.add(ring);
  } else if (s.kind === 'multiCircle') {
    // Visa bossens position som "incoming meteor storm" — liten central marker
    const mark = new THREE.Mesh(new THREE.RingGeometry(0.6, 0.9, 24),
      new THREE.MeshBasicMaterial({ color: 0xff7733, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
    mark.rotation.x = -Math.PI / 2;
    mark.position.set(cast.originX, gY, cast.originZ);
    grp.add(mark);
  }
}

function tickBossTelegraph(side, m, cast, dt) {
  // Pulsera telegraph-meshen för synlighet
  if (!cast.telegraphMesh) return;
  const t = performance.now() * 0.012;
  const pulse = 0.5 + 0.5 * Math.sin(t);
  cast.telegraphMesh.traverse(o => {
    if (o.isMesh && o.material && o.material.transparent) {
      o.material.userData = o.material.userData || {};
      if (!('baseOpacity' in o.material.userData)) o.material.userData.baseOpacity = o.material.opacity;
      o.material.opacity = Math.min(1, o.material.userData.baseOpacity * (0.6 + 0.5 * pulse));
    }
  });
}

// ===== EXECUTE =====
// Triggar skill-effekten baserat på primitive-typ. Flyttar cast → execute-fas.
function bossExecuteSkill(side, m, cast) {
  const s = cast.skill;
  cast.phase = 'execute';
  // Re-trigga attack-animation vid execute så bossen "slår" när skadan faktiskt landar
  if (m.mesh) m.mesh.userData.attackTrigger = true;
  if (s.kind === 'groundCircle') {
    cast.timer = 0.45;   // visuell flash-tid
    cast.extras = { meshes: [], done: true };
    spawnGroundImpact(cast.targetX, cast.targetZ, s.radius, 0xff5533);
    applyBossCircleDmg(side, m, cast);
    if (s.knockback) applyBossKnockback(side, cast.targetX, cast.targetZ, s.radius, s.knockback);
    if (s.leaveBurn) spawnPoolDot(side, m, cast.targetX, cast.targetZ, s.radius * 0.7, 3.0, 0.3, 0xff7722);
    return;
  }
  if (s.kind === 'lineDash') {
    cast.timer = s.execTime || 0.5;
    cast.extras = {
      meshes: [],
      done: false,
      dashStartX: cast.originX, dashStartZ: cast.originZ,
      dashEndX: cast.originX + cast.dirX * s.length,
      dashEndZ: cast.originZ + cast.dirZ * s.length,
      damaged: new Set(),
    };
    triggerCameraShake(0.20, 0.18);
    return;
  }
  if (s.kind === 'projectile') {
    spawnBossProjectile(side, m, cast.originX, cast.originZ, cast.dirX, cast.dirZ, s);
    cast.timer = 0.05; cast.extras = { meshes: [], done: true };
    return;
  }
  if (s.kind === 'projectileMulti') {
    const count = s.count || 3;
    const spread = s.spreadAngle || Math.PI / 6;
    const baseAng = Math.atan2(cast.dirX, cast.dirZ);
    for (let i = 0; i < count; i++) {
      const off = count === 1 ? 0 : (-spread / 2 + spread * i / (count - 1));
      const ang = baseAng + off;
      spawnBossProjectile(side, m, cast.originX, cast.originZ, Math.sin(ang), Math.cos(ang), s);
    }
    cast.timer = 0.05; cast.extras = { meshes: [], done: true };
    return;
  }
  if (s.kind === 'cone') {
    cast.timer = 0.4;
    cast.extras = { meshes: [], done: true };
    spawnConeFlash(cast.originX, cast.originZ, cast.dirX, cast.dirZ, s.length, s.halfAngle, 0xff4422);
    applyBossConeDmg(side, m, cast);
    return;
  }
  if (s.kind === 'poolDot') {
    cast.timer = 0.3;
    cast.extras = { meshes: [], done: true };
    spawnPoolDot(side, m, cast.targetX, cast.targetZ, s.radius, s.duration, s.dpsMul, 0x66dd33, s.slow);
    return;
  }
  if (s.kind === 'multiCircle') {
    cast.timer = (s.count || 5) * (s.spawnInterval || 0.6) + 0.5;
    cast.extras = {
      meshes: [],
      done: false,
      spawned: 0,
      spawnTimer: 0,
      circles: [],
    };
    return;
  }
  if (s.kind === 'sweepBeam') {
    cast.timer = s.sweepDuration;
    cast.extras = {
      meshes: [],
      done: false,
      startAng: Math.atan2(cast.dirX, cast.dirZ) - s.halfAngle,
      endAng: Math.atan2(cast.dirX, cast.dirZ) + s.halfAngle,
      damageTimer: 0,
    };
    spawnSweepBeamMesh(cast);
    return;
  }
  if (s.kind === 'sustainedCone') {
    cast.timer = s.sustainDuration;
    cast.extras = {
      meshes: [],
      done: false,
      damageTimer: 0,
    };
    spawnSustainedConeMesh(cast);
    return;
  }
  cast.timer = 0.1; cast.extras = { meshes: [], done: true };
}

function tickBossExecute(side, m, cast, dt) {
  const s = cast.skill;
  if (s.kind === 'lineDash') {
    const e = cast.extras;
    const u = Math.min(1, 1 - cast.timer / (s.execTime || 0.5));
    const cx = e.dashStartX + (e.dashEndX - e.dashStartX) * u;
    const cz = e.dashStartZ + (e.dashEndZ - e.dashStartZ) * u;
    m.mesh.position.x = cx;
    m.mesh.position.z = cz;
    // Skada allt nytt i bredd-band
    applyBossLineDmg(side, m, cast, cx, cz);
    if (cast.timer <= 0) e.done = true;
    return;
  }
  if (s.kind === 'multiCircle') {
    const e = cast.extras;
    e.spawnTimer -= dt;
    if (e.spawned < (s.count || 5) && e.spawnTimer <= 0) {
      // Spawna en cirkel nära boss men random offset (hero som center om targetHero)
      const cx = (s.targetHero ? side.hero.x : cast.originX) + (Math.random() - 0.5) * 2 * (s.spread || 6);
      const cz = (s.targetHero ? side.hero.z : cast.originZ) + (Math.random() - 0.5) * 2 * (s.spread || 6);
      const subCast = {
        skill: { kind: 'groundCircle', radius: s.radius, dmgMul: s.dmgMul, telegraph: 0.7 },
        targetX: cx, targetZ: cz,
        originX: cx, originZ: cz,
        dirX: 0, dirZ: 1,
        telegraphMesh: null,
        phase: 'telegraph', timer: 0.7,
      };
      spawnBossTelegraph(side, m, subCast);
      e.circles.push(subCast);
      e.spawnTimer = (s.spawnInterval || 0.6);
      e.spawned++;
    }
    // Ticka sub-cirklar
    for (let i = e.circles.length - 1; i >= 0; i--) {
      const sub = e.circles[i];
      sub.timer -= dt;
      tickBossTelegraph(side, m, sub, dt);
      if (sub.timer <= 0 && sub.phase === 'telegraph') {
        sub.phase = 'done';
        cleanupTelegraphMesh(sub);
        spawnGroundImpact(sub.targetX, sub.targetZ, s.radius, 0xff6633);
        applyBossCircleDmg(side, m, sub);
      }
      if (sub.phase === 'done' && sub.timer < -0.5) e.circles.splice(i, 1);
    }
    if (e.spawned >= (s.count || 5) && e.circles.length === 0) e.done = true;
    return;
  }
  if (s.kind === 'sweepBeam') {
    const e = cast.extras;
    const u = Math.min(1, 1 - cast.timer / s.sweepDuration);
    const curAng = e.startAng + (e.endAng - e.startAng) * u;
    cast.dirX = Math.sin(curAng); cast.dirZ = Math.cos(curAng);
    if (e.beamMesh) {
      e.beamMesh.position.set(cast.originX + cast.dirX * s.length / 2, 1.0, cast.originZ + cast.dirZ * s.length / 2);
      e.beamMesh.rotation.y = curAng;
    }
    e.damageTimer -= dt;
    if (e.damageTimer <= 0) {
      e.damageTimer = 0.2;
      applyBossBeamDmg(side, m, cast, s.length, 1.4, s.dpsMul * 0.2);
    }
    if (cast.timer <= 0) e.done = true;
    return;
  }
  if (s.kind === 'sustainedCone') {
    const e = cast.extras;
    e.damageTimer -= dt;
    if (e.damageTimer <= 0) {
      e.damageTimer = 0.3;
      applyBossConeDmgRaw(side, m, cast, s.length, s.halfAngle, s.dpsMul * 0.3);
    }
    // Mesh pulsar
    if (e.coneMesh && e.coneMesh.material) {
      e.coneMesh.material.opacity = 0.55 + 0.30 * Math.sin(performance.now() * 0.015);
    }
    if (cast.timer <= 0) e.done = true;
    return;
  }
}

// ===== DAMAGE-APPLIERS =====
// I boss-wars co-op (MP) ska boss-skills träffa ALLA hjältar inom AoE,
// inte bara sides[1]. Helper:
function bossWarsTargets(side) {
  if (bossMpState && bossMpState.matchActive && APP.gameMode === 'bosswars') {
    return [sides[1], sides[2], sides[3]].filter(s => s);
  }
  return [side];
}
function applyBossCircleDmg(side, m, cast) {
  const s = cast.skill;
  const dmg = m.damage * (s.dmgMul || 1);
  for (const tgt of bossWarsTargets(side)) {
    if (tgt.hero.dead) continue;
    if (Math.hypot(tgt.hero.x - cast.targetX, tgt.hero.z - cast.targetZ) < s.radius) {
      damageHero(tgt, dmg);
      if (s.slow) {
        tgt.heroSlowMul = Math.min(tgt.heroSlowMul || 1, s.slow.mul);
        tgt.heroSlowTime = Math.max(tgt.heroSlowTime || 0, s.slow.dur);
      }
    }
  }
}
function applyBossConeDmg(side, m, cast) {
  applyBossConeDmgRaw(side, m, cast, cast.skill.length, cast.skill.halfAngle, cast.skill.dmgMul);
}
function applyBossConeDmgRaw(side, m, cast, length, halfAngle, dmgMul) {
  const dmg = m.damage * (dmgMul || 1);
  for (const tgt of bossWarsTargets(side)) {
    if (tgt.hero.dead) continue;
    const dx = tgt.hero.x - cast.originX, dz = tgt.hero.z - cast.originZ;
    const d = Math.hypot(dx, dz);
    if (d > 0.001 && d < length) {
      const dot = (dx * cast.dirX + dz * cast.dirZ) / d;
      const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (ang < halfAngle) damageHero(tgt, dmg);
    }
  }
}
function applyBossLineDmg(side, m, cast, cx, cz) {
  const s = cast.skill;
  const dmg = m.damage * (s.dmgMul || 1);
  const e = cast.extras;
  for (const tgt of bossWarsTargets(side)) {
    if (tgt.hero.dead) continue;
    const key = 'hero' + tgt.idx;
    if (e.damaged.has(key)) continue;
    const d = Math.hypot(tgt.hero.x - cx, tgt.hero.z - cz);
    if (d < (s.width || 2) * 0.6) {
      damageHero(tgt, dmg);
      e.damaged.add(key);
    }
  }
}
function applyBossBeamDmg(side, m, cast, length, width, dmg) {
  const realDmg = m.damage * dmg;
  for (const tgt of bossWarsTargets(side)) {
    if (tgt.hero.dead) continue;
    const dx = tgt.hero.x - cast.originX, dz = tgt.hero.z - cast.originZ;
    const along = dx * cast.dirX + dz * cast.dirZ;
    if (along > 0 && along < length) {
      const perp = Math.abs(dx * (-cast.dirZ) + dz * cast.dirX);
      if (perp < width) damageHero(tgt, realDmg);
    }
  }
}
function applyBossKnockback(side, x, z, radius, force) {
  for (const tgt of bossWarsTargets(side)) {
    if (tgt.hero.dead) continue;
    const dx = tgt.hero.x - x, dz = tgt.hero.z - z;
    const d = Math.hypot(dx, dz);
    if (d >= radius || d < 0.01) continue;
    const nx = tgt.hero.x + (dx / d) * force;
    const nz = tgt.hero.z + (dz / d) * force;
    if (isHeroWalkable(tgt.idx, nx, nz)) {
      tgt.hero.x = nx; tgt.hero.z = nz;
      if (tgt.mesh) tgt.mesh.position.set(nx, 0, nz);
    }
  }
}

// ===== VISUAL HELPERS =====
function spawnGroundImpact(x, z, radius, color = 0xff5533) {
  // Boss-wars-platformen är på y=0.42 → impact-meshes behöver ligga ovanpå
  const gY = (APP.gameMode === 'bosswars') ? 0.50 : 0.1;
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.5, radius, 36),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, gY, z);
  scene.add(ring);
  combatFx.push({ mesh: ring, life: 0.45, maxLife: 0.45, kind: 'impact' });
  const disk = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.95, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false }));
  disk.rotation.x = -Math.PI / 2;
  disk.position.set(x, gY - 0.01, z);
  scene.add(disk);
  combatFx.push({ mesh: disk, life: 0.40, maxLife: 0.40, kind: 'impact' });
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * radius * 0.9;
    spawnHitSparkFx(x + Math.cos(a) * r, 0.4 + Math.random() * 0.8, z + Math.sin(a) * r, color);
  }
  triggerCameraShake(0.15, 0.15);
}

function spawnConeFlash(x, z, dx, dz, length, halfAngle, color) {
  const segs = 14;
  const geom = new THREE.BufferGeometry();
  const verts = [0, 0, 0];
  for (let i = 0; i <= segs; i++) {
    const a = -halfAngle + 2 * halfAngle * (i / segs);
    verts.push(Math.sin(a) * length, 0, Math.cos(a) * length);
  }
  const idx = [];
  for (let i = 1; i <= segs; i++) idx.push(0, i, i + 1);
  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geom.setIndex(idx);
  geom.computeVertexNormals();
  const fan = new THREE.Mesh(geom,
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
  fan.position.set(x, 0.1, z);
  fan.rotation.y = Math.atan2(dx, dz);
  scene.add(fan);
  combatFx.push({ mesh: fan, life: 0.4, maxLife: 0.4, kind: 'cone-flash' });
  triggerCameraShake(0.22, 0.20);
}

function spawnBossProjectile(side, m, x, z, dx, dz, skill) {
  side.bossProjectiles = side.bossProjectiles || [];
  const dmg = m.damage * (skill.dmgMul || 1);
  const grp = new THREE.Group();
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 14, 10),
    new THREE.MeshStandardMaterial({ color: 0xff4422, emissive: 0xff3311, emissiveIntensity: 1.4 }));
  grp.add(head);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.7, 8),
    new THREE.MeshBasicMaterial({ color: 0xff7733, transparent: true, opacity: 0.7 }));
  tail.rotation.x = Math.PI / 2;
  tail.position.z = -0.5;
  grp.add(tail);
  grp.rotation.y = Math.atan2(dx, dz);
  grp.position.set(x, 1.1, z);
  scene.add(grp);
  side.bossProjectiles.push({
    mesh: grp, x, z, dx, dz,
    speed: skill.speed || 14,
    damage: dmg,
    radius: skill.radius || 0.8,
    range: skill.range || 14,
    traveled: 0,
  });
}

function tickBossProjectiles(side, dt) {
  if (!side.bossProjectiles) return;
  for (let i = side.bossProjectiles.length - 1; i >= 0; i--) {
    const p = side.bossProjectiles[i];
    const step = p.speed * dt;
    p.x += p.dx * step; p.z += p.dz * step; p.traveled += step;
    p.mesh.position.set(p.x, 1.1, p.z);
    spawnProjectileTrailPuff(p.x, 1.0, p.z, 0xff7733);
    // Träffa hjälte (i co-op: alla 3)
    let hit = false;
    for (const tgt of bossWarsTargets(side)) {
      if (tgt.hero.dead) continue;
      if (Math.hypot(tgt.hero.x - p.x, tgt.hero.z - p.z) < p.radius + 0.45) {
        damageHero(tgt, p.damage);
        hit = true;
        break;
      }
    }
    if (hit) {
      if (p.mesh.geometry) p.mesh.geometry.dispose?.();
      p.mesh.traverse(o => { if (o.isMesh) { o.geometry?.dispose(); o.material?.dispose(); } });
      scene.remove(p.mesh);
      side.bossProjectiles.splice(i, 1);
      continue;
    }
    if (p.traveled > p.range) {
      p.mesh.traverse(o => { if (o.isMesh) { o.geometry?.dispose(); o.material?.dispose(); } });
      scene.remove(p.mesh);
      side.bossProjectiles.splice(i, 1);
    }
  }
}

function spawnPoolDot(side, m, x, z, radius, duration, dpsMul, color = 0x66dd33, slow = null) {
  const grp = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.85, radius, 36),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  grp.add(ring);
  const disk = new THREE.Mesh(new THREE.CircleGeometry(radius, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.40, side: THREE.DoubleSide, depthWrite: false }));
  disk.rotation.x = -Math.PI / 2;
  grp.add(disk);
  grp.position.set(x, 0.07, z);
  scene.add(grp);
  side.bossPools = side.bossPools || [];
  side.bossPools.push({
    mesh: grp, x, z, radius,
    life: duration, maxLife: duration,
    dps: m.damage * dpsMul,
    tickAccum: 0,
    slow,
    color,
  });
}

function tickBossPools(side, dt) {
  if (!side.bossPools) return;
  for (let i = side.bossPools.length - 1; i >= 0; i--) {
    const p = side.bossPools[i];
    p.life -= dt;
    p.tickAccum += dt;
    // Skada hjälten var 0.5s om i pöl (co-op: alla 3)
    if (p.tickAccum >= 0.5) {
      p.tickAccum -= 0.5;
      for (const tgt of bossWarsTargets(side)) {
        if (tgt.hero.dead) continue;
        if (Math.hypot(tgt.hero.x - p.x, tgt.hero.z - p.z) < p.radius) {
          damageHero(tgt, p.dps * 0.5);
          if (p.slow) {
            tgt.heroSlowMul = Math.min(tgt.heroSlowMul || 1, p.slow.mul);
            tgt.heroSlowTime = Math.max(tgt.heroSlowTime || 0, p.slow.dur);
          }
        }
      }
    }
    // Spawna gröna bubblor
    if (Math.random() < 0.4) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * p.radius * 0.9;
      spawnProjectileTrailPuff(p.x + Math.cos(a) * r, 0.3 + Math.random() * 0.5, p.z + Math.sin(a) * r, p.color);
    }
    // Fade ut mot slutet
    const fade = Math.min(1, p.life / 0.8);
    p.mesh.traverse(o => {
      if (o.material && o.material.transparent) {
        const base = o.material.userData?.baseOpacity || o.material.opacity;
        o.material.userData = o.material.userData || { baseOpacity: o.material.opacity };
        o.material.opacity = (o.material.userData.baseOpacity || 0.5) * fade;
      }
    });
    if (p.life <= 0) {
      p.mesh.traverse(o => { if (o.isMesh) { o.geometry?.dispose(); o.material?.dispose(); } });
      scene.remove(p.mesh);
      side.bossPools.splice(i, 1);
    }
  }
}

function spawnSweepBeamMesh(cast) {
  const s = cast.skill;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, s.length, 14),
    new THREE.MeshBasicMaterial({ color: 0xff4422, transparent: true, opacity: 0.85 }));
  beam.rotation.x = Math.PI / 2;
  beam.position.set(cast.originX + cast.dirX * s.length / 2, 1.0, cast.originZ + cast.dirZ * s.length / 2);
  beam.rotation.y = Math.atan2(cast.dirX, cast.dirZ);
  scene.add(beam);
  cast.extras.beamMesh = beam;
  cast.extras.meshes = [beam];
}

function spawnSustainedConeMesh(cast) {
  const s = cast.skill;
  const r = s.length;
  const ang = s.halfAngle;
  const segs = 16;
  const geom = new THREE.BufferGeometry();
  const verts = [0, 0, 0];
  for (let i = 0; i <= segs; i++) {
    const a = -ang + 2 * ang * (i / segs);
    verts.push(Math.sin(a) * r, 0, Math.cos(a) * r);
  }
  const idx = [];
  for (let i = 1; i <= segs; i++) idx.push(0, i, i + 1);
  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geom.setIndex(idx);
  geom.computeVertexNormals();
  const cone = new THREE.Mesh(geom,
    new THREE.MeshBasicMaterial({ color: 0xff6622, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
  cone.position.set(cast.originX, 0.12, cast.originZ);
  cone.rotation.y = Math.atan2(cast.dirX, cast.dirZ);
  scene.add(cone);
  cast.extras.coneMesh = cone;
  cast.extras.meshes = [cone];
}

// Tickar aura: pulsering + sporadiska smoke-puffs i världen runt boss
function tickBossAura(mesh, dt) {
  const a = mesh.userData.bossAura;
  if (!a) return;
  const t = performance.now() * 0.0025;
  if (a.smoke && a.smoke.material) a.smoke.material.opacity = (a.isMini ? 0.18 : 0.28) + 0.08 * Math.sin(t);
  if (a.outer && a.outer.material) a.outer.material.opacity = (a.isMini ? 0.07 : 0.11) + 0.05 * Math.sin(t * 0.7 + 1);
  if (a.eyeLight) a.eyeLight.intensity = (a.isMini ? 0.9 : 1.8) + 0.4 * Math.sin(t * 1.4);
  if (a.smoke) a.smoke.rotation.y += dt * 0.4;
  if (a.outer) a.outer.rotation.y -= dt * 0.25;
  // Spawnar rök-puffs runt boss — sänkt rate för bättre perf i boss-wars
  // (förr 0.18s = 5.5 puffs/s vilket spammade combatFx)
  const interval = a.isMini ? 0.6 : 0.35;
  a.puffAccum = (a.puffAccum || 0) + dt;
  while (a.puffAccum >= interval) {
    a.puffAccum -= interval;
    const ang = Math.random() * Math.PI * 2;
    const r = (a.isMini ? 0.5 : 1.0) * a.scale * (0.7 + Math.random() * 0.4);
    const px = mesh.position.x + Math.cos(ang) * r;
    const pz = mesh.position.z + Math.sin(ang) * r;
    const py = (a.isMini ? 0.3 : 0.6) * a.scale + Math.random() * 0.5 * a.scale;
    spawnProjectileTrailPuff(px, py, pz, a.auraColor);
  }
}

function updateMonsters(side, dt) {
  // Side's monsters lever i side's egen arena. De jagar side's hjälte och attackerar
  // motståndarens playerCreeps (som är i samma arena).
  const oppIdx = 3 - side.idx;
  const opp = sides[oppIdx];
  const towerPos = SIDE_CFG[side.idx].tower;
  // Boss Wars MP co-op: bossen ska jaga närmsta levande hjälte av alla 3
  const bwCoOp = bossMpState && bossMpState.matchActive && APP.gameMode === 'bosswars';

  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    // Per-monster mål: default = side.hero. För boss-wars co-op-boss: närmsta levande hjälte.
    let heroX = side.hero.x, heroZ = side.hero.z;
    let heroAlive = !side.hero.dead;
    let targetSide = side;
    if (bwCoOp && m.isBossWarsBoss) {
      let best = null, bestDist = Infinity;
      for (const idx of [1, 2, 3]) {
        const s = sides[idx];
        if (!s || s.hero.dead) continue;
        const dd = (s.hero.x - m.mesh.position.x) ** 2 + (s.hero.z - m.mesh.position.z) ** 2;
        if (dd < bestDist) { bestDist = dd; best = s; }
      }
      if (best) { heroX = best.hero.x; heroZ = best.hero.z; heroAlive = true; targetSide = best; }
      else heroAlive = false;
    }

    // DoT-tick (Fire Wave)
    if ((m.dotRemaining || 0) > 0) {
      m.dotRemaining -= dt;
      m.hp -= (m.dotPerSec || 0) * dt;
      if (m.hp <= 0) { hostKillMonster(side, i, side); continue; }
    }
    // Poison-stack-tick
    if ((m.poisonRemaining || 0) > 0 && (m.poisonStacks || 0) > 0) {
      m.poisonRemaining -= dt;
      const s = m.poisonStacks;
      m.hp -= POISON_BASE_DPS * s * (1 + 0.10 * (s - 1)) * dt;
      if (m.poisonRemaining <= 0) m.poisonStacks = 0;
      if (m.hp <= 0) { hostKillMonster(side, i, side); continue; }
    }
    // Gandulf Soul Mark DoT (5% current HP/sek + healar caster)
    if (m.gandulfMarkRemaining > 0) {
      tickGandulfMarkClient(m, dt);
      if (m.hp <= 0) { hostKillMonster(side, i, side); continue; }
    }
    // Boss/miniboss: aura-tick varje frame
    if (m.isBoss || m.isMiniBoss) tickBossAura(m.mesh, dt);
    // Phase 2-aura (egen tick — endast aktiv när bossen gått in i phase 2)
    if (m.isBossWarsBoss && m.mesh && m.mesh.userData.phase2Aura) tickBossPhase2Aura(m.mesh, dt);
    // Boss Wars: bossen är inaktiv (står still, attackar inte, castar inga skills)
    // tills alla aktiva heroes är inne i boss-rummet. tickBossSkills bail:ar redan
    // i sin egen check; här skippar vi också movement + AA.
    if (m.isBossWarsBoss && APP.bossWars && !APP.bossWars.bossActivated) {
      continue;
    }
    // Frusen: hoppa över movement + attack + boss-skills
    if ((m.frozenTime || 0) > 0) {
      m.frozenTime -= dt;
      continue;
    }
    // Feared: kan inte agera (taggas i tickFearWave; här bara skippa AI)
    if ((m.fearTime || 0) > 0) {
      continue;
    }
    // Taunted: tvinga chase
    if ((m.tauntedTime || 0) > 0) { m.tauntedTime -= dt; m.chasing = true; }
    // Boss Wars phase-transition — alla 5 bossar har phase 2 (tier 1-3 vid 50%,
    // tier 4-5 vid 30%). Invulnerable + flyger upp/landar med nya skills.
    if (m.isBossWarsBoss && m.bossPhase === 1 && m.phase2Skills && m.hp <= m.maxHp * (m.phaseThreshold || 0.5)) {
      triggerBossPhaseTransition(side, m);
    }
    if ((m.phaseTransitionRemaining || 0) > 0) {
      m.phaseTransitionRemaining = Math.max(0, m.phaseTransitionRemaining - dt);
      // Animera y-position: bågformig flyg-upp + land
      const total = m.phaseTransitionTotal || 2.5;
      const u = 1 - m.phaseTransitionRemaining / total;   // 0 → 1
      // Sinus-båge: y peaks vid u=0.5
      const peakY = 7.0;
      m.mesh.position.y = Math.sin(u * Math.PI) * peakY;
      // Spinn medan i luften
      m.mesh.rotation.y += dt * 4.5;
      // Vid landning: byt skill-set + reset
      if (m.phaseTransitionRemaining <= 0 && m._pendingPhase2) {
        m._pendingPhase2 = false;
        m.bossSkills = m.phase2Skills;
        m.skillCds = m.phase2Skills.map(s => s.cd * 0.4);
        m.mesh.position.y = 0;
        m.mesh.rotation.y = 0;
        // Boost dmg lite för phase 2 (raid-känsla)
        m.damage = Math.round(m.damage * 1.25);
        // Visuell landningsburst
        spawnGroundImpact(m.mesh.position.x, m.mesh.position.z, 8, 0xff44aa);
        triggerCameraShake(0.5, 0.5);
        // Phase 2 aura/glow (tier-specifik färg)
        applyBossPhase2Glow(m.mesh, m.bossTier);
      }
      continue;   // Skip all normal monster AI under transition
    }
    // Boss/miniboss-skill: under cast pausar normal AI
    if (m.bossSkills) {
      tickBossSkills(side, m, dt);
      if (m.activeCast) continue;
    }

    // Nått tornet?
    const dxT = towerPos.x - m.mesh.position.x;
    const dzT = towerPos.z - m.mesh.position.z;
    if (dxT * dxT + dzT * dzT < TOWER_REACH * TOWER_REACH) {
      side.tower.hp = Math.max(0, side.tower.hp - 1);
      scene.remove(m.mesh);
      side.monsters.splice(i, 1);
      continue;
    }

    // Aggro mot hjälten. Legolus i Shadow Volley-invis ses ej av fiender —
    // aggro/atk skippas (gäller Boss Wars-boss också, han tappar lock).
    const dxh = heroX - m.mesh.position.x;
    const dzh = heroZ - m.mesh.position.z;
    const distHero = Math.hypot(dxh, dzh);
    const heroVisible = heroAlive && !((targetSide.legolusInvisRemaining || 0) > 0);
    if (!heroVisible) m.chasing = false;
    else if (!m.chasing && distHero < MONSTER_AGGRO_RANGE) m.chasing = true;
    else if (m.chasing && distHero > MONSTER_LEASH_RANGE && !m.isBossWarsBoss) m.chasing = false;
    // Boss Wars: bossen jagar ALLTID hjälten oavsett avstånd (men förlorar lock om invis)
    if (m.isBossWarsBoss && heroVisible) m.chasing = true;

    m.atkCd = Math.max(0, m.atkCd - dt);
    const mAtkRange = m.attackRange || 1.2;
    const mAtkInterval = m.attackInterval || MONSTER_MELEE_INTERVAL;
    if (heroVisible && distHero < mAtkRange && m.atkCd <= 0) {
      damageHero(targetSide, m.damage || MONSTER_MELEE_DAMAGE);
      m.atkCd = mAtkInterval;
      spawnSlashFx(targetSide.hero.x, targetSide.hero.z, 0xff5544);
      // Trigga attack-animation på boss-mesh
      if (m.mesh) m.mesh.userData.attackTrigger = true;
      // Boss-AA: extra visuell feedback så animationen syns tydligt.
      // Ground-impact vid bossens fot + slash vid heroens position.
      if (m.isBossWarsBoss && m.mesh) {
        spawnGroundImpact(m.mesh.position.x, m.mesh.position.z, 2.2, 0xff6644);
        spawnHitSparkFx(targetSide.hero.x, 1.2, targetSide.hero.z, 0xffaa44);
      }
      // Räknare för boss-AA — syncas till klienter via b-state så klienter
      // kan trigga visuell attack-animation lokalt (delta-detection).
      if (m.isBossWarsBoss) m.aaCount = (m.aaCount || 0) + 1;
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
    // Boss Wars: använd boss-wars-arena-bounds istället för classic-lane-bounds
    // (bossen står annars stilla eftersom arenan ligger på z=60-120, utanför
    // isCreepPos-regionerna).
    const walkOk = (x, z) => (APP.gameMode === 'bosswars') ? isBossWarsPos(x, z) : isCreepPos(x, z);
    if (walkOk(nx, nz)) { m.mesh.position.x = nx; m.mesh.position.z = nz; }
    else if (walkOk(nx, m.mesh.position.z)) m.mesh.position.x = nx;
    else if (walkOk(m.mesh.position.x, nz)) m.mesh.position.z = nz;
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
    // Poison-stack-tick
    if ((c.poisonRemaining || 0) > 0 && (c.poisonStacks || 0) > 0) {
      c.poisonRemaining -= dt;
      const s = c.poisonStacks;
      c.hp -= POISON_BASE_DPS * s * (1 + 0.10 * (s - 1)) * dt;
      if (c.poisonRemaining <= 0) c.poisonStacks = 0;
      if (c.hp <= 0) { scene.remove(c.mesh); side.playerCreeps.splice(i, 1); continue; }
    }
    // Gandulf Soul Mark DoT
    if (c.gandulfMarkRemaining > 0) {
      tickGandulfMarkClient(c, dt);
      if (c.hp <= 0) { scene.remove(c.mesh); side.playerCreeps.splice(i, 1); continue; }
    }
    // Frusen — hoppa över
    if ((c.frozenTime || 0) > 0) {
      c.frozenTime -= dt;
      continue;
    }
    // Slow-tick: decay slowMul tillbaka till 1 när slowTime expirar
    if ((c.slowTime || 0) > 0) {
      c.slowTime -= dt;
      if (c.slowTime <= 0) { c.slowTime = 0; c.slowMul = 1.0; }
    }
    // Feared — kan inte agera
    if ((c.fearTime || 0) > 0) {
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
          // Direkt skada + slash-fx vid målet
          if (targetType === 'hero') {
            damageHero(opp, c.damage);
            spawnSlashFx(opp.hero.x, opp.hero.z, 0xff5544);
          } else {
            target.hp -= c.damage;
            spawnSlashFx(target.mesh.position.x, target.mesh.position.z, 0xffaa44);
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
    const step = c.speed * (c.slowMul || 1) * dt;
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
      // Träff — spawna hit-spark
      const sparkColor = p.aoeRadius > 0 ? 0xb060ff : 0xffd060;
      spawnHitSparkFx(tx, Math.max(0.5, p.mesh.position.y), tz, sparkColor);
      if (p.targetType === 'hero') {
        damageHero(opp, p.damage);
        spawnSlashFx(opp.hero.x, opp.hero.z, sparkColor);
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
            spawnSlashFx(opp.hero.x, opp.hero.z, 0xb060ff);
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
  // Rensa aktiv cast + dess telegraph-mesh
  if (m.activeCast) {
    cleanupTelegraphMesh(m.activeCast);
    cleanupExecuteMesh(m.activeCast);
    m.activeCast = null;
  }
  scene.remove(m.mesh);
  side.monsters.splice(idx, 1);
  // Boss-belöning: 5× guld + XP
  const goldReward = m.isBoss ? GOLD_PER_KILL * 5 : (m.isMiniBoss ? GOLD_PER_KILL * 2 : GOLD_PER_KILL);
  const xpReward = m.isBoss ? MONSTER_XP_REWARD * 5 : (m.isMiniBoss ? MONSTER_XP_REWARD * 2 : MONSTER_XP_REWARD);
  if (byPlayerSide) { byPlayerSide.gold += goldReward; gainXp(byPlayerSide, xpReward); }
  else { side.gold += goldReward; gainXp(side, xpReward); }
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
  // Boss Wars Phoenix Amulet: revive en gång vid 50% HP istället för att dö
  if (side.phoenixReviveAvailable && APP.gameMode === 'bosswars') {
    side.phoenixReviveAvailable = false;
    side.hero.hp = Math.round(side.hero.maxHp * 0.5);
    spawnSkillCastFx(side.hero.x, side.hero.z, 0xff7733, 3.0);
    spawnShieldBurstFx(side.hero.x, side.hero.z, 0xffaa44);
    triggerCameraShake(0.4, 0.5);
    return;   // hero överlever — INTE dead
  }
  side.hero.dead = true;
  side.hero.respawnTimer = RESPAWN_TIME;
  // Avbryt pågående ultimates vid död
  if (side.rageRemaining > 0) {
    side.rageRemaining = 0;
    if (side.mesh) side.mesh.scale.set(1, 1, 1);
  }
  if (side.laserBeam) {
    for (const m of [side.laserBeam.mesh, side.laserBeam.core, side.laserBeam.halo]) {
      if (!m) continue;
      scene.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose();
    }
    side.laserBeam = null;
  }
  if (side.soulDrain || side.soulDrainBeam) {
    removeSoulDrainBeam(side);
    side.soulDrain = null;
  }
  // Aragurn ult: rensa svärds-aura + reset scale
  if (side.berserkRemaining > 0) {
    side.berserkRemaining = 0;
    if (side.mesh) side.mesh.scale.set(1, 1, 1);
  }
  if (side.berserkSwordMesh) {
    side.berserkSwordMesh.traverse(o => {
      if (o.isMesh) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }
    });
    scene.remove(side.berserkSwordMesh);
    side.berserkSwordMesh = null;
  }
  // Aragurn leap: avbryt + rensa indikator
  if (side.aragurnLeap) {
    if (side.aragurnLeap.indicator) {
      if (side.aragurnLeap.indicator.material) side.aragurnLeap.indicator.material.dispose();
      if (side.aragurnLeap.indicator.geometry) side.aragurnLeap.indicator.geometry.dispose();
      scene.remove(side.aragurnLeap.indicator);
    }
    side.aragurnLeap = null;
  }
  if (side.whirlwindRemaining > 0) side.whirlwindRemaining = 0;
  // Återställ Aragurn-svärd till default-position (var ute under whirlwind)
  if (side.mesh && side.mesh.userData.aragurnSword && side.mesh.userData.aragurnSwordDefault) {
    const sword = side.mesh.userData.aragurnSword;
    const def = side.mesh.userData.aragurnSwordDefault;
    sword.position.copy(def.pos);
    sword.rotation.copy(def.rot);
  }
  // I arena: behåll mesh synlig så GLTF death-animationen syns
  if (APP.gameMode !== 'arena1v1') {
    side.mesh.visible = false;
  }
}

function respawnHero(side) {
  const cfg = SIDE_CFG[side.idx];
  side.hero.dead = false;
  side.hero.hp = side.hero.maxHp;
  side.hero.x = cfg.heroSpawn.x;
  side.hero.z = cfg.heroSpawn.z;
  side.mesh.position.set(side.hero.x, 0, side.hero.z);
  side.mesh.visible = true;
  // Reset item-stacks vid respawn
  side.furyStacks = 0;
  side.furyTargetId = 0;
  side.titansInstanceStacks = 0;
  side.titansBlockPending = false;
  side.lingShieldHp = 0;
  side.lingShieldRefreshTimer = 0.5;
  // Shadow Volley state: rensa invis + aaPending så hero inte är osynlig på respawn
  side.legolusInvisRemaining = 0;
  side.legolusUltAaPending = false;
}

// ============================================================
// HJÄLTENS AUTO-ATTACK
// ============================================================

function findClosestHostile(side, x, z, maxDist) {
  // Hjälten attackerar fientliga entiteter i sin egen arena:
  // - side.monsters (egen inkommande wave)
  // - opp.playerCreeps (motståndarens skickade grunts som är i denna arena)
  // - arena: special orb i mitten + opposing hero
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
  if (APP.gameMode === 'arena1v1' && arenaState.phase === 'fight') {
    if (arenaState.orb.alive && arenaOrbMesh) {
      const ox = ARENA_CFG.orb.x, oz = ARENA_CFG.orb.z;
      const d = Math.hypot(ox - x, oz - z);
      if (d < bestDist) {
        if (!arenaState.orbTarget) {
          // Använd getter för mesh så vi alltid har current referens
          arenaState.orbTarget = {
            id: -100, isArenaOrb: true,
            get mesh() { return arenaOrbMesh; },
          };
        }
        bestDist = d;
        best = { entity: arenaState.orbTarget, isMonster: false, targetType: 'arena-orb' };
      }
    }
    // 2v2: leta efter ALLA opp-team-hjältar (1v1: bara opp som var)
    const oppHeroes = APP.arenaTeamSize === 2
      ? arenaOppTeamSides(side)
      : (opp ? [opp] : []);
    for (const oh of oppHeroes) {
      if (oh.hero.dead) continue;
      const d = Math.hypot(oh.hero.x - x, oh.hero.z - z);
      if (d < bestDist) {
        if (!arenaState.heroTargets) arenaState.heroTargets = {};
        if (!arenaState.heroTargets[oh.idx]) {
          arenaState.heroTargets[oh.idx] = {
            id: -200 + oh.idx, isArenaHero: true, sideIdx: oh.idx,
            get mesh() { return sides[this.sideIdx]?.mesh; },
          };
        }
        bestDist = d;
        best = { entity: arenaState.heroTargets[oh.idx], isMonster: false, targetType: 'arena-hero' };
      }
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
  if (side.targetType === 'arena-orb') {
    return (arenaState.orb.alive && arenaState.orbTarget) ? arenaState.orbTarget : null;
  }
  if (side.targetType === 'arena-hero') {
    const oppIdx = 3 - side.idx;
    const oppSide = sides[oppIdx];
    if (!oppSide || oppSide.hero.dead) return null;
    return (arenaState.heroTargets && arenaState.heroTargets[oppIdx]) || null;
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
  // Taunt-lock: tauntad hero tvingas attackera taunter:s hero
  if ((side.hero.tauntedTime || 0) > 0 && side.hero.tauntedBy) {
    const tauntSide = sides[side.hero.tauntedBy];
    if (tauntSide && !tauntSide.hero.dead) {
      side.aaActive = true;
      if (!arenaState.heroTargets) arenaState.heroTargets = {};
      if (!arenaState.heroTargets[tauntSide.idx]) {
        arenaState.heroTargets[tauntSide.idx] = {
          id: -200 + tauntSide.idx, isArenaHero: true, sideIdx: tauntSide.idx,
          get mesh() { return sides[this.sideIdx]?.mesh; },
        };
      }
      side.targetId = arenaState.heroTargets[tauntSide.idx].id;
      side.targetType = 'arena-hero';
    }
  }
  let target = resolveTargetEntity(side, opp);
  let isMonster = side.targetType === 'monster';
  const baseRange = side.attackRange || HERO_ATTACK_RANGE;
  // Shadow Volley empowered AA: dubbel range medan invis-ult-pending (klient-mirror av server).
  const range = (side.heroId === 'legolas' && side.legolusUltAaPending)
    ? baseRange * 2.0 : baseRange;
  if (target) {
    const tx = target.mesh.position.x, tz = target.mesh.position.z;
    const d = Math.hypot(tx - side.hero.x, tz - side.hero.z);
    if (d > range) target = null;
  }
  if (!target) {
    // Manuell AA: ingen auto-pick av nästa target. Target dog eller är out of
    // range → sluta attackera. Användaren måste trycka Attack-knappen igen.
    side.aaActive = false;
    side.targetId = 0; side.targetType = '';
    return null;
  }
  side.targetX = target.mesh.position.x;
  side.targetZ = target.mesh.position.z;
  return { entity: target, isMonster };
}

function updateHeroAttack(side, dt) {
  side.attackCd = Math.max(0, side.attackCd - dt);
  if (side.hero.dead || !side.aaActive) return;
  // Aragurn under whirlwind / leap: ingen AA
  if ((side.whirlwindRemaining || 0) > 0 || side.aragurnLeap) return;
  const target = maintainTargetLock(side);
  if (!target || side.attackCd > 0) return;
  side.attackCounter++;
  const isAoE = side.attackCounter % PASSIVE_EVERY === 0;

  // ---- Ling & Lang: Fury Stacks ----
  // 1% AS + 1% AAdmg per AA mot SAMMA target, max 10. Första AA mot nytt
  // target ger inga stacks (specen: "+1% per AA on same target").
  const hasLingLang = side.inventory && side.inventory.some(it => it.itemId === 'item3');
  if (hasLingLang) {
    const tid = target.entity.id;
    if (side.furyTargetId === tid) {
      side.furyStacks = Math.min(10, (side.furyStacks || 0) + 1);
    } else {
      side.furyTargetId = tid;
      side.furyStacks = 0;
    }
  } else {
    side.furyStacks = 0;
    side.furyTargetId = 0;
  }
  const furyMul = 1 + 0.01 * (side.furyStacks || 0);

  // ---- Titans Armor: var 3:e AA → block nästa inkommande skada ----
  const hasTitans = side.inventory && side.inventory.some(it => it.itemId === 'item5');
  if (hasTitans && side.attackCounter % 3 === 0) {
    side.titansBlockPending = true;
  }
  // Crit-info räknas ut nedan men vi behöver det tidigare för mesh-färgen
  const _preBuffActive = (side.legolusBuffRemaining || 0) > 0;
  const _preCritCh = (side.critChancePct || 0) + (_preBuffActive ? LEGOLUS_BUFF_CRIT_PCT : 0)
                     + (side.legolusDashBuffPending ? 1.0 : 0);
  const _meshIsCrit = _preCritCh > 0.5;  // approx — visualen behöver inte vara perfekt synkad
  const mesh = makeHeroAaProjectileMesh(side.heroId || 'magiker', isAoE, _meshIsCrit);
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
  const isLegolusHero = side.heroId === 'legolas';
  const splitNow = isLegolusHero && !!side.legolusSplitPending;
  if (splitNow) side.legolusSplitPending = false;
  // Talent: Phantom Dash — lifesteal 20% → 50% när dash-buffed
  const dashLs = arenaHasTalent(side, 'l_dash_buff') ? 0.50 : LEGOLUS_DASH_LIFESTEAL;
  // Aragurn passive (Last Stand) + berserk AA dmg multiplier
  const aragurnPassive = aragurnPassiveMul(side);
  const berserkActive = (side.berserkRemaining || 0) > 0;
  const berserkMul = berserkActive ? BERSERK_AA_DMG_MUL : 1;
  let aaDmg = side.attackDmg * auraDmg * buffDmgMul * critMul * furyMul * aragurnPassive * berserkMul;
  // Berserk: 25% lifesteal på AA. Stackar additivt med dash-buff (annars dash overrider).
  const berserkLs = berserkActive ? BERSERK_AA_LIFESTEAL : 0;
  const aaLifesteal = dashBuffed ? dashLs : berserkLs;
  // Shadow Volley empowered AA: dmg = 25% target's maxHp + stun + thorn pool vid hit.
  // Revealar Legolus direkt vid spawn av pilen.
  const ultAaNow = isLegolusHero && !!side.legolusUltAaPending;
  if (ultAaNow) {
    const tEnt = target.entity;
    const tMax = tEnt.maxHp || tEnt.hp || aaDmg;
    aaDmg = tMax * 0.25;
    side.legolusUltAaPending = false;
    side.legolusInvisRemaining = 0;
  }
  side.projectiles.push({
    mesh, target: target.entity, targetIsMonster: target.isMonster,
    ownerSide: target.isMonster ? side : sides[3 - side.idx] || side,
    damage: aaDmg, isAoE, isCrit,
    lifestealRatio: aaLifesteal,
    legolusBuffed: dashBuffed,
    appliesPoison: splitNow,
    legolusUltAa: ultAaNow,
  });
  // Aragurn Berserk: 100% cleave — varje AA träffar ALLA fiender inom AA-range
  // (utöver huvudtarget). Extra projektiler spawnar mot var och en.
  if (berserkActive && side.heroId === 'aragurn') {
    const opp2 = sides[3 - side.idx];
    const aaRange = side.attackRange || 4;
    const cleaveExtras = [];
    const cleaveSeen = new Set([target.entity]);
    const tryAddCleave = (list, isMonster) => {
      for (const e of list) {
        if (cleaveSeen.has(e)) continue;
        const dC = Math.hypot(e.mesh.position.x - side.hero.x, e.mesh.position.z - side.hero.z);
        if (dC > aaRange + 0.5) continue;
        cleaveExtras.push({ entity: e, isMonster });
        cleaveSeen.add(e);
      }
    };
    tryAddCleave(side.monsters, true);
    if (opp2) tryAddCleave(opp2.playerCreeps, false);
    for (const c of cleaveExtras) {
      const m2 = makeHeroAaProjectileMesh('aragurn', false, false);
      m2.scale.setScalar(0.85);
      m2.position.set(side.hero.x, 1.5, side.hero.z);
      scene.add(m2);
      side.projectiles.push({
        mesh: m2, target: c.entity, targetIsMonster: c.isMonster,
        ownerSide: c.isMonster ? side : (sides[3 - side.idx] || side),
        damage: aaDmg, isAoE: false, isCrit: false,
        lifestealRatio: 0, legolusBuffed: false, appliesPoison: false,
      });
    }
  }
  if (splitNow) {
    const opp = sides[3 - side.idx];
    const extras = [];
    const seen = new Set([target.entity]);
    function tryAdd(list, isMonster) {
      const candidates = [];
      for (const e of list) {
        if (seen.has(e)) continue;
        const d = Math.hypot(e.mesh.position.x - side.hero.x, e.mesh.position.z - side.hero.z);
        if (d > LEGOLUS_SPLIT_RANGE) continue;
        candidates.push({ e, d, isMonster });
      }
      candidates.sort((a, b) => a.d - b.d);
      for (const c of candidates) {
        if (extras.length >= LEGOLUS_SPLIT_EXTRAS) break;
        extras.push(c); seen.add(c.e);
      }
    }
    tryAdd(side.monsters, true);
    if (extras.length < LEGOLUS_SPLIT_EXTRAS && opp) tryAdd(opp.playerCreeps, false);
    for (const ex of extras) {
      const m2 = makeHeroAaProjectileMesh('legolas', false, false);
      // Poison-pilar är mindre och har lila-grön emissive
      m2.scale.setScalar(0.75);
      m2.traverse(o => {
        if (o.material && o.material.emissive) o.material.emissive.setHex(0x88dd44);
      });
      m2.position.set(side.hero.x, 1.5, side.hero.z);
      scene.add(m2);
      side.projectiles.push({
        mesh: m2, target: ex.e, targetIsMonster: ex.isMonster,
        ownerSide: ex.isMonster ? side : (sides[3 - side.idx] || side),
        damage: side.attackDmg * auraDmg * buffDmgMul, isAoE: false, isCrit: false,
        lifestealRatio: 0, legolusBuffed: false, appliesPoison: true,
      });
    }
  }
  if (isLegolusHero) {
    side.legolusAaCounter = (side.legolusAaCounter || 0) + 1;
    if (side.legolusAaCounter % LEGOLUS_PASSIVE_EVERY === 0) side.legolusSplitPending = true;
  }
  // Legolas ult-buff: +30% AS efter teleport-träff
  const ultAsMul = (side.legolusUltBuff || 0) > 0 ? (1 + LEGOLUS_ULT_AS_BONUS) : 1;
  // Legolas Hunter's Focus (F-buff): +30% AS under buff-duration
  const focusAsMul = (side.legolusBuffRemaining || 0) > 0 ? (1 + LEGOLUS_BUFF_AS_PCT) : 1;
  // Aragurn berserk-buff: -50% AS (interval * 2)
  const berserkAsMul = (side.berserkRemaining || 0) > 0 ? BERSERK_AS_MUL : 1;
  const interval = side.attackInterval || HERO_ATTACK_INTERVAL;
  side.attackCd = interval / ((side.attackSpeedMul || 1) * auraAs * furyMul * ultAsMul * focusAsMul * berserkAsMul);
}

function updateProjectiles(side, dt) {
  const opp = sides[3 - side.idx];
  for (let i = side.projectiles.length - 1; i >= 0; i--) {
    const p = side.projectiles[i];
    // Target lever?
    const isArenaOrbT = !!p.target?.isArenaOrb;
    const isArenaHeroT = !!p.target?.isArenaHero;
    const targetAlive = isArenaOrbT
      ? arenaState.orb.alive
      : isArenaHeroT
        ? (sides[p.target.sideIdx] && !sides[p.target.sideIdx].hero.dead)
        : p.targetIsMonster
          ? side.monsters.includes(p.target)
          : (opp && opp.playerCreeps.includes(p.target));
    if (!targetAlive) {
      scene.remove(p.mesh); side.projectiles.splice(i, 1); continue;
    }
    // Hämta target-position (orb sitter still vid ARENA_CFG.orb)
    const tp = isArenaOrbT
      ? { x: ARENA_CFG.orb.x, y: 1.3, z: ARENA_CFG.orb.z }
      : isArenaHeroT
        ? { x: sides[p.target.sideIdx].hero.x, y: 0.9, z: sides[p.target.sideIdx].hero.z }
        : p.target.mesh.position;
    const dx = tp.x - p.mesh.position.x;
    const dy = ((tp.y || 0) + 0.9) - p.mesh.position.y;
    const dz = tp.z - p.mesh.position.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.4) {
      const ix = tp.x, iz = tp.z;
      // AA-träff → ult-energy gain + rage-lifesteal om aktiv
      gainUltEnergy(side, ULT_GAIN_AA_HIT);
      applyRageLifesteal(side, p.damage);
      // Arena-orb / arena-hero hit → applicera special damage och hoppa över monster-logiken
      if (isArenaOrbT) {
        damageArenaOrb(p.damage, side.idx);
        spawnFloatingText(ARENA_CFG.orb.x, 1.5, ARENA_CFG.orb.z, String(Math.round(p.damage)), p.isCrit ? 'crit' : 'dmg');
        if ((p.lifestealRatio || 0) > 0 && !side.hero.dead) {
          const healAmt = p.damage * p.lifestealRatio;
          side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + healAmt);
          spawnHeroHealText(side, healAmt);
        }
        scene.remove(p.mesh); side.projectiles.splice(i, 1); continue;
      }
      if (isArenaHeroT) {
        const targetSide = sides[p.target.sideIdx];
        if (targetSide) {
          // damageHero spawnar redan popup baserat på faktisk skada efter shields/DR
          damageHero(targetSide, p.damage, p.isCrit);
        }
        if ((p.lifestealRatio || 0) > 0 && !side.hero.dead) {
          const healAmt = p.damage * p.lifestealRatio;
          side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + healAmt);
          spawnHeroHealText(side, healAmt);
        }
        scene.remove(p.mesh); side.projectiles.splice(i, 1); continue;
      }
      // Boss Wars phase-transition: bossen invulnerable medan han flyger upp/landar
      if (p.target.isBossWarsBoss && (p.target.phaseTransitionRemaining || 0) > 0) {
        spawnCcText(p.target.mesh, 'IMMUNE');
        scene.remove(p.mesh); side.projectiles.splice(i, 1);
        continue;
      }
      // Applicera poison-stack INNAN damage
      if (p.appliesPoison) {
        p.target.poisonStacks = (p.target.poisonStacks || 0) + 1;
        p.target.poisonRemaining = POISON_DURATION;
      }
      const _dmgApplied = Math.min(p.damage, p.target.hp);
      p.target.hp -= p.damage;
      spawnDamageText(p.target.mesh, _dmgApplied, p.isCrit);
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
      // Boss Wars AA-lifesteal (talent Bloodthirst / item Berserker Gauntlet)
      if ((side.aaLifestealPct || 0) > 0 && !side.hero.dead) {
        side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + _dmgApplied * side.aaLifestealPct);
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
      // Shadow Volley empowered AA hit: stun target + nearby (1.5s) + thorn pool 3s.
      if (p.legolusUltAa) {
        const stun = 1.5, stunR = 2.5;
        if (p.target && !isArenaHeroT && !isArenaOrbT) {
          p.target.frozenTime = Math.max(p.target.frozenTime || 0, stun);
        }
        for (const m of side.monsters) {
          if (m === p.target) continue;
          if (Math.hypot(m.mesh.position.x - ix, m.mesh.position.z - iz) < stunR) {
            m.frozenTime = Math.max(m.frozenTime || 0, stun);
          }
        }
        if (opp) for (const c of opp.playerCreeps) {
          if (c === p.target) continue;
          if (Math.hypot(c.mesh.position.x - ix, c.mesh.position.z - iz) < stunR) {
            c.frozenTime = Math.max(c.frozenTime || 0, stun);
          }
        }
        if (opp && !opp.hero.dead && Math.hypot(opp.hero.x - ix, opp.hero.z - iz) < stunR) {
          opp.hero.frozenTime = Math.max(opp.hero.frozenTime || 0, stun);
        }
        spawnClientLocalThornPool(side, ix, iz);
      }
      scene.remove(p.mesh); side.projectiles.splice(i, 1); continue;
    }
    const step = PROJECTILE_SPEED * dt;
    const nx = dx / dist, ny = dy / dist, nz = dz / dist;
    p.mesh.position.x += nx * step;
    p.mesh.position.y += ny * step;
    p.mesh.position.z += nz * step;
    // Orient mesh toward motion (för pilar/hammare). Sphere-projektiler spinner.
    if (p.mesh.userData.orientToMotion) {
      p.mesh.rotation.y = Math.atan2(nx, nz);
      p.mesh.rotation.x = -Math.asin(Math.max(-1, Math.min(1, ny)));
    } else if (p.mesh.userData.spin) {
      p.mesh.rotation.z = (p.mesh.rotation.z || 0) + dt * 14;
      p.mesh.rotation.x = (p.mesh.rotation.x || 0) + dt * 9;
    }
    // Trail-partikel var ~50ms: liten färgad puff som fadar ut
    p.trailAccum = (p.trailAccum || 0) + dt;
    if (p.trailAccum >= 0.045 && p.mesh.userData.trailColor !== undefined) {
      p.trailAccum = 0;
      spawnProjectileTrailPuff(p.mesh.position.x, p.mesh.position.y, p.mesh.position.z, p.mesh.userData.trailColor);
    }
    // Arena: blockas av cover-props på vägen
    if (APP.gameMode === 'arena1v1' && isArenaCoverAt(p.mesh.position.x, p.mesh.position.z)) {
      spawnHitSparkFx(p.mesh.position.x, p.mesh.position.y, p.mesh.position.z, 0xaaaaaa);
      scene.remove(p.mesh); side.projectiles.splice(i, 1); continue;
    }
  }
}

// Liten färgad puff som spawnar bakom flygande projektiler. Förlitar sig på combatFx-cleanup.
function spawnProjectileTrailPuff(x, y, z, color) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.10, 6, 5),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 })
  );
  m.position.set(x, y, z);
  scene.add(m);
  combatFx.push({ mesh: m, life: 0.28, maxLife: 0.28, kind: 'trail' });
}

// ============================================================
// SKILLS (host/solo)
// ============================================================

// Solo skill-helpers
function soloResolveSkillGroundTarget(side, ev, maxDistance) {
  if (ev && ev.tap === true && side.targetId) {
    const opp = sides[3 - side.idx];
    const t = resolveTargetEntity(side, opp);
    if (t && t.mesh) return { x: t.mesh.position.x, z: t.mesh.position.z };
  }
  let dx = (ev && ev.dx) || 0, dz = (ev && ev.dz) || 0;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) { dx = side.hero.facingX; dz = side.hero.facingZ; }
  else { dx /= len; dz /= len; }
  // Drag-fraktion (0..1) skalar avståndet — användaren bestämmer exakt vart inom max-range
  // mag=undefined (keyboard/tap) → 1 (full distans). mag=0 → cast under hero.
  const mag = (ev && typeof ev.mag === 'number') ? Math.min(1, Math.max(0, ev.mag)) : 1;
  return { x: side.hero.x + dx * maxDistance * mag, z: side.hero.z + dz * maxDistance * mag };
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
  // Boss Wars phase-transition: bossen är invulnerable medan han flyger upp/landar
  if (m.isBossWarsBoss && (m.phaseTransitionRemaining || 0) > 0) {
    spawnCcText(m.mesh, 'IMMUNE');
    return;
  }
  if ((m.frozenTime || 0) > 0) {
    soloShatter(side, opp, m.mesh.position.x, m.mesh.position.z);
    m.frozenTime = 0;
  }
  const actual = Math.min(dmg, m.hp);
  m.hp -= dmg;
  spawnDamageText(m.mesh, actual, false);
  applySkillLifesteal(side, actual);
  applyRageLifesteal(side, actual);
  gainUltOnSkillHit(side);
  if (m.hp <= 0) hostKillMonster(side, mIdx, side);
}
function soloApplySkillDmgToCreep(side, opp, c, dmg) {
  if ((c.frozenTime || 0) > 0) {
    soloShatter(side, opp, c.mesh.position.x, c.mesh.position.z);
    c.frozenTime = 0;
  }
  const actual = Math.min(dmg, c.hp);
  c.hp -= dmg;
  spawnDamageText(c.mesh, actual, false);
  applySkillLifesteal(side, actual);
  applyRageLifesteal(side, actual);
  gainUltOnSkillHit(side);
}

// Onyx Orb skill-lifesteal: hela X% av skill-skada utdelad
function applySkillLifesteal(side, dmgDealt) {
  const ls = side.skillLifestealPct || 0;
  if (ls <= 0 || dmgDealt <= 0 || side.hero.dead) return;
  side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + dmgDealt * ls);
}

// Soul Drain (Q): target-baserad channel. Tap → låst target (eller närmaste i range).
// 5 ticks (1/sek). Per tick: 5% av target maxHP i skada + self-heal Gandulf med samma
// mängd, slow-stack +10% (max 50%). Slow ligger kvar 1s efter sista tick. Bryts om
// target dör/försvinner/springer >12m. Talent m_drain_extend förlänger med +2s.
function hostCastSoulDrain(side, ev) {
  if (side.hero.dead || side.skills.q.cd > 0) return;
  if (side.soulDrain) removeSoulDrainBeam(side);
  side.soulDrain = null;
  const opp = sides[3 - side.idx];
  // Hitta target: tap-aim → låst target, annars närmaste i range
  let target = null;
  let targetType = null;
  if (ev && ev.tap === true && side.targetId) {
    target = resolveTargetEntity(side, opp);
    if (target) targetType = side.targetType;
  }
  if (!target) {
    const t = findClosestHostile(side, side.hero.x, side.hero.z, SOULDRAIN_RANGE);
    if (t) {
      target = t.entity;
      targetType = t.targetType || (t.isMonster ? 'monster' : 'creep');
    }
  }
  if (!target || !target.mesh) return;
  const tx = target.mesh.position.x, tz = target.mesh.position.z;
  if (Math.hypot(tx - side.hero.x, tz - side.hero.z) > SOULDRAIN_RANGE) return;
  // Talent: Lasting Drain — +2s duration
  const duration = SOULDRAIN_DURATION + (arenaHasTalent(side, 'm_drain_extend') ? 2 : 0);
  side.skills.q.cd = side.skills.q.max * gandulfCdrMul(side);
  side.soulDrain = {
    remaining: duration,
    tickAccum: 0,
    stacks: 0,
    targetId: target.id,
    targetType,
  };
  ensureSoulDrainBeam(side);
  spawnSkillCastFx(side.hero.x, side.hero.z, 0x99ff88, 1.6);
  spawnShieldBurstFx(side.hero.x, side.hero.z, 0xaa44ff);
  triggerCameraShake(0.12, 0.18);
  // Initial tick direkt — drain ska börja skada vid cast
  const initialTarget = resolveSoulDrainTarget(side, side.soulDrain, opp);
  if (initialTarget) {
    updateSoulDrainBeam(side, initialTarget.mesh);
    applySoulDrainTick(side, initialTarget, side.soulDrain);
  }
}

function resolveSoulDrainTarget(side, sd, opp) {
  if (!sd) return null;
  if (sd.targetType === 'monster') {
    for (const m of side.monsters) if (m.id === sd.targetId) return m.hp > 0 ? m : null;
    return null;
  }
  if (sd.targetType === 'creep' && opp) {
    for (const c of opp.playerCreeps) if (c.id === sd.targetId) return c.hp > 0 ? c : null;
    return null;
  }
  if (sd.targetType === 'arena-orb') {
    return (arenaState.orb && arenaState.orb.alive && arenaState.orbTarget) ? arenaState.orbTarget : null;
  }
  if (sd.targetType === 'arena-hero') {
    const oppSide = sides[3 - side.idx];
    if (!oppSide || oppSide.hero.dead) return null;
    return (arenaState.heroTargets && arenaState.heroTargets[oppSide.idx]) || null;
  }
  return null;
}

function tickSoulDrain(side, dt) {
  const sd = side.soulDrain;
  if (!sd) return;
  const opp = sides[3 - side.idx];
  const target = resolveSoulDrainTarget(side, sd, opp);
  // Break-villkor: target borta, död, eller out-of-range
  let shouldBreak = false;
  if (side.hero.dead) shouldBreak = true;
  else if (!target || !target.mesh) shouldBreak = true;
  // Hård CC bryter channel
  else if ((side.hero.frozenTime || 0) > 0) shouldBreak = true;
  else if ((side.heroFearTime || 0) > 0) shouldBreak = true;
  else if ((side.hero.tauntedTime || 0) > 0) shouldBreak = true;
  else if ((side.iceBlockRemaining || 0) > 0) shouldBreak = true;
  else {
    const d = Math.hypot(target.mesh.position.x - side.hero.x, target.mesh.position.z - side.hero.z);
    if (d > SOULDRAIN_BREAK_RANGE) shouldBreak = true;
  }
  if (shouldBreak) {
    removeSoulDrainBeam(side);
    side.soulDrain = null;
    return;
  }
  updateSoulDrainBeam(side, target.mesh, dt);
  sd.remaining -= dt;
  sd.tickAccum += dt;
  while (sd.tickAccum >= SOULDRAIN_TICK && sd.remaining > -SOULDRAIN_TICK) {
    sd.tickAccum -= SOULDRAIN_TICK;
    const tt = resolveSoulDrainTarget(side, sd, opp);
    if (!tt || !tt.mesh) break;
    applySoulDrainTick(side, tt, sd);
  }
  if (sd.remaining <= 0) {
    removeSoulDrainBeam(side);
    side.soulDrain = null;
  }
}

function applySoulDrainTick(side, target, sd) {
  const opp = sides[3 - side.idx];
  // Hitta target-maxHp per typ (proxies för orb/hero har inte egna .maxHp)
  let maxHp = target.maxHp || target.hp || 1;
  if (sd.targetType === 'arena-orb') maxHp = arenaState.orb.maxHp || maxHp;
  else if (sd.targetType === 'arena-hero') {
    const oppSide = sides[3 - side.idx];
    if (oppSide) maxHp = oppSide.hero.maxHp || maxHp;
  }
  const baseDmg = maxHp * SOULDRAIN_DMG_PCT * (side.skillDmgMul || 1) *
                  (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1) *
                  gandulfSkillDmgMul(side) *
                  bossWarsPctScale(target);
  sd.stacks = Math.min(SOULDRAIN_MAX_STACKS, (sd.stacks || 0) + 1);
  const slowMul = 1 - SOULDRAIN_SLOW_PER_STACK * sd.stacks;
  const tt = sd.targetType;
  let healed = 0;
  if (tt === 'monster') {
    const idx = side.monsters.indexOf(target);
    if (idx >= 0) {
      healed = Math.min(baseDmg, target.hp);
      const deathX = target.mesh.position.x;
      const deathZ = target.mesh.position.z;
      onGandulfSkillHit(side, target);
      soloApplySkillDmgToMonster(side, opp, idx, baseDmg);
      if (side.monsters[idx] === target && target.hp > 0) {
        target.slowMul = Math.min(target.slowMul || 1, slowMul);
        target.slowTime = Math.max(target.slowTime || 0, SOULDRAIN_SLOW_TAIL);
      } else if (!side.monsters.includes(target)) {
        // Monster dog av drain → explosion
        spawnSoulDrainExplosion(side, opp, deathX, deathZ, healed * SOULDRAIN_EXPLOSION_DMG_PCT);
      }
    }
  } else if (tt === 'creep' && opp) {
    healed = Math.min(baseDmg, target.hp);
    const deathX = target.mesh.position.x;
    const deathZ = target.mesh.position.z;
    onGandulfSkillHit(side, target);
    soloApplySkillDmgToCreep(side, opp, target, baseDmg);
    if (target.hp > 0) {
      target.slowMul = Math.min(target.slowMul || 1, slowMul);
      target.slowTime = Math.max(target.slowTime || 0, SOULDRAIN_SLOW_TAIL);
    } else {
      const i = opp.playerCreeps.indexOf(target);
      if (i >= 0) {
        scene.remove(target.mesh);
        opp.playerCreeps.splice(i, 1);
        side.gold += minionBounty(target);
        gainXp(side, minionXp(target));
      }
      // Creep dog av drain → explosion
      spawnSoulDrainExplosion(side, opp, deathX, deathZ, healed * SOULDRAIN_EXPLOSION_DMG_PCT);
    }
  } else if (tt === 'arena-orb') {
    healed = Math.min(baseDmg, arenaState.orb.hp);
    damageArenaOrb(baseDmg, side.idx);
    gainUltOnSkillHit(side);
  } else if (tt === 'arena-hero') {
    const oppIdx = 3 - side.idx;
    const oppSide = sides[oppIdx];
    if (oppSide && !oppSide.hero.dead && APP.gameMode === 'arena1v1' && arenaState.phase === 'fight') {
      healed = Math.min(baseDmg, oppSide.hero.hp);
      damageHero(oppSide, baseDmg);
      const ccMul = Math.max(0, 1 - (oppSide.ccReductionPct || 0));
      const heroSlowMul = 1 - SOULDRAIN_SLOW_PER_STACK * sd.stacks * ccMul;
      oppSide.heroSlowMul = Math.min(oppSide.heroSlowMul || 1, heroSlowMul);
      oppSide.heroSlowTime = Math.max(oppSide.heroSlowTime || 0, SOULDRAIN_SLOW_TAIL);
      gainUltOnSkillHit(side);
    }
  }
  // Heal Gandulf
  if (healed > 0 && !side.hero.dead) {
    const newHp = Math.min(side.hero.maxHp, side.hero.hp + healed);
    const delta = newHp - side.hero.hp;
    side.hero.hp = newHp;
    if (delta > 0) spawnHeroHealText(side, delta);
  }
  if (target.mesh) {
    spawnHitSparkFx(target.mesh.position.x, 1.2, target.mesh.position.z, 0x99ff88);
    spawnHitSparkFx(side.hero.x, 1.2, side.hero.z, 0xaa44ff);
  }
}

// Soul-explosion vid minion-död: AoE-skada + tydlig grön shockwave + soul-burst.
function spawnSoulDrainExplosion(side, opp, x, z, damage) {
  if (damage <= 0) return;
  // Visuell shockwave-ring som expanderar och fadar
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.2, 0.5, 36),
    new THREE.MeshBasicMaterial({ color: 0x88ff66, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.12, z);
  scene.add(ring);
  // Inre kraftig flash-sfär
  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(SOULDRAIN_EXPLOSION_RADIUS * 0.35, 18, 12),
    new THREE.MeshBasicMaterial({ color: 0xddffcc, transparent: true, opacity: 0.85, depthWrite: false })
  );
  flash.position.set(x, 1.0, z);
  scene.add(flash);
  // Stort outer halo
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(SOULDRAIN_EXPLOSION_RADIUS * 0.55, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0x44ff66, transparent: true, opacity: 0.55, depthWrite: false })
  );
  halo.position.set(x, 1.0, z);
  scene.add(halo);
  // Point-light som blinkar starkt
  const lit = new THREE.PointLight(0x66ff66, 4.0, SOULDRAIN_EXPLOSION_RADIUS * 2);
  lit.position.set(x, 1.5, z);
  scene.add(lit);
  side.soulExplosions = side.soulExplosions || [];
  side.soulExplosions.push({
    ring, flash, halo, light: lit,
    x, z,
    life: 0.55, maxLife: 0.55,
  });
  // Burst-partiklar runt explosion-center
  for (let i = 0; i < 16; i++) {
    const ang = Math.random() * Math.PI * 2;
    const r = Math.random() * SOULDRAIN_EXPLOSION_RADIUS * 0.7;
    const px = x + Math.cos(ang) * r;
    const py = 0.3 + Math.random() * 1.4;
    const pz = z + Math.sin(ang) * r;
    spawnHitSparkFx(px, py, pz, Math.random() < 0.5 ? 0x88ff44 : 0xddffcc);
  }
  triggerCameraShake(0.18, 0.20);
  // AoE-skada — träffar monsters, creeps, opp-hero (i arena) men INTE arena-orb
  for (let j = side.monsters.length - 1; j >= 0; j--) {
    const m = side.monsters[j];
    if (Math.hypot(m.mesh.position.x - x, m.mesh.position.z - z) < SOULDRAIN_EXPLOSION_RADIUS) {
      onGandulfSkillHit(side, m);
      soloApplySkillDmgToMonster(side, opp, j, damage);
    }
  }
  if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
    const c = opp.playerCreeps[j];
    if (Math.hypot(c.mesh.position.x - x, c.mesh.position.z - z) < SOULDRAIN_EXPLOSION_RADIUS) {
      onGandulfSkillHit(side, c);
      soloApplySkillDmgToCreep(side, opp, c, damage);
      if (c.hp <= 0) {
        scene.remove(c.mesh);
        opp.playerCreeps.splice(j, 1);
        side.gold += minionBounty(c);
        gainXp(side, minionXp(c));
      }
    }
  }
  // Arena: opp hero kan ta explosion-skada
  if (APP.gameMode === 'arena1v1' && opp && !opp.hero.dead && arenaState.phase === 'fight') {
    if (Math.hypot(opp.hero.x - x, opp.hero.z - z) < SOULDRAIN_EXPLOSION_RADIUS) {
      damageHero(opp, damage);
    }
  }
}

function tickSoulExplosions(side, dt) {
  if (!side.soulExplosions || side.soulExplosions.length === 0) return;
  for (let i = side.soulExplosions.length - 1; i >= 0; i--) {
    const e = side.soulExplosions[i];
    e.life -= dt;
    const t = 1 - Math.max(0, e.life / e.maxLife);   // 0 → 1 över livet
    const fade = Math.max(0, e.life / e.maxLife);     // 1 → 0
    // Ring expanderar utåt + fadar
    if (e.ring) {
      const r = SOULDRAIN_EXPLOSION_RADIUS * (0.2 + 0.95 * t);
      e.ring.scale.set(r, r, 1);
      e.ring.material.opacity = 0.95 * fade;
    }
    if (e.flash) {
      const s = 1 + 1.3 * t;
      e.flash.scale.set(s, s, s);
      e.flash.material.opacity = 0.85 * fade * fade;
    }
    if (e.halo) {
      const s = 1 + 1.0 * t;
      e.halo.scale.set(s, s, s);
      e.halo.material.opacity = 0.55 * fade;
    }
    if (e.light) e.light.intensity = 4.0 * fade;
    if (e.life <= 0) {
      const dispose = (o) => {
        if (!o) return;
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
        scene.remove(o);
      };
      dispose(e.ring); dispose(e.flash); dispose(e.halo);
      if (e.light) scene.remove(e.light);
      side.soulExplosions.splice(i, 1);
    }
  }
}

// Beam-visual mellan Gandulf och target (3-lager grön + ljus). Tillsammans med en
// roterande mark-aura under Gandulf (visar "drain aktiv"). Particles spawnar längs
// beamen som virvlar mot Gandulf — "själen sugs tillbaka".
function ensureSoulDrainBeam(side) {
  if (side.soulDrainBeam) return;
  const grp = new THREE.Group();
  // Inre vit-grön kärna — glödande hjärtat
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xeeffcc, transparent: true, opacity: 1.0 });
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 1, 12, 1, false), coreMat);
  core.rotation.x = Math.PI / 2;
  grp.add(core);
  // Mellanlager — kraftig grön
  const beamMat = new THREE.MeshBasicMaterial({ color: 0x44ff44, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.30, 1, 14, 1, false), beamMat);
  beam.rotation.x = Math.PI / 2;
  grp.add(beam);
  // Yttre halo — mjuk grön glow
  const haloMat = new THREE.MeshBasicMaterial({ color: 0x88ff66, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
  const halo = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.65, 1, 14, 1, false), haloMat);
  halo.rotation.x = Math.PI / 2;
  grp.add(halo);
  scene.add(grp);
  // Mark-aura under Gandulf — roterande grön ring (visar "drain aktiv")
  const auraRing = new THREE.Mesh(
    new THREE.RingGeometry(0.7, 1.1, 32),
    new THREE.MeshBasicMaterial({ color: 0x44ff66, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false })
  );
  auraRing.rotation.x = -Math.PI / 2;
  auraRing.position.set(side.hero.x, 0.06, side.hero.z);
  scene.add(auraRing);
  const auraDisk = new THREE.Mesh(
    new THREE.CircleGeometry(0.7, 24),
    new THREE.MeshBasicMaterial({ color: 0x44ff88, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false })
  );
  auraDisk.rotation.x = -Math.PI / 2;
  auraDisk.position.set(side.hero.x, 0.05, side.hero.z);
  scene.add(auraDisk);
  // Liten point-light som följer Gandulf
  const auraLight = new THREE.PointLight(0x66ff66, 1.6, 4);
  auraLight.position.set(side.hero.x, 1.0, side.hero.z);
  scene.add(auraLight);
  side.soulDrainBeam = {
    group: grp, core, beam, halo,
    auraRing, auraDisk, auraLight,
    particleAccum: 0,
  };
}

function updateSoulDrainBeam(side, targetMesh, dt = 1/60) {
  const sdb = side.soulDrainBeam;
  if (!sdb || !targetMesh) return;
  const hx = side.hero.x, hz = side.hero.z, hy = 1.2;
  const tx = targetMesh.position.x, tz = targetMesh.position.z, ty = 1.2;
  const dx = tx - hx, dz = tz - hz;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) return;
  sdb.group.position.set((hx + tx) / 2, (hy + ty) / 2, (hz + tz) / 2);
  sdb.group.rotation.y = Math.atan2(dx, dz);
  sdb.core.scale.y = len;
  sdb.beam.scale.y = len;
  sdb.halo.scale.y = len;
  // Stark pulsering så det är tydligt att den är igång
  const t = performance.now() * 0.008;
  sdb.beam.material.opacity = 0.70 + 0.25 * Math.sin(t);
  sdb.halo.material.opacity = 0.35 + 0.20 * Math.sin(t + Math.PI / 2);
  sdb.core.material.opacity = 0.85 + 0.15 * Math.sin(t * 1.7);
  // Mark-aura under Gandulf — följer med + roterar + pulsar
  if (sdb.auraRing) {
    sdb.auraRing.position.x = hx;
    sdb.auraRing.position.z = hz;
    sdb.auraRing.rotation.z = (sdb.auraRing.rotation.z || 0) + 0.05;
    const auraPulse = 1 + 0.10 * Math.sin(t * 1.3);
    sdb.auraRing.scale.set(auraPulse, auraPulse, 1);
    sdb.auraRing.material.opacity = 0.55 + 0.25 * Math.sin(t);
  }
  if (sdb.auraDisk) {
    sdb.auraDisk.position.x = hx;
    sdb.auraDisk.position.z = hz;
    sdb.auraDisk.material.opacity = 0.12 + 0.10 * Math.sin(t * 0.8);
  }
  if (sdb.auraLight) {
    sdb.auraLight.position.set(hx, 1.0, hz);
    sdb.auraLight.intensity = 1.4 + 0.6 * Math.sin(t * 1.5);
  }
  // Soul-particles längs beamen — flödar från target mot Gandulf.
  // Cappa accum så tab-switch / frame drops inte spawnar massa partiklar på en frame.
  sdb.particleAccum = Math.min((sdb.particleAccum || 0) + dt, SOULDRAIN_PARTICLE_INTERVAL * 3);
  while (sdb.particleAccum >= SOULDRAIN_PARTICLE_INTERVAL) {
    sdb.particleAccum -= SOULDRAIN_PARTICLE_INTERVAL;
    const u = Math.random();  // 0..1 längs beamen
    const px = tx + (hx - tx) * u + (Math.random() - 0.5) * 0.35;
    const py = ty + (hy - ty) * u + (Math.random() - 0.5) * 0.3;
    const pz = tz + (hz - tz) * u + (Math.random() - 0.5) * 0.35;
    spawnProjectileTrailPuff(px, py, pz, Math.random() < 0.5 ? 0x66ff66 : 0xddffcc);
  }
}

function removeSoulDrainBeam(side) {
  const sdb = side.soulDrainBeam;
  if (!sdb) return;
  const cleanup = (obj) => {
    if (!obj) return;
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
    scene.remove(obj);
  };
  if (sdb.group) {
    sdb.group.traverse(o => {
      if (o.isMesh) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      }
    });
    scene.remove(sdb.group);
  }
  cleanup(sdb.auraRing);
  cleanup(sdb.auraDisk);
  if (sdb.auraLight) scene.remove(sdb.auraLight);
  side.soulDrainBeam = null;
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
  side.skills.f.cd = side.skills.f.max * gandulfCdrMul(side);
  const opp = sides[3 - side.idx];
  const center = soloResolveSkillGroundTarget(side, ev || {}, NOVA_CAST_DISTANCE);
  // Cast-FX vid hero + target — ger tydlig visuell signal var Frostnovan landar
  spawnSkillCastFx(side.hero.x, side.hero.z, 0x88ddff, 1.0);
  spawnSkillCastFx(center.x, center.z, 0xaaeeff, 1.2);
  spawnShieldBurstFx(center.x, center.z, 0x66ccff);
  triggerCameraShake(0.18, 0.22);
  // Huvud-ring + inner glow + light
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.3, NOVA_RADIUS, 36),
    new THREE.MeshBasicMaterial({ color: 0x88ddff, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(center.x, 0.08, center.z);
  scene.add(ring);
  side.novaEffects.push({ mesh: ring, life: 0.7, maxLife: 0.7 });
  // Inner frost-disk (semi-transparent), fade:as separat
  const disk = new THREE.Mesh(
    new THREE.CircleGeometry(NOVA_RADIUS * 0.85, 32),
    new THREE.MeshBasicMaterial({ color: 0xddeeff, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
  );
  disk.rotation.x = -Math.PI / 2;
  disk.position.set(center.x, 0.05, center.z);
  scene.add(disk);
  side.novaEffects.push({ mesh: disk, life: 0.7, maxLife: 0.7 });
  // 6 is-shards som sticker upp + glittrar
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const r = NOVA_RADIUS * (0.55 + Math.random() * 0.3);
    const sx = center.x + Math.cos(a) * r, sz = center.z + Math.sin(a) * r;
    const shard = new THREE.Mesh(
      new THREE.ConeGeometry(0.18, 0.55, 6),
      new THREE.MeshStandardMaterial({ color: 0xccebff, emissive: 0x4488cc, emissiveIntensity: 1.0, transparent: true, opacity: 0.9 })
    );
    shard.position.set(sx, 0.0, sz);
    scene.add(shard);
    side.novaEffects.push({ mesh: shard, life: 0.7, maxLife: 0.7 });
  }
  // Kall point-light som pulserar ut
  const frostLight = new THREE.PointLight(0x88ccff, 2.4, NOVA_RADIUS * 2.5);
  frostLight.position.set(center.x, 1.2, center.z);
  scene.add(frostLight);
  side.novaEffects.push({ mesh: frostLight, life: 0.7, maxLife: 0.7, isLight: true });
  const novaDmg = NOVA_DAMAGE * (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1) * gandulfSkillDmgMul(side);
  // Talent: Frost Vampirism — heal 15% av total damage done
  let novaDmgDealt = 0;
  const frostHeal = arenaHasTalent(side, 'm_frost_heal');
  for (let j = side.monsters.length - 1; j >= 0; j--) {
    const m = side.monsters[j];
    if (Math.hypot(m.mesh.position.x - center.x, m.mesh.position.z - center.z) < NOVA_RADIUS) {
      const wasFrozen = (m.frozenTime || 0) > 0;
      onGandulfSkillHit(side, m);
      soloApplySkillDmgToMonster(side, opp, j, novaDmg);
      if (frostHeal) novaDmgDealt += novaDmg;
      const stillExists = side.monsters[j] === m;
      if (stillExists && m.hp > 0 && !wasFrozen) m.frozenTime = NOVA_FREEZE_TIME;
    }
  }
  if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
    const c = opp.playerCreeps[j];
    if (Math.hypot(c.mesh.position.x - center.x, c.mesh.position.z - center.z) < NOVA_RADIUS) {
      const wasFrozen = (c.frozenTime || 0) > 0;
      onGandulfSkillHit(side, c);
      soloApplySkillDmgToCreep(side, opp, c, novaDmg);
      if (frostHeal) novaDmgDealt += novaDmg;
      if (c.hp > 0 && !wasFrozen) c.frozenTime = NOVA_FREEZE_TIME;
      else if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(j, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
    }
  }
  // Arena: orb-damage om i radius
  if (APP.gameMode === 'arena1v1' && arenaState.orb.alive) {
    const dToOrb = Math.hypot(ARENA_CFG.orb.x - center.x, ARENA_CFG.orb.z - center.z);
    if (dToOrb < NOVA_RADIUS) {
      damageArenaOrb(novaDmg, side.idx);
      if (frostHeal) novaDmgDealt += novaDmg;
    }
  }
  // Arena: damage + freeze opp hero om i radius (bara under fight-fas)
  if (APP.gameMode === 'arena1v1' && opp && !opp.hero.dead && arenaState.phase === 'fight') {
    const dToHero = Math.hypot(opp.hero.x - center.x, opp.hero.z - center.z);
    if (dToHero < NOVA_RADIUS) {
      damageHero(opp, novaDmg);
      if (frostHeal) novaDmgDealt += novaDmg;
      // Frostnova fryser opp.hero i NOVA_FREEZE_TIME (CC-reduktion via ccReductionPct)
      const ccMul = Math.max(0, 1 - (opp.ccReductionPct || 0));
      opp.hero.frozenTime = Math.max(opp.hero.frozenTime || 0, NOVA_FREEZE_TIME * ccMul);
    }
  }
  // Apply Frost Vampirism heal
  if (frostHeal && novaDmgDealt > 0 && !side.hero.dead) {
    side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + novaDmgDealt * 0.15);
    spawnHealFx(side.hero.x, side.hero.z);
  }
}

function updateNovaEffects(side, dt) {
  for (let i = side.novaEffects.length - 1; i >= 0; i--) {
    const n = side.novaEffects[i];
    n.life -= dt;
    const tNorm = Math.max(0, n.life / n.maxLife);
    // Cache start-värdet vid första tick så vi inte multiplicerar in oss till 0
    if (n.isLight && n.mesh.intensity !== undefined) {
      if (n.baseIntensity === undefined) n.baseIntensity = n.mesh.intensity;
      n.mesh.intensity = n.baseIntensity * tNorm;
    } else if (n.mesh.material && n.mesh.material.transparent) {
      if (n.baseOpacity === undefined || n.baseOpacity === 0) {
        n.baseOpacity = n.mesh.material.opacity || 1;
      }
      n.mesh.material.opacity = n.baseOpacity * tNorm;
    }
    if (n.life <= 0) { scene.remove(n.mesh); side.novaEffects.splice(i, 1); }
  }
  // Fire Wave-cone fade ut (gruppen innehåller 2 cone-meshar + 1 light)
  if (side.fireWaves) for (let i = side.fireWaves.length - 1; i >= 0; i--) {
    const fw = side.fireWaves[i];
    fw.life -= dt;
    const tNorm = Math.max(0, fw.life / fw.maxLife);
    if (fw.mesh && fw.mesh.children) {
      // Flicker via sinus + linear fade
      const flicker = 0.85 + 0.15 * Math.sin(performance.now() * 0.025);
      fw.mesh.children.forEach(c => {
        if (c.material && c.material.transparent) {
          c.material.opacity = (c === fw.mesh.children[0] ? 0.55 : 0.7) * tNorm * flicker;
        }
      });
    }
    if (fw.light) fw.light.intensity = 2.2 * tNorm * (0.8 + 0.2 * Math.sin(performance.now() * 0.04));
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
  side.skills.e.cd = side.skills.e.max * gandulfCdrMul(side);
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
  // Talent: Singularity — radie +30% (pull + explosion)
  const sizeMul = arenaHasTalent(side, 'm_bh_radius') ? 1.30 : 1.0;
  side.blackHoles.push({
    sphere, ring,
    x: center.x, z: center.z,
    life: BLACKHOLE_DURATION, maxLife: BLACKHOLE_DURATION,
    explosionDmg: BLACKHOLE_EXPLOSION_DMG * (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1),
    radius: BLACKHOLE_RADIUS * sizeMul,
    explosionRadius: BLACKHOLE_EXPLOSION_RADIUS * sizeMul,
    dotTickAccum: 0,  // ticka 3% maxHP per sek på allt i radien
  });
}

function updateBlackHolesSolo(side, dt) {
  if (!side.blackHoles || side.blackHoles.length === 0) return;
  const opp = sides[3 - side.idx];
  for (let i = side.blackHoles.length - 1; i >= 0; i--) {
    const bh = side.blackHoles[i];
    bh.life -= dt;
    const pull = BLACKHOLE_PULL_SPEED * dt;
    const bhRadius = bh.radius || BLACKHOLE_RADIUS;
    // Sug in monsters + creeps
    for (const m of side.monsters) {
      const dx = bh.x - m.mesh.position.x, dz = bh.z - m.mesh.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.15 && d < bhRadius) {
        const f = 1 - d / bhRadius;
        m.mesh.position.x += (dx / d) * pull * (0.4 + f * 0.6);
        m.mesh.position.z += (dz / d) * pull * (0.4 + f * 0.6);
      }
    }
    if (opp) for (const c of opp.playerCreeps) {
      const dx = bh.x - c.mesh.position.x, dz = bh.z - c.mesh.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.15 && d < bhRadius) {
        const f = 1 - d / bhRadius;
        c.mesh.position.x += (dx / d) * pull * (0.4 + f * 0.6);
        c.mesh.position.z += (dz / d) * pull * (0.4 + f * 0.6);
      }
    }
    // Arena: pull opp.hero mot center (CC-reduktion via ccReductionPct)
    if (APP.gameMode === 'arena1v1' && opp && !opp.hero.dead && arenaState.phase === 'fight') {
      const dx = bh.x - opp.hero.x, dz = bh.z - opp.hero.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.15 && d < bhRadius) {
        const f = 1 - d / bhRadius;
        const ccMul = Math.max(0, 1 - (opp.ccReductionPct || 0));
        const pullEff = pull * (0.4 + f * 0.6) * ccMul;
        const nx = opp.hero.x + (dx / d) * pullEff;
        const nz = opp.hero.z + (dz / d) * pullEff;
        if (isHeroWalkable(opp.idx, nx, nz)) { opp.hero.x = nx; opp.hero.z = nz; }
        else if (isHeroWalkable(opp.idx, nx, opp.hero.z)) opp.hero.x = nx;
        else if (isHeroWalkable(opp.idx, opp.hero.x, nz)) opp.hero.z = nz;
        if (opp.mesh) { opp.mesh.position.x = opp.hero.x; opp.mesh.position.z = opp.hero.z; }
      }
    }
    // Snurra sfär
    bh.sphere.rotation.y += dt * 4;
    bh.ring.rotation.z += dt * 2;
    // Pulse sphere scale based on life
    const t = 1 - bh.life / bh.maxLife;
    bh.sphere.scale.setScalar(1 + 0.3 * Math.sin(t * 20));
    // DoT: 3% av maxHP per sekund på allt i radien (tickas var 0.5s = 1.5% per tick)
    bh.dotTickAccum = (bh.dotTickAccum || 0) + dt;
    while (bh.dotTickAccum >= 0.5) {
      bh.dotTickAccum -= 0.5;
      const tickDmgMul = gandulfSkillDmgMul(side);
      for (let j = side.monsters.length - 1; j >= 0; j--) {
        const m = side.monsters[j];
        if (Math.hypot(m.mesh.position.x - bh.x, m.mesh.position.z - bh.z) < bhRadius) {
          const dmg = (m.maxHp || m.hp) * 0.015 * tickDmgMul;
          soloApplySkillDmgToMonster(side, opp, j, dmg);
        }
      }
      if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
        const c = opp.playerCreeps[j];
        if (Math.hypot(c.mesh.position.x - bh.x, c.mesh.position.z - bh.z) < bhRadius) {
          const dmg = (c.maxHp || c.hp) * 0.015 * tickDmgMul;
          soloApplySkillDmgToCreep(side, opp, c, dmg);
          if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(j, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
        }
      }
      // Arena: orb + opp hero DoT
      if (APP.gameMode === 'arena1v1') {
        if (arenaState.orb && arenaState.orb.alive) {
          if (Math.hypot(ARENA_CFG.orb.x - bh.x, ARENA_CFG.orb.z - bh.z) < bhRadius) {
            damageArenaOrb(arenaState.orb.maxHp * 0.015 * tickDmgMul, side.idx);
          }
        }
        if (opp && !opp.hero.dead && arenaState.phase === 'fight') {
          if (Math.hypot(opp.hero.x - bh.x, opp.hero.z - bh.z) < bhRadius) {
            damageHero(opp, opp.hero.maxHp * 0.015 * tickDmgMul);
          }
        }
      }
    }
    if (bh.life <= 0) {
      // Explosion
      const dmgMul = gandulfSkillDmgMul(side);
      const expR = bh.explosionRadius || BLACKHOLE_EXPLOSION_RADIUS;
      for (let j = side.monsters.length - 1; j >= 0; j--) {
        const m = side.monsters[j];
        if (Math.hypot(m.mesh.position.x - bh.x, m.mesh.position.z - bh.z) < expR) {
          soloApplySkillDmgToMonster(side, opp, j, bh.explosionDmg * dmgMul);
          onGandulfSkillHit(side, m);
        }
      }
      if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
        const c = opp.playerCreeps[j];
        if (Math.hypot(c.mesh.position.x - bh.x, c.mesh.position.z - bh.z) < expR) {
          soloApplySkillDmgToCreep(side, opp, c, bh.explosionDmg * dmgMul);
          onGandulfSkillHit(side, c);
          if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(j, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
        }
      }
      // Arena: orb + opp hero-damage från black hole-explosion + shake
      applyAoEDamageInArena(bh.x, bh.z, expR, bh.explosionDmg * dmgMul, side.idx);
      if (APP.gameMode === 'arena1v1' && opp && !opp.hero.dead) {
        if (Math.hypot(opp.hero.x - bh.x, opp.hero.z - bh.z) < expR) {
          damageHero(opp, bh.explosionDmg * dmgMul);
        }
      }
      if (APP.gameMode === 'arena1v1') triggerCameraShake(0.30, 0.35);
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
  // Cast-FX: grön burst vid hero + ground-impact vid target
  spawnSkillCastFx(side.hero.x, side.hero.z, 0x66cc44, 0.9);
  spawnShieldBurstFx(center.x, center.z, 0x88dd55);
  // Visuell brun rot-ring + spinkar + svag grön glow
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(VINE_TRAP_RADIUS * 0.85, VINE_TRAP_RADIUS, 36),
    new THREE.MeshBasicMaterial({ color: 0x4a8030, transparent: true, opacity: 0.65, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(center.x, 0.07, center.z);
  scene.add(ring);
  // Grön mark-glöd som ligger kvar
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(VINE_TRAP_RADIUS, 32),
    new THREE.MeshBasicMaterial({ color: 0x55cc44, transparent: true, opacity: 0.20, side: THREE.DoubleSide })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(center.x, 0.05, center.z);
  scene.add(glow);
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
  // Talent: Toxic Roots — DoT-skada dubbel
  const dotMul = arenaHasTalent(side, 'l_vine_dot') ? 2 : 1;
  side.vineTraps.push({
    ring, spikes, glow,
    x: center.x, z: center.z,
    life: VINE_TRAP_DURATION, maxLife: VINE_TRAP_DURATION,
    dotPerSec: VINE_TRAP_DOT_DPS * (side.skillDmgMul || 1) * dotMul,
    radius: VINE_TRAP_RADIUS,
  });
}

function hostCastLegolusBuff(side) {
  if (side.hero.dead || side.skills.f.cd > 0) return;
  side.skills.f.cd = side.skills.f.max;
  // Talent: Patient Hunter — buff-tid +2s
  const extra = arenaHasTalent(side, 'l_focus_dur') ? 2 : 0;
  side.legolusBuffRemaining = LEGOLUS_BUFF_DURATION + extra;
  // Visuell aim-buff (gulgrön expanderande ring)
  spawnSkillCastFx(side.hero.x, side.hero.z, 0xddff55, 1.1);
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
  // Visuella spår — start och slut
  spawnSkillCastFx(side.hero.x, side.hero.z, 0x66ff88, 0.7);
  side.hero.x = nx; side.hero.z = nz;
  side.mesh.position.x = nx; side.mesh.position.z = nz;
  spawnSkillCastFx(nx, nz, 0x66ff88, 0.7);
  side.legolusDashBuffPending = true;
}

function updateVineTrapsSolo(side, dt) {
  // Reset self-buff flagga FÖRST — sätts åter om hero står i sin egen trap (loopen nedan)
  side.legolusInOwnTrap = false;
  if (!side.vineTraps || side.vineTraps.length === 0) return;
  const opp = sides[3 - side.idx];
  for (let i = side.vineTraps.length - 1; i >= 0; i--) {
    const vt = side.vineTraps[i];
    vt.life -= dt;
    const r2 = vt.radius * vt.radius;
    // localOnly = client-prediktion i arena MP: bara visuell, ingen damage/root/heal
    // (host kör auktoritativ simulering och appliceras via heroSnap).
    if (vt.localOnly) {
      const fadeMul = Math.max(0, vt.life / vt.maxLife);
      if (vt.ring && vt.ring.material) vt.ring.material.opacity = 0.65 * fadeMul;
      if (vt.glow && vt.glow.material) vt.glow.material.opacity = 0.20 * fadeMul;
      if (vt.life <= 0) {
        if (vt.ring) scene.remove(vt.ring);
        if (vt.glow) scene.remove(vt.glow);
        if (vt.spikes) for (const sp of vt.spikes) scene.remove(sp);
        side.vineTraps.splice(i, 1);
      }
      continue;
    }
    // Self-buff: om Legolas själv står i sin egen vine trap → -20% dmg taken + 5% HP/s heal
    if (!side.hero.dead) {
      const ddx = side.hero.x - vt.x, ddz = side.hero.z - vt.z;
      if (ddx * ddx + ddz * ddz < r2) {
        side.legolusInOwnTrap = true;
        const healAmt = side.hero.maxHp * 0.05 * dt;   // 5% maxHP/s
        if (healAmt > 0 && side.hero.hp < side.hero.maxHp) {
          side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + healAmt);
        }
      }
    }
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
    // Arena: root + DoT mot opp.hero om i radien (PvP)
    if (APP.gameMode === 'arena1v1' && opp && !opp.hero.dead && arenaState.phase === 'fight') {
      const dx = opp.hero.x - vt.x, dz = opp.hero.z - vt.z;
      if (dx * dx + dz * dz < r2) {
        const ccMul = Math.max(0, 1 - (opp.ccReductionPct || 0));
        opp.hero.frozenTime = Math.max(opp.hero.frozenTime || 0, VINE_TRAP_ROOT_REFRESH * ccMul);
        damageHero(opp, vt.dotPerSec * dt);
      }
    }
    // Arena: vine-trap DoT mot orb
    applyAoEDamageInArena(vt.x, vt.z, vt.radius, vt.dotPerSec * dt, side.idx);
    // Fade ring + spikar + glow
    const fadeMul = Math.max(0, vt.life / vt.maxLife);
    if (vt.ring && vt.ring.material) vt.ring.material.opacity = 0.65 * fadeMul;
    if (vt.glow && vt.glow.material) vt.glow.material.opacity = 0.20 * fadeMul;
    if (vt.life <= 0) {
      if (vt.ring) scene.remove(vt.ring);
      if (vt.glow) scene.remove(vt.glow);
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
  // Taunt enemy hero — arena 1v1 (PvP) eller classic duel
  const inDuel = !!duelState.active;
  const inArenaFight = APP.gameMode === 'arena1v1' && arenaState.phase === 'fight';
  if (opp && !opp.hero.dead && (inDuel || inArenaFight)) {
    const dx = opp.hero.x - side.hero.x, dz = opp.hero.z - side.hero.z;
    if (dx * dx + dz * dz < r2) {
      const ccMul = Math.max(0, 1 - (opp.ccReductionPct || 0));
      opp.hero.tauntedTime = TAUNT_DURATION * ccMul;
      opp.hero.tauntedBy = side.idx;
      // Lås opp:s AA-target på taunter:s hero (force-attack Gimlu).
      // Skapa heroTarget lazy om det inte finns (annars triggas force-AA först
      // när motspelaren gjort sin första AA — kan vara flera frames bort).
      if (!arenaState.heroTargets) arenaState.heroTargets = {};
      if (!arenaState.heroTargets[side.idx]) {
        arenaState.heroTargets[side.idx] = {
          id: -200 + side.idx, isArenaHero: true, sideIdx: side.idx,
          get mesh() { return sides[this.sideIdx]?.mesh; },
        };
      }
      opp.aaActive = true;
      opp.targetId = arenaState.heroTargets[side.idx].id;
      opp.targetType = 'arena-hero';
    }
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
  // Cast-FX för dramatik
  spawnSkillCastFx(side.hero.x, side.hero.z, 0xffaa55, 1.5);
  triggerCameraShake(0.25, 0.3);
}

function hostCastGimluIronWill(side) {
  if (side.hero.dead || side.skills.f.cd > 0) return;
  side.skills.f.cd = side.skills.f.max;
  side.ironWillRemaining = IRON_WILL_DURATION;
  side.ironWillStored = 0;
  // Visuell uppladdning — orange ring runt hero som indikerar buf
  spawnSkillCastFx(side.hero.x, side.hero.z, 0xff7733, 1.3);
}

function updateIronWillSolo(side, dt) {
  if (!side.ironWillRemaining || side.ironWillRemaining <= 0) return;
  side.ironWillRemaining -= dt;
  if (side.ironWillRemaining <= 0) {
    const dmg = side.ironWillStored || 0;
    side.ironWillStored = 0;
    side.ironWillRemaining = 0;
    if (dmg > 0) {
      // Talent: Wrath Unleashed — radie +30%
      const radius = IRON_WILL_EXPLOSION_RADIUS * (arenaHasTalent(side, 'g_iron_radius') ? 1.30 : 1.0);
      const r2 = radius * radius;
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
      // Arena: Iron Will-explosion mot orb + opp hero + camera-shake för lokala
      applyAoEDamageInArena(side.hero.x, side.hero.z, radius, dmg, side.idx);
      if (APP.gameMode === 'arena1v1' && opp && !opp.hero.dead) {
        const dx = opp.hero.x - side.hero.x, dz = opp.hero.z - side.hero.z;
        if (dx * dx + dz * dz < r2) damageHero(opp, dmg);
      }
      if (APP.gameMode === 'arena1v1') triggerCameraShake(0.35, 0.4);
      // Stor explosion-ring
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.5, radius, 56),
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
  // Teleport om hammer redan ute — fungerar i arena även om hammer landade
  // i cover-prop genom att leta walkable position längs linjen tillbaka mot hero.
  if (side.hammers && side.hammers.length > 0) {
    const h = side.hammers[0];
    let tx = h.mesh.position.x, tz = h.mesh.position.z;
    if (!isHeroWalkable(side.idx, tx, tz)) {
      const sx = side.hero.x, sz = side.hero.z;
      const dx = sx - tx, dz = sz - tz;
      const d = Math.hypot(dx, dz);
      if (d > 0.01) {
        const ddx = dx / d, ddz = dz / d;
        let found = false;
        for (let step = 0.4; step <= d; step += 0.4) {
          const px = tx + ddx * step, pz = tz + ddz * step;
          if (isHeroWalkable(side.idx, px, pz)) {
            tx = px; tz = pz; found = true; break;
          }
        }
        if (!found) { tx = sx; tz = sz; }
      }
    }
    side.hero.x = tx;
    side.hero.z = tz;
    side.mesh.position.x = tx;
    side.mesh.position.z = tz;
    // Liten teleport-FX där hammer låg
    spawnSkillCastFx(h.mesh.position.x, h.mesh.position.z, 0xffaa44, 1.2);
    spawnSkillCastFx(tx, tz, 0xffaa44, 1.2);
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
    // Talent: Mighty Throw — återresan får full skada (var 50%)
    const returnMul = arenaHasTalent(side, 'g_hammer_full') ? 1.0 : HAMMER_RETURN_DMG_MUL;
    const dmgMul = h.returning ? returnMul : 1;
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
    // Arena: hammer-hit på orb (use mesh-position som "center")
    const orbKey = 'orb_' + (h.returning ? 'r' : 'o');
    if (!h.hit.has(orbKey)) {
      const beforeHp = arenaState.orb.hp;
      applyAoEDamageInArena(h.mesh.position.x, h.mesh.position.z, HAMMER_RADIUS, dmg, side.idx);
      if (arenaState.orb.hp < beforeHp) {
        h.hit.add(orbKey);
        const lifesteal = (beforeHp - Math.max(0, arenaState.orb.hp)) * HAMMER_LIFESTEAL;
        if (!side.hero.dead && lifesteal > 0) {
          side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + lifesteal);
        }
      }
    }
    // Arena: hammer-hit på opp.hero (en gång per fas — ute/återresa)
    const heroKey = 'hero_' + (h.returning ? 'r' : 'o');
    if (APP.gameMode === 'arena1v1' && opp && !opp.hero.dead && !h.hit.has(heroKey) && arenaState.phase === 'fight') {
      if (Math.hypot(opp.hero.x - h.mesh.position.x, opp.hero.z - h.mesh.position.z) < HAMMER_RADIUS) {
        h.hit.add(heroKey);
        damageHero(opp, dmg);
        if (!side.hero.dead) {
          side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + dmg * HAMMER_LIFESTEAL);
        }
      }
    }
  }
}

function updateSkillCooldowns(side, dt) {
  // Titans Armor instance-stacks: +1% CDR per stack
  const taCdrBoost = 1 + 0.01 * (side.titansInstanceStacks || 0);
  const eff = dt * (side.heroFountainAura ? FOUNTAIN_CDR_MUL : 1) * taCdrBoost;
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

// Per-level-scaling-formel: bas-stat 10% * 1.2^(level-1). Lvl1=10%, lvl10=51.6%.
// "Slow"-varianter halverar compound-tillväxten (1.1 i st för 1.2) — används för de
// stat:s som balanserades ner (crit, CDR, maxHP, attack speed, HP regen).
const bootsPct = (level) => 0.10 * Math.pow(1.2, level - 1);
const bootsPctSlow = (level) => 0.10 * Math.pow(1.1, level - 1);
const gloveBigPct = (level) => 0.10 * Math.pow(1.2, level - 1);
const gloveBigPctSlow = (level) => 0.10 * Math.pow(1.1, level - 1);
const gloveHealPct = (level) => 0.01 * Math.pow(1.2, level - 1);
const gloveHealPctSlow = (level) => 0.01 * Math.pow(1.1, level - 1);

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
        statsAtLevel: (level) => ({
          moveSpeedPct: bootsPct(level),
          attackSpeedPct: bootsPctSlow(level),
        }),
        activeAtMax: {
          duration: 5, cooldown: 30,
          description: '+50% rörelse och attackfart i 5s',
          stats: { moveSpeedPct: 0.5, attackSpeedPct: 0.5 },
        },
      },
      magic: {
        id: 'magic', parentId: 'item1', name: 'Boots of Magic', icon: '✨',
        description: 'Förstärker skills och kortar cooldowns',
        statsAtLevel: (level) => ({
          skillDmgPct: bootsPct(level),
          cdrPct: bootsPctSlow(level),
        }),
        activeAtMax: {
          duration: 5, cooldown: 30,
          description: '+50% skill-skada och CDR i 5s',
          stats: { skillDmgPct: 0.5, cdrPct: 0.5 },
        },
      },
      tank: {
        id: 'tank', parentId: 'item1', name: 'Boots of Tank', icon: '🛡',
        description: 'Mer HP och mindre inkommande skada',
        statsAtLevel: (level) => ({
          dmgReductionPct: bootsPct(level),
          maxHpPct: bootsPctSlow(level),
        }),
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
        statsAtLevel: (level) => ({
          attackSpeedPct: gloveBigPct(level),
          critChancePct: gloveBigPctSlow(level),
        }),
        activeAtMax: {
          duration: 5, cooldown: 30,
          description: '+50% attackfart och crit chans i 5s',
          stats: { attackSpeedPct: 0.5, critChancePct: 0.5 },
        },
      },
      spell: {
        id: 'spell', parentId: 'item2', name: 'Glove of Spell', icon: '🔮',
        description: 'Mer skill-skada och CDR',
        statsAtLevel: (level) => ({
          skillDmgPct: gloveBigPct(level),
          cdrPct: gloveBigPctSlow(level),
        }),
        activeAtMax: {
          duration: 5, cooldown: 30,
          description: '+50% skill-skada och CDR i 5s',
          stats: { skillDmgPct: 0.5, cdrPct: 0.5 },
        },
      },
      tank: {
        id: 'tank', parentId: 'item2', name: 'Glove of Tank', icon: '🛡',
        description: 'Skadereduktion + passiv HP-regen',
        statsAtLevel: (level) => ({
          dmgReductionPct: gloveBigPct(level),
          healPerSecPct: gloveHealPctSlow(level),
        }),
        activeAtMax: {
          duration: 5, cooldown: 30,
          description: '+50% skadereduktion och 5%/s heal i 5s',
          stats: { dmgReductionPct: 0.5, healPerSecPct: 0.05 },
        },
      },
    },
  },
  item3: {
    id: 'item3', name: 'Ling & Lang', icon: '🌪',
    description: 'Snabbhet, fury-stacks, CC-immunitet — krockreduktion. Vid Lv 10: explosiv sköld var 20:e sek.',
    statsAtLevel: (level) => {
      const v = 0.10 * Math.pow(1.1, level - 1);  // 10% → 23.6% vid lvl 10 (1.1× compound)
      return {
        moveSpeedPct: v,
        attackSpeedPct: v,
        attackDmgPct: v,
        ccReductionPct: 0.20,    // konstant, skalas inte
      };
    },
    activeAtMax: {
      kind: 'lingShield', duration: 0, cooldown: 20,
      description: 'Sköld 20% maxHP. Vid kollaps: AoE-explosion. Medan aktiv: +20% AA-räckvidd och +10% AA-skada.',
    },
  },
  item4: {
    id: 'item4', name: 'Onyx Orb', icon: '🔮',
    description: 'CDR, skill-skada, skill-lifesteal. Movement +10% per skill på CD. Vid Lv 10: aktiv is-block.',
    statsAtLevel: (level) => {
      const v = 0.10 * Math.pow(1.1, level - 1);
      return {
        cdrPct: v,
        skillDmgPct: v,
        skillLifestealPct: v,
        aaDmgReductionPct: 0.20,    // konstant
        skillDmgReductionPct: 0.20, // konstant
      };
    },
    activeAtMax: {
      kind: 'iceBlock', duration: 1.5, cooldown: 45,
      description: 'Fryser hjälten i 1.5s, healar 15% maxHP/0.5s (total 45%). Avbryt med en till tap. Vid utgång: 50% slow runt i 2s, +50% MS i 1s.',
    },
  },
  item5: {
    id: 'item5', name: 'Titans Armor', icon: '🛡',
    description: 'Skadereduktion, regen från förlorad HP, block-chans. Block var 3:e AA + 30% return. Stacking DR/CDR per damage taken. Vid Lv 10: aktiv fear-våg.',
    statsAtLevel: (level) => {
      const v = 0.10 * Math.pow(1.1, level - 1);
      return {
        dmgReductionPct: v,
        hpRegenLostPct: v,   // 10% av FÖRLORAD HP per sek
        blockChancePct: v,
      };
    },
    activeAtMax: {
      kind: 'fearWave', duration: 1.5, cooldown: 45,
      description: 'Skräm-våg AoE i 1.5s. Fiender spring slumpmässigt och kan inte agera. När fear slutar tar de 20% av nuvarande HP som skada.',
    },
  },
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
// Per-hero overrides på enstaka skill-CDs (bryter med global SKILL_BASE_CD)
const HERO_SKILL_CD = {
  legolas: { e: 6.0 },  // Shadow Dash -4s (var 8s, nu 6s)
};
function heroSkillBaseCd(heroId, key) {
  const ov = HERO_SKILL_CD[heroId];
  if (ov && ov[key] !== undefined) return ov[key];
  return SKILL_BASE_CD[key];
}

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
  // Nya stat-keys för Ling & Lang / Onyx Orb / Titans Armor
  let attackDmgPct = 0;          // multiplikativ AA-skada
  let ccReductionPct = 0;        // -X% varaktighet på stuns/roots/freeze/taunt etc
  let skillLifestealPct = 0;     // hela X% av skill-skada utdelad
  let aaDmgReductionPct = 0;     // -X% inkommande AA-skada
  let skillDmgReductionPct = 0;  // -X% inkommande skill-skada
  let hpRegenLostPct = 0;        // X% av FÖRLORAD HP per sek (Titans Armor)
  let blockChancePct = 0;        // X% chans att helt blocka skadeinstans (Titans Armor)
  let aaRangePct = 0;            // +X% AA-räckvidd (Ling & Lang shield aktiv)

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
    attackDmgPct += stats.attackDmgPct || 0;
    ccReductionPct += stats.ccReductionPct || 0;
    skillLifestealPct += stats.skillLifestealPct || 0;
    aaDmgReductionPct += stats.aaDmgReductionPct || 0;
    skillDmgReductionPct += stats.skillDmgReductionPct || 0;
    hpRegenLostPct += stats.hpRegenLostPct || 0;
    blockChancePct += stats.blockChancePct || 0;
    aaRangePct += stats.aaRangePct || 0;
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
  // Boss Wars talents + items — applicera stats från valda objekt
  if (side.bossWarsTalents) for (const tid of side.bossWarsTalents) {
    const t = BOSS_WARS_TALENTS.find(x => x.id === tid);
    if (t && t.stats) addStats(t.stats);
  }
  if (side.bossWarsItems) for (const iid of side.bossWarsItems) {
    const it = BOSS_WARS_ITEMS.find(x => x.id === iid);
    if (it && it.stats) addStats(it.stats);
  }
  // Ling & Lang lvl 10 shield-uppe: +AA range + AA dmg
  if ((side.lingShieldHp || 0) > 0) {
    attackDmgPct += LING_AA_DMG_BONUS;
    aaRangePct += LING_AA_RANGE_BONUS;
  }

  // Level-skalning ovanpå items (matchar server-engine)
  const lvl = (side.level || 1) - 1;
  const levelDmgMul = 1 + LEVEL_DMG_PCT * lvl;
  const levelHpMul = 1 + LEVEL_HP_PCT * lvl;
  const levelMsMul = 1 + LEVEL_MS_PCT * lvl;
  side.attackDmg = attackDmg * levelDmgMul * (1 + attackDmgPct);
  side.moveSpeed = moveSpeedFlat * (1 + moveSpeedPct) * levelMsMul;
  side.attackSpeedMul = 1 + attackSpeedPct;
  side.skillDmgMul = (1 + skillDmgPct) * levelDmgMul;
  side.cdrMul = Math.max(0.1, 1 - cdrPct);
  // Generisk DR + AA-DR + Skill-DR (alla appliceras additivt → cap 90%)
  const totalDR = Math.min(0.9, dmgReductionPct + aaDmgReductionPct + skillDmgReductionPct);
  side.dmgReductionMul = Math.max(0.10, 1 - totalDR);
  side.critChancePct = Math.min(1, critChancePct);
  side.healPerSecPct = Math.max(0, healPerSecPct);
  // Boss Wars-extras som inte är vanliga stats: AA-lifesteal + crit-dmg-bonus
  let aaLifestealSum = 0, critDmgBonusSum = 0, hasPhoenix = false;
  const _pushBwExtras = (def) => {
    if (!def) return;
    if (def.lifestealOnAa) aaLifestealSum += def.lifestealOnAa;
    if (def.critDmgBonus) critDmgBonusSum += def.critDmgBonus;
    if (def.phoenixRevive) hasPhoenix = true;
  };
  if (side.bossWarsTalents) for (const tid of side.bossWarsTalents) _pushBwExtras(BOSS_WARS_TALENTS.find(x => x.id === tid));
  if (side.bossWarsItems) for (const iid of side.bossWarsItems) _pushBwExtras(BOSS_WARS_ITEMS.find(x => x.id === iid));
  side.aaLifestealPct = aaLifestealSum;
  side.critDmgMul = 2.0 + critDmgBonusSum;
  side.phoenixReviveAvailable = hasPhoenix && (side.phoenixReviveAvailable !== false);   // sätts false när använt
  // Nya stats för items
  side.ccReductionPct = Math.min(0.9, ccReductionPct);
  side.skillLifestealPct = Math.max(0, skillLifestealPct);
  side.hpRegenLostPct = Math.max(0, hpRegenLostPct);
  side.blockChancePct = Math.min(1, blockChancePct);
  // AA-range: bas från heroDef + bonus från items/active (lingShield kollas i aaRangeMul ovan)
  side.aaRangeBonus = aaRangePct;
  side.attackRange = def.attackRange * (1 + aaRangePct);

  // Max HP — räkna ny topp, behåll relativ HP vid förändring
  const newMaxHp = Math.round(maxHpFlat * (1 + maxHpPct) * levelHpMul);
  if (newMaxHp !== side.hero.maxHp) {
    const delta = newMaxHp - side.hero.maxHp;
    side.hero.maxHp = newMaxHp;
    if (delta > 0) side.hero.hp = Math.min(newMaxHp, side.hero.hp + delta);
    else if (side.hero.hp > newMaxHp) side.hero.hp = newMaxHp;
  }

  // Skill-cooldown-cap räknas via CDR (max-värdet sätts om så castcd sätter rätt)
  side.skills.q.max = heroSkillBaseCd(side.heroId, 'q') * side.cdrMul;
  side.skills.f.max = heroSkillBaseCd(side.heroId, 'f') * side.cdrMul;
  side.skills.e.max = heroSkillBaseCd(side.heroId, 'e') * side.cdrMul;
}

// ============================================================
// ITEM-ACTIVES: Tier 10 (Ling & Lang shield, Onyx ice-block, Titans fear)
// ============================================================

const LING_SHIELD_REFRESH = 20;       // sek mellan refresh
const LING_SHIELD_PCT = 0.20;          // 20% maxHP
const LING_AOE_RADIUS = 4.5;
const LING_AOE_DMG_PCT = 0.15;         // 15% av hero maxHp till AoE-fiender
const LING_AA_RANGE_BONUS = 0.20;      // medan shield > 0
const LING_AA_DMG_BONUS = 0.10;        // medan shield > 0

// Auto-passiv: refreshar var 20:e sek till 20% maxHP (toppas upp om partial).
function tickLingShield(side, dt) {
  const hasLvl10 = side.inventory && side.inventory.some(it => it.itemId === 'item3' && it.level >= ITEM_MAX_LEVEL);
  if (!hasLvl10) {
    if ((side.lingShieldHp || 0) > 0) {
      side.lingShieldHp = 0;
      recomputeSideStats(side);
    }
    return;
  }
  if ((side.lingShieldRefreshTimer ?? -1) <= 0) {
    // Första frame eller efter trigger — sätt nästa timer
    side.lingShieldRefreshTimer = LING_SHIELD_REFRESH;
  }
  side.lingShieldRefreshTimer -= dt;
  if (side.lingShieldRefreshTimer <= 0) {
    side.lingShieldRefreshTimer = LING_SHIELD_REFRESH;
    const target = side.hero.maxHp * LING_SHIELD_PCT;
    const wasUp = (side.lingShieldHp || 0) > 0;
    side.lingShieldHp = Math.max(side.lingShieldHp || 0, target);
    spawnShieldBurstFx(side.hero.x, side.hero.z, 0xddffaa);
    if (!wasUp) recomputeSideStats(side);  // applicera +20% range + 10% AA dmg
  }
}

function lingShieldExplode(side) {
  // Förhindra rekursion (om explosionen skadar opp's Ling shield som triggar igen)
  if (side._inLingExplode) return;
  side._inLingExplode = true;
  const dmg = side.hero.maxHp * LING_AOE_DMG_PCT;
  // Skada egna monsters/opp's creeps i radie
  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    if (Math.hypot(m.mesh.position.x - side.hero.x, m.mesh.position.z - side.hero.z) < LING_AOE_RADIUS) {
      m.hp -= dmg;
      if (m.hp <= 0) hostKillMonster(side, i, side);
    }
  }
  const opp = sides[3 - side.idx];
  if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
    const c = opp.playerCreeps[i];
    if (Math.hypot(c.mesh.position.x - side.hero.x, c.mesh.position.z - side.hero.z) < LING_AOE_RADIUS) {
      c.hp -= dmg;
      if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(i, 1); }
    }
  }
  // Arena: orb + opp hero
  applyAoEDamageInArena(side.hero.x, side.hero.z, LING_AOE_RADIUS, dmg, side.idx);
  if (APP.gameMode === 'arena1v1' && opp && !opp.hero.dead) {
    if (Math.hypot(opp.hero.x - side.hero.x, opp.hero.z - side.hero.z) < LING_AOE_RADIUS) {
      damageHero(opp, dmg);
    }
  }
  spawnShieldBurstFx(side.hero.x, side.hero.z, 0xffaa55);
  spawnSkillCastFx(side.hero.x, side.hero.z, 0xffcc44, 2.0);
  triggerCameraShake(0.30, 0.3);
  side._inLingExplode = false;
}

// Skada till hjälten — applicerar dmgReductionMul från items + fontän-aura.
function gandulfSkillDmgMul(side) {
  if (side.heroId !== 'magiker' || !(side.gandulfBuffRemaining > 0)) return 1;
  return 1 + (side.gandulfBuffStacks || 0) * GANDULF_BUFF_SKILL_DMG_PER_STACK;
}
function gandulfCdrMul(side) {
  // Kvar för bakåtkompabilitet — passive ger inte längre CDR
  return 1;
}
// Gandulf passive — Soul Mark: 3 OLIKA skills på samma target inom 3s → target
// får DoT (5% current HP/sek i 3s) som även healar Gandulf 10% max HP/sek.
// Ersätter tidigare shield-mekanik (5% per hit + 30% vid 3 hits).
const GANDULF_MARK_DURATION = 3.0;
const GANDULF_MARK_WINDOW = 3.0;
const GANDULF_MARK_DOT_PCT = 0.05;
const GANDULF_MARK_HEAL_PCT = 0.10;

function onGandulfSkillHit(side, target) {
  if (side.heroId !== 'magiker') return;
  side.gandulfBuffStacks = (side.gandulfBuffStacks || 0) + 1;
  side.gandulfBuffRemaining = GANDULF_BUFF_DURATION;
  // Mark-tracking: 3 OLIKA skills på samma target inom 3s → applicera DoT/heal
  if (target && typeof target === 'object' && target.id != null) {
    const skillKey = side._currentSkillKey;
    if (!skillKey) return;
    const now = performance.now() / 1000;
    if (!side._gandulfHits) side._gandulfHits = new Map();
    let hits = side._gandulfHits.get(target.id);
    if (!hits) { hits = []; side._gandulfHits.set(target.id, hits); }
    const cutoff = now - GANDULF_MARK_WINDOW;
    for (let i = hits.length - 1; i >= 0; i--) if (hits[i].t < cutoff) hits.splice(i, 1);
    if (hits.some(h => h.skill === skillKey)) return;
    hits.push({ skill: skillKey, t: now });
    if (hits.length >= 3) {
      target.gandulfMarkRemaining = GANDULF_MARK_DURATION;
      target.gandulfMarkCasterSideIdx = side.idx;
      side._gandulfHits.delete(target.id);
    }
  }
}

// Tick Soul Mark DoT på target. DoT skadar 5% current HP/sek + healar caster 10% maxHP/sek.
// Anropas från solo monster/creep update-loopar.
function tickGandulfMarkClient(target, dt) {
  if (!target || !target.gandulfMarkRemaining || target.gandulfMarkRemaining <= 0) return;
  if ((target.hp || 0) <= 0) { target.gandulfMarkRemaining = 0; return; }
  target.gandulfMarkRemaining -= dt;
  const dotDmg = target.hp * GANDULF_MARK_DOT_PCT * dt;
  target.hp -= dotDmg;
  const caster = sides[target.gandulfMarkCasterSideIdx];
  if (caster && !caster.hero.dead) {
    const heal = caster.hero.maxHp * GANDULF_MARK_HEAL_PCT * dt;
    caster.hero.hp = Math.min(caster.hero.maxHp, caster.hero.hp + heal);
  }
  if (target.gandulfMarkRemaining <= 0) {
    target.gandulfMarkRemaining = 0;
    target.gandulfMarkCasterSideIdx = 0;
  }
}

function damageHero(side, amount, isCrit = false) {
  if (side.hero.dead) return;
  let gimluDR = 0;
  if (side.heroId === 'gimlu') {
    const ratio = side.hero.maxHp > 0 ? side.hero.hp / side.hero.maxHp : 1;
    if (ratio < GIMLU_PASSIVE_TIER1_HP) gimluDR += GIMLU_PASSIVE_TIER1_DR;
    if (ratio < GIMLU_PASSIVE_TIER3_HP) {
      gimluDR += GIMLU_PASSIVE_TIER3_DR;
      side.gimluDmgInstanceCount = (side.gimluDmgInstanceCount || 0) + 1;
      if (side.gimluDmgInstanceCount % GIMLU_PASSIVE_IMMUNE_EVERY === 0) {
        spawnCcText(side.mesh, 'IMMUNE');
        return;
      }
    }
  }
  // Titans Armor: var-3:e-AA pending block ELLER procentuell block-chans
  // (efter Gimlu-counter så hans immune-stack inte tappas vid block).
  let blocked = false;
  if (side.titansBlockPending) {
    side.titansBlockPending = false;
    blocked = true;
  } else if ((side.blockChancePct || 0) > 0 && Math.random() < side.blockChancePct) {
    blocked = true;
  }
  if (blocked) {
    spawnHitSparkFx(side.hero.x, 1.0, side.hero.z, 0xffaa66);
    spawnCcText(side.mesh, 'BLOCK');
    // Return 30% till skadegivaren — vi har inte attacker-ref här, så hoppa
    // över returnen för nu (notera: kräver attacker-passing för full impl)
    return;
  }
  // Titans Armor: instance-stack (1% DR + 1% CDR per dmg-instans tagen, max 10)
  const hasTitans = side.inventory && side.inventory.some(it => it.itemId === 'item5');
  if (hasTitans) {
    side.titansInstanceStacks = Math.min(10, (side.titansInstanceStacks || 0) + 1);
  }
  const gimluMul = gimluDR > 0 ? (1 - gimluDR) : 1;
  const auraMul = side.heroFountainAura ? FOUNTAIN_DMG_REDUCTION_MUL : 1;
  const tauntMul = (side.titansTauntRemaining || 0) > 0 ? (1 - TAUNT_DMG_REDUCTION) : 1;
  // Titans Armor instance-stacks → +1% DR per stack
  const taStackMul = 1 - 0.01 * (side.titansInstanceStacks || 0);
  // Magiker laser-ult: 90% DR
  const laserMul = side.laserBeam ? LASER_DR_MUL : 1;
  // Gimlu rage-ult: 50% DR
  const rageMul = (side.rageRemaining || 0) > 0 ? RAGE_DR_MUL : 1;
  // Aragurn Shout-buff på self/ally: 20% DR
  const shoutDrSelf = (side.aragurnShoutBuff || 0) > 0 ? (1 - SHOUT_BUFF_DR) : 1;
  const shoutDrAlly = (side.aragurnAllyShoutBuff || 0) > 0 ? (1 - SHOUT_BUFF_DR) : 1;
  // Legolas i sin egen Vine Trap: -20% damage taken
  const legolusTrapDr = side.legolusInOwnTrap ? 0.80 : 1;
  // Aragurn Whirlwind CC-immun (samma som rage — soak alla CC) — DR-wise samma som vanlig
  // Mottagar-debuff från Aragurn Shout: target tar +20% mer skada
  const shoutDebuffMul = (side.aragurnShoutDebuff || 0) > 0 ? (1 + SHOUT_DEBUFF_DMG_TAKEN) : 1;
  let final = amount * (side.dmgReductionMul ?? 1) * auraMul * tauntMul * gimluMul * taStackMul * laserMul * rageMul * shoutDrSelf * shoutDrAlly * legolusTrapDr * shoutDebuffMul;
  // Ling & Lang shield absorberar FÖRST (passiv tier-10). Vid kollaps: AoE-explosion.
  if ((side.lingShieldHp || 0) > 0 && final > 0) {
    if (side.lingShieldHp >= final) {
      side.lingShieldHp -= final;
      final = 0;
    } else {
      final -= side.lingShieldHp;
      side.lingShieldHp = 0;
    }
    if (side.lingShieldHp <= 0) {
      side.lingShieldHp = 0;
      lingShieldExplode(side);
      recomputeSideStats(side);
    }
  }
  // Gandulf shield absorberar därefter
  if ((side.shield || 0) > 0 && final > 0) {
    if (side.shield >= final) { side.shield -= final; final = 0; }
    else { final -= side.shield; side.shield = 0; }
  }
  const hpBefore = side.hero.hp;
  side.hero.hp = Math.max(0, side.hero.hp - final);
  const hpLost = hpBefore - side.hero.hp;
  // Visa skada som faktiskt landade på HP (efter shields/DR)
  if (hpLost > 0.5) spawnHeroDamageText(side, hpLost, isCrit);
  if ((side.titansTauntRemaining || 0) > 0 && side.hero.hp > 0) {
    const tauntHeal = final * TAUNT_HEAL_PCT;
    side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + tauntHeal);
    if (tauntHeal > 0.5) spawnHeroHealText(side, tauntHeal);
  }
  if ((side.ironWillRemaining || 0) > 0) {
    side.ironWillStored = (side.ironWillStored || 0) + final;
  }
  // Gimlu tank-mekanik: 5% av damage taken som ult-gain (cap 2% per hit).
  // Kompenserar långsam AA-frekvens + single-target skills.
  if (side.heroId === 'gimlu' && final > 0 && side.hero.hp > 0) {
    gainUltEnergy(side, Math.min(GIMLU_ULT_GAIN_PER_HIT_CAP, final * GIMLU_ULT_GAIN_ON_DMG_PCT));
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
  const kind = def.activeAtMax.kind || 'statBuff';
  // Specialfall: ice-block kan avbrytas mid-channel med en till tap.
  // Sätt CD vid cancel också så spam-tap inte kringgår 45s-cooldown.
  if (kind === 'iceBlock' && (entry.activeRemaining || 0) > 0) {
    entry.activeRemaining = 0;
    entry.activeCd = def.activeAtMax.cooldown ?? ACTIVE_COOLDOWN;
    onIceBlockEnd(side);
    return;
  }
  if ((entry.activeCd || 0) > 0) return;
  if ((entry.activeRemaining || 0) > 0) return;
  entry.activeCd = def.activeAtMax.cooldown ?? ACTIVE_COOLDOWN;
  if (kind === 'iceBlock') {
    entry.activeRemaining = def.activeAtMax.duration ?? 1.5;
    side.iceBlockRemaining = entry.activeRemaining;
    side.iceBlockHealAccum = 0;
    side.iceBlockOwnerEntry = entry;
    spawnSkillCastFx(side.hero.x, side.hero.z, 0x88ddff, 1.5);
  } else if (kind === 'fearWave') {
    entry.activeRemaining = 0;  // instant — ingen channel
    fearWaveActivate(side);
  } else if (kind === 'lingShield') {
    // Inte klickbar — passiv. Bara safeguard.
    entry.activeRemaining = 0;
    entry.activeCd = 0;
  } else {
    // Generisk stat-buff (boots/glove)
    entry.activeRemaining = def.activeAtMax.duration ?? ACTIVE_DURATION;
  }
  recomputeSideStats(side);
}

// === Onyx Orb ice-block ===
const ICE_BLOCK_HEAL_PCT = 0.15;       // 15% maxHP per 0.5s
const ICE_BLOCK_HEAL_INTERVAL = 0.5;
const ICE_BLOCK_SLOW_RADIUS = 5.5;
const ICE_BLOCK_SLOW_DURATION = 2.0;
const ICE_BLOCK_SLOW_MUL = 0.5;
const ICE_BLOCK_SELF_MS_BUFF = 1.0;    // 1s buff på 50% MS

function tickIceBlock(side, dt) {
  if ((side.iceBlockRemaining || 0) > 0) {
    side.iceBlockRemaining -= dt;
    side.iceBlockHealAccum = (side.iceBlockHealAccum || 0) + dt;
    while (side.iceBlockHealAccum >= ICE_BLOCK_HEAL_INTERVAL && side.iceBlockRemaining > 0) {
      side.iceBlockHealAccum -= ICE_BLOCK_HEAL_INTERVAL;
      side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + side.hero.maxHp * ICE_BLOCK_HEAL_PCT);
      spawnHealFx(side.hero.x, side.hero.z);
    }
    if (side.iceBlockRemaining <= 0) {
      side.iceBlockRemaining = 0;
      onIceBlockEnd(side);
    }
  }
  // Tick self-MS buff
  if ((side.iceBlockMsBuff || 0) > 0) {
    side.iceBlockMsBuff -= dt;
    if (side.iceBlockMsBuff < 0) side.iceBlockMsBuff = 0;
  }
  // Tick opp-hero-slow timer (om någon icel-block slogan oss)
  if ((side.heroSlowTime || 0) > 0) {
    side.heroSlowTime -= dt;
    if (side.heroSlowTime <= 0) {
      side.heroSlowTime = 0;
      side.heroSlowMul = 1;
    }
  }
}

function onIceBlockEnd(side) {
  side.iceBlockRemaining = 0;
  side.iceBlockHealAccum = 0;
  if (side.iceBlockOwnerEntry) {
    side.iceBlockOwnerEntry.activeRemaining = 0;
    side.iceBlockOwnerEntry = null;
  }
  // Self MS buff
  side.iceBlockMsBuff = ICE_BLOCK_SELF_MS_BUFF;
  // Slow alla nära fiender
  for (const m of side.monsters) {
    if (Math.hypot(m.mesh.position.x - side.hero.x, m.mesh.position.z - side.hero.z) < ICE_BLOCK_SLOW_RADIUS) {
      m.slowTime = Math.max(m.slowTime || 0, ICE_BLOCK_SLOW_DURATION);
      m.slowMul = Math.min(m.slowMul || 1, ICE_BLOCK_SLOW_MUL);
    }
  }
  const opp = sides[3 - side.idx];
  if (opp) {
    for (const c of opp.playerCreeps) {
      if (Math.hypot(c.mesh.position.x - side.hero.x, c.mesh.position.z - side.hero.z) < ICE_BLOCK_SLOW_RADIUS) {
        c.slowTime = Math.max(c.slowTime || 0, ICE_BLOCK_SLOW_DURATION);
        c.slowMul = Math.min(c.slowMul || 1, ICE_BLOCK_SLOW_MUL);
      }
    }
    // Opp hero (arena PvP)
    if (APP.gameMode === 'arena1v1' && !opp.hero.dead) {
      if (Math.hypot(opp.hero.x - side.hero.x, opp.hero.z - side.hero.z) < ICE_BLOCK_SLOW_RADIUS) {
        opp.heroSlowTime = ICE_BLOCK_SLOW_DURATION;
        opp.heroSlowMul = ICE_BLOCK_SLOW_MUL;
      }
    }
  }
  spawnSkillCastFx(side.hero.x, side.hero.z, 0x88ddff, 2.0);
  triggerCameraShake(0.20, 0.3);
}

// === Titans Armor fear-wave ===
const FEAR_RADIUS = 6.0;
const FEAR_DURATION = 1.5;
const FEAR_HP_DMG_PCT = 0.20;

function fearWaveActivate(side) {
  // Visuell expanderande ring
  spawnSkillCastFx(side.hero.x, side.hero.z, 0xaa44ff, 1.8);
  triggerCameraShake(0.30, 0.35);
  // Mark monsters i radie
  for (const m of side.monsters) {
    if (Math.hypot(m.mesh.position.x - side.hero.x, m.mesh.position.z - side.hero.z) < FEAR_RADIUS) {
      m.fearTime = FEAR_DURATION;
      m.fearOwnerIdx = side.idx;
    }
  }
  const opp = sides[3 - side.idx];
  if (opp) for (const c of opp.playerCreeps) {
    if (Math.hypot(c.mesh.position.x - side.hero.x, c.mesh.position.z - side.hero.z) < FEAR_RADIUS) {
      c.fearTime = FEAR_DURATION;
      c.fearOwnerIdx = side.idx;
    }
  }
  // Arena: opp hero
  if (APP.gameMode === 'arena1v1' && opp && !opp.hero.dead) {
    if (Math.hypot(opp.hero.x - side.hero.x, opp.hero.z - side.hero.z) < FEAR_RADIUS) {
      opp.heroFearTime = FEAR_DURATION;
      opp.heroFearOwnerIdx = side.idx;
    }
  }
}

// Tick fear på alla entiteter. På utgång: damage 20% av nuvarande HP.
function tickFearWave(side, dt) {
  // Side's own monsters
  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    if ((m.fearTime || 0) > 0) {
      const prev = m.fearTime;
      m.fearTime -= dt;
      if (m.fearTime <= 0 && prev > 0) {
        const dmg = m.hp * FEAR_HP_DMG_PCT;
        m.hp -= dmg;
        if (m.hp <= 0) hostKillMonster(side, i, sides[m.fearOwnerIdx] || side);
      }
    }
  }
  // Opp creeps (i denna arena)
  const opp = sides[3 - side.idx];
  if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
    const c = opp.playerCreeps[i];
    if ((c.fearTime || 0) > 0) {
      const prev = c.fearTime;
      c.fearTime -= dt;
      if (c.fearTime <= 0 && prev > 0) {
        const dmg = c.hp * FEAR_HP_DMG_PCT;
        c.hp -= dmg;
        if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(i, 1); }
      }
    }
  }
  // Egen hero (om motspelaren feared oss)
  if ((side.heroFearTime || 0) > 0) {
    const prev = side.heroFearTime;
    side.heroFearTime -= dt;
    if (side.heroFearTime <= 0 && prev > 0) {
      const dmg = side.hero.hp * FEAR_HP_DMG_PCT;
      damageHero(side, dmg);
    }
  }
}

function applyMovement(side, joyX, joyZ, dt) {
  if (side.hero.dead) return;
  // Ice-block channel: kan inte röra sig
  if ((side.iceBlockRemaining || 0) > 0) return;
  // Feared/stunnad av motspelaren: kan inte agera/röra sig
  if ((side.heroFearTime || 0) > 0) return;
  // Frusen/rotad av motspelaren (Frostnova / Vine Trap): kan inte röra sig
  if ((side.hero.frozenTime || 0) > 0) return;
  // Tauntad av Gimlu: tappar kontroll — auto-walk till Gimlu och kan inte ändra
  // riktning. Existing applyEvent-block stoppar skills, maintainTargetLock tvingar
  // AA på taunter. Här override:as joystick-input med auto-walk.
  if ((side.hero.tauntedTime || 0) > 0 && side.hero.tauntedBy) {
    const tSide = sides[side.hero.tauntedBy];
    if (tSide && !tSide.hero.dead) {
      const dx = tSide.hero.x - side.hero.x;
      const dz = tSide.hero.z - side.hero.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.8) {
        joyX = dx / d; joyZ = dz / d;
      } else {
        // Stå still nära taunter (han attackerar då via AA-lock)
        joyX = 0; joyZ = 0;
      }
    }
  }
  const mag = Math.hypot(joyX, joyZ);
  if (mag < 0.05) return;
  const strength = Math.min(1, mag);
  const ndx = joyX / mag, ndz = joyZ / mag;
  side.hero.facingX = ndx;
  side.hero.facingZ = ndz;
  // Onyx Orb: +10% MS per skill på CD
  let onyxMs = 0;
  if (side.inventory && side.inventory.some(it => it.itemId === 'item4')) {
    if (side.skills && side.skills.q.cd > 0) onyxMs += 0.10;
    if (side.skills && side.skills.f.cd > 0) onyxMs += 0.10;
    if (side.skills && side.skills.e.cd > 0) onyxMs += 0.10;
  }
  // Ice-block post-exit self-buff: +50% MS
  const iceMsBuff = (side.iceBlockMsBuff || 0) > 0 ? 0.5 : 0;
  // Aragurn whirlwind: +20% MS
  const whirlMs = (side.whirlwindRemaining || 0) > 0 ? WHIRLWIND_MS_BUFF : 0;
  // Aragurn allierad shout-buff: +20% MS (gäller bara allierade, INTE Aragurn själv)
  const allyShoutMs = (side.aragurnAllyShoutBuff || 0) > 0 ? SHOUT_BUFF_MS : 0;
  // Ice-block applicerad slow från motspelaren
  const slowMul = (side.heroSlowMul || 1);
  // Shadow Volley (Legolus ult): +20% movespeed under invis
  const invisMs = (side.legolusInvisRemaining || 0) > 0 ? LEGOLUS_INVIS_SPEED_BONUS : 0;
  const effSpeed = side.moveSpeed * (1 + onyxMs + iceMsBuff + whirlMs + allyShoutMs + invisMs) * slowMul;
  const nx = side.hero.x + ndx * effSpeed * strength * dt;
  const nz = side.hero.z + ndz * effSpeed * strength * dt;
  if (isHeroWalkable(side.idx, nx, nz)) { side.hero.x = nx; side.hero.z = nz; }
  else if (isHeroWalkable(side.idx, nx, side.hero.z)) side.hero.x = nx;
  else if (isHeroWalkable(side.idx, side.hero.x, nz)) side.hero.z = nz;
  side.mesh.position.x = side.hero.x;
  side.mesh.position.z = side.hero.z;
  // Under whirlwind: rotation styrs av tickAragurnWhirlwind (snabb spinn).
  // Annars: vänd mot rörelseriktningen.
  if (!((side.whirlwindRemaining || 0) > 0)) {
    side.mesh.rotation.y = Math.atan2(ndx, ndz);
  }
}

function applyEvent(side, ev) {
  // Cheat-events får alltid gå igenom
  if (ev.type === 'cheat') {
    if (ev.cmd === 'gold' && typeof ev.amount === 'number') {
      const amt = Math.max(0, Math.min(10_000_000, Math.floor(ev.amount)));
      side.gold += amt;
    }
    return;
  }
  // Ice-block channel: kan inte använda AA/skills (förutom item-activate som
  // hanteras separat — den tappar redan ice-block via cancel-flödet)
  const channelLocked = (side.iceBlockRemaining || 0) > 0;
  // Feared/stunnad av motspelaren: kan inte göra AA/skills
  const feared = (side.heroFearTime || 0) > 0;
  // Frusen/rotad: kan inte cast:a skills heller
  const frozen = (side.hero.frozenTime || 0) > 0;
  // Tauntad av motspelaren: kan inte cast:a skills, kan inte cancel:a AA
  const taunted = (side.hero.tauntedTime || 0) > 0;
  // Magiker laser-ult: kan inte göra AA eller andra skills
  const laserLocked = !!side.laserBeam;
  // Aragurn whirlwind + leap: kan inte göra AA eller andra skills under
  const whirlLocked = (side.whirlwindRemaining || 0) > 0;
  const leapLocked = !!side.aragurnLeap;
  if (ev.type === 'aa') {
    if (side.hero.dead || channelLocked || feared || frozen || laserLocked || whirlLocked || leapLocked) return;
    // Tauntad: AA-target låses i maintainTargetLock, men låt event:et gå igenom
    // (maintainTargetLock skriver över targetId direkt — klienten ser inte flimmer)
    // Manuell AA: aktivera bara om någon fiende redan finns inom range.
    const t = findClosestHostile(side, side.hero.x, side.hero.z, side.attackRange || HERO_ATTACK_RANGE);
    if (t) {
      side.aaActive = true;
      side.targetId = t.entity.id;
      side.targetType = t.targetType || (t.isMonster ? 'monster' : 'creep');
      side.targetX = t.entity.mesh.position.x;
      side.targetZ = t.entity.mesh.position.z;
    } else {
      side.aaActive = false;
      side.targetId = 0; side.targetType = '';
    }
    return;
  }
  if (ev.type === 'aa-cancel') {
    if (taunted) return;  // tauntad hero kan inte stänga av AA på taunter
    side.aaActive = false;
    side.targetId = 0; side.targetType = '';
    return;
  }
  if (ev.type === 'skill') {
    // Aragurn Q (whirlwind) och E (leap) blockerar ALLA andra skills, men user-cast ult
    // (R) tillåts under leap-flygning eftersom det vore frustrerande att blockas helt.
    // Whirlwind blockerar dock allt utom när whirl själv expirerat.
    if (side.hero.dead || channelLocked || feared || frozen || laserLocked || taunted) return;
    if (whirlLocked && ev.key !== 'q') return;   // bara den pågående Q tickar; ny cast skippas via cd
    if (leapLocked && ev.key !== 'r') return;
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
    const isAragurn = side.heroId === 'aragurn';
    // Q/F/E skill-cast: reset per-cast ult-gain-budget (AoE-skills som leap
    // skulle annars fylla ult proportionellt till antal targets träffade).
    if (ev.key === 'q' || ev.key === 'f' || ev.key === 'e') {
      side._ultCapThisCast = ULT_GAIN_SKILL_CAST_CAP;
      // Gandulf Soul Mark passive: tracka vilken skill träffade target
      side._currentSkillKey = ev.key;
    } else if (ev.key === 'r') {
      // Ult: räkna som sin egen skill för Soul Mark (annars stale Q/F/E-key
      // från förra cast skulle göra ult-tickar bidra som "samma skill")
      side._currentSkillKey = 'r';
    }
    if (ev.key === 'r') {
      hostCastUlt(side, dx, dz);
    } else if (ev.key === 'q') {
      if (isLegolus) hostCastLegolusVineTrap(side, ev);
      else if (isGimlu) hostCastGimluTaunt(side);
      else if (isAragurn) hostCastAragurnWhirlwind(side);
      else hostCastSoulDrain(side, ev);
    } else if (ev.key === 'f') {
      if (isLegolus) hostCastLegolusBuff(side);
      else if (isGimlu) hostCastGimluIronWill(side);
      else if (isAragurn) hostCastAragurnShout(side, dx, dz);
      else hostCastFrostnova(side, ev);
    } else if (ev.key === 'e') {
      if (isLegolus) hostCastLegolusDash(side, ev);
      else if (isGimlu) hostCastGimluHammer(side, dx, dz);
      else if (isAragurn) hostCastAragurnLeap(side, ev);
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
  // Arena prep + Boss Wars prep tillåter shop var som helst.
  // Klassiskt line wars: kräver bas-position.
  const isArenaPrep = APP.gameMode === 'arena1v1' && arenaState.phase === 'prep';
  const isBossWars = APP.gameMode === 'bosswars';
  if (!isArenaPrep && !isBossWars && !inSideBase(side.idx, side.hero.x, side.hero.z)) return;

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
  bossProjectiles: new Map(),
  bossPools: new Map(),
  thornPools: new Map(),
};

// Entiteter där interpolation gör störst nytta (karaktärer) — snabbflygande projektiler snappar.
const INTERPOLATED_KEYS = new Set(['monsters', 'playerCreeps', 'heroCopies']);

// Line wars: server broadcastar boss-skill activeCast i monster-snap (M[i].c).
// Klient spawnar telegraph-mesh på boss-meshen vid ny cast och rensar vid slut.
// Heroes ser röd telegraph-zon under telegraph-fasen → kan flytta sig ur den.
function syncBossSkillTelegraphsFromSnap(sideIdx, monsterList) {
  if (!monsterList) return;
  const meshMap = clientMeshes.monsters && clientMeshes.monsters.get(sideIdx);
  if (!meshMap) return;
  for (const m of monsterList) {
    const mesh = meshMap.get(m.id);
    if (!mesh) continue;
    const newCast = m.c;
    const newKey = newCast ? `${newCast.n}|${newCast.ph}` : '';
    const prevKey = mesh.userData._bossCastKey || '';
    if (newKey === prevKey) continue;
    // Cleanup gammal telegraph-mesh
    if (mesh.userData._bossTelegraph) {
      const tg = mesh.userData._bossTelegraph;
      tg.traverse?.(o => { if (o.geometry) o.geometry.dispose?.(); if (o.material) o.material.dispose?.(); });
      scene.remove(tg);
      mesh.userData._bossTelegraph = null;
    }
    if (newCast && newCast.ph === 'telegraph' && newCast.n) {
      // Pseudo-monster för spawnBossTelegraph (har samma fält som riktig boss)
      const pseudoMonster = { mesh, x: mesh.position.x, z: mesh.position.z };
      const pseudoSkill = {
        id: newCast.n,
        kind: newCast.k || 'groundCircle',
        radius: newCast.rad || 3,
        length: newCast.len || 0,
        halfAngle: newCast.ha || 0,
        width: newCast.w || 0,
        telegraph: newCast.tg || 1,
      };
      const pseudoCast = {
        skill: pseudoSkill,
        phase: 'telegraph',
        timer: newCast.t || 0,
        dirX: newCast.dx != null ? newCast.dx : 0,
        dirZ: newCast.dz != null ? newCast.dz : 1,
        originX: newCast.ox != null ? newCast.ox : mesh.position.x,
        originZ: newCast.oz != null ? newCast.oz : mesh.position.z,
        targetX: newCast.tx, targetZ: newCast.tz,
        telegraphMesh: null,
      };
      try { spawnBossTelegraph(null, pseudoMonster, pseudoCast); } catch (_) {}
      mesh.userData._bossTelegraph = pseudoCast.telegraphMesh;
    }
    mesh.userData._bossCastKey = newKey;
  }
}

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
      const oldX = mesh.position.x, oldZ = mesh.position.z;
      mesh.position.x = e.x;
      mesh.position.z = e.z;
      if (e.y !== undefined) mesh.position.y = e.y;
      if (e.ry !== undefined) mesh.rotation.y = e.ry;
      // Orient mot motion-riktning för pilar (creep-arrows: orientToMotion-flagga
      // sätts i makeMesh). Använd delta sedan förra snap som riktning.
      if (!fresh && mesh.userData && mesh.userData.orientToMotion) {
        const ddx = e.x - oldX, ddz = e.z - oldZ;
        if (ddx * ddx + ddz * ddz > 0.0001) mesh.rotation.y = Math.atan2(ddx, ddz);
      }
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
// Halflife 80 ms är en sweet-spot: snabbt nog att kännas responsivt, men
// tillräckligt tolerant mot nät-jitter att klienten inte stutter:ar vid
// fördröjda/burst:ade broadcasts. 35 ms (tidigare) gjorde att karaktärer
// "tickade" synligt vid varje state-tick på laggig anslutning.
function smoothEntityMeshes(dt) {
  const k = 1 - Math.pow(0.5, dt / 0.08);
  // Hero-meshes — alla 3 sidor (boss-wars MP har sides[3]).
  for (const sideIdx of [1, 2, 3]) {
    const side = sides[sideIdx];
    if (!side || !side.mesh._target) continue;
    smoothMeshToTarget(side.mesh, k);
  }
  // Boss-wars boss-mesh (ligger i sides[1].monsters)
  if (APP.gameMode === 'bosswars' && sides[1] && sides[1].monsters) {
    for (const m of sides[1].monsters) {
      if (m && m.mesh && m.mesh._target) smoothMeshToTarget(m.mesh, k);
    }
  }
  // Karaktär-meshes (monsters + creeps) i classic MP via clientMeshes
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

// Cache:a relevant clip-namnen per mesh (kostar att traversa actions varje frame)
function getCachedClipNames(mesh) {
  if (mesh.userData._cachedClips) return mesh.userData._cachedClips;
  const actions = mesh.userData.actions;
  if (!actions) return null;
  const cache = {
    idle:   findClipName(actions, 'Idle'),
    walk:   findClipName(actions, 'Walking', 'Walk'),
    run:    findClipName(actions, 'Running', 'Run'),
    attack: findClipName(actions, '1H_Melee_Attack', '2H_Melee_Attack', 'Attack', 'Chop', 'Spellcast_Shoot', 'Spellcast'),
    death:  findClipName(actions, 'Death_A', 'Death'),
  };
  mesh.userData._cachedClips = cache;
  return cache;
}

function animateGltfCharacter(mesh, dt, side, type) {
  let st = mesh._gltfState;
  if (!st) {
    st = mesh._gltfState = {
      lastX: mesh.position.x,
      lastZ: mesh.position.z,
      attackTimer: 0,
    };
  }

  // Velocity från positionsdelta
  const dx = mesh.position.x - st.lastX;
  const dz = mesh.position.z - st.lastZ;
  const vel = Math.hypot(dx, dz) / Math.max(dt, 0.001);
  st.lastX = mesh.position.x;
  st.lastZ = mesh.position.z;

  const clips = getCachedClipNames(mesh);
  if (!clips) return;

  // Death: kör en gång och stanna kvar
  const isDead = side && side.hero && side.hero.dead;
  if (isDead) {
    if (clips.death && mesh.userData.currentClipName !== clips.death) {
      playGltfAction(mesh, clips.death, { once: true, fade: 0.15 });
    }
    return;
  }

  // Attack-detektion (hero): attackCounter-delta + skill-CD-hopp
  let attackTrig = false;
  if (side && type === 'hero') {
    if (side._lastAttackCounter === undefined) side._lastAttackCounter = side.attackCounter || 0;
    if ((side.attackCounter || 0) > side._lastAttackCounter) {
      side._lastAttackCounter = side.attackCounter;
      attackTrig = true;
    }
    if (!side._lastSkillCd) side._lastSkillCd = { q: 0, f: 0, e: 0 };
    for (const k of ['q', 'f', 'e']) {
      const cur = (side.skills && side.skills[k]) ? side.skills[k].cd : 0;
      if (cur > side._lastSkillCd[k] + 0.5 && cur > 0.5) attackTrig = true;
      side._lastSkillCd[k] = cur;
    }
  }
  // Attack-detektion (monster/boss): flagga sätts av updateMonsters/tickBossSkills
  if (type === 'monster' && mesh.userData.attackTrigger) {
    attackTrig = true;
    mesh.userData.attackTrigger = false;
  }

  if (attackTrig && clips.attack) {
    // Monster/boss attack-clip håller längre + lite långsammare så slaget syns tydligt
    const isBossMon = type === 'monster';
    playGltfAction(mesh, clips.attack, { once: true, fade: 0.08, timeScale: isBossMon ? 1.0 : 1.4 });
    st.attackTimer = isBossMon ? 0.7 : HERO_ATTACK_DURATION;
  }

  if (st.attackTimer > 0) {
    st.attackTimer -= dt;
    return; // håll kvar attack-clipet
  }

  // Aragurn whirlwind: kör attack-clip i loop istället för run/walk så det ser ut
  // som en kontinuerlig snurr-svingning, oavsett om han springer eller står stilla.
  if (side && side.heroId === 'aragurn' && (side.whirlwindRemaining || 0) > 0) {
    if (clips.attack) {
      playGltfAction(mesh, clips.attack, { fade: 0.08, timeScale: 2.0 });
    } else if (clips.idle) {
      playGltfAction(mesh, clips.idle);
    }
    return;
  }

  // Movement state
  if (vel > 4.0 && clips.run) {
    playGltfAction(mesh, clips.run);
  } else if (vel > 0.4 && clips.walk) {
    playGltfAction(mesh, clips.walk);
  } else if (clips.idle) {
    playGltfAction(mesh, clips.idle);
  }
}

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

  const phase = st.walkPhase;
  const sinP = Math.sin(phase);
  const cosP = Math.cos(phase);

  // ---- Walk-cykel ----
  // Lår svänger ±SWING runt höften. Underbenet bryts (knäböj) bara när
  // benet är på väg fram (sin>0 för vänster, <0 för höger) — det är vad som
  // ger MLBB-känslan av "fot lyfts upp och svingas framåt".
  const swing = moving ? sinP * WALK_AMPLITUDE * 1.15 : 0;
  if (rig.leftLeg) rig.leftLeg.rotation.x = swing;
  if (rig.rightLeg) rig.rightLeg.rotation.x = -swing;

  // Knäböj: 0 i stance, upp till ~1.4 rad (80°) under swing-fasen.
  // Smoothstep-likt med ^1.4 → mjuk upp/ner.
  const KNEE_MAX = 1.45;
  const leftBend  = moving ? Math.pow(Math.max(0,  sinP), 1.3) * KNEE_MAX : 0;
  const rightBend = moving ? Math.pow(Math.max(0, -sinP), 1.3) * KNEE_MAX : 0;
  if (rig.leftLegLower)  rig.leftLegLower.rotation.x  = leftBend;
  if (rig.rightLegLower) rig.rightLegLower.rotation.x = rightBend;

  // Fot-tilt: kompenserar lite för knäböjen så foten inte pekar rakt ned
  // när benet är högst, och tippar framåt vid avstöt (toe-off).
  if (rig.leftFootPivot)  rig.leftFootPivot.rotation.x  = moving ? -leftBend * 0.45 + Math.max(0, -sinP) * 0.30 : 0;
  if (rig.rightFootPivot) rig.rightFootPivot.rotation.x = moving ? -rightBend * 0.45 + Math.max(0,  sinP) * 0.30 : 0;

  // Arm-swing (motsatt fas mot benen, ~70% av amplituden)
  if (rig.leftArm)  rig.leftArm.rotation.x  = -swing * 0.70;
  if (rig.rightArm) rig.rightArm.rotation.x =  swing * 0.70;
  // Lite sidoutåt-vinkel på armarna under löpning (mer naturlig pose)
  if (moving) {
    if (rig.leftArm)  rig.leftArm.rotation.z  =  0.10;
    if (rig.rightArm) rig.rightArm.rotation.z = -0.10;
  } else {
    if (rig.leftArm)  rig.leftArm.rotation.z  = 0;
    if (rig.rightArm) rig.rightArm.rotation.z = 0;
  }

  // Spine / torso counter-rotation: shoulders vrider sig mot bäckenet,
  // huvudet kompenserar lite tillbaka så blicken hålls stabil.
  if (rig.torso) rig.torso.rotation.y = moving ?  sinP * 0.12 : 0;
  if (rig.head)  rig.head.rotation.y  = moving ? -sinP * 0.07 : 0;
  // Lutar bröstet aningen framåt vid löpning
  if (rig.torso) rig.torso.rotation.x = moving ? 0.06 : 0;

  // Kropps-bounce: två studsar per stride (vid varje fot-ilandning),
  // amplitud skalar lätt med velocity.
  if (moving) {
    const bounceAmp = 0.05 + Math.min(0.04, vel * 0.005);
    mesh.position.y = Math.abs(sinP) * bounceAmp;
  } else {
    const t = performance.now() / 1000;
    // Idle: andningsrörelse + svag sway
    mesh.position.y = Math.sin(t * 1.6 + st.idlePhase) * 0.014;
    if (rig.torso) rig.torso.rotation.y = Math.sin(t * 0.8 + st.idlePhase) * 0.035;
    if (rig.head)  rig.head.rotation.y  = Math.sin(t * 0.9 + st.idlePhase * 1.3) * 0.045;
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

  // Attack-thrust: ersätt höger arm-rotation med framåt-pose + lätt
  // bål-rotation så slaget ser ut att komma från höften.
  if (st.attackTimer > 0) {
    st.attackTimer -= dt;
    const total = st.attackTotal || ATTACK_DURATION;
    const t = Math.max(0, Math.min(1, 1 - st.attackTimer / total));
    const intensity = Math.sin(t * Math.PI);  // 0 → 1 → 0
    if (rig.rightArm) {
      const walkRot = swing * 0.70;
      rig.rightArm.rotation.x = -1.25 * intensity + walkRot * (1 - intensity);
      rig.rightArm.rotation.z = -0.10 - intensity * 0.20;
    }
    if (rig.torso) rig.torso.rotation.y += intensity * -0.20;
  }
}

function animateMeshChar(mesh, dt, side, type) {
  if (mesh.userData.mixer) {
    animateGltfCharacter(mesh, dt, side, type);
  } else if (mesh.userData.rig) {
    animateCharacter(mesh, dt, side, type); // legacy procedurell fallback
  }
}

function animateAllCharacters(dt) {
  if (APP.mode === 'lobby') return;
  const idxs = (APP.gameMode === 'arena1v1' && APP.arenaTeamSize === 2) ? [1, 2, 3, 4] : [1, 2];
  // Hero-meshes
  for (const sideIdx of idxs) {
    const side = sides[sideIdx];
    if (!side || !side.mesh) continue;
    if (!side.mesh.visible) continue;
    animateMeshChar(side.mesh, dt, side, 'hero');
  }
  // Solo: monster/creep-meshes ligger på side.monsters/playerCreeps direkt
  if (APP.mode === 'solo') {
    for (const sideIdx of idxs) {
      const side = sides[sideIdx];
      if (!side) continue;
      for (const m of side.monsters) if (m.mesh) animateMeshChar(m.mesh, dt, null, 'monster');
      for (const c of side.playerCreeps) if (c.mesh) animateMeshChar(c.mesh, dt, null, 'minion');
    }
  }
  // MP: meshes från clientMeshes
  if (APP.mode === 'host' || APP.mode === 'client') {
    for (const key of ['monsters', 'playerCreeps']) {
      const tier = clientMeshes[key];
      if (!tier) continue;
      const type = key === 'monsters' ? 'monster' : 'minion';
      for (const map of tier.values()) {
        for (const mesh of map.values()) animateMeshChar(mesh, dt, null, type);
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
  // Sync duel pickup-orbs + big duel-arena orb
  if (duelState.active) {
    syncDuelOrbsFromState(state.dO);
    syncDuelBigOrbFromState(state.dBO);
  } else if (wasActive) {
    clearDuelOrbMeshes();
    clearDuelBigOrbMesh();
  }
  for (const idx of [1, 2]) {
    const sData = state.s[idx];
    if (!sData) continue;
    const side = sides[idx];
    if (!side) continue;
    // Hero pick info per side
    if (sData.hid !== undefined) side.heroId = sData.hid;
    if (sData.hpc !== undefined) side.heroPickConfirmed = !!sData.hpc;
    // Hjälte position: för OWN side (vår egen hero) i classic MP kör vi
    // local-prediction varje frame via tickLocalPrediction → reconcile bara
    // vid stora avvikelser (knockback, teleport, stun) så vanlig löpning blir
    // smooth 60Hz istället för ryckigt 20Hz från snap-stream. För opp-side
    // applieras snap direkt (smooth via mesh._target-interpolation).
    const isOwnLocalClassicMp = (idx === APP.localSide) &&
      (APP.mode === 'host' || APP.mode === 'client') && APP.gameMode === 'classic';
    if (isOwnLocalClassicMp) {
      const dxR = side.hero.x - sData.h.x;
      const dzR = side.hero.z - sData.h.z;
      // 2.5m² = 6.25 — stor avvikelse = knockback/teleport/stun → snap till server
      if (dxR * dxR + dzR * dzR > 6.25) {
        side.hero.x = sData.h.x;
        side.hero.z = sData.h.z;
      }
      // Annars behåll lokal predicted pos
    } else {
      side.hero.x = sData.h.x;
      side.hero.z = sData.h.z;
    }
    side.hero.hp = sData.h.hp;
    side.hero.maxHp = sData.h.mh;
    side.hero.facingX = sData.h.fx;
    side.hero.facingZ = sData.h.fz;
    side.hero.dead = !!sData.h.d;
    side.hero.respawnTimer = sData.h.rt;
    // Debuff-timers
    side.hero.frozenTime = sData.h.frz || 0;
    side.hero.dotRemaining = sData.h.dot || 0;
    side.hero.tauntedTime = sData.h.tnt || 0;
    side.hero.poisonRemaining = sData.h.poi || 0;
    // Aragurn-state (för visuella effekter på klient)
    side.whirlwindRemaining = sData.wwR || 0;
    if (sData.leapA) {
      side.aragurnLeap = side.aragurnLeap || {};
      side.aragurnLeap.active = true;
      side.aragurnLeap.u = sData.leapU || 0;
      side.aragurnLeap.targetX = sData.leapTx || 0;
      side.aragurnLeap.targetZ = sData.leapTz || 0;
    } else {
      side.aragurnLeap = null;
    }
    const heroRy = Math.atan2(sData.h.fx, sData.h.fz);
    if (isOwnLocalClassicMp) {
      // Own-side i classic MP: tickLocalPrediction uppdaterar mesh.position
      // direkt via applyMovement varje frame. Sätt _target=null så
      // smoothEntityMeshes inte krockar med prediction (annars dubbel-update).
      side.mesh._target = null;
    } else {
      if (!side.mesh._target) {
        side.mesh.position.x = sData.h.x;
        side.mesh.position.z = sData.h.z;
        side.mesh.rotation.y = heroRy;
      }
      side.mesh._target = { x: sData.h.x, z: sData.h.z, ry: heroRy };
    }
    side.mesh.visible = !sData.h.d;
    // Resurser
    side.gold = sData.g;
    side.income = sData.inc ?? side.income;
    side.incomeTimer = sData.incT ?? side.incomeTimer;
    // Ult-energy från server-snap (mätare-rendering + R-knapp ready-toggle)
    if (sData.ue !== undefined) side.ultEnergy = sData.ue;
    if (sData.incC !== undefined) side.incomeTickCount = sData.incC;
    // Portal-state (lvl-30 PvP-portal)
    if (sData.ptu !== undefined) side.portalUsesLeft = sData.ptu;
    if (sData.ptc !== undefined) side.portalCooldown = sData.ptc;
    side.inEnemyTerritory = !!sData.pet;
    side.enemyTerritoryTimer = sData.petT || 0;
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
    // Shadow Volley ult-state (invis-timer + empowered-AA-flagga). Klient
    // sätter hero-mesh-opacity nedan baserat på lInv.
    side.legolusInvisRemaining = sData.lInv || 0;
    side.legolusUltAaPending = !!sData.lAa;
    // Gimlu buff-status
    side.titansTauntRemaining = sData.taunt || 0;
    side.ironWillRemaining = sData.iw || 0;
    side.ironWillStored = sData.iwS || 0;
    // Gandulf passive
    side.gandulfBuffRemaining = sData.gbuf || 0;
    side.gandulfBuffStacks = sData.gbStk || 0;
    side.shield = sData.shld || 0;
    // Duel speed-buff
    side.duelSpeedBuffRemaining = sData.dSp || 0;
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
      else if (e && e.mb) m.scale.set(1.25, 1.3, 1.25);   // miniboss = mellan minion (1.0) och boss (1.6)
      if (e && e.r) {
        // Range-monster grön-tintat
        m.traverse(o => {
          if (o.material && o.material.color && o.isMesh) {
            o.material = o.material.clone();
            o.material.color.setHex(0x5a7a4a);
          }
        });
      }
      attachHpBar(m, (e && e.boss) ? 2.4 : (e && e.mb) ? 2.0 : 1.7);
      return m;
    });
    // Boss-skill-telegraph: efter monster-reconcile, kolla om någon boss har
    // ny activeCast i snap → spawna telegraph-mesh på dess mesh. När cast
    // försvinner, rensa telegraph. Heroes kan dodga ut ur damage-zonen under
    // telegraph-fasen.
    syncBossSkillTelegraphsFromSnap(idx, sData.M);
    // Boss-projektiler + DoT-pools (line wars boss-skills)
    clientReconcileEntities(idx, 'bossProjectiles', sData.BP || [], () => {
      const grp = new THREE.Group();
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.45, 14, 10),
        new THREE.MeshStandardMaterial({ color: 0xff6622, emissive: 0xff3300, emissiveIntensity: 1.4 })
      );
      core.position.y = 1.0;
      grp.add(core);
      return grp;
    });
    clientReconcileEntities(idx, 'bossPools', sData.BPL || [], () => {
      const grp = new THREE.Group();
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 4.5, 36),
        new THREE.MeshBasicMaterial({ color: 0x66cc44, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.08;
      grp.add(ring);
      const inner = new THREE.Mesh(
        new THREE.CircleGeometry(4.4, 32),
        new THREE.MeshBasicMaterial({ color: 0x447733, transparent: true, opacity: 0.30, side: THREE.DoubleSide })
      );
      inner.rotation.x = -Math.PI / 2;
      inner.position.y = 0.06;
      grp.add(inner);
      grp.userData.poolRing = ring;
      grp.userData.poolInner = inner;
      return grp;
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
        // Fireball: större glowing orb med sekundär halo så pilbåge-flyget syns.
        const grp = new THREE.Group();
        const core = new THREE.Mesh(
          new THREE.SphereGeometry(0.30, 14, 10),
          new THREE.MeshStandardMaterial({ color: 0xff7733, emissive: 0xff5511, emissiveIntensity: 2.0, roughness: 0.35 })
        );
        grp.add(core);
        const halo = new THREE.Mesh(
          new THREE.SphereGeometry(0.50, 12, 8),
          new THREE.MeshBasicMaterial({ color: 0xffaa44, transparent: true, opacity: 0.32, depthWrite: false })
        );
        grp.add(halo);
        return grp;
      }
      // Pil: större cone med silver-tip + brun shaft + fjädrar. Orienteras
      // mot motion-riktning via userData-flagga (renderas av updateCreepProjectiles-mesh).
      const grp = new THREE.Group();
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045, 0.045, 0.70, 8),
        new THREE.MeshStandardMaterial({ color: 0x6a4020, roughness: 0.75 })
      );
      shaft.rotation.x = Math.PI / 2;
      grp.add(shaft);
      const tip = new THREE.Mesh(
        new THREE.ConeGeometry(0.08, 0.22, 8),
        new THREE.MeshStandardMaterial({ color: 0xc8c8d0, metalness: 0.55, roughness: 0.35 })
      );
      tip.rotation.x = Math.PI / 2;
      tip.position.z = 0.42;
      grp.add(tip);
      const featherMat = new THREE.MeshBasicMaterial({ color: 0xddddee, transparent: true, opacity: 0.92, side: THREE.DoubleSide });
      for (let i = 0; i < 3; i++) {
        const ang = (i / 3) * Math.PI * 2;
        const f = new THREE.Mesh(new THREE.PlaneGeometry(0.10, 0.18), featherMat);
        f.position.set(Math.cos(ang) * 0.05, Math.sin(ang) * 0.05, -0.30);
        f.rotation.z = ang;
        grp.add(f);
      }
      grp.userData.orientToMotion = true;
      return grp;
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
    // Shadow Volley thorn pools (Legolus ult): grön disc med torn-spikes, AoE-ring.
    clientReconcileEntities(idx, 'thornPools', sData.TP || [], (e) => {
      const grp = new THREE.Group();
      const r = (e && e.r) || 2.5;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(r * 0.85, r, 36),
        new THREE.MeshBasicMaterial({ color: 0x4a8030, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.08;
      grp.add(ring);
      const inner = new THREE.Mesh(
        new THREE.CircleGeometry(r * 0.83, 28),
        new THREE.MeshBasicMaterial({ color: 0x2a4818, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
      );
      inner.rotation.x = -Math.PI / 2;
      inner.position.y = 0.06;
      grp.add(inner);
      for (let i = 0; i < 10; i++) {
        const ang = (i / 10) * Math.PI * 2;
        const rad = r * (0.3 + Math.random() * 0.4);
        const sp = new THREE.Mesh(
          new THREE.ConeGeometry(0.10, 0.42, 6),
          new THREE.MeshStandardMaterial({ color: 0x224410, roughness: 0.75 })
        );
        sp.position.set(Math.cos(ang) * rad, 0.20, Math.sin(ang) * rad);
        sp.rotation.x = (Math.random() - 0.5) * 0.3;
        grp.add(sp);
      }
      grp.userData.tpRing = ring;
      grp.userData.tpInner = inner;
      return grp;
    });
    const tpMap = clientMeshes.thornPools && clientMeshes.thornPools.get(idx);
    if (tpMap && sData.TP) for (const tp of sData.TP) {
      const m = tpMap.get(tp.id);
      if (m && m.userData.tpRing) {
        m.userData.tpRing.material.opacity = 0.70 * tp.life;
        if (m.userData.tpInner) m.userData.tpInner.material.opacity = 0.45 * tp.life;
      }
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
  // Boss Wars: vinn = boss död, förlust = hjälte död.
  // Vänta tills bossen faktiskt spawnats — annars triggas vinst direkt under
  // hero-pick eftersom sides[1].monsters fortfarande är tom.
  if (APP.gameMode === 'bosswars') {
    if (!APP.bossWars || !APP.bossWars.started) return;
    const s = sides[1];
    if (!s) return;
    if (!s.bossWarsBossId) return;
    // MP co-op: förlust = ALLA hjältar är döda (klassisk raid). Vinst = boss död.
    if (bossMpState.matchActive) {
      const heroes = [sides[1], sides[2], sides[3]].filter(Boolean);
      const allDead = heroes.length > 0 && heroes.every(h => h.hero.dead);
      const bossAlive = s.monsters.some(m => m.isBossWarsBoss);
      if (allDead) {
        matchState.gameOver = true;
        matchState.winner = 2;
        matchState.gameWon = false;
        if (bossMpState.role === 'host') sendGameMsg({ t: 'b-end', won: false });
      } else if (!bossAlive) {
        matchState.gameOver = true;
        matchState.winner = 1;
        matchState.gameWon = true;
        if (bossMpState.role === 'host') sendGameMsg({ t: 'b-end', won: true });
      }
      return;
    }
    // Solo: existing logic
    if (s.hero.dead) {
      matchState.gameOver = true;
      matchState.winner = 2;
      matchState.gameWon = false;
    } else {
      const bossAlive = s.monsters.some(m => m.isBossWarsBoss);
      if (!bossAlive) {
        matchState.gameOver = true;
        matchState.winner = 1;
        matchState.gameWon = true;
      }
    }
    return;
  }
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

const cameraOffset = new THREE.Vector3(0, 17, 14);
const cameraTarget = new THREE.Vector3();

// Arena-läget får större kamera-distans så hela den dubblade banan syns
// (30% inzoomad från tidigare 32/26 → 22/18)
const ARENA_CAMERA_OFFSET = new THREE.Vector3(0, 22, 18);
// Boss Wars: zoomat ut 25% från classic så man ser bossens AoE bättre
const BOSSWARS_CAMERA_OFFSET = new THREE.Vector3(0, 17 * 1.25, 14 * 1.25);

// Camera-shake: triggas av stora effekter (orb-död, AoE-explosioner)
const cameraShake = { magnitude: 0, duration: 0, elapsed: 0 };
function triggerCameraShake(magnitude, duration) {
  // Använd den största pågående shaken (override om ny är starkare)
  if (magnitude > cameraShake.magnitude || cameraShake.elapsed > cameraShake.duration * 0.5) {
    cameraShake.magnitude = magnitude;
    cameraShake.duration = duration;
    cameraShake.elapsed = 0;
  }
}

function updateCamera(dt) {
  if (!sides[APP.localSide]) return;
  const hero = sides[APP.localSide].hero;
  // Klient (sida 2) = kamera spegelvänd
  const sign = (APP.localSide === 2) ? -1 : 1;
  const off = (APP.gameMode === 'arena1v1') ? ARENA_CAMERA_OFFSET
            : (APP.gameMode === 'bosswars') ? BOSSWARS_CAMERA_OFFSET
            : cameraOffset;
  const desiredX = hero.x + off.x * sign;
  const desiredY = off.y;
  const desiredZ = hero.z + off.z * sign;
  // ~50 ms halflife — kameran följer responsivt men utan ryck
  const lerpK = 1 - Math.pow(0.5, dt / 0.05);
  camera.position.x += (desiredX - camera.position.x) * lerpK;
  camera.position.y += (desiredY - camera.position.y) * lerpK;
  camera.position.z += (desiredZ - camera.position.z) * lerpK;
  cameraTarget.x += (hero.x - cameraTarget.x) * lerpK;
  cameraTarget.y += (0.8 - cameraTarget.y) * lerpK;
  cameraTarget.z += (hero.z - cameraTarget.z) * lerpK;
  // Camera-shake: random offset som fade:as ut över duration
  if (cameraShake.duration > 0) {
    cameraShake.elapsed += dt;
    if (cameraShake.elapsed >= cameraShake.duration) {
      cameraShake.magnitude = 0;
      cameraShake.duration = 0;
      cameraShake.elapsed = 0;
    } else {
      const fade = 1 - cameraShake.elapsed / cameraShake.duration;
      const m = cameraShake.magnitude * fade;
      camera.position.x += (Math.random() - 0.5) * m * 2;
      camera.position.y += (Math.random() - 0.5) * m;
      camera.position.z += (Math.random() - 0.5) * m * 2;
    }
  }
  camera.lookAt(cameraTarget);
}

// ============================================================
// HUD
// ============================================================

const hudEl = document.getElementById('hud');         // null efter HUD-omfördelning
const statusEl = document.getElementById('status');   // null — ersatt av nya element nedan
// Nya HUD-element efter omfördelning: torn-HP-stack (vänster), gold inline med income,
// wave-display (top-row), respawn-overlay (centrerad vid död).
const towerOwnFillEl = document.getElementById('tower-hp-own-fill');
const towerOwnTextEl = document.getElementById('tower-hp-own-text');
const towerEnemyFillEl = document.getElementById('tower-hp-enemy-fill');
const towerEnemyTextEl = document.getElementById('tower-hp-enemy-text');
const incomeGoldEl = document.getElementById('income-gold');
const waveDisplayEl = document.getElementById('wave-display');
const waveTextEl = document.getElementById('wave-text');
const respawnOverlayEl = document.getElementById('respawn-overlay');
const respawnTimerEl = document.getElementById('respawn-timer');
const towerHpStackEl = document.getElementById('tower-hp-stack');
const endgameEl = document.getElementById('endgame');
const endgameTitle = document.getElementById('endgame-title');
const endgameInfo = document.getElementById('endgame-info');
document.getElementById('restart-btn').addEventListener('click', () => location.reload());

function fmtCd(s) { return s <= 0 ? 'redo' : s.toFixed(1) + 's'; }

function updateHud() {
  const side = sides[APP.localSide];
  if (!side) return;
  if (matchState.gameOver) {
    // Match slut: dölj respawn-overlay (var synlig vid hero-död)
    if (respawnOverlayEl) respawnOverlayEl.classList.add('hidden');
    endgameEl.classList.add('visible');
    const won = matchState.winner === APP.localSide;
    endgameEl.classList.toggle('win', won);
    endgameEl.classList.toggle('lose', !won);
    endgameTitle.textContent = won ? 'VINST!' : 'FÖRLUST';
    if (APP.gameMode === 'bosswars') {
      const bossInfo = getBossWarsDef(APP.bossWars && APP.bossWars.tier || 1);
      endgameInfo.textContent = won
        ? `Du besegrade ${bossInfo.name} (Tier ${bossInfo.tier} · ${bossInfo.diff})!`
        : `${bossInfo.name} besegrade dig. Försök igen!`;
    } else {
      endgameInfo.textContent = won
        ? `Du krossade motståndarens torn på wave ${side.wave.current}.`
        : `Ditt torn föll på wave ${side.wave.current}.`;
    }
    return;
  }
  const opp = sides[3 - APP.localSide];
  const isArena = APP.gameMode === 'arena1v1';
  const isBossWars = APP.gameMode === 'bosswars';
  // Tower HP-stack (line wars endast — arena/boss har inga torn)
  const showTowers = !isArena && !isBossWars;
  if (towerHpStackEl) towerHpStackEl.classList.toggle('hidden', !showTowers);
  if (showTowers) {
    if (towerOwnFillEl) towerOwnFillEl.style.width = ((side.tower.hp / side.tower.maxHp) * 100).toFixed(1) + '%';
    if (towerOwnTextEl) towerOwnTextEl.textContent = `${side.tower.hp}/${side.tower.maxHp}`;
    if (opp) {
      if (towerEnemyFillEl) towerEnemyFillEl.style.width = ((opp.tower.hp / opp.tower.maxHp) * 100).toFixed(1) + '%';
      if (towerEnemyTextEl) towerEnemyTextEl.textContent = `${opp.tower.hp}/${opp.tower.maxHp}`;
    } else {
      if (towerEnemyFillEl) towerEnemyFillEl.style.width = '0%';
      if (towerEnemyTextEl) towerEnemyTextEl.textContent = '–';
    }
  }
  // Wave-display (line wars endast)
  if (waveDisplayEl) {
    if (showTowers) {
      waveDisplayEl.classList.remove('hidden');
      if (waveTextEl) {
        if (side.wave.active) waveTextEl.textContent = `Wave ${side.wave.current}`;
        else waveTextEl.textContent = `Wave ${side.wave.current + 1} om ${side.wave.betweenTimer.toFixed(1)}s`;
      }
    } else {
      waveDisplayEl.classList.add('hidden');
    }
  }
  // Gold inline med income (line wars + boss wars). Arena har ingen gold-mekanik.
  if (incomeGoldEl) {
    if (!isArena) incomeGoldEl.textContent = `${side.gold}g`;
    else incomeGoldEl.textContent = '';
  }
  // Respawn-overlay: visa "RESPAWN <countdown>" när hero är död i line/boss wars
  if (respawnOverlayEl) {
    const showRespawn = side.hero.dead && !isArena;
    respawnOverlayEl.classList.toggle('hidden', !showRespawn);
    if (showRespawn && respawnTimerEl) {
      respawnTimerEl.textContent = side.hero.respawnTimer.toFixed(1);
    }
  }
  updateLevelUI(side);
  updateBossHpBar();
}

// Performance-mätare (top-right): frame-time i ms + FPS, med färg-kod
// och mini-bar mot 60 fps target. Uppdateras ~4 gånger/sek så siffrorna
// är stabila och lätta att läsa (annars flickerar de varje frame).
const perfMeterEl = document.getElementById('perf-meter');
const perfMsEl = document.getElementById('perf-ms');
const perfFpsEl = document.getElementById('perf-fps');
const perfBarFillEl = document.getElementById('perf-bar-fill');
const _perfFrames = [];
let _perfLastUpdateMs = 0;
let _lastHudMs = 0;   // throttle-tracker för HUD-textuppdateringar
const PERF_FRAME_BUDGET_MS = 1000 / 60;   // 16.67 ms = 60 fps target
function tickPerfMeter(dt) {
  if (!perfMeterEl) return;
  // Lägg dagens dt (sekunder) i rullande fönster av ~60 frames
  _perfFrames.push(dt);
  if (_perfFrames.length > 60) _perfFrames.shift();
  const nowMs = performance.now();
  if (nowMs - _perfLastUpdateMs < 250) return;
  _perfLastUpdateMs = nowMs;
  const sum = _perfFrames.reduce((s, v) => s + v, 0);
  const avg = sum / Math.max(1, _perfFrames.length);
  const ms = avg * 1000;
  const fps = avg > 0 ? (1 / avg) : 0;
  if (perfMsEl) perfMsEl.textContent = ms.toFixed(1);
  if (perfFpsEl) perfFpsEl.textContent = Math.round(fps);
  // Bar-fill: 100% när vi når 60 fps (16.67ms), skalar ner när frame-time växer
  if (perfBarFillEl) {
    const ratio = Math.max(0, Math.min(1, PERF_FRAME_BUDGET_MS / ms));
    perfBarFillEl.style.width = (ratio * 100).toFixed(0) + '%';
  }
  // Färg-tillstånd (klassbaserat)
  perfMeterEl.classList.remove('warn', 'bad');
  if (ms > 33) perfMeterEl.classList.add('bad');         // < 30 fps
  else if (ms > 20) perfMeterEl.classList.add('warn');   // < 50 fps
}

// Top-center boss HP-bar (procent). Synlig under boss-fighten i boss wars.
const bossHpWrapEl = document.getElementById('boss-hp-wrap');
const bossHpFillEl = document.getElementById('boss-hp-fill');
const bossHpPctEl = document.getElementById('boss-hp-pct');
const bossHpNameEl = document.getElementById('boss-hp-name');
function updateBossHpBar() {
  if (!bossHpWrapEl) return;
  if (APP.gameMode !== 'bosswars' || !APP.bossWars || !APP.bossWars.started) {
    bossHpWrapEl.classList.add('hidden');
    return;
  }
  // Hitta boss-meshen — bor i sides[1].monsters med isBossWarsBoss=true
  const hostSide = sides[1];
  const boss = hostSide && hostSide.monsters
    ? hostSide.monsters.find(m => m.isBossWarsBoss)
    : null;
  if (!boss || boss.hp <= 0) {
    bossHpWrapEl.classList.add('hidden');
    return;
  }
  bossHpWrapEl.classList.remove('hidden');
  const pct = Math.max(0, Math.min(100, (boss.hp / boss.maxHp) * 100));
  // Visa 1 decimal när < 10%, annars heltal (känns mer "epic" på final stretch)
  const pctStr = pct < 10 ? pct.toFixed(1) : Math.round(pct).toString();
  if (bossHpFillEl) bossHpFillEl.style.width = pct + '%';
  if (bossHpPctEl) bossHpPctEl.textContent = pctStr + '%';
  if (bossHpNameEl && boss.bossName) bossHpNameEl.textContent = boss.bossName;
  // Phase 2 styling
  bossHpWrapEl.classList.toggle('phase2', boss.bossPhase === 2);
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

// Aim-line — Group med fyllning + bred glow, tydligare än tidigare smala plan
const aimLine = new THREE.Group();
const aimLineCore = new THREE.Mesh(
  new THREE.PlaneGeometry(ELDKLOT_RANGE, 1.0),
  new THREE.MeshBasicMaterial({ color: 0xff7733, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false })
);
aimLine.add(aimLineCore);
const aimLineGlow = new THREE.Mesh(
  new THREE.PlaneGeometry(ELDKLOT_RANGE, 1.8),
  new THREE.MeshBasicMaterial({ color: 0xffaa55, transparent: true, opacity: 0.30, side: THREE.DoubleSide, depthWrite: false })
);
aimLine.add(aimLineGlow);
aimLine.rotation.x = -Math.PI / 2;
aimLine.visible = false;
scene.add(aimLine);

const aimDot = new THREE.Mesh(
  new THREE.CircleGeometry(0.9, 24),
  new THREE.MeshBasicMaterial({ color: 0xaa88ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })
);
aimDot.rotation.x = -Math.PI / 2;
aimDot.visible = false;
scene.add(aimDot);

// Generic AoE-aim-ring (skalas + tintas per skill) — Group med fyllning + tjock kant
const aimCircle = new THREE.Group();
const aimCircleFill = new THREE.Mesh(
  new THREE.CircleGeometry(1.0, 40),
  new THREE.MeshBasicMaterial({ color: 0x88ddff, transparent: true, opacity: 0.30, side: THREE.DoubleSide, depthWrite: false })
);
aimCircle.add(aimCircleFill);
const aimCircleRing = new THREE.Mesh(
  new THREE.RingGeometry(0.86, 1.0, 48),
  new THREE.MeshBasicMaterial({ color: 0x88ddff, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false })
);
aimCircle.add(aimCircleRing);
const aimCircleInner = new THREE.Mesh(
  new THREE.RingGeometry(0.75, 0.86, 48),
  new THREE.MeshBasicMaterial({ color: 0x88ddff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
);
aimCircle.add(aimCircleInner);
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
  // Drag-magnitude som fraktion 0..1 — bestämmer avstånd inom max range
  const dragFrac = Math.min(1, Math.max(0, aimState.dragMag / AIM_MAX_DRAG));

  // Returnerar cast-position för en target-baserad skill given MAX-distance.
  // Drag: hero + drag-dir × (drag-fraktion × maxDist) — så användaren bestämmer
  // exakt vart, inom max-range. Tap-on-target: target's position. Annars: hero.
  function castGround(maxDist) {
    let p;
    if (dragging) p = { x: side.hero.x + w.x * (dragFrac * maxDist), z: side.hero.z + w.z * (dragFrac * maxDist) };
    else if (side.targetId && side.targetType) {
      if (APP.mode === 'solo') {
        const opp = sides[3 - side.idx];
        const t = resolveTargetEntity(side, opp);
        if (t && t.mesh) p = { x: t.mesh.position.x, z: t.mesh.position.z };
      } else if (side.targetX || side.targetZ) {
        p = { x: side.targetX, z: side.targetZ };
      }
    }
    if (!p) p = { x: side.hero.x + side.hero.facingX * maxDist, z: side.hero.z + side.hero.facingZ * maxDist };
    // Clamp till arenan under duel (matchar server-side clamp)
    if (duelState.active) {
      const dx = p.x - 0, dz = p.z - 35;
      const d = Math.hypot(dx, dz);
      const maxR = 12 - 0.5;
      if (d > maxR) {
        p = { x: (dx / d) * maxR, z: 35 + (dz / d) * maxR };
      }
    }
    return p;
  }
  function showCircle(x, z, radius, color) {
    aimCircle.visible = true;
    aimCircle.position.set(x, 0.07, z);
    // Pulsande skala för synlighet
    const pulse = 1 + 0.06 * Math.sin(performance.now() * 0.008);
    aimCircle.scale.set(radius * pulse, radius * pulse, 1);
    aimCircle.traverse(o => { if (o.material && o.material.color) o.material.color.setHex(color); });
  }
  function showLine(dirX, dirZ, length) {
    aimLine.visible = true;
    aimLine.position.set(side.hero.x + dirX * (length / 2), 0.07, side.hero.z + dirZ * (length / 2));
    aimLine.rotation.y = -Math.atan2(dirZ, dirX);
    // Skala längden + lite pulserande bredd
    const pulse = 1 + 0.10 * Math.sin(performance.now() * 0.009);
    aimLine.scale.set(length / ELDKLOT_RANGE, pulse, 1);
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
    } else if (heroId === 'aragurn') {
      // Whirlwind — self-cast, visa damage-radien runt hero
      showCircle(side.hero.x, side.hero.z, WHIRLWIND_RADIUS, 0xffe399);
    } else {
      // Gandulf Wind Puff — cone framåt (push + debuff)
      showLine(dirX, dirZ, 5.5);
    }
  } else if (aimState.key === 'f') {
    if (heroId === 'legolas') {
      // Self-buff — visa ring runt hero
      showCircle(side.hero.x, side.hero.z, 1.2, 0xddff55);
    } else if (heroId === 'gimlu') {
      // Iron Will — visa explosionsradien runt hero
      showCircle(side.hero.x, side.hero.z, IRON_WILL_EXPLOSION_RADIUS, 0xff7733);
    } else if (heroId === 'aragurn') {
      // War Shout — cone framåt (line för aim)
      showLine(dirX, dirZ, SHOUT_LENGTH);
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
    } else if (heroId === 'aragurn') {
      // Heroic Leap — target-cirkel där hero landar
      const p = castGround(LEAP_MAX_DISTANCE);
      showCircle(p.x, p.z, LEAP_RADIUS, 0xff8844);
    } else {
      // Gandulf Black Hole — cirkel med blackhole-radien
      const p = castGround(BLACKHOLE_CAST_DISTANCE);
      showCircle(p.x, p.z, BLACKHOLE_RADIUS, 0x9966ff);
    }
  } else if (aimState.key === 'r') {
    // Ultimate-skills — siktning per hjälte
    if (heroId === 'legolas') {
      // Worldpiercer: jätte-pil med ~30m visuell sikt-linje i drag/facing-riktning
      showLine(dirX, dirZ, 30);
    } else if (heroId === 'magiker') {
      // Arcane Beam: lång laser-linje (visa 20m så strålens väg syns)
      showLine(dirX, dirZ, 20);
    } else if (heroId === 'gimlu') {
      // Berserker Rage: self-buff, visa rage-pulse-radien runt hero
      showCircle(side.hero.x, side.hero.z, RAGE_PULSE_RADIUS, 0xff4422);
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
  r: document.getElementById('skill-r'),
};
const ultFillEl = skillEls.r ? skillEls.r.querySelector('.ult-fill') : null;
const ultPctEl = skillEls.r ? skillEls.r.querySelector('.ult-pct') : null;

// SVG-ikoner per hero × skill — bild på vad skillen gör. Sätts via
// updateSkillIcons() vid match-start och hero-swap.
const SKILL_ICON_SVG = {
  magiker: {
    r: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="sk-mr-las" x1="0" y1="50%" x2="100%" y2="50%"><stop offset="0" stop-color="#ffffff"/><stop offset="0.5" stop-color="#88ccff"/><stop offset="1" stop-color="#3366ff"/></linearGradient></defs>
        <rect x="3" y="17" width="34" height="6" rx="2" fill="url(#sk-mr-las)" stroke="#225599" stroke-width="0.8"/>
        <circle cx="6" cy="20" r="4.5" fill="#ddeeff" opacity="0.85"/>
        <line x1="35" y1="14" x2="38" y2="11" stroke="#88ccff" stroke-width="2" stroke-linecap="round"/>
        <line x1="35" y1="26" x2="38" y2="29" stroke="#88ccff" stroke-width="2" stroke-linecap="round"/>
      </svg>`,
    q: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="sk-mq-fire" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stop-color="#ffcc00"/><stop offset="0.5" stop-color="#ff6622"/><stop offset="1" stop-color="#cc2200"/>
        </linearGradient></defs>
        <path d="M 20 35 Q 7 28 11 17 Q 12 24 17 21 Q 15 13 21 7 Q 22 15 25 13 Q 28 21 32 17 Q 33 28 20 35 Z" fill="url(#sk-mq-fire)" stroke="#aa3300" stroke-width="0.8"/>
        <path d="M 19 27 Q 16 24 17 20 Q 18 22 19 21 Q 18 17 20 14 Q 21 18 22 17 Q 23 22 21 25 Q 21 27 19 27 Z" fill="#ffee88" opacity="0.85"/>
      </svg>`,
    f: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <g stroke="#aaddff" stroke-width="2.4" stroke-linecap="round" fill="none">
          <line x1="20" y1="5" x2="20" y2="35"/>
          <line x1="7.5" y1="13" x2="32.5" y2="27"/>
          <line x1="7.5" y1="27" x2="32.5" y2="13"/>
          <path d="M 20 11 l -3 -2.5 M 20 11 l 3 -2.5 M 20 29 l -3 2.5 M 20 29 l 3 2.5"/>
          <path d="M 14 16 l -3 0.5 l 0.5 -3 M 26 24 l 3 -0.5 l -0.5 3 M 14 24 l -3 -0.5 l 0.5 3 M 26 16 l 3 0.5 l -0.5 -3"/>
        </g>
        <circle cx="20" cy="20" r="3" fill="#cceeff"/>
      </svg>`,
    e: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <defs><radialGradient id="sk-me-bh" cx="50%" cy="50%">
          <stop offset="0" stop-color="#000"/><stop offset="0.55" stop-color="#1a0033"/>
          <stop offset="0.85" stop-color="#5500aa"/><stop offset="1" stop-color="#9933ff"/>
        </radialGradient></defs>
        <circle cx="20" cy="20" r="15" fill="url(#sk-me-bh)"/>
        <path d="M 20 7 Q 32 12 30 22 Q 22 30 12 24" stroke="#cc88ff" stroke-width="1.6" fill="none" opacity="0.8"/>
        <path d="M 14 12 Q 22 14 24 22" stroke="#aa44ff" stroke-width="1.4" fill="none" opacity="0.6"/>
      </svg>`,
  },
  legolas: {
    r: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="sk-lr-arr" x1="0" y1="50%" x2="100%" y2="50%"><stop offset="0" stop-color="#ddff66"/><stop offset="1" stop-color="#66aa22"/></linearGradient></defs>
        <path d="M 4 20 L 30 20 L 30 13 L 38 20 L 30 27 L 30 20" fill="url(#sk-lr-arr)" stroke="#446a18" stroke-width="1.2"/>
        <line x1="2" y1="20" x2="6" y2="20" stroke="#bbff77" stroke-width="3" stroke-linecap="round"/>
      </svg>`,
    q: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <g stroke="#44aa44" stroke-width="2.4" stroke-linecap="round" fill="none">
          <path d="M 6 32 Q 14 22 20 28 Q 26 34 32 22"/>
          <path d="M 10 18 Q 16 10 22 16 Q 28 22 34 12"/>
        </g>
        <ellipse cx="14" cy="14" rx="3.5" ry="2.2" fill="#77dd55" transform="rotate(-30 14 14)" stroke="#33772a" stroke-width="0.8"/>
        <ellipse cx="27" cy="20" rx="3.5" ry="2.2" fill="#77dd55" transform="rotate(25 27 20)" stroke="#33772a" stroke-width="0.8"/>
        <ellipse cx="20" cy="26" rx="3" ry="2" fill="#88ee66" transform="rotate(10 20 26)" stroke="#3a8030" stroke-width="0.7"/>
      </svg>`,
    f: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <g stroke="#ddff55" stroke-width="2" fill="none">
          <circle cx="20" cy="20" r="13"/>
          <circle cx="20" cy="20" r="7.5"/>
          <line x1="20" y1="3" x2="20" y2="11"/>
          <line x1="20" y1="29" x2="20" y2="37"/>
          <line x1="3" y1="20" x2="11" y2="20"/>
          <line x1="29" y1="20" x2="37" y2="20"/>
        </g>
        <circle cx="20" cy="20" r="2.5" fill="#ddff55"/>
      </svg>`,
    e: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <g fill="none" stroke="#66ff88" stroke-linecap="round">
          <path d="M 11 20 L 28 20" stroke-width="4"/>
          <path d="M 22 12 L 30 20 L 22 28" stroke-width="3.5"/>
          <line x1="5" y1="12" x2="11" y2="12" stroke-width="2" opacity="0.55"/>
          <line x1="3" y1="20" x2="9" y2="20" stroke-width="2" opacity="0.35"/>
          <line x1="5" y1="28" x2="11" y2="28" stroke-width="2" opacity="0.55"/>
        </g>
      </svg>`,
  },
  aragurn: {
    q: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <g stroke="#ccd8e0" stroke-width="2.4" fill="none" stroke-linecap="round">
          <path d="M 20 4 Q 36 8 36 20 Q 36 32 20 36 Q 4 32 4 20 Q 4 8 20 4"/>
          <path d="M 20 10 Q 28 12 30 20 Q 28 28 20 30 Q 12 28 10 20 Q 12 12 20 10"/>
        </g>
        <path d="M 20 12 L 22 20 L 20 28 L 18 20 Z" fill="#dadcdf" stroke="#666" stroke-width="0.6"/>
        <circle cx="20" cy="20" r="1.6" fill="#ffd34a"/>
      </svg>`,
    f: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <path d="M 6 14 L 6 26 L 14 22 L 14 18 Z" fill="#ddc090" stroke="#553311" stroke-width="1"/>
        <g stroke="#ffe399" stroke-width="2" fill="none" stroke-linecap="round" opacity="0.85">
          <path d="M 16 20 L 22 20"/>
          <path d="M 16 14 L 24 12"/>
          <path d="M 16 26 L 24 28"/>
          <path d="M 24 20 L 32 20"/>
          <path d="M 24 12 L 30 8"/>
          <path d="M 24 28 L 30 32"/>
        </g>
      </svg>`,
    e: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <path d="M 8 32 Q 14 8 26 16 Q 30 22 32 30" stroke="#ffd34a" stroke-width="2.2" fill="none" stroke-dasharray="3 2" stroke-linecap="round"/>
        <circle cx="8" cy="32" r="2.4" fill="#88aaff"/>
        <circle cx="32" cy="30" r="3.5" fill="#ff7733" stroke="#aa3300" stroke-width="1"/>
        <circle cx="32" cy="30" r="6" fill="none" stroke="#ffaa55" stroke-width="1" opacity="0.6"/>
      </svg>`,
    r: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="sk-ar-blade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe6a0"/><stop offset="1" stop-color="#aa6622"/></linearGradient></defs>
        <path d="M 18 4 L 22 4 L 24 26 L 16 26 Z" fill="url(#sk-ar-blade)" stroke="#553311" stroke-width="0.8"/>
        <rect x="13" y="26" width="14" height="3" fill="#553311"/>
        <rect x="18" y="29" width="4" height="7" fill="#aa6622"/>
        <g stroke="#ff7733" stroke-width="1.4" fill="none" stroke-linecap="round" opacity="0.85">
          <path d="M 7 18 L 13 16"/>
          <path d="M 27 16 L 33 18"/>
          <path d="M 5 26 L 10 26"/>
          <path d="M 30 26 L 35 26"/>
        </g>
      </svg>`,
  },
  gimlu: {
    r: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <defs><radialGradient id="sk-gr-rage" cx="50%" cy="50%"><stop offset="0" stop-color="#ff4422"/><stop offset="0.7" stop-color="#cc2200"/><stop offset="1" stop-color="#660000"/></radialGradient></defs>
        <path d="M 20 4 L 24 14 L 35 16 L 27 24 L 30 35 L 20 28 L 10 35 L 13 24 L 5 16 L 16 14 Z" fill="url(#sk-gr-rage)" stroke="#aa0000" stroke-width="1"/>
        <circle cx="20" cy="22" r="3" fill="#fff" opacity="0.7"/>
      </svg>`,
    q: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <path d="M 6 17 L 18 14 L 18 26 L 6 23 Z" fill="#ffaa55" stroke="#cc6622" stroke-width="1"/>
        <path d="M 18 14 L 27 9 L 27 31 L 18 26 Z" fill="#cc7733" stroke="#883311" stroke-width="1"/>
        <rect x="3" y="18" width="4" height="4" fill="#553311"/>
        <g stroke="#ffd34a" stroke-width="2" fill="none" stroke-linecap="round">
          <path d="M 30 14 Q 34 20 30 26"/>
          <path d="M 34 11 Q 39 20 34 29"/>
        </g>
      </svg>`,
    f: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <path d="M 20 4 L 33 8 Q 33 24 20 36 Q 7 24 7 8 Z" fill="#aa6633" stroke="#ff8844" stroke-width="2"/>
        <path d="M 20 10 L 30 12 Q 30 22 20 31 Q 10 22 10 12 Z" fill="#cc8855" opacity="0.55"/>
        <path d="M 20 13 L 20 27 M 13 19 L 27 19" stroke="#ffd34a" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      </svg>`,
    e: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <rect x="6" y="13" width="16" height="14" rx="2" fill="#999" stroke="#444" stroke-width="1.5"/>
        <rect x="22" y="18.5" width="14" height="3" fill="#6a4020" stroke="#3a2410" stroke-width="0.8"/>
        <circle cx="33.5" cy="20" r="2.5" fill="#cc8844" stroke="#663300" stroke-width="0.8"/>
        <line x1="4" y1="10" x2="9" y2="14" stroke="#aaa" stroke-width="1.8" opacity="0.6"/>
        <line x1="4" y1="30" x2="9" y2="26" stroke="#aaa" stroke-width="1.8" opacity="0.6"/>
        <line x1="2" y1="20" x2="7" y2="20" stroke="#aaa" stroke-width="1.8" opacity="0.4"/>
        <path d="M 10 16 L 18 16 M 10 24 L 18 24" stroke="#666" stroke-width="0.8" opacity="0.7"/>
      </svg>`,
  },
};

function updateSkillIcons(heroId) {
  const set = SKILL_ICON_SVG[heroId] || SKILL_ICON_SVG.magiker;
  for (const k of ['q', 'f', 'e', 'r']) {
    const btn = skillEls[k];
    if (!btn) continue;
    const iconEl = btn.querySelector('.icon');
    if (iconEl) iconEl.innerHTML = set[k] || '';
  }
}

// ---- Skill-tooltip (långt tryck på en skill-knapp visar beskrivning) ----
const skillTooltipEl = document.getElementById('skill-tooltip');
const sttNameEl = skillTooltipEl ? skillTooltipEl.querySelector('.stt-name') : null;
const sttDescEl = skillTooltipEl ? skillTooltipEl.querySelector('.stt-desc') : null;
const skillTooltipState = {
  timer: null,
  shown: false,
  heldKey: null,
};
const SKILL_LONGPRESS_MS = 500;

function showSkillTooltip(key) {
  if (!skillTooltipEl) return;
  const side = sides[APP.localSide];
  const heroId = (side && side.heroId) || 'magiker';
  const info = HERO_INFO[heroId];
  if (!info || !info.skills || !info.skills[key]) return;
  const sd = info.skills[key];
  if (sttNameEl) sttNameEl.textContent = `${sd.icon || ''} ${sd.name || key.toUpperCase()}`;
  if (sttDescEl) sttDescEl.textContent = sd.desc || '';
  // Positionera ovanför skill-knappen
  const btn = skillEls[key];
  const r = btn.getBoundingClientRect();
  skillTooltipEl.classList.remove('hidden');
  // Mät tooltipens storlek efter att den blivit synlig
  requestAnimationFrame(() => {
    const tr = skillTooltipEl.getBoundingClientRect();
    let left = r.left + r.width / 2 - tr.width / 2;
    let top = r.top - tr.height - 12;
    // Klamra inom viewport
    left = Math.max(8, Math.min(window.innerWidth - tr.width - 8, left));
    if (top < 8) top = r.bottom + 12;
    skillTooltipEl.style.left = `${left}px`;
    skillTooltipEl.style.top = `${top}px`;
    skillTooltipEl.classList.add('visible');
  });
  skillTooltipState.shown = true;
  skillTooltipState.heldKey = key;
}

function hideSkillTooltip() {
  if (!skillTooltipEl) return;
  skillTooltipEl.classList.remove('visible');
  skillTooltipEl.classList.add('hidden');
  skillTooltipState.shown = false;
  skillTooltipState.heldKey = null;
}

function startSkillLongPress(key) {
  clearSkillLongPress();
  skillTooltipState.timer = setTimeout(() => {
    skillTooltipState.timer = null;
    showSkillTooltip(key);
  }, SKILL_LONGPRESS_MS);
}

function clearSkillLongPress() {
  if (skillTooltipState.timer) {
    clearTimeout(skillTooltipState.timer);
    skillTooltipState.timer = null;
  }
}

// Default-ikoner (magiker) vid module-load så knapparna aldrig är tomma
updateSkillIcons('magiker');

// ============================================================
// ARENA UI (HUD, prep-panel, end-overlay)
// ============================================================

const arenaRoundEl = document.getElementById('arena-round');
const arenaRoundTextEl = document.getElementById('arena-round-text');
const arenaScore1El = document.getElementById('arena-score-1');
const arenaScore2El = document.getElementById('arena-score-2');
const arenaPrepEl = document.getElementById('arena-prep');
const apTitleEl = document.getElementById('ap-title');
const apTimerEl = document.getElementById('ap-timer');
const apPointsEl = document.getElementById('ap-points');
const apOppStatusEl = document.getElementById('ap-opp-status');
const apTalentsGridEl = document.getElementById('ap-talents-grid');
const apItemsGridEl = document.getElementById('ap-items-grid');
const apGoldDisplayEl = document.getElementById('ap-gold-display');
const apReadyBtn = document.getElementById('ap-ready');
const arenaEndEl = document.getElementById('arena-end');
const aeTitleEl = document.getElementById('ae-title');
const aeInfoEl = document.getElementById('ae-info');
const aeContinueBtn = document.getElementById('ae-continue');

function showArenaPrep() {
  if (!arenaPrepEl) return;
  arenaPrepEl.classList.add('visible');
  renderTalentsGrid();
  renderArenaPrepItems();
  updateArenaPrepUI();
}

// Items-grid under prep: spelaren kan både välja talents OCH köpa items.
// Återanvänder befintliga ITEM_TYPES + shop-event-flödet (samma som klassisk
// shop-tap → applyEvent({ type: 'shop', kind: 'item', ... })).
function renderArenaPrepItems() {
  if (!apItemsGridEl) return;
  const side = sides[APP.localSide];
  if (!side) { apItemsGridEl.innerHTML = ''; return; }
  apItemsGridEl.innerHTML = '';
  const ownedById = new Map();
  for (const it of (side.inventory || [])) ownedById.set(it.itemId, it);
  for (const [itemId, def] of Object.entries(ITEM_TYPES)) {
    const existing = ownedById.get(itemId);
    const card = document.createElement('div');
    card.className = 'ap-item-card' + (existing ? ' owned' : '');
    const name = def.name || itemId;
    let cost, action;
    if (existing) {
      if (existing.level >= ITEM_MAX_LEVEL) { cost = 'MAX'; action = null; }
      else { cost = itemUpgradeCost(existing.level) + 'g'; action = 'upgrade'; }
    } else {
      cost = ITEM_BUY_COST + 'g';
      action = 'buy';
    }
    const lvlStr = existing ? `<span class="ai-level">Lvl ${existing.level}</span>` : '';
    card.innerHTML = `<div class="ai-name">${name}${lvlStr}</div><div class="ai-cost">${cost}</div>`;
    // Disabled om vi inte har råd eller inventory är full vid buy
    let disabled = false;
    if (action === 'buy') {
      if ((side.inventory || []).length >= INVENTORY_SLOTS) disabled = true;
      if (side.gold < ITEM_BUY_COST) disabled = true;
      // Items med varianter kan inte köpas direkt — kräver variant-val (skippa i prep-grid)
      if (def.variants) disabled = true;
    } else if (action === 'upgrade') {
      const c = itemUpgradeCost(existing.level);
      if (side.gold < c) disabled = true;
    }
    if (action === null) disabled = true;
    if (disabled) card.classList.add('disabled');
    if (!disabled && action) {
      card.addEventListener('click', () => {
        // Samma 'item' event hanterar både buy (inget existing) och upgrade
        sendOrApplyEvent({ type: 'shop', kind: 'item', item: itemId });
        // Re-render efter en kort delay så host hinner svara (eller direkt om solo/host)
        setTimeout(() => { renderArenaPrepItems(); updateArenaPrepUI(); }, 80);
      });
    }
    apItemsGridEl.appendChild(card);
  }
}
function hideArenaPrep() {
  if (arenaPrepEl) arenaPrepEl.classList.remove('visible');
}

const arenaCountdownEl = document.getElementById('arena-countdown');
const acTextEl = document.getElementById('ac-text');
function showArenaCountdown(text, isFight = false) {
  if (!arenaCountdownEl || !acTextEl) return;
  arenaCountdownEl.classList.remove('hidden');
  acTextEl.textContent = text;
  acTextEl.classList.toggle('fight', !!isFight);
  // Restart animation by forcing reflow
  acTextEl.style.animation = 'none';
  void acTextEl.offsetWidth;
  acTextEl.style.animation = '';
}
function hideArenaCountdown() {
  if (arenaCountdownEl) arenaCountdownEl.classList.add('hidden');
}
function showArenaEnd(winnerIdx, isMatchEnd) {
  if (!arenaEndEl) return;
  arenaEndEl.classList.add('visible');
  if (!aeTitleEl || !aeInfoEl) return;
  if (isMatchEnd) {
    if (winnerIdx === APP.localSide) {
      aeTitleEl.textContent = 'MATCH WON!';
      aeTitleEl.classList.add('win'); aeTitleEl.classList.remove('lose');
    } else if (winnerIdx > 0) {
      aeTitleEl.textContent = 'Match Lost';
      aeTitleEl.classList.add('lose'); aeTitleEl.classList.remove('win');
    } else {
      aeTitleEl.textContent = 'Match Draw';
      aeTitleEl.classList.remove('win', 'lose');
    }
    aeInfoEl.textContent = `Slutresultat: ${arenaState.wins[1]} – ${arenaState.wins[2]}`;
    if (aeContinueBtn) {
      aeContinueBtn.textContent = 'Tillbaka till lobby';
      aeContinueBtn.style.display = '';   // återställ — kan ha gömts av round-end
    }
  } else {
    if (winnerIdx === 0) {
      aeTitleEl.textContent = 'Draw';
      aeTitleEl.classList.remove('win', 'lose');
    } else if (winnerIdx === APP.localSide) {
      aeTitleEl.textContent = 'Round Won';
      aeTitleEl.classList.add('win'); aeTitleEl.classList.remove('lose');
    } else {
      aeTitleEl.textContent = 'Round Lost';
      aeTitleEl.classList.add('lose'); aeTitleEl.classList.remove('win');
    }
    aeInfoEl.textContent = `Score: ${arenaState.wins[1]} – ${arenaState.wins[2]} · nästa runda börjar...`;
    if (aeContinueBtn) aeContinueBtn.style.display = 'none';
  }
}
function hideArenaEnd() {
  if (arenaEndEl) arenaEndEl.classList.remove('visible');
  if (aeContinueBtn) aeContinueBtn.style.display = '';
}

function updateArenaHud() {
  if (!arenaRoundEl) return;
  if (APP.gameMode === 'arena1v1' && arenaState.phase !== 'idle') {
    arenaRoundEl.classList.remove('hidden');
    if (arenaRoundTextEl) arenaRoundTextEl.textContent = `Round ${arenaState.roundNum}`;
    if (arenaScore1El) arenaScore1El.textContent = String(arenaState.wins[1] || 0);
    if (arenaScore2El) arenaScore2El.textContent = String(arenaState.wins[2] || 0);
  } else {
    arenaRoundEl.classList.add('hidden');
  }
}

function updateArenaPrepUI() {
  if (!arenaPrepEl) return;
  const mapName = (ARENA_MAPS[arenaState.mapIdx || 0] || ARENA_MAPS[0]).name;
  if (apTitleEl) apTitleEl.textContent = `Round ${arenaState.roundNum} · ${mapName}`;
  if (apTimerEl) {
    apTimerEl.textContent = String(Math.ceil(arenaState.prepTimer));
    apTimerEl.classList.toggle('urgent', arenaState.prepTimer <= 10);
  }
  const localTalents = arenaState.talents[APP.localSide] || { points: 0, chosen: [] };
  if (apPointsEl) apPointsEl.textContent = String(localTalents.points);
  // Gold-display för items-grid
  if (apGoldDisplayEl) {
    const localSide = sides[APP.localSide];
    apGoldDisplayEl.textContent = localSide ? `${localSide.gold || 0}g` : '';
  }
  if (apOppStatusEl) {
    const otherIdx = 3 - APP.localSide;
    const opp = sides[otherIdx];
    const oppReady = arenaState.ready[otherIdx];
    let txt;
    if (!opp) txt = '· (Ingen motståndare)';
    else if (opp.isBot) txt = `· Bot (${(opp.botDifficulty || 'medium').toUpperCase()}) väntar`;
    else txt = oppReady ? '· Motståndaren är redo' : '· Motståndaren väljer talents...';
    apOppStatusEl.textContent = txt;
  }
  // Uppdatera ready-knappen
  if (apReadyBtn) {
    const myReady = arenaState.ready[APP.localSide];
    apReadyBtn.textContent = myReady ? 'Ready ✓' : 'Ready';
    apReadyBtn.classList.toggle('ready-confirmed', myReady);
  }
}

function renderTalentsGrid() {
  if (!apTalentsGridEl) return;
  const side = sides[APP.localSide];
  const heroId = (side && side.heroId) || 'magiker';
  const talents = ARENA_TALENTS[heroId] || [];
  apTalentsGridEl.innerHTML = '';
  const chosen = new Set(arenaState.talents[APP.localSide]?.chosen || []);
  const points = arenaState.talents[APP.localSide]?.points || 0;
  for (const t of talents) {
    const picked = chosen.has(t.id);
    const div = document.createElement('div');
    div.className = 'talent-card' + (picked ? ' picked' : (points <= 0 ? ' disabled' : ''));
    div.title = picked ? 'Klicka för att ångra' : (points > 0 ? 'Klicka för att välja' : 'Inga poäng kvar');
    div.innerHTML = `
      <div class="tc-icon">${t.icon || '✦'}</div>
      <div class="tc-name">${t.name}</div>
      <div class="tc-desc">${t.desc}</div>`;
    // Picked talents kan klickas för att ångras + refunda poäng. Disabled (inga
    // poäng + ej picked) gör inget.
    if (picked || points > 0) {
      div.addEventListener('click', () => onTalentPick(t.id));
    }
    apTalentsGridEl.appendChild(div);
  }
}

function onTalentPick(talentId) {
  const tStat = arenaState.talents[APP.localSide];
  if (!tStat) return;
  const idx = tStat.chosen.indexOf(talentId);
  let remove = false;
  if (idx >= 0) {
    // Ångra valet — refunda poäng
    tStat.chosen.splice(idx, 1);
    tStat.points += 1;
    remove = true;
  } else {
    if (tStat.points <= 0) return;
    tStat.chosen.push(talentId);
    tStat.points -= 1;
  }
  const side = sides[APP.localSide];
  if (side) recomputeArenaSideStats(side);
  renderTalentsGrid();
  updateArenaPrepUI();
  // Skicka till host om vi är klient
  if (isArenaMp() && APP.mode === 'client') {
    sendGameMsg({ t: 'a-talent', side: APP.localSide, talentId, remove });
  }
}

if (apReadyBtn) apReadyBtn.addEventListener('click', () => {
  const newVal = !arenaState.ready[APP.localSide];
  arenaState.ready[APP.localSide] = newVal;
  updateArenaPrepUI();
  if (isArenaMp() && APP.mode === 'client') {
    sendGameMsg({ t: 'a-ready', side: APP.localSide, value: newVal });
  }
});

if (aeContinueBtn) aeContinueBtn.addEventListener('click', () => {
  if (arenaState.phase === 'matchEnd') {
    hideArenaEnd();
    returnToLobby();
  }
});

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
// Max drag-distans i pixlar för full-range cast. Linjär skalning däremellan
// (0 px = under hero, full = max range).
const AIM_MAX_DRAG = 90;
const SKILL_AIMABLE = { q: true, e: true, f: true, r: true };

// ===== ARENA BOT (singleplayer) =====
// Driver sides[2] som AI när APP.arenaBot.active=true. 3 svårighetsgrader.
const BOT_PARAMS = {
  easy: {
    preferredRange: 5.0, minRange: 2.5, jitter: 0.45,
    strafeFreq: 0.5, aaInRange: 0.25,
    skillRatePerSec: 0.25,         // ~1 skill per 4s
    ultThreshold: 100, skillReactionMs: 800,
  },
  medium: {
    preferredRange: 4.0, minRange: 2.0, jitter: 0.18,
    strafeFreq: 0.9, aaInRange: 0.6,
    skillRatePerSec: 0.7,          // ~1 skill per 1.4s
    ultThreshold: 100, skillReactionMs: 350,
  },
  hard: {
    preferredRange: 3.2, minRange: 1.6, jitter: 0.05,
    strafeFreq: 1.4, aaInRange: 1.0,
    skillRatePerSec: 1.6,          // ~1 skill per 0.6s
    ultThreshold: 100, skillReactionMs: 120,
  },
};

function tickArenaBot(side, dt) {
  if (!side || side.hero.dead) return;
  const enemy = sides[3 - side.idx];
  if (!enemy) return;
  // Frusen/rotad/feared/tauntad: AI skippar input — befintliga CC-systemet styr movement
  if ((side.hero.frozenTime || 0) > 0) return;
  if ((side.heroFearTime || 0) > 0) return;
  if ((side.iceBlockRemaining || 0) > 0) return;
  const diff = side.botDifficulty || APP.arenaBot?.difficulty || 'medium';
  const p = BOT_PARAMS[diff] || BOT_PARAMS.medium;
  // Mål: enemy hero. Om enemy död → stå still nära mitten.
  let tx, tz, enemyAlive = !enemy.hero.dead;
  if (enemyAlive) { tx = enemy.hero.x; tz = enemy.hero.z; }
  else { tx = 0; tz = 35; }   // arena-mitt
  const dx = tx - side.hero.x, dz = tz - side.hero.z;
  const d = Math.hypot(dx, dz);
  // Decision-cache: undvik att spamma applyEvent varje frame
  side._botState = side._botState || { lastSkillMs: 0, lastAaMs: 0, strafePhase: Math.random() * Math.PI * 2 };
  const bs = side._botState;
  const nowMs = performance.now();
  // === MOVEMENT ===
  let moveX = 0, moveZ = 0;
  if (d > 0.05) {
    const nx = dx / d, nz = dz / d;
    if (d > p.preferredRange + 0.4) {
      moveX = nx; moveZ = nz;             // chase
    } else if (d < p.minRange) {
      moveX = -nx; moveZ = -nz;           // kite
    } else {
      // Strafa vinkelrätt
      const phase = Math.sin(nowMs * 0.001 * p.strafeFreq + bs.strafePhase);
      const side_ = phase > 0 ? 1 : -1;
      moveX = -nz * side_; moveZ = nx * side_;
    }
    // Jitter för easier-bot
    moveX += (Math.random() - 0.5) * p.jitter;
    moveZ += (Math.random() - 0.5) * p.jitter;
    const ml = Math.hypot(moveX, moveZ);
    if (ml > 0.01) { moveX /= ml; moveZ /= ml; }
  }
  applyMovement(side, moveX, moveZ, dt);
  // Vänd alltid mot fienden (för korrekt skill-aim)
  if (enemyAlive && d > 0.01) {
    side.hero.facingX = dx / d;
    side.hero.facingZ = dz / d;
  }
  // === AA ===
  const aaRange = side.attackRange || 4.0;
  if (enemyAlive && d <= aaRange + 0.5) {
    if (!side.aaActive && nowMs - bs.lastAaMs > 250) {
      applyEvent(side, { type: 'aa' });
      bs.lastAaMs = nowMs;
    }
  } else if (side.aaActive && d > aaRange + 2.0) {
    // Out of range — släpp AA
    applyEvent(side, { type: 'aa-cancel' });
  }
  // === SKILLS ===
  if (!side.skills || !enemyAlive) return;
  // Sannolikhet att casta skill: p.skillRatePerSec * dt
  if (Math.random() < p.skillRatePerSec * dt && nowMs - bs.lastSkillMs > p.skillReactionMs) {
    const candidates = [];
    for (const k of ['q', 'f', 'e']) {
      if (side.skills[k] && side.skills[k].cd <= 0) candidates.push(k);
    }
    if ((side.ultEnergy || 0) >= ULT_ENERGY_MAX) candidates.push('r');
    if (candidates.length === 0) return;
    const k = candidates[Math.floor(Math.random() * candidates.length)];
    const aimX = d > 0.01 ? dx / d : side.hero.facingX;
    const aimZ = d > 0.01 ? dz / d : side.hero.facingZ;
    // Sätt targetId/Type så tap-aim:ade skills (t.ex. Soul Drain) hittar opp-hero
    if (arenaState && arenaState.heroTargets) {
      const oppIdx = 3 - side.idx;
      if (!arenaState.heroTargets[oppIdx]) {
        arenaState.heroTargets[oppIdx] = {
          id: -200 + oppIdx, isArenaHero: true, sideIdx: oppIdx,
          get mesh() { return sides[this.sideIdx]?.mesh; },
        };
      }
      side.targetId = arenaState.heroTargets[oppIdx].id;
      side.targetType = 'arena-hero';
    }
    applyEvent(side, { type: 'skill', key: k, dx: aimX, dz: aimZ, tap: true });
    bs.lastSkillMs = nowMs;
  }
}

// Ult-energy: fills 0.5%/s passivt, +5% per skill-hit, +3% per AA-hit.
// Vid 100% kan hero casta sin ultimate (key='r').
const ULT_ENERGY_MAX = 100;
const ULT_GAIN_PASSIVE = 0.5;   // %/sek
const ULT_GAIN_SKILL_HIT = 5;
const ULT_GAIN_AA_HIT = 3;
const ULT_GAIN_SKILL_CAST_CAP = 10;     // Max gain per skill-cast (AoE-fix)
const ULT_LOCKOUT_AFTER_CAST = 5.0;     // Sek ingen gain efter ult-cast
const GIMLU_ULT_GAIN_ON_DMG_PCT = 0.05; // Gimlu tank-mekanik: 5% av damage taken
const GIMLU_ULT_GAIN_PER_HIT_CAP = 2;   // Max 2% per damage-instance

function gainUltEnergy(side, amount) {
  if (!side) return;
  if ((side._ultLockoutTime || 0) > 0) return;   // 5s lockout efter ult-cast
  side.ultEnergy = Math.min(ULT_ENERGY_MAX, (side.ultEnergy || 0) + amount);
}

// Skill-hit-gain med per-cast-cap. _ultCapThisCast reset:as när hero castar
// Q/F/E (i applyEvent skill-gren) så AoE-träffar inte fyller ult proportionellt.
function gainUltOnSkillHit(side) {
  if (!side || side.hero.dead) return;
  if ((side._ultLockoutTime || 0) > 0) return;
  const cap = (side._ultCapThisCast == null) ? 0 : side._ultCapThisCast;
  if (cap <= 0) return;
  const amt = Math.min(ULT_GAIN_SKILL_HIT, cap);
  side._ultCapThisCast = cap - amt;
  side.ultEnergy = Math.min(ULT_ENERGY_MAX, (side.ultEnergy || 0) + amt);
}

// Dispatchar ULT-cast per hero. Konsumerar 100% energy och kallar
// rätt host-fn.
function hostCastUlt(side, dx, dz) {
  if (!side || side.hero.dead) return;
  if ((side.ultEnergy || 0) < ULT_ENERGY_MAX) return;
  // Förhindra dubbel-cast för alla heroes
  if (side.laserBeam || (side.rageRemaining || 0) > 0 || (side.legolusUltBuff || 0) > 0 || (side.berserkRemaining || 0) > 0) return;
  side.ultEnergy = 0;
  const heroId = side.heroId || 'magiker';
  if (heroId === 'magiker') hostCastMagikerUlt(side, dx, dz);
  else if (heroId === 'legolas') hostCastLegolasUlt(side, dx, dz);
  else if (heroId === 'gimlu') hostCastGimluUlt(side);
  else if (heroId === 'aragurn') hostCastAragurnUlt(side);
}

// Tick:ar pågående ultimates (laser-tick, rage-tick, etc).
// Per-hero ult-funktioner implementeras nedan i sina respektive sektioner.
function tickUltimates(side, dt) {
  if (side.laserBeam) tickMagikerLaser(side, dt);
  if (side.soulDrain) tickSoulDrain(side, dt);
  if (side.soulExplosions && side.soulExplosions.length) tickSoulExplosions(side, dt);
  if ((side.rageRemaining || 0) > 0) tickGimluRage(side, dt);
  if ((side.legolusUltBuff || 0) > 0) {
    side.legolusUltBuff = Math.max(0, side.legolusUltBuff - dt);
  }
  if ((side.whirlwindRemaining || 0) > 0) tickAragurnWhirlwind(side, dt);
  if (side.aragurnLeap) tickAragurnLeap(side, dt);
  if ((side.berserkRemaining || 0) > 0) tickAragurnBerserk(side, dt);
  if ((side.aragurnShoutBuff || 0) > 0) side.aragurnShoutBuff = Math.max(0, side.aragurnShoutBuff - dt);
  if ((side.aragurnAllyShoutBuff || 0) > 0) side.aragurnAllyShoutBuff = Math.max(0, side.aragurnAllyShoutBuff - dt);
  if ((side.aragurnShoutDebuff || 0) > 0) side.aragurnShoutDebuff = Math.max(0, side.aragurnShoutDebuff - dt);
  // War Shout HoT: tickar HP varje frame medan timern är aktiv
  if ((side.aragurnShoutHealRemaining || 0) > 0 && !side.hero.dead) {
    const healAmt = side.hero.maxHp * (side.aragurnShoutHealPct || 0) * dt;
    if (healAmt > 0 && side.hero.hp < side.hero.maxHp) {
      side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + healAmt);
    }
    side.aragurnShoutHealRemaining = Math.max(0, side.aragurnShoutHealRemaining - dt);
    if (side.aragurnShoutHealRemaining <= 0) side.aragurnShoutHealPct = 0;
  }
}

// === Magiker ult: Laser Beam ===
const LASER_DURATION = 3.0;
const LASER_TURN_RATE = 4.5;       // rad/s — hur snabbt strålen kan svänga med facing
const LASER_TICK_INTERVAL = 0.5;
const LASER_TICK_DMG_PCT = 0.15;    // 15% av target maxHP per tick = 90% över 3s
const LASER_RANGE = 60;             // jätte långt
const LASER_WIDTH = 2.2;            // perpendicular bredd för träff
const LASER_DR_MUL = 0.10;          // 90% DR

function hostCastMagikerUlt(side, dx, dz) {
  if (side.hero.dead) return;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) { dx = side.hero.facingX; dz = side.hero.facingZ; }
  else { dx /= len; dz /= len; }
  // Visuell laser-stråle — flera lager för pop. Origo i hero, mittpunkt LASER_RANGE/2 framåt.
  // Yttre halo (mjuk blå, semi-transparent, brett)
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0x66bbff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
  });
  const halo = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, LASER_RANGE, 18, 1, false), haloMat);
  halo.rotation.order = 'YXZ';
  halo.rotation.y = Math.atan2(dx, dz);
  halo.rotation.x = Math.PI / 2;
  halo.position.set(side.hero.x + dx * LASER_RANGE / 2, 1.0, side.hero.z + dz * LASER_RANGE / 2);
  scene.add(halo);
  // Mellanlager (ljusare blå)
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xccddff, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, LASER_RANGE, 18, 1, false), beamMat);
  beam.rotation.copy(halo.rotation);
  beam.position.copy(halo.position);
  scene.add(beam);
  // Inre kärna (vit, brännhet, smalare men tjockare än innan)
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.98 });
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, LASER_RANGE, 16, 1, false), coreMat);
  core.rotation.copy(halo.rotation);
  core.position.copy(halo.position);
  scene.add(core);
  side.laserBeam = {
    remaining: LASER_DURATION,
    dx, dz,
    tickAccum: 0,
    mesh: beam,
    halo,
    core,
  };
  // Visuell start-effekt
  spawnSkillCastFx(side.hero.x, side.hero.z, 0x88ccff, 2.0);
  spawnShieldBurstFx(side.hero.x, side.hero.z, 0xaaddff);
  triggerCameraShake(0.30, 0.35);
  // Initial tick direkt — laser ska börja skada omedelbart (6 ticks under 3s, varannan 0.5s)
  applyLaserBeamTick(side);
}

function tickMagikerLaser(side, dt) {
  const lb = side.laserBeam;
  if (!lb) return;
  lb.remaining -= dt;
  lb.tickAccum += dt;
  // Styrning: laser-riktningen svänger mot hero-facing med LASER_TURN_RATE rad/s
  const desiredAng = Math.atan2(side.hero.facingX, side.hero.facingZ);
  const curAng = Math.atan2(lb.dx, lb.dz);
  let delta = desiredAng - curAng;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const maxStep = LASER_TURN_RATE * dt;
  const step = Math.max(-maxStep, Math.min(maxStep, delta));
  const newAng = curAng + step;
  lb.dx = Math.sin(newAng);
  lb.dz = Math.cos(newAng);
  // Synka beam-position + rotation med hero (hero kan röra sig fritt under cast + styra)
  const cx = side.hero.x + lb.dx * LASER_RANGE / 2;
  const cz = side.hero.z + lb.dz * LASER_RANGE / 2;
  for (const m of [lb.mesh, lb.core, lb.halo]) {
    if (!m) continue;
    m.position.set(cx, 1.0, cz);
    m.rotation.y = newAng;
  }
  // CC-immunitet: nollställ alla cc-tillstånd varje frame
  side.hero.frozenTime = 0;
  side.hero.tauntedTime = 0;
  side.hero.dotRemaining = 0;
  side.hero.poisonRemaining = 0;
  side.heroFearTime = 0;
  side.heroSlowTime = 0;
  side.heroSlowMul = 1;
  // Skada-tick var 0.5s
  while (lb.tickAccum >= LASER_TICK_INTERVAL && lb.remaining > -LASER_TICK_INTERVAL) {
    lb.tickAccum -= LASER_TICK_INTERVAL;
    applyLaserBeamTick(side);
  }
  if (lb.remaining <= 0) {
    for (const m of [lb.mesh, lb.core, lb.halo]) {
      if (!m) continue;
      scene.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose();
    }
    side.laserBeam = null;
  }
}

function applyLaserBeamTick(side) {
  const lb = side.laserBeam;
  if (!lb) return;
  const opp = sides[3 - side.idx];
  const ox = side.hero.x, oz = side.hero.z;
  const { dx, dz } = lb;
  const inBeam = (ex, ez) => {
    const ddx = ex - ox, ddz = ez - oz;
    const along = ddx * dx + ddz * dz;
    if (along < 0 || along > LASER_RANGE) return false;
    const perp = Math.abs(ddx * (-dz) + ddz * dx);
    return perp < LASER_WIDTH;
  };
  // Monsters (ult-damage ger INTE ult-energy)
  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    if (inBeam(m.mesh.position.x, m.mesh.position.z)) {
      const dmg = (m.maxHp || m.hp) * LASER_TICK_DMG_PCT * bossWarsPctScale(m);
      m.hp -= dmg;
      spawnHitSparkFx(m.mesh.position.x, 1.2, m.mesh.position.z, 0xaaddff);
      if (m.hp <= 0) hostKillMonster(side, i, side);
    }
  }
  // Opp creeps (ult-damage ger INTE ult-energy)
  if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
    const c = opp.playerCreeps[i];
    if (inBeam(c.mesh.position.x, c.mesh.position.z)) {
      const dmg = (c.maxHp || c.hp) * LASER_TICK_DMG_PCT;
      c.hp -= dmg;
      spawnHitSparkFx(c.mesh.position.x, 1.2, c.mesh.position.z, 0xaaddff);
      if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(i, 1); }
    }
  }
  // Arena orb
  if (APP.gameMode === 'arena1v1' && arenaState.orb.alive) {
    if (inBeam(ARENA_CFG.orb.x, ARENA_CFG.orb.z)) {
      damageArenaOrb(arenaState.orb.maxHp * LASER_TICK_DMG_PCT, side.idx);
    }
  }
  // Arena opp hero
  if (APP.gameMode === 'arena1v1' && opp && !opp.hero.dead) {
    if (inBeam(opp.hero.x, opp.hero.z)) {
      damageHero(opp, opp.hero.maxHp * LASER_TICK_DMG_PCT);
      spawnHitSparkFx(opp.hero.x, 1.0, opp.hero.z, 0xaaddff);
    }
  }
}

// === Legolas ult: Shadow Volley (invis + empowered next-AA + thorn pool) ===
const LEGOLUS_INVIS_DURATION = 5.0;
const LEGOLUS_INVIS_SPEED_BONUS = 0.20;
const LEGOLUS_ULT_AA_STUN_DUR = 1.5;
const LEGOLUS_ULT_AA_STUN_RADIUS = 2.5;
const LEGOLUS_THORN_POOL_DURATION = 3.0;
const LEGOLUS_THORN_POOL_TICK = 0.5;
const LEGOLUS_THORN_POOL_DMG_PCT = 0.05;
const LEGOLUS_THORN_POOL_RADIUS = 2.5;
// Gamla Worldpiercer-konstanter — funktionerna nedan (_legacyHostCastLegolasUlt_UNUSED,
// tickBigArrows, onLegolasUltHit, disposeArrowMesh) kallas aldrig längre eftersom
// hostCastLegolasUlt inte spawnar bigArrows. Konstanter behövs för att kodgraf
// ska parsa (death code). side.legolusUltBuff sätts aldrig — alltid 0.
const ULT_ARROW_SPEED = 38;
const ULT_ARROW_MAX_RANGE = 200;
const ULT_ARROW_LENGTH = 5.5;
const ULT_ARROW_HIT_RADIUS = 1.8;
const ULT_ARROW_STUN_DURATION = 1.0;
const ULT_ARROW_TRAIL_INTERVAL = 0.025;
const LEGOLUS_ULT_BUFF_DURATION = 5.0;
const LEGOLUS_ULT_AS_BONUS = 0.30;

// Shadow Volley cast: invis 5s + +20% movespeed + empowered next-AA pending.
// Pilen är vanlig AA-projektil men dmg=25%maxHp, stun nearby, lämnar thorn pool.
function hostCastLegolasUlt(side, dx, dz) {
  if (side.hero.dead) return;
  side.legolusInvisRemaining = LEGOLUS_INVIS_DURATION;
  side.legolusUltAaPending = true;
  spawnSkillCastFx(side.hero.x, side.hero.z, 0x44aa66, 1.6);
  spawnShieldBurstFx(side.hero.x, side.hero.z, 0x44aa66);
  triggerCameraShake(0.15, 0.20);
}

// Spawnar en visuell thorn pool på (x,z) och tickar damage 5%maxHp/0.5s i 3s.
// Server broadcastar TP via snap för line wars; denna används bara i solo/arena/boss.
function spawnClientLocalThornPool(side, x, z) {
  const grp = new THREE.Group();
  const r = LEGOLUS_THORN_POOL_RADIUS;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(r * 0.85, r, 36),
    new THREE.MeshBasicMaterial({ color: 0x4a8030, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.08;
  grp.add(ring);
  const inner = new THREE.Mesh(
    new THREE.CircleGeometry(r * 0.83, 28),
    new THREE.MeshBasicMaterial({ color: 0x2a4818, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
  );
  inner.rotation.x = -Math.PI / 2; inner.position.y = 0.06;
  grp.add(inner);
  for (let i = 0; i < 10; i++) {
    const ang = (i / 10) * Math.PI * 2;
    const rad = r * (0.3 + Math.random() * 0.4);
    const sp = new THREE.Mesh(
      new THREE.ConeGeometry(0.10, 0.42, 6),
      new THREE.MeshStandardMaterial({ color: 0x224410, roughness: 0.75 })
    );
    sp.position.set(Math.cos(ang) * rad, 0.20, Math.sin(ang) * rad);
    sp.rotation.x = (Math.random() - 0.5) * 0.3;
    grp.add(sp);
  }
  grp.position.set(x, 0, z);
  scene.add(grp);
  side.thornPoolsLocal = side.thornPoolsLocal || [];
  side.thornPoolsLocal.push({
    mesh: grp, ring, inner, x, z,
    radius: r, remaining: LEGOLUS_THORN_POOL_DURATION,
    duration: LEGOLUS_THORN_POOL_DURATION,
    tickAccum: 0, dmgPct: LEGOLUS_THORN_POOL_DMG_PCT,
  });
}

// Tickar lokala thorn pools i solo/arena/boss (line wars använder server-state TP).
function tickClientThornPools(side, dt) {
  if (!side.thornPoolsLocal || side.thornPoolsLocal.length === 0) return;
  const opp = sides[3 - side.idx];
  for (let i = side.thornPoolsLocal.length - 1; i >= 0; i--) {
    const p = side.thornPoolsLocal[i];
    p.remaining -= dt;
    p.tickAccum += dt;
    while (p.tickAccum >= LEGOLUS_THORN_POOL_TICK && p.remaining > -LEGOLUS_THORN_POOL_TICK) {
      p.tickAccum -= LEGOLUS_THORN_POOL_TICK;
      for (let k = side.monsters.length - 1; k >= 0; k--) {
        const m = side.monsters[k];
        if (Math.hypot(m.mesh.position.x - p.x, m.mesh.position.z - p.z) < p.radius) {
          const dmg = (m.maxHp || m.hp) * p.dmgPct;
          m.hp -= dmg;
          if (m.hp <= 0) hostKillMonster(side, k, side);
        }
      }
      if (opp) for (let k = opp.playerCreeps.length - 1; k >= 0; k--) {
        const c = opp.playerCreeps[k];
        if (Math.hypot(c.mesh.position.x - p.x, c.mesh.position.z - p.z) < p.radius) {
          const dmg = (c.maxHp || c.hp) * p.dmgPct;
          c.hp -= dmg;
          if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(k, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
        }
      }
      if (opp && !opp.hero.dead && Math.hypot(opp.hero.x - p.x, opp.hero.z - p.z) < p.radius) {
        damageHero(opp, opp.hero.maxHp * p.dmgPct);
      }
    }
    const lifeR = Math.max(0, p.remaining / p.duration);
    if (p.ring && p.ring.material) p.ring.material.opacity = 0.70 * lifeR;
    if (p.inner && p.inner.material) p.inner.material.opacity = 0.45 * lifeR;
    if (p.remaining <= 0) { scene.remove(p.mesh); side.thornPoolsLocal.splice(i, 1); }
  }
}

// Tickar Shadow Volley invis-timer (solo/arena/boss). Vid 0 reveal + cancel aaPending.
function tickClientLegolusInvis(side, dt) {
  if ((side.legolusInvisRemaining || 0) <= 0) return;
  side.legolusInvisRemaining = Math.max(0, side.legolusInvisRemaining - dt);
  if (side.legolusInvisRemaining <= 0) {
    side.legolusUltAaPending = false;
  }
}

// Dead (Worldpiercer-pilen) — behållen som no-op-stub om något annat anropar funktionen.
function _legacyHostCastLegolasUlt_UNUSED(side, dx, dz) {
  if (side.hero.dead) return;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) { dx = side.hero.facingX; dz = side.hero.facingZ; }
  else { dx /= len; dz /= len; }
  // Stor pil-mesh — natur-magi: gyllene skaft, glödande tip, fjädrar + halo + roterande blad. +Z = framåt.
  const grp = new THREE.Group();
  // Skaft (silver-gult trä, lite glowing)
  const shaftMat = new THREE.MeshStandardMaterial({
    color: 0x8a6028, roughness: 0.45, emissive: 0xaaff55, emissiveIntensity: 0.7, metalness: 0.3,
  });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, ULT_ARROW_LENGTH, 14), shaftMat);
  shaft.rotation.x = Math.PI / 2;
  grp.add(shaft);
  // Tipp (kristallin grön, kraftigt glow)
  const tipMat = new THREE.MeshStandardMaterial({
    color: 0xddff88, emissive: 0xaaff55, emissiveIntensity: 2.0, metalness: 0.6, roughness: 0.2,
  });
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.8, 14), tipMat);
  tip.rotation.x = Math.PI / 2;
  tip.position.z = ULT_ARROW_LENGTH / 2 + 0.85;
  grp.add(tip);
  // Yttre halo runt pilen (semi-transparent grön cylinder)
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0x88ff44, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false,
  });
  const halo = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, ULT_ARROW_LENGTH + 1.0, 16), haloMat);
  halo.rotation.x = Math.PI / 2;
  grp.add(halo);
  // Vingar (4 fjädrar, större)
  const featherMat = new THREE.MeshBasicMaterial({ color: 0xccff88, transparent: true, opacity: 0.92, side: THREE.DoubleSide });
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2;
    const feather = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 1.1), featherMat);
    feather.position.set(Math.cos(ang) * 0.28, Math.sin(ang) * 0.28, -ULT_ARROW_LENGTH / 2 + 0.6);
    feather.rotation.z = ang;
    grp.add(feather);
  }
  // Roterande blad-ring vid spetsen (3 löv som orbiterar)
  const leafGroup = new THREE.Group();
  leafGroup.position.z = ULT_ARROW_LENGTH / 2 + 0.4;
  const leafMat = new THREE.MeshBasicMaterial({ color: 0x66dd33, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  for (let i = 0; i < 3; i++) {
    const ang = (i / 3) * Math.PI * 2;
    const leaf = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.9), leafMat);
    leaf.position.set(Math.cos(ang) * 0.9, Math.sin(ang) * 0.9, 0);
    leaf.rotation.z = ang + Math.PI / 2;
    leafGroup.add(leaf);
  }
  grp.add(leafGroup);
  // Glow-light som följer med
  const glow = new THREE.PointLight(0xaaff55, 2.4, 6);
  glow.position.z = ULT_ARROW_LENGTH / 2;
  grp.add(glow);
  // Orientation: +Z framåt → atan2(dx, dz) (samma som hero-facing)
  grp.rotation.y = Math.atan2(dx, dz);
  grp.position.set(side.hero.x, 1.0, side.hero.z);
  scene.add(grp);
  side.bigArrows = side.bigArrows || [];
  side.bigArrows.push({
    mesh: grp,
    dx, dz,
    traveled: 0,
    maxRange: ULT_ARROW_MAX_RANGE,
    leafGroup,
    trailAccum: 0,
  });
  spawnSkillCastFx(side.hero.x, side.hero.z, 0x88ff44, 1.8);
  spawnShieldBurstFx(side.hero.x, side.hero.z, 0xaaff66);
  triggerCameraShake(0.18, 0.25);
}

function tickBigArrows(side, dt) {
  if (!side.bigArrows || side.bigArrows.length === 0) return;
  const opp = sides[3 - side.idx];
  for (let i = side.bigArrows.length - 1; i >= 0; i--) {
    const arr = side.bigArrows[i];
    const step = ULT_ARROW_SPEED * dt;
    arr.mesh.position.x += arr.dx * step;
    arr.mesh.position.z += arr.dz * step;
    arr.traveled += step;
    // Roterande visuell rolling + orbiterande löv
    arr.mesh.rotation.z = (arr.mesh.rotation.z || 0) + dt * 8;
    if (arr.leafGroup) arr.leafGroup.rotation.z = (arr.leafGroup.rotation.z || 0) + dt * 6;
    // Nature-magic trail: gröna gnistor + virvlande löv bakom pilen
    arr.trailAccum = (arr.trailAccum || 0) + dt;
    while (arr.trailAccum >= ULT_ARROW_TRAIL_INTERVAL) {
      arr.trailAccum -= ULT_ARROW_TRAIL_INTERVAL;
      const tx = arr.mesh.position.x - arr.dx * (ULT_ARROW_LENGTH * 0.5 + Math.random() * 1.2);
      const ty = 1.0 + (Math.random() - 0.5) * 0.5;
      const tz = arr.mesh.position.z - arr.dz * (ULT_ARROW_LENGTH * 0.5 + Math.random() * 1.2);
      const color = Math.random() < 0.5 ? 0x88ff44 : 0xccff88;
      spawnProjectileTrailPuff(tx + (Math.random() - 0.5) * 0.4, ty, tz + (Math.random() - 0.5) * 0.4, color);
    }
    // localOnly = client-prediktion i arena MP: ingen hit-detection (host gör det),
    // ta bara bort pilen när max-range nås eller efter ~5s.
    if (arr.localOnly) {
      if (arr.traveled > arr.maxRange) {
        disposeArrowMesh(arr.mesh);
        side.bigArrows.splice(i, 1);
      }
      continue;
    }
    let hit = null;
    // Opp hero (arena)
    if (APP.gameMode === 'arena1v1' && opp && !opp.hero.dead) {
      const d = Math.hypot(opp.hero.x - arr.mesh.position.x, opp.hero.z - arr.mesh.position.z);
      if (d < ULT_ARROW_HIT_RADIUS) hit = { kind: 'oppHero', target: opp };
    }
    // Bosses (i classic-mode side.monsters med isBoss=true)
    if (!hit) {
      for (const m of side.monsters) {
        if (!m.isBoss) continue;
        const d = Math.hypot(m.mesh.position.x - arr.mesh.position.x, m.mesh.position.z - arr.mesh.position.z);
        if (d < ULT_ARROW_HIT_RADIUS + 1.0) { hit = { kind: 'boss', target: m }; break; }
      }
    }
    if (hit) {
      onLegolasUltHit(side, hit, arr);
      disposeArrowMesh(arr.mesh);
      side.bigArrows.splice(i, 1);
      continue;
    }
    if (arr.traveled > arr.maxRange) {
      disposeArrowMesh(arr.mesh);
      side.bigArrows.splice(i, 1);
    }
  }
}

// Disposar geometry + material för en arrow-grupp innan scene.remove
function disposeArrowMesh(grp) {
  if (!grp) return;
  grp.traverse(o => {
    if (o.isMesh) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
        else o.material.dispose();
      }
    }
  });
  scene.remove(grp);
}

function onLegolasUltHit(side, hit, arr) {
  let tx, tz;
  if (hit.kind === 'oppHero') {
    tx = hit.target.hero.x; tz = hit.target.hero.z;
  } else {
    tx = hit.target.mesh.position.x; tz = hit.target.mesh.position.z;
  }
  // Teleport caster — backa ~1.5m längs arrow-riktningen så vi inte överlappar
  const newX = tx - arr.dx * 1.5;
  const newZ = tz - arr.dz * 1.5;
  side.hero.x = newX;
  side.hero.z = newZ;
  if (side.mesh) {
    side.mesh.position.set(newX, 0, newZ);
    side.mesh.rotation.y = Math.atan2(arr.dx, arr.dz);
  }
  // 30% AS buff i 5s
  side.legolusUltBuff = LEGOLUS_ULT_BUFF_DURATION;
  // Stun target i 1s
  if (hit.kind === 'oppHero') {
    hit.target.heroFearTime = Math.max(hit.target.heroFearTime || 0, ULT_ARROW_STUN_DURATION);
  } else {
    hit.target.frozenTime = Math.max(hit.target.frozenTime || 0, ULT_ARROW_STUN_DURATION);
  }
  spawnSkillCastFx(newX, newZ, 0xddff44, 2.0);
  triggerCameraShake(0.35, 0.4);
}

// === Gimlu ult: Rage ===
const RAGE_DURATION = 5.0;
const RAGE_TICK_INTERVAL = 0.5;
const RAGE_PULSE_RADIUS = 4.5;
const RAGE_PULSE_DMG_PCT = 0.035;    // 3.5% maxHP per 0.5s (nerf -30%)
const RAGE_DR_MUL = 0.50;             // 50% DR
const RAGE_HEAL_PCT = 0.20;           // 20% lifesteal från all skada utdelad
const RAGE_SCALE = 2.0;

function hostCastGimluUlt(side) {
  if (side.hero.dead) return;
  side.rageRemaining = RAGE_DURATION;
  side.rageTickAccum = 0;
  if (side.mesh) side.mesh.scale.set(RAGE_SCALE, RAGE_SCALE, RAGE_SCALE);
  spawnSkillCastFx(side.hero.x, side.hero.z, 0xff4422, 2.2);
  spawnShieldBurstFx(side.hero.x, side.hero.z, 0xff6633);
  triggerCameraShake(0.45, 0.5);
}

function tickGimluRage(side, dt) {
  side.rageRemaining -= dt;
  side.rageTickAccum += dt;
  // CC-immune: nollställ alla cc-states
  side.hero.frozenTime = 0;
  side.hero.tauntedTime = 0;
  side.heroFearTime = 0;
  side.heroSlowTime = 0;
  side.heroSlowMul = 1;
  // Pulse-damage var 0.5s (max 10 pulser över 5s)
  while (side.rageTickAccum >= RAGE_TICK_INTERVAL && side.rageRemaining > 0) {
    side.rageTickAccum -= RAGE_TICK_INTERVAL;
    applyRagePulse(side);
  }
  if (side.rageRemaining <= 0) {
    side.rageRemaining = 0;
    if (side.mesh) side.mesh.scale.set(1, 1, 1);
  }
}

function applyRagePulse(side) {
  const ox = side.hero.x, oz = side.hero.z;
  const opp = sides[3 - side.idx];
  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    const d = Math.hypot(m.mesh.position.x - ox, m.mesh.position.z - oz);
    if (d < RAGE_PULSE_RADIUS) {
      const dmg = (m.maxHp || m.hp) * RAGE_PULSE_DMG_PCT * bossWarsPctScale(m);
      const dealt = Math.min(dmg, m.hp);
      m.hp -= dmg;
      applyRageLifesteal(side, dealt);
      // Ult-damage ger INTE ult-energy
      if (m.hp <= 0) hostKillMonster(side, i, side);
    }
  }
  if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
    const c = opp.playerCreeps[i];
    const d = Math.hypot(c.mesh.position.x - ox, c.mesh.position.z - oz);
    if (d < RAGE_PULSE_RADIUS) {
      const dmg = (c.maxHp || c.hp) * RAGE_PULSE_DMG_PCT;
      const dealt = Math.min(dmg, c.hp);
      c.hp -= dmg;
      applyRageLifesteal(side, dealt);
      if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(i, 1); }
    }
  }
  if (APP.gameMode === 'arena1v1' && arenaState.orb.alive) {
    const d = Math.hypot(ARENA_CFG.orb.x - ox, ARENA_CFG.orb.z - oz);
    if (d < RAGE_PULSE_RADIUS) {
      const dmg = arenaState.orb.maxHp * RAGE_PULSE_DMG_PCT;
      const dealt = Math.min(dmg, arenaState.orb.hp);
      damageArenaOrb(dmg, side.idx);
      applyRageLifesteal(side, dealt);
    }
  }
  if (APP.gameMode === 'arena1v1' && opp && !opp.hero.dead) {
    const d = Math.hypot(opp.hero.x - ox, opp.hero.z - oz);
    if (d < RAGE_PULSE_RADIUS) {
      const dmg = opp.hero.maxHp * RAGE_PULSE_DMG_PCT;
      const dealt = Math.min(dmg, opp.hero.hp);
      damageHero(opp, dmg);
      applyRageLifesteal(side, dealt);
    }
  }
  spawnShieldBurstFx(ox, oz, 0xff6633);
}

function applyRageLifesteal(side, dmgDealt) {
  if ((side.rageRemaining || 0) <= 0 || dmgDealt <= 0 || side.hero.dead) return;
  side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + dmgDealt * RAGE_HEAL_PCT);
}

// ============================================================
// ARAGURN — Warrior med STORT svärd
// ============================================================
// Q: Whirlwind — 3s spin, AoE-tick 5% maxHP per 0.5s, CC-immun + +20% MS
// F: War Shout — kon-framåt, slowar/debuffar fiender, buffar allierade
// E: Hero Leap — 1s mark-targetad leap, AoE-stun + heal per träffad
// R: Berserk Form — 5s, -50% AS, +150% AA dmg, 100% cleave
// Passive: per % HP lost → +0.5% skill+AA dmg

const WHIRLWIND_DURATION = 3.0;
const WHIRLWIND_TICK = 0.5;
const WHIRLWIND_RADIUS = 3.0;
const WHIRLWIND_DMG_PCT = 0.075;     // var 0.05 — buff till 7.5% per 0.5s
const WHIRLWIND_MS_BUFF = 0.20;
const SHOUT_LENGTH = 8.0;
const SHOUT_HALF_ANGLE = Math.PI / 3;      // 60° halv-vinkel = 120° kon (vidare)
const SHOUT_DIRECT_DMG_PCT = 0.15;          // 15% av targets max-HP
const SHOUT_DEBUFF_DURATION = 4.0;
const SHOUT_DEBUFF_DMG_TAKEN = 0.20;        // tar 20% mer skada
const SHOUT_SLOW_DURATION = 3.0;
const SHOUT_SLOW_MUL = 0.80;                // 20% slow
const SHOUT_ALLY_BUFF_DURATION = 4.0;
const SHOUT_BUFF_DR = 0.20;                 // 20% damage reduction
const SHOUT_BUFF_MS = 0.20;                 // 20% movement speed (bara allierade)
const SHOUT_BUFF_RADIUS = 6.0;              // cirkel runt Aragurn för buff (skild från damage-konen)
const SHOUT_HEAL_DURATION = 2.0;            // HoT i sek
const SHOUT_HEAL_SELF_PCT = 0.10;           // Aragurn: 10% maxHP / sek
const SHOUT_HEAL_ALLY_PCT = 0.05;           // ally: 5% maxHP / sek
const LEAP_TRAVEL_TIME = 1.0;
const LEAP_MAX_DISTANCE = 10.0 * 1.15;     // +15% = 11.5m
const LEAP_RADIUS = 4.55;                   // = BLACKHOLE_RADIUS
const LEAP_DMG_PCT = 0.20;                  // 20% maxHP
const LEAP_STUN_TIME = 1.0;
const LEAP_HEAL_LOST_PCT = 0.25;            // 25% av (maxHP - currentHP) per träffad fiende (var 10%)
const BERSERK_DURATION = 5.0;
const BERSERK_AS_MUL = 1.0;                 // ingen AS-nerf längre (var 0.50 = -50% AS)
const BERSERK_AA_DMG_MUL = 2.50;            // +150% AA-damage
const BERSERK_AA_LIFESTEAL = 0.25;          // 25% lifesteal av all AA-skada under berserk
const BERSERK_SCALE = 1.25;                 // lite större hero

// === Q: Whirlwind ===
function hostCastAragurnWhirlwind(side) {
  if (side.hero.dead || side.skills.q.cd > 0) return;
  // Kan inte starta ny spin medan en pågår (CD räknar ner FÖRST efter spin slutat)
  if ((side.whirlwindRemaining || 0) > 0) return;
  // Kan inte casta om stunnad — befintliga CC-locks i applyEvent fångar redan
  // frozen/feared/taunted. Whirlwind rensar resten (slow, etc) vid cast.
  side.whirlwindRemaining = WHIRLWIND_DURATION + (arenaHasTalent(side, 'a_spin_extend') ? 1.5 : 0);
  side.whirlwindTickAccum = 0;
  // Rensa befintlig slow / dot / taunt / fear / frozen (men stun ligger på frozen → kan inte casta)
  side.heroSlowTime = 0; side.heroSlowMul = 1;
  side.hero.dotRemaining = 0; side.hero.dotPerSec = 0;
  side.hero.poisonRemaining = 0; side.hero.poisonStacks = 0;
  side.hero.tauntedTime = 0;
  side.heroFearTime = 0;
  // Flytta svärdet UT från kroppen så det visuellt snurrar utanför hero
  if (side.mesh && side.mesh.userData.aragurnSword) {
    const sword = side.mesh.userData.aragurnSword;
    sword.position.set(1.2, 1.0, 0);   // 1.2m ut åt sidan, 1.0m upp
    sword.rotation.set(0, 0, Math.PI / 2);  // klingan horisontell, pekar utåt
  }
  // Visuell start-burst
  spawnSkillCastFx(side.hero.x, side.hero.z, 0xddc680, 1.8);
  spawnShieldBurstFx(side.hero.x, side.hero.z, 0xffe399);
  triggerCameraShake(0.15, 0.18);
  // Initial tick direkt
  applyWhirlwindTick(side);
}

function tickAragurnWhirlwind(side, dt) {
  side.whirlwindRemaining = Math.max(0, side.whirlwindRemaining - dt);
  side.whirlwindTickAccum += dt;
  // CC-immun under spin: nollställ alla CC-fält varje frame
  side.heroSlowTime = 0; side.heroSlowMul = 1;
  side.hero.frozenTime = 0;
  side.hero.tauntedTime = 0;
  side.heroFearTime = 0;
  side.hero.dotRemaining = 0;
  side.hero.poisonRemaining = 0;
  // Snabb spinn på hero-mesh (rotation.y override:as här, applyMovement skippar
  // sin egen rotation under whirl). Svärdet är child så det snurrar med.
  if (side.mesh) side.mesh.rotation.y += dt * 18;
  while (side.whirlwindTickAccum >= WHIRLWIND_TICK && side.whirlwindRemaining > -WHIRLWIND_TICK) {
    side.whirlwindTickAccum -= WHIRLWIND_TICK;
    applyWhirlwindTick(side);
  }
  if (side.whirlwindRemaining <= 0) {
    side.whirlwindRemaining = 0;
    // CD startar NU — först efter spin slutat (max innehåller redan CDR-reduktion)
    side.skills.q.cd = side.skills.q.max;
    // Återställ svärd till default-position
    if (side.mesh && side.mesh.userData.aragurnSword && side.mesh.userData.aragurnSwordDefault) {
      const sword = side.mesh.userData.aragurnSword;
      const def = side.mesh.userData.aragurnSwordDefault;
      sword.position.copy(def.pos);
      sword.rotation.copy(def.rot);
    }
  }
}

function applyWhirlwindTick(side) {
  const opp = sides[3 - side.idx];
  const ox = side.hero.x, oz = side.hero.z;
  const skillMul = aragurnPassiveMul(side) * (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1);
  // Monsters
  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    if (Math.hypot(m.mesh.position.x - ox, m.mesh.position.z - oz) < WHIRLWIND_RADIUS) {
      const dmg = (m.maxHp || m.hp) * WHIRLWIND_DMG_PCT * skillMul * bossWarsPctScale(m);
      soloApplySkillDmgToMonster(side, opp, i, dmg);
    }
  }
  if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
    const c = opp.playerCreeps[i];
    if (Math.hypot(c.mesh.position.x - ox, c.mesh.position.z - oz) < WHIRLWIND_RADIUS) {
      const dmg = (c.maxHp || c.hp) * WHIRLWIND_DMG_PCT * skillMul;
      soloApplySkillDmgToCreep(side, opp, c, dmg);
      if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(i, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
    }
  }
  // Arena: orb + opp hero
  if (APP.gameMode === 'arena1v1') {
    if (arenaState.orb && arenaState.orb.alive) {
      if (Math.hypot(ARENA_CFG.orb.x - ox, ARENA_CFG.orb.z - oz) < WHIRLWIND_RADIUS) {
        damageArenaOrb(arenaState.orb.maxHp * WHIRLWIND_DMG_PCT * skillMul, side.idx);
      }
    }
    if (opp && !opp.hero.dead && arenaState.phase === 'fight') {
      if (Math.hypot(opp.hero.x - ox, opp.hero.z - oz) < WHIRLWIND_RADIUS) {
        damageHero(opp, opp.hero.maxHp * WHIRLWIND_DMG_PCT * skillMul);
      }
    }
  }
  // Visuell spinn-FX
  spawnHitSparkFx(ox + (Math.random() - 0.5) * WHIRLWIND_RADIUS * 0.7, 1.0, oz + (Math.random() - 0.5) * WHIRLWIND_RADIUS * 0.7, 0xffe399);
}

// === F: War Shout ===
function hostCastAragurnShout(side, dirX, dirZ) {
  if (side.hero.dead || side.skills.f.cd > 0) return;
  side.skills.f.cd = side.skills.f.max;
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.01) { dirX = side.hero.facingX; dirZ = side.hero.facingZ; }
  else { dirX /= len; dirZ /= len; }
  const rangeMul = arenaHasTalent(side, 'a_shout_radius') ? 1.3 : 1.0;
  const length = SHOUT_LENGTH * rangeMul;
  const halfAng = SHOUT_HALF_ANGLE * (rangeMul > 1 ? 1.15 : 1);
  // Visuell kon-flash + ljudvågringar
  spawnConeFlash(side.hero.x, side.hero.z, dirX, dirZ, length, halfAng, 0xffe399);
  // Visuell buff-cirkel runt Aragurn (separat från damage-konen)
  spawnGroundImpact(side.hero.x, side.hero.z, SHOUT_BUFF_RADIUS, 0xffe399);
  triggerCameraShake(0.18, 0.20);
  const passive = aragurnPassiveMul(side);
  const skillMul = passive * (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1);
  // Self-buff: bara DR (inte MS) + HoT 10%/s i 2s
  side.aragurnShoutBuff = SHOUT_ALLY_BUFF_DURATION;
  side.aragurnShoutHealRemaining = SHOUT_HEAL_DURATION;
  side.aragurnShoutHealPct = SHOUT_HEAL_SELF_PCT;
  // Cone-träff på fiender
  const opp = sides[3 - side.idx];
  const inCone = (ex, ez) => {
    const ddx = ex - side.hero.x, ddz = ez - side.hero.z;
    const d = Math.hypot(ddx, ddz);
    if (d > length || d < 0.001) return false;
    const dot = (ddx * dirX + ddz * dirZ) / d;
    return Math.acos(Math.max(-1, Math.min(1, dot))) < halfAng;
  };
  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    if (!inCone(m.mesh.position.x, m.mesh.position.z)) continue;
    const dmg = (m.maxHp || m.hp) * SHOUT_DIRECT_DMG_PCT * skillMul * bossWarsPctScale(m);
    soloApplySkillDmgToMonster(side, opp, i, dmg);
    if (side.monsters[i] === m && m.hp > 0) {
      m.slowMul = Math.min(m.slowMul || 1, SHOUT_SLOW_MUL);
      m.slowTime = Math.max(m.slowTime || 0, SHOUT_SLOW_DURATION);
    }
  }
  if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
    const c = opp.playerCreeps[i];
    if (!inCone(c.mesh.position.x, c.mesh.position.z)) continue;
    const dmg = (c.maxHp || c.hp) * SHOUT_DIRECT_DMG_PCT * skillMul;
    soloApplySkillDmgToCreep(side, opp, c, dmg);
    if (c.hp > 0) {
      c.slowMul = Math.min(c.slowMul || 1, SHOUT_SLOW_MUL);
      c.slowTime = Math.max(c.slowTime || 0, SHOUT_SLOW_DURATION);
    } else {
      scene.remove(c.mesh); opp.playerCreeps.splice(i, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c));
    }
  }
  // Arena: opp hero i kon
  if (APP.gameMode === 'arena1v1' && opp && !opp.hero.dead && arenaState.phase === 'fight') {
    if (inCone(opp.hero.x, opp.hero.z)) {
      damageHero(opp, opp.hero.maxHp * SHOUT_DIRECT_DMG_PCT * skillMul);
      const ccMul = Math.max(0, 1 - (opp.ccReductionPct || 0));
      opp.heroSlowMul = Math.min(opp.heroSlowMul || 1, 1 - (1 - SHOUT_SLOW_MUL) * ccMul);
      opp.heroSlowTime = Math.max(opp.heroSlowTime || 0, SHOUT_SLOW_DURATION);
      opp.aragurnShoutDebuff = SHOUT_DEBUFF_DURATION;  // tar 20% mer skada
    }
  }
  // Allierade hjältar inom CIRKEL runt Aragurn (inte cone) får buff + HoT
  if (APP.gameMode === 'arena1v1' && APP.arenaTeamSize === 2) {
    const team = arenaTeamMates(arenaTeamOf(side.idx)) || [];
    for (const aidx of team) {
      if (aidx === side.idx) continue;
      const ally = sides[aidx];
      if (!ally || ally.hero.dead) continue;
      const dAlly = Math.hypot(ally.hero.x - side.hero.x, ally.hero.z - side.hero.z);
      if (dAlly < SHOUT_BUFF_RADIUS) {
        ally.aragurnAllyShoutBuff = SHOUT_ALLY_BUFF_DURATION;
        ally.aragurnShoutHealRemaining = SHOUT_HEAL_DURATION;
        ally.aragurnShoutHealPct = SHOUT_HEAL_ALLY_PCT;
      }
    }
  }
}

// === E: Hero Leap ===
function hostCastAragurnLeap(side, ev) {
  if (side.hero.dead || side.skills.e.cd > 0) return;
  side.skills.e.cd = side.skills.e.max;
  // Mark-target: drag-position eller framåt
  const center = soloResolveSkillGroundTarget(side, ev || {}, LEAP_MAX_DISTANCE);
  // Begränsa max-distansen
  const dx = center.x - side.hero.x, dz = center.z - side.hero.z;
  const d = Math.hypot(dx, dz);
  let tx = center.x, tz = center.z;
  if (d > LEAP_MAX_DISTANCE) {
    tx = side.hero.x + (dx / d) * LEAP_MAX_DISTANCE;
    tz = side.hero.z + (dz / d) * LEAP_MAX_DISTANCE;
  }
  // Clamp inom walkable area — om utanför banan, sök tillbaka mot hero
  if (!isHeroWalkable(side.idx, tx, tz)) {
    const sx = side.hero.x, sz = side.hero.z;
    const ddx = sx - tx, ddz = sz - tz;
    const dl = Math.hypot(ddx, ddz);
    if (dl > 0.01) {
      const nx = ddx / dl, nz = ddz / dl;
      let found = false;
      for (let step = 0.5; step <= dl; step += 0.5) {
        const px = tx + nx * step, pz = tz + nz * step;
        if (isHeroWalkable(side.idx, px, pz)) {
          tx = px; tz = pz; found = true; break;
        }
      }
      if (!found) { tx = sx; tz = sz; }   // fallback: stå still
    }
  }
  side.aragurnLeap = {
    remaining: LEAP_TRAVEL_TIME,
    startX: side.hero.x, startZ: side.hero.z,
    targetX: tx, targetZ: tz,
  };
  // Mark-indikator där han ska landa
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(LEAP_RADIUS * 0.85, LEAP_RADIUS, 36),
    new THREE.MeshBasicMaterial({ color: 0xff7733, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(tx, 0.08, tz);
  scene.add(ring);
  side.aragurnLeap.indicator = ring;
  spawnSkillCastFx(side.hero.x, side.hero.z, 0xffaa55, 1.4);
}

function tickAragurnLeap(side, dt) {
  const lp = side.aragurnLeap;
  if (!lp) return;
  lp.remaining -= dt;
  const t = Math.min(1, 1 - lp.remaining / LEAP_TRAVEL_TIME);   // 0 → 1
  // Bågformig bana: linjär XZ + parabel-höjd Y
  const cx = lp.startX + (lp.targetX - lp.startX) * t;
  const cz = lp.startZ + (lp.targetZ - lp.startZ) * t;
  const cy = Math.sin(t * Math.PI) * 4.0;  // peak 4m hög
  side.hero.x = cx;
  side.hero.z = cz;
  if (side.mesh) {
    side.mesh.position.set(cx, cy, cz);
    side.mesh.rotation.y = Math.atan2(lp.targetX - lp.startX, lp.targetZ - lp.startZ);
  }
  // Indikatorn pulserar starkare ju närmre landning
  if (lp.indicator) {
    lp.indicator.material.opacity = 0.5 + 0.45 * Math.sin(performance.now() * 0.02);
    const scale = 1 + 0.08 * t;
    lp.indicator.scale.set(scale, scale, 1);
  }
  if (lp.remaining <= 0) {
    // Landning!
    side.hero.x = lp.targetX; side.hero.z = lp.targetZ;
    if (side.mesh) side.mesh.position.set(lp.targetX, 0, lp.targetZ);
    if (lp.indicator) { scene.remove(lp.indicator); lp.indicator.material.dispose(); lp.indicator.geometry.dispose(); }
    applyAragurnLeapImpact(side, lp.targetX, lp.targetZ);
    side.aragurnLeap = null;
  }
}

function applyAragurnLeapImpact(side, x, z) {
  spawnGroundImpact(x, z, LEAP_RADIUS, 0xff7733);
  triggerCameraShake(0.40, 0.45);
  const opp = sides[3 - side.idx];
  const passive = aragurnPassiveMul(side);
  const skillMul = passive * (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1);
  const healPctPerHit = LEAP_HEAL_LOST_PCT * (arenaHasTalent(side, 'a_leap_heal') ? 1.5 : 1.0);
  let hitCount = 0;
  // Monsters
  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    if (Math.hypot(m.mesh.position.x - x, m.mesh.position.z - z) < LEAP_RADIUS) {
      const dmg = (m.maxHp || m.hp) * LEAP_DMG_PCT * skillMul * bossWarsPctScale(m);
      soloApplySkillDmgToMonster(side, opp, i, dmg);
      if (side.monsters[i] === m && m.hp > 0) m.frozenTime = Math.max(m.frozenTime || 0, LEAP_STUN_TIME);
      hitCount++;
    }
  }
  if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
    const c = opp.playerCreeps[i];
    if (Math.hypot(c.mesh.position.x - x, c.mesh.position.z - z) < LEAP_RADIUS) {
      const dmg = (c.maxHp || c.hp) * LEAP_DMG_PCT * skillMul;
      soloApplySkillDmgToCreep(side, opp, c, dmg);
      if (c.hp > 0) c.frozenTime = Math.max(c.frozenTime || 0, LEAP_STUN_TIME);
      else { scene.remove(c.mesh); opp.playerCreeps.splice(i, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
      hitCount++;
    }
  }
  // Arena: orb + opp hero
  if (APP.gameMode === 'arena1v1') {
    if (arenaState.orb && arenaState.orb.alive) {
      if (Math.hypot(ARENA_CFG.orb.x - x, ARENA_CFG.orb.z - z) < LEAP_RADIUS) {
        damageArenaOrb(arenaState.orb.maxHp * LEAP_DMG_PCT * skillMul, side.idx);
        hitCount++;
      }
    }
    if (opp && !opp.hero.dead && arenaState.phase === 'fight') {
      if (Math.hypot(opp.hero.x - x, opp.hero.z - z) < LEAP_RADIUS) {
        damageHero(opp, opp.hero.maxHp * LEAP_DMG_PCT * skillMul);
        const ccMul = Math.max(0, 1 - (opp.ccReductionPct || 0));
        opp.hero.frozenTime = Math.max(opp.hero.frozenTime || 0, LEAP_STUN_TIME * ccMul);
        hitCount++;
      }
    }
  }
  // Heal per träffad fiende: 10% av FÖRLORAD HP (maxHP - currentHP)
  if (hitCount > 0 && !side.hero.dead) {
    const lostHp = side.hero.maxHp - side.hero.hp;
    const heal = lostHp * healPctPerHit * hitCount;
    if (heal > 0) {
      side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + heal);
      spawnHeroHealText(side, heal);
    }
  }
}

// === R: Berserk Form ===
function hostCastAragurnUlt(side) {
  if (side.hero.dead) return;
  side.berserkRemaining = BERSERK_DURATION;
  if (side.mesh) side.mesh.scale.set(BERSERK_SCALE, BERSERK_SCALE, BERSERK_SCALE);
  // Spawna stort glödande svärd som följer hero (visuell aura)
  if (!side.berserkSwordMesh) {
    const grp = new THREE.Group();
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 2.4, 0.05),
      new THREE.MeshStandardMaterial({ color: 0xddc680, emissive: 0xff7733, emissiveIntensity: 1.6, metalness: 0.6, roughness: 0.3 })
    );
    blade.position.y = 1.4;
    grp.add(blade);
    const tipGlow = new THREE.PointLight(0xff7733, 2.4, 4);
    tipGlow.position.y = 2.4;
    grp.add(tipGlow);
    const hilt = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.1, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x553311, metalness: 0.3 })
    );
    hilt.position.y = 0.25;
    grp.add(hilt);
    // Halo runt klingan
    const halo = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 2.6, 14),
      new THREE.MeshBasicMaterial({ color: 0xff8844, transparent: true, opacity: 0.35, depthWrite: false })
    );
    halo.position.y = 1.4;
    grp.add(halo);
    grp.userData.halo = halo;
    grp.userData.blade = blade;
    grp.userData.tipGlow = tipGlow;
    scene.add(grp);
    side.berserkSwordMesh = grp;
  }
  spawnSkillCastFx(side.hero.x, side.hero.z, 0xff7733, 2.2);
  spawnShieldBurstFx(side.hero.x, side.hero.z, 0xffaa55);
  triggerCameraShake(0.30, 0.40);
}

function tickAragurnBerserk(side, dt) {
  side.berserkRemaining = Math.max(0, side.berserkRemaining - dt);
  if (side.berserkSwordMesh) {
    side.berserkSwordMesh.position.set(side.hero.x + 0.6, 0, side.hero.z);
    side.berserkSwordMesh.rotation.y = side.mesh ? side.mesh.rotation.y : 0;
    const halo = side.berserkSwordMesh.userData.halo;
    if (halo && halo.material) halo.material.opacity = 0.30 + 0.20 * Math.sin(performance.now() * 0.012);
  }
  if (side.berserkRemaining <= 0) {
    if (side.mesh) side.mesh.scale.set(1, 1, 1);
    if (side.berserkSwordMesh) {
      side.berserkSwordMesh.traverse(o => {
        if (o.isMesh) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }
      });
      scene.remove(side.berserkSwordMesh);
      side.berserkSwordMesh = null;
    }
  }
}

// === PASSIVE: Last Stand ===
// Per 1% HP saknad → +0.5% skill + AA damage. Mul appliceras i Aragurns
// skill-dmg (skillMul = aragurnPassiveMul × skillDmgMul) och AA via getter.
function aragurnPassiveMul(side) {
  if (side.heroId !== 'aragurn' || side.hero.dead) return 1;
  const maxHp = side.hero.maxHp || 1;
  const lostPct = Math.max(0, 1 - side.hero.hp / maxHp);   // 0..1
  return 1 + lostPct * 0.5;   // 1.0 → 1.5 vid 0 HP
}

const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (APP.mode === 'lobby') return;
  const side = sides[APP.localSide];
  if (!side) return;
  if (e.code === 'KeyQ') castLocalSkill('q', side.hero.facingX, side.hero.facingZ, true);
  if (e.code === 'KeyE') castLocalSkill('e', side.hero.facingX, side.hero.facingZ, true);
  if (e.code === 'KeyF') castLocalSkill('f', 0, 0, true);
  // Spacebar (eller R) = ultimate
  if (e.code === 'Space' || e.code === 'KeyR') { e.preventDefault?.(); castLocalSkill('r', side.hero.facingX, side.hero.facingZ, true); }
  if (e.code === 'KeyA') { e.preventDefault?.(); triggerAA(); }
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
  if (!side) return;
  // Tillåt att hålla även när skillen är på cooldown — då vill man bara läsa
  // beskrivningen. Cast blockeras separat på cd vid release.
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
  // Starta 500ms-timer för tooltip
  startSkillLongPress(key);
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
    // Användaren drar för att sikta — avbryt tooltip
    clearSkillLongPress();
    if (skillTooltipState.shown) hideSkillTooltip();
  }
}
function endSkillTouch(touch, cancelled) {
  const key = aimState.key;
  if (!key) return;
  skillEls[key].classList.remove('active');
  const wasShowingTooltip = skillTooltipState.shown;
  clearSkillLongPress();
  hideSkillTooltip();
  const side = sides[APP.localSide];
  // Om tooltipen visades = användaren ville läsa, INTE casta
  // ULT (r) har ingen CD — kolla energi i hostCastUlt i stället
  const skillCdOK = key === 'r' ? true : (side && side.skills[key].cd <= 0);
  if (!cancelled && !wasShowingTooltip && side && skillCdOK) {
    let dx, dz;
    const isDrag = SKILL_AIMABLE[key] && aimState.dragMag > AIM_THRESHOLD;
    if (isDrag) {
      const w = screenToWorld(aimState.dx, aimState.dz);
      dx = w.x; dz = w.z;
    } else {
      dx = side.hero.facingX; dz = side.hero.facingZ;
    }
    // Drag-fraktion (0..1) — användaren styr cast-avstånd inom max-range.
    // Tap (utan drag) = full räckvidd framåt (klassisk default).
    const mag = isDrag ? Math.min(1, Math.max(0, aimState.dragMag / AIM_MAX_DRAG)) : 1;
    // tap=true om INTE drag — låter applyEvent leta upp target-aim
    castLocalSkill(key, dx, dz, !isDrag, mag);
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
const shopState = { selectedTier: 1, selectedLane: 1 };

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
}
const shopRefs = { heroBtns: [], laneBtns: [], tierBtns: [], minionBtns: [] };

function getNextLockedTier(side) {
  for (let t = 2; t <= 5; t++) if (!side.tierUnlocks[t]) return t;
  return null;
}

// Bygger en flatten:ad lista av alla shop-cells: items med varianter får
// en cell per variant. Items utan varianter får exakt en cell. Item6 är stub
// → skippas tills den fylls i. Returnerar { itemId, variantId? }.
function buildShopItemList() {
  const list = [];
  for (const itemId of ITEM_ORDER) {
    const def = ITEM_TYPES[itemId];
    if (!def) continue;
    if (def.variants) {
      for (const vid of Object.keys(def.variants)) {
        list.push({ itemId, variantId: vid });
      }
    } else {
      // Skippa items utan stats (stub-items som item6 returnerar {})
      if (typeof def.statsAtLevel !== 'function') { list.push({ itemId }); continue; }
      const sample = def.statsAtLevel(1);
      if (sample && Object.keys(sample).length > 0) list.push({ itemId });
      else list.push({ itemId });  // Visa även stub men sub-text säger "Coming Soon"
    }
  }
  return list;
}

function populateShop() {
  // ITEMS — alla varianter visas direkt som separata cells (Glove of Speed,
  // Glove of Magic, Glove of Tank, etc istället för en "Glove"-rad med picker).
  const heroRow = document.getElementById('shop-hero-row');
  heroRow.innerHTML = '';
  shopRefs.heroBtns = [];
  shopRefs.heroCells = [];
  shopRefs.heroVariantBtns = [];
  for (const entry of buildShopItemList()) {
    const cell = document.createElement('div');
    cell.className = 'item-cell';
    cell.dataset.item = entry.itemId;
    if (entry.variantId) cell.dataset.variant = entry.variantId;

    const primary = document.createElement('button');
    primary.className = 'shop-btn item-btn primary';
    primary.dataset.item = entry.itemId;
    if (entry.variantId) primary.dataset.variant = entry.variantId;
    primary.addEventListener('click', () => onItemPrimaryClick(entry.itemId, entry.variantId));
    cell.appendChild(primary);

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

function onItemPrimaryClick(itemId, variantId) {
  // Öppna detalj-modalen — variantId pre-selecteras om angiven.
  openItemShopDetail(itemId, variantId);
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

  // Item-knappar — primary alltid klickbar (öppnar detail-modal). Disable bara
  // för MAX-level (inget mer att göra). Köp/upgrade-disable hanteras i modalen.
  const invFull = side.inventory.length >= INVENTORY_SLOTS;
  for (const cell of shopRefs.heroCells) {
    const itemId = cell.dataset.item;
    const variantId = cell.dataset.variant || null;
    const def = ITEM_TYPES[itemId];
    if (!def) continue;
    // Hitta existing entry — för variants kollar vi om EXAKT denna variant ägs
    const existing = side.inventory.find(it =>
      it.itemId === itemId && (variantId ? it.variantId === variantId : true)
    );
    // Andra variants ägs?
    const otherVariantOwned = !!variantId && side.inventory.find(it =>
      it.itemId === itemId && it.variantId && it.variantId !== variantId
    );
    const subDef = variantId && def.variants && def.variants[variantId]
      ? def.variants[variantId]
      : (existing ? itemDefForEntry(existing) : def);
    cell.classList.remove('picker-open');

    const primary = cell.querySelector('.primary');
    primary.classList.remove('owned', 'maxlvl', 'locked-variant');
    if (!existing) {
      const name = subDef.name || def.name;
      const icon = subDef.icon || def.icon || '?';
      let sub;
      if (otherVariantOwned) { primary.classList.add('locked-variant'); sub = 'Annan variant ägs'; }
      else if (invFull) sub = 'Inventory full';
      else if (side.gold < ITEM_BUY_COST) sub = `${ITEM_BUY_COST}g · saknar`;
      else sub = `${ITEM_BUY_COST}g · köp`;
      primary.innerHTML = `${icon} ${name}<small>${sub}</small>`;
      primary.disabled = false;  // alltid klickbar → öppnar info-modal
    } else if (existing.level >= ITEM_MAX_LEVEL) {
      primary.classList.add('owned', 'maxlvl');
      const name = subDef.name || def.name;
      const icon = subDef.icon || def.icon;
      primary.innerHTML = `${icon} ${name}<small>MAX (lvl ${existing.level})</small>`;
      primary.disabled = false;  // klickbar → öppnar info
    } else {
      primary.classList.add('owned');
      const cost = itemUpgradeCost(existing.level);
      const name = subDef.name || def.name;
      const icon = subDef.icon || def.icon;
      const sub = side.gold < cost ? `Lvl ${existing.level} · ${cost}g saknas` : `Lvl ${existing.level} → ${existing.level+1} · ${cost}g`;
      primary.innerHTML = `${icon} ${name}<small>${sub}</small>`;
      primary.disabled = false;  // klickbar → öppnar info-modal
    }
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

  // I arena: shop tillgänglig under prep-fasen (köpa items innan match)
  const isArenaPrep = APP.gameMode === 'arena1v1' && arenaState.phase === 'prep';
  // Boss Wars: ingen shop
  const isBossWars = APP.gameMode === 'bosswars';
  const showShop = !isBossWars && (isArenaPrep || (inBase && APP.gameMode !== 'arena1v1'));
  if (shopContainerEl) shopContainerEl.classList.toggle('visible', showShop);
  if (!showShop) collapseShopPanels();
}

populateShop();

function updateShop() {
  refreshShopUI();
  // Detalj-panelens disable-states (Buy/Upgrade-knappar) uppdateras mot
  // gold/inventory utan att rendera om hela DOM:n, så att variant-klick
  // inte tappas mellan frames.
  if (isdState.itemId) refreshIsdButtonsOnly();
}

// ---- Item-shop detalj-modal (klick på item → info + Buy/Upgrade) ----
// Modalen ligger nu CSS-positionerad till vänster (fixed, left), inte i shop-containern.
const isdEl = document.getElementById('item-shop-detail');
const isdIconEl = document.getElementById('isd-icon');
const isdNameEl = document.getElementById('isd-name');
const isdLevelEl = document.getElementById('isd-level');
const isdDescEl = document.getElementById('isd-desc');
const isdVariantsEl = document.getElementById('isd-variants');
const isdStatsCurEl = document.getElementById('isd-stats-current');
const isdStatsNextEl = document.getElementById('isd-stats-next');
const isdActiveEl = document.getElementById('isd-active');
const isdBuyBtn = document.getElementById('isd-buy');
const isdUpgradeBtn = document.getElementById('isd-upgrade');
const isdCloseBtn = document.getElementById('isd-close');

const isdState = { itemId: null, variantId: null };

// Mappa stat-nycklar till svenska etiketter + formatering (shop-detail-modal)
const ISD_STAT_LABELS = {
  moveSpeedPct:    { label: 'Rörelse',         pct: true },
  attackSpeedPct:  { label: 'Attackfart',      pct: true },
  skillDmgPct:     { label: 'Skill-skada',     pct: true },
  cdrPct:          { label: 'CDR',             pct: true },
  dmgReductionPct: { label: 'Skadereduktion',  pct: true },
  maxHpPct:        { label: 'Max HP',          pct: true },
  critChancePct:   { label: 'Crit chans',      pct: true },
  healPerSecPct:   { label: 'Heal per sek',    pct: true },
  attackDmg:       { label: 'Attack-skada',    pct: false },
  moveSpeed:       { label: 'Rörelse (flat)',  pct: false },
  maxHp:           { label: 'Max HP (flat)',   pct: false },
};

function statsLinesHtml(stats) {
  const lines = [];
  for (const [k, v] of Object.entries(stats || {})) {
    if (!v) continue;
    const meta = ISD_STAT_LABELS[k] || { label: k, pct: k.endsWith('Pct') };
    const valStr = meta.pct ? `+${(v * 100).toFixed(1)}%` : `+${v}`;
    lines.push(`<div class="stat-line">${meta.label}: <strong>${valStr}</strong></div>`);
  }
  return lines.join('');
}

function openItemShopDetail(itemId, variantId = null) {
  if (!ITEM_TYPES[itemId]) return;
  isdState.itemId = itemId;
  isdState.variantId = variantId;
  refreshItemShopDetail();
  if (isdEl) isdEl.classList.add('visible');
}

function closeItemShopDetail() {
  isdState.itemId = null;
  isdState.variantId = null;
  if (isdEl) isdEl.classList.remove('visible');
}

// Uppdaterar bara knapp-disabled-states + cost-text utan att rendera om
// variant-knapparna (annars tappas klick mellan frames).
function refreshIsdButtonsOnly() {
  const itemId = isdState.itemId;
  if (!itemId) return;
  const def = ITEM_TYPES[itemId];
  if (!def) return;
  const side = sides[APP.localSide];
  const existingAny = side ? side.inventory.find(it => it.itemId === itemId) : null;
  const existing = side
    ? side.inventory.find(it =>
        it.itemId === itemId && (isdState.variantId ? it.variantId === isdState.variantId : true)
      )
    : null;
  const otherVariantOwned = !existing && existingAny;
  const hasVariants = !!def.variants;
  const needsVariantChoice = hasVariants && !existing && !otherVariantOwned;
  const heroDead = side && side.hero && side.hero.dead;
  const invFull = side && side.inventory.length >= INVENTORY_SLOTS;
  if (isdBuyBtn) {
    if (existing) {
      isdBuyBtn.disabled = true;
      isdBuyBtn.innerHTML = `Buy<small>redan i inventory</small>`;
    } else if (otherVariantOwned) {
      isdBuyBtn.disabled = true;
      isdBuyBtn.innerHTML = `Buy<small>annan variant ägs</small>`;
    } else {
      const variantOk = !needsVariantChoice || !!isdState.variantId;
      const canAfford = side && side.gold >= ITEM_BUY_COST;
      isdBuyBtn.disabled = heroDead || invFull || !variantOk || !canAfford;
      const sub = invFull ? 'inventory full'
                : !variantOk ? 'välj variant först'
                : !canAfford ? `behöver ${ITEM_BUY_COST}g`
                : `${ITEM_BUY_COST}g`;
      isdBuyBtn.innerHTML = `Buy<small>${sub}</small>`;
    }
  }
  if (isdUpgradeBtn) {
    if (!existing) {
      isdUpgradeBtn.disabled = true;
      isdUpgradeBtn.innerHTML = `Upgrade<small>kräver ägd</small>`;
    } else if (existing.level >= ITEM_MAX_LEVEL) {
      isdUpgradeBtn.disabled = true;
      isdUpgradeBtn.innerHTML = `Upgrade<small>MAX nivå</small>`;
    } else {
      const cost = itemUpgradeCost(existing.level);
      const canAfford = side && side.gold >= cost;
      isdUpgradeBtn.disabled = heroDead || !canAfford;
      isdUpgradeBtn.innerHTML = `Upgrade<small>${cost}g · Lvl ${existing.level} → ${existing.level + 1}</small>`;
    }
  }
}

function refreshItemShopDetail() {
  const itemId = isdState.itemId;
  if (!itemId) return;
  const def = ITEM_TYPES[itemId];
  if (!def) return;
  const side = sides[APP.localSide];
  // existing: matchar samma item OCH (om vi specifierat variant) samma variant.
  // existingAny: matchar bara samma itemId (för att indikera "annan variant ägd").
  const existingAny = side ? side.inventory.find(it => it.itemId === itemId) : null;
  const existing = side
    ? side.inventory.find(it =>
        it.itemId === itemId && (isdState.variantId ? it.variantId === isdState.variantId : true)
      )
    : null;
  const otherVariantOwned = !existing && existingAny;
  const subDef = existing ? itemDefForEntry(existing) : null;
  const hasVariants = !!def.variants;
  const needsVariantChoice = hasVariants && !existing && !otherVariantOwned;
  // Display-def: pre-selected variant > existing variant > raw root
  const variantDef = (isdState.variantId && def.variants) ? def.variants[isdState.variantId] : null;
  const displayDef = variantDef || subDef || def;

  if (isdIconEl) isdIconEl.textContent = displayDef.icon || '?';
  if (isdNameEl) isdNameEl.textContent = displayDef.name || def.name;
  if (isdLevelEl) {
    isdLevelEl.textContent = existing
      ? `Lvl ${existing.level}${existing.level >= ITEM_MAX_LEVEL ? ' · MAX' : ` / ${ITEM_MAX_LEVEL}`}`
      : 'Ej ägd';
  }
  if (isdDescEl) isdDescEl.textContent = displayDef.description || def.description || '';

  // Variant-picker dolt eftersom shoppen nu visar varje variant som egen cell.
  // Vi behåller logiken på en linje "vald variant" om man landat på root-itemet
  // utan variant (gammal entry-point).
  if (needsVariantChoice && !isdState.variantId) {
    const buttons = Object.entries(def.variants).map(([vid, v]) => {
      return `<button class="var-btn" data-vid="${vid}">${v.icon || ''} ${v.name}<small>${v.description || ''}</small></button>`;
    }).join('');
    isdVariantsEl.innerHTML = `<div class="vt-title">VÄLJ VARIANT</div>${buttons}`;
    isdVariantsEl.classList.remove('hidden');
    isdVariantsEl.querySelectorAll('button[data-vid]').forEach(b => {
      b.onclick = () => {
        isdState.variantId = b.dataset.vid;
        refreshItemShopDetail();
      };
    });
  } else if (isdVariantsEl) {
    isdVariantsEl.innerHTML = '';
    isdVariantsEl.classList.add('hidden');
  }

  // Nuvarande stats (om ägd)
  if (existing && subDef && typeof subDef.statsAtLevel === 'function') {
    const cur = subDef.statsAtLevel(existing.level);
    const html = statsLinesHtml(cur);
    if (html) {
      isdStatsCurEl.innerHTML = `<div class="stats-title">Nuvarande (Lvl ${existing.level})</div>${html}`;
      isdStatsCurEl.classList.remove('hidden');
    } else {
      isdStatsCurEl.innerHTML = '';
      isdStatsCurEl.classList.add('hidden');
    }
  } else if (isdStatsCurEl) {
    isdStatsCurEl.innerHTML = '';
    isdStatsCurEl.classList.add('hidden');
  }

  // Förhandsvisning: vad köp/uppgrade ger
  if (isdStatsNextEl) {
    let title = '';
    let stats = null;
    if (existing && existing.level < ITEM_MAX_LEVEL && subDef && subDef.statsAtLevel) {
      title = `Efter uppgrade (Lvl ${existing.level + 1})`;
      stats = subDef.statsAtLevel(existing.level + 1);
    } else if (!existing) {
      const previewDef = needsVariantChoice
        ? (isdState.variantId ? def.variants[isdState.variantId] : null)
        : def;
      if (previewDef && typeof previewDef.statsAtLevel === 'function') {
        title = 'Vid köp (Lvl 1)';
        stats = previewDef.statsAtLevel(1);
      }
    }
    const html = stats ? statsLinesHtml(stats) : '';
    if (html) {
      isdStatsNextEl.innerHTML = `<div class="stats-title">${title}</div>${html}`;
      isdStatsNextEl.classList.remove('hidden');
    } else {
      isdStatsNextEl.innerHTML = '';
      isdStatsNextEl.classList.add('hidden');
    }
  }

  // Active-info (lvl 10 unlock)
  if (isdActiveEl) {
    const adef = (subDef && subDef.activeAtMax)
              || (!existing && !needsVariantChoice && def.activeAtMax)
              || (needsVariantChoice && isdState.variantId && def.variants[isdState.variantId].activeAtMax);
    if (adef) {
      const unlocked = existing && existing.level >= ITEM_MAX_LEVEL;
      isdActiveEl.innerHTML =
        `<div class="stats-title">ACTIVE — låses upp vid Lvl ${ITEM_MAX_LEVEL}</div>` +
        `<div class="stat-line">${adef.description || ''}</div>` +
        `<div class="stat-line" style="opacity:0.75">${adef.duration}s effekt · ${adef.cooldown}s cooldown` +
        (unlocked ? ' · <span style="color:#aaffaa">UPPLÅST</span>' : '') + `</div>`;
      isdActiveEl.classList.remove('hidden');
    } else {
      isdActiveEl.innerHTML = '';
      isdActiveEl.classList.add('hidden');
    }
  }

  // Knappstatus
  const heroDead = side && side.hero && side.hero.dead;
  const invFull = side && side.inventory.length >= INVENTORY_SLOTS;
  if (isdBuyBtn) {
    if (existing) {
      isdBuyBtn.disabled = true;
      isdBuyBtn.innerHTML = `Buy<small>redan i inventory</small>`;
    } else if (otherVariantOwned) {
      isdBuyBtn.disabled = true;
      isdBuyBtn.innerHTML = `Buy<small>annan variant ägs</small>`;
    } else {
      const variantOk = !needsVariantChoice || !!isdState.variantId;
      const canAfford = side && side.gold >= ITEM_BUY_COST;
      isdBuyBtn.disabled = heroDead || invFull || !variantOk || !canAfford;
      const sub = invFull ? 'inventory full'
                : !variantOk ? 'välj variant först'
                : !canAfford ? `behöver ${ITEM_BUY_COST}g`
                : `${ITEM_BUY_COST}g`;
      isdBuyBtn.innerHTML = `Buy<small>${sub}</small>`;
    }
  }
  if (isdUpgradeBtn) {
    if (!existing) {
      isdUpgradeBtn.disabled = true;
      isdUpgradeBtn.innerHTML = `Upgrade<small>kräver ägd</small>`;
    } else if (existing.level >= ITEM_MAX_LEVEL) {
      isdUpgradeBtn.disabled = true;
      isdUpgradeBtn.innerHTML = `Upgrade<small>MAX nivå</small>`;
    } else {
      const cost = itemUpgradeCost(existing.level);
      const canAfford = side && side.gold >= cost;
      isdUpgradeBtn.disabled = heroDead || !canAfford;
      isdUpgradeBtn.innerHTML = `Upgrade<small>${cost}g · Lvl ${existing.level} → ${existing.level + 1}</small>`;
    }
  }
}

if (isdBuyBtn) {
  isdBuyBtn.addEventListener('click', () => {
    const itemId = isdState.itemId;
    if (!itemId) return;
    const def = ITEM_TYPES[itemId];
    const side = sides[APP.localSide];
    if (!def || !side) return;
    const existing = side.inventory.find(it => it.itemId === itemId);
    if (existing) return;
    if (def.variants && !isdState.variantId) return;
    sendOrApplyEvent({
      type: 'shop', kind: 'item',
      item: itemId,
      ...(isdState.variantId ? { variant: isdState.variantId } : {}),
    });
    // Användaren stänger manuellt via × — uppdatera bara DOM
    refreshItemShopDetail();
  });
}
if (isdUpgradeBtn) {
  isdUpgradeBtn.addEventListener('click', () => {
    const itemId = isdState.itemId;
    if (!itemId) return;
    const side = sides[APP.localSide];
    if (!side) return;
    const existing = side.inventory.find(it => it.itemId === itemId);
    if (!existing) return;
    if (existing.level >= ITEM_MAX_LEVEL) return;
    sendOrApplyEvent({ type: 'shop', kind: 'item', item: itemId });
    // Användaren stänger manuellt via × — uppdatera bara DOM
    refreshItemShopDetail();
  });
}
if (isdCloseBtn) isdCloseBtn.addEventListener('click', closeItemShopDetail);
// Klick utanför panel-card stänger INTE längre (panel är liten, inte fullskärm)

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
  attackDmgPct: 'AA-skada',
  ccReductionPct: 'CC-reduktion',
  skillLifestealPct: 'skill-lifesteal',
  aaDmgReductionPct: 'AA-skadereduktion',
  skillDmgReductionPct: 'skill-skadereduktion',
  hpRegenLostPct: 'regen av förlorad HP',
  blockChancePct: 'block-chans',
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
  // ULT-knappens fill + percentage + ready-glow
  if (skillEls.r) {
    const energy = side ? (side.ultEnergy || 0) : 0;
    const pct = Math.min(100, Math.max(0, Math.round(energy)));
    if (ultFillEl) ultFillEl.style.height = pct + '%';
    if (ultPctEl) ultPctEl.textContent = pct + '%';
    skillEls.r.classList.toggle('ready', pct >= 100);
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
// mag (0..1) = drag-fraktion av max-range. 0 = under hero, 1 = full max-range.
function castLocalSkill(key, worldDx, worldDz, tap = false, mag = 1) {
  const side = sides[APP.localSide];
  if (!side || side.hero.dead) return;
  const isArenaMpClient = (APP.mode === 'client' && isArenaMp());
  // ULT (r): ingen CD, blockas av energy-check i hostCastUlt
  if (key === 'r') {
    if ((side.ultEnergy || 0) < ULT_ENERGY_MAX) return;
    if ((side._ultLockoutTime || 0) > 0) return;   // 5s lockout efter förra ult-cast
    // Optimistic: nollställ ultEnergy + starta 5s lockout lokalt så användaren
    // ser ult-ikonen tom + ult-gain pausad direkt (utan att vänta på broadcast).
    side._localUltCastAt = performance.now();
    side.ultEnergy = 0;
    side._ultLockoutTime = ULT_LOCKOUT_AFTER_CAST;
    // Visuell ult-feedback direkt (host's broadcast carry no fx för ult)
    triggerClientVisualSkill(side, 'r');
    // Optimistic klient-prediction för Legolas Shadow Volley: sätt invis-state
    // direkt så hero blir transparent och empowered-AA är tillgänglig innan
    // server-snap bekräftar (~150 ms). Server är auktoritativ vid nästa snap.
    if (side.heroId === 'legolas') {
      side.legolusInvisRemaining = LEGOLUS_INVIS_DURATION;
      side.legolusUltAaPending = true;
    }
    sendOrApplyEvent({ type: 'skill', key, dx: worldDx, dz: worldDz, tap, mag });
    return;
  }
  // Gimlu E är "teleport till hammar" om hammaren är ute — bypassar cd
  const isGimluE = side.heroId === 'gimlu' && key === 'e';
  if (!isGimluE && side.skills[key].cd > 0) return;
  // Optimistic lokal cd: sätt cd till max direkt så användaren ser knappen
  // gå på cooldown utan ~150 ms broadcast-fördröjning. Förhindrar också att
  // click-spam genererar dropped duplicate-events (host hade redan satt cd
  // på första). Sticky-stash i _localCastAt så applyHeroSnap inte snap:ar
  // tillbaka till 0 under första ~500 ms efter klick (innan host-broadcast
  // bekräftar).
  if (!isGimluE) {
    side.skills[key].cd = side.skills[key].max || 1;
    side.skills[key]._localCastAt = performance.now();
  }
  // Trigga visuell skill-effekt direkt på klient (instant feedback).
  // Gäller alla MP-lägen (classic line wars, arena, boss wars) eftersom servern
  // / hosten inte skickar dedikerade fx-events — klienten måste själv spawna
  // visualer för sina egna casts. Solo körs som vanligt via applyEvent och
  // skippar denna (sin egen hostCast-funktion spawnar fx direkt).
  const isClassicMp = (APP.mode === 'host' || APP.mode === 'client') && APP.gameMode === 'classic';
  if (isArenaMpClient || isClassicMp ||
      (bossMpState && bossMpState.matchActive && bossMpState.role === 'client' && APP.gameMode === 'bosswars')) {
    triggerClientVisualSkill(side, key);
  }
  // Klient-prediktion i arena MP för Legolas Q (vine trap) + E (dash). Host broadcastar
  // inte vine trap-meshen eller dash-teleporten via a-state — klienten skulle annars
  // bara se cast-ringen och inget mer. Damage/auktoritativ position kommer från host.
  if (isArenaMpClient && side.heroId === 'legolas') {
    if (key === 'q') spawnClientLocalVineTrap(side, worldDx, worldDz, tap, mag);
    else if (key === 'e') spawnClientLocalDash(side, worldDx, worldDz);
  }
  sendOrApplyEvent({ type: 'skill', key, dx: worldDx, dz: worldDz, tap, mag });
}

// ============================================================
// Klient-prediktion för Legolas-skills i arena MP. Host kör auktoritativ
// simulering men arena-broadcasten skickar bara hero-snaps, inte entity-listor
// som vineTraps/bigArrows. Utan dessa client-side spawns ser klienten bara
// cast-ringen från triggerClientVisualSkill och inget mer. Spawn:ade entries
// är markerade localOnly:true så updateVineTrapsSolo/tickBigArrows skippar
// damage- och hit-detection (de fade:as bara visuellt).
// ============================================================

function spawnClientLocalVineTrap(side, worldDx, worldDz, tap, mag) {
  const ev = { dx: worldDx, dz: worldDz, tap, mag };
  const center = soloResolveSkillGroundTarget(side, ev, VINE_TRAP_CAST_DISTANCE);
  spawnSkillCastFx(side.hero.x, side.hero.z, 0x66cc44, 0.9);
  spawnShieldBurstFx(center.x, center.z, 0x88dd55);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(VINE_TRAP_RADIUS * 0.85, VINE_TRAP_RADIUS, 36),
    new THREE.MeshBasicMaterial({ color: 0x4a8030, transparent: true, opacity: 0.65, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(center.x, 0.07, center.z);
  scene.add(ring);
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(VINE_TRAP_RADIUS, 32),
    new THREE.MeshBasicMaterial({ color: 0x55cc44, transparent: true, opacity: 0.20, side: THREE.DoubleSide })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(center.x, 0.05, center.z);
  scene.add(glow);
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
    ring, spikes, glow,
    x: center.x, z: center.z,
    life: VINE_TRAP_DURATION, maxLife: VINE_TRAP_DURATION,
    radius: VINE_TRAP_RADIUS,
    localOnly: true,
  });
}

function spawnClientLocalBigArrow(side, worldDx, worldDz, tap) {
  let dx = worldDx || 0, dz = worldDz || 0;
  // Tap-aim: använd target-riktning om vi har en target (samma som applyEvent på host)
  if (tap === true && side.targetId) {
    const opp = sides[3 - side.idx];
    const t = resolveTargetEntity(side, opp);
    if (t && t.mesh) {
      const ddx = t.mesh.position.x - side.hero.x;
      const ddz = t.mesh.position.z - side.hero.z;
      const m = Math.hypot(ddx, ddz);
      if (m > 0.01) { dx = ddx / m; dz = ddz / m; }
    }
  }
  const len = Math.hypot(dx, dz);
  if (len < 0.01) { dx = side.hero.facingX; dz = side.hero.facingZ; }
  else { dx /= len; dz /= len; }
  // Mesh-bygge: samma kod som hostCastLegolasUlt så det blir visuellt identiskt.
  const grp = new THREE.Group();
  const shaftMat = new THREE.MeshStandardMaterial({
    color: 0x8a6028, roughness: 0.45, emissive: 0xaaff55, emissiveIntensity: 0.7, metalness: 0.3,
  });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, ULT_ARROW_LENGTH, 14), shaftMat);
  shaft.rotation.x = Math.PI / 2;
  grp.add(shaft);
  const tipMat = new THREE.MeshStandardMaterial({
    color: 0xddff88, emissive: 0xaaff55, emissiveIntensity: 2.0, metalness: 0.6, roughness: 0.2,
  });
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.8, 14), tipMat);
  tip.rotation.x = Math.PI / 2;
  tip.position.z = ULT_ARROW_LENGTH / 2 + 0.85;
  grp.add(tip);
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0x88ff44, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false,
  });
  const halo = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, ULT_ARROW_LENGTH + 1.0, 16), haloMat);
  halo.rotation.x = Math.PI / 2;
  grp.add(halo);
  const featherMat = new THREE.MeshBasicMaterial({ color: 0xccff88, transparent: true, opacity: 0.92, side: THREE.DoubleSide });
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2;
    const feather = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 1.1), featherMat);
    feather.position.set(Math.cos(ang) * 0.28, Math.sin(ang) * 0.28, -ULT_ARROW_LENGTH / 2 + 0.6);
    feather.rotation.z = ang;
    grp.add(feather);
  }
  const leafGroup = new THREE.Group();
  leafGroup.position.z = ULT_ARROW_LENGTH / 2 + 0.4;
  const leafMat = new THREE.MeshBasicMaterial({ color: 0x66dd33, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  for (let i = 0; i < 3; i++) {
    const ang = (i / 3) * Math.PI * 2;
    const leaf = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.9), leafMat);
    leaf.position.set(Math.cos(ang) * 0.9, Math.sin(ang) * 0.9, 0);
    leaf.rotation.z = ang + Math.PI / 2;
    leafGroup.add(leaf);
  }
  grp.add(leafGroup);
  const arrowLight = new THREE.PointLight(0xaaff55, 2.4, 6);
  arrowLight.position.z = ULT_ARROW_LENGTH / 2;
  grp.add(arrowLight);
  grp.rotation.y = Math.atan2(dx, dz);
  grp.position.set(side.hero.x, 1.0, side.hero.z);
  scene.add(grp);
  side.bigArrows = side.bigArrows || [];
  side.bigArrows.push({
    mesh: grp,
    dx, dz,
    traveled: 0,
    maxRange: ULT_ARROW_MAX_RANGE,
    leafGroup,
    trailAccum: 0,
    localOnly: true,
  });
  spawnSkillCastFx(side.hero.x, side.hero.z, 0x88ff44, 1.8);
  spawnShieldBurstFx(side.hero.x, side.hero.z, 0xaaff66);
  triggerCameraShake(0.18, 0.25);
}

function spawnClientLocalDash(side, worldDx, worldDz) {
  let dx = worldDx || 0, dz = worldDz || 0;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) { dx = side.hero.facingX; dz = side.hero.facingZ; }
  else { dx /= len; dz /= len; }
  let dist = LEGOLUS_DASH_DISTANCE, nx = side.hero.x, nz = side.hero.z;
  while (dist >= 0.5) {
    const tx = side.hero.x + dx * dist;
    const tz = side.hero.z + dz * dist;
    if (isHeroWalkable(side.idx, tx, tz)) { nx = tx; nz = tz; break; }
    dist -= 0.5;
  }
  if (dist < 0.5) return;
  spawnSkillCastFx(side.hero.x, side.hero.z, 0x66ff88, 0.7);
  side.hero.x = nx; side.hero.z = nz;
  if (side.mesh) { side.mesh.position.x = nx; side.mesh.position.z = nz; }
  spawnSkillCastFx(nx, nz, 0x66ff88, 0.7);
}

function sendOrApplyEvent(ev) {
  // Boss Wars MP-klient: events buffras och skickas till host i b-input
  if (bossMpState.matchActive && bossMpState.role === 'client') {
    bossMpState.pendingEvents.push(ev);
    return;
  }
  // Boss Wars MP-host: applicera lokalt (host kör auth-sim)
  if (bossMpState.matchActive && bossMpState.role === 'host') {
    applyEvent(sides[APP.localSide], ev);
    return;
  }
  if (APP.mode === 'solo' || (isArenaMp() && APP.mode === 'host')) {
    // Solo + arena-host kör simulering lokalt — applicera event direkt
    applyEvent(sides[APP.localSide], ev);
  } else if (APP.mode === 'host' || APP.mode === 'client') {
    // Klassisk MP / arena-client: events går via relay
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
// Network rates: med klient-interpolation (smoothEntityMeshes lerpar mesh.position
// mot _target varje frame vid 60 fps, 80 ms halflife) ger 30 Hz broadcasts samma
// visuella smoothness som 45 Hz — men halva CPU + nätverk-pressen, vilket sänker
// risken för spikes och stutters på Render's free-tier-server och högre RTT.
const INPUT_SEND_INTERVAL = 1 / 30;        // 30 Hz input
// Arena state 20 Hz: matchar server-auktoritativ classic-MP-rate. Med 80 ms
// halflife interpolation + klient-prediction känns det smooth. Lägre rate =
// mindre nät+CPU-press = färre spikes på host's enhet och Render's free tier.
const ARENA_STATE_SEND_INTERVAL = 1 / 20;

function isMpMode() { return APP.mode === 'host' || APP.mode === 'client'; }
function isArenaMp() { return APP.gameMode === 'arena1v1' && (APP.mode === 'host' || APP.mode === 'client'); }

function flushClientInput() {
  if (!isMpMode() || !wsOpen()) return;
  // Arena-host kör lokalt och ska aldrig skicka client-input
  if (isArenaMp() && APP.mode === 'host') return;
  const raw = readLocalJoystick();
  const dir = screenToWorld(raw.x, raw.z);
  const evs = APP.pendingEvents;
  APP.pendingEvents = [];
  // I arena-MP: skicka som 'a-input' till host (peer-to-peer), inte 'in' till server
  if (isArenaMp() && APP.mode === 'client') {
    sendGameMsg({ t: 'a-input', jx: dir.x, jz: dir.z, events: evs });
  } else {
    sendGameMsg({ t: 'in', j: { x: dir.x, z: dir.z }, ev: evs });
  }
  lastInputJoy = dir;
}

function maybeSendClientInput(now) {
  if (!isMpMode() || !wsOpen()) return;
  // Arena MP: bara client skickar input (host kör simulering lokalt)
  if (isArenaMp() && APP.mode !== 'client') return;
  // Klassisk MP är server-auktoritativ — BÅDE host och client skickar input
  // till servern. Tidigare blockerades host här ("klassisk host får server-state")
  // vilket gjorde att host's joystick-input aldrig nådde servern → host's hero
  // stod still i state, host upplevde lag/icke-fri rörelse. Decision 019 säger
  // explicit "Båda klienter blir tunna i MP (skickar inputs, renderar state)".
  if (now - APP.lastInputSent < INPUT_SEND_INTERVAL && APP.pendingEvents.length === 0) return;
  APP.lastInputSent = now;
  flushClientInput();
}

// ============================================================
// Boss Wars MP: in-match state sync (host-auktoritativ)
// ============================================================
// Host kör hela simuleringen, broadcastar state ~30 Hz. Klienterna
// renderar mottagen state och skickar input. Match-end avgörs av host.

// Bygger en snapshot för ett MP-boss-wars-state-meddelande
function buildBossWarsSnap() {
  // Hero snapshots för alla 3 sides (alla som existerar)
  const h = {};
  for (const idx of [1, 2, 3]) {
    const s = sides[idx];
    if (s) h[idx] = heroSnap(s);
  }
  // Boss snapshot: hitta isBossWarsBoss-monstret i sides[1].monsters.
  // OBS: bossens position bor på mesh.position, inte på m.x/m.z (som projektiler har).
  let boss = null;
  const hostSide = sides[1];
  if (hostSide && hostSide.monsters && hostSide.monsters.length) {
    const b = hostSide.monsters.find(m => m.isBossWarsBoss);
    if (b && b.mesh) {
      boss = {
        x: +b.mesh.position.x.toFixed(2),
        z: +b.mesh.position.z.toFixed(2),
        hp: Math.round(b.hp),
        mh: b.maxHp,
        ph: b.bossPhase || 1,
        pt: +(b.phaseTransitionRemaining || 0).toFixed(2),
        aac: b.aaCount || 0,           // AA-räknare för klient-visual (delta-detect)
        c: b.activeCast && b.activeCast.skill ? {
          n: b.activeCast.skill.id || '',
          k: b.activeCast.skill.kind || 'circle',
          rad: b.activeCast.skill.radius || 0,
          len: b.activeCast.skill.length || 0,
          ha: b.activeCast.skill.halfAngle || 0,
          w: b.activeCast.skill.width || 0,
          ph: b.activeCast.phase || 'telegraph',
          t: +(b.activeCast.timer || 0).toFixed(2),
          tg: +(b.activeCast.skill.telegraph || 0).toFixed(2),
          tx: b.activeCast.targetX != null ? +b.activeCast.targetX.toFixed(2) : null,
          tz: b.activeCast.targetZ != null ? +b.activeCast.targetZ.toFixed(2) : null,
          ox: b.activeCast.originX != null ? +b.activeCast.originX.toFixed(2) : null,
          oz: b.activeCast.originZ != null ? +b.activeCast.originZ.toFixed(2) : null,
          dx: b.activeCast.dirX != null ? +b.activeCast.dirX.toFixed(3) : null,
          dz: b.activeCast.dirZ != null ? +b.activeCast.dirZ.toFixed(3) : null,
        } : null,
      };
    }
  }
  return { h, b: boss, t: APP.bossWars && APP.bossWars.tier || 1 };
}

function broadcastBossWarsState() {
  if (bossMpState.role !== 'host' || !bossMpState.matchActive || !wsOpen()) return;
  // Defensiv: vänta tills sides[1] + boss faktiskt finns. Skyddar mot
  // edge-case där tick() fyrar mellan matchActive=true och enterPlayPhase().
  if (!sides[1] || !sides[1].monsters || !sides[1].bossWarsBossId) return;
  const snap = buildBossWarsSnap();
  sendGameMsg({
    t: 'b-state',
    h: snap.h,
    b: snap.b,
    tr: snap.t,
    ba: !!(APP.bossWars && APP.bossWars.bossActivated),   // boss aktiverad?
    gc: !!(APP.bossWars && APP.bossWars.gateClosed),       // gate stängd?
  });
}

function applyBossWarsState(msg) {
  // Bara klienter applicerar denna; host kör auth-sim
  if (bossMpState.role !== 'client' || !bossMpState.matchActive) return;
  // Boss-aktivering + gate-state (synkad från host)
  if (msg.ba !== undefined || msg.gc !== undefined) {
    applyBossWarsActivationFromSnap(msg.ba, msg.gc);
  }
  // Hero-snapshots — sätt position, hp, level för alla 3 sides
  if (msg.h) {
    for (const idx of [1, 2, 3]) {
      const snap = msg.h[idx];
      const s = sides[idx];
      if (s && snap) applyHeroSnap(s, snap);
    }
  }
  // Boss: skapa mesh om saknas, annars uppdatera position/hp/phase
  if (msg.b && sides[1]) {
    const hostSide = sides[1];
    let boss = hostSide.monsters && hostSide.monsters.find(m => m.isBossWarsBoss);
    if (!boss && !hostSide._bossSpawnRequested) {
      // Idempotens-guard: säkerställ att spawnBossWarsBoss bara körs en gång
      // på klienten även om b-state-meddelanden anländer snabbare än
      // monsters-arrayen uppdateras.
      hostSide._bossSpawnRequested = true;
      spawnBossWarsBoss(hostSide, msg.tr || 1);
      boss = hostSide.monsters.find(m => m.isBossWarsBoss);
    } else if (!boss) {
      // Spawn pågår, hoppa över denna tick
      return;
    }
    if (boss && boss.mesh) {
      // Smooth-interpolation: sätt _target istället för direkt position.
      // smoothEntityMeshes lerpar mesh.position mot _target varje frame.
      // Mutera befintligt _target-objekt om det finns (mindre GC).
      if (!boss.mesh._target) {
        boss.mesh.position.x = msg.b.x;
        boss.mesh.position.z = msg.b.z;
        boss.mesh._target = { x: msg.b.x, z: msg.b.z };
      } else {
        boss.mesh._target.x = msg.b.x;
        boss.mesh._target.z = msg.b.z;
      }
      // Delta-detection för visual events (host kör auth-sim; klient triggar
      // bara lokala visuals baserat på state-förändringar):

      // 1) Damage popup när boss-HP minskar
      const prevHp = boss._prevSyncedHp != null ? boss._prevSyncedHp : msg.b.hp;
      if (msg.b.hp < prevHp - 0.5 && boss.mesh) {
        spawnDamageText(boss.mesh, prevHp - msg.b.hp);
      }
      boss._prevSyncedHp = msg.b.hp;

      // 2) Boss AA-trigger (för attack-animation)
      const prevAac = boss._prevSyncedAac || 0;
      const newAac = msg.b.aac || 0;
      if (newAac > prevAac && boss.mesh.userData) {
        boss.mesh.userData.attackTrigger = true;
      }
      boss._prevSyncedAac = newAac;

      // 3) Boss skill telegraph — spawna lokal mesh när host startar ny cast
      const newCast = msg.b.c;
      const newCastKey = newCast ? `${newCast.n}|${newCast.ph}` : '';
      const prevCastKey = boss._prevSyncedCastKey || '';
      if (newCastKey !== prevCastKey) {
        // Cleanup gammal telegraph-mesh
        if (boss._syncedTelegraph) {
          scene.remove(boss._syncedTelegraph);
          boss._syncedTelegraph.traverse?.(o => {
            if (o.geometry) o.geometry.dispose?.();
            if (o.material) o.material.dispose?.();
          });
          boss._syncedTelegraph = null;
        }
        // Spawna ny om vi nu är i telegraph-fas
        if (newCast && newCast.ph === 'telegraph' && newCast.n) {
          const pseudoSkill = {
            id: newCast.n,
            kind: newCast.k || 'circle',
            radius: newCast.rad || 0,
            length: newCast.len || 0,
            halfAngle: newCast.ha || 0,
            width: newCast.w || 0,
            telegraph: newCast.tg || 1,
          };
          const pseudoCast = {
            skill: pseudoSkill,
            phase: 'telegraph',
            timer: newCast.t || 0,
            dirX: newCast.dx != null ? newCast.dx : 0,
            dirZ: newCast.dz != null ? newCast.dz : 1,
            originX: newCast.ox != null ? newCast.ox : boss.mesh.position.x,
            originZ: newCast.oz != null ? newCast.oz : boss.mesh.position.z,
            targetX: newCast.tx,
            targetZ: newCast.tz,
            telegraphMesh: null,
          };
          spawnBossTelegraph(null, boss, pseudoCast);
          boss._syncedTelegraph = pseudoCast.telegraphMesh;
        }
      }
      boss._prevSyncedCastKey = newCastKey;

      boss.hp = msg.b.hp;
      boss.maxHp = msg.b.mh;
      const prevPhase = boss._prevSyncedPhase || 1;
      boss.bossPhase = msg.b.ph || 1;
      boss.phaseTransitionRemaining = msg.b.pt || 0;
      // Delta-detection: fas växlade 1 → 2 → lägg på phase-2-aura på klienten.
      // Idempotent — applyBossPhase2Glow returnerar tidigt om aura redan finns.
      if (boss.bossPhase === 2 && prevPhase !== 2 && boss.mesh) {
        applyBossPhase2Glow(boss.mesh, msg.tr || boss.bossTier || 1);
      }
      boss._prevSyncedPhase = boss.bossPhase;
    }
  }
}

// Klient → host: skicka local input (joystick + events) ~45 Hz
function sendBossWarsInput() {
  if (bossMpState.role !== 'client' || !bossMpState.matchActive) return;
  if (!wsOpen()) {
    // WS nere — släng buffrade events så pendingEvents inte växer obegränsat
    bossMpState.pendingEvents = [];
    return;
  }
  const raw = readLocalJoystick();
  const dir = screenToWorld(raw.x, raw.z);
  const evs = bossMpState.pendingEvents;
  bossMpState.pendingEvents = [];
  sendGameMsg({
    t: 'b-input',
    p: bossMpState.peerIdx,
    jx: +dir.x.toFixed(3),
    jz: +dir.z.toFixed(3),
    ev: evs,
  });
}

// Host: applicera mottagen klient-input i simulateAll-loopen
function applyBossWarsRemoteInputs(dt) {
  if (bossMpState.role !== 'host' || !bossMpState.matchActive) return;
  for (const idx of [2, 3]) {
    const ri = bossMpState.remoteInput[idx];
    const s = sides[idx];
    if (!s || !ri) continue;
    applyMovement(s, ri.jx || 0, ri.jz || 0, dt);
    if (Array.isArray(ri.ev) && ri.ev.length) {
      for (const ev of ri.ev) applyEvent(s, ev);
      ri.ev = [];
    }
  }
}
function handleNetworkMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'st' && isMpMode() && APP.gameMode !== 'arena1v1') {
    applyRemoteState(msg);
    return;
  }
  // Arena MP-meddelanden
  if (msg.t === 'a-input' && APP.mode === 'host' && isArenaMp()) {
    APP.remoteArenaInput = msg;  // konsumeras i simulateAll
    return;
  }
  if (msg.t === 'a-state' && APP.mode === 'client' && isArenaMp()) {
    applyArenaState(msg);
    return;
  }
  if (msg.t === 'a-ready' && APP.mode === 'host' && isArenaMp()) {
    if (msg.side === 1 || msg.side === 2) arenaState.ready[msg.side] = !!msg.value;
    return;
  }
  // Hero-pick i arena MP (peer-to-peer, server bypassad)
  if (msg.t === 'a-pick' && isArenaMp()) {
    if (heroPickState.active && heroPickState.mode !== 'solo') {
      heroPickState.oppSelected = msg.heroId || null;
      const oppHero = HEROES.find(h => h.id === heroPickState.oppSelected);
      if (heroPickState.oppConfirmed) {
        hpOppStatusEl.textContent = `Motståndaren klar: ${oppHero ? oppHero.name : msg.heroId}`;
      } else {
        hpOppStatusEl.textContent = `Motståndaren tittar på: ${oppHero ? oppHero.name : '...'}`;
      }
      refreshHeroCardUI();
    }
    return;
  }
  if (msg.t === 'a-pick-confirm' && isArenaMp()) {
    if (heroPickState.active && heroPickState.mode !== 'solo') {
      heroPickState.oppSelected = msg.heroId || heroPickState.oppSelected;
      heroPickState.oppConfirmed = true;
      const oppHero = HEROES.find(h => h.id === heroPickState.oppSelected);
      hpOppStatusEl.textContent = `Motståndaren klar: ${oppHero ? oppHero.name : '?'}`;
      refreshHeroCardUI();
      // Om vi också är confirm:ade → starta direkt
      if (heroPickState.confirmed) finishHeroPick();
    }
    return;
  }
  // Boss Wars MP-meddelanden (3-spelar co-op)
  if (msg.t === 'b-start' && bossMpState.active && bossMpState.role === 'client') {
    // Host gick till boss-pick. Vi stannar på wait-panel tills b-tier kommer.
    if (bossMpState.waitMsgEl) bossMpState.waitMsgEl.textContent = 'Hosten väljer boss... vänta...';
    return;
  }
  if (msg.t === 'b-tier' && bossMpState.active && bossMpState.role === 'client' && !bossMpState.matchActive) {
    // Host har valt boss-tier. Klient går nu in i hero-pick parallellt.
    // bossWarsStartFight sätter APP.bossWars + visar hero-pick. Host:s sändare-block
    // körs inte eftersom vi är client.
    bossWarsStartFight(msg.tier || 1);
    return;
  }
  if (msg.t === 'b-launch' && bossMpState.active && bossMpState.role === 'client') {
    bossMpClientEnterMatch(msg);
    return;
  }
  if (msg.t === 'b-ready' && bossMpState.active && bossMpState.role === 'host' && !bossMpState.matchActive) {
    // Klient klar med pick + prep. Spara payload + kolla om alla peers är klara.
    bossMpState.peersReady = bossMpState.peersReady || {};
    bossMpState.peersReady[msg.p] = {
      hero: msg.hero || 'magiker',
      tals: Array.isArray(msg.tals) ? msg.tals.slice() : [],
      items: Array.isArray(msg.items) ? msg.items.slice() : [],
    };
    updateBossPrepWaitingStatus();
    maybeLaunchBossMp();
    return;
  }
  if (msg.t === 'b-state' && bossMpState.active && bossMpState.role === 'client' && bossMpState.matchActive) {
    applyBossWarsState(msg);
    return;
  }
  if (msg.t === 'b-input' && bossMpState.active && bossMpState.role === 'host' && bossMpState.matchActive) {
    const idx = msg.p;
    if (idx === 2 || idx === 3) bossMpState.remoteInput[idx] = msg;
    return;
  }
  if (msg.t === 'b-end' && bossMpState.active && bossMpState.role === 'client') {
    // Host detekterade match-slut → klient triggar samma end-screen.
    // Konvention: winner=1 = spelaren vann, winner=2 = bossen vann.
    matchState.gameOver = true;
    matchState.gameWon = !!msg.won;
    matchState.winner = msg.won ? 1 : 2;
    return;
  }
  if (msg.t === 'a-talent' && APP.mode === 'host' && isArenaMp()) {
    const t = arenaState.talents[msg.side];
    if (t) {
      const idx = t.chosen.indexOf(msg.talentId);
      if (msg.remove && idx >= 0) {
        t.chosen.splice(idx, 1);
        t.points += 1;
      } else if (!msg.remove && idx < 0 && t.points > 0) {
        t.chosen.push(msg.talentId);
        t.points -= 1;
      }
      const s = sides[msg.side];
      if (s) recomputeArenaSideStats(s);
    }
    return;
  }
}

// Bygger en snapshot av en sidas hero-state till klienten
function heroSnap(side) {
  if (!side) return null;
  return {
    x: side.hero.x, z: side.hero.z,
    fx: side.hero.facingX, fz: side.hero.facingZ,
    hp: side.hero.hp, mh: side.hero.maxHp,
    d: side.hero.dead,
    sh: side.shield || 0,
    lv: side.level,
    sk: { q: side.skills.q.cd, f: side.skills.f.cd, e: side.skills.e.cd },
    hid: side.heroId || 'magiker',
    ac: side.attackCounter || 0,
    g: side.gold || 0,
    ue: side.ultEnergy || 0,
    tnt: +(side.hero.tauntedTime || 0).toFixed(2),
    // CC-state: klient-prediction behöver dessa för att respektera stuns/freeze
    // (annars rör sig hjälten lokalt under stun → ful rubber-band vid snap-tillbaka).
    fzt: +(side.hero.frozenTime || 0).toFixed(2),
    fer: +(side.heroFearTime || 0).toFixed(2),
    ibr: +(side.iceBlockRemaining || 0).toFixed(2),
    slm: +(side.heroSlowMul != null ? side.heroSlowMul : 1).toFixed(3),
    slt: +(side.heroSlowTime || 0).toFixed(2),
  };
}

function applyHeroSnap(side, snap) {
  if (!side || !snap) return;
  // Lokal MP-klient kör klient-side prediction för EGEN hjälte (applyMovement
  // varje frame i tick()). Det ger instant input-respons trots ~150 ms RTT
  // till host. Här applicerar vi ENBART reconciliation om vår predicterade
  // position avviker mycket från host (knockback, wall-hit, stun, etc.).
  const isLocalMpClient = (
    side.idx === APP.localSide &&
    ((APP.mode === 'client' && isArenaMp()) ||
     (bossMpState && bossMpState.matchActive && bossMpState.role === 'client' && APP.gameMode === 'bosswars'))
  );
  // isMpClientForVisuals = true om vi inte kör simuleringen lokalt och därför
  // behöver delta-detection för att visa fx från andra spelares casts. Gäller
  // arena MP-klient, boss MP-klient OCH alla classic-MP-deltagare (server-auth
  // — varken host eller client kör skill-logik lokalt).
  const isClassicMpForVis = (APP.mode === 'host' || APP.mode === 'client') && APP.gameMode === 'classic';
  const isMpClientForVisuals = (
    (APP.mode === 'client' && isArenaMp()) ||
    (bossMpState && bossMpState.matchActive && bossMpState.role === 'client' && APP.gameMode === 'bosswars') ||
    isClassicMpForVis
  );
  // Capture prev values för delta-detection (AA-fire, skill-cast, ult-cast)
  const prevAc = side.attackCounter || 0;
  const prevQcd = side.skills?.q?.cd || 0;
  const prevFcd = side.skills?.f?.cd || 0;
  const prevEcd = side.skills?.e?.cd || 0;
  const prevUe = side.ultEnergy || 0;

  if (isLocalMpClient) {
    // Reconcile: snap till host om diff > 2.5 enheter (knockback, teleport, stun)
    if (side.mesh) {
      const dx = side.hero.x - snap.x;
      const dz = side.hero.z - snap.z;
      if (dx * dx + dz * dz > 6.25) {
        side.hero.x = snap.x;
        side.hero.z = snap.z;
        side.mesh.position.x = snap.x;
        side.mesh.position.z = snap.z;
      }
      // Rensa _target så smoothEntityMeshes inte fightar applyMovement
      side.mesh._target = null;
    }
    // Facing från host (för AA-target-riktning, ej kontroversiell)
    side.hero.facingX = snap.fx;
    side.hero.facingZ = snap.fz;
  } else {
    side.hero.x = snap.x;
    side.hero.z = snap.z;
    side.hero.facingX = snap.fx;
    side.hero.facingZ = snap.fz;
  }

  const wasDead = side.hero.dead;
  side.hero.hp = snap.hp;
  side.hero.maxHp = snap.mh;
  side.hero.dead = !!snap.d;
  side.shield = snap.sh;
  side.level = snap.lv;
  // Sticky-aware cd-update för Q/F/E: efter att klient klickat skill lokalt
  // satte vi cd = max optimistiskt. Om broadcast bär lägre cd än vår lokala
  // (host hade inte hunnit applicera när broadcasten skickades), behåll lokal
  // i ~500 ms så klient inte snap:ar tillbaka cd → tillåter dubbel-klick.
  // För OWN local side i MP: sticky check. Annars: trust host direkt.
  const nowPerf = performance.now();
  const isOwnLocalSide = (side.idx === APP.localSide && isMpClientForVisuals);
  const setCdSticky = (k) => {
    const skill = side.skills?.[k];
    if (!skill || !snap.sk) return;
    const snapCd = snap.sk[k] || 0;
    if (isOwnLocalSide) {
      const localCast = skill._localCastAt || 0;
      const isRecent = nowPerf - localCast < 500;
      if (isRecent && skill.cd > snapCd) {
        // Keep local cd — host's broadcast hasn't caught up yet
        return;
      }
    }
    skill.cd = snapCd;
  };
  setCdSticky('q'); setCdSticky('f'); setCdSticky('e');
  side.attackCounter = snap.ac;
  if (snap.g !== undefined) side.gold = snap.g;
  // Ult-energy: sticky local optimism (om vi just castade ult lokalt och host's
  // broadcast inte hunnit reflektera ännu, behåll vår 0). Annars trust host.
  if (snap.ue !== undefined) {
    const recentUlt = side._localUltCastAt && (nowPerf - side._localUltCastAt < 600);
    if (recentUlt && snap.ue > (side.ultEnergy || 0)) {
      // Keep local 0 — host hasn't seen our ult cast yet
    } else {
      side.ultEnergy = snap.ue;
    }
  }
  if (snap.tnt !== undefined) side.hero.tauntedTime = snap.tnt;
  // CC-state: applicerar ALLTID (även för lokal sida) så prediction respekterar
  // stun/freeze/fear/slow. Annars rör sig hjälten visuellt under CC, sen rycker
  // tillbaka via reconciliation = ful rubber-band.
  if (snap.fzt !== undefined) side.hero.frozenTime = snap.fzt;
  if (snap.fer !== undefined) side.heroFearTime = snap.fer;
  if (snap.ibr !== undefined) side.iceBlockRemaining = snap.ibr;
  if (snap.slm !== undefined) side.heroSlowMul = snap.slm;
  if (snap.slt !== undefined) side.heroSlowTime = snap.slt;
  if (side.mesh) {
    if (!isLocalMpClient) {
      // Non-local: _target-baserad interpolation (smoothEntityMeshes lerpar
      // mesh.position mot _target vid 60 fps med 80 ms halflife).
      const heroRy = (snap.fx || snap.fz) ? Math.atan2(snap.fx, snap.fz) : (side.mesh._target?.ry ?? side.mesh.rotation.y);
      if (!side.mesh._target) {
        side.mesh.position.x = snap.x;
        side.mesh.position.z = snap.z;
        side.mesh.rotation.y = heroRy;
        side.mesh._target = { x: snap.x, z: snap.z, ry: heroRy };
      } else {
        side.mesh._target.x = snap.x;
        side.mesh._target.z = snap.z;
        side.mesh._target.ry = heroRy;
      }
    }
    if (side.heroId !== snap.hid) {
      side.heroId = snap.hid;
      swapHeroMeshIfNeeded(side);
    }
    // I arena: behåll mesh synlig vid död så GLTF Death-anim körs
    if (APP.gameMode !== 'arena1v1') {
      side.mesh.visible = !side.hero.dead;
    }
  }
  // Visual delta-detection: trigga lokala visuals när host's broadcast
  // indikerar att hjälte just AAt eller castade skill. Endast på MP-client
  // (host kör simulateAll → spawnar riktiga projektiler).
  if (isMpClientForVisuals && side.mesh && !side.hero.dead) {
    if ((snap.ac || 0) > prevAc) triggerClientVisualAA(side);
    if ((snap.sk?.q || 0) > prevQcd + 0.5) triggerClientVisualSkill(side, 'q');
    if ((snap.sk?.f || 0) > prevFcd + 0.5) triggerClientVisualSkill(side, 'f');
    if ((snap.sk?.e || 0) > prevEcd + 0.5) triggerClientVisualSkill(side, 'e');
    // Ult-cast detection: ultEnergy droppade markant från höjd till lågt
    // (host konsumerade ult-meter). Trigger visual för andra peers — för own
    // sida har triggerClientVisualSkill(side, 'r') redan fyrat i castLocalSkill.
    if (prevUe > 40 && (snap.ue || 0) < prevUe - 30 && side.idx !== APP.localSide) {
      triggerClientVisualSkill(side, 'r');
    }
  }
}

// Host: broadcast hela arena-overlay-state (inkl båda heroes) till klienten
function broadcastArenaState() {
  if (APP.mode !== 'host' || !wsOpen() || !isArenaMp()) return;
  sendGameMsg({
    t: 'a-state',
    ph: arenaState.phase,
    rn: arenaState.roundNum,
    w: arenaState.wins,
    pt: arenaState.prepTimer,
    sst: arenaState.startingTimer,
    spl: arenaState.startingPhaseShown,
    et: arenaState.endTimer,
    rw: arenaState.roundWinner,
    mw: arenaState.matchWinner,
    rdy: arenaState.ready,
    tal: {
      1: { p: arenaState.talents[1].points, c: arenaState.talents[1].chosen.slice() },
      2: { p: arenaState.talents[2].points, c: arenaState.talents[2].chosen.slice() },
    },
    o: { hp: arenaState.orb.hp, a: arenaState.orb.alive, sp: arenaState.orb.spawnTimer },
    mp: arenaState.mapIdx || 0,
    sr: +(arenaState.shrinkRadius || 0).toFixed(2),
    ft: +(arenaState.fightTimer || 0).toFixed(2),
    h1: heroSnap(sides[1]),
    h2: heroSnap(sides[2]),
  });
}

// Client: ta emot a-state och applicera lokalt.
function applyArenaState(msg) {
  if (APP.mode !== 'client' || !isArenaMp()) return;
  const prevPhase = arenaState.phase;
  const prevRound = arenaState.roundNum;
  arenaState.phase = msg.ph;
  arenaState.roundNum = msg.rn;
  if (msg.mp !== undefined && arenaState.mapIdx !== msg.mp) {
    arenaState.mapIdx = msg.mp;
    // Bygg om arena-scenen med den valda mappen
    if (arenaSceneGroup.userData.mapIdx !== msg.mp) buildArenaScene();
  }
  if (msg.sr !== undefined) arenaState.shrinkRadius = msg.sr;
  if (msg.ft !== undefined) arenaState.fightTimer = msg.ft;
  // Använd numeriska keys för wins/ready så vi inte blandar med strings efter JSON-roundtrip
  arenaState.wins[1] = (msg.w && msg.w[1]) || 0;
  arenaState.wins[2] = (msg.w && msg.w[2]) || 0;
  arenaState.prepTimer = msg.pt;
  arenaState.startingTimer = msg.sst;
  arenaState.startingPhaseShown = msg.spl;
  arenaState.endTimer = msg.et;
  arenaState.roundWinner = msg.rw;
  arenaState.matchWinner = msg.mw;
  // Sync opp:s ready från host. Behåll LOKALA ready för own-side så klientens
  // optimistiska "Ready ✓" inte överskrivs innan host hunnit få vår a-ready-msg.
  const _localReady = arenaState.ready[APP.localSide];
  arenaState.ready[1] = !!(msg.rdy && msg.rdy[1]);
  arenaState.ready[2] = !!(msg.rdy && msg.rdy[2]);
  if (_localReady) {
    arenaState.ready[APP.localSide] = true;   // sticky local optimism
    // Om host:ens broadcast INTE har vår ready=true → host har inte fått vår
    // a-ready-msg. Re-skicka. (Pattern: at-least-once delivery via retry varje
    // state-tick tills host bekräftar.)
    if (!msg.rdy || !msg.rdy[APP.localSide]) {
      sendGameMsg({ t: 'a-ready', side: APP.localSide, value: true });
    }
  }
  // Talents — sticky local-authority för EGNA val + at-least-once retry för
  // motsidans val. Bakgrund: vid 45 Hz state-broadcast kan en stale broadcast
  // (skickad innan host hunnit få klientens a-talent) anlända mellan klick och
  // bekräftelse — det skulle annars rulla tillbaka det optimistiska valet i UI:n.
  const _localTalentSide = APP.localSide;
  const _localChosenPrev = (arenaState.talents[_localTalentSide]?.chosen || []).slice();
  // Motståndarens sida(or): host är auktoritativ, skriv över direkt.
  for (const idx of [1, 2]) {
    if (idx === _localTalentSide) continue;
    if (msg.tal[idx]) {
      arenaState.talents[idx].points = msg.tal[idx].p;
      arenaState.talents[idx].chosen = msg.tal[idx].c.slice();
    }
  }
  // Egen sida: jämför host-vy med lokal vy. Matchar de = accept host-punkter (täcker
  // +1 vid round-start). Skiljer de sig = behåll lokal chosen, re-skicka diff-actions
  // tills host hunnit applicera (idempotent på host-sidan).
  if (msg.tal[_localTalentSide]) {
    const hostChosen = msg.tal[_localTalentSide].c || [];
    const hostSet = new Set(hostChosen);
    const localSet = new Set(_localChosenPrev);
    const equal = hostChosen.length === _localChosenPrev.length &&
      _localChosenPrev.every(t => hostSet.has(t));
    if (equal) {
      arenaState.talents[_localTalentSide].points = msg.tal[_localTalentSide].p;
    } else {
      // Re-skicka actions för att täcka diff
      for (const tid of _localChosenPrev) {
        if (!hostSet.has(tid)) {
          sendGameMsg({ t: 'a-talent', side: _localTalentSide, talentId: tid, remove: false });
        }
      }
      for (const tid of hostChosen) {
        if (!localSet.has(tid)) {
          sendGameMsg({ t: 'a-talent', side: _localTalentSide, talentId: tid, remove: true });
        }
      }
      // Behåll lokal chosen (skriv inte över); UI stannar synkad med användarens klick.
    }
  }
  // Orb
  const orbWasAlive = arenaState.orb.alive;
  arenaState.orb.hp = msg.o.hp;
  arenaState.orb.alive = msg.o.a;
  arenaState.orb.spawnTimer = msg.o.sp;
  if (arenaOrbMesh) arenaOrbMesh.visible = arenaState.orb.alive;
  if (!orbWasAlive && arenaState.orb.alive) {
    // Orb spawnade — spela FX lokalt också
    spawnSkillCastFx(ARENA_CFG.orb.x, ARENA_CFG.orb.z, 0x55ffcc, 1.6);
    spawnShieldBurstFx(ARENA_CFG.orb.x, ARENA_CFG.orb.z, 0x55ffcc);
    showOrbBanner('ORB UPPENBARAR SIG', '#88ffdd');
  } else if (orbWasAlive && !arenaState.orb.alive) {
    // Orb dog
    spawnShieldBurstFx(ARENA_CFG.orb.x, ARENA_CFG.orb.z, 0x88ffdd);
    triggerCameraShake(0.4, 0.45);
  }
  // Hero-snapshots
  applyHeroSnap(sides[1], msg.h1);
  applyHeroSnap(sides[2], msg.h2);
  // UI-fas-transitions
  if (prevPhase !== arenaState.phase) {
    if (arenaState.phase === 'prep') {
      hideArenaEnd();
      hideArenaCountdown();
      showArenaPrep();
    } else if (arenaState.phase === 'starting') {
      hideArenaPrep();
      showArenaCountdown(arenaState.startingPhaseShown || '3');
    } else if (arenaState.phase === 'starting-end') {
      // FIGHT! visas
      showArenaCountdown('FIGHT!', true);
    } else if (arenaState.phase === 'fight') {
      hideArenaPrep();
      hideArenaCountdown();
      hideArenaEnd();
    } else if (arenaState.phase === 'roundEnd') {
      showArenaEnd(arenaState.roundWinner, false);
    } else if (arenaState.phase === 'matchEnd') {
      showArenaEnd(arenaState.matchWinner, true);
    }
  } else if (arenaState.phase === 'starting') {
    // Uppdatera countdown-text när phase-shown ändras
    const lbl = arenaState.startingPhaseShown;
    if (lbl) {
      const isFight = lbl.toUpperCase().startsWith('F');
      const cur = (typeof acTextEl !== 'undefined' && acTextEl) ? acTextEl.textContent : null;
      if (cur !== lbl) showArenaCountdown(lbl, isFight);
    }
  }
  // Uppdatera prep-UI om i prep-fas (timer, points, ready)
  if (arenaState.phase === 'prep') {
    updateArenaPrepUI();
    // VIKTIGT: anropa INTE renderTalentsGrid här. Den rebuildar hela
    // DOM:en via innerHTML='' och vid 45 Hz broadcast skulle klick-events
    // ätas (mouseDown/Up spänner över flera renders → click landar på
    // detached DOM-nod). Grid renderas explicit via:
    //   1) showArenaPrep vid fas-transition till prep (täcker round-start +1)
    //   2) onTalentPick vid lokal användarklick
    // Points-display + ready-knapp uppdateras via updateArenaPrepUI utan
    // att röra grid-DOM:en (säker mot click-eating).
  }
  // Recompute stats för lokal sida — bara om talents-listan faktiskt ändrats.
  // Annars är det wasted CPU att iterera alla talents/items varje broadcast.
  const localSide = sides[APP.localSide];
  if (localSide) {
    const _talentsHash = JSON.stringify(arenaState.talents[APP.localSide]?.chosen || []);
    if (_talentsHash !== _lastRecomputedTalentsHash) {
      _lastRecomputedTalentsHash = _talentsHash;
      recomputeArenaSideStats(localSide);
    }
  }
}

// ---- Hero pick-skärm ----
// 10 hjältar — endast Magikern available just nu.
// Duel-state speglas från server (eller default i solo)
const duelState = {
  active: false, timer: 0, matchTimer: 0, count: 0, lastWinner: 0, announceTimer: 0,
  startBannerMs: 0,
};
// Pickup-orbs som syns under duel (id → { group, age })
const duelOrbMeshes = new Map();

function makeDuelOrbMesh(type) {
  const grp = new THREE.Group();
  const isHeal = type === 'h' || type === 'heal';
  const color = isHeal ? 0x55ff7a : 0xffd34a;
  const emissive = isHeal ? 0x22aa44 : 0xff9020;
  // Central glow-sphere
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.35, 1),
    new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: 1.4, roughness: 0.25, metalness: 0.1 })
  );
  core.position.y = 0.9;
  grp.add(core);
  // Halo-ring
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(0.50, 0.04, 8, 28),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 })
  );
  halo.position.y = 0.9;
  halo.rotation.x = Math.PI / 2;
  grp.add(halo);
  // Ground-mark ring
  const ground = new THREE.Mesh(
    new THREE.RingGeometry(0.45, 0.65, 28),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0.36;
  grp.add(ground);
  // Pointlight
  const light = new THREE.PointLight(color, 0.7, 4, 2);
  light.position.y = 0.9;
  grp.add(light);
  // Icon ovanför (sphere som matchar typ)
  if (isHeal) {
    // Plus-symbol av två boxes ovanför
    const plusMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const ph = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.07, 0.07), plusMat);
    ph.position.y = 0.9;
    grp.add(ph);
    const pv = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.30, 0.07), plusMat);
    pv.position.y = 0.9;
    grp.add(pv);
  } else {
    // Pil/wing-symbol
    const wing = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.30, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    wing.position.y = 0.9;
    wing.rotation.z = Math.PI / 2;
    grp.add(wing);
  }
  grp.userData.orbType = isHeal ? 'heal' : 'speed';
  return grp;
}

function syncDuelOrbsFromState(orbList) {
  const seen = new Set();
  for (const o of (orbList || [])) {
    seen.add(o.i);
    let entry = duelOrbMeshes.get(o.i);
    if (!entry) {
      const grp = makeDuelOrbMesh(o.k);
      grp.position.set(o.x, 0, o.z);
      scene.add(grp);
      entry = { grp, age: 0 };
      duelOrbMeshes.set(o.i, entry);
    } else {
      // Position kan justeras (men de rör sig inte i normalfallet)
      entry.grp.position.x = o.x;
      entry.grp.position.z = o.z;
    }
  }
  // Ta bort orbs som inte längre finns (consumed eller duel slut)
  for (const [id, entry] of duelOrbMeshes) {
    if (!seen.has(id)) {
      scene.remove(entry.grp);
      duelOrbMeshes.delete(id);
    }
  }
}

function tickDuelOrbVisual(dt) {
  // Bob + rotation
  for (const entry of duelOrbMeshes.values()) {
    entry.age += dt;
    entry.grp.position.y = Math.sin(entry.age * 3) * 0.10;
    entry.grp.rotation.y += dt * 1.3;
  }
}

function clearDuelOrbMeshes() {
  for (const entry of duelOrbMeshes.values()) scene.remove(entry.grp);
  duelOrbMeshes.clear();
}

// Big duel-arena orb (samma koncept som arena1v1 orb): spawnar i mitten av
// duel-arenan, 15s respawn efter kill, ger heal + shield till sista skadegivaren.
let duelBigOrbMeshState = null;
function ensureDuelBigOrbMesh() {
  if (duelBigOrbMeshState) return duelBigOrbMeshState;
  const grp = new THREE.Group();
  // Core: glowing sphere — turkos som arena-orb
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.85, 1),
    new THREE.MeshStandardMaterial({
      color: 0x55ffcc, emissive: 0x22aa88, emissiveIntensity: 1.4,
      roughness: 0.25, metalness: 0.4,
    })
  );
  core.position.y = 1.4;
  core.castShadow = true;
  grp.add(core);
  // Halo-ring runt
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(1.2, 0.10, 10, 32),
    new THREE.MeshBasicMaterial({ color: 0x88ffdd, transparent: true, opacity: 0.6 })
  );
  halo.position.y = 1.4;
  halo.rotation.x = Math.PI / 2;
  grp.add(halo);
  // Ground-ring
  const ground = new THREE.Mesh(
    new THREE.RingGeometry(1.1, 1.5, 32),
    new THREE.MeshBasicMaterial({ color: 0x55ffcc, transparent: true, opacity: 0.4, side: THREE.DoubleSide })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0.06;
  grp.add(ground);
  // Pointlight
  const light = new THREE.PointLight(0x55ffcc, 1.4, 8, 2);
  light.position.y = 1.4;
  grp.add(light);
  attachHpBar(grp, 2.4);
  scene.add(grp);
  duelBigOrbMeshState = { grp, core, halo, ground, light, age: 0 };
  return duelBigOrbMeshState;
}

function syncDuelBigOrbFromState(bo) {
  if (!bo) { clearDuelBigOrbMesh(); return; }
  const mesh = ensureDuelBigOrbMesh();
  mesh.grp.position.set(bo.x, 0, bo.z);
  mesh.grp.visible = !!bo.a;
  if (bo.a) {
    // Uppdatera HP-bar via standard-helper
    updateEntityHpBar(mesh.grp, bo.hp, bo.mh, performance.now() / 1000, 0);
  } else if (mesh.grp.userData.hpBar) {
    mesh.grp.userData.hpBar.visible = false;
  }
}

function clearDuelBigOrbMesh() {
  if (!duelBigOrbMeshState) return;
  duelBigOrbMeshState.grp.traverse(o => {
    if (o.isMesh) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }
  });
  scene.remove(duelBigOrbMeshState.grp);
  duelBigOrbMeshState = null;
}

function tickDuelBigOrbVisual(dt) {
  if (!duelBigOrbMeshState || !duelBigOrbMeshState.grp.visible) return;
  const m = duelBigOrbMeshState;
  m.age = (m.age || 0) + dt;
  m.core.rotation.y += dt * 1.2;
  m.core.position.y = 1.4 + Math.sin(m.age * 2.3) * 0.10;
  m.halo.rotation.z += dt * 1.7;
  m.halo.scale.setScalar(1 + 0.06 * Math.sin(m.age * 3.0));
  if (m.light) m.light.intensity = 1.2 + 0.5 * Math.sin(m.age * 2.5);
}

const HEROES = [
  { id: 'magiker',   name: 'Gandulf',     role: 'Mage',         initial: 'G',   available: true  },
  { id: 'legolas',   name: 'Legolus',     role: 'Archer',       initial: 'L',   available: true  },
  { id: 'gimlu',     name: 'Gimlu',       role: 'Tank',         initial: 'Gi',  available: true  },
  { id: 'aragurn',   name: 'Aragurn',     role: 'Warrior',      initial: 'Ar',  available: true  },
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
      q: { name: 'Wind Puff', icon: '💨', desc: 'Skickar en vindstöt i en kon framför Gandulf (5.5 m × 90°). Skadar alla träffade fiender med 20% av deras max-HP, pushar tillbaka dem 3 meter i vindens riktning, och applicerar en debuff (4s) som gör att de tar +20% mer skada av all efterföljande damage. Drag-aim styr riktning.' },
      f: { name: 'Frost Nova', icon: '❄', desc: 'AoE-explosion (3.8 m radie) vid target eller drag-position. Skadar och fryser fiender i 2 sekunder. Om en frusen fiende träffas av en ny skill splittras isen (shatter) och skickar ut shards som skadar närliggande fiender.' },
      e: { name: 'Black Hole', icon: '⚫', desc: 'Spawnar en black hole vid target/drag-position som lever i 3 sekunder. Suger in fiender mot mitten och tickar 3% av deras max-HP per sekund medan de står i radien. Vid slutet exploderar den i AoE-damage (4 m radie).' },
    },
    passive: { name: 'Soul Mark', icon: '✦', desc: 'Träffar du SAMMA mål med 3 OLIKA skills inom 3 sekunder så får target en mark som tickar 5% av dess current HP per sekund i 3 sekunder (DoT) — och healar Gandulf 10% av hans max HP per sekund under hela markens varaktighet. Kombinera Wind Puff + Frost Nova + Black Hole för max sustain.' },
    ult: { name: 'Arcane Beam', icon: '⚡', desc: 'Skjuter en kontinuerlig laserstråle rakt fram i 3 sekunder (60 m räckvidd, smal). Strålen tickar var 0.5 s och gör 15% av targets max-HP per tick — totalt 90% maxHP över hela varaktigheten. Träffar alla fiender, bossar, motståndarhjälte och arena-orb i strålens väg. Medan strålen är aktiv: 90% skadereduktion på Magikern, CC-immun (kan inte frysas/stunnas/tauntas) men kan röra sig fritt.' },
  },
  legolas: {
    skills: {
      q: { name: 'Vine Trap Rain', icon: '🌿', desc: 'Skjuter en pil i luften som regnar ner pilar över en zon i 3 sekunder. Gör inget direkt damage — bara DoT och rotar fiender på plats. Om Legolas själv står i sin egen trap får han 20% damage reduction och healar 5% av sin max-HP per sekund så länge han stannar i zonen.' },
      f: { name: 'Hunter\'s Focus', icon: '🎯', desc: '5 sekunders self-buff: +10% auto-attack damage, +10% crit chans, +30% crit damage, +30% attack speed.' },
      e: { name: 'Shadow Dash', icon: '💨', desc: 'Snabb dash framåt (4 m). 6 sek cooldown. Nästa auto-attack är garanterat crit + 20% lifesteal. Om den buffade AA dödar fienden, resetas dash-cooldown så du kan kedja.' },
    },
    passive: { name: 'Toxic Volley', icon: '☣', desc: 'Var 3:e auto-attack blir splittad: huvudtarget + 2 närmaste extra fiender inom 6 m. Alla 3 träffar applicerar en poison-stack som tickar damage i 4 sekunder. Stackar refreshar duration. Damage per sekund = 5 × stacks × (1 + 10% × (stacks − 1)), så varje stack gör 10% mer skada än föregående.' },
    ult: { name: 'Shadow Volley', icon: '🌑', desc: 'Legolus blir osynlig för alla fiender och motspelare i 5 sekunder, får +20% movement speed och hans nästa auto-attack blir empowered: dubbel räckvidd, gör 25% av targetens max-HP i direct damage, stunnar target + alla fiender inom 2.5 m i 1.5 sekunder och lämnar en torn-pool under target som tickar 5% av max-HP i AoE-damage var 0.5 sekund i 3 sekunder (totalt 30% maxHP). Legolus revealas så fort han skjuter pilen eller efter 5 sekunder. Skill-skada som träffar honom under invis dealar damage men avslöjar INTE hans position.' },
  },
  gimlu: {
    skills: {
      q: { name: 'Titan\'s Taunt', icon: '📢', desc: 'Skrik som tauntar alla fiender inom 5.5 m i 3 sekunder — de tvingas attackera Gimlu (auto-attack bara, inga skills). Under buffen får Gimlu 30% damage reduction, healas 20% av all skada han tar och 10% av maxHP per halv sekund.' },
      f: { name: 'Iron Will', icon: '🛡', desc: '3 sekunders aktiveringsfönster. All damage Gimlu tar lagras i en mätare. Vid slutet exploderar han i AoE (6 m radie) och gör damage = den lagrade summan till alla fiender runt.' },
      e: { name: 'Hammer Throw', icon: '🔨', desc: 'Kastar hammaren i en rak sträcka (9 m) som sedan flyger tillbaka. Full damage på vägen ut, halv damage på vägen tillbaka. Gimlu healas 50% av damage done. Tryck E igen medan hammaren är ute för att byta plats med den (teleport).' },
    },
    passive: { name: 'Stalwart Resolve', icon: '🗿', desc: 'Skiktad defensiv passiv som triggar på olika HP-trösklar:\n• Under 80% HP: 10% damage reduction (alltid på).\n• Under 60% HP: + 2.5% av maxHP regen per sekund (förutom DR från tier 1).\n• Under 40% HP: + 10% mer damage reduction (20% totalt) och var 6:e inkommande damage-instance blockas helt.\n\nBonus: Gimlu bygger ult-energy genom att tanka skada (5% av damage taken, max 2% per hit).' },
    ult: { name: 'Berserker Rage', icon: '🪓', desc: '5 sekunders raseri: Gimlu växer till dubbel storlek, blir CC-immun (ingen kan frysa, taunta, fear:a eller slow:a honom) och får 50% skadereduktion. Var 0.5 s pulsar han en AoE-våg runt sig (4.5 m radie) som gör 3.5% av targets max-HP i skada — totalt 35% max-HP över 5 s (10 pulser). 20% av all skada Gimlu delar ut healar honom själv. Pulserna träffar monster, creeps, bossar, motståndarhjälte och arena-orb.' },
  },
  aragurn: {
    skills: {
      q: { name: 'Whirlwind', icon: '🌀', desc: 'Aragurn snurrar med svärdet utstärkt i 3 sekunder och skadar alla fiender inom 3m — 7.5% av deras max-HP per 0.5s. Healar Aragurn 10% av all damage done från whirlwinden. CC-immun (rensar alla CC förutom stun), +20% MS. Kan inte AA eller cast:a andra skills under spin. Cooldown börjar räknas FÖRST när spin är slut.' },
      f: { name: 'War Shout', icon: '📣', desc: 'TVÅ separata zoner: KON framför Aragurn (8m × 120°) gör 15% max-HP damage + 20% slow (3s) + 20% mer skada taken (4s, mot hjältar). CIRKEL runt Aragurn (6m) ger buff till allierade hjältar: +20% damage reduction + +20% movement speed (4s) + HoT (5% maxHP/s i 2s). Aragurn själv: bara damage reduction-buff + HoT (10% maxHP/s i 2s).' },
      e: { name: 'Hero Leap', icon: '🦘', desc: 'Hoppa i båge till en mark-targetad punkt (drag-aim styr landing). Walkability-clampas så hero inte landar i väggar/tower. AoE-landning (4.5m radie). Fiender träffade: 20% max-HP damage + stunnas 1 sekund. Aragurn healar 25% av förlorad HP per fiende träffad.' },
    },
    passive: { name: 'War Veteran', icon: '🛡', desc: 'TVÅ-delad passive:\n• Lifesteal: 0.5% lifesteal per 1% HP loss på all skada han delar ut (skill + AA). Vid 50% HP = 25% lifesteal, vid 1% HP = ~50% lifesteal.\n• Damage Reduction baserat på fiender nära (5m radie): 1 fiende = 20% DR, varje extra fiende = +5% DR (max 40% vid 5+ fiender). Skalas för group fights.' },
    ult: { name: 'Berserk Form', icon: '⚔', desc: '5 sekunders berserk-form: Aragurn blir lite större, hans svärd dubbleras i storlek och får en glödande aura. +150% AA-damage, 100% cleave/splash (varje AA träffar ALLA fiender inom AA-range), och 25% lifesteal på all AA-damage. Ingen attack speed-nerf — full DPS-burst.' },
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
  if (heroId === 'aragurn') return `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs><radialGradient id="bg-ar" cx="50%" cy="40%"><stop offset="0%" stop-color="#5a3a28"/><stop offset="100%" stop-color="#15100a"/></radialGradient></defs>
      <rect width="100" height="100" fill="url(#bg-ar)"/>
      <path d="M 5 100 Q 50 60 95 100 Z" fill="#3a2a1c"/>
      <!-- Stort svärd diagonal bakom -->
      <line x1="18" y1="14" x2="58" y2="62" stroke="#553311" stroke-width="3"/>
      <polygon points="20,12 30,8 26,18" fill="#cccccc" stroke="#666" stroke-width="0.8"/>
      <line x1="22" y1="10" x2="56" y2="58" stroke="#dadcdf" stroke-width="3.5"/>
      <line x1="55" y1="55" x2="63" y2="65" stroke="#553311" stroke-width="2.5"/>
      <!-- Ansikte -->
      <circle cx="55" cy="55" r="14" fill="#e0b894"/>
      <!-- Halvlångt hår, lite vågigt -->
      <path d="M 38 50 Q 38 32 55 30 Q 72 32 72 50 L 70 72 Q 64 64 56 64 Q 48 64 42 72 Z" fill="#3a2818"/>
      <path d="M 42 60 Q 42 76 36 80 Q 41 78 44 70" fill="#3a2818"/>
      <path d="M 68 60 Q 68 76 74 80 Q 69 78 66 70" fill="#3a2818"/>
      <!-- Pannan / lockar -->
      <path d="M 40 48 Q 47 38 55 40 Q 63 38 70 48 L 70 52 Q 60 44 50 50 Q 44 48 40 52 Z" fill="#3a2818"/>
      <!-- Ögon -->
      <ellipse cx="49" cy="56" rx="1.6" ry="2" fill="#1a1208"/>
      <ellipse cx="61" cy="56" rx="1.6" ry="2" fill="#1a1208"/>
      <!-- Lite skäggstubb -->
      <path d="M 46 64 Q 55 70 64 64 Q 60 66 55 66 Q 50 66 46 64 Z" fill="#2a1808" opacity="0.7"/>
      <!-- Skinnrustnings-axel -->
      <path d="M 32 84 Q 55 76 78 84 L 78 100 L 32 100 Z" fill="#4a3a26"/>
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
const howtoContent = document.getElementById('howto-content');
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
  const ultimate = info.ult
    ? `<div class="skill-item${heroesBrowserSkillKey === 'r' ? ' expanded' : ''}" data-skill="r">
        <div class="skill-head"><div class="skill-key r">${info.ult.icon || 'R'}</div><span>R · Ultimate · ${info.ult.name}</span></div>
        <div class="skill-desc">${info.ult.desc}</div>
      </div>`
    : '';
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
    <div class="skill-list">${skillItems}${ultimate}${passive}</div>
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
// Items har antingen flera varianter (Boots / Glove) ELLER egna statsAtLevel direkt
// (Ling & Lang, Onyx Orb, Titans Armor). Båda formerna renderas med samma layout —
// non-variant items blir ett enda block med rot-namnet.
function itemHasContent(def) {
  if (!def) return false;
  if (def.variants) return true;
  if (typeof def.statsAtLevel !== 'function') return false;
  const sample = def.statsAtLevel(1);
  return sample && Object.keys(sample).length > 0;
}
function openItemDetailModal(itemId) {
  const def = ITEM_TYPES[itemId];
  if (!def || !itemHasContent(def) || !itemDetailModal) return;
  renderItemDetail(itemId, def);
  itemDetailModal.classList.remove('hidden');
}
function closeItemDetailModal() { if (itemDetailModal) itemDetailModal.classList.add('hidden'); }

function renderVariantBlock(v) {
  const sample = v.statsAtLevel(1);
  const statKeys = Object.keys(sample);
  const thead = `<th>Lvl</th>${statKeys.map(k => `<th>${STAT_LABELS[k] || k}</th>`).join('')}`;
  const rows = [];
  for (let lvl = 1; lvl <= 10; lvl++) {
    const s = v.statsAtLevel(lvl);
    rows.push(`<tr><td class="lv">${lvl}</td>${statKeys.map(k => `<td>${fmtStatVal(k, s[k])}</td>`).join('')}</tr>`);
  }
  const activeHtml = v.activeAtMax
    ? `<div class="variant-active"><b>Active (lvl 10):</b> ${v.activeAtMax.description || ''} — ${v.activeAtMax.duration ? v.activeAtMax.duration + 's effekt, ' : ''}${v.activeAtMax.cooldown}s cd</div>`
    : '';
  return `<div class="variant-block">
    <div class="variant-name">${v.icon || ''} ${v.name}</div>
    <div class="variant-desc">${v.description || ''}</div>
    <table class="tier-table"><thead><tr>${thead}</tr></thead><tbody>${rows.join('')}</tbody></table>
    ${activeHtml}
  </div>`;
}

function renderItemDetail(itemId, def) {
  let blocks;
  if (def.variants) {
    blocks = Object.values(def.variants).map(renderVariantBlock).join('');
  } else {
    // Non-variant item: rendera root-defen som ett enda block (utan dubbel-namn)
    blocks = renderVariantBlock({
      name: def.name,
      icon: def.icon,
      description: '',  // beskrivningen visas redan i headern
      statsAtLevel: def.statsAtLevel,
      activeAtMax: def.activeAtMax,
    });
  }
  itemDetailBody.innerHTML = `<h3 style="color:#ffd34a;margin:0 0 4px;font-size:24px">${def.icon || ''} ${def.name}</h3>
    <div class="sub-role">${def.description || ''}</div>
    <div class="sub-role" style="margin-bottom:10px">Köp: ${ITEM_BUY_COST}g · Uppgradering lvl N: 500×2^(N-1) guld · Max level 10</div>
    <div class="variant-list">${blocks}</div>`;
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
    const hasContent = itemHasContent(def);
    const card = document.createElement('div');
    card.className = 'browser-card' + (hasContent ? '' : ' locked');
    card.innerHTML = `<div class="card-icon" style="font-size:34px;background:linear-gradient(135deg,#2a2456,#15102a)">${def.icon || '?'}</div><div class="card-name">${def.name}</div><div class="card-role">${hasContent ? 'Klicka för detaljer' : 'Coming Soon'}</div>`;
    if (hasContent) card.addEventListener('click', () => openItemDetailModal(itemId));
    grid.appendChild(card);
  }
  itemsBrowserContent.appendChild(grid);
}

// === How to Play-rendering ===
function howtoSvg(kind) {
  const stroke = '#dbe2ef';
  const accent = '#ffd34a';
  const blue = '#6ab0ff';
  const red = '#ff7766';
  const green = '#5cc66c';
  const violet = '#b58cff';
  switch (kind) {
    case 'overview': return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="6" width="88" height="88" rx="10" fill="none" stroke="${stroke}" stroke-width="2"/><line x1="50" y1="10" x2="50" y2="90" stroke="${stroke}" stroke-width="2" stroke-dasharray="3 3"/><circle cx="28" cy="30" r="8" fill="${blue}"/><rect x="22" y="38" width="12" height="14" rx="3" fill="${blue}"/><circle cx="72" cy="70" r="8" fill="${red}"/><rect x="66" y="78" width="12" height="14" rx="3" fill="${red}"/><path d="M28 60 L72 40" stroke="${accent}" stroke-width="2" stroke-dasharray="2 3"/></svg>`;
    case 'controls': return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="26" cy="68" r="20" fill="none" stroke="${stroke}" stroke-width="2"/><circle cx="26" cy="68" r="8" fill="${blue}"/><circle cx="74" cy="68" r="14" fill="${red}" opacity="0.85"/><text x="74" y="73" text-anchor="middle" fill="#fff" font-size="14" font-weight="700">AA</text><circle cx="58" cy="36" r="10" fill="${violet}" opacity="0.9"/><text x="58" y="40" text-anchor="middle" fill="#fff" font-size="10" font-weight="700">Q</text><circle cx="80" cy="44" r="10" fill="${violet}" opacity="0.9"/><text x="80" y="48" text-anchor="middle" fill="#fff" font-size="10" font-weight="700">F</text><circle cx="86" cy="22" r="10" fill="${violet}" opacity="0.9"/><text x="86" y="26" text-anchor="middle" fill="#fff" font-size="10" font-weight="700">E</text></svg>`;
    case 'lanes': return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="6" width="92" height="40" rx="4" fill="rgba(106,176,255,0.10)" stroke="${blue}" stroke-width="1.5"/><rect x="4" y="54" width="92" height="40" rx="4" fill="rgba(255,119,102,0.10)" stroke="${red}" stroke-width="1.5"/><line x1="4" y1="50" x2="96" y2="50" stroke="${stroke}" stroke-width="2"/><rect x="6" y="10" width="92" height="14" fill="none" stroke="${stroke}" stroke-width="0.6"/><rect x="6" y="28" width="92" height="14" fill="none" stroke="${stroke}" stroke-width="0.6"/><rect x="6" y="58" width="92" height="14" fill="none" stroke="${stroke}" stroke-width="0.6"/><rect x="6" y="76" width="92" height="14" fill="none" stroke="${stroke}" stroke-width="0.6"/><circle cx="88" cy="26" r="4" fill="${accent}"/><circle cx="88" cy="74" r="4" fill="${accent}"/></svg>`;
    case 'waves': return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><g>${[0,1,2,3,4].map(r => [0,1,2].map(c => `<rect x="${10 + c*22}" y="${14 + r*14}" width="14" height="10" rx="2" fill="${r===2?red:blue}" opacity="${0.45 + r*0.10}"/>`).join('')).join('')}</g><path d="M82 50 L82 86" stroke="${accent}" stroke-width="3"/><polygon points="76,80 88,80 82,92" fill="${accent}"/></svg>`;
    case 'income': return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="56" r="26" fill="${accent}" stroke="#a87a00" stroke-width="2"/><text x="50" y="63" text-anchor="middle" fill="#5a3e00" font-size="22" font-weight="800">G</text><path d="M50 28 L50 8" stroke="${green}" stroke-width="3"/><polygon points="42,14 58,14 50,4" fill="${green}"/><text x="84" y="20" text-anchor="middle" fill="${green}" font-size="11" font-weight="700">+</text></svg>`;
    case 'shop': return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="14" y="22" width="72" height="58" rx="6" fill="rgba(70,120,200,0.18)" stroke="${stroke}" stroke-width="1.5"/><rect x="20" y="30" width="60" height="10" fill="${blue}" opacity="0.5"/><text x="50" y="38" text-anchor="middle" fill="#fff" font-size="8" font-weight="700">SHOP</text><rect x="22" y="44" width="22" height="14" rx="2" fill="${violet}" opacity="0.7"/><rect x="56" y="44" width="22" height="14" rx="2" fill="${green}" opacity="0.7"/><rect x="22" y="62" width="22" height="14" rx="2" fill="${red}" opacity="0.7"/><rect x="56" y="62" width="22" height="14" rx="2" fill="${accent}" opacity="0.7"/></svg>`;
    case 'minions': return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><g>${[0,1,2].map(i => `<circle cx="${20 + i*16}" cy="${48 + i*4}" r="5" fill="${blue}"/><rect x="${15 + i*16}" y="${54 + i*4}" width="10" height="10" rx="2" fill="${blue}"/>`).join('')}</g><path d="M70 60 L92 50" stroke="${accent}" stroke-width="2"/><polygon points="86,46 96,48 90,54" fill="${accent}"/><text x="50" y="22" text-anchor="middle" fill="${accent}" font-size="9" font-weight="700">DIN ARMÉ</text></svg>`;
    case 'items': return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="20" y="20" width="26" height="26" rx="4" fill="${violet}" opacity="0.7"/><text x="33" y="38" text-anchor="middle" fill="#fff" font-size="14">👢</text><rect x="54" y="20" width="26" height="26" rx="4" fill="${green}" opacity="0.7"/><text x="67" y="38" text-anchor="middle" fill="#fff" font-size="14">🧤</text><rect x="20" y="54" width="26" height="26" rx="4" fill="${blue}" opacity="0.7"/><text x="33" y="72" text-anchor="middle" fill="#fff" font-size="14">🛡</text><rect x="54" y="54" width="26" height="26" rx="4" fill="${red}" opacity="0.7"/><text x="67" y="72" text-anchor="middle" fill="#fff" font-size="14">⚔</text></svg>`;
    case 'heroes': return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="22" cy="40" r="14" fill="${violet}"/><polygon points="14,28 30,28 22,16" fill="${violet}"/><circle cx="50" cy="40" r="14" fill="${green}"/><path d="M40 30 Q50 24 60 30 L60 38 Q50 34 40 38 Z" fill="#234"/><circle cx="78" cy="40" r="14" fill="${red}"/><rect x="68" y="28" width="20" height="6" fill="#888"/><path d="M22 60 L22 80" stroke="${stroke}" stroke-width="2"/><path d="M50 60 L50 80" stroke="${stroke}" stroke-width="2"/><path d="M78 60 L78 80" stroke="${stroke}" stroke-width="2"/></svg>`;
    case 'fountain': return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><ellipse cx="50" cy="80" rx="32" ry="6" fill="none" stroke="${blue}" stroke-width="1.5" opacity="0.6"/><ellipse cx="50" cy="80" rx="22" ry="4" fill="${blue}" opacity="0.35"/><rect x="44" y="40" width="12" height="38" fill="#aab4c8"/><circle cx="50" cy="36" r="10" fill="${blue}" opacity="0.8"/><polygon points="50,18 58,32 42,32" fill="${accent}"/><circle cx="50" cy="48" r="38" fill="none" stroke="${blue}" stroke-width="1" stroke-dasharray="2 2" opacity="0.5"/></svg>`;
    case 'duel': return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="38" fill="rgba(255,119,102,0.10)" stroke="${red}" stroke-width="2"/><line x1="22" y1="22" x2="78" y2="78" stroke="${stroke}" stroke-width="4"/><line x1="78" y1="22" x2="22" y2="78" stroke="${stroke}" stroke-width="4"/><circle cx="50" cy="50" r="6" fill="${accent}"/><text x="50" y="92" text-anchor="middle" fill="${red}" font-size="10" font-weight="700">DUEL</text></svg>`;
    case 'copy': return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="46" r="12" fill="${accent}"/><rect x="24" y="56" width="16" height="20" rx="3" fill="${accent}"/><circle cx="68" cy="46" r="12" fill="${red}" opacity="0.7"/><rect x="60" y="56" width="16" height="20" rx="3" fill="${red}" opacity="0.7"/><text x="50" y="20" text-anchor="middle" fill="${accent}" font-size="11" font-weight="700">LV 30</text><path d="M44 50 L56 50" stroke="${stroke}" stroke-width="2" stroke-dasharray="2 2"/></svg>`;
    case 'goal': return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="44" y="32" width="12" height="46" fill="#aab4c8"/><circle cx="50" cy="28" r="12" fill="${red}"/><polygon points="50,12 60,26 40,26" fill="${red}" opacity="0.7"/><path d="M30 70 L40 78 M70 70 L60 78" stroke="${accent}" stroke-width="2"/><path d="M28 86 L72 86" stroke="${red}" stroke-width="3"/><text x="50" y="98" text-anchor="middle" fill="${accent}" font-size="9" font-weight="700">VINST</text></svg>`;
  }
  return '';
}

// Sticky tracker: kom-från-panel så Back-knappen returnerar till rätt sub-meny.
let _howtoReturnPanel = 'main';

function renderHowto(mode) {
  if (!howtoContent) return;
  if (mode === 'arena') return renderHowtoArena();
  if (mode === 'boss') return renderHowtoBoss();
  return renderHowtoLine();   // default = line wars
}

function renderHowtoLine() {
  if (!howtoContent) return;
  const sections = [
    {
      icon: 'overview', title: 'Översikt',
      html: `<p>Hero Line Wars är en <strong>1v1 MOBA-light</strong>. Ni har varsin arena. Var 10:e sekund spawnar en wave av fiender i din arena — du måste döda dem innan de når din <strong>fontän</strong>. När fontänen är död förlorar du.</p><p>Vid sidan dödar du fiender för guld och XP, köper items till din hjälte och <strong>minions till motståndarens lane</strong> så hens wave blir tuffare.</p>`
    },
    {
      icon: 'lanes', title: 'Lanes & arenor',
      html: `<p>Du har <strong>2 lanes</strong> (övre + nedre) i din arena. Vägg-barriärer skiljer dem så fiender stannar i sin lane. Du kan röra dig fritt mellan dem.</p><p>Motståndarens arena är spegelvänt nedanför (för host). Joinern ser den uppochnedvänd så hens arena är "nere".</p>`
    },
    {
      icon: 'waves', title: 'Waves (50 totalt)',
      html: `<p><strong>10s prep</strong> i början, sedan kommer en ny wave var 10:e sekund. 30 fiender per wave (15 per lane), alla spawnar samtidigt i kolumn.</p><ul><li><strong>5 tiers:</strong> Soldiers → Knights → Berserkers → Demons → Drakätt.</li><li><strong>Boss var 10:e wave</strong> (10, 20, 30, 40, 50) — enorm HP, hård dmg.</li><li>Wave-banner längst upp visar nästa wave.</li></ul>`
    },
    {
      icon: 'income', title: 'Income (passive + boost)',
      html: `<p>Du får <strong>passivt guld var 15:e sekund</strong>. Starten är låg — boosta den genom att <strong>köpa minions</strong> till hens lane.</p><ul><li>Varje minion-köp ger dig <strong>+20% av minions kostnad som permanent income-boost</strong>.</li><li>Köp dyrare minions ⇒ mer income snabbare.</li><li>Income-display visas top center: "Income: Xg/15s".</li></ul>`
    },
    {
      icon: 'shop', title: 'Shop (höger sida)',
      html: `<p>Shoppen är delad i två paneler på höger sida:</p><ul><li><strong>Hjälte-items (ovan):</strong> Boots, Glove of Haste osv — flat stat-boost för din hjälte. Upp till level 10 per item, dyrare per level.</li><li><strong>Minion-shop (under):</strong> 30 olika minions (5 tiers × 6 arketyper). Köp så spawnar de i hens lane som "din armé". De drar income, gör skada på hens torn/hero.</li></ul>`
    },
    {
      icon: 'minions', title: 'Minions du köper',
      html: `<p>När du köper en minion <strong>spawnar den i motståndarens lane</strong> tillsammans med hens nuvarande wave. Den marscherar mot hens fontän.</p><ul><li>5 tier-nivåer låses upp vid <strong>200g / 500g / 1000g / 2000g</strong> guld du tjänat.</li><li>Minions kan attackera motståndarens hjälte också.</li><li>Att skicka många minions trycker hens wave-defense — och boostar din income.</li></ul>`
    },
    {
      icon: 'items', title: 'Hjälte-items',
      html: `<p>Items har <strong>10 levels</strong>. Köp första gången för 200g, sedan dyrare per level (500 × 2^(lvl-1)).</p><ul><li><strong>Boots</strong> — 3 varianter: Speed / Magic / Tank. Vid lvl 10 unlock active: +50% buff i 5s, 30s CD.</li><li><strong>Glove of Haste</strong> — attack-speed/skill-dmg fokus.</li><li>Max 4 items i inventoryn längst ner i mitten. Tap/hover för tooltip.</li></ul>`
    },
    {
      icon: 'fountain', title: 'Fontän-aura',
      html: `<p>Din fontän är inte bara mål — den <strong>healar och boostar dig</strong> när du är nära.</p><ul><li>Inom ~4.5m radie: <strong>+2% av maxHP/s heal</strong>, +10% skada, -10% inkommande skada, +10% CDR, +10% attack speed.</li><li>Stå nära fontänen mellan waves för att returna full HP gratis.</li></ul>`
    },
    {
      icon: 'duel', title: 'Duel (var 5:e min)',
      html: `<p>Var 5:e minut teleporteras båda hjältar till en <strong>cirkulär stenarena</strong>. 90-sekunder deathmatch — sista mannen kvar (eller högsta HP% vid timeout) vinner.</p><ul><li>Vinst: <strong>500 / 1500 / 5000 / 10000g</strong> + 1 level (skalar med duel-nummer).</li><li>Max 4 dueler per match. Lanes är pausade under duel.</li></ul>`
    },
    {
      icon: 'copy', title: 'Lvl 30 hero-copy (belöning)',
      html: `<p>Om du når <strong>level 30</strong> och vinner en duel spawnar en <strong>bot-styrd kopia av din hjälte</strong> i motståndarens lane.</p><ul><li>Kopian har 70% av dina stats och marscherar mot hens fontän.</li><li>Gör 10 skada på fontänen vid kontakt och aggro:ar hens hjälte.</li><li>Game-changing — pressar matchen mot vinst.</li></ul>`
    },
    {
      icon: 'goal', title: 'Hur du vinner',
      html: `<p>Förstör <strong>motståndarens fontän</strong>. Båda fontäner har 50 HP. Skada kommer från:</p><ul><li>Dina <strong>minions</strong> som når hens fontän (största källan).</li><li>Din <strong>hero-copy</strong> på lvl 30.</li><li>Indirekt: hens hjälte dör → 5s respawn → 5g till dig per kill.</li></ul>`
    },
  ];
  howtoContent.innerHTML = sections.map(s => `
    <div class="howto-section">
      <div class="howto-icon">${howtoSvg(s.icon)}</div>
      <div class="howto-body">
        <h3>${s.title}</h3>
        ${s.html}
      </div>
    </div>
  `).join('');
}

function renderHowtoArena() {
  if (!howtoContent) return;
  const sections = [
    {
      icon: 'overview', title: 'Översikt',
      html: `<p>Arena Wars är ren <strong>PvP-duell</strong> mellan hjältar (1v1 eller 2v2). Inga waves, ingen fontän — bara hero-vs-hero combat över flera rundor.</p><p>Vinner du <strong>3 av 5 rundor</strong> vinner du matchen. Mellan rundor får du välja talents och köpa items.</p>`
    },
    {
      icon: 'controls', title: 'Kontroller',
      html: `<ul><li><strong>Vänster joystick</strong> — flytta hjälten.</li><li><strong>AA-knapp (stor, hörnet)</strong> — toggle auto-attack på närmaste fiende.</li><li><strong>Skills (Q / F / E)</strong> — tap för auto-aim, drag-hold för manuell aim med riktnings-indicator på marken.</li><li><strong>Ult (R)</strong> — kräver 100% energy. 5s lockout efter cast.</li><li><strong>Desktop:</strong> WASD/piltangenter + Q/F/E + Space = AA.</li></ul>`
    },
    {
      icon: 'overview', title: 'Hero pick (60s)',
      html: `<p>Innan matchen startar väljer båda spelare hjälte från grid-vyn. 60-sekunders timer. <strong>Tap på en hjälte</strong> sen <strong>Confirm</strong>. Båda måste bekräfta innan matchen börjar — eller 0s timer.</p><p>Du kan se motståndarens val live under pick-fasen.</p>`
    },
    {
      icon: 'waves', title: 'Round-struktur',
      html: `<p>Varje round består av två faser:</p><ul><li><strong>Prep (60s):</strong> Välj 1 talent + köp items. Båda måste klicka Ready (eller timer går ut) för att starta fight-fasen.</li><li><strong>Fight:</strong> Sista hjälten som lever vinner round. Vid timeout vinner högsta HP%. Ingen respawn — dö = round-förlust.</li></ul><p>+1 talent-point per vunnen round + 500g bonus.</p>`
    },
    {
      icon: 'items', title: 'Items + talents under prep',
      html: `<p>Prep-skärmen visar talents (övre delen) och items (under). Du kan både välja talent OCH köpa items i samma prep-fas.</p><ul><li><strong>Talents:</strong> Hero-specifika passive buffs (t.ex. +20% skill damage, +10% MS). 1 poäng per round, max 5 över hela matchen.</li><li><strong>Items:</strong> Standard hero-items (Boots, Glove of Haste osv). 200g köp / 500×2^(lvl-1)g upgrade. Stats ackumuleras genom matchen.</li></ul>`
    },
    {
      icon: 'duel', title: 'Orb + shrink-circle',
      html: `<p>Under fight-fasen spawnar en <strong>magisk orb</strong> i mitten av arenan. Skada den för gold/buff-belöning.</p><p>En <strong>krymp-cirkel</strong> drar in arenan över tid — utanför cirkeln tar du 5% maxHP/sek + stackar (1% mer per stack). Tvingar engagement i mitten.</p>`
    },
    {
      icon: 'heroes', title: 'Heroes & skills',
      html: `<p>Alla 4 hjältar (Gandulf, Legolus, Gimlu, Aragurn) tillgängliga. Se Heroes-fliken för full skill-beskrivning. Ultimates har <strong>5s lockout</strong> efter cast — kan inte spammas.</p><ul><li>Skill-cast har per-cast cap på ult-gain (max 10% oavsett targets).</li><li>Drag-aim ger exakt landing-position (mag = drag-fraktion av max-range).</li></ul>`
    },
    {
      icon: 'goal', title: 'Hur du vinner',
      html: `<p>Döda motståndaren <strong>3 gånger</strong> (Best of 5). Skill-kombos och positionering avgör. Spara ult till rätt moment — 5s lockout efter cast.</p><p><strong>2v2-läge:</strong> teamet med flest lvande hjältar vid round-end vinner. Allierad shout-buff (Aragurn F) ger DR + MS + HoT till lagkompis.</p>`
    },
  ];
  howtoContent.innerHTML = sections.map(s => `
    <div class="howto-section">
      <div class="howto-icon">${howtoSvg(s.icon)}</div>
      <div class="howto-body">
        <h3>${s.title}</h3>
        ${s.html}
      </div>
    </div>
  `).join('');
}

function renderHowtoBoss() {
  if (!howtoContent) return;
  const sections = [
    {
      icon: 'overview', title: 'Översikt',
      html: `<p>Boss Wars är en <strong>3-spelar co-op raid</strong> mot en enskild gigantisk boss (eller solo om du vill träna). Inga waves, ingen PvP — bara du och dina vänner mot bossen.</p><p>5 olika bosstar med stigande svårighet (Captain → Drakkonungen).</p>`
    },
    {
      icon: 'controls', title: 'Kontroller',
      html: `<ul><li>Samma som andra modes: joystick + AA + Q/F/E/R + skill-aim med drag.</li><li><strong>Hjältar är 15% större</strong> i Boss Wars — bättre synlighet mot stor boss.</li><li>Aragurns svärd är dock 40% mindre för att inte täcka skärmen.</li></ul>`
    },
    {
      icon: 'lanes', title: 'Spawn-rum + korridor + boss-rum',
      html: `<p>Mappen är trippeldelad:</p><ul><li><strong>Spawn-rum (väster):</strong> Alla 3 hjältar spawnar tätt tillsammans här. Trygg start-zon.</li><li><strong>Korridor:</strong> Smal väg österut. Springa genom denna till boss-rummet.</li><li><strong>Boss-rum (öster):</strong> Cirkulär arena där bossen står inaktiv tills alla är inne.</li></ul>`
    },
    {
      icon: 'duel', title: 'Boss-aktivering + gate',
      html: `<p>Bossen <strong>står helt still</strong> tills <strong>ALLA</strong> aktiva hjältar är inne i boss-rummet. När alla är inne:</p><ul><li>Gate stängs vid ingången — ingen kan springa ut.</li><li>Bossen aktiveras: börjar jaga, attackera och casta skills.</li><li>Coordinate som team — vänta på varandra!</li></ul>`
    },
    {
      icon: 'waves', title: 'Boss-skills (telegraphade)',
      html: `<p>Varje boss har <strong>3 unika skills</strong>. Alla har <strong>telegraph-fas</strong> (röd varnings-zon på marken) innan execute — du kan <strong>dodga</strong> ut ur damage-zonen.</p><ul><li><strong>Captain:</strong> Shield Bash (line-dash), Throwing Axe (projektil), Battle Roar (AoE + slow).</li><li><strong>Drakkonungen:</strong> Dragon Breath (sustained cone), Wing Slam (huge AoE + knockback), Skyfire Rain (10 meteorer).</li><li>Andra bossar har mix av target-AoE, cones, sweep-beams, pools.</li></ul>`
    },
    {
      icon: 'minions', title: 'Phase 2 (vid 50% HP)',
      html: `<p>När bossen tappar <strong>50% HP</strong> aktiveras phase 2:</p><ul><li>Bossen flyger upp i luften — invulnerable i 2.5s.</li><li>Lander med <strong>knockback + 3s stun</strong> på alla hjältar.</li><li>Spawnar nytt skill-set (annorlunda än fas 1).</li><li>Får <strong>glow/aura</strong> i tier-specifik färg (blå smoke / grön eld / gold-halo / lila skugga / röd eld).</li><li>+25% AA-damage.</li></ul>`
    },
    {
      icon: 'shop', title: 'Talents + items (prep)',
      html: `<p>Innan striden får du <strong>välja talents</strong> och köpa <strong>raid-items</strong> som matchar din build. Boss Wars-talents är mer aggressiva än arena-talents.</p><ul><li>Phoenix Revive: en automatisk revive vid 0 HP.</li><li>Lifesteal-on-AA: vampire-builds.</li><li>Crit-dmg-bonus: burst-builds.</li></ul>`
    },
    {
      icon: 'fountain', title: 'Boss HP-bar (top center)',
      html: `<p>En stor HP-bar visas <strong>högst upp i mitten</strong> av skärmen under hela striden. Visar bossens procent (inte siffror). Färgen byts till lila i phase 2.</p><p>Hjälper hela teamet att tracka boss-HP utan att kolla på bossen själv.</p>`
    },
    {
      icon: 'goal', title: 'Damage-skalning + win',
      html: `<p>Mot bossar är <strong>% max-HP-skador nerfas 10×</strong> (en 5%-skill blir 0.5%). Bossens enormous HP skulle annars få whirlwind/laser att one-shot:a. Flat-damage AA + skill-base-damage är oförändrade.</p><p><strong>Vinst:</strong> Döda bossen innan teamet wipe:as. Bossen ger inte respawn — om en spelare dör är det till nästa matchstart.</p>`
    },
  ];
  howtoContent.innerHTML = sections.map(s => `
    <div class="howto-section">
      <div class="howto-icon">${howtoSvg(s.icon)}</div>
      <div class="howto-body">
        <h3>${s.title}</h3>
        ${s.html}
      </div>
    </div>
  `).join('');
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
    // Arena-MP: peer-to-peer (server bypassad). Classic-MP: via server.
    if (isArenaMp()) {
      sendGameMsg({ t: 'a-pick', heroId });
    } else {
      sendOrApplyEvent({ type: 'hero-pick', heroId });
    }
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
  } else if (isArenaMp()) {
    hpConfirmBtn.textContent = 'Väntar på motståndaren...';
    sendGameMsg({ t: 'a-pick-confirm', heroId: heroPickState.selected });
    // Om motståndaren redan confirm:at → starta nu
    if (heroPickState.oppConfirmed) finishHeroPick();
  } else {
    hpConfirmBtn.textContent = 'Väntar på motståndaren...';
    sendOrApplyEvent({ type: 'hero-confirm' });
  }
}

function finishHeroPick() {
  // Idempotens-guard: race-condition där båda spelare confirm:ar samtidigt
  // kan annars trigga enterPlayPhase två gånger.
  if (!heroPickState.active) return;
  if (heroPickState.timerHandle) {
    clearInterval(heroPickState.timerHandle);
    heroPickState.timerHandle = null;
  }
  heroPickState.active = false;
  heroPickState.mode = null;
  // Boss Wars: visa prep-panel innan matchen startar (välj 3 talents + 4 items)
  if (APP.gameMode === 'bosswars' && APP.bossWars && APP.bossWars.active) {
    showBossWarsPrep();
    return;
  }
  enterPlayPhase();
}

// ===== Boss Wars prep — välj 3 talents + 4 items =====
function showBossWarsPrep() {
  if (heroPickEl) heroPickEl.classList.add('hidden');
  const prepEl = document.getElementById('boss-prep');
  if (!prepEl) { enterPlayPhase(); return; }
  prepEl.classList.remove('hidden');
  // Reset selection state
  APP.bossWars.selectedTalents = [];
  APP.bossWars.selectedItems = [];
  renderBossPrepGrids();
  updateBossPrepButton();
}

function renderBossPrepGrids() {
  const tg = document.getElementById('bp-talents-grid');
  const ig = document.getElementById('bp-items-grid');
  if (!tg || !ig) return;
  // Talents
  tg.innerHTML = '';
  const tSelected = new Set(APP.bossWars.selectedTalents || []);
  const tFull = tSelected.size >= 3;
  for (const t of BOSS_WARS_TALENTS) {
    const picked = tSelected.has(t.id);
    const div = document.createElement('div');
    div.className = 'bp-card' + (picked ? ' selected' : (tFull ? ' disabled' : ''));
    div.innerHTML = `<div class="bp-icon">${t.icon}</div><div class="bp-name">${t.name}</div><div class="bp-desc">${t.desc}</div>`;
    if (picked || !tFull) div.addEventListener('click', () => toggleBossPrepTalent(t.id));
    tg.appendChild(div);
  }
  // Items
  ig.innerHTML = '';
  const iSelected = new Set(APP.bossWars.selectedItems || []);
  const iFull = iSelected.size >= 4;
  for (const it of BOSS_WARS_ITEMS) {
    const picked = iSelected.has(it.id);
    const div = document.createElement('div');
    div.className = 'bp-card' + (picked ? ' selected' : (iFull ? ' disabled' : ''));
    div.innerHTML = `<div class="bp-icon">${it.icon}</div><div class="bp-name">${it.name}</div><div class="bp-desc">${it.desc}</div>`;
    if (picked || !iFull) div.addEventListener('click', () => toggleBossPrepItem(it.id));
    ig.appendChild(div);
  }
  // Status-text
  const ts = document.getElementById('bp-talents-status');
  const iS = document.getElementById('bp-items-status');
  if (ts) ts.textContent = `(${tSelected.size}/3 valda)`;
  if (iS) iS.textContent = `(${iSelected.size}/4 valda)`;
}

function toggleBossPrepTalent(id) {
  const sel = APP.bossWars.selectedTalents = APP.bossWars.selectedTalents || [];
  const idx = sel.indexOf(id);
  if (idx >= 0) sel.splice(idx, 1);
  else if (sel.length < 3) sel.push(id);
  renderBossPrepGrids();
  updateBossPrepButton();
}
function toggleBossPrepItem(id) {
  const sel = APP.bossWars.selectedItems = APP.bossWars.selectedItems || [];
  const idx = sel.indexOf(id);
  if (idx >= 0) sel.splice(idx, 1);
  else if (sel.length < 4) sel.push(id);
  renderBossPrepGrids();
  updateBossPrepButton();
}
function updateBossPrepButton() {
  const btn = document.getElementById('bp-start-btn');
  if (!btn) return;
  const okT = (APP.bossWars.selectedTalents || []).length === 3;
  const okI = (APP.bossWars.selectedItems || []).length === 4;
  btn.disabled = !(okT && okI);
  btn.textContent = (okT && okI) ? '⚔ Starta strid' : `Välj ${3 - (APP.bossWars.selectedTalents || []).length} talents + ${4 - (APP.bossWars.selectedItems || []).length} items`;
}
function startBossWarsFightAfterPrep() {
  // MP-läge: skicka b-ready med lokal peers val + visa vänta-status. Host
  // samlar in alla peers ready och broadcastar sen b-launch.
  if (bossMpState.active && !bossMpState.matchActive) {
    const payload = {
      p: bossMpState.peerIdx,
      hero: heroPickState.selected || 'magiker',
      tals: (APP.bossWars.selectedTalents || []).slice(),
      items: (APP.bossWars.selectedItems || []).slice(),
    };
    if (bossMpState.role === 'host') {
      bossMpState.peersReady = bossMpState.peersReady || {};
      bossMpState.peersReady[bossMpState.peerIdx] = payload;
      updateBossPrepWaitingStatus();
      maybeLaunchBossMp();
    } else {
      sendGameMsg({ t: 'b-ready', ...payload });
      // Lokal "ready"-flagga så väntestatus visas
      bossMpState.peersReady = bossMpState.peersReady || {};
      bossMpState.peersReady[bossMpState.peerIdx] = payload;
      updateBossPrepWaitingStatus();
    }
    return;   // INTE entera matchen än — vänta på b-launch (eller egna trigger på host)
  }
  // Solo: gå direkt in i match
  const prepEl = document.getElementById('boss-prep');
  if (prepEl) prepEl.classList.add('hidden');
  enterPlayPhase();
}

// Visar "Väntar på andra spelare..." i prep-panelen, döljer start-knappen.
// Uppdaterar count baserat på bossMpState.peersReady. Visar bara om någon
// är ready (annars återställs UI:n till normal "Starta strid").
function updateBossPrepWaitingStatus() {
  const waitEl = document.getElementById('bp-mp-waiting');
  const startBtn = document.getElementById('bp-start-btn');
  if (!waitEl || !startBtn) return;
  const ready = bossMpState.peersReady || {};
  let count = 0;
  for (let i = 1; i <= 3; i++) if (ready[i]) count++;
  if (count === 0) {
    waitEl.classList.add('hidden');
    startBtn.classList.remove('hidden');
    return;
  }
  const total = bossMpState.peersTotal || 3;
  waitEl.textContent = `Klar! Väntar på andra spelare (${count}/${total} klara)...`;
  waitEl.classList.remove('hidden');
  startBtn.classList.add('hidden');
}

// Host: när alla peers har skickat b-ready, broadcasta b-launch + entera matchen
function maybeLaunchBossMp() {
  if (bossMpState.role !== 'host' || bossMpState.matchActive) return;
  const ready = bossMpState.peersReady || {};
  const total = bossMpState.peersTotal || 3;
  let count = 0;
  for (let i = 1; i <= 3; i++) if (ready[i]) count++;
  if (count < total) return;
  // Alla klara — bygg full payload och broadcasta
  sendGameMsg({
    t: 'b-launch',
    tier: APP.bossWars.tier || 1,
    peers: ready,
  });
  APP.bossWars.peerPayloads = ready;
  bossMpState.matchActive = true;
  bossMpState.lastStateSent = performance.now() / 1000;
  // Dölj prep-panel + vänta-status
  const prepEl = document.getElementById('boss-prep');
  if (prepEl) prepEl.classList.add('hidden');
  const waitEl = document.getElementById('bp-mp-waiting');
  if (waitEl) waitEl.classList.add('hidden');
  const startBtn = document.getElementById('bp-start-btn');
  if (startBtn) startBtn.classList.remove('hidden');
  enterPlayPhase();
}

// Klient tar emot b-launch → sätt tier + alla peer-payloads + entera matchen.
// Varje peer har valt hero + talents + items via b-ready innan host triggar launch.
function bossMpClientEnterMatch(msg) {
  // Idempotens-guard: om b-launch levereras två gånger (retransmit eller
  // dubbel relay) ignoreras det andra anropet.
  if (bossMpState.matchActive) return;
  bossMpState.matchActive = true;
  const peers = msg.peers || {};
  const myPayload = peers[bossMpState.peerIdx] || {};
  APP.gameMode = 'bosswars';
  APP.bossWars = {
    active: true,
    tier: msg.tier || 1,
    started: false,
    selectedTalents: (myPayload.tals || []).slice(),
    selectedItems: (myPayload.items || []).slice(),
    peerPayloads: peers,
  };
  heroPickState.selected = myPayload.hero || 'magiker';
  matchState.gameOver = false;
  matchState.gameWon = false;
  matchState.winner = 0;
  // Dölj lobby + ev. pick/prep + wait-status
  lobbyEl.classList.add('hidden');
  if (heroPickEl) heroPickEl.classList.add('hidden');
  const prepEl = document.getElementById('boss-prep');
  if (prepEl) prepEl.classList.add('hidden');
  const waitEl = document.getElementById('bp-mp-waiting');
  if (waitEl) waitEl.classList.add('hidden');
  const startBtn = document.getElementById('bp-start-btn');
  if (startBtn) startBtn.classList.remove('hidden');
  // Sätt upp match som "solo" — 3 sides skapas via boss-MP-extender i enterPlayPhase
  setupMatch('solo');
  enterPlayPhase();
}
// Bind start-button (en gång vid init)
(function bindBossPrepStart() {
  const btn = document.getElementById('bp-start-btn');
  if (btn) btn.addEventListener('click', startBossWarsFightAfterPrep);
})();

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
  // Solo eller arena-MP: lokal timer (vi bypassar server).
  // Classic-MP: server driver timern via state.pT.
  const useLocalTimer = mode === 'solo' || isArenaMp();
  if (useLocalTimer) {
    heroPickState.timerHandle = setInterval(() => {
      if (!heroPickState.active) return;  // skydd om finishHeroPick redan körts
      heroPickState.timer -= 1;
      if (heroPickState.timer <= 0) {
        heroPickState.timer = 0;
        hpTimerEl.textContent = '0';
        hpTimerEl.classList.add('urgent');
        if (!heroPickState.selected) heroPickState.selected = 'magiker';
        // Arena-MP watchdog: motspelaren kanske disconnect:ade —
        // forcera oppConfirmed med default-hjälte så transition kan ske
        if (isArenaMp() && !heroPickState.oppConfirmed) {
          if (!heroPickState.oppSelected) heroPickState.oppSelected = 'magiker';
          heroPickState.oppConfirmed = true;
        }
        if (!heroPickState.confirmed) {
          confirmHero();          // triggar finishHeroPick via opp-check inom confirmHero
        } else {
          finishHeroPick();        // redan confirm:ad men opp-confirm uteblev — starta nu
        }
        return;
      }
      hpTimerEl.textContent = String(heroPickState.timer);
      hpTimerEl.classList.toggle('urgent', heroPickState.timer <= 10);
      // Arena-MP: check om båda confirm:at → transitionera lokalt
      if (isArenaMp() && heroPickState.confirmed && heroPickState.oppConfirmed) {
        finishHeroPick();
      }
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
const lobbyHowtoEl = document.getElementById('lobby-howto');
const lobbyArenaBotEl = document.getElementById('lobby-arena-bot');
const lobbyLineWarsEl = document.getElementById('lobby-line-wars');
const lobbyArenaWarsEl = document.getElementById('lobby-arena-wars');
const lobbyLineTeamEl = document.getElementById('lobby-line-team');
const lobbyArenaTeamEl = document.getElementById('lobby-arena-team');
const lobbyArena2v2El = document.getElementById('lobby-arena-2v2');
const lobbyBossPickEl = document.getElementById('lobby-boss-pick');
const lobbyBossModeEl = document.getElementById('lobby-boss-mode');
const lobbyBossHostEl = document.getElementById('lobby-boss-host');
const lobbyBossJoinEl = document.getElementById('lobby-boss-join');
const lobbyBossWaitEl = document.getElementById('lobby-boss-wait');
function showLobbyPanel(which) {
  for (const el of [lobbyMainEl, lobbyHostingEl, lobbyJoiningEl, lobbyHeroesEl, lobbyItemsEl, lobbyHowtoEl, lobbyArenaBotEl, lobbyLineWarsEl, lobbyArenaWarsEl, lobbyLineTeamEl, lobbyArenaTeamEl, lobbyArena2v2El, lobbyBossPickEl, lobbyBossModeEl, lobbyBossHostEl, lobbyBossJoinEl, lobbyBossWaitEl]) {
    if (el) el.classList.remove('visible');
  }
  if (which === 'main') lobbyMainEl.classList.add('visible');
  else if (which === 'hosting') lobbyHostingEl.classList.add('visible');
  else if (which === 'joining') lobbyJoiningEl.classList.add('visible');
  else if (which === 'heroes') lobbyHeroesEl.classList.add('visible');
  else if (which === 'items') lobbyItemsEl.classList.add('visible');
  else if (which === 'howto') lobbyHowtoEl.classList.add('visible');
  else if (which === 'arena-bot') lobbyArenaBotEl.classList.add('visible');
  else if (which === 'line-wars') lobbyLineWarsEl.classList.add('visible');
  else if (which === 'arena-wars') lobbyArenaWarsEl.classList.add('visible');
  else if (which === 'line-team') lobbyLineTeamEl.classList.add('visible');
  else if (which === 'arena-team') lobbyArenaTeamEl.classList.add('visible');
  else if (which === 'arena-2v2') lobbyArena2v2El.classList.add('visible');
  else if (which === 'boss-pick') lobbyBossPickEl.classList.add('visible');
  else if (which === 'boss-mode') lobbyBossModeEl.classList.add('visible');
  else if (which === 'boss-host') lobbyBossHostEl.classList.add('visible');
  else if (which === 'boss-join') lobbyBossJoinEl.classList.add('visible');
  else if (which === 'boss-wait') lobbyBossWaitEl.classList.add('visible');
}

function showLobbyError(msg) {
  lobbyHostMsgEl.innerHTML = `<span class="err">${msg}</span>`;
  lobbyJoinMsgEl.innerHTML = `<span class="err">${msg}</span>`;
}

// ---- WebSocket relay-anslutning ----
// Öppnar en WS till relay-servern och registrerar en envelope-handler.
// Server-protokoll:
//   client → server : { t: 'host' } | { t: 'join', code } | { t: 'msg', d } | { t: 'leave' } | { t: 'reclaim', code } | { t: 'ping' }
//   server → client : { t: 'hosted', code } | { t: 'joined', code } | { t: 'join-error', msg }
//                     | { t: 'peer-joined' } | { t: 'peer-left' } | { t: 'peer-rejoined' }
//                     | { t: 'reclaimed', code, hasClient } | { t: 'reclaim-error', msg }
//                     | { t: 'pong' } | { t: 'msg', d }

// Modul-scope state för reclaim-flödet. Deklareras INNAN openRelay/onRelayClose
// så vi undviker TDZ om någon onclose-event triggas tidigt.
let pendingHostCode = null;
let _reclaimInProgress = false;

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
      startWsKeepalive();
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
  // Boss Wars MP-flöde: separat hantering så vanlig hosted/joined-flow inte krockar
  if (bossMpState.active) {
    if (env.t === 'hosted') {
      bossMpState.code = env.code;
      bossMpState.peerIdx = env.peerIdx || 1;
      if (bossMpState.codeDisplayEl) bossMpState.codeDisplayEl.textContent = env.code;
      if (bossMpState.hostMsgEl) bossMpState.hostMsgEl.textContent = 'Dela koden med två vänner — väntar på spelare...';
      updateBossPeerCount(1, env.maxPeers || 3);
      return;
    }
    if (env.t === 'joined') {
      bossMpState.peerIdx = env.peerIdx || 2;
      if (bossMpState.waitCodeEl) bossMpState.waitCodeEl.textContent = env.code;
      updateBossPeerCount(env.peersTotal || 2, env.maxPeers || 3);
      showLobbyPanel('boss-wait');
      return;
    }
    if (env.t === 'join-error') {
      if (bossMpState.joinMsgEl) bossMpState.joinMsgEl.innerHTML = `<span class="err">${env.msg || 'Kunde inte ansluta.'}</span>`;
      closeRelay();
      bossMpState.active = false;
      return;
    }
    if (env.t === 'peer-joined') {
      updateBossPeerCount(env.peersTotal || (bossMpState.peersTotal + 1), env.maxPeers || 3);
      if (bossMpState.role === 'host' && bossMpState.hostMsgEl) {
        bossMpState.hostMsgEl.textContent = (bossMpState.peersTotal >= bossMpState.maxPeers)
          ? 'Alla är inne! Tryck "Starta matchen" när ni är redo.'
          : `Spelare anslöt (${bossMpState.peersTotal}/${bossMpState.maxPeers}).`;
      }
      return;
    }
    if (env.t === 'peer-left') {
      if (env.peersTotal !== undefined) {
        updateBossPeerCount(env.peersTotal, env.maxPeers || bossMpState.maxPeers);
        // Nolla buffrad input för den som lämnade så host inte applicerar
        // gammal input på en peer-slot som senare återanvänds av ny joiner.
        bossMpState.remoteInput[2] = null;
        bossMpState.remoteInput[3] = null;
        // Pre-match: nolla peersReady så stale entries inte triggar felaktig launch
        // när en peer återanvänder samma idx-slot. (Under match är peersReady ej i bruk.)
        if (!bossMpState.matchActive) {
          bossMpState.peersReady = {};
          updateBossPrepWaitingStatus();
        }
        if (bossMpState.role === 'host' && bossMpState.hostMsgEl) {
          bossMpState.hostMsgEl.textContent = `En spelare lämnade. Väntar på ${bossMpState.maxPeers - bossMpState.peersTotal} till...`;
        }
        return;
      }
      // Rummet stängdes (host försvann)
      bossMpState.active = false;
      if (APP.mode === 'host' || APP.mode === 'client') {
        showLobbyError('Rummet stängdes.');
        returnToLobby();
      } else {
        if (bossMpState.hostMsgEl) bossMpState.hostMsgEl.innerHTML = '<span class="err">Rummet stängdes.</span>';
        showLobbyPanel('boss-mode');
      }
      closeRelay();
      return;
    }
    if (env.t === 'pong') { APP._lastPongMs = performance.now(); return; }
    if (env.t === 'msg') { handleNetworkMessage(env.d); return; }
    return;
  }
  if (env.t === 'hosted') {
    onHosted(env.code);
  } else if (env.t === 'joined') {
    onJoined(env.code);
  } else if (env.t === 'join-error') {
    showLobbyError(env.msg || 'Kunde inte ansluta.');
    closeRelay();
  } else if (env.t === 'peer-joined') {
    onPeerJoined();
  } else if (env.t === 'peer-rejoined') {
    // Host:en återanslöt efter grace-period — ingen action på client-sidan
    // utöver att logga (server fortsätter relay:a meddelanden som vanligt).
    console.log('Host återansluten');
  } else if (env.t === 'peer-left') {
    if (APP.mode === 'host' || APP.mode === 'client') {
      showLobbyError('Motståndaren lämnade matchen.');
      returnToLobby();
    }
  } else if (env.t === 'reclaimed') {
    // Lyckad reclaim — host fortsätter visa rumkoden, ev. med "Återansluten"
    onReclaimed(env.code, !!env.hasClient);
  } else if (env.t === 'reclaim-error') {
    showLobbyError(env.msg || 'Rummet finns inte längre.');
    pendingHostCode = null;
    closeRelay();
    showLobbyPanel('main');
  } else if (env.t === 'pong') {
    // Keepalive-svar — bara markera att vi är vid liv
    APP._lastPongMs = performance.now();
  } else if (env.t === 'msg') {
    handleNetworkMessage(env.d);
  }
}

function onRelayClose() {
  console.log('WS closed');
  stopWsKeepalive();
  // Host tappade WS INNAN peer joinad — försök automatisk reclaim
  if (pendingHostCode && APP.mode === 'lobby') {
    tryReclaimHostRoom(pendingHostCode);
    return;
  }
  if (APP.mode === 'host' || APP.mode === 'client') {
    showLobbyError('Anslutningen till servern tappades.');
    returnToLobby();
  }
}

function closeRelay() {
  stopWsKeepalive();
  if (APP.ws) {
    try { APP.ws.onclose = null; APP.ws.close(); } catch (_) {}
    APP.ws = null;
  }
}

// Keepalive: skickar { t: 'ping' } var 25s så proxy/Render-sleep inte stänger WS.
// Server svarar { t: 'pong' }. Räcker som signal att WS är vid liv på båda sidor.
function startWsKeepalive() {
  stopWsKeepalive();
  APP._kaInterval = setInterval(() => {
    if (wsOpen()) {
      try { APP.ws.send(JSON.stringify({ t: 'ping' })); } catch (_) {}
    }
  }, 25000);
}
function stopWsKeepalive() {
  if (APP._kaInterval) { clearInterval(APP._kaInterval); APP._kaInterval = null; }
}

// Auto-reclaim när host:s WS dör med ett aktivt rum. Försöker återansluta
// med backoff och skickar { t: 'reclaim', code }. Server svarar 'reclaimed'
// eller 'reclaim-error' (om rummet faktiskt är borta).
async function tryReclaimHostRoom(code) {
  // Race-guard: om en reclaim redan pågår, ignorera nya disconnect-event
  if (_reclaimInProgress) return;
  _reclaimInProgress = true;
  try {
    lobbyHostMsgEl.textContent = 'Anslutningen tappades — försöker återansluta...';
    let attempts = 0;
    const maxAttempts = 3;
    while (attempts < maxAttempts) {
      attempts++;
      try {
        // Liten paus mellan försök (linjär backoff)
        await new Promise(r => setTimeout(r, 1000 + attempts * 500));
        await openRelay();
        wsSendEnvelope({ t: 'reclaim', code });
        return; // Vänta på 'reclaimed' / 'reclaim-error' via handleRelayEnvelope
      } catch (err) {
        console.warn(`Reclaim försök ${attempts} misslyckades:`, err);
        if (attempts >= maxAttempts) {
          showLobbyError('Anslutningen tappades och kunde inte återställas. Skapa ett nytt rum.');
          pendingHostCode = null;
          showLobbyPanel('main');
          return;
        }
      }
    }
  } finally {
    _reclaimInProgress = false;
  }
}

function onReclaimed(code, hasClient) {
  pendingHostCode = code;
  if (lobbyCodeDisplayEl) lobbyCodeDisplayEl.textContent = code;
  if (lobbyHostMsgEl) lobbyHostMsgEl.textContent = hasClient
    ? 'Återansluten. Spelet återupptas...'
    : 'Återansluten. Väntar på spelare...';
}

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
    sides[3] = null;
    sides[4] = null;
    // Solo Practice 2v2: skapa 3 dummies (sida 2, 3, 4)
    if (APP.gameMode === 'arena1v1' && APP.arenaTeamSize === 2) {
      sides[2] = createSide(2);
      sides[3] = createSide(3);
      sides[4] = createSide(4);
    }
    // Arena Wars Singleplayer vs bot: skapa sides[2] som bot-styrd
    if (APP.gameMode === 'arena1v1' && APP.arenaBot && APP.arenaBot.active) {
      sides[2] = createSide(2);
      sides[2].isBot = true;
      sides[2].botDifficulty = APP.arenaBot.difficulty || 'medium';
      // Random hero för boten (välj från tillgängliga)
      const heroes = ['magiker', 'legolas', 'gimlu', 'aragurn'];
      sides[2].heroId = heroes[Math.floor(Math.random() * heroes.length)];
    }
  } else if (mode === 'host') {
    APP.localSide = 1;
    APP.twoSides = true;
    sides[1] = createSide(1);
    sides[2] = createSide(2);
    sides[3] = null; sides[4] = null;
  } else if (mode === 'client') {
    APP.localSide = 2;
    APP.twoSides = true;
    sides[1] = createSide(1);
    sides[2] = createSide(2);
    sides[3] = null; sides[4] = null;
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
  // Sätt heroId och byt mesh.
  // Solo: läs från heroPickState.selected.
  // Arena-MP: peer-to-peer pick (selected = lokal, oppSelected = motståndare).
  // Classic-MP: side.heroId är redan satt via clientReconcileSide.
  for (const idx of [1, 2]) {
    const s = sides[idx];
    if (!s) continue;
    if (APP.mode === 'solo' && idx === APP.localSide && heroPickState.selected) {
      s.heroId = heroPickState.selected;
    }
    if (isArenaMp()) {
      if (idx === APP.localSide && heroPickState.selected) {
        s.heroId = heroPickState.selected;
      } else if (heroPickState.oppSelected) {
        s.heroId = heroPickState.oppSelected;
      }
    }
    swapHeroMeshIfNeeded(s);
  }
  // Uppdatera skill-ikoner för lokal sidans hjälte
  const localSide = sides[APP.localSide];
  if (localSide) updateSkillIcons(localSide.heroId || 'magiker');
  // Arena: bygg scen, sätt lvl 30, starta runda 1 (prep-fas)
  if (APP.gameMode === 'arena1v1') {
    buildArenaScene();
    arenaSceneGroup.visible = true;
    for (const idx of arenaSideIdxs()) {
      const s = sides[idx];
      if (!s) continue;
      s.level = 30;
      s.xp = 0;
      s.xpToNext = xpForLevel(30);
    }
    // Endast host (eller solo) initierar arenaState. Klienten följer via a-state-broadcast.
    if (APP.mode !== 'client') {
      resetArenaState();
      arenaState.talents[1].points = 0;
      arenaState.talents[2].points = 0;
      startArenaRound(1);
    } else {
      // Client: visa hero-pick-överlag bortagen, vänta på host's första a-state
      hideArenaPrep();
      hideArenaEnd();
      hideArenaCountdown();
    }
  } else if (APP.gameMode === 'bosswars' && APP.bossWars && APP.bossWars.active) {
    // Boss Wars: bygg flat platform, sätt hjälte lvl 30, applicera prep-val, spawna boss
    buildBossWarsScene();
    bossWarsSceneGroup.visible = true;
    arenaSceneGroup.visible = false;
    // MP: skapa sides[2] och sides[3] för de andra peers (3-hero co-op).
    // I solo förblir det bara sides[1].
    const peerPayloads = (APP.bossWars && APP.bossWars.peerPayloads) || {};
    if (bossMpState.matchActive) {
      if (!sides[2]) sides[2] = createSide(2);
      if (!sides[3]) sides[3] = createSide(3);
      // Applicera varje peers hjälte-val på sin sida (sides[peerIdx])
      for (const idx of [1, 2, 3]) {
        const s = sides[idx];
        if (!s) continue;
        const p = peerPayloads[idx];
        s.heroId = (p && p.hero) || 'magiker';
        swapHeroMeshIfNeeded(s);
      }
    }
    // Spawn-positioner: alla 3 hjältar i spawn-rummet, nära varandra.
    // Triangulär uppställning så de inte överlappar. Bossen är öster om
    // korridor + gate och inaktiv tills alla 3 är inne i boss-rummet.
    const spawnPoints = {
      1: { x: SPAWN_ROOM_CX - 2, z: SPAWN_ROOM_CZ },
      2: { x: SPAWN_ROOM_CX + 1, z: SPAWN_ROOM_CZ - 3 },
      3: { x: SPAWN_ROOM_CX + 1, z: SPAWN_ROOM_CZ + 3 },
    };
    const activeIdxs = bossMpState.matchActive ? [1, 2, 3] : [1];
    for (const idx of activeIdxs) {
      const s = sides[idx];
      if (!s) continue;
      // Talents/items: applicera varje peers val på sin sida (sides[peerIdx])
      if (bossMpState.matchActive) {
        const p = peerPayloads[idx];
        s.bossWarsTalents = (p && p.tals ? p.tals : []).slice();
        s.bossWarsItems = (p && p.items ? p.items : []).slice();
      } else {
        s.bossWarsTalents = (APP.bossWars.selectedTalents || []).slice();
        s.bossWarsItems = (APP.bossWars.selectedItems || []).slice();
      }
      s.phoenixReviveAvailable = true;
      s.level = 30;
      s.xp = 0;
      s.xpToNext = xpForLevel(30);
      const sp = spawnPoints[idx] || spawnPoints[1];
      s.hero.x = sp.x;
      s.hero.z = sp.z;
      s.hero.facingX = 1; s.hero.facingZ = 0;
      s.hero.hp = s.hero.maxHp;
      s.hero.dead = false;
      s.hero.respawnTimer = 0;
      if (s.mesh) {
        s.mesh.position.set(s.hero.x, 0, s.hero.z);
        s.mesh.rotation.y = Math.atan2(s.hero.facingX, s.hero.facingZ);
        // Hero +15% storlek i boss wars (raid-känsla, syns bättre vs stor boss).
        // Aragurn-svärdet är child av mesh:n så det skalas automatiskt.
        s.mesh.scale.set(1.15, 1.15, 1.15);
        s.mesh.userData.bossWarsScaled = true;
      }
    }
    // Spawna boss — bara host (eller solo) gör det. Klienter får boss via b-state.
    const isMpClient = bossMpState.matchActive && bossMpState.role === 'client';
    if (!isMpClient) {
      spawnBossWarsBoss(sides[1], APP.bossWars.tier || 1);
    }
    // Boss Wars co-op: bossen ligger i sides[1].monsters, men hero-skills på peer 2/3
    // itererar side.monsters i sin egen sida (tom). Dela monsters-arrayen så
    // alla hero-skills träffar bossen oavsett vem som castar. updateMonsters
    // skippas för sides 2/3 i simulateAll (annars triple-tick av boss-AI).
    if (bossMpState.matchActive) {
      if (sides[2]) sides[2].monsters = sides[1].monsters;
      if (sides[3]) sides[3].monsters = sides[1].monsters;
    }
    // Markera match som startad — först nu får checkMatchEnd avgöra utgång
    APP.bossWars.started = true;
    // Boss inaktiv tills alla aktiva heroes är inne i boss-rummet. Då stängs gaten.
    APP.bossWars.bossActivated = false;
    APP.bossWars.gateClosed = false;
    // Säkerställ att gaten är dold visuellt vid match-start (build-cache kan
    // ha lämnat den visible från en tidigare match).
    if (bossWarsSceneGroup.userData.gate) bossWarsSceneGroup.userData.gate.visible = false;
    if (bossWarsSceneGroup.userData.gateGlow) bossWarsSceneGroup.userData.gateGlow.visible = false;
    // MP: anpassa APP.localSide så camera/HUD följer lokal hero
    if (bossMpState.matchActive) APP.localSide = bossMpState.peerIdx;
  } else {
    arenaSceneGroup.visible = false;
    bossWarsSceneGroup.visible = false;
  }
  // Recompute stats för solo (MP får från servern)
  if (APP.mode === 'solo') {
    if (sides[1]) recomputeSideStats(sides[1]);
  } else if (APP.gameMode === 'arena1v1') {
    // I arena vill vi att klientens lvl 30 också ger rätt stats lokalt
    if (sides[1]) recomputeSideStats(sides[1]);
    if (sides[2]) recomputeSideStats(sides[2]);
  }
  // Boss Wars MP: recompute stats för alla 3 sidor så talents/items applicieras
  // (annars förblir attackDmg/maxHp/moveSpeed på defaults oavsett val i prep).
  if (APP.gameMode === 'bosswars' && bossMpState.matchActive) {
    for (const idx of [1, 2, 3]) {
      if (sides[idx]) recomputeSideStats(sides[idx]);
    }
  }
}

function swapHeroMeshIfNeeded(side) {
  const wantedHeroId = side.heroId || 'magiker';
  const currentHeroId = side.mesh?.userData?.heroId || 'magiker';
  if (wantedHeroId === currentHeroId) return;
  // Behåll position, rotation, scale och hp-bar-state
  const oldMesh = side.mesh;
  const newMesh = makeHeroMesh(side.idx, wantedHeroId);
  newMesh.position.copy(oldMesh.position);
  newMesh.rotation.y = oldMesh.rotation.y;
  newMesh.visible = oldMesh.visible;
  // Behåll boss-wars +15%-scale om gammal mesh hade det
  if (oldMesh.userData && oldMesh.userData.bossWarsScaled) {
    newMesh.scale.set(1.15, 1.15, 1.15);
    newMesh.userData.bossWarsScaled = true;
  }
  attachHpBar(newMesh, 2.0, true);
  scene.add(newMesh);
  scene.remove(oldMesh);
  side.mesh = newMesh;
}

// Options-meny (kugghjul under match): pause + lämna match
const optionsBtnEl = document.getElementById('options-btn');
const optionsOverlayEl = document.getElementById('options-overlay');
const optResumeBtn = document.getElementById('opt-resume');
const optLeaveBtn = document.getElementById('opt-leave');
function openOptionsOverlay() { if (optionsOverlayEl) optionsOverlayEl.classList.remove('hidden'); }
function closeOptionsOverlay() { if (optionsOverlayEl) optionsOverlayEl.classList.add('hidden'); }
if (optionsBtnEl) optionsBtnEl.addEventListener('click', openOptionsOverlay);
if (optResumeBtn) optResumeBtn.addEventListener('click', closeOptionsOverlay);
if (optLeaveBtn) optLeaveBtn.addEventListener('click', () => {
  closeOptionsOverlay();
  returnToLobby();
});
// Klick på overlay-bakgrund (utanför kortet) stänger menyn
if (optionsOverlayEl) {
  optionsOverlayEl.addEventListener('click', (e) => {
    if (e.target === optionsOverlayEl) closeOptionsOverlay();
  });
}

function returnToLobby() {
  closeOptionsOverlay();
  bossMpCleanupAfterMatch();   // ingen-op om inte aktiv
  closeRelay();
  pendingHostCode = null;
  // Städar alla 4 sidor (2v2 kan ha sides[3]/[4])
  for (const i of [1, 2, 3, 4]) {
    if (sides[i]) { removeSide(sides[i]); sides[i] = null; }
  }
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
  // Arena cleanup
  arenaSceneGroup.visible = false;
  resetArenaState();
  hideArenaPrep();
  hideArenaEnd();
  hideArenaCountdown();
  if (arenaRoundEl) arenaRoundEl.classList.add('hidden');
  lobbyEl.classList.remove('hidden');
  showLobbyPanel('main');
  APP.mode = 'lobby';
  APP.gameMode = 'classic';
  resetIncomeTickTracking();
}

document.getElementById('btn-host').addEventListener('click', () => {
  APP.gameMode = 'classic';
  APP.arenaBot = { active: false, difficulty: null };
  hostGame();
});
document.getElementById('btn-host-cancel').addEventListener('click', cancelHosting);
document.getElementById('btn-join').addEventListener('click', () => {
  APP.gameMode = 'classic';
  APP.arenaBot = { active: false, difficulty: null };
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
document.getElementById('btn-solo').addEventListener('click', () => {
  APP.gameMode = 'classic';
  APP.arenaBot = { active: false, difficulty: null };
  showHeroPick('solo');
});
document.getElementById('btn-heroes').addEventListener('click', () => { renderHeroesBrowser(); showLobbyPanel('heroes'); });
document.getElementById('btn-items').addEventListener('click', () => { renderItemsBrowser(); showLobbyPanel('items'); });
// Per-mode How to Play-knappar. Sticky return-panel så Back-knappen returnerar
// till rätt sub-meny (line-team / arena-team / boss-mode).
const _btnHowtoLine = document.getElementById('btn-howto-line');
if (_btnHowtoLine) _btnHowtoLine.addEventListener('click', () => {
  _howtoReturnPanel = 'line-team';
  renderHowto('line');
  showLobbyPanel('howto');
});
const _btnHowtoArena = document.getElementById('btn-howto-arena');
if (_btnHowtoArena) _btnHowtoArena.addEventListener('click', () => {
  _howtoReturnPanel = 'arena-team';
  renderHowto('arena');
  showLobbyPanel('howto');
});
const _btnHowtoBoss = document.getElementById('btn-howto-boss');
if (_btnHowtoBoss) _btnHowtoBoss.addEventListener('click', () => {
  _howtoReturnPanel = 'boss-mode';
  renderHowto('boss');
  showLobbyPanel('howto');
});
document.getElementById('btn-heroes-back').addEventListener('click', () => showLobbyPanel('main'));
document.getElementById('btn-items-back').addEventListener('click', () => showLobbyPanel('main'));
document.getElementById('btn-howto-back').addEventListener('click', () => showLobbyPanel(_howtoReturnPanel || 'main'));
const btnHeroDetailBack = document.getElementById('btn-hero-detail-back');
if (btnHeroDetailBack) btnHeroDetailBack.addEventListener('click', closeHeroDetailModal);
const btnItemDetailBack = document.getElementById('btn-item-detail-back');
if (btnItemDetailBack) btnItemDetailBack.addEventListener('click', closeItemDetailModal);
// Klick på modal-bakgrund stänger också
if (heroDetailModal) heroDetailModal.addEventListener('click', (e) => { if (e.target === heroDetailModal) closeHeroDetailModal(); });
if (itemDetailModal) itemDetailModal.addEventListener('click', (e) => { if (e.target === itemDetailModal) closeItemDetailModal(); });

// ---- Arena Wars ----
function hostArena() {
  APP.gameMode = 'arena1v1';
  APP.arenaTeamSize = 1;   // MP arena: alltid 1v1 (2v2 är solo-only än)
  APP.arenaBot = { active: false, difficulty: null };
  hostGame();
}
function joinArenaShow() {
  APP.gameMode = 'arena1v1';
  APP.arenaTeamSize = 1;   // MP arena: alltid 1v1
  APP.arenaBot = { active: false, difficulty: null };
  lobbyJoinMsgEl.textContent = '';
  showLobbyPanel('joining');
  setTimeout(() => lobbyCodeInputEl.focus(), 50);
}
function arenaSoloShow() {
  // Visa difficulty-väljare innan vi startar bot-matchen
  showLobbyPanel('arena-bot');
}
function arenaSoloStartWithBot(difficulty) {
  APP.gameMode = 'arena1v1';
  APP.arenaTeamSize = 1;
  APP.arenaBot = { active: true, difficulty };
  // Solo: slumpa map (1 av 3)
  arenaState.mapIdx = Math.floor(Math.random() * ARENA_MAPS.length);
  showHeroPick('solo');
}
const btnArenaHost = document.getElementById('btn-arena-host');
if (btnArenaHost) btnArenaHost.addEventListener('click', hostArena);
const btnArenaJoin = document.getElementById('btn-arena-join');
if (btnArenaJoin) btnArenaJoin.addEventListener('click', joinArenaShow);
const btnArenaSolo = document.getElementById('btn-arena-solo');
if (btnArenaSolo) btnArenaSolo.addEventListener('click', arenaSoloShow);
const btnArenaBotBack = document.getElementById('btn-arena-bot-back');
if (btnArenaBotBack) btnArenaBotBack.addEventListener('click', () => { APP.arenaBot = { active: false, difficulty: null }; showLobbyPanel('arena-wars'); });
const btnBotEasy = document.getElementById('btn-bot-easy');
if (btnBotEasy) btnBotEasy.addEventListener('click', () => arenaSoloStartWithBot('easy'));
const btnBotMedium = document.getElementById('btn-bot-medium');
if (btnBotMedium) btnBotMedium.addEventListener('click', () => arenaSoloStartWithBot('medium'));
const btnBotHard = document.getElementById('btn-bot-hard');
if (btnBotHard) btnBotHard.addEventListener('click', () => arenaSoloStartWithBot('hard'));

// ---- Mode-knappar (Line Wars / Arena Wars) — visar team-väljare ----
const btnModeLine = document.getElementById('btn-mode-line');
if (btnModeLine) btnModeLine.addEventListener('click', () => { APP.gameMode = 'classic'; showLobbyPanel('line-team'); });
const btnModeArena = document.getElementById('btn-mode-arena');
if (btnModeArena) btnModeArena.addEventListener('click', () => { APP.gameMode = 'arena1v1'; showLobbyPanel('arena-team'); });

// ---- Team-storlek-väljare ----
const btnLineTeamBack = document.getElementById('btn-line-team-back');
if (btnLineTeamBack) btnLineTeamBack.addEventListener('click', () => showLobbyPanel('main'));
const btnLine1v1 = document.getElementById('btn-line-1v1');
if (btnLine1v1) btnLine1v1.addEventListener('click', () => { APP.gameMode = 'classic'; showLobbyPanel('line-wars'); });
// ---- Boss Wars ----
function bossWarsShow() {
  APP.gameMode = 'bosswars';
  APP.bossWars = { active: false, tier: 0 };  // reset
  showLobbyPanel('boss-mode');
}
// Klick på Host Game från boss-mode-menyn → boss-pick (steg före riktig MP-host)
function bossWarsShowPick() {
  renderBossPickGrid();
  showLobbyPanel('boss-pick');
}
function openBossInfoModal() {
  const modal = document.getElementById('boss-info-modal');
  if (modal) modal.classList.remove('hidden');
}
function closeBossInfoModal() {
  const modal = document.getElementById('boss-info-modal');
  if (modal) modal.classList.add('hidden');
}
function renderBossPickGrid() {
  const grid = document.getElementById('boss-pick-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const b of BOSS_WARS_DEFS) {
    const card = document.createElement('div');
    card.className = 'boss-card';
    card.innerHTML = `
      <div class="bc-tier">TIER ${b.tier}</div>
      <div class="bc-name">${b.name}</div>
      <div class="bc-diff ${b.diffClass}">${b.diff}</div>
      <div class="bc-hp">${b.hp} HP</div>`;
    card.addEventListener('click', () => openBossDetail(b.tier));
    grid.appendChild(card);
  }
}
function openBossDetail(tier) {
  const b = getBossWarsDef(tier);
  if (!b) return;
  const def = BOSS_DEFS[b.wave];
  const skills = def ? def.skills : [];
  const skillNames = {
    shieldBash: 'Shield Bash', throwingAxe: 'Throwing Axe', battleRoar: 'Battle Roar',
    lightningStrike: 'Lightning Strike', spearVolley: 'Spear Volley', warStomp: 'War Stomp',
    cleaveWave: 'Cleave Wave', poisonPool: 'Poison Pool', earthquake: 'Earthquake',
    hellfireBeam: 'Hellfire Beam', infernoStrike: 'Inferno Strike', meteorShower: 'Meteor Shower',
    dragonBreath: 'Dragon Breath', wingSlam: 'Wing Slam', skyfireRain: 'Skyfire Rain',
  };
  const skillDescs = {
    shieldBash: 'Dashar 7m framåt och skadar allt i banan.',
    throwingAxe: 'Kastar en yxa rakt fram (14m räckvidd).',
    battleRoar: '5m AoE-radie runt bossen, applicerar 60% slow i 2s.',
    lightningStrike: 'Targetar din nuvarande position med 2.8m AoE-skada.',
    spearVolley: 'Kastar 3 spjut i en kon-spread framåt.',
    warStomp: '6m AoE runt bossen med 2.5m knockback.',
    cleaveWave: '90° kon framåt, 8m lång.',
    poisonPool: 'Kastar en pöl på din position som tickar DoT + slow i 6s (3m radie).',
    earthquake: '5 slumpmässiga AoE-cirklar (2.5m) spawnas i sekvens runt bossen.',
    hellfireBeam: 'Roterande beam-sweep 180° över 1.8s (12m räckvidd).',
    infernoStrike: 'Snabb telegraferad AoE-strike på din position + brinnande zon 3s.',
    meteorShower: '5 meteorer landar slumpvis runt bossen över 4s.',
    dragonBreath: 'Sustained kon-flam 2.5s (12m räckvidd, smal kon, DPS-tick var 0.3s).',
    wingSlam: '5m AoE runt bossen + 4m knockback.',
    skyfireRain: '8 meteorer regnar över 6s (3m radie per meteor).',
  };
  const body = document.getElementById('boss-detail-body');
  const phase2Pct = Math.round((b.phaseThreshold || 0.5) * 100);
  const phase2Hint = b.hasPhase2
    ? `<div style="margin-top: 14px; padding: 8px 12px; background: rgba(120,40,160,0.35); border-left: 3px solid #ff66cc; font: 400 12.5px/1.45 system-ui, sans-serif; border-radius: 0 6px 6px 0;">⚠ <strong>Phase 2 vid ${phase2Pct}% HP</strong> — bossen byter taktik. Vad som händer får du upptäcka själv.</div>`
    : '';
  let html = `
    <h2>${b.name}</h2>
    <div class="bd-meta">Tier ${b.tier} · ${b.diff} · ${b.hp} HP · damage scale ${b.dmgScale}×</div>
    <p style="margin: 0 0 14px; font: 400 14px/1.5 system-ui, sans-serif; opacity: 0.92;">${b.desc}</p>
    <div style="font: 700 13px/1 system-ui, sans-serif; color: #aa66ff; letter-spacing: 1.5px; margin: 14px 0 6px;">⚔ SKILLS</div>`;
  for (const s of skills) {
    html += `<div class="bd-skill"><div class="bd-skill-name">${skillNames[s.id] || s.id}</div><div class="bd-skill-desc">${skillDescs[s.id] || ''}</div></div>`;
  }
  html += phase2Hint;
  body.innerHTML = html;
  // Spara vald tier till fight-knappen
  const fightBtn = document.getElementById('btn-boss-detail-fight');
  if (fightBtn) fightBtn.dataset.tier = String(tier);
  const modal = document.getElementById('boss-detail-modal');
  if (modal) modal.classList.remove('hidden');
}
function closeBossDetail() {
  const modal = document.getElementById('boss-detail-modal');
  if (modal) modal.classList.add('hidden');
}
function bossWarsStartFight(tier) {
  APP.gameMode = 'bosswars';
  APP.arenaTeamSize = 1;
  APP.bossWars = { active: true, tier, started: false };
  // Force-reset så ev. gammal matchState från tidigare match inte hänger kvar
  matchState.gameOver = false;
  matchState.gameWon = false;
  matchState.winner = 0;
  closeBossDetail();
  // MP: host broadcastar tier till klienterna så alla kan gå till hero-pick parallellt
  if (bossMpState.active && bossMpState.role === 'host' && !bossMpState.matchActive) {
    bossMpState.peersReady = {};   // nollställ ready-tracking inför ny match
    sendGameMsg({ t: 'b-tier', tier });
  }
  showHeroPick('solo');
}
const btnModeBoss = document.getElementById('btn-mode-boss');
if (btnModeBoss) btnModeBoss.addEventListener('click', bossWarsShow);
// ---- Boss Wars MP (3-spelar co-op via relay-server) ----
const bossMpState = {
  active: false,             // true när host-flow eller join-flow är igång
  role: null,                // 'host' | 'client'
  code: null,                // 4-tecken rumskod
  peersTotal: 1,             // hur många i rummet just nu
  maxPeers: 3,
  peerIdx: 1,                // 1=host, 2=första klient, 3=andra klient
  matchActive: false,        // true när vi är i en MP boss-match
  hostTier: 0,               // tier som host valt och broadcastat
  lastStateSent: 0,          // för broadcast-rate-limiting
  lastInputSent: 0,          // för input-rate-limiting
  remoteInput: { 2: null, 3: null },  // host: senaste input från klienter
  pendingEvents: [],         // klient: events som väntar på att skickas till host
  peersReady: {},            // per-peer pick: peersReady[idx] = { hero, tals, items }
  codeDisplayEl: document.getElementById('lobby-boss-code-display'),
  hostMsgEl: document.getElementById('lobby-boss-host-msg'),
  hostCountEl: document.getElementById('lobby-boss-peer-count'),
  startBtnEl: document.getElementById('btn-boss-start-match'),
  codeInputEl: document.getElementById('lobby-boss-code-input'),
  joinMsgEl: document.getElementById('lobby-boss-join-msg'),
  waitCodeEl: document.getElementById('lobby-boss-wait-code'),
  waitCountEl: document.getElementById('lobby-boss-wait-count'),
  waitMsgEl: document.getElementById('lobby-boss-wait-msg'),
};
function updateBossPeerCount(n, max) {
  bossMpState.peersTotal = n;
  if (max) bossMpState.maxPeers = max;
  const text = `Spelare: ${n} / ${bossMpState.maxPeers}`;
  if (bossMpState.hostCountEl) bossMpState.hostCountEl.textContent = text;
  if (bossMpState.waitCountEl) bossMpState.waitCountEl.textContent = text;
  if (bossMpState.startBtnEl) {
    const ready = (n >= bossMpState.maxPeers);
    bossMpState.startBtnEl.disabled = !ready;
    bossMpState.startBtnEl.style.opacity = ready ? '1' : '0.5';
    bossMpState.startBtnEl.textContent = ready ? 'Starta matchen' : `Starta matchen (${n}/${bossMpState.maxPeers})`;
  }
}
async function bossWarsHostGame() {
  APP.gameMode = 'bosswars';
  APP.bossWars = { active: true, tier: 0 };
  bossMpState.active = true;
  bossMpState.role = 'host';
  bossMpState.code = null;
  bossMpState.peersTotal = 1;
  if (bossMpState.codeDisplayEl) bossMpState.codeDisplayEl.textContent = '----';
  if (bossMpState.hostMsgEl) bossMpState.hostMsgEl.textContent = 'Ansluter till server (kan ta ~30 s om servern sover)...';
  updateBossPeerCount(1, 3);
  showLobbyPanel('boss-host');
  try {
    await openRelay();
  } catch (err) {
    if (bossMpState.hostMsgEl) bossMpState.hostMsgEl.innerHTML = `<span class="err">Kunde inte nå servern: ${err.message || 'okänt fel'}</span>`;
    bossMpState.active = false;
    return;
  }
  wsSendEnvelope({ t: 'host', maxPeers: 3 });
  if (bossMpState.hostMsgEl) bossMpState.hostMsgEl.textContent = 'Skapar rum...';
}
async function bossWarsJoinGame() {
  const code = (bossMpState.codeInputEl ? bossMpState.codeInputEl.value : '').trim().toUpperCase();
  if (code.length !== 4) {
    if (bossMpState.joinMsgEl) bossMpState.joinMsgEl.innerHTML = '<span class="err">Koden måste vara 4 tecken.</span>';
    return;
  }
  APP.gameMode = 'bosswars';
  APP.bossWars = { active: true, tier: 0 };
  bossMpState.active = true;
  bossMpState.role = 'client';
  bossMpState.code = code;
  if (bossMpState.joinMsgEl) bossMpState.joinMsgEl.textContent = 'Ansluter till server (kan ta ~30 s om servern sover)...';
  try {
    await openRelay();
  } catch (err) {
    if (bossMpState.joinMsgEl) bossMpState.joinMsgEl.innerHTML = `<span class="err">Kunde inte nå servern: ${err.message || 'okänt fel'}</span>`;
    bossMpState.active = false;
    return;
  }
  if (bossMpState.joinMsgEl) bossMpState.joinMsgEl.textContent = 'Söker rummet...';
  wsSendEnvelope({ t: 'join', code });
}
function bossWarsLeaveLobby() {
  bossMpState.active = false;
  bossMpState.role = null;
  bossMpState.code = null;
  closeRelay();
  APP.gameMode = 'classic';
  APP.bossWars = { active: false, tier: 0 };
  showLobbyPanel('boss-mode');
}
function bossWarsHostStartMatch() {
  if (bossMpState.role !== 'host') return;
  if (bossMpState.peersTotal < bossMpState.maxPeers) return;
  // Berätta för klienterna att host nu går till boss-pick. Klienterna stannar
  // kvar på wait-panelen tills host broadcastar b-launch.
  sendGameMsg({ t: 'b-start' });
  bossWarsShowPick();   // Host väljer boss + prep ensam; clients väntar
}
function bossMpCleanupAfterMatch() {
  // Anropas från returnToLobby — nolla allt boss-MP-state.
  // No-op om inte aktiv.
  if (!bossMpState.active && !bossMpState.matchActive) return;
  bossMpState.active = false;
  bossMpState.matchActive = false;
  bossMpState.peerIdx = 1;
  bossMpState.hostTier = 0;
  bossMpState.remoteInput = { 2: null, 3: null };
  bossMpState.pendingEvents = [];
  bossMpState.lastStateSent = 0;
  bossMpState.lastInputSent = 0;
  bossMpState.peersReady = {};
  // Återställ prep-panel UI till default-state inför nästa match
  const waitEl = document.getElementById('bp-mp-waiting');
  if (waitEl) waitEl.classList.add('hidden');
  const startBtn = document.getElementById('bp-start-btn');
  if (startBtn) startBtn.classList.remove('hidden');
}
// Wire up boss-MP-knappar
const btnBossStart = document.getElementById('btn-boss-start-match');
if (btnBossStart) btnBossStart.addEventListener('click', bossWarsHostStartMatch);
const btnBossHostCancel = document.getElementById('btn-boss-host-cancel');
if (btnBossHostCancel) btnBossHostCancel.addEventListener('click', bossWarsLeaveLobby);
const btnBossJoinConnect = document.getElementById('btn-boss-join-connect');
if (btnBossJoinConnect) btnBossJoinConnect.addEventListener('click', bossWarsJoinGame);
const btnBossJoinBack = document.getElementById('btn-boss-join-back');
if (btnBossJoinBack) btnBossJoinBack.addEventListener('click', () => { closeRelay(); bossMpState.active = false; showLobbyPanel('boss-mode'); });
const btnBossWaitLeave = document.getElementById('btn-boss-wait-leave');
if (btnBossWaitLeave) btnBossWaitLeave.addEventListener('click', bossWarsLeaveLobby);
if (bossMpState.codeInputEl) {
  bossMpState.codeInputEl.addEventListener('input', () => {
    bossMpState.codeInputEl.value = bossMpState.codeInputEl.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  });
  bossMpState.codeInputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') bossWarsJoinGame(); });
}
if (bossMpState.codeDisplayEl) {
  bossMpState.codeDisplayEl.addEventListener('click', () => {
    const code = bossMpState.codeDisplayEl.textContent.trim();
    if (code && code !== '----' && navigator.clipboard) {
      navigator.clipboard.writeText(code).then(() => {
        if (bossMpState.hostMsgEl) bossMpState.hostMsgEl.textContent = `Kopierat: ${code} — dela med vänner!`;
      });
    }
  });
}

// Boss-mode panel: Host / Join / Info / Tillbaka
const btnBossModeBack = document.getElementById('btn-boss-mode-back');
if (btnBossModeBack) btnBossModeBack.addEventListener('click', () => { APP.gameMode = 'classic'; APP.bossWars = { active: false, tier: 0 }; showLobbyPanel('main'); });
const btnBossHost = document.getElementById('btn-boss-host');
if (btnBossHost) btnBossHost.addEventListener('click', () => { bossWarsHostGame(); });
const btnBossJoin = document.getElementById('btn-boss-join');
if (btnBossJoin) btnBossJoin.addEventListener('click', () => {
  bossMpState.joinMsgEl && (bossMpState.joinMsgEl.textContent = '');
  if (bossMpState.codeInputEl) { bossMpState.codeInputEl.value = ''; setTimeout(() => bossMpState.codeInputEl.focus(), 50); }
  showLobbyPanel('boss-join');
});
const btnBossInfo = document.getElementById('btn-boss-info');
if (btnBossInfo) btnBossInfo.addEventListener('click', openBossInfoModal);
const btnBossInfoBack = document.getElementById('btn-boss-info-back');
if (btnBossInfoBack) btnBossInfoBack.addEventListener('click', closeBossInfoModal);
const bossInfoModal = document.getElementById('boss-info-modal');
if (bossInfoModal) bossInfoModal.addEventListener('click', (e) => { if (e.target === bossInfoModal) closeBossInfoModal(); });
// Boss-pick panel: tillbaka går till boss-mode-menyn (inte main)
const btnBossBack = document.getElementById('btn-boss-back');
if (btnBossBack) btnBossBack.addEventListener('click', () => showLobbyPanel('boss-mode'));
const btnBossDetailBack = document.getElementById('btn-boss-detail-back');
if (btnBossDetailBack) btnBossDetailBack.addEventListener('click', closeBossDetail);
const btnBossDetailFight = document.getElementById('btn-boss-detail-fight');
if (btnBossDetailFight) btnBossDetailFight.addEventListener('click', () => {
  const tier = parseInt(btnBossDetailFight.dataset.tier || '1', 10);
  bossWarsStartFight(tier);
});
const bossDetailModal = document.getElementById('boss-detail-modal');
if (bossDetailModal) bossDetailModal.addEventListener('click', (e) => { if (e.target === bossDetailModal) closeBossDetail(); });

const btnArenaTeamBack = document.getElementById('btn-arena-team-back');
if (btnArenaTeamBack) btnArenaTeamBack.addEventListener('click', () => { APP.gameMode = 'classic'; APP.arenaBot = { active: false, difficulty: null }; showLobbyPanel('main'); });
const btnArena1v1Mode = document.getElementById('btn-arena-1v1');
if (btnArena1v1Mode) btnArena1v1Mode.addEventListener('click', () => { APP.gameMode = 'arena1v1'; APP.arenaTeamSize = 1; showLobbyPanel('arena-wars'); });
const btnArena2v2Mode = document.getElementById('btn-arena-2v2');
if (btnArena2v2Mode) btnArena2v2Mode.addEventListener('click', () => { APP.gameMode = 'arena1v1'; APP.arenaTeamSize = 2; showLobbyPanel('arena-2v2'); });

// ---- Submenu-back-knappar ----
const btnLineBack = document.getElementById('btn-line-back');
if (btnLineBack) btnLineBack.addEventListener('click', () => showLobbyPanel('line-team'));
const btnArenaBack = document.getElementById('btn-arena-back');
if (btnArenaBack) btnArenaBack.addEventListener('click', () => { APP.arenaBot = { active: false, difficulty: null }; showLobbyPanel('arena-team'); });

// ---- Arena 2v2-panel ----
const btnArena2v2Solo = document.getElementById('btn-arena-2v2-solo');
if (btnArena2v2Solo) btnArena2v2Solo.addEventListener('click', () => {
  APP.gameMode = 'arena1v1';
  APP.arenaTeamSize = 2;
  APP.arenaBot = { active: false, difficulty: null };
  showHeroPick('solo');
});
const btnArena2v2Back = document.getElementById('btn-arena-2v2-back');
if (btnArena2v2Back) btnArena2v2Back.addEventListener('click', () => { APP.arenaTeamSize = 1; showLobbyPanel('arena-team'); });

// ============================================================
// HUVUDLOOP
// ============================================================

const clock = new THREE.Clock();

function simulateAll(dt) {
  // I arena: pausa all gameplay-sim utanför 'fight'-fasen (prep + roundEnd + matchEnd)
  if (APP.gameMode === 'arena1v1' && arenaState.phase !== 'fight') return;
  // Boss Wars: check om alla aktiva heroes är i boss-rummet → aktivera bossen
  if (APP.gameMode === 'bosswars') checkBossWarsActivation();
  // Lokal duel-timer (bara HUD, ingen duel triggas i solo). Stannar vid 0.
  if (duelState.timer > 0) duelState.timer = Math.max(0, duelState.timer - dt);
  // Hjälte-respawn
  for (const side of activeSides()) {
    if (!side) continue;
    // I arena + boss wars: ingen auto-respawn — match avslutas vid hero-död
    if (side.hero.dead && APP.gameMode !== 'arena1v1' && APP.gameMode !== 'bosswars') {
      side.hero.respawnTimer -= dt;
      if (side.hero.respawnTimer <= 0) respawnHero(side);
    }
  }
  // Applicera input för lokal sida (host=1, solo=1)
  if (sides[APP.localSide]) {
    const raw = readLocalJoystick();
    const dir = screenToWorld(raw.x, raw.z);
    applyMovement(sides[APP.localSide], dir.x, dir.z, dt);
  }
  // I arena-MP host: applicera klientens senaste input på sides[2]
  if (isArenaMp() && APP.mode === 'host' && sides[2]) {
    const ri = APP.remoteArenaInput;
    if (ri) {
      applyMovement(sides[2], ri.jx || 0, ri.jz || 0, dt);
      if (ri.events && ri.events.length) {
        for (const ev of ri.events) applyEvent(sides[2], ev);
        ri.events = [];
      }
    }
  }
  // Boss Wars MP host: applicera klienternas senaste input på sides[2] och sides[3]
  if (bossMpState.matchActive && bossMpState.role === 'host') {
    applyBossWarsRemoteInputs(dt);
  }
  // Arena solo vs bot: driv sides[2] med AI
  if (APP.gameMode === 'arena1v1' && APP.mode === 'solo' && sides[2] && sides[2].isBot && arenaState.phase === 'fight') {
    tickArenaBot(sides[2], dt);
  }
  // (Klassisk multiplayer-fjärrsidans input hanteras av servern numera.)
  // Fontän-aura: compute närhet till egen fontän + regen, innan andra updates
  for (const side of activeSides()) {
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
      // Titans Armor: regen X% av FÖRLORAD HP per sek (% av (maxHP - hp))
      if ((side.hpRegenLostPct || 0) > 0 && side.hero.hp < side.hero.maxHp) {
        const lost = side.hero.maxHp - side.hero.hp;
        side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + lost * side.hpRegenLostPct * dt);
      }
      // Titans Taunt passive heal: 20% av maxHP per sek (+50% med Vengeful Roar-talent)
      if ((side.titansTauntRemaining || 0) > 0 && side.hero.hp < side.hero.maxHp) {
        const tauntHealMul = arenaHasTalent(side, 'g_taunt_heal') ? 1.5 : 1.0;
        side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + side.hero.maxHp * TAUNT_HEAL_PER_SEC * tauntHealMul * dt);
      }
      // Gimlu Stalwart Resolve regen: 5%/s när <60% HP
      if (side.heroId === 'gimlu' && side.hero.hp < side.hero.maxHp) {
        const ratio = side.hero.maxHp > 0 ? side.hero.hp / side.hero.maxHp : 1;
        if (ratio < GIMLU_PASSIVE_TIER2_HP) {
          side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + side.hero.maxHp * GIMLU_PASSIVE_TIER2_REGEN * dt);
        }
      }
    }
  }
  const isArena = APP.gameMode === 'arena1v1';
  const isBossWars = APP.gameMode === 'bosswars';
  // Per-sida simulering
  for (const side of activeSides()) {
    if (!side) continue;
    updateSkillCooldowns(side, dt);
    if (!isArena && !isBossWars) {
      updateWaves(side, dt);
      updateMonsters(side, dt);
      updatePlayerCreeps(side, dt);
      updateCreepProjectiles(side, dt);
    } else if (isBossWars) {
      // Boss Wars: bara monster-tick (för boss-AI), inga waves/creeps.
      // Sides 2/3 delar samma monsters-array som sides[1] (shared-pointer
      // ovan i enterPlayPhase), så hopp över tick:n för dem — annars körs
      // boss-AI 3× per frame.
      if (side.idx === 1) updateMonsters(side, dt);
    }
    if (!side.hero.dead) updateHeroAttack(side, dt);
    updateProjectiles(side, dt);
    updateFireballs(side, dt);
    updateBlackHolesSolo(side, dt);
    updateVineTrapsSolo(side, dt);
    updateHammersSolo(side, dt);
    updateIronWillSolo(side, dt);
    if ((side.legolusBuffRemaining || 0) > 0) side.legolusBuffRemaining = Math.max(0, side.legolusBuffRemaining - dt);
    // Ult-cast-lockout (5s ingen ult-gain efter ult castas)
    if ((side._ultLockoutTime || 0) > 0) side._ultLockoutTime = Math.max(0, side._ultLockoutTime - dt);
    if ((side.gandulfBuffRemaining || 0) > 0) {
      side.gandulfBuffRemaining = Math.max(0, side.gandulfBuffRemaining - dt);
      if (side.gandulfBuffRemaining === 0) side.gandulfBuffStacks = 0;
    }
    if ((side.titansTauntRemaining || 0) > 0) side.titansTauntRemaining = Math.max(0, side.titansTauntRemaining - dt);
    // Tick hero-CC (taunted/frusen/rotad av motspelaren)
    if ((side.hero.tauntedTime || 0) > 0) {
      side.hero.tauntedTime = Math.max(0, side.hero.tauntedTime - dt);
      if (side.hero.tauntedTime === 0) side.hero.tauntedBy = 0;
    }
    if ((side.hero.frozenTime || 0) > 0) {
      side.hero.frozenTime = Math.max(0, side.hero.frozenTime - dt);
    }
    updateNovaEffects(side, dt);
    updateActiveBuffs(side, dt);
    tickLingShield(side, dt);
    tickIceBlock(side, dt);
    tickFearWave(side, dt);
    tickBossProjectiles(side, dt);
    tickBossPools(side, dt);
    // Ult-energy passiv gain + ult-tick (laser/rage/arrows)
    if (!side.hero.dead) gainUltEnergy(side, ULT_GAIN_PASSIVE * dt);
    tickUltimates(side, dt);
    tickBigArrows(side, dt);
    // Shadow Volley (Legolus ult) tick: invis-timer + thorn pools (solo/arena/boss).
    // I classic MP är server auktoritativ — invis-flagga + TP-pools synkas via snap;
    // dessa client-side ticks är no-op då (state.legolusInvisRemaining nollställs av snap).
    tickClientLegolusInvis(side, dt);
    tickClientThornPools(side, dt);
    if (!isArena) tickIncome(side, dt);
  }
  if (!isArena) checkMatchEnd();
  // Game-over-prompt visas via befintliga options-UI'n; spara att vi vunnit
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
  // Dölj income-display i arena (ingen income-mekanik där)
  if (APP.gameMode === 'arena1v1') {
    incomeDisplayEl.style.display = 'none';
    return;
  }
  incomeDisplayEl.style.display = '';
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

// ============================================================
// COMBAT FX — kortlivade visuella effekter (slash, hit-spark, heal, shield)
// ============================================================
const combatFx = [];

function spawnSlashFx(x, z, color = 0xffd060) {
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.18), mat);
  plane.position.set(x, 1.0, z);
  plane.rotation.x = -Math.PI / 2;
  plane.rotation.z = Math.random() * Math.PI;
  scene.add(plane);
  combatFx.push({ mesh: plane, life: 0.22, maxLife: 0.22, kind: 'slash' });
}

// Skapar hero-specifik AA-projektil-mesh. Default fallback = klassisk gyllene sphere.
// heroId: 'magiker' (frostbolt), 'legolas' (pil), 'gimlu' (hammare).
// isAoE: true → större + lila (Magiker passive AoE).
// isCrit: true → orange-rött glow-boost.
function makeHeroAaProjectileMesh(heroId, isAoE, isCrit) {
  const grp = new THREE.Group();
  if (heroId === 'legolas') {
    // Pil: brun cylinder-skaft + grön spets + 3 fjädrar bakåt.
    const shaftMat = new THREE.MeshStandardMaterial({ color: 0x7a4a22, roughness: 0.7, emissive: 0x33aa33, emissiveIntensity: 0.45 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.85, 8), shaftMat);
    shaft.rotation.x = Math.PI / 2;
    grp.add(shaft);
    const tipMat = new THREE.MeshStandardMaterial({ color: 0xddff88, emissive: 0x99dd44, emissiveIntensity: 1.4, metalness: 0.3 });
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.30, 8), tipMat);
    tip.rotation.x = Math.PI / 2;
    tip.position.z = 0.55;
    grp.add(tip);
    const featherMat = new THREE.MeshBasicMaterial({ color: isCrit ? 0xffaa44 : 0x88cc55, transparent: true, opacity: 0.92, side: THREE.DoubleSide });
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2;
      const f = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.20), featherMat);
      f.position.set(Math.cos(ang) * 0.05, Math.sin(ang) * 0.05, -0.38);
      f.rotation.z = ang;
      grp.add(f);
    }
    grp.userData.orientToMotion = true;
    grp.userData.trailColor = isCrit ? 0xffcc66 : 0xaaee66;
    return grp;
  }
  if (heroId === 'aragurn') {
    // Svärds-svep: liten roterande klinga som följer slaget (melee-känsla).
    const bladeMat = new THREE.MeshStandardMaterial({ color: 0xeaeaea, metalness: 0.8, roughness: 0.25, emissive: isCrit ? 0xff7733 : 0xddc680, emissiveIntensity: isCrit ? 0.9 : 0.35 });
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.55, 0.03), bladeMat);
    grp.add(blade);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 5), bladeMat);
    tip.position.y = 0.36;
    grp.add(tip);
    const guardMat = new THREE.MeshStandardMaterial({ color: 0x8a6a30, metalness: 0.5 });
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.06), guardMat);
    guard.position.y = -0.30;
    grp.add(guard);
    grp.userData.spin = true;
    grp.userData.trailColor = isCrit ? 0xff7733 : 0xffd388;
    return grp;
  }
  if (heroId === 'gimlu') {
    // Hammare: grått huvud (box) + brun handle (cylinder), roterar under flykt.
    const headMat = new THREE.MeshStandardMaterial({ color: 0xb8b8c0, metalness: 0.7, roughness: 0.35, emissive: 0xff5522, emissiveIntensity: isCrit ? 0.7 : 0.25 });
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.30, 0.28), headMat);
    head.position.set(0, 0.18, 0);
    grp.add(head);
    const handleMat = new THREE.MeshStandardMaterial({ color: 0x7a4a22, roughness: 0.8 });
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.45, 8), handleMat);
    handle.position.set(0, -0.10, 0);
    grp.add(handle);
    // Två röda "runor" på hammarhuvudets sidor
    const runeMat = new THREE.MeshBasicMaterial({ color: 0xff6633, transparent: true, opacity: 0.95 });
    for (const sx of [-1, 1]) {
      const r = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.18), runeMat);
      r.position.set(sx * 0.181, 0.18, 0);
      r.rotation.y = Math.PI / 2;
      grp.add(r);
    }
    grp.userData.spin = true;
    grp.userData.trailColor = isCrit ? 0xff6622 : 0xddaa44;
    return grp;
  }
  // Magiker: frostbolt — blå/cyan kärna + ytterskal av is-fragment, point-light.
  const coreSize = isAoE ? 0.28 : 0.20;
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(coreSize, 1),
    new THREE.MeshStandardMaterial({
      color: isAoE ? 0xff77ff : 0xaaddff,
      emissive: isAoE ? 0xaa44dd : 0x4488ff,
      emissiveIntensity: isCrit ? 1.6 : 1.1,
    })
  );
  grp.add(core);
  // Tre is-fragment (mindre tetraedrar) runt kärnan
  const fragMat = new THREE.MeshBasicMaterial({ color: 0xddeeff, transparent: true, opacity: 0.75 });
  for (let i = 0; i < 3; i++) {
    const f = new THREE.Mesh(new THREE.TetrahedronGeometry(0.08, 0), fragMat);
    const a = (i / 3) * Math.PI * 2;
    f.position.set(Math.cos(a) * coreSize * 1.4, Math.sin(a * 1.3) * 0.12, Math.sin(a) * coreSize * 1.4);
    grp.add(f);
  }
  const lt = new THREE.PointLight(isAoE ? 0xaa66ff : 0x66bbff, 1.6, 4.5);
  grp.add(lt);
  grp.userData.spin = true;
  grp.userData.trailColor = isAoE ? 0xcc66ff : 0x88ccff;
  return grp;
}

// ============================================================
// FLYTANDE TEXT-POPUPS (damage / heal / shield / CC) via DOM-overlay
// ============================================================
const fxOverlayEl = document.getElementById('fx-overlay');
const _fxProjVec = new THREE.Vector3();
let _fxPopupBudget = 0;
const FX_POPUP_MAX_PER_FRAME = 4;  // max nya popups per frame (cappar spam)
const FX_POPUP_MAX_LIVE = 60;       // hård cap på samtidiga DOM-element

function worldToScreen(x, y, z) {
  _fxProjVec.set(x, y, z).project(camera);
  // NDC (-1..1) → pixlar
  const sx = (_fxProjVec.x * 0.5 + 0.5) * window.innerWidth;
  const sy = (1 - (_fxProjVec.y * 0.5 + 0.5)) * window.innerHeight;
  const behind = _fxProjVec.z < -1 || _fxProjVec.z > 1;
  return { x: sx, y: sy, behind };
}

// type: 'dmg' (röd) | 'crit' (orange större) | 'heal' (grön) | 'shield' (ljusblå) | 'cc' (gul mindre)
function spawnFloatingText(worldX, worldY, worldZ, text, type = 'dmg') {
  if (!fxOverlayEl) return;
  if (_fxPopupBudget >= FX_POPUP_MAX_PER_FRAME) return;
  if (fxOverlayEl.childElementCount >= FX_POPUP_MAX_LIVE) return;
  const p = worldToScreen(worldX, worldY, worldZ);
  if (p.behind) return;
  // Slumpa horisontellt jitter så stackade träffar inte överlappar perfekt
  const jitter = (Math.random() - 0.5) * 24;
  const el = document.createElement('div');
  el.className = 'fx-popup ' + (type === 'crit' ? 'dmg crit' : type);
  el.textContent = text;
  el.style.left = (p.x + jitter) + 'px';
  el.style.top  = (p.y - 12) + 'px';
  el.addEventListener('animationend', () => el.remove(), { once: true });
  fxOverlayEl.appendChild(el);
  _fxPopupBudget++;
}

// Reset:as varje frame i tick()
function resetFxPopupBudget() { _fxPopupBudget = 0; }

// Bekväma wrapper:s med entitets-position
function spawnDamageText(mesh, amount, isCrit = false) {
  if (!mesh || !mesh.position) return;
  const v = Math.round(amount);
  if (v <= 0) return;
  const yTop = (mesh.userData && mesh.userData.hpBar ? mesh.userData.hpBar.position.y : 2.0) + 0.4;
  spawnFloatingText(mesh.position.x, yTop, mesh.position.z, String(v), isCrit ? 'crit' : 'dmg');
}
function spawnHeroDamageText(side, amount, isCrit = false) {
  if (!side || !side.mesh) return;
  spawnDamageText(side.mesh, amount, isCrit);
}
function spawnHealText(mesh, amount) {
  if (!mesh || !mesh.position) return;
  const v = Math.round(amount);
  if (v <= 0) return;
  const yTop = (mesh.userData && mesh.userData.hpBar ? mesh.userData.hpBar.position.y : 2.0) + 0.4;
  spawnFloatingText(mesh.position.x, yTop, mesh.position.z, '+' + v, 'heal');
}
function spawnHeroHealText(side, amount) {
  if (!side || !side.mesh) return;
  spawnHealText(side.mesh, amount);
}
function spawnShieldText(mesh, amount) {
  if (!mesh || !mesh.position) return;
  const v = Math.round(amount);
  if (v <= 0) return;
  const yTop = (mesh.userData && mesh.userData.hpBar ? mesh.userData.hpBar.position.y : 2.0) + 0.4;
  spawnFloatingText(mesh.position.x, yTop, mesh.position.z, '+' + v + ' shield', 'shield');
}
function spawnCcText(mesh, label) {
  if (!mesh || !mesh.position) return;
  const yTop = (mesh.userData && mesh.userData.hpBar ? mesh.userData.hpBar.position.y : 2.0) + 0.7;
  spawnFloatingText(mesh.position.x, yTop, mesh.position.z, label, 'cc');
}

// Scanna alla entiteter och spawna CC-popup när en CC går från 0 → aktiv.
// Repeat var 2s medan CC är aktiv så spelaren ser status-texten flera gånger.
const CC_DEFS = [
  { key: 'tauntedTime', label: 'TAUNTED' },
  { key: 'frozenTime',  label: 'FROZEN' },
  { key: 'fearTime',    label: 'STUNNED' },     // bossar/monster: fearTime
  { key: 'heroFearTime',label: 'STUNNED' },     // hero: heroFearTime
  { key: 'slowTime',    label: 'SLOWED' },       // monster/creep
  { key: 'heroSlowTime',label: 'SLOWED' },       // hero
  { key: 'poisonRemaining', label: 'POISONED' },
  { key: 'dotRemaining', label: 'BURNING' },
];
const CC_REPEAT_INTERVAL = 2.0;

function checkCcStateForEntity(entity, mesh) {
  if (!entity || !mesh) return;
  if (!entity._ccTracked) entity._ccTracked = {};
  for (const def of CC_DEFS) {
    const val = entity[def.key] || 0;
    const t = entity._ccTracked[def.key];
    if (val > 0) {
      if (!t) {
        entity._ccTracked[def.key] = { lastSpawnT: performance.now() / 1000 };
        spawnCcText(mesh, def.label);
      } else {
        const nowS = performance.now() / 1000;
        if (nowS - t.lastSpawnT > CC_REPEAT_INTERVAL) {
          t.lastSpawnT = nowS;
          spawnCcText(mesh, def.label);
        }
      }
    } else if (t) {
      entity._ccTracked[def.key] = null;
    }
  }
}

function checkAllCcStates() {
  // Heroes — kolla både CC på .hero (taunt/frozen/dot/poison) och på .side (fear/slow)
  for (const idx of [1, 2, 3, 4]) {
    const s = sides[idx];
    if (!s || !s.mesh || s.hero.dead) continue;
    checkCcStateForEntity(s.hero, s.mesh);
    // side-objekt äger heroFearTime/heroSlowTime — använd side direkt som "entity"
    checkCcStateForEntity(s, s.mesh);
  }
  // Monsters + creeps i varje side
  for (const idx of [1, 2, 3, 4]) {
    const s = sides[idx];
    if (!s) continue;
    if (Array.isArray(s.monsters)) for (const m of s.monsters) {
      if (m.hp > 0) checkCcStateForEntity(m, m.mesh);
    }
    if (Array.isArray(s.playerCreeps)) for (const c of s.playerCreeps) {
      if (c.hp > 0) checkCcStateForEntity(c, c.mesh);
    }
  }
}

function spawnHitSparkFx(x, y, z, color = 0xffaa44) {
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
  const burst = new THREE.Mesh(new THREE.IcosahedronGeometry(0.18, 0), mat);
  burst.position.set(x, y, z);
  scene.add(burst);
  combatFx.push({ mesh: burst, life: 0.18, maxLife: 0.18, kind: 'spark' });
}

function spawnHealFx(x, z) {
  // Grön plus-symbol som flyter upp
  const grp = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x66ff88, transparent: true, opacity: 0.95 });
  const h = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.10, 0.10), mat);
  const v = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.36, 0.10), mat);
  grp.add(h); grp.add(v);
  grp.position.set(x, 1.7, z);
  scene.add(grp);
  combatFx.push({ mesh: grp, life: 0.9, maxLife: 0.9, kind: 'heal' });
}

function spawnShieldBurstFx(x, z, color = 0x66c8ff) {
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.30, 0.45, 28), mat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.08, z);
  scene.add(ring);
  combatFx.push({ mesh: ring, life: 0.55, maxLife: 0.55, kind: 'shieldBurst' });
}

// Klient-visual för MP: när host's broadcast indikerar att hjälte just AAt
// (attackCounter ökade), spawna en visuell projektil som flyger framåt i
// hero's facing-riktning. På HOST körs simulateAll och spawnar riktiga
// projektiler; på CLIENT skippas simulateAll så vi behöver den här syntheten
// för att användaren ska se "något" hända när de tappar AA.
function triggerClientVisualAA(side) {
  if (!side || !side.mesh || side.hero.dead) return;
  const fx = side.hero.facingX || 0;
  const fz = side.hero.facingZ || 1;
  const heroId = side.heroId || 'magiker';
  const colors = { magiker: 0x88aaff, legolas: 0xaadd77, gimlu: 0xffcc55, aragurn: 0xeeeeee };
  const color = colors[heroId] || 0xffdc66;
  // Större projektil + längre liv så det blir tydligt synligt på klient
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.30, 14, 10),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.98, depthWrite: false })
  );
  sphere.position.set(side.hero.x + fx * 0.5, 1.3, side.hero.z + fz * 0.5);
  scene.add(sphere);
  combatFx.push({
    mesh: sphere, life: 0.6, maxLife: 0.6, kind: 'aaFly',
    vx: fx * 22, vz: fz * 22,
  });
  // Muzzle-flash vid hero (liten ring som expanderar snabbt)
  spawnSkillCastFx(side.hero.x + fx * 0.4, side.hero.z + fz * 0.4, color, 0.8);
}

// Klient-visual för skill-cast — förstärkt med:
// (1) hero-specifika full meshes för Legolas (vine trap / dash / big arrow)
// (2) större cast-ring + ground-impact för alla andra
// (3) trail-partiklar bakom projektil för Q/E/R så casting tydligt syns
function triggerClientVisualSkill(side, key) {
  if (!side || !side.mesh || side.hero.dead) return;
  const heroId = side.heroId || 'magiker';
  // Legolas: använd befintliga full client-prediction-funktioner för Q/E/R i
  // ARENA/BOSS MP där host-broadcast saknar entity-listor för vine traps /
  // big arrows. I CLASSIC MP är servern auktoritativ och broadcastar VT/BA
  // via 'st'-message → klient reconciliear automatiskt. Att också spawna
  // local-only mesh här skulle ge 2 cirklar (en från reconcile som fade:as
  // efter 3s + en local-only som ALDRIG fade:as eftersom updateVineTrapsSolo
  // ej körs i classic MP). Skip routing där.
  const isClassicMpHere = (APP.mode === 'host' || APP.mode === 'client') && APP.gameMode === 'classic';
  if (heroId === 'legolas' && !isClassicMpHere) {
    if (key === 'q') { spawnClientLocalVineTrap(side, side.hero.facingX, side.hero.facingZ, false, 1); return; }
    if (key === 'e') { spawnClientLocalDash(side, side.hero.facingX, side.hero.facingZ); return; }
    // Shadow Volley: ingen pil-mesh längre. Cast-fx hanteras via generic spawnSkillCastFx
    // nedan + invis-mesh-opacity via state-snap. Fall-through till default-pathen.
  }
  const colors = { q: 0xffaa44, f: 0x77ccff, e: 0xbb88ff, r: 0xff44aa };
  const color = colors[key] || 0xffdc66;
  const radius = (key === 'r') ? 3.0 : 1.8;   // större än tidigare
  // Cast-ring vid hero + sekundär ring på marken (ground-impact-feel)
  spawnSkillCastFx(side.hero.x, side.hero.z, color, radius);
  spawnShieldBurstFx(side.hero.x, side.hero.z, color);
  // Projektil-blast i facing-riktning för Q/E/R — större + flyger längre
  if (key === 'q' || key === 'e' || key === 'r') {
    const fx = side.hero.facingX || 0;
    const fz = side.hero.facingZ || 1;
    const size = (key === 'r') ? 0.6 : 0.42;
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(size, 16, 12),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.98, depthWrite: false })
    );
    sphere.position.set(side.hero.x + fx * 0.7, 1.3, side.hero.z + fz * 0.7);
    scene.add(sphere);
    combatFx.push({
      mesh: sphere, life: (key === 'r') ? 1.2 : 0.9,
      maxLife: (key === 'r') ? 1.2 : 0.9, kind: 'aaFly',
      vx: fx * 24, vz: fz * 24,
    });
    // Trail-partiklar bakom projektilen
    for (let i = 0; i < 3; i++) {
      const pf = i * 0.06;
      spawnProjectileTrailPuff(
        side.hero.x + fx * (0.4 + pf),
        1.2 + (Math.random() - 0.5) * 0.3,
        side.hero.z + fz * (0.4 + pf),
        color
      );
    }
  } else if (key === 'f') {
    // F är ofta AoE / self-buff — spawna en större ground-mark vid hero
    spawnGroundImpact(side.hero.x, side.hero.z, 3.0, color);
  }
}

function spawnSkillCastFx(x, z, color, radius = 0.6) {
  // Cast-ring som expanderar (för skills som inte annars har visuell start)
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.08, radius, 32), mat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.06, z);
  scene.add(ring);
  combatFx.push({ mesh: ring, life: 0.45, maxLife: 0.45, kind: 'castRing' });
}

// Visuella effekter för Aragurn-skills på klient (line wars MP).
// Whirlwind: spin hero-mesh + transient golden aura. Leap: y-arc upp/ner +
// landings-impact när leap slutar. Server är auktoritativ och skickar
// whirlwindRemaining/aragurnLeap-state via state-snap; klient renderar.
function tickAragurnVisuals(dt) {
  const idxs = [1, 2];
  for (const idx of idxs) {
    const s = sides[idx];
    if (!s || !s.mesh) continue;
    // Whirlwind: spin hero-mesh snabbt under whirlwindRemaining > 0
    if ((s.whirlwindRemaining || 0) > 0) {
      s.mesh.rotation.y += dt * 18;
      // Spawn aura-puff då och då för "spin"-känsla
      s._wwSpawnAccum = (s._wwSpawnAccum || 0) + dt;
      if (s._wwSpawnAccum > 0.08) {
        s._wwSpawnAccum = 0;
        spawnSkillCastFx(s.hero.x, s.hero.z, 0xffe399, 1.6);
      }
      // Triggra cast-fx vid start (delta-detection)
      if (!s._wwActive) {
        s._wwActive = true;
        spawnShieldBurstFx(s.hero.x, s.hero.z, 0xffd34a);
        triggerCameraShake(0.15, 0.18);
      }
    } else if (s._wwActive) {
      s._wwActive = false;
    }
    // Leap: y-arc. Server skickar leapU (0..1 progress). Peak vid u=0.5.
    if (s.aragurnLeap && s.aragurnLeap.active) {
      const u = s.aragurnLeap.u || 0;
      const peakY = 6.0;
      s.mesh.position.y = Math.sin(u * Math.PI) * peakY;
      if (!s._leapActive) {
        s._leapActive = true;
        spawnSkillCastFx(s.hero.x, s.hero.z, 0xff8844, 1.4);
        spawnShieldBurstFx(s.hero.x, s.hero.z, 0xffaa66);
      }
    } else {
      if (s._leapActive) {
        // Just landed — spawn ground-impact vid current pos
        s._leapActive = false;
        spawnGroundImpact(s.mesh.position.x, s.mesh.position.z, LEAP_RADIUS, 0xff7733);
        triggerCameraShake(0.35, 0.4);
        s.mesh.position.y = 0;
      } else if (s.mesh.position.y !== 0) {
        s.mesh.position.y = 0;
      }
    }
  }
}

function tickCombatFx(dt) {
  for (let i = combatFx.length - 1; i >= 0; i--) {
    const e = combatFx[i];
    e.life -= dt;
    if (e.life <= 0) {
      scene.remove(e.mesh);
      combatFx.splice(i, 1);
      continue;
    }
    const t = 1 - e.life / e.maxLife;
    if (e.kind === 'slash') {
      e.mesh.scale.setScalar(1 + t * 0.8);
      if (e.mesh.material) e.mesh.material.opacity = 0.9 * (1 - t);
    } else if (e.kind === 'spark') {
      e.mesh.scale.setScalar(1 + t * 2);
      if (e.mesh.material) e.mesh.material.opacity = 0.95 * (1 - t);
    } else if (e.kind === 'heal') {
      e.mesh.position.y += dt * 1.4;
      e.mesh.children.forEach(c => { if (c.material) c.material.opacity = 1.0 * (1 - t); });
    } else if (e.kind === 'shieldBurst') {
      e.mesh.scale.setScalar(1 + t * 3.5);
      if (e.mesh.material) e.mesh.material.opacity = 0.7 * (1 - t);
    } else if (e.kind === 'castRing') {
      e.mesh.scale.setScalar(1 + t * 1.8);
      if (e.mesh.material) e.mesh.material.opacity = 0.85 * (1 - t);
    } else if (e.kind === 'trail') {
      e.mesh.scale.setScalar(1 - t * 0.5);
      if (e.mesh.material) e.mesh.material.opacity = 0.55 * (1 - t);
    } else if (e.kind === 'aaFly') {
      e.mesh.position.x += (e.vx || 0) * dt;
      e.mesh.position.z += (e.vz || 0) * dt;
      if (e.mesh.material) e.mesh.material.opacity = 0.95 * (1 - t);
    }
  }
}

// Shield-aura: persistent sphere runt heroes som har shield aktiv
function ensureShieldAura(side) {
  if (!side.mesh) return;
  let aura = side.mesh.userData.shieldAura;
  if (!aura) {
    aura = new THREE.Mesh(
      new THREE.SphereGeometry(0.65, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x66c8ff, transparent: true, opacity: 0.18 })
    );
    aura.position.y = 0.85;
    side.mesh.add(aura);
    side.mesh.userData.shieldAura = aura;
  }
  return aura;
}

function updateShieldAuras(now) {
  for (const idx of [1, 2]) {
    const s = sides[idx];
    if (!s || !s.mesh) continue;
    const has = (s.shield || 0) > 0 && !s.hero.dead;
    if (has) {
      const aura = ensureShieldAura(s);
      if (aura) {
        aura.visible = true;
        const pulse = 0.18 + 0.10 * Math.sin(now * 6);
        if (aura.material) aura.material.opacity = pulse;
      }
    } else if (s.mesh.userData.shieldAura) {
      s.mesh.userData.shieldAura.visible = false;
    }
  }
}

// Track shield-deltas så vi kan spawna en burst första gången shield gains
function checkShieldGain() {
  const nowS = performance.now() / 1000;
  for (const idx of [1, 2, 3, 4]) {
    const s = sides[idx];
    if (!s) continue;
    const prev = s._shieldPrev || 0;
    const cur = (s.shield || 0) + (s.lingShieldHp || 0);
    if (cur > prev + 0.5) {
      if (s.hero && !s.hero.dead && s.mesh) {
        spawnShieldBurstFx(s.hero.x, s.hero.z, 0x66c8ff);
        // Ackumulera shield-gain (start-tid sätts vid första delta så
        // burst:s i samma frame summeras).
        s._shieldPopAccum = (s._shieldPopAccum || 0) + (cur - prev);
        if (!s._shieldPopStartT) s._shieldPopStartT = nowS;
      }
    }
    // Throttling-timer tickar alltid på reell tid (oberoende av FPS)
    if ((s._shieldPopAccum || 0) > 0 && s._shieldPopStartT && (nowS - s._shieldPopStartT) > 0.15) {
      if (s.mesh) spawnShieldText(s.mesh, s._shieldPopAccum);
      s._shieldPopAccum = 0;
      s._shieldPopStartT = 0;
    }
    s._shieldPrev = cur;
  }
}

// Track hp-gains så vi kan spawna heal-plus, OCH hp-drops för slash
function checkHealGain() {
  const nowS = performance.now() / 1000;
  for (const idx of [1, 2, 3, 4]) {
    const s = sides[idx];
    if (!s) continue;
    const prev = s._hpPrev !== undefined ? s._hpPrev : s.hero.hp;
    const cur = s.hero.hp;
    const delta = cur - prev;
    if (delta > 0 && !s.hero.dead) {
      if (delta > 1.0) spawnHealFx(s.hero.x, s.hero.z);
      s._healAccum = (s._healAccum || 0) + delta;
      if (!s._healAccumStartT) s._healAccumStartT = nowS;
    }
    // Reell-tid throttling (oberoende av FPS): burst > 5 spawnar snabbt,
    // passiv regen spawnar var ~1s.
    if ((s._healAccum || 0) > 0) {
      const elapsed = nowS - (s._healAccumStartT || nowS);
      const big = s._healAccum > 5;
      if ((big && elapsed > 0.15) || elapsed > 1.0) {
        spawnHeroHealText(s, s._healAccum);
        s._healAccum = 0;
        s._healAccumStartT = 0;
      }
    }
    // MP-fallback slash-spawn när HP sjunker
    if (cur < prev - 0.5 && !s.hero.dead && APP.mode !== 'solo') {
      spawnSlashFx(s.hero.x, s.hero.z, 0xff5544);
    }
    s._hpPrev = cur;
  }
}

// === Buff / Debuff status sprites ===
// Två sprites per hero: en buff-row ovanför HP-baren, en debuff-row till höger om hero.
// Båda är canvas-baserade billboards som uppdateras varje frame.

const STATUS_BUFF_W = 256, STATUS_BUFF_H = 36;
const STATUS_DEBUFF_W = 80, STATUS_DEBUFF_H = 200;

function makeStatusSprite(w, h, scaleX, scaleY) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(scaleX, scaleY, 1);
  sprite.userData.canvas = canvas;
  sprite.userData.tex = tex;
  sprite.userData.lastHash = '';
  return sprite;
}

function ensureBuffDebuffSprites(side) {
  if (!side.mesh) return;
  if (!side.mesh.userData.buffSprite) {
    const buff = makeStatusSprite(STATUS_BUFF_W, STATUS_BUFF_H, 2.4, 0.34);
    buff.position.set(0, 2.55, 0);
    side.mesh.add(buff);
    side.mesh.userData.buffSprite = buff;
  }
  if (!side.mesh.userData.debuffSprite) {
    const debuff = makeStatusSprite(STATUS_DEBUFF_W, STATUS_DEBUFF_H, 0.5, 1.25);
    debuff.position.set(0.8, 1.3, 0);
    side.mesh.add(debuff);
    side.mesh.userData.debuffSprite = debuff;
  }
}

// Returnerar aktiva buffs/debuffs som array av { icon, color, t?, label? }
function collectBuffs(side) {
  const list = [];
  // Shield (Gandulf passive)
  if ((side.shield || 0) > 0) {
    list.push({ icon: '🛡', color: '#66c8ff', label: Math.round(side.shield) + '' });
  }
  // Skill-dmg stacks (Gandulf passive)
  if ((side.gandulfBuffStacks || 0) > 0 && (side.gandulfBuffRemaining || 0) > 0) {
    list.push({ icon: '✦', color: '#b58cff', t: side.gandulfBuffRemaining, label: 'x' + side.gandulfBuffStacks });
  }
  // Legolus aim-buff
  if ((side.legolusBuffRemaining || 0) > 0) {
    list.push({ icon: '🎯', color: '#ddff55', t: side.legolusBuffRemaining });
  }
  // Gimlu Titan's Taunt
  if ((side.titansTauntRemaining || 0) > 0) {
    list.push({ icon: '📢', color: '#ffaa55', t: side.titansTauntRemaining });
  }
  // Gimlu Iron Will
  if ((side.ironWillRemaining || 0) > 0) {
    list.push({ icon: '🔥', color: '#ff7733', t: side.ironWillRemaining });
  }
  // Duel speed-buff
  if ((side.duelSpeedBuffRemaining || 0) > 0) {
    list.push({ icon: '💨', color: '#ffd34a', t: side.duelSpeedBuffRemaining });
  }
  // Fountain aura
  if (side.heroFountainAura) {
    list.push({ icon: '💧', color: '#66ddff' });
  }
  // Aktiva items (boots/glove)
  if (side.inventory) {
    for (const it of side.inventory) {
      const ar = it.activeRemaining || 0;
      if (ar > 0) {
        const def = (typeof ITEM_TYPES !== 'undefined') ? ITEM_TYPES[it.itemId] : null;
        const icon = (def && def.icon) ? def.icon : '⭐';
        list.push({ icon, color: '#ffd34a', t: ar });
      }
    }
  }
  return list;
}

function collectDebuffs(side) {
  const list = [];
  if ((side.hero.frozenTime || 0) > 0) {
    list.push({ icon: '❄', color: '#88ddff', t: side.hero.frozenTime });
  }
  if ((side.hero.dotRemaining || 0) > 0) {
    list.push({ icon: '🔥', color: '#ff6644', t: side.hero.dotRemaining });
  }
  if ((side.hero.poisonRemaining || 0) > 0) {
    list.push({ icon: '🌿', color: '#88dd66', t: side.hero.poisonRemaining });
  }
  if ((side.hero.tauntedTime || 0) > 0) {
    list.push({ icon: '😡', color: '#ff8844', t: side.hero.tauntedTime });
  }
  return list;
}

function drawBuffSprite(side) {
  const sprite = side.mesh.userData.buffSprite;
  if (!sprite) return;
  const buffs = collectBuffs(side);
  const hash = buffs.map(b => `${b.icon}|${b.color}|${(b.t || 0).toFixed(1)}|${b.label || ''}`).join('#');
  if (hash === sprite.userData.lastHash) {
    sprite.visible = buffs.length > 0;
    return;
  }
  sprite.userData.lastHash = hash;
  const canvas = sprite.userData.canvas;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  sprite.visible = buffs.length > 0;
  if (!buffs.length) { sprite.userData.tex.needsUpdate = true; return; }
  const iconSize = 30;
  const gap = 4;
  const totalW = buffs.length * (iconSize + gap) - gap;
  const startX = Math.max(0, (canvas.width - totalW) / 2);
  ctx.font = '20px system-ui,sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < buffs.length; i++) {
    const b = buffs[i];
    const x = startX + i * (iconSize + gap);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x, 2, iconSize, iconSize);
    ctx.strokeStyle = b.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, 3, iconSize - 2, iconSize - 2);
    ctx.fillStyle = '#fff';
    ctx.font = '22px system-ui,sans-serif';
    ctx.fillText(b.icon, x + iconSize / 2, 16);
    // Timer-text under
    if (b.t) {
      ctx.fillStyle = b.color;
      ctx.font = '700 11px ui-monospace,monospace';
      ctx.fillText(b.t.toFixed(1) + 's', x + iconSize / 2, canvas.height - 6);
    } else if (b.label) {
      ctx.fillStyle = b.color;
      ctx.font = '700 11px ui-monospace,monospace';
      ctx.fillText(b.label, x + iconSize / 2, canvas.height - 6);
    }
  }
  sprite.userData.tex.needsUpdate = true;
}

function drawDebuffSprite(side) {
  const sprite = side.mesh.userData.debuffSprite;
  if (!sprite) return;
  const debuffs = collectDebuffs(side);
  const hash = debuffs.map(b => `${b.icon}|${(b.t || 0).toFixed(1)}`).join('#');
  if (hash === sprite.userData.lastHash) {
    sprite.visible = debuffs.length > 0;
    return;
  }
  sprite.userData.lastHash = hash;
  const canvas = sprite.userData.canvas;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  sprite.visible = debuffs.length > 0;
  if (!debuffs.length) { sprite.userData.tex.needsUpdate = true; return; }
  const iconSize = 36;
  const gap = 4;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < debuffs.length; i++) {
    const b = debuffs[i];
    const y = 4 + i * (iconSize + gap);
    if (y + iconSize > canvas.height) break;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(8, y, iconSize, iconSize);
    ctx.strokeStyle = b.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(9, y + 1, iconSize - 2, iconSize - 2);
    ctx.fillStyle = '#fff';
    ctx.font = '24px system-ui,sans-serif';
    ctx.fillText(b.icon, 8 + iconSize / 2, y + iconSize / 2);
    if (b.t) {
      ctx.fillStyle = b.color;
      ctx.font = '700 12px ui-monospace,monospace';
      ctx.fillText(b.t.toFixed(1) + 's', 8 + iconSize / 2, y + iconSize - 4);
    }
  }
  sprite.userData.tex.needsUpdate = true;
}

function updateBuffDebuffSprites() {
  for (const idx of [1, 2]) {
    const s = sides[idx];
    if (!s || !s.mesh || s.hero.dead) continue;
    ensureBuffDebuffSprites(s);
    drawBuffSprite(s);
    drawDebuffSprite(s);
  }
}

function animateSceneProps(dt, now) {
  // Arena-facklor: flickande ljus + flammande koner
  if (APP.gameMode === 'arena1v1') {
    for (let bi = 0; bi < arenaBraziers.length; bi++) {
      const br = arenaBraziers[bi];
      if (br.userData.flames) {
        for (let i = 0; i < br.userData.flames.length; i++) {
          const fl = br.userData.flames[i];
          const k = 0.85 + 0.25 * Math.sin(now * (6 + i * 1.6) + bi);
          fl.scale.set(1, k, 1);
          fl.position.x = (Math.sin(now * (5.5 + i) + i + bi) * 0.06);
          fl.position.z = (Math.cos(now * (4.4 + i) + i + bi) * 0.06);
        }
      }
      if (br.userData.light) {
        br.userData.light.intensity = 1.6 + 0.45 * Math.sin(now * 8 + bi * 1.7) + 0.15 * Math.sin(now * 17 + bi);
      }
    }
  }
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
  // Portaler: animera ring + disk + halo, walk-onto-detection
  const localSide = sides[APP.localSide];
  for (const idx of [1, 2]) {
    const p = portalMeshes[idx];
    if (!p) continue;
    if (p.ring) p.ring.rotation.z = now * 0.8;
    if (p.disk) {
      p.disk.material.opacity = 0.45 + 0.20 * Math.sin(now * 2.0 + idx);
      p.disk.rotation.z = -now * 1.2;
    }
    if (p.halo) {
      p.halo.rotation.z = now * 0.4;
      const s = 1 + 0.06 * Math.sin(now * 1.5 + idx);
      p.halo.scale.set(s, s, s);
    }
    if (p.light) p.light.intensity = 1.4 + 0.5 * Math.sin(now * 1.8 + idx);
    if (p.ground) p.ground.material.opacity = 0.35 + 0.18 * Math.sin(now * 1.3 + idx);
    // Walk-onto: bara lokal hero på sin egen portal aktiverar
    if (localSide && idx === APP.localSide && !localSide.hero.dead && localSide.level >= PORTAL_REQUIRED_LEVEL) {
      const pp = PORTAL_POS[idx];
      const d = Math.hypot(localSide.hero.x - pp.x, localSide.hero.z - pp.z);
      const nowMs = performance.now();
      if (d < PORTAL_ENTER_RADIUS && nowMs - portalTrigger.lastSentMs > 800) {
        portalTrigger.lastSentMs = nowMs;
        sendOrApplyEvent({ type: 'portal' });
      }
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

// Klient-side prediction: arena/boss MP-klient kör applyMovement lokalt för
// sin EGEN hjälte varje frame. Annars är input-rörelse fördröjd full RTT
// (input → host → broadcast → render = ~300 ms på Render's free-tier i USA).
// Med prediction känns rörelse instant; host's broadcast reconcile:ar bara
// om vår predicterade position avviker > 2.5 enheter (knockback, stun, etc.).
function tickLocalPrediction(dt) {
  const side = sides[APP.localSide];
  if (!side) return;
  const raw = readLocalJoystick();
  const dir = screenToWorld(raw.x, raw.z);
  applyMovement(side, dir.x, dir.z, dt);
}

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now() / 1000;
  resetFxPopupBudget();
  tickPerfMeter(dt);
  // Tick lokal optimistic ult-lockout för classic MP-klient (line wars).
  // I solo + arena/boss host körs simulateAll som tickar via buff-loopen
  // — guard:a här så det inte blir dubbel tick (2.5s istället för 5s lockout).
  if (APP.mode !== 'solo' && !(isArenaMp() && APP.mode === 'host')) {
    const _localSide = sides[APP.localSide];
    if (_localSide && (_localSide._ultLockoutTime || 0) > 0) {
      _localSide._ultLockoutTime = Math.max(0, _localSide._ultLockoutTime - dt);
    }
  }

  // Boss Wars MP-klient: ingen lokal sim, bara input + render av host's state.
  // MEN: klient kör applyMovement lokalt för EGEN hjälte (prediction) så
  // input-rörelse känns omedelbar trots ~150 ms RTT till host.
  const isBossMpClient = bossMpState.matchActive && bossMpState.role === 'client';
  const isBossMpHost = bossMpState.matchActive && bossMpState.role === 'host';
  if (isBossMpClient) {
    tickLocalPrediction(dt);
    if (now - bossMpState.lastInputSent > INPUT_SEND_INTERVAL) {
      bossMpState.lastInputSent = now;
      sendBossWarsInput();
    }
    smoothEntityMeshes(dt);
    // Klient kör inte simulateAll → phase-2-aura behöver tickas separat
    // så animation/pulsering syns på klient (host tickar via updateMonsters).
    if (sides[1] && sides[1].monsters) {
      const _boss = sides[1].monsters.find(m => m.isBossWarsBoss);
      if (_boss && _boss.mesh && _boss.mesh.userData.phase2Aura) tickBossPhase2Aura(_boss.mesh, dt);
    }
  } else if (APP.mode === 'solo' || (isArenaMp() && APP.mode === 'host')) {
    // Solo + arena-host kör simulationen lokalt
    if (!matchState.gameOver) simulateAll(dt);
  } else if (isMpMode()) {
    // Klassisk MP (server-auth): bara input + render från server's state.
    // Arena-client: input + prediction + render från host's state.
    // Classic MP behöver också local-prediction för own hero — annars rör sig
    // hero bara via 20Hz state-snap = synlig "hackig" jitter när man springer.
    // Reconciliation sker i applySideData (stor diff = snap till server pos).
    maybeSendClientInput(now);
    tickLocalPrediction(dt);
    smoothEntityMeshes(dt);
  }
  // Arena MP host broadcastar state till klienten
  if (isArenaMp() && APP.mode === 'host' && wsOpen()) {
    if (now - APP.lastStateSent > ARENA_STATE_SEND_INTERVAL) {
      APP.lastStateSent = now;
      broadcastArenaState();
    }
  }
  // Boss Wars MP host broadcastar state till klienterna ~20 Hz
  // (klient-interpolation lerpar 60 fps, så 20 Hz räcker visuellt och sparar
  // CPU+nätverk på host's enhet vilket är vanlig flaskhals)
  if (isBossMpHost && wsOpen()) {
    if (now - bossMpState.lastStateSent > (1 / 20)) {
      bossMpState.lastStateSent = now;
      broadcastBossWarsState();
    }
  }
  // Arena state-machine (host kör; client följer a-state)
  if (APP.gameMode === 'arena1v1') {
    if (APP.mode === 'solo' || APP.mode === 'host') tickArena(dt);
    // Klient: tickArena körs INTE (host-auth), men shrink-cirkelns visual måste
    // uppdateras lokalt så klienten ser cirkeln. arenaState.shrinkRadius synkas
    // via a-state.
    else if (APP.mode === 'client' && arenaState.phase === 'fight') {
      updateShrinkCircleVisual(dt);
    }
  }

  tickMixers(dt);
  animateAllCharacters(dt);
  animateSceneProps(dt, now);
  tickAllHpBars();
  tickDuelOrbVisual(dt);
  tickDuelBigOrbVisual(dt);
  tickCombatFx(dt);
  tickAragurnVisuals(dt);
  updateShieldAuras(now);
  checkShieldGain();
  checkHealGain();
  checkAllCcStates();
  updateBuffDebuffSprites();

  // Throttle text-tunga HUD-uppdateringar till ~10 Hz. innerHTML-skrivningar
  // är dyra (force reflow). 6× mindre CPU per frame utan synlig skillnad.
  // updateBossHpBar körs DÄRFÖR direkt i updateHud — kallas också separat varje
  // frame nedan för smidig HP-animation.
  if (!_lastHudMs || now * 1000 - _lastHudMs > 100) {
    _lastHudMs = now * 1000;
    updateHud();
    updateDuelHud();
    updateIncomeDisplay();
  } else {
    // Mellan throttle-ticks: bara den snabba boss-HP-baren behöver fortsätta
    updateBossHpBar();
  }
  checkWaveBanner();
  checkIncomeTickNotifications();
  updateSkillButtonStyles();
  updateAimIndicators();
  updateTargetIndicator();
  updateShop();
  updateInventoryDisplay();
  updateCamera(dt);
  // Shadow Volley: toggle hero-mesh-visibility för invis-Legolus. Måste ske
  // EFTER applyHeroSnap (som sätter visible = !dead) och FÖRE render.
  for (const side of activeSides()) updateLegolusInvisVisibility(side);

  if (bloomComposer) bloomComposer.render();
  else renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// Toggle visibility för Legolus under Shadow Volley-invis. För casteren själv:
// behåll synlig (HUD-indikator visar invis-status). För motståndare/observatörer:
// dölj mesh helt. Anropas en gång per frame innan render.
function updateLegolusInvisVisibility(side) {
  if (!side || !side.mesh) return;
  if ((side.heroId || 'magiker') !== 'legolas') {
    // Återställ om hero bytte från Legolas medan stale-flagga sattes
    if (side.mesh._invisHidden) {
      side.mesh.visible = !side.hero.dead;
      side.mesh._invisHidden = false;
    }
    return;
  }
  const invis = (side.legolusInvisRemaining || 0) > 0;
  const isMe = (side.idx === APP.localSide);
  if (invis && !isMe) {
    side.mesh.visible = false;
    side.mesh._invisHidden = true;
  } else if (side.mesh._invisHidden) {
    side.mesh.visible = !side.hero.dead;
    side.mesh._invisHidden = false;
  }
}

requestAnimationFrame(tick);
window.__mainJsLoaded = true;
console.log('[main] module loaded fully');

// Dev-trigger: ?test=arena → auto-start solo arena (för screenshot/QA)
if (new URLSearchParams(location.search).get('test') === 'arena') {
  // Vänta tills assets är klara
  const tryStart = () => {
    if (!assetsReady) { setTimeout(tryStart, 300); return; }
    APP.gameMode = 'arena1v1';
    // Hoppa över hero-pick: sätt hero direkt och kör enterPlayPhase som solo
    heroPickState.selected = 'magiker';
    setupMatch('solo');
    enterPlayPhase();
    // Hoppa direkt till fight-fas så vi ser arena-scenen utan prep-overlay
    arenaState.phase = 'fight';
    arenaState.fightTimer = 0;
  arenaState.shrinkRadius = 0;
  arenaState.shrinkDamageAccum = 0;
    hideArenaPrep();
  };
  tryStart();
}
