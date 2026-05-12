'use strict';

// =============================================================
// Pure simulation engine för Hero Line Warz (Node-side, server-auth).
// Inga Three.js-beroenden — entiteter använder { x, z, ry } direkt.
// Måste hållas i synk med simuleringen i src/main.js (solo-mode).
// =============================================================

// === Hero & melee-konstanter ===
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

// Fontän-aura: hero inom radius av egen fontän får regen + buff på output/defense/CDR/AS
const FOUNTAIN_AURA_RADIUS = 4.5;
const FOUNTAIN_AURA_RADIUS_SQ = FOUNTAIN_AURA_RADIUS * FOUNTAIN_AURA_RADIUS;
const FOUNTAIN_AURA_REGEN = 2;       // hp/s
const FOUNTAIN_AURA_PCT = 0.10;      // 10% till varje stat
const FOUNTAIN_DMG_MUL = 1 + FOUNTAIN_AURA_PCT;
const FOUNTAIN_DMG_REDUCTION_MUL = 1 - FOUNTAIN_AURA_PCT;
const FOUNTAIN_CDR_MUL = 1 + FOUNTAIN_AURA_PCT;       // snabbare cd-decrement
const FOUNTAIN_AS_MUL = 1 + FOUNTAIN_AURA_PCT;         // snabbare attack-interval

const INCOME_BASE = 2;
const INCOME_INTERVAL = 15.0;
const INCOME_MINION_RATIO = 0.2;

// Level-system 1–30
const MAX_LEVEL = 30;
const LEVEL_DMG_PCT = 0.04;   // +4% dmg + skill-dmg per level
const LEVEL_HP_PCT = 0.04;    // +4% max HP per level
const LEVEL_MS_PCT = 0.01;    // +1% move-speed per level
function xpForLevel(level) { return 50 * level; } // XP behövs för att gå från `level` → `level+1`
const MONSTER_XP_REWARD = 10;
const CREEP_XP_RATIO = 0.6;

// Hero pick-fas
const PICK_PHASE_DURATION = 60; // sek

// Duel-system: var 5:e min stannar lane-fas och båda hjältar slåss i arena
const DUEL_INTERVAL = 300;      // 5 min mellan dueler
const DUEL_DURATION = 90;       // max sekunder per duel
const DUEL_MAX_COUNT = 4;
const DUEL_REWARDS_GOLD = [500, 1500, 5000, 10000];
const DUEL_ANNOUNCE_TIME = 4;   // sek att visa vinnare efter duel
// Arena ligger separat från huvudkartan (centrum z=35)
const ARENA_CX = 0;
const ARENA_CZ = 35;
const ARENA_RADIUS = 9;   // XP = creep.cost * 0.6

const TIER_UNLOCK_COST = { 2: 200, 3: 500, 4: 1000, 5: 2000 };

// === Minion-data ===
const ARCHETYPE_BASE = {
  slasher:  { cost: 10, hp: 18, speed: 1.6,  damage: 3, range: 1.0, interval: 0.8, attackType: 'melee' },
  archer:   { cost: 14, hp: 15, speed: 1.4,  damage: 4, range: 3.5, interval: 1.2, attackType: 'arrow' },
  bruiser:  { cost: 18, hp: 32, speed: 1.3,  damage: 5, range: 1.2, interval: 1.3, attackType: 'melee' },
  mage:     { cost: 22, hp: 20, speed: 1.3,  damage: 5, range: 3.5, interval: 1.5, attackType: 'magic', aoeRadius: 1.6 },
  tank:     { cost: 26, hp: 60, speed: 1.15, damage: 2, range: 1.0, interval: 1.4, attackType: 'melee' },
  champion: { cost: 35, hp: 48, speed: 1.3,  damage: 8, range: 1.5, interval: 1.5, attackType: 'melee' },
};
const ARCHETYPE_ORDER = ['slasher', 'archer', 'bruiser', 'mage', 'tank', 'champion'];
const TIER_MULT = { 1: 1.0, 2: 2.0, 3: 4.0, 4: 7.0, 5: 11.0 };
const TIER_NAMES = { 1: 'Goblin', 2: 'Ork', 3: 'Vandöd', 4: 'Demon', 5: 'Drakätt' };

