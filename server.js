const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const tutorial = require('./tutorial-island');

// ── Constants ──────────────────────────────────────────────────────────────────
const PORT = 2222;
const TICK_MS = 600;
const STATE_INTERVAL = 1;
const SAVE_INTERVAL_MS = 30000;
const DATA_DIR = path.join(__dirname, 'data');
const CHUNKS_DIR = path.join(DATA_DIR, 'chunks');
const TILE_DATA_DIR = path.join(DATA_DIR, 'tile-data');
const NAMES_FILE = path.join(DATA_DIR, 'names.json');
const FRIENDS_FILE = path.join(DATA_DIR, 'friends.json');
const WALLS_FILE = path.join(DATA_DIR, 'walls.json');
const DOORS_FILE = path.join(DATA_DIR, 'doors.json');
const HEIGHTS_FILE = path.join(DATA_DIR, 'heights.json');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const VARIANTS_FILE = path.join(DATA_DIR, 'variants.json');
const APPEARANCES_FILE = path.join(DATA_DIR, 'appearances.json');
const playerPositions = new Map(); // name → {x, y, layer}
const playerAppearances = new Map(); // name → appearance object
const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1480654483095552123/AsoMuMPfGyKNYma5hh-kYnIaNLm4sLF8Ui3rVewiZf37anEXyw5qU_7I8E8gQkDcDm1E';
const DISCORD_BOT_USER_ID = '1464768627709313044';
const BOT_PLAYER_ID = 0; // Reserved ID for Discord bot "AI"

const CHUNK_SIZE = 64;
const VIEW_DIST = 3;
const ENTITY_VIEW = (VIEW_DIST + 1) * CHUNK_SIZE;
const SPAWN_X = 100, SPAWN_Y = 100;

// ── Tick Queue System (OSRS-authentic action scheduling) ─────────────────────
// Actions are scheduled for a future tick and run in priority order:
//   0 = movement, 1 = player actions, 2 = NPC actions, 3 = world events
// Usage: schedule(tick + 4, 1, 'player:3:attack', () => { ... })
// The key is optional — if provided, scheduling with the same key replaces the old entry.
const tickQueue = []; // { tick, priority, key, fn }

function schedule(atTick, priority, key, fn) {
  // If key provided, remove any existing entry with that key
  if (key) {
    for (let i = tickQueue.length - 1; i >= 0; i--) {
      if (tickQueue[i].key === key) { tickQueue.splice(i, 1); break; }
    }
  }
  tickQueue.push({ tick: atTick, priority, key, fn });
}

function cancelScheduled(key) {
  for (let i = tickQueue.length - 1; i >= 0; i--) {
    if (tickQueue[i].key === key) { tickQueue.splice(i, 1); return true; }
  }
  return false;
}

function processTickQueue() {
  // Collect all actions due this tick
  const due = [];
  for (let i = tickQueue.length - 1; i >= 0; i--) {
    if (tickQueue[i].tick <= tick) {
      due.push(tickQueue[i]);
      tickQueue.splice(i, 1);
    }
  }
  // Sort by priority (lower = earlier)
  due.sort((a, b) => a.priority - b.priority);
  // Execute
  for (const action of due) {
    try { action.fn(); } catch (e) { console.error('[tickQueue] Error:', e.message); }
  }
}


const T = {
  GRASS: 0, WATER: 1, TREE: 2, PATH: 3, ROCK: 4, SAND: 5, WALL: 6,
  FLOOR: 7, DOOR: 8, BRIDGE: 9, FISH_SPOT: 10, FLOWER: 11, BUSH: 12,
  DARK_GRASS: 13, CUSTOM: 14
};

// ── OSRS Terrain Data ─────────────────────────────────────────────────────────
const underlayRgb = {}; // id -> '#rrggbb'
const overlayRgb = {}; // id -> { hex, texture, hideUnderlay }
const terrainCache = new Map(); // 'cx_cy' -> Uint8Array(64*64*3) RGB per tile
const collisionCache = new Map(); // 'cx_cy' -> Uint8Array(64*64) settings flags per tile

function loadTerrainDefs() {
  try {
    const ul = JSON.parse(fs.readFileSync(path.join(TILE_DATA_DIR, 'underlays-rgb.json'), 'utf8'));
    for (const u of ul) underlayRgb[u.id] = u.hex;
    const ol = JSON.parse(fs.readFileSync(path.join(TILE_DATA_DIR, 'overlays-rgb.json'), 'utf8'));
    for (const o of ol) overlayRgb[o.id] = { hex: o.hex, texture: o.texture, hide: o.hideUnderlay };
    console.log(`[terrain] Loaded ${ul.length} underlays, ${ol.length} overlays`);
  } catch (e) {
    console.log('[terrain] No terrain definitions found, using default colors');
  }
}

function loadTerrainChunk(cx, cy) {
  const key = `${cx}_${cy}`;
  if (terrainCache.has(key)) return terrainCache.get(key);
  const filePath = path.join(TILE_DATA_DIR, `${cx}_${cy}.json`);
  if (!fs.existsSync(filePath)) { terrainCache.set(key, null); return null; }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // Build RGB array: 64*64*3 bytes
    const rgb = new Uint8Array(64 * 64 * 3);
    for (let x = 0; x < 64; x++) {
      for (let y = 0; y < 64; y++) {
        const ul = data.underlay[x][y];
        const ol = data.overlay[x][y];
        const olDef = overlayRgb[ol];
        let hex;
        if (ol > 0 && olDef && olDef.hide) hex = olDef.hex;
        else if (ul > 0 && underlayRgb[ul]) hex = underlayRgb[ul];
        else hex = null;
        if (hex) {
          const idx = (y * 64 + x) * 3;
          rgb[idx] = parseInt(hex.slice(1, 3), 16);
          rgb[idx + 1] = parseInt(hex.slice(3, 5), 16);
          rgb[idx + 2] = parseInt(hex.slice(5, 7), 16);
        }
        // else stays 0,0,0 (black = no data, client uses default)
      }
    }
    terrainCache.set(key, rgb);
    // Cache collision settings (bit 0 = blocked)
    if (data.settings) {
      const flags = new Uint8Array(64 * 64);
      for (let x = 0; x < 64; x++)
        for (let y = 0; y < 64; y++)
          flags[y * 64 + x] = data.settings[x][y];
      collisionCache.set(key, flags);
    }
    return rgb;
  } catch (e) { terrainCache.set(key, null); return null; }
}


