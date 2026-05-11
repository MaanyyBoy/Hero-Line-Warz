import * as THREE from 'three';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b2838);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);

// Karta: bas-zon på höger (x ~10..28), två horisontella lanes som sträcker sig västerut (x ~-30..10).
// Lane 1 (övre): z [1.5..15]. Lane 2 (nedre): z [-15..-1.5]. Bas-zon: z [-15..15].
// Mitten mellan lanes (z [-1.5..1.5], x < 10) är NO-GO — smal nog att man ser in i andra lanen.

// Mark / utanför-zon (mörkare)
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(140, 70),
  new THREE.MeshStandardMaterial({ color: 0x1f2f1f })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// Spelarens bas-golv — övre höger, mellan z=0.5 och z=14.55
const baseFloor = new THREE.Mesh(
  new THREE.PlaneGeometry(18, 14),
  new THREE.MeshStandardMaterial({ color: 0x6b6555 })
);
baseFloor.rotation.x = -Math.PI / 2;
baseFloor.position.set(19, 0.01, 7.5);
scene.add(baseFloor);

// Motståndarens bas-golv — nedre höger, mellan z=-14.55 och z=-0.5
const enemyBaseFloor = new THREE.Mesh(
  new THREE.PlaneGeometry(18, 14),
  new THREE.MeshStandardMaterial({ color: 0x554444 })
);
enemyBaseFloor.rotation.x = -Math.PI / 2;
enemyBaseFloor.position.set(19, 0.01, -7.5);
scene.add(enemyBaseFloor);

// Lanesnas golv (jord/sand) — 4 separata lanes, 2 dina (norra halvan), 2 motståndarens (södra)
function makeLane(cx, cz, length, width, color) {
  const lane = new THREE.Mesh(
    new THREE.PlaneGeometry(length, width),
    new THREE.MeshStandardMaterial({ color })
  );
  lane.rotation.x = -Math.PI / 2;
  lane.position.set(cx, 0.01, cz);
  scene.add(lane);
}
// Player lanes — ljusare ton
makeLane(-8.5, 12, 39, 6, 0x6a7a4a);   // Player lane 1: z [9, 15]
makeLane(-8.5, 4, 39, 6, 0x6a7a4a);    // Player lane 2: z [1, 7]
// Enemy lanes — mörkare/röd-ton
makeLane(-8.5, -4, 39, 6, 0x7a5a4a);   // Enemy lane 1: z [-7, -1]
makeLane(-8.5, -12, 39, 6, 0x7a5a4a);  // Enemy lane 2: z [-15, -9]

// Väggar
function makeWall(cx, cz, w, d, h = 1.2) {
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color: 0x4a443d })
  );
  wall.position.set(cx, h / 2, cz);
  scene.add(wall);
}
makeWall(-1, 15.15, 58, 0.3);    // Norra yttervägg
makeWall(-1, -15.15, 58, 0.3);   // Södra yttervägg
makeWall(28.15, 0, 0.3, 30.6);   // Östra bakväggen (bakom båda baser)
makeWall(-28.15, 0, 0.3, 30.6);  // Västra bakväggen (bakom båda spawn-portaler)
// MITTVÄGG — heltäckande, separerar dina/motståndarens arenor (kan ej korsas av hjälten)
makeWall(0, 0, 56.6, 0.3);
// Skiljeväggar mellan lanes inom samma arena (endast i lane-regionen)
makeWall(-8.5, 8, 39, 0.3);      // Mellan din lane 1 (z=12) och din lane 2 (z=4)
makeWall(-8.5, -8, 39, 0.3);     // Mellan hens lane 1 (z=-4) och hens lane 2 (z=-12)

// Spelarens torn (övre höger, mellan dina två lanes)
const tower = { x: 24, z: 8, hp: 50, maxHp: 50 };
const towerBase = new THREE.Mesh(
  new THREE.CylinderGeometry(1.6, 1.8, 1, 16),
  new THREE.MeshStandardMaterial({ color: 0xb0b0b8 })
);
towerBase.position.set(tower.x, 0.5, tower.z);
scene.add(towerBase);

const towerTop = new THREE.Mesh(
  new THREE.CylinderGeometry(0.9, 1.3, 3, 16),
  new THREE.MeshStandardMaterial({ color: 0x6688cc })
);
towerTop.position.set(tower.x, 2.5, tower.z);
scene.add(towerTop);

// Motståndarens torn (nedre höger, mellan hens två lanes) — röd-tonat
const enemyTower = { x: 24, z: -8, hp: 50, maxHp: 50 };
const enemyTowerBase = new THREE.Mesh(
  new THREE.CylinderGeometry(1.6, 1.8, 1, 16),
  new THREE.MeshStandardMaterial({ color: 0xb89090 })
);
enemyTowerBase.position.set(enemyTower.x, 0.5, enemyTower.z);
scene.add(enemyTowerBase);

const enemyTowerTop = new THREE.Mesh(
  new THREE.CylinderGeometry(0.9, 1.3, 3, 16),
  new THREE.MeshStandardMaterial({ color: 0xcc4444 })
);
enemyTowerTop.position.set(enemyTower.x, 2.5, enemyTower.z);
scene.add(enemyTowerTop);

