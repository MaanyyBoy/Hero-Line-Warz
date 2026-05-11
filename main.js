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

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ============================================================
// STATIC SCENE (mark, väggar, lanes, baser, torn, ljus)
// ============================================================

const towerMeshes = {};

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

const TEXTURES = {
  groundGrass: () => makeNoiseTexture([42, 60, 32], 0.2, { repeatX: 14, repeatY: 7, streaks: true }),
  laneGrassMine: () => makeNoiseTexture([95, 120, 55], 0.18, { repeatX: 10, repeatY: 1.6, streaks: true }),
  laneGrassOpp: () => makeNoiseTexture([70, 90, 105], 0.18, { repeatX: 10, repeatY: 1.6, streaks: true }),
  baseFloor1: () => makeNoiseTexture([130, 120, 100], 0.12, { repeatX: 5, repeatY: 4, speckColor: [180, 165, 140] }),
  baseFloor2: () => makeNoiseTexture([110, 115, 130], 0.12, { repeatX: 5, repeatY: 4, speckColor: [150, 160, 180] }),
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

  // Bas-golv (övre = sida 1, nedre = sida 2)
  const baseFloor1 = new THREE.Mesh(
    new THREE.PlaneGeometry(18, 14),
    new THREE.MeshStandardMaterial({ map: TEXTURES.baseFloor1(), color: 0xffffff, roughness: 0.9 })
  );
  baseFloor1.rotation.x = -Math.PI / 2; baseFloor1.position.set(19, 0.02, 7.5);
  baseFloor1.receiveShadow = true;
  scene.add(baseFloor1);
  const baseFloor2 = new THREE.Mesh(
    new THREE.PlaneGeometry(18, 14),
    new THREE.MeshStandardMaterial({ map: TEXTURES.baseFloor2(), color: 0xffffff, roughness: 0.9 })
  );
  baseFloor2.rotation.x = -Math.PI / 2; baseFloor2.position.set(19, 0.02, -7.5);
  baseFloor2.receiveShadow = true;
  scene.add(baseFloor2);

  function makeLane(cx, cz, length, width, tex) {
    const lane = new THREE.Mesh(
      new THREE.PlaneGeometry(length, width),
      new THREE.MeshStandardMaterial({ map: tex, color: 0xffffff, roughness: 1.0 })
    );
    lane.rotation.x = -Math.PI / 2; lane.position.set(cx, 0.02, cz);
    lane.receiveShadow = true;
    scene.add(lane);
  }
  const laneMineTex = TEXTURES.laneGrassMine();
  const laneOppTex = TEXTURES.laneGrassOpp();
  makeLane(-8.5, 12, 39, 6, laneMineTex);     // Sida 1 lane 1
  makeLane(-8.5, 4,  39, 6, laneMineTex);     // Sida 1 lane 2
  makeLane(-8.5, -4, 39, 6, laneOppTex);      // Sida 2 lane 1
  makeLane(-8.5, -12, 39, 6, laneOppTex);     // Sida 2 lane 2

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

  // Torn — flerlager: sten-bas → mur → battlements → flaggstång + flagga
  const towerStoneTex = TEXTURES.stoneTower();
  function makeTower(x, z, flagColor) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);

    const stoneMat = new THREE.MeshStandardMaterial({ map: towerStoneTex, color: 0xffffff, roughness: 0.7 });
    const stoneDark = new THREE.MeshStandardMaterial({ map: towerStoneTex, color: 0xaaaaaa, roughness: 0.8 });

    // Bred bas (sokkel)
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 2.1, 0.6, 20), stoneDark);
    base.position.y = 0.3; base.castShadow = true; base.receiveShadow = true;
    grp.add(base);

    // Mur (huvudkropp)
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.75, 3.2, 20), stoneMat);
    wall.position.y = 2.2; wall.castShadow = true; wall.receiveShadow = true;
    grp.add(wall);

    // Skiva precis under battlements
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.55, 0.25, 20), stoneDark);
    cap.position.y = 3.95; cap.castShadow = true; cap.receiveShadow = true;
    grp.add(cap);

    // Battlements — 12 små klossar runt kanten
    const cren = 12;
    for (let i = 0; i < cren; i++) {
      const ang = (i / cren) * Math.PI * 2;
      const r = 1.55;
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.55, 0.35), stoneMat);
      b.position.set(Math.cos(ang) * r, 4.35, Math.sin(ang) * r);
      b.rotation.y = -ang;
      b.castShadow = true; b.receiveShadow = true;
      grp.add(b);
    }

    // Innertopp (något insatt)
    const innerTop = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.2, 20), stoneDark);
    innerTop.position.y = 4.25; innerTop.receiveShadow = true;
    grp.add(innerTop);

    // Flaggstång
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 2.2, 8),
      new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 0.9 })
    );
    pole.position.y = 5.45; pole.castShadow = true;
    grp.add(pole);

    // Flagga (rektangel) — sidans färg
    const flagMat = new THREE.MeshStandardMaterial({ color: flagColor, roughness: 0.7, side: THREE.DoubleSide });
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.7), flagMat);
    flag.position.set(0.6, 6.0, 0);
    flag.castShadow = true;
    grp.add(flag);

    // Knopp på toppen av stång
    const finial = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 12, 8),
      new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.5, roughness: 0.4 })
    );
    finial.position.y = 6.6; finial.castShadow = true;
    grp.add(finial);

    scene.add(grp);
    return { group: grp };
  }
  towerMeshes[1] = makeTower(24, 8,  0x4477dd);   // sida 1 = blå flagga
  towerMeshes[2] = makeTower(24, -8, 0xdd4444);   // sida 2 = röd flagga

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
const PROJECTILE_SPEED = 18;
const PASSIVE_EVERY = 4;
const PASSIVE_AOE_RADIUS = 2.0;