function loadTerrainHeights(cx, cy) {
  const filePath = path.join(TILE_DATA_DIR, `${cx}_${cy}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const heights = new Uint16Array(64 * 64);
    for (let x = 0; x < 64; x++)
      for (let y = 0; y < 64; y++)
        heights[y * 64 + x] = data.height[x][y] || 0;
    return heights;
  } catch (e) { return null; }
}


loadTerrainDefs();


// ── Chunk System ───────────────────────────────────────────────────────────────
const chunks = new Map();

function localXY(wx, wy) {
  return [((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE, ((wy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE];
}

function loadChunkFromDisk(cx, cy, layer = 0) {
  const prefix = layer === 0 ? `${cx}_${cy}` : `L${layer}_${cx}_${cy}`;
  const tp = path.join(CHUNKS_DIR, `${prefix}.bin`);
  if (!fs.existsSync(tp)) return null;
  const buf = fs.readFileSync(tp);
  const tiles = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  tiles.set(new Uint8Array(buf.buffer, buf.byteOffset, Math.min(buf.byteLength, tiles.length)));
  const colors = new Map();
  const cp = path.join(CHUNKS_DIR, `${prefix}.json`);
  if (fs.existsSync(cp)) {
    const obj = JSON.parse(fs.readFileSync(cp, 'utf8'));
    for (const [k, v] of Object.entries(obj)) colors.set(parseInt(k), v);
  }
  return { tiles, colors, dirty: false, lastAccess: Date.now() };
}

function saveChunkToDisk(cx, cy, chunk, layer = 0) {
  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
  const prefix = layer === 0 ? `${cx}_${cy}` : `L${layer}_${cx}_${cy}`;
  fs.writeFileSync(path.join(CHUNKS_DIR, `${prefix}.bin`), Buffer.from(chunk.tiles));
  const cp = path.join(CHUNKS_DIR, `${prefix}.json`);
  if (chunk.colors.size > 0) {
    const obj = {}; for (const [k, v] of chunk.colors) obj[k] = v;
    fs.writeFileSync(cp, JSON.stringify(obj));
  } else if (fs.existsSync(cp)) { fs.unlinkSync(cp); }
  chunk.dirty = false;
}

function getChunk(cx, cy, layer = 0) {
  const key = `${layer}_${cx}_${cy}`;
  let chunk = chunks.get(key);
  if (chunk) return chunk;
  chunk = loadChunkFromDisk(cx, cy, layer);
  if (!chunk) { const tiles = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE); tiles.fill(T.WATER); chunk = { tiles, colors: new Map(), dirty: false, lastAccess: Date.now() }; }
  chunks.set(key, chunk);
  return chunk;
}

function tileAt(x, y, layer = 0) {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const key = `${layer}_${cx}_${cy}`;
  let chunk = chunks.get(key);
  if (!chunk) {
    chunk = loadChunkFromDisk(cx, cy, layer);
    if (!chunk) return T.WATER;
    chunks.set(key, chunk);
  }
  const [lx, ly] = localXY(x, y);
  return chunk.tiles[ly * CHUNK_SIZE + lx];
}

function setTile(x, y, t, layer = 0) {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const chunk = getChunk(cx, cy, layer);
  const [lx, ly] = localXY(x, y);
  chunk.tiles[ly * CHUNK_SIZE + lx] = t;
  chunk.dirty = true;
  chunk.lastAccess = Date.now();
}

function getColor(x, y, layer = 0) {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const chunk = chunks.get(`${layer}_${cx}_${cy}`);
  if (!chunk) return null;
  const [lx, ly] = localXY(x, y);
  return chunk.colors.get(ly * CHUNK_SIZE + lx) || null;
}

function setColor(x, y, color, layer = 0) {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const chunk = getChunk(cx, cy, layer);
  const [lx, ly] = localXY(x, y);
  const k = ly * CHUNK_SIZE + lx;
  if (color) chunk.colors.set(k, color);
  else chunk.colors.delete(k);
  chunk.dirty = true;
}

// Cardinal adjacency check — OSRS melee requires N/S/E/W, no diagonals
function isCardinalAdjacent(x1, y1, x2, y2) {
  const dx = Math.abs(x1 - x2), dy = Math.abs(y1 - y2);
  return (dx === 1 && dy === 0) || (dx === 0 && dy === 1);
}

// Tile variant storage (server-side)
global.tileVariantMap = new Map(); // "layer_x_y" → variant number

function saveVariants() {
  try {
    const obj = {};
    for (const [k, v] of global.tileVariantMap) obj[k] = v;
    fs.writeFileSync(VARIANTS_FILE, JSON.stringify(obj));
  } catch (e) { console.warn('[variants] Save error:', e.message); }
}

function loadVariants() {
  try {
    if (fs.existsSync(VARIANTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(VARIANTS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(data)) global.tileVariantMap.set(k, v);
      console.log(`[variants] Loaded ${global.tileVariantMap.size} tile variants`);
    }
  } catch (e) { console.warn('[variants] Load error:', e.message); }
}

// Wall/door edge storage (server-side, mirrors client)
const serverWallEdges = new Map(); // "layer_x_y" → bitmask (N=1, E=2, S=4, W=8, diagNE=16, diagNW=32)
const serverWallTexMap = new Map(); // "layer_x_y" → "type_variant" (wall texture key)
const serverDoorEdges = new Map();
const serverOpenDoors = new Map(); // "layer_x_y" → bitmask of which edges are currently open
const serverTileHeights = new Map(); // "layer_x_y" → height (float)
const serverRoofs = new Map(); // "layer_id" → roof object
let serverNextRoofId = 1;
const ROOFS_FILE = path.join(DATA_DIR, 'roofs.json');
const WALL_TEX_FILE = path.join(DATA_DIR, 'wall_textures.json');

function saveWalls() {
  try {
    const walls = {}; for (const [k, v] of serverWallEdges) walls[k] = v;
    const doors = {}; for (const [k, v] of serverDoorEdges) doors[k] = v;
    const heights = {}; for (const [k, v] of serverTileHeights) heights[k] = v;
    fs.writeFileSync(WALLS_FILE, JSON.stringify(walls));
    fs.writeFileSync(DOORS_FILE, JSON.stringify(doors));
    fs.writeFileSync(HEIGHTS_FILE, JSON.stringify(heights));
    const roofs = {}; for (const [k, v] of serverRoofs) roofs[k] = v;
    fs.writeFileSync(ROOFS_FILE, JSON.stringify(roofs));
    const wallTex = {}; for (const [k, v] of serverWallTexMap) wallTex[k] = v;
    fs.writeFileSync(WALL_TEX_FILE, JSON.stringify(wallTex));
  } catch (e) { console.warn('[walls] Save error:', e.message); }
}

function loadWalls() {
  try {
    if (fs.existsSync(WALLS_FILE)) {
      const walls = JSON.parse(fs.readFileSync(WALLS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(walls)) serverWallEdges.set(k, v);
      console.log(`[walls] Loaded ${serverWallEdges.size} wall edges`);
    }
    if (fs.existsSync(DOORS_FILE)) {
      const doors = JSON.parse(fs.readFileSync(DOORS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(doors)) serverDoorEdges.set(k, v);
      console.log(`[walls] Loaded ${serverDoorEdges.size} door edges`);
    }
    if (fs.existsSync(HEIGHTS_FILE)) {
      const heights = JSON.parse(fs.readFileSync(HEIGHTS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(heights)) serverTileHeights.set(k, parseFloat(v));
      console.log(`[heights] Loaded ${serverTileHeights.size} tile heights`);
    }
    if (fs.existsSync(ROOFS_FILE)) {
      const roofs = JSON.parse(fs.readFileSync(ROOFS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(roofs)) { serverRoofs.set(k, v); if (v.id >= serverNextRoofId) serverNextRoofId = v.id + 1; }
      console.log(`[roofs] Loaded ${serverRoofs.size} roofs`);
    }
    if (fs.existsSync(WALL_TEX_FILE)) {
      const wallTex = JSON.parse(fs.readFileSync(WALL_TEX_FILE, 'utf8'));
      for (const [k, v] of Object.entries(wallTex)) serverWallTexMap.set(k, v);
      console.log(`[wallTex] Loaded ${serverWallTexMap.size} wall textures`);
    }
  } catch (e) { console.warn('[walls] Load error:', e.message); }
}

// Send wall/door edges for a layer to a player
function sendEdgesForLayer(ws, layer) {
  const walls = [], doors = [];
  for (const [k, v] of serverWallEdges) {
    const parts = k.split('_');
    if (parseInt(parts[0]) === layer) walls.push({ x: parseInt(parts[1]), y: parseInt(parts[2]), mask: v });
  }
  for (const [k, v] of serverDoorEdges) {
    const parts = k.split('_');
    if (parseInt(parts[0]) === layer) doors.push({ x: parseInt(parts[1]), y: parseInt(parts[2]), mask: v });
  }
  if (walls.length > 0) send(ws, { t: 'walls_bulk', layer, walls });
  if (doors.length > 0) send(ws, { t: 'doors_bulk', layer, doors });
}
function getServerWallEdge(x, y, layer = 0) { return serverWallEdges.get(`${layer}_${x}_${y}`) || 0; }
function getServerDoorEdge(x, y, layer = 0) { return serverDoorEdges.get(`${layer}_${x}_${y}`) || 0; }

function isWalkable(x, y, layer = 0) {
  // Only walls block movement — tile colors are purely visual
  const we = getServerWallEdge(x, y, layer);
  if (we & 48) return false; // diagonal walls block the full tile
  return true;
}

// Check if movement from (fx,fy) to (tx,ty) is blocked by an edge wall
function isEdgeBlocked(fx, fy, tx, ty, layer = 0) {
  const dx = tx - fx, dy = ty - fy;
  // Combine wall + door edges, but exclude open doors from blocking
  const fromOpen = serverOpenDoors.get(`${layer}_${fx}_${fy}`) || 0;
  const toOpen = serverOpenDoors.get(`${layer}_${tx}_${ty}`) || 0;
  const fromEdges = getServerWallEdge(fx, fy, layer) | (getServerDoorEdge(fx, fy, layer) & ~fromOpen);
  const toEdges = getServerWallEdge(tx, ty, layer) | (getServerDoorEdge(tx, ty, layer) & ~toOpen);
  // Cardinal movement
  if (dx === 0 && dy === 1) return !!(fromEdges & 1) || !!(toEdges & 4);   // moving north: from's N wall or to's S wall
  if (dx === 0 && dy === -1) return !!(fromEdges & 4) || !!(toEdges & 1);   // moving south
  if (dx === 1 && dy === 0) return !!(fromEdges & 2) || !!(toEdges & 8);   // moving east
  if (dx === -1 && dy === 0) return !!(fromEdges & 8) || !!(toEdges & 2);  // moving west
  // Diagonal movement: check both cardinal components
  if (dx !== 0 && dy !== 0) {
    if (isEdgeBlocked(fx, fy, fx + dx, fy, layer)) return true;
    if (isEdgeBlocked(fx, fy, fx, fy + dy, layer)) return true;
    if (isEdgeBlocked(fx + dx, fy, tx, ty, layer)) return true;
    if (isEdgeBlocked(fx, fy + dy, tx, ty, layer)) return true;
  }
  return false;
}

function evictChunks() {
  const now = Date.now();
  const keep = new Set();
  for (const [, p] of players) {
    const cx = Math.floor(p.x / CHUNK_SIZE), cy = Math.floor(p.y / CHUNK_SIZE);
    for (let dx = -(VIEW_DIST + 1); dx <= VIEW_DIST + 1; dx++)
      for (let dy = -(VIEW_DIST + 1); dy <= VIEW_DIST + 1; dy++)
        keep.add(`${p.layer}_${cx + dx}_${cy + dy}`);
  }
  for (const [key, chunk] of chunks) {
    if (keep.has(key)) continue;
    if (now - chunk.lastAccess > 60000) {
      if (chunk.dirty) {
        const parts = key.split('_').map(Number);
        const [layer, cx, cy] = parts;
        saveChunkToDisk(cx, cy, chunk, layer);
      }
      chunks.delete(key);
    }
  }
}

function saveAllChunks() {
  let saved = 0;
  for (const [key, chunk] of chunks) {
    if (!chunk.dirty) continue;
    const parts = key.split('_').map(Number);
    const [layer, cx, cy] = parts;
    saveChunkToDisk(cx, cy, chunk, layer);
    saved++;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const namesObj = {}; for (const [k, v] of customNames) namesObj[k] = v;
  fs.writeFileSync(NAMES_FILE, JSON.stringify(namesObj));
  if (saved > 0 || customNames.size > 0) console.log(`[save] ${saved} chunks, ${customNames.size} names`);
}

// ── World State ────────────────────────────────────────────────────────────────
let players = new Map();
let npcs = [];
let respawns = [];
let groundItems = [];
let openDoors = new Map();
let customNames = new Map();
let nextGroundItemId = 1;
let tick = 0;
let nextPlayerId = 1;

// ── Friends System ────────────────────────────────────────────────────────────
const friendsData = new Map(); // id -> Set of friend ids
const playerNames = new Map(); // id -> display name

// Load friends from disk
function loadPositions() {
  try {
    if (fs.existsSync(POSITIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
      for (const [name, pos] of Object.entries(data)) playerPositions.set(name, pos);
      console.log(`[positions] Loaded ${playerPositions.size} saved positions`);
    }
  } catch (e) {}
}
function savePositions() {
  try {
    const data = {};
    for (const [name, pos] of playerPositions) data[name] = pos;
    // Also save all currently online players
    for (const [, p] of players) {
      const name = playerNames.get(p.id);
      if (name) data[name] = { x: p.x, y: p.y, layer: p.layer };
    }
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify(data));
  } catch (e) {}
}

const DEFAULT_APPEARANCE = {
  bodyType: 'A', // A or B
  head: 0, jaw: 0, torso: 0, arms: 0, hands: 0, legs: 0, feet: 0,
  hairColor: '#6B3A2A', torsoColor: '#8B7355', legsColor: '#4A5568', feetColor: '#5C4033', skinColor: '#D4A574',
};

function loadAppearances() {
  try {
    if (fs.existsSync(APPEARANCES_FILE)) {
      const data = JSON.parse(fs.readFileSync(APPEARANCES_FILE, 'utf8'));
      for (const [name, app] of Object.entries(data)) playerAppearances.set(name, app);
      console.log(`[appearances] Loaded ${playerAppearances.size} saved appearances`);
    }
  } catch (e) {}
}
function saveAppearances() {
  try {
    const data = {};
    for (const [name, app] of playerAppearances) data[name] = app;
    // Also save all currently online players
    for (const [, p] of players) {
      const name = playerNames.get(p.id);
      if (name && p.appearance) data[name] = p.appearance;
    }
    fs.writeFileSync(APPEARANCES_FILE, JSON.stringify(data));
  } catch (e) {}
}

function loadFriends() {
  try {
    if (fs.existsSync(FRIENDS_FILE)) {
      const data = JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8'));
      if (data.friends) for (const [id, friends] of Object.entries(data.friends)) {
        friendsData.set(parseInt(id), new Set(friends));
      }
      if (data.names) for (const [id, name] of Object.entries(data.names)) {
        playerNames.set(parseInt(id), name);
      }
      if (data.nextId) nextPlayerId = data.nextId;
      console.log(`[friends] Loaded ${friendsData.size} friend lists, ${playerNames.size} names`);
    }
  } catch (e) { console.log('[friends] Load error:', e.message); }
}

function saveFriends() {
  try {
    const friends = {};
    for (const [id, set] of friendsData) friends[id] = [...set];
    const names = {};
    for (const [id, name] of playerNames) names[id] = name;
    fs.writeFileSync(FRIENDS_FILE, JSON.stringify({ friends, names, nextId: nextPlayerId }));
  } catch (e) { console.log('[friends] Save error:', e.message); }
}

function getPlayerById(id) {
  for (const [, p] of players) if (p.id === id) return p;
  return null;
}
function getPlayerByName(name) {
  const lower = name.toLowerCase();
  for (const [, p] of players) if ((playerNames.get(p.id) || `Player ${p.id}`).toLowerCase() === lower) return p;
  return null;
}
function getFriendsList(playerId) {
  const friends = friendsData.get(playerId) || new Set();
  return [...friends].map(fid => {
    const isOnline = fid === BOT_PLAYER_ID ? discordConnected : !!getPlayerById(fid);
    return {
      id: fid,
      name: playerNames.get(fid) || `Player ${fid}`,
      online: isOnline,
      world: isOnline ? 1 : 0,
    };
  });
}
function buildOnlineList() {
  const list = [];
  for (const [, op] of players) list.push({ id: op.id, name: playerNames.get(op.id) || `Player ${op.id}` });
  if (discordConnected) list.push({ id: BOT_PLAYER_ID, name: 'AI' });
  return list;
}
function sendFriendsList(p) {
  send(p.ws, { t: 'friends', list: getFriendsList(p.id), name: playerNames.get(p.id) || `Player ${p.id}` });
}
function notifyFriendsOfStatus(playerId, online) {
  const name = playerNames.get(playerId) || `Player ${playerId}`;
  // Notify all online players who have this player as a friend
  for (const [, p] of players) {
    const pFriends = friendsData.get(p.id);
    if (pFriends && pFriends.has(playerId)) {
      sendFriendsList(p);
      if (online) sendChat(p, `${name} has logged in.`, '#22c55e');
      else sendChat(p, `${name} has logged out.`, '#888888');
    }
  }
}

// ── Seeded RNG ─────────────────────────────────────────────────────────────────
let seed = 42;
function rng() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

// ── Game Definitions (from OSRS cache) ──────────────────────────────────────
const itemDefs = new Map(); // id -> def
const npcDefs = new Map();  // id -> def
const ITEM_BY_NAME = new Map(); // lowercase name -> def

function loadDefinitions() {
  try {
    const items = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'items.json'), 'utf8'));
    for (const i of items) { itemDefs.set(i.id, i); ITEM_BY_NAME.set(i.name.toLowerCase(), i); }
    console.log(`[defs] Loaded ${itemDefs.size} items`);
  } catch (e) { console.log('[defs] items.json error:', e.message); }
  try {
    const npcsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'npcs.json'), 'utf8'));
    for (const n of npcsData) npcDefs.set(n.id, n);
    console.log(`[defs] Loaded ${npcDefs.size} NPCs`);
  } catch (e) { console.log('[defs] npcs.json error:', e.message); }
}

// Item param keys for equipment bonuses
const EQUIP_PARAMS = {
  0: 'astab', 1: 'aslash', 2: 'acrush', 3: 'amagic', 4: 'aranged',
  5: 'dstab', 6: 'dslash', 7: 'dcrush', 8: 'dmagic', 9: 'dranged',
  10: 'str', 11: 'rstr', 13: 'prayer', 14: 'aspeed'
};

function getItemBonuses(itemId) {
  const def = itemDefs.get(itemId);
  if (!def || !def.params) return null;
  const b = {};
  for (const [paramId, key] of Object.entries(EQUIP_PARAMS)) {
    if (def.params[paramId] !== undefined) b[key] = def.params[paramId];
  }
  return Object.keys(b).length > 0 ? b : null;
}

function itemName(id) { const d = itemDefs.get(id); return d ? d.name : `Item #${id}`; }
function findItemId(name) { const d = ITEM_BY_NAME.get(name.toLowerCase()); return d ? d.id : -1; }

// ── Gear Tier System ─────────────────────────────────────────────────────────
// Every weapon/armor gets a tier (1, 2, or 3). Players can lock their account
// to a lower tier as a self-imposed challenge (like OSRS pures but for gear).
// p.gearTier = 1|2|3 — blocks equipping anything above that tier.
// Tier 1: basic (bronze-level)  — low max hit, low DR
// Tier 2: mid   (iron-level)    — moderate max hit, moderate DR
// Tier 3: end   (steel+-level)  — full max hit, full DR
// Items should have a `tier` field (1/2/3). On equip: if (item.tier > p.gearTier) reject.
// TODO: add tier field to item defs, equip handler check, UI toggle to lock tier

// Equipment slots
const EQUIP_SLOTS = ['head', 'cape', 'neck', 'weapon', 'body', 'shield', 'legs', 'hands', 'feet', 'ring', 'ammo'];

function calcEquipBonuses(equipment) {
  const total = { astab:0, aslash:0, acrush:0, amagic:0, aranged:0, dstab:0, dslash:0, dcrush:0, dmagic:0, dranged:0, str:0, rstr:0, prayer:0 };
  for (const slot of EQUIP_SLOTS) {
    const id = equipment[slot];
    if (!id || id < 0) continue;
    const b = getItemBonuses(id);
    if (!b) continue;
    for (const k of Object.keys(total)) if (b[k]) total[k] += b[k];
  }
  return total;
}

// ── NPC Spawns ──────────────────────────────────────────────────────────────
function spawnNpcs() {
  // No OSRS NPC spawns — custom NPCs can be added here in the future
  console.log('[npcs] No NPC spawn data loaded (OSRS data removed)');
}

// ── Tutorial Island NPC Spawns ───────────────────────────────────────────────
function spawnTutorialNpcs() {
  // Spawn tutorial guide NPCs (non-combat, talkable)
  for (const tn of tutorial.TUTORIAL_NPCS) {
    npcs.push({
      id: npcs.length, defId: tn.defId, name: tn.name,
      x: tn.x, y: tn.y, spawnX: tn.x, spawnY: tn.y,
      hp: 1, maxHp: 1, attack: 1, strength: 1, defence: 1,
      ranged: 1, magic: 1, combatLevel: 0,
      aggressive: false, dead: false, respawnTick: 0,
      wanderTick: 0, nextAttackTick: 0, attackSpeed: 4,
      combatTarget: null, combatTimeout: 0,
      drops: [], color: '#ffff00',
      tutorialNpc: true, tutorialStep: tn.step,
    });
  }
  // Spawn tutorial combat NPCs (giant rats, chickens)
  for (const cn of tutorial.TUTORIAL_COMBAT_NPCS) {
    npcs.push({
      id: npcs.length, defId: cn.defId, name: cn.name,
      x: cn.x, y: cn.y, spawnX: cn.x, spawnY: cn.y,
      hp: cn.hp, maxHp: cn.maxHp,
      attack: cn.attack, strength: cn.strength, defence: cn.defence,
      ranged: 1, magic: 1, combatLevel: cn.combatLevel,
      aggressive: false, dead: false, respawnTick: 0,
      wanderTick: Math.floor(Math.random() * 100),
      nextAttackTick: 0, attackSpeed: cn.attackSpeed,
      combatTarget: null, combatTimeout: 0,
      drops: [], color: '#8b1a1a',
      tutorialCombatNpc: true,
    });
  }
  console.log(`[tutorial] Spawned ${tutorial.TUTORIAL_NPCS.length} guide NPCs + ${tutorial.TUTORIAL_COMBAT_NPCS.length} combat NPCs on Tutorial Island`);
}

// ── Tutorial Island Logic ───────────────────────────────────────────────────
function handleTutorialTalk(p, npc) {
  if (p.tutorialComplete) return false;
  if (!npc.tutorialNpc) return false;

  const step = tutorial.STEPS[p.tutorialStep];
  if (!step || !step.npc) return false;

  // Check if this is the right NPC for the current step
  if (step.npc !== npc.name) {
    sendChat(p, `You need to talk to the ${tutorial.STEPS[p.tutorialStep].npc || 'next instructor'}.`, '#ff0');
    return true;
  }

  // Send dialogue
  if (step.dialogue) {
    for (const line of step.dialogue) {
      sendChat(p, `[${npc.name}] ${line}`, '#0ff');
    }
  }

  // Give items
  if (step.give) {
    for (const item of step.give) {
      addItemById(p, item.id, item.count);
    }
    sendChat(p, 'You receive some items.', '#ff0');
  }

  // Check for completion
  if (step.complete) {
    completeTutorial(p);
    return true;
  }

  // Advance step
  p.tutorialStep++;
  const nextStep = tutorial.STEPS[p.tutorialStep];

  // If next step is an action step, show what to do
  if (nextStep && nextStep.action) {
    sendChat(p, nextStep.message, '#0f0');
  }
  // If next step is also a talk step (same NPC), hint to talk again
  else if (nextStep && nextStep.npc) {
    // Auto-advance simple UI steps (open_tab, pray, go_underground)
  }

  sendStats(p);
  return true;
}

function handleTutorialAction(p, action, data) {
  if (p.tutorialComplete) return;
  const step = tutorial.STEPS[p.tutorialStep];
  if (!step || !step.action) return;

  if (!p.tutorialProgress) p.tutorialProgress = {};

  switch (step.action) {
    case 'fish': {
      if (action !== 'fish') return;
      p.tutorialProgress.fishCount = (p.tutorialProgress.fishCount || 0) + 1;
      if (p.tutorialProgress.fishCount >= (step.count || 2)) {
        sendChat(p, 'You\'ve caught enough shrimps! Talk to the Survival Expert.', '#0f0');
        p.tutorialStep++;
        p.tutorialProgress = {};
      }
      break;
    }
    case 'skills': {
      if (!p.tutorialProgress.skills) p.tutorialProgress.skills = {};
      const sp = p.tutorialProgress.skills;
      if (action === 'woodcutting') sp.woodcutting = (sp.woodcutting || 0) + 1;
      if (action === 'firemaking') sp.firemaking = (sp.firemaking || 0) + 1;
      if (action === 'cooking') sp.cooking = (sp.cooking || 0) + 1;
      // Check all tasks done
      const allDone = step.tasks.every(t => (sp[t.skill] || 0) >= t.count);
      if (allDone) {
        sendChat(p, 'Great work! Head to the Master Chef\'s building.', '#0f0');
        p.tutorialStep++;
        p.tutorialProgress = {};
      }
      break;
    }
    case 'cook_bread': {
      if (action !== 'cook_bread') return;
      sendChat(p, 'Delicious bread! Now head through the door and find the Quest Guide.', '#0f0');
      p.tutorialStep++;
      break;
    }
    case 'go_underground': {
      // Auto-advance when player reaches underground Y coords
      if (action === 'move' && data && data.y < 9600 && data.y > 9400) {
        sendChat(p, 'You\'ve entered the mining area. Talk to the Mining Instructor.', '#0f0');
        p.tutorialStep++;
      }
      break;
    }
    case 'mine_and_smelt': {
      if (!p.tutorialProgress.mine) p.tutorialProgress.mine = {};
      const mp = p.tutorialProgress.mine;
      if (action === 'mine_tin') mp.tin = true;
      if (action === 'mine_copper') mp.copper = true;
      if (action === 'smelt') mp.smelted = true;
      if (mp.tin && mp.copper && mp.smelted) {
        sendChat(p, 'You made a bronze bar! Talk to the Mining Instructor.', '#0f0');
        p.tutorialStep++;
        p.tutorialProgress = {};
      }
      break;
    }
    case 'smith_dagger': {
      if (action !== 'smith') return;
      sendChat(p, 'You smithed a bronze dagger! Find the Combat Instructor.', '#0f0');
      p.tutorialStep++;
      break;
    }
    case 'kill_melee': {
      if (action !== 'kill' || data?.target !== step.target) return;
      sendChat(p, 'Well fought! Talk to the Combat Instructor.', '#0f0');
      p.tutorialStep++;
      break;
    }
    case 'kill_ranged': {
      if (action !== 'kill' || data?.target !== step.target) return;
      sendChat(p, 'Great ranged shot! Talk to the Combat Instructor.', '#0f0');
      p.tutorialStep++;
      break;
    }
    case 'open_tab': {
      // Auto-advance
      sendChat(p, 'Good. Now find Brother Brace at the chapel.', '#0f0');
      p.tutorialStep++;
      break;
    }
    case 'pray': {
      // Auto-advance
      sendChat(p, 'You feel the power of prayer. Continue south to the Ironman tutor.', '#0f0');
      p.tutorialStep++;
      break;
    }
    case 'kill_magic': {
      if (action !== 'kill' || data?.target !== step.target) return;
      sendChat(p, 'Magical! Talk to the Magic Instructor to complete Tutorial Island.', '#0f0');
      p.tutorialStep++;
      break;
    }
  }
}

function completeTutorial(p) {
  p.tutorialComplete = true;
  p.tutorialStep = -1;

  // Clear inventory and give completion items
  p.inventory = [];
  for (const item of tutorial.COMPLETION_INVENTORY) {
    addItemById(p, item.id, item.count);
  }

  // Teleport to Lumbridge
  p.x = SPAWN_X;
  p.y = SPAWN_Y;
  p.prevX = SPAWN_X;
  p.prevY = SPAWN_Y;
  p.path = [];
  p.gathering = null;
  p.combatTarget = null;
  p.clickedNpc = null;
  p.sentChunks = new Set();

  sendChat(p, 'Welcome to Lumbridge! Your adventure begins now.', '#ff0');
  sendChat(p, 'You have been given starter equipment and supplies.', '#0f0');
  sendStats(p);
  console.log(`[tutorial] Player ${p.id} completed Tutorial Island`);
}

// Basic drop tables (expand with wiki data later)
function getDropTable(def) {
  const drops = [];
  const name = def.name.toLowerCase();
  // Bones (almost everything drops bones)
  if (def.combatLevel > 0) drops.push({ id: findItemId('Bones'), weight: 1, always: true });
  // Specific drops by NPC name
  if (name.includes('chicken')) { drops.push({ id: findItemId('Feather'), weight: 3 }); drops.push({ id: findItemId('Raw chicken'), weight: 1, always: true }); }
  if (name.includes('cow')) { drops.push({ id: findItemId('Cowhide'), weight: 1, always: true }); drops.push({ id: findItemId('Raw beef'), weight: 1, always: true }); }
  if (name.includes('goblin')) { drops.push({ id: findItemId('Coins'), weight: 2, qty: [1, 5] }); }
  if (name.includes('guard')) { drops.push({ id: findItemId('Coins'), weight: 2, qty: [10, 30] }); }
  if (name === 'giant rat') { drops.push({ id: findItemId('Raw rat meat'), weight: 1, always: true }); }
  if (name.includes('spider')) { /* spiders only drop bones */ }
  return drops;
}

// ── All 23 OSRS Skills ─────────────────────────────────────────────────────
const ALL_SKILLS = [
  'attack', 'strength', 'defence', 'ranged', 'prayer', 'magic', 'runecraft',
  'hitpoints', 'crafting', 'mining', 'smithing', 'fishing', 'cooking',
  'firemaking', 'woodcutting', 'agility', 'herblore', 'thieving', 'fletching',
  'slayer', 'farming', 'construction', 'hunter'
];

// ── XP ─────────────────────────────────────────────────────────────────────────
function xpForLevel(l) {
  let t = 0;
  for (let i = 1; i < l; i++) t += Math.floor(i + 300 * Math.pow(2, i / 7)) / 4;
  return Math.floor(t);
}
function levelForXp(xp) {
  for (let l = 1; l < 99; l++) if (xpForLevel(l + 1) > xp) return l;
  return 99;
}
function addXp(p, skill, amount) {
  p.skills[skill].xp += amount;
  const nl = levelForXp(p.skills[skill].xp);
  if (nl > p.skills[skill].level) {
    p.skills[skill].level = nl;
    sendChat(p, `Congratulations! Your ${skill} level is now ${nl}!`, '#ff0');
  }
}

// ── Pathfinding (A*) ───────────────────────────────────────────────────────────
function findPath(sx, sy, tx, ty, layer = 0) {
  if (!isWalkable(tx, ty, layer)) return [];
  if (sx === tx && sy === ty) return [];
  if (Math.abs(tx - sx) + Math.abs(ty - sy) > 200) return [];
  const key = (x, y) => `${x},${y}`;
  const open = [{ x: sx, y: sy, g: 0, f: 0 }];
  const closed = new Set();
  const came = new Map();
  const gScore = new Map();
  gScore.set(key(sx, sy), 0);
  let searched = 0;
  while (open.length > 0 && searched < 2000) {
    searched++;
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift();
    if (cur.x === tx && cur.y === ty) {
      const p = [];
      let k = key(tx, ty);
      while (came.has(k)) { const c = came.get(k); p.unshift({ x: c.x, y: c.y }); k = key(c.px, c.py); }
      p.push({ x: tx, y: ty });
      return p;
    }
    closed.add(key(cur.x, cur.y));
    for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0],[-1,-1],[1,-1],[-1,1],[1,1]]) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!isWalkable(nx, ny, layer) || closed.has(key(nx, ny))) continue;
      if (isEdgeBlocked(cur.x, cur.y, nx, ny, layer)) continue;
      if (dx !== 0 && dy !== 0 && (!isWalkable(cur.x + dx, cur.y, layer) || !isWalkable(cur.x, cur.y + dy, layer))) continue;
      const ng = cur.g + (dx !== 0 && dy !== 0 ? 1.41 : 1);
      const k = key(nx, ny);
      if (!gScore.has(k) || ng < gScore.get(k)) {
        gScore.set(k, ng);
        open.push({ x: nx, y: ny, g: ng, f: ng + Math.abs(nx - tx) + Math.abs(ny - ty) });
        came.set(k, { x: nx, y: ny, px: cur.x, py: cur.y });
      }
    }
  }
  return [];
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const [ws] of players) if (ws.readyState === WebSocket.OPEN) ws.send(s);
}