// Spawn-markörer: motståndarens (väst, röda) + spelarens (öst, blå)
function makeSpawnMarker(x, z, color, emissive) {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 0.9, 0.2, 12),
    new THREE.MeshStandardMaterial({ color, emissive })
  );
  m.position.set(x, 0.12, z);
  scene.add(m);
}
// Inkommande hot mot dig — i din arena (övre), portal i västra änden av dina lanes
makeSpawnMarker(-27, 12, 0xcc4444, 0x441111);
makeSpawnMarker(-27, 4, 0xcc4444, 0x441111);
// Dina sända grunts — i hens arena (nedre), portal i västra änden av hens lanes
makeSpawnMarker(-27, -4, 0x4488cc, 0x112244);
makeSpawnMarker(-27, -12, 0x4488cc, 0x112244);

// Hjälten — startar i bas-zonen framför tornet
const hero = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.4, 0.8, 8, 16),
  new THREE.MeshStandardMaterial({ color: 0xff5533 })
);
hero.position.set(15, 0.8, 8);
scene.add(hero);

const HERO_SPAWN = { x: 15, z: 8 };
const player = {
  hp: 100,
  maxHp: 100,
  gold: 0,
  dead: false,
  respawnTimer: 0,
  items: { sword: 0, boots: 0, vit: 0 },
};

// Ljus
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(8, 15, 6);
scene.add(sun);

// Kamera (samma ML-tilt som tidigare)
const cameraOffset = new THREE.Vector3(0, 9, 7);
const cameraTarget = new THREE.Vector3();

const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'KeyQ') castEldklot();
  if (e.code === 'KeyE') castBlink();
  if (e.code === 'KeyR' || e.code === 'KeyF') castFrostnova(); // W används redan för rörelse — använd R/F
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

// Hjältens facing (uppdateras vid rörelse, behålls när stilla). Default: västerut mot lanes.
let heroFacingX = -1;
let heroFacingZ = 0;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Walkable check: union av bas-zon + lane 1 + lane 2, minus tornet. Marginal för hjältens radie.
const HERO_R = 0.45;
const TOWER_R = 1.6;
// Hjälpare: är (x, z) inom en lane (smal-radie 2.85 från centrum, längs x [-27.95, 11])
function inLane(x, z, centerZ) {
  return x >= -27.95 && x <= 11 && z >= centerZ - 2.85 && z <= centerZ + 2.85;
}
function inAnyLane(x, z) {
  return inLane(x, z, 12) || inLane(x, z, 4) || inLane(x, z, -4) || inLane(x, z, -12);
}

// Hjälpare: är (x, z) inom EN av DINA lanes (övre arenan)
function inMyLane(x, z) {
  return inLane(x, z, 12) || inLane(x, z, 4);
}

function isWalkable(x, z) { // HJÄLTE — endast din arena (övre)
  // Block runt ditt torn
  const dx = x - tower.x, dz = z - tower.z;
  if (dx * dx + dz * dz < (TOWER_R + HERO_R) * (TOWER_R + HERO_R)) return false;
  // Din bas
  if (x >= 10.6 && x <= 27.55 && z >= 0.5 && z <= 14.55) return true;
  // Dina lanes
  return inMyLane(x, z);
}

// ---- Monster + wave-system ----

const monsters = [];

// Båda sidors creeps marscherar VÄST → ÖST mot målet-tornet i sin egen arena.
// Inkommande hot (enemy creeps): går genom dina lanes (z=12, z=4) mot ditt torn (24, 8).
// Dina grunts (player creeps): går genom hens lanes (z=-4, z=-12) mot hens torn (24, -8).
const lanePaths = {
  enemy: {
    1: [{ x: 10, z: 12 }, { x: tower.x, z: tower.z }],
    2: [{ x: 10, z: 4 }, { x: tower.x, z: tower.z }],
  },
  player: {
    1: [{ x: 10, z: -4 }, { x: enemyTower.x, z: enemyTower.z }],
    2: [{ x: 10, z: -12 }, { x: enemyTower.x, z: enemyTower.z }],
  },
};

function spawnMonster(lane) {
  // Inkommande hot — spawnar i västra änden av DINA lanes (övre arenan)
  // lane 1 = din övre lane (z=12), lane 2 = din nedre lane (z=4)
  const start = lane === 1 ? { x: -27, z: 12 } : { x: -27, z: 4 };
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 1.2, 0.8),
    new THREE.MeshStandardMaterial({ color: 0x553322 })
  );
  mesh.position.set(start.x, 0.6, start.z);
  scene.add(mesh);
  monsters.push({ mesh, lane, hp: 10, speed: 2.0, pathIndex: 0 });
}

const MONSTER_AGGRO_RANGE = 5.0;
const MONSTER_LEASH_RANGE = 7.5;
const TOWER_REACH = 2.3;
const MONSTER_MELEE_DAMAGE = 8;
const MONSTER_MELEE_INTERVAL = 1.0;
const GOLD_PER_KILL = 5;
const RESPAWN_TIME = 5.0;

// Walkable för monster — samma yta som hjältens, men utan torn-exklusion
// (monster ska kunna trycka mot tornet för att skada det).
function isMonsterPos(x, z) {
  // Din bas (övre höger)
  if (x >= 10.6 && x <= 27.55 && z >= 0.5 && z <= 14.55) return true;
  // Hens bas (nedre höger)
  if (x >= 10.6 && x <= 27.55 && z >= -14.55 && z <= -0.5) return true;
  // Alla 4 lanes
  return inAnyLane(x, z);
}