const MINION_TYPES = {};
for (const tier of [1, 2, 3, 4, 5]) {
  for (const arch of ARCHETYPE_ORDER) {
    const base = ARCHETYPE_BASE[arch];
    const mult = TIER_MULT[tier];
    const id = `T${tier}_${arch}`;
    MINION_TYPES[id] = {
      id, tier, archetype: arch,
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
const MINION_KILL_RATIO = 0.2;
const ARROW_SPEED = 14;
const MAGIC_PROJ_SPEED = 10;

// === Items ===
const ITEM_BUY_COST = 200;
const ITEM_MAX_LEVEL = 10;
const INVENTORY_SLOTS = 4;
const SKILL_BASE_CD = { q: 4.0, f: 8.0, e: 10.0 };
const ACTIVE_DURATION = 5;
const ACTIVE_COOLDOWN = 30;
const bootsPct = (level) => 0.10 * Math.pow(1.2, level - 1);

const ITEM_TYPES = {
  item1: {
    id: 'item1', name: 'Boots',
    variants: {
      speed: {
        id: 'speed', name: 'Boots of Speed',
        statsAtLevel: (level) => { const v = bootsPct(level); return { moveSpeedPct: v, attackSpeedPct: v }; },
        activeAtMax: { duration: 5, cooldown: 30, stats: { moveSpeedPct: 0.5, attackSpeedPct: 0.5 } },
      },
      magic: {
        id: 'magic', name: 'Boots of Magic',
        statsAtLevel: (level) => { const v = bootsPct(level); return { skillDmgPct: v, cdrPct: v }; },
        activeAtMax: { duration: 5, cooldown: 30, stats: { skillDmgPct: 0.5, cdrPct: 0.5 } },
      },
      tank: {
        id: 'tank', name: 'Boots of Tank',
        statsAtLevel: (level) => { const v = bootsPct(level); return { dmgReductionPct: v, maxHpPct: v }; },
        activeAtMax: { duration: 5, cooldown: 30, stats: { dmgReductionPct: 0.5, maxHpPct: 0.5 } },
      },
    },
  },
  item2: { id: 'item2', name: 'Item 2', statsAtLevel: () => ({}) },
  item3: { id: 'item3', name: 'Item 3', statsAtLevel: () => ({}) },
  item4: { id: 'item4', name: 'Item 4', statsAtLevel: () => ({}) },
  item5: { id: 'item5', name: 'Item 5', statsAtLevel: () => ({}) },
  item6: { id: 'item6', name: 'Item 6', statsAtLevel: () => ({}) },
};

// === Side config ===
const SIDE_CFG = {
  1: { laneZ: { 1: 12, 2: 4 },   spawnX: -27, baseZRange: [0.5, 14.55],   tower: { x: 24, z: 8 },  heroSpawn: { x: 15, z: 8 } },
  2: { laneZ: { 1: -4, 2: -12 }, spawnX: -27, baseZRange: [-14.55, -0.5], tower: { x: 24, z: -8 }, heroSpawn: { x: 15, z: -8 } },
};

// === Walk-checks ===
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
function isArenaWalkable(x, z) {
  const dx = x - ARENA_CX, dz = z - ARENA_CZ;
  return (dx * dx + dz * dz) < (ARENA_RADIUS - HERO_R) * (ARENA_RADIUS - HERO_R);
}
function isCreepPos(x, z) {
  if (x >= 10.6 && x <= 27.55 && z >= 0.5 && z <= 14.55) return true;
  if (x >= 10.6 && x <= 27.55 && z >= -14.55 && z <= -0.5) return true;
  return inLane(x, z, 12) || inLane(x, z, 4) || inLane(x, z, -4) || inLane(x, z, -12);
}

// === Helpers ===
function itemDefForEntry(entry) {
  const root = ITEM_TYPES[entry.itemId];
  if (!root) return null;
  if (entry.variantId && root.variants && root.variants[entry.variantId]) return root.variants[entry.variantId];
  return root;
}
function itemUpgradeCost(currentLevel) { return 500 * Math.pow(2, currentLevel - 1); }
function minionBounty(creep) { return Math.max(1, Math.floor((creep.cost || 10) * MINION_KILL_RATIO)); }
function minionXp(creep) { return Math.max(1, Math.floor((creep.cost || 10) * CREEP_XP_RATIO)); }

// Lägg XP på sida och hantera level-up. Stoppar vid MAX_LEVEL.
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

function recomputeSideStats(side) {
  let attackDmg = HERO_BASE_ATTACK_DMG;
  let moveSpeedFlat = HERO_BASE_MOVE_SPEED;
  let maxHpFlat = HERO_MAX_HP;
  let attackSpeedPct = 0, moveSpeedPct = 0, skillDmgPct = 0, cdrPct = 0, dmgReductionPct = 0, maxHpPct = 0;
  const addStats = (s) => {
    if (!s) return;
    attackDmg += s.attackDmg || 0;
    moveSpeedFlat += s.moveSpeed || 0;
    maxHpFlat += s.maxHp || 0;
    attackSpeedPct += s.attackSpeedPct || 0;
    moveSpeedPct += s.moveSpeedPct || 0;
    skillDmgPct += s.skillDmgPct || 0;
    cdrPct += s.cdrPct || 0;
    dmgReductionPct += s.dmgReductionPct || 0;
    maxHpPct += s.maxHpPct || 0;
  };
  for (const entry of side.inventory) {
    const def = itemDefForEntry(entry);
    if (!def) continue;
    if (def.statsAtLevel) addStats(def.statsAtLevel(entry.level));
    if ((entry.activeRemaining || 0) > 0 && def.activeAtMax && def.activeAtMax.stats) {
      addStats(def.activeAtMax.stats);
    }
  }
  // Level-skalning ovanpå items: +4% dmg/HP/skill-dmg, +1% movespeed per level (utöver lvl 1)
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
  const newMaxHp = Math.round(maxHpFlat * (1 + maxHpPct) * levelHpMul);
  if (newMaxHp !== side.hero.maxHp) {
    const delta = newMaxHp - side.hero.maxHp;
    side.hero.maxHp = newMaxHp;
    if (delta > 0) side.hero.hp = Math.min(newMaxHp, side.hero.hp + delta);
    else if (side.hero.hp > newMaxHp) side.hero.hp = newMaxHp;
  }
  side.skills.q.max = SKILL_BASE_CD.q * side.cdrMul;
  side.skills.f.max = SKILL_BASE_CD.f * side.cdrMul;
  side.skills.e.max = SKILL_BASE_CD.e * side.cdrMul;
}

function damageHero(side, amount) {
  if (side.hero.dead) return;
  const auraMul = side.heroFountainAura ? FOUNTAIN_DMG_REDUCTION_MUL : 1;
  const final = amount * (side.dmgReductionMul ?? 1) * auraMul;
  side.hero.hp = Math.max(0, side.hero.hp - final);
  if (side.hero.hp <= 0) killHero(side);
}

function updateActiveBuffs(side, dt) {
  let buffEnded = false;
  for (const entry of side.inventory) {
    if ((entry.activeRemaining || 0) > 0) {
      entry.activeRemaining -= dt;
      if (entry.activeRemaining <= 0) { entry.activeRemaining = 0; buffEnded = true; }
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

function killHero(side) {
  if (side.hero.dead) return;
  side.hero.dead = true;
  side.hero.respawnTimer = RESPAWN_TIME;
}
function respawnHero(side) {
  const cfg = SIDE_CFG[side.idx];
  side.hero.dead = false;
  side.hero.hp = side.hero.maxHp;
  side.hero.x = cfg.heroSpawn.x;
  side.hero.z = cfg.heroSpawn.z;
}

function createSide(idx) {
  const cfg = SIDE_CFG[idx];
  const side = {
    idx,
    hero: {
      x: cfg.heroSpawn.x, z: cfg.heroSpawn.z,
      hp: HERO_MAX_HP, maxHp: HERO_MAX_HP,
      facingX: -1, facingZ: 0,
      dead: false, respawnTimer: 0,
    },
    moveSpeed: HERO_BASE_MOVE_SPEED,
    attackDmg: HERO_BASE_ATTACK_DMG,
    attackCd: 0,
    attackCounter: 0,
    attackSpeedMul: 1, skillDmgMul: 1, cdrMul: 1, dmgReductionMul: 1,
    heroFountainAura: false,
    aaActive: false,
    targetId: 0,
    targetType: '',
    targetX: 0,
    targetZ: 0,
    level: 1,
    xp: 0,
    xpToNext: xpForLevel(1),
    heroId: 'magiker',
    heroPickConfirmed: false,
    gold: 0,
    income: INCOME_BASE, incomeTimer: 0, incomeTickCount: 0,
    inventory: [],
    tierUnlocks: { 1: true, 2: false, 3: false, 4: false, 5: false },
    skills: {
      q: { cd: 0, max: SKILL_BASE_CD.q },
      f: { cd: 0, max: SKILL_BASE_CD.f },
      e: { cd: 0, max: SKILL_BASE_CD.e },
    },
    tower: { hp: TOWER_MAX_HP, maxHp: TOWER_MAX_HP },
    monsters: [],
    playerCreeps: [],
    projectiles: [],
    fireballs: [],
    novaEffects: [],
    creepProjectiles: [],
    wave: { current: 0, toSpawn: 0, spawnTimer: 0, spawnInterval: 1.0, betweenTimer: 3.0, active: false },
  };
  recomputeSideStats(side);
  return side;
}

function createGameState() {
  return {
    sides: { 1: createSide(1), 2: createSide(2) },
    nextEntityId: 1,
    matchState: { gameOver: false, winner: 0 },
    lastInputs: { 1: { j: { x: 0, z: 0 } }, 2: { j: { x: 0, z: 0 } } },
    phase: 'pick',
    pickTimer: PICK_PHASE_DURATION,
    duelActive: false,
    duelTimer: DUEL_INTERVAL,
    duelMatchTimer: 0,
    duelCount: 0,
    duelLastWinner: 0,         // sida-idx, 0=ingen/tie
    duelAnnounceTimer: 0,      // sek kvar att visa vinnar-banner
  };
}

function checkMatchEnd(state) {
  if (state.matchState.gameOver) return;
  if (state.sides[1].tower.hp <= 0) {
    state.matchState.gameOver = true;
    state.matchState.winner = 2;
  } else if (state.sides[2].tower.hp <= 0) {
    state.matchState.gameOver = true;
    state.matchState.winner = 1;
  }
}

// === Spawn ===
function spawnMonster(state, side, lane) {
  const cfg = SIDE_CFG[side.idx];
  side.monsters.push({
    id: state.nextEntityId++,
    x: cfg.spawnX, z: cfg.laneZ[lane], ry: 0,
    lane, hp: 10, speed: 2.0, pathIndex: 0,
    atkCd: 0, slowTime: 0, slowMul: 1.0, chasing: false,
  });
}

function spawnMinion(state, side, typeId, lane) {
  const def = MINION_TYPES[typeId];
  if (!def) return;
  const oppIdx = 3 - side.idx;
  const oppCfg = SIDE_CFG[oppIdx];
  side.playerCreeps.push({
    id: state.nextEntityId++,
    x: oppCfg.spawnX, z: oppCfg.laneZ[lane], ry: 0,
    typeId,
    lane,
    hp: def.hp, maxHp: def.hp,
    speed: def.speed, damage: def.damage, range: def.range, interval: def.interval,
    attackType: def.attackType, aoeRadius: def.aoeRadius || 0,
    cost: def.cost,
    pathIndex: 0, atkCd: 0,
  });
}

function spawnCreepProjectile(state, ownerSide, creep, target, targetType) {
  const isMagic = creep.attackType === 'magic';
  ownerSide.creepProjectiles.push({
    id: state.nextEntityId++,
    x: creep.x, y: 1.0, z: creep.z,
    target, targetType,
    damage: creep.damage,
    aoeRadius: creep.aoeRadius || 0,
    speed: isMagic ? MAGIC_PROJ_SPEED : ARROW_SPEED,
    kind: isMagic ? 'magic' : 'arrow',
  });
}

function killMonster(arenaSide, idx, byPlayerSide) {
  const m = arenaSide.monsters[idx];
  if (!m) return;
  arenaSide.monsters.splice(idx, 1);
  if (byPlayerSide) { byPlayerSide.gold += GOLD_PER_KILL; gainXp(byPlayerSide, MONSTER_XP_REWARD); }
  else { arenaSide.gold += GOLD_PER_KILL; gainXp(arenaSide, MONSTER_XP_REWARD); }
}

// === Update ===
function updateSkillCooldowns(side, dt) {
  // Fontän-aura accelererar cd-decrement med +10%
  const eff = dt * (side.heroFountainAura ? FOUNTAIN_CDR_MUL : 1);
  side.skills.q.cd = Math.max(0, side.skills.q.cd - eff);
  side.skills.f.cd = Math.max(0, side.skills.f.cd - eff);
  side.skills.e.cd = Math.max(0, side.skills.e.cd - eff);
}

function updateWaves(state, side, dt) {
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
      spawnMonster(state, side, lane);
      side.wave.toSpawn--;
      side.wave.spawnTimer = side.wave.spawnInterval;
    }
  } else if (side.monsters.length === 0) {
    side.wave.active = false;
    side.wave.betweenTimer = 5.0;
  }
}

function updateMonsters(state, side, opp, dt) {
  const heroX = side.hero.x, heroZ = side.hero.z;
  const heroAlive = !side.hero.dead;
  const towerPos = SIDE_CFG[side.idx].tower;
  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    const dxT = towerPos.x - m.x, dzT = towerPos.z - m.z;
    if (dxT * dxT + dzT * dzT < TOWER_REACH * TOWER_REACH) {
      side.tower.hp = Math.max(0, side.tower.hp - 1);
      side.monsters.splice(i, 1);
      continue;
    }
    const dxh = heroX - m.x, dzh = heroZ - m.z;
    const distHero = Math.hypot(dxh, dzh);
    if (!heroAlive) m.chasing = false;
    else if (!m.chasing && distHero < MONSTER_AGGRO_RANGE) m.chasing = true;
    else if (m.chasing && distHero > MONSTER_LEASH_RANGE) m.chasing = false;
    m.atkCd = Math.max(0, m.atkCd - dt);
    if (heroAlive && distHero < 1.2 && m.atkCd <= 0) {
      damageHero(side, MONSTER_MELEE_DAMAGE);
      m.atkCd = MONSTER_MELEE_INTERVAL;
    }
    if (!m.chasing && opp) {
      let nearest = null, bestDist = CREEP_VS_CREEP_RANGE;
      for (const pc of opp.playerCreeps) {
        const dx = pc.x - m.x, dz = pc.z - m.z;
        const d = Math.hypot(dx, dz);
        if (d < bestDist) { bestDist = d; nearest = pc; }
      }
      if (nearest) {
        if (m.atkCd <= 0) {
          nearest.hp -= CREEP_VS_CREEP_DAMAGE;
          m.atkCd = CREEP_VS_CREEP_INTERVAL;
          if (nearest.hp <= 0) {
            const idx2 = opp.playerCreeps.indexOf(nearest);
            if (idx2 >= 0) { opp.playerCreeps.splice(idx2, 1); side.gold += minionBounty(nearest); gainXp(side, minionXp(nearest)); }
          }
        }
        m.ry = Math.atan2(nearest.x - m.x, nearest.z - m.z);
        continue;
      }
    }
    let dirX, dirZ;
    if (m.chasing) {
      if (distHero < 0.7) continue;
      dirX = dxh / distHero; dirZ = dzh / distHero;
    } else {
      const cfg = SIDE_CFG[side.idx];
      const path = [{ x: 10, z: cfg.laneZ[m.lane] }, { x: cfg.tower.x, z: cfg.tower.z }];
      const idx2 = Math.min(m.pathIndex, path.length - 1);
      const tgt = path[idx2];
      const dx = tgt.x - m.x, dz = tgt.z - m.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.3 && m.pathIndex < path.length - 1) { m.pathIndex++; continue; }
      dirX = dx / d; dirZ = dz / d;
    }
    if (m.slowTime > 0) {
      m.slowTime -= dt;
      if (m.slowTime <= 0) m.slowMul = 1.0;
    }
    const step = m.speed * (m.slowMul || 1.0) * dt;
    const nx = m.x + dirX * step, nz = m.z + dirZ * step;
    if (isCreepPos(nx, nz)) { m.x = nx; m.z = nz; }
    else if (isCreepPos(nx, m.z)) m.x = nx;
    else if (isCreepPos(m.x, nz)) m.z = nz;
    m.ry = Math.atan2(dirX, dirZ);
  }
}

function updatePlayerCreeps(state, side, opp, dt) {
  const oppCfg = SIDE_CFG[3 - side.idx];
  for (let i = side.playerCreeps.length - 1; i >= 0; i--) {
    const c = side.playerCreeps[i];
    const dxT = oppCfg.tower.x - c.x, dzT = oppCfg.tower.z - c.z;
    if (dxT * dxT + dzT * dzT < TOWER_REACH * TOWER_REACH) {
      if (opp) opp.tower.hp = Math.max(0, opp.tower.hp - 1);
      side.playerCreeps.splice(i, 1);
      continue;
    }
    c.atkCd = Math.max(0, c.atkCd - dt);
    let target = null, targetType = null, bestDist = c.range;
    if (opp && !opp.hero.dead) {
      const d = Math.hypot(opp.hero.x - c.x, opp.hero.z - c.z);
      if (d < bestDist) { bestDist = d; target = opp.hero; targetType = 'hero'; }
    }
    if (opp) for (const m of opp.monsters) {
      const d = Math.hypot(m.x - c.x, m.z - c.z);
      if (d < bestDist) { bestDist = d; target = m; targetType = 'monster'; }
    }
    if (target) {
      const tx = target.x, tz = target.z;
      c.ry = Math.atan2(tx - c.x, tz - c.z);
      if (c.atkCd <= 0) {
        if (c.attackType === 'melee') {
          if (targetType === 'hero') damageHero(opp, c.damage);
          else {
            target.hp -= c.damage;
            if (target.hp <= 0) killMonster(opp, opp.monsters.indexOf(target), side);
          }
        } else {
          spawnCreepProjectile(state, side, c, target, targetType);
        }
        c.atkCd = c.interval;
      }
      continue;
    }
    const path = [{ x: 10, z: oppCfg.laneZ[c.lane] }, { x: oppCfg.tower.x, z: oppCfg.tower.z }];
    const idx2 = Math.min(c.pathIndex, path.length - 1);
    const tgt = path[idx2];
    const dx = tgt.x - c.x, dz = tgt.z - c.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.3 && c.pathIndex < path.length - 1) { c.pathIndex++; continue; }
    const dirX = dx / d, dirZ = dz / d;
    const step = c.speed * dt;
    const nx = c.x + dirX * step, nz = c.z + dirZ * step;
    if (isCreepPos(nx, nz)) { c.x = nx; c.z = nz; }
    else if (isCreepPos(nx, c.z)) c.x = nx;
    else if (isCreepPos(c.x, nz)) c.z = nz;
    c.ry = Math.atan2(dirX, dirZ);
  }
}

function updateCreepProjectiles(state, side, opp, dt) {
  for (let i = side.creepProjectiles.length - 1; i >= 0; i--) {
    const p = side.creepProjectiles[i];
    let alive = false, tx, tz, ty;
    if (p.targetType === 'hero') {
      alive = opp && !opp.hero.dead;
      if (alive) { tx = opp.hero.x; tz = opp.hero.z; ty = 0.9; }
    } else {
      alive = opp && opp.monsters.includes(p.target);
      if (alive) { tx = p.target.x; tz = p.target.z; ty = 0.9; }
    }
    if (!alive) { side.creepProjectiles.splice(i, 1); continue; }
    const dx = tx - p.x, dy = ty - p.y, dz = tz - p.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.4) {
      if (p.targetType === 'hero') damageHero(opp, p.damage);
      else {
        p.target.hp -= p.damage;
        if (p.target.hp <= 0) killMonster(opp, opp.monsters.indexOf(p.target), side);
      }
      if (p.aoeRadius > 0) {
        const ix = tx, iz = tz;
        if (opp && !opp.hero.dead && Math.hypot(opp.hero.x - ix, opp.hero.z - iz) < p.aoeRadius) {
          damageHero(opp, p.damage);
        }
        if (opp) for (let k = opp.monsters.length - 1; k >= 0; k--) {
          const m = opp.monsters[k];
          if (m === p.target) continue;
          if (Math.hypot(m.x - ix, m.z - iz) < p.aoeRadius) {
            m.hp -= p.damage;
            if (m.hp <= 0) killMonster(opp, k, side);
          }
        }
      }
      side.creepProjectiles.splice(i, 1);
      continue;
    }
    const step = p.speed * dt;
    p.x += (dx / dist) * step;
    p.y += (dy / dist) * step;
    p.z += (dz / dist) * step;
  }
}

