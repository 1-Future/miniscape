# OpenScape Resources

Community tools and repos useful for building an open source OSRS-like game.

## Cache & Asset Pipeline

- **[osrscachereader](https://github.com/Dezinater/osrscachereader)** — JS/Node library that reads the OSRS cache. Parses NPCs, items, objects, models, sprites, maps, animations. GLTF exporter built in. Works in browser and Node. **Most directly useful for asset pipeline.**

- **[OSRS Cache Tools](https://github.com/MiladyCheese/Old-School-RuneScape-Cache-Tools)** — Java GUI for reading/editing OSRS cache. Model export (OBJ), sound/music decoder (MIDI + instrument samples as OGG/SF2), sprite extraction. Useful for understanding OSRS music/sound pipeline.

- **[RuneBlend](https://github.com/tamateea/RuneBlend/)** — Blender addon for importing raw RS `.dat` model files. Documents the binary model format — vertex colors, skeletal bones, quaternion rotations. Reference for the PS1-aesthetic vertex coloring system.

## Character & Equipment

- **[OSRS Blender CharacterCreator](https://github.com/Psyda/OSRS-Blender-CharacterCreator)** — Web-based character creator + Blender bridge. Browse all items/equipment/kits by slot. Shows how OSRS composes characters from kit pieces + equipped items. Has pre-extracted cache with 4,833 items, 307 kits, 4,139 3D models with worn model IDs. **Gold mine for equipment data.**

- **[RuneMonk Recorder](https://github.com/Dezinater/runemonk-recorder)** — Recording tool used by RuneMonk for capturing model/animation data.

## World & Map

- **[OSRS Map Tiles](https://github.com/Explv/osrs_map_tiles)** — Full OSRS world map exported as tile images. Useful for 2D minimap overlay, world reference, and map editor background.

## Browser 3D Reference

- **[InfernoTrainer](https://github.com/Supalosa/InfernoTrainer)** — TypeScript browser-based Inferno/Colosseum combat trainer. Proves OSRS-fidelity 3D works in the browser. The [assets.md](https://github.com/Supalosa/InfernoTrainer/blob/colosseum/assets.md) documents the full extraction pipeline: cache → GLTF → meshopt compressed GLB. Shows character equipment compositing commands and animation binding. **Best reference for browser 3D pipeline.**

## Key Takeaways

- `osrscachereader` + `InfernoTrainer` = complete pipeline from cache to browser-ready 3D
- `OSRS-Blender-CharacterCreator` has pre-extracted worn equipment model IDs we couldn't get from RuneLite API
- OSRS uses vertex coloring (no UV textures) which is core to the PS1 aesthetic
- Character models are composed from kit parts + equipment replacements per slot
- `meshopt` compression makes GLTF/GLB files browser-efficient
