/**
 * An application that takes selected tokens, and lets you roll saving
 * throws and apply damage correctly via a the interface.
 */
export class DamageApplicator extends Application {
  static MODULE = "damage-application";

  static init() {
    Hooks.on("renderChatMessage", DamageApplicator._appendToDamageRolls);
    Hooks.on("dnd5e.preRollDamage", DamageApplicator._appendDamageRollData);
    Hooks.on("preCreateChatMessage", DamageApplicator._appendMoreDamageRollData);
  }

  constructor(data) {
    super(data);
    // The initiating damage roll.
    this.message = data.message;
    this.tokens = canvas.tokens.controlled;
    // The damage types and the bypasses (mgc, ada, sil);
    const messageData = foundry.utils.deepClone(this.message.flags[DamageApplicator.MODULE] ?? {});
    this.values = messageData.damage.values; // object of damage type to damage value
    this.bypasses = messageData.damage.bypasses;
    this.types = Object.keys(this.values);
    this.hasSave = messageData.damage.hasSave;
    this.saveData = messageData.damage.saveData;

    this.isTempHP = this.types.includes("temphp");
    this.isHealing = !this.isTempHP && this.types.includes("healing");
    this.isDamage = !this.isTempHP && !this.isHealing;

    this.toggles = {};

    // Data model.
    this.model = new (class DamageApplicationModel extends foundry.abstract.TypeDataModel {
      static defineSchema() {
        return {
          tokens: new foundry.data.fields.ArrayField(new foundry.data.fields.DocumentIdField()),
          values: new foundry.data.fields.SchemaField(Object.keys(CONFIG.DND5E.damageTypes).reduce((acc, key) => {
            acc[key] = new foundry.data.fields.NumberField({integer: true, min: 0, initial: 0})
            return acc;
          }, {})),
          bypasses: new foundry.data.fields.ArrayField(new foundry.data.fields.StringField())
        };
      }

      prepareDerivedData() {
        this.actors = this.tokens.reduce((acc, tokenId) => {
          const actor = canvas.scene.tokens.get(tokenId)?.actor;
          if (!actor || actor.type === "group") return acc;
          if (actor.testUserPermission(game.user, "OWNER")) acc.add(actor);
          return acc;
        }, new Set());
        for (const key in this.values) if (!this.values[key]) delete this.values[key];
      }

    })({
      tokens: this.tokens.map(t => t.document.id),
      values: this.values,
      bypasses: this.bypasses
    });

    this.model.prepareDerivedData();
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: [DamageApplicator.MODULE],
      template: "modules/damage-application/templates/application.hbs",
      width: 620
    });
  }

  get title() {
    return game.i18n.format("DAMAGE_APP.ApplicationTitle", {id: this.message.id});
  }

  get id() {
    return `${DamageApplicator.MODULE}-${this.message.id}`;
  }

  /** @override */
  async getData() {
    const data = await super.getData();

    // Actor data.
    data.actors = [];
    for (const actor of this.model.actors) {
      const uuid = actor.uuid.replaceAll(".", "-");
      const {dr, di, dv} = this._getActorDamageTraits(actor);
      const save = foundry.utils.getProperty(this.toggles, `${uuid}.save`) ?? {success: null, total: 0};
      console.warn(save);

      data.actors.push({
        hasResistance: dr.length > 0,
        hasInvulnerability: di.length > 0,
        hasVulnerability: dv.length > 0,
        img: actor.img,
        name: actor.name.split(" ")[0].trim(),
        actorName: actor.name,
        hasPlayer: this._getActorHasActivePlayerOwner(actor),
        hp: actor.system.attributes.hp,
        dr, di, dv,
        actorUuid: uuid,
        save: {success: save.success, total: save.total.paddedString(2)},
        saveIcon: save.success === null ? "fa-person-falling-burst" : save.success ? "fa-check" : "fa-times"
      });
    }

    // Damage roll data.
    data.types = Object.entries(this.model.values).map(([type, value]) => ({
      type, value, label: CONFIG.DND5E.damageTypes[type] ?? CONFIG.DND5E.healingTypes[type] ?? type
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
      else if (action === "saving-throw") {
        n.addEventListener("click", this._onRollSave.bind(this));
        n.addEventListener("contextmenu", this._onToggleSuccess.bind(this));
      } else if (action === "pan-to-token") n.addEventListener("click", this._onPanToken.bind(this));
      else if (action === "apply-damage") n.addEventListener("click", this._onApplyDamage.bind(this));
      else if (action === "render-actor") n.addEventListener("click", this._onRenderActor.bind(this));
      else if (action === "apply-damage-all") n.addEventListener("click", this._onApplyDamageAll.bind(this));
      else if (action === "saving-throw-all") n.addEventListener("click", this._onRollSaveAll.bind(this));
    });
    html[0].querySelectorAll(".damage-types [name]").forEach(n => {
      n.addEventListener("change", this._onChangeDamageValue.bind(this));
    });
  }

  /** @override */
  async render(force = false, options = {}) {
    if (force) {
      options.top = 150;
      options.left = 150;
    }
    if (!this.model.actors.size) {
      ui.notifications.warn("DAMAGE_APP.YouHaveNoValidTokens", {localize: true});
      return null;
    }
    for (const actor of this.model.actors) actor.apps[this.id] = this;
    this.model.prepareDerivedData();
    return super.render(force, options);
  }

  /** @override */
  async close(...args) {
    for (const actor of this.model.actors) delete actor.apps[this.id];
    return super.close(...args);
  }

  /**
   * Update the data model when changing the value of a damage roll.
   * @param {PointerEvent} event      The initiating change event.
   */
  _onChangeDamageValue(event) {
    const data = new FormDataExtended(event.currentTarget.closest("FORM")).object;
    this.model.updateSource(data);
    console.warn(data);
    this.render();
  }

  /**
   * Render the sheet of the token's associated actor.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {ActorSheet}            The rendered actor sheet.
   */
  _onRenderActor(event) {
    const uuid = event.currentTarget.closest("[data-actor-uuid]").dataset.actorUuid.replaceAll("-", ".");
    return fromUuidSync(uuid).sheet.render(true);
  }

  /**
   * Apply damage, healing, or temphp to a single token's actor.
   * @param {PointerEvent} event      The initiating click event.
   */
  async _onApplyDamage(event) {
    const actorEl = event.currentTarget.closest("[data-actor-uuid]");
    const uuid = actorEl.dataset.actorUuid;
    const actor = fromUuidSync(uuid.replaceAll("-", "."));
    const values = foundry.utils.deepClone(this.model.values);

    // If this is damage, apply resistances, immunities, vulnerabilities.
    const modifiers = actorEl.querySelectorAll(".trait-section .enabled");
    if (this.isDamage) {
      for (const mod of modifiers) {
        const data = mod.dataset;
        values[data.key] *= {dr: 0.5, di: 0, dv: 2}[data.trait];
      }
    }
    const total = Object.values(values).reduce((acc, v) => acc + v, 0);

    // Did the actor save?
    let multiplier = this.isHealing ? -1 : 1;
    const madeSave = !!foundry.utils.getProperty(this.toggles, `${uuid}.save.success`);
    if (this.isDamage && madeSave) multiplier = 0.5;
    if (event.shiftKey) multiplier *= -1;

    return this.isTempHP ? actor.applyTempHP(total) : actor.applyDamage(total, multiplier);
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
    for (const actor of this.model.actors) {
      const values = foundry.utils.deepClone(this.model.values);
      if (this.isDamage) {
        const {dr, di, dv} = this._getActorDamageTraits(actor);
        for (const d of dr) if (!d.bypass) values[d.key] *= 0.5;
        for (const d of di) if (!d.bypass) values[d.key] *= 0;
        for (const d of dv) if (!d.bypass) values[d.key] *= 2;
      }
      let modifier = this.isHealing ? -1 : 1;
      if (this.hasSave && save && this.isDamage) {
        const roll = await actor.rollAbilitySave(this.saveData.ability, {
          event, targetValue: this.saveData.dc, fumble: null, critical: null
        });
        if (!roll) continue;
        if (roll.total >= this.saveData.dc) modifier = 0.5;
      }
      const total = Object.values(values).reduce((acc, v) => acc + v, 0);
      if (heal && !this.isTempHP) modifier *= -1;
      if (half) modifier *= 0.5;
      if (!this.isTempHP) {
        const bonus = (heal && half && ((total % 2 === 1))) ? -0.5 : 0;
        await actor.applyDamage(Math.max(0, total + bonus), modifier);
      } else {
        await actor.applyTempHP(total);
      }
    }
  }

  /**
   * Pan to the relevant token on the canvas. Fade the UI for 5 seconds.
   * @param {PointerEvent} event      The initiating click event.
   */
  async _onPanToken(event) {
    const uuid = event.currentTarget.closest("[data-actor-uuid]").dataset.actorUuid.replaceAll("-", ".");
    const actor = fromUuidSync(uuid);
    const token = actor.token?.object ?? actor.getActiveTokens()[0];
    if (!token) return null;
    const app = event.currentTarget.closest(".damage-application.app");
    app.classList.toggle("fade", true);
    await canvas.animatePan({...token.center, scale: 1, duration: 500});
    app.classList.toggle("fade", false);
  }

  /**
   * Perform a saving throw for the selected token's actor, then append the result just below.
   * @param {PointerEvent} event      The initiating click event.
   */
  async _onRollSave(event) {
    const target = event.currentTarget;
    target.style.pointerEvents = "none";
    const uuid = target.closest("[data-actor-uuid]").dataset.actorUuid;
    const actor = fromUuidSync(uuid.replaceAll("-", "."));
    const data = target.dataset;
    const roll = await actor.rollAbilitySave(data.ability, {event, targetValue: data.dc});
    if (!roll) {
      target.style.pointerEvents = "";
      return null;
    }
    // Show roll result after this anchor.
    const success = roll.total >= Number(data.dc);
    foundry.utils.setProperty(this.toggles, `${uuid}.save`, {success, total: roll.total});
    this.render();
  }

  /**
   * Toggle the success state of a saving throw.
   * @param {PointerEvent} event      The initiating right-click event.
   */
  _onToggleSuccess(event) {
    const uuid = event.currentTarget.closest("[data-actor-uuid]").dataset.actorUuid;
    const state = foundry.utils.getProperty(this.toggles, `${uuid}.save.success`);
    console.warn({event, uuid, state, isBool: typeof state === "boolean"});
    if (!(typeof state === "boolean")) return null;
    foundry.utils.setProperty(this.toggles, `${uuid}.save.success`, !state);
    this.render();
  }

  /**
   * Toggle whether a trait should be taken into account for the purpose of applying damage.
   * @param {PointerEvent} event      The initiating click event.
   */
  _onToggleTrait(event) {
    event.currentTarget.classList.toggle("enabled");
    const state = event.currentTarget.classList.contains("enabled");
    const d = event.currentTarget.dataset.trait;
    const type = event.currentTarget.dataset.key;
    const uuid = event.currentTarget.closest("[data-actor-uuid]").dataset.actorUuid;
    foundry.utils.setProperty(this.toggles, `${uuid}.${d}.${type}`, state);
    this.render();
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
        const typeLabel = CONFIG.DND5E.damageTypes[type] ?? type;
        let toggled = foundry.utils.getProperty(this.toggles, `${actor.uuid.replaceAll(".", "-")}.${d}.${type}`) ?? null;
        toggled = toggled ?? !hasBypass;
        if (hasBypass) {
          for (const b of bypasses) {
            const property = CONFIG.DND5E.physicalWeaponProperties[b].slice(0, 3);
            acc[d].push({
              key: type,
              label: game.i18n.format("DAMAGE_APP.NonSpecialProperty", {prop: property, label: typeLabel}),
              bypass: b,
              toggled
            });
          }
        } else {
          acc[d].push({
            key: type,
            label: typeLabel,
            toggled
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

    const types = Object.keys(message.flags[DamageApplicator.MODULE].damage.values);
    const data = {
      isTempHP: types.includes("temphp"),
      isHealing: !types.includes("temphp") && types.includes("healing"),
      isDamage: !types.includes("temphp") && !types.includes("healing"),
      save: message.flags[DamageApplicator.MODULE].damage.hasSave
    };
    div.innerHTML = await renderTemplate("modules/damage-application/templates/buttons.hbs", data);
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

    config.messageData[`flags.${DamageApplicator.MODULE}.damage`] = {
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

    const indices = message.flags[DamageApplicator.MODULE].damage.indices;
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
        const indOf = roll.terms.indexOf(term);
        if (indOf > 0 && (roll.terms[indOf - 1] instanceof OperatorTerm) && (roll.terms[indOf - 1].operator === "-")) {
          values[ind] = (values[ind] ?? 0) - term.total;
        } else {
          values[ind] = (values[ind] ?? 0) + term.total;
        }
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

    message.updateSource({[`flags.${DamageApplicator.MODULE}.damage`]: {values}, "flags.core.canPopout": true});
  }
}

Hooks.once("init", DamageApplicator.init);