function updateMonsters(dt) {
  for (let i = monsters.length - 1; i >= 0; i--) {
    const m = monsters[i];

    // Nått tornet?
    const dxT = tower.x - m.mesh.position.x;
    const dzT = tower.z - m.mesh.position.z;
    if (dxT * dxT + dzT * dzT < TOWER_REACH * TOWER_REACH) {
      tower.hp = Math.max(0, tower.hp - 1);
      scene.remove(m.mesh);
      monsters.splice(i, 1);
      continue;
    }

    // Aggro: börja jaga om hjälten är nära och hjälten lever. Leash om hjälten dör eller är långt borta.
    const dxh = hero.position.x - m.mesh.position.x;
    const dzh = hero.position.z - m.mesh.position.z;
    const distHero = Math.hypot(dxh, dzh);
    if (player.dead) m.chasing = false;
    else if (!m.chasing && distHero < MONSTER_AGGRO_RANGE) m.chasing = true;
    else if (m.chasing && distHero > MONSTER_LEASH_RANGE) m.chasing = false;

    // Monster-melee mot hjälten (vid kontakt)
    m.atkCd = Math.max(0, (m.atkCd || 0) - dt);
    if (!player.dead && distHero < 1.2 && m.atkCd <= 0) {
      player.hp = Math.max(0, player.hp - MONSTER_MELEE_DAMAGE);
      m.atkCd = MONSTER_MELEE_INTERVAL;
      if (player.hp <= 0) killHero();
    }

    // Om inte jagar hjälten: kolla efter player-creep att slåss mot
    if (!m.chasing) {
      let nearestPC = null, bestDistPC = CREEP_VS_CREEP_RANGE;
      for (const pc of playerCreeps) {
        const dx = pc.mesh.position.x - m.mesh.position.x;
        const dz = pc.mesh.position.z - m.mesh.position.z;
        const d = Math.hypot(dx, dz);
        if (d < bestDistPC) { bestDistPC = d; nearestPC = pc; }
      }
      if (nearestPC) {
        if (m.atkCd <= 0) {
          nearestPC.hp -= CREEP_VS_CREEP_DAMAGE;
          m.atkCd = CREEP_VS_CREEP_INTERVAL;
          if (nearestPC.hp <= 0) {
            const idx = playerCreeps.indexOf(nearestPC);
            if (idx >= 0) removePlayerCreep(idx);
          }
        }
        const dx = nearestPC.mesh.position.x - m.mesh.position.x;
        const dz = nearestPC.mesh.position.z - m.mesh.position.z;
        m.mesh.rotation.y = Math.atan2(dx, dz);
        continue;
      }
    }

    // Riktning: mot hjälten om jagar, annars mot vägpunkt mot tornet.
    let dirX, dirZ;
    if (m.chasing) {
      if (distHero < 0.7) continue;
      dirX = dxh / distHero;
      dirZ = dzh / distHero;
    } else {
      const path = lanePaths.enemy[m.lane];
      const idx = Math.min(m.pathIndex, path.length - 1);
      const target = path[idx];
      const dx = target.x - m.mesh.position.x;
      const dz = target.z - m.mesh.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.3 && m.pathIndex < path.length - 1) { m.pathIndex++; continue; }
      dirX = dx / dist;
      dirZ = dz / dist;
    }

    // Slow-tick
    if (m.slowTime && m.slowTime > 0) {
      m.slowTime -= dt;
      if (m.slowTime <= 0) m.slowMul = 1.0;
    }

    // Rörelse med vägg-collision (glid längs vägg på en axel)
    const effSpeed = m.speed * (m.slowMul || 1.0);
    const step = effSpeed * dt;
    const nx = m.mesh.position.x + dirX * step;
    const nz = m.mesh.position.z + dirZ * step;
    if (isMonsterPos(nx, nz)) {
      m.mesh.position.x = nx;
      m.mesh.position.z = nz;
    } else if (isMonsterPos(nx, m.mesh.position.z)) {
      m.mesh.position.x = nx;
    } else if (isMonsterPos(m.mesh.position.x, nz)) {
      m.mesh.position.z = nz;
    }
    m.mesh.rotation.y = Math.atan2(dirX, dirZ);
  }
}

// ---- Player creeps (du köper dem i shopen — marscherar mot enemyTower) ----

const playerCreeps = [];
const PLAYER_CREEP_HP = 25;
const PLAYER_CREEP_SPEED = 1.5;
const PLAYER_CREEP_COST = 10;
const CREEP_VS_CREEP_DAMAGE = 5;
const CREEP_VS_CREEP_RANGE = 1.5;
const CREEP_VS_CREEP_INTERVAL = 1.5;

function spawnPlayerCreep(lane) {
  // Dina sända grunts — spawnar i västra änden av HENS lanes (nedre arenan)
  // lane 1 = hens övre lane (z=-4), lane 2 = hens nedre lane (z=-12)
  const start = lane === 1 ? { x: -27, z: -4 } : { x: -27, z: -12 };
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 1.0, 0.7),
    new THREE.MeshStandardMaterial({ color: 0x3388dd, emissive: 0x112244, emissiveIntensity: 0.4 })
  );
  mesh.position.set(start.x, 0.5, start.z);
  scene.add(mesh);
  playerCreeps.push({ mesh, lane, hp: PLAYER_CREEP_HP, speed: PLAYER_CREEP_SPEED, pathIndex: 0, atkCd: 0 });
}

