import {
  ATTRIBUTES,
  ATTRIBUTE_INFO,
  SLOT_GROUP,
  glanceChanceFor,
  resolveAttributes,
  type EquipSlot,
  type ServerMessage,
  type WireItem,
} from '@rc/shared';
import { dollSlots, packGearRows, type CatalogueItem } from './game/pack';

/**
 * The character panel (D-547): paperdoll, pack and sheet behind two tabs.
 *
 * One panel rather than three, because "what am I wearing", "what am I
 * carrying" and "what does that make me" are one question a player asks once
 * — and answering it across three windows is how a player ends up not
 * checking at all.
 *
 * Everything here is a VIEW. Equipping is a message; the server decides
 * whether it happened and the panel redraws from what comes back (D-102).
 * There is deliberately no optimistic update: a paperdoll that shows a sword
 * the server refused is worse than one that takes a tick to catch up.
 */

type Status = Extract<ServerMessage, { t: 'status' }>;

/** One thing the character can do, as the book renders it (D-553). */
export interface BookEntry {
  id: string;
  glyph: string;
  label: string;
  /**
   * Held but not usable yet. Shown anyway, and explicitly NOT draggable — a
   * bar slot that does nothing is the same lie D-538 refused for feats.
   */
  inert?: boolean;
  note?: string;
}

export interface CharacterPanelCallbacks {
  onEquip: (itemId: string, slot?: EquipSlot) => void;
  onUnequip: (itemId: string) => void;
  /** Eat it, drink it, bind a wound with it (D-554). */
  onUse: (templateId: string) => void;
  /** Put it on the floor, where anybody can pick it up. */
  onDrop: (itemId: string) => void;
  /** Pool it in the town's common stores (D-530). */
  onStock: (itemId: string) => void;
  /** Take something back out of the stores. Anybody may. */
  onTake: (itemId: string) => void;
  /** Ask what the stores hold, when the panel opens beside them. */
  onLookAtStores: () => void;
  /** What this character can do right now, for the Abilities tab. */
  book: () => { actions: BookEntry[]; rites: BookEntry[] };
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** The last segment of a store key, which is the facility a player sees. */
function storeName(station: string): string {
  const type = station.slice(station.lastIndexOf(':') + 1);
  return type === 'infirmary' ? 'the infirmary stores' : 'the common stores';
}

export class CharacterPanel {
  private tab: 'gear' | 'sheet' | 'book' = 'gear';
  private inventory: readonly WireItem[] = [];
  private catalogue: readonly CatalogueItem[] = [];
  private status: Status | null = null;
  /** Which item the player picked up, for click-a-slot-to-place. */
  private holding: { id: string; slots: EquipSlot[] } | null = null;
  /**
   * What the common stores hold, or null when there are none within reach.
   *
   * ⚠ Cleared by the server REFUSING a look, not by tracking where the
   * player is walking. The client does not own reach — the server does
   * (D-102) — and a panel that decided for itself would show a larder from
   * the other side of the square.
   */
  private stores: { station: string; items: readonly WireItem[] } | null = null;

  constructor(private cb: CharacterPanelCallbacks) {
    for (const btn of document.querySelectorAll<HTMLButtonElement>('.ctab')) {
      btn.addEventListener('click', () => {
        this.tab = (btn.dataset.tab as 'gear' | 'sheet' | 'book') ?? 'gear';
        this.render();
      });
    }
  }

  get visible(): boolean {
    return !$('char-panel').classList.contains('hidden');
  }

  toggle(): void {
    $('char-panel').classList.toggle('hidden');
    if (this.visible) {
      // ⚠ Asked once, on opening. The server pushes every later change to
      // everybody standing there, and a refusal is what clears the section —
      // so walking away and opening the pack shows no stores, without this
      // panel ever deciding for itself how far two tiles is (D-102).
      this.cb.onLookAtStores();
      this.render();
    }
  }

  hide(): void {
    $('char-panel').classList.add('hidden');
  }

  setInventory(items: readonly WireItem[]): void {
    this.inventory = items;
    // Whatever was picked up may have just been worn, dropped or looted.
    this.holding = null;
    if (this.visible) this.render();
  }

  /**
   * What the stores within reach hold, or null for "none within reach".
   *
   * ⚠ Pushed by the server whenever they change, to everybody standing
   * there — pooling is public, and that is its whole cost (D-530). This panel
   * never asks twice.
   */
  setStores(stores: { station: string; items: readonly WireItem[] } | null): void {
    this.stores = stores;
    if (this.visible) this.render();
  }

  setCatalogue(items: readonly CatalogueItem[]): void {
    this.catalogue = items;
    if (this.visible) this.render();
  }

