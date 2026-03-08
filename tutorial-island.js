// Tutorial Island - Step-by-step progression matching OSRS
// Captured from real OSRS playthrough via Combat Debug Plugin (2026-03-07)

// Tutorial Island spawn point (near Gielinor Guide)
const TUTORIAL_SPAWN = { x: 3094, y: 3107 };

// NPC definitions with OSRS IDs and positions from captured data
const TUTORIAL_NPCS = [
  { defId: 3308, name: 'Gielinor Guide', x: 3095, y: 3106, step: 0 },
  { defId: 8503, name: 'Survival Expert', x: 3104, y: 3094, step: 2 },
  { defId: 3305, name: 'Master Chef', x: 3074, y: 3086, step: 6 },
  { defId: 3312, name: 'Quest Guide', x: 3085, y: 3123, step: 8 },
  { defId: 3311, name: 'Mining Instructor', x: 3082, y: 9505, step: 10 },
  { defId: 3307, name: 'Combat Instructor', x: 3107, y: 9509, step: 14 },
  { defId: 3310, name: 'Account Guide', x: 3126, y: 3123, step: 18 },
  { defId: 3319, name: 'Brother Brace', x: 3124, y: 3106, step: 20 },
  { defId: 7941, name: 'Ironman tutor', x: 3132, y: 3086, step: 22 },
  { defId: 3309, name: 'Magic Instructor', x: 3142, y: 3088, step: 23 },
];

// Combat NPCs on Tutorial Island
const TUTORIAL_COMBAT_NPCS = [
  { defId: 3313, name: 'Giant rat', x: 3105, y: 9519, hp: 5, maxHp: 5, attack: 1, strength: 1, defence: 1, combatLevel: 1, attackSpeed: 4 },
  { defId: 3313, name: 'Giant rat', x: 3109, y: 9518, hp: 5, maxHp: 5, attack: 1, strength: 1, defence: 1, combatLevel: 1, attackSpeed: 4 },
  { defId: 3316, name: 'Chicken', x: 3140, y: 3093, hp: 3, maxHp: 3, attack: 1, strength: 1, defence: 1, combatLevel: 1, attackSpeed: 4 },
  { defId: 3316, name: 'Chicken', x: 3138, y: 3092, hp: 3, maxHp: 3, attack: 1, strength: 1, defence: 1, combatLevel: 1, attackSpeed: 4 },
];

// Skill animation IDs from captured data
const ANIMS = {
  FISHING: 621,
  WOODCUTTING: 879,
  FIREMAKING: 733,
  COOKING_FIRE: 897,
  COOKING_RANGE: 896,
  MINING: 625,
  SMELTING: 899,
  SMITHING: 898,
  MELEE_SWORD: 386,
  RANGED_BOW: 426,
  MAGIC_WIND_STRIKE: 711,
  LADDER_UP: 828,
  LADDER_DOWN: 827,
};

// Item IDs from captured inventory data
const ITEMS = {
  SMALL_FISHING_NET: 303,
  RAW_SHRIMPS: 2514,
  SHRIMPS: 315,
  BRONZE_AXE: 1351,
  TINDERBOX: 590,
  LOGS: 2511,
  POT_OF_FLOUR: 2516,
  BUCKET_OF_WATER: 1929,
  BREAD_DOUGH: 2307,
  BREAD: 2309,
  POT: 1931,
  BUCKET: 1925,
  BRONZE_PICKAXE: 1265,
  TIN_ORE: 438,
  COPPER_ORE: 436,
  BRONZE_BAR: 2349,
  HAMMER: 2347,
  BRONZE_DAGGER: 1205,
  BRONZE_SWORD: 1277,
  WOODEN_SHIELD: 1171,
  SHORTBOW: 841,
  BRONZE_ARROW: 882,
  AIR_RUNE: 556,
  MIND_RUNE: 558,
  WATER_RUNE: 555,
  EARTH_RUNE: 557,
  BODY_RUNE: 559,
  COINS: 995,
};

// XP values from captured data
const XP = {
  FISHING_SHRIMP: 10,
  WOODCUTTING_TREE: 25,
  FIREMAKING_LOG: 40,
  COOKING_SHRIMP: 30,
  COOKING_BREAD: 40,
  MINING_TIN: 17,
  MINING_COPPER: 17,
  SMITHING_BAR: 6,
  SMITHING_DAGGER: 12,
  MELEE_PER_DMG: 4,     // attack XP per damage
  RANGED_PER_DMG: 4,
  MAGIC_WIND_STRIKE: 9, // 5.5 base + per-damage
};