function removePlayerCreep(idx) {
  const c = playerCreeps[idx];
  if (!c) return;
  scene.remove(c.mesh);
  playerCreeps.splice(idx, 1);
}

function updatePlayerCreeps(dt) {
  for (let i = playerCreeps.length - 1; i >= 0; i--) {
    const c = playerCreeps[i];

    // Nått enemy-tornet?
    const dxT = enemyTower.x - c.mesh.position.x;
    const dzT = enemyTower.z - c.mesh.position.z;
    if (dxT * dxT + dzT * dzT < TOWER_REACH * TOWER_REACH) {
      enemyTower.hp = Math.max(0, enemyTower.hp - 1);
      removePlayerCreep(i);
      continue;
    }

    c.atkCd = Math.max(0, c.atkCd - dt);

    // Närmsta enemy-creep inom attack range?
    let nearest = null, bestDist = CREEP_VS_CREEP_RANGE;
    for (const m of monsters) {
      const dx = m.mesh.position.x - c.mesh.position.x;
      const dz = m.mesh.position.z - c.mesh.position.z;
      const d = Math.hypot(dx, dz);
      if (d < bestDist) { bestDist = d; nearest = m; }
    }
    if (nearest) {
      if (c.atkCd <= 0) {
        nearest.hp -= CREEP_VS_CREEP_DAMAGE;
        c.atkCd = CREEP_VS_CREEP_INTERVAL;
        if (nearest.hp <= 0) {
          const idx = monsters.indexOf(nearest);
          if (idx >= 0) killMonster(idx);
        }
      }
      const dx = nearest.mesh.position.x - c.mesh.position.x;
      const dz = nearest.mesh.position.z - c.mesh.position.z;
      c.mesh.rotation.y = Math.atan2(dx, dz);
      continue;
    }

    // Walk mot mål
    const path = lanePaths.player[c.lane];
    const idx = Math.min(c.pathIndex, path.length - 1);
    const target = path[idx];
    const dx = target.x - c.mesh.position.x;
    const dz = target.z - c.mesh.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.3 && c.pathIndex < path.length - 1) { c.pathIndex++; continue; }
    const dirX = dx / dist, dirZ = dz / dist;
    const step = c.speed * dt;
    const nx = c.mesh.position.x + dirX * step;
    const nz = c.mesh.position.z + dirZ * step;
    if (isMonsterPos(nx, nz)) {
      c.mesh.position.x = nx;
      c.mesh.position.z = nz;
    } else if (isMonsterPos(nx, c.mesh.position.z)) {
      c.mesh.position.x = nx;
    } else if (isMonsterPos(c.mesh.position.x, nz)) {
      c.mesh.position.z = nz;
    }
    c.mesh.rotation.y = Math.atan2(dirX, dirZ);
  }
}

const waveState = {
  current: 0,
  toSpawn: 0,
  spawnTimer: 0,
  spawnInterval: 1.0,
  betweenTimer: 3.0,
  active: false,
};

function startWave(n) {
  waveState.current = n;
  waveState.toSpawn = 4 + n * 2; // växer med wave-nummer
  waveState.spawnTimer = 0;
  waveState.active = true;
}

function updateWaves(dt) {
  if (!waveState.active) {
    waveState.betweenTimer -= dt;
    if (waveState.betweenTimer <= 0) startWave(waveState.current + 1);
    return;
  }
  if (waveState.toSpawn > 0) {
    waveState.spawnTimer -= dt;
    if (waveState.spawnTimer <= 0) {
      const lane = (waveState.toSpawn % 2 === 0) ? 1 : 2;
      spawnMonster(lane);
      waveState.toSpawn--;
      waveState.spawnTimer = waveState.spawnInterval;
    }
  } else if (monsters.length === 0) {
    waveState.active = false;
    waveState.betweenTimer = 5.0;
  }
}

// ---- Hjältens auto-attack ----

const HERO_ATTACK_RANGE = 4.0;
const HERO_ATTACK_INTERVAL = 1.0; // sek mellan attacker
let HERO_ATTACK_DAMAGE = 5;       // ökas av shop (svärd)
const PROJECTILE_SPEED = 18;
const PASSIVE_EVERY = 4;        // var 4:e auto-attack är AoE
const PASSIVE_AOE_RADIUS = 2.0; // AoE-radie runt målet vid passive-träff
let heroAttackCd = 0;
let attackCounter = 0;
const projectiles = [];

function findClosestMonster(x, z, maxDist) {
  let closest = null;
  let bestDist = maxDist;
  for (const m of monsters) {
    const dx = m.mesh.position.x - x;
    const dz = m.mesh.position.z - z;
    const d = Math.hypot(dx, dz);
    if (d < bestDist) { bestDist = d; closest = m; }
  }
  return closest;
}