function findClosestHostile(side, opp, x, z, maxDist, state) {
  let best = null, bestDist = maxDist;
  // Under duel: bara opp:s hero räknas (creeps/monsters är frysta)
  if (state && state.duelActive) {
    if (opp && !opp.hero.dead) {
      const d = Math.hypot(opp.hero.x - x, opp.hero.z - z);
      if (d < bestDist) return { entity: opp.hero, isMonster: false, isHero: true, targetSideIdx: 3 - side.idx };
    }
    return null;
  }
  for (const m of side.monsters) {
    const d = Math.hypot(m.x - x, m.z - z);
    if (d < bestDist) { bestDist = d; best = { entity: m, isMonster: true }; }
  }
  if (opp) for (const c of opp.playerCreeps) {
    const d = Math.hypot(c.x - x, c.z - z);
    if (d < bestDist) { bestDist = d; best = { entity: c, isMonster: false, ownerSide: opp }; }
  }
  return best;
}

// Slå upp target-entitet — kan vara monster/creep/hero (hero under duel).
function resolveTargetEntity(side, opp, state) {
  if (side.targetType === 'hero') {
    if (state && state.duelActive && opp && !opp.hero.dead) return opp.hero;
    return null;
  }
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

function maintainTargetLock(side, opp, state) {
  if (!side.aaActive || side.hero.dead) {
    if (side.hero.dead) {
      side.aaActive = false;
      side.targetId = 0; side.targetType = ''; side.targetX = 0; side.targetZ = 0;
    }
    return null;
  }
  let target = resolveTargetEntity(side, opp, state);
  let isMonster = side.targetType === 'monster';
  let isHero = side.targetType === 'hero';
  if (target) {
    const d = Math.hypot(target.x - side.hero.x, target.z - side.hero.z);
    if (d > HERO_ATTACK_RANGE) target = null;
  }
  if (!target) {
    const t = findClosestHostile(side, opp, side.hero.x, side.hero.z, HERO_ATTACK_RANGE, state);
    if (t) {
      target = t.entity;
      isMonster = !!t.isMonster;
      isHero = !!t.isHero;
      if (isHero) {
        side.targetId = 0;
        side.targetType = 'hero';
      } else {
        side.targetId = target.id;
        side.targetType = isMonster ? 'monster' : 'creep';
      }
    } else {
      side.targetId = 0; side.targetType = ''; side.targetX = 0; side.targetZ = 0;
      return null;
    }
  }
  side.targetX = target.x;
  side.targetZ = target.z;
  return { entity: target, isMonster, isHero };
}

function updateHeroAttack(state, side, opp, dt) {
  side.attackCd = Math.max(0, side.attackCd - dt);
  if (side.hero.dead || !side.aaActive) return;
  const target = maintainTargetLock(side, opp, state);
  if (!target || side.attackCd > 0) return;
  side.attackCounter++;
  const isAoE = side.attackCounter % PASSIVE_EVERY === 0;
  const auraDmg = side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1;
  const auraAs = side.heroFountainAura ? FOUNTAIN_AS_MUL : 1;
  side.projectiles.push({
    id: state.nextEntityId++,
    x: side.hero.x, y: 1.5, z: side.hero.z,
    target: target.entity,
    targetIsMonster: !!target.isMonster,
    targetIsHero: !!target.isHero,
    targetSideIdx: target.isHero ? (3 - side.idx) : 0,
    damage: side.attackDmg * auraDmg, isAoE,
  });
  side.attackCd = HERO_ATTACK_INTERVAL / ((side.attackSpeedMul || 1) * auraAs);
}

function updateProjectiles(state, side, opp, dt) {
  for (let i = side.projectiles.length - 1; i >= 0; i--) {
    const p = side.projectiles[i];
    let targetAlive;
    let tp;
    if (p.targetIsHero) {
      const ts = state.sides[p.targetSideIdx];
      targetAlive = ts && !ts.hero.dead;
      tp = ts ? ts.hero : null;
    } else if (p.targetIsMonster) {
      targetAlive = side.monsters.includes(p.target);
      tp = p.target;
    } else {
      targetAlive = opp && opp.playerCreeps.includes(p.target);
      tp = p.target;
    }
    if (!targetAlive || !tp) { side.projectiles.splice(i, 1); continue; }
    const dx = tp.x - p.x, dy = (p.targetIsHero ? 1.0 : 0.9) - p.y, dz = tp.z - p.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.4) {
      const ix = tp.x, iz = tp.z;
      if (p.targetIsHero) {
        damageHero(state.sides[p.targetSideIdx], p.damage);
      } else {
        p.target.hp -= p.damage;
        if (p.target.hp <= 0) {
          if (p.targetIsMonster) {
            const k = side.monsters.indexOf(p.target);
            if (k >= 0) killMonster(side, k, side);
          } else {
            const k = opp.playerCreeps.indexOf(p.target);
            if (k >= 0) { opp.playerCreeps.splice(k, 1); side.gold += minionBounty(p.target); gainXp(side, minionXp(p.target)); }
          }
        }
      }
      if (p.isAoE) {
        for (let k = side.monsters.length - 1; k >= 0; k--) {
          const m = side.monsters[k];
          if (m === p.target) continue;
          if (Math.hypot(m.x - ix, m.z - iz) < PASSIVE_AOE_RADIUS) {
            m.hp -= p.damage;
            if (m.hp <= 0) killMonster(side, k, side);
          }
        }
        if (opp) for (let k = opp.playerCreeps.length - 1; k >= 0; k--) {
          const c = opp.playerCreeps[k];
          if (c === p.target) continue;
          if (Math.hypot(c.x - ix, c.z - iz) < PASSIVE_AOE_RADIUS) {
            c.hp -= p.damage;
            if (c.hp <= 0) { opp.playerCreeps.splice(k, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
          }
        }
      }
      side.projectiles.splice(i, 1);
      continue;
    }
    const step = PROJECTILE_SPEED * dt;
    p.x += (dx / dist) * step;
    p.y += (dy / dist) * step;
    p.z += (dz / dist) * step;
  }
}

function castEldklot(state, sideIdx, dirX, dirZ) {
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.q.cd > 0) return;
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.01) { dirX = side.hero.facingX; dirZ = side.hero.facingZ; }
  else { dirX /= len; dirZ /= len; }
  side.skills.q.cd = side.skills.q.max;
  side.fireballs.push({
    id: state.nextEntityId++,
    x: side.hero.x, y: 1.0, z: side.hero.z,
    dx: dirX, dz: dirZ,
    hit: new Set(),
    traveled: 0,
    damage: ELDKLOT_DAMAGE * (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1),
  });
}

