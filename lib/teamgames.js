'use strict';
/*
 * Team games: Overwatch and Marvel Rivals. A set is a series of maps (first to 2, 3 or 4), each with its
 * mode, its map and each team's hero ban, and the overlay draws team plates over the top corners with a
 * header at the top centre over the game's own objective display.
 *
 * Overwatch's spectator HUD puts each mode's objective at the top centre, at a different height (measured
 * at 1080p on the Fall Split Overwatch stream, 11/20/26): Escort, Hybrid and Push start about y 40 to 50
 * (the payload or robot panel and distances), Flashpoint and Control about y 62. The old Fall Split header
 * ran from y 20 to 82 and covered all of them, so on the night it was pushed up off the screen by hand.
 * Here the header sits flush with the top edge and comes in two sizes: `full` (two lines, to y 54) where
 * the objective sits low, and `slim` (one line, to y 34) where it sits high. Clash is new and unmeasured,
 * so it takes the slim header. Marvel Rivals is unmeasured too: slim everywhere until a spectator frame
 * says otherwise. Every mode's header can be nudged in Settings (overlay.team.nudge).
 */
const TEAM_GAMES = {
  ow: {
    modes: {
      Control: { header: 'full', maps: ['Antarctic Peninsula', 'Busan', 'Ilios', 'Lijiang Tower', 'Nepal', 'Oasis', 'Samoa'] },
      Escort: { header: 'slim', maps: ['Circuit Royal', 'Dorado', 'Havana', 'Junkertown', 'Rialto', 'Route 66', 'Shambali Monastery', 'Watchpoint: Gibraltar'] },
      Hybrid: { header: 'slim', maps: ['Blizzard World', 'Eichenwalde', 'Hollywood', "King's Row", 'Midtown', 'Numbani', 'Paraíso'] },
      Push: { header: 'slim', maps: ['Colosseo', 'Esperança', 'New Queen Street', 'Runasapi'] },
      Flashpoint: { header: 'full', maps: ['Aatlis', 'New Junk City', 'Suravasa'] },
      Clash: { header: 'slim', maps: ['Hanaoka', 'Throne of Anubis'] },
    },
    ban: true,
  },
  rivals: {
    // Map names are suggestions; the operator types the map as the lobby shows it.
    modes: {
      Domination: { header: 'slim', maps: ["Hellfire Gala: Krakoa", 'Yggsgard: Royal Palace', "Hydra Charteris Base: Hell's Heaven", "Intergalactic Empire of Wakanda: Birnin T'Challa"] },
      Convoy: { header: 'slim', maps: ['Yggsgard: Yggdrasill Path', 'Tokyo 2099: Spider-Islands', 'Empire of Eternal Night: Midtown'] },
      Convergence: { header: 'slim', maps: ['Tokyo 2099: Shin-Shibuya', 'Intergalactic Empire of Wakanda: Hall of Djalia', 'Klyntar: Symbiotic Surface', 'Empire of Eternal Night: Central Park'] },
    },
    ban: true,
  },
};
const isTeamGame = (game) => !!TEAM_GAMES[game];
// The mode a map belongs to, for a map typed without one.
function modeOfMap(game, map) {
  const g = TEAM_GAMES[game];
  if (!g || !map) return '';
  const key = String(map).trim().toLowerCase();
  for (const [mode, m] of Object.entries(g.modes)) if (m.maps.some((x) => x.toLowerCase() === key)) return mode;
  return '';
}
function headerFor(game, mode) {
  const g = TEAM_GAMES[game];
  return (g && g.modes[mode] && g.modes[mode].header) || 'slim';
}
// What pages need: modes with their maps and header size, per team game.
function teamGameInfo() {
  return Object.fromEntries(Object.entries(TEAM_GAMES).map(([id, g]) => [id, {
    ban: g.ban,
    modes: Object.entries(g.modes).map(([name, m]) => ({ name, header: m.header, maps: m.maps })),
  }]));
}

// ---------- the map series on the current set ----------
const clean = (s, n = 60) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
// A map: { map, mode, ban1, ban2, winner } where winner is 1, 2, 'draw' or '' while it is being played.
function cleanMap(m) {
  const x = m && typeof m === 'object' ? m : {};
  const winner = x.winner === 1 || x.winner === 2 || x.winner === 'draw' ? x.winner : '';
  return { map: clean(x.map), mode: clean(x.mode, 30), ban1: clean(x.ban1, 30), ban2: clean(x.ban2, 30), winner };
}
// The list always ends with the map being played (or the next one), unless the series is over.
function seriesState(current) {
  const maps = (current.maps || []).map(cleanMap);
  const firstTo = Math.max(1, Math.ceil((Number(current.bestOf) || 1) / 2));
  const won1 = maps.filter((m) => m.winner === 1).length;
  const won2 = maps.filter((m) => m.winner === 2).length;
  const done = won1 >= firstTo || won2 >= firstTo;
  let live = maps.findIndex((m) => !m.winner);
  if (live < 0) live = done ? -1 : maps.length;
  return { maps, firstTo, won1, won2, done, live, winner: done ? (won1 > won2 ? 1 : 2) : 0 };
}
// Applies one change from the dashboard to current.maps (and the score it drives). Returns the new list.
function applyMapAction(current, game, b) {
  const s = seriesState(current);
  const maps = s.maps;
  const at = (i) => { while (maps.length <= i) maps.push(cleanMap({})); return maps[i]; };
  switch (b.action) {
    case 'edit': {
      // Fields of one map (the live one by default): map, mode, ban1, ban2.
      const i = Number.isInteger(b.index) ? b.index : s.live;
      if (i < 0) throw new Error('The series is over: undo the last map to change it');
      const m = at(i);
      for (const k of ['map', 'mode', 'ban1', 'ban2']) if (typeof b[k] === 'string') m[k] = clean(b[k], k === 'map' ? 60 : 30);
      if (typeof b.map === 'string' && !b.mode && !m.mode) m.mode = modeOfMap(game, m.map);
      break;
    }
    case 'win': {
      if (s.live < 0) throw new Error('The series is already decided: undo the last map first');
      const side = b.side === 1 || b.side === 2 ? b.side : b.side === 'draw' ? 'draw' : null;
      if (!side) throw new Error('Pick the team that won the map');
      at(s.live).winner = side;
      break;
    }
    case 'undo': {
      // Takes back the last result, so that map is live again.
      for (let i = maps.length - 1; i >= 0; i -= 1) if (maps[i].winner) { maps[i].winner = ''; break; }
      break;
    }
    case 'remove': {
      const i = Number(b.index);
      if (Number.isInteger(i) && i >= 0 && i < maps.length) maps.splice(i, 1);
      break;
    }
    case 'clear':
      maps.length = 0;
      break;
    default:
      throw new Error('Unknown map action');
  }
  // Drop empty maps at the end, but keep the live one if it has anything typed.
  while (maps.length && !maps[maps.length - 1].winner && !maps[maps.length - 1].map && !maps[maps.length - 1].mode && !maps[maps.length - 1].ban1 && !maps[maps.length - 1].ban2) maps.pop();
  current.maps = maps;
  const after = seriesState(current);
  current.score1 = after.won1;
  current.score2 = after.won2;
  return after;
}

module.exports = { TEAM_GAMES, isTeamGame, modeOfMap, headerFor, teamGameInfo, seriesState, applyMapAction, cleanMap };