const MONSTER_AGGRO_RANGE = 5.0;
const MONSTER_LEASH_RANGE = 7.5;
const TOWER_REACH = 2.3;
const MONSTER_MELEE_DAMAGE = 8;
const MONSTER_MELEE_INTERVAL = 1.0;
const GOLD_PER_KILL = 5;
const RESPAWN_TIME = 5.0;

const PLAYER_CREEP_HP = 25;
const PLAYER_CREEP_SPEED = 1.5;
const PLAYER_CREEP_COST = 10;
const CREEP_VS_CREEP_DAMAGE = 5;
const CREEP_VS_CREEP_RANGE = 1.5;
const CREEP_VS_CREEP_INTERVAL = 1.5;

const ELDKLOT_SPEED = 16;
const ELDKLOT_DAMAGE = 15;
const ELDKLOT_RANGE = 14;
const ELDKLOT_RADIUS = 0.6;
const NOVA_RADIUS = 3.5;
const NOVA_DAMAGE = 10;
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
  return inLane(x, z, 12) || inLane(x, z, 4) || inLane(x, z, -4) || inLane(x, z, -12);
}

// ============================================================
// MESH-FABRIKER (composite groups, origin vid fötter, forward = +z)
// ============================================================

function setShadow(obj, cast = true, recv = false) {
  obj.traverse(o => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = recv; }});
}

function makeHeroMesh(idx) {
  const cfg = SIDE_CFG[idx];
  const grp = new THREE.Group();

  const robeColor = idx === 1 ? 0x2a2456 : 0x3a1f3a;       // mörk lila/blå robe
  const trimColor = cfg.heroColor;                         // accentkant från side
  const skinColor = 0xe6c7a5;

  // Robe (kropp)
  const robe = new THREE.Mesh(
    new THREE.CylinderGeometry(0.30, 0.58, 1.25, 14),
    new THREE.MeshStandardMaterial({ color: robeColor, roughness: 0.8 })
  );
  robe.position.y = 0.63;
  grp.add(robe);

  // Trim på hem (ljusare ring)
  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(0.56, 0.07, 8, 18),
    new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.6, emissive: trimColor, emissiveIntensity: 0.15 })
  );
  trim.rotation.x = Math.PI / 2;
  trim.position.y = 0.05;
  grp.add(trim);

  // Bälte
  const belt = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.42, 0.1, 14),
    new THREE.MeshStandardMaterial({ color: 0x2a1c10, roughness: 0.7 })
  );
  belt.position.y = 0.95;
  grp.add(belt);

  // Krage (kappans överdel)
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.30, 0.18, 12),
    new THREE.MeshStandardMaterial({ color: robeColor, roughness: 0.75 })
  );
  collar.position.y = 1.34;
  grp.add(collar);

  // Huvud
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 16, 12),
    new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.55 })
  );
  head.position.y = 1.55;
  grp.add(head);

  // Skägg (för stämningens skull)
  const beard = new THREE.Mesh(
    new THREE.ConeGeometry(0.14, 0.22, 10),
    new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.9 })
  );
  beard.position.set(0, 1.43, 0.13);
  beard.rotation.x = Math.PI;
  grp.add(beard);

  // Trollkarlshatt
  const hatBrim = new THREE.Mesh(
    new THREE.TorusGeometry(0.27, 0.05, 8, 16),
    new THREE.MeshStandardMaterial({ color: robeColor, roughness: 0.8 })
  );
  hatBrim.rotation.x = Math.PI / 2;
  hatBrim.position.y = 1.72;
  grp.add(hatBrim);
  const hatCone = new THREE.Mesh(
    new THREE.ConeGeometry(0.22, 0.55, 12),
    new THREE.MeshStandardMaterial({ color: robeColor, roughness: 0.8 })
  );
  hatCone.position.y = 2.02;
  hatCone.rotation.x = -0.12;
  grp.add(hatCone);
  // Stjärna på hatten
  const hatStar = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.06),
    new THREE.MeshStandardMaterial({ color: trimColor, emissive: trimColor, emissiveIntensity: 0.7, roughness: 0.3 })
  );
  hatStar.position.set(0, 1.95, 0.20);
  grp.add(hatStar);

  // Stav (lutad något åt sidan)
  const staff = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.045, 1.7, 8),
    new THREE.MeshStandardMaterial({ color: 0x2c1d10, roughness: 0.85 })
  );
  staff.position.set(0.38, 0.95, 0.08);
  staff.rotation.z = -0.06;
  grp.add(staff);

  // Stavens kristall (glödande, sidans accent)
  const orb = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.13, 0),
    new THREE.MeshStandardMaterial({
      color: trimColor, emissive: trimColor, emissiveIntensity: 1.2,
      roughness: 0.2, metalness: 0.0,
    })
  );
  orb.position.set(0.38, 1.85, 0.08);
  grp.add(orb);

  setShadow(grp, true, false);
  return grp;
}