function fireProjectile(target) {
  attackCounter++;
  const isAoE = attackCounter % PASSIVE_EVERY === 0;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(isAoE ? 0.28 : 0.18, 12, 8),
    new THREE.MeshStandardMaterial({
      color: isAoE ? 0xff66ff : 0xffdd55,
      emissive: isAoE ? 0x882288 : 0x886611,
      emissiveIntensity: isAoE ? 1.2 : 0.8,
    })
  );
  // Avfyras från hjältens "torso"-höjd så projektilen flyger över väggar
  mesh.position.set(hero.position.x, 1.5, hero.position.z);
  scene.add(mesh);
  projectiles.push({ mesh, target, damage: HERO_ATTACK_DAMAGE, isAoE });
}

function updateHeroAttack(dt) {
  heroAttackCd = Math.max(0, heroAttackCd - dt);
  if (heroAttackCd > 0) return;
  const target = findClosestMonster(hero.position.x, hero.position.z, HERO_ATTACK_RANGE);
  if (!target) return;
  fireProjectile(target);
  heroAttackCd = HERO_ATTACK_INTERVAL;
}

function updateProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    if (!monsters.includes(p.target)) {
      scene.remove(p.mesh);
      projectiles.splice(i, 1);
      continue;
    }
    const tp = p.target.mesh.position;
    const dx = tp.x - p.mesh.position.x;
    const dy = (tp.y + 0.4) - p.mesh.position.y;
    const dz = tp.z - p.mesh.position.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.4) {
      const impactX = p.target.mesh.position.x;
      const impactZ = p.target.mesh.position.z;
      p.target.hp -= p.damage;
      if (p.target.hp <= 0) {
        const idx = monsters.indexOf(p.target);
        if (idx >= 0) killMonster(idx);
      }
      // Passive: AoE-skada till andra monster nära träffpunkten
      if (p.isAoE) {
        for (let k = monsters.length - 1; k >= 0; k--) {
          const m = monsters[k];
          if (m === p.target) continue;
          const dxm = m.mesh.position.x - impactX;
          const dzm = m.mesh.position.z - impactZ;
          if (Math.hypot(dxm, dzm) < PASSIVE_AOE_RADIUS) {
            m.hp -= p.damage;
            if (m.hp <= 0) killMonster(k);
          }
        }
      }
      scene.remove(p.mesh);
      projectiles.splice(i, 1);
      continue;
    }
    const step = PROJECTILE_SPEED * dt;
    p.mesh.position.x += (dx / dist) * step;
    p.mesh.position.y += (dy / dist) * step;
    p.mesh.position.z += (dz / dist) * step;
  }
}

// ---- Hjälte-liv (HP, död, respawn) + guld-helper ----

function killHero() {
  if (player.dead) return;
  player.dead = true;
  player.respawnTimer = RESPAWN_TIME;
  hero.visible = false;
}

function respawnHero() {
  player.dead = false;
  player.hp = player.maxHp;
  hero.position.set(HERO_SPAWN.x, 0.8, HERO_SPAWN.z);
  hero.visible = true;
}

function killMonster(idx) {
  const m = monsters[idx];
  if (!m) return;
  scene.remove(m.mesh);
  monsters.splice(idx, 1);
  player.gold += GOLD_PER_KILL;
}

// ---- Skills (Magikern) ----

const skills = {
  q: { cd: 0, max: 4.0, name: 'Eldklot' },
  f: { cd: 0, max: 8.0, name: 'Frostnova' },
  e: { cd: 0, max: 10.0, name: 'Blink' },
};

// --- Q: Eldklot (skillshot, piercing) ---
const ELDKLOT_SPEED = 16;
const ELDKLOT_DAMAGE = 15;
const ELDKLOT_RANGE = 14;
const ELDKLOT_RADIUS = 0.6;
const fireballs = [];

function castEldklot(dirX, dirZ) {
  if (gameOver || player.dead || skills.q.cd > 0) return;
  if (dirX === undefined) { dirX = heroFacingX; dirZ = heroFacingZ; }
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.01) { dirX = heroFacingX; dirZ = heroFacingZ; }
  else { dirX /= len; dirZ /= len; }
  skills.q.cd = skills.q.max;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 14, 10),
    new THREE.MeshStandardMaterial({ color: 0xff5a18, emissive: 0xcc2200, emissiveIntensity: 1.0 })
  );
  mesh.position.set(hero.position.x, 1.0, hero.position.z);
  scene.add(mesh);
  fireballs.push({ mesh, dx: dirX, dz: dirZ, hit: new Set(), traveled: 0 });
}

function updateFireballs(dt) {
  for (let i = fireballs.length - 1; i >= 0; i--) {
    const f = fireballs[i];
    const step = ELDKLOT_SPEED * dt;
    f.mesh.position.x += f.dx * step;
    f.mesh.position.z += f.dz * step;
    f.traveled += step;
    for (let j = monsters.length - 1; j >= 0; j--) {
      const m = monsters[j];
      if (f.hit.has(m)) continue;
      const dx = m.mesh.position.x - f.mesh.position.x;
      const dz = m.mesh.position.z - f.mesh.position.z;
      if (Math.hypot(dx, dz) < ELDKLOT_RADIUS + 0.45) {
        f.hit.add(m);
        m.hp -= ELDKLOT_DAMAGE;
        if (m.hp <= 0) killMonster(j);
      }
    }
    if (f.traveled > ELDKLOT_RANGE) {
      scene.remove(f.mesh);
      fireballs.splice(i, 1);
    }
  }
}

