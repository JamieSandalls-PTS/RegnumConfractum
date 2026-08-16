# Architecture Decision Record

**Project:** Regnum Confractum — a persistent-world roleplaying MMO
**Presentation:** procedural 3D rendered to a pixel-quantised isometric view (see D-401,
which supersedes the original 2D sprite approach)
**Inspiration:** Arelith (Neverwinter Nights persistent world), Ultima Online, Tibia
**Status of this document:** living — every locked decision is appended here with its rationale.

> **Why this document exists.** Claude does not retain memory between sessions. This
> file, the schemas, and the test suite are the project's memory. A decision that is
> not written down here will be re-litigated, and probably re-litigated differently.
> Record the *reasoning*, not just the conclusion — a future session needs to know
> which constraints are load-bearing and which were arbitrary.

---

## Phase 0 — Framing

### D-000: The project is content and systems, not an engine achievement

**Decision:** Treat Arelith as the model in the correct sense — it was a *content and
systems* achievement layered on an existing engine that supplied rendering, animation,
netcode and toolset for free.

**Rationale:** The work that makes a persistent RP world worth inhabiting is systems
code, world data, and community infrastructure. Every hour spent on bespoke 3D art or
novel engine technology is an hour not spent on the thing players actually stay for.
This project deliberately maximises code and data, and minimises bespoke art.

**Consequence:** Architecture is chosen to make world content *data* wherever possible.

---

## Phase 1 — Core architecture, platform, scale

### D-101: Isometric 2D, browser-delivered

**Decision:** Isometric 2D tile world, rendered in the browser. Not 3D. Not
room-based text.

**Rationale:** 2D worlds are data; 3D worlds are craft. A tile map is a grid of
integers that can be generated, validated and revised programmatically, and reviewed
by a human in a map editor. A 3D area is hand-placed geometry where the gap between
"atmospheric" and "asset-store props in a box" is thousands of hours of exactly the
work Claude is weakest at. Isometric over top-down because immersion and sense of
place were stated as a primary goal, and isometric reads as *architecture* rather
than *floor plan*.

**Accepted cost:** Fewer free isometric asset packs; more character facings, which
multiplies equipment-layer art. Mitigated by committing to one commercial pack early
(see D-30x, Phase 3).

**Precedent:** Ultima Online, Tibia and Furcadia sustained deep RP communities for
decades on 2D sprites. Fidelity was never the binding constraint on immersion.

### D-102: Authoritative server, presentation-only client

**Decision:** The client sends *intent* ("walk to tile 14,22", "attack that entity")
and renders what the server tells it. It never determines outcomes.

**Rationale:** A persistent economy plus player conflict means any trusted-client
design ends with duplicated items and a dead economy. Server authority is the only
model that survives contact with a real playerbase.

**Secondary benefit:** The client can be fully open-sourced later without creating a
cheating surface.

### D-103: Zoned areas, not a seamless world

**Decision:** The world is a graph of discrete areas joined by transitions. Each area
is an independent simulation unit on a tile grid of roughly 64x64 to 128x128.

**Rationale:** The single largest complexity saving available. Eliminates cross-boundary
entity handoff and distributed interest management — the two problems that most
reliably kill indie MMOs. Also provides a natural sharding boundary if one is ever
needed.

**Evidence:** Arelith is zoned with loading transitions and it has never been a
meaningful complaint in twenty years.

### D-104: 10Hz server tick, tile-based movement, non-twitch combat

**Decision:** Server simulates at 10Hz. Characters move tile to tile with client-side
interpolation for smoothness. Combat is cooldown- or round-based.

**Rationale:** Three benefits at once. Bandwidth and CPU become negligible at target
scale. Latency never decides a fight, which matters for a playerbase spread across
timezones. And it keeps the design honest about what this game is — a world for
roleplay, not an action game.

**Reversibility:** LOW. This assumption is baked into combat, movement, ability and
netcode design. Changing it later is a rewrite. Confirmed with stakeholder before
locking.

### D-105: TypeScript on Bun/Node, shared wire-protocol package

**Decision:** TypeScript across server and client, with the wire protocol defined once
in a shared package consumed by both.

**Rationale:** A change to a message shape should break the build on both sides rather
than desync silently in production. That property is worth more at this scale than any
raw performance advantage Go or C# would offer. Claude is also measurably faster and
more reliable in TypeScript, which is a real engineering input given who is writing
the code.

**Rejected:** Go (two languages, no shared types, perf headroom not needed at 300 CCU).

### D-106: Postgres as source of truth; no Redis initially

**Decision:** Postgres holds characters, inventory, world state, land ownership and
faction standing. Dirty-flag entities and flush every 30-60s, with immediate writes on
critical events: item transfer, death, logout, currency change.

**Also required:** an append-only event log table, from day one.

**Rationale for the event log:** When a player claims a guild artifact was stolen, the
log is the difference between a resolvable dispute and a community-splitting argument.
Moderation of an RP community is an evidence problem before it is a policy problem.

**Redis deferred:** Adds an operational component for no benefit at target scale.
Revisit only when profiling demands it.

### D-107: WebSocket transport, JSON first

