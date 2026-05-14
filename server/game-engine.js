'use strict';

// =============================================================
// Pure simulation engine för Hero Line Warz (Node-side, server-auth).
// Inga Three.js-beroenden — entiteter använder { x, z, ry } direkt.
// Måste hållas i synk med simuleringen i src/main.js (solo-mode).
// =============================================================

// === Hero & melee-konstanter ===
const HERO_R = 0.45;
const TOWER_R = 1.6;
// Bas-värden (används som fallback om heroId saknar def). Per-hero stats i HERO_DEFS.
const HERO_MAX_HP = 100;
const HERO_BASE_MOVE_SPEED = 6;
const HERO_BASE_ATTACK_DMG = 5;
const HERO_ATTACK_RANGE = 4.0;
const HERO_ATTACK_INTERVAL = 1.0;
const PROJECTILE_SPEED = 18;

// Hero-definitioner (per-hero baseline stats). Skill-mekanik delas tills user byter.
const HERO_DEFS = {
  magiker: {
    name: 'Gandulf',
    baseHp: 100,
    baseDmg: 5,
    attackRange: 4.0,
    attackInterval: 1.0,
    baseMoveSpeed: 6.0,
  },
  legolas: {
    name: 'Legolus',
    baseHp: 85,           // glass-cannon
    baseDmg: 6,           // mer per AA
    attackRange: 6.0,     // längre räckvidd än Gandulf (4.0)
    attackInterval: 0.7,  // snabbare AA än Gandulf (1.0)
    baseMoveSpeed: 7.0,   // snabbare än Gandulf (6.0)
  },
  gimlu: {
    name: 'Gimlu',
    baseHp: 140,          // tank
    baseDmg: 7,           // hård träff
    attackRange: 2.5,     // melee-räckvidd
    attackInterval: 1.2,  // tung yxa, långsam
    baseMoveSpeed: 5.0,   // långsam
  },
};
function heroDef(heroId) { return HERO_DEFS[heroId] || HERO_DEFS.magiker; }
const PASSIVE_EVERY = 4;
const PASSIVE_AOE_RADIUS = 2.0;

const MONSTER_AGGRO_RANGE = 5.0;
const MONSTER_LEASH_RANGE = 7.5;
const TOWER_REACH = 2.3;
const MONSTER_MELEE_DAMAGE = 8;       // fallback om monster saknar damage
const MONSTER_MELEE_INTERVAL = 1.0;
const GOLD_PER_KILL = 5;
const RESPAWN_TIME = 5.0;

// === Wave-system (50 waves, boss var 10:e) ===
const MAX_WAVES = 50;
const INITIAL_PREP_TIME = 10;          // sek innan wave 1
const WAVE_GAP_TIME = 10;              // sek mellan waves
const WAVE_COUNT_PER_LANE = 10;        // 10 per lane = 20 totalt
const WAVE_CLUMP_COLS_Z = [-1.5, 0, 1.5]; // 3 kolumner inom lane-bredden
const WAVE_CLUMP_ROW_SPACING = 1.0;       // m mellan rader bakåt
const WAVE_NAMES = ['Soldiers', 'Knights', 'Berserkers', 'Demons', 'Drakätt'];
const BOSS_NAMES = ['Captain', 'General', 'Warlord', 'Demon Prince', 'Drakkonungen'];
// Per 10 waves: 5 melee, 3 mix, 2 range. Boss räknas som melee (singel-spawn).
// Index 0..9 = wave (n-1) % 10
const WAVE_TYPE_PATTERN = ['melee', 'mix', 'range', 'melee', 'mix', 'melee', 'range', 'melee', 'mix', 'boss'];
// Range-monster har längre attack-range, långsammare AA-interval, lägre HP, slow speed.
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
    waveType,                            // 'melee' | 'mix' | 'range'
    count: WAVE_COUNT_PER_LANE * 2,
    monsterHp: Math.round(10 + tierIdx * 12 + inTier * 1.5),
    monsterDmg: Math.round((8 + tierIdx * 4 + inTier * 0.6) * 10) / 10,
    monsterSpeed: 2.0 + tierIdx * 0.05,
  };
}

const CREEP_VS_CREEP_DAMAGE = 5;
const CREEP_VS_CREEP_RANGE = 1.5;
const CREEP_VS_CREEP_INTERVAL = 1.5;

// Gandulf-skills (omgjorda)
// Fire Wave (Q): triangulär cone framför hero. Direkt dmg + 3s DoT.
const FIREWAVE_LENGTH = 5;                 // halverad räckvidd
const FIREWAVE_HALF_ANGLE = Math.PI / 4;   // 45° → 90° total cone
const FIREWAVE_DIRECT_DMG = 18;
const FIREWAVE_DOT_DPS = 6;
const FIREWAVE_DOT_DURATION = 3.0;
const FIREWAVE_EFFECT_LIFE = 0.6;          // hur länge cone-mesh visas på klienten
// Frost Nova (F): target-AoE freeze + shatter
const NOVA_RADIUS = 3.8;
const NOVA_DAMAGE = 10;
const NOVA_FREEZE_TIME = 2.0;
const NOVA_CAST_DISTANCE = 6;              // drag-räckvidd
const SHATTER_RADIUS = 2.5;
const SHATTER_DAMAGE = 15;
// Legolus-skills
const VINE_TRAP_RADIUS = 3.0;
const VINE_TRAP_DURATION = 3.0;
const VINE_TRAP_DOT_DPS = 8;
const VINE_TRAP_CAST_DISTANCE = 7;
const VINE_TRAP_ROOT_REFRESH = 0.25;     // håller frozenTime hög så länge i zonen
const LEGOLUS_BUFF_DURATION = 5.0;
const LEGOLUS_BUFF_DMG_PCT = 0.10;
const LEGOLUS_BUFF_CRIT_PCT = 0.10;
const LEGOLUS_BUFF_CRIT_DMG_PCT = 0.30;  // +30% crit damage (extra ovanpå 2x default)
const LEGOLUS_DASH_DISTANCE = 4.0;
const LEGOLUS_DASH_LIFESTEAL = 0.20;
// Passive: var 3:e AA → nästa AA är split + poison
const LEGOLUS_PASSIVE_EVERY = 3;
const LEGOLUS_SPLIT_EXTRAS = 2;
const LEGOLUS_SPLIT_RANGE = 6;     // hur långt extra targets kan vara från hero
const POISON_DURATION = 4.0;
const POISON_BASE_DPS = 5;         // per stack baseline
// Gimlu
const TAUNT_RADIUS = 5.5;
const TAUNT_DURATION = 3.0;
const TAUNT_DMG_REDUCTION = 0.30;       // 30% mindre skada
const TAUNT_HEAL_PCT = 0.20;            // 20% av skada som tas tillbaka
const TAUNT_HEAL_PER_SEC = 0.20;        // 10% maxHP per 0.5s = 20%/sek passiv heal
const IRON_WILL_DURATION = 3.0;
const IRON_WILL_EXPLOSION_RADIUS = 6.0;
const HAMMER_SPEED = 12;
const HAMMER_RANGE = 9;
const HAMMER_RADIUS = 0.8;
const HAMMER_DAMAGE = 25;
const HAMMER_LIFESTEAL = 0.50;
const HAMMER_RETURN_DMG_MUL = 0.5;
// Gimlu passive trösklar (Stalwart Resolve)
const GIMLU_PASSIVE_TIER1_HP = 0.80;   // <80% → 20% DR
const GIMLU_PASSIVE_TIER1_DR = 0.20;
const GIMLU_PASSIVE_TIER2_HP = 0.60;   // <60% → +5%/s regen
const GIMLU_PASSIVE_TIER2_REGEN = 0.05;
const GIMLU_PASSIVE_TIER3_HP = 0.40;   // <40% → +20% mer DR (40% totalt) + var 3:e dmg immun
const GIMLU_PASSIVE_TIER3_DR = 0.20;
const GIMLU_PASSIVE_IMMUNE_EVERY = 3;
// Gandulf passive (Arcane Convergence)
const GANDULF_BUFF_DURATION = 3.0;
const GANDULF_BUFF_SKILL_DMG_PER_STACK = 0.05;  // 5% skill-dmg per enemy hit (3s)
const GANDULF_SHIELD_PER_HIT_PCT = 0.05;        // +5% maxHP shield per enemy hit
const GANDULF_SHIELD_HITS = 3;
const GANDULF_SHIELD_PCT = 0.30;                // 30% av maxHP
// Black Hole (E): target-AoE pull + explosion vid slutet
const BLACKHOLE_RADIUS = 3.5;
const BLACKHOLE_PULL_SPEED = 2.5;
const BLACKHOLE_DURATION = 3.0;
const BLACKHOLE_EXPLOSION_RADIUS = 4.0;
const BLACKHOLE_EXPLOSION_DMG = 30;
const BLACKHOLE_CAST_DISTANCE = 8;
// Bakåtkompabilitet med tidigare konstanter (används av hero-copy etc)
const ELDKLOT_DAMAGE = FIREWAVE_DIRECT_DMG;
const ELDKLOT_RANGE = FIREWAVE_LENGTH;
const ELDKLOT_RADIUS = 0.6;
const ELDKLOT_SPEED = 16;
const NOVA_SLOW_MUL = 0.6;
const NOVA_SLOW_TIME = 2.0;
const TOWER_MAX_HP = 50;

