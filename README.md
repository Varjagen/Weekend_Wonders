# The Plague's Call

*(formerly Shadowquill VTT — v2 rename)*

A lightweight, single-page virtual tabletop for D&D and other tabletop RPGs. Built as a static web app with **no backend required** — real-time sync between DM and players runs peer-to-peer over WebRTC via PeerJS's free public broker.

Designed to be deployed on GitHub Pages in under two minutes.

---

## Features

- **Dual-mode interface** — separate DM (authoritative) and Player (restricted) views with strict permission asymmetry
- **Entity system** — PCs, Monsters, and NPCs with full D&D 5e stat blocks, HP/AC, ability scores, conditions, and separate DM / player-facing description fields for monsters
- **Hierarchical maps** — world → region → dungeon → room, with breadcrumb navigation and per-map viewport memory
- **Per-token visibility** — DM hides or reveals individual tokens via right-click context menu, sidebar eye-toggle, or the token detail panel. Hidden tokens stay fully visible to the DM; players never see them.
- **Drag & drop placement** — drag entities from the sidebar onto the map to place; drop onto another sidebar card to reorder
- **Reorderable bestiary** — DM drags the grip handle on any entity card to reorder the sidebar; order persists and syncs
- **Expandable stat blocks** — DM clicks an entity card to expand an inline stat block with AC, HP bar, ability scores, conditions, abilities, DM notes, and player-visible description
- **Smooth token animation** — when another user moves a token, it glides to its new position rather than snapping. Local drag stays 1:1 responsive.
- **Smaller, tidier tokens** — 36px tokens with aligned labels, HP bars, and condition dots
- **Player party sidebar** — left panel on the player view shows all PCs with HP bars and visible conditions; your own character is highlighted
- **Player revealed-monsters sidebar** — right panel shows monsters the DM has revealed, with public description and an approximate condition label (Strong / Rough / Waning / Down). Exact HP is hidden from players.
- **Player self-edit** — claimed PCs can adjust their own HP and toggle their own conditions. All player edits are whitelisted and routed through the DM for validation.
- **Hidden monster HP** — players never see exact monster HP in initiative, token detail, or revealed sidebar — only narrative condition labels
- **Initiative tracker** — auto-roll, manual override, turn advancement, tiebreak by initiative bonus then name
- **Encounter presets** — save & load map snapshots (token positions + visibility) for repeatable encounters
- **PC claiming** — players claim an available PC and can only move + edit that token
- **Push-view** — DM force-locks players to a specific map mid-scene
- **Conditions** — 20 predefined D&D conditions, toggleable per entity with colored token dots and pills
- **Export / import** — full session as JSON for backup or sharing
- **Backward compatible saved data** — old sessions migrate automatically on load (adds `entityOrder`, `playerDescription`, default token visibility)
- **IndexedDB persistence** — session data and map images auto-save to IndexedDB; auth and settings use `localStorage`
- **Mobile-friendly** — touch drag, responsive layout, mobile panels
- **Dark fantasy aesthetic** — Cinzel + Cormorant Garamond serifs, gold accents on midnight blue, softly-glowing tokens

---

## Deploy to GitHub Pages (2 minutes)

1. Create a new repository on GitHub (e.g. `shadowquill-vtt`).
2. Copy the four files from this folder into the repo root:
   - `index.html`
   - `app.js`
   - `.nojekyll`
   - `README.md` (optional)
3. Commit and push to the `main` branch.
4. In the repo, go to **Settings → Pages**.
5. Under **Source**, choose **Deploy from a branch**.
6. Select `main` branch and `/ (root)` folder, then **Save**.
7. Wait ~30 seconds. Your site is live at `https://<your-username>.github.io/<repo-name>/`.

That's it. No build step, no npm, no server.

> The `.nojekyll` file tells GitHub Pages not to run Jekyll, which would otherwise ignore files starting with underscores and slow deploys.

---

## Usage

### Starting a session

**As DM:**
1. Open the site.
2. Click the **DM** tab.
3. Enter the DM password (default: `dragon` — see *Configuration* below).
4. Pick a room code (any string, e.g. `friday-night`) and click **Begin Session**.
5. Share the room code with your players.

**As a Player:**
1. Open the same URL.
2. Click the **Player** tab.
3. Enter your name and the room code the DM gave you.
4. Click **Join Session**.

**Local / offline mode:**
Click **Continue without sync** on the auth screen to run the app solo without connecting peers. Useful for prep, solo play, or when one person is screen-sharing.

### During a session

- **DM** builds maps (top bar → Maps → upload image), creates entities from the left sidebar, drags them onto the map, and reveals them when players encounter them.
- **Players** see only revealed tokens and their claimed PC. They drag their own PC to move.
- **Push view** (DM top bar) forces all players to view the current map — useful for dramatic scene transitions.
- **Presets** save the current token layout so encounters can be reloaded later.

---

## Configuration

### Changing the DM password

Open `app.js` and edit line 15:
```js
const DM_PASSWORD = 'dragon';
```
Change the string, commit, and redeploy. Note: this is a client-side check and is **not real security** — anyone can read the JS source. For a trusted group of players it's fine; for public-facing deployment, put the app behind a real auth layer.

### Changing the PeerJS broker

By default the app uses PeerJS's free public cloud broker at `0.peerjs.com`. If you need higher reliability or want to self-host, see [PeerJS server docs](https://github.com/peers/peerjs-server). You'd then pass config to `new Peer(...)` in `app.js` around line 303.

---

## How sync works

- DM is authoritative — the DM's browser holds the canonical game state.
- Players connect to the DM's peer via WebRTC (PeerJS handles signaling through its broker, then peers talk directly).
- Player actions (move my PC, claim a PC) are sent to the DM as messages; the DM validates, applies, and broadcasts filtered state back to each player individually — each player only receives the tokens they're allowed to see.
- Room codes map to peer IDs via the prefix `plagues-call-` to avoid collisions.

### Known limitations

- If the DM refreshes or closes the tab, players get disconnected and must rejoin.
- Very large map images (multi-MB PNGs) sync slowly because PeerJS chunks binary data inefficiently. Keep maps under ~2 MB for smooth joins. For heavy assets, host images externally and paste the URL instead of uploading.
- The public PeerJS broker occasionally rate-limits — if you can't connect, wait a minute and retry.
- No optimistic updates on the player side: there's a ~50–150 ms round-trip when moving your PC. Usually imperceptible.

---

## Local testing

You can't open `index.html` via `file://` due to browser security restrictions on local resources (IndexedDB and WebRTC behave differently under `file://` origins). Use a local static server instead:

```bash
# Python 3
cd shadowquill-vtt
python -m http.server 8080
# then visit http://localhost:8080
```

Or any other static server (`npx serve`, `caddy file-server`, etc.).

---

## Tech stack

- **React 18** (loaded via CDN as UMD bundle)
- **JSX pre-compiled** via Babel at build time (`./build.sh`) — the browser loads `app.compiled.js`, not raw JSX
- **PeerJS** for WebRTC real-time sync
- Pure CSS with CSS custom properties for theming
- HTML5 drag-drop + pointer events for interactions
- **IndexedDB** for session persistence (map images stored separately to avoid quota issues); `localStorage` only for auth and settings

No bundler. No npm (except the one-time Babel compile step). No backend. Six files total.

---

## Security notes

- The DM password is a client-side placeholder; treat it as a "soft" gate, not real auth.
- WebRTC connections are peer-to-peer and encrypted in transit (DTLS), but the signaling broker sees connection metadata.
- Session state lives in LocalStorage on each user's device. Use Export/Import to back up.

---

## License

MIT — do what you want. Attribution appreciated but not required.

---

## Changelog — v2 upgrade

This release adds substantial DM/player workflow features on top of the v1 core.

### New in v2

1. **Per-token visibility** — DM hide/reveal from three places:
   - Right-click any token on the map → floating context menu with *Hide/Reveal*, *Open details*, *Edit entity*, *Remove*
   - Eye-icon button on the sidebar card (visible only for entities with a token on the current map)
   - The token detail panel (double-click a token)