// ── Discord Bridge (integrated) ──────────────────────────────────────────────
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const DISCORD_CHANNEL_ID = '1480654372131180635';
const DISCORD_API = 'https://discord.com/api/v10';
const POLL_INTERVAL_MS = 3000; // check for new messages every 3s

let discordConnected = false;
let lastPmToBot = null;
let pendingNpcTalk = null;
let lastSeenMessageId = null;
let discordPollTimer = null;

function postToDiscord(content) {
  if (!DISCORD_WEBHOOK) return;
  fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  }).catch(e => console.error('[discord] webhook error:', e.message));
}

function initBotPlayer() {
  playerNames.set(BOT_PLAYER_ID, 'AI');
  if (!friendsData.has(BOT_PLAYER_ID)) friendsData.set(BOT_PLAYER_ID, new Set());
}

function setBotOnline(online) {
  discordConnected = online;
  if (online) {
    broadcast({ t: 'chat', msg: 'AI has connected.', color: '#7289da' });
  } else {
    broadcast({ t: 'chat', msg: 'AI has disconnected.', color: '#888' });
  }
  notifyFriendsOfStatus(BOT_PLAYER_ID, online);
  broadcast({ t: 'online_players', list: buildOnlineList() });
}

// Poll Discord channel for new messages from FUTURE BOT
async function pollDiscordMessages() {
  try {
    const url = lastSeenMessageId
      ? `${DISCORD_API}/channels/${DISCORD_CHANNEL_ID}/messages?after=${lastSeenMessageId}&limit=10`
      : `${DISCORD_API}/channels/${DISCORD_CHANNEL_ID}/messages?limit=1`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bot ${DISCORD_BOT_TOKEN}` }
    });
    if (!res.ok) {
      console.error(`[discord] Poll error: ${res.status}`);
      return;
    }
    const messages = await res.json();
    if (!Array.isArray(messages) || messages.length === 0) return;

    // Messages come newest-first, reverse to process in order
    messages.reverse();

    // On first poll, just record the latest ID (don't process old messages)
    if (!lastSeenMessageId) {
      lastSeenMessageId = messages[messages.length - 1].id;
      if (!discordConnected) {
        setBotOnline(true);
        console.log('[discord] Polling active, AI online');
      }
      return;
    }

    for (const msg of messages) {
      lastSeenMessageId = msg.id;

      // Skip webhook messages (those are from us)
      if (msg.webhook_id) continue;

      const isBot = msg.author.id === DISCORD_BOT_USER_ID;
      const name = isBot ? 'AI' : msg.author.username;
      const text = (msg.content || '').trim().slice(0, 200);
      if (!text) continue;

      console.log(`[discord] → Game: ${name}: ${text}`);

      if (isBot) {
        // Route NPC talk response
        if (pendingNpcTalk) {
          const recipient = getPlayerById(pendingNpcTalk.playerId);
          if (recipient) {
            send(recipient.ws, { t: 'chat', msg: `[${pendingNpcTalk.npcName}] ${text}`, color: '#0ff' });
          }
          pendingNpcTalk = null;
          continue;
        }
        // Route PM reply
        if (lastPmToBot !== null) {
          const recipient = getPlayerById(lastPmToBot);
          if (recipient) {
            send(recipient.ws, { t: 'pm', from: BOT_PLAYER_ID, fromName: 'AI', msg: text });
          }
          continue;
        }
      }
      // Show in game chat
      broadcast({ t: 'chat', msg: `${name}: ${text}`, color: '#7289da' });
    }
  } catch (e) {
    console.error('[discord] Poll error:', e.message);
  }
}

function startDiscordPolling() {
  console.log('[discord] Starting message polling...');
  pollDiscordMessages(); // initial poll to get last message ID
  discordPollTimer = setInterval(pollDiscordMessages, POLL_INTERVAL_MS);
}
function broadcastTiles(changes, layer = 0) {
  const byChunk = new Map();
  for (const c of changes) {
    const key = `${layer}_${Math.floor(c.x / CHUNK_SIZE)}_${Math.floor(c.y / CHUNK_SIZE)}`;
    if (!byChunk.has(key)) byChunk.set(key, []);
    byChunk.get(key).push(c);
  }
  for (const [ws, p] of players) {
    if (p.layer !== layer) continue;
    const rel = [];
    for (const [key, cc] of byChunk) if (p.sentChunks.has(key)) rel.push(...cc);
    if (rel.length > 0) send(ws, { t: 'tiles', changes: rel });
  }
}
function sendChat(p, msg, color) { send(p.ws, { t: 'chat', msg, color }); }
function sendStats(p) {
  // Send inventory with names resolved for client display
  const inv = p.inventory.map(i => ({ id: i.id, name: itemName(i.id), count: i.count }));
  const equip = {};
  for (const s of EQUIP_SLOTS) {
    if (p.equipment[s] >= 0) equip[s] = { id: p.equipment[s], name: itemName(p.equipment[s]) };
  }
  send(p.ws, { t: 'stats', hp: p.hp, maxHp: p.maxHp, skills: p.skills, inv, equip, bonuses: calcEquipBonuses(p.equipment), activePrayer: p.activePrayer });
}

function addItemById(p, id, count = 1) {
  if (id < 0) return false;
  const def = itemDefs.get(id);
  const stackable = def && def.stackable;
  if (stackable) {
    const ex = p.inventory.find(i => i.id === id);
    if (ex) { ex.count += count; return true; }
  }
  if (p.inventory.length >= 28) { sendChat(p, 'Your inventory is full.', '#f44'); return false; }
  if (stackable) {
    p.inventory.push({ id, count });
  } else {
    for (let i = 0; i < count; i++) {
      if (p.inventory.length >= 28) { sendChat(p, 'Your inventory is full.', '#f44'); return i > 0; }
      p.inventory.push({ id, count: 1 });
    }
  }
  return true;
}

// Legacy name-based wrapper (for gathering/old code)
function addItem(p, name) {
  const id = findItemId(name);
  if (id < 0) { // fallback: add by name for items not in cache
    if (p.inventory.length >= 28) { sendChat(p, 'Your inventory is full.', '#f44'); return false; }
    const ex = p.inventory.find(i => i.name === name && !i.id);
    if (ex) ex.count++; else p.inventory.push({ id: -1, name, count: 1 });
    return true;
  }
  return addItemById(p, id);
}

function dropItemGround(id, x, y, count = 1) {
  groundItems.push({ id: nextGroundItemId++, itemId: id, name: itemName(id), x, y, count, despawnTick: tick + 167 });
}
function dropItem(name, x, y) {
  const id = findItemId(name);
  groundItems.push({ id: nextGroundItemId++, itemId: id, name: id >= 0 ? itemName(id) : name, x, y, count: 1, despawnTick: tick + 167 });
}

function findCluster(tx, ty, layer = 0) {
  const t = tileAt(tx, ty, layer);
  let x0 = tx, y0 = ty;
  while (tileAt(x0 - 1, y0, layer) === t) x0--;
  while (tileAt(x0, y0 - 1, layer) === t) y0--;
  let w = 0, h = 0;
  while (tileAt(x0 + w, y0, layer) === t) w++;
  while (tileAt(x0, y0 + h, layer) === t) h++;
  return { x: x0, y: y0, w, h };
}

function walkToClusterBase(cx, cy, cw, ch, px, py, layer = 0) {
  const candidates = [];
  for (let dx = 0; dx < cw; dx++) if (isWalkable(cx + dx, cy + ch, layer)) candidates.push([cx + dx, cy + ch]);
  for (let dy = 0; dy < ch; dy++) {
    if (isWalkable(cx - 1, cy + dy, layer)) candidates.push([cx - 1, cy + dy]);
    if (isWalkable(cx + cw, cy + dy, layer)) candidates.push([cx + cw, cy + dy]);
  }
  for (let dx = 0; dx < cw; dx++) if (isWalkable(cx + dx, cy - 1, layer)) candidates.push([cx + dx, cy - 1]);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (Math.abs(a[0] - px) + Math.abs(a[1] - py)) - (Math.abs(b[0] - px) + Math.abs(b[1] - py)));
  return candidates[0];
}

function walkAdjacentTo(tx, ty, px, py, layer = 0) {
  const adj = [[tx-1,ty],[tx+1,ty],[tx,ty-1],[tx,ty+1]].filter(([x,y]) => isWalkable(x,y, layer));
  if (adj.length === 0) return null;
  adj.sort((a, b) => (Math.abs(a[0] - px) + Math.abs(a[1] - py)) - (Math.abs(b[0] - px) + Math.abs(b[1] - py)));
  return adj[0];
}

// ── Bucket Fill ──────────────────────────────────────────────────────────────
function bucketFill(sx, sy, newTile, newColor, layer = 0) {
  const oldTile = tileAt(sx, sy, layer);
  const oldColor = oldTile === T.CUSTOM ? (getColor(sx, sy, layer) || '#ff00ff') : null;
  if (oldTile === newTile && (newTile !== T.CUSTOM || oldColor === newColor)) return [];
  const changes = [], stack = [{ x: sx, y: sy }], visited = new Set();
  function matches(x, y) {
    if (Math.abs(x - sx) > 100 || Math.abs(y - sy) > 100) return false;
    if (tileAt(x, y, layer) !== oldTile) return false;
    if (oldTile === T.CUSTOM) return (getColor(x, y, layer) || '#ff00ff') === oldColor;
    return true;
  }
  while (stack.length > 0 && changes.length < 5000) {
    const { x, y } = stack.pop();
    const k = `${x},${y}`;
    if (visited.has(k) || !matches(x, y)) continue;
    visited.add(k);
    const prev = tileAt(x, y, layer);
    const prevColor = prev === T.CUSTOM ? (getColor(x, y, layer) || null) : null;
    setTile(x, y, newTile, layer);
    if (newTile === T.CUSTOM && newColor) setColor(x, y, newColor, layer);
    else setColor(x, y, null, layer);
    changes.push({ x, y, tile: newTile, color: newColor || null, prevTile: prev, prevColor });
    // Only spread to neighbors not blocked by wall/door edges
    if (!isEdgeBlocked(x, y, x+1, y, layer)) stack.push({ x: x+1, y });
    if (!isEdgeBlocked(x, y, x-1, y, layer)) stack.push({ x: x-1, y });
    if (!isEdgeBlocked(x, y, x, y+1, layer)) stack.push({ x, y: y+1 });
    if (!isEdgeBlocked(x, y, x, y-1, layer)) stack.push({ x, y: y-1 });
  }
  return changes;
}

function tileKey(x, y, layer = 0) {
  const t = tileAt(x, y, layer);
  if (t === T.CUSTOM) return 'c:' + (getColor(x, y, layer) || '#ff00ff');
  return 't:' + t;
}

function bucketAllRecolor(sx, sy, newTile, newColor, layer = 0) {
  const targetKey = tileKey(sx, sy, layer);
  const changes = [];
  for (const [key, chunk] of chunks) {
    const parts = key.split('_').map(Number);
    const [chunkLayer, cx, cy] = parts;
    if (chunkLayer !== layer) continue;
    const baseX = cx * CHUNK_SIZE, baseY = cy * CHUNK_SIZE;
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const k = ly * CHUNK_SIZE + lx;
        const t = chunk.tiles[k];
        const tk = t === T.CUSTOM ? 'c:' + (chunk.colors.get(k) || '#ff00ff') : 't:' + t;
        if (tk !== targetKey) continue;
        const wx = baseX + lx, wy = baseY + ly;
        const prev = t, prevColor = t === T.CUSTOM ? (chunk.colors.get(k) || null) : null;
        chunk.tiles[k] = newTile;
        if (newTile === T.CUSTOM && newColor) chunk.colors.set(k, newColor);
        else chunk.colors.delete(k);
        chunk.dirty = true;
        changes.push({ x: wx, y: wy, tile: newTile, color: newColor || null, prevTile: prev, prevColor });
      }
    }
  }
  return changes;
}

// ── Player Chunks ──────────────────────────────────────────────────────────────
function sendChunkToPlayer(ws, cx, cy, layer = 0) {
  const chunk = getChunk(cx, cy, layer);
  const colorsObj = {};
  for (const [k, v] of chunk.colors) colorsObj[k] = v;
  const msg = { t: 'chunk', cx, cy, tiles: Buffer.from(chunk.tiles).toString('base64'), colors: colorsObj };
  // Attach OSRS terrain data if available
  const terrain = loadTerrainChunk(cx, cy);
  if (terrain) msg.terrain = Buffer.from(terrain).toString('base64');
  const heights = loadTerrainHeights(cx, cy);
  if (heights) msg.heights = Buffer.from(heights.buffer).toString('base64');
  // Attach tile variants for this chunk
  if (global.tileVariantMap) {
    const variants = {};
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = cx * CHUNK_SIZE + lx, wy = cy * CHUNK_SIZE + ly;
        const vKey = `${layer}_${wx}_${wy}`;
        const v = global.tileVariantMap.get(vKey);
        if (v > 0) variants[`${lx}_${ly}`] = v;
      }
    }
    if (Object.keys(variants).length > 0) msg.variants = variants;
  }
  send(ws, msg);
}

function updatePlayerChunks(p) {
  const pcx = Math.floor(p.x / CHUNK_SIZE), pcy = Math.floor(p.y / CHUNK_SIZE);
  for (let dx = -VIEW_DIST; dx <= VIEW_DIST; dx++) {
    for (let dy = -VIEW_DIST; dy <= VIEW_DIST; dy++) {
      const key = `${p.layer}_${pcx + dx}_${pcy + dy}`;
      if (!p.sentChunks.has(key)) {
        sendChunkToPlayer(p.ws, pcx + dx, pcy + dy, p.layer);
        p.sentChunks.add(key);
      }
    }
  }
  for (const key of p.sentChunks) {
    const parts = key.split('_').map(Number);
    const [layer, cx, cy] = parts;
    if (layer !== p.layer || Math.abs(cx - pcx) > VIEW_DIST + 2 || Math.abs(cy - pcy) > VIEW_DIST + 2) {
      p.sentChunks.delete(key);
    }
  }
}

// ── Player Factory ─────────────────────────────────────────────────────────────
function createPlayer(ws) {
  const sx = SPAWN_X;
  const sy = SPAWN_Y;
  const skills = {};
  for (const s of ALL_SKILLS) skills[s] = { xp: 0, level: 1 };
  // Combat stats start at 99 — balanced around max cb, gear is the lever
  const XP_99 = xpForLevel(99);
  for (const s of ['attack', 'strength', 'defence', 'ranged', 'prayer', 'magic', 'hitpoints']) {
    skills[s] = { xp: XP_99, level: 99 };
  }
  const equipment = {};
  for (const s of EQUIP_SLOTS) equipment[s] = -1;
  const pid = nextPlayerId++;
  playerNames.set(pid, `Player ${pid}`);
  if (!friendsData.has(pid)) friendsData.set(pid, new Set());
  return {
    id: pid, ws, x: sx, y: sy, prevX: sx, prevY: sy, layer: 0, hp: 99, maxHp: 99,
    gender: 'male', appearance: { ...DEFAULT_APPEARANCE }, sentChunks: new Set(),
    path: [], gathering: null, actionTick: 0,
    combatTarget: null, clickedNpc: null, pendingPickup: null, pendingTalk: null, gatherCluster: null,
    nextAttackTick: 0, attackSpeed: 4,
    autoRetaliate: true,
    activePrayer: null, // null | 'melee' | 'ranged' | 'magic'
    gearTier: 3, // 1-3, restricts equippable gear tier (self-imposed challenge mode)
    skills, equipment,
    inventory: [],
    // Tutorial Island state
    tutorialStep: 0,          // current step index in tutorial.STEPS
    tutorialComplete: false,  // true after completing Tutorial Island
    tutorialProgress: {},     // tracks sub-tasks (e.g. fish count, trees chopped)
  };
}

// ── Combat Style Detection ───────────────────────────────────────────────────
// Weapon categories for attack speed and style
const RANGED_WEAPONS = new Set(); // populated from item defs
const MAGIC_WEAPONS = new Set();  // populated from item defs

function getCombatStyle(p) {
  const wepId = p.equipment.weapon;
  if (!wepId || wepId < 0) return { style: 'melee', speed: 4, range: 1 };
  const def = itemDefs.get(wepId);
  if (!def) return { style: 'melee', speed: 4, range: 1 };
  const name = (def.name || '').toLowerCase();
  const params = def.params || {};
  const aspeed = params[14]; // attack speed param

  // Detect ranged weapons
  if (name.includes('bow') || name.includes('crossbow') || name.includes('dart') ||
      name.includes('knife') || name.includes('thrownaxe') || name.includes('javelin') ||
      name.includes('chinchompa') || name.includes('blowpipe') || name.includes('ballista')) {
    const speed = aspeed !== undefined ? aspeed : 4;
    const range = name.includes('longbow') || name.includes('ballista') ? 10 : 7;
    return { style: 'ranged', speed, range };
  }

  // Detect magic weapons (staves)
  if (name.includes('staff') || name.includes('wand') || name.includes('trident') ||
      name.includes('sanguinesti') || name.includes('tumeken')) {
    return { style: 'magic', speed: 5, range: 10 };
  }

  // Melee
  const speed = aspeed !== undefined ? aspeed : 4;
  return { style: 'melee', speed, range: 1 };
}

function isInAttackRange(x1, y1, x2, y2, range) {
  if (range <= 1) return isCardinalAdjacent(x1, y1, x2, y2);
  const dx = Math.abs(x1 - x2);
  const dy = Math.abs(y1 - y2);
  return Math.max(dx, dy) <= range;
}

// Projectile delay: 1 tick base + 1 per 3 tiles distance (approximate OSRS formula)
function getProjectileDelay(x1, y1, x2, y2) {
  const dist = Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
  return 1 + Math.floor(dist / 3);
}

// ── Combat Helpers (scheduled via tick queue) ────────────────────────────────
function schedulePlayerAttack(p, npcId, delay) {
  schedule(tick + delay, 1, `patk:${p.id}`, () => playerAttackTick(p, npcId));
}

function playerAttackTick(p, npcId) {
  const npc = npcs[npcId];
  if (!npc || npc.dead || p.combatTarget !== npcId) {
    sendChat(p, `[${tick}] patk:CANCEL (dead=${npc?.dead} target=${p.combatTarget}) P:${p.x},${p.y}`, '#888');
    return;
  }

  const combat = getCombatStyle(p);
  p.attackSpeed = combat.speed;

  if (!isInAttackRange(p.x, p.y, npc.x, npc.y, combat.range)) {
    sendChat(p, `[${tick}] patk:CHASE (P:${p.x},${p.y} N:${npc.x},${npc.y} style=${combat.style} range=${combat.range})`, '#888');
    schedule(tick + 1, 1, `patk:${p.id}`, () => playerAttackTick(p, npcId));
    return;
  }
  // Enforce attack speed cooldown — never attack before nextAttackTick
  if (tick < p.nextAttackTick) {
    sendChat(p, `[${tick}] patk:WAIT (next=${p.nextAttackTick}) P:${p.x},${p.y}`, '#888');
    schedule(p.nextAttackTick, 1, `patk:${p.id}`, () => playerAttackTick(p, npcId));
    return;
  }
  // Execute attack
  npc.combatTarget = p.id;
  const bonuses = calcEquipBonuses(p.equipment);

  // Calculate hit chance based on combat style
  let attRoll, defRoll, effStr, maxHit;
  if (combat.style === 'magic') {
    const effMag = p.skills.magic.level + 1 + 8;
    attRoll = effMag * (bonuses.amagic + 64);
    defRoll = ((npc.magic || npc.defence || 1) + 9) * (64);
    // Magic max hit: base spell damage (simplified: magic level / 3)
    maxHit = Math.max(1, Math.floor(p.skills.magic.level / 3));
  } else if (combat.style === 'ranged') {
    const effRng = p.skills.ranged.level + 1 + 8;
    attRoll = effRng * (bonuses.aranged + 64);
    defRoll = ((npc.defence || 1) + 9) * (64);
    effStr = p.skills.ranged.level + 1 + 8;
    maxHit = Math.max(1, Math.floor(0.5 + effStr * (bonuses.rstr + 64) / 640));
  } else {
    const effAtk = p.skills.attack.level + 1 + 8;
    attRoll = effAtk * (bonuses.aslash + 64);
    defRoll = ((npc.defence || 1) + 9) * 64;
    effStr = p.skills.strength.level + 1 + 8;
    maxHit = Math.max(1, Math.floor(0.5 + effStr * (bonuses.str + 64) / 640));
  }

  // Every attack lands — no accuracy roll, minimum 1 damage
  const dmg = Math.max(1, Math.floor(rng() * (maxHit + 1)));

  // Projectile delay for ranged/magic
  const projDelay = combat.style !== 'melee' ? getProjectileDelay(p.x, p.y, npc.x, npc.y) : 0;

  if (projDelay > 0) {
    // Schedule damage to apply after projectile travel
    const px = p.x, py = p.y, nx = npc.x, ny = npc.y;
    sendChat(p, `[${tick}] You cast at ${npc.name} (${combat.style}, delay=${projDelay}t) P:${px},${py} N:${nx},${ny}`, '#f44');
    schedule(tick + projDelay, 1, `proj:${p.id}:${tick}`, () => {
      if (npc.dead) return;
      npc.hp -= dmg;
      sendChat(p, `[${tick}] You hit ${npc.name} for ${dmg} (P:${px},${py} N:${npc.x},${npc.y})`, '#f44');
      applyKillCheck(p, npc);
      giveXp(p, combat.style, dmg);
    });
  } else {
    // Melee: instant damage
    npc.hp -= dmg;
    sendChat(p, `[${tick}] You hit ${npc.name} for ${dmg} (P:${p.x},${p.y} N:${npc.x},${npc.y})`, '#f44');
    applyKillCheck(p, npc);
    giveXp(p, combat.style, dmg);
  }

  if (!npc.dead) {
    // Schedule next player attack and record cooldown
    p.nextAttackTick = tick + p.attackSpeed;
    schedulePlayerAttack(p, npcId, p.attackSpeed);
  }
  p.maxHp = p.skills.hitpoints.level;
  sendStats(p);
}

function applyKillCheck(p, npc) {
  if (npc.hp <= 0) {
    npc.dead = true; npc.respawnTick = tick + 17; npc.combatTarget = null;
    cancelScheduled(`natk:${npc.id}`);
    sendChat(p, `You killed ${npc.name}!`, '#0f0');
    // Tutorial kill tracking
    if (!p.tutorialComplete) handleTutorialAction(p, 'kill', { target: npc.name });
    for (const drop of npc.drops) {
      if (drop.id < 0) continue;
      if (drop.always || rng() < (1 / Math.max(1, drop.weight))) {
        const qty = drop.qty ? (drop.qty[0] + Math.floor(rng() * (drop.qty[1] - drop.qty[0] + 1))) : 1;
        dropItemGround(drop.id, npc.x, npc.y, qty);
      }
    }
    p.combatTarget = null;
  }
}

function giveXp(p, style, dmg) {
  if (dmg <= 0) return;
  const baseXp = Math.floor(dmg * 4);
  if (style === 'magic') {
    addXp(p, 'magic', baseXp);
  } else if (style === 'ranged') {
    addXp(p, 'ranged', baseXp);
  } else {
    // Melee: split between attack, strength, defence
    const xpPerSkill = Math.floor(baseXp / 3);
    addXp(p, 'attack', xpPerSkill);
    addXp(p, 'strength', xpPerSkill);
    addXp(p, 'defence', xpPerSkill);
  }
  addXp(p, 'hitpoints', Math.floor(dmg * 1.33));
}

function scheduleNpcAttack(npc, delay) {
  schedule(tick + delay, 2, `natk:${npc.id}`, () => npcAttackTick(npc));
}

function npcAttackTick(npc) {
  if (npc.dead || npc.combatTarget === null) return;
  let combatant = null;
  for (const [, p] of players) {
    if (p.id === npc.combatTarget) { combatant = p; break; }
  }
  if (!combatant) { npc.combatTarget = null; return; }
  const dist = Math.abs(npc.x - combatant.x) + Math.abs(npc.y - combatant.y);
  if (dist > 16 || Math.abs(npc.x - npc.spawnX) + Math.abs(npc.y - npc.spawnY) >= 12) {
    sendChat(combatant, `[${tick}] natk:LEASH (N:${npc.x},${npc.y} spawn:${npc.spawnX},${npc.spawnY})`, '#888');
    npc.combatTarget = null; return;
  }
  if (!isCardinalAdjacent(npc.x, npc.y, combatant.x, combatant.y)) {
    sendChat(combatant, `[${tick}] natk:CHASE (P:${combatant.x},${combatant.y} N:${npc.x},${npc.y})`, '#888');
    schedule(tick + 1, 2, `natk:${npc.id}`, () => npcAttackTick(npc));
    return;
  }
  // Enforce attack speed cooldown — never attack before nextAttackTick
  if (tick < npc.nextAttackTick) {
    sendChat(combatant, `[${tick}] natk:WAIT (next=${npc.nextAttackTick}) N:${npc.x},${npc.y}`, '#888');
    schedule(npc.nextAttackTick, 2, `natk:${npc.id}`, () => npcAttackTick(npc));
    return;
  }
  // Execute NPC attack — every attack lands, minimum 1 damage
  const npcStyle = npc.combatStyle || 'melee';
  const npcMaxHit = Math.max(1, Math.floor(0.5 + ((npc.strength || npc.attack || 1) + 9) * 64 / 640));
  let dmg = Math.max(1, Math.floor(rng() * (npcMaxHit + 1)));
  // Protection prayer: 100% block if correct style
  if (combatant.activePrayer === npcStyle) dmg = 0;
  combatant.hp -= dmg;
  sendChat(combatant, `[${tick}] ${npc.name} hits you for ${dmg} (P:${combatant.x},${combatant.y} N:${npc.x},${npc.y})`, '#f44');
  addXp(combatant, 'defence', Math.floor(dmg * 1.33));
  if (combatant.hp <= 0) killPlayer(combatant);
  combatant.maxHp = combatant.skills.hitpoints.level;
  sendStats(combatant);
  // Auto-retaliate: only if player is idle (no active path) and not already fighting another NPC
  if (combatant.autoRetaliate && combatant.hp > 0 && combatant.path.length === 0) {
    if (combatant.combatTarget === null) {
      // Fresh retaliation — half-speed penalty per OSRS wiki
      combatant.combatTarget = npc.id;
      combatant.clickedNpc = null;
      const retaliateDelay = Math.ceil(combatant.attackSpeed / 2);
      combatant.nextAttackTick = tick + retaliateDelay;
      schedulePlayerAttack(combatant, npc.id, retaliateDelay);
      sendChat(combatant, `[${tick}] AUTO-RETALIATE → ${npc.name} (delay=${retaliateDelay}t)`, '#888');
    }
    // If already fighting (combatTarget set), don't switch — existing schedule continues
  }
  // Schedule next NPC attack and record cooldown
  npc.nextAttackTick = tick + npc.attackSpeed;
  scheduleNpcAttack(npc, npc.attackSpeed);
}

// ── Game Tick ──────────────────────────────────────────────────────────────────
function gameTick() {
  tick++;

  for (const [, p] of players) {
    p.movedThisTick = false;
    if (p.path.length > 0) {
      p.prevX = p.x; p.prevY = p.y; // track previous tile for NPC chase
      const prevCX = Math.floor(p.x / CHUNK_SIZE), prevCY = Math.floor(p.y / CHUNK_SIZE);
      const next = p.path.shift();
      p.x = next.x; p.y = next.y;
      p.movedThisTick = true;
      const newCX = Math.floor(p.x / CHUNK_SIZE), newCY = Math.floor(p.y / CHUNK_SIZE);
      if (newCX !== prevCX || newCY !== prevCY) updatePlayerChunks(p);
    }

    if (p.pendingPickup !== null && p.path.length === 0) {
      const idx = groundItems.findIndex(g => g.id === p.pendingPickup);
      if (idx !== -1) {
        const gi = groundItems[idx];
        if (p.x === gi.x && p.y === gi.y && addItem(p, gi.name)) {
          groundItems.splice(idx, 1);
          sendStats(p);
          sendChat(p, `You pick up: ${gi.name}`, '#ff0');
        }
      }
      p.pendingPickup = null;
    }

    // Tutorial NPC talk — arrive adjacent and trigger dialogue
    if (p.pendingTalk !== null && p.path.length === 0) {
      const talkNpc = npcs[p.pendingTalk];
      if (talkNpc && isCardinalAdjacent(p.x, p.y, talkNpc.x, talkNpc.y)) {
        handleTutorialTalk(p, talkNpc);
      }
      p.pendingTalk = null;
    }

    // Auto-advance tutorial steps that trigger on movement (go_underground)
    if (!p.tutorialComplete && p.tutorialStep >= 0) {
      const step = tutorial.STEPS[p.tutorialStep];
      if (step && step.action === 'go_underground') {
        handleTutorialAction(p, 'move', { y: p.y });
      }
    }

    if (p.gathering && p.path.length === 0) {
      const g = p.gathering;
      const cl = p.gatherCluster;
      let adjacent = false;
      if (cl) {
        for (let dy = 0; dy < cl.h && !adjacent; dy++)
          for (let dx = 0; dx < cl.w && !adjacent; dx++)
            if (Math.abs(p.x - (cl.x + dx)) + Math.abs(p.y - (cl.y + dy)) <= 1) adjacent = true;
      } else {
        adjacent = Math.abs(p.x - g.tx) + Math.abs(p.y - g.ty) <= 1;
      }
      if (adjacent && tileAt(g.tx, g.ty, p.layer) === g.tile) {
        p.actionTick++;
        if (p.actionTick >= 4) {
          p.actionTick = 0;
          if (g.type === 'woodcutting') {
            const wcChance = Math.min(0.9, 0.25 + p.skills.woodcutting.level * 0.005);
            if (rng() >= wcChance) { sendChat(p, 'You swing at the tree...', '#ccc'); }
            else if (addItem(p, 'Logs')) {
              addXp(p, 'woodcutting', 25);
              sendChat(p, 'You chop down the tree.', '#ff0');
              if (!p.tutorialComplete) handleTutorialAction(p, 'woodcutting');
              const cl2 = p.gatherCluster || { x: g.tx, y: g.ty, w: 1, h: 1 };
              const changes = [];
              for (let dy = 0; dy < cl2.h; dy++)
                for (let dx = 0; dx < cl2.w; dx++) {
                  setTile(cl2.x + dx, cl2.y + dy, T.GRASS, p.layer);
                  changes.push({ x: cl2.x + dx, y: cl2.y + dy, tile: T.GRASS });
                  respawns.push({ x: cl2.x + dx, y: cl2.y + dy, tile: T.TREE, tick: tick + 25, layer: p.layer });
                }
              broadcastTiles(changes, p.layer);
              p.gathering = null; p.gatherCluster = null;
            }
          } else if (g.type === 'mining') {
            const mineChance = Math.min(0.9, 0.25 + p.skills.mining.level * 0.005);
            if (rng() >= mineChance) { sendChat(p, 'You swing at the rock...', '#ccc'); }
            else if (addItem(p, 'Ore')) {
              addXp(p, 'mining', 30);
              sendChat(p, 'You mine some ore.', '#ff0');
              setTile(g.tx, g.ty, T.GRASS, p.layer);
              broadcastTiles([{ x: g.tx, y: g.ty, tile: T.GRASS }], p.layer);
              respawns.push({ x: g.tx, y: g.ty, tile: T.ROCK, tick: tick + 33, layer: p.layer });
              p.gathering = null;
            }
          } else if (g.type === 'fishing') {
            const fishChance = Math.min(0.9, 0.25 + p.skills.fishing.level * 0.005);
            if (rng() >= fishChance) { sendChat(p, 'You continue fishing...', '#ccc'); }
            else if (addItem(p, 'Raw fish')) {
              addXp(p, 'fishing', 20);
              sendChat(p, 'You catch a fish.', '#ff0');
              if (!p.tutorialComplete) handleTutorialAction(p, 'fish');
            }
          }
          sendStats(p);
        }
      } else { p.gathering = null; }
    }

    // NPC targeting — chase and initiate combat via tick queue
    if (p.clickedNpc !== null) {
      const npc = npcs[p.clickedNpc];
      if (!npc || npc.dead) {
        p.clickedNpc = null;
      } else {
        const combat = getCombatStyle(p);
        if (isInAttackRange(p.x, p.y, npc.x, npc.y, combat.range)) {
          // In range — start combat, schedule first attacks via tick queue
          p.combatTarget = p.clickedNpc;
          p.clickedNpc = null;
          p.path = [];
          npc.combatTarget = p.id;
          p.attackSpeed = combat.speed;
          // Respect attack cooldowns — don't attack before nextAttackTick
          const pDelay = Math.max(0, p.nextAttackTick - tick);
          const nDelay = Math.max(1, npc.nextAttackTick - tick); // NPC always at least 1 tick after
          schedulePlayerAttack(p, npc.id, pDelay);
          scheduleNpcAttack(npc, nDelay);
        } else if (p.path.length === 0) {
          const adj = walkAdjacentTo(npc.x, npc.y, p.x, p.y, p.layer);
          if (adj) { p.path = findPath(p.x, p.y, adj[0], adj[1], p.layer); }
          else { p.clickedNpc = null; }
        }
      }
    }

    // Chase NPC during active combat if not in range
    if (p.combatTarget !== null) {
      const npc = npcs[p.combatTarget];
      const combat = getCombatStyle(p);
      if (!npc || npc.dead || Math.abs(p.x - npc.x) + Math.abs(p.y - npc.y) > 16) {
        p.combatTarget = null;
        cancelScheduled(`patk:${p.id}`);
      } else if (!isInAttackRange(p.x, p.y, npc.x, npc.y, combat.range) && p.path.length === 0) {
        const adj = walkAdjacentTo(npc.x, npc.y, p.x, p.y, p.layer);
        if (adj) p.path = findPath(p.x, p.y, adj[0], adj[1], p.layer);
      }
      // Combat heartbeat — log every tick while in combat
      if (npc && !npc.dead) {
        const inRange = isInAttackRange(p.x, p.y, npc.x, npc.y, combat.range);
        const dist = Math.max(Math.abs(p.x - npc.x), Math.abs(p.y - npc.y));
        const pNext = p.nextAttackTick; const nNext = npc.nextAttackTick;
        const pWait = Math.max(0, pNext - tick); const nWait = Math.max(0, nNext - tick);
        sendChat(p, `[${tick}] cb: P:${p.x},${p.y} N:${npc.x},${npc.y} dist=${dist} range=${combat.range} style=${combat.style} pAtk=${pWait}t nAtk=${nWait}t`, '#555');
      }
    }
  }

  // NPC AI
  for (const npc of npcs) {
    if (npc.dead) {
      if (tick >= npc.respawnTick) { npc.dead = false; npc.hp = npc.maxHp; npc.x = npc.spawnX; npc.y = npc.spawnY; npc.combatTarget = null; }
      continue;
    }
    // NPC combat state — check if target still valid
    let combatant = null;
    if (npc.combatTarget !== null) {
      for (const [, p] of players) {
        if (p.id === npc.combatTarget) { combatant = p; break; }
      }
      const distToTarget = combatant ? Math.abs(npc.x - combatant.x) + Math.abs(npc.y - combatant.y) : 999;
      if (!combatant || distToTarget > 16 ||
          Math.abs(npc.x - npc.spawnX) + Math.abs(npc.y - npc.spawnY) >= 12) {
        npc.combatTarget = null;
        cancelScheduled(`natk:${npc.id}`);
        combatant = null;
      }
    }
    const inCombat = combatant !== null;

    if (inCombat) {
      // NPC chase: move toward player's PREVIOUS tile (OSRS behavior — NPC takes your old tile)
      // NPC moves every tick but targets where the player WAS (1-tick lag)
      if (!isCardinalAdjacent(npc.x, npc.y, combatant.x, combatant.y)) {
        // Target the player's previous position — NPC walks to where the player WAS
        // OSRS tie-breaking order: West, East, South, North (then diagonals)
        const targetX = combatant.movedThisTick ? combatant.prevX : combatant.x;
        const targetY = combatant.movedThisTick ? combatant.prevY : combatant.y;
        const dx = targetX - npc.x, dy = targetY - npc.y;
        // Try cardinal directions in OSRS priority: W, E, S, N
        // Primary: directions that reduce distance. Fallback: perpendicular directions to path around obstacles.
        const primary = [];
        if (dx < 0) primary.push([-1, 0]); // West
        if (dx > 0) primary.push([1, 0]);  // East
        if (dy < 0) primary.push([0, -1]); // South
        if (dy > 0) primary.push([0, 1]);  // North
        // Fallback: perpendicular directions (try to go around blocked tiles)
        const fallback = [];
        if (dx === 0) { fallback.push([-1, 0]); fallback.push([1, 0]); } // blocked N/S, try W/E
        if (dy === 0) { fallback.push([0, -1]); fallback.push([0, 1]); } // blocked W/E, try S/N
        const allMoves = [...primary, ...fallback];
        let moved = false;
        for (const [mx, my] of allMoves) {
          const nx = npc.x + mx, ny = npc.y + my;
          if (isWalkable(nx, ny) && Math.abs(nx - npc.spawnX) < 12 && Math.abs(ny - npc.spawnY) < 12) {
            npc.x = nx; npc.y = ny; moved = true; break;
          }
        }
      }
    } else if (tick % 5 === npc.wanderTick % 5) {
      // Wander when not in combat
      const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
      const [dx, dy] = dirs[Math.floor(rng() * 4)];
      const nx = npc.x + dx, ny = npc.y + dy;
      if (isWalkable(nx, ny) && Math.abs(nx - npc.spawnX) + Math.abs(ny - npc.spawnY) < 8) {
        npc.x = nx; npc.y = ny;
      }
    }

    // Aggressive NPCs initiate combat with nearby players via tick queue
    if (npc.aggressive && !inCombat) {
      let closest = null, closestDist = 999;
      for (const [, p] of players) {
        const d = Math.abs(p.x - npc.x) + Math.abs(p.y - npc.y);
        if (d < closestDist) { closest = p; closestDist = d; }
      }
      if (closest && closestDist < 5 && !isCardinalAdjacent(npc.x, npc.y, closest.x, closest.y)) {
        // OSRS tie-breaking: W, E, S, N
        const dx = closest.x - npc.x, dy = closest.y - npc.y;
        const moves = [];
        if (dx < 0) moves.push([-1, 0]);
        if (dx > 0) moves.push([1, 0]);
        if (dy < 0) moves.push([0, -1]);
        if (dy > 0) moves.push([0, 1]);
        for (const [mx, my] of moves) {
          if (isWalkable(npc.x + mx, npc.y + my)) { npc.x += mx; npc.y += my; break; }
        }
      }
      if (closest && isCardinalAdjacent(npc.x, npc.y, closest.x, closest.y) && npc.combatTarget === null) {
        // Aggro — schedule NPC attack via queue
        npc.combatTarget = closest.id;
        scheduleNpcAttack(npc, 0);
      }
    }
  }

  // Process tick queue — all scheduled actions (combat, etc.) run here in priority order
  processTickQueue();

  // Respawn resources
  for (let i = respawns.length - 1; i >= 0; i--) {
    if (tick >= respawns[i].tick) {
      const r = respawns[i];
      setTile(r.x, r.y, r.tile, r.layer || 0);
      broadcastTiles([{ x: r.x, y: r.y, tile: r.tile }], r.layer || 0);
      respawns.splice(i, 1);
    }
  }

  // Despawn ground items
  for (let i = groundItems.length - 1; i >= 0; i--) {
    if (tick >= groundItems[i].despawnTick) groundItems.splice(i, 1);
  }

  // HP regen
  if (tick % 100 === 0) {
    for (const [, p] of players) {
      if (p.hp < p.maxHp) { p.hp++; sendStats(p); }
    }
  }

  // Per-player state broadcast (proximity filtered)
  if (tick % STATE_INTERVAL === 0) {
    for (const [ws, p] of players) {
      const pArr = [];
      for (const [, op] of players) {
        if (Math.abs(op.x - p.x) <= ENTITY_VIEW && Math.abs(op.y - p.y) <= ENTITY_VIEW) {
          const opa = op.appearance;
          pArr.push({ id: op.id, x: op.x, y: op.y, hp: op.hp, maxHp: op.maxHp, g: op.gender,
            a: opa ? { bt: opa.bodyType, hc: opa.hairColor, tc: opa.torsoColor, lc: opa.legsColor, fc: opa.feetColor, sc: opa.skinColor } : null,
            path: op.path.slice(0, 20) });
        }
      }
      const nArr = npcs.filter(n => !n.dead && Math.abs(n.x - p.x) <= ENTITY_VIEW && Math.abs(n.y - p.y) <= ENTITY_VIEW)
        .map(n => ({ id: n.id, did: n.defId, x: n.x, y: n.y, hp: n.hp, maxHp: n.maxHp, name: n.name, color: n.color, atk: n.attack || 1, def: n.defence || 1, talk: true }));
      const gArr = groundItems.filter(g => Math.abs(g.x - p.x) <= ENTITY_VIEW && Math.abs(g.y - p.y) <= ENTITY_VIEW)
        .map(g => ({ id: g.id, name: g.name, x: g.x, y: g.y }));
      const dArr = [...openDoors.values()].filter(d => Math.abs(d.ox - p.x) <= ENTITY_VIEW && Math.abs(d.oy - p.y) <= ENTITY_VIEW);
      // Action progress for gathering skills
      let action = null;
      if (p.gathering && p.path.length === 0) {
        const actionNames = { woodcutting: 'Woodcutting', mining: 'Mining', fishing: 'Fishing' };
        const actionItems = { woodcutting: 'Logs', mining: 'Ore', fishing: 'Raw fish' };
        action = {
          type: p.gathering.type,
          name: actionNames[p.gathering.type] || p.gathering.type,
          item: actionItems[p.gathering.type] || '',
          tick: p.actionTick,
          total: 4,
        };
      }
      send(ws, { t: 'state', players: pArr, npcs: nArr, items: gArr, doors: dArr, tick, action });
    }
  }

  // Evict idle chunks every 30s
  if (tick % 50 === 0) evictChunks();
}

function killPlayer(p) {
  cancelScheduled(`patk:${p.id}`);
  p.hp = p.maxHp; p.path = []; p.gathering = null; p.combatTarget = null; p.clickedNpc = null;
  for (let r = 0; r < 50; r++)
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++)
        if (isWalkable(SPAWN_X + dx, SPAWN_Y + dy, p.layer)) { p.x = SPAWN_X + dx; p.y = SPAWN_Y + dy; r = 999; dx = 999; break; }
  sendChat(p, 'Oh dear, you are dead!', '#f00');
  if (p.inventory.length > 3) p.inventory.splice(3);
  sendStats(p);
  updatePlayerChunks(p);
}

// ── Message Handling ───────────────────────────────────────────────────────────
function handleMessage(ws, data) {
  const p = players.get(ws);
  if (!p) return;
  let msg;
  try { msg = JSON.parse(data); } catch { return; }

  switch (msg.t) {
    case 'chat': {
      const text = (msg.msg || '').trim().slice(0, 100);
      const chatName = playerNames.get(p.id) || `Player ${p.id}`;
      if (text) {
        broadcast({ t: 'chat', msg: `${chatName}: ${text}`, color: '#0000aa' });
        // Forward to Discord webhook
        postToDiscord(`**${chatName}:** ${text}`);
      }
      break;
    }
    case 'set_name': {
      const name = (msg.name || '').trim().slice(0, 20);
      if (name.length < 1) { sendChat(p, 'Name must be at least 1 character.', '#f44'); break; }
      // Check for duplicate names
      let nameTaken = false;
      for (const [id, n] of playerNames) {
        if (n.toLowerCase() === name.toLowerCase() && id !== p.id) { nameTaken = true; break; }
      }
      if (nameTaken) { sendChat(p, 'That name is already taken.', '#f44'); break; }
      playerNames.set(p.id, name);
      sendChat(p, `Name set to: ${name}`, '#22c55e');
      sendFriendsList(p);
      // Update friends lists of anyone who has us as friend
      for (const [, op] of players) {
        const opFriends = friendsData.get(op.id);
        if (opFriends && opFriends.has(p.id)) sendFriendsList(op);
      }
      // Send updated online list to all
      broadcast({ t: 'online_players', list: buildOnlineList() });
      saveFriends();
      // Restore saved position
      const savedPos = playerPositions.get(name);
      if (savedPos) {
        p.x = savedPos.x; p.y = savedPos.y; p.layer = savedPos.layer || 0;
        p.sentChunks = new Set();
        send(ws, { t: 'move_to', x: p.x, y: p.y, layer: p.layer });
        updatePlayerChunks(p);
      }
      // Restore saved appearance
      const savedApp = playerAppearances.get(name);
      if (savedApp) {
        p.appearance = savedApp;
        p.gender = savedApp.bodyType === 'B' ? 'female' : 'male';
        send(ws, { t: 'appearance', appearance: savedApp });
      } else {
        send(ws, { t: 'need_chargen' }); // No appearance = new player, show character creation
      }
      break;
    }
    case 'friend_add': {
      const targetName = (msg.name || '').trim();
      if (!targetName) break;
      // Find by name first, then by ID
      let target = getPlayerByName(targetName);
      if (!target && /^\d+$/.test(targetName)) target = getPlayerById(parseInt(targetName));
      // Allow adding by name even if offline (check playerNames)
      let targetId = null;
      if (target) {
        targetId = target.id;
      } else {
        // Search playerNames for offline match
        for (const [id, name] of playerNames) {
          if (name.toLowerCase() === targetName.toLowerCase()) { targetId = id; break; }
        }
      }
      if (targetId === null) { sendChat(p, `Player "${targetName}" not found.`, '#f44'); break; }
      // if (targetId === p.id) { sendChat(p, "You can't add yourself.", '#f44'); break; }
      const myFriends = friendsData.get(p.id);
      if (myFriends.has(targetId)) { sendChat(p, `Already on your friends list.`, '#f44'); break; }
      myFriends.add(targetId);
      const friendName = playerNames.get(targetId) || `Player ${targetId}`;
      sendChat(p, `Added ${friendName} to friends list.`, '#22c55e');
      sendFriendsList(p);
      saveFriends();
      break;
    }
    case 'friend_remove': {
      const rid = msg.id;
      const myFriends = friendsData.get(p.id);
      if (!myFriends || !myFriends.has(rid)) break;
      myFriends.delete(rid);
      const removedName = playerNames.get(rid) || `Player ${rid}`;
      sendChat(p, `Removed ${removedName} from friends list.`, '#ff981f');
      sendFriendsList(p);
      saveFriends();
      break;
    }
    case 'pm': {
      const targetId = msg.to;
      const text = (msg.msg || '').trim().slice(0, 200);
      if (!text) break;
      const myName = playerNames.get(p.id) || `Player ${p.id}`;
      const targetName = playerNames.get(targetId) || `Player ${targetId}`;

      // If PMing the AI bot, forward to Discord
      if (targetId === BOT_PLAYER_ID) {
        if (!discordConnected) { sendChat(p, 'AI is not online.', '#f44'); break; }
        postToDiscord(`**[PM from ${myName}]:** ${text}`);
        lastPmToBot = p.id;
        send(p.ws, { t: 'pm_sent', to: targetId, toName: 'AI', msg: text });
        break;
      }

      const target = getPlayerById(targetId);
      if (!target) { sendChat(p, `${targetName} is not online.`, '#f44'); break; }
      send(target.ws, { t: 'pm', from: p.id, fromName: myName, msg: text });
      send(p.ws, { t: 'pm_sent', to: targetId, toName: targetName, msg: text });
      break;
    }
    case 'move': {
      const tx = Math.floor(msg.x), ty = Math.floor(msg.y);
      if (Math.abs(tx - p.x) + Math.abs(ty - p.y) > 200) { sendChat(p, 'Too far!', '#f44'); return; }
      p.gathering = null; p.clickedNpc = null;
      if (p.combatTarget !== null) {
        cancelScheduled(`patk:${p.id}`);
        p.combatTarget = null; // clicking to move always disengages
      }
      if (isWalkable(tx, ty, p.layer)) { p.path = findPath(p.x, p.y, tx, ty, p.layer); }
      else { sendChat(p, "I can't reach that.", '#f44'); }
      break;
    }
    case 'gather': {
      const tx = Math.floor(msg.x), ty = Math.floor(msg.y);
      if (Math.abs(tx - p.x) + Math.abs(ty - p.y) > 200) return;
      const tile = tileAt(tx, ty, p.layer);
      const typeMap = { [T.TREE]: 'woodcutting', [T.ROCK]: 'mining', [T.FISH_SPOT]: 'fishing' };
      if (!typeMap[tile]) return;
      p.gathering = null; p.clickedNpc = null; p.combatTarget = null;
      let adj;
      if (tile === T.TREE || tile === T.ROCK) {
        const cl = findCluster(tx, ty, p.layer);
        adj = walkToClusterBase(cl.x, cl.y, cl.w, cl.h, p.x, p.y, p.layer);
        p.gatherCluster = cl;
      } else {
        adj = walkAdjacentTo(tx, ty, p.x, p.y, p.layer);
        p.gatherCluster = null;
      }
      if (adj) {
        p.path = findPath(p.x, p.y, adj[0], adj[1], p.layer);
        p.gathering = { type: typeMap[tile], tx, ty, tile };
        p.actionTick = 0;
      }
      break;
    }
    case 'gender': { p.gender = msg.v === 'female' ? 'female' : 'male'; break; }
    case 'set_appearance': {
      const a = msg.appearance;
      if (!a || typeof a !== 'object') break;
      const app = { ...DEFAULT_APPEARANCE };
      app.bodyType = a.bodyType === 'B' ? 'B' : 'A';
      app.head = Math.max(0, Math.min(8, parseInt(a.head) || 0));
      app.jaw = Math.max(0, Math.min(7, parseInt(a.jaw) || 0));
      app.torso = Math.max(0, Math.min(19, parseInt(a.torso) || 0));
      app.arms = Math.max(0, Math.min(16, parseInt(a.arms) || 0));
      app.hands = Math.max(0, Math.min(1, parseInt(a.hands) || 0));
      app.legs = Math.max(0, Math.min(21, parseInt(a.legs) || 0));
      app.feet = Math.max(0, Math.min(1, parseInt(a.feet) || 0));
      // Validate colors are hex strings
      const hexRe = /^#[0-9a-fA-F]{6}$/;
      if (hexRe.test(a.hairColor)) app.hairColor = a.hairColor;
      if (hexRe.test(a.torsoColor)) app.torsoColor = a.torsoColor;
      if (hexRe.test(a.legsColor)) app.legsColor = a.legsColor;
      if (hexRe.test(a.feetColor)) app.feetColor = a.feetColor;
      if (hexRe.test(a.skinColor)) app.skinColor = a.skinColor;
      p.appearance = app;
      p.gender = app.bodyType === 'B' ? 'female' : 'male';
      const name = playerNames.get(p.id);
      if (name) { playerAppearances.set(name, app); saveAppearances(); }
      sendChat(p, 'Appearance updated!', '#22c55e');
      break;
    }
    case 'door': {
      const dx = Math.floor(msg.x), dy = Math.floor(msg.y);
      if (Math.abs(p.x - dx) > 1 || Math.abs(p.y - dy) > 1) {
        sendChat(p, 'You need to be next to the door.', '#f44'); return;
      }
      const dk = `${dx},${dy}`;
      const tile = tileAt(dx, dy, p.layer);
      if (tile === T.DOOR) {
        let sx = dx, sy = dy;
        for (const [ndx, ndy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
          if (tileAt(dx + ndx, dy + ndy, p.layer) === T.FLOOR) { sx = dx + ndx; sy = dy + ndy; break; }
        }
        openDoors.set(dk, { ox: dx, oy: dy, sx, sy });
        setTile(dx, dy, T.FLOOR, p.layer);
        broadcastTiles([{ x: dx, y: dy, tile: T.FLOOR }], p.layer);
        sendChat(p, 'You open the door.', '#ccc');
      } else {
        for (const [key, d] of openDoors) {
          if ((dx === d.ox && dy === d.oy) || (dx === d.sx && dy === d.sy)) {
            if (Math.abs(p.x - d.ox) > 1 || Math.abs(p.y - d.oy) > 1) {
              sendChat(p, 'You need to be next to the door.', '#f44'); return;
            }
            openDoors.delete(key);
            setTile(d.ox, d.oy, T.DOOR, p.layer);
            broadcastTiles([{ x: d.ox, y: d.oy, tile: T.DOOR }], p.layer);
            sendChat(p, 'You close the door.', '#ccc');
            break;
          }
        }
      }
      break;
    }
    case 'pickup': {
      const gid = Math.floor(msg.id);
      const idx = groundItems.findIndex(g => g.id === gid);
      if (idx === -1) return;
      const gi = groundItems[idx];
      p.gathering = null; p.clickedNpc = null; p.combatTarget = null;
      if (p.x === gi.x && p.y === gi.y) {
        if (addItem(p, gi.name)) {
          groundItems.splice(idx, 1);
          sendStats(p); sendChat(p, `You pick up: ${gi.name}`, '#ff0');
        }
      } else {
        p.path = findPath(p.x, p.y, gi.x, gi.y, p.layer);
        p.pendingPickup = gid;
      }
      break;
    }
    case 'autoRetaliate': {
      p.autoRetaliate = !p.autoRetaliate;
      sendChat(p, `Auto Retaliate: ${p.autoRetaliate ? 'ON' : 'OFF'}`, '#ff0');
      break;
    }
    case 'toggle_prayer': {
      const style = msg.v;
      if (!['melee', 'ranged', 'magic'].includes(style)) break;
      // Toggle off if already active, otherwise switch
      p.activePrayer = p.activePrayer === style ? null : style;
      if (p.activePrayer) sendChat(p, `Protect from ${style} activated.`, '#ff0');
      else sendChat(p, 'Prayer deactivated.', '#ff0');
      send(p.ws, { t: 'prayer', active: p.activePrayer });
      break;
    }
    // case 'set_tier': TODO — wire up when gear system exists
    case 'skip_tutorial': {
      if (!p.tutorialComplete) completeTutorial(p);
      break;
    }
    case 'talk': {
      const npcId = Math.floor(msg.id);
      if (npcId < 0 || npcId >= npcs.length || npcs[npcId].dead) break;
      const npc = npcs[npcId];

      // Also handle tutorial progression if applicable
      if (npc.tutorialNpc && !p.tutorialComplete) {
        handleTutorialTalk(p, npc);
      }

      // AI NPC talk — forward to Discord for AI response
      const chatName = playerNames.get(p.id) || `Player ${p.id}`;
      const npcDesc = `${npc.name} (Level ${npc.combatLevel || 0}, near ${Math.floor(npc.x)},${Math.floor(npc.y)})`;
      const playerMsg = (msg.msg || 'Hello').trim().slice(0, 200);
      pendingNpcTalk = { playerId: p.id, npcName: npc.name };
      postToDiscord(`**[NPC: ${npcDesc}]** ${chatName} says: "${playerMsg}"\n_Respond in character as ${npc.name}. Keep it short (1-2 sentences). Stay in OSRS lore._`);
      sendChat(p, `You talk to ${npc.name}...`, '#0ff');
      break;
    }
    case 'attack': {
      const npcId = Math.floor(msg.id);
      if (npcId < 0 || npcId >= npcs.length || npcs[npcId].dead) return;
      const npc = npcs[npcId];

      // Tutorial NPC — handle as talk instead of combat
      if (npc.tutorialNpc) {
        // Walk to NPC first if not adjacent
        if (!isCardinalAdjacent(p.x, p.y, npc.x, npc.y)) {
          const adj = walkAdjacentTo(npc.x, npc.y, p.x, p.y, p.layer);
          if (adj) {
            p.path = findPath(p.x, p.y, adj[0], adj[1], p.layer);
            p.pendingTalk = npcId;
          }
        } else {
          handleTutorialTalk(p, npc);
        }
        break;
      }

      p.gathering = null;
      if (p.combatTarget !== null) cancelScheduled(`patk:${p.id}`);
      p.combatTarget = null;
      const combat = getCombatStyle(p);
      if (isInAttackRange(p.x, p.y, npc.x, npc.y, combat.range)) {
        // Already in range — attack immediately
        p.clickedNpc = npcId;
      } else if (combat.range <= 1) {
        // Melee — walk adjacent
        const adj = walkAdjacentTo(npc.x, npc.y, p.x, p.y, p.layer);
        if (adj) { p.path = findPath(p.x, p.y, adj[0], adj[1], p.layer); p.clickedNpc = npcId; }
      } else {
        // Ranged/magic — walk until in range (just walk toward, combat tick will handle range check)
        const adj = walkAdjacentTo(npc.x, npc.y, p.x, p.y, p.layer);
        if (adj) { p.path = findPath(p.x, p.y, adj[0], adj[1], p.layer); }
        p.clickedNpc = npcId;
      }
      break;
    }
    case 'half_paint': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) break;
      // Broadcast to players on same layer
      for (const [ws2, op] of players) {
        if (op.layer === p.layer) send(ws2, { t: 'half_paint', x, y, side: msg.side, tile: msg.tile, color: msg.color });
      }
      break;
    }
    case 'door_toggle': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const side = Math.floor(msg.side) & 0xF;
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) break;
      // Toggle open state on server — open doors don't block
      const key = `${p.layer}_${x}_${y}`;
      const curOpen = serverOpenDoors.get(key) || 0;
      const newOpen = curOpen ^ side;
      if (newOpen === 0) serverOpenDoors.delete(key);
      else serverOpenDoors.set(key, newOpen);
      // Broadcast to players on same layer
      for (const [ws2, op] of players) {
        if (op.layer === p.layer) send(ws2, { t: 'door_toggle', x, y, side, open: !!(newOpen & side) });
      }
      break;
    }
    case 'door_edge': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const mask = Math.floor(msg.mask) & 0xF;
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) break;
      if (mask === 0) serverDoorEdges.delete(`${p.layer}_${x}_${y}`);
      else serverDoorEdges.set(`${p.layer}_${x}_${y}`, mask);
      for (const [ws2, op] of players) {
        if (op.layer === p.layer) send(ws2, { t: 'door_edge', x, y, mask });
      }
      break;
    }
    case 'set_height': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const h = parseFloat(msg.h) || 0;
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) break;
      const key = `${p.layer}_${x}_${y}`;
      if (h === 0) serverTileHeights.delete(key);
      else serverTileHeights.set(key, h);
      for (const [ws2] of players) send(ws2, { t: 'set_height', x, y, h, layer: p.layer });
      break;
    }
    case 'wall_edge': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const mask = Math.floor(msg.mask) & 0x3F;
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) break;
      if (mask === 0) { serverWallEdges.delete(`${p.layer}_${x}_${y}`); serverWallTexMap.delete(`${p.layer}_${x}_${y}`); }
      else serverWallEdges.set(`${p.layer}_${x}_${y}`, mask);
      for (const [ws2, op] of players) {
        if (op.layer === p.layer) send(ws2, { t: 'wall_edge', x, y, mask });
      }
      break;
    }
    case 'wall_tex': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const tex = String(msg.tex || '6_0');
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) break;
      serverWallTexMap.set(`${p.layer}_${x}_${y}`, tex);
      for (const [ws2, op] of players) {
        if (op.layer === p.layer) send(ws2, { t: 'wall_tex', x, y, tex });
      }
      break;
    }
    case 'place_roof': {
      const roof = msg.roof;
      if (!roof) break;
      roof.id = serverNextRoofId++;
      roof.layer = p.layer;
      const key = `${roof.layer}_${roof.id}`;
      serverRoofs.set(key, roof);
      for (const [ws2] of players) send(ws2, { t: 'place_roof', roof });
      break;
    }
    case 'update_roof': {
      const roof = msg.roof;
      if (!roof) break;
      const key = `${roof.layer}_${roof.id}`;
      if (!serverRoofs.has(key)) break;
      serverRoofs.set(key, roof);
      for (const [ws2] of players) send(ws2, { t: 'update_roof', roof });
      break;
    }
    case 'delete_roof': {
      const key = `${msg.layer}_${msg.id}`;
      serverRoofs.delete(key);
      for (const [ws2] of players) send(ws2, { t: 'delete_roof', layer: msg.layer, id: msg.id });
      break;
    }
    case 'paint': {
      const changes = [];
      if (!Array.isArray(msg.tiles) || msg.tiles.length > 500) return;
      for (const t of msg.tiles) {
        const x = Math.floor(t.x), y = Math.floor(t.y);
        if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) continue;
        const tile = Math.floor(t.tile);
        if (tile < 0 || tile > T.CUSTOM) continue;
        const variant = Math.floor(t.variant || 0);
        setTile(x, y, tile, p.layer);
        if (tile === T.CUSTOM && t.color) setColor(x, y, String(t.color).slice(0, 7), p.layer);
        else setColor(x, y, null, p.layer);
        // Store variant
        const vKey = `${p.layer}_${x}_${y}`;
        if (!global.tileVariantMap) global.tileVariantMap = new Map();
        if (variant > 0) global.tileVariantMap.set(vKey, variant);
        else global.tileVariantMap.delete(vKey);
        changes.push({ x, y, tile, color: t.color || null, variant });
      }
      if (changes.length > 0) broadcastTiles(changes, p.layer);
      break;
    }
    case 'bucket': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const tile = Math.floor(msg.tile);
      const variant = Math.floor(msg.variant || 0);
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) return;
      if (tile < 0 || tile > T.CUSTOM) return;
      const changes = bucketFill(x, y, tile, msg.color || null, p.layer);
      if (changes.length > 0) {
        for (const c of changes) {
          const vKey = `${p.layer}_${c.x}_${c.y}`;
          c.prevVariant = global.tileVariantMap.get(vKey) || 0;
          if (variant > 0) global.tileVariantMap.set(vKey, variant);
          else global.tileVariantMap.delete(vKey);
        }
        broadcastTiles(changes.map(c => ({ x: c.x, y: c.y, tile: c.tile, color: c.color, variant })), p.layer);
        send(ws, { t: 'bucket_undo', changes: changes.map(c => ({ x: c.x, y: c.y, tile: c.prevTile, color: c.prevColor, variant: c.prevVariant })) });
      }
      break;
    }
    case 'bucket_all': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const tile = Math.floor(msg.tile);
      const variant = Math.floor(msg.variant || 0);
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) return;
      if (tile < 0 || tile > T.CUSTOM) return;
      const changes = bucketAllRecolor(x, y, tile, msg.color || null, p.layer);
      if (changes.length > 0) {
        for (const c of changes) {
          const vKey = `${p.layer}_${c.x}_${c.y}`;
          c.prevVariant = global.tileVariantMap.get(vKey) || 0;
          if (variant > 0) global.tileVariantMap.set(vKey, variant);
          else global.tileVariantMap.delete(vKey);
        }
        broadcastTiles(changes.map(c => ({ x: c.x, y: c.y, tile: c.tile, color: c.color, variant })), p.layer);
        send(ws, { t: 'bucket_undo', changes: changes.map(c => ({ x: c.x, y: c.y, tile: c.prevTile, color: c.prevColor, variant: c.prevVariant })) });
        sendChat(p, `Recolored ${changes.length} tiles globally.`, '#ff981f');
      }
      break;
    }
    case 'bucket_new': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const tile = Math.floor(msg.tile);
      const variant = Math.floor(msg.variant || 0);
      const name = String(msg.name || '').slice(0, 30);
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) return;
      if (tile < 0 || tile > T.CUSTOM || !name) return;
      const newNameKey = tile === T.CUSTOM && msg.color ? 'c:' + msg.color : 't:' + tile;
      customNames.set(newNameKey, name);
      const changes = bucketAllRecolor(x, y, tile, msg.color || null, p.layer);
      if (changes.length > 0) {
        for (const c of changes) {
          const vKey = `${p.layer}_${c.x}_${c.y}`;
          c.prevVariant = global.tileVariantMap.get(vKey) || 0;
          if (variant > 0) global.tileVariantMap.set(vKey, variant);
          else global.tileVariantMap.delete(vKey);
        }
        broadcastTiles(changes.map(c => ({ x: c.x, y: c.y, tile: c.tile, color: c.color, variant })), p.layer);
        send(ws, { t: 'bucket_undo', changes: changes.map(c => ({ x: c.x, y: c.y, tile: c.prevTile, color: c.prevColor, variant: c.prevVariant })) });
      }
      const namesObj = {}; for (const [k, v] of customNames) namesObj[k] = v;
      broadcast({ t: 'names', names: namesObj });
      sendChat(p, `Renamed ${changes.length} tiles to "${name}".`, '#ff981f');
      break;
    }
    case 'set_layer': {
      const layer = Math.floor(msg.layer);
      if (layer < -1000 || layer > 1000 || isNaN(layer)) break;
      p.layer = layer;
      p.sentChunks = new Set();
      updatePlayerChunks(p);
      // Client already has all edges, no need to resend on layer change
      sendChat(p, `Layer: ${layer}`, '#ff981f');
      break;
    }
  }
}

// ── HTTP Server ────────────────────────────────────────────────────────────────
const clientPath = path.join(__dirname, 'client.html');
const mapPath = path.join(__dirname, 'map.html');
const launcherPath = path.join(__dirname, 'launcher.html');
const server = http.createServer((req, res) => {
  // Serve static lib files (Three.js etc.)
  if (req.url.startsWith('/lib/')) {
    const libFile = path.join(__dirname, req.url);
    if (fs.existsSync(libFile)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=86400' });
      res.end(fs.readFileSync(libFile));
      return;
    }
    res.writeHead(404); res.end('Not found'); return;
  }

  // Serve model files from /models/
  if (req.url.startsWith('/models/')) {
    const modelFile = path.join(__dirname, req.url);
    if (fs.existsSync(modelFile)) {
      const ext = path.extname(modelFile).toLowerCase();
      const mimeTypes = { '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg' };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
      res.end(fs.readFileSync(modelFile));
      return;
    }
    res.writeHead(404); res.end('Not found'); return;
  }
  // API: auto-login with name parameter
  if (req.url.startsWith('/play?')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const name = params.get('name');
    let html = fs.readFileSync(clientPath, 'utf8');
    if (name) {
      // Inject auto-login script
      html = html.replace('</body>', `<script>window.autoLoginName = "${name.replace(/"/g, '')}";</script></body>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
    res.end(html);
    return;
  }
  let file;
  if (req.url === '/play') file = clientPath;
  else if (req.url === '/map') file = mapPath;
  else file = launcherPath;
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
  res.end(fs.readFileSync(file, 'utf8'));
});

