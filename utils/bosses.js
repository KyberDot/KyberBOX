// The four Minecraft "final boss" mobs tracked by the Bosses Beaten
// widget. Fixed, known set (not admin-addable like death counter
// players), so each gets its own dedicated column on plans rather than a
// separate table - column name is derived here rather than built from
// user input anywhere, since SQL column names can't be parameterized the
// way values can.

const BOSSES = [
  { key: 'elder_guardian', label: 'Elder Guardian', image: '/img/bosses/elder_guardian.webp', column: 'boss_elder_guardian_beaten' },
  { key: 'ender_dragon', label: 'Ender Dragon', image: '/img/bosses/ender_dragon.webp', column: 'boss_ender_dragon_beaten' },
  { key: 'warden', label: 'Warden', image: '/img/bosses/warden.png', column: 'boss_warden_beaten' },
  { key: 'wither', label: 'Wither', image: '/img/bosses/wither.png', column: 'boss_wither_beaten' },
];

const BOSS_BY_KEY = {};
BOSSES.forEach((b) => { BOSS_BY_KEY[b.key] = b; });

function columnForBossKey(key) {
  const boss = BOSS_BY_KEY[key];
  return boss ? boss.column : null;
}

module.exports = { BOSSES, columnForBossKey };