// --- F: Frostnova (AoE + slow) ---
const NOVA_RADIUS = 3.5;
const NOVA_DAMAGE = 10;
const NOVA_SLOW_MUL = 0.6; // 40% slow
const NOVA_SLOW_TIME = 2.0;
const novaEffects = [];

function castFrostnova() {
  if (gameOver || player.dead || skills.f.cd > 0) return;
  skills.f.cd = skills.f.max;
  // Visuell ring som tonar ut
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.3, NOVA_RADIUS, 36),
    new THREE.MeshBasicMaterial({ color: 0x88ddff, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(hero.position.x, 0.08, hero.position.z);
  scene.add(ring);
  novaEffects.push({ mesh: ring, life: 0.6, maxLife: 0.6 });
  // Skada + slow inom radien
  for (let j = monsters.length - 1; j >= 0; j--) {
    const m = monsters[j];
    const dx = m.mesh.position.x - hero.position.x;
    const dz = m.mesh.position.z - hero.position.z;
    if (Math.hypot(dx, dz) < NOVA_RADIUS) {
      m.hp -= NOVA_DAMAGE;
      m.slowMul = NOVA_SLOW_MUL;
      m.slowTime = NOVA_SLOW_TIME;
      if (m.hp <= 0) killMonster(j);
    }
  }
}

function updateNovaEffects(dt) {
  for (let i = novaEffects.length - 1; i >= 0; i--) {
    const n = novaEffects[i];
    n.life -= dt;
    n.mesh.material.opacity = 0.7 * (n.life / n.maxLife);
    if (n.life <= 0) {
      scene.remove(n.mesh);
      novaEffects.splice(i, 1);
    }
  }
}

// --- E: Blink (teleport i facing-riktning) ---
const BLINK_RANGE = 6.0;
function castBlink(dirX, dirZ) {
  if (gameOver || player.dead || skills.e.cd > 0) return;
  if (dirX === undefined) { dirX = heroFacingX; dirZ = heroFacingZ; }
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.01) { dirX = heroFacingX; dirZ = heroFacingZ; }
  else { dirX /= len; dirZ /= len; }
  // Hitta längsta giltiga distans <= BLINK_RANGE
  let dist = BLINK_RANGE;
  let nx, nz;
  while (dist >= 0.5) {
    nx = hero.position.x + dirX * dist;
    nz = hero.position.z + dirZ * dist;
    if (isWalkable(nx, nz)) break;
    dist -= 0.5;
  }
  if (dist < 0.5) return;
  skills.e.cd = skills.e.max;
  hero.position.x = nx;
  hero.position.z = nz;
}

function updateSkillCooldowns(dt) {
  skills.q.cd = Math.max(0, skills.q.cd - dt);
  skills.f.cd = Math.max(0, skills.f.cd - dt);
  skills.e.cd = Math.max(0, skills.e.cd - dt);
}

const statusEl = document.getElementById('status');
function fmtCd(s) { return s <= 0 ? 'redo' : s.toFixed(1) + 's'; }

const endgameEl = document.getElementById('endgame');
const endgameTitle = document.getElementById('endgame-title');
const endgameInfo = document.getElementById('endgame-info');
document.getElementById('restart-btn').addEventListener('click', () => location.reload());

function updateHud() {
  if (gameOver || gameWon) {
    endgameEl.classList.add('visible');
    endgameEl.classList.toggle('win', gameWon);
    endgameEl.classList.toggle('lose', gameOver);
    endgameTitle.textContent = gameWon ? 'VINST!' : 'FÖRLUST';
    endgameInfo.textContent = gameWon
      ? `Du krossade motståndarens torn på wave ${waveState.current}.`
      : `Ditt torn föll på wave ${waveState.current}.`;
    return;
  }
  const heroLine = player.dead
    ? `<span style="color:#ff6666">DÖD — respawn om ${player.respawnTimer.toFixed(1)}s</span>`
    : `HP: ${player.hp}/${player.maxHp}`;
  const top = [
    heroLine,
    `Guld: ${player.gold}`,
    `<span style="color:#88aaff">Du: ${tower.hp}/${tower.maxHp}</span>`,
    `<span style="color:#ff8888">Motst: ${enemyTower.hp}/${enemyTower.maxHp}</span>`,
  ];
  if (waveState.active) top.push(`Wave ${waveState.current}`);
  else top.push(`Wave ${waveState.current + 1} om: ${waveState.betweenTimer.toFixed(1)}s`);
  const nextAoe = PASSIVE_EVERY - (attackCounter % PASSIVE_EVERY);
  const bottom = [
    `Q: ${fmtCd(skills.q.cd)}`,
    `F: ${fmtCd(skills.f.cd)}`,
    `E: ${fmtCd(skills.e.cd)}`,
    `AoE: ${nextAoe}`,
  ];
  statusEl.innerHTML = top.join(' | ') + '<br>' + bottom.join(' | ');
}