// Fontän-aura: hero inom radius av egen fontän får regen + buff på output/defense/CDR/AS
const FOUNTAIN_AURA_RADIUS = 4.5;
const FOUNTAIN_AURA_RADIUS_SQ = FOUNTAIN_AURA_RADIUS * FOUNTAIN_AURA_RADIUS;
const FOUNTAIN_AURA_REGEN_PCT = 0.02; // 2% av maxHp per sekund
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
const ARENA_RADIUS = 14.4;   // 12 × 1.2 — 20% större duel-arena
const ARENA_VISUAL_RADIUS = ARENA_RADIUS;  // för klienten
// Special-orb i duel-arenan (matchar arena1v1 orb-konceptet)
const DUEL_BIG_ORB_MAX_HP = 100;
const DUEL_BIG_ORB_RESPAWN = 15;
const DUEL_BIG_ORB_HEAL_PCT = 0.30;
const DUEL_BIG_ORB_SHIELD_PCT = 0.30;
// Duel pickup orbs
const DUEL_ORB_HEAL_PCT = 0.15;            // 15% av maxHP
const DUEL_ORB_SPEED_BONUS = 0.30;         // +30% movement speed
const DUEL_ORB_SPEED_DURATION = 1.0;       // sek
const DUEL_ORB_COUNT_PER_TYPE = 3;
const DUEL_ORB_SPAWN_WINDOW = 30;          // alla orbs har spawnat inom 30s
const DUEL_ORB_PICKUP_RADIUS = 0.7;        // m
const DUEL_ORB_MIN_SPAWN = 0.5;            // sek tidigaste spawn-tid

// Hero-kopia (Fas 5): duel-belöning för max-level vinnare istället för level-up
const HERO_COPY_STAT_RATIO = 0.7;
const HERO_COPY_TOWER_DAMAGE = 10;
const HERO_COPY_ATTACK_RANGE = 4.0;
const HERO_COPY_ATTACK_INTERVAL = 1.2;
const HERO_COPY_SKILL_INTERVAL = 6.0; // hur ofta boten castar Eldklot
const HERO_COPY_AGGRO_RANGE = 5.5;
const HERO_COPY_RADIUS = 0.45;   // XP = creep.cost * 0.6

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
const bootsPctSlow = (level) => 0.10 * Math.pow(1.1, level - 1);
// Glove huvud-stats start på 10%, heal start på 1%. "Slow"-varianten halverar compound (1.1×).
const gloveBigPct = (level) => 0.10 * Math.pow(1.2, level - 1);
const gloveBigPctSlow = (level) => 0.10 * Math.pow(1.1, level - 1);
const gloveHealPct = (level) => 0.01 * Math.pow(1.2, level - 1);
const gloveHealPctSlow = (level) => 0.01 * Math.pow(1.1, level - 1);

const ITEM_TYPES = {
  item1: {
    id: 'item1', name: 'Boots',
    variants: {
      speed: {
        id: 'speed', name: 'Boots of Speed',
        statsAtLevel: (level) => ({ moveSpeedPct: bootsPct(level), attackSpeedPct: bootsPctSlow(level) }),
        activeAtMax: { duration: 5, cooldown: 30, stats: { moveSpeedPct: 0.5, attackSpeedPct: 0.5 } },
      },
      magic: {
        id: 'magic', name: 'Boots of Magic',
        statsAtLevel: (level) => ({ skillDmgPct: bootsPct(level), cdrPct: bootsPctSlow(level) }),
        activeAtMax: { duration: 5, cooldown: 30, stats: { skillDmgPct: 0.5, cdrPct: 0.5 } },
      },
      tank: {
        id: 'tank', name: 'Boots of Tank',
        statsAtLevel: (level) => ({ dmgReductionPct: bootsPct(level), maxHpPct: bootsPctSlow(level) }),
        activeAtMax: { duration: 5, cooldown: 30, stats: { dmgReductionPct: 0.5, maxHpPct: 0.5 } },
      },
    },
  },
  item2: {
    id: 'item2', name: 'Glove of Haste',
    variants: {
      haste: {
        id: 'haste', name: 'Glove of Haste',
        statsAtLevel: (level) => ({ attackSpeedPct: gloveBigPct(level), critChancePct: gloveBigPctSlow(level) }),
        activeAtMax: { duration: 5, cooldown: 30, stats: { attackSpeedPct: 0.5, critChancePct: 0.5 } },
      },
      spell: {
        id: 'spell', name: 'Glove of Spell',
        statsAtLevel: (level) => ({ skillDmgPct: gloveBigPct(level), cdrPct: gloveBigPctSlow(level) }),
        activeAtMax: { duration: 5, cooldown: 30, stats: { skillDmgPct: 0.5, cdrPct: 0.5 } },
      },
      tank: {
        id: 'tank', name: 'Glove of Tank',
        statsAtLevel: (level) => ({ dmgReductionPct: gloveBigPct(level), healPerSecPct: gloveHealPctSlow(level) }),
        activeAtMax: { duration: 5, cooldown: 30, stats: { dmgReductionPct: 0.5, healPerSecPct: 0.05 } },
      },
    },
  },
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
  // Lane-bounds är utvidgade bakåt (x ned till -45) så att monster-spawn-stagger
  // (15 i kolumn bakom portalen) ryms och de kan röra sig in i lanen.
  // Hero använder en smalare inLane via isHeroWalkable som inte ändras.
  const inLaneWide = (cz) => x >= -45 && x <= 11 && z >= cz - 2.85 && z <= cz + 2.85;
  return inLaneWide(12) || inLaneWide(4) || inLaneWide(-4) || inLaneWide(-12);
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
  const def = heroDef(side.heroId);
  side.attackRange = def.attackRange;
  side.attackInterval = def.attackInterval;
  let attackDmg = def.baseDmg;
  let moveSpeedFlat = def.baseMoveSpeed;
  let maxHpFlat = def.baseHp;
  let attackSpeedPct = 0, moveSpeedPct = 0, skillDmgPct = 0, cdrPct = 0, dmgReductionPct = 0, maxHpPct = 0;
  let critChancePct = 0, healPerSecPct = 0;
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
    critChancePct += s.critChancePct || 0;
    healPerSecPct += s.healPerSecPct || 0;
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
  side.critChancePct = Math.min(1, critChancePct);
  side.healPerSecPct = Math.max(0, healPerSecPct);
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

// Gandulf passive-helpers — buff/shield på skill-hit
function gandulfSkillDmgMul(side) {
  if (side.heroId !== 'magiker' || !(side.gandulfBuffRemaining > 0)) return 1;
  return 1 + (side.gandulfBuffStacks || 0) * GANDULF_BUFF_SKILL_DMG_PER_STACK;
}
function gandulfCdrMul(side) {
  // Kvar för bakåtkompabilitet — passive ger inte längre CDR
  return 1;
}
function onGandulfSkillHit(side, target) {
  if (side.heroId !== 'magiker') return;
  side.gandulfBuffStacks = (side.gandulfBuffStacks || 0) + 1;
  side.gandulfBuffRemaining = GANDULF_BUFF_DURATION;
  // +5% maxHP shield per hit (stackar additivt, capad på maxHP)
  side.shield = Math.min(side.hero.maxHp, (side.shield || 0) + side.hero.maxHp * GANDULF_SHIELD_PER_HIT_PCT);
  if (target && typeof target === 'object') {
    target.gandulfHits = (target.gandulfHits || 0) + 1;
    if (target.gandulfHits % GANDULF_SHIELD_HITS === 0) {
      const amt = side.hero.maxHp * GANDULF_SHIELD_PCT;
      side.shield = Math.max(side.shield || 0, amt);
    }
  }
}

function damageHero(side, amount) {
  if (side.hero.dead) return;
  // Gimlu passive Stalwart Resolve — tröskelbaserad DR + var 3:e instance immune vid <40%
  let gimluDR = 0;
  if (side.heroId === 'gimlu') {
    const ratio = side.hero.maxHp > 0 ? side.hero.hp / side.hero.maxHp : 1;
    if (ratio < GIMLU_PASSIVE_TIER1_HP) gimluDR += GIMLU_PASSIVE_TIER1_DR;
    if (ratio < GIMLU_PASSIVE_TIER3_HP) {
      gimluDR += GIMLU_PASSIVE_TIER3_DR;
      side.gimluDmgInstanceCount = (side.gimluDmgInstanceCount || 0) + 1;
      if (side.gimluDmgInstanceCount % GIMLU_PASSIVE_IMMUNE_EVERY === 0) return; // immune
    }
  }
  const gimluMul = gimluDR > 0 ? (1 - gimluDR) : 1;
  const auraMul = side.heroFountainAura ? FOUNTAIN_DMG_REDUCTION_MUL : 1;
  const tauntMul = (side.titansTauntRemaining || 0) > 0 ? (1 - TAUNT_DMG_REDUCTION) : 1;
  let final = amount * (side.dmgReductionMul ?? 1) * auraMul * tauntMul * gimluMul;
  // Gandulf shield absorberar först
  if ((side.shield || 0) > 0 && final > 0) {
    if (side.shield >= final) { side.shield -= final; final = 0; }
    else { final -= side.shield; side.shield = 0; }
  }
  side.hero.hp = Math.max(0, side.hero.hp - final);
  // Titans Taunt: heala tillbaka 20% av tagen skada
  if ((side.titansTauntRemaining || 0) > 0 && side.hero.hp > 0) {
    side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + final * TAUNT_HEAL_PCT);
  }
  // Iron Will: stacka tagen skada för senare explosion
  if ((side.ironWillRemaining || 0) > 0) {
    side.ironWillStored = (side.ironWillStored || 0) + final;
  }
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
    vineTraps: [],
    legolusBuffRemaining: 0,
    legolusDashBuffPending: false,
    critDmgMul: 2.0,         // base crit-multiplikator (kan justeras av buff)
    titansTauntRemaining: 0,
    ironWillRemaining: 0,
    ironWillStored: 0,
    hammers: [],
    ironWillExplosions: [],
    legolusAaCounter: 0,
    legolusSplitPending: false,
    gimluDmgInstanceCount: 0,
    gandulfBuffStacks: 0,
    gandulfBuffRemaining: 0,
    shield: 0,
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
    wave: {
      current: 0,
      active: false,
      betweenTimer: INITIAL_PREP_TIME,
      name: '',
      isBoss: false,
      bannerPulse: 0,             // ökas vid wave-start så klienten triggar banner
    },
    heroCopies: [],
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
    duelOrbs: [],              // aktiva pickup-orbs i arenan
    duelOrbQueue: [],          // orbs som väntar på att spawna (sorterad på t)
    duelArenaTime: 0,          // tid sedan duel startade (sek)
    duelOrbIdCounter: 0,
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
  const w = side.wave;
  // Slut: efter wave 50 + alla döda, inga fler waves
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
      spawnWaveAtOnce(state, side, def);
    }
    return;
  }
  // Wave aktiv tills alla monsters borta
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

