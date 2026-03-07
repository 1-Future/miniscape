// Extract item, NPC, and object definitions from the OSRS cache
// Output: data/items.json, data/npcs.json, data/objects.json

import { RSCache } from 'osrscachereader';
import * as fs from 'fs';

const CACHE_DIR = './data/osrs-cache/cache/';
const OUT_DIR = './data';
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log('[extract] Loading OSRS cache...');
const cache = new RSCache(CACHE_DIR);
await cache.onload;
console.log('[extract] Cache loaded.');

// Index 2 = CONFIGS, archive 10 = ITEM, 9 = NPC, 6 = OBJECT
async function extractAll(archiveId, label) {
  console.log(`[extract] Reading ${label}...`);
  const files = await cache.getAllFiles(2, archiveId);
  const defs = [];
  let count = 0;
  for (const file of files) {
    if (!file || !file.def) continue;
    const d = file.def;
    // Skip unnamed/null entries
    if (!d.name || d.name === 'null' || d.name === '') continue;
    defs.push(d);
    count++;
  }
  console.log(`[extract] ${label}: ${count} named definitions (${files.length} total)`);
  return defs;
}

// ── Items ──────────────────────────────────────────────────────────────────────
const itemDefs = await extractAll(10, 'Items');
const items = itemDefs.map(d => {
  const item = {
    id: d.id,
    name: d.name,
    cost: d.cost || 0,
    stackable: d.stackable === 1,
    members: d.members || false,
    tradeable: d.isTradeable || false,
    weight: d.weight || 0,
    options: (d.options || []).filter(Boolean),
    interfaceOptions: (d.interfaceOptions || []).filter(Boolean),
  };
  if (d.examineText) item.examine = d.examineText;
  if (d.notedID >= 0) item.notedId = d.notedID;
  if (d.notedTemplate >= 0) item.notedTemplate = d.notedTemplate;
  if (d.equipSlot !== undefined) item.equipSlot = d.equipSlot;
  if (d.maleModel0 >= 0) item.equipable = true;
  if (d.team) item.team = d.team;
  // Equipment params (attack/defence bonuses stored in params)
  if (d.params && typeof d.params === 'object' && Object.keys(d.params).length > 0) {
    item.params = d.params;
  }
  return item;
});

fs.writeFileSync(`${OUT_DIR}/items.json`, JSON.stringify(items, null, 2));
console.log(`[extract] Wrote ${items.length} items to data/items.json`);

// ── NPCs ───────────────────────────────────────────────────────────────────────
const npcDefs = await extractAll(9, 'NPCs');
const npcs = npcDefs.map(d => {
  const npc = {
    id: d.id,
    name: d.name,
    size: d.size || 1,
    combatLevel: d.combatLevel || -1,
    actions: (d.actions || []).filter(Boolean),
    minimapVisible: d.isMinimapVisible !== false,
    interactable: d.isInteractable !== false,
  };
  // Stats array: [attack, defence, strength, hitpoints, ranged, magic]
  if (d.stats && d.stats.some(s => s > 1)) npc.stats = d.stats;
  if (d.params && typeof d.params === 'object' && Object.keys(d.params).length > 0) {
    npc.params = d.params;
  }
  return npc;
});

fs.writeFileSync(`${OUT_DIR}/npcs.json`, JSON.stringify(npcs, null, 2));
console.log(`[extract] Wrote ${npcs.length} NPCs to data/npcs.json`);

// ── Objects ────────────────────────────────────────────────────────────────────
const objDefs = await extractAll(6, 'Objects');
const objects = objDefs.map(d => {
  const obj = {
    id: d.id,
    name: d.name,
    sizeX: d.sizeX || 1,
    sizeY: d.sizeY || 1,
    actions: (d.actions || []).filter(Boolean),
    blocksMovement: d.interactType !== 0,
  };
  if (d.mapSceneID >= 0) obj.mapScene = d.mapSceneID;
  if (d.mapAreaId >= 0) obj.mapArea = d.mapAreaId;
  if (d.animationID >= 0) obj.animation = d.animationID;
  return obj;
});

fs.writeFileSync(`${OUT_DIR}/objects.json`, JSON.stringify(objects, null, 2));
console.log(`[extract] Wrote ${objects.length} objects to data/objects.json`);

console.log('[extract] Done!');