function makeMonsterMesh() {
  const grp = new THREE.Group();
  const skinMat = new THREE.MeshStandardMaterial({ color: 0x3d2b1a, roughness: 0.95 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a1c10, roughness: 0.95 });

  // Ben
  const legGeo = new THREE.BoxGeometry(0.18, 0.42, 0.18);
  const legL = new THREE.Mesh(legGeo, darkMat); legL.position.set(-0.16, 0.21, 0); grp.add(legL);
  const legR = new THREE.Mesh(legGeo, darkMat); legR.position.set(0.16, 0.21, 0); grp.add(legR);

  // Torso
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.55, 0.42), skinMat);
  torso.position.y = 0.72;
  grp.add(torso);

  // Armar (lite kortare än ben)
  const armGeo = new THREE.BoxGeometry(0.16, 0.45, 0.16);
  const armL = new THREE.Mesh(armGeo, skinMat); armL.position.set(-0.39, 0.75, 0); armL.rotation.z = 0.15; grp.add(armL);
  const armR = new THREE.Mesh(armGeo, skinMat); armR.position.set(0.39, 0.75, 0); armR.rotation.z = -0.15; grp.add(armR);

  // Huvud
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), skinMat);
  head.position.y = 1.18;
  head.scale.set(1, 0.95, 1.05);
  grp.add(head);

  // Glödande ögon
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xff5522, emissive: 0xff3311, emissiveIntensity: 1.3 });
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), eyeMat);
  eyeL.position.set(-0.07, 1.20, 0.20); grp.add(eyeL);
  const eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), eyeMat);
  eyeR.position.set(0.07, 1.20, 0.20); grp.add(eyeR);

  // Små horn
  const hornMat = new THREE.MeshStandardMaterial({ color: 0x1c130a, roughness: 0.8 });
  const hornL = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 8), hornMat);
  hornL.position.set(-0.13, 1.40, 0); hornL.rotation.z = 0.25; grp.add(hornL);
  const hornR = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 8), hornMat);
  hornR.position.set(0.13, 1.40, 0); hornR.rotation.z = -0.25; grp.add(hornR);

  setShadow(grp, true, false);
  return grp;
}

function makePlayerCreepMesh(ownerIdx) {
  const cfg = SIDE_CFG[ownerIdx];
  const grp = new THREE.Group();
  const armorMat = new THREE.MeshStandardMaterial({
    color: cfg.gruntColor, roughness: 0.55, metalness: 0.25,
    emissive: cfg.gruntEmissive, emissiveIntensity: 0.25,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x251a12, roughness: 0.9 });

  // Ben (mörka)
  const legGeo = new THREE.BoxGeometry(0.14, 0.36, 0.14);
  const legL = new THREE.Mesh(legGeo, darkMat); legL.position.set(-0.13, 0.18, 0); grp.add(legL);
  const legR = new THREE.Mesh(legGeo, darkMat); legR.position.set(0.13, 0.18, 0); grp.add(legR);

  // Torso (rustning)
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.45, 0.38), armorMat);
  torso.position.y = 0.62;
  grp.add(torso);

  // Skulderplåtar
  const shGeo = new THREE.SphereGeometry(0.16, 10, 8);
  const shL = new THREE.Mesh(shGeo, armorMat); shL.position.set(-0.29, 0.82, 0); shL.scale.set(1, 0.6, 1); grp.add(shL);
  const shR = new THREE.Mesh(shGeo, armorMat); shR.position.set(0.29, 0.82, 0); shR.scale.set(1, 0.6, 1); grp.add(shR);

  // Armar (mörka)
  const armGeo = new THREE.BoxGeometry(0.13, 0.4, 0.13);
  const armL = new THREE.Mesh(armGeo, darkMat); armL.position.set(-0.31, 0.62, 0); grp.add(armL);
  const armR = new THREE.Mesh(armGeo, darkMat); armR.position.set(0.31, 0.62, 0); grp.add(armR);

  // Huvud (hud)
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xe2c4a6, roughness: 0.7 })
  );
  head.position.y = 1.02;
  grp.add(head);

  // Hjälm (halv-sfär + plym)
  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.19, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    armorMat
  );
  helmet.position.y = 1.05;
  grp.add(helmet);
  const plume = new THREE.Mesh(
    new THREE.ConeGeometry(0.05, 0.18, 8),
    new THREE.MeshStandardMaterial({ color: cfg.gruntColor, emissive: cfg.gruntEmissive, emissiveIntensity: 0.4 })
  );
  plume.position.set(0, 1.32, -0.05);
  grp.add(plume);

  // Svärd (höger sida)
  const swordHilt = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.18, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x2a1810, roughness: 0.8 })
  );
  swordHilt.position.set(0.42, 0.7, 0.05); grp.add(swordHilt);
  const swordBlade = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.45, 0.015),
    new THREE.MeshStandardMaterial({ color: 0xc8d0d8, roughness: 0.3, metalness: 0.8 })
  );
  swordBlade.position.set(0.42, 1.02, 0.05); grp.add(swordBlade);

  setShadow(grp, true, false);
  return grp;
}

// ============================================================
// APP-STATE
// ============================================================

const APP = {
  mode: 'lobby',          // 'lobby' | 'solo' | 'host' | 'client'
  localSide: 1,           // 1 eller 2 — vilken sida den lokala spelaren styr
  twoSides: false,        // singleplayer = false, multiplayer = true
  peer: null,
  conn: null,
  // Klient-input som ska skickas
  pendingEvents: [],
  lastInputSent: 0,
  lastStateSent: 0,
  // Mottagen client-input (bara host använder)
  remoteInputs: null,
  // Senast mottagen state (bara client använder för render)
  lastStateRecv: null,
};

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
  scene.add(heroMesh);

  return {
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
    // Resurser
    gold: 0,
    items: { sword: 0, boots: 0, vit: 0 },
    // Skills
    skills: {
      q: { cd: 0, max: 4.0 },
      f: { cd: 0, max: 8.0 },
      e: { cd: 0, max: 10.0 },
    },
    // Torn
    tower: { hp: TOWER_MAX_HP, maxHp: TOWER_MAX_HP },
    // Mobile entities
    monsters: [],         // inkommande hot mot detta torn
    playerCreeps: [],     // egna grunts (befinner sig i opp's arena, marscherar mot opp's torn)
    projectiles: [],      // hjältens auto-attack
    fireballs: [],        // Q (Eldklot)
    novaEffects: [],      // F (Frostnova) visuell ring
    // Wave-system
    wave: {
      current: 0, toSpawn: 0, spawnTimer: 0,
      spawnInterval: 1.0, betweenTimer: 3.0, active: false,
    },
  };
}

function removeSide(side) {
  if (!side) return;
  scene.remove(side.mesh);
  for (const m of side.monsters) scene.remove(m.mesh);
  for (const c of side.playerCreeps) scene.remove(c.mesh);
  for (const p of side.projectiles) scene.remove(p.mesh);
  for (const f of side.fireballs) scene.remove(f.mesh);
  for (const n of side.novaEffects) scene.remove(n.mesh);
}