// ── WebSocket Server ───────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const p = createPlayer(ws);
  players.set(ws, p);
  console.log(`[join] Player ${p.id} at (${p.x}, ${p.y}) (${players.size} online)`);

  const namesObj = {}; for (const [k, v] of customNames) namesObj[k] = v;
  const pName = playerNames.get(p.id) || `Player ${p.id}`;
  send(ws, { t: 'welcome', id: p.id, x: p.x, y: p.y, layer: p.layer, customNames: namesObj, chunkSize: CHUNK_SIZE, name: pName });
  updatePlayerChunks(p);
  // Send all wall/door data to client
  const allWalls = {}; for (const [k, v] of serverWallEdges) allWalls[k] = v;
  const allDoors = {}; for (const [k, v] of serverDoorEdges) allDoors[k] = v;
  const allHeights = {}; for (const [k, v] of serverTileHeights) allHeights[k] = v;
  const allRoofs = {}; for (const [k, v] of serverRoofs) allRoofs[k] = v;
  const allWallTex = {}; for (const [k, v] of serverWallTexMap) allWallTex[k] = v;
  send(ws, { t: 'all_edges', walls: allWalls, doors: allDoors, heights: allHeights, roofs: allRoofs, wallTextures: allWallTex });
  sendStats(p);
  sendFriendsList(p);
  sendChat(p, `Welcome to OpenScape! ${players.size} player(s) online.`, '#ff981f');
  broadcast({ t: 'chat', msg: `${pName} has joined.`, color: '#0ff' });
  notifyFriendsOfStatus(p.id, true);

  // Broadcast online players list to all (including new player)
  broadcast({ t: 'online_players', list: buildOnlineList() });

  ws.on('message', (data) => handleMessage(ws, data.toString()));
  ws.on('close', () => {
    players.delete(ws);
    const leaveName = playerNames.get(p.id) || `Player ${p.id}`;
    broadcast({ t: 'chat', msg: `${leaveName} has left.`, color: '#888' });
    notifyFriendsOfStatus(p.id, false);
    // Update online list for remaining players
    broadcast({ t: 'online_players', list: buildOnlineList() });
    // Save position on disconnect
    const name = playerNames.get(p.id);
    if (name) {
      playerPositions.set(name, { x: p.x, y: p.y, layer: p.layer });
      if (p.appearance) playerAppearances.set(name, p.appearance);
    }
    savePositions();
    saveAppearances();
    console.log(`[leave] Player ${p.id} disconnected (${players.size} online)`);
  });
});