function spawnWaveAtOnce(state, side, def) {
  if (def.isBoss) {
    spawnMonsterFromDef(state, side, 1, def, null, 'melee');
    return;
  }
  const cfg = SIDE_CFG[side.idx];
  for (const lane of [1, 2]) {
    const positions = clumpPositions(cfg.spawnX, cfg.laneZ[lane], WAVE_COUNT_PER_LANE);
    // Bestäm per-monster attackType baserat på wave-typ
    let melee, range;
    if (def.waveType === 'range') { melee = 0; range = WAVE_COUNT_PER_LANE; }
    else if (def.waveType === 'mix') { melee = Math.ceil(WAVE_COUNT_PER_LANE / 2); range = WAVE_COUNT_PER_LANE - melee; }
    else { melee = WAVE_COUNT_PER_LANE; range = 0; }
    let i = 0;
    for (; i < melee; i++) spawnMonsterFromDef(state, side, lane, def, positions[i], 'melee');
    for (let j = 0; j < range; j++) spawnMonsterFromDef(state, side, lane, def, positions[melee + j], 'range');
  }
}

function spawnMonsterFromDef(state, side, lane, def, pos, attackType) {
  const cfg = SIDE_CFG[side.idx];
  const x = pos ? pos.x : cfg.spawnX;
  const z = pos ? pos.z : cfg.laneZ[lane];
  const isRange = attackType === 'range';
  const hp = isRange ? Math.round(def.monsterHp * RANGE_MONSTER_HP_RATIO) : def.monsterHp;
  const speed = isRange ? def.monsterSpeed * RANGE_MONSTER_SPEED_RATIO : def.monsterSpeed;
  side.monsters.push({
    id: state.nextEntityId++,
    x, z,
    ry: 0,
    lane,
    hp, maxHp: hp,
    speed,
    damage: def.monsterDmg,
    attackType: attackType || 'melee',
    attackRange: isRange ? RANGE_MONSTER_RANGE : 1.2,
    attackInterval: isRange ? RANGE_MONSTER_INTERVAL : MONSTER_MELEE_INTERVAL,
    pathIndex: 0,
    atkCd: 0, slowTime: 0, slowMul: 1.0, chasing: false,
    isBoss: !!def.isBoss,
  });
}