**Decision:** WebSocket. JSON encoding during development, swappable for a binary
codec behind the same schema. Full snapshot on area entry, deltas thereafter.
Interest management begins as "everyone in this area"; radius filtering added only
when an area demonstrably gets crowded.

**Rationale:** Debuggability during the phase where debuggability is worth most.
The schema boundary makes the later swap mechanical rather than architectural.

### D-108: PixiJS for the world, React for the interface

**Decision:** PixiJS (WebGL 2D) renders the isometric world. React handles chat,
inventory, character sheet, journals and all text-heavy interface.

**Rationale:** Isometric rendering is a sprite-batching and depth-sorting problem,
which is Pixi's strength. The interface is text- and form-heavy, which is React's.
Zero-install browser delivery is a genuine retention advantage with the literate,
writing-focused audience this world is aimed at.

**Rejected:** Godot 4 web export. Godot's core strength is its visual editor — the
exact workflow Claude cannot drive, since it would mean authoring scene files blind.
PixiJS plus React is code, which is where Claude is strongest.

### D-109: Sandboxed Lua scripting layer, built early

**Decision:** Embed sandboxed Lua (WASM-hosted) exposing a controlled API for area
events, triggers, dialogue and quests. Build it in the first milestone, not later.

**Rationale:** This is the NWScript analogue. It is what allows content authors and
DMs to change the world without a server deploy, and it is the line between shipping
*a game* and shipping *an engine with a world running on it*. Retrofitting it after
systems exist means reworking all of them; building it up front costs roughly a week.

### D-110: All world content is versioned data

**Decision:** Areas, items, NPCs, dialogue trees, factions and loot tables live as
JSON/YAML in git, validated against strict schemas. A browser-based map editor is a
first-class deliverable.

**Rationale:** This is the force multiplier that makes a Claude-built world feasible.
Content as schema-validated data can be generated and revised at volume and reviewed
visually by a human who is not reading code.

### D-111: Single VPS, Docker Compose, off-box nightly backups

**Decision:** One self-hosted VPS (~£15-40/month). Docker Compose. Caddy for TLS.
Nightly Postgres backups shipped off-box. No Kubernetes, no microservices, no
message bus.

**Rationale:** Operational complexity is a tax paid forever, out of the same budget of
attention that content and moderation need. Stakeholder confirmed comfort with
self-hosting.

### D-112: Target 300 concurrent players, single process

**Decision:** Design for 300 CCU on one process on one box. Structure areas as
isolated units so multi-process is *available* later, but do not build it.

**Rationale:** Arelith — the most successful world of this type — peaks around
100-200 concurrent. 300 players at 10Hz with delta updates is a few megabits and a
fraction of a core. Building for 10,000 would trade certain present complexity for
speculative future need.

**Real bottleneck:** content volume and moderator attention. Never hardware.

### D-113: Original setting; SRD-licensed rules only if used at all

**Decision:** No Forgotten Realms, no Wizards-of-the-Coast IP. Either an original
setting and ruleset, or mechanics derived from openly licensed material (5.1 SRD
under CC-BY, or ORC-licensed content), with licence obligations documented.

**Rationale:** Arelith could use Forgotten Realms because it ran on a licensed NWN
client. That cover does not extend to an independent product. A takedown after two
years of community-building is an avoidable catastrophe.

### D-114: Stakeholder is hands-off; verification must be automated

**Decision:** The stakeholder directs design and reviews the *running game*, not the
code. Therefore correctness cannot depend on human code review.

**Consequences — these are requirements, not nice-to-haves:**

- Deterministic simulation harness, so game logic is testable headlessly and
  reproducibly.
- Headless bot clients that play the game and assert invariants (no item duplication,
  no currency creation, no unreachable areas, no desync).
- A persistent staging server the stakeholder can simply log into to review work.
- Admin web UI for inspecting world state without database access.
- Schema validation on every content file in CI.

**Rationale:** With no human reading the code, the test suite and the tooling are the
only things standing between a subtle bug and a live economy exploit. The one thing
the stakeholder must still do personally is *play* and judge feel — that judgement is
not automatable and is the highest-value input available.

---

## Phase 2 — Features and systems

### D-201: Recognition is fluid, with confidence-tiered automatic name capture

**Decision:** Names are not known until learned. Automatic capture parses speech for
self-introduction, gated by confidence:

- **High confidence** ("I am X", "my name is X", "they call me X", "X, at your
  service") — silently auto-stores for every character in earshot.
- **Ambiguous** — surfaces an unobtrusive "store this name?" prompt. Never guesses.
- **Third-party** ("this is X", said while targeting someone) — attaches to the target.
- **Explicit** — an introduce command always available for reliability.

Every stored name carries **provenance**: self-claimed, third-party, or verified.

**Rationale:** Naive keyword matching stores wrong names constantly and destroys the
mechanic it is meant to serve. Confidence tiers keep the fluidity without the noise.

**Deliberate consequence:** A claimed name is not a proven name. Two characters may
claim the same name; a third party may misattribute one. This is a feature — false
identity and rumour are RP content, not bugs.

### D-202: Emote animation is driven by a lexicon-backed state machine

**Decision:** Text wrapped in asterisks is parsed against a data-defined lexicon of
synonym groups. Emotes divide into **states** (sit, lean, kneel, lie down — persist
until movement) and **transients** (bow, laugh, wave, draw weapon — play once). Both
may fire from one line: `*sits down and laughs*` enters sit, plays laugh. `*stands up*`
exits state. Negation is handled — `*doesn't flinch*` must not flinch.

Unmatched text renders as plain emote text with no animation. It never errors.

**Constraint (couples to Phase 3):** Expressiveness is hard-bounded by the animation
vocabulary of the chosen art pack. This is the strongest single argument for buying a
comprehensive commercial isometric set rather than assembling free ones.

**Extensibility:** The lexicon is a content file, extendable by DMs without a deploy.

### D-203: Soft death with ghost phase; XP cost modelled as debt

**Decision:** Death costs XP but never removes a level. Implemented as **death debt** —
future XP earnings pay down the debt before advancing the character.

**Rationale:** Deleting XP clips awkwardly at level boundaries and can waste progress.
Debt is smooth, never destroys earned advancement, and allows precise tuning of sting.

**Ghost phase:** 5 minutes minimum before self-respawn at town. Ghosts see and hear
only other ghosts.

**Rationale for the vision restriction — do not relax this:** if ghosts could observe
the living, a dead player becomes a free scout relaying enemy positions over Discord.
The restriction closes an exploit that most games in this genre leave open.

### D-204: Spirit interaction abilities

**Decision:** Three class-gated interactions with the dead:

1. **Speak With Dead** — the ghost is drawn back to its corpse and may answer five
   questions, then departs. *The dead are under no compulsion to answer truthfully.*
2. **Animate Dead** — raises a dead player's corpse as an undead ally. Does not block
   the owner's respawn; the owner may instead choose to remain inside the body as an
   observer, with speech garbled by the system into undead register.
3. **Plane Shift ritual** — shaman-type classes perceive ghosts directly.

**Rationale:** Novel, deeply RP-generative, and turns death from dead time into content.
The lying corpse in particular converts an information mechanic into a drama mechanic.

**Open risk:** Animate Dead needs a consent boundary or duration cap, or repeated
raising becomes a griefing vector. Unresolved.

**Open risk:** Speak With Dead requires the ghost to be reachable. Behaviour when the
dead player has logged off is unresolved.

### D-205: Deep injury system, tuned for social dependency

**Decision:** Injuries are located (head, torso, arms, legs), typed (cut, pierce, blunt,
burn, frost, venom, rot, curse), and tiered (minor/major), plus sickness and curses.
Each type demands a different treatment path: bandaging, suturing, cauterising,
herbalism, surgery, divine healing, curse-breaking. Untreated wounds may progress.
Every combination carries descriptive text for appearance and effect.

**Rationale — the real design goal:** the payoff is not simulation depth, it is that
**you must find a physician**. Systems that make players need other players are the
engine of a social world.

**Tuning rule:** injuries should be interesting and inconvenient, not crippling. Punish
too hard and players stop taking risks, which destroys the drama the system exists to
create.

**Content note:** the description matrix is bulk data generation — a good fit for
Claude-authored content under schema validation.

### D-206: Tiered PvP — declared intent, open wilderness, permadeath endgame

**Decision:** Three zones of escalating danger.

- **Settled areas — declared hostility.** A player must enable hostility toward a
  target *and* speak a hostile message at the same moment. A 10-second window then
  elapses before any attack may land, creating space for roleplay or flight.
- **Wilderness — open PvP.** No declaration required.
- **Endgame areas — permadeath**, unless revived by another player within a time limit.

Every hostility declaration is written to the event log with its spoken intent.

**Rationale:** The declaration window makes ganking structurally impossible in settled
areas while keeping conflict available. The escalation gradient lets players choose
their own stakes. Logging makes moderation an evidence exercise rather than an
argument.

**Requirement:** Permadeath zones need unmissable warning at the point of entry.

**Unresolved:** Whether theft falls under declared hostility. Pickpocketing cannot be
pre-declared without absurdity; likely a separate mechanic where detection converts the
act into a hostile one. Needs design.

### D-207: Voluntary permadeath yields Legacy Points

**Decision:** A player may permanently retire or kill a character to earn Legacy Points,
spendable on bonuses and unlocks for future characters.

**Required guards:** Points scale with time invested and achievements reached, with
diminishing returns on repeat sacrifices.

**Hard rule:** Legacy Points buy **access and flavour** — the RP-locked classes — and
never raw power. Otherwise the system becomes a grind treadmill and pay-to-win by
attrition.

**Rationale:** Makes retirement meaningful, discourages character hoarding, and turns
an ending into a beginning.

### D-208: Classic archetype classes plus monster/subterranean options

**Decision:** A familiar high-fantasy class spread across melee, arcane, ranged, and
support, plus playable monstrous and subterranean cultures. A subset of classes with
distinctive RP abilities is gated behind Legacy Points.

**Scope ruling:** Launch with 8-10 deep, distinct classes and expand on a quarterly
cadence. Class breadth is the most reliable way for scope to collapse a project — each
class is abilities, balance, animation, art, and test coverage.

### D-209: IP boundary — familiar feel, original nouns

**Decision:** The *feel* of classic high fantasy is the target. Wizards of the Coast
product identity is out: named settings and deities, and creatures that are theirs
rather than folklore (beholders, mind flayers, and their specific conception of drow).
An original pantheon and original naming for the subterranean cultures.

**Rationale:** Players respond to archetype and tone, not to proper nouns. The rename
costs nothing and removes an existential risk. Arelith's cover came from running on a
licensed client; that cover does not extend to an independent product.

### D-210: No orphan items — enforced in CI

**Decision:** Every item must be exactly one of: base material, equipment, consumable,
vendor trash, or an input to a recipe. No craftable item may terminate in a low-value
dead end; each should feed something more valuable.

**Enforcement:** A graph validator walks the item and recipe database and **fails the
build** on any orphan — anything that is not equipment, not consumable, not tagged
trash, and not an input to any recipe.

**Rationale:** This is a graph property, therefore machine-checkable. Exactly the class
of invariant that keeps a hands-off project honest without human code review.

### D-211: Minimise NPC gold faucets

**Decision:** NPC purchase of vendor trash must be capped (vendor daily budgets) or
replaced by folding trash into crafting inputs.

**Rationale:** Any NPC that buys goods for coin prints money indefinitely. Inflation is
the standard cause of death for indie MMO economies. Wealth should move player to
player; NPC vendors set floors and ceilings, not income.

**Note:** This is in tension with the stated "vendor trash: sellable only" category.
Folding trash into crafting resolves the tension and reinforces D-210.

### D-212: Party cap of 5; faction limits are on benefits, not roster

**Decision:** Hard mechanical party cap of five characters. Faction scale is constrained
by **capping benefits** — officer slots, claim plots, treasury limits — and by making
territory upkeep scale superlinearly with holdings.

**Rationale — stated honestly:** roster caps cannot be enforced. Players will form
allied sub-factions and coordinate externally. No mechanic defeats Discord. What *can*
be done is making large-scale coordination mechanically inefficient and financially
punishing. The party cap works precisely because it is mechanical.

### D-213: Hidden player settlements; coordinates as a physical item

**Decision:** Factions may found small towns. Town locations are hidden by default;
reaching one requires faction membership or possession of its coordinates. Revealing a
location enables trade and invites banditry — a deliberate, reversible political choice.

**Key mechanic:** Coordinates exist as a **physical item** — a map, charter, or scrap of
parchment. Stealable, forgeable, sellable, inheritable.

**Rationale:** Fuses settlement secrecy with the in-world writing system and gives
thieves a target more valuable and more interesting than gold. The secrecy/prosperity
trade-off is self-balancing and generates politics without authored content.

**Also:** Players may build individually outside towns on a small claim, with land
upkeep costs and hireable NPC guards at tiered strengths. Guard wages are a
well-shaped gold sink.

### D-214: Overworld grid reconciling coordinates with zoned areas

**Decision (PROPOSED — needs ratification):** Introduce a coarse overworld grid as a
second spatial layer above D-103's zoned areas. Each cell may host or generate an area.
Travel between cells consumes time and can be intercepted. A coordinate names a cell
plus an offset.

**Why this is flagged rather than assumed:** D-103 locked a graph of discrete areas.
Navigable coordinates in open wilderness imply a continuous space. These are different
models, and the seam between them is the kind of thing that is cheap to design now and
extremely expensive to discover in month four.

### D-215: Open registration, compensated by onboarding and audit tooling

**Decision:** No application to join. Comprehensive logging instead: chat, hostile
actions, theft, trades, item transfers, deaths, logins, area transitions — all
searchable through an admin interface. Players are told logging exists.

**Accepted cost, stated plainly:** open registration relocates the entire
community-quality problem into moderation, and moderation load scales with population
while burning out volunteers.

**Required compensation:** an onboarding area that teaches expectations through play,
in-world mentorship, and a low-friction tutorial gate that filters people who arrived
expecting an action game — without being an application.

### D-216: DM toolset is a first-class milestone, not a feature

**Decision:** The DM toolset is budgeted and scheduled as its own milestone. Required
capability:

- Global, area-wide and individual messaging
- Rapid creation of temporary areas, placeable at wilderness coordinates
- Spawn and direct control of NPCs, monsters, objects, weather and lighting
- A **trigger and scheduling engine**: time-of-day and elapsed-time schedules;
  conditional triggers (player count in area, entity death, item acquired, area
  entered); and chained consequences
- **Live puppeteering** — possess and speak as any NPC in real time
- **Rehearsal mode** — run an event against staging before it goes live
- An event template library for reuse
- Rollback for anything spawned

**Interface ruling:** a visual, form-based editor generating scripts underneath. DMs
must not be required to write code.

**Rationale:** This is effectively a second product, and it is the stakeholder's
highest-conviction requirement. Live puppeteering is what separates events that feel
improvised from events that feel canned. Rehearsal mode is what makes "easily" true.

### D-217: Witness-based reputation

**Decision:** Reputation is tracked per faction and decays over time. Crimes register
**only if witnessed** or if evidence is discovered. Guard response ladders: warned,
fined, arrested, killed on sight. Player and faction bounties layer on top.

**Rationale — this is the load-bearing part:** omniscient reputation makes disguise,
alibis, hoods, and the silencing of witnesses meaningless. Witness-based reputation
snaps together with D-201: you can only be *wanted* if they know who you are. The two
systems multiply each other.

**Free consequence:** bounty-hunter gameplay emerges without being designed.

---

## Phase 2 — Amendments

> ADR convention: entries are superseded, not rewritten. The original decision and the
> reasoning that changed it are both part of the record.

### D-218: Explicit name declaration, contested by Bluff against Insight
**Supersedes the parsing approach in D-201.**

**Decision:** A speaker declares a name via an explicit flag rather than the system
inferring it from free text. The declared name — true or false — propagates to every
character in earshot. Listeners may contest it with Insight against the speaker's Bluff.

**Rationale:** Removes text-parsing ambiguity entirely and converts identity into a
*skill contest*, which is far richer than pattern matching could ever be. Stakeholder's
design, and better than the original.

**Two hard rules:**

1. **Insight is graded and fallible.** Results range across "certain he is lying",
   "something rings false", and "you cannot tell", and are occasionally *wrong* at
   narrow margins. Insight reveals *that* something is off — never *what* the truth is.
   A reliable lie detector destroys deception roleplay outright.
2. **The declaration flag is invisible to observers.** Listeners hear a man state a
   name; they do not see that a mechanic was invoked. Leaking this collapses the
   illusion into metagame.

### D-219: Identity threads, with multi-channel disguise

**Decision:** The unit of recognition is an **observed identity** — a character in a
given presentation state — not the character themselves. Names, voices and remembered
history attach to the *thread*. A character seen normally and the same character
disguised are two independent threads in an observer's knowledge.

**Merge event:** Piercing a disguise merges the threads, retroactively attaching
everything known about the disguised identity to the real one.

**Rationale:** The merge is a genuine dramatic beat — the moment of recognition — and
falls out of the data model for free rather than needing to be authored.

**Disguise leaks through independent channels:** appearance, **voice**, gait and
mannerism, and distinctive equipment. Bluff and Disguise suppress each; Insight and
Perception pierce each independently. A master of disguise with a memorable limp
remains catchable by the right observer.

**Per-observer resolution:** contests resolve individually. The same lie may read as
true to one listener and false to another.

### D-220: Risk-scaled rewards paid in goods, not coin
**Refines D-211.**

**Decision:** High-risk content yields rare materials, unique equipment and valuables.
Coin does not drop from monsters. Rewards are monitored via telemetry, never capped.

**Rationale:** Goods only become money when another player pays for them — the reward
feels identical to the player while the wealth is *transferred* rather than *created*.
Coin dropping from monsters is money printed from nothing, which is the standard
mechanism by which these economies die.

### D-221: Economy telemetry from day one

**Decision:** Instrument and dashboard: total money supply; coin created per day by
source; coin destroyed per day by sink; price indices on staple goods; wealth
distribution across the playerbase.

**Tuning doctrine:** when inflation appears, raise **sinks** — upkeep, repair, guard
wages. Do not nerf rewards. Higher costs read as *world*; reduced loot reads as
punishment.

**Rationale:** "Monitored, not capped" requires actual instruments. This is also the
form of oversight a hands-off owner can genuinely exercise at a glance.

### D-222: Legacy Points scale on active playtime and level
**Refines D-207.**

**Decision:** Points earned on voluntary permadeath scale with the character's level and
**active** playtime — measured by meaningful action, not wall-clock session length.
Renown and achievements weight the result.

**Rationale:** Wall-clock time is farmable by idling characters overnight. Weighting
renown ensures a memorable character is worth more than a ground-out one, which
incentivises exactly the behaviour the world wants.

### D-223: Theft — undeclared, with a one-sided retaliation window
**Resolves the open question in D-206.**

**Decision:** Theft requires no hostility declaration. Detection is a contested roll —
Sleight of Hand against Perception, modified by crowding, lighting and distraction. On
detection the victim receives a window of **one-sided hostility**: they may strike, and
the thief cannot retaliate until that free action resolves.

**Refinements:**

- The thief receives a *cue* they have been made, never certainty — consistent with the
  Insight doctrine in D-218.
- **Witnesses count.** A botched pickpocket in a crowded market is a materially
  different problem from one in an alley, and reputation damage applies only where the
  thief is recognised (per D-217).
- Failed attempts are detectable. The fumbled theft is the classic scene and must be
  reachable.

### D-224: Animate Dead — observer role, and gear stays on the corpse
**Supersedes the consent question left open in D-204.**

**Decision:** The slain player is never forced to remain. They may observe as the
zombie for the respawn timer and beyond, at their discretion, and may respawn at any
point once the timer expires. **The body remains animated regardless, wearing
everything carried at the moment of death.**

**Rationale:** Makes necromancers genuinely feared, and generates the best emergent
quest in the design — hunting down your own corpse to recover your equipment.

**Ruling — gear drops when the zombie is destroyed.** Without this the hunt has no
payoff.

**Open — respawn while the body walks off in your armour.** Recommended yes, for
stakes, but harsh enough to require explicit stakeholder ratification.

**Still open:** duration cap on animated corpses, or the world fills with them.
Suggested tie to the necromancer's skill.

### D-225: Valuables are sellable *or* displayable
**Refines D-210 and D-211; preserves the five-category rule intact.**

**Decision:** Category four — artifacts, jewellery, trophies — genuinely exists with no
practical use, balanced on frequency against value. It gains one non-monetary use:
**placeable as decoration in player housing.**

**Rationale:** This is the most elegant sink in the design. A valuable has two fates —
sold for coin, or mounted on a wall. Players *voluntarily* removing money from the
economy in exchange for status costs nothing to enforce, because they want to do it.
It also gives hidden settlements something to display and be proud of.

**Retained safety valve:** vendor daily budgets, throttling the rate at which coin
enters — not capping what any player may earn.

---

## Open decisions

**Blocking — needed before spatial code is written:**

- **D-214 overworld grid.** Still proposed, not ratified. The seam between navigable
  wilderness coordinates and the zoned-area model of D-103 is cheap to design now and
  extremely expensive to discover later.

Unresolved, non-blocking:

- Respawning empty-handed while the animated corpse retains all equipment (D-224)
- Duration cap on animated corpses (D-224)
- Speak With Dead behaviour when the dead player has logged off (D-204)
- Which 8-10 classes ship at launch — depends on setting
- Milestone sequencing and the definition of the first playable slice

---

## Phase 3 — Look, feel and vibe

### D-301: Overworld grid — RATIFIED
**Promotes D-214 from proposed to locked.**

**Decision:** A coarse overworld grid sits above the zoned areas of D-103. Each cell may
host or generate an area. Travel between cells consumes time and can be intercepted. A
coordinate names a cell plus an offset.

**Status:** Ratified by stakeholder. Spatial implementation may now proceed.

### D-302: Setting — a decaying empire, low and grim

**Decision:** Low fantasy crossed with post-collapse decay. Magic is rare and feared.
Civilisation has contracted to defensible pockets; the roads between are dangerous. A
population running from aberrations, demons and undead through to religious zealots,
thieves and brutes. The tonal reference is Neverwinter Nights: gritty, somewhat dark,
realistically proportioned.

**Explicitly excluded:** cute or comic-relief races, cartoon or chibi stylisation,
bright saturated fantasy palettes.

**Diegetic payoff:** this setting makes D-213's hidden settlements *make sense in
fiction*. People conceal their towns because there is genuinely something out there
worth hiding from. The secrecy-versus-trade tension stops being an elegant abstraction
and becomes the world's central question.

### D-303: The virtue principle — the system never rewards goodness

**Decision (this is the first line of the design bible):** A player can be good in this
world, and doing so must be a costly choice made *against the grain* — never a
mechanically optimal one.

**Therefore:**

- **No alignment meter. No karma stat. No mechanical bonus for virtue.** Ever.
- Mercy must be **mechanically possible** — sparing, ransoming, sheltering, healing,
  concealing someone must all be supported actions. Otherwise good is unplayable and
  the principle is empty.
- Validation for virtuous play comes from **other players and factions**, never from
  the game.
- The ambient world must be genuinely grim and genuinely winning. If evil is not
  actually ascendant, heroism costs nothing and therefore means nothing.

**Rationale:** Stakeholder's framing — "if you are good and spritely in this world, you
do it in spite of everything evil happening around you, much like real life." This is a
design principle, not flavour text, and it adjudicates a large number of downstream
micro-decisions.

### D-304: Characters are 3D-rendered to isometric sprite sheets

**Decision:** Do not purchase pixel-art character sprites. Build or acquire 3D base
meshes, apply animation libraries, and **pre-render to eight-direction isometric sprite
sheets**. The game remains 2D — same client, same tile grid, same netcode.

**Precedent:** Diablo, Fallout, Baldur's Gate and Age of Empires all did exactly this.

**Rationale — four reasons, in order of weight:**

1. **Animation vocabulary becomes nearly free.** D-202's emote system needs roughly
   30-40 animations across 8 facings. Hand-drawn that is prohibitive; rendered it is a
   render queue. The emote system is only as expressive as the animation set, so this
   is decisive.
2. **Equipment layering is solved by rendering variants**, rather than by aligning
   hand-drawn overlays across every frame and facing — which is why layered equipment
   is vanishingly rare in isometric pixel art.
3. **Lighting and proportion are consistent by construction**, which is the actual
   difference between "gritty and coherent" and "asset pack soup."
4. **It is a pipeline, therefore code.** This moves the art burden into the half of the
   project where Claude is strong. Single largest lever available given the
   constraints in D-114.

**Accepted cost:** more setup before the first sprite exists, and a machine to run
renders on.

**Fallback if earlier visual progress is required:** buy a commercial isometric pack and
commission a pixel artist to extend it (low four figures for a workable character
system) — at the price of being bounded by that pack's animation set permanently.

**Environments:** purchased isometric tilesets for bulk coverage; pre-rendered 3D for
hero props and structures.

### D-305: Light and weather are mechanical inputs, not decoration

**Decision:** Dynamic day/night with real light falloff (torches, lanterns, windows),
weather including rain, fog and snow, and seasons. Implemented as a shader pass over
the tile layer.

**Critical design ruling:** these feed the existing contests. Fog and rain penalise
Perception — therefore weather assists thieves (D-223) and the disguised (D-219).
Darkness conceals; carrying a light source reveals the bearer.

**Rationale:** this converts atmosphere into tactics and makes a foggy night the time
when things happen. It is also what justifies building the system properly rather than
as a cosmetic layer.

### D-306: Interface — a reading application first

**Decision:** Dark, low-chroma interface with warm candlelight accents. Sans-serif for
system text and chat; serif reserved for in-world documents, where journals, letters and
books render as actual pages. World view dominant, chat docked and resizable, emote
composer with asterisk syntax highlighted live during composition.

**Rationale:** The trap is over-styling. Players will read enormous quantities of text
and the chat log is the most-used surface in the game. Legibility beats atmosphere on
that surface specifically.

### D-307: Audio — sparse and event-driven

**Decision:** Ambient loops per area type (wind over ruins, water in caves, market
murmur, rain on stone). Music is **sparse and event-driven**, not continuous. Distinct
cues for mechanical beats: hostility declared, theft detected, disguise pierced.

**Rationale:** near-silence is more oppressive than a constant score, and cheaper.
Highest atmosphere return per unit of effort in the project.

### D-308: Palette and tone rules

**Decision:** Desaturated, restrained base palette with light as the only real colour
source. Gore present but not gratuitous — implied violence reads darker than depicted
violence. Beauty exists but is rare, and is usually a ruin.

---

## Phase 4 — Rendering (supersedes the sprite pipeline)

> Validated by a working prototype before adoption, not adopted on argument.
> See `prototypes/procedural-characters.html`.

### D-401: Procedural runtime 3D, rendered to a pixel-quantised isometric view
**SUPERSEDES D-108 (PixiJS 2D) and D-304 (3D pre-rendered to sprite sheets).**

**Decision:** The client is a real-time 3D renderer (Three.js) using an **orthographic
camera at an isometric angle**, rendering to a low internal resolution (~320×200) which
is then palette-quantised with ordered dithering and upscaled with nearest-neighbour
filtering.

The game still *reads* as isometric pixel art. It is no longer *made of* pixel art.

**Rationale:** the sprite plan spent its whole life fighting art volume. Procedural
generation does not mitigate that problem, it deletes it. Characters are built from a
parameter vector at runtime; animation is a function of time; equipment is more
geometry parented to the same bones.

**Validated by prototype — measured, not assumed:**

- 6 characters + terrain = ~6,600 triangles
- Ran at 30fps on a *software* rasteriser with no GPU, in a headless container
- **Entire deliverable is 540KB including a bundled copy of Three.js**

**The style and the technique are mutually reinforcing.** At ~80px character height,
the flaws that make procedural animation and primitive geometry look bad fall below the
resolution of the image. The pixelation is not only an aesthetic choice — it is an
error budget.

**Reference precedent:** Rain World (fully procedural animation, excellent result),
Spore (procedural rigging and gait from arbitrary assembled parts). Note that Children
of Morta is hand-drawn and Noita is a 2D falling-sand sim — they are precedent for the
*look*, not the technique.

### D-402: Characters are generated from a seed plus archetype-constrained parameters

**Decision:** A character's appearance derives deterministically from an integer seed
stored on the character record. Proportions, bulk, limb ratios, colours, and equipment
presence all follow from it.

**Critical:** generation is constrained by **hand-authored archetype ranges**, not
uniform random. Pure random generation produces mush; constrained ranges produce
recognisable silhouettes.

**Rationale:** this is the direct answer to "procedural output looks samey." It is also
why D-219's silhouette-based recognition works — archetypes *are* silhouettes.

### D-403: Cloth and hair are verlet chains solved per frame

**Decision:** Capes and hair are position-based verlet simulations with distance
constraints and a body collider, driven by gravity and wind. No physics engine.

**Rationale:** roughly a hundred lines each. A rigid-body engine would be a dependency
and an operational cost for a problem that does not need one. Wind is already a
first-class world variable under D-305, so cloth reacts to weather for free.

### D-404: Palette quantisation is the art direction

**Decision:** A ~24-colour palette — warm-neutral ramp, cold shadow, firelight ramp,
skin — applied as a post-process with 4×4 ordered dithering.

**Ordering matters and was learned the hard way:** exposure and vignette must be applied
*before* quantisation. Applying them after pushes colours back off the palette and undoes
the effect entirely.

**Consequence:** art direction is now a parameter that changes in seconds, not an asset
someone has to redraw. Retuning the world's entire mood is a palette edit.

### D-405: Problems that cease to exist

Recording these explicitly so nobody re-solves them:

| Former problem | Status |
|---|---|
| Payload — GB of sprite atlases, on-demand streaming, aggressive caching | **Gone.** Geometry is generated client-side. |
| Per-facing / per-frame depth sorting; cloak and pauldron bleed-through | **Gone.** The z-buffer does it. |
| 8 directions; mirroring flipping weapons to the wrong hand | **Gone.** Facings are continuous. |
| Emote vocabulary capped by the purchased animation set | **Gone.** Each emote is ~8 lines. |
| Equipment × body-type render multiplication | **Gone.** Equipment is geometry on shared bones. |
| Asset licensing, EULA negotiation, live-service redistribution risk | **Gone.** We own everything. |
| Style drift between purchased art and custom renders | **Gone.** One source. |

**Financial consequence:** the PVGames purchase recommended in `ART_SOURCING.md` is no
longer required. That document is retained as a record of the market survey and the
reasoning, not as a live recommendation.

### D-406: What the prototype did NOT prove

Stated so it is not overclaimed:

- Character geometry is deliberately crude boxes. Production needs better primitive
  composition, chamfered forms, and more parts per limb.
- Performance was measured on a software rasteriser with 6 characters. **Not** validated
  at 20-40 visible characters on real hardware.
- Lighting and palette were tuned by the author reviewing screenshots — a poor
  substitute for the stakeholder's eye. Art direction remains unratified.
- No terrain streaming, no equipment swapping at runtime, no LOD, no mobile testing.

### D-407: Architecture unaffected

**Decision:** D-102 through D-107 stand unchanged. The server never knew how the client
draws.

**Consequence:** D-305 (light and weather as mechanical inputs) becomes substantially
easier — it is now genuine lighting rather than a shader faked over flat sprites.

---

## Open decisions

Non-blocking, carried forward:

- Respawning empty-handed while the animated corpse retains all equipment (D-224)
- Duration cap on animated corpses (D-224)
- Speak With Dead behaviour when the dead player has logged off (D-204)
- Which 8-10 classes ship at launch (D-208)
- Art direction ratification against the prototype (D-406)

**Resolved:** the working title is settled — **Regnum Confractum**, the broken realm.
It suits D-302's decayed empire, and it is original naming, which D-209 requires.

**Resolved elsewhere:** milestone sequencing and the first playable slice are now
specified in `BUILD_PLAN.md`.

---

## Phase 5 — Implementation record

> Decisions made while building, appended per the ADR convention. These are
> narrower than design decisions but are recorded for the same reason: an
> unwritten choice will be re-litigated.

### D-501: Node 22 + npm; tsx execution, no build step; path-alias monorepo

**Decision:** D-105 left "Bun or Node" open. Resolved to **Node 22 with npm**:
the development machine has Node 22 installed and Bun absent, and nothing in
the design needs Bun. All code runs from TypeScript source via `tsx` — dev
server, Docker image, migration CLI alike — with `tsc --noEmit` as the type
gate and Vitest as the test runner. There is no compile step to orchestrate
and no `dist/` to drift from source.

**Monorepo shape:** a single npm package with multiple source roots
(`shared/`, `server/`, `sim/`, `tools/`) joined by `@rc/*` path aliases in one
root `tsconfig.json` — not npm workspaces. One `npm install`, one typecheck,
one test run. The D-105 requirement stands in substance: the wire protocol
lives only in `shared/src/protocol.ts` and a shape change breaks the
typecheck on both sides.

**Reversal cost:** LOW. Introducing real workspaces or a build step later is
mechanical; the import paths would not change.

### D-502: M0 conservation invariants are enforced in the store, verified by bots

**Decision:** Item and coin transfer are single atomic operations on the
Store interface (`transferItem`, `transferCoin`) — a conditional UPDATE and a
transaction with lock ordering in Postgres. Game code cannot express
"duplicate an item" because ownership mutation only exists as a
transfer-or-fail primitive. Headless bots (D-114) then verify the invariants
end-to-end over real WebSockets: racing double-gives, overdraw attempts,
mirror-vs-snapshot desync checks, and restart survival.

**Also locked by test:** the event log's append-only property is enforced by
a Postgres trigger and there is a test that attempts UPDATE/DELETE and
expects rejection.

### D-503: M1 renderer — wire carries the appearance seed; walls are ruined stubs

**Decision (wire):** `WireEntity` carries `appearanceSeed`, so every client
generates identical appearance geometry from the character record (D-402)
with no asset transfer. Appearance generation and movement interpolation are
pure modules under `client/src/game/`, tested headlessly in CI; Three.js code
is confined to `client/src/render/`.

**Decision (walls):** wall tiles render as knee-to-waist rubble stubs, not
full-height walls. At the isometric camera's ~34° elevation a wall of height
h occludes ~1.5h tiles of floor behind it, and full-height walls fully
swallowed characters standing beside them. Stubs can never hide a person and
suit the decayed setting; proper tall walls need a camera-side cutaway,
deferred to the M5 area pipeline.

**Fog lesson, second occurrence:** the prototype's fog band (19→40) was
correct for its ~6-unit stage but washed the game's ~13-unit visible field to
black; the band is now 24→48. Rule of thumb recorded: fog near must exceed
camera distance PLUS the visible field radius.

**Verification hook:** the client exposes `window.__rc` (step one frame, dump
entity mirror) so automated checks can pump frames and read canvas output
without relying on requestAnimationFrame. First-light capture:
`docs/media/m1-two-players.png`.

**Still open (D-406):** art direction is implemented but NOT ratified — the
stakeholder has not yet judged the look by eye.