  /**
   * The common stores, drawn above the pack when there are any within reach.
   *
   * ⚠ It shows what is there and NOT who put it there. There is no owner
   * recorded — the stores are common (D-530) — and inventing a "contributed
   * by" line would turn generosity into a scoreboard, which is exactly what
   * the north star forbids (D-303): the only reward for stocking the larder
   * is that other players saw you do it.
   */
  private renderStores(): void {
    const list = $('pack-list');
    if (!this.stores) return;
    const head = document.createElement('div');
    head.className = 'store-head';
    head.textContent = storeName(this.stores.station);
    list.appendChild(head);

    if (this.stores.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pack-empty';
      empty.textContent = 'Bare boards. Somebody has to fill them.';
      list.appendChild(empty);
      return;
    }
    for (const item of this.stores.items) {
      const el = document.createElement('div');
      el.className = 'pack-row store-row';
      const name = document.createElement('span');
      const label = this.catalogue.find((c) => c.id === item.templateId)?.name ?? item.templateId;
      name.textContent = label;
      const acts = document.createElement('span');
      acts.className = 'pack-acts';
      const take = document.createElement('button');
      take.textContent = 'take';
      take.title = `Take ${label} out of the stores`;
      take.addEventListener('click', (e) => {
        e.stopPropagation();
        this.cb.onTake(item.id);
      });
      acts.appendChild(take);
      const qty = document.createElement('span');
      qty.className = 'qty';
      qty.textContent = String(item.qty);
      el.append(name, acts, qty);
      list.appendChild(el);
    }
  }

  setStatus(status: Status): void {
    this.status = status;
    if (this.visible) this.render();
  }

  render(): void {
    for (const btn of document.querySelectorAll<HTMLButtonElement>('.ctab')) {
      btn.classList.toggle('active', btn.dataset.tab === this.tab);
    }
    $('tab-gear').classList.toggle('hidden', this.tab !== 'gear');
    $('tab-sheet').classList.toggle('hidden', this.tab !== 'sheet');
    $('tab-book').classList.toggle('hidden', this.tab !== 'book');
    if (this.tab === 'gear') this.renderGear();
    else if (this.tab === 'book') this.renderBook();
    else this.renderSheet();
  }

  // -------------------------------------------------------------------------
  // The book (D-553)
  // -------------------------------------------------------------------------

  private renderBook(): void {
    const { actions, rites } = this.cb.book();
    this.fillBook($('book-actions'), actions, 'Nothing yet.');
    this.fillBook($('book-rites'), rites, 'This calling knows no rites.');
  }

  private fillBook(host: HTMLElement, entries: BookEntry[], empty: string): void {
    host.innerHTML = '';
    if (entries.length === 0) {
      const none = document.createElement('div');
      none.className = 'pack-empty';
      none.textContent = empty;
      host.appendChild(none);
      return;
    }
    for (const entry of entries) {
      const el = document.createElement('div');
      el.className = `book-item${entry.inert ? ' inert' : ''}`;
      el.innerHTML = `<span class="bglyph">${entry.glyph}</span><span>${entry.label}</span>`
        + (entry.note ? `<span class="bnote">${entry.note}</span>` : '');
      if (!entry.inert) {
        el.draggable = true;
        // The same payload the drawer uses, so the bar's drop handler does not
        // need to know where a drag came from.
        el.addEventListener('dragstart', (e) => {
          e.dataTransfer?.setData('rc/ability', entry.id);
          e.dataTransfer?.setData('rc/from-slot', 'palette');
        });
      }
      host.appendChild(el);
    }
  }

  // -------------------------------------------------------------------------
  // Gear
  // -------------------------------------------------------------------------