// ── Init ───────────────────────────────────────────────────────────────────────
fs.mkdirSync(CHUNKS_DIR, { recursive: true });
if (fs.existsSync(NAMES_FILE)) {
  const obj = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8'));
  for (const [k, v] of Object.entries(obj)) customNames.set(k, v);
  console.log(`[load] ${customNames.size} custom names`);
}
loadDefinitions();
loadFriends();
loadWalls();
loadVariants();
loadPositions();
loadAppearances();
initBotPlayer();

// Create a small grass island at spawn so the player can stand
for (let dx = -3; dx <= 3; dx++) {
  for (let dy = -3; dy <= 3; dy++) {
    setTile(SPAWN_X + dx, SPAWN_Y + dy, T.GRASS);
  }
}

setInterval(gameTick, TICK_MS);
setInterval(saveAllChunks, SAVE_INTERVAL_MS);
setInterval(saveFriends, SAVE_INTERVAL_MS);
setInterval(saveWalls, SAVE_INTERVAL_MS);
setInterval(saveVariants, SAVE_INTERVAL_MS);
process.on('SIGINT', () => { saveAllChunks(); saveFriends(); saveWalls(); saveVariants(); savePositions(); saveAppearances(); process.exit(); });
process.on('SIGTERM', () => { saveAllChunks(); saveFriends(); saveWalls(); saveVariants(); savePositions(); saveAppearances(); process.exit(); });

server.listen(PORT, () => {
  console.log(`[server] OpenScape running on http://localhost:${PORT}`);
  console.log(`[server] Chunk-based world (${CHUNK_SIZE}x${CHUNK_SIZE} chunks, view=${VIEW_DIST})`);
  console.log(`[server] Spawn: (${SPAWN_X}, ${SPAWN_Y})`);
  // Start Discord message polling
  startDiscordPolling();
});
