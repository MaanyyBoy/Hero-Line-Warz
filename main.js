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

// Bas-zonens golv (ljusare innergård)
const baseFloor = new THREE.Mesh(
  new THREE.PlaneGeometry(18, 30),
  new THREE.MeshStandardMaterial({ color: 0x6b6555 })
);
baseFloor.rotation.x = -Math.PI / 2;
baseFloor.position.set(19, 0.01, 0);
scene.add(baseFloor);

// Lanesnas golv (jord/sand)
function makeLane(cx, cz, length, width) {
  const lane = new THREE.Mesh(
    new THREE.PlaneGeometry(length, width),
    new THREE.MeshStandardMaterial({ color: 0x7a5a3a })
  );
  lane.rotation.x = -Math.PI / 2;
  lane.position.set(cx, 0.01, cz);
  scene.add(lane);
}
makeLane(-10, 8.25, 40, 13.5);   // Lane 1: x [-30, 10], z [1.5, 15]
makeLane(-10, -8.25, 40, 13.5);  // Lane 2: x [-30, 10], z [-15, -1.5]

// Väggar
function makeWall(cx, cz, w, d, h = 1.2) {
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color: 0x4a443d })
  );
  wall.position.set(cx, h / 2, cz);
  scene.add(wall);
}
makeWall(-1, 15.15, 58, 0.3);    // Norra ytterväggen (löper över hela kartan)
makeWall(-1, -15.15, 58, 0.3);   // Södra ytterväggen
makeWall(28.15, 0, 0.3, 30.6);   // Östra bakväggen (bakom basen)
makeWall(-10, 1.35, 40, 0.3);    // Lane 1 innervägg (nedre kanten av lane 1)
makeWall(-10, -1.35, 40, 0.3);   // Lane 2 innervägg (övre kanten av lane 2)
makeWall(9.85, 0, 0.3, 3);       // Smal mur mellan lane-mynningarna vid basen

// Spelarens torn (med HP-state)
const tower = { x: 24, z: 0, hp: 100, maxHp: 100 };
const towerBase = new THREE.Mesh(
  new THREE.CylinderGeometry(1.6, 1.8, 1, 16),
  new THREE.MeshStandardMaterial({ color: 0xb0b0b8 })
);
towerBase.position.set(tower.x, 0.5, tower.z);
scene.add(towerBase);

const towerTop = new THREE.Mesh(
  new THREE.CylinderGeometry(0.9, 1.3, 3, 16),
  new THREE.MeshStandardMaterial({ color: 0x7a7aa0 })
);
towerTop.position.set(tower.x, 2.5, tower.z);
scene.add(towerTop);

// Spawn-markörer i lanesnas västra ände
function makeSpawnMarker(x, z) {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 0.9, 0.2, 12),
    new THREE.MeshStandardMaterial({ color: 0xcc4444, emissive: 0x441111 })
  );
  m.position.set(x, 0.12, z);
  scene.add(m);
}
makeSpawnMarker(-29, 11);
makeSpawnMarker(-29, -11);

// Hjälten — startar i bas-zonen framför tornet
const hero = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.4, 0.8, 8, 16),
  new THREE.MeshStandardMaterial({ color: 0xff5533 })
);
hero.position.set(15, 0.8, 0);
scene.add(hero);

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
function isWalkable(x, z) {
  const dx = x - tower.x, dz = z - tower.z;
  if (dx * dx + dz * dz < (TOWER_R + HERO_R) * (TOWER_R + HERO_R)) return false;
  // Bas-zon
  if (x >= 10.6 && x <= 27.55 && z >= -14.55 && z <= 14.55) return true;
  // Lane 1 (med liten överlapp in i basen för smidig övergång)
  if (x >= -29.55 && x <= 11 && z >= 1.95 && z <= 14.55) return true;
  // Lane 2
  if (x >= -29.55 && x <= 11 && z >= -14.55 && z <= -1.95) return true;
  return false;
}

// ---- Monster + wave-system ----

const monsters = [];

// Vägpunkter per lane: först till bas-ingången, sen till tornet.
const lanePaths = {
  1: [{ x: 10, z: 8.25 }, { x: tower.x, z: tower.z }],
  2: [{ x: 10, z: -8.25 }, { x: tower.x, z: tower.z }],
};

