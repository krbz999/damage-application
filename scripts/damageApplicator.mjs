import {MODULE} from "./constants.mjs";

/**
 * An application that takes selected tokens, and lets you roll saving
 * throws and apply damage correctly via a the interface.
 */
export class DamageApplicator extends Application {
  constructor(data) {
    super(data);
    // The initiating damage roll.
    this.message = data.message;
    this.tokens = canvas.tokens.controlled;
    // The damage types and the bypasses (mgc, ada, sil);
    this.values = this.message.flags[MODULE].damage.values; // object of damage type to damage value
    this.bypasses = this.message.flags[MODULE].damage.bypasses;
    this.types = Object.keys(this.values);
    this.hasSave = this.message.flags[MODULE].damage.hasSave;
    this.saveData = this.message.flags[MODULE].damage.saveData;

    this.isTempHP = this.types.includes("temphp");
    this.isHealing = !this.isTempHP && this.types.includes("healing");
    this.isDamage = !this.isTempHP && !this.isHealing;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      width: 500,
      height: "100%",
      classes: [MODULE],
      resizable: true,
      scrollY: [],
      tabs: [],
      dragDrop: [],
      closeOnSubmit: false,
      template: `modules/${MODULE}/templates/damageApplicator.hbs`,
      top: 150,
      left: 150
    });
  }

  get title() {
    return `Damage Applicator: ${this.message.id}`;
  }

  get id() {
    return `${MODULE}-${this.message.uuid.replaceAll(".", "-")}`;
  }

  /**
   * The tokens that are targeted by this application of damage or healing. If the user is a GM,
   * use the selected tokens. If the user is not a GM, use their owned tokens. Either case,
   * broken tokens are filtered out.
   * @returns {Token[]}     An array of token placeables.
   */
  get targets() {
    const unfiltered = game.user.isGM ? this.tokens : canvas.tokens.placeables;
    return unfiltered.reduce((acc, token) => {
      if (!token.actor) return acc;
      if (token.actor.type === "group") return acc;
      const ok = game.user.isGM || token.actor.testUserPermission(game.user, "OWNER");
      if (ok) acc.push(token);
      return acc;
    }, []);
  }

  /** @override */
  async getData() {
    const data = await super.getData();

    // Actor data.
    data.actors = [];
    for (const token of this.targets) {
      const {dr, di, dv} = this._getActorDamageTraits(token.actor);
      data.actors.push({
        id: token.id,
        hasResistance: dr.length > 0,
        hasInvulnerability: di.length > 0,
        hasVulnerability: dv.length > 0,
        img: token.document.texture.src,
        name: token.actor.name.split(" ")[0].trim(),
        actorName: token.actor.name,
        hasPlayer: this._getActorHasActivePlayerOwner(token.actor),
        hp: token.actor.system.attributes.hp,
        dr, di, dv
      });
    }

    // Damage roll data.
    data.types = Object.entries(this.values).map(([type, value]) => ({
      type,
      value,
      label: CONFIG.DND5E.damageTypes[type] ?? CONFIG.DND5E.healingTypes[type] ?? type
    }));
    data.total = Object.values(this.values).reduce((acc, v) => acc + v, 0);
    data.isDamage = this.isDamage;
    data.isHealing = this.isHealing;
    data.isTempHP = this.isTempHP;

    // Item data.
    data.hasSave = this.hasSave && this.isDamage;
    if (data.hasSave) {
      data.save = {
        ability: this.saveData.ability,
        dc: Math.max(this.saveData.dc, this.message.flags.babonus?.saveDC || 0),
        label: CONFIG.DND5E.abilities[this.saveData.ability].label
      };
    }

    return data;
  }

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);
    html[0].querySelectorAll("[data-action]").forEach(n => {
      const action = n.dataset.action;
      if (action === "toggle-trait") n.addEventListener("click", this._onToggleTrait.bind(this));
      else if (action === "saving-throw") n.addEventListener("click", this._onRollSave.bind(this));
      else if (action === "toggle-throw") n.addEventListener("click", this._onToggleSuccess.bind(this));
      else if (action === "remove-actor") n.addEventListener("click", this._onRemoveActor.bind(this));
      else if (action === "pan-to-token") n.addEventListener("click", this._onPanToken.bind(this));
      else if (action === "apply-damage") n.addEventListener("click", this._onApplyDamage.bind(this));
      else if (action === "render-actor") n.addEventListener("click", this._onRenderActor.bind(this));
      else if (action === "apply-damage-all") n.addEventListener("click", this._onApplyDamageAll.bind(this));
      else if (action === "saving-throw-all") n.addEventListener("click", this._onRollSaveAll.bind(this));
    });
  }

  /** @override */
  async render(force = false, options = {}) {
    if (!this.targets.length) {
      ui.notifications.warn("You have no valid tokens.");
      return null;
    }
    return super.render(force, options);
  }

  /**
   * Render the sheet of the token's associated actor.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {ActorSheet}            The rendered actor sheet.
   */
  _onRenderActor(event) {
    return canvas.scene.tokens.get(event.currentTarget.closest(".actor").dataset.tokenId).actor.sheet.render(true);
  }

  /**
   * Apply damage, healing, or temphp to a single token's actor.
   * @param {PointerEvent} event      The initiating click event.
   */
  async _onApplyDamage(event) {
    const actorEl = event.currentTarget.closest(".actor");
    const actor = canvas.scene.tokens.get(actorEl.dataset.tokenId).actor;
    const values = {};
    for (const input of this.element[0].querySelectorAll(".damage-types .type input")) {
      values[input.dataset.key] = input.valueAsNumber || 0;
    }

    // If this is damage, apply resistances, immunities, vulnerabilities.
    const modifiers = actorEl.querySelectorAll(".trait-section .enabled");
    if (this.isDamage) {
      for (const mod of modifiers) {
        const data = mod.closest(".type").dataset;
        values[data.key] *= {dr: 0.5, di: 0, dv: 2}[data.trait];
      }
    }
    const total = Object.values(values).reduce((acc, v) => acc + v, 0);

    // Did the actor save?
    let multiplier = this.isHealing ? -1 : 1;
    const madeSave = actorEl.querySelector("[data-action='toggle-throw'].success");
    if (this.isDamage && madeSave) multiplier = 0.5;
    if (event.shiftKey) multiplier *= -1;

    if (!this.isTempHP) await actor.applyDamage(total, multiplier);
    else await actor.applyTempHP(total);
    this._updateHitPointValues(actorEl);
  }

  /**
   * Update the displayed hp values of an actor.
   * @param {HTMLElement} actor     The actor element in the application.
   */
  _updateHitPointValues(actor) {
    const hp = canvas.scene.tokens.get(actor.dataset.tokenId).actor.system.attributes.hp;
    const [value, temp, max, tempmax] = actor.querySelectorAll("[data-attr^='hp-']");
    value.innerText = hp.value;
    max.innerText = hp.max;
    if (hp.temp) temp.innerText = `(+${hp.temp})`;
    if (hp.tempmax) tempmax.innerText = `(+${hp.tempmax})`;
  }

  /**
   * Apply damage, healing, or temphp to all tokens' actors.
   * @param {PointerEvent} event      The initiating click event.
   */
  async _onApplyDamageAll(event) {
    this.element[0].querySelectorAll(".actor [data-action='apply-damage']").forEach(n => {
      n.dispatchEvent(new PointerEvent("click", event));
    });
  }

  /**
   * Roll saving throws for all tokens' actors.
   * @param {PointerEvent} event      The initiating click event.
   */
  async _onRollSaveAll(event) {
    this.element[0].querySelectorAll(".actor [data-action='saving-throw']").forEach(n => {
      if (n.style.pointerEvents !== "none") n.dispatchEvent(new PointerEvent("click", event));
    });
  }

  /**
   * Damage all tokens with the default respective damage types and values from the chatlog.
   * @param {PointerEvent} event        The initiating click event.
   * @param {boolean} [save=false]      Whether to roll saving throws first to halve the damage.
   */
  async damageAll(event, {save = false} = {}) {
    const heal = event.shiftKey && !save;
    const half = event.currentTarget.dataset.action === "quick-apply-half";
    for (const token of this.targets) {
      const values = foundry.utils.deepClone(this.values);
      if (this.isDamage) {
        const {dr, di, dv} = this._getActorDamageTraits(token.actor);
        for (const d of dr) if (!d.bypass) values[d.key] *= 0.5;
        for (const d of di) if (!d.bypass) values[d.key] *= 0;
        for (const d of dv) if (!d.bypass) values[d.key] *= 2;
      }
      let modifier = this.isHealing ? -1 : 1;
      if (this.hasSave && save && this.isDamage) {
        const roll = await token.actor.rollAbilitySave(this.saveData.ability, {
          event, targetValue: this.saveData.dc, fumble: null, critical: null
        });
        if (!roll) continue;
        if (roll.total >= this.saveData.dc) modifier = 0.5;
      }
      const total = Object.values(values).reduce((acc, v) => acc + v, 0);
      if (heal && !this.isTempHP) modifier *= -1;
      if (half) modifier *= 0.5;
      if (!this.isTempHP) await token.actor.applyDamage(total, modifier);
      else await token.actor.applyTempHP(total);
    }
  }

  /**
   * Pan to the relevant token on the canvas. Fade the UI for 5 seconds.
   * @param {PointerEvent} event      The initiating click event.
   */
  async _onPanToken(event) {
    const app = event.currentTarget.closest(".damage-application.app");
    app.classList.toggle("fade", true);
    const {x, y} = canvas.tokens.get(event.currentTarget.closest(".actor").dataset.tokenId).center;
    await canvas.animatePan({x, y, scale: 1, duration: 500});
    app.classList.toggle("fade", false);
  }

  /**
   * Remove an actor when the trash can button is clicked.
   * @param {PointerEvent} event      The initiating click event.
   */
  _onRemoveActor(event) {
    event.currentTarget.closest(".actor").remove();
  }

  /**
   * Perform a saving throw for the selected token's actor, then append the result just below.
   * @param {PointerEvent} event      The initiating click event.
   */
  async _onRollSave(event) {
    const target = event.currentTarget;
    target.style.pointerEvents = "none";
    const token = canvas.scene.tokens.get(target.closest(".actor").dataset.tokenId);
    const data = target.dataset;
    const roll = await token.actor.rollAbilitySave(data.ability, {event, targetValue: data.dc});
    if (!roll) {
      target.style.pointerEvents = "";
      return;
    }
    // Show roll result after this anchor.
    const res = target.closest(".util").querySelector("[data-action='toggle-throw']");
    res.classList.toggle("success", roll.total >= Number(data.dc));
    res.innerText = roll.total;
  }

  /**
   * Toggle the success state of a saving throw.
   * @param {PointerEvent} event      The initiating click event.
   */
  _onToggleSuccess(event) {
    event.currentTarget.classList.toggle("success");
  }

  /**
   * Toggle whether a trait should be taken into account for the purpose of applying damage.
   * @param {PointerEvent} event      The initiating click event.
   */
  _onToggleTrait(event) {
    event.currentTarget.classList.toggle("enabled");
  }

  /**
   * Get a target's relevant resistances, invulnerabilities, and vulnerabilities.
   * @param {Actor} actor     The actor to evaluate.
   * @returns {object}        An object with dx.key, .label, .bypass, for dx = dr, di, dv.
   */
  _getActorDamageTraits(actor) {
    return ["dr", "di", "dv"].reduce((acc, d) => {
      const trait = actor.system.traits[d];
      const types = new Set(trait.value);
      const bypasses = trait.bypasses.filter(b => this.bypasses.includes(b)); // the bypasses that matter.
      if (trait.custom?.length) {
        for (const val of trait.custom.split(";")) {
          const t = val.trim();
          if (t) types.add(t);
        }
      }

      for (const type of types) {
        if (!this.types.includes(type)) continue; // ignore types that aren't relevant for this damage roll.
        const hasBypass = CONFIG.DND5E.physicalDamageTypes[type] && (bypasses.size > 0);
        if (hasBypass) {
          for (const b of bypasses) {
            acc[d].push({
              key: type,
              label: `Non-${CONFIG.DND5E.physicalWeaponProperties[b].slice(0, 3)} ${CONFIG.DND5E.damageTypes[type]}`,
              bypass: b
            });
          }
        } else {
          acc[d].push({
            key: type,
            label: `${CONFIG.DND5E.damageTypes[type]}`
          });
        }
      }

      return acc;
    }, {dr: [], di: [], dv: []});
  }

  /**
   * Get whether a target has an active player owner.
   * @param {Actor} actor     The actor to evaluate.
   * @returns {boolean}       Whether the actor has an active player owner.
   */
  _getActorHasActivePlayerOwner(actor) {
    return game.users.some(user => {
      return !user.isGM && user.active && actor.testUserPermission(user, "OWNER");
    });
  }

  /**
   * Append button(s) to damage rolls.
   * @param {ChatMessage} message     The message being rendered.
   * @param {HTMLElement} html        The rendered html element.
   */
  static async _appendToDamageRolls(message, [html]) {
    if (!game.user.isGM) return;
    if (message.flags.dnd5e?.roll?.type !== "damage") return;
    const roll = html.querySelector(".dice-roll");
    const div = document.createElement("DIV");

    const types = Object.keys(message.flags[MODULE].damage.values);
    const data = {
      isTempHP: types.includes("temphp"),
      isHealing: !types.includes("temphp") && types.includes("healing"),
      isDamage: !types.includes("temphp") && !types.includes("healing"),
      save: message.flags[MODULE].damage.hasSave
    };
    div.innerHTML = await renderTemplate("modules/damage-application/templates/damageRollButtons.hbs", data);
    div.querySelectorAll("[data-action]").forEach(n => {
      const action = n.dataset.action;
      if (action === "render") {
        n.addEventListener("click", (event) => new DamageApplicator({message}).render(true));
      } else if (action === "quick-apply") {
        n.addEventListener("click", (event) => new DamageApplicator({message}).damageAll(event, {save: false}));
      } else if (action === "save-and-apply") {
        n.addEventListener("click", (event) => new DamageApplicator({message}).damageAll(event, {save: true}));
      } else if (action === "quick-apply-half") {
        n.addEventListener("click", (event) => new DamageApplicator({message}).damageAll(event, {save: false}));
      }
    });
    roll.after(div.firstElementChild);
  }

  /**
   * Append damage type and bypass properties to a damage roll message.
   * @param {Item} item         The item rolling damage.
   * @param {object} config     The configuration object for the damage roll.
   */
  static _appendDamageRollData(item, config) {
    const parts = item.system.damage.parts;
    const indices = {};

    let idx = 0;
    for (const [formula, type] of parts) {
      const terms = new CONFIG.Dice.DamageRoll(formula, config.data).terms;
      for (const term of terms) {
        if (!(term instanceof Die) && !(term instanceof NumericTerm)) continue;
        indices[idx] = type;
        idx++;
      }
    }

    const bypasses = item.system.properties ? Object.keys(CONFIG.DND5E.physicalWeaponProperties).filter(p => {
      return item.system.properties[p];
    }) : [];

    config.messageData[`flags.${MODULE}.damage`] = {
      indices,
      bypasses,
      hasSave: item.hasSave,
      saveData: item.system.save
    };
  }

  /**
   * Append more properties after the roll has been thrown into chat.
   * @param {ChatMessage} message     The message being posted in chat.
   */
  static _appendMoreDamageRollData(message) {
    if (message.flags.dnd5e?.roll?.type !== "damage") return;

    const indices = message.flags[MODULE].damage.indices;
    let currentType = indices[0];
    let idx = 0;

    const roll = message.rolls[0];
    const values = {};

    const damageLabels = Object.values(CONFIG.DND5E.damageTypes);

    for (const term of roll.terms) {
      if (!(term instanceof Die) && !(term instanceof NumericTerm)) continue;

      // If still looping over indices, use those, do nothing else.
      const ind = indices[idx];
      if (ind) {
        values[ind] = (values[ind] ?? 0) + term.total;
        currentType = ind;
        idx++;
        continue;
      }

      // If the term has flavor, use this as the damage type if it is valid, otherwise use the default type.
      const fl = term.options.flavor;
      let type;
      if (!fl) {
        // No flavor, use the type of the previous term.
        type = currentType;
      } else {
        const slg = fl.slugify({strict: true});

        // If the type exists, use that.
        if (fl in CONFIG.DND5E.damageTypes) type = fl;
        // If the type slugified exists, use that.
        else if (slg in CONFIG.DND5E.damageTypes) type = slg;
        // If the type is a proper label instead, use the type that corresponds to it.
        else if (damageLabels.includes(fl)) type = Object.entries(CONFIG.DND5E.damageTypes).find(dt => dt[1] === fl)[0];
        // Default to the default type.
        else type = indices[0];
      }
      values[type] = (values[type] ?? 0) + term.total;
      idx++;
    }

    // If the derived total is less than the actual total, add the remainder onto the first type.
    const valueTotal = Object.values(values).reduce((acc, v) => acc + v, 0);
    if (valueTotal < roll.total) values[indices[0]] += (roll.total - valueTotal);

    message.updateSource({[`flags.${MODULE}.damage`]: {values}, "flags.core.canPopout": true});
  }
}
