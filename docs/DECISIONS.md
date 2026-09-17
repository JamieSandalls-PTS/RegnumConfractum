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

- ~~Respawning empty-handed while the animated corpse retains all equipment (D-224)~~ — resolved zone-dependent in D-511
- ~~Duration cap on animated corpses (D-224)~~ — resolved in D-511
- ~~Speak With Dead behaviour when the dead player has logged off (D-204)~~ — resolved in D-511
- ~~Which 8-10 classes ship at launch — depends on setting~~ — ratified in D-511
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

- ~~Respawning empty-handed while the animated corpse retains all equipment (D-224)~~ — resolved in D-511
- ~~Duration cap on animated corpses (D-224)~~ — resolved in D-511
- ~~Speak With Dead behaviour when the dead player has logged off (D-204)~~ — resolved in D-511
- ~~Which 8-10 classes ship at launch (D-208)~~ — ratified in D-511
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

### D-504: Art direction — partial ratification, and per-area lighting profiles
**Progresses D-406.**

**Stakeholder verdict on the M1 render (2026-08-16):** the dark, grim look is
right *for an underground or enclosed location* — the test render "seems like
a cave." Outdoor and bright locations must read much brighter and more
colourful. Not worth deep investment in the look yet; **models and animations
need work** (matches the gap D-406 predicted — tracked as its own work item,
not blocking systems milestones).

**Decision:** areas declare a `lighting` profile in their content file
(`overcast`, `night`, `underground`, `interior` — extendable). The client maps
the profile to hemisphere/key/rim intensities, background and fog. This slots
directly under D-305 (light and weather as mechanical inputs): time-of-day and
weather will later modulate the same parameters. A handful of brighter,
still-desaturated entries were added to the palette so daylight scenes have
somewhere to land (D-404: mood retuning is a palette edit, and D-308's
restraint still applies).

### D-505: M2 core implemented — names leave the wire; speech is per-observer

**What is built (the roleplay core's spine):**

- **Names are no longer objective wire data.** `WireEntity` carries a
  per-observer `descriptor` — a learned name, or a generated description of
  what the observer sees ("a broad, heavy-built figure in worn cloth").
  Snapshots and arrival events are personalized per connection; movement and
  emotes stay broadcast because they are objective.
- **Proximity speech** — whisper (1 tile), say (10), shout (40) — with
  Bresenham line of sight; whispers and speech require sight, shouts carry
  around walls attributed to "a voice from somewhere unseen".
- **Name declaration** (D-218): an explicit `declareAs` flag on speech. The
  claimed name — true or false — is stored per listener with provenance
  `self_claimed`. Contested per listener (D-219): Insight+d20 vs Bluff+d20;
  win by 6+ reads a lie with certainty, narrow margins are noisy in both
  directions (12% within ±2). The wire message shape is identical whether or
  not a declaration fired, verified by test — the mechanic is invisible.
- **Emotes** (D-202): asterisk spans parsed against
  `content/emotes/lexicon.json` (synonym groups, negators — "*doesn't
  laugh*" does not laugh). Postures (sit/kneel/stand) persist on the entity
  and appear in late joiners' snapshots; transients (bow, wave, laugh, point,
  shrug) play once. Movement returns posture to standing.
- **Chat is fully logged** in the event log, including declarations and their
  truthfulness (D-215) — moderation is an evidence problem.

**Deliberately deferred from this slice (still M2 scope, next in line):**
languages (scrambled when unknown); in-world writing (books, notes, letters
as items); hooded/disguised presentation states and the thread-merge on
pierce (the data model — knowledge keyed by observer × subject ×
presentation — is already shaped for it); third-party introductions
("this is X"); live emote highlighting in the composer.

### D-506: M2 completed — languages, writing, hoods, introductions, the tavern

**Languages.** Speech carries a language id; the speaker must know it.
Listeners without it receive text scrambled **server-side** — the original
words never reach their client, so no client mod can un-hear a tongue.
Scrambling is deterministic per (language, word): recurring words stay
recognisable across sentences and speakers, making the sound of a language
itself roleplay material. Emote spans pass through — actions are seen, not
heard. **Names propagate only through comprehension**: a declaration or
introduction in a tongue you lack teaches you nothing.

**In-world writing.** `/write` consumes one parchment (base material — the
writing sink) and creates a `written-note` item carrying title and text in
`items.data` (migration 0003). Notes are given hand-to-hand like any item and
read only by their holder. Authorship is deliberately NOT recorded on the
wire: a signature is just text you chose to write, which makes forgery
(D-213's stealable coordinates, unsigned threats, planted letters) native.
The full text is logged in the event log (D-215).

**Presentation threads.** `set_presentation` toggles normal/hooded. A hood
hides face and hair; build stays readable (archetypes are silhouettes,
D-402/D-219). Names declared while hooded attach to the hooded thread.
**Lowering the hood in an observer's line of sight is the pierce**: that
observer's hooded thread merges into normal — the normal name wins a
collision, and the hooded row is deleted. Limitation, recorded: one name per
thread means a merge discards the hooded alias when both exist. Active
piercing (Perception vs Disguise, at range, without consent) waits for M4's
skill system.

**Introductions.** `introduce` on speech attaches a name to a present target
for every comprehending listener, provenance `third_party`, never
overwriting a held name. Misattribution is possible by design (D-201).

**The tavern.** `hanged-ferryman` (64×64): common room with bar, snug and
pillars, street outside with well and crates — the first-slice stage. New
characters start there. Tile kinds grew `wood` and `table` (waist-high:
blocks movement, not sight). Interior lighting profile brightened after the
same albedo lesson a third time: mid-tone sources or the palette starves.

**Now missing for the full first slice:** nothing mechanical. The go/no-go
test (two writers, ninety minutes) is a human evaluation. Area transitions
(D-103's graph edges) are the next engineering gap — characters currently
stay in the area they spawned in.

### D-507: M3a — transitions, NPCs, the Lua sandbox, and the DM verbs

**Area transitions (closes the D-103 gap).** Areas declare transition tiles
in content (`{x, y, toArea, toX, toY}`), cross-validated in CI (target area
exists, both ends walkable). Stepping on one despawns, respawns, and
snapshots the player in the linked area; the hood survives the door; the
position write is immediate. The yard and the tavern are now linked, and
exits render as worn threshold stones.

**NPCs.** Connectionless world entities (`characterId: null`, wire kind
`npc`) with one fixed public descriptor for every observer. Deliberate
simplification, recorded: NPCs are outside the recognition system for now —
no per-observer names, no disguises. Revisit when NPCs matter socially
(named innkeepers, D-216 recurring characters).

**Sandboxed Lua (D-109).** wasmoon (Lua 5.4 in WASM), one engine per
scripted area, `os/io/require/load/debug/package` stripped before any script
runs. The controlled API: `spawn_npc, despawn, say, move, narrate,
narrate_global, set_lighting, player_count, game_hour, log`, plus triggers
`on_enter`, `on_player_count` (fires on the crossing, re-arms when the crowd
thins), `on_hour`, and `delay`/`every`. **All time is server ticks** — never
the wall clock — so scripted worlds replay deterministically (D-114). The
game clock runs a 48-minute day (1200 ticks per game hour). Script errors
are logged and contained; a broken script cannot take the server down, and
later scripts still load. Possessed/scripted speech goes through the same
pipeline as players — earshot, sight, languages, emote parsing all apply.

**DM verbs (first slice of D-216).** Token-gated POST endpoints on the admin
server — spawn-npc, despawn (NPCs only; players cannot be despawned), say
(possession), move, narrate (area/global), lighting — with forms in the
admin UI. Every DM action lands in the event log.

**Deferred to M3b:** the visual form-based event editor (DMs must not write
code), trigger persistence, rehearsal mode, event templates, rollback,
entity-death and item-acquired triggers (need M4's combat/death), invisible
DM observation, and DM-authored trigger chains from the console.

### D-508: M3b — the DM event system

**Design call:** the "script underneath" the form editor (D-216) is a
**declarative event document**, not generated Lua. A document is
schema-validated before it can run, every spawn it makes is tracked for
rollback, and a rehearsal is just a run that announces itself. Lua remains
the power tool for content authors; events are the DM's instrument.

**The model:** an event is a chain of stages; each stage waits for its
trigger — immediate, at_hour (48-min game day), after_seconds,
player_count, entity_death — fires its actions — narrate, spawn_npc,
npc_say, set_lighting, spawn_area, despawn — and arms the next. Spawned
areas and NPCs bind `$alias` names later stages reference. Temporary areas
clone a content area under a run-scoped id and link into a host area via a
runtime way-marker; players present see the marker appear, and rollback
evacuates them before the area vanishes.

**Persistence:** documents live in `dm_events` (migration 0004), duplicable
in place — that IS the template library. Runs are in-memory: a restart
clears live runs (acceptable: a DM re-runs the event; revisit if events grow
long-lived). Every start/stage/rollback is event-logged.

**Rehearsal, honestly stated:** BUILD_PLAN imagined rehearsal against a
staging server. With one server, rehearsal = run now, prefixed
`[rehearsal]` in every narration, one-click rollback. True staging rehearsal
becomes possible when the VPS exists.

**M3 done-when status:** the canonical chain (announce → spawn location →
5-players trigger → spawn warband → warlord-killed → reward) is built in the
editor and verified end-to-end by bots over the admin HTTP API — except the
death stage, which arms correctly and waits on `EventEngine.entityDied`,
wired when M4 gives entities death. **Still open from D-216:** invisible DM
observation, weather control beyond lighting profiles.

### D-509: M4a — combat, the death loop, and the physician dependency

**Combat (D-104, D-206).** Attacks are adjacent, cooldown-paced (2s), damage
2–6 from the seeded server rng. Zones enforce the PvP tiers: NPCs are fair
game anywhere; players in **settled** areas can only be struck after the
attacker has *declared hostility* — a spoken threat delivered through the
real speech pipeline and logged verbatim — and the 10-second warning window
has fully elapsed. Declarations expire after 5 minutes. The yard is
wilderness (open PvP); the tavern is settled.

**The death loop (D-203).** At 0 hp: the living watch you fall
(`entity_died`) and perceive you no more; you continue as a ghost in a
partitioned plane — **every delivery path (snapshots, deltas, speech,
arrivals) partitions on the ghost flag in both directions**, bot-verified,
so a dead player can never scout for the living. Death adds 100 debt
immediately (immediate DB write); XP earned later pays debt before it
advances the character. After the minimum ghost time, `respawn` wakes you at
the town spawn on full hp. Ghosts do not persist across sessions: logging
out dead means waking at the spawn next login, debt already banked
(pragmatic call — revisit if ghost-time roleplay matters).

**Injuries (D-205).** Hits roll wounds — located (head/torso/arms/legs),
typed (cut/pierce/blunt), tiered. **Major wounds bleed** (1 hp per wound per
30s) until treated, **and cannot be self-treated** — the physician
dependency is mechanical, not suggested. Treatment consumes the treater's
bandage. Death scars major wounds down to minor.

**Completes M3:** the warlord-killed stage of the canonical event chain now
fires via `onEntityDeath → EventEngine.entityDied`, bot-verified.

**Deferred to M4b:** classes and skills (D-208 — WHICH 8-10 classes remains
an open stakeholder decision), Legacy Points and voluntary permadeath
(D-207/D-222), spirit interactions (D-204: Speak With Dead, Animate Dead,
corpses as objects per D-224), endgame permadeath zones, richer injury types
(burn/frost/venom/rot/curse) and treatment paths, active disguise-piercing,
Lua on_death.

### D-510: Voluntary permadeath and Legacy Points implemented

**Decision:** `retire` ends a character permanently (ghosts may retire too —
walking into the dark instead of respawning). The account earns Legacy
Points: `floor(√xp) + floor(√deeds)`, multiplied by `1/(1 + 0.5 ×
priorRetirements)`, minimum 1. **Deeds** are the D-222 anti-idle measure:
a counter of meaningful actions (speech +1, kills +5, area travel +1),
accrued live and persisted with vitals — wall-clock time earns nothing.
Points live on the ACCOUNT; retired characters vanish from the character
list and can never be entered. Renown weighting joins the formula when
renown exists (M5+). Nothing is yet purchasable with points — the spend
side (RP-locked classes, D-207) arrives with the class system, and the
hard rule is restated here: **access and flavour, never raw power.**

### D-511: Stakeholder ratifications — class roster, corpse rules, zombie limits, SWD reach
**Resolves the open items of D-204, D-208 and D-224. Ratified by the
stakeholder 2026-08-17.**

**The launch class roster (D-208) — ratified.** Nine classes, names being
original-noun placeholders open to later renaming:

| Class | Role | Notes |
|---|---|---|
| Man-at-Arms | armoured melee | |
| Berserker | aggressive melee | |
| Hunter | ranged / wilderness | |
| Shade | stealth / larceny | |
| Magus | arcane | |
| Bonespeaker | necromancer | Speak With Dead, Animate Dead. **Legacy-locked.** |
| Vessel | shaman | Plane Shift, perceives ghosts. **Legacy-locked.** |
| Physician | treatment | the D-205 dependency |
| Cantor | priest | divine healing, curse-breaking |

Two of nine are Legacy-locked (D-207 spend side).

**Animate Dead gear is zone-dependent (D-206 tiers).** In **settled** areas
the zombie inherits the character's looks, stats and gear *score* but is a
cosmetic copy: it **cannot be looted**, and the player respawns with their
loot intact. In **wilderness** (and endgame) zones the harsh rule applies:
the zombie wears everything carried at death, the player respawns
empty-handed, and the gear drops where the zombie is destroyed. The
hunt-your-own-corpse quest exists exactly where players chose the stakes.

**Zombie limits.** Maximum duration for an animated corpse is **3 hours of
real play time** (tick-counted, per the one-clock rule). Concurrent zombies
per necromancer scale with skill level, **maximum 3** at the highest.

**Corpse persistence (new, extends D-224).** Player corpses do not vanish
on death: a corpse remains **at minimum the length of the respawn timer**.
When a corpse despawns un-animated, anything it held is left **on the
ground for 1 hour** (tick-counted) before server cleanup.

**Speak With Dead out of reach (D-204).** When the target's player is
offline or already respawned, the caster receives a **distinct "the spirit
is beyond reach" result** — different from a reachable ghost who chooses
silence. Chosen with the status-leak trade-off stated and accepted.

### D-512: M4b spirit interactions implemented — corpses, séances, animation, class scaffold

**Corpses are world entities.** Death spawns a `corpse` entity in the living
plane at the fall (wire kinds `corpse`/`pile` join the protocol, v2). A
`corpses` table persists them; **items may now be owned by a character OR a
corpse** (one-of constraint) — the first non-character item owner, moved in
bulk by the same atomic-update argument as `transferItem`. Corpse life is
tick-counted with the remainder persisted on transitions: a restart can
lengthen a corpse's life but never destroy items. Corpse decay is clamped to
≥ the ghost minimum (the D-511 "at least the respawn timer" rule); decay
leaves a lootable `pile`; the pile's hour ends in **deliberate, logged
destruction** (`corpse_loot_cleanup` records every item) — the one item sink.
Corpses resolve descriptors through the same per-observer knowledge as the
living: you recognise a corpse only if you knew the face (D-219 applies to
the dead).

**Séance = the one sanctioned plane crossing, speech-only, logged.** Speak
With Dead pulls the ghost to its body (`transferToArea`, plane preserved),
opens a 5-question bridge: caster questions cross to the spirit; answers come
back **out of the corpse's mouth** via the ordinary speech pipeline, so
bystanders hear them and language rules apply. Every question and answer is
in the event log. Beyond-reach is the distinct error `beyond_reach` (D-511).

**Animate Dead.** The corpse entity becomes a `zombie` (wire kind `npc`,
descriptor "the walking corpse of ⟨as-you-knew-them⟩") that shambles after
its necromancer. Duration and the skill-scaled concurrency cap
(`1 + floor(necromancy/40)`, max 3) per D-511. Destruction drops held gear
as a pile. The **undead register is a content language** (`undead`) that no
character speaks — the existing scrambler garbles it for every listener,
displays "unknown", and the event log keeps the original words. The riding
owner hears what the body hears and speaks through it; never forced (D-224).

**Class scaffold (D-208).** Classes are schema-validated content
(`content/classes/*.json`): role, ability grants, `legacyLocked`. The nine
D-511 classes are authored. Abilities gate `speak_dead`/`animate_dead`
server-side. **PLACEHOLDER: legacy-locked classes require ≥1 Legacy Point at
creation with no deduction — pricing awaits stakeholder ratification.**
Characters gain `class_id` and a `necromancy` skill (0-100, bluff/insight
precedent).

**Plane-partition hardening.** Three pre-existing unpartitioned broadcasts
(emotes, speakAs emotes, presentation changes) and three `entity_left` paths
now partition on the actor's ghost flag — a ghost emoting no longer reaches
living clients.

**DM verbs added:** `grant-item` (testing faucet; production goods still
enter only via play, D-220) and `set-skills`, both in the admin UI.

**Bot coverage:** `sim/test/m4c-spirits.test.ts` — 17 tests: zone-dependent
gear rules, looting, the full séance including a lying answer, beyond-reach,
ability gates, the cap, following, riding, gear drop on destruction,
decay→pile→cleanup with conservation asserted throughout, and the
legacy-lock creation gate.

### D-513: Endgame permadeath zones implemented — the fall, the hand, the end

**The entry is a two-step ritual (D-206's unmissable warning).** Stepping
onto a way-marker whose target is an endgame area does not cross — it warns,
in plain words: FINAL DEATH, no ghost, no respawn. Stepping off and back on
within 30s confirms. Ghosts pass unchallenged; they have nothing left to
lose.

**Falling opens a window instead of a grave.** At 0 hp in an endgame zone
you are **downed**: no ghost, no death debt, a kneeling body the living can
see. You may speak — last words matter — but every other action is locked,
**retirement included** (no buying a Legacy award out of a death you were
about to lose; logging out is finalized as death, not escape). Another
player adjacent may `revive` within the window (default 60s, tick-counted,
`reviveWindowTicks`); revival restores quarter hp and counts as a weighty
deed (D-222). A blow struck while you are down is an **execution** — the
window slams shut.

**The window closing is the end.** Involuntary retirement: the character is
gone, a corpse remains wearing everything carried (endgame zones use the
wilderness gear rule), and the account is awarded **zero Legacy Points**.
⚠ **The zero-award ruling follows the recorded recommendation but has NOT
been explicitly ratified by the stakeholder** — if an ending should always
seed a beginning (D-207's spirit), this is the entry to supersede.

**Content:** the first endgame area is authored — `sunken-crypt`, linked
from the broken-yard's south end, underground lighting.

**Bot coverage:** `sim/test/m4d-endgame.test.ts` — 6 tests: warn-then-commit
entry, the downed state (speech yes, action no, retire no), revival, the
bled-out ending with zero award and lootable corpse, conservation, and the
character's permanent disappearance from the account.

### D-514: Graphics/UI pass — mouse control, hotbar, camera, character v2, the viewer

**Requested by the stakeholder 2026-08-17** (six items, verbatim priorities);
began the post-M4 "basic UI before M5" ruling early at their direction.

**Mouse control.** Left-click a tile walks there via client-side A*
(`client/src/game/path.ts`, movement rules mirroring `World.moveTarget`
exactly, unit-tested); the executor re-plans from the current tile every step
so queued-intent drift cannot derail it, and WASD always overrides. Hovering
highlights the tile (outline) or entity (ring); left-click an entity selects
it (target frame + brighter ring). The server validates every step — the
mouse only chooses intents (D-102 intact).

**Right-click menus.** Contextual actions filtered by target kind: players
(Examine/Attack/Treat/Revive), NPCs, corpses (Loot/Speak with dead/Animate
dead), piles, self (hood, respawn as ghost), bare tiles (walk here). All
entries send existing wire messages; nothing new server-side.

**Action bar.** Nine slots on keys 1–9, an ability drawer to drag from,
slot-to-slot swaps, double-click to clear, layout persisted in localStorage.
Abilities act on the selected target, else a sensible nearest. The old 1–4
equipment-debug keys are gone (the viewer now owns that job).

**Camera.** Wheel zooms the ortho frustum (clamped ×0.55–×2.2); holding
left-click and dragging orbits azimuth with easing. Orbit radius is constant,
so the fog-vs-camera-distance contract (CLAUDE.md) holds at every angle.

**Character v2.** Appearance gains `sex`, `hairStyle`, `hairColor` — drawn
AFTER all original fields, so existing seeds keep their silhouettes and the
recognition descriptors are untouched (descriptions stay build-based;
gendering them is an open stakeholder question). Sex-derived proportions
(shoulder/hip/waist ratios) are computed in the renderer from the neutral
parameters. Bodies use capsules and tapered cylinders (waist, chest taper,
shoulder caps); hair is a SOLID fitted cap/shell plus chunky verlet locks
(crop/bob/tail/long) that wobble; the female build carries a sprung chest
(critically damped, ±3cm clamp — secondary motion, not a gag). Animations
cross-fade over 0.22s on every switch, one-shot emotes play from their own
start with a sine envelope, and the walk's knee snap (clipped max()) became
a raised-cosine hump.

**The viewer** (`/viewer.html` on the dev client) shows 12 seeded characters
with animation/filter/lighting/equipment/hood/slow-mo controls, quantised or
raw rendering, drag-orbit and zoom, and every on-screen seed listed for
reproducible feedback — the stakeholder's art verdict (D-406) can now be
given against living examples. **Verified live in the browser:** click-to-move
pathing around water, the context menu, hotbar, orbit and zoom, and the
viewer page itself.

**Review round 1 (stakeholder, same day) — applied:**
- **Joint sign convention fixed.** The model faces +Z; for hanging children,
  `rotation.x > 0` swings BACKWARD. Knees had it inverted (bird legs), and
  sit/kneel were built on the inverted convention — all leg animation
  rewritten: knees hinge back, sitting thighs point forward with shins down,
  kneeling is one knee down/one foot planted. This is documented in a comment
  block above the anims so it is never re-guessed.
- **Sword gripped properly:** rotated ~90° out of the fist, blade pointing
  forward and slightly down.
- **Compound torso:** flattened ribcage + trapezius slab + pectoral plates
  (male) / sprung bust (female) + three abdominal bands on the waist front.
- **Tapered limbs:** every segment is joint-ball + top-heavy tapering
  cylinder (thigh thick at top, calf bulge to ankle, deltoid to wrist).
- **Wave** rises fast and holds the hand clearly overhead; **shrug** now
  lifts the shoulder JOINTS (pose snapshots carry shoulder height so the
  cross-fade covers it).
- **Hair rebuilt:** volumetric flattened cap + brow fringe; bob from cheek
  and back slabs (no helmet-band artefact); locks are overlapping tapered
  capsules on the verlet chains; tail gets a visible gather.
- **Viewer:** pixelation degree slider (1–6; the game ships at 4).

**Review round 2 (stakeholder, same day) — body fidelity, applied with a
closed visual loop.** The viewer gained an automation hook (`window.__viewer`:
solo a seed, set animation/camera/pixelation, advance fixed frames, POST the
canvas to a local receiver — the D-503 technique) so renders could be
INSPECTED from front and side and iterated like an artist would, without the
browser pane compositing. Five look-adjust cycles produced:
- **Torso as three lathe-turned volumes** (pelvis/abdomen/ribcage) with
  MATCHING seam radii, flattened front-to-back — no stacked-primitive
  creases. The ribcage stops below the neck root (an early iteration buried
  the head — caught on camera). One cloth material across the torso so the
  body reads as a single garment; metal is reserved for armour.
- **Soft masses over the volumes:** abdominal swell, pectoral plates / the
  sprung bust, trapezius saddle; **deltoids ride the arm bone** and tuck
  into the chest edge (they read as puffed sleeves hovering at the joint
  until moved).
- **Feet:** rounded heel + 45°-spun 4-sided frustum toe wedge — a shaped
  boot, not a rectangle.
- **Proportion calibration from screenshots:** shoulder span compressed
  toward ~2.5–3 head-widths (heroic seeds rendered past 4), male hips
  clearly inside the shoulders, a body-width floor so slight seeds keep
  human hips instead of sticks, arm length capped near mid-thigh, no
  hanging crotch dome.
Verified at review distance AND at game quantisation (grid of 12, swords
reading correctly, silhouettes distinct). The capture loop is reusable —
`scratchpad shot-receiver` + `__viewer.shoot()` — and documented in HANDOFF.

**Review round 3 (stakeholder, same day) — applied via the same loop:**
- **Shoulders joined to the torso:** the ribcage lathe HOLDS full width
  through the shoulder line before rounding over, reaching out to meet the
  deltoids, which are wider, flatter, and buried into the chest edge.
- **Bust enlarged and properly sprung:** bigger volumes, and the spring is
  now underdamped (stiffness 90 / damping 8, ±5cm vertical and ±3.5cm
  fore-aft clamps) with stronger coupling to torso motion — the walk bob and
  posture changes produce visible follow-through, not a hidden tremble.
- **Pelvis V-drop:** the lathe centre descends past the hip joints so the
  crotch reads as trousers meeting between the thighs, not a ball underside.
- **Arms shortened** (0.36·H, limb-seed influence damped to 0.4).
- Viewer automation gained close-up zoom below the game clamp.
Known nits carried to the next round: the hair fringe reads as a visor on
some seeds, hands are still simple palms, belt line sits high on some
builds.

**Review round 4 (stakeholder: "put more effort in — judge against real
human front/side references") — three measured cycles:**
- **Cycle A (skeleton calibration against 7.5-head anthropometry):** the
  shoulder joints were ~15cm LOW (at armpit height), which had been
  lengthening the neck and the apparent arms all along. Raised to just
  below the chest top; arm length set to 0.31·H (wrist at crotch) with the
  real 55/45 upper/forearm split instead of 50/50. Hair cap enlarged,
  raised, and re-segmented — the bald patch was the cap terminating level
  with the cranium crown; the plank fringe became a curved brow shell
  (sphere section centred on +Z — three.js phi convention noted).
- **Cycle B (from A's renders):** the belt read as a floating hoop → strap
  hugging the waist seam; bare pale forearms read as oven mitts → cloth
  sleeves to the wrist, hands alone skin; flat-slab side profile → pecs
  proud of the ribcage; the bob's box back-panel left a squared nape →
  squashed-sphere mass.
- **Cycle C (from B's renders):** slim seeds' bust vanished frontally →
  larger, slightly hung volumes (0.21·bodyW); cowboy thigh-gap → hip
  joints tucked to 0.24·hipW with thicker thigh tops.
Signed off against front and side captures of male 1001 and female 1011,
the walk mid-stride, and the quantised game-distance grid.

**Review round 5 (stakeholder: "take it a tier further, even if more
work") — the detail tier, plus the cape bug:**
- **Cape origin fixed:** the cloth pinned its top row to the chest BONE's
  origin, which is the waist seam — the reported cape-from-the-waist bug.
  A dedicated `capeAnchor` joint between the shoulder blades now carries
  the pin; verified hanging from the upper back on a caped seed.
- **Faces:** deterministic per seed — eye whites with hair-toned irises,
  tilted brows, a three-sided nose prism, a shaded mouth line. At game
  distance they read as the dark pixels a face needs; up close they are
  honest features.
- **Hands:** palm + gently curled finger mass + opposable thumb per side,
  replacing the mitt spheres.
- **Cloth folds:** the garment lathes take a radial ripple displacement
  (seed-phased, strongest toward the hem) with recomputed normals —
  trousers and tunic catch light like cloth. The belt was re-proportioned
  to stay proud of the rippled surface beneath it.
Next candidates when this returns: focus-height control in the viewer for
true head close-ups, fold shading at quantised distance, finger separation.

### D-515: Character creation, split pixelation, and speech bubbles

**Requested by the stakeholder 2026-08-18**, after ratifying the round-17
model work ("the preset body types look good") with one correction: the
brute preset's bust was ~50% oversized. Bust volume now tracks body width
only up to a cap, so heavy builds no longer scale the chest linearly.

**Character creation is a five-step wizard (D-208's first real form):**
calling → skill allocation → feats → spells (casters only) → name. It is
the first system where the player composes a character rather than
receiving one.

**All four catalogues are CONTENT, not code** (D-110): `content/skills/`,
`content/feats/`, `content/spells/`, plus new fields on the nine authored
classes (`affinities`, `spellcasting`). The client renders whatever the
server's `creation_content` message contains, so adding a feat is a data
change and a client deploy is never required. The content validator
cross-checks every reference — a feat naming an unknown skill, a spell on a
non-casting class, or a casting class with an empty spell list all fail CI.

**Legality is decided once, on the server** (D-102). `validateBuild()` lives
in `shared/` and is called by BOTH sides: the client for live feedback
(sliders clamp to the remaining budget, feats grey out with their unmet
prerequisite named), the server as the authority before anything is
written. Nine bot tests submit builds a hostile client could hand-craft —
overspent points, off-grid allocations, a feat without its prerequisite, a
feat or spell belonging to another class, magic on a mundane class,
duplicates, unknown ids — and every one is refused.

**Skills reuse the existing 0–100 scale.** bluff, insight and necromancy
keep their own columns because live mechanics read them (D-218 contests,
D-511's zombie cap); creation MIRRORS those three out of the skills map
(baseline + allocation), so each mechanic keeps exactly one source of truth
and no existing reader changed. Migration `0008_character_build.sql`.

⚠ **The creation budget is UNRATIFIED placeholder balance** — 120 points, 40
per skill, steps of 5, two feats, three spells. The numbers are deliberately
legible and centralised in `shared/src/content.ts` for the stakeholder to
overrule. The spell list is small, mundane and low-fantasy by design; there
are no fireballs, and none of the picks make being good cheaper (D-303).

**Split pixelation reinstated as the default render** (supersedes the
uniform-quantiser default in D-404's implementation, not its reasoning).
Characters render on layer 1 through the low-res palette quantiser; the
environment renders crisp. A Graphics settings panel exposes render mode
(split / uniform / raw) and independent pixel scales for characters and
environment, persisted per browser. The lesson worth keeping: lights AND
camera must have `layers.enableAll()` or the split pass renders black —
and the hearth adds its own lights after the scene is built, so the call
happens after terrain construction.

**Speech bubbles draw only what the server delivered.** Range is never
decided client-side: the gateway already filters speech by channel
(whisper / say / shout) and line of sight, so receiving the message *is*
the permission to draw it. A client cannot widen its own hearing by editing
a radius, and a whisper across the room can never appear. Bubbles are DOM
elements projected above the speaker's head, styled per channel, with a
lifetime scaled to text length. Speech from a speaker not in view (heard
through a wall, or a séance voice) stays in the chat log only.

**Split rendering needs a DEPTH pass, not just an alpha composite**
(stakeholder: "the character is always on top of environment objects").
Two render passes mean two depth buffers, so blending the character layer
over the environment made characters float in front of every chair and
wall regardless of where they stood. Both passes now carry a
`THREE.DepthTexture`, and the composite shader discards character
fragments whose depth is behind the environment's at that pixel. Both
passes share one camera and projection, so the raw depth values compare
directly — no linearisation needed. Consequences worth keeping:
- The environment can no longer render straight to the screen (it has no
  depth texture that way); it always goes to a target and is blitted. A
  `uPassthrough` mode makes the crisp-and-unquantised blit byte-identical
  to the old direct render, so turning the palette off changes nothing.
- The character pass is lower-resolution than the environment, so the
  occlusion boundary is quantised to character pixels. That reads as
  correct for the art direction rather than as an artefact.
- `PixelPost.depthOcclusion` exists as a verification switch (D-114): off
  reproduces the pre-fix flat overlay so an automated check can A/B the
  two and prove the depth test is doing work.

### D-516: Combat state, weapon carry, attack animations, and the fall

**Requested by the stakeholder 2026-08-18** to make combat testable by feel.

**Combat is a STATE, and the server owns it.** An entity enters combat when
attacked or when hostility is declared either way (both parties — the
threatened one has every reason to draw), and leaves only when BOTH
conditions hold: nothing violent for `COMBAT_LEAVE_TICKS` (10s) *and* no
hostile within `COMBAT_PROXIMITY_TILES` (20). Two clauses, deliberately: a
timer alone would have players sheathing mid-standoff. The flag rides on
`WireEntity` and changes broadcast as `entity_combat`, so every observer
sees the same stance — "my sword is out and yours isn't" is exactly the
kind of disagreement players notice.

**The state is what makes weapons go away.** Out of combat a sword or staff
rides slung across the back; entering combat draws it. The weapon hangs
off the character ROOT and its transform is interpolated between a hand
anchor and a back anchor each frame, so a half-drawn blade is genuinely
halfway out rather than snapping between parents. The reach over the
shoulder is a pose blended on top of whatever else is playing, and it runs
backwards to sheathe.

**Attack variants are chosen server-side.** Four melee swings (overhead
chop, horizontal slash, thrust with a lunge, backhand cut) plus a caster's
wind-up-and-release. The variant is cosmetic, but a cosmetic disagreement
is still a disagreement about the thing players are watching, so the
server rolls it and ships it in `entity_attacked`. Whether it renders as a
cut or a cast is read from what the attacker HOLDS, which every client
derives identically from the appearance seed — no new server concept of
weapons was needed.

**Projectiles and particles are client-side and decide nothing.** A magical
bolt gathers motes at the stave head, flies a shallow arc with its own
travelling light and a mote trail, and bursts on arrival. A bolt that
visually misses still did exactly the damage the server said (D-102).

**Death is watched, not skipped.** `entity_died` now plays a collapse — the
knees buckle, the torso folds, the body rolls onto its side — and the
visual outlives its entity just long enough to finish falling. Corpses
seen for the first time hold the final frame instead. Lesson worth
keeping: the root rotation that lays the body flat turns every local
Y-offset into a horizontal distance, so continuing to "drop" the pelvis
through the fall buried the body in the floor.

**Bodies can be carried, gated on build.** `carry_body` / `drop_body` are
authoritative: a corpse's burden comes from the dead character's own
generated bulk and height, and a carrier manages
`CARRY_BASE_CAPACITY + athletics`. A carried body follows its bearer each
tick and is set down where they stand; if the bearer logs out or dies it
stays where it is rather than following them into nothing. Inventory
integration is deliberately deferred.

**Cloth fidelity is now tunable for review** (`clothTuning` in cloth.ts):
`fidelity` scales every garment's simulated grid at construction, and
`solverIterations` relaxes the distance constraints per step. The viewer
exposes both, so "make it floppier" is a slider rather than a code change.
At 0.6× a robe is coarse and jagged; at 2.4× with two solver passes it
drapes to the floor.

⚠ **Unratified tuning:** the 10-second/20-tile combat window, the four-swing
roster, and the carry capacity formula are all first-pass numbers chosen to
be legible and centralised, not settled balance.

### D-517: The viewer becomes a tabbed workbench, with live cloth tuning

**Requested by the stakeholder 2026-08-18:** a way to tweak cloth attachment
points, parameters and collisions by hand and export what works — and,
after a first pass, to reorganise the viewer into tabs that "all work
together, each tab just configures a different part of the game".

**One scene, four control groups.** The viewer keeps a single live stage and
splits its panel into **Cast**, **Animation**, **Cloth** and **Render**.
Nothing is duplicated and nothing is modal: changing the animation while
the cloth tab is open still drives the same body, which is the point — the
drape has to be judged in motion.

**Every solver constant became a parameter.** `ClothParams` now carries
gravity, damping, wind response and strength, the body-hug and its hem
falloff, soft-pin strength, per-pass stiffness, iteration count, floor
height and floor friction. `defaultClothParams(layout)` returns exactly
the values that were previously hardcoded in `step()`, so the change is
inert until someone moves a slider.

**Garments are tuned in body-relative units.** The workbench sizes a cape
as a multiple of shoulder width and body width rather than in metres, so a
setting that looks right on one build is not silently wrong on a brute or
a slight rogue. The export carries those relative numbers.

**The lab garment replaces the real one.** While the cloth tab is driving a
cape, the character's built-in cape is suppressed; leaving the tab hands
the body back its own clothes. Tuning a garment that sits next to a second
copy of itself would be useless.

**Rebuild versus live is an explicit distinction.** Grid, cut and bone
changes construct a new solver; physics and collider choices are copied
into the running one each frame. Getting this wrong either drops the drape
state on every slider move or silently ignores geometry edits.

The export is a `GarmentConfig` JSON block, meant to be pasted back and
baked into `CharacterVisual`'s construction — the same loop the model
editor already uses (D-514).

### D-518: Death is a ragdoll, not an animation

**Stakeholder, 2026-08-18:** "apply physics to the model and make them fall
over, with a little force from the direction of the attack" — then, on
seeing a physics-driven rigid fall, "I want them to ragdoll, not just fall
physics based."

**The body is simulated, not keyframed.** Fifteen particles sit at the
joints; bones are hard distance constraints between them; the torso is
cross-braced so it stays a torso rather than folding flat; the floor stops
them with friction. It is the same verlet technique as the cloth (D-403)
and chosen for the same reason — no physics engine, ~150 lines, and it
composes with everything already hanging off the skeleton.

**The simulation drives the rig, not the other way round.** Each frame the
solver runs and then each bone is turned to point at its child particle,
so the cape, robe and hair follow a body that is genuinely being
simulated. While a character is falling or down, the pose/cross-fade
system is bypassed entirely.

**The blow is an impulse on the upper body.** A killing hit shoves chest,
head and shoulders in the direction it travelled (the client derives that
from attacker and target positions); the legs barely feel it, which is
why a struck body turns as it goes down. A death with nobody behind it —
bleeding out, sickness — passes no impulse at all and gravity folds the
body where it stands.

**Traps, each of which cost a cycle and is now covered by a test:**
- Verlet velocity is a per-STEP displacement. Seeding the impulse without
  multiplying by dt launched the body sixty times too fast — fourteen
  metres in a fifth of a second. It is applied on the first step instead.
- The settle check compares this step's movement, which is zero on frame
  one, so the body "settled" before it fell. An age guard fixes it.
- The floor must be the ground the character stood on. Passing the root's
  own height floored the body at hip level and it never fell at all.

**Corpses seen for the first time** build a ragdoll and fast-forward it to
rest, so a body already on the ground is lying settled rather than
toppling in front of whoever just walked in.

`client/test/ragdoll.test.ts` pins the properties that matter: it falls, it
stays out of the floor, bones keep their length, a struck body travels
with the blow and an unstruck one does not, direction is respected, and a
settled body costs nothing and never drifts.

### D-519: Garments are cut to the body, not to nominal height

**Stakeholder, 2026-08-18:** "the cape is not positioned the same on larger
models... whatever position the cape is in for the small body type, it
should be anchored at the same relative Y for the larger body." They also
set the review standard: **all four archetypes, from eight directions.**

**Two independent scaling faults, both measured across 240 seeds:**

1. **The anchor and the length did not track each other.** Leg length
   carries a per-archetype `limb` multiplier, so the point the cape hangs
   from ranges between ~0.76 and ~0.85 of nominal height — but the cape's
   length was a fixed `height × 0.62`. The hem therefore landed in a
   different place on every build: a **54%** spread. The cape is now cut
   from `dims.capeAnchorY`, a rig-derived height, so the hem sits at the
   same point on the leg for everyone (spread 5%).

2. **The cut was driven by bulk.** `shoulderW × 1.6 + bodyW × 0.95` let
   body width dominate, and bulk varies 0.2→0.75 against much smaller
   shoulder variation. A brute's cape was 1.9× its own shoulder span
   against an ascetic's 1.5× — the same garment read as a cloak on one
   build and a blanket on another (**47%** spread). It is now
   `shoulderW × 2.9 + bodyW × 0.25`: cut to the shoulders it hangs from,
   with a modest allowance for girth (spread 6%).

**The collar is a neck ring and is sized off the head.** The old
`max(shoulderW × 0.8, bodyW × 0.42)` both doubled across builds and
switched which term dominated — a discontinuity. On heavy bodies the
pinned ring grew wide enough to carry fabric up around the head, which is
what the stakeholder's screenshot showed. Now `headH × 0.62 +
shoulderW × 0.16` (spread 12%, and continuous).

**The contact sheet was decapitating tall builds.** `sheet()` framed the
camera at a fixed height and zoom, so a 1.97m brute was cut off at the
shoulders — the review tool was hiding the very thing under review. It now
frames from the character's own height.

**The lesson worth keeping:** `appearance.height` is NOT the rendered
height of the rig. Anything that must sit at a consistent point on the
body has to be measured against the SKELETON, and anything that hangs
from the shoulders has to be cut from the shoulder span. Both are now
exposed via `measurements` so the cloth workbench (D-517) uses the same
basis.

`client/test/garment-scale.test.ts` asserts the proportions across 240
seeds spanning every archetype, including the brute-versus-ascetic
extreme. It fails against the old formulas.

### D-520: Stakeholder-ratified cloth settings baked; hood flaps removed

**The workbench loop closed for the first time.** The stakeholder tuned the
cape, robe skirt and sleeve in the cloth workbench (D-517) and handed back
three JSON exports (2026-08-18). Those numbers are now the game's garment
construction — the first art numbers in the project ratified by direct
manipulation rather than by screenshot round-trips.

**Cape:** longer (0.91 of anchor height, near the ankle), a tighter collar
(0.38·headH + 0.16·shoulder), a wider pinned shoulder ring
(1.99·shoulder), 13 columns, and the anchor itself raised, pulled back
off the spine and tilted (−0.28 rad) — baked into the `capeAnchor` joint
so the workbench's zero stays "where the game puts it". Physics: heavy
(gravity −24.5), fast-settling (damping 0.875), wind-responsive, **hug
off** — the body-hug force is replaced by honest collision, with the
collider set extended to the forearms, hands, thighs and shins so a long
cape parts around a swinging arm. Back plane shallower (−0.04·bodyW) and
released higher (0.46·torsoH).

**Robe skirt:** denser grid (22×18), rigid through EIGHT rows — a fitted
garment to below the hip, flowing only beneath — very heavy and very
damped (gravity −29, damping 0.625), floor at 0. Length moved to
`height × 0.465` per the export's own sizing. ⚠ Note: that is NOMINAL
height, limb-independent — the one garment not on D-519's rig-derived
basis, kept faithful to what the stakeholder validated. If skirt hems
misbehave on extreme-limb seeds, this is where to look.

**Sleeves:** tuned on the right arm, mirrored to both — shorter
(0.726·bodyW), slimmer rings (0.15/0.22·bodyW), three rigid rows, default
tube physics.

**Hood flaps removed** (stakeholder: "useless"). The two physics strips
hanging from the hood rim are gone from construction, stepping, layering
and teardown, and the workbench no longer offers the preset. The hood is
now entirely rigid geometry — shell, gather, mantle — plus the veil.

**The workbench presets were re-baselined** to these values, so opening
the cloth tab shows exactly what the game renders and an untouched export
round-trips to no change. The garment-scale test's collar assertion was
re-expressed around the failure mode it guards (a collar approaching head
size) rather than a spread bound calibrated to the pre-tune constants.

### D-521: The first shipped iteration is a round-based scenario mode

**Stakeholder, 2026-08-18:** "I originally wanted to build the full RP game
and world, but now I think I should focus on a short scenario-based version
of it in the first instance. All the features etc will remain... sort of
like Space Station 13, or Werewolf. 20-30 minute rounds. Day-night cycle.
All players start in the tavern, and must survive, level up, craft, farm
etc. One player is evil, with an objective... The only difference is, there
is no respawn timer. If you are dead, you are dead until revived, or the
game ends."

**Decision:** the first shippable product is **the Round** — a 20–30 minute
scenario played by a small cast in a compact map, with a hidden antagonist,
a compressed day-night cycle, and no respawn. The persistent world
(D-101 through D-406) is **not cancelled and not superseded**; it is
resequenced behind the Round. Every system already built is retained.

**Why this is the right move, stated plainly rather than accepted on
authority:**

1. **It pays the oldest debt in the project.** BUILD_PLAN's declared go/no-go
   gate — two writers, ninety minutes, the tavern — has never been run,
   because unstructured roleplay needs a rare kind of player to ignite. The
   Round manufactures the ignition: a hidden traitor gives every player a
   reason to lie and a reason to read the person opposite. **The M2 gate is
   now tested inside the Round rather than beside it.**
2. **It makes the built systems load-bearing instead of latent.** Recognition
   and false names (D-219, D-218), hoods that merge threads when they drop
   (D-506), fallible Insight, scrambled languages, unsigned letters
   (forgery is native), the physician dependency for untreatable wounds
   (D-509), corpses as carryable world objects (D-518), Speak With Dead and
   the dead's freedom to lie (D-512) — these are not features that a
   Werewolf-like *tolerates*. They are its entire mechanical vocabulary, and
   they are finished. The unusual thing about this pivot is how little of it
   is new code.
3. **It shrinks the two hardest unbuilt problems to a size that fits.**
   A persistent economy (M5) and a persistent world (M6) are open-ended.
   A round-scoped crafting loop and a five-area map are bounded, shippable,
   and — critically — testable by bots in seconds.

**What the Round is, mechanically:**

- **A server-owned session over the existing world.** Phases: lobby →
  running → resolution → reset. The victory conditions are exactly the
  trigger vocabulary the DM event engine already speaks (`entity_death`,
  `at_hour`, `after_seconds`, `player_count`) — **a scenario is a DM event
  document that plays itself**, and it should be built on that engine, not
  beside it (D-508).
- ~~**Characters are round-scoped.** Progression must complete inside 25
  minutes, so levels, skills and goods are created and discarded with the
  round.~~ — **superseded by D-522: the character persists and levels
  across rounds; only gear is stripped.** The **account** also persists:
  Legacy Points, statistics, unlocks. D-207 still holds — Legacy buys
  access and flavour, never power.
- **Death is the endgame rule applied globally.** D-513 already built the
  downed state, the `revive` window, and death without respawn. In the Round
  that becomes the default: no respawn timer, no death debt, no walking it
  off. Dead is dead until revived or until the round ends.
- **The clock is round-scoped.** `TICKS_PER_GAME_HOUR` is currently fixed at
  two real minutes (a 48-minute day). It becomes a round parameter so one
  round is one day, and **area lighting must follow the hour** rather than
  only following script and DM actions.
- **Evil is assigned, not chosen.** The antagonist is picked server-side and
  in secret at round start, and carries an objective document from content
  (`kill <target>`, `steal <object>`, `survive`, `escape`).

**Rulings this forces, which are not negotiable design-wise:**

- **Invariant 4 holds, and holds harder.** Ghosts see only ghosts. SS13 lets
  the dead observe freely; we cannot, because a dead player with full vision
  and a voice channel is a perfect informant and the antagonist's position
  is the whole game. Being dead in the Round is *quiet*, and if that proves
  unbearable the fix is a shorter round, not a relaxed invariant.
- **Invariant 5 holds.** There is no detect-traitor. Insight remains graded
  and fallible. A reliable read on the antagonist ends the mode instantly.
- **The north star (D-303) is unchanged and now easier to violate by
  accident.** Evil being *assigned* does not license scoring virtue. The
  round must **not** reward correct accusation, execution, or a clean sweep —
  if points accrue for lynching, the game teaches the exact opposite of
  D-303. Mercy toward a suspect (restrain, exile, lock in the cellar) must
  be *supported* and never *optimal*. The round ends; it does not grade.
- **Invariant 2 holds.** Round-kit items go through the orphan validator like
  everything else (D-210).
- **Invariant 10 holds.** The event log stays append-only across rounds; the
  round id is a column, not a reason to reset the table.

**What this costs, honestly.** Crafting, farming, gathering and the
inventory UI do not exist — that is M5 work pulled forward, and it is the
bulk of the new build. Levelling exists as an `xp` integer with no curve and
no unlocks. The map is three areas (tavern, yard, crypt) and a round needs
perhaps five. Everything else is configuration and a session engine.

**Open questions for the stakeholder — flagged, not assumed:**

- Cast size per round, and what happens below it (bots? merge lobbies?).
- Whether characters are pre-rolled or created in the lobby — the creation
  wizard (D-515) is a five-minute experience in front of a 25-minute round.
- More than one antagonist above a certain cast size, and whether they know
  each other.
- Whether a revived player returns with anything, or naked and wounded.
- What, if anything, an account earns from a round, given D-207.

### D-522: The Round's cast — persistent characters, stripped gear, a floor of three

**Stakeholder rulings, 2026-08-18,** answering D-521's open questions:

> "Minimum 3 players per round. Character creation is done before attempting
> to join a game/round. The idea is, your character is persistent, and levels
> up by playing the rounds (xp for crafting, farming, healing others, killing
> enemies, winning the round etc), and that xp/level is kept between games.
> Gear/items however are stripped between rounds."

**This supersedes D-521's round-scoped-character bullet.** The shape is now:

| Layer | Between rounds |
|---|---|
| Account (Legacy Points, unlocks, statistics) | persists |
| **Character (identity, xp, level, skills)** | **persists** |
| Gear, items, crafted goods, harvested crops | **stripped** |

Character creation (D-515) happens **outside** the round, at the roster
screen — which removes the bad ratio D-521 worried about, a five-minute
wizard in front of a twenty-five-minute round. The lobby is a join queue,
not a creation step.

**Why this is a better design than what D-521 assumed, and where it is more
dangerous:**

**Better:** a character that survives the round is a character worth being
careful with. Round-scoped characters make death free — lose, shrug, requeue.
Persistence gives the no-respawn rule its teeth and gives the roleplay core
something to accrete around: a name with a reputation across rounds is
exactly the social texture Arelith runs on.

**More dangerous — three consequences that need managing, not just noting:**

1. **Veteran dominance will kill the mode if the curve is not flat.** A cast
   mixing a hundred-round veteran with three first-timers is not the same
   game for either. The discipline that saves this is already written down:
   **D-207's rule for Legacy Points must govern round levels too — levels buy
   access and options, never raw power.** A level should unlock a craft, a
   rite, a skill *verb*; it must not multiply damage or hit points enough to
   make a veteran unkillable by three novices. If the mode drifts toward
   stat-scaling it needs level-banded queues instead, which a 300-player
   target cannot afford.
2. **XP sources are an incentive system, and one of them is a trap.** Craft,
   farm, heal, survive, win — all fine; they are services and outcomes.
   **But xp must not be paid for killing another player.** At a cast of three
   to five, xp-for-player-kills is xp-for-lynching: it pays the good team to
   execute suspects, which is precisely the mechanical reward for
   accusation that D-303 and D-521 both forbid. Combat xp comes from
   **NPCs and hostile spawns**; the antagonist earns from **completing its
   objective**, not from the body count. The good team earns from **surviving
   and winning**, not from being right about who to kill.
   Implementation note: this vocabulary already exists — D-510's Legacy
   formula scales on *deeds*, "meaningful actions, never wall-clock"
   (`server/src/game/legacy.ts`). Round xp should extend that deed list
   rather than invent a parallel one.
3. **Death now needs a defined cost, and D-521 left it undefined.** Round
   death is **not** permadeath — the character survives a lost round, and
   permadeath stays what D-510 made it: voluntary retirement, the only route
   to Legacy Points. So dying in a round must still cost something or the
   no-respawn rule is theatre. **Recommendation: the round's earnings are
   forfeit.** Die and you bank nothing from those twenty-five minutes — a
   real loss, no death spiral, no bookkeeping. The alternative worth
   considering is a **wound that carries into the next round**, which would
   finally give D-205's injury matrix a job; it is more interesting and it
   risks a downward spiral for unlucky players. **Unratified — stakeholder
   call.**

**On the floor of three, stated plainly: three players is a technical floor,
not a functioning mystery.** Social deduction does not work at 2-versus-1 —
a single accusation is a coin flip, and one lucky ambush ends the round
before anyone has spoken. Three should be what lets a round *start*, not what
rounds are designed for; five to eight is where a hidden antagonist becomes a
game. Two consequences follow:

- **Objective type should scale with cast size.** "Kill player X" at a cast
  of three is near-deterministic and reduces to a duel. **Steal**, **escape**
  and **survive** objectives still function at three because they do not
  require the antagonist to win a fight. Assassination objectives should be
  reserved for larger casts.
- **NPCs are the low-count fix.** The tavern already has a scripted keeper
  (D-507). A room with connectionless NPCs in it gives a three-player round
  crowd to hide in and hostiles to earn xp from without inflating the cast.

**A new open question this creates, and it is the sharpest one yet:
does recognition memory persist between rounds?** The recognition system
(D-219) makes names per-observer knowledge. If that knowledge carries across
rounds, then within a small player base every regular is recognised on sight
within weeks, false names stop working, and "Torvald was the traitor last
round" becomes the dominant strategy — the deception core degrades into
metagame. If it resets each round, the deception core stays sharp but a
persistent character's reputation cannot accumulate, which is half the point
of persistence. **These pull in opposite directions and cannot both be had
in full.** The masks and hoods are already built (D-506) and are the obvious
partial answer. **Flagged for the stakeholder — do not resolve it in code
by accident.**

**Remaining open from D-521:** more than one antagonist above a given cast
size and whether they know each other; what a revived player returns with.

### D-523: The dungeon — the round's separation engine

**Stakeholder, 2026-08-18:** "there should be a dungeon that resets daily,
that can be farmed for loot and materials. This is a source of XP, and a
distraction for the good players. The enemy player may join them in the
dungeon and strike at an opportune time, or they may be left free to complete
other objectives."

**Decision: accepted, and it is load-bearing rather than optional content.**
The dungeon is not a side activity bolted onto the Round — it is the
mechanism that makes a hidden antagonist playable at all.

**Why it is structural.** A hidden-traitor round only works if players
**separate**. If the whole cast sits in the tavern for twenty-five minutes,
nobody can be killed unwitnessed, the antagonist can never act, and the round
resolves by timer. Something has to pull people apart — and forced tasks
(the Among Us answer) make separation feel like a chore assigned by the game.
The dungeon separates people **voluntarily**, for reasons they own: xp, loot,
materials. That is a far better mechanism, because the player chooses the
exposure and therefore owns the consequence.

**The tension it creates is self-balancing, which is the mark of a good
mechanic.** Attention is the scarce resource. Diving earns but leaves the
tavern unwatched and the antagonist unobserved; staying watches but earns
nothing. If everyone stays, nobody progresses and the round is dull. If
everyone dives, the antagonist walks its objective unopposed. There is no
dominant strategy, and the group must negotiate the split out loud — which
is itself roleplay, and which makes *who volunteered to go where* a fact the
cast can later reason about.

**It closes a hole D-522 left open.** D-522 ruled that combat xp comes from
**NPCs, never from killing another player** (xp for player kills pays the
good team to lynch suspects, violating D-303). That rule had no content
behind it — there were no NPC hostiles anywhere. **The dungeon is where that
xp lives.**

**Existing mechanics it activates, none of which need building:**

- **Zone tier (D-206).** The dungeon is `wilderness`; the tavern is
  `settled`. That single content field already means the tavern requires a
  spoken, logged hostility declaration with a ten-second window, and the
  dungeon requires nothing. **The dungeon is mechanically the place where
  you can be struck without announcement** — already implemented, already
  bot-tested.
- **Wilderness corpse rules (D-511/D-512).** A wilderness corpse wears
  everything. Die in the dungeon and your loot goes to whoever finds the body
   — including your killer. The antagonist murdering a diver and taking the
  haul is a complete, built loop.
- **Plausible death.** Deaths underground are *expected*. "The undead took
  him" is a survivable lie; "he died in the tavern cellar" is not. The
  dungeon is the antagonist's alibi factory.
- **Speak With Dead (D-512), in which the dead may lie.** A body recovered
  from the dungeon can be questioned and can mislead. This is a murder
  mystery mechanic that has been finished and unused since M4b.

**"Resets daily" needs disambiguating, because the pivot changed what a day
is.** D-521 made the clock round-scoped: **one round is one day.** So
"daily" and "per round" are now the same statement, and the dungeon resets
**per round**. Recording this explicitly because the alternative reading —
a persistent dungeon on a real-world 24-hour timer — would be a mistake:
it would make loot a race *between* rounds, hand the day's first cast a full
dungeon and its fifth a stripped one, and reintroduce exactly the
cross-round item persistence that D-522 deliberately deleted. **Per-round
reset.** (A mid-round refresh at dawn is available later as a pacing beat if
a round needs a second wave; not for the first build.)

**What the dungeon pays in, and what it must never pay in.** Loot and
materials are **round-scoped** — stripped at the end like all gear (D-522).
Only **xp persists**. This is the correct shape and it should be defended:
**the dungeon must pay in a currency that cannot win the round.** Loot arms
you for the next twenty minutes; xp banks to a character you will play
tomorrow; neither completes an objective or identifies the antagonist. What
diving costs is **absence**, and absence is the whole point.

**The risk, stated plainly: the dungeon can eat the round.** A farmable
dungeon inside a 25-minute social-deduction game can easily collapse into
"everyone dives, twenty minutes of PvE, the traitor wins by default or gets
bored" — a co-op crawler with a griefer in it. The mode dies there. Three
levers keep it in its place, and they should be built in from the start
rather than retrofitted when it goes wrong:

1. **Diminishing returns per clear.** The first run pays well, the second
   little. Farming is bounded by design, not by the round timer.
2. **Dangerous enough to need company.** If a dive requires two or more, the
   split is *visible* — the cast knows who went below and who stayed. That
   feeds deduction instead of starving it. A solo dive should be a
   conspicuous, risky choice, not the efficient one.
3. **An objective clock that punishes over-diving.** If the antagonist can
   complete its objective while the cast is underground, over-committing is
   self-correcting. This needs no new system; it is a tuning relationship
   between objective duration and dungeon depth.

**At the minimum cast of three, the dungeon is sharper than it looks.** If
two dive and one stays, and the antagonist is one of the divers, the dive is
an unobservable 1v1. That may be an honest and interesting risk, or it may
make diving suicidal and therefore dead content at low counts. **Consider a
minimum party size to enter, scaled to cast size.** Unratified.

**Implementation trap, recorded before someone steps in it.** `sunken-crypt`
already exists (D-513) and is the obvious starting geometry — but its zone
is `endgame`, which carries **involuntary permadeath**. D-522 ruled that
round death is **not** permadeath; the persistent character survives a lost
round. **A round dungeon must be `wilderness`, never `endgame`.** Reuse the
area, not its tier — or a bad pull costs a player the character they have
levelled across fifty rounds.

**Open for the stakeholder:** how many dungeon layouts at launch and whether
they rotate per round; whether the antagonist's objective can ever be *inside*
the dungeon (it would force the cast down, which is either excellent or a
collapse of the tension above); minimum party size at low cast counts.

### D-524: Recognition resets per round; dying forfeits the round's xp

**Stakeholder, 2026-08-18:** "recognition memory would not persist between
rounds. The cost for dying is loss of XP still."

**Ruling 1 — recognition memory is round-scoped.** This resolves the
question D-522 flagged as the sharpest one open. Per-observer name knowledge
(D-219) is created and discarded with the round. Every round, the cast meets
as strangers; false names, hoods and introductions work on round one and on
round five hundred.

**What this costs, so nobody is surprised later:** a persistent character
cannot accumulate reputation *through the recognition system*. Being widely
known is no longer something the mechanics track across rounds. In the
persistent world (M5–M7) that would be a serious loss — renown is half of
Arelith. In the Round it is the correct trade, because a deduction game whose
deception layer decays with familiarity has a shelf life measured in weeks.

**A nuance worth stating, because it prevents a false sense of security:**
resetting recognition stops the *game* from helping players metagame; it does
not stop players metagaming. Regulars will know each other's characters on
sight regardless of what the server remembers. **The reason this is
nonetheless sufficient is that the antagonist is assigned at random each
round** — so "Torvald was the traitor last round" carries no predictive
information whatsoever. Identity-deception degrades with familiarity;
**role-deception does not**, and role-deception is the one the Round is built
on. Any future change that makes antagonist assignment predictable —
weighting, queues, opt-in — would destroy this property and must be treated
as a serious design change, not a tuning knob.

**Ruling 2 — death forfeits the round's xp.** Confirming the recommendation
in D-522: die, and you bank nothing from that round. The twenty-five minutes
are the stake, which is a real loss with no bookkeeping and no spiral. The
carried-wound alternative is set aside.

**Recorded assumption, cheap to correct:** this is read as **forfeiting xp
earned in that round**, not as **deducting xp already banked** from previous
rounds. The distinction matters — deducting banked xp can de-level a
character and puts unlucky players into a downward spiral, which is the
failure mode that made the carried-wound option unattractive in the first
place. Built as forfeit-the-round's-earnings. **If the intent was a deduction
from the character's total, say so and it is a one-line change.**

**Interaction with D-523 that makes the dungeon sharper.** Dungeon xp is
banked only if you live to the end of the round. So a player who dives, farms
hard, and is then murdered by the antagonist on the way home loses the entire
haul — xp and, under wilderness corpse rules, the loot to the killer. **The
richer the dive, the more there is to lose by dying with it.** Farming late
in a round is therefore a genuine gamble rather than free value, and no
special-case rule was needed to make it one.

### D-525: What resets between rounds is the *feature*, not the face

**Stakeholder, 2026-08-18, correcting an over-reading:** "It doesn't matter
if they recognize a character between rounds (character name/appearance)
because they may not be evil that round. However, the in-game name
recognition feature should only persist across one round, then be wiped."

**This entry exists to correct the record.** The stakeholder's earlier line
— "players should not know each other between rounds" — was first read as a
requirement for **anonymity**, and this decision number briefly recorded a
mechanism for it: per-round `appearanceSeed` and presented names, so a
character would be a build rather than a face. **That was never ratified and
is withdrawn.** It is recorded here rather than deleted so that a future
session does not re-propose it believing it to be new.

**The actual ruling, which is narrower and better:**

- **Characters stay recognisable across rounds.** Persistent name, persistent
  appearance, persistent identity. Torvald is Torvald every round.
- **The recognition *system* (D-219) is wiped between rounds.** Per-observer
  name knowledge — who has been introduced to whom, which threads have
  merged, which false name was swallowed — is created and discarded with the
  round. Mechanically, every round opens with an empty knowledge table.

**Why the face may safely persist, in the stakeholder's own reasoning:
knowing *who* someone is tells you nothing about *what* they are this round.**
The antagonist is assigned at random each round, so cross-round familiarity
carries no predictive information about the only fact that matters. This is
the same property D-524 identified: identity-deception decays with
familiarity, **role-deception does not**, and the Round is built on
role-deception. Anonymity was solving a problem randomness had already
solved.

**And the cost anonymity would have carried is now avoided.** A character
nobody can recognise is a build, not a person — capability without renown.
Keeping the face keeps the thing players actually become attached to, and
keeps a door open to M5–M7, where renown is half the point and a per-round
face would have been actively wrong.

**One acknowledged leak, not worth engineering against.** A player who
remembers a character from a previous round can address them by name without
having been introduced this round — speaking a name is a mechanical act
here (D-218), so out-of-round knowledge can shortcut an in-round
introduction. This is inherent to the ruling and is **acceptable**, because
it reveals nothing about the antagonist. Do not add machinery to prevent it.

**Implementation note:** this is a lifecycle change to existing storage, not
new behaviour. Recognition knowledge must be **round-scoped state**, cleared
at round reset, and must not be written to the character's persistent record.
The trap to avoid is the reverse — quietly persisting it because the
persistent-world design (D-219) assumes it endures.

### D-526: Survival needs, and the low-cast objective set

**Stakeholder, 2026-08-18:** "I think we can handle 3 players minimum with
some creative objective choices. Maybe killing an NPC, or starving out the
other players etc. Food/water needs will need to be part of it, so players
cannot camp one spot."

**Ruling 1 — the minimum cast of three stands, carried by objective design.**
D-522 warned that three players is a technical floor rather than a functioning
mystery, and that assassination objectives at that size reduce to a duel. The
resolution is not a higher floor but a **cast-scaled objective set**:

- **Kill a named NPC.** Excellent at three. The tavern already has a scripted
  keeper (D-507) — a fixed, known, defenceless target the cast must *protect*
  rather than a player they must *suspect*. It converts the round from "who
  is the traitor" (thin at three) into "the keeper must live" (a defence
  problem that works at any size), and the antagonist is exposed by what it
  does, not by a coin-flip accusation.
- **Starve the cast out.** Attrition rather than assassination — the
  antagonist wins by denial: spoiling stores, poisoning the well, burning the
  crop. **This objective does not require the antagonist to win a single
  fight**, which is exactly what a 2-versus-1 needs.
- **Steal / escape / survive**, as already recorded in D-522.

Assassination objectives stay reserved for larger casts.

**Ruling 2 — food and water are in, as an anti-camping mechanic.** This is
accepted for the same structural reason as the dungeon (D-523): it is a
**movement engine**. The dungeon pulls players apart by offering reward;
hunger pushes them out of a defensible corner by denying them the option to
sit in it. Between them, the round has both a carrot and a stick against the
degenerate strategy of the whole cast barricading in one room — which is
otherwise the *correct* play in a hidden-traitor game and would kill the mode
outright.

**It also makes farming load-bearing.** MR2's farming was, honestly, content
without a consumer — you farm because the milestone says so. Now you farm
because the cast eats. That is the D-210 no-orphans discipline applied to a
verb rather than an item, and it is a better argument for farming than the
one MR2 previously had.

**And it hands the antagonist a non-violent attack surface.** Poisoning the
well, spoiling the stores, torching a field — unwitnessed, deniable, and
requiring no combat at all. At a cast of three, where any fight is decisive
and obvious, **a poisoner is a far more interesting antagonist than a
duellist.** This is the single strongest argument for the mechanic.

**It couples to the dungeon in a way that bounds farming for free.** Diving
takes you away from food and water. A long dive is therefore self-limiting
without any artificial timer — a fourth lever alongside D-523's three, and
the only one that costs nothing to implement once needs exist.

**It fits the north star exactly.** Scarce food makes **feeding someone else
a costly kindness** — possible, never optimal, and validated only by the
person you fed. D-303 asks for precisely this and has had very little to
work with mechanically until now.

**The failure mode, which is well documented in this genre: tedium.** Hunger
systems become chores — a bar that ticks, a sandwich clicked every ninety
seconds, attention taxed for no decision. The rule that prevents it:
**hunger must force a decision, not a chore.** Concretely, for a 25-minute
round:

- **Coarse, not continuous.** Two or three meaningful need events per round,
  pinned to the day-night cycle (dawn / noon / dusk), not a draining bar.
- **The first bite of pressure is a *choice*, not damage** — it should make
  you leave a room, not shave your hit points.
- **No death spiral.** Consequences must plateau. Starvation may weaken and
  eventually kill, but it must never make a losing cast unable to act; a
  round decided by a hunger bar rather than by a person is a failed round.
- **Water and food should fail differently**, or one of them is decoration.

**Unratified and needed before build:** the number of need events per round,
what the first stage actually costs, and whether starvation can kill inside a
round or only incapacitate.

### D-527: The day-night cycle — ten minutes, and night belongs to the wild

**Stakeholder, 2026-08-18:** "I want a day to be around 10 mins, 5 mins day,
5 mins night. At night I want NPCs to roam outdoors, making outside perilous,
but rewarding to the brave/strong."

**Decision:** a full cycle is **6,000 ticks — ten real minutes**, split evenly:
day from 06:00, night from 18:00. A game hour is 25 real seconds
(`ROUND_TICKS_PER_GAME_HOUR = 250`), which keeps every authored `on_hour` and
`at_hour` trigger working (D-507, D-508) — just very much faster. The
persistent world's two-real-minutes-per-game-hour is untouched; the round runs
on its own clock.

**A 25-minute round is therefore two and a half cycles — three day phases and
exactly TWO nights**, opening and closing in daylight. This is a better shape
than it looks:

- Two nights give the round **two distinct danger beats** rather than one
  undifferentiated stretch. A single night would make the round a
  before-and-after; three would make night routine.
- Ending in daylight means the round does not resolve in the dark, when
  visibility is worst and a resolution would feel arbitrary.
- **A body discovered at dawn** is the oldest setup in the genre, and this
  cycle produces it twice a round without anyone authoring it.

**Night NPCs roaming outdoors is the third movement force, and it completes
the set.** The Round now has three pressures that no single position defeats:

| Force | Direction | Decision |
|---|---|---|
| The dungeon | pulls players **out** — reward | D-523 |
| Hunger and thirst | pushes players **out** — need | D-526 |
| **Night** | drives players **in** — danger | **D-527** |

That is why the barricade strategy fails. Camping one room was already
answered by hunger; night answers the opposite degenerate case, the cast that
spends the whole round spread across open ground where nobody can be
ambushed. **No spot is safe against all three at once**, and the cast must
keep making decisions about where to be. This was the structural gap left
after D-526 and it is now closed.

**What night does for the antagonist is the real prize.** At night the cast
is driven indoors, together, tense, and unwilling to go out alone — which is
exactly the condition under which a murder is both possible and deniable.
"He went out at dusk and something took him" is a complete alibi that the
world itself makes plausible. **The game manufactures the antagonist's cover
on a timer**, without a single scripted event.

**"Rewarding to the brave/strong" is the part to be careful with.** Night
must pay better than day — otherwise nobody goes out and it is simply a
five-minute intermission. But the reward must obey D-522: **it pays in xp and
materials, never in anything that wins the round.** A night forager comes
back richer and more experienced; they do not come back holding the round.
Two further constraints follow:

- **Night must be survivable by the strong, not only by the lucky.** If night
  roamers kill anyone who steps out, night is a wall rather than a decision,
  and the round loses five minutes in every ten.
- **The antagonist must not be the obvious beneficiary.** If night is so
  lethal that the cast never separates, the antagonist cannot act either.
  Night should isolate people, not freeze them.

**Implementation shape (MR1 for the clock, MR2 for the roamers):**
`roundHour()`, `isNight()` and `roundPhaseOfDay()` in `shared/src/round.ts`
derive everything from the tick, so the cycle is deterministic and headlessly
testable. Area lighting follows the phase. Night spawning is per-area and
applies only to areas that are actually outdoors — which means **areas need
an `outdoor` flag**; `lighting: 'interior' | 'underground'` is a rendering
profile and must not be overloaded to mean "safe from roamers".

**Unratified, and needed before the roamers are tuned:** how much more night
pays than day; the roamer's strength relative to a mid-round character; and
whether night roamers may enter settled areas at all or only prowl outside
them.

### D-528: Night pays half again — outdoors only, and why that matters

**Stakeholder, 2026-08-18:** "Night should return 50% more rewards."

**Ruling:** `NIGHT_REWARD_MULTIPLIER = 1.5`, applied to xp and materials
earned **outdoors, after dusk**. This is the first ratified number in the
Round's economy and it settles the tuning question D-527 left open.

**The scope is the whole decision, and the naive reading is a trap.** A
blanket time-based bonus — *everything* pays 1.5× between dusk and dawn —
would be actively harmful, because it pays best for the safest possible
choices:

- **Sitting indoors.** The cast barricaded in the tavern would earn half
  again for doing the thing night exists to punish.
- **Diving.** The dungeon is underground; roamers do not reach it. A night
  bonus there would make dusk the optimal moment to go below, so nobody
  would ever brave the open and the roamers would prowl an empty map.

The bonus is **compensation for peril**, so it is paid only where the peril
is. Where the sky does not reach, night is not dangerous and must not be
lucrative. Both cases are asserted in `server/test/round.test.ts`; the
indoor one is the test that matters.

**This forced the `outdoor` flag on areas.** D-527 already said night must
not be inferred from `lighting`, because that is a rendering profile and
tying "how an area looks" to "whether it is dangerous" is a coupling that
will be wrong the first time someone authors a bright cavern or a gloomy
field.

**It was first made REQUIRED, and that was wrong — recorded because the
reasoning is worth keeping.** The argument was that any default is a silent
gameplay decision. But the suite immediately failed in nine places, all
fixtures building throwaway areas, and that surfaced the real objection:
**`zone` is defaulted**, and `zone` decides whether you can be killed without
warning and whether death is permanent. A field governing night danger has no
claim to be stricter than the field governing permadeath. Requiring it would
have been inconsistent with the schema's own convention for a smaller stake.

**It defaults to `false`, and the direction is deliberate.** An area opts IN
to night. Forgetting the flag on open ground means night never reaches it —
wrong, but visible the first time nobody notices dusk. The opposite default
fails silently and in the worse direction: every cellar paying the night
bonus for hiding, which is the exact inversion this decision exists to
prevent. All authored areas set it explicitly regardless.

**Applied in `gainXp` rather than at each grant site**, so every reward path
inherits it — including MR2's gathering, harvesting and crafting, which do
not exist yet and would otherwise each need to remember.

**Rounded, not floored.** At these magnitudes flooring an odd reward costs
more than the bonus gives.

**Two properties it cannot violate, both already load-bearing:**

- **It cannot pay for a player kill.** Those grant zero inside a round
  (D-522), and 1.5 × 0 is still 0. Asserted, because a multiplier is exactly
  the kind of thing that later becomes a back door.
- **It cannot win a round.** It scales xp and materials, never objectives,
  and xp banks only if you survive (D-524) — so a night forager who is
  murdered on the way home loses the enhanced haul along with everything
  else. **Night raises both sides of that gamble at once**, which is the
  behaviour we want: the richest time to be out is also the most dangerous
  time to be carrying it.

**Still unratified from D-527:** roamer strength relative to a mid-round
character, and whether roamers may enter settled areas or only prowl outside
them. The reward side is now settled; the danger side is not, and the two
have to be tuned against each other before night is playable.

### D-529: Roamer strength, and the cross — the Round's map

**Stakeholder, 2026-08-18:** "Roamers should be strong enough to kill a solo
player with no gear easily, a group should be able to handle them reliably,
but it will depend on the class of players, and their level ultimately.
Roamers should only roam outside." And: "the areas should be a cross shape.
Town in the center which contains buildings for crafting, the well, the
tavern, maybe a few others. North is the farm... East is the mine... West is
the wood... South is the dungeon."

**Ruling 1 — roamer strength: lethal to the lone and unarmed, beatable by a
pair.** Roamers spawn only in **outdoor** areas (the `outdoor` flag, D-528)
and only at night. They never enter the town's interiors, and they never
enter the dungeon — the dungeon is its own danger and is not under the sky.

**The consequence is the best thing in this design, and it is worth naming
because everything should be tuned to protect it.** If going out alone at
night is death, then a night errand **requires a partner** — and your partner
may be the antagonist. The line "I'll come with you, it's dangerous alone" is
generated by the monster tuning, not by a script. **The buddy system is where
betrayal lives**, and the roamers are what create it. Any tuning that lets a
competent player solo the night destroys this, which is the real reason the
next point matters.

**⚠ This collides with persistent levels (D-522) and is the sharpest open
question in the Round's balance.** Characters level across rounds. If levels
make a veteran strong enough to walk the night alone, the buddy system
evaporates *for exactly the players who have been here longest* — the
betrayal geometry decays with experience, which is the same failure mode
D-524 was written to prevent for recognition. This is D-522's "levels buy
access, never raw power" arriving with teeth. Two candidate answers:

- **Attrition rather than a wall.** Roamers stay individually modest but
  come in numbers, so a strong solo player wins fights and still loses the
  night — worn down, out of light, unable to carry a haul home.
- **Roamer presence scales with the local party.** Keeps "you need a partner"
  true at every level, at the cost of feeling gamey if players notice.

Recommendation is attrition; it is honest and unmeasurable by the player.
**Unratified.**

**Ruling 2 — the map is a cross.** Town at the centre; **north the farm**
(food, herbs, the healing chain); **east the mine** (rock and ore, the
weapon chain); **west the wood** (timber, and animals for pelts); **south the
dungeon** (monsters, loot, xp).

**Why the shape is right, stated so it is not casually changed:**

- **Radial symmetry means equal exposure.** Every resource sits the same
  distance from safety, so choosing a direction is a choice about *what you
  need*, never about *what is safe*. If one spoke were closer or safer the
  map would collapse onto that axis.
- **Four spokes and one hub force the cast to fragment**, and a fragmented
  cast is the precondition for everything the Round is about. Nobody can
  cover four resources in twenty-five minutes, so the cast must divide the
  work and trust each other to come back with what they promised.
- **The hub is the social chokepoint.** Everyone returns to town to craft,
  eat and drink. The tavern is the Schelling point where the conversation —
  and the accusation — happens.
- **Direction is free evidence.** Areas are discrete and joined by
  transitions (D-103), so leaving town is a visible departure through a named
  gate. "He said the mine, but he came back from the north" is a complete
  accusation produced by geometry alone, with no tracking system to build.
- **Herbs are north, and healing is a dependency (D-509).** Major wounds
  cannot be self-treated, so the farm is the lifeline and denying it is a
  devastating and entirely non-violent play.

**The consequence nobody would predict, and it changes MR2's priorities.**
Town is `settled` and the spokes are `wilderness` (D-206). That mapping is
already built, and it means **the antagonist cannot murder anyone in town**
without a spoken, logged hostility declaration and a ten-second window — that
is, without ending its own game. So the antagonist has exactly two routes:

1. **Get people to leave**, and act where the sky is the only witness.
2. **Break cover in public**, which is a climax rather than a tactic.

Therefore **the non-violent tools are not optional flavour — they are what
makes the centre of the map playable at all.** Poisoning the well, spoiling
the stores, firing a field: these were listed in D-526 as one interesting
option among several. Under the cross they are **required**, because a
settled hub otherwise gives the antagonist nothing to do at the one place
everybody is. **The well belongs in the town centre for this reason**, and it
is the single most important object on the map after the tavern.

**The degenerate strategy this creates, and its fix.** If town is safe from
both roamers and murder, "everyone hides in town for twenty-five minutes"
wins by the clock. Hunger (D-526) is the answer, but only if the town's
stores are a **buffer of a few minutes, not a supply for the round**. If the
storehouse can feed the cast to the deadline, the map has a dominant
strategy and the Round is broken. **The stores must run out.** This is a hard
constraint on MR2's hunger tuning, not a preference.

**Still open, and blocking the map's construction:** whether the south spoke
IS the dungeon or is the approach to a dungeon below it (recommended: the
approach is outdoor wilderness, the dungeon proper is underground, so the two
dangers stay distinct); how long a spoke takes to cross, which is the
round's real pacing knob; and the town's building roster beyond the tavern,
the well and a workshop.

### D-530: The town's facilities — potency for concentration, and the greed that is allowed to survive

**Stakeholder, 2026-08-18,** ratifying D-529's open items and adding the rule
that turns the town from scenery into a decision:

> "It should contain all the above, but it should not be *required* to store
> items there. I want it to be possible for each player to be greedy, and even
> amidst an evil threat, self preservation must be a factor. Players can keep
> food on their person, hog the medicine etc. Items placed there, and 'used'
> from there should be more potent. Being healed at the infirmary should be
> more effective than bandaging in the field."

**Ratified from D-529:** the **south spoke is the approach**, outdoor and
wilderness, with the **dungeon proper underground beneath it** — so the two
dangers stay distinct and diving at dusk is not a way to dodge the night.
**Roamers scale by attrition**, individually modest and numerous, so a strong
solo player wins fights and still loses the night. **A spoke is 30-45 seconds
one way**, which at `MOVE_COOLDOWN_TICKS = 3` (3.3 tiles/second) means
roughly 100-150 tiles of travel and sizes every area at 64×64. The town holds
the **well, storehouse, workshop and infirmary** beside the tavern.

**Ruling: facilities make goods more potent, and using them is never
required.** Bandaging in the field works; being treated at the infirmary
works better. Eating from your pack works; eating from the storehouse works
better. Improvising works; the workshop works better.

**This is not a convenience mechanic — it is a trade between efficiency and
availability, and it is self-balancing.** Pooling goods is the efficient play,
but the value is only redeemable *in town*, in daylight, when you are not the
one bleeding in the wood. Carrying your own is wasteful and redeemable
**anywhere, at any hour, including the moment you actually need it**. Neither
dominates:

| | Efficiency | Availability | Exposure |
|---|---|---|---|
| Pooled in town | high | town only | **one target for the antagonist** |
| Carried on the person | low | everywhere | your loss alone |

**The consequence that makes this excellent: the cast builds its own single
point of failure, and it builds it by cooperating.** Poisoning the well or
spoiling the stores only hurts to the extent that people actually rely on
them — so **the antagonist's non-violent play grows stronger exactly as the
cast grows more trusting.** The hoarder, meanwhile, is insulated from the
sabotage they refused to be part of. Cooperation is efficient and fragile;
greed is wasteful and robust. That is a real dilemma with no correct answer,
which is the best kind.

**It lands squarely on the north star (D-303), and by the right route.**
Contributing to the stores is *supported* and never *safe* — you give up the
one property that saves your life, which is having the thing on you when you
need it. Nothing scores the gift. The only reward for stocking the infirmary
is that other players saw you do it, which is exactly where D-303 says
validation must come from. This is the most direct mechanical expression of
the north star the project has produced, and it arrived from a stakeholder
sentence about greed rather than from designing at the principle.

**⚠ The tuning constraint that keeps the dilemma alive.** If facility use is
*much* more potent, field goods become worthless, nobody carries anything,
and the choice collapses — everyone pools, and the antagonist's single act of
sabotage decides every round. **The multiplier must be meaningful but not
overwhelming; 1.5×-2× is the band**, matching D-528's night bonus so players
learn one sense of scale rather than several. Field treatment must remain
genuinely worth carrying. **Unratified; this is the number to watch when the
mode is first played.**

**A second-order effect worth building around:** major wounds cannot be
self-treated (D-509), so the badly hurt must reach the infirmary *and* find
someone willing to treat them — a double dependency, at a known location. The
wounded are therefore **predictable**, and the antagonist knows exactly where
they will be. Nothing needs to be added for that; it falls out of the map.

**Depth within a spoke is a risk gradient, and should be authored as one.**
At 64×64, the near edge of a spoke is roughly twenty seconds from town and
the far edge closer to thirty-five. Richer resources belong at the far end,
so the choice of *how deep to go* is a second, finer version of the choice of
whether to go out at all — and at night the deep end is where people
disappear.

### D-531: In a round, violence is free — and loud

**Stakeholder, 2026-08-18:** "For this mode, I think we need to change the
hostility declaration. Players can choose to attack at any time, with no RP
necessary, but nearby sounds of fighting will be heard within range of the
action." Clarified: "When I say heard, I mean audio, plus text announcements
to those in range."

**Decision: D-206's declared-hostility rule is disabled inside a round**, and
replaced by combat noise. The persistent world keeps the declaration
unchanged — this supersedes it **for round mode only**, and M5–M7 are
untouched.

**This fixes a real problem the cross map exposed (D-529).** With the town
`settled`, the antagonist could not kill anyone at the one place everybody
gathers without a spoken, logged warning and a ten-second wait — that is,
without ending its own game. The declaration was designed for a persistent
world where roleplay is the point and there is time for it. In a
twenty-five-minute scenario a ten-second warning does not make murder
*risky*, it makes it *impossible*.

**The restraint moves from procedural to informational, and that is the whole
idea.** Nothing stops you swinging. What stops you is that **everyone nearby
hears it**. The question is no longer "have I earned permission to attack"
but "who is close enough to hear", which is a question about **position**,
and position is something players can reason about, exploit and lie about.

**What this does to the map, without changing a tile:** distance from other
people becomes the antagonist's real constraint. Killing in the town square
is possible and reckless. Killing at the deep end of a spoke is quiet, and
the deep end is exactly where D-530's risk gradient already sends people for
the better resources. **The map's economic geography and its murder geography
are now the same geography**, which is a much better property than the zone
rule produced.

**Three things the sound deliberately does NOT do:**

- **It does not respect line of sight.** You hear a brawl through a tavern
  wall. If sound were sight-limited, killing indoors would be silent and the
  town would be free again — the mechanic would undo itself.
- **It names nobody.** The wire carries a kind, an eight-point bearing and a
  coarse near/far band. No entity id, no descriptor, no coordinates. **A
  sound is a lead, not evidence**, which is what keeps D-217 intact:
  reputation still requires a witness, and hearing a scuffle through a wall
  is not one. The bearing is deliberately coarse so a listener cannot
  triangulate.
- **It does not cross the plane.** Ghosts hear nothing of the living. A dead
  player who could hear *where* fighting was happening would be a live scout
  on a voice call — invariant 4 by another route, and the version of the leak
  nobody would have thought to test for.

**NPC fights are just as audible as murders, and that ambiguity is the point.**
At night, with roamers abroad (D-527), "something is fighting to the north"
could be a wolf or could be your friend being killed. **The world supplies
the antagonist's deniability for free**, and it does so precisely when the
cast is most on edge.

**`COMBAT_NOISE_TILES = 30`, near/far split at 12.** At 100×100 areas that is
about a third of the town, so violence anywhere near where people gather is
heard, and violence deep in a spoke is not. **Unratified first pass** — this
is the number that decides how much of the map is safe to kill in, and it
should be the first thing tuned once the mode is played.

**Sound is area-local.** You do not hear fighting in the next area along.
Areas are discrete (D-103) with no shared coordinate space, and making noise
cross transitions would both be awkward and make the spokes audible from
town, which would defeat the whole mechanic.

**A new wire message rather than a narration**, because the stakeholder asked
for audio as well as text: `sound` carries `kind`, `bearing`, `distance` and
a ready-made line, so the client can play a cue, attenuate it by band, and
show the text. `narrate` would have delivered prose with nothing for the
client to hear.

**⚠ `zone` still matters in a round, for a different reason.** It no longer
gates attacks, but it still drives corpse rules (D-511/D-512): a settled
corpse is cosmetic and unlootable, a wilderness corpse wears everything. So
killing someone in town is now *possible but unprofitable*, and killing them
in a spoke pays. That is a happy accident of the existing design and it
points the same way as the noise rule.

### D-532: Night roamers implemented — and two things measurement changed

MR2's implementation of D-527's night and D-529's roamer ruling. Content in
`content/roamers/`, behaviour in the gateway, verified by
`sim/test/mr2-roamers.test.ts`.

**Roamers spawn at dusk in outdoor WILDERNESS areas, and are taken back at
dawn.** Not the settled town, not the dungeon. Survivors do not linger, so
night is a phase rather than an infestation that accumulates across a round.

**Ruling taken, and flagged: roamers do NOT enter the settled town.** D-529
left this open. Keeping them out is what preserves the three forces — the
town has to remain the refuge night drives people *into*. If roamers walked
Ashfold, night would be uniformly lethal, there would be nowhere worth
running to, and the choice "out or in" would collapse into "hide or die
wherever you are". **One line to flip if the stakeholder rules otherwise**
(`roamerAreas()`, `def.zone !== 'settled'`).

**Two things the tests changed, both of which reasoning alone had wrong:**

1. **Roamers did not roam.** They spawned deliberately outside their own
   aggro radius — so nobody is ambushed at the instant night falls — and
   then stood still until someone walked into them. A player could hold one
   spot all night and never be touched, which makes "night is dangerous"
   simply false. They now drift along a heading held for a stretch, so they
   cross ground rather than shiver on the spot, and a distant watcher can
   read which way a thing is going.

2. **The density was nowhere near enough, and neither was their reach.**
   Seven roamers across a 100×100 area is seven things in ten thousand tiles,
   with a nine-tile notice radius. The first honest test — stand a lone
   unarmed player in the open all night — was passed by the player. Aggro is
   now 20 and 26 tiles, and counts 8 and 3 per area.

   **The aggro radius deliberately exceeds the spawn clearance now.** They
   notice you from further than they are allowed to appear, which means they
   *cross open ground towards you*: visible, avoidable, and frightening in
   the right way. Being hunted is the intended feel; being stepped on is not.
   The clearance still stops one materialising on top of somebody, which is
   the failure that would be unfair rather than dangerous.

**They inherit the rest of the design for free.** A roamer's blow interrupts
gathering exactly as a player's does — otherwise working a vein through a
pack of dogs would be free. And a roamer fight emits the same `sound` as a
murder (D-531), naming nothing: **at night, "something is fighting to the
north" could be a wolf or could be your friend**, which is the antagonist's
alibi arriving on a timer with nothing scripted.

**⚠ Every number here is unratified**, and the two that matter most are
`perArea` and `aggroTiles`, because together they decide whether night is a
decision or a wall. The shape is what the tests assert — dusk/dawn, wilderness
only, a lone walker actually being hurt — so the numbers can be retuned
without the assertions going stale.

**The day-night cycle length became a server option** (`round.dayTicks`) so
tests can reach dusk without waiting fifty real seconds for it, the same
reason combat and corpse pacing are options (D-114). The rule stays
tick-based; only the pacing moves.

### D-533: Hunger and thirst implemented — and they pull opposite ways

D-526's survival needs, built. `shared/src/needs.ts`, gateway, and
`sim/test/mr2-needs.test.ts`.

**The decision worth recording is that the two needs pull in OPPOSITE
directions**, which D-526 did not specify and which turns out to matter more
than either need on its own:

- **Hunger pushes you OUT.** Bread is baked from grain, grain grows on the
  farm. A cast that never leaves town eventually has nothing to eat.
- **Thirst pulls you IN.** Water is **not carried**: you drink at the well at
  the town's centre, or you do not drink.

Two needs that both pushed outward would be one need with two bars. Pulling
against each other means **nobody can settle anywhere** — the field starves
you of water, the town starves you of food — and the cast is kept in motion
between two known places without a single scripted event.

It also does something D-529 asked for and could not previously deliver:
**it makes the well the most valuable object on the map.** A poisoner needs
something worth poisoning, and "the one place everybody must come, repeatedly,
on a timer" is exactly that. The well was already at the town's centre for
this reason; now it earns it.

**They fail DIFFERENTLY, or one of them is decoration** (D-526's own words):

| | Penalty | Felt as |
|---|---|---|
| Hunger | work takes up to 1.9× longer | economic — fewer hauls per trip |
| Thirst | maximum health drops to 60% | martial — you lose fights you would win |

**Nothing here can kill.** Both plateau at the second stage, and thirst
clamps current health to the new maximum but never below one. A round decided
by an unattended bar rather than by a person is a failed round, and the
antagonist is meant to be the threat. ⚠ D-526 left "may starvation kill
inside a round" open; this implements **no**, and it is one constant to change.

**Coarse, on the round clock.** Steps are counted in game HOURS, not ticks, so
they inherit the compressed day (D-527) automatically and shrink with it in
tests. Eight hours to a stage of hunger, six to a stage of thirst.

**D-530's facility trade, applied to meals.** Eating from the common stores
or drinking at the well holds you **half again as long** as eating standing
up in a field. The bonus is TIME rather than quantity, so there is no
part-eaten bookkeeping — and it keeps the same shape as everything else in
D-530: the better version is only redeemable where you are not alone.

**Needs are round-scoped**, cleared at reset with everything else the round
holds. A character does not walk into the next round still starving.

**⚠ The constraint D-529 identified is still unmet.** Hiding in town beats
the clock unless **the storehouse runs out**. Bread is craftable from grain
and grain is on the farm, so the pressure exists in principle — but nothing
yet stocks the town with a starting supply that then depletes. Until that
lands, a cast that begins with full bellies and never leaves is only pressured
after the first hunger step. **This is the next thing MR2 needs, and it is a
content/tuning problem rather than a systems one.**

**A note on the test that failed first, because it is a good sign rather than
a bad one.** The needs suite put its second bot alone in the mine. The
roamers found it at dusk and killed it, which ended the round, reset every
need, and failed a plateau assertion for reasons having nothing to do with
needs. D-532's roamers were doing precisely what they were built to do, in a
test that was not about them. The fix was to stop putting a lone bot in the
wilderness overnight — which is also the advice the game gives its players.

### D-534: Starvation kills; a full day empties the belly; stations are objects

**Stakeholder, 2026-08-19:** "It should take approximately one full day for a
full hunger bar to deplete. And starvation should kill." Plus: "proceed with
creating objects for the stations."

**Hunger runs to the end and kills.** This **amends D-526's "consequences
plateau, nothing may kill"** — for hunger only. Three stages at eight game
hours each: sated at dawn, gnawing by mid-afternoon, severe in the small
hours, **starving at the following dawn**. Then two health per game hour
until dead, roughly ten more hours from a full frame.

**The spirit of D-526's rule is kept by making it slow and loud.** A full
day of neglect before any damage, hours more before it is fatal, and a
notice at every step — the last one says so in as many words. Nobody is
surprised by starvation, anybody can be fed by anybody, and a 25-minute
round is two and a half days, so it is reachable **only through sustained
neglect and never by accident**. The rule D-526 was protecting — that a
round should be decided by a person and not by an unattended bar — survives,
because dying of hunger now takes longer than most rounds last.

**Thirst still does not kill, and that asymmetry is deliberate.** It stops at
`severe`: your maximum health drops to 60% and stays there. **Thirst does not
kill you — it makes something else kill you.** If both needs were fatal the
second would be a slower copy of the first; keeping one economic-and-fatal
and the other martial-and-survivable is what makes neglecting them feel
different. Thirst is also trivially fixed by walking to the well, so a fatal
version would punish nothing but forgetfulness.

**Stations are real placed objects now.** `atStation()` was "you are somewhere
in round-town", which was honest but wrong: a recipe that needs the workshop
should mean **a specific anvil in a specific room**. Areas carry a `stations`
array; the town holds a workshop, a storehouse, an infirmary and the well,
each spawned as an entity with its own descriptor, each usable from two tiles
away. This is what D-530's facility potency was waiting on, and it gives the
antagonist something particular to stand beside — or to spoil.

**Two test traps recorded, both of which cost real time:**

1. **A starving bot ends the round.** Death resets every need, so any
   assertion sharing a round with a starving bot measures the reset rather
   than the need. Starvation lives in `sim/test/mr2-starvation.test.ts` with
   a server of its own, and the needs suite runs a clock slow enough that
   nobody reaches `starving` before it finishes.
2. **An unwalkable spawn is silently relocated to the area spawn.** A test
   bot placed on the tavern's wall corner was moved to the town centre — two
   tiles from the well — and spent the suite quietly drinking its fill while
   an assertion waited for "there is no water here". The lesson generalises:
   **a position that lands in a wall does not error, it teleports.**

### D-535: The dungeon deepens rather than reshapes, and shuts at dusk

**Stakeholder, 2026-08-19:** "Ideally, I would like it to change shape/rooms
each day, but that requires forcing the players to leave it... Maybe there are
3 floors, and the later floors only open on days 2/3?" And, choosing between
the options offered: **"option 2 sounds good"** — the stairs close at dusk.

**Decision: three floors, opening on successive round-days, with the entrance
sealed between dusk and dawn.**

**The floors dissolve the problem rather than working around it.** Reshaping a
space requires it to be EMPTY, which requires evicting whoever is standing in
it — teleporting people out of a dungeon is the kind of thing players never
forgive. Revealing a new floor requires nothing, because nobody was ever in
it. The stakeholder's own instinct was the answer.

**And it buys something reshaping would not: a schedule.** "The lower stair
opens at dawn" is a fixed, shared, knowable event. The cast has to gather and
decide who goes down, which is a meeting, and meetings are where the social
game lives. A dungeon that silently rearranged itself would give novelty; one
that opens on a timer gives novelty *and* an argument.

| Floor | Opens | Character |
|---|---|---|
| 1 | round start | Modest. Soloable, and too poor to hold you |
| 2 | second dawn | Wants a partner. The reason to come back |
| 3 | third dawn | Wants the cast — and only the round's last five minutes remain |

Floor 3 opening at tick 12,000 of a 15,000-tick round means it is reachable
for **exactly the closing daylight and not one minute of night**. A climax you
cannot fully exploit is what makes it tempting.

**The entrance seals at dusk, and that is the interesting half.** The dungeon
is the one place roamers cannot reach (D-529), so leaving it open would make
diving the correct way to earn through the night without taking night's risk
— precisely the inversion D-528 restricted the night bonus to prevent.
Sealing it makes dusk a decision with teeth: **come up now, or be shut in
until morning.** Being locked below overnight is a good horror beat, and it
hands the antagonist a sealed room with a known set of people in it.

**Only the ENTRANCE seals.** Movement between floors already reached stays
open, so being caught below is frightening rather than merely idle.

**Both gates narrate rather than fail silently.** A stair that simply does
nothing reads as a bug, and players need to know a way exists *before* it
opens in order to plan around it. The geometry is always connected; the
gating is entirely server-side.

**⚠ Not built: per-round procedural layout.** Generating the floors' shape at
round start — before anyone is inside, so the same eviction problem never
arises — would give variety ACROSS rounds to go with the deepening WITHIN a
round. The floors are currently authored and identical every time. This is
the obvious next step and it is a self-contained one.

**⚠ Not built: the dungeon's contents.** Three floors of empty cavern. No
monsters, no loot, no reason to descend yet. D-523 called the dungeon the
round's separation engine; it cannot separate anybody until there is
something down there.

### D-536: The dawn truce — sixty seconds where the day does not start

**Stakeholder, 2026-08-19:** "ensure there is a 60 second grace window at dawn
before the day actually begins ticking down... survivors should have 60
seconds to discuss their plans, illnesses, injuries, etc." And: "During this
grace window, no player can attack, take damage, or starve, or transition to
new zones."

**Decision: a hard, total truce of 600 ticks at the round's opening and at
every dawn.** Not a quiet period — a **stopped clock**.

**The round's clock genuinely pauses.** Paused ticks are counted and
subtracted from every round-clock reading, so the countdown does not run, the
day-night cycle does not advance, and needs do not deepen. A truce that merely
suppressed damage would still be spending the round's time, and players would
notice they were being charged for their own meeting.

**Four prohibitions, each a way the truce could be quietly incomplete:**

| | Why it would otherwise leak |
|---|---|
| No attacking | the obvious one |
| No roamer damage | the wild things do not observe truces unless told to |
| No need progression | starving through a truce is taking damage by another name |
| No leaving the area | the antagonist could skip the one moment it must answer questions |

A truce with a hole in it is **worse than none**, because players will have
planned around it.

**Why this matters more than it looks.** The Round is a game about people
talking to each other (D-521), and a mode that never stops moving never lets
them. Dawn is when the survivors count themselves, show their wounds, and
argue about who goes where — and it is the one moment **the antagonist has to
lie in front of everybody, with no way to end the conversation by violence.**
This is the closest thing MR has to a scheduled scene, and it costs sixty
seconds of a twenty-five minute round.

**It is visible.** `round_state` carries `graceTicks` and the HUD shows
`dawn · 0:47` in place of the countdown. A safety you can only discover by
trying to hit someone is not a safety anyone will plan around.

**⚠ Note for tests:** every suite that is not about the truce sets
`graceTicks: 0`. Five of them had to, and they all failed loudly first —
which is the right failure, since the truce works.

### D-537: The dungeon has contents — and one shared implementation

The floors were geometry with nothing in them (D-535). D-523 calls the
dungeon the round's separation engine — the thing that pulls the cast apart
voluntarily so the antagonist can act — and it separates nobody while empty.

**Dungeon dwellers are night roamers with a different habitat**, not a second
system. `RoamerSchema` gains `habitat: 'night' | 'dungeon'`, a `floor`, an
`xp` value and a `loot` table; spawn, hunt, strike, wander and despawn are the
same code. A dungeon needs a thing that walks towards you and hits you, which
is exactly what night already had — a second implementation would have meant
two sets of the same bugs.

The one real difference: **dwellers arrive with the round and never leave.**
Underground has no dawn to be driven off by. They are spawned onto **every
floor at round start, including floors not yet open** — the gate is on the
stair (D-535), not on the inhabitants, so a floor is fully alive the moment
its stair gives way rather than filling up while somebody stands watching it.

**The gradient runs on three axes at once**, because one is not a gradient:

| Floor | Opens | Worth | Carries | Hits |
|---|---|---|---|---|
| 1 crypt-crawler | at once | 12 xp | iron ore | 2-4 |
| 2 gallery-drowned | second dawn | 26 xp | **gravebright**, hide | 4-7 |
| 3 undercroft-warden | third dawn | 55 xp | gravebright ×2 | 6-10 |

**Gravebright exists so that descending is not merely faster mining.** It is
the one material nothing above floor two carries, and its only use — a warding
charm — also needs timber from the opposite end of the map, so **a diver still
has to talk to a woodcutter.** That is the cross map's argument (D-529) applied
downwards.

**Loot goes straight to the killer, not onto the floor.** A pile in a dungeon
nobody can re-enter after dusk (D-535) is a reward that evaporates — and
carrying the haul home yourself is what makes you worth following.

**Floors refill on a timer** (90s). A floor cleared once must not stay cleared,
or the first party down takes everything and the schedule stops meaning
anything to whoever arrives second.

**Two things measurement changed, both found by the bot suite:**

1. **Floor one was not soloable, which contradicted its own design.** Seven
   crawlers at a fourteen-tile notice radius meant a lone unarmed diver was
   swarmed and killed before putting one down — so the very first step of the
   descent was a two-person job, and the floor could not do the job D-535 gave
   it (teach the loop, reward it poorly). Four at nine tiles means one or two
   find you at a time.
2. **Loot rolls were effectively random per RUN, not per seed.** They drew
   from the roamer RNG, which is consumed every tick by wander decisions — so
   whether something dropped depended on how many things were alive and how
   fast the machine was going. Loot now has **its own stream**, and the same
   seed with the same kill gives the same answer. This is exactly the class of
   nondeterminism D-114's harness exists to forbid, and it would have been
   invisible except as an occasionally-failing test.

**The orphan check learned about drops.** `findOrphans` counted only nodes as
producers, so gravebright — which no node yields — failed the build as
unreachable. Monster loot is now a legitimate way an item enters the world,
and for gravebright it is the only way.

**⚠ Every number here is unratified**, and floor three's warden is the one
most likely to be wrong: it opens with five minutes left, so it has never been
fought in a real round.

### D-538: Characters level — and a level may not buy power

**Stakeholder, 2026-08-19:** "flesh out the classes with a moderate list of
tuned skills and feats, and determine the levels they are received."

D-522 ratified persistent characters that level across rounds and left the
mechanism unbuilt: there was no level, no progression table, and no answer to
what a level actually gives you. This is that mechanism, and it is built
around the one constraint that everything else in the Round depends on.

**The constraint, restated because it is load-bearing.** D-207 said Legacy
Points buy access and flavour, never raw power. D-522 applied the same rule to
levels. D-529 then showed what happens if it slips: the Round's betrayal
geometry rests on "going out alone at night is death, so take a partner", and
the partner may be the antagonist. A level that made a veteran able to walk
the night alone would dissolve the buddy system *for exactly the players who
have been here longest*. The rule is therefore not a preference; it is the
thing that stops the mode decaying with experience.

**So a level grants three things and never a fourth:**

| Granted | Never granted |
|---|---|
| feats — verbs and permissions | hit points |
| class abilities — the rites | damage |
| points in non-combat skills | `arms`, or any `creationOnly` skill |

**The fence is enforced in CI, not described.** A skill may be marked
`creationOnly`; `arms` is, and a class progression that grants one fails
`validate:content` with the decision quoted in the error. This is deliberate
paranoia: a class file is exactly where somebody would one day add `arms: 10`
at level five, and it would look reasonable in review. A second rule catches
the other direction — a feat whose `minLevel` is above one and which no class
ever grants is unreachable content, and fails the build. That is invariant 2's
principle (D-210, every item has a consumer) applied to feats.

**Grants are automatic and fixed, not chosen.** There is no level-up wizard.
A physician has the full kit at five, and every physician does. Two reasons:
a schedule is legible to other players in a way a grab-bag of per-character
choices is not — "you are level four, you can mend that" is a thing a cast can
plan around — and it means levelling needs no UI, no pending-choice state, and
no way to be half-done.

**Level is DERIVED from banked xp, never stored.** Storing both is the classic
dual-write bug, and in a round it would be worse than usual: earnings sit in a
pot and are banked only on survival (D-524), so a stored level could be
credited for work the character is about to die and forfeit.

**What was authored.** Fifteen skills (five new: endurance, craft, survival,
persuasion, attunement), twenty-seven feats (thirteen new, most of them
level-granted), and a nine-step table per class covering levels two to ten.
Feats declare their mechanics from a **closed enum** — `carry`, `craft_speed`,
`harvest_speed`, `hunger_rate`, `thirst_rate`, `treat_bonus`, `zombie_cap` —
which the server implements in full. A feat with no `effect` is *declaring*
itself flavour rather than hiding that it is. That distinction matters more
than it looks: a content-driven game whose feat text implies mechanics that
were never wired is lying to its players, and nothing in a schema catches it
unless the schema is asked to.

**Skills now do things that they did not.** `craft` and `survival` shorten
work (capped at half — an instant harvest would delete the vulnerability that
makes gathering a risk), `endurance` stretches the interval between need
steps, `athletics` still sets carry, `necromancy` still sets the zombie cap,
and **treatment now mends as well as closes**: `TREAT_BASE_HEAL` plus
Medicine/20 plus feats, capped by the patient's own maximum. Medicine was
previously a key that opened a door; a physician whose care is worth queuing
for is what makes D-205's dependency social rather than procedural. Treating
someone else pays xp and deeds — healing is a service and D-522 lists it —
while treating yourself does not, or a physician would farm their own scrapes.

**⚠ Unratified:** the xp curve (level 2 at 150, level 10 at 8000, calibrated
against MR2's actual earnings of roughly 150–350 for a surviving round), every
feat magnitude, and the treatment numbers. The tests assert SHAPE, so all of
it retunes without an assertion going stale.

**One thing deliberately not done:** casting classes gain no spells from
levels, because nothing casts yet. Granting them would be exactly the lie the
`effect` enum exists to prevent.

---

### D-539: A character's face is authored, and the authored face is what strangers see

Creation had a class, skills, feats and a name, and for appearance it had a
reroll button. That was always a placeholder — `creator.ts` was built in D-514
as a standalone range-finding tool so the stakeholder could push every slider
until the rig broke, on the understanding that the in-game flow would adopt
the ratified ranges later. This is later.

**The shape: seed first, player second.** The character's integer seed still
generates a whole appearance (D-402); what is stored is a sparse **override**
of the handful of fields the player set by hand. Three consequences, all of
which were the reason for choosing it over storing a whole appearance:

- every character, NPC, roamer and corpse made before this keeps rendering
  exactly as before — no override at all is byte-identical to the old
  behaviour, and there is a test that says so;
- a field added to `Appearance` later is inherited from the seed by every
  existing character, rather than defaulting to something wrong;
- the wire carries a small object rather than a full body description.

**The override reaches the observer, and that is the point of putting it on
the wire at all.** Stranger-descriptors are the whole of D-201/D-219 identity:
until a name is learned, a character IS "a towering, heavy-built figure". A
descriptor computed from the raw seed would describe somebody else — so
`resolveAppearance` is now the only way any code reads an appearance, on both
sides, including `corpseBurden` (a player who built a heavy figure must be
heavy to carry).

**The server bounds the body.** `APPEARANCE_LIMITS` is checked by the wire
schema and again in the handler; colours must come from the world's palettes,
because off-palette colour survives the quantiser badly (D-404) and would make
one character look wrong in a way nobody could explain. The panel's sliders
are narrower than `creator.ts`'s on purpose: range-finding was that tool's
job, and it is not this one's.

**Equipment is not in the override, and that is a design decision rather than
an omission.** Gear is stripped between rounds (D-522) and will be driven by
the inventory. A helm chosen at creation would be a permanent disguise the
recognition system never agreed to — silhouette is one of the few channels
disguise cannot fully close (D-219), and it has to stay honest. The creation
preview therefore dresses nobody, and describes the body undressed.

**Also fixed while in here:** the wizard widened `document.querySelector('.panel')`,
which matches the in-game settings panel — it appears earlier in the document
— so the creation screen had been rendering at 300px in a 720px style. And
the client built every in-world character from the seed alone, which would
have discarded the authored body at the moment it mattered most.

---

### D-540: Bot AI — a round that runs without three people in it

**Stakeholder, 2026-08-19:** "bot AI is needed for testing. The bots should be
able to perform basic functions for each role, and if the bot is the traitor,
a random trigger to go for the objective."

The handoff after MR2 said the remaining risk was **entirely in numbers nobody
has felt**: roamer strength, the floor-three warden, hunger rates, the dungeon
gradient — two dozen of them, none judgeable except against a round that runs
its length. A round needs three players. That is the bottleneck this removes.

`BotClient` already spoke the protocol; `BotAgent` drives it. Three
commitments, each of which changes what a bot round can prove:

1. **They play through the wire and only the wire.** An agent sees what a
   rendering client sees — its own area mirror, its own status, its own
   `round_role`. No server handle, no reading another agent's role, no vision
   into an area it is not standing in. A bot that finds the keeper found it by
   walking there. This is what makes a bot round evidence about the game
   rather than about the harness.
2. **They learn the map by walking it.** Transition targets are server-side by
   design (the snapshot says only where the exits ARE), so an agent discovers
   where a door goes by going through it and remembers the edge. No test
   encodes the shape of the cross, and the map (D-529) can be re-authored
   without touching a bot.
3. **The antagonist commits on its own clock** — a minimum delay, then a
   per-decision roll on its **own** random stream. Before it commits it works
   like everybody else, which is the whole point: the deception has to be
   behavioural, or the bots would only ever exercise the combat code.

Roles — gatherer, forager, woodsman, physician, delver, idler — each know
which nodes to look for and which recipes to attempt. Needs are obeyed (hunger
pushes out, thirst pulls in, D-533), work is done, blows are returned, and the
truce is talked through.

**Three things measurement changed, in the order they were found:**

- **Re-deciding faster than you can act produces paralysis.** The first
  version re-rolled which door to walk to on every decision, and the agents
  stood between two exits shuffling for the length of a round, each tick
  committing to a different one and taking one step. Anything that re-decides
  faster than it acts does this. The chosen door is now held until reached or
  abandoned.
- **Aggression keyed on proximity kills the objective.** Bots originally hit
  any NPC within reach — which meant the good half of the cast would kill the
  tavern keeper by walking past it, and every kill_npc round would resolve for
  the wrong reason. Aggression is now keyed on **having been struck**.
- **A spent seam looks exactly like a full one on the wire.** Charges are
  server-side, so an agent finds out by trying and remembers the refusal for
  ninety seconds. Without it an agent stands at the first exhausted vein for
  the rest of the round. Worth noting that **a human client has the same
  blindness** and no such memory.

**`npm run bots` fills a live round**, so one person can play the go/no-go
gate. That was the actual reason to build this.

**Two holes the bots found in the server, neither fixed here:**

- **A player who joins a running round never receives `round_role`.** It is
  sent once, at round start. A human joining late has the same hole, and would
  be in a round with no idea whether they were the antagonist.
- **`lastResyncDiffs` was comparing across doors.** A snapshot for a different
  area is arrival, not a resync; diffing it reported every entity in the room
  you left as a discrepancy, which turned the desync check into noise exactly
  when a client starts using the map. Fixed in `BotClient` — worth knowing
  that the check was quietly useless for any client that moved between areas.

### D-541: The sound drop — normalised and split where the decoder is

**Stakeholder, 2026-08-19:** a folder of sound files, "the actions/areas they
relate to are in the name", then "they need to be normalized" and "some sounds
are multiple in one file, and they need to be split".

Twenty-four files: six area beds, a menu track, and seventeen combat sounds.
Two of them named "(file needs to be split)".

**What was already true and had to stay true.** The audio layer was entirely
procedural (D-514's ambience, D-531's combat cue) precisely so the repo
carried no assets. That is now over, and deliberately: the procedural layer
survives untouched — hearth crackle, room tone, and the anonymous
through-a-wall combat cue — and the sampled layer sits beside it on the same
`AudioContext`. The two are not alternatives. The procedural cue is what a
player hears when the server has told them a fight is happening *without*
telling them who is in it (D-531), and a sampled death cry through a wall
would hand back the identity the message withheld. **Samples play for what you
can see; the synthesised cue plays for what you can only hear.**

**Where normalisation and splitting happen, and why it is not offline.**

Both were asked for as file preparation, and both run at LOAD instead. The
reason is a hard constraint rather than a preference: half the drop is `.ogg`,
`.mp3` and `.flac`, and this machine has no decoder for any of them — no
ffmpeg, and Python's standard library decodes WAV and AIFF only. Doing the
work offline would have normalised the twelve files that happen to be WAV and
left the ambience beds, the menu music and one of the two "needs splitting"
files untouched. That is worse than not doing it: the inconsistency would be
invisible until somebody walked from the town into the mine.

The browser already decodes every one of these formats, and has to decode them
to play them. So the work happens on samples it holds anyway, it applies
uniformly, and **whatever is dropped in next — in whatever format — is
normalised and split without a build step anybody has to remember**.

The logic is a pure module (`shared/src/audio.ts`) over `Float32Array`, so it
is tested rather than trusted: `shared/test/audio.test.ts` runs it over the
real `maledeath.wav`, and a Python port (`tools/src/probe-audio.py`) reports
the same answer independently. Both find **nineteen takes**; the browser finds
nineteen takes with gains matching the Python probe to two decimals, and finds
**seven** in the ogg that no offline pass here could have opened at all.

**Three details that are the difference between working and nearly working:**

- **RMS, not peak, and silence excluded from the measurement.** `maledeath` is
  fifty seconds of mostly silence around a handful of cries. Measured whole it
  reads as nearly silent, and peak-normalising it would have amplified the
  cries into distortion. Each take is measured and normalised on its own —
  they differ by more than 5× within the one file.
- **A gap must be long enough to be a gap.** A dip inside a scream is not the
  end of a take; treating it as one turns four takes into forty. Takes are
  padded either side so the attack transient survives the cut.
- **A peak ceiling over the loudness target, and hard limits on gain.** A file
  that appears to need 20× is not quiet, it is broken, and amplifying it would
  raise its noise floor into a hiss.

**Beds stream; effects are decoded.** The menu track is around twenty-six
minutes and would decode to roughly half a gigabyte; the beds are tens of
megabytes each. Those play through an `<audio>` element, which means their
samples are never all in memory and therefore cannot be measured up front —
so they are normalised by a slow automatic gain reading the signal through an
analyser toward the same category targets. It converges in a second or two,
which is acceptable for a bed and would not be for a death cry. Effects are
short, so they get an exact measured gain and a precise split.

**Ambience is area content, not derived.** Areas gained an `ambience` field
naming a cue, for the same reason `outdoor` is not inferred from `lighting`
(D-527): a render profile is not the same axis as what a place sounds like,
and coupling them means the day somebody wants a quiet cave they have to
change how it looks. The cue list is content (D-110), schema-validated, and
**CI fails on a cue pointing at a file that is not there** — a silent cue and
an unwired one are indistinguishable in play, so the build has to tell them
apart.

**One new wire event.** `entity_effect` (`heal` | `rite`) is broadcast when a
wound is mended or a rite performed, because those had no observable trace and
a corpse standing up is not a private matter. It carries what happened and
never to whom or why.

**`bow.wav` is authored and deliberately unwired**, marked `status: 'planned'`
like a planned objective: there is no ranged weapon. Attaching it to a melee
swing would be the audio version of a feat whose text implies a mechanic
nobody built (D-538).

**⚠ Unratified:** the loudness targets, and the split thresholds. Both are
unusually easy to judge — getting them wrong is audible inside one round.

**Note on the repo.** `Sounds/` is the raw drop and `client/public/audio/` is
what the game loads, produced by `tools/src/build-audio.py` (AIFF → WAV,
because no browser plays AIFF; everything else copied and renamed). The
conversion is lossless and every other file is copied byte-for-byte, so the
drop folder is redundant once the stakeholder is satisfied — about 49 MB of
it.

### D-542: The world gets objects, walls get their height back, and targeting stops hurting

**Stakeholder, 2026-08-20:** "The maps are pretty bare, can you work on adding
some objects to them. Including crates, barrels, actual walls (Not those tiny
half walls). and allow walls to be semi transparent when the character/camera
is behind them. I want you to make a load of objects of different types,
including the well and other stations (They currently use players as the
object)." And: "Targeting is painful. Make it so that you can left click an
enemy/player to target them, and it shows them as targeted in the hud."

Four faults, and the first one was not on the list because it was invisible
from the outside.

**1. Half the map had no renderer at all.** The round map (D-529's cross) uses
tile kinds `grass`, `dirt`, `tree` and `rock`. `terrain.ts` knew seven kinds,
none of them these, and fell back to `walkable ? floor : wall` — so nine
tenths of every spoke was rendering as grey stone floor, and every tree and
boulder as a knee-high grey stub. The farm, the wood and the mine were the
same grey car park with different names. **This was the largest single cause
of "the maps are pretty bare", and no amount of adding props would have fixed
it.** Grass, dirt, trees (trunk and three crown tiers) and rock (boulders and
chips) are now rendered as themselves.

**2. Walls were knee-high on purpose, and the note said when to change it.**
`terrain.ts` carried this comment: *"Ruined stubs, not full walls: at this
camera elevation a wall of height h occludes ~1.5h tiles of floor behind it,
and full-height walls swallowed characters standing beside them. Full-height
walls need a camera-side cutaway — revisit with the area pipeline in M5."*
The reasoning was right and the cutaway is now built, so walls are 2.5 units
with a capstone course and an occasional ruined stub.

**The cutaway is a dithered screen-space cutout**, not a fade. Every tall
thing — walls, trees, rock, props over waist height — draws with a patched
material that knows where the player is on screen and how deep. A fragment
both nearer to the camera than the player and inside a soft radius of them is
discarded on a 4×4 Bayer pattern. Three reasons for that shape:

- **Instanced geometry has no per-wall object to fade.** The whole area is a
  handful of draw calls, so there is nothing to make transparent one at a
  time. A material patch handles every occluder by one rule at no CPU cost
  and needs no list of what is in the way.
- **Transparency would fight the palette quantiser (D-404)** by introducing
  colours that are not in the palette, and would need sorting against
  instanced geometry and itself. A discard introduces no new colours.
- **Stippling is already the idiom.** The post pass dithers; this dithers with
  the same matrix. It reads as "something is in front of you" rather than as
  a hole in the world, which is why a few pixels are kept even at full
  strength — an entirely erased wall reads as missing geometry.

**3. Stations rendered as people.** Facilities are entities (they are used and
targeted), and `addEntity` had a branch for nodes and piles and then fell
through to `CharacterVisual` — so the well in the town square was a man
standing very still, and so were the anvil, the storehouse and the infirmary.
They are now built from the prop catalogue. The wire also gained `variant`,
carrying the node or station id: the client had been *guessing shapes from
the descriptor's prose*, which is how stations fell through in the first
place.

**4. Targeting measured to a magic pixel.** `entityAtScreen` projected one
point at chest height and took anything within 30px, with no preference by
kind. So clicking a person's legs, head or weapon missed; a resource node
standing near someone stole the click; and zooming out made everything
unclickable. Now each entity is a vertical *segment* from feet to head, the
cursor is measured against the whole segment, the grab radius scales with how
large the thing is drawn, and **people beat scenery** on a tie. Left-click
already selected — what was missing was hitting what you aimed at.

Around it: the target panel gained what it is and how far away it is (and
turns warm within reach), the marker ring pulses so it is findable once there
is clutter on the floor, **Tab cycles targets nearest-first**, Escape and a
click on open ground clear.

---

**Props are area content, not entities.** A prop is a type, a tile and a
rotation. They never move, never act and nobody interacts with them, so
paying an entity id, a wire slot and a delta stream for each of two hundred
crates would spend the netcode budget on scenery. They travel once with the
snapshot.

**The type list is a closed enum the client implements in full** — the same
discipline feat effects follow (D-538) — and a test asserts every type builds
geometry. The failure it prevents is specific and nasty: a type the schema
accepts and the renderer ignores would be an *invisible solid obstacle*.

**Solid props change walkability, and that is why the catalogue is shared
rather than client-side.** A crate the server walks through and the client
draws is the one kind of desync a player can see. `isTileWalkable` consults
props, the client's pathfinder consults them, and **CI's reachability flood
blocks on them** — a barrel authored into the only doorway now fails the
build instead of sealing a spoke in play.

**Placement is generated, not typed.** The map is generated, so two hundred
hand-authored coordinates would be lost the next time a wall moved —
`build-round-map.py` dresses the cross and `dress-areas.py` dresses the three
hand-authored areas. Both place in small **clusters**: three barrels and a
crate together read as somebody's stores, where the same four scattered read
as noise. Both refuse a solid prop on any tile with fewer than five walkable
neighbours (a corridor or a doorway), then run one flood fill and drop
anything that still cut something off — on the tight dungeon floors that
repair pass actually fires, which is the point of having it.

⚠ **A caution learned immediately:** the generator rewrites its areas
wholesale, so the `ambience` fields added by hand in D-541 were silently lost
the first time the map was rebuilt. Anything that belongs on a generated area
belongs in the generator.

**Also here:** `entity_effect` gained nothing, but `shot-receiver.ts` gained a
configurable port after defaulting to 8123 and fighting a dev server for it.

**⚠ Unratified:** the see-through radius (110 device pixels) and how much of
an occluder survives at full strength; wall height; and the dressing density,
which is the number most worth arguing with — a map can be cluttered as
easily as it can be bare.

### D-543: The map editor — and why it writes through a server

**Stakeholder, 2026-08-20:** "I need you to build in a tool that allows me to
place the assets on the map. Can you do this? a map editor that allows me to
place walls and objects."

`/tools` has said **map editor** in the repository layout since the first
commit. This is it, built at the point it was needed rather than up front —
which is the right moment, because the thing it edits (tile kinds that render,
a prop catalogue, walls with height) only became worth placing by hand in
D-542.

**It renders through the game's own `Terrain` and `PropVisual`.** Not a 2D
grid of icons, not a schematic: the same instanced meshes, the same lighting
profile, the same geometry. An editor that draws its own approximation is an
editor that lies about what you are making, and the entire value of placing
scenery by hand is judging how it looks. The one deliberate difference is that
the editor renders **raw rather than through the palette pass** — the
quantiser's ordered dither is the game's look, and it makes a single misplaced
tile nearly impossible to see. You judge composition here and the look in the
game.

**Five tools:** ground and walls (the eleven kinds the renderer actually
draws), props (all thirty-one, grouped, with solid ones marked), stations,
resource nodes, and the spawn point. Brush sizes, rotation, undo/redo per
stroke — a stroke, not a tile, because that is what a person thinks of as one
action.

**The tile palette is the renderer's list, not a free-text field.** D-542's
worst bug was that `grass`, `dirt`, `tree` and `rock` had no renderer and fell
back to grey floor across nine tenths of the map, invisibly. An editor that
let you type a kind would reintroduce that failure one tile at a time.

---

**The design decision worth recording is where the file I/O lives.**

A browser cannot write the repository. The obvious options were to download an
edited JSON for the user to drop in by hand, or to talk to a small local
server. The editor talks to a server, and the reason is not convenience:

**A download cannot be refused.** Saving PUTs the area to
`tools/src/editor-server.ts`, which parses it with the real `AreaSchema`,
floods it for reachability **with solid props blocking** (D-542), and checks
the specific ways a person seals their own map — a barrel in a doorway, a
facility with nowhere to stand within D-530's two tiles, an exit off a
walkable tile. **If anything fails, nothing is written.** The validator
guarding CI is the validator guarding the save button, so the editor cannot
produce content that fails the build. That was proved by accident during the
first real save: three market stalls in a row sealed one tile behind them and
the save was refused, naming the tile.

After a successful write it runs the **full** content validation and returns
what it finds, because a single area cannot know whether it just broke another
area's transition.

The check lives in `tools/src/editor-check.ts` rather than inside the server
so it can be tested without booting an HTTP listener — the guard on the save
button is the thing most worth testing about an editor, and a test that has to
start a server is a test nobody runs.

**Two smaller decisions:**

- **GET returns the SCHEMA-PARSED area, not the file's bytes.** Half the
  schema has defaults, and a hand-authored file may omit any of them; handing
  the editor raw bytes gave it an area with no `lighting`, which the renderer
  met as `undefined`. The editor works on the same resolved document the game
  server loads. The cost is that saving writes those defaults back explicitly,
  which makes content more verbose and more honest.
- **A timestamped copy goes to `content/.editor-backups/` before every
  write**, gitignored. Git is the real safety net; this is the belt, and it
  earned itself immediately when a 3×3 eraser removed more than intended.

**The editor warns on generated areas.** The whole cross is written by
`build-round-map.py`, which rewrites those files wholesale — anything placed
by hand in `round-*` is discarded the next time it runs. The editor says so in
the panel rather than pretending otherwise. ⚠ This is the sharpest rough edge
of the tool and the obvious next piece of work: either the generator learns to
preserve hand-placed props, or the hand-edited areas need a marker it
respects.

**Run it:**

    npm run dev:editor      # the file server, port 8140
    npm run dev:client      # then open /editor.html

### D-544: More editor, a smaller tavern, and props that light the room

**Stakeholder, 2026-08-20:** "I need more controls in the editor. I need to be
able to place/reposition area transition tiles, and change the map size. The
map for the tavern is far too large for example, It needs to be 50% smaller.
Also, can you add some props for doors/windows, foliage, and ensure props with
lighting have a lighting effect."

**Exits are now a tool.** Pick a target area and an arrival tile, click to
place, click an existing one to repoint it, right-click to remove. The panel
lists every exit in the area with a "go" button.

It also says, in the panel, that **exits are one-way**. That is the single
most common mistake this tool can produce: a transition is a door in ONE
area's file, and the way back is a separate transition in the other. A door
that only works in one direction is invisible in the data and obvious in play.

**Map size is a panel, not a tool**, because it is one decision about the whole
area and it can throw work away. It crops or grows from an offset, fills new
ground with floor, drops what falls outside — and **says exactly what it
dropped** ("dropped 31 props, 1 exits"). "Trim to content" finds the tightest
rectangle that still holds everything, plus a one-tile border so the enclosing
wall survives.

**The important new guard is on the other side of the resize.** Shrinking an
area orphans any door pointing INTO it: the tavern going from 64×64 to 32×32
leaves the yard's door aimed at a tile that no longer exists, and the area on
its own has no way to know. `checkAreaForSave` now takes every other area and
refuses a save that would strand an inbound door, naming which area and which
tile. Without this the editor's most attractive feature would also be its most
destructive.

---

**The tavern: 64×64 → 32×32, and re-authored rather than cropped.**

The stakeholder was right, and the measurement is worth recording: the old
room's content filled 62×62 of its 64×64, so there was **nothing to crop**.
Trimming would have thrown away three quarters of the tavern rather than
tightening it. Halving a room means re-authoring it, so `build-tavern.py`
joins `build-round-map.py` as a generator.

The second pass went further than the first, because the first missed the
point: it kept the taproom the full size of the new map. A tavern should be a
room you cross in a few steps with an **outside to arrive from**, so the
interior is now about 20×15 — roughly forty seats, a crowded night — inside a
32×32 plot with an approach, a yard, a treeline and lanterns at the door.

The keeper's spawn moved with it, and the yard's door was repointed in the
same script: moving an entrance without moving what points at it is exactly
the failure the new inbound check exists to catch.

---

**Doors, windows and foliage**, and one rule that made them possible:

Props gained a **`mount`**: `floor` or `wall`. A window belongs IN a wall and a
barrel does not, and before this the schema had one rule for everything ("a
prop inside a wall is a mistake"), which made a window unexpressible. Each prop
is now checked against its own rule, in the schema and in the editor, where
placing on the wrong kind of tile simply does nothing rather than producing
content the save would refuse.

**A door is deliberately NOT solid.** There is no opening mechanic, so a solid
door is a wall with a handle painted on it — and worse, a doorway that cannot
be walked through would seal areas that the reachability check has no way to
know were meant to connect. It is drawn hung ajar.

---

**Lights, and the arithmetic that shapes them.**

Braziers, lantern posts, wall torches and lit windows declare a light in
CONTENT — colour, intensity, radius, flicker, height — so "does this glow" is
one fact in one place and the editor can know it without knowing how anything
is drawn.

They are **not** each a real light. The town carries around forty light-casting
props, and every real light in a Three.js scene is compiled into every lit
material's shader: forty point lights is not "a bit slower", it is a shader
that loops forty times per fragment. So `LightRig` keeps a **fixed pool of
eight** and hands them to the nearest sources each frame. A player sees the
braziers near them lit and the ones two streets away dark, which is roughly
what a real torch does, and anything dropped is too far to judge.

Flicker is the hearth's — layered sines, seeded per source, no per-frame
randomness — so two clients watching the same brazier see the same flame.

⚠ Torch reach was raised from 9 to 15 after the first look: a taproom is wider
than the old radius, so a room with five torches in it still read as unlit.

### D-545: Walls become a family, and roofs are painted rather than drawn

**Stakeholder, 2026-08-20:** "Can you also add different wall types, and a
dynamic roof painter" — and, on materials: "Brick walls, cave walls, and
forest/tree walls for outside."

**Seven wall kinds**: stone, timber, plaster, brick, cave, palisade, and a
**treeline** for closing open ground without a stone wall appearing in a
field. They behave identically — unwalkable, opaque, full height — and differ
in material and silhouette: the palisade is sharpened stakes, the cave wall is
tall and ragged, the treeline is trunks and tiered crowns.

**The dangerous part of this change was not the geometry.** `isTileOpaque`
tested `kind === 'wall'`, so every material added after it would have been a
wall you could **see straight through**. Line of sight is what makes a witness
(D-217), so that would not have been a rendering bug — it would have been a
silent hole in the crime system. Opacity now keys off the family, and a test
asserts every member blocks sight.

---

**Roofs are painted as a footprint; the shape is derived.**

You never draw a roof, you draw where one IS. Touching tiles flood into a
region, the region's bounding box decides which way the ridge runs (along the
longer side, the way a real roof sheds water over the shortest span), and the
surface is a **heightfield sampled at tile corners**.

That last word is the whole difference between the second attempt and the
first, which the stakeholder correctly called awful. The first built one
tilted slab per tile: every slab carried its own rotation, so every seam
opened, the silhouette stepped, and it read as a woodpile. Sampling a
continuous height function at **shared** corners makes neighbouring quads
agree exactly, so each pitch is one unbroken plane — and the ridge, the eaves
and the overhang fall out of the same function instead of being drawn on
afterwards. A ridge beam and a fascia board finish it.

Paint an L-shaped inn and you get an L-shaped roof. Extend a room by two tiles
and the pitch re-derives; nothing needs re-authoring. That is what makes it a
painter rather than a roof asset.

⚠ Pitch was raised twice. At the original cap a roof over a wide building
barely rose and read as a slightly domed field. **Pitch is most of what makes
a roof legible from an isometric camera** — more than colour, more than
texture — and the cap now sits where a hall still reads as a building.

**A roof lifts away when you walk under it** — the whole region, faded out,
not a dithered hole. A hole punched in a roof reads as damage; a roof that
lifts reads as a cutaway, which is what isometric games have done since
Ultima, and it is right here precisely because the roof is not hiding
something dangerous. **Walls keep the dither (D-542)** because a wall is only
ever partly in the way. Two different problems, two different idioms.

**Roofs are presentation only.** They never block movement, they never block
line of sight, and the server does not read them. There is deliberately no way
to express "this roof blocks" — a rendering decision quietly editing who
counts as a witness is exactly the coupling this project keeps refusing.

**The editor keeps every roof up**, so you can see what you are painting;
only the game lifts them.

---

**One small tooling ruling.** The editor may now zoom out four times further
than the game. The game's zoom clamp is deliberate — pulling the camera back
is scouting, and the witness model assumes you see about as far as you are —
so the ceiling is raised by tools only, never globally.

---

## D-546 — Attributes, and a level-up screen that spends them

**Date:** 2026-08-20 · **Status:** accepted · **Supersedes part of D-538**

Every character now carries four attributes — **strength, dexterity, vigor,
will** — starting at **10 apiece with 10 more to place** at creation. The
baseline is identical for every calling: a class is a bundle of access and
options (D-208, D-511), and giving the man-at-arms free strength would make
the calling a stat block, which is the design this project has refused since
D-303.

Each attribute has exactly one job, so that "what does this do" has an answer
rather than a paragraph:

| attribute | what it does |
|---|---|
| **strength** | damage, and carrying capacity — including what a body weighs |
| **dexterity** | the chance an incoming blow only glances |
| **vigor** | maximum health, one point for one |
| **will** | the size of the mana reserve, and how fast it returns |

**Every derived number returns exactly the old value at the base of 10.**
Health at vigor 10 is 20, which is `DEFAULT_MAX_HP`; the damage and carry
bonuses are zero. That is the calibration that lets a character written before
attributes existed read back as the character the old code produced — which is
why migration 0010 backfills nothing, and why `resolveAttributes(null)` is the
one reader everything goes through.

**Mana is a real resource, not a decoration.** It is spent by the rites that
already exist — Speak With Dead and Animate Dead (D-204/D-511) — and it
regenerates **out of combat only**, because a caster who refills while
standing in a fight is not making a decision about when to spend. Spells carry
no cost yet because there is no cast verb yet; that is stated here rather than
papered over with a bar that never moves.

### The tension with D-538, stated plainly

D-538 fenced levels off from raw power: *"a level never grants hit points,
never grants damage."* **Attribute points at level-up cross that fence**,
because strength is damage and vigor is hit points. The stakeholder asked for
it directly, so it is built. What is not negotiable is the magnitude, and the
reason is D-529: the Round's whole betrayal geometry rests on "going out alone
at night is death, so take a partner". A level that made a veteran able to
walk the night alone would evaporate the buddy system for exactly the players
who have been here longest.

So the fence moved, and it moved by **four points across nine levels** — at
levels 3, 5, 7 and 9. At the ceiling that is **+4 health OR +1 damage OR +4
carry**: visible on a character sheet, invisible in a fight. A point per level
would have been +9, which is half a starting character's health, and that
would decide fights.

**Everything else about D-538 stands.** `arms` is still `creationOnly` and a
level still cannot buy it — every character swings with what it bought at
creation, and `validateAdvances` refuses otherwise. Class progression grants
are still **automatic and fixed**, because "a physician has field surgery by
four" is something the whole table can plan around and a grab-bag of
per-character picks is not. Level is still **derived from banked xp**, never
stored.

### What the level-up screen actually is

It sits *on top of* the automatic grants rather than replacing them. A level
hands the player a small budget — skill points, an occasional feat, a caster's
occasional spell, and the four attribute points above — and the screen spends
it. The class deepens on its own schedule; the player decides what else they
became.

Three properties are deliberate:

- **The budget is cumulative, not per-level.** A player who levelled twice
  while away, or who closed the screen without spending, gets it all back.
  Nothing is ever lost by ignoring the screen.
- **The submission is the WHOLE advancement record**, not a delta. That makes
  a resend harmless — which matters because the screen appears exactly when a
  round is tearing its sockets down.
- **Spent points cannot be un-spent.** The screen does not offer the button,
  and the server would refuse the record anyway.

`validateAdvances` is the single rule set: the client renders the screen from
it and the server enforces it (D-102).

⚠ **Every magnitude here is UNRATIFIED** — the four attribute points, the ten
skill points a level, which levels carry a feat, the mana costs, the glance
cap.

---

## D-547 — Equipment, the paperdoll, and a kit for every calling

**Date:** 2026-08-20 · **Status:** accepted

Items may now declare an `equip` block: a slot, and any of armour, weapon
damage, mana and weight. Characters wear them in eleven slots — head, body,
hands, legs, feet, cloak, two hands, an amulet and two rings — shown as a
paperdoll in a new character panel that also holds the pack and the sheet.
One panel, because "what am I wearing", "what am I carrying" and "what does
that make me" are one question a player asks once, and answering it across
three windows is how a player ends up not checking at all.

**Gear is allowed to matter more than a level does**, and that is not an
inconsistency with D-546. Everything here is stripped between rounds (D-522)
and every calling is handed a kit at the start, so a sword that adds damage
cannot compound across a career the way an attribute point can. Round-scoped
power is safe in a way permanent power is not.

Rulings that are consequences rather than opinions:

- **`both-hands` is not a slot a character has.** It is what an item
  *declares*, and equipping one fills main-hand and off-hand together.
  Modelling it as a real slot was the first attempt and it immediately
  produced a shield worn alongside a greatsword, because nothing owned the
  contradiction.
- **Damage takes the best weapon, never the sum.** Summing would make
  dual-wielding strictly correct for everybody — a build decision nobody made
  on purpose.
- **Armour reduces and can never erase.** `MIN_DAMAGE` is 1. An unkillable
  player in a 25-minute round with no respawn is not a tank, it is a
  stalemate the antagonist has no answer to.
- **The slot lives on the ITEM**, not in a list on the character, so the two
  can never disagree about where a thing is — and **every move clears it**
  (transfer, corpse, loot, strip), because an item that arrives in a new
  owner's pack still claiming a slot is a sword worn by somebody who never
  picked it up. A partial unique index in Postgres enforces one item per slot,
  because the gateway is not the only writer of those rows.
- **The paperdoll never feeds the descriptor pipeline** (D-201/D-219). D-539
  already refused authored equipment at creation because a helm chosen once
  would be a permanent disguise; equipping a hood must not silently become a
  presentation change either. Presentation stays its own explicit verb.

**Every calling starts a round with a kit** — a weapon, a body layer, legs,
boots, a trinket or a helm, two loaves and two bandages. The kits are
deliberately close in total worth: the round is a social game, and a calling
that started two armour tiers ahead would make the antagonist's problem
arithmetic instead of deception. It is granted **at most once per character
per round, tracked rather than inferred from an empty pack** — "holds nothing"
is also true of somebody who has just been robbed, and refilling a robbed
player would delete the whole point of robbing them.

Starting-kit items **count as consumers in the D-210 orphan graph**, and CI
now checks kits properly: an unknown item, an unwearable one, a helm assigned
to the feet, or a kit that fills one slot twice all fail the build.

**Gold is not part of round mode** (stakeholder). Coin stays in the persistent
world's economy (D-220/D-221) and is simply not shown while a round runs —
there are no shops, no wages and nothing to spend it on. The mechanic is
untouched, only hidden where it means nothing.

---

## D-548 — A HUD you can read at a glance

**Date:** 2026-08-20 · **Status:** accepted

Three additions, all presentation, none of them touching what the server
decides.

**Bars, not numbers.** Health and mana are bars with the figures inside them,
because the question a player asks mid-fight is "am I nearly out" and nobody
reads a fraction to answer it. Urgency is banded — fine, bad, nearly over —
rather than a sliding gradient, which would signal change when nothing had
changed.

⚠ **Hunger gets a bar too, and that needs care.** D-526 made needs *coarse*
precisely so a player watches the room instead of a draining number. The bar
is a presentation of a stage: it moves in visible steps, it shows the stage's
**name** beside it, and `starving` is drawn nearly empty rather than empty —
an empty bar reads as "this mechanic has finished with you" at exactly the
point starvation starts doing damage (D-534). Thirst shares the label rather
than getting its own bar, because two bars side by side would read as one
resource with two halves, which is exactly what D-533 made them not.

**A compass that follows the camera.** The needle is fed the *camera-space
direction of north* by the scene rather than deriving an angle from the
azimuth. Working it out by hand means re-deciding which axis is screen-right
and whether tile y runs north or south, and getting that subtly wrong yields a
compass that is correct at the default rotation and mirrored elsewhere — a bug
that survives every screenshot taken from the default angle.

**A classic round clock.** Twelve-hour face, two hands, on the round's
compressed cycle (D-527). A twelve-hour face cannot tell noon from midnight,
so the *dial* says which: it shades at night and swaps a sun for a moon. That
is the honest fix; squeezing twenty-four hours onto the face would be
unambiguous and would stop it being a clock anybody recognises. The minute
hand is interpolated client-side between the whole hours the server sends —
cosmetic, bounded by one game hour, and the alternative is a hand that jumps
in twelve-degree steps and reads as broken.

---

## D-549 — Ashfold halved, and built as a street plan

**Date:** 2026-08-20 · **Status:** accepted · **Amends D-530's pacing band**

The town is now **50×50, half its old size** (stakeholder). The old 100×100
Ashfold was a field with five sheds in it: nine tenths of the walking a player
did there was crossing empty ground between buildings that had no reason to be
that far apart.

**The shape is a ring, not a scatter.** A dirt road encloses the tavern and the
well-square; the four working buildings sit just outside it in the four
quadrants; four approaches run from the gates to the ring. A town is a street
plan first and buildings second, and the plan does something mechanical as
well as visual: **every route between two buildings passes the square**, so
nothing important happens out of sight.

**The tavern is at the middle, and the round starts inside it.** Putting the
cast in one room at dawn is the whole of D-536's truce — the antagonist has to
lie to everybody's face before anyone has anywhere to be. It has two doors, on
purpose: a single exit would make the tavern the easiest room in the game to
trap people in.

**The well stays in the open**, between the tavern door and the south gate —
the most overlooked tile in Ashfold, which is exactly what D-529 needs it to
be. A poisoner has to do it where everyone walks.

**There are four working buildings, and the fourth is a guardhouse.** Smithy,
storehouse, infirmary, guardhouse, each in its own wall material with its own
roof (D-545). The guardhouse exists so that "the guards saw you" has a place
on the map rather than being an abstraction the server applies from nowhere.

At this size the far corners are inside `COMBAT_NOISE_TILES` (30) of each
other, which is what finally makes D-531's noise model bite in a settled zone:
a scuffle behind the smithy is heard in the infirmary.

Smaller things that are part of the same change:

- The town is walled with a **palisade**, not an anonymous `wall`. Ashfold
  expects trouble and the fence is the first thing that says so.
- **Tree copses at the four corners** — cover, and the only place in a settled
  zone where line of sight is genuinely broken (D-217). ⚠ The first version
  alternated tiles in a checkerboard and left one-tile pockets, which
  `seal_unreachable` turned to rock, so all four corners came out as rubble
  heaps rather than copses. Solid clumps.
- **The square's furniture is placed by hand** — stalls, lanterns down the
  roads, braziers at the tavern door, a shrine at the well, a signpost at each
  gate. A market whose stalls land wherever the RNG puts them is not a market,
  and scattered lanterns light the back of the smithy instead of the road. The
  scattered clutter is a quarter of what it was, because the area is.
- Areas **no longer all share one size**, so the generator's `W`/`H` are now
  rebound per area and the transition linker computes each edge against its
  own dimensions. Getting that wrong put the town's gates at x=50 on a map 50
  wide.

### ⚠ What this costs, stated plainly

**D-530's measured 30–45 second travel band no longer holds.** A quarter of
every errand used to be crossing Ashfold; halving the town took about eight
seconds off each leg. Measured on the new map, a mid-depth errand is **22s**
and a deep one **37s**, against 30s and 45s before — roughly fifteen seconds
cheaper per round trip.

The obvious compensation would be to grow the spokes, and it is deliberately
not taken: the stakeholder's instruction was that the other areas look right
as they are. So the band in `server/test/round-map.test.ts` has been
**re-measured rather than re-derived**, and what survives unchanged is the
part that was actually about design — depth inside a spoke still costs
meaningfully more than its mouth, or "how deep do I go" is not a decision.

If the longer commitment turns out to matter in play, the lever is spoke size,
not town size.

---

## D-550 — Combat runs in rounds, and reach comes from the weapon

**Date:** 2026-08-20 · **Status:** accepted · **Amends D-538 and D-546 again**

Combat now runs on a **four-second round**, on a global beat —
`floor(tick / COMBAT_ROUND_TICKS)`. Global rather than per-character on
purpose: a shared beat is what makes it a round in the sense the stakeholder
meant, so that "I get one swing this round" is a statement two people can
agree about. Per-character timers would just be the cooldown again with a
longer name.

**A basic character gets one attack in a round.** More comes from feats
declaring `extra_attack`, which are gated behind `minLevel` and arrive through
a class's progression table.

Two gates enforce it and both are needed:

- the **budget** caps how many swings a round is worth;
- **`attackReadyAt` spaces them inside the round**, because without it two
  attacks could land on consecutive ticks across a round boundary — four blows
  in under a second, which is the twitch combat D-104 ruled out.

### ⚠ This is a rebalance, not a restructure

`ATTACK_COOLDOWN_TICKS` was 20: **two swings every four seconds, for
everybody**. One attack per round halves that, and a single `extra_attack`
feat restores today's rate. So the baseline is now half of what every existing
number was tuned against, and a level-8 martial character is back at par.

That is a bigger fence-crossing than D-546's four attribute points, and it is
worth naming as such: **a second attack is double output**, where four
attribute points is four health. It is confined entirely to the feat effect
enum precisely so CI can see every source of it — D-538's argument applied to
a mechanic D-538 would not itself have allowed.

⚠ Both halves of this — the four-second round and where the extra attack sits
— are UNRATIFIED and want the stakeholder's eye in play.

### Reach

Weapons declare a `range` in tiles, defaulting to **one**, so nothing that is
not explicitly a missile weapon gains reach by omission. `handleAttack` reads
the weapon instead of the `ATTACK_RANGE` constant.

**Anything past arm's length requires line of sight**, or a bow would shoot
through the tavern wall — and a witness model built on line of sight (D-217)
cannot have a weapon that ignores it.

Reach travels with the weapon that sets the damage, never separately: a bow in
one hand and a dagger in the other must not give a dagger's damage at a bow's
reach, or the correct build is always "hold a bow you never use".

### Auto-attack

A selected target that is **visibly hostile** is engaged without further
clicking. Mages hit with the staff through the same path — a staff is a weapon
with a damage value and nothing special-cases it — and a bow simply starts
engaging six tiles out.

The switch is a new `hostile` flag on the wire entity, set for roamers,
dungeon dwellers and the animated dead. It is **never set for a player,
whatever they have done**: a wire field saying "this player is hostile" would
be the game making an accusation, which is exactly what D-217 leaves to
players. A player becomes auto-attackable **client-side, by having swung at
you first** — remembered locally and never sent.

That distinction is not fussiness. Guards are NPCs and are deliberately not
flagged hostile; nor is the tavern keeper, who is somebody's objective. If
auto-attack keyed off "is an NPC", clicking the keeper would start a murder.

---

## D-551 — Daylight undoes what walks at night

**Date:** 2026-08-20 · **Status:** accepted

Night roamers no longer vanish at dawn — they **come apart where they stand**.
A new `entity_dissolved` event precedes the `entity_left` that removes them,
and the client plays a slow sag of pale motes drifting *down*.

Deliberately the opposite motion to an impact burst, which throws motes *away*
from a point. The difference is what lets a player tell "it died there" from
"it stopped existing" without reading any text. Slow, too: a fast dissolve
reads as another hit landing.

It is a separate event from `entity_left` because the two mean different
things and a player needs to tell them apart — **a thing that LEFT might be
behind you; a thing that came apart is gone.** That is worth a wire message on
its own.

⚠ The event goes out *before* the entity is despawned. A client that has
already dropped the entity has nothing to play the effect on, which is how the
first version produced no effect at all.

---

## D-552 — The town watch, and something for it to witness

**Date:** 2026-08-20 · **Status:** accepted

Ashfold has **guards**, and D-549 gave them a guardhouse to muster from.

A guard is a **roamer with `habitat: 'guard'`** — the same spawn, hunt,
approach, strike and wander code as a night thing, with exactly one filter
added: *who it is willing to hunt*. Giving the watch its own implementation
would have meant two sets of bugs, which is the same argument D-537 made for
dungeon dwellers.

What differs, and why:

- **They are on the map for the whole round, day and night.** A town whose
  guards go off duty at dusk is a town with no guards on the two nights that
  matter. Daylight does not undo them either (D-551 is for what walks at
  night).
- **They do not hunt on sight.** A guard walks its round until it has
  *witnessed* something. This is the whole design: **the answer to the watch
  is not to fight them, it is not to be seen.**
- **They are not flagged `hostile`.** A watchman on its round is not something
  you auto-attack by clicking on it (D-550) — it is a person, and attacking it
  must stay a choice.
- **They are worth zero xp and carry no loot.** Paying for a guard kill would
  make murdering the watch a farming strategy, and at a cast of three that is
  a better rate than the dungeon.

**Witnessing is line of sight**, exactly as every other question about who saw
what is decided (D-217). A crime round the back of the smithy is not
witnessed; the same crime in the square is.

**Only the culprit is told.** They learn a watchman has seen them; nobody else
is told anything by the game. The rest of the cast has to be told by a person,
which is the only kind of evidence this game recognises. The `wanted` memory
lives on the server, decays after `WANTED_TICKS`, is never rendered, and is
cleared at every round reset (D-525) — the moment "wanted" becomes visible,
the cast can read the antagonist off the UI and the witness model is dead.

Striking a guard is itself witnessed, which is what stops "kill the witness"
being free.

### The well can be spoiled

D-529 named well-poisoning as the antagonist's non-violent attack surface and
the `the-long-hunger` objective has sat at `status: 'planned'` ever since,
because nothing implemented it. It is implemented now, and it is what gives
the watch something to watch for besides a stabbing.

A sprig of bitterleaf and a moment at the well spoils the water for
`WELL_POISON_HOURS`. Drinking from it **deepens thirst instead of relieving
it** and costs health — a poisoner who left everyone watered would have
accomplished nothing.

**Nothing announces it.** The well looks exactly the same; you find out by
drinking, or because somebody watched it happen. It is deliberately cheap to
*do* and impossible to do *unseen* — D-549 put the well in the open square for
exactly this reason. The cost is not the materials, it is the witnesses.

---

## D-553 — The hotbar belongs to the character

**Date:** 2026-08-20 · **Status:** accepted

The hotbar lived in `localStorage`, which meant one bar shared by every
character on the machine and none of it following the player to another
browser. A physician's bar and a berserker's are not the same bar, so it now
lives on the character beside the build, and comes back on the next login.

Sent whole and debounced, for the same reason `advance` is sent whole: a
resend has to be harmless, and dragging a slot around is not worth a message
per gesture.

**The contents are deliberately not validated.** An ability id the client no
longer recognises renders as an empty slot, which is the right thing to happen
when a character loses a rite — refusing the whole bar because one slot went
stale would lose the other eight.

**The character panel gains an Abilities tab**: what this character can
actually do, and the place you drag those things onto the bar from. Dragging a
slot off the bar clears it.

Two lists, and the split is the honest one — things every character can do,
and rites this calling was granted (filtered against the character's real
`abilities`, so a man-at-arms is never shown Speak With Dead).

⚠ **Spells appear, greyed, undraggable, and labelled "no casting yet."** A
character that HAS a spell should be able to see it; a hotbar slot that
silently does nothing is exactly the lie D-538 refused for feats. When a cast
verb exists, the label comes off and nothing else changes.

---

## D-554 — Bodies, heaps, and using what you carry

**Date:** 2026-08-21 · **Status:** accepted · **Supersedes part of D-537**

Five things the stakeholder found by playing. Each is a promise the world was
quietly failing to keep.

### The skill sliders were 22 pixels wide

Allocating skills at creation "did not work", and the reason was CSS. The
description under each row declares `flex-basis: 100%` so it sits on its own
line — but the row never wrapped, so the description stayed on the first line
and squeezed the slider to its minimum width. A range input 22px wide with a
step of 5 and a max of 40 has three reachable positions.

Worth writing down because of how it presented: nothing threw, the value
bound correctly, and the budget arithmetic was right. It was purely a layout
failure, and the only way to find it was to measure the element.

### Everything that dies leaves a body

A roamer used to simply cease at the moment of the killing blow, which reads
as the swing having deleted it. Now it leaves a corpse where it fell.

**And the body holds what it was carrying**, which supersedes D-537's *"loot
goes straight to the killer, never to the floor"*. That ruling was about a
reward evaporating — a pile on a dungeon floor nobody can re-enter after dusk.
A body you loot where it dropped does not evaporate: you are standing on it.
What the change buys is that killing something leaves evidence in the world,
which every other death in this game already does.

Corpses now carry **no character** when nothing that died was a person.
`corpses.character_id` is nullable, which serves three needs with one shape —
a roamer's body, the loot on it, and a heap of dropped goods. `character_id IS
NULL` reads as "this was never a person", and it is exactly what the rites
refuse on: there is no spirit behind a dead dog and nothing to question in a
sack of ore. The refusal is its own answer, distinct from `beyond_reach` — one
means "not a spirit", the other "a spirit you cannot get".

**A body worth looting looks like one.** A pack is drawn beside it, and the
flag is honest in both directions: a settled-zone corpse holds nothing (D-511)
and says so, which saves the walk rather than hiding the disappointment behind
it. Emptying one sends `entity_lootable` and the pack goes.

⚠ That event exists because the first attempt re-broadcast `entity_entered`,
which the client correctly ignores for an entity it already has — so the
"update" did nothing at all and looked like it worked.

### A body you watched fall stays where it landed

The server replaces a dying entity with a separate corpse entity. The client
was playing the ragdoll on the first and building a fresh, pre-settled one for
the second, so you watched a body drop and a different body appear on top of
it in a tidy pose.

The corpse now **adopts the ragdoll that is already falling**, matched by
tile. Anything not witnessed still arrives settled — a corpse found later must
not flop over as you walk up to it, which is what the pre-settle was for.

### What you wear can be seen

Equipping something changes the model. A compact `worn` silhouette rides on
the wire entity — helm, pauldrons, cape, robe, and what is in hand — read off
the SLOT and the stats rather than off item ids, so a new sword looks like a
sword without being registered anywhere. The renderer's `setEquipment` API has
existed since M1 waiting for exactly this.

⚠ **It never reaches the descriptor pipeline** (D-201/D-219, restated in
D-547). What a stranger is CALLED and what they are seen to be carrying are
separate questions, and joining them would make a helm the permanent disguise
D-539 refused to allow at creation. A test strips a character to the skin and
dresses them again, asserting the watcher's descriptor does not move.

Null means "as the seed draws you", which is what keeps every NPC, roamer and
corpse looking exactly as it did rather than being stripped bare.

### A bandage in your pack is a bandage you can use

Two verbs the game did not have: `use_item` and `drop_item`.

`use_item` **dispatches on the template** rather than making the client say
what kind of use it is — eating a loaf and binding a wound arrive as the same
message, so a new consumable is a content change. Items declare what using
them does from a closed enum, for the same reason feats do (D-538): an item
whose description implies a use nobody wired is the commonest way a
content-driven game lies to its players.

A bandage mends and closes **one minor wound**. Major ones stay the
physician's (D-205) — a bandage that fixed them would delete the one
mechanical dependency this game has on another player. It refuses *before*
consuming: linen spent on a whole man is linen a bleeding one does not have.

`drop_item` puts something on the floor as a heap anybody can loot, reusing
the ground-pile machinery corpse decay already produces. **A dropped thing is
moved, never destroyed** — the item row changes owner, which is what keeps the
no-duplication and no-creation invariants (D-114) true of a verb that looks
like a delete.

Both get buttons on the pack row rather than more click-the-row behaviour: a
row that does three different things depending on where you click is a row
nobody trusts.

---

## D-555 — Imported characters, and a retarget nobody has to open Blender for

**Status:** built (spike). Whether the imported look replaces the procedural
one is the stakeholder's call and is not made here.

**Context.** The stakeholder's verdict on the procedural characters
(2026-09-08): *"the graphics for characters are really subpar, and the
animations/models you created are not near to the level I would like."* That
is a fair reading of what D-402's generated-from-a-seed approach produces —
it makes an infinite cast of mannequins, and a mannequin is what it looks
like. The proposal was to import authored art instead.

One constraint decided everything: **"unless the retargeting can be done by
you, automatically, then this won't work."** The stakeholder is hands-off,
does not review code (D-114) and will not run a 3D tool. A pipeline whose
first step is "open Blender and fix the arms" is not a pipeline here, it is
a permanent dependency on somebody who is not in this project.

**Decision: the whole import is a build script.** `npm run build:characters`
reads a Synty Sidekick `.unitypackage` and a folder of Mixamo `.fbx` out of
`assets/incoming/` and writes `.glb` files into `client/public/models/`.
There is no manual step, no engine, no Blender. Dropping a new animation in
the folder and running it again is the entire workflow.

Everything it needs was already installed. `three` ships `FBXLoader`,
`GLTFExporter` and `SkeletonUtils.retargetClip`, and — verified rather than
hoped — **FBXLoader parses binary FBX under Node** with only three stubs
(`tools/src/node-dom.ts`): an inert `<img>`, a blob URL and a `FileReader`,
none of which decode anything. No new dependency was added.

### The bone map is data, written once

Sidekick's skeleton is the **Unreal humanoid** — `pelvis`, `spine_01..03`,
`clavicle_l`, `thigh_r`, and sockets this game will want: `prop_l`/`prop_r`
for a held weapon and a dozen `*Attach` points for worn gear. Mixamo's is
its own naming. `shared/src/rig.ts` holds the dictionary between them, keyed
target-first because that is the direction `retargetClip` reads.

It is deliberately **partial**. Twist bones, the IK chain and the attachment
sockets have no entry, and a bone with no entry keeps its rest orientation
relative to a parent that did move — which is right for all three. Inventing
a mapping for a twist bone is how an elbow comes to rotate twice.

### The correction that made it work is arithmetic, not taste

`retarget` copies each source bone's **world** rotation onto the target. That
is only correct when both rigs agree which way a bone points at rest, and
Mixamo and Unreal do not. Copied raw, the first build stood a 1.78m figure up
and folded it into a **1.0m concertina** — spine, arms and legs all bunched at
hip height. The build succeeded. The file loaded. Nothing said a word.

The fix is per-bone: `sourceRest⁻¹ · targetRest`, rotation only, passed as
`localOffsets`. `retarget` then applies the source's rotation *delta* to the
target's own rest orientation, so a source at rest produces a target at rest —
the property the naive version lacked. Nothing is tuned by eye, so it holds
for any Mixamo clip rather than for the five that were tried. (`localOffsets`
is in three r185 and missing from `@types/three`; the widening is commented
at the call site.)

The hip is the one bone whose **translation** is copied, scaled by the ratio
of the two rigs' hip heights, or the feet skate.

### What is in the files

**Clips live in one file, not in every character.** They address bones by
name, so `animations.glb` drives any outfit. Baking them per character made
the first build 12MB apiece, nearly all of it the same keyframes again; it is
now 318KB once. **Finger tracks are dropped** — thirty of fifty-three tracks,
for joints well under a pixel at an orthographic camera nineteen units out.

**Characters come from the pack's own `.sk` definitions**, not from a
body-plus-outfit rule guessed off filenames. Each `.sk` names its exact parts
and ships a colour map cut to that combination; guessing produced characters
wearing somebody else's palette. Content is data (D-110), including somebody
else's. A `manifest.json` says what was built, so nothing downstream
hardcodes a list that only exists because of what was dropped in a folder.

**The palette is a 32×32 PNG carried alongside the mesh**, not baked in.
Sidekick colours a whole character with one: every UV island lands on a
single texel, so skin, cloth, leather and metal are four *pixels*. That is
why per-character recolouring is cheap — a copy of that image with a few
pixels changed is a new set of clothes — and it is a natural fit for a game
that already quantises to a palette (D-404). Two settings are not optional:
NEAREST, or a bilinear tap invents colours on nobody's palette, and sRGB.

**Body blendshapes are kept and facial ones dropped.** Every part ships
morph targets; the head ships seventy-two of them, a full ARKit facial set
costing 7MB to animate a lip curl nobody can see. The four that survive —
`defaultBuff`, `defaultSkinny`, `defaultHeavy`, `masculineFeminine` — are the
body-shape sliders, and they are how `bulk` and `height` in
`shared/src/appearance.ts` could reach an imported mesh instead of being
quietly dropped on the way in. Widening that list is the whole change if a
close camera ever arrives.

### Verified by measurement, because looking at it is not a test

Two defects in this work were invisible in the build log, silent in the
browser, and found only by measuring (`tools/test/imported-rig.test.ts`):

- a `.glb` whose meshes were bound to joints **not in the file**, because
  exporting the animations first had reparented the skeleton out of the
  character. It loaded without complaint and moved nothing.
- world matrices refreshed from the SkinnedMesh rather than from the top of
  the hierarchy. Bones are *siblings* of the mesh, not children, so every
  bone kept whatever the loader last computed. The hip scale came out 0.14
  instead of 0.91 and the walk became a shuffle 12cm off the floor.

So the suite asserts the shape of a walking figure, not the presence of
bytes: head above hips throughout, neither foot ever at the waist, the two
feet peaking at different times, and forward travel between 0.8 and 2.5 m/s.

The split is: the built `.glb` are **checked in** (28MB for the eight
characters this pack defines), the licensed `.unitypackage` and FBX drops are
**not** (`assets/incoming/` is ignored). CI and a fresh clone therefore never
need the source art, and nobody has to own a Synty licence to run the build.
The suite skips itself when the models are absent rather than failing — a red
suite meaning "you have not bought the art" teaches people to ignore red
suites.

### What this does NOT decide

`/imported.html` puts the two side by side under the same light, camera and
filter, with the palette filter as a dropdown — because it is a toggle, not
a commitment, and if the imported models stand on their own then *raw* is
what shipping looks like. **The art-direction verdict is the stakeholder's**
(D-406, D-504) and this entry does not pre-empt it.

Also undecided, and larger than it looks: the imported characters are one
mesh set per authored combination, while D-539's appearance system and
D-547's paperdoll assume a body that is generated and dressed. Reconciling
them — Sidekick's parts are modular and its skeleton carries the sockets, so
it is possible — is the work that follows a yes, not part of this spike.

---

## D-556 — The importer is not tied to one vendor's licence

**Status:** built. Which art gets bought is still the stakeholder's call.

**Context.** Two questions from the stakeholder on seeing D-555 working
(2026-09-08): could I author models and animations of that quality myself,
and — since apparently not — is Synty's subscription a problem, given
*"I am not allowed to develop anything on the project if the subscription is
cancelled."*

The first answer is no, and it is worth being exact about why rather than
vague. Generating geometry from code is precisely what D-402 does, and the
result is the mannequin the stakeholder has already judged subpar. The
missing thing is not effort or cleverness: authored character art is
thousands of deliberate decisions about silhouette, proportion and edge flow
made by somebody looking at the result, and this project's own doctrine
(D-114) is that I do not get to judge how something looks. Writing more code
raises the ceiling of "stylised primitives assembled well". It does not
reach "somebody sculpted this". Animation is nearer the line — a walk cycle
is keyframes on twenty bones, and now that clips can be retargeted, deriving
variants from real ones (mirrored, retimed, blended, layered) is tractable —
but authoring believable motion from nothing, unseen, is what Mixamo exists
to avoid.

So: art comes from outside. The question is only what happens when a
supplier's terms change.

**Decision: the pipeline takes any humanoid FBX, and the rig it is on is
data.** `assets/incoming/characters/*.fbx` is a second, vendor-neutral
source alongside the Synty `.unitypackage`, and both go through the same
assemble → retarget → export. `shared/src/rig.ts` gained `detectRig`, which
reads a skeleton's bone names and says which rig it is; an unrecognised rig
**stops the build with its name** instead of being retargeted through the
wrong dictionary and exported folded in half. Clips are written **one file
per rig**, not one per character, and each character names its own in the
manifest.

Proven, not asserted: `mixamo-beta` in `client/public/models/` is built from
a plain Mixamo FBX, with no Synty content anywhere in it, and it walks. A
test asserts it (`builds a character that owes nothing to any one vendor`),
so the escape hatch cannot rot quietly.

### What that means for the licence question

- **Animations already have no licence hook.** Mixamo is free, royalty-free,
  and not a subscription. That half of the problem does not depend on
  anybody's terms.
- **Synty sells individual packs outright as well as by subscription.**
  Buying the packs needed is a perpetual licence and sidesteps the "cannot
  develop if I stop paying" trap entirely. ⚠ Terms change and I have not
  read the current ones — this needs checking before money moves.
- **CC0 sources exist** (Quaternius, KayKit and similar) and are genuinely
  unencumbered. Lower ceiling than Synty, but they build through this same
  path with no new code.

The insurance is real either way: whatever is bought, the models are checked
in as `.glb` (D-555), so a lapsed subscription cannot reach into the repo and
remove work already done.

### The bug this shook out

Making the pipeline accept a second source immediately found a defect that
the single-source version had hidden. **A Mixamo FBX exported with its skin
contains TWO complete rigs with identical bone names, one nested inside the
other** — `hips > hips > spine > spine`. The union-by-name assembly claimed
each name only after recursing on the parent, so the inner copy was built a
second time: 129 bones for a 65-bone skeleton, half of them orphaned, the
character scattered over ten metres. The fix is to claim the name *before*
recursing and to walk past any ancestor that is the bone's own duplicate,
deriving the local transform from world matrices so it stays correct however
many duplicates were skipped.

Worth recording because of what it nearly cost: the first fix attempted was
to stop calling `Skeleton.pose()`, which *looked* right — the Mixamo
character improved — while quietly shortening every Synty character by 40cm.
Only measuring both at once showed that `pose()` was never the problem. A
change that fixes the case you are looking at and breaks the one you are
not is the exact failure mode a hands-off stakeholder cannot catch.

---

## D-557 — A third rig, and what a vendor's shader does not bring with it

**Status:** built (evaluation). No purchase is recommended or made here.

**Context.** The stakeholder pointed at Polytope Studio's *Lowpoly Medieval
Fantasy Series* and then supplied the free Modular Armors pack, already
unpacked in a Unity project. Two questions were live: does D-556's
"any humanoid FBX" claim survive contact with a rig nobody had seen, and is
this series a cheaper answer than Synty at a $200 ceiling.

**The rig went in with no argument.** `detectRig` correctly returned NULL and
the build stopped rather than guessing — which is the behaviour D-556 was
built for, and the first time it has fired in anger. The skeleton turned out
to be **Mixamo's, renamed**: every bone is `mixamorigX` with the prefix
swapped for `PT_`. So the dictionary is a transformation rather than a list,
with four genuine exceptions spelled out (Polytope counts
`Spine`/`Spine2`/`Spine3` where Mixamo counts `Spine`/`Spine1`/`Spine2`, and
its toes are `PT_LeftToe` not `LeftToeBase`). Deriving the rest from
`RIG_FROM_MIXAMO` means a bone added there cannot be forgotten here.

The bones left unmapped are the ones that should be: the arm twists, the
five-bone cape chains and the front/back cloth chains. No Mixamo clip drives
them, and **the cape and skirt are exactly what D-519's cloth system already
simulates** — an imported rig arriving with its own cloth bones is an
opportunity, not a problem.

### A character can be a FOLDER

The Sidekick path reads the pack's `.sk` files. Polytope has no such thing:
it ships one FBX per part. So `assets/incoming/characters/<name>/` is now a
character, assembled from every FBX inside it, and a `.png` in that folder is
its texture. **Which parts make a character is then which files you put in
the folder** — choosing an outfit needs no new format and no code change
(D-110). A single loose `.fbx` still means one character, as before.

### The shape tests now run PER RIG, and that is the point

The walking-shape checks previously ran on the first character only. A wrong
bone dictionary does not fail — it produces a character that loads, animates
and is folded in half — so checking one rig would have meant the second one
shipped broken. `it.each(RIGS)` now walks a figure from every rig in the
manifest and asserts head above hips, neither foot at the waist, and the two
feet peaking at different times. All three rigs pass.

### The finding that actually decides it

**Polytope's colour lives in their shader, not in their texture.** Measured,
not assumed: `PT_Armors_Base_Texture.png` is 256x256 with **six distinct
colours, every one of them grey**. The companion `PT_texture.tga` is 249
colours and still overwhelmingly luminance ramps. Colour comes from an
Amplify Shader Editor material that tints regions selected by seven separate
mask textures — Cloth, Metal, Leather, Gems, Skin/Eye/Hair, Lips/Scars,
Feathers.

Amplify is Unity-only. So the imported knight renders as a **white statue**,
and the screenshot proving it is the honest deliverable of this spike.

That is a real difference in kind from Synty, not degree:

- **Synty**: colour is IN the texture — a 32x32 palette where each UV island
  lands on one texel. Recolouring is editing pixels. Zero shader work, and it
  suits D-404's quantisation for free.
- **Polytope**: colour is in the SHADER. Recolouring means writing a
  Three.js material that samples a greyscale base plus up to seven masks and
  lerps between per-group tints, and then making that survive the palette
  post-process.

That is perhaps a day's work and would end up a **better** system than
Synty's — real per-region faction colour, a coat-of-arms slot. But it is a
day Synty costs zero of, and it is unbudgeted.

### The conclusion: the machinery stays, the characters go

The first draft of this entry recommended keeping the free Polytope pack as
the modular character system alongside a Synty environment purchase. The
stakeholder asked the obvious question — *why keep these when the Synty packs
come with their own characters* — and was right. Three of the four arguments
for keeping them do not survive contact:

**The weight comparison was against the wrong pack.** 25,569 verts was
measured against the Sidekick knight's 59,568 — but Sidekick is the modern,
expensive line nobody is proposing to buy. The recommendation is the LEGACY
POLYGON packs, which are a much lighter line, and no legacy character has
been measured. Quoting a favourable number from a pack that is not in the
basket is not a comparison, and it is the kind of error that is invisible
once it is in a summary.

**"Free" is free plus a day.** A Polytope character is a white statue until
somebody writes the mask shader, and that shader then has to be maintained
and has to survive D-404's quantisation. Synty's colour arrives in the
texture.

**And the stakeholder's actual brief was one look.** Mixing two character
lines in one scene is worse than either alone — it fails the requirement
that was stated first.

The Synty basket already carries **26 characters** with colour and skin
variants (Dungeon Pack 16 — knights, goblins, skeletons, ghosts, a rock
golem; Knights 5; Vikings 5). What it does not carry is MODULARITY, and that
is the one real loss: with fixed meshes, a character is chosen per class
rather than dressed, and equipping found gear mid-round can attach a weapon
to a hand socket but cannot show plate replacing leather without swapping the
whole mesh. Bounded, because gear is stripped between rounds (D-522) and kits
are per class (D-547) — but real, and it is the thing to re-open if the
paperdoll ever needs to read on the body.

**What is kept is the pipeline, not the art.** Rig detection stopping the
build by name, folder-as-character, the per-rig shape tests and the Polytope
dictionary all stay: they cost nothing, they are what made this evaluation
take an afternoon instead of a week, and they are what makes the next pack —
from any vendor — the same afternoon. The built `polytope-knight` is removed
from `client/public/models/`; one command rebuilds it from the folder if the
question is ever re-opened.

The series has **no caves, no dungeons, no snow and no dark fantasy**, and
D-523 makes the dungeon structural rather than decorative. That was always
the decisive gap; the character argument was never going to bridge it.


## D-558 — The character studio, and five defects only measurement found

**Status:** built. The art verdict remains the stakeholder's (D-555).

**Context.** D-555 gave the build a pipeline; it did not give anybody a way
to look at what came out, and choosing an outfit still meant copying FBX
files into a folder by hand. That is not reviewable, not diffable, and not
something a stakeholder who does not open 3D tools can do at all (D-114).

**Decision.** A character is CONTENT. `content/characters/<id>.json` names one
part per slot plus a pack and a colour atlas; the art stays out of git and
the decision goes in (D-110). `npm run dev:studio` + `/studio.html` picks the
parts, animates the result and writes the document; the save endpoint refuses
anything that would not build, using the same validator the build uses — the
guarantee the map editor already gives (D-543).

The slot vocabulary is OURS, not a vendor's, with a parser mapping their
names onto it: 720 of 720 parts in the Modular Fantasy Hero pack file
correctly, and a name the parser does not know is skipped rather than landing
somewhere wrong.

**One assembler, shared.** `client/src/render/assembly.ts` is imported by
both the Node build and the browser studio, because a preview that assembles
differently from the build is a preview that lies. Extracting it exposed four
bugs in code that had been working by luck: it was ORDER-DEPENDENT (whichever
part was processed first decided the rig root, so the same character built in
one and threw "two rig roots" in the other); it MUTATED the caller's geometry,
so a part used twice had its skin indices remapped twice; it refreshed world
matrices from the MESH, which is detached in a clone; and it refused multiple
roots, which a cape legitimately has.

### The five defects, and why each needed measuring

Every one of these loaded without an error, logged nothing, and produced a
`.glb` that played. The stakeholder found three of them by looking; none
would have been found by reading the code.

**1. The bone list was not in hierarchy order.** `SkeletonUtils.retarget`
walks `skeleton.bones` IN ARRAY ORDER and derives each bone's local matrix
from `bone.parent.matrixWorld` — so a child listed before its parent is
solved against a stale parent, and the error propagates into everything
below. The assembler emitted bones in discovery order, which is leaf-first:
`neck_01` at index 0 and `Pelvis` at index 4, the entire spine reversed. The
damage was not uniform and that is what made it hard to see — the legs
happened to interleave favourably and came out within 2 degrees, while the
RIGHT FOREARM pointed **82 degrees** away from where the source clip put it.
From the default three-quarter view that reads as an arm held a bit oddly.

**2. Mixamo bakes root motion into the walk.** 155cm of forward hip travel
per 1.03s cycle. The server owns position (invariant 1), so a clip that also
moves the character makes the client the authority on where somebody is: on
screen it slid a metre and a half ahead of itself and snapped back every loop.
Net horizontal travel is now removed from any clip that ENDS AT THE HEIGHT IT
STARTED — a cycle has returned to its own first pose, so the ground it covered
is drift. It is removed as a ramp, which keeps the hips' side-to-side sway;
zeroing the axes would flatten the walk into a glide. Clips that genuinely
finish elsewhere are left alone: `death` ends on the floor and `stand-to-sit`
on a stool. **Those two still travel, and where a corpse ends up relative to
the tile the server put it on is an open question, not a settled one.**

**3. One source file shipped a shadow rig.** `Neutral Idle.fbx` contains two
skinned meshes: `Beta_Surface`, bound to the real 65-bone skeleton, and
`Beta_Joints`, bound to 64 zero-offset LEAF stubs, one hung off each real
bone. Taking the first skinned mesh took the stubs. A retarget reads world
matrices, and a stub's world matrix is its real parent's REST transform times
whatever the clip wrote to the stub — none of the rotation accumulated down a
chain it does not have. The idle retargeted to a figure with its arms folded
over its head, its legs crumpled under it and its hips at 172cm instead of
85cm, while the other four clips, whose duplicate rig is a SIBLING rather than
a shadow, were perfect. The rule is now structural, not a filename: the real
rig is the one that is not a set of duplicates hanging off another rig's bones.

**4. A bone's node transform is not where the bone goes; its BIND matrix is.**
The assembler read node transforms. For every body part in the pack the two
agree to the decimal, so this had never mattered. For a cape they disagree
completely: `back_05` binds across the back at y=53.6 while its node sits at
y=-80.1, BELOW THE FLOOR, because the exporter dropped the socket the chain
hung from. The bind matrix is by definition the bone's transform in the pose
the vertices were weighted against, so that is what is read now.

**5. A cape is not a second root.** Thirteen of the 720 parts are a chain of
their own — `Capes_00 > Capes_01 > back_02..back_06` — with not one body bone
in the file, because the vendor's engine parents it to a socket on import.
D-556's assembler was changed to ALLOW multiple roots, and the note it left
said a cape "is placed in world space and simulated separately." That was
wrong: placed correctly and parented to nothing, it never moved, and the
character walked out from under their own cloak. An orphan chain is now hung
off the body bone nearest to where its topmost weighted bone BINDS, which
needs no table of part names and no socket these files do not ship — a cape
resolves to `spine_03` because that is what it sits against. It stays RIGID
relative to that bone: it travels and turns with the torso but does not yet
flow, which is D-519's cloth system's job and not the importer's.

### Two of the pack's categories are not what their filenames say

Found by the stakeholder reading the studio's own lists, and confirmed by
measuring the meshes rather than by argument:

- **`SK_Chr_Head_No_Elements_*` are HELMETS**, not plain heads with the
  trimmings left off — two to four times the vertices of a bare head, half
  again as deep front to back, and carrying no `eyes` bone at all, because
  the face is inside them. A helmed head IS the head, so it fills the head
  slot and a bare head chosen as well would poke through the visor.
- **`SK_Chr_HelmetAttachment_*` are CRESTS**, not helmets — plumes and horns
  sitting at y=173-195, above the skull, with nothing to mount on unless a
  helm is already there.

Filed wrongly, the studio offered 72 "heads" of which a third were helmets
and a "helmet" list made entirely of plumes. So parts now declare what they
CONCEAL and what they REQUIRE, and the studio greys a slot out with the
reason rather than refusing the save: a crest with no helm and hair under a
closed helm both build perfectly well and are simply never seen, which is a
wasted choice a person has no way of noticing. Concealment is a property of
the PART, not the slot — this pack ships head coverings in three cuts
(`Base_Hair` modelled around hair, `No_Hair` replacing it, `No_FacialHair`
shaving the beard) that all sit in the same slot — so it is read off the file.

### What the studio had to grow before any of this was visible

The preview opened at a fixed zoom that framed a 1.8m figure so tightly the
camera sat inside it; all that reached the screen was a shadow, and the first
report was that the character did not render at all. It now frames from the
measured bounding box. There was also no way to turn the model: the right
forearm defect survived every screenshot taken from the default angle, and it
took the stakeholder asking for another one to find it. Drag to orbit, an
angle slider, three preset views and a speed control that reaches ZERO are
all there because a bad limb is far easier to see stopped than moving.

### The studio now feeds the build

`build:characters` reads `content/characters/*.json` as a third source
alongside the pack's own `.sk` files and `assets/incoming/characters/`, so a
character authored in the studio becomes a `.glb` the game can load. Pack
resolution — turning the NAME a definition stores into a folder of meshes —
moved to `tools/src/packs.ts` and is shared with the studio server, for the
same reason `assemble` is shared: two copies drift, and the failure is a
character that previews and then will not build.

A definition whose pack is not ingested, or which names a part the pack does
not ship, **stops the build by name**. A character silently missing from
`client/public/models/` is the failure that surfaces much later as a blank
space where somebody expected a knight. Two characters claiming one id is
also an error: the id is the output filename, so the second would overwrite
the first and the character would load as somebody else.

CI schema-checks the definitions (`validate:content`), which is not the same
job as the studio's save endpoint — a definition can be hand-edited or
arrive in a merge. What CI cannot check is whether the named parts exist:
`assets/source/` is gitignored and absent there. So it checks everything
that is a DECISION rather than a file — unique ids, id matching filename, a
complete body, and combinations that would build something nobody can see.

`ashfold-guard` and `ashfold-townsfolk` are the first two, and are drafts for
the stakeholder to redo in the studio rather than a ratified roster.

### Which body, and what a helmet rules out

A definition now carries a required **`sex`**, and the studio filters every
list by it. This is not a roleplaying statement and is never shown to
players — it selects which MESHES fit together. The pack cuts most parts
twice and the two do not meet: a female forearm bound to a male upper arm
meets it at the wrong diameter and the seam is visible from three metres.
Parts the pack cuts once — hair, a pauldron, a cape — are unisex and belong
to both, so switching body keeps them rather than clearing the character.
It is required rather than defaulted because a character whose sex is implied
by whichever parts happened to be picked is one mismatched limb from being
neither.

**A helmet also rules out a head covering.** A hood is cut to sit on a skull,
not over a great helm; the two intersect rather than stack.

### A weighting fault in the art, and the discipline of not fixing too much

The stakeholder watched the guard walk and saw the RIGHT wing of his helmet
tear off the helm on every arm swing while the left one held.
`SK_Chr_HelmetAttachment_03` is 98% weighted to the head and has **26
vertices at the root of the right wing weighted, fully, to `clavicle_r` and
`UpperArm_R`**. It is a weight painted onto the wrong bone at the vendor and
would do the same in their own engine.

The first rule written to catch it — "a part bound to a bone unrelated to its
dominant one" — flagged 13 parts of 720, and **most were correct art**: a
skirt legitimately spans both calves, and a hand's weight spreads across
fingers that are siblings rather than ancestors. Repairing on that rule would
have deformed good meshes to fix one bad one. Scanning before implementing is
what caught it.

The rule that survives is narrow and says something true: **a part anchored
on the centre line must not touch exactly one side of the body.** Asymmetry
alone is not a fault — this pack ships sashes over one shoulder and drapes
over one hip, and six parts are deliberately lopsided, all of them binding
BOTH sides unevenly. What no garment does is hang off one side and not the
other, for under a twentieth of its weight, while anchored on the spine.
Across 720 parts that describes exactly one, and it is the broken one.

The correction repoints the influence rather than removing it, so per-vertex
weights still sum to what they did and the part cannot lose volume. It is
**printed by the build and shown in the studio**: the pipeline is allowed to
fix somebody else's art, but not to do it quietly — a silent fix is a silent
claim that the art was fine.

**⚠ Still unreconciled with the rest of the game.** Imported characters do
not go through D-539's appearance system or D-547's paperdoll, and nothing in
the game renders them yet — the procedural `CharacterVisual` is still what
`main.ts` draws. Deleting it first would leave the game with no characters at
all.


## D-559 — The imported cast in the game, behind a toggle

**Status:** built. **The art verdict is still the stakeholder's** (D-555) —
this is what makes it possible to give, not an attempt to pre-empt it.

**Context.** D-555 built the importer, D-558 built the studio, and after both
of them nothing in the GAME had changed: `main.ts` still drew D-402's
procedural characters and the imported ones existed only on a slab in
`/imported.html`. A verdict on art cannot be given from a viewer. Whether
these characters are right for this game depends on how they read at
isometric distance, through D-404's quantiser, in a lit tavern, next to
somebody else — none of which a turntable shows.

**Decision.** `ImportedVisual` is a drop-in for `CharacterVisual`: the same
eighteen members `main.ts` drives, held in one union, so the world code does
not know which cast it has. A **setting** picks between them, defaulting to
`procedural` — the imported cast is the thing under evaluation, not the
thing that ships.

The interface between the two is enforced by the COMPILER rather than by a
test. `main.ts` holds them in a union and calls eighteen members on it, so a
member missing from either is a build failure — which is a better guarantee
than any assertion, and it is why this was done as a union rather than as a
second code path with an `if` at every call site.

Models are loaded once and shared: a crowd is twenty entities over three
models, each instance a skeleton clone over the same geometry, material and
palette. `dispose()` therefore does NOT dispose them, or the first guard to
die would blank every other guard in the room.

### What it does not do, stated on the members that do not do it

- **`setPresentation` is a no-op.** D-219's hooded silhouette is what the
  recognition system depends on being visible — a hood dropping in view is
  what merges two identity threads — and a fixed mesh has no hood to raise.
  On the imported cast a hooded figure looks exactly like an unhooded one.
- **`setEquipment` is a no-op.** D-554 put a `worn` silhouette on the wire so
  equipping plate changed the model; these characters wear what they were
  built wearing. A studio definition IS the outfit.
- **No emotes.** The drop has five clips and none of them is a bow.
- **Kneeling borrows the sit**, because there is no kneel. Better a figure on
  the floor than one standing upright through a prayer.
- **Only HEIGHT survives from D-539's appearance.** The server's descriptors
  call people towering or slight (D-201) and a cast of identical statures
  would make every one of those a lie, so instances are scaled from the
  built height to the wire height. Build, shape and colouring are not
  expressible on a fixed mesh.

Those are the cost of a yes, and they are the work that follows one.

### Which character an entity is drawn as is UNRESOLVED

Chosen from the appearance seed. That much is defensible — the seed is the
server's (D-102), so every client agrees and a person keeps the same body
between sessions — but it is **arbitrary**: nothing connects the guard model
to a guard. Saying which character an entity wears is a wire field and a
decision about how a roster relates to classes and to D-522's persistent
characters, and neither is made here.

The seed is MIXED before the remainder is taken, and the test for it uses
seeds that share their low bits rather than consecutive ones. Over
consecutive seeds a plain `seed % 3` distributes perfectly well and proves
nothing; over multiples of the cast size it collapses to a single model —
300 seeds, one man, the whole tavern.

### Two bugs worth recording, because neither threw

**The rebuild hung the tab.** Switching cast has to rebuild the characters
already in the world, or the change appears to do nothing until you walk
through a door and the person judging the art concludes the toggle is
broken. The first version deleted and re-added each entity while iterating
the `entities` Map — and a Map iterator visits entries inserted DURING
iteration, so re-adding under the same key moved it to the end and the loop
found it again, forever. No exception, no error in the console: the page
simply stopped painting. Snapshot the entries first.

**The models loaded after the world was built.** `preload()` is kicked off
in `applySnapshot`, but `addEntity` runs synchronously further down that same
function, so on the first snapshot of a session `available()` was still false
and every character was built procedural whatever the setting said. The
manifest is now fetched at module load, and the world rebuilds if the models
land after it. This is the same class of mistake as the Map one — an
ordering, invisible until somebody looks at the result and says "the toggle
does nothing".

**And one that was visible but easy to misread:** the palette came out black
and yellow, because the atlas was loaded with `flipY = false`. That is the
right convention for textures glTF's own loader brings in, but this atlas is
loaded separately and applied to UVs that came through the FBX exporter.
Flipped, it samples the wrong row — which does not look like a bug, it looks
like the artist chose black and yellow.

⚠ **The procedural `CharacterVisual` is NOT deleted and must not be until
the stakeholder says yes.** It is the cast that renders every appearance the
server can describe, wears equipment and raises a hood; the imported one is
three characters that do none of those. Deleting it on a maybe would leave
the game with no way back.


## D-560 — Creation rules as content, and what this art can actually vary

**Status:** part built. Naming and races are in; classes, race-per-class and
keyword gating are the next two pieces.

**Context.** D-555 imported the art, D-558 built a studio to assemble a
character from it, D-559 put the result in the world behind a toggle. None of
that touched the thing that decides what a PLAYER looks like. The correction
came from the stakeholder and is worth recording as the reason this decision
exists: the imported art should reach the world THROUGH character creation,
not by replacing the system that reads a player's choices. D-559's toggle
swaps one cast for another wholesale; that is a way to look at the models in
situ and is not the direction.

### Two measured facts about the art, which bound everything below

**Skin is four colours, so a tone is a colour and not a file.** The atlas
suffix `_A/_B/_C` changes ONLY the skin pixels while the number `01`–`04`
changes the clothing colourway. But going further and diffing every pixel of
those variants shows skin in this art is exactly **four flat colours** out of
a 1024² atlas:

    #ffccae  235,306 px   the skin itself
    #edaf97    6,935 px   a warmer shade - lips, the inside of an ear
    #cdb3a1    5,700 px   a greyer shade
    #433622    3,577 px   the deep shadow - eye sockets, an open mouth

So any colour a person picks is reachable by four exact substitutions, and a
race stores an **RGB** rather than a texture name. Three tones was a property
of how many files somebody exported, and it should not have become a property
of the game — the stakeholder asked for a picker, and the measurement is why
one is not only possible but exact. The three shades are derived from the base
by ratios measured as the mean across the vendor's own three tones, so a
picked colour is shaded the way an artist shaded theirs. The same four colours
appear in all four clothing colourways, so a tone composes with whatever a
character is wearing instead of replacing it. NEAREST filtering is what makes
the substitution safe: every UV island lands inside one flat region, so
replacing a colour cannot bleed into its neighbour.

**⚠ There is essentially no bare body.** Measuring which parts sample the
skin band of the atlas, across all 720:

| slot | parts | fully bare |
|---|---|---|
| head | 46 | 37 |
| hair / eyebrows / facial hair | 38 / 17 / 18 | 36 / 17 / 18 |
| arms, hands, legs | 36–42 each | **one per body** |
| torso, hips | 58 each | **none** |

This pack does not do "naked body, clothing on top" — a body and its clothes
are the SAME MESH. Two consequences, and neither is negotiable by writing a
different schema:

1. A creation screen restricted to base body parts can offer a real choice of
   **face, hair, ears, skin tone and stature**, and essentially no choice of
   body. So that is what a race is here.
2. Equipment must SWAP the torso and limb meshes rather than layer over them.
   Anything that wants a visible body underneath needs different art.

### Decision

**Part names are content.** `SK_Chr_Head_Male_04` is the right name for a
file and the wrong name for a person, and nothing downstream — a creation
screen, a character sheet, a description — can show a filename. So
`content/parts/<pack>.json` maps a part to what a player is told it is
called. Only the DECISION is stored: which slot a part fills, which body it
is cut for and whether it is bare are all derived from the file, and writing
them down as well would create two sources that can disagree.

**A race is a face, a stature and a set of skin tones.** `content/races/*.json`
names which parts a player may choose per slot, the height range per body,
and the tones. Curated, not "everything in the pack": a screen offering 46
heads is a catalogue rather than a choice, and a race means nothing if every
race offers the same faces.

**One tool, `/creation-tool.html`**, served by the same authoring server as
the studio — one process, because both read the same art and a second port is
a second thing to remember. Naming is built for VOLUME: every part in a slot
is a row with its field already there, so the job is look, type, Enter, and
122 parts is 122 keystrokes rather than 122 clicks. Race curation is chips
that preview on hover, because the job is comparing faces against each other
and forty stems in a scrolling box is not a comparison. An unnamed part shows
as its file stem in warning colour, so unfinished naming is visible rather
than quietly indistinct.

The preview looks a character in the EYE — `setOrbitHeight` at eye level
rather than the game's overhead orbit, which is the one angle a face cannot
be judged from. It shares `assemble()` with the build, so what is approved is
what ships.

### A bug this found in the assembler, which a whole character could not

`Skeleton.pose()` restores each skinned bone's LOCAL matrix from its bind
matrix relative to its PARENT'S WORLD matrix — and it only sets world
matrices for bones that are in the skeleton. A bone nothing is weighted to is
not in the skeleton, so on a freshly built hierarchy its world matrix is
still identity, and every skinned child of one lands at its bind position
measured from the ORIGIN instead of from its parent.

A whole character never showed it, because almost every bone in that chain
carries weights and `pose()` had already placed the parents it needed. A
single head does: its `spine_03` is an unweighted ancestor, and the head
assembled **1.6 metres behind the character** — exactly its own eye height,
which is what "measured from the origin" means for a bone at eye level. The
fix is one line, `group.updateMatrixWorld(true)` BEFORE `pose()`, and the
test is a head assembled alone.

This is the third time (D-558's bone ordering, D-558's bind matrices, this)
that a defect in the assembler was invisible until something ASSEMBLED
DIFFERENTLY. Sharing one assembler between the build, the studio and this
tool is what keeps finding them.

### Face markings, and the one atlas that hides them

The stakeholder named nine of the twenty-three male heads and stopped,
reporting that the rest had "no visible difference" and guessing they were
tattooed faces whose colour was not being applied. That was exactly right,
and finding it took four measurements rather than one guess:

1. **The heads are all different.** Deduplicating vertex POSITIONS — the
   shape, not the topology — gives 23 distinct shapes from 23 files. Vertex
   counts differ too, but that alone proves nothing: extra vertices are
   usually the same shape split at UV seams.
2. **The tool was rendering them correctly.** Hashing the canvas pixels per
   head gives a different hash for each, and the same hash again when a head
   is revisited. My own reading of three screenshots as "identical" was
   wrong; the eye is not an instrument.
3. **A colour was missing.** Every head samples 3–5 flat colours, and heads
   09+ sample one more: `#4566a9`, a saturated blue. Zero blue pixels reached
   the canvas.
4. **It is on the face, and only on faces.** Mapping each vertex's UV to its
   atlas colour puts those 96 vertices at x ±8.9, y 160–174, **z +8.4..12.9**
   — the front of the upper head, around and above the eyes. Across all 720
   parts in the pack, exactly 28 sample that colour and all 28 are heads.

**The cause was the atlas.** `PolygonFantasyHero_Texture_01` — the one with
no colourway suffix, which I had chosen as the default precisely BECAUSE it
looked like the neutral one — is the **markings-free cut**. Sampling one
marked head against each atlas:

    01.png    #ffccae x372  #cdb3a1 x312  #000000 x60          no blue at all
    01_A.png  #ffccae x318  #cdb3a1 x270  #4566a9 x96  ...     96 verts of war paint
    01_B/C    same 96                                          markings survive every tone

So the marked heads sampled plain skin and became indistinguishable from the
unmarked ones — and the nine heads the stakeholder could name were precisely
the nine that carry no markings. `preferredAtlas()` now refuses the
unlettered atlas, in the studio and the creation tool alike, and the two
authored characters were re-textured.

**Markings became a choice rather than an accident.** No other part touches
that colour, so it is a channel of its own: a race now carries `markings`
beside `skinTones`, both pickable, and recolouring one cannot disturb the
other. On some heads the paint is the ONLY thing distinguishing two
silhouettes, which makes its colour worth deciding rather than inheriting.

⚠ **The duplicate-name warning had to learn the same lesson.** It first fired
on a "Normal" head beside "Normal" eyebrows, then on a male "Angry" brow
beside a female one — neither pair can ever appear in one list. Scoped to the
same slot AND overlapping bodies it fires once, on two unisex hairstyles both
called "Long", which is a real ambiguity. A warning that cries wolf is worse
than no warning.

⚠ **Still to build:** classes as an authored thing (starting stats and
progression already exist as content; what does not is an editor for them),
which races a class admits, and keyword tagging so equipment, spells and
actions can be gated per class/race/body. The in-game creation screen is
untouched — it still asks calling → appearance → attributes → skills → feats
→ spells → name, with `appearance` driving the procedural rig. Wiring it to
read races is the step after the tool is complete.


## D-561 — Naming the rest of the packs, and where animation actually varies

**Status:** built — body parts, worn items, environment and pickups are all
nameable. Animation is DEFINED and not yet implemented: no clip is bound to
an action anywhere.

**Context.** D-560 named the face and stopped there, because the creation
screen only asks about faces. Everything else in five packs — 1,456 character
parts, 652 environment meshes, 477 props, 330 buildings, 163 weapons, 35
items — still had only a filename, and a filename is the one thing that
cannot be shown to a player.

### Where animation belongs, which is not under race

The stakeholder asked whether animations should hang under race and then
gender. They should not, and the reason is the weapons.

Three things want to change how somebody moves. **The rig**: clips bind to
bones BY NAME (D-555), so a set belongs to a skeleton, and every character in
this pack shares one. **What they are holding**: a greatsword changes idle,
walk and every attack, and there are 163 weapons here across a handful of
weapon classes. **Race and body**: real, but flavour — a heavier gait, a
different idle.

Nesting animation under race leaves the heaviest case with nowhere to live,
and forces a set per race × body × weapon. So sets LAYER instead:

    rig  <-  race + body  <-  stance

Same shape at every layer, resolved in that order, anything unspecified
falling through. A stance that names only `attack-1` changes the attack and
inherits the walk, which is what makes 163 weapons expressible as a handful
of stances. Resolution is by LAYER rather than by argument order, so a caller
collecting sets from three files cannot change the answer by accident.

**The action vocabulary is closed** — 62 actions across locomotion, combat,
reaction, interaction and emote. A set naming an action nothing implements is
a promise the renderer never keeps, which is the lie D-553 refused for hotbar
spells. Only `idle` and `walk` are REQUIRED: everything else may be missing
and simply not play, but a character with neither is a statue that slides.

### Three tabs, one implementation

Worn items, environment and pickups are the same job — a mesh with a name
nobody can show and properties nothing can infer — so they share a list, a
preview and a save, and differ only in the property panel. The vendor's own
prefixes (`Wep_`, `Bld_`, `Env_`, `Prop_`, `Item_`) sort meshes into the
three tabs, and `kindOfMesh` returns NULL rather than guessing: a mesh in the
wrong tab is one somebody has to notice, a mesh in no tab is one they go
looking for.

Names are drafted from the filename as a PLACEHOLDER, never filled in. A
hundred rows of accepted guesses look exactly like a hundred rows somebody
read.

Environment assets carry `solid` and `opaque` as SEPARATE flags. A fence
stops a body and not an eye, and conflating them is how a witness sees
through a wall or fails to see over a rail (D-217, D-545).

### ⚠ The packs disagree about units, by a factor of a hundred

Measured across the weapons in each pack:

    dungeon-pack   longest dimension 0.75..2.38    METRES
    knights        longest dimension 68..203       centimetres
    vikings        longest dimension 56..169       centimetres

Characters are centimetres. A pipeline that assumes one convention renders
the dungeon pack's axes a centimetre long, or the knights' swords two metres
across a room — and nothing in a file listing shows it. So a worn item stores
its own `scale`, the tool guesses a starting value from the mesh's own extent,
and the panel shows **what it would measure in centimetres once placed**. A
guess that cannot be seen is the same defect as a unit that cannot be seen.

### Smaller things this turn

**Every slot is nameable, not only the face.** A torso still needs a name —
it is what a player is told they are wearing — and the creation screen is
only one of the readers. Creation slots are marked with a star rather than
being the only ones listed.

**A part is previewed where it is worn.** A pauldron floating in space says
nothing about whether it is the right pauldron; on a shoulder it does. Body
slots assemble onto the bare `_00` mannequin, which needs no table of names
because the bare set sorts first in every slot. The camera pulls back for a
body and returns to eye level for a face.

**The preview looks at the middle of the thing.** `follow` aims 0.9m above
the point it is given, so a barrel on the floor previewed at focus 0 put the
camera's line through empty air above it — which reads as "nothing
rendered" rather than as a framing mistake.

⚠ **Still to build:** a class editor, which races a class admits, and the
keyword gating that ties equipment, spells and actions to class and race —
the `tags` field exists on every asset and nothing reads it yet. And no clip
is bound to any action: the vocabulary is the foundation, not the wiring.


## D-562 — Mirroring names, and what a "set" turns out to be

**Status:** mirroring and base-part marking built. The garment editor is
proposed, not built.

**Context.** The stakeholder named all 29 male torsos and asked for a "set"
system: define which parts belong to a set, name the set, have the members
named automatically — expecting that female parts could be named from male
ones by number. They then questioned whether it was worth it, since character
creation only needs the NUDE parts and everything else is armour that only
matters when worn.

Two separate claims, and they do not have the same answer.

### The male/female pairing is real, and measured

Comparing which atlas islands each part samples, same number against a
control of every other number in the same slot:

| slot | same number | different number |
|---|---|---|
| Torso | **0.96** | 0.36 |
| Hips | **0.97** | 0.23 |
| LegLeft | **0.94** | 0.24 |
| ArmUpperLeft | **0.89** | 0.14 |
| HandLeft | **0.94** | 0.13 |

`Torso_Female_12` is the same garment as `Torso_Male_12`, cut for a different
body. So names carry across, and one button saves roughly three hundred
entries. It **never overwrites**: somebody who has already named a part
looked at it, and a bulk operation that silently replaces considered work is
one nobody dares press twice. The body word inside a name is SWAPPED rather
than copied — "Studded leather male" arriving on a woman is exactly the
mistake that survives three hundred rows unnoticed — and whole-word only, so
"Malevolent" keeps its middle.

### A number does NOT group slots into an outfit

Tested twice and neither test found a signal. UV-island overlap across slots
sharing a number: 0.08–0.21, against 0.11–0.15 for different numbers — but
that metric is void anyway, because an arm and a torso sample different parts
of the atlas whether or not they belong together. Garment-COLOUR overlap,
skin excluded, which does not have that flaw: **0.34 within a number against
0.33 across**. No signal at all. The pack dresses every outfit from one small
palette of greys, browns and leathers.

So the tool does not offer cross-slot sets. An auto-name derived from an
unverified premise is worse than a blank, because a wrong name looks finished.

### What a set actually is, and it is not a naming device

The stakeholder's own follow-up settles the design: *"just because an asset is
in a set, it doesn't mean that set will always be present together — you could
have gloves from one set mixed with a torso from another. Some armor items
may have the arms bare, or with the set arms."*

That rules out a set as a group that is worn whole. A set is a **wardrobe**,
and the thing the game equips is a GARMENT: a list of slot → mesh swaps,
which may cover one slot or five, and which mix freely with every other
garment. This follows from D-560's finding that a body and its clothing are
the same mesh in this art — equipment SWAPS meshes rather than layering over
them — and a garment is precisely that swap list.

⚠ **Not built.** It belongs in the Worn items tab beside the rigid props, and
it is authored by LOOKING at the assembled result rather than inferred from a
number, since the numbering has just been shown to mean nothing across slots.

### Bare parts are measured and REPORTED, never decided

The distinction that matters for creation: a character is built from a body,
everything else is a garment. Skin occupies the bottom 0.31 of the atlas
(measured as the only pixels that differ between the light and dark skin
variants), so a part's bareness is its UVs and nothing else — not its number,
because `_00` being the nude one is a convention this pack happens to follow.

⚠ **A threshold would have been wrong, and the torso is why.** No torso in
this pack is fully bare: the nude one still has a waistband and measures
**71%**, while the next barest is "Straps" at 29% and everything else is
under 10%. A cutoff strict enough to exclude a shirt excludes the nude torso
too — which is the one slot where getting it wrong matters most. So the tool
prints the percentage beside every part, marks only what is essentially all
skin, and leaves the rest to a person. The gap between 71% and 29% is
obvious to an eye and invisible to a threshold chosen in advance.

The mark is stored as a `base` TAG rather than in the name, so it survives a
rename.


## D-563 — Attaching a weapon to a hand, and drafting six hundred names

**Status:** built.

**Context.** Three things the stakeholder found by using the tools: there was
no visible way to set a worn item's attach point; the race tab offered only
the face; and the weapon and item filenames are accurate enough that naming
them by hand was needless.

### The attach point existed and was unusable

There WAS an "Attach to bone" field — it appeared only after an item was
named, and it was a free text box expecting `Hand_R`. Nobody should have to
know how a rig spells its right hand, and a typo in a free field is an item
that silently hangs off nothing. It is now a list of the rig's 47 actual
bones, with the likely ones first.

**But the real defect was the preview.** A weapon was drawn floating on its
own, so there was nothing to judge an attach point AGAINST. It now hangs off
the chosen bone of an assembled body, live, so the offset fields are worth
having. Four things had to be fixed to get there, and every one of them was
silent:

1. **The preview ran on FOCUS, before the item existed.** Naming a mesh is
   what creates the asset, and naming re-rendered the property panel but not
   the preview — so the body never appeared. The one path nobody tests is the
   first time.
2. **The body was wearing the wrong atlas.** A hero mesh painted from the
   knights atlas samples whatever sits at its UVs, which comes out as a
   bleached mannequin. The body wears the CHARACTER pack's texture; the item
   wears its own.
3. **The bone's world scale was ASSUMED.** The body is scaled 0.01 because
   the art is centimetres, so 0.01 looked like the factor to divide by — but a
   bone's bind matrix carries scale of its own, and the sword came out a dot
   in a fist. It is measured with `getWorldScale` now, which also makes the
   stored offsets mean metres whatever a future rig does.
4. **The body is CACHED and shared**, so each preview parented another weapon
   to the same hand without removing the last. A knight would have ended up
   holding every weapon in the pack, each hidden inside the next.

And the framing is measured from the assembled bounds rather than a fixed
zoom: a T-posed body is wider than it is tall and a weapon sits past the end
of an outstretched hand, so a zoom chosen for the torso cut off the very
thing being judged.

### Names drafted from filenames

`npm run name:assets` drafts every weapon and pickup name from its filename
and guesses how it is carried. 199 assets across four packs in one run. The
stakeholder asked for it, the filenames are descriptive, and the alternative
was six hundred lines of typing.

It **never overwrites**: an asset already in the file was looked at by a
person. Re-running after a new pack arrives adds only what is missing.

Trailing modifiers move to the front, because `Axe_Nature` is a filing
convention and not a name — "Nature axe", "Large hammer", "Large crystal
axe". The `Chr_` infix in `Item_Chr_Bag_Large` is dropped: it says the vendor
files the thing under characters, which is not part of what it is called.

⚠ **The first version of that hung the build.** It rotated one word at a time
and looped while the new last word was a modifier, so `Bone_Spikes` became
`Spikes_Bone` became `Bone_Spikes` forever. It did not throw and it did not
log — the command simply never returned. Moving the whole trailing block in
one pass terminates by construction, and there is a test named for the case.

Buildings and props are deliberately NOT drafted: 1,459 meshes whose names
are mostly `Wall_01`-shaped, and filling the files with that is noise nobody
asked for. The environment tab is there for the ones somebody wants.

⚠ Stance and attach are GUESSES from the name — shield to the off hand, a
spear to polearm, everything unrecognised to the right hand and one-handed.
A wrong stance is one dropdown to fix; a wrong attach is a sword through a
wrist, so the fallback is the safe one.

### A race is not necessarily humanoid

The race tab offered only the five face slots. The schema always allowed
every slot; only the list did not. It now shows all of them, and below the
neck it offers the parts marked `base` with a "show all N (garments)" escape
— because listing 29 torsos as things a race can BE is offering a wardrobe as
an ancestry, while a race whose body IS a garment (a skeleton, a suit of
armour) needs the full list. A body part is previewed on a body there too,
for the same reason it is in the naming tab.

---

## D-564 — An animation library, the sets that bind it, and 163 weapons placed by rule

**Status:** built.

**Context.** The stakeholder asked for the whole animation half of the
character work in one go: fetch every relevant clip from Mixamo, build a
system that turns clips into usable sets, and — since the sets are chosen by
what a character is holding — get the 163 worn items into hands that can
hold them. D-561 had already written the vocabulary and the layering and said
plainly that **no clip was bound to any action yet**. This is the wiring.

### Getting the clips out is not the interesting part, but it is where the time went

The library's own API is what makes this automatable at all: search, export
with `{ format: fbx7_2019, skin: false, fps: 30, reducekf: 0 }` and
`inplace: true` wherever the motion supports it, poll the job, take the
presigned URL. `inplace` matters more than it sounds — it is what stops the
walk arriving with 155cm of root motion baked in, the defect D-558 had to
strip out of the first five clips after the fact. Asking for the clip without
its skin matters too: it is bones and curves and no 3MB character nobody is
going to draw.

⚠ **Three things blocked the obvious route, and the third is a rule rather
than a workaround.**

1. The presigned URL is **CORS-refused to the page** that produced it, so the
   browser cannot fetch its own download.
2. **Chrome stops honouring repeated automatic downloads.** The click-an-anchor
   route worked for seventy-one files and then silently stopped: `a.click()`
   returned, no error appeared, and the file never landed. Every batch after
   that looked successful and claimed nothing, which is exactly the failure a
   count check is for — `claim-downloads.ts` refuses to match names to files
   by order when the counts disagree, because a shifted match names a walk
   "death" and nothing about it looks wrong until somebody dies.
3. The remaining route — Node fetching the presigned URL, which works, since
   presigned means no session — needs the URL to reach Node, and every path
   out of the page is closed by **the site's own Content-Security-Policy**
   (`default-src 'self'`, and a `connect-src` naming only its own hosts). ⚠
   **Engineering around a site's CSP is not something to do**, so the URLs
   were carried out by hand instead: slower, noisier, and the correct choice.

The architecture deliberately never carries the session token: the page holds
it and Node only ever sees a presigned URL. That was a choice at the outset
and it survived every one of the reroutes above.

**84 of 85 wishes arrived.** The one gap is real and is left visible in the
wishlist rather than filled: **there is no eating animation in the library**
— "eating", "sandwich", "food" and "meal" all return nothing — so D-533's
meals have no clip and `eat` currently plays nothing.

⚠ **Three clips are SUBSTITUTES and say so where they are declared.** There is
no woodcutting or mining motion (a downward two-handed melee swing stands in
for `harvest-swing`), no smithing or carpentry (a bartender working with both
hands at a counter stands in for `craft`), and no bandaging (kneeling and
examining something on the ground stands in for `treat-wound`). A substitute
that is written down is a decision; one that is not is a lie about what the
library contains.

⚠ **`two-handed__death` was REMOVED rather than substituted.** There is no
greatsword death clip, and the layering already answers it: `two-handed` falls
through to `unarmed__death`. Recorded so nobody adds the wish back and calls
it a gap.

### The wishlist is not a manifest, and a fallback to "first result" is a trap

Search terms are guesses, and the searcher took the first result when no
preferred title matched. That is how **the polearm stance shipped its idle as
a crouch**: "spear idle" returns a page of unrelated motions, the first was a
crouching one, and nothing in the filename, the build log or the browser said
so. `unarmed__craft` shipped as a **squat** the same way.

Both were caught by the SHAPE test — every clip's opening hip height, measured
against the character's own height — which already existed from D-558 and had
never fired before. It now names the actions that legitimately do not start on
their feet (`climb`, `downed`, `sleep`, `get-up`, `revive`, `stand-up`,
`sitting`, `kneel`, `treat-wound`, `harvest-gather`, `swim`) one at a time
instead of widening its band, because widening the band is what would have let
both of these through.

### Sets: the layering from D-561, made real and made small

`content/animations/*.json`, one file per set, drafted by
`npm run draft:animations` from what actually built — nine sets: one **rig**
set of 46 unarmed clips and eight **stance** sets of one to fourteen.

⚠ **The unarmed clips go in the RIG layer, not in a stance called "unarmed",
and that single choice is the whole design.** Drafted as a stance set it would
look identical in the tool and mean the opposite: nothing would inherit
anything and every stance would need all 62 actions filled in by hand. As it
is, `two-handed` names seven clips and is a complete character.

The tool tab therefore shows **inheritance, not just assignment**: a row left
empty prints the clip it will actually play and where it comes from. An author
who cannot see the difference between "empty" and "inherits the walk" will
fill every row in every set and undo the layering by hand.

CI schema-checks the sets, refuses a duplicate id, refuses a stance set that
applies to something that is not a stance, refuses a set that names no clips —
and then **resolves all of them together and fails if the result has no idle
or no walk** (D-561's `REQUIRED_ACTIONS`). A complete-looking pile of stance
sets with no rig set beneath them is legal data, parses cleanly, and renders a
statue that slides.

### 163 weapons, placed by measurement rather than by eye

The stakeholder placed **one** weapon by hand — an arming sword — and asked
for the rest. Positioning 163 by eye is not work anybody should do, and it
does not have to be: a grip transform is three things, and only one of them
varies per mesh.

- **The units**, which are MEASURED, not configured: the dungeon pack is
  metres and the other three are centimetres (D-561), taken from the median
  mesh length so one outsized halberd cannot decide it for seventy others.
- **The wrist-to-palm offset and the twist**, which belong to the HAND and are
  therefore constant across a family. The right hand's local +X points back
  toward the shoulder and the left hand's points away — measured, not assumed
  — so mirroring a grip is a sign flip on x and nothing else.
- **Which family it is**, decided by NAME rather than by shape: a round shield
  and a war hammer have similar proportions, and a rule guessing from the box
  would put one of them in the wrong hand, which looks like art rather than
  like a bug.

⚠ **The load-bearing measurement is that the mesh ORIGIN is the grip, in both
families.** Weapons measure with their origin low on the haft (0.0–0.4 of the
way up) and shields measure with theirs at the centre of the boss (0.44–0.71,
or dead centre where the board is wider than it is tall) — which is exactly
where each is held. So the offset does not scale with the weapon: a 2.1m spear
and a 48cm knife take the same one.

⚠ **A shield needs NO rotation, which is the opposite of what it looks like it
needs.** The left hand's bone frame IS the world's in the rest pose, and the
shields are modelled upright and facing forward, so identity already stands
them up and points them where the character looks. The first guess was a
quarter turn off the blade convention and laid the shield along the arm like a
plank.

**Re-running is safe because of one tag.** `fit:weapons` writes `auto-fit` on
everything it places and will overwrite only what carries it; the creation
tool **strips that tag the moment somebody edits an offset by hand**. Without
it the tool could either never correct its own mistake or would silently
overwrite the stakeholder's arming sword, and there is no third option.

### Two ways to see it, because neither alone is enough

**`tools/test/weapon-fit.test.ts`** places all 163 on an assembled body and
measures: the bone exists, the item ends up between 15cm and 3m long, its grip
lands within 30cm of the hand, its centre is not inside the ribs, a shield is
in the off hand, and every auto-fitted item still carries its family's
numbers. ⚠ The **size** assertion is the one that earns its place: a wrong
`scale` is the easiest mistake to make here and the only one nothing else
catches — a sword at scale 1 in a centimetre pack is 89 metres long and
renders as a grey plane that reads as a broken shader. All six failure modes
were checked by deliberately breaking an item and watching the test fail.

⚠ **The consistency check exists because the geometric ones are not sufficient,
and that is worth stating.** An un-rotated blade stands upright out of the
fist: it hits nothing, sits in the hand, and measures the right length. It is
wrong only compared to the other 162. Corrupting a rotation passed every
geometric assertion and was caught by nothing until the family check was
added.

**A contact sheet** in the tool renders twelve characters at once, each
holding a different item, so an outlier is obvious beside eleven that are
right. One at a time it would be 163 loads and 163 looks. ⚠ Rows stack
UPWARD rather than backward — a grid laid out in X and Z hides every row but
the front one from an orbiting camera, which showed four bodies out of twelve
and read as a bug in the cloning. The bodies are `SkeletonUtils.clone`s of the
one assembled mannequin: `partMesh` caches its meshes and `assemble` binds
them, so assembling twice from the cache would rebind the same geometry to a
second skeleton and take the first body with it.

### Defects found here that logged nothing

⚠ **A skinless FBX has no skinned mesh, and the whole build stopped.** Asking
the library for clips without skin — which is right — means `retargetClip` has
no `source.skeleton` to read. A synthetic skeleton is now built from the file's
bone hierarchy, PARENT BEFORE CHILD, because `SkeletonUtils` walks
`skeleton.bones` as a flat array and solves each bone against its parent's
world matrix (the defect that put a forearm 82 degrees out in D-558). The first
fix reparented the bone root under the new mesh and made a cycle: the first
`updateMatrixWorld` walked it until the stack ran out.

⚠ **`let` is hoisted but not initialised, and the creation tool stopped
painting.** `frame()` and `boot()` were called from the middle of the file and
read state declared below them, so module evaluation threw a ReferenceError
and aborted — the Animations tab highlighted and nothing rendered, with one
line in the console as the only sign. Both entry points now sit as the last
lines of the file, which makes it impossible rather than making it a rule.

⚠ **The camera's zoom ceiling was 1**, set when the only thing on the stage was
one character. A contact sheet six metres wide simply refused to zoom out and
read as a broken camera rather than as a clamp.

**What this does not do.** Nothing in the game reads a set yet:
`resolveAnimations` is called by the tool and by CI and by no renderer.
`ImportedVisual` still picks clips by name (D-559). Binding a character to a
rig set, a race set and the stance its equipped weapon declares is the next
piece, and it is the piece that makes the 163 stances mean something.

---

## D-565 — Weapon up or weapon away, and a number field you can scroll

**Status:** built; 43 clips still to fetch.

**Context.** Two asks from the stakeholder. Holstering needs animations, and
"each action that is possible in combat should have a combat variation — for
example, running (Combat), running (Peaceful)". Separately, positioning an
attached weapon by typing numbers is the wrong shape of interaction and should
be scrollable, with a choosable step.

### Readiness is a fourth LAYER, not a doubled vocabulary

The obvious reading of "every action gets a combat variation" is 62 more enum
entries. That is the wrong answer twice over: most of them would never differ
from their peaceful twin, and the ones that do would have to be kept in sync
by hand across eleven stances.

D-561 already had the machinery. Animation sets LAYER —
`rig ← race ← stance` — and anything a layer is silent about falls through. So
readiness is a fourth layer on the end:

```
rig  ←  race  ←  stance  ←  readiness
```

A readiness set applies to `<stance>/<readiness>`, e.g. `one-handed/combat`.
One override per clip that actually changes; everything else is inherited.

⚠ **The two readiness values are not symmetrical, and the asymmetry is the
design.** `peaceful` is the ABSENCE of an override — a man with a sheathed
sword walks like a man, so the renderer simply does not pass a combat set and
resolution falls through to the rig. `combat` is where the guard idle, the
sidestep, the shortened stride and every attack live. `peaceful` exists as a
NAME so a caller can ask for one without a special case, not as a set anybody
authors.

⚠ **It is called `Readiness`, not `Posture`, and that is not cosmetic.**
`Posture` already means sitting / standing / kneeling in this codebase
(D-506), and `shared` re-exports everything through one index — the two types
collided in eight files the moment the first name was tried. The compiler
caught it; the rename is what stops it recurring.

⚠ **`combat-idle` is REMOVED from the action vocabulary, superseding that part
of D-561.** With three layers it was the only way to say "standing still,
weapon up". With a readiness layer that is `idle` resolved through
`<stance>/combat`, and keeping both would be two spellings of one thing
waiting to disagree. Deleting it rather than leaving it unused is the rule
D-538 applied to feats: a vocabulary entry nothing implements is a promise the
renderer never keeps. Nothing outside this session's own generated files
referenced it — the procedural `character.ts` has a `combat-idle` key of its
own, in a different string space, and is untouched.

### Holstering belongs to the stance, not to either readiness

Draw and sheathe are the TRANSITION between the two states, so they cannot
belong to either one. They sit in the `stance` layer alongside the only other
genuinely readiness-free thing a weapon changes — how it is carried.

That leaves the stance layer looking almost empty (`stance-one-handed` is two
clips) and the readiness layer carrying the weight, which is correct and worth
saying out loud: a sword changes almost nothing about a man until he raises
it.

⚠ **`carrying` is the one stance with no combat half**, and it is the case
that proves the split is real: a man with a barrel in his arms has no guard.
Its idle and walk sit in the stance layer, where a peaceful override belongs.

### The clip names now say which they are

`<stance>__<action>` becomes `<stance>__combat__<action>` for a weapon-up
clip; the segment is absent otherwise. `one-handed__walk` was ambiguous —
every existing stance clip in the library is in fact a guard walk — and
`one-handed__combat__walk` is not, while leaving room for the peaceful one.
The 34 clips already on disk were renamed to match.

### Two ways this can be got wrong, both tested

Resolution order is asserted directly: a combat walk beats a stance walk beats
the rig walk, with the array deliberately in the wrong order so only the LAYER
can be deciding it. Getting that wrong gives a sheathed man a guard stride,
which renders perfectly and is wrong in every frame.

And the drafter is asserted to put draw and sheathe in the STANCE set and the
combat walk in the READINESS set — because putting holstering in the combat
set would mean a sheathed character had no way to draw, which is a deadlock
that no single screenshot would reveal.

⚠ `resolveAnimations` now iterates `ANIMATION_LAYERS` rather than a private
copy of the list. The copy was already there and already correct; a fifth
layer added to the enum and forgotten in the function would resolve as if it
did not exist, which looks exactly like a set nobody filled in.

### A number field you can scroll

Fitting a weapon is a dozen small corrections in a row, each judged by looking.
Typing breaks that loop every time. The offset, rotation and scale fields now
take the wheel; the arrow keys step by the same amount; shift multiplies the
step by ten and alt divides it by ten for one gesture without changing the
setting. The step itself is chosen from chips **per group**, because the three
are not in the same units and never want the same granularity — a centimetre
is a sensible offset step and a useless rotation step.

⚠ **The wheel handler must `stopPropagation` as well as `preventDefault`.** The
stage's own wheel handler zooms the camera, and a scroll that nudged the
weapon and flew the camera backwards at the same time would be unusable.

⚠ **A nudge must not rebuild the preview.** `showAsset` re-parses the FBX and
reassembles the body — fine once per click, hopeless on a wheel. `nudgeAttached`
writes the three fields straight onto the object already parented to the bone,
so an adjustment is a matrix update. It divides by the bone's MEASURED world
scale for the same reason `showAsset` does (D-563).

There is also a **"Back to the fitted default"** button, which clears the
transform rather than writing the rule's numbers here — a second copy of those
numbers in the UI is a copy waiting to drift from `fit:weapons`.

### The authoring server's port is overridable, for a reason worth recording

`npm run dev:studio` runs under `tsx` with no reload, so a change to a shared
SCHEMA means restarting it — and a schema the running process has never heard
of comes back as a 500 that reads exactly like a broken route. It cost real
time twice. `/creation-tool.html?api=8151` now points the tools at a second
server started on another port, which is the fastest way to pick up a schema
change without stopping the one already running.

### The clips, fetched

**126 of 127 wishes are on disk** — the one gap is still `eat`, which the
library does not contain in any form. Fifteen sets now: the rig, seven
`— carried` stance sets (a draw and a sheathe apiece) and seven `— weapon up`
readiness sets, the largest being sword-and-shield at 18 clips and polearm at
17. Sword-and-shield, greatsword, polearm and bow all have a full combat
locomotion ring; the polearm's comes from the melee pack, which is the most
complete combat set in the library.

⚠ **Two download findings worth keeping.** The presigned URLs expire in five
minutes and carrying them out by hand is slower than that — five of fourteen
expired mid-transit. The click-to-download route works again in a fresh
browser profile, so Chrome's automatic-download block is per-session state
rather than permanent; it is still the route that dies silently after a few
dozen files, which is why `claim-downloads.ts` refuses to match by order when
the counts disagree.

⚠ **And the download report disagreed with the filesystem.** Nine files were
reported saved and the nine names I carried forward were not the nine on disk:
two clips I believed had failed were there, and two I believed had landed were
not. Rebuilding the queue from `missing-animations.ts` — which reads the disk —
rather than from the previous step's report is what caught it. A report is a
claim; the directory is the fact.

⚠ **`find` no longer falls back to the first result.** It returns NULL when
nothing preferred matches, and the caller reports the miss. That fallback is
what shipped a crouch as the polearm idle in D-564, and with 42 new wishes
going through in one pass it would have been worth several more. Resolving
every wish to a product BEFORE exporting any of them turned one bad query
(`great sword equip`, which matches nothing — the title is `Draw A Great
Sword 1`) into one line instead of ten minutes of exports.

⚠ **`bow__draw` is `Standing Equip Bow`, not `Standing Draw Arrow`.** The
second is nocking an arrow, which is already `reload` and the combat idle.
Taking the bow off your back is a different motion and the names do not say so.

Verified by playing them on the mannequin: the sword draw reaches across to
the left hip, the greatsword sheathe puts the blade away over the shoulder,
and the polearm block is a proper two-handed guard with the weight back.

Nothing in the game reads a set yet, unchanged from D-564.

---

## D-566 — The authoring tools grow up: materials, classes, items, and a map that can hold a pack

**Status:** built; placing a pack mesh from the editor UI is the one piece left.

**Context.** The stakeholder asked for the workflow to be legible from the menu
and for the four tools behind it to exist, so that how the assets link together
can be seen rather than argued about. The menu is now **Core definitions**
(body parts, races, weapon assets, environment assets, pickups, animations),
**Map builder**, **Item definitions**, **Class definitions**.

⚠ **The rule the placeholders followed, and why it stayed:** an unbuilt section
says so in plain words, names what it will read and write, and what must exist
first — rather than opening an empty editor. A tab that looks like a tool and
does nothing is the lie D-538 refused for feats and D-553 refused for hotbar
spells. All four are now real, and `renderSoon` remains for the next one.

### Armour material is measurable; the filenames are not

The stakeholder asked to tag weapons and armour plate / cloth / leather "based
on the filename". ⚠ **The filenames carry nothing.** Every part is
`SK_Chr_Torso_Male_12` — slot, sex, number. Unlike `name:assets` (D-563), which
had accurate weapon filenames to rearrange, there is no text here at all, and
drafting from it would have invented data.

⚠ **The stakeholder's own names did carry it.** Fifty-six parts they had typed
contain a material word — "Heavy plate male", "Fine leather female", "Robe
male" — which is ground truth nothing in this repo generated, and it became the
test set.

For the other 499, the pixels answer it. A part's UVs sample a handful of flat
colours (three to seven — the same finding as skin in D-560 and weapons in
D-564), and plate is desaturated grey, leather brown, cloth saturated. So
`npm run name:parts` measures and classifies, agreeing with **50 of 56** of the
stakeholder's labels.

⚠ **A "fix" that RAISED accuracy made the result worse, and that is the lesson
worth keeping.** Counting dark near-greys as steel scored 93% — higher than what
shipped — while calling 381 parts plate and 38 cloth. The human-named set is
mostly plate torsos, so a plate-biased classifier wins on it. The real finding
was that `#2d3237` and `#3b4348` are 133,000 pixels of that atlas and they are
SHADOW: a robe measures 24% `#2d3237` and so does a harness. Excluding colours
below a brightness floor fixed it. **Accuracy on an unbalanced set is not
sufficient evidence**, so there is now a test asserting no material runs away
with the pack — the check accuracy could not make.

⚠ **A face is not made of cloth.** Classifying every slot tagged 128 faces and
hairstyles, which reads as a decision and is noise. Only armour-capable slots
are classified.

⚠ **Plate/cloth/leather does not apply to weapons.** A sword is not cloth. What
a class actually needs for weapons is `stance`, which all 163 already declare.

### A PNG decoder, because measuring should not need another language

Every measurement that has decided something about this art needed pixels, and
until now that meant the browser or a Python script beside the TypeScript.
`tools/src/png.ts` is ~120 lines of zlib and unfiltering, no dependency, and
deliberately NOT a general library: 8-bit RGB/RGBA non-interlaced, and it
THROWS on anything else rather than returning plausible wrong pixels. Verified
200/200 against Pillow before anything trusted it.

### Classes: the first tool that consumes the tagging

`content/classes/*.json` gains `armour`, `weapons`, `races`, `items` and
`startingAttributes`, and the editor covers identity, progression and
permissions with **+ New calling**.

⚠ **Empty means UNRESTRICTED, one rule for all four lists.** That is what made
these safe to add: the nine classes authored before they existed carry none of
them, parse to `[]`, and behave exactly as before. Authoring is narrowing from
everything, so a half-finished class is permissive rather than unplayable.

⚠ **Gating is ACCESS, never power** (D-207 → D-522). Telling a magus they may
not wear plate removes an option; it does not make the man-at-arms hit harder.
A gate that granted something for obeying it would be the mechanical reward for
virtue D-303 forbids.

⚠ **Feats and spells are edited from the OTHER side.** A feat declares
`classes: []` meaning open to everyone (17 of 28 already restrict), so the
class page writes into `feats.json`. And unticking a feat that is open to
everyone **cannot** just remove one class from an empty list — it names every
other calling explicitly, or the feat stays open to all and the click did
nothing. Getting that backwards silently opens a restricted feat to the roster.

⚠ **`startingAttributes` CROSSES D-546, which is ratified**, so nothing reads
it. That decision gives every calling the same start — 10 apiece with 10 to
place — because a class is access and options and not a stat block, and because
a class starting three points of vigor ahead makes the round's social problem
arithmetic instead of deception. Two readings are open and very different: a
SUGGESTION the creation screen pre-fills (compatible, the role `affinities`
plays for skills) or a RULE that supersedes D-546. **Flagged for the
stakeholder, in the panel and in the schema; not decided here.**

### Items point at assets; that is the whole split

`ItemTemplate` gains `art: { pack, asset, swaps }`. The ASSET owns how a thing
is held, which bone and which animation stance — decided once, for 163 weapons.
The ITEM owns which asset, what colour, what it weighs and what it is worth. A
rusted shortsword and a fine one are one mesh, two colourways and two stat
blocks, and the art work is not repeated per item. The panel says so on the
row: *"Held at Hand_R · stance one-handed — from the asset, not the item."*

Colours are exact substitutions against the pack atlas, the mechanism
`skinPalette` already uses (D-560) and safe for the same measured reason: every
UV island sits inside one flat region, so NEAREST filtering keeps a
substitution clean. The server measures which colours a mesh actually samples
and offers exactly those as swatches, so recolouring is never a texture editor.

⚠ **Four silent bugs stood between that design and it working, all the same
family — two things that had to agree and did not.**

1. **`POLYGON_Knights_Texture_01.png` sits in `Source_Files/`, not
   `Source_Files/Textures/`**, and `texturesIn()` read only the folder called
   "Textures". The one atlas covering that pack's weapons was invisible to the
   studio, the creation tool and every measurement. Textures are now FOUND
   under the pack, the way `findDir` already finds meshes.
2. **The client and the server chose different atlases for the same pack.** The
   tool measured a sword's colours off one image and painted it from another,
   so every swatch named a colour the mesh did not contain and recolouring did
   nothing, with no error anywhere. One shared `assetAtlas()` now — the D-558
   "one assembler" lesson in a different place.
3. **The texture endpoint only served CHARACTER packs**, so the weapon atlas
   404'd and a `catch` swallowed it; the preview silently kept whatever was
   loaded last and painted a sword from the character sheet, skin tones and
   all. There is an assetpacks texture route now, and the catch logs.
4. **The item preview loaded the asset FILE without the pack CATALOGUE**, so
   the texture list still belonged to whichever pack was opened last.

None of the four threw. Each produced a confident wrong answer.

### The environment library is classified, and the simulation reads it

`npm run name:environment` measures all **1,402** environment meshes and writes
`solid`, `opaque`, `footprint` and a drafted name.

⚠ **Environment filenames ARE descriptive**, unlike character parts — a wall is
`SM_Bld_Wall_01`. D-563 declined to draft names for them ("1,459 `Wall_01`-shaped
names is noise") and that judgement was right about NAMES and wrong about
everything else: what stops a body, what stops an eye, and how many tiles it
covers are all derivable, and they are the fields a map actually needs.

⚠ **`solid` and `opaque` stay SEPARATE.** A fence stops a body and not an eye,
and conflating them is how a witness sees through a wall or fails to see over a
rail (D-217, D-545). The decision leans on measured HEIGHT as well as the name:
nothing knee-high blocks sight, whatever it is called. A "wall" 40cm tall is a
garden border.

**Placed pack meshes** are a new thing on the grid, beside the 44 code-built
prop types. ⚠ `footprint`, `solid` and `opaque` are **baked in at placement**
rather than looked up: looking them up would thread the asset catalogue through
`isTileWalkable`, the client pathfinder and CI's reachability flood — every
caller changed, for a value that must never differ between them. Baking keeps
an area self-describing, exactly as it is for props. ⚠ The cost is drift, so
`placedAssetDrift` reports it and **CI fails on it**: a wall that quietly became
walkable months after somebody edited a tag is precisely the failure nobody
would look for.

⚠ **A quarter turn SWAPS the footprint.** A 4×1 wall laid east-west covers four
tiles across; turned, four down. Forgetting that leaves three tiles of a wall
walkable and the reachability flood passes happily.

⚠ **Line of sight now reads placed assets.** Before this a building put down by
the editor was invisible to sight — a killing behind a house was witnessed
through it, and a witness is what makes a crime register at all (D-217).

### The map builder embeds the editor rather than replacing it

The editor already exists, has its own server, and refuses any save that would
fail the build (D-543/544). Two editors writing the same area files would
eventually disagree about what a legal map is, so the section embeds it.

**What is left:** the editor UI cannot yet PLACE a pack mesh — the schema, the
walkability, the line of sight, the reachability flood and the drift check are
all in and tested, but the palette in the editor still offers only the 44
code-built props. That is the next piece and it is now mechanical.

---

## D-567 — The world is measured in metres: tiles superseded by a continuous coordinate system

**Status:** decided by the stakeholder, 2026-09-10. **Supersedes the tile-movement
half of D-104.** In progress — this entry is written before the code moves,
because a decision this size must not be discovered later by reading a diff.

**What D-104 said, and what survives.** D-104 bundled three rulings: a **10Hz
server tick**, **tile-to-tile movement with client interpolation**, and
**cooldown/round-based combat**. The tick and the non-twitch combat model are
UNCHANGED and remain in force — latency must never decide a fight (D-104's real
argument), and D-550's four-second combat round is untouched. Only the middle
ruling is replaced: **position is no longer an integer tile, it is a coordinate
in metres.**

⚠ D-104 rated its own reversibility LOW and said changing it later is a rewrite.
That assessment was correct and is being accepted, not disputed.

### Why it changed

The map editor is what forced it, and the evidence is measured rather than felt.
`solid` was one boolean over a bounding rectangle, so:

```
sm-env-door-frame-02        footprint 3×1   solid ✓   ← blocks its own opening
sm-env-ceiling-arch-01      footprint 5×5   solid ✓   ← blocks 25 tiles you walk under
sm-bld-castle-wall-gate-01  footprint 5×2   solid ✓   ← a gate nobody can pass
sm-env-glacier-arch-01      footprint 24×9  solid ✓
```

**1,157 of 1,402 environment assets are marked solid; 395 of those block nine or
more tiles as a solid rectangle.** No interior can be authored that anybody can
enter, and CI's reachability flood correctly refuses one. Patching the
rectangles would not fix it: a door is passable in a strip narrower than a tile,
an arch is passable because of its HEIGHT, and neither fact is expressible on a
one-metre grid with a boolean.

The stakeholder's ruling: *"For the world, ditch the tile system completely in
favour of a coordinate system. Anything measured or located by tiles previously,
should now rely on coordinates and distance."*

### The model: one rule, four behaviours

A collision layer is a list of **volumes**. A volume is a footprint (rect,
circle or polygon, freely rotated) plus a vertical extent `base → top`, a
`walkable` top surface, an `opaque` flag, and an optional linear `ramp` across
that surface.

⚠ **"Blocks passage" is NOT a flag.** It is what happens when a volume's top is
higher than a character can step onto and its body overlaps theirs. That single
rule produces all four things the stakeholder asked for:

| Authored as | Behaviour | Why |
|---|---|---|
| kerb, rug, root — top 0.15m | **walk over** | within `STEP_UP`, so you simply stand on it |
| stair, ramp — `ramp` 0 → 2.4m | **walk up** | every step along it is within `STEP_UP` |
| wall — top 3m | **blocked** | too high to step onto, body overlaps |
| arch, bridge — base 2.4m, top 4m | **walk under** | body `[0, 1.8]` never overlaps `[2.4, 4]` |

⚠ **`opaque` stays SEPARATE from geometry, exactly as it did on tiles** (D-545,
D-217). A rail stops nothing and hides nothing; a glass wall would stop a body
and not an eye. Line of sight is what makes a witness, and deriving it from
height would silently decide who saw a murder.

### The map edge is now authored, not implied

An area's extent was `width × height` and anything outside it was refused by
arithmetic. It is now a **`bounds` polygon** on the collision layer — which is
what makes a non-rectangular area possible at all (a cave mouth, a river bank,
a road leaving town at an angle).

### Masks are per-asset, overridable per placement

Ratified by the stakeholder alongside the coordinate ruling. An environment
asset carries its collision volumes in its OWN local frame, authored once; every
placement inherits them transformed by its position, rotation and scale. A
single placed object may override its own — so one wall in one map can have a
gap knocked in it without forking the asset that 684 others share.

⚠ This is the same baking trade-off D-566 recorded and it keeps the same guard:
an inherited mask is copied at placement so an area stays self-describing, and
drift between the copy and the asset is reported by CI.

### The nav grid is an INDEX, not a return of tiles

Continuous pathfinding needs an acceleration structure, and this one is a grid
baked from the volumes at ~0.25m. ⚠ **Saying so plainly because it would
otherwise look like the tile system creeping back in.** The distinction is
real and load-bearing: nothing in content, the wire protocol, the rules or the
editor sees it; no distance is measured in it; it is rebuilt from the collision
layer at load and never authored. If a future change wants a true navmesh,
nothing outside the pathfinder is affected.

### What this costs, measured before starting

Every one of these reads integer tiles today and has to be converted:

- **The wire protocol** — entity `x`/`y` are `z.number().int()`
- **Movement** — step validation and the corner-cutting rule in `world.ts`
- **19 `chebyshev()` calls in `gateway.ts`** — weapon reach, speech channels,
  station use, looting, revive, `COMBAT_NOISE_TILES`
- **Line of sight** — `los.ts` walks tiles
- **Pathfinding** — the client's `path.ts` and `sim/walk.ts`
- **CI** — the reachability flood in `validate-content.ts` and `editor-check.ts`
- **Eleven authored areas**, plus the generators that write four of them
- **The determinism harness and every bot test**

⚠ **Chebyshev distance is not Euclidean distance, and swapping them silently
re-tunes the game.** On a grid, a diagonal neighbour was distance 1; in metres
it is 1.41. Every range constant is therefore RE-MEASURED against play, not
converted by arithmetic — the same discipline D-549 applied when Ashfold
halved in size and the travel band was re-measured rather than re-derived.

⚠ **Determinism is the risk that matters** (D-114). Tile positions could not
drift; float positions can. The mitigation is that the server remains the only
computer of position (invariant 1), that its arithmetic is fixed-order, and
that the determinism harness compares whole runs — but this is the thing most
likely to fail quietly and it is called out here so it is watched.

### What has landed, and what it cost

**Built:** the collision model (`shared/src/collision.ts`), the navigation index
(`shared/src/navigation.ts`), per-asset collision masks with free placement, the
editor's select/manipulate/mask tools, continuous server movement, and
server-owned pathing on the wire (`move_to` / `move_stop`).

⚠ **`walkable` defaults to FALSE, and finding out why cost three failures at
once.** It defaulted to true — "of course you can stand on the top of a thing" —
and that made every 3m wall a standable platform at 3m and every archway a floor
at 4m. The navigation index filled with floating open ground nothing could reach
and routes detoured around thin air. A volume is an obstacle unless somebody
says otherwise; standing on something is an authoring act and it is one tick box.

⚠ **A body has WIDTH, and the first collision rule forgot it.** "Anything within
arm's reach whose surface is above my feet blocks me" is unwalkable in a way
that looks like geometry working: approaching a platform up a ramp, the
platform's side is within a body radius while the feet are still centimetres
below its top, so the rule blocked the last 30cm of every ramp, every kerb and
every doorstep in the world. The clearance is now a STEP, not any amount at all.

⚠ **The overlay's legend was lying, and only a sweep found it.** Every colour is
now asserted against what `stepTo` and `sightBlocked` actually do across
thirty-six volumes. Three of five were wrong: a 10cm lip you cannot stand on
does not stop you (`walkable` decides where your feet END UP, not whether you
may pass); a 4m arch is not somewhere you stand just because it has a top; and
"you walk under it" needed a colour of its own. A cage drawn red that the
simulation walks through means a whole map authored confidently against the
wrong picture.

### Four things that survived the tile era as float bugs

None of these threw. Each is the same shape: integer arithmetic fed continuous
coordinates.

1. **Line of sight HUNG.** `hasLineOfSight` ran Bresenham with
   `while (x !== to.x || y !== to.y)`, stepping by whole numbers — from 45.05
   towards 39 it stepped 44.05, 43.05, 42.05, and never once hit the target. A
   pinned server thread, and every test that reached it reported a timeout
   somewhere else entirely. It is now a segment against opaque volumes at eye
   height, which is also the version that lets a witness see over a chest-high
   wall (D-217).
2. **Every door in the world stopped working.** A transition fired on
   `t.x === event.x`, an equality that was true on a grid and is essentially
   never true again. Matched by nearness now, with the radius set larger than
   one tick of walking — or a fast walker steps clean over the doorway between
   two ticks.
3. **The endgame confirmation could not be given.** It keyed the pending
   confirm on the position at the moment of crossing, so "step off the marker
   and step on again" compared two different floats and warned forever. Keyed
   on the transition's authored point now.
4. **The bots reported eighty-eight protocol violations, all false.** Their
   invariant check indexed `tiles[59.6]`, got `undefined`, and read it as "the
   server put me inside a wall".

⚠ **Three A* implementations were deleted, and that is the real change.** The
client's, the bot agent's, and a copy inside a test each ran over the tile grid
and each silently concluded the whole map was impassable. But the deeper point
is D-102: the route was never the client's to choose. It only ever was because
the server could not path. The client now says WHERE and the server decides
HOW — `move_to` and `move_stop` — which is also what makes walking around a
continuous obstacle possible at all, since a client route and a server
collision test disagree constantly once obstacles stop being tile-shaped.

⚠ **A caller has to say when it has ARRIVED.** A walk finishes when it is close
enough, which is before the route's last waypoint; the server does not know
that and keeps walking. So a test started harvesting, the character strolled
on, and the work cancelled because the worker moved (D-529) — reported as
"timed out waiting for the work to complete", which points at gathering and not
at the walker.

⚠ **`WALK_SPEED` is inherited, not chosen.** It is exactly the old cadence — one
metre every three ticks — so that converting movement to metres did not silently
re-tune the pace of the whole game in the same change. Likewise a direction
still carries the direction vector's OWN length, so a diagonal covers 1.41m and
a caller counting in whole steps still lands where it did. It does now take
longer than a cardinal step, which is correct and which the grid gave away free.

⚠ **Still on chebyshev: nineteen range checks in `gateway.ts`** — weapon reach,
speech channels, station use, looting, revive, `COMBAT_NOISE_TILES`. They work,
because chebyshev on metres is a defensible approximation at these distances,
and they are wrong: a diagonal neighbour was 1 and is 1.41. Converting them is
a re-measure against play, not an edit.

⚠ **Areas are still authored as tiles.** `areaCollision` derives a layer from
the grid for any area without one, so the continuous rules run everywhere today
and re-cutting an area by hand is an improvement rather than a prerequisite.
Until that happens, every wall in the world is still a metre thick and on a
lattice.

### Every distance is now measured in metres

The nineteen `chebyshev` calls are gone. The conversion followed one rule,
applied twice, and neither half is a re-measure against play:

- **Short ranges, where the semantic is "adjacent"** — raised to **1.5m**
  (attack, interact, whisper) and **2.5m** (station reach). Chebyshev called a
  diagonal neighbour 1 away when it is 1.41, so changing the metric without
  moving the number would have dropped every diagonal neighbour out of reach.
  Handing something to the person beside you would have worked north and failed
  north-east, with nothing in the UI to explain it.
- **Long ranges, where the semantic is "about this far"** — left alone (say 10,
  shout 40, combat proximity 20, noise 30/12, aggro 9), so the straight-line
  reach that was actually tuned is preserved and the square's corners go. ⚠ This
  SHRINKS the ground each covers by about a third. Speech range decides who
  witnesses a declaration (D-218), so that is a rules change and not a cosmetic
  one.

Every `*_TILES` constant is renamed `*_METRES`, including `aggroTiles` →
`aggroMetres` in the six authored roamers. The rename is the point: a unit that
is not in the name is a unit nobody checks.

⚠ **One word cost an hour: `reach: z.number().int()`.** Raising bare-handed
reach to 1.5m made the ENTIRE status message fail schema validation, so it was
dropped on the floor — no error, no status, six tests reporting a timeout
waiting for a message that was being sent correctly every time. **Any `.int()`
left on a distance is a trapdoor of exactly this shape**, which is why
`CharacterSummary.x/y` went the same way and why migration 0013 widens the
stored positions to `double precision`: left as `integer`, Postgres rounds on
write, and a character logs out at 12.4 and wakes at 12.

### CI asks whether a BODY can get there

`unreachableTiles` floods the navigation index from the spawn instead of
flooding tiles, so the question is the one the server asks at runtime.

⚠ **The obvious claim about this is wrong, and the test says so.** The tile
flood already tested `canStandAt` at each tile CENTRE, so a doorway narrow
enough to block a centre was caught either way. What the navigation flood adds
is routes that do not run through tile centres at all: a passage at an angle, a
gap offset half a metre from the lattice, anything rotated. Those the tile flood
declared unreachable — a FALSE failure. There is now a test where both tile
centres in a doorway are provably unstandable (asserted, not asserted in a
comment) and a body walks straight through.

So it is stronger in both directions: it refuses what a body cannot fit
through, and it stops refusing what a body plainly can.

### The areas themselves are still tiles, and you can now see it

⚠ Ten of the eleven authored areas carry no `collision` block, so what the
server collides against is derived from their tile grids — every wall a metre
thick and on the old lattice. That is the last real remnant, and it is not
something to convert automatically: a machine-derived layer baked into content
would freeze the approximation and then drift from the tiles the editor still
edits.

What is built instead is the means to judge it: the map editor draws the whole
area's collision layer on demand. Re-cutting a map is now a thing a person can
see, do and check, which is where D-567 always had to end.

---

## D-568 — The bow pack, and two dead branches it exposed

**Status:** implemented.
**Supersedes:** nothing. Extends D-561 (naming packs), D-563 (attaching a
weapon), D-564 (grips by measurement).

The stakeholder supplied `POLYGON_BowAndCrossbow_SourceFiles_v3.zip` — six
meshes: three rigged bows and three projectiles. It is ingested as
`assets/source/bow-crossbow`.

⚠ **The first zip delivered under that name was the Generic pack renamed.**
Byte-identical to `POLYGON_Generic_SourceFiles_v3.zip` — same size, same
SHA-256, `MaterialList_PolygonGeneric.txt` inside, and zero meshes matching
bow, crossbow, quiver or bolt. It was not extracted. The lesson is cheap and
worth keeping: **inspect an archive before extracting it**, because the second
copy of an already-ingested pack under a misleading name is a mess that only
shows up much later, as duplicate assets nobody can account for.

### What is in it, measured

| mesh | long axis | length | origin along it |
|---|---|---|---|
| `Rigged_Bow_Testing` | Y | 145.6 | 0.50 |
| `Rigged_Bow_NativeAmerican_Testing` | Y | 142.3 | 0.50 |
| `Rigged_CrossBow_Testing` | Z | 112.1 | **0.92** |
| `SM_Arrow_01` | Z | 93.0 | 0.50 |
| `SM_Prop_Arrow_NativeAmerican_01` | Z | 100.5 | 0.43 |
| `SM_Wep_Crossbow_Bolt_01` | Z | 46.3 | 0.50 |

The pack is **centimetres** (scale 0.01), like the characters and the knights,
not metres like the dungeon pack — D-561's 100× disagreement holding for a
sixth pack.

The bows are **skinned**, with an eight-bone draw rig (`Root`, `bowString`,
three upper and three lower limb bones) and one 1.67s clip each. Nothing reads
that yet; it is a bow that *could* visibly draw, which is worth knowing before
somebody writes an aim animation that fights it.

### Two dead branches, both found by running the code rather than reading it

⚠ **`carry()` could never return the `bow` stance.** The test was
`/bow\b|longbow|shortbow/`, and `_` is a **word character** — so `\b` does not
match in `rigged_bow_testing`, which wants a non-word character after "bow" and
finds an underscore. The branch matched no filename in any pack and had never
fired. Nothing failed: a bow was simply drafted as a one-handed weapon in the
right fist, which reads as a clumsy name rather than as a dead branch. The
boundary is now `_`.

⚠ **`kindOfMesh` filed four of the six nowhere and two wrongly.** The vendor
breaks their own prefix convention here: the bows carry no `Wep_`, and the
three projectiles are filed under three different conventions (`SM_Arrow_01`,
`SM_Prop_Arrow_...`, `SM_Wep_Crossbow_Bolt_...`). `Rigged_` is now read as a
weapon — a rigged weapon is still a weapon, and without it these are the only
weapons in the repository no tool would list.

⚠ **An ammunition rule was tried here and REVERTED, and that is the entry.**
Matching the words Arrow/Bolt/Quiver filed the three projectiles correctly and
broke three other meshes doing it: `SM_Env_Basement_Support_Beam_Bolt_01` and
`SM_Prop_Bolt_01` (a bolt is a fastener as often as it is ammunition) and
`SM_Bld_Castle_Arrow_Slit_01` (an "arrow" modifying a "slit"). Three meshes
broken to fix three. **English is not a classifier.** The three oddities are
filed by hand instead.

### Which required making a hand correction survive the generator

⚠ `nameAssets` skipped a mesh already present **in the file being written**, so
moving a mis-filed mesh to the right kind was undone on the next run — a second
copy under a second id, silently. It now skips a mesh catalogued **anywhere in
the pack**, across kinds. A generator is only safe to re-run if a person's
correction survives it, and this is the same non-idempotency the wall converter
shipped once. Proven by re-running and hashing: byte-identical.

### The grip

Two new families. ⚠ **A bow needs no rotation**, for the shield's reason
(D-564): it goes in the left hand, whose bone frame is the world's at rest, and
the bows are modelled standing on Y with the string toward the archer — so
identity already *is* the pose. And the origin is the exact mesh centre, which
on a bow is the riser, so D-564's "the origin is the grip" holds for a third
family.

⚠ **The crossbow is the one weapon in any pack whose origin is not its grip** —
92% of it sits behind the origin. `HELD_AT` shifts it along its own long axis
(0.35 from the butt, **unratified**), which puts the origin 62cm ahead of the
fist *by construction*. That tripped the grip-distance test, whose allowance
(`0.3 + 0.25 × length`) was tuned on weapons where the origin *is* the grip;
the crossbow now carries the real rule underneath instead — you cannot hold a
thing further from you than the thing is long.

### The stance goes live

`hunting-bow` had deliberately carried **no art** since D-566, because giving
it a sword's asset to satisfy the hunter's gate "would be a lie the animation
system would then act on". It now points at `bow-crossbow/wep-longbow-01`, which
activates the gate (hunter and shade both admit `bow`) and connects the **ten
authored clips** in `stance-bow.json` and `combat-bow.json` to something to hold.

⚠ **There is no `crossbow` animation set.** The stance is a legal value with no
clips behind it, so a crossbow falls through to the rig set and is carried like
nothing at all. The meshes are in; the movement is not.

---

## D-569 — The last content gets an editor, and the rules move to one place

**Status:** implemented.
**Extends:** D-543 (the editor refuses a save that would fail the build),
D-558/D-560 (the authoring server), D-566 (the tools grow up).

Recipes, roamers, objectives, sound cues, the emote lexicon and the languages
were the last content with a schema, a CI validator and **no way to author
them**. Two new sections on the creation tool — **Round content** and
**Speech & sound** — close that.

### The rules are now written once

The per-entity checks lived inside `validate-content.ts`'s single long pass,
where the authoring server could not reach them. They are now pure functions in
`shared/` — `recipeProblems`, `roamerProblems`, `objectiveProblems`,
`castCoverageProblem` — and `validate-content.ts` **calls them**. D-543's
promise that the editor refuses anything the build would refuse is only true
while both read the same code; two copies drift, and the direction that hurts
is the tool being the more permissive of the pair.

⚠ **A `null` reference set means "I cannot check this" and must stay a skipped
check, never a fabricated pass.** The server sometimes knows the item list and
CI always does. A validator that read "I don't know the items" as "the item
exists" would be worse than one that said nothing.

### What a per-document form cannot check, and therefore what this is for

⚠ **The orphan graph is the reason recipes needed an editor rather than better
discipline.** Invariant 2 (D-210) says every item has a consumer, and the
commonest way to break it is to repoint or delete the only recipe that ate a
material. *The document you edited stays perfectly valid.* The build fails
somewhere else, about a different item, an hour later. So every recipe and
roamer save runs `findOrphans` over the graph **as it would stand afterwards**,
and a delete is refused by name — deleting `coarse-bread` reports
`item 'field-grain' is a base material that no recipe consumes`.

⚠ **`validateContent` is NOT what runs on save.** It takes 3.6–6 seconds,
because it floods every area for reachability. That is not a save button. What
runs is the part a round-content edit can actually break.

⚠ **Objectives have the same shape of trap one level up.** Shelving the last
live objective playable at the minimum cast is a legal edit to a legal
document; the failure is that the lobby fills and the round never starts, with
no error message anywhere. `castCoverageProblem` refuses it, and CI now uses
the same function.

⚠ **CI's orphan exemption list is exported and shared**, and
`tarnished-signet` was removed from it — it is exempt *because an objective
steals it*, so the exemption is now derived from the objectives themselves.
Retargeting that objective used to leave a stale literal behind, quietly
excusing the signet from the check for no reason.

### Rules the forms enforce because they are rules, not tuning

**A guard that pays is a farming strategy, not a watch (D-552).** The form
removes the xp and loot fields entirely when habitat is `guard` — gone rather
than greyed — and the save refuses a guard worth anything. Paying for a guard
kill would make murdering the watch the safest income in the game.

**A cue pointing at a file that is not on disk is refused, not warned about
(D-541)** — it is silent in play and indistinguishable from a cue nobody wired.
Files are picked from what is actually on disk rather than typed, and a whole-file
save also refuses to remove a cue an area still names as its ambience (the area
is not open in this editor and nothing else would catch it until the build).

**`common` cannot be removed** — without it every line of speech in the world
scrambles for every listener.

**The lexicon's keys are closed on both sides.** A posture the client cannot
hold and a gesture it cannot play are dropdowns. The synonyms are the open
half, and are the half worth authoring — "genuflects" reaching `kneeling` is
the point of the system. ⚠ They are edited as one comma-separated box rather
than a row of chips with plus buttons: these are lists of thirty words typed in
one sitting, and a control costing a click per word is a control nobody fills
in, which shows up as a lexicon that matches "kneels" and not "genuflects".

### The one check the tool refuses to pretend it can make

⚠ **`kill_npc` matches the descriptor of whatever died with an exact
`Set.has`** — and NPCs are not declared on an area, they are spawned by
`spawn_npc{...}` inside sandboxed Lua (D-507). So the only complete list of
descriptors requires running the scripts. The tool reads the Lua for
`descriptor = "..."`, offers what it finds as **suggestions**, warns when the
typed target matches none of them, and **passes `null` to the validator so
nothing is refused**. Treating a partial scan as complete would reject every
objective aimed at an NPC spawned by a DM event.

⚠ **That warning found a real bug on the first objective opened.**
`silence-the-keeper` is `status: "live"` and targets the descriptor
`"the keeper"`. The only NPC any script spawns is
`"a heavyset keeper with scarred knuckles"`, in `hanged-ferryman` — and
`round-town` runs no scripts and does not link to the ferryman, so **there is
no keeper in the round map at all.** D-526 calls this objective the low-cast
workhorse; as authored, an antagonist dealt it cannot win. It is two problems,
not a typo, and the second is a design gap. **Left unfixed and flagged for the
stakeholder** — repointing the descriptor would make it *look* fixed while
still being unwinnable, which is worse than a known gap. The tests never caught
it because their fixtures spawn an NPC with the fixture's own descriptor: they
prove the mechanism, not the content.

---

## D-570 — The wardrobe: a garment is a list of swaps, and it is authored by looking

**Status:** implemented.
**Implements:** D-562's finding, which had been recorded and unbuilt since.
**Extends:** D-560 (equipment swaps meshes, never layers), D-566 (the armour
gate), D-569 (one implementation of every content rule).

This was the last content type with no editor. `content/garments/` and a
**Garments** section on the creation tool close it.

### What a garment is, and why it could not be an outfit

⚠ **A "set" is a WARDROBE, not a costume** — the stakeholder's correction in
D-562. Gloves from one set mix with a torso from another, and some armours
leave the arms bare. So the equippable thing is a **list of slot swaps**
covering one slot or five, not "plate armour #12".

⚠ It has to be **swaps rather than layers** because of what D-560 measured:
there is essentially no bare body in this pack. Of 720 parts, arms and hands
have ONE bare option each and torso and hips have **none** — a body and its
clothes are the same mesh. Layering a breastplate over a torso would put it
over a shirt nobody can take off.

⚠ And it has to be authored **by looking**, which is a measured conclusion and
not a preference. D-562 tried twice to derive outfits from the numbering: UV
overlap across slots is void as a metric, and garment-colour overlap gives
**0.34 within a number against 0.33 across** — no signal, because the pack
dresses everything from one palette. A machine cannot tell which torso goes
with which gloves. So every change previews on a body immediately, framed on
the whole figure rather than by `frameFor`'s per-slot distance: a suit
inspected through a shot of somebody's chin is not inspected.

### The check that earns the file

⚠ **Both bodies, or half the cast cannot wear it.** A garment that dresses a
male torso and not a female one is refused by name. Nothing downstream would
have said so — the other half would simply render in whatever was underneath,
which reads as an art glitch rather than as missing content.

The other half of that is one button: `mirrorGarmentParts` fills the opposite
body **by number**, which is safe because the pairing was measured —
`Torso_Female_12` shares **0.96** of its atlas islands with `Torso_Male_12`
and 0.36 with any other female torso, and every twice-cut slot runs 0.89 to
0.97 against controls of 0.13 to 0.36. Unisex parts (a cape, a pauldron) are
carried across unchanged rather than given an invented `_Female_` spelling
that would name a file which does not exist.

Also refused: a part filed under the wrong slot (the mistake a dropdown makes
easiest, and invisible in the JSON afterwards because both halves read as
plausible strings), a part cut for the other body (a female forearm on a male
upper arm meets it at the wrong diameter — the seam is visible from three
metres), and a garment that dresses nothing.

### Material is DERIVED, which is why this was worth building

⚠ D-566 put `material` on the ITEM under protest and said so in the code:
*"declared on the ITEM, which is a compromise and should not outlive the
garment editor... its material will be derivable from those parts rather than
repeated here."* It now is. 568 of the pack's 720 parts carry a material tag
measured from their pixels (D-563), so `garmentMaterial` asks them.

⚠ **The heaviest part decides.** A mail hauberk with leather gloves is plate: a
calling barred from plate must not get around the gate because the gloves are
soft, and taking the lightest would make every suit gateable by its least
protected inch. `base` is bare skin and never votes — folding it in would let
a class "admit bare" as though it were a kind of protection.

⚠ **An untagged garment returns null, not cloth.** Empty means UNRESTRICTED
everywhere else in this codebase and a silent default here would be the one
place it did not.

`ItemTemplate` gains `garment`, and **CI refuses an item whose declared
material disagrees with the garment it names** — proven by deliberately
pointing `hide-jerkin` (leather) at a plate garment and watching the build
fail. Two sources that can differ will differ, and that particular
disagreement is silent: a class gate letting a magus wear plate because the
item said cloth. The declared field can be dropped once every armour item
names a garment.

### What a garment may not dress

⚠ Everything a person IS rather than wears — face, hair, brows, beard, ears —
is excluded from `GARMENT_SLOTS`. A garment is stripped between rounds
(D-522), so one that replaced your face would change who you looked like when
you took it off; and gear must never reach the descriptor pipeline, which is
the permanent disguise D-539 and D-547 both refused.

`helmet` IS included and is not an exception. In this pack a closed helm is
modelled as the head mesh — it has no `eyes` bone, because the face is inside
it — so wearing one necessarily swaps the head. It conceals rather than
rewrites: take it off and the authored face is underneath.

### Three UI defects, all found by driving the tool rather than reading it

⚠ **`textField` reached into another screen.** It hard-coded
`renderRoundList()` on change, and the garment editor reuses it for the name
field — so renaming a garment redrew the LIST pane as the recipe list while
the side pane still showed the garment. Nothing threw; the tool displayed two
different editors at once, which reads as a rendering glitch rather than as
one function calling into a screen it knows nothing about. The refresh is now
a parameter.

⚠ **The list row lied about the garment.** It carries the slot count, and
changing a slot re-rendered only the side pane — leaving a row reading "0
slots" beside a body visibly wearing three.

⚠ **Selecting a garment did not show it.** The row handler rendered the form
and left whatever was last on the stage: a bare head from the boot sequence,
beside a form describing a suit of plate. In an editor whose entire premise is
that a garment can only be judged by looking, that is the defect that matters
most, and no test would have caught it.

### Still to build

⚠ **Nothing renders a garment in the GAME yet.** The content is authorable and
validated; `ImportedVisual.setEquipment` still does nothing (D-559), so a worn
garment is invisible in play. Wiring it is the next piece, and it is the same
piece D-559 already named as the cost of a yes to this art.

⚠ **No garment is authored.** One was built end to end to prove the path — a
gothic plate torso with pauldroned upper arms and bare forearms, which is
exactly D-562's "some armours leave the arms bare" — and then deleted, because
the ask was the editor and a roster of garments is the stakeholder's to author
by looking.

---

## D-571 — A garment reaches the world: dressing is re-assembly, not grafting

**Status:** implemented.
**Completes:** D-570 (the garment editor), D-559's named regression
(`setEquipment` did nothing).
**Extends:** D-554 (the `worn` silhouette), D-555/D-558 (the assembler).

`ImportedVisual.setEquipment` was a no-op with a comment saying so. It now
re-assembles the character out of part files with the garment's slots swapped,
and the plate a player equips is the plate that renders.

### Grafting was ruled out by measurement, not by taste

The obvious implementation is to keep the built `.glb` and graft the garment's
meshes onto its skeleton. Measuring the three built characters killed it:

| | bones | notes |
|---|---|---|
| `ashfold-guard` | 53 | carries `Capes_01`, `back_02`…`back_05` |
| `ashfold-townsfolk` | 47 | no cape bones at all; has `toes_l` and no `toes_r` |
| `polygon-hero-male` | 47 | different ORDER again; meshes named `SK_Chr_Torso_Male_04`, not `torso` |

A character's skeleton is the union of ITS parts' weighted bones, so the three
disagree in count, in order and in membership. ⚠ Grafting a caped garment onto
the townsfolk would remap every cape vertex through a bone that is not there —
`indexOf.get(name)!` yields `undefined`, which becomes index 0 — and pool the
cape at the pelvis. Silently.

Re-assembling has none of those problems, because `assemble()` computes the
union for whatever combination it is handed. It is the same call the build
makes, which is what makes the claim "what renders is what the build would have
written" checkable rather than hopeful.

### Which needed a part to survive glTF, and that is the load-bearing measurement

`build:characters` now writes a `.glb` per PART that any character definition
or garment names — 29 files, 1.7 MB, only what content references, the rule
`build:environment` already follows.

⚠ **A part file is NOT scaled to metres**, unlike a finished outfit. It is an
ingredient: the browser feeds it back through the same `assemble()`, and that
call does the conversion. Baking it in would apply it twice and produce a
1.8-centimetre knight, which renders perfectly, at the wrong size, with nothing
in any log.

Proven rather than assumed — a re-assembly from part files against the build's
own monolith:

- **bounding box identical to three decimal places** on both characters;
- **same bone set**;
- **skinned vertices 90 NANOMETRES apart** under an identical name-based pose.

That last one is the real assertion. The box only says the bind pose matches;
posing both by bone name exactly as a clip does, and comparing
`applyBoneTransform` output vertex by vertex, is what says the skinIndex remap
is sound — and a wrong remap is a limb following the wrong joint, which reads
as bad art rather than as a bug.

### ⚠ The bone ORDER differs, and chasing that down was worth it

`ashfold-guard` re-assembles with the build's exact bone order and
`ashfold-townsfolk` does not (`neck_01` against `clavicle_l` at index 4). The
first version of the test asserted exact order and failed, and the temptation
was to weaken it to a set comparison and move on.

The cause: in the monolith each part arrived from FBX carrying the vendor's
whole rig, so a branch point like `spine_03` lists its children in the FBX's
order. A part FILE carries only the ancestors that part needs, so whichever
part introduced a child first decides. It does not matter — skinIndex is
remapped into whatever order results and clips bind by name — and the
90-nanometre test is what establishes that, instead of an argument.

⚠ What DOES matter is that the order parts arrive in is pinned. Feeding one
character's parts in JSON key order rather than slot-vocabulary order produces
the same 53 bones in a completely different arrangement. Both are correct;
having two is what makes any future comparison between build and browser
meaningless. The client iterates `CHARACTER_SLOTS`, as the build does.

### What travels, and what deliberately does not

`WornLook` gains `garments: string[]`, beside the five silhouette flags.
⚠ Exactly as public as those flags and for the same reason — everyone in the
room can see you are in mail — and still never reaching the descriptor
pipeline, or a helm becomes the permanent disguise D-539 refused.

⚠ **Order is a rule, not an accident of iteration.** Two garments can claim one
body slot; the later one is seen. `lookOf` sorts by the equip-slot vocabulary
so every observer resolves the collision identically — otherwise two clients
draw the same person in two different coats.

⚠ **Sex is NOT on the wire.** A garment is cut for a BODY, not chosen by a
player: the pack cuts most parts twice and a female forearm on a male upper arm
meets it at the wrong diameter (D-558). Which cut to wear is therefore a
property of the assembled character, and the manifest carries it. Putting it on
the wire would be asking the wrong system.

⚠ `EquippedItem` gains `garment`, because `lookOf` is deliberately keyed off
the slot and the stats "so a new sword looks like a sword without anybody
registering it anywhere" — and a garment is the one piece of appearance that
cannot be inferred from numbers. Which mesh replaces which slot is a decision
somebody made by looking (D-562).

### What it costs, and what it does not

⚠ **The common case costs nothing.** `loadDressed` falls straight through to
`load` when there is nothing worn, so an undressed character is one download,
one parse, one shared scene, exactly as before. Assembling is paid for only by
somebody actually dressed, and cached by combination — a crowd in the same kit
shares one assembly (asserted).

⚠ **A character with no slot vocabulary cannot be dressed**, and says so. One
discovered from a `.unitypackage` or a folder of loose FBX (D-556, D-557) has
meshes named after whatever file they came from, so a swap has nothing to
replace. The manifest carries `parts: null` to make that checkable rather than
guessable, and CI asserts the two agree.

⚠ **The old model is removed, never disposed.** Geometry, material and palette
are shared across every instance in the same kit, so disposing on a change of
coat would blank every other character wearing it — the trap `dispose()`
already documents.

⚠ **The animation is carried across, not restarted.** Putting on a cloak
mid-stride must not reset the walk to frame zero, and a corpse being looted must
not sit up and die again. `play()` now returns its action so the new one can be
seeked to where the old one was.

⚠ **A token guards the constructor's own load.** `setEquipment` can land before
the bare model resolves; without the check the bare model would arrive second
and silently undress somebody.

### What is authored

`gothic-plate` is a real garment — eight slots, both bodies — and
`mail-hauberk` names it. That is deliberate: the ask was to wire this up, so
one item genuinely wearing one garment is the deliverable rather than a
fixture. It is a first example to change, not a ratified roster.

⚠ **The PROCEDURAL cast ignores `garments` entirely**, and that is correct
rather than unfinished. It generates approximate armour geometry from the five
flags — that is what it is for — and reading the garments as well would draw
the same pauldrons twice. Both casts still take one `setEquipment`, so
`main.ts` still does not know which it is holding (D-559).

### Three defects the headless pass found, none of which would have thrown

Proving the SERVER half — a second player seeing the garment on the wire —
turned up three things the browser check could not have:

⚠ **`publishWorn` compared five fields and not the sixth.** The change test
was helm/pauldrons/cape/robe/weapon, which is a SILHOUETTE and not an
identity: two different suits of plate produce identical flags. Changing from
one to another was therefore judged "no visible change" and never broadcast —
the wearer would see it and nobody else would. `garments` is now part of the
comparison.

⚠ **The client told only the procedural cast.** `main.ts` handled
`entity_worn` with `if (e.visual instanceof CharacterVisual)`, so the imported
cast never heard about a change of kit and a garment would appear only on the
next full snapshot — in practice, on the next area change. `applyWorn` takes
the union precisely so the caller need not know which cast it holds (D-559);
testing for one of them was undoing that. The guard now excludes what is not a
person — a pile wears nothing — rather than picking a cast, which the compiler
insisted on and was right to.

⚠ **`BotClient` never handled `entity_worn` at all.** D-554 put the event on
the wire and nothing headless ever read it, so a bot's view of what anybody
wore froze at the snapshot and every assertion about equipment was silently
testing the starting kit.

⚠ An unknown-entity `entity_worn` is deliberately NOT a violation, unlike
every neighbour in that switch. Entering the world grants the kit and
publishes the silhouette before the new entity has been broadcast, so
observers legitimately get one delta about somebody they cannot see yet — and
the `entity_entered` that follows carries the authoritative `worn`. The real
client drops it on the same `if`. Treating it as a violation failed ten honest
tests to flag a redundant message.

⚠ **Still missing on the imported cast:** `setPresentation` (D-219's hood) and
emotes. Equipment is no longer on that list.

---

## D-572 — A character has a race, and the race bounds it

**Status:** implemented.
**Completes:** D-560 (races as content), and the half of D-566 that could never
fire.

⚠ **A character had no race at all.** `content/races/` has been authored since
D-560, curated in the creation tool, and every calling has carried a `races`
list since D-566 — and there was nowhere to record which race a character
actually *is*. So the gate could not fire, the authored height ranges bounded
nothing, and the skin tones and curated part lists reached no player. This is
the join between "races are content" and "the game reads them".

The server did not even load `content/races/`.

### What was added

A `raceId` on `create_character`, on the character record (migration 0015), on
the summary and on `status`; `races` in the server's content; and one pure rule,
`creationRaceProblems`, that the gateway enforces at creation.

⚠ **Optional, exactly as `classId` is**, and that property is the whole design.
Every character made before this, every bot and every older client sends none
and behaves identically. A calling that names no races admits all of them
(D-566), and all nine name none today. Authoring a race NARROWS; nothing is
silently locked by adding a field. The migration is `NULL` and nullable for the
same reason — giving existing characters a race would be inventing a fact about
somebody else's character.

⚠ **But a race that IS sent must resolve.** Writing an id nothing can look up
makes a character whose race is a string rather than a thing, and that survives
into the renderer and the descriptor pipeline before anybody notices. An
unknown race reports ONE problem and stops: nothing below the lookup can be
checked against a race that does not exist, and guessing would bury the real
error under two invented ones.

### The height bound, and the honest limit on it

A race's `height` range now bounds what a client may submit. ⚠ This is the
SERVER's limit, not the UI's (D-102): `APPEARANCE_LIMITS` allows 2.1m for
anybody, and the race is what says an elf is not that.

⚠ **It takes the UNION of the race's per-body ranges, not the matching one** —
because a character does not have a body sex to match against. `sex` in this
codebase selects which MESHES fit together (D-558) and is a property of an
assembled outfit; nobody has ever asked a player for one. Until creation does,
the honest bound is "a height this race can be at all". Narrowing per body
would be enforcing a fact nobody has stated. A race declaring no heights bounds
nothing, because empty means unrestricted here as everywhere.

### What was already there

⚠ **The class editor has had "Races it admits" since D-566.** The claim in
`CLAUDE.md` that it was still to build was stale — the AUTHORING existed and
only the enforcement was missing. The gate now carries a note saying it refuses
a character at creation, because narrowing it is the one edit on that page that
can stop somebody making the character they wanted.

### Verified

- The pure rules, including every "empty means unrestricted" path.
- End to end against a live gateway: recorded, refused when unknown, refused
  when too tall, accepted at the ends of the range.
- ⚠ **Against the REAL Postgres store**, not only `MemoryStore` — created with
  a race, read back with it. The fake being more permissive than the real one
  has cost this repo a login before (D-547), and a column added to the type but
  not to the INSERT would pass every in-memory test.
- Proven by deliberate break: removing the persist line fails two tests.

---

## D-573 — The creation screen asks what you are

**Status:** implemented.
**Completes:** D-560's course correction — *"the imported art must reach the
world THROUGH character creation, not by replacing the system that reads a
player's choices."*
**Builds on:** D-572 (a character has a race).

D-572 gave a character a race and the server the rules to judge it. Nothing
asked. The wizard was calling → face → body → skills → feats → name, and
`content/races/` — curated faces, statures, skin tones, markings — reached no
player at all.

It is now **calling → race → face → …**, and the order is the design: a calling
may admit only some races (D-566), so the choice has to be narrowed by one
already made; and a race curates which faces and statures exist (D-560), so it
has to be made before the face is.

### The step exists only when there is something to choose

⚠ A server whose content has no races skips it entirely — the same rule the
spell step already follows for a calling that does not cast. An empty step is a
question with no answers and a player has to click past it anyway. Verified
both ways by driving the wizard: six steps without races, seven with.

⚠ `creation_content` carries races **whole**, not as ids, because the screen
needs what each race curates. Ids would mean a round trip per race, or the
client shipping a copy of the content and going stale the moment somebody
authors one.

### The face step is bounded by the race, and that is the point

⚠ The server refuses a height the race cannot be (D-572). A panel that offered
the world's full 1.5–2.1m would be letting somebody build a character that is
rejected **at the last step, after they had named it**. `AppearancePanel` now
takes the race's range: measured in the browser, an elf's slider reads
1.60–1.85 and a human's 1.60–1.90.

⚠ Changing race **throws the panel away and rebuilds it** rather than clamping
what is there. Losing a tuned face is worse than annoying — but silently moving
a slider somebody set is the game editing their choice without saying so, and
showing them a character the server will refuse is worse than both.

⚠ A fresh ROLL is clamped, and that is not the same silent edit. The seed
generates from an archetype (D-402) whose ranges are the world's, so a roll can
legitimately land outside the race; nobody has chosen that number yet, and
leaving it out of range would show a slider whose handle sits past its own end.
Measured: seed 12345 rolls 1.703m, and inside a 1.62–1.64 race starts at 1.64.

### Two ways to strand a player, both closed

⚠ **Changing the calling drops a race it does not admit**, along with the feats
and spells that were already dropped for the same reason. Carrying one forward
would build a character the server rejects after it has been named.

⚠ **A calling can admit only races nobody has authored** — a content error, not
a bug, reachable by deleting a race a class still names. The step says which
calling and what it admits, and sends the player back, rather than presenting
an empty grid.

### The rule lives in `shared`, not in the screen

`racesForClass` was extracted rather than left in the wizard, because the
testing doctrine forbids logic that can only be exercised through a browser —
and this is the rule that decides what a player may be. Getting it backwards
offers exactly the races a calling refuses, with no symptom until the refusal.
⚠ Empty `classRaces` means ALL; all nine callings declare none today, so
inverting it would offer nobody anything.

⚠ **The review summary names the race.** It is chosen five steps before the
end and was never mentioned again — a summary that omits a whole step's choice
is the one place a wrong pick survives into a character you then live with. It
now reads "Elven Man-at-arms".

### Verified

By driving the real wizard in the browser, not by reading it: the step appears
and disappears with content, an unrestricted calling offers both races and a
gated one offers a single race, the slider takes the chosen race's range and
changes with it, a roll clamps, and the submitted message carries
`raceId: 'human'` with a height inside the human range.

---

## D-574 — A race is a face, and the face a player chose is the one the world draws

**Status:** implemented.
**Completes:** D-560's course correction, and answers the question D-559 left
open.
**Builds on:** D-572 (a character has a race), D-573 (creation asks), D-571
(re-assembly in the browser).

D-573 let a player choose a race and D-572 made the server enforce it, but a
race still only changed how tall you were. Its curated `parts`, `skinTones` and
`markings` — the whole reason a race is content — were sent to the client and
read by nothing.

Now the face step offers exactly what the race curates, the server refuses
anything else, and the world draws it.

### ⚠ This answers D-559's open question

D-559 recorded: *"which character an entity is drawn as is UNRESOLVED — picked
from the seed, which is deterministic and agreed across clients but arbitrary:
nothing connects the guard model to a guard. That needs a wire field and a
decision about how a roster relates to classes."*

Nothing needs to connect it. **The player said.** A look names a part per slot
and those parts are what gets assembled. The seed remains the answer for every
NPC, roamer, corpse and pre-face-step character — which is almost everything —
and that is a fallback rather than a failure.

### A look is not an appearance, and both survive

⚠ `CharacterLook` is deliberately SEPARATE from `AppearanceOverride`. The
latter is the procedural parameter set, and it is what the descriptor pipeline
reads to call a stranger "a towering, heavy-built figure" (D-201/D-539). Those
numbers must outlive whatever art renders them, so a look is an ADDITIONAL
layer: a character with no look renders exactly as before, which is every
character that exists.

⚠ Skin is stored as an **RGB, not a tone id**. D-560 measured why — skin is
four flat colours in the whole atlas, which the vendor's `_A/_B/_C` variants
merely remap — and storing the colour means a race can rename or reorder its
tones without silently changing somebody's face.

⚠ `look` is one JSONB column, not a column per slot. The slot vocabulary
belongs to content and grows with the art (D-561); a migration per hat is not
something anybody should have to write.

### Curation is a rule, not a menu

Every part must be one the race offers **for that slot**. A race that offers
the same faces as every other race is not a race (D-560), and a hand-rolled
client that could send any stem would have made the curation decorative. The
server refuses by name, and `lookProblems` is the one implementation the screen
and the server both read.

⚠ A look with NO race is refused outright rather than treated as a smaller
valid look — there is nothing to check it against, and accepting it would let a
raceless character carry any part in the pack.

⚠ "Wrong markings" and "this race wears none" are separate messages. "Pick a
different one" reads as advice when there is none to pick.

### The preview is the character, not a stand-in for it

⚠ Once a look names parts, the creation preview swaps from `CharacterVisual` to
`ImportedVisual` — the same class the world builds, from the same part files. A
creation screen that previewed a different cast from the world is the exact lie
this screen exists to avoid: tune a face, accept it, walk into the tavern as
somebody else. The panel holds the pair as a union for the same reason
`main.ts` does (D-559): the code driving a character must not know which it has.

⚠ The procedural sliders do not stop mattering when it swaps. They are what
the descriptors read, and those words are what other players see before they
are told a name.

### Two things the player is deliberately not asked

⚠ **The body.** A race curates one bare option per body for each of the eleven
body slots (D-563), so offering them would be eleven rows of a single button.
What matters is that the cut MATCHES the face — a female forearm on a male
upper arm meets it at the wrong diameter (D-558) — so the body is filled from
the face's own cut and refilled whenever that changes.

⚠ **Their sex.** It selects which meshes fit and is never shown (D-558); the
chosen head already contains the answer in its own filename. Storing it as well
would be a second source that can disagree with the parts it describes.

Changing the face also drops hair and brows cut for the other body. Dropping
them is visible; leaving them is a seam nobody chose.

### The skin recolour, measured rather than claimed

`skinPalette` substitutes four exact colours on the ATLAS — safe because each
UV island sits inside one flat region under NEAREST filtering (D-560).
Pixel-counted in the browser on a real character:

| | `#ffccae` (skin) | `#49667e` (garment) | `#2d3237` (garment) |
|---|---|---|---|
| untinted | 235,306 | 449,857 | 77,958 |
| ivory `#efe3d1` | **0** → 235,306 as `#efe3d1` | 449,857 | 77,958 |
| pale `#ffccae` | 235,306 | 449,857 | 77,958 |

The skin count moves exactly and the garment counts do not move at all.

⚠ Tinted palettes are cached **per colour**, not per character — a cast of
twenty in three tones is three textures. And the colours are part of the model
cache key: two characters in the same parts and different skin are two models,
and leaving the tone out of the key would hand the second one the first one's
face.

⚠ A palette that has not decoded yet returns UNTINTED rather than caching a
blank canvas under that key. A wrong skin for one frame beats painting
everybody in that tone permanently.

### The build has to run first

`build:characters` now exports a `.glb` for every part a RACE curates —
**183 files, 8.6 MB**, against the 29 a definition and a garment named. Without
it a player picks a face and the client asks for a file that was never written.
A client still downloads only the face it is looking at.

### Verified

By driving the real wizard: the race's four face rows and its skin swatches
render from the authored `content/races/elven.json`; picking a face fetches its
`.glb` and auto-fills all eleven body slots in the matching cut; the submitted
message carries twelve parts and the chosen tone. Server-side, against a live
gateway: recorded and persisted, refused for an unoffered part, refused for a
face with no race, refused for an off-palette skin, and a character with no
face still creates. Proven by deliberate break.

---

## D-575 — The head is the slot that decides the cut, so it cannot be filtered by it

**Status:** implemented. A defect fix on D-574, recorded because the failure
mode is worth remembering.

The stakeholder asked for female heads and brows to be added to both races.
⚠ **They were already there** — `elven` and `human` each curate all 23 male and
all 23 female heads, and 10 male and 7 female brows. The claim that they were
male-only came from reading the first four entries of a list, which happen to
be male. Measuring the file before acting on the request is what found that.

**But the symptom was real.** `renderFace` filtered every slot by the cut of
the chosen face, including `head`. So:

- with nothing chosen, all 46 faces showed;
- pick a male one, and the head row re-rendered filtered to male;
- **the 23 female faces were gone and could not be reached again.**

A one-way door. Nothing errored and nothing was logged — the options simply
stopped being drawn — so the only symptom available to a player is "I cannot
make a woman", which is exactly what was reported.

⚠ **The head is the slot that DECIDES the cut. Filtering it by that cut is
circular.** Every other slot must be filtered: a female brow on a male head
meets it at the wrong diameter and the seam is visible from three metres
(D-558). Parts the pack cuts once — hair, ears — carry no body word and belong
to both.

The rule moved to `partsForSlot` in `shared` and is tested, for the reason the
testing doctrine gives: this decides what a player can reach, it got it wrong,
and it cannot be exercised through a browser where it lived.

### ⚠ And the labels hid the only distinction on screen

`partLabel` stripped the body word, so the six faces read "Head 00" … "Head 08"
with no clue which cut each was — and "Eyebrow 01" appeared in both the male
and the female list meaning two different meshes. A fallback label exists to be
legible until somebody names the part properly (D-560); one that hides the only
distinction on screen is worse than the filename it came from. It now reads
"Head Female 05".

**Verified** by driving the wizard on the real authored race: all six faces
stay after picking either cut, brows swap from male 01/06/07 to female 01/02/03
with the face, and switching to a female face refetches the female head and
refills all ten body slots in the female cut.

---

## D-576 — The names were authored, and only the authoring tools could read them

**Status:** implemented.
**Completes:** D-560 (parts have player-facing names).

⚠ **Reported by the stakeholder as "I already named the heads/faces. How did
you lose it?" Nothing was lost.** `content/parts/modular-fantasy-hero.json`
holds **720 names**, written through the creation tool, valid, and
schema-checked in CI the whole time.

⚠ **The file was read by `name-parts.ts`, `studio-server.ts` and
`validate-content.ts` — the naming tool, the studio and the validator. Every
one of them is an authoring tool. The game server never loaded it**, so
`creation_content` never carried a name, and the creation screen derived a
label from the file stem for every part. A face the stakeholder had called
"Scarred mouth" was offered to a player as `Head Female 05`.

That is precisely what D-560 said must never happen — "nothing downstream can
show a filename" — and it was true of the tool that wrote the names and false
of the only screen that shows them.

### What changed

`Content.partNames` is loaded from `content/parts/` beside the races, and
`creation_content` carries `partNames`. The client's `partLabel` looks the stem
up and falls back to the stem, **keeping the body word** for the reason D-575
gives.

⚠ **Trimmed to what the races curate** — 142 of 720, 5.2 KB — because the other
578 are garment meshes creation never offers. Every part any race offers is
named today, and a server test asserts that rather than assuming it: an unnamed
curated part is a part nobody has named, never a name that failed to load.

### ⚠ Naming the parts CREATED a collision the file stems had hidden

**20 of the 23 head names are shared across the two cuts.** "Burnt", "Cut eye"
and "Markings 10" are each a male face *and* a female face — and D-575 requires
all 46 to be on screen at once, so switching to names put twenty pairs of
identically-labelled chips in one row. That is a worse row than the stems were.

So a row that shows **both** cuts is grouped under `male` / `female` headings.
⚠ Keyed on what the row actually contains, not on `head`: until a face is
picked nothing is filtered, and the brows row was offering "Flared", "Scruffy",
"Stylish", "Normal" and "Angry" twice each. Once a face is chosen every other
row holds one cut and no heading appears.

⚠ **Grouping rather than suffixing the name with its cut.** The head is the
slot that decides the cut — every other slot is filtered by it (D-558) and the
body is filled from it (D-574) — so a player choosing a face is already
choosing that, and a heading says so plainly. It is a label on an ambiguity
that is genuinely on screen, not a question about the player.

### ⚠ The same defect, one layer down: the chips were never styled

`.chip` and `.chip.on` are defined in `creation-tool.html` and `editor.html`.
**They have never existed in `client/index.html`.** The face picker borrowed the
class name from the authoring tools without the rule, so 46 faces rendered as a
run of unstyled text — no border, no background, no pointer cursor — and
`.chip.on` meant **the chosen face carried no mark at all**. Nothing threw;
the screen simply looked like prose. Styling now lives in the game's own sheet.

⚠ Both halves of this are one mistake with two symptoms: **the tool had it and
the game never asked.** Worth checking wherever else the two share a vocabulary.

**Verified** by driving the real wizard against the real content: 142 names on
the wire, "Normal | Scarred nose | Scarred eye | Scarred mouth | Dark eyes |
Burnt" where stems used to be, zero raw stems on screen, 46 faces under two
headings, brows grouped before a face is picked and flat (7, distinct) after,
and the chosen chip drawn in `--warm`. Proven by deliberate break: dropping the
loader line fails all three server tests.

---

## D-577 — One screen owns the overlay, and a model is scaled by its own height

**Status:** implemented.
**Found by:** the stakeholder looking at a screenshot and asking why character
creation was on the login page.

### The overlay had three forms and no owner

`#overlay .panel` holds `login-form`, `char-form` and `create-form` as
siblings. `CreationWizard.open()` hid `char-form` and showed `create-form`, and
**never touched `login-form`** — it relied on `showCharacters()` having hidden
it when you logged in. True on the one real path, and silently false for any
other caller.

⚠ **The screenshot was my own harness**, which opened the wizard without
logging in — so the reported symptom was not reachable in play. The fragility
it exposed was real, and is the part worth fixing: a screen that is correct
only because of what ran before it is one edit away from being wrong.

`open()` now hides all three of its siblings' worth of state — it owns the
panel while it is up. And `close()` no longer un-hides `char-form`: that is
right for cancelling and wrong for a dropped connection, which must land on the
login fields, and the disconnect path was correct only because it hid the
character list on the NEXT LINE. Each caller now names its own destination.

### ⚠ And then the preview showed a flat field of skin

Measuring instead of squinting: the assembled figure was **190 units tall and
217 wide** with the camera 4.5 units out. The camera was inside its shin.

`attach()` did `model.scale.setScalar(appearanceHeight / outfit.height)`. That
is wrong twice, in the same direction:

1. ⚠ **It SETS rather than multiplies**, wiping the centimetre-to-metre
   conversion the re-assembly loaders apply. Part files are exported unscaled
   by design (D-571) precisely so that conversion happens once, in the loader —
   so **every garment and every player-chosen face rendered one hundred times
   too large.** This was never only a preview bug: `attach` is shared with the
   world.
2. ⚠ **It divided by the MONOLITH's height** from the manifest (1.667m) while
   drawing a different assembly of different meshes (1.90m). A body a player
   authored is not the outfit it borrowed its rig from.

Loaders now report the height of the model **actually built**, and `attach`
multiplies by `appearanceHeight / loaded.height`.

### ⚠ The measurement that had to match the build

The obvious implementation — `Box3.setFromObject` — is wrong here and looks
tidier. `build:characters` measures stature from **bone extent**, lowest bone
to highest, which is where every manifest `height` comes from. Mesh bounds
include a helmet crest and a hair mesh: the authored guard measures **1.92m by
geometry against 1.70m by skeleton**. Normalising by geometry would make him a
short man wearing a tall hat, and would have **silently resized the existing
cast by up to 13%** while every test still passed.

`heightOf` measures bones, and the browser now reproduces the build's own
number to the millimetre on all three outfits — 0cm delta, measured, not
assumed.

**Verified:** asked for 1.6584m, renders 1.6584m (bind stature × final scale),
final scale 0.009951 — the loader's 0.01 preserved and normalised rather than
destroyed. Four headless tests on a synthetic figure, three of which fail when
the bone loop is emptied.

---

## D-578 — What a character is holding decides how they move

**Status:** implemented.
**Completes:** D-564 and D-565, which built the animation library and the layer
design and recorded that **"nothing in the game reads a set yet"**.

⚠ **The third thing this session found authored, validated and read only by
the authoring tools** (D-576 is the pattern). 126 clips, fifteen sets, a closed
action vocabulary, CI resolving every set together — and the renderer picked
clips by hard-coded NAME. So eleven stances animated identically, a man with a
bow swung it like a sword, and the three authored attack variants for every
melee stance showed as one.

### The chain that was missing

**The stance travels with the item**, beside `garment` and for the reason
already written there: `lookOf` is keyed off slot and stats so a new sword
looks like a sword without anybody registering it anywhere, and a stance is the
other fact numbers cannot give you. A bow and an arming sword have the same
shape of damage and reach.

⚠ **Resolved SERVER-side** against loaded content and sent on `worn` (D-102).
A client working it out from the silhouette would animate a crossbow as a
sword; a client handed an asset id would need the whole worn-item catalogue,
and an id it could not resolve would silently become "unarmed" — a man swinging
a greatsword like his fists. The existing `stanceOf` (D-566's weapon gate)
already did this lookup and is now shared rather than duplicated.

⚠ **Silent rather than defaulted.** `CharacterItem.stance` carries a schema
default of `one-handed`, right for a thing somebody filed as a weapon and wrong
for an item with no art at all — defaulting here would put a character holding
bread into a swordsman's guard.

### ⚠ The same broadcast bug as D-571, one field later, found the same way

`publishWorn` compares the silhouette to decide whether anything visible
changed, and `stance` was in the payload and not in the comparison. A bow and a
sword produce identical flags and identical garments — swapping one for the
other changes no mesh — so **drawing a bow was judged "no visible change" and
never broadcast**: the archer nocked an arrow and the room watched him swing.

The comment directly above the comparison already described this failure mode
for `garments`. It was found by the sim test, not by reading the code beneath
that comment.

### ⚠ Resolved up front, or it would apply to almost nobody

Building the table lazily on the first change of kit passed every test and left
the defect intact for the common case: roamers, the watch, the keeper and every
corpse never equip anything and never draw, so the authored rig set would have
applied to almost no one while the old hard-coded names still ran the world.
Caught by measuring a freshly constructed visual — `neutral-idle` where it
should have said `unarmed-idle`.

### What this turns on that was already paid for

- **Kneeling is its own motion.** D-559 recorded "kneeling borrows the sit,
  because there is no kneel". There is: `unarmed-kneel` shipped in D-564 and
  nothing read it.
- **The attack variant is read.** D-516 has sent which swing it asked for since
  combat was built and the renderer threw it away.
- **A bow shoots.** `combat-bow` names no `attack-1` — you do not swing a bow —
  so the chain is `attack-1 ?? shoot`, and asserting the raw key would have
  called correct content a failure.
- **Readiness is the absence of an override.** A man with a sheathed bow walks
  like a man; only `combat` has sets (D-565). Verified live: `unarmed-idle`
  sheathed, `bow-combat-idle` drawn, `bow-combat-walk` moving.

### ⚠ Gaps this exposes rather than fixes

- **The RACE layer is unreachable.** A race set applies to `race/sex`; the sex
  is derivable from the chosen parts but `raceId` is on the character record
  (D-572) and **not on the wire entity**. No race set is authored today so
  nothing is currently lost — the day one is, the wire is what needs feeding,
  not the resolver.
- **Two stances have no set at all**: `crossbow` (already flagged in D-568) and
  `one-handed-shield`. Both fall through to the rig, so a character holding
  only a shield stands as though empty-handed.
- **`dagger` and `thrown` have no combat idle** — the library holds two clips
  each, which their own notes say. Their fighters stand like unarmed men and
  strike like knife-fighters. That is the fall-through working correctly and a
  gap in the CLIP LIBRARY, not in the content; the fix is fetching two clips.

⚠ **Sets are loaded at BUILD time**, the channel `content/audio/sounds.json`
already uses. The cost, stated: authoring a set needs a client rebuild rather
than a server restart. Sets bind actions to clips in a `.glb` the same build
produces, so the two move together anyway — but if content must outpace
deploys, that import is the line to change.

---

## D-579 — Everyone who arrives in a round is told what they are

**Status:** implemented.
**Fixes:** the hole recorded in `CLAUDE.md` as "a player who joins a RUNNING
round never receives `round_role`", which turned out to have a second and much
worse face.

`round_role` was sent once, in a loop over the connections present when the
round STARTED. Two people it never reached:

1. **Anyone joining mid-round**, told nothing at all.
2. ⚠ **The antagonist reconnecting after a dropped connection.** `secretRole`
   is keyed on the CHARACTER, so the role survived the disconnect perfectly
   well on the server — the objective simply was never sent again. **A round is
   one player having a secret task**, and a dropped wifi connection silently
   disarmed it while the round carried on around them.

⚠ **`round_state` already reached them**, which is what made this so quiet: the
HUD showed a running round with a live clock and a cast count. The player could
see the round. They just had no idea what they were in it.

### The fix, and the rule it must not break

One `sendRoundRole(conn)` serves both the start of the round and every arrival
after it. ⚠ **Sent to EVERY arrival, never only to an antagonist** — the rule
the mode rests on is that everybody gets the message and only one carries an
objective, so its arrival is not itself a tell, and two places building that
payload is two places for it to stop being true.

⚠ **The same objective, not a fresh draw.** Re-rolling on reconnect would
change the round's win condition halfway through because somebody's connection
dropped.

### ⚠ What this exposes and does not fix — for the stakeholder

**A latecomer can never be the antagonist.** The assignment is made once, from
the cast present at the start, so anyone arriving later is truthfully told
`antagonist: false` — and everybody else can deduce it. At a cast of three to
five, "he wasn't here when it started, so he's clean" is a free elimination and
the mode's central deduction is that much cheaper.

This is a design question, not a bug, and the obvious fixes are worse:
reassigning mid-round changes the win condition under everyone; barring late
joiners shrinks an already small cast. Left as it is, stated plainly.

➡ **Ratified as it stands in D-634:** a latecomer joins on the good side.

⚠ Note also that `roundCast()` is computed live from connections, so a
latecomer DOES count toward the cast size and toward "the good cast is wiped".
Only the role assignment is frozen at the start.

**Verified** by a test written before the fix and watched to fail on both
counts: the latecomer times out waiting for a role, and so does the
reconnecting antagonist. `round_state` passed throughout, which is the detail
that dates the bug.

---

## D-580 — The common stores are a real place, and they can be ruined

**Status:** implemented.
**Completes:** D-530's ruling on facility potency, and closes D-529's hard
constraint that **the stores must run out**.

⚠ **D-530 has been half-built since it was written.** The ruling was that
pooling goods at a facility is more potent than carrying them and never
required — "it should not be *required* to store items there... Items placed
there, and 'used' from there should be more potent." What existed was a TIME
bonus for eating beside the storehouse **out of your own pack**. That is the
flavour of the rule without its substance: nothing was ever pooled, so nothing
could be hoarded, denied, or spoiled, and the table of trade-offs D-530 drew
had only one row that could actually happen.

### A store is the third owner an item can have

Beside a character and a corpse. Modelling it as an OWNER rather than as a list
hanging off the station is what keeps D-114's no-duplication invariant for
free: an item is in exactly one place, depositing is a move, and Postgres
enforces exactly-one-owner with a check constraint that was EXTENDED rather
than dropped — the gateway is not the only writer (D-547).

Keyed `<areaId>:<stationType>` — the TOWN's stores, not one particular sack.

⚠ **Anybody may take what anybody pooled.** No owner is recorded and no
permission is checked. That is the exposure half of D-530's trade, and a lock
would quietly delete the dilemma the facility exists to create.

⚠ **The stores are emptied at a round reset**, and this is not tidying. Gear
is stripped between rounds (D-522); stores that survived would let the cast
accumulate a permanent larder across rounds, defeating D-529's hard constraint
in a way that gets worse every round and reads as generosity.

### Spoiling rides on the ITEMS, not on the station

The well is a SOURCE and is rightly modelled as a timed window (D-552).
Provisions are things, and things go off: a timed flag on the station would let
a victim carry the loaf clear of the sabotage and eat it safely, which is not
what spoiling stores means. So `ItemData.spoiled` travels with the loaf.

⚠ **Nothing announces it, and the WIRE carries no flag either.** A first draft
sent `spoiled` on `store_contents`; the client could not render it without
destroying the sabotage, which made it a wire field nothing may ever read — the
exact anti-pattern three other decisions this session were written to remove.
It is gone. Whether the bread is good is a property of the BREAD, discovered by
eating it, and the test asserts it against the store rather than the wire.

⚠ **A spoiled loaf looks like a loaf.** You find out by
eating it — it costs you the meal AND deepens the hunger, exactly as poisoned
water does for thirst, because a saboteur who left everybody fed would have
accomplished nothing.

⚠ **Eating prefers an unspoiled loaf where there is a choice.** Given a good
one and a ruined one a person eats the good one, so sabotage bites once the
good food has run out — which is the pressure D-529 wants, and the opposite of
making every meal a coin toss.

⚠ **Refused BEFORE the bitterleaf is spent** when there is nothing
perishable there. The room is deliberately hard to read; destroying the one
thing that makes this possible for misreading it is a trap rather than a risk.

⚠ Its bite is exactly proportional to how much the cast pooled — the property
D-530 called the best thing in the design. The antagonist's non-violent play
grows stronger as the cast grows more trusting, and the hoarder is insulated
from the sabotage they refused to be part of.

### The UI says what is there and never who put it there

No "contributed by" line. Inventing one would turn generosity into a
scoreboard, which is exactly what D-303 forbids: the only reward for stocking
the larder is that other players saw you do it.

⚠ The `stock` button is drawn ONLY beside the stores. An affordance that is
always present and usually refused teaches players to ignore refusals. And
"there are no stores here" is treated as an ANSWER rather than an error — the
panel asks whenever it opens, the server is the authority on reach, and the
refusal is what empties the section.

### ⚠ Three things the tests caught that reading did not

1. **Stations exist only while a round runs.** They are spawned with the round
   (D-534) and torn down at reset, so the first fixture — a server with no
   round — produced four `no_store_here` refusals that looked like a broken
   feature and were a broken fixture.
2. **An objective needing a bigger cast than `minCast` means the lobby fills
   and never starts** — the trap D-569 named when the objective editor was
   built, hit here for real. Worth recording how it PRESENTED: the `beforeAll`
   timed out and vitest reported its tests as **SKIPPED rather than failed**,
   which reads as green in the summary line. Only `--reporter=verbose` showed
   three tests that never ran.
3. **`MemoryStore.grantItem` accepts a template content does not have.** The
   suite spent three tests pooling `ration-bread`, which does not exist; the
   real item is `coarse-bread`. Item rows do not reference templates, so
   Postgres would accept it too — consistent, not a divergence, but it means a
   typo'd item id is silently a real object.

**Verified** by eight bot-driven assertions through the wire, including the
no-duplication invariant (`countItems` unchanged across a deposit), a second
player taking what the first pooled, spoiled food deepening hunger, the good
loaf being eaten first, and the stores being empty after a real round reset.
Proven by deliberate break: removing the reset's `clearStores()` fails exactly
the reset test.

⚠ **Still unbuilt from D-530:** potency beyond meals — being treated at the
infirmary is not yet better than bandaging in the field, and the workshop is
not yet better than improvising. The multiplier band (1.5x-2x) remains
**unratified**, and D-530 flags it as the number to watch when the mode is
first played.

---

## D-581 — The editor shows you what you are about to place, and a map says whether it is real

**Status:** implemented.
**Asked for by the stakeholder**, ahead of authoring maps in earnest.

### What it is like to place something now

A **ghost** of the picked asset stands under the cursor, snapped exactly as the
click will snap, turned to the current angle and lifted to the current height.
⚠ It is a real `AssetVisual`, not a box: the whole reason to preview is to
judge whether THIS mesh sits right against the one beside it, and a stand-in of
the right size and the wrong shape answers a different question. Hidden rather
than parked when the cursor leaves the map — a preview left where it was last
valid reads as something already placed, which is the one thing it must not
look like.

**Shift + left-drag turns it. Shift + wheel raises it.** Both act on whichever
thing is live: the ghost while the asset tool is up, otherwise the selection.
⚠ Keyed on what is ON SCREEN rather than "the selection if there is one" —
preferring a stale selection while a preview is being steered would turn a wall
somewhere off-screen and look like nothing happened.

**X** swaps to selection and back to the SAME brush. Remembered rather than
assumed: the point of the key is to glance at what is already placed and carry
on, and snapping back to the tile tool would lose an asset picked out of 1,402.

⚠ **Shift-drag used to PAN, and this takes that binding.** Panning is still
on middle-drag, where it also already was. The trade is deliberate: panning had
two bindings and turning a wall to meet another had none but a 15° key, and
lining two meshes up by eye is the motion a map is actually built out of.

Height is a new field on the paint side (`assetZ`), deliberately SEPARATE from
a selected object's `z`. They are two different things a person adjusts, and
sharing one number means raising a lantern silently re-heights the next fifty
walls.

### ⚠ Two defects this turned up, one of them mine

**A wheel gesture was one undo step per notch.** `raiseBy` snapshotted on every
event, so Ctrl+Z would step back through a lift one notch at a time — exactly
what the painting path already refuses ("one snapshot per stroke, not per
tile"). Now one snapshot per gesture, with an idle gap deciding where a gesture
ends. Measured: five notches lift 1.25m and **one undo puts it back**.

**Undo left a DANGLING SELECTION, and that one predates this work.** `undo`
restores `area` by parsing a snapshot, so every `PlacedAsset` in it is a new
object — while `selected` went on pointing at the old, detached one. The
inspector, the mask view and now shift-turn would all be editing something no
longer on the map: the numbers move and nothing happens. Undo and redo now
clear the selection. Re-pointing it at whatever occupies that slot instead
would silently select a different object.

### A map now says whether it is real

`AreaDef.live` — is this part of a game loop, or a place to test things?
Nothing in a file said which, so `proving-ground` and `round-town` parsed
identically and every question that mattered was answered by recognising the
name. The editor shows it in front of the map's name in the list (● / ○) and
lets you set it.

⚠ **Defaults to FALSE**, the same direction as `outdoor` and for the same
reason: a map opts IN to being real. Forgetting it on a live map understates
what is shipping, which somebody notices the moment they look for their map and
it says test; the opposite default quietly promotes every scratch map to part
of the game, which is the failure nobody sees.

⚠ **It gates nothing**, on purpose. A flag that silently changed how an area
played would make a test map stop testing the thing it was built to test.

⚠ **The eleven/one split contains a judgement call the stakeholder should
check.** The eight `round-*` areas are unambiguously live (D-521 makes the
Round the shipping target) and `proving-ground` is unambiguously not. The other
three — `hanged-ferryman`, `broken-yard`, `sunken-crypt` — are the PERSISTENT
WORLD's authored areas, real content for a milestone resequenced behind MR
rather than cancelled, and the tavern even runs a scripted keeper. They are
marked live because calling them "for testing" would be untrue, not because
they are in the loop today. One word per file flips any of them.

**Verified** by driving the real editor through real events and reading the
numbers rather than the screen (the D-559 rule, in a second tool): the ghost
lands at the snapped point with the current angle and height; five wheel
notches lift 1.25m and one undo restores it; a selection turns 30° while the
paint defaults stay where they were; X round-trips and keeps the brush. The
editor grew `window.__ed` for this, which is what `window.__rc` is for the
game — the things worth checking here cannot be read off a screenshot.

---

## D-582 — The machine-placed scenery comes out, and the generator stops eating hand work

**Status:** implemented.
**Stakeholder:** "remove all procedurally generated assets completely from the
maps", ahead of designing them by hand.

### What was actually in the maps

Every one of the **6,130 placements across eleven areas came from one pack**,
`dungeon-pack`, and not one was put there by a person. They were produced by
`walls-to-assets.py`, which converts runs of wall TILES into rows of pack
meshes — a mechanical conversion, which is why the farm, the wood and the
tavern were all built out of dungeon masonry. That tool's own docstring said
where it ended: *"a person tidying a map by hand in the editor is the eventual
answer."* This is the other half of that sentence.

`tools/src/strip-procedural.py` clears them. It also clears **799 roof tiles**,
which were painted by the same generation: a roof is presentation that lifts
when you walk under it (D-545), so a roof left standing over removed walls is a
lid hanging in the air above bare ground.

⚠ **`proving-ground` is kept WHOLE**, and the rule that spares it is a named
list rather than a heuristic. It is the one map built by hand as a collision
fixture, and `mr6-proving-ground.test.ts` walks an actor through it — the only
test that covers the joins between the model, the index, the server, the wire
and the client. Clearing it would have deleted the test that catches exactly
the class of bug that map-building produces. A rule that inferred "fixture"
from `live` would quietly strip the next one somebody adds.

⚠ What is NOT touched is the map's SKELETON: tiles, legend, spawn, stations,
nodes, transitions, zone, outdoor, live. Where the doors are and what an area
IS were decisions; only the scenery was machine-placed.

### ⚠ The trap this exposed, which would have cost a day of design

`build-round-map.py` writes each `round-*` file **wholesale** and knows nothing
about `assets`. It was safe while those files held nothing but generated
geometry. It stopped being safe the moment a person opened the editor: one run
would have erased an afternoon of placement without a word, and the editor's
"this area is generated" warning understates it — the warning says your edits
are lost, the behaviour was that everything was.

The generator now carries `assets`, `roofs` and `live` across from whatever is
on disk. The division is stated where it is enforced: **this script owns the
skeleton of a round area, and a person owns what stands on it.**

Proven by running it: a marker asset, a roof tile and the `live` flag planted
in `round-town` all survived a full regeneration, while stations and
transitions were still rewritten by the generator.

### ⚠ Three tests failed, and each got a different answer

Blanket-skipping all three would have been the easy read. They are not the same
kind of failure:

1. **"roofs do not change what anybody can walk on"** — FIXED, and improved.
   Its own comment says it "asserts the shape of the data rather than
   behaviour", so depending on somebody having painted a roof was incidental.
   It now builds its own 8x8 roofed fixture and additionally asserts the thing
   that cannot be authored: that a roof has no field in which to say it blocks.
2. **"every map has walls you can bump into"** — SKIPPED, with the restore
   condition in its name. It is true again the moment the maps are designed,
   and it is false right now BY INSTRUCTION rather than by accident.
3. **"the dungeon gets tighter as it goes down"** — SKIPPED likewise. This is
   D-535's design property measured off the collision layer; with the scenery
   gone all three floors measure the same 10,000 open tiles. It is the
   assertion that stops floor 3 being floor 1 with different lighting, so it
   must come back when the floors are designed.

⚠ Skipping rather than deleting, and naming the restore condition in the test
title, is the compromise: deleting loses the rule, and leaving the suite red
trains people to ignore a red suite — which is the one thing D-114 cannot
afford, since the tests are the only thing reading this code for correctness.

**The maps are now bare walkable ground with their doors, spawns, stations and
nodes intact** — 12 assets left in the whole project, all of them in the
fixture. Content validates; 599 tests pass with the two skips.

---

## D-583 — Interactive objects are content, and they have a tab

**Status:** implemented.
**Stakeholder:** "there should be a tab in the creator for Interactive Objects
and here we would define stations, mining/food nodes etc. anything that is an
interactive part of the environment."

### What was wrong underneath it

⚠ **`content/stations/*.json` was read by CI and by nothing else.** The
gateway spawned facilities from a hardcoded `STATION_DESCRIPTORS` table of
four, so the authored `descriptor` never reached a player and a fifth station
type would have spawned with its raw id for a description ("forge"). The
`art` field had been in `StationDefSchema` since D-530 and nothing read it at
all. Resource nodes had no `art` field to read.

So both were drawn as built-in procedural geometry with no way to say
otherwise — the last procedural geometry in the game, which
`placement.ts` had already flagged as "a known residue [that] should become
pack assets like everything else".

### The chain, end to end

The server resolves a station's definition and sends its art on the entity;
the client draws it through **the same loader a placed asset uses**
(`loadOneAsset`), and `build:environment` now scans stations and nodes as well
as areas so the mesh actually ships.

⚠ **Resolved server-side, never looked up by the client** (D-102): which mesh
a facility wears is content the client has no copy of, and an id it could not
resolve would fall back to built-in geometry — the well silently reverting to a
grey cylinder, which reads as a texture failing to load rather than as a
mistake.

⚠ **The built-in shape is drawn FIRST and replaced only when a mesh arrives.**
Waiting for the fetch would leave a hole where the well is for as long as the
download takes, and thirst is a leash to a PLACE (D-529) — the place has to be
visible from the first frame. The fallback is also what answers for a
definition nobody has given art to, which is most of them.

⚠ `build:environment` ships only what the world uses, so **a station wearing
a mesh no area places would otherwise not be built** — scanning areas alone
would produce a map whose walls are right and whose well is a cylinder, with
nothing erroring.

### The tab

Stations and nodes together, because they are the same kind of thing to the
person making them: an object standing in the world that a player walks up to
and uses. What differs is what they DO — one gates a recipe, the other yields
an item and runs out — not how they are made, placed or drawn. Two tabs would
teach the art picker twice and hide that a forge and an ore vein are siblings.

The art picker runs over the **ingested catalogue**, not a text box, and the
save is refused when a mesh does not exist — checked on the authoring server
because `assets/source/` is gitignored and CI cannot see it. The list shows
which station types **the rules name by id**, because deleting one of those
breaks crafting rather than removing a building, and how many recipes gate on
each: a station nothing crafts at is an orphan in D-210's sense.

### What was authored

well → `knights/sm-bld-village-well-01`, workshop → `vikings/sm-prop-anvil-01`,
storehouse → `knights/sm-prop-crate-01`, infirmary → `vikings/sm-prop-table-01`,
timber-stand → `knights/sm-env-tree-01`, herb-patch →
`knights/sm-env-flower-01`, iron-vein → `vikings/sm-env-rock-02`.

⚠ Town facilities are kept to the village packs rather than `dungeon-pack`.
The packs carry different atlases and D-557's one-look rule applies to a square
as much as to a cast.

⚠ **`grain-row` and `game-trail` were deliberately left with no art.** The
packs ship no crop row and no game trail, and a hay cart or a fence standing in
for them would be a lie about what the object is — the same refusal D-568 made
when it would not give `hunting-bow` a sword's mesh to satisfy a gate.

---

## D-584 — Ashfold, designed; and where a map's shape actually lives

**Status:** implemented. The first hand-designed area.

A walled town of **129 placed meshes**: a cobbled square where every round
opens, the tavern on its north side, the four working buildings set BEHIND
their stations so the facilities stay in the open, the well alone on the road
south, a market flanking that road, four gates aligned to the four spokes, and
copses in the corners. Town furniture is from the village packs only —
`dungeon-pack` is a different atlas and D-557's one-look rule applies to a
square as much as to a cast.

### ⚠ The correction to D-582: a map's shape is in the TILES

D-582 skipped "the dungeon gets tighter as it goes down" on the grounds that
clearing the machine-placed scenery had erased the floors' shape. **That was
wrong.** A dungeon's cave system is carved in the tile grid by
`build-round-map.py`; only its WALL DRESSING had been converted to meshes. The
layout was never lost, and the rule is restored and passing — measured on the
tiles, which is the right place for it: a floor's shape is the level, not its
dressing.

⚠ The same finding bites the other way for the town. Running the generator
brings its tile walls BACK — 386 unwalkable tiles of palisade, timber and
brick — so a hand-designed town has two towns in it: the generator's boxes
standing invisibly inside the buildings a person placed. Ashfold's ground is
therefore FLATTENED as part of designing it, leaving structure to the meshes,
which is what D-567 asked for. Water is left alone: it is a feature, not a wall.

### ⚠ Four errors, each caught by a different check, none by looking

1. **Empty collision arrays.** The placements were written with `collision:
   []`, which means NO COLLISION — every wall and building in the town would
   have been walk-through. CI's drift check caught it, because an empty array
   disagrees with the catalogue's own mask. The mask is BAKED at placement, and
   an empty array is a statement rather than a default.
2. **A ring of orphaned ground.** The wall set back three from the border left
   45 walkable tiles between it and the map edge that no gate reached. The wall
   now sits ON the edge: the only way out is a gate, and a gate opens straight
   onto the tile that carries you to the next area.
3. **Gates that did not line up with their roads.** A blind 5-metre wall grid
   skipped one segment covering x 20–25 and then centred a 5-metre gate at
   24.5, covering 22–27. The result had a hole in the wall at 20–22 that
   nothing filled and a gatepost standing on one of the two road tiles.
4. **⚠ A gate opening sized by eye.** Posts 0.5m from the centre of a road
   tile leave no room for a body of `BODY_RADIUS` 0.3. The map validated, the
   gate looked open, and one of the two tiles carrying players to the farm was
   unusable — the flood tests TILES and a player is a circle.

### ⚠ The walk test is the assertion that matters

`mr7-ashfold.test.ts` sends an actor on the errands the round is made of: to
all four facilities, out through **both road tiles of every gate**, and across
the square corner to corner. It is the proving-ground treatment applied to the
town people actually play in, and it found something CI could not — a market
stall standing on the corner of the square, so the cast could not cross the
place where the dawn truce happens (D-536). The stalls now flank the road
south, where everybody walking to the water passes them, which is what a market
wants anyway.

**Validated, looked at from four angles, and walked.** The layout lives in
`tools/src/design-ashfold.py` — a transcription of a composition, not a
generator: every building, gate and piece of furniture is named and placed, and
the only loops are straight runs of identical wall, which is the gesture the
editor's own drag-to-lay-a-run makes.

---

## D-585 — The ground is painted, not tiled

**Status:** implemented.
**Stakeholder:** a texture painter for the bare floor — and, when the first cut
arrived tile-based: "I do not want the painting to be tile based, I need a
brush that paints where I choose, with smoothing/blending."

### ⚠ The first cut was wrong, and the correction is the decision

Ground materials were hung off the tile LEGEND, so painting was "assign a
character to a square" — cheap to store, diffable, and unable to do the one
thing a ground painter is for. A tile-based floor can only ever have square
edges. What a person laying out ground wants is a brush that goes where they
put it and blends where two surfaces meet.

So the ground is **one image over the area** (`AreaDef.groundPaint`), painted
with a soft round brush.

⚠ Baking the blend into an image rather than mixing N materials in a splat
SHADER is the right trade here specifically: this renderer draws at a low
internal resolution and ends in palette quantisation (D-404), so the detail a
splat shader buys is quantised away — and one image means one plane, one
material, and nothing to keep in sync between the editor and the game.

### What a material is

`content/ground/*.json`: a name, an optional texture file, a repeat, and a
tint. Eight ship — grass, dirt, cobble, flag, boards, sand, mud, stone.

⚠ **The tint is the fallback as well as the tint**, and that is what makes
the whole thing usable before any art exists: a material with no texture paints
as flat colour, so ground can be laid out now and gain its surface when the art
lands, without being repainted. Every one of the eight ships that way.

⚠ A material naming a texture that is not on disk **fails the build**, the
rule a sound cue follows (D-541) and for the same reason: it renders as the
tint and looks exactly like a material nobody finished.

### The brush

Paints the material's texture tiled in WORLD space — anchored to the world and
not to the stroke, or every dab restarts the tiling and a field of grass
becomes a mosaic of overlapping circles.

⚠ The soft edge is done by CLIPPING the material's own pixels to a
radial-gradient alpha, not by drawing a gradient of its colour. Drawing the
colour fades towards transparent black and leaves a dark rim where two
materials meet, which is the opposite of blending.

⚠ Strokes are INTERPOLATED. A pointer reports a handful of positions a
second and a fast drag jumps metres between them, so dabbing only where events
land draws a string of discs with gaps — a broken brush rather than a fast
stroke. The stroke ends on pointer-up, or the next click paints a line from
wherever the last one finished.

Radius is in METRES, not pixels: the thing being judged is how big the stroke
is on the map, and a pixel radius means a different brush at every zoom — the
same mistake as sizing a gate opening by eye (D-584).

### ⚠ The editor draws the ground now, reversing part of D-567

D-567 replaced the editor's terrain with an empty plane on the grounds that
"the ground has to get out of the way". That was right while the ground was not
authored. It stops being right the moment somebody is painting a surface,
because you cannot judge one you cannot see. The editor draws the painted image
through the GAME's own code — a painter whose floor is not the floor that ships
is a painter that lies (the D-558 rule for the character assembler).

⚠ The image is written BEFORE the area's reference to it. The other way
round, a save that failed halfway leaves an area naming a picture that is not
there — which CI refuses, so the map stops building until somebody works out
why.

**Textures:** `client/public/textures/ground/` for materials,
`client/public/textures/painted/` for the painted images. ambientCG and Poly
Haven are both CC0 — verified against their own licence pages, commercial use
allowed, attribution not required.

---

## D-586 — The palette quantiser is removed

**Status:** implemented. **Supersedes D-401 and D-404**, and the split-render
ruling of 2026-08-18.
**Stakeholder:** "remove the pixelization effect/layer from the game. It is no
longer needed."

The world is drawn straight to the canvas at full resolution. Gone with it: the
320x200 internal buffer, the ordered dither, the 24-colour palette snap, the
nearest-neighbour upscale, the split pass that ran characters through the
quantiser while the world stayed crisp, and every control that tuned them
(`PixelPost`, 263 lines, deleted).

⚠ **This is a decision reversal, and it is the stakeholder's to make.** The
pixelation was ratified art direction validated by prototype (D-401) and
reinstated once already. It is recorded as a supersession rather than an edit,
per this project's ADR convention, so the reasoning that produced it stays
readable.

### ⚠ Three things were tuned AGAINST the quantiser and are now wrong

Each was a correct decision whose premise has gone:

1. **The camera's aspect came from the 320x200 buffer.** Right while every
   frame was rendered into that buffer and upscaled; a stretched world now. It
   reads the real viewport.
2. **The painted ground was 8 pixels per metre**, chosen because anything
   finer was quantised away. At full resolution that is simply blocky — a soft
   brush edge became a staircase. Raised to 32.
3. **Ground textures filtered NEAREST**, because bilinear mush before a hard
   colour snap helps nothing. Now LINEAR: a soft brush edge is the whole point
   of the painter (D-585), and nearest turns it back into a staircase.

⚠ Characters and effects still sit on **layer 1** — the split pass drew them
separately — so the single render explicitly enables every layer on the camera.
Without that the world draws with nobody in it.

⚠ The Graphics settings panel keeps only what still decides something: which
cast the world is drawn with, and whether walls between you and the camera go
stippled. A slider that tunes a pass that no longer exists is worse than no
slider.

---

## D-587 — The ground paints a mask, not a picture

**Status:** implemented. **Corrects D-585.**
**Stakeholder:** "The detail I am seeing in the render window is very poor. Why
is this the case?"

### The answer, measured

D-585 baked the material's own pixels into the painted image. A 1024px forest
texture covering 2.5 metres, baked at 32 pixels per metre, occupies **80
pixels** — a **thirteenfold downsample**, before a frame is drawn. Ninety-nine
per cent of the art was thrown away at paint time, and no amount of better
source art would have changed it.

⚠ **The reasoning that produced it was sound and its premise had been
removed.** D-585 argued the bake from the palette quantiser: "the detail a
splat shader buys is quantised away". D-586 deleted the quantiser at the
stakeholder's request. I corrected two things that dependended on it — the
camera's aspect, the texture filtering — and did not follow the same thread to
the decision that rested on it hardest. A removed premise does not announce
which conclusions it was holding up.

### What it does now

The painted image carries WEIGHTS, one material per channel, and the shader
samples each material's texture tiled in world space and mixes them. The mask
can be coarse — a soft brush edge is a gradient, not fine detail — while the
surface stays exactly as sharp as the source art.

⚠ **THREE materials per area, not four, and the reason is a canvas trap.** An
RGBA mask looks like four weight channels. It is not: a 2D canvas stores
premultiplied pixels, so a weight written into ALPHA reads back as zero for red,
green and blue. The first cut painted happily and measured an entirely empty
mask — nothing on screen, no error, every channel zero. Alpha now carries
COVERAGE and the three colour channels carry weights. The editor names the three
an area is using and refuses a fourth rather than dropping it.

⚠ The channel ORDER is data. Red means "this much of `groundMaterials[0]`";
reorder that list and a map repaints itself with gravel where the grass was,
silently and everywhere. It is written beside the image and read by the renderer.

⚠ Painting a material takes weight AWAY from the others at that texel, or two
materials at full strength wash to their average forever and nothing can be
painted over.

⚠ Layer textures are mipmapped and anisotropic. Ground runs away from an
isometric camera, and a tiled texture without mipmaps shimmers violently at
distance — the artefact that reads as a broken renderer.

### ⚠ A splat mask cannot be judged by looking

"The ground is blank" has at least three causes that are identical on screen:
nothing painted, the shader discarding, and the channels being zeroed on
upload. It was the third, and only a hook that counts non-zero texels per
channel could tell them apart. `window.__ed.mask()` exists for that reason.

---

## D-588 — Six ground materials, a way to take one off a map, and the alpha that was eating the blend

**2026-09-12. Supersedes D-587's channel budget and its coverage rule; the rest
of D-587 stands.**

The stakeholder asked for two things: a second splat layer, and controls to
remove a material from a map — "Deleting it does not work, and it tells me I
have used all materials."

### ⚠ The report was a real bug of mine, and my own error text was false advice

`channelFor()` added a layer the first time a material was painted and **never
removed one**. So a material rubbed out to nothing still held its channel, and
the message I had written for the full case —

> Rub one out completely to free its channel, or paint with one of those four.

— described something the code could not do, however hard anybody rubbed. There
was no way to free a channel at all. Erasing PAINT and removing a MATERIAL are
different acts and only one of them existed.

### Two masks, six materials

`SPLAT_MASKS = 2`, three weights each. Three was one image's worth and ran out
immediately: a town is grass, dirt and cobble before anybody has laid a gravel
yard or a patch of mud. The cost is one more texture fetch per fragment, which
is the cheapest thing in this shader.

`groundPaint` is now a LIST of image names, one per mask, paired with
`groundMaterials` three at a time. `GROUND_MASKS` lives in `shared/` because
three things must agree — the schema, the renderer and the editor server that
writes the files — and three separate constants is three chances for a map to
name a mask nobody wrote.

### Removing a material COMPACTS the channels

Clearing a channel alone would leave a hole nothing could use. `removeMaterial`
clears it and slides every later material down, **moving its painted weights
with it** — including across the mask boundary, where channel 3 lives in the
second image and lands in the first.

⚠ That arithmetic is pulled out of the canvas into `compactChannels` and tested
headlessly, because it is the half that cannot be judged by looking: a
compaction that moves the materials but not their weights renders a perfectly
plausible town with grass where the gravel was, and nothing in the picture says
so. Six tests, and a deliberate break to prove they bite.

### ⚠ ALPHA-AS-COVERAGE WAS EATING THE BLEND, and that is D-587 corrected

Found while verifying this, not by reading. D-587 made alpha the coverage,
derived as the largest weight in its own mask. That puts a SMALL number in alpha
exactly where the weights are small, and a premultiplied canvas loses precision
in proportion to how small alpha is. Measured in the browser, one write and one
read of a single canvas:

```
wrote 255,128, 64,255  ->  read 255,128, 64,255   lossless
wrote 100, 50,  0,100  ->  read  99, 51,  0,100   ±1
wrote  10,  0,  0, 10  ->  read   0,  0,  0, 10   GONE
wrote   3,  0,  0,  3  ->  read   0,  0,  0,  3   GONE
```

The smallest weights are the soft RIM of every stroke — the blending the brush
exists for, and the thing the stakeholder asked for in those words. On one
stroke at radius 4m, the old rule **destroyed 784 of 12,825 painted texels
outright (6.1%) and drifted 6,292 more (49%)**, and it compounded on every
read, every save and every reload.

So alpha is now **binary**: 255 where anything is painted, 0 where nothing is —
the two values a premultiplied store round-trips exactly. Coverage is computed
in the shader from the weight TOTAL, which is both lossless and a better edge:
the rim carries a small total, so paint fades into the ground under it instead
of ending on a rim that is faint and fully opaque.

⚠ The three-weights-per-mask limit is UNCHANGED and the reason is now stated
better: alpha cannot carry a weight because a small alpha destroys the weights
beside it, not merely because the channel reads back empty.

### What the editor shows

An "In use on this map (n/6)" list under the material palette: each material,
the share of the map it actually covers, and a remove button. The share is
MEASURED from the masks rather than counted from strokes — a material painted
and then covered over reads as 0% and is exactly the one worth removing, and
nothing but the pixels knows that. Removing is confirmed, and the confirmation
says what it costs.

`window.__ed` gains `dab`, `remove` and `coverage`. Six materials and a removal
is a dozen strokes and a dialog, and what has to be checked afterwards is which
channel holds what — a number, not a picture.

⚠ **The game still does not render painted ground.** `buildPaintedGround` is
updated to the splat form and has no caller: the wire's area has no
`groundPaint` field, so putting the painted floor in front of a player is a
protocol change and a separate piece of work. The editor paints what the editor
shows.

### ⚠ An unrelated test was failing, and its fixture was the liar

`mr2-grace.test.ts` put two bots at `width/2` and `width/2 + 1` on the south
road. Ashfold's gate opening is two tiles wide and centred on x=24.5, so the
right-hand bot was standing in the palisade — whose TILE is walkable grass,
because the wall is an asset with a collision volume (D-584) rather than a wall
kind. Nothing in the map data looked wrong. The bot was quietly relocated to the
area spawn twenty-two tiles away and the truce test failed claiming the server
had allowed an attack it had actually refused for being out of reach. The tiles
are now DERIVED with `canStandAt`, and the fixture asserts the two bots ended up
adjacent before asserting anything about the truce.

---

## D-589 — The painted ground reaches a player

**2026-09-12. Completes D-585/D-587/D-588.**

Three decisions built a ground painter and **the wire carried nothing**.
`buildPaintedGround` sat with no caller, the snapshot's area had no field for
it, and the editor painted a floor the game had no way to be told about. This
is the half that closes it.

### The masks ride on the snapshot, beside `roofs`

`groundPaint` (the mask images) and `groundMaterials` (which material owns each
channel) are added to the wire area. Presentation only, like `roofs` — and for
a stronger reason than convention.

⚠ **A ground material carries `walkable`, and the server does not read it.**
What a floor is made of must never decide where a body may stand; that is the
tile grid and the collision volumes (D-542, D-584). If paint could re-cut a
map, laying a patch of mud would silently move a wall and the person painting
would have no way to know. `mr8-painted-ground.test.ts` asserts two areas
differing *only* in their paint send identical tiles, legend and size.

⚠ **The two fields travel together or not at all.** A mask without its material
list is six unlabelled numbers per texel; the list without the mask is a set of
materials covering nothing. Both default to `[]` — empty, never absent, because
the client asks for a length and the common case is every map in the game.

⚠ **Order is the data**, as it is in the file: mask 0's red means
`groundMaterials[0]`, mask 1's red means `[3]`, and nothing in the pixels
records which was which.

### One implementation, both sides

The client builds the plane through the same `ground.ts` the editor uses, for
the reason D-558 gives for sharing the character assembler: a floor that draws
differently in the painter from the way it draws in the world is a painter that
lies. `buildPaintedGround` is updated from D-585's single baked image to the
splat form — a list of masks, layers resolved from ids against the client's own
`content/ground/`.

⚠ **A material the content no longer defines keeps its place and renders
nothing.** Dropping the entry would slide every later material onto somebody
else's paint — a map that renders perfectly and is the wrong map.

⚠ **The masks load as `NoColorSpace`.** They are weights, not pictures; an sRGB
decode would bend every blend in a way that still looks like ground.

### ⚠ The test fixture had to be synthesised, and the first cut proved why

The unpainted case originally used `proving-ground` itself and passed until the
moment that map was painted — which is exactly the point. What is painted in
`content/` is a decision somebody may remake any day, so a test that reads it is
testing the map rather than the wire. Both fixtures are now built in memory and
differ in one thing.

### What is verified, and what is not

- The server sends the pair, and paint changes nothing about the map: four
  headless tests.
- `buildPaintedGround` loads both masks from PNG, resolves six material ids,
  fetches six textures (all 200) and renders **six patches in six distinct
  colours**: measured in the browser by flood-filling the rendered pixels,
  against the map saved by the editor.
- ⚠ **NOT verified: the three lines in `main.ts`** that build the mesh on a
  snapshot and dispose it on an area change. That path needs a logged-in player,
  which is the stakeholder's half of D-114. Both halves around it are covered.
- ⚠ **No live map is painted**, so this ships as a no-op for players until
  somebody paints one. `proving-ground` carries test paint, nothing else does.

---

## D-590 — Ashfold has a ground, and the tint was eating it

**2026-09-12.** Supersedes D-585's single `tint` field.

`tools/src/paint-round-town.py` paints the town: six materials — grass, dirt,
cobble, boards, mud, leaf mould — over the whole 50×50, written as the two
splat masks D-588 defined.

### ⚠ The tile grid is a guide, not a stencil

The stakeholder's requirement was explicit and is the whole constraint: *"I do
not want the painting to be tilebased, I need a brush that paints where I
choose, with smoothing/blending"*. A mask rasterised straight off a 50×50 grid
is a tile-based floor wearing a splat shader — every boundary a perfect
axis-aligned staircase at exactly one-metre intervals.

So each boundary is **blurred into a soft edge and then domain-warped**, sampled
through low-frequency noise that carries the finished gradient off the grid by
up to most of a tile.

⚠ **That order is the way round it is because the other way was tried and looked
at.** Warping a hard 0/1 edge and blurring afterwards only works while the warp
is WIDER than the blur; at a 0.38m warp under a blur with about a metre of
support, the wander was averaged away completely and every boundary came back
perfectly straight — soft, and unmistakably a grid.

⚠ **One displacement field, shared by every material.** Warping each through its
own noise moves neighbours independently, opening gaps that the normalisation
fills with whatever is nearby — a thin wrong-coloured seam down the side of
every road.

⚠ **A building is where its BUILDING is, not where the grid changes character.**
The tavern's meshes stand across the north ring road, so the tiles beneath it
say `dirt` and the first pass painted the road straight through the taproom.

⚠ **Wear is broken HARD, not shaded.** The churned ground at the gates, the
junctions, the well and the tavern door started as discs multiplied by noise
ranging 0.55–1.2 — which left every stamp a complete circle that merely varied
in strength: six identical circles, read as six identical circles. Taking the
noise down THROUGH zero cuts each into patches instead.

### ⚠ A material was being multiplied by its own average colour

Found by looking at the first painted town, which came out nearly black and
read as bad lighting. `tint` was doing two jobs — the flat colour a material
shows when it has no art, AND a multiply over the art when it has some — and
those cannot be one number, because a material's tint IS roughly the average
colour of its own texture. Multiplying them squares it. Measured across the
shipped materials:

```
mud      texture 0.302,0.267,0.216   x tint  ->  0.107,0.080,0.051
grass    texture 0.366,0.417,0.253   x tint  ->  0.153,0.199,0.084
boards   texture 0.489,0.381,0.256   x tint  ->  0.213,0.130,0.065
```

An albedo of 0.08 is about as dark as coal. So the two jobs are two fields:
**`tint` stands in for art that is missing** (never multiplied into a texture,
which is what keeps D-585's promise that a map can be laid out before its art
exists), and **`wash` modifies art that is there**, defaulting to white.

### ⚠ The generator put Ashfold's walls back, for the second time

Running `build-round-map.py` to prove the paint survives it also rewrote 386
palisade and wall TILES into a town whose walls became placed assets with
collision volumes (D-584) — an invisible second palisade standing inside the
real one, which parses, validates and floods as reachable. The record already
noted this happening once; it happened again, to somebody who had just read
that note.

A warning that has been read and not acted on is not a control. The generator
now carries `SHAPE_IS_AUTHORED = {'round-town'}`: for those areas it preserves
the shape as well as the contents, prints that it did, and is idempotent —
proven by running it twice and diffing.

⚠ `groundPaint`/`groundMaterials` are in `PRESERVED` for the related reason:
without them the next generator run would have silently unpainted the town and
left two orphan masks on disk, looking exactly like a map nobody had painted.

### What is verified

- The editor reads the masks back at the shares the script reported (64.7% vs
  64.8% grass, and so on down the list): the PNG round trip is lossless and the
  channel order is right.
- Content validates; the generator is idempotent over the whole `content/areas`
  directory.
- ⚠ **Whether it LOOKS right is the stakeholder's call** (D-114). It has been
  looked at from three angles and top-down, and the numbers above are the only
  part of "does the town have a ground" that a machine can answer.

---

## D-591 — A blue road, a statue that could only ever be one colour, and a town with things in it

**2026-09-12.** Three faults, two of them invisible to the eye that looked at
them, plus the dressing pass Ashfold needed.

### ⚠ Every piece of world scenery had its V axis inverted

`world-assets.ts` set `flipY = false` on the environment atlas, citing D-559.
D-559 is about the CHARACTER palette — and `imported-models.ts` says, in
terms, **"NOT flipY = false"** and gives the reason. The line here copied the
decision's citation and the opposite of its conclusion.

It survived because the miss is nearly invisible on most of the pack: the atlas
is roughly symmetric in tone about v=0.5, so walls landed on other greys and
houses on other reds and looked completely right. Measured by rendering each
mesh under both conventions and counting pixels:

```
path   false #394171 (blue)          ->  true #7c817d (grey cobble)
tree   false #717171 #daa3a5         ->  true #5d6a36 #6b573f
cart   false #caae86 #555558         ->  true #6b573f (brown)
```

⚠ **And it was misread twice before it was measured.** A top-down render was
read as "grey rocks scattered in the corners"; those were the TREES, and the
green around them was the painted ground. D-560's rule again: reading a render
is not measuring one.

⚠ **The editor had been right the whole time** — it never set `flipY` — so the
tool and the game disagreed, which is the exact failure D-543 exists to
prevent. It was not caught because nobody had put the two side by side on a
mesh that differs.

### ⚠ Two meshes have a CORNER origin, and the paths missed their own gates

A placed asset's `x,y` is the centre of the thing: the editor shows it there,
the collision mask is baked around it, every generator assumes it. Measured
across three packs, walls, gates, houses and stalls all sit within a centimetre
of centred. `SM_Env_Path_Cobble_01` and `_02` span 0…3 in x and −3…0 in z, so
**every cobble path in Ashfold was drawn 1.5m east and 1.5m north of the road
it was laid on** — a paved way missing the gate it leads to, in a town whose
gates and walkable corridor are aligned to the centimetre.

`originCorrection` lives in `shared/` and is read by BOTH the build and the
editor, because both had the same bug in the same way and therefore agreed with
each other.

⚠ **The rule is narrow on purpose.** Centring every mesh on its bounding box
fixes the two that are broken and moves a dozen that are right: a tree's origin
is its TRUNK and its box centre is out in the canopy. An axis is corrected only
when the mesh lies entirely to one side of the origin, which is what a corner
origin means and nothing else does. Four meshes qualify, and the build PRINTS
each one — D-558's rule that a silent repair is a silent claim the art was fine.

⚠ The gate itself was never misaligned: its arch measures 2.11m centred on its
origin against a 2.0m walkable corridor at the same centre. Measuring that
first is what stopped the "fix" landing on the gates.

### ⚠ The statue could not be re-textured, because it has ONE uv

`SM_Prop_Statue_01` gives all **11,598** of its vertices the same texture
coordinate, in the vendor's own FBX — the source and the built `.glb` are
identical, so the pipeline is faithful and the mesh can only ever be one flat
colour. Sampling every one of the knights pack's ten atlases at that
coordinate gives a brown in all ten; there is no atlas that makes it stone.

So it is REPLACED, not repaired: `dungeon-pack/sm-env-statue-03` carries 19
distinct uvs on weathered greys. Turned 90° so its 2×1 footprint is the 1×2 the
old one had — the same three tiles, not one more — and the 2×2 plinth prop is
deliberately left off, because a plinth is not worth two tiles of the one square
the whole cast crosses.

### Ashfold is dressed: 172 objects

Market stalls with goods beside them, benches at the well, a woodpile at the
smithy, crates at the storehouse, a weapon rack and banners at the guardhouse,
torches at the gates, roadside fence runs, and grass and flowers over the green.

⚠ **Every solid placement is refused if it would stand in a route**, and
refusals are printed. Fifteen were. The keep-clear set is derived from the map
— the road a body walks, the ring, two tiles around every facility, the spawn —
**plus the four corners of the square, because `mr7-ashfold.test.ts` walks a
body to each of them and that test is the contract for this map.** The first
pass put a barrel on one, a crate on another and a stall on the other two; all
four were reachable, so the flood was happy, and the walk test said "no route to
(20,20)". A tile a test stands on is as load-bearing as a road.

⚠ **A flower is not a wall.** Almost everything in these packs is `solid: true`,
`sm-env-flower-01` included, so anything scattered for looks carries an explicit
empty mask — a statement that you may walk through it rather than an oversight.

⚠ **The copses stayed thin, and the number of attempts is the finding.** Random
scatter, minimum-spacing rules, quarter-turns only, and hand-transcribed
positions each left a different set of unreachable tiles: a canopy is two to
three metres, a body is sixty centimetres, and the green between the ring road
and the palisade is narrow enough that one tree in the wrong metre makes a dead
end along the wall. Four trees, one per copse, on the inner edge. Thickening
them properly means moving the existing trees, which is a map decision rather
than a dressing one.

⚠ **The 6×5 rockpiles are set pieces, not scatter.** One at the north-west
corner filled the gap between the palisade and the smithy and sealed 26 tiles
off. Nothing about a rock pile looks like a wall.

### `tools/src/why-unreachable.ts`

"5 walkable tiles unreachable, e.g. (7,14)" is not something you can act on.
This names the assets standing around each one. ⚠ Its first cut wrote its own
flood — tile centres, four directions — and reported every tile reachable while
`validate:content` refused the same map. It now imports `unreachableTiles`: a
diagnostic that disagrees with the thing it is diagnosing is worse than none.

⚠ The placer's own guard is in Python and the authority is in TypeScript, so it
can only approximate (it grows each blocker by `BODY_RADIUS` and floods tile
centres). It catches gross pockets. `validate:content` remains the authority and
the walk test remains the contract.

---

## D-592 — The whole world has a ground and things standing on it

**2026-09-12.** Extends D-590/D-591 from Ashfold to every area. Supersedes
`paint-round-town.py` (now one entry in a table) and the D-542 `dress-areas.py`
(which wrote the dead `props` array).

### ⚠ Three areas had been flattened to empty rooms, and that was found by surveying

Before anything could be dressed, a survey of all twelve areas turned up that
`hanged-ferryman`, `broken-yard` and `sunken-crypt` were **100% floor with a
one-entry legend** — no walls, no water, no furniture. At HEAD they had 473,
252 and 55 wall tiles respectively.

The cause is a pair of tools run in sequence: `walls-to-assets.py` (D-567)
turns wall TILES into pack meshes and floors the tiles underneath, and then
`strip-procedural.py` (D-582) deleted every asset in eleven areas — including
the walls that had just become assets. **The first-slice tavern, which is the
persistent world's default starting area, was an empty 32×32 hall.**

Recovered: the yard's and the crypt's tile grids lifted back out of the last
commit (same dimensions, so the grid transplants cleanly), and the tavern
rebuilt by `build-tavern.py`, which is what D-544 wrote it for.

⚠ **Their walls are left as TILES, not converted to pack meshes.** D-545 renders
seven wall families at full height, so tile walls are not a defect; and
re-running the converter is half of what caused this.

### Painting is a table, not twelve scripts

`paint-areas.py` maps a TILE KIND to a material per area, and everything else
follows. The mechanics are D-590's unchanged — blur then domain warp, six
materials in two masks, alpha binary.

⚠ **`patches` exists because a legend is not a surface.** The crypt is 89 tiles
of one kind, the yard 744, the mine 9,388 — a recipe driven only by the legend
paints those a single flat colour and the painter has bought nothing. A patch
throws a second material across the first in blobs: not where the grid says,
where nothing says.

⚠ **The patch threshold is taken as a QUANTILE of the noise, not guessed.** fbm
is normalised to 0..1 and is nowhere near uniform, so "> 0.7" was 8% cover on
one map and 41% on another. Taking the quantile makes the number on the recipe
mean what it says.

⚠ **Wear is derived from the area's own data** — transitions, facilities,
resource nodes, the spawn — because those are where a cast actually stands, and
that is the half a tile grid cannot express. Only two spots in the whole world
are named by hand.

⚠ **`round-wood` had to be repainted after looking at it.** The first recipe put
the ingested forest-floor photograph under the entire map; its mean colour is
(0.57, 0.53, 0.37), a dry olive-tan, so from above the wood read as a sand flat
with trees standing on it. Grass is the base and bare needle floor is a patch —
which is also what a wood is.

### Dressing, and who gets the last word on it

`dress-areas.py` scatters by layer: what, how many, on which tile kinds, how far
apart. Roughly one solid thing per forty square metres on a 100×100, plus
walk-through decoration on top. 2,800 objects across eleven areas.

⚠ **The minimum GAP is the load-bearing rule**, learned on Ashfold's copses: a
body is 60cm across and a canopy is two to three metres, so two solid things a
metre apart are a wall with a gap nobody can use.

⚠ **THE GUARD AND THE AUTHORITY CANNOT BE THE SAME CODE, so the authority gets
the last word.** The placer is Python and `unreachableTiles` is TypeScript, so
the placer can only approximate — it grows blockers by `BODY_RADIUS` and floods
tile centres. It caught gross pockets and then passed **eight areas the build
refused**. Rather than tighten the approximation a fifth time,
`prune-unreachable.ts` runs the real check and deletes scatter until the map is
whole: 196 objects removed across the world, one round each.

⚠ **It removes only placements marked `dressed`.** That flag is in the SCHEMA,
not a stray key, because zod strips what it does not know — a flag the editor
silently dropped on the next save would turn every scattered rock into a hand
placement and the next dressing run would double the map.

⚠ **A bug in the pruner, found by the build refusing one tile it claimed to have
fixed.** After the first round it looked up culprits by their index in the
FILTERED list and recorded them against the ORIGINAL array, so from round two
onwards it deleted a different asset from the one it had blamed. The only
symptom was one unreachable tile on the one map that needed two rounds. The
index now travels on the placement.

### ⚠ A test asserted something that had become wrong

`mr6-proving-ground` demanded a collision mask on every placed asset — written
when an empty mask could only mean a forgotten bake (D-584 shipped a town of
walk-through walls that way). Maps now carry deliberate walk-through
decoration, and a tuft of grass you cannot step past is worse than no tuft of
grass. `overrideCollision` is exactly the difference between a statement and an
oversight, which is what it was added for, so that is what the test checks now.

### Cost

24 masks, 8.9 MB on disk; a client fetches the two for the area it is in, at
most 1.4 MB for a 100×100. 137 environment meshes, 13 MB. ⚠ Unratified and
worth watching in play: whether ~500 scattered objects on a spoke is atmosphere
or clutter, and whether the dungeon's vast open middle wants dressing at all or
wants a different LAYOUT — that is a map decision, not a dressing one.

---

## D-593 — A keeper who can be silenced, and a larder that runs out

**2026-09-12.** Closes the two items MR2 was carrying: D-569's unwinnable
objective, and the constraint D-529 named and D-533 recorded as still unmet.

### The keeper existed in the wrong world

`silence-the-keeper` shipped `status: live` and named the keeper of the Hanged
Ferryman, who stands in the persistent world's tavern. `round-town` ran no
scripts and did not link there, so the target did not exist in the map the
round is played in. D-526 calls this objective the low-cast workhorse: an
antagonist dealt it could not win, and nothing in the build said so.

Ashfold has its own keeper now (`content/scripts/ashfold-keeper.lua`), and the
objective names him.

⚠ **He stands at the DOOR, not behind a bar, because there is no inside.**
Measured: every tile of the tavern's footprint fails `canStandAt` — D-584's
tavern is a solid mesh, a facade you walk past. The threshold is the better
place anyway: D-549 put the square where every route crosses, so a keeper on it
is a target the whole cast can see being defended, which is what the
objective's own notes ask for.

⚠ **The engine matches a kill by PUBLIC DESCRIPTOR, not by id**
(`npcsKilled.has(descriptor)`), so a rewording in either file silently makes
the objective unwinnable again. That is now a test and a build error rather
than a hope.

### ⚠ CI could not have caught this, and now can — for LIVE objectives only

`validate-content.ts` passed `npcDescriptors: null`, and D-569 said why: NPCs
are spawned by Lua and by DM events, so a build-time scan is partial, and
treating a partial scan as complete would reject every DM-spawned target.

That reasoning holds for a draft. **It does not hold for a live one:** the
round engine deals live objectives at random with nobody watching, so a live
objective has to be satisfiable out of shipped content or it is simply a way to
lose a round. Live `kill_npc` objectives are now checked against the descriptors
the shipped scripts spawn; drafts are not. Proven by reverting the objective to
its old target and watching the build refuse it.

### The town starts with a larder, and nothing refills it

D-529: *hiding in town beats the clock unless the storehouse runs out.* D-533
recorded the gap precisely — "nothing yet stocks the town with a starting
supply that then depletes" — and called it a content problem rather than a
systems one. It was both: **every route into a store went through somebody's
pack**, so there was no way to stock one at all. `grantItemToStore` is the
missing third owner (D-580) reaching the store directly.

⚠ **Two meals a head, and the number is the point.** Chosen against the clock
rather than by feel: a full belly takes about a day to empty (D-534) and a
round is two and a half days (D-527), so the cast eats comfortably through the
first day, thins through the second, and is out before the end — by which time
bread comes from grain, and grain is on the farm, which is outside. ⚠
Unratified, and the first thing to watch in play.

⚠ **Scaled by cast size**, because the same larder is a fortnight for three and
an afternoon for eight.

⚠ **One item per row, not one row of N.** Stores are taken from one thing at a
time and spoiling marks INDIVIDUAL items (D-580); a single stack of twelve
would go off all at once or not at all, which is a different mechanic from the
one that was built.

⚠ **It also hands the antagonist something to ruin from the first minute.**
Until now a round opened with nothing pooled, which made the best sabotage in
the game unavailable until the cast had done the work of stocking it
themselves.

### ⚠ Two tests that would have proved nothing

The stocking assertions were first appended to `mr6-stores`, where they ran
after a sibling that resets the round — so they measured an emptied larder, and
two of the three passed against it. They have their own fixture now. And the
keeper test's first draft walked the bot greedily along the axis with the
furthest to go, which stopped dead at (25, 22): the square's statue stands at
(25, 21), directly between the tavern door and everyone crossing the square. It
uses `move_to` now, which is the message a real player's click sends — a test
that reimplements pathfinding is testing its own pathfinding.

---

## D-594 — Enemies are content, and a creature is drawn as what its content says

**2026-09-12.** Asked for: the ability to define NPCs and enemies in the
creation tool — looks, assets, stats — on the grounds that "the asset packs I
have include enemies." They do: sixteen of them.

### ⚠ Every enemy in the game was being drawn as a random townsman

Roamers had stats and no appearance at all. The spawn passed
`appearanceSeed: rng.int(...)` and nothing else, so **"something man-shaped
that does not walk like a man" rendered as a man**, and had done since D-532.
Meanwhile the ingested dungeon pack held goblins, skeletons, ghosts and a rock
golem, untouched.

### The measurement that made this cheap

`Character_Goblin_Male.fbx` and its fifteen siblings are on the **Unreal
humanoid rig** — the same one the Sidekick characters use (D-555). So the
126-clip library retargets onto them with no new work: a goblin walks because a
knight already does. Had they been on a vendor rig of their own this would have
been a week, and the expensive half would have stayed invisible until somebody
watched a goblin slide across a floor.

### A character can BE a mesh

`CharacterDefSchema` gains `mesh` as the alternative to `parts`, refused if
both or neither are given. A pack ships people in two shapes and both are
legitimate: `modular-fantasy-hero` is 720 part files, the dungeon pack's people
are one rigged FBX each. Forcing the second through the first would mean
inventing a "whole body" slot and pretending an assembler ran.

⚠ Named from the PACK rather than copied into `assets/incoming/`, which builds
identically and requires a manual step — the thing D-555 made the pipeline to
avoid.

⚠ `source: 'mesh'` in the manifest, not `'defined'`. D-571 promises that a
character carrying a slot vocabulary can be re-dressed, and a finished pack
body cannot be. Reusing `defined` made a goblin claim to be dressable and broke
the test guarding exactly that promise — which is the test working.

### The wire field D-559 said was missing

D-559: *"which character an entity is drawn as is UNRESOLVED — picked from the
seed, which is deterministic and agreed across clients but arbitrary: nothing
connects the guard model to a guard. That needs a wire field."* `WireEntity`
gains `model`, and a roamer names one.

⚠ **Absent still means the seed**, which remains right for players who have not
been through creation, for corpses, and for the town watch — a guard is a
PERSON, and one drawn from the seed is a different townsman each time rather
than a uniform (D-552).

⚠ **A model the client cannot find falls back to the seed** rather than failing
to draw: an invisible enemy is worse than a wrong-looking one. ⚠ And because a
silent fallback is exactly the state this change existed to leave, the BUILD
refuses a roamer naming a character that does not exist.

⚠ **Height is on the CREATURE, not the character.** The art is authored at one
size — the pack's goblin is as tall as its knight — so the same body is a
different creature at different heights. It reaches the descriptor pipeline, so
a thing a player is told is towering is.

### The editor

"What it looks like" in the creature editor: a picker of every authored
character, a height, and a live preview of the built body playing its idle.

⚠ **The stage had to be un-hidden for it.** Round content was in the "no 3D
preview for rules" list, written when it was recipes and objectives — which are
rules. A creature's LOOK is the one thing on that screen you can only judge by
eye, which is why the parts and garment tabs have a stage. Recipes and
objectives still do not.

### ⚠ Three things caught by measuring after reading a render wrong — twice

1. **The packs ship no quadruped.** `scavenger-dog` is "a lean thing on four
   legs" and `crypt-crawler` "a low, many-legged thing": drawing them as a
   goblin and a skeleton is the mismatch that reads as broken art. They keep
   the seed, and their files say why — either the art or the prose has to give,
   and that is not a dressing decision.
2. ⚠ **A pale patch on the skeleton knight's chest was a PLAYER'S HEAD, and it
   took the stakeholder to say so.** It was visible in a screenshot — two dark
   eyes on a pale face — and it was explained away twice: first as flesh
   showing through a breastplate, then, after sampling the mesh's UVs and
   finding `#cab593`, as a ribcage. **The measurement was real and answered the
   wrong question.** It said what colours the skeleton's own mesh samples; the
   head was never part of that mesh. It was the creation tool's bare-head
   mannequin, left on the stage because `previewCreature` cleared only its own
   object — D-570's bug word for word, one editor later: "the stage kept a bare
   head from boot, in the one editor whose whole premise is looking."

   The lesson D-560 states is that reading a render is not measuring one. The
   corollary, which cost more here: **a measurement that confirms your reading
   is only worth what its question was.** "What colour does this mesh sample"
   cannot rule out a second object in front of it, and reaching for arithmetic
   made the wrong answer feel settled.

   ⚠ **And the atlas "finding" from that detour was wrong too, in the same
   way.** It said `Dungeons_Texture_01` and `_01_A` give identical histograms,
   so the letters must be colourways and switching to `preferredAtlas` was a
   harmless no-op. That was measured on ONE model — the skeleton knight, which
   is bone and grey under either. The goblin is not:

   ```
   goblin skin   _01    #91945d   olive green
                 _01_A  #999087   grey-beige
   ```

   The lettered cut DESATURATES this pack, and for one commit every goblin
   rendered pale. The build uses the plain `assetAtlas` again, with a
   definition's own `texture` as the override. **Sampling one mesh and
   generalising to sixteen is reading a render, one level up:** the arithmetic
   was real and the sample was not representative, which is the harder version
   of the same mistake and took a green goblin coming out grey to notice.
3. **`tormented-soul` is DROPPED.** Its skeleton is spelled differently enough
   to be its own rig variant, the clips retargeted onto it do not drive its
   bones, and D-555's shape tests caught it. A character that cannot walk must
   not ship. D-557's precedent: keep the machinery, drop the character.

### ⚠ What this does NOT do

**NPCs are still Lua-only.** `spawn_npc` takes a descriptor and no look, so the
Ashfold keeper is still drawn from a seed. Roamers came first because they are
content already and are most of what a player meets; giving a scripted NPC the
same field is small and is not done here. D-569's larger complaint — that NPCs
are not declared content at all — stands.

---

## D-595 — Every mesh in every pack can be found in the tool

**2026-09-12.** Asked for: "ensure all assets from all packs are available in
the creation tool, in the proper categories."

Measured first. **3,555 meshes across seven packs.** Three separate things were
stopping some of them from reaching the tool, and not one of them said so.

### ⚠ An entire pack was invisible, skipped by a bare `continue`

`allPacks()` required a folder called `fbx`. The `generic` pack keeps its
meshes in `Models/`, so `findDir` returned null and the loop skipped it —
**467 meshes, 454 of them placeable scenery, invisible to every tool in the
project** since the pack was ingested. No warning, no empty entry, nothing.

The mesh folder now falls back to the pack ROOT, because `meshPath` and
`partStems` both recurse: a pack works whatever its folder is called, and a
pack with genuinely no meshes reports none rather than disappearing.

### ⚠ Two functions disagreed about what a pack contains

`partStems` read only the TOP LEVEL of the mesh folder. `meshPath`, directly
beside it, recursed. So the vikings pack's 140 snow variants and its six
characters were catalogued — by tools that could find them — while `partStems`
reported them as not in the pack. Anything checking a catalogue against
`partStems` was checking against a smaller pack than the one on disk, which is
how a catalogue came to list 370 meshes out of a "233-mesh" pack.

`partStems` recurses now. The vikings pack went from 233 to 373.

### ⚠ A mesh with no kind appeared in NO tab

`kindOfMesh` returns null for anything its prefixes do not cover. That is right
for a CATALOGUE — D-561 chose it deliberately, better no entry than a guessed
one — and quietly fatal for a MENU: the tool filters by kind, so an
unclassified mesh could not be found, named or placed by anybody.

`meshShelf` is the menu's classifier and is **TOTAL**: every mesh lands
somewhere. It adds three shelves the catalogue has no use for —

  * `character` — a whole rigged person (D-594), not a prop to place
  * `body-part` — `Chr_*`, which has its own tab and catalogue (D-560)
  * `helper` — collision hulls, convex shells, LOD stubs and FX meshes

— and an **`unfiled`** shelf, which is shown in the tool as a tab.

⚠ **Unfiled is a real answer, not a failure state.** D-568 tried to file the
last few by matching English words and broke three meshes to fix three, because
"bolt" is a fastener as often as it is ammunition. The rule stands: a person
files them. This only makes sure they can see them. Four remain across all
seven packs, and all four are now on screen with a name field beside them.

⚠ **Helpers are checked FIRST, before any prefix.**
`SM_Bld_Base_Stairs_01_Collision` carries a real `Bld_` prefix, so classifying
by prefix alone offered 78 invisible physics boxes as buildings.

⚠ `kindOfMesh` is UNCHANGED. What a catalogue may claim and what a menu shows
are different questions, and the knights pack misspelling its own `Prop_`
prefix as `Prp_` on exactly one mesh is a fact about one pack rather than a
naming rule.

### The result

```
pack                  total  char-item  environment  pickup  character  body-part  helper  unfiled
bow-crossbow              6          4            1       0          0          0       0        1
dungeon-pack            830         73          684      36         16         16       4        1
fantasy-dungeons-map     57          0           57       0          0          0       0        0
generic                 467          0          454       0          1          0      12        0
knights                 328          8          320       0          0          0       0        0
modular-fantasy-hero   1494         54            0       0          0       1440       0        0
vikings                 373         28          342       0          0          0       1        2
TOTAL                  3555        167         1858      36         17       1456      17        4
```

`tools/test/pack-coverage.test.ts` asserts every mesh lands on a shelf, that
`generic` is among the packs found, that unfiled stays small, and that a
collision hull never reaches the scenery shelf. ⚠ It skips when
`assets/source/` is empty, which is every clean checkout — the packs are
licensed art and gitignored (D-555), so this checks the art that is present
rather than being a reason CI cannot run without it.

---

## D-596 — A scripted NPC has a face, and one place holds the stage

**2026-09-13.** Two things: the tavern keeper is drawn as an authored
character, and the creation tool stops leaving the last tab's model standing on
the stage.

### The keeper was a stranger with a fixed name

D-594 gave ROAMERS a look and stopped there. `spawn_npc` took a position, a
descriptor and a seed, so every scripted NPC was drawn from the seed — as a
random townsman. The one that matters is the tavern keeper: D-593 put him at
Ashfold's door because `silence-the-keeper` is live and D-526 calls it the
low-cast workhorse. The cast is asked to keep one particular man alive, and
he looked like a different stranger on every seed.

`spawn_npc` now takes an optional `character`, an id in
`content/characters/`. Ashfold's keeper and the Hanged Ferryman's both name
`ashfold-townsfolk`.

⚠ **`content/characters/` had never been loaded by a server.** It is read by
`build:characters` and by all three authoring tools, and by nothing that runs
a game. This is D-576 exactly — 720 authored part names that reached no player
because only the tools read them — and it is now the fourth directory found in
that position. A `model` the server cannot resolve is not a fault a renderer
can report: it falls back to the seed and draws a perfectly plausible
stranger. So the server loads the cast and **refuses an unknown id at spawn,
naming what exists**, and `validate:content` refuses the literal at build
time as well, because a scripted NPC spawns when its area first loads — which
in the round map is the moment somebody starts a round.

⚠ **Also authored and unread: the watch.** `ashfold-guard` exists, is built,
and its own note says it is the uniform for D-552's watchmen — and
`town-guard.json` named no character, so the guard was seed-drawn too. One
line of content.

⚠ **The look is optional and must stay so.** Almost every scripted NPC should
go on being a stranger; a gateway that invented an appearance for everything
would be authoring content nobody wrote. Asserted.

⚠ **`ashfold-townsfolk` is a placeholder for the keeper and says so in the
script.** He is the only authored human who is not in a helmet. A keeper of
his own is one file in the studio and one word in the Lua, and choosing his
parts is an art judgement, which is not mine (D-114).

⚠ **The face is behind the cast toggle.** `useImportedCast()` defaults to
`procedural` (D-559), so none of this is visible until Settings says
`imported`. That default is the stakeholder's to flip and the reason for it —
the imported cast is under evaluation, not shipped — has not changed.

### One mount, or the same bug a fourth time

Reported by the stakeholder: the render window "sometimes does not clear the
old model when you switch tool tabs and select a different model in a
different tab."

It did. Every preview added straight to the scene and removed its OWN object,
and there were two owners — `shown` and `creaturePreview` — so there were four
places to forget. This is the third and fourth sighting of one bug: D-570 in
the garment editor ("selecting a garment did not show it"), D-594's player
head floating inside every roamer, and now across tabs and across sections.

⚠ **Patching the call site is what let it come back twice.** Nothing is added
to the scene after boot any more. One `mount` group holds everything on the
stage and `clearStage()` empties it, so a new preview *cannot* forget to clear
the old one — there is nowhere else to put anything. The ground stays on the
scene: it is the floor, not something being judged.

⚠ **Clearing alone would be half a fix.** An empty stage after every tab
change is the same complaint in a politer form, so each tab records how to
show what it has selected. The caption is cleared too: an empty stage still
labelled `skeleton-knight` reads as a model that failed to draw.

⚠ **Two bugs found while wiring it, neither of which threw.** `creatureShown`
is documented as "what is on the stage, so re-rendering the form does not
reload it" and **nothing ever assigned it** except one stray line in
`createClass`, an editor away — so the guard never held and the form re-fetched
a body on every render, and the one write it did get was from a different
editor entirely. The guard also compared an optional `character` against a
`null`, so it could not have held anyway.

### ⚠ The guard that shipped as a no-op, caught by breaking it

The new `validate:content` check for script character ids passed a
deliberately misspelled id. The regex had been written with a literal
**backspace byte** where `\b` was meant — `0x08` followed by `character` —
which matches nothing, so the check ran on every build and found nothing,
forever. Nothing in a diff, a log, a typecheck or a test run shows this; it is
invisible in every terminal that renders the file.

The only reason it is not in the repo right now is the standing practice of
breaking each new guard on purpose before believing it. That practice has now
paid for itself twice in two sessions.

### Verified

`sim/test/mr9-npc-looks.test.ts`: the keeper arrives on the wire carrying the
character its script names, found by DESCRIPTOR rather than "the first NPC with
a model" (the watch now has one too, so the loose version would pass on a guard
and say nothing about the keeper); the descriptor is untouched by the look; an
unresolvable id is refused by name; and an NPC spawned without one still
carries no model. Proved by deliberate break: dropping `model` in the gateway
fails the first assertion and nothing else.

The stage is verified by **counting what is on it** in the browser, not by
looking at it — through six transitions (parts → environment → worn item →
parts → environment → round → core) the mount holds exactly one subject every
time, and the head, the arrow and the bow leave when they should.

---

## D-597 — The three things the map tools could not author

**2026-09-13.** Asked whether the tools exist to build the game's
infrastructure. Measured rather than answered from memory: all 22 content types
have a schema and a CI validator, and fourteen have an editor. Three gaps, all
closed here.

### ⚠ An area's own properties were unauthorable, and every default is quiet

The map editor edited what is IN an area and nothing ABOUT it. `outdoor`
defaults false, `zone` defaults settled, `lighting` defaults overcast,
`ambience` and `scripts` default empty — so a wilderness area drawn in the
editor and saved paid no night bonus (D-528), carried the settled zone's
hostility and corpse rules (D-206), and was silent (D-541). None of it visible
on the map, all of it hand-edited JSON.

⚠ **The defaults are NOT changed.** D-527 chose their direction deliberately:
forgetting `outdoor` on open ground is wrong and visible in play, while the
opposite default pays every cellar the night bonus and is wrong and invisible.
The fix is to make them askable, not to guess better.

They live in the panel that already held the live/test flag, because that panel
is already "what this file IS" and everything else is its contents. Lighting is
applied to the VIEW as well as the file: the editor renders through the game's
own lighting (D-543), so choosing `night` should look like night, or the
profile is a word in a form.

⚠ **Ambience and scripts are picked from a LIST, not typed.** A bed naming a
cue that does not exist fails CI, and an `effect` cue named as a bed would loop
a sword-hit forever — so the endpoint offers `ambience` cues only.

### ⚠ Ground materials could be painted with and never authored

Thirteen shipped; a fourteenth meant hand-writing JSON beside an image nothing
listed, in the one tool whose whole premise is that what you place is what you
get. The painter now edits the material it is painting with: name, texture,
repeat, tint, wash, walkable, notes.

⚠ **`tint` and `wash` are two controls because they are two jobs** (D-590) —
the tint stands in for art that is missing, the wash multiplies art that is
there, and one field doing both is what rendered mud at an albedo of 0.107 and
made the whole town read as bad lighting.

⚠ **The texture is chosen from what is on disk.** Nothing in CI can see under
`client/public/`, so the editor server is the only thing that can check it
exists — and a material naming a missing image renders as its tint, which looks
unfinished rather than wrong.

⚠ **A delete is refused by name while any map is painted with it.**
`groundMaterials` is the channel order for the masks (D-588): remove one an
area lists and every surface after it shifts a channel along. That is not an
error anywhere — the map simply comes back wearing the wrong ground.

### The map pipeline had no npm entries

`paint-areas.py`, `dress-areas.py`, `build-round-map.py`, `prune-unreachable`,
`why-unreachable`, `build-audio` and the ground-texture scripts are how all
twelve areas were painted and dressed, and none was reachable through
`npm run`. They are now `map:generate`, `map:walls`, `map:paint`, `map:dress`,
`map:dress-town`, `map:prune` and `map:why`, named so that `npm run` lists them
in the order they run.

### Verified

The area panel round-trips to disk — every control read back from Ashfold's own
file, and three fields written to `proving-ground` and confirmed in the diff.
Every material guard was broken on purpose before being believed: an absent
texture, an id/url mismatch, a colour that is not a colour, and a delete of
`grass` (refused, naming all eight maps it is painted into). A material was
created, validated by CI, and deleted, leaving a clean tree.

---

## D-598 — A person who stands somewhere is content, not code

**2026-09-13.** An NPC could only be born inside a Lua script. That made every
question about the world's cast a question about source code: `kill_npc`
objectives had to be checked against descriptors SCRAPED out of the Lua with a
regular expression and could only ever be half-checked (D-569), nothing could
list who was in the world, and putting a blacksmith in the square meant writing
a script.

`content/npcs/<id>.json` declares WHO — name, descriptor, what they look like
(D-596), an optional fixed seed. `AreaDef.npcs` declares WHERE. A script still
decides what they DO, and reaches one with `npc("<id>")`.

⚠ **The split is the one stations and nodes already use** (D-530, D-583): the
definition is content and the placement is map data, so the same keeper can be
stood in two taverns without his descriptor being written twice, and the map
editor is where you decide where he stands. A new `npc` tool places them, and
they draw as person-sized markers rather than floor plates — where somebody
stands is judged against the doorway they block and the crowd that has to get
past them, and a flat square answers neither.

⚠ **Behaviour stays Lua on purpose.** Greeting, counting the room and reacting
to a death are behaviour, and a form is a bad place to write behaviour.

⚠ **Spawning is IDEMPOTENT and runs at every round start.** A round must not be
the reason the next round has no keeper: `silence-the-keeper` is live and dealt
at random, so an antagonist who won it once would otherwise have deleted the
objective for everybody until somebody restarted the server. It matches on
`npcType`, never on the descriptor — that is prose somebody edits, and the
question being asked is "is this placement filled".

⚠ **`npcType` is server-side and never on the wire.** What a player learns about
somebody is the descriptor; an id beside it is a name the game hands out free.

### What this finally makes checkable

`kill_npc` objectives now compare against descriptors read from DOCUMENTS
rather than scraped from Lua. Four new refusals, each broken on purpose before
being believed: an area placing an id nothing declares (at server construction,
not at spawn — the round map first loads when somebody starts a round); a
script asking for somebody its own area does not place; an objective naming a
descriptor no declared NPC wears; and renaming a descriptor a live objective
targets, refused in the studio by name.

⚠ **The "nowhere to stand" check caught a live defect on its first run.** The
Hanged Ferryman's keeper stood at (27,14), which no body can occupy — so the
server had been silently moving him to the area's spawn on every load, in the
persistent world's default starting area. Measured: 695 standable tiles in that
tavern and his was not one of them. He is at (26,14).

### ⚠ Two tests were passing for a reason that was never true

Both said "the only other entity here is the one I am looking at". `mr4-gear`
took *the first entity that is not me* as the wearer, and `m3b-events` asserted
that after a rollback there were *no NPCs at all* in the tavern. Both held only
while the world was empty of anybody else, and both broke the moment the tavern
gained a keeper — on a man with no part in either test. They now name the
wearer by id and the warband by descriptor.

### ⚠ And one in the editor, found by counting rather than by looking

Placing a person put them in the file and drew nothing until a reload: the npc
tool did not rebuild the markers, exactly as the node tool one branch below it
does. Placed, saved and invisible is the class of bug the editor exists to
prevent, and one missing figure among three hundred objects is not something an
eye reports — so the editor's `counts()` hook now returns the markers actually
in the scene beside the placements in the file, and the two disagreeing is the
assertion. The same measurement caught the placement guard testing the legend's
`walkable` rather than `canStandAt`, which let somebody be stood inside the
palisade.

### Verified

`sim/test/mr9-declared-cast.test.ts`: somebody stands there with NO script host
running at all (every earlier NPC test had to start one, because the NPC did
not exist until Lua made it); a script reaches the same person rather than a
second copy; a killed NPC is back after the spawner runs again with a NEW entity
id; running it twice does not make two; and a bad placement refuses at
construction. Proved by deliberate break — removing the boot call fails three of
the five and nothing else. 956 tests pass; content validates over 144 files.

---

## D-599 — Every solid thing knows how tall it is

**2026-09-13.** D-581 recorded that "every asset uses a PLACEHOLDER mask: 0 of
1,402 has a drawn shape, so all fall back to a box of the measured footprint ×
a default 3m height (`size` is missing on all of them too)". Measured again
before touching anything: **1,402 catalogued environment assets, 0 carrying a
size.** The field was added to the schema by D-567 and written only for assets
drafted after it existed — which was none of them.

So `defaultMask` gave a barrel and a gatehouse the same height to walk into,
and the one number the schema's own comment says decides whether a thing is
walked over, under or into was the constant `3`.

`name:environment` already measured every mesh — the loop needs the size to
decide the pack's unit convention — and threw the number away for anything
already catalogued. It now backfills it.

⚠ **ONLY `size`.** `solid`, `opaque`, `footprint` and the name may all have been
corrected by a person since they were drafted, and re-deriving them from the
mesh would silently undo that work — the same reason `name:assets` skips a mesh
somebody has already catalogued (D-568). A backfill fills a hole; it does not
re-run a decision.

⚠ **Rounded to the millimetre.** The raw float is seventeen digits, which makes
every re-run a diff against itself, and a diff that is always dirty is one
nobody reads. A millimetre is finer than anything `STEP_UP` (0.35m) can act on.

### What the real heights change, measured rather than assumed

Median solid height **2.13m**. 892 assets were being drawn too tall and 520 too
short.

- **67 solid assets measure 0.35m or less** and therefore stop blocking
  movement: `blocks` is `surfaceHeight > feetZ + STEP_UP`. Pebbles, roof caps,
  a saw rail. Correct — they are things you walk over.
- **94 opaque assets measure between 1.2m and 1.6m**, and those stop blocking
  SIGHT. ⚠ That band exists because `SIGHT_HEIGHT` (which decides `opaque`) is
  1.2 and `EYE_HEIGHT` (which tests it) is 1.6. It is coherent — `opaque` means
  "stops an eye at its own height", and the mask's top does the rest — but it
  is worth knowing the two constants are not the same number.
- **Six of those 94 are actually placed**: a log, a gravestone, a torchstick,
  two stalagmites and a small mushroom. Every one of them used to block line of
  sight at eye height because its box was 3m tall. This is a correction to
  D-217: a murder behind a gravestone was unwitnessed, and is not any more.

Nothing got *harder* to walk through: a box that grew taller still blocks a
walker exactly as a 3m one did.

### ⚠ 727 placements drifted, and the only remedy CI named was "by hand"

A placement carries a COPY of its asset's mask (D-567) so an area is
self-describing. The cost is drift, which `placedAssetDrift` reports and CI
fails on — and the message said "re-place it", once per placement. Filling one
field in the catalogue produced 727 of them.

`npm run map:rebake` re-bakes them. ⚠ **It never touches a placement marked
`overrideCollision`** — that flag is the other half of the stakeholder's ruling
(per-asset, overridable per placement) and the only thing distinguishing a copy
that should track the catalogue from a doorway somebody deliberately knocked a
gap in.

⚠ **Proved by removing the guard rather than by reading it: 609 hand-authored
masks would have been overwritten, including all four of Ashfold's castle gate
arches.** Sealing those turns the town's gates into walls — a map that still
validates, still renders, and has no way in.

⚠ **It is deliberately NOT part of `validate:content`.** A build that repaired
its own inputs would make the drift check unfalsifiable, including in the case
where the catalogue is what changed by mistake.

### ⚠ The verification lied first, and by one character

Checking that no override had moved, comparing the JSON *text* against `HEAD`
reported four changes — all four gates. They were `-2.0` against `-2`: the tool
rewrites the document through Node's serialiser, and JavaScript has no
int/float distinction. Compared by VALUE, zero of 2,208 overrides differ.
Comparing text answers a question about formatting when the question was about
volumes, and it answered it alarmingly.

### Exposed, not fixed

- **The `generic` pack drafted 461 environment assets** (and one in
  bow-crossbow). That pack was invisible to every tool until D-595 fixed
  `allPacks()`, so this is the first time `name:environment` has ever seen it.
  Machine-drafted names, tagged `draft`.
- ⚠ **Two dungeon-pack meshes are catalogued as solid 24×24 scenery and are
  particle emitters**: `SM_Prop_Candle_Chandelier_02_Particle` measures 95.5m
  and `SM_Prop_Candle_Stand_01_Particle` 32.5m. Neither is placed anywhere.
  They were miscatalogued long before this and the measurement is what made
  them visible. Left for a person, per D-595's ruling that English is not a
  classifier and the oddities are filed by hand.
- **Skydomes, background mountains and cloud rings measure 30–185m.** Correct,
  and a reminder that the palette contains set dressing nobody should place as
  collidable.
- ⚠ **No asset has a DRAWN mask, and this does not change that.** A gatehouse
  still blocks a solid rectangle rather than leaving its arch open, and nothing
  can be walked under. That is authoring with eyes on it, not arithmetic — the
  four gates in Ashfold are what it looks like when somebody does it.

### Verified

`tools/test/environment-assets.test.ts` gains three assertions: every solid
asset knows its height, no solid asset is zero-height (a box with top 0 blocks
nothing and would be a ghost the reachability flood still counts), and heights
are rounded. Proved by deliberate break — deleting one `size` fails the first
and nothing else. 959 tests pass; content validates over 146 files; a re-run of
the re-bake reports nothing left to do.

---

## D-607 — The mode nobody could reach

**Status:** implemented
**Supersedes:** the `ROUND_MODE` default in D-521's configuration (off → on)

### The report

> "I can't play a proper round at the moment after logging in. Make this
> possible. Also, when in the lobby, add the option to add bots while waiting
> in game."

### What was actually wrong

Nothing in the round was broken. The round was **off**.

`ROUND_MODE` defaulted to unset, so `npm run dev:server` booted the persistent
world — respawn, death debt, enduring recognition, no clock, no antagonist, no
lobby. D-521 moved the shipping target to the Round in August and the default
never followed it. A server that boots the mode that is not being shipped is a
server whose only symptom is that nothing happens, and the only way to find
that out is to log in and wait.

⚠ **The default area was a second switch that could disagree with the first.**
`DEFAULT_AREA_ID` defaulted to `hanged-ferryman` independently of the mode, so
turning round mode on by itself would have started the cast in the persistent
world's tavern. It now FOLLOWS the mode — `round-town` in a round — with the
env var still overriding both. Two independent settings that have to agree fail
silently, and this pair fails in the least legible way there is: a player
standing in a room the round never reaches.

### Three bots are a command in another terminal, which is not a feature

The cast floor is three (D-522). The go/no-go gate is one person playing a
round and judging how it feels (D-114, BUILD_PLAN). D-540 built bots that can
fill a round and `npm run bots` to launch them — and left the distance between
"logged in" and "playing" as a second terminal and a command that is invisible
from inside the game. **A mode that cannot be started by the person it is for
is not shipped.**

The lobby panel now offers `+1`, `fill the cast` and `send home`.

⚠ **They are ORDINARY CLIENTS, and that is load-bearing rather than
convenient.** Each one opens a real WebSocket to the server's own port,
registers, creates a character and is dealt a role by the same code that deals
one to a person — so a bot can be the antagonist, and D-540's property that a
bot round is evidence about the GAME rather than about the harness survives. An
in-process shortcut past the gateway would have satisfied every assertion about
cast size while quietly making every bot round test the wrong thing.

⚠ **The count is public; which ones are bots is not.** `round_state` carries
how many of the cast are bots and never which. A bot can be dealt the objective
exactly as a player can, and a round whose antagonist can be read off a HUD is
not a round (D-521, D-217).

⚠ **Off in production, and refused OUT LOUD.** The verb registers accounts and
creates characters on demand; exposed publicly it is an account-creation hole
wearing a lobby button. `ALLOW_BOTS` gates it, the client only draws the
controls when the server says it allows them, and a server that forbids them
answers `not_allowed` rather than ignoring the message — a control the client
draws and the server silently drops is indistinguishable from a broken one.

### ⚠ A round could not be played TWICE, and no test could have seen it

Everything MR1 asserts is about one round. Two things crossed the reset and
both of them made the next round unplayable:

- **The dead stayed dead.** Round death is not permadeath (D-522) and `respawn`
  is refused outright while a round runs — correctly. Nothing stood anybody up
  at the reset, so a killed player spent every subsequent round as a ghost.
  That presents as a bug in *death*, which is where anybody would look, and it
  is a missing line in *reset*.
- **The living stood where they stopped.** D-536's opening truce says "you have
  all woken in the same place". From the second round on that was simply false:
  the cast opened scattered across six areas, some of them underground, with a
  minute of enforced peace to spend walking back to each other.

`gatherForNewRound` stands everybody up at the round's opening point. ⚠ The
living are moved by the same despawn-and-respawn the dead are, rather than by a
quiet position edit — a living character moved without leaving would leave a
copy of themselves standing in the area they came from for every observer still
in it.

### ⚠ The reset was losing its lobby broadcast, two runs in three

`onTick` is async on an interval, so a later tick begins while an earlier one
is still inside an await. The reset is a long chain of them and the engine's
phase flips to `lobby` PART WAY THROUGH — so a tick landing mid-reset saw a
lobby with a full cast and started the next round before the last one had
finished clearing. The lobby state was never broadcast at all: the HUD went
from "the round is over" straight to a running clock.

That was invisible while the lobby had nothing in it. It is not invisible now:
the lobby is where the bot controls live, so between rounds the panel would
never have appeared. The reset is now atomic with respect to the tick.

### What was tried and NARROWED

The first cut also relocated a character on `enter_world` whenever round mode
was on, on the reasoning that the area saved on their record is a fact about a
round that no longer exists. **Two suites rightly refused it**: `mr2-roamers`
and `mr2-dungeon` place a character somewhere deliberately and assert what they
can see from there, and the relocation silently moved one of them out of the
settled town into the wilderness — where it saw eleven roamers and reported
that the town is not a refuge.

They were right and the change was wrong. The server moving people around
unasked is its own class of bug. What survives is one narrow case that cannot
misfire: **a round never begins in an `endgame` area.** An endgame tier carries
involuntary permadeath (D-513) and D-523 is explicit that a round death must
never cost a character levelled across fifty rounds, so logging out in the
crypt and logging in to a round would quietly convert every round death into a
real one.

### ⚠ And then the server EXITED the instant a round began

With the mode finally on, the first real round killed the process:

```
error: column "owner_store_id" of relation "items" does not exist
  at PgStore.grantItemToStore
  at GameServer.stockCommonStores
  at GameServer.startRound
```

`grantItemToStore` is the one route into a store that does not go through
somebody's pack — D-593's larder, the thing that "was a SYSTEMS gap as well as
a content one" — and it named a column that has never existed. The schema says
`owner_store`; every other query in the file says `owner_store`; this one
insert said `owner_store_id`.

⚠ **All 1015 tests passed against it.** Every sim test uses `MemoryStore`,
which has no columns to disagree about. This is the third time this repo has
been bitten by the fake being more permissive than the real store, and D-572
wrote the warning down in as many words: *"a column added to the type but not
to the INSERT passes every in-memory test and the fake being more permissive
than the real one has cost a login before."*

⚠ **The reason nobody caught it is worse than the bug.** `persistence.pg` and
`stores.pg` are `skipIf(!DATABASE_URL)`. The server reads `.env`; **vitest did
not** — so on a developer machine the only two suites standing between the code
and the real schema were skipped every single run, and vitest prints a skipped
file in **green**. `vitest.config.ts` now reads `.env`, which took the skip
count from 11 to 1 and immediately turned up a second genuine failure: D-592's
dressing pass put a twisted tree with a 3×3 collision volume five tiles from
the broken yard's spawn, and the M0 persistence test walks four tiles east.
That test now MEASURES how far there is room for. ⚠ It would have failed CI on
the next push.

### ⚠ One rejected query took the whole world down with it

The tick driver was `setInterval(() => void this.onTick(), …)`. `void`
discards the promise, so anything that rejected inside a tick became an
unhandled rejection and Node ended the process.

That is the wrong trade for what this server holds — a round with no respawn
and a cast who cannot rejoin what has ended. A tick now fails **loudly and
alone**: logged with its stack, counted, and throttled by message (1st, 10th,
100th…, because the same fault fires ten times a second and ten thousand
identical lines is a log nobody reads). ⚠ It is caught, never quietly: a tick
that threw has by definition left something half-done, and a server that hides
that is worse than one that stops. What it must not do is take the world with
it.

### ⚠ A lone player waited five seconds for the lobby to exist

A waiting lobby broadcast every fifty ticks. Somebody who had just logged in
therefore stood in the town with no HUD at all, which is indistinguishable from
a server that has not noticed them — and it is worse now than it was, because
the lobby is where the controls for filling the cast live, so the first thing a
lone player needs was the last thing to appear. `round_state` is now sent on
arrival, beside the role message D-579 already sent there.

### Verified

- `sim/test/stores.pg.test.ts` gains the round-opening path — stocking a store
  with no pack involved, reading it back through `getItem`, and taking it out
  again. Proved by deliberate break: restoring `owner_store_id` fails it with
  the exact error that killed the server.
- `sim/test/mr10-lobby-bots.test.ts` — bots arrive over the wire, the cast
  reaches three, the round starts, they can be sent home, and a server that
  forbids them says so. Proved by deliberate break: removing the refusal fails
  the third case.
- `sim/test/mr10-second-round.test.ts` — kills a member of the cast, lets the
  round resolve and reset, and asserts the fallen stand up, everyone is at the
  opening point, and a second round begins. Proved by deliberate break:
  removing `gatherForNewRound` fails on "the dead are standing again".
- `client/test/round-hud.test.ts` — the panel is never offered during a running
  round or on a server that forbids bots, the note counts bots and names none,
  and the buttons ask for the shortfall.

⚠ **Three defects here were found by RUNNING rather than by reading, and two of
them were first reported by the test as something else entirely.** A protocol
violation (`entity_left` for an entity the receiving mirror had already
dropped) is silent in a real client and only a headless bot flags it. A kill
loop budgeted in attempts rather than in outcome reported "nobody died" when
what had happened was "the watch killed the attacker first" — the most
misleading sentence it could have printed. And the lost lobby broadcast
presented as a test timing out on a phase, not as a race.

1025 tests pass, 1 skipped — ten of the eleven skips were the Postgres
suites, which now run locally. Content validates over 146 files. ⚠ `mr2-gathering`
remains intermittent under full-suite load and passes on its own.

---

## D-608 — A round opens in the tavern, and it opens you whole

**Status:** implemented
**Supersedes:** D-607's round-mode default area (`round-town` → `hanged-ferryman`),
and its ruling that an arrival keeps the position on its record

### The report

> "Upon joining a game, all players should be placed in the tavern. At the end
> of a round, all players should be placed in a tavern. At the moment, when I
> log in to an existing character, I am dead, and in the wrong location. A
> round should be a complete reset of player statuses and position."

### ⚠ Two defects, and only one of them looked like a bug

Measured against the stakeholder's own characters in the dev database:

| character | area | hp |
|---|---|---|
| James | `proving-ground` | **0** / 20 |
| Jameson | `round-south` | **0** / 20 |
| Jayyyyy | `round-south` | **7** / 20 |
| Aldous Vane | `broken-yard` | **2** / 20 |

**The wrong room is visible immediately.** The area saved on a record is a fact
about a round that no longer exists, and honouring it drops a character into
the proving ground while the round is using a map they cannot reach.

**The health was the "I am dead" half, and it was silent.** Entry restored
health with `if (character.hp <= 0)` — so a character stored at **7 of 20**,
which is the normal state of anybody who logged out after a bad night, walked
into the next round nearly dead and was killed by the first thing that touched
them. That is not a bug in death. It is a reset that only ever covered one of
its cases, and the symptom it produces is a report about death.

`wipeRoundStatus` is now one place holding everything a round resets about a
*person* — health, mana, wounds, hunger and thirst — called both on arrival and
at the reset between rounds. ⚠ Needs included, or a round opens with somebody
already starving on a clock belonging to a round that finished (D-526).

### The tavern, not the square

D-607 started rounds at `round-town`, which is the open square. D-549 said the
round starts at the tavern in the middle of town and D-604 made the Hanged
Ferryman that tavern — one door off the square. It is also the room D-536's
opening truce actually describes: *"you have all woken in the same place."* The
default is now `hanged-ferryman` in both modes, so there is one answer to
"where does a character begin" rather than two that can disagree.

### ⚠ The one carve-out: rejoining a round you are already in

A player reconnecting to a running round they are in the cast of is **not**
moved and **not** reset. Two things depend on it. Moving them would undo
whatever they had walked into, and for the antagonist it would be a public
relocation in the middle of their own plan (D-579). More seriously, a "complete
reset" applied to a reconnecting corpse would be a **respawn button made of
wifi** — and the dead staying down until the round ends is the mode's central
rule (D-521, D-522).

### ⚠ What the tests objected to, and why the objection was answered rather than overruled

D-607 tried this same relocation and backed it out because two suites refused
it. Nine fixtures across six files stand a character in a chosen area with
`saveCharacterPosition` and assert what they can see from there — a body in the
wilderness at dusk, at the well, on the gate road. They are not testing
arrival, and they are right that the server moving people around unasked is its
own class of bug.

So the rule ships with `placeArrivals`, default true, and those six suites say
out loud that they are asking a different question. A flag that names which
question a fixture is asking is honest; quietly weakening the rule so the
fixtures pass would not have been.

### ⚠ And a round the players had all left ran on with nobody in it

`abandoned` has been a documented outcome since D-521 — *"too few players
remained connected to continue"* — and **nothing ever produced one** except the
DM's restart button. A round whose cast had all disconnected kept counting down
its full twenty-five minutes, so the next person to log in did not arrive in a
lobby: they arrived as a latecomer in a round that could not be won, with the
bot controls hidden **because the controls are a lobby thing**. A dead end with
no way out from inside the game, and the exact one this work exists to remove.

A round below the minimum cast for `ROUND_THIN_CAST_TICKS` (30s, unratified) is
now abandoned. ⚠ It waits rather than firing on the first missing player —
ending a round on a flicker of somebody's wifi is a worse failure than the one
it fixes — and it counts who is CONNECTED, never who is alive, because dying is
how a round is supposed to shrink.

### Verified

- `sim/test/mr10-second-round.test.ts` gains the reported case, planted exactly:
  a character saved out in `round-south` at 3 hit points arrives in the tavern
  at full health, sated, unwounded. Proved by two deliberate breaks — restoring
  `if (character.hp <= 0)` fails on *"whole, not merely alive: expected 3 to be
  20"*, and never moving arrivals fails on *"placed in the tavern"*.
- The same file asserts the carve-out: somebody rejoining a running round they
  are in is left exactly where they were.
- `sim/test/mr10-lobby-bots.test.ts` gains the deserted round. Proved by
  deliberate break: removing the check times out on *"the round gives up"*.
- Live, against real Postgres: the failing state replanted on a throwaway
  character now logs in to `hanged-ferryman` at 20/20 in a lobby reading 1/3;
  two bots later the round runs with all three standing in the tavern together.

1029 tests pass, 1 skipped — every file green, including `mr2-gathering`.
Content validates over 146 files.

---

## D-609 — Chairs with their backs to the table, and buttons nobody could press

**Status:** implemented
**Supersedes:** D-605's ruling that a seat's `rotation` is the sitter's facing

### The report

> "The chairs are backwards in the tavern, and the buttons to fill the cast are
> not working."

Two unrelated bugs, and both were invisible to a green test suite for the same
underlying reason: each test asserted the code against its own convention
rather than against the thing a person would see.

### ⚠ The chair's backrest is at −Z, and that is measured

D-605 stored a seat's `rotation` as **the direction a sitter looks** and drew
the mesh at that same angle. Measuring the pack's chair
(`generic/sm-gen-prop-chair-01`) settles what that produces: of the vertices
above seat height, the centroid sits at **z = −0.228** against a model centre of
0 — the backrest is at −Z, the seat opens toward +Z. Map +y is south and the
renderer places map y on three's z, so a chair drawn at yaw 0 has its back to
the **north** and seats somebody looking **south**.

Written as "the sitter looks north", then, the mesh was drawn exactly half a
turn wrong — which around a table means all 32 chairs had their **backs to the
table**.

`rotation` now means what it means for the other ~2,800 placed objects in the
world: **which way the model points**. The sitter's facing is derived from it by
`sitterFacingFor()`, and the half turn is documented where the measurement is.
⚠ That is the right home for it: the editor, `world-assets` and the drift
checker all already read `rotation` as mesh yaw, so a field that meant the
opposite for 32 objects was a trap, not a convention.

### ⚠ Why the sitting suite could not see it

`mr9-sitting` asserted `facing === directionFromDegrees(seat.rotation)` — the
server against the convention. That stays true **whichever way round the
convention is**. It can tell you the server is consistent; it cannot tell you
the convention disagrees with the art.

The new assertion checks the convention against the **room**: every chair is
drawn up to a `table` tile, so the person sitting in it must end up looking at
one. Turn either the mesh or the sitter alone and it fails on all 32; turn both
and it is genuinely still a chair at a table. Proved by deliberate break.

### ⚠ The buttons were unclickable, and looked perfect

`#round-hud` is `pointer-events: none` — correctly. It floats over the world and
must not swallow a click meant for the ground beneath it. Everything in it had
always been read-only, so nothing had ever noticed; the first controls put
inside it (D-607) inherited the rule and could not be reached. Hit-testing in
the browser: a click at each button's own centre landed on `#overlay`.

They were styled, enabled and hovering. There is no visual difference between a
button that does nothing and a button that is not receiving the click.

⚠ **And the HUD test could not see it either, for a reason worth keeping.** It
calls the handler on a fake element. **Dispatching a handler proves the
handler; it says nothing about whether a person can reach it.** The guard added
here asserts the opt-in against the stylesheet — and asserts that `#round-hud`
really is click-through, so it cannot quietly become a test of nothing — while
checking that the clock and the objective card stay click-through, because
making those solid would put a dead rectangle over the world for
twenty-five minutes.

⚠ **Verified by hit-testing, not by eye.** `document.elementFromPoint` at each
button's centre returns the button; with the opt-in removed it returns
`#overlay`; a click dispatched at those coordinates reaches the handler.
⚠ The OS-level mouse could not be used — the app window would not draw while
minimized — so this is the full path minus the physical click.

### Verified

1032 tests pass, 1 skipped. Content validates over 146 files. Both fixes proved
by deliberate break, each failing on the assertion that names the defect.

---

## D-610 — Four reports, and the one nobody could have reported

**Status:** implemented

### 1. The companions talked over everybody

Measured rather than estimated: the only speech bots had was a **6% roll per
decision**, and a decision is every **160ms** — about one line every 2.7
seconds each, so three companions produced a line roughly every second. In a
mode whose entire point is people talking to each other (D-521), the
companions were burying the conversation.

Now: **at most one line per bot per thirty seconds**, **never with nobody in
earshot** (10m, the server's own `say` range), and what it says is **read off
the agent's actual state** — the need it is answering, the node it is stood at,
the spoke it is walking to. ⚠ That last part is the point rather than flavour:
a companion that announces where it is going is the only way somebody playing
alongside bots can form a picture of the round.

⚠ **An antagonist says the same things as everybody else**, drawn from the same
cover work, and nothing in the speech code reads the objective. D-540 is
explicit that the deception must be behavioural; chatter that changed once a
bot was dealt the role would be a tell learnable in one round.

⚠ **The first version of the throttle test passed with the throttle deleted.**
Twice. It counted lines in a window, and the "do not repeat yourself" check was
quietly doing the work — then, once that was fixed, the talker was a *gatherer*
who walked to the mine within a second and had nobody in earshot, so the test
was measuring "the bot left the room". It now keeps an idler in the room and
asserts the **gap between consecutive lines**. With the throttle removed it
fails with 55 lines at ~31ms apart.

### 2. "I tried to attack a bot and nothing happened"

The server was answering every time — *out of reach*, *you have swung all you
can this round*, *not now, the day has not started*. **`#status-msg` lives
inside the login overlay**, which is hidden the moment you enter play, so every
in-world refusal was written into an invisible element.

⚠ An action that is refused must LOOK different from an action that was never
sent. In-world refusals now go to the chat log; auth and creation errors still
go to the overlay, where the player is actually looking.

### 3. A door undressed you

`worn` (D-554, D-571, D-578) lives on the **entity**, and a transition despawns
one entity and spawns another — carrying `facing`, `ghost` and `presentation`
across but not this. ⚠ The line above it reads *"the hood survives the door"*,
so the question had been asked once and never revisited when equipment arrived
three decisions later. ⚠ `publishWorn` could not repair it either: it compares
against the previous value and a fresh entity has none, so the wearer simply
stood there undressed until the next time they changed kit. Fixed for doors and
for the round reset, which despawns the same way.

### 4. ⚠ "The bots seem to be duplicating" — they were not, and the real bug was worse

Measured: the cast stayed at **three** every round. What grew was the **town
watch** — four more guards each round, never removed: 17 NPCs became 41 over
four rounds.

`despawnRoamers()` carefully **skips** guards in its loop, because the watch is
not a night thing (D-552) — and then ended with `this.roamers.clear()`, which
threw away the handles to the very guards it had just spared. Two consequences,
and **only one of them is visible**:

- `despawnGuards` then found nothing to stand down, so every round left its
  watch behind and spawned four more; and
- ⚠ **`witnessCrime` walks that same map, so the watch went BLIND.** Every
  watchman on the map became scenery — still standing there, still drawn,
  incapable of seeing a murder committed in front of them. D-552's whole
  mechanic, and D-217's witness invariant with it, silently dead.

⚠ **And it fired at every DAWN, not only at a reset (D-551) — so the watch was
blind from the first morning of the very first round.** Nothing errors, nothing
looks wrong, and the only symptom is a town that is quietly lawless. Reported
as cosmetic duplication; the duplication was the half you could see.

Both halves are now tested: the watch is the **same size** every round
(asserted as equality across rounds, not against a ceiling — a cap would pass
while the leak was merely slower, and the number is unratified), and it still
**witnesses a killing after a night has passed**. Reinstating the `clear()`
fails both, the second with *"the watch is still watching after the sun came
up: expected false to be true"*.

### ⚠ Two tests that were asserting the wrong thing

- `client/test/imported-cast.test.ts` hard-coded the clip name
  `bow-combat-idle`, and broke the moment that row was legitimately re-pointed
  in the creation tool. A valid authoring change failed the build with a
  message about a clip name (D-110: content is data). It now reads the value
  from content and asserts the **layering** — the combat set wins, and its idle
  is not the rig's fall-through.
- `sim/test/mr1-round.test.ts` staged its murder in the **open square**, which
  is where the watch walks. Once the watch was repaired it began arresting the
  murderer partway through four hundred swings; both innocents died, the round
  resolved `cast_wiped`, and the next assertion found the round already over.
  ⚠ That is the watch being **correct**. What was wrong is a test of the
  round's rules staging its fixture in front of a mechanic it is not testing —
  moved to the tavern, which is equally settled and has no guards.

### Verified

1037 tests pass, 1 skipped, every file green. Content validates over 147 files.
Every fix proved by deliberate break, each failing on the assertion that names
the defect.

---

## D-611 — Three UI faults, all of them one class name too few

**Status:** implemented

### 1. Every pre-game screen was pinned to the right edge

Measured: the login card sat at **x=968, centre 1118** in a 1280 viewport —
478px right of centre, and squeezed from its intended 340px to 300px. The
overlay around it was a perfectly good centred flexbox with one child.

There are **two `.panel` rules**. The first, at the top of the file, is the
centred card the login screen, the character wizard and the level-up screen are
all built from. The second, three hundred lines later, is the in-game side
panel: `position: absolute; top: 64px; right: 12px`. Same class, later rule, so
it won — for all four users of the class, including two that live inside the
centred overlay.

⚠ **Exactly D-576's shape**: two surfaces sharing one class vocabulary, where
the one that got there second silently redefines the first. The in-game panels
are now `.dock`. The card measures dead centre (640, 360) and the wizard's wide
variant centres at 720px.

### 2. Two pairs of elements were drawn on top of each other

Measured with real content in both:

- **`#round-bar` ∩ `#target-frame` = 264×30px.** Both declared `top: 12px;
  left: 50%`. ⚠ The top centre is a **column owned by the round** — clock, then
  the objective card, then the lobby controls — and its height changes with
  what is showing, so nothing else can share that space without moving whenever
  the round does. The target frame goes top-left, which is empty.
- **`#dials` ∩ `#btn-settings` = 77×25px.** Both `right: 12px` near the top.
  The right column now reads compass-and-clock at the edge, the settings button
  to their left, and everything that *opens* below both — which also fixes a
  132×12 clip of the compass by any docked panel, since `.dock` opened at
  `top: 64px` and the dials reach to y=76.

After: **no overlap between any pair of HUD elements**, measured with every one
of them visible and filled.

### 3. Talk and what you notice were one scrollback

⚠ A line of dialogue could be pushed off the top by four refusals and a change
in the weather — in a mode whose entire point is people talking to each other
(D-521). Two logs now, stacked in the left column with captions: **what you
notice** (narration, the world's answers, refusals, sounds carried through
walls, documents) and **talk** (speech and its impression). They scroll
independently, so a busy minute of events cannot bury a sentence.

⚠ Every log style was keyed on `#chat-log`, so styling had to move to a `.log`
class shared by both — a rule left naming `#chat-log` would have left the new
panel unstyled, which is D-576's failure repeated inside the fix for it. The
test asserts no `#chat-log .` selector survives.

⚠ Also fixed here: the log was **396px wide, not 460px**. The hotbar starts at
x=412 and the log ran to x=472, so the last sixty pixels of every line sat
underneath it.

### Verified

`client/test/hud-layout.test.ts` pins all five facts. ⚠ It is honest about what
a source assertion can prove: a stylesheet cannot be laid out in node, so what
is checked is the **anchor each element declares**, not the box it occupies —
the boxes were measured in the browser, which is the only place they exist.
Reinstating all four original mistakes fails five of the six tests.

1043 tests pass, 1 skipped, every file green.

---

## D-612 — Two columns, a world clock on every line, and the combat nobody could see

**Status:** implemented

### The logs sit abreast, and they are wide enough to read

Stacked, each log was a letterbox. Side by side needs width, and the bottom
strip has none left — hotbar at x 412-868, vitals at 1024-1268, the work bar
centred at 510-770. So the pair moved **up**, clear of all three, at 620px:
two columns of 306px each, which also clears the craft panel's left edge at
x=646 when it is open. Measured: no overlap between any pair of HUD elements.

### ⚠ The stamp is the ROUND's clock, not the wall clock

A round runs a game hour every twenty-five seconds (D-527), so a real timestamp
would read the same minute for an entire round and tell nobody anything. What
places an event for a player is the hour the WORLD was at — *"it happened just
before dusk"* is a thing two people can argue about; *"14:52:03"* is not.

⚠ Minutes are interpolated from how long the current hour has been running, the
same way the dial's minute hand is. Stamping whole hours would give twenty-five
seconds of identical stamps, which reads as a frozen log.

### ⚠ Both logs empty when a round resets

Not tidiness. D-525 wipes recognition precisely so the cast meets as strangers
every round, and a scrollback still holding last round's accusations,
confessions and dying words hands back exactly what that ruling took away. It
is also the one piece of round state a player can re-read at leisure.

⚠ Keyed on the TRANSITION into lobby, not on the phase being lobby: lobby state
is broadcast every fifty ticks, so clearing on the value would wipe the log
five times a second while people stood around waiting — including anything they
had just said to each other.

### ⚠ Combat animations: the world code was picking a cast

`playAttack` opened with `if (!attacker || !(attacker.visual instanceof
CharacterVisual)) return;`. `CharacterVisual` is the **procedural** cast;
anybody rendered by `ImportedVisual` — which is now everybody who made a
character through creation (D-574) — returned before the animation. And before
the sound, which is below that line.

`ImportedVisual.playAttack` has been a real implementation since D-559, not a
stub. The call simply never reached it.

Five sites, all the same mistake, each switching something off for half the
cast: **`playAttack`** (the swing), **`entity_combat`** (the entire readiness
layer — sheathe, draw, guard stance), **`voiceCue`** (a modelled character took
a blow in silence), **`entity_lootable`** (a modelled corpse never drew the
pack that says it is worth searching), and the **carried body** (which dragged
along the floor instead of riding at the shoulder). `pendingBolts` was typed to
the procedural cast too, which stopped a modelled caster's bolt.

⚠ **This was found, fixed and written down once already.** D-571 records
`entity_worn` doing exactly this, and the comment recording it sits fifteen
lines above two of the five. A rule that must be remembered at each call site
is not a rule — there is now one `isPerson()` predicate, and a test that fails
if any site narrows to a single cast.

### ⚠ Two intermittents, both made worse by a correct change, both now fixed

- `mr3-bots` waited until one agent had visited two areas and then sampled
  where everybody was — a **proxy** for dispersal rather than dispersal. Once
  the cast started a round together in the tavern (D-608) rather than spread
  around the square, they all went through the one door at once and the sample
  caught them co-located. It failed about one run in two saying *"expected 1 to
  be greater than 1"*, which describes nothing. It now waits for the property
  itself. ⚠ And the walking check needed its own wait: the agent's map memory
  lags the client mirror by one decision, so at the instant the cast first
  occupies two areas, nobody has recorded the second one yet.
- `mr2-gathering` remains the known flake and passes on its own.

### Verified

1046 tests pass, 1 skipped, every file green — including both intermittents.
`client/test/hud-layout.test.ts` pins the layout anchors and the both-casts
rule; reinstating the `instanceof CharacterVisual` in `playAttack` fails it by
name. ⚠ Source assertions, and honest about it: a stylesheet cannot be laid out
in node, so the boxes were measured in the browser and what the tests pin is
the anchor each element declares.


---

## D-613 — Seventeen finished people nobody could reach

**Status:** implemented

### The report

> "Currently there is no proper way to create enemies in the character creator.
> The Goblin meshes etc do not show up in that tool. I think there should be a
> separate tab in the character creator for enemies/non-modular characters."

### ⚠ Every piece was already built except the one that lets a person see it

- `CharacterDefSchema.mesh` has said **"this is how enemies get in"** since
  D-594, and `goblin.json`, the skeletons and the rock golem already use it.
- `meshShelf` has classified whole rigged bodies as `'character'` since D-595,
  and is TOTAL by construction precisely so nothing can fall out of it.
- The studio server has validated and written these definitions the whole time.

The creation tool simply **had no tab for that shelf**. Measured across the
ingested packs: 1,456 body-part meshes, 1,858 environment, 167 weapons, 36
pickups, 4 unfiled — and **17 characters that appeared in no tab at all**. Six
of them goblins. The classifier was right; the menu was one entry short.

### A separate tab, because it is a different SHAPE of content

Not a different subject. A modular character is an assembly chosen slot by slot
out of hundreds of part files (D-560); one of these is a single rigged FBX that
IS the body. Forcing the second through the first would mean inventing a "whole
body" slot and pretending an assembler ran — which is the reasoning D-594 wrote
down when it added the field, and the reason the two belong on separate tabs
rather than in one list.

The tab lists a pack's whole bodies, says how many are named, previews the raw
mesh on the stage, and writing a name creates the definition.

### ⚠ Four things that would each have made it useless

- **It previews the RAW pack mesh, not the built `.glb`.** The creature editor
  loads from the models manifest, which is right there — the question is "what
  will the game draw" — and useless here, where the question is "what is this
  mesh". A body nobody has named has never been built and never will be until
  somebody names it, so previewing only built characters would leave the tab
  unable to show the very meshes it exists for.
- **It lands on a pack that HAS some.** Only one ingested pack ships finished
  people, so opening on whichever pack the last tab was reading showed an empty
  list — and an empty list is indistinguishable from a broken tab. It walks the
  packs until it finds bodies.
- **The shelf is named, not inferred.** The tab is called `enemies` and the
  shelf is called `character`; without mapping one to the other it asked for a
  shelf that does not exist, matched nothing, and rendered empty — the same
  failure wearing the same face.
- **It writes on `change`, not on `input`.** Every keystroke would be a write
  into git and one definition id per prefix of the word being typed.

### ⚠ The scale trap, said where the author is standing

Measured in the tool: the pack's goblin is **1.79m** and its knight 1.86m. Every
body in these packs is modelled at human height whatever it is, so how big a
creature IS comes from `heightMetres` on the roamer (D-594) and never from the
mesh — and it reaches the descriptor pipeline (D-201), so a thing a player is
told is small actually is. The side pane says so beside the body, because this
is the one fact an author cannot see by looking at the preview.

### ⚠ A look cannot be deleted out from under a creature

A roamer names its look by id. Deleting the definition leaves content that
parses, validates against its own schema, and fails the build somewhere else
about a different document — the exact shape of failure D-569 built the recipe
graph check for. `DELETE /api/characters/:id` refuses with the reason, verified
live: deleting `skeleton-soldier` answers *"skeleton-soldier is what
night-walker is drawn as"*, and an unused definition deletes cleanly.

### Verified

Driven in the browser: the tab lists all 16 of the dungeon pack's bodies, shows
9 already named, previews a goblin at 1.79m, and naming
`Character_Goblin_Female` wrote a definition that `validate:content` accepts on
the next run. The test junk was then removed through the same delete path.

`tools/test/enemy-tab.test.ts` pins the tab, the shelf mapping, the schema shape
(a character is an assembly or a mesh, never both and never neither), that the
goblins are findable, and the delete guard. Proved by deliberate break: removing
the shelf mapping and removing the guard each fail by name.

1051 tests pass, 1 skipped, every file green. Content validates over 147 files.

⚠ Two Postgres-backed suites failed earlier in this session for an
environmental reason worth recording: Docker was not running, so they could not
connect. They fail LOUDLY rather than skipping, which is correct — D-572's
lesson is that `MemoryStore` is more permissive than the real store — but it
means a red suite can mean "no database" rather than "broken code". With the
database up, both pass.


---

## D-614 — A sword you are holding is drawn

**Status:** implemented

Reported: *"I had a sword equipped, and it was not visible in combat."* Three
gaps, each of which alone was enough.

**No weapon mesh had ever been built for the client.** `build:environment`
collects what AREAS, stations and nodes place; an item's art was in no list, so
not one of D-564's 163 fitted weapons had ever been exported. ⚠ And building
them naively would have destroyed the fitting: `normalise` stands a mesh on the
ground and re-centres it in x/z, which is right for a barrel and moves a
sword's grip by half a blade. D-564's load-bearing measurement is that **the
mesh origin IS the grip** -- it is why a 2.1m spear and a 48cm knife take the
same offset. Held items now export RAW, on the same reasoning D-571 gives for
character part files: the transform was measured against the raw FBX, so baking
a conversion in here would apply it twice.

**The wire said only `'sword'`** -- the same word for every blade in the game,
so a client could not know which mesh to hold. `WornLook` carries `weaponArt`
now, read off the same item the silhouette picked (the reasoning `stance`
already carries: choosing the silhouette from one weapon while drawing another
is a man swinging a sword he is not holding).

⚠ **`publishWorn`'s comparison has now caught three decisions running** --
D-571 found `garments` missing from it, D-578 found `stance`, and this is
`weaponArt`. Two different swords give identical flags, identical garments and
an identical stance, so without the line a change of sword is judged "no
visible change" and never broadcast. Added deliberately rather than discovered
a fourth time.

**`ImportedVisual` had a hand socket it used only to find a muzzle.** It now
hangs the fitted mesh off the bone the fitting names.

⚠ **One bug caught by comparing against the fitting tool rather than by
running:** the stored offset must be divided by the bone's inherited world
scale, not only the mesh scale. A child's position is in its parent's local
space, so a bone at 0.0116 turns a 12cm offset into 1.4mm -- a hilt welded to
the wrist. The tool has divided both since D-563; anything reading those
offsets has to undo the same division.

**Measured in the browser:** sword drawn on `Hand_R`, **12.3cm** from the bone
-- exactly the stored offset -- with the bone's real world scale at **0.0116**,
not the 0.01 anyone would assume.

---

## D-615 — Sitting on a chair and sitting on the ground are two things

**Status:** implemented

Asked for: the sit emote should not be the chair animation. Measured, the
library's `unarmed-sitting` puts the hips **58cm** off the floor -- that is a
seat -- and the `*sits*` emote resolved to it too, so anybody sitting down in a
field hovered at chair height with their legs round furniture that was not
there.

The two are now separate actions. ⚠ The server says which, because only the
server knows: the `sit` verb finds a seat and decides where the sitter ends up
and which way they face (D-605), while the emote says nothing about furniture.
A client cannot tell them apart -- both are `posture: 'sitting'` -- and guessing
from the tile would make it a question of geometry the authority has already
answered.

⚠ **The flag rides on the EVENT as well as the entity.** Taking a chair
broadcasts `entity_emote` with `posture: 'sitting'` exactly as the emote does,
so reading the flag off the entity in that handler would be reading a value the
event is about to change. Everybody sat on the floor through the chair.

⚠ **There is no ground-sitting clip in the library, and none was faked.**
Measured: `unarmed-sitting` 58cm, `unarmed-kneel` 43cm; hips on the floor would
be about 20cm. Binding either is the substitution D-564 warns about, where a
search falling back to its first result shipped a crouch as an idle. So the
SPLIT ships, `sit-ground` is in the wishlist with search terms, and until a clip
is fetched the emote falls back to the chair sit -- looking as it does today
rather than wrong in a new way. Fetching needs a Mixamo session, which is the
stakeholder's.

---

## D-616 — The hood and the emotes, on the cast that ships

**Status:** implemented

Both were empty methods on `ImportedVisual`, and `setPresentation`'s own comment
called itself a regression. ⚠ That regression was load-bearing: D-219's
recognition depends on the hood being VISIBLE -- a hood dropping in view is what
merges two identity threads -- so on the cast that actually ships, the mechanic
rested on nothing.

**The hood is a head covering, not a garment**, and the separation is the
point. Garments are equipment (D-570/D-571) and equipment must never reach the
descriptor pipeline -- D-539 refused a helm at creation precisely because it
would be a permanent disguise. The hood is the opposite: presentation, which the
descriptors already read. Modelling it as a garment would have broken the rule
from the other side.

⚠ **Chosen by TAG, not by filename.** `content/parts/<pack>.json` documents
`tags` as "free keywords per part, for anything that wants to select on them
later", so which mesh is the hood is a decision in content that somebody can
change in the creation tool. ALSO: the 28 hood parts split by what they CONCEAL
(hair / facial hair / neither), not by sex -- head coverings are cut once for
both bodies.

**Emotes play.** ⚠ The comment read "no emotes in the drop" and had been out
of date since D-564: `unarmed-bow`, `-wave`, `-laugh`, `-point` and `-shrug` all
shipped and `rig-unreal.json` binds every one by name. The method was empty, so
an emote reached other players as text and as nothing on screen.

### ⚠ Three mistakes on the way, all found by measuring

- `build:characters` exports parts a definition or garment names, and the hood
  is neither -- so the part was never built. The symptom is the worst kind: the
  swap happens, the loader asks for a file that is not there, and the character
  renders bare-headed exactly as before the feature.
- **`loadLook` had its OWN copy of the swap loop** and never called
  `dressedParts`, so the hood worked for seed bodies and not for anybody who
  had chosen a face -- which is every player. Now one `layer()` rule.
- Extracting that rule **dropped the injected wardrobe**, turning five garment
  tests red at once. Extracting shared code has to carry the seams with it.

⚠ **And one non-bug:** the emote looked stuck until `document.hidden` turned
out to be true -- a hidden browser pane throttles `requestAnimationFrame`, so
nothing was stepping. Driving frames by hand showed wave -> walk -> idle exactly
as designed. That was the measurement, not the code.

**Measured:** hood up takes the assembly from **14 meshes to 15** (+732 verts)
and back to 14 when lowered; `unarmed-idle` -> `unarmed-laugh` -> idle as the
clip expires.

---

## D-617 — The procedural cast is deleted

**Status:** implemented
**Supersedes:** D-559's ruling that it must not be deleted until the stakeholder says so

The stakeholder said so. There is one cast: the imported models.

⚠ **The two things only the procedural rig could do were built first**
(D-616), because deleting it before that would have taken D-219's hood with it
-- and the hood is what recognition and disguise rest on (invariant 6). The
order was the stakeholder's call and it was the right one.

**The Settings toggle went too.** A switch that silently changed which renderer
somebody was judging is a way to report a bug about the wrong one, and it
defaulted to the cast that was not shipping.

### What went with it, and why

- `/imported.html` -- an A/B page with nothing left to compare.
- `/creator.html` -- a preview of the deleted rig.
- The viewer's **cast grid, seed filters, gear toggles, hood toggle, animation
  driver and per-part colour editor**: every one browsed something that no
  longer exists. Its Render tab went too -- D-586 removed the quantiser those
  controls tuned, so they had been vestigial since.
- `garment-scale` and `walk-grounding`: both measure generated geometry (cape
  anchoring across builds, the analytic walk solve). Neither has meaning for a
  cast that plays authored clips.

### ⚠ The cloth workbench survives on a placeholder

It pinned cloth to `CharacterVisual.bones()` and collided it against
`colliderCatalog()` -- properties of a skeleton the renderer GENERATED. The
imported cast is fixed meshes with no cloth simulation, so the workbench needed
something to stand on or it went down with the cast. `WorkbenchBody` is a
jointed stand-in at roughly human proportions, deliberately blocky, and the page
says so. ⚠ **The bone NAMES are kept identical**: a saved garment stores its
pin as a string (D-520), so renaming them would silently unpin every garment
already tuned. ⚠ A garment tuned here is tuned against an **approximation** --
the honest state of cloth tuning until something rigged replaces it.

### ⚠ A repaired mechanic changed two tests, and both were right to change

The town watch was blind from the first round ever played (D-610). With its eyes
back:

- `mr1-round` staged four hundred swings in the open square; the watch began
  arresting the murderer partway through, so the round resolved `cast_wiped`
  and the next assertion found it already over. Moved to the tavern -- equally
  settled, no guards.
- `mr3-bots` asserted the antagonist WINS after killing the keeper. It now
  sometimes loses the fight with the guards instead. Both endings are correct;
  what that test is for is the BOT finding a target it was never told the
  position of and committing, which is asserted directly. Pinning the winner
  pinned the outcome of a fight.

### Verified

1057 tests pass, 1 skipped, every file green -- including both long-standing
intermittents. Content validates over 147 files. `hud-layout.test.ts` now
asserts the stronger fact the deletion makes available: the file is gone,
nothing imports it, and nothing constructs it. A half-removal leaving one live
reference would be the worst of both.

## D-618 -- The last procedural geometry indoors, and the dead who would not leave

**Status:** implemented
**Reported by:** the stakeholder, playing

Four of ten notes, and one of them had a cause nobody would have guessed from
the symptom.

### The tavern's walls, tables and hearth were TILE KINDS

The taproom's legend carried `wall-timber`, `table` and `hearth`, and the
terrain renderer drew each of them as generated geometry -- the last of the
procedural world still standing anywhere a player spends time. They are pack
meshes now: `generic/sm-bld-base-wall-01` for the walls,
`dungeon-pack/sm-prop-table-01` for the bar and the tables,
`dungeon-pack/sm-env-wall-fireplace-01` for the hearth. The legend is `f` and
`x`, both **wood**, and the collision comes from the objects.

⚠ **A run is tiled by evenly spacing WHOLE panels, never by scaling one to
fit.** A 24m wall takes ten 2.5m panels at 2.4m centres -- 10cm of overlap
each, invisible -- where scaling the last one to 1.5m compresses its texture by
40% on exactly one panel per run and reads as a seam.

⚠ **The first cut gave every wall `collision: []` with
`overrideCollision: true`, and you could walk out through the side of the
building.** That combination is how the chairs are placed, where it is a
documented choice (D-567); on a wall it means there is no wall. The room had no
walls at all for as long as it took to notice. The mask is the panel's SPAN
rather than its mesh, or the wall creeps a tenth of a metre into the room at
every joint.

⚠ **Then the validator found four unreachable tiles**, because a wall line
that is walkable floor is a wall line bodies path through and objects then
block. The fix is a tile that is unwalkable and still WOOD: a tile may be
unwalkable without being a procedural wall, which is a distinction the legend
did not previously have.

⚠ **The rest of the world is 17,000+ wall tiles across eleven areas.** The
note said "everywhere"; the tavern is done in full and the scale of the rest is
flagged rather than quietly narrowed. D-545 renders those at full height and
`walls-to-assets.py` converts them, and re-running that converter is half of
what caused D-592's flattening.

### A bot showed up as a goblin, and the cause was a lottery

Which character an entity is drawn as, when nobody chose a face, is picked from
the appearance seed (D-559). **Ten of the twelve built characters are
monsters**, so the seed handed bots, NPCs and anybody who never went through
creation a goblin, a skeleton or a rock golem.

A definition now DECLARES `kind: 'person' | 'creature'`, the manifest carries
it, and the fallback draws only from people. A goblin is drawn when content
SAYS this thing is a goblin -- a roamer naming its look (D-594) -- and never by
accident of a number.

⚠ **Declared, not inferred.** The tempting rule -- a whole mesh is a
creature, an assembly is a person -- is true of today's twelve and is an
accident of which art happened to be modular: `polygon-hero-male` is a whole
mesh and is the most person-shaped thing in the pack.

⚠ **It defaults to `creature`,** which is the safe direction: an
unclassified definition stays OUT of the pool, and the cost of that is "this
NPC is never picked at random" rather than the bug being fixed.

⚠ **The classification silently did nothing on the first attempt.** The
build read it through `definedCharacters()`, a helper that skips whole-mesh
definitions -- which is every creature -- so all thirteen came out `person` and
the manifest looked correct. **A helper that filters for one purpose is not a
list.**

⚠ **If nothing is marked as a person it falls back to the whole list**
rather than drawing nobody. A wrong-bodied cast is a bug you can see; an empty
tavern looks like the server is down.

### The dead stayed between rounds, replaying their deaths

The reset cleared nodes, stations, roamers, guards, the stores, recognition,
kit and xp -- and left the bodies lying where they fell. A fresh client is
never told a corpse has already landed, so each one played its death animation
again, forever.

`sweepTheDead()` runs at reset. ⚠ **Swept rather than decayed**: a corpse
normally rots on a timer and leaves its gear as a heap (D-511, D-554), and that
whole chain is a WITHIN-round mechanic. Between rounds none of it means
anything -- gear is stripped anyway (D-522) -- so the bodies go without
ceremony and without leaving heaps, which is what "back to the start of round
state" means. ⚠ **The items go with them**, or the rows are owned by
nothing: invisible, unreachable, and still counted by the no-duplication
invariant D-114 exists to protect. ⚠ **The departure is announced on the
plane the body was ON**, or a ghost's corpse is announced to the living.

The chat and the perceived-actions panels clear on the same transition (D-612
cleared them on one of the two reset paths).

### Pressing an action button between ticks said so, every time

Every refused swing inside a combat round printed "you have swung all you can
this round" into the log. The client now suppresses `on_cooldown` **and only
that code**: a refusal that tells you something you did not know is still
printed, because a verb that fails in silence is the bug the whole refusal
channel exists to prevent (D-610).



## D-619 -- A weapon up is a run, and the watch can reach you

**Status:** implemented
**Reported by:** the stakeholder, playing
⚠ **Every magnitude here is UNRATIFIED.**

The note was that combat at level 1 is over in seconds -- and explicitly *not*
because the rounds are too short. Three separate things were wrong, and only
one of them was a damage number.

### Nothing about a fight moved

Every body in the world walked at `WALK_SPEED`, fighting or not. So the man
swinging and the man running from him travelled identically: a fight was
decided entirely by who swung first, nobody could close and nobody could break
off. `RUN_SPEED` is 4.2 against a walk of 2.9, selected by the entity's own
`combat` flag -- the server's, already broadcast (D-516), so every observer
sees one pace.

⚠ **1.45x, not 2x.** A combat round is four seconds (D-550) and reach is a
metre and a half; at double speed a body crosses the whole gap between two
swings and back, which turns a non-twitch game (D-104) into a kiting contest
decided by mouse work. At 4.2 a runner opens 5.2m over a round -- enough to
break away, not enough to fight a duel out of reach.

⚠ **It is a STATE, not a key.** Nobody presses run. You run because your
weapon is out.

⚠ **The glide had to learn it too, or it stops being presentation.** The
server reports a new position every tick; a client interpolating at walking
pace closes less ground than arrives and falls steadily behind until the
catch-up factor stops it about a metre back. What that looks like is a
character sliding along a step behind their own sword. `stepToward` takes a
seconds-per-metre now, and `main.ts` passes the run when the wire says combat.

⚠ **The combat flag is recorded for EVERY body, and only the stance is a
person's.** It had been set inside `if (isPerson(...))`, so a creature's flag
was never written -- and a creature runs at the same pace a person does even
though it has no readiness layer to swap.

⚠ **Locomotion is two clips now, and that broke the re-table.** `retable()`
answered "am I moving?" by comparing the playing clip to the WALK. With a run
in the vocabulary, raising a weapon mid-stride found the run playing, decided
it was not the walk, and dropped a running character into the idle.

### The watch was capped below a walking player

A roamer lays down one metre of route every `moveCooldownTicks`, so that
cadence is a **speed limit**. At 4 the watch was held to 2.5 m/s against a
player walking at 2.9 -- it could never catch anybody who simply left, which is
why "the guards never arrive". At 2 the cap sits above the speed and the
guard's own legs decide.

**A roamer enters combat when it picks a quarry**, not when it lands a blow.
Two things follow and neither is cosmetic: it runs, and every observer sees a
weapon come up.

Damage 3-6 -> 4-9 and hp 22 -> 30, so that arriving matters. ⚠ **The reach
of all of it is bounded by the guard still having to WITNESS something first**
(D-552, D-217): none of it touches a player who was not seen. And **the watch
is still worth zero xp and carries nothing** -- the moment it pays, murdering
the watch is a farming strategy.

### A named objective had ten hit points

Not a content decision -- the world's `spawn` default, set once for test
fixtures, which no content file could reach. `NpcDefSchema` gains `hp`,
defaulting to ten so nothing unauthored moves, and both keepers are **40**.

The arithmetic, measured rather than guessed: a level-1 character with the
arming sword its kit grants swings at +3 against an unarmoured AC of 10, hits
about seven times in ten for a flat 3 -- 2.1 a swing -- and a basic character
gets ONE swing per four-second round (D-550). Ten hit points was five swings
and twenty seconds. Forty is about nineteen swings and seventy seconds of
standing over somebody in the open square where D-549 put every route: long
enough for the watch to close and for anybody crossing to see it. It halves for
two attackers, which is D-529's buddy system working rather than a leak.

### ⚠ Two fixtures were wrong about the game, and the game was right

- `mr9-keeper` fought **bare-handed** -- measured off the fixture itself: 27
  swings for 13 damage, about half a point each. An antagonist dealt
  `silence-the-keeper` carries the kit its calling granted (D-547), so a
  fixture that punches him is not a harder version of the real thing, it is a
  different thing, and tuning the objective against it would tune it against
  nobody. It equips an arming sword now.
- `mr1-round` murders one of the cast in a settled zone to prove a round needs
  no hostility declaration (D-531). D-610 had already moved it out of the
  square for this reason -- but **guards stand in every settled area**, the
  tavern included, so the tavern was only ever far enough away rather than out
  of reach. Once they could run, the watch killed the murderer partway through,
  the cast was wiped, the round resolved, and the next assertion found the
  round already over. There is a `watch: false` server option now, the same
  move as `graceTicks: 0` for the dawn truce (D-536): a suite states which
  mechanics it is not about instead of hoping they stay out of the way.
  Weakening the watch to keep an unrelated suite green would be tuning the game
  to the tests.

### Verified

1071 tests pass, 1 skipped. Content validates over 147 files. The run is
asserted three ways -- the speed function, one tick of the real sim carrying a
fighter 1.45x further than the same body walking, and the renderer choosing
`run` over `walk` -- and the watch's cap is asserted as a SPEED rather than as
a cadence, because the cadence is the thing that reads as harmless.

⚠ **One long-standing intermittent is still intermittent.**
`mr2-gathering`'s interrupt assertion failed once under full-suite load with
the work ending on "you moved" rather than "you were struck", and passed alone
and on the next full run. Its own comment records a history of chasing timing
in it. Noted rather than papered over.

## D-620 -- A weapon you are not fighting with is put away

**Status:** implemented
**Reported by:** the stakeholder, playing
**Extends:** D-614 (a sword you are holding is drawn), D-565 (readiness is a layer)

"Weapons should only be visible when in combat state. At the start of entering
combat an animation should play to draw weapons, and when it ends an animation
should play to holster them."

D-614 put 163 fitted weapons into hands and never took one out again, so the
whole cast stood about the tavern holding drawn steel. The twelve **draw and
sheathe clips** D-564 fetched and D-565 deliberately filed in the STANCE layer
-- rather than in either readiness -- had never been played by anything at all.

### ⚠ The two halves are not symmetrical, and that is the design

The blade appears at the **start** of a draw: the clip's hand reaches to the
hip and comes back holding something, and nothing to hold makes the motion
meaningless. It leaves at the **end** of a sheathe, which is the same sentence
read backwards. Hiding it when combat ends is a sword that vanishes while the
hand is still putting it away -- which reads as a missing model rather than as
a bug in a flag.

`readinessTransition` is pure and exported for exactly that reason: it is the
whole of the decision, the rest is three.js parenting, and "the sword
disappeared halfway through putting it away" is a defect you can only see by
looking (D-114).

### ⚠ Nothing plays for an empty hand

An unarmed character entering combat still changes how they STAND, because
that is the readiness layer. A draw with nothing to draw would be the renderer
claiming something happened. The flag is still tracked either way, or somebody
who equips mid-fight gets an invisible weapon and no event that would reveal
it.

### ⚠ A missing clip snaps rather than sticks

A rig with no sheathe stows immediately. The failure of an unbound clip has to
be "it went away suddenly", never "combat never ends".

### ⚠ The transition owns the body while it plays

Without that, the re-table that RAISED the weapon immediately replaces the draw
with the combat idle and the clip is never seen. Held in `performance.now()`
milliseconds to match `emotingUntil` rather than `attackUntil` -- this file
already had two clocks and joining a third to the wrong one is how a transition
either never holds or holds forever.

Visibility is toggled, not re-parented: the mesh is loaded asynchronously and
hangs off a bone, so tearing it off on every sheathe would make entering combat
a network round trip and race two quick changes.

## D-621 -- The dead see a different world

**Status:** implemented
**Reported by:** the stakeholder
⚠ **The look is unratified.** Every constant in the shader is a taste call.

"When dead, I would like you to add some kind of shader to the map/render that
makes the character and map look ethereal, grayscale."

A full-screen pass, not a material swap: a ghost has to see the WORLD change,
and there is no per-object edit that reaches painted ground, instanced terrain,
placed meshes, effects and people alike.

### ⚠ Grayscale is the floor, not the whole of it

A straight desaturate reads as a broken screenshot. What reads as a different
plane is four things together -- desaturate, **lifted blacks** (a ghost's world
is pale, not dark; darkening it reads as the lights going out), a **cold tint
weighted into the shadows** (a uniform blue cast looks like a filter, a
gradient looks like light behaving differently), and a **vignette** centred on
the screen rather than on the player, because a vignette that tracks a body
reads as a spotlight.

Measured on a real render rather than judged by eye: an orange box reads
(204, 68, 34) alive -- saturation 170 -- and (160, 166, 177) dead, saturation
17 and blue-dominant.

### ⚠ The colour space was wrong, and it looked like a taste problem

A raw `ShaderMaterial` writes whatever it is given, and the canvas expects
sRGB. Before the fix the same box read **(90, 97, 112)** where the arithmetic
says about (133, 141, 153): every veiled pixel a third too dark, which is
indistinguishable from having picked the numbers badly. The render target is
sRGB so the world pass encodes into it, sampling decodes, and
`<colorspace_fragment>` re-encodes. Verified by driving the fade one frame and
confirming the pass is a **passthrough** at that amount -- one channel out by a
rounding step.

### ⚠ The living pay nothing

Nothing is allocated until somebody dies, and `render()` goes straight to the
canvas while the amount is zero -- not even a blit. That fast path is why the
ease must **arrive**: an exponential approaches 1 and never reaches it, so the
world would stay grey for somebody plainly alive after a respawn. It is linear
over about a second, because dying is the one event a player most needs to
understand and a hard cut reads as a graphics glitch.

Also load-bearing: the render target needs a **depth buffer**. Without one the
world draws in submission order and terrain lands on top of people -- a failure
that only appears once somebody dies, which is the worst time to find it.

## D-622 -- What you can use lights up

**Status:** implemented
**Reported by:** the stakeholder

"If an object is interactable, I would like it to show a highlighted edge when
hovering the mouse cursor over it. This includes objects like stations,
characters, and chairs."

There was a ring on the GROUND under a hovered entity, which answers a
different question -- it says where a thing stands, not that the thing is a
thing you can use -- and scenery like a chair had no feedback at all.

### An inverted hull, not a post-process

An outline pass over the whole frame means a second render target, a depth
prepass and an edge filter, running every frame for everybody so that it is
available on the frames where something is hovered. A hull is one extra draw
per mesh of ONE object, only while the cursor is on it, and it survives the
renderer changing underneath it because nothing reads the depth buffer.

Measured: 912 outline pixels appear around a 6,084-pixel box and the box's own
pixels are **unchanged** -- a rim, not a recolour.

### ⚠ The push happens in the vertex shader, before skinning

A character is a skinned mesh: its vertices are transformed on the GPU by the
skeleton, so scaling the OBJECT does nothing to where the skin ends up and an
outline built that way stays welded to the bind pose while the body walks out
of it. Pushing `transformed` along the vertex normal at `<begin_vertex>` puts
the expansion into the same bind-pose space the skinning then reads.

### ⚠ `normal`, not `objectNormal`

`objectNormal` is declared by the basic material's vertex shader only inside
`#if defined(USE_ENVMAP) || defined(USE_SKINNING)`. Reading it compiles for a
character and **fails to compile for a chair** -- one class of object with no
outline and nothing in the log. The raw `normal` attribute is always declared.

### ⚠ The width is divided by the object's world scale

The imported cast is authored in centimetres and worn at a root scale of 0.01
(D-555, D-577), and the push is in LOCAL units -- so a constant is a hundred
times too small on a person and correct on a chair, which looks like the
outline failing on characters specifically.

### ⚠ Entities first, scenery second, and scenery means SEATS

A chair with somebody sitting in it is two interactable things on one tile, and
the person is what you meant; the entity pick already resolves that (D-542) and
this keeps the same answer. And every wall, cobble and flower is a placed asset
too -- outlining whatever stands on the hovered tile would light up the floor
of the tavern as the cursor crossed it. A seat is the only piece of scenery
there is a verb for.

Two more things that are not incidental: the hull shares the source's
**skeleton object** (a copy would have to be posed by somebody, and nobody
would), and it copies world matrices **after** the mixers have run, because
reading last frame's matrix trails a running character by a whole frame -- at
four metres a second (D-619) that is a visible double image.

⚠ Verified in the browser rather than by unit test: this is GPU code, and an
assertion that a uniform was written proves nothing about what is on screen.
What was measured is above.

## D-623 -- Which mesh the hood is, is a decision somebody can make

**Status:** implemented
**Reported by:** the stakeholder
**Extends:** D-616

"The model for the hood is incorrect. Can you add a place in the creation tool
to define the asset to use for the hood?"

D-616 chose the hood by a `hood` TAG rather than a filename in the renderer,
which was the right shape and had no way to be set: the tag was typed into
`content/parts/` by hand. So "the model is incorrect" was a bug nobody could
fix without editing JSON.

The Body parts tab now has a **hood picker** -- all twenty-eight head coverings
in the pack, by the name a person gave them, previewing on a body as you
choose. ⚠ A picker showing file stems would be asking somebody to choose a
hood by inventory number: the stems say `HeadCoverings_No_Hair_03` and the
names say "Brown hood 3".

⚠ **Exactly one part may carry the tag.** Setting a new hood clears the old
one in the same action, and `validate:content` refuses two. `hoodStem()`
returns the FIRST match, so two tagged parts is an ordering-dependent answer --
stable until somebody renames a part, and then the whole cast changes hood with
nothing in any log.

⚠ A tag pointing at a part the current pack does not ship still SHOWS in the
picker rather than silently resetting to none. Somebody switching packs should
see what was chosen, not have the tool quietly discard it.

## D-624 -- The cast that fills a lobby is content

**Status:** implemented
**Reported by:** the stakeholder
**Extends:** D-607 (bots summoned from the lobby), D-618 (the goblin lottery)

"I am not sure how bots are selected/created, but the definition of bots needs
to be added to the creation tool."

The roster was **eleven names and six roles hardcoded in
`server/src/dev/bots.ts`** -- the thing D-110 exists to prevent, and a thing no
tool can edit. Filling a lobby is how a round starts at all (D-607), so who
fills it is content: `content/bots/`, a fourth kind in the Round content tab,
and the same save-refuses-what-the-build-refuses rule the rest of the tool
follows (D-543).

D-618 fixed the goblin by keeping creatures out of the appearance lottery. This
is the other half: a companion should be a person somebody DECIDED on.

### ⚠ Draw order is a field, not the file listing

Definitions are read alphabetically, and the first draft of this relied on that
-- wrongly. A cast of three is the floor (D-522), so the first three summoned
have to cover the mine, the farm and the wood; alphabetically they are a
woodsman, a delver and a gatherer, with **nobody on the farm**. An unworked arm
makes hunger look broken when it is merely unattended (D-529) -- a bug report
about the wrong system. `order` is authored, ties break on id so the order is
total, and the three arms are asserted in a test, refused on save and refused
on delete, by name.

### ⚠ A fixed face, because the old one moved

Without an authored `appearanceSeed` a companion's face came from the ORDER it
was summoned in, so Dorn was a different stranger depending on how many arrived
before him.

### ⚠ Letters only, in the schema

Character names are letters on the wire. D-540 lost twenty minutes to a refusal
that surfaced as a timeout; a new companion now fails the build instead.

### ⚠ The cap is what content says there is

`MAX_BOTS` was a constant equal to the hardcoded roster's length. Drawing past
the end wrapped, so a twelfth request handed back a second Dorn -- and
character names are unique, so it surfaced as a refusal that read like the
server being broken. An empty `content/bots/` is refused out loud, naming the
directory, rather than being a lobby button that summons nobody.

Everything below `role` is optional, and a definition with nothing but an id, a
name and a role behaves exactly as the hardcoded roster did: authoring narrows,
it never silently locks (D-572). The six roles are a closed vocabulary in
`shared` now, because a seventh role in a file the agent does not implement is
a companion that stands still -- D-538's rule for feats, for the same reason.

### Verified

1085 tests pass, 1 skipped. Content validates over 158 files. Every refusal was
driven against the real endpoint rather than asserted in prose: a role outside
the enum, an unknown calling, a name with a digit in it, a save that strands
the farm, and a delete that removes the only forager.

## D-625 -- The taproom, furnished from the packs and measured into place

**Status:** implemented
**Reported by:** the stakeholder -- "fix the tavern interior, add proper tables,
walls and fireplaces from the assets"
**Extends:** D-618, which turned the taproom's tiles into placed meshes and
stopped one step short of any of them being visible

D-618 replaced the tavern's procedural walls, tables and hearth with pack
meshes. It was right about the shape and wrong about almost everything else,
and the reason nobody could tell is the first note below.

### ⚠ Three of the four meshes had never been built

`npm run build:environment` ships only what the world actually places, and it
was not re-run after the meshes changed. So `generic/sm-bld-base-wall-01`,
`dungeon-pack/sm-prop-table-01` and `dungeon-pack/sm-env-wall-fireplace-01`
existed in the area file, validated, flooded and **drew nothing at all**: one
`console.warn` per mesh and an object that is simply absent. The taproom was
bare boards with thirty-two chairs standing on it.

A missing mesh is not a missing texture. `tools/test/environment-assets.test.ts`
now asserts that every asset every AREA places has a built mesh, naming the map
that placed it -- the same check `held-weapons` has made for what a character
holds since D-614, which is where the idea was already written down.

### ⚠ The wall was from the wrong game

`generic` is POLYGON's **modern** kit: its textures ship tyre decals and dollar
signs, and `sm-bld-base-wall-01` is a 60-vertex featureless panel that sampled
the atlas's colour-swatch strip. A fantasy taproom with a concrete basement
wall is exactly what it looked like. The chair was from the same pack.

Everything is `dungeon-pack` now -- which despite its name is the fantasy
interior set -- so the room samples **one atlas** and reads as one place:
**`sm-env-basement-wallpanel-01`** for the walls, which is a boarded timber
wall and the only warm interior wall in any ingested pack; the trestle
**`sm-prop-table-01`**; **`sm-prop-stool-01`** for seats; **barrels** and
**candles**; and **`sm-env-wall-fireplace-01`** for the hearth.

⚠ Three choices were made by LOOKING at the meshes rendered side by side,
and two of them contradict their own names. `sm-prop-fireplace-01` is a
cast-iron **stove** with a flue, not a hearth. `sm-prop-bench-01` is carved
**stone**, not a bench you put in a tavern. And the dungeon's own
`sm-env-wall-*` are cut stone **five metres tall** -- a crypt, not a room
somebody drinks in.

⚠ **Stools rather than chairs**, and not for taste: a stool has no backrest,
so the one thing a seat can get wrong -- the sitter facing into the back of it
(D-609) -- cannot happen on one.

### ⚠ A collision mask is authored in the MESH'S frame, not the world's

`transformVolume` multiplies every dimension by the placement's `scale` and
ADDS its `rotation`. The layout was written in world metres and pre-swapped by
hand, so it was wrong twice over and both faults were invisible in the file:

- The wall panels are scaled 1.25, so masks cut in metres came out a quarter
  too large -- enough to push the south run's mask from x=11.0 to 11.69 and
  drag the other half back to 12.375, narrowing the **doorway to 69cm** against
  a body radius of 30. The room was sealed. `map:why` reported the door tile as
  "penned in by (nothing within 3.5m)", because the wall that sealed it was two
  panels away and had grown.
- The bar trestles are turned 90 degrees, so a mask pre-swapped by hand was
  rotated a second time and lay **across** the counter instead of along it,
  which is why `validate:content` said the keeper "has nowhere to stand".

### ⚠ Panels are anchored to a run's ends, not spread across its middle

Spreading them put each centre on an even division and let its 6.25m of mesh
hang 1.4m past both ends. That is harmless where a wall runs past a corner and
not harmless at a door: the west run stopped its collision a metre short of the
doorway and then **drew straight over it** -- a door you could walk through and
could not see. Anchoring also fixed the four corners, where a leftover
`WALL_LEN * scale` (already scaled once) opened a 78cm gap.

⚠ The panels overlap rather than tiling exactly, and the scale is uniform,
because **this mesh's height scales with its length**: a scale chosen per run
to tile exactly would have the four walls meet at four different heights.
Overlaps are staggered a centimetre in depth, or two coplanar faces z-fight and
it reads as a driver fault rather than as a map.

### ⚠ The numbers came from the catalogue, and the first cut guessed them

`content/assets/*.environment.json` carries each mesh's measured extent. The
trestle is **2.95 x 1.40**; D-618 gave it a 0.9m collision box and laid ten of
them a metre apart to make a bar, which is ten three-metre slabs overlapping by
two metres each.

Masks are now cut a little INSIDE the art, and that is about `BODY_RADIUS`,
which is 0.3. A tile centre needs that much air to stand in and more to be
walked into; the first re-cut left exactly 0.3 at four table edges -- a coin
flip on the last decimal -- and `validate:content` refused it with twenty tiles
a body could stand on and could not reach. A tabletop that overhangs its own
collision by 20cm is what a tabletop does, and nobody can see the difference.

⚠ The gap in the bar is the **lift-up flap** and is load-bearing rather than
decorative: a continuous nine-metre counter seals the strip behind it, and the
keeper the whole tavern is built around then stands somewhere nothing can
reach. Barrels are kept out of that strip for the same reason -- it is one tile
wide, and a barrel in it walls him off as surely as a second counter would.

### ⚠ `mr9-sitting` was measuring a table by its placement point

The assertion that every sitter looks AT a table compared the looked-at tile
against the single coordinate a table is placed at. A trestle is three tiles
long, so a stool drawn up to either end was judged to be looking at nothing:
**thirty of thirty-three seats failed a room that was right.** It reads the
measured size from the same catalogue the room is laid out against -- so the
two cannot drift -- and rotates the footprint exactly as `transformVolume`
does.

### Verified

1086 tests pass, 1 skipped; content validates over 158 files. The walls were
checked as arithmetic as well as by eye: each run's panels merge to one
unbroken span, corner to corner, with a 2m gap centred on each doorway. The
new missing-mesh test was proved by deleting two meshes from the manifest and
watching it name them and the map that places them.

⚠ Unratified, and a matter of taste rather than correctness: the room is
**timber-walled with a stone hearth**, which is a reading of D-545's "a tavern
is not built of the stone a town gate is" against what the packs actually ship.
The bar is three trestles in a row because no pack here has a counter mesh.

## D-626 -- The wall has no back, so it is placed twice

**Status:** implemented
**Reported by:** the stakeholder -- "the walls only have textures on one side.
They need to be placed in both directions"
**Extends:** D-625

Measured off the built `.glb` rather than inferred: of
`sm-env-basement-wallpanel-01`'s 208 triangles, **94 face +z and none face
-z**. It is an open shell -- a plank face, two end caps, a top and a bottom,
and nothing behind it. glTF materials default to `doubleSided: false`, so the
renderer culls what was never modelled and you look straight through the
tavern wall from outside.

⚠ **Only the wall.** Every other mesh the taproom places came back a closed
solid with triangles in all six directions -- hearth 144/110 front to back,
table 336/343, and the barrel, stool and candles likewise. The fault was in one
mesh, exactly where the stakeholder said it was.

### ⚠ A second placement, not a double-sided material

Turning off backface culling is one line and draws the SAME face from behind,
lit by a normal pointing the other way -- a wall lit as though the sun were
inside the room. Two shells back to back carry their own normals and light
correctly from both sides, which is what the mesh would have done if the
vendor had modelled a back. It costs fifteen extra draw calls in one room.

⚠ **The twin carries no collision.** The mask belongs to the wall, not to
each face of it; duplicating it doubles the volumes the pathfinder sweeps for
nothing.

### ⚠ The twin is 0.998 scale, and the reason is geometric

Back to back, a twin's top face, end caps and bottom are exactly coplanar with
its partner's, and coplanar faces z-fight -- along the top of every wall in the
room, where it is plainly visible and where it *moves with the camera*, which
is the tell that reads as a driver fault rather than as a map.

Shrinking one of the pair separates every parallel pair at once, which **no
offset can do**: a shift along the wall's normal leaves the HORIZONTAL tops
exactly where they were. The price is a 5mm step at the top and a 5mm inset at
the caps, which is an order of magnitude below a pixel at this camera.

### ⚠ The overlap stagger was a centimetre and showed

D-625 staggered alternate panels 1cm in depth for the same z-fighting reason.
At the game camera that is fine; at close range it is a visible notch in the
face of the wall at every joint. It is **3mm** now. The arithmetic, rather than
a smaller number chosen by feel: this camera is orthographic, so depth is
LINEAR across near..far, and a 24-bit buffer resolves about a hundredth of a
millimetre over the whole 200m range. Three millimetres is a thousand times
that and a tenth of a pixel.

### Verified

1087 tests pass (including the two Postgres suites, which need
`npm run db:up`); content validates over 158 files. The pairing is asserted --
every placement of a mesh named one-sided must come as a pair a half turn
apart with exactly one mask -- and the assertion was proved by deleting one
twin and skewing another, which it named individually. Looked at from all four
sides at the game's own camera and lighting: planks on both faces, clean wall
tops, both doorways clear.

⚠ **The general case is open.** "Which meshes are one-sided" is a property
of the ART and belongs in the asset catalogue beside the measured `size`, where
any map could read it. Today it is a hand-kept list of one id in the test, with
the method written down beside it. The other eleven areas place wall meshes
converted by `walls-to-assets.py` from a different family and have not been
checked.

## D-627 -- One engine, two products, and the scenario is the boundary

**Status:** ratified (stakeholder), implementation follows
**Supersedes:** nothing. It states a line D-521 implied and never drew.

D-521 changed the product from a persistent-world MMO to **MR -- the Round**, and
was right to keep every system rather than cancel it. What it did not do is say
**which game any given area, verb or definition belongs to**. Sixteen months of
work later, nothing in the repo records that, so the two products run as one
world and the Round has no edges.

The stakeholder's words for the symptom: *"this project is sprawling, because the
tools to build the game, and the game runtime itself, are not linked."* The tools
are the place it is felt. The cause is upstream of them: there is no boundary for
a tool to serve, so every piece of work re-decides it by hand and gets it slightly
differently each time.

### ⚠ The proof: you can walk out of a round into permadeath

`RoundEngine` **has no concept of an area at all** -- no set, no map, no edges. It
knows the cast, the clock and the objective. Meanwhile the area graph runs:

    round-town -> hanged-ferryman -> broken-yard -> sunken-crypt

and `sunken-crypt` is `zone: endgame`, which carries **involuntary permadeath**
(D-513). D-523 says in terms that the round must NEVER contain an endgame area,
because a round death must not cost a character levelled across fifty rounds.

Nothing gates it. `dungeonGateAllows` is the only transition check while a round
runs and it enforces the dungeon's day/night and floor rules only;
`confirmEndgameEntry` warns twice and then lets you through. The invariant is not
defended by code -- it is defended by nobody having walked west yet.

### The ruling

**One engine. Two products. The Round is the product; the persistent world is a
deferred consumer of the same systems (D-521). The boundary between them is a
SCENARIO, and it is data.**

A scenario declares its **area set** and opening area, its objective pool, its
cast bounds and its round configuration. `RoundEngine` takes one. A transition
outside the set is refused.

⚠ **Data, not an `if`.** A new guard against `sunken-crypt` would fix the case
found and leave the next one -- and there will be a next one, because the
persistent world is meant to keep growing behind the Round. A declared set makes
the whole class impossible: an area is in this round or it is not, and CI can
read the answer.

### What follows for free

- **MR3's "multiple scenarios as data, chosen or rotated per round"** stops being
  a feature to build and becomes the thing that already exists.
- **CI can check a round is winnable and self-contained** -- the class of bug
  D-593 hit for real (an objective naming a keeper who was in no round map) and
  D-569 hit one level up (shelving the last objective playable at `minCast`).
- **The authoring tool gains its missing right-most stage.** The stakeholder
  asked for a left-to-right workflow where base definitions are complete before
  the parts that use them. Art, motion, bodies, things, world and rules all
  compose into something, and until now there was no name for the something. It
  is the scenario.
- **The persistent world keeps its areas** and is simply in no scenario. Both
  products coexist across one declared line instead of being tangled by default.

### ⚠ Two verbs are unguarded, and they are the same mistake one layer down

`handleRespawn` is gated on `roundRunning`; `handleRetire` and `handlePay` are
not. So a player can **retire mid-round** -- ending the character forever and
collecting Legacy, which D-207 and MR3 both say is earned between rounds and
never inside one -- and can trade gold, which round mode does not even display.
Both are the boundary missing again, in the verb table rather than in the map.

### ⚠ What this does NOT rule

`speak_dead` in a round looks like the same leak and is not: the MR gate text
names *"question a corpse"* as one of the things a good round should contain.
Interrogating the victim is a deduction mechanic, and it stays. The test is
whether a verb belongs to the ROUND's design, not whether it predates it.

### ⚠ Recorded against MR1, which asked for the opposite

MR1 specified the round be built **on** the DM event engine -- *"a scenario is an
event document that plays itself"* -- and it was built beside it: `RoundEngine`
is its own system and `EventEngine` receives deaths and nothing else. That was
probably the right call for a spine that had to work, and it is why the scenario
concept never appeared. Converging them is a separate decision; this entry only
records that the plan and the code disagree and that the code won.

## D-628 -- The scenario, built: three holes in the boundary, not one

**Status:** implemented
**Implements:** D-627

`content/scenarios/ashfold.json` declares the eight areas a round is played in.
`RoundEngine`'s world now has an edge, and `validate:content` refuses a
scenario that contains an endgame area, names an area that does not exist, or
carries no live objective playable at its own minimum cast.

### ⚠ The map was the smallest of the three holes

Implementing the boundary found two more, both the same absence one layer over:

1. **The cast was only ever gathered at a RESET.** So the FIRST round after a
   boot was played wherever people happened to log in -- and the shipped
   `DEFAULT_AREA_ID` is `hanged-ferryman`, which is not in the scenario at all.
   Every server's first round therefore began out of bounds, and the new
   boundary would then have refused the cast passage into their own town.
   `placeStrandedCast` moves anybody outside the scenario into its opening
   area at round start. ⚠ Only the stranded ones: a general gather would be
   a second implementation of the reset's, and would shove anybody already
   standing in the round somewhere else for no reason.
2. **A latecomer arrived in the persistent world.** D-608 sends an arriving
   character "to the tavern" so they open the round whole and with everybody
   else; it read `defaultAreaId`. A round's home is the scenario's now.

⚠ **The pattern to notice:** three separate places each answered "where is
the round?" by reaching for a global default. That is what having no boundary
looks like from the inside -- not one broken check, but every site inventing
the same wrong answer independently.

### ⚠ Two verbs were the same bug in the verb table

`handleRespawn` has been gated on `roundRunning` since D-521. `handleRetire`
and `handlePay` never were. Retirement ends the character forever and pays
Legacy, which D-207 and MR3 both place strictly between rounds -- ungated it
was two exploits at once: an exit from a round that has no respawn, and a way
to bank the round's takings before anybody could take them off you. Gold is the
persistent world's (D-220) and round mode does not display it, so `pay` was a
currency moving with no UI admitting it existed.

⚠ `speak_dead` is deliberately NOT gated. The MR gate text names "question a
corpse" among the things a good round contains. The test is whether a verb
belongs to the ROUND's design, not whether it predates it.

### Also swept, from the same pass

`hostilities` and `roamerHeadings` were never cleared at a reset. A declared
grudge survived into the next round -- long enough for a stale entry to decide
whether somebody counts as a threat to `combatTick` -- and the headings map is
keyed on entity ids that are despawned every reset, so it grew for the life of
the process.

### ⚠ Two fixtures asserted the old answer, and both were right to change

- `mr10-second-round` asserted the cast reassembles in `'hanged-ferryman'`.
  That was never the property under test: it was whatever the fixture's
  `defaultAreaId` happened to be. It reads the scenario's `opensIn` now, so the
  two cannot drift.
- `mr2-gathering` needs its miners IN THE MINE and had been getting them there
  by setting `defaultAreaId`. It takes `placeArrivals: false` now -- the opt-out
  seven other fixtures already use for exactly this.

### Verified

1096 tests pass, 1 skipped; content validates over 159 files. The boundary test
was checked by DISABLING the guard and watching a bot walk from `round-town`
into `hanged-ferryman` -- the first step of the road to permadeath -- and the
endgame rule by adding `sunken-crypt` to the scenario and watching CI refuse it
by name. A reset-invariant suite now asserts the whole floor at once: no
corpses or heaps anywhere in the world, everyone alive and whole in the opening
area, nobody left with their weapon up, and the world re-stocked rather than
stocked twice.

⚠ **The edge is reported, not hidden.** `validate:content` prints
`round-town -> hanged-ferryman lead out of the scenario and will be refused` as
a ⚠ING. A door out of the set is legal -- the tavern belongs to the
persistent world and is simply shut for the round -- but not knowing where the
edges are is how this started.

⚠ **Still open, and the stakeholder's to settle:** `hanged-ferryman` is the
persistent world's first-slice tavern that D-608 borrowed as the round's
opening room, while `round-town` contains a second tavern with the keeper
`silence-the-keeper` names. One of them should belong to each product. Until
that is decided the round opens in the town and the borrowed door stays shut.

➡ **Settled in D-634:** there is one tavern. The taproom is inside the round.



## D-629 -- One tool, one server, seven stages, and the scenario at the end

**Status:** implemented
**Implements:** MR4 (the production line), first half. Builds on D-627.

The stakeholder's brief: *"the tools to build the game, and the game runtime
itself, are not linked... a streamlined, left-to-right workflow for building
all assets and definitions, and making them accessible to the runtime."*
D-627 found the cause upstream of the tools (no boundary for them to serve)
and drew it. This entry is the tools themselves. The second half -- a save
reaching the running game -- is the next entry.

### What was there

Four pages on three processes. `/creation-tool.html` held nine sections in one
flat row with no order; `/studio.html` assembled modular characters on the same
server; `/viewer.html` was the cloth workbench with no server at all; and
`/editor.html` ran on a server of its own on 8140 while everything else saved
through 8150. `SYSTEM_INVENTORY.md` had already measured the real gap: **21 of
24 content types were editable** -- the missing editors were not the sprawl.
The sprawl was that the tool had no order, sat on two servers across four
pages, and nothing carried a save into the game.

⚠ **Two ports was a cost, not untidiness.** A session was lost to a stale
editor server answering with a schema it had never heard of, which presents
as a broken route. And the map builder was dead without a second process
nobody remembered to start.

### The ruling, and what was built

**One page. One server. Seven stages, read left to right, each using what the
one before it defined:**

    Art -> Motion -> Bodies -> Things -> World -> Rules -> Scenario

- **Art** names meshes (parts, weapons, environment, pickups, unfiled).
- **Motion** binds built clips to the action vocabulary.
- **Bodies** is races, **characters** (the studio, absorbed), enemies, and the
  **cloth workbench** (the viewer, absorbed).
- **Things** is items, garments, interactive objects.
- **World** is speech & sound, then the **map builder** (embedded). Cues before
  maps, because a map names its ambience.
- **Rules** is skills/feats/spells, callings, round content.
- **Scenario** is new: D-627's boundary, edited by hand.

`editor-server.ts` is gone; its routes are `editor-routes.ts`, mounted on the
authoring server, so `npm run dev:tools` is the whole thing (`dev:studio` and
`dev:editor` alias it). The embedded editor inherits the page's `?api=`
override, so a second server for a schema change moves both at once.

⚠ **The stages are a REGISTRY, not another `if` chain.** The nine sections that
existed are untouched -- a restructure, not a rewrite, because the file carries
the orphan-graph refusals, the cast-coverage check, the shared `assemble()` and
the measured mirror rules, and a rewrite discards all of that for a layout
change. A stage is a list of pointers into them; adding a tab is one line.
Absorbed pages became **tab modules** under `client/src/tool/` that take a
`ToolContext` -- the page described once -- rather than reaching for its
globals, which is the pattern for extracting the rest.

⚠ **A stage says what it lacks, and "unbuilt" is the word that matters.**
`GET /api/overview` reads the content tree AND the build manifests, and each
stage carries a badge: a character with no `.glb`, an animation set naming a
clip that was never built, a garment whose parts are not exported, an area
placing a mesh `build:environment` has not seen. Every one of those validates,
floods and draws nothing -- three of the taproom's four meshes did exactly
that for a whole session (D-625) -- and no report that only counted files
would have said so. Tested against a tree with one of everything unbuilt.

⚠ **The scenario editor refuses exactly what CI refuses.** `scenarioProblems`
is the one function on both paths (D-543's rule). An endgame area is refused
at the chip, before a save is attempted; a door out of the set is REPORTED
before saving and again after, as a warning, because an edge is legal and the
point is knowing where it is. The last live scenario cannot be deleted --
with none the lobby fills and never starts, which is D-569's trap with a new
face.

### Two small things found on the way

`DELETE` was never in either server's CORS allow-list although four DELETE
routes existed. And the cloth panel still told a person to *"reroll on the
Cast tab"*, a tab deleted with the procedural cast in D-617.

### Verified

Typecheck clean; tools and client suites green (one test moved from asserting
the Enemies tab in the HTML to asserting it in the registry). Live in the
browser against the merged server: the parts tab, the characters tab
assembling and animating a randomised figure and opening a saved one, the
cloth workbench on its placeholder body, the scenario editor refusing
`sunken-crypt` by name and round-tripping `ashfold` with its edge reported,
and the map builder listing every area through port 8150.

### Not done here, and next

The runtime half of MR4: a dependency map from content type to what it
invalidates, a **Publish** that runs only the invalidated builds, a content
**reload** on the running server, and the client's build-time imports moved
onto the server channel. Today a save still reaches the game the way it did
yesterday -- by somebody remembering which build to run and restarting.


## D-630 -- A save reaches the running game

**Status:** implemented
**Implements:** MR4 (the production line), second half. Completes D-629.

D-629 gave the tools one page, one server and an order. This is the other
half of the stakeholder's sentence -- *"making them accessible to the
runtime"*. Until now nothing linked a save to the game: no tool invoked a
build, the server had no reload, and three of the taproom's four meshes sat
unbuilt for a session with one `console.warn` each (D-625).

### The map is data

`shared/src/pipeline.ts` says, per content directory, which builds a save
invalidates and how the running server can take it: **hot** (swapped in
place -- items, classes, races, recipes, objectives, the roster, the
scenario, and the rest of the lookups), **warm** (areas: re-read, applied at
the next round reset, because the live world is entities instantiated from
them), **restart** (scripts: the Lua host loads them at boot), or **client**
(garments: baked manifest only). ⚠ **A directory with no entry fails a test**
that lists `content/` -- D-210's principle applied to the pipeline. Two
directories had been in exactly that state for months (D-576, D-578), found
one at a time by somebody noticing.

### Publish

The authoring server notes every directory it writes or deletes in.
`GET /api/publish` says what is pending; `POST /api/publish` runs only the
invalidated builds, in order, streaming NDJSON, then calls the game's
`POST /api/dm/reload-content` and reports the reply. The tool's Publish
control counts the pending work and says on hover what it will do.

⚠ **Two pending sets, cleared separately.** A build that finished is
finished whether or not the game was up to be told; a reload that could not
be delivered stays pending until it can. One flag would let "built but the
game never heard" read as "nothing to do".

⚠ The admin port comes from `.env` the way the server reads it -- a second
copy of the default is how `npm run bots` came to point at a port the server
was not on (D-628). The same drift was in the LOGIN FORM (`ws://…:8080`
while the server sat on 8095); Vite exposes `PORT` from the repository's
`.env` now.

### The reload

`GameServer.reloadContent(next)` swaps the lookups, re-seeds the emote
parser, hands the round engine its new objective pool (applied to the NEXT
deal -- the assignment a running round made was told to the antagonist and
must not move), hands the bot stable its roster, re-reads the live scenario,
and tells every connection. ⚠ **It reports what it could NOT apply rather
than claiming it did**: an area or a script that changed comes back as
`deferred` with the reason. Proven by a headless bot refused `use_item` on a
loaf the server had never heard of and, after the swap, answered by the
food rule instead -- two gates past "no such thing".

### Four channels to two

Animation sets, ground materials, weapon grips and the part catalogue were
Vite imports at build time -- a set authored in the tool needed a client
rebuild, a sixth pack's weapons were invisible until somebody edited a list
of five imports, and **`content/animations` had never been read by the game
server at all**. They ride the wire now as `render_content`, sent the moment
a socket opens (before auth: none of it is secret or per-player, and the
first snapshot needs it) and again after every reload. The client's modules
keep their synchronous lookups and gain a setter. ⚠ **`audio/sounds.json`
stays a build-time import**, and the map says why: the menu plays music
before a connection exists. Baked `.glb` and the Python map scripts are the
other channel that remains.

### Verified

Typecheck clean; the full suite green (see the commit); content validates.
Live, from the tool against a running game: a scenario save lit Publish
with "reload scenarios (hot)", and one click reported the game re-reading
21 directories; a character save lit it with "build:characters" and the
build streamed 150 lines into the panel before the reload. A fresh client
entered Ashfold with the wire-fed content and drew 300 placed meshes; the
grip path is asserted by the headless test (grips arrive, before auth, and
again after a reload) rather than by a live weapon, because nothing in the
lobby's roster carries one.

### Left open

`garments` reach the client only through the baked manifest; the server does
not load them. `EnvironmentAsset.operable` and asset `tags` still have no
reader. The **death-model swap** and **effects as content** do not exist.
Areas apply at a reset, not live -- making a placed asset appear in a running
world is a delta the world does not yet emit.


## D-631 -- Every mesh is filed from one place, and cloth is tuned on the real thing

**Status:** implemented
**Supersedes:** the workbench half of D-520 (the generated-grid garments) and
the placeholder body of D-617. Extends D-561's asset kinds with `projectile`.

Two asks from the stakeholder, both about the Art and Bodies stages of the
production line (D-629).

### 1. Asset filing

*"Make the Unfiled tab a filing tab, left-most on Art: all assets visible and
filed from here -- body part, clothing, weapon, pickup, environment -- with
more than one use allowed (an arrow is a pickup AND a projectile), existing
categories used to label what is already filed, and the unlabelled
highlighted."*

**Filing is not a new document.** It is READ off the files that already
decide what a mesh is -- the asset kinds under `content/assets/`, the `base`
tag under `content/parts/`, the creature definitions under
`content/characters/` -- and WRITTEN back into them. A separate filing file
would be a second source that drifts from the one the game reads, which is
D-576's mistake with a new name. So the Filing tab and the per-kind tabs are
two views of one set of files: ticking *weapon* on a mesh creates the entry
the Weapon assets tab then edits.

- **One mesh, several uses.** `FILING_USES` is body part, clothing, creature,
  weapon/worn, environment, pickup, projectile, helper. A use maps to an asset
  kind, a parts tag or a character definition; a mesh may carry any
  combination its shelf allows.
- **`projectile` is a fourth asset kind**, thin like `pickup`: which mesh,
  how it sits, a speed nobody has ratified. The game shoots nothing yet; the
  kind exists because filing needed it, and its properties belong to the
  combat rules when they arrive.
- **A face is never clothing.** Body part and clothing are one tag with two
  faces (`base`, D-562); the creation slots are body parts whatever the tag
  says, because a race curates faces.
- **Unfiling is refused by name** while an area places the asset, an item or a
  station is drawn as it, or a roamer looks like it. A clean delete and a
  broken build are the same act (D-569).
- **Unfiled is highlighted**, and that highlight is the tab's product: a mesh
  nobody has filed is a mesh no tab lists and no map can place. The dungeon
  pack had 24 on the day.

### 2. The cloth workbench

*"It uses the old procedural models. Rebuild it so I select clothing assets
and define the physics for those assets -- for example, capes."*

The old solver (D-403) simulated a grid it generated itself, pinned to a
placeholder body, and the workbench's output was a JSON block pasted into a
conversation for somebody to bake by hand. **The rebuilt one takes the pack's
own skinned mesh**: its vertices are the particles, its triangles' edges the
constraints, and which vertices hang free is read off the bone weights the
artist painted. A cape's collar is weighted to `Capes_01` on the spine and
stays where the animation puts it; the fall of the cape is weighted to
`back_02..back_05`, a chain nothing animates, and those are the vertices that
swing. Measured: 197 particles, 113 free, on the guard's feathered cape.

- **Settings are content**, `content/cloth/<pack>.json`, keyed by PART stem
  -- a garment covers five slots and many garments share one cape, so the
  physics belongs to the mesh. Free bones, a weight threshold, gravity,
  damping, stiffness, fold resistance, passes, wind, thickness, floor, and
  capsule colliders on named bones. Ratified by nobody; the seed is a cape
  that hangs and does not pass through the body.
- **The game applies it.** The loaders now say which part stands in which
  slot; `ImportedVisual` starts a solver per part with settings, hides the
  skinned original and draws a world-space proxy parented to the scene,
  because gravity and wind are world directions and the swing when a wearer
  turns is the whole effect. The wind the world already reported to
  `update()` -- ignored since the procedural cast went -- is used at last.
  Settings ride `render_content` (D-630) like the animation sets, so a Publish
  reaches a client that is already open.
- **The workbench is the game's own path.** A body assembled through the same
  `assemble()`, the same `MeshCloth`, the same clip library, with the part's
  weighted bones offered as the free-bone choice and the body's bones as
  colliders. Save writes the content file; Remove deletes the entry.

⚠ **Three things measured on the way that reading would not have found.**
`applyBoneTransform` takes the vertex IN the vector it is handed -- it does
not read the position attribute -- so an empty vector skins the origin and
every pinned particle lands on its bone's pivot, which looks like a cape
gathered into a point at the collar. The pack's FBX parts are **non-indexed
triangle soup** (every cape), so the solver makes a sequential index and welds
duplicated corners into shared particles, which is where the edges come from.
And a skinned test strip authored at the origin while its bone sat a metre up
hung below the floor: binding takes the current pose as rest, so a vertex sits
where the artist put it, not where its bone is.

⚠ **Deleted:** `render/cloth.ts`, `cloth-lab.ts`, `cloth-ui.ts`,
`render/workbench-body.ts`. The stakeholder's D-520 numbers described a
generated grid on a placeholder and have no meaning on a real mesh; nothing
else read them.

### Verified

Ten filing tests over a temporary tree (an arrow filed both ways; a face
refused as clothing; a placed barrel refused by name; a creature filed and
unfiled). Eight solver tests on a synthetic skinned strip (pins, hang, edge
lengths, following the bone, staying outside a collider, wind, non-indexed
input). Live: the dungeon pack's 24 unfiled meshes highlighted, one filed as a
pickup and unfiled again through the server; the feathered cape assembled on
a body in the workbench with the bones it is weighted to offered as choices.
Typecheck clean; content validates over 160 files.

### Open

The cape defaults are a starting point the workbench exists to replace. A
hood is weighted to the head and has nothing to swing; skirts (`hips`) are
offered and untried. Self-collision is not simulated. Ragdoll death drops the
cape with the body because the pins follow the skinned pose; nobody has
watched it.

### Addendum, same day: the whole body, the case of a bone, and a switch

Three corrections from the stakeholder playing the workbench.

**A cape collides with thighs, legs, feet, arms and hands**, not only the
trunk. `CAPE_COLLIDERS` now runs the trunk, both arms to the hands (spheres
on the fists), both legs to the toe bone. Tested: the defaults name every one
of those bones.

**The rig mixes case, and it was silently costing most of the body.**
Measured on the built guard: `Pelvis`, `UpperArm_L`, `Hand_L`, `Thigh_R`,
`Foot_R` beside `spine_02`, `lowerarm_l`, `calf_l`. A collider authored as
`thigh_l` matched nothing and was skipped without a word, so the cape passed
through a striding leg while the settings looked complete. Bones are matched
without case now, and a collider naming a bone the rig lacks is reported in
the workbench banner rather than dropped.

**Most parts do not need physics, and the first guess made them fall.** A
backpack is weighted entirely to `spine_02`; the workbench's fallback freed
its only anchor, so it dropped to the floor and collapsed -- the report was
accurate. A part whose weights are all on the body is **rigid** now: no
solver, a message saying so, and a **Physics ON/OFF** switch per part. Off
means no solver in the preview and no settings in content (Save removes any),
so the part rides the animation as the pack built it. On frees the guessed
chain, or whatever bones a person ticks.


## D-632 -- The dead are drawn as their race's ghost

**Status:** implemented
**Builds on:** D-203 (ghosts see only ghosts), D-572 (a character has a race),
D-594 (a creature is drawn as what its content says), D-631 (filing).

The stakeholder filed the dungeon pack's ghost meshes as creatures and asked
where the model for a dead player is defined. Nowhere: the dead were drawn as
themselves behind the veil (D-621), and a death-model swap was on the open
list from MR4.

### The ruling

**A race names its ghost look**: `ghost` on `content/races/<id>.json` is a
`content/characters/` id -- in practice a whole-mesh creature filed on Art
> Filing -- and is picked on the Races tab under Bodies. Per race, because a
race already decides what a body looks like and a dwarf's ghost should not
be an elf's. Absent means what every race did before: drawn as yourself.
Both shipped races point at `character-ghost-02`, as a default to replace.

### How it reaches a screen

- On death, the server sets the entity's `model` to the race's ghost before
  it announces the new ghost to the ghosts already present, so their
  `entity_entered` carries it (D-594's `model` field, unchanged).
- The dying player cannot be sent their own `entity_entered`, so a new delta
  event `entity_model` tells that one client which model it is now; the
  client rebuilds the visual from the same wire record. The living hear
  nothing, because they never hear of the ghost at all (D-203) -- a model
  change for someone you cannot see would leak the dead into the world of
  the living.
- The look survives a door: the transition re-spawn carries `model` across
  as it carries the hood and the kit (D-610).
- A revival re-spawns the entity without it.

⚠ **Refused where it is written.** CI, the race editor's save and the
server's content load all refuse a ghost look that names no character
definition; one that resolved to nothing would draw the dead from the seed
and never say why.

### Verified

Headless (`mr13-ghost-look`): a killed player is told to draw themselves as
the ghost and their killer, alive, learns nothing; a second ghost sees the
first as the ghost look and is seen the same way; no bot records a
violation. The Races tab offers every character definition as the look.

### Also here

Things > Interactive objects redrew the page as the Parts & names tab when
a station's art was shown: the shared asset preview re-rendered the core
tabs' panes from any section. It renders only the panes it belongs to.


## D-633 -- The simulation tests were never running at 5 ms, and CI had been red for five days

**Status:** implemented
**Corrects:** a constant thirty-nine files had copied, and the platform it hid.

The stakeholder asked why every GitHub workflow was failing. It had been
failing since 12 September (run #9, the first push after the August
successes): three simulation suites failing on every run and two or three
more flaking, while the same suite passed on the development machine every
time. Nobody could see it locally, which is exactly the shape of failure
D-114's doctrine warns about: a suite that is green in the one place anybody
looks.

### The measurement

`sim/probe/linux-kill.ts`, on Windows and inside a Linux Node 22 container
(which is what the CI runner is):

| `setInterval` at | Windows | Linux |
|---|---|---|
| 5 ms | 63 / s | 191 / s |
| 15 ms | 62 / s | 66 / s |
| 16 ms | 41 / s | -- |
| 20 ms | 31 / s | -- |

| `setTimeout` of | Windows | Linux |
|---|---|---|
| 5 ms | 15.6 | 5.1 |
| 30 ms | 30.9 | 30.2 |
| 50 ms | 61.9 | 50.2 |

Windows runs Node's timers on a 15.6 ms system clock and rounds every delay
UP to whole periods of it. Linux honours the number. Every simulation test
declared `const TICK = 5`, slept in multiples of it, and had been tuned by
trial against a world that ticked 63 times a second and waits that were
rounded up -- so on CI the same servers ran three times as fast against the
same waits. The reset fixture is the clean case: killing one of two players
ends the round, the round resolves in ten ticks and the reset stands the
victim back up. On Windows those ten ticks take 156 ms and the polling loop
sees the ghost; on Linux they take 50 ms and pass inside one iteration, so
the status read "alive" both before and after and the fixture reported that
nobody had died. The dungeon, the watch, thirst and the endgame door failed
the same way with different actors.

### The ruling

**The clock the tests were calibrated on is reproduced on every platform,
on purpose.** `sim/test/setup-clock.ts` runs before every test file and, off
Windows, rounds every `setTimeout` and `setInterval` in the process up to
15.625 ms periods. `sim/src/testTick.ts` holds the one `TICK` (5, the unit
the waits are written in), the one `TICK_INTERVAL_MS` the servers are asked
for (15: one period, 62/s on both platforms -- sixteen was tried first and
halved the rate, because an interval rounds up too), and the one `sleep`.
Forty-one files import them.

⚠ This is not a fix for wall-clock tests. It is the environment they were
tuned in, stated and reproduced, so that Linux and Windows run the same
simulation -- the property a test needs before it can mean anything. The
durable fix is tick-driven waits, and it is a rewrite of forty-nine files
that nobody has asked for yet.

### Three tests were wrong on their own terms, found by the tick stamps

The bot mirror now stamps every blow and every work report with its tick,
and records `deaths`. With that:

- **Reset invariants** observed a death by polling a status the reset
  overwrites. It reads the death event now.
- **The dungeon's loot** counted attempts, not kills; the seeded loot stream
  drops nothing on the first crawler and ore on the second, so one kill in
  six attempts was the miss. It counts kills now.
- **The struck worker** -- the intermittent recorded in three handoffs --
  had two faults. The thug was steered at the miner's own tile and the
  server finished the route: it walked into the miner's body and shoved them
  over a metre off the seam, which cancelled the job with "you moved" and put
  the retry out of reach (last job died at tick 131, first blow landed at
  218). And the retry never came, because "is a job running" was answered by
  ANY progress record rather than the latest. The thug stops beside the
  miner now, the latest record decides, and a refused restart walks back to
  the seam. Three passes in a row, where it had been a coin toss.

### Also here

Filing the pack's whole-cast Godot export as a creature stopped
`build:characters` by name (D-556's guard, working). The filing refuses it
now, before the definition exists: a mesh whose skeleton matches no rig
cannot be a creature, and the message says what such a file usually is.

### Verified

The eight suites that failed on CI, in the Linux container, 65 of 65; the
full suite on Windows.



## D-634 -- One tavern, and a latecomer is always good

**Status:** ratified by the stakeholder, 2026-09-17. Settles the two open
questions D-627 and D-579 left, without a line of server code.

### One tavern

Asked which of two taverns the round owned, the stakeholder answered that they
know of only one. They are right, and the "two taverns" were an artefact of
ids rather than of the world. `round-town` holds a tavern BUILDING in the
middle of Ashfold's square, and D-593 measured that every tile of its
footprint fails `canStandAt` -- it is a facade, and its keeper stands at the
door because there is no inside to stand in. The door on that facade leads
into `hanged-ferryman`, which is the taproom D-618 furnished and D-625 made
visible, and the room the stakeholder has stood in. From a player's side of
the screen that is one tavern: a building in the square with a taproom behind
its door. The id says "persistent world's first-slice tavern" because that is
what the room was authored as in M2; nothing about the room says so.

**The ruling:** the taproom is inside the round. `hanged-ferryman` joins the
Ashfold scenario's area set, so the door in the square works again and the
round's edge moves one room west, to the taproom's door onto the yard -- which
the boundary refuses exactly as it refused the tavern door, since the yard is
the road to the crypt (D-523). Nothing else changes: the round still opens in
the square (`opensIn`), the keeper the objective names still stands at the
door, and the persistent world still starts in the same room.

⚠ **Two keepers, and it is left that way on purpose.** The taproom has its own
scripted keeper (`ferryman-keeper`, "a heavyset keeper with scarred knuckles")
and Ashfold's stands at the door (`ashfold-keeper`, the one
`silence-the-keeper` names). With the room in the round both are on the map.
That is a content question -- one publican or two, and which one the
objective wants -- with a visible result, and it is the stakeholder's; the
objective is unaffected either way because it matches by descriptor.

⚠ **Not verified in play.** The boundary suite walks a bot through the square
door into the taproom and is refused at the yard door; that the taproom reads
right from inside a round is for the stakeholder's eyes.

### A latecomer is always good

D-579 recorded that the antagonist is dealt once, from the cast present at the
start, so anyone joining later is told `antagonist: false` -- and that the rest
of the cast can deduce it. The stakeholder's ruling: **latecomers join the
round on the good side.** The deduction cost is accepted. The code already did
this and `mr5-rejoin` has asserted it since D-579; what changes is that it is
no longer an open question.