function updateFireballs(state, side, opp, dt) {
  for (let i = side.fireballs.length - 1; i >= 0; i--) {
    const f = side.fireballs[i];
    const step = ELDKLOT_SPEED * dt;
    f.x += f.dx * step; f.z += f.dz * step;
    f.traveled += step;
    for (let j = side.monsters.length - 1; j >= 0; j--) {
      const m = side.monsters[j];
      if (f.hit.has(m)) continue;
      const d = Math.hypot(m.x - f.x, m.z - f.z);
      if (d < ELDKLOT_RADIUS + 0.45) {
        f.hit.add(m);
        m.hp -= f.damage;
        if (m.hp <= 0) killMonster(side, j, side);
      }
    }
    // Duel: hit opp.hero med Eldklot om i radie
    if (state.duelActive && opp && !opp.hero.dead && !f.hit.has('opp-hero')) {
      const d = Math.hypot(opp.hero.x - f.x, opp.hero.z - f.z);
      if (d < ELDKLOT_RADIUS + 0.5) {
        f.hit.add('opp-hero');
        damageHero(opp, f.damage);
      }
    }
    if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
      const c = opp.playerCreeps[j];
      if (f.hit.has(c)) continue;
      const d = Math.hypot(c.x - f.x, c.z - f.z);
      if (d < ELDKLOT_RADIUS + 0.45) {
        f.hit.add(c);
        c.hp -= f.damage;
        if (c.hp <= 0) { opp.playerCreeps.splice(j, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
      }
    }
    if (f.traveled > ELDKLOT_RANGE) side.fireballs.splice(i, 1);
  }
}

function castFrostnova(state, sideIdx) {
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.f.cd > 0) return;
  side.skills.f.cd = side.skills.f.max;
  side.novaEffects.push({
    id: state.nextEntityId++,
    x: side.hero.x, z: side.hero.z,
    life: 0.6, maxLife: 0.6,
  });
  const novaDmg = NOVA_DAMAGE * (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1);
  for (let j = side.monsters.length - 1; j >= 0; j--) {
    const m = side.monsters[j];
    if (Math.hypot(m.x - side.hero.x, m.z - side.hero.z) < NOVA_RADIUS) {
      m.hp -= novaDmg;
      m.slowMul = NOVA_SLOW_MUL;
      m.slowTime = NOVA_SLOW_TIME;
      if (m.hp <= 0) killMonster(side, j, side);
    }
  }
  const opp = state.sides[3 - sideIdx];
  if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
    const c = opp.playerCreeps[j];
    if (Math.hypot(c.x - side.hero.x, c.z - side.hero.z) < NOVA_RADIUS) {
      c.hp -= novaDmg;
      if (c.hp <= 0) { opp.playerCreeps.splice(j, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
    }
  }
  // Duel: nova träffar opp.hero om i radie
  if (state.duelActive && opp && !opp.hero.dead) {
    if (Math.hypot(opp.hero.x - side.hero.x, opp.hero.z - side.hero.z) < NOVA_RADIUS) {
      damageHero(opp, novaDmg);
    }
  }
}

function updateNovaEffects(side, dt) {
  for (let i = side.novaEffects.length - 1; i >= 0; i--) {
    const n = side.novaEffects[i];
    n.life -= dt;
    if (n.life <= 0) side.novaEffects.splice(i, 1);
  }
}

function castBlink(state, sideIdx, dirX, dirZ) {
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.e.cd > 0) return;
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.01) { dirX = side.hero.facingX; dirZ = side.hero.facingZ; }
  else { dirX /= len; dirZ /= len; }
  let dist = BLINK_RANGE, nx, nz;
  while (dist >= 0.5) {
    nx = side.hero.x + dirX * dist;
    nz = side.hero.z + dirZ * dist;
    if (isHeroWalkable(side.idx, nx, nz)) break;
    dist -= 0.5;
  }
  if (dist < 0.5) return;
  side.skills.e.cd = side.skills.e.max;
  side.hero.x = nx; side.hero.z = nz;
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
  const check = side.inDuel ? isArenaWalkable : (x, z) => isHeroWalkable(side.idx, x, z);
  if (check(nx, nz)) { side.hero.x = nx; side.hero.z = nz; }
  else if (check(nx, side.hero.z)) side.hero.x = nx;
  else if (check(side.hero.x, nz)) side.hero.z = nz;
}