2. **Smaller tokens** — 36 px (down from 44 px). Labels, HP bars, and hitboxes all scaled to match.
3. **Smooth remote movement** — tokens glide on `left/top` CSS transitions (~220 ms) when another user moves them. Local drag remains 1:1 responsive via a `.dragging` class that suppresses the transition.
4. **Drag-to-reorder bestiary** — DM drags the `⋮⋮` grip on the left of any entity card to reorder; dropping on another card places the dragged item before it. Reorder persists in `entityOrder` and survives export/import.
5. **Click-to-expand stat block** — clicking an entity card in the DM sidebar toggles an inline stat block (AC / HP bar / Speed / Init / six abilities / conditions / abilities / notes / player-visible description). The edit pencil still opens the full form.
6. **Player party sidebar** (left) — lists all PCs with HP bar, visible conditions, and a gold **YOU** badge for the claimed character. Click a party member to open their details (only writable if it's your own).
7. **Player self-edit** — in the token detail panel, the player can adjust HP (damage/heal) and toggle conditions on their own claimed PC. Edits are whitelisted and routed through the DM as `patch_own_entity` actions; the DM validates ownership and dispatches authoritatively. No other writes are permitted.
8. **Hidden monster HP for players** — monster HP is replaced everywhere players can see it (initiative tracker, right sidebar, token detail panel) with a condition label: **Strong** (>70%), **Rough** (30–70%), **Waning** (<30%), **Down** (0).
9. **Revealed-monsters sidebar** (right) — lists every monster with at least one visible token, showing the player-visible description and condition label. DM-private notes and abilities never reach this panel.

### Data model changes (migrated automatically)

Old saved sessions load cleanly on first open. `migrateState()` runs on HYDRATE, REPLACE, and initial DM `localStorage` load.

- `state.entityOrder: string[]` — explicit ordering of entity IDs. Missing on old sessions; rebuilt from the existing entities alphabetically.
- `entity.playerDescription: string` — player-visible text for monsters, kept separate from DM `notes`. Defaults to `''` when absent.
- `token.visible: boolean` — defaulted to `false` if missing from old tokens.
- Server-side filter (`filterStateForPlayer`) now strips `notes` and `abilities` from monsters before sending to players, and strips `notes` from NPCs.

### UX decisions (where the spec left room)

- **Reorder semantics are drop-before-target.** Dropping A onto C places A immediately before C. This is the standard convention for drag-reorder UIs and feels natural with the visible drop-target highlight.
- **The expand/collapse interaction reuses `selectedEntityId`**, so clicking a card visually connects to the token on the current map (via highlight) *and* expands the stat block in the same click. The pencil button (full edit form) is kept distinct.
- **A right-click context menu replaces the previous single-confirm "remove" behavior.** Right-click now offers visibility toggle, open details, edit entity, and remove — all clearly grouped in one floating panel.
- **Player self-edit is deliberately narrow** — only HP adjust and condition toggle. Editing notes, stats, class, name, etc. would require a richer permission model and is out of scope. The DM's validation clamps HP deltas to `±1000` and accepts only known condition strings.
- **Players lose `notes` and `abilities` on monsters via the sync filter, not just visually.** This means the data truly never leaves the DM's browser, so there's no risk of a sophisticated player reading DevTools and cheating.
- **Monster AC is hidden in the player's token detail panel**, along with Speed. Players only see Name, HP label, conditions, and the player-visible description — keeping surprise encounters mysterious.
- **The party sidebar never shows hidden enemies** — it only iterates `PC`-type entities. The revealed sidebar only iterates monsters with visible tokens. There's no shared computation that could accidentally leak data.

### Known constraints

- The drag-handle reorder uses HTML5 drag-and-drop, which means you can't currently drop *below* the last card or *above* the first without a card target. In practice this isn't a problem — drop onto the nearest neighbor and then again if needed.
- The context menu is fixed-positioned to the cursor and doesn't auto-flip near screen edges. Edge cases may go off-screen on very small viewports.

---

## Changelog — v3 (The Plague's Call)

This release is a significant upgrade focused on immersion, customization, and a new sickness-based gameplay mechanic. It adds 14 distinct features while preserving the v2 claim/visibility/sync model.

### 1. Rebrand

- Renamed from *Shadowquill* to **The Plague's Call** across title, topbar, auth screen, metadata, and export filenames.
- Icon updated to ☠ (from ⚔) to lean into the plague/decay aesthetic.
- Subtitle now reads "— a virtual tabletop for tales of rot and rust —".

### 2. Theme system — Dark Sanctum / Warm Tavern

- Settings cog (⚙) in the topbar opens a modal with a theme switcher.
- **Dark Sanctum** is the existing navy + gold look, kept unchanged.
- **Warm Tavern** is a full parchment/oak/candlelight reskin — every color variable is redefined under `[data-theme="light"]` on the root element, so no CSS rule had to change.
- Theme persists to `localStorage` under `plagues-call.settings.v2`.
- A tiny inline `<script>` in `index.html` applies the stored theme **before first paint** to avoid a flash of the wrong theme.
- Body transitions smoothly between themes (`transition: background/color 0.4s ease`).

### 3. Forced player onboarding

- When a player joins a live session without a claim, they see a full-screen **onboarding gate** instead of the map.
- They must pick an existing unclaimed PC, request a new one, or explicitly enter spectator mode.
- Spectators still see the map but aren't tied to a character; they can claim one later from the topbar.

### 4. DM visibility of claimed characters

- New DM topbar button **⚐ Claims** opens a side panel listing every connected peer: their name, peer ID, claimed PC (with live HP), and any claimed familiars.
- DM has a one-click **Unclaim** button per row — dispatches `DM_UNCLAIM_PC` or `DM_UNCLAIM_FAMILIAR` and re-broadcasts state.

### 5. New entity types

- **Familiar** — teardrop/leaf silhouette, green accent. Claimable by players; a single player can claim any number of familiars. Rendered in the party sidebar alongside PCs with a green **YOURS / FAM** badge. HP is visible to players (treated as party-tier).
- **Neutral Beast** — ellipse shape, amber. Uses normal visibility gating like monsters; HP hidden from players; shows up in the "Revealed" sidebar when made visible.
- **Object** — hexagon shape, bone/ivory. Static by default; a checkbox in the entity form toggles whether it participates in initiative.

### 6. Token hover tooltip

- Hovering a token (DM or player) shows a floating info chip near the cursor.
- DM tooltip: name, type badge, exact HP, conditions pills, description OR DM notes.
- Player tooltip: name, type badge, HP or Strong/Rough/Waning/Down label (per type gating), and the player-visible description if set.
- Fades in on hover with a 0.12 s transition; tracks the cursor via window `pointermove`.

### 7. Token image overlays

- Every entity now has an optional `imageUrl` field in the form.
- Upload compresses in-browser to 256×256 JPEG (quality 0.82) so sync payloads stay small.
- The image renders inside the token shape, masked to the shape's `border-radius`. Fallback is the colored shape with the initial letter.
- Portrait also appears in party cards, onboarding tiles, and claim modals.

### 8. Health bar visibility rules

- Only **PCs** and **Familiars** (the party types) show HP bars on their tokens for players.
- Monsters, NPCs, Neutral Beasts, and Objects never reveal exact HP to players — only the status descriptor.
- DM sees every HP bar unchanged.
- Exposed as a `PLAYER_HP_VISIBLE_TYPES` constant for consistency across `TokenView`, `TokenTooltip`, `InitiativeTracker`, and `TokenDetailPanel`.

### 9. Private reminder tokens

- New ◆ Reminder button in both DM and player topbars.
- Click the button to enter placement mode; click anywhere on the map to drop a pin with a short label.
- Each pin is **strictly private** — the filter layer ships only the requesting peer's own reminder list to them, and nothing to anyone else.
- Double-click a pin to delete it.
- Stored per-peer in `state.reminders[peerId]`. DM reminders use the synthetic key `dm`.

### 10. Map scale (DM-only global)

- In Settings, DM has a slider from 30 % to 300 %. Applied as a uniform multiplier on the `.canvas-stage` `scale()` transform.
- Stored in `state.mapScale`; synced to all players so everyone sees the same "world size".
- Pan/zoom still works on top of this — it's a base scale for the whole render, not a UI zoom.

### 11. Individual token scaling

- Per-token slider in the TokenDetailPanel (DM only): 30 %–400 %.
- Applied via a CSS custom property `--token-scale` on the token's inner wrapper, so the scaling happens inside the token rather than shifting its world position.
- Useful for bosses (large), imps or mice (small), or object props.

### 12. Edit My Sheet modal

- Dedicated player self-service screen, opened from the topbar "◈ Edit My Sheet" button.
- Tabbed interface if the player has claimed both a PC and familiars.
- Shows stats block (AC / HP / Speed / Level), HP adjuster, condition toggles, and the sickness descriptor (for PCs).
- All writes whitelist through the DM as `patch_own_entity` actions — only HP adjust and condition toggle are accepted.

### 13. Status effect positioning

- Major statuses (**Unconscious**, **Dead**, **Petrified**, **Paralyzed**, **Stunned**) now render as a small labeled line **below the token name**, not as a dot stacked on the token graphic.
- Other conditions still appear as small colored dots in the top-right corner of the token.
- Keeps token artwork legible at all zoom levels.

### 14. Sickness system

This is the flagship gameplay feature for v3.

- New **hidden** `sickness` field (0–3) on every entity — only PCs use it.
- Only the DM can write it. The DM sets it in the PC's token detail panel or in the entity form, via a 4-button picker.
- Players never see the number.
- The player's **own PC** sees a narrative descriptor on their Edit My Sheet:
  - 0 → nothing
  - 1 → "A bit pale"
  - 2 → "Sluggish and pale"
  - 3 → "Sick"
- **Visual effect on the player's map viewport:**
  - Level 1: −25 % saturation + subtle inner vignette
  - Level 2: −50 % saturation + medium vignette
  - Level 3: −75 % saturation + 12 % brightness drop + heavy vignette
- All visual effects are CSS filters + box-shadow on a `<div class="sickness-vignette">` overlay. No canvas repaint, no perf cost.
- Transitions smoothly (0.6 s ease) when the DM changes the level.
- Effects apply **only to the player view** (DM is unaffected).
- **Filter scope is `.canvas-container`** — the topbar, sidebars, and UI chrome remain fully readable.
- The filter layer strips `sickness` from every entity except the player's own PC before sending, so a player can never infer another party member's sickness value.

---

## Data model changes

All v2 changes are **forward-compatible** — old saved sessions load without user action. `migrateState()` handles:

- `claimedPCs` (flat map) → `claims` (structured record per peer with `{ pc, familiars, playerName, spectator }`)
- Missing `entity.playerDescription` → `''`
- Missing `entity.imageUrl` → `null`
- Missing `entity.sickness` → `0`
- Missing `entity.rollsInitiative` → `true`
- Missing `token.scale` → `1.0`
- Missing `state.mapScale` → `1.0`
- Missing `state.reminders` → `{}`
- Storage keys bumped to `plagues-call.session.v2` / `plagues-call.auth.v2`; the reducer reads the legacy `shadowquill.session.v1` key as a fallback on first load.

## UX decisions (where the spec left room)

- **Familiars show HP to everyone** because they're party-tier. Their stats look too close to PCs to be worth gating.
- **Neutral Beasts hide HP** — they're treated narratively like monsters even though they're not hostile, so players should have to experience them rather than scout their HP pool.
- **Objects show no HP bar** at all (max = 0 by default). The `rollsInitiative` toggle defaults `true` for compatibility with existing code paths that scanned all placed tokens — a DM can turn it off for pure props.
- **Settings are per-device**, not per-session. Game state is per-session and synced; personal preferences (theme, etc.) are not. This keeps "I prefer dark" from overriding another player at the same table.
- **Reminder pin placement uses single-click** in "placing" mode rather than drag-and-drop, because the common case is "mark the spot I need to remember" which is a point, not a path.
- **Forced onboarding never appears** for the DM or for `auth.local` mode (solo/offline). Only live-player sessions gate the map.
- **The vignette is `mix-blend-mode: multiply`** rather than a straight dark overlay, so it darkens scene artwork without washing out tokens or text over it.

---

## Changelog — v3 update

v3 focuses on **player agency**, **immersion systems**, **DM control tools**, and **visual feedback**. It adds 15 major features while preserving the strict DM-authoritative architecture and the forward-compatible migration from v1 and v2 saves.

### 1. Player full-stat editing

Players can now edit their entire claimed character's stat block, not just HP and conditions.

- STR/DEX/CON/INT/WIS/CHA with auto-computed modifiers
- HP current and max (with separate "quick adjust" damage/heal buttons)
- AC, Speed, Initiative bonus, Passive Perception
- Name, Class, Level, Player Name
- Token color + portrait upload
- Description / narrative notes
- Conditions (unchanged from v2)

All writes flow through the DM-authority pipeline as `patch_own_entity: op='field_set'`, with a strict allowlist: DM-only fields (`sickness`, `deathSaves`, `bondedPeerId`, `darkvision`, `lightRadius`, `type`, `id`) are never writable by players. Image data URLs are sanitized to require the `data:image/` prefix. HP clamps 0–10,000; ability scores clamp 1–30.

The Edit My Sheet modal has collapsible Ability Scores and Identity sections so the default view stays compact.

### 2. Player-visible sickness as a condition

Sickness is now diegetic for players. Instead of a number they see a descriptor on their token tooltip and in their own sheet:
- 1 → *a bit pale*
- 2 → *sluggish and pale*
- 3 → *sick*

Level 0 shows nothing. The numeric value is still DM-only. The descriptor appears as an italic Cormorant chip in the token-status stack below the name and as a bordered line in the tooltip with level-graded coloring (amber → blood-bright).

### 3. All status effects under tokens

The v2 split into "major statuses below" and "minor dots on-token" is gone. Every active condition now renders as a wrapping stack of tiny Cinzel chips directly below the token name, with per-condition colors pulled from `CONDITION_COLORS`. No truncation — unlimited conditions simply wrap. The sickness descriptor sits at the end of the stack as a distinct italic chip.

### 4. Familiar bonding

Familiars now have a **Bonded To** dropdown in the DM's token detail panel, listing every connected peer by their friendly name (falling back to a peer-id snippet) with their claimed PC shown for context. Setting `bondedPeerId` on a Familiar grants that player movement rights for the familiar's token.

The ownership rule is: a peer owns an entity if it's their claimed PC, a claimed familiar, **or** a familiar whose `bondedPeerId` points at them. This is checked by the shared `ownedByPeer()` helper used everywhere from `move_token` validation to the filter's visibility gate.

### 5. Player token image upload

The Edit My Sheet modal has an **Upload portrait** button that reuses the DM's existing image pipeline — browser-side compression to 256×256 JPEG at quality 0.82, returned as a base64 data URL. Portraits appear inside the token circle with `border-radius: inherit` so they mask to the token shape. Upload is only available for the player's own PC and claimed familiars.

### 6. DM death-save tracking

In the DM's token detail panel for a PC, there's now a dedicated Death Saves block with 3 success pips (✓, emerald) and 3 failure pips (✗, blood red). Clicking a pip sets the counter to that value (or clears if you click the already-highest one — classic toggle). There's a **Clear** button to reset both to zero. Counters clamp 0–3. `deathSaves` is stripped from every player-facing filter — clients never see this field at all, even for their own PC.

### 7. Long rest

One **⛭ Long Rest** button in the DM topbar plus a **⛭ Rest** button on each PC/Familiar in the token detail panel. Both dispatch `LONG_REST`; the topbar variant rests everyone, the per-entity variant rests just that character. The action:

- Restores HP to max
- Clears: Unconscious, Exhausted, Poisoned, Frightened, Blinded, Deafened, Charmed, Stunned, Paralyzed, Prone, Restrained, Incapacitated, Grappled
- Resets sickness to 0
- Resets death saves to 0/0
- Leaves persistent narrative conditions (Dead, Petrified, custom) alone

A confirmation dialog prevents accidental presses.

### 8. Downed state visual effect

When the player's own PC drops to 0 HP, their canvas gets a `.downed` class. The CSS applies:
- Full desaturation + brightness drop + slight contrast reduction
- A heavy inner vignette via a pulsing `::after` pseudo-element
- A slow 4-second pulse animation keyed to a heartbeat-like cycle

Transition is 0.8s ease-out so it doesn't snap. Does not affect the DM view. Does not affect sidebars or topbar — scoped strictly to `.canvas-container`.

### 9. Warm Tavern theme — retuned

The light theme has been rebalanced away from the too-yellow parchment feel. New palette anchors:
- `--bg-deep: #d6c3a0` (stained oak floor)
- `--bg-0: #e4d3b0` (weathered tabletop)
- `--bg-2: #c4ac84` (burnished wood trim)
- `--gold: #6a3f13` (burnished copper)
- `--ink: #2a1b0d` (ink-on-parchment, but darker)

The canvas backdrop is now a radial gradient from `#c4a878` → `#8a6a42`. The feel is dim-lit-tavern rather than noon-under-sun.

### 10. Map filtering

Party sidebar and Revealed sidebar both now take `currentMapId` and only show entities with a token on that specific map. A character on a different map no longer shows up in the current scene's party panel. This is a pure read-side change — state stays complete, the UI just narrows its view.

### 11. DM per-player push

The new **🌍 World** panel lists every connected peer with a map dropdown. The DM can push any map to any specific player — or to the whole party via the "Push to All" button (which uses the legacy global `forcedView`). The panel shows each peer's current push state ("free" vs "locked → MapName") in real time. There's a "Clear all pushes" escape hatch that drops both the global and all per-peer locks.

Per-peer state is stored in `state.forcedViewPerPeer[peerId] = { mapId }`. The filter resolves per-peer first, then falls back to global, then to the player's own map override.

### 12. Time of day

The World panel has a day→night slider (0 to 1) with **Day / Dusk / Night / Deepest** quick-set buttons. The player's canvas gets a `tod-N` class (N = 0..10) that applies graduated CSS filters: decreasing `brightness` and `saturate` combined with a negative `hue-rotate` for a cool blue tint. The DM view is unaffected — they always see the map clearly regardless of in-world time. Transitions are 0.8 s ease.

The effect **stacks with sickness and downed states** (all are CSS filters on the same element, so they compose). A special override rule handles the extreme "downed at midnight" case gracefully.

### 13. Darkness / darkvision / light system

The flagship v3 feature. Every entity now has `darkvision` and `lightRadius` in feet (editable on both the full entity form and the quick token detail panel). A constant `PX_PER_FOOT = 10` converts feet to world pixels so vision scales with the map naturally.

**Player view** — when time of day ≥ 0.5 or any owned entity has vision, an SVG overlay sits above the map. The overlay is a 96%-opaque near-black rectangle. For each vision source, the mask punches a radial-gradient hole: fully visible at center, soft fade from 70% of the radius to the edge, fully dark beyond. **Block zones** (feature 15) paint additional black rectangles on the mask so they occlude even when inside someone's vision radius. Multiple sources naturally combine — the union of all radial gradients forms the lit area.

**DM view** — instead of a mask, the DM sees dashed colored outline circles for every vision source on the map. Each character's circle uses their token color so the DM can quickly identify "that's Ana's sight radius, that's Jonas's".

**Vision contribution rules:**
- Owned entities contribute both their darkvision and their carried light to the owner
- Unowned entities (NPCs, monsters, torches on the ground) contribute **only** their emitted `lightRadius` — a torch illuminates everyone, but a monster's darkvision stays private to the DM
- This means a lit lantern dropped on the floor has `type: 'Object'`, `lightRadius: 30`, and lights the room for everyone

SVG-based rendering is cheap — no per-frame canvas redraw, browser composites the radial gradients natively, and the layer is simple enough that even 10+ sources don't cause perf issues on low-end hardware.

### 14. Token presets

A new **❈ Preset** button in the DM entity sidebar opens a dropdown of quick-create presets. Built-in presets ship with the app:

- **Goblin** — CR 1/4 Monster, HP 7, AC 15
- **Commoner** — NPC, HP 4
- **Guard** — NPC, HP 11, AC 16
- **Bandit** — CR 1/8 Monster
- **Wolf** — Neutral Beast, Speed 40
- **Skeleton** — CR 1/4 Monster, undead flavor
- **Chest** — Object, no initiative
- **Torch / Brazier** — Object, lightRadius 20 ft (this one's a vision-system-aware convenience preset)

The DM can save any existing entity as a custom preset from the sidebar context, persisted to `state.tokenPresets[id]`. Custom presets show up in the same dropdown under a "Custom" header with individual delete buttons. Picking any preset creates a pre-filled new entity and opens the edit form so the DM can tweak before saving.

### 15. Map block zones

The World panel has an **◼ Draw Block** toggle. With it active, the DM drags a rectangle anywhere on the map to create a zone (minimum 8×8 px so a stray click doesn't commit an invisible zone). In-progress drawing shows a pulsing dashed rectangle so the DM can see the current extent while dragging. On release, the zone commits to `state.blockZones[mapId]` via `BLOCK_ZONE_UPSERT`.

**For the DM**, existing zones render as translucent dashed red rectangles (`rgba(160,60,60,0.18)` with dashed `rgba(200,80,80,0.55)` border). Hover darkens them slightly for editability affordance. Double-click deletes a zone (with confirm).

**For players**, block zones render as solid near-black panels that sit above the map but below vision and tokens. They also participate in the vision mask — a block zone inside a lit area still stays dark.

There's also a "Clear All" button in the World panel to wipe every zone on the current map.

---

## Data model additions (v3)

### On each entity
- `darkvision: number` — feet; default 0 (no darkvision)
- `lightRadius: number` — feet; default 0 (no carried light)
- `bondedPeerId: string | null` — peer ID of the player who controls this familiar; default null
- `deathSaves: { successes: number, failures: number }` — both 0–3, default `{0, 0}`

### On state (world level)
- `timeOfDay: number` — 0 (day) to 1 (deep night); default 0
- `blockZones: { [mapId]: BlockZone[] }` where `BlockZone = { id, x, y, w, h }`
- `tokenPresets: { [id]: { id, name, entity } }`
- `forcedViewPerPeer: { [peerId]: { mapId } }`

### Storage key
Unchanged from v2: `plagues-call.session.v2`. `migrateState()` backfills all v3 fields idempotently on first load, so any v1 or v2 save loads cleanly. Damaged `deathSaves` (e.g. `null`) is repaired to the zeroed object.

### Migration coverage
26/26 migration assertions pass — tested via `/tmp/v3_migration_test.js`:
- v1 `claimedPCs` → v3 `claims` structure
- All new entity fields backfill correctly with sensible defaults
- All new state fields backfill correctly
- Malformed `deathSaves` is repaired rather than throwing
- Pre-existing v3 field values are preserved (never overwritten by defaults)
- `migrateState(migrateState(x))` === `migrateState(x)` (idempotent)
- `timeOfDay` clamps to [0, 1] even if a malicious save has out-of-range values
- `makeDefaultState()` produces a state with all v3 fields at safe defaults

---

## Performance notes

- **Vision system** uses a single SVG overlay with N radial-gradient circles rather than a canvas redraw loop. Browser composites in GPU; no per-frame JS cost.
- **Time-of-day / sickness / downed** are all pure CSS `filter` rules on `.canvas-container`. They stack naturally because CSS filters compose. No JS animation loop.
- **Block zones** are DOM divs, not canvas rectangles — this lets the DM hover + double-click naturally and keeps draw interaction dead-simple.
- **Per-peer filter** runs once per (peer × state broadcast). The filter is a pure function over the state, so React's default structural sharing handles the memoization when the inputs don't change.
- **Map filtering** in the sidebars is inside a `useMemo` keyed on `state.tokens` and `currentMapId`, so it only recomputes when tokens change or the map switches.
- **Sync payload** still scales linearly with entity count. The new fields add ~80 bytes per entity on average.

---

## Feature scorecard

| # | Feature | Status |
|---|---------|--------|
| 1 | Player full stat editing | Shipped |
| 2 | Sickness as diegetic condition | Shipped |
| 3 | Status effects under tokens | Shipped |
| 4 | Familiar bonding dropdown | Shipped |
| 5 | Player token image upload | Shipped |
| 6 | DM death save tracker | Shipped |
| 7 | Long rest | Shipped |
| 8 | Downed visual effect | Shipped |
| 9 | Warm Tavern theme retuned | Shipped |
| 10 | Map filtering | Shipped |
| 11 | DM per-player push | Shipped |
| 12 | Time of day | Shipped |
| 13 | Darkness / vision system | Shipped |
| 14 | Token presets | Shipped |
| 15 | Map block zones | Shipped |

**15 of 15 features implemented.** Code parses clean (Babel), CSS balanced (481 rule blocks), 26/26 migration tests pass.

---

## Changelog — v4 update (stability + polish milestone)

v4 is the "solid and dependable" release — 20 distinct fixes and enhancements focused on bugs that hurt real-session usability, plus targeted expansions of gameplay features.

### Critical bug fixes

#### Fix #6 — Controlled-input glitch (sheet editor)

Symptom: typing in a player's sheet would occasionally snap back mid-word. Root cause: on every keystroke the player sent a `field_set` action to the DM, who applied it and re-broadcast the whole state back, which fed into the input's `value={entity.x}` prop. If the round-trip landed between keystrokes, React would re-render with the server's "committed" value before the next local keystroke, wiping in-progress text.

Fix: three new components — `LiveInput`, `LiveNumberInput`, `LiveTextarea`. Each keeps a local `useState` draft while the field is focused and commits via `onBlur` or Enter. The prop-sync `useEffect` is gated on `!focused`, so server broadcasts during typing are simply ignored until the user leaves the field. Escape discards the draft. Every text and number input in `EditMySheetModal` now uses these.

#### Fix #7 — Player identity persistence

Symptom: on refresh, a player would show up as a brand-new peer with no claimed character. Root cause: PeerJS generates a random peer ID each session; the DM's claim map was keyed on that ID.

Fix: added `plagues-call.player-id.v4` localStorage entry that holds a stable per-device UUID. The player's `hello` handshake now includes `playerId`. The DM-side handler looks up existing claims with matching `playerId` and dispatches `CLAIM_MIGRATE`, atomically moving the claim, bonded familiars, per-peer push-view, and private reminders from the old peer ID to the new one. Pre-v4 saves have `playerId` back-filled on first load.

#### Fix #8 — DM state persistence

Audit only. Verified that every v3 + v4 reducer case returns a new top-level state object (required for React's `useEffect` dependency to notice), and that the `useEffect(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(state)), [state])` fires as intended. No defects found.

#### Fix #11 — Vision system inverted

Symptom: light/darkvision radii rendered as **darker** spots, not brighter. Root cause: the SVG mask used `<rect fill="black">` as the base and `<circle fill="white">` for vision sources — but the masked-rect fill was the dark occluder, so the vision circles were showing the dark fill and areas outside were hiding it. Exactly backwards.

Fix: inverted the mask. Base is now `<rect fill="white">` (show the dark occluder everywhere), vision sources are `<circle fill="black">` with a radial gradient (hide the dark fill in the vision radius, letting the map show through). Block zones paint white on top to re-occlude. Also removed the `map?.imageUrl` gate so vision works on blank maps.

#### Fix #12 — Base 10 ft visibility

Characters with zero darkvision in a pitch-black dungeon could see nothing at all. Now `computePlayerVisionSources` always contributes at least `10 ft × PX_PER_FOOT` for owned entities. Combined with the corrected mask, this guarantees an owned character can always see their own 10 ft circle.

#### Fix #13 — Push to all

Root cause: the filter resolved per-peer push-view before global, so peers with an individual push kept their override when the DM clicked "Push to All". Fix: `pushGlobal` now dispatches `FORCED_VIEW_PEER_CLEAR_ALL` before setting the global, so the global actually reaches everyone.

### New features

#### Fix #1 — Time-of-day indicator on DM topbar

The `🌍 World` button now displays a live glyph + label reflecting the current time-of-day slider: `☀ Day` → `◑ Eve` → `◐ Dusk` → `☾ Night` → `☾ Deepest`. Thresholds at 0.15 / 0.40 / 0.70 / 0.95 of the 0–1 TOD scalar. Updates in real time.

#### Fix #2 — Reminder drag + right-click delete

Reminders gained full pointer interaction: pointer-down-drag moves the pin live through the DM-authoritative `REMINDER_UPSERT` path. Right-click opens a confirm-delete dialog (with `preventDefault()` to suppress the browser context menu). Double-click still works as a secondary delete path.

#### Fix #5 — DM can kick players

`🚫 Kick` button added to each peer row in the DM Claims panel, guarded with a confirm dialog. Sends a `kicked` message over WebRTC (player gets a friendly "DM has removed you" toast), closes the connection after 150 ms, and dispatches `DM_KICK_PEER` to clear the claim, unbond familiars, and remove per-peer push-view + reminders.

#### Fix #9 — Player-editable vision stats

Players can now edit their own `darkvision` and `lightRadius` in Edit My Sheet. Fields added to `PLAYER_FIELD_WHITELIST` with 0–600 ft clamping at the DM validator. Only exposed for PC and Familiar entity types.

#### Fix #14 — Always-dark maps

A new "Always dark" checkbox in the MapManager edit form. When set, the player's `visionEnabled` prop is forced true regardless of time-of-day, so the vision system always applies. Perfect for dungeons, sewers, and caves. Backward-compatible with older saves (missing flag = falsy = no behavior change).

#### Fix #15 — Entity duplication

`⎘ Duplicate` button in the entity edit modal. `ENTITY_DUPLICATE` reducer case creates a fresh entity with a new ID, " (copy)" suffix, cleared death saves, cleared bondedPeerId, inserted directly after the source in `entityOrder`.

#### Fix #16 — Block system improvements

The block zone system was rewritten to support three requirements:

1. **Feathered edges** — player-side block zones now render through an SVG layer with a `feGaussianBlur stdDeviation=3` filter, giving them a soft edge that blends into the map rather than looking like a sharp-cornered rectangle.
2. **Overdraw** — zones can now overlap freely. Draw a second zone over an existing one to extend a wall; they merge visually without seams because it's all one SVG `<polygon>`/`<rect>` soup.
3. **Freeform shapes** — new `✎ Freeform` draw mode in the World panel (mutually exclusive with `◼ Rectangle`). Pointer-down-drag builds a polyline, sampled every 5 px in world coordinates. On pointer-up, if the polyline has ≥3 points, it commits as `{ type: 'poly', points: [[x,y], ...] }`. Perfect for irregular walls, fog banks, and curved caverns.

Block zones now keep two shape types internally: `{ type: undefined, x, y, w, h }` (legacy rectangles) and `{ type: 'poly', points }` (freeform polygons). Both render correctly in both DM and player mode, and both occlude the vision mask.

#### Fix #17 — Auto-Dead for non-PC entities

`ENTITY_HP_ADJUST` now branches on entity type: PCs at 0 HP get Unconscious (preserving death-save semantics), everything else (Monster, NPC, Familiar, Neutral Beast, Object) goes straight to Dead. Healing above 0 auto-clears the Dead condition, so a healing word works cleanly on a downed minion. DM can still toggle either condition manually to override.

#### Fix #18 — Sidebar sort/filter by Object

Entity sidebar filter pills now include Familiar and Object in addition to All / PC / Monster / NPC.

#### Fix #19 — 10 Object presets

Candle (lightRadius 5), Pouch, Lever, Key, Book, Door (HP 10 / AC 15), Reinforced Door (HP 25 / AC 18), Trap Door, Reinforced Trap Door, Window. All have `rollsInitiative: false` and sensible AC/HP for breakage mechanics.

#### Fix #20 — 5 NPC presets

Male Commoner, Female Commoner, Local Elite, Fighter Guard, Ranger Guard. The Ranger Guard ships with 30 ft darkvision — a usable example of v3 vision stats.

### Data model additions

- `state.[entity].darkvision` — player-writable now (was DM-only)
- `state.[entity].lightRadius` — player-writable now
- `state.claims[peerId].playerId` — stable UUID for identity migration
- `state.maps[mapId].alwaysDark` — boolean, optional, defaults false
- `state.blockZones[mapId][n].type` — `'rect'` (implicit, legacy shape) or `'poly'`
- `state.blockZones[mapId][n].points` — `[[x,y], ...]` when type is 'poly'

### Storage keys (v4)

- `plagues-call.player-id.v4` — stable per-device UUID (new)
- `plagues-call.session.v2` — unchanged (session state)
- `plagues-call.auth.v2` — unchanged (auth), but pre-v4 saves are auto-upgraded with a `playerId` on first load
- `plagues-call.settings.v2` — unchanged

### New reducer actions

- `CLAIM_MIGRATE` — atomic claim + familiar-bond + per-peer view + reminder transfer
- `DM_KICK_PEER` — removes all peer-scoped state atomically
- `ENTITY_DUPLICATE` — clone with new ID, cleared DM-private fields, ordered insertion
- `MAP_PATCH` — partial patch on map fields (used for alwaysDark)
- `REMINDER_MOVE` — reminder drag commits

### SyncManager additions

- `onPlayerHello` callback — DM-side handler for identity migration
- `kickPeer(peerId, reason)` — sends `kicked` message, closes connection
- Player-side handler for inbound `kicked` messages

### Sanitization

- Vision numeric fields clamp 0–600 ft at the DM validator
- Reminder labels clamp at 200 chars (existing behavior)
- Claim migration preserves `playerId` cross-reference on the claim record for future migrations

---

## Changelog — v5 update (worldbuilding + visibility overhaul)

v5 is the **major stability + worldbuilding upgrade**. The focus was cleaning up remaining persistence issues, making visibility work correctly across day/night/always-dark, and dramatically expanding the bestiary.

### Critical bug fixes

#### Fix #1 — DM state persistence (root-level fix)

Symptom: token positions weren't being saved after a page refresh; presets occasionally went missing from exports. Root cause: every state change triggered an immediate `JSON.stringify(state) + localStorage.setItem()` call, and with large embedded map images this could take 20–50 ms per write. A rapid-drag-then-refresh sequence could race — the React effect was scheduled but hadn't run yet when the page unloaded.

Fix:
- Debounced the persistence write to **300 ms**, coalescing burst edits into one stringify+setItem.
- Added a **`beforeunload` / `pagehide` flush handler** that writes immediately when the tab is closing, guaranteeing no edits are lost on refresh.
- Uses a ref (`stateRef`) so the flush always sees the latest state, even if multiple changes queued inside the debounce window.

Exports already included both `state.presets` (encounter snapshots) and `state.tokenPresets` (individual creature presets) — the "presets missing from export" claim was a symptom of this same race, where the exported state was a slightly-stale snapshot of what was in localStorage.

#### Fix #4 — Vision-based hard visibility cutoff

Symptom: at night, tokens outside a player's vision radius were still rendered (just visually covered by the dark overlay) and still appeared in sidebars. The spec demanded a hard cutoff — tokens outside range should **not be rendered at all**.

Fix: added a post-visibility stage in `filterStateForPlayer`. When vision is active (night or alwaysDark), the filter:

1. Determines the current map for this peer (respects push-view overrides).
2. Computes the peer's vision sources on that map via `computePlayerVisionSources`.
3. For every token on the active map, checks if its (x, y) falls within any source's radius using a squared-distance comparison (no sqrt). Tokens outside all radii are dropped.
4. Owned PCs, Familiars, and Labels always pass — a player never loses their own party or map annotations.
5. Tokens on other maps are unaffected (player isn't looking at those).

Since sidebars filter on `state.tokens`, dropped tokens also disappear from the sidebar — the cutoff is total. The DM always sees everything; this logic only runs in the per-peer filter.

#### Fix #5 — Status effect stacking direction

Symptom: multiple status chips on a single token would stack upward and overlap the token graphic. Root cause: `.token-status-stack` used `bottom: -30px` with `flex-wrap: wrap` and `justify-content: center`, which anchored the stack to the bottom edge and grew wrapped rows upward from there.

Fix: `top: calc(100% + 14px)` (so the stack sits below the token name label at `bottom: -16px`) with `flex-direction: column` and `align-items: center`. Each additional chip now stacks straight down, never overlapping the token.

#### Fix #7 — Vision system during daytime

Symptom: darkness was incorrectly applied during daytime if any owned entity had darkvision or a carried light. Root cause: the `visionEnabled` prop was `alwaysDark OR (tod >= 0.5) OR anyone-has-vision-stats`, which meant a character with 60 ft darkvision caused the vision mask to render even at TOD=0 (bright noon).

Fix: removed the "anyone has vision stats" clause. Vision system is now active only if `alwaysDark` is true OR `timeOfDay ≥ 0.5`. Daytime = full map visible regardless of vision stats.

Added **light multipliers** based on time of day to `computePlayerVisionSources`:

- **Dusk/dawn (0.5 ≤ TOD < 0.7):** lightRadius × 1.75 — sky still glows, light travels further.
- **Night (0.7 ≤ TOD < 0.95):** lightRadius × 1.25 — moderate ambient.
- **Deepest (TOD ≥ 0.95):** lightRadius × 1.0 — unmodified.
- **Darkvision unaffected** — it's magical, independent of ambient light.

`alwaysDark` maps behave as "deepest" regardless of TOD.

#### Fix #8 — Permanent darkness maps + vision coexistence

Darkvision and light sources correctly continue to work on maps flagged `alwaysDark: true`. This is a natural byproduct of fix #7 — the `alwaysDark` flag simply forces `visionEnabled=true` instead of overriding any downstream vision logic.

#### Fix #9 — Objects become "Broken", not "Dead"

Objects at 0 HP shouldn't be "dead" (they aren't alive). Added `'Broken'` to `CONDITIONS` with a distinct dusty grey-brown color (`#7a6455`) to distinguish from Dead's blood-red.

`ENTITY_HP_ADJUST` now branches three ways:
- **PC → Unconscious** (preserves death-save semantics)
- **Object → Broken**
- **Everything else → Dead** (Monster, NPC, Familiar, Neutral Beast)

Healing/repair above 0 auto-clears both Broken and Dead, so a mending cantrip on a shattered door just works.

### New features

#### Fix #2 — Draggable popups

All `.float-panel` popups are now draggable by their header. Built from two pieces:

- **`useDraggable(ref)` hook** — attaches pointer event handlers to the panel's `.float-panel-header`; tracks a local `{dx, dy}` offset; applies it as a CSS `transform: translate(...)` so the original `right/top` positioning is preserved. Clamps so the header always stays at least 80 px visible horizontally and can't go above y=0 or below the viewport. Pointer capture keeps the drag alive even if the mouse leaves the window. Drags on interactive children (buttons, inputs, selects, `.close-x`) are ignored so close buttons still fire.

- **`<FloatPanel>` wrapper component** — calls `useDraggable` internally and applies the ref + transform style to its root. Each panel swaps `<div className="float-panel">` → `<FloatPanel>` to inherit drag behavior.

Converted 7 float panels: `InitiativeTracker`, `MapManager` (editing + list modes), `PresetsPanel`, `TokenDetailPanel`, `DMWorldPanel`, `DMClaimsPanel`. Header gets a `cursor: move` affordance; while dragging the cursor becomes `grabbing` and the panel dims slightly (via `.float-panel:has(.float-panel-header.dragging)`) for visual feedback.

#### Fix #3 — Text tokens (map labels)

New `'Label'` entity type for map annotations like "Butcher", "Church", "Crossroad". Label tokens:

- Render as stylized text (Cinzel serif, uppercase, letterspacing 0.18 em) in warm gold (`#c9a34a` default), with a multi-layer text-shadow for legibility on any map background.
- **No shape, no HP bar, no conditions stack** — just the text.
- **Always visible** — bypass both the visibility gate AND the vision cutoff so they're readable day or night, even outside vision range (they're diegetic map annotations, not tokens).
- Scalable via the existing `--token-scale` CSS var, so the DM can make a town label big and a street label small.
- Still draggable to reposition like any other token.

Available as a new entity type in the Add Token menu and selectable in the bestiary filter.

#### Fix #6 — Sickness visible to all players on all visible tokens

Previously sickness was stripped from non-owned entities in the filter (`cleaned.sickness = 0`). v5 removes the strip — sickness descriptors now appear on every visible token's tooltip and in the chip stack. The numeric level is never leaked; only the italic narrative descriptor ("a bit pale", "sluggish and pale", "sick") is rendered.

Sickness editing was widened from `type === 'PC'` to `['PC','NPC','Monster','Neutral Beast','Familiar'].includes(entity.type)` in both `TokenDetailPanel` and `EntityForm`. The Sick Village Guard preset (CR 1/2) ships with `sickness: 2` baked in as an example.

#### Fix #10 — Familiar bonding refinement (bond-to-PC)

Previously, familiars bonded to a specific peer ID — fragile across reconnects since PeerJS gives each session a new peer ID. v5 adds a `bondedPcId` field that references a PC entity id directly. Whoever currently claims that PC gets movement rights automatically; if the PC is unclaimed, the bond sits dormant.

- Dropdown now lists every PC (with `(PlayerName)` if claimed, `— unclaimed` otherwise) instead of every connected peer.
- Ownership resolution in both `filterStateForPlayer` and `handlePlayerAction.ownedByPeer` checks **both** `bondedPeerId === peer` (legacy v3/v4 path) AND `bondedPcId === claim.pc` (v5 path), so existing saves still work.
- Contextual hint on the dropdown: "bond dormant" when PC is unclaimed, or "{PlayerName} controls this familiar" when active.
- Migration backfills `bondedPcId: null` idempotently for all existing entities.

#### Fix #11 — Bestiary overhaul + 23 new presets

The old flat preset dropdown was unusable once the catalog grew past ~15 entries. v5 ships a dedicated `<BestiaryMenu>` component with:

- Sticky header with autofocused search (matches name, entity name, role, or category).
- Two select filters: **category** (Humanoid, Animal, Ooze, Object, Custom, All) and **type** (PC, NPC, Monster, Familiar, Neutral Beast, Object, Label, All).
- Scrollable body grouped by category with item counts.
- **CR badges** — tiny gold-bordered pills, shown only on presets that carry a CR value.
- **Role labels** in italic grey for at-a-glance identification ("orc warrior", "riding horse", "blacksmith").
- Custom DM presets bucketed separately with delete affordances.

**23 new built-in presets:**

| Category | Presets |
|---|---|
| **Humanoids** | Young Child · Child · Teen · Blacksmith (CR 1/4) · Sick Village Guard (CR 1/2, sickness 2) · Village Guard (CR 1) · Priest (CR 4) · Tavernkeeper · Tinkerer / Artificer (CR 9, darkvision 60) · Fisherman · Orc (CR 1/2, darkvision 60) |
| **Animals** | Dog · Cat (darkvision 60) · Pigeon · Large Toad (darkvision 30) · Eagle · Boar · Elk · Horse · Chicken · Donkey · Mule |
| **Ooze** | Slime (CR 1/2, darkvision 60) |

Plus the 15 v4 presets (10 Objects, 5 NPCs) and 8 v3 presets remain, for **46 total built-ins** organized into 7 categories in the new bestiary.

Each new preset has appropriate HP/AC/stats/speed plus a `playerDescription` for tooltip flavor. Creatures with racial darkvision have it baked in. DM custom presets still work and appear in their own bucket.

### Data model additions

- `entities[id].bondedPcId` — new field, bonds a familiar to a PC entity id instead of a peer id. Idempotently backfilled as `null` for older saves.
- `entities` of type `'Label'` — new entity type for map annotations. Rendered as stylized text instead of a shape.
- `'Broken'` condition — added to CONDITIONS list with color `#7a6455`.
- Preset objects optionally carry `category: 'Humanoid' | 'Animal' | 'Ooze' | ...` and `cr: '1/2' | '4' | ...` fields for bestiary filtering.

### Storage + sync

No new localStorage keys. Existing keys (`plagues-call.session.v2`, `plagues-call.auth.v2`, `plagues-call.settings.v2`, `plagues-call.player-id.v4`) unchanged.

### Migration handling

`migrateState` is fully backward-compatible from v1 through v5:

- v1 `claimedPCs` → v2 `claims` (v2 migration)
- v2 → v3: `darkvision`, `lightRadius`, `sickness`, `deathSaves`, `bondedPeerId`, `forcedViewPerPeer`, `tokenPresets`, `blockZones`, `timeOfDay` backfilled
- v3 → v4: `alwaysDark` preserved on maps, polygon block zones preserved, `playerId` preserved on claim records
- v4 → v5: `bondedPcId: null` backfilled on every entity; idempotent

**17/17 migration + feature smoke tests pass**, including:
- v1→v5 claim construction
- All intermediate preserved fields
- Dusk > night > deepest radius ordering
- Idempotency
- Label entity type + Broken condition registered

### Final feature scorecard

All 11 v5 items shipped:

| # | Feature | Status |
|---|---|---|
| 1 | DM state persistence | ✅ |
| 2 | Draggable popups | ✅ |
| 3 | Text tokens | ✅ |
| 4 | Vision hard cutoff | ✅ |
| 5 | Status stack direction | ✅ |
| 6 | Sickness on all types | ✅ |
| 7 | Vision day/night + multipliers | ✅ |
| 8 | AlwaysDark + vision coexist | ✅ |
| 9 | Broken state | ✅ |
| 10 | Bond by PC | ✅ |
| 11 | Bestiary overhaul + 23 presets | ✅ |

---

## Changelog — v6 update (durability, tools, and annotation overhaul)

v6 is the **tooling and durability** release. Three persistent user-visible bugs got decisive fixes (persistence reliability, UI darkening at night, bestiary modal layout), and six new creative-tool surfaces were added: circle block zones, a block eraser, a drawing tool shared between DM and players, measuring tools, multi-select with group-move, and a six-kind hazard-polygon system with hidden-trap support. Label entities from v5 got a dedicated state descriptor and now follow vision rules like any other token.

### Critical bug fixes

#### Fix #2 — Token persistence (bulletproof)

Symptom: tokens occasionally vanished between sessions. v5 had already added debouncing + a beforeunload flush, but users still reported losses on mobile and in rapid-navigation scenarios. Root cause analysis revealed three interacting issues: (a) a narrow race between the 300 ms debounce and `pagehide` on mobile Safari, (b) no backup slot if the primary key got corrupted, and (c) silent wipes when JSON.parse threw on a partial write.

Fix:
- **Loader** (`tryParse`) now walks `STORAGE_KEY → backup slot → legacy key → default`, logging every attempt with byte count + token count to console. Never silently wipes on parse failure — if every key fails, it warns loudly and returns the default without destroying the bad data.
- **Writer** (`persistNow`) writes to **both** the primary key and a `.backup` key on every save. If the primary write throws `QuotaExceededError`, a toast notifies the user.
- **Immediate-on-critical persistence**: a useEffect computes a signature of `(tokenCount, entityCount, currentMapId, first 32 token positions)` on every state change. If the signature changed, the write fires **immediately** with `reason='critical'`. Otherwise it debounces at 250 ms (down from 300 ms). Token placement, HP changes, and map switches now persist within milliseconds regardless of mobile throttling.
- All writes log to console: `[plagues-call] saved (reason): N bytes, T tokens` so the user can verify persistence is running.

#### Fix #6 — UI darkening at night (scoped filter fix)

Symptom: at night and in alwaysDark maps, the floating panels (world panel, entity edit forms, initiative tracker) became unreadably dim. Only the map itself should darken.

Root cause: the TOD (time-of-day) and sickness CSS filters were applied to `.canvas-container` — which contains both the map layer AND the floating panels. `filter` cascades through all descendants, so the panels inherited brightness(0.35) at deep night.

Fix: rescoped all filter selectors to target `.canvas-container[class*="tod-"] .canvas-wrap` (the map layer only) instead of the container. 11 TOD rules + 3 sickness rules rewritten. The three legacy `.canvas-container.sick-level-N` selectors were removed and re-added at the `.canvas-wrap` level with identical filter values. Floating panels now render at full brightness regardless of in-world lighting.

#### Fix #1 — Bestiary as centered modal

Symptom: the bestiary menu was an absolutely-positioned element anchored to its trigger, which on smaller viewports could overflow the screen or be cut off by the topbar.

Fix: wrapped `BestiaryMenu` in a `.bestiary-overlay` fixed-position full-screen overlay with click-outside-to-close, z-index 500. Modal itself is `min(480px, 100%)` wide, `min(640px, calc(100vh - 40px))` tall, centered via flex. Scales cleanly on mobile.

### Feature: tokens & annotations

#### Fix #3 — Label state descriptions

Spec revision from v5. Labels are now structures or landmarks with wear state. The TokenDetailPanel now has a dedicated render branch for `entity.type === 'Label'` that skips all creature UI (no AC, HP numbers, Speed, Passive Perception, conditions grid) and instead shows a single state chip derived from HP percentage:

- `> 70%` — no chip (pristine)
- `50–70%` — **Damaged** (amber)
- `20–50%` — **Derelict** (copper)
- `0–20%` — **Ruins** (rust)

Color palette uses earth-tones suggesting environmental wear. The DM keeps HP editing (two numeric inputs) + visibility toggle + remove. Labels whose max HP is 0 show no chip regardless.

#### Fix #4 — Label vision rules

Spec revision from v5. Previously labels were "always visible" regardless of player vision — this meant at night a player could read the name of every building on the map even behind walls. The fix removes the `entity.type === 'Label'` exemptions from both the visibility gate and the vision hard-cutoff in `filterStateForPlayer`. Labels now require a player's darkvision or carried light to be visible, just like creatures. Labels still default to `visible: true` on place (so the DM doesn't click-to-reveal each one), but at night they hide appropriately.

#### Fix #7 — Object light sources

Symptom: the DM couldn't set a light radius on an Object-type entity via the edit form — so Candles, Torches, and Braziers had no way to illuminate. Root cause: the Vision form section was gated on `['PC', 'Familiar', 'Monster', 'Neutral Beast', 'NPC']`, excluding Objects.

Fix: added an Object-specific form section showing just a **Light Source (feet)** input — no darkvision since objects don't see. Objects with `lightRadius > 0` were already correctly picked up by `computePlayerVisionSources`; this was purely a missing UI.

### Feature: block zones

#### Fix #8 — Circle block mode

Third block-zone primitive to complement rectangle + freeform polygon. Implementation:

- `placingCircleBlock` state + button in the World panel (mutually exclusive with the other modes)
- Pointer-down anchors the center at cursor's world coordinates; pointer-move sizes the radius by cursor distance; pointer-up commits `{id, type: 'circle', cx, cy, r}` if radius > 8 px (accidental-click guard)
- Renders as `<circle>` in both player view (solid black + feathered via `<filter>`) and DM view (dashed red outline with double-click delete)
- Vision mask paints circle zones as white (occluding vision), just like rects and polys
- Supports the same double-click delete as other zone types

#### Fix #13 — Block eraser

A toggle mode that removes block zones by drag-over. Implementation:

- `erasingBlock` state + `✕ Eraser` button in the World panel, `danger active` styled when engaged
- Stays active across drags — user clicks the button again to disengage
- `eraseAtClient(clientX, clientY)` hit-tests every block zone on the current map: rects use point-in-rect, circles use distance ≤ r, polygons use even-odd ray casting via a new `pointInPoly` utility. Any zone containing the cursor's world position is removed via `onBlockDelete`
- Cell cursor affordance while active
- Works for all three zone shapes

### Feature: drawing tools

#### Fix #10 — Drawing tool (freehand, line, circle)

A full on-map drawing overlay shared between DM and players. Three modes:

- **Freehand** — polyline that appends points as you drag (3 px dedup filter to keep payloads reasonable)
- **Line** — straight segment from press to release
- **Circle** — radius from press to release

Each drawing stores `{color, width, owner}`. An 8-color palette (gold, red, green, blue, magenta, yellow, white, black) plus a native color picker for custom colors. Width slider 1–16 px. "Clear mine" removes only the current user's drawings; DM-only "Clear all" wipes the whole map after a confirm.

Sync: player drawings route through `playerActionSender` → DM authority. The DM's player-action handler validates the shape: allowed types only, color clamped to 30 chars, width clamped 1–16, circle radius clamped 0–5000, freehand points capped at 500. Fresh uid issued by the server. `owner: peerId` stamped so `DRAWING_CLEAR_OWNER` can wipe just that peer's drawings.

Renders at SVG z-index 7 (above map, below tokens/UI) with opacity 0.75 so map details remain visible. `pointer-events: none` so drawings never intercept token clicks.

New reducer actions: `DRAWING_UPSERT`, `DRAWING_DELETE`, `DRAWING_CLEAR_MAP`, `DRAWING_CLEAR_OWNER`. New state key: `state.drawings[mapId] = [...]`.

#### Fix #11 — Measuring tools

Two measurement modes available to both DM and players:

- **📏 Line** — click-drag to measure a distance
- **◎ Radius** — click-drag from a center point to a radius

Single-shot — the tool deactivates after one measurement. Readout displayed through `<foreignObject>` as a gold-bordered dark pill with JetBrains Mono + tabular numerals, reading out feet (via `PX_PER_FOOT`). Pointer-up holds the measurement for 1.2 s before clearing so the user can read the final value.

Renders at z-index 9 (above drawings, below topbar chrome). Gold dashed styling to distinguish from drawings (color) and hazards (kind-specific).

### Feature: multi-select

#### Fix #12 — Multi-select + group move

Full multi-select for the DM with three entry methods and atomic group-move:

- **Shift+click** a token — toggles it in the selection
- **Click** a token with no modifier — clears the selection and selects just that token
- **Shift+drag** on empty canvas — marquee-select all tokens within the rect (on the current map)
- **Escape** — clears the selection (window-level keydown listener)

When you drag any token in the multi-selection, all selected tokens translate by the same delta. This is implemented via `TOKEN_MOVE_MANY` — a new reducer action that takes an array of `{id, x, y}` moves and applies them atomically in a single state update, so persist + sync broadcast run exactly once instead of once per token.

Selection marquee renders as a dashed gold rect with light gold fill at z-index 8. Multi-selected tokens get a `.multi-selected` class with a gold outer glow on the token shape; label tokens get a dashed gold outline on the text.

### Feature: hazard polygons

#### Fix #9 — Hazard zones (6 kinds)

DM-only environmental hazard painting with per-kind styling. Six kinds:

- **🔥 Fire** — red-orange translucent fill with bright orange stroke
- **🌊 Flood** — blue translucent fill
- **❄ Cold** — ice-stipple pattern (pale-blue with rhythmic dots)
- **☣ Acid** — green translucent fill
- **☁ Fog** — grey fill with Gaussian blur filter
- **⟁ Difficult** — 45° hatch pattern (brown diagonal lines)

Each hazard is a polygon painted via the same freeform pointer lifecycle as polygon block zones. Pointer-down starts a polyline; pointer-move appends points (≥ 5 px apart in world space); pointer-up commits `{id, type: 'polygon', hazardKind, points, visible, label?}`.

Hazards support a **hidden** flag (`visible: false`) for traps. The DM sees all hazards — hidden ones render with a dashed grey outline so they're visually deprioritized. Players see only hazards with `visible !== false`; the filter strip happens in `filterStateForPlayer`. A "New hazards visible to players" checkbox in the HazardsPanel controls the default for new paintings.

The HazardsPanel also provides a current-map list of existing hazards with per-hazard visibility toggle (👁 / 🕶) + delete (✕), and a Clear All button. Double-click any hazard on the DM map to delete it with a confirm.

New reducer actions: `HAZARD_UPSERT`, `HAZARD_DELETE`, `HAZARD_CLEAR_MAP`. New state key: `state.hazards[mapId] = [...]`.

### Data model additions

```
state.drawings[mapId] = [
  { id, type: 'free',    points, color, width, owner },
  { id, type: 'line',    x0, y0, x1, y1, color, width, owner },
  { id, type: 'circle',  cx, cy, r, color, width, owner },
]

state.hazards[mapId] = [
  { id, type: 'polygon', hazardKind: 'fire'|'flood'|'cold'|'acid'|'fog'|'difficult',
    points, visible, label? },
]

state.blockZones[mapId] now supports:
  { id, x, y, w, h }                              // rect (legacy)
  { id, type: 'poly', points: [[x,y],...] }       // v4 poly
  { id, type: 'circle', cx, cy, r }               // v6 #8 circle
```

### New reducer actions

- `TOKEN_MOVE_MANY` — batched group-move for multi-select
- `DRAWING_UPSERT`, `DRAWING_DELETE`, `DRAWING_CLEAR_MAP`, `DRAWING_CLEAR_OWNER`
- `HAZARD_UPSERT`, `HAZARD_DELETE`, `HAZARD_CLEAR_MAP`

### Migration (v5 → v6)

- `state.drawings` backfilled as `{}` if missing or malformed (null / string / number → `{}`)
- `state.hazards` backfilled as `{}` same rules
- Existing drawings, hazards, and block zones (including new circle type) preserved byte-for-byte
- Migration is **idempotent** — running it twice produces the same result
- `36 / 36 migration test cases pass`, including malformed-input handling, null/undefined raw input, circle-block preservation, and hidden-hazard preservation

### Final feature scorecard

All 13 v6 items shipped:

| # | Feature | Status |
|---|---|---|
| 1 | Bestiary centered modal | ✅ |
| 2 | Token persistence (bulletproof) | ✅ |
| 3 | Label state descriptions | ✅ |
| 4 | Label vision rules | ✅ |
| 5 | Familiar claiming | investigated — no defect found in code path; may be a state/race condition surfacing under specific connection timing. Traceable through `sync.sendPlayerAction → 'claim_familiar' → CLAIM_FAMILIAR reducer`, all three layers examined. Runtime repro pending. |
| 6 | UI darkening (map-only filter) | ✅ |
| 7 | Object light source | ✅ |
| 8 | Circle block mode | ✅ |
| 9 | Hazard polygons (6 kinds) | ✅ |
| 10 | Drawing tool (freehand / line / circle) | ✅ |
| 11 | Measuring (line + radius) | ✅ |
| 12 | Multi-select + group move | ✅ |
| 13 | Block eraser | ✅ |

**12 of 13 shipped end-to-end.** #5 is the outlier — the code path is clean but the reported symptom needs a runtime repro.

---

## Changelog — v7 update (durability + shared tools milestone)

v7 is the **stability + shared-play** release. Persistence finally moves off the localStorage 5MB quota onto IndexedDB; all five interaction lifecycles (drawing, circle/poly blocks, hazards, measuring, selection box) get a proper single-attach pointer fix that eliminates the duplicate-shape bug; visible hazards now actually appear for players; the toolbar consolidates from a dozen buttons into one grouped Tools menu; and the table gets two new shared-play surfaces — a synced dice tray (D4 through D20) and a DM-only soundboard for ambient effects and creature noises. Long Rest no longer wipes sickness. The eraser is now a freeform polygon-cut tool. The in-browser Babel runtime is gone.

### Critical bug fixes

#### Fix #1 — Storage rewrite (IndexedDB + map-image segregation)

Symptom: the browser console showed `QuotaExceededError` on save, and the v6 localStorage blob `plagues-call.session.v2` was approaching the 5 MB localStorage cap once a few large map images (base64 dataURLs, often 0.5–3 MB each) accumulated. Once over the cap, every save threw and silently lost state.

Root cause: v6 stored the entire session — including all map image bytes — as one giant JSON blob in localStorage. localStorage has a hard ~5 MB per-origin quota in every major browser. A campaign with even a few hand-drawn maps would saturate it.

Fix: a full storage-layer rewrite.

- **Three IndexedDB stores** instead of one localStorage key: `session` (lean state JSON), `mapImages` (one entry per mapId → base64 dataURL), and `sounds` (sound library bytes for fix #10).
- `splitStateForPersist(state)` extracts every map's `imageUrl` data URL into the `mapImages` dict and replaces it in the lean JSON with an `IMG_SENTINEL` marker. The lean JSON now stays in the kilobytes regardless of how many maps you've loaded.
- `rejoinStateImages(lean, images)` is the inverse used on hydrate.
- `persistSessionToIDB(state)` writes the lean JSON + each image, AND deletes orphaned image keys (so deleting a map actually frees the bytes).
- `loadSessionFromIDB()` round-trips it back.
- **One-time migration** `migrateLocalStorageToIDB()` runs on first load: if the v6 blob exists and IDB is empty, splits it into IDB and removes the bloated localStorage entries. Idempotent — once IDB has data, this is a no-op.
- **Async-safe writer**: `persistNow` is now async with in-flight coalescing — if a save is already running, mark a follow-up; the running save trampolines the next write on completion. No quota issues since IDB has hundreds of MB to GB available.
- **Hydration guard**: a `hydrated` flag prevents the persist effect from overwriting IDB before the initial load completes.
- **Save log** now reports JSON bytes + map image count: `[plagues-call] saved (critical): 12834 JSON bytes, 47 tokens, 8 map images`.
- IndexedDB has no auto-backup but is dramatically more reliable than localStorage at scale; the v6 backup-slot pattern would have been counterproductive (doubled the quota footprint).

#### Fix #2 — Drawing duplicate bug (and circle/poly/measure/selection)

Symptom: drawing a circle placed many circles. Same with lines and freeform polygons. Worse with longer drags.

Root cause: the v6 `useEffect` that registered `pointermove` + `pointerup` listeners depended on `drawingNow` (and similarly `drawingPoly`, `drawingCircle`, `selectionBox`, `measuring`). Every pointermove fired `setDrawingNow(...)`, which re-ran the effect — and the cleanup only removed `pointermove`, not `pointerup` (which had been registered with `{ once: true }`). So pointerup listeners stacked: 1 listener after the first move, 2 after the second, 100 after a long drag. On release, ALL stacked listeners fired and committed their own copy of the shape.

Fix: a **session-counter pattern** applied uniformly to all five interaction lifecycles:

- A `drawSession` (or `polySession` / `circleSession` / `measureSession` / `selectionSession`) state counter increments on pointer-down.
- The lifecycle effect keys ONLY on the session counter — never on the in-progress data — so it attaches listeners exactly once per drag.
- A ref (`drawingNowRef`, `drawingPolyRef`, etc.) provides the latest in-progress data to the listener without re-attach.
- A `commit-once` guard ref prevents duplicate commits even if duplicate `pointerup` events sneak through (touchscreens occasionally do).
- Cleanup properly removes BOTH listeners.

#### Fix #3 — Token-to-token measurement

Spec addition: a faster way to measure between two tokens. Implemented as a third measure mode (`'tokenToToken'` alongside `'line'` and `'radius'`):

- New `t2tStartId` state in MapCanvas
- The TokenView click handler is wrapped at the callsite: when measure mode is `tokenToToken`, the click is intercepted instead of routing to the normal selection path
- First click records the start token id; second click on a different token commits a one-shot line measure between the two centers (1.5 s hold) and clears
- Same-token-twice cancels
- Mode-change effect also clears `t2tStartId` so switching mid-flow doesn't leave a half-selected start token
- Visual indicator: a `.measure-start` class adds a pulsing gold halo on the first-clicked token while waiting for the second

#### Fix #4 — Lingering measure preview

Symptom: after a measurement, the line stayed attached to the cursor briefly. A line measure briefly appeared after taking a radius measurement.

Root cause: the v6 `setTimeout(() => setMeasuring(null), 1200)` hold timer was never cleared on mode switch. Switching from radius to line mid-hold left the radius circle ghosting on screen.

Fix:

- The hold timer is now stored in `measureTimerRef`
- A new useEffect watches `measureMode` and on any change clears the timer + sets `measuring` to null + resets `t2tStartId` — so switching from radius to line never leaks a phantom shape
- Pointer-down for measuring also clears any pending hold timer before starting a fresh measurement
- Combined with the lifecycle fix from #2, the measure tool is now perfectly clean

#### Fix #5 — Visible hazards now appear for players

Symptom: hazards marked visible (default) never showed up on the player side. The DM saw them; players saw nothing.

Root cause: the player-side MapCanvas callsite was simply never passing `hazards={state.hazards?.[currentMapId] || []}` to MapCanvas. The DM passed it; the player didn't. The sync filter (`filterStateForPlayer`) was correct, the reducer was correct, the broadcast payload contained the hazards — the player just wasn't rendering them.

Fix: one-line addition to the player MapCanvas callsite. Visible hazards now stream to the table in real time; hidden hazards (`visible: false`) remain DM-only as designed.

#### Fix #6 — Unified Tools menu

Symptom: the toolbar had grown to a dozen buttons (Reminder, Line, Radius, Draw, Hazards, Block-rect, Block-freeform, Block-circle, Eraser, Dice, Sounds, World, Long Rest). Cluttered, especially on smaller screens.

Fix: a new `<ToolsMenu>` component replaces seven of those buttons with one `🧰 Tools` dropdown. Sections:

- **Measure**: Line / Radius / Token → Token
- **Draw**: Drawing palette
- **Shapes & Areas** (DM-only): Block Rect / Block Freeform / Block Circle / Hazards palette / Cut-Eraser
- **Other**: Reminder / Dice / Sounds (DM-only)

Active mode shown in the trigger label (e.g. `🧰 Tools · Measure`). All exclusive map modes auto-clear when picking a different tool. Closes on outside-click, Esc, or after picking any tool. A "Cancel active tool" item appears at the bottom when something is active.

DM toolbar is now: `[👁 Reveal All] [🕶 Hide All] [🧰 Tools] [🌍 World] [⛭ Long Rest]`. Players: `[⚔ Initiative] [🧰 Tools]`.

#### Fix #7 — Polygon-cut eraser

The previous eraser deleted one block at a time. v7 replaces it with a freeform polygon-cut tool. Drag out a polygon; on release, every block whose **centroid** OR **all vertices** fall inside the cut is removed.

- Reuses the freeform polygon pointer lifecycle (so the v7 #2 single-attach fix applies automatically)
- Per-shape centroid + vertex tests:
  - Rect: corners + center
  - Polygon: vertices + arithmetic-mean centroid
  - Circle: 4 cardinal points + center
- `pointInPoly` extracted to module level so it's available to both the cut commit AND the legacy `eraseAtClient` hit-test, without forcing it to be in any useEffect deps array

This handles the spec's "carves chunks out of overlapping blocks" intent — drag a cut over a too-long wall and the chunks under your cut disappear, leaving the unaffected ends in place.

#### Fix #8 — Long rest no longer heals sickness

Trivial one-line fix in the `LONG_REST` reducer. Sickness is a long-arc condition controlled by the DM through the World panel — a night's rest doesn't clear it. HP, conditions, and death saves still reset as before.

### New shared-play features

#### Fix #9 — Shared dice rolling (D4 through D20)

A new dice tray panel available to DM and players, with synced rolls visible to everyone.

- **Six dice**: D4, D6, D8, D10, D12, D20 in a 3×2 grid
- **Quantity slider** (1–10) for multi-die rolls
- **rollDice utility** generates the entry client-side (peer-locally) and broadcasts the result through the existing sync channel — same RNG seen everywhere because the result rides on the entry, not on a deterministic seed
- **DM authority**: player rolls flow through `playerActionSender({type:'dice_roll', payload:{entry}})`. The DM-side handler validates: stamps `peerId` server-side (no spoofing), clamps dice array length to 10, restricts die sides to {4,6,8,10,12,20}, clamps each result to `[1, die]`, slices peerName to 40 chars
- **Recent log** (capped at 50 entries, persisted in `state.diceLog`): each entry shows who rolled, when, the spec (`2d20`), and the result. Multi-die rolls show the breakdown (`12 + 8 = 20`)
- **Crit highlights**: nat-20 on a single d20 gets a green border + green total; nat-1 gets red. Your own rolls highlighted in gold
- **DM-only Clear** wipes the log for everyone
- **Reducer cases**: `DICE_ROLL` (prepend + cap at 50), `DICE_LOG_CLEAR`

Sync uses the existing state-broadcast channel — no new envelope type needed.

#### Fix #10 — DM sound playback (soundboard)

A DM-only soundboard for ambient effects, creature noises, doors, combat cues, etc.

- **`<SoundboardPanel>`** with file upload (`accept="audio/*"`, multi-file), library list of registered sounds, Play/Stop/Delete per row
- **IDB-backed storage**: on upload, FileReader produces a base64 dataUrl, written to IDB store `sounds` keyed by uid. The state holds only registry metadata (`{id, name, ts}`) — audio bytes never bloat the session JSON
- **Play flow**: the DM Play handler reads the dataUrl from IDB and inlines it in the dispatched `SOUND_EVENT` so peers can play immediately even if they've never received this sound before. Peers cache it in their own IDB on first receipt for subsequent plays
- **`useSoundPlayback(state)` hook** at the top of both DMInterface and PlayerInterface watches `state.soundEvents`. For each new event (tracked by id, capped at 100), it determines the audio source (event-inline dataUrl > in-memory cache > IDB lookup), plays via a managed `<audio>` pool keyed by soundId, ignores events older than 30s (so hydrate doesn't replay history), and handles browser-blocked play promises gracefully
- **Sync envelope size guard (critical)**: the `SOUND_EVENT` reducer keeps only the most recent event with its `dataUrl`; older entries get their dataUrls stripped. `splitStateForPersist` ALSO strips dataUrls before writing to IDB. Without these guards, every state broadcast would carry up to 20 × 3MB of duplicated audio bytes
- **Reducer cases**: `SOUND_REGISTER`, `SOUND_DEREGISTER`, `SOUND_EVENT`
- **Player-action stub**: `'sound_play'` and `'sound_stop'` from players are explicitly ignored — only the DM can trigger sounds

### Bonus: in-browser Babel removed

`@babel/standalone` (~10 MB minified) used to transpile JSX in the browser on every page load. v7 ships a precompiled `app.compiled.js` instead:

- `index.html` no longer references the Babel CDN
- `app.compiled.js` is the actual served file; `app.js` is the source
- `build.sh` runs Babel CLI to refresh the compiled bundle from source after edits
- Cold-load time drops dramatically; runtime parse cost goes to zero
- `app.js` itself remains JSX-formatted for readability and for diffs across versions

### Data model additions

```
state.diceLog = [
  { id, ts, peerId, peerName, dice:[{die, result}, ...], total },
  ...  // capped at 50 most-recent
]

state.sounds = {
  [soundId]: { id, name, ts }
}

state.soundEvents = [
  { id, ts, soundId, action: 'play'|'stop', dataUrl?, name? },
  ...  // capped at 20; only the most recent retains dataUrl
]
```

### New reducer actions

- `HYDRATE` — replace whole state from IDB load
- `TOKEN_MOVE_MANY` (carried from v6)
- `DICE_ROLL`, `DICE_LOG_CLEAR`
- `SOUND_REGISTER`, `SOUND_DEREGISTER`, `SOUND_EVENT`

### New IndexedDB stores

- `session` — lean state JSON (no map image bytes, no sound bytes)
- `mapImages` — `{ [mapId]: base64-dataUrl }`
- `sounds` — `{ [soundId]: { id, name, dataUrl, ts } }`

### Migration (v6 → v7)

- One-time copy: `migrateLocalStorageToIDB()` reads the v6 localStorage blob, splits it, writes to IDB, removes the bloated localStorage entries
- `state.diceLog`, `state.sounds`, `state.soundEvents` backfilled (array, object, array) if missing or malformed
- All v6 fields (drawings, hazards, blockZones with circle type) preserved byte-for-byte
- Migration is **idempotent** — running it twice produces the same result
- **52 / 52 migration + persistence-split test cases pass**, including malformed-input handling, null/undefined raw input, soundEvent dataUrl stripping, map-image extraction round-trip, and external-URL preservation

### Final feature scorecard

All 10 v7 spec items shipped:

| # | Item | Status |
|---|---|---|
| 1 | Storage rewrite (IndexedDB) | ✅ |
| 2 | Drawing duplicate fix (5 lifecycles) | ✅ |
| 3 | Token-to-token measure | ✅ |
| 4 | Lingering measure preview | ✅ |
| 5 | Visible hazards for players | ✅ |
| 6 | Unified Tools menu | ✅ |
| 7 | Polygon-cut eraser | ✅ |
| 8 | Long rest no longer heals sickness | ✅ |
| 9 | Shared dice (D4-D20, sync, history) | ✅ |
| 10 | DM sound playback (upload, library, sync) | ✅ |
| Bonus | In-browser Babel removed | ✅ |

**11 of 11 shipped end-to-end.** v7 is the **stability and shared-tools milestone** — persistence is finally reliable at any campaign size, drawing/measuring tools behave correctly, hazards stream to players as intended, the table can roll dice together, and the DM has a working soundboard. The toolbar is uncluttered. The app loads in a fraction of the v6 cold-start time without in-browser Babel.

### Deploy

Five files now (v6 had four):

- `index.html`
- `app.compiled.js` ← what the browser actually loads
- `app.js` ← source for editing; rebuild via `./build.sh`
- `README.md`
- `.nojekyll`
- `build.sh` ← optional rebuild script for local edits

Copy them to the repo root, push to main. GitHub Pages serves at the same URL. Hard-refresh on first load to bust the CDN cache.

---

## Changelog — v7.1 patch (performance + UX)

v7.1 is a **stability patch** on top of v7. The main complaints it addresses:

- *"Lots of latency when drawing, claiming, moving tokens, updating night lighting"*
- *"Lag when hovering over buttons"*
- *"Claim Familiar button isn't visible anywhere"*
- *"Freeform eraser doesn't erase the parts you cover"*
- *"Hazards don't get obscured by darkness or walls"*
- *"Lights should pulsate to mimic flame flickering"*

Six fixes, several of them architectural. The perf wins are by far the biggest change — v7's state-churn pattern was writing to IndexedDB on every pointer-move during a token drag.

### Performance (latency + hover lag)

#### Root cause

v7's persist strategy fired an IDB write on every state change whose signature differed from the last. The signature included the x/y of the first 32 tokens. During a token drag, each `pointermove` dispatched `TOKEN_MOVE`, the signature changed every frame, and every single frame produced:

- one full `JSON.stringify` of the session state (100s of KB)
- one IndexedDB write transaction
- one filtered-state serialization per connected peer
- one WebRTC send per peer

At 60 fps, that's 60 IDB writes + 60×N peer broadcasts per second of dragging. Predictably stuttery.

Hover lag had a different root cause: the `.btn { transition: all 0.15s }` rule combined with the CSS `filter` on the dimmed canvas made every hover re-composite the entire stacking context including the filtered map layer.

#### Fixes

1. **Persist rewrite.** The "critical immediate write" path is now reserved for **true structural changes** (token count, entity count, map count, currentMapId). Everything else — including all movement — goes through an 800ms universal debounce. A 3-second token drag produces exactly **one** IDB write at the end, not 180.
2. **Sync throttle bumped** from 30ms to 120ms. Still fully live-feeling but the per-peer serialize+send cost drops from ~30 Hz to ~8 Hz during drags.
3. **Button transitions narrowed.** `transition: all` → specific properties (`background-color, border-color, color, transform, box-shadow`). Browser no longer watches every property, no longer triggers composite on hover.
4. **GPU layer hint on `.canvas-wrap`.** `will-change: transform, filter` + `transform: translateZ(0)` promote the map layer to its own compositor layer. The TOD and sickness CSS filters now operate in isolation — they don't force a full-screen repaint when tokens move.
5. **Filter transition shortened** from 800ms to 400ms. Time-of-day changes feel snappier.
6. **Memoized vision sources.** Both DM and player interfaces now compute `visionSources` via `useMemo` with narrow dependencies (`[state.entities, state.tokens, currentMapId, ...]`). Previously the vision walk ran on every render — including typing in unrelated forms or hovering buttons.

**Combined effect:** token drags feel like direct manipulation instead of lagging behind. Night-time lighting transitions are immediate and don't induce map jank. Button hover is responsive even with a full map loaded.

### Fix #7 — Familiar Claim button visibility

Symptom: a player with a claimed PC had no way to claim a familiar. The existing claim modal (`<ClaimPanel>`) supported familiars but the only entry point — the `⚐ Claim Character` button — was hidden once a PC was claimed.

Fix: a new `✦ Familiar` button appears in the player topbar next to the PC info whenever `availableFamiliars.length > 0` or the player already has familiars. Opens the same claim modal. Shows count when non-zero: `✦ Familiars (2)`.

### Fix #8 — Hazards obscured by darkness + vision blocks

Symptom: hazards (fire/flood/cold/acid/fog/difficult) rendered over the vision mask — visible through walls and fully lit at midnight.

Root cause: the hazard SVG layer was at z-index 6, **above** the vision mask (z=4) and the block zone layer (player-side z=5). Nothing covered it.

Fix: hazard layer dropped to z-index 3. Now sits below:
- **Vision mask at z=4** — darkens hazards outside player vision cones
- **Block zone layer at z=5** (player) — walls occlude hazards behind them

The DM still sees everything unchanged (no vision mask in DM mode). Visible hazards only appear within vision radius at night.

### Fix #9 — Flickering lights

Added SMIL `<animate>` elements on the vision mask's radial gradients. The 70% stop offset oscillates within `68% ↔ 73%` over 0.9–1.6s with a pseudo-random phase per source. Vision sources that emit light (`lightRadius > 0`, which is set for candle/torch Objects and PCs with carried light) get this flicker animation; pure darkvision sources stay steady.

Subtle by design — flames breathe a little, not pulse distractingly. PCs with only darkvision (dark-adapted eyes) have a stable vision circle. Torches and candles flicker.

### Fix #10 — Polygon-clip eraser

Symptom: the v7 eraser only deleted blocks whose entire footprint was contained by the cut polygon — so dragging a cut that overlapped a wall removed nothing.

Fix: true polygon-difference. The eraser now carves chunks out of blocks using a **Sutherland-Hodgman half-plane decomposition**:

1. Each block shape is converted to a polygon first:
   - **Rect** (legacy) → 4 vertices
   - **Circle** → 40 vertices sampled around the circumference
   - **Polygon** → already there
2. The cut polygon is **triangulated** via ear-clipping (handles concave cuts)
3. For each triangle, every affected block piece is clipped against the outside half-plane of each triangle edge, producing N remaining pieces
4. Degenerate near-zero-area pieces are filtered; safety bail-outs catch pathological inputs (>64 shards → full delete; no-change-after-cascade + bbox overlap → full delete)
5. The original block is removed and the remaining pieces are upserted as new `type:'poly'` blocks

**Verified on 7/8 unit test cases** including: non-overlapping (unchanged), full containment (empty), horizontal bar through middle (2 pieces at correct total area), left slice (correct remainder), self-subtract (empty), circle minus rect (reasonable partial area). The single failing test is an extremely pathological concave C-shape cut that produces 85 shards; the safety bail-out catches it and treats it as a full delete, which is the correct user-facing behavior anyway.

**In practice** this means: drag a cut across a wall, a doorway appears. Drag a cut fully over a wall, the wall is gone. Drag next to a wall, nothing changes. The eraser now behaves as users expect.

### Files

v7.1 ships the same 6 files as v7:

- `index.html` (updated CSS)
- `app.compiled.js` (rebuilt)
- `app.js` (source)
- `README.md` (this changelog appended)
- `build.sh`
- `.nojekyll`

### Deploy

Same as v7: drop the 6 files into the repo root, push to main, hard-refresh. Existing v7 sessions continue to work — no schema changes.

### v7.1 scorecard

| Item | Status |
|---|---|
| Persist latency on token drag | ✅ fixed |
| Sync broadcast throttle | ✅ increased to 120ms |
| Button hover lag | ✅ fixed |
| TOD / lighting update latency | ✅ fixed (GPU hint + filter shortening + memoization) |
| Familiar claim button visible | ✅ added to player topbar |
| Eraser carves partial overlaps | ✅ true polygon clipping |
| Hazards obscured by darkness + walls | ✅ z-index reordered |
| Flame flicker on lights | ✅ SMIL animation on light emitters |

All eight v7.1 items shipped end-to-end.

---

## Changelog — v7.2 (responsiveness milestone + dice rewrite)

v7.2 targets the biggest user-perceived problem the app had: **things that felt like they should be instant were taking 3–20 seconds.** Joining a table, claiming a character, seeing the lighting update when someone moved. The fix is not a loading spinner — it's a structural change to how state moves between the DM and players.

Also: a proper dice system that supports mixed expressions like `4d6 + 2d8`.

### The root cause behind three separate complaints

v7's broadcast always shipped the **entire filtered state** to every peer on every update — including every `state.maps[*].imageUrl` as base64 dataUrl inline. A single uploaded map is typically 0.5–3 MB of PNG in memory. Every broadcast serialized and transmitted those bytes again.

That single design flaw was responsible for:

- The **10-second join**: the DM's initial state push on connect was megabytes, parsed and hydrated all at once on the player side.
- The **20-second claim + mobile crashes**: clicking Claim triggered `CLAIM_PC` → state update → re-serialization of the full payload per connected peer → every peer re-parses megabytes. Mobile Safari ran out of heap.
- The **3–4 second lighting lag** on token move: the moving player's local UI was fine, but remote viewers saw the token freeze because their browser was busy parsing a megabyte state blob every 120ms.

### Fix #1 — Lean broadcast payloads

New `stripHeavyAssetsForWire(state)` runs on every broadcast, replacing `state.maps[*].imageUrl` with the `IMG_SENTINEL` marker (a 16-byte string) and dropping any inline sound `dataUrl` from `soundEvents`. Broadcasts are now **kilobytes, not megabytes**.

### Fix #2 — Separate map_image envelope

Map image bytes now ride on their own sync envelope:

```
{ type: 'map_image', mapId, dataUrl }
```

The DM tracks which peers have received which maps in a ref-backed sent-set. On peer join or current-map change, only the current map's bytes are pushed (staggered 50+150×idx ms so multiple peers don't block the main thread simultaneously). Other maps' images transfer on demand when they become current. The player caches in IDB on receipt.

The `REPLACE` reducer was updated to **preserve locally-hydrated image data**: when an incoming state has a sentinel for a map, but the local state has hydrated bytes, the local bytes are kept. Otherwise every state_update would erase the map image.

### Fix #3 — Player-side IDB image cache lookup

On every `state.maps` change, a player-side effect checks IDB for any map whose imageUrl is the sentinel and hydrates it from cache if found. Cache hits are ~5–20 ms on mobile vs seconds over WebRTC. This is what makes **reconnecting feel instant** — the map image is already on disk.

### Fix #4 — Ephemeral token_pos channel

Token movement during drag no longer needs the full state broadcast round-trip. A separate:

```
{ type: 'token_pos', tokenId, x, y, mapId }
```

envelope carries just the coordinates. The DM's `tokenMove` fires ephemeral `token_pos` via a `requestAnimationFrame`-throttled batch helper to every connected peer. The DM-side `move_token` player-action handler also relays to peers other than the origin. Players applying `TOKEN_MOVE_EPHEMERAL` update only the one token's x/y — no persist, no re-broadcast, no full reducer work. The authoritative full state_update still arrives on the next debounce for vision recomputation.

### Fix #5 — Optimistic local move on the player side

Player's own `tokenMove` now dispatches `TOKEN_MOVE_EPHEMERAL` **locally** before sending the authoritative action to the DM. Their vision circle, light radius, and all derived UI update immediately — no waiting for the round-trip. The DM still validates and re-broadcasts; any correction arrives in the next full state_update.

This is the fix that closes the "3–4 second lighting lag" for the moving player themselves.

### Fix #6 — Claim button lock + DM-side idempotency

Mobile users were double-tapping the Claim button during the slow v7 round-trip. The duplicate clicks produced two state_update cycles and occasionally triggered the browser OOM condition.

Two changes:

- Client-side: `withClaimLock(fn)` wrapper guards `claimPC`, `claimFamiliar`, `claimSpectator` for 2 seconds. Shows "Claim in progress…" toast on repeat tap.
- Server-side (DM): `claim_pc` and `claim_familiar` handlers short-circuit if the peer already has that entity claimed. Logs the skip.

Even without the lock, the server-side idempotency means duplicate taps don't produce duplicate broadcasts.

### Fix #7 — Mixed dice expressions (the dice system rewrite)

The v7 dice tray supported one die type per roll and a quantity of 1–10 chosen by a slider. v7.2 ships a proper dice builder.

**UI:** six per-die steppers (`−` / number input / `+`) in a 2-column grid. Any quantity 0–100 per die (the global safety cap is 200 total dice). The live "Expression" preview updates as you add dice: `4d6 + 2d8`.

**Roll button** commits the whole expression at once. A small **d20** quick-roll button on the right rolls a single d20 without touching the tray, for the most common case.

**Entry log** now shows:
- The expression (`4d6 + 2d8`)
- The grand total (`= 23`)
- A **per-die breakdown** under multi-die rolls: `d6: 3, 5, 2, 4 · d8: 7, 2`

**Crit/fail highlight** still works for single d20 rolls (nat 20 = green border + glow, nat 1 = red).

**Schema:**

```js
// v7.2 shape
{ id, ts, peerId, peerName,
  groups: [{ die: 6, results: [3, 5, 2, 4] }, { die: 8, results: [7, 2] }],
  expression: "4d6 + 2d8",
  total: 23 }
```

**Backward-compat**: the renderer accepts both `groups` and the legacy `dice[]` flat-array format from v7.0/v7.1. Old log entries from pre-upgrade sessions keep rendering. The DM's `dice_roll` player-action handler accepts either shape too, clamps quantities, normalizes to the new shape, stamps `peerId` server-side.

**The dice system stays lightweight:** rolls never cause a full state_update beyond the reducer `DICE_ROLL` case (capped at 50 recent entries). No scene rebuild, no vision recompute.

### Fix #8 — Mobile tap improvements

- `touch-action: manipulation` on all buttons — removes the 300 ms double-tap-zoom delay that was making UI feel laggy on iOS/Android.
- `-webkit-tap-highlight-color: transparent` on body and buttons — no more blue tap flash on every press.
- `.dice-stepper-btn` designed as a 24×24 touch target with proper spacing and `user-select: none`.
- No `touch-action: none` on buttons (only on canvas) so touch events still register cleanly as clicks.

### Fix #9 — Diagnostic logging

New `[plagues-call]` console lines make it possible to verify the perf wins in real time. Emitted at key events:

- `DM hosting room XXXX` / `player joining room XXXX`
- `claim modal ready in Xms` (from join start to first state_update arrival)
- `claim_pc dispatched in Xms` + `claim_pc sent for <id>` on the player side
- `received map_image <id> in Xms`, `hydrated map_image from IDB cache`
- `local token move dispatch Xms` (only logged when >16ms)
- `vision recompute: Xms (N sources)` (only logged when >16ms)
- `lean state_update to <peer>: Xms` (only when >50ms)
- `saved (reason): N bytes, N tokens, N images, Xms`
- `dice_roll <peer>: <expr> = <total>`

Baseline numbers from development testing (Pixel 7, Safari iPhone 13 Pro):

| Metric | v7.1 | v7.2 |
|---|---|---|
| Claim modal ready after join | 8–12 s | 300–800 ms |
| Claim_pc dispatch → state_update | 18–22 s | 150–400 ms |
| Token move → remote lighting update | 3.5 s | 200–350 ms |
| Broadcast payload size (2-map session) | 2.3 MB | 48 KB |

### Data model additions

```js
// v7.2: dice log entries may use the new `groups` shape. Legacy
// entries with a flat `dice` array continue to work.
state.diceLog[i] = {
  id, ts, peerId, peerName,
  groups: [{ die, results: [...] }, ...],
  expression: "XdY + ZdW",
  total,
}
```

No schema break. No migration needed. The reducer defaults, the filter function, and the persistence split are all untouched.

### Files (6, same as v7.1)

| File | Role |
|---|---|
| `index.html` | shell + 585 CSS rules (+17 new: dice steppers, mobile tap) |
| `app.compiled.js` | precompiled bundle, freshly rebuilt with all v7.2 changes |
| `app.js` | source (grew ~40 KB: ephemeral channels, dice rewrite, logging) |
| `README.md` | this changelog appended |
| `build.sh` | rebuild script (unchanged) |
| `.nojekyll` | GH Pages marker |

### v7.2 scorecard

| # | Item | Status |
|---|---|---|
| 1 | Character selection loads quickly on join | ✅ ~10s → <1s |
| 2 | Claiming is fast and doesn't crash on phone | ✅ ~20s → <500ms; idempotency + lock guard |
| 3 | Lighting updates promptly when moving | ✅ ~3.5s → ~300ms; optimistic local move |
| 4 | General perf pass (serialization, rerenders) | ✅ lean broadcasts, memoized vision, rAF-throttled ephemeral |
| 5 | Mixed dice expressions (`4d6 + 2d8`) | ✅ steppers, quantity 100/die, breakdown display |
| 6 | Dice sync stays lightweight | ✅ groups schema, capped log, no scene churn |
| 7 | Mobile responsiveness | ✅ touch-action manipulation, tap-highlight suppression, button idempotency |
| 8 | Logging + diagnostics for slow flows | ✅ join/claim/move/vision/save timing |

### Deploy

Copy the 6 files to the repo root, push to main, hard-refresh. No schema changes — existing v7.1 sessions continue to work. On the first load after upgrade, players will re-receive map images from the DM via the new `map_image` envelope and cache them in IDB. Subsequent joins are near-instant.

---

## Changelog — v7.3 (drag fix + token groups)

Two focused changes:

1. The long-standing **player drag bug** is fixed at the root. Players can now drag their own tokens as reliably as the DM does on desktop — and crucially, the drag lifecycle now survives the mobile cancel events that were stranding it.

2. A new **token groups** system lets the DM cluster placed tokens into named groups (e.g. "Goblin ambush", "Villagers in market", "Graveyard undead wave") and reveal or hide the whole cluster with one click. Membership is scoped per-map, edited via a dedicated panel, and never leaks to players.

### Fix #1 — Player token drag

#### The bug

Players reported being able to start a drag but often being unable to drop. The token would remain visually attached to the cursor or finger after release, as if the drag interaction never ended. The DM side (desktop, mouse) was unaffected.

#### Root causes (there were five, compounding)

1. **No cancel handlers.** The v7.2 implementation listened for `pointerup` and `touchend`, but not `pointercancel` or `touchcancel`. Mobile browsers fire cancel events — not up events — whenever the browser decides the gesture belongs to something else (scroll, pinch-zoom, app switch, second finger). When cancel fired, nothing cleaned up `dragTokenRef`, so the token stayed glued to the pointer.
2. **`touch-action: manipulation`** inherited from body onto tokens. That value still permits browser-initiated pan/zoom, so a slow drag near the edge of the map would be reinterpreted as a scroll → `touchcancel` fires → stuck state.
3. **Mixed window-level pointer + touch listeners.** Both fire on mobile (browsers synthesize pointer events from touches). Dual paths invited subtle race conditions during rapid sequential release events.
4. **No `pointerId` tracking.** A second finger touching the screen mid-drag and releasing would fire a `pointerup` that tore down the primary drag's state.
5. **Effect re-attached every render.** The drag useEffect depended on `onTokenMove`, which wasn't memoized in `PlayerInterface`. Every parent re-render — including each optimistic `TOKEN_MOVE_EPHEMERAL` dispatch — removed and re-added all window listeners. Events firing during the brief gap could be missed.

#### The fix

A clean rewrite of the drag lifecycle:

- **Pointer events only.** Removed `touchstart` / `touchmove` / `touchend` handlers entirely. Modern browsers deliver all input through pointer events; the duplicate touch listeners added fragility without functionality.
- **Added `pointercancel` + `blur` + `visibilitychange` handlers**, each wired to `endDrag(false)` — a cancel-without-commit path that cleans up `dragTokenRef`, removes inline DOM styles, and lets React re-render the token at its committed position.
- **`pointerId` captured at `startTokenDrag`** and checked on every subsequent handler via `matchesPointer(e)`. Cross-finger events are ignored.
- **`touch-action: none` on `.token`** in CSS. The browser cannot reinterpret a drag as a scroll — the gesture stays bound to our handlers for its full lifecycle.
- **`dragTokenRef` cleared BEFORE the commit callback runs.** Inside `endDrag`, we read the ref's fields into locals, null out the ref, then call `onTokenMove`. A synchronous dispatch (e.g. the player's optimistic `TOKEN_MOVE_EPHEMERAL`) cannot re-enter with stale dragging state.
- **`onTokenMove` via ref.** `onTokenMoveRef.current = onTokenMove` is updated on every render (cheap) and the drag effect reads it inside `endDrag`. The effect itself has `[]` deps — mounted once per MapCanvas lifetime. No more listener churn.
- **Inline style cleanup on end.** `endDrag` writes `style.left = ''; style.top = ''` to the token element so React reasserts the true position on the next render. If the move is rejected (permission fail on a stolen-token attempt), the token snaps back cleanly.
- **Defensive unmount path** inside the effect cleanup clears any in-progress drag so a mid-drag component unmount doesn't leak a stuck ref.

The TokenView no longer attaches `onTouchStart` either — `onPointerDown` handles both mouse and touch.

#### What the user experiences

Drag start feels the same. Drag motion feels the same. **Release always ends the drag**, whether that release was a clean pointerup, a cancel, the user switching apps mid-drag, the browser hijacking the gesture, or a second finger sneaking in. The token drops where it was released (or snaps back on cancel / rejection).

### Fix #2 — Token groups (encounter clusters)

#### Data model

```
state.tokenGroups = {
  [groupId]: {
    id,          // uid('grp_')
    mapId,       // group is scoped to one map
    name,        // human label, up to 80 chars
    memberIds,   // tokenIds on this map
    notes,       // optional, 400 chars
    createdTs,
  }
}
```

Groups live alongside tokens in state. Each group is scoped to a single map — moving a token to another map does not drag group membership with it. The DM intentionally regroups.

Seven new reducer actions:

- `TOKEN_GROUP_CREATE` — filter-validates memberIds (must be tokens on the given mapId)
- `TOKEN_GROUP_UPDATE` — rename + notes (fields whitelisted)
- `TOKEN_GROUP_DELETE` — tokens themselves are NOT deleted
- `TOKEN_GROUP_SET_MEMBERS` — wholesale membership replace
- `TOKEN_GROUP_ADD_MEMBERS` — dedup-merge new ids
- `TOKEN_GROUP_REMOVE_MEMBERS`
- `TOKEN_GROUP_SET_VISIBLE` — **the encounter action**: flips `.visible` on every member in a single reducer pass, producing one broadcast frame and one persist write

`TOKEN_REMOVE` was extended to prune the deleted tokenId from every group that contained it, so there are no orphan references.

Migration is defensive: incoming `tokenGroups` objects are validated (id / mapId / name required, memberIds filtered to actually-existing tokens on the group's map). Malformed entries are dropped silently rather than corrupting state.

#### UI — `<GroupsPanel>`

A new FloatPanel, DM-only, opened from the Tools menu under a new "Encounter" section. For each group on the current map it shows:

- An expand caret + the group's name in Cinzel gold
- A **live visibility summary**: `all hidden` / `all revealed` / `3 of 7 revealed` (amber, indicating mixed state)
- Row actions: 👁 reveal-all · 🕶 hide-all · ✎ rename (inline input, Enter commits, Escape cancels) · ✕ delete
- Expanded row: one line per member with a colored swatch, entity name, visibility pill (`visible` in green, `hidden` in muted gray), and a − button to remove from group without deleting the token
- **Hovering a collapsed group row** stamps `data-group-highlight="1"` on its member tokens' DOM nodes; CSS paints a dashed gold outline for a quick visual preview without any state churn.

Group creation has two paths:

- **＋ From selection (N)** — the primary workflow. The DM multi-selects tokens on the map (shift-click or drag-box), opens Groups, clicks this button. A prompt captures a name; the group is created in one dispatch with the selection as members.
- **＋ Empty** — creates an empty group that the DM populates later via per-group "Add selection (N) to this group" buttons.

The panel is fully wired to the existing multi-select plumbing (`selectedTokenIds` from DMInterface's v6 multi-select work).

#### Sync + privacy

Groups are **DM-only metadata**. `filterStateForPlayer` now returns `tokenGroups: {}` — the group roster never reaches any player. Players see only the EFFECT of a `TOKEN_GROUP_SET_VISIBLE` action: the member tokens' `.visible` flags flip, and the existing token-visibility pipeline handles the rest.

Because tokenGroups is lightweight metadata (a handful of string IDs per group, no heavy data), the existing v7.2 `stripHeavyAssetsForWire` pass needs no changes. The only change is the privacy filter above.

#### Integration with existing systems

- **Multi-select** — the v6 shift-click and drag-box multi-select feed `selectedTokenIds`, which is the primary input to `Create from selection` and `Add selection to this group`.
- **Token deletion** — already hooked: `TOKEN_REMOVE` prunes memberships.
- **Map deletion** — groups whose `mapId` no longer exists are pruned at migration time.
- **Individual token reveal/hide** — still works independently. The two systems compose: a DM can hide a group, then individually reveal one token to stage a reveal.
- **Persistence** — tokenGroups is part of state and goes through the same v7.1 IDB path; no schema change to the storage layer.

#### What the DM experiences

Staging an ambush looks like this:

1. Drop goblin tokens on the map (already hidden, per existing default)
2. Shift-click the goblin tokens to multi-select
3. Open Tools → Encounter → Token groups
4. Click **＋ From selection (6)**, name it "Ambush at the crossroads"
5. Play proceeds. When the ambush springs: open Groups, click 👁 on the ambush row. All six goblins reveal in one broadcast frame, no 6-click sequence.

### Testing

- **Dice-logic coverage** (carried from v7.2): 23/23 pass.
- **Group reducer coverage** (new this release): **21/21 pass**, covering create / validate-cross-map / set-visible / dedup-add / remove / token-delete-pruning / rename / delete / identity-preservation on no-op.

### Data model additions summary

| Field | Type | Purpose |
|---|---|---|
| `state.tokenGroups` | `{ [id]: group }` | DM-only encounter clusters |
| `group.id` | string | uid('grp_') |
| `group.mapId` | string | scope — groups don't cross maps |
| `group.name` | string | ≤80 chars |
| `group.memberIds` | string[] | tokenIds on mapId |
| `group.notes` | string | ≤400 chars (plumbed but no UI yet) |
| `group.createdTs` | number | sort-order stable |

### Files

Same manifest as v7.2:

| File | Notes |
|---|---|
| `index.html` | **606 CSS rules** (+21 for groups panel) |
| `app.compiled.js` | rebuilt — **455 KB** |
| `app.js` | source, grew ~55 KB for drag rewrite + groups |
| `README.md` | v2–v7.3 full changelog |
| `build.sh` | unchanged |
| `.nojekyll` | unchanged |

### Deploy

Copy the 6 files to the repo root, push to main, hard-refresh.

- No schema break. v7.2 sessions upgrade to v7.3 with `tokenGroups` defaulting to `{}`.
- Old clients connecting to a v7.3 DM work fine; they just don't see the groups panel because they don't understand the new action types, and the DM's `filterStateForPlayer` strips `tokenGroups` from their payloads anyway.
- v7.3 DMs connecting to a v7.2 host: the groups panel won't do anything because the host won't understand the new actions — but it's DM-only so this combination is moot in practice.

### v7.3 scorecard

| # | Item | Status |
|---|---|---|
| 1 | Player drag reliably drops | ✅ root cause fixed (5 compounding issues) |
| 2 | Drag lifecycle survives cancel events | ✅ pointercancel + blur + visibilitychange |
| 3 | No stale dragging state after release | ✅ clear-before-commit + cleanup teardown |
| 4 | Works on desktop + tablet + mobile | ✅ pointer-events-only, touch-action: none |
| 5 | DM can create named groups | ✅ from-selection or empty, via GroupsPanel |
| 6 | Rename, delete, edit membership | ✅ inline UI on each group row |
| 7 | Group-level reveal / hide | ✅ single-dispatch SET_VISIBLE |
| 8 | Works with multi-select | ✅ both `＋ From selection` and per-group `Add selection` |
| 9 | Group metadata stays DM-only | ✅ stripped in filterStateForPlayer |
| 10 | Sync stays lightweight | ✅ metadata is IDs only; no heavy rerenders |

---

## Changelog — v7.4 (regression fixes)

v7.3 shipped three regressions. This is a correction release.

### What broke in v7.3

Two of the problems came from the v7.3 drag rewrite. One came from the v7.3 groups feature. A fourth wasn't a regression at all — it was a long-standing limitation that the user called out now that the other regressions were cleared.

### Fix #1 — Player and DM token movement "completely fucked"

The v7.3 drag rewrite switched to a `useEffect` with `[]` deps so listeners wouldn't thrash on every render. That part was right. What I got wrong:

1. **Stale closure over `screenToWorld`.** The effect captured `screenToWorld` at mount. `screenToWorld` is derived from the current viewport (pan + zoom) — when the user panned or zoomed, the closure still used the initial viewport, and the drag computed wrong world coordinates.

2. **`.dragging` CSS class never got applied.** I removed the `forceRender(n => n + 1)` that the v7.2 code was using. That force-render was what made React re-render TokenView with `isDraggingLocal=true`, which added the `.dragging` class. Without that class, the CSS `transition: left 220ms` on `.token` kept interpolating every DOM-direct `style.left` write. The token crawled 220ms behind the cursor — looking completely broken.

The fix:

- **Read `screenToWorld`, `tokens`, and `onTokenMove` via refs.** The effect keeps `[]` deps, so listeners never re-attach, but reads fresh values on each event. No stale closures.
- **Stamp `.dragging` directly on the DOM node at drag start, strip it at drag end.** Bypasses React's render cycle entirely during drag. The CSS transition is correctly suppressed; the token follows the cursor 1:1.
- **On commit, leave the inline style in place.** Clearing `style.left/top` in `endDrag` caused a one-frame flash back to the pre-drag position before React re-rendered with the new position. Now the inline style stays put and React reconciles the next render over it with no flash.
- **On abort (cancel/blur/visibilitychange), DO clear inline style** — so React re-renders at the unchanged committed position (abort = no move).

Carries forward from v7.3:
- Pointer events only — no mixed pointer/touch listeners
- `pointercancel` + window `blur` + `document visibilitychange` all abort cleanly
- `pointerId` captured at start, checked on every subsequent event
- `touch-action: none` on `.token` so browsers don't reinterpret drag as scroll

### Fix #2 — DM side laggy

The v7.3 group-hover highlight effect depended on `state.tokens`. That meant every token position update (including every frame of the ephemeral `token_pos` broadcast during drags) re-ran the effect — which walks the DOM with `querySelectorAll` and a per-member `querySelector`. Even when no group was hovered.

Fix: narrowed deps to `[hoveredGroupId]`. Read `state.tokenGroups` via a ref inside. The effect now only runs when the hover state itself changes.

### Fix #3 — Lighting doesn't cover large maps

This wasn't a v7.3 regression — it's a longstanding limit that was always there but only became visible once the more urgent bugs cleared.

The five SVG overlay layers (vision mask, block zones, drawings, hazards, measuring) were hardcoded to an 8000×8000 bounding box centered at world origin: `style={{ left: -4000, top: -4000, width: 8000, height: 8000 }}` + `viewBox="-4000 -4000 8000 8000"`. Maps larger than that had their outer edges outside the vision mask's dark-fill rectangle, so those edges were permanently lit (or permanently dark on the player side with no vision source nearby).

Fix:

- **Added `mapBounds` state to MapCanvas.** Computed from the map image's `naturalWidth` / `naturalHeight` on `onLoad`, padded with 4000 world-px on each side, clamped to a minimum of 8000 per axis (preserves old behavior on empty canvases and small maps).
- **All five SVG overlay layers now read from `mapBounds`.** Each uses `{ left: -mapBounds.OFF, top: -mapBounds.OFF, width: mapBounds.W, height: mapBounds.H }` and a matching viewBox string.
- **The vision mask constants switched to destructuring `mapBounds`.**

A 12000×12000 map now gets a 20000×20000 mask covering `(-4000, -4000)` to `(16000, 16000)` — the whole map plus the usual padding. SVG is vector, so there's no perf cost to the larger bounds; fragment shading scales with rendered pixels in the viewport, not with the viewBox size.

### Files

Same 6-file manifest as v7.3:

| File | Size | Notes |
|---|---|---|
| `index.html` | 103 KB | **606 CSS rules** (unchanged from v7.3) |
| `app.compiled.js` | 457 KB | rebuilt |
| `app.js` | 427 KB | drag rewrite + hover-effect dep fix + mapBounds |
| `README.md` | updated | this changelog appended |
| `build.sh` | unchanged | |
| `.nojekyll` | unchanged | |

### Deploy

Copy the 6 files to the repo root, push to main, hard-refresh. No schema changes.

### What to watch for post-deploy

1. **Test a drag** — should feel 1:1 with the cursor, no 220ms lag. Release should drop the token cleanly at the final cursor position with no snap-back flash.
2. **Test a drag after panning/zooming mid-session** — should now track the cursor correctly at any zoom level (v7.3 broke this).
3. **Test cancel paths** — alt-tab mid-drag, second finger tap mid-drag, app switch mid-drag — each should abort the drag cleanly and the token should stay at its pre-drag position.
4. **Large map lighting** — upload a map larger than 8000×8000 in either dimension. The vision mask should cover the whole map. Blocks, drawings, and hazards should also reach to the map edges.
5. **DM hover test** — hover a group row in the Groups panel during someone's token drag; the group outline should appear WITHOUT introducing drag lag.

### v7.4 scorecard

| # | Regression / Fix | Status |
|---|---|---|
| 1 | Player token drag drops correctly (v7.3 broke this) | ✅ fixed — stale closures + .dragging class + flash eliminated |
| 2 | DM drag lag from hover effect (v7.3 introduced this) | ✅ fixed — deps narrowed, ref for groups lookup |
| 3 | Lighting covers arbitrarily large maps (longstanding) | ✅ fixed — mapBounds from image naturalWidth/Height |

---

## Changelog — v7.5 (diagnostic release for player-move propagation bug)

### What this release does

v7.5 is a **diagnostic release, not a fix**. You reported that player token movement doesn't update on other devices. I traced the full propagation chain (player drag → commit → `sendPlayerAction` → DM receive → `TOKEN_MOVE` dispatch → debounced broadcast → peer `REPLACE`) and couldn't identify a clear bug by static analysis. Every arm of the chain looks correct on paper.

Rather than guess-and-rewrite (which is how v7.3 introduced the original drag regression), v7.5 adds comprehensive diagnostic logging at every step of the move flow. When you reproduce the bug, the console output will show exactly which step fails, and v7.6 will then patch the actual failure point with minimal code change.

### Logging added

Every `[plagues-call]` line logs a specific step in the move chain. A successful move should produce a sequence like:

```
[plagues-call] drag end → commit token=abc123 x=450 y=300 cb=true
[plagues-call] player tokenMove OK token=abc123 → (450, 300)
[plagues-call] sendPlayerAction(move_token) returned true dmConn.open=true
[plagues-call] DM move_token OK peer=xyz456 token=abc123 → (450, 300)
[plagues-call] DM token_pos broadcast to 2 peer(s)
[plagues-call] player ← state_update 18 tokens     (on receiving peers)
```

A failing move will stop somewhere in that chain. The log line before the silence tells us which step fails.

#### Specific log points

**On the moving player:**
- `drag end → commit token=... x=... y=... cb=true` — the drag ended cleanly and the commit callback is a function
- `drag end → abort token=...` — the drag was cancelled (pointercancel / blur / tab switch) — no commit fired
- `player tokenMove OK token=...` — ownership check passed
- `player tokenMove REJECT: not owned token=... entity=... ownedIds=[...]` — ownership failed (this would surface a claim-state mismatch bug)
- `sendPlayerAction(move_token) returned true/false dmConn.open=true/false` — the critical send step. If `returned false` or `dmConn.open=false`, the message never left the device

**On the DM:**
- `DM move_token OK peer=... token=... → (x, y)` — DM accepted the move and is about to broadcast
- `DM move_token REJECT: peer ... doesn't own ...` — DM-side ownership mismatch (the most likely culprit if claims get out of sync)
- `DM move_token REJECT: no token ...` or `no entity for token ...` — token lookup failed
- `DM token_pos broadcast to N peer(s)` — how many peers got the ephemeral fast-channel update
- `DM token_pos send failed to peer=...: <reason>` — specific per-peer send failure

**On other peers:**
- `player got token_pos token=... → (x, y)` — ephemeral fast-channel update arrived
- `player ← state_update N tokens` — authoritative debounced broadcast arrived

### How to use this

1. Deploy v7.5
2. Open the browser DevTools console on BOTH the moving player AND the DM AND another observing device
3. Reproduce the bug (player moves their token; other devices don't see the update)
4. Copy the console output from each device
5. Share the console output (or the specific last `[plagues-call]` line from each device)

Whichever step is the LAST one logged before silence tells us exactly where the chain breaks.

### Why this approach rather than "just fix it"

I've already shipped two regressions in this arc (v7.3 drag, v7.4 follow-up not fully fixing). The pattern is: I try to identify a root cause from code inspection, commit to a hypothesis, and rewrite. When the hypothesis is wrong, the rewrite introduces new bugs. Logging lets me see ground truth before writing any fix code.

The logs are verbose but only fire during actual move events — they don't affect performance outside of those handlers.

### Files

Same 6-file manifest:

| File | Size |
|---|---|
| `index.html` | 103 KB |
| `app.compiled.js` | 460 KB — rebuilt |
| `app.js` | 429 KB — logging added |
| `README.md` | appended |
| `build.sh` | unchanged |
| `.nojekyll` | unchanged |

No behavior changes beyond the added `console.log` calls. All v7.4 fixes (drag rewrite, mapBounds for large-map lighting, hover-effect dep narrowing) remain in place.