// Tutorial steps - each step defines what happens when player talks to the NPC
// or performs the required action
const STEPS = [
  // Step 0: Talk to Gielinor Guide (character creation already done)
  {
    npc: 'Gielinor Guide',
    dialogue: [
      'Welcome to Tutorial Island!',
      'Before we begin, let\'s take a look at the Settings menu.',
      'Click on the wrench icon to open your settings.',
    ],
    advance: 'talk', // advances on talk
  },
  // Step 1: Open settings tab, then talk again
  {
    npc: 'Gielinor Guide',
    dialogue: [
      'Wonderful. Now let me tell you a bit about the game.',
      'This is Gielinor, a medieval fantasy world.',
      'Head through that door to continue your journey.',
    ],
    advance: 'talk',
  },
  // Step 2: Talk to Survival Expert (gives fishing net)
  {
    npc: 'Survival Expert',
    dialogue: [
      'Hello there, newcomer. I\'m the Survival Expert.',
      'I\'m here to teach you about surviving in the wilderness.',
      'First, let me give you a fishing net. Use it at a fishing spot.',
    ],
    give: [{ id: ITEMS.SMALL_FISHING_NET, count: 1 }],
    advance: 'talk',
  },
  // Step 3: Catch 2 shrimps
  {
    action: 'fish',
    target: 'shrimps',
    count: 2,
    message: 'Catch 2 shrimps using the fishing net.',
  },
  // Step 4: Talk to Survival Expert again (gives axe + tinderbox)
  {
    npc: 'Survival Expert',
    dialogue: [
      'Well done! You caught some shrimps.',
      'Now I\'ll teach you about woodcutting and firemaking.',
      'Take this axe and tinderbox.',
    ],
    give: [{ id: ITEMS.BRONZE_AXE, count: 1 }, { id: ITEMS.TINDERBOX, count: 1 }],
    advance: 'talk',
  },
  // Step 5: Chop 2 trees, light 2 fires, cook 2 shrimps
  {
    action: 'skills',
    tasks: [
      { skill: 'woodcutting', count: 2, message: 'Chop 2 trees' },
      { skill: 'firemaking', count: 2, message: 'Light 2 fires' },
      { skill: 'cooking', count: 2, message: 'Cook 2 shrimps on the fire' },
    ],
    message: 'Chop trees, light fires, and cook your shrimps.',
  },
  // Step 6: Go to Master Chef, make bread
  {
    npc: 'Master Chef',
    dialogue: [
      'Hello! I\'m the Master Chef.',
      'I\'ll teach you how to make bread.',
      'Here, take these ingredients.',
    ],
    give: [{ id: ITEMS.POT_OF_FLOUR, count: 1 }, { id: ITEMS.BUCKET_OF_WATER, count: 1 }],
    advance: 'talk',
  },
  // Step 7: Combine flour+water, cook bread on range
  {
    action: 'cook_bread',
    message: 'Combine the pot of flour with the bucket of water, then cook the dough on the range.',
  },
  // Step 8: Talk to Quest Guide
  {
    npc: 'Quest Guide',
    dialogue: [
      'Hello, adventurer! I\'m here to tell you about quests.',
      'Quests are special adventures you can go on.',
      'Open your quest journal to see available quests.',
      'Now head down the ladder to learn about mining and smithing.',
    ],
    advance: 'talk',
  },
  // Step 9: Go down ladder (auto-advance when entering underground)
  {
    action: 'go_underground',
    message: 'Climb down the ladder to the mining area.',
  },
  // Step 10: Talk to Mining Instructor (gives pickaxe)
  {
    npc: 'Mining Instructor',
    dialogue: [
      'Hi there! I\'m the Mining Instructor.',
      'I\'ll teach you about mining and smithing.',
      'Take this pickaxe and mine some tin and copper ore.',
    ],
    give: [{ id: ITEMS.BRONZE_PICKAXE, count: 1 }],
    advance: 'talk',
  },
  // Step 11: Mine tin + copper, smelt bronze bar
  {
    action: 'mine_and_smelt',
    message: 'Mine tin and copper ore, then smelt them into a bronze bar at the furnace.',
  },
  // Step 12: Talk to Mining Instructor again (gives hammer)
  {
    npc: 'Mining Instructor',
    dialogue: [
      'Great work! You made a bronze bar.',
      'Now take this hammer and smith the bar into a dagger at the anvil.',
    ],
    give: [{ id: ITEMS.HAMMER, count: 1 }],
    advance: 'talk',
  },
  // Step 13: Smith bronze dagger
  {
    action: 'smith_dagger',
    message: 'Use the bronze bar on the anvil to make a bronze dagger.',
  },
  // Step 14: Talk to Combat Instructor (gives sword + shield)
  {
    npc: 'Combat Instructor',
    dialogue: [
      'Hello warrior! I\'m the Combat Instructor.',
      'I\'ll teach you the basics of combat.',
      'Take this sword and shield. Equip them and attack a giant rat!',
    ],
    give: [{ id: ITEMS.BRONZE_SWORD, count: 1 }, { id: ITEMS.WOODEN_SHIELD, count: 1 }],
    advance: 'talk',
  },
  // Step 15: Kill a giant rat with melee
  {
    action: 'kill_melee',
    target: 'Giant rat',
    message: 'Equip the bronze sword and shield, then kill a giant rat.',
  },
  // Step 16: Talk to Combat Instructor again (gives bow + arrows)
  {
    npc: 'Combat Instructor',
    dialogue: [
      'Well done! Melee combat is effective up close.',
      'Now let me teach you about ranged combat.',
      'Take this shortbow and some arrows.',
    ],
    give: [{ id: ITEMS.SHORTBOW, count: 1 }, { id: ITEMS.BRONZE_ARROW, count: 50 }],
    advance: 'talk',
  },
  // Step 17: Kill a giant rat with ranged
  {
    action: 'kill_ranged',
    target: 'Giant rat',
    message: 'Equip the shortbow and bronze arrows, then kill a giant rat with ranged.',
  },
  // Step 18: Talk to Account Guide
  {
    npc: 'Account Guide',
    dialogue: [
      'Welcome! I\'m the Account Guide.',
      'I can tell you about managing your account.',
      'Click the account management button to continue.',
    ],
    advance: 'talk',
  },
  // Step 19: Open account tab (auto-advance)
  {
    action: 'open_tab',
    message: 'Open the account management tab.',
  },
  // Step 20: Talk to Brother Brace
  {
    npc: 'Brother Brace',
    dialogue: [
      'Greetings, traveller. I am Brother Brace.',
      'I can teach you about prayer.',
      'Prayer can protect you in combat and provide various benefits.',
      'Try praying at the altar, then continue on your way.',
    ],
    advance: 'talk',
  },
  // Step 21: Pray at altar (auto-advance)
  {
    action: 'pray',
    message: 'Pray at the altar.',
  },
  // Step 22: Talk to Ironman tutor (optional, auto-skip for now)
  {
    npc: 'Ironman tutor',
    dialogue: [
      'Greetings! I can set your account to Ironman mode.',
      'Ironman mode restricts trading and the Grand Exchange.',
      'For now, you can continue as a normal player.',
    ],
    advance: 'talk',
  },
  // Step 23: Talk to Magic Instructor (gives runes)
  {
    npc: 'Magic Instructor',
    dialogue: [
      'Hello! I\'m the Magic Instructor.',
      'I\'ll teach you the basics of magic.',
      'Take these runes and try casting Wind Strike on a chicken.',
    ],
    give: [{ id: ITEMS.AIR_RUNE, count: 5 }, { id: ITEMS.MIND_RUNE, count: 5 }],
    advance: 'talk',
  },
  // Step 24: Cast Wind Strike on a chicken
  {
    action: 'kill_magic',
    target: 'Chicken',
    message: 'Open the magic tab and cast Wind Strike on a chicken.',
  },
  // Step 25: Talk to Magic Instructor again — teleport to Lumbridge
  {
    npc: 'Magic Instructor',
    dialogue: [
      'Excellent work! You\'ve completed Tutorial Island!',
      'You are ready to begin your adventure in Gielinor.',
      'I will now teleport you to the mainland. Good luck!',
    ],
    advance: 'talk',
    complete: true,
  },
];