function tickIncome(side, dt) {
  side.incomeTimer += dt;
  while (side.incomeTimer >= INCOME_INTERVAL) {
    side.incomeTimer -= INCOME_INTERVAL;
    side.gold += side.income;
    side.incomeTickCount = (side.incomeTickCount || 0) + 1;
  }
}

function applyEvent(state, sideIdx, ev) {
  const side = state.sides[sideIdx];
  if (!side) return;
  if (ev.type === 'cheat') {
    if (ev.cmd === 'gold' && typeof ev.amount === 'number') {
      const amt = Math.max(0, Math.min(10_000_000, Math.floor(ev.amount)));
      side.gold += amt;
    }
    return;
  }
  if (ev.type === 'hero-pick') {
    if (state.phase !== 'pick') return;
    if (typeof ev.heroId === 'string' && ev.heroId.length < 32) {
      side.heroId = ev.heroId;
      side.heroPickConfirmed = false; // ändrade val — unconfirm
    }
    return;
  }
  if (ev.type === 'hero-confirm') {
    if (state.phase !== 'pick') return;
    side.heroPickConfirmed = true;
    return;
  }
  if (ev.type === 'aa') {
    if (side.hero.dead) return;
    const opp = state.sides[3 - sideIdx];
    side.aaActive = true;
    // Lock omedelbart på närmaste fiende (om någon i range)
    const t = findClosestHostile(side, opp, side.hero.x, side.hero.z, HERO_ATTACK_RANGE);
    if (t) {
      side.targetId = t.entity.id;
      side.targetType = t.isMonster ? 'monster' : 'creep';
      side.targetX = t.entity.x;
      side.targetZ = t.entity.z;
    } else {
      side.targetId = 0; side.targetType = ''; side.targetX = 0; side.targetZ = 0;
    }
    return;
  }
  if (ev.type === 'aa-cancel') {
    side.aaActive = false;
    side.targetId = 0; side.targetType = ''; side.targetX = 0; side.targetZ = 0;
    return;
  }
  if (ev.type === 'skill') {
    // Om tap (ingen dx/dz), använd target som aim. Annars använd givet drag-riktning.
    let dx = ev.dx, dz = ev.dz;
    const useTargetAim = (ev.tap === true) && side.targetId;
    if (useTargetAim) {
      const opp = state.sides[3 - sideIdx];
      const t = resolveTargetEntity(side, opp);
      if (t) {
        const ddx = t.x - side.hero.x, ddz = t.z - side.hero.z;
        const m = Math.hypot(ddx, ddz);
        if (m > 0.01) { dx = ddx / m; dz = ddz / m; }
      }
    }
    if (ev.key === 'q') castEldklot(state, sideIdx, dx, dz);
    else if (ev.key === 'f') castFrostnova(state, sideIdx);
    else if (ev.key === 'e') castBlink(state, sideIdx, dx, dz);
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
      if (def.variants && (!ev.variant || !def.variants[ev.variant])) return;
      if (side.inventory.length >= INVENTORY_SLOTS) return;
      if (side.gold < ITEM_BUY_COST) return;
      side.gold -= ITEM_BUY_COST;
      const entry = { itemId: ev.item, level: 1, activeRemaining: 0, activeCd: 0 };
      if (def.variants && ev.variant) entry.variantId = ev.variant;
      side.inventory.push(entry);
    } else {
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
    spawnMinion(state, side, ev.minionType, ev.lane);
  } else if (ev.kind === 'unlock') {
    const tier = ev.tier;
    if (!TIER_UNLOCK_COST[tier] || side.tierUnlocks[tier]) return;
    for (let t = 2; t < tier; t++) if (!side.tierUnlocks[t]) return;
    const cost = TIER_UNLOCK_COST[tier];
    if (side.gold < cost) return;
    side.gold -= cost;
    side.tierUnlocks[tier] = true;
  }
}

