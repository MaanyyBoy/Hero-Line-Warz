// Server-authoritative account stats/XP reporting (2026-07-03).
//
// WHY: the Unity client used to PATCH its own profiles row (arena_wins/account_xp/…) directly.
// RLS lets a player update their OWN row, so a modified client could set arbitrary stats =
// spoofable leaderboard. Now the trusted server writes the stats after a match, keyed to a
// VERIFIED user id, using the SERVICE_ROLE key (bypasses RLS). The SQL trigger in
// docs/supabase_serverauth_stats.sql freezes those columns for normal clients.
//
// SAFE FEATURE-FLAG: everything here is a NO-OP unless SUPABASE_SERVICE_ROLE_KEY is set (Fly
// secret). Until then the game behaves exactly as before (client-side stats). Nothing to break.
//
// Identity: the client sends its Supabase access_token on host/join; verifyToken() checks it via
// Supabase /auth/v1/user (needs only the public anon key) → returns the real user id. A client
// therefore cannot report for someone else.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mznilvwnyrkszyxsuqyj.supabase.co';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_X50rVWwoywVG-ob82VP-sw_NAsEPzJk';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Mirror the client's AccountService constants so server-awarded XP is identical.
const MATCH_WIN_XP = 200, MATCH_LOSS_XP = 60;

function enabled() { return !!SERVICE_KEY; }

// ---- HTTP (uses global fetch; Node 18+) ----
async function sbFetch(path, opts, key) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return res;
}

// Verify a client's access_token → return { id } or null. Uses the PUBLIC anon key (no secret).
async function verifyToken(accessToken) {
  if (!accessToken || typeof accessToken !== 'string') return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user || !user.id) return null;
    const username = (user.user_metadata && user.user_metadata.username) || null;   // verified nickname (can't be spoofed)
    return { id: user.id, username };
  } catch (_) { return null; }
}

// Report one player's match result. outcome: 'win' | 'loss'. mode: 'arena' | 'linewars' | 'boss'.
// Read-modify-write via SERVICE_ROLE (per-user concurrency is ~nil, so a race is negligible).
// vsBots: när matchen innehöll bottar hoppar vi över leaderboard-kolumnerna (win/loss/boss_clears)
// men ger fortfarande XP — exakt som klientens anti-farm-gate (AccountService.ReportResult).
async function reportMatchResult({ userId, outcome, mode, heroLegacyId, bossTier, vsBots }) {
  if (!enabled() || !userId) return;
  const won = outcome === 'win';
  try {
    // 1) read current row (service_role bypasses RLS)
    const getRes = await sbFetch(
      `/rest/v1/profiles?id=eq.${userId}&select=lw_wins,lw_losses,arena_wins,arena_losses,boss_clears,best_boss_tier,account_xp,hero_xp`,
      { method: 'GET' }, SERVICE_KEY);
    if (!getRes.ok) return;
    const rows = await getRes.json();
    const cur = (rows && rows[0]) || {};

    const patch = {};
    // win/loss columns per mode — SKIPPAS för bot-matcher (anti-farm), XP ges ändå nedan
    if (!vsBots) {
      if (mode === 'arena') patch[won ? 'arena_wins' : 'arena_losses'] = (cur[won ? 'arena_wins' : 'arena_losses'] || 0) + 1;
      else if (mode === 'linewars') patch[won ? 'lw_wins' : 'lw_losses'] = (cur[won ? 'lw_wins' : 'lw_losses'] || 0) + 1;
      else if (mode === 'boss' && won) {
        patch.boss_clears = (cur.boss_clears || 0) + 1;
        if (bossTier && bossTier > (cur.best_boss_tier || 0)) patch.best_boss_tier = bossTier;
      }
    }
    // XP: account-XP ges alltid; per-hjälte hero_xp (= mastery-progress) ges EJ för bot-matcher (anti-farm,
    // user 2026-07-08 — mastery ska bara byggas mot riktiga spelare).
    const gain = won ? MATCH_WIN_XP : MATCH_LOSS_XP;
    patch.account_xp = (cur.account_xp || 0) + gain;
    const heroXp = (cur.hero_xp && typeof cur.hero_xp === 'object') ? { ...cur.hero_xp } : {};
    if (!vsBots && heroLegacyId) heroXp[heroLegacyId] = (heroXp[heroLegacyId] || 0) + gain;
    patch.hero_xp = heroXp;

    // 2) write back
    await sbFetch(`/rest/v1/profiles?id=eq.${userId}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
    }, SERVICE_KEY);
  } catch (_) { /* best-effort; never throw into the game loop */ }
}

module.exports = { enabled, verifyToken, reportMatchResult };
