/* The Plague's Call — single-file React app (formerly "Shadowquill" v1)
 * - Dual-mode (DM / Player) with strict permission separation
 * - PeerJS WebRTC sync (free public broker — no backend required)
 * - IndexedDB persistence (v7) + Export/Import JSON
 */
const { useState, useEffect, useRef, useReducer, useMemo, useCallback, createContext, useContext } = React;

// ====================================================================
// CONSTANTS
// ====================================================================
// Storage keys bumped to v2 for the Plague's Call rebrand. Older
// 'shadowquill.*' sessions are still readable — see migrateState() below,
// which checks both namespaces for legacy compatibility.
const STORAGE_KEY  = 'plagues-call.session.v2';
const AUTH_KEY     = 'plagues-call.auth.v2';
const SETTINGS_KEY = 'plagues-call.settings.v2';
const PLAYER_ID_KEY = 'plagues-call.player-id.v4'; // v4: stable per-device identity
const PEER_PREFIX  = 'plagues-call-';
const LEGACY_STORAGE_KEY = 'shadowquill.session.v1';
const LEGACY_AUTH_KEY    = 'shadowquill.auth.v1';

// ====================================================================
// IDB STORAGE  (v7 fix #1)
// ====================================================================
// v6 wrote everything to localStorage as one giant JSON blob. Once map
// images (base64 data URLs, often 0.5–3 MB each) accumulated, the total
// quickly exceeded the ~5 MB localStorage quota and saves started
// throwing QuotaExceededError — silently losing state.
//
// v7 splits storage:
//   IDB store 'session'   → the lean state JSON (no map image bytes)
//   IDB store 'mapImages' → { mapId → base64-data-url }
//   IDB store 'sounds'    → { soundId → { name, dataUrl } } for v7 #10
//
// On save, map images are extracted from state.maps[*].imageUrl into
// the mapImages store; the state JSON gets a sentinel ("__idb__") marker
// in their place. On load, the sentinels get re-inflated.
//
// localStorage retains only:
//   - auth, settings, player-id (small, fine where they were)
//   - a tiny "session metadata" stub for legacy code paths
//
// IndexedDB has effectively no quota for this kind of usage (per-origin
// allowance is hundreds of MB to GB), and writes are async + transactional.

const IDB_NAME = 'plagues-call';
const IDB_VERSION = 1;
const IDB_STORES = { session: 'session', mapImages: 'mapImages', sounds: 'sounds' };
const IMG_SENTINEL = '__idb_image__';

// In-memory cache for sound audio data (soundId → dataUrl).
// Populated by onSoundData and by useSoundPlayback when it reads from IDB.
// This avoids the IDB read-write race: when a sound_data envelope arrives
// and updates the cache, the next render of useSoundPlayback can find the
// bytes synchronously without waiting for an async IDB lookup to complete.
// Never serialised or broadcast — lives only for the current page session.
const _soundDataCache = new Map();

let _idbPromise = null;
function openIDB() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORES.session))    db.createObjectStore(IDB_STORES.session);
      if (!db.objectStoreNames.contains(IDB_STORES.mapImages))  db.createObjectStore(IDB_STORES.mapImages);
      if (!db.objectStoreNames.contains(IDB_STORES.sounds))     db.createObjectStore(IDB_STORES.sounds);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _idbPromise;
}

function idbGet(storeName, key) {
  return openIDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}
function idbSet(storeName, key, value) {
  return openIDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }));
}
function idbDelete(storeName, key) {
  return openIDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }));
}
function idbAllKeys(storeName) {
  return openIDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}
function idbAllEntries(storeName) {
  return openIDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const keysReq = store.getAllKeys();
    const valsReq = store.getAll();
    keysReq.onsuccess = () => {
      valsReq.onsuccess = () => {
        const out = {};
        keysReq.result.forEach((k, i) => { out[k] = valsReq.result[i]; });
        resolve(out);
      };
      valsReq.onerror = () => reject(valsReq.error);
    };
    keysReq.onerror = () => reject(keysReq.error);
  }));
}

// Strip map images from the state for serialization. Returns
//   { lean, images } where lean has IMG_SENTINEL in place of imageUrl
//   bytes, and images is { mapId → dataUrl } for IDB persistence.
// Also strips inline audio dataUrls from soundEvents — those live in
// the IDB sounds store, no need to duplicate them in state.
function splitStateForPersist(state) {
  const images = {};
  const leanMaps = {};
  for (const [id, m] of Object.entries(state.maps || {})) {
    if (m.imageUrl && typeof m.imageUrl === 'string' && m.imageUrl.startsWith('data:')) {
      images[id] = m.imageUrl;
      leanMaps[id] = { ...m, imageUrl: IMG_SENTINEL };
    } else {
      // External URLs and missing images stay in the JSON
      leanMaps[id] = m;
    }
  }
  // v7 #10: drop dataUrls from soundEvents so they don't bloat the
  // session JSON. Players cache the bytes in IDB on first receipt.
  const leanSoundEvents = (state.soundEvents || []).map(e => {
    const { dataUrl, ...rest } = e;
    return rest;
  });
  return {
    lean: { ...state, maps: leanMaps, soundEvents: leanSoundEvents },
    images,
  };
}

// Inverse: take a lean state + an images dict and rehydrate.
function rejoinStateImages(lean, images) {
  const maps = {};
  for (const [id, m] of Object.entries(lean.maps || {})) {
    if (m.imageUrl === IMG_SENTINEL && images[id]) {
      maps[id] = { ...m, imageUrl: images[id] };
    } else if (m.imageUrl === IMG_SENTINEL) {
      // Image missing from IDB — leave it null so the map can still load.
      console.warn(`[plagues-call] map ${id} image missing from IDB`);
      maps[id] = { ...m, imageUrl: null };
    } else {
      maps[id] = m;
    }
  }
  return { ...lean, maps };
}

// Save: writes the lean state JSON + each map image to IDB. Removes
// IDB images for maps that no longer exist (so deletion frees space).
async function persistSessionToIDB(state) {
  const { lean, images } = splitStateForPersist(state);
  const json = JSON.stringify(lean);
  await idbSet(IDB_STORES.session, 'main', json);
  // Sync map images with IDB: write current ones, delete orphans.
  const existingKeys = await idbAllKeys(IDB_STORES.mapImages);
  const wantKeys = new Set(Object.keys(images));
  for (const k of existingKeys) {
    if (!wantKeys.has(k)) await idbDelete(IDB_STORES.mapImages, k);
  }
  for (const [id, dataUrl] of Object.entries(images)) {
    await idbSet(IDB_STORES.mapImages, id, dataUrl);
  }
  return { jsonBytes: json.length, imageCount: Object.keys(images).length };
}

async function loadSessionFromIDB() {
  const json = await idbGet(IDB_STORES.session, 'main');
  if (!json) return null;
  const lean = JSON.parse(json);
  const images = await idbAllEntries(IDB_STORES.mapImages);
  return rejoinStateImages(lean, images);
}

// One-time migration from localStorage v6 blob → IDB. Reads the old
// blob, splits it, writes to IDB, and deletes the localStorage entries.
// Idempotent: once IDB has a session, this is a no-op.
async function migrateLocalStorageToIDB() {
  try {
    const existingIDB = await idbGet(IDB_STORES.session, 'main');
    if (existingIDB) return { migrated: false, reason: 'idb-already-has-data' };
    // Try v6 keys
    let raw = null, source = null;
    try { raw = localStorage.getItem(STORAGE_KEY); source = STORAGE_KEY; } catch {}
    if (!raw) { try { raw = localStorage.getItem(STORAGE_KEY + '.backup'); source = STORAGE_KEY + '.backup'; } catch {} }
    if (!raw) { try { raw = localStorage.getItem(LEGACY_STORAGE_KEY); source = LEGACY_STORAGE_KEY; } catch {} }
    if (!raw) return { migrated: false, reason: 'no-localstorage-data' };
    const parsed = JSON.parse(raw);
    await persistSessionToIDB(parsed);
    // Now safe to remove the bloated localStorage entries
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    try { localStorage.removeItem(STORAGE_KEY + '.backup'); } catch {}
    return { migrated: true, source, bytes: raw.length };
  } catch (err) {
    console.warn('[plagues-call] localStorage→IDB migration failed:', err?.message || err);
    return { migrated: false, reason: 'error', error: err?.message };
  }
}

// v4: Stable per-device player identity. Persists across refresh/reconnect
// so that DM can re-link a returning player to their previous claim even
// though PeerJS gives them a brand-new peer ID on each session.
function getOrCreatePlayerId() {
  try {
    const existing = localStorage.getItem(PLAYER_ID_KEY);
    if (existing) return existing;
    const id = 'pid_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    localStorage.setItem(PLAYER_ID_KEY, id);
    return id;
  } catch {
    return 'pid_anon_' + Math.random().toString(36).slice(2, 12);
  }
}

// Simple password for DM mode (placeholder — swap with real auth for production)
const DM_PASSWORD = 'dragon';
if (DM_PASSWORD === 'dragon') {
  console.warn("[plagues-call] Default DM password 'dragon' is in use. Change DM_PASSWORD in app.js before public deployment.");
}

const APP_NAME = "The Plague's Call";

const CONDITIONS = [
  'Blinded','Charmed','Deafened','Frightened','Grappled',
  'Incapacitated','Invisible','Paralyzed','Petrified','Poisoned',
  'Prone','Restrained','Stunned','Unconscious','Exhausted',
  'Concentrating','Raging','Blessed','Hasted','Dead',
  // v5 fix #9: Objects at 0 HP get "Broken", not "Dead"
  'Broken'
];

const CONDITION_COLORS = {
  'Poisoned': '#6b8e3f', 'Stunned': '#c9b03a', 'Blinded': '#444',
  'Paralyzed': '#7a4bc4', 'Charmed': '#c46ab8', 'Frightened': '#b56a3a',
  'Prone': '#6b7280', 'Restrained': '#8b5a2b', 'Unconscious': '#4a4a6a',
  'Dead': '#8b2020', 'Invisible': '#4a7cbd', 'Blessed': '#d4a574',
  'Concentrating': '#9b6ac4', 'Raging': '#c43e3e', 'Hasted': '#d4a574',
  // v5: "Broken" gets a dusty grey-brown to distinguish from Dead's blood red
  'Broken': '#7a6455',
};

// Entity types. Added in v2: Familiar, Neutral Beast, Object.
//  - Familiar      : player-claimable, possibly multiple per player, HP visible to players
//  - Neutral Beast : environmental / non-hostile, visibility-gated like monsters
//  - Object        : static/interactable, no initiative by default, HP hidden from players
const ENTITY_TYPES = ['PC', 'Monster', 'NPC', 'Familiar', 'Neutral Beast', 'Object', 'Label'];

const DEFAULT_COLORS = {
  'PC': '#4a7cbd',
  'Monster': '#8b2020',
  'NPC': '#d4a574',
  'Familiar': '#5fb58a',
  'Neutral Beast': '#7a9274',
  'Object': '#8a7f6e',
  'Label': '#c9a34a',
};

// Entity types whose HP bars/numbers players can see. Everything else is
// abstracted to a Strong/Rough/Waning status label for players.
const PLAYER_HP_VISIBLE_TYPES = new Set(['PC', 'Familiar']);

// Entity types that are player-claimable.
const CLAIMABLE_TYPES = new Set(['PC', 'Familiar']);

// Player-visible descriptors for the DM-set Sickness stat (0–3).
const SICKNESS_DESCRIPTORS = [
  '',                       // 0 — nothing
  'A bit pale',             // 1
  'Sluggish and pale',      // 2
  'Sick',                   // 3
];

const DEFAULT_SETTINGS = {
  theme: 'dark',        // 'dark' | 'light'
  mapScale: 1.0,        // global DM control: map-vs-token perceived size multiplier
  sicknessEffects: true, // player-side: wobble/vignette when PC is sluggish/sick
};

// v3: built-in token presets. DM can add custom ones on top; these are merged
// in at read time (never saved to state so they always reflect code updates).
const BUILTIN_TOKEN_PRESETS = [
  { id: 'builtin:goblin',   name: 'Goblin',     builtin: true,
    entity: { type: 'Monster', name: 'Goblin',  color: '#6b8e3f',
              hp: { current: 7, max: 7 }, ac: 15, speed: 30, initBonus: 2,
              stats: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
              cr: '1/4', passivePerception: 9,
              playerDescription: 'A wiry, sharp-toothed creature in scavenged leather.' } },
  { id: 'builtin:commoner', name: 'Commoner',   builtin: true,
    entity: { type: 'NPC', name: 'Commoner',    color: '#9b8b7a',
              hp: { current: 4, max: 4 }, ac: 10, speed: 30, initBonus: 0,
              stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
              role: 'villager', passivePerception: 10 } },
  { id: 'builtin:guard',    name: 'Guard',      builtin: true,
    entity: { type: 'NPC', name: 'Guard',       color: '#5a7088',
              hp: { current: 11, max: 11 }, ac: 16, speed: 30, initBonus: 1,
              stats: { str: 13, dex: 12, con: 12, int: 10, wis: 11, cha: 10 },
              role: 'town guard', passivePerception: 12 } },
  { id: 'builtin:bandit',   name: 'Bandit',     builtin: true,
    entity: { type: 'Monster', name: 'Bandit',  color: '#6b4a2b',
              hp: { current: 11, max: 11 }, ac: 12, speed: 30, initBonus: 1,
              stats: { str: 11, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
              cr: '1/8', passivePerception: 10,
              playerDescription: 'A rough-looking brigand with a weathered blade.' } },
  { id: 'builtin:wolf',     name: 'Wolf',       builtin: true,
    entity: { type: 'Neutral Beast', name: 'Wolf', color: '#6a6358',
              hp: { current: 11, max: 11 }, ac: 13, speed: 40, initBonus: 2,
              stats: { str: 12, dex: 15, con: 12, int: 3, wis: 12, cha: 6 },
              role: 'wolf', passivePerception: 13,
              playerDescription: 'A lean grey wolf, ribs visible under matted fur.' } },
  { id: 'builtin:skeleton', name: 'Skeleton',   builtin: true,
    entity: { type: 'Monster', name: 'Skeleton', color: '#c9c3a8',
              hp: { current: 13, max: 13 }, ac: 13, speed: 30, initBonus: 2,
              stats: { str: 10, dex: 14, con: 15, int: 6, wis: 8, cha: 5 },
              cr: '1/4', passivePerception: 9,
              playerDescription: 'Yellowed bones bound together by a foul animating will.' } },
  { id: 'builtin:chest',    name: 'Chest',      builtin: true,
    entity: { type: 'Object', name: 'Chest', color: '#8b6540',
              hp: { current: 0, max: 0 }, ac: 12, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'container',
              playerDescription: 'An iron-bound chest, latched.' } },
  { id: 'builtin:torch',    name: 'Torch / Brazier', builtin: true,
    entity: { type: 'Object', name: 'Torch', color: '#d4a52e',
              hp: { current: 0, max: 0 }, ac: 10, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'light source',
              lightRadius: 20,
              playerDescription: 'A flickering flame casting long shadows.' } },

  // v4 fix #19: Object presets
  { id: 'builtin:candle', name: 'Candle', builtin: true,
    entity: { type: 'Object', name: 'Candle', color: '#f0d77a',
              hp: { current: 0, max: 0 }, ac: 8, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'light source',
              lightRadius: 5,
              playerDescription: 'A lone candle, its flame thin and nervous.' } },
  { id: 'builtin:pouch', name: 'Pouch', builtin: true,
    entity: { type: 'Object', name: 'Pouch', color: '#704a28',
              hp: { current: 0, max: 0 }, ac: 8, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'container',
              playerDescription: 'A small leather pouch, drawstring pulled tight.' } },
  { id: 'builtin:lever', name: 'Lever', builtin: true,
    entity: { type: 'Object', name: 'Lever', color: '#6a6a6a',
              hp: { current: 0, max: 0 }, ac: 15, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'mechanism',
              playerDescription: 'An iron lever set into the wall.' } },
  { id: 'builtin:key', name: 'Key', builtin: true,
    entity: { type: 'Object', name: 'Key', color: '#b8965a',
              hp: { current: 0, max: 0 }, ac: 10, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'key',
              playerDescription: 'An ornate brass key.' } },
  { id: 'builtin:book', name: 'Book', builtin: true,
    entity: { type: 'Object', name: 'Book', color: '#5c3a2e',
              hp: { current: 2, max: 2 }, ac: 8, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'tome',
              playerDescription: 'A weathered tome, spine cracked, pages yellow.' } },
  { id: 'builtin:door', name: 'Door', builtin: true,
    entity: { type: 'Object', name: 'Door', color: '#6e4a28',
              hp: { current: 10, max: 10 }, ac: 15, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'door',
              playerDescription: 'A wooden door, weather-beaten.' } },
  { id: 'builtin:reinforced_door', name: 'Reinforced Door', builtin: true,
    entity: { type: 'Object', name: 'Reinforced Door', color: '#3a2e22',
              hp: { current: 25, max: 25 }, ac: 18, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'door',
              playerDescription: 'A heavy door banded with iron.' } },
  { id: 'builtin:trap_door', name: 'Trap Door', builtin: true,
    entity: { type: 'Object', name: 'Trap Door', color: '#5a3a22',
              hp: { current: 8, max: 8 }, ac: 12, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'hatch',
              playerDescription: 'A wooden hatch set into the floor.' } },
  { id: 'builtin:reinforced_trap_door', name: 'Reinforced Trap Door', builtin: true,
    entity: { type: 'Object', name: 'Reinforced Trap Door', color: '#2c2016',
              hp: { current: 20, max: 20 }, ac: 17, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'hatch',
              playerDescription: 'An iron-bound hatch, heavy and barred.' } },
  { id: 'builtin:window', name: 'Window', builtin: true,
    entity: { type: 'Object', name: 'Window', color: '#7a94a6',
              hp: { current: 4, max: 4 }, ac: 10, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'window',
              playerDescription: 'A leaded-glass window.' } },

  // v4 fix #20: NPC presets
  { id: 'builtin:npc_male_commoner', name: 'Male Commoner', builtin: true,
    entity: { type: 'NPC', name: 'Commoner (m)', color: '#9b8b7a',
              hp: { current: 4, max: 4 }, ac: 10, speed: 30, initBonus: 0,
              stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
              role: 'villager', passivePerception: 10,
              playerDescription: 'A weathered man in plain working clothes.' } },
  { id: 'builtin:npc_female_commoner', name: 'Female Commoner', builtin: true,
    entity: { type: 'NPC', name: 'Commoner (f)', color: '#a08b7d',
              hp: { current: 4, max: 4 }, ac: 10, speed: 30, initBonus: 0,
              stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
              role: 'villager', passivePerception: 10,
              playerDescription: 'A weathered woman in plain working clothes.' } },
  { id: 'builtin:npc_local_elite', name: 'Local Elite', builtin: true,
    entity: { type: 'NPC', name: 'Local Elite', color: '#7a5a88',
              hp: { current: 18, max: 18 }, ac: 13, speed: 30, initBonus: 1,
              stats: { str: 11, dex: 12, con: 12, int: 13, wis: 12, cha: 14 },
              role: 'noble / merchant / patron', passivePerception: 12,
              playerDescription: 'Finely dressed and carrying themself with easy authority.' } },
  { id: 'builtin:npc_fighter_guard', name: 'Fighter Guard', builtin: true,
    entity: { type: 'NPC', name: 'Fighter Guard', color: '#4a5f82',
              hp: { current: 22, max: 22 }, ac: 17, speed: 30, initBonus: 1,
              stats: { str: 14, dex: 12, con: 14, int: 10, wis: 11, cha: 10 },
              role: 'guard (heavy)', passivePerception: 12,
              playerDescription: 'Chain shirt, sword at hip, watchful eyes.' } },
  { id: 'builtin:npc_ranger_guard', name: 'Ranger Guard', builtin: true,
    entity: { type: 'NPC', name: 'Ranger Guard', color: '#3f6a4a',
              hp: { current: 19, max: 19 }, ac: 14, speed: 30, initBonus: 3,
              stats: { str: 11, dex: 16, con: 12, int: 11, wis: 14, cha: 10 },
              role: 'guard (scout)', passivePerception: 14,
              darkvision: 30,
              playerDescription: 'Leather armor, longbow slung, alert to every shadow.' } },

  // ==========================================================
  // v5 #11 — BESTIARY: humanoids
  // ==========================================================
  { id: 'builtin:young_child', name: 'Young Child', builtin: true, category: 'Humanoid', cr: '0',
    entity: { type: 'NPC', name: 'Young Child', color: '#c9a380',
              hp: { current: 2, max: 2 }, ac: 9, speed: 25, initBonus: 0,
              stats: { str: 6, dex: 10, con: 8, int: 8, wis: 8, cha: 10 },
              role: 'young child', passivePerception: 9,
              playerDescription: 'A small child, barely old enough to know fear.' } },
  { id: 'builtin:child', name: 'Child', builtin: true, category: 'Humanoid', cr: '0',
    entity: { type: 'NPC', name: 'Child', color: '#b79270',
              hp: { current: 4, max: 4 }, ac: 10, speed: 30, initBonus: 0,
              stats: { str: 8, dex: 12, con: 10, int: 10, wis: 9, cha: 10 },
              role: 'child', passivePerception: 10,
              playerDescription: 'A child, eyes wide, all elbows and quick feet.' } },
  { id: 'builtin:teen', name: 'Teen', builtin: true, category: 'Humanoid', cr: '0',
    entity: { type: 'NPC', name: 'Teen', color: '#a88568',
              hp: { current: 6, max: 6 }, ac: 10, speed: 30, initBonus: 1,
              stats: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 11 },
              role: 'adolescent', passivePerception: 11,
              playerDescription: 'A lanky adolescent, caught between child and adult.' } },
  { id: 'builtin:blacksmith', name: 'Blacksmith', builtin: true, category: 'Humanoid', cr: '1/4',
    entity: { type: 'NPC', name: 'Blacksmith', color: '#5a4238',
              hp: { current: 16, max: 16 }, ac: 11, speed: 30, initBonus: 0,
              stats: { str: 16, dex: 10, con: 14, int: 10, wis: 11, cha: 10 },
              role: 'blacksmith', passivePerception: 10,
              playerDescription: 'Scarred forearms, leather apron, a hammer always within reach.' } },
  { id: 'builtin:sick_village_guard', name: 'Sick Village Guard', builtin: true, category: 'Humanoid', cr: '1/2',
    entity: { type: 'NPC', name: 'Sick Village Guard', color: '#6a7a5a',
              hp: { current: 9, max: 15 }, ac: 13, speed: 25, initBonus: 1,
              stats: { str: 12, dex: 12, con: 10, int: 10, wis: 11, cha: 9 },
              role: 'village guard (ailing)', passivePerception: 11,
              sickness: 2,
              playerDescription: 'A guard in dented chain, pale and sweating, leaning on their spear.' } },
  { id: 'builtin:village_guard', name: 'Village Guard', builtin: true, category: 'Humanoid', cr: '1',
    entity: { type: 'NPC', name: 'Village Guard', color: '#4a5a6a',
              hp: { current: 22, max: 22 }, ac: 14, speed: 30, initBonus: 1,
              stats: { str: 13, dex: 12, con: 13, int: 10, wis: 11, cha: 10 },
              role: 'village guard', passivePerception: 12,
              playerDescription: 'A dutiful village guard in studded leather, spear in hand.' } },
  { id: 'builtin:priest', name: 'Priest', builtin: true, category: 'Humanoid', cr: '4',
    entity: { type: 'NPC', name: 'Priest', color: '#c9b37a',
              hp: { current: 44, max: 44 }, ac: 15, speed: 30, initBonus: 0,
              stats: { str: 10, dex: 10, con: 12, int: 13, wis: 16, cha: 13 },
              role: 'priest / cleric', passivePerception: 15,
              playerDescription: 'Robed in ceremonial vestments, holy symbol held before them.' } },
  { id: 'builtin:tavernkeeper', name: 'Tavernkeeper', builtin: true, category: 'Humanoid', cr: '1/8',
    entity: { type: 'NPC', name: 'Tavernkeeper', color: '#8b6a4a',
              hp: { current: 10, max: 10 }, ac: 10, speed: 30, initBonus: 0,
              stats: { str: 11, dex: 10, con: 12, int: 11, wis: 11, cha: 13 },
              role: 'tavernkeeper', passivePerception: 11,
              playerDescription: 'Rag in one hand, tankard in the other, always listening.' } },
  { id: 'builtin:tinkerer', name: 'Tinkerer (Artificer)', builtin: true, category: 'Humanoid', cr: '9',
    entity: { type: 'NPC', name: 'Tinkerer', color: '#6a4a7c',
              hp: { current: 91, max: 91 }, ac: 17, speed: 30, initBonus: 2,
              stats: { str: 10, dex: 14, con: 14, int: 18, wis: 12, cha: 11 },
              role: 'artificer', passivePerception: 14,
              darkvision: 60,
              playerDescription: 'Goggles, a bandolier of strange tools, fingers stained with oil and arcane residue.' } },
  { id: 'builtin:fisherman', name: 'Fisherman', builtin: true, category: 'Humanoid', cr: '0',
    entity: { type: 'NPC', name: 'Fisherman', color: '#5a7090',
              hp: { current: 4, max: 4 }, ac: 10, speed: 30, initBonus: 0,
              stats: { str: 11, dex: 10, con: 11, int: 10, wis: 11, cha: 10 },
              role: 'fisherman', passivePerception: 11,
              playerDescription: 'Salt-cracked hands, a coiled net over their shoulder, smell of the sea.' } },
  { id: 'builtin:orc', name: 'Orc', builtin: true, category: 'Humanoid', cr: '1/2',
    entity: { type: 'Monster', name: 'Orc', color: '#5a6a3a',
              hp: { current: 15, max: 15 }, ac: 13, speed: 30, initBonus: 1,
              stats: { str: 16, dex: 12, con: 16, int: 7, wis: 11, cha: 10 },
              role: 'orc warrior', passivePerception: 10,
              darkvision: 60,
              playerDescription: 'Tusked, scarred, greataxe gripped in calloused hands.' } },

  // ==========================================================
  // v5 #11 — BESTIARY: animals
  // ==========================================================
  { id: 'builtin:dog', name: 'Dog', builtin: true, category: 'Animal', cr: '1/8',
    entity: { type: 'Neutral Beast', name: 'Dog', color: '#8a6a3a',
              hp: { current: 5, max: 5 }, ac: 12, speed: 40, initBonus: 2,
              stats: { str: 10, dex: 14, con: 12, int: 3, wis: 12, cha: 6 },
              role: 'hound', passivePerception: 13,
              playerDescription: 'A loyal hound, ears pricked, tail low and alert.' } },
  { id: 'builtin:cat', name: 'Cat', builtin: true, category: 'Animal', cr: '0',
    entity: { type: 'Neutral Beast', name: 'Cat', color: '#8b7355',
              hp: { current: 2, max: 2 }, ac: 12, speed: 40, initBonus: 2,
              stats: { str: 3, dex: 15, con: 10, int: 3, wis: 12, cha: 7 },
              role: 'house cat', passivePerception: 13,
              darkvision: 60,
              playerDescription: 'A sleek cat, unbothered by you, slipping through shadow.' } },
  { id: 'builtin:pigeon', name: 'Pigeon', builtin: true, category: 'Animal', cr: '0',
    entity: { type: 'Neutral Beast', name: 'Pigeon', color: '#8e8e8e',
              hp: { current: 1, max: 1 }, ac: 11, speed: 10, initBonus: 1,
              stats: { str: 2, dex: 13, con: 8, int: 2, wis: 12, cha: 6 },
              role: 'city bird', passivePerception: 11,
              playerDescription: 'A scruffy grey pigeon, head bobbing.' } },
  { id: 'builtin:large_toad', name: 'Large Toad', builtin: true, category: 'Animal', cr: '1/4',
    entity: { type: 'Neutral Beast', name: 'Large Toad', color: '#5a7a3a',
              hp: { current: 11, max: 11 }, ac: 11, speed: 20, initBonus: 1,
              stats: { str: 12, dex: 13, con: 13, int: 2, wis: 10, cha: 3 },
              role: 'large toad', passivePerception: 10,
              darkvision: 30,
              playerDescription: 'A bloated, dinner-plate-sized toad, damp and staring.' } },
  { id: 'builtin:eagle', name: 'Eagle', builtin: true, category: 'Animal', cr: '0',
    entity: { type: 'Neutral Beast', name: 'Eagle', color: '#6a4a2a',
              hp: { current: 3, max: 3 }, ac: 12, speed: 10, initBonus: 2,
              stats: { str: 6, dex: 15, con: 10, int: 2, wis: 14, cha: 7 },
              role: 'raptor', passivePerception: 14,
              playerDescription: 'A sharp-eyed eagle, wings spread, circling high.' } },
  { id: 'builtin:boar', name: 'Boar', builtin: true, category: 'Animal', cr: '1/4',
    entity: { type: 'Neutral Beast', name: 'Boar', color: '#4a3a2a',
              hp: { current: 11, max: 11 }, ac: 11, speed: 40, initBonus: 0,
              stats: { str: 13, dex: 11, con: 12, int: 2, wis: 9, cha: 5 },
              role: 'boar', passivePerception: 9,
              playerDescription: 'A tusked wild boar, shaggy and furious.' } },
  { id: 'builtin:elk', name: 'Elk', builtin: true, category: 'Animal', cr: '1/4',
    entity: { type: 'Neutral Beast', name: 'Elk', color: '#6a4e2a',
              hp: { current: 13, max: 13 }, ac: 10, speed: 50, initBonus: 0,
              stats: { str: 16, dex: 10, con: 12, int: 2, wis: 10, cha: 6 },
              role: 'elk', passivePerception: 12,
              playerDescription: 'A tall elk, antlers crowning its head, eyes wary.' } },
  { id: 'builtin:horse', name: 'Horse', builtin: true, category: 'Animal', cr: '1/4',
    entity: { type: 'Neutral Beast', name: 'Horse', color: '#5a3a2a',
              hp: { current: 19, max: 19 }, ac: 10, speed: 60, initBonus: 0,
              stats: { str: 18, dex: 12, con: 13, int: 2, wis: 11, cha: 7 },
              role: 'riding horse', passivePerception: 10,
              playerDescription: 'A riding horse, broad-chested, breath misting in the morning air.' } },
  { id: 'builtin:chicken', name: 'Chicken', builtin: true, category: 'Animal', cr: '0',
    entity: { type: 'Neutral Beast', name: 'Chicken', color: '#c9a374',
              hp: { current: 1, max: 1 }, ac: 10, speed: 10, initBonus: 0,
              stats: { str: 2, dex: 10, con: 8, int: 2, wis: 10, cha: 4 },
              role: 'chicken', passivePerception: 10,
              playerDescription: 'A scrawny chicken, picking at the dirt.' } },
  { id: 'builtin:donkey', name: 'Donkey', builtin: true, category: 'Animal', cr: '1/8',
    entity: { type: 'Neutral Beast', name: 'Donkey', color: '#8b7355',
              hp: { current: 11, max: 11 }, ac: 10, speed: 40, initBonus: 0,
              stats: { str: 12, dex: 10, con: 11, int: 2, wis: 10, cha: 5 },
              role: 'donkey', passivePerception: 10,
              playerDescription: 'A patient donkey, head down, ears twitching at flies.' } },
  { id: 'builtin:mule', name: 'Mule', builtin: true, category: 'Animal', cr: '1/8',
    entity: { type: 'Neutral Beast', name: 'Mule', color: '#6a5a42',
              hp: { current: 13, max: 13 }, ac: 10, speed: 40, initBonus: 0,
              stats: { str: 14, dex: 10, con: 13, int: 2, wis: 10, cha: 5 },
              role: 'mule', passivePerception: 10,
              playerDescription: 'A sturdy mule, laden and unimpressed.' } },

  // ==========================================================
  // v5 #11 — BESTIARY: other
  // ==========================================================
  { id: 'builtin:slime', name: 'Slime', builtin: true, category: 'Ooze', cr: '1/2',
    entity: { type: 'Monster', name: 'Slime', color: '#5a8a5a',
              hp: { current: 22, max: 22 }, ac: 8, speed: 10, initBonus: -2,
              stats: { str: 12, dex: 6, con: 13, int: 1, wis: 6, cha: 1 },
              role: 'ooze', passivePerception: 8,
              darkvision: 60,
              playerDescription: 'A translucent, shuddering mass of acidic green.' } },
];

// ====================================================================
// UTILITIES
// ====================================================================
const uid = (prefix = '') => prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// v7 #9 / v7.2: dice roll utilities. Two shapes:
//
//   rollDice(die, qty, peerId, peerName)
//     — legacy single-die roll; returns an entry with a flat `dice`
//       array. Kept for backward compatibility with any call sites
//       that still use it.
//
//   rollDiceMixed(counts, peerId, peerName)
//     — v7.2 mixed-expression roll. `counts` is `{ 4: n, 6: n, ... }`
//       mapping die sides to quantity (0 or more, unlimited). Returns
//       an entry with a `groups` array (one per non-zero die type),
//       each containing `{ die, results: [...] }`, plus an
//       `expression` string ("4d6 + 2d8") and a `total`.
//
// Both entries sync through the same DICE_ROLL reducer which caps the
// log at 50. The renderer detects which shape by the presence of
// `groups` vs `dice`.
//
// Safety: clamps individual quantities at 100 and total dice at 200
// so a malicious or runaway client can't produce a 10,000-entry
// result that bloats the synced state.
function rollDice(die, qty, peerId, peerName) {
  const n = Math.max(1, Math.min(100, qty | 0));
  const sides = die | 0;
  const dice = [];
  for (let i = 0; i < n; i++) {
    dice.push({ die: sides, result: 1 + Math.floor(Math.random() * sides) });
  }
  const total = dice.reduce((s, d) => s + d.result, 0);
  return {
    id: uid('roll_'),
    ts: Date.now(),
    peerId,
    peerName: peerName || (peerId === 'dm' ? 'DM' : 'Player'),
    dice,
    total,
    expression: `${n}d${sides}`,
  };
}

const ALLOWED_DIE_SIDES = [4, 6, 8, 10, 12, 20];

function rollDiceMixed(counts, peerId, peerName) {
  const groups = [];
  let totalDice = 0;
  for (const s of ALLOWED_DIE_SIDES) {
    const q = Math.max(0, Math.min(100, (counts?.[s] | 0)));
    if (q <= 0) continue;
    if (totalDice + q > 200) break; // global safety cap
    const results = [];
    for (let i = 0; i < q; i++) {
      results.push(1 + Math.floor(Math.random() * s));
    }
    groups.push({ die: s, results });
    totalDice += q;
  }
  if (groups.length === 0) {
    // No dice requested — roll a single d20 as a convenience fallback
    // so a click on "Roll" with an empty tray still does something.
    groups.push({ die: 20, results: [1 + Math.floor(Math.random() * 20)] });
  }
  const total = groups.reduce(
    (s, g) => s + g.results.reduce((a, r) => a + r, 0), 0
  );
  const expression = groups
    .map(g => `${g.results.length}d${g.die}`)
    .join(' + ');
  return {
    id: uid('roll_'),
    ts: Date.now(),
    peerId,
    peerName: peerName || (peerId === 'dm' ? 'DM' : 'Player'),
    groups,
    total,
    expression,
  };
}

// v7 #7: Even-odd ray-cast point-in-polygon test. Used by both the
// block eraser hit-test and the polygon-cut commit logic. Module-level
// so it's available to all hooks regardless of declaration order.
function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    const intersect = (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// v7.1 #4: Polygon clipping for the freeform-polygon eraser.
// The v7 eraser deleted a block only if the entire block fell inside
// the cut polygon — not useful in practice. v7.1 implements a true
// polygon-difference (subtract) operation so partial overlaps are
// carved out of the block, leaving the remaining piece(s) intact.
//
// Strategy: convert every block shape to a polygon (rect → 4 pts,
// circle → 32 pts, poly → already one). Then compute subject - clip
// as an array of polygons using a line-by-line Sutherland–Hodgman
// approach that handles concave subjects via polygon splitting.
//
// This is not a full industrial CSG implementation — it handles the
// common case of drawing a cut across a wall well, and for overlapping
// or very concave shapes it degrades gracefully (may return the
// unclipped block rather than a malformed result). Good enough for
// a TTRPG VTT's eraser.
//
// Approach:
//   1. Clip the subject against each edge of the clip polygon
//      (Sutherland–Hodgman gives us subject ∩ clip).
//   2. For the difference we instead clip against the *reverse* of
//      each clip edge AND keep the outside half-plane.
//   3. Because the clip polygon may be concave, we subdivide it into
//      convex fans first.
//
// An even simpler, good-enough alternative is what we do here:
// APPROXIMATE THE DIFFERENCE BY RASTERIZING THE OVERLAP IN TILES.
// Way too coarse. Instead we use actual polygon math via the
// polygonClip library-free Greiner-Hormann-style routine below.

// Convert a block zone to a polygon (array of [x,y]).
function blockToPolygon(z) {
  if (z.type === 'poly' && Array.isArray(z.points) && z.points.length >= 3) {
    return z.points.map(p => [p[0], p[1]]);
  }
  if (z.type === 'circle' && typeof z.cx === 'number') {
    const pts = [];
    const N = 40;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      pts.push([z.cx + Math.cos(a) * z.r, z.cy + Math.sin(a) * z.r]);
    }
    return pts;
  }
  // Legacy rect
  return [
    [z.x, z.y],
    [z.x + z.w, z.y],
    [z.x + z.w, z.y + z.h],
    [z.x, z.y + z.h],
  ];
}

// Line-segment intersection used in fast-reject overlap testing.
function segIntersect(p1, p2, p3, p4) {
  const x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
  const x3 = p3[0], y3 = p3[1], x4 = p4[0], y4 = p4[1];
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1), t, u };
}

// Shoelace-area; positive if CCW.
function polyArea2(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return a / 2;
}

// Force CCW orientation (positive area).
function ensureCCW(pts) {
  return polyArea2(pts) < 0 ? [...pts].reverse() : pts.slice();
}

// Clip a polygon against a single half-plane: points are on the
// "inside" side of the directed edge (a → b) if cross product sign is
// positive (for CCW convention). Returns new polygon.
function clipAgainstHalfPlane(subject, a, b) {
  if (!subject.length) return [];
  const inside = (p) => {
    // Positive cross = left of edge = inside for CCW
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-9;
  };
  const intersect = (p, q) => {
    const rx = q[0] - p[0], ry = q[1] - p[1];
    const sx = b[0] - a[0], sy = b[1] - a[1];
    const denom = rx * sy - ry * sx;
    if (Math.abs(denom) < 1e-12) return p.slice();
    const t = ((a[0] - p[0]) * sy - (a[1] - p[1]) * sx) / denom;
    return [p[0] + t * rx, p[1] + t * ry];
  };
  const out = [];
  for (let i = 0; i < subject.length; i++) {
    const cur = subject[i];
    const prev = subject[(i - 1 + subject.length) % subject.length];
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur));
    }
  }
  return out;
}

// Subtract a CONVEX polygon B from a polygon A. Returns array of
// resulting polygons. For each edge of B (in CCW order), we clip A
// against the OUTSIDE half-plane of that edge, yielding one piece.
// The union of those N pieces is A - B.
//
// NOTE: the returned pieces can overlap each other — their union,
// not their sum, is the mathematically correct A − B. In practice
// for a VTT eraser this is fine: blocks occlude vision regardless of
// overlap, and users draw simple cuts that don't produce pathological
// overlap. Degenerate (near-zero-area) pieces are filtered out.
function subtractConvex(subject, clip) {
  const sub = ensureCCW(subject);
  const cl = ensureCCW(clip);
  const results = [];
  for (let i = 0; i < cl.length; i++) {
    const a = cl[i], b = cl[(i + 1) % cl.length];
    // Flip the edge direction to get the OUTSIDE half-plane
    const piece = clipAgainstHalfPlane(sub, b, a);
    if (piece.length >= 3 && Math.abs(polyArea2(piece)) > 0.5) {
      results.push(piece);
    }
  }
  return results;
}

// Ear-clipping triangulation of a simple polygon (CCW).
// Returns array of triangles (each a 3-vertex polygon).
function triangulate(pts) {
  const poly = ensureCCW(pts);
  const n = poly.length;
  if (n < 3) return [];
  if (n === 3) return [poly];
  const indices = poly.map((_, i) => i);
  const triangles = [];
  let safety = n * 3;
  while (indices.length > 3 && safety-- > 0) {
    let earFound = false;
    for (let i = 0; i < indices.length; i++) {
      const i0 = indices[(i - 1 + indices.length) % indices.length];
      const i1 = indices[i];
      const i2 = indices[(i + 1) % indices.length];
      const a = poly[i0], b = poly[i1], c = poly[i2];
      // Convex corner check (CCW)
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cross <= 0) continue;
      // No other vertex inside triangle abc
      let anyInside = false;
      for (let j = 0; j < indices.length; j++) {
        const ij = indices[j];
        if (ij === i0 || ij === i1 || ij === i2) continue;
        if (pointInPoly(poly[ij][0], poly[ij][1], [a, b, c])) {
          anyInside = true; break;
        }
      }
      if (anyInside) continue;
      triangles.push([a, b, c]);
      indices.splice(i, 1);
      earFound = true;
      break;
    }
    if (!earFound) break; // degenerate; bail
  }
  if (indices.length === 3) {
    triangles.push([poly[indices[0]], poly[indices[1]], poly[indices[2]]]);
  }
  return triangles;
}

// Subtract an arbitrary (possibly concave) polygon B from A.
// Triangulate B, then subtract each triangle from all remaining pieces
// in sequence. Since triangles are convex, subtractConvex is correct.
function polygonSubtract(subject, clip) {
  if (!subject || subject.length < 3 || !clip || clip.length < 3) return [subject];

  // Exact-match check: identical polygons → empty result.
  // Handles the common case where the user draws a cut over the whole
  // block, which otherwise hits pointInPoly edge cases and degenerates.
  if (subject.length === clip.length) {
    let allSame = true;
    for (let i = 0; i < subject.length; i++) {
      if (Math.abs(subject[i][0] - clip[i][0]) > 1e-4 ||
          Math.abs(subject[i][1] - clip[i][1]) > 1e-4) { allSame = false; break; }
    }
    if (allSame) return [];
  }

  // Fast reject: no overlap → return subject
  let anyCross = false, anySubjectInClip = false;
  for (const p of subject) {
    if (pointInPoly(p[0], p[1], clip)) { anySubjectInClip = true; break; }
  }
  outer:
  for (let i = 0; i < subject.length; i++) {
    const a = subject[i], b = subject[(i + 1) % subject.length];
    for (let j = 0; j < clip.length; j++) {
      const c = clip[j], d = clip[(j + 1) % clip.length];
      if (segIntersect(a, b, c, d)) { anyCross = true; break outer; }
    }
  }
  if (!anySubjectInClip && !anyCross) return [subject];
  // Full containment check
  if (!anyCross) {
    const allIn = subject.every(p => pointInPoly(p[0], p[1], clip));
    if (allIn) return [];
  }
  const triangles = triangulate(clip);
  if (triangles.length === 0) return [subject];
  // Iterative subtraction: start with [subject], subtract each triangle
  const originalArea = Math.abs(polyArea2(subject));
  let pieces = [ensureCCW(subject)];
  for (const tri of triangles) {
    const next = [];
    for (const piece of pieces) {
      const diff = subtractConvex(piece, tri);
      for (const d of diff) if (d.length >= 3 && Math.abs(polyArea2(d)) > 0.5) next.push(d);
    }
    pieces = next;
    if (pieces.length === 0) break;
    // Safety: if pieces are exploding exponentially, bail to
    // "delete the whole block" to avoid pathological geometry.
    if (pieces.length > 64) {
      // Too many shards → treat cut as complete removal
      return [];
    }
  }
  // Sanity check: if final total area is nearly identical to original,
  // the cut didn't actually carve anything meaningful (e.g. cut
  // polygon is concave in a way our simple half-plane algorithm
  // mishandles). Fall back to "delete the block" if the cut visibly
  // overlaps the block's bounding box — it's better to delete a block
  // the user aimed at than to leave it unchanged.
  if (pieces.length > 0) {
    const totalArea = pieces.reduce((s, p) => s + Math.abs(polyArea2(p)), 0);
    if (Math.abs(totalArea - originalArea) < 0.5) {
      // Bounding-box overlap test
      let sxMin = Infinity, syMin = Infinity, sxMax = -Infinity, syMax = -Infinity;
      for (const p of subject) {
        if (p[0] < sxMin) sxMin = p[0]; if (p[0] > sxMax) sxMax = p[0];
        if (p[1] < syMin) syMin = p[1]; if (p[1] > syMax) syMax = p[1];
      }
      let cxMin = Infinity, cyMin = Infinity, cxMax = -Infinity, cyMax = -Infinity;
      for (const p of clip) {
        if (p[0] < cxMin) cxMin = p[0]; if (p[0] > cxMax) cxMax = p[0];
        if (p[1] < cyMin) cyMin = p[1]; if (p[1] > cyMax) cyMax = p[1];
      }
      const bboxOverlap = !(cxMax < sxMin || cxMin > sxMax || cyMax < syMin || cyMin > syMax);
      if (bboxOverlap) {
        // Concave cut covers subject → treat as a full delete
        // so the user sees a result instead of "nothing happened".
        return [];
      }
    }
  }
  return pieces;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const roll = (sides) => 1 + Math.floor(Math.random() * sides);
const modFor = (stat) => Math.floor((stat - 10) / 2);

const deepClone = (obj) => structuredClone(obj);

const downloadJson = (data, filename) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
};

// Pick a file from disk. `accept` controls the file filter (e.g. 'application/json' or 'image/*').
// `readAs` controls how the FileReader reads it: 'text' returns { file, content: string };
// 'dataUrl' returns the data URL string directly.
function pickFile(accept, readAs = 'text') {
  return new Promise((res) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return res(null);
      const reader = new FileReader();
      if (readAs === 'dataUrl') {
        reader.onload = () => res(reader.result);
        reader.readAsDataURL(file);
      } else {
        reader.onload = () => res({ file, content: reader.result });
        reader.readAsText(file);
      }
    };
    input.click();
  });
}

const pickImage = () => pickFile('image/*', 'dataUrl');

// ====================================================================
// DEFAULT STATE
// ====================================================================
const makeDefaultState = () => {
  const mapId = uid('map_');
  return {
    entities: {},
    maps: {
      [mapId]: {
        id: mapId,
        name: 'The World',
        type: 'world',
        parentId: null,
        imageUrl: null,
        notes: '',
        viewport: { x: 0, y: 0, zoom: 1 }
      }
    },
    tokens: {},
    initiative: { active: false, entries: [], turn: 0, round: 1 },
    presets: {},
    currentMapId: mapId,
    forcedView: null,            // legacy (global push-view) — kept for back-compat
    forcedViewPerPeer: {},       // v3: per-peer push (peerId -> { mapId })
    playerMapOverride: null,     // player-chosen map when not forced
    claims: {},                  // v2 claim record
    entityOrder: [],
    reminders: {},               // per-user private reminder tokens
    mapScale: 1.0,               // global DM-controlled scale
    // v3 additions:
    timeOfDay: 0,                // 0 = bright day, 1 = deep night; smooth scalar
    blockZones: {},              // mapId -> [{id, x, y, w, h}]
    tokenPresets: {},            // DM-defined presets keyed by id: { id, name, entity: partial }
    // v6 #10: drawings — per-map shared overlay. {mapId: [drawing, ...]}
    //   freehand: {id, type:'freehand', points:[[x,y],...], color, width, owner}
    //   line    : {id, type:'line', x0,y0,x1,y1, color, width, owner}
    //   circle  : {id, type:'circle', cx,cy,r, color, width, owner}
    drawings: {},
    // v6 #9: hazard polygons — {mapId: [hazard, ...]}
    //   {id, type:'polygon', hazardKind:'fire|flood|cold|acid|fog|difficult',
    //    points:[[x,y],...], visible:true|false, label?}
    hazards: {},
    // v7 #9: shared dice rolls. Capped at 50 most-recent entries.
    //   {id, ts, peerName, peerId, dice:[{die:6, result:4}, ...], total}
    diceLog: [],
    // v7 #10: DM-controlled sound playback events. The sounds themselves
    // live in IDB (sounds store); this array holds metadata + play events.
    //   sounds: { [id]: { id, name, ts } }  — registry (no audio bytes)
    //   soundEvents: [{ id, soundId, ts, action: 'play' | 'stop' }, ...]
    sounds: {},
    soundEvents: [],
    // v7.3: Token groups. DM creates named groups of placed tokens (by
    // tokenId) and can hide/reveal the whole group with one click.
    // Groups are SCOPED to a specific map — a group lives where its
    // tokens live. Moving a token to another map doesn't drag the
    // group membership with it; the DM intentionally regroups.
    //   tokenGroups: { [groupId]: {
    //     id,
    //     mapId,          // map this group belongs to
    //     name,           // user-visible label
    //     memberIds: [],  // tokenIds on that map
    //     notes?,
    //     createdTs,
    //   } }
    tokenGroups: {},
  };
};

const makeEntity = (overrides = {}) => ({
  id: uid('ent_'),
  name: 'Unnamed',
  type: 'PC',
  color: DEFAULT_COLORS['PC'],
  ac: 10,
  hp: { current: 10, max: 10 },
  speed: 30,
  initBonus: 0,
  passivePerception: 10,
  conditions: [],
  notes: '',
  playerDescription: '',
  imageUrl: null,
  sickness: 0,
  stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  class: '', level: 1, playerName: '',
  cr: '1/4', abilities: '',
  faction: '', role: '',
  rollsInitiative: true,
  // v3 additions:
  darkvision: 0,               // feet; 0 = none
  lightRadius: 0,              // feet; 0 = no light carried
  // Bonded familiars:
  //  - bondedPeerId (v3, legacy): direct peer-id bond (fragile on reconnect)
  //  - bondedPcId (v5): bond to a PC entity id; whoever claims that PC
  //    automatically gets movement rights. Preferred going forward.
  bondedPeerId: null,
  bondedPcId: null,
  // Death save tracking (DM-only). PCs only in practice.
  deathSaves: { successes: 0, failures: 0 },
  ...overrides,
});

// Reminder tokens are per-user and live outside the synced token model.
const makeReminder = (overrides = {}) => ({
  id: uid('rem_'),
  mapId: null,
  x: 0, y: 0,
  label: '',
  color: '#c9a34a',
  ...overrides,
});

// v3: block zones — DM-drawn rectangles that hide a portion of the map from
// players. Overlaid in screen space on the player map render. Also
// participates in the vision system as a line-of-sight blocker.
const makeBlockZone = (overrides = {}) => ({
  id: uid('blk_'),
  x: 0, y: 0, w: 100, h: 100,
  ...overrides,
});

// ====================================================================
// STATE MIGRATION (keeps older saved sessions forward-compatible)
// ====================================================================
function migrateState(raw) {
  if (!raw || typeof raw !== 'object') return makeDefaultState();
  const state = { ...raw };

  // Ensure entities object
  state.entities = state.entities || {};

  // Backfill missing fields on every entity. Spread order: existing values win.
  const entities = {};
  for (const [id, e] of Object.entries(state.entities)) {
    entities[id] = {
      playerDescription: '',
      imageUrl: null,
      sickness: 0,
      rollsInitiative: true,
      darkvision: 0,
      lightRadius: 0,
      bondedPeerId: null,
      bondedPcId: null,
      deathSaves: { successes: 0, failures: 0 },
      ...e,
    };
    // deathSaves might exist but be malformed
    const ds = entities[id].deathSaves;
    if (!ds || typeof ds !== 'object') {
      entities[id].deathSaves = { successes: 0, failures: 0 };
    }
  }
  state.entities = entities;

  // Build/repair entityOrder — must contain every current entity id exactly once
  const existingIds = Object.keys(state.entities);
  const prevOrder = Array.isArray(state.entityOrder) ? state.entityOrder : [];
  const seen = new Set();
  const orderedIds = [];
  for (const id of prevOrder) {
    if (state.entities[id] && !seen.has(id)) {
      orderedIds.push(id);
      seen.add(id);
    }
  }
  // Append any new entities not yet in order (alphabetical fallback)
  const missing = existingIds
    .filter(id => !seen.has(id))
    .sort((a, b) => (state.entities[a].name || '').localeCompare(state.entities[b].name || ''));
  state.entityOrder = [...orderedIds, ...missing];

  // Ensure other expected top-level keys
  state.tokens = state.tokens || {};
  state.maps = state.maps || {};
  state.presets = state.presets || {};
  state.initiative = state.initiative || { active: false, entries: [], turn: 0, round: 1 };
  if (state.forcedView === undefined) state.forcedView = null;
  if (state.playerMapOverride === undefined) state.playerMapOverride = null;
  if (typeof state.mapScale !== 'number' || !isFinite(state.mapScale) || state.mapScale <= 0) state.mapScale = 1.0;
  state.reminders = state.reminders && typeof state.reminders === 'object' ? state.reminders : {};
  // v3 additions
  if (typeof state.timeOfDay !== 'number' || !isFinite(state.timeOfDay)) state.timeOfDay = 0;
  state.timeOfDay = clamp(state.timeOfDay, 0, 1);
  state.forcedViewPerPeer = state.forcedViewPerPeer && typeof state.forcedViewPerPeer === 'object' ? state.forcedViewPerPeer : {};
  state.blockZones = state.blockZones && typeof state.blockZones === 'object' ? state.blockZones : {};
  // v6: drawings and hazards — both keyed by mapId, arrays of shapes.
  state.drawings = state.drawings && typeof state.drawings === 'object' ? state.drawings : {};
  state.hazards = state.hazards && typeof state.hazards === 'object' ? state.hazards : {};
  // v7: dice + sounds backfills
  state.diceLog = Array.isArray(state.diceLog) ? state.diceLog : [];
  state.sounds = state.sounds && typeof state.sounds === 'object' ? state.sounds : {};
  state.soundEvents = Array.isArray(state.soundEvents) ? state.soundEvents : [];
  // v7.3: token groups. Sanitize: group must have id, mapId, name,
  // and a memberIds array. Prune references to tokens that no longer
  // exist on this map.
  {
    const cleanGroups = {};
    const incoming = (state.tokenGroups && typeof state.tokenGroups === 'object')
      ? state.tokenGroups : {};
    for (const [id, g] of Object.entries(incoming)) {
      if (!g || typeof g !== 'object') continue;
      if (!g.id || !g.mapId || typeof g.name !== 'string') continue;
      const validMembers = Array.isArray(g.memberIds)
        ? g.memberIds.filter(tid => {
            const t = state.tokens?.[tid];
            return t && t.mapId === g.mapId;
          })
        : [];
      cleanGroups[id] = {
        id: g.id,
        mapId: g.mapId,
        name: g.name.slice(0, 80),
        memberIds: validMembers,
        notes: typeof g.notes === 'string' ? g.notes.slice(0, 400) : '',
        createdTs: g.createdTs || Date.now(),
      };
    }
    state.tokenGroups = cleanGroups;
  }
  state.tokenPresets = state.tokenPresets && typeof state.tokenPresets === 'object' ? state.tokenPresets : {};

  // v2 claim model migration: `claimedPCs` (peerId -> entityId) becomes
  // `claims` (peerId -> { pc, familiars, playerName, spectator }).
  if (!state.claims || typeof state.claims !== 'object') state.claims = {};
  if (state.claimedPCs && typeof state.claimedPCs === 'object') {
    for (const [peerId, entId] of Object.entries(state.claimedPCs)) {
      if (!state.claims[peerId]) {
        state.claims[peerId] = { pc: entId || null, familiars: [], playerName: '', spectator: false };
      } else if (!state.claims[peerId].pc) {
        state.claims[peerId].pc = entId || null;
      }
    }
  }
  // Normalize every claim record so downstream code can trust its shape.
  const normalizedClaims = {};
  for (const [peerId, claim] of Object.entries(state.claims)) {
    const c = claim && typeof claim === 'object' ? claim : {};
    normalizedClaims[peerId] = {
      pc: c.pc || null,
      familiars: Array.isArray(c.familiars) ? c.familiars.filter(id => state.entities[id]) : [],
      playerName: typeof c.playerName === 'string' ? c.playerName : '',
      spectator: !!c.spectator,
      // v4 fix #7: preserve stable per-device identity on the claim
      playerId: typeof c.playerId === 'string' ? c.playerId : null,
    };
  }
  state.claims = normalizedClaims;
  delete state.claimedPCs; // stop storing the legacy shape

  // Ensure every token has visibility + scale
  const tokens = {};
  for (const [id, t] of Object.entries(state.tokens)) {
    tokens[id] = { visible: false, scale: 1.0, ...t };
    if (typeof tokens[id].scale !== 'number' || !isFinite(tokens[id].scale) || tokens[id].scale <= 0) {
      tokens[id].scale = 1.0;
    }
  }
  state.tokens = tokens;

  return state;
}

// ====================================================================
// STATE REDUCER
// ====================================================================
function reducer(state, action) {
  switch (action.type) {
    case 'HYDRATE': return action.state || state;
    case 'REPLACE': {
      // v7.2: the player receives broadcasts with imageUrl stripped to
      // IMG_SENTINEL. If we have hydrated bytes for a map locally
      // (from an earlier map_image envelope or IDB cache), we preserve
      // them instead of replacing with the sentinel marker. This is
      // what makes the map layer continue rendering after every
      // subsequent state_update.
      const incoming = action.payload || {};
      const currentMaps = state.maps || {};
      const incomingMaps = incoming.maps || {};
      const mergedMaps = {};
      for (const [id, m] of Object.entries(incomingMaps)) {
        if (m?.imageUrl === IMG_SENTINEL && currentMaps[id]?.imageUrl
            && currentMaps[id].imageUrl !== IMG_SENTINEL) {
          mergedMaps[id] = { ...m, imageUrl: currentMaps[id].imageUrl };
        } else {
          mergedMaps[id] = m;
        }
      }
      return migrateState({ ...incoming, maps: mergedMaps });
    }

    // v7.2: map image bytes arrived via map_image envelope — merge into
    // the named map slot. Dispatched by Session on receipt of a
    // map_image from the DM.
    case 'MAP_IMAGE_RECEIVED': {
      const m = state.maps?.[action.mapId];
      if (!m) return state;
      return {
        ...state,
        maps: { ...state.maps, [action.mapId]: { ...m, imageUrl: action.dataUrl } },
      };
    }

    // v7.2: ephemeral token move. Updates just this one token's
    // coordinates without any of the full-state side effects. Used by
    // players to render remote drag motion in real time without
    // waiting for the debounced state_update.
    case 'TOKEN_MOVE_EPHEMERAL': {
      const t = state.tokens?.[action.tokenId];
      if (!t) return state;
      if (action.mapId && t.mapId !== action.mapId) return state;
      return {
        ...state,
        tokens: { ...state.tokens, [action.tokenId]: { ...t, x: action.x, y: action.y } },
      };
    }

    // Entities
    case 'ENTITY_UPSERT': {
      const isNew = !state.entities[action.entity.id];
      const entities = { ...state.entities, [action.entity.id]: action.entity };
      const entityOrder = isNew
        ? [...(state.entityOrder || []), action.entity.id]
        : (state.entityOrder || []);
      return { ...state, entities, entityOrder };
    }
    case 'ENTITY_DELETE': {
      const { [action.id]: _removed, ...rest } = state.entities;
      const tokens = Object.fromEntries(Object.entries(state.tokens).filter(([_, t]) => t.entityId !== action.id));
      const initEntries = state.initiative.entries.filter(e => e.entityId !== action.id);
      // Clear this entity from every peer's claim (pc and familiars)
      const claims = {};
      for (const [peerId, c] of Object.entries(state.claims || {})) {
        claims[peerId] = {
          ...c,
          pc: c.pc === action.id ? null : c.pc,
          familiars: (c.familiars || []).filter(fid => fid !== action.id),
        };
      }
      const entityOrder = (state.entityOrder || []).filter(id => id !== action.id);
      return {
        ...state,
        entities: rest,
        tokens,
        initiative: { ...state.initiative, entries: initEntries },
        claims,
        entityOrder,
      };
    }
    case 'ENTITY_REORDER': {
      // action.order: array of entity ids (DM's new explicit ordering)
      // Re-sync with current entities to avoid ghosts
      const existing = new Set(Object.keys(state.entities));
      const seen = new Set();
      const next = [];
      for (const id of action.order) {
        if (existing.has(id) && !seen.has(id)) { next.push(id); seen.add(id); }
      }
      // Append any entities not yet in order (safety)
      for (const id of Object.keys(state.entities)) {
        if (!seen.has(id)) next.push(id);
      }
      return { ...state, entityOrder: next };
    }
    case 'ENTITY_HP_ADJUST': {
      const e = state.entities[action.id];
      if (!e) return state;
      const cur = clamp(e.hp.current + action.delta, 0, e.hp.max);
      const updated = { ...e, hp: { ...e.hp, current: cur } };
      if (cur === 0) {
        // v4 fix #17: PCs go Unconscious (so they can roll death saves).
        // v5 fix #9: Objects get "Broken", not "Dead" — they aren't alive.
        // Everything else (Monster, NPC, Familiar, Neutral Beast) goes Dead.
        let targetCond;
        if (e.type === 'PC') targetCond = 'Unconscious';
        else if (e.type === 'Object') targetCond = 'Broken';
        else targetCond = 'Dead';
        if (!updated.conditions.includes(targetCond)) {
          updated.conditions = [...updated.conditions, targetCond];
        }
      } else {
        // Healed back above 0 — clear auto-applied status so repair or
        // healing just works. Unconscious stays unless explicitly cleared,
        // matching D&D RAW.
        if (updated.conditions.includes('Dead')) {
          updated.conditions = updated.conditions.filter(c => c !== 'Dead');
        }
        if (updated.conditions.includes('Broken')) {
          updated.conditions = updated.conditions.filter(c => c !== 'Broken');
        }
      }
      return { ...state, entities: { ...state.entities, [action.id]: updated } };
    }
    case 'ENTITY_TOGGLE_CONDITION': {
      const e = state.entities[action.id];
      if (!e) return state;
      const has = e.conditions.includes(action.condition);
      return {
        ...state,
        entities: {
          ...state.entities,
          [action.id]: {
            ...e,
            conditions: has
              ? e.conditions.filter(c => c !== action.condition)
              : [...e.conditions, action.condition]
          }
        }
      };
    }

    // Maps
    case 'MAP_UPSERT':
      return { ...state, maps: { ...state.maps, [action.map.id]: action.map } };
    case 'MAP_DELETE': {
      if (Object.keys(state.maps).length <= 1) return state;
      const { [action.id]: _r, ...rest } = state.maps;
      const tokens = Object.fromEntries(Object.entries(state.tokens).filter(([_, t]) => t.mapId !== action.id));
      let currentMapId = state.currentMapId;
      if (currentMapId === action.id) currentMapId = Object.keys(rest)[0];
      // reparent children
      const maps = Object.fromEntries(Object.entries(rest).map(([k, v]) => [
        k, v.parentId === action.id ? { ...v, parentId: null } : v
      ]));
      return { ...state, maps, tokens, currentMapId };
    }
    case 'MAP_SWITCH':
      return { ...state, currentMapId: action.id };
    case 'MAP_VIEWPORT':
      return {
        ...state,
        maps: {
          ...state.maps,
          [action.id]: { ...state.maps[action.id], viewport: action.viewport }
        }
      };

    // Tokens
    case 'TOKEN_PLACE': {
      // prevent duplicate placement per map per entity
      const existing = Object.values(state.tokens).find(
        t => t.entityId === action.token.entityId && t.mapId === action.token.mapId
      );
      if (existing) return state;
      return { ...state, tokens: { ...state.tokens, [action.token.id]: action.token } };
    }
    case 'TOKEN_MOVE': {
      const t = state.tokens[action.id];
      if (!t) return state;
      return { ...state, tokens: { ...state.tokens, [action.id]: { ...t, x: action.x, y: action.y } } };
    }
    // v6 #12: batched token move for group-drag. Takes an array of
    // { id, x, y } moves, applies them all atomically so persist and
    // sync broadcast run once.
    case 'TOKEN_MOVE_MANY': {
      const moves = action.moves || [];
      if (!moves.length) return state;
      const tokens = { ...state.tokens };
      for (const m of moves) {
        const t = tokens[m.id];
        if (!t) continue;
        tokens[m.id] = { ...t, x: m.x, y: m.y };
      }
      return { ...state, tokens };
    }
    case 'TOKEN_REMOVE': {
      const { [action.id]: _r, ...rest } = state.tokens;
      // v7.3: prune this tokenId from any group that listed it.
      // Keeps groups tidy without needing a separate sweep.
      let groups = state.tokenGroups;
      if (groups && typeof groups === 'object') {
        let groupsChanged = false;
        const nextGroups = {};
        for (const [gid, g] of Object.entries(groups)) {
          if ((g.memberIds || []).includes(action.id)) {
            nextGroups[gid] = { ...g, memberIds: g.memberIds.filter(x => x !== action.id) };
            groupsChanged = true;
          } else {
            nextGroups[gid] = g;
          }
        }
        if (groupsChanged) groups = nextGroups;
      }
      return { ...state, tokens: rest, tokenGroups: groups };
    }
    case 'TOKEN_VISIBILITY': {
      const t = state.tokens[action.id];
      if (!t) return state;
      return { ...state, tokens: { ...state.tokens, [action.id]: { ...t, visible: action.visible } } };
    }
    case 'TOKEN_REVEAL_ALL_ON_MAP': {
      const tokens = Object.fromEntries(Object.entries(state.tokens).map(([k, t]) => [
        k, t.mapId === action.mapId ? { ...t, visible: action.visible } : t
      ]));
      return { ...state, tokens };
    }

    // Initiative
    case 'INIT_SET': return { ...state, initiative: action.initiative };
    case 'INIT_ADVANCE': {
      const { entries } = state.initiative;
      if (!entries.length) return state;
      const nextTurn = (state.initiative.turn + 1) % entries.length;
      const round = nextTurn === 0 ? state.initiative.round + 1 : state.initiative.round;
      return { ...state, initiative: { ...state.initiative, turn: nextTurn, round } };
    }

    // Presets
    case 'PRESET_SAVE':
      return { ...state, presets: { ...state.presets, [action.preset.id]: action.preset } };
    case 'PRESET_DELETE': {
      const { [action.id]: _r, ...rest } = state.presets;
      return { ...state, presets: rest };
    }

    // Forced view
    case 'FORCED_VIEW': return { ...state, forcedView: action.forcedView };

    // Player map override
    case 'PLAYER_MAP_OVERRIDE': return { ...state, playerMapOverride: action.mapId };

    // v2: unified claim model
    case 'CLAIM_PC': {
      // Atomic: any other peer that claims this PC loses it first.
      const nextClaims = {};
      for (const [p, c] of Object.entries(state.claims)) {
        nextClaims[p] = (p !== action.peerId && c.pc === action.entityId)
          ? { ...c, pc: null }
          : c;
      }
      const prev = nextClaims[action.peerId] || { pc: null, familiars: [], playerName: '', spectator: false };
      nextClaims[action.peerId] = {
        ...prev,
        pc: action.entityId,
        playerName: action.playerName || prev.playerName || '',
        spectator: false,
      };
      return { ...state, claims: nextClaims };
    }
    case 'UNCLAIM_PC': {
      const prev = state.claims[action.peerId];
      if (!prev) return state;
      return {
        ...state,
        claims: { ...state.claims, [action.peerId]: { ...prev, pc: null } }
      };
    }
    case 'DM_UNCLAIM_PC': {
      // DM-initiated removal of a claim. Scans every peer and clears matching PC.
      const nextClaims = {};
      for (const [p, c] of Object.entries(state.claims)) {
        nextClaims[p] = c.pc === action.entityId ? { ...c, pc: null } : c;
      }
      return { ...state, claims: nextClaims };
    }
    case 'CLAIM_FAMILIAR': {
      // Familiars can be claimed by multiple peers? No — one peer per familiar,
      // but a single peer can claim multiple familiars. Transfer semantics.
      const nextClaims = {};
      for (const [p, c] of Object.entries(state.claims)) {
        nextClaims[p] = (p !== action.peerId && c.familiars.includes(action.entityId))
          ? { ...c, familiars: c.familiars.filter(id => id !== action.entityId) }
          : c;
      }
      const prev = nextClaims[action.peerId] || { pc: null, familiars: [], playerName: '', spectator: false };
      const nextFamiliars = prev.familiars.includes(action.entityId)
        ? prev.familiars
        : [...prev.familiars, action.entityId];
      nextClaims[action.peerId] = { ...prev, familiars: nextFamiliars, spectator: false };
      return { ...state, claims: nextClaims };
    }
    case 'UNCLAIM_FAMILIAR': {
      const prev = state.claims[action.peerId];
      if (!prev) return state;
      return {
        ...state,
        claims: {
          ...state.claims,
          [action.peerId]: { ...prev, familiars: prev.familiars.filter(id => id !== action.entityId) }
        }
      };
    }
    case 'DM_UNCLAIM_FAMILIAR': {
      const nextClaims = {};
      for (const [p, c] of Object.entries(state.claims)) {
        nextClaims[p] = c.familiars.includes(action.entityId)
          ? { ...c, familiars: c.familiars.filter(id => id !== action.entityId) }
          : c;
      }
      return { ...state, claims: nextClaims };
    }
    case 'CLAIM_SPECTATOR': {
      const prev = state.claims[action.peerId] || { pc: null, familiars: [], playerName: '', spectator: false };
      return {
        ...state,
        claims: {
          ...state.claims,
          [action.peerId]: { ...prev, spectator: true, pc: null, familiars: [], playerName: action.playerName || prev.playerName }
        }
      };
    }
    case 'SET_PLAYER_NAME': {
      const prev = state.claims[action.peerId] || { pc: null, familiars: [], playerName: '', spectator: false };
      return {
        ...state,
        claims: { ...state.claims, [action.peerId]: { ...prev, playerName: action.playerName || '' } }
      };
    }

    // v2: Sickness (DM-only write path, enforced at action sites not reducer)
    case 'SET_SICKNESS': {
      const e = state.entities[action.id];
      if (!e) return state;
      const lvl = clamp(Number(action.level) || 0, 0, 3);
      return { ...state, entities: { ...state.entities, [action.id]: { ...e, sickness: lvl } } };
    }

    // v2: Token scale
    case 'TOKEN_SCALE': {
      const t = state.tokens[action.id];
      if (!t) return state;
      const s = clamp(Number(action.scale) || 1, 0.3, 4);
      return { ...state, tokens: { ...state.tokens, [action.id]: { ...t, scale: s } } };
    }

    // v2: global map-vs-token scale
    case 'MAP_SCALE_SET': {
      const s = clamp(Number(action.scale) || 1, 0.3, 3);
      return { ...state, mapScale: s };
    }

    // v2: reminder tokens (per-peer, DM treated as a peer too via its own key)
    case 'REMINDER_UPSERT': {
      const peerId = action.peerId;
      const list = state.reminders[peerId] || [];
      const idx = list.findIndex(r => r.id === action.reminder.id);
      const nextList = idx === -1 ? [...list, action.reminder] : list.map(r => r.id === action.reminder.id ? action.reminder : r);
      return { ...state, reminders: { ...state.reminders, [peerId]: nextList } };
    }
    case 'REMINDER_DELETE': {
      const peerId = action.peerId;
      const list = state.reminders[peerId] || [];
      return { ...state, reminders: { ...state.reminders, [peerId]: list.filter(r => r.id !== action.id) } };
    }

    // v3: generic safe patch on an entity (whitelist enforced at the
    // ACTION site, not here — reducer just applies the given field set).
    case 'ENTITY_PATCH': {
      const e = state.entities[action.id];
      if (!e) return state;
      const patch = action.patch || {};
      // Deep-merge hp and stats when partially specified
      const next = { ...e, ...patch };
      if (patch.hp) next.hp = { ...e.hp, ...patch.hp };
      if (patch.stats) next.stats = { ...e.stats, ...patch.stats };
      if (patch.deathSaves) next.deathSaves = { ...e.deathSaves, ...patch.deathSaves };
      // Re-clamp hp.current to [0, hp.max] if either changed
      if (patch.hp || patch.hp === 0) {
        next.hp.current = clamp(next.hp.current || 0, 0, next.hp.max || 0);
      }
      return { ...state, entities: { ...state.entities, [action.id]: next } };
    }

    // v3: death save counters (DM-only writes; action-site enforced)
    case 'DEATH_SAVE_SET': {
      const e = state.entities[action.id];
      if (!e) return state;
      const ds = {
        successes: clamp(Number(action.successes ?? e.deathSaves.successes), 0, 3),
        failures:  clamp(Number(action.failures  ?? e.deathSaves.failures),  0, 3),
      };
      return { ...state, entities: { ...state.entities, [action.id]: { ...e, deathSaves: ds } } };
    }
    case 'DEATH_SAVE_CLEAR': {
      const e = state.entities[action.id];
      if (!e) return state;
      return { ...state, entities: { ...state.entities, [action.id]: { ...e, deathSaves: { successes: 0, failures: 0 } } } };
    }

    // v3: Long rest — restore HP to max for target entities, clear specific
    // recoverable conditions, reset sickness to 0, reset death saves.
    case 'LONG_REST': {
      // action.entityIds may be an array (rest these specific ones) or
      // omitted (rest all PCs + Familiars).
      const targetIds = Array.isArray(action.entityIds)
        ? action.entityIds
        : Object.values(state.entities).filter(e => e.type === 'PC' || e.type === 'Familiar').map(e => e.id);
      const CLEARED = new Set(['Unconscious','Exhausted','Poisoned','Frightened','Blinded','Deafened','Charmed','Stunned','Paralyzed','Prone','Restrained','Incapacitated','Grappled']);
      const entities = { ...state.entities };
      for (const id of targetIds) {
        const e = entities[id];
        if (!e) continue;
        // v7 fix #8: Long rest no longer resets sickness. Sickness is a
        // long-arc condition that the DM controls explicitly via the
        // sickness controls in the World panel — a night's rest doesn't
        // clear it.
        entities[id] = {
          ...e,
          hp: { ...e.hp, current: e.hp.max },
          conditions: e.conditions.filter(c => !CLEARED.has(c)),
          deathSaves: { successes: 0, failures: 0 },
        };
      }
      return { ...state, entities };
    }

    // v3: Time of day (scalar, 0=day, 1=deep night)
    case 'TIME_OF_DAY_SET':
      return { ...state, timeOfDay: clamp(Number(action.value) || 0, 0, 1) };

    // v3: Per-peer push-view. Works alongside legacy global `forcedView`.
    case 'FORCED_VIEW_PEER_SET': {
      const next = { ...(state.forcedViewPerPeer || {}) };
      if (action.mapId == null) delete next[action.peerId];
      else next[action.peerId] = { mapId: action.mapId };
      return { ...state, forcedViewPerPeer: next };
    }
    case 'FORCED_VIEW_PEER_CLEAR_ALL':
      return { ...state, forcedViewPerPeer: {} };

    // v3: Block zones per map
    case 'BLOCK_ZONE_UPSERT': {
      const mapId = action.mapId;
      const list = state.blockZones[mapId] || [];
      const idx = list.findIndex(z => z.id === action.zone.id);
      const next = idx === -1 ? [...list, action.zone] : list.map(z => z.id === action.zone.id ? action.zone : z);
      return { ...state, blockZones: { ...state.blockZones, [mapId]: next } };
    }
    case 'BLOCK_ZONE_DELETE': {
      const mapId = action.mapId;
      const list = state.blockZones[mapId] || [];
      return { ...state, blockZones: { ...state.blockZones, [mapId]: list.filter(z => z.id !== action.id) } };
    }
    case 'BLOCK_ZONE_CLEAR_MAP':
      return { ...state, blockZones: { ...state.blockZones, [action.mapId]: [] } };

    // v6 #10: Drawing overlays — freehand + line + circle.
    //   DRAWING_UPSERT: add or replace a drawing on a map
    //   DRAWING_DELETE: remove one by id
    //   DRAWING_CLEAR_MAP: wipe all drawings on a map
    //   DRAWING_CLEAR_OWNER: wipe all drawings by one owner on a map
    case 'DRAWING_UPSERT': {
      const { mapId, drawing } = action;
      if (!mapId || !drawing?.id) return state;
      const list = state.drawings?.[mapId] || [];
      const i = list.findIndex(d => d.id === drawing.id);
      const next = i === -1 ? [...list, drawing] : list.map(d => d.id === drawing.id ? drawing : d);
      return { ...state, drawings: { ...(state.drawings || {}), [mapId]: next } };
    }
    case 'DRAWING_DELETE': {
      const { mapId, id } = action;
      const list = state.drawings?.[mapId] || [];
      return { ...state, drawings: { ...(state.drawings || {}), [mapId]: list.filter(d => d.id !== id) } };
    }
    case 'DRAWING_CLEAR_MAP':
      return { ...state, drawings: { ...(state.drawings || {}), [action.mapId]: [] } };
    case 'DRAWING_CLEAR_OWNER': {
      const list = state.drawings?.[action.mapId] || [];
      return { ...state, drawings: { ...(state.drawings || {}), [action.mapId]: list.filter(d => d.owner !== action.owner) } };
    }

    // v6 #9: Hazard polygons — environmental effects on a map.
    case 'HAZARD_UPSERT': {
      const { mapId, hazard } = action;
      if (!mapId || !hazard?.id) return state;
      const list = state.hazards?.[mapId] || [];
      const i = list.findIndex(h => h.id === hazard.id);
      const next = i === -1 ? [...list, hazard] : list.map(h => h.id === hazard.id ? hazard : h);
      return { ...state, hazards: { ...(state.hazards || {}), [mapId]: next } };
    }
    case 'HAZARD_DELETE': {
      const list = state.hazards?.[action.mapId] || [];
      return { ...state, hazards: { ...(state.hazards || {}), [action.mapId]: list.filter(h => h.id !== action.id) } };
    }
    case 'HAZARD_CLEAR_MAP':
      return { ...state, hazards: { ...(state.hazards || {}), [action.mapId]: [] } };

    // v7 #9: dice rolling. ROLL adds to log + caps at 50 entries.
    // CLEAR wipes the log (DM only via UI gating).
    case 'DICE_ROLL': {
      const entry = action.entry;
      if (!entry || !entry.id) return state;
      const log = [entry, ...(state.diceLog || [])].slice(0, 50);
      return { ...state, diceLog: log };
    }
    case 'DICE_LOG_CLEAR':
      return { ...state, diceLog: [] };

    // v7 #10: DM sound playback. SOUND_REGISTER adds metadata to the
    // shared registry (audio bytes live in IDB sounds store). SOUND_EVENT
    // appends a play/stop event so connected players see it and trigger
    // local audio playback. Events capped at 20 to keep the buffer small.
    case 'SOUND_REGISTER': {
      const { id, name } = action;
      if (!id) return state;
      return { ...state, sounds: { ...(state.sounds || {}), [id]: { id, name: String(name || id), ts: Date.now() } } };
    }
    case 'SOUND_DEREGISTER': {
      const { [action.id]: _r, ...rest } = (state.sounds || {});
      return { ...state, sounds: rest };
    }
    case 'SOUND_EVENT': {
      const ev = action.event;
      if (!ev || !ev.id) return state;
      // v7 #10: keep the FIRST entry (most recent) with its dataUrl so it
      // reaches peers via state broadcast; older entries are stripped of
      // their bytes since players have already cached them in IDB. This
      // keeps state.soundEvents tiny across sessions while still letting
      // newcomers play a fresh sound the DM just triggered.
      const lean = (state.soundEvents || []).map(e => {
        const { dataUrl, ...rest } = e;
        return rest;
      });
      const evs = [ev, ...lean].slice(0, 20);
      return { ...state, soundEvents: evs };
    }

    // v3: DM-defined custom token presets
    case 'TOKEN_PRESET_UPSERT':
      return { ...state, tokenPresets: { ...state.tokenPresets, [action.preset.id]: action.preset } };
    case 'TOKEN_PRESET_DELETE': {
      const { [action.id]: _r, ...rest } = state.tokenPresets;
      return { ...state, tokenPresets: rest };
    }

    // v4: Identity migration — a returning player reconnects with a new
    // peer ID but the same persistent playerId. Move their claim (PC,
    // familiars, name, spectator flag) from the old peer key to the new.
    // Also updates bondedPeerId on any familiars that were bonded to
    // the old peer id so familiar movement rights carry over.
    case 'CLAIM_MIGRATE': {
      const { fromPeerId, toPeerId, playerName, playerId } = action;
      if (!toPeerId) return state;
      const claims = { ...(state.claims || {}) };
      const oldClaim = fromPeerId && claims[fromPeerId];
      if (oldClaim) {
        claims[toPeerId] = {
          ...oldClaim,
          playerName: playerName || oldClaim.playerName,
          playerId: playerId || oldClaim.playerId || null,
        };
        if (fromPeerId !== toPeerId) delete claims[fromPeerId];
      } else if (!claims[toPeerId]) {
        // First hello from this peer id — record a blank claim with the
        // playerId stamped so a future reconnect can migrate back.
        claims[toPeerId] = { pc: null, familiars: [], playerName: playerName || '', spectator: false, playerId: playerId || null };
      } else {
        // Existing peer-key claim — just stamp the playerId
        claims[toPeerId] = { ...claims[toPeerId], playerId: playerId || claims[toPeerId].playerId || null };
        if (playerName) claims[toPeerId].playerName = playerName;
      }
      const entities = { ...state.entities };
      if (fromPeerId && fromPeerId !== toPeerId) {
        for (const [id, e] of Object.entries(entities)) {
          if (e && e.type === 'Familiar' && e.bondedPeerId === fromPeerId) {
            entities[id] = { ...e, bondedPeerId: toPeerId };
          }
        }
      }
      const fvpp = { ...(state.forcedViewPerPeer || {}) };
      if (fromPeerId && fvpp[fromPeerId] && fromPeerId !== toPeerId) { fvpp[toPeerId] = fvpp[fromPeerId]; delete fvpp[fromPeerId]; }
      const reminders = { ...(state.reminders || {}) };
      if (fromPeerId && reminders[fromPeerId] && fromPeerId !== toPeerId) { reminders[toPeerId] = reminders[fromPeerId]; delete reminders[fromPeerId]; }
      return { ...state, claims, entities, forcedViewPerPeer: fvpp, reminders };
    }

    // v4: DM kicks a peer. Clears their claim and any per-peer overlays.
    case 'DM_KICK_PEER': {
      const peerId = action.peerId;
      const claims = { ...(state.claims || {}) };
      delete claims[peerId];
      const fvpp = { ...(state.forcedViewPerPeer || {}) };
      delete fvpp[peerId];
      const reminders = { ...(state.reminders || {}) };
      delete reminders[peerId];
      // Unbond any familiars held by this peer
      const entities = { ...state.entities };
      for (const [id, e] of Object.entries(entities)) {
        if (e && e.type === 'Familiar' && e.bondedPeerId === peerId) {
          entities[id] = { ...e, bondedPeerId: null };
        }
      }
      return { ...state, claims, entities, forcedViewPerPeer: fvpp, reminders };
    }

    // v4: Entity duplication. Produces a new entity with a fresh ID and
    // " (copy)" suffix. Inserted just after the source in entityOrder.
    case 'ENTITY_DUPLICATE': {
      const src = state.entities[action.id];
      if (!src) return state;
      const newId = uid('ent_');
      const copy = {
        ...src,
        id: newId,
        name: (src.name || 'Unnamed') + ' (copy)',
        deathSaves: { successes: 0, failures: 0 },
        bondedPeerId: null,
      };
      const order = [...(state.entityOrder || [])];
      const idx = order.indexOf(action.id);
      if (idx === -1) order.push(newId);
      else order.splice(idx + 1, 0, newId);
      return {
        ...state,
        entities: { ...state.entities, [newId]: copy },
        entityOrder: order,
      };
    }

    // v4: Partial patch on a map (used for "alwaysDark" flag and other settings)
    case 'MAP_PATCH': {
      const m = state.maps[action.id];
      if (!m) return state;
      return { ...state, maps: { ...state.maps, [action.id]: { ...m, ...action.patch } } };
    }

    // v4: Move a reminder (user drag). Peer may only move their own.
    case 'REMINDER_MOVE': {
      const peerId = action.peerId;
      const list = state.reminders[peerId] || [];
      const nextList = list.map(r =>
        r.id === action.id ? { ...r, x: action.x, y: action.y } : r
      );
      return { ...state, reminders: { ...state.reminders, [peerId]: nextList } };
    }

    // ===== v7.3: Token groups (DM-only encounter clustering) =====
    // Groups live in state.tokenGroups keyed by id. Each group is
    // scoped to a single map and holds an array of tokenIds. Hiding
    // or revealing a group updates the .visible flag on every member
    // in a single reducer pass so the sync layer emits one payload.
    case 'TOKEN_GROUP_CREATE': {
      const { id, mapId, name, memberIds } = action;
      if (!id || !mapId || !name) return state;
      // Filter memberIds to tokens that actually exist on this map
      const validMembers = (Array.isArray(memberIds) ? memberIds : [])
        .filter(tid => state.tokens?.[tid]?.mapId === mapId);
      const group = {
        id,
        mapId,
        name: String(name).slice(0, 80),
        memberIds: validMembers,
        notes: '',
        createdTs: Date.now(),
      };
      return {
        ...state,
        tokenGroups: { ...(state.tokenGroups || {}), [id]: group },
      };
    }

    case 'TOKEN_GROUP_UPDATE': {
      const { id, patch } = action;
      const g = state.tokenGroups?.[id];
      if (!g) return state;
      const next = { ...g };
      if (typeof patch?.name === 'string') next.name = patch.name.slice(0, 80);
      if (typeof patch?.notes === 'string') next.notes = patch.notes.slice(0, 400);
      return {
        ...state,
        tokenGroups: { ...state.tokenGroups, [id]: next },
      };
    }

    case 'TOKEN_GROUP_DELETE': {
      const { id } = action;
      if (!state.tokenGroups?.[id]) return state;
      const { [id]: _removed, ...rest } = state.tokenGroups;
      return { ...state, tokenGroups: rest };
    }

    // Replace membership wholesale. Keeps the reducer simple and
    // avoids diff logic on the DM side. Filters for valid members
    // on this map before writing.
    case 'TOKEN_GROUP_SET_MEMBERS': {
      const { id, memberIds } = action;
      const g = state.tokenGroups?.[id];
      if (!g) return state;
      const valid = (Array.isArray(memberIds) ? memberIds : [])
        .filter(tid => state.tokens?.[tid]?.mapId === g.mapId);
      return {
        ...state,
        tokenGroups: { ...state.tokenGroups, [id]: { ...g, memberIds: valid } },
      };
    }

    // Add one or more members to an existing group.
    case 'TOKEN_GROUP_ADD_MEMBERS': {
      const { id, tokenIds } = action;
      const g = state.tokenGroups?.[id];
      if (!g) return state;
      const toAdd = (Array.isArray(tokenIds) ? tokenIds : [])
        .filter(tid => state.tokens?.[tid]?.mapId === g.mapId);
      if (toAdd.length === 0) return state;
      const merged = Array.from(new Set([...(g.memberIds || []), ...toAdd]));
      return {
        ...state,
        tokenGroups: { ...state.tokenGroups, [id]: { ...g, memberIds: merged } },
      };
    }

    case 'TOKEN_GROUP_REMOVE_MEMBERS': {
      const { id, tokenIds } = action;
      const g = state.tokenGroups?.[id];
      if (!g) return state;
      const drop = new Set(Array.isArray(tokenIds) ? tokenIds : []);
      const kept = (g.memberIds || []).filter(tid => !drop.has(tid));
      return {
        ...state,
        tokenGroups: { ...state.tokenGroups, [id]: { ...g, memberIds: kept } },
      };
    }

    // Set .visible on every token in the group in one shot. This is
    // the encounter-flow action — hide the goblin ambush, then reveal
    // them all when they spring the trap.
    case 'TOKEN_GROUP_SET_VISIBLE': {
      const { id, visible } = action;
      const g = state.tokenGroups?.[id];
      if (!g) return state;
      const memberSet = new Set(g.memberIds || []);
      if (memberSet.size === 0) return state;
      const tokens = { ...state.tokens };
      let changed = false;
      for (const tid of memberSet) {
        const t = tokens[tid];
        if (!t) continue;
        if (!!t.visible === !!visible) continue;
        tokens[tid] = { ...t, visible: !!visible };
        changed = true;
      }
      if (!changed) return state;
      return { ...state, tokens };
    }

    default: return state;
  }
}

// ICE server config shared by both host and join.
// STUN alone fails on mobile cellular (symmetric NAT / CGNAT).
// The Open Relay Project provides free public TURN servers that cover
// those cases — no registration required.
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ], username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

// How long to wait for the PeerJS broker WebSocket + WebRTC handshake
// before giving up and showing an error. Without this, mobile users on
// poor connections see an infinite orange dot with no feedback.
const CONNECT_TIMEOUT_MS = 20000;

class SyncManager {
  constructor({ mode, onStateUpdate, onPlayerAction, onPlayerHello, onStatusChange, onPeerListChange, onPeerId, onError, onMapImage, onTokenPos, onSoundData }) {
    this.mode = mode;
    this.peer = null;
    this.roomCode = null;
    this.connections = new Map(); // for DM
    this.dmConnection = null; // for Player
    this.myPeerId = null;
    this.onStateUpdate = onStateUpdate;
    this.onPlayerAction = onPlayerAction;
    this.onPlayerHello = onPlayerHello;
    this.onStatusChange = onStatusChange;
    this.onPeerListChange = onPeerListChange;
    this.onPeerId = onPeerId;
    this.onError = onError;
    this.onMapImage = onMapImage;
    this.onTokenPos = onTokenPos;
    this.onSoundData = onSoundData;
    this.status = 'offline';
  }
  setStatus(s) {
    this.status = s;
    this.onStatusChange?.(s);
  }
  async hostSession(roomCode) {
    this.setStatus('connecting');
    this.roomCode = roomCode;
    const timeout = setTimeout(() => {
      if (this.status === 'connecting') {
        this.setStatus('error');
        this.onError?.('Could not reach the PeerJS broker. Check your connection and try again.');
      }
    }, CONNECT_TIMEOUT_MS);
    try {
      this.peer = new Peer(PEER_PREFIX + roomCode, { config: ICE_SERVERS });
      this.peer.on('open', (id) => {
        clearTimeout(timeout);
        this.myPeerId = id;
        this.onPeerId?.(id);
        this.setStatus('live');
      });
      this.peer.on('connection', (conn) => {
        conn.on('open', () => {
          this.connections.set(conn.peer, conn);
          this.onPeerListChange?.(Array.from(this.connections.keys()));
        });
        conn.on('data', (data) => {
          if (data.type === 'player_action') this.onPlayerAction?.(data.payload, conn.peer);
          else if (data.type === 'hello') this.onPlayerHello?.(data, conn.peer);
        });
        conn.on('close', () => {
          this.connections.delete(conn.peer);
          this.onPeerListChange?.(Array.from(this.connections.keys()));
        });
        conn.on('error', () => {
          this.connections.delete(conn.peer);
          this.onPeerListChange?.(Array.from(this.connections.keys()));
        });
      });
      this.peer.on('error', (err) => {
        clearTimeout(timeout);
        if (err.type === 'unavailable-id') {
          this.onError?.('Room code already in use. Pick another.');
          this.setStatus('error');
        } else {
          this.setStatus('error');
          this.onError?.(err.message || 'Connection error');
        }
      });
    } catch (err) {
      clearTimeout(timeout);
      this.setStatus('error');
      this.onError?.(err.message);
    }
  }
  async joinSession(roomCode, playerId, playerName) {
    this.setStatus('connecting');
    this.roomCode = roomCode;
    this.playerId = playerId;
    this.playerName = playerName;
    const timeout = setTimeout(() => {
      if (this.status === 'connecting') {
        this.setStatus('error');
        this.onError?.('Could not connect to the table. Check your connection — mobile data may need a moment, or try WiFi.');
      }
    }, CONNECT_TIMEOUT_MS);
    try {
      this.peer = new Peer(undefined, { config: ICE_SERVERS });
      this.peer.on('open', (id) => {
        clearTimeout(timeout);
        this.myPeerId = id;
        this.onPeerId?.(id);
        const conn = this.peer.connect(PEER_PREFIX + roomCode, { reliable: true });
        this.dmConnection = conn;
        conn.on('open', () => {
          this.setStatus('live');
          conn.send({ type: 'hello', peerId: id, playerId, playerName });
        });
        conn.on('data', (data) => {
          if (data.type === 'state_update') this.onStateUpdate?.(data.payload);
          else if (data.type === 'map_image') this.onMapImage?.(data.mapId, data.dataUrl);
          else if (data.type === 'token_pos') this.onTokenPos?.(data.tokenId, data.x, data.y, data.mapId);
          else if (data.type === 'sound_data') this.onSoundData?.(data.soundId, data.name, data.dataUrl);
          else if (data.type === 'kicked') {
            this.onError?.(data.reason || 'You were removed from the session.');
            try { conn.close(); } catch {}
            this.setStatus('offline');
          }
        });
        conn.on('close', () => this.setStatus('offline'));
        conn.on('error', () => this.setStatus('error'));
      });
      this.peer.on('error', (err) => {
        clearTimeout(timeout);
        this.setStatus('error');
        this.onError?.(err.message || 'Could not connect');
      });
    } catch (err) {
      clearTimeout(timeout);
      this.setStatus('error');
      this.onError?.(err.message);
    }
  }
  sendPlayerAction(action) {
    if (this.mode !== 'player' || !this.dmConnection?.open) return false;
    try {
      this.dmConnection.send({ type: 'player_action', payload: action });
      return true;
    } catch { return false; }
  }
  // Send raw audio bytes to all connected peers so they can play the
  // sound immediately without waiting for a future state broadcast.
  // The state broadcast strips dataUrls; this is the only delivery path.
  sendSoundData(soundId, name, dataUrl) {
    if (this.mode !== 'dm' || !soundId || !dataUrl) return;
    for (const conn of this.connections.values()) {
      try {
        if (conn.open) conn.send({ type: 'sound_data', soundId, name, dataUrl });
      } catch {}
    }
  }
  sendSoundDataTo(peerId, soundId, name, dataUrl) {
    if (this.mode !== 'dm' || !soundId || !dataUrl) return;
    const conn = this.connections.get(peerId);
    try {
      if (conn?.open) conn.send({ type: 'sound_data', soundId, name, dataUrl });
    } catch {}
  }
  // v4: DM boots a player. Sends a goodbye message so their client can
  // show a friendly explanation, then closes the connection.
  kickPeer(peerId, reason) {
    if (this.mode !== 'dm') return;
    const conn = this.connections.get(peerId);
    if (!conn) return;
    try { conn.send({ type: 'kicked', reason: reason || 'The DM has removed you from the session.' }); } catch {}
    // Small delay so the message has a chance to land before the close
    setTimeout(() => {
      try { conn.close(); } catch {}
      this.connections.delete(peerId);
      this.onPeerListChange?.(Array.from(this.connections.keys()));
    }, 150);
  }
  destroy() {
    try { this.peer?.destroy(); } catch {}
    this.peer = null;
    this.connections.clear();
    this.dmConnection = null;
    this.setStatus('offline');
  }
}

// ====================================================================
// VISIBILITY FILTER (what player can see)
// ====================================================================

// Strip DM-only fields from an entity for player-facing consumption.
function sanitizeEntityForPlayer(e) {
  if (!e) return e;
  const isMonsterOrBeast = e.type === 'Monster' || e.type === 'Neutral Beast';
  const isNpcOrObject = e.type === 'NPC' || e.type === 'Object';
  return {
    ...e,
    deathSaves: { successes: 0, failures: 0 },
    ...(isMonsterOrBeast && { notes: '', abilities: '' }),
    ...(isNpcOrObject    && { notes: '' }),
  };
}

// v3: Vision system — convert feet to world-pixels using a fixed scale.
// 10 px/ft is a common VTT default (1" hex on a 72dpi 5-ft grid) but this
// lives in one constant so it can be tuned. Darkness system reads token
// positions + entity.darkvision + entity.lightRadius to compute the list
// of { x, y, radius } holes to punch in the dark overlay.
const PX_PER_FOOT = 10;

// DM helper: returns vision sources (as dashed outlines on the DM map) for
// every PC/Familiar with darkvision OR every entity of any type with
// lightRadius on the current map. Each gets a unique color keyed to its
// claimant (so the DM can eyeball "that's Ana's sight, that's Jonas's").
function computeVisionSources(state, mapId) {
  const sources = [];
  for (const t of Object.values(state.tokens)) {
    if (t.mapId !== mapId) continue;
    const e = state.entities[t.entityId];
    if (!e) continue;
    const dv = (e.darkvision || 0) * PX_PER_FOOT;
    const lr = (e.lightRadius || 0) * PX_PER_FOOT;
    if (dv <= 0 && lr <= 0) continue;
    const radius = Math.max(dv, lr);
    // v7.1: mark as a flame emitter if the token contributes any light.
    // Pure darkvision sources don't flicker — magical sight is steady.
    sources.push({ x: t.x, y: t.y, radius, color: e.color, isLight: lr > 0 });
  }
  return sources;
}

// Player helper: vision sources this specific player benefits from.
// Includes all owned entities' darkvision + lightRadius plus any torch
// objects (lightRadius > 0) placed on the map as they illuminate everyone.
//
// v5 fix #7: carried-light radii scale with time of day. Dusk/dawn light
// travels further than deep night (the sky still has some glow), so:
//   day     (tod < 0.5)    : doesn't matter — vision system not active
//   dusk    (0.5 ≤ tod < 0.7) : lightRadius × 1.75
//   night   (0.7 ≤ tod < 0.95): lightRadius × 1.25
//   deepest (tod ≥ 0.95)   : lightRadius × 1.0 (unmodified)
// Darkvision is magical and unaffected by ambient light.
function computePlayerVisionSources(state, mapId, ownedEntityIds, timeOfDay = 0, alwaysDark = false) {
  const sources = [];
  const owned = ownedEntityIds || new Set();
  const BASE_VISIBILITY_FT = 10;
  const baseRadius = BASE_VISIBILITY_FT * PX_PER_FOOT;

  // alwaysDark maps behave like "deepest" night regardless of TOD
  const effectiveTod = alwaysDark ? 1.0 : timeOfDay;
  let lightMul;
  if (effectiveTod >= 0.95) lightMul = 1.0;
  else if (effectiveTod >= 0.70) lightMul = 1.25;
  else lightMul = 1.75; // dusk/dawn band

  for (const t of Object.values(state.tokens)) {
    if (t.mapId !== mapId) continue;
    const e = state.entities[t.entityId];
    if (!e) continue;
    const dv = (e.darkvision || 0) * PX_PER_FOOT;
    const lr = (e.lightRadius || 0) * PX_PER_FOOT * lightMul;

    if (owned.has(e.id)) {
      const radius = Math.max(baseRadius, dv, lr);
      // v7.1: flicker if any portion of this source is from flame
      // (held torch/lantern). Base ambient vision + pure darkvision stay steady.
      sources.push({ x: t.x, y: t.y, radius, owned: true, entityId: e.id, isLight: lr > 0 });
      continue;
    }
    if (lr > 0) {
      // Non-owned flame (torch objects, candles, etc.) always flicker.
      sources.push({ x: t.x, y: t.y, radius: lr, owned: false, entityId: e.id, isLight: true });
    }
  }
  return sources;
}

function filterStateForPlayer(state, peerId) {
  // Lookup claim record for this peer
  const claim = state.claims?.[peerId] || { pc: null, familiars: [], playerName: '', spectator: false };
  const ownedIds = new Set();
  if (claim.pc) ownedIds.add(claim.pc);
  for (const id of claim.familiars) ownedIds.add(id);
  // v3: peers also "own" familiars whose bondedPeerId points at them.
  // v5 fix #10: ALSO own familiars bonded to a PC we currently claim.
  for (const [id, ent] of Object.entries(state.entities)) {
    if (!ent || ent.type !== 'Familiar') continue;
    if (ent.bondedPeerId === peerId) ownedIds.add(id);
    if (ent.bondedPcId && ent.bondedPcId === claim.pc) ownedIds.add(id);
  }

  // Token visibility: always show PCs/Familiars + owned; else DM must reveal.
  // v6 fix #4: Labels no longer get an "always visible" exemption — they
  // now follow the same vision rules as creatures. They still default to
  // visible (t.visible = true on place) so the DM doesn't need to click
  // to reveal each one, but at night / in alwaysDark maps they'll be
  // cut off if out of range.
  const visibleTokens = {};
  Object.entries(state.tokens).forEach(([k, t]) => {
    const entity = state.entities[t.entityId];
    if (!entity) return;
    const alwaysVisible = entity.type === 'PC' || entity.type === 'Familiar';
    const isOwned = ownedIds.has(entity.id);
    if (alwaysVisible || isOwned || t.visible) {
      visibleTokens[k] = t;
    }
  });

  // v5 fix #4: Hard vision-based cutoff. If vision is active on the current
  // map (night, or alwaysDark), any token whose position falls OUTSIDE every
  // owned vision radius is stripped entirely — not rendered, not listed in
  // sidebars, not known to the player client at all.
  //
  // We scope this to the CURRENT map (tokens on other maps aren't affected,
  // since the player isn't looking at those). Vision sources are computed
  // from the owned entity positions on that same map, mirroring what the
  // client would see.
  //
  // Note: this runs on top of the existing visibility gate. Owned PCs and
  // Familiars are always included regardless of distance so a player never
  // loses their own party's positions.
  const effectiveMapId = (state.forcedViewPerPeer?.[peerId]?.mapId)
    || (state.forcedView?.mapId)
    || state.currentMapId;
  const activeMap = state.maps?.[effectiveMapId];
  const mapAlwaysDark = !!activeMap?.alwaysDark;
  const tod = typeof state.timeOfDay === 'number' ? state.timeOfDay : 0;
  const visionActive = mapAlwaysDark || tod >= 0.5;

  let finalTokens = visibleTokens;

  if (visionActive) {
    const sources = computePlayerVisionSources(state, effectiveMapId, ownedIds, tod, mapAlwaysDark);
    const cutTokens = {};
    for (const [k, t] of Object.entries(visibleTokens)) {
      if (t.mapId !== effectiveMapId) { cutTokens[k] = t; continue; }
      const ent = state.entities[t.entityId];
      if (!ent) continue;
      if (ownedIds.has(ent.id)) { cutTokens[k] = t; continue; }
      let visible = false;
      for (const s of sources) {
        const dx = t.x - s.x, dy = t.y - s.y;
        if (dx * dx + dy * dy <= s.radius * s.radius) { visible = true; break; }
      }
      if (visible) cutTokens[k] = t;
    }
    finalTokens = cutTokens;
  }

  // Filter initiative entries - show PCs/Familiars (always) and entities with a visible token
  const filteredInitEntries = state.initiative.entries.filter(e => {
    const entity = state.entities[e.entityId];
    if (!entity) return false;
    if (entity.type === 'PC' || entity.type === 'Familiar') return true;
    return Object.values(state.tokens).some(t => t.entityId === entity.id && t.visible);
  });

  // Sanitize entities. Own PC keeps sickness; everyone else gets sickness=0
  // (v3: but players now DO see sickness as a diegetic condition on their own
  // PC — the EditMySheet renders it from this preserved value).
  // v5 fix #6: sickness is now shown to all players on all visible tokens
  // (previously stripped for non-owned entities). Only the narrative
  // descriptor label ever reaches the UI — the numeric level is an
  // implementation detail that the chip uses purely for styling.
  const sanitizedEntities = {};
  for (const [id, e] of Object.entries(state.entities)) {
    sanitizedEntities[id] = sanitizeEntityForPlayer(e);
  }

  // Reminders are strictly private
  const myReminders = state.reminders?.[peerId] || [];
  const reminders = { [peerId]: myReminders };

  // v3: per-peer forced view. If this peer has a specific push, apply it.
  // Otherwise fall back to the legacy global forcedView (applies to all).
  const peerForced = state.forcedViewPerPeer?.[peerId];
  const effectiveForcedView = peerForced || state.forcedView || null;

  // v6 #9: Strip invisible hazards from the player-facing payload.
  // Hazards with visible === false are DM-only (e.g., hidden traps).
  // Also strip any drawings whose map doesn't exist (defensive cleanup).
  const visibleHazards = {};
  for (const [mapId, list] of Object.entries(state.hazards || {})) {
    visibleHazards[mapId] = (list || []).filter(h => h.visible !== false);
  }

  return {
    ...state,
    entities: sanitizedEntities,
    tokens: finalTokens,
    initiative: { ...state.initiative, entries: filteredInitEntries },
    reminders,
    forcedView: effectiveForcedView,
    // Strip other peers' private forced-view map. Only keep this peer's own.
    forcedViewPerPeer: peerForced ? { [peerId]: peerForced } : {},
    hazards: visibleHazards,
    // v7.3: Token groups are DM-only encounter metadata. Players see
    // only the EFFECT of group operations (tokens appearing /
    // disappearing), never the group roster itself. Strip entirely.
    tokenGroups: {},
  };
}

// v7.2 PERFORMANCE FIX: strip heavy binary assets from broadcast
// payloads. In v7, every state_update included all map image dataUrls
// inline (often multiple MB) and every sound event's dataUrl. A fresh
// join or a single token drag would push megabytes through WebRTC on
// each broadcast, producing the reported 10-second join and 3–4 second
// lighting-update lag.
//
// New strategy: the broadcast payload carries only lean metadata.
// Players fetch map image bytes on demand via a separate 'map_image'
// envelope (sent once per map, cached locally in IDB).
//
// Sound events already had their dataUrls stripped in the reducer
// (v7 fix) but we belt-and-suspenders that here too.
function stripHeavyAssetsForWire(state) {
  const leanMaps = {};
  for (const [id, m] of Object.entries(state.maps || {})) {
    if (m?.imageUrl && typeof m.imageUrl === 'string' && m.imageUrl.startsWith('data:')) {
      leanMaps[id] = { ...m, imageUrl: IMG_SENTINEL };
    } else {
      leanMaps[id] = m;
    }
  }
  const leanSoundEvents = (state.soundEvents || []).map(e => {
    if (e?.dataUrl) {
      const { dataUrl, ...rest } = e;
      return rest;
    }
    return e;
  });
  return { ...state, maps: leanMaps, soundEvents: leanSoundEvents };
}

// ====================================================================
// TOAST SYSTEM
// ====================================================================
const ToastContext = createContext(null);

function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, type = 'info', duration = 3000) => {
    const id = uid('t');
    setToasts((curr) => [...curr, { id, message, type }]);
    setTimeout(() => setToasts((curr) => curr.filter(t => t.id !== id)), duration);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>{t.message}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
const useToast = () => useContext(ToastContext);

// Maps a sync status string to the CSS modifier class used on .conn-dot.
// Used in both DMInterface and PlayerInterface topbars.
const syncStatusClass = (status) =>
  status === 'live' ? 'live' : status === 'connecting' ? 'connecting' : status === 'error' ? 'error' : '';

// ====================================================================
// AUTH SCREEN
// ====================================================================
function AuthScreen({ onAuth }) {
  const [tab, setTab] = useState('dm');
  const [password, setPassword] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [error, setError] = useState('');

  const handleDM = () => {
    if (password !== DM_PASSWORD) {
      setError('Incorrect passphrase.');
      return;
    }
    const code = roomCode.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'table-' + Math.random().toString(36).slice(2, 6);
    onAuth({ mode: 'dm', roomCode: code });
  };

  const handlePlayer = () => {
    if (!roomCode.trim()) { setError('Enter a room code.'); return; }
    if (!playerName.trim()) { setError('Choose a display name.'); return; }
    onAuth({
      mode: 'player',
      roomCode: roomCode.trim().toLowerCase(),
      playerName: playerName.trim(),
      // v4 fix #7: stable per-device identity so the DM can restore
      // this player's claim after a refresh/reconnect.
      playerId: getOrCreatePlayerId(),
    });
  };

  const handleLocal = () => {
    onAuth({ mode: 'dm', roomCode: null, local: true });
  };

  return (
    <div className="auth-screen">
      <div className="auth-card slide-up">
        <div className="auth-title">The Plague's Call</div>
        <div className="auth-subtitle">— a virtual tabletop for tales of rot and rust —</div>

        <div className="auth-tab-row">
          <div className={`auth-tab ${tab === 'dm' ? 'active' : ''}`} onClick={() => { setTab('dm'); setError(''); }}>
            ⚔ Dungeon Master
          </div>
          <div className={`auth-tab ${tab === 'player' ? 'active' : ''}`} onClick={() => { setTab('player'); setError(''); }}>
            ⌂ Player
          </div>
        </div>

        {tab === 'dm' ? (
          <>
            <div className="auth-field">
              <label>Passphrase</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter the arcane word…" autoFocus
                onKeyDown={e => e.key === 'Enter' && handleDM()} />
              <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 4 }}>
                Default passphrase: <kbd>dragon</kbd> — edit <code>DM_PASSWORD</code> in <code>app.js</code>
              </div>
            </div>
            <div className="auth-field">
              <label>Room Code (optional)</label>
              <input value={roomCode} onChange={e => setRoomCode(e.target.value)} placeholder="e.g. curse-of-strahd"
                onKeyDown={e => e.key === 'Enter' && handleDM()} />
              <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 4 }}>
                Share with players so they may join.
              </div>
            </div>
            {error && <div style={{ color: 'var(--blood-bright)', fontSize: 12, marginBottom: 12 }}>{error}</div>}
            <button className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: '12px' }} onClick={handleDM}>
              Open the Session
            </button>
            <div className="hr" />
            <button className="btn ghost" style={{ width: '100%', justifyContent: 'center' }} onClick={handleLocal}>
              ⚐ Local-only mode (no sync)
            </button>
          </>
        ) : (
          <>
            <div className="auth-field">
              <label>Room Code</label>
              <input value={roomCode} onChange={e => setRoomCode(e.target.value)} placeholder="e.g. curse-of-strahd" autoFocus
                onKeyDown={e => e.key === 'Enter' && handlePlayer()} />
            </div>
            <div className="auth-field">
              <label>Your Name</label>
              <input value={playerName} onChange={e => setPlayerName(e.target.value)} placeholder="e.g. Elara"
                onKeyDown={e => e.key === 'Enter' && handlePlayer()} />
            </div>
            {error && <div style={{ color: 'var(--blood-bright)', fontSize: 12, marginBottom: 12 }}>{error}</div>}
            <button className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: '12px' }} onClick={handlePlayer}>
              Join the Table
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ====================================================================
// TOKEN COMPONENT
// ====================================================================
// Map entity.type → CSS shape class on `.token-shape`. New v2 types use
// distinct silhouettes so the map stays readable at a glance.
const TOKEN_SHAPE_CLASS = {
  'PC': 'pc',
  'Monster': 'monster',
  'NPC': 'npc',
  'Familiar': 'familiar',
  'Neutral Beast': 'neutral-beast',
  'Object': 'object',
  'Label': 'label',
};

function TokenView({
  token, entity, isCurrent, isSelected, canDrag,
  onStartDrag, onDoubleClick, onContextMenu,
  showLabel, isDraggingLocal,
  onHoverChange, mode,
  // v6 #12:
  isMultiSelected, onSingleClick,
  // v7 #3: token-to-token measurement — first-clicked token gets a halo
  isMeasureStart,
}) {
  if (!entity) return null;
  const typeClass = TOKEN_SHAPE_CLASS[entity.type] || 'npc';
  const hpPct = entity.hp.max > 0 ? (entity.hp.current / entity.hp.max) * 100 : 0;
  const hpClass = hpPct <= 25 ? 'critical' : hpPct <= 50 ? 'low' : '';
  const initial = (entity.name || '?').slice(0, 1).toUpperCase();
  // v2: per-token scale factor. Applied as a CSS scale so hitboxes remain
  // centered on token.x/y (we compensate the offset with transform-origin).
  const scale = clamp(Number(token.scale) || 1, 0.3, 4);

  // v2: player-facing HP bar gating. DM sees everything; players only see
  // HP bars for PCs + Familiars (the "party" types).
  const showHpBar = entity.hp.max > 0 && (
    mode === 'dm' || PLAYER_HP_VISIBLE_TYPES.has(entity.type)
  );

  // v3: every status effect renders BELOW the token name, wrapped into a list.
  // Conditions with distinct colors still use CONDITION_COLORS; sickness
  // (player-facing descriptor) also appears here as a small italic tag.
  const statusItems = [...entity.conditions];
  const sicknessLabel = SICKNESS_DESCRIPTORS[entity.sickness || 0] || '';

  const onPointerDown = (e) => {
    if (e.button === 2) return;
    if (canDrag) {
      e.stopPropagation();
      onStartDrag?.(e);
    }
  };
  const onContext = (e) => {
    if (onContextMenu) { e.preventDefault(); onContextMenu(e); }
  };

  const classes = [
    'token',
    !token.visible ? 'hidden-token' : '',
    isCurrent ? 'current-turn' : '',
    isSelected ? 'selected' : '',
    isMultiSelected ? 'multi-selected' : '',
    isMeasureStart ? 'measure-start' : '',
    isDraggingLocal ? 'dragging' : '',
  ].filter(Boolean).join(' ');

  // v6 #12: pass click events to the parent so shift-click can toggle
  // multi-selection. The click fires after pointer-up, separately from
  // drag, so this doesn't interfere with drag-to-move.
  const onClick = (e) => {
    if (onSingleClick) {
      e.stopPropagation();
      onSingleClick(e);
    }
  };

  // v5 #3: Labels render as stylized text — no shape, no HP bar, no
  // conditions stack. Used for map annotations like "Butcher", "Church".
  // They still participate in selection/drag so the DM can reposition them.
  if (entity.type === 'Label') {
    return (
      <div
        className={classes + ' token-label-text'}
        data-tok={token.id}
        style={{
          left: token.x,
          top: token.y,
          '--token-scale': scale,
          color: entity.color || '#c9a34a',
        }}
        onPointerDown={onPointerDown}
        onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick?.(e); }}
        onClick={onClick}
        onContextMenu={onContext}
        onMouseEnter={() => onHoverChange?.({ tokenId: token.id, entityId: entity.id })}
        onMouseLeave={() => onHoverChange?.(null)}
      >
        <div className="token-label-inner">{entity.name || 'Label'}</div>
      </div>
    );
  }

  return (
    <div
      className={classes}
      data-tok={token.id}
      style={{ left: token.x - 18, top: token.y - 18, '--token-scale': scale }}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick?.(e); }}
      onClick={onClick}
      onContextMenu={onContext}
      onMouseEnter={() => onHoverChange?.({ tokenId: token.id, entityId: entity.id })}
      onMouseLeave={() => onHoverChange?.(null)}
    >
      <div className="token-inner">
        {showHpBar && (
          <div className="token-hp-bar">
            <div className={`token-hp-fill ${hpClass}`} style={{ width: `${hpPct}%` }} />
          </div>
        )}
        <div className={`token-shape ${typeClass}`} style={{ '--color': entity.color }}>
          {entity.imageUrl ? (
            <img src={entity.imageUrl} alt="" className="token-portrait" draggable="false" />
          ) : (
            <span>{initial}</span>
          )}
        </div>
        {showLabel && <div className="token-label">{entity.name}</div>}
        {showLabel && (statusItems.length > 0 || sicknessLabel) && (
          <div className="token-status-stack">
            {statusItems.map(c => (
              <span key={c} className="token-status-chip" title={c}
                style={{ background: CONDITION_COLORS[c] || 'rgba(120,120,120,0.85)' }}>
                {c}
              </span>
            ))}
            {sicknessLabel && (
              <span className="token-status-chip sickness" title="Sickness">
                <em>{sicknessLabel.toLowerCase()}</em>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ====================================================================
// MAP CANVAS
// ====================================================================
function MapCanvas({
  map, entities, tokens, initiative, mode, peerId, claimedEntityId, ownedEntityIds,
  onTokenMove, onTokenDoubleClick, onTokenContextMenu,
  onPlaceEntity, onViewportChange, selectedTokenId,
  // v6 #12: multi-select
  selectedTokenIds, onTokenSingleClick, onSelectTokens,
  mapScale = 1.0,
  reminders = [], onReminderUpsert, onReminderDelete,
  placingReminder = false, onPlaceReminderDone,
  hoveredTokenId, onTokenHoverChange,
  // v3:
  visionEnabled = false,      // whether to dim the map where nothing sees
  visionSources = [],         // [{ x, y, radius }] — in world pixels
  blockZones = [],            // [{ id, x, y, w, h }] — in world pixels
  placingBlock = false, onPlaceBlockDone, onBlockUpsert, onBlockDelete,
  placingFreeBlock = false, onPlaceFreeBlockDone,
  // v6 #8 + #13: two new block modes — circle draw + eraser.
  placingCircleBlock = false, onPlaceCircleBlockDone,
  erasingBlock = false, onPlaceEraseBlockDone,
  // v6 #11: measuring tools (line + radius). Available to DM and players.
  measureMode = null,         // null | 'line' | 'radius'
  onMeasureModeDone,
  // v6 #10: drawing tool — free / line / circle with color + width.
  drawings = [],              // [{id, type, ..., color, width, owner}]
  drawMode = null,            // null | 'free' | 'line' | 'circle'
  drawColor = '#c9a34a',
  drawWidth = 3,
  drawOwner = null,           // peerId or 'dm' — tags the drawing
  onDrawingUpsert,
  // v6 #9: hazard polygons. Rendered with per-type styling. Hazards
  // with visible === false are already stripped for players in the
  // sync filter; DM sees all.
  hazards = [],
  placingHazard = null,       // null | 'fire' | 'flood' | 'cold' | 'acid' | 'fog' | 'difficult'
  hazardVisibleDefault = true,
  onHazardUpsert,
  onHazardDelete,
  onPlaceHazardDone,
}) {
  const wrapRef = useRef(null);
  const stageRef = useRef(null);
  const [viewport, setViewport] = useState(map?.viewport || { x: 0, y: 0, zoom: 1 });
  const [panning, setPanning] = useState(false);
  const panRef = useRef(null);
  const dragTokenRef = useRef(null);
  const [, forceRender] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  // v7.4 LIGHTING FIX: the vision mask, block-zone layer, drawing
  // layer, hazard layer, and measuring layer were all hardcoded to a
  // -4000 → +4000 (8000 square) bounding box. Maps larger than that
  // had their outer edges permanently light (or permanently dark on
  // the player side) because the dark-fill rectangle of the vision
  // mask simply didn't extend over them.
  //
  // Fix: measure the map image's natural size on load and compute a
  // bounding box that covers it with 4000px of padding on every side
  // (so tokens can light outside the map edge without clipping the
  // mask). Minimum 8000 to preserve old behavior on unmapped canvases.
  // One useState so all five layers re-render cohesively.
  const [mapBounds, setMapBounds] = useState({ W: 8000, H: 8000, OFF: 4000 });
  const onMapImageLoad = (e) => {
    const img = e?.target;
    if (!img) return;
    // Natural dimensions in world pixels (tokens and all overlays use
    // world pixels; the stage transform handles screen-space scaling).
    // Pad each axis with 4000 world-px so tokens can illuminate beyond
    // the map edge without clipping the mask.
    const nw = img.naturalWidth || 0;
    const nh = img.naturalHeight || 0;
    const W = Math.max(8000, Math.ceil(nw + 8000));
    const H = Math.max(8000, Math.ceil(nh + 8000));
    const OFF = 4000;
    setMapBounds(prev => (prev.W === W && prev.H === H && prev.OFF === OFF) ? prev : { W, H, OFF });
  };
  // v3: in-progress block zone rectangle while DM is dragging to draw.
  // Lives locally; committed to state on pointer-up via onBlockUpsert.
  const [drawingBlock, setDrawingBlock] = useState(null);
  // v4 #16: freeform polygon-in-progress as pointer is being dragged.
  // Stored as [[x,y], ...] in world coordinates.
  const [drawingPoly, setDrawingPoly] = useState(null);
  // v6 #8: circle-in-progress {cx, cy, r}
  const [drawingCircle, setDrawingCircle] = useState(null);
  // v6 #13: eraser active while pointer is down
  const [erasingActive, setErasingActive] = useState(false);
  // v6 #12: drag-to-select box in world coordinates (DM only).
  //   null → no box in progress; {x0,y0,x1,y1} → currently dragging
  const [selectionBox, setSelectionBox] = useState(null);
  // v6 #11: in-progress measurement — {x0,y0,x1,y1} in world coords.
  // Applies to 'line' and 'radius' modes; v7 also supports 'tokenToToken'.
  const [measuring, setMeasuring] = useState(null);
  // v7 #3: token-to-token measurement. Holds the first-clicked token id
  // while we wait for a second click. On the second click, commit a
  // one-shot line measure between the two token centers and clear.
  const [t2tStartId, setT2tStartId] = useState(null);
  // v6 #10: in-progress drawing. For free mode it's {type:'free', points:[[x,y]...]};
  // for line/circle it's {type, x0,y0,x1,y1 | cx,cy,r}.
  const [drawingNow, setDrawingNow] = useState(null);
  const drawRef = useRef(null);

  // Update viewport when map changes
  useEffect(() => {
    setViewport(map?.viewport || { x: 0, y: 0, zoom: 1 });
  }, [map?.id]);

  // persist viewport debounced
  useEffect(() => {
    const handle = setTimeout(() => {
      if (mode === 'dm' && map) {
        onViewportChange?.(map.id, viewport);
      }
    }, 500);
    return () => clearTimeout(handle);
  }, [viewport.x, viewport.y, viewport.zoom]);

  const screenToWorld = useCallback((sx, sy) => {
    const rect = wrapRef.current.getBoundingClientRect();
    return {
      x: (sx - rect.left - viewport.x) / viewport.zoom,
      y: (sy - rect.top - viewport.y) / viewport.zoom,
    };
  }, [viewport]);

  // --- Panning + placement ---
  const onWrapPointerDown = (e) => {
    // Only react to pointer-downs on the canvas backdrop, not on tokens/pins.
    if (e.target !== wrapRef.current
        && !e.target.classList.contains('canvas-stage')
        && !e.target.classList.contains('map-image')) return;

    // v3: Block-zone rectangle draw mode (DM only).
    if (placingBlock && mode === 'dm') {
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      drawRef.current = { startX: world.x, startY: world.y };
      setDrawingBlock({ x: world.x, y: world.y, w: 0, h: 0 });
      return;
    }

    // v7 #2: Freeform polygon block draw (DM only). Pointer-down starts
    // a polyline; pointer-move appends; pointer-up commits as polygon.
    if (placingFreeBlock && mode === 'dm') {
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      setDrawingPoly([[world.x, world.y]]);
      setPolySession(s => s + 1);
      return;
    }

    // v7 #2: Hazard polygon draw (DM only). Same lifecycle as freeform
    // block polygons, but commits as a hazard instead.
    if (placingHazard && mode === 'dm') {
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      setDrawingPoly([[world.x, world.y]]);
      setPolySession(s => s + 1);
      return;
    }

    // v7 #2: Circle block draw (DM only). Pointer-down anchors the center,
    // drag expands the radius, pointer-up commits as { type: 'circle', cx, cy, r }.
    if (placingCircleBlock && mode === 'dm') {
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      drawRef.current = { cx: world.x, cy: world.y };
      setDrawingCircle({ cx: world.x, cy: world.y, r: 0 });
      setCircleSession(s => s + 1);
      return;
    }

    // v7 #7: Polygon-cut eraser (DM only). The eraser is now a polygon
    // tool: drag out a freeform polygon, on release every block whose
    // centroid (or all vertices) falls inside the cut is removed.
    // Reuses the same polygon pointer lifecycle as block / hazard,
    // dispatching to the cut handler on commit.
    if (erasingBlock && mode === 'dm') {
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      setDrawingPoly([[world.x, world.y]]);
      setPolySession(s => s + 1);
      return;
    }

    // Reminder placement is handled by onStagePointerClick below, so a
    // click is committed on pointer-up (lets panning still work if the
    // user changes their mind).
    if (placingReminder) return;

    // v7 #11: Measuring mode — start a line/radius from this point.
    // Cancels any lingering hold timer from a prior measurement.
    if (measureMode) {
      e.preventDefault();
      if (measureTimerRef.current) {
        clearTimeout(measureTimerRef.current);
        measureTimerRef.current = null;
      }
      const world = screenToWorld(e.clientX, e.clientY);
      setMeasuring({ x0: world.x, y0: world.y, x1: world.x, y1: world.y });
      setMeasureSession(s => s + 1);
      return;
    }

    // v7 #2: Drawing mode — free / line / circle.
    // Bump the session counter so the lifecycle effect re-arms exactly
    // once for this drawing.
    if (drawMode) {
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      if (drawMode === 'free') {
        setDrawingNow({ type: 'free', points: [[world.x, world.y]] });
      } else if (drawMode === 'line') {
        setDrawingNow({ type: 'line', x0: world.x, y0: world.y, x1: world.x, y1: world.y });
      } else if (drawMode === 'circle') {
        setDrawingNow({ type: 'circle', cx: world.x, cy: world.y, r: 0 });
      }
      setDrawSession(s => s + 1);
      return;
    }

    // v6 #12: Shift-drag on empty canvas = marquee select (DM only).
    // Holds the shift key while pressing down on the backdrop.
    if (mode === 'dm' && e.shiftKey) {
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      drawRef.current = { startX: world.x, startY: world.y };
      setSelectionBox({ x0: world.x, y0: world.y, x1: world.x, y1: world.y });
      return;
    }

    setPanning(true);
    panRef.current = { startX: e.clientX, startY: e.clientY, vx: viewport.x, vy: viewport.y };
  };

  // v3: block-zone rectangle pointer-move / pointer-up lifecycle
  useEffect(() => {
    if (!drawingBlock) return;
    const onMove = (e) => {
      const world = screenToWorld(e.clientX, e.clientY);
      const sx = drawRef.current.startX, sy = drawRef.current.startY;
      setDrawingBlock({
        x: Math.min(sx, world.x),
        y: Math.min(sy, world.y),
        w: Math.abs(world.x - sx),
        h: Math.abs(world.y - sy),
      });
    };
    const onUp = () => {
      const rect = drawingBlock;
      setDrawingBlock(null);
      drawRef.current = null;
      if (rect && rect.w > 8 && rect.h > 8) {
        onBlockUpsert?.({ id: uid('blk_'), x: rect.x, y: rect.y, w: rect.w, h: rect.h });
      }
      onPlaceBlockDone?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drawingBlock, onBlockUpsert, onPlaceBlockDone, screenToWorld]);

  // v4 #16: freeform polygon pointer-move / pointer-up lifecycle
  // v7 #2: Polygon (freeform block + hazard) lifecycle.
  // Same single-attach pattern as drawings + circle blocks.
  const drawingPolyRef = useRef(null);
  drawingPolyRef.current = drawingPoly;
  const polyCommittedRef = useRef(true);
  const [polySession, setPolySession] = useState(0);
  // Keep latest hazard config in refs so the listener reads current values
  // without needing to re-attach when the DM toggles the visibility default
  // mid-session.
  const placingHazardRef = useRef(placingHazard);
  placingHazardRef.current = placingHazard;
  const hazardVisibleDefaultRef = useRef(hazardVisibleDefault);
  hazardVisibleDefaultRef.current = hazardVisibleDefault;
  // v7 #7: erasing flag in a ref so the polygon commit can route to
  // the cut handler instead of creating a new block.
  const erasingBlockRef = useRef(erasingBlock);
  erasingBlockRef.current = erasingBlock;
  const blockZonesRef = useRef(blockZones);
  blockZonesRef.current = blockZones;
  useEffect(() => {
    if (polySession === 0) return;
    polyCommittedRef.current = false;
    const onMove = (e) => {
      const world = screenToWorld(e.clientX, e.clientY);
      setDrawingPoly(prev => {
        if (!prev) return prev;
        const last = prev[prev.length - 1];
        const dx = world.x - last[0], dy = world.y - last[1];
        if (dx * dx + dy * dy < 25) return prev;
        return [...prev, [world.x, world.y]];
      });
    };
    const onUp = () => {
      if (polyCommittedRef.current) return;
      polyCommittedRef.current = true;
      const poly = drawingPolyRef.current;
      setDrawingPoly(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (poly && poly.length >= 3) {
        if (erasingBlockRef.current) {
          // v7.1 fix: true polygon-clip eraser. Instead of deleting a
          // block only if entirely contained, we now compute each
          // block's shape MINUS the cut polygon and replace the block
          // with its remaining piece(s). Rects and circles are
          // converted to polygons first.
          //
          //   cut fully contains block  → block removed (empty result)
          //   cut partially overlaps    → block replaced by the
          //                               non-overlapping piece(s)
          //   cut doesn't touch block   → block unchanged
          //
          // polygonSubtract returns [] when fully consumed, [originalPoly]
          // when untouched, or [piece1, piece2, ...] when carved.
          for (const z of (blockZonesRef.current || [])) {
            const subjectPoly = blockToPolygon(z);
            const pieces = polygonSubtract(subjectPoly, poly);
            // If pieces === [original subject], the block was untouched.
            const untouched = pieces.length === 1
              && pieces[0].length === subjectPoly.length
              && pieces[0].every((p, i) => Math.abs(p[0] - subjectPoly[i][0]) < 1e-3 && Math.abs(p[1] - subjectPoly[i][1]) < 1e-3);
            if (untouched) continue;
            // Otherwise delete the original and upsert the remaining
            // pieces as new poly-type blocks.
            onBlockDelete?.(z.id);
            for (const piece of pieces) {
              if (piece.length < 3) continue;
              onBlockUpsert?.({ id: uid('blk_'), type: 'poly', points: piece });
            }
          }
        } else if (placingHazardRef.current && onHazardUpsert) {
          onHazardUpsert({
            id: uid('hz_'),
            type: 'polygon',
            hazardKind: placingHazardRef.current,
            points: poly,
            visible: hazardVisibleDefaultRef.current,
          });
        } else if (onBlockUpsert) {
          onBlockUpsert({ id: uid('blk_'), type: 'poly', points: poly });
        }
      }
      onPlaceFreeBlockDone?.();
      onPlaceHazardDone?.();
      onPlaceEraseBlockDone?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [polySession, onBlockUpsert, onPlaceFreeBlockDone, onHazardUpsert, onPlaceHazardDone, onBlockDelete, onPlaceEraseBlockDone, screenToWorld]);

  // v7 #2: Selection-box (marquee) lifecycle — session-keyed.
  const selectionBoxRef = useRef(null);
  selectionBoxRef.current = selectionBox;
  const selectionCommittedRef = useRef(true);
  const [selectionSession, setSelectionSession] = useState(0);
  useEffect(() => {
    if (selectionSession === 0) return;
    selectionCommittedRef.current = false;
    const onMove = (e) => {
      const world = screenToWorld(e.clientX, e.clientY);
      setSelectionBox(prev => prev ? { ...prev, x1: world.x, y1: world.y } : prev);
    };
    const onUp = () => {
      if (selectionCommittedRef.current) return;
      selectionCommittedRef.current = true;
      const box = selectionBoxRef.current;
      setSelectionBox(null);
      drawRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!box || !onSelectTokens) return;
      const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1);
      const y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);
      if (x1 - x0 < 4 && y1 - y0 < 4) return;
      const ids = [];
      for (const t of Object.values(tokens)) {
        if (t.mapId !== map?.id) continue;
        if (t.x >= x0 && t.x <= x1 && t.y >= y0 && t.y <= y1) ids.push(t.id);
      }
      onSelectTokens(ids);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [selectionSession, tokens, map?.id, screenToWorld, onSelectTokens]);

  // v7 #4 + #11: Measuring lifecycle.
  // The v6 version had three problems:
  //   (a) effect re-attached on every state change → multiple pointerup
  //       listeners stacked → double-commit / lingering preview
  //   (b) the 1.2s hold timer was never cleared on mode switch, so a
  //       line measure could leak into a fresh radius measure
  //   (c) cleanup didn't remove pointerup
  // Fix: session counter (single attach), commit-once guard, the 1.2s
  // hold timer is stored in a ref + cleared on mode change, and
  // switching mode forces measuring to null.
  const measuringRef = useRef(null);
  measuringRef.current = measuring;
  const measureCommittedRef = useRef(true);
  const measureTimerRef = useRef(null);
  const [measureSession, setMeasureSession] = useState(0);
  // Whenever the active mode changes (or clears), kill any lingering
  // preview + clear the hold timer so we never see a phantom line/circle
  // from a previous measurement. Also resets t2t pending start.
  useEffect(() => {
    if (measureTimerRef.current) {
      clearTimeout(measureTimerRef.current);
      measureTimerRef.current = null;
    }
    setMeasuring(null);
    setT2tStartId(null);
  }, [measureMode]);
  useEffect(() => {
    if (measureSession === 0) return;
    measureCommittedRef.current = false;
    const onMove = (e) => {
      const world = screenToWorld(e.clientX, e.clientY);
      setMeasuring(prev => prev ? { ...prev, x1: world.x, y1: world.y } : prev);
    };
    const onUp = () => {
      if (measureCommittedRef.current) return;
      measureCommittedRef.current = true;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // Hold the final reading visible for 1.2s, then clear cleanly.
      // Save the timer in a ref so a mode-switch can cancel it.
      if (measureTimerRef.current) clearTimeout(measureTimerRef.current);
      measureTimerRef.current = setTimeout(() => {
        setMeasuring(null);
        measureTimerRef.current = null;
      }, 1200);
      onMeasureModeDone?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [measureSession, screenToWorld, onMeasureModeDone]);

  // v7 fix #2: Drawing pointer-move / pointer-up lifecycle.
  // The v6 implementation had `useEffect` depend on `drawingNow`, which
  // meant every pointermove → setDrawingNow → effect cleanup + re-attach,
  // and the `pointerup` listener (registered with `{ once: true }`) was
  // never removed by cleanup. Result: N listeners stacked → N copies of
  // every shape committed on release.
  //
  // The fix: depend only on a session counter that increments on each
  // pointer-down. The effect attaches its listeners exactly once per
  // session and uses a ref to read the latest drawing state. A
  // commit-once guard prevents double-commit even if duplicate up events
  // sneak through (touchscreens occasionally do this).
  const drawingNowRef = useRef(null);
  drawingNowRef.current = drawingNow;
  const drawCommittedRef = useRef(true); // start as "committed" so no listener fires
  const [drawSession, setDrawSession] = useState(0);
  useEffect(() => {
    if (drawSession === 0) return;
    drawCommittedRef.current = false;
    const onMove = (e) => {
      const world = screenToWorld(e.clientX, e.clientY);
      setDrawingNow(prev => {
        if (!prev) return prev;
        if (prev.type === 'free') {
          const last = prev.points[prev.points.length - 1];
          const dx = world.x - last[0], dy = world.y - last[1];
          if (dx * dx + dy * dy < 9) return prev;
          return { ...prev, points: [...prev.points, [world.x, world.y]] };
        }
        if (prev.type === 'line') return { ...prev, x1: world.x, y1: world.y };
        if (prev.type === 'circle') {
          const dx = world.x - prev.cx, dy = world.y - prev.cy;
          return { ...prev, r: Math.sqrt(dx * dx + dy * dy) };
        }
        return prev;
      });
    };
    const onUp = () => {
      // Commit-once guard: a single pointerup must produce a single shape.
      if (drawCommittedRef.current) return;
      drawCommittedRef.current = true;
      const d = drawingNowRef.current;
      setDrawingNow(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!d || !onDrawingUpsert) return;
      // Size guards prevent click-blob commits.
      if (d.type === 'free' && d.points.length < 2) return;
      if (d.type === 'line' && Math.hypot(d.x1 - d.x0, d.y1 - d.y0) < 6) return;
      if (d.type === 'circle' && d.r < 4) return;
      onDrawingUpsert({
        ...d,
        id: uid('draw_'),
        color: drawColor,
        width: drawWidth,
        owner: drawOwner,
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drawSession, screenToWorld, onDrawingUpsert, drawColor, drawWidth, drawOwner]);
  // v7 #2: Circle block lifecycle. Same fix as freehand drawings —
  // session counter so the effect attaches listeners exactly once per
  // drag, ref-based reads, commit-once guard.
  const drawingCircleRef = useRef(null);
  drawingCircleRef.current = drawingCircle;
  const circleCommittedRef = useRef(true);
  const [circleSession, setCircleSession] = useState(0);
  useEffect(() => {
    if (circleSession === 0) return;
    circleCommittedRef.current = false;
    const onMove = (e) => {
      const world = screenToWorld(e.clientX, e.clientY);
      const cx = drawRef.current?.cx, cy = drawRef.current?.cy;
      if (cx === undefined || cy === undefined) return;
      const dx = world.x - cx, dy = world.y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      setDrawingCircle({ cx, cy, r });
    };
    const onUp = () => {
      if (circleCommittedRef.current) return;
      circleCommittedRef.current = true;
      const c = drawingCircleRef.current;
      setDrawingCircle(null);
      drawRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (c && c.r > 8) {
        onBlockUpsert?.({ id: uid('blk_'), type: 'circle', cx: c.cx, cy: c.cy, r: c.r });
      }
      onPlaceCircleBlockDone?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [circleSession, onBlockUpsert, onPlaceCircleBlockDone, screenToWorld]);

  // v6 #13: Block eraser. While the pointer is pressed, any block zone
  // whose hit-test shape contains the cursor's world position gets deleted.
  //   rect:   point-in-rect test (x,y,w,h)
  //   circle: distance ≤ r
  //   poly:   ray-casting (even-odd) point-in-polygon
  // pointInPoly is defined at module level (above) so it's hoisted and
  // usable in earlier hooks too.
  const eraseAtClient = useCallback((clientX, clientY) => {
    const world = screenToWorld(clientX, clientY);
    for (const z of blockZones) {
      let hit = false;
      if (z.type === 'poly' && Array.isArray(z.points) && z.points.length >= 3) {
        hit = pointInPoly(world.x, world.y, z.points);
      } else if (z.type === 'circle' && typeof z.cx === 'number') {
        const dx = world.x - z.cx, dy = world.y - z.cy;
        hit = (dx * dx + dy * dy) <= (z.r * z.r);
      } else {
        // Rect (legacy shape)
        hit = world.x >= z.x && world.x <= z.x + z.w
           && world.y >= z.y && world.y <= z.y + z.h;
      }
      if (hit) onBlockDelete?.(z.id);
    }
  }, [blockZones, onBlockDelete, screenToWorld]);

  useEffect(() => {
    if (!erasingActive) return;
    const onMove = (e) => eraseAtClient(e.clientX, e.clientY);
    const onUp = () => {
      setErasingActive(false);
      onPlaceEraseBlockDone?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [erasingActive, eraseAtClient, onPlaceEraseBlockDone]);
  useEffect(() => {
    if (!panning) return;
    const onMove = (e) => {
      const dx = e.clientX - panRef.current.startX;
      const dy = e.clientY - panRef.current.startY;
      setViewport(v => ({ ...v, x: panRef.current.vx + dx, y: panRef.current.vy + dy }));
    };
    const onUp = () => setPanning(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [panning]);

  // --- Wheel zoom ---
  const onWheel = (e) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.0015;
    const nextZoom = clamp(viewport.zoom * (1 + delta), 0.15, 4);
    const rect = wrapRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // keep mouse position stable
    const ratio = nextZoom / viewport.zoom;
    const nx = mx - (mx - viewport.x) * ratio;
    const ny = my - (my - viewport.y) * ratio;
    setViewport({ x: nx, y: ny, zoom: nextZoom });
  };
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewport]);

  // --- Token dragging ---
  //
  // v7.4 drag rewrite (replaces the buggy v7.3 rewrite).
  //
  // The v7.3 version froze closure state: its effect had `[]` deps so
  // `screenToWorld` was captured at mount and went stale the moment the
  // user panned or zoomed. It also removed the `forceRender` that was
  // applying the `.dragging` class during drag, so the CSS transition
  // `transition: left 220ms` kept interpolating every DOM write — the
  // token crawled behind the cursor by a fifth of a second.
  //
  // v7.4 fixes:
  //   - use refs for everything the handlers need to read, so the
  //     effect can still have `[]` deps AND read fresh values
  //     (screenToWorld, tokens, onTokenMove all via refs)
  //   - stamp `.dragging` directly on the token DOM node at drag
  //     start and strip it at drag end — no React re-render needed
  //     during drag, and more importantly the CSS transition is
  //     actually suppressed so the token follows the cursor 1:1
  //   - pointercancel / blur / visibilitychange still abort without
  //     committing (carries forward v7.3's mobile hardening)
  //   - pointerId still tracked so a second finger can't tear down
  //     the primary drag
  //   - before calling onTokenMove, we clear the DOM inline position
  //     so React's next render is authoritative
  const screenToWorldRef = useRef(screenToWorld);
  screenToWorldRef.current = screenToWorld;
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;
  const onTokenMoveRef = useRef(onTokenMove);
  onTokenMoveRef.current = onTokenMove;

  const startTokenDrag = (tokenId, e) => {
    const token = tokensRef.current[tokenId];
    if (!token) return;
    const point = e.touches ? e.touches[0] : e;
    const world = screenToWorldRef.current(point.clientX, point.clientY);
    dragTokenRef.current = {
      tokenId,
      offsetX: world.x - token.x,
      offsetY: world.y - token.y,
      lastX: token.x, lastY: token.y,
      pointerId: (e.pointerId != null) ? e.pointerId : null,
    };
    // Stamp the .dragging class directly on the DOM so:
    //  1. CSS suppresses the `transition: left/top 220ms` so the token
    //     follows the cursor 1:1 rather than easing into position
    //  2. z-index bumps above peers so the dragged token sits on top
    // No React re-render needed — we avoid touching React's render
    // cycle during drag entirely.
    const el = document.querySelector(`[data-tok="${tokenId}"]`);
    if (el) el.classList.add('dragging');
  };

  useEffect(() => {
    // End-of-drag helper. `commit` controls whether the move is sent
    // upstream. On pointerup: commit. On pointercancel / blur: abort.
    // Always clears dragTokenRef BEFORE calling onTokenMove so a
    // synchronous dispatch can't re-enter this code with a stale ref.
    const endDrag = (commit) => {
      const ref = dragTokenRef.current;
      if (!ref) return;
      dragTokenRef.current = null;
      const tokenEl = document.querySelector(`[data-tok="${ref.tokenId}"]`);
      if (tokenEl) {
        tokenEl.classList.remove('dragging');
        if (!commit) {
          // Abort path (pointercancel / blur / visibilitychange): clear
          // the inline style so React's next render snaps the token
          // back to its committed (unchanged) position.
          tokenEl.style.left = '';
          tokenEl.style.top = '';
        }
        // On commit: LEAVE the inline style in place. The token is
        // sitting at its final drop position. We're about to dispatch
        // TOKEN_MOVE which will re-render with the same coordinates;
        // React will reconcile the style prop and things stay put.
        // Clearing the inline style here would cause a 1-frame flash
        // back to the pre-drag position before React re-renders.
      }
      if (commit) {
        // v7.5: log the commit so we can trace the full chain when
        // propagation fails.
        console.log(`[plagues-call] drag end → commit token=${ref.tokenId.slice(-6)} x=${ref.lastX.toFixed(0)} y=${ref.lastY.toFixed(0)} cb=${typeof onTokenMoveRef.current === 'function'}`);
        onTokenMoveRef.current?.(ref.tokenId, ref.lastX, ref.lastY);
      } else {
        console.log(`[plagues-call] drag end → abort token=${ref.tokenId.slice(-6)}`);
      }
    };
    const matchesPointer = (e) => {
      const ref = dragTokenRef.current;
      if (!ref || ref.pointerId == null) return true;
      if (e?.pointerId == null) return true;
      return e.pointerId === ref.pointerId;
    };
    const onMove = (e) => {
      const ref = dragTokenRef.current;
      if (!ref) return;
      if (!matchesPointer(e)) return;
      const world = screenToWorldRef.current(e.clientX, e.clientY);
      const x = world.x - ref.offsetX;
      const y = world.y - ref.offsetY;
      ref.lastX = x;
      ref.lastY = y;
      const tokenEl = document.querySelector(`[data-tok="${ref.tokenId}"]`);
      if (tokenEl) {
        if (tokenEl.classList.contains('token-label-text')) {
          tokenEl.style.left = x + 'px';
          tokenEl.style.top = y + 'px';
        } else {
          tokenEl.style.left = (x - 18) + 'px';
          tokenEl.style.top = (y - 18) + 'px';
        }
      }
    };
    const onUp = (e) => {
      if (!matchesPointer(e)) return;
      endDrag(true);
    };
    const onCancel = (e) => {
      if (!matchesPointer(e)) return;
      endDrag(false);
    };
    const onBlur = () => endDrag(false);
    const onVisibilityChange = () => {
      if (document.hidden) endDrag(false);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (dragTokenRef.current) {
        const ref = dragTokenRef.current;
        dragTokenRef.current = null;
        const tokenEl = document.querySelector(`[data-tok="${ref.tokenId}"]`);
        if (tokenEl) {
          tokenEl.classList.remove('dragging');
          tokenEl.style.left = '';
          tokenEl.style.top = '';
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- HTML5 drag & drop from sidebar ---
  const onDragOver = (e) => {
    if (mode !== 'dm') return;
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = () => setDragOver(false);
  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (mode !== 'dm') return;
    const entityId = e.dataTransfer.getData('text/entity-id');
    if (!entityId) return;
    const world = screenToWorld(e.clientX, e.clientY);
    onPlaceEntity?.(entityId, world.x, world.y);
  };

  const zoomBy = (factor) => {
    const rect = wrapRef.current.getBoundingClientRect();
    const mx = rect.width / 2, my = rect.height / 2;
    const nextZoom = clamp(viewport.zoom * factor, 0.15, 4);
    const ratio = nextZoom / viewport.zoom;
    const nx = mx - (mx - viewport.x) * ratio;
    const ny = my - (my - viewport.y) * ratio;
    setViewport({ x: nx, y: ny, zoom: nextZoom });
  };
  const resetView = () => setViewport({ x: 0, y: 0, zoom: 1 });

  const canDragToken = (t) => {
    if (mode === 'dm') return true;
    const ent = entities[t.entityId];
    if (!ent) return false;
    if (ownedEntityIds && ownedEntityIds.has(ent.id)) return true;
    return claimedEntityId === ent.id;
  };

  const currentInitEntityId = initiative.active && initiative.entries[initiative.turn]?.entityId;

  // --- Tokens visible on this map ---
  const visibleTokens = useMemo(
    () => Object.values(tokens).filter(t => t.mapId === map?.id),
    [tokens, map?.id]
  );

  // Click-on-empty-canvas while in "placing reminder" mode → drops a reminder.
  const onStagePointerClick = (e) => {
    if (!placingReminder) return;
    // Ignore clicks on actual tokens (they have their own handlers)
    if (e.target.closest('.token')) return;
    if (e.target.closest('.reminder-pin')) return;
    const world = screenToWorld(e.clientX, e.clientY);
    const label = prompt('Reminder label (shown only to you)');
    if (!label) { onPlaceReminderDone?.(); return; }
    onReminderUpsert?.({
      id: uid('rem_'),
      mapId: map?.id || null,
      x: world.x,
      y: world.y,
      label: label.slice(0, 200),
      color: '#c9a34a',
    });
    onPlaceReminderDone?.();
  };

  return (
    <div
      ref={wrapRef}
      className={`canvas-wrap ${panning ? 'panning' : ''} ${dragOver ? 'can-drop' : ''} ${placingReminder ? 'placing-reminder' : ''} ${placingBlock ? 'placing-block' : ''} ${placingFreeBlock ? 'placing-free-block' : ''} ${placingCircleBlock ? 'placing-circle-block' : ''} ${erasingBlock ? 'erasing-block' : ''} ${measureMode ? 'measuring' : ''} ${drawMode ? 'drawing' : ''} ${placingHazard ? 'placing-hazard' : ''}`}
      onPointerDown={onWrapPointerDown}
      onClick={onStagePointerClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{ height: '100%', width: '100%' }}
    >
      <div
        ref={stageRef}
        className="canvas-stage"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom * (mapScale || 1)})`,
        }}
      >
        {map?.imageUrl ? (
          <img src={map.imageUrl} alt={map.name} className="map-image" draggable="false"
            onLoad={onMapImageLoad} />
        ) : null}

        {visibleTokens.map(t => {
          const ent = entities[t.entityId];
          if (!ent) return null;
          const isOwned = ownedEntityIds ? ownedEntityIds.has(ent.id) : claimedEntityId === ent.id;
          return (
            <TokenView
              key={t.id}
              token={t}
              entity={ent}
              isCurrent={currentInitEntityId === ent.id}
              isSelected={selectedTokenId === t.id}
              isMultiSelected={selectedTokenIds ? selectedTokenIds.has(t.id) : false}
              isMeasureStart={t2tStartId === t.id}
              canDrag={canDragToken(t)}
              isDraggingLocal={dragTokenRef.current?.tokenId === t.id}
              showLabel={mode === 'dm' || t.visible || isOwned}
              onStartDrag={(e) => startTokenDrag(t.id, e)}
              onDoubleClick={() => onTokenDoubleClick?.(t.id)}
              onSingleClick={(e) => {
                // v7 #3: token-to-token mode intercepts the click.
                // First click → record start. Second click → commit
                // measurement between the two token centers and clear.
                if (measureMode === 'tokenToToken') {
                  if (!t2tStartId) {
                    setT2tStartId(t.id);
                    return;
                  }
                  if (t2tStartId === t.id) {
                    // Same token clicked twice — cancel
                    setT2tStartId(null);
                    return;
                  }
                  const start = tokens[t2tStartId];
                  if (start && start.mapId === t.mapId) {
                    setMeasuring({ x0: start.x, y0: start.y, x1: t.x, y1: t.y });
                    if (measureTimerRef.current) clearTimeout(measureTimerRef.current);
                    measureTimerRef.current = setTimeout(() => {
                      setMeasuring(null);
                      measureTimerRef.current = null;
                    }, 1500);
                  }
                  setT2tStartId(null);
                  onMeasureModeDone?.();
                  return;
                }
                if (onTokenSingleClick) onTokenSingleClick(t.id, e);
              }}
              onContextMenu={mode === 'dm' ? (e) => onTokenContextMenu?.(t.id, e) : undefined}
              onHoverChange={onTokenHoverChange}
              mode={mode}
            />
          );
        })}

        {/* Reminder pins — private to this viewer.
            v4 fix #2: pointer-drag to move, right-click to delete. */}
        {reminders.filter(r => r.mapId === map?.id).map(r => (
          <div
            key={r.id}
            className="reminder-pin"
            style={{ left: r.x - 10, top: r.y - 26, color: r.color }}
            title={r.label + ' — drag to move, right-click to delete'}
            onPointerDown={(e) => {
              if (e.button !== 0) return; // only primary button starts a drag
              e.stopPropagation();
              e.preventDefault();
              const start = screenToWorld(e.clientX, e.clientY);
              const startRx = r.x, startRy = r.y;
              let dragged = false;
              const onMove = (ev) => {
                const world = screenToWorld(ev.clientX, ev.clientY);
                const dx = world.x - start.x;
                const dy = world.y - start.y;
                if (!dragged && Math.abs(dx) + Math.abs(dy) < 3) return;
                dragged = true;
                onReminderUpsert?.({ ...r, x: startRx + dx, y: startRy + dy });
              };
              const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
              };
              window.addEventListener('pointermove', onMove);
              window.addEventListener('pointerup', onUp);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (confirm(`Delete reminder "${r.label}"?`)) onReminderDelete?.(r.id);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (confirm(`Delete reminder "${r.label}"?`)) onReminderDelete?.(r.id);
            }}
          >
            <div className="reminder-pin-body">◆</div>
            <div className="reminder-pin-label">{r.label}</div>
          </div>
        ))}

        {/* v3/v4 #16: Block zones — now SVG-based with feathered edges and
            support for both rectangles and freeform polygon shapes.
            Rect zones: { id, x, y, w, h }
            Poly zones: { id, type: 'poly', points: [[x,y],...] }
            Rendered through a single SVG layer for both DM (editable dashed
            outlines) and player (solid occluders with blur feather). */}
        {(blockZones.length > 0 || drawingBlock || drawingPoly || drawingCircle) && (
          <svg className="block-zone-layer"
            xmlns="http://www.w3.org/2000/svg"
            style={{ position: 'absolute', left: -mapBounds.OFF, top: -mapBounds.OFF, width: mapBounds.W, height: mapBounds.H, pointerEvents: 'none', zIndex: mode === 'dm' ? 3 : 5, overflow: 'visible' }}
            viewBox={`${-mapBounds.OFF} ${-mapBounds.OFF} ${mapBounds.W} ${mapBounds.H}`}>
            <defs>
              {/* Gaussian blur = feathered edge on player-side occluders */}
              <filter id="block-feather" x="-10%" y="-10%" width="120%" height="120%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="3" />
              </filter>
            </defs>
            {blockZones.map(z => {
              const isPoly = z.type === 'poly' && Array.isArray(z.points) && z.points.length >= 3;
              const isCircle = z.type === 'circle' && typeof z.cx === 'number';
              if (mode === 'player') {
                // Solid near-black, feathered edges. pointer-events: none.
                const props = {
                  fill: '#040608',
                  stroke: '#040608',
                  strokeWidth: 2,
                  strokeLinejoin: 'round',
                  filter: 'url(#block-feather)',
                };
                if (isPoly) {
                  return <polygon key={z.id}
                    points={z.points.map(([x,y]) => `${x},${y}`).join(' ')}
                    {...props} />;
                }
                if (isCircle) {
                  return <circle key={z.id} cx={z.cx} cy={z.cy} r={z.r} {...props} />;
                }
                return <rect key={z.id} x={z.x} y={z.y} width={z.w} height={z.h} {...props} />;
              }
              // DM view — translucent dashed outline, clickable for delete
              const dmProps = {
                fill: 'rgba(160,60,60,0.18)',
                stroke: 'rgba(200,80,80,0.55)',
                strokeWidth: 2,
                strokeDasharray: '6 5',
                style: { pointerEvents: 'auto', cursor: 'pointer' },
                onDoubleClick: (e) => {
                  e.stopPropagation();
                  if (confirm('Delete this block zone?')) onBlockDelete?.(z.id);
                },
              };
              if (isPoly) {
                return <polygon key={z.id}
                  points={z.points.map(([x,y]) => `${x},${y}`).join(' ')}
                  {...dmProps}><title>Double-click to delete</title></polygon>;
              }
              if (isCircle) {
                return <circle key={z.id} cx={z.cx} cy={z.cy} r={z.r} {...dmProps}><title>Double-click to delete</title></circle>;
              }
              return <rect key={z.id} x={z.x} y={z.y} width={z.w} height={z.h} {...dmProps}><title>Double-click to delete</title></rect>;
            })}

            {/* In-progress rectangle preview */}
            {drawingBlock && mode === 'dm' && (
              <rect
                x={drawingBlock.x} y={drawingBlock.y}
                width={drawingBlock.w} height={drawingBlock.h}
                fill="rgba(200,80,80,0.22)"
                stroke="rgba(255,120,120,0.85)"
                strokeWidth="2"
                strokeDasharray="4 4" />
            )}

            {/* In-progress freeform polyline preview */}
            {drawingPoly && mode === 'dm' && drawingPoly.length >= 2 && (
              <polyline
                points={drawingPoly.map(([x,y]) => `${x},${y}`).join(' ')}
                fill="rgba(200,80,80,0.15)"
                stroke="rgba(255,120,120,0.85)"
                strokeWidth="2"
                strokeDasharray="4 4"
                strokeLinejoin="round"
                strokeLinecap="round" />
            )}

            {/* v6 #8: In-progress circle preview */}
            {drawingCircle && mode === 'dm' && drawingCircle.r > 2 && (
              <circle
                cx={drawingCircle.cx} cy={drawingCircle.cy} r={drawingCircle.r}
                fill="rgba(200,80,80,0.18)"
                stroke="rgba(255,120,120,0.9)"
                strokeWidth="2"
                strokeDasharray="4 4" />
            )}
          </svg>
        )}

        {/* v6 #10: Drawing overlay — freehand, line, and circle shapes
            stored per-map. Semi-transparent so map details are still
            visible underneath. Rendered at z-index 7 (above map, below
            token UI). Pointer-events: none so it never intercepts clicks. */}
        {(drawings.length > 0 || drawingNow) && (
          <svg className="drawing-layer"
            xmlns="http://www.w3.org/2000/svg"
            style={{ position: 'absolute', left: -mapBounds.OFF, top: -mapBounds.OFF, width: mapBounds.W, height: mapBounds.H, pointerEvents: 'none', zIndex: 7, overflow: 'visible' }}
            viewBox={`${-mapBounds.OFF} ${-mapBounds.OFF} ${mapBounds.W} ${mapBounds.H}`}>
            {drawings.map(d => {
              const stroke = d.color || '#c9a34a';
              const w = Math.max(1, d.width || 3);
              const commonProps = {
                stroke, strokeWidth: w, strokeLinecap: 'round', strokeLinejoin: 'round',
                fill: 'none', opacity: 0.75,
              };
              if (d.type === 'free' && Array.isArray(d.points) && d.points.length >= 2) {
                return <polyline key={d.id}
                  points={d.points.map(([x,y]) => `${x},${y}`).join(' ')}
                  {...commonProps} />;
              }
              if (d.type === 'line' && typeof d.x0 === 'number') {
                return <line key={d.id} x1={d.x0} y1={d.y0} x2={d.x1} y2={d.y1} {...commonProps} />;
              }
              if (d.type === 'circle' && typeof d.cx === 'number') {
                return <circle key={d.id} cx={d.cx} cy={d.cy} r={d.r} {...commonProps} />;
              }
              return null;
            })}
            {/* In-progress preview */}
            {drawingNow && (() => {
              const stroke = drawColor || '#c9a34a';
              const w = Math.max(1, drawWidth || 3);
              const p = { stroke, strokeWidth: w, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none', opacity: 0.9 };
              if (drawingNow.type === 'free' && drawingNow.points.length >= 2) {
                return <polyline points={drawingNow.points.map(([x,y]) => `${x},${y}`).join(' ')} {...p} />;
              }
              if (drawingNow.type === 'line') {
                return <line x1={drawingNow.x0} y1={drawingNow.y0} x2={drawingNow.x1} y2={drawingNow.y1} {...p} />;
              }
              if (drawingNow.type === 'circle') {
                return <circle cx={drawingNow.cx} cy={drawingNow.cy} r={drawingNow.r} {...p} />;
              }
              return null;
            })()}
          </svg>
        )}

        {/* v6 #9: Hazard polygon overlay — per-kind styling.
            Hidden hazards are filtered out for players in the sync layer,
            so this map sees only what the viewer should see. DM sees
            everything and gets an additional "HIDDEN" outline treatment
            for invisible hazards.
            v7.1 fix: dropped z-index from 6 to 3 (below the vision mask
            at z=4 and below the darkening overlay). Now hazards are
            obscured by darkness AND by block zones just like the map
            image is. The DM still sees everything because there's no
            vision mask in DM mode. Players in bright daylight see all
            visible hazards because no vision mask renders either. */}
        {hazards.length > 0 && (
          <svg className="hazard-layer"
            xmlns="http://www.w3.org/2000/svg"
            style={{ position: 'absolute', left: -mapBounds.OFF, top: -mapBounds.OFF, width: mapBounds.W, height: mapBounds.H, pointerEvents: 'none', zIndex: 3, overflow: 'visible' }}
            viewBox={`${-mapBounds.OFF} ${-mapBounds.OFF} ${mapBounds.W} ${mapBounds.H}`}><defs>
              <pattern id="hz-hatch-difficult" x="0" y="0" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="10" height="10" fill="rgba(140,100,60,0.18)" />
                <line x1="0" y1="0" x2="0" y2="10" stroke="rgba(180,130,70,0.6)" strokeWidth="1.5" />
              </pattern>
              <pattern id="hz-stipple-cold" x="0" y="0" width="6" height="6" patternUnits="userSpaceOnUse">
                <rect width="6" height="6" fill="rgba(180,220,240,0.25)" />
                <circle cx="3" cy="3" r="0.8" fill="rgba(230,245,255,0.85)" />
              </pattern>
              <filter id="hz-fog-blur"><feGaussianBlur stdDeviation="3" /></filter>
            </defs>
            {hazards.filter(h => h.type === 'polygon' && Array.isArray(h.points) && h.points.length >= 3).map(h => {
              const pts = h.points.map(([x,y]) => `${x},${y}`).join(' ');
              const hiddenDM = mode === 'dm' && h.visible === false;
              const baseProps = { points: pts, strokeLinejoin: 'round' };
              let style;
              switch (h.hazardKind) {
                case 'fire':
                  style = { fill: 'rgba(230,80,40,0.28)', stroke: 'rgba(255,120,60,0.85)', strokeWidth: 2 };
                  break;
                case 'flood':
                  style = { fill: 'rgba(60,120,200,0.28)', stroke: 'rgba(100,160,230,0.8)', strokeWidth: 2 };
                  break;
                case 'cold':
                  style = { fill: 'url(#hz-stipple-cold)', stroke: 'rgba(200,230,245,0.85)', strokeWidth: 1.5 };
                  break;
                case 'acid':
                  style = { fill: 'rgba(110,180,70,0.3)', stroke: 'rgba(150,210,90,0.85)', strokeWidth: 2 };
                  break;
                case 'fog':
                  style = { fill: 'rgba(180,180,190,0.45)', stroke: 'rgba(200,200,210,0.55)', strokeWidth: 1.5, filter: 'url(#hz-fog-blur)' };
                  break;
                case 'difficult':
                  style = { fill: 'url(#hz-hatch-difficult)', stroke: 'rgba(160,110,50,0.75)', strokeWidth: 1.5 };
                  break;
                default:
                  style = { fill: 'rgba(180,80,80,0.25)', stroke: 'rgba(220,100,100,0.8)', strokeWidth: 2 };
              }
              if (hiddenDM) {
                // DM view of an invisible hazard: dashed, lower opacity
                style = { ...style, fill: 'rgba(100,100,100,0.12)', stroke: 'rgba(180,180,180,0.7)', strokeWidth: 1.5, strokeDasharray: '6 4' };
              }
              const dmHandlers = mode === 'dm' ? {
                style: { pointerEvents: 'auto', cursor: 'pointer' },
                onDoubleClick: (e) => {
                  e.stopPropagation();
                  if (confirm(`Delete this ${h.hazardKind} hazard?`)) {
                    onHazardDelete?.(h.id);
                  }
                },
              } : {};
              return <polygon key={h.id} {...baseProps} {...style} {...dmHandlers}>
                <title>{h.hazardKind}{h.visible === false ? ' (hidden)' : ''}{h.label ? ` — ${h.label}` : ''}</title>
              </polygon>;
            })}
          </svg>
        )}

        {/* v6 #12: Selection box marquee (DM only, shift-drag) */}
        {selectionBox && mode === 'dm' && (() => {
          const x = Math.min(selectionBox.x0, selectionBox.x1);
          const y = Math.min(selectionBox.y0, selectionBox.y1);
          const w = Math.abs(selectionBox.x1 - selectionBox.x0);
          const h = Math.abs(selectionBox.y1 - selectionBox.y0);
          return (
            <div
              className="selection-marquee"
              style={{ left: x, top: y, width: w, height: h }}
            />
          );
        })()}

        {/* v6 #11: Measurement overlay — line or radius. Renders distance
            in feet using PX_PER_FOOT. Lives at the stage level so it
            scales with the map viewport. */}
        {measuring && (() => {
          const { x0, y0, x1, y1 } = measuring;
          const dx = x1 - x0, dy = y1 - y0;
          const distPx = Math.sqrt(dx * dx + dy * dy);
          const distFt = Math.round(distPx / PX_PER_FOOT);
          const isRadius = measureMode === 'radius' || (!measureMode && false);
          const midX = (x0 + x1) / 2, midY = (y0 + y1) / 2;
          return (
            <svg className="measure-overlay"
              xmlns="http://www.w3.org/2000/svg"
              style={{ position: 'absolute', left: -mapBounds.OFF, top: -mapBounds.OFF, width: mapBounds.W, height: mapBounds.H, pointerEvents: 'none', zIndex: 9, overflow: 'visible' }}
              viewBox={`${-mapBounds.OFF} ${-mapBounds.OFF} ${mapBounds.W} ${mapBounds.H}`}>
              {isRadius ? (
                <>
                  <circle cx={x0} cy={y0} r={distPx}
                    fill="rgba(212,165,116,0.08)"
                    stroke="rgba(212,165,116,0.85)"
                    strokeWidth="1.5"
                    strokeDasharray="4 3" />
                  <circle cx={x0} cy={y0} r={3} fill="rgba(212,165,116,0.95)" />
                </>
              ) : (
                <>
                  <line x1={x0} y1={y0} x2={x1} y2={y1}
                    stroke="rgba(212,165,116,0.95)"
                    strokeWidth="2"
                    strokeDasharray="5 3" />
                  <circle cx={x0} cy={y0} r={3} fill="rgba(212,165,116,0.95)" />
                  <circle cx={x1} cy={y1} r={3} fill="rgba(212,165,116,0.95)" />
                </>
              )}
              {/* Distance readout */}
              <foreignObject x={isRadius ? x0 : midX} y={isRadius ? y0 : midY} width="80" height="26"
                style={{ overflow: 'visible' }}>
                <div className="measure-label" style={{
                  transform: 'translate(-50%, -50%)',
                }}>
                  {distFt} ft{isRadius ? ' radius' : ''}
                </div>
              </foreignObject>
            </svg>
          );
        })()}

        {/* v3: Vision mask (player only). SVG layer at the world-stage level
            so it scales with zoom. A dark rectangle covers the whole map,
            and each vision source punches a soft-edged hole through it.
            v4 FIX: inverted the mask. In SVG masks, white = show, black = hide.
            We want the dark rect to BE HIDDEN where vision reaches (so the map
            is visible) and SHOWN everywhere else (so unlit areas stay dark).
            Correct mask: start WHITE (show the dark everywhere), then paint
            BLACK circles at each vision source (hide the dark → map visible). */}
        {mode === 'player' && visionEnabled && visionSources.length > 0 && (() => {
          const maskId = `vis-mask-${map.id}`;
          const { W, H, OFF } = mapBounds;
          return (
            <svg
              className="vision-mask"
              xmlns="http://www.w3.org/2000/svg"
              style={{ position: 'absolute', left: -OFF, top: -OFF, width: W, height: H, pointerEvents: 'none', zIndex: 4 }}
              viewBox={`${-OFF} ${-OFF} ${W} ${H}`}
            >
              <defs>
                {/* Radial gradients: black center (hide dark → reveal map)
                    fading to white at edge (show dark → hide map).
                    v7.1: slight "flame flicker" — the 70% stop position
                    is animated within a small range. Each source gets a
                    different phase (via begin offset and duration) so
                    they flicker asynchronously. The effect is subtle:
                    the vision circle's soft edge gently breathes. Only
                    sources that emit light (not pure darkvision) get
                    the flicker — clean darkvision stays stable. */}
                {visionSources.map((s, i) => {
                  const flickers = !!s.isLight; // set by compute*VisionSources when this is a light emitter
                  const phase = (i * 0.37) % 1;  // pseudo-random phase per source
                  const dur = 0.9 + ((i * 0.17) % 0.7); // 0.9–1.6s each
                  return (
                    <radialGradient key={i} id={`vg-${maskId}-${i}`}
                      cx={s.x} cy={s.y} r={s.radius}
                      gradientUnits="userSpaceOnUse">
                      <stop offset="0%"   stopColor="black" stopOpacity="1" />
                      <stop offset="70%"  stopColor="black" stopOpacity="1">
                        {flickers && (
                          <animate attributeName="offset"
                            values="68%;73%;69%;71%;70%;72%;70%"
                            dur={`${dur}s`}
                            begin={`-${phase * dur}s`}
                            repeatCount="indefinite" />
                        )}
                      </stop>
                      <stop offset="100%" stopColor="black" stopOpacity="0" />
                    </radialGradient>
                  );
                })}
                <mask id={maskId} maskUnits="userSpaceOnUse">
                  {/* Start WHITE — show the dark fill everywhere by default. */}
                  <rect x={-OFF} y={-OFF} width={W} height={H} fill="white" />
                  {/* Punch BLACK circles at vision sources — hides the dark
                      fill there, making the map visible underneath. */}
                  {visionSources.map((s, i) => (
                    <circle key={i}
                      cx={s.x} cy={s.y} r={s.radius}
                      fill={`url(#vg-${maskId}-${i})`} />
                  ))}
                  {/* Block zones paint WHITE on top → force dark fill to
                      show there even if vision would otherwise reveal them.
                      v4 #16: poly support. v6 #8: circle support. */}
                  {blockZones.map(z => {
                    if (z.type === 'poly' && Array.isArray(z.points) && z.points.length >= 3) {
                      return <polygon key={z.id}
                        points={z.points.map(([x,y]) => `${x},${y}`).join(' ')}
                        fill="white" />;
                    }
                    if (z.type === 'circle' && typeof z.cx === 'number') {
                      return <circle key={z.id} cx={z.cx} cy={z.cy} r={z.r} fill="white" />;
                    }
                    return <rect key={z.id} x={z.x} y={z.y} width={z.w} height={z.h} fill="white" />;
                  })}
                </mask>
              </defs>
              <rect x={-OFF} y={-OFF} width={W} height={H}
                fill="rgba(4,6,10,0.96)"
                mask={`url(#${maskId})`} />
            </svg>
          );
        })()}

        {/* v3: DM vision outlines — dashed circles per character so DM sees
            what each player can see. Rendered above the map, below tokens. */}
        {mode === 'dm' && visionSources.length > 0 && (
          <svg className="vision-outlines"
            xmlns="http://www.w3.org/2000/svg"
            style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible', zIndex: 2 }}>
            {visionSources.map((s, i) => (
              <circle key={i}
                cx={s.x} cy={s.y} r={s.radius}
                fill="none"
                stroke={s.color || '#4a7cbd'}
                strokeWidth="2"
                strokeDasharray="6 6"
                opacity="0.55" />
            ))}
          </svg>
        )}
      </div>

      {!map?.imageUrl && (
        <div className="map-empty">
          <div className="glyph">⚜</div>
          <div style={{ fontFamily: 'Cormorant Garamond, serif', fontStyle: 'italic', fontSize: 18 }}>
            {mode === 'dm'
              ? 'The canvas awaits. Upload a map image to begin.'
              : 'The realm is shrouded in mist.'}
          </div>
        </div>
      )}

      <div className="canvas-overlay top-right">
        <div className="zoom-controls">
          <button className="zoom-btn" title="Zoom in" onClick={() => zoomBy(1.2)}>＋</button>
          <button className="zoom-btn" title="Reset" onClick={resetView}>⌂</button>
          <button className="zoom-btn" title="Zoom out" onClick={() => zoomBy(1 / 1.2)}>－</button>
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// ENTITY FORM (create / edit entity)
// ====================================================================
function EntityForm({ initial, onSave, onCancel }) {
  const [entity, setEntity] = useState(() => initial || makeEntity());

  const update = (patch) => setEntity(e => ({ ...e, ...patch }));
  const updateStat = (stat, value) => setEntity(e => ({ ...e, stats: { ...e.stats, [stat]: Number(value) || 0 } }));
  const updateHp = (key, value) => setEntity(e => ({ ...e, hp: { ...e.hp, [key]: Number(value) || 0 } }));

  useEffect(() => {
    // if type changes, reset color if default
    if (Object.values(DEFAULT_COLORS).includes(entity.color)) {
      setEntity(e => ({ ...e, color: DEFAULT_COLORS[e.type] }));
    }
  }, [entity.type]);

  // Simple in-browser image upload. We downscale to at most 256×256 and
  // re-encode as JPEG (~0.8 quality) to keep the base64 sync payload small.
  const uploadImage = async () => {
    try {
      const dataUrl = await pickImage();
      if (!dataUrl) return;
      const img = new Image();
      img.onload = () => {
        const maxSide = 256;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const compressed = canvas.toDataURL('image/jpeg', 0.82);
        update({ imageUrl: compressed });
      };
      img.onerror = () => update({ imageUrl: dataUrl }); // fall back to raw
      img.src = dataUrl;
    } catch {}
  };

  // Shorthands
  const isHpType = entity.type !== 'Object';
  const isPlayerFacing = ['Monster','NPC','Neutral Beast','Object'].includes(entity.type);

  return (
    <div className="form-grid">
      <div className="form-row-2">
        <div>
          <label>Name</label>
          <input value={entity.name} onChange={e => update({ name: e.target.value })} />
        </div>
        <div>
          <label>Type</label>
          <select value={entity.type} onChange={e => update({ type: e.target.value })}>
            {ENTITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>

      {/* Portrait / token image */}
      <div>
        <label>Token Image <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— optional; falls back to colored token</span></label>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div className="portrait-preview" style={{ background: entity.color }}>
            {entity.imageUrl ? <img src={entity.imageUrl} alt="" draggable="false" /> : <span>{(entity.name || '?').slice(0,1).toUpperCase()}</span>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button className="btn sm" type="button" onClick={uploadImage}>⇧ Upload image</button>
            {entity.imageUrl && (
              <button className="btn sm ghost" type="button" onClick={() => update({ imageUrl: null })}>Remove image</button>
            )}
          </div>
        </div>
      </div>

      <div className="form-row-3">
        <div>
          <label>Color</label>
          <input type="color" value={entity.color} onChange={e => update({ color: e.target.value })} />
        </div>
        <div>
          <label>AC</label>
          <input type="number" value={entity.ac} onChange={e => update({ ac: Number(e.target.value) || 0 })} />
        </div>
        <div>
          <label>Speed</label>
          <input type="number" value={entity.speed} onChange={e => update({ speed: Number(e.target.value) || 0 })} />
        </div>
      </div>

      {isHpType && (
        <div className="form-row-3">
          <div>
            <label>HP Current</label>
            <input type="number" value={entity.hp.current} onChange={e => updateHp('current', e.target.value)} />
          </div>
          <div>
            <label>HP Max</label>
            <input type="number" value={entity.hp.max} onChange={e => updateHp('max', e.target.value)} />
          </div>
          <div>
            <label>Init Bonus</label>
            <input type="number" value={entity.initBonus} onChange={e => update({ initBonus: Number(e.target.value) || 0 })} />
          </div>
        </div>
      )}

      {/* Objects don't need a stat block but may still roll init if DM wants */}
      {entity.type === 'Object' && (
        <div className="form-row-2">
          <div>
            <label>Rolls Initiative?</label>
            <label className="toggle-row">
              <input type="checkbox"
                checked={!!entity.rollsInitiative}
                onChange={e => update({ rollsInitiative: e.target.checked })} />
              <span>{entity.rollsInitiative ? 'Included in initiative' : 'Static object — skipped'}</span>
            </label>
          </div>
          <div>
            <label>Init Bonus</label>
            <input type="number" value={entity.initBonus} disabled={!entity.rollsInitiative}
              onChange={e => update({ initBonus: Number(e.target.value) || 0 })} />
          </div>
        </div>
      )}

      {['PC','Monster','NPC','Familiar','Neutral Beast'].includes(entity.type) && (
        <div>
          <label>Ability Scores</label>
          <div className="form-row-6">
            {['str','dex','con','int','wis','cha'].map(s => (
              <div key={s} className="stat-box">
                <label>{s.toUpperCase()}</label>
                <input type="number" value={entity.stats[s]} onChange={e => updateStat(s, e.target.value)} />
                <div style={{ fontSize: 9, color: 'var(--ink-mute)', fontFamily: 'JetBrains Mono, monospace' }}>
                  {modFor(entity.stats[s]) >= 0 ? `+${modFor(entity.stats[s])}` : modFor(entity.stats[s])}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="form-row-2">
        <div>
          <label>Passive Perception</label>
          <input type="number" value={entity.passivePerception} onChange={e => update({ passivePerception: Number(e.target.value) || 0 })} />
        </div>
        {entity.type === 'PC' && (
          <div>
            <label>Level</label>
            <input type="number" value={entity.level} onChange={e => update({ level: Number(e.target.value) || 1 })} />
          </div>
        )}
        {entity.type === 'Monster' && (
          <div>
            <label>Challenge Rating</label>
            <input value={entity.cr} onChange={e => update({ cr: e.target.value })} />
          </div>
        )}
        {entity.type === 'NPC' && (
          <div>
            <label>Faction</label>
            <input value={entity.faction} onChange={e => update({ faction: e.target.value })} />
          </div>
        )}
        {entity.type === 'Familiar' && (
          <div>
            <label>Bonded To <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— the master PC name, if any</span></label>
            <input value={entity.faction} onChange={e => update({ faction: e.target.value })} placeholder="e.g. Caelum the wizard" />
          </div>
        )}
        {entity.type === 'Neutral Beast' && (
          <div>
            <label>Nature</label>
            <input value={entity.role} onChange={e => update({ role: e.target.value })} placeholder="e.g. deer, forest spirit" />
          </div>
        )}
        {entity.type === 'Object' && (
          <div>
            <label>Kind</label>
            <input value={entity.role} onChange={e => update({ role: e.target.value })} placeholder="e.g. altar, chest, rune" />
          </div>
        )}
      </div>

      {entity.type === 'PC' && (
        <div className="form-row-2">
          <div>
            <label>Class</label>
            <input value={entity.class} onChange={e => update({ class: e.target.value })} placeholder="e.g. Wizard" />
          </div>
          <div>
            <label>Player Name</label>
            <input value={entity.playerName} onChange={e => update({ playerName: e.target.value })} />
          </div>
        </div>
      )}

      {/* v5 fix #6: Sickness applies to any creature (not just PCs). */}
      {['PC','NPC','Monster','Neutral Beast','Familiar'].includes(entity.type) && (
        <div>
          <label>Sickness <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— DM-only setting; descriptor appears on tooltips and under the token</span></label>
          <div className="sickness-picker">
            {[0,1,2,3].map(lvl => (
              <button
                key={lvl}
                type="button"
                className={`sickness-btn ${entity.sickness === lvl ? 'active' : ''} sick-level-${lvl}`}
                onClick={() => update({ sickness: lvl })}
              >
                <span className="sickness-num">{lvl}</span>
                <span className="sickness-label">{lvl === 0 ? 'Healthy' : SICKNESS_DESCRIPTORS[lvl]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {(entity.type === 'Monster' || entity.type === 'Neutral Beast') && (
        <div>
          <label>Abilities / DM Notes</label>
          <textarea value={entity.abilities} onChange={e => update({ abilities: e.target.value })}
            placeholder="Multiattack, breath weapon, legendary actions…" />
        </div>
      )}

      {isPlayerFacing && (
        <div>
          <label>Player-Visible Description <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— shown to players when revealed / on hover</span></label>
          <textarea value={entity.playerDescription || ''} onChange={e => update({ playerDescription: e.target.value })}
            placeholder="A hulking brute draped in rusted chains. Its breath reeks of rot." />
        </div>
      )}

      {/* v3: Vision — darkvision and light-radius in feet. Used by the
          darkness / vision rendering system.
          v6 fix #7: Objects get a lightRadius input too (candles, torches,
          braziers, magical beacons). They don't see, so darkvision is
          hidden for objects. */}
      {['PC','Familiar','Monster','Neutral Beast','NPC'].includes(entity.type) && (
        <div>
          <label>Vision <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— darkvision + carried light (feet)</span></label>
          <div className="form-row-2">
            <div>
              <label style={{ fontSize: 9 }}>Darkvision</label>
              <input type="number" min="0" step="5" value={entity.darkvision || 0}
                onChange={e => update({ darkvision: Number(e.target.value) || 0 })} />
            </div>
            <div>
              <label style={{ fontSize: 9 }}>Light Radius</label>
              <input type="number" min="0" step="5" value={entity.lightRadius || 0}
                onChange={e => update({ lightRadius: Number(e.target.value) || 0 })} />
            </div>
          </div>
        </div>
      )}
      {entity.type === 'Object' && (
        <div>
          <label>Light Source <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— objects may emit light (feet)</span></label>
          <input type="number" min="0" step="5" value={entity.lightRadius || 0}
            onChange={e => update({ lightRadius: Number(e.target.value) || 0 })}
            placeholder="0 = no light" />
        </div>
      )}

      <div>
        <label>Conditions</label>
        <div className="cond-grid">
          {CONDITIONS.map(c => (
            <div
              key={c}
              className={`cond-chip ${entity.conditions.includes(c) ? 'active' : ''}`}
              onClick={() => update({
                conditions: entity.conditions.includes(c)
                  ? entity.conditions.filter(x => x !== c)
                  : [...entity.conditions, c]
              })}
            >{c}</div>
          ))}
        </div>
      </div>

      <div>
        <label>DM Notes <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— never shown to players</span></label>
        <textarea value={entity.notes} onChange={e => update({ notes: e.target.value })} />
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" onClick={() => onSave(entity)}>Save</button>
      </div>
    </div>
  );
}

// ====================================================================
// ENTITY SIDEBAR (DM)
// ====================================================================
function EntitySidebar({ state, dispatch, onEditEntity, onSelectEntity, selectedEntityId }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('All');
  const [showDead, setShowDead] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  const order = state.entityOrder || [];
  const entitiesByOrder = order.map(id => state.entities[id]).filter(Boolean);
  // include any entity not yet in entityOrder (should be migrated but defensive)
  for (const e of Object.values(state.entities)) {
    if (!order.includes(e.id)) entitiesByOrder.push(e);
  }

  // Filtering preserves order. We never mutate master order based on filter.
  const filtered = entitiesByOrder.filter(e => {
    if (filter !== 'All' && e.type !== filter) return false;
    if (!showDead && e.hp.current <= 0) return false;
    if (search && !e.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const newEntity = () => onEditEntity(makeEntity());
  const adjustHp = (id, delta) => dispatch({ type: 'ENTITY_HP_ADJUST', id, delta });

  // v3: Token preset shortcut. Creates a new entity pre-filled from a built-in
  // preset or a DM-saved custom preset, then opens the edit form so the DM
  // can tweak before saving.
  const newFromPreset = (preset) => {
    if (!preset) return;
    onEditEntity(makeEntity({ ...preset.entity }));
    setShowPresetMenu(false);
  };
  const [showPresetMenu, setShowPresetMenu] = useState(false);
  // Allow DM to save any entity as a custom preset via ENTITY_REORDER, stored
  // inside state.tokenPresets keyed by uid. Expose save/delete here.
  const saveAsPreset = (entity) => {
    const name = prompt('Preset name:', entity.name);
    if (!name) return;
    const id = uid('preset_');
    dispatch({
      type: 'TOKEN_PRESET_UPSERT',
      preset: {
        id, name,
        entity: { ...entity, id: undefined, imageUrl: entity.imageUrl || null },
      },
    });
  };
  const deletePreset = (id) => {
    if (!confirm('Delete this preset?')) return;
    dispatch({ type: 'TOKEN_PRESET_DELETE', id });
  };
  const allPresets = [
    ...BUILTIN_TOKEN_PRESETS,
    ...Object.values(state.tokenPresets || {}),
  ];

  const tokensByEntity = useMemo(() => {
    const m = {};
    Object.values(state.tokens).forEach(t => {
      if (t.mapId === state.currentMapId) m[t.entityId] = t;
    });
    return m;
  }, [state.tokens, state.currentMapId]);

  const toggleVisibility = (token) => {
    dispatch({ type: 'TOKEN_VISIBILITY', id: token.id, visible: !token.visible });
  };

  const handleCardClick = (e, entity) => {
    // Expand/collapse. Also notify parent for selection wiring (token highlight).
    setExpandedId(prev => prev === entity.id ? null : entity.id);
    onSelectEntity?.(entity.id);
  };

  // --- Drag-to-reorder logic ---
  // We use the same drag that places on map (dataTransfer entity-id),
  // but let the sidebar cards act as drop targets to reorder.
  const onCardDragStart = (ev, entity) => {
    ev.dataTransfer.setData('text/entity-id', entity.id);
    ev.dataTransfer.effectAllowed = 'copyMove';
    // Use the parent card element as the drag ghost so it doesn't look
    // like the user is dragging just a 12px handle grip.
    const card = ev.currentTarget.closest('.entity-card');
    if (card) {
      try { ev.dataTransfer.setDragImage(card, 20, 20); } catch {}
    }
  };
  const onCardDragOver = (ev, overEntity) => {
    // Only treat as reorder when no search filter differs from master — we still
    // allow it, but reorder maps to the master list.
    const draggingId = ev.dataTransfer.types.includes('text/entity-id');
    if (!draggingId) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    setDragOverId(overEntity.id);
  };
  const onCardDragLeave = () => setDragOverId(null);
  const onCardDrop = (ev, overEntity) => {
    ev.preventDefault();
    ev.stopPropagation(); // prevent canvas drop
    setDragOverId(null);
    const srcId = ev.dataTransfer.getData('text/entity-id');
    if (!srcId || srcId === overEntity.id) return;
    const base = state.entityOrder || [];
    const srcIdx = base.indexOf(srcId);
    const dstIdx = base.indexOf(overEntity.id);
    if (srcIdx === -1 || dstIdx === -1) return;
    // Drop-before-target semantics: remove src, then insert at the target's
    // index. Target shifts left by 1 if src was originally before it.
    const next = [...base];
    next.splice(srcIdx, 1);
    const insertAt = srcIdx < dstIdx ? dstIdx - 1 : dstIdx;
    next.splice(insertAt, 0, srcId);
    dispatch({ type: 'ENTITY_REORDER', order: next });
  };

  return (
    <>
      <div className="sidebar-section">
        <div className="sidebar-title">
          <span>Bestiary</span>
          <div style={{ display: 'flex', gap: 4, position: 'relative' }}>
            <button className="btn sm" onClick={() => setShowPresetMenu(v => !v)}
              title="Quick-create from a preset">
              ❈ Preset
            </button>
            <button className="btn sm primary" onClick={newEntity}>＋ New</button>
            {showPresetMenu && (
              <BestiaryMenu
                builtins={BUILTIN_TOKEN_PRESETS}
                custom={Object.values(state.tokenPresets || {})}
                onPick={newFromPreset}
                onDelete={deletePreset}
                onClose={() => setShowPresetMenu(false)}
              />
            )}
          </div>
        </div>
        <div className="search-row">
          <input placeholder="Search by name…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="filter-pills">
          {['All','PC','Monster','NPC','Familiar','Object','Label'].map(f => (
            <div key={f} className={`pill ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{f}</div>
          ))}
          <div className={`pill ${!showDead ? 'active' : ''}`} onClick={() => setShowDead(!showDead)}>
            {showDead ? 'Hide dead' : 'Show dead'}
          </div>
        </div>
      </div>
      <div className="sidebar-section grow">
        <div className="entity-list">
          {filtered.length === 0 && (
            <div className="empty-state">
              <span className="glyph">✦</span>
              {entitiesByOrder.length === 0 ? 'No entities yet. Forge one.' : 'No matching entities.'}
            </div>
          )}
          {filtered.map(e => {
            const onMap = tokensByEntity[e.id];
            const hpPct = e.hp.max > 0 ? e.hp.current / e.hp.max : 0;
            const hpClass = hpPct <= 0.25 ? 'critical' : hpPct <= 0.5 ? 'low' : '';
            const isDead = e.hp.current <= 0;
            const swatchClass = e.type === 'Monster' ? 'monster' : e.type === 'NPC' ? 'npc' : '';
            const expanded = expandedId === e.id;
            const selected = selectedEntityId === e.id;
            const dropping = dragOverId === e.id;
            return (
              <div
                key={e.id}
                className={`entity-card ${selected ? 'selected' : ''} ${isDead ? 'dead' : ''} ${expanded ? 'expanded' : ''} ${dropping ? 'drop-target' : ''}`}
                onDragOver={(ev) => onCardDragOver(ev, e)}
                onDragLeave={onCardDragLeave}
                onDrop={(ev) => onCardDrop(ev, e)}
              >
                <div
                  className="entity-card-row"
                  onClick={(ev) => handleCardClick(ev, e)}
                >
                  {/* Drag handle — draggable, used for reorder AND map placement */}
                  <div
                    className="drag-handle"
                    draggable
                    onDragStart={(ev) => { ev.stopPropagation(); onCardDragStart(ev, e); }}
                    onClick={(ev) => ev.stopPropagation()}
                    title="Drag to reorder or to place on map"
                  >⋮⋮</div>
                  <div className={`entity-swatch ${swatchClass}`} style={{ background: e.color }} />
                  <div className="entity-info">
                    <div className="entity-name">{e.name}</div>
                    <div className="entity-meta">
                      <span className="mono">{e.type === 'PC' ? `L${e.level} ${e.class||''}` : e.type === 'Monster' ? `CR ${e.cr}` : e.role || 'NPC'}</span>
                      <span className={`entity-hp ${hpClass} mono`}>{e.hp.current}/{e.hp.max}</span>
                      <span className="mono" style={{ color: 'var(--ink-mute)' }}>AC {e.ac}</span>
                    </div>
                  </div>
                  {/* Eye toggle — only shown when entity has a token on current map */}
                  {onMap && (
                    <button
                      className={`eye-btn ${onMap.visible ? 'on' : 'off'}`}
                      onClick={(ev) => { ev.stopPropagation(); toggleVisibility(onMap); }}
                      title={onMap.visible ? 'Visible to players — click to hide' : 'Hidden from players — click to reveal'}
                    >
                      {onMap.visible ? '👁' : '⦿'}
                    </button>
                  )}
                  <div className="entity-actions" onClick={ev => ev.stopPropagation()}>
                    <button className="btn sm danger" onClick={() => adjustHp(e.id, -1)} title="-1 HP">−</button>
                    <button className="btn sm" onClick={() => adjustHp(e.id, +1)} title="+1 HP">+</button>
                    <button className="btn sm" onClick={() => onEditEntity(e)} title="Edit full sheet">✎</button>
                  </div>
                </div>
                {expanded && <EntityStatBlock entity={e} onMap={onMap} />}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// Inline, expandable stat block shown when a DM clicks an entity card.
function EntityStatBlock({ entity, onMap }) {
  const e = entity;
  const hpPct = e.hp.max > 0 ? (e.hp.current / e.hp.max) * 100 : 0;
  const hpClass = hpPct <= 25 ? 'critical' : hpPct <= 50 ? 'low' : '';
  return (
    <div className="entity-expanded">
      <div className="statblock-row">
        <div className="statblock-cell">
          <div className="statblock-label">AC</div>
          <div className="statblock-value mono">{e.ac}</div>
        </div>
        <div className="statblock-cell">
          <div className="statblock-label">HP</div>
          <div className="statblock-value mono">
            {e.hp.current}<span style={{ color: 'var(--ink-mute)' }}>/{e.hp.max}</span>
          </div>
        </div>
        <div className="statblock-cell">
          <div className="statblock-label">Speed</div>
          <div className="statblock-value mono">{e.speed}</div>
        </div>
        <div className="statblock-cell">
          <div className="statblock-label">Init</div>
          <div className="statblock-value mono">{e.initBonus >= 0 ? `+${e.initBonus}` : e.initBonus}</div>
        </div>
      </div>
      <div className="statblock-hp-bar">
        <div className={`statblock-hp-fill ${hpClass}`} style={{ width: `${hpPct}%` }} />
      </div>
      <div className="statblock-stats">
        {['str','dex','con','int','wis','cha'].map(s => (
          <div key={s} className="statblock-stat">
            <div className="statblock-stat-label">{s.toUpperCase()}</div>
            <div className="statblock-stat-value mono">{e.stats[s]}</div>
            <div className="statblock-stat-mod mono">
              {modFor(e.stats[s]) >= 0 ? `+${modFor(e.stats[s])}` : modFor(e.stats[s])}
            </div>
          </div>
        ))}
      </div>
      {e.conditions.length > 0 && (
        <div className="statblock-conditions">
          {e.conditions.map(c => (
            <div key={c} className="cond-chip active" style={{ cursor: 'default' }}>{c}</div>
          ))}
        </div>
      )}
      {e.type === 'PC' && e.playerName && (
        <div className="statblock-note"><strong>Player:</strong> {e.playerName}</div>
      )}
      {e.type === 'Monster' && e.abilities && (
        <div className="statblock-note"><strong>Abilities:</strong><br />{e.abilities}</div>
      )}
      {e.type === 'Monster' && e.playerDescription && (
        <div className="statblock-note" style={{ borderColor: 'var(--gold-dim)' }}>
          <strong style={{ color: 'var(--gold)' }}>Player-Visible:</strong><br />{e.playerDescription}
        </div>
      )}
      {e.type === 'NPC' && (e.faction || e.role) && (
        <div className="statblock-note">
          {e.role && <><strong>Role:</strong> {e.role}<br /></>}
          {e.faction && <><strong>Faction:</strong> {e.faction}</>}
        </div>
      )}
      {e.notes && (
        <div className="statblock-note"><strong>DM Notes:</strong><br />{e.notes}</div>
      )}
      {onMap && (
        <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 6, fontStyle: 'italic' }}>
          ◆ Placed on current map {onMap.visible ? '— visible to players' : '— hidden from players'}
        </div>
      )}
    </div>
  );
}

// ====================================================================
// INITIATIVE TRACKER
// ====================================================================
function InitiativeTracker({ state, dispatch, mode, onClose }) {
  const { initiative, entities, currentMapId } = state;
  const rollAll = () => {
    const tokensHere = Object.values(state.tokens).filter(t => t.mapId === currentMapId);
    const entitiesHere = tokensHere.map(t => entities[t.entityId]).filter(Boolean);
    const entries = entitiesHere.map(e => ({
      entityId: e.id,
      roll: roll(20) + (e.initBonus || 0),
    }));
    entries.sort((a, b) => b.roll - a.roll || (entities[b.entityId]?.initBonus || 0) - (entities[a.entityId]?.initBonus || 0) || entities[a.entityId].name.localeCompare(entities[b.entityId].name));
    dispatch({ type: 'INIT_SET', initiative: { active: true, entries, turn: 0, round: 1 } });
  };

  const clearInit = () => dispatch({ type: 'INIT_SET', initiative: { active: false, entries: [], turn: 0, round: 1 } });
  const advance = () => dispatch({ type: 'INIT_ADVANCE' });

  const updateRoll = (entityId, newRoll) => {
    const entries = initiative.entries.map(e => e.entityId === entityId ? { ...e, roll: Number(newRoll) || 0 } : e);
    entries.sort((a, b) => b.roll - a.roll);
    dispatch({ type: 'INIT_SET', initiative: { ...initiative, entries } });
  };

  const removeEntry = (entityId) => {
    const entries = initiative.entries.filter(e => e.entityId !== entityId);
    const turn = Math.min(initiative.turn, Math.max(0, entries.length - 1));
    dispatch({ type: 'INIT_SET', initiative: { ...initiative, entries, turn } });
  };

  return (
    <FloatPanel style={{ right: 16, top: 80, width: 340 }}>
      <div className="float-panel-header">
        <span>⚔ Initiative · Round {initiative.round}</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        {mode === 'dm' && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            <button className="btn primary" onClick={rollAll}>🎲 Roll All</button>
            <button className="btn" onClick={advance} disabled={!initiative.entries.length}>⏭ Next Turn</button>
            <button className="btn danger" onClick={clearInit} disabled={!initiative.entries.length}>Clear</button>
          </div>
        )}
        <div className="init-list">
          {initiative.entries.length === 0 ? (
            <div className="empty-state"><span className="glyph">⚔</span>Initiative not yet rolled.</div>
          ) : initiative.entries.map((entry, idx) => {
            const e = entities[entry.entityId];
            if (!e) return null;
            // Players see HP only for PCs; monsters get a descriptor instead of numbers
            const showExactHp = mode === 'dm' || e.type === 'PC';
            const hpPctRaw = e.hp.max > 0 ? (e.hp.current / e.hp.max) * 100 : 0;
            const monsterStatus =
              hpPctRaw <= 0 ? 'Down' :
              hpPctRaw < 30 ? 'Waning' :
              hpPctRaw <= 70 ? 'Rough' :
              'Strong';
            return (
              <div key={entry.entityId} className={`init-entry ${idx === initiative.turn ? 'current' : ''}`}>
                {mode === 'dm' ? (
                  <input className="mono" type="number" value={entry.roll}
                    onChange={(ev) => updateRoll(entry.entityId, ev.target.value)}
                    style={{ width: 48, padding: 4, textAlign: 'center', fontWeight: 600 }} />
                ) : (
                  <div className="init-roll">{entry.roll}</div>
                )}
                <div className="entity-swatch" style={{ background: e.color, width: 10, height: 10 }} />
                <div className="init-name">{e.name}</div>
                {showExactHp ? (
                  <div className="init-hp">{e.hp.current}/{e.hp.max}</div>
                ) : (
                  <div className={`init-status status-${monsterStatus.toLowerCase()}`}>{monsterStatus}</div>
                )}
                {mode === 'dm' && (
                  <button className="btn sm ghost" onClick={() => removeEntry(entry.entityId)} title="Remove">×</button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// MAP MANAGER
// ====================================================================
function MapManager({ state, dispatch, onClose, toast }) {
  const [editing, setEditing] = useState(null);
  const maps = Object.values(state.maps);

  const newMap = () => {
    const id = uid('map_');
    setEditing({ id, name: 'New Map', type: 'region', parentId: null, imageUrl: null, notes: '', viewport: { x: 0, y: 0, zoom: 1 } });
  };

  const uploadImage = async () => {
    const data = await pickImage();
    if (data) setEditing({ ...editing, imageUrl: data });
  };

  const saveMap = () => {
    dispatch({ type: 'MAP_UPSERT', map: editing });
    setEditing(null);
    toast('Map saved', 'success');
  };

  const deleteMap = (id) => {
    if (!confirm('Delete this map and all its tokens?')) return;
    dispatch({ type: 'MAP_DELETE', id });
    toast('Map deleted');
  };

  if (editing) {
    return (
      <FloatPanel style={{ right: 16, top: 80, width: 400 }}>
        <div className="float-panel-header">
          <span>⌖ {state.maps[editing.id] ? 'Edit Map' : 'New Map'}</span>
          <button className="close-x" onClick={() => setEditing(null)}>×</button>
        </div>
        <div className="float-panel-body">
          <div className="form-grid">
            <div>
              <label>Name</label>
              <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div className="form-row-2">
              <div>
                <label>Type</label>
                <select value={editing.type} onChange={e => setEditing({ ...editing, type: e.target.value })}>
                  <option value="world">World</option>
                  <option value="region">Region</option>
                  <option value="city">City</option>
                  <option value="dungeon">Dungeon</option>
                  <option value="interior">Interior</option>
                  <option value="encounter">Encounter</option>
                </select>
              </div>
              <div>
                <label>Parent Map</label>
                <select value={editing.parentId || ''} onChange={e => setEditing({ ...editing, parentId: e.target.value || null })}>
                  <option value="">— None —</option>
                  {maps.filter(m => m.id !== editing.id).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label>Map Image</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn" onClick={uploadImage}>📁 Upload Image</button>
                {editing.imageUrl && (
                  <>
                    <img src={editing.imageUrl} style={{ height: 48, borderRadius: 4, border: '1px solid var(--border)' }} />
                    <button className="btn sm danger" onClick={() => setEditing({ ...editing, imageUrl: null })}>Clear</button>
                  </>
                )}
              </div>
              <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 4 }}>Embedded as base64 — stays in session.</div>
            </div>
            <div>
              <label>Notes (DM only)</label>
              <textarea value={editing.notes} onChange={e => setEditing({ ...editing, notes: e.target.value })} />
            </div>
            {/* v4 fix #14: map-level permanent darkness. Overrides the
                time-of-day system — the map is always treated as night,
                vision rules always apply. Good for dungeons & caves. */}
            <div className="toggle-row">
              <input type="checkbox" id="alwaysDark"
                checked={!!editing.alwaysDark}
                onChange={e => setEditing({ ...editing, alwaysDark: e.target.checked })} />
              <label htmlFor="alwaysDark" style={{ cursor: 'pointer' }}>
                Always dark <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— overrides time of day; vision rules always apply</span>
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn primary" onClick={saveMap}>Save Map</button>
            </div>
          </div>
        </div>
      </FloatPanel>
    );
  }

  return (
    <FloatPanel style={{ right: 16, top: 80, width: 360 }}>
      <div className="float-panel-header">
        <span>⌖ Maps & Realms</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        <button className="btn primary" onClick={newMap} style={{ marginBottom: 12 }}>＋ New Map</button>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {maps.map(m => {
            const parent = m.parentId ? state.maps[m.parentId]?.name : null;
            const isCurrent = state.currentMapId === m.id;
            return (
              <div key={m.id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: 10, borderRadius: 5,
                background: isCurrent ? 'rgba(212,165,116,0.1)' : 'var(--bg-0)',
                border: `1px solid ${isCurrent ? 'var(--gold-dim)' : 'var(--border-soft)'}`
              }}>
                {m.imageUrl && <img src={m.imageUrl} style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 3 }} />}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{m.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--ink-mute)' }}>
                    {m.type}{parent ? ` · in ${parent}` : ''}
                  </div>
                </div>
                <button className="btn sm" onClick={() => dispatch({ type: 'MAP_SWITCH', id: m.id })} disabled={isCurrent}>Go</button>
                <button className="btn sm ghost" onClick={() => setEditing(deepClone(m))}>✎</button>
                <button className="btn sm ghost" onClick={() => deleteMap(m.id)} disabled={maps.length <= 1}>×</button>
              </div>
            );
          })}
        </div>
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// PRESETS PANEL
// ====================================================================
// ====================================================================
// BESTIARY MENU  (v5 #11)
// ====================================================================
// Preset picker with search and filters. Replaces the older flat
// "Built-in / Custom" list once the preset catalog got large.
//
// Filters: category (Humanoid / Animal / Ooze / Object / …), type
// (PC/Monster/NPC/etc), and a free-text search by name.
// CR is only shown when present on a preset.
function BestiaryMenu({ builtins, custom, onPick, onDelete, onClose }) {
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('All');
  const [filterCategory, setFilterCategory] = useState('All');

  // Collect category options across the builtin set (plus "Custom" bucket)
  const categoryOptions = useMemo(() => {
    const s = new Set(['All']);
    for (const p of builtins) if (p.category) s.add(p.category);
    return Array.from(s);
  }, [builtins]);

  const typeOptions = ['All', 'PC', 'NPC', 'Monster', 'Familiar', 'Neutral Beast', 'Object', 'Label'];

  // Combine and filter
  const filtered = useMemo(() => {
    const all = [
      ...builtins.map(p => ({ ...p, _source: 'Built-in', _category: p.category || 'Other' })),
      ...custom.map(p => ({ ...p, _source: 'Custom',    _category: 'Custom' })),
    ];
    const q = search.trim().toLowerCase();
    return all.filter(p => {
      if (filterType !== 'All' && p.entity?.type !== filterType) return false;
      if (filterCategory !== 'All' && p._category !== filterCategory) return false;
      if (q) {
        const hay = `${p.name || ''} ${p.entity?.name || ''} ${p.entity?.role || ''} ${p._category}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [builtins, custom, search, filterType, filterCategory]);

  // Group by _category for display
  const grouped = useMemo(() => {
    const g = {};
    for (const p of filtered) {
      const k = p._category;
      if (!g[k]) g[k] = [];
      g[k].push(p);
    }
    return g;
  }, [filtered]);

  return (
    <div className="bestiary-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="preset-menu bestiary-menu bestiary-modal" onClick={e => e.stopPropagation()}>
      <div className="bestiary-header">
        <input
          className="bestiary-search"
          placeholder="Search bestiary…"
          autoFocus
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button className="close-x" onClick={onClose} title="Close">×</button>
      </div>
      <div className="bestiary-filters">
        <select className="bestiary-select" value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
          {categoryOptions.map(c => <option key={c} value={c}>{c === 'All' ? 'All categories' : c}</option>)}
          {custom.length > 0 && filterCategory !== 'Custom' && <option value="Custom">Custom</option>}
        </select>
        <select className="bestiary-select" value={filterType} onChange={e => setFilterType(e.target.value)}>
          {typeOptions.map(t => <option key={t} value={t}>{t === 'All' ? 'All types' : t}</option>)}
        </select>
      </div>
      <div className="bestiary-body">
        {filtered.length === 0 ? (
          <div className="bestiary-empty">No matches. Try clearing filters.</div>
        ) : Object.entries(grouped).map(([cat, items]) => (
          <div key={cat} className="bestiary-group">
            <div className="preset-menu-header">{cat} <span style={{ opacity: 0.5, fontWeight: 400 }}>· {items.length}</span></div>
            {items.map(p => (
              <div key={p.id} className="preset-menu-item bestiary-item" onClick={() => onPick(p)}>
                <div className="preset-menu-swatch" style={{ background: p.entity.color || '#888' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="preset-menu-name">
                    {p.name}
                    {p.cr && <span className="bestiary-cr">CR {p.cr}</span>}
                  </div>
                  <div className="preset-menu-type">
                    {p.entity.type}
                    {p.entity.role && <span className="bestiary-role"> — {p.entity.role}</span>}
                  </div>
                </div>
                {p._source === 'Custom' && (
                  <button className="preset-menu-del"
                    onClick={(e) => { e.stopPropagation(); onDelete?.(p.id); }}
                    title="Delete preset">×</button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="preset-menu-footer">
        Tap to create · drag a sidebar card → "Save as preset" to extend this list
      </div>
    </div>
    </div>
  );
}

// ====================================================================
// PRESETS PANEL  (encounter snapshots)
// ====================================================================
function PresetsPanel({ state, dispatch, onClose, toast }) {
  const [name, setName] = useState('');
  const presets = Object.values(state.presets);

  const savePreset = () => {
    if (!name.trim()) { toast('Enter a name', 'error'); return; }
    const tokensOnMap = Object.values(state.tokens).filter(t => t.mapId === state.currentMapId);
    const preset = {
      id: uid('preset_'),
      name: name.trim(),
      mapId: state.currentMapId,
      tokens: tokensOnMap.map(t => ({ ...t })),
    };
    dispatch({ type: 'PRESET_SAVE', preset });
    setName('');
    toast('Preset saved', 'success');
  };

  const loadPreset = (preset) => {
    if (!confirm(`Load "${preset.name}"? This replaces tokens on the target map.`)) return;
    // Remove current tokens on that map and restore preset tokens
    Object.keys(state.tokens).forEach(tid => {
      if (state.tokens[tid].mapId === preset.mapId) {
        dispatch({ type: 'TOKEN_REMOVE', id: tid });
      }
    });
    preset.tokens.forEach(t => {
      dispatch({ type: 'TOKEN_PLACE', token: { ...t, id: uid('tok_') } });
    });
    dispatch({ type: 'MAP_SWITCH', id: preset.mapId });
    toast('Preset loaded', 'success');
  };

  const overwritePreset = (preset) => {
    if (!confirm(`Overwrite "${preset.name}" with current state?`)) return;
    const tokensOnMap = Object.values(state.tokens).filter(t => t.mapId === state.currentMapId);
    dispatch({
      type: 'PRESET_SAVE',
      preset: { ...preset, mapId: state.currentMapId, tokens: tokensOnMap.map(t => ({ ...t })) }
    });
    toast('Preset overwritten', 'success');
  };

  const deletePreset = (id) => {
    if (!confirm('Delete this preset?')) return;
    dispatch({ type: 'PRESET_DELETE', id });
  };

  return (
    <FloatPanel style={{ right: 16, top: 80, width: 360 }}>
      <div className="float-panel-header">
        <span>❈ Encounter Presets</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          <input placeholder="Name this encounter…" value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && savePreset()} />
          <button className="btn primary" onClick={savePreset}>Save</button>
        </div>
        {presets.length === 0 ? (
          <div className="empty-state"><span className="glyph">❈</span>No saved encounters yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {presets.map(p => {
              const map = state.maps[p.mapId];
              return (
                <div key={p.id} style={{
                  padding: 10, borderRadius: 5,
                  background: 'var(--bg-0)', border: '1px solid var(--border-soft)'
                }}>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{p.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginBottom: 6 }}>
                    {p.tokens.length} tokens · {map?.name || 'unknown map'}
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn sm primary" onClick={() => loadPreset(p)}>Load</button>
                    <button className="btn sm" onClick={() => overwritePreset(p)}>Overwrite</button>
                    <button className="btn sm danger" onClick={() => deletePreset(p.id)}>×</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// TOKEN DETAIL PANEL
// ====================================================================
function TokenDetailPanel({ state, token, entity, mode, dispatch, onClose, claimedEntityId, playerActionSender, onLongRest }) {
  const [hpDelta, setHpDelta] = useState(0);

  if (!entity) return null;

  const isDM = mode === 'dm';
  const isOwnPC = entity.id === claimedEntityId;
  // v2: HP/AC/Speed get hidden from players for anything that isn't PC/Familiar.
  // Player's own PC and claimed familiars still show everything because
  // those flow through the own-sheet code paths.
  const isOpaqueForPlayer = !isDM && !PLAYER_HP_VISIBLE_TYPES.has(entity.type);

  // DM edits via local dispatch. Own-PC player edits go through playerActionSender
  // which routes through the DM as authority — keeping sync clean.
  const emitHpAdjust = (delta) => {
    if (isDM) {
      dispatch({ type: 'ENTITY_HP_ADJUST', id: entity.id, delta });
    } else if (isOwnPC && playerActionSender) {
      playerActionSender({ type: 'patch_own_entity', payload: { op: 'hp_adjust', delta } });
    }
  };
  const emitToggleCondition = (c) => {
    if (isDM) {
      dispatch({ type: 'ENTITY_TOGGLE_CONDITION', id: entity.id, condition: c });
    } else if (isOwnPC && playerActionSender) {
      playerActionSender({ type: 'patch_own_entity', payload: { op: 'toggle_condition', condition: c } });
    }
  };

  const applyHp = (sign) => {
    const d = Math.abs(hpDelta) * sign;
    if (d === 0) return;
    emitHpAdjust(d);
    setHpDelta(0);
  };

  const toggleVisibility = () => {
    dispatch({ type: 'TOKEN_VISIBILITY', id: token.id, visible: !token.visible });
  };

  const removeToken = () => {
    if (!confirm('Remove this token from the map?')) return;
    dispatch({ type: 'TOKEN_REMOVE', id: token.id });
    onClose();
  };

  // HP descriptor for monsters viewed by players
  const hpPctRaw = entity.hp.max > 0 ? (entity.hp.current / entity.hp.max) * 100 : 0;
  const monsterStatus =
    hpPctRaw <= 0 ? 'Down' :
    hpPctRaw < 30 ? 'Waning' :
    hpPctRaw <= 70 ? 'Rough' :
    'Strong';

  // v6 fix #3: Label entities get a simple state descriptor derived
  // from HP percentage. No AC, Speed, Passive Perception, or conditions.
  //    70%+     → no label (pristine)
  //    50–70%   → "Damaged"
  //    20–50%   → "Derelict"
  //    0–20%    → "Ruins"
  // Labels whose max HP is 0 are considered pristine (no damage state).
  const labelState =
    entity.type === 'Label' && entity.hp.max > 0
      ? (hpPctRaw > 70 ? null
        : hpPctRaw > 50 ? 'Damaged'
        : hpPctRaw > 20 ? 'Derelict'
        : 'Ruins')
      : null;

  const canEditHp = isDM || isOwnPC;
  const canEditConditions = isDM || isOwnPC;

  // v6 fix #3: Label entities get a dedicated minimal panel — no HP
  // numbers, no AC/Speed/Conditions, just the name + a state descriptor
  // and optional player-visible description (map lore).
  if (entity.type === 'Label') {
    return (
      <FloatPanel style={{ left: 16, top: 80, width: 300 }}>
        <div className="float-panel-header">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="bestiary-role" style={{ fontStyle: 'normal', color: entity.color || '#c9a34a', fontFamily: 'Cinzel, serif', letterSpacing: '0.1em' }}>
              ✦
            </span>
            {entity.name}
          </span>
          <button className="close-x" onClick={onClose}>×</button>
        </div>
        <div className="float-panel-body">
          <div style={{ fontSize: 11, color: 'var(--ink-dim)', marginBottom: 8, fontStyle: 'italic' }}>
            Map label
          </div>
          {labelState && (
            <div className={`label-state-chip state-${labelState.toLowerCase()}`}>
              {labelState}
            </div>
          )}
          {entity.playerDescription && (
            <div className="statblock-note" style={{ marginTop: 10 }}>
              <em>{entity.playerDescription}</em>
            </div>
          )}
          {isDM && (
            <>
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-soft)' }}>
                <label style={{ fontSize: 10 }}>HP (drives state descriptor)</label>
                <div className="form-row-2">
                  <input type="number" value={entity.hp.current}
                    onChange={e => dispatch({ type: 'ENTITY_PATCH', id: entity.id, patch: { hp: { ...entity.hp, current: Number(e.target.value) || 0 } } })} />
                  <input type="number" value={entity.hp.max}
                    onChange={e => dispatch({ type: 'ENTITY_PATCH', id: entity.id, patch: { hp: { ...entity.hp, max: Number(e.target.value) || 0 } } })} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <button className="btn sm" onClick={toggleVisibility}>{token.visible ? '🕶 Hide' : '👁 Reveal'}</button>
                <button className="btn sm danger" onClick={removeToken}>✕ Remove</button>
              </div>
            </>
          )}
        </div>
      </FloatPanel>
    );
  }

  return (
    <FloatPanel style={{ left: 16, top: 80, width: 340 }}>
      <div className="float-panel-header">
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="entity-swatch" style={{ background: entity.color, width: 12, height: 12 }} />
          {entity.name}
          {isOwnPC && <span className="own-pc-badge">YOU</span>}
        </span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
          {!isOpaqueForPlayer && (
            <div style={{ textAlign: 'center', padding: 8, background: 'var(--bg-0)', borderRadius: 4, border: '1px solid var(--border-soft)' }}>
              <div style={{ fontSize: 10, color: 'var(--ink-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>AC</div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 600, color: 'var(--gold)' }}>{entity.ac}</div>
            </div>
          )}
          <div style={{ textAlign: 'center', padding: 8, background: 'var(--bg-0)', borderRadius: 4, border: '1px solid var(--border-soft)' }}>
            <div style={{ fontSize: 10, color: 'var(--ink-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>HP</div>
            {isOpaqueForPlayer ? (
              <div className={`status-label status-${monsterStatus.toLowerCase()}`}>{monsterStatus}</div>
            ) : (
              <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{entity.hp.current}<span style={{ color: 'var(--ink-mute)', fontSize: 12 }}>/{entity.hp.max}</span></div>
            )}
          </div>
          {!isOpaqueForPlayer && (
            <div style={{ textAlign: 'center', padding: 8, background: 'var(--bg-0)', borderRadius: 4, border: '1px solid var(--border-soft)' }}>
              <div style={{ fontSize: 10, color: 'var(--ink-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Speed</div>
              <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{entity.speed}</div>
            </div>
          )}
        </div>

        <div style={{ fontSize: 11, color: 'var(--ink-dim)', marginBottom: 8 }}>
          {entity.type === 'PC' && `Level ${entity.level} ${entity.class || ''}${entity.playerName ? ` · ${entity.playerName}` : ''}`}
          {entity.type === 'Monster' && isDM && `CR ${entity.cr}`}
          {entity.type === 'NPC' && (entity.faction ? `${entity.role} · ${entity.faction}` : entity.role || 'NPC')}
        </div>

        {isOpaqueForPlayer && entity.playerDescription && (
          <div className="statblock-note" style={{ marginBottom: 10 }}>
            {entity.playerDescription}
          </div>
        )}

        {canEditHp && (
          <>
            <label>Adjust HP {isOwnPC && !isDM && <span style={{ color: 'var(--gold-dim)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— your character</span>}</label>
            <div className="hp-adjuster" style={{ marginBottom: 10 }}>
              <button className="btn danger" onClick={() => applyHp(-1)}>− Damage</button>
              <input type="number" value={hpDelta} onChange={e => setHpDelta(Math.abs(Number(e.target.value)) || 0)} />
              <button className="btn" onClick={() => applyHp(+1)}>+ Heal</button>
            </div>
          </>
        )}

        <div style={{ marginBottom: 10 }}>
          <label>Conditions</label>
          <div className="cond-grid">
            {CONDITIONS.slice(0, 15).map(c => (
              <div
                key={c}
                className={`cond-chip ${entity.conditions.includes(c) ? 'active' : ''}`}
                onClick={canEditConditions ? () => emitToggleCondition(c) : undefined}
                style={{ cursor: canEditConditions ? 'pointer' : 'default' }}
              >{c}</div>
            ))}
          </div>
        </div>

        {isDM && entity.type === 'Monster' && entity.abilities && (
          <div style={{ marginBottom: 10 }}>
            <label>Abilities</label>
            <div style={{ fontSize: 12, padding: 8, background: 'var(--bg-0)', borderRadius: 4, whiteSpace: 'pre-wrap' }}>{entity.abilities}</div>
          </div>
        )}

        {isDM && entity.notes && (
          <div style={{ marginBottom: 10 }}>
            <label>DM Notes</label>
            <div style={{ fontSize: 12, padding: 8, background: 'var(--bg-0)', borderRadius: 4, whiteSpace: 'pre-wrap' }}>{entity.notes}</div>
          </div>
        )}

        {/* v3: DM-only death save tracker (PCs only). Counters clamp 0–3. */}
        {isDM && entity.type === 'PC' && (
          <div style={{ marginBottom: 10 }}>
            <label>Death Saves <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— DM only</span></label>
            <div className="death-saves">
              <div className="death-saves-row">
                <span className="death-saves-label good">Successes</span>
                <div className="death-pip-row">
                  {[1,2,3].map(n => {
                    const filled = (entity.deathSaves?.successes || 0) >= n;
                    return (
                      <button key={n} type="button"
                        className={`death-pip success ${filled ? 'filled' : ''}`}
                        onClick={() => dispatch({ type: 'DEATH_SAVE_SET', id: entity.id,
                          successes: filled && (entity.deathSaves?.successes === n) ? n - 1 : n })}
                        title={`Set successes to ${n}`}>✓</button>
                    );
                  })}
                </div>
              </div>
              <div className="death-saves-row">
                <span className="death-saves-label bad">Failures</span>
                <div className="death-pip-row">
                  {[1,2,3].map(n => {
                    const filled = (entity.deathSaves?.failures || 0) >= n;
                    return (
                      <button key={n} type="button"
                        className={`death-pip failure ${filled ? 'filled' : ''}`}
                        onClick={() => dispatch({ type: 'DEATH_SAVE_SET', id: entity.id,
                          failures: filled && (entity.deathSaves?.failures === n) ? n - 1 : n })}
                        title={`Set failures to ${n}`}>✗</button>
                    );
                  })}
                </div>
              </div>
              {(entity.deathSaves?.successes > 0 || entity.deathSaves?.failures > 0) && (
                <button className="btn sm ghost" style={{ marginTop: 4 }}
                  onClick={() => dispatch({ type: 'DEATH_SAVE_CLEAR', id: entity.id })}>
                  Clear death saves
                </button>
              )}
            </div>
          </div>
        )}

        {/* v3/v5: Familiar bonding. v5 refinement — bond by PC *name*
            (entity id) rather than peer id. Whichever player currently
            claims that PC gets movement rights automatically; if the PC
            is unclaimed, the bond is dormant. This keeps the bond stable
            across player reconnects (peer ids change but entity ids are
            permanent). bondedPeerId is derived at permission-check time. */}
        {isDM && entity.type === 'Familiar' && state && (
          <div style={{ marginBottom: 10 }}>
            <label>Bonded with <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— grants movement rights to whoever claims this PC</span></label>
            <select
              className="mono"
              value={entity.bondedPcId || ''}
              onChange={(e) => {
                const pcId = e.target.value || null;
                dispatch({ type: 'ENTITY_PATCH', id: entity.id, patch: { bondedPcId: pcId } });
              }}
              style={{ width: '100%' }}>
              <option value="">— unbonded —</option>
              {Object.values(state.entities)
                .filter(ent => ent.type === 'PC')
                .map(pc => {
                  const claim = Object.values(state.claims || {}).find(c => c.pc === pc.id);
                  return (
                    <option key={pc.id} value={pc.id}>
                      {pc.name}{claim?.playerName ? ` (${claim.playerName})` : ' — unclaimed'}
                    </option>
                  );
                })}
            </select>
            {entity.bondedPcId && (() => {
              const pc = state.entities[entity.bondedPcId];
              const claim = pc && Object.values(state.claims || {}).find(c => c.pc === pc.id);
              if (!pc) return <div className="settings-hint">Bonded PC no longer exists.</div>;
              if (!claim) return <div className="settings-hint">Bond is dormant — no player has claimed {pc.name} yet.</div>;
              return <div className="settings-hint">{claim.playerName || 'A player'} controls this familiar.</div>;
            })()}
          </div>
        )}

        {/* v3: Vision stats — darkvision + light radius (DM-only edit) */}
        {isDM && ['PC','Familiar','Monster','Neutral Beast','NPC'].includes(entity.type) && (
          <div style={{ marginBottom: 10 }}>
            <label>Vision <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— used by the darkness system</span></label>
            <div className="form-row-2">
              <div>
                <label style={{ fontSize: 9 }}>Darkvision (ft)</label>
                <input type="number" min="0" step="5" value={entity.darkvision || 0}
                  onChange={(e) => dispatch({ type: 'ENTITY_PATCH', id: entity.id, patch: { darkvision: Number(e.target.value) || 0 } })} />
              </div>
              <div>
                <label style={{ fontSize: 9 }}>Light Radius (ft)</label>
                <input type="number" min="0" step="5" value={entity.lightRadius || 0}
                  onChange={(e) => dispatch({ type: 'ENTITY_PATCH', id: entity.id, patch: { lightRadius: Number(e.target.value) || 0 } })} />
              </div>
            </div>
          </div>
        )}

        {/* v2/v5 fix #6: DM sickness editor. v5 widens to NPC/Monster/
            Neutral Beast/Familiar (previously PC-only). The descriptor
            is still the only thing players see — no numeric leak. */}
        {isDM && ['PC','NPC','Monster','Neutral Beast','Familiar'].includes(entity.type) && (
          <div style={{ marginBottom: 10 }}>
            <label>Sickness <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— creeping pallor on this player's view</span></label>
            <div className="sickness-picker">
              {[0,1,2,3].map(lvl => (
                <button
                  key={lvl}
                  type="button"
                  className={`sickness-btn ${entity.sickness === lvl ? 'active' : ''} sick-level-${lvl}`}
                  onClick={() => dispatch({ type: 'SET_SICKNESS', id: entity.id, level: lvl })}
                >
                  <span className="sickness-num">{lvl}</span>
                  <span className="sickness-label">{lvl === 0 ? 'Healthy' : SICKNESS_DESCRIPTORS[lvl]}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* v2: DM-only per-token scale slider. Lets bosses grow, imps shrink. */}
        {isDM && (
          <div style={{ marginBottom: 10 }}>
            <label>Token Size <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— scale on this map</span></label>
            <div className="scale-row">
              <button className="btn sm" onClick={() => dispatch({ type: 'TOKEN_SCALE', id: token.id, scale: Math.max(0.3, (token.scale || 1) - 0.1) })}>−</button>
              <input type="range" min="0.3" max="4" step="0.05"
                value={token.scale || 1}
                onChange={(e) => dispatch({ type: 'TOKEN_SCALE', id: token.id, scale: Number(e.target.value) })} />
              <button className="btn sm" onClick={() => dispatch({ type: 'TOKEN_SCALE', id: token.id, scale: Math.min(4, (token.scale || 1) + 0.1) })}>+</button>
              <span className="mono scale-value">{((token.scale || 1) * 100).toFixed(0)}%</span>
              <button className="btn sm ghost" onClick={() => dispatch({ type: 'TOKEN_SCALE', id: token.id, scale: 1 })}>Reset</button>
            </div>
          </div>
        )}

        {isDM && (
          <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn" onClick={toggleVisibility}>
              {token.visible ? '🕶 Hide from players' : '👁 Reveal to players'}
            </button>
            {onLongRest && (entity.type === 'PC' || entity.type === 'Familiar') && (
              <button className="btn" onClick={() => onLongRest(entity.id)} title="Long rest this character only">⛭ Rest</button>
            )}
            <button className="btn danger" onClick={removeToken}>Remove</button>
          </div>
        )}
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// TOKEN TOOLTIP  (hover info — DM sees full, player sees public subset)
// ====================================================================
// Small floating chip that follows the cursor. Not a React portal (lives
// inside the canvas container) so its coordinates are viewport-relative.
function TokenTooltip({ hovered, entities, mode, x, y }) {
  if (!hovered) return null;
  const ent = entities[hovered.entityId];
  if (!ent) return null;
  const isDM = mode === 'dm';
  const showHp = isDM || PLAYER_HP_VISIBLE_TYPES.has(ent.type);
  const hpPct = ent.hp.max > 0 ? (ent.hp.current / ent.hp.max) * 100 : 0;
  const status = hpPct <= 0 ? 'Down' : hpPct < 30 ? 'Waning' : hpPct <= 70 ? 'Rough' : 'Strong';
  const description = isDM
    ? (ent.notes || ent.playerDescription || '')
    : (ent.playerDescription || '');
  // v3: sickness as diegetic text — shows for DM always; for players only on
  // entities whose sickness survived the filter (i.e. their own owned PC).
  const sicknessLabel = SICKNESS_DESCRIPTORS[ent.sickness || 0] || '';
  return (
    <div className="token-tooltip" style={{ left: x + 16, top: y + 16 }}>
      <div className="token-tooltip-header">
        <span className="token-tooltip-name">{ent.name}</span>
        <span className={`token-tooltip-type type-${TOKEN_SHAPE_CLASS[ent.type] || 'npc'}`}>{ent.type}</span>
      </div>
      {ent.hp.max > 0 && (
        showHp
          ? <div className="token-tooltip-hp mono">HP {ent.hp.current}/{ent.hp.max}</div>
          : <div className={`status-label status-${status.toLowerCase()}`}>{status}</div>
      )}
      {sicknessLabel && (
        <div className={`token-tooltip-sickness sick-level-${ent.sickness}`}>
          <em>{sicknessLabel.toLowerCase()}</em>
        </div>
      )}
      {description && <div className="token-tooltip-desc">{description}</div>}
      {ent.conditions.length > 0 && (
        <div className="token-tooltip-conds">
          {ent.conditions.map(c => (
            <span key={c} className="party-cond-pill" style={{ background: CONDITION_COLORS[c] || '#555' }}>{c}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ====================================================================
// SETTINGS MODAL  (theme + global map scale)
// ====================================================================
function SettingsModal({ settings, onChange, onClose, mode, mapScale, onMapScaleChange }) {
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal slide-up" style={{ maxWidth: 460 }}>
        <div className="float-panel-header">
          <span>⚙ Settings</span>
          <button className="close-x" onClick={onClose}>×</button>
        </div>
        <div className="float-panel-body">
          <div className="settings-section">
            <label className="settings-label">Theme</label>
            <div className="theme-switch">
              <button
                className={`theme-option ${settings.theme === 'dark' ? 'active' : ''}`}
                onClick={() => onChange({ theme: 'dark' })}
              >
                <span className="theme-swatch dark" />
                <span>Dark Sanctum</span>
                <span className="theme-sub">Navy · gilded</span>
              </button>
              <button
                className={`theme-option ${settings.theme === 'light' ? 'active' : ''}`}
                onClick={() => onChange({ theme: 'light' })}
              >
                <span className="theme-swatch light" />
                <span>Warm Tavern</span>
                <span className="theme-sub">Parchment · oak</span>
              </button>
            </div>
          </div>

          {mode === 'dm' && (
            <div className="settings-section">
              <label className="settings-label">Map Scale <span className="settings-label-sub">— how large the map feels relative to tokens</span></label>
              <div className="scale-row">
                <button className="btn sm" onClick={() => onMapScaleChange(Math.max(0.3, (mapScale || 1) - 0.1))}>−</button>
                <input type="range" min="0.3" max="3" step="0.05"
                  value={mapScale || 1}
                  onChange={(e) => onMapScaleChange(Number(e.target.value))} />
                <button className="btn sm" onClick={() => onMapScaleChange(Math.min(3, (mapScale || 1) + 0.1))}>+</button>
                <span className="mono scale-value">{((mapScale || 1) * 100).toFixed(0)}%</span>
                <button className="btn sm ghost" onClick={() => onMapScaleChange(1)}>Reset</button>
              </div>
              <div className="settings-hint">
                Scales the entire map rendering uniformly. Pan/zoom still works on top.
              </div>
            </div>
          )}

          <div className="settings-section">
            <div className="settings-hint" style={{ fontStyle: 'italic', color: 'var(--ink-mute)' }}>
              Preferences are stored on this device only.
            </div>
          </div>

          {mode === 'player' && (
            <div className="settings-section">
              <label className="settings-label">Sickness Effects</label>
              <div className="toggle-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  id="sickness-effects-toggle"
                  type="checkbox"
                  checked={settings.sicknessEffects !== false}
                  onChange={e => onChange({ sicknessEffects: e.target.checked })}
                  style={{ width: 16, height: 16, accentColor: 'var(--gold)', cursor: 'pointer' }}
                />
                <label htmlFor="sickness-effects-toggle" style={{ cursor: 'pointer', fontSize: 13 }}>
                  Screen wobble &amp; vignette when your character is sluggish or sick
                </label>
              </div>
              <div className="settings-hint">
                Disable if you find the motion distracting or experience motion sensitivity.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// LIVE INPUT  (v4 fix #6)
// ====================================================================
// Controlled input whose draft value is local while the user is typing,
// and only commits to the parent on blur or Enter. Fixes the "mid-typing
// state snaps back" bug on the player sheet — when the DM re-broadcasts
// state on every keystroke, the original input's `value={entity.x}`
// would overwrite the user's in-progress typing.
//
// Usage:
//   <LiveInput value={entity.name} onCommit={v => setField({ name: v })} />
//   <LiveNumberInput value={entity.ac} onCommit={v => setField({ ac: v })} min={0} max={30} />
//
// `value` is only read from props when the input is NOT focused, so server
// updates during typing are ignored until the user leaves the field.
function LiveInput({ value, onCommit, className, placeholder, type = 'text', style }) {
  const [draft, setDraft] = useState(value ?? '');
  const [focused, setFocused] = useState(false);
  // Sync from props when the external value changes AND the user isn't
  // editing right now (otherwise we'd overwrite their in-progress input).
  useEffect(() => {
    if (!focused) setDraft(value ?? '');
  }, [value, focused]);
  const commit = () => {
    const next = draft;
    if (next === (value ?? '')) return; // no-op
    onCommit?.(next);
  };
  return (
    <input
      type={type}
      className={className}
      placeholder={placeholder}
      style={style}
      value={draft}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === 'Escape') { setDraft(value ?? ''); e.currentTarget.blur(); }
      }}
    />
  );
}

// Same pattern but coerces to number, clamps, and commits a numeric value.
function LiveNumberInput({ value, onCommit, className, min, max, step = 1, style }) {
  const [draft, setDraft] = useState(String(value ?? 0));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(String(value ?? 0));
  }, [value, focused]);
  const commit = () => {
    let n = Number(draft);
    if (!isFinite(n)) n = Number(value) || 0;
    if (typeof min === 'number') n = Math.max(min, n);
    if (typeof max === 'number') n = Math.min(max, n);
    // Re-normalize the draft to what we actually committed (handles "5x" → 5)
    setDraft(String(n));
    if (n === Number(value)) return;
    onCommit?.(n);
  };
  return (
    <input
      type="number"
      className={className}
      style={style}
      min={min}
      max={max}
      step={step}
      value={draft}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === 'Escape') { setDraft(String(value ?? 0)); e.currentTarget.blur(); }
      }}
    />
  );
}

// Same draft-on-focus pattern for multi-line fields. Enter inserts a newline
// (native textarea behavior); commit happens only on blur.
function LiveTextarea({ value, onCommit, placeholder, style, rows }) {
  const [draft, setDraft] = useState(value ?? '');
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value ?? '');
  }, [value, focused]);
  const commit = () => {
    if (draft === (value ?? '')) return;
    onCommit?.(draft);
  };
  return (
    <textarea
      rows={rows}
      style={style}
      placeholder={placeholder}
      value={draft}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      onChange={(e) => setDraft(e.target.value)}
    />
  );
}

// ====================================================================
// USE DRAGGABLE  (v5 fix #2)
// ====================================================================
// Makes a floating panel (`.float-panel`) draggable by its header
// (`.float-panel-header`). Pass in the ref to the panel root.
//
// Behavior:
//  - Pointer-down on the header grabs the panel.
//  - Pointer-move updates a local offset state, applied via inline
//    transform so React doesn't fight the position.
//  - Pointer-up ends the drag.
//  - Drags on interactive children of the header (buttons, inputs)
//    are ignored so close buttons still work.
//  - Clamps so the header stays partially inside the viewport — you
//    can't fling a panel off the screen and lose it.
//
// Each panel instance has its own drag offset, reset when unmounted.
function useDraggable(ref) {
  const [offset, setOffset] = useState({ dx: 0, dy: 0 });
  const dragState = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const header = el.querySelector('.float-panel-header');
    if (!header) return;

    const onPointerDown = (e) => {
      // Only left-button drags. Ignore drags starting on interactive
      // children (buttons, inputs) so they still fire clicks.
      if (e.button !== 0) return;
      const target = e.target;
      if (target.closest('button, input, select, textarea, a, .close-x')) return;
      dragState.current = {
        startX: e.clientX,
        startY: e.clientY,
        baseDx: offset.dx,
        baseDy: offset.dy,
      };
      header.setPointerCapture?.(e.pointerId);
      header.classList.add('dragging');
      e.preventDefault();
    };
    const onPointerMove = (e) => {
      const s = dragState.current;
      if (!s) return;
      const rawDx = s.baseDx + (e.clientX - s.startX);
      const rawDy = s.baseDy + (e.clientY - s.startY);
      // Clamp so the header (40px tall) stays partially on screen
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const minLeft = -(rect.width - 80); // keep 80px visible on the right
      const maxLeft = vw - 80;
      const minTop = 0;                    // don't let header go above 0
      const maxTop = vh - 40;
      // Translate the raw delta back through the original rect position
      // (rect.left = original left + current dx → we clamp future left).
      const originalLeft = rect.left - s.baseDx;
      const originalTop  = rect.top  - s.baseDy;
      const newLeft = clamp(originalLeft + rawDx, minLeft, maxLeft);
      const newTop  = clamp(originalTop  + rawDy, minTop,  maxTop);
      setOffset({ dx: newLeft - originalLeft, dy: newTop - originalTop });
    };
    const onPointerUp = (e) => {
      if (!dragState.current) return;
      dragState.current = null;
      header.classList.remove('dragging');
      try { header.releasePointerCapture?.(e.pointerId); } catch {}
    };

    header.addEventListener('pointerdown', onPointerDown);
    header.addEventListener('pointermove', onPointerMove);
    header.addEventListener('pointerup', onPointerUp);
    header.addEventListener('pointercancel', onPointerUp);
    return () => {
      header.removeEventListener('pointerdown', onPointerDown);
      header.removeEventListener('pointermove', onPointerMove);
      header.removeEventListener('pointerup', onPointerUp);
      header.removeEventListener('pointercancel', onPointerUp);
    };
  }, [ref, offset.dx, offset.dy]);

  // Style applied by the caller to the panel root. We use transform
  // rather than left/top so we don't conflict with any initial
  // positioning the panel had (e.g. `right: 16px, top: 80px`).
  return {
    style: { transform: `translate(${offset.dx}px, ${offset.dy}px)` },
  };
}

// Wrapper that makes a float panel draggable automatically. Swap
// `<div className="float-panel">` for `<FloatPanel>` at the root of
// each panel component and it inherits the drag behavior.
function FloatPanel({ className = '', style, children, ...rest }) {
  const ref = useRef(null);
  const drag = useDraggable(ref);
  return (
    <div
      ref={ref}
      className={`float-panel ${className}`.trim()}
      style={{ ...style, ...drag.style }}
      {...rest}
    >
      {children}
    </div>
  );
}

// ====================================================================
// EDIT MY SHEET MODAL  (player self-service)
// ====================================================================
// Dedicated surface for a player to manage their own PC (and any
// familiars). Only HP adjustments and condition toggles are permitted;
// all writes are routed through the DM for validation.
function EditMySheetModal({ state, myPeerId, claim, playerActionSender, onClose }) {
  const [hpDelta, setHpDelta] = useState(0);
  const [focusedId, setFocusedId] = useState(claim.pc || claim.familiars[0] || null);
  const [expandedSection, setExpandedSection] = useState('core'); // core | stats | identity

  // v3: entity IDs the player may edit. PC + claimed familiars + bonded familiars.
  const myIds = useMemo(() => {
    const s = new Set([...(claim.familiars || [])]);
    if (claim.pc) s.add(claim.pc);
    // also include bonded familiars
    for (const [id, e] of Object.entries(state.entities)) {
      if (e && e.type === 'Familiar' && e.bondedPeerId === myPeerId) s.add(id);
    }
    return Array.from(s);
  }, [claim.pc, claim.familiars, state.entities, myPeerId]);

  const entity = focusedId && state.entities[focusedId] ? state.entities[focusedId] : null;

  // v3: direct field writer — routes through the DM-authoritative path.
  const setField = (patch) => {
    if (!entity) return;
    playerActionSender({ type: 'patch_own_entity', payload: { entityId: entity.id, op: 'field_set', patch } });
  };

  const applyHp = (sign) => {
    const d = Math.abs(hpDelta) * sign;
    if (!d || !entity) return;
    playerActionSender({ type: 'patch_own_entity', payload: { entityId: entity.id, op: 'hp_adjust', delta: d } });
    setHpDelta(0);
  };
  const toggleCond = (c) => {
    if (!entity) return;
    playerActionSender({ type: 'patch_own_entity', payload: { entityId: entity.id, op: 'toggle_condition', condition: c } });
  };

  // v3: player token image upload — reuses same compression pipeline as the DM form.
  const uploadImage = async () => {
    if (!entity) return;
    try {
      const dataUrl = await pickImage();
      if (!dataUrl) return;
      const img = new Image();
      img.onload = () => {
        const maxSide = 256;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const compressed = canvas.toDataURL('image/jpeg', 0.82);
        setField({ imageUrl: compressed });
      };
      img.onerror = () => setField({ imageUrl: dataUrl });
      img.src = dataUrl;
    } catch {}
  };

  if (!entity) {
    return (
      <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal slide-up" style={{ maxWidth: 420 }}>
          <div className="float-panel-header">
            <span>◈ Edit My Sheet</span>
            <button className="close-x" onClick={onClose}>×</button>
          </div>
          <div className="float-panel-body">
            <div className="empty-state"><span className="glyph">⚔</span>You haven't claimed a character yet.</div>
          </div>
        </div>
      </div>
    );
  }

  const sicknessLabel = SICKNESS_DESCRIPTORS[entity.sickness || 0] || '';

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal slide-up" style={{ maxWidth: 520 }}>
        <div className="float-panel-header">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="entity-swatch" style={{ background: entity.color, width: 12, height: 12 }} />
            ◈ {entity.name} — Your Sheet
          </span>
          <button className="close-x" onClick={onClose}>×</button>
        </div>
        <div className="float-panel-body">
          {myIds.length > 1 && (
            <div className="sheet-tabs">
              {myIds.map(id => {
                const e = state.entities[id];
                if (!e) return null;
                return (
                  <button
                    key={id}
                    className={`sheet-tab ${focusedId === id ? 'active' : ''}`}
                    onClick={() => setFocusedId(id)}
                  >
                    <div className="entity-swatch" style={{ background: e.color, width: 10, height: 10 }} />
                    {e.name}
                    {id === claim.pc ? <span className="own-pc-badge" style={{ marginLeft: 4 }}>PC</span> : <span className="familiar-badge">FAM</span>}
                  </button>
                );
              })}
            </div>
          )}

          {/* v3: editable portrait */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
            <div className="portrait-preview" style={{ background: entity.color }}>
              {entity.imageUrl
                ? <img src={entity.imageUrl} alt="" draggable="false" />
                : <span>{(entity.name || '?').slice(0,1).toUpperCase()}</span>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button className="btn sm" type="button" onClick={uploadImage}>⇧ Upload portrait</button>
              {entity.imageUrl && (
                <button className="btn sm ghost" type="button" onClick={() => setField({ imageUrl: '' })}>Remove image</button>
              )}
              <input type="color" value={entity.color}
                onChange={(e) => setField({ color: e.target.value })}
                title="Token color"
                style={{ width: 50, height: 24, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }} />
            </div>
          </div>

          {entity.type === 'PC' && sicknessLabel && (
            <div className={`sickness-note sick-level-${entity.sickness || 0}`}>
              <span className="sickness-glyph">❋</span>
              <span><em>You feel</em> <strong>{sicknessLabel.toLowerCase()}</strong>.</span>
            </div>
          )}

          {/* --- Core block: HP + quick stats --- */}
          {/* v4 fix #6: all numeric fields use LiveNumberInput so typing
              "12" doesn't glitch to "1" because state broadcast rebuilds
              the DOM between "1" and "2". */}
          <div className="sheet-stats">
            <div className="sheet-stat">
              <span>AC</span>
              <LiveNumberInput className="sheet-stat-input mono"
                value={entity.ac}
                onCommit={(v) => setField({ ac: v })}
                min={0} max={40} />
            </div>
            <div className="sheet-stat">
              <span>Speed</span>
              <LiveNumberInput className="sheet-stat-input mono"
                value={entity.speed}
                onCommit={(v) => setField({ speed: v })}
                min={0} max={120} step={5} />
            </div>
            <div className="sheet-stat">
              <span>Init</span>
              <LiveNumberInput className="sheet-stat-input mono"
                value={entity.initBonus}
                onCommit={(v) => setField({ initBonus: v })}
                min={-10} max={20} />
            </div>
            <div className="sheet-stat">
              <span>Passive</span>
              <LiveNumberInput className="sheet-stat-input mono"
                value={entity.passivePerception}
                onCommit={(v) => setField({ passivePerception: v })}
                min={0} max={40} />
            </div>
          </div>

          <label>HP</label>
          <div className="form-row-2" style={{ marginBottom: 8 }}>
            <div>
              <label style={{ fontSize: 9, opacity: 0.6 }}>Current</label>
              <LiveNumberInput
                value={entity.hp.current}
                onCommit={(v) => setField({ hp: { current: v, max: entity.hp.max } })}
                min={0} max={10000} />
            </div>
            <div>
              <label style={{ fontSize: 9, opacity: 0.6 }}>Max</label>
              <LiveNumberInput
                value={entity.hp.max}
                onCommit={(v) => setField({ hp: { current: entity.hp.current, max: v } })}
                min={0} max={10000} />
            </div>
          </div>

          <label>Quick Adjust</label>
          <div className="hp-adjuster" style={{ marginBottom: 10 }}>
            <button className="btn danger" onClick={() => applyHp(-1)}>− Damage</button>
            <input type="number" value={hpDelta} onChange={e => setHpDelta(Math.abs(Number(e.target.value)) || 0)} />
            <button className="btn" onClick={() => applyHp(+1)}>+ Heal</button>
          </div>

          {/* v4 fix #9: player-editable vision stats */}
          {['PC','Familiar'].includes(entity.type) && (
            <>
              <label>Vision <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— feet; DM may override</span></label>
              <div className="form-row-2" style={{ marginBottom: 10 }}>
                <div>
                  <label style={{ fontSize: 9 }}>Darkvision</label>
                  <LiveNumberInput
                    value={entity.darkvision || 0}
                    onCommit={(v) => setField({ darkvision: v })}
                    min={0} max={600} step={5} />
                </div>
                <div>
                  <label style={{ fontSize: 9 }}>Light Radius</label>
                  <LiveNumberInput
                    value={entity.lightRadius || 0}
                    onCommit={(v) => setField({ lightRadius: v })}
                    min={0} max={600} step={5} />
                </div>
              </div>
            </>
          )}

          {/* --- Ability scores (collapsible) --- */}
          {entity.type === 'PC' && (
            <>
              <label onClick={() => setExpandedSection(s => s === 'stats' ? '' : 'stats')}
                style={{ cursor: 'pointer', userSelect: 'none' }}>
                Ability Scores {expandedSection === 'stats' ? '▾' : '▸'}
              </label>
              {expandedSection === 'stats' && (
                <div className="form-row-6" style={{ marginBottom: 10 }}>
                  {['str','dex','con','int','wis','cha'].map(s => (
                    <div key={s} className="stat-box">
                      <label>{s.toUpperCase()}</label>
                      <LiveNumberInput
                        value={entity.stats[s]}
                        onCommit={(v) => setField({ stats: { [s]: v } })}
                        min={1} max={30} />
                      <div style={{ fontSize: 9, color: 'var(--ink-mute)', fontFamily: 'JetBrains Mono, monospace' }}>
                        {modFor(entity.stats[s]) >= 0 ? `+${modFor(entity.stats[s])}` : modFor(entity.stats[s])}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* --- Identity (collapsible) --- */}
          {entity.type === 'PC' && (
            <>
              <label onClick={() => setExpandedSection(s => s === 'identity' ? '' : 'identity')}
                style={{ cursor: 'pointer', userSelect: 'none' }}>
                Identity {expandedSection === 'identity' ? '▾' : '▸'}
              </label>
              {expandedSection === 'identity' && (
                <div style={{ marginBottom: 10 }}>
                  <div className="form-row-2">
                    <div>
                      <label style={{ fontSize: 9 }}>Name</label>
                      <LiveInput value={entity.name}
                        onCommit={(v) => setField({ name: v })} />
                    </div>
                    <div>
                      <label style={{ fontSize: 9 }}>Class</label>
                      <LiveInput value={entity.class || ''}
                        onCommit={(v) => setField({ class: v })} />
                    </div>
                  </div>
                  <div className="form-row-2" style={{ marginTop: 6 }}>
                    <div>
                      <label style={{ fontSize: 9 }}>Level</label>
                      <LiveNumberInput
                        value={entity.level}
                        onCommit={(v) => setField({ level: Math.max(1, v) })}
                        min={1} max={30} />
                    </div>
                    <div>
                      <label style={{ fontSize: 9 }}>Player Name</label>
                      <LiveInput value={entity.playerName || ''}
                        onCommit={(v) => setField({ playerName: v })} />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          <label>Conditions <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— click to toggle</span></label>
          <div className="cond-grid">
            {CONDITIONS.slice(0, 15).map(c => (
              <div
                key={c}
                className={`cond-chip ${entity.conditions.includes(c) ? 'active' : ''}`}
                onClick={() => toggleCond(c)}
              >{c}</div>
            ))}
          </div>

          <label style={{ marginTop: 10 }}>Notes / Description</label>
          <LiveTextarea
            value={entity.playerDescription || ''}
            onCommit={(v) => setField({ playerDescription: v })}
            placeholder="A short description of your character…" />

          <div className="settings-hint" style={{ marginTop: 12 }}>
            All changes sync in real time through the DM. The DM may override anything at any moment.
          </div>
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// PLAYER ONBOARDING  (forced character selection on join)
// ====================================================================
// Shown full-screen as a gate before the player can interact with the map.
// The player must pick a PC, request a new one, or choose spectator mode.
function PlayerOnboardingGate({ state, myPeerId, playerName, playerActionSender, onRequestNewPC }) {
  const [search, setSearch] = useState('');
  const allClaimedIds = new Set(Object.values(state.claims || {}).map(c => c.pc).filter(Boolean));
  const availablePCs = Object.values(state.entities)
    .filter(e => e.type === 'PC' && !allClaimedIds.has(e.id))
    .filter(e => !search || e.name.toLowerCase().includes(search.toLowerCase()));

  const pickPC = (ent) => {
    playerActionSender({ type: 'claim_pc', payload: { entityId: ent.id, playerName } });
  };
  const pickSpectator = () => {
    playerActionSender({ type: 'claim_spectator', payload: { playerName } });
  };

  return (
    <div className="onboarding-overlay">
      <div className="onboarding-card">
        <div className="onboarding-title">Step into the realm</div>
        <div className="onboarding-subtitle">Welcome, {playerName || 'traveler'}. Choose your presence at the table.</div>

        <div className="onboarding-section">
          <div className="onboarding-section-title">Existing Characters</div>
          {availablePCs.length === 0 ? (
            <div className="empty-state" style={{ padding: '20px' }}>
              <span className="glyph">⚔</span>
              No unclaimed characters. Ask your DM to create one for you, or proceed as a spectator.
            </div>
          ) : (
            <>
              <input className="onboarding-search"
                placeholder="Search by name…"
                value={search}
                onChange={e => setSearch(e.target.value)} />
              <div className="onboarding-grid">
                {availablePCs.map(e => (
                  <div
                    key={e.id}
                    className="onboarding-pc"
                    onClick={() => pickPC(e)}
                  >
                    <div className="pc-avatar" style={{ background: e.color, width: 44, height: 44 }}>
                      {e.imageUrl
                        ? <img src={e.imageUrl} alt="" style={{width:'100%',height:'100%',objectFit:'cover',borderRadius:'50%'}} />
                        : (e.name[0] || '?').toUpperCase()}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontFamily: 'Cinzel, serif', fontSize: 14 }}>{e.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--ink-dim)' }}>
                        Level {e.level} {e.class} · {e.hp.max} HP · AC {e.ac}
                      </div>
                    </div>
                    <button className="btn primary sm">Claim</button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="onboarding-divider">or</div>

        <div className="onboarding-actions">
          <button className="btn" onClick={onRequestNewPC}>＋ Request a new character</button>
          <button className="btn ghost" onClick={pickSpectator}>👁 Join as spectator</button>
        </div>

        <div className="settings-hint" style={{ textAlign: 'center', marginTop: 16 }}>
          You can change this later from the top bar.
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// DM WORLD PANEL  (time-of-day, per-peer push, block zones, etc.)
// ====================================================================
// ====================================================================
// HAZARDS PANEL  (v6 #9)
// ====================================================================
// DM-only. Paints environmental hazard polygons on the current map:
// fire / flood / cold / acid / fog / difficult terrain. Each has its
// own visual treatment. Hazards can be marked hidden so they function
// as traps (DM-only visibility).
const HAZARD_KINDS = [
  { key: 'fire',      label: 'Fire',      glyph: '🔥', swatch: 'rgba(230,80,40,0.6)' },
  { key: 'flood',     label: 'Flood',     glyph: '🌊', swatch: 'rgba(60,120,200,0.6)' },
  { key: 'cold',      label: 'Cold',      glyph: '❄',  swatch: 'rgba(200,230,245,0.7)' },
  { key: 'acid',      label: 'Acid',      glyph: '☣',  swatch: 'rgba(110,180,70,0.6)' },
  { key: 'fog',       label: 'Fog',       glyph: '☁',  swatch: 'rgba(180,180,190,0.65)' },
  { key: 'difficult', label: 'Difficult', glyph: '⟁',  swatch: 'rgba(160,110,50,0.55)' },
];
function HazardsPanel({
  state, dispatch, onClose, toast,
  placingHazard, setPlacingHazard,
  hazardVisibleDefault, setHazardVisibleDefault,
}) {
  const currentMapId = state.currentMapId;
  const list = state.hazards?.[currentMapId] || [];
  return (
    <FloatPanel style={{ right: 16, top: 80, width: 280 }}>
      <div className="float-panel-header">
        <span>⚠ Hazards</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        <label className="settings-label">Kind <span className="settings-label-sub">— click-drag on map to paint</span></label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, marginBottom: 10 }}>
          {HAZARD_KINDS.map(k => (
            <button key={k.key}
              className={`btn sm ${placingHazard === k.key ? 'active' : ''}`}
              onClick={() => setPlacingHazard(placingHazard === k.key ? null : k.key)}
              title={`${k.label} hazard`}>
              <span style={{ display: 'inline-block', width: 8, height: 8, background: k.swatch, borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} />
              {k.glyph} {k.label}
            </button>
          ))}
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 10 }}>
          <input type="checkbox" checked={hazardVisibleDefault}
            onChange={e => setHazardVisibleDefault(e.target.checked)} />
          <span>New hazards visible to players</span>
        </label>
        <div className="settings-hint" style={{ marginBottom: 10 }}>
          Uncheck to paint hidden hazards (traps). Hidden hazards only appear on the DM screen.
        </div>

        <label className="settings-label">On this map <span className="settings-label-sub">— {list.length} hazard(s)</span></label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflowY: 'auto', marginBottom: 8 }}>
          {list.map(h => (
            <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, padding: '3px 6px', background: 'var(--bg-0)', borderRadius: 3 }}>
              <span style={{ flex: 1 }}>
                {HAZARD_KINDS.find(k => k.key === h.hazardKind)?.glyph || '?'} {h.hazardKind}
                {h.visible === false && <span style={{ color: 'var(--ink-mute)', marginLeft: 4 }}>(hidden)</span>}
              </span>
              <button className="btn sm ghost" title="Toggle visibility"
                onClick={() => dispatch({ type: 'HAZARD_UPSERT', mapId: currentMapId, hazard: { ...h, visible: h.visible === false } })}>
                {h.visible === false ? '👁' : '🕶'}
              </button>
              <button className="btn sm ghost danger"
                onClick={() => dispatch({ type: 'HAZARD_DELETE', mapId: currentMapId, id: h.id })}>
                ✕
              </button>
            </div>
          ))}
          {list.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--ink-dim)', fontStyle: 'italic' }}>No hazards painted yet.</div>
          )}
        </div>

        <button className="btn sm danger"
          disabled={!list.length}
          onClick={() => {
            if (confirm('Clear all hazards on this map?')) {
              dispatch({ type: 'HAZARD_CLEAR_MAP', mapId: currentMapId });
              toast('Cleared all hazards');
            }
          }}>
          Clear All
        </button>
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// TOOLS MENU  (v7 #6)
// ====================================================================
// Single grouped popover replacing the row of toolbar buttons (Reminder,
// Line, Radius, Draw, Hazards, Dice, Sounds, Block modes, Eraser).
// Click the 🧰 Tools button to open; pick a tool; menu closes; the tool
// becomes active. Active mode is shown in the trigger label.
//
// Props are deliberately broad: the tools menu reads & writes a slice
// of the parent component's state so it can offer/cancel any mode and
// open any panel. We accept an `active` summary describing which tool
// is currently engaged so the menu can highlight it.
function ToolsMenu({
  isDM,
  // measure
  measureMode, setMeasureMode,
  // draw
  showDraw, setShowDraw,
  // panels
  showDice, setShowDice,
  showSounds, setShowSounds,
  showHazards, setShowHazards,
  // v7.3: groups panel (DM-only)
  showGroups, setShowGroups,
  // reminder
  placingReminder, setPlacingReminder,
  // DM-only block modes
  placingBlock, setPlacingBlock,
  placingFreeBlock, setPlacingFreeBlock,
  placingCircleBlock, setPlacingCircleBlock,
  erasingBlock, setErasingBlock,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  // Close on outside click + Esc
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Helper: cancel ALL exclusive map modes. Each mode-toggle below
  // calls this first so only one is active at a time.
  const clearAllModes = () => {
    setMeasureMode?.(null);
    setPlacingReminder?.(false);
    if (isDM) {
      setPlacingBlock?.(false);
      setPlacingFreeBlock?.(false);
      setPlacingCircleBlock?.(false);
      setErasingBlock?.(false);
    }
  };

  // Choose-mode helper: clears, sets the requested one, closes the menu
  const choose = (fn) => () => { clearAllModes(); fn(); setOpen(false); };

  // Active label for the trigger button
  let activeLabel = '';
  if (measureMode === 'line')         activeLabel = '· Measure';
  else if (measureMode === 'radius')  activeLabel = '· Radius';
  else if (measureMode === 'tokenToToken') activeLabel = '· T→T';
  else if (placingReminder)           activeLabel = '· Reminder';
  else if (isDM && placingBlock)      activeLabel = '· Block';
  else if (isDM && placingFreeBlock)  activeLabel = '· Block';
  else if (isDM && placingCircleBlock)activeLabel = '· Block';
  else if (isDM && erasingBlock)      activeLabel = '· Eraser';

  const isActive = !!activeLabel;

  return (
    <div className="tools-menu-wrap" ref={wrapRef} style={{ position: 'relative' }}>
      <button className={`btn ${open || isActive ? 'active' : ''}`}
        onClick={() => setOpen(!open)}
        title="Tools — measure, draw, shapes, dice, sounds">
        🧰 Tools{activeLabel ? <span className="tools-active-suffix"> {activeLabel}</span> : ''}
      </button>
      {open && (
        <div className="tools-menu-pop">
          {/* MEASURE */}
          <div className="tools-section">
            <div className="tools-section-title">Measure</div>
            <button className={`tools-item ${measureMode === 'line' ? 'active' : ''}`}
              onClick={choose(() => setMeasureMode('line'))}>
              📏 Line <span className="tools-hint">click-drag</span>
            </button>
            <button className={`tools-item ${measureMode === 'radius' ? 'active' : ''}`}
              onClick={choose(() => setMeasureMode('radius'))}>
              ◎ Radius <span className="tools-hint">drag from center</span>
            </button>
            <button className={`tools-item ${measureMode === 'tokenToToken' ? 'active' : ''}`}
              onClick={choose(() => setMeasureMode('tokenToToken'))}>
              ⤴ Token → Token <span className="tools-hint">click two tokens</span>
            </button>
          </div>

          {/* DRAW */}
          <div className="tools-section">
            <div className="tools-section-title">Draw</div>
            <button className={`tools-item ${showDraw ? 'active' : ''}`}
              onClick={() => { setShowDraw(true); setOpen(false); }}>
              ✒ Drawing palette <span className="tools-hint">free / line / circle</span>
            </button>
          </div>

          {/* SHAPES & AREAS — DM only */}
          {isDM && (
            <div className="tools-section">
              <div className="tools-section-title">Shapes & Areas <span className="tools-section-sub">DM</span></div>
              <button className={`tools-item ${placingBlock ? 'active' : ''}`}
                onClick={choose(() => setPlacingBlock(true))}>
                ◼ Block — Rect <span className="tools-hint">click-drag</span>
              </button>
              <button className={`tools-item ${placingFreeBlock ? 'active' : ''}`}
                onClick={choose(() => setPlacingFreeBlock(true))}>
                ✎ Block — Freeform <span className="tools-hint">drag a polygon</span>
              </button>
              <button className={`tools-item ${placingCircleBlock ? 'active' : ''}`}
                onClick={choose(() => setPlacingCircleBlock(true))}>
                ⬤ Block — Circle <span className="tools-hint">drag from center</span>
              </button>
              <button className={`tools-item ${showHazards ? 'active' : ''}`}
                onClick={() => { setShowHazards(true); setOpen(false); }}>
                ⚠ Hazards palette <span className="tools-hint">fire / flood / cold / acid / fog / difficult</span>
              </button>
              <button className={`tools-item danger ${erasingBlock ? 'active' : ''}`}
                onClick={choose(() => setErasingBlock(true))}>
                ✕ Cut / Eraser <span className="tools-hint">draw to subtract</span>
              </button>
            </div>
          )}

          {/* v7.3: ENCOUNTER — DM only. Token grouping for fast
              reveal/hide of whole clusters. */}
          {isDM && (
            <div className="tools-section">
              <div className="tools-section-title">Encounter <span className="tools-section-sub">DM</span></div>
              <button className={`tools-item ${showGroups ? 'active' : ''}`}
                onClick={() => { setShowGroups(true); setOpen(false); }}>
                ⋱ Token groups <span className="tools-hint">reveal / hide clusters at once</span>
              </button>
            </div>
          )}

          {/* OTHER */}
          <div className="tools-section">
            <div className="tools-section-title">Other</div>
            <button className={`tools-item ${placingReminder ? 'active' : ''}`}
              onClick={choose(() => setPlacingReminder(true))}>
              ◆ Reminder <span className="tools-hint">private pin</span>
            </button>
            <button className={`tools-item ${showDice ? 'active' : ''}`}
              onClick={() => { setShowDice(true); setOpen(false); }}>
              🎲 Dice <span className="tools-hint">d4 — d20 for the table</span>
            </button>
            {isDM && (
              <button className={`tools-item ${showSounds ? 'active' : ''}`}
                onClick={() => { setShowSounds(true); setOpen(false); }}>
                🔊 Soundboard <span className="tools-hint">play audio for everyone</span>
              </button>
            )}
          </div>

          {isActive && (
            <div className="tools-section">
              <button className="tools-item ghost"
                onClick={() => { clearAllModes(); setOpen(false); }}>
                ⌧ Cancel active tool
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ====================================================================
// TOKEN GROUPS PANEL  (v7.3)
// ====================================================================
// DM-only. Lists token groups for the current map; lets the DM create
// a group from the current selection, rename, edit membership, and —
// the main point of the feature — hide or reveal an entire group with
// one click.
//
// Permissions: players never open or see this panel. Group metadata
// itself is DM-only; only the effect (tokens appearing / disappearing
// via their .visible flag) propagates to players.
function GroupsPanel({
  state, dispatch, onClose, toast,
  currentMapId,
  selectedTokenIds,
  onTokenReveal, // (tokenId, visible) — reuses existing TOKEN_VISIBILITY plumbing if needed
  onHighlightGroupMembers, // (groupId, on) — briefly outline the group's tokens on the map
}) {
  // Groups are keyed globally but scoped to a single map; filter here.
  const groupsById = state.tokenGroups || {};
  const groupsOnMap = useMemo(
    () => Object.values(groupsById)
      .filter(g => g.mapId === currentMapId)
      .sort((a, b) => (a.createdTs || 0) - (b.createdTs || 0)),
    [groupsById, currentMapId]
  );

  // Track which group is currently open (expanded member list)
  const [openGroupId, setOpenGroupId] = useState(null);
  const [editingNameFor, setEditingNameFor] = useState(null);
  const [editingNameValue, setEditingNameValue] = useState('');

  const selectedOnCurrentMap = useMemo(() => {
    const ids = [];
    for (const tid of selectedTokenIds) {
      const t = state.tokens?.[tid];
      if (t && t.mapId === currentMapId) ids.push(tid);
    }
    return ids;
  }, [selectedTokenIds, state.tokens, currentMapId]);

  const createFromSelection = () => {
    if (selectedOnCurrentMap.length === 0) {
      toast('Select one or more tokens on the map first', 'info');
      return;
    }
    const name = prompt('Group name:', '');
    if (!name || !name.trim()) return;
    const id = uid('grp_');
    dispatch({
      type: 'TOKEN_GROUP_CREATE',
      id, mapId: currentMapId,
      name: name.trim(),
      memberIds: selectedOnCurrentMap,
    });
    setOpenGroupId(id);
    toast(`Group "${name.trim()}" created with ${selectedOnCurrentMap.length} token${selectedOnCurrentMap.length === 1 ? '' : 's'}`, 'success');
  };

  const createEmpty = () => {
    const name = prompt('New group name:', '');
    if (!name || !name.trim()) return;
    const id = uid('grp_');
    dispatch({
      type: 'TOKEN_GROUP_CREATE',
      id, mapId: currentMapId,
      name: name.trim(),
      memberIds: [],
    });
    setOpenGroupId(id);
  };

  const addSelectionTo = (groupId) => {
    if (selectedOnCurrentMap.length === 0) {
      toast('Select tokens on the map first', 'info');
      return;
    }
    dispatch({
      type: 'TOKEN_GROUP_ADD_MEMBERS',
      id: groupId,
      tokenIds: selectedOnCurrentMap,
    });
    toast(`Added ${selectedOnCurrentMap.length} to group`, 'success');
  };

  const removeMember = (groupId, tokenId) => {
    dispatch({
      type: 'TOKEN_GROUP_REMOVE_MEMBERS',
      id: groupId,
      tokenIds: [tokenId],
    });
  };

  const renameStart = (g) => {
    setEditingNameFor(g.id);
    setEditingNameValue(g.name);
  };
  const renameCommit = () => {
    if (editingNameFor && editingNameValue.trim()) {
      dispatch({
        type: 'TOKEN_GROUP_UPDATE',
        id: editingNameFor,
        patch: { name: editingNameValue.trim() },
      });
    }
    setEditingNameFor(null);
    setEditingNameValue('');
  };

  const deleteGroup = (g) => {
    if (!confirm(`Delete group "${g.name}"? (Member tokens are NOT deleted.)`)) return;
    dispatch({ type: 'TOKEN_GROUP_DELETE', id: g.id });
    if (openGroupId === g.id) setOpenGroupId(null);
  };

  const setGroupVisible = (g, visible) => {
    const n = (g.memberIds || []).length;
    if (n === 0) {
      toast('Group is empty — add tokens first', 'info');
      return;
    }
    dispatch({ type: 'TOKEN_GROUP_SET_VISIBLE', id: g.id, visible });
    toast(`${visible ? 'Revealed' : 'Hid'} ${n} token${n === 1 ? '' : 's'}`, 'success');
  };

  // Helper: describe a group's current hidden/revealed state
  const visibilitySummary = (g) => {
    const members = (g.memberIds || [])
      .map(tid => state.tokens?.[tid])
      .filter(Boolean);
    if (members.length === 0) return { label: 'empty', mixed: false, visibleCount: 0, total: 0 };
    const vis = members.filter(t => t.visible).length;
    const total = members.length;
    return {
      label: vis === 0 ? `all hidden` : vis === total ? `all revealed` : `${vis} of ${total} revealed`,
      mixed: vis > 0 && vis < total,
      visibleCount: vis,
      total,
    };
  };

  return (
    <FloatPanel style={{ right: 16, top: 80, width: 340 }}>
      <div className="float-panel-header">
        <span>⋱ Groups</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        <div className="settings-hint" style={{ fontSize: 11, marginBottom: 10, lineHeight: 1.4 }}>
          Cluster tokens for faster encounter control — hide or reveal a whole
          ambush at once.
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <button className="btn primary sm" onClick={createFromSelection}
            disabled={selectedOnCurrentMap.length === 0}
            title={selectedOnCurrentMap.length === 0
              ? 'Shift-click tokens on the map to select them first'
              : `Create a group from ${selectedOnCurrentMap.length} selected token${selectedOnCurrentMap.length === 1 ? '' : 's'}`}>
            ＋ From selection ({selectedOnCurrentMap.length})
          </button>
          <button className="btn sm ghost" onClick={createEmpty}
            title="Create an empty group and add members later">
            ＋ Empty
          </button>
        </div>

        <label className="settings-label">
          Groups on this map <span className="settings-label-sub">— {groupsOnMap.length}</span>
        </label>

        {groupsOnMap.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--ink-dim)', fontStyle: 'italic', padding: 8 }}>
            No groups yet. Select tokens on the map and click "From selection".
          </div>
        )}

        <div className="groups-list">
          {groupsOnMap.map(g => {
            const summary = visibilitySummary(g);
            const isOpen = openGroupId === g.id;
            const isEditing = editingNameFor === g.id;
            return (
              <div key={g.id} className={`group-row ${isOpen ? 'open' : ''}`}>
                <div className="group-row-head">
                  {isEditing ? (
                    <input
                      className="group-row-name-input"
                      type="text"
                      value={editingNameValue}
                      onChange={e => setEditingNameValue(e.target.value)}
                      onBlur={renameCommit}
                      onKeyDown={e => {
                        if (e.key === 'Enter') renameCommit();
                        if (e.key === 'Escape') { setEditingNameFor(null); setEditingNameValue(''); }
                      }}
                      autoFocus
                    />
                  ) : (
                    <button
                      className="group-row-name"
                      onClick={() => setOpenGroupId(isOpen ? null : g.id)}
                      onMouseEnter={() => onHighlightGroupMembers?.(g.id, true)}
                      onMouseLeave={() => onHighlightGroupMembers?.(g.id, false)}
                      title="Click to expand / collapse"
                    >
                      <span className="group-row-caret">{isOpen ? '▾' : '▸'}</span>
                      <span className="group-row-label">{g.name}</span>
                      <span className={`group-row-summary ${summary.mixed ? 'mixed' : ''}`}>
                        {summary.label}
                      </span>
                    </button>
                  )}
                  <div className="group-row-actions">
                    <button className="btn sm"
                      onClick={() => setGroupVisible(g, true)}
                      title="Reveal all members"
                      disabled={summary.total === 0 || summary.visibleCount === summary.total}>
                      👁
                    </button>
                    <button className="btn sm"
                      onClick={() => setGroupVisible(g, false)}
                      title="Hide all members"
                      disabled={summary.total === 0 || summary.visibleCount === 0}>
                      🕶
                    </button>
                    <button className="btn sm ghost"
                      onClick={() => renameStart(g)}
                      title="Rename group">✎</button>
                    <button className="btn sm ghost danger"
                      onClick={() => deleteGroup(g)}
                      title="Delete group (tokens are preserved)">✕</button>
                  </div>
                </div>

                {isOpen && (
                  <div className="group-row-body">
                    <div className="group-row-members">
                      {(g.memberIds || []).length === 0 && (
                        <div style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--ink-dim)', padding: 4 }}>
                          No members. Select tokens on the map and click "Add selection" below.
                        </div>
                      )}
                      {(g.memberIds || []).map(tid => {
                        const t = state.tokens?.[tid];
                        const ent = t ? state.entities?.[t.entityId] : null;
                        if (!t || !ent) return null;
                        return (
                          <div key={tid} className="group-row-member">
                            <div className="entity-swatch"
                              style={{ background: ent.color || 'var(--gold)', width: 10, height: 10 }} />
                            <span className="group-row-member-name">{ent.name || 'Unnamed'}</span>
                            <span className={`group-row-member-vis ${t.visible ? 'visible' : 'hidden'}`}>
                              {t.visible ? 'visible' : 'hidden'}
                            </span>
                            <button className="btn sm ghost danger"
                              onClick={() => removeMember(g.id, tid)}
                              title="Remove from group">−</button>
                          </div>
                        );
                      })}
                    </div>
                    {selectedOnCurrentMap.length > 0 && (
                      <button className="btn sm"
                        onClick={() => addSelectionTo(g.id)}
                        style={{ width: '100%', marginTop: 4 }}>
                        ＋ Add selection ({selectedOnCurrentMap.length}) to this group
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// SOUNDBOARD PANEL  (v7 #10)
// ====================================================================
// DM-only. Upload audio files (mp3/ogg/wav) to play for the table.
// Sounds are stored in IDB (the 'sounds' store) so they don't bloat the
// main session JSON. Each row has Play / Stop / Delete.
//
// When the DM clicks Play, two things happen:
//   1. A SOUND_EVENT is dispatched to state.soundEvents — players see
//      this in their synced state and trigger local audio playback
//   2. The DM's sync layer also pushes the sound's dataUrl directly to
//      every connected peer via a 'sound_data' envelope, so players
//      who don't yet have the bytes can play immediately
//
// Players cache received sound bytes in their own IDB so a sound played
// twice in one session only transmits once.
function SoundboardPanel({
  state, dispatch, onClose, toast,
  onPlay, onStop, isDM, peerList,
}) {
  const [uploading, setUploading] = useState(false);
  const [audioReady, setAudioReady] = useState(true);
  const [targetPeerId, setTargetPeerId] = useState(null); // null = all players
  const fileRef = useRef(null);
  const sounds = state.sounds || {};
  const list = Object.values(sounds).sort((a, b) => (a.ts || 0) - (b.ts || 0));

  // Build display name for each connected peer from state.claims
  const connectedPlayers = (peerList || []).map(pid => {
    const claim = state.claims?.[pid];
    const name = claim?.playerName || pid.slice(-6);
    return { pid, name };
  });

  const handleUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setUploading(true);
    try {
      for (const file of files) {
        const dataUrl = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(r.error);
          r.readAsDataURL(file);
        });
        const id = uid('snd_');
        const name = file.name.replace(/\.[^.]+$/, '').slice(0, 60);
        await idbSet(IDB_STORES.sounds, id, { id, name, dataUrl, ts: Date.now() });
        dispatch({ type: 'SOUND_REGISTER', id, name });
      }
      toast(`Loaded ${files.length} sound${files.length === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      console.error('[plagues-call] sound upload failed:', err);
      toast('Upload failed — see console', 'error');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleDelete = async (id, name) => {
    if (!confirm(`Delete sound "${name}"?`)) return;
    try {
      await idbDelete(IDB_STORES.sounds, id);
      dispatch({ type: 'SOUND_DEREGISTER', id });
    } catch (err) {
      console.error('[plagues-call] sound delete failed:', err);
    }
  };

  return (
    <FloatPanel style={{ right: 16, top: 80, width: 320 }}>
      <div className="float-panel-header">
        <span>🔊 Soundboard</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        {!audioReady && (
          <div className="settings-hint" style={{ background: 'rgba(212,165,116,0.1)', padding: 8, borderRadius: 3, marginBottom: 8 }}>
            Click anywhere to enable audio playback (browser policy).
          </div>
        )}

        <label className="settings-label">Upload <span className="settings-label-sub">— mp3, ogg, wav</span></label>
        <input ref={fileRef} type="file" accept="audio/*" multiple
          onChange={handleUpload}
          disabled={uploading}
          style={{ marginBottom: 12, fontSize: 11 }} />

        {isDM && connectedPlayers.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <label className="settings-label">Play for</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              <button
                className={`btn sm${targetPeerId === null ? ' active' : ' ghost'}`}
                onClick={() => setTargetPeerId(null)}
                title="Play for all connected players"
              >Everyone</button>
              {connectedPlayers.map(({ pid, name }) => (
                <button
                  key={pid}
                  className={`btn sm${targetPeerId === pid ? ' active' : ' ghost'}`}
                  onClick={() => setTargetPeerId(t => t === pid ? null : pid)}
                  title={`Play only for ${name}`}
                >{name}</button>
              ))}
            </div>
          </div>
        )}

        <label className="settings-label">Library <span className="settings-label-sub">— {list.length} sound{list.length === 1 ? '' : 's'}</span></label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 300, overflowY: 'auto' }}>
          {list.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--ink-dim)', fontStyle: 'italic', padding: 6 }}>
              No sounds yet. Upload audio files to build your soundboard.
            </div>
          )}
          {list.map(s => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 6px', background: 'var(--bg-0)', borderRadius: 3 }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.name}>
                {s.name}
              </span>
              <button className="btn sm" onClick={() => onPlay(s.id, targetPeerId)} title={targetPeerId ? `Play for ${connectedPlayers.find(p=>p.pid===targetPeerId)?.name}` : 'Play for the table'}>▶</button>
              <button className="btn sm ghost" onClick={() => onStop(s.id)} title="Stop">■</button>
              {isDM && (
                <button className="btn sm ghost danger" onClick={() => handleDelete(s.id, s.name)} title="Delete">✕</button>
              )}
            </div>
          ))}
        </div>
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// AUDIO PLAYBACK MANAGER  (v7 #10)
// ====================================================================
// Watches state.soundEvents. When a new event appears, looks up the
// sound in local IDB (or falls back to a dataUrl provided in the
// event itself) and plays it via a managed pool of <audio> elements.
//
// Browser autoplay restrictions: the first user interaction unlocks
// autoplay; until then, play() promises reject. We catch and ignore
// these so the app doesn't crash, and re-attempt on the next event.
function useSoundPlayback(state) {
  const audioPoolRef = useRef({});           // soundId → HTMLAudioElement
  const localCacheRef = useRef({});          // soundId → dataUrl (in-memory)
  const seenEventsRef = useRef(new Set());   // event ids already processed
  // Trim seen-events set so it doesn't grow forever (cap at 100)
  useEffect(() => {
    const events = state.soundEvents || [];
    for (const ev of events) {
      if (seenEventsRef.current.has(ev.id)) continue;
      seenEventsRef.current.add(ev.id);
      // Cap
      if (seenEventsRef.current.size > 100) {
        const trimmed = Array.from(seenEventsRef.current).slice(-100);
        seenEventsRef.current = new Set(trimmed);
      }
      // Skip events older than 30s (don't replay history on hydrate)
      if (Date.now() - ev.ts > 30000) continue;
      handleEvent(ev);
    }
    function handleEvent(ev) {
      if (ev.action === 'stop') {
        const a = audioPoolRef.current[ev.soundId];
        if (a) { a.pause(); a.currentTime = 0; }
        return;
      }
      if (ev.action !== 'play') return;
      // Try inline dataUrl first; otherwise look up in cache; otherwise IDB
      const tryPlay = (src) => {
        let audio = audioPoolRef.current[ev.soundId];
        if (!audio || audio.src !== src) {
          if (audio) audio.pause();
          audio = new Audio(src);
          audioPoolRef.current[ev.soundId] = audio;
        } else {
          audio.currentTime = 0;
        }
        const p = audio.play();
        if (p && p.catch) p.catch(err => {
          console.warn('[plagues-call] audio play blocked:', err?.message);
        });
      };
      if (ev.dataUrl) {
        localCacheRef.current[ev.soundId] = ev.dataUrl;
        // Persist to IDB for future plays without re-transmit
        idbSet(IDB_STORES.sounds, ev.soundId, {
          id: ev.soundId,
          name: ev.name || ev.soundId,
          dataUrl: ev.dataUrl,
          ts: Date.now(),
        }).catch(() => {});
        tryPlay(ev.dataUrl);
        return;
      }
      const cached = localCacheRef.current[ev.soundId];
      if (cached) { tryPlay(cached); return; }
      // Check the module-level in-memory cache populated by onSoundData.
      // This resolves the race where sound_data arrives and writes to IDB,
      // but the IDB write hasn't committed by the time we try to read it.
      const memCached = _soundDataCache.get(ev.soundId);
      if (memCached) { localCacheRef.current[ev.soundId] = memCached; tryPlay(memCached); return; }
      idbGet(IDB_STORES.sounds, ev.soundId).then(rec => {
        if (rec?.dataUrl) {
          localCacheRef.current[ev.soundId] = rec.dataUrl;
          _soundDataCache.set(ev.soundId, rec.dataUrl);
          tryPlay(rec.dataUrl);
        } else {
          console.warn(`[plagues-call] sound ${ev.soundId} not available locally`);
        }
      }).catch(() => {});
    }
  }, [state.soundEvents]);
}

// ====================================================================
// DICE TRAY  (v7 #9)
// ====================================================================
// Shared dice rolling visible to everyone in the session. Six standard
// dice (D4, D6, D8, D10, D12, D20). Quantity 1–10. Each roll appears in
// a synced log with who rolled, what, and the result. DM and players
// can both roll; player rolls flow through DM authority so the DM sees
// every event.
const DICE_SIDES = [4, 6, 8, 10, 12, 20];
function DiceTray({
  state, onClose, onRoll,
  myPeerId, myName, isDM, dispatch,
}) {
  // v7.2: counts-per-die state. Keys are the 6 allowed sides.
  // Unbounded quantity in practice (clamped at 100 per die in rollDiceMixed).
  const [counts, setCounts] = useState({ 4: 0, 6: 0, 8: 0, 10: 0, 12: 0, 20: 0 });
  const log = state.diceLog || [];

  const totalDice = Object.values(counts).reduce((a, b) => a + b, 0);
  const expression = ALLOWED_DIE_SIDES
    .filter(s => counts[s] > 0)
    .map(s => `${counts[s]}d${s}`)
    .join(' + ') || '(pick dice)';

  const bump = (sides, delta) => {
    setCounts(c => ({
      ...c,
      [sides]: Math.max(0, Math.min(100, (c[sides] | 0) + delta)),
    }));
  };
  const setExact = (sides, val) => {
    const n = Math.max(0, Math.min(100, Number(val) | 0));
    setCounts(c => ({ ...c, [sides]: n }));
  };
  const clearAll = () => setCounts({ 4: 0, 6: 0, 8: 0, 10: 0, 12: 0, 20: 0 });

  const handleRoll = () => {
    if (totalDice === 0) return;
    const entry = rollDiceMixed(counts, myPeerId || (isDM ? 'dm' : 'player'), myName);
    onRoll(entry);
    // Leave the tray filled so the player can repeat a complex roll
    // with one tap. They can hit Clear to start over.
  };

  // Quick-roll d20 (single) convenience button — the most common D&D
  // use case. Routes through rollDiceMixed with a one-shot counts.
  const quickD20 = () => {
    const entry = rollDiceMixed({ 20: 1 }, myPeerId || (isDM ? 'dm' : 'player'), myName);
    onRoll(entry);
  };

  const fmtTime = (ts) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Render a single dice log entry. Handles BOTH the new `groups`
  // shape (v7.2) and the legacy `dice` flat array (v7.0/v7.1).
  const renderEntry = (e) => {
    const isMine = e.peerId === myPeerId || (isDM && e.peerId === 'dm');
    // Normalize to groups for consistent rendering
    const groups = e.groups || (e.dice ? [{
      die: e.dice[0]?.die,
      results: e.dice.map(d => d.result),
    }] : []);
    // Crit/fail highlights only apply when the roll is a single d20
    const isSingleD20 = groups.length === 1 && groups[0].die === 20 && groups[0].results.length === 1;
    const isCrit20 = isSingleD20 && groups[0].results[0] === 20;
    const isCrit1 = isSingleD20 && groups[0].results[0] === 1;
    const expr = e.expression
      || groups.map(g => `${g.results.length}d${g.die}`).join(' + ');
    return (
      <div key={e.id} className={`dice-log-entry ${isMine ? 'mine' : ''} ${isCrit20 ? 'crit' : ''} ${isCrit1 ? 'fail' : ''}`}>
        <div className="dice-log-head">
          <span className="dice-log-who">{e.peerName}</span>
          <span className="dice-log-when">{fmtTime(e.ts)}</span>
        </div>
        <div className="dice-log-roll">
          <span className="dice-log-spec">{expr}</span>
          <span className="dice-log-detail">
            = <strong>{e.total}</strong>
          </span>
        </div>
        {/* v7.2: breakdown per die type. Only shown when there are
            multiple dice (one die → the total IS the result). */}
        {groups.some(g => g.results.length > 1 || groups.length > 1) && (
          <div className="dice-log-breakdown">
            {groups.map((g, i) => (
              <div key={i} className="dice-log-breakdown-row">
                <span className="dice-log-breakdown-die">d{g.die}:</span>
                <span className="dice-log-breakdown-vals">{g.results.join(', ')}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <FloatPanel style={{ right: 16, top: 80, width: 320 }}>
      <div className="float-panel-header">
        <span>🎲 Dice</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        <label className="settings-label">
          Build your roll
          {totalDice > 0 && (
            <button className="btn sm ghost" style={{ float: 'right', marginTop: -4 }}
              onClick={clearAll}>Clear</button>
          )}
        </label>
        <div className="dice-steppers">
          {ALLOWED_DIE_SIDES.map(s => (
            <div key={s} className="dice-stepper">
              <span className="dice-stepper-label">d{s}</span>
              <button className="dice-stepper-btn"
                onClick={() => bump(s, -1)}
                disabled={counts[s] <= 0}
                aria-label={`Remove a d${s}`}>−</button>
              <input className="dice-stepper-input"
                type="number" min="0" max="100"
                value={counts[s]}
                onChange={e => setExact(s, e.target.value)}
                aria-label={`Number of d${s}`} />
              <button className="dice-stepper-btn"
                onClick={() => bump(s, +1)}
                aria-label={`Add a d${s}`}>+</button>
            </div>
          ))}
        </div>

        <div className="dice-expression">
          <span className="dice-expression-label">Expression</span>
          <span className="dice-expression-value">{expression}</span>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          <button className="btn primary"
            onClick={handleRoll}
            disabled={totalDice === 0}
            style={{ flex: 1 }}
            title={totalDice === 0 ? 'Pick some dice first' : `Roll ${expression}`}>
            🎲 Roll
          </button>
          <button className="btn sm"
            onClick={quickD20}
            title="Quick d20 without changing the tray">
            d20
          </button>
        </div>

        <label className="settings-label">
          Recent <span className="settings-label-sub">— {log.length}</span>
          {isDM && log.length > 0 && (
            <button className="btn sm ghost danger" style={{ float: 'right', marginTop: -4 }}
              onClick={() => {
                if (confirm('Clear the dice log for everyone?')) {
                  dispatch({ type: 'DICE_LOG_CLEAR' });
                }
              }}>
              Clear
            </button>
          )}
        </label>
        <div className="dice-log">
          {log.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--ink-dim)', fontStyle: 'italic' }}>
              No rolls yet. Pick some dice above and tap Roll.
            </div>
          )}
          {log.map(renderEntry)}
        </div>
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// DRAWING PANEL  (v6 #10)
// ====================================================================
// Tool palette for the on-map drawing overlay. Both DM and players can
// draw on the shared map surface; the panel lets them pick a color, a
// line width, and the mode (free / line / circle).
//
// Also offers "Clear mine" and (DM only) "Clear all" to wipe the map.
function DrawingPanel({
  state, onClose,
  drawMode, setDrawMode,
  drawColor, setDrawColor,
  drawWidth, setDrawWidth,
  onClearOwn, onClearAll,
  isDM,
}) {
  const palette = ['#c9a34a', '#e05a5a', '#3fa679', '#5a8ec9', '#c46ab8', '#f0d77a', '#ffffff', '#222222'];
  return (
    <FloatPanel style={{ right: 16, top: 80, width: 260 }}>
      <div className="float-panel-header">
        <span>✒ Draw</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        <label className="settings-label">Mode</label>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
          <button className={`btn sm ${drawMode === 'free' ? 'active' : ''}`}
            onClick={() => setDrawMode(drawMode === 'free' ? null : 'free')}>✒ Free</button>
          <button className={`btn sm ${drawMode === 'line' ? 'active' : ''}`}
            onClick={() => setDrawMode(drawMode === 'line' ? null : 'line')}>╱ Line</button>
          <button className={`btn sm ${drawMode === 'circle' ? 'active' : ''}`}
            onClick={() => setDrawMode(drawMode === 'circle' ? null : 'circle')}>◯ Circle</button>
        </div>

        <label className="settings-label">Color</label>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
          {palette.map(c => (
            <button key={c} className="draw-swatch"
              style={{ background: c, outline: drawColor === c ? '2px solid var(--gold-bright)' : '1px solid var(--border-soft)' }}
              onClick={() => setDrawColor(c)}
              title={c} />
          ))}
          <input type="color" value={drawColor} onChange={e => setDrawColor(e.target.value)}
            className="draw-color-input" title="Custom color" />
        </div>

        <label className="settings-label">Width <span className="settings-label-sub">({drawWidth}px)</span></label>
        <input type="range" min="1" max="16" step="1"
          value={drawWidth}
          onChange={e => setDrawWidth(Number(e.target.value))}
          style={{ width: '100%', marginBottom: 12 }} />

        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn sm" onClick={onClearOwn}>Clear mine</button>
          {isDM && <button className="btn sm danger" onClick={onClearAll}>Clear all</button>}
        </div>
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// DM WORLD PANEL
// ====================================================================
function DMWorldPanel({
  state, dispatch, onClose, toast,
  onToggleBlockPlace, onToggleFreeBlockPlace, onToggleCircleBlockPlace, onToggleEraseBlock,
  placingBlock, placingFreeBlock, placingCircleBlock, erasingBlock,
}) {
  const peers = Object.entries(state.claims || {});
  const currentMapId = state.currentMapId;
  const tod = state.timeOfDay || 0;
  const maps = state.maps || {};

  const setPeerPush = (peerId, mapId) => {
    dispatch({ type: 'FORCED_VIEW_PEER_SET', peerId, mapId });
    if (mapId) toast('Pushed view to player', 'success');
  };
  const clearAllPush = () => {
    dispatch({ type: 'FORCED_VIEW', forcedView: null });
    dispatch({ type: 'FORCED_VIEW_PEER_CLEAR_ALL' });
    toast('All push-views released');
  };
  const pushGlobal = () => {
    if (state.forcedView?.mapId === currentMapId) {
      dispatch({ type: 'FORCED_VIEW', forcedView: null });
      toast('Global push released');
    } else {
      // v4 FIX #13: clear per-peer overrides so the global push actually
      // reaches everyone. Previously, peers with an individual push would
      // keep their override (filter resolves per-peer first).
      dispatch({ type: 'FORCED_VIEW_PEER_CLEAR_ALL' });
      dispatch({ type: 'FORCED_VIEW', forcedView: { mapId: currentMapId } });
      toast('Pushed to all players', 'success');
    }
  };

  return (
    <FloatPanel className="world-panel" style={{ right: 16, top: 80, width: 360 }}>
      <div className="float-panel-header">
        <span>🌍 World</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">

        {/* Time of day */}
        <div className="settings-section">
          <label className="settings-label">Time of Day</label>
          <div className="scale-row">
            <span className="mono" style={{ fontSize: 11, color: 'var(--gold-dim)' }}>☀</span>
            <input type="range" min="0" max="1" step="0.02"
              value={tod}
              onChange={(e) => dispatch({ type: 'TIME_OF_DAY_SET', value: Number(e.target.value) })} />
            <span className="mono" style={{ fontSize: 11, color: 'var(--azure)' }}>☾</span>
            <span className="mono scale-value">{Math.round(tod * 100)}%</span>
          </div>
          <div className="settings-hint">
            Shifts the player view from daylight toward deep night. DM view stays unchanged.
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
            {[
              { label: 'Day', v: 0 },
              { label: 'Dusk', v: 0.5 },
              { label: 'Night', v: 0.85 },
              { label: 'Deepest', v: 1 },
            ].map(p => (
              <button key={p.label} className={`btn sm ${Math.abs(tod - p.v) < 0.03 ? 'active' : ''}`}
                onClick={() => dispatch({ type: 'TIME_OF_DAY_SET', value: p.v })}>{p.label}</button>
            ))}
          </div>
        </div>

        {/* Block zones */}
        <div className="settings-section">
          <label className="settings-label">Block Zones <span className="settings-label-sub">— hide portions of the current map from players</span></label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className={`btn sm ${placingBlock ? 'active' : ''}`}
              onClick={onToggleBlockPlace}>
              {placingBlock ? '◼ Click-drag…' : '◼ Rectangle'}
            </button>
            <button className={`btn sm ${placingFreeBlock ? 'active' : ''}`}
              onClick={onToggleFreeBlockPlace}>
              {placingFreeBlock ? '✎ Drawing…' : '✎ Freeform'}
            </button>
            <button className={`btn sm ${placingCircleBlock ? 'active' : ''}`}
              onClick={onToggleCircleBlockPlace}>
              {placingCircleBlock ? '⬤ Click-drag…' : '⬤ Circle'}
            </button>
            <button className={`btn sm ${erasingBlock ? 'danger active' : ''}`}
              onClick={onToggleEraseBlock}>
              {erasingBlock ? '✕ Erasing…' : '✕ Eraser'}
            </button>
            <button className="btn sm danger"
              disabled={!(state.blockZones?.[currentMapId] || []).length}
              onClick={() => {
                if (confirm('Clear all block zones on this map?')) {
                  dispatch({ type: 'BLOCK_ZONE_CLEAR_MAP', mapId: currentMapId });
                }
              }}>
              Clear All
            </button>
          </div>
          <div className="settings-hint">
            {(state.blockZones?.[currentMapId] || []).length} block zone(s). Shapes can overlap. The eraser removes any block it touches while held; clear individual shapes by double-clicking them.
          </div>
        </div>

        {/* Push-view */}
        <div className="settings-section">
          <label className="settings-label">Push View</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <button className={`btn sm ${state.forcedView?.mapId === currentMapId ? 'danger active' : ''}`}
              onClick={pushGlobal}>
              {state.forcedView?.mapId === currentMapId ? '⚑ Release All' : '⚑ Push to All'}
            </button>
            <button className="btn sm ghost" onClick={clearAllPush}>Clear all pushes</button>
          </div>
          {peers.length === 0 ? (
            <div className="settings-hint">No players connected.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {peers.map(([peerId, claim]) => {
                const pushed = state.forcedViewPerPeer?.[peerId];
                return (
                  <div key={peerId} className="world-peer-row">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500, fontSize: 12 }}>
                        {claim.playerName || <em style={{ color: 'var(--ink-mute)' }}>unnamed</em>}
                      </div>
                      <div className="mono" style={{ fontSize: 10, color: 'var(--ink-mute)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {pushed ? `locked → ${maps[pushed.mapId]?.name || '?'}` : 'free'}
                      </div>
                    </div>
                    <select className="mono" style={{ padding: '4px 6px', fontSize: 11, maxWidth: 140 }}
                      value={pushed?.mapId || ''}
                      onChange={(e) => setPeerPush(peerId, e.target.value || null)}>
                      <option value="">— free —</option>
                      {Object.values(maps).map(m => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>
    </FloatPanel>
  );
}

// ====================================================================
// DM CLAIMS PANEL  (DM view of who has claimed what)
// ====================================================================
function DMClaimsPanel({ state, dispatch, sync, onClose, toast }) {
  const peers = Object.entries(state.claims || {});
  // v4 fix #5: DM kicks a peer. Also dispatches DM_KICK_PEER to clear
  // claims/reminders/bonds in the synced state.
  const kickPeer = (peerId, name) => {
    if (!confirm(`Kick ${name || 'this player'} from the session? This releases their claim and disconnects them.`)) return;
    try { sync?.kickPeer(peerId, 'The DM has removed you from the session.'); } catch {}
    dispatch({ type: 'DM_KICK_PEER', peerId });
    toast('Player removed', 'success');
  };
  return (
    <FloatPanel style={{ right: 16, top: 80, width: 360 }}>
      <div className="float-panel-header">
        <span>⚐ Claimed Characters</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        {peers.length === 0 ? (
          <div className="empty-state"><span className="glyph">⚔</span>No players have joined yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {peers.map(([peerId, claim]) => {
              const pc = claim.pc ? state.entities[claim.pc] : null;
              return (
                <div key={peerId} className="claim-row">
                  <div className="claim-row-header">
                    <span className="claim-peer-name">{claim.playerName || <em style={{color:'var(--ink-mute)'}}>Unknown player</em>}</span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {claim.spectator && <span className="claim-badge spectator">Spectator</span>}
                      {sync && (
                        <button className="btn sm danger" title="Kick player"
                          onClick={() => kickPeer(peerId, claim.playerName)}>
                          🚫 Kick
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="claim-peer-id mono">id: {peerId.slice(0, 12)}…</div>
                  {pc ? (
                    <div className="claim-entity-row">
                      <div className="entity-swatch" style={{ background: pc.color, width: 12, height: 12 }} />
                      <span style={{ flex: 1, fontWeight: 500 }}>{pc.name}</span>
                      <span className="mono" style={{ color: 'var(--ink-mute)', fontSize: 11 }}>{pc.hp.current}/{pc.hp.max}</span>
                      <button className="btn sm danger" onClick={() => {
                        if (confirm(`Release ${pc.name} from this player?`)) {
                          dispatch({ type: 'DM_UNCLAIM_PC', entityId: pc.id });
                          toast('Claim released');
                        }
                      }}>Unclaim</button>
                    </div>
                  ) : !claim.spectator && (
                    <div className="claim-entity-row" style={{ color: 'var(--ink-mute)', fontStyle: 'italic' }}>No character claimed</div>
                  )}
                  {(claim.familiars || []).map(fid => {
                    const fam = state.entities[fid];
                    if (!fam) return null;
                    return (
                      <div key={fid} className="claim-entity-row" style={{ paddingLeft: 20 }}>
                        <div className="entity-swatch" style={{ background: fam.color, width: 10, height: 10 }} />
                        <span style={{ flex: 1, fontSize: 12 }}>{fam.name}</span>
                        <span className="familiar-badge">FAM</span>
                        <button className="btn sm ghost" onClick={() => {
                          if (confirm(`Release ${fam.name} from this player?`)) {
                            dispatch({ type: 'DM_UNCLAIM_FAMILIAR', entityId: fam.id });
                          }
                        }}>×</button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// BREADCRUMB
// ====================================================================
function Breadcrumb({ map, maps, onSwitch }) {
  const chain = [];
  let c = map;
  while (c) {
    chain.unshift(c);
    c = c.parentId ? maps[c.parentId] : null;
  }
  return (
    <div className="breadcrumb">
      {chain.map((m, i) => (
        <React.Fragment key={m.id}>
          {i > 0 && <span className="breadcrumb-sep">›</span>}
          <span
            className={`breadcrumb-item ${i === chain.length - 1 ? 'current' : ''}`}
            onClick={i === chain.length - 1 ? undefined : () => onSwitch(m.id)}
          >{m.name}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

// ====================================================================
// DM INTERFACE
// ====================================================================
function DMInterface({ state, dispatch, sync, syncStatus, peerCount, onLogout, roomCode, toast, settings, onSettingsChange, onOpenSettings, showSettings, onCloseSettings }) {
  // v7 #10: hook into shared sound events so the DM hears what they
  // broadcast (and any sound that arrives via state sync).
  useSoundPlayback(state);
  const [editingEntity, setEditingEntity] = useState(null);
  const [selectedEntityId, setSelectedEntityId] = useState(null);
  const [selectedTokenId, setSelectedTokenId] = useState(null);
  // v6 #12: multi-select. Shift-click to toggle, or drag-box on empty
  // canvas. Dragging any selected token moves the entire group,
  // preserving relative offsets. Independent from selectedTokenId
  // (single) — the detail panel still tracks that one.
  const [selectedTokenIds, setSelectedTokenIds] = useState(() => new Set());
  const [showInit, setShowInit] = useState(false);
  const [showMaps, setShowMaps] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const [showClaims, setShowClaims] = useState(false);
  const [showWorld, setShowWorld] = useState(false);
  const [ctxMenu, setCtxMenu] = useState(null); // { tokenId, x, y }
  const [hoveredToken, setHoveredToken] = useState(null); // { tokenId, entityId }
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
  const [placingReminder, setPlacingReminder] = useState(false);
  const [placingBlock, setPlacingBlock] = useState(false);
  const [placingFreeBlock, setPlacingFreeBlock] = useState(false);
  const [placingCircleBlock, setPlacingCircleBlock] = useState(false);
  const [erasingBlock, setErasingBlock] = useState(false);
  // v6 #11: measuring tool mode — null | 'line' | 'radius'
  const [measureMode, setMeasureMode] = useState(null);
  // v6 #10: drawing tool state (DM)
  const [drawMode, setDrawMode] = useState(null);
  const [drawColor, setDrawColor] = useState('#c9a34a');
  const [drawWidth, setDrawWidth] = useState(3);
  const [showDraw, setShowDraw] = useState(false);
  // v6 #9: hazards state (DM)
  const [placingHazard, setPlacingHazard] = useState(null);
  const [hazardVisibleDefault, setHazardVisibleDefault] = useState(true);
  const [showHazards, setShowHazards] = useState(false);
  // v7 #9: dice tray panel
  const [showDice, setShowDice] = useState(false);
  // v7 #10: soundboard panel
  const [showSounds, setShowSounds] = useState(false);
  // v7.3: token groups panel
  const [showGroups, setShowGroups] = useState(false);
  // v7.3: group hover highlight — which groupId is being hovered in
  // the panel. When set, we stamp data-group-highlight on member
  // token DOM elements via a small effect below.
  const [hoveredGroupId, setHoveredGroupId] = useState(null);
  const DM_KEY = 'dm'; // reminders key for DM ("peer id" substitute in local/hosted mode)

  const currentMapId = state.currentMapId;
  const currentMap = state.maps[currentMapId];
  const selectedToken = selectedTokenId ? state.tokens[selectedTokenId] : null;
  const selectedTokenEntity = selectedToken ? state.entities[selectedToken.entityId] : null;
  // v7.1 perf: memoize vision sources. The v7 code recomputed them on
  // every render of the DM interface — including when the user typed a
  // single character into an entity form. Now the walk only re-runs if
  // entities or tokens changed.
  const dmVisionSources = useMemo(
    () => computeVisionSources(state, currentMapId),
    [state.entities, state.tokens, currentMapId]
  );

  // v7.3 / v7.4: When the DM hovers a group row in the Groups panel,
  // stamp data-group-highlight="1" on each member token's DOM element
  // so the CSS can paint a dashed outline. Cleans up on unhover /
  // unmount.
  //
  // v7.4 fix: DON'T depend on state.tokens — that runs the DOM walk on
  // every token move, producing visible DM lag during drags. The group
  // highlight just needs to reflect the current group's memberIds; if
  // the panel hover state doesn't change and the group roster doesn't
  // change, there's no work to do. Read tokenGroups via a ref and run
  // only when hoveredGroupId changes (or the group is edited).
  const tokenGroupsRef = useRef(state.tokenGroups);
  tokenGroupsRef.current = state.tokenGroups;
  useEffect(() => {
    // Clear any previous stamps
    document.querySelectorAll('.token[data-group-highlight]')
      .forEach(el => el.removeAttribute('data-group-highlight'));
    if (!hoveredGroupId) {
      document.body.classList.remove('map-highlight-group');
      return;
    }
    const g = tokenGroupsRef.current?.[hoveredGroupId];
    if (!g) return;
    document.body.classList.add('map-highlight-group');
    for (const tid of (g.memberIds || [])) {
      const el = document.querySelector(`.token[data-tok="${tid}"]`);
      if (el) el.setAttribute('data-group-highlight', '1');
    }
    return () => {
      document.body.classList.remove('map-highlight-group');
      document.querySelectorAll('.token[data-group-highlight]')
        .forEach(el => el.removeAttribute('data-group-highlight'));
    };
  }, [hoveredGroupId]);

  // Track cursor for tooltip follow. Attached at the app-shell level.
  useEffect(() => {
    const onMove = (e) => setCursorPos({ x: e.clientX, y: e.clientY });
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  const placeEntity = (entityId, x, y) => {
    const existing = Object.values(state.tokens).find(t => t.entityId === entityId && t.mapId === state.currentMapId);
    if (existing) {
      toast('Entity already placed on this map', 'error');
      return;
    }
    dispatch({
      type: 'TOKEN_PLACE',
      token: {
        id: uid('tok_'),
        entityId,
        mapId: state.currentMapId,
        x, y,
        visible: false, // new tokens default hidden
        scale: 1.0,
      }
    });
    toast('Token placed (hidden)', 'success');
  };

  // v6 #12: token move with group-move support. If the dragged token is
  // part of the multi-selection, translate all selected tokens by the
  // same delta (preserving relative offsets). Otherwise single-move.
  //
  // v7.2: ALSO fire an ephemeral 'token_pos' envelope to all connected
  // peers immediately. This bypasses the 120ms debounced state_update
  // so remote viewers see the token follow the cursor in real time.
  // The full state_update still arrives later for persistence + vision
  // recomputation on the peer side.
  const tokenMove = (tokenId, x, y) => {
    const draggedTok = state.tokens[tokenId];
    if (draggedTok && selectedTokenIds.size > 1 && selectedTokenIds.has(tokenId)) {
      const dx = x - draggedTok.x;
      const dy = y - draggedTok.y;
      const moves = [];
      for (const tid of selectedTokenIds) {
        const t = state.tokens[tid];
        if (!t) continue;
        moves.push({ id: tid, x: t.x + dx, y: t.y + dy });
      }
      dispatch({ type: 'TOKEN_MOVE_MANY', moves });
      // Broadcast each moved token. Multi-moves are rare so the
      // N-message burst is acceptable; we throttle per-token at the
      // sender (roughly one per animation frame) below.
      if (sync?.connections) {
        for (const m of moves) {
          const tok = state.tokens[m.id];
          if (!tok) continue;
          broadcastEphemeralMove(m.id, m.x, m.y, tok.mapId);
        }
      }
      return;
    }
    dispatch({ type: 'TOKEN_MOVE', id: tokenId, x, y });
    if (draggedTok && sync?.connections) {
      broadcastEphemeralMove(tokenId, x, y, draggedTok.mapId);
    }
  };

  // v7.2: ephemeral broadcast helper with per-token rAF-ish throttling
  // so we don't saturate the WebRTC channel during 60-fps drags. We
  // store the pending move in a ref; a single rAF coalesces multiple
  // moves to the same token within one frame into one send.
  const pendingEphemeralRef = useRef({});
  const broadcastEphemeralMove = useCallback((tokenId, x, y, mapId) => {
    pendingEphemeralRef.current[tokenId] = { x, y, mapId };
    // Drain on next animation frame. rAF coalesces naturally so even a
    // 60-fps pointermove stream produces at most one send per frame.
    if (!pendingEphemeralRef.current.__raf) {
      pendingEphemeralRef.current.__raf = requestAnimationFrame(() => {
        const pending = pendingEphemeralRef.current;
        pendingEphemeralRef.current = {};
        if (!sync?.connections) return;
        for (const [tid, pos] of Object.entries(pending)) {
          if (tid === '__raf') continue;
          for (const [, conn] of sync.connections) {
            if (conn?.open) {
              try {
                conn.send({ type: 'token_pos', tokenId: tid, x: pos.x, y: pos.y, mapId: pos.mapId });
              } catch {}
            }
          }
        }
      });
    }
  }, [sync]);

  // v6 #12: Click a token with shift held → toggle it in the multi-select
  // set. Without shift → clear the set and make that token the sole
  // selection (so you can start a new group from a click).
  const tokenSingleClick = (tokenId, e) => {
    const shift = e && (e.shiftKey || e.metaKey);
    setSelectedTokenIds(prev => {
      const next = new Set(prev);
      if (shift) {
        if (next.has(tokenId)) next.delete(tokenId);
        else next.add(tokenId);
      } else {
        next.clear();
        next.add(tokenId);
      }
      return next;
    });
  };

  // Escape clears the multi-selection. Watches window-level key events.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && selectedTokenIds.size > 0) {
        setSelectedTokenIds(new Set());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedTokenIds.size]);

  const tokenDoubleClick = (tokenId) => setSelectedTokenId(tokenId);
  const tokenContextMenu = (tokenId, e) => {
    setCtxMenu({ tokenId, x: e.clientX, y: e.clientY });
  };
  const closeCtxMenu = () => setCtxMenu(null);
  // Close context menu on any click elsewhere
  useEffect(() => {
    if (!ctxMenu) return;
    const onAny = () => closeCtxMenu();
    window.addEventListener('click', onAny);
    window.addEventListener('contextmenu', onAny);
    return () => {
      window.removeEventListener('click', onAny);
      window.removeEventListener('contextmenu', onAny);
    };
  }, [ctxMenu]);

  const revealAllOnMap = (visible) => {
    dispatch({ type: 'TOKEN_REVEAL_ALL_ON_MAP', mapId: state.currentMapId, visible });
    toast(visible ? 'All tokens revealed' : 'All tokens hidden');
  };

  const saveEntity = (entity) => {
    dispatch({ type: 'ENTITY_UPSERT', entity });
    setEditingEntity(null);
    toast('Entity saved', 'success');
  };

  const deleteCurrentEntity = () => {
    if (!editingEntity || !state.entities[editingEntity.id]) { setEditingEntity(null); return; }
    if (!confirm('Delete this entity? All tokens will be removed.')) return;
    dispatch({ type: 'ENTITY_DELETE', id: editingEntity.id });
    setEditingEntity(null);
    toast('Entity deleted');
  };

  // v4 fix #15: Clone an entity's full stat block. Reducer handles the
  // new id, " (copy)" suffix, order placement, and clears DM-private
  // state (death saves, bond).
  const duplicateCurrentEntity = () => {
    if (!editingEntity || !state.entities[editingEntity.id]) return;
    dispatch({ type: 'ENTITY_DUPLICATE', id: editingEntity.id });
    setEditingEntity(null);
    toast('Entity duplicated', 'success');
  };

  const onViewportChange = (mapId, viewport) => {
    dispatch({ type: 'MAP_VIEWPORT', id: mapId, viewport });
  };

  const pushView = () => {
    if (state.forcedView?.mapId === state.currentMapId) {
      dispatch({ type: 'FORCED_VIEW', forcedView: null });
      toast('Released player view control');
    } else {
      dispatch({ type: 'FORCED_VIEW', forcedView: { mapId: state.currentMapId } });
      toast('Players locked to this map', 'success');
    }
  };

  // v3: Long rest. Restores every PC + Familiar to full HP, clears
  // recoverable conditions, resets sickness to 0, resets death saves.
  const longRestAll = () => {
    if (!confirm('Long rest: restore all PCs + familiars to full HP, clear recoverable conditions, reset sickness and death saves?')) return;
    dispatch({ type: 'LONG_REST' });
    toast('The party rests. Wounds mend, fevers break.', 'success', 4000);
  };
  const longRestOne = (entityId) => {
    dispatch({ type: 'LONG_REST', entityIds: [entityId] });
    const e = state.entities[entityId];
    toast(`${e?.name || 'Character'} has rested.`, 'success');
  };

  const exportSession = () => {
    downloadJson(state, `plagues-call-session-${Date.now()}.json`);
    toast('Session exported', 'success');
  };

  const importSession = async () => {
    const result = await pickFile();
    if (!result) return;
    try {
      const data = JSON.parse(result.content);
      if (!confirm('This replaces your current session. Continue?')) return;
      dispatch({ type: 'REPLACE', payload: data });
      toast('Session imported', 'success');
    } catch {
      toast('Invalid session file', 'error');
    }
  };

  const myReminders = state.reminders?.[DM_KEY] || [];
  const reminderUpsert = (r) => dispatch({ type: 'REMINDER_UPSERT', peerId: DM_KEY, reminder: r });
  const reminderDelete = (id) => dispatch({ type: 'REMINDER_DELETE', peerId: DM_KEY, id });

  return (
    <div className="app-shell">
      <div className="topbar">
        <span className="mode-badge dm">⚔ Dungeon Master</span>
        <span className="topbar-title">{APP_NAME}</span>
        <div className="topbar-divider" />
        <button className="btn" onClick={() => setShowMaps(true)}>⌖ Maps</button>
        <button className={`btn ${showInit ? 'active' : ''}`} onClick={() => setShowInit(!showInit)}>⚔ Initiative</button>
        <button className="btn" onClick={() => setShowPresets(true)}>❈ Presets</button>
        <button className={`btn ${showClaims ? 'active' : ''}`} onClick={() => setShowClaims(!showClaims)}>⚐ Claims</button>
        <div className="topbar-divider" />
        <button className="btn" onClick={() => revealAllOnMap(true)}>👁 Reveal All</button>
        <button className="btn" onClick={() => revealAllOnMap(false)}>🕶 Hide All</button>
        {/* v7 #6: All map-mode + panel toggles consolidated under one
            🧰 Tools button. Active tool is shown in the trigger label. */}
        <ToolsMenu
          isDM={true}
          measureMode={measureMode} setMeasureMode={setMeasureMode}
          showDraw={showDraw} setShowDraw={setShowDraw}
          showDice={showDice} setShowDice={setShowDice}
          showSounds={showSounds} setShowSounds={setShowSounds}
          showHazards={showHazards} setShowHazards={setShowHazards}
          showGroups={showGroups} setShowGroups={setShowGroups}
          placingReminder={placingReminder} setPlacingReminder={setPlacingReminder}
          placingBlock={placingBlock} setPlacingBlock={setPlacingBlock}
          placingFreeBlock={placingFreeBlock} setPlacingFreeBlock={setPlacingFreeBlock}
          placingCircleBlock={placingCircleBlock} setPlacingCircleBlock={setPlacingCircleBlock}
          erasingBlock={erasingBlock} setErasingBlock={setErasingBlock}
        />
        <button className={`btn world-btn ${showWorld ? 'active' : ''}`}
          onClick={() => setShowWorld(!showWorld)}
          title="World: push view, time of day, block zones">
          {(() => {
            // v4 #1: live time-of-day glyph + label directly on the World btn
            const tod = state.timeOfDay || 0;
            let glyph = '☀', label = 'Day';
            if (tod >= 0.95) { glyph = '☾'; label = 'Deepest'; }
            else if (tod >= 0.70) { glyph = '☾'; label = 'Night'; }
            else if (tod >= 0.40) { glyph = '◐'; label = 'Dusk'; }
            else if (tod >= 0.15) { glyph = '◑'; label = 'Eve'; }
            return <span>🌍 {glyph} <span className="world-btn-label">{label}</span></span>;
          })()}
        </button>
        <button className="btn" onClick={longRestAll}
          title="Restore HP, clear conditions, reset sickness for all party members">
          ⛭ Long Rest
        </button>
        <div className="topbar-spacer" />
        {roomCode && (
          <div className="conn-status">
            <div className={`conn-dot ${syncStatusClass(syncStatus)}`} />
            <span className="mono">{roomCode}</span>
            <span style={{ color: 'var(--ink-dim)' }}>· {peerCount} {peerCount === 1 ? 'player' : 'players'}</span>
          </div>
        )}
        <button className="btn" onClick={exportSession}>⇩ Export</button>
        <button className="btn" onClick={importSession}>⇧ Import</button>
        <button className="btn ghost" title="Settings" onClick={onOpenSettings}>⚙</button>
        <button className="btn ghost" onClick={onLogout}>⎋ Exit</button>
      </div>

      <div className="main">
        <div className="sidebar">
          <EntitySidebar
            state={state}
            dispatch={dispatch}
            onEditEntity={setEditingEntity}
            onSelectEntity={setSelectedEntityId}
            selectedEntityId={selectedEntityId}
          />
        </div>

        <div className="canvas-container">
          <MapCanvas
            map={currentMap}
            entities={state.entities}
            tokens={state.tokens}
            initiative={state.initiative}
            mode="dm"
            onTokenMove={tokenMove}
            onTokenDoubleClick={tokenDoubleClick}
            onTokenContextMenu={tokenContextMenu}
            onPlaceEntity={placeEntity}
            onViewportChange={onViewportChange}
            selectedTokenId={selectedTokenId}
            selectedTokenIds={selectedTokenIds}
            onTokenSingleClick={tokenSingleClick}
            onSelectTokens={(ids) => setSelectedTokenIds(new Set(ids))}
            mapScale={state.mapScale || 1}
            reminders={myReminders}
            onReminderUpsert={reminderUpsert}
            onReminderDelete={reminderDelete}
            placingReminder={placingReminder}
            onPlaceReminderDone={() => setPlacingReminder(false)}
            hoveredTokenId={hoveredToken?.tokenId}
            onTokenHoverChange={setHoveredToken}
            blockZones={state.blockZones?.[state.currentMapId] || []}
            placingBlock={placingBlock}
            onPlaceBlockDone={() => setPlacingBlock(false)}
            placingFreeBlock={placingFreeBlock}
            onPlaceFreeBlockDone={() => setPlacingFreeBlock(false)}
            placingCircleBlock={placingCircleBlock}
            onPlaceCircleBlockDone={() => setPlacingCircleBlock(false)}
            erasingBlock={erasingBlock}
            onPlaceEraseBlockDone={() => {/* keep eraser active across drags */}}
            measureMode={measureMode}
            onMeasureModeDone={() => setMeasureMode(null)}
            drawings={state.drawings?.[state.currentMapId] || []}
            drawMode={drawMode}
            drawColor={drawColor}
            drawWidth={drawWidth}
            drawOwner="dm"
            onDrawingUpsert={(d) => dispatch({ type: 'DRAWING_UPSERT', mapId: state.currentMapId, drawing: d })}
            hazards={state.hazards?.[state.currentMapId] || []}
            placingHazard={placingHazard}
            hazardVisibleDefault={hazardVisibleDefault}
            onHazardUpsert={(h) => dispatch({ type: 'HAZARD_UPSERT', mapId: state.currentMapId, hazard: h })}
            onHazardDelete={(id) => dispatch({ type: 'HAZARD_DELETE', mapId: state.currentMapId, id })}
            onPlaceHazardDone={() => setPlacingHazard(null)}
            onBlockUpsert={(zone) => dispatch({ type: 'BLOCK_ZONE_UPSERT', mapId: state.currentMapId, zone })}
            onBlockDelete={(id) => dispatch({ type: 'BLOCK_ZONE_DELETE', mapId: state.currentMapId, id })}
            visionSources={dmVisionSources}
          />

          <TokenTooltip hovered={hoveredToken} entities={state.entities} mode="dm" x={cursorPos.x} y={cursorPos.y} />

          <div className="canvas-overlay top-left">
            <Breadcrumb map={currentMap} maps={state.maps} onSwitch={(id) => dispatch({ type: 'MAP_SWITCH', id })} />
          </div>

          {showInit && <InitiativeTracker state={state} dispatch={dispatch} mode="dm" onClose={() => setShowInit(false)} />}
          {showMaps && <MapManager state={state} dispatch={dispatch} onClose={() => setShowMaps(false)} toast={toast} />}
          {showPresets && <PresetsPanel state={state} dispatch={dispatch} onClose={() => setShowPresets(false)} toast={toast} />}
          {showClaims && <DMClaimsPanel state={state} dispatch={dispatch} sync={sync} onClose={() => setShowClaims(false)} toast={toast} />}
          {showWorld && (
            <DMWorldPanel
              state={state}
              dispatch={dispatch}
              toast={toast}
              onClose={() => setShowWorld(false)}
              placingBlock={placingBlock}
              placingFreeBlock={placingFreeBlock}
              placingCircleBlock={placingCircleBlock}
              erasingBlock={erasingBlock}
              onToggleBlockPlace={() => {
                setPlacingBlock(p => !p);
                setPlacingFreeBlock(false);
                setPlacingCircleBlock(false);
                setErasingBlock(false);
              }}
              onToggleFreeBlockPlace={() => {
                setPlacingFreeBlock(p => !p);
                setPlacingBlock(false);
                setPlacingCircleBlock(false);
                setErasingBlock(false);
              }}
              onToggleCircleBlockPlace={() => {
                setPlacingCircleBlock(p => !p);
                setPlacingBlock(false);
                setPlacingFreeBlock(false);
                setErasingBlock(false);
              }}
              onToggleEraseBlock={() => {
                setErasingBlock(p => !p);
                setPlacingBlock(false);
                setPlacingFreeBlock(false);
                setPlacingCircleBlock(false);
              }}
            />
          )}

          {showDraw && (
            <DrawingPanel
              state={state}
              onClose={() => setShowDraw(false)}
              drawMode={drawMode} setDrawMode={setDrawMode}
              drawColor={drawColor} setDrawColor={setDrawColor}
              drawWidth={drawWidth} setDrawWidth={setDrawWidth}
              onClearOwn={() => {
                dispatch({ type: 'DRAWING_CLEAR_OWNER', mapId: state.currentMapId, owner: 'dm' });
                toast('Cleared your drawings');
              }}
              onClearAll={() => {
                if (confirm('Clear ALL drawings on this map (including players\')?')) {
                  dispatch({ type: 'DRAWING_CLEAR_MAP', mapId: state.currentMapId });
                  toast('Cleared all drawings');
                }
              }}
              isDM={true}
            />
          )}

          {showHazards && (
            <HazardsPanel
              state={state}
              dispatch={dispatch}
              toast={toast}
              onClose={() => setShowHazards(false)}
              placingHazard={placingHazard}
              setPlacingHazard={setPlacingHazard}
              hazardVisibleDefault={hazardVisibleDefault}
              setHazardVisibleDefault={setHazardVisibleDefault}
            />
          )}

          {showDice && (
            <DiceTray
              state={state}
              onClose={() => setShowDice(false)}
              myPeerId="dm"
              myName="DM"
              isDM={true}
              dispatch={dispatch}
              onRoll={(entry) => dispatch({ type: 'DICE_ROLL', entry })}
            />
          )}

          {showSounds && (
            <SoundboardPanel
              state={state}
              dispatch={dispatch}
              toast={toast}
              onClose={() => setShowSounds(false)}
              isDM={true}
              peerList={peerList}
              onPlay={async (soundId, targetPeerId) => {
                let dataUrl = null, name = null;
                try {
                  const rec = await idbGet(IDB_STORES.sounds, soundId);
                  if (rec) { dataUrl = rec.dataUrl; name = rec.name; }
                } catch {}
                const ev = {
                  id: uid('sev_'),
                  ts: Date.now(),
                  soundId,
                  action: 'play',
                  dataUrl,
                  name,
                };
                dispatch({ type: 'SOUND_EVENT', event: ev });
                if (dataUrl) {
                  if (targetPeerId) {
                    sync.sendSoundDataTo(targetPeerId, soundId, name, dataUrl);
                  } else {
                    sync.sendSoundData(soundId, name, dataUrl);
                  }
                }
              }}
              onStop={(soundId) => {
                dispatch({ type: 'SOUND_EVENT', event: {
                  id: uid('sev_'), ts: Date.now(), soundId, action: 'stop',
                }});
              }}
            />
          )}

          {/* v7.3: Token groups panel */}
          {showGroups && (
            <GroupsPanel
              state={state}
              dispatch={dispatch}
              toast={toast}
              onClose={() => setShowGroups(false)}
              currentMapId={currentMapId}
              selectedTokenIds={selectedTokenIds}
              onHighlightGroupMembers={(groupId, on) => {
                setHoveredGroupId(on ? groupId : null);
              }}
            />
          )}

          {selectedToken && selectedTokenEntity && (
            <TokenDetailPanel
              state={state}
              token={selectedToken}
              entity={selectedTokenEntity}
              mode="dm"
              dispatch={dispatch}
              onLongRest={longRestOne}
              onClose={() => setSelectedTokenId(null)}
            />
          )}
        </div>{/* /canvas-container */}

        {ctxMenu && (() => {
          const t = state.tokens[ctxMenu.tokenId];
          if (!t) return null;
          const ent = state.entities[t.entityId];
          return (
            <div
              className="token-ctx-menu"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <div className="token-ctx-header">
                <div className="entity-swatch" style={{ background: ent?.color, width: 10, height: 10 }} />
                <span>{ent?.name || 'Token'}</span>
              </div>
              <button className="token-ctx-item" onClick={() => {
                dispatch({ type: 'TOKEN_VISIBILITY', id: t.id, visible: !t.visible });
                closeCtxMenu();
              }}>
                <span className="ctx-icon">{t.visible ? '🕶' : '👁'}</span>
                {t.visible ? 'Hide from players' : 'Reveal to players'}
              </button>
              <button className="token-ctx-item" onClick={() => {
                setSelectedTokenId(t.id);
                closeCtxMenu();
              }}>
                <span className="ctx-icon">◈</span>
                Open details
              </button>
              {ent && (
                <button className="token-ctx-item" onClick={() => {
                  setEditingEntity(ent);
                  closeCtxMenu();
                }}>
                  <span className="ctx-icon">✎</span>
                  Edit entity
                </button>
              )}
              <div className="token-ctx-sep" />
              <button className="token-ctx-item danger" onClick={() => {
                if (confirm('Remove this token from the map?')) dispatch({ type: 'TOKEN_REMOVE', id: t.id });
                closeCtxMenu();
              }}>
                <span className="ctx-icon">✕</span>
                Remove token
              </button>
            </div>
          );
        })()}

        {editingEntity && (
          <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setEditingEntity(null)}>
            <div className="modal slide-up">
              <div className="float-panel-header">
                <span>{state.entities[editingEntity.id] ? '✎ Edit Entity' : '＋ New Entity'}</span>
                <button className="close-x" onClick={() => setEditingEntity(null)}>×</button>
              </div>
              <div className="float-panel-body">
                <EntityForm
                  initial={editingEntity}
                  onSave={saveEntity}
                  onCancel={() => setEditingEntity(null)}
                />
                {state.entities[editingEntity.id] && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 6, justifyContent: 'space-between' }}>
                    <button className="btn" onClick={duplicateCurrentEntity} title="Create a copy of this entity">⎘ Duplicate</button>
                    <button className="btn danger" onClick={deleteCurrentEntity}>Delete Entity</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {showSettings && (
        <SettingsModal
          settings={settings}
          onChange={onSettingsChange}
          onClose={onCloseSettings}
          mode="dm"
          mapScale={state.mapScale || 1}
          onMapScaleChange={(v) => dispatch({ type: 'MAP_SCALE_SET', scale: v })}
        />
      )}
    </div>
  );
}

// ====================================================================
// PARTY SIDEBAR (Player — left)
// ====================================================================
// Shows all PCs and Familiars with HP bars and conditions. Player's own
// characters (PC + claimed familiars) are visually distinguished. This
// never leaks hidden-enemy info because it only iterates PC/Familiar types.
function PartySidebar({ state, claimedEntityId, ownedFamiliarIds = [], currentMapId, onSelectPC }) {
  // v3: only include party members who have a token on the current map.
  // Players on other maps are elsewhere in the world and shouldn't clutter
  // the current-scene sidebar.
  const entityIdsOnMap = useMemo(() => {
    const s = new Set();
    for (const t of Object.values(state.tokens)) {
      if (t.mapId === currentMapId) s.add(t.entityId);
    }
    return s;
  }, [state.tokens, currentMapId]);

  const partyMembers = Object.values(state.entities)
    .filter(e => (e.type === 'PC' || e.type === 'Familiar') && entityIdsOnMap.has(e.id))
    // Maintain DM-set order for stable presentation
    .sort((a, b) => {
      const order = state.entityOrder || [];
      const ai = order.indexOf(a.id);
      const bi = order.indexOf(b.id);
      if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  const ownedFamiliarSet = new Set(ownedFamiliarIds);

  return (
    <div className="sidebar player-sidebar left">
      <div className="sidebar-section">
        <div className="sidebar-title">
          <span>⚜ The Party</span>
        </div>
      </div>
      <div className="sidebar-section grow">
        <div className="party-list">
          {partyMembers.length === 0 ? (
            <div className="empty-state"><span className="glyph">✦</span>No party members yet.</div>
          ) : partyMembers.map(e => {
            const hpPct = e.hp.max > 0 ? (e.hp.current / e.hp.max) * 100 : 0;
            const hpClass = hpPct <= 25 ? 'critical' : hpPct <= 50 ? 'low' : '';
            const isYou = e.id === claimedEntityId || ownedFamiliarSet.has(e.id);
            const isFamiliar = e.type === 'Familiar';
            const isDown = e.hp.current <= 0;
            return (
              <div
                key={e.id}
                className={`party-card ${isYou ? 'you' : ''} ${isDown ? 'down' : ''} ${isFamiliar ? 'familiar-card' : ''}`}
                onClick={() => onSelectPC?.(e.id)}
              >
                <div className="party-avatar" style={{ background: e.color }}>
                  {e.imageUrl
                    ? <img src={e.imageUrl} alt="" draggable="false" />
                    : (e.name[0] || '?').toUpperCase()}
                </div>
                <div className="party-info">
                  <div className="party-name">
                    {e.name}
                    {isYou && e.id === claimedEntityId && <span className="own-pc-badge">YOU</span>}
                    {isYou && isFamiliar && <span className="familiar-badge">YOURS</span>}
                    {isFamiliar && !isYou && <span className="familiar-badge dim">FAM</span>}
                  </div>
                  <div className="party-meta mono">
                    {isFamiliar ? (e.faction ? `bond: ${e.faction}` : 'Familiar') : `L${e.level} ${e.class || ''}`}
                  </div>
                  <div className="party-hp-row">
                    <div className="party-hp-bar">
                      <div className={`party-hp-fill ${hpClass}`} style={{ width: `${hpPct}%` }} />
                    </div>
                    <span className={`party-hp-text mono ${hpClass}`}>{e.hp.current}/{e.hp.max}</span>
                  </div>
                  {e.conditions.length > 0 && (
                    <div className="party-conditions">
                      {e.conditions.slice(0, 6).map(c => (
                        <span key={c} className="party-cond-pill" style={{ background: CONDITION_COLORS[c] || '#555' }}>
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// REVEALED MONSTERS SIDEBAR (Player — right)
// ====================================================================
// Lists monsters that have been revealed (visible tokens) to the player,
// showing the player-visible description and an approximate condition label.
function RevealedMonstersSidebar({ state, currentMapId }) {
  // v3: scope to current map — a foe revealed in another scene should not
  // leak into the current scene's right panel.
  const revealedFoes = useMemo(() => {
    const byId = new Map();
    for (const t of Object.values(state.tokens)) {
      if (!t.visible) continue;
      if (t.mapId !== currentMapId) continue;
      const ent = state.entities[t.entityId];
      if (!ent) continue;
      if (!['Monster', 'Neutral Beast', 'NPC'].includes(ent.type)) continue;
      if (!byId.has(ent.id)) byId.set(ent.id, { entity: ent, tokens: [] });
      byId.get(ent.id).tokens.push(t);
    }
    return Array.from(byId.values());
  }, [state.tokens, state.entities, currentMapId]);

  return (
    <div className="sidebar player-sidebar right">
      <div className="sidebar-section">
        <div className="sidebar-title">
          <span>❖ Revealed</span>
        </div>
      </div>
      <div className="sidebar-section grow">
        <div className="revealed-list">
          {revealedFoes.length === 0 ? (
            <div className="empty-state"><span className="glyph">❖</span>Nothing revealed yet.</div>
          ) : revealedFoes.map(({ entity: e, tokens }) => {
            const hpPct = e.hp.max > 0 ? (e.hp.current / e.hp.max) * 100 : 0;
            const status = hpPct <= 0 ? 'Down' : hpPct < 30 ? 'Waning' : hpPct <= 70 ? 'Rough' : 'Strong';
            const swatchClass = TOKEN_SHAPE_CLASS[e.type] || 'monster';
            return (
              <div key={e.id} className={`revealed-card revealed-type-${swatchClass}`}>
                <div className="revealed-header">
                  <div className={`entity-swatch ${swatchClass}`} style={{ background: e.color }} />
                  <div className="revealed-name">{e.name}</div>
                  <div className={`status-label status-${status.toLowerCase()}`}>{status}</div>
                </div>
                <div className="revealed-type-badge">{e.type}</div>
                {e.playerDescription ? (
                  <div className="revealed-desc">{e.playerDescription}</div>
                ) : (
                  <div className="revealed-desc" style={{ fontStyle: 'italic', color: 'var(--ink-mute)' }}>
                    A creature of uncertain nature.
                  </div>
                )}
                {e.conditions.length > 0 && (
                  <div className="revealed-conditions">
                    {e.conditions.map(c => (
                      <span key={c} className="party-cond-pill" style={{ background: CONDITION_COLORS[c] || '#555' }}>
                        {c}
                      </span>
                    ))}
                  </div>
                )}
                {tokens.length > 1 && (
                  <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 4, fontStyle: 'italic' }}>
                    {tokens.length} on the field
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// PLAYER INTERFACE
// ====================================================================
function PlayerInterface({ state, dispatch, myPeerId, playerName, sync, syncStatus, onLogout, roomCode, toast, settings, onSettingsChange, onOpenSettings, showSettings, onCloseSettings }) {
  // v7 #10: hook into shared sound events so the player hears whatever
  // the DM plays for the table.
  useSoundPlayback(state);
  const [selectedTokenId, setSelectedTokenId] = useState(null);
  const [showInit, setShowInit] = useState(false);
  const [showClaim, setShowClaim] = useState(false);
  const [showSheet, setShowSheet] = useState(false); // dedicated "Edit My Sheet" modal
  const [hoveredToken, setHoveredToken] = useState(null);
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
  const [placingReminder, setPlacingReminder] = useState(false);
  // v6 #11: measuring tool mode — null | 'line' | 'radius'
  const [measureMode, setMeasureMode] = useState(null);
  // v6 #10: drawing tool state (player)
  const [drawMode, setDrawMode] = useState(null);
  const [drawColor, setDrawColor] = useState('#5a8ec9');
  const [drawWidth, setDrawWidth] = useState(3);
  const [showDraw, setShowDraw] = useState(false);
  // v7 #9: dice tray (player)
  const [showDice, setShowDice] = useState(false);

  // v2: read claim record (pc + familiars + playerName + spectator)
  const myClaim = state.claims?.[myPeerId] || { pc: null, familiars: [], playerName: '', spectator: false };
  const claimedEntityId = myClaim.pc || null;
  const claimedEntity = claimedEntityId ? state.entities[claimedEntityId] : null;
  const claimedFamiliarIds = myClaim.familiars || [];
  const hasMadeChoice = !!claimedEntityId || myClaim.spectator || claimedFamiliarIds.length > 0;
  // Set of entity IDs the player is allowed to move/edit
  const ownedEntityIds = useMemo(() => {
    const s = new Set(claimedFamiliarIds);
    if (claimedEntityId) s.add(claimedEntityId);
    return s;
  }, [claimedEntityId, claimedFamiliarIds]);

  // v3: resolve owned entities for the vision-enable check. Derives from
  // ownedEntityIds so it stays consistent with movement permissions and
  // bonded familiars.
  const visionOwned = useMemo(
    () => Array.from(ownedEntityIds).map(id => state.entities[id]).filter(Boolean),
    [ownedEntityIds, state.entities]
  );

  // v2: sickness visual filter. Only the player's own PC's sickness counts.
  const sicknessLevel = claimedEntity?.sickness || 0;

  const currentMapId = state.forcedView?.mapId || state.playerMapOverride || state.currentMapId;
  const currentMap = state.maps[currentMapId];
  const isForced = !!state.forcedView;

  const selectedToken = selectedTokenId ? state.tokens[selectedTokenId] : null;
  const selectedTokenEntity = selectedToken ? state.entities[selectedToken.entityId] : null;

  // v7.1 perf: memoize vision sources so they don't recompute on every
  // render (token drag, hover state change, etc.)
  const tod = state.timeOfDay || 0;
  const mapAlwaysDark = !!currentMap?.alwaysDark;
  const playerVisionSources = useMemo(
    () => {
      const t0 = performance.now();
      const res = computePlayerVisionSources(state, currentMapId, ownedEntityIds, tod, mapAlwaysDark);
      const elapsed = performance.now() - t0;
      if (elapsed > 16) console.log(`[plagues-call] vision recompute: ${elapsed.toFixed(0)}ms (${res.length} sources)`);
      return res;
    },
    [state.entities, state.tokens, currentMapId, ownedEntityIds, tod, mapAlwaysDark]
  );

  // Track cursor for hover tooltip
  useEffect(() => {
    const onMove = (e) => setCursorPos({ x: e.clientX, y: e.clientY });
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  const tokenMove = (tokenId, x, y) => {
    const token = state.tokens[tokenId];
    if (!token) {
      console.log(`[plagues-call] player tokenMove REJECT: no token ${tokenId.slice(-6)}`);
      return;
    }
    const entity = state.entities[token.entityId];
    if (!entity || !ownedEntityIds.has(entity.id)) {
      console.log(`[plagues-call] player tokenMove REJECT: not owned ${tokenId.slice(-6)} entity=${entity?.name} ownedIds=[${[...ownedEntityIds].map(id => id.slice(-6)).join(',')}]`);
      toast('You may only move your own characters', 'error');
      return;
    }
    console.log(`[plagues-call] player tokenMove OK token=${tokenId.slice(-6)} → (${x.toFixed(0)}, ${y.toFixed(0)})`);
    // v7.2 PERFORMANCE FIX: optimistic local dispatch. Update the
    // player's own token position immediately so their vision circle,
    // light radius, and all derived UI update without waiting for the
    // full DM round-trip (which was the 3–4 second lighting lag).
    // The DM remains authoritative — if for any reason the DM rejects
    // the move, the next state_update will correct it.
    dispatch({ type: 'TOKEN_MOVE_EPHEMERAL', tokenId, x, y, mapId: token.mapId });
    // Then send the authoritative action to the DM for persistence
    // + broadcast to all other peers.
    const sent = sync.sendPlayerAction({
      type: 'move_token',
      payload: { tokenId, x, y },
      peerId: myPeerId,
    });
    console.log(`[plagues-call] sendPlayerAction(move_token) returned ${sent} dmConn.open=${sync?.dmConnection?.open}`);
  };

  const tokenDoubleClick = (tokenId) => setSelectedTokenId(tokenId);

  // Player-action sender used by TokenDetailPanel/EditMySheet for own-entity writes
  const playerActionSender = useCallback((action) => {
    if (!sync) return;
    sync.sendPlayerAction({ ...action, peerId: myPeerId });
  }, [sync, myPeerId]);

  // Reminder helpers — reminders are stored per-peer, so we route
  // create/delete through the DM-authoritative action pipeline.
  const myReminders = state.reminders?.[myPeerId] || [];
  const reminderUpsert = (r) => {
    playerActionSender({ type: 'reminder_upsert', payload: { reminder: r } });
  };
  const reminderDelete = (id) => {
    playerActionSender({ type: 'reminder_delete', payload: { id } });
  };

  // v7.2: Claim button lock. Mobile devices were reporting duplicate
  // claims from double-taps, and with the slow round-trip that existed
  // in v7 it was easy to think the first tap "didn't register" and
  // tap again. The DM will accept only the first one anyway, but the
  // UI should lock out rapid repeat taps and give immediate feedback.
  const [claimLocked, setClaimLocked] = useState(false);
  const claimLockTimerRef = useRef(null);
  const withClaimLock = (fn) => {
    if (claimLocked) {
      toast('Claim in progress…', 'info');
      return;
    }
    setClaimLocked(true);
    fn();
    if (claimLockTimerRef.current) clearTimeout(claimLockTimerRef.current);
    // Unlock after 2s. If the DM accepts the claim, the state_update
    // will re-render and this button goes away anyway. The 2s window
    // is a safety release in case the network drops the request.
    claimLockTimerRef.current = setTimeout(() => setClaimLocked(false), 2000);
  };
  useEffect(() => () => {
    if (claimLockTimerRef.current) clearTimeout(claimLockTimerRef.current);
  }, []);

  const claimPC = (entityId) => withClaimLock(() => {
    const t0 = performance.now();
    sync.sendPlayerAction({
      type: 'claim_pc',
      payload: { entityId, playerName },
      peerId: myPeerId,
    });
    console.log(`[plagues-call] claim_pc sent for ${entityId.slice(-6)} (${(performance.now() - t0).toFixed(0)}ms)`);
    setShowClaim(false);
    toast('Requesting character…', 'success');
  });

  const claimFamiliar = (entityId) => withClaimLock(() => {
    sync.sendPlayerAction({
      type: 'claim_familiar',
      payload: { entityId, playerName },
      peerId: myPeerId,
    });
    toast('Requesting familiar…', 'success');
  });

  const unclaimFamiliar = (entityId) => {
    sync.sendPlayerAction({
      type: 'unclaim_familiar',
      payload: { entityId },
      peerId: myPeerId,
    });
  };

  const claimSpectator = () => withClaimLock(() => {
    sync.sendPlayerAction({
      type: 'claim_spectator',
      payload: { playerName },
      peerId: myPeerId,
    });
    setShowClaim(false);
  });

  const unclaimPC = () => {
    sync.sendPlayerAction({
      type: 'unclaim_pc',
      payload: {},
      peerId: myPeerId,
    });
  };

  // Already-claimed IDs across all peers (used to filter the claim modal list)
  const allClaimedPCIds = new Set(
    Object.values(state.claims || {}).map(c => c.pc).filter(Boolean)
  );
  const allClaimedFamiliarIds = new Set(
    Object.values(state.claims || {}).flatMap(c => c.familiars || [])
  );
  const unclaimedPCs = Object.values(state.entities).filter(e => {
    if (e.type !== 'PC') return false;
    return !allClaimedPCIds.has(e.id);
  });
  const availableFamiliars = Object.values(state.entities).filter(e => {
    if (e.type !== 'Familiar') return false;
    return !allClaimedFamiliarIds.has(e.id);
  });

  // Player-action sender already defined above at the top of this component.
  // (Previously there was a duplicate definition here — removed.)

  // Clicking a party card opens the detail panel for that PC's token
  // (only if it has one on the current map; otherwise focus the claimed PC).
  const selectPCById = (entityId) => {
    const tok = Object.values(state.tokens).find(t => t.entityId === entityId);
    if (tok) setSelectedTokenId(tok.id);
  };

  // ==========================================================
  // Forced onboarding: until the player has claimed a PC,
  // requested one, or chosen spectator mode, we render an
  // overlay gate so they can't interact with the map.
  // ==========================================================
  if (!hasMadeChoice && syncStatus === 'live') {
    return (
      <div className="app-shell">
        <div className="topbar">
          <span className="mode-badge player">⌂ Player</span>
          <span className="topbar-title">{APP_NAME}</span>
          <div className="topbar-spacer" />
          <div className="conn-status">
            <div className="conn-dot live" />
            <span className="mono">{roomCode}</span>
            <span style={{ color: 'var(--ink-dim)' }}>· {playerName}</span>
          </div>
          <button className="btn ghost" onClick={onLogout}>⎋ Leave</button>
        </div>
        <PlayerOnboardingGate
          state={state}
          myPeerId={myPeerId}
          playerName={playerName}
          playerActionSender={playerActionSender}
          onRequestNewPC={() => toast('Please ask your DM to create a character for you.', 'info', 5000)}
        />
      </div>
    );
  }

  const effectsEnabled = settings.sicknessEffects !== false;
  const sicknessWobbleClass = effectsEnabled && sicknessLevel >= 2 ? `sickness-wobble-${Math.min(sicknessLevel, 3)}` : '';

  return (
    <div className={`app-shell ${sicknessWobbleClass}`}>
      {effectsEnabled && sicknessLevel >= 3 && <div className="sickness-vignette" />}
      <div className="topbar">
        <span className="mode-badge player">⌂ Player</span>
        <span className="topbar-title">{APP_NAME}</span>
        <div className="topbar-divider" />
        {claimedEntity ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="entity-swatch" style={{ background: claimedEntity.color, width: 12, height: 12 }} />
            <span style={{ fontSize: 13, fontWeight: 500 }}>{claimedEntity.name}</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-dim)' }}>
              {claimedEntity.hp.current}/{claimedEntity.hp.max} HP
            </span>
            <button className="btn sm primary" onClick={() => setShowSheet(true)}>◈ Edit My Sheet</button>
            {/* v7.1: Give players a way to claim a familiar even after
                they've claimed a PC. This button was missing in v7, so
                familiars were only reachable from the initial claim
                modal — by the time a player had a PC, there was no UI
                entry point. Shown only when unclaimed familiars exist
                OR the player already has familiars (so they can manage). */}
            {(availableFamiliars.length > 0 || (myClaim.familiars || []).length > 0) && (
              <button className="btn sm" onClick={() => setShowClaim(true)}
                title="Claim or release a familiar">
                ✦ Familiar{(myClaim.familiars || []).length > 0 ? `s (${myClaim.familiars.length})` : ''}
              </button>
            )}
            <button className="btn sm ghost" onClick={unclaimPC}>Release</button>
          </div>
        ) : myClaim.spectator ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--ink-dim)' }}>👁 Spectator mode</span>
            <button className="btn sm" onClick={() => setShowClaim(true)}>⚐ Claim Character</button>
          </div>
        ) : (
          <button className="btn primary" onClick={() => setShowClaim(true)}>⚐ Claim Character</button>
        )}
        <div className="topbar-divider" />
        <button className={`btn ${showInit ? 'active' : ''}`} onClick={() => setShowInit(!showInit)}>⚔ Initiative</button>
        {/* v7 #6: Players get a stripped-down ToolsMenu — no DM-only
            block / hazard / soundboard items. */}
        <ToolsMenu
          isDM={false}
          measureMode={measureMode} setMeasureMode={setMeasureMode}
          showDraw={showDraw} setShowDraw={setShowDraw}
          showDice={showDice} setShowDice={setShowDice}
          placingReminder={placingReminder} setPlacingReminder={setPlacingReminder}
        />
        <div className="topbar-spacer" />
        <div className="conn-status">
          <div className={`conn-dot ${syncStatusClass(syncStatus)}`} />
          <span className="mono">{roomCode}</span>
          <span style={{ color: 'var(--ink-dim)' }}>· {playerName}</span>
        </div>
        <button className="btn ghost" title="Settings" onClick={onOpenSettings}>⚙</button>
        <button className="btn ghost" onClick={onLogout}>⎋ Leave</button>
      </div>

      <div className="main player-view">
        <PartySidebar
          state={state}
          claimedEntityId={claimedEntityId}
          ownedFamiliarIds={claimedFamiliarIds}
          currentMapId={currentMapId}
          onSelectPC={selectPCById}
        />

        <div className={`canvas-container sick-level-${sicknessLevel} tod-${Math.round((state.timeOfDay || 0) * 10)} ${claimedEntity && claimedEntity.hp.current <= 0 ? 'downed' : ''}`}>
          <MapCanvas
            map={currentMap}
            entities={state.entities}
            tokens={state.tokens}
            initiative={state.initiative}
            mode="player"
            peerId={myPeerId}
            claimedEntityId={claimedEntityId}
            ownedEntityIds={ownedEntityIds}
            onTokenMove={tokenMove}
            onTokenDoubleClick={tokenDoubleClick}
            onPlaceEntity={() => {}}
            onViewportChange={() => {}}
            selectedTokenId={selectedTokenId}
            mapScale={state.mapScale || 1}
            reminders={myReminders}
            onReminderUpsert={reminderUpsert}
            onReminderDelete={reminderDelete}
            placingReminder={placingReminder}
            onPlaceReminderDone={() => setPlacingReminder(false)}
            hoveredTokenId={hoveredToken?.tokenId}
            onTokenHoverChange={setHoveredToken}
            blockZones={state.blockZones?.[currentMapId] || []}
            visionEnabled={!!(currentMap?.alwaysDark) || (state.timeOfDay || 0) >= 0.5}
            visionSources={playerVisionSources}
            measureMode={measureMode}
            onMeasureModeDone={() => setMeasureMode(null)}
            drawings={state.drawings?.[currentMapId] || []}
            drawMode={drawMode}
            drawColor={drawColor}
            drawWidth={drawWidth}
            drawOwner={myPeerId}
            onDrawingUpsert={(d) => playerActionSender({ type: 'drawing_upsert', payload: { mapId: currentMapId, drawing: d } })}
            hazards={state.hazards?.[currentMapId] || []}
          />

          <TokenTooltip hovered={hoveredToken} entities={state.entities} mode="player" x={cursorPos.x} y={cursorPos.y} />

          <div className="canvas-overlay top-left">
            {currentMap && <Breadcrumb map={currentMap} maps={state.maps} onSwitch={() => {}} />}
          </div>

          {isForced && (
            <div className="canvas-overlay bottom-center">
              <div className="forced-view-banner">
                <span className="glyph">⚑</span>
                DM-controlled view · {currentMap?.name}
              </div>
            </div>
          )}

          {syncStatus !== 'live' && (
            <div className="canvas-overlay bottom-center">
              <div className="forced-view-banner">
                {syncStatus === 'connecting' ? 'Connecting to the table…' : syncStatus === 'error' ? 'Connection lost. Reopen the page to retry.' : 'Offline'}
              </div>
            </div>
          )}

          {showInit && <InitiativeTracker state={state} dispatch={() => {}} mode="player" onClose={() => setShowInit(false)} />}

          {showDraw && (
            <DrawingPanel
              state={state}
              onClose={() => setShowDraw(false)}
              drawMode={drawMode} setDrawMode={setDrawMode}
              drawColor={drawColor} setDrawColor={setDrawColor}
              drawWidth={drawWidth} setDrawWidth={setDrawWidth}
              onClearOwn={() => playerActionSender({ type: 'drawing_clear_owner', payload: { mapId: currentMapId } })}
              onClearAll={() => {}}
              isDM={false}
            />
          )}

          {showDice && (
            <DiceTray
              state={state}
              onClose={() => setShowDice(false)}
              myPeerId={myPeerId}
              myName={playerName}
              isDM={false}
              dispatch={() => {}}
              onRoll={(entry) => playerActionSender({ type: 'dice_roll', payload: { entry } })}
            />
          )}

          {selectedToken && selectedTokenEntity && (
            <TokenDetailPanel
              state={state}
              token={selectedToken}
              entity={selectedTokenEntity}
              mode="player"
              dispatch={() => {}}
              onClose={() => setSelectedTokenId(null)}
              claimedEntityId={claimedEntityId}
              playerActionSender={playerActionSender}
            />
          )}

          {showClaim && (
            <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowClaim(false)}>
              <div className="modal slide-up" style={{ maxWidth: 480 }}>
                <div className="float-panel-header">
                  <span>⚐ Claim</span>
                  <button className="close-x" onClick={() => setShowClaim(false)}>×</button>
                </div>
                <div className="float-panel-body">
                  {!claimedEntity && (
                    <>
                      <label>Characters</label>
                      {unclaimedPCs.length === 0 ? (
                        <div className="empty-state"><span className="glyph">⚔</span>No unclaimed characters.</div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                          {unclaimedPCs.map(e => (
                            <div key={e.id} className="claim-option"
                              onClick={() => claimPC(e.id)}>
                              <div className="pc-avatar" style={{ background: e.color, width: 36, height: 36 }}>
                                {e.imageUrl
                                  ? <img src={e.imageUrl} alt="" style={{width:'100%',height:'100%',objectFit:'cover',borderRadius:'50%'}} />
                                  : (e.name[0] || '?').toUpperCase()}
                              </div>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: 500 }}>{e.name}</div>
                                <div style={{ fontSize: 11, color: 'var(--ink-dim)' }}>
                                  Level {e.level} {e.class} · {e.hp.max} HP · AC {e.ac}
                                </div>
                              </div>
                              <button className="btn primary sm">Claim</button>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {availableFamiliars.length > 0 && (
                    <>
                      <label>Familiars <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— you may claim multiple</span></label>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {availableFamiliars.map(e => (
                          <div key={e.id} className="claim-option familiar"
                            onClick={() => claimFamiliar(e.id)}>
                            <div className="pc-avatar familiar-avatar" style={{ background: e.color, width: 32, height: 32 }}>
                              {(e.name[0] || '?').toUpperCase()}
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 500 }}>{e.name}</div>
                              <div style={{ fontSize: 11, color: 'var(--ink-dim)' }}>
                                Familiar {e.faction ? `· bonded to ${e.faction}` : ''}
                              </div>
                            </div>
                            <button className="btn sm">Claim</button>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {claimedFamiliarIds.length > 0 && (
                    <>
                      <label style={{ marginTop: 14 }}>Your familiars</label>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {claimedFamiliarIds.map(fid => {
                          const f = state.entities[fid];
                          if (!f) return null;
                          return (
                            <div key={fid} className="claim-option" style={{ cursor: 'default' }}>
                              <div className="pc-avatar familiar-avatar" style={{ background: f.color, width: 28, height: 28 }}>
                                {(f.name[0] || '?').toUpperCase()}
                              </div>
                              <span style={{ flex: 1, fontSize: 13 }}>{f.name}</span>
                              <button className="btn sm ghost" onClick={() => unclaimFamiliar(fid)}>Release</button>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {showSheet && (
            <EditMySheetModal
              state={state}
              myPeerId={myPeerId}
              claim={myClaim}
              playerActionSender={playerActionSender}
              onClose={() => setShowSheet(false)}
            />
          )}
        </div>

        <RevealedMonstersSidebar state={state} currentMapId={currentMapId} />
      </div>

      {showSettings && (
        <SettingsModal
          settings={settings}
          onChange={onSettingsChange}
          onClose={onCloseSettings}
          mode="player"
        />
      )}
    </div>
  );
}

// ====================================================================
// ROOT APP
// ====================================================================
function Root() {
  const [auth, setAuth] = useState(() => {
    // Try the v2 key first, then fall back to the legacy shadowquill key
    let loaded = null;
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      if (raw) loaded = JSON.parse(raw);
    } catch {}
    if (!loaded) {
      try {
        const legacy = localStorage.getItem(LEGACY_AUTH_KEY);
        if (legacy) loaded = JSON.parse(legacy);
      } catch {}
    }
    // v4 fix #7: backfill playerId for pre-v4 saves so refresh restores claim
    if (loaded && loaded.mode === 'player' && !loaded.playerId) {
      loaded.playerId = getOrCreatePlayerId();
      try { localStorage.setItem(AUTH_KEY, JSON.stringify(loaded)); } catch {}
    }
    return loaded;
  });

  // v2: global settings (theme + whatever else lands here later).
  // Stored outside game state so they're per-device, not per-session.
  const [settings, setSettings] = useState(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {}
    return { ...DEFAULT_SETTINGS };
  });

  // Apply + persist theme whenever it changes. Uses `data-theme` on the root
  // element so CSS can toggle variable blocks without a full reload.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme || 'dark');
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  }, [settings]);

  const updateSettings = (patch) => setSettings(s => ({ ...s, ...patch }));

  const [showSettings, setShowSettings] = useState(false);

  if (!auth) {
    return (
      <AuthScreen onAuth={(a) => {
        setAuth(a);
        try { localStorage.setItem(AUTH_KEY, JSON.stringify(a)); } catch {}
      }} />
    );
  }

  const logout = () => {
    try { localStorage.removeItem(AUTH_KEY); } catch {}
    try { localStorage.removeItem(LEGACY_AUTH_KEY); } catch {}
    setAuth(null);
  };

  return (
    <Session
      auth={auth}
      onLogout={logout}
      settings={settings}
      onSettingsChange={updateSettings}
      showSettings={showSettings}
      onOpenSettings={() => setShowSettings(true)}
      onCloseSettings={() => setShowSettings(false)}
    />
  );
}

// ====================================================================
// PLAYER ACTION VALIDATION HELPERS (module-level — pure, no closures)
// ====================================================================

// Returns the set of entity IDs a peer owns: their claimed PC, explicitly
// claimed familiars, and any familiars bonded by peerId or by PC.
function ownedByPeer(s, pid) {
  const c = s.claims?.[pid];
  const out = new Set();
  if (c) {
    for (const id of (c.familiars || [])) out.add(id);
    if (c.pc) out.add(c.pc);
  }
  for (const [, ent] of Object.entries(s.entities)) {
    if (!ent || ent.type !== 'Familiar') continue;
    if (ent.bondedPeerId === pid) out.add(ent.id);
    if (c && ent.bondedPcId && ent.bondedPcId === c.pc) out.add(ent.id);
  }
  return out;
}

// Fields a player may write on their own entity. DM-only fields are never
// writable by players regardless of claim (deathSaves, sickness, type, etc.).
const PLAYER_FIELD_WHITELIST = new Set([
  'name', 'color', 'ac', 'speed', 'initBonus', 'passivePerception',
  'class', 'level', 'playerName', 'notes', 'playerDescription',
  'imageUrl', 'faction', 'role', 'darkvision', 'lightRadius',
]);
const PLAYER_HP_WHITELIST    = new Set(['current', 'max']);
const PLAYER_STATS_WHITELIST = new Set(['str', 'dex', 'con', 'int', 'wis', 'cha']);

function Session({ auth, onLogout, settings, onSettingsChange, showSettings, onOpenSettings, onCloseSettings }) {
  const toast = useToast();
  // v7 #1: IDB-backed initial state. The reducer initializer can't be
  // async, so we start with default state and hydrate asynchronously
  // from IDB in a useEffect. The DM session shows a brief loading toast
  // while IDB streams in. Migrating from v6 localStorage happens once
  // here too — old blobs get split, written to IDB, and removed from
  // localStorage to free up the quota.
  const [state, dispatch] = useReducer(reducer, null, () => makeDefaultState());
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (auth.mode !== 'dm') { setHydrated(true); return; }
    let cancelled = false;
    (async () => {
      try {
        // One-time migration from v6 localStorage blob → IDB
        const mig = await migrateLocalStorageToIDB();
        if (mig.migrated) {
          console.log(`[plagues-call] migrated ${mig.bytes} bytes from ${mig.source} to IndexedDB`);
        }
        const loaded = await loadSessionFromIDB();
        if (cancelled) return;
        if (loaded) {
          const migrated = migrateState(loaded);
          const tokenCount = Object.keys(migrated.tokens || {}).length;
          const mapCount = Object.keys(migrated.maps || {}).length;
          console.log(`[plagues-call] loaded from IDB: ${tokenCount} tokens, ${mapCount} maps`);
          dispatch({ type: 'HYDRATE', state: migrated });
        } else {
          // No IDB data — try one more legacy fallback before giving up
          let raw = null;
          try { raw = localStorage.getItem(LEGACY_STORAGE_KEY); } catch {}
          if (raw) {
            try {
              const parsed = JSON.parse(raw);
              const migrated = migrateState(parsed);
              dispatch({ type: 'HYDRATE', state: migrated });
              console.log(`[plagues-call] loaded from legacy localStorage`);
              // Persist into IDB right away so future loads use it
              persistSessionToIDB(migrated).catch(e =>
                console.warn('[plagues-call] initial IDB write failed:', e?.message));
            } catch (e) {
              console.warn('[plagues-call] legacy parse failed:', e?.message);
            }
          } else {
            console.log('[plagues-call] no saved state found — starting fresh');
          }
        }
      } catch (err) {
        console.error('[plagues-call] hydrate failed:', err?.message || err);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, [auth.mode]);

  const [syncStatus, setSyncStatus] = useState('offline');
  const [peerList, setPeerList] = useState([]);
  const [myPeerId, setMyPeerId] = useState(null);
  const syncRef = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // v7.2: Player-side IDB hydration for map images. When a state_update
  // arrives with a sentinel imageUrl for a map we've seen before, try
  // loading the image from our local IDB cache. Avoids waiting for the
  // DM to re-push bytes we already have. Keeps a loaded-set in a ref
  // so we only try each mapId once per session.
  const idbHydratedMapsRef = useRef(new Set());
  useEffect(() => {
    if (auth.mode !== 'player') return;
    const maps = state.maps || {};
    for (const [id, m] of Object.entries(maps)) {
      if (idbHydratedMapsRef.current.has(id)) continue;
      if (m?.imageUrl !== IMG_SENTINEL) continue;
      idbHydratedMapsRef.current.add(id);
      (async () => {
        try {
          const cached = await idbGet(IDB_STORES.mapImages, id);
          if (cached && typeof cached === 'string' && cached.startsWith('data:')) {
            dispatch({ type: 'MAP_IMAGE_RECEIVED', mapId: id, dataUrl: cached });
            console.log(`[plagues-call] hydrated map_image ${id.slice(-6)} from IDB cache`);
          }
        } catch (err) {
          // Cache miss is normal on first join — DM will push bytes.
        }
      })();
    }
  }, [state.maps, auth.mode]);

  // v7 fix #1: BULLETPROOF persistence via IndexedDB.
  // The v6 strategy (write everything to localStorage) ran into the 5MB
  // localStorage quota — once map images accumulated, every save threw
  // QuotaExceededError and silently lost state. v7:
  //   - State JSON (without map images) goes to IDB store 'session'/main
  //   - Each map image is stored separately in IDB store 'mapImages'
  //   - Write debounce remains (250ms) but writes are async + transactional
  //   - Critical actions still trigger an immediate write
  //   - On quota or write failure: explicit toast + console.error, no silent loss
  //   - Save log shows JSON bytes + map image count
  //
  // We hold a pending-save ref so multiple in-flight writes coalesce;
  // newer writes supersede older ones if they overlap.
  const persistInFlightRef = useRef(false);
  const persistQueuedRef = useRef(false);
  const persistNow = useCallback((reason = 'routine') => {
    if (auth.mode !== 'dm') return;
    if (!hydrated) return; // don't overwrite IDB before initial load
    // Coalesce: if a save is already running, mark a follow-up save and
    // let the in-flight one schedule it.
    if (persistInFlightRef.current) {
      persistQueuedRef.current = true;
      return;
    }
    persistInFlightRef.current = true;
    const snapshot = stateRef.current;
    const t0 = performance.now();
    persistSessionToIDB(snapshot)
      .then(({ jsonBytes, imageCount }) => {
        const tokens = Object.keys(snapshot.tokens || {}).length;
        const elapsed = performance.now() - t0;
        console.log(`[plagues-call] saved (${reason}): ${jsonBytes} JSON bytes, ${tokens} tokens, ${imageCount} map images, ${elapsed.toFixed(0)}ms`);
      })
      .catch(err => {
        console.error('[plagues-call] SAVE FAILED', err?.name, err?.message);
        if (err?.name === 'QuotaExceededError') {
          toast('Storage quota exceeded — export and prune old maps', 'error');
        } else {
          toast('Save failed — see console', 'error');
        }
      })
      .finally(() => {
        persistInFlightRef.current = false;
        if (persistQueuedRef.current) {
          persistQueuedRef.current = false;
          // Trampoline the queued save with a microtask delay so we don't
          // recurse a giant stack during fast edits.
          setTimeout(() => persistNow('coalesced'), 0);
        }
      });
  }, [auth.mode, toast, hydrated]);

  // v7.1 PERFORMANCE FIX: the v7 persist strategy fired an IDB write
  // on EVERY state change whose signature differed — including every
  // pointermove during a token drag (TOKEN_MOVE dispatches at ~60fps).
  // That caused JSON.stringify + IDB write per frame, producing visible
  // stutter on both the DM canvas and the dragged token.
  //
  // New strategy: ALL state changes debounce through a single 800ms
  // timer. The "critical" immediate-write path is kept only for the
  // true invariants (token count / entity count / current map), not
  // for every movement. Writes coalesce naturally; if you drag a
  // token for 3 seconds, that's ONE IDB write at the end, not 180.
  // The beforeunload + pagehide flush guarantees nothing is lost on
  // page close.
  const lastSigRef = useRef('');
  const persistTimerRef = useRef(null);
  useEffect(() => {
    if (auth.mode !== 'dm') return;
    if (!hydrated) return;
    const s = state;
    // Structural signature ignores positions — only counts + current map.
    // A change here means a token was added/removed/claimed/etc.
    // Movement is handled by the debounce alone.
    const structSig = [
      Object.keys(s.tokens || {}).length,
      Object.keys(s.entities || {}).length,
      Object.keys(s.maps || {}).length,
      s.currentMapId,
    ].join('::');
    if (structSig !== lastSigRef.current) {
      lastSigRef.current = structSig;
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistNow('critical');
      return;
    }
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      persistNow('debounced');
    }, 800);
    return () => {
      // Intentionally do NOT clear the timer on unmount — we want the
      // pending write to land. beforeunload catches the close path.
    };
  }, [state, auth.mode, persistNow, hydrated]);

  // Flush on unload (survives across tab-close)
  useEffect(() => {
    if (auth.mode !== 'dm') return;
    const flush = () => persistNow('unload');
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, [auth.mode, persistNow]);

  // Setup sync
  useEffect(() => {
    if (auth.local) return;
    if (!auth.roomCode) return;

    const sync = new SyncManager({
      mode: auth.mode,
      onStateUpdate: (newState) => {
        if (auth.mode === 'player') {
          // v7.5: log arrival of a state_update so we can trace whether
          // the DM's broadcast reaches players. Includes a short token
          // summary to help spot whether the moved token's position
          // propagated back.
          const tokCount = Object.keys(newState?.tokens || {}).length;
          console.log(`[plagues-call] player ← state_update ${tokCount} tokens`);
          dispatch({ type: 'REPLACE', payload: newState });
        }
      },
      onPlayerAction: (action, peerId) => {
        handlePlayerAction(action, peerId);
      },
      // v4: When a player reconnects, migrate their claim from their old
      // peer id to the new one, keyed on their stable playerId.
      onPlayerHello: (hello, newPeerId) => {
        if (!hello?.playerId) return;
        const curr = stateRef.current;
        // Find any existing peer key whose "playerId" marker matches
        const claims = curr.claims || {};
        let fromPeerId = null;
        for (const [pid, c] of Object.entries(claims)) {
          if (c && c.playerId === hello.playerId && pid !== newPeerId) {
            fromPeerId = pid;
            break;
          }
        }
        dispatch({ type: 'CLAIM_MIGRATE',
          fromPeerId, toPeerId: newPeerId,
          playerName: hello.playerName || '',
          playerId: hello.playerId,
        });
        if (fromPeerId) {
          toast(`${hello.playerName || 'Player'} reconnected — claim restored`, 'success');
        }
      },
      onStatusChange: setSyncStatus,
      onPeerListChange: setPeerList,
      onPeerId: setMyPeerId,
      onError: (msg) => toast(msg, 'error'),
      // v7.2: map image bytes arrive separately. Cache in IDB and
      // merge into state so the map layer renders.
      onMapImage: (mapId, dataUrl) => {
        if (auth.mode !== 'player') return;
        if (!mapId || !dataUrl) return;
        const t0 = performance.now();
        idbSet(IDB_STORES.mapImages, mapId, dataUrl).catch(err => {
          console.warn('[plagues-call] cache map image failed:', err);
        });
        dispatch({ type: 'MAP_IMAGE_RECEIVED', mapId, dataUrl });
        const elapsed = performance.now() - t0;
        console.log(`[plagues-call] received map_image ${mapId.slice(-6)} in ${elapsed.toFixed(0)}ms`);
      },
      // v7.2: ephemeral token-position updates. Apply locally without
      // waiting for the next full state_update; gives sub-frame
      // responsiveness for remote viewers watching a token move.
      onTokenPos: (tokenId, x, y, mapId) => {
        if (auth.mode !== 'player') return;
        console.log(`[plagues-call] player got token_pos token=${tokenId.slice(-6)} → (${x.toFixed(0)}, ${y.toFixed(0)})`);
        dispatch({ type: 'TOKEN_MOVE_EPHEMERAL', tokenId, x, y, mapId });
      },
      onSoundData: (soundId, name, dataUrl) => {
        if (!soundId || !dataUrl) return;
        // Populate the in-memory cache immediately so useSoundPlayback can
        // find the bytes synchronously on the next render, without waiting
        // for the IDB write to commit (which would lose the race).
        _soundDataCache.set(soundId, dataUrl);
        idbSet(IDB_STORES.sounds, soundId, { id: soundId, name, dataUrl, ts: Date.now() })
          .catch(err => console.warn('[plagues-call] cache sound failed:', err));
      },
    });

    syncRef.current = sync;

    const joinT0 = performance.now();
    if (auth.mode === 'dm') {
      sync.hostSession(auth.roomCode);
      console.log(`[plagues-call] DM hosting room ${auth.roomCode}`);
    } else {
      // Wrap onStateUpdate to log when the first state arrives (claim modal ready).
      const priorHandler = sync.onStateUpdate;
      let fired = false;
      sync.onStateUpdate = (payload) => {
        if (!fired) {
          fired = true;
          console.log(`[plagues-call] claim modal ready in ${(performance.now() - joinT0).toFixed(0)}ms`);
        }
        priorHandler?.(payload);
      };
      sync.joinSession(auth.roomCode, auth.playerId, auth.playerName);
      console.log(`[plagues-call] player joining room ${auth.roomCode}`);
    }

    return () => { sync.destroy(); };
  }, [auth.roomCode, auth.mode, auth.local]);

  // v7.1 PERFORMANCE FIX: DM broadcasts state changes to peers. The
  // v7 debounce was 30ms — still fires several times per 100ms during
  // a token drag, and each broadcast serializes the entire filtered
  // state (typically 50–200 KB with drawings/hazards). On lower-end
  // devices this caused visible input stutter.
  //
  // New: 120ms debounce. At worst ~8 broadcasts per second of dragging.
  // Each broadcast is still perfectly current because the useEffect
  // re-runs on every state change and only the last scheduled timer
  // actually fires (previous ones get cleared).
  useEffect(() => {
    if (auth.mode !== 'dm' || !syncRef.current || syncStatus !== 'live') return;
    const handle = setTimeout(() => {
      peerList.forEach(pid => {
        const conn = syncRef.current.connections.get(pid);
        if (conn?.open) {
          try {
            conn.send({
              type: 'state_update',
              // v7.2: strip heavy assets (map image bytes, sound bytes)
              // before wire transmit. These travel through separate
              // map_image / sound_data envelopes on demand.
              payload: stripHeavyAssetsForWire(filterStateForPlayer(stateRef.current, pid))
            });
          } catch {}
        }
      });
    }, 120);
    return () => clearTimeout(handle);
  }, [state, peerList, syncStatus, auth.mode]);

  // v7.2 PERFORMANCE FIX: initial-state push to new peers. Previously
  // this sent the WHOLE state inline including megabytes of map image
  // dataUrls — producing the 10-second join lag. Now we:
  //   1. Send a lean state_update immediately (kilobytes, arrives fast)
  //      so the claim modal can render right away
  //   2. Send the current map's image bytes in a separate map_image
  //      envelope moments later (player caches in IDB so reconnects
  //      don't re-transmit)
  //   3. Trickle other map images over the next few seconds with
  //      setTimeout so we don't block the main thread on mobile
  const sentMapImagesRef = useRef({}); // peerId → Set of mapIds already sent
  const sentSoundsRef = useRef(new Set()); // peerIds that have received full sound library
  useEffect(() => {
    if (auth.mode !== 'dm' || !syncRef.current) return;
    const newPeers = peerList.filter(pid => !sentMapImagesRef.current[pid]);
    for (const pid of newPeers) {
      sentMapImagesRef.current[pid] = new Set();
    }
    const sync = syncRef.current;
    peerList.forEach(pid => {
      const conn = sync.connections.get(pid);
      if (!conn?.open) return;
      try {
        const t0 = performance.now();
        const filtered = filterStateForPlayer(stateRef.current, pid);
        const lean = stripHeavyAssetsForWire(filtered);
        conn.send({ type: 'state_update', payload: lean });
        const elapsed = performance.now() - t0;
        if (elapsed > 50) console.log(`[plagues-call] lean state_update to ${pid.slice(-6)}: ${elapsed.toFixed(0)}ms`);
      } catch (err) {
        console.warn('[plagues-call] initial state push failed:', err);
      }
      // Send all known sounds to this peer if we haven't already.
      // This covers sounds played in previous sessions that are already in
      // state.soundEvents when the player joins — they have no inline dataUrl
      // and no IDB entry, so we push the bytes from the DM's IDB proactively.
      if (!sentSoundsRef.current.has(pid)) {
        sentSoundsRef.current.add(pid);
        idbAllEntries(IDB_STORES.sounds).then(entries => {
          const c = sync.connections.get(pid);
          if (!c?.open) return;
          for (const [soundId, rec] of Object.entries(entries)) {
            if (!rec?.dataUrl) continue;
            try { c.send({ type: 'sound_data', soundId, name: rec.name, dataUrl: rec.dataUrl }); } catch {}
          }
        }).catch(() => {});
      }
    });
  }, [peerList, auth.mode]);

  // v7.2: push map image bytes to peers for maps they haven't cached.
  // Runs when the current map changes OR when a new peer joins. The
  // actual byte push is deferred via setTimeout so it doesn't block
  // the claim modal from rendering.
  useEffect(() => {
    if (auth.mode !== 'dm' || !syncRef.current) return;
    const s = stateRef.current;
    const currentMapId = s.currentMapId;
    if (!currentMapId) return;
    const currentMap = s.maps?.[currentMapId];
    if (!currentMap?.imageUrl || !currentMap.imageUrl.startsWith('data:')) return;

    const sync = syncRef.current;
    // For each peer, send the current map's image if we haven't already
    // sent it to that peer in this session.
    const timers = [];
    peerList.forEach((pid, idx) => {
      const sentSet = sentMapImagesRef.current[pid] || (sentMapImagesRef.current[pid] = new Set());
      if (sentSet.has(currentMapId)) return;
      // Stagger so multiple peers don't serialize simultaneously
      const t = setTimeout(() => {
        const conn = sync.connections.get(pid);
        if (!conn?.open) return;
        try {
          conn.send({
            type: 'map_image',
            mapId: currentMapId,
            dataUrl: currentMap.imageUrl,
          });
          sentSet.add(currentMapId);
          console.log(`[plagues-call] map_image ${currentMapId.slice(-6)} → ${pid.slice(-6)}`);
        } catch (err) {
          console.warn('[plagues-call] map_image send failed:', err);
        }
      }, 50 + idx * 150);
      timers.push(t);
    });
    return () => timers.forEach(t => clearTimeout(t));
  }, [peerList, state.currentMapId, state.maps, auth.mode]);

  // Handle player actions (DM side). All writes go through here so the DM
  // can validate ownership before dispatching. Players never mutate state
  // directly — they always send an intent message.
  const handlePlayerAction = useCallback((action, peerId) => {
    const curr = stateRef.current;

    switch (action.type) {
      case 'claim_pc': {
        const { entityId, playerName } = action.payload;
        const entity = curr.entities[entityId];
        if (!entity || entity.type !== 'PC') return;
        // v7.2: idempotency. If this peer already has this PC claimed,
        // ignore the duplicate — mobile double-taps otherwise trigger
        // two full state-sync rounds per claim.
        const existing = curr.claims?.[peerId];
        if (existing && existing.pc === entityId) {
          console.log(`[plagues-call] claim_pc ignored (already claimed by same peer) ${entityId.slice(-6)}`);
          return;
        }
        const takenBySomeoneElse = Object.entries(curr.claims || {})
          .some(([k, c]) => c.pc === entityId && k !== peerId);
        if (takenBySomeoneElse) return;
        const t0 = performance.now();
        dispatch({ type: 'CLAIM_PC', peerId, entityId, playerName });
        toast(`${entity.name} claimed by ${playerName || 'a player'}`, 'success');
        console.log(`[plagues-call] claim_pc ${entityId.slice(-6)} dispatched in ${(performance.now() - t0).toFixed(0)}ms`);
        break;
      }
      case 'unclaim_pc':
        dispatch({ type: 'UNCLAIM_PC', peerId });
        break;
      case 'claim_familiar': {
        const { entityId, playerName } = action.payload;
        const entity = curr.entities[entityId];
        if (!entity || entity.type !== 'Familiar') return;
        // v7.2: idempotency for duplicate taps.
        const existing = curr.claims?.[peerId];
        if (existing && (existing.familiars || []).includes(entityId)) return;
        const takenBySomeoneElse = Object.entries(curr.claims || {})
          .some(([k, c]) => (c.familiars || []).includes(entityId) && k !== peerId);
        if (takenBySomeoneElse) return;
        dispatch({ type: 'CLAIM_FAMILIAR', peerId, entityId });
        if (playerName) dispatch({ type: 'SET_PLAYER_NAME', peerId, playerName });
        break;
      }
      case 'unclaim_familiar':
        dispatch({ type: 'UNCLAIM_FAMILIAR', peerId, entityId: action.payload.entityId });
        break;
      case 'claim_spectator':
        dispatch({ type: 'CLAIM_SPECTATOR', peerId, playerName: action.payload.playerName });
        break;
      case 'move_token': {
        const { tokenId, x, y } = action.payload;
        const token = curr.tokens[tokenId];
        if (!token) {
          console.log(`[plagues-call] DM move_token REJECT: no token ${tokenId?.slice(-6)} from peer=${peerId?.slice(-6)}`);
          return;
        }
        const entity = curr.entities[token.entityId];
        if (!entity) {
          console.log(`[plagues-call] DM move_token REJECT: no entity for token ${tokenId.slice(-6)}`);
          return;
        }
        const owned = ownedByPeer(curr, peerId);
        if (!owned.has(entity.id)) {
          console.log(`[plagues-call] DM move_token REJECT: peer ${peerId.slice(-6)} doesn't own ${entity.name} (${entity.id.slice(-6)}). owned=[${[...owned].map(id => id.slice(-6)).join(',')}] claim=${JSON.stringify(curr.claims?.[peerId])}`);
          return;
        }
        console.log(`[plagues-call] DM move_token OK peer=${peerId.slice(-6)} token=${tokenId.slice(-6)} → (${x.toFixed(0)}, ${y.toFixed(0)})`);
        dispatch({ type: 'TOKEN_MOVE', id: tokenId, x, y });
        // v7.2: broadcast ephemeral token_pos to all OTHER peers so
        // remote viewers see the movement immediately (not waiting for
        // the 120ms state_update debounce). The originating peer has
        // already applied the move optimistically.
        const sync = syncRef.current;
        if (sync?.connections) {
          let sentCount = 0;
          for (const [pid, conn] of sync.connections) {
            if (pid === peerId) continue;
            if (!conn?.open) continue;
            try {
              conn.send({ type: 'token_pos', tokenId, x, y, mapId: token.mapId });
              sentCount++;
            } catch (err) {
              console.log(`[plagues-call] DM token_pos send failed to peer=${pid.slice(-6)}: ${err?.message}`);
            }
          }
          console.log(`[plagues-call] DM token_pos broadcast to ${sentCount} peer(s)`);
        }
        break;
      }
      case 'patch_own_entity': {
        // v3: expanded whitelist — players may edit the full stat block on
        // their own entities, but certain DM-only fields are never writable.
        const { entityId, op } = action.payload || {};
        const targetId = entityId || curr.claims?.[peerId]?.pc;
        if (!targetId) return;
        if (!ownedByPeer(curr, peerId).has(targetId)) return;
        const entity = curr.entities[targetId];
        if (!entity) return;
        if (op === 'hp_adjust') {
          const delta = Number(action.payload.delta) || 0;
          dispatch({ type: 'ENTITY_HP_ADJUST', id: targetId, delta: clamp(delta, -1000, 1000) });
        } else if (op === 'toggle_condition') {
          const condition = String(action.payload.condition || '');
          if (!CONDITIONS.includes(condition)) return;
          dispatch({ type: 'ENTITY_TOGGLE_CONDITION', id: targetId, condition });
        } else if (op === 'field_set') {
          // Apply a patch of allowed fields. Drop anything outside the whitelist.
          const raw = action.payload.patch || {};
          const patch = {};
          for (const [k, v] of Object.entries(raw)) {
            if (PLAYER_FIELD_WHITELIST.has(k)) patch[k] = v;
          }
          // v4 #9: clamp vision numeric fields so a bad client can't DoS the
          // vision overlay with absurd radii.
          if ('darkvision' in patch)  patch.darkvision  = clamp(Number(patch.darkvision)  || 0, 0, 600);
          if ('lightRadius' in patch) patch.lightRadius = clamp(Number(patch.lightRadius) || 0, 0, 600);
          if (raw.hp && typeof raw.hp === 'object') {
            const hp = {};
            for (const [k, v] of Object.entries(raw.hp)) {
              if (PLAYER_HP_WHITELIST.has(k)) hp[k] = clamp(Number(v) || 0, 0, 10000);
            }
            if (Object.keys(hp).length) patch.hp = hp;
          }
          if (raw.stats && typeof raw.stats === 'object') {
            const stats = {};
            for (const [k, v] of Object.entries(raw.stats)) {
              if (PLAYER_STATS_WHITELIST.has(k)) stats[k] = clamp(Number(v) || 0, 1, 30);
            }
            if (Object.keys(stats).length) patch.stats = stats;
          }
          if (raw.conditions && Array.isArray(raw.conditions)) {
            patch.conditions = raw.conditions.filter(c => CONDITIONS.includes(c));
          }
          // Sanitize image data URL — must start with data:image/
          if (typeof patch.imageUrl === 'string' && !patch.imageUrl.startsWith('data:image/') && patch.imageUrl !== '') {
            delete patch.imageUrl;
          }
          if (Object.keys(patch).length) {
            dispatch({ type: 'ENTITY_PATCH', id: targetId, patch });
          }
        }
        break;
      }
      case 'reminder_upsert': {
        // Player's own reminder on their own track. Defensive sanitize.
        const r = action.payload?.reminder;
        if (!r || typeof r !== 'object') return;
        const safe = {
          id: String(r.id || uid('rem_')),
          mapId: r.mapId ? String(r.mapId) : null,
          x: Number(r.x) || 0,
          y: Number(r.y) || 0,
          label: String(r.label || '').slice(0, 200),
          color: typeof r.color === 'string' ? r.color.slice(0, 20) : '#c9a34a',
        };
        dispatch({ type: 'REMINDER_UPSERT', peerId, reminder: safe });
        break;
      }
      case 'reminder_delete': {
        dispatch({ type: 'REMINDER_DELETE', peerId, id: String(action.payload?.id || '') });
        break;
      }
      // v6 #10: Player drawings flow through DM authority. Validate +
      // sanitize shape + stamp owner as the originating peerId so the
      // DM can track who drew what, and so 'drawing_clear_owner' can
      // wipe just that player's drawings.
      case 'drawing_upsert': {
        const { mapId, drawing } = action.payload || {};
        if (!mapId || !drawing?.type) return;
        if (!curr.maps?.[mapId]) return;
        const allowedTypes = new Set(['free', 'line', 'circle']);
        if (!allowedTypes.has(drawing.type)) return;
        const color = typeof drawing.color === 'string' ? drawing.color.slice(0, 30) : '#c9a34a';
        const width = clamp(Number(drawing.width) || 3, 1, 16);
        let safe;
        if (drawing.type === 'free') {
          const pts = Array.isArray(drawing.points) ? drawing.points : [];
          if (pts.length < 2) return;
          // Cap the number of points so a malicious client can't submit millions
          const clippedPts = pts.slice(0, 500).map(p => [Number(p[0]) || 0, Number(p[1]) || 0]);
          safe = { id: uid('draw_'), type: 'free', points: clippedPts, color, width, owner: peerId };
        } else if (drawing.type === 'line') {
          safe = {
            id: uid('draw_'), type: 'line',
            x0: Number(drawing.x0) || 0, y0: Number(drawing.y0) || 0,
            x1: Number(drawing.x1) || 0, y1: Number(drawing.y1) || 0,
            color, width, owner: peerId,
          };
        } else if (drawing.type === 'circle') {
          safe = {
            id: uid('draw_'), type: 'circle',
            cx: Number(drawing.cx) || 0, cy: Number(drawing.cy) || 0,
            r: clamp(Number(drawing.r) || 0, 0, 5000),
            color, width, owner: peerId,
          };
        }
        if (safe) dispatch({ type: 'DRAWING_UPSERT', mapId, drawing: safe });
        break;
      }
      case 'drawing_clear_owner': {
        const mapId = action.payload?.mapId;
        if (!mapId || !curr.maps?.[mapId]) return;
        dispatch({ type: 'DRAWING_CLEAR_OWNER', mapId, owner: peerId });
        break;
      }
      // v7 #9 / v7.2: Player dice roll. Stamp peerId server-side so a
      // client can't pretend to be someone else; clamp dice quantities
      // and result ranges so a malicious client can't inject a fake
      // crit. Accepts both v7.2 `groups` shape AND legacy flat `dice`
      // array for backward compat with older clients.
      case 'dice_roll': {
        const e = action.payload?.entry;
        if (!e) return;
        const allowedSides = new Set([4, 6, 8, 10, 12, 20]);
        let groups = [];
        let total = 0;
        let totalDice = 0;
        if (Array.isArray(e.groups)) {
          // v7.2 shape
          for (const g of e.groups) {
            if (!allowedSides.has(g?.die)) continue;
            if (!Array.isArray(g.results)) continue;
            const sanitized = g.results
              .slice(0, 100)
              .map(r => clamp(r | 0, 1, g.die | 0));
            if (sanitized.length === 0) continue;
            if (totalDice + sanitized.length > 200) break;
            groups.push({ die: g.die | 0, results: sanitized });
            total += sanitized.reduce((s, r) => s + r, 0);
            totalDice += sanitized.length;
          }
        } else if (Array.isArray(e.dice)) {
          // Legacy shape — convert into a single group
          const dice = e.dice.slice(0, 100).filter(d => allowedSides.has(d.die));
          if (dice.length > 0) {
            const sides = dice[0].die | 0;
            const results = dice.map(d => clamp(d.result | 0, 1, sides));
            groups = [{ die: sides, results }];
            total = results.reduce((s, r) => s + r, 0);
            totalDice = results.length;
          }
        }
        if (groups.length === 0) return;
        const peerName = typeof e.peerName === 'string' ? e.peerName.slice(0, 40) : 'Player';
        const expression = groups.map(g => `${g.results.length}d${g.die}`).join(' + ');
        const entry = {
          id: uid('roll_'),
          ts: Date.now(),
          peerId,
          peerName,
          groups,
          total,
          expression,
        };
        console.log(`[plagues-call] dice_roll ${peerName}: ${expression} = ${total}`);
        dispatch({ type: 'DICE_ROLL', entry });
        break;
      }
      // v7 #10: Player-side sound triggers are not allowed; only the DM
      // can play sounds. We stub a case so player attempts are ignored
      // explicitly rather than falling through to no-op.
      case 'sound_play':
      case 'sound_stop':
        return;
    }
  }, [toast]);

  if (auth.mode === 'dm') {
    return (
      <DMInterface
        state={state}
        dispatch={dispatch}
        sync={syncRef.current}
        syncStatus={auth.local ? 'local' : syncStatus}
        peerCount={peerList.length}
        onLogout={onLogout}
        roomCode={auth.local ? null : auth.roomCode}
        toast={toast}
        settings={settings}
        onSettingsChange={onSettingsChange}
        onOpenSettings={onOpenSettings}
        showSettings={showSettings}
        onCloseSettings={onCloseSettings}
      />
    );
  }

  return (
    <PlayerInterface
      state={state}
      dispatch={dispatch}
      myPeerId={myPeerId}
      playerName={auth.playerName}
      sync={syncRef.current}
      syncStatus={syncStatus}
      onLogout={onLogout}
      roomCode={auth.roomCode}
      toast={toast}
      settings={settings}
      onSettingsChange={onSettingsChange}
      onOpenSettings={onOpenSettings}
      showSettings={showSettings}
      onCloseSettings={onCloseSettings}
    />
  );
}

// ====================================================================
// MOUNT
// ====================================================================
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <ToastProvider>
    <Root />
  </ToastProvider>
);