// === Duel-system ===
function startDuel(state) {
  state.duelActive = true;
  state.duelMatchTimer = DUEL_DURATION;
  state.duelAnnounceTimer = 0;
  // Teleportera båda hjältar in i arenan, full HP, rensa CD och projektiler
  const positions = [
    { x: ARENA_CX - 5, z: ARENA_CZ },         // side 1: västra sidan
    { x: ARENA_CX + 5, z: ARENA_CZ },         // side 2: östra sidan
  ];
  for (const idx of [1, 2]) {
    const s = state.sides[idx];
    if (!s) continue;
    const p = positions[idx - 1];
    s.hero.x = p.x;
    s.hero.z = p.z;
    s.hero.hp = s.hero.maxHp;
    s.hero.dead = false;
    s.hero.respawnTimer = 0;
    s.hero.facingX = (idx === 1 ? 1 : -1);
    s.hero.facingZ = 0;
    s.attackCd = 0;
    s.aaActive = false;
    s.targetId = 0; s.targetType = ''; s.targetX = 0; s.targetZ = 0;
    s.skills.q.cd = 0;
    s.skills.f.cd = 0;
    s.skills.e.cd = 0;
    s.projectiles = [];
    s.fireballs = [];
    s.novaEffects = [];
    s.inDuel = true;
    s.heroFountainAura = false;
  }
}

