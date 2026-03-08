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

const CHUNK_SIZE = 64;
const VIEW_DIST = 3;
const ENTITY_VIEW = (VIEW_DIST + 1) * CHUNK_SIZE;
const SPAWN_X = 3222, SPAWN_Y = 3218;

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

function isOsrsBlocked(x, y) {
  const cx = Math.floor(x / 64), cy = Math.floor(y / 64);
  const key = `${cx}_${cy}`;
  if (!collisionCache.has(key)) {
    // Force load terrain to populate collision cache
    loadTerrainChunk(cx, cy);
  }
  const flags = collisionCache.get(key);
  if (!flags) return false; // No data = assume walkable
  const lx = ((x % 64) + 64) % 64, ly = ((y % 64) + 64) % 64;
  return (flags[ly * 64 + lx] & 1) === 1; // bit 0 = blocked
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

function loadChunkFromDisk(cx, cy) {
  const tp = path.join(CHUNKS_DIR, `${cx}_${cy}.bin`);
  if (!fs.existsSync(tp)) return null;
  const buf = fs.readFileSync(tp);
  const tiles = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  tiles.set(new Uint8Array(buf.buffer, buf.byteOffset, Math.min(buf.byteLength, tiles.length)));
  const colors = new Map();
  const cp = path.join(CHUNKS_DIR, `${cx}_${cy}.json`);
  if (fs.existsSync(cp)) {
    const obj = JSON.parse(fs.readFileSync(cp, 'utf8'));
    for (const [k, v] of Object.entries(obj)) colors.set(parseInt(k), v);
  }
  return { tiles, colors, dirty: false, lastAccess: Date.now() };
}

function saveChunkToDisk(cx, cy, chunk) {
  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(CHUNKS_DIR, `${cx}_${cy}.bin`), Buffer.from(chunk.tiles));
  const cp = path.join(CHUNKS_DIR, `${cx}_${cy}.json`);
  if (chunk.colors.size > 0) {
    const obj = {}; for (const [k, v] of chunk.colors) obj[k] = v;
    fs.writeFileSync(cp, JSON.stringify(obj));
  } else if (fs.existsSync(cp)) { fs.unlinkSync(cp); }
  chunk.dirty = false;
}

function getChunk(cx, cy) {
  const key = `${cx}_${cy}`;
  let chunk = chunks.get(key);
  if (chunk) return chunk;
  chunk = loadChunkFromDisk(cx, cy);
  if (!chunk) chunk = { tiles: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE), colors: new Map(), dirty: false, lastAccess: Date.now() };
  chunks.set(key, chunk);
  return chunk;
}

function tileAt(x, y) {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const key = `${cx}_${cy}`;
  let chunk = chunks.get(key);
  if (!chunk) {
    chunk = loadChunkFromDisk(cx, cy);
    if (!chunk) return T.GRASS;
    chunks.set(key, chunk);
  }
  const [lx, ly] = localXY(x, y);
  return chunk.tiles[ly * CHUNK_SIZE + lx];
}

function setTile(x, y, t) {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const chunk = getChunk(cx, cy);
  const [lx, ly] = localXY(x, y);
  chunk.tiles[ly * CHUNK_SIZE + lx] = t;
  chunk.dirty = true;
  chunk.lastAccess = Date.now();
}

function getColor(x, y) {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const chunk = chunks.get(`${cx}_${cy}`);
  if (!chunk) return null;
  const [lx, ly] = localXY(x, y);
  return chunk.colors.get(ly * CHUNK_SIZE + lx) || null;
}

