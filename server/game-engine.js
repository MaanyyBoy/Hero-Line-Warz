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
// Game-feel (user 2026-06-20): +15% movement på ALLA hjältar (kändes slowmotion). Appliceras i
// recomputeSideStats (bas, körs i alla lägen via recomputeArenaSideStats) → carryar genom loadout.
// Klientens prediktion (_localMoveSpeed) måste matcha ×1.15 (arena/boss/sandbox); Line Wars läser ms.
const MOVE_SPEED_FEEL_MUL = 1.15;
const HERO_BASE_ATTACK_DMG = 5;
const HERO_ATTACK_RANGE = 4.0;
const HERO_ATTACK_INTERVAL = 1.0;
// Attack-move feel (all modes, server-auth; tap-to-AA v2, user 2026-06-20): ATK is NOT a hold
// button — each tap fires exactly ONE auto-attack and briefly STOPS the hero only for the SWING,
// then the joystick resumes. NOT a fixed timer: the lock is the swing's share of each attack cycle
// (lock = attackCd × this fraction), and attackCd IS the hero's attack speed — so a fast attacker
// gets a short swing & runs more (more stop-go cycles), a slow attacker a longer one. Tune by feel:
// lower = hero runs more / shorter slaps, higher = longer commit. No auto-chase/taunt: a tap does
// nothing out of range. AA_ACQUIRE_RANGE_MUL is only the maintainTargetLock drop-lock window now.
const AA_MOVE_LOCK_FRAC = 0.40;
const AA_ACQUIRE_RANGE_MUL = 1.5;
const AA_CRIT_FLASH = 0.15;   // G5: sek som crit-AA-flaggan (cri) hålls hög så klienten stylar siffran som crit
const PROJECTILE_SPEED = 18;

// Hero-definitioner (per-hero baseline stats). Skill-mekanik delas tills user byter.
const HERO_DEFS = {
  zyro: {
    name: 'Zyro',
    baseHp: 100,
    baseDmg: 5,
    attackRange: 6.3,     // mage AA = 70% av archer (Legolas 9.0). Var 4.0 (användarbeslut 2026-06-04)
    attackInterval: 1.0,
    baseMoveSpeed: 6.0,
  },
  nyro: {
    name: 'Nyro',
    baseHp: 85,           // glass-cannon
    baseDmg: 6,           // mer per AA
    attackRange: 9.0,     // AA-range +50% (6.0 → 9.0) — bågskytt på avstånd
    attackInterval: 0.7,  // snabbare AA än Gandulf (1.0)
    baseMoveSpeed: 7.0,   // snabbare än Gandulf (6.0)
  },
  kryx: {
    name: 'Kryx',
    baseHp: 140,          // tank
    baseDmg: 7,           // hård träff
    attackRange: 2.5,     // melee-räckvidd
    attackInterval: 1.2,  // tung yxa, långsam
    baseMoveSpeed: 5.0,   // långsam
  },
  elar: {
    name: 'Elar',
    baseHp: 130, baseDmg: 8, attackRange: 2.8, attackInterval: 1.1, baseMoveSpeed: 5.5,
  },
  kostefo: {
    name: 'Kostef',
    baseHp: 95,           // medium HP
    baseDmg: 5,           // medium dmg
    attackRange: 7.56,    // +20% (6.3->7.56) user 2026-06-26. Var 5.4 (användarbeslut 2026-06-04)
    attackInterval: 0.9,  // något snabbare
    baseMoveSpeed: 6.2,
  },
  zheyna: {
    name: 'Zheyna',
    baseHp: 95,           // spjut-carry: medium HP
    baseDmg: 15,          // hög skada per träff (motsats till snabba archers)
    attackRange: 7.5,     // ranged spjut
    attackInterval: 1.5,  // AA-takt (1.8→1.5 balans 2026-06-08)
    baseMoveSpeed: 6.0,
  },
  ganji: {
    name: 'Ganji',
    baseHp: 110,          // melee sword ninja
    baseDmg: 9,
    attackRange: 2.6,     // melee
    attackInterval: 0.9,
    baseMoveSpeed: 6.4,
  },
  xina: {                 // 8:e hjälten (2026-06-23) — melee female assassin, crit-passive + shurikens
    name: 'Xina',
    baseHp: 90,
    baseDmg: 7,
    attackRange: 2.6,     // melee
    attackInterval: 0.85, // snabba slag
    baseMoveSpeed: 6.6,
  },
};
function heroDef(heroId) { return HERO_DEFS[heroId] || HERO_DEFS.zyro; }
// ===== ZHEYNA (spjut-carry) konstanter (decision 134) =====
const ZHEYNA_PASSIVE_DMG_MAX = 0.40;   // +40% AA-skada på max AA-range (linjärt från 0 nära)
const ZHEYNA_PASSIVE_LS_MAX = 0.25;    // +25% lifesteal på max AA-range
// Q Spear Pierce
const ZHEYNA_Q_RANGE = 10, ZHEYNA_Q_SPEED = 22, ZHEYNA_Q_REPRESS = 1.5;   // cd via HERO_SKILL_CD.zheyna
const ZHEYNA_Q_STUN_RADIUS = 2.0, ZHEYNA_Q_STUN_DUR = 2.0;
const ZHEYNA_Q_BUFF_HERO = 0.20, ZHEYNA_Q_BUFF_MINION = 0.05, ZHEYNA_Q_BUFF_DUR = 3.0;
// F Clone
const ZHEYNA_CLONE_DUR = 5, ZHEYNA_CLONE_DMG_MUL = 0.50;
const ZHEYNA_CLONE_DMG_TAKEN_MUL = 1.5, ZHEYNA_CLONE_OWNER_DR = 0.50;
// E Warpath
const ZHEYNA_E_DUR = 5, ZHEYNA_E_AS = 0.20, ZHEYNA_E_MS = 0.20, ZHEYNA_E_RANGE = 0.20, ZHEYNA_E_KNOCKBACK = 1.0;   // cd via HERO_SKILL_CD.zheyna
// R Spear God
const ZHEYNA_R_RANGE = 20, ZHEYNA_R_MAX_CHARGE = 3.0, ZHEYNA_R_AIM_EXTRA = 2.0;
const ZHEYNA_R_DMG_PER_SEC = 0.20, ZHEYNA_R_WIDTH_BASE = 2.0, ZHEYNA_R_WIDTH_PER_SEC = 1.5;
const ZHEYNA_R_KNOCKBACK_PER_SEC = 2.0, ZHEYNA_R_CHARGE_MS_MUL = 0.50, ZHEYNA_R_CHARGE_TURN_SPEED = 2.2, ZHEYNA_R_SPEAR_SPEED = 26;
function zheynaTurnToward(side, ndx, ndz, dt) {
  // Turn-rate-begränsad facing (ult-laddning): rotera mot (ndx,ndz) max TURN_SPEED rad/s.
  const cx = side.hero.facingX || 0, cz = side.hero.facingZ || 1;
  const cur = Math.atan2(cx, cz), tgt = Math.atan2(ndx, ndz);
  let d = tgt - cur;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const step = ZHEYNA_R_CHARGE_TURN_SPEED * dt;
  const na = Math.abs(d) <= step ? tgt : cur + Math.sign(d) * step;
  side.hero.facingX = Math.sin(na); side.hero.facingZ = Math.cos(na);
}
// ===== XINA (melee assassin) konstanter (decision 139, 2026-06-23) =====
// Passive (i updateHeroAttack): +15% crit chance, +15% crit-dmg, +15% crit-lifesteal.
// Q Shuriken Toss — 5 shurikens i kon, flyger ut + tillbaka (bumerang).
const XINA_Q_COUNT = 5, XINA_Q_RANGE = 8, XINA_Q_SPEED = 16, XINA_Q_CONE = 70 * Math.PI / 180;
const XINA_Q_DMG_PCT = 0.05, XINA_Q_LIFESTEAL = 0.50, XINA_Q_HIT_RADIUS = 0.8;
const XINA_Q_BUFF_PER_HIT = 0.05, XINA_Q_BUFF_DUR = 3.0;   // +5% MS & AS per träffande shuriken (max 5), 3s refresh
// F Ninja's Cloak — buff
const XINA_CLOAK_DUR = 3.0, XINA_CLOAK_AS = 0.50, XINA_CLOAK_MS = 0.50;
const XINA_CLOAK_EVASION = 0.50, XINA_CLOAK_SKILL_DR = 0.50;   // 50% dodge vs AA, 50% DR mot skill-skada; 2 charges vid skill-lvl 5
// E Xina's Slice — krok
const XINA_E_RANGE = 11, XINA_E_SPEED = 22, XINA_E_STICK_DUR = 5.0, XINA_E_HIT_RADIUS = 0.9;
const XINA_E_BREAK_DIST = 9.0, XINA_E_BREAK_STUN = 1.0, XINA_E_PULL_STUN = 1.5;
const XINA_E_AA_COUNT = 2, XINA_E_AA_LIFESTEAL = 0.50;   // 2 snabba AA: 100% crit + 100% extra crit-dmg + 50% lifesteal
// R Shuriken Storm — orbit 5s → skjuts ut
const XINA_R_COUNT = 5, XINA_R_DUR = 5.0, XINA_R_ORBIT_RADIUS = 2.4, XINA_R_ORBIT_SPEED = 3.2;
const XINA_R_TICK_DMG_PCT = 0.10, XINA_R_HEAL = 0.50, XINA_R_HIT_CD = 0.5, XINA_R_HIT_RADIUS = 0.9;
const XINA_R_MS = 0.25, XINA_R_AS = 0.25, XINA_R_OUT_DMG = 0.25;
const XINA_R_LAUNCH_RANGE = 10, XINA_R_LAUNCH_SPEED = 18, XINA_R_LAUNCH_DMG_PCT = 0.20;
const XINA_R_LAUNCH_SLOW_MUL = 0.50, XINA_R_LAUNCH_SLOW_DUR = 2.0;

// Konstanta side-index-arrayer — undviker `[1,2]` literal-allokering i hot-paths
// (30 Hz × N anrop = märkbar GC-tryck i Render free-tier Node). Frysta = immutable.
const _SIDE_KEYS = Object.freeze([1, 2]);

// ── Team-arena (2v2/3v3, Task 18) — ADDITIVT. Classic/1v1 saknar state.teamSize
// → arenaOpp ger EXAKT gamla `sides[3 - idx]` och arenaKeys ger [1,2]: noll
// beteendeskillnad för live-lägena. I team-läge är "opp" = NÄRMASTE LEVANDE
// fiende-hero (v1-semantik: varje skill/AA påverkar sin opp; AoE multi-träff
// över flera fiender är en v2-förbättring, dokumenterad i TEAM_ARENA_PLAN.md).
function arenaKeys(state) { return (state && state.sideKeys) || _SIDE_KEYS; }
function arenaOpp(state, idx) {
  if (!state || !state.teamSize || state.teamSize <= 1) return state.sides[3 - idx];
  const me = state.sides[idx];
  if (!me) return state.sides[3 - idx] || null;
  let best = null, bestD = Infinity, anyEnemy = null;
  for (const k of state.sideKeys) {
    const s = state.sides[k];
    if (!s || (s.team || k) === (me.team || idx)) continue;
    if (!anyEnemy) anyEnemy = s;
    if (s.hero.dead) continue;
    const dx = s.hero.x - me.hero.x, dz = s.hero.z - me.hero.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD) { bestD = d2; best = s; }
  }
  return best || anyEnemy;   // alla fiender döda → valfri fiende-side (callers dead-guardar)
}
// Spawn-position: 1v1 = exakt gamla SPAWN1/2; team = båge kring väst/öst-punkten.
function arenaSpawnFor(idx, teamSize) {
  if (!teamSize || teamSize <= 1) return (idx === 1) ? ARENA1V1_SPAWN1 : ARENA1V1_SPAWN2;
  const team = idx <= teamSize ? 1 : 2;
  const member = idx - (team === 1 ? 1 : teamSize + 1);
  const baseAngle = team === 1 ? Math.PI : 0;
  const offset = (member - (teamSize - 1) / 2) * 0.45;
  const radius = 40 * ARENA1V1_SCALE;
  return { x: Math.cos(baseAngle + offset) * radius, z: ARENA1V1_Z + Math.sin(baseAngle + offset) * radius };
}

const PASSIVE_EVERY = 4;
const PASSIVE_AOE_RADIUS = 2.0;

const MONSTER_AGGRO_RANGE = 5.0;
const MONSTER_LEASH_RANGE = 7.5;
const TOWER_REACH = 2.3;
const MONSTER_MELEE_DAMAGE = 8;       // fallback om monster saknar damage
const MONSTER_MELEE_INTERVAL = 1.0;
// Minion melee wind-up (user 2026-06-14): minion-melee-skada landar 0.5s EFTER att
// slaget startar, och bara om hjälten fortfarande är i range → bra MS låter dig springa
// förbi. Range-projektiler dör om hjälten är > 2× minionens range från avfyrningspunkten.
// Gäller ENBART minions (ej bossar/mini-bossar — de träffar direkt).
const MINION_MELEE_WINDUP = 0.5;
const MINION_PROJ_RANGE_MUL = 2.0;
// Fountain (the old "tower") no longer self-heals; standing near YOUR fountain regenerates
// the hero 2% max HP/sec (user 2026-06-14). Radius covers the base area around it.
const FOUNTAIN_REGEN_RADIUS = 9.0;
const FOUNTAIN_REGEN_PCT = 0.02;
const GOLD_PER_KILL = 5;
const RESPAWN_TIME = 5.0;

// === Wave-system (50 waves, boss var 10:e) ===
const MAX_WAVES = 50;
const INITIAL_PREP_TIME = 10;          // sek innan wave 1
const WAVE_GAP_TIME = 10;              // sek mellan waves
const WAVE_COUNT_PER_LANE = 10;        // 10 per lane = 20 totalt
const WAVE_CLUMP_COLS_Z = [-1.5, 0, 1.5]; // 3 kolumner inom lane-bredden
const WAVE_CLUMP_ROW_SPACING = 1.0;       // m mellan rader bakåt
const WAVE_NAMES = ['Soldiers', 'Knights', 'Berserkers', 'Demons', 'Dragonkin'];
const BOSS_NAMES = ['Captain', 'General', 'Warlord', 'Demon Prince', 'Dragon King'];
// Per 10 waves: 5 melee, 3 mix, 2 range. Boss räknas som melee (singel-spawn).
// Index 0..9 = wave (n-1) % 10
const WAVE_TYPE_PATTERN = ['melee', 'mix', 'range', 'melee', 'mix', 'melee', 'range', 'melee', 'mix', 'boss'];
// Range-monster har längre attack-range, långsammare AA-interval, lägre HP, slow speed.
const RANGE_MONSTER_RANGE = 4.5;
const RANGE_MONSTER_INTERVAL = 1.5;
const RANGE_MONSTER_SPEED_RATIO = 0.75;
const RANGE_MONSTER_HP_RATIO = 0.80;

// 5 boss-definitioner med 3 unika skills var (wave 10/20/30/40/50).
// Skills är dodgeable: telegraph-fasen ger heroes tid att flytta sig ur
// damage-zonen innan execute-fasen träffar. dmgMul multipliceras mot bossens
// base monsterDmg. cd = cooldown per skill.
const BOSS_DEFS = {
  10: {
    name: 'Captain',
    skills: [
      { id: 'shieldBash',   kind: 'lineDash',    telegraph: 1.4, length: 11, width: 3.2, execTime: 0.5, dmgMul: 2.2, cd: 7.5 },
      { id: 'throwingAxe',  kind: 'projectile',  telegraph: 0.5, speed: 14, dmgMul: 1.8, radius: 1.0, range: 18, cd: 5.0 },
      { id: 'battleRoar',   kind: 'groundCircle',telegraph: 1.4, radius: 7.5, dmgMul: 1.6, originSelf: true, slow: { dur: 2.5, mul: 0.5 }, cd: 9.0 },
    ],
  },
  20: {
    name: 'General',
    skills: [
      { id: 'lightningStrike', kind: 'groundCircle',   telegraph: 1.0, radius: 4.2, dmgMul: 2.4, targetHero: true, cd: 5.5 },
      { id: 'spearVolley',     kind: 'projectileMulti',telegraph: 0.7, count: 4, spreadAngle: Math.PI / 6, speed: 18, dmgMul: 1.6, radius: 1.0, range: 18, cd: 6.5 },
      { id: 'warStomp',        kind: 'groundCircle',   telegraph: 1.3, radius: 9, dmgMul: 2.0, originSelf: true, knockback: 3.5, cd: 10.0 },
    ],
  },
  30: {
    name: 'Warlord',
    skills: [
      { id: 'cleaveWave',  kind: 'cone',        telegraph: 1.0, length: 12, halfAngle: Math.PI / 3, dmgMul: 2.6, cd: 6.0 },
      { id: 'poisonPool',  kind: 'poolDot',     telegraph: 1.0, radius: 4.5, duration: 7, dpsMul: 0.6, slow: { dur: 0.8, mul: 0.6 }, targetHero: true, cd: 7.5 },
      { id: 'earthquake',  kind: 'multiCircle', telegraph: 0.7, count: 6, spawnInterval: 0.5, radius: 3.5, dmgMul: 1.7, spread: 9, cd: 11.0 },
    ],
  },
  40: {
    name: 'Demon Prince',
    skills: [
      { id: 'hellfireBeam',  kind: 'sweepBeam',   telegraph: 1.3, sweepDuration: 2.2, length: 16, halfAngle: Math.PI / 1.8, dpsMul: 1.8, cd: 10.0 },
      { id: 'infernoStrike', kind: 'groundCircle',telegraph: 0.8, radius: 3.2, dmgMul: 2.8, targetHero: true, leaveBurn: true, cd: 5.0 },
      { id: 'meteorShower',  kind: 'multiCircle', telegraph: 0.9, count: 6, spawnInterval: 0.7, radius: 4.5, dmgMul: 2.4, spread: 13, cd: 13.0 },
    ],
  },
  50: {
    name: 'Drakkonungen',
    skills: [
      { id: 'dragonBreath', kind: 'sustainedCone',telegraph: 1.3, sustainDuration: 2.8, length: 16, halfAngle: Math.PI / 2.8, dpsMul: 2.0, cd: 8.5 },
      { id: 'wingSlam',     kind: 'groundCircle', telegraph: 1.0, radius: 7.5, dmgMul: 3.0, originSelf: true, knockback: 5.0, cd: 7.0 },
      { id: 'skyfireRain',  kind: 'multiCircle',  telegraph: 0.7, count: 10, spawnInterval: 0.6, radius: 4.0, dmgMul: 2.2, spread: 15, cd: 15.0 },
    ],
  },
};

// Mini-boss-mapping: 3 minibossar per tier (en per skill-index) presenterar
// kommande boss's skills i förhand så spelaren får träna på att dodga dem.
// Spawnar TILLSAMMANS med vanliga minions, lite starkare än minions.
const MINIBOSS_WAVE_MAP = {
  2:  { bossTier: 10, skillIdx: 0 },
  5:  { bossTier: 10, skillIdx: 1 },
  7:  { bossTier: 10, skillIdx: 2 },
  12: { bossTier: 20, skillIdx: 0 },
  15: { bossTier: 20, skillIdx: 1 },
  17: { bossTier: 20, skillIdx: 2 },
  22: { bossTier: 30, skillIdx: 0 },
  25: { bossTier: 30, skillIdx: 1 },
  27: { bossTier: 30, skillIdx: 2 },
  32: { bossTier: 40, skillIdx: 0 },
  35: { bossTier: 40, skillIdx: 1 },
  37: { bossTier: 40, skillIdx: 2 },
  42: { bossTier: 50, skillIdx: 0 },
  45: { bossTier: 50, skillIdx: 1 },
  47: { bossTier: 50, skillIdx: 2 },
};

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
      bossDef: BOSS_DEFS[waveNum] || null,
    };
  }
  const inTier = ((waveNum - 1) % 10) + 1;
  const def = {
    number: waveNum,
    name: WAVE_NAMES[tierIdx],
    isBoss: false,
    waveType,                            // 'melee' | 'mix' | 'range'
    count: WAVE_COUNT_PER_LANE * 2,
    monsterHp: Math.round(10 + tierIdx * 12 + inTier * 1.5),
    monsterDmg: Math.round((8 + tierIdx * 4 + inTier * 0.6) * 10) / 10,
    monsterSpeed: 2.0 + tierIdx * 0.05,
  };
  // Mini-boss på utvalda waves: spawnas TILLSAMMANS med vanliga minions
  const mbInfo = MINIBOSS_WAVE_MAP[waveNum];
  if (mbInfo) {
    const bossDef = BOSS_DEFS[mbInfo.bossTier];
    if (bossDef && bossDef.skills && bossDef.skills[mbInfo.skillIdx]) {
      def.minibossDef = {
        name: 'Mini ' + bossDef.name,
        skill: bossDef.skills[mbInfo.skillIdx],
        hp: Math.round(def.monsterHp * 4.5),     // ~4.5x minion-HP
        dmg: Math.round(def.monsterDmg * 1.6 * 10) / 10,   // 1.6x minion-DMG
        speed: def.monsterSpeed * 0.85,          // lite långsammare än minions
        bossTier: mbInfo.bossTier,
      };
    }
  }
  return def;
}

const CREEP_VS_CREEP_DAMAGE = 5;
const CREEP_VS_CREEP_RANGE = 1.5;
const CREEP_VS_CREEP_INTERVAL = 1.5;

// Monster ranged AA-projektil: travel-time buckets (sek) — picks deterministiskt
// per range-monster vid spawn. Hero tar damage först vid impact, inte vid cast.
const MONSTER_PROJ_TIME_BUCKETS = [0.5, 1.0, 1.5];
const MONSTER_PROJ_Y = 1.0;
// Projektil-utseende per wave-tier (index 0..4). Klienten ritar olika
// meshes baserat på 'k' (kind). Bossar har egna kinds (se BOSS_RANGE_AA).
const MONSTER_PROJ_KIND_PER_TIER = ['arrow', 'axe', 'darkOrb', 'fireball', 'dragonBolt'];
// Per-boss AA-projektil-config (line wars wave 10/20/30/40/50). Travel-times
// hålls inom 0.5-1.0s så hjälten ser projektilen komma men kan inte alltid dodga.
// Wave 40 (Demon Prince) är MELEE med +30% range — undantag i BOSS_MELEE_RANGE.
const BOSS_RANGE_AA = {
  10: { kind: 'bossAxe',      range: 7.0, interval: 1.5, travel: 0.6 },   // Captain — slänger yxa
  20: { kind: 'bossSpear',    range: 8.0, interval: 1.6, travel: 0.8 },   // General — blixtspjut
  30: { kind: 'darkOrb',      range: 7.5, interval: 1.7, travel: 1.0 },   // Warlord — gift-orb
  50: { kind: 'dragonBreath', range: 9.0, interval: 1.6, travel: 0.7 },   // Drakkonungen — eldspjut
};
// Bossar som är MELEE med override-range (annars defaultas bossar till 1.2m melee).
// Vanlig boss-melee-range har historiskt varit 2.4m; +30% = 3.12m.
const BOSS_MELEE_RANGE = {
  40: 3.1,   // Demon Prince — melee med +30% extended range
};

// Gandulf-skills (omgjorda)
// Fire Wave (Q): triangulär cone framför hero. Direkt dmg + 3s DoT.
const FIREWAVE_LENGTH = 6.5;               // Q cast-range +30% (5.0 → 6.5)
const FIREWAVE_HALF_ANGLE = Math.PI / 4;   // 45° → 90° total cone
const FIREWAVE_DIRECT_DMG = 18;
const FIREWAVE_DOT_DPS = 6;
const FIREWAVE_DOT_DURATION = 3.0;
const FIREWAVE_EFFECT_LIFE = 0.6;          // hur länge cone-mesh visas på klienten
// Frost Nova (F): target-AoE freeze + shatter
const NOVA_RADIUS = 3.8;
const NOVA_DAMAGE = 10;
const ICE_RAIN_DOT_INTERVAL = 0.5;   // Ice Rain (user 2026-06-24, was Frost Nova): DoT tick cadence
const ICE_RAIN_DOT_PCT = 0.05;       // 5% maxHP per tick over the 2s zone = 4 ticks (~20% maxHP)
const ICE_RAIN_DURATION = 2.0;       // zone persists 2s (DoT period + visual)
const NOVA_FREEZE_TIME = 1.5;   // nerf från 2.0: 2s hard-freeze/8s CD var för pressande i 1v1 (matchar klient)
const NOVA_CAST_DISTANCE = 7.8;            // F drag-räckvidd +30% (6.0 → 7.8)
const SHATTER_RADIUS = 2.5;
const SHATTER_DAMAGE = 15;
// Legolus-skills
const VINE_TRAP_RADIUS = 3.9;   // +30% (user 2026-06-24); was 3.0
const VINE_TRAP_DURATION = 2.0;   // nerf från 3.0 (~75% root-uptime i arena var för hög)
const VINE_TRAP_DOT_DPS = 8;
const VINE_TRAP_CAST_DISTANCE = 7;
const VINE_TRAP_ROOT_REFRESH = 0.25;     // håller frozenTime hög så länge i zonen
const LEGOLUS_BUFF_DURATION = 5.0;
const LEGOLUS_BUFF_DMG_PCT = 0.10;
const LEGOLUS_BUFF_CRIT_PCT = 0.10;
const LEGOLUS_BUFF_CRIT_DMG_PCT = 0.30;  // +30% crit damage (extra ovanpå 2x default)
const LEGOLUS_BUFF_AS_PCT = 0.30;        // Hunter's Focus: +30% attack speed under buff
const LEGOLUS_DASH_DISTANCE = 6.72;   // +20% (user 2026-06-24); was 5.6
const LEGOLUS_DASH_LIFESTEAL = 0.20;
// Passive: var 3:e AA → nästa AA är split + poison
const LEGOLUS_PASSIVE_EVERY = 3;
const LEGOLUS_SPLIT_EXTRAS = 2;
const LEGOLUS_SPLIT_RANGE = 6;     // hur långt extra targets kan vara från hero
const POISON_DURATION = 4.0;
const POISON_BASE_DPS = 5;         // per stack baseline
// === Kostefo skills ===
// Q: Joint Attack — gås-wave AoE DoT 3s, 5% maxHP per 0.5s tick
const KOSTEFO_GOOSEWAVE_DURATION = 3.0;
const KOSTEFO_GOOSEWAVE_TICK = 0.5;
const KOSTEFO_GOOSEWAVE_DMG_PCT = 0.05;
// Fyrkantig hit-zon (var rektangulär 3.6×6.5). Sida = 6.5 × 1.4 = 9.1 → +40% på max-dim.
const KOSTEFO_GOOSEWAVE_WIDTH = 9.1;     // fyrkant (matchar length)
const KOSTEFO_GOOSEWAVE_LENGTH = 9.1;    // räckvidd framåt
const KOSTEFO_GOOSEWAVE_OFFSET = 4.0;    // offset från hero (bibehållen)
const KOSTEFO_GOOSEWAVE_CD = 6.0;   // user 2026-06-26: +2s (eff. CD sätts via HERO_SKILL_CD.kostefo.q nedan; denna är fallback)
// F: Joint Slider — piercing projectile, 6m, explosion DoT + slow vid slutet
const KOSTEFO_SLIDER_RANGE = 12.0;       // user 2026-06-26: 2× range (var 6.0)
const KOSTEFO_SLIDER_SPEED = 7.0;        // ~0.86s flight på 6m (halverad från 14)
const KOSTEFO_SLIDER_RADIUS = 0.55;      // hit-radie för pierce
const KOSTEFO_SLIDER_DIRECT_PCT = 0.15;  // 15% maxHP direct
const KOSTEFO_SLIDER_DOT_DUR = 2.0;
const KOSTEFO_SLIDER_DOT_PER_SEC = 0.08; // 8% maxHP/s (nerf från 0.15: ~97%→67% maxHP/träff skalat)
const KOSTEFO_SLIDER_SLOW_DUR = 2.0;
const KOSTEFO_SLIDER_SLOW_MUL = 0.70;    // 30% slow → multiplier 0.7
const KOSTEFO_SLIDER_EXPLOSION_RADIUS = 2.5;
const KOSTEFO_SLIDER_CD = 7.0;
// E: Cannabis Cloud — smoke + invis + heal + buff (stationär dim-area vid cast-pos)
const KOSTEFO_CLOUD_DURATION = 4.0;
const KOSTEFO_CLOUD_RADIUS = 5.0;        // +25% från 4.0 per user-spec
const KOSTEFO_CLOUD_STUN_DUR = 1.0;
const KOSTEFO_CLOUD_TICK = 0.5;
const KOSTEFO_CLOUD_DMG_PCT = 0.05;      // 5% current HP per tick
const KOSTEFO_CLOUD_HEAL_PCT = 0.25;     // 25% maxHP direct heal vid cast
const KOSTEFO_CLOUD_MS_BONUS = 0.20;     // +20% movespeed under cloud
const KOSTEFO_CLOUD_AS_BONUS = 0.20;     // +20% attackspeed under cloud
const KOSTEFO_CLOUD_CD = 12.0;
// R (ult): Joint Avengers — 8 joints copy AA, 10% dmg, 50% lifesteal, 5s
const KOSTEFO_ULT_DURATION = 5.0;
const KOSTEFO_ULT_JOINT_COUNT = 8;
const KOSTEFO_ULT_DMG_RATIO = 1.00;      // user 2026-06-26: 2× igen (var 0.50). Håll i synk med OrbitJoints.DamageRatio (solo)
const KOSTEFO_ULT_LIFESTEAL = 0.50;
const KOSTEFO_ULT_ORBIT_RADIUS = 1.8;
const KOSTEFO_ULT_ORBIT_SPEED = 1.8;     // rad/sec
// Passive: Smoke Companion — 25% AA-dmg, alla träffar healar Kostefo med same summa
const KOSTEFO_COMPANION_DMG_RATIO = 0.25;
const KOSTEFO_COMPANION_FOLLOW_DIST = 1.6;
const KOSTEFO_COMPANION_AA_RANGE = 4.5;
const KOSTEFO_COMPANION_AA_INTERVAL = 0.9;

// Legolus ult (Shadow Volley): invis + empowered next-AA + thorn pool
const LEGOLUS_INVIS_DURATION = 5.0;
const LEGOLUS_INVIS_SPEED_BONUS = 0.20;     // +20% movespeed under invis
const LEGOLUS_ULT_AA_RANGE_MUL = 2.0;       // dubbel range på empowered AA
const LEGOLUS_ULT_AA_DMG_PCT = 0.20;        // 20% av target's maxHp (nerf -20% från 0.25)
const LEGOLUS_ULT_AA_STUN_DUR = 1.5;        // stun target + nearby 1.5s
const LEGOLUS_ULT_AA_STUN_RADIUS = 2.5;     // radie runt target för AoE-stun
const LEGOLUS_THORN_POOL_DURATION = 3.0;    // pool finns kvar 3s
const LEGOLUS_THORN_POOL_TICK = 0.5;        // tick var 0.5s
const LEGOLUS_THORN_POOL_DMG_PCT = 0.04;    // 4% maxHp per tick (nerf -20% från 0.05)
const LEGOLUS_THORN_POOL_RADIUS = 2.5;      // AoE-radie
// Gimlu
const TAUNT_RADIUS = 5.5;
const TAUNT_DURATION = 3.0;
const TAUNT_DMG_REDUCTION = 0.30;       // 30% mindre skada
const TAUNT_HEAL_PCT = 0.20;            // 20% av skada som tas tillbaka
const TAUNT_HEAL_PER_SEC = 0.20;        // 10% maxHP per 0.5s = 20%/sek passiv heal
const IRON_WILL_DURATION = 3.0;
const IRON_WILL_EXPLOSION_RADIUS = 6.0;
// Kryx-rework 2026-06-07: Q Titan's Stomp + F Titan's Rage (E/R orörda).
const STOMP_RADIUS = 5.5;
const STOMP_DMG_PCT = 0.25;            // initial AoE = 25% av targets maxHP (boss: via bossWarsDmgMod-cap)
const STOMP_DMG_PCT_HERO = 0.12;       // PvP-burst-nerf (balans 2026-06-08): 12% maxHP mot hjältar
const STOMP_DOT_PCT = 0.05;            // DoT 5% maxHP/sek
const STOMP_DOT_DUR = 3.0;
const STOMP_DR_HERO = 0.25, STOMP_DR_MINION = 0.05, STOMP_DR_BOSS = 0.50, STOMP_DR_DUR = 3.0;
const STOMP_SLOW_MUL = 0.60;           // 40% MS- OCH AS-slow
const STOMP_SLOW_DUR = 2.0;
const KRYX_DR_CAP = 0.70;              // tak på Kryx total-DR (passive+stomp+rage), user-beslut
const TITANS_RAGE_DURATION = 5.0;
const TITANS_RAGE_SELF = 0.25;         // +25% dmg/DR/MS/AS
const TITANS_RAGE_ALLY = 0.125;        // allies nära: hälften
const TITANS_RAGE_FEAR_DUR = 1.0;      // feared 1s (endast enemy-hero/PvP)
const TITANS_RAGE_LEECH_DUR = 1.0;     // efter fear: 1s där enemy-skada healar Kryx 100%
const TITANS_RAGE_RADIUS = 6.0;        // fear/ally-buff-radie
// Passive: Berserk-mätare (3 bars, 1 bar/10% maxHP taget). Full → nästa Q/F/E empowras.
const BERSERK_BAR_PCT = 0.10, BERSERK_FULL_PCT = 0.30;
const BERSERK_STOMP_RADIUS_MUL = 2.0, BERSERK_STOMP_DMG_MUL = 1.5, BERSERK_STOMP_SLOW_MUL = 0.40;   // empowered Stomp (100% AoE, +50% dmg, 60% slow)
const BERSERK_HAMMER_SIZE_MUL = 3.0, BERSERK_HAMMER_DMG_MUL = 1.5, BERSERK_HAMMER_HEAL_MUL = 1.5, BERSERK_HAMMER_SLOW_MUL = 0.50;
const HAMMER_SPEED = 12;
const HAMMER_RANGE = 11.7;   // K3: +30% (user) — was 9 (also aligns with the client SkillData preview)
const HAMMER_RADIUS = 0.8;
const HAMMER_DAMAGE = 25;
const HAMMER_LIFESTEAL = 0.15;
const HAMMER_RETURN_DMG_MUL = 0.5;
// Gimlu passive trösklar (Stalwart Resolve)
const GIMLU_PASSIVE_TIER1_HP = 0.80;   // <80% → 10% DR (var 20% — nerf 50%)
const GIMLU_PASSIVE_TIER1_DR = 0.10;
const GIMLU_PASSIVE_TIER2_HP = 0.60;   // <60% → +2.5%/s regen (var 5% — nerf 50%)
const GIMLU_PASSIVE_TIER2_REGEN = 0.025;
const GIMLU_PASSIVE_TIER3_HP = 0.40;   // <40% → +10% mer DR (var 20% — nerf 50%) + var 6:e dmg immun (var 3:e)
const GIMLU_PASSIVE_TIER3_DR = 0.10;
const GIMLU_PASSIVE_IMMUNE_EVERY = 6;
// Zyro passive (Arcane Convergence v2 — 2026-05-26 user-redesign)
// Per skill-hit: +1 stack (cap 3). Refreshar timer + adderar shield.
// Stack ger: +15% skill-dmg + +10% MS i 3s. Shield 10% maxHP per stack
// (cap 30%) - persistent tills shield-HP konsumerats av damage.
const GANDULF_BUFF_DURATION = 3.0;
const GANDULF_BUFF_SKILL_DMG_PER_STACK = 0.15;  // 15% skill-dmg per stack
const GANDULF_BUFF_MS_PER_STACK = 0.10;         // 10% movement speed per stack
const GANDULF_SHIELD_PER_STACK = 0.10;          // 10% maxHP shield per stack
const GANDULF_MAX_STACKS = 3;                   // cap stacks
// Legacy-konstanter (Soul Mark) — INTE LÄNGRE ANVÄNDA i nya passive-mekaniken,
// men behållna här för att undvika TDZ om gammal kod refererar dem under hot-reload.
const GANDULF_SHIELD_PER_HIT_PCT = 0;
const GANDULF_SHIELD_HITS = 999;
const GANDULF_SHIELD_PCT = 0;
// Black Hole (E): target-AoE pull + explosion vid slutet
const BLACKHOLE_RADIUS = 3.5;
const BLACKHOLE_PULL_SPEED = 2.5;
const BLACKHOLE_DURATION = 3.0;
const BLACKHOLE_EXPLOSION_RADIUS = 4.0;
const BLACKHOLE_EXPLOSION_DMG = 30;
const BLACKHOLE_CAST_DISTANCE = 10.4;      // E cast-range +30% (8.0 → 10.4)
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
const FOUNTAIN_AURA_REGEN_PCT = 0.03; // 3% av maxHp per sekund
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
const MONSTER_XP_REWARD = 7;       // -30% (var 10) — sänker level-fart i tidigt spel
const CREEP_XP_RATIO = 0.42;       // -30% (var 0.6)

// Skill-point-system (decision-pending). Hero börjar med 1 point på lvl 1, får
// +1 per level-up → totalt 30 points över hela matchen. Q/F/E unlockas + uppgraderas
// via points (max 5 per skill). R unlockas gratis vid hero-level 10 (ingen point-kostnad).
// Resterande points (upp till 15) spenderas på 5 stats (max 5 per stat).
const POINTS_PER_LEVEL = 1;
const STARTING_POINTS = 1;
const SKILL_LEVEL_MAX = 5;
const STAT_LEVEL_MAX = 5;
const ULT_UNLOCK_LEVEL = 10;
const SKILL_LEVEL_DMG_PER_PT = 0.25;   // +25% skada per skill-level (lvl 5 = +100% vs lvl 1)

// === Max-level (lvl 5) bonus-effekter per skill (decision-pending) ===
// Gandulf
const GANDULF_LVL5_WP_MS_DURATION = 1.5;   // Wind Puff lvl5: caster MS-buff varaktighet
const GANDULF_LVL5_WP_MS_MUL = 1.30;       // +30% movement speed
const GANDULF_LVL5_FN_AS_DURATION = 3.0;   // Frost Nova lvl5: enemies AS-slow varaktighet
const GANDULF_LVL5_FN_AS_MUL = 0.50;       // -50% attack speed (halverar AA-frekvens)
const GANDULF_LVL5_BH_STUN_DURATION = 1.0; // Black Hole lvl5: stun varaktighet vid explosion
// Legolas
const LEGOLAS_LVL5_VT_MARK_DURATION = 3.0; // Vine Trap lvl5: mark-varaktighet på rootade enemies
const LEGOLAS_LVL5_VT_MARK_DMG_MUL = 1.20; // +20% dmg från Legolas på marked targets
const LEGOLAS_LVL5_HF_AA_CDR = 0.3;        // Hunter's Focus lvl5: -0.3s dash-CD per AA under buff
// Dash lvl5: 2 stacks (separate CDs) — implementerat via side.nyroDashStackCd vid sidan av side.skills.e.cd
// Gimlu
const GIMLU_LVL5_TT_HEAL_PCT = 0.50;           // Taunt lvl5: 50% av healing-during-taunt → AoE-skada
const GIMLU_LVL5_TT_EXPLOSION_RADIUS = 3.5;    // Taunt-explosion radie
const GIMLU_LVL5_IW_REFLECT_PCT = 0.30;        // Iron Will lvl5: 30% av incoming dmg reflekteras
const GIMLU_LVL5_IW_REFLECT_RADIUS = 3.0;      // Reflect-AoE radie runt Gimlu
const GIMLU_LVL5_HAMMER_MS_DURATION = 1.0;     // Hammer lvl5: caster MS-buff varaktighet
const GIMLU_LVL5_HAMMER_MS_MUL = 1.50;         // +50% MS
const GIMLU_LVL5_HAMMER_SLOW_DURATION = 2.0;   // Hammer lvl5: slow på hit-targets
const GIMLU_LVL5_HAMMER_SLOW_MUL = 0.80;       // -20% MS på hit
// Aragurn
const ARAGURN_LVL5_SHOUT_PULL_PCT = 0.5;       // War Shout lvl5: dra targets halvvägs mot Aragurn
const ARAGURN_LVL5_SHOUT_STUN_DURATION = 1.0;  // 1s stun på hit
const ARAGURN_LVL5_BANNER_DURATION = 5.0;      // Hero Leap lvl5: banner-livstid
const ARAGURN_LVL5_BANNER_RADIUS = 4.5;        // banner-aura-radie
const ARAGURN_LVL5_BANNER_HEAL_PCT = 0.05;     // 5% max HP/s heal
const ARAGURN_LVL5_BANNER_AS_BONUS = 0.10;     // +10% AS
const ARAGURN_LVL5_BANNER_MS_BONUS = 0.10;     // +10% MS
const ARAGURN_LVL5_BANNER_DR_BONUS = 0.20;     // -20% incoming dmg
// Kostefo
const KOSTEFO_LVL5_Q_SLOW_DURATION = 2.0;      // Joint Attack lvl5: slow på hit-targets
const KOSTEFO_LVL5_Q_SLOW_MUL = 0.50;          // -50% MS
const KOSTEFO_LVL5_Q_LIFESTEAL_PCT = 0.10;     // 10% lifesteal av skill-dmg
const KOSTEFO_LVL5_SLIDER_TP_WINDOW = 3.0;     // Joint Slider lvl5: 3s re-cast-window för tp
const KOSTEFO_LVL5_CLOUD_RADIUS_MUL = 1.20;    // Cannabis Cloud lvl5: +20% radie
const KOSTEFO_LVL5_CLONE_LIFETIME = 5.0;       // klon lever 5s
const KOSTEFO_LVL5_CLONE_SPEED = 4.0;          // base run speed
// Stat-point-bonusar per point (additivt till motsvarande pct i recomputeSideStats)
const STAT_KEYS = ['as', 'ms', 'hp', 'sd', 'dr'];
const STAT_PER_POINT = {
  as: 0.05,    // +5% attackSpeedPct
  ms: 0.03,    // +3% moveSpeedPct
  hp: 0.05,    // +5% maxHpPct
  sd: 0.05,    // +5% skillDmgPct
  dr: 0.03,    // +3% dmgReductionPct
};

// Hero pick-fas
const PICK_PHASE_DURATION = 60; // sek

// Duel-system: var 5:e min stannar lane-fas och båda hjältar slåss i arena
const DUEL_INTERVAL = 600;      // sekunder mellan dueler (10 min — första duel 10 min in)
const DUEL_DURATION = 90;       // max sekunder per duel
const DUEL_MAX_COUNT = 4;
const DUEL_REWARDS_GOLD = [500, 1500, 5000, 10000];
const DUEL_ANNOUNCE_TIME = 4;   // sek att visa vinnare efter duel
// Arena ligger separat från huvudkartan (centrum z=35)
const ARENA_CX = 0;
const ARENA_CZ = 48;   // duel-arena flyttad 35->48 ut ur det ×1.3-breddade fältet (krockade med yttre lanen)
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
// Decision 106: Clone-knappen i minion-shoppen — 100% stats (vs duel-clonens 70%).
const CLONE_COST = 50000;
const CLONE_STAT_RATIO = 1.0;
const HERO_COPY_TOWER_DAMAGE = 10;
const HERO_COPY_ATTACK_RANGE = 4.0;
const HERO_COPY_ATTACK_INTERVAL = 1.2;
const HERO_COPY_SKILL_INTERVAL = 6.0; // hur ofta boten castar Eldklot (legacy = qInterval)
const HERO_COPY_AGGRO_RANGE = 5.5;
const HERO_COPY_RADIUS = 0.45;   // XP = creep.cost * 0.6
// Decision 107: hero-copy cyklar 3 skills (Q/F/E) istället för bara en.
const HERO_COPY_Q_INTERVAL = 6.0;    // single fireball
const HERO_COPY_F_INTERVAL = 10.0;   // triple fireball-spread (3 i kon)
const HERO_COPY_E_INTERVAL = 8.0;    // dash-strike (gap close + AA-burst)
const HERO_COPY_DASH_DISTANCE = 2.5;
const HERO_COPY_DASH_DMG_MUL = 1.8;  // dash AA-skadan = attackDmg × 1.8
const HERO_COPY_F_DMG_MUL = 0.6;     // varje fireball i triple-spread = skillDmg × 0.6
const HERO_COPY_F_SPREAD = 0.26;     // ~15° i radianer

// Decision 105: tier-unlock-kostnader × 1.5 (svårare att stiga i tier).
const TIER_UNLOCK_COST = { 2: 300, 3: 750, 4: 1500, 5: 3000 };
// Decision 105: minions +30% HP/dmg, +50% kostnad.
const MINION_HP_MUL = 1.3;
const MINION_DMG_MUL = 1.3;
const MINION_COST_MUL = 1.5;

// === Minion-data ===
const ARCHETYPE_BASE = {
  // Range-justering (användarbeslut 2026-06-04): ranged (archer/mage) 3.5→5.5 så de
  // skjuter tydligt på avstånd (stop-dist = range-0.5 ⇒ skott från ~5m, AA-anim läses
  // som ranged). Melee +0.3 så de stannar och svingar i st f att clippa in i målet.
  slasher:  { cost: 10, hp: 18, speed: 1.6,  damage: 3, range: 1.3, interval: 0.8, attackType: 'melee' },
  archer:   { cost: 14, hp: 15, speed: 1.4,  damage: 4, range: 5.5, interval: 1.2, attackType: 'arrow' },
  bruiser:  { cost: 18, hp: 32, speed: 1.3,  damage: 5, range: 1.5, interval: 1.3, attackType: 'melee' },
  mage:     { cost: 22, hp: 20, speed: 1.3,  damage: 7, range: 5.5, interval: 1.5, attackType: 'magic', aoeRadius: 1.6 },
  tank:     { cost: 26, hp: 60, speed: 1.15, damage: 2, range: 1.3, interval: 1.4, attackType: 'melee' },
  champion: { cost: 35, hp: 48, speed: 1.3,  damage: 8, range: 1.8, interval: 1.5, attackType: 'melee' },
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
      cost: Math.round(base.cost * mult * MINION_COST_MUL),
      hp: Math.round(base.hp * mult * MINION_HP_MUL),
      speed: base.speed,
      damage: Math.round(base.damage * mult * MINION_DMG_MUL),
      range: base.range,
      interval: base.interval,
      attackType: base.attackType,
      aoeRadius: base.aoeRadius || 0,
    };
  }
}
const MINION_KILL_RATIO = 0.2;
// Range-minion AA-projektiler: flight time 0.5-1.5s. Pil långsammast (~1.2s på
// 3.5 m range), magic (fireball) snabbare (~0.6s). Skadan applieras vid hit, ej
// vid skott — hero hinner se projektilen flyga och kan röra sig.
const ARROW_SPEED = 3.0;     // 3.5 m range / 3.0 m/s ≈ 1.17s flight
const MAGIC_PROJ_SPEED = 6.0; // 3.5 m range / 6.0 m/s ≈ 0.58s flight

// === Items ===
const ITEM_BUY_COST = 200;
const ITEM_MAX_LEVEL = 10;
const INVENTORY_SLOTS = 4;
const SKILL_BASE_CD = { q: 4.0, f: 8.0, e: 10.0 };
// Ult-energy: fills 0.5%/s passivt + 5% per skill-hit + 3% per AA-hit. Vid 100% kan
// klienten casta R (ult). Matchar main.js ULT_GAIN_*-konstanter.
const ULT_ENERGY_MAX = 100;
const ULT_GAIN_PASSIVE = 0.5;
const ULT_GAIN_SKILL_HIT = 5;
const ULT_GAIN_AA_HIT = 3;
const ULT_GAIN_SKILL_CAST_CAP = 10;   // Max gain per skill-cast oavsett antal träffar (AoE-fix)
const ULT_LOCKOUT_AFTER_CAST = 5.0;   // Sek ingen ult-gain efter ult-cast
const GIMLU_ULT_GAIN_ON_DMG_PCT = 0.05;   // 5% av damage taken som ult-gain (tank-mekanik)
const GIMLU_ULT_GAIN_PER_HIT_CAP = 2;     // Max 2% per damage-instance
// Lockout-aware: blockerar passive + AA + skill-hit-gain i 5s efter ult-cast
function gainUltEnergy(side, amount) {
  if (!side || side.hero.dead) return;
  if ((side._ultLockoutTime || 0) > 0) return;
  side.ultEnergy = Math.min(ULT_ENERGY_MAX, (side.ultEnergy || 0) + amount);
}
// Skill-hit-gain med per-cast-cap. Reset:as via _ultCapThisCast i applyEvent's
// skill-gren. Förhindrar att AoE-skills (leap, frostnova, etc.) fyller ult
// proportionellt till antal träffar.
function gainUltOnSkillHit(side) {
  if (!side || side.hero.dead) return;
  if ((side._ultLockoutTime || 0) > 0) return;
  const cap = (side._ultCapThisCast == null) ? 0 : side._ultCapThisCast;
  if (cap <= 0) return;
  const amt = Math.min(ULT_GAIN_SKILL_HIT, cap);
  side._ultCapThisCast = cap - amt;
  side.ultEnergy = Math.min(ULT_ENERGY_MAX, (side.ultEnergy || 0) + amt);
}
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

// === Side config === (decision 041: lane-Z ×1.2, lane-X ×1.3)
// Lanes widened (~+25%: laneZ + half-width ×1.25) and lengthened (~+30%: west extent),
// base scaled to match (user 2026-06-14). Client LineWarsMpMode geometry mirrors these.
const SIDE_CFG = {
  // Lane-Z-layout skalad ×1.3 (2026-06-15: 30% bredare/mer utspridda lanes). Lane-centra
  // ±6/±18 → ±7.8/±23.4, väggar/torn/spawn/bas följer ×1.3. Marginal hjältekropp↔vägg = 0.286.
  1: { laneZ: { 1: 23.4, 2: 7.8 },   spawnX: -53, baseZRange: [0.65, 29.25],   tower: { x: 30, z: 15.6 },  heroSpawn: { x: 15, z: 15.6 } },
  2: { laneZ: { 1: -7.8, 2: -23.4 }, spawnX: -53, baseZRange: [-29.25, -0.65], tower: { x: 30, z: -15.6 }, heroSpawn: { x: 15, z: -15.6 } },
};

// Portal-feature: lvl-30 hero kan teleportera till motståndarens lanes för PvP-raid.
const PORTAL_MAX_USES = 3;
const PORTAL_COOLDOWN = 60;          // 1 minut mellan teleports
const PORTAL_ENEMY_DURATION = 30;    // 30s i fiendens territorium
const PORTAL_REQUIRED_LEVEL = 30;
const PORTAL_ENTER_RADIUS = 1.3;
const PORTAL_POS = {
  // Matchar visuella portal-mesharna (skalat ×1.3 med lane-layouten 2026-06-15)
  1: { x: 22, z: 25.35 },
  2: { x: 22, z: -25.35 },
};
// Teleport-destination i motståndarens territorium (skalat ×1.3)
const PORTAL_DEST = {
  1: { x: 0, z: -15.6 },
  2: { x: 0, z: 15.6 },
};
// === Walk-checks === (lane-Z-layout ×1.3 2026-06-15: halvbredd 4.28→5.564, centra utspridda ×1.3)
function inLane(x, z, centerZ) {
  // Hero walkable half-width 5.0 (was 5.564): the hero stops ~1.3 wu before the divider
  // walls so its body/marker (radius ~0.8) no longer sinks into the wall mesh. The VISUAL
  // lane platforms stay full width (11.128) — this just adds a small no-walk shoulder.
  return x >= -54.5 && x <= 11 && z >= centerZ - 5.0 && z <= centerZ + 5.0;
}
function inSideLanes(idx, x, z) {
  const cfg = SIDE_CFG[idx];
  return inLane(x, z, cfg.laneZ[1]) || inLane(x, z, cfg.laneZ[2]);
}
function inSideBase(idx, x, z) {
  const cfg = SIDE_CFG[idx] || SIDE_CFG[1]; // fallback för boss wars/team-arena (idx 3/4) — annars kraschar shop-köp
  const [zMin, zMax] = cfg.baseZRange;
  return x >= 10.6 && x <= 36.5 && z >= zMin && z <= zMax; // base depth 27.55->36.5 (deeper base, user 2026-06-16)
}
function isHeroWalkable(idx, x, z, opts) {
  const cfg = SIDE_CFG[idx];
  const dx = x - cfg.tower.x, dz = z - cfg.tower.z;
  if (dx * dx + dz * dz < (TOWER_R + HERO_R) * (TOWER_R + HERO_R)) return false;
  // I fiendens territorium (portal-trip): tillåt opp:s lanes + base (men inte opp:s tower)
  if (opts && opts.inEnemyTerritory) {
    const oppIdx = 3 - idx;
    const oppCfg = SIDE_CFG[oppIdx];
    const oddx = x - oppCfg.tower.x, oddz = z - oppCfg.tower.z;
    if (oddx * oddx + oddz * oddz < (TOWER_R + HERO_R) * (TOWER_R + HERO_R)) return false;
    if (inSideBase(oppIdx, x, z) || inSideLanes(oppIdx, x, z)) return true;
    // Annars faller den tillbaka till normal walkable (egen sida)
  }
  return inSideBase(idx, x, z) || inSideLanes(idx, x, z);
}
function isArenaWalkable(x, z) {
  const dx = x - ARENA_CX, dz = z - ARENA_CZ;
  return (dx * dx + dz * dz) < (ARENA_RADIUS - HERO_R) * (ARENA_RADIUS - HERO_R);
}
function isCreepPos(x, z) {
  // Scaled with the wider/longer lanes (2026-06-14). Lane x-min covers the spawn clumps
  // behind spawnX (-53 minus ~3 rows). Base z ±29.25, lane half-width 5.564 (×1.3-layout).
  if (x >= 10.6 && x <= 36.5 && z >= 0.65 && z <= 29.25) return true;
  if (x >= 10.6 && x <= 36.5 && z >= -29.25 && z <= -0.65) return true;
  const inLaneWide = (cz) => x >= -58 && x <= 11 && z >= cz - 5.564 && z <= cz + 5.564;
  return inLaneWide(23.4) || inLaneWide(7.8) || inLaneWide(-7.8) || inLaneWide(-23.4);
}

// ===== BOSS WARS — arena-walkability (server-auth Fas 2, decision 122) =====
// Layout-konstanter speglade EXAKT från main.js (boss-rum + korridor + spawn-rum)
// så servern matchar klientens isBossWarsPos byte-för-byte — annars rubber-band
// (buggmönster #9: geometri-antaganden). Samma namn som klienten för port-trohet.
// ADDITIVT — oanropat tills tickBossWars/applyMovement wirar in det (slice 0/1).
const BOSSWARS_CX = 0, BOSSWARS_CZ = 90, BOSSWARS_RADIUS = 36, BOSSWARS_FLOOR_Y = 0.42;
const BOSSWARS_MAX_HIT_FRAC = 0.05;   // fallback-tak om bossTier saknas
// Tier-graderat tak (användarbeslut 2026-06-07): platta 5% gjorde alla tiers ~20 hits.
// T1 lättare (6% → ~17 hits), T5 svårare (4% → ~25 hits). Per-hit-andel av maxHp.
const BOSSWARS_TIER_MAX_HIT_FRAC = { 1: 0.06, 2: 0.055, 3: 0.05, 4: 0.045, 5: 0.04 };
const BOSS_GATE_X = BOSSWARS_CX - BOSSWARS_RADIUS;            // -36 (boss-rummets västsida)
const BW_CORRIDOR_LENGTH = 26, BW_CORRIDOR_WIDTH = 9;
const BW_CORRIDOR_HALF_W = BW_CORRIDOR_WIDTH / 2;             // 4.5
const BW_CORRIDOR_X_MIN = BOSS_GATE_X - BW_CORRIDOR_LENGTH;   // -62
const BW_CORRIDOR_X_MAX = BOSS_GATE_X;                        // -36
const BW_SPAWN_ROOM_SIZE = 24, BW_SPAWN_ROOM_HALF = BW_SPAWN_ROOM_SIZE / 2;  // 12
const BW_SPAWN_ROOM_CX = BW_CORRIDOR_X_MIN - BW_SPAWN_ROOM_HALF;  // -74
const BW_SPAWN_ROOM_CZ = BOSSWARS_CZ;                             // 90
const BW_GATE_THICKNESS = 0.5;
// Spegel av main.js isBossWarsPos. gateClosed passas explicit (engine har ingen APP-global).
function isBossWarsWalkable(x, z, gateClosed) {
  // 1) Gate-block: stängd gate spärrar korridor-utgången in i boss-rummet.
  if (gateClosed) {
    const inGateBand = Math.abs(x - BOSS_GATE_X) < (BW_GATE_THICKNESS / 2 + 0.45);
    const inGateZ = Math.abs(z - BOSSWARS_CZ) < (BW_CORRIDOR_HALF_W + 0.4);
    if (inGateBand && inGateZ) return false;
  }
  // 2) Spawn-rum (kvadrat västra sidan)
  const sdx = x - BW_SPAWN_ROOM_CX, sdz = z - BW_SPAWN_ROOM_CZ;
  if (Math.abs(sdx) < BW_SPAWN_ROOM_HALF - 0.5 && Math.abs(sdz) < BW_SPAWN_ROOM_HALF - 0.5) return true;
  // 3) Korridor (med 6m overlap in i boss-rummet)
  if (x >= BW_CORRIDOR_X_MIN - 0.5 && x <= BW_CORRIDOR_X_MAX + 6 &&
      Math.abs(z - BOSSWARS_CZ) < BW_CORRIDOR_HALF_W - 0.3) return true;
  // 4) Boss-rum: cirkel oavsett tier-shape
  const dx = x - BOSSWARS_CX, dz = z - BOSSWARS_CZ;
  const r = BOSSWARS_RADIUS - 0.5;
  return (dx * dx + dz * dz) < r * r;
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
  let levelsGained = 0;
  while (side.level < MAX_LEVEL && side.xp >= side.xpToNext) {
    side.xp -= side.xpToNext;
    side.level += 1;
    side.xpToNext = xpForLevel(side.level);
    leveled = true;
    levelsGained++;
  }
  if (side.level >= MAX_LEVEL) {
    side.xp = 0;
    side.xpToNext = 0;
  }
  if (levelsGained > 0) {
    side.unspentPoints = (side.unspentPoints || 0) + POINTS_PER_LEVEL * levelsGained;
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
  // Stat-points: applicera additivt på motsvarande pct-stats
  if (side.statPts) {
    attackSpeedPct += (side.statPts.as || 0) * STAT_PER_POINT.as;
    moveSpeedPct += (side.statPts.ms || 0) * STAT_PER_POINT.ms;
    maxHpPct += (side.statPts.hp || 0) * STAT_PER_POINT.hp;
    skillDmgPct += (side.statPts.sd || 0) * STAT_PER_POINT.sd;
    dmgReductionPct += (side.statPts.dr || 0) * STAT_PER_POINT.dr;
  }
  // Boss Wars-loadout: talents + items stat-bonusar (mirror main.js recomputeSideStats
  // 15834-15842). Foldas in i samma accumulator → läggs på FÖRE level-mult, exakt som klienten.
  let _bwAaLifesteal = 0, _bwCritDmgBonus = 0, _bwPhoenix = false;
  if (side.inBossWars) {
    const _applyBw = (def) => {
      if (!def) return;
      if (def.stats) addStats(def.stats);
      if (def.lifestealOnAa) _bwAaLifesteal += def.lifestealOnAa;
      if (def.critDmgBonus) _bwCritDmgBonus += def.critDmgBonus;
      if (def.phoenixRevive) _bwPhoenix = true;
    };
    if (side.bossWarsTalents) for (const tid of side.bossWarsTalents) _applyBw(ENGINE_BOSS_WARS_TALENTS[tid]);
    if (side.bossWarsItems) for (const iid of side.bossWarsItems) _applyBw(ENGINE_BOSS_WARS_ITEMS[iid]);
  }
  // Per-skill level-mult (för tick-skills som kan läsa skillLvlMul[key] live)
  side.skillLvlMul = {
    q: 1 + SKILL_LEVEL_DMG_PER_PT * Math.max(0, ((side.skillLvl && side.skillLvl.q) || 1) - 1),
    f: 1 + SKILL_LEVEL_DMG_PER_PT * Math.max(0, ((side.skillLvl && side.skillLvl.f) || 1) - 1),
    e: 1 + SKILL_LEVEL_DMG_PER_PT * Math.max(0, ((side.skillLvl && side.skillLvl.e) || 1) - 1),
    r: 1,
  };
  // Level-skalning ovanpå items: +4% dmg/HP/skill-dmg, +1% movespeed per level (utöver lvl 1)
  const lvl = (side.level || 1) - 1;
  const levelDmgMul = 1 + LEVEL_DMG_PCT * lvl;
  const levelHpMul = 1 + LEVEL_HP_PCT * lvl;
  const levelMsMul = 1 + LEVEL_MS_PCT * lvl;
  side.attackDmg = attackDmg * levelDmgMul;
  side.moveSpeed = moveSpeedFlat * (1 + moveSpeedPct) * levelMsMul * MOVE_SPEED_FEEL_MUL;
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
  // Per-hero CD-override för specifika skills. Legolas Shadow Dash = 6s
  // (var 10s default) — buff för rörlighet. Kostefo Cannabis Cloud = 12s
  // (var 10s default) — längre CD för stark sustain-skill. Övriga = base.
  const HERO_SKILL_CD = { nyro: { e: 6.0 }, kostefo: { q: 6.0, e: 12.0 }, zheyna: { q: 9.0, f: 10.0, e: 12.0 } };
  const heroCd = HERO_SKILL_CD[side.heroId] || {};
  side.skills.q.max = (heroCd.q !== undefined ? heroCd.q : SKILL_BASE_CD.q) * side.cdrMul;
  side.skills.f.max = (heroCd.f !== undefined ? heroCd.f : SKILL_BASE_CD.f) * side.cdrMul;
  side.skills.e.max = (heroCd.e !== undefined ? heroCd.e : SKILL_BASE_CD.e) * side.cdrMul;
  // Boss Wars-extras (mirror main.js 15880-15891): crit-dmg läses i combat via side.critDmgMul.
  // AA-lifesteal + phoenix-revive-BETEENDE = Phase B (fälten sätts här, behavior wiras separat).
  if (side.inBossWars) {
    side.critDmgMul = 2.0 + _bwCritDmgBonus;
    side.aaLifestealPct = _bwAaLifesteal;
    side.phoenixReviveAvailable = _bwPhoenix && (side.phoenixReviveAvailable !== false);
  }
}

// ── Arena-talents (server-side kopia av main.js ARENA_TALENTS) ──
// Stat-talents: appliceras i recomputeArenaSideStats efter recomputeSideStats.
// Skill-modifier-talents: läses via engineHasTalent(state, side, id) i cast/tick-funktioner.
const ENGINE_ARENA_TALENTS = {
  zyro: [
    { id: 'm_skill',        stats: { skillDmgPct: 0.10 } },
    { id: 'm_cdr',          stats: { cdrPct: 0.10 } },
    { id: 'm_hp',           stats: { maxHpPct: 0.15 } },
    { id: 'm_dr',           stats: { dmgReductionPct: 0.10 } },
    { id: 'm_ms',           stats: { moveSpeedPct: 0.10 } },
    { id: 'm_frost_heal' }, // Frost Nova heals 15% of damage dealt
    { id: 'm_drain_extend' }, // Soul Drain +2s (5s → 7s)
    { id: 'm_bh_radius' },  // Black Hole radius + explosion +30%
  ],
  nyro: [
    { id: 'l_dmg',          stats: { attackDmg: 5 } },
    { id: 'l_as',           stats: { attackSpeedPct: 0.15 } },
    { id: 'l_crit',         stats: { critChancePct: 0.10 } },
    { id: 'l_ms',           stats: { moveSpeedPct: 0.10 } },
    { id: 'l_cdr',          stats: { cdrPct: 0.10 } },
    { id: 'l_vine_dot' },   // Vine Trap DoT doubles damage
    { id: 'l_focus_dur' },  // Hunter's Focus +2s duration
    { id: 'l_dash_buff' },  // Shadow Dash lifesteal 20% → 50%
  ],
  kryx: [
    { id: 'g_hp',           stats: { maxHpPct: 0.15 } },
    { id: 'g_dr',           stats: { dmgReductionPct: 0.10 } },
    { id: 'g_dmg',          stats: { attackDmg: 5 } },
    { id: 'g_as',           stats: { attackSpeedPct: 0.10 } },
    { id: 'g_regen',        stats: { healPerSecPct: 0.02 } },
    { id: 'g_taunt_heal' }, // Titan's Taunt heal +50%
    { id: 'g_iron_radius' }, // Iron Will explosion +30%
    { id: 'g_hammer_full' }, // Hammer return 100% damage
  ],
  elar: [
    { id: 'a_dmg',          stats: { attackDmg: 6 } },
    { id: 'a_hp',           stats: { maxHpPct: 0.15 } },
    { id: 'a_as',           stats: { attackSpeedPct: 0.12 } },
    { id: 'a_dr',           stats: { dmgReductionPct: 0.12 } },
    { id: 'a_ms',           stats: { moveSpeedPct: 0.10 } },
    { id: 'a_spin_extend' }, // Whirlwind +1.5s
    { id: 'a_shout_radius' }, // Shout cone +30%
    { id: 'a_leap_heal' },  // Hero Leap heal 10% → 15%
  ],
  kostefo: [
    { id: 'k_skill',        stats: { skillDmgPct: 0.10 } },
    { id: 'k_cdr',          stats: { cdrPct: 0.10 } },
    { id: 'k_hp',           stats: { maxHpPct: 0.15 } },
    { id: 'k_dr',           stats: { dmgReductionPct: 0.10 } },
    { id: 'k_ms',           stats: { moveSpeedPct: 0.10 } },
    { id: 'k_dmg',          stats: { attackDmg: 5 } },
    { id: 'k_as',           stats: { attackSpeedPct: 0.12 } },
    { id: 'k_crit',         stats: { critChancePct: 0.10 } },
  ],
  zheyna: [
    { id: 'z_dmg',          stats: { attackDmg: 6 } },
    { id: 'z_as',           stats: { attackSpeedPct: 0.15 } },
    { id: 'z_crit',         stats: { critChancePct: 0.10 } },
    { id: 'z_hp',           stats: { maxHpPct: 0.15 } },
    { id: 'z_dr',           stats: { dmgReductionPct: 0.10 } },
    { id: 'z_ms',           stats: { moveSpeedPct: 0.10 } },
    { id: 'z_skill',        stats: { skillDmgPct: 0.10 } },
    { id: 'z_cdr',          stats: { cdrPct: 0.10 } },
  ],
};

// ── Boss Wars-loadout (server-side kopia av main.js BOSS_WARS_TALENTS/ITEMS) ──
// Stat-bonusar foldas in i recomputeSideStats (boss-wars-gren, additivt före level-mult,
// exakt som klienten). critDmgBonus → side.critDmgMul (läses redan i combat). lifestealOnAa +
// phoenixRevive = beteende (Phase B). Spelaren väljer 3 talents + 4 items i prep.
const ENGINE_BOSS_WARS_TALENTS = {
  bwt_hp:    { stats: { maxHpPct: 0.25 } },
  bwt_as:    { stats: { attackSpeedPct: 0.20 } },
  bwt_dmg:   { stats: { attackDmg: 12 } },
  bwt_skill: { stats: { skillDmgPct: 0.20 } },
  bwt_cdr:   { stats: { cdrPct: 0.15 } },
  bwt_dr:    { stats: { dmgReductionPct: 0.18 } },
  bwt_ls:    { stats: {}, lifestealOnAa: 0.12 },
  bwt_crit:  { stats: { critChancePct: 0.15 }, critDmgBonus: 0.25 },
  bwt_ms:    { stats: { moveSpeedPct: 0.15 } },
  bwt_heal:  { stats: { healPerSecPct: 0.02 } },
};
const ENGINE_BOSS_WARS_ITEMS = {
  bwi_blade:    { stats: { attackDmg: 15, attackSpeedPct: 0.15 } },
  bwi_helm:     { stats: { maxHpPct: 0.35 } },
  bwi_boots:    { stats: { moveSpeedPct: 0.25 } },
  bwi_cape:     { stats: { dmgReductionPct: 0.20 } },
  bwi_amulet:   { stats: { skillDmgPct: 0.30 } },
  bwi_ring:     { stats: { cdrPct: 0.20, attackSpeedPct: 0.15 } },
  bwi_tome:     { stats: { skillDmgPct: 0.35, maxHpPct: 0.15 } },
  bwi_gauntlet: { stats: { attackDmg: 18 }, lifestealOnAa: 0.15 },
  bwi_crit:     { stats: { critChancePct: 0.25 }, critDmgBonus: 0.35 },
  bwi_phoenix:  { stats: { maxHpPct: 0.10 }, phoenixRevive: true },
};

// Kolla om en side valt en specifik talent (för arena server-auth skill-modifier-logic).
function engineHasTalent(state, side, talentId) {
  if (!state || !state.talents) return false;
  const t = state.talents[side.idx];
  return !!(t && t.chosen && t.chosen.includes(talentId));
}

// Räknar om stats inklusive arena-talents (stat-talents ovanpå recomputeSideStats).
// Speglar main.js:recomputeArenaSideStats. Kräver state för talents-lookup.
function recomputeArenaSideStats(state, side) {
  recomputeSideStats(side);
  if (!state || !state.talents) return;
  const heroId = side.heroId || 'zyro';
  const talentList = ENGINE_ARENA_TALENTS[heroId] || [];
  const chosen = (state.talents[side.idx] && state.talents[side.idx].chosen) || [];
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
  side.attackDmg = (side.attackDmg || 0) + attackDmgFlat;
  side.attackSpeedMul = (side.attackSpeedMul || 1) * (1 + attackSpeedPct);
  side.moveSpeed = (side.moveSpeed || HERO_BASE_MOVE_SPEED) * (1 + moveSpeedPct);
  side.skillDmgMul = (side.skillDmgMul || 1) * (1 + skillDmgPct);
  side.cdrMul = Math.max(0.1, (side.cdrMul || 1) * (1 - cdrPct));
  side.dmgReductionMul = Math.max(0.0, (side.dmgReductionMul || 1) * (1 - dmgReductionPct));
  const maxHpBefore = side.hero.maxHp;
  side.hero.maxHp = Math.round(side.hero.maxHp * (1 + maxHpPct));
  if (side.hero.maxHp > maxHpBefore) {
    side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + (side.hero.maxHp - maxHpBefore));
  }
  side.critChancePct = Math.min(1, (side.critChancePct || 0) + critChancePct);
  side.healPerSecPct = (side.healPerSecPct || 0) + healPerSecPct;
  // Uppdatera CD-max för skills efter ev. cdrPct-förändring
  if (cdrPct !== 0) {
    const HERO_SKILL_CD = { nyro: { e: 6.0 }, kostefo: { q: 6.0, e: 12.0 }, zheyna: { q: 9.0, f: 10.0, e: 12.0 } };
    const heroCd = HERO_SKILL_CD[side.heroId] || {};
    side.skills.q.max = (heroCd.q !== undefined ? heroCd.q : SKILL_BASE_CD.q) * side.cdrMul;
    side.skills.f.max = (heroCd.f !== undefined ? heroCd.f : SKILL_BASE_CD.f) * side.cdrMul;
    side.skills.e.max = (heroCd.e !== undefined ? heroCd.e : SKILL_BASE_CD.e) * side.cdrMul;
  }
}

// Gandulf passive-helpers — buff/shield på skill-hit
function gandulfSkillDmgMul(side) {
  if (side.heroId !== 'zyro' || !(side.gandulfBuffRemaining > 0)) return 1;
  return 1 + (side.gandulfBuffStacks || 0) * GANDULF_BUFF_SKILL_DMG_PER_STACK;
}
function gandulfCdrMul(side) {
  // Kvar för bakåtkompabilitet — passive ger inte längre CDR
  return 1;
}
// Soul Mark borttagen 2026-05-26 (ersatt av shield + MS-passive). Konstanter
// kvar med no-op-värden för bakåt-kompatibilitet om gammal kod refererar dem.
const GANDULF_MARK_DURATION = 0;
const GANDULF_MARK_WINDOW = 0;
const GANDULF_MARK_DOT_PCT = 0;
const GANDULF_MARK_HEAL_PCT = 0;

function onGandulfSkillHit(side, target) {
  if (side.heroId !== 'zyro') return;
  // Stack-cap till 3. Varje hit refreshar timer + adderar shield (persistent).
  const prevStacks = side.gandulfBuffStacks || 0;
  side.gandulfBuffStacks = Math.min(GANDULF_MAX_STACKS, prevStacks + 1);
  side.gandulfBuffRemaining = GANDULF_BUFF_DURATION;
  // Shield-tillägg: 10% maxHP per stack OM stacks ökade. Använd side.shield (generic
  // shield-state — duel-orb-reward delar samma field). Cap PASSIVE-bidraget vid
  // stacks × 10% maxHP, men om side.shield redan är högre (duel-orb-reward) bevaras det.
  if (side.gandulfBuffStacks > prevStacks && !side.hero.dead) {
    const stackCap = side.hero.maxHp * GANDULF_SHIELD_PER_STACK * GANDULF_MAX_STACKS;
    const oldShield = side.shield || 0;
    if (oldShield < stackCap) {
      const add = side.hero.maxHp * GANDULF_SHIELD_PER_STACK;
      side.shield = Math.min(stackCap, oldShield + add);
    }
  }
}

// Soul Mark-DoT borttagen 2026-05-26 — ny passive (shield + MS + skill-dmg)
// ersätter mark-mekaniken. Nollställer ev. legacy-mark-state på targets från
// FÖRE patchen så ingen mark-timer fastnar (bug-hunter-fynd).
function tickGandulfMark(state, target, dt) {
  if (target) {
    target.gandulfMarkRemaining = 0;
    target.gandulfMarkCasterSideIdx = 0;
  }
}

function damageHero(side, amount, isAaDamage) {
  if (side.hero.dead) return;
  if ((side.phoenixImmuneRemaining || 0) > 0) return;   // boss-wars phoenix post-revive-immunitet
  // Kryx-DR (rework 2026-06-07): Titan's Stomp-stack + Titan's Rage, cap 70%. Passiven
  // är nu berserk-mätaren (offensiv empower, INGEN DR) → gamla Stalwart Resolve borttagen.
  let kryxMul = 1;
  if (side.heroId === 'kryx') {
    let kryxDr = 0;
    if ((side.titansStompDrTime || 0) > 0) kryxDr += (side.titansStompDr || 0);
    if ((side.titansRageTime || 0) > 0) kryxDr += (side.titansRageBuff || 0);
    if (kryxDr > 0) kryxMul = 1 - Math.min(KRYX_DR_CAP, kryxDr);
  } else if ((side.titansRageTime || 0) > 0) {
    kryxMul = 1 - Math.min(KRYX_DR_CAP, side.titansRageBuff || 0);   // ally rage-DR (cap-skydd mot negativ final)
  }
  // Aragurn passive — DR baserat på nearby enemies (cached varje frame i tick-loop)
  const elarMul = side.heroId === 'elar' ? (1 - elarPassiveDR(side)) : 1;
  const auraMul = side.heroFountainAura ? FOUNTAIN_DMG_REDUCTION_MUL : 1;
  // Aragurn banner-aura (Hero Leap lvl5): -20% incoming dmg
  const bannerMul = side.inAragurnBanner ? (1 - ARAGURN_LVL5_BANNER_DR_BONUS) : 1;
  // E3 War Shout: -20% incoming dmg medan buffen är aktiv (self + buffade allierade)
  const shoutDrMul = (side.elarShoutBuffTime || 0) > 0 ? (1 - SHOUT_BUFF_DR) : 1;
  let final = amount * (side.dmgReductionMul ?? 1) * auraMul * kryxMul * elarMul * bannerMul * shoutDrMul;
  // Xina Ninja's Cloak: 50% DR mot skill-skada (AA hanteras separat av evasion vid projektil-träff).
  if (side.heroId === 'xina' && (side.xinaCloakRem || 0) > 0 && !isAaDamage) final *= (1 - XINA_CLOAK_SKILL_DR);
  // Zheyna Clone: medan klonen lever tar Zheyna -50%, klonen soakar samma instans ×1.5 (egen
  // HP-pool) och dör snabbt → DR slut. Robust i alla lägen (ingen aggro-omdirigering).
  if (side.zheynaClone) {
    side.zheynaClone.hp -= final * ZHEYNA_CLONE_DMG_TAKEN_MUL;
    final *= (1 - ZHEYNA_CLONE_OWNER_DR);
    if (side.zheynaClone.hp <= 0) side.zheynaClone = null;
  }
  // Gandulf shield absorberar först
  if ((side.shield || 0) > 0 && final > 0) {
    if (side.shield >= final) { side.shield -= final; final = 0; }
    else { final -= side.shield; side.shield = 0; }
  }
  side.hero.hp = Math.max(0, side.hero.hp - final);
  // (Titan's Stomp har ingen self-heal längre — borttagen i reworken.)
  // Iron Will: stacka tagen skada för senare explosion
  if ((side.ironWillRemaining || 0) > 0) {
    side.ironWillStored = (side.ironWillStored || 0) + final;
    // Lvl 5: queue 30% damage-reflect (AoE runt Gimlu vid nästa tick)
    if (side.skillLvl && side.skillLvl.f >= SKILL_LEVEL_MAX && final > 0) {
      side.ironWillReflectQueue = side.ironWillReflectQueue || [];
      side.ironWillReflectQueue.push(final * GIMLU_LVL5_IW_REFLECT_PCT);
    }
  }
  // Gimlu tank-mekanik: bygger ult genom att tanka skada (kompenserar låg AA-frekvens
  // + single-target skills). 5% av damage taken som ult-gain, cap 2% per hit.
  if (side.heroId === 'kryx' && final > 0 && side.hero.hp > 0) {
    gainUltEnergy(side, Math.min(GIMLU_ULT_GAIN_PER_HIT_CAP, final * GIMLU_ULT_GAIN_ON_DMG_PCT));
    // Passive: berserk-mätare fylls av tagen skada (3 bars = 30% maxHP → empowrar nästa Q/F/E).
    if (!side.berserkCharged) {
      side.berserkDmgAccum = (side.berserkDmgAccum || 0) + final;
      if (side.berserkDmgAccum >= side.hero.maxHp * BERSERK_FULL_PCT) { side.berserkDmgAccum = side.hero.maxHp * BERSERK_FULL_PCT; side.berserkCharged = true; }
    }
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
  // Boss Wars Phoenix Amulet (Phase B): revive EN gång vid 50% HP istället för att dö.
  // Intar ALLA dödskällor (boss-skada, ad-wipe, etc) eftersom alla går via killHero.
  // FX visas klient-sida via hp-hoppet i b-state (ingen explicit FX-sync i Phase B).
  if (side.inBossWars && side.phoenixReviveAvailable) {
    side.phoenixReviveAvailable = false;
    side.hero.hp = Math.round(side.hero.maxHp * 0.5);
    // 1.5s immunitet efter revive (balans-fynd): annars äts phoenixen direkt av nästa
    // boss-burst i tier 4-5 (varje skill one-shottar) → wasted item-slot.
    side.phoenixImmuneRemaining = 1.5;
    return;   // överlever — INTE dead
  }
  side.hero.dead = true;
  side.hero.respawnTimer = RESPAWN_TIME;
  // Zheyna: avbryt klon/spjut/ult-laddning + DR vid död (decision 134)
  if (side.heroId === 'zheyna') {
    side.zheynaClone = null; side.zheynaSpear = null; side.zheynaUltSpear = null; side.zheynaUltCharging = false;
    side.zheynaWarpathRem = 0; side.zheynaDmgBuffMul = 1; side.zheynaDmgBuffRem = 0;
  }
  if (side.heroId === 'xina') resetXinaState(side);   // avbryt shurikens/krok/storm + buffar vid död
}
function respawnHero(side) {
  const cfg = SIDE_CFG[side.idx];
  side.hero.dead = false;
  side.hero.hp = side.hero.maxHp;
  if (side.inBossWars) {
    // Boss wars: respawna vid boss-rummets västkant (nära fighten, inom walkable cirkel).
    // Sprid per peer (idx 1/2/3 → z -4/0/+4) så de tre co-op-hjältarna inte staplas på exakt samma punkt.
    side.hero.x = BOSSWARS_CX - BOSSWARS_RADIUS + 4;
    side.hero.z = BOSSWARS_CZ + (side.idx - 2) * 4;
    // S3/S4: nollställ debuff-stackar — annars respawnar hjälten med maxade aura-/ad-stackar
    // (omedelbar maxskada vid första kontakt).
    side.auraStacks = 0; side.auraTickAccum = 0; side.auraResetTimer = 0;
    side.adStacks = 0; side.adStackTimer = 0;
  } else {
    side.hero.x = cfg.heroSpawn.x;
    side.hero.z = cfg.heroSpawn.z;
  }
  // Lvl-5 cleanup: rensa Gimlu taunt-state + iron-will reflect-queue så
  // explosion inte fyrar på respawn-position. tauntHealAccum-tracker mätte
  // hp-delta som lvl5 healing under taunt — utan respawn-rensning räknas
  // respawn-hp-hopp (0 → maxHp) som healing → falsk explosion.
  side.titansTauntRemaining = 0;
  side.tauntLvl5 = false;
  side.tauntHealAccum = 0;
  side._tauntHpPrev = side.hero.hp;
  if (side.ironWillReflectQueue) side.ironWillReflectQueue.length = 0;
  side.ironWillRemaining = 0;
  side.ironWillStored = 0;
  // Aragurn lvl5 — rensa banner-state vid respawn så aura inte hänger kvar
  if (side.elarBanners) side.elarBanners.length = 0;
  side.inAragurnBanner = false;
  // Rensa Shadow Volley-state om Legolus dog medan invis (annars stannar
  // invis-flagga med "0" rem men cleared aaPending — säkert att nolla allt).
  side.nyroInvisRemaining = 0;
  side.nyroUltAaPending = false;
  // Rensa Kostefo-state vid respawn så cloud/ult inte hänger kvar från död-tick
  side.kostefoCloudRemaining = 0;
  side.kostefoCloudTickAccum = 0;
  side.kostefoCloudX = 0;
  side.kostefoCloudZ = 0;
  side.kostefoInCloud = false;
  side.kostefoUltRemaining = 0;
  side.kostefoUltJoints = [];
  side.kostefoGooseWaves = [];
  side.kostefoSliders = [];
  // Lvl-5 cleanup
  side.kostefoSliderTpMarker = null;
  if (side.kostefoClones) side.kostefoClones.length = 0;
  side.kostefoCloudRadiusMul = 1;
}

function createSide(idx) {
  // SIDE_CFG har bara idx 1+2 (classic/arena). Boss wars (3 co-op) + 2v2 behöver
  // idx 3/4 → fallback till side 1:s cfg (tower/lane/spawn används ej i de lägena;
  // hero-spawn överrids av createBossWarsState). Oförändrat för idx 1/2.
  const cfg = SIDE_CFG[idx] || SIDE_CFG[1];
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
    heroId: 'zyro',
    heroPickConfirmed: false,
    vineTraps: [],
    nyroBuffRemaining: 0,
    nyroDashBuffPending: false,
    ultEnergy: 0,           // 0-100, klient renderar mätare + tillåter R-cast vid 100
    elarNearbyCount: 0,  // cachas varje frame för Aragurn passive DR
    critDmgMul: 2.0,         // base crit-multiplikator (kan justeras av buff)
    titansTauntRemaining: 0,
    ironWillRemaining: 0,
    ironWillStored: 0,
    hammers: [],
    ironWillExplosions: [],
    nyroAaCounter: 0,
    nyroSplitPending: false,
    nyroInvisRemaining: 0,         // sek kvar i Shadow Volley-invis
    nyroUltAaPending: false,       // nästa AA är empowered (revealar)
    thornPools: [],                   // {id,x,z,radius,remaining,tickAccum,dmgPct}
    // Kostefo state
    kostefoGooseWaves: [],            // Q: {id,x,z,dx,dz,remaining,tickAccum}
    kostefoSliders: [],               // F: {id,x,z,dx,dz,traveled,hit:Set}
    kostefoCloudRemaining: 0,         // E: sek kvar (cloud existerar på marken)
    kostefoCloudTickAccum: 0,
    kostefoCloudX: 0,                 // E: cast-position (cloud är stationär — följer ej hero)
    kostefoCloudZ: 0,
    kostefoInCloud: false,            // E: hero inom cloud-radius just nu (recalc per tick)
    kostefoUltRemaining: 0,           // R: sek kvar (joints summon:ade)
    kostefoUltJoints: [],             // R: [{angle, attackCd}] orbit-state
    kostefoCompanion: null,           // Passive: {x,z,ry,attackCd}
    // Slider-DoT trackas via target-egna fält: m.kostefoDotRemaining/PerSec
    kryxDmgInstanceCount: 0,
    gandulfBuffStacks: 0,
    gandulfBuffRemaining: 0,
    // Lvl-5 max-skill bonus-buffar (per skill)
    windPuffMsRem: 0,          // Gandulf Q lvl5 — +30% MS
    nyroDashStackCd: 0,     // Legolas E lvl5 — andra stackens CD (oanvänd vid lvl<5)
    tauntHealAccum: 0,         // Gimlu Q lvl5 — heal-tracker under taunt
    _tauntHpPrev: 0,           // Gimlu Q lvl5 — internal: hp vid förra ticken
    tauntLvl5: false,          // Gimlu Q lvl5 — flagga: är denna taunt en lvl5-cast
    kryxHammerMsRem: 0,       // Gimlu E lvl5 — caster MS-buff timer
    ironWillReflectQueue: [],  // Gimlu F lvl5 — reflect-damage queue
    elarBanners: [],        // Aragurn E lvl5 — banner-entiteter på marken
    inAragurnBanner: false,    // Aragurn E lvl5 — flagga: hero inom banner-aura
    kostefoSliderTpMarker: null, // Kostefo F lvl5 — { x, z, remaining } för re-cast-tp
    kostefoClones: [],         // Kostefo E lvl5 — decoy-kloner som springer ut
    kostefoCloudRadiusMul: 1,  // Kostefo E lvl5 — 1.20 vid lvl5, 1.0 default
    // Xina (decision 139) — assassin shurikens/krok/storm + buff-timers
    xinaShurikens: [], xinaHook: null, xinaStorm: [], xinaLaunch: [],
    xinaUltRem: 0, xinaCloakRem: 0, xinaCloakStackCd: 0,
    xinaQBuffRem: 0, xinaQBuffStacks: 0, xinaStormHits: null,
    shield: 0,
    // Portal-state: 3 användningar, 1 min cooldown, 30s i fiendens lanes
    portalUsesLeft: PORTAL_MAX_USES,
    portalCooldown: 0,
    inEnemyTerritory: false,
    enemyTerritoryTimer: 0,
    gold: 0,
    income: INCOME_BASE, incomeTimer: 0, incomeTickCount: 0,
    inventory: [],
    tierUnlocks: { 1: true, 2: false, 3: false, 4: false, 5: false },
    skills: {
      q: { cd: 0, max: SKILL_BASE_CD.q },
      f: { cd: 0, max: SKILL_BASE_CD.f },
      e: { cd: 0, max: SKILL_BASE_CD.e },
    },
    // Skill-points-system: Q/F/E unlock + upgrade 0-5, stat-points 0-5 per stat
    skillLvl: { q: 0, f: 0, e: 0 },
    statPts: { as: 0, ms: 0, hp: 0, sd: 0, dr: 0 },
    unspentPoints: STARTING_POINTS,
    tower: { hp: TOWER_MAX_HP, maxHp: TOWER_MAX_HP },
    monsters: [],
    playerCreeps: [],
    projectiles: [],
    fireballs: [],
    novaEffects: [],
    creepProjectiles: [],
    monsterProjectiles: [],
    wave: {
      current: 0,
      active: false,
      betweenTimer: INITIAL_PREP_TIME,
      name: '',
      isBoss: false,
      bannerPulse: 0,             // ökas vid wave-start så klienten triggar banner
      waveReady: false,           // decision 105: nästa wave väntar tills BÅDA sidor klara
    },
    heroCopies: [],
  };
  recomputeSideStats(side);
  return side;
}

function createGameState() {
  const s1 = createSide(1), s2 = createSide(2);
  // inLineWars: classic-mode flag. createGameState is ONLY ever the line-wars room (server.js:82),
  // so this never touches arena/boss. Enables the server-auth ults (laser/rage/berserk) in line
  // wars too (2026-06-23); their HERO damage is duel-gated (isHeroPvpActive) so it can't break the
  // creep-pushing phase.
  s1.inLineWars = true; s2.inLineWars = true;
  return {
    sides: { 1: s1, 2: s2 },
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

// ── Decision 120 Fas 1: arena 1v1 server-auktoritativ ──────────────────
// Arena 1v1 = hjälte-mot-hjälte i en separat arena (z-offset 80, skild från
// duel-arenan CZ=35). Återanvänder createSide + engine:ns duel-strids-tick.
// ADDITIVT: inget anropar detta än (server.js kör fortf. host-auth för arena-rum)
// förrän hela slice:n + server-wiren är klar och testad. Bryter inget under tiden.
const ARENA1V1_Z = 80;                 // matchar main.js ARENA_Z_OFFSET
// Arena Wars 20% mindre (användarbeslut 2026-06-04). MÅSTE matcha main.js ARENA_SCALE
// exakt — annars clampar servern mot andra bounds än klient-prediction → rubber-banding.
const ARENA1V1_SCALE = 0.8;
// Spawn nära arena-kanten (walkable-bound = ±44*scale; spawn ±40*scale → ~3 enheter marginal).
const ARENA1V1_SPAWN1 = { x: -40 * ARENA1V1_SCALE, z: ARENA1V1_Z };
const ARENA1V1_SPAWN2 = { x: 40 * ARENA1V1_SCALE, z: ARENA1V1_Z };
// Arena1v1 walkable-bounds (matchar main.js ARENA_CFG.bounds, skalad med ARENA1V1_SCALE).
// Egen check: duel-arenan (isArenaWalkable) är en cirkel vid z=35 → fel för z=80.
const ARENA1V1_BOUNDS = { minX: -44 * ARENA1V1_SCALE, maxX: 44 * ARENA1V1_SCALE, minZ: ARENA1V1_Z - 28 * ARENA1V1_SCALE, maxZ: ARENA1V1_Z + 28 * ARENA1V1_SCALE };
function isArena1v1Walkable(x, z) {
  return x >= ARENA1V1_BOUNDS.minX && x <= ARENA1V1_BOUNDS.maxX
      && z >= ARENA1V1_BOUNDS.minZ && z <= ARENA1V1_BOUNDS.maxZ;
}
// Väljer rätt walkability-check för en sides läge. Används av movement OCH alla
// teleport/leap-skills (dash/leap/hammer-tp/slider-tp) — annars använder de classic
// isHeroWalkable som avvisar arena1v1-positioner (z≈80) → teleport-skills misslyckas.
function heroWalk(side, x, z, opts) {
  if (side.inBossWars) return isBossWarsWalkable(x, z, side._bwGateClosed);
  if (side.inArena1v1) return isArena1v1Walkable(x, z);
  if (side.inDuel) return isArenaWalkable(x, z);
  return isHeroWalkable(side.idx, x, z, opts);
}
// Arena-flöde-konstanter (speglar main.js — håll i sync)
const ARENA_PREP_TIME = 18;        // nerf 25→18: ~2.5min meny/Bo5 var för mycket dödtid; ready-knappen skippar ändå (matchar klient)
const ARENA_ROUND_END_PAUSE = 5;   // +1s så utfallet hinner läsas
const ARENA_BO5_WINS_NEEDED = 3;
const ARENA_GOLD_START = 400;
const ARENA_GOLD_PER_ROUND = 250;
const ARENA_GOLD_WIN_BONUS = 500;
const ARENA_ORB_MAX_HP = 100;
const ARENA_ORB_RESPAWN_DELAY = 15;
const ARENA_ORB_HEAL_PCT = 0.30;       // dödaren får +30% maxHp heal
const ARENA_ORB_SHIELD_PCT = 0.15;     // + 15% maxHp shield (nerf från 0.30: ~60%→45% eff-HP-swing = mindre snöboll i Bo5)
const ARENA_ORB_AA_BIAS_SQ = 6.25;     // auto-AA prioriterar fiende-hjälten: orben väljs bara om ~2.5m närmare
const ARENA_STARTING_DURATION = 3.0;   // 3-2-1-FIGHT countdown
// Shrink-zon
const A_SHRINK_START_DELAY = 30;   // nerf från 60: zonen formar rundan i tid (rundor avgjordes ofta innan)
const A_SHRINK_INITIAL_RADIUS = 28 * ARENA1V1_SCALE;   // skalad med ARENA1V1_SCALE
const A_SHRINK_FINAL_RADIUS = 4 * ARENA1V1_SCALE;
const A_SHRINK_DURATION = 60;
const A_SHRINK_DMG_PCT = 0.05;
const A_SHRINK_TICK_INTERVAL = 0.25;
// Ult-konstanter (speglar main.js — håll i sync). Server-auth arena: dessa 3 ults
// (zyro laser, kryx rage, elar berserk) körs auktoritativt här; klienten
// renderar bara visualen från synkat tillstånd (lz/rg/bz i serializeArenaHero).
const LASER_DURATION = 3.0;
const LASER_TURN_RATE = 4.5;
const LASER_TICK_INTERVAL = 0.5;
const LASER_TICK_DMG_PCT = 0.08;   // nerf från 0.15: var 90% maxHP-one-shot över 3s → nu ~48% (matchar klient)
const LASER_RANGE = 60;
const LASER_WIDTH = 2.2;
const RAGE_DURATION = 5.0;
const RAGE_TICK_INTERVAL = 0.5;
const RAGE_PULSE_RADIUS = 7.0;       // buff från 5.5: rage-ulten var nästan oduglig i 1v1 (matchar klient)
const RAGE_PULSE_DMG_PCT = 0.05;     // buff från 0.035: rage var svagast i 1v1 (~35%→50% maxHP-ceiling)
const RAGE_HEAL_PCT = 0.20;
const BERSERK_DURATION = 5.0;
const BERSERK_AA_DMG_MUL = 2.50;     // +150% AA-damage
const BERSERK_AA_LIFESTEAL = 0.25;
function createArenaState(teamSize) {
  // Team-arena (Task 18): teamSize 1 = exakt gamla 1v1; 2/3 = sides 1..2N där
  // 1..N = team 1 (väst) och N+1..2N = team 2 (öst). Allt nedan är formbevarat
  // för 1v1 (sideKeys [1,2], team-fält ignoreras av arenaOpp utan teamSize>1).
  const size = (teamSize === 2 || teamSize === 3) ? teamSize : 1;
  const keys = [];
  for (let i = 1; i <= size * 2; i++) keys.push(i);
  const sides = {};
  const inputs = {};
  const talents = {};
  const ready = {};
  for (const idx of keys) {
    const s = createSide(idx);
    // team-fältet sätts BARA i team-läge — 1v1-payloaden (hero-snapens tm) förblir orörd.
    if (size > 1) s.team = idx <= size ? 1 : 2;
    const spawn = arenaSpawnFor(idx, size);
    s.hero.x = spawn.x; s.hero.z = spawn.z;
    s.hero.facingX = (s.team || idx) === 1 ? 1 : -1; s.hero.facingZ = 0;
    // inArena1v1 → applyMovement använder arena1v1-walkability (ej duel-cirkeln/classic).
    s.inArena1v1 = true;
    sides[idx] = s;
    inputs[idx] = { j: { x: 0, z: 0 } };
    talents[idx] = { points: 0, chosen: [] };
    ready[idx] = false;
  }
  return {
    mode: 'arena1v1',
    teamSize: size,
    sideKeys: keys,
    sides,
    nextEntityId: 1,
    // duelActive=true aktiverar engine:ns hero-vs-hero-combat (skill-träffar mot opp.hero,
    // AA-targeting, isHeroPvpActive) — samma gate duel-deathmatchen använder. Arena kör
    // tickArena (ej tickGame:s duelActive-gren) så ingen dubbel-tick.
    duelActive: true,
    lastInputs: inputs,
    // matchState så server.js:gameLoopTick:s `room.game.matchState.gameOver`-guard
    // fungerar för arena också (sätts i transitionArenaMatchEnd).
    matchState: { gameOver: false, winner: 0 },
    // Arena-flöde (speglar arenaState i main.js / a-state-formen)
    phase: 'prep',             // prep | fight | roundEnd | matchEnd
    roundNum: 1,
    wins: { 1: 0, 2: 0 },      // per TEAM i team-läge (1v1: team == side)
    ready,
    prepTimer: 0,
    startingTimer: 0,
    startingPhaseShown: false,
    endTimer: 0,
    roundWinner: 0,
    matchWinner: 0,
    fightTimer: 0,
    shrinkRadius: 0,
    mapIdx: 0,
    talents,
    // x/z på orb-objektet sätts här en gång för alla — undviker ny position-wrapper
    // i findClosestHostile varje tick (var { entity: { x,z,hp,maxHp }, ... } ).
    orb: { hp: 0, maxHp: ARENA_ORB_MAX_HP, alive: false, spawnTimer: 0, x: 0, z: ARENA1V1_Z },
  };
}

// Arena combat-tick: ÅTERANVÄNDER engine:ns duel-strids-funktioner (samma set som
// tickGame:s duelActive-gren, rad ~4993–5082). Bara combat här; arena-flödet
// (prep/round/orb/shrink/talents) portas separat. ADDITIVT — oanropat tills wirad.
// Movement: joystick via lastInputs (trust-client-position bakas in vid input-wiring).
// === Server-auth ult-tickar (arena 1v1). Magiker laser + Gimlu rage körs här;
// Aragurn berserk är en AA-modifier (updateHeroAttack) + ren timer-nedräkning.
// Enda arena-target är opp.hero (orb-skada hör till separat orb-system). ===
function applyLaserBeamTickServer(state, side) {
  const lb = side.laserBeam;
  if (!lb || side.hero.dead) return;
  // Boss wars (co-op): lasern träffar boss-monstret i st f motståndar-hjälte.
  // (%-av-boss-maxHp ärver arena-formeln — balans/boss-DR tunas i slice 2.)
  if (state.mode === 'bosswars') {
    const boss = state.boss;
    if (!boss || boss.hp <= 0) return;
    const ddx = boss.x - side.hero.x, ddz = boss.z - side.hero.z;
    const along = ddx * lb.dx + ddz * lb.dz;
    if (along < 0 || along > LASER_RANGE) return;
    const perp = Math.abs(ddx * (-lb.dz) + ddz * lb.dx);
    if (perp >= LASER_WIDTH) return;
    boss.hp = Math.max(0, boss.hp - bossWarsDmgMod(boss, boss.maxHp * LASER_TICK_DMG_PCT));   // fas-immunitet+DR; clamp (death=slice 4)
    return;
  }
  if (state.mode === 'sandbox') {   // sandbox: lasern träffar dummies i strålen (odödliga)
    for (const d of (state.sandboxDummies || [])) {
      if (d.hp <= 1) continue;
      const sdx = d.x - side.hero.x, sdz = d.z - side.hero.z;
      const along = sdx * lb.dx + sdz * lb.dz;
      if (along < 0 || along > LASER_RANGE) continue;
      if (Math.abs(sdx * (-lb.dz) + sdz * lb.dx) >= LASER_WIDTH) continue;
      d.hp = Math.max(1, d.hp - d.maxHp * LASER_TICK_DMG_PCT);
    }
    return;
  }
  const opp = arenaOpp(state, side.idx);
  if (!opp || opp.hero.dead) return;
  // Line wars: only deal hero damage during a duel / enemy-territory PvP window — never during the
  // creep-pushing phase (2026-06-23). Arena is always PvP so inArena1v1 short-circuits.
  if (!side.inArena1v1 && !isHeroPvpActive(state)) return;
  const ddx = opp.hero.x - side.hero.x, ddz = opp.hero.z - side.hero.z;
  const along = ddx * lb.dx + ddz * lb.dz;
  if (along < 0 || along > LASER_RANGE) return;
  const perp = Math.abs(ddx * (-lb.dz) + ddz * lb.dx);
  if (perp >= LASER_WIDTH) return;
  damageHero(opp, opp.hero.maxHp * LASER_TICK_DMG_PCT);
}

function tickMagikerLaserServer(state, side, dt) {
  const lb = side.laserBeam;
  if (!lb) return;
  if (side.hero.dead) { side.laserBeam = null; return; }
  lb.remaining -= dt;
  lb.tickAccum += dt;
  // Strålen svänger mot hero-facing (LASER_TURN_RATE rad/s) — matchar klientens host-fn
  const desired = Math.atan2(side.hero.facingX, side.hero.facingZ);
  const cur = Math.atan2(lb.dx, lb.dz);
  let delta = desired - cur;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const maxStep = LASER_TURN_RATE * dt;
  const ang = cur + Math.max(-maxStep, Math.min(maxStep, delta));
  lb.dx = Math.sin(ang); lb.dz = Math.cos(ang);
  // CC-immun under laser
  side.hero.frozenTime = 0; side.hero.tauntedTime = 0;
  side.heroFearTime = 0; side.heroSlowTime = 0; side.heroSlowMul = 1;
  side.iceBlockRemaining = 0;
  side.hero.dotRemaining = 0; side.hero.poisonRemaining = 0;   // full CC-immun (som whirlwind)
  // R3: hero is ROOTED while the laser fires — keep aaMoveLockTime topped up so applyMovement
  // blocks the move step AND clients freeze joystick prediction via the serialized `aml` flag.
  side.aaMoveLockTime = Math.max(side.aaMoveLockTime || 0, 0.2);
  while (lb.tickAccum >= LASER_TICK_INTERVAL && lb.remaining > -LASER_TICK_INTERVAL) {
    lb.tickAccum -= LASER_TICK_INTERVAL;
    applyLaserBeamTickServer(state, side);
  }
  if (lb.remaining <= 0) side.laserBeam = null;
}

function tickGimluRageServer(state, side, dt) {
  if (side.hero.dead) { side.rageRemaining = 0; return; }
  side.rageRemaining -= dt;
  side.rageTickAccum = (side.rageTickAccum || 0) + dt;
  // CC-immun under rage
  side.hero.frozenTime = 0; side.hero.tauntedTime = 0;
  side.heroFearTime = 0; side.heroSlowTime = 0; side.heroSlowMul = 1;
  side.iceBlockRemaining = 0;
  side.hero.dotRemaining = 0; side.hero.poisonRemaining = 0;   // full CC-immun (som whirlwind)
  const opp = arenaOpp(state, side.idx);
  // Boss wars (co-op): rage-pulserna träffar boss-monstret i st f motståndar-hjälte.
  const bossTarget = (state.mode === 'bosswars') ? state.boss
                   : (state.mode === 'sandbox') ? sandboxNearestDummy(state, side.hero.x, side.hero.z) : null;
  while (side.rageTickAccum >= RAGE_TICK_INTERVAL && side.rageRemaining > 0) {
    side.rageTickAccum -= RAGE_TICK_INTERVAL;
    // K5: stor earthquake-puls per damage-instans runt hero (hela ult-AoE:n). Återanvänder novaEffects.
    side.novaEffects = side.novaEffects || [];
    side.novaEffects.push({ id: state.nextEntityId++, x: side.hero.x, z: side.hero.z, life: 0.9, maxLife: 0.9, r: RAGE_PULSE_RADIUS, kind: 'q' });
    if (bossTarget && bossTarget.hp > 0) {
      const d = Math.hypot(bossTarget.x - side.hero.x, bossTarget.z - side.hero.z);
      if (d < RAGE_PULSE_RADIUS) {
        const dmg = bossWarsDmgMod(bossTarget, bossTarget.maxHp * RAGE_PULSE_DMG_PCT);   // fas-immunitet + DR
        const dealt = Math.min(dmg, bossTarget.hp);
        bossTarget.hp = Math.max(0, bossTarget.hp - dmg);   // clamp; death slice 4
        if (dealt > 0 && !side.hero.dead) {
          side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + dealt * RAGE_HEAL_PCT);
        }
      }
    } else if (opp && !opp.hero.dead && (side.inArena1v1 || isHeroPvpActive(state))) {   // line wars: hero dmg only during duel/PvP (2026-06-23)
      const d = Math.hypot(opp.hero.x - side.hero.x, opp.hero.z - side.hero.z);
      if (d < RAGE_PULSE_RADIUS) {
        const dmg = opp.hero.maxHp * RAGE_PULSE_DMG_PCT;
        const dealt = Math.min(dmg, opp.hero.hp);
        damageHero(opp, dmg);
        if (dealt > 0 && !side.hero.dead) {
          side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + dealt * RAGE_HEAL_PCT);
        }
      }
    }
  }
  if (side.rageRemaining <= 0) side.rageRemaining = 0;
}

// Arena online-vs-bot (server-auth). Speglar klientens tickArenaBot: target enemy-hero,
// chase/kite/strafe, AA + skills (ult tillåten). Driver sides[idx].isBot via lastInputs/applyEvent.
function tickArenaBotServer(state, sideIdx, dt) {
  const side = state.sides[sideIdx];
  if (!side || !side.isBot || side.hero.dead) return;
  const enemy = arenaOpp(state, sideIdx);
  if (!enemy) return;
  if (!side._botSkillsInited) {
    side._botSkillsInited = true;
    side.skillLvl = side.skillLvl || { q: 0, f: 0, e: 0 };
    for (const k of ['q', 'f', 'e']) if ((side.skillLvl[k] || 0) < 1) side.skillLvl[k] = 1;
  }
  const input = state.lastInputs[sideIdx];
  if ((side.hero.frozenTime || 0) > 0 || (side.heroFearTime || 0) > 0 || (side.iceBlockRemaining || 0) > 0 || (side.hero.tauntedTime || 0) > 0) { if (input) input.j = null; return; }
  const p = BOT_PARAMS[side.botDifficulty] || BOT_PARAMS.medium;
  const enemyAlive = !enemy.hero.dead;
  const dx = enemy.hero.x - side.hero.x, dz = enemy.hero.z - side.hero.z;
  const d = Math.hypot(dx, dz) || 0.001;
  side._botState = side._botState || { strafePhase: Math.random() * Math.PI * 2 };
  const bs = side._botState;
  let mx = 0, mz = 0;
  if (enemyAlive && d > 0.05) {
    const nx = dx / d, nz = dz / d;
    const range = side.attackRange || HERO_ATTACK_RANGE;
    if (d > range + 0.4) { mx = nx; mz = nz; }              // chase
    else if (d < range * 0.5) { mx = -nx; mz = -nz; }       // kite
    else { const ph = Math.sin(Date.now() * 0.001 * (p.strafeFreq || 1) + bs.strafePhase); const s_ = ph > 0 ? 1 : -1; mx = -nz * s_; mz = nx * s_; }  // strafe
    mx += (Math.random() - 0.5) * p.jitter; mz += (Math.random() - 0.5) * p.jitter;
    const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
    side.hero.facingX = nx; side.hero.facingZ = nz;
  }
  if (input) input.j = (mx || mz) ? { x: mx, z: mz } : null;
  const aaRange = side.attackRange || HERO_ATTACK_RANGE;
  if (enemyAlive && d <= aaRange + 0.5 && !side.aaActive) applyEvent(state, sideIdx, { type: 'aa' });
  else if (side.aaActive && d > aaRange + 2.0) applyEvent(state, sideIdx, { type: 'aa-cancel' });
  if (!enemyAlive) return;
  side._botSkillT = (side._botSkillT || 0) - dt;
  if (side._botSkillT <= 0 && Math.random() < p.skillRatePerSec * dt) {
    side._botSkillT = p.skillReactionMs / 1000;
    const cand = [];
    for (const k of ['q', 'f', 'e']) if (side.skills[k] && side.skills[k].cd <= 0) cand.push(k);
    if ((side.ultEnergy || 0) >= ULT_ENERGY_MAX) cand.push('r');   // ult funkar i arena
    if (cand.length) applyEvent(state, sideIdx, { type: 'skill', key: cand[(Math.random() * cand.length) | 0], dx: dx / d, dz: dz / d, tap: true });
  }
}

function tickArenaCombat(state, dt) {
  // Bot-AI (arena online-vs-bot): sätt rörelse-input + AA/skill före rörelse-loopen.
  for (const sideIdx of arenaKeys(state)) if (state.sides[sideIdx] && state.sides[sideIdx].isBot) tickArenaBotServer(state, sideIdx, dt);
  for (const sideIdx of arenaKeys(state)) {
    const side = state.sides[sideIdx];
    const j = state.lastInputs[sideIdx] && state.lastInputs[sideIdx].j;
    heroAutoMove(side, j, dt);
  }
  for (const sideIdx of arenaKeys(state)) {
    const side = state.sides[sideIdx];
    const opp = arenaOpp(state, sideIdx);
    updateSkillCooldowns(side, dt);
    if (!side.hero.dead) updateHeroAttack(state, side, opp, dt);
    updateProjectiles(state, side, opp, dt);
    updateFireballs(state, side, opp, dt);
    updateBlackHoles(state, side, opp, dt);
    updateVineTraps(state, side, opp, dt);
    updateHammers(state, side, opp, dt);
    updateIronWill(state, side, opp, dt);
    updateAragurnWhirlwind(state, side, opp, dt);
    updateAragurnLeap(state, side, opp, dt);
    updateAragurnShoutHeal(side, dt);
    updateSoulDrain(state, side, opp, dt);
    updateBossProjectiles(state, side, dt);
    updateBossPools(state, side, dt);
    tickLegolusInvis(side, dt);
    tickThornPools(state, side, dt);
    tickKostefoSkills(state, side, opp, dt);
    // Server-auth ults: zyro laser + kryx rage (elar berserk = AA-modifier nedan)
    if (side.laserBeam) tickMagikerLaserServer(state, side, dt);
    if ((side.rageRemaining || 0) > 0) tickGimluRageServer(state, side, dt);
    if ((side.berserkRemaining || 0) > 0) {
      // Nollställ vid död (som laser/rage) — annars svävar berserk-svärdet kvar
      // på liket i hela round-end-pausen (klientens _srvBerserkMesh följer bz>0).
      if (side.hero.dead) side.berserkRemaining = 0;
      else side.berserkRemaining = Math.max(0, side.berserkRemaining - dt);
    }
    if (side.heroId === 'elar') {
      side._elarCountTickAccum = (side._elarCountTickAccum || 0) + dt;
      if (side._elarCountTickAccum >= 0.2 || side.elarNearbyCount == null) {
        side._elarCountTickAccum = 0;
        side.elarNearbyCount = elarNearbyCount(state, side);
      }
    }
    if (!side.hero.dead) gainUltEnergy(side, ULT_GAIN_PASSIVE * dt);
    if ((side._ultLockoutTime || 0) > 0) side._ultLockoutTime = Math.max(0, side._ultLockoutTime - dt);
    if ((side.nyroBuffRemaining || 0) > 0) side.nyroBuffRemaining = Math.max(0, side.nyroBuffRemaining - dt);
    tickGimluTauntLvl5(state, side, opp, dt);
    if ((side.windPuffMsRem || 0) > 0) side.windPuffMsRem = Math.max(0, side.windPuffMsRem - dt);
    if ((side.kryxHammerMsRem || 0) > 0) side.kryxHammerMsRem = Math.max(0, side.kryxHammerMsRem - dt);
    tickZheyna(state, side, dt); tickXina(state, side, dt);
    // CC-timers på hero: tickas ner här (tickGame gör detta i sin loop, men
    // tickArenaCombat är en separat path). Utan detta fastnar frozenTime/
    // tauntedTime/heroSlowTime permanent på det satta värdet i arena.
    if ((side.hero.frozenTime || 0) > 0) side.hero.frozenTime = Math.max(0, side.hero.frozenTime - dt);
    if ((side.hero.tauntedTime || 0) > 0) side.hero.tauntedTime = Math.max(0, side.hero.tauntedTime - dt);
    if ((side.hero.dotRemaining || 0) > 0) {
      side.hero.dotRemaining = Math.max(0, side.hero.dotRemaining - dt);
      damageHero(side, (side.hero.dotPerSec || 0) * dt);   // DoT-skada saknades i arena-loopen (FireWave/Stomp)
    }
    if ((side.hero.poisonRemaining || 0) > 0) side.hero.poisonRemaining = Math.max(0, side.hero.poisonRemaining - dt);
    if ((side.heroSlowTime || 0) > 0) {
      side.heroSlowTime = Math.max(0, side.heroSlowTime - dt);
      if (side.heroSlowTime <= 0) { side.heroSlowTime = 0; side.heroSlowMul = 1; }
    }
    tickKryxTimers(side, dt);   // Titan's Stomp-DR + hjälte-AS-slow + Titan's Rage (rework)
    if ((side.heroFearTime || 0) > 0) side.heroFearTime = Math.max(0, side.heroFearTime - dt);
    if ((side.iceBlockRemaining || 0) > 0) side.iceBlockRemaining = Math.max(0, side.iceBlockRemaining - dt);
    // HP-regen (g_regen-talent / item healPerSecPct) — tickGame gör detta i sin loop,
    // men tickArenaCombat är separat path → utan detta var g_regen-talenten placebo i arena.
    if (!side.hero.dead && (side.healPerSecPct || 0) > 0 && side.hero.hp < side.hero.maxHp) {
      side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + side.hero.maxHp * side.healPerSecPct * dt);
    }
    flushIronWillReflectLvl5(state, side, opp);
    tickAragurnBannersLvl5(side, dt);
    if (side.ironWillExplosions) for (let k = side.ironWillExplosions.length - 1; k >= 0; k--) {
      side.ironWillExplosions[k].life -= dt;
      if (side.ironWillExplosions[k].life <= 0) side.ironWillExplosions.splice(k, 1);
    }
    updateNovaEffects(state, side, opp, dt);
    updateActiveBuffs(side, dt);
  }
}

// ── Arena-flöde (server-side, ren logik — UI/mesh/FX stannar på klienten) ──
// Speglar main.js startArenaRound/transition*/checkArenaRoundEnd/tickShrinkCircle/
// updateArenaOrb, men ENBART logik-delarna. 1v1 (sides 1,2).
function _arenaResetHero(state, side, spawn, roundNum) {
  side.hero.x = spawn.x; side.hero.z = spawn.z;
  side.hero.facingX = ((side.team || side.idx) === 1) ? 1 : -1;
  side.hero.facingZ = 0;
  side.hero.dead = false;
  side.hero.respawnTimer = 0;
  // Lagra referens till state på side för talent-lookup i funktioner som inte tar state (damageHero etc.)
  side._arenaState = state;
  recomputeArenaSideStats(state, side); // applicerar stat-talents ovanpå base+items
  side.hero.hp = side.hero.maxHp;
  side.shield = 0;
  side.shrinkHitStacks = 0;
  if (side.skills) { if (side.skills.q) side.skills.q.cd = 0; if (side.skills.f) side.skills.f.cd = 0; if (side.skills.e) side.skills.e.cd = 0; }
  // Nolla combat-entiteter + buff-timers så varje runda startar fräsch (ej ult-energy)
  // fireWaves + shatters är kort-livade FX men kan bridga till nästa runda vid round-end mitt i cast.
  for (const arr of ['projectiles', 'fireballs', 'blackHoles', 'vineTraps', 'hammers', 'novaEffects',
                     'bossProjectiles', 'bossPools', 'thornPools', 'ironWillExplosions',
                     'kostefoGooseWaves', 'kostefoSliders', 'elarBanners', 'kostefoUltJoints',
                     'fireWaves', 'shatters']) {
    if (Array.isArray(side[arr])) side[arr].length = 0;
  }
  side.whirlwindRemaining = 0;
  side.elarLeap = null;
  side.elarShoutBuffTime = 0;    // E3 War Shout-buff (MS/dmg/DR)
  side.elarShoutHealRemaining = 0; side.elarShoutHealPct = 0;
  side.laserBeam = null;            // zyro ult (R)
  side.rageRemaining = 0;           // kryx ult (R)
  side.rageTickAccum = 0;           // kryx ult ackumulator
  side.berserkRemaining = 0;        // elar ult (R)
  side.nyroBuffRemaining = 0;
  side.nyroInvisRemaining = 0;
  side.nyroUltAaPending = false; // shadow volley empowered-AA pending
  side.nyroAaCounter = 0;        // nyro passive split-counter
  side.nyroSplitPending = false;
  side.nyroDashBuffPending = false;
  side.nyroDashStackCd = 0;
  side.titansTauntRemaining = 0;
  side.tauntLvl5 = false; side.tauntHealAccum = 0; side._tauntHpPrev = side.hero.hp;
  side.ironWillRemaining = 0;
  side.ironWillStored = 0;
  if (side.ironWillReflectQueue) side.ironWillReflectQueue.length = 0;
  side.inAragurnBanner = false;
  side._ultLockoutTime = 0;         // ult-lockout nollas så R kan castas direkt
  side.gandulfBuffRemaining = 0; side.gandulfBuffStacks = 0;
  side.kostefoCloudRemaining = 0; side.kostefoCloudTickAccum = 0;
  side.kostefoCloudX = 0; side.kostefoCloudZ = 0; side.kostefoInCloud = false;
  side.kostefoCloudRadiusMul = 1;
  side.kostefoSliderTpMarker = null;
  if (side.kostefoClones) side.kostefoClones.length = 0;
  side.kostefoUltRemaining = 0; side.kostefoCompanion = null;
  if (side.soulDrain) side.soulDrain = null;   // Gandulf Q drain-beam
  side.kryxDmgInstanceCount = 0;
  side.attackCd = 0; side.attackCounter = 0;
  side.aaActive = false; side.targetId = 0; side.targetType = ''; side.targetX = 0; side.targetZ = 0;
  side.windPuffMsRem = 0; side.kryxHammerMsRem = 0;
  // Zheyna-state (decision 134)
  side.zheynaClone = null; side.zheynaSpear = null; side.zheynaUltSpear = null;
  side.zheynaUltCharging = false; side.zheynaUltCharge = 0; side.zheynaUltAim = 0;
  side.zheynaWarpathRem = 0; side.zheynaDmgBuffMul = 1; side.zheynaDmgBuffRem = 0;
  resetXinaState(side);   // Xina (decision 139)
  // CC-fält på hero-objektet (frozenTime etc. kan kvarstå från sista dead-tick)
  side.hero.frozenTime = 0; side.hero.tauntedTime = 0;
  side.hero.dotRemaining = 0; side.hero.poisonRemaining = 0; side.hero.poisonStacks = 0;
  side.heroFearTime = 0; side.heroSlowTime = 0; side.heroSlowMul = 1;
  side.heroASlowTime = 0; side.heroASlowMul = 1;   // Kryx-rework: hjälte-AS-slow
  side.titansStompDrTime = 0; side.titansStompDr = 0; side.titansRageTime = 0; side.titansRageBuff = 0;
  side.rageLeechStart = 0; side.rageLeechTime = 0; side.rageLeechOwner = 0;
  side.berserkCharged = false; side.berserkDmgAccum = 0;   // berserk-mätare
  side.ganjiMeter = 0; side.ganjiPassiveReady = false;     // Ganji Katana's Slice-mätare
  side.iceBlockRemaining = 0;
  side.gold = (roundNum === 1) ? ARENA_GOLD_START : ((side.gold || 0) + ARENA_GOLD_PER_ROUND);
}

// Bot auto-ready: alla bot-sides är alltid redo (gäller 1v1 OCH team-läge).
function _arenaResetReady(state) {
  const ready = {};
  for (const idx of arenaKeys(state)) {
    const s = state.sides[idx];
    ready[idx] = !!(s && s.isBot);
  }
  state.ready = ready;
}

function startArenaRound(state, roundNum) {
  state.roundNum = roundNum;
  state.phase = 'prep';
  state.prepTimer = ARENA_PREP_TIME;
  state.fightTimer = 0;
  state.shrinkRadius = 0;
  state.shrinkDamageAccum = 0;
  _arenaResetReady(state);
  for (const idx of arenaKeys(state)) {
    if (!state.talents[idx]) state.talents[idx] = { points: 0, chosen: [] };
    state.talents[idx].points += 1;                 // +1 talent-poäng/runda
  }
  // x/z behövs för AA-targeting (findClosestHostile/resolveTargetEntity läser target.x/z).
  state.orb = { hp: 0, maxHp: ARENA_ORB_MAX_HP, alive: false, spawnTimer: 0, x: 0, z: ARENA1V1_Z };
  for (const idx of arenaKeys(state))
    _arenaResetHero(state, state.sides[idx], arenaSpawnFor(idx, state.teamSize), roundNum);
}

function transitionArenaToStarting(state) {
  state.phase = 'starting';
  state.startingTimer = ARENA_STARTING_DURATION;
  state.startingPhaseShown = '3';   // countdown-label klienten visar (3→2→1→FIGHT!)
  for (const idx of arenaKeys(state)) {
    const s = state.sides[idx];
    const spawn = arenaSpawnFor(idx, state.teamSize);
    s.hero.x = spawn.x; s.hero.z = spawn.z;
    s.hero.facingX = ((s.team || idx) === 1) ? 1 : -1; s.hero.facingZ = 0;
  }
}

function transitionArenaToFight(state) {
  state.phase = 'fight';
  state.fightTimer = 0;
  state.shrinkRadius = 0;
  state.shrinkDamageAccum = 0;
  _arenaResetReady(state);
  // Orb spawnar direkt vid fight-start
  state.orb.alive = true;
  state.orb.hp = state.orb.maxHp;
  state.orb.spawnTimer = 0;
}

function transitionArenaRoundEnd(state, winnerTeam) {
  state.phase = 'roundEnd';
  state.roundWinner = winnerTeam;   // 1v1: side == team
  state.endTimer = ARENA_ROUND_END_PAUSE;
  if (winnerTeam === 1 || winnerTeam === 2) {
    state.wins[winnerTeam] = (state.wins[winnerTeam] || 0) + 1;
    // Belöning till HELA vinnande laget (1v1: exakt gamla beteendet — ett medlem).
    for (const idx of arenaKeys(state)) {
      const s = state.sides[idx];
      if (!s || (s.team || idx) !== winnerTeam) continue;
      if (state.talents[idx]) state.talents[idx].points += 1;
      s.gold = (s.gold || 0) + ARENA_GOLD_WIN_BONUS;
    }
  }
}

function transitionArenaMatchEnd(state, winnerIdx) {
  state.phase = 'matchEnd';
  state.matchWinner = winnerIdx;
  state.matchState.gameOver = true;       // stoppar gameLoopTick
  state.matchState.winner = winnerIdx;
}

// Skapar + initierar en arena-match server-side: sätter valda hjältar, kör
// startArenaRound(1) (recompute-stats + full HP + gold + talent-poäng). Anropas
// av server.js när host skickar a-sim-start. heroes = { 1: heroId, 2: heroId }.
function initArenaMatch(heroes, teamSize) {
  const state = createArenaState(teamSize);
  for (const idx of arenaKeys(state)) {
    const side = state.sides[idx];
    if (heroes && typeof heroes[idx] === 'string') {
      side.heroId = heroes[idx];
      side.heroPickConfirmed = true;
    }
    // Arena = full-power lvl 30: alla skills unlockade + maxade (matchar klientens
    // enterPlayPhase). Utan detta är skillLvl 0 server-side → skill-lock-gaten i
    // applyEvent avvisar casten → ingen cd sätts → skills blir spambara.
    side.level = 30;
    side.xp = 0;
    side.xpToNext = xpForLevel(30);
    side.skillLvl = { q: SKILL_LEVEL_MAX, f: SKILL_LEVEL_MAX, e: SKILL_LEVEL_MAX };
  }
  startArenaRound(state, 1);
  return state;
}

function checkArenaRoundEnd(state) {
  if (!state.teamSize || state.teamSize <= 1) {
    const d1 = state.sides[1].hero.dead, d2 = state.sides[2].hero.dead;
    if (d1 && d2) { transitionArenaRoundEnd(state, 0); return; }
    if (d1) { transitionArenaRoundEnd(state, 2); return; }
    if (d2) { transitionArenaRoundEnd(state, 1); return; }
    return;
  }
  // Team-läge: rundan slutar när HELA ett lag är dött.
  let alive1 = 0, alive2 = 0;
  for (const idx of state.sideKeys) {
    const s = state.sides[idx];
    if (!s || s.hero.dead) continue;
    if ((s.team || idx) === 1) alive1++; else alive2++;
  }
  if (alive1 === 0 && alive2 === 0) transitionArenaRoundEnd(state, 0);
  else if (alive1 === 0) transitionArenaRoundEnd(state, 2);
  else if (alive2 === 0) transitionArenaRoundEnd(state, 1);
}

function tickArenaShrink(state, dt) {
  const t = state.fightTimer;
  if (t < A_SHRINK_START_DELAY) { state.shrinkRadius = 0; return; }
  const elapsed = t - A_SHRINK_START_DELAY;
  const u = Math.min(1, elapsed / A_SHRINK_DURATION);
  const r = A_SHRINK_INITIAL_RADIUS - (A_SHRINK_INITIAL_RADIUS - A_SHRINK_FINAL_RADIUS) * u;
  state.shrinkRadius = r;
  state.shrinkDamageAccum = (state.shrinkDamageAccum || 0) + dt;
  while (state.shrinkDamageAccum >= A_SHRINK_TICK_INTERVAL) {
    state.shrinkDamageAccum -= A_SHRINK_TICK_INTERVAL;
    for (const idx of arenaKeys(state)) {
      const s = state.sides[idx];
      if (!s || s.hero.dead) continue;
      const dx = s.hero.x - 0;
      const dz = s.hero.z - ARENA1V1_Z;
      if (Math.hypot(dx, dz) > r) {
        const stacks = s.shrinkHitStacks || 0;
        const dmg = s.hero.maxHp * (A_SHRINK_DMG_PCT + stacks * 0.01) * A_SHRINK_TICK_INTERVAL;
        damageHero(s, dmg);
        s.shrinkHitStacks = Math.min(10, stacks + 1);   // cap 10 → max zon-DPS 15%/s (matchar klient)
      }
    }
  }
}

// Skada på arena1v1-center-orb (state.orb). Vid kill: dödaren får heal + shield.
// Mirror av klientens damageArenaOrb. Respawn sköts av tickArenaOrbTimer.
function damageArenaOrbServer(state, amount, byIdx) {
  const orb = state.orb;
  if (!orb || !orb.alive || orb.hp <= 0 || amount <= 0) return;
  orb.hp -= amount;
  if (orb.hp <= 0) {
    orb.hp = 0;
    orb.alive = false;
    orb.spawnTimer = ARENA_ORB_RESPAWN_DELAY;
    const winner = state.sides[byIdx];
    if (winner && !winner.hero.dead) {
      const heal = winner.hero.maxHp * ARENA_ORB_HEAL_PCT;
      winner.hero.hp = Math.min(winner.hero.maxHp, winner.hero.hp + heal);
      const shield = winner.hero.maxHp * ARENA_ORB_SHIELD_PCT;
      winner.shield = Math.max(winner.shield || 0, shield);
    }
  }
}

function tickArenaOrbTimer(state, dt) {
  // Bara spawn/respawn-timer här. Orb-skill-damage (damageArenaOrb) hookas i
  // skill-applicerings-vägarna senare (TODO) — kräver integration i skill-pipen.
  const orb = state.orb;
  if (!orb.alive) {
    orb.spawnTimer = Math.max(0, orb.spawnTimer - dt);   // clamp: ingen negativ timer i snap
    if (orb.spawnTimer <= 0) { orb.alive = true; orb.hp = orb.maxHp; }
  }
}

// Arena top-tick. Komplett fas-maskin.
function tickArena(state, dt) {
  if (state.matchState && state.matchState.gameOver) return;   // matchen slut — server.js stoppar loopen
  if (state.phase === 'prep') {
    state.prepTimer = Math.max(0, state.prepTimer - dt);
    let allReady = true;
    for (const k of arenaKeys(state)) if (!state.ready[k]) { allReady = false; break; }
    if (state.prepTimer <= 0 || allReady) transitionArenaToStarting(state);
  } else if (state.phase === 'starting') {
    state.startingTimer = Math.max(0, state.startingTimer - dt);
    // Driv 3-2-1-FIGHT-countdown via startingPhaseShown (klienten visar texten).
    // Måste vara en truthy STRING — klienten gör `if (lbl)` + jämför mot prev text.
    const rem = state.startingTimer;
    let label;
    if (rem > 2.0) label = '3';
    else if (rem > 1.0) label = '2';
    else if (rem > 0.4) label = '1';
    else label = 'FIGHT!';
    state.startingPhaseShown = label;
    if (state.startingTimer <= 0) transitionArenaToFight(state);
  } else if (state.phase === 'fight') {
    state.fightTimer += dt;
    tickArenaCombat(state, dt);
    tickArenaShrink(state, dt);
    tickArenaOrbTimer(state, dt);
    checkArenaRoundEnd(state);
  } else if (state.phase === 'roundEnd') {
    state.endTimer -= dt;
    if (state.endTimer <= 0) {
      if (state.wins[1] >= ARENA_BO5_WINS_NEEDED) transitionArenaMatchEnd(state, 1);
      else if (state.wins[2] >= ARENA_BO5_WINS_NEEDED) transitionArenaMatchEnd(state, 2);
      else startArenaRound(state, state.roundNum + 1);
    }
  }
}

// Persistent hero-snap-objekt per sida — muteras i stället för att allokeras 30 Hz.
// Alla fält som kan vara undefined MÅSTE explicit sättas till undefined när inaktiva,
// annars läcker stale-värden till nästa tick. Sk-objektet har ett eget persistent sub-objekt.
// Optional-objekt (lp/lz/kComp/kCl) skapas fortfarande nytt när aktiva — de är sällan
// aktiva och involverar olika fält beroende på state, vilket gör in-place-muttering farlig.
function _makeHeroSnapBuf() {
  return {
    x: 0, z: 0, fx: 0, fz: 0, hp: 0, mh: 0, d: false,
    sh: undefined, lv: 0, sk: { q: 0, f: 0, e: 0 }, hid: 'zyro',
    ac: 0, g: undefined, ue: undefined, tnt: undefined, fzt: undefined,
    fer: undefined, ibr: undefined, slm: undefined, slt: undefined,
    asp: undefined, adm: undefined, wwr: undefined,
    lp: undefined, lz: undefined, rg: undefined, bz: undefined,
    lInv: undefined, kUlt: undefined, kJoints: undefined,
    kComp: undefined, kCl: undefined,
    tx: 0, tz: 0, aus: undefined, art: undefined, ads: undefined,
    zc: undefined, zsp: undefined, zus: undefined, zch: undefined, zwr: undefined,   // Zheyna (decision 134)
    xsh: undefined, xhk: undefined, xstm: undefined, xlnch: undefined, xcl: undefined, xul: undefined,   // Xina (decision 139)
    gmBk: 0,   // Kryx berserk-mätare (0..1 andel, 1 = charged). Initialt i struct → V8 hidden class stabil.
    taunt: undefined, iw: undefined, iwS: undefined,   // Gimlu: taunt-timer + iron-will (serialize-paritet arena/boss wars)
    tm: undefined,   // team-arena: lag (1/2); undefined i 1v1 → payload oförändrad
  };
}
const _heroSnapBuf1 = _makeHeroSnapBuf();
const _heroSnapBuf2 = _makeHeroSnapBuf();
// Team-arena: buffrar för sides 3..6 (1v1 rör dem aldrig).
const _heroSnapBufs = { 1: _heroSnapBuf1, 2: _heroSnapBuf2,
  3: _makeHeroSnapBuf(), 4: _makeHeroSnapBuf(), 5: _makeHeroSnapBuf(), 6: _makeHeroSnapBuf() };

// Serialisera arena-side → heroSnap-form (matchar main.js heroSnap / klientens
// applyHeroSnap). Läser engine:ns logiska side-state. Optional-fält utelämnas via
// nz/nzr2 (klient läser `|| 0`). LEAP_TRAVEL_TIME finns ej här → använd leap.total.
// Perf: muterar _heroSnapBuf1/_heroSnapBuf2 på plats (undviker 2×30=60 obj-allok/sek).
function serializeArenaHero(side, buf) {
  if (!side) return null;
  const leap = side.elarLeap;
  buf.x = r2(side.hero.x); buf.z = r2(side.hero.z);
  buf.fx = r3(side.hero.facingX); buf.fz = r3(side.hero.facingZ);
  buf.hp = ri(side.hero.hp); buf.mh = ri(side.hero.maxHp);
  buf.d = side.hero.dead;
  buf.sh = nzr2(side.shield);
  buf.lv = side.level;
  buf.sk.q = r2(side.skills.q.cd); buf.sk.f = r2(side.skills.f.cd); buf.sk.e = r2(side.skills.e.cd);
  buf.hid = side.heroId || 'zyro';
  buf.ac = side.attackCounter || 0;
  buf.g = nz(side.gold);
  buf.ue = nzr2(side.ultEnergy);
  buf.tnt = nzr2(side.hero.tauntedTime);
  buf.fzt = nzr2(side.hero.frozenTime);
  buf.fer = nzr2(side.heroFearTime);
  buf.ibr = nzr2(side.iceBlockRemaining);
  // Movement-locked (CC): mirrors the applyMovement freeze (root/stun/freeze/fear) so the CLIENT
  // can freeze joystick prediction → no more "walk a few steps then snap back" while CC'd (2026-06-23).
  buf.mlk = flag((side.hero.frozenTime || 0) > 0 || (side.iceBlockRemaining || 0) > 0 || (side.heroFearTime || 0) > 0);
  buf.slm = (side.heroSlowMul != null && side.heroSlowMul !== 1) ? r3(side.heroSlowMul) : undefined;
  buf.slt = nzr2(side.heroSlowTime);
  buf.asp = nzr2(side.arenaSpeedBuff);
  buf.adm = nzr2(side.arenaDamageBuff);
  buf.wwr = nzr2(side.whirlwindRemaining);
  buf.trg = nzr2(side.titansRageTime);          // K4: Titan's Rage → red glow
  buf.lbf = nzr2(side.nyroBuffRemaining);    // N3: Hunter's Focus → green glow
  buf.shb = nzr2(side.elarShoutBuffTime);    // E3: War Shout → gold glow
  buf.cri = flag(side.aaCritFlash > 0);         // G5: senaste AA var en crit → klienten stylar siffran
  // Ult-visual-state: optional-objekt skapas nytt vid aktivering (men är sällan aktiva).
  buf.lp = leap ? { u: r2(1 - (leap.remaining || 0) / (leap.total || 1)), tx: r2(leap.targetX), tz: r2(leap.targetZ) } : undefined;
  buf.lz = (side.laserBeam && side.laserBeam.remaining > 0) ? { dx: r3(side.laserBeam.dx), dz: r3(side.laserBeam.dz) } : undefined;
  buf.rg = nzr2(side.rageRemaining);
  buf.bz = nzr2(side.berserkRemaining);
  buf.gmBk = side.berserkCharged ? 1 : (side.berserkDmgAccum > 0 && side.hero.maxHp > 0 ? r2(side.berserkDmgAccum / side.hero.maxHp) : 0);   // Gimlu berserk-mätare: 1 = charged, 0..1 = andel
  buf.gjMk = side.ganjiPassiveReady ? 1 : ((side.ganjiMeter || 0) > 0 ? r2(side.ganjiMeter) : 0);   // Ganji Katana's Slice-mätare
  buf.lInv = nzr2(side.nyroInvisRemaining);
  buf.kUlt = nzr2(side.kostefoUltRemaining);
  buf.kJoints = arrOpt(side.kostefoUltJoints, j => ({ a: r3(j.angle) }));
  buf.kComp = side.kostefoCompanion ? { x: r2(side.kostefoCompanion.x), z: r2(side.kostefoCompanion.z), ry: r3(side.kostefoCompanion.ry || 0) } : undefined;
  buf.kCl = (side.kostefoCloudRemaining || 0) > 0 ? { r: r2(side.kostefoCloudRemaining), x: r2(side.kostefoCloudX), z: r2(side.kostefoCloudZ), rm: r2(side.kostefoCloudRadiusMul || 1) } : undefined;
  buf.tx = r2(side.targetX || 0);
  buf.tz = r2(side.targetZ || 0);
  buf.aml = ((side.aaMoveLockTime || 0) > 0) ? 1 : undefined;   // 1 while committing an AA swing → client freezes joystick prediction (tap-to-AA stop, 2026-06-20 v2)
  buf.aus = nz(side.auraStacks);
  buf.art = nzr2(side.auraResetTimer);
  buf.ads = nz(side.adStacks);
  // Gimlu (Kryx): taunt-timer + iron-will-timer/stored → klient renderar taunt-ring + IW-UI (MP-paritet).
  // Saknade i arena/boss-wars-snapen (var bara i serializeSide för classic) → klienten såg alltid 0.
  buf.taunt = nzr2(side.titansTauntRemaining);
  buf.iw = nzr2(side.ironWillRemaining);
  buf.iwS = nzr1(side.ironWillStored);
  buf.tm = side.team || undefined;   // team-arena (1v1: undefined → skippas)
  // Zheyna (decision 134): klon/spjut/ult-spjut/laddning → klient-render (MP-paritet).
  buf.zc = side.zheynaClone ? { x: r2(side.zheynaClone.x), z: r2(side.zheynaClone.z) } : undefined;
  buf.zsp = side.zheynaSpear ? { x: r2(side.zheynaSpear.x), z: r2(side.zheynaSpear.z), dx: r3(side.zheynaSpear.dx), dz: r3(side.zheynaSpear.dz) } : undefined;
  buf.zus = side.zheynaUltSpear ? { x: r2(side.zheynaUltSpear.x), z: r2(side.zheynaUltSpear.z), dx: r3(side.zheynaUltSpear.dx), dz: r3(side.zheynaUltSpear.dz), w: r2(side.zheynaUltSpear.width || 3) } : undefined;
  buf.zch = side.zheynaUltCharging ? { c: r2(side.zheynaUltCharge || 0) } : undefined;
  buf.zwr = nzr2(side.zheynaWarpathRem);
  // Xina (decision 139): shurikens/krok/storm/launch + cloak/ult-timers → klient-render (MpHeroVisuals).
  buf.xsh = (side.xinaShurikens && side.xinaShurikens.length) ? side.xinaShurikens.map(s => ({ x: r2(s.x), z: r2(s.z) })) : undefined;
  buf.xhk = side.xinaHook ? { x: r2(side.xinaHook.x), z: r2(side.xinaHook.z), a: side.xinaHook.attached ? 1 : 0 } : undefined;
  buf.xstm = (side.xinaStorm && side.xinaStorm.length) ? side.xinaStorm.map(s => ({ x: r2(s.x), z: r2(s.z) })) : undefined;
  buf.xlnch = (side.xinaLaunch && side.xinaLaunch.length) ? side.xinaLaunch.map(s => ({ x: r2(s.x), z: r2(s.z), dx: r3(s.dx), dz: r3(s.dz) })) : undefined;
  buf.xcl = nzr2(side.xinaCloakRem);
  buf.xul = nzr2(side.xinaUltRem);
  return buf;
}

// Konstant tom array för power-ups (av, decision 073) — undviker ny allokering 30 Hz.
const _ARENA_EMPTY_PU = [];
Object.freeze(_ARENA_EMPTY_PU);
// Konstant tom array används som fallback när arrOpt returnerar undefined (tom entitets-array).
// Undviker `|| []` som skapar ny tom array-instans varje tick för inaktiva entitetstyper.
// Aldrig muterad — arrOpt returnerar en NY array när entiteter finns, annars lämnar vi detta.
const _ARENA_EMPTY_ARR = _ARENA_EMPTY_PU;   // samma fryst tomma array

// Persistent snap-objekt: muteras i stället för att allokeras nytt 30 Hz.
// JSON.stringify bryr sig inte om objektidentitet — samma objekt med nya värden
// serialiseras identiskt mot ett nyskapat. Sparar ~40 objekt-allokeringar/tick + GC-tryck.
// sub-objekten (o/bh/fw/nv/ab/kg/ks/vt/tp/hm/iwe) muteras likaså på plats.
const _arenaSSnap = {
  t: 'a-state',
  ph: '', rn: 0, w: null, pt: 0, sst: 0, spl: false, et: 0,
  rw: 0, mw: 0, rdy: null, tal: undefined, ts: undefined,
  o: { hp: 0, a: false, sp: 0 },
  mp: 0, sr: 0, ft: 0, pu: _ARENA_EMPTY_PU,
  h1: null, h2: null, h3: undefined, h4: undefined, h5: undefined, h6: undefined,
  bh: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR },
  fw: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR },
  nv: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR },
  ab: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR },
  kg: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR },
  ks: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR },
  vt: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR },
  tp: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR },
  hm: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR },
  iwe: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR },
  kCln: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR },
};
// Persistent talent-sub-objekt — allokeras bara under prep/roundEnd/matchEnd (ej 30 Hz i fight).
// Dessa behöver fortfarande ny allokering (chosen.slice()) — acceptabelt (ej fight-hot-path).
// Persistent orb-tal-containers för de tre faserna.
const _arenaTalSnap = {
  1: { p: 0, c: [] },
  2: { p: 0, c: [] },
};

// ── SHARED hero skill-entity serialization ──────────────────────────────────
// SINGLE source of the wire shape for every hero skill-entity (black holes, fire
// waves, novas, banners, goose waves, sliders, vine traps, thorn pools, hammers,
// iron-will explosions). Used by Arena, Boss Wars AND Sandbox so the data — and
// thus the client's shared MpSkillEntities renderer — is identical in every mode.
// (Was previously only emitted by Arena; Boss Wars/Sandbox sent nothing → most hero
//  skills looked empty in those modes.) Named mappers avoid per-tick closure alloc.
function _mapBh(b)  { return { id: b.id, x: r2(b.x), z: r2(b.z), life: r2(b.maxLife ? b.life / b.maxLife : 0) }; }   // Z4: life 1→0 → klienten växer black hole mot explosionsradien
function _mapFw(w)  { return { id: w.id, x: r2(w.x), y: 0, z: r2(w.z), ry: r2(Math.atan2(w.dx, w.dz)), life: r2(w.maxLife ? w.life / w.maxLife : w.life), k: w.kind }; }   // k='wind' → Z3 lila vind-kon
function _mapNv(n)  { return { id: n.id, x: r2(n.x), z: r2(n.z), r: r2(n.r || NOVA_RADIUS), life: r2(n.maxLife ? n.life / n.maxLife : n.life), k: n.kind }; }   // k='q' → Kryx earthquake-puls (K1/K5), annars frost
function _mapAb(b)  { return { id: b.id, x: r2(b.x), z: r2(b.z) }; }
function _mapKg(w)  { return { id: w.id, x: r2(w.x), z: r2(w.z), ry: r2(Math.atan2(w.dx, w.dz)) }; }
function _mapKs(sl) { return { id: sl.id, x: r2(sl.x), z: r2(sl.z), ry: r2(Math.atan2(sl.dx, sl.dz)) }; }
function _mapVt(v)  { return { id: v.id, x: r2(v.x), z: r2(v.z), r: r2(v.radius || 3), life: r3(v.maxLife ? v.life / v.maxLife : v.life) }; }
function _mapTp(p)  { return { id: p.id, x: r2(p.x), z: r2(p.z), r: p.radius, life: r3(p.remaining / (p.duration || 1)) }; }
function _mapHm(h)  { return { id: h.id, x: r2(h.x), z: r2(h.z) }; }
function _mapIwe(e) { return { id: e.id, x: r2(e.x), z: r2(e.z), life: r3(e.life / (e.maxLife || 1)) }; }
function _mapKCln(c){ return { id: c.id, x: r2(c.x), z: r2(c.z), ry: r3(c.ry), hp: c.hp }; }   // Kostefo E lvl5 decoy-kloner (samma form som serializeSide)

// Writes side s's skill-entities into snap.<type>[i] (entity-type-major, keyed by side),
// the exact shape the Arena client already consumed. snap must have bh/fw/.../iwe containers.
function writeSkillEntitiesInto(s, snap, i) {
  snap.bh[i]  = arrOpt(s.blackHoles, _mapBh) || _ARENA_EMPTY_ARR;
  snap.fw[i]  = arrOpt(s.fireWaves, _mapFw) || _ARENA_EMPTY_ARR;
  snap.nv[i]  = arrOpt(s.novaEffects, _mapNv) || _ARENA_EMPTY_ARR;
  snap.ab[i]  = arrOpt(s.elarBanners, _mapAb) || _ARENA_EMPTY_ARR;
  snap.kg[i]  = arrOpt(s.kostefoGooseWaves, _mapKg) || _ARENA_EMPTY_ARR;
  snap.ks[i]  = arrOpt(s.kostefoSliders, _mapKs) || _ARENA_EMPTY_ARR;
  snap.vt[i]  = arrOpt(s.vineTraps, _mapVt) || _ARENA_EMPTY_ARR;
  snap.tp[i]  = arrOpt(s.thornPools, _mapTp) || _ARENA_EMPTY_ARR;
  snap.hm[i]  = arrOpt(s.hammers, _mapHm) || _ARENA_EMPTY_ARR;
  snap.iwe[i] = arrOpt(s.ironWillExplosions, _mapIwe) || _ARENA_EMPTY_ARR;
  snap.kCln[i] = arrOpt(s.kostefoClones, _mapKCln) || _ARENA_EMPTY_ARR;   // Kostefo E lvl5 decoy-kloner — nu synliga i arena/boss/sandbox (var bara line wars)
}

// Serialisera hela arena-state → a-state-meddelandet (matchar main.js
// broadcastArenaState så klientens applyArenaState läser det oförändrat).
// Entity-arrayerna byggs från LOGISKT state (server har ingen mesh) — fw/kg/ks
// härleder ry från dx/dz. Power-ups av (073).
// Perf: muterar _arenaSSnap på plats (undviker ~40 objekt-allokeringar/tick).
// Klienten ser exakt samma fält-struktur som tidigare — ingen format-skillnad.
function serializeArenaState(state) {
  const snap = _arenaSSnap;
  snap.ph = state.phase;
  snap.rn = state.roundNum;
  snap.w = state.wins;
  snap.pt = state.prepTimer;
  snap.sst = state.startingTimer;
  snap.spl = state.startingPhaseShown;
  snap.et = state.endTimer;
  snap.rw = state.roundWinner;
  snap.mw = state.matchWinner;
  snap.rdy = state.ready;
  snap.mp = state.mapIdx || 0;
  snap.sr = r2(state.shrinkRadius || 0);
  snap.ft = r2(state.fightTimer || 0);
  // Team-arena: ts + tm bara i team-läge — 1v1-payloaden förblir identisk.
  snap.ts = (state.teamSize && state.teamSize > 1) ? state.teamSize : undefined;
  // tal skickas bara under prep/roundEnd/matchEnd (då talents kan ändras).
  // Under fight/starting ändras de aldrig → klient behåller föregående snap.
  // chosen.slice() allokerar bara under dessa faser (ej fight-hot-path).
  if (state.phase === 'prep' || state.phase === 'roundEnd' || state.phase === 'matchEnd') {
    for (let i = 1; i <= 6; i++) {
      const tal = state.talents[i];
      if (tal) {
        if (!_arenaTalSnap[i]) _arenaTalSnap[i] = { p: 0, c: [] };
        _arenaTalSnap[i].p = tal.points;
        _arenaTalSnap[i].c = tal.chosen.slice();
      } else if (_arenaTalSnap[i]) {
        _arenaTalSnap[i] = undefined;   // sides 3-6 i 1v1 → fältet skippas i JSON
      }
    }
    snap.tal = _arenaTalSnap;
  } else {
    snap.tal = undefined;
  }
  // Orb: mutera sub-objektet på plats (undviker ny { hp,a,sp } allokering/tick)
  snap.o.hp = state.orb.hp;
  snap.o.a = state.orb.alive;
  snap.o.sp = state.orb.spawnTimer;
  // Hero-snapshots + entity-arrayer per side: 1..2*teamSize aktiva, resten
  // undefined → skippas i JSON (1v1 = exakt gamla payloaden).
  // _ARENA_EMPTY_ARR = konstant fryst [] → JSON.stringify skriver "[]" utan ny allokering.
  for (let i = 1; i <= 6; i++) {
    const s = state.sides[i];
    snap['h' + i] = s ? serializeArenaHero(s, _heroSnapBufs[i]) : undefined;
    if (!s) {
      snap.bh[i] = undefined; snap.fw[i] = undefined; snap.nv[i] = undefined;
      snap.ab[i] = undefined; snap.kg[i] = undefined; snap.ks[i] = undefined;
      snap.vt[i] = undefined; snap.tp[i] = undefined; snap.hm[i] = undefined;
      snap.iwe[i] = undefined; snap.kCln[i] = undefined;
      continue;
    }
    writeSkillEntitiesInto(s, snap, i); // SHARED — same shape Boss Wars/Sandbox now emit
  }
  return snap;
}

// ===== BOSS WARS — server-auth state + tick (Fas 2, decision 122) =====
// 3-spelar co-op mot EN boss. Speglar createArenaState-mönstret men 3 sides + boss i
// sides[1].monsters (isBossWarsBoss) precis som klientens buildBossWarsSnap läser den.
// ADDITIVT — inget anropar detta än (server.js wirar in i slice 0d). Boss-AI/skills/ads
// portas slice 2-4; HÄR bara state + STATISK boss för att validera pipelinen (slice 0).
const BOSSWARS_TIER_HP = { 1: 6500, 2: 8000, 3: 13000, 4: 20000, 5: 30000 };  // bas-hp (×3 raid-buff vid spawn). Tier 1: 5000→6500 (crit-comp dödade på ~14s = trivialt, mekanik hann ej aktiveras).
const BOSSWARS_TIER_DMGSCALE = { 1: 1.5, 2: 1.8, 3: 2.2, 4: 2.8, 5: 3.0 };    // matchar BOSS_WARS_DEFS (T5 3.5→3.0: one-shot-nerf 2026-06-07)
const BOSSWARS_TIER_SPEED = { 1: 3.8, 2: 4.7, 3: 5.0, 4: 5.2, 5: 5.4 };       // matchar spawnBossWarsBoss
const BOSSWARS_TIER_PHASE_THRESH = { 1: 0.5, 2: 0.5, 3: 0.5, 4: 0.3, 5: 0.3 };
const BOSSWARS_TIER_AA = {
  1: { kind: 'bw_goblinArrow', range: 8.5, interval: 1.2, travel: 0.6 },
  2: { kind: 'bw_warlockOrb',  range: 8.0, interval: 1.4, travel: 0.9 },
  3: { kind: 'bw_alienPlasma', range: 7.5, interval: 1.3, travel: 0.8 },
  4: { kind: 'bw_demonHeart',  range: 7.0, interval: 1.5, travel: 1.0 },
  5: { kind: 'bw_starshard',   range: 9.0, interval: 1.2, travel: 0.7 },
};
const BOSSWARS_TIER_DR = { 1: 0.10, 2: 0.15, 3: 0.20, 4: 0.25, 5: 0.30 };  // base-DR per tier (decision 110)
// Boss-skills phase 1 per tier (port av BOSS_DEFS[wave].skills i main.js). Slice 2b cast-machine
// castar dessa. Skill-kinds: groundCircle/cone/lineDash/multiCircle/sweepBeam/sustainedCone (skada)
// + projectile/projectileMulti/poolDot (= slice 2c, boss-skapade entiteter).
const BOSSWARS_TIER_SKILLS = {
  1: [
    { id: 'shieldBash', kind: 'lineDash', telegraph: 1.4, length: 11, width: 3.2, execTime: 0.5, dmgMul: 2.2, cd: 7.5 },
    { id: 'throwingAxe', kind: 'projectile', telegraph: 0.5, speed: 14, dmgMul: 1.8, radius: 1.0, range: 18, cd: 5.0 },
    { id: 'battleRoar', kind: 'groundCircle', telegraph: 1.4, radius: 7.5, dmgMul: 1.6, originSelf: true, slow: { dur: 2.5, mul: 0.5 }, cd: 9.0 },
  ],
  2: [
    { id: 'lightningStrike', kind: 'groundCircle', telegraph: 1.0, radius: 4.2, dmgMul: 2.4, targetHero: true, cd: 5.5 },
    { id: 'spearVolley', kind: 'projectileMulti', telegraph: 0.7, count: 4, spreadAngle: Math.PI / 6, speed: 18, dmgMul: 1.6, radius: 1.0, range: 18, cd: 6.5 },
    { id: 'warStomp', kind: 'groundCircle', telegraph: 1.3, radius: 9, dmgMul: 2.0, originSelf: true, knockback: 3.5, cd: 10.0 },
  ],
  3: [
    { id: 'cleaveWave', kind: 'cone', telegraph: 1.0, length: 12, halfAngle: Math.PI / 3, dmgMul: 2.6, cd: 6.0 },
    { id: 'poisonPool', kind: 'poolDot', telegraph: 1.0, radius: 4.5, duration: 7, dpsMul: 0.6, slow: { dur: 0.8, mul: 0.6 }, targetHero: true, cd: 7.5 },
    { id: 'earthquake', kind: 'multiCircle', telegraph: 0.7, count: 6, spawnInterval: 0.5, radius: 3.5, dmgMul: 1.7, spread: 9, cd: 11.0 },
  ],
  4: [
    { id: 'hellfireBeam', kind: 'sweepBeam', telegraph: 1.3, sweepDuration: 2.2, length: 16, halfAngle: Math.PI / 1.8, dpsMul: 1.8, cd: 10.0 },
    { id: 'infernoStrike', kind: 'groundCircle', telegraph: 0.8, radius: 3.2, dmgMul: 2.8, targetHero: true, leaveBurn: true, cd: 5.0 },
    { id: 'meteorShower', kind: 'multiCircle', telegraph: 0.9, count: 6, spawnInterval: 0.7, radius: 4.5, dmgMul: 2.4, spread: 13, cd: 13.0 },
  ],
  5: [
    { id: 'dragonBreath', kind: 'sustainedCone', telegraph: 1.3, sustainDuration: 2.8, length: 16, halfAngle: Math.PI / 2.8, dpsMul: 2.0, cd: 8.5 },
    { id: 'wingSlam', kind: 'groundCircle', telegraph: 1.0, radius: 7.5, dmgMul: 3.0, originSelf: true, knockback: 5.0, cd: 7.0 },
    { id: 'skyfireRain', kind: 'multiCircle', telegraph: 0.7, count: 10, spawnInterval: 0.6, radius: 4.0, dmgMul: 2.2, spread: 15, cd: 15.0 },
  ],
};
// Phase 2 skill-sets (port av BOSS_WARS_PHASE2_SKILLS, re-keyad wave→tier). Boss byter
// skill-array vid phaseThreshold-HP (slice 3a). Nya skills hårdare/mer komplexa.
const BOSSWARS_TIER_PHASE2_SKILLS = {
  1: [
    { id: 'berserkerCharge', kind: 'lineDash', telegraph: 0.9, length: 14, width: 3.5, execTime: 0.5, dmgMul: 3.0, cd: 5.5 },
    { id: 'whirlwindStrike', kind: 'groundCircle', telegraph: 1.0, radius: 6.5, dmgMul: 1.8, originSelf: true, slow: { dur: 1.8, mul: 0.5 }, cd: 6.5 },
    { id: 'warCry', kind: 'groundCircle', telegraph: 1.6, radius: 13, dmgMul: 2.2, originSelf: true, knockback: 3.0, cd: 12.0 },
  ],
  2: [
    { id: 'stormCall', kind: 'multiCircle', telegraph: 0.8, count: 10, spawnInterval: 0.4, radius: 4.0, dmgMul: 1.8, spread: 11, cd: 13.0 },
    { id: 'heavyArtillery', kind: 'projectileMulti', telegraph: 0.6, count: 6, spreadAngle: Math.PI / 4, speed: 20, dmgMul: 2.0, radius: 1.2, range: 22, cd: 7.5 },
    { id: 'shieldWall', kind: 'groundCircle', telegraph: 1.0, radius: 10, dmgMul: 2.4, originSelf: true, knockback: 4.5, cd: 9.0 },
  ],
  3: [
    { id: 'tectonicSlam', kind: 'groundCircle', telegraph: 1.2, radius: 13, dmgMul: 3.0, originSelf: true, knockback: 3.0, cd: 10.0 },
    { id: 'toxicCloud', kind: 'poolDot', telegraph: 0.9, radius: 7, duration: 9, dpsMul: 0.8, slow: { dur: 1.2, mul: 0.5 }, targetHero: true, cd: 8.0 },
    { id: 'boulderHurl', kind: 'projectile', telegraph: 0.5, speed: 22, dmgMul: 2.6, radius: 2.0, range: 26, cd: 5.5 },
  ],
  4: [
    { id: 'demonicEruption', kind: 'multiCircle', telegraph: 0.8, count: 10, spawnInterval: 0.4, radius: 5, dmgMul: 2.8, spread: 15, cd: 12.0 },
    { id: 'soulBurn', kind: 'poolDot', telegraph: 0.7, radius: 8, duration: 10, dpsMul: 1.0, slow: { dur: 1.5, mul: 0.5 }, targetHero: true, cd: 7.0 },
    { id: 'hellfireStorm', kind: 'sweepBeam', telegraph: 1.0, sweepDuration: 3.0, length: 20, halfAngle: Math.PI / 1.6, dpsMul: 2.2, cd: 9.0 },
  ],
  5: [
    { id: 'infernalRoar', kind: 'groundCircle', telegraph: 1.1, radius: 14, dmgMul: 3.5, originSelf: true, knockback: 6.0, cd: 8.5 },
    { id: 'dragonDive', kind: 'lineDash', telegraph: 0.8, length: 22, width: 4.0, execTime: 0.6, dmgMul: 4.0, cd: 7.0 },
    { id: 'meteorApocalypse', kind: 'multiCircle', telegraph: 0.6, count: 16, spawnInterval: 0.35, radius: 4.5, dmgMul: 2.8, spread: 18, cd: 14.0 },
  ],
};
const BOSSWARS_HERO_SPAWNS = {
  1: { x: BW_SPAWN_ROOM_CX,     z: BW_SPAWN_ROOM_CZ },
  2: { x: BW_SPAWN_ROOM_CX - 3, z: BW_SPAWN_ROOM_CZ + 4 },
  3: { x: BW_SPAWN_ROOM_CX - 3, z: BW_SPAWN_ROOM_CZ - 4 },
};
// ===== BOSS 3 (WARLORD) SYMBOL-MEKANIK =====
// Reveal: var 5% HP-loss visas EN symbol (1s) över bossen (minnesspel). Efter 5 reveals (vid
// 75/50/25% HP) blir bossen immun, teleporteras till mitten, 5 symboler spawnar i en ring.
// Var 5:e sek (runda 1+2) / 3:e sek (runda 3) pulserar bossen → 1-hit-dödar varje hjälte som
// INTE står i rätt symbol (rätt = reveal-ordningen). 5 pulser/runda. Runda 2 (50%) klar →
// phase-2 skill-swap (ersätter den generiska fly-up-övergången för tier 3).
const WARLORD_SHAPES = ['triangle', 'square', 'circle', 'pentagon', 'star'];
const WARLORD_NUM_SYMBOLS = 5;
const WARLORD_RING_RADIUS = 6.5;          // symboler 6.5m från mitten (inom BOSSWARS_RADIUS 36)
const WARLORD_SYMBOL_RADIUS = 2.28;       // hjälte måste vara inom denna av symbolen för immunitet (20% större → får plats med 3 spelare)
const WARLORD_REVEAL_TIME = 1.0;          // visningstid per reveal-symbol (stor, mitt på golvet)
const WARLORD_REVEAL_GAP = 0.3;           // blank paus mellan reveals (så sekvensen blir läsbar)
const WARLORD_PULSE_INTERVAL_P1 = 5.0;    // runda 1+2
const WARLORD_PULSE_INTERVAL_P2 = 3.0;    // runda 3 (25%)
const WARLORD_CHALLENGE_THRESH = [0.75, 0.50, 0.25];   // challenge-trösklar (fraktion av maxHp)
function warlordRevealThresholds(round) {
  // runda 1: .95 .90 .85 .80 .75 | runda 2: .70..50 | runda 3: .45..25
  const start = 0.95 - (round - 1) * 0.25;
  return [start, start - 0.05, start - 0.10, start - 0.15, start - 0.20];
}
function warlordShuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}
function warlordSameOrder(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function warlordMakeRoundSymbols(prev) {
  let order = warlordShuffle(WARLORD_SHAPES);
  let guard = 0;
  while (warlordSameOrder(order, prev) && guard++ < 20) order = warlordShuffle(WARLORD_SHAPES);
  return order;
}
// Returnerar true = bossen är upptagen (immun + AI pausad) denna tick.
// State-maskin: reveal-ackumulering (boss slåss, symboler köas+visas på golvet) →
// engaged (alla 5 avslöjade → boss immun+mitten, kvarvarande köade reveals visas klart) →
// challengeActive (pulser). Köning gör att burst-skada inte missar symbol-ordningen, och
// immuniteten startar vid full reveal så bossen aldrig kan dödas innan utmaningen.
function tickWarlordChallenge(state, dt, boss) {
  const w = boss.warlord;
  if (!w) return false;
  warlordTickRevealDisplay(w, dt);
  if (w.engaged) {
    if (w.challengeActive) {
      tickWarlordPulses(state, dt, boss);
    } else if (!w.revealDisplay && w.revealQueue.length === 0 && (w.revealGap || 0) <= 0) {
      // Alla köade reveals visade → starta pulserna.
      beginWarlordPulses(state, boss);
    }
    return true;   // immun + AI pausad genom hela symbol-fasen
  }
  // Reveal-ackumulering: boss slåss normalt; trösklar köar symboler (1 per 5% HP).
  if (w.round <= 3) {
    const frac = boss.hp / boss.maxHp;
    const thresholds = warlordRevealThresholds(w.round);
    while (w.revealIdx < WARLORD_NUM_SYMBOLS && frac <= thresholds[w.revealIdx]) {
      w.revealQueue.push(w.roundSymbols[w.revealIdx]);   // köa (burst → flera på en tick, ordning bevaras)
      w.revealIdx++;
    }
    if (w.revealIdx >= WARLORD_NUM_SYMBOLS) {
      engageWarlord(state, boss);   // alla avslöjade → immun + mitten; pulser efter att kön tömts
      return true;
    }
  }
  return false;
}
// Avancera den stora golv-reveal-symbolen (en i taget från kön, med blank paus emellan).
function warlordTickRevealDisplay(w, dt) {
  if (w.revealDisplay) {
    w.revealDisplay.remaining -= dt;
    if (w.revealDisplay.remaining <= 0) { w.revealDisplay = null; w.revealGap = WARLORD_REVEAL_GAP; }
    return;
  }
  if ((w.revealGap || 0) > 0) { w.revealGap = Math.max(0, w.revealGap - dt); return; }
  if (w.revealQueue.length) w.revealDisplay = { shape: w.revealQueue.shift(), remaining: WARLORD_REVEAL_TIME };
}
// Alla 5 avslöjade → boss immun + teleport till mitten. Pulserna börjar FÖRST när kön tömts
// (beginWarlordPulses) så spelarna hinner se hela sekvensen även vid burst.
function engageWarlord(state, boss) {
  const w = boss.warlord;
  w.engaged = true;
  w.challengeRound = w.round;
  // Klamp HP upp till fas-tröskeln (75/50/25%) så ingen burst tar bossen under den under
  // symbol-fasen. Bossen är immun under fasen → stannar exakt på tröskeln tills den är klar.
  // round är alltid 1-3 här (engage gateas av w.round<=3); clamp:a indexet defensivt mot NaN-HP.
  boss.hp = Math.max(boss.hp, WARLORD_CHALLENGE_THRESH[Math.min(2, w.round - 1)] * boss.maxHp);
  boss.x = BOSSWARS_CX; boss.z = BOSSWARS_CZ;   // teleport till mitten
  boss.activeCast = null;
  // Rensa pågående boss-projektiler/pooler så bara pulsen är hotet.
  if (state.bossProjectiles) state.bossProjectiles.length = 0;
  if (state.bossPools) state.bossPools.length = 0;
}
function beginWarlordPulses(state, boss) {
  const w = boss.warlord;
  w.challengeActive = true;
  // 5 symboler i ring; arrangemang OBEROENDE av reveal-ordningen (position avslöjar ej svaret).
  const ringShapes = warlordShuffle(w.roundSymbols);
  w.groundSymbols = ringShapes.map((shape, i) => {
    const ang = (i / WARLORD_NUM_SYMBOLS) * Math.PI * 2 - Math.PI / 2;
    return { shape, x: BOSSWARS_CX + Math.cos(ang) * WARLORD_RING_RADIUS, z: BOSSWARS_CZ + Math.sin(ang) * WARLORD_RING_RADIUS };
  });
  w.pulseIdx = 0;
  w.pulseInterval = (w.round === 3) ? WARLORD_PULSE_INTERVAL_P2 : WARLORD_PULSE_INTERVAL_P1;
  w.pulseTimer = w.pulseInterval;   // första pulsen efter ett intervall (tid att springa till symbol 1)
}
function tickWarlordPulses(state, dt, boss) {
  const w = boss.warlord;
  w.pulseTimer -= dt;
  if (w.pulseTimer > 0) return;
  const requiredShape = w.roundSymbols[w.pulseIdx];
  const safeSym = w.groundSymbols.find(s => s.shape === requiredShape);
  const rSq = WARLORD_SYMBOL_RADIUS * WARLORD_SYMBOL_RADIUS;
  for (const idx of [1, 2, 3]) {
    const s = state.sides[idx];
    if (!s || s.hero.dead) continue;
    if ((s.phoenixImmuneRemaining || 0) > 0) continue;   // respektera phoenix-revive-immunitet
    let safe = false;
    if (safeSym) {
      const dx = s.hero.x - safeSym.x, dz = s.hero.z - safeSym.z;
      if (dx * dx + dz * dz <= rSq) safe = true;
    }
    if (!safe) killHero(s);   // 1-hit (respekterar phoenix-item via killHero)
  }
  w.pulseCounter = (w.pulseCounter || 0) + 1;   // delta → klient triggar shockwave-FX
  w.pulseIdx++;
  if (w.pulseIdx >= WARLORD_NUM_SYMBOLS) endWarlordChallenge(state, boss);
  else w.pulseTimer = w.pulseInterval;
}
function endWarlordChallenge(state, boss) {
  const w = boss.warlord;
  w.challengeActive = false;
  w.engaged = false;             // boss sårbar igen
  w.groundSymbols = [];
  // Runda 2 (50%) klar → phase-2 (skill-swap + dmg-boost). Ersätter generisk fly-up för tier 3.
  if (w.challengeRound === 2 && boss.bossPhase === 1 && boss.phase2Skills) {
    boss.bossPhase = 2;
    boss.bossSkills = boss.phase2Skills;
    boss.skillCds = boss.phase2Skills.map(s => s.cd * 0.4);
    boss.damage = Math.round(boss.damage * 1.25);
    boss.phase2DrBonus = 0.20;   // +20pp DR i fas 2 (samma som generisk övergång, användarbeslut)
  }
  w.prevRoundSymbols = w.roundSymbols;
  w.round++;
  w.revealIdx = 0;
  w.challengeRound = 0;
  w.revealQueue.length = 0;
  w.revealDisplay = null;
  w.revealGap = 0;
  if (w.round <= 3) w.roundSymbols = warlordMakeRoundSymbols(w.prevRoundSymbols);
}

// ===== BOSS 5 (DRAGON KING) BREAKPOINT-MEKANIK-RAMVERK (decision 135) =====
// Combat-fas avbryts vid 80/60/40% HP av en kooperativ mekanik (boss otargetbar+immun+mitten),
// 20% = fas 2 (buff-placeholder). Extensibelt: lägg till breakpoint-värde + en start-funktion.
// Endast tier 5. Server-auth (MP, 3 spelare). Solo-port i main.js (1-spelar-varianter).
const DRAGON_SYMBOLS = ['sword', 'crown', 'skull', 'eye', 'flame', 'moon'];
const DRAGON_BREAKS = [0.80, 0.60, 0.40, 0.20];   // 80=memory, 60=soul link, 40=meteor, 20=fas 2
const DRAGON_MEM_REVEAL_HP = [0.95, 0.90, 0.85];   // 3 symbol-reveals under combat 100→80%
const DRAGON_MEM_REVEAL_TIME = 1.0, DRAGON_MEM_GAP = 0.3;
const DRAGON_MEM_TIMER = 30, DRAGON_MEM_WRONG_DMG = 0.20, DRAGON_MEM_MAX_MISTAKES = 3;
const DRAGON_MEM_PILLAR_RADIUS = 7.0, DRAGON_MEM_STAND_RADIUS = 2.0, DRAGON_ACT_PILLAR_RADIUS = 2.2;
const DRAGON_P2_DMG_MUL = 1.15, DRAGON_P2_DR_BONUS = 0.20;   // fas-2-dmg 1.30→1.15: fas-2-one-shot-nerf 2026-06-07
function dragonPickMemSymbols() {
  const a = DRAGON_SYMBOLS.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a.slice(0, 3);
}
function dragonKill(side) {   // mekanik-död är SLUTGILTIG — kringgår phoenix-revive ("dör direkt")
  if (!side || side.hero.dead) return;
  side.phoenixReviveAvailable = false;
  killHero(side);
}
function dragonWipe(state) {   // raid wipe — alla 3 dör (ingen respawn i boss wars)
  for (const idx of [1, 2, 3]) dragonKill(state.sides[idx]);
}
// Huvud-gate (anropas i tickBossWarsBoss). Returnerar true = boss immun + AI pausad denna tick.
function tickDragonMechanics(state, dt, boss) {
  const d = boss.dragon; if (!d) return false;
  if (d.active) {
    if (d.mech === 1) tickDragonMemory(state, dt, boss);
    else if (d.mech === 2) tickDragonSoulLink(state, dt, boss);
    else if (d.mech === 3) tickDragonMeteor(state, dt, boss);
    return true;   // mekanik pågår → boss immun (bossWarsDmgMod) + AI pausad
  }
  dragonTickMemoryReveals(state, dt, boss);   // visar symbolerna under combat 100→80%
  const frac = boss.hp / boss.maxHp;
  if (d.breakIdx < DRAGON_BREAKS.length && frac <= DRAGON_BREAKS[d.breakIdx]) {
    const bf = DRAGON_BREAKS[d.breakIdx]; d.breakIdx++;
    dragonStartBreak(state, boss, bf);
    return true;
  }
  return false;
}
function dragonTickMemoryReveals(state, dt, boss) {
  const d = boss.dragon;
  if (d.memReveal) { d.memReveal.remaining -= dt; if (d.memReveal.remaining <= 0) { d.memReveal = null; d.memGap = DRAGON_MEM_GAP; } return; }
  if ((d.memGap || 0) > 0) { d.memGap = Math.max(0, d.memGap - dt); return; }
  const frac = boss.hp / boss.maxHp;
  while (d.memRevealIdx < 3 && frac <= DRAGON_MEM_REVEAL_HP[d.memRevealIdx]) { d.memQueue.push(d.memSymbols[d.memRevealIdx]); d.memRevealIdx++; }
  if (d.memQueue.length) d.memReveal = { shape: d.memQueue.shift(), remaining: DRAGON_MEM_REVEAL_TIME };
}
function dragonStartBreak(state, boss, bf) {
  boss.hp = Math.max(boss.hp, bf * boss.maxHp);   // klamp till tröskeln (ingen burst under)
  boss.x = BOSSWARS_CX; boss.z = BOSSWARS_CZ;       // teleport mitten
  boss.activeCast = null;
  if (state.bossProjectiles) state.bossProjectiles.length = 0;
  if (state.bossPools) state.bossPools.length = 0;
  if (bf === 0.80) startDragonMemory(state, boss);
  else if (bf === 0.60) startDragonSoulLink(state, boss);
  else if (bf === 0.40) startDragonMeteor(state, boss);
  else if (bf === 0.20) dragonEnterPhase2(state, boss);
}
// --- MEKANIK 1: MEMORY TRIAL ---
function startDragonMemory(state, boss) {
  const d = boss.dragon;
  d.active = true; d.mech = 1;
  d.memStep = 0; d.memMistakes = 0; d.memTimer = DRAGON_MEM_TIMER; d.memReveal = null;
  d.memPillars = DRAGON_SYMBOLS.map((sym, i) => {
    const ang = (i / DRAGON_SYMBOLS.length) * Math.PI * 2 - Math.PI / 2;
    return { sym, x: BOSSWARS_CX + Math.cos(ang) * DRAGON_MEM_PILLAR_RADIUS, z: BOSSWARS_CZ + Math.sin(ang) * DRAGON_MEM_PILLAR_RADIUS };
  });
  d.actPillar = { x: BOSSWARS_CX, z: BOSSWARS_CZ };   // aktiverings-pelare i mitten
  d.msg = 'Remember what was shown.';
}
function tickDragonMemory(state, dt, boss) {
  const d = boss.dragon;
  if ((d.memActLock || 0) > 0) d.memActLock = Math.max(0, d.memActLock - dt);   // debounce-timer
  d.memTimer -= dt;
  if (d.memTimer <= 0) { d.active = false; dragonWipe(state); }
}
// Aktiveringsknapp tryckt (MP: aktivator vid mitten-pelaren + ≥2 spelare i rätt symbol).
function dragonMemActivate(state, sideIdx) {
  const boss = state.boss, d = boss && boss.dragon;
  if (!d || !d.active || d.mech !== 1) return;
  if ((d.memActLock || 0) > 0) return;   // debounce: hindra knapp-spam → burst-missar på en tick
  const actor = state.sides[sideIdx];
  if (!actor || actor.hero.dead) return;
  if (Math.hypot(actor.hero.x - d.actPillar.x, actor.hero.z - d.actPillar.z) > DRAGON_ACT_PILLAR_RADIUS) return;
  d.memActLock = 0.5;
  const wp = d.memPillars.find(p => p.sym === d.memSymbols[d.memStep]);
  // Require ALL alive teammates on the correct symbol. Was hard-coded `count >= 2`, which is
  // impossible once a player dies and <3 remain → every activation = mistake → guaranteed wipe
  // loop. Now scales: 3 alive→2 others, 2 alive→1 other, lone survivor→advances. (user 2026-06-25)
  let aliveOthers = 0, onSymbol = 0;
  for (const idx of [1, 2, 3]) {
    if (idx === sideIdx) continue;
    const s = state.sides[idx];
    if (!s || s.hero.dead) continue;
    aliveOthers++;
    if (wp && Math.hypot(s.hero.x - wp.x, s.hero.z - wp.z) <= DRAGON_MEM_STAND_RADIUS) onSymbol++;
  }
  if (wp && onSymbol >= aliveOthers) { d.memStep++; if (d.memStep >= 3) dragonMemSuccess(state, boss); }
  else dragonMemMistake(state, boss);
}
function dragonMemMistake(state, boss) {
  const d = boss.dragon;
  d.memMistakes++;
  for (const idx of [1, 2, 3]) { const s = state.sides[idx]; if (s && !s.hero.dead) damageHero(s, s.hero.maxHp * DRAGON_MEM_WRONG_DMG); }
  if (d.memMistakes >= DRAGON_MEM_MAX_MISTAKES) { d.active = false; dragonWipe(state); }
}
function dragonMemSuccess(state, boss) {
  const d = boss.dragon;
  d.active = false; d.mech = 0; d.memPillars = []; d.msg = '';
}
// --- FAS 2 (20%): placeholder-buff. Extensibelt — framtida mekanik kan ersätta/utöka. ---
function dragonEnterPhase2(state, boss) {
  const d = boss.dragon;
  if (boss.bossPhase !== 2) {
    boss.bossPhase = 2;
    boss.damage = Math.round(boss.damage * DRAGON_P2_DMG_MUL);   // +30% skada
    boss.phase2DrBonus = DRAGON_P2_DR_BONUS;                      // +20% DR
    if (boss.phase2Skills) { boss.bossSkills = boss.phase2Skills; boss.skillCds = boss.phase2Skills.map(s => s.cd * 0.4); }
  }
  d.active = false; d.mech = 0; d.msg = '';   // ingen mekanik än — combat fortsätter med buff
}
// --- MEKANIK 2: SOUL LINK TRIAL (60%) — MP-only (3 spelare). Solo hoppar denna breakpoint. ---
const DRAGON_SL_TIMER = 30, DRAGON_SL_BREAKS_REQ = 3;
const DRAGON_SL_CHAIN_MAX = 12, DRAGON_SL_BREAK_WINDOW = 2.0, DRAGON_SL_INTERCEPT_BAND = 1.6;   // brytfönster 1.5→2.0: mer marginal på mobil 2026-06-07
const DRAGON_SL_ORB_COUNT = 10, DRAGON_SL_ORB_SPEED = 6, DRAGON_SL_ORB_DMG = 0.10, DRAGON_SL_ORB_HIT_RADIUS = 1.3, DRAGON_SL_ORB_HIT_CD = 1.0;   // orb-dmg 0.15→0.10: 10 orbs × koordination var för hårt 2026-06-07
function dragonPointOnSegment(px, pz, ax, az, bx, bz, band) {
  const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz;
  if (len2 < 0.01) return false;
  let t = ((px - ax) * dx + (pz - az) * dz) / len2; t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cz = az + t * dz;
  return Math.hypot(px - cx, pz - cz) <= band;
}
function dragonSpawnOrbs(d) {
  d.slOrbs = [];
  for (let i = 0; i < DRAGON_SL_ORB_COUNT; i++) {
    const ang = Math.random() * Math.PI * 2, r = Math.random() * BOSSWARS_RADIUS * 0.6, dir = Math.random() * Math.PI * 2;
    d.slOrbs.push({ x: BOSSWARS_CX + Math.cos(ang) * r, z: BOSSWARS_CZ + Math.sin(ang) * r, vx: Math.cos(dir) * DRAGON_SL_ORB_SPEED, vz: Math.sin(dir) * DRAGON_SL_ORB_SPEED });
  }
}
function dragonNewSoulPair(state, d) {
  const alive = [1, 2, 3].filter(i => state.sides[i] && !state.sides[i].hero.dead);
  if (alive.length < 3) { d.slPair = null; return; }   // kräver alla 3 (2 länkade + 1 interceptor)
  for (let i = alive.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = alive[i]; alive[i] = alive[j]; alive[j] = t; }
  d.slPair = [alive[0], alive[1]]; d.slState = 'linking'; d.slWindow = 0;
}
function startDragonSoulLink(state, boss) {
  const d = boss.dragon;
  d.active = true; d.mech = 2;
  d.slBreaks = 0; d.slTimer = DRAGON_SL_TIMER;
  dragonSpawnOrbs(d);
  dragonNewSoulPair(state, d);
  d.msg = 'Stretch the chain — third stands in it as it snaps!';
}
function dragonTickOrbs(state, dt, d) {
  if (!d.slOrbs) return;
  for (const o of d.slOrbs) {
    o.x += o.vx * dt; o.z += o.vz * dt;
    const dx = o.x - BOSSWARS_CX, dz = o.z - BOSSWARS_CZ, dd = Math.hypot(dx, dz) || 0.001;
    if (dd > BOSSWARS_RADIUS - 1) {   // studsa mot arena-kanten
      const nx = dx / dd, nz = dz / dd, dot = o.vx * nx + o.vz * nz;
      o.vx -= 2 * dot * nx; o.vz -= 2 * dot * nz;
      o.x = BOSSWARS_CX + nx * (BOSSWARS_RADIUS - 1); o.z = BOSSWARS_CZ + nz * (BOSSWARS_RADIUS - 1);
    }
    for (const idx of [1, 2, 3]) {
      const s = state.sides[idx];
      if (!s || s.hero.dead) continue;
      if ((s._dragonOrbCd || 0) <= 0 && Math.hypot(s.hero.x - o.x, s.hero.z - o.z) <= DRAGON_SL_ORB_HIT_RADIUS) {
        damageHero(s, s.hero.maxHp * DRAGON_SL_ORB_DMG); s._dragonOrbCd = DRAGON_SL_ORB_HIT_CD;
      }
    }
  }
  for (const idx of [1, 2, 3]) { const s = state.sides[idx]; if (s && (s._dragonOrbCd || 0) > 0) s._dragonOrbCd = Math.max(0, s._dragonOrbCd - dt); }
}
function tickDragonSoulLink(state, dt, boss) {
  const d = boss.dragon;
  d.slTimer -= dt;
  if (d.slTimer <= 0) { d.active = false; dragonWipe(state); return; }
  dragonTickOrbs(state, dt, d);
  if (!d.slPair) { dragonNewSoulPair(state, d); if (!d.slPair) { d.active = false; d.mech = 0; d.slOrbs = []; d.msg = ''; return; } }   // can't form a pair (<3 alive) → END trial, don't wipe (user 2026-06-25)
  const a = state.sides[d.slPair[0]], b = state.sides[d.slPair[1]];
  // A linked hero died (e.g. to an orb) → re-pair if 3 are still alive, else END the trial WITHOUT a
  // raid wipe. Instant-wiping the whole raid on one orb death was too punishing. (user 2026-06-25)
  if (!a || !b || a.hero.dead || b.hero.dead) { dragonNewSoulPair(state, d); if (!d.slPair) { d.active = false; d.mech = 0; d.slOrbs = []; d.msg = ''; } return; }
  const dist = Math.hypot(a.hero.x - b.hero.x, a.hero.z - b.hero.z);
  if (d.slState === 'linking') {
    if (dist >= DRAGON_SL_CHAIN_MAX) { d.slState = 'breaking'; d.slWindow = DRAGON_SL_BREAK_WINDOW; }
  } else if (d.slState === 'breaking') {
    d.slWindow -= dt;
    if (d.slWindow <= 0) {
      const third = [1, 2, 3].find(i => i !== d.slPair[0] && i !== d.slPair[1]);
      const t = state.sides[third];
      const onLine = t && !t.hero.dead && dragonPointOnSegment(t.hero.x, t.hero.z, a.hero.x, a.hero.z, b.hero.x, b.hero.z, DRAGON_SL_INTERCEPT_BAND);
      if (onLine) {
        d.slBreaks++;
        if (d.slBreaks >= DRAGON_SL_BREAKS_REQ) { d.active = false; d.mech = 0; d.slPair = null; d.slOrbs = []; d.msg = ''; }
        else dragonNewSoulPair(state, d);
      } else { d.active = false; dragonWipe(state); }   // kedjan brister utan interceptor → wipe (länkade dör)
    }
  }
}
// --- MEKANIK 3: METEOR RIDDLE (40%) — 3 rundor. Körs i MP OCH solo (1 spelare = 1 säker cirkel). ---
const DRAGON_MT_ROUNDS = 3, DRAGON_MT_COUNTDOWN = 6, DRAGON_MT_CIRCLE_RADIUS = 2.0;   // countdown 5→6: gåta+spring för snålt på mobil 2026-06-07
const DRAGON_MT_COLORS = ['red', 'blue', 'green'];
const DRAGON_MT_HINTS = {
  red: ['Nothing is hotter than the flames.', 'Embers never lie — follow the burning hue.', 'Seek the color of fire and fury.'],
  blue: ['The deepest oceans never forget.', 'The sky reflects eternity.', 'Cold depths keep the worthy safe.'],
  green: ['Life always returns through nature.', 'The forest remembers all.', 'Where the leaves grow, you will live.'],
};
function dragonPickHint(color) { const a = DRAGON_MT_HINTS[color]; return a[(Math.random() * a.length) | 0]; }
function dragonMakeMeteorCircles() {
  const pts = [], rings = [{ r: 5, n: 5 }, { r: 9.5, n: 5 }, { r: 14, n: 5 }];
  for (const ring of rings) for (let i = 0; i < ring.n; i++) {
    const ang = (i / ring.n) * Math.PI * 2 + ring.r * 0.3;
    pts.push({ x: BOSSWARS_CX + Math.cos(ang) * ring.r, z: BOSSWARS_CZ + Math.sin(ang) * ring.r });
  }
  const colors = [];
  for (const c of DRAGON_MT_COLORS) for (let i = 0; i < 5; i++) colors.push(c);
  for (let i = colors.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = colors[i]; colors[i] = colors[j]; colors[j] = t; }
  return pts.map((p, i) => ({ x: p.x, z: p.z, color: colors[i] }));
}
function dragonMeteorNewRound(d) {
  d.mtSafe = DRAGON_MT_COLORS[(Math.random() * 3) | 0];
  d.mtCircles = dragonMakeMeteorCircles();
  d.mtHint = dragonPickHint(d.mtSafe);
  d.mtCountdown = DRAGON_MT_COUNTDOWN;
  d.mtState = 'countdown';
}
function startDragonMeteor(state, boss) {
  const d = boss.dragon;
  d.active = true; d.mech = 3; d.mtRound = 0;
  dragonMeteorNewRound(d);
  d.msg = 'Read the riddle — stand on the safe color!';
}
function dragonMeteorResolve(state, boss) {
  const d = boss.dragon;
  for (const c of d.mtCircles) c._occ = 0;
  for (const idx of [1, 2, 3]) {
    const s = state.sides[idx]; if (!s || s.hero.dead) continue;
    let safeCircle = null;
    for (const c of d.mtCircles) { if (Math.hypot(s.hero.x - c.x, s.hero.z - c.z) <= DRAGON_MT_CIRCLE_RADIUS && c.color === d.mtSafe) { safeCircle = c; break; } }
    s._mtSafeCircle = safeCircle;
    if (safeCircle) safeCircle._occ++;
  }
  for (const idx of [1, 2, 3]) {
    const s = state.sides[idx]; if (!s || s.hero.dead) continue;
    if (!s._mtSafeCircle || s._mtSafeCircle._occ !== 1) dragonKill(s);   // fel färg / utanför / delad cirkel = död
  }
  d.mtRound++;
  if (![1, 2, 3].some(i => state.sides[i] && !state.sides[i].hero.dead)) { d.active = false; d.mech = 0; d.mtCircles = []; d.msg = ''; return; }   // alla döda → checkBossWarsEnd
  if (d.mtRound >= DRAGON_MT_ROUNDS) { d.active = false; d.mech = 0; d.mtCircles = []; d.msg = ''; }
  else dragonMeteorNewRound(d);
}
function tickDragonMeteor(state, dt, boss) {
  const d = boss.dragon;
  if (d.mtState === 'countdown') {
    d.mtCountdown -= dt;
    if (d.mtCountdown <= 0) dragonMeteorResolve(state, boss);
  }
}

function createBossWarsState(tier) {
  const t = Math.max(1, Math.min(5, tier || 1));
  const sides = { 1: createSide(1), 2: createSide(2), 3: createSide(3) };
  const state = {
    mode: 'bosswars',
    tier: t,
    sides,
    nextEntityId: 1,
    // OBS: INTE duelActive — boss wars är CO-OP, ingen hero-vs-hero PvP (friendly fire).
    // Heroes targetar bossen (ett monster) via vanlig monster-targeting (slice 1-2).
    duelActive: false,
    gateClosed: false,        // korridor-gate (stängs när alla inne i boss-rummet, slice 4)
    bossActivated: false,
    bossProjectiles: [], bossPools: [],   // boss skill-projektiler (directional) + DoT-pooler (slice 2c)
    bossWarsMinions: [], bossWarsWave: { countdown: 0, active: false },   // boss-1 minion-vågor (slice 3b)
    boss2Ads: [], boss2KillCooldown: { remaining: 0 }, boss2AdWaveTimer: { remaining: 0, active: false }, boss2AdWaveSpawn: { countdown: 0, active: false },   // boss-2 ads (3b-ii)
    boss4Minions: [], boss4Bags: [], boss4Pools: [], boss4Spawn: { countdown: 0, active: false }, _b4PoolAccum: 0,   // boss-4 poison-bag-mekanik (decision 132)
    lastInputs: { 1: { j: { x: 0, z: 0 } }, 2: { j: { x: 0, z: 0 } }, 3: { j: { x: 0, z: 0 } } },
    matchState: { gameOver: false, winner: 0 },
  };
  for (const idx of [1, 2, 3]) {
    const s = sides[idx];
    s.inBossWars = true;
    s._bwGateClosed = false;
    const sp = BOSSWARS_HERO_SPAWNS[idx];
    s.hero.x = sp.x; s.hero.z = sp.z;
    s.hero.facingX = 1; s.hero.facingZ = 0;
    // Boss wars = full-power lvl 30 + maxade skills (mirror initArenaMatch / klientens enterPlayPhase).
    s.level = 30; s.xp = 0; s.xpToNext = xpForLevel(30);
    s.skillLvl = { q: SKILL_LEVEL_MAX, f: SKILL_LEVEL_MAX, e: SKILL_LEVEL_MAX };
  }
  // STATISK boss (slice 0) i sides[1].monsters — full AI/skills/faser portas slice 2-3.
  // x/z direkt på objektet (server har ingen mesh); raid-buff ×3 matchar spawnBossWarsBoss.
  // Raid-buff ×3.0, sedan användar-buff +150% (×2.5) = ×7.5 total.
  const bossHp = Math.round(BOSSWARS_TIER_HP[t] * 3.0 * 2.5);
  const bossId = state.nextEntityId++;
  const aa = BOSSWARS_TIER_AA[t];
  const boss = {
    id: bossId, isBossWarsBoss: true, isBoss: true,
    x: BOSSWARS_CX, z: BOSSWARS_CZ,
    hp: bossHp, maxHp: bossHp,
    bossPhase: 1, phaseTransitionRemaining: 0, aaCount: 0,
    activeCast: null, bossTier: t,
    // Combat-stats (mirror spawnBossWarsBoss): dmg = 42 × dmgScale × 1.5 (raid +50%)
    // × 1.25 (användar-buff +25% all damage). bossEffectiveDamage läser boss.damage →
    // täcker AA + alla skills + DoT-pooler. Ads har egna konstanter (orörda).
    speed: BOSSWARS_TIER_SPEED[t],
    damage: Math.round(42 * BOSSWARS_TIER_DMGSCALE[t] * 1.5 * 1.25),
    attackType: 'range', attackRange: aa.range, attackInterval: aa.interval,
    projTime: aa.travel, projKind: aa.kind, atkCd: 0,
    phaseThreshold: BOSSWARS_TIER_PHASE_THRESH[t],
    // Skill-data (slice 2b cast-machine castar dessa). Initial-CD 40% (mirror spawnBossWarsBoss).
    bossSkills: BOSSWARS_TIER_SKILLS[t],
    skillCds: BOSSWARS_TIER_SKILLS[t].map(s => s.cd * 0.4),
    phase2Skills: BOSSWARS_TIER_PHASE2_SKILLS[t], _pendingPhase2: false, phaseTransitionTotal: 2.5,
    // Boss-DR-fält (decision 110) — wrapper-applicering wiras slice 2b.
    dmgReductionBase: BOSSWARS_TIER_DR[t], dmgReductionStep: 0.05,
    dmgReductionStepIntervalSec: 120, dmgReductionCap: 0.70, spawnTime: 0,
  };
  // Boss 3 (Warlord): symbol-mekanik-state. Endast tier 3.
  if (t === 3) {
    boss.warlord = {
      round: 1, revealIdx: 0,
      roundSymbols: warlordMakeRoundSymbols(null), prevRoundSymbols: null,
      revealQueue: [], revealDisplay: null, revealGap: 0,
      engaged: false, challengeActive: false, challengeRound: 0,
      groundSymbols: [],
      pulseIdx: 0, pulseTimer: 0, pulseInterval: WARLORD_PULSE_INTERVAL_P1, pulseCounter: 0,
    };
  }
  // Boss 5 (Dragon King): breakpoint-mekanik-state. Endast tier 5 (decision 135).
  if (t === 5) {
    boss.dragon = {
      breakIdx: 0, active: false, mech: 0,
      memSymbols: dragonPickMemSymbols(), memRevealIdx: 0, memReveal: null, memQueue: [], memGap: 0,
      memPillars: [], actPillar: { x: BOSSWARS_CX, z: BOSSWARS_CZ }, memStep: 0, memMistakes: 0, memTimer: 0,
      msg: '',
    };
  }
  sides[1].monsters.push(boss);
  sides[1].bossWarsBossId = bossId;
  state.boss = boss;   // direkt-ref för serialisering (undviker .find per 30 Hz-tick)
  // Co-op: dela monster-array-REFERENSEN så ALLA 3 hjältars findClosestHostile/
  // updateHeroAttack/updateProjectiles hittar bossen (mirror klientens enterPlayPhase 27559).
  // Boss-AI tickas bara 1× (via state.boss i slice 2), ej per-side → ingen trippel-tick.
  sides[2].monsters = sides[1].monsters;
  sides[3].monsters = sides[1].monsters;
  return state;
}
function initBossWarsMatch(heroes, tier, loadouts) {
  const state = createBossWarsState(tier);
  for (const idx of [1, 2, 3]) {
    const side = state.sides[idx];
    if (heroes && typeof heroes[idx] === 'string') {
      side.heroId = heroes[idx];
      side.heroPickConfirmed = true;
    }
    // C3-försvar: aldrig köra simmen med undefined heroId (peer hann ej bekräfta hjälte) → zyro-fallback.
    if (!side.heroId) side.heroId = 'zyro';
    // Boss-wars-loadout per peer (talents + items). Cappas server-side (3 talents / 4 items)
    // som spoof-skydd mot manipulerade payloads. recomputeSideStats applicerar stat-bonusarna.
    const lo = loadouts && loadouts[idx];
    // Dedup + validate against the catalog before capping — a count-only cap let a spoofed payload
    // stack the SAME talent/item 3-4× (e.g. 4× Tome = +140% SD) and break boss-wars balance
    // (anti-cheat audit 2026-06-23). Set() removes dupes; filter drops unknown ids.
    side.bossWarsTalents = [...new Set(((lo && Array.isArray(lo.tals)) ? lo.tals : []).filter(id => ENGINE_BOSS_WARS_TALENTS[id]))].slice(0, 3);
    side.bossWarsItems = [...new Set(((lo && Array.isArray(lo.items)) ? lo.items : []).filter(id => ENGINE_BOSS_WARS_ITEMS[id]))].slice(0, 4);
    // recomputeArenaSideStats no-op:ar arena-talent-delen (state.talents saknas i boss wars)
    // men kör recomputeSideStats → bas-stats + boss-wars-loadout (foldas i recomputeSideStats).
    recomputeArenaSideStats(state, side);
  }
  return state;
}

// ───────── SANDBOX — träningsläge (2026-06-18) ─────────────────────────────
// Server-auktoritativt så det ALLTID speglar live-spelet (samma skill-kod → auto-synkat).
// Återanvänder boss-wars hjälte-combat EXAKT: 3 odödliga dummy-monster läggs i
// sides[1].monsters (delad ref) → hjältens AA/skills träffar dem via samma funktioner.
// EGEN tick (rör ALDRIG tickBossWars) → live-boss-koden är orörd.
const SANDBOX_DUMMY_HP = 5000;   // sänkt 50000→5000 (synlig HP-bar-rörelse per spell-cast; odödliga ändå)
const SANDBOX_DUMMY_REGEN_DELAY = 3.0;   // sek utan träff innan dummyn fyller HP igen
function sandboxMakeDummy(state, x, z) {
  return {
    id: state.nextEntityId++, isSandboxDummy: true,
    x, z, ry: 0, _ax: x, _az: z,   // _ax/_az = ankare → snäpps tillbaka varje tick (står STILLA)
    hp: SANDBOX_DUMMY_HP, maxHp: SANDBOX_DUMMY_HP,
    _lastHp: SANDBOX_DUMMY_HP, _regenTimer: 0,
    frozenTime: 0, dotRemaining: 0, dotPerSec: 0, poisonRemaining: 0,
    slowTime: 0, slowMul: 1, nyroMarked: 0,
  };
}
function sandboxNearestDummy(state, x, z) {
  let best = null, bestD = Infinity;
  for (const d of (state.sandboxDummies || [])) {
    if (d.hp <= 1) continue;
    const dd = (d.x - x) * (d.x - x) + (d.z - z) * (d.z - z);
    if (dd < bestD) { bestD = dd; best = d; }
  }
  return best;
}
// (Re)konfigurera side 1:s hjälte till given hjälte på max (lvl 30 + maxade skills).
function sandboxSetupHero(state, heroId) {
  const side = state.sides[1];
  side.heroId = heroId || 'zyro';
  side.heroPickConfirmed = true;
  side.hero.dead = false;
  side.hero.respawnTimer = 0;
  side.hero.x = BOSSWARS_CX - 15; side.hero.z = BOSSWARS_CZ;   // inne i boss-rummet
  side.hero.frozenTime = 0; side.hero.dotRemaining = 0; side.hero.poisonRemaining = 0;
  side.heroFearTime = 0; side.iceBlockRemaining = 0;
  // Städa FÖRRA hjältens state vid byte → ren start, "samma inställningar som andra lägen".
  for (const arr of ['fireballs', 'projectiles', 'blackHoles', 'vineTraps', 'thornPools', 'hammers',
                     'novaEffects', 'shatters', 'fireWaves', 'kostefoGooseWaves', 'kostefoSliders',
                     'kostefoUltJoints', 'kostefoClones', 'elarBanners', 'ironWillExplosions',
                     'heroCopies', 'heroCopyFireballs', 'creepProjectiles', 'monsterProjectiles'])
    if (Array.isArray(side[arr])) side[arr].length = 0;
  side.laserBeam = null; side.rageRemaining = 0; side.berserkRemaining = 0; side.berserkCharged = false;
  side.gandulfBuffRemaining = 0; side.gandulfBuffStacks = 0; side.nyroBuffRemaining = 0;
  side.nyroInvisRemaining = 0; side.nyroUltAaPending = false; side.kostefoCloudRemaining = 0;
  side.kostefoCompanion = null; side.kostefoUltRemaining = 0; side.kostefoUltJointsState = null;
  side.zheynaClone = null; side.zheynaSpear = null; side.zheynaUltSpear = null; side.zheynaUltCharging = false;
  side.zheynaWarpathRem = 0; side.windPuffMsRem = 0; side.kryxHammerMsRem = 0; side.titansTauntRemaining = 0;
  resetXinaState(side);   // Xina (decision 139)
  side.ironWillRemaining = 0; side.ironWillStored = 0; side._ultLockoutTime = 0;
  side.elarShoutBuffTime = 0; side.elarShoutHealRemaining = 0; side.elarShoutHealPct = 0;
  side.hero.tauntedTime = 0; side.heroSlowTime = 0; side.heroSlowMul = 1; side.attackCounter = 0;
  side.skillLvl = { q: SKILL_LEVEL_MAX, f: SKILL_LEVEL_MAX, e: SKILL_LEVEL_MAX };
  recomputeArenaSideStats(state, side);   // bas-stats + ev. loadout (boss-wars = endgame-balans)
  side.hero.hp = side.hero.maxHp;
  side.level = 30;                          // HUD: visa max level (boss wars-stats = lvl-30-maxat)
  side.ultEnergy = side.ultEnergy || 0;
}
function createSandboxState(heroId) {
  const state = createBossWarsState(1);   // ger side-/hjälte-setup (lvl 30, maxade skills)
  state.mode = 'sandbox';
  state.sandbox = true;
  state.bossActivated = true;   // hjälte-combat aktiv direkt (ingen gå-till-boss-rum-fas)
  state.gateClosed = false;
  // Nolla boss-wars-mekanik-arrayer så inget bossbeteende kör i sandbox-ticken (men BEHÅLL bossen).
  state.bossWarsMinions = []; state.boss2Ads = []; state.boss4Minions = [];
  state.boss4Bags = []; state.boss4Pools = []; state.bossProjectiles = []; state.bossPools = [];
  // Solo: döda side 2 & 3 så ev. loopar hoppar dem (sandboxen tickar bara side 1).
  for (const idx of [2, 3]) if (state.sides[idx]) state.sides[idx].hero.dead = true;
  // Mål i sides[1].monsters (delad ref → hjältens AA/skills riktar mot dem). Layout per user-bild:
  // BOSS ensam i mitten (boss-wars-boss-modell) + 2 monster bredvid varandra. Alla STÅR STILLA.
  const cx = BOSSWARS_CX, cz = BOSSWARS_CZ;
  state.sides[1].monsters = [];
  state.sides[2].monsters = state.sides[1].monsters;
  state.sides[3].monsters = state.sides[1].monsters;
  const boss = state.boss;   // skapad av createBossWarsState — återanvänds som center-dummy
  if (boss) {
    boss.x = cx; boss.z = cz; boss._ax = cx; boss._az = cz;
    boss.isSandboxDummy = true;   // odödlig + ankrad i sandbox-ticken (behåller isBossWarsBoss → boss-modell + DR)
    boss.activeCast = null; boss.bossActivated = true;
    state.sides[1].monsters.push(boss);
  }
  // Utspridda, ej staplade under boss-dummyn (user 2026-06-23): boss i mitten, två monster
  // tydligt separerade till höger (framför hjälten som spawnar till vänster). Alla står stilla.
  const mon1 = sandboxMakeDummy(state, cx + 10, cz - 8);
  const mon2 = sandboxMakeDummy(state, cx + 10, cz + 8);
  state.sandboxDummies = [boss, mon1, mon2].filter(Boolean);
  state.sides[1].monsters.push(mon1, mon2);
  sandboxSetupHero(state, heroId);
  return state;
}
// Byt hjälte på plats (behåll position) — utan att lämna sandboxen.
function sandboxSwapHero(state, heroId) {
  if (!state || !state.sandbox) return;
  const x = state.sides[1].hero.x, z = state.sides[1].hero.z;
  sandboxSetupHero(state, heroId);
  state.sides[1].hero.x = x; state.sides[1].hero.z = z;   // stanna där man stod
}
function tickSandbox(state, dt) {
  const s = state.sides[1];
  if (!s) return;
  s._bwGateClosed = false;
  // 1) Rörelse (joystick som boss wars).
  if (!s.hero.dead) {
    const inp = state.lastInputs && state.lastInputs[1];
    const j = (inp && inp.j) || { x: 0, z: 0 };
    heroAutoMove(s, j, dt);
  }
  // 2) Hjälte-combat — EXAKT boss-wars hjälte-sekvensen (side 1, opp=null → inga fiender slår
  // tillbaka). Skill-FUNKTIONERNA är delade med live → auto-synkat; bara anrops-listan dupliceras.
  // (Boss-side-funktionerna nedanför i tickBossWars körs INTE här — ingen boss i sandbox.)
  updateSkillCooldowns(s, dt);
  if (!s.hero.dead) updateHeroAttack(state, s, null, dt);
  updateProjectiles(state, s, null, dt);
  updateFireballs(state, s, null, dt);
  updateBlackHoles(state, s, null, dt);
  updateVineTraps(state, s, null, dt);
  updateHammers(state, s, null, dt);
  updateIronWill(state, s, null, dt);
  updateAragurnWhirlwind(state, s, null, dt);
  updateAragurnLeap(state, s, null, dt);
  updateAragurnShoutHeal(s, dt);
  updateSoulDrain(state, s, null, dt);
  tickLegolusInvis(s, dt);
  tickThornPools(state, s, dt);
  tickKostefoSkills(state, s, null, dt);
  tickGimluTauntLvl5(state, s, null, dt);
  flushIronWillReflectLvl5(state, s, null);
  tickAragurnBannersLvl5(s, dt);
  updateNovaEffects(state, s, null, dt);
  updateActiveBuffs(s, dt);
  if (s.laserBeam) tickMagikerLaserServer(state, s, dt);
  if ((s.rageRemaining || 0) > 0) tickGimluRageServer(state, s, dt);
  if ((s.berserkRemaining || 0) > 0) { if (s.hero.dead) s.berserkRemaining = 0; else s.berserkRemaining = Math.max(0, s.berserkRemaining - dt); }
  if (!s.hero.dead) gainUltEnergy(s, ULT_GAIN_PASSIVE * dt);
  if ((s._ultLockoutTime || 0) > 0) s._ultLockoutTime = Math.max(0, s._ultLockoutTime - dt);
  if ((s.nyroBuffRemaining || 0) > 0) s.nyroBuffRemaining = Math.max(0, s.nyroBuffRemaining - dt);
  if ((s.windPuffMsRem || 0) > 0) s.windPuffMsRem = Math.max(0, s.windPuffMsRem - dt);
  if ((s.kryxHammerMsRem || 0) > 0) s.kryxHammerMsRem = Math.max(0, s.kryxHammerMsRem - dt);
  tickZheyna(state, s, dt); tickXina(state, s, dt);
  if ((s.hero.frozenTime || 0) > 0) s.hero.frozenTime = Math.max(0, s.hero.frozenTime - dt);
  if ((s.hero.tauntedTime || 0) > 0) s.hero.tauntedTime = Math.max(0, s.hero.tauntedTime - dt);
  if ((s.phoenixImmuneRemaining || 0) > 0) s.phoenixImmuneRemaining = Math.max(0, s.phoenixImmuneRemaining - dt);
  if ((s.hero.dotRemaining || 0) > 0) { s.hero.dotRemaining = Math.max(0, s.hero.dotRemaining - dt); damageHero(s, (s.hero.dotPerSec || 0) * dt); }
  if ((s.hero.poisonRemaining || 0) > 0) s.hero.poisonRemaining = Math.max(0, s.hero.poisonRemaining - dt);
  if ((s.heroSlowTime || 0) > 0) { s.heroSlowTime = Math.max(0, s.heroSlowTime - dt); if (s.heroSlowTime <= 0) { s.heroSlowTime = 0; s.heroSlowMul = 1; } }
  tickKryxTimers(s, dt);
  if ((s.iceBlockRemaining || 0) > 0) s.iceBlockRemaining = Math.max(0, s.iceBlockRemaining - dt);
  updateMonsterProjectiles(state, s, dt);
  // 3) Dummies: odödliga (dör/despawnar aldrig) + regen till full efter REGEN_DELAY utan träff.
  for (const d of state.sandboxDummies) {
    d.x = d._ax; d.z = d._az;     // ANKRA → står helt stilla (knockback/pull från skills flyttar dem ej)
    if (d.hp < d._lastHp - 0.01) d._regenTimer = SANDBOX_DUMMY_REGEN_DELAY;  // tog skada → vänta innan regen
    else if (d._regenTimer > 0) { d._regenTimer -= dt; if (d._regenTimer <= 0) d.hp = d.maxHp; }
    if (d.hp < 1) d.hp = 1;       // odödlig
    d._lastHp = d.hp;
    // Z1: låt Frost Nova-frysen hålla sin tid (1.5s) så indikatorn syns — dummies står stilla
    // ändå, så ingen rörelse-jank. DoT/poison nollas fortf. (immortal regen ska ej spamma DoT).
    if ((d.frozenTime || 0) > 0) d.frozenTime = Math.max(0, d.frozenTime - dt);
    d.dotRemaining = 0; d.poisonRemaining = 0;
  }
}
function serializeSandboxState(state) {
  const snap = {
    sb: 1,
    h: serializeArenaHero(state.sides[1], _sandboxHeroBuf),
    dm: state.sandboxDummies.map(d => ({ id: d.id, x: r2(d.x), z: r2(d.z), hp: ri(d.hp), mh: d.maxHp, b: d.isBossWarsBoss ? 1 : 0, fz: flag((d.frozenTime || 0) > 0) })),   // Z1: fz = frusen (is-indikator)
    // Hero skill-entities under side "1" (same per-side-keyed shape as Arena/Boss Wars) so the
    // shared client renderer shows black holes/fire waves/novas/vine traps/etc. in sandbox too.
    bh: {}, fw: {}, nv: {}, ab: {}, kg: {}, ks: {}, vt: {}, tp: {}, hm: {}, iwe: {}, kCln: {},
  };
  writeSkillEntitiesInto(state.sides[1], snap, 1);
  return snap;
}
const _sandboxHeroBuf = _makeHeroSnapBuf();
// ===== BOSS SKILL DAMAGE-PRIMITIVER (slice 2b) =====
// Boss-skills träffar ALLA 3 co-op-hjältar inom AoE. Port av main.js applyBoss*-funktioner;
// mesh-refs borttagna (boss = state.boss x/z), isHeroWalkable → isBossWarsWalkable.
// ADDITIVT — anropas av cast-machinen (slice 2b-ii).
function bossWarsTargets(state) {
  return [state.sides[1], state.sides[2], state.sides[3]].filter(s => s);
}
function bossEffectiveDamage(m) {
  // boss4DmgBuff: +20% utgående skada medan Demon Prince (tier 4) står i en giftpool.
  return (m && m.damage ? m.damage : 0) * ((m && m.damageBuffMul) || 1) * ((m && m.boss4DmgBuff) || 1);
}
function applyBossCircleDmg(state, m, cast) {
  const s = cast.skill;
  const dmg = bossEffectiveDamage(m) * (s.dmgMul || 1);
  for (const tgt of bossWarsTargets(state)) {
    if (tgt.hero.dead) continue;
    if (Math.hypot(tgt.hero.x - cast.targetX, tgt.hero.z - cast.targetZ) < s.radius) {
      damageHero(tgt, dmg);
      if (s.slow) {
        tgt.heroSlowMul = Math.min(tgt.heroSlowMul != null ? tgt.heroSlowMul : 1, s.slow.mul);
        tgt.heroSlowTime = Math.max(tgt.heroSlowTime || 0, s.slow.dur);
      }
    }
  }
}
function applyBossConeDmgRaw(state, m, cast, length, halfAngle, dmgMul) {
  const dmg = bossEffectiveDamage(m) * (dmgMul || 1);
  for (const tgt of bossWarsTargets(state)) {
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
function applyBossConeDmg(state, m, cast) {
  applyBossConeDmgRaw(state, m, cast, cast.skill.length, cast.skill.halfAngle, cast.skill.dmgMul);
}
function applyBossLineDmg(state, m, cast, cx, cz) {
  const s = cast.skill;
  const dmg = bossEffectiveDamage(m) * (s.dmgMul || 1);
  const e = cast.extras;
  for (const tgt of bossWarsTargets(state)) {
    if (tgt.hero.dead) continue;
    const key = 'hero' + tgt.idx;
    if (e.damaged.has(key)) continue;
    const d = Math.hypot(tgt.hero.x - cx, tgt.hero.z - cz);
    if (d < (s.width || 2) * 0.6) { damageHero(tgt, dmg); e.damaged.add(key); }
  }
}
function applyBossBeamDmg(state, m, cast, length, width, dmg) {
  const realDmg = bossEffectiveDamage(m) * dmg;
  for (const tgt of bossWarsTargets(state)) {
    if (tgt.hero.dead) continue;
    const dx = tgt.hero.x - cast.originX, dz = tgt.hero.z - cast.originZ;
    const along = dx * cast.dirX + dz * cast.dirZ;
    if (along > 0 && along < length) {
      const perp = Math.abs(dx * (-cast.dirZ) + dz * cast.dirX);
      if (perp < width) damageHero(tgt, realDmg);
    }
  }
}
function applyBossKnockback(state, x, z, radius, force) {
  for (const tgt of bossWarsTargets(state)) {
    if (tgt.hero.dead) continue;
    const dx = tgt.hero.x - x, dz = tgt.hero.z - z;
    const d = Math.hypot(dx, dz);
    if (d >= radius || d < 0.01) continue;
    const nx = tgt.hero.x + (dx / d) * force, nz = tgt.hero.z + (dz / d) * force;
    if (isBossWarsWalkable(nx, nz, state.gateClosed)) { tgt.hero.x = nx; tgt.hero.z = nz; }
  }
}

// Boss-rummet (cirkel) — aktiverings-check (alla levande heroes inne → boss vaknar).
function isInsideBossRoom(x, z) {
  const dx = x - BOSSWARS_CX, dz = z - BOSSWARS_CZ;
  const r = BOSSWARS_RADIUS - 0.5;
  return (dx * dx + dz * dz) < r * r;
}
// Aktivera bossen + stäng korridor-gaten när ALLA levande heroes är inne i boss-rummet.
function maybeActivateBossWars(state) {
  if (state.bossActivated) return;
  let anyAlive = false, allInside = true;
  for (const idx of [1, 2, 3]) {
    const s = state.sides[idx];
    if (!s || s.hero.dead) continue;
    anyAlive = true;
    if (!isInsideBossRoom(s.hero.x, s.hero.z)) { allInside = false; break; }
  }
  if (anyAlive && allInside) { state.bossActivated = true; state.gateClosed = true; }
}
// Boss-AA-projektil mot specifik hjälte (homing via bossTargetIdx i updateMonsterProjectiles).
// Ligger i sides[1].monsterProjectiles → serialiseras i mr[1], renderas av klient (projKind-mesh).
function spawnBossAaProjectile(state, boss, targetIdx) {
  const travel = boss.projTime || 0.8;
  state.sides[1].monsterProjectiles.push({
    id: state.nextEntityId++,
    x: boss.x, y: MONSTER_PROJ_Y, z: boss.z,
    srcX: boss.x, srcZ: boss.z,
    damage: boss.damage || 40,
    timer: travel, totalTime: travel,
    kind: boss.projKind || 'magic',
    isBoss: true,
    bossTargetIdx: targetIdx,
  });
}
// ===== BOSS CAST-STATEMASKIN (slice 2b-ii) =====
// Port av main.js tickBossSkills/startBossCast/tickBossCast/bossExecuteSkill/tickBossExecute.
// Distinkta namn (engine har tickBossSkillsServer för classic). boss=state.boss (x/z, ingen mesh);
// visual-spawns skippade (klienten ritar telegraph från serialiserad b.c).
function nearestLiveHero(state, x, z) {
  let best = null, bestSq = Infinity;
  for (const idx of [1, 2, 3]) {
    const s = state.sides[idx];
    if (!s || s.hero.dead) continue;
    const dx = s.hero.x - x, dz = s.hero.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestSq) { bestSq = d2; best = s; }
  }
  return best;
}
// ===== BOSS PROJEKTILER + POOLS (slice 2c) =====
// Port av main.js spawnBossProjectile/tickBossProjectiles/spawnPoolDot/tickBossPools, mesh-refs
// borttagna. Ligger på state (boss-global). Serialiseras (bp/bpl) så klienterna ser dem.
function spawnBossWarsProjectile(state, boss, x, z, dx, dz, skill) {
  state.bossProjectiles.push({
    id: state.nextEntityId++, x, z, dx, dz,
    speed: skill.speed || 14,
    damage: bossEffectiveDamage(boss) * (skill.dmgMul || 1),
    radius: skill.radius || 0.8, range: skill.range || 14, traveled: 0,
  });
}
function tickBossWarsProjectiles(state, dt) {
  const arr = state.bossProjectiles;
  if (!arr) return;
  for (let i = arr.length - 1; i >= 0; i--) {
    const p = arr[i];
    const step = p.speed * dt;
    p.x += p.dx * step; p.z += p.dz * step; p.traveled += step;
    let hit = false;
    for (const tgt of bossWarsTargets(state)) {
      if (tgt.hero.dead) continue;
      if (Math.hypot(tgt.hero.x - p.x, tgt.hero.z - p.z) < p.radius + 0.45) { damageHero(tgt, p.damage); hit = true; break; }
    }
    if (hit || p.traveled > p.range) arr.splice(i, 1);
  }
}
function spawnBossWarsPool(state, boss, x, z, radius, duration, dpsMul, slow) {
  state.bossPools.push({
    id: state.nextEntityId++, x, z, radius,
    life: duration, maxLife: duration,
    dps: bossEffectiveDamage(boss) * dpsMul, tickAccum: 0, slow: slow || null,
  });
}
function tickBossWarsPools(state, dt) {
  const arr = state.bossPools;
  if (!arr) return;
  for (let i = arr.length - 1; i >= 0; i--) {
    const p = arr[i];
    p.life -= dt; p.tickAccum += dt;
    if (p.tickAccum >= 0.5) {
      p.tickAccum -= 0.5;
      for (const tgt of bossWarsTargets(state)) {
        if (tgt.hero.dead) continue;
        if (Math.hypot(tgt.hero.x - p.x, tgt.hero.z - p.z) < p.radius) {
          damageHero(tgt, p.dps * 0.5);
          if (p.slow) {
            tgt.heroSlowMul = Math.min(tgt.heroSlowMul != null ? tgt.heroSlowMul : 1, p.slow.mul);
            tgt.heroSlowTime = Math.max(tgt.heroSlowTime || 0, p.slow.dur);
          }
        }
      }
    }
    if (p.life <= 0) arr.splice(i, 1);
  }
}
function cancelBossWarsCast(state, boss) { boss.activeCast = null; }
function finishBossWarsCast(state, boss) {
  const cast = boss.activeCast;
  if (!cast) return;
  boss.skillCds[cast.skillIdx] = cast.skill.cd;
  boss.activeCast = null;
}
function startBossWarsCast(state, boss, skill, skillIdx) {
  const target = nearestLiveHero(state, boss.x, boss.z);
  const hero = target ? target.hero : null;
  const bx = boss.x, bz = boss.z;
  let dirX = 0, dirZ = 1;
  if (hero) { const dx = hero.x - bx, dz = hero.z - bz; const dl = Math.hypot(dx, dz) || 1; dirX = dx / dl; dirZ = dz / dl; }
  boss.activeCast = {
    skill, skillIdx, phase: 'telegraph', timer: skill.telegraph,
    dirX, dirZ, originX: bx, originZ: bz,
    targetX: (skill.targetHero && hero) ? hero.x : (skill.originSelf ? bx : bx + dirX * (skill.length || 5) / 2),
    targetZ: (skill.targetHero && hero) ? hero.z : (skill.originSelf ? bz : bz + dirZ * (skill.length || 5) / 2),
    extras: null,
  };
  boss.aaCount = (boss.aaCount || 0) + 1;   // delta-detect → klient triggar cast-anim + FX
}
function bossWarsExecuteSkill(state, boss, cast) {
  const s = cast.skill;
  cast.phase = 'execute';
  boss.aaCount = (boss.aaCount || 0) + 1;   // re-trigga anim vid execute (skadan landar)
  if (s.kind === 'groundCircle') {
    cast.timer = 0.45; cast.extras = { done: true };
    applyBossCircleDmg(state, boss, cast);
    if (s.knockback) applyBossKnockback(state, cast.targetX, cast.targetZ, s.radius, s.knockback);
    // leaveBurn: spawna en brand-DoT-pool vid impact-positionen (server-parity med solo-vägen).
    // Demon Prince infernoStrike (tier 4) använder detta — pool radius 70% av skill-radius, 3s, 30% dpsMul.
    if (s.leaveBurn) spawnBossWarsPool(state, boss, cast.targetX, cast.targetZ, (s.radius || 3) * 0.7, 3.0, 0.3, null);
    return;
  }
  if (s.kind === 'cone') {
    cast.timer = 0.4; cast.extras = { done: true };
    applyBossConeDmg(state, boss, cast);
    return;
  }
  if (s.kind === 'lineDash') {
    cast.timer = s.execTime || 0.5;
    cast.extras = { done: false, dashStartX: cast.originX, dashStartZ: cast.originZ,
      dashEndX: cast.originX + cast.dirX * s.length, dashEndZ: cast.originZ + cast.dirZ * s.length, damaged: new Set() };
    return;
  }
  if (s.kind === 'multiCircle') {
    cast.timer = (s.count || 5) * (s.spawnInterval || 0.6) + 0.5;
    cast.extras = { done: false, spawned: 0, spawnTimer: 0, circles: [] };
    return;
  }
  if (s.kind === 'sweepBeam') {
    cast.timer = s.sweepDuration;
    const base = Math.atan2(cast.dirX, cast.dirZ);
    cast.extras = { done: false, startAng: base - s.halfAngle, endAng: base + s.halfAngle, damageTimer: 0 };
    return;
  }
  if (s.kind === 'sustainedCone') {
    cast.timer = s.sustainDuration; cast.extras = { done: false, damageTimer: 0 };
    return;
  }
  if (s.kind === 'projectile') {
    spawnBossWarsProjectile(state, boss, cast.originX, cast.originZ, cast.dirX, cast.dirZ, s);
    cast.timer = 0.05; cast.extras = { done: true };
    return;
  }
  if (s.kind === 'projectileMulti') {
    const count = s.count || 3, spread = s.spreadAngle || Math.PI / 6;
    const baseAng = Math.atan2(cast.dirX, cast.dirZ);
    for (let i = 0; i < count; i++) {
      const off = count === 1 ? 0 : (-spread / 2 + spread * i / (count - 1));
      const ang = baseAng + off;
      spawnBossWarsProjectile(state, boss, cast.originX, cast.originZ, Math.sin(ang), Math.cos(ang), s);
    }
    cast.timer = 0.05; cast.extras = { done: true };
    return;
  }
  if (s.kind === 'poolDot') {
    spawnBossWarsPool(state, boss, cast.targetX, cast.targetZ, s.radius, s.duration, s.dpsMul, s.slow);
    cast.timer = 0.3; cast.extras = { done: true };
    return;
  }
  // Okänd kind → no-op done (boss fastnar ej).
  cast.timer = 0.1; cast.extras = { done: true };
}
function tickBossWarsExecute(state, boss, cast, dt) {
  const s = cast.skill, e = cast.extras;
  if (s.kind === 'lineDash') {
    const u = Math.min(1, 1 - cast.timer / (s.execTime || 0.5));
    const cx = e.dashStartX + (e.dashEndX - e.dashStartX) * u;
    const cz = e.dashStartZ + (e.dashEndZ - e.dashStartZ) * u;
    boss.x = cx; boss.z = cz;   // bossen dashar (m.mesh.position → boss.x/z)
    applyBossLineDmg(state, boss, cast, cx, cz);
    if (cast.timer <= 0) { boss.x = e.dashEndX; boss.z = e.dashEndZ; e.done = true; }   // snäpp till slutpos
    return;
  }
  if (s.kind === 'multiCircle') {
    e.spawnTimer -= dt;
    if (e.spawned < (s.count || 5) && e.spawnTimer <= 0) {
      let ox = cast.originX, oz = cast.originZ;
      if (s.targetHero) { const h = nearestLiveHero(state, boss.x, boss.z); if (h) { ox = h.hero.x; oz = h.hero.z; } }
      const cx = ox + (Math.random() - 0.5) * 2 * (s.spread || 6);
      const cz = oz + (Math.random() - 0.5) * 2 * (s.spread || 6);
      e.circles.push({ skill: { kind: 'groundCircle', radius: s.radius, dmgMul: s.dmgMul }, targetX: cx, targetZ: cz, timer: 0.7, phase: 'telegraph' });
      e.spawnTimer = (s.spawnInterval || 0.6); e.spawned++;
    }
    for (let i = e.circles.length - 1; i >= 0; i--) {
      const sub = e.circles[i];
      sub.timer -= dt;
      if (sub.timer <= 0 && sub.phase === 'telegraph') { sub.phase = 'done'; applyBossCircleDmg(state, boss, sub); }
      if (sub.phase === 'done' && sub.timer < -0.5) e.circles.splice(i, 1);
    }
    if (e.spawned >= (s.count || 5) && e.circles.length === 0) e.done = true;
    return;
  }
  if (s.kind === 'sweepBeam') {
    const u = Math.min(1, 1 - cast.timer / s.sweepDuration);
    const curAng = e.startAng + (e.endAng - e.startAng) * u;
    cast.dirX = Math.sin(curAng); cast.dirZ = Math.cos(curAng);
    e.damageTimer -= dt;
    if (e.damageTimer <= 0) { e.damageTimer = 0.2; applyBossBeamDmg(state, boss, cast, s.length, 1.4, s.dpsMul * 0.2); }
    if (cast.timer <= 0) e.done = true;
    return;
  }
  if (s.kind === 'sustainedCone') {
    e.damageTimer -= dt;
    if (e.damageTimer <= 0) { e.damageTimer = 0.3; applyBossConeDmgRaw(state, boss, cast, s.length, s.halfAngle, s.dpsMul * 0.3); }
    if (cast.timer <= 0) e.done = true;
    return;
  }
}
function tickBossWarsCast(state, boss, dt) {
  const cast = boss.activeCast;
  cast.timer -= dt;
  if (cast.phase === 'telegraph') {
    if (cast.timer <= 0) bossWarsExecuteSkill(state, boss, cast);
    return;
  }
  if (cast.phase === 'execute') {
    tickBossWarsExecute(state, boss, cast, dt);
    if (cast.timer <= 0 && (!cast.extras || cast.extras.done)) finishBossWarsCast(state, boss);
  }
}
function tickBossWarsSkills(state, boss, dt) {
  if (boss.hp <= 0) { if (boss.activeCast) cancelBossWarsCast(state, boss); return; }
  if (boss.skillCds) for (let i = 0; i < boss.skillCds.length; i++) boss.skillCds[i] = Math.max(0, boss.skillCds[i] - dt);
  if (boss.activeCast) { tickBossWarsCast(state, boss, dt); return; }
  // Casta bara om någon levande hjälte är inom 18m.
  let best = Infinity;
  for (const idx of [1, 2, 3]) {
    const s = state.sides[idx];
    if (!s || s.hero.dead) continue;
    const dd = Math.hypot(s.hero.x - boss.x, s.hero.z - boss.z);
    if (dd < best) best = dd;
  }
  if (best > 18 || !boss.bossSkills || !boss.skillCds) return;
  const ready = [];
  for (let i = 0; i < boss.skillCds.length; i++) if (boss.skillCds[i] <= 0) ready.push(i);
  if (ready.length === 0) return;
  const pick = ready[(Math.random() * ready.length) | 0];
  startBossWarsCast(state, boss, boss.bossSkills[pick], pick);
}

// Boss-skade-modifierare (slice 3a): fas-flyup-IMMUNITET (decision 117) + boss-DR (decision 110).
// Returnerar effektiv skada (0 = immun). Anropas i ALLA boss-skadevägar; no-op för icke-boss-monster.
function bossWarsDmgMod(m, dmg) {
  if (!m || !m.isBossWarsBoss) return dmg;
  if (m.warlord && m.warlord.engaged) return 0;          // immun hela symbol-fasen (boss 3): full reveal → pulser klart
  if (m.dragon && m.dragon.active) return 0;             // immun under boss 5-mekanik (decision 135)
  if ((m.phaseTransitionRemaining || 0) > 0) return 0;   // immun under fas-övergång
  // DR = base + step per intervall (decision 110) över aktiv tid, cap. Annars stallar långa fights.
  const steps = Math.floor((m.activeTime || 0) / (m.dmgReductionStepIntervalSec || 120));
  // phase2DrBonus: +20pp DR additivt i fas 2 (sätts vid fas-övergång). Cap 70% totalt.
  const dr = Math.min(m.dmgReductionCap || 0.70, (m.dmgReductionBase || 0) + steps * (m.dmgReductionStep || 0.05) + (m.phase2DrBonus || 0));
  // Cap: tier-graderat per-hit-tak (T1 6% → T5 4%) — hindrar burst-one-shots.
  // Taket appliceras på RÅ skada FÖRE DR (user 2026-06-08): annars maskerar taket
  // DR för %maxHP-skills (rå×(1−DR) > tak → min väljer taket → DR försvinner). Med
  // taket först reducerar DR ALLTID, även %maxHP-skills; one-shot-skyddet kvarstår
  // (slutlig ≤ tak). Måste matcha solo-vägen i main.js damageMonster.
  const cap = BOSSWARS_TIER_MAX_HIT_FRAC[m.bossTier] || BOSSWARS_MAX_HIT_FRAC;
  return Math.min(dmg, m.maxHp * cap) * (1 - dr);
}
// Fas-övergång (slice 3a): vid phaseThreshold-HP → bossPhase 2. Stun+push heroes, immun flyup 2.5s,
// cleanse boss-debuffs (behåll positiv buff), swap till phase2-skills vid landning. Port av main.js.
function triggerBossWarsPhaseTransition(state, boss) {
  if (!boss || boss.bossPhase !== 1 || !boss.phase2Skills) return;
  boss.bossPhase = 2;
  // Fas-2-balans (användarbeslut 2026-06-05): klamp HP UPP till tröskeln så bossen aldrig
  // kan hamna UNDER 50%/30% medan fasen entras + +20pp DR permanent i fas 2.
  boss.hp = Math.max(boss.hp, boss.maxHp * (boss.phaseThreshold || 0.5));
  boss.phase2DrBonus = 0.20;
  boss.activeCast = null;   // avbryt pågående cast
  for (const idx of [1, 2, 3]) {
    const s = state.sides[idx];
    if (!s || s.hero.dead) continue;
    s.hero.frozenTime = Math.max(s.hero.frozenTime || 0, 2.0);   // 2s stun (var 3s — kändes som handlingsförlust)
    const dx = s.hero.x - boss.x, dz = s.hero.z - boss.z;
    const d = Math.hypot(dx, dz) || 1;
    const nx = s.hero.x + (dx / d) * 6, nz = s.hero.z + (dz / d) * 6;   // push 6m
    if (isBossWarsWalkable(nx, nz, state.gateClosed)) { s.hero.x = nx; s.hero.z = nz; }
  }
  boss.phaseTransitionRemaining = 2.5; boss.phaseTransitionTotal = 2.5;
  // CLEANSE negativa debuffs (positiv damageBuffMul lämnas orörd).
  boss.dotRemaining = 0; boss.dotPerSec = 0;
  boss.poisonRemaining = 0; boss.poisonStacks = 0;
  boss.frozenTime = 0; boss.slowTime = 0; boss.slowMul = 1.0; boss.nyroMarked = 0;
  boss._pendingPhase2 = true;
  // Decision 118 "Val B": rensa kvarvarande P1-minions/ads + nollställ spawn-schemat
  // så heroes får fresh grace (10s) efter P2 startar. Speglar klientens transition.
  if (state.bossWarsMinions) for (let i = state.bossWarsMinions.length - 1; i >= 0; i--) despawnBossWarsMinionEngine(state, state.bossWarsMinions[i]);
  if (state.boss2Ads) for (let i = state.boss2Ads.length - 1; i >= 0; i--) despawnBoss2AdEngine(state, state.boss2Ads[i]);
  if (state.bossWarsWave) { state.bossWarsWave.active = false; state.bossWarsWave.countdown = 0; }
  if (state.boss2AdWaveSpawn) { state.boss2AdWaveSpawn.active = false; state.boss2AdWaveSpawn.countdown = 0; }
  if (state.boss2AdWaveTimer) { state.boss2AdWaveTimer.active = false; state.boss2AdWaveTimer.remaining = 0; }
  if (state.boss2KillCooldown) state.boss2KillCooldown.remaining = 0;   // S2: annars carry-over P1→P2 wipe-risk
}

// Boss-AI slice 2a-3a: fas-övergång → skill-cast (pausar AI) → annars rörelse + AA. Tickas 1× i tickBossWars.
function tickBossWarsBoss(state, dt) {
  const boss = state.boss;
  if (!boss || boss.hp <= 0 || !state.bossActivated) return;
  boss.activeTime = (boss.activeTime || 0) + dt;   // tidsbaserad DR-step (decision 110, bossWarsDmgMod)
  // Absorption-buff timeout (minion-absorption +20%/5s, decision 116) — bossEffectiveDamage läser damageBuffMul.
  if ((boss.damageBuffRemaining || 0) > 0) {
    boss.damageBuffRemaining -= dt;
    if (boss.damageBuffRemaining <= 0) { boss.damageBuffRemaining = 0; boss.damageBuffMul = 1; }
  }
  // Boss 3 (Warlord): symbol-mekanik äger sin egen fas-2 (vid 50%-challengen). Returnerar true
  // = boss immun + AI pausad (reveal/challenge/puls). Gate:ar den generiska fly-up-övergången.
  if (boss.dragon) {
    if (tickDragonMechanics(state, dt, boss)) return;   // boss 5: breakpoint-mekaniker (gate:ar generisk fas)
  } else if (boss.warlord) {
    if (tickWarlordChallenge(state, dt, boss)) return;
  } else if (boss.bossPhase === 1 && boss.phase2Skills && boss.hp <= boss.maxHp * (boss.phaseThreshold || 0.5)) {
    // Fas-övergång: trigga vid phaseThreshold; under flyup (2.5s) ingen AI (boss immun via bossWarsDmgMod).
    triggerBossWarsPhaseTransition(state, boss);
  }
  if ((boss.phaseTransitionRemaining || 0) > 0) {
    boss.phaseTransitionRemaining = Math.max(0, boss.phaseTransitionRemaining - dt);
    if (boss.phaseTransitionRemaining <= 0 && boss._pendingPhase2) {
      boss._pendingPhase2 = false;
      boss.bossSkills = boss.phase2Skills;
      boss.skillCds = boss.phase2Skills.map(s => s.cd * 0.4);
      boss.damage = Math.round(boss.damage * 1.25);   // phase-2 dmg-boost (raid-känsla)
    }
    return;
  }
  // Boss-skills: under cast pausar normal rörelse/AA (lineDash flyttar bossen själv).
  tickBossWarsSkills(state, boss, dt);
  if (boss.activeCast) return;
  let target = null, bestSq = Infinity;
  for (const idx of [1, 2, 3]) {
    const s = state.sides[idx];
    if (!s || s.hero.dead) continue;
    const dx = s.hero.x - boss.x, dz = s.hero.z - boss.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestSq) { bestSq = d2; target = s; }
  }
  if (!target) return;
  const dist = Math.sqrt(bestSq) || 0.0001;
  const atkRange = boss.attackRange || 7.5;
  // Rörelse: jaga om utanför ~90% av attack-range; annars stå och skjut.
  if (dist > atkRange * 0.9) {
    const ux = (target.hero.x - boss.x) / dist, uz = (target.hero.z - boss.z) / dist;
    const nx = boss.x + ux * boss.speed * dt, nz = boss.z + uz * boss.speed * dt;
    if (isBossWarsWalkable(nx, nz, state.gateClosed)) { boss.x = nx; boss.z = nz; }
  }
  // AA (range): homing-projektil mot target-hjälten.
  boss.atkCd = Math.max(0, (boss.atkCd || 0) - dt);
  if (dist < atkRange && boss.atkCd <= 0) {
    boss.atkCd = boss.attackInterval || 1.4;
    boss.aaCount = (boss.aaCount || 0) + 1;   // delta-detect → klient triggar attack-anim + charge-FX
    spawnBossAaProjectile(state, boss, target.idx);
  }
}

// ===== BOSS 1 MINION-VÅGOR (slice 3b-i, decisions 116-117) — bara tier 1 =====
// Port av main.js. Minions = entiteter i sides[1].monsters (DELAD ref → alla 3 hjältar AA/skill:ar dem)
// + state.bossWarsMinions (minion-AI). Rör sig mot bossen → absorberas (heal+buff+AoE). Aura skadar
// heroes som står nära. Killable. Inga mesh (klient renderar från serialiserad `bm`).
const BOSSWARS_MINION_HP_P1 = 150, BOSSWARS_MINION_HP_P2 = 300, BOSSWARS_MINION_SPEED = 1.5;
const BOSSWARS_MINION_ABSORB_DIST = 1.5;
const BOSSWARS_MINION_ABSORB_AOE_PCT_P1 = 0.30, BOSSWARS_MINION_ABSORB_AOE_PCT_P2 = 0.50;
// Aura-radie 9.0 (var 13.5 ≈ halva arenan = ingen positionell motspel, "städa eller dö"). 9.0 ger
// kite-utrymme: döda minionen snabbt, kliv sen ut ur auran (balans + playtest).
const BOSSWARS_MINION_AURA_RADIUS = 9.0, BOSSWARS_MINION_AURA_TICK_INTERVAL = 0.5;
const BOSSWARS_MINION_AURA_ESCALATION_PER_TICK = 1.5, BOSSWARS_MINION_AURA_RESET_TIME = 7.0, BOSSWARS_MINION_AURA_START_PCT = 1;
// Stack-tak (agent-fynd S5): utan tak eskalerar aura-skadan obegränsat → exponentiell wipe. Cap = ~13%/tick max.
const BOSSWARS_MINION_AURA_MAX_STACKS = 8;
const BOSSWARS_MINION_WAVE_FIRST_DELAY = 5.0, BOSSWARS_MINION_WAVE_INTERVAL = 20.0;
const BOSSWARS_MINION_WAVE_SIZE_P1 = 3, BOSSWARS_MINION_WAVE_SIZE_P2 = 6, BOSSWARS_MINION_WAVE_SPEED_MUL_P2 = 1.0;
function bossWarsMinionsActive(state) { return state.tier === 1; }   // mirror bossWarsMinionsEnabled (bara boss 1)
function healBossWarsBoss(boss, amount) { if (boss) boss.hp = Math.min(boss.maxHp, boss.hp + amount); }
function spawnBossWarsMinionEngine(state, ang, speedMul, hp) {
  const r = BOSSWARS_RADIUS - 2;
  const m = {
    id: state.nextEntityId++, hp, maxHp: hp,
    x: BOSSWARS_CX + Math.cos(ang) * r, z: BOSSWARS_CZ + Math.sin(ang) * r,
    moveSpeed: BOSSWARS_MINION_SPEED * (speedMul || 1),
    isMinion: true, isMonster: false, isBoss: false, isBossWarsBoss: false,
    attackType: 'none', damage: 0,
  };
  state.sides[1].monsters.push(m);   // delad ref → alla 3 hjältars AA/skill träffar
  state.bossWarsMinions.push(m);
  return m;
}
function spawnBossWarsMinionWaveEngine(state, size, speedMul, hp) {
  for (let i = 0; i < size; i++) spawnBossWarsMinionEngine(state, (i / size) * Math.PI * 2, speedMul, hp);
}
function tickBossWarsMinionWavesEngine(state, dt) {
  if (!bossWarsMinionsActive(state) || !state.bossActivated) return;
  const boss = state.boss;
  if (!boss || boss.hp <= 0) { state.bossWarsWave.active = false; return; }
  if ((boss.phaseTransitionRemaining || 0) > 0) return;   // pausa under fas-flyup
  if (!state.bossWarsWave.active) { state.bossWarsWave.active = true; state.bossWarsWave.countdown = BOSSWARS_MINION_WAVE_FIRST_DELAY; }
  state.bossWarsWave.countdown -= dt;
  if (state.bossWarsWave.countdown <= 0) {
    const isP2 = boss.bossPhase === 2;
    spawnBossWarsMinionWaveEngine(state,
      isP2 ? BOSSWARS_MINION_WAVE_SIZE_P2 : BOSSWARS_MINION_WAVE_SIZE_P1,
      isP2 ? BOSSWARS_MINION_WAVE_SPEED_MUL_P2 : 1.0,
      isP2 ? BOSSWARS_MINION_HP_P2 : BOSSWARS_MINION_HP_P1);
    state.bossWarsWave.countdown += BOSSWARS_MINION_WAVE_INTERVAL;
  }
}
function despawnBossWarsMinionEngine(state, m) {
  let k = state.bossWarsMinions.indexOf(m);
  if (k >= 0) state.bossWarsMinions.splice(k, 1);
  k = state.sides[1].monsters.indexOf(m);
  if (k >= 0) state.sides[1].monsters.splice(k, 1);
}
function applyMinionAbsorptionEngine(state, boss) {
  if (!boss || boss.hp <= 0) return;
  healBossWarsBoss(boss, boss.maxHp * 0.10);
  // Cap +60% (3 stackar) — annars staplar täta absorptioner (6 minions/våg i P2) obegränsat
  // → boss-dmg 2.2× ostoppbart (server-debug C1).
  boss.damageBuffMul = Math.min(1.0 + 3 * 0.20, (boss.damageBuffMul || 1) + 0.20);
  boss.damageBuffRemaining = 5.0;
  const aoePct = (boss.bossPhase === 2) ? BOSSWARS_MINION_ABSORB_AOE_PCT_P2 : BOSSWARS_MINION_ABSORB_AOE_PCT_P1;
  for (const tgt of bossWarsTargets(state)) {
    if (!tgt || !tgt.hero || tgt.hero.dead) continue;
    damageHero(tgt, tgt.hero.maxHp * aoePct);
  }
}
function updateBossWarsMinionsEngine(state, dt) {
  const arr = state.bossWarsMinions;
  if (!arr || arr.length === 0) return;
  const boss = state.boss;
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    // Hero-kill/DoT (borttagen från monsters) ELLER hp<=0 → despawn (ingen absorption).
    if (m.hp <= 0 || !state.sides[1].monsters.includes(m)) { despawnBossWarsMinionEngine(state, m); continue; }
    if ((m.frozenTime || 0) > 0) continue;
    if (!boss) continue;
    const dx = boss.x - m.x, dz = boss.z - m.z;
    const dist = Math.hypot(dx, dz) || 0.0001;
    if (dist < BOSSWARS_MINION_ABSORB_DIST) {   // nådde bossen → absorption
      applyMinionAbsorptionEngine(state, boss);
      despawnBossWarsMinionEngine(state, m);
      continue;
    }
    const step = m.moveSpeed * dt;
    m.x += (dx / dist) * step; m.z += (dz / dist) * step;
  }
}
function tickBossWarsMinionAuraEngine(state, dt) {
  if (!bossWarsMinionsActive(state)) return;
  const minions = state.bossWarsMinions;
  if (!minions || minions.length === 0) return;
  const r2 = BOSSWARS_MINION_AURA_RADIUS * BOSSWARS_MINION_AURA_RADIUS;
  for (const side of bossWarsTargets(state)) {
    if (!side || !side.hero) continue;
    if (side.auraStacks == null) { side.auraStacks = 0; side.auraTickAccum = 0; side.auraResetTimer = 0; }
    let inAura = false;
    if (!side.hero.dead) {
      const hx = side.hero.x, hz = side.hero.z;
      for (const mm of minions) {
        const dxh = hx - mm.x, dzh = hz - mm.z;
        if (dxh * dxh + dzh * dzh < r2) { inAura = true; break; }
      }
    }
    if (inAura) {
      side.auraResetTimer = 0;
      side.auraTickAccum += dt;
      while (side.auraTickAccum >= BOSSWARS_MINION_AURA_TICK_INTERVAL) {
        side.auraTickAccum -= BOSSWARS_MINION_AURA_TICK_INTERVAL;
        const cappedStacks = Math.min(side.auraStacks, BOSSWARS_MINION_AURA_MAX_STACKS);
        const pct = (BOSSWARS_MINION_AURA_START_PCT + cappedStacks * BOSSWARS_MINION_AURA_ESCALATION_PER_TICK) / 100;
        damageHero(side, side.hero.maxHp * pct);
        side.auraStacks = Math.min(side.auraStacks + 1, BOSSWARS_MINION_AURA_MAX_STACKS);
      }
    } else {
      side.auraResetTimer += dt;
      if (side.auraResetTimer >= BOSSWARS_MINION_AURA_RESET_TIME) { side.auraStacks = 0; side.auraTickAccum = 0; side.auraResetTimer = 0; }
    }
  }
}

// ===== BOSS 2 ADS (slice 3b-ii, decision 118) — bara tier 2 =====
// Separat mekanik: ads JAGAR hjältar + homing-distansattack (stacking-slow vid impact) +
// våg-gemensam dödstimer → explosion + kill-cooldown-WIPE (döda ad medan cooldown löper = laget dör).
// Ad-HP 600 (var 120): dog på en enda crit-AA (~180) → AoE/multi-fokus = oavsiktlig wipe utan
// reaktionsfönster (balansagent). 600 kräver flera träffar → spelaren hinner se "nästan död" + stoppa.
const BOSS2_AD_HP = 600, BOSS2_AD_SPEED = 5.25, BOSS2_AD_DAMAGE = 10;
const BOSS2_AD_RANGE = 8.0, BOSS2_AD_ATK_INTERVAL = 1.5, BOSS2_AD_PROJ_TIME = 0.8;
const BOSS2_AD_LIFETIME = 10, BOSS2_AD_EXPLODE_PCT_P1 = 0.25, BOSS2_AD_EXPLODE_PCT_P2 = 0.50;
// Total-cap på våg-explosion (agent-fynd S1): per-ad-skada × full våg (3×50%=150%) = garanterad wipe utan motspel.
const BOSS2_AD_EXPLODE_CAP_PCT = 0.75;
const BOSS2_AD_KILL_COOLDOWN_P1 = 2.0, BOSS2_AD_KILL_COOLDOWN_P2 = 3.0;
const BOSS2_AD_WAVE_FIRST_DELAY = 10, BOSS2_AD_WAVE_INTERVAL_P1 = 40, BOSS2_AD_WAVE_INTERVAL_P2 = 30;
// Stack-dmg 0.03 (var 0.05): P2 10 stackar gav 50% maxHP/hit medan 65% slowad = dödsspiral för
// low-HP-builds. 0.03 → max 30% maxHP/hit, behåller hotet utan 2-hit-death (balansagent).
const BOSS2_AD_STACK_DMG_PCT = 0.03, BOSS2_AD_STACK_SLOW_PCT = 0.10;
// Golv på rörelse-mult (agent-fynd): utan golv → 10 stacks = 0% rörelse = hard-CC-dödsspiral.
const BOSS2_AD_STACK_SLOW_FLOOR = 0.35;
const BOSS2_AD_STACK_MAX_P1 = 5, BOSS2_AD_STACK_MAX_P2 = 10, BOSS2_AD_STACK_DECAY = 5, BOSS2_AD_WAVE_SIZE = 3;
function boss2AdsActive(state) { return state.tier === 2; }
function spawnBoss2AdEngine(state, ang) {
  const r = BOSSWARS_RADIUS - 2;
  const m = {
    id: state.nextEntityId++, hp: BOSS2_AD_HP, maxHp: BOSS2_AD_HP,
    x: BOSSWARS_CX + Math.cos(ang) * r, z: BOSSWARS_CZ + Math.sin(ang) * r,
    moveSpeed: BOSS2_AD_SPEED, isBoss2Ad: true, isMinion: false, isMonster: false, isBoss: false, isBossWarsBoss: false,
    attackType: 'range', damage: BOSS2_AD_DAMAGE, attackRange: BOSS2_AD_RANGE,
    attackInterval: BOSS2_AD_ATK_INTERVAL, projTime: BOSS2_AD_PROJ_TIME, atkCd: 0, _bwState: state,
  };
  state.sides[1].monsters.push(m);   // delad ref → hero-targeting/AA/skill
  state.boss2Ads.push(m);
  return m;
}
function spawnBoss2AdWaveEngine(state, size) {
  // Despawn ev. överlevande ads från förra vågen (S2): annars nollställs deras dödstimer.
  for (let i = state.boss2Ads.length - 1; i >= 0; i--) despawnBoss2AdEngine(state, state.boss2Ads[i]);
  for (let i = 0; i < size; i++) spawnBoss2AdEngine(state, (i / size) * Math.PI * 2);
  state.boss2AdWaveTimer.remaining = BOSS2_AD_LIFETIME; state.boss2AdWaveTimer.active = true;
}
function despawnBoss2AdEngine(state, m) {
  let k = state.boss2Ads.indexOf(m); if (k >= 0) state.boss2Ads.splice(k, 1);
  k = state.sides[1].monsters.indexOf(m); if (k >= 0) state.sides[1].monsters.splice(k, 1);
}
function applyBoss2AdExplosionEngine(state, boss, adCount) {
  const pct = (boss && boss.bossPhase === 2) ? BOSS2_AD_EXPLODE_PCT_P2 : BOSS2_AD_EXPLODE_PCT_P1;
  // Skala med antal kvarvarande ads men cappa total-skadan (S1): annars 3×50%=150% = säker wipe.
  const totalPct = Math.min(pct * Math.max(1, adCount || 1), BOSS2_AD_EXPLODE_CAP_PCT);
  for (const tgt of bossWarsTargets(state)) { if (!tgt || !tgt.hero || tgt.hero.dead) continue; damageHero(tgt, tgt.hero.maxHp * totalPct); }
}
function triggerBoss2AdWipeEngine(state) {
  for (const tgt of bossWarsTargets(state)) { if (!tgt || !tgt.hero || tgt.hero.dead) continue; killHero(tgt); }
}
// Anropas från killMonster när en hero dödar en boss-2-ad: wipe om kill-cooldown löper, annars starta den.
function onBoss2AdHeroKill(state, ad) {
  const k = state.boss2Ads.indexOf(ad); if (k >= 0) state.boss2Ads.splice(k, 1);
  if (state.boss2KillCooldown.remaining > 0) {
    triggerBoss2AdWipeEngine(state);
  } else {
    const boss = state.boss;
    state.boss2KillCooldown.remaining = (boss && boss.bossPhase === 2) ? BOSS2_AD_KILL_COOLDOWN_P2 : BOSS2_AD_KILL_COOLDOWN_P1;
  }
}
function applyBoss2AdStackHitEngine(state, side) {
  if (!side || !side.hero || side.hero.dead) return;
  const boss = state.boss;
  const maxStacks = (boss && boss.bossPhase === 2) ? BOSS2_AD_STACK_MAX_P2 : BOSS2_AD_STACK_MAX_P1;
  side.adStacks = Math.min(maxStacks, (side.adStacks || 0) + 1);
  side.adStackTimer = BOSS2_AD_STACK_DECAY;
  damageHero(side, side.adStacks * BOSS2_AD_STACK_DMG_PCT * side.hero.maxHp);
  const slowMul = Math.max(BOSS2_AD_STACK_SLOW_FLOOR, 1 - side.adStacks * BOSS2_AD_STACK_SLOW_PCT);
  side.heroSlowMul = Math.min(side.heroSlowMul != null ? side.heroSlowMul : 1, slowMul);
  side.heroSlowTime = Math.max(side.heroSlowTime || 0, BOSS2_AD_STACK_DECAY);
}
function tickBoss2AdStacksEngine(state, dt) {
  for (const idx of [1, 2, 3]) {
    const s = state.sides[idx];
    if (!s) continue;
    if ((s.adStackTimer || 0) > 0) { s.adStackTimer -= dt; if (s.adStackTimer <= 0) { s.adStackTimer = 0; s.adStacks = 0; } }
  }
}
function spawnBoss2AdProjectileEngine(state, ad, targetIdx) {
  state.sides[1].monsterProjectiles.push({
    id: state.nextEntityId++, x: ad.x, y: MONSTER_PROJ_Y, z: ad.z, srcX: ad.x, srcZ: ad.z,
    damage: ad.damage, timer: ad.projTime, totalTime: ad.projTime, kind: 'darkOrb',
    bossTargetIdx: targetIdx, isBoss2AdProj: true,   // impact → applyBoss2AdStackHitEngine
  });
}
function tickBoss2AdWavesEngine(state, dt) {
  if (!boss2AdsActive(state) || !state.bossActivated) return;
  const boss = state.boss;
  if (!boss || boss.hp <= 0) { state.boss2AdWaveSpawn.active = false; return; }
  if ((boss.phaseTransitionRemaining || 0) > 0) return;
  if (!state.boss2AdWaveSpawn.active) { state.boss2AdWaveSpawn.active = true; state.boss2AdWaveSpawn.countdown = BOSS2_AD_WAVE_FIRST_DELAY; }
  state.boss2AdWaveSpawn.countdown -= dt;
  if (state.boss2AdWaveSpawn.countdown <= 0) {
    spawnBoss2AdWaveEngine(state, BOSS2_AD_WAVE_SIZE);
    state.boss2AdWaveSpawn.countdown += (boss.bossPhase === 2) ? BOSS2_AD_WAVE_INTERVAL_P2 : BOSS2_AD_WAVE_INTERVAL_P1;
  }
}
function updateBoss2AdsEngine(state, dt) {
  if (!boss2AdsActive(state)) return;
  if (state.boss2KillCooldown.remaining > 0) state.boss2KillCooldown.remaining = Math.max(0, state.boss2KillCooldown.remaining - dt);
  const arr = state.boss2Ads;
  // Våg tömd av hero-kills → deaktivera dödstimer (ingen explosion).
  if (state.boss2AdWaveTimer.active && (!arr || arr.length === 0)) { state.boss2AdWaveTimer.remaining = 0; state.boss2AdWaveTimer.active = false; }
  if (!arr || arr.length === 0) return;
  const boss = state.boss;
  const inTransition = !!(boss && (boss.phaseTransitionRemaining || 0) > 0);
  // Våg-gemensam dödstimer → ALLA kvarvarande ads exploderar samma frame (skada per ad).
  if (state.boss2AdWaveTimer.active && !inTransition) {
    state.boss2AdWaveTimer.remaining -= dt;
    if (state.boss2AdWaveTimer.remaining <= 0) {
      applyBoss2AdExplosionEngine(state, boss, arr.length);   // EN cappad våg-explosion (ej per-ad)
      for (let i = arr.length - 1; i >= 0; i--) { const ad = arr[i]; if (ad) despawnBoss2AdEngine(state, ad); }
      state.boss2AdWaveTimer.remaining = 0; state.boss2AdWaveTimer.active = false;
      return;
    }
  }
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (!m) continue;
    if (m.hp <= 0 || !state.sides[1].monsters.includes(m)) { despawnBoss2AdEngine(state, m); continue; }
    const target = nearestLiveHero(state, m.x, m.z);
    if (!target) continue;
    const dx = target.hero.x - m.x, dz = target.hero.z - m.z;
    const dist = Math.hypot(dx, dz) || 1;
    m.atkCd = Math.max(0, (m.atkCd || 0) - dt);
    if (dist > m.attackRange) {   // utanför räckvidd → jaga
      const step = m.moveSpeed * dt;
      m.x += (dx / dist) * step; m.z += (dz / dist) * step;
    } else if (m.atkCd <= 0) {    // inom räckvidd → skjut homing-projektil
      spawnBoss2AdProjectileEngine(state, m, target.idx);
      m.atkCd = m.attackInterval;
    }
  }
}

// ===== BOSS 4 (DEMON PRINCE) GIFTVÄSKE-MEKANIK (decision 132) =====
// Bärar-minions (2 var 30:e sek) jagar närmaste hjälte + lägger en refresh:ande DoT.
// Dödas en minion → den droppar en väska på marken (5s). Plockas väskan (stå på den 1s) →
// hjälten bär den 5s (slow + dot + ingen skill-cast, kan ej släppa) → blir en PERMANENT
// giftpool där hjälten står. Plockas väskan EJ inom 5s → poolen bildas där väskan ligger.
// Pooler: 5% maxHP/0.5s + 50% slow på hjältar (INGEN stapling), och om bossen står i en
// pool får den +1% maxHP heal/sek + 20% utgående skada (försvinner direkt när den lämnar).
// Fas 1 / Fas 2 (eskalering vid fasbyte 30% HP, användarbeslut 2026-06-05):
// minion-HP 420→600, DoT 3%→5% maxHP/s, mark-pickup-tid 5s→4s, boss-heal 1%→2%/s, boss-buff +20%→+40%.
const BOSS4_MINION_HP_P1 = 420, BOSS4_MINION_HP_P2 = 600;
const BOSS4_MINION_SPEED = 5.0, BOSS4_MINION_RANGE = 2.6, BOSS4_MINION_ATK_INTERVAL = 1.5;
const BOSS4_MINION_SPAWN_INTERVAL = 30, BOSS4_MINION_SPAWN_COUNT = 2, BOSS4_MINION_FIRST_DELAY = 8;
const BOSS4_MINION_DOT_PCT_P1 = 0.03, BOSS4_MINION_DOT_PCT_P2 = 0.05, BOSS4_MINION_DOT_DUR = 5, BOSS4_MINION_SLOW_MUL = 0.80;
const BOSS4_BAG_GROUND_TIME_P1 = 5, BOSS4_BAG_GROUND_TIME_P2 = 4, BOSS4_BAG_PICKUP_TIME = 1.0, BOSS4_BAG_PICKUP_RADIUS = 1.0, BOSS4_BAG_CARRY_TIME = 5;
const BOSS4_CARRY_SLOW_MUL = 0.70, BOSS4_CARRY_DOT_PCT = 0.01;
const BOSS4_POOL_RADIUS = 6.0, BOSS4_POOL_TICK = 0.5, BOSS4_POOL_DMG_PCT = 0.05, BOSS4_POOL_SLOW_MUL = 0.50;   // radie 6m (12m diam)
const BOSS4_BOSS_HEAL_PCT_P1 = 0.01, BOSS4_BOSS_HEAL_PCT_P2 = 0.02, BOSS4_BOSS_DMG_BUFF_P1 = 1.20, BOSS4_BOSS_DMG_BUFF_P2 = 1.40;
function boss4Active(state) { return state.tier === 4; }
function boss4IsP2(state) { return !!(state.boss && state.boss.bossPhase === 2); }
function boss4GroundTime(state) { return boss4IsP2(state) ? BOSS4_BAG_GROUND_TIME_P2 : BOSS4_BAG_GROUND_TIME_P1; }
function spawnBoss4Minion(state, ang) {
  const r = BOSSWARS_RADIUS - 3;
  const hp = boss4IsP2(state) ? BOSS4_MINION_HP_P2 : BOSS4_MINION_HP_P1;
  const m = {
    id: state.nextEntityId++, hp, maxHp: hp,
    x: BOSSWARS_CX + Math.cos(ang) * r, z: BOSSWARS_CZ + Math.sin(ang) * r,
    moveSpeed: BOSS4_MINION_SPEED, isBoss4Minion: true, isMinion: false, isBoss2Ad: false,
    isMonster: false, isBoss: false, isBossWarsBoss: false,
    attackType: 'melee', damage: 0, attackRange: BOSS4_MINION_RANGE,
    attackInterval: BOSS4_MINION_ATK_INTERVAL, atkCd: 0, _bwState: state,
  };
  state.sides[1].monsters.push(m);   // delad ref → hero-targeting/AA/skill kan döda minion
  state.boss4Minions.push(m);
  return m;
}
function despawnBoss4Minion(state, m) {
  let k = state.boss4Minions.indexOf(m); if (k >= 0) state.boss4Minions.splice(k, 1);
  k = state.sides[1].monsters.indexOf(m); if (k >= 0) state.sides[1].monsters.splice(k, 1);
}
function tickBoss4MinionSpawns(state, dt) {
  if (!state.bossActivated) return;
  const boss = state.boss;
  if (!boss || boss.hp <= 0) { state.boss4Spawn.active = false; return; }
  if ((boss.phaseTransitionRemaining || 0) > 0) return;   // pausa under fas-övergång (matchar ads)
  if (!state.boss4Spawn.active) { state.boss4Spawn.active = true; state.boss4Spawn.countdown = BOSS4_MINION_FIRST_DELAY; }
  state.boss4Spawn.countdown -= dt;
  if (state.boss4Spawn.countdown <= 0) {
    for (let i = 0; i < BOSS4_MINION_SPAWN_COUNT; i++) spawnBoss4Minion(state, Math.random() * Math.PI * 2);
    state.boss4Spawn.countdown += BOSS4_MINION_SPAWN_INTERVAL;
  }
}
function updateBoss4Minions(state, dt) {
  const arr = state.boss4Minions;
  if (!arr || arr.length === 0) return;
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (!m) continue;
    // Death-sweep: hp<=0, ELLER redan removed ur side.monsters av killMonster (hero-kill → drop bag).
    if (m.hp <= 0 || !state.sides[1].monsters.includes(m)) { despawnBoss4Minion(state, m); continue; }
    const target = nearestLiveHero(state, m.x, m.z);
    if (!target) continue;
    const dx = target.hero.x - m.x, dz = target.hero.z - m.z;
    const dist = Math.hypot(dx, dz) || 1;
    m.atkCd = Math.max(0, (m.atkCd || 0) - dt);
    if (dist > m.attackRange) {
      const step = m.moveSpeed * dt;
      m.x += (dx / dist) * step; m.z += (dz / dist) * step;
    } else if (m.atkCd <= 0) {
      applyBoss4MinionHit(state, target);
      m.atkCd = m.attackInterval;
    }
  }
}
// Minion-AA = refresh:ande DoT (3%/5% maxHP/sek i 5s, fas-beroende) + 20% slow. Träff refreshar.
function applyBoss4MinionHit(state, side) {
  if (!side || !side.hero || side.hero.dead) return;
  side.b4DotRem = BOSS4_MINION_DOT_DUR;
  side.b4DotPs = (boss4IsP2(state) ? BOSS4_MINION_DOT_PCT_P2 : BOSS4_MINION_DOT_PCT_P1) * side.hero.maxHp;
}
function tickBoss4MinionDot(state, dt) {
  for (const idx of [1, 2, 3]) {
    const s = state.sides[idx];
    if (!s) continue;
    if ((s.b4DotRem || 0) > 0) {
      s.b4DotRem = Math.max(0, s.b4DotRem - dt);
      if (!s.hero.dead) {
        damageHero(s, (s.b4DotPs || 0) * dt);
        s.heroSlowMul = Math.min(s.heroSlowMul != null ? s.heroSlowMul : 1, BOSS4_MINION_SLOW_MUL);
        s.heroSlowTime = Math.max(s.heroSlowTime || 0, 0.2);
      }
    }
  }
}
// Hero-kill på bärar-minion → droppa väska. Anropas från killMonster (monstret redan ur monsters).
function onBoss4MinionKill(state, m) {
  const k = state.boss4Minions.indexOf(m); if (k >= 0) state.boss4Minions.splice(k, 1);
  spawnBoss4Bag(state, m.x, m.z);
}
function spawnBoss4Bag(state, x, z) {
  const gt = boss4GroundTime(state);
  state.boss4Bags.push({ id: state.nextEntityId++, x, z, st: 'ground', timer: gt, maxTimer: gt, ci: 0, pk: 0, pkT: 0 });
}
function spawnBoss4Pool(state, x, z) {
  state.boss4Pools.push({ id: state.nextEntityId++, x, z });   // permanent (ingen life)
}
function tickBoss4Bags(state, dt) {
  const arr = state.boss4Bags;
  if (!arr || arr.length === 0) return;
  const rSq = BOSS4_BAG_PICKUP_RADIUS * BOSS4_BAG_PICKUP_RADIUS;
  for (let i = arr.length - 1; i >= 0; i--) {
    const b = arr[i];
    if (b.st === 'ground') {
      // Pickup-detektering: en hjälte (som inte redan bär) måste stå inom radie i 1s sammanhängande.
      let cand = 0;
      for (const idx of [1, 2, 3]) {
        const s = state.sides[idx];
        if (!s || s.hero.dead || s.boss4Carrying) continue;
        const dx = s.hero.x - b.x, dz = s.hero.z - b.z;
        if (dx * dx + dz * dz <= rSq) { cand = idx; break; }
      }
      if (cand && cand === b.pk) {
        b.pkT += dt;
        if (b.pkT >= BOSS4_BAG_PICKUP_TIME) {
          b.st = 'carried'; b.ci = cand; b.timer = BOSS4_BAG_CARRY_TIME; b.maxTimer = BOSS4_BAG_CARRY_TIME; b.pk = 0; b.pkT = 0;
          state.sides[cand].boss4Carrying = b.id;
          continue;
        }
      } else { b.pk = cand; b.pkT = 0; }   // bytt/lämnat kandidat → nollställ 1s-timern
      b.timer -= dt;
      if (b.timer <= 0) { spawnBoss4Pool(state, b.x, b.z); arr.splice(i, 1); }
    } else {   // carried
      const s = state.sides[b.ci];
      if (!s || s.hero.dead) {
        // Bärare död → väskan droppar som upplockbar väska igen, ny mark-timer (svar 8C).
        if (s) s.boss4Carrying = 0;
        b.st = 'ground'; b.timer = boss4GroundTime(state); b.maxTimer = b.timer; b.ci = 0; b.pk = 0; b.pkT = 0;
        continue;
      }
      b.x = s.hero.x; b.z = s.hero.z;   // väskan följer bäraren
      damageHero(s, BOSS4_CARRY_DOT_PCT * s.hero.maxHp * dt);   // 1% maxHP/sek
      s.heroSlowMul = Math.min(s.heroSlowMul != null ? s.heroSlowMul : 1, BOSS4_CARRY_SLOW_MUL);   // 30% slow
      s.heroSlowTime = Math.max(s.heroSlowTime || 0, 0.2);
      if (s.hero.dead) {   // dog av carry-dot denna tick → droppa väska
        s.boss4Carrying = 0;
        b.st = 'ground'; b.timer = boss4GroundTime(state); b.maxTimer = b.timer; b.ci = 0; b.pk = 0; b.pkT = 0;
        continue;
      }
      b.timer -= dt;
      if (b.timer <= 0) { spawnBoss4Pool(state, s.hero.x, s.hero.z); s.boss4Carrying = 0; arr.splice(i, 1); }
    }
  }
}
function tickBoss4Pools(state, dt) {
  const arr = state.boss4Pools;
  const boss = state.boss;
  // Boss-buff/heal: utvärderas VARJE frame (försvinner direkt när bossen lämnar poolen).
  if (boss && boss.hp > 0) {
    let bossInPool = false;
    if (arr) for (const p of arr) {
      const dx = boss.x - p.x, dz = boss.z - p.z;
      if (dx * dx + dz * dz < BOSS4_POOL_RADIUS * BOSS4_POOL_RADIUS) { bossInPool = true; break; }
    }
    const p2 = boss4IsP2(state);
    boss.boss4DmgBuff = bossInPool ? (p2 ? BOSS4_BOSS_DMG_BUFF_P2 : BOSS4_BOSS_DMG_BUFF_P1) : 1;
    if (bossInPool && boss.hp < boss.maxHp) boss.hp = Math.min(boss.maxHp, boss.hp + boss.maxHp * (p2 ? BOSS4_BOSS_HEAL_PCT_P2 : BOSS4_BOSS_HEAL_PCT_P1) * dt);
  }
  // Hero DOT/slow: var 0.5s. INGEN stapling — en hjälte i flera pooler tar EN tick (svar 4).
  if (!arr || arr.length === 0) return;
  state._b4PoolAccum = (state._b4PoolAccum || 0) + dt;
  if (state._b4PoolAccum < BOSS4_POOL_TICK) return;
  state._b4PoolAccum -= BOSS4_POOL_TICK;
  const rSq = BOSS4_POOL_RADIUS * BOSS4_POOL_RADIUS;
  for (const idx of [1, 2, 3]) {
    const s = state.sides[idx];
    if (!s || s.hero.dead) continue;
    let inPool = false;
    for (const p of arr) {
      const dx = s.hero.x - p.x, dz = s.hero.z - p.z;
      if (dx * dx + dz * dz < rSq) { inPool = true; break; }
    }
    if (inPool) {
      damageHero(s, s.hero.maxHp * BOSS4_POOL_DMG_PCT);
      s.heroSlowMul = Math.min(s.heroSlowMul != null ? s.heroSlowMul : 1, BOSS4_POOL_SLOW_MUL);
      s.heroSlowTime = Math.max(s.heroSlowTime || 0, BOSS4_POOL_TICK + 0.1);
    }
  }
}
function tickBoss4(state, dt) {
  if (!boss4Active(state)) return;
  tickBoss4MinionSpawns(state, dt);
  updateBoss4Minions(state, dt);
  tickBoss4MinionDot(state, dt);
  tickBoss4Bags(state, dt);
  tickBoss4Pools(state, dt);
}

// Boss-wars top-tick. SLICE 1a-3b: hjälte + boss-AI + minion-vågor/aura + boss-2-ads.
// Boss wars-bot (co-op-medspelare, server-auth). Mirror av main.js tickBossWarsBotSolo.
// Gå in i boss-rummet → target state.boss → move/AA/skill (ult tillåten i boss wars).
function tickBossWarsBot(state, sideIdx, dt) {
  const side = state.sides[sideIdx];
  if (!side || !side.isBot || side.hero.dead) return;
  const input = state.lastInputs[sideIdx];
  if (!side._botSkillsInited) {
    side._botSkillsInited = true;
    side.skillLvl = side.skillLvl || { q: 0, f: 0, e: 0 };
    for (const k of ['q', 'f', 'e']) if ((side.skillLvl[k] || 0) < 1) side.skillLvl[k] = 1;
  }
  const p = BOT_PARAMS[side.botDifficulty] || BOT_PARAMS.medium;
  if ((side.hero.frozenTime || 0) > 0 || (side.heroFearTime || 0) > 0 || (side.hero.tauntedTime || 0) > 0 || (side.iceBlockRemaining || 0) > 0) { if (input) input.j = null; return; }
  if (!state.bossActivated) {
    const dx = BOSSWARS_CX - side.hero.x, dz = BOSSWARS_CZ - side.hero.z, d = Math.hypot(dx, dz) || 1;
    if (input) input.j = (d > 2) ? { x: dx / d, z: dz / d } : null;
    return;
  }
  const boss = state.boss;
  if (!boss || (boss.hp || 0) <= 0) { if (input) input.j = null; return; }
  const dx = boss.x - side.hero.x, dz = boss.z - side.hero.z, d = Math.hypot(dx, dz) || 1;
  side.hero.facingX = dx / d; side.hero.facingZ = dz / d;
  const range = side.attackRange || HERO_ATTACK_RANGE;
  let mx = 0, mz = 0;
  if (d > range * 0.8) { mx = dx / d; mz = dz / d; }
  else if (d < range * 0.45) { mx = -dx / d; mz = -dz / d; }
  if (mx || mz) { mx += (Math.random() - 0.5) * p.jitter; mz += (Math.random() - 0.5) * p.jitter; const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml; }
  if (input) input.j = (mx || mz) ? { x: mx, z: mz } : null;
  side.targetId = boss.id; side.targetType = 'monster';
  if (d <= range + 0.5 && !side.aaActive) applyEvent(state, sideIdx, { type: 'aa' });
  side._botSkillT = (side._botSkillT || 0) - dt;
  if (side._botSkillT <= 0 && Math.random() < p.skillRatePerSec * dt) {
    side._botSkillT = p.skillReactionMs / 1000;
    const cand = [];
    for (const k of ['q', 'f', 'e']) if (side.skills[k] && side.skills[k].cd <= 0) cand.push(k);
    if ((side.ultEnergy || 0) >= ULT_ENERGY_MAX) cand.push('r');   // ult funkar i boss wars
    if (cand.length) applyEvent(state, sideIdx, { type: 'skill', key: cand[(Math.random() * cand.length) | 0], dx: dx / d, dz: dz / d, tap: true });
  }
}

function tickBossWars(state, dt) {
  if (state.matchState && state.matchState.gameOver) return;
  // Bot-AI (co-op-medspelare): sätter rörelse-input + AA/skill före rörelse-loopen.
  for (const idx of [1, 2, 3]) if (state.sides[idx] && state.sides[idx].isBot) tickBossWarsBot(state, idx, dt);
  // 1) Rörelse (alla 3 hjältar) — applyMovement använder isBossWarsWalkable.
  for (const idx of [1, 2, 3]) {
    const s = state.sides[idx];
    if (!s) continue;
    // Boss wars: INGEN respawn under boss-fights (användarbeslut 2026-06-05) — död hjälte stannar
    // död tills matchen tar slut när HELA laget är dött (wipe, checkBossWarsEnd). Matchar solo.
    if (s.hero.dead) continue;
    s._bwGateClosed = state.gateClosed;   // sync till heroWalk/applyMovement
    const inp = state.lastInputs[idx];
    const j = (inp && inp.j) || { x: 0, z: 0 };
    heroAutoMove(s, j, dt);
  }
  // 2) Hjälte-combat (CO-OP vs boss). opp=null → ingen hero-vs-hero (friendly fire).
  // Bossen ligger i sides[1].monsters (delad ref) → updateHeroAttack/updateProjectiles
  // riktar mot den för alla 3 hjältar. updateHeroAttack/updateProjectiles är opp-null-säkra.
  for (const idx of [1, 2, 3]) {
    const s = state.sides[idx];
    if (!s) continue;
    updateSkillCooldowns(s, dt);
    if (!s.hero.dead) updateHeroAttack(state, s, null, dt);
    updateProjectiles(state, s, null, dt);
    // Skill-ENTITET-updates (slice 1c). Delade med classic line wars → de skadar
    // monster (= bossen, i delad sides[1].monsters). opp=null (co-op, ingen PvP/friendly
    // fire). ULTS (laser/rage/berserk) = slice 1d (skrivna mot opp.hero, måste boss-adapteras).
    // updateBossProjectiles/Pools = slice 2 (boss-AI). Audit: alla opp-null-säkra.
    updateFireballs(state, s, null, dt);
    updateBlackHoles(state, s, null, dt);
    updateVineTraps(state, s, null, dt);
    updateHammers(state, s, null, dt);
    updateIronWill(state, s, null, dt);
    updateAragurnWhirlwind(state, s, null, dt);
    updateAragurnLeap(state, s, null, dt);
    updateAragurnShoutHeal(s, dt);
    updateSoulDrain(state, s, null, dt);
    tickLegolusInvis(s, dt);
    tickThornPools(state, s, dt);
    tickKostefoSkills(state, s, null, dt);
    tickGimluTauntLvl5(state, s, null, dt);
    flushIronWillReflectLvl5(state, s, null);
    tickAragurnBannersLvl5(s, dt);
    if (s.heroId === 'elar') {
      s._elarCountTickAccum = (s._elarCountTickAccum || 0) + dt;
      if (s._elarCountTickAccum >= 0.2 || s.elarNearbyCount == null) {
        s._elarCountTickAccum = 0;
        s.elarNearbyCount = elarNearbyCount(state, s);
      }
    }
    if (s.ironWillExplosions) for (let k = s.ironWillExplosions.length - 1; k >= 0; k--) {
      s.ironWillExplosions[k].life -= dt;
      if (s.ironWillExplosions[k].life <= 0) s.ironWillExplosions.splice(k, 1);
    }
    updateNovaEffects(state, s, null, dt);
    updateActiveBuffs(s, dt);
    // Ults (slice 1d): laser/rage träffar boss-monstret; berserk = AA-modifier (decrement här).
    if (s.laserBeam) tickMagikerLaserServer(state, s, dt);
    if ((s.rageRemaining || 0) > 0) tickGimluRageServer(state, s, dt);
    if ((s.berserkRemaining || 0) > 0) {
      if (s.hero.dead) s.berserkRemaining = 0;
      else s.berserkRemaining = Math.max(0, s.berserkRemaining - dt);
    }
    // Self-state-tick (mirror tickArenaCombat 1483-1506): ult-energy, lockout, buff-
    // timers, CC-nedräkning (boss CC:ar heroes i slice 2 — utan detta fastnar CC permanent),
    // regen (healPerSecPct-talent/item). Allt opp-oberoende → säkert i co-op.
    if (!s.hero.dead) gainUltEnergy(s, ULT_GAIN_PASSIVE * dt);
    if ((s._ultLockoutTime || 0) > 0) s._ultLockoutTime = Math.max(0, s._ultLockoutTime - dt);
    if ((s.nyroBuffRemaining || 0) > 0) s.nyroBuffRemaining = Math.max(0, s.nyroBuffRemaining - dt);
    if ((s.windPuffMsRem || 0) > 0) s.windPuffMsRem = Math.max(0, s.windPuffMsRem - dt);
    if ((s.kryxHammerMsRem || 0) > 0) s.kryxHammerMsRem = Math.max(0, s.kryxHammerMsRem - dt);
    tickZheyna(state, s, dt); tickXina(state, s, dt);
    if ((s.hero.frozenTime || 0) > 0) s.hero.frozenTime = Math.max(0, s.hero.frozenTime - dt);
    if ((s.hero.tauntedTime || 0) > 0) s.hero.tauntedTime = Math.max(0, s.hero.tauntedTime - dt);
    if ((s.phoenixImmuneRemaining || 0) > 0) s.phoenixImmuneRemaining = Math.max(0, s.phoenixImmuneRemaining - dt);
    if ((s.hero.dotRemaining || 0) > 0) {
      s.hero.dotRemaining = Math.max(0, s.hero.dotRemaining - dt);
      damageHero(s, (s.hero.dotPerSec || 0) * dt);   // DoT-skada saknades i boss-wars-loopen
    }
    if ((s.hero.poisonRemaining || 0) > 0) s.hero.poisonRemaining = Math.max(0, s.hero.poisonRemaining - dt);
    if ((s.heroSlowTime || 0) > 0) {
      s.heroSlowTime = Math.max(0, s.heroSlowTime - dt);
      if (s.heroSlowTime <= 0) { s.heroSlowTime = 0; s.heroSlowMul = 1; }
    }
    tickKryxTimers(s, dt);   // Titan's Stomp-DR + hjälte-AS-slow (rework)
    if ((s.heroFearTime || 0) > 0) s.heroFearTime = Math.max(0, s.heroFearTime - dt);
    if ((s.iceBlockRemaining || 0) > 0) s.iceBlockRemaining = Math.max(0, s.iceBlockRemaining - dt);
    if (!s.hero.dead && (s.healPerSecPct || 0) > 0 && s.hero.hp < s.hero.maxHp) {
      s.hero.hp = Math.min(s.hero.maxHp, s.hero.hp + s.hero.maxHp * s.healPerSecPct * dt);
    }
  }
  // 3) Boss-aktivering (alla inne → vakna + gate) + boss-AI (rörelse + AA) + boss-projektiler.
  maybeActivateBossWars(state);
  tickBossWarsBoss(state, dt);
  tickBossWarsMinionWavesEngine(state, dt);   // boss-1 minion-vågor (slice 3b)
  updateBossWarsMinionsEngine(state, dt);     // minion-rörelse mot boss + absorption
  tickBossWarsMinionAuraEngine(state, dt);    // minion-aura skadar närstående heroes
  tickBoss2AdWavesEngine(state, dt);          // boss-2 ad-vågor (slice 3b-ii)
  updateBoss2AdsEngine(state, dt);            // boss-2 ad-AI (jakt/distansattack/explosion/wipe)
  tickBoss2AdStacksEngine(state, dt);         // boss-2 ad-stack-decay
  tickBoss4(state, dt);                        // boss-4 giftväske-mekanik (decision 132)
  tickBossWarsProjectiles(state, dt);
  tickBossWarsPools(state, dt);
  updateMonsterProjectiles(state, state.sides[1], dt);
  checkBossWarsEnd(state);   // boss död → spelarna vinner (server.js stoppar loop + skickar b-end)
}
// Match-slut: boss död → spelarna vinner. (Lose-villkor = slice 4: wipe/time.)
// OBS: classic checkMatchEnd (torn-logik) får EJ anropas för boss wars.
function checkBossWarsEnd(state) {
  if (state.matchState.gameOver) return;
  if (state.boss && state.boss.hp <= 0) {
    state.matchState.gameOver = true;
    state.matchState.winner = 1;   // 1 = spelarna vann (boss död)
    return;
  }
  // Lose: ALLA sides döda (wipe). INGEN respawn i boss wars (användarbeslut 2026-06-05) — döda
  // hjältar stannar döda, så matchen tar slut när hela laget ligger nere (ej nödvändigtvis samma tick).
  const heroes = [state.sides[1], state.sides[2], state.sides[3]].filter(Boolean);
  if (heroes.length > 0 && heroes.every(h => h.hero.dead)) {
    state.matchState.gameOver = true;
    state.matchState.winner = 2;   // 2 = bossen vann
  }
}

// Persistenta boss-wars-snap-buffrar (muteras, ej allokeras 30 Hz — som arena).
const _bwHeroBuf1 = _makeHeroSnapBuf();
const _bwHeroBuf2 = _makeHeroSnapBuf();
const _bwHeroBuf3 = _makeHeroSnapBuf();
const _bwMapMr = (p) => ({ id: p.id, x: r2(p.x), z: r2(p.z), kind: p.kind });
const _bwBossBuf = { x: 0, z: 0, hp: 0, mh: 0, ph: 1, pt: 0, aac: 0, dr: 0, c: undefined, wl: undefined, dg: undefined };
// Warlord (boss 3) symbol-mekanik-buffer (persistent → ingen 30 Hz-allokering). sy = mark-symboler.
const _bwWarlordSy = [];
const _bwWarlordBuf = { a: 0, r: 1, rv: null, pc: 0, pi: 0, pt: 0, pv: 5, sy: null };
// Boss-cast-buffer (telegraph/execute) — matchar klientens buildBossWarsSnap cast-fält
// (applyBossWarsState läser n/k/rad/len/ha/w/ph/t/tg/tx/tz/ox/oz/dx/dz).
const _bwCastBuf = { n: '', k: 'circle', rad: 0, len: 0, ha: 0, w: 0, ph: 'telegraph', t: 0, tg: 0, tx: null, tz: null, ox: null, oz: null, dx: null, dz: null };
const _bwSnap = {
  t: 'b-state',
  ba: false, gc: false, tr: 1,
  h: { 1: null, 2: null, 3: null },
  mr: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR, 3: _ARENA_EMPTY_ARR },
  b: null,
  bp: _ARENA_EMPTY_ARR, bpl: _ARENA_EMPTY_ARR, bm: _ARENA_EMPTY_ARR, ba2: _ARENA_EMPTY_ARR, b2r: false,   // 2c+3b+3b-ii
  b4m: _ARENA_EMPTY_ARR, b4b: _ARENA_EMPTY_ARR, b4p: _ARENA_EMPTY_ARR,   // boss-4 minions/väskor/pooler (decision 132)
  // Hero skill-entities per side (1..3) — SHARED shape with Arena/Sandbox (writeSkillEntitiesInto).
  // Boss Wars previously emitted NONE of these → hero skills looked empty online.
  bh: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR, 3: _ARENA_EMPTY_ARR },
  fw: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR, 3: _ARENA_EMPTY_ARR },
  nv: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR, 3: _ARENA_EMPTY_ARR },
  ab: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR, 3: _ARENA_EMPTY_ARR },
  kg: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR, 3: _ARENA_EMPTY_ARR },
  ks: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR, 3: _ARENA_EMPTY_ARR },
  vt: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR, 3: _ARENA_EMPTY_ARR },
  tp: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR, 3: _ARENA_EMPTY_ARR },
  hm: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR, 3: _ARENA_EMPTY_ARR },
  iwe: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR, 3: _ARENA_EMPTY_ARR },
  kCln: { 1: _ARENA_EMPTY_ARR, 2: _ARENA_EMPTY_ARR, 3: _ARENA_EMPTY_ARR },
};
// Serialisera boss-wars-state → b-state-meddelandet. Matchar main.js buildBossWarsSnap
// FÄLT-FÖR-FÄLT (serializer-paritet #1) så klientens applyBossWarsState läser det
// oförändrat: ba/gc, h[1..3] (serializeArenaHero=applyHeroSnap-form), mr[1..3] projektiler,
// b{x,z,hp,mh,ph,pt,aac,c}, tr. Boss-cast (c) serialiseras i slice 2 (telegraph/execute);
// här undefined (statisk boss). Muterar _bwSnap på plats (ingen 30 Hz-allokering).
function serializeBossWarsState(state) {
  const snap = _bwSnap;
  snap.ba = !!state.bossActivated;
  snap.gc = !!state.gateClosed;
  snap.tr = state.tier || 1;
  snap.h[1] = serializeArenaHero(state.sides[1], _bwHeroBuf1);
  snap.h[2] = serializeArenaHero(state.sides[2], _bwHeroBuf2);
  snap.h[3] = serializeArenaHero(state.sides[3], _bwHeroBuf3);
  snap.mr[1] = arrOpt(state.sides[1] && state.sides[1].monsterProjectiles, _bwMapMr) || _ARENA_EMPTY_ARR;
  snap.mr[2] = arrOpt(state.sides[2] && state.sides[2].monsterProjectiles, _bwMapMr) || _ARENA_EMPTY_ARR;
  snap.mr[3] = arrOpt(state.sides[3] && state.sides[3].monsterProjectiles, _bwMapMr) || _ARENA_EMPTY_ARR;
  // Hero skill-entities per side via the SHARED serializer (same as Arena/Sandbox).
  for (let i = 1; i <= 3; i++) {
    const s = state.sides[i];
    if (s) writeSkillEntitiesInto(s, snap, i);
    else { snap.bh[i] = _ARENA_EMPTY_ARR; snap.fw[i] = _ARENA_EMPTY_ARR; snap.nv[i] = _ARENA_EMPTY_ARR; snap.ab[i] = _ARENA_EMPTY_ARR; snap.kg[i] = _ARENA_EMPTY_ARR; snap.ks[i] = _ARENA_EMPTY_ARR; snap.vt[i] = _ARENA_EMPTY_ARR; snap.tp[i] = _ARENA_EMPTY_ARR; snap.hm[i] = _ARENA_EMPTY_ARR; snap.iwe[i] = _ARENA_EMPTY_ARR; snap.kCln[i] = _ARENA_EMPTY_ARR; }
  }
  // Boss skill-projektiler (directional) + DoT-pooler → klient reconciliear + renderar (slice 2c-client).
  snap.bp = arrOpt(state.bossProjectiles, p => ({ id: p.id, x: r2(p.x), z: r2(p.z), dx: r3(p.dx), dz: r3(p.dz) })) || _ARENA_EMPTY_ARR;
  snap.bpl = arrOpt(state.bossPools, p => ({ id: p.id, x: r2(p.x), z: r2(p.z), r: p.radius, life: r2(p.maxLife ? p.life / p.maxLife : p.life) })) || _ARENA_EMPTY_ARR;
  snap.bm = arrOpt(state.bossWarsMinions, m => ({ id: m.id, x: r2(m.x), z: r2(m.z), hp: ri(m.hp), mh: ri(m.maxHp) })) || _ARENA_EMPTY_ARR;   // boss-1 minions (slice 3b) — hp/mh för klient-HP-bar
  snap.ba2 = arrOpt(state.boss2Ads, m => ({ id: m.id, x: r2(m.x), z: r2(m.z), hp: ri(m.hp), mh: ri(m.maxHp) })) || _ARENA_EMPTY_ARR;   // boss-2 ads (3b-ii)
  // Boss-4 (decision 132): bärar-minions, väskor (st 0=mark/1=buren, t=timer-sek, ci=bärar-idx), pooler.
  snap.b4m = arrOpt(state.boss4Minions, m => ({ id: m.id, x: r2(m.x), z: r2(m.z), hp: ri(m.hp), mh: ri(m.maxHp) })) || _ARENA_EMPTY_ARR;
  // V15: pk = pickup-progress (0..1s stått-på-väskan) — klienten visar PICK-%.
  snap.b4b = arrOpt(state.boss4Bags, b => ({ id: b.id, x: r2(b.x), z: r2(b.z), st: b.st === 'carried' ? 1 : 0, t: r2(b.timer), tm: r2(b.maxTimer != null ? b.maxTimer : BOSS4_BAG_CARRY_TIME), ci: b.ci || 0, pk: nzr2(b.pkT) })) || _ARENA_EMPTY_ARR;
  snap.b4p = arrOpt(state.boss4Pools, p => ({ id: p.id, x: r2(p.x), z: r2(p.z) })) || _ARENA_EMPTY_ARR;
  // Kill-cooldown: återstående sekunder (>0 = WIPE-risk, röd-state). Klienten visar countdown
  // i HOLD-FIRE-bannern + truthy-värdet driver ad-röd-färg (0 = falsy = säkert). Playtest #1.
  snap.b2r = state.boss2KillCooldown.remaining > 0 ? r2(state.boss2KillCooldown.remaining) : 0;
  const boss = state.boss;
  if (boss) {
    const o = _bwBossBuf;
    o.x = r2(boss.x); o.z = r2(boss.z);
    o.hp = ri(boss.hp); o.mh = boss.maxHp;
    o.ph = boss.bossPhase || 1;
    o.pt = nzr2(boss.phaseTransitionRemaining);
    o.aac = boss.aaCount || 0;
    // Härdnings-DR (playtest #4): aktuell time-step-DR i % så klienten kan visa "Hardened".
    const _drSteps = Math.floor((boss.activeTime || 0) / (boss.dmgReductionStepIntervalSec || 120));
    o.dr = Math.round(Math.min(boss.dmgReductionCap || 0.70, (boss.dmgReductionBase || 0) + _drSteps * (boss.dmgReductionStep || 0.05) + (boss.phase2DrBonus || 0)) * 100);
    // Boss-cast → klient ritar telegraph-varning (slice 2b). Matchar buildBossWarsSnap.
    const ac = boss.activeCast;
    if (ac && ac.skill) {
      const c = _bwCastBuf, sk = ac.skill;
      c.n = sk.id || ''; c.k = sk.kind || 'circle';
      c.rad = sk.radius || 0; c.len = sk.length || 0; c.ha = sk.halfAngle || 0; c.w = sk.width || 0;
      c.ph = ac.phase || 'telegraph'; c.t = r2(ac.timer || 0); c.tg = r2(sk.telegraph || 0);
      c.tx = ac.targetX != null ? r2(ac.targetX) : null; c.tz = ac.targetZ != null ? r2(ac.targetZ) : null;
      c.ox = ac.originX != null ? r2(ac.originX) : null; c.oz = ac.originZ != null ? r2(ac.originZ) : null;
      c.dx = ac.dirX != null ? r3(ac.dirX) : null; c.dz = ac.dirZ != null ? r3(ac.dirZ) : null;
      o.c = c;
    } else {
      o.c = undefined;
    }
    // Warlord (boss 3): reveal-symbol över huvudet + challenge (mark-symboler + puls). Tier 3 only.
    if (boss.warlord) {
      const w = boss.warlord, wb = _bwWarlordBuf;
      wb.a = w.challengeActive ? 1 : 0;
      wb.r = w.challengeRound || w.round;
      wb.rv = w.revealDisplay ? w.revealDisplay.shape : null;
      wb.pc = w.pulseCounter || 0;
      wb.pi = w.pulseIdx || 0;
      wb.pt = w.challengeActive ? r2(w.pulseTimer) : 0;
      wb.pv = w.pulseInterval || 5;
      if (w.challengeActive && w.groundSymbols.length) {
        for (let i = 0; i < w.groundSymbols.length; i++) {
          const g = w.groundSymbols[i];
          const e = _bwWarlordSy[i] || (_bwWarlordSy[i] = { s: '', x: 0, z: 0 });
          e.s = g.shape; e.x = r2(g.x); e.z = r2(g.z);
        }
        _bwWarlordSy.length = w.groundSymbols.length;
        wb.sy = _bwWarlordSy;
      } else {
        wb.sy = null;
      }
      o.wl = wb;
    } else {
      o.wl = undefined;
    }
    // Dragon King (boss 5): mekanik-render (reveal-symbol + memory-pelare/aktiverings-pelare). Tier 5.
    if (boss.dragon) {
      const d = boss.dragon;
      const dg = { m: d.active ? d.mech : 0, rv: d.memReveal ? d.memReveal.shape : null, msg: d.msg || '', ph: boss.bossPhase || 1 };
      if (d.active && d.mech === 1) {
        dg.mp = d.memPillars.map(p => ({ s: p.sym, x: r2(p.x), z: r2(p.z) }));
        dg.ap = { x: r2(d.actPillar.x), z: r2(d.actPillar.z) };
        dg.st = d.memStep; dg.mis = d.memMistakes; dg.t = r2(d.memTimer);
      } else if (d.active && d.mech === 2) {
        dg.sl = {
          p: d.slPair, st: d.slState === 'breaking' ? 1 : 0, bw: r2(d.slWindow || 0),
          br: d.slBreaks, t: r2(d.slTimer), o: (d.slOrbs || []).map(o => ({ x: r2(o.x), z: r2(o.z) })),
        };
      } else if (d.active && d.mech === 3) {
        dg.mt = {   // safe-färgen skickas EJ (spelaren måste lösa gåtan); cirkel-färger ÄR synliga
          c: d.mtCircles.map(c => ({ x: r2(c.x), z: r2(c.z), col: c.color })),
          cd: r2(d.mtCountdown), hint: d.mtHint, r: (d.mtRound || 0) + 1,
        };
      }
      o.dg = dg;
    } else {
      o.dg = undefined;
    }
    snap.b = o;
  } else {
    snap.b = null;
  }
  return snap;
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
    pathIndex: 0, atkCd: 0, aac: 0,
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
  if (m.isSandboxDummy) { m.hp = 1; return; }   // sandbox-dummy är odödlig — despawna aldrig
  arenaSide.monsters.splice(idx, 1);
  // Boss-2-ad hero-kill (decision 118): wipe om kill-cooldown löper, annars starta den. Ingen reward.
  if (m.isBoss2Ad && m._bwState) { onBoss2AdHeroKill(m._bwState, m); return; }
  // Boss-4 bärar-minion hero-kill (decision 132): droppa giftväska där den dog. Ingen reward.
  if (m.isBoss4Minion && m._bwState) { onBoss4MinionKill(m._bwState, m); return; }
  // Boss-wars-bossen själv (S4): död hanteras av checkBossWarsEnd — ingen guld/XP-reward (endgame co-op, ej farming).
  if (m.isBossWarsBoss) return;
  // Mini-bosses ger 2× belöning eftersom de är ~4.5x stark som vanliga minions
  const mul = m.isMiniBoss ? 2 : 1;
  const recv = byPlayerSide || arenaSide;
  recv.gold += GOLD_PER_KILL * mul;
  gainXp(recv, MONSTER_XP_REWARD * mul);
}

// === Update ===
function updateSkillCooldowns(side, dt) {
  // Fontän-aura accelererar cd-decrement med +10%
  const eff = dt * (side.heroFountainAura ? FOUNTAIN_CDR_MUL : 1);
  side.skills.q.cd = Math.max(0, side.skills.q.cd - eff);
  side.skills.f.cd = Math.max(0, side.skills.f.cd - eff);
  side.skills.e.cd = Math.max(0, side.skills.e.cd - eff);
  // Legolas Dash lvl5 — andra stackens CD
  if ((side.nyroDashStackCd || 0) > 0) {
    side.nyroDashStackCd = Math.max(0, side.nyroDashStackCd - eff);
  }
}

// Stagger wave-spawn över flera ticks så ingen enskild tick får 20 nya monster
// (vilket gav tick-spikar > 100ms + klient-side mesh-clone-storm = synlig
// "hackighet" vid varje wave-start). Med 4 spawns/tick × ~30 Hz = 5-6 ticks
// (~170-200ms) för en hel wave — för spelaren känns det fortfarande som en
// "wave-burst" men CPU-spiken är spridd över ~6 frames istället för 1.
const WAVE_SPAWNS_PER_TICK = 4;

function updateWaves(state, side, dt) {
  const w = side.wave;
  // Slut: efter wave 50 + alla döda, inga fler waves
  if (w.current >= MAX_WAVES && !w.active) return;
  // Decision 105: tickar bara ner till nästa wave om vi INTE väntar på motståndaren.
  if (!w.active && !w.waveReady) {
    w.betweenTimer = Math.max(0, w.betweenTimer - dt);
    if (w.betweenTimer <= 0 && w.current < MAX_WAVES) {
      w.current += 1;
      const def = getWaveDef(w.current);
      if (!def) { w.active = false; return; }   // defensive: never deref a missing wave def (user 2026-06-25)
      w.name = def.name;
      w.isBoss = def.isBoss;
      w.active = true;
      w.bannerPulse = (w.bannerPulse || 0) + 1;
      enqueueWaveSpawn(state, side, def);
    }
  }
  // Process pending spawn-tasks (max N per tick = stagger CPU + mesh-creation)
  if (w.spawnQueue && w.spawnQueue.length > 0) {
    let spawned = 0;
    while (w.spawnQueue.length > 0 && spawned < WAVE_SPAWNS_PER_TICK) {
      const task = w.spawnQueue.shift();
      if (task.kind === 'monster') {
        spawnMonsterFromDef(state, side, task.lane, task.def, task.pos, task.atkType);
      } else if (task.kind === 'miniboss') {
        spawnMinibossFromDef(state, side, task.mb);
      } else if (task.kind === 'boss') {
        spawnMonsterFromDef(state, side, 1, task.def, null, 'melee');
      }
      spawned++;
    }
  }
  // Wave aktiv tills alla monsters borta OCH inga pending spawns kvar
  if (w.active && side.monsters.length === 0 && (!w.spawnQueue || w.spawnQueue.length === 0)) {
    w.active = false;
    w.waveReady = true;           // decision 105: vänta tills motståndaren också är klar
    // betweenTimer sätts först när BÅDA sidor är klara (syncWaves)
  }
}

// Decision 105: när BÅDA sidor avslutat sin wave, starta countdown till nästa wave
// samtidigt på båda sidor (så de förblir synkade hela matchen).
function syncWaves(sides) {
  const w1 = sides[1] && sides[1].wave;
  const w2 = sides[2] && sides[2].wave;
  // Defensiv: om en sida saknas behandla den som "klar" så waves inte fastnar.
  if (w1 && w1.waveReady && (!w2 || w2.waveReady)) {
    w1.betweenTimer = WAVE_GAP_TIME;
    w1.waveReady = false;
    if (w2) { w2.betweenTimer = WAVE_GAP_TIME; w2.waveReady = false; }
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

// Bygger spawn-queue för wave istället för att spawna allt direkt.
// updateWaves processar 4 spawns/tick → wave fyrar av över ~5 ticks
// (170ms) istället för 1 tick (33ms) → mycket mindre CPU/render-spike.
function enqueueWaveSpawn(state, side, def) {
  const w = side.wave;
  w.spawnQueue = w.spawnQueue || [];
  if (def.isBoss) {
    w.spawnQueue.push({ kind: 'boss', def });
    return;
  }
  const cfg = SIDE_CFG[side.idx];
  // Vävt: lane 1 + lane 2 alternerat så båda lanes börjar fyllas direkt
  // (annars: lane 1 fylls helt först, lane 2 sist → asymmetrisk lookout).
  const laneQueues = { 1: [], 2: [] };
  for (const lane of [1, 2]) {
    const positions = clumpPositions(cfg.spawnX, cfg.laneZ[lane], WAVE_COUNT_PER_LANE);
    let melee, range;
    if (def.waveType === 'range') { melee = 0; range = WAVE_COUNT_PER_LANE; }
    else if (def.waveType === 'mix') { melee = Math.ceil(WAVE_COUNT_PER_LANE / 2); range = WAVE_COUNT_PER_LANE - melee; }
    else { melee = WAVE_COUNT_PER_LANE; range = 0; }
    for (let i = 0; i < melee; i++) laneQueues[lane].push({ kind: 'monster', lane, def, pos: positions[i], atkType: 'melee' });
    for (let j = 0; j < range; j++) laneQueues[lane].push({ kind: 'monster', lane, def, pos: positions[melee + j], atkType: 'range' });
  }
  // Interleave: pop alternerande från lane 1 + 2
  while (laneQueues[1].length || laneQueues[2].length) {
    if (laneQueues[1].length) w.spawnQueue.push(laneQueues[1].shift());
    if (laneQueues[2].length) w.spawnQueue.push(laneQueues[2].shift());
  }
  // Mini-boss spawnas sist (efter alla vanliga monsters) i lane 1
  if (def.minibossDef) {
    w.spawnQueue.push({ kind: 'miniboss', mb: def.minibossDef });
  }
}

function spawnMinibossFromDef(state, side, mb) {
  const cfg = SIDE_CFG[side.idx];
  side.monsters.push({
    id: state.nextEntityId++,
    x: cfg.spawnX, z: cfg.laneZ[1],
    ry: 0, lane: 1,
    hp: mb.hp, maxHp: mb.hp,
    speed: mb.speed,
    damage: mb.dmg,
    attackType: 'melee',
    attackRange: 1.4,
    attackInterval: MONSTER_MELEE_INTERVAL,
    pathIndex: 0,
    atkCd: 0, slowTime: 0, slowMul: 1.0, chasing: false,
    aac: 0,
    projTime: 0,
    isBoss: false,
    isMiniBoss: true,
    bossName: mb.name,
    bossSkills: [mb.skill],
    skillCds: [mb.skill.cd * 0.5],
    activeCast: null,
    multiCircleQueue: null,
  });
}

function spawnMonsterFromDef(state, side, lane, def, pos, attackType) {
  const cfg = SIDE_CFG[side.idx];
  const x = pos ? pos.x : cfg.spawnX;
  const z = pos ? pos.z : cfg.laneZ[lane];
  const isRange = attackType === 'range';
  const hp = isRange ? Math.round(def.monsterHp * RANGE_MONSTER_HP_RATIO) : def.monsterHp;
  const speed = isRange ? def.monsterSpeed * RANGE_MONSTER_SPEED_RATIO : def.monsterSpeed;
  // Variera projektil-travel-time per range-monster så hjälten ser olika hot.
  const projTime = isRange
    ? MONSTER_PROJ_TIME_BUCKETS[state.nextEntityId % MONSTER_PROJ_TIME_BUCKETS.length]
    : 0;
  // Per-tier projektil-utseende (Goblin→arrow, Ork→axe, Vandöd→darkOrb, Demon→fireball, Drakätt→dragonBolt)
  const tierIdx = def && def.number ? Math.min(4, Math.floor((def.number - 1) / 10)) : 0;
  const projKind = isRange ? (MONSTER_PROJ_KIND_PER_TIER[tierIdx] || 'arrow') : null;
  const monster = {
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
    projTime,
    projKind,
    pathIndex: 0,
    atkCd: 0, slowTime: 0, slowMul: 1.0, chasing: false,
    aac: 0,
    isBoss: !!def.isBoss,
  };
  // Boss-skill-state: bossen castar telegraph→execute via tickBossSkillsServer.
  if (def.isBoss && def.bossDef && def.bossDef.skills) {
    monster.bossSkills = def.bossDef.skills;
    monster.bossName = def.bossDef.name;
    monster.skillCds = def.bossDef.skills.map(s => s.cd * 0.4);   // första cast snabbare
    monster.activeCast = null;
    monster.multiCircleQueue = null;   // för multiCircle-skills (sequence av AoE)
    monster.bossTier = Math.max(1, Math.min(5, Math.floor(def.number / 10)));   // 1..5 för klient-FX-färg
    // Bossar med BOSS_RANGE_AA-entry blir range med projektil-AA istället för melee.
    // Coolare kind + längre range så bossens AA syns tydligt.
    const bossAa = BOSS_RANGE_AA[def.number];
    if (bossAa) {
      monster.attackType = 'range';
      monster.attackRange = bossAa.range;
      monster.attackInterval = bossAa.interval;
      monster.projTime = bossAa.travel;
      monster.projKind = bossAa.kind;
    }
    // Melee-bossar med extended range (t.ex. Demon Prince +30%).
    const meleeOverride = BOSS_MELEE_RANGE[def.number];
    if (meleeOverride && !bossAa) {
      monster.attackRange = meleeOverride;
    }
  }
  side.monsters.push(monster);
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
    // Gandulf Soul Mark DoT — 5% current HP/sek + healar caster 10% max HP/sek
    if (m.gandulfMarkRemaining > 0) {
      tickGandulfMark(state, m, dt);
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
    // Legolus i Shadow Volley-invis + Kostefo INOM Cannabis Cloud — båda gör hero
    // osynlig för fiender. Invis trumfar taunt (assassin-mekanik). Kostefo förlorar
    // invis så fort han kliver ut ur molnet (kostefoInCloud återställs i tick).
    const heroVisible = heroAlive
      && !((side.nyroInvisRemaining || 0) > 0)
      && !side.kostefoInCloud;
    if (!heroVisible) m.chasing = false;
    else if (!m.chasing && distHero < MONSTER_AGGRO_RANGE) m.chasing = true;
    else if (m.chasing && distHero > MONSTER_LEASH_RANGE) m.chasing = false;
    m.atkCd = Math.max(0, m.atkCd - dt);
    // Lvl-5 attack-speed-slow tick (Gandulf Frost Nova lvl5 etc)
    if ((m.aSlowTime || 0) > 0) {
      m.aSlowTime -= dt;
      if (m.aSlowTime <= 0) m.aSlowMul = 1;
    }
    // Lvl-5 Legolas mark tick
    if ((m.nyroMarked || 0) > 0) m.nyroMarked = Math.max(0, m.nyroMarked - dt);
    const atkRange = m.attackRange || 1.2;
    const atkInterval = m.attackInterval || MONSTER_MELEE_INTERVAL;
    // Minion melee wind-up resolve: skadan landar MINION_MELEE_WINDUP sek efter slaget,
    // och bara om hjälten FORTFARANDE är i range (nuvarande positioner) → springer du ur
    // melee-range hinner du undan. (Bossar går aldrig denna väg — de träffar direkt.)
    if ((m.meleeWindup || 0) > 0) {
      m.meleeWindup -= dt;
      if (m.meleeWindup <= 0) {
        const wdx = heroX - m.x, wdz = heroZ - m.z;
        if (heroAlive && (wdx * wdx + wdz * wdz) <= atkRange * atkRange) damageHero(side, m.meleeDmg || MONSTER_MELEE_DAMAGE);
      }
    }
    if (heroVisible && distHero < atkRange && m.atkCd <= 0) {
      m.aac = (m.aac || 0) + 1;          // triggar attack-animation på klient (delta)
      m.ry = Math.atan2(dxh, dzh);       // vänd mot målet vid AA
      // Range-monster (inkl. range-bossar): damage tillämpas vid projektil-impact.
      if (m.attackType === 'range') {
        spawnMonsterProjectile(state, side, m);
      } else if (m.isBoss || m.isMiniBoss) {
        bossAaDamageHero(side, m.damage || MONSTER_MELEE_DAMAGE);   // bossar/mini-bossar: direkt (AA-cap mot one-shot)
      } else {
        m.meleeWindup = MINION_MELEE_WINDUP;                  // minion: wind-up + range-recheck
        m.meleeDmg = m.damage || MONSTER_MELEE_DAMAGE;
      }
      m.atkCd = atkInterval / (m.aSlowMul || 1);
    }
    if (!m.chasing && opp) {
      // Find-nearest med sqr-dist (sparar sqrt × N creeps per monster per tick)
      let nearest = null, bestDistSq = CREEP_VS_CREEP_RANGE * CREEP_VS_CREEP_RANGE;
      const creeps = opp.playerCreeps;
      for (let pi = 0; pi < creeps.length; pi++) {
        const pc = creeps[pi];
        const dx = pc.x - m.x, dz = pc.z - m.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestDistSq) { bestDistSq = d2; nearest = pc; }
      }
      if (nearest) {
        if (m.atkCd <= 0) {
          m.aac = (m.aac || 0) + 1;     // triggar attack-animation även mot creeps
          nearest.hp -= CREEP_VS_CREEP_DAMAGE;
          m.atkCd = CREEP_VS_CREEP_INTERVAL / (m.aSlowMul || 1);
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
    if (m.dmgTakenDebuffTime > 0) {
      m.dmgTakenDebuffTime -= dt;
      if (m.dmgTakenDebuffTime <= 0) m.dmgTakenDebuffMul = 1;
    }
    const step = m.speed * (m.slowMul || 1.0) * dt;
    const nx = m.x + dirX * step, nz = m.z + dirZ * step;
    if (isCreepPos(nx, nz)) { m.x = nx; m.z = nz; }
    else if (isCreepPos(nx, m.z)) m.x = nx;
    else if (isCreepPos(m.x, nz)) m.z = nz;
    m.ry = Math.atan2(dirX, dirZ);
    // Boss-skill-tick (server-auth för line wars)
    if (m.bossSkills) tickBossSkillsServer(state, side, m, dt);
  }
}

// ============================================================
// BOSS SKILL-SYSTEM SERVER-SIDE (för line wars, server-auth)
// Telegraph → execute. Klient renderar telegraph-mesh från broadcastad
// activeCast så heroes kan dodga ut ur damage-zonen.
// ============================================================
function tickBossSkillsServer(state, side, m, dt) {
  if (m.hp <= 0) { m.activeCast = null; m.multiCircleQueue = null; return; }
  // Tick CDs
  if (m.skillCds) for (let i = 0; i < m.skillCds.length; i++) m.skillCds[i] = Math.max(0, m.skillCds[i] - dt);
  // Multi-circle queue (earthquake, meteorShower, skyfireRain): sekvens av AoE-impacts
  if (m.multiCircleQueue) tickMultiCircleQueue(state, side, m, dt);
  // Aktiv cast (telegraph → execute)
  if (m.activeCast) {
    const cast = m.activeCast;
    cast.timer -= dt;
    if (cast.phase === 'telegraph' && cast.timer <= 0) {
      bossExecuteSkill(state, side, m, cast);
      // Sustained skills (sweepBeam, sustainedCone) tickas i execute-fas; övriga avslutas direkt
      if (cast.phase !== 'execute') m.activeCast = null;
    } else if (cast.phase === 'execute') {
      tickBossExecutePhase(state, side, m, cast, dt);
      if (cast.timer <= 0) m.activeCast = null;
    }
    return;
  }
  // Välj ny skill om någon är ready
  if (!m.bossSkills || !m.skillCds) return;
  const ready = [];
  for (let i = 0; i < m.skillCds.length; i++) if (m.skillCds[i] <= 0) ready.push(i);
  if (ready.length === 0) return;
  const pick = ready[Math.floor(Math.random() * ready.length)];
  const skill = m.bossSkills[pick];
  m.skillCds[pick] = skill.cd;
  startBossCastServer(state, side, m, skill);
}

function startBossCastServer(state, side, m, skill) {
  // Räkna ut target-position + direction beroende på skill-type
  const hero = side.hero;
  let originX = m.x, originZ = m.z;
  let targetX, targetZ, dirX, dirZ;
  // Legolus i Shadow Volley-invis + Kostefo INOM Cannabis Cloud: boss kan inte se
  // honom → casta i statisk standardriktning (lätt att undvika, men kan träffa).
  const heroHidden = ((side.nyroInvisRemaining || 0) > 0) || !!side.kostefoInCloud;
  if (skill.originSelf) {
    targetX = m.x; targetZ = m.z;
  } else if (skill.targetHero && hero && !hero.dead && !heroHidden) {
    targetX = hero.x; targetZ = hero.z;
  } else if (heroHidden) {
    dirX = 1; dirZ = 0;
    targetX = m.x + (skill.length || skill.range || skill.radius || 5); targetZ = m.z;
  } else {
    // Cone/line/projectile: rikta mot hero
    if (hero && !hero.dead) {
      const dx = hero.x - m.x, dz = hero.z - m.z;
      const d = Math.hypot(dx, dz) || 1;
      dirX = dx / d; dirZ = dz / d;
      targetX = m.x + dirX * (skill.length || skill.range || skill.radius || 5);
      targetZ = m.z + dirZ * (skill.length || skill.range || skill.radius || 5);
    } else {
      dirX = 1; dirZ = 0;
      targetX = m.x + 5; targetZ = m.z;
    }
  }
  m.activeCast = {
    skill,
    phase: 'telegraph',
    timer: skill.telegraph,
    telegraphTotal: skill.telegraph,
    originX, originZ,
    targetX, targetZ,
    dirX: dirX || 0, dirZ: dirZ || 1,
    sweepStartAngle: 0,
    tickAccum: 0,
  };
  // Trigga attack-animation även på skill-cast (boss kanske aldrig är i AA-range)
  m.aac = (m.aac || 0) + 1;
}

function bossExecuteSkill(state, side, m, cast) {
  const skill = cast.skill;
  const dmg = (m.damage || 10) * (skill.dmgMul || 1);
  const dpsDmg = (m.damage || 10) * (skill.dpsMul || 0);
  const kind = skill.kind;
  if (kind === 'groundCircle') {
    bossApplyAoE(state, side, cast.targetX, cast.targetZ, skill.radius, dmg, skill);
  } else if (kind === 'cone') {
    bossApplyCone(state, side, cast.originX, cast.originZ, cast.dirX, cast.dirZ, skill.length, skill.halfAngle, dmg, skill);
  } else if (kind === 'lineDash') {
    // Dasha boss + skada längs linjen
    const newX = cast.originX + cast.dirX * skill.length;
    const newZ = cast.originZ + cast.dirZ * skill.length;
    bossApplyLine(state, side, cast.originX, cast.originZ, newX, newZ, skill.width / 2, dmg, skill);
    m.x = newX; m.z = newZ;
  } else if (kind === 'projectile') {
    spawnBossProjectile(state, side, m, cast.originX, cast.originZ, cast.dirX, cast.dirZ, skill.speed, skill.range, skill.radius, dmg, skill);
  } else if (kind === 'projectileMulti') {
    const baseAng = Math.atan2(cast.dirX, cast.dirZ);
    for (let i = 0; i < skill.count; i++) {
      const t = skill.count === 1 ? 0 : (i / (skill.count - 1)) - 0.5;
      const ang = baseAng + t * skill.spreadAngle;
      const dx = Math.sin(ang), dz = Math.cos(ang);
      spawnBossProjectile(state, side, m, cast.originX, cast.originZ, dx, dz, skill.speed, skill.range, skill.radius, dmg, skill);
    }
  } else if (kind === 'multiCircle') {
    // Starta queue: spawnar skill.count AoE-circlar över skill.count * spawnInterval sek
    const positions = [];
    for (let i = 0; i < skill.count; i++) {
      const ang = (i / skill.count) * Math.PI * 2 + Math.random() * 0.5;
      const r = Math.random() * skill.spread;
      positions.push({ x: m.x + Math.cos(ang) * r, z: m.z + Math.sin(ang) * r });
    }
    m.multiCircleQueue = { positions, spawnInterval: skill.spawnInterval, nextSpawnIn: 0, idx: 0, radius: skill.radius, dmg, skill };
  } else if (kind === 'poolDot') {
    // DoT-pool vid target-pos
    side.bossPools = side.bossPools || [];
    side.bossPools.push({
      id: state.nextEntityId++,
      x: cast.targetX, z: cast.targetZ,
      radius: skill.radius,
      duration: skill.duration, life: skill.duration,
      dps: dpsDmg, tickAccum: 0,
      slow: skill.slow,
    });
  } else if (kind === 'sweepBeam') {
    // Sustained roterande beam — tick i execute-phase
    cast.phase = 'execute';
    cast.timer = skill.sweepDuration;
    cast.sweepStartAngle = Math.atan2(cast.dirX, cast.dirZ);
    cast.sweepDmg = dpsDmg;
  } else if (kind === 'sustainedCone') {
    // Sustained dragon breath — tick damage i kon
    cast.phase = 'execute';
    cast.timer = skill.sustainDuration;
    cast.sustainDmg = dpsDmg;
  }
}

function tickBossExecutePhase(state, side, m, cast, dt) {
  const skill = cast.skill;
  cast.tickAccum = (cast.tickAccum || 0) + dt;
  // Tick damage var 0.25s under sustained execute
  if (cast.tickAccum < 0.25) return;
  const tickDmg = (cast.sweepDmg || cast.sustainDmg || 0) * cast.tickAccum;
  cast.tickAccum = 0;
  if (skill.kind === 'sweepBeam') {
    // Rotera dir över sweep-duration (90° vänster → 90° höger)
    const total = skill.sweepDuration;
    const elapsed = total - cast.timer;
    const sweepAng = cast.sweepStartAngle + (elapsed / total - 0.5) * Math.PI;
    const dx = Math.sin(sweepAng), dz = Math.cos(sweepAng);
    bossApplyCone(state, side, m.x, m.z, dx, dz, skill.length, skill.halfAngle, tickDmg, skill);
  } else if (skill.kind === 'sustainedCone') {
    bossApplyCone(state, side, m.x, m.z, cast.dirX, cast.dirZ, skill.length, skill.halfAngle, tickDmg, skill);
  }
}

function tickMultiCircleQueue(state, side, m, dt) {
  const q = m.multiCircleQueue;
  if (!q) return;
  q.nextSpawnIn -= dt;
  while (q.nextSpawnIn <= 0 && q.idx < q.positions.length) {
    const p = q.positions[q.idx++];
    bossApplyAoE(state, side, p.x, p.z, q.radius, q.dmg, q.skill);
    q.nextSpawnIn += q.spawnInterval;
  }
  if (q.idx >= q.positions.length) m.multiCircleQueue = null;
}

// Anti-one-shot (user 2026-06-16): en boss-SKILL kan aldrig ta mer än 50% av hjältens
// maxHP i en enda träff. Squishies (Nyro/Zyro/Kostef) överlever då alltid 1 telegraf-nuke
// men dör på 2 utan heal/dodge → bossar förblir farliga men inte instant-dödande.
const BOSS_HERO_MAX_HIT_FRAC = 0.5;
function bossDamageHero(side, dmg) {
  damageHero(side, Math.min(dmg, side.hero.maxHp * BOSS_HERO_MAX_HIT_FRAC));
}
// Anti-one-shot för boss AUTO-ATTACKS (user 2026-06-23: bossar 1-shottade heroes). En boss-AA
// (melee + range-projektil) får aldrig ta mer än 20% maxHP per träff → AA är chip-skada, döden
// kommer från mekanik/för många skills, inte ett enda slag. Bara reducerande (Math.min) → minions
// (som slår < 20%) är opåverkade.
const BOSS_HERO_AA_MAX_HIT_FRAC = 0.20;
function bossAaDamageHero(heroSide, dmg) {
  if (!heroSide || !heroSide.hero) return;
  damageHero(heroSide, Math.min(dmg, heroSide.hero.maxHp * BOSS_HERO_AA_MAX_HIT_FRAC));
}

function bossApplyAoE(state, side, cx, cz, radius, dmg, skill) {
  const r2 = radius * radius;
  // Hero (target i line wars: side.hero är den vars torn bossen attackerar)
  if (!side.hero.dead) {
    const dx = side.hero.x - cx, dz = side.hero.z - cz;
    if (dx * dx + dz * dz < r2) {
      bossDamageHero(side, dmg);
      if (skill.slow && !side.hero.dead) {
        side.heroSlowMul = Math.min(side.heroSlowMul || 1, skill.slow.mul);
        side.heroSlowTime = Math.max(side.heroSlowTime || 0, skill.slow.dur);
      }
      if (skill.knockback && !side.hero.dead) {
        const d = Math.hypot(dx, dz) || 1;
        side.hero.x += (dx / d) * skill.knockback;
        side.hero.z += (dz / d) * skill.knockback;
      }
    }
  }
  // Boss-skills fokuserar bara på hero (dodgeable design). Invaderande creeps
  // hanteras separat av reguljär monster-AA i updateMonsters.
}

function bossApplyCone(state, side, cx, cz, dx, dz, length, halfAngle, dmg, skill) {
  if (!side.hero.dead) {
    const ddx = side.hero.x - cx, ddz = side.hero.z - cz;
    const d = Math.hypot(ddx, ddz);
    if (d > 0.01 && d < length) {
      const dot = (ddx * dx + ddz * dz) / d;
      const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (ang < halfAngle) {
        bossDamageHero(side, dmg);
      }
    }
  }
}

function bossApplyLine(state, side, x1, z1, x2, z2, halfWidth, dmg, skill) {
  if (side.hero.dead) return;
  // Punkt-till-segment-avstånd
  const dx = x2 - x1, dz = z2 - z1;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 0.01) return;
  const t = Math.max(0, Math.min(1, ((side.hero.x - x1) * dx + (side.hero.z - z1) * dz) / lenSq));
  const cx = x1 + t * dx, cz = z1 + t * dz;
  const distSq = (side.hero.x - cx) ** 2 + (side.hero.z - cz) ** 2;
  if (distSq < halfWidth * halfWidth) bossDamageHero(side, dmg);
}

// Boss-skill-projektil. Kind per skill — så Captain's throwingAxe ser ut som en
// stridyxa, Generals spearVolley som blixtspjut etc. Default 'bossDefault' = stor orange orb.
const BOSS_SKILL_PROJ_KIND = {
  throwingAxe: 'bossAxe',
  spearVolley: 'bossSpear',
  // (resterande boss-skills är inte projectile-kind)
};
function spawnBossProjectile(state, side, m, x, z, dx, dz, speed, range, radius, dmg, skill) {
  side.bossProjectiles = side.bossProjectiles || [];
  side.bossProjectiles.push({
    id: state.nextEntityId++,
    x, z, dx, dz,
    speed, range, traveled: 0,
    radius, dmg, skill,
    kind: (skill && BOSS_SKILL_PROJ_KIND[skill.id]) || 'bossDefault',
  });
}

function updateBossProjectiles(state, side, dt) {
  if (!side.bossProjectiles || side.bossProjectiles.length === 0) return;
  for (let i = side.bossProjectiles.length - 1; i >= 0; i--) {
    const p = side.bossProjectiles[i];
    const step = p.speed * dt;
    p.x += p.dx * step; p.z += p.dz * step; p.traveled += step;
    // Träff på hero?
    if (!side.hero.dead) {
      const ddx = side.hero.x - p.x, ddz = side.hero.z - p.z;
      if (ddx * ddx + ddz * ddz < p.radius * p.radius) {
        bossDamageHero(side, p.dmg);   // anti-one-shot cap (boss-skill-projektil)
        side.bossProjectiles.splice(i, 1);
        continue;
      }
    }
    if (p.traveled > p.range) side.bossProjectiles.splice(i, 1);
  }
}

function updateBossPools(state, side, dt) {
  if (!side.bossPools || side.bossPools.length === 0) return;
  for (let i = side.bossPools.length - 1; i >= 0; i--) {
    const p = side.bossPools[i];
    p.life -= dt;
    p.tickAccum += dt;
    if (p.tickAccum >= 0.5) {
      p.tickAccum = 0;
      if (!side.hero.dead) {
        const dx = side.hero.x - p.x, dz = side.hero.z - p.z;
        if (dx * dx + dz * dz < p.radius * p.radius) {
          damageHero(side, p.dps * 0.5);
          if (p.slow) {
            side.heroSlowMul = Math.min(side.heroSlowMul || 1, p.slow.mul);
            side.heroSlowTime = Math.max(side.heroSlowTime || 0, p.slow.dur);
          }
        }
      }
    }
    if (p.life <= 0) side.bossPools.splice(i, 1);
  }
}

function updatePlayerCreeps(state, side, opp, dt) {
  const oppCfg = SIDE_CFG[3 - side.idx];
  for (let i = side.playerCreeps.length - 1; i >= 0; i--) {
    const c = side.playerCreeps[i];
    // Wind Puff debuff tick-down
    if (c.dmgTakenDebuffTime > 0) {
      c.dmgTakenDebuffTime -= dt;
      if (c.dmgTakenDebuffTime <= 0) c.dmgTakenDebuffMul = 1;
    }
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
    // Gandulf Soul Mark DoT (klient renderar inte detta direkt — server tickar HP)
    if (c.gandulfMarkRemaining > 0) {
      tickGandulfMark(state, c, dt);
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
    // Minion (creep) melee wind-up resolve vs the defending hero — skadan landar efter
    // wind-up och bara om hjälten fortfarande är i range (springa förbi = miss).
    if ((c.meleeWindup || 0) > 0) {
      c.meleeWindup -= dt;
      if (c.meleeWindup <= 0 && opp && !opp.hero.dead) {
        const wdx = opp.hero.x - c.x, wdz = opp.hero.z - c.z;
        if ((wdx * wdx + wdz * wdz) <= c.range * c.range) damageHero(opp, c.meleeDmg || c.damage);
      }
    }
    // Lvl-5 attack-speed-slow tick (för player-creeps mottagliga för Frost Nova lvl5)
    if ((c.aSlowTime || 0) > 0) {
      c.aSlowTime -= dt;
      if (c.aSlowTime <= 0) c.aSlowMul = 1;
    }
    // MS-slow tick (Aragurn Shout, Kostefo Q lvl5, Gimlu Hammer lvl5 m.fl.)
    if ((c.slowTime || 0) > 0) {
      c.slowTime -= dt;
      if (c.slowTime <= 0) c.slowMul = 1;
    }
    // Lvl-5 Legolas mark tick
    if ((c.nyroMarked || 0) > 0) c.nyroMarked = Math.max(0, c.nyroMarked - dt);
    // Find-nearest med sqr-dist (sparar sqrt per creep × targets per tick)
    let target = null, targetType = null, bestDistSq = c.range * c.range;
    if (tauntActive && opp && !opp.hero.dead) {
      // Tauntad: lås till opp.hero (Gimlu) oavsett avstånd
      target = opp.hero; targetType = 'hero';
      const dxh = opp.hero.x - c.x, dzh = opp.hero.z - c.z;
      bestDistSq = dxh * dxh + dzh * dzh;
    } else {
      if (opp && !opp.hero.dead) {
        const dx = opp.hero.x - c.x, dz = opp.hero.z - c.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestDistSq) { bestDistSq = d2; target = opp.hero; targetType = 'hero'; }
      }
      if (opp) {
        const mons = opp.monsters;
        for (let mi = 0; mi < mons.length; mi++) {
          const m = mons[mi];
          const dx = m.x - c.x, dz = m.z - c.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestDistSq) { bestDistSq = d2; target = m; targetType = 'monster'; }
        }
      }
    }
    if (target) {
      const tx = target.x, tz = target.z;
      c.ry = Math.atan2(tx - c.x, tz - c.z);
      if (c.atkCd <= 0) {
        c.aac = (c.aac || 0) + 1;     // triggar attack-animation på klient (delta)
        if (c.attackType === 'melee') {
          if (targetType === 'hero') { c.meleeWindup = MINION_MELEE_WINDUP; c.meleeDmg = c.damage; } // wind-up + range-recheck
          else {
            target.hp -= c.damage;
            if (target.hp <= 0) killMonster(opp, opp.monsters.indexOf(target), side);
          }
        } else {
          spawnCreepProjectile(state, side, c, target, targetType);
        }
        c.atkCd = c.interval / (c.aSlowMul || 1);
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
    // Slow appliceras via slowMul (sätts av Kostefo Q lvl5 + andra slow-källor).
    // Tick av slowTime/slowMul-reset hanteras tidigare i updatePlayerCreeps.
    const step = c.speed * (c.slowMul || 1) * dt;
    const nx = c.x + dirX * step, nz = c.z + dirZ * step;
    if (isCreepPos(nx, nz)) { c.x = nx; c.z = nz; }
    else if (isCreepPos(nx, c.z)) c.x = nx;
    else if (isCreepPos(c.x, nz)) c.z = nz;
    c.ry = Math.atan2(dirX, dirZ);
  }
}

// Monster-AA-projektil: spawnas av range-monster + range-miniboss + range-boss.
// Damage tillämpas vid IMPACT (timer = 0), inte vid cast. Olika monster har
// olika travel-time (m.projTime, 0.5/1.0/1.5s) så hjälten ser olika hot.
function spawnMonsterProjectile(state, side, m) {
  const travel = m.projTime || 1.0;
  const isBossKind = !!m.isBoss || !!m.isMiniBoss;
  side.monsterProjectiles.push({
    id: state.nextEntityId++,
    x: m.x, y: MONSTER_PROJ_Y, z: m.z,
    srcX: m.x, srcZ: m.z,
    damage: m.damage || MONSTER_MELEE_DAMAGE,
    timer: travel,
    totalTime: travel,
    kind: m.projKind || 'magic',         // styr klient-mesh (arrow/fireball/bossSpear/...)
    isBoss: !!m.isBoss,
    isMiniBoss: !!m.isMiniBoss,
    // Minion-projektiler dör om hjälten är > 2× minionens range från avfyrningspunkten
    // (springer du tillräckligt långt missar skottet). 0 = ingen cap (bossar).
    maxRange: isBossKind ? 0 : (m.attackRange || RANGE_MONSTER_RANGE) * MINION_PROJ_RANGE_MUL,
  });
}

function updateMonsterProjectiles(state, side, dt) {
  if (!side.monsterProjectiles) return;
  for (let i = side.monsterProjectiles.length - 1; i >= 0; i--) {
    const p = side.monsterProjectiles[i];
    // Boss-wars boss-AA homar mot en SPECIFIK hjälte (bossTargetIdx), ej side.hero.
    // bossTargetIdx undefined → klassiskt beteende (side.hero), bakåtkompatibelt.
    const tgt = (p.bossTargetIdx != null) ? state.sides[p.bossTargetIdx] : side;
    // Hjälte död/borta: projektil försvinner utan damage
    if (!tgt || !tgt.hero || tgt.hero.dead) { side.monsterProjectiles.splice(i, 1); continue; }
    // Minion-projektil: fizzlar om hjälten sprungit > 2× range från avfyrningspunkten.
    if (p.maxRange > 0) {
      const ddx = tgt.hero.x - p.srcX, ddz = tgt.hero.z - p.srcZ;
      if (ddx * ddx + ddz * ddz > p.maxRange * p.maxRange) { side.monsterProjectiles.splice(i, 1); continue; }
    }
    p.timer = Math.max(0, p.timer - dt);
    // Lerp position från src till hjältens nuvarande pos så missilen ser ut
    // att tracka målet. (Auto-hit — matchar existerande creepProjectile-mönster.)
    const elapsed = p.totalTime - p.timer;
    const t = p.totalTime > 0 ? Math.min(1, elapsed / p.totalTime) : 1;
    p.x = p.srcX + (tgt.hero.x - p.srcX) * t;
    p.z = p.srcZ + (tgt.hero.z - p.srcZ) * t;
    if (p.timer <= 0) {
      if (p.isBoss2AdProj) applyBoss2AdStackHitEngine(state, tgt);   // boss-2-ad: stacking-slow i st f flat dmg
      else bossAaDamageHero(tgt, p.damage);   // range-AA-cap mot one-shot (no-op för minions, < 20% maxHP)
      side.monsterProjectiles.splice(i, 1);
    }
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
            m.hp -= bossWarsDmgMod(m, p.damage);   // 5%-tak/immunitet/DR (no-op icke-boss)
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
// Wind Puff debuff: tar +20% mer skada i 4s. Applieras av Magiker Q på träffade targets.
// Multipliceras in i alla skill-damage-applications nedan.
function dmgTakenDebuffMul(target) {
  if (!target || !target.dmgTakenDebuffTime || target.dmgTakenDebuffTime <= 0) return 1;
  return target.dmgTakenDebuffMul || 1;
}

function applySkillDamageToMonster(state, side, opp, mIdx, dmg) {
  const m = side.monsters[mIdx];
  if (!m || m.hp <= 0) return;
  // Shatter: om frusen, splittra is och skicka shards
  if ((m.frozenTime || 0) > 0) {
    triggerShatter(state, side, opp, m.x, m.z, side);
    m.frozenTime = 0;
  }
  const finalDmg = bossWarsDmgMod(m, dmg * elarShoutDmgMul(side) * dmgTakenDebuffMul(m));   // boss: fas-immunitet + DR (+E3 shout)
  const actualDealt = Math.min(m.hp, finalDmg);
  m.hp -= finalDmg;
  elarLifestealHeal(side, actualDealt);
  gainUltOnSkillHit(side);
  if (m.hp <= 0) killMonster(side, mIdx, side);
}
function applySkillDamageToCreep(state, attackerSide, oppSide, creep, dmg) {
  if (!creep || creep.hp <= 0) return;
  if ((creep.frozenTime || 0) > 0) {
    triggerShatter(state, oppSide, attackerSide, creep.x, creep.z, attackerSide);
    creep.frozenTime = 0;
  }
  const finalDmg = dmg * elarShoutDmgMul(attackerSide) * dmgTakenDebuffMul(creep);
  const actualDealt = Math.min(creep.hp, finalDmg);
  creep.hp -= finalDmg;
  elarLifestealHeal(attackerSide, actualDealt);
  gainUltOnSkillHit(attackerSide);
}
function applySkillDamageToOppHero(state, side, opp, dmg) {
  if (!opp || opp.hero.dead) return;
  if ((opp.hero.frozenTime || 0) > 0) {
    triggerShatter(state, opp, side, opp.hero.x, opp.hero.z, side);
    opp.hero.frozenTime = 0;
  }
  const finalDmg = dmg * elarShoutDmgMul(side) * dmgTakenDebuffMul(opp.hero);
  const actualDealt = Math.min(opp.hero.hp, finalDmg);
  damageHero(opp, finalDmg);
  elarLifestealHeal(side, actualDealt);
  gainUltOnSkillHit(side);
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
        m.hp -= bossWarsDmgMod(m, SHATTER_DAMAGE);   // 5%-tak/immunitet/DR (no-op icke-boss)
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

// Acquisition range for quick-cast (tap) aim of DIRECTED skills (projectiles/dashes). Generous so
// it always snaps toward the enemy hero across the whole arena (ArenaHalfX*2 ≈ 70); only sets the
// cast DIRECTION (the skill then travels its own distance). 2026-06-22.
const TAP_AIM_RANGE = 80;

// Lös ut cast-mark (x,z) för target-baserade skills (Nova, Black Hole)
function resolveSkillGroundTarget(state, side, opp, ev, defaultDistance) {
  let tx, tz;
  // Quick-cast (tap): sikta automatiskt enligt prioritet 1→2→3.
  if (ev.tap === true) {
    // Prioritet 1: aktuellt auto-attack-target (alltid prioriterat).
    if (side.targetId) {
      const t = resolveTargetEntity(side, opp, state);
      if (t) { tx = t.x; tz = t.z; }
    }
    // Prioritet 2: ingen AA-target → närmaste giltiga fiende inom skill-räckvidd
    // (samma val som auto-attack-acquisition → förutsägbart, mode-medvetet).
    if (tx === undefined) {
      const near = findClosestHostile(side, opp, side.hero.x, side.hero.z, defaultDistance, state);
      if (near && near.entity) { tx = near.entity.x; tz = near.entity.z; }
    }
  }
  // Prioritet 3: ingen tap-target → riktning/facing (drag eller default framåt).
  if (tx === undefined) {
    // Drag: dir × distance × mag (drag-fraktion 0.3..1) från hero.
    // Min-clamp på 0.3 säkerställer att drag aldrig kastar skill ovanpå
    // hero (mag=0 skulle annars ge "exploderar runt heroens kropp"). Tap
    // utan target ger mag=1 = full räckvidd.
    let dx = ev.dx || 0, dz = ev.dz || 0;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) { dx = side.hero.facingX; dz = side.hero.facingZ; }
    else { dx /= len; dz /= len; }
    let mag = (typeof ev.mag === 'number' && Number.isFinite(ev.mag))
      ? Math.min(1, Math.max(0, ev.mag)) : 1;
    if (mag < 0.3) mag = 0.3;
    tx = side.hero.x + dx * defaultDistance * mag;
    tz = side.hero.z + dz * defaultDistance * mag;
  }
  // Clamp till duel-arenan (cirkel vid z=35) så skills inte landar utanför.
  // EJ för arena1v1: den delar duelActive-flaggan men ligger vid z=80 i en stor
  // öppen arena — clampen skulle annars dra varje skill-target till z=35 (~49 enh
  // bort) → skills missar helt. (decision 120: test-fynd 2)
  if (state && state.duelActive && state.mode !== 'arena1v1') {
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

// Hero-vs-hero PvP är aktiv om duel pågår ELLER om någon hero är i fiendens territorium via portal
function isHeroPvpActive(state) {
  if (!state) return false;
  if (state.duelActive) return true;
  const s1 = state.sides && state.sides[1];
  const s2 = state.sides && state.sides[2];
  if (s1 && s1.inEnemyTerritory) return true;
  if (s2 && s2.inEnemyTerritory) return true;
  return false;
}

// Find-closest: kvadrerad distans-jämförelse (undviker sqrt i hot loop).
// Hero AA + skill-target-search kallar denna varje tick × 30 entiteter.
function findClosestHostile(side, opp, x, z, maxDist, state) {
  let best = null, bestDistSq = maxDist * maxDist;
  // Under duel: opp.hero OCH duel-big-orb är giltiga targets
  if (state && state.duelActive) {
    if (opp && !opp.hero.dead) {
      const dx = opp.hero.x - x, dz = opp.hero.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDistSq) { bestDistSq = d2; best = { entity: opp.hero, isMonster: false, isHero: true, targetSideIdx: opp.idx }; }
    }
    if (state.duelBigOrb && state.duelBigOrb.alive) {
      const dx = state.duelBigOrb.x - x, dz = state.duelBigOrb.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDistSq) { bestDistSq = d2; best = { entity: state.duelBigOrb, isMonster: false, isHero: false, isDuelOrb: true }; }
    }
    // Arena1v1: center-orben (state.orb) är också ett giltigt AA-target (mirror klient).
    // Bias mot hero-target (ej mot range-cap) så auto-AA inte siktar fel när båda
    // hjältarna trängs vid mitten där orben står — orben väljs bara om klart närmast.
    if (side.inArena1v1 && state.orb && state.orb.alive) {
      const dx = 0 - x, dz = ARENA1V1_Z - z;
      const d2 = dx * dx + dz * dz;
      const bias = (best && best.isHero) ? ARENA_ORB_AA_BIAS_SQ : 0;
      if (d2 + bias < bestDistSq) { bestDistSq = d2; best = { entity: state.orb, isMonster: false, isArenaOrb: true }; }
    }
    return best;
  }
  // Portal-PvP: opp.hero blir target om någon sida är i fiendens territorium
  if (state && isHeroPvpActive(state) && opp && !opp.hero.dead) {
    const dx = opp.hero.x - x, dz = opp.hero.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestDistSq) { bestDistSq = d2; best = { entity: opp.hero, isMonster: false, isHero: true, targetSideIdx: opp.idx }; }
  }
  for (let i = 0; i < side.monsters.length; i++) {
    const m = side.monsters[i];
    const dx = m.x - x, dz = m.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestDistSq) { bestDistSq = d2; best = { entity: m, isMonster: true }; }
  }
  if (opp) {
    const creeps = opp.playerCreeps;
    for (let i = 0; i < creeps.length; i++) {
      const c = creeps[i];
      const dx = c.x - x, dz = c.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDistSq) { bestDistSq = d2; best = { entity: c, isMonster: false, ownerSide: opp }; }
    }
  }
  return best;
}

// Slå upp target-entitet — kan vara monster/creep/hero (hero under duel).
function resolveTargetEntity(side, opp, state) {
  if (side.targetType === 'hero') {
    if (state && isHeroPvpActive(state) && opp && !opp.hero.dead) return opp.hero;
    return null;
  }
  if (side.targetType === 'duelOrb') {
    if (state && state.duelActive && state.duelBigOrb && state.duelBigOrb.alive) return state.duelBigOrb;
    return null;
  }
  if (side.targetType === 'arenaOrb') {
    // state.orb har x/z-fält (satta i createArenaState) — returnera objektet direkt.
    if (side.inArena1v1 && state && state.orb && state.orb.alive) return state.orb;
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
  let isArenaOrb = side.targetType === 'arenaOrb';
  const baseRange = (side.attackRange || HERO_ATTACK_RANGE) * (side.heroId === 'zheyna' && (side.zheynaWarpathRem || 0) > 0 ? (1 + ZHEYNA_E_RANGE) : 1);
  // Legolus Shadow Volley empowered AA: dubbel range medan invis-ult-pending.
  const ultAaRange = (side.heroId === 'nyro' && side.nyroUltAaPending)
    ? baseRange * LEGOLUS_ULT_AA_RANGE_MUL : baseRange;
  const range = ultAaRange;
  let inRange = false;
  if (target) {
    const dx = target.x - side.hero.x, dz = target.z - side.hero.z;
    const d2 = dx * dx + dz * dz;
    const acquire = range * AA_ACQUIRE_RANGE_MUL;
    if (d2 > acquire * acquire) target = null;   // beyond acquire range → drop the lock
    else inRange = d2 <= range * range;           // within attack range → may fire; else chase toward it
  }
  if (!target) {
    // Manuell AA: ingen auto-pick av nästa target. Target dog eller är out of
    // range → sluta attackera. Användaren måste trycka Attack-knappen igen.
    side.aaActive = false;
    side.targetId = 0; side.targetType = ''; side.targetX = 0; side.targetZ = 0;
    return null;
  }
  side.targetX = target.x;
  side.targetZ = target.z;
  // Återanvänd ett cachat result-objekt per side (undviker ny allokering 30 Hz).
  // Fälten skrivs varje gång → ingen stale-data-risk. Objektet används bara
  // under samma sync-tick av updateHeroAttack (ej async/multi-tick).
  if (!side._aaTarget) side._aaTarget = { entity: null, isMonster: false, isHero: false, isDuelOrb: false, isArenaOrb: false, inRange: false };
  const r = side._aaTarget;
  r.entity = target; r.isMonster = isMonster; r.isHero = isHero; r.isDuelOrb = isDuelOrb; r.isArenaOrb = isArenaOrb;
  r.inRange = inRange;   // false = locked but out of attack range → chase, don't fire
  return r;
}

function updateHeroAttack(state, side, opp, dt) {
  side.attackCd = Math.max(0, side.attackCd - dt);
  side.aaMoveLockTime = Math.max(0, (side.aaMoveLockTime || 0) - dt);   // swing-commit window ticks down
  if (side.hero.dead || !side.aaActive) return;
  // Arena: kan inte auto-attackera medan hard-CC:ad (freeze/stun/ice-block/fear).
  // heroFearTime tillagd (QA 2026-06-17): bot-guards immobiliserar redan vid fear; människo-
  // spelare gjorde det inte → Gimlu Titan's Rage-fear hade ingen effekt på riktiga spelare.
  if ((side.inArena1v1 || side.inBossWars) && ((side.hero.frozenTime || 0) > 0 || (side.iceBlockRemaining || 0) > 0 || (side.heroFearTime || 0) > 0)) return;
  const target = maintainTargetLock(side, opp, state);
  if (!target || side.attackCd > 0 || !target.inRange) return;   // out of attack range → chase (movement loop), don't fire
  side.attackCounter++;
  const isAoE = side.attackCounter % PASSIVE_EVERY === 0;
  const auraDmg = side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1;
  const auraAs = side.heroFountainAura ? FOUNTAIN_AS_MUL : 1;
  // Legolus self-buff aktiv? +10% dmg, +10% crit, +30% crit-dmg
  const buffActive = (side.nyroBuffRemaining || 0) > 0;
  const buffDmgMul = buffActive ? (1 + LEGOLUS_BUFF_DMG_PCT) : 1;
  let critChance = (side.critChancePct || 0) + (buffActive ? LEGOLUS_BUFF_CRIT_PCT : 0);
  let critMulBase = (side.critDmgMul || 2.0) + (buffActive ? LEGOLUS_BUFF_CRIT_DMG_PCT : 0);
  // Xina passive: +15% crit chance, +15% crit damage, +15% lifesteal on crits (lifesteal below).
  if (side.heroId === 'xina') { critChance += 0.15; critMulBase += 0.15; }
  // Legolus dash-buff aktiv? Nästa AA = 100% crit + 20% lifesteal
  const dashBuffed = !!side.nyroDashBuffPending;
  if (dashBuffed) {
    critChance = 1.0;
    side.nyroDashBuffPending = false;
  }
  // Ganji passive "Katana's Slice": full meter → this AA is a guaranteed crit + 50% bonus
  // dmg, then the meter resets. Mirrors the Legolus dash-buff pattern (one empowered AA).
  const ganjiEmpowered = side.heroId === 'ganji' && !!side.ganjiPassiveReady;
  if (ganjiEmpowered) {
    critChance = 1.0;
    side.ganjiPassiveReady = false;
    side.ganjiMeter = 0;
  }
  const isCrit = critChance > 0 && Math.random() < critChance;
  const critMul = isCrit ? critMulBase : 1;
  if (isCrit) side.aaCritFlash = AA_CRIT_FLASH;   // G5: signalera crit till klienten (cri-flagga)
  // Legolus passive: var 3:e AA ger split-buff till nästa AA
  const isLegolusHero = side.heroId === 'nyro';
  const splitNow = isLegolusHero && !!side.nyroSplitPending;
  if (splitNow) side.nyroSplitPending = false;
  // Shadow Volley empowered AA: target.maxHp*25% direct dmg + stun nearby + thorn pool.
  // Pilen revealar Legolus när den skjuts. Override:ar normal dmg-formel.
  const ultAaNow = isLegolusHero && !!side.nyroUltAaPending;
  // Aragurn Berserk (R): +150% AA-dmg + 25% lifesteal under 5s. (AS oförändrad.)
  // Gate på inArena1v1 — berserkRemaining tickas bara ner i arena-loopen; i classic
  // skulle ett oavsiktligt satt fält ge permanent buff.
  const berserkActive = (side.inArena1v1 || side.inBossWars || side.inLineWars) && (side.berserkRemaining || 0) > 0;
  const rageDmgMul = (side.inArena1v1 || side.inBossWars || side.inLineWars) && (side.titansRageTime || 0) > 0 ? (1 + (side.titansRageBuff || 0)) : 1;   // Titan's Rage outgoing-dmg (arena/boss/line wars)
  let aaDmg = side.attackDmg * auraDmg * buffDmgMul * critMul * (berserkActive ? BERSERK_AA_DMG_MUL : 1) * rageDmgMul * (ganjiEmpowered ? GANJI_EMPOWER_DMG_MUL : 1) * elarShoutDmgMul(side) * xinaOutMul(side);
  if (ultAaNow) {
    const tMax = target.entity.maxHp || target.entity.hp || aaDmg;
    aaDmg = tMax * LEGOLUS_ULT_AA_DMG_PCT;
    side.nyroUltAaPending = false;
    side.nyroInvisRemaining = 0;   // reveal direkt vid pil-spawn
  }
  // Zheyna passive Hunter's Reach: distans-skalad AA-dmg + lifesteal (alla lägen).
  // Warpath (E): +1m knockback per AA medan aktiv.
  let zheynaLs = 0, zheynaKnock = 0;
  if (side.heroId === 'zheyna') {
    const _tdx = (target.entity.x || 0) - side.hero.x, _tdz = (target.entity.z || 0) - side.hero.z;
    const _wp = (side.zheynaWarpathRem || 0) > 0;
    const _maxR = (side.attackRange || 7.5) * (_wp ? (1 + ZHEYNA_E_RANGE) : 1);
    const _f = _maxR > 0 ? Math.max(0, Math.min(1, Math.hypot(_tdx, _tdz) / _maxR)) : 0;
    aaDmg *= (1 + ZHEYNA_PASSIVE_DMG_MAX * _f) * (side.zheynaDmgBuffMul || 1);   // passive + Q-stun-buff
    zheynaLs = ZHEYNA_PASSIVE_LS_MAX * _f;
    if (_wp) zheynaKnock = ZHEYNA_E_KNOCKBACK;
  }
  side.projectiles.push({
    id: state.nextEntityId++,
    x: side.hero.x, y: 1.5, z: side.hero.z,
    target: target.entity,
    targetIsMonster: !!target.isMonster,
    targetIsHero: !!target.isHero,
    targetIsDuelOrb: !!target.isDuelOrb,
    targetIsArenaOrb: !!target.isArenaOrb,
    targetSideIdx: target.isHero ? (target.targetSideIdx || (3 - side.idx)) : 0,
    ownerSideIdx: side.idx,
    damage: aaDmg, isAoE, isCrit,
    lifestealRatio: (dashBuffed ? (engineHasTalent(state, side, 'l_dash_buff') ? 0.50 : LEGOLUS_DASH_LIFESTEAL) : (berserkActive ? BERSERK_AA_LIFESTEAL : zheynaLs)) + (side.heroId === 'xina' && isCrit ? 0.15 : 0),   // Xina passive: 15% crit-lifesteal
    knockback: zheynaKnock,
    nyroBuffed: dashBuffed,
    appliesPoison: splitNow,
    nyroUltAa: ultAaNow,             // → vid hit: stun nearby + thorn pool
    ganjiMark: ganjiEmpowered,          // → vid hit: 5% maxHP/s DoT (ej boss) + 20% slow
  });
  // Zheyna Clone: kopierar AA (50% dmg) från klon-position mot samma target.
  if (side.heroId === 'zheyna' && side.zheynaClone) {
    side.projectiles.push({
      id: state.nextEntityId++, x: side.zheynaClone.x, y: 1.2, z: side.zheynaClone.z,
      target: target.entity, targetIsMonster: !!target.isMonster, targetIsHero: !!target.isHero,
      targetIsDuelOrb: !!target.isDuelOrb, targetIsArenaOrb: !!target.isArenaOrb,
      targetSideIdx: target.isHero ? (target.targetSideIdx || (3 - side.idx)) : 0, ownerSideIdx: side.idx,
      damage: aaDmg * ZHEYNA_CLONE_DMG_MUL, isAoE: false, isCrit,
      lifestealRatio: 0, knockback: 0, nyroBuffed: false, appliesPoison: false,
    });
  }
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
        nyroBuffed: false,
        appliesPoison: true,
      });
    }
  }
  // Stega passive-räknaren efter att split konsumerats. Var 3:e AA → split-buff till nästa.
  if (isLegolusHero) {
    side.nyroAaCounter = (side.nyroAaCounter || 0) + 1;
    if (side.nyroAaCounter % LEGOLUS_PASSIVE_EVERY === 0) {
      side.nyroSplitPending = true;
    }
    // Hunter's Focus lvl5: -0.3s dash-CD per successful AA medan F-buff aktiv
    if ((side.nyroBuffRemaining || 0) > 0 && (side.skillLvl && side.skillLvl.f >= SKILL_LEVEL_MAX)) {
      side.skills.e.cd = Math.max(0, side.skills.e.cd - LEGOLAS_LVL5_HF_AA_CDR);
      if ((side.nyroDashStackCd || 0) > 0) {
        side.nyroDashStackCd = Math.max(0, side.nyroDashStackCd - LEGOLAS_LVL5_HF_AA_CDR);
      }
    }
  }
  // Legolas Hunter's Focus (F-buff): +30% attack speed under buff-duration
  const focusAsMul = (side.nyroBuffRemaining || 0) > 0 ? (1 + LEGOLUS_BUFF_AS_PCT) : 1;
  // Kostefo Cannabis Cloud: +20% AS medan hero ÄR inom molnet
  const cloudAsMul = side.kostefoInCloud ? (1 + KOSTEFO_CLOUD_AS_BONUS) : 1;
  // Aragurn banner-aura (Hero Leap lvl5): +10% AS
  const bannerAsMul = side.inAragurnBanner ? (1 + ARAGURN_LVL5_BANNER_AS_BONUS) : 1;
  const interval = side.attackInterval || HERO_ATTACK_INTERVAL;
  const warpathAsMul = (side.zheynaWarpathRem || 0) > 0 ? (1 + ZHEYNA_E_AS) : 1;
  // Kryx-rework: Titan's Stomp AS-slow på hjälte (<1 → långsammare). Rage-AS-buff folds in i batch 2.
  const kryxAsSlowMul = (side.heroASlowTime || 0) > 0 ? (side.heroASlowMul || 1) : 1;
  const rageAsMul = (side.inArena1v1 || side.inBossWars) && (side.titansRageTime || 0) > 0 ? (1 + (side.titansRageBuff || 0)) : 1;   // Titan's Rage AS-buff (arena/bosswars only)
  side.attackCd = interval / ((side.attackSpeedMul || 1) * auraAs * focusAsMul * cloudAsMul * bannerAsMul * warpathAsMul * kryxAsSlowMul * rageAsMul * xinaAttackSpeedMul(side));
  // Face the target and commit to the swing: the hero stops to attack (can't run + AA at once).
  // Lock scales with the just-computed interval → faster attack speed = shorter stop.
  { const _fx = target.entity.x - side.hero.x, _fz = target.entity.z - side.hero.z, _fd = Math.hypot(_fx, _fz) || 1;
    side.hero.facingX = _fx / _fd; side.hero.facingZ = _fz / _fd; }
  side.aaMoveLockTime = side.attackCd * AA_MOVE_LOCK_FRAC;
  // One-shot per tap (user 2026-06-20 v2): a manual ATK press fires exactly ONE AA, then stops —
  // holding does nothing extra, you tap again to keep attacking. Target fields are left intact so
  // this fire's snapshot still carries tx/tz for the projectile visual; maintainTargetLock returns
  // null next tick (aaActive=false) so it won't re-fire. Bots re-arm through their own `!side.aaActive`
  // gate every tick, so AI auto-attacks stay continuous; only human taps are one-shot.
  side.aaActive = false;
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
    } else if (p.targetIsArenaOrb) {
      targetAlive = state.orb && state.orb.alive;
      tp = targetAlive ? state.orb : null;  // state.orb har x/z-fält — undviker ny allokering
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
      // Ganji passive "Katana's Slice"-märke: slow alla, DoT på allt utom boss.
      if (p.ganjiMark) {
        if (p.targetIsHero) {
          const ts = state.sides[p.targetSideIdx];
          if (ts && !ts.hero.dead) {
            ts.heroSlowMul = Math.min(ts.heroSlowMul == null ? 1 : ts.heroSlowMul, GANJI_MARK_SLOW_MUL);
            ts.heroSlowTime = Math.max(ts.heroSlowTime || 0, GANJI_MARK_DUR);
            ts.heroASlowMul = Math.min(ts.heroASlowMul == null ? 1 : ts.heroASlowMul, GANJI_MARK_SLOW_MUL);
            ts.heroASlowTime = Math.max(ts.heroASlowTime || 0, GANJI_MARK_DUR);
            ts.hero.dotRemaining = GANJI_MARK_DUR; ts.hero.dotPerSec = ts.hero.maxHp * GANJI_MARK_DOT_PCT;
          }
        } else if (p.targetIsMonster && tp) {
          applyGanjiSlow(tp);
          if (!tp.isBossWarsBoss) { tp.dotRemaining = GANJI_MARK_DUR; tp.dotPerSec = (tp.maxHp || tp.hp) * GANJI_MARK_DOT_PCT; }
        } else if (!p.targetIsDuelOrb && !p.targetIsArenaOrb && tp) { // playerCreep
          applyGanjiSlow(tp);
          tp.dotRemaining = GANJI_MARK_DUR; tp.dotPerSec = (tp.maxHp || tp.hp) * GANJI_MARK_DOT_PCT;
        }
      }
      let aaDmgDealt = 0;   // För Aragurn-passive lifesteal — räkna utdelad AA-skada
      // Lvl-5 Legolas Vine Trap mark: +20% dmg på marked targets (bara primär hit)
      const _primaryTarget = p.targetIsHero ? (state.sides[p.targetSideIdx] ? state.sides[p.targetSideIdx].hero : null) : ((p.targetIsDuelOrb || p.targetIsArenaOrb) ? null : p.target);
      const _primaryDmg = p.damage * nyroMarkMul(side, _primaryTarget);
      if (p.targetIsHero) {
        const ts = state.sides[p.targetSideIdx];
        // Xina Ninja's Cloak: 50% evasion mot auto-attacks → dodge (ingen skada/lifesteal).
        const dodged = ts && !ts.hero.dead && (ts.xinaCloakRem || 0) > 0 && Math.random() < XINA_CLOAK_EVASION;
        if (!dodged) {
          if (ts) aaDmgDealt = Math.min(ts.hero.hp, _primaryDmg);
          damageHero(state.sides[p.targetSideIdx], _primaryDmg, true);   // isAaDamage=true → kringgår Xina skill-DR
          if (state.sides[p.targetSideIdx] && state.sides[p.targetSideIdx].hero.dead) killedTarget = true;
        }
      } else if (p.targetIsDuelOrb) {
        const orb = state.duelBigOrb;
        if (orb && orb.alive) {
          damageDuelBigOrb(state, _primaryDmg, p.ownerSideIdx || side.idx);
          if (!orb.alive) killedTarget = true;
        }
      } else if (p.targetIsArenaOrb) {
        if (state.orb && state.orb.alive) {
          damageArenaOrbServer(state, _primaryDmg, p.ownerSideIdx || side.idx);
          if (!state.orb.alive) killedTarget = true;
        }
      } else {
        const _eff = bossWarsDmgMod(p.target, _primaryDmg);   // boss: fas-immunitet + DR (no-op annars)
        aaDmgDealt = Math.min(p.target.hp, _eff);
        p.target.hp -= _eff;
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
      // Zheyna Warpath: knockback target 1m bort från Zheyna (mode-anpassad walkable för heroes).
      if (p.knockback > 0 && tp) {
        const kdx = tp.x - side.hero.x, kdz = tp.z - side.hero.z;
        const km = Math.hypot(kdx, kdz) || 1;
        const knx = tp.x + (kdx / km) * p.knockback, knz = tp.z + (kdz / km) * p.knockback;
        if (p.targetIsHero) {
          const ts = state.sides[p.targetSideIdx];
          if (ts && !ts.hero.dead) {
            const walk = ts.inBossWars ? (x, z) => isBossWarsWalkable(x, z, ts._bwGateClosed)
                       : ts.inArena1v1 ? isArena1v1Walkable
                       : (x, z) => isHeroWalkable(ts.idx, x, z, null);
            if (walk(knx, knz)) { ts.hero.x = knx; ts.hero.z = knz; }
          }
        } else if (p.targetIsMonster && p.target && p.target.hp > 0) {
          p.target.x = knx; p.target.z = knz;
        }
      }
      // Aragurn passive lifesteal: 0.5% per 1% HP loss på AA-damage också
      elarLifestealHeal(side, aaDmgDealt);
      // Boss Wars AA-lifesteal (Phase B): talent Bloodthirst / item Berserker Gauntlet.
      // aaLifestealPct sätts bara för boss-wars-sides → no-op i arena/classic.
      if ((side.aaLifestealPct || 0) > 0 && aaDmgDealt > 0 && !side.hero.dead) {
        side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + aaDmgDealt * side.aaLifestealPct);
      }
      // Ult-energy gain per AA-hit (3%)
      if (aaDmgDealt > 0) gainUltEnergy(side, ULT_GAIN_AA_HIT);
      // Titan's Rage leech: en feared enemy:s utdelade AA-skada healar Kryx i 1s efter fearen.
      if ((side.rageLeechTime || 0) > 0 && aaDmgDealt > 0) {
        const kryx = state.sides[side.rageLeechOwner];
        if (kryx && !kryx.hero.dead) kryx.hero.hp = Math.min(kryx.hero.maxHp, kryx.hero.hp + aaDmgDealt);
      }
      // Legolus dash-buffed AA: 20% lifesteal + reset dash-cd om kill.
      // Gate på aaDmgDealt > 0 → ingen heal mot immun boss (warlord/dragon-mekanik) — annars farm-exploit.
      if (p.lifestealRatio > 0 && aaDmgDealt > 0 && !side.hero.dead) {
        side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + p.damage * p.lifestealRatio);
      }
      if (p.nyroBuffed && killedTarget) {
        side.skills.e.cd = 0;
      }
      if (p.isAoE) {
        for (let k = side.monsters.length - 1; k >= 0; k--) {
          const m = side.monsters[k];
          if (m === p.target) continue;
          if (Math.hypot(m.x - ix, m.z - iz) < PASSIVE_AOE_RADIUS) {
            m.hp -= bossWarsDmgMod(m, p.damage);   // 5%-tak/immunitet/DR (no-op icke-boss)
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
      // Shadow Volley empowered AA hit: stun target + nearby (1.5s) + thorn pool 3s.
      // Använder hero.frozenTime (samma fält som Vine Trap/Leap/Frostnova) som
      // hero-stun. monster/creep frozenTime dekrementeras i deras egna ticks.
      if (p.nyroUltAa) {
        // Stun primärt target
        if (p.targetIsHero) {
          const ts = state.sides[p.targetSideIdx];
          if (ts && !ts.hero.dead) ts.hero.frozenTime = Math.max(ts.hero.frozenTime || 0, LEGOLUS_ULT_AA_STUN_DUR);
        } else if (!p.targetIsDuelOrb && !p.targetIsArenaOrb) {
          if (p.target) p.target.frozenTime = Math.max(p.target.frozenTime || 0, LEGOLUS_ULT_AA_STUN_DUR);
        }
        // AoE-stun runt hit-pos
        for (const m of side.monsters) {
          if (m === p.target) continue;
          if (Math.hypot(m.x - ix, m.z - iz) < LEGOLUS_ULT_AA_STUN_RADIUS) {
            m.frozenTime = Math.max(m.frozenTime || 0, LEGOLUS_ULT_AA_STUN_DUR);
          }
        }
        if (opp) for (const c of opp.playerCreeps) {
          if (c === p.target) continue;
          if (Math.hypot(c.x - ix, c.z - iz) < LEGOLUS_ULT_AA_STUN_RADIUS) {
            c.frozenTime = Math.max(c.frozenTime || 0, LEGOLUS_ULT_AA_STUN_DUR);
          }
        }
        if (opp && !opp.hero.dead) {
          if (Math.hypot(opp.hero.x - ix, opp.hero.z - iz) < LEGOLUS_ULT_AA_STUN_RADIUS) {
            opp.hero.frozenTime = Math.max(opp.hero.frozenTime || 0, LEGOLUS_ULT_AA_STUN_DUR);
          }
        }
        // Spawna thorn pool på hit-pos (ägd av casterns sida)
        side.thornPools = side.thornPools || [];
        side.thornPools.push({
          id: state.nextEntityId++,
          x: ix, z: iz,
          radius: LEGOLUS_THORN_POOL_RADIUS,
          remaining: LEGOLUS_THORN_POOL_DURATION,
          duration: LEGOLUS_THORN_POOL_DURATION,
          tickAccum: 0,
          dmgPct: LEGOLUS_THORN_POOL_DMG_PCT,
        });
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

// Shadow Volley: dekrementera invis-timer. Vid 0 cancellas även aaPending
// (annars stannar empowered AA kvar i evighet om Legolus aldrig skjuter).
function tickLegolusInvis(side, dt) {
  if ((side.nyroInvisRemaining || 0) <= 0) return;
  side.nyroInvisRemaining = Math.max(0, side.nyroInvisRemaining - dt);
  if (side.nyroInvisRemaining <= 0) {
    side.nyroUltAaPending = false;
  }
}

// Tickar Shadow Volley thorn pools per sida (5% maxHp / 0.5s i 3s, AoE 2.5 m).
// Skadar motståndarens minions + hero + monsterwaves i sin egen sida.
function tickThornPools(state, side, dt) {
  if (!side.thornPools || side.thornPools.length === 0) return;
  // Boss wars: co-op (3 sides) → `3 - side.idx` ger en MEDSPELARE/undefined (sides[0]).
  // Inget krasch (opp guardas nedan) men opp ska vara null i co-op (ingen fiende-hjälte/creeps).
  const opp = (state.mode === 'bosswars') ? null : arenaOpp(state, side.idx);
  for (let i = side.thornPools.length - 1; i >= 0; i--) {
    const p = side.thornPools[i];
    p.remaining -= dt;
    p.tickAccum += dt;
    while (p.tickAccum >= LEGOLUS_THORN_POOL_TICK && p.remaining > -LEGOLUS_THORN_POOL_TICK) {
      p.tickAccum -= LEGOLUS_THORN_POOL_TICK;
      // Egna sidans monster (wave-mobs som spawnar i din arena)
      for (let k = side.monsters.length - 1; k >= 0; k--) {
        const m = side.monsters[k];
        if (Math.hypot(m.x - p.x, m.z - p.z) < p.radius) {
          const dmg = (m.maxHp || m.hp) * p.dmgPct;
          m.hp -= bossWarsDmgMod(m, dmg);   // 5%-tak/immunitet/DR (no-op icke-boss)
          if (m.hp <= 0) killMonster(side, k, side);
        }
      }
      // Motståndarens creeps (line wars: opponent skickar creeps in i din arena)
      if (opp) for (let k = opp.playerCreeps.length - 1; k >= 0; k--) {
        const c = opp.playerCreeps[k];
        if (Math.hypot(c.x - p.x, c.z - p.z) < p.radius) {
          const dmg = (c.maxHp || c.hp) * p.dmgPct;
          c.hp -= dmg;
          if (c.hp <= 0) { opp.playerCreeps.splice(k, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
        }
      }
      // Opp-hero (arena/duel): pool spawnas under target, kan träffa fientlig hero
      if (opp && !opp.hero.dead) {
        if (Math.hypot(opp.hero.x - p.x, opp.hero.z - p.z) < p.radius) {
          damageHero(opp, opp.hero.maxHp * p.dmgPct);
        }
      }
    }
    if (p.remaining <= 0) side.thornPools.splice(i, 1);
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
  const opp = arenaOpp(state, sideIdx);
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
        m.hp -= bossWarsDmgMod(m, f.damage);   // 5%-tak/immunitet/DR (no-op icke-boss)
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
  const opp = arenaOpp(state, sideIdx);
  const center = resolveSkillGroundTarget(state, side, opp, ev || {}, NOVA_CAST_DISTANCE);
  side.novaEffects.push({
    id: state.nextEntityId++,
    x: center.x, z: center.z,
    life: ICE_RAIN_DURATION, maxLife: ICE_RAIN_DURATION,   // Ice Rain: zone persists 2s for the DoT
    dotAccum: 0,                                            // ticks 5% maxHP/0.5s to enemies inside
  });
  const novaDmg = NOVA_DAMAGE * (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1) * gandulfSkillDmgMul(side);
  // m_frost_heal talent: heala 15% av skill-skada per träff
  const frostHeal = engineHasTalent(state, side, 'm_frost_heal');
  // Lvl 5 bonus: applicera attack-speed-slow på alla hit-targets
  const isLvl5 = (side.skillLvl && side.skillLvl.f >= SKILL_LEVEL_MAX);
  const applyLvl5AsSlow = (entity) => {
    if (!isLvl5) return;
    entity.aSlowTime = Math.max(entity.aSlowTime || 0, GANDULF_LVL5_FN_AS_DURATION);
    entity.aSlowMul = Math.min(entity.aSlowMul == null ? 1 : entity.aSlowMul, GANDULF_LVL5_FN_AS_MUL);
  };
  let frostHealTotal = 0;
  for (let j = side.monsters.length - 1; j >= 0; j--) {
    const m = side.monsters[j];
    if (Math.hypot(m.x - center.x, m.z - center.z) < NOVA_RADIUS) {
      const wasFrozen = (m.frozenTime || 0) > 0;
      onGandulfSkillHit(side, m);
      const hpBefore = m.hp;
      applySkillDamageToMonster(state, side, opp, j, novaDmg);
      if (frostHeal) frostHealTotal += Math.min(novaDmg, hpBefore) * 0.15;
      const stillAlive = side.monsters[j] === m && m.hp > 0;
      if (stillAlive) {
        if (!wasFrozen) m.frozenTime = NOVA_FREEZE_TIME;
        applyLvl5AsSlow(m);
      }
    }
  }
  if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
    const c = opp.playerCreeps[j];
    if (Math.hypot(c.x - center.x, c.z - center.z) < NOVA_RADIUS) {
      const wasFrozen = (c.frozenTime || 0) > 0;
      onGandulfSkillHit(side, c);
      const hpBefore = c.hp;
      applySkillDamageToCreep(state, side, opp, c, novaDmg);
      if (frostHeal) frostHealTotal += Math.min(novaDmg, hpBefore) * 0.15;
      if (c.hp > 0) {
        if (!wasFrozen) c.frozenTime = NOVA_FREEZE_TIME;
        applyLvl5AsSlow(c);
      } else if (c.hp <= 0) {
        const idx = opp.playerCreeps.indexOf(c);
        if (idx >= 0) { opp.playerCreeps.splice(idx, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
      }
    }
  }
  if (isHeroPvpActive(state) && opp && !opp.hero.dead) {
    if (Math.hypot(opp.hero.x - center.x, opp.hero.z - center.z) < NOVA_RADIUS) {
      const wasFrozen = (opp.hero.frozenTime || 0) > 0;
      onGandulfSkillHit(side, opp.hero);
      const hpBefore = opp.hero.hp;
      applySkillDamageToOppHero(state, side, opp, novaDmg);
      if (frostHeal) frostHealTotal += Math.min(novaDmg, hpBefore) * 0.15;
      if (!opp.hero.dead && !wasFrozen) opp.hero.frozenTime = NOVA_FREEZE_TIME;
    }
  }
  // m_frost_heal: applicera samlad heal
  if (frostHeal && frostHealTotal > 0 && !side.hero.dead) {
    side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + frostHealTotal);
  }
}

// Ice Rain DoT tick (user 2026-06-24): 5% maxHP to every enemy inside the zone. No freeze (the
// cast already applied that) and no skill-hit procs — just damage, every 0.5s for 2s.
function iceRainTick(state, side, opp, n) {
  const cx = n.x, cz = n.z;
  for (let j = side.monsters.length - 1; j >= 0; j--) {
    const m = side.monsters[j];
    if (Math.hypot(m.x - cx, m.z - cz) < NOVA_RADIUS) {
      applySkillDamageToMonster(state, side, opp, j, (m.maxHp || m.hp) * ICE_RAIN_DOT_PCT);
    }
  }
  if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
    const c = opp.playerCreeps[j];
    if (Math.hypot(c.x - cx, c.z - cz) < NOVA_RADIUS) {
      applySkillDamageToCreep(state, side, opp, c, (c.maxHp || c.hp) * ICE_RAIN_DOT_PCT);
      if (c.hp <= 0) {
        const idx = opp.playerCreeps.indexOf(c);
        if (idx >= 0) { opp.playerCreeps.splice(idx, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
      }
    }
  }
  if (isHeroPvpActive(state) && opp && !opp.hero.dead) {
    if (Math.hypot(opp.hero.x - cx, opp.hero.z - cz) < NOVA_RADIUS) {
      applySkillDamageToOppHero(state, side, opp, opp.hero.maxHp * ICE_RAIN_DOT_PCT);
    }
  }
}

function updateNovaEffects(state, side, opp, dt) {
  for (let i = side.novaEffects.length - 1; i >= 0; i--) {
    const n = side.novaEffects[i];
    n.life -= dt;
    // Ice Rain (user 2026-06-24): frost novas (no kind) are a 2s DoT zone — 5% maxHP per 0.5s to
    // enemies inside NOVA_RADIUS. (kind 'q' = Kryx earthquake pulse: visual only, damage at cast.)
    if (!n.kind && state) {
      n.dotAccum = (n.dotAccum || 0) + dt;
      while (n.dotAccum >= ICE_RAIN_DOT_INTERVAL && n.life > -ICE_RAIN_DOT_INTERVAL) {
        n.dotAccum -= ICE_RAIN_DOT_INTERVAL;
        iceRainTick(state, side, opp, n);
      }
    }
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
  const opp = arenaOpp(state, sideIdx);
  const center = resolveSkillGroundTarget(state, side, opp, ev || {}, BLACKHOLE_CAST_DISTANCE);
  side.skills.e.cd = side.skills.e.max * gandulfCdrMul(side);
  if (!side.blackHoles) side.blackHoles = [];
  const skillDmgMul = (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1) * gandulfSkillDmgMul(side);
  // m_bh_radius talent: +30% pull-radius och explosion-radius
  const bhRadiusMul = engineHasTalent(state, side, 'm_bh_radius') ? 1.30 : 1.0;
  side.blackHoles.push({
    id: state.nextEntityId++,
    x: center.x, z: center.z,
    life: BLACKHOLE_DURATION, maxLife: BLACKHOLE_DURATION,
    explosionDmg: BLACKHOLE_EXPLOSION_DMG * skillDmgMul,
    radiusMul: bhRadiusMul,
    // Lvl 5 bonus: stun:a alla hit-targets vid explosion (sparas på effekten
    // så framtida lvl-down inte påverkar redan castade black holes)
    lvl5Stun: !!(side.skillLvl && side.skillLvl.e >= SKILL_LEVEL_MAX),
  });
}

function updateBlackHoles(state, side, opp, dt) {
  if (!side.blackHoles || side.blackHoles.length === 0) return;
  for (let i = side.blackHoles.length - 1; i >= 0; i--) {
    const bh = side.blackHoles[i];
    bh.life -= dt;
    // Sug-styrka: smooth pull i radien (m_bh_radius talent applicerat vid cast)
    const pull = BLACKHOLE_PULL_SPEED * dt;
    const bhPullR = BLACKHOLE_RADIUS * (bh.radiusMul || 1);
    const bhExplosionR = BLACKHOLE_EXPLOSION_RADIUS * (bh.radiusMul || 1);
    for (const m of side.monsters) {
      const dx = bh.x - m.x, dz = bh.z - m.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.15 && d < bhPullR) {
        const f = 1 - d / bhPullR;
        m.x += (dx / d) * pull * (0.4 + f * 0.6);
        m.z += (dz / d) * pull * (0.4 + f * 0.6);
      }
    }
    if (opp) for (const c of opp.playerCreeps) {
      const dx = bh.x - c.x, dz = bh.z - c.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.15 && d < bhPullR) {
        const f = 1 - d / bhPullR;
        c.x += (dx / d) * pull * (0.4 + f * 0.6);
        c.z += (dz / d) * pull * (0.4 + f * 0.6);
      }
    }
    // Suga in opp.hero under duel
    if (isHeroPvpActive(state) && opp && !opp.hero.dead) {
      const dx = bh.x - opp.hero.x, dz = bh.z - opp.hero.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.15 && d < bhPullR) {
        opp.hero.x += (dx / d) * pull * 0.5;
        opp.hero.z += (dz / d) * pull * 0.5;
      }
    }
    if (bh.life <= 0) {
      // Explosion AoE
      const stunDur = bh.lvl5Stun ? GANDULF_LVL5_BH_STUN_DURATION : 0;
      for (let j = side.monsters.length - 1; j >= 0; j--) {
        const m = side.monsters[j];
        if (Math.hypot(m.x - bh.x, m.z - bh.z) < bhExplosionR) {
          onGandulfSkillHit(side, m);
          applySkillDamageToMonster(state, side, opp, j, bh.explosionDmg);
          // Lvl 5: stun (= frozen) i 1s om träffad och fortfarande vid liv
          if (stunDur > 0 && side.monsters[j] === m && m.hp > 0) {
            m.frozenTime = Math.max(m.frozenTime || 0, stunDur);
          }
        }
      }
      if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
        const c = opp.playerCreeps[j];
        if (Math.hypot(c.x - bh.x, c.z - bh.z) < bhExplosionR) {
          onGandulfSkillHit(side, c);
          applySkillDamageToCreep(state, side, opp, c, bh.explosionDmg);
          if (c.hp <= 0) { opp.playerCreeps.splice(j, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
          else if (stunDur > 0) c.frozenTime = Math.max(c.frozenTime || 0, stunDur);
        }
      }
      if (isHeroPvpActive(state) && opp && !opp.hero.dead) {
        if (Math.hypot(opp.hero.x - bh.x, opp.hero.z - bh.z) < bhExplosionR) {
          onGandulfSkillHit(side, opp.hero);
          applySkillDamageToOppHero(state, side, opp, bh.explosionDmg);
          if (stunDur > 0 && !opp.hero.dead) opp.hero.frozenTime = Math.max(opp.hero.frozenTime || 0, stunDur);
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
  const opp = arenaOpp(state, sideIdx);
  const center = resolveSkillGroundTarget(state, side, opp, ev || {}, VINE_TRAP_CAST_DISTANCE);
  if (!side.vineTraps) side.vineTraps = [];
  const vineDotMul = engineHasTalent(state, side, 'l_vine_dot') ? 2 : 1;
  side.vineTraps.push({
    id: state.nextEntityId++,
    x: center.x, z: center.z,
    life: VINE_TRAP_DURATION, maxLife: VINE_TRAP_DURATION,
    dotPerSec: VINE_TRAP_DOT_DPS * (side.skillDmgMul || 1) * vineDotMul,
    radius: VINE_TRAP_RADIUS,
    // Lvl 5: spara mark-flagga + Set över träffade entiteter (för mark vid trap-slut)
    lvl5Mark: !!(side.skillLvl && side.skillLvl.q >= SKILL_LEVEL_MAX),
    hitMonsterIds: new Set(),
    hitCreepIds: new Set(),
    hitOppHero: false,
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
        m.hp -= bossWarsDmgMod(m, vt.dotPerSec * dt);   // 5%-tak/immunitet/DR (no-op icke-boss)
        if (vt.lvl5Mark) vt.hitMonsterIds.add(m.id);
        if (m.hp <= 0) killMonster(side, j, side);
      }
    }
    if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
      const c = opp.playerCreeps[j];
      const dx = c.x - vt.x, dz = c.z - vt.z;
      if (dx * dx + dz * dz < r2) {
        c.frozenTime = Math.max(c.frozenTime || 0, VINE_TRAP_ROOT_REFRESH);
        c.hp -= vt.dotPerSec * dt;
        if (vt.lvl5Mark) vt.hitCreepIds.add(c.id);
        if (c.hp <= 0) { opp.playerCreeps.splice(j, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
      }
    }
    // Duel: applicera även på opp.hero
    if (isHeroPvpActive(state) && opp && !opp.hero.dead) {
      const dx = opp.hero.x - vt.x, dz = opp.hero.z - vt.z;
      if (dx * dx + dz * dz < r2) {
        opp.hero.frozenTime = Math.max(opp.hero.frozenTime || 0, VINE_TRAP_ROOT_REFRESH);
        damageHero(opp, vt.dotPerSec * dt);
        if (vt.lvl5Mark) vt.hitOppHero = true;
      }
    }
    if (vt.life <= 0) {
      // Lvl 5: applicera mark på alla entiteter som rootats under trap-livet
      if (vt.lvl5Mark) {
        for (const m of side.monsters) {
          if (vt.hitMonsterIds.has(m.id)) m.nyroMarked = LEGOLAS_LVL5_VT_MARK_DURATION;
        }
        if (opp) for (const c of opp.playerCreeps) {
          if (vt.hitCreepIds.has(c.id)) c.nyroMarked = LEGOLAS_LVL5_VT_MARK_DURATION;
        }
        if (vt.hitOppHero && opp && !opp.hero.dead) {
          opp.hero.nyroMarked = LEGOLAS_LVL5_VT_MARK_DURATION;
        }
      }
      side.vineTraps.splice(i, 1);
    }
  }
}

// Helper: returnera dmg-mult för Legolas-hits mot marked targets
function nyroMarkMul(side, target) {
  if (side.heroId !== 'nyro' || !target) return 1;
  return (target.nyroMarked || 0) > 0 ? LEGOLAS_LVL5_VT_MARK_DMG_MUL : 1;
}

// F: Self-buff i 5s — +10% dmg, +10% crit, +30% crit-dmg
function castLegolusBuff(state, sideIdx) {
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.f.cd > 0) return;
  side.skills.f.cd = side.skills.f.max;
  side.nyroBuffRemaining = LEGOLUS_BUFF_DURATION + (engineHasTalent(state, side, 'l_focus_dur') ? 2 : 0);
}

// E: Kort dash + flagga: nästa AA = 100% crit + 20% lifesteal. Reset cd om buffed AA dödar.
// Lvl 5: 2 stacks med separata CDs (side.skills.e.cd + side.nyroDashStackCd).
function castLegolusDash(state, sideIdx, ev) {
  const side = state.sides[sideIdx];
  if (side.hero.dead) return;
  const isLvl5 = (side.skillLvl && side.skillLvl.e >= SKILL_LEVEL_MAX);
  // CD-gate: vid lvl5 krävs att MINST en stack är klar
  const stack1Ready = (side.skills.e.cd || 0) <= 0;
  const stack2Ready = isLvl5 && (side.nyroDashStackCd || 0) <= 0;
  if (!stack1Ready && !stack2Ready) return;
  let dx = (ev && ev.dx) || 0, dz = (ev && ev.dz) || 0;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) { dx = side.hero.facingX; dz = side.hero.facingZ; }
  else { dx /= len; dz /= len; }
  let dist = LEGOLUS_DASH_DISTANCE, nx, nz;
  while (dist >= 0.5) {
    nx = side.hero.x + dx * dist;
    nz = side.hero.z + dz * dist;
    if (heroWalk(side, nx, nz)) break;
    dist -= 0.5;
  }
  if (dist < 0.5) return;
  // Konsumera prioriterat stack 1 (huvud-CD), sen stack 2
  if (stack1Ready) side.skills.e.cd = side.skills.e.max;
  else side.nyroDashStackCd = side.skills.e.max;
  side.hero.x = nx; side.hero.z = nz;
  side.nyroDashBuffPending = true;
}

// === Ganji (melee sword ninja) — v1 server kit reusing proven, hero-agnostic effects.
// Q = Thousand Slashes -> Whirlwind (spinning melee AoE). F = Shadow Step (blink).
// E = Ninja's Speed (Hunter's Focus AA buff + Warpath MS/AS). R = invis (in the ult block).
// Clone + the exact channel/passive are deferred to a later pass. ===
const GANJI_STEP_DISTANCE = 8;
// Ganji passive "Katana's Slice" (port av GanjiKit): rörelse fyller en mätare; full vid
// 10 m → nästa AA garanterad crit + 50% bonus-dmg, sen nollas mätaren. Server-auth, alla
// lägen (fylls i applyMovement + Shadow Step). Mätaren serialiseras som gjMk (klient-bar).
const GANJI_METER_METERS = 10;
const GANJI_EMPOWER_DMG_MUL = 1.5;
// Empowrad AA stämplar ett märke: 5% maxHP/s DoT i 3s + 20% MS/AS-slow (solo-paritet).
// DoT EJ på boss (uncappat %maxHP skulle bryta boss-dmg-taket, samma regel som Stomp).
const GANJI_MARK_DUR = 3, GANJI_MARK_DOT_PCT = 0.05, GANJI_MARK_SLOW_MUL = 0.80;
function applyGanjiSlow(ent) {
  ent.slowMul = Math.min(ent.slowMul == null ? 1 : ent.slowMul, GANJI_MARK_SLOW_MUL);
  ent.slowTime = Math.max(ent.slowTime || 0, GANJI_MARK_DUR);
  ent.aSlowMul = Math.min(ent.aSlowMul == null ? 1 : ent.aSlowMul, GANJI_MARK_SLOW_MUL);
  ent.aSlowTime = Math.max(ent.aSlowTime || 0, GANJI_MARK_DUR);
}
function ganjiAddMeter(side, meters) {
  if (side.heroId !== 'ganji' || side.ganjiPassiveReady || !(meters > 0)) return;
  side.ganjiMeter = Math.min(1, (side.ganjiMeter || 0) + meters / GANJI_METER_METERS);
  if (side.ganjiMeter >= 1) side.ganjiPassiveReady = true;
}
function castGanjiStep(state, sideIdx, ev) { // F: blink to the aim direction
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.f.cd > 0) return;
  let dx = (ev && ev.dx) || 0, dz = (ev && ev.dz) || 0;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) { dx = side.hero.facingX || 0; dz = side.hero.facingZ || 1; }
  else { dx /= len; dz /= len; }
  let dist = GANJI_STEP_DISTANCE, nx, nz;
  while (dist >= 0.5) {
    nx = side.hero.x + dx * dist;
    nz = side.hero.z + dz * dist;
    if (heroWalk(side, nx, nz)) break;
    dist -= 0.5;
  }
  if (dist < 0.5) return;
  side.skills.f.cd = side.skills.f.max;
  side.hero.x = nx; side.hero.z = nz;
  ganjiAddMeter(side, dist); // Shadow Step distance counts toward the passive (solo parity)
}
function castGanjiSpeed(state, sideIdx) { // E: Ninja's Speed self-buff
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.e.cd > 0) return;
  side.skills.e.cd = side.skills.e.max;
  side.nyroBuffRemaining = LEGOLUS_BUFF_DURATION; // +AA dmg/crit/attack-speed (agnostic effect)
  side.zheynaWarpathRem = ZHEYNA_E_DUR;              // +move/attack speed (agnostic effect)
}

// === Gimlu-skills ===
// Q: Titan's Stomp (rework 2026-06-07) — AoE-stamp: 25% maxHP-skada + DoT (5% maxHP/s, 3s)
// + 40% MS/AS-slow (2s). Kryx får DR per träff (hero +25% / minion +5% / boss +50%, 3s, cap 70%).
// DoT appliceras EJ på boss (uncappat 5%/s skulle bryta boss-dmg-taket); boss tar capped initial-hit.
function castGimluTaunt(state, sideIdx) {
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.q.cd > 0) return;
  side.skills.q.cd = side.skills.q.max;
  // Passive empower: full berserk → 100% större AoE, +50% skada, 60% slow.
  const emp = consumeBerserk(side);
  const rageMul = (side.titansRageTime || 0) > 0 ? (1 + (side.titansRageBuff || 0)) : 1;   // Titan's Rage outgoing-dmg
  const eRad = emp ? STOMP_RADIUS * BERSERK_STOMP_RADIUS_MUL : STOMP_RADIUS;
  const r2 = eRad * eRad;
  const eDmgPct = STOMP_DMG_PCT * (emp ? BERSERK_STOMP_DMG_MUL : 1) * rageMul;
  const eDmgPctHero = STOMP_DMG_PCT_HERO * (emp ? BERSERK_STOMP_DMG_MUL : 1) * rageMul;   // PvP-nerf
  const eDotPct = STOMP_DOT_PCT * (emp ? BERSERK_STOMP_DMG_MUL : 1) * rageMul;
  const eSlow = emp ? BERSERK_STOMP_SLOW_MUL : STOMP_SLOW_MUL;
  // K1: earthquake-puls vid HELA AoE:n + sprickor. Visuell livslängd 0.75s (user 2026-06-23 —
  // effekten ska bara synas 0.75s; skadan/DoT nedan är oberoende av nova-entitetens liv).
  side.novaEffects = side.novaEffects || [];
  side.novaEffects.push({ id: state.nextEntityId++, x: side.hero.x, z: side.hero.z, life: 0.75, maxLife: 0.75, r: eRad, kind: 'q' });
  let drGain = 0;
  // Monsters (minions + boss)
  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    const dx = m.x - side.hero.x, dz = m.z - side.hero.z;
    if (dx * dx + dz * dz >= r2) continue;
    const isBoss = !!m.isBossWarsBoss;
    const mMax = m.maxHp || m.hp;   // cacha FÖRE hp-reduktion (annars baseras DoT på sänkt hp)
    m.hp -= bossWarsDmgMod(m, mMax * eDmgPct);   // cap/immunitet för boss, no-op annars
    m.slowMul = Math.min(m.slowMul == null ? 1 : m.slowMul, eSlow);
    m.slowTime = Math.max(m.slowTime || 0, STOMP_SLOW_DUR);
    m.aSlowMul = Math.min(m.aSlowMul == null ? 1 : m.aSlowMul, eSlow);
    m.aSlowTime = Math.max(m.aSlowTime || 0, STOMP_SLOW_DUR);
    if (!isBoss) { m.dotRemaining = STOMP_DOT_DUR; m.dotPerSec = mMax * eDotPct; }
    drGain += isBoss ? STOMP_DR_BOSS : STOMP_DR_MINION;
    if (m.hp <= 0) killMonster(side, i, side);
  }
  // Opp playerCreeps (invaderande minions)
  const opp = arenaOpp(state, sideIdx);
  if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
    const c = opp.playerCreeps[i];
    const dx = c.x - side.hero.x, dz = c.z - side.hero.z;
    if (dx * dx + dz * dz >= r2) continue;
    const cMax = c.maxHp || c.hp;   // cacha FÖRE hp-reduktion
    c.hp -= cMax * eDmgPct;
    c.slowMul = Math.min(c.slowMul == null ? 1 : c.slowMul, eSlow);
    c.slowTime = Math.max(c.slowTime || 0, STOMP_SLOW_DUR);
    c.aSlowMul = Math.min(c.aSlowMul == null ? 1 : c.aSlowMul, eSlow);
    c.aSlowTime = Math.max(c.aSlowTime || 0, STOMP_SLOW_DUR);
    c.dotRemaining = STOMP_DOT_DUR; c.dotPerSec = cMax * eDotPct;
    drGain += STOMP_DR_MINION;
    if (c.hp <= 0) { opp.playerCreeps.splice(i, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
  }
  // Enemy-hero (arena/duel PvP)
  if (isHeroPvpActive(state) && opp && !opp.hero.dead) {
    const dx = opp.hero.x - side.hero.x, dz = opp.hero.z - side.hero.z;
    if (dx * dx + dz * dz < r2) {
      damageHero(opp, opp.hero.maxHp * eDmgPctHero);   // PvP-nerf: 12% (ej 25%)
      opp.heroSlowMul = Math.min(opp.heroSlowMul == null ? 1 : opp.heroSlowMul, eSlow);
      opp.heroSlowTime = Math.max(opp.heroSlowTime || 0, STOMP_SLOW_DUR);
      opp.heroASlowMul = Math.min(opp.heroASlowMul == null ? 1 : opp.heroASlowMul, eSlow);
      opp.heroASlowTime = Math.max(opp.heroASlowTime || 0, STOMP_SLOW_DUR);
      opp.hero.dotRemaining = STOMP_DOT_DUR; opp.hero.dotPerSec = opp.hero.maxHp * eDotPct;
      drGain += STOMP_DR_HERO;
    }
  }
  // DR till Kryx (3s) — fräsch stack per stomp (cap 70% total appliceras i damageHero).
  if (drGain > 0) { side.titansStompDr = drGain; side.titansStompDrTime = STOMP_DR_DUR; }
}

// Kryx-rework-timers (Stomp-DR + hjälte-AS-slow + Titan's Rage). Kallas i alla tick-loopar.
function tickKryxTimers(side, dt) {
  if ((side.titansStompDrTime || 0) > 0) { side.titansStompDrTime = Math.max(0, side.titansStompDrTime - dt); if (side.titansStompDrTime <= 0) side.titansStompDr = 0; }
  if ((side.heroASlowTime || 0) > 0) { side.heroASlowTime = Math.max(0, side.heroASlowTime - dt); if (side.heroASlowTime <= 0) side.heroASlowMul = 1; }
  if ((side.titansRageTime || 0) > 0) { side.titansRageTime = Math.max(0, side.titansRageTime - dt); if (side.titansRageTime <= 0) side.titansRageBuff = 0; }
  // E3 War Shout-buff (alla lägen — tickas här i den delade timer-hubben)
  if ((side.elarShoutBuffTime || 0) > 0) side.elarShoutBuffTime = Math.max(0, side.elarShoutBuffTime - dt);
  // G5 crit-flash (alla lägen) — kort fönster där cri-flaggan är hög efter en crit-AA
  if ((side.aaCritFlash || 0) > 0) side.aaCritFlash = Math.max(0, side.aaCritFlash - dt);
  // Titan's Rage leech: efter fear-fönstret (rageLeechStart) → 1s där denna (feared)
  // hjältes utdelade skada healar Kryx (rageLeechOwner). Empowered: slow vid leech-start.
  if ((side.rageLeechStart || 0) > 0) {
    side.rageLeechStart = Math.max(0, side.rageLeechStart - dt);
    if (side.rageLeechStart <= 0) {
      side.rageLeechTime = TITANS_RAGE_LEECH_DUR;
      if (side.rageEmpSlow) { side.heroSlowMul = Math.min(side.heroSlowMul == null ? 1 : side.heroSlowMul, 0.6); side.heroSlowTime = Math.max(side.heroSlowTime || 0, 1.0); }
    }
  }
  if ((side.rageLeechTime || 0) > 0) side.rageLeechTime = Math.max(0, side.rageLeechTime - dt);
}

// Passive: konsumera full berserk-mätare (empowrar nästa Q/F/E). Returnerar true + nollar.
function consumeBerserk(side) {
  if (side.heroId !== 'kryx' || !side.berserkCharged) return false;
  side.berserkCharged = false; side.berserkDmgAccum = 0;
  return true;
}

// Lvl-5 Gimlu F (Iron Will) — flush reflect-queue: applicera AoE-skada runt Gimlu
// från ackumulerad reflekterad skada (30% av incoming under iron-will).
function flushIronWillReflectLvl5(state, side, opp) {
  const q = side.ironWillReflectQueue;
  if (!q || q.length === 0) return;
  let total = 0;
  for (const r of q) total += r;
  q.length = 0;
  if (total <= 0 || side.hero.dead) return;
  const r2 = GIMLU_LVL5_IW_REFLECT_RADIUS * GIMLU_LVL5_IW_REFLECT_RADIUS;
  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    const ddx = m.x - side.hero.x, ddz = m.z - side.hero.z;
    if (ddx * ddx + ddz * ddz < r2) {
      m.hp -= bossWarsDmgMod(m, total);   // 5%-tak/immunitet/DR (no-op icke-boss)
      if (m.hp <= 0) killMonster(side, i, side);
    }
  }
  if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
    const c = opp.playerCreeps[i];
    const ddx = c.x - side.hero.x, ddz = c.z - side.hero.z;
    if (ddx * ddx + ddz * ddz < r2) {
      c.hp -= total;
      if (c.hp <= 0) { opp.playerCreeps.splice(i, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
    }
  }
  if (isHeroPvpActive(state) && opp && !opp.hero.dead) {
    const ddx = opp.hero.x - side.hero.x, ddz = opp.hero.z - side.hero.z;
    if (ddx * ddx + ddz * ddz < r2) damageHero(opp, total);
  }
}

// Lvl-5 Gimlu Q (Titans Taunt) — track healing-during-taunt + fire AoE-explosion vid slut
function tickGimluTauntLvl5(state, side, opp, dt) {
  if ((side.titansTauntRemaining || 0) <= 0) return;
  if (side.tauntLvl5) {
    const prev = side._tauntHpPrev != null ? side._tauntHpPrev : side.hero.hp;
    if (side.hero.hp > prev) side.tauntHealAccum = (side.tauntHealAccum || 0) + (side.hero.hp - prev);
    side._tauntHpPrev = side.hero.hp;
  }
  side.titansTauntRemaining = Math.max(0, side.titansTauntRemaining - dt);
  if (side.titansTauntRemaining === 0 && side.tauntLvl5 && (side.tauntHealAccum || 0) > 0) {
    const dmg = side.tauntHealAccum * GIMLU_LVL5_TT_HEAL_PCT;
    const r2 = GIMLU_LVL5_TT_EXPLOSION_RADIUS * GIMLU_LVL5_TT_EXPLOSION_RADIUS;
    for (let i = side.monsters.length - 1; i >= 0; i--) {
      const m = side.monsters[i];
      const ddx = m.x - side.hero.x, ddz = m.z - side.hero.z;
      if (ddx * ddx + ddz * ddz < r2) {
        m.hp -= bossWarsDmgMod(m, dmg);   // 5%-tak/immunitet/DR (no-op icke-boss)
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
    if (isHeroPvpActive(state) && opp && !opp.hero.dead) {
      const ddx = opp.hero.x - side.hero.x, ddz = opp.hero.z - side.hero.z;
      if (ddx * ddx + ddz * ddz < r2) damageHero(opp, dmg);
    }
    // Visuell explosion-burst via samma ironWillExplosions-array (klient renderar ring)
    side.ironWillExplosions = side.ironWillExplosions || [];
    side.ironWillExplosions.push({ id: state.nextEntityId++, x: side.hero.x, z: side.hero.z, life: 0.7, maxLife: 0.7 });
    side.tauntLvl5 = false;
    side.tauntHealAccum = 0;
  }
}

// F: Titan's Rage (rework 2026-06-07) — self+ally-buff (dmg/DR/MS/AS, alla samma %).
// Enemy-hero (PvP) feared; efter fearen healar deras utdelade skada Kryx i 1s (leech).
// Empowered (berserk): 30% stats, allies full (ej halva), fear 1.5s + slow efter.
function castGimluIronWill(state, sideIdx) {
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.f.cd > 0) return;
  side.skills.f.cd = side.skills.f.max;
  const emp = consumeBerserk(side);
  const self = emp ? 0.30 : TITANS_RAGE_SELF;
  const ally = emp ? self : self * 0.5;
  const fearDur = emp ? 1.5 : TITANS_RAGE_FEAR_DUR;
  // Self-buff
  side.titansRageTime = TITANS_RAGE_DURATION;
  side.titansRageBuff = self;
  // Ally-buff (boss wars co-op) inom radie
  const r2 = TITANS_RAGE_RADIUS * TITANS_RAGE_RADIUS;
  if (side.inBossWars) for (const idx of [1, 2, 3]) {
    if (idx === sideIdx) continue;
    const a = state.sides[idx];
    if (!a || a.hero.dead) continue;
    const dx = a.hero.x - side.hero.x, dz = a.hero.z - side.hero.z;
    if (dx * dx + dz * dz <= r2) { a.titansRageTime = TITANS_RAGE_DURATION; a.titansRageBuff = ally; }
  }
  // Fear + heal-redirect på enemy-hero (PvP only — bossar/minions kan ej feares)
  const opp = arenaOpp(state, sideIdx);
  if (isHeroPvpActive(state) && opp && !opp.hero.dead) {
    const dx = opp.hero.x - side.hero.x, dz = opp.hero.z - side.hero.z;
    if (dx * dx + dz * dz <= r2) {
      opp.heroFearTime = Math.max(opp.heroFearTime || 0, fearDur);
      opp.rageLeechStart = fearDur;          // efter fear → leech-fönster (1s)
      opp.rageLeechOwner = sideIdx;
      opp.rageEmpSlow = emp;
    }
  }
}

function updateIronWill(state, side, opp, dt) {
  if (!side.ironWillRemaining || side.ironWillRemaining <= 0) return;
  side.ironWillRemaining -= dt;
  if (side.ironWillRemaining <= 0) {
    const dmg = side.ironWillStored || 0;
    side.ironWillStored = 0;
    side.ironWillRemaining = 0;
    if (dmg > 0) {
      // g_iron_radius talent: +30% explosion radius
      const ironRadiusMul = engineHasTalent(state, side, 'g_iron_radius') ? 1.30 : 1.0;
      const r2 = (IRON_WILL_EXPLOSION_RADIUS * ironRadiusMul) * (IRON_WILL_EXPLOSION_RADIUS * ironRadiusMul);
      for (let i = side.monsters.length - 1; i >= 0; i--) {
        const m = side.monsters[i];
        const ddx = m.x - side.hero.x, ddz = m.z - side.hero.z;
        if (ddx * ddx + ddz * ddz < r2) {
          m.hp -= bossWarsDmgMod(m, dmg);   // 5%-tak/immunitet/DR (no-op icke-boss)
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
      if (isHeroPvpActive(state) && opp && !opp.hero.dead) {
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
  const isLvl5 = !!(side.skillLvl && side.skillLvl.e >= SKILL_LEVEL_MAX);
  // Om hammer redan ute → teleport till den och despawn
  if (side.hammers && side.hammers.length > 0) {
    const h = side.hammers[0];
    if (heroWalk(side, h.x, h.z)) {
      side.hero.x = h.x;
      side.hero.z = h.z;
    }
    side.hammers.splice(0, 1);
    // Lvl 5: +50% MS i 1s efter tp
    if (isLvl5) side.kryxHammerMsRem = GIMLU_LVL5_HAMMER_MS_DURATION;
    return;
  }
  if (side.skills.e.cd > 0) return;
  side.skills.e.cd = side.skills.e.max;
  // Tap-cast (no drag) sends undefined/0 direction → coerce so Math.hypot can't be NaN. (NaN < 0.01
  // is FALSE, which used to skip the facing-fallback and throw a NaN-direction hammer = invisible,
  // never travels, but cooldown still consumed — user R3 bug.) Now a tap throws along hero facing.
  dirX = +dirX || 0; dirZ = +dirZ || 0;
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.01) { dirX = side.hero.facingX; dirZ = side.hero.facingZ; }
  else { dirX /= len; dirZ /= len; }
  side.hammers = side.hammers || [];
  // g_hammer_full talent: return = 100% damage (base is 50%)
  const hammerReturnMul = engineHasTalent(state, side, 'g_hammer_full') ? 1.0 : HAMMER_RETURN_DMG_MUL;
  const emp = consumeBerserk(side);   // passive empower (endast vid kast, ej teleport)
  side.hammers.push({
    id: state.nextEntityId++,
    x: side.hero.x, z: side.hero.z,
    dx: dirX, dz: dirZ,
    traveled: 0,
    returning: false,
    hit: new Set(),
    damage: HAMMER_DAMAGE * (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1) * ((side.titansRageTime || 0) > 0 ? (1 + (side.titansRageBuff || 0)) : 1),
    returnDmgMul: hammerReturnMul,
    lvl5Slow: isLvl5,
    empowered: emp,
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
      if (d < 0.6) {
        // Lvl 5: +50% MS i 1s när hammer återvänder till Gimlu
        if (h.lvl5Slow) side.kryxHammerMsRem = Math.max(side.kryxHammerMsRem || 0, GIMLU_LVL5_HAMMER_MS_DURATION);
        side.hammers.splice(i, 1); continue;
      }
      h.x += (ddx / d) * step;
      h.z += (ddz / d) * step;
    }
    const dmgMul = h.returning ? (h.returnDmgMul !== undefined ? h.returnDmgMul : HAMMER_RETURN_DMG_MUL) : 1;
    // Passive empower: +50% dmg, +50% heal, ×3 hit-radie, 50% MS-slow (annars lvl5-slow).
    const dmg = h.damage * dmgMul * (h.empowered ? BERSERK_HAMMER_DMG_MUL : 1);
    const lifesteal = HAMMER_LIFESTEAL * (h.empowered ? BERSERK_HAMMER_HEAL_MUL : 1);
    const hitR = HAMMER_RADIUS * (h.empowered ? BERSERK_HAMMER_SIZE_MUL : 1);
    const doSlow = h.lvl5Slow || h.empowered;
    const hSlowMul = h.empowered ? BERSERK_HAMMER_SLOW_MUL : GIMLU_LVL5_HAMMER_SLOW_MUL;
    // Träff på monsters
    for (let j = side.monsters.length - 1; j >= 0; j--) {
      const m = side.monsters[j];
      if (h.hit.has(m.id)) continue;
      if (Math.hypot(m.x - h.x, m.z - h.z) < hitR) {
        h.hit.add(m.id);
        m.hp -= bossWarsDmgMod(m, dmg);   // 5%-tak/immunitet/DR (no-op icke-boss)
        if (doSlow) {
          m.slowTime = Math.max(m.slowTime || 0, GIMLU_LVL5_HAMMER_SLOW_DURATION);
          m.slowMul = Math.min(m.slowMul == null ? 1 : m.slowMul, hSlowMul);
        }
        if (!side.hero.dead) side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + dmg * lifesteal);
        if (m.hp <= 0) killMonster(side, j, side);
      }
    }
    // Träff på opp's playerCreeps
    if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
      const c = opp.playerCreeps[j];
      if (h.hit.has(c.id)) continue;
      if (Math.hypot(c.x - h.x, c.z - h.z) < hitR) {
        h.hit.add(c.id);
        c.hp -= dmg;
        if (doSlow) {
          c.slowTime = Math.max(c.slowTime || 0, GIMLU_LVL5_HAMMER_SLOW_DURATION);
          c.slowMul = Math.min(c.slowMul == null ? 1 : c.slowMul, hSlowMul);
        }
        if (!side.hero.dead) side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + dmg * lifesteal);
        if (c.hp <= 0) { opp.playerCreeps.splice(j, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
      }
    }
    // Duel: träffa opp.hero
    if (state.duelActive && opp && !opp.hero.dead && !h.hit.has('opp-hero')) {
      if (Math.hypot(opp.hero.x - h.x, opp.hero.z - h.z) < hitR + 0.4) {
        h.hit.add('opp-hero');
        damageHero(opp, dmg);
        if (doSlow) {
          opp.heroSlowTime = Math.max(opp.heroSlowTime || 0, GIMLU_LVL5_HAMMER_SLOW_DURATION);
          opp.heroSlowMul = Math.min(opp.heroSlowMul == null ? 1 : opp.heroSlowMul, hSlowMul);
        }
        if (!side.hero.dead) side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + dmg * lifesteal);
      }
    }
  }
}

// ============================================================
// GANDULF Q — WIND PUFF (cone framåt, 20% maxHP dmg + push 3m + debuff +20% dmg taken)
// Tidigare versioner: Eldklot (fire cone), Soul Drain (target-locked channel).
// ============================================================
const WIND_PUFF_LENGTH = 3;                      // 3 m radius (user 2026-06-24; was 5.5)
const WIND_PUFF_HALF_ANGLE = Math.PI / 2;       // 180° half-circle in front (user 2026-06-24; was 90° cone)
const WIND_PUFF_DMG_PCT = 0.10;                  // 10% maxHP (0.20→0.07 var övernerf; 0.10 = ~20% maxHP/cast @ lvl30, stark utility-Q med push+debuff utan 2-cast-kill)
const WIND_PUFF_PUSH_DIST = 3;                   // 3m pushback i cast-riktning
const WIND_PUFF_DEBUFF_DURATION = 4.0;
const WIND_PUFF_DEBUFF_MUL = 1.20;               // +20% taken damage

function castWindPuff(state, sideIdx, dirX, dirZ) {
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.q.cd > 0) return;
  // Sätt CD först så server och klient CD är synkade även vid bail
  side.skills.q.cd = side.skills.q.max * gandulfCdrMul(side);
  // Lvl 5 bonus: caster får +30% MS i 1.5s
  if (side.skillLvl && side.skillLvl.q >= SKILL_LEVEL_MAX) {
    side.windPuffMsRem = GANDULF_LVL5_WP_MS_DURATION;
  }
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.01) { dirX = side.hero.facingX; dirZ = side.hero.facingZ; }
  else { dirX /= len; dirZ /= len; }
  const opp = arenaOpp(state, sideIdx);
  const skillMul = (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1) * gandulfSkillDmgMul(side);
  // Spawn cone-FX (klient renderar via fireWaves-reconcile — orange-ish, OK för wind)
  side.fireWaves = side.fireWaves || [];
  side.fireWaves.push({
    id: state.nextEntityId++,
    x: side.hero.x, z: side.hero.z,
    dx: dirX, dz: dirZ,
    life: 0.6, maxLife: 0.6,
    kind: 'wind',   // Z3: klienten renderar lila/vit vind-kon i st f orange eld
  });
  const inCone = (ex, ez) => {
    const ddx = ex - side.hero.x, ddz = ez - side.hero.z;
    const d = Math.hypot(ddx, ddz);
    if (d > WIND_PUFF_LENGTH || d < 0.001) return false;
    const dot = (ddx * dirX + ddz * dirZ) / d;
    return Math.acos(Math.max(-1, Math.min(1, dot))) < WIND_PUFF_HALF_ANGLE;
  };
  // Monsters
  for (let j = side.monsters.length - 1; j >= 0; j--) {
    const m = side.monsters[j];
    if (!inCone(m.x, m.z)) continue;
    const dmg = (m.maxHp || m.hp) * WIND_PUFF_DMG_PCT * skillMul;
    onGandulfSkillHit(side, m);
    applySkillDamageToMonster(state, side, opp, j, dmg);
    if (side.monsters[j] === m && m.hp > 0) {
      m.x += dirX * WIND_PUFF_PUSH_DIST;
      m.z += dirZ * WIND_PUFF_PUSH_DIST;
      m.dmgTakenDebuffTime = WIND_PUFF_DEBUFF_DURATION;
      m.dmgTakenDebuffMul = WIND_PUFF_DEBUFF_MUL;
    }
  }
  // Opp creeps
  if (opp) for (let j = opp.playerCreeps.length - 1; j >= 0; j--) {
    const c = opp.playerCreeps[j];
    if (!inCone(c.x, c.z)) continue;
    const dmg = (c.maxHp || c.hp) * WIND_PUFF_DMG_PCT * skillMul;
    onGandulfSkillHit(side, c);
    applySkillDamageToCreep(state, side, opp, c, dmg);
    if (c.hp > 0) {
      c.x += dirX * WIND_PUFF_PUSH_DIST;
      c.z += dirZ * WIND_PUFF_PUSH_DIST;
      c.dmgTakenDebuffTime = WIND_PUFF_DEBUFF_DURATION;
      c.dmgTakenDebuffMul = WIND_PUFF_DEBUFF_MUL;
    } else {
      const idx = opp.playerCreeps.indexOf(c);
      if (idx >= 0) { opp.playerCreeps.splice(idx, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
    }
  }
  // Duel: opp.hero i cone
  if (isHeroPvpActive(state) && opp && !opp.hero.dead && inCone(opp.hero.x, opp.hero.z)) {
    const dmg = opp.hero.maxHp * WIND_PUFF_DMG_PCT * skillMul;
    onGandulfSkillHit(side, opp.hero);
    applySkillDamageToOppHero(state, side, opp, dmg);
    if (!opp.hero.dead) {
      opp.hero.x += dirX * WIND_PUFF_PUSH_DIST;
      opp.hero.z += dirZ * WIND_PUFF_PUSH_DIST;
      opp.hero.dmgTakenDebuffTime = WIND_PUFF_DEBUFF_DURATION;
      opp.hero.dmgTakenDebuffMul = WIND_PUFF_DEBUFF_MUL;
    }
  }
}

// ============================================================
// GANDULF Q — SOUL DRAIN (LEGACY — ej längre routad, behållen för att inte
// bryta solo/arena-paths som ev. importerar den)
// ============================================================
const SOULDRAIN_DURATION = 5.0;
const SOULDRAIN_TICK = 1.0;
const SOULDRAIN_DMG_PCT = 0.05;
const SOULDRAIN_SLOW_PER_STACK = 0.10;
const SOULDRAIN_MAX_STACKS = 5;
const SOULDRAIN_SLOW_TAIL = 1.0;
const SOULDRAIN_RANGE = 10.0;
const SOULDRAIN_BREAK_RANGE = 12.0;

function castSoulDrain(state, sideIdx, ev) {
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.q.cd > 0) return;
  if (side.soulDrain) side.soulDrain = null;
  const opp = arenaOpp(state, sideIdx);
  // Sätt CD FÖRST så klientens optimistic CD synkar med server, även om vi
  // bail:ar utan target nedan. Annars: klient ser CD i 4s utan att server
  // har satt det → vid nästa cast är klient blockerad men server tillåter.
  side.skills.q.cd = side.skills.q.max * gandulfCdrMul(side);
  // Hitta target: tap → låst targetId, annars närmsta i range
  let target = null, targetType = null;
  if (ev && ev.tap === true && side.targetId) {
    const t = resolveTargetEntity(side, opp, state);
    if (t) { target = t; targetType = side.targetType; }
  }
  if (!target) {
    const t = findClosestHostile(side, opp, side.hero.x, side.hero.z, SOULDRAIN_RANGE, state);
    if (t) {
      target = t.entity;
      targetType = t.isMonster ? 'monster' : 'creep';
    }
  }
  if (target) {
    const drainDuration = SOULDRAIN_DURATION + (engineHasTalent(state, side, 'm_drain_extend') ? 2 : 0);
    side.soulDrain = {
      remaining: drainDuration,
      tickAccum: 0,
      stacks: 0,
      targetId: target.id,
      targetType,
    };
    applySoulDrainTick(state, side, opp);
  } else {
    // Inget target — fallback: AoE "vampire wave" runt hero så Q alltid gör
    // något när det castas (annars ser användaren bara CD-bar utan effekt).
    const skillMul = (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1) * gandulfSkillDmgMul(side);
    const r2 = (SOULDRAIN_RANGE * 0.5) * (SOULDRAIN_RANGE * 0.5);
    let healed = 0;
    for (let i = side.monsters.length - 1; i >= 0; i--) {
      const m = side.monsters[i];
      const ddx = m.x - side.hero.x, ddz = m.z - side.hero.z;
      if (ddx * ddx + ddz * ddz < r2) {
        const dmg = (m.maxHp || m.hp) * SOULDRAIN_DMG_PCT * 2 * skillMul;
        const dealt = Math.min(dmg, m.hp);
        applySkillDamageToMonster(state, side, opp, i, dmg);
        healed += dealt;
      }
    }
    if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
      const c = opp.playerCreeps[i];
      const ddx = c.x - side.hero.x, ddz = c.z - side.hero.z;
      if (ddx * ddx + ddz * ddz < r2) {
        const dmg = (c.maxHp || c.hp) * SOULDRAIN_DMG_PCT * 2 * skillMul;
        const dealt = Math.min(dmg, c.hp);
        applySkillDamageToCreep(state, side, opp, c, dmg);
        healed += dealt;
        if (c.hp <= 0) { opp.playerCreeps.splice(i, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
      }
    }
    if (!side.hero.dead && healed > 0) {
      side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + healed * 0.4);
    }
  }
}

function resolveSoulDrainTargetServer(side, opp) {
  const sd = side.soulDrain;
  if (!sd) return null;
  if (sd.targetType === 'monster') {
    for (const m of side.monsters) if (m.id === sd.targetId && m.hp > 0) return m;
    return null;
  }
  if (sd.targetType === 'creep' && opp) {
    for (const c of opp.playerCreeps) if (c.id === sd.targetId && c.hp > 0) return c;
    return null;
  }
  return null;
}

function applySoulDrainTick(state, side, opp) {
  const sd = side.soulDrain;
  if (!sd) return;
  const target = resolveSoulDrainTargetServer(side, opp);
  if (!target) { side.soulDrain = null; return; }
  sd.stacks = Math.min(SOULDRAIN_MAX_STACKS, (sd.stacks || 0) + 1);
  const maxHp = target.maxHp || target.hp || 1;
  const dmg = maxHp * SOULDRAIN_DMG_PCT * (side.skillDmgMul || 1) *
              (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1) *
              gandulfSkillDmgMul(side);
  const slowMul = 1 - SOULDRAIN_SLOW_PER_STACK * sd.stacks;
  if (sd.targetType === 'monster') {
    const idx = side.monsters.indexOf(target);
    if (idx >= 0) {
      onGandulfSkillHit(side, target);
      applySkillDamageToMonster(state, side, opp, idx, dmg);
      if (side.monsters[idx] === target && target.hp > 0) {
        target.slowMul = Math.min(target.slowMul || 1, slowMul);
        target.slowTime = Math.max(target.slowTime || 0, SOULDRAIN_SLOW_TAIL);
      }
    }
  } else if (sd.targetType === 'creep' && opp) {
    onGandulfSkillHit(side, target);
    applySkillDamageToCreep(state, side, opp, target, dmg);
    if (target.hp > 0) {
      target.slowMul = Math.min(target.slowMul || 1, slowMul);
      target.slowTime = Math.max(target.slowTime || 0, SOULDRAIN_SLOW_TAIL);
    } else {
      const i = opp.playerCreeps.indexOf(target);
      if (i >= 0) { opp.playerCreeps.splice(i, 1); side.gold += minionBounty(target); gainXp(side, minionXp(target)); }
    }
  }
  // Heal Gandulf — Soul Drain är vampyr-skill
  if (!side.hero.dead) side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + dmg * 0.4);
}

function updateSoulDrain(state, side, opp, dt) {
  if (!side.soulDrain) return;
  const sd = side.soulDrain;
  if (side.hero.dead) { side.soulDrain = null; return; }
  // Bryt-range: om target rör sig för långt bort, bryt drain
  const target = resolveSoulDrainTargetServer(side, opp);
  if (!target) { side.soulDrain = null; return; }
  const d = Math.hypot(target.x - side.hero.x, target.z - side.hero.z);
  if (d > SOULDRAIN_BREAK_RANGE) { side.soulDrain = null; return; }
  sd.remaining -= dt;
  if (sd.remaining <= 0) { side.soulDrain = null; return; }
  sd.tickAccum = (sd.tickAccum || 0) + dt;
  while (sd.tickAccum >= SOULDRAIN_TICK) {
    sd.tickAccum -= SOULDRAIN_TICK;
    applySoulDrainTick(state, side, opp);
    if (!side.soulDrain) return;
  }
}

// ============================================================
// ARAGURN SKILLS (server-auth för line wars)
// ============================================================
const WHIRLWIND_DURATION = 3.0;
const WHIRLWIND_TICK = 0.5;
const WHIRLWIND_RADIUS = 3.6;              // +20% (3.0 → 3.6)
const WHIRLWIND_DMG_PCT = 0.05;      // nerf tillbaka från 0.075 (~194% maxHP/3s i max-arena var för högt)
const WHIRLWIND_HEAL_PCT = 0.10;     // Aragurn healar 10% av all damage done från whirlwind

// Aragurn passive — Lifesteal (proportional till HP loss) + DR (baserat på nearby enemies)
const ARAGURN_LIFESTEAL_PER_HP_LOSS = 0.005;   // 0.5% lifesteal per 1% HP loss → max 50% vid 0 HP
const ARAGURN_DR_RADIUS = 5.0;                  // 5m radius runt hero för enemy-count
const ARAGURN_DR_BASE_1 = 0.20;                 // 1 enemy nearby = 20% DR
const ARAGURN_DR_EXTRA_PER_ENEMY = 0.05;        // +5% per extra enemy utöver första
const ARAGURN_DR_MAX = 0.40;                    // cap 40%

// Helper: räkna fiender (monster + opp creeps + opp hero) inom radius runt hero
function elarNearbyCount(state, side) {
  if (!side || side.heroId !== 'elar' || side.hero.dead) return 0;
  const r2 = ARAGURN_DR_RADIUS * ARAGURN_DR_RADIUS;
  const hx = side.hero.x, hz = side.hero.z;
  let count = 0;
  for (const m of side.monsters) {
    const dx = m.x - hx, dz = m.z - hz;
    if (dx * dx + dz * dz < r2) count++;
  }
  // Boss wars co-op: `3 - side.idx` ger medspelare/undefined → null (bossen räknas redan via side.monsters ovan).
  const opp = (state.mode === 'bosswars') ? null : arenaOpp(state, side.idx);
  if (opp) {
    for (const c of opp.playerCreeps) {
      const dx = c.x - hx, dz = c.z - hz;
      if (dx * dx + dz * dz < r2) count++;
    }
    if (isHeroPvpActive(state) && !opp.hero.dead) {
      const dx = opp.hero.x - hx, dz = opp.hero.z - hz;
      if (dx * dx + dz * dz < r2) count++;
    }
  }
  return count;
}

// Helper: DR från Aragurn-passive baserat på cached nearby-count (uppdateras 1Hz i tick-loop).
function elarPassiveDR(side) {
  if (!side || side.heroId !== 'elar') return 0;
  const n = side.elarNearbyCount || 0;
  if (n <= 0) return 0;
  if (n === 1) return ARAGURN_DR_BASE_1;
  // 2+ enemies: 20% baseline + 5% per extra (cap 40%)
  return Math.min(ARAGURN_DR_MAX, ARAGURN_DR_BASE_1 + (n - 1) * ARAGURN_DR_EXTRA_PER_ENEMY);
}

// Helper: lifesteal heal baserat på HP loss-pct. Anropas efter varje damage-app
// där `side` är attacker. Heal 0.5% av dealt damage per 1% HP loss (max 50% av dmg).
function elarLifestealHeal(side, dmgDealt) {
  if (!side || side.heroId !== 'elar' || side.hero.dead || dmgDealt <= 0) return;
  const hpLossPct = Math.max(0, 1 - (side.hero.hp / Math.max(1, side.hero.maxHp)));
  const lifestealPct = hpLossPct * 100 * ARAGURN_LIFESTEAL_PER_HP_LOSS;   // 0.5% × loss%
  if (lifestealPct <= 0) return;
  const heal = dmgDealt * lifestealPct;
  side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + heal);
}
const WHIRLWIND_MS_BUFF = 0.20;
const SHOUT_LENGTH = 8.0;
const SHOUT_HALF_ANGLE = Math.PI / 3;
const SHOUT_DIRECT_DMG_PCT = 0.15;
const SHOUT_SLOW_DURATION = 3.0;
const SHOUT_SLOW_MUL = 0.80;
const SHOUT_HEAL_DURATION = 2.0;
const SHOUT_HEAL_SELF_PCT = 0.10;
// E3 War Shout buff (utöver cone-skadan): self + allierade i stor cirkel får
// +20% MS / +20% utgående skada / +20% DR under fönstret. Allierade får även en
// (lägre) HoT. Buffen tickas i tickKryxTimers (alla loopar) så den gäller alla lägen.
const SHOUT_BUFF_DURATION = 4.0;
const SHOUT_BUFF_MS = 0.20;
const SHOUT_BUFF_DMG = 0.20;
const SHOUT_BUFF_DR = 0.20;
const SHOUT_BUFF_RADIUS = 8.0;       // stor buff-cirkel runt Aragurn
const SHOUT_HEAL_ALLY_PCT = 0.06;    // allierad HoT (lägre än Aragurns egen)
// +20% utgående skada medan War Shout-buffen är aktiv (self eller buffad allierad).
function elarShoutDmgMul(side) {
  return (side && (side.elarShoutBuffTime || 0) > 0) ? (1 + SHOUT_BUFF_DMG) : 1;
}
const LEAP_TRAVEL_TIME = 1.0;
const LEAP_MAX_DISTANCE = 11.5;
const LEAP_RADIUS = 4.55;
const LEAP_DMG_PCT = 0.20;
const LEAP_STUN_TIME = 1.0;

// Q: Whirlwind — spin 3s med tick-damage runt hero + MS-buff + CC-immun.
// CD sätts ENDAST när spin slutar (i updateAragurnWhirlwind). Att sätta CD här
// + igen vid slut skulle ge effektiv CD = WHIRLWIND_DURATION + cd.max.
function castAragurnWhirlwind(state, sideIdx) {
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.q.cd > 0) return;
  if ((side.whirlwindRemaining || 0) > 0) return;
  side.whirlwindRemaining = WHIRLWIND_DURATION + (engineHasTalent(state, side, 'a_spin_extend') ? 1.5 : 0);
  side.whirlwindTickAccum = 0;
  // Initial tick direkt
  applyWhirlwindTick(state, side, arenaOpp(state, sideIdx));
}

function applyWhirlwindTick(state, side, opp) {
  const r2 = WHIRLWIND_RADIUS * WHIRLWIND_RADIUS;
  const skillMul = (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1);
  let totalDealt = 0;   // Whirlwind heal: 10% av all damage done tickas till hero
  // Monsters
  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    const dx = m.x - side.hero.x, dz = m.z - side.hero.z;
    if (dx * dx + dz * dz < r2) {
      const dmg = (m.maxHp || m.hp) * WHIRLWIND_DMG_PCT * skillMul;
      const dealt = Math.min(m.hp, dmg * dmgTakenDebuffMul(m));
      applySkillDamageToMonster(state, side, opp, i, dmg);
      totalDealt += dealt;
    }
  }
  // Opp creeps
  if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
    const c = opp.playerCreeps[i];
    const dx = c.x - side.hero.x, dz = c.z - side.hero.z;
    if (dx * dx + dz * dz < r2) {
      const dmg = (c.maxHp || c.hp) * WHIRLWIND_DMG_PCT * skillMul;
      const dealt = Math.min(c.hp, dmg * dmgTakenDebuffMul(c));
      applySkillDamageToCreep(state, side, opp, c, dmg);
      totalDealt += dealt;
      if (c.hp <= 0) {
        opp.playerCreeps.splice(i, 1);
        side.gold += minionBounty(c);
        gainXp(side, minionXp(c));
      }
    }
  }
  // Duel: opp.hero
  if (isHeroPvpActive(state) && opp && !opp.hero.dead) {
    const dx = opp.hero.x - side.hero.x, dz = opp.hero.z - side.hero.z;
    if (dx * dx + dz * dz < r2) {
      const dmg = opp.hero.maxHp * WHIRLWIND_DMG_PCT * skillMul;
      const dealt = Math.min(opp.hero.hp, dmg * dmgTakenDebuffMul(opp.hero));
      applySkillDamageToOppHero(state, side, opp, dmg);
      totalDealt += dealt;
    }
  }
  // Heal Aragurn 10% av damage done (utöver passive lifesteal — stackar)
  if (totalDealt > 0 && !side.hero.dead) {
    side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + totalDealt * WHIRLWIND_HEAL_PCT);
  }
}

function updateAragurnWhirlwind(state, side, opp, dt) {
  if (!side.whirlwindRemaining || side.whirlwindRemaining <= 0) return;
  side.whirlwindRemaining -= dt;
  // CC-immun under spin
  side.heroSlowTime = 0; side.heroSlowMul = 1;
  side.heroASlowTime = 0; side.heroASlowMul = 1;   // CC-immun rensar även AS-slow (Stomp)
  side.hero.frozenTime = 0;
  side.hero.tauntedTime = 0;
  side.heroFearTime = 0;
  side.hero.dotRemaining = 0;
  side.hero.poisonRemaining = 0;
  side.whirlwindTickAccum = (side.whirlwindTickAccum || 0) + dt;
  while (side.whirlwindTickAccum >= WHIRLWIND_TICK && side.whirlwindRemaining > -WHIRLWIND_TICK) {
    side.whirlwindTickAccum -= WHIRLWIND_TICK;
    applyWhirlwindTick(state, side, opp);
  }
  if (side.whirlwindRemaining <= 0) {
    side.whirlwindRemaining = 0;
    // CD startar nu — först efter spin slutat (max innehåller CDR redan)
    side.skills.q.cd = side.skills.q.max;
  }
}

// F: War Shout — cone-damage framåt + slow på fiender + HoT på Aragurn
function castAragurnShout(state, sideIdx, dirX, dirZ) {
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.f.cd > 0) return;
  side.skills.f.cd = side.skills.f.max;
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.01) { dirX = side.hero.facingX; dirZ = side.hero.facingZ; }
  else { dirX /= len; dirZ /= len; }
  // HoT på Aragurn
  side.elarShoutHealRemaining = SHOUT_HEAL_DURATION;
  side.elarShoutHealPct = SHOUT_HEAL_SELF_PCT;
  // E3: self-buff (MS/dmg/DR) + ally-buff i stor cirkel (boss wars co-op). Ally får HoT med.
  side.elarShoutBuffTime = SHOUT_BUFF_DURATION;
  if (side.inBossWars) {
    const br2 = SHOUT_BUFF_RADIUS * SHOUT_BUFF_RADIUS;
    for (const idx of [1, 2, 3]) {
      if (idx === sideIdx) continue;
      const a = state.sides[idx];
      if (!a || a.hero.dead) continue;
      const dx = a.hero.x - side.hero.x, dz = a.hero.z - side.hero.z;
      if (dx * dx + dz * dz <= br2) {
        a.elarShoutBuffTime = SHOUT_BUFF_DURATION;
        a.elarShoutHealRemaining = SHOUT_HEAL_DURATION;
        a.elarShoutHealPct = SHOUT_HEAL_ALLY_PCT;
      }
    }
  }
  const opp = arenaOpp(state, sideIdx);
  const skillMul = (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1);
  // a_shout_radius talent: +30% cone length and half-angle
  const shoutRangeMul = engineHasTalent(state, side, 'a_shout_radius') ? 1.30 : 1.0;
  const shoutLength = SHOUT_LENGTH * shoutRangeMul;
  const shoutHalfAngle = SHOUT_HALF_ANGLE * shoutRangeMul;
  // Lvl 5: pull targets halvvägs mot Aragurn + 1s stun
  const isLvl5 = !!(side.skillLvl && side.skillLvl.f >= SKILL_LEVEL_MAX);
  const pullToward = (target) => {
    if (!isLvl5) return;
    target.x = side.hero.x + (target.x - side.hero.x) * (1 - ARAGURN_LVL5_SHOUT_PULL_PCT);
    target.z = side.hero.z + (target.z - side.hero.z) * (1 - ARAGURN_LVL5_SHOUT_PULL_PCT);
  };
  const inCone = (ex, ez) => {
    const ddx = ex - side.hero.x, ddz = ez - side.hero.z;
    const d = Math.hypot(ddx, ddz);
    if (d > shoutLength || d < 0.001) return false;
    const dot = (ddx * dirX + ddz * dirZ) / d;
    return Math.acos(Math.max(-1, Math.min(1, dot))) < shoutHalfAngle;
  };
  // Monsters
  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    if (!inCone(m.x, m.z)) continue;
    const dmg = (m.maxHp || m.hp) * SHOUT_DIRECT_DMG_PCT * skillMul;
    applySkillDamageToMonster(state, side, opp, i, dmg);
    if (side.monsters[i] === m && m.hp > 0) {
      m.slowMul = Math.min(m.slowMul || 1, SHOUT_SLOW_MUL);
      m.slowTime = Math.max(m.slowTime || 0, SHOUT_SLOW_DURATION);
      pullToward(m);
      if (isLvl5) m.frozenTime = Math.max(m.frozenTime || 0, ARAGURN_LVL5_SHOUT_STUN_DURATION);
    }
  }
  // Opp creeps
  if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
    const c = opp.playerCreeps[i];
    if (!inCone(c.x, c.z)) continue;
    const dmg = (c.maxHp || c.hp) * SHOUT_DIRECT_DMG_PCT * skillMul;
    applySkillDamageToCreep(state, side, opp, c, dmg);
    if (c.hp > 0) {
      c.slowMul = Math.min(c.slowMul || 1, SHOUT_SLOW_MUL);
      c.slowTime = Math.max(c.slowTime || 0, SHOUT_SLOW_DURATION);
      pullToward(c);
      if (isLvl5) c.frozenTime = Math.max(c.frozenTime || 0, ARAGURN_LVL5_SHOUT_STUN_DURATION);
    } else {
      opp.playerCreeps.splice(i, 1);
      side.gold += minionBounty(c);
      gainXp(side, minionXp(c));
    }
  }
  // Duel: opp.hero
  if (isHeroPvpActive(state) && opp && !opp.hero.dead && inCone(opp.hero.x, opp.hero.z)) {
    const dmg = opp.hero.maxHp * SHOUT_DIRECT_DMG_PCT * skillMul;
    applySkillDamageToOppHero(state, side, opp, dmg);
    opp.heroSlowMul = Math.min(opp.heroSlowMul || 1, SHOUT_SLOW_MUL);
    opp.heroSlowTime = Math.max(opp.heroSlowTime || 0, SHOUT_SLOW_DURATION);
    if (isLvl5) {
      // Pull opp.hero halvvägs (med CC-mul-reduktion på stun-duration)
      pullToward(opp.hero);
      const ccMul = Math.max(0, 1 - (opp.ccReductionPct || 0));
      opp.hero.frozenTime = Math.max(opp.hero.frozenTime || 0, ARAGURN_LVL5_SHOUT_STUN_DURATION * ccMul);
    }
  }
}

// Lvl 5 Hero Leap banner — tick livstid, applicera heal + buff-flagga om hero inom radie
function tickAragurnBannersLvl5(side, dt) {
  if (!side.elarBanners || side.elarBanners.length === 0) {
    side.inAragurnBanner = false;
    return;
  }
  let inAura = false;
  for (let i = side.elarBanners.length - 1; i >= 0; i--) {
    const b = side.elarBanners[i];
    b.life -= dt;
    if (b.life <= 0) { side.elarBanners.splice(i, 1); continue; }
    if (!side.hero.dead) {
      const ddx = side.hero.x - b.x, ddz = side.hero.z - b.z;
      if (ddx * ddx + ddz * ddz < ARAGURN_LVL5_BANNER_RADIUS * ARAGURN_LVL5_BANNER_RADIUS) {
        inAura = true;
        // Heal 5% maxHP per sek
        side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + side.hero.maxHp * ARAGURN_LVL5_BANNER_HEAL_PCT * dt);
      }
    }
  }
  side.inAragurnBanner = inAura;
}

function updateAragurnShoutHeal(side, dt) {
  if (!side.elarShoutHealRemaining || side.elarShoutHealRemaining <= 0) return;
  if (side.hero.dead) { side.elarShoutHealRemaining = 0; return; }
  const healAmt = side.hero.maxHp * (side.elarShoutHealPct || 0) * dt;
  if (healAmt > 0 && side.hero.hp < side.hero.maxHp) {
    side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + healAmt);
  }
  side.elarShoutHealRemaining -= dt;
  if (side.elarShoutHealRemaining <= 0) side.elarShoutHealPct = 0;
}

// E: Heroic Leap — hoppa till target-position, AoE damage + stun vid landning.
// Använder resolveSkillGroundTarget så drag-aim + tap-target-aim båda fungerar
// (samma pattern som Black Hole/Frost Nova). Klampar landings-pos mot walkability
// så hero inte landar inuti väggar/tower.
function castAragurnLeap(state, sideIdx, ev) {
  const side = state.sides[sideIdx];
  if (side.hero.dead || side.skills.e.cd > 0) return;
  if (side.elarLeap) return;   // redan i luften
  const opp = arenaOpp(state, sideIdx);
  const target = resolveSkillGroundTarget(state, side, opp, ev || {}, LEAP_MAX_DISTANCE);
  let tx = target.x, tz = target.z;
  const walkOpts = { inEnemyTerritory: side.inEnemyTerritory };
  // Walkability-clamp: om target ligger i icke-walkable terräng, gå tillbaka
  // mot hero i 0.5m-steg tills vi hittar walkable pos. Skippar leap helt om
  // ingen walkable mellan hero och target hittas.
  if (!heroWalk(side, tx, tz, walkOpts)) {
    const ddx = tx - side.hero.x, ddz = tz - side.hero.z;
    const d = Math.hypot(ddx, ddz);
    if (d < 0.1) return;   // för nära, skip
    const stepX = (ddx / d) * 0.5;
    const stepZ = (ddz / d) * 0.5;
    let foundWalkable = false;
    for (let testX = tx - stepX, testZ = tz - stepZ;
         Math.hypot(testX - side.hero.x, testZ - side.hero.z) > 0.4;
         testX -= stepX, testZ -= stepZ) {
      if (heroWalk(side, testX, testZ, walkOpts)) {
        tx = testX; tz = testZ;
        foundWalkable = true;
        break;
      }
    }
    if (!foundWalkable) return;   // ingen walkable pos längs leap-vägen
  }
  side.skills.e.cd = side.skills.e.max;
  side.elarLeap = {
    remaining: LEAP_TRAVEL_TIME,
    total: LEAP_TRAVEL_TIME,
    startX: side.hero.x, startZ: side.hero.z,
    targetX: tx, targetZ: tz,
  };
  // CC-immun under hopp
  side.hero.frozenTime = 0;
  side.hero.tauntedTime = 0;
  side.heroFearTime = 0;
}

function updateAragurnLeap(state, side, opp, dt) {
  if (!side.elarLeap) return;
  const lp = side.elarLeap;
  lp.remaining -= dt;
  // CC-immun under leap
  side.heroSlowTime = 0; side.heroSlowMul = 1;
  side.heroASlowTime = 0; side.heroASlowMul = 1;   // CC-immun rensar även AS-slow (Stomp)
  side.hero.frozenTime = 0;
  // Linjär xz-interpolation (server skickar position varje frame via snapshot)
  const u = Math.max(0, Math.min(1, 1 - lp.remaining / lp.total));
  side.hero.x = lp.startX + (lp.targetX - lp.startX) * u;
  side.hero.z = lp.startZ + (lp.targetZ - lp.startZ) * u;
  if (lp.remaining <= 0) {
    // Landning
    side.hero.x = lp.targetX;
    side.hero.z = lp.targetZ;
    applyAragurnLeapImpact(state, side, opp, lp.targetX, lp.targetZ);
    side.elarLeap = null;
  }
}

// Heal-pct per träffad fiende: 25% av (maxHP - currentHP) per hit.
const LEAP_HEAL_LOST_PCT = 0.25;

function applyAragurnLeapImpact(state, side, opp, x, z) {
  const skillMul = (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1);
  // Lvl 5: spawna banner på landings-pos
  if (side.skillLvl && side.skillLvl.e >= SKILL_LEVEL_MAX) {
    side.elarBanners = side.elarBanners || [];
    side.elarBanners.push({
      id: state.nextEntityId++,
      x, z,
      life: ARAGURN_LVL5_BANNER_DURATION,
      maxLife: ARAGURN_LVL5_BANNER_DURATION,
    });
  }
  const r2 = LEAP_RADIUS * LEAP_RADIUS;
  let hitCount = 0;
  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    const ddx = m.x - x, ddz = m.z - z;
    if (ddx * ddx + ddz * ddz < r2) {
      const dmg = (m.maxHp || m.hp) * LEAP_DMG_PCT * skillMul;
      applySkillDamageToMonster(state, side, opp, i, dmg);
      if (side.monsters[i] === m && m.hp > 0) m.frozenTime = Math.max(m.frozenTime || 0, LEAP_STUN_TIME);
      hitCount++;
    }
  }
  if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
    const c = opp.playerCreeps[i];
    const ddx = c.x - x, ddz = c.z - z;
    if (ddx * ddx + ddz * ddz < r2) {
      const dmg = (c.maxHp || c.hp) * LEAP_DMG_PCT * skillMul;
      applySkillDamageToCreep(state, side, opp, c, dmg);
      if (c.hp > 0) c.frozenTime = Math.max(c.frozenTime || 0, LEAP_STUN_TIME);
      else { opp.playerCreeps.splice(i, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
      hitCount++;
    }
  }
  if (isHeroPvpActive(state) && opp && !opp.hero.dead) {
    const ddx = opp.hero.x - x, ddz = opp.hero.z - z;
    if (ddx * ddx + ddz * ddz < r2) {
      const dmg = opp.hero.maxHp * LEAP_DMG_PCT * skillMul;
      applySkillDamageToOppHero(state, side, opp, dmg);
      opp.hero.frozenTime = Math.max(opp.hero.frozenTime || 0, LEAP_STUN_TIME);
      hitCount++;
    }
  }
  // Heal Aragurn: 25% av förlorad HP per träffad fiende (a_leap_heal talent: ×1.5)
  if (hitCount > 0 && !side.hero.dead) {
    const lost = Math.max(0, side.hero.maxHp - side.hero.hp);
    const healPct = LEAP_HEAL_LOST_PCT * (engineHasTalent(state, side, 'a_leap_heal') ? 1.5 : 1.0);
    const heal = lost * healPct * hitCount;
    side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + heal);
  }
}

// ============================================================
// KOSTEFO SKILLS (Joint Attack, Joint Slider, Cannabis Cloud, Joint Avengers, Smoke Companion)
// ============================================================

// Q: Joint Attack — bred AoE-zon framför hero, gås-stampede.
// Zonen står still i 3s, tickar 5% maxHP per 0.5s till alla fiender inom.
function castKostefoJointAttack(state, sideIdx, dirX, dirZ) {
  const side = state.sides[sideIdx];
  if (!side || side.hero.dead) return;
  if (side.skills.q.cd > 0) return;
  side.skills.q.cd = side.skills.q.max || KOSTEFO_GOOSEWAVE_CD;
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.01) { dirX = side.hero.facingX; dirZ = side.hero.facingZ; }
  else { dirX /= len; dirZ /= len; }
  // Zon-center placeras OFFSET + halv-length framför hero. Med offset 4m och
  // length 6.5m: bakkant 0.75m framför hero, framkant 7.25m. Zonen startar tydligt
  // framför Kostefo (ej direkt vid hans fötter) per user-spec.
  const fwd = KOSTEFO_GOOSEWAVE_OFFSET + KOSTEFO_GOOSEWAVE_LENGTH / 2;
  const cx = side.hero.x + dirX * fwd;
  const cz = side.hero.z + dirZ * fwd;
  side.kostefoGooseWaves.push({
    id: state.nextEntityId++,
    x: cx, z: cz,
    dx: dirX, dz: dirZ,
    width: KOSTEFO_GOOSEWAVE_WIDTH,
    length: KOSTEFO_GOOSEWAVE_LENGTH,
    remaining: KOSTEFO_GOOSEWAVE_DURATION,
    duration: KOSTEFO_GOOSEWAVE_DURATION,
    tickAccum: 0,
  });
}

// F: Joint Slider — piercing projectile, 6m, explosion vid slutet.
function castKostefoJointSlider(state, sideIdx, dirX, dirZ) {
  const side = state.sides[sideIdx];
  if (!side || side.hero.dead) return;
  // Lvl 5: om tp-marker aktiv → teleport till explosionspos istället för ny cast.
  // CD från initial cast tickar fortsatt (ingen ny CD-set vid tp).
  if (side.kostefoSliderTpMarker) {
    const m = side.kostefoSliderTpMarker;
    if (heroWalk(side, m.x, m.z)) {
      side.hero.x = m.x;
      side.hero.z = m.z;
    }
    side.kostefoSliderTpMarker = null;
    return;
  }
  if (side.skills.f.cd > 0) return;
  side.skills.f.cd = side.skills.f.max || KOSTEFO_SLIDER_CD;
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.01) { dirX = side.hero.facingX; dirZ = side.hero.facingZ; }
  else { dirX /= len; dirZ /= len; }
  // Homing: om hero har AA-target locked, slider jagar det target. Annars fri aim
  // (befintlig fri-cast beteende). Snapshot:as vid cast — om target dör mid-flight
  // fortsätter slider rakt fram i senaste kända riktning.
  let homingTargetType = null, homingTargetId = 0;
  if (side.aaActive && side.targetId) {
    homingTargetType = side.targetType;
    homingTargetId = side.targetId;
  }
  side.kostefoSliders.push({
    id: state.nextEntityId++,
    x: side.hero.x, z: side.hero.z,
    dx: dirX, dz: dirZ,
    traveled: 0,
    maxRange: KOSTEFO_SLIDER_RANGE,
    hitMon: [],          // monster-ids redan piercede
    hitCreep: [],        // creep-ids redan piercede
    hitOppHero: false,
    lvl5Tp: !!(side.skillLvl && side.skillLvl.f >= SKILL_LEVEL_MAX),
    homingTargetType, homingTargetId,
  });
}

// E: Cannabis Cloud — stationär dim-area vid cast-pos. Invis + buffs ges bara
// medan Kostefo står inom molnet (hero kan röra sig ut/in). Initial stun + heal
// triggas vid cast.
function castKostefoCannabisCloud(state, sideIdx) {
  const side = state.sides[sideIdx];
  if (!side || side.hero.dead) return;
  if (side.skills.e.cd > 0) return;
  side.skills.e.cd = side.skills.e.max || KOSTEFO_CLOUD_CD;
  side.kostefoCloudRemaining = KOSTEFO_CLOUD_DURATION;
  side.kostefoCloudTickAccum = 0;
  // Cloud läggs vid hero-pos och stannar — följer ej hero.
  side.kostefoCloudX = side.hero.x;
  side.kostefoCloudZ = side.hero.z;
  side.kostefoInCloud = true;          // hero startar inom radie (centered)
  // Lvl 5: +20% radie (lagras per cloud-cast via kostefoCloudRadiusMul)
  const isLvl5 = !!(side.skillLvl && side.skillLvl.e >= SKILL_LEVEL_MAX);
  side.kostefoCloudRadiusMul = isLvl5 ? KOSTEFO_LVL5_CLOUD_RADIUS_MUL : 1;
  // Lvl 5: spawna 1HP decoy-klon som springer åt slumpmässig riktning
  if (isLvl5) {
    const ang = Math.random() * Math.PI * 2;
    side.kostefoClones = side.kostefoClones || [];
    side.kostefoClones.push({
      id: state.nextEntityId++,
      x: side.hero.x, z: side.hero.z,
      dx: Math.cos(ang), dz: Math.sin(ang),
      ry: Math.atan2(Math.cos(ang), Math.sin(ang)),
      hp: 1,
      life: KOSTEFO_LVL5_CLONE_LIFETIME,
    });
  }
  // Initial heal: 25% maxHP direct
  side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + side.hero.maxHp * KOSTEFO_CLOUD_HEAL_PCT);
  // Initial stun + dmg-tick på alla inom radie (radien skalas vid lvl5)
  const opp = arenaOpp(state, sideIdx);
  const cx = side.kostefoCloudX, cz = side.kostefoCloudZ;
  const cloudR = KOSTEFO_CLOUD_RADIUS * (side.kostefoCloudRadiusMul || 1);
  const r2 = cloudR * cloudR;
  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    const ddx = m.x - cx, ddz = m.z - cz;
    if (ddx * ddx + ddz * ddz < r2) {
      m.frozenTime = Math.max(m.frozenTime || 0, KOSTEFO_CLOUD_STUN_DUR);
    }
  }
  if (opp) for (const c of opp.playerCreeps) {
    const ddx = c.x - cx, ddz = c.z - cz;
    if (ddx * ddx + ddz * ddz < r2) {
      c.frozenTime = Math.max(c.frozenTime || 0, KOSTEFO_CLOUD_STUN_DUR);
    }
  }
  if (isHeroPvpActive(state) && opp && !opp.hero.dead) {   // PvP-gate: stunna ej medspelare i boss wars
    const ddx = opp.hero.x - cx, ddz = opp.hero.z - cz;
    if (ddx * ddx + ddz * ddz < r2) {
      opp.hero.frozenTime = Math.max(opp.hero.frozenTime || 0, KOSTEFO_CLOUD_STUN_DUR);
    }
  }
}

// Tickar Joint Attack-wave: 0.5s damage-ticks inom rektangulär zon framför hero.
// Wave är stationär (placerad vid cast-tid) — fiender inom rektangeln får DoT.
function tickKostefoGooseWaves(state, side, opp, dt) {
  if (!side.kostefoGooseWaves || side.kostefoGooseWaves.length === 0) return;
  const skillMul = (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1);
  // Lvl 5: skill-level + skill-key Q (lagras vid cast snarare än check här,
  // men eftersom vi inte kan veta vilken skill-level som castade waven retroaktivt
  // använder vi nuvarande side.skillLvl.q. Funkar i praktiken eftersom lvl bara går uppåt.)
  const isLvl5 = !!(side.skillLvl && side.skillLvl.q >= SKILL_LEVEL_MAX);
  for (let i = side.kostefoGooseWaves.length - 1; i >= 0; i--) {
    const w = side.kostefoGooseWaves[i];
    w.remaining -= dt;
    w.tickAccum += dt;
    while (w.tickAccum >= KOSTEFO_GOOSEWAVE_TICK && w.remaining > -KOSTEFO_GOOSEWAVE_TICK) {
      w.tickAccum -= KOSTEFO_GOOSEWAVE_TICK;
      let tickHealAccum = 0;   // lvl5 lifesteal: sum dealt damage
      const halfW = w.width / 2, halfL = w.length / 2;
      // Lokal-koord-test: project punkt på dx/dz-axel + perpendicular
      for (let k = side.monsters.length - 1; k >= 0; k--) {
        const m = side.monsters[k];
        const rx = m.x - w.x, rz = m.z - w.z;
        const along = rx * w.dx + rz * w.dz;
        const side2 = rx * (-w.dz) + rz * w.dx;
        if (Math.abs(along) <= halfL && Math.abs(side2) <= halfW) {
          const dmg = (m.maxHp || m.hp) * KOSTEFO_GOOSEWAVE_DMG_PCT * skillMul;
          const dealt = Math.min(m.hp, dmg);
          applySkillDamageToMonster(state, side, opp, k, dmg);
          if (isLvl5) {
            tickHealAccum += dealt;
            if (side.monsters[k] === m && m.hp > 0) {
              m.slowTime = Math.max(m.slowTime || 0, KOSTEFO_LVL5_Q_SLOW_DURATION);
              m.slowMul = Math.min(m.slowMul == null ? 1 : m.slowMul, KOSTEFO_LVL5_Q_SLOW_MUL);
            }
          }
        }
      }
      if (opp) for (let k = opp.playerCreeps.length - 1; k >= 0; k--) {
        const c = opp.playerCreeps[k];
        const rx = c.x - w.x, rz = c.z - w.z;
        const along = rx * w.dx + rz * w.dz;
        const side2 = rx * (-w.dz) + rz * w.dx;
        if (Math.abs(along) <= halfL && Math.abs(side2) <= halfW) {
          const dmg = (c.maxHp || c.hp) * KOSTEFO_GOOSEWAVE_DMG_PCT * skillMul;
          const dealt = Math.min(c.hp, dmg);
          applySkillDamageToCreep(state, side, opp, c, dmg);
          if (isLvl5) {
            tickHealAccum += dealt;
            if (c.hp > 0) {
              c.slowTime = Math.max(c.slowTime || 0, KOSTEFO_LVL5_Q_SLOW_DURATION);
              c.slowMul = Math.min(c.slowMul == null ? 1 : c.slowMul, KOSTEFO_LVL5_Q_SLOW_MUL);
            }
          }
        }
      }
      if (isHeroPvpActive(state) && opp && !opp.hero.dead) {
        const rx = opp.hero.x - w.x, rz = opp.hero.z - w.z;
        const along = rx * w.dx + rz * w.dz;
        const side2 = rx * (-w.dz) + rz * w.dx;
        if (Math.abs(along) <= halfL && Math.abs(side2) <= halfW) {
          const dmg = opp.hero.maxHp * KOSTEFO_GOOSEWAVE_DMG_PCT * skillMul;
          const dealt = Math.min(opp.hero.hp, dmg);
          applySkillDamageToOppHero(state, side, opp, dmg);
          if (isLvl5) {
            tickHealAccum += dealt;
            const ccMul = Math.max(0, 1 - (opp.ccReductionPct || 0));
            opp.heroSlowTime = Math.max(opp.heroSlowTime || 0, KOSTEFO_LVL5_Q_SLOW_DURATION * ccMul);
            opp.heroSlowMul = Math.min(opp.heroSlowMul == null ? 1 : opp.heroSlowMul, KOSTEFO_LVL5_Q_SLOW_MUL);
          }
        }
      }
      // Lvl 5: heal Kostefo 10% av dealt dmg per tick
      if (isLvl5 && tickHealAccum > 0 && !side.hero.dead) {
        side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + tickHealAccum * KOSTEFO_LVL5_Q_LIFESTEAL_PCT);
      }
    }
    if (w.remaining <= 0) side.kostefoGooseWaves.splice(i, 1);
  }
}

// Tickar Joint Sliders: rör projektilen framåt, piercar igenom targets (gör direkt
// dmg + applicerar DoT), vid maxRange exploderar + AoE-slow/DoT.
function tickKostefoSliders(state, side, opp, dt) {
  if (!side.kostefoSliders || side.kostefoSliders.length === 0) return;
  const skillMul = (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1);
  const stepSpeed = KOSTEFO_SLIDER_SPEED;
  const hitR2 = KOSTEFO_SLIDER_RADIUS * KOSTEFO_SLIDER_RADIUS;
  for (let i = side.kostefoSliders.length - 1; i >= 0; i--) {
    const s = side.kostefoSliders[i];
    // Homing: justera dx/dz mot target's nuvarande position med smooth turn-rate.
    // Om target dog/försvann fortsätter slider rakt fram i senaste kända riktning.
    if (s.homingTargetType) {
      let tx = null, tz = null;
      if (s.homingTargetType === 'monster' && s.homingTargetId) {
        const m = side.monsters.find(x => x.id === s.homingTargetId);
        if (m && m.hp > 0) { tx = m.x; tz = m.z; }
      } else if (s.homingTargetType === 'creep' && s.homingTargetId && opp) {
        const c = opp.playerCreeps.find(x => x.id === s.homingTargetId);
        if (c && c.hp > 0) { tx = c.x; tz = c.z; }
      } else if (s.homingTargetType === 'hero' && opp && !opp.hero.dead) {
        tx = opp.hero.x; tz = opp.hero.z;
      }
      if (tx !== null) {
        const tdx = tx - s.x, tdz = tz - s.z;
        const td = Math.hypot(tdx, tdz);
        if (td > 0.05) {
          // 35% drag per frame mot target = smooth curving turn
          const ndx = tdx / td, ndz = tdz / td;
          const turnRate = 0.35;
          const newDx = s.dx + (ndx - s.dx) * turnRate;
          const newDz = s.dz + (ndz - s.dz) * turnRate;
          const nl = Math.hypot(newDx, newDz);
          if (nl > 0.01) { s.dx = newDx / nl; s.dz = newDz / nl; }
        }
      }
    }
    const step = stepSpeed * dt;
    s.x += s.dx * step;
    s.z += s.dz * step;
    s.traveled += step;
    // Pierce-träffar längs vägen (reverse-iterate så splice/killMonster inte
    // korrumperar iterationen — applySkillDamageToMonster → killMonster splicar
    // side.monsters, dito för opp.playerCreeps).
    for (let k = side.monsters.length - 1; k >= 0; k--) {
      const m = side.monsters[k];
      if (s.hitMon.indexOf(m.id) >= 0) continue;
      const rdx = m.x - s.x, rdz = m.z - s.z;
      if (rdx * rdx + rdz * rdz < hitR2) {
        s.hitMon.push(m.id);
        const dmg = (m.maxHp || m.hp) * KOSTEFO_SLIDER_DIRECT_PCT * skillMul;
        applySkillDamageToMonster(state, side, opp, k, dmg);
        if (side.monsters[k] === m && m.hp > 0) applyKostefoSliderDot(m, side);
      }
    }
    if (opp) for (let k = opp.playerCreeps.length - 1; k >= 0; k--) {
      const c = opp.playerCreeps[k];
      if (s.hitCreep.indexOf(c.id) >= 0) continue;
      const rdx = c.x - s.x, rdz = c.z - s.z;
      if (rdx * rdx + rdz * rdz < hitR2) {
        s.hitCreep.push(c.id);
        const dmg = (c.maxHp || c.hp) * KOSTEFO_SLIDER_DIRECT_PCT * skillMul;
        applySkillDamageToCreep(state, side, opp, c, dmg);
        if (c.hp > 0) applyKostefoSliderDot(c, side);
        else { opp.playerCreeps.splice(k, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); }
      }
    }
    if (isHeroPvpActive(state) && opp && !opp.hero.dead && !s.hitOppHero) {
      const rdx = opp.hero.x - s.x, rdz = opp.hero.z - s.z;
      if (rdx * rdx + rdz * rdz < hitR2) {
        s.hitOppHero = true;
        const dmg = opp.hero.maxHp * KOSTEFO_SLIDER_DIRECT_PCT * skillMul;
        applySkillDamageToOppHero(state, side, opp, dmg);
        if (!opp.hero.dead) applyKostefoSliderDot(opp.hero, side);
      }
    }
    if (s.traveled >= s.maxRange) {
      // Explosion vid slutet: AoE + slow + DoT på alla träffade
      applyKostefoSliderExplosion(state, side, opp, s.x, s.z, skillMul);
      // Lvl 5: starta tp-marker — 3s re-cast-fönster för tp till explosionspos
      if (s.lvl5Tp) {
        side.kostefoSliderTpMarker = {
          x: s.x, z: s.z,
          remaining: KOSTEFO_LVL5_SLIDER_TP_WINDOW,
        };
      }
      side.kostefoSliders.splice(i, 1);
    }
  }
}

// Lvl-5 Joint Slider: dekrementera tp-marker. När expirerar → clear.
function tickKostefoSliderTpMarker(side, dt) {
  if (!side.kostefoSliderTpMarker) return;
  side.kostefoSliderTpMarker.remaining -= dt;
  if (side.kostefoSliderTpMarker.remaining <= 0) {
    side.kostefoSliderTpMarker = null;
  }
}

// Lvl-5 Cannabis Cloud-klon — walk:ar åt slumpmässig riktning, despawn vid death/life-end.
function tickKostefoClonesLvl5(side, dt) {
  if (!side.kostefoClones || side.kostefoClones.length === 0) return;
  for (let i = side.kostefoClones.length - 1; i >= 0; i--) {
    const k = side.kostefoClones[i];
    k.life -= dt;
    k.x += k.dx * KOSTEFO_LVL5_CLONE_SPEED * dt;
    k.z += k.dz * KOSTEFO_LVL5_CLONE_SPEED * dt;
    if (k.life <= 0 || k.hp <= 0) side.kostefoClones.splice(i, 1);
  }
}

function applyKostefoSliderDot(target, side) {
  target.kostefoDotRemaining = KOSTEFO_SLIDER_DOT_DUR;
  target.kostefoDotPerSec = (target.maxHp || target.hp || 100) * KOSTEFO_SLIDER_DOT_PER_SEC;
  target.kostefoDotOwnerSide = side.idx;
}

function applyKostefoSliderExplosion(state, side, opp, x, z, skillMul) {
  const r2 = KOSTEFO_SLIDER_EXPLOSION_RADIUS * KOSTEFO_SLIDER_EXPLOSION_RADIUS;
  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    const ddx = m.x - x, ddz = m.z - z;
    if (ddx * ddx + ddz * ddz < r2) {
      // Direct-dmg vid explosion (samma som pierce)
      const dmg = (m.maxHp || m.hp) * KOSTEFO_SLIDER_DIRECT_PCT * skillMul;
      applySkillDamageToMonster(state, side, opp, i, dmg);
      if (side.monsters[i] === m && m.hp > 0) {
        m.slowTime = KOSTEFO_SLIDER_SLOW_DUR;
        m.slowMul = KOSTEFO_SLIDER_SLOW_MUL;
        applyKostefoSliderDot(m, side);
      }
    }
  }
  if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
    const c = opp.playerCreeps[i];
    const ddx = c.x - x, ddz = c.z - z;
    if (ddx * ddx + ddz * ddz < r2) {
      const dmg = (c.maxHp || c.hp) * KOSTEFO_SLIDER_DIRECT_PCT * skillMul;
      applySkillDamageToCreep(state, side, opp, c, dmg);
      if (c.hp > 0) {
        c.slowTime = KOSTEFO_SLIDER_SLOW_DUR;
        c.slowMul = KOSTEFO_SLIDER_SLOW_MUL;
        applyKostefoSliderDot(c, side);
      } else {
        opp.playerCreeps.splice(i, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c));
      }
    }
  }
  if (isHeroPvpActive(state) && opp && !opp.hero.dead) {
    const ddx = opp.hero.x - x, ddz = opp.hero.z - z;
    if (ddx * ddx + ddz * ddz < r2) {
      const dmg = opp.hero.maxHp * KOSTEFO_SLIDER_DIRECT_PCT * skillMul;
      applySkillDamageToOppHero(state, side, opp, dmg);
      if (!opp.hero.dead) {
        opp.heroSlowTime = KOSTEFO_SLIDER_SLOW_DUR;
        opp.heroSlowMul = KOSTEFO_SLIDER_SLOW_MUL;
        applyKostefoSliderDot(opp.hero, side);
      }
    }
  }
}

// Tickar slider-DoT på alla entities med kostefoDotRemaining > 0.
// (Skannar alla monsters/creeps — billigt: ~30 + 30 iterationer.)
function tickKostefoSliderDots(state, side, opp, dt) {
  for (let i = side.monsters.length - 1; i >= 0; i--) {
    const m = side.monsters[i];
    if ((m.kostefoDotRemaining || 0) > 0) {
      m.kostefoDotRemaining -= dt;
      m.hp -= bossWarsDmgMod(m, (m.kostefoDotPerSec || 0) * dt);   // 5%-tak/immunitet/DR (no-op icke-boss)
      if (m.hp <= 0) { killMonster(side, i, side); continue; }
      if (m.kostefoDotRemaining <= 0) { m.kostefoDotRemaining = 0; m.kostefoDotPerSec = 0; }
    }
  }
  if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
    const c = opp.playerCreeps[i];
    if ((c.kostefoDotRemaining || 0) > 0) {
      c.kostefoDotRemaining -= dt;
      c.hp -= (c.kostefoDotPerSec || 0) * dt;
      if (c.hp <= 0) { opp.playerCreeps.splice(i, 1); side.gold += minionBounty(c); gainXp(side, minionXp(c)); continue; }
      if (c.kostefoDotRemaining <= 0) { c.kostefoDotRemaining = 0; c.kostefoDotPerSec = 0; }
    }
  }
}

// Tickar Cannabis Cloud: stationär vid cast-pos. Beräknar hero-in-cloud per
// tick (used för invis/buffs i andra funktioner). Dmg-tick på fiender inom radie.
function tickKostefoCloud(state, side, opp, dt) {
  if ((side.kostefoCloudRemaining || 0) <= 0) {
    side.kostefoInCloud = false;
    return;
  }
  side.kostefoCloudRemaining -= dt;
  side.kostefoCloudTickAccum += dt;
  const cx = side.kostefoCloudX, cz = side.kostefoCloudZ;
  // Lvl 5 utökar cloud-radie via kostefoCloudRadiusMul (1.0 default, 1.20 vid lvl5)
  const cloudR = KOSTEFO_CLOUD_RADIUS * (side.kostefoCloudRadiusMul || 1);
  const r2 = cloudR * cloudR;
  // Recompute "hero inom moln" varje tick — buffs/invis baseras på detta.
  const hddx = side.hero.x - cx, hddz = side.hero.z - cz;
  side.kostefoInCloud = !side.hero.dead && (hddx * hddx + hddz * hddz < r2);
  if (side.kostefoCloudRemaining <= 0) side.kostefoInCloud = false;
  while (side.kostefoCloudTickAccum >= KOSTEFO_CLOUD_TICK && side.kostefoCloudRemaining > -KOSTEFO_CLOUD_TICK) {
    side.kostefoCloudTickAccum -= KOSTEFO_CLOUD_TICK;
    const skillMul = (side.skillDmgMul || 1) * (side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1);
    for (let i = side.monsters.length - 1; i >= 0; i--) {
      const m = side.monsters[i];
      const ddx = m.x - cx, ddz = m.z - cz;
      if (ddx * ddx + ddz * ddz < r2) {
        const dmg = m.hp * KOSTEFO_CLOUD_DMG_PCT * skillMul;
        applySkillDamageToMonster(state, side, opp, i, dmg);
      }
    }
    if (opp) for (let i = opp.playerCreeps.length - 1; i >= 0; i--) {
      const c = opp.playerCreeps[i];
      const ddx = c.x - cx, ddz = c.z - cz;
      if (ddx * ddx + ddz * ddz < r2) {
        const dmg = c.hp * KOSTEFO_CLOUD_DMG_PCT * skillMul;
        applySkillDamageToCreep(state, side, opp, c, dmg);
      }
    }
    if (isHeroPvpActive(state) && opp && !opp.hero.dead) {
      const ddx = opp.hero.x - cx, ddz = opp.hero.z - cz;
      if (ddx * ddx + ddz * ddz < r2) {
        const dmg = opp.hero.hp * KOSTEFO_CLOUD_DMG_PCT * skillMul;
        applySkillDamageToOppHero(state, side, opp, dmg);
      }
    }
  }
}

// Joint Avengers (R): 8 joints orbiterar Kostefo + skjuter AA-kopior på närmaste target.
function tickKostefoUltJoints(state, side, opp, dt) {
  if ((side.kostefoUltRemaining || 0) <= 0) return;
  side.kostefoUltRemaining -= dt;
  if (!side.kostefoUltJoints) return;
  // Joints attackerar BARA samma target som Kostefo just nu AA:ar mot (global
  // range — joints kan träffa oavsett avstånd). Om Kostefo inte attackerar
  // (aaActive=false eller targetId=0) → joints attackerar inte heller.
  // Resolverar target en gång per tick (inte per joint) — sparar ~8 lookups.
  const heroIsAttacking = side.aaActive && !side.hero.dead && (side.targetId > 0 || side.targetType === 'hero' || side.targetType === 'duelOrb' || side.targetType === 'arenaOrb');
  let target = null;          // entity (m / creep / opp.hero / orb)
  let targetKind = null;      // 'monster' | 'creep' | 'hero' | 'duelOrb' | 'arenaOrb'
  if (heroIsAttacking) {
    target = resolveTargetEntity(side, opp, state);
    if (target) {
      if (side.targetType === 'hero') targetKind = 'hero';
      else if (side.targetType === 'duelOrb') targetKind = 'duelOrb';
      else if (side.targetType === 'arenaOrb') targetKind = 'arenaOrb';
      else if (side.targetType === 'monster') targetKind = 'monster';
      else if (side.targetType === 'creep') targetKind = 'creep';
    }
  }
  for (const j of side.kostefoUltJoints) {
    j.angle += KOSTEFO_ULT_ORBIT_SPEED * dt;
    j.attackCd = Math.max(0, (j.attackCd || 0) - dt);
    if (j.attackCd > 0) continue;
    if (!target || !targetKind) continue;   // Inget target → ingen attack
    const baseDmg = side.attackDmg * KOSTEFO_ULT_DMG_RATIO;
    const auraDmg = side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1;
    const dmg = baseDmg * auraDmg;
    let dealt = 0;
    if (targetKind === 'hero') {
      if (opp && !opp.hero.dead) { dealt = Math.min(opp.hero.hp, dmg); damageHero(opp, dmg); }
    } else if (targetKind === 'monster') {
      const idx = side.monsters.indexOf(target);
      if (idx >= 0) { dealt = Math.min(target.hp, dmg); applySkillDamageToMonster(state, side, opp, idx, dmg); }
    } else if (targetKind === 'creep') {
      dealt = Math.min(target.hp, dmg);
      applySkillDamageToCreep(state, side, opp, target, dmg);
      if (target.hp <= 0 && opp) {
        const idx = opp.playerCreeps.indexOf(target);
        if (idx >= 0) { opp.playerCreeps.splice(idx, 1); side.gold += minionBounty(target); gainXp(side, minionXp(target)); }
      }
    } else if (targetKind === 'duelOrb') {
      // Duel big-orb: Kostefo's joints kan damaga orben under duel om Kostefo
      // själv targetar den (annars förblir joints idle).
      if (state.duelBigOrb && state.duelBigOrb.alive) {
        dealt = Math.min(state.duelBigOrb.hp, dmg);
        damageDuelBigOrb(state, dmg, side.idx);
      }
    } else if (targetKind === 'arenaOrb') {
      // Arena1v1 center-orb: joints skadar den om Kostefo själv targetar den.
      if (state.orb && state.orb.alive) {
        dealt = Math.min(state.orb.hp, dmg);
        damageArenaOrbServer(state, dmg, side.idx);
      }
    }
    // Lifesteal: 50% av dealt dmg → heal Kostefo
    if (dealt > 0 && !side.hero.dead) {
      side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + dealt * KOSTEFO_ULT_LIFESTEAL);
    }
    j.attackCd = KOSTEFO_COMPANION_AA_INTERVAL;
  }
  if (side.kostefoUltRemaining <= 0) {
    side.kostefoUltRemaining = 0;
    side.kostefoUltJoints = [];
  }
}

// Smoke Companion (passive): följer Kostefo, kopierar AA med 25% dmg, healar Kostefo med dealt dmg.
function tickKostefoCompanion(state, side, opp, dt) {
  if (side.heroId !== 'kostefo' || side.hero.dead) {
    side.kostefoCompanion = null;
    return;
  }
  if (!side.kostefoCompanion) {
    side.kostefoCompanion = {
      x: side.hero.x - KOSTEFO_COMPANION_FOLLOW_DIST,
      z: side.hero.z, ry: 0,
      attackCd: 0,
    };
  }
  const comp = side.kostefoCompanion;
  // Follow Kostefo med ~1.6 m offset bakom hero (motsatt facing-riktning)
  const tx = side.hero.x - side.hero.facingX * KOSTEFO_COMPANION_FOLLOW_DIST;
  const tz = side.hero.z - side.hero.facingZ * KOSTEFO_COMPANION_FOLLOW_DIST;
  const lerpK = 1 - Math.pow(0.5, dt / 0.10);
  comp.x += (tx - comp.x) * lerpK;
  comp.z += (tz - comp.z) * lerpK;
  comp.ry = Math.atan2(side.hero.facingX, side.hero.facingZ);
  // AA-tick
  comp.attackCd = Math.max(0, comp.attackCd - dt);
  if (comp.attackCd > 0) return;
  const t = findClosestHostile(side, opp, comp.x, comp.z, KOSTEFO_COMPANION_AA_RANGE, state);
  if (!t) return;
  const baseDmg = side.attackDmg * KOSTEFO_COMPANION_DMG_RATIO;
  const auraDmg = side.heroFountainAura ? FOUNTAIN_DMG_MUL : 1;
  const dmg = baseDmg * auraDmg;
  let dealt = 0;
  if (t.isHero) {
    if (opp && !opp.hero.dead) { dealt = Math.min(opp.hero.hp, dmg); damageHero(opp, dmg); }
  } else if (t.isMonster) {
    const idx = side.monsters.indexOf(t.entity);
    if (idx >= 0) { dealt = Math.min(t.entity.hp, dmg); applySkillDamageToMonster(state, side, opp, idx, dmg); }
  } else if (!t.isDuelOrb) {
    dealt = Math.min(t.entity.hp, dmg);
    applySkillDamageToCreep(state, side, opp, t.entity, dmg);
    if (t.entity.hp <= 0 && opp) {
      const idx = opp.playerCreeps.indexOf(t.entity);
      if (idx >= 0) { opp.playerCreeps.splice(idx, 1); side.gold += minionBounty(t.entity); gainXp(side, minionXp(t.entity)); }
    }
  }
  if (dealt > 0 && !side.hero.dead) {
    side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + dealt);
  }
  comp.attackCd = KOSTEFO_COMPANION_AA_INTERVAL;
}

// Samlad tick för alla Kostefo-skills — kallas från båda spel-loopar (duel + main).
function tickKostefoSkills(state, side, opp, dt) {
  if (!side) return;
  tickKostefoGooseWaves(state, side, opp, dt);
  tickKostefoSliders(state, side, opp, dt);
  tickKostefoSliderDots(state, side, opp, dt);
  tickKostefoCloud(state, side, opp, dt);
  tickKostefoUltJoints(state, side, opp, dt);
  tickKostefoCompanion(state, side, opp, dt);
  // Lvl 5 add-ons
  tickKostefoSliderTpMarker(side, dt);
  tickKostefoClonesLvl5(side, dt);
}

// Movement wrapper used by EVERY mode-tick: if an auto-attack target is locked but out of attack
// range (ATK pressed up to 1.5× range), run toward it to attack; otherwise apply the joystick.
function heroAutoMove(side, j, dt) {
  const jx = j ? j.x : 0, jz = j ? j.z : 0;
  // The joystick is the ONLY movement input — there is NO auto-chase/taunt toward an AA target
  // (user 2026-06-20 v2: a manual tap does nothing if the target is out of range; you walk in
  // yourself). applyMovement briefly freezes during the AA swing (aaMoveLockTime).
  if ((Math.abs(jx) + Math.abs(jz)) > 0.05) applyMovement(side, jx, jz, dt);
}

function applyMovement(side, joyX, joyZ, dt) {
  if (side.hero.dead) return;
  // Magiker laser ult (R3, user): ROOTED while the beam fires — can't run, but can still TURN to
  // aim it (the beam swings toward facing). Returns before the move step so position is locked; the
  // laser tick tops up aaMoveLockTime so clients freeze prediction via `aml` (no rubber-band).
  if (side.laserBeam && side.laserBeam.remaining > 0) {
    const lmag = Math.hypot(joyX, joyZ);
    if (lmag >= 0.05) { side.hero.facingX = joyX / lmag; side.hero.facingZ = joyZ / lmag; }
    return;
  }
  // Attack-move (tap-to-AA, user 2026-06-20 v2): each manual AA briefly commits the hero to the
  // swing — movement freezes for aaMoveLockTime (a fraction of the attack interval) while the hero
  // faces the target, then the joystick resumes. No taunt/chase: this is a short per-tap stop only.
  if ((side.aaMoveLockTime || 0) > 0) return;
  // Arena server-auth: hard-CC (freeze/root/stun via frozenTime, ice-block) stoppar
  // rörelse helt — annars var CC kosmetisk (timern tickade men hjälten rörde sig).
  // Gatead till arena1v1 så classic-rörelse är orörd. Klienten speglar via readLocalJoystick.
  // heroFearTime tillagd (QA 2026-06-17) — feared människo-spelare kunde annars gå fritt.
  if ((side.inArena1v1 || side.inBossWars) && ((side.hero.frozenTime || 0) > 0 || (side.iceBlockRemaining || 0) > 0 || (side.heroFearTime || 0) > 0)) return;
  const mag = Math.hypot(joyX, joyZ);
  if (mag < 0.05) return;
  // Full movement-speed så fort en riktning valts (användarbeslut 2026-06-04) —
  // ingen graderad hastighet. Speglar klientens applyMovement (annars rubber-band).
  const strength = 1;
  const ndx = joyX / mag, ndz = joyZ / mag;
  if (side.zheynaUltCharging) zheynaTurnToward(side, ndx, ndz, dt);   // turn-rate-begränsad sikt under ult-laddning
  else { side.hero.facingX = ndx; side.hero.facingZ = ndz; }
  // Slow (Kostefo Slider / Aragurn Shout / Gimlu Hammer lvl5) — appliceras nu på
  // rörelsen (saknades). Arena-gatead. heroSlowMul = 1 när ej slowad (bf2d230).
  const slowMul = ((side.inArena1v1 || side.inBossWars) && (side.heroSlowTime || 0) > 0) ? (side.heroSlowMul || 1) : 1;
  const speedMul = (side.duelSpeedBuffRemaining > 0) ? (1 + DUEL_ORB_SPEED_BONUS) : 1;
  const invisMul = (side.nyroInvisRemaining > 0) ? (1 + LEGOLUS_INVIS_SPEED_BONUS) : 1;
  const cloudMul = side.kostefoInCloud ? (1 + KOSTEFO_CLOUD_MS_BONUS) : 1;
  // Lvl-5 MS-buffs (Gandulf Wind Puff, Gimlu Hammer, Aragurn banner m.fl.)
  const wpMul = (side.windPuffMsRem || 0) > 0 ? GANDULF_LVL5_WP_MS_MUL : 1;
  const hammerMul = (side.kryxHammerMsRem || 0) > 0 ? GIMLU_LVL5_HAMMER_MS_MUL : 1;
  const bannerMul = side.inAragurnBanner ? (1 + ARAGURN_LVL5_BANNER_MS_BONUS) : 1;
  // Zyro passive: +10% MS per stack (max 30%) under buff-duration.
  const zyroPassiveMs = (side.heroId === 'zyro' && (side.gandulfBuffRemaining || 0) > 0)
    ? 1 + (side.gandulfBuffStacks || 0) * GANDULF_BUFF_MS_PER_STACK : 1;
  // Zheyna: Warpath +20% MS / ult-laddning -50% MS.
  const warpathMs = (side.zheynaWarpathRem || 0) > 0 ? (1 + ZHEYNA_E_MS) : 1;
  const ultChargeMs = side.zheynaUltCharging ? ZHEYNA_R_CHARGE_MS_MUL : 1;
  const rageMs = (side.inArena1v1 || side.inBossWars) && (side.titansRageTime || 0) > 0 ? (1 + (side.titansRageBuff || 0)) : 1;   // Titan's Rage MS-buff (arena/bosswars only)
  const shoutMs = (side.elarShoutBuffTime || 0) > 0 ? (1 + SHOUT_BUFF_MS) : 1;   // E3 War Shout MS-buff (alla lägen)
  const xinaMs = xinaMoveSpeedMul(side);   // Xina (decision 139) — cloak/ult/Q-stack MS (1 för icke-Xina)
  const nx = side.hero.x + ndx * side.moveSpeed * speedMul * invisMul * cloudMul * wpMul * hammerMul * bannerMul * zyroPassiveMs * warpathMs * ultChargeMs * rageMs * shoutMs * slowMul * xinaMs * strength * dt;
  const nz = side.hero.z + ndz * side.moveSpeed * speedMul * invisMul * cloudMul * wpMul * hammerMul * bannerMul * zyroPassiveMs * warpathMs * ultChargeMs * rageMs * shoutMs * slowMul * xinaMs * strength * dt;
  const opts = side.inEnemyTerritory ? { inEnemyTerritory: true } : null;
  const check = side.inBossWars ? (x, z) => isBossWarsWalkable(x, z, side._bwGateClosed)
              : side.inArena1v1 ? isArena1v1Walkable
              : side.inDuel ? isArenaWalkable
              : (x, z) => isHeroWalkable(side.idx, x, z, opts);
  const ox = side.hero.x, oz = side.hero.z;
  if (check(nx, nz)) { side.hero.x = nx; side.hero.z = nz; }
  else if (check(nx, side.hero.z)) side.hero.x = nx;
  else if (check(side.hero.x, nz)) side.hero.z = nz;
  if (side.heroId === 'ganji') ganjiAddMeter(side, Math.hypot(side.hero.x - ox, side.hero.z - oz));
}

// ===== ZHEYNA SKILLS (server-auth, decision 134) =====
function zheynaWalk(side) {
  return side.inBossWars ? (x, z) => isBossWarsWalkable(x, z, side._bwGateClosed)
       : side.inArena1v1 ? isArena1v1Walkable
       : side.inDuel ? isArenaWalkable
       : (x, z) => isHeroWalkable(side.idx, x, z, null);
}
// Mode-agnostisk lista över giltiga fiender med {ent (har x/z + hp/maxHp), isHero/isMonster/isCreep}.
function zheynaEnemies(state, side) {
  const out = [];
  const opp = arenaOpp(state, side.idx);
  if (opp && opp.hero && !opp.hero.dead && (state.duelActive || side.inArena1v1 || (typeof isHeroPvpActive === 'function' && isHeroPvpActive(state)))) {
    out.push({ ent: opp.hero, isHero: true, sideIdx: opp.idx });
  }
  for (const m of side.monsters) if (m && m.hp > 0) out.push({ ent: m, isMonster: true });
  if (opp && opp.playerCreeps) for (const c of opp.playerCreeps) if (c && c.hp > 0) out.push({ ent: c, isCreep: true });
  return out;
}
// Aktuell AA-skada (för Q-spjut + clone): bas × passive(distans) × crit × Q-buff.
function zheynaAaDamageAt(side, dist, guaranteedCrit) {
  const maxR = (side.attackRange || 7.5) * ((side.zheynaWarpathRem || 0) > 0 ? (1 + ZHEYNA_E_RANGE) : 1);
  const f = maxR > 0 ? Math.max(0, Math.min(1, dist / maxR)) : 0;
  let dmg = (side.attackDmg || 0) * (1 + ZHEYNA_PASSIVE_DMG_MAX * f) * (side.zheynaDmgBuffMul || 1);
  if (guaranteedCrit) dmg *= (side.critDmgMul || 2.0);
  return dmg;
}
function zheynaApplyHitDamage(state, side, e, dmg) {
  if (e.isHero) { const ts = state.sides[e.sideIdx]; if (ts && !ts.hero.dead) damageHero(ts, dmg); }
  else if (e.isMonster) {
    e.ent.hp -= bossWarsDmgMod(e.ent, dmg);
    if (e.ent.hp <= 0) { const k = side.monsters.indexOf(e.ent); if (k >= 0) killMonster(side, k, side); }
  } else if (e.isCreep) {
    const opp = arenaOpp(state, side.idx);
    e.ent.hp -= dmg;
    if (e.ent.hp <= 0 && opp) { const k = opp.playerCreeps.indexOf(e.ent); if (k >= 0) { opp.playerCreeps.splice(k, 1); side.gold += minionBounty(e.ent); gainXp(side, minionXp(e.ent)); } }
  }
}
function zheynaKnockEnt(state, side, e, ox, oz, dist) {
  const ent = e.ent; const dx = (ent.x || 0) - ox, dz = (ent.z || 0) - oz; const m = Math.hypot(dx, dz) || 1;
  const nx = (ent.x || 0) + (dx / m) * dist, nz = (ent.z || 0) + (dz / m) * dist;
  if (e.isHero) { const ts = state.sides[e.sideIdx]; if (ts && !ts.hero.dead) { const w = zheynaWalk(ts); if (w(nx, nz)) { ts.hero.x = nx; ts.hero.z = nz; } } }
  else if (ent.hp > 0) { ent.x = nx; ent.z = nz; }
}
// Q Spear Pierce — kast + re-press-teleport
function castZheynaQ(state, sideIdx, ev) {
  const side = state.sides[sideIdx];
  if (!side || side.hero.dead) return;
  if (side.zheynaSpear && (side.zheynaSpear.repress || 0) > 0) { zheynaTeleportToSpear(state, side); return; }
  if (side.skills.q.cd > 0) return;
  side.skills.q.cd = side.skills.q.max;
  let dx = ev && ev.dx, dz = ev && ev.dz;
  const m = Math.hypot(dx || 0, dz || 0);
  if (m < 0.01) { dx = side.hero.facingX || 0; dz = side.hero.facingZ || 1; } else { dx /= m; dz /= m; }
  side.zheynaSpear = {
    id: state.nextEntityId++, x: side.hero.x, z: side.hero.z, dx, dz, traveled: 0,
    destX: side.hero.x + dx * ZHEYNA_Q_RANGE, destZ: side.hero.z + dz * ZHEYNA_Q_RANGE,
    landed: false, hit: false, repress: ZHEYNA_Q_REPRESS,
  };
}
function updateZheynaSpear(state, side, dt) {
  const sp = side.zheynaSpear; if (!sp) return;
  sp.repress = Math.max(0, sp.repress - dt);
  if (sp.repress <= 0) { side.zheynaSpear = null; return; }   // fönster ute → spjut försvinner
  if (!sp.landed) {
    const step = ZHEYNA_Q_SPEED * dt;
    // träff på första fiende i banan?
    for (const e of zheynaEnemies(state, side)) {
      const rx = (e.ent.x || 0) - sp.x, rz = (e.ent.z || 0) - sp.z;
      const along = rx * sp.dx + rz * sp.dz, perp = Math.abs(rx * sp.dz - rz * sp.dx);
      if (along >= 0 && along <= step + 0.6 && perp <= 0.9) {
        sp.landed = true; sp.destX = e.ent.x || sp.x; sp.destZ = e.ent.z || sp.z;
        const dist = Math.hypot((e.ent.x || 0) - side.hero.x, (e.ent.z || 0) - side.hero.z);
        if (!sp.hit) { sp.hit = true; zheynaApplyHitDamage(state, side, e, zheynaAaDamageAt(side, dist, true)); }
        break;
      }
    }
    if (!sp.landed) {
      sp.x += sp.dx * step; sp.z += sp.dz * step; sp.traveled += step;
      if (sp.traveled >= ZHEYNA_Q_RANGE) { sp.landed = true; sp.destX = sp.x; sp.destZ = sp.z; }
    }
  }
}
function zheynaTeleportToSpear(state, side) {
  const sp = side.zheynaSpear; if (!sp) return;
  const tx = sp.destX, tz = sp.destZ;
  const w = zheynaWalk(side);
  if (w(tx, tz)) { side.hero.x = tx; side.hero.z = tz; }
  let heroStuns = 0, minionStuns = 0;
  const rSq = ZHEYNA_Q_STUN_RADIUS * ZHEYNA_Q_STUN_RADIUS;
  for (const e of zheynaEnemies(state, side)) {
    const ddx = (e.ent.x || 0) - tx, ddz = (e.ent.z || 0) - tz;
    if (ddx * ddx + ddz * ddz <= rSq) {
      e.ent.frozenTime = Math.max(e.ent.frozenTime || 0, ZHEYNA_Q_STUN_DUR);
      if (e.isHero) heroStuns++; else minionStuns++;
    }
  }
  const buff = heroStuns * ZHEYNA_Q_BUFF_HERO + minionStuns * ZHEYNA_Q_BUFF_MINION;
  if (buff > 0) { side.zheynaDmgBuffMul = 1 + buff; side.zheynaDmgBuffRem = ZHEYNA_Q_BUFF_DUR; }
  side.zheynaSpear = null;
}
// F Clone
function castZheynaClone(state, sideIdx) {
  const side = state.sides[sideIdx];
  if (!side || side.hero.dead || side.skills.f.cd > 0) return;
  side.skills.f.cd = side.skills.f.max;
  side.zheynaClone = { id: state.nextEntityId++, x: side.hero.x + 1.4, z: side.hero.z, hp: side.hero.maxHp, maxHp: side.hero.maxHp, remaining: ZHEYNA_CLONE_DUR };
}
function tickZheynaClone(state, side, dt) {
  const cl = side.zheynaClone; if (!cl) return;
  cl.remaining -= dt;
  if (cl.remaining <= 0 || cl.hp <= 0) { side.zheynaClone = null; return; }
  const ox = side.hero.x + 1.4, oz = side.hero.z;
  cl.x += (ox - cl.x) * Math.min(1, dt * 6); cl.z += (oz - cl.z) * Math.min(1, dt * 6);
}
// E Warpath
function castZheynaWarpath(state, sideIdx) {
  const side = state.sides[sideIdx];
  if (!side || side.hero.dead || side.skills.e.cd > 0) return;
  side.skills.e.cd = side.skills.e.max;
  side.zheynaWarpathRem = ZHEYNA_E_DUR;
}
// R Spear God — håll-ladda + släpp/auto-kast (hitscan-rektangel + visuellt spjut)
function startZheynaUltCharge(state, side) {
  if (side.hero.dead || side.zheynaUltCharging) return;
  if ((side.level || 1) < ULT_UNLOCK_LEVEL) return;
  if ((side.ultEnergy || 0) < ULT_ENERGY_MAX || (side._ultLockoutTime || 0) > 0) return;
  side.zheynaUltCharging = true; side.zheynaUltCharge = 0; side.zheynaUltAim = 0;
}
function fireZheynaUlt(state, side) {
  if (!side.zheynaUltCharging) return;
  side.zheynaUltCharging = false;
  if (side.hero.dead) return;
  const charge = Math.max(1, Math.min(ZHEYNA_R_MAX_CHARGE, side.zheynaUltCharge || 1));
  side.ultEnergy = 0; side._ultLockoutTime = ULT_LOCKOUT_AFTER_CAST;
  const dmgFrac = ZHEYNA_R_DMG_PER_SEC * charge;
  const width = ZHEYNA_R_WIDTH_BASE + ZHEYNA_R_WIDTH_PER_SEC * (charge - 1);
  const knock = ZHEYNA_R_KNOCKBACK_PER_SEC * charge;
  let dx = side.hero.facingX || 0, dz = side.hero.facingZ || 1;
  const m = Math.hypot(dx, dz) || 1; dx /= m; dz /= m;
  const ox = side.hero.x, oz = side.hero.z, halfW = width / 2;
  for (const e of zheynaEnemies(state, side)) {
    const rx = (e.ent.x || 0) - ox, rz = (e.ent.z || 0) - oz;
    const along = rx * dx + rz * dz, perp = Math.abs(rx * dz - rz * dx);
    if (along >= 0 && along <= ZHEYNA_R_RANGE && perp <= halfW) {
      zheynaApplyHitDamage(state, side, e, (e.ent.maxHp || e.ent.hp || 0) * dmgFrac * (side.zheynaDmgBuffMul || 1));
      if (e.ent.hp == null || e.ent.hp > 0) zheynaKnockEnt(state, side, e, ox, oz, knock);
    }
  }
  // Visuellt spjut (gameplay redan klart via hitscan) — flyger 20m för FX/MP-render.
  side.zheynaUltSpear = { id: state.nextEntityId++, x: ox, z: oz, dx, dz, traveled: 0, width };
}
function updateZheynaUltSpear(side, dt) {
  const sp = side.zheynaUltSpear; if (!sp) return;
  sp.x += sp.dx * ZHEYNA_R_SPEAR_SPEED * dt; sp.z += sp.dz * ZHEYNA_R_SPEAR_SPEED * dt; sp.traveled += ZHEYNA_R_SPEAR_SPEED * dt;
  if (sp.traveled >= ZHEYNA_R_RANGE) side.zheynaUltSpear = null;
}
// Per-side Zheyna-tick — anropas i alla modes per frame.
function tickZheyna(state, side, dt) {
  if (!side || side.heroId !== 'zheyna') return;
  if ((side.zheynaWarpathRem || 0) > 0) side.zheynaWarpathRem = Math.max(0, side.zheynaWarpathRem - dt);
  if ((side.zheynaDmgBuffRem || 0) > 0) { side.zheynaDmgBuffRem = Math.max(0, side.zheynaDmgBuffRem - dt); if (side.zheynaDmgBuffRem <= 0) side.zheynaDmgBuffMul = 1; }
  updateZheynaSpear(state, side, dt);
  tickZheynaClone(state, side, dt);
  if (side.zheynaUltCharging) {
    if (side.hero.dead) { side.zheynaUltCharging = false; }
    else {
      side.zheynaUltCharge = Math.min(ZHEYNA_R_MAX_CHARGE, (side.zheynaUltCharge || 0) + dt);
      if (side.zheynaUltCharge >= ZHEYNA_R_MAX_CHARGE) {
        side.zheynaUltAim = (side.zheynaUltAim || 0) + dt;
        if (side.zheynaUltAim >= ZHEYNA_R_AIM_EXTRA) fireZheynaUlt(state, side);
      }
    }
  }
  updateZheynaUltSpear(side, dt);
}

// ===== XINA SKILLS (server-auth, decision 139) =====
// Återanvänder Zheynas mode-agnostiska helpers zheynaWalk/zheynaEnemies (generiska, ej heroId-bundna).
function resetXinaState(side) {
  side.xinaShurikens = []; side.xinaHook = null; side.xinaStorm = []; side.xinaLaunch = [];
  side.xinaUltRem = 0; side.xinaCloakRem = 0; side.xinaCloakStackCd = 0;
  side.xinaQBuffRem = 0; side.xinaQBuffStacks = 0; side.xinaStormHits = null;
}
function xinaHeal(side, amount) { if (amount > 0 && !side.hero.dead) side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + amount); }
function xinaMaxHpOf(e) { return (e.ent.maxHp || e.ent.hp || 0); }
// Q/F/E-buff-multiplikatorer (returnerar 1 för icke-Xina → säkra att kalla i delade hot-paths).
function xinaQBuffMul(side) { return (side.xinaQBuffRem || 0) > 0 ? (Math.min(XINA_Q_COUNT, side.xinaQBuffStacks || 0) * XINA_Q_BUFF_PER_HIT) : 0; }
function xinaOutMul(side) { return side.heroId === 'xina' && (side.xinaUltRem || 0) > 0 ? (1 + XINA_R_OUT_DMG) : 1; }
function xinaAttackSpeedMul(side) {
  if (side.heroId !== 'xina') return 1;
  return (1 + xinaQBuffMul(side)) * ((side.xinaCloakRem || 0) > 0 ? (1 + XINA_CLOAK_AS) : 1) * ((side.xinaUltRem || 0) > 0 ? (1 + XINA_R_AS) : 1);
}
function xinaMoveSpeedMul(side) {
  if (side.heroId !== 'xina') return 1;
  return (1 + xinaQBuffMul(side)) * ((side.xinaCloakRem || 0) > 0 ? (1 + XINA_CLOAK_MS) : 1) * ((side.xinaUltRem || 0) > 0 ? (1 + XINA_R_MS) : 1);
}
// Skada + returnerar faktiskt utdelad skada (lifesteal-gate mot immun boss).
function xinaApplyHitDamage(state, side, e, dmg) {
  let dealt = 0;
  if (e.isHero) { const ts = state.sides[e.sideIdx]; if (ts && !ts.hero.dead) { dealt = Math.min(ts.hero.hp, dmg); damageHero(ts, dmg); } }
  else if (e.isMonster) { const eff = bossWarsDmgMod(e.ent, dmg); dealt = Math.max(0, Math.min(e.ent.hp, eff)); e.ent.hp -= eff; if (e.ent.hp <= 0) { const k = side.monsters.indexOf(e.ent); if (k >= 0) killMonster(side, k, side); } }
  else if (e.isCreep) { const opp = arenaOpp(state, side.idx); dealt = Math.min(e.ent.hp, dmg); e.ent.hp -= dmg; if (e.ent.hp <= 0 && opp) { const k = opp.playerCreeps.indexOf(e.ent); if (k >= 0) { opp.playerCreeps.splice(k, 1); side.gold += minionBounty(e.ent); gainXp(side, minionXp(e.ent)); } } }
  return dealt;
}
function xinaGrantQBuff(side) { side.xinaQBuffStacks = Math.min(XINA_Q_COUNT, (side.xinaQBuffStacks || 0) + 1); side.xinaQBuffRem = XINA_Q_BUFF_DUR; }
// Q Shuriken Toss — 5 shurikens i kon, flyger ut + tillbaka. 5% maxHP/träff, heal 50%, +5% MS/AS per träff.
function castXinaQ(state, sideIdx, dx, dz) {
  const side = state.sides[sideIdx];
  if (!side || side.hero.dead || side.skills.q.cd > 0) return;
  side.skills.q.cd = side.skills.q.max;
  let bx = dx, bz = dz; const m = Math.hypot(bx || 0, bz || 0);
  if (m < 0.01) { bx = side.hero.facingX || 0; bz = side.hero.facingZ || 1; } else { bx /= m; bz /= m; }
  const base = Math.atan2(bx, bz), mul = side.skillDmgMul || 1;
  side.xinaShurikens = side.xinaShurikens || [];
  for (let i = 0; i < XINA_Q_COUNT; i++) {
    const off = (XINA_Q_COUNT > 1 ? (i / (XINA_Q_COUNT - 1) - 0.5) : 0) * XINA_Q_CONE;
    const a = base + off;
    side.xinaShurikens.push({ id: state.nextEntityId++, x: side.hero.x, z: side.hero.z, dx: Math.sin(a), dz: Math.cos(a), traveled: 0, returning: false, dmgMul: mul, hit: false });
  }
}
function updateXinaShurikens(state, side, dt) {
  const arr = side.xinaShurikens; if (!arr || !arr.length) return;
  const enemies = zheynaEnemies(state, side);
  const step = XINA_Q_SPEED * dt, r2hit = XINA_Q_HIT_RADIUS * XINA_Q_HIT_RADIUS;
  for (let i = arr.length - 1; i >= 0; i--) {
    const s = arr[i];
    if (!s.returning) {
      s.x += s.dx * step; s.z += s.dz * step; s.traveled += step;
      if (s.traveled >= XINA_Q_RANGE) s.returning = true;
    } else {
      const tx = side.hero.x - s.x, tz = side.hero.z - s.z, d = Math.hypot(tx, tz);
      if (d <= step + 0.4) { arr.splice(i, 1); continue; }   // tillbaka hos Xina → klar
      s.x += (tx / d) * step; s.z += (tz / d) * step;
    }
    if (!s.hit) {
      for (const e of enemies) {
        const ex = (e.ent.x || 0) - s.x, ez = (e.ent.z || 0) - s.z;
        if (ex * ex + ez * ez <= r2hit) {
          s.hit = true;
          const dmg = xinaMaxHpOf(e) * XINA_Q_DMG_PCT * s.dmgMul * xinaOutMul(side);
          const dealt = xinaApplyHitDamage(state, side, e, dmg);
          if (dealt > 0) { xinaHeal(side, dmg * XINA_Q_LIFESTEAL); xinaGrantQBuff(side); }
          break;
        }
      }
    }
  }
}
// F Ninja's Cloak — 3s buff (AS/MS/evasion/skill-DR). 2 charges vid skill-lvl 5.
function castXinaCloak(state, sideIdx) {
  const side = state.sides[sideIdx];
  if (!side || side.hero.dead) return;
  const twoCharges = !!(side.skillLvl && (side.skillLvl.f || 0) >= SKILL_LEVEL_MAX);
  const s1 = (side.skills.f.cd || 0) <= 0;
  const s2 = twoCharges && (side.xinaCloakStackCd || 0) <= 0;
  if (!s1 && !s2) return;
  if (s1) side.skills.f.cd = side.skills.f.max; else side.xinaCloakStackCd = side.skills.f.max;
  side.xinaCloakRem = XINA_CLOAK_DUR;
}
// E Xina's Slice — krok. Kast → fäster på fiende; re-press → dra till mål + stun + 2 empowrade AA.
function castXinaSlice(state, sideIdx, dx, dz) {
  const side = state.sides[sideIdx];
  if (!side || side.hero.dead) return;
  if (side.xinaHook && side.xinaHook.attached) { xinaPullToHook(state, side); return; }
  if (side.xinaHook) return;            // kedjan är på väg ut → vänta
  if (side.skills.e.cd > 0) return;
  side.skills.e.cd = side.skills.e.max;
  let bx = dx, bz = dz; const m = Math.hypot(bx || 0, bz || 0);
  if (m < 0.01) { bx = side.hero.facingX || 0; bz = side.hero.facingZ || 1; } else { bx /= m; bz /= m; }
  side.xinaHook = { id: state.nextEntityId++, x: side.hero.x, z: side.hero.z, dx: bx, dz: bz, traveled: 0, attached: false, ent: null, isHero: false, isMonster: false, isCreep: false, sideIdx: 0, stickRem: 0 };
}
function xinaHookTarget(state, hk) { return hk.isHero ? (state.sides[hk.sideIdx] ? state.sides[hk.sideIdx].hero : null) : hk.ent; }
function xinaHookDead(state, hk) { return hk.isHero ? (!state.sides[hk.sideIdx] || state.sides[hk.sideIdx].hero.dead) : (!hk.ent || hk.ent.hp <= 0); }
function xinaStun(state, hk, dur) {
  if (hk.isHero) { const ts = state.sides[hk.sideIdx]; if (ts && !ts.hero.dead) ts.hero.frozenTime = Math.max(ts.hero.frozenTime || 0, dur); }
  else if (hk.ent && hk.ent.hp > 0) hk.ent.frozenTime = Math.max(hk.ent.frozenTime || 0, dur);
}
function updateXinaHook(state, side, dt) {
  const hk = side.xinaHook; if (!hk) return;
  if (!hk.attached) {
    const step = XINA_E_SPEED * dt;
    for (const e of zheynaEnemies(state, side)) {
      const ex = (e.ent.x || 0) - hk.x, ez = (e.ent.z || 0) - hk.z;
      if (ex * ex + ez * ez <= XINA_E_HIT_RADIUS * XINA_E_HIT_RADIUS) {
        hk.attached = true; hk.ent = e.ent; hk.isHero = !!e.isHero; hk.isMonster = !!e.isMonster; hk.isCreep = !!e.isCreep; hk.sideIdx = e.sideIdx != null ? e.sideIdx : 0; hk.stickRem = XINA_E_STICK_DUR;
        break;
      }
    }
    if (!hk.attached) {
      hk.x += hk.dx * step; hk.z += hk.dz * step; hk.traveled += step;
      if (hk.traveled >= XINA_E_RANGE) side.xinaHook = null;
    }
  } else {
    if (xinaHookDead(state, hk)) { side.xinaHook = null; return; }
    const tgt = xinaHookTarget(state, hk);
    hk.x = tgt.x; hk.z = tgt.z; hk.stickRem -= dt;
    const d = Math.hypot(tgt.x - side.hero.x, tgt.z - side.hero.z);
    if (d > XINA_E_BREAK_DIST) { xinaStun(state, hk, XINA_E_BREAK_STUN); side.xinaHook = null; return; }   // kedjan brister → stun 1s
    if (hk.stickRem <= 0) side.xinaHook = null;
  }
}
function xinaPullToHook(state, side) {
  const hk = side.xinaHook; if (!hk || !hk.attached) return;
  if (xinaHookDead(state, hk)) { side.xinaHook = null; return; }
  const tgt = xinaHookTarget(state, hk);
  const dx = tgt.x - side.hero.x, dz = tgt.z - side.hero.z, d = Math.hypot(dx, dz) || 1;
  const stop = Math.max(0, d - (side.attackRange || 2.6) * 0.6);
  const nx = side.hero.x + (dx / d) * stop, nz = side.hero.z + (dz / d) * stop;
  const w = zheynaWalk(side);
  if (w(nx, nz)) { side.hero.x = nx; side.hero.z = nz; }
  side.hero.facingX = dx / d; side.hero.facingZ = dz / d;
  xinaStun(state, hk, XINA_E_PULL_STUN);   // stun 1.5s
  // 2 snabba AA: 100% crit + 100% extra crit-dmg (passive +15%) + 50% lifesteal
  const eWrap = { ent: tgt, isHero: hk.isHero, isMonster: hk.isMonster, isCreep: hk.isCreep, sideIdx: hk.sideIdx };
  const critMul = (side.critDmgMul || 2.0) + 0.15 + 1.0;
  for (let i = 0; i < XINA_E_AA_COUNT; i++) {
    if (xinaHookDead(state, hk)) break;
    const dmg = (side.attackDmg || 0) * critMul * xinaOutMul(side);
    const dealt = xinaApplyHitDamage(state, side, eWrap, dmg);
    if (dealt > 0) xinaHeal(side, dmg * XINA_E_AA_LIFESTEAL);
  }
  side.xinaHook = null;
}
// R Shuriken Storm — 5 orbiterande shurikens 5s (kontakt 10% maxHP + heal 50%), skjuts sedan ut 10m.
function castXinaUlt(state, side) {
  if (!side || side.hero.dead) return;
  side.xinaUltRem = XINA_R_DUR; side.xinaStorm = []; side.xinaStormHits = {};
  for (let i = 0; i < XINA_R_COUNT; i++) {
    const a = (i / XINA_R_COUNT) * Math.PI * 2;
    side.xinaStorm.push({ angle: a, x: side.hero.x + Math.cos(a) * XINA_R_ORBIT_RADIUS, z: side.hero.z + Math.sin(a) * XINA_R_ORBIT_RADIUS });
  }
}
function xinaEntKey(e) { return e.isHero ? ('h' + e.sideIdx) : ('e' + (e.ent.id || 0)); }
function updateXinaStorm(state, side, dt) {
  const arr = side.xinaStorm; if (!arr || !arr.length) return;
  const hits = side.xinaStormHits || (side.xinaStormHits = {});
  for (const k in hits) { hits[k] -= dt; if (hits[k] <= 0) delete hits[k]; }
  const enemies = zheynaEnemies(state, side), r2hit = XINA_R_HIT_RADIUS * XINA_R_HIT_RADIUS;
  for (const s of arr) {
    s.angle += XINA_R_ORBIT_SPEED * dt;
    s.x = side.hero.x + Math.cos(s.angle) * XINA_R_ORBIT_RADIUS;
    s.z = side.hero.z + Math.sin(s.angle) * XINA_R_ORBIT_RADIUS;
    for (const e of enemies) {
      const key = xinaEntKey(e);
      if (hits[key] != null) continue;
      const ex = (e.ent.x || 0) - s.x, ez = (e.ent.z || 0) - s.z;
      if (ex * ex + ez * ez <= r2hit) {
        const dmg = xinaMaxHpOf(e) * XINA_R_TICK_DMG_PCT * xinaOutMul(side);
        const dealt = xinaApplyHitDamage(state, side, e, dmg);
        if (dealt > 0) xinaHeal(side, dmg * XINA_R_HEAL);
        hits[key] = XINA_R_HIT_CD;
      }
    }
  }
}
function xinaApplySlow(state, e) {
  if (e.isHero) { const ts = state.sides[e.sideIdx]; if (ts && !ts.hero.dead) { ts.heroSlowMul = Math.min(ts.heroSlowMul == null ? 1 : ts.heroSlowMul, XINA_R_LAUNCH_SLOW_MUL); ts.heroSlowTime = Math.max(ts.heroSlowTime || 0, XINA_R_LAUNCH_SLOW_DUR); } }
  else if (e.ent && e.ent.hp > 0) { e.ent.slowMul = Math.min(e.ent.slowMul == null ? 1 : e.ent.slowMul, XINA_R_LAUNCH_SLOW_MUL); e.ent.slowTime = Math.max(e.ent.slowTime || 0, XINA_R_LAUNCH_SLOW_DUR); }
}
function xinaLaunchStorm(state, side) {
  const arr = side.xinaStorm;
  if (arr && arr.length) {
    side.xinaLaunch = side.xinaLaunch || [];
    for (const s of arr) side.xinaLaunch.push({ id: state.nextEntityId++, x: s.x, z: s.z, dx: Math.cos(s.angle), dz: Math.sin(s.angle), traveled: 0, hit: false });
  }
  side.xinaStorm = []; side.xinaStormHits = null;
}
function updateXinaLaunch(state, side, dt) {
  const arr = side.xinaLaunch; if (!arr || !arr.length) return;
  const enemies = zheynaEnemies(state, side);
  const step = XINA_R_LAUNCH_SPEED * dt, r2hit = XINA_R_HIT_RADIUS * XINA_R_HIT_RADIUS;
  for (let i = arr.length - 1; i >= 0; i--) {
    const s = arr[i];
    s.x += s.dx * step; s.z += s.dz * step; s.traveled += step;
    if (!s.hit) for (const e of enemies) {
      const ex = (e.ent.x || 0) - s.x, ez = (e.ent.z || 0) - s.z;
      if (ex * ex + ez * ez <= r2hit) {
        s.hit = true;
        const dmg = xinaMaxHpOf(e) * XINA_R_LAUNCH_DMG_PCT * xinaOutMul(side);
        xinaApplyHitDamage(state, side, e, dmg);
        xinaApplySlow(state, e);
        break;
      }
    }
    if (s.traveled >= XINA_R_LAUNCH_RANGE) arr.splice(i, 1);
  }
}
// Per-side Xina-tick — anropas i alla modes per frame (bredvid tickZheyna).
function tickXina(state, side, dt) {
  if (!side || side.heroId !== 'xina') return;
  if ((side.xinaCloakRem || 0) > 0) side.xinaCloakRem = Math.max(0, side.xinaCloakRem - dt);
  if ((side.xinaCloakStackCd || 0) > 0) side.xinaCloakStackCd = Math.max(0, side.xinaCloakStackCd - dt);
  if ((side.xinaQBuffRem || 0) > 0) { side.xinaQBuffRem = Math.max(0, side.xinaQBuffRem - dt); if (side.xinaQBuffRem <= 0) side.xinaQBuffStacks = 0; }
  updateXinaShurikens(state, side, dt);
  updateXinaHook(state, side, dt);
  if ((side.xinaUltRem || 0) > 0) {
    side.xinaUltRem = Math.max(0, side.xinaUltRem - dt);
    updateXinaStorm(state, side, dt);
    if (side.xinaUltRem <= 0) xinaLaunchStorm(state, side);
  }
  updateXinaLaunch(state, side, dt);
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
    if (!process.env.ALLOW_CHEATS) return;   // dev-only — the authoritative server must NEVER trust the cheat path in production (anti-cheat audit 2026-06-23). Set ALLOW_CHEATS=1 locally to use it.
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
  if (ev.type === 'dragon-activate') {   // boss 5 Memory Trial: aktivera nästa symbol (decision 135)
    dragonMemActivate(state, sideIdx);
    return;
  }
  if (ev.type === 'portal') {
    // Lvl-30-gated PvP-portal: teleporterar till motståndarens lanes i 30s
    if (side.hero.dead) return;
    if (side.inEnemyTerritory) return;        // redan där borta
    if ((side.level || 1) < PORTAL_REQUIRED_LEVEL) return;
    if ((side.portalUsesLeft || 0) <= 0) return;
    if ((side.portalCooldown || 0) > 0) return;
    if (state.duelActive) return;              // ingen portal under duel
    // Måste stå på/intill portalen för att aktivera
    const pp = PORTAL_POS[side.idx];
    if (!pp) return;
    const d = Math.hypot(side.hero.x - pp.x, side.hero.z - pp.z);
    if (d > PORTAL_ENTER_RADIUS + 0.4) return;
    // Teleport!
    const dest = PORTAL_DEST[side.idx];
    side.hero.x = dest.x;
    side.hero.z = dest.z;
    side.inEnemyTerritory = true;
    side.enemyTerritoryTimer = PORTAL_ENEMY_DURATION;
    side.portalUsesLeft -= 1;
    side.portalCooldown = PORTAL_COOLDOWN;
    return;
  }
  if (ev.type === 'aa') {
    if (side.hero.dead) return;
    const opp = arenaOpp(state, sideIdx);
    // Manuell AA: aktivera bara om någon fiende redan finns inom range.
    // Inget auto-aktiverande "väntar"-läge — hero attackerar bara efter explicit
    // tryck mot ett konkret target.
    // One-shot tap: only acquire a target already inside ATTACK range — a tap does NOTHING if the
    // nearest enemy is out of range (no chase; user 2026-06-20 v2). You run closer and tap again.
    // Range mirrors maintainTargetLock (Zheyna Warpath +range, Legolus empowered ult-AA double range).
    const baseAcqRange = (side.attackRange || HERO_ATTACK_RANGE) * (side.heroId === 'zheyna' && (side.zheynaWarpathRem || 0) > 0 ? (1 + ZHEYNA_E_RANGE) : 1);
    const acqRange = (side.heroId === 'nyro' && side.nyroUltAaPending) ? baseAcqRange * LEGOLUS_ULT_AA_RANGE_MUL : baseAcqRange;
    const t = findClosestHostile(side, opp, side.hero.x, side.hero.z, acqRange, state);
    if (t) {
      side.aaActive = true;
      if (t.isHero) { side.targetId = 0; side.targetType = 'hero'; }
      else if (t.isDuelOrb) { side.targetId = 0; side.targetType = 'duelOrb'; }
      else if (t.isArenaOrb) { side.targetId = 0; side.targetType = 'arenaOrb'; }
      else {
        side.targetId = t.entity.id;
        side.targetType = t.isMonster ? 'monster' : 'creep';
      }
      side.targetX = t.entity.x;
      side.targetZ = t.entity.z;
    } else {
      side.aaActive = false;
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
    if (side.boss4Carrying) return;   // bär giftväska (boss 4) → kan inte casta skills (decision 132)
    // Hard-CC blocks ALL casts (mirror the movement/AA guard at applyMovement) — without this,
    // freeze/root/fear/ice-block were cosmetic for SKILLS against a custom client: a stunned player
    // could still Blink/Leap/ult out (anti-cheat audit 2026-06-23). Gimlu Rage zeroes these timers
    // (CC-immune) so it is unaffected. Arena/boss only — classic CC model is unchanged.
    if ((side.inArena1v1 || side.inBossWars) &&
        ((side.hero.frozenTime || 0) > 0 || (side.iceBlockRemaining || 0) > 0 || (side.heroFearTime || 0) > 0)) return;
    // R-cast (ult): server-side consume + lockout. Per-hero ult-effekter
    // implementeras separat (klient-side endast just nu). Här säkerställs
    // att ultEnergy faktiskt nollställs så snap inte hoppar tillbaka till 100,
    // och 5s lockout startar så ult-gain pausas.
    if (ev.key === 'r') {
      // ULT-unlock-gate: kräver hero-level >= 10
      if ((side.level || 1) < ULT_UNLOCK_LEVEL) return;
      // Zheyna Spear God: tryck → börja ladda; tryck igen → kasta (toggle). Auto-kast vid
      // max-laddning + sikt-fönster (tickZheyna). Konsumerar ult-energy vid kast.
      if (side.heroId === 'zheyna') {
        if (side.zheynaUltCharging) fireZheynaUlt(state, side); else startZheynaUltCharge(state, side);
        return;
      }
      // Säkerställ att ult-träffar (t.ex. Soul Drain-tick) räknas som 'r' i
      // Gandulf Soul Mark-tracking istället för stale Q/F/E från förra cast.
      side._currentSkillKey = 'r';
      if ((side.ultEnergy || 0) >= ULT_ENERGY_MAX && (side._ultLockoutTime || 0) <= 0) {
        side.ultEnergy = 0;
        side._ultLockoutTime = ULT_LOCKOUT_AFTER_CAST;
        // Legolus Shadow Volley: invis 5s + empowered next-AA. Revealar vid AA-fire eller timeout.
        if (side.heroId === 'nyro' && !side.hero.dead) {
          side.nyroInvisRemaining = LEGOLUS_INVIS_DURATION;
          side.nyroUltAaPending = true;
          side.attackCd = 0;
          // N5: stop auto-attacking on ult cast — the empowered shot waits until the
          // player presses ATK again (then aaActive→true fires the pending empowered AA).
          side.aaActive = false; side.targetId = 0; side.targetType = '';
        }
        // Ganji Ninja's Mastery: 5 s invisibility (+move speed, agnostic effect).
        // Clone + the empowered break-AA are deferred to a later pass.
        if (side.heroId === 'ganji' && !side.hero.dead) {
          side.nyroInvisRemaining = LEGOLUS_INVIS_DURATION;
        }
        // Kostefo Joint Avengers: summona 8 joints som orbiterar + kopierar AA
        if (side.heroId === 'kostefo' && !side.hero.dead) {
          side.kostefoUltRemaining = KOSTEFO_ULT_DURATION;
          side.kostefoUltJoints = [];
          for (let i = 0; i < KOSTEFO_ULT_JOINT_COUNT; i++) {
            side.kostefoUltJoints.push({
              angle: (i / KOSTEFO_ULT_JOINT_COUNT) * Math.PI * 2,
              attackCd: i * (KOSTEFO_COMPANION_AA_INTERVAL / KOSTEFO_ULT_JOINT_COUNT),
            });
          }
        }
        // Server-auth ults: arena 1v1 + boss wars + sandbox (inBossWars) + line wars (inLineWars).
        // Line wars added 2026-06-23 — tickGame now ticks these fields down (annars permanent
        // berserk-AA m.m.) och hero-skadan är duel-gatead (isHeroPvpActive) i tick-funktionerna.
        // Magiker Master Beam: 3s svängande laser (AoE-tick mot opp hero). Riktning
        // från ev.dx/dz (cast-aim) med facing-fallback. Klient renderar via lz-snap.
        if ((side.inArena1v1 || side.inBossWars || side.inLineWars) && side.heroId === 'zyro' && !side.hero.dead) {
          let ldx = ev.dx, ldz = ev.dz;
          const lm = Math.hypot(ldx || 0, ldz || 0);
          if (lm < 0.01) { ldx = side.hero.facingX || 0; ldz = side.hero.facingZ || 1; }
          else { ldx /= lm; ldz /= lm; }
          side.laserBeam = { remaining: LASER_DURATION, dx: ldx, dz: ldz, tickAccum: 0 };
          applyLaserBeamTickServer(state, side);   // initial tick direkt (matchar klientens host-fn)
        }
        // Gimlu Rage: 5s AoE-pulser + 20% lifesteal + CC-immun
        if ((side.inArena1v1 || side.inBossWars || side.inLineWars) && side.heroId === 'kryx' && !side.hero.dead) {
          side.rageRemaining = RAGE_DURATION;
          side.rageTickAccum = 0;
        }
        // Aragurn Berserk: 5s +150% AA-dmg + 25% lifesteal (AA-modifier i updateHeroAttack)
        if ((side.inArena1v1 || side.inBossWars || side.inLineWars) && side.heroId === 'elar' && !side.hero.dead) {
          side.berserkRemaining = BERSERK_DURATION;
        }
        // Xina Shuriken Storm: 5 orbiterande shurikens 5s + buffs, skjuts sedan ut (tickXina).
        if ((side.inArena1v1 || side.inBossWars || side.inLineWars) && side.heroId === 'xina' && !side.hero.dead) {
          castXinaUlt(state, side);
        }
      }
      return;
    }
    // Q/F/E skill-lock-gate: kräver skillLvl[key] > 0 (unlocked via skill-point)
    if (ev.key === 'q' || ev.key === 'f' || ev.key === 'e') {
      const skLvl = (side.skillLvl && side.skillLvl[ev.key]) || 0;
      if (skLvl <= 0) return;
    }
    // Q/F/E skill-cast: reset per-cast ult-gain-budget så AoE-hits inte
    // proportionellt fyller ult (leap som träffar 20 mobs gav 100% direkt).
    side._ultCapThisCast = ULT_GAIN_SKILL_CAST_CAP;
    // Spara aktuell skill-key så onGandulfSkillHit kan tracka 3-olika-skills-mark
    side._currentSkillKey = ev.key;
    // Quick-cast aim (tap, no drag): aim at the auto-attack target (priority 1), else at the
    // nearest valid enemy in range (priority 2 — in arena/duel/pvp that IS the enemy hero, since
    // findClosestHostile returns opp.hero there). Drag (tap=false) keeps the manual direction.
    // Matches resolveSkillGroundTarget so EVERY directed skill tap-aims the same way (user 2026-06-22).
    let dx = ev.dx, dz = ev.dz;
    if (ev.tap === true) {
      const opp = arenaOpp(state, sideIdx);
      let aim = null;
      if (side.targetId) aim = resolveTargetEntity(side, opp, state);   // priority 1: AA target
      if (!aim) {                                                       // priority 2: nearest enemy hero/hostile
        const near = findClosestHostile(side, opp, side.hero.x, side.hero.z, TAP_AIM_RANGE, state);
        if (near && near.entity) aim = near.entity;
      }
      if (aim) {
        const ddx = aim.x - side.hero.x, ddz = aim.z - side.hero.z;
        const m = Math.hypot(ddx, ddz);
        if (m > 0.01) { dx = ddx / m; dz = ddz / m; }
      }
    }
    const isLegolus = side.heroId === 'nyro';
    const isGimlu = side.heroId === 'kryx';
    const isAragurn = side.heroId === 'elar';
    const isKostefo = side.heroId === 'kostefo';
    const isZheyna = side.heroId === 'zheyna';
    const isGanji = side.heroId === 'ganji';
    const isXina = side.heroId === 'xina';
    // Wrap-around-cast: bumpa side.skillDmgMul med per-skill-level-mult under
    // cast-tid. Bake-at-cast skills (projektiler, fireballs, dotPerSec etc) får
    // automatiskt rätt skalning. Tick-skills som läser side.skillDmgMul live ska
    // alternativt läsa side.skillLvlMul[key] (sätts i recomputeSideStats).
    const _prevSkillDmgMul = side.skillDmgMul;
    const _skLvl = (side.skillLvl && side.skillLvl[ev.key]) || 1;
    const _lvlMul = 1 + SKILL_LEVEL_DMG_PER_PT * Math.max(0, _skLvl - 1);
    side.skillDmgMul = _prevSkillDmgMul * _lvlMul;
    try {
      if (ev.key === 'q') {
        if (isLegolus) castLegolusVineTrap(state, sideIdx, ev);
        else if (isGimlu) castGimluTaunt(state, sideIdx);
        else if (isAragurn) castAragurnWhirlwind(state, sideIdx);
        else if (isKostefo) castKostefoJointAttack(state, sideIdx, dx, dz);
        else if (isZheyna) castZheynaQ(state, sideIdx, ev);
        else if (isGanji) castAragurnWhirlwind(state, sideIdx); // Ganji Q = Thousand Slashes (spinning AoE)
        else if (isXina) castXinaQ(state, sideIdx, dx, dz);   // Xina Q = Shuriken Toss (bumerang-fläkt)
        else castWindPuff(state, sideIdx, dx, dz);   // Magiker Q = Wind Puff (cone push+debuff)
      } else if (ev.key === 'f') {
        if (isLegolus) castLegolusBuff(state, sideIdx);
        else if (isGimlu) castGimluIronWill(state, sideIdx);
        else if (isAragurn) castAragurnShout(state, sideIdx, dx, dz);
        else if (isKostefo) castKostefoJointSlider(state, sideIdx, dx, dz);
        else if (isZheyna) castZheynaClone(state, sideIdx);
        else if (isGanji) castGanjiStep(state, sideIdx, ev); // Ganji F = Shadow Step (blink)
        else if (isXina) castXinaCloak(state, sideIdx);   // Xina F = Ninja's Cloak (buff, 2 charges @lvl5)
        else castFrostnova(state, sideIdx, ev);
      } else if (ev.key === 'e') {
        if (isLegolus) castLegolusDash(state, sideIdx, ev);
        else if (isGimlu) castGimluHammer(state, sideIdx, dx, dz);
        else if (isAragurn) castAragurnLeap(state, sideIdx, ev);
        else if (isKostefo) castKostefoCannabisCloud(state, sideIdx);
        else if (isZheyna) castZheynaWarpath(state, sideIdx);
        else if (isGanji) castGanjiSpeed(state, sideIdx); // Ganji E = Ninja's Speed (self buff)
        else if (isXina) castXinaSlice(state, sideIdx, dx, dz);   // Xina E = Xina's Slice (krok; re-press = pull)
        else castBlink(state, sideIdx, ev);
      }
    } finally {
      side.skillDmgMul = _prevSkillDmgMul;
    }
    return;
  }
  if (ev.type === 'activate') {
    if (side.hero.dead) return;
    activateInventoryItem(side, ev.slot);
    return;
  }
  // Spendera 1 skill-point på Q/F/E (R kan inte uppgraderas via points)
  if (ev.type === 'spsk') {
    const key = ev.key;
    if (key !== 'q' && key !== 'f' && key !== 'e') return;
    if ((side.unspentPoints || 0) <= 0) return;
    if (!side.skillLvl) side.skillLvl = { q: 0, f: 0, e: 0 };
    const cur = side.skillLvl[key] || 0;
    if (cur >= SKILL_LEVEL_MAX) return;
    side.skillLvl[key] = cur + 1;
    side.unspentPoints -= 1;
    recomputeSideStats(side);
    return;
  }
  // Spendera 1 stat-point på en av de 5 stats
  if (ev.type === 'spst') {
    const stat = ev.stat;
    if (!STAT_PER_POINT[stat]) return;
    if ((side.unspentPoints || 0) <= 0) return;
    if (!side.statPts) side.statPts = { as: 0, ms: 0, hp: 0, sd: 0, dr: 0 };
    const cur = side.statPts[stat] || 0;
    if (cur >= STAT_LEVEL_MAX) return;
    side.statPts[stat] = cur + 1;
    side.unspentPoints -= 1;
    recomputeSideStats(side);
    return;
  }
  if (ev.type !== 'shop') return;
  if (side.hero.dead) return;
  // Arena prep: item-köp tillåtet var som helst (ingen bas i arena1v1).
  // Classic line wars: kräver att hjälten är i sin bas.
  const isArenaPrep = (state.mode === 'arena1v1') && (state.phase === 'prep');
  if (!isArenaPrep && !inSideBase(side.idx, side.hero.x, side.hero.z)) return;
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
    if (isArenaPrep) recomputeArenaSideStats(state, side); else recomputeSideStats(side);
  } else if (ev.kind === 'minion') {
    const def = MINION_TYPES[ev.minionType];
    if (!def || !side.tierUnlocks[def.tier]) return;
    if (side.gold < def.cost) return;
    if (ev.lane !== 1 && ev.lane !== 2) return;
    side.gold -= def.cost;
    side.income += Math.floor(def.cost * INCOME_MINION_RATIO);
    spawnMinion(state, side, ev.minionType, ev.lane);
  } else if (ev.kind === 'clone') {
    // Decision 106: köp en 100%-stats-clone av din hero (50k g), spawnar på
    // motståndarens sida och attackerar motståndarens hero (bot-AI).
    if (side.gold < CLONE_COST) return;
    side.gold -= CLONE_COST;
    spawnHeroCopy(state, side, CLONE_STAT_RATIO);
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
// Decision 107: helper för fireball-spawn (återanvänds av Q och F-skill).
// ndx/ndz måste vara NORMALISERAD riktning (sqrt(ndx² + ndz²) === 1).
function spawnHeroCopyFireball(state, arenaSide, hc, ndx, ndz, damage) {
  if (!arenaSide.heroCopyFireballs) arenaSide.heroCopyFireballs = [];
  arenaSide.heroCopyFireballs.push({
    id: state.nextEntityId++,
    ownerSideIdx: hc.ownerSideIdx,
    x: hc.x, y: 1.0, z: hc.z,
    dx: ndx, dz: ndz,
    hit: new Set(),
    traveled: 0,
    damage,
  });
}

function spawnHeroCopy(state, winnerSide, statRatio) {
  const winnerIdx = winnerSide.idx;
  const oppIdx = 3 - winnerIdx;
  const oppCfg = SIDE_CFG[oppIdx];
  const oppSide = state.sides[oppIdx];
  if (!oppSide) return;
  const lane = (state.duelCount % 2 === 1) ? 1 : 2; // alternera mellan lanes
  const z = oppCfg.laneZ[lane];
  // Decision 106: statRatio = 1.0 för shop-clone, 0.7 för duel-clone (default).
  const stat = (typeof statRatio === 'number') ? statRatio : HERO_COPY_STAT_RATIO;
  const maxHp = Math.round(winnerSide.hero.maxHp * stat);
  oppSide.heroCopies.push({
    id: state.nextEntityId++,
    ownerSideIdx: winnerIdx,
    heroId: winnerSide.heroId || 'zyro',
    x: oppCfg.spawnX, z, ry: 0,
    lane,
    hp: maxHp, maxHp,
    attackDmg: winnerSide.attackDmg * stat,
    moveSpeed: winnerSide.moveSpeed * stat,
    skillDmg: ELDKLOT_DAMAGE * (winnerSide.skillDmgMul || 1) * stat,
    attackCd: 0,
    // Decision 107: 3 skill-CDs istället för en (Q/F/E)
    qCd: 0, fCd: 0, eCd: 0,
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
    // Decision 107: 3 separata skill-CDs (Q/F/E)
    hc.qCd = Math.max(0, (hc.qCd || 0) - dt);
    hc.fCd = Math.max(0, (hc.fCd || 0) - dt);
    hc.eCd = Math.max(0, (hc.eCd || 0) - dt);
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
      // Decision 107: skill-rotation (Q/F/E) — högst en skill per tick.
      const dxh = arenaSide.hero.x - hc.x, dzh = arenaSide.hero.z - hc.z;
      const mh = Math.hypot(dxh, dzh) || 1;
      const ndx = dxh / mh, ndz = dzh / mh;
      if (heroAlive && d < ELDKLOT_RANGE && hc.qCd <= 0) {
        // Q: enkel fireball (orginal-beteendet)
        spawnHeroCopyFireball(state, arenaSide, hc, ndx, ndz, hc.skillDmg);
        hc.qCd = HERO_COPY_Q_INTERVAL;
      } else if (heroAlive && d < ELDKLOT_RANGE * 0.85 && hc.fCd <= 0) {
        // F: 3 fireballs i kon (center + ±15°), 60% damage var
        const cs = Math.cos(HERO_COPY_F_SPREAD), sn = Math.sin(HERO_COPY_F_SPREAD);
        const fDmg = hc.skillDmg * HERO_COPY_F_DMG_MUL;
        spawnHeroCopyFireball(state, arenaSide, hc, ndx, ndz, fDmg);
        spawnHeroCopyFireball(state, arenaSide, hc, ndx * cs - ndz * sn, ndx * sn + ndz * cs, fDmg);
        spawnHeroCopyFireball(state, arenaSide, hc, ndx * cs + ndz * sn, -ndx * sn + ndz * cs, fDmg);
        hc.fCd = HERO_COPY_F_INTERVAL;
      } else if (heroAlive && d > 1.5 && d < 6 && hc.eCd <= 0) {
        // E: dash forward + AA-burst (bonus dmg)
        const dashStep = Math.min(HERO_COPY_DASH_DISTANCE, d - 1.2);
        hc.x += ndx * dashStep;
        hc.z += ndz * dashStep;
        damageHero(arenaSide, hc.attackDmg * HERO_COPY_DASH_DMG_MUL);
        hc.eCd = HERO_COPY_E_INTERVAL;
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
  // Pickup-orbs borttagna (användarbeslut 2026-06-04) — endast stora mitt-orben
  // (duelBigOrb) finns i duel-arenan. Tom kö = inga heal/speed-pickup-orbs spawnar.
  state.duelOrbQueue = [];
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
    // Rensa ALLA skill-entitets-arrays — annars lever en entitet som castades precis vid
    // duel-start kvar i duel-arenan (de tickas i duel-branchen) och skadar hjältar.
    for (const arr of ['blackHoles', 'vineTraps', 'hammers', 'fireWaves', 'shatters', 'thornPools',
      'kostefoGooseWaves', 'kostefoSliders', 'bossProjectiles', 'bossPools',
      'ironWillExplosions', 'elarBanners', 'heroCopyFireballs']) {
      if (Array.isArray(s[arr])) s[arr].length = 0;
    }
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
    // Spegla startDuel: rensa alla skill-entiteter så inget följer med ut ur duel-arenan.
    for (const arr of ['blackHoles', 'vineTraps', 'hammers', 'fireWaves', 'shatters', 'thornPools',
      'kostefoGooseWaves', 'kostefoSliders', 'bossProjectiles', 'bossPools',
      'ironWillExplosions', 'elarBanners', 'heroCopyFireballs']) {
      if (Array.isArray(s[arr])) s[arr].length = 0;
    }
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

// === BOTS (line wars-motståndare) — server-auth. Mirror av main.js solo-bot. ===
// Svårighet skalar combat-aggression + ekonomi-takt. Bot:en kör ekonomi-köp DIREKT
// (server-AI behöver ej stå i basen som en spelare) + styr hjälten via lastInputs/applyEvent.
const BOT_PARAMS = {
  easy:   { jitter: 0.40, skillRatePerSec: 0.25, skillReactionMs: 800, economyInterval: 6.5, tierBuffer: 2.6, minionPickTop: 4 },
  medium: { jitter: 0.18, skillRatePerSec: 0.70, skillReactionMs: 350, economyInterval: 3.8, tierBuffer: 1.7, minionPickTop: 2 },
  hard:   { jitter: 0.05, skillRatePerSec: 1.40, skillReactionMs: 150, economyInterval: 2.2, tierBuffer: 1.2, minionPickTop: 1 },
};
function botLineWarsEconomy(state, side, p) {
  // Lås upp nästa tier om vi har gott om guld (buffer skalar per svårighet).
  for (let tier = 2; tier <= 5; tier++) {
    if (!side.tierUnlocks[tier] && side.tierUnlocks[tier - 1]) {
      const cost = TIER_UNLOCK_COST[tier];
      if (cost && side.gold > cost * p.tierBuffer) { side.gold -= cost; side.tierUnlocks[tier] = true; }
      break;
    }
  }
  // Köp bästa råd-affordabla minion → slumpad lane (skickas mot spelaren).
  const affordable = [];
  for (const id in MINION_TYPES) { const m = MINION_TYPES[id]; if (side.tierUnlocks[m.tier] && side.gold >= m.cost) affordable.push(m); }
  if (affordable.length) {
    affordable.sort((a, b) => b.cost - a.cost);
    const m = affordable[Math.min(affordable.length - 1, (Math.random() * p.minionPickTop) | 0)];
    side.gold -= m.cost;
    side.income += Math.floor(m.cost * INCOME_MINION_RATIO);
    spawnMinion(state, side, m.id, 1 + ((Math.random() * 2) | 0));
  }
}
function tickLineWarsBot(state, sideIdx, dt) {
  const side = state.sides[sideIdx];
  if (!side || !side.isBot) return;
  // Lazy-init: bot startar med Q/F/E unlockade (annars gatas skill-cast av skillLvl<=0).
  if (!side._botSkillsInited) {
    side._botSkillsInited = true;
    side.skillLvl = side.skillLvl || { q: 0, f: 0, e: 0 };
    for (const k of ['q', 'f', 'e']) if ((side.skillLvl[k] || 0) < 1) side.skillLvl[k] = 1;
  }
  const p = BOT_PARAMS[side.botDifficulty] || BOT_PARAMS.medium;
  // Ekonomi-tick
  side._botEco = (side._botEco || 0) - dt;
  if (side._botEco <= 0) { side._botEco = p.economyInterval; botLineWarsEconomy(state, side, p); }
  // Hjälte-AI: försvara nära basen, attackera närmaste inkommande fiende.
  const input = state.lastInputs[sideIdx];
  if (side.hero.dead) { if (input) input.j = null; return; }
  if ((side.hero.frozenTime || 0) > 0 || (side.heroFearTime || 0) > 0 || (side.hero.tauntedTime || 0) > 0 || (side.iceBlockRemaining || 0) > 0) {
    if (input) input.j = null; return;
  }
  const opp = arenaOpp(state, sideIdx);
  const t = findClosestHostile(side, opp, side.hero.x, side.hero.z, 14, state);
  let mx = 0, mz = 0;
  if (t && t.entity) {
    const dx = t.entity.x - side.hero.x, dz = t.entity.z - side.hero.z, d = Math.hypot(dx, dz) || 1;
    side.hero.facingX = dx / d; side.hero.facingZ = dz / d;
    const range = side.attackRange || HERO_ATTACK_RANGE;
    if (d > range * 0.85) { mx = dx / d; mz = dz / d; }
    if (d <= range + 0.5 && !side.aaActive) applyEvent(state, sideIdx, { type: 'aa' });
    side._botSkillT = (side._botSkillT || 0) - dt;
    if (side._botSkillT <= 0 && Math.random() < p.skillRatePerSec * dt) {
      side._botSkillT = p.skillReactionMs / 1000;
      const cand = [];   // R (ult) ger ingen combat-effekt i classic → hoppas över
      for (const k of ['q', 'f', 'e']) if (side.skills[k] && side.skills[k].cd <= 0) cand.push(k);
      if (cand.length) applyEvent(state, sideIdx, { type: 'skill', key: cand[(Math.random() * cand.length) | 0], dx: dx / d, dz: dz / d, tap: true });
    }
  }
  if (mx || mz) { mx += (Math.random() - 0.5) * p.jitter; mz += (Math.random() - 0.5) * p.jitter; const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml; }
  if (input) input.j = (mx || mz) ? { x: mx, z: mz } : null;
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
  // Server-auth ults (Zyro laser / Kryx rage / Elar berserk) in line wars (2026-06-23). Ticked here
  // ONCE per game frame — before the duel/push split — so they expire in BOTH phases (no double-tick,
  // no stuck buff). Hero damage inside these fns is duel-gated (isHeroPvpActive) so the push phase is
  // untouched; the ult still fires + shows its visual.
  for (const sideIdx of [1, 2]) {
    const us = state.sides[sideIdx];
    if (!us) continue;
    if (us.laserBeam) tickMagikerLaserServer(state, us, dt);
    if ((us.rageRemaining || 0) > 0) tickGimluRageServer(state, us, dt);
    if ((us.berserkRemaining || 0) > 0) { if (us.hero.dead) us.berserkRemaining = 0; else us.berserkRemaining = Math.max(0, us.berserkRemaining - dt); }
  }
  // Duel-fas: bara hero-kombat, hoppa över wave/monster/creep/income
  if (state.duelActive) {
    // Bot-AI: duellen är hjälte-vs-hjälte (som arena) → återanvänd arena-bot:en så
    // bot:en faktiskt slåss istället för att stå still (annars passiv docka i duellen).
    for (const sideIdx of [1, 2]) if (state.sides[sideIdx] && state.sides[sideIdx].isBot) tickArenaBotServer(state, sideIdx, dt);
    // Movement
    for (const sideIdx of [1, 2]) {
      const side = state.sides[sideIdx];
      const j = state.lastInputs[sideIdx].j;
      heroAutoMove(side, j, dt);
    }
    // Hero-attacker (mot opp.hero, hanteras i findClosestHostile när state.duelActive)
    for (const sideIdx of [1, 2]) {
      const side = state.sides[sideIdx];
      const opp = arenaOpp(state, sideIdx);
      updateSkillCooldowns(side, dt);
      if (!side.hero.dead) updateHeroAttack(state, side, opp, dt);
      updateProjectiles(state, side, opp, dt);
      updateFireballs(state, side, opp, dt);
      updateBlackHoles(state, side, opp, dt);
      updateVineTraps(state, side, opp, dt);
      updateHammers(state, side, opp, dt);
      updateIronWill(state, side, opp, dt);
      updateAragurnWhirlwind(state, side, opp, dt);
      updateAragurnLeap(state, side, opp, dt);
      updateAragurnShoutHeal(side, dt);
      updateSoulDrain(state, side, opp, dt);
      updateBossProjectiles(state, side, dt);
      updateBossPools(state, side, dt);
      tickLegolusInvis(side, dt);
      tickThornPools(state, side, dt);
      tickKostefoSkills(state, side, opp, dt);
      // Aragurn passive: cache nearby-enemy-count för damageHero DR-beräkning
      // Aragurn passive: throttla nearby-count till 5 Hz (recompute var 0.2s)
      // istället för 30 Hz. Iterar alla monsters + creeps O(N+M), helt onödigt
      // varje tick eftersom DR-värdet bara läses vid damageHero som inte triggar
      // ofta nog för 30 Hz precision att vara märkbar. 6× CPU-spar för Aragurn-sidor.
      if (side.heroId === 'elar') {
        side._elarCountTickAccum = (side._elarCountTickAccum || 0) + dt;
        if (side._elarCountTickAccum >= 0.2 || side.elarNearbyCount == null) {
          side._elarCountTickAccum = 0;
          side.elarNearbyCount = elarNearbyCount(state, side);
        }
      }
      // Ult-energy passive gain (0.5%/sek) — gainUltEnergy bail:ar om lockout aktiv
      if (!side.hero.dead) gainUltEnergy(side, ULT_GAIN_PASSIVE * dt);
      // Tick ner lockout-timer (5s efter ult-cast)
      if ((side._ultLockoutTime || 0) > 0) side._ultLockoutTime = Math.max(0, side._ultLockoutTime - dt);
      if ((side.nyroBuffRemaining || 0) > 0) side.nyroBuffRemaining = Math.max(0, side.nyroBuffRemaining - dt);
      tickGimluTauntLvl5(state, side, opp, dt);
      if ((side.windPuffMsRem || 0) > 0) side.windPuffMsRem = Math.max(0, side.windPuffMsRem - dt);
      if ((side.kryxHammerMsRem || 0) > 0) side.kryxHammerMsRem = Math.max(0, side.kryxHammerMsRem - dt);
      tickZheyna(state, side, dt); tickXina(state, side, dt);
      flushIronWillReflectLvl5(state, side, opp);
      tickAragurnBannersLvl5(side, dt);
      if (side.ironWillExplosions) for (let k = side.ironWillExplosions.length - 1; k >= 0; k--) {
        side.ironWillExplosions[k].life -= dt;
        if (side.ironWillExplosions[k].life <= 0) side.ironWillExplosions.splice(k, 1);
      }
      updateNovaEffects(state, side, opp, dt);
      updateActiveBuffs(side, dt);
      // CC/DoT/regen-timers (duel-blocket tickade dem EJ → frusen/tauntad/feared/slowad
      // hjälte fastnade hela duellen; gällde även människor — pre-existerande, fixat här).
      if ((side.hero.frozenTime || 0) > 0) side.hero.frozenTime = Math.max(0, side.hero.frozenTime - dt);
      if ((side.hero.tauntedTime || 0) > 0) side.hero.tauntedTime = Math.max(0, side.hero.tauntedTime - dt);
      if ((side.hero.dotRemaining || 0) > 0) { side.hero.dotRemaining = Math.max(0, side.hero.dotRemaining - dt); damageHero(side, (side.hero.dotPerSec || 0) * dt); }
      if ((side.hero.poisonRemaining || 0) > 0) side.hero.poisonRemaining = Math.max(0, side.hero.poisonRemaining - dt);
      if ((side.heroSlowTime || 0) > 0) { side.heroSlowTime = Math.max(0, side.heroSlowTime - dt); if (side.heroSlowTime <= 0) { side.heroSlowTime = 0; side.heroSlowMul = 1; } }
      tickKryxTimers(side, dt);
      if ((side.heroFearTime || 0) > 0) side.heroFearTime = Math.max(0, side.heroFearTime - dt);
      if ((side.iceBlockRemaining || 0) > 0) side.iceBlockRemaining = Math.max(0, side.iceBlockRemaining - dt);
      // Legolas-mark + Zyro/gandulf-buff tickas även i duellen (QA 2026-06-17) — annars
      // expirerade marken aldrig under duel = permanent +20% dmg, och buffen frös.
      if ((side.hero.nyroMarked || 0) > 0) side.hero.nyroMarked = Math.max(0, side.hero.nyroMarked - dt);
      if ((side.gandulfBuffRemaining || 0) > 0) { side.gandulfBuffRemaining = Math.max(0, side.gandulfBuffRemaining - dt); if (side.gandulfBuffRemaining <= 0) side.gandulfBuffStacks = 0; }
      if (!side.hero.dead && (side.healPerSecPct || 0) > 0 && side.hero.hp < side.hero.maxHp) side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + side.hero.maxHp * side.healPerSecPct * dt);
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
  // Portal-state tick (utanför duel)
  for (const sideIdx of [1, 2]) {
    const s = state.sides[sideIdx];
    if (!s) continue;
    if ((s.portalCooldown || 0) > 0) s.portalCooldown = Math.max(0, s.portalCooldown - dt);
    if (s.inEnemyTerritory) {
      s.enemyTerritoryTimer = Math.max(0, (s.enemyTerritoryTimer || 0) - dt);
      // Hero dog i fiendens territorium ELLER 30s slut → tillbaka till egen fontän
      if (s.hero.dead || s.enemyTerritoryTimer <= 0) {
        const cfg = SIDE_CFG[sideIdx];
        s.hero.x = cfg.heroSpawn.x;
        s.hero.z = cfg.heroSpawn.z;
        s.inEnemyTerritory = false;
        s.enemyTerritoryTimer = 0;
        // Reset AA-target så hero inte fastnar låst på opp.hero
        s.targetId = 0; s.targetType = ''; s.targetX = 0; s.targetZ = 0;
        s.aaActive = false;
      }
    }
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
      side.hero.respawnTimer = Math.max(0, side.hero.respawnTimer - dt);
      if (side.hero.respawnTimer <= 0) respawnHero(side);
    }
  }
  // Bot-AI (line wars-motståndare): sätter rörelse-input + AA/skill/ekonomi-köp.
  if (state.sides[1] && state.sides[1].isBot) tickLineWarsBot(state, 1, dt);
  if (state.sides[2] && state.sides[2].isBot) tickLineWarsBot(state, 2, dt);
  for (const sideIdx of [1, 2]) {
    const side = state.sides[sideIdx];
    const j = state.lastInputs[sideIdx].j;
    heroAutoMove(side, j, dt);
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
      // Hero-MS-slow tick (Gimlu Hammer lvl5 m.fl.)
      if ((side.heroSlowTime || 0) > 0) {
        side.heroSlowTime -= dt;
        if (side.heroSlowTime <= 0) { side.heroSlowTime = 0; side.heroSlowMul = 1; }
      }
      tickKryxTimers(side, dt);   // Titan's Stomp-DR + hjälte-AS-slow (rework)
      // Lvl-5 Legolas mark tick på hero (för duel/arena PvP)
      if ((side.hero.nyroMarked || 0) > 0) side.hero.nyroMarked = Math.max(0, side.hero.nyroMarked - dt);
      // Wind Puff debuff på hero
      if (side.hero.dmgTakenDebuffTime > 0) {
        side.hero.dmgTakenDebuffTime -= dt;
        if (side.hero.dmgTakenDebuffTime <= 0) side.hero.dmgTakenDebuffMul = 1;
      }
      // Titans Taunt passive heal: 20% av maxHP per sek (= 10% per halvsek) medan tauntet är aktivt
      if ((side.titansTauntRemaining || 0) > 0 && side.hero.hp < side.hero.maxHp) {
        side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + side.hero.maxHp * TAUNT_HEAL_PER_SEC * dt);
      }
      // (Stalwart Resolve regen borttagen i rework 2026-06-07 — passiven ersatt av berserk-mätaren.)
    }
  }
  for (const sideIdx of [1, 2]) {
    const side = state.sides[sideIdx];
    const opp = arenaOpp(state, sideIdx);
    updateSkillCooldowns(side, dt);
    updateWaves(state, side, dt);
    updateMonsters(state, side, opp, dt);
    updatePlayerCreeps(state, side, opp, dt);
    updateHeroCopies(state, side, dt);
    updateBlackHoles(state, side, opp, dt);
    updateVineTraps(state, side, opp, dt);
    updateHammers(state, side, opp, dt);
    updateIronWill(state, side, opp, dt);
    updateAragurnWhirlwind(state, side, opp, dt);
    updateAragurnLeap(state, side, opp, dt);
    updateAragurnShoutHeal(side, dt);
    updateSoulDrain(state, side, opp, dt);
    updateBossProjectiles(state, side, dt);
    updateBossPools(state, side, dt);
    tickLegolusInvis(side, dt);
    tickThornPools(state, side, dt);
    tickKostefoSkills(state, side, opp, dt);
    // Aragurn passive: cache nearby-enemy-count för damageHero DR-beräkning.
    // Throttlad till 5 Hz (recompute var 0.2s) — O(N+M) iter onödig varje tick.
    if (side.heroId === 'elar') {
      side._elarCountTickAccum = (side._elarCountTickAccum || 0) + dt;
      if (side._elarCountTickAccum >= 0.2 || side.elarNearbyCount == null) {
        side._elarCountTickAccum = 0;
        side.elarNearbyCount = elarNearbyCount(state, side);
      }
    }
    if ((side.nyroBuffRemaining || 0) > 0) side.nyroBuffRemaining = Math.max(0, side.nyroBuffRemaining - dt);
    tickGimluTauntLvl5(state, side, opp, dt);
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
    updateMonsterProjectiles(state, side, dt);
    if (!side.hero.dead) updateHeroAttack(state, side, opp, dt);
    updateProjectiles(state, side, opp, dt);
    updateFireballs(state, side, opp, dt);
    updateNovaEffects(state, side, opp, dt);
    updateActiveBuffs(side, dt);
    // Lvl-5 buff-timers (Gandulf Wind Puff MS, Gimlu Hammer MS m.fl.)
    if ((side.windPuffMsRem || 0) > 0) side.windPuffMsRem = Math.max(0, side.windPuffMsRem - dt);
    if ((side.kryxHammerMsRem || 0) > 0) side.kryxHammerMsRem = Math.max(0, side.kryxHammerMsRem - dt);
    tickZheyna(state, side, dt); tickXina(state, side, dt);
    flushIronWillReflectLvl5(state, side, opp);
    tickAragurnBannersLvl5(side, dt);
    tickIncome(side, dt);
    // Fountain no longer self-heals (user 2026-06-14). Instead a hero standing NEAR its
    // OWN fountain regenerates 2% max HP/sec.
    if (side.hero && !side.hero.dead && side.hero.hp < side.hero.maxHp) {
      const ft = SIDE_CFG[side.idx] && SIDE_CFG[side.idx].tower;
      if (ft) {
        const fdx = side.hero.x - ft.x, fdz = side.hero.z - ft.z;
        if (fdx * fdx + fdz * fdz <= FOUNTAIN_REGEN_RADIUS * FOUNTAIN_REGEN_RADIUS)
          side.hero.hp = Math.min(side.hero.maxHp, side.hero.hp + side.hero.maxHp * FOUNTAIN_REGEN_PCT * dt);
      }
    }
  }
  // Decision 105: synka wave-progression mellan sidor (nästa wave startar
  // bara när BÅDA har avslutat sin wave).
  syncWaves(state.sides);
  checkMatchEnd(state);
}

// Avrundnings-helpers för JSON-payload — reducerar string-storlek vid stringify
// från 15+ tecken (full float-precision) till 4-6 tecken. Använt på positions/HP
// där 1 cm / 1 hp precision räcker visuellt. Snabbare än toFixed (returnerar number).
function r2(v) { return Math.round(v * 100) / 100; }
function r1(v) { return Math.round(v * 10) / 10; }
function r3(v) { return Math.round(v * 1000) / 1000; }
function ri(v) { return Math.round(v); }

// Tom array → undefined så JSON.stringify skippar fältet helt. Stora vinster
// för Kostefo/Aragurn/Legolus-specifika arrays som oftast är tomma (sliders,
// joints, vine traps, hammers, etc).
function arrOpt(arr, mapper) {
  if (!arr || arr.length === 0) return undefined;
  return arr.map(mapper);
}

// Skip-helpers för 0-default-fält. JSON.stringify skippar undefined-värden,
// så 0-värda timer-fält faller bort från payload. Klient läser med `|| 0`-fallback.
function nz(v) { return v > 0 ? v : undefined; }            // numeric > 0
function nzr2(v) { return v > 0 ? r2(v) : undefined; }      // numeric > 0, avrundad
function nzr1(v) { return v > 0 ? r1(v) : undefined; }
function flag(v) { return v ? 1 : undefined; }               // boolean flag

function serializeSide(side) {
  return {
    h: {
      x: r2(side.hero.x), z: r2(side.hero.z),
      hp: ri(side.hero.hp), mh: ri(side.hero.maxHp),
      sh: nzr2(side.shield),   // shield → client shield-bar (G1)
      fx: r3(side.hero.facingX), fz: r3(side.hero.facingZ),
      d: side.hero.dead, rt: nzr1(side.hero.respawnTimer),
      // Debuff-timers — skippas helt när 0 (sparas i payload). Klient: `|| 0`.
      frz: nzr2(side.hero.frozenTime),
      dot: nzr2(side.hero.dotRemaining),
      tnt: nzr2(side.hero.tauntedTime),
      mlk: flag((side.hero.frozenTime || 0) > 0 || (side.iceBlockRemaining || 0) > 0 || (side.heroFearTime || 0) > 0),   // movement-locked (CC) → klient fryser prediktion 2026-06-23
      poi: nzr2(side.hero.poisonRemaining),
      lMk: nzr2(side.hero.nyroMarked),
      // Zheyna (decision 134): klon/spjut/ult-spjut/laddning → klient-render (classic MP).
      zc: side.zheynaClone ? { x: r2(side.zheynaClone.x), z: r2(side.zheynaClone.z) } : undefined,
      zsp: side.zheynaSpear ? { x: r2(side.zheynaSpear.x), z: r2(side.zheynaSpear.z), dx: r3(side.zheynaSpear.dx), dz: r3(side.zheynaSpear.dz) } : undefined,
      zus: side.zheynaUltSpear ? { x: r2(side.zheynaUltSpear.x), z: r2(side.zheynaUltSpear.z), dx: r3(side.zheynaUltSpear.dx), dz: r3(side.zheynaUltSpear.dz), w: r2(side.zheynaUltSpear.width || 3) } : undefined,
      zch: side.zheynaUltCharging ? { c: r2(side.zheynaUltCharge || 0) } : undefined,
      zwr: nzr2(side.zheynaWarpathRem),
      // Xina (decision 139): shurikens/krok/storm/launch + cloak/ult-timers → klient-render (classic MP).
      xsh: (side.xinaShurikens && side.xinaShurikens.length) ? side.xinaShurikens.map(s => ({ x: r2(s.x), z: r2(s.z) })) : undefined,
      xhk: side.xinaHook ? { x: r2(side.xinaHook.x), z: r2(side.xinaHook.z), a: side.xinaHook.attached ? 1 : 0 } : undefined,
      xstm: (side.xinaStorm && side.xinaStorm.length) ? side.xinaStorm.map(s => ({ x: r2(s.x), z: r2(s.z) })) : undefined,
      xlnch: (side.xinaLaunch && side.xinaLaunch.length) ? side.xinaLaunch.map(s => ({ x: r2(s.x), z: r2(s.z), dx: r3(s.dx), dz: r3(s.dz) })) : undefined,
      xcl: nzr2(side.xinaCloakRem),
      xul: nzr2(side.xinaUltRem),
      // Server-auth ults in line wars (2026-06-23): klient renderar laser/rage-ring + berserk-storlek/tint.
      trg: nzr2(side.titansRageTime),
      lz: (side.laserBeam && side.laserBeam.remaining > 0) ? { dx: r3(side.laserBeam.dx), dz: r3(side.laserBeam.dz) } : undefined,
      rg: nzr2(side.rageRemaining),
      bz: nzr2(side.berserkRemaining),
    },
    g: side.gold,
    inc: side.income,
    incT: +side.incomeTimer.toFixed(2),
    incC: side.incomeTickCount || 0,
    // Portal-state — skippas helt om portal-features inte aktiva.
    ptu: nz(side.portalUsesLeft),
    ptc: nzr1(side.portalCooldown),
    pet: flag(side.inEnemyTerritory),
    petT: nzr1(side.enemyTerritoryTimer),
    tu: side.tierUnlocks,
    inv: side.inventory.map(it => ({
      id: it.itemId,
      vt: it.variantId || null,
      lv: it.level,
      ar: +(it.activeRemaining || 0).toFixed(2),
      ac: +(it.activeCd || 0).toFixed(2),
    })),
    ms: r2(side.moveSpeed),
    ad: r1(side.attackDmg),
    ac: side.attackCounter,
    tw: { hp: side.tower.hp, mh: side.tower.maxHp },
    fa: flag(side.heroFountainAura),
    aa: flag(side.aaActive),
    aml: ((side.aaMoveLockTime || 0) > 0) ? 1 : undefined,   // 1 while committing an AA swing → client freezes joystick prediction (tap-to-AA stop, 2026-06-20 v2)
    tg: nz(side.targetId),
    tt: side.targetType || undefined,
    tx: nzr2(side.targetX),
    tz: nzr2(side.targetZ),
    lv: side.level || 1,
    xp: side.xp || 0,
    xpN: side.xpToNext || 0,
    hid: side.heroId || 'zyro',
    hpc: side.heroPickConfirmed ? 1 : 0,
    sk: { q: r2(side.skills.q.cd), f: r2(side.skills.f.cd), e: r2(side.skills.e.cd) },
    // Skill-point-system: skill-levels + stat-points + unspent
    skLv: { q: (side.skillLvl && side.skillLvl.q) || 0, f: (side.skillLvl && side.skillLvl.f) || 0, e: (side.skillLvl && side.skillLvl.e) || 0 },
    stp: { as: (side.statPts && side.statPts.as) || 0, ms: (side.statPts && side.statPts.ms) || 0, hp: (side.statPts && side.statPts.hp) || 0, sd: (side.statPts && side.statPts.sd) || 0, dr: (side.statPts && side.statPts.dr) || 0 },
    up: side.unspentPoints || 0,
    ue: +(side.ultEnergy || 0).toFixed(1),   // ult-energy 0-100 för klientens R-knapp + meter
    // Aragurn-state — klienten roterar hero-mesh under whirlwind + visar leap-y-arc.
    // Skippas helt när inaktivt (undefined → JSON-skip).
    wwR: nzr2(side.whirlwindRemaining),
    leapA: flag(side.elarLeap),
    leapU: side.elarLeap ? r3(1 - (side.elarLeap.remaining / side.elarLeap.total)) : undefined,
    leapTx: side.elarLeap ? r2(side.elarLeap.targetX) : undefined,
    leapTz: side.elarLeap ? r2(side.elarLeap.targetZ) : undefined,
    w: {
      c: side.wave.current,
      a: side.wave.active,
      bt: +(side.wave.betweenTimer || 0).toFixed(1),
      n: side.wave.name || '',
      b: side.wave.isBoss ? 1 : 0,
      p: side.wave.bannerPulse || 0,
      wr: side.wave.waveReady ? 1 : 0,   // decision 105
    },
    M: arrOpt(side.monsters, m => ({
      id: m.id, x: r2(m.x), z: r2(m.z), ry: r3(m.ry), hp: ri(m.hp), mh: m.maxHp || 10,
      boss: flag(m.isBoss), mb: flag(m.isMiniBoss), r: flag(m.attackType === 'range'),
      tier: m.bossTier || undefined,
      aac: m.aac || 0,    // AA-counter — klient detekterar delta → attack-animation
      fz: flag((m.frozenTime || 0) > 0), dot: flag((m.dotRemaining || 0) > 0),
      // Boss-skill activeCast broadcastas så klient kan rendera telegraph + execute
      c: m.activeCast && m.activeCast.skill ? {
        n: m.activeCast.skill.id || '',
        k: m.activeCast.skill.kind || 'groundCircle',
        rad: m.activeCast.skill.radius || 0,
        len: m.activeCast.skill.length || 0,
        ha: m.activeCast.skill.halfAngle || 0,
        w: m.activeCast.skill.width || 0,
        ph: m.activeCast.phase || 'telegraph',
        t: r2(m.activeCast.timer || 0),
        tg: r2(m.activeCast.skill.telegraph || 0),
        tx: m.activeCast.targetX != null ? r2(m.activeCast.targetX) : null,
        tz: m.activeCast.targetZ != null ? r2(m.activeCast.targetZ) : null,
        ox: m.activeCast.originX != null ? r2(m.activeCast.originX) : null,
        oz: m.activeCast.originZ != null ? r2(m.activeCast.originZ) : null,
        dx: m.activeCast.dirX != null ? r3(m.activeCast.dirX) : null,
        dz: m.activeCast.dirZ != null ? r3(m.activeCast.dirZ) : null,
      } : undefined,
    })),
    BP: arrOpt(side.bossProjectiles, p => ({ id: p.id, x: r2(p.x), z: r2(p.z), dx: r3(p.dx), dz: r3(p.dz), kind: p.kind })),
    BPL: arrOpt(side.bossPools, p => ({ id: p.id, x: r2(p.x), z: r2(p.z), rad: p.radius, life: r3(p.life / p.duration) })),
    C: arrOpt(side.playerCreeps, c => ({ id: c.id, typeId: c.typeId, x: r2(c.x), z: r2(c.z), ry: r3(c.ry), hp: ri(c.hp), mh: c.maxHp, aac: c.aac || 0, fz: flag((c.frozenTime || 0) > 0), dot: flag((c.dotRemaining || 0) > 0) })),
    F: arrOpt(side.fireballs, f => ({ id: f.id, x: r2(f.x), y: r2(f.y), z: r2(f.z) })),
    P: arrOpt(side.projectiles, p => ({ id: p.id, x: r2(p.x), y: r2(p.y), z: r2(p.z), aoe: p.isAoE })),
    N: arrOpt(side.novaEffects, n => ({ id: n.id, x: r2(n.x), z: r2(n.z), r: r2(n.r || NOVA_RADIUS), life: r3(n.life / n.maxLife), k: n.kind })),
    CP: arrOpt(side.creepProjectiles, p => ({ id: p.id, x: r2(p.x), y: r2(p.y), z: r2(p.z), kind: p.kind })),
    MR: arrOpt(side.monsterProjectiles, p => ({ id: p.id, x: r2(p.x), y: r2(p.y), z: r2(p.z), kind: p.kind })),
    HC: arrOpt(side.heroCopies, c => ({ id: c.id, owner: c.ownerSideIdx, heroId: c.heroId || 'zyro', x: r2(c.x), z: r2(c.z), ry: r3(c.ry), hp: ri(c.hp), mh: c.maxHp })),
    HCF: arrOpt(side.heroCopyFireballs, f => ({ id: f.id, x: r2(f.x), y: r2(f.y), z: r2(f.z) })),
    FW: arrOpt(side.fireWaves, f => ({ id: f.id, x: r2(f.x), z: r2(f.z), dx: r3(f.dx), dz: r3(f.dz), life: r3(f.life / f.maxLife), k: f.kind })),
    BH: arrOpt(side.blackHoles, b => ({ id: b.id, x: r2(b.x), z: r2(b.z), life: r3(b.life / b.maxLife) })),
    SH: arrOpt(side.shatters, s => ({ id: s.id, x: r2(s.x), z: r2(s.z), life: r3(s.life / s.maxLife) })),
    VT: arrOpt(side.vineTraps, v => ({ id: v.id, x: r2(v.x), z: r2(v.z), life: r3(v.life / v.maxLife) })),
    lbuf: nzr2(side.nyroBuffRemaining),
    shb: nzr2(side.elarShoutBuffTime),   // E3: War Shout buff → gold glow (side-level i classic)
    ldash: flag(side.nyroDashBuffPending),
    lds2: nzr2(side.nyroDashStackCd),
    // Shadow Volley ult-state (Legolus): invis-timer + empowered-AA-flagga + thorn pools
    lInv: nzr2(side.nyroInvisRemaining),
    lAa: flag(side.nyroUltAaPending),
    TP: arrOpt(side.thornPools, p => ({
      id: p.id, x: r2(p.x), z: r2(p.z),
      r: p.radius, life: r3(p.remaining / p.duration),
    })),
    // Kostefo state — alla fält skippas när 0 / null. kCloudX/Z bara om cloud aktiv.
    kCloud: nzr2(side.kostefoCloudRemaining),
    kCloudX: (side.kostefoCloudRemaining || 0) > 0 ? r2(side.kostefoCloudX) : undefined,
    kCloudZ: (side.kostefoCloudRemaining || 0) > 0 ? r2(side.kostefoCloudZ) : undefined,
    // KO3: uniformt kCl-objekt (spegel av arena buf.kCl) så klienten renderar cloud likadant i alla lägen
    kCl: (side.kostefoCloudRemaining || 0) > 0 ? { r: r2(side.kostefoCloudRemaining), x: r2(side.kostefoCloudX), z: r2(side.kostefoCloudZ), rm: r2(side.kostefoCloudRadiusMul || 1) } : undefined,
    kUlt: nzr2(side.kostefoUltRemaining),
    kComp: side.kostefoCompanion ? {
      x: r2(side.kostefoCompanion.x), z: r2(side.kostefoCompanion.z), ry: r3(side.kostefoCompanion.ry || 0),
    } : undefined,
    kJoints: arrOpt(side.kostefoUltJoints, j => ({ a: r3(j.angle) })),
    kGW: arrOpt(side.kostefoGooseWaves, w => ({
      id: w.id, x: r2(w.x), z: r2(w.z), dx: r3(w.dx), dz: r3(w.dz),
      w: w.width, l: w.length, life: r3(w.remaining / w.duration),
    })),
    kSL: arrOpt(side.kostefoSliders, s => ({
      id: s.id, x: r2(s.x), z: r2(s.z), dx: r3(s.dx), dz: r3(s.dz),
    })),
    HM: arrOpt(side.hammers, h => ({ id: h.id, x: r2(h.x), z: r2(h.z), ret: h.returning ? 1 : 0 })),
    taunt: nzr2(side.titansTauntRemaining),
    iw: nzr2(side.ironWillRemaining),
    iwS: nzr1(side.ironWillStored),
    gbuf: nzr2(side.gandulfBuffRemaining),
    gbStk: nz(side.gandulfBuffStacks),
    wpMs: nzr2(side.windPuffMsRem),
    ghMs: nzr2(side.kryxHammerMsRem),
    inAbn: flag(side.inAragurnBanner),
    ABN: arrOpt(side.elarBanners, b => ({ id: b.id, x: r2(b.x), z: r2(b.z), life: r3(b.life / b.maxLife) })),
    kSTp: side.kostefoSliderTpMarker ? { x: r2(side.kostefoSliderTpMarker.x), z: r2(side.kostefoSliderTpMarker.z), rem: r2(side.kostefoSliderTpMarker.remaining) } : undefined,
    kCln: arrOpt(side.kostefoClones, c => ({ id: c.id, x: r2(c.x), z: r2(c.z), ry: r3(c.ry), hp: c.hp })),
    kCrM: side.kostefoCloudRadiusMul && side.kostefoCloudRadiusMul !== 1 ? r3(side.kostefoCloudRadiusMul) : undefined,
    shld: nzr1(side.shield),
    dSp: nzr2(side.duelSpeedBuffRemaining),
    IWE: arrOpt(side.ironWillExplosions, e => ({ id: e.id, x: r2(e.x), z: r2(e.z), life: r3(e.life / e.maxLife) })),
    // Kryx berserk-mätare i classic MP (duel): 1 = charged, 0..1 = andel.
    // Skippar fältet helt när 0 (nz → undefined → JSON.stringify utelämnar det).
    gmBk: side.berserkCharged ? 1 : (side.berserkDmgAccum > 0 && side.hero.maxHp > 0 ? r2(side.berserkDmgAccum / side.hero.maxHp) : undefined),
    // Ganji passive-mätare (Katana's Slice) i classic MP: 1 = full/armed, 0..1 = bygger.
    gjMk: side.ganjiPassiveReady ? 1 : ((side.ganjiMeter || 0) > 0 ? r2(side.ganjiMeter) : undefined),
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
  createArenaState,        // decision 120 Fas 1 (arena server-auth)
  initArenaMatch,          // skapa+initiera arena-match (sätt hjältar + round 1)
  tickArena,               // arena fas-maskin + combat-tick
  serializeArenaState,     // arena → a-state-meddelande
  initBossWarsMatch,       // decision 122 Fas 2 (boss wars server-auth): skapa 3-co-op-match
  tickBossWars,            // boss wars top-tick (slice 0: hjälte-rörelse; AI/ads slice 1-4)
  serializeBossWarsState,  // boss wars → b-state-meddelande
  tickGame,
  serializeState,
  applyEvent,
  recomputeArenaSideStats, // exponeras för talent-recompute i server.js vid a-talent
  isArenaTalent: (id) => !!ENGINE_ARENA_TALENTS[id], // validera klient-skickad talentId (anti-cheat 2026-06-23)
  createSandboxState,      // sandbox-träningsläge (2026-06-18): hjälte + 3 dummies, server-auth
  tickSandbox,             // sandbox-tick (återanvänder boss-wars hjälte-combat, egen funktion)
  serializeSandboxState,   // sandbox → sb-state-meddelande
  sandboxSwapHero,         // byt hjälte på plats utan att lämna sandboxen
};
