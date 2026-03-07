# MiniScape Vision

## 1. RuneLite Plugins as Native Features

RuneLite has ~200+ plugins that solve real pain points in the vanilla OSRS client. Since MiniScape builds the engine from scratch, we can integrate these directly as first-class features instead of bolting them on as plugins.

### High-Priority Integrations
- **Ground Items** — show item names/values on the ground with color coding
- **Tile Markers** — click to mark tiles with colors (already partially built via paint tools)
- **XP Tracker** — real-time XP/hr, time to level, session gains
- **Loot Tracker** — log drops per NPC with value totals
- **Bank Tags** — tag and filter bank items
- **Inventory Setups** — save/load gear loadouts
- **Quest Helper** — step-by-step quest guides with map markers
- **Clue Scroll Helper** — puzzle solvers, coordinate lookups
- **Menu Entry Swapper** — customize right-click menus
- **GPU Renderer** — WebGL rendering for performance at scale
- **Animation Smoothing** — interpolate between ticks for fluid movement
- **Object Markers** — highlight specific objects (banks, altars, etc.)
- **NPC Indicators** — highlight NPCs by name, show respawn timers
- **World Map** — in-game world map with teleport locations (partially done)
- **Agility Overlay** — show clickboxes for agility courses
- **Prayer Flick Helper** — visual indicators for prayer switching

### Why This Matters
Every RuneLite plugin represents a community-identified problem. Instead of reverse-engineering the game client to add overlays, we build them into the rendering pipeline. No plugin API needed — just features.

## 2. AI Vision Tile Mapping

### Concept
Use AI vision models to automatically classify every tile in the OSRS world from the mejrs map tile images we already use.

### Process
1. **Source**: mejrs tile images at zoom 3-4 (`https://raw.githubusercontent.com/mejrs/layers_osrs/refs/heads/master/mapsquares/-1/{z}/0_{x}_{y}.png`)
2. **Extract**: Each 256x256 image contains tiles at various densities per zoom level
3. **Classify**: Feed tiles through a vision model (Claude, GPT-4V, or local model) to identify tile type: grass, water, tree, rock, sand, path, wall, floor, door, etc.
4. **Output**: Binary tilemap file — one byte per tile covering the entire OSRS world
5. **Result**: MiniScape loads an accurate OSRS world automatically

### Scale
- OSRS world is roughly 3000x3000 tiles in the main overworld
- At zoom 3, each image covers 32x32 tiles = ~9000 images for full coverage
- Batch-able with rate limiting, cacheable results
- Could also extract elevation, object placement, NPC spawn accuracy

### Data Format
```
data/world-tiles/{regionX}_{regionY}.bin  — 64x64 tile bytes per chunk
data/world-meta.json                       — tile type definitions, region bounds
```

### Enhancement: Object Detection
Beyond flat tiles, vision models could identify:
- Tree species (normal, oak, willow, yew, magic)
- Rock types (copper, tin, iron, coal, mithril)
- Building types and door placements
- Water features (rivers, lakes, ocean)
- Path networks and road connections