function endDuel(state) {
  const s1 = state.sides[1], s2 = state.sides[2];
  let winnerIdx = 0;
  if (s1 && s2) {
    const a = !s1.hero.dead, b = !s2.hero.dead;
    if (a && !b) winnerIdx = 1;
    else if (b && !a) winnerIdx = 2;
    else if (a && b) {
      // Timeout — högre HP% vinner
      const hp1 = s1.hero.hp / s1.hero.maxHp;
      const hp2 = s2.hero.hp / s2.hero.maxHp;
      if (hp1 > hp2 + 0.01) winnerIdx = 1;
      else if (hp2 > hp1 + 0.01) winnerIdx = 2;
      // annars tie (0)
    }
  }
  state.duelCount += 1;
  state.duelLastWinner = winnerIdx;
  state.duelAnnounceTimer = DUEL_ANNOUNCE_TIME;
  if (winnerIdx > 0) {
    const winner = state.sides[winnerIdx];
    const rewardIdx = Math.min(state.duelCount - 1, DUEL_REWARDS_GOLD.length - 1);
    winner.gold += DUEL_REWARDS_GOLD[rewardIdx];
    // Level-up belöning (Fas 5 hanterar lvl 30 → hero-kopia istället)
    if (winner.level < MAX_LEVEL) {
      winner.level += 1;
      winner.xp = 0;
      winner.xpToNext = winner.level >= MAX_LEVEL ? 0 : xpForLevel(winner.level);
      recomputeSideStats(winner);
    }
    // TODO Fas 5: om winner.level >= MAX_LEVEL, spawna hero-kopia på fiendens lane
  }
  // Teleportera tillbaka till baserna, full HP, rensa allt duel-rest
  for (const idx of [1, 2]) {
    const s = state.sides[idx];
    if (!s) continue;
    const cfg = SIDE_CFG[idx];
    s.hero.x = cfg.heroSpawn.x;
    s.hero.z = cfg.heroSpawn.z;
    s.hero.hp = s.hero.maxHp;
    s.hero.dead = false;
    s.hero.respawnTimer = 0;
    s.attackCd = 0;
    s.aaActive = false;
    s.targetId = 0; s.targetType = ''; s.targetX = 0; s.targetZ = 0;
    s.projectiles = [];
    s.fireballs = [];
    s.novaEffects = [];
    s.inDuel = false;
  }
  state.duelActive = false;
  state.duelMatchTimer = 0;
  // Nästa duel om vi inte nått max
  state.duelTimer = state.duelCount < DUEL_MAX_COUNT ? DUEL_INTERVAL : Infinity;
}