// ============================================================
// SPAWNING (host/solo)
// ============================================================

function hostSpawnMonster(side, lane) {
  const cfg = SIDE_CFG[side.idx];
  const z = cfg.laneZ[lane];
  const mesh = makeMonsterMesh();
  mesh.position.set(cfg.spawnX, 0, z);
  scene.add(mesh);
  side.monsters.push({
    id: nextEntityId++, lane, hp: 10, speed: 2.0, pathIndex: 0,
    atkCd: 0, slowTime: 0, slowMul: 1.0, chasing: false,
    mesh,
  });
}

function hostSpawnPlayerCreep(side, lane) {
  // side = ägaren. Grunt spawnas i OPP's lane (västra änden).
  const oppIdx = 3 - side.idx;
  const oppCfg = SIDE_CFG[oppIdx];
  const z = oppCfg.laneZ[lane]; // opp's egen lane = vår oppLaneZ
  const mesh = makePlayerCreepMesh(side.idx);
  mesh.position.set(oppCfg.spawnX, 0, z);
  scene.add(mesh);
  side.playerCreeps.push({
    id: nextEntityId++, lane, hp: PLAYER_CREEP_HP, speed: PLAYER_CREEP_SPEED,
    pathIndex: 0, atkCd: 0,
    mesh,
  });
}

// ============================================================
// SIDE-SIMULERING (host/solo)
// ============================================================

function updateWaves(side, dt) {
  if (!side.wave.active) {
    side.wave.betweenTimer -= dt;
    if (side.wave.betweenTimer <= 0) {
      side.wave.current++;
      side.wave.toSpawn = 4 + side.wave.current * 2;
      side.wave.spawnTimer = 0;
      side.wave.active = true;
    }
    return;
  }
  if (side.wave.toSpawn > 0) {
    side.wave.spawnTimer -= dt;
    if (side.wave.spawnTimer <= 0) {
      const lane = (side.wave.toSpawn % 2 === 0) ? 1 : 2;
      hostSpawnMonster(side, lane);
      side.wave.toSpawn--;
      side.wave.spawnTimer = side.wave.spawnInterval;
    }
  } else if (side.monsters.length === 0) {
    side.wave.active = false;
    side.wave.betweenTimer = 5.0;
  }
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
    if (heroAlive && distHero < 1.2 && m.atkCd <= 0) {
      side.hero.hp = Math.max(0, side.hero.hp - MONSTER_MELEE_DAMAGE);
      m.atkCd = MONSTER_MELEE_INTERVAL;
      if (side.hero.hp <= 0) killHero(side);
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
            if (idx2 >= 0) { scene.remove(nearest.mesh); opp.playerCreeps.splice(idx2, 1); }
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
      if (distHero < 0.7) continue;
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
  // Side's playerCreeps lever i opp's arena, marscherar mot opp's torn.
  // De fightas mot opp's monsters (samma arena).
  const oppIdx = 3 - side.idx;
  const opp = sides[oppIdx];
  const oppCfg = SIDE_CFG[oppIdx];

  for (let i = side.playerCreeps.length - 1; i >= 0; i--) {
    const c = side.playerCreeps[i];

    const dxT = oppCfg.tower.x - c.mesh.position.x;
    const dzT = oppCfg.tower.z - c.mesh.position.z;
    if (dxT * dxT + dzT * dzT < TOWER_REACH * TOWER_REACH) {
      if (opp) opp.tower.hp = Math.max(0, opp.tower.hp - 1);
      scene.remove(c.mesh);
      side.playerCreeps.splice(i, 1);
      continue;
    }

    c.atkCd = Math.max(0, c.atkCd - dt);

    // Närmsta opp's monster
    if (opp) {
      let nearest = null, bestDist = CREEP_VS_CREEP_RANGE;
      for (const m of opp.monsters) {
        const dx = m.mesh.position.x - c.mesh.position.x;
        const dz = m.mesh.position.z - c.mesh.position.z;
        const d = Math.hypot(dx, dz);
        if (d < bestDist) { bestDist = d; nearest = m; }
      }
      if (nearest) {
        if (c.atkCd <= 0) {
          nearest.hp -= CREEP_VS_CREEP_DAMAGE;
          c.atkCd = CREEP_VS_CREEP_INTERVAL;
          if (nearest.hp <= 0) hostKillMonster(opp, opp.monsters.indexOf(nearest), side);
        }
        const dx = nearest.mesh.position.x - c.mesh.position.x;
        const dz = nearest.mesh.position.z - c.mesh.position.z;
        c.mesh.rotation.y = Math.atan2(dx, dz);
        continue;
      }
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

function hostKillMonster(side, idx, byPlayerSide) {
  const m = side.monsters[idx];
  if (!m) return;
  scene.remove(m.mesh);
  side.monsters.splice(idx, 1);
  // Guld går till spelaren vars hjälte/creep slog ihjäl monstret.
  // byPlayerSide kan vara side själv (hjälten i samma arena dödade sitt monster)
  // eller opp (opp's creep dödade monstret).
  if (byPlayerSide) byPlayerSide.gold += GOLD_PER_KILL;
  else side.gold += GOLD_PER_KILL;
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

function updateHeroAttack(side, dt) {
  side.attackCd = Math.max(0, side.attackCd - dt);
  if (side.hero.dead || side.attackCd > 0) return;
  const target = findClosestHostile(side, side.hero.x, side.hero.z, HERO_ATTACK_RANGE);
  if (!target) return;
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
  side.projectiles.push({
    mesh, target: target.entity, targetIsMonster: target.isMonster,
    ownerSide: target.ownerSide || side, damage: side.attackDmg, isAoE,
  });
  side.attackCd = HERO_ATTACK_INTERVAL;
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
      if (p.target.hp <= 0) {
        if (p.targetIsMonster) {
          const k = side.monsters.indexOf(p.target);
          if (k >= 0) hostKillMonster(side, k, side); // hjälten dödade — guld till sidan
        } else {
          const k = opp.playerCreeps.indexOf(p.target);
          if (k >= 0) { scene.remove(p.target.mesh); opp.playerCreeps.splice(k, 1); side.gold += GOLD_PER_KILL; }
        }
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
            if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(k, 1); side.gold += GOLD_PER_KILL; }
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

function hostCastEldklot(side, dirX, dirZ) {
  if (side.hero.dead || side.skills.q.cd > 0) return;
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.01) { dirX = side.hero.facingX; dirZ = side.hero.facingZ; }
  else { dirX /= len; dirZ /= len; }
  side.skills.q.cd = side.skills.q.max;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 14, 10),
    new THREE.MeshStandardMaterial({ color: 0xff5a18, emissive: 0xcc2200, emissiveIntensity: 1.0 })
  );
  mesh.position.set(side.hero.x, 1.0, side.hero.z);
  scene.add(mesh);
  side.fireballs.push({ mesh, dx: dirX, dz: dirZ, hit: new Set(), traveled: 0 });
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
        m.hp -= ELDKLOT_DAMAGE;
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
        c.hp -= ELDKLOT_DAMAGE;
        if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(j, 1); side.gold += GOLD_PER_KILL; }
      }
    }
    if (f.traveled > ELDKLOT_RANGE) {
      scene.remove(f.mesh); side.fireballs.splice(i, 1);
    }
  }
}