// ---- Sikt-indikatorer (visas under drag-aim på mobil) ----

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
  // Q: linje från hjälten i aim-riktning
  if (aimState.key === 'q' && aimState.active) {
    aimLine.visible = true;
    const cx = hero.position.x + aimState.dx * (ELDKLOT_RANGE / 2);
    const cz = hero.position.z + aimState.dz * (ELDKLOT_RANGE / 2);
    aimLine.position.set(cx, 0.06, cz);
    // Rotera planet runt y-axeln så att dess längdaxel pekar i (dx,dz). PlaneGeometry är XY innan rotation.x.
    // Efter rotation.x=-π/2 ligger planet i XZ med längd längs X, bredd längs Z. Rotera y för att rikta längden.
    aimLine.rotation.y = -Math.atan2(aimState.dz, aimState.dx);
  } else {
    aimLine.visible = false;
  }
  // E: prick där hjälten landar
  if (aimState.key === 'e' && aimState.active) {
    aimDot.visible = true;
    let dist = BLINK_RANGE;
    let nx, nz;
    while (dist >= 0.5) {
      nx = hero.position.x + aimState.dx * dist;
      nz = hero.position.z + aimState.dz * dist;
      if (isWalkable(nx, nz)) break;
      dist -= 0.5;
    }
    if (dist >= 0.5) aimDot.position.set(nx, 0.06, nz);
    else aimDot.position.set(hero.position.x, 0.06, hero.position.z);
  } else {
    aimDot.visible = false;
  }
}

// ---- Touch-input (virtuell joystick + skill-knappar med drag-to-aim) ----

const joyEl = document.getElementById('joy');
const joyKnobEl = document.getElementById('joy-knob');
const skillEls = {
  q: document.getElementById('skill-q'),
  f: document.getElementById('skill-f'),
  e: document.getElementById('skill-e'),
};

const joyState = {
  touchId: null,
  cx: 0, cy: 0,
  dx: 0, dz: 0, // -1..1 (dz = -y eftersom skärm-y växer nedåt)
  radius: 70,
};

const aimState = {
  touchId: null,
  key: null,
  active: false,
  btnCx: 0, btnCy: 0,
  dx: 0, dz: 0,
  dragMag: 0,
};

const AIM_THRESHOLD = 16; // pixlar drag innan vi räknar som aim (annars tap)
const SKILL_AIMABLE = { q: true, e: true, f: false };

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
  let dx = touch.clientX - joyState.cx;
  let dy = touch.clientY - joyState.cy;
  const mag = Math.hypot(dx, dy);
  const max = joyState.radius;
  const clamped = Math.min(mag, max);
  const ndx = mag > 0 ? dx / mag : 0;
  const ndy = mag > 0 ? dy / mag : 0;
  joyKnobEl.style.transform = `translate(${ndx * clamped}px, ${ndy * clamped}px)`;
  // Magnitude som styrka (0..1) — vi använder full hastighet om man drar till kanten
  const strength = clamped / max;
  joyState.dx = ndx * strength;
  joyState.dz = ndy * strength; // skärm-y nedåt → spel-z framåt (söder)
}

function endJoystick() {
  joyState.touchId = null;
  joyState.dx = 0; joyState.dz = 0;
  joyKnobEl.style.transform = 'translate(0px, 0px)';
}

function skillKeyFromTarget(target) {
  // Klätt sig genom shadow children — gå upp till elementet med data-key
  let el = target;
  while (el && el !== document.body) {
    if (el.dataset && el.dataset.key) return el.dataset.key;
    el = el.parentElement;
  }
  return null;
}

function startSkillTouch(touch, key) {
  if (skills[key].cd > 0) return;
  const r = rectOf(skillEls[key]);
  aimState.touchId = touch.identifier;
  aimState.key = key;
  aimState.active = SKILL_AIMABLE[key];
  aimState.btnCx = r.left + r.width / 2;
  aimState.btnCy = r.top + r.height / 2;
  aimState.dx = heroFacingX;
  aimState.dz = heroFacingZ;
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
    // Skärm-koordinater → spelkoordinater: x→x, y→z (skärm-y nedåt = spel-z söderut)
    aimState.dx = dx / mag;
    aimState.dz = dy / mag;
  }
}

function endSkillTouch(touch, cancelled) {
  const key = aimState.key;
  if (!key) return;
  skillEls[key].classList.remove('active');
  if (!cancelled) {
    // Riktning: aim om man dragit över threshold, annars facing
    let dx, dz;
    if (SKILL_AIMABLE[key] && aimState.dragMag > AIM_THRESHOLD) {
      dx = aimState.dx; dz = aimState.dz;
    } else {
      dx = heroFacingX; dz = heroFacingZ;
    }
    if (key === 'q') castEldklot(dx, dz);
    else if (key === 'e') castBlink(dx, dz);
    else if (key === 'f') castFrostnova();
  }
  aimState.touchId = null;
  aimState.key = null;
  aimState.active = false;
}

function onTouchStart(e) {
  for (const touch of e.changedTouches) {
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    if (!target) continue;
    // Joystick?
    if (joyState.touchId === null && (target === joyEl || target === joyKnobEl || joyEl.contains(target))) {
      e.preventDefault();
      startJoystick(touch);
      continue;
    }
    // Skill?
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
    if (touch.identifier === joyState.touchId) {
      e.preventDefault();
      moveJoystick(touch);
    } else if (touch.identifier === aimState.touchId) {
      e.preventDefault();
      moveSkillTouch(touch);
    }
  }
}

function onTouchEnd(e) {
  for (const touch of e.changedTouches) {
    if (touch.identifier === joyState.touchId) {
      e.preventDefault();
      endJoystick();
    } else if (touch.identifier === aimState.touchId) {
      e.preventDefault();
      endSkillTouch(touch, e.type === 'touchcancel');
    }
  }
}