function tickGame(state, dt) {
  if (state.matchState.gameOver) return;
  // Hero pick-fas: bara timer + transition. Inga waves/monsters under denna fas.
  if (state.phase === 'pick') {
    state.pickTimer = Math.max(0, state.pickTimer - dt);
    const s1 = state.sides[1], s2 = state.sides[2];
    const bothConfirmed = s1.heroPickConfirmed && s2.heroPickConfirmed;
    const timeUp = state.pickTimer <= 0;
    if (bothConfirmed || timeUp) {
      state.phase = 'game';
      state.duelTimer = DUEL_INTERVAL;
      recomputeSideStats(s1);
      recomputeSideStats(s2);
    }
    return;
  }
  // Tick announce timer (vinnar-banner efter duel)
  if (state.duelAnnounceTimer > 0) state.duelAnnounceTimer = Math.max(0, state.duelAnnounceTimer - dt);
  // Duel-fas: bara hero-kombat, hoppa över wave/monster/creep/income
  if (state.duelActive) {
    // Movement
    for (const sideIdx of [1, 2]) {
      const side = state.sides[sideIdx];
      const j = state.lastInputs[sideIdx].j;
      if (j) applyMovement(side, j.x, j.z, dt);
    }
    // Hero-attacker (mot opp.hero, hanteras i findClosestHostile när state.duelActive)
    for (const sideIdx of [1, 2]) {
      const side = state.sides[sideIdx];
      const opp = state.sides[3 - sideIdx];
      updateSkillCooldowns(side, dt);
      if (!side.hero.dead) updateHeroAttack(state, side, opp, dt);
      updateProjectiles(state, side, opp, dt);
      updateFireballs(state, side, opp, dt);
      updateNovaEffects(side, dt);
      updateActiveBuffs(side, dt);
    }
    // Duel match timer
    state.duelMatchTimer = Math.max(0, state.duelMatchTimer - dt);
    const s1 = state.sides[1], s2 = state.sides[2];
    const someoneDead = s1.hero.dead || s2.hero.dead;
    if (someoneDead || state.duelMatchTimer <= 0) endDuel(state);
    return;
  }
  // Triggern: är det dags för nästa duel?
  if (state.duelCount < DUEL_MAX_COUNT && state.duelTimer > 0) {
    state.duelTimer = Math.max(0, state.duelTimer - dt);
    if (state.duelTimer <= 0) {
      startDuel(state);
      return;
    }
  }
  for (const sideIdx of [1, 2]) {
    const side = state.sides[sideIdx];
    if (side.hero.dead) {
      side.hero.respawnTimer -= dt;
      if (side.hero.respawnTimer <= 0) respawnHero(side);
    }
  }
  for (const sideIdx of [1, 2]) {
    const side = state.sides[sideIdx];
    const j = state.lastInputs[sideIdx].j;
    if (j) applyMovement(side, j.x, j.z, dt);
  }
  // Fontän-aura: räkna ut per sida innan andra updates (så regen + buff appliceras hela ticket)
  for (const sideIdx of [1, 2]) {
    const side = state.sides[sideIdx];
    const cfg = SIDE_CFG[sideIdx];
    if (side.hero.dead) {
      side.heroFountainAura = false;
    } else {
      const dx = side.hero.x - cfg.tower.x;
      const dz = side.hero.z - cfg.tower.z;
      side.heroFountainAura = (dx * dx + dz * dz) < FOUNTAIN_AURA_RADIUS_SQ;
      if (side.heroFountainAura && side.hero.hp < side.hero.maxHp) {
        side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + FOUNTAIN_AURA_REGEN * dt);
      }
    }
  }
  for (const sideIdx of [1, 2]) {
    const side = state.sides[sideIdx];
    const opp = state.sides[3 - sideIdx];
    updateSkillCooldowns(side, dt);
    updateWaves(state, side, dt);
    updateMonsters(state, side, opp, dt);
    updatePlayerCreeps(state, side, opp, dt);
    updateCreepProjectiles(state, side, opp, dt);
    if (!side.hero.dead) updateHeroAttack(state, side, opp, dt);
    updateProjectiles(state, side, opp, dt);
    updateFireballs(state, side, opp, dt);
    updateNovaEffects(side, dt);
    updateActiveBuffs(side, dt);
    tickIncome(side, dt);
  }
  checkMatchEnd(state);
}

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
    fa: side.heroFountainAura ? 1 : 0,
    aa: side.aaActive ? 1 : 0,
    tg: side.targetId || 0,
    tt: side.targetType || '',
    tx: side.targetX || 0,
    tz: side.targetZ || 0,
    lv: side.level || 1,
    xp: side.xp || 0,
    xpN: side.xpToNext || 0,
    hid: side.heroId || 'magiker',
    hpc: side.heroPickConfirmed ? 1 : 0,
    sk: { q: side.skills.q.cd, f: side.skills.f.cd, e: side.skills.e.cd },
    w: { c: side.wave.current, a: side.wave.active, bt: side.wave.betweenTimer },
    M: side.monsters.map(m => ({ id: m.id, x: m.x, z: m.z, ry: m.ry, hp: m.hp, mh: 10 })),
    C: side.playerCreeps.map(c => ({ id: c.id, typeId: c.typeId, x: c.x, z: c.z, ry: c.ry, hp: c.hp, mh: c.maxHp })),
    F: side.fireballs.map(f => ({ id: f.id, x: f.x, y: f.y, z: f.z })),
    P: side.projectiles.map(p => ({ id: p.id, x: p.x, y: p.y, z: p.z, aoe: p.isAoE })),
    N: side.novaEffects.map(n => ({ id: n.id, x: n.x, z: n.z, life: n.life / n.maxLife })),
    CP: side.creepProjectiles.map(p => ({ id: p.id, x: p.x, y: p.y, z: p.z, kind: p.kind })),
  };
}

function serializeState(state) {
  return {
    t: 'st',
    m: { o: state.matchState.gameOver, win: state.matchState.winner },
    s: { 1: serializeSide(state.sides[1]), 2: serializeSide(state.sides[2]) },
    ph: state.phase || 'game',
    pT: +(state.pickTimer || 0).toFixed(1),
    dA: state.duelActive ? 1 : 0,
    dT: +(state.duelTimer === Infinity ? 0 : (state.duelTimer || 0)).toFixed(1),
    dM: +(state.duelMatchTimer || 0).toFixed(1),
    dC: state.duelCount || 0,
    dW: state.duelLastWinner || 0,
    dAn: +(state.duelAnnounceTimer || 0).toFixed(2),
  };
}

module.exports = {
  createGameState,
  tickGame,
  serializeState,
  applyEvent,
};