function hostCastFrostnova(side) {
  if (side.hero.dead || side.skills.f.cd > 0) return;
  side.skills.f.cd = side.skills.f.max;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.3, NOVA_RADIUS, 36),
    new THREE.MeshBasicMaterial({ color: 0x88ddff, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(side.hero.x, 0.08, side.hero.z);
  scene.add(ring);
  side.novaEffects.push({ mesh: ring, life: 0.6, maxLife: 0.6 });
  // Skada/slow på alla fientliga i radien (egna monsters + opp's creeps)
  for (let j = side.monsters.length - 1; j >= 0; j--) {
    const m = side.monsters[j];
    if (Math.hypot(m.mesh.position.x - side.hero.x, m.mesh.position.z - side.hero.z) < NOVA_RADIUS) {
      m.hp -= NOVA_DAMAGE;
      m.slowMul = NOVA_SLOW_MUL;
      m.slowTime = NOVA_SLOW_TIME;
      if (m.hp <= 0) hostKillMonster(side, j, side);
    }
  }
  const opp = sides[3 - side.idx];
  if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
    const c = opp.playerCreeps[j];
    if (Math.hypot(c.mesh.position.x - side.hero.x, c.mesh.position.z - side.hero.z) < NOVA_RADIUS) {
      c.hp -= NOVA_DAMAGE;
      if (c.hp <= 0) { scene.remove(c.mesh); opp.playerCreeps.splice(j, 1); side.gold += GOLD_PER_KILL; }
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
}

function hostCastBlink(side, dirX, dirZ) {
  if (side.hero.dead || side.skills.e.cd > 0) return;
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.01) { dirX = side.hero.facingX; dirZ = side.hero.facingZ; }
  else { dirX /= len; dirZ /= len; }
  let dist = BLINK_RANGE;
  let nx, nz;
  while (dist >= 0.5) {
    nx = side.hero.x + dirX * dist;
    nz = side.hero.z + dirZ * dist;
    if (isHeroWalkable(side.idx, nx, nz)) break;
    dist -= 0.5;
  }
  if (dist < 0.5) return;
  side.skills.e.cd = side.skills.e.max;
  side.hero.x = nx;
  side.hero.z = nz;
  side.mesh.position.x = nx;
  side.mesh.position.z = nz;
}

function updateSkillCooldowns(side, dt) {
  side.skills.q.cd = Math.max(0, side.skills.q.cd - dt);
  side.skills.f.cd = Math.max(0, side.skills.f.cd - dt);
  side.skills.e.cd = Math.max(0, side.skills.e.cd - dt);
}

// ============================================================
// HOST: APPLICERA INPUT FÖR EN SIDA
// ============================================================

const SHOP_ITEMS = {
  sword:       { cost: 50, apply: (s) => { s.attackDmg += 5; } },
  boots:       { cost: 40, apply: (s) => { s.moveSpeed += 1; } },
  vit:         { cost: 60, apply: (s) => { s.hero.maxHp += 50; s.hero.hp = s.hero.maxHp; } },
  'grunt-top': { cost: PLAYER_CREEP_COST, apply: (s) => hostSpawnPlayerCreep(s, 1) },
  'grunt-bot': { cost: PLAYER_CREEP_COST, apply: (s) => hostSpawnPlayerCreep(s, 2) },
};

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
  if (ev.type === 'skill') {
    if (ev.key === 'q') hostCastEldklot(side, ev.dx, ev.dz);
    else if (ev.key === 'f') hostCastFrostnova(side);
    else if (ev.key === 'e') hostCastBlink(side, ev.dx, ev.dz);
  } else if (ev.type === 'shop') {
    if (side.hero.dead) return;
    if (!inSideBase(side.idx, side.hero.x, side.hero.z)) return;
    const item = SHOP_ITEMS[ev.item];
    if (!item) return;
    if (side.gold < item.cost) return;
    side.gold -= item.cost;
    if (ev.item in side.items) side.items[ev.item]++;
    item.apply(side);
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
};

function clientReconcileEntities(sideIdx, key, list, makeMesh) {
  if (!clientMeshes[key].has(sideIdx)) clientMeshes[key].set(sideIdx, new Map());
  const map = clientMeshes[key].get(sideIdx);
  const seen = new Set();
  for (const e of list) {
    seen.add(e.id);
    let mesh = map.get(e.id);
    if (!mesh) {
      mesh = makeMesh(e);
      scene.add(mesh);
      map.set(e.id, mesh);
    }
    mesh.position.x = e.x;
    mesh.position.z = e.z;
    if (e.y !== undefined) mesh.position.y = e.y;
    if (e.ry !== undefined) mesh.rotation.y = e.ry;
    if (e.life !== undefined && mesh.material && mesh.material.opacity !== undefined) {
      mesh.material.opacity = 0.7 * Math.max(0, e.life);
    }
  }
  for (const [id, mesh] of map) {
    if (!seen.has(id)) {
      scene.remove(mesh);
      map.delete(id);
    }
  }
}

function applyRemoteState(state) {
  APP.lastStateRecv = state;
  for (const idx of [1, 2]) {
    const sData = state.s[idx];
    if (!sData) continue;
    const side = sides[idx];
    if (!side) continue;
    // Hjälte
    side.hero.x = sData.h.x;
    side.hero.z = sData.h.z;
    side.hero.hp = sData.h.hp;
    side.hero.maxHp = sData.h.mh;
    side.hero.facingX = sData.h.fx;
    side.hero.facingZ = sData.h.fz;
    side.hero.dead = !!sData.h.d;
    side.hero.respawnTimer = sData.h.rt;
    side.mesh.position.set(sData.h.x, 0, sData.h.z);
    side.mesh.rotation.y = Math.atan2(sData.h.fx, sData.h.fz);
    side.mesh.visible = !sData.h.d;
    // Resurser
    side.gold = sData.g;
    side.items = sData.i;
    side.moveSpeed = sData.ms;
    side.attackDmg = sData.ad;
    side.attackCounter = sData.ac;
    // Torn
    side.tower.hp = sData.tw.hp;
    side.tower.maxHp = sData.tw.mh;
    // Skills
    side.skills.q.cd = sData.sk.q;
    side.skills.f.cd = sData.sk.f;
    side.skills.e.cd = sData.sk.e;
    // Wave (för HUD)
    side.wave.current = sData.w.c;
    side.wave.active = !!sData.w.a;
    side.wave.betweenTimer = sData.w.bt;
    // Entiteter
    clientReconcileEntities(idx, 'monsters', sData.M, () => makeMonsterMesh());
    clientReconcileEntities(idx, 'playerCreeps', sData.C, () => makePlayerCreepMesh(idx));
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
    i: side.items,
    ms: side.moveSpeed,
    ad: side.attackDmg,
    ac: side.attackCounter,
    tw: { hp: side.tower.hp, mh: side.tower.maxHp },
    sk: { q: side.skills.q.cd, f: side.skills.f.cd, e: side.skills.e.cd },
    w: { c: side.wave.current, a: side.wave.active, bt: side.wave.betweenTimer },
    M: side.monsters.map(m => ({ id: m.id, x: m.mesh.position.x, z: m.mesh.position.z, ry: m.mesh.rotation.y })),
    C: side.playerCreeps.map(c => ({ id: c.id, x: c.mesh.position.x, z: c.mesh.position.z, ry: c.mesh.rotation.y })),
    F: side.fireballs.map((f, i) => ({ id: 'f' + side.idx + '_' + i, x: f.mesh.position.x, y: 1.0, z: f.mesh.position.z })),
    P: side.projectiles.map((p, i) => ({ id: 'p' + side.idx + '_' + i, x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z, aoe: p.isAoE })),
    N: side.novaEffects.map((n, i) => ({ id: 'n' + side.idx + '_' + i, x: n.mesh.position.x, z: n.mesh.position.z, life: n.life / n.maxLife })),
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

const cameraOffset = new THREE.Vector3(0, 9, 7);
const cameraTarget = new THREE.Vector3();

function updateCamera(dt) {
  if (!sides[APP.localSide]) return;
  const hero = sides[APP.localSide].hero;
  // Klient (sida 2) = kamera spegelvänd
  const sign = (APP.localSide === 2) ? -1 : 1;
  const desiredX = hero.x + cameraOffset.x * sign;
  const desiredY = cameraOffset.y;
  const desiredZ = hero.z + cameraOffset.z * sign;
  const lerpK = 1 - Math.pow(0.001, dt);
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
    : `HP: ${side.hero.hp}/${side.hero.maxHp}`;
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

function updateAimIndicators() {
  const side = sides[APP.localSide];
  if (!side) { aimLine.visible = false; aimDot.visible = false; return; }
  // aimState dx/dz är screen-relativa — konvertera till world för att rita indikator i scenen
  const w = screenToWorld(aimState.dx, aimState.dz);
  if (aimState.key === 'q' && aimState.active) {
    aimLine.visible = true;
    const cx = side.hero.x + w.x * (ELDKLOT_RANGE / 2);
    const cz = side.hero.z + w.z * (ELDKLOT_RANGE / 2);
    aimLine.position.set(cx, 0.06, cz);
    aimLine.rotation.y = -Math.atan2(w.z, w.x);
  } else {
    aimLine.visible = false;
  }
  if (aimState.key === 'e' && aimState.active) {
    aimDot.visible = true;
    let dist = BLINK_RANGE;
    let nx, nz;
    while (dist >= 0.5) {
      nx = side.hero.x + w.x * dist;
      nz = side.hero.z + w.z * dist;
      if (isHeroWalkable(side.idx, nx, nz)) break;
      dist -= 0.5;
    }
    if (dist >= 0.5) aimDot.position.set(nx, 0.06, nz);
    else aimDot.position.set(side.hero.x, 0.06, side.hero.z);
  } else {
    aimDot.visible = false;
  }
}

// ============================================================
// INPUTS (joystick, knappar, shop)
// ============================================================

const joyEl = document.getElementById('joy');
const joyKnobEl = document.getElementById('joy-knob');
const skillEls = {
  q: document.getElementById('skill-q'),
  f: document.getElementById('skill-f'),
  e: document.getElementById('skill-e'),
};

const joyState = {
  touchId: null, cx: 0, cy: 0, dx: 0, dz: 0, radius: 70,
};
const aimState = {
  touchId: null, key: null, active: false,
  btnCx: 0, btnCy: 0, dx: 0, dz: 0, dragMag: 0,
};
const AIM_THRESHOLD = 16;
const SKILL_AIMABLE = { q: true, e: true, f: false };

const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (APP.mode === 'lobby') return;
  const side = sides[APP.localSide];
  if (!side) return;
  if (e.code === 'KeyQ') castLocalSkill('q', side.hero.facingX, side.hero.facingZ);
  if (e.code === 'KeyE') castLocalSkill('e', side.hero.facingX, side.hero.facingZ);
  if (e.code === 'KeyR' || e.code === 'KeyF') castLocalSkill('f', 0, 0);
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
    if (SKILL_AIMABLE[key] && aimState.dragMag > AIM_THRESHOLD) {
      // Drag-riktning är screen-relativ — konvertera till world
      const w = screenToWorld(aimState.dx, aimState.dz);
      dx = w.x; dz = w.z;
    } else {
      // Facing-fallback är redan i world-koord
      dx = side.hero.facingX; dz = side.hero.facingZ;
    }
    castLocalSkill(key, dx, dz);
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

// ---- Shop ----

const shopEl = document.getElementById('shop');
const shopBtns = Array.from(document.querySelectorAll('.shop-btn'));

shopBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.item;
    sendOrApplyEvent({ type: 'shop', item: id });
  });
});