window.addEventListener('touchstart', onTouchStart, { passive: false });
window.addEventListener('touchmove', onTouchMove, { passive: false });
window.addEventListener('touchend', onTouchEnd, { passive: false });
window.addEventListener('touchcancel', onTouchEnd, { passive: false });

// ---- Shop (visas när hjälten är i bas-zonen och lever) ----

const shopEl = document.getElementById('shop');
const shopBtns = Array.from(document.querySelectorAll('.shop-btn'));

const shopItems = {
  sword:      { cost: 50, apply: () => { HERO_ATTACK_DAMAGE += 5; } },
  boots:      { cost: 40, apply: () => { moveSpeed += 1; } },
  vit:        { cost: 60, apply: () => { player.maxHp += 50; player.hp = player.maxHp; } },
  'grunt-top':{ cost: PLAYER_CREEP_COST, apply: () => spawnPlayerCreep(1) },
  'grunt-bot':{ cost: PLAYER_CREEP_COST, apply: () => spawnPlayerCreep(2) },
};

shopBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.item;
    const item = shopItems[id];
    if (!item) return;
    if (player.gold < item.cost) return;
    if (player.dead) return;
    player.gold -= item.cost;
    if (id in player.items) player.items[id]++;
    item.apply();
  });
});

function isInBaseZone(x, z) {
  return x >= 10.6 && x <= 27.55 && z >= 0.5 && z <= 14.55;
}

function updateShop() {
  const inBase = !player.dead && isInBaseZone(hero.position.x, hero.position.z);
  shopEl.classList.toggle('visible', inBase);
  if (inBase) {
    for (const btn of shopBtns) {
      const id = btn.dataset.item;
      const cost = shopItems[id].cost;
      btn.disabled = player.gold < cost;
    }
  }
}

function updateSkillButtonStyles() {
  for (const key of ['q', 'f', 'e']) {
    const el = skillEls[key];
    const cd = skills[key].cd;
    if (cd > 0) {
      el.classList.add('cooling');
      el.querySelector('.cd').textContent = cd.toFixed(1);
    } else {
      el.classList.remove('cooling');
      el.querySelector('.cd').textContent = '';
    }
  }
}

let gameOver = false;
let gameWon = false;

let moveSpeed = 6; // ökas av shop (stövlar)
const clock = new THREE.Clock();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);

  if (!gameOver && !gameWon && player.dead) {
    player.respawnTimer -= dt;
    if (player.respawnTimer <= 0) respawnHero();
  }

  if (!gameOver && !gameWon) {
    if (!player.dead) {
      // Tangentbord
      let kx = 0, kz = 0;
    if (keys['KeyW'] || keys['ArrowUp']) kz -= 1;
    if (keys['KeyS'] || keys['ArrowDown']) kz += 1;
    if (keys['KeyA'] || keys['ArrowLeft']) kx -= 1;
    if (keys['KeyD'] || keys['ArrowRight']) kx += 1;
    const klen = Math.hypot(kx, kz);
    if (klen > 0) { kx /= klen; kz /= klen; }
    // Joystick (touch). Magnitude redan 0..1.
    const jx = joyState.dx;
    const jz = joyState.dz;
    // Välj input: joystick prioriteras om aktiv (har magnitude)
    let mx, mz, strength;
    if (Math.hypot(jx, jz) > 0.05) {
      mx = jx; mz = jz; strength = Math.min(1, Math.hypot(jx, jz));
    } else if (klen > 0) {
      mx = kx; mz = kz; strength = 1;
    } else {
      mx = 0; mz = 0; strength = 0;
    }
    if (strength > 0) {
      const ndx = mx / Math.max(1e-6, Math.hypot(mx, mz));
      const ndz = mz / Math.max(1e-6, Math.hypot(mx, mz));
      heroFacingX = ndx;
      heroFacingZ = ndz;
      const nx = hero.position.x + ndx * moveSpeed * strength * dt;
      const nz = hero.position.z + ndz * moveSpeed * strength * dt;
      if (isWalkable(nx, nz)) {
        hero.position.x = nx;
        hero.position.z = nz;
      } else if (isWalkable(nx, hero.position.z)) {
        hero.position.x = nx;
      } else if (isWalkable(hero.position.x, nz)) {
        hero.position.z = nz;
      }
      hero.rotation.y = Math.atan2(ndx, ndz);
    }
    } // slut på if (!player.dead)

    updateSkillCooldowns(dt);
    updateWaves(dt);
    updateMonsters(dt);
    updatePlayerCreeps(dt);
    if (!player.dead) updateHeroAttack(dt);
    updateProjectiles(dt);
    updateFireballs(dt);
    updateNovaEffects(dt);
    if (tower.hp <= 0) gameOver = true;
    else if (enemyTower.hp <= 0) gameWon = true;
  }

  updateHud();
  updateSkillButtonStyles();
  updateAimIndicators();
  updateShop();

  const lerpK = 1 - Math.pow(0.001, dt);
  const desired = hero.position.clone().add(cameraOffset);
  camera.position.lerp(desired, lerpK);
  cameraTarget.lerp(hero.position, lerpK);
  camera.lookAt(cameraTarget);

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