  private renderGear(): void {
    const doll = $('paperdoll');
    doll.innerHTML = '';
    for (const view of dollSlots(this.inventory, this.catalogue)) {
      const cell = document.createElement('div');
      cell.className = `doll-slot ${SLOT_GROUP[view.slot]}${view.item ? ' filled' : ''}`;
      // A slot the held item could go in lights up — the affordance has to be
      // visible before the click, or picking something up looks like nothing
      // happened.
      if (this.holding?.slots.includes(view.slot)) cell.classList.add('drop');
      cell.innerHTML = `<span class="dslot">${view.label}</span>`;
      cell.appendChild(document.createTextNode(view.item ? view.item.name : '—'));
      if (this.holding) {
        if (this.holding.slots.includes(view.slot)) {
          const held = this.holding;
          cell.addEventListener('click', () => this.cb.onEquip(held.id, view.slot));
        }
      } else if (view.item) {
        const worn = view.item;
        cell.addEventListener('click', () => this.cb.onUnequip(worn.id));
      }
      doll.appendChild(cell);
    }

    const line = $('loadout-line');
    line.innerHTML = '';
    const s = this.status;
    if (s) {
      const over = s.loadout.weight > s.loadout.capacity;
      line.innerHTML =
        `armour <b>${s.loadout.armour}</b>`
        + `<span>weapon <b>+${s.loadout.damage}</b></span>`
        + `<span class="${over ? 'over' : ''}">load <b>${s.loadout.weight}</b>/${s.loadout.capacity}</span>`;
    }

    const list = $('pack-list');
    list.innerHTML = '';
    this.renderStores();
    const rows = packGearRows(this.inventory, this.catalogue);
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pack-empty';
      empty.textContent = 'Nothing but lint.';
      list.appendChild(empty);
      return;
    }
    for (const row of rows) {
      const el = document.createElement('div');
      el.className = `pack-row${row.equipItemId ? ' wearable' : ''}`;
      const name = document.createElement('span');
      name.textContent = row.name;
      if (row.equipItemId) {
        const verb = document.createElement('span');
        verb.className = 'verb';
        // Rings are why a single slot is not always enough: two hands, and
        // the player has an opinion about which.
        verb.textContent = row.slots.length > 1 ? '· pick a hand' : '· wear';
        name.appendChild(verb);
      }
      const qty = document.createElement('span');
      qty.className = 'qty';
      qty.textContent = String(row.qty);

      // The verbs live on BUTTONS rather than on the row, because a row that
      // does three different things depending on where you click is a row
      // nobody trusts. Clicking the row still equips — that was already true
      // and is the common case — but eating and dropping say so.
      const acts = document.createElement('span');
      acts.className = 'pack-acts';
      if (row.useItemId) {
        const use = document.createElement('button');
        use.textContent = row.useVerb ?? 'use';
        use.title = `${row.useVerb ?? 'Use'} — ${row.name}`;
        use.addEventListener('click', (e) => {
          e.stopPropagation();
          this.cb.onUse(row.useItemId!);
        });
        acts.appendChild(use);
      }
      if (row.dropItemId) {
        const drop = document.createElement('button');
        drop.textContent = 'drop';
        drop.title = `Put one ${row.name} on the floor, where anybody can take it`;
        drop.addEventListener('click', (e) => {
          e.stopPropagation();
          this.cb.onDrop(row.dropItemId!);
        });
        acts.appendChild(drop);
      }
      // ⚠ Only beside the stores, because it is only possible there — an
      // affordance that is always drawn and usually refused teaches players
      // to ignore the refusal.
      if (this.stores && row.dropItemId) {
        const stock = document.createElement('button');
        stock.textContent = 'stock';
        stock.title =
          `Put one ${row.name} into ${storeName(this.stores.station)}. `
          + 'Anybody can take it, and it is one thing to ruin.';
        stock.addEventListener('click', (e) => {
          e.stopPropagation();
          this.cb.onStock(row.dropItemId!);
        });
        acts.appendChild(stock);
      }
      el.append(name, acts, qty);
      if (row.equipItemId) {
        const itemId = row.equipItemId;
        const slots = row.slots;
        el.addEventListener('click', () => {
          if (slots.length > 1) {
            // Ambiguous: hold it and let them choose the slot on the doll.
            this.holding = { id: itemId, slots };
            this.render();
          } else {
            this.cb.onEquip(itemId, slots[0]);
          }
        });
      }
      list.appendChild(el);
    }
  }

  // -------------------------------------------------------------------------
  // Sheet
  // -------------------------------------------------------------------------

  private renderSheet(): void {
    const s = this.status;
    const attrsEl = $('sheet-attrs');
    attrsEl.innerHTML = '';
    if (!s) return;
    const attrs = resolveAttributes(s.attributes);
    for (const attr of ATTRIBUTES) {
      const row = document.createElement('div');
      row.className = 'sheet-attr';
      row.innerHTML =
        `<span>${ATTRIBUTE_INFO[attr].name}`
        + `<span class="blurb">${ATTRIBUTE_INFO[attr].blurb}</span></span>`
        + `<b>${attrs[attr]}</b>`;
      attrsEl.appendChild(row);
    }
    // Derived numbers beside the attributes that produced them. The point of
    // showing both is that the player can see WHY the number is what it is —
    // a sheet that only reports outcomes teaches nobody how to build.
    $('sheet-derived').textContent =
      `Level ${s.level} · ${s.hp}/${s.maxHp} health · ${s.mana}/${s.maxMana} reserve · `
      + `armour ${s.loadout.armour} · weapon +${s.loadout.damage} · `
      // Reach and swings-per-round are the two numbers that decide a fight
      // and neither is visible anywhere else (D-550).
      + `reach ${s.reach} · ${s.attacksPerRound} attack${s.attacksPerRound === 1 ? '' : 's'} a round · `
      + `${Math.round(glanceChanceFor(attrs) * 100)}% turned aside · `
      + `carrying ${s.loadout.weight}/${s.loadout.capacity}`;

    const skills = $('sheet-skills');
    skills.innerHTML = '';
    const held = Object.entries(s.skills)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    if (held.length === 0) skills.textContent = 'Nothing you would put a name to.';
    for (const [id, value] of held) {
      const span = document.createElement('span');
      span.innerHTML = `${id} <b>${value}</b>`;
      skills.appendChild(span);
    }

    const feats = $('sheet-feats');
    feats.innerHTML = '';
    const all = [...s.feats, ...s.spells, ...s.abilities];
    feats.textContent = all.length > 0 ? all.join(' · ') : 'None yet.';
  }
}