function updateShop() {
  const side = sides[APP.localSide];
  if (!side) { shopEl.classList.remove('visible'); return; }
  const inBase = !side.hero.dead && inSideBase(side.idx, side.hero.x, side.hero.z);
  shopEl.classList.toggle('visible', inBase);
  if (inBase) {
    for (const btn of shopBtns) {
      const id = btn.dataset.item;
      const cost = SHOP_ITEMS[id].cost;
      btn.disabled = side.gold < cost;
    }
  }
}

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

// castLocalSkill tar EMOT world-koord-riktning. Skickas vidare till host (eller
// appliceras direkt om vi är host/solo). Anropare ansvarar för konvertering.
function castLocalSkill(key, worldDx, worldDz) {
  const side = sides[APP.localSide];
  if (!side || side.skills[key].cd > 0 || side.hero.dead) return;
  sendOrApplyEvent({ type: 'skill', key, dx: worldDx, dz: worldDz });
}

function sendOrApplyEvent(ev) {
  if (APP.mode === 'host' || APP.mode === 'solo') {
    applyEvent(sides[APP.localSide], ev);
  } else if (APP.mode === 'client') {
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

function flushClientInput() {
  if (APP.mode !== 'client' || !APP.conn || !APP.conn.open) return;
  const raw = readLocalJoystick();
  const dir = screenToWorld(raw.x, raw.z);
  const evs = APP.pendingEvents;
  APP.pendingEvents = [];
  const msg = { t: 'in', j: { x: dir.x, z: dir.z }, ev: evs };
  try { APP.conn.send(msg); } catch (_) {}
  lastInputJoy = dir;
}

function maybeSendClientInput(now) {
  if (APP.mode !== 'client' || !APP.conn || !APP.conn.open) return;
  if (now - APP.lastInputSent < INPUT_SEND_INTERVAL && APP.pendingEvents.length === 0) return;
  APP.lastInputSent = now;
  flushClientInput();
}

function maybeSendHostState(now) {
  if (APP.mode !== 'host' || !APP.conn || !APP.conn.open) return;
  if (now - APP.lastStateSent < STATE_SEND_INTERVAL) return;
  APP.lastStateSent = now;
  try { APP.conn.send(serializeState()); } catch (_) {}
}

function handleNetworkMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'st' && APP.mode === 'client') {
    applyRemoteState(msg);
  } else if (msg.t === 'in' && APP.mode === 'host') {
    APP.remoteInputs = msg;
    // Apply events omedelbart
    if (msg.ev && msg.ev.length && sides[2]) {
      for (const ev of msg.ev) applyEvent(sides[2], ev);
    }
  } else if (msg.t === 'bye') {
    showLobbyError('Motståndaren lämnade matchen.');
    returnToLobby();
  }
}