function updateMonsters(state, side, opp, dt) {
  const heroX = side.hero.x, heroZ = side.hero.z;
  const heroAlive = !side.hero.dead;
  const towerPos = SIDE_CFG[side.idx].tower;
  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    // DoT-tick (Fire Wave)
    if ((m.dotRemaining || 0) > 0) {
      m.dotRemaining -= dt;
      m.hp -= (m.dotPerSec || 0) * dt;
      if (m.hp <= 0) { killMonster(side, i, side); continue; }
    }
    // Poison-stack-tick (Legolus passive)
    if ((m.poisonRemaining || 0) > 0 && (m.poisonStacks || 0) > 0) {
      m.poisonRemaining -= dt;
      const s = m.poisonStacks;
      m.hp -= POISON_BASE_DPS * s * (1 + 0.10 * (s - 1)) * dt;
      if (m.poisonRemaining <= 0) m.poisonStacks = 0;
      if (m.hp <= 0) { killMonster(side, i, side); continue; }
    }
    // Frusen: hoppa över movement + attack-cooldown
    if ((m.frozenTime || 0) > 0) {
      m.frozenTime -= dt;
      continue;
    }
    // Taunt: tvinga chase mot hero
    if ((m.tauntedTime || 0) > 0) {
      m.tauntedTime -= dt;
      m.chasing = true;
    }
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
    const atkRange = m.attackRange || 1.2;
    const atkInterval = m.attackInterval || MONSTER_MELEE_INTERVAL;
    if (heroAlive && distHero < atkRange && m.atkCd <= 0) {
      damageHero(side, m.damage || MONSTER_MELEE_DAMAGE);
      m.atkCd = atkInterval;
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
      // Range-monster stannar längre bort vid attackRange - 0.5; melee går nära
      const stopDist = m.attackType === 'range' ? Math.max(0.7, (m.attackRange || 4.5) - 0.5) : 0.7;
      if (distHero < stopDist) continue;
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
    // DoT-tick
    if ((c.dotRemaining || 0) > 0) {
      c.dotRemaining -= dt;
      c.hp -= (c.dotPerSec || 0) * dt;
      if (c.hp <= 0) { side.playerCreeps.splice(i, 1); continue; }
    }
    // Poison-stack-tick
    if ((c.poisonRemaining || 0) > 0 && (c.poisonStacks || 0) > 0) {
      c.poisonRemaining -= dt;
      const s = c.poisonStacks;
      c.hp -= POISON_BASE_DPS * s * (1 + 0.10 * (s - 1)) * dt;
      if (c.poisonRemaining <= 0) c.poisonStacks = 0;
      if (c.hp <= 0) { side.playerCreeps.splice(i, 1); continue; }
    }
    // Frusen: hoppa över movement/attack
    if ((c.frozenTime || 0) > 0) {
      c.frozenTime -= dt;
      continue;
    }
    // Taunt-tick: tvingar target = opp.hero (Gimlu)
    if ((c.tauntedTime || 0) > 0) c.tauntedTime -= dt;
    const tauntActive = (c.tauntedTime || 0) > 0;
    const dxT = oppCfg.tower.x - c.x, dzT = oppCfg.tower.z - c.z;
    if (dxT * dxT + dzT * dzT < TOWER_REACH * TOWER_REACH) {
      if (opp) opp.tower.hp = Math.max(0, opp.tower.hp - 1);
      side.playerCreeps.splice(i, 1);
      continue;
    }
    c.atkCd = Math.max(0, c.atkCd - dt);
    let target = null, targetType = null, bestDist = c.range;
    if (tauntActive && opp && !opp.hero.dead) {
      // Tauntad: lås till opp.hero (Gimlu) oavsett avstånd
      target = opp.hero; targetType = 'hero';
      bestDist = Math.hypot(opp.hero.x - c.x, opp.hero.z - c.z);
    } else {
      if (opp && !opp.hero.dead) {
        const d = Math.hypot(opp.hero.x - c.x, opp.hero.z - c.z);
        if (d < bestDist) { bestDist = d; target = opp.hero; targetType = 'hero'; }
      }
      if (opp) for (const m of opp.monsters) {
        const d = Math.hypot(m.x - c.x, m.z - c.z);
        if (d < bestDist) { bestDist = d; target = m; targetType = 'monster'; }
      }
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

// === Skill-effekter (DoT, freeze, shatter) ===
function applySkillDamageToMonster(state, side, opp, mIdx, dmg) {
  const m = side.monsters[mIdx];
  if (!m || m.hp <= 0) return;
  // Shatter: om frusen, splittra is och skicka shards
  if ((m.frozenTime || 0) > 0) {
    triggerShatter(state, side, opp, m.x, m.z, side);
    m.frozenTime = 0;
  }
  m.hp -= dmg;
  if (m.hp <= 0) killMonster(side, mIdx, side);
}
function applySkillDamageToCreep(state, attackerSide, oppSide, creep, dmg) {
  if (!creep || creep.hp <= 0) return;
  if ((creep.frozenTime || 0) > 0) {
    triggerShatter(state, oppSide, attackerSide, creep.x, creep.z, attackerSide);
    creep.frozenTime = 0;
  }
  creep.hp -= dmg;
}
function applySkillDamageToOppHero(state, side, opp, dmg) {
  if (!opp || opp.hero.dead) return;
  if ((opp.hero.frozenTime || 0) > 0) {
    triggerShatter(state, opp, side, opp.hero.x, opp.hero.z, side);
    opp.hero.frozenTime = 0;
  }
  damageHero(opp, dmg);
}
// Shatter spawnar mini-AoE som skadar närliggande monster + creeps + opp.hero
function triggerShatter(state, arenaSide, attackerSide, x, z, sourceSide) {
  // Lägg till en visuell shatter-effekt (returneras via novaEffects-liknande list)
  if (!sourceSide.shatters) sourceSide.shatters = [];
  sourceSide.shatters.push({ id: state.nextEntityId++, x, z, life: 0.5, maxLife: 0.5 });
  // Skada närliggande monsters i arenaSide
  if (arenaSide && arenaSide.monsters) {
    for (let i = arenaSide.monsters.length - 1; i >= 0; i--) {
      const m = arenaSide.monsters[i];
      if (Math.hypot(m.x - x, m.z - z) < SHATTER_RADIUS) {
        m.hp -= SHATTER_DAMAGE;
        if (m.hp <= 0) killMonster(arenaSide, i, sourceSide);
      }
    }
  }
  // Skada närliggande creeps i attackerSide (om arena är opp:s arena)
  if (attackerSide && attackerSide.playerCreeps) {
    for (let i = attackerSide.playerCreeps.length - 1; i >= 0; i--) {
      const c = attackerSide.playerCreeps[i];
      if (Math.hypot(c.x - x, c.z - z) < SHATTER_RADIUS) {
        c.hp -= SHATTER_DAMAGE;
        if (c.hp <= 0) { attackerSide.playerCreeps.splice(i, 1); sourceSide.gold += minionBounty(c); gainXp(sourceSide, minionXp(c)); }
      }
    }
  }
}

// Lös ut cast-mark (x,z) för target-baserade skills (Nova, Black Hole)
function resolveSkillGroundTarget(state, side, opp, ev, defaultDistance) {
  let tx, tz;
  // Tap + lock: använd target's position
  if (ev.tap === true && side.targetId) {
    const t = resolveTargetEntity(side, opp, state);
    if (t) { tx = t.x; tz = t.z; }
  }
  if (tx === undefined) {
    // Drag: dir × distance från hero
    let dx = ev.dx || 0, dz = ev.dz || 0;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) { dx = side.hero.facingX; dz = side.hero.facingZ; }
    else { dx /= len; dz /= len; }
    tx = side.hero.x + dx * defaultDistance;
    tz = side.hero.z + dz * defaultDistance;
  }
  // Clamp till arenan under duel så skills inte landar utanför
  if (state && state.duelActive) {
    const dx = tx - ARENA_CX, dz = tz - ARENA_CZ;
    const d = Math.hypot(dx, dz);
    const maxR = ARENA_RADIUS - 0.5;
    if (d > maxR) {
      tx = ARENA_CX + (dx / d) * maxR;
      tz = ARENA_CZ + (dz / d) * maxR;
    }
  }
  return { x: tx, z: tz };
}

function findClosestHostile(side, opp, x, z, maxDist, state) {
  let best = null, bestDist = maxDist;
  // Under duel: opp.hero OCH duel-big-orb är giltiga targets
  if (state && state.duelActive) {
    if (opp && !opp.hero.dead) {
      const d = Math.hypot(opp.hero.x - x, opp.hero.z - z);
      if (d < bestDist) { bestDist = d; best = { entity: opp.hero, isMonster: false, isHero: true, targetSideIdx: 3 - side.idx }; }
    }
    if (state.duelBigOrb && state.duelBigOrb.alive) {
      const d = Math.hypot(state.duelBigOrb.x - x, state.duelBigOrb.z - z);
      if (d < bestDist) { bestDist = d; best = { entity: state.duelBigOrb, isMonster: false, isHero: false, isDuelOrb: true }; }
    }
    return best;
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
  if (side.targetType === 'duelOrb') {
    if (state && state.duelActive && state.duelBigOrb && state.duelBigOrb.alive) return state.duelBigOrb;
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

// Damage på big duel-orb. Vid kill: belöna lastDamager med heal + shield.
function damageDuelBigOrb(state, amount, byIdx) {
  const orb = state.duelBigOrb;
  if (!orb || !orb.alive || amount <= 0) return;
  orb.hp -= amount;
  if (byIdx) orb.lastDamagerIdx = byIdx;
  if (orb.hp <= 0) {
    orb.hp = 0;
    orb.alive = false;
    orb.respawnTimer = DUEL_BIG_ORB_RESPAWN;
    const winner = state.sides[orb.lastDamagerIdx];
    if (winner && !winner.hero.dead) {
      const heal = winner.hero.maxHp * DUEL_BIG_ORB_HEAL_PCT;
      winner.hero.hp = Math.min(winner.hero.maxHp, winner.hero.hp + heal);
      const shield = winner.hero.maxHp * DUEL_BIG_ORB_SHIELD_PCT;
      winner.shield = Math.max(winner.shield || 0, shield);
    }
  }
}

function tickDuelBigOrb(state, dt) {
  const orb = state.duelBigOrb;
  if (!orb) return;
  if (orb.alive) return;
  orb.respawnTimer = Math.max(0, (orb.respawnTimer || 0) - dt);
  if (orb.respawnTimer <= 0) {
    orb.alive = true;
    orb.hp = orb.maxHp;
    orb.lastDamagerIdx = 0;
  }
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
  let isDuelOrb = side.targetType === 'duelOrb';
  const range = side.attackRange || HERO_ATTACK_RANGE;
  if (target) {
    const d = Math.hypot(target.x - side.hero.x, target.z - side.hero.z);
    if (d > range) target = null;
  }
  if (!target) {
    const t = findClosestHostile(side, opp, side.hero.x, side.hero.z, range, state);
    if (t) {
      target = t.entity;
      isMonster = !!t.isMonster;
      isHero = !!t.isHero;
      isDuelOrb = !!t.isDuelOrb;
      if (isHero) {
        side.targetId = 0;
        side.targetType = 'hero';
      } else if (isDuelOrb) {
        side.targetId = 0;
        side.targetType = 'duelOrb';
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
  return { entity: target, isMonster, isHero, isDuelOrb };
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
  // Legolus self-buff aktiv? +10% dmg, +10% crit, +30% crit-dmg
  const buffActive = (side.legolusBuffRemaining || 0) > 0;
  const buffDmgMul = buffActive ? (1 + LEGOLUS_BUFF_DMG_PCT) : 1;
  let critChance = (side.critChancePct || 0) + (buffActive ? LEGOLUS_BUFF_CRIT_PCT : 0);
  let critMulBase = (side.critDmgMul || 2.0) + (buffActive ? LEGOLUS_BUFF_CRIT_DMG_PCT : 0);
  // Legolus dash-buff aktiv? Nästa AA = 100% crit + 20% lifesteal
  const dashBuffed = !!side.legolusDashBuffPending;
  if (dashBuffed) {
    critChance = 1.0;
    side.legolusDashBuffPending = false;
  }
  const isCrit = critChance > 0 && Math.random() < critChance;
  const critMul = isCrit ? critMulBase : 1;
  // Legolus passive: var 3:e AA ger split-buff till nästa AA
  const isLegolusHero = side.heroId === 'legolas';
  const splitNow = isLegolusHero && !!side.legolusSplitPending;
  if (splitNow) side.legolusSplitPending = false;
  side.projectiles.push({
    id: state.nextEntityId++,
    x: side.hero.x, y: 1.5, z: side.hero.z,
    target: target.entity,
    targetIsMonster: !!target.isMonster,
    targetIsHero: !!target.isHero,
    targetIsDuelOrb: !!target.isDuelOrb,
    targetSideIdx: target.isHero ? (3 - side.idx) : 0,
    ownerSideIdx: side.idx,
    damage: side.attackDmg * auraDmg * buffDmgMul * critMul, isAoE, isCrit,
    lifestealRatio: dashBuffed ? LEGOLUS_DASH_LIFESTEAL : 0,
    legolusBuffed: dashBuffed,
    appliesPoison: splitNow,
  });
  // Split: skjut 2 extra projektiler mot närmaste andra fiender
  if (splitNow) {
    const extras = [];
    const seen = new Set([target.entity]);
    function tryAddNearest(list, isMonster) {
      const best = []; // upp till 2, sorterat efter dist
      for (const e of list) {
        if (seen.has(e)) continue;
        const d = Math.hypot(e.x - side.hero.x, e.z - side.hero.z);
        if (d > LEGOLUS_SPLIT_RANGE) continue;
        best.push({ e, d, isMonster });
      }
      best.sort((a, b) => a.d - b.d);
      for (const b of best) {
        if (extras.length >= LEGOLUS_SPLIT_EXTRAS) break;
        extras.push(b); seen.add(b.e);
      }
    }
    tryAddNearest(side.monsters, true);
    if (extras.length < LEGOLUS_SPLIT_EXTRAS && opp) tryAddNearest(opp.playerCreeps, false);
    for (const ex of extras) {
      side.projectiles.push({
        id: state.nextEntityId++,
        x: side.hero.x, y: 1.5, z: side.hero.z,
        target: ex.e,
        targetIsMonster: ex.isMonster,
        targetIsHero: false,
        targetSideIdx: 0,
        damage: side.attackDmg * auraDmg * buffDmgMul, isAoE: false, isCrit: false,
        lifestealRatio: 0,
        legolusBuffed: false,
        appliesPoison: true,
      });
    }
  }
  // Stega passive-räknaren efter att split konsumerats. Var 3:e AA → split-buff till nästa.
  if (isLegolusHero) {
    side.legolusAaCounter = (side.legolusAaCounter || 0) + 1;
    if (side.legolusAaCounter % LEGOLUS_PASSIVE_EVERY === 0) {
      side.legolusSplitPending = true;
    }
  }
  const interval = side.attackInterval || HERO_ATTACK_INTERVAL;
  side.attackCd = interval / ((side.attackSpeedMul || 1) * auraAs);
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
    } else if (p.targetIsDuelOrb) {
      targetAlive = state.duelBigOrb && state.duelBigOrb.alive;
      tp = state.duelBigOrb;
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
      let killedTarget = false;
      // Applicera poison-stack INNAN damage (om target dör räknas stacken inte)
      if (p.appliesPoison && !p.targetIsHero) {
        p.target.poisonStacks = (p.target.poisonStacks || 0) + 1;
        p.target.poisonRemaining = POISON_DURATION;
      } else if (p.appliesPoison && p.targetIsHero) {
        const ts = state.sides[p.targetSideIdx];
        if (ts && !ts.hero.dead) {
          ts.hero.poisonStacks = (ts.hero.poisonStacks || 0) + 1;
          ts.hero.poisonRemaining = POISON_DURATION;
        }
      }
      if (p.targetIsHero) {
        damageHero(state.sides[p.targetSideIdx], p.damage);
        if (state.sides[p.targetSideIdx] && state.sides[p.targetSideIdx].hero.dead) killedTarget = true;
      } else if (p.targetIsDuelOrb) {
        const orb = state.duelBigOrb;
        if (orb && orb.alive) {
          damageDuelBigOrb(state, p.damage, p.ownerSideIdx || side.idx);
          if (!orb.alive) killedTarget = true;
        }
      } else {
        p.target.hp -= p.damage;
        if (p.target.hp <= 0) {
          killedTarget = true;
          if (p.targetIsMonster) {
            const k = side.monsters.indexOf(p.target);
            if (k >= 0) killMonster(side, k, side);
          } else {
            const k = opp.playerCreeps.indexOf(p.target);
            if (k >= 0) { opp.playerCreeps.splice(k, 1); side.gold += minionBounty(p.target); gainXp(side, minionXp(p.target)); }
          }
        }
      }
      // Legolus dash-buffed AA: 20% lifesteal + reset dash-cd om kill
      if (p.lifestealRatio > 0 && !side.hero.dead) {
        side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + p.damage * p.lifestealRatio);
      }
      if (p.legolusBuffed && killedTarget) {
        side.skills.e.cd = 0;
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

// Fire Wave (Q): triangulär cone framför hero. Direkt dmg + DoT som varar 3s.
function castEldklot(state, sideIdx, dirX, dirZ) {
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.q.cd > 0) return;
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.01) { dirX = side.hero.facingX; dirZ = side.hero.facingZ; }
  else { dirX /= len; dirZ /= len; }
  side.skills.q.cd = side.skills.q.max * gandulfCdrMul(side);
  const opp = state.sides[3 - sideIdx];
  const passiveMul = gandulfSkillDmgMul(side);
  const directDmg = FIREWAVE_DIRECT_DMG * (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1) * passiveMul;
  const dotDps = FIREWAVE_DOT_DPS * (side.skillDmgMul || 1) * passiveMul;
  // Spawna cone-effekt för klient-visuell (lever 0.6s)
  side.fireWaves = side.fireWaves || [];
  side.fireWaves.push({
    id: state.nextEntityId++,
    x: side.hero.x, z: side.hero.z,
    dx: dirX, dz: dirZ,
    life: FIREWAVE_EFFECT_LIFE, maxLife: FIREWAVE_EFFECT_LIFE,
  });
  // Träffa alla monsters i cone
  const inCone = (ex, ez) => {
    const ddx = ex - side.hero.x, ddz = ez - side.hero.z;
    const d = Math.hypot(ddx, ddz);
    if (d > FIREWAVE_LENGTH || d < 0.001) return false;
    const dot = (ddx * dirX + ddz * dirZ) / d;
    const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
    return ang < FIREWAVE_HALF_ANGLE;
  };
  for (let j = side.monsters.length - 1; j >= 0; j--) {
    const m = side.monsters[j];
    if (!inCone(m.x, m.z)) continue;
    onGandulfSkillHit(side, m);
    applySkillDamageToMonster(state, side, opp, j, directDmg);
    if (m.hp > 0) {
      m.dotRemaining = FIREWAVE_DOT_DURATION;
      m.dotPerSec = dotDps;
    }
  }
  if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
    const c = opp.playerCreeps[j];
    if (!inCone(c.x, c.z)) continue;
    onGandulfSkillHit(side, c);
    applySkillDamageToCreep(state, side, opp, c, directDmg);
    if (c.hp > 0) {
      c.dotRemaining = FIREWAVE_DOT_DURATION;
      c.dotPerSec = dotDps;
    } else {
      const idx = opp.playerCreeps.indexOf(c);
      if (idx >= 0) { opp.playerCreeps.splice(idx, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
    }
  }
  // Duel: träffa opp.hero om i cone
  if (state.duelActive && opp && !opp.hero.dead && inCone(opp.hero.x, opp.hero.z)) {
    onGandulfSkillHit(side, opp.hero);
    applySkillDamageToOppHero(state, side, opp, directDmg);
    if (!opp.hero.dead) {
      opp.hero.dotRemaining = FIREWAVE_DOT_DURATION;
      opp.hero.dotPerSec = dotDps;
    }
  }
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

// Frost Nova (F): target-AoE. Skadar + fryser fiender 2s. Frusen + ny skill-träff → shatter.
function castFrostnova(state, sideIdx, ev) {
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.f.cd > 0) return;
  side.skills.f.cd = side.skills.f.max * gandulfCdrMul(side);
  const opp = state.sides[3 - sideIdx];
  const center = resolveSkillGroundTarget(state, side, opp, ev || {}, NOVA_CAST_DISTANCE);
  side.novaEffects.push({
    id: state.nextEntityId++,
    x: center.x, z: center.z,
    life: 0.6, maxLife: 0.6,
  });
  const novaDmg = NOVA_DAMAGE * (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1) * gandulfSkillDmgMul(side);
  for (let j = side.monsters.length - 1; j >= 0; j--) {
    const m = side.monsters[j];
    if (Math.hypot(m.x - center.x, m.z - center.z) < NOVA_RADIUS) {
      const wasFrozen = (m.frozenTime || 0) > 0;
      onGandulfSkillHit(side, m);
      applySkillDamageToMonster(state, side, opp, j, novaDmg);
      const stillAlive = side.monsters[j] === m && m.hp > 0;
      if (stillAlive && !wasFrozen) m.frozenTime = NOVA_FREEZE_TIME;
    }
  }
  if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
    const c = opp.playerCreeps[j];
    if (Math.hypot(c.x - center.x, c.z - center.z) < NOVA_RADIUS) {
      const wasFrozen = (c.frozenTime || 0) > 0;
      onGandulfSkillHit(side, c);
      applySkillDamageToCreep(state, side, opp, c, novaDmg);
      if (c.hp > 0 && !wasFrozen) c.frozenTime = NOVA_FREEZE_TIME;
      else if (c.hp <= 0) {
        const idx = opp.playerCreeps.indexOf(c);
        if (idx >= 0) { opp.playerCreeps.splice(idx, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
      }
    }
  }
  if (state.duelActive && opp && !opp.hero.dead) {
    if (Math.hypot(opp.hero.x - center.x, opp.hero.z - center.z) < NOVA_RADIUS) {
      const wasFrozen = (opp.hero.frozenTime || 0) > 0;
      onGandulfSkillHit(side, opp.hero);
      applySkillDamageToOppHero(state, side, opp, novaDmg);
      if (!opp.hero.dead && !wasFrozen) opp.hero.frozenTime = NOVA_FREEZE_TIME;
    }
  }
}

function updateNovaEffects(side, dt) {
  for (let i = side.novaEffects.length - 1; i >= 0; i--) {
    const n = side.novaEffects[i];
    n.life -= dt;
    if (n.life <= 0) side.novaEffects.splice(i, 1);
  }
  // Fire Wave-cone-effekter (livstid)
  if (side.fireWaves) for (let i = side.fireWaves.length - 1; i >= 0; i--) {
    side.fireWaves[i].life -= dt;
    if (side.fireWaves[i].life <= 0) side.fireWaves.splice(i, 1);
  }
  // Shatter-effekter (livstid)
  if (side.shatters) for (let i = side.shatters.length - 1; i >= 0; i--) {
    side.shatters[i].life -= dt;
    if (side.shatters[i].life <= 0) side.shatters.splice(i, 1);
  }
}

// Black Hole (E): spawnar en black hole vid target-position som suger in fiender i 3s
// och avslutas med en AoE-explosion.
function castBlink(state, sideIdx, ev) {
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.e.cd > 0) return;
  const opp = state.sides[3 - sideIdx];
  const center = resolveSkillGroundTarget(state, side, opp, ev || {}, BLACKHOLE_CAST_DISTANCE);
  side.skills.e.cd = side.skills.e.max * gandulfCdrMul(side);
  if (!side.blackHoles) side.blackHoles = [];
  const skillDmgMul = (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1) * gandulfSkillDmgMul(side);
  side.blackHoles.push({
    id: state.nextEntityId++,
    x: center.x, z: center.z,
    life: BLACKHOLE_DURATION, maxLife: BLACKHOLE_DURATION,
    explosionDmg: BLACKHOLE_EXPLOSION_DMG * skillDmgMul,
  });
}

function updateBlackHoles(state, side, opp, dt) {
  if (!side.blackHoles || side.blackHoles.length === 0) return;
  for (let i = side.blackHoles.length - 1; i >= 0; i--) {
    const bh = side.blackHoles[i];
    bh.life -= dt;
    // Sug-styrka: smooth pull i radien
    const pull = BLACKHOLE_PULL_SPEED * dt;
    for (const m of side.monsters) {
      const dx = bh.x - m.x, dz = bh.z - m.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.15 && d < BLACKHOLE_RADIUS) {
        const f = 1 - d / BLACKHOLE_RADIUS; // starkare vid kanten? nej, starkare nära mitten = (1 - d/r)
        m.x += (dx / d) * pull * (0.4 + f * 0.6);
        m.z += (dz / d) * pull * (0.4 + f * 0.6);
      }
    }
    if (opp) for (const c of opp.playerCreeps) {
      const dx = bh.x - c.x, dz = bh.z - c.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.15 && d < BLACKHOLE_RADIUS) {
        const f = 1 - d / BLACKHOLE_RADIUS;
        c.x += (dx / d) * pull * (0.4 + f * 0.6);
        c.z += (dz / d) * pull * (0.4 + f * 0.6);
      }
    }
    // Suga in opp.hero under duel
    if (state.duelActive && opp && !opp.hero.dead) {
      const dx = bh.x - opp.hero.x, dz = bh.z - opp.hero.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.15 && d < BLACKHOLE_RADIUS) {
        opp.hero.x += (dx / d) * pull * 0.5;
        opp.hero.z += (dz / d) * pull * 0.5;
      }
    }
    if (bh.life <= 0) {
      // Explosion AoE
      for (let j = side.monsters.length - 1; j >= 0; j--) {
        const m = side.monsters[j];
        if (Math.hypot(m.x - bh.x, m.z - bh.z) < BLACKHOLE_EXPLOSION_RADIUS) {
          onGandulfSkillHit(side, m);
          applySkillDamageToMonster(state, side, opp, j, bh.explosionDmg);
        }
      }
      if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
        const c = opp.playerCreeps[j];
        if (Math.hypot(c.x - bh.x, c.z - bh.z) < BLACKHOLE_EXPLOSION_RADIUS) {
          onGandulfSkillHit(side, c);
          applySkillDamageToCreep(state, side, opp, c, bh.explosionDmg);
          if (c.hp <= 0) { opp.playerCreeps.splice(j, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
        }
      }
      if (state.duelActive && opp && !opp.hero.dead) {
        if (Math.hypot(opp.hero.x - bh.x, opp.hero.z - bh.z) < BLACKHOLE_EXPLOSION_RADIUS) {
          onGandulfSkillHit(side, opp.hero);
          applySkillDamageToOppHero(state, side, opp, bh.explosionDmg);
        }
      }
      side.blackHoles.splice(i, 1);
    }
  }
}

// === Legolus-skills ===
// Q: Vine Trap Rain — zon som rotar + DoT i 3s, ingen direct dmg
function castLegolusVineTrap(state, sideIdx, ev) {
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.q.cd > 0) return;
  side.skills.q.cd = side.skills.q.max;
  const opp = state.sides[3 - sideIdx];
  const center = resolveSkillGroundTarget(state, side, opp, ev || {}, VINE_TRAP_CAST_DISTANCE);
  if (!side.vineTraps) side.vineTraps = [];
  side.vineTraps.push({
    id: state.nextEntityId++,
    x: center.x, z: center.z,
    life: VINE_TRAP_DURATION, maxLife: VINE_TRAP_DURATION,
    dotPerSec: VINE_TRAP_DOT_DPS * (side.skillDmgMul || 1),
    radius: VINE_TRAP_RADIUS,
  });
}

function updateVineTraps(state, side, opp, dt) {
  if (!side.vineTraps || side.vineTraps.length === 0) return;
  for (let i = side.vineTraps.length - 1; i >= 0; i--) {
    const vt = side.vineTraps[i];
    vt.life -= dt;
    const r2 = vt.radius * vt.radius;
    // Applicera root + DoT på monsters i radien
    for (let j = side.monsters.length - 1; j >= 0; j--) {
      const m = side.monsters[j];
      const dx = m.x - vt.x, dz = m.z - vt.z;
      if (dx * dx + dz * dz < r2) {
        m.frozenTime = Math.max(m.frozenTime || 0, VINE_TRAP_ROOT_REFRESH);
        m.hp -= vt.dotPerSec * dt;
        if (m.hp <= 0) killMonster(side, j, side);
      }
    }
    if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
      const c = opp.playerCreeps[j];
      const dx = c.x - vt.x, dz = c.z - vt.z;
      if (dx * dx + dz * dz < r2) {
        c.frozenTime = Math.max(c.frozenTime || 0, VINE_TRAP_ROOT_REFRESH);
        c.hp -= vt.dotPerSec * dt;
        if (c.hp <= 0) { opp.playerCreeps.splice(j, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
      }
    }
    // Duel: applicera även på opp.hero
    if (state.duelActive && opp && !opp.hero.dead) {
      const dx = opp.hero.x - vt.x, dz = opp.hero.z - vt.z;
      if (dx * dx + dz * dz < r2) {
        opp.hero.frozenTime = Math.max(opp.hero.frozenTime || 0, VINE_TRAP_ROOT_REFRESH);
        damageHero(opp, vt.dotPerSec * dt);
      }
    }
    if (vt.life <= 0) side.vineTraps.splice(i, 1);
  }
}

// F: Self-buff i 5s — +10% dmg, +10% crit, +30% crit-dmg
function castLegolusBuff(state, sideIdx) {
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.f.cd > 0) return;
  side.skills.f.cd = side.skills.f.max;
  side.legolusBuffRemaining = LEGOLUS_BUFF_DURATION;
}

// E: Kort dash + flagga: nästa AA = 100% crit + 20% lifesteal. Reset cd om buffed AA dödar.
function castLegolusDash(state, sideIdx, ev) {
  const side = state.sides[sideIdx];
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
  side.legolusDashBuffPending = true;
}

// === Gimlu-skills ===
// Q: Titan's Taunt — AoE-skrik. Fiender i radien blir tauntade 3s; Gimlu får 30% DR + 20% heal.
function castGimluTaunt(state, sideIdx) {
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.q.cd > 0) return;
  side.skills.q.cd = side.skills.q.max;
  side.titansTauntRemaining = TAUNT_DURATION;
  const r2 = TAUNT_RADIUS * TAUNT_RADIUS;
  // Tauntar alla monsters i radien
  for (const m of side.monsters) {
    const dx = m.x - side.hero.x, dz = m.z - side.hero.z;
    if (dx * dx + dz * dz < r2) {
      m.tauntedTime = TAUNT_DURATION;
      m.chasing = true;
    }
  }
  // Tauntar opp:s playerCreeps som invaderar Gimlus arena
  const opp = state.sides[3 - sideIdx];
  if (opp) for (const c of opp.playerCreeps) {
    const dx = c.x - side.hero.x, dz = c.z - side.hero.z;
    if (dx * dx + dz * dz < r2) {
      c.tauntedTime = TAUNT_DURATION;
      c.tauntTargetSide = sideIdx;
    }
  }
  // Duel: tauntar opp.hero
  if (state.duelActive && opp && !opp.hero.dead) {
    const dx = opp.hero.x - side.hero.x, dz = opp.hero.z - side.hero.z;
    if (dx * dx + dz * dz < r2) opp.hero.tauntedTime = TAUNT_DURATION;
  }
}

// F: Iron Will — 3s aktivt fönster. Alla dmg taken stackas. Vid slut: AoE explosion runt hero.
function castGimluIronWill(state, sideIdx) {
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.f.cd > 0) return;
  side.skills.f.cd = side.skills.f.max;
  side.ironWillRemaining = IRON_WILL_DURATION;
  side.ironWillStored = 0;
}

function updateIronWill(state, side, opp, dt) {
  if (!side.ironWillRemaining || side.ironWillRemaining <= 0) return;
  side.ironWillRemaining -= dt;
  if (side.ironWillRemaining <= 0) {
    const dmg = side.ironWillStored || 0;
    side.ironWillStored = 0;
    side.ironWillRemaining = 0;
    if (dmg > 0) {
      const r2 = IRON_WILL_EXPLOSION_RADIUS * IRON_WILL_EXPLOSION_RADIUS;
      for (let i = side.monsters.length - 1; i >= 0; i--) {
        const m = side.monsters[i];
        const ddx = m.x - side.hero.x, ddz = m.z - side.hero.z;
        if (ddx * ddx + ddz * ddz < r2) {
          m.hp -= dmg;
          if (m.hp <= 0) killMonster(side, i, side);
        }
      }
      if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
        const c = opp.playerCreeps[i];
        const ddx = c.x - side.hero.x, ddz = c.z - side.hero.z;
        if (ddx * ddx + ddz * ddz < r2) {
          c.hp -= dmg;
          if (c.hp <= 0) { opp.playerCreeps.splice(i, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
        }
      }
      if (state.duelActive && opp && !opp.hero.dead) {
        const ddx = opp.hero.x - side.hero.x, ddz = opp.hero.z - side.hero.z;
        if (ddx * ddx + ddz * ddz < r2) damageHero(opp, dmg);
      }
      side.ironWillExplosions = side.ironWillExplosions || [];
      side.ironWillExplosions.push({ id: state.nextEntityId++, x: side.hero.x, z: side.hero.z, life: 0.7, maxLife: 0.7 });
    }
  }
}

// E: Hammer Throw — kastar hammar rakt fram + tillbaka. Vid andra tryck: teleport.
function castGimluHammer(state, sideIdx, dirX, dirZ) {
  const side = state.sides[sideIdx];
  if (side.hero.dead) return;
  // Om hammer redan ute → teleport till den och despawn
  if (side.hammers && side.hammers.length > 0) {
    const h = side.hammers[0];
    if (isHeroWalkable(side.idx, h.x, h.z)) {
      side.hero.x = h.x;
      side.hero.z = h.z;
    }
    side.hammers.splice(0, 1);
    return;
  }
  if (side.skills.e.cd > 0) return;
  side.skills.e.cd = side.skills.e.max;
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.01) { dirX = side.hero.facingX; dirZ = side.hero.facingZ; }
  else { dirX /= len; dirZ /= len; }
  side.hammers = side.hammers || [];
  side.hammers.push({
    id: state.nextEntityId++,
    x: side.hero.x, z: side.hero.z,
    dx: dirX, dz: dirZ,
    traveled: 0,
    returning: false,
    hit: new Set(),
    damage: HAMMER_DAMAGE * (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1),
  });
}

function updateHammers(state, side, opp, dt) {
  if (!side.hammers || side.hammers.length === 0) return;
  for (let i = side.hammers.length - 1; i >= 0; i--) {
    const h = side.hammers[i];
    const step = HAMMER_SPEED * dt;
    if (!h.returning) {
      h.x += h.dx * step;
      h.z += h.dz * step;
      h.traveled += step;
      if (h.traveled >= HAMMER_RANGE) {
        h.returning = true;
        h.hit = new Set(); // ny set så enemies kan träffas igen vid retur
      }
    } else {
      const ddx = side.hero.x - h.x, ddz = side.hero.z - h.z;
      const d = Math.hypot(ddx, ddz);
      if (d < 0.6) { side.hammers.splice(i, 1); continue; }
      h.x += (ddx / d) * step;
      h.z += (ddz / d) * step;
    }
    const dmgMul = h.returning ? HAMMER_RETURN_DMG_MUL : 1;
    const dmg = h.damage * dmgMul;
    // Träff på monsters
    for (let j = side.monsters.length - 1; j >= 0; j--) {
      const m = side.monsters[j];
      if (h.hit.has(m.id)) continue;
      if (Math.hypot(m.x - h.x, m.z - h.z) < HAMMER_RADIUS) {
        h.hit.add(m.id);
        m.hp -= dmg;
        if (!side.hero.dead) side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + dmg * HAMMER_LIFESTEAL);
        if (m.hp <= 0) killMonster(side, j, side);
      }
    }
    // Träff på opp's playerCreeps
    if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
      const c = opp.playerCreeps[j];
      if (h.hit.has(c.id)) continue;
      if (Math.hypot(c.x - h.x, c.z - h.z) < HAMMER_RADIUS) {
        h.hit.add(c.id);
        c.hp -= dmg;
        if (!side.hero.dead) side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + dmg * HAMMER_LIFESTEAL);
        if (c.hp <= 0) { opp.playerCreeps.splice(j, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
      }
    }
    // Duel: träffa opp.hero
    if (state.duelActive && opp && !opp.hero.dead && !h.hit.has('opp-hero')) {
      if (Math.hypot(opp.hero.x - h.x, opp.hero.z - h.z) < HAMMER_RADIUS + 0.4) {
        h.hit.add('opp-hero');
        damageHero(opp, dmg);
        if (!side.hero.dead) side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + dmg * HAMMER_LIFESTEAL);
      }
    }
  }
}

function applyMovement(side, joyX, joyZ, dt) {
  if (side.hero.dead) return;
  const mag = Math.hypot(joyX, joyZ);
  if (mag < 0.05) return;
  const strength = Math.min(1, mag);
  const ndx = joyX / mag, ndz = joyZ / mag;
  side.hero.facingX = ndx;
  side.hero.facingZ = ndz;
  const speedMul = (side.duelSpeedBuffRemaining > 0) ? (1 + DUEL_ORB_SPEED_BONUS) : 1;
  const nx = side.hero.x + ndx * side.moveSpeed * speedMul * strength * dt;
  const nz = side.hero.z + ndz * side.moveSpeed * speedMul * strength * dt;
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
    const t = findClosestHostile(side, opp, side.hero.x, side.hero.z, side.attackRange || HERO_ATTACK_RANGE, state);
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
    const isLegolus = side.heroId === 'legolas';
    const isGimlu = side.heroId === 'gimlu';
    if (ev.key === 'q') {
      if (isLegolus) castLegolusVineTrap(state, sideIdx, ev);
      else if (isGimlu) castGimluTaunt(state, sideIdx);
      else castEldklot(state, sideIdx, dx, dz);
    } else if (ev.key === 'f') {
      if (isLegolus) castLegolusBuff(state, sideIdx);
      else if (isGimlu) castGimluIronWill(state, sideIdx);
      else castFrostnova(state, sideIdx, ev);
    } else if (ev.key === 'e') {
      if (isLegolus) castLegolusDash(state, sideIdx, ev);
      else if (isGimlu) castGimluHammer(state, sideIdx, dx, dz);
      else castBlink(state, sideIdx, ev);
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

// === Hero-kopia (Fas 5) ===
// Spawnar en bot-styrd hero-kopia i fiendens lane som duel-belöning
// för max-level-vinnare. Lagras på MOTSTÅNDARENS sida (i deras arena).
function spawnHeroCopy(state, winnerSide) {
  const winnerIdx = winnerSide.idx;
  const oppIdx = 3 - winnerIdx;
  const oppCfg = SIDE_CFG[oppIdx];
  const oppSide = state.sides[oppIdx];
  if (!oppSide) return;
  const lane = (state.duelCount % 2 === 1) ? 1 : 2; // alternera mellan lanes
  const z = oppCfg.laneZ[lane];
  const stat = HERO_COPY_STAT_RATIO;
  const maxHp = Math.round(winnerSide.hero.maxHp * stat);
  oppSide.heroCopies.push({
    id: state.nextEntityId++,
    ownerSideIdx: winnerIdx,
    heroId: winnerSide.heroId || 'magiker',
    x: oppCfg.spawnX, z, ry: 0,
    lane,
    hp: maxHp, maxHp,
    attackDmg: winnerSide.attackDmg * stat,
    moveSpeed: winnerSide.moveSpeed * stat,
    skillDmg: ELDKLOT_DAMAGE * (winnerSide.skillDmgMul || 1) * stat,
    attackCd: 0,
    skillCd: 0,
    chasing: false,
    facingX: 1, facingZ: 0,
    pathIndex: 0,
  });
}

function updateHeroCopies(state, arenaSide, dt) {
  // arenaSide är den sida vars arena bot:en är i (= motståndaren till owner)
  if (!arenaSide.heroCopies) return;
  const oppCfg = SIDE_CFG[arenaSide.idx]; // det är arenaSide's torn boten attackerar
  const towerPos = oppCfg.tower;
  for (let i = arenaSide.heroCopies.length - 1; i >= 0; i--) {
    const hc = arenaSide.heroCopies[i];
    hc.attackCd = Math.max(0, hc.attackCd - dt);
    hc.skillCd = Math.max(0, hc.skillCd - dt);
    // Nått tornet?
    const dxT = towerPos.x - hc.x, dzT = towerPos.z - hc.z;
    if (dxT * dxT + dzT * dzT < (TOWER_REACH + HERO_COPY_RADIUS) * (TOWER_REACH + HERO_COPY_RADIUS)) {
      arenaSide.tower.hp = Math.max(0, arenaSide.tower.hp - HERO_COPY_TOWER_DAMAGE);
      arenaSide.heroCopies.splice(i, 1);
      continue;
    }
    // HP nere?
    if (hc.hp <= 0) {
      arenaSide.heroCopies.splice(i, 1);
      continue;
    }
    // Aggro mot arenaSide:s hero (motståndaren till owner)
    const heroAlive = !arenaSide.hero.dead;
    let aggro = false;
    if (heroAlive) {
      const d = Math.hypot(arenaSide.hero.x - hc.x, arenaSide.hero.z - hc.z);
      if (!hc.chasing && d < HERO_COPY_AGGRO_RANGE) hc.chasing = true;
      else if (hc.chasing && d > HERO_COPY_AGGRO_RANGE * 1.5) hc.chasing = false;
      aggro = hc.chasing && d < HERO_COPY_AGGRO_RANGE * 1.5;
      // Skill: cast Eldklot mot hero om i range och CD redo
      if (heroAlive && d < ELDKLOT_RANGE && hc.skillCd <= 0) {
        const dx = arenaSide.hero.x - hc.x, dz = arenaSide.hero.z - hc.z;
        const m = Math.hypot(dx, dz) || 1;
        state.sides[hc.ownerSideIdx]; // bara reference för läsbarhet
        // Skapa fireball — lagras på arenaSide.heroCopies[i] men vi använder en separat fält
        if (!arenaSide.heroCopyFireballs) arenaSide.heroCopyFireballs = [];
        arenaSide.heroCopyFireballs.push({
          id: state.nextEntityId++,
          ownerSideIdx: hc.ownerSideIdx,
          x: hc.x, y: 1.0, z: hc.z,
          dx: dx / m, dz: dz / m,
          hit: new Set(),
          traveled: 0,
          damage: hc.skillDmg,
        });
        hc.skillCd = HERO_COPY_SKILL_INTERVAL;
      }
      // AA mot hero om nära nog
      if (aggro && d < HERO_COPY_ATTACK_RANGE && hc.attackCd <= 0) {
        damageHero(arenaSide, hc.attackDmg);
        hc.attackCd = HERO_COPY_ATTACK_INTERVAL;
      }
    }
    // Rörelse: chasa hero om aggro, annars mot tornet
    let tx, tz;
    if (aggro) { tx = arenaSide.hero.x; tz = arenaSide.hero.z; }
    else { tx = towerPos.x; tz = towerPos.z; }
    const dx = tx - hc.x, dz = tz - hc.z;
    const m = Math.hypot(dx, dz);
    if (m > 0.1) {
      const stop = aggro ? HERO_COPY_ATTACK_RANGE - 0.4 : TOWER_REACH;
      if (m > stop) {
        const step = hc.moveSpeed * dt;
        hc.x += (dx / m) * step;
        hc.z += (dz / m) * step;
        hc.ry = Math.atan2(-dz, dx);
        hc.facingX = dx / m; hc.facingZ = dz / m;
      }
    }
  }
  // Tickea hero-copy-fireballs separat
  if (arenaSide.heroCopyFireballs && arenaSide.heroCopyFireballs.length) {
    for (let i = arenaSide.heroCopyFireballs.length - 1; i >= 0; i--) {
      const f = arenaSide.heroCopyFireballs[i];
      const step = ELDKLOT_SPEED * dt;
      f.x += f.dx * step; f.z += f.dz * step;
      f.traveled += step;
      // Träffa motståndar-hero (arenaSide hero)
      if (!arenaSide.hero.dead && !f.hit.has('h')) {
        const d = Math.hypot(arenaSide.hero.x - f.x, arenaSide.hero.z - f.z);
        if (d < ELDKLOT_RADIUS + 0.5) {
          f.hit.add('h');
          damageHero(arenaSide, f.damage);
        }
      }
      if (f.traveled > ELDKLOT_RANGE) {
        arenaSide.heroCopyFireballs.splice(i, 1);
      }
    }
  }
}

// === Duel-system ===
function startDuel(state) {
  state.duelActive = true;
  state.duelMatchTimer = DUEL_DURATION;
  state.duelAnnounceTimer = 0;
  state.duelArenaTime = 0;
  state.duelOrbs = [];
  state.duelOrbIdCounter = 0;
  // Schemalägg 3 heal + 3 speed orbs på random tider inom första 30s
  const queue = [];
  for (let i = 0; i < DUEL_ORB_COUNT_PER_TYPE; i++) {
    queue.push({ type: 'heal', t: DUEL_ORB_MIN_SPAWN + Math.random() * (DUEL_ORB_SPAWN_WINDOW - DUEL_ORB_MIN_SPAWN) });
    queue.push({ type: 'speed', t: DUEL_ORB_MIN_SPAWN + Math.random() * (DUEL_ORB_SPAWN_WINDOW - DUEL_ORB_MIN_SPAWN) });
  }
  queue.sort((a, b) => a.t - b.t);
  state.duelOrbQueue = queue;
  // Teleportera båda hjältar in i arenan, full HP, rensa CD och projektiler
  // Större arena (radius 14.4) — placera spelarna 8.4m från centrum (skalat 20%)
  const positions = [
    { x: ARENA_CX - 8.4, z: ARENA_CZ },       // side 1: västra sidan
    { x: ARENA_CX + 8.4, z: ARENA_CZ },       // side 2: östra sidan
  ];
  // Big orb spawnar omedelbart vid duel-start, alive, full HP
  state.duelBigOrb = {
    x: ARENA_CX, z: ARENA_CZ,
    hp: DUEL_BIG_ORB_MAX_HP, maxHp: DUEL_BIG_ORB_MAX_HP,
    alive: true, respawnTimer: 0, lastDamagerIdx: 0,
  };
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
    s.duelSpeedBuffRemaining = 0;
  }
}

function spawnDuelOrb(state, type) {
  // Random position inom arenan (uniform i area), minst 1m från kanten
  const maxR = ARENA_RADIUS - 1.2;
  const r = Math.sqrt(Math.random()) * maxR;
  const ang = Math.random() * Math.PI * 2;
  state.duelOrbIdCounter += 1;
  state.duelOrbs.push({
    id: state.duelOrbIdCounter,
    type,
    x: ARENA_CX + Math.cos(ang) * r,
    z: ARENA_CZ + Math.sin(ang) * r,
  });
}

function tickDuelOrbs(state, dt) {
  state.duelArenaTime += dt;
  // Spawn:a orbs vars t har passerat
  while (state.duelOrbQueue.length > 0 && state.duelOrbQueue[0].t <= state.duelArenaTime) {
    const next = state.duelOrbQueue.shift();
    spawnDuelOrb(state, next.type);
  }
  // Tick speed-buff per side
  for (const idx of [1, 2]) {
    const s = state.sides[idx];
    if (s && (s.duelSpeedBuffRemaining || 0) > 0) {
      s.duelSpeedBuffRemaining = Math.max(0, s.duelSpeedBuffRemaining - dt);
    }
  }
  // Pickup-check: hero touch
  if (state.duelOrbs.length > 0) {
    for (let i = state.duelOrbs.length - 1; i >= 0; i--) {
      const orb = state.duelOrbs[i];
      for (const idx of [1, 2]) {
        const s = state.sides[idx];
        if (!s || s.hero.dead) continue;
        const d = Math.hypot(s.hero.x - orb.x, s.hero.z - orb.z);
        if (d < DUEL_ORB_PICKUP_RADIUS) {
          // Pickup!
          if (orb.type === 'heal') {
            s.hero.hp = Math.min(s.hero.maxHp, s.hero.hp + s.hero.maxHp * DUEL_ORB_HEAL_PCT);
          } else if (orb.type === 'speed') {
            s.duelSpeedBuffRemaining = DUEL_ORB_SPEED_DURATION;
          }
          state.duelOrbs.splice(i, 1);
          break;
        }
      }
    }
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
    } else {
      // Max level — kan inte levla mer. Spawna en hero-kopia på fiendens lane istället.
      spawnHeroCopy(state, winner);
    }
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
    s.duelSpeedBuffRemaining = 0;
  }
  state.duelActive = false;
  state.duelMatchTimer = 0;
  state.duelOrbs = [];
  state.duelOrbQueue = [];
  state.duelArenaTime = 0;
  state.duelBigOrb = null;   // rensa big-orb mellan dueler
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
      updateBlackHoles(state, side, opp, dt);
      updateVineTraps(state, side, opp, dt);
      updateHammers(state, side, opp, dt);
      updateIronWill(state, side, opp, dt);
      if ((side.legolusBuffRemaining || 0) > 0) side.legolusBuffRemaining = Math.max(0, side.legolusBuffRemaining - dt);
      if ((side.titansTauntRemaining || 0) > 0) side.titansTauntRemaining = Math.max(0, side.titansTauntRemaining - dt);
      if (side.ironWillExplosions) for (let k = side.ironWillExplosions.length - 1; k >= 0; k--) {
        side.ironWillExplosions[k].life -= dt;
        if (side.ironWillExplosions[k].life <= 0) side.ironWillExplosions.splice(k, 1);
      }
      updateNovaEffects(side, dt);
      updateActiveBuffs(side, dt);
    }
    // Pickup-orbs (heal + speed) + big duel-arena orb
    tickDuelOrbs(state, dt);
    tickDuelBigOrb(state, dt);
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
        side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + side.hero.maxHp * FOUNTAIN_AURA_REGEN_PCT * dt);
      }
      // Passiv heal från Glove of Tank-stack (oavsett position)
      if ((side.healPerSecPct || 0) > 0 && side.hero.hp < side.hero.maxHp) {
        side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + side.hero.maxHp * side.healPerSecPct * dt);
      }
      // Fire Wave DoT på hjälten
      if ((side.hero.dotRemaining || 0) > 0) {
        side.hero.dotRemaining -= dt;
        damageHero(side, (side.hero.dotPerSec || 0) * dt);
      }
      // Tick freeze på hero (om frusen, hjälten kan inte använda skills/AA — för enkelhet bara dekrementera)
      if ((side.hero.frozenTime || 0) > 0) side.hero.frozenTime -= dt;
      // Titans Taunt passive heal: 20% av maxHP per sek (= 10% per halvsek) medan tauntet är aktivt
      if ((side.titansTauntRemaining || 0) > 0 && side.hero.hp < side.hero.maxHp) {
        side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + side.hero.maxHp * TAUNT_HEAL_PER_SEC * dt);
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
  for (const sideIdx of [1, 2]) {
    const side = state.sides[sideIdx];
    const opp = state.sides[3 - sideIdx];
    updateSkillCooldowns(side, dt);
    updateWaves(state, side, dt);
    updateMonsters(state, side, opp, dt);
    updatePlayerCreeps(state, side, opp, dt);
    updateHeroCopies(state, side, dt);
    updateBlackHoles(state, side, opp, dt);
    updateVineTraps(state, side, opp, dt);
    updateHammers(state, side, opp, dt);
    updateIronWill(state, side, opp, dt);
    if ((side.legolusBuffRemaining || 0) > 0) side.legolusBuffRemaining = Math.max(0, side.legolusBuffRemaining - dt);
    if ((side.titansTauntRemaining || 0) > 0) side.titansTauntRemaining = Math.max(0, side.titansTauntRemaining - dt);
    if ((side.gandulfBuffRemaining || 0) > 0) {
      side.gandulfBuffRemaining = Math.max(0, side.gandulfBuffRemaining - dt);
      if (side.gandulfBuffRemaining <= 0) side.gandulfBuffStacks = 0;
    }
    // Iron will explosion-effects life-tick
    if (side.ironWillExplosions) for (let k = side.ironWillExplosions.length - 1; k >= 0; k--) {
      side.ironWillExplosions[k].life -= dt;
      if (side.ironWillExplosions[k].life <= 0) side.ironWillExplosions.splice(k, 1);
    }
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
      // Debuff-timers (klienten visar ikoner)
      frz: +(side.hero.frozenTime || 0).toFixed(2),
      dot: +(side.hero.dotRemaining || 0).toFixed(2),
      tnt: +(side.hero.tauntedTime || 0).toFixed(2),
      poi: +(side.hero.poisonRemaining || 0).toFixed(2),
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
    w: {
      c: side.wave.current,
      a: side.wave.active,
      bt: +(side.wave.betweenTimer || 0).toFixed(1),
      n: side.wave.name || '',
      b: side.wave.isBoss ? 1 : 0,
      p: side.wave.bannerPulse || 0,
    },
    M: side.monsters.map(m => ({ id: m.id, x: m.x, z: m.z, ry: m.ry, hp: m.hp, mh: m.maxHp || 10, boss: m.isBoss ? 1 : 0, r: m.attackType === 'range' ? 1 : 0, fz: (m.frozenTime || 0) > 0 ? 1 : 0, dot: (m.dotRemaining || 0) > 0 ? 1 : 0 })),
    C: side.playerCreeps.map(c => ({ id: c.id, typeId: c.typeId, x: c.x, z: c.z, ry: c.ry, hp: c.hp, mh: c.maxHp, fz: (c.frozenTime || 0) > 0 ? 1 : 0, dot: (c.dotRemaining || 0) > 0 ? 1 : 0 })),
    F: side.fireballs.map(f => ({ id: f.id, x: f.x, y: f.y, z: f.z })),
    P: side.projectiles.map(p => ({ id: p.id, x: p.x, y: p.y, z: p.z, aoe: p.isAoE })),
    N: side.novaEffects.map(n => ({ id: n.id, x: n.x, z: n.z, life: n.life / n.maxLife })),
    CP: side.creepProjectiles.map(p => ({ id: p.id, x: p.x, y: p.y, z: p.z, kind: p.kind })),
    HC: (side.heroCopies || []).map(c => ({ id: c.id, owner: c.ownerSideIdx, heroId: c.heroId || 'magiker', x: c.x, z: c.z, ry: c.ry, hp: c.hp, mh: c.maxHp })),
    HCF: (side.heroCopyFireballs || []).map(f => ({ id: f.id, x: f.x, y: f.y, z: f.z })),
    FW: (side.fireWaves || []).map(f => ({ id: f.id, x: f.x, z: f.z, dx: f.dx, dz: f.dz, life: f.life / f.maxLife })),
    BH: (side.blackHoles || []).map(b => ({ id: b.id, x: b.x, z: b.z, life: b.life / b.maxLife })),
    SH: (side.shatters || []).map(s => ({ id: s.id, x: s.x, z: s.z, life: s.life / s.maxLife })),
    VT: (side.vineTraps || []).map(v => ({ id: v.id, x: v.x, z: v.z, life: v.life / v.maxLife })),
    lbuf: +(side.legolusBuffRemaining || 0).toFixed(2),
    ldash: side.legolusDashBuffPending ? 1 : 0,
    HM: (side.hammers || []).map(h => ({ id: h.id, x: h.x, z: h.z, ret: h.returning ? 1 : 0 })),
    taunt: +(side.titansTauntRemaining || 0).toFixed(2),
    iw: +(side.ironWillRemaining || 0).toFixed(2),
    iwS: +(side.ironWillStored || 0).toFixed(1),
    gbuf: +(side.gandulfBuffRemaining || 0).toFixed(2),
    gbStk: side.gandulfBuffStacks || 0,
    shld: +(side.shield || 0).toFixed(1),
    dSp: +(side.duelSpeedBuffRemaining || 0).toFixed(2),
    IWE: (side.ironWillExplosions || []).map(e => ({ id: e.id, x: e.x, z: e.z, life: e.life / e.maxLife })),
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
    dO: (state.duelOrbs || []).map(o => ({ i: o.id, k: o.type === 'heal' ? 'h' : 's', x: +o.x.toFixed(2), z: +o.z.toFixed(2) })),
    dBO: state.duelBigOrb ? {
      x: +state.duelBigOrb.x.toFixed(2), z: +state.duelBigOrb.z.toFixed(2),
      hp: +state.duelBigOrb.hp.toFixed(1), mh: state.duelBigOrb.maxHp,
      a: state.duelBigOrb.alive ? 1 : 0,
      rt: +(state.duelBigOrb.respawnTimer || 0).toFixed(1),
    } : null,
  };
}

module.exports = {
  createGameState,
  tickGame,
  serializeState,
  applyEvent,
};