// Final inventory given on Tutorial Island completion (from captured OSRS data)
const COMPLETION_INVENTORY = [
  { id: ITEMS.BRONZE_AXE, count: 1 },
  { id: ITEMS.BRONZE_PICKAXE, count: 1 },
  { id: ITEMS.TINDERBOX, count: 1 },
  { id: ITEMS.SMALL_FISHING_NET, count: 1 },
  { id: ITEMS.SHRIMPS, count: 1 },
  { id: ITEMS.BRONZE_DAGGER, count: 1 },
  { id: ITEMS.BRONZE_SWORD, count: 1 },
  { id: ITEMS.WOODEN_SHIELD, count: 1 },
  { id: ITEMS.SHORTBOW, count: 1 },
  { id: ITEMS.BRONZE_ARROW, count: 25 },
  { id: ITEMS.AIR_RUNE, count: 25 },
  { id: ITEMS.MIND_RUNE, count: 15 },
  { id: ITEMS.BUCKET, count: 1 },
  { id: ITEMS.POT, count: 1 },
  { id: ITEMS.BREAD, count: 1 },
  { id: ITEMS.WATER_RUNE, count: 6 },
  { id: ITEMS.EARTH_RUNE, count: 4 },
  { id: ITEMS.BODY_RUNE, count: 2 },
];

module.exports = {
  TUTORIAL_SPAWN,
  TUTORIAL_NPCS,
  TUTORIAL_COMBAT_NPCS,
  ANIMS,
  ITEMS,
  XP,
  STEPS,
  COMPLETION_INVENTORY,
};