function setupConnHandlers() {
  if (!APP.conn) return;
  APP.conn.on('data', handleNetworkMessage);
  APP.conn.on('close', () => {
    if (APP.mode === 'host' || APP.mode === 'client') {
      showLobbyError('Anslutningen tappades.');
      returnToLobby();
    }
  });
  APP.conn.on('error', (err) => {
    console.warn('conn error', err);
  });
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

function showLobbyPanel(which) {
  for (const el of [lobbyMainEl, lobbyHostingEl, lobbyJoiningEl]) el.classList.remove('visible');
  if (which === 'main') lobbyMainEl.classList.add('visible');
  else if (which === 'hosting') lobbyHostingEl.classList.add('visible');
  else if (which === 'joining') lobbyJoiningEl.classList.add('visible');
}

function showLobbyError(msg) {
  lobbyHostMsgEl.innerHTML = `<span class="err">${msg}</span>`;
  lobbyJoinMsgEl.innerHTML = `<span class="err">${msg}</span>`;
}

function genRoomCode() {
  // 4 versala bokstäver, ingen O/I för att slippa förväxling
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function peerIdFromCode(code) { return 'spel-' + code.toUpperCase(); }

function startPeer(id) {
  return new Promise((resolve, reject) => {
    const peer = new Peer(id);
    peer.on('open', (openId) => resolve(peer));
    peer.on('error', (err) => reject(err));
  });
}

async function hostGame() {
  if (typeof Peer === 'undefined') {
    showLobbyError('PeerJS-biblioteket kunde inte laddas. Kolla nätverk eller blockerare och ladda om sidan.');
    return;
  }
  showLobbyPanel('hosting');
  lobbyHostMsgEl.textContent = 'Skapar rum...';
  const code = genRoomCode();
  try {
    APP.peer = await startPeer(peerIdFromCode(code));
  } catch (err) {
    // Om peer-id redan finns globalt, försök ett annat
    if (err && err.type === 'unavailable-id') {
      return hostGame();
    }
    showLobbyError('Kunde inte skapa rum: ' + (err.type || err.message || 'okänt fel'));
    return;
  }
  lobbyCodeDisplayEl.textContent = code;
  lobbyHostMsgEl.textContent = 'Väntar på spelare...';
  APP.peer.on('connection', (conn) => {
    APP.conn = conn;
    conn.on('open', () => {
      setupConnHandlers();
      startMatch('host');
    });
  });
}

function cancelHosting() {
  if (APP.peer) { try { APP.peer.destroy(); } catch (_) {} APP.peer = null; }
  APP.conn = null;
  lobbyCodeDisplayEl.textContent = '----';
  lobbyHostMsgEl.textContent = '';
  showLobbyPanel('main');
}

async function joinGame() {
  if (typeof Peer === 'undefined') {
    lobbyJoinMsgEl.innerHTML = '<span class="err">PeerJS kunde inte laddas. Ladda om sidan.</span>';
    return;
  }
  const code = lobbyCodeInputEl.value.trim().toUpperCase();
  if (code.length !== 4) {
    lobbyJoinMsgEl.innerHTML = '<span class="err">Koden måste vara 4 tecken.</span>';
    return;
  }
  lobbyJoinMsgEl.textContent = 'Ansluter...';
  try {
    // Klient behöver också ett unikt id; PeerJS genererar slumpmässigt om vi inte anger
    APP.peer = await startPeer(undefined);
  } catch (err) {
    showLobbyError('PeerJS-fel: ' + (err.type || err.message || 'okänt'));
    return;
  }
  const conn = APP.peer.connect(peerIdFromCode(code), { reliable: true });
  APP.conn = conn;
  let opened = false;
  conn.on('open', () => {
    opened = true;
    setupConnHandlers();
    startMatch('client');
  });
  conn.on('error', (err) => {
    if (!opened) {
      showLobbyError('Kunde inte ansluta — kontrollera koden.');
    }
  });
  setTimeout(() => {
    if (!opened) {
      showLobbyError('Timeout — ingen anslutning.');
      try { APP.peer.destroy(); } catch (_) {}
      APP.peer = null;
      APP.conn = null;
    }
  }, 15000);
}

function startMatch(mode) {
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
    // Stoppa lokal simulering — state kommer från host
  }
  matchState.gameOver = false;
  matchState.gameWon = false;
  matchState.winner = 0;
  lobbyEl.classList.add('hidden');
  document.body.classList.add('in-game');
}

function returnToLobby() {
  if (APP.conn) { try { APP.conn.send({ t: 'bye' }); } catch (_) {} try { APP.conn.close(); } catch (_) {} APP.conn = null; }
  if (APP.peer) { try { APP.peer.destroy(); } catch (_) {} APP.peer = null; }
  if (sides[1]) { removeSide(sides[1]); sides[1] = null; }
  if (sides[2]) { removeSide(sides[2]); sides[2] = null; }
  for (const key of ['monsters', 'playerCreeps', 'fireballs', 'projectiles', 'novaEffects']) {
    for (const m of clientMeshes[key].values()) for (const mesh of m.values()) scene.remove(mesh);
    clientMeshes[key].clear();
  }
  endgameEl.classList.remove('visible');
  document.body.classList.remove('in-game');
  lobbyEl.classList.remove('hidden');
  showLobbyPanel('main');
  APP.mode = 'lobby';
}

document.getElementById('btn-host').addEventListener('click', hostGame);
document.getElementById('btn-host-cancel').addEventListener('click', cancelHosting);
document.getElementById('btn-join').addEventListener('click', () => {
  lobbyJoinMsgEl.textContent = '';
  showLobbyPanel('joining');
  setTimeout(() => lobbyCodeInputEl.focus(), 50);
});
document.getElementById('btn-join-back').addEventListener('click', () => {
  if (APP.peer) { try { APP.peer.destroy(); } catch (_) {} APP.peer = null; }
  APP.conn = null;
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
document.getElementById('btn-solo').addEventListener('click', () => startMatch('solo'));

// ============================================================
// HUVUDLOOP
// ============================================================

const clock = new THREE.Clock();

function simulateAll(dt) {
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
  // Applicera input för fjärr-sida (host bara)
  if (APP.mode === 'host' && sides[2] && APP.remoteInputs && APP.remoteInputs.j) {
    applyMovement(sides[2], APP.remoteInputs.j.x, APP.remoteInputs.j.z, dt);
  }
  // Per-sida simulering
  for (const side of [sides[1], sides[2]]) {
    if (!side) continue;
    updateSkillCooldowns(side, dt);
    updateWaves(side, dt);
    updateMonsters(side, dt);
    updatePlayerCreeps(side, dt);
    if (!side.hero.dead) updateHeroAttack(side, dt);
    updateProjectiles(side, dt);
    updateFireballs(side, dt);
    updateNovaEffects(side, dt);
  }
  checkMatchEnd();
}

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now() / 1000;

  if (APP.mode === 'solo' || APP.mode === 'host') {
    if (!matchState.gameOver) simulateAll(dt);
  } else if (APP.mode === 'client') {
    // Klient simulerar inte — applyRemoteState() sköter allt via data-events.
    // Skicka input.
    maybeSendClientInput(now);
  }

  if (APP.mode === 'host') maybeSendHostState(now);

  updateHud();
  updateSkillButtonStyles();
  updateAimIndicators();
  updateShop();
  updateCamera(dt);

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