function spawnMonster(lane) {
  const start = lane === 1 ? { x: -29, z: 11 } : { x: -29, z: -11 };
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

// Walkable för monster — samma yta som hjältens, men utan torn-exklusion
// (monster ska kunna trycka mot tornet för att skada det).
function isMonsterPos(x, z) {
  if (x >= 10.6 && x <= 27.55 && z >= -14.55 && z <= 14.55) return true;
  if (x >= -29.55 && x <= 11 && z >= 1.95 && z <= 14.55) return true;
  if (x >= -29.55 && x <= 11 && z >= -14.55 && z <= -1.95) return true;
  return false;
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

    // Aggro: börja jaga om hjälten är nära, sluta jaga om hjälten är långt borta (hysteres).
    const dxh = hero.position.x - m.mesh.position.x;
    const dzh = hero.position.z - m.mesh.position.z;
    const distHero = Math.hypot(dxh, dzh);
    if (!m.chasing && distHero < MONSTER_AGGRO_RANGE) m.chasing = true;
    else if (m.chasing && distHero > MONSTER_LEASH_RANGE) m.chasing = false;

    // Riktning: mot hjälten om jagar, annars mot vägpunkt mot tornet.
    let dirX, dirZ;
    if (m.chasing) {
      if (distHero < 0.7) continue;
      dirX = dxh / distHero;
      dirZ = dzh / distHero;
    } else {
      const path = lanePaths[m.lane];
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
const HERO_ATTACK_DAMAGE = 5;
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
        scene.remove(p.target.mesh);
        const idx = monsters.indexOf(p.target);
        if (idx >= 0) monsters.splice(idx, 1);
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
            if (m.hp <= 0) {
              scene.remove(m.mesh);
              monsters.splice(k, 1);
            }
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

function castEldklot() {
  if (gameOver || skills.q.cd > 0) return;
  skills.q.cd = skills.q.max;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 14, 10),
    new THREE.MeshStandardMaterial({ color: 0xff5a18, emissive: 0xcc2200, emissiveIntensity: 1.0 })
  );
  mesh.position.set(hero.position.x, 1.0, hero.position.z);
  scene.add(mesh);
  fireballs.push({
    mesh,
    dx: heroFacingX,
    dz: heroFacingZ,
    hit: new Set(),
    traveled: 0,
  });
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
        if (m.hp <= 0) {
          scene.remove(m.mesh);
          monsters.splice(j, 1);
        }
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
  if (gameOver || skills.f.cd > 0) return;
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
      if (m.hp <= 0) {
        scene.remove(m.mesh);
        monsters.splice(j, 1);
      }
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
function castBlink() {
  if (gameOver || skills.e.cd > 0) return;
  // Hitta längsta giltiga distans <= BLINK_RANGE
  let dist = BLINK_RANGE;
  let nx, nz;
  while (dist >= 0.5) {
    nx = hero.position.x + heroFacingX * dist;
    nz = hero.position.z + heroFacingZ * dist;
    if (isWalkable(nx, nz)) break;
    dist -= 0.5;
  }
  if (dist < 0.5) return; // Inget giltigt mål — spendera ingen CD
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

function updateHud() {
  if (tower.hp <= 0) {
    statusEl.textContent = `GAME OVER — du klarade ${waveState.current - 1} waves`;
    return;
  }
  const top = [`Torn HP: ${tower.hp}/${tower.maxHp}`];
  if (waveState.active) {
    top.push(`Wave ${waveState.current}`);
    top.push(`Monster: ${monsters.length + waveState.toSpawn}`);
  } else {
    top.push(`Wave ${waveState.current + 1} om: ${waveState.betweenTimer.toFixed(1)}s`);
  }
  const nextAoe = PASSIVE_EVERY - (attackCounter % PASSIVE_EVERY);
  const bottom = [
    `Q Eldklot: ${fmtCd(skills.q.cd)}`,
    `F Frostnova: ${fmtCd(skills.f.cd)}`,
    `E Blink: ${fmtCd(skills.e.cd)}`,
    `Nästa AoE-AA: ${nextAoe}`,
  ];
  statusEl.innerHTML = top.join(' | ') + '<br>' + bottom.join(' | ');
}

let gameOver = false;

const moveSpeed = 6;
const clock = new THREE.Clock();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);

  if (!gameOver) {
    let mx = 0, mz = 0;
    if (keys['KeyW'] || keys['ArrowUp']) mz -= 1;
    if (keys['KeyS'] || keys['ArrowDown']) mz += 1;
    if (keys['KeyA'] || keys['ArrowLeft']) mx -= 1;
    if (keys['KeyD'] || keys['ArrowRight']) mx += 1;
    const len = Math.hypot(mx, mz);
    if (len > 0) {
      mx /= len; mz /= len;
      heroFacingX = mx;
      heroFacingZ = mz;
      const nx = hero.position.x + mx * moveSpeed * dt;
      const nz = hero.position.z + mz * moveSpeed * dt;
      if (isWalkable(nx, nz)) {
        hero.position.x = nx;
        hero.position.z = nz;
      } else if (isWalkable(nx, hero.position.z)) {
        hero.position.x = nx;
      } else if (isWalkable(hero.position.x, nz)) {
        hero.position.z = nz;
      }
      hero.rotation.y = Math.atan2(mx, mz);
    }

    updateSkillCooldowns(dt);
    updateWaves(dt);
    updateMonsters(dt);
    updateHeroAttack(dt);
    updateProjectiles(dt);
    updateFireballs(dt);
    updateNovaEffects(dt);
    if (tower.hp <= 0) gameOver = true;
  }

  updateHud();

  const lerpK = 1 - Math.pow(0.001, dt);
  const desired = hero.position.clone().add(cameraOffset);
  camera.position.lerp(desired, lerpK);
  cameraTarget.lerp(hero.position, lerpK);
  camera.lookAt(cameraTarget);

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