function setColor(x, y, color) {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const chunk = getChunk(cx, cy);
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

function isWalkable(x, y) {
  const t = tileAt(x, y);
  if (t === T.WATER || t === T.TREE || t === T.ROCK || t === T.WALL || t === T.BUSH || t === T.DOOR) return false;
  if (isOsrsBlocked(x, y)) return false;
  return true;
}

function evictChunks() {
  const now = Date.now();
  const keep = new Set();
  for (const [, p] of players) {
    const cx = Math.floor(p.x / CHUNK_SIZE), cy = Math.floor(p.y / CHUNK_SIZE);
    for (let dx = -(VIEW_DIST + 1); dx <= VIEW_DIST + 1; dx++)
      for (let dy = -(VIEW_DIST + 1); dy <= VIEW_DIST + 1; dy++)
        keep.add(`${cx + dx}_${cy + dy}`);
  }
  for (const [key, chunk] of chunks) {
    if (keep.has(key)) continue;
    if (now - chunk.lastAccess > 60000) {
      if (chunk.dirty) {
        const [cx, cy] = key.split('_').map(Number);
        saveChunkToDisk(cx, cy, chunk);
      }
      chunks.delete(key);
    }
  }
}

function saveAllChunks() {
  let saved = 0;
  for (const [key, chunk] of chunks) {
    if (!chunk.dirty) continue;
    const [cx, cy] = key.split('_').map(Number);
    saveChunkToDisk(cx, cy, chunk);
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

// ── NPC Spawns (from OSRS data) ─────────────────────────────────────────────
function spawnNpcs() {
  try {
    const spawns = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'npc-spawns-osrs.json'), 'utf8'));
    // Only spawn NPCs near Lumbridge initially (expand later)
    const lumbridgeSpawns = spawns.filter(s =>
      s.x >= 3140 && s.x <= 3330 && s.y >= 3140 && s.y <= 3330
    );
    let spawned = 0;
    for (const s of lumbridgeSpawns) {
      const def = npcDefs.get(s.id);
      if (!def) continue;
      if (def.combatLevel < 0 && !def.actions.includes('Attack')) continue; // skip non-combat NPCs for now
      if (isOsrsBlocked(s.x, s.y)) continue; // don't spawn on blocked tiles
      // Get stats from cache def
      const stats = def.stats || [1,1,1,1,1,1]; // [atk, def, str, hp, range, mage]
      const hp = Math.max(1, stats[3]);
      npcs.push({
        id: npcs.length, defId: s.id, name: def.name,
        x: s.x, y: s.y, spawnX: s.x, spawnY: s.y,
        hp, maxHp: hp,
        attack: stats[0], strength: stats[2], defence: stats[1],
        ranged: stats[4], magic: stats[5],
        combatLevel: def.combatLevel,
        aggressive: def.name.includes('Goblin') || def.name.includes('rat') || def.name.includes('spider') || def.name.includes('Dark wizard'),
        dead: false, respawnTick: 0, wanderTick: Math.floor(Math.random() * 100),
        nextAttackTick: 0, attackSpeed: 4, // ticks between NPC attacks
        combatTarget: null, combatTimeout: 0, // NPC remembers who attacked it
        drops: getDropTable(def),
        color: '#8b1a1a',
      });
      spawned++;
    }
    console.log(`[npcs] Spawned ${spawned} NPCs near Lumbridge (from ${lumbridgeSpawns.length} spawn points)`);
  } catch (e) {
    console.log('[npcs] No npc-spawns-osrs.json found, no NPCs spawned');
  }
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
function findPath(sx, sy, tx, ty) {
  if (!isWalkable(tx, ty)) return [];
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
      if (!isWalkable(nx, ny) || closed.has(key(nx, ny))) continue;
      if (dx !== 0 && dy !== 0 && (!isWalkable(cur.x + dx, cur.y) || !isWalkable(cur.x, cur.y + dy))) continue;
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
function broadcastTiles(changes) {
  const byChunk = new Map();
  for (const c of changes) {
    const key = `${Math.floor(c.x / CHUNK_SIZE)}_${Math.floor(c.y / CHUNK_SIZE)}`;
    if (!byChunk.has(key)) byChunk.set(key, []);
    byChunk.get(key).push(c);
  }
  for (const [ws, p] of players) {
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
  // Include tutorial hint if on Tutorial Island
  let tutorialHint = null;
  if (!p.tutorialComplete && p.tutorialStep >= 0 && p.tutorialStep < tutorial.STEPS.length) {
    const step = tutorial.STEPS[p.tutorialStep];
    if (step.npc) tutorialHint = `Talk to ${step.npc}`;
    else if (step.message) tutorialHint = step.message;
  }
  send(p.ws, { t: 'stats', hp: p.hp, maxHp: p.maxHp, skills: p.skills, inv, equip, bonuses: calcEquipBonuses(p.equipment), tutorialHint });
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

function findCluster(tx, ty) {
  const t = tileAt(tx, ty);
  let x0 = tx, y0 = ty;
  while (tileAt(x0 - 1, y0) === t) x0--;
  while (tileAt(x0, y0 - 1) === t) y0--;
  let w = 0, h = 0;
  while (tileAt(x0 + w, y0) === t) w++;
  while (tileAt(x0, y0 + h) === t) h++;
  return { x: x0, y: y0, w, h };
}

function walkToClusterBase(cx, cy, cw, ch, px, py) {
  const candidates = [];
  for (let dx = 0; dx < cw; dx++) if (isWalkable(cx + dx, cy + ch)) candidates.push([cx + dx, cy + ch]);
  for (let dy = 0; dy < ch; dy++) {
    if (isWalkable(cx - 1, cy + dy)) candidates.push([cx - 1, cy + dy]);
    if (isWalkable(cx + cw, cy + dy)) candidates.push([cx + cw, cy + dy]);
  }
  for (let dx = 0; dx < cw; dx++) if (isWalkable(cx + dx, cy - 1)) candidates.push([cx + dx, cy - 1]);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (Math.abs(a[0] - px) + Math.abs(a[1] - py)) - (Math.abs(b[0] - px) + Math.abs(b[1] - py)));
  return candidates[0];
}

function walkAdjacentTo(tx, ty, px, py) {
  const adj = [[tx-1,ty],[tx+1,ty],[tx,ty-1],[tx,ty+1]].filter(([x,y]) => isWalkable(x,y));
  if (adj.length === 0) return null;
  adj.sort((a, b) => (Math.abs(a[0] - px) + Math.abs(a[1] - py)) - (Math.abs(b[0] - px) + Math.abs(b[1] - py)));
  return adj[0];
}

// ── Bucket Fill ──────────────────────────────────────────────────────────────
function bucketFill(sx, sy, newTile, newColor) {
  const oldTile = tileAt(sx, sy);
  const oldColor = oldTile === T.CUSTOM ? (getColor(sx, sy) || '#ff00ff') : null;
  if (oldTile === newTile && (newTile !== T.CUSTOM || oldColor === newColor)) return [];
  const changes = [], stack = [{ x: sx, y: sy }], visited = new Set();
  function matches(x, y) {
    if (Math.abs(x - sx) > 100 || Math.abs(y - sy) > 100) return false;
    if (tileAt(x, y) !== oldTile) return false;
    if (oldTile === T.CUSTOM) return (getColor(x, y) || '#ff00ff') === oldColor;
    return true;
  }
  while (stack.length > 0 && changes.length < 5000) {
    const { x, y } = stack.pop();
    const k = `${x},${y}`;
    if (visited.has(k) || !matches(x, y)) continue;
    visited.add(k);
    const prev = tileAt(x, y);
    const prevColor = prev === T.CUSTOM ? (getColor(x, y) || null) : null;
    setTile(x, y, newTile);
    if (newTile === T.CUSTOM && newColor) setColor(x, y, newColor);
    else setColor(x, y, null);
    changes.push({ x, y, tile: newTile, color: newColor || null, prevTile: prev, prevColor });
    stack.push({ x: x+1, y }, { x: x-1, y }, { x, y: y+1 }, { x, y: y-1 });
  }
  return changes;
}

function tileKey(x, y) {
  const t = tileAt(x, y);
  if (t === T.CUSTOM) return 'c:' + (getColor(x, y) || '#ff00ff');
  return 't:' + t;
}

function bucketAllRecolor(sx, sy, newTile, newColor) {
  const targetKey = tileKey(sx, sy);
  const changes = [];
  for (const [key, chunk] of chunks) {
    const [cx, cy] = key.split('_').map(Number);
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
function sendChunkToPlayer(ws, cx, cy) {
  const chunk = getChunk(cx, cy);
  const colorsObj = {};
  for (const [k, v] of chunk.colors) colorsObj[k] = v;
  const msg = { t: 'chunk', cx, cy, tiles: Buffer.from(chunk.tiles).toString('base64'), colors: colorsObj };
  // Attach OSRS terrain data if available
  const terrain = loadTerrainChunk(cx, cy);
  if (terrain) msg.terrain = Buffer.from(terrain).toString('base64');
  const heights = loadTerrainHeights(cx, cy);
  if (heights) msg.heights = Buffer.from(heights.buffer).toString('base64');
  send(ws, msg);
}

function updatePlayerChunks(p) {
  const pcx = Math.floor(p.x / CHUNK_SIZE), pcy = Math.floor(p.y / CHUNK_SIZE);
  for (let dx = -VIEW_DIST; dx <= VIEW_DIST; dx++) {
    for (let dy = -VIEW_DIST; dy <= VIEW_DIST; dy++) {
      const key = `${pcx + dx}_${pcy + dy}`;
      if (!p.sentChunks.has(key)) {
        sendChunkToPlayer(p.ws, pcx + dx, pcy + dy);
        p.sentChunks.add(key);
      }
    }
  }
  for (const key of p.sentChunks) {
    const [cx, cy] = key.split('_').map(Number);
    if (Math.abs(cx - pcx) > VIEW_DIST + 2 || Math.abs(cy - pcy) > VIEW_DIST + 2) {
      p.sentChunks.delete(key);
    }
  }
}

// ── Player Factory ─────────────────────────────────────────────────────────────
function createPlayer(ws) {
  // New players start on Tutorial Island
  const sx = tutorial.TUTORIAL_SPAWN.x;
  const sy = tutorial.TUTORIAL_SPAWN.y;
  const skills = {};
  for (const s of ALL_SKILLS) skills[s] = { xp: 0, level: 1 };
  skills.hitpoints = { xp: 1154, level: 10 };
  const equipment = {};
  for (const s of EQUIP_SLOTS) equipment[s] = -1;
  return {
    id: nextPlayerId++, ws, x: sx, y: sy, prevX: sx, prevY: sy, hp: 10, maxHp: 10,
    gender: 'male', sentChunks: new Set(),
    path: [], gathering: null, actionTick: 0,
    combatTarget: null, clickedNpc: null, pendingPickup: null, pendingTalk: null, gatherCluster: null,
    nextAttackTick: 0, attackSpeed: 4,
    autoRetaliate: true,
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

  let hitChance;
  if (attRoll > defRoll) hitChance = 1 - (defRoll + 2) / (2 * (attRoll + 1));
  else hitChance = attRoll / (2 * (defRoll + 1));

  // Calculate damage
  const hit = rng() < hitChance;
  const dmg = hit ? Math.floor(rng() * (maxHit + 1)) : 0;

  // Projectile delay for ranged/magic
  const projDelay = combat.style !== 'melee' ? getProjectileDelay(p.x, p.y, npc.x, npc.y) : 0;

  if (projDelay > 0) {
    // Schedule damage to apply after projectile travel
    const px = p.x, py = p.y, nx = npc.x, ny = npc.y;
    sendChat(p, `[${tick}] You cast at ${npc.name} (${combat.style}, delay=${projDelay}t) P:${px},${py} N:${nx},${ny}`, '#f44');
    schedule(tick + projDelay, 1, `proj:${p.id}:${tick}`, () => {
      if (npc.dead) return;
      if (dmg > 0) {
        npc.hp -= dmg;
        sendChat(p, `[${tick}] You hit ${npc.name} for ${dmg} (P:${px},${py} N:${npc.x},${npc.y})`, '#f44');
      } else {
        sendChat(p, `[${tick}] You miss ${npc.name} (P:${px},${py} N:${npc.x},${npc.y})`, '#f44');
      }
      applyKillCheck(p, npc);
      giveXp(p, combat.style, dmg);
    });
  } else {
    // Melee: instant damage
    if (dmg > 0) {
      npc.hp -= dmg;
      sendChat(p, `[${tick}] You hit ${npc.name} for ${dmg} (P:${p.x},${p.y} N:${npc.x},${npc.y})`, '#f44');
    } else {
      sendChat(p, `[${tick}] You miss ${npc.name} (P:${p.x},${p.y} N:${npc.x},${npc.y})`, '#f44');
    }
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
  // Execute NPC attack
  const bonuses = calcEquipBonuses(combatant.equipment);
  const npcAttRoll = ((npc.attack || 1) + 9) * 64;
  const pDefRoll = (combatant.skills.defence.level + 1 + 8) * (bonuses.dslash + 64);
  let npcHitChance;
  if (npcAttRoll > pDefRoll) npcHitChance = 1 - (pDefRoll + 2) / (2 * (npcAttRoll + 1));
  else npcHitChance = npcAttRoll / (2 * (pDefRoll + 1));
  if (rng() < npcHitChance) {
    const npcMaxHit = Math.max(1, Math.floor(0.5 + ((npc.strength || npc.attack || 1) + 9) * 64 / 640));
    const dmg = Math.floor(rng() * (npcMaxHit + 1));
    if (dmg > 0) {
      combatant.hp -= dmg;
      sendChat(combatant, `[${tick}] ${npc.name} hits you for ${dmg} (P:${combatant.x},${combatant.y} N:${npc.x},${npc.y})`, '#f44');
      addXp(combatant, 'defence', Math.floor(dmg * 1.33));
      if (combatant.hp <= 0) killPlayer(combatant);
    } else {
      sendChat(combatant, `[${tick}] ${npc.name} hits you for 0 (P:${combatant.x},${combatant.y} N:${npc.x},${npc.y})`, '#f44');
    }
  } else {
    sendChat(combatant, `[${tick}] ${npc.name} misses (P:${combatant.x},${combatant.y} N:${npc.x},${npc.y})`, '#f44');
  }
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
      if (adjacent && tileAt(g.tx, g.ty) === g.tile) {
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
                  setTile(cl2.x + dx, cl2.y + dy, T.GRASS);
                  changes.push({ x: cl2.x + dx, y: cl2.y + dy, tile: T.GRASS });
                  respawns.push({ x: cl2.x + dx, y: cl2.y + dy, tile: T.TREE, tick: tick + 25 });
                }
              broadcastTiles(changes);
              p.gathering = null; p.gatherCluster = null;
            }
          } else if (g.type === 'mining') {
            const mineChance = Math.min(0.9, 0.25 + p.skills.mining.level * 0.005);
            if (rng() >= mineChance) { sendChat(p, 'You swing at the rock...', '#ccc'); }
            else if (addItem(p, 'Ore')) {
              addXp(p, 'mining', 30);
              sendChat(p, 'You mine some ore.', '#ff0');
              setTile(g.tx, g.ty, T.GRASS);
              broadcastTiles([{ x: g.tx, y: g.ty, tile: T.GRASS }]);
              respawns.push({ x: g.tx, y: g.ty, tile: T.ROCK, tick: tick + 33 });
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
          const adj = walkAdjacentTo(npc.x, npc.y, p.x, p.y);
          if (adj) { p.path = findPath(p.x, p.y, adj[0], adj[1]); }
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
        const adj = walkAdjacentTo(npc.x, npc.y, p.x, p.y);
        if (adj) p.path = findPath(p.x, p.y, adj[0], adj[1]);
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
      setTile(r.x, r.y, r.tile);
      broadcastTiles([{ x: r.x, y: r.y, tile: r.tile }]);
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
          pArr.push({ id: op.id, x: op.x, y: op.y, hp: op.hp, maxHp: op.maxHp, g: op.gender, path: op.path.slice(0, 20) });
        }
      }
      const nArr = npcs.filter(n => !n.dead && Math.abs(n.x - p.x) <= ENTITY_VIEW && Math.abs(n.y - p.y) <= ENTITY_VIEW)
        .map(n => ({ id: n.id, x: n.x, y: n.y, hp: n.hp, maxHp: n.maxHp, name: n.name, color: n.color, atk: n.attack || 1, def: n.defence || 1, talk: n.tutorialNpc || false }));
      const gArr = groundItems.filter(g => Math.abs(g.x - p.x) <= ENTITY_VIEW && Math.abs(g.y - p.y) <= ENTITY_VIEW)
        .map(g => ({ id: g.id, name: g.name, x: g.x, y: g.y }));
      const dArr = [...openDoors.values()].filter(d => Math.abs(d.ox - p.x) <= ENTITY_VIEW && Math.abs(d.oy - p.y) <= ENTITY_VIEW);
      send(ws, { t: 'state', players: pArr, npcs: nArr, items: gArr, doors: dArr, tick });
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
        if (isWalkable(SPAWN_X + dx, SPAWN_Y + dy)) { p.x = SPAWN_X + dx; p.y = SPAWN_Y + dy; r = 999; dx = 999; break; }
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
      if (text) broadcast({ t: 'chat', msg: `Player ${p.id}: ${text}`, color: '#0000aa' });
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
      if (isWalkable(tx, ty)) { p.path = findPath(p.x, p.y, tx, ty); }
      else { sendChat(p, "I can't reach that.", '#f44'); }
      break;
    }
    case 'gather': {
      const tx = Math.floor(msg.x), ty = Math.floor(msg.y);
      if (Math.abs(tx - p.x) + Math.abs(ty - p.y) > 200) return;
      const tile = tileAt(tx, ty);
      const typeMap = { [T.TREE]: 'woodcutting', [T.ROCK]: 'mining', [T.FISH_SPOT]: 'fishing' };
      if (!typeMap[tile]) return;
      p.gathering = null; p.clickedNpc = null; p.combatTarget = null;
      let adj;
      if (tile === T.TREE || tile === T.ROCK) {
        const cl = findCluster(tx, ty);
        adj = walkToClusterBase(cl.x, cl.y, cl.w, cl.h, p.x, p.y);
        p.gatherCluster = cl;
      } else {
        adj = walkAdjacentTo(tx, ty, p.x, p.y);
        p.gatherCluster = null;
      }
      if (adj) {
        p.path = findPath(p.x, p.y, adj[0], adj[1]);
        p.gathering = { type: typeMap[tile], tx, ty, tile };
        p.actionTick = 0;
      }
      break;
    }
    case 'gender': { p.gender = msg.v === 'female' ? 'female' : 'male'; break; }
    case 'door': {
      const dx = Math.floor(msg.x), dy = Math.floor(msg.y);
      if (Math.abs(p.x - dx) > 1 || Math.abs(p.y - dy) > 1) {
        sendChat(p, 'You need to be next to the door.', '#f44'); return;
      }
      const dk = `${dx},${dy}`;
      const tile = tileAt(dx, dy);
      if (tile === T.DOOR) {
        let sx = dx, sy = dy;
        for (const [ndx, ndy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
          if (tileAt(dx + ndx, dy + ndy) === T.FLOOR) { sx = dx + ndx; sy = dy + ndy; break; }
        }
        openDoors.set(dk, { ox: dx, oy: dy, sx, sy });
        setTile(dx, dy, T.FLOOR);
        broadcastTiles([{ x: dx, y: dy, tile: T.FLOOR }]);
        sendChat(p, 'You open the door.', '#ccc');
      } else {
        for (const [key, d] of openDoors) {
          if ((dx === d.ox && dy === d.oy) || (dx === d.sx && dy === d.sy)) {
            if (Math.abs(p.x - d.ox) > 1 || Math.abs(p.y - d.oy) > 1) {
              sendChat(p, 'You need to be next to the door.', '#f44'); return;
            }
            openDoors.delete(key);
            setTile(d.ox, d.oy, T.DOOR);
            broadcastTiles([{ x: d.ox, y: d.oy, tile: T.DOOR }]);
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
        p.path = findPath(p.x, p.y, gi.x, gi.y);
        p.pendingPickup = gid;
      }
      break;
    }
    case 'autoRetaliate': {
      p.autoRetaliate = !p.autoRetaliate;
      sendChat(p, `Auto Retaliate: ${p.autoRetaliate ? 'ON' : 'OFF'}`, '#ff0');
      break;
    }
    case 'talk': // fall through — talk is same as clicking an NPC
    case 'attack': {
      const npcId = Math.floor(msg.id);
      if (npcId < 0 || npcId >= npcs.length || npcs[npcId].dead) return;
      const npc = npcs[npcId];

      // Tutorial NPC — handle as talk instead of combat
      if (npc.tutorialNpc) {
        // Walk to NPC first if not adjacent
        if (!isCardinalAdjacent(p.x, p.y, npc.x, npc.y)) {
          const adj = walkAdjacentTo(npc.x, npc.y, p.x, p.y);
          if (adj) {
            p.path = findPath(p.x, p.y, adj[0], adj[1]);
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
        const adj = walkAdjacentTo(npc.x, npc.y, p.x, p.y);
        if (adj) { p.path = findPath(p.x, p.y, adj[0], adj[1]); p.clickedNpc = npcId; }
      } else {
        // Ranged/magic — walk until in range (just walk toward, combat tick will handle range check)
        const adj = walkAdjacentTo(npc.x, npc.y, p.x, p.y);
        if (adj) { p.path = findPath(p.x, p.y, adj[0], adj[1]); }
        p.clickedNpc = npcId;
      }
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
        setTile(x, y, tile);
        if (tile === T.CUSTOM && t.color) setColor(x, y, String(t.color).slice(0, 7));
        else setColor(x, y, null);
        changes.push({ x, y, tile, color: t.color || null });
      }
      if (changes.length > 0) broadcastTiles(changes);
      break;
    }
    case 'bucket': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const tile = Math.floor(msg.tile);
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) return;
      if (tile < 0 || tile > T.CUSTOM) return;
      const changes = bucketFill(x, y, tile, msg.color || null);
      if (changes.length > 0) {
        broadcastTiles(changes.map(c => ({ x: c.x, y: c.y, tile: c.tile, color: c.color })));
        send(ws, { t: 'bucket_undo', changes: changes.map(c => ({ x: c.x, y: c.y, tile: c.prevTile, color: c.prevColor })) });
      }
      break;
    }
    case 'bucket_all': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const tile = Math.floor(msg.tile);
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) return;
      if (tile < 0 || tile > T.CUSTOM) return;
      const changes = bucketAllRecolor(x, y, tile, msg.color || null);
      if (changes.length > 0) {
        broadcastTiles(changes.map(c => ({ x: c.x, y: c.y, tile: c.tile, color: c.color })));
        send(ws, { t: 'bucket_undo', changes: changes.map(c => ({ x: c.x, y: c.y, tile: c.prevTile, color: c.prevColor })) });
        sendChat(p, `Recolored ${changes.length} tiles globally.`, '#ff981f');
      }
      break;
    }
    case 'bucket_new': {
      const x = Math.floor(msg.x), y = Math.floor(msg.y);
      const tile = Math.floor(msg.tile);
      const name = String(msg.name || '').slice(0, 30);
      if (Math.abs(x - p.x) > ENTITY_VIEW || Math.abs(y - p.y) > ENTITY_VIEW) return;
      if (tile < 0 || tile > T.CUSTOM || !name) return;
      const newNameKey = tile === T.CUSTOM && msg.color ? 'c:' + msg.color : 't:' + tile;
      customNames.set(newNameKey, name);
      const changes = bucketAllRecolor(x, y, tile, msg.color || null);
      if (changes.length > 0) {
        broadcastTiles(changes.map(c => ({ x: c.x, y: c.y, tile: c.tile, color: c.color })));
        send(ws, { t: 'bucket_undo', changes: changes.map(c => ({ x: c.x, y: c.y, tile: c.prevTile, color: c.prevColor })) });
      }
      const namesObj = {}; for (const [k, v] of customNames) namesObj[k] = v;
      broadcast({ t: 'names', names: namesObj });
      sendChat(p, `Renamed ${changes.length} tiles to "${name}".`, '#ff981f');
      break;
    }
  }
}

// ── HTTP Server ────────────────────────────────────────────────────────────────
const clientPath = path.join(__dirname, 'client.html');
const mapPath = path.join(__dirname, 'map.html');
const launcherPath = path.join(__dirname, 'launcher.html');
const server = http.createServer((req, res) => {
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
  send(ws, { t: 'welcome', id: p.id, x: p.x, y: p.y, customNames: namesObj, chunkSize: CHUNK_SIZE });
  updatePlayerChunks(p);
  sendStats(p);
  sendChat(p, `Welcome to MiniScape! ${players.size} player(s) online.`, '#ff981f');
  broadcast({ t: 'chat', msg: `Player ${p.id} has joined.`, color: '#0ff' });

  ws.on('message', (data) => handleMessage(ws, data.toString()));
  ws.on('close', () => {
    players.delete(ws);
    broadcast({ t: 'chat', msg: `Player ${p.id} has left.`, color: '#888' });
    console.log(`[leave] Player ${p.id} disconnected (${players.size} online)`);
  });
});

// ── OSRS Sync Server (receives live data from RuneLite Combat Debug plugin) ──
const SYNC_PORT = 2223;
const syncServer = new WebSocket.Server({ port: SYNC_PORT });
let osrsSync = null; // latest OSRS state
let syncNpcs = new Map(); // idx -> mirrored NPC data

syncServer.on('connection', (ws) => {
  console.log('[osrs-sync] RuneLite plugin connected');
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.t === 'sync') {
        osrsSync = msg;
        // Mirror player position, stats, and equipment to first MiniScape player
        if (msg.player && players.size > 0) {
          const firstPlayer = players.values().next().value;
          if (firstPlayer) {
            firstPlayer.x = msg.player.x;
            firstPlayer.y = msg.player.y;
            firstPlayer.path = []; // cancel any movement

            // Sync stats
            if (msg.player.attack !== undefined) {
              firstPlayer.skills = firstPlayer.skills || {};
              firstPlayer.skills.attack = msg.player.attack;
              firstPlayer.skills.strength = msg.player.strength;
              firstPlayer.skills.defence = msg.player.defence;
              firstPlayer.skills.ranged = msg.player.ranged;
              firstPlayer.skills.magic = msg.player.magic;
              firstPlayer.skills.prayer = msg.player.prayer;
              firstPlayer.skills.hitpoints = msg.player.maxHp;
              firstPlayer.hp = msg.player.hp;
              firstPlayer.maxHp = msg.player.maxHp;
            }

            // Sync equipment
            if (msg.player.equipment) {
              firstPlayer.equipment = firstPlayer.equipment || {};
              for (const [slot, id] of Object.entries(msg.player.equipment)) {
                if (id > 0) firstPlayer.equipment[slot] = id;
                else delete firstPlayer.equipment[slot];
              }
            }
          }
        }
        // Mirror NPCs — create/update sync NPCs
        if (msg.npcs) {
          const seenIdx = new Set();
          for (const npcData of msg.npcs) {
            seenIdx.add(npcData.idx);
            let existing = null;
            // Find existing NPC with matching sync index
            for (const npc of npcs) {
              if (npc.syncIdx === npcData.idx) { existing = npc; break; }
            }
            if (existing) {
              // Update position
              existing.prevX = existing.x;
              existing.prevY = existing.y;
              existing.x = npcData.x;
              existing.y = npcData.y;
              existing.syncAnim = npcData.anim;
              if (npcData.hp >= 0 && npcData.maxHp > 0) {
                existing.hp = Math.round((npcData.hp / npcData.maxHp) * existing.maxHp);
              }
            } else {
              // Spawn new synced NPC
              const def = npcDefs.get(npcData.id);
              const stats = def && def.stats ? def.stats : [1,1,1,1,1,1];
              const hp = def ? Math.max(1, stats[3]) : 10;
              npcs.push({
                id: npcs.length, defId: npcData.id, name: npcData.name,
                x: npcData.x, y: npcData.y, spawnX: npcData.x, spawnY: npcData.y,
                prevX: npcData.x, prevY: npcData.y,
                hp, maxHp: hp,
                attack: stats[0], strength: stats[2], defence: stats[1],
                ranged: stats[4], magic: stats[5],
                combatLevel: def ? def.combatLevel : 1,
                aggressive: false,
                dead: false, respawnTick: 0, wanderTick: 99999999,
                nextAttackTick: 0, attackSpeed: 4,
                combatTarget: null, combatTimeout: 0,
                drops: def ? getDropTable(def) : [],
                color: '#8b1a1a',
                syncIdx: npcData.idx, // mark as synced NPC
                syncAnim: npcData.anim,
              });
              syncNpcs.set(npcData.idx, npcs[npcs.length - 1]);
              console.log(`[osrs-sync] Spawned ${npcData.name} (osrs id=${npcData.id}) at ${npcData.x},${npcData.y}`);
            }
          }
          // Remove synced NPCs that are no longer nearby
          for (let i = npcs.length - 1; i >= 0; i--) {
            if (npcs[i].syncIdx !== undefined && !seenIdx.has(npcs[i].syncIdx)) {
              syncNpcs.delete(npcs[i].syncIdx);
              npcs.splice(i, 1);
            }
          }
        }
      }
    } catch (e) {
      console.error('[osrs-sync] Parse error:', e.message);
    }
  });
  ws.on('close', () => {
    console.log('[osrs-sync] RuneLite plugin disconnected');
    // Clean up synced NPCs
    for (let i = npcs.length - 1; i >= 0; i--) {
      if (npcs[i].syncIdx !== undefined) npcs.splice(i, 1);
    }
    syncNpcs.clear();
    osrsSync = null;
  });
});

console.log(`[osrs-sync] Listening on ws://localhost:${SYNC_PORT}`);

// ── Init ───────────────────────────────────────────────────────────────────────
fs.mkdirSync(CHUNKS_DIR, { recursive: true });
if (fs.existsSync(NAMES_FILE)) {
  const obj = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8'));
  for (const [k, v] of Object.entries(obj)) customNames.set(k, v);
  console.log(`[load] ${customNames.size} custom names`);
}
loadDefinitions();
spawnNpcs();
spawnTutorialNpcs();

setInterval(gameTick, TICK_MS);
setInterval(saveAllChunks, SAVE_INTERVAL_MS);
process.on('SIGINT', () => { saveAllChunks(); process.exit(); });
process.on('SIGTERM', () => { saveAllChunks(); process.exit(); });

server.listen(PORT, () => {
  console.log(`[server] MiniScape running on http://localhost:${PORT}`);
  console.log(`[server] Chunk-based world (${CHUNK_SIZE}x${CHUNK_SIZE} chunks, view=${VIEW_DIST})`);
  console.log(`[server] Spawn: OSRS (${SPAWN_X}, ${SPAWN_Y}) Lumbridge`);
});
