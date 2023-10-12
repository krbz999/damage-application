/**
 * An application that takes selected tokens, and lets you roll saving
 * throws and apply damage correctly via a the interface.
 */
export class DamageApplicator extends Application {
  /**
   * The module's id.
   * @type {string}
   */
  static MODULE = "damage-application";

  /** Initialize module. */
  static init() {
    Hooks.on("renderChatMessage", DamageApplicator._appendToDamageRolls);
    Hooks.on("dnd5e.preRollDamage", DamageApplicator._appendDamageRollData);
    Hooks.on("preCreateChatMessage", DamageApplicator._appendMoreDamageRollData);
    game.modules.get(DamageApplicator.MODULE).api = DamageApplicator;
  }

  /**
   * @constructor
   * @param {ChatMessage} message
   */
  constructor(message) {
    super();
    // The initiating damage roll.
    this.message = message;

    // Set token actors depending on user status.
    this.actors = this.constructor._getActors();

    // The damage types and the bypasses (mgc, ada, sil).
    const messageData = foundry.utils.deepClone(this.message.flags[DamageApplicator.MODULE]);
    this.hasSave = messageData.damage.hasSave;
    this.saveData = messageData.damage.saveData;

    // Data model.
    this.model = new (class DamageApplicationModel extends foundry.abstract.TypeDataModel {
      /** @override */
      static defineSchema() {
        const fields = foundry.data.fields;
        return {
          values: new fields.SchemaField(Object.keys(CONFIG.DND5E.damageTypes).reduce((acc, key) => {
            acc[key] = new fields.NumberField({integer: true, min: 0, initial: 0})
            return acc;
          }, {})),
          bypasses: new fields.SetField(new fields.StringField())
        };
      }

      /** @override */
      prepareDerivedData() {
        for (const key in this.values) if (!this.values[key]) delete this.values[key];
      }

    })({values: messageData.damage.values, bypasses: messageData.damage.bypasses});

    this.model.prepareDerivedData();
  }

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: [DamageApplicator.MODULE],
      template: "modules/damage-application/templates/application.hbs",
      width: 620
    });
  }

  /** @override */
  get title() {
    return game.i18n.format("DAMAGE_APP.ApplicationTitle", {id: this.message.id});
  }

  /** @override */
  get id() {
    return `${DamageApplicator.MODULE}-${this.message.id}`;
  }

  /** @override */
  async getData() {
    const data = {};

    // Actor data.
    this._prepareActors();
    data.actors = Object.values(this.actorData);

    // Damage roll data.
    data.types = Object.entries(this.model.values).reduce((acc, [type, value]) => {
      const label = CONFIG.DND5E.damageTypes[type] ?? CONFIG.DND5E.healingTypes[type];
      if (label) acc.push({type: type, value: value, label: label});
      return acc;
    }, []);
    data.total = Object.values(this.model.values).reduce((acc, v) => acc + v, 0);

    // Item data.
    data.hasSave = this.hasSave;
    if (data.hasSave) {
      data.save = {
        ability: this.saveData.ability,
        dc: Math.max(this.saveData.dc, this.message.flags.babonus?.saveDC || 0),
        label: CONFIG.DND5E.abilities[this.saveData.ability].label
      };
    }

    return data;
  }

  /** Prepare the internal `actorData` object. */
  _prepareActors() {
    const types = Object.keys(this.model.values);

    for (const actor of this.actors) {
      const uuid = actor.uuid;
      this.actorData ??= {};

      const data = this.actorData[uuid] ??= {};

      const clone = data.clone ??= actor.clone({}, {keepId: true});
      data.actor = actor;
      data.img = actor.img;
      data.name = actor.name.split(" ")[0].trim();
      data.actorName = actor.name;
      data.hasPlayer = game.users.some(user => !user.isGM && user.active && actor.testUserPermission(user, "OWNER"));
      data.hp = actor.system.attributes.hp;
      data.actorUuid = uuid;
      data.saved ??= null;
      data.savedCssClass = data.saved ? "success" : data.saved === false ? "failure" : "";
      data.saveIcon = data.saved === null ? "fa-person-falling-burst" : data.saved ? "fa-check" : "fa-times";
      ["dr", "di", "dv"].forEach(d => {
        data[d] = [];
        for (const value of actor.system.traits[d].value) {
          if (!(value in CONFIG.DND5E.damageTypes) || !types.includes(value)) continue;

          const traitBypasses = actor.system.traits[d].bypasses;

          // Is this type invalid due to beibng a physical damage type and bypassed?
          const isPhysical = value in CONFIG.DND5E.physicalDamageTypes;
          const isBypassed = this.model.bypasses.length > 0;
          const actorBypasses = traitBypasses.intersects(new Set(this.model.bypasses));
          if (isPhysical && isBypassed && actorBypasses) continue;


          const bypass = isPhysical && (traitBypasses.size > 0);
          let label;
          if (bypass) {
            label = game.i18n.format("DND5E.DamagePhysicalBypasses", {
              damageTypes: CONFIG.DND5E.damageTypes[value],
              bypassTypes: [...traitBypasses.map(p => CONFIG.DND5E.physicalWeaponProperties[p])].filterJoin(", ")
            });
          } else {
            label = CONFIG.DND5E.damageTypes[value]
          }
          data[d].push({
            key: value,
            bypass: bypass,
            label: label,
            enabled: clone.system.traits[d].value.has(value)
          });
        }
      });
      data.hasResistance = data.dr.length > 0;
      data.hasInvulnerability = data.di.length > 0;
      data.hasVulnerability = data.dv.length > 0;
    }
  }

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);
    html[0].querySelectorAll("[data-action]").forEach(n => {
      const action = n.dataset.action;
      if (action === "toggle-trait") n.addEventListener("click", this._onToggleTrait.bind(this));
      else if (action === "pan-to-token") n.addEventListener("click", this._onPanToken.bind(this));
      else if (action === "render-actor") n.addEventListener("click", this._onRenderActor.bind(this));
      else if (action === "apply-damage") n.addEventListener("click", this._onClickApplyDamage.bind(this));
      else if (action === "apply-damage-all") n.addEventListener("click", this._onClickApplyDamageAll.bind(this));
      else if (action === "saving-throw-all") n.addEventListener("click", this._onClickRollSaveAll.bind(this));
      else if (action === "saving-throw") {
        n.addEventListener("click", this._onClickRollSave.bind(this));
        n.addEventListener("contextmenu", this._onToggleSuccess.bind(this));
      }
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
    if (!this.actors.size) {
      ui.notifications.warn("DAMAGE_APP.YouHaveNoValidTokens", {localize: true});
      return null;
    }
    for (const actor of this.actors) actor.apps[this.id] = this;
    this.model.prepareDerivedData();
    return super.render(force, options);
  }

  /** @override */
  async close(...args) {
    for (const actor of this.actors) delete actor.apps[this.id];
    return super.close(...args);
  }

  /**
   * Update the data model when changing the value of a damage roll.
   * @param {PointerEvent} event      The initiating change event.
   */
  _onChangeDamageValue(event) {
    const data = new FormDataExtended(event.currentTarget.closest("FORM")).object;
    this.model.updateSource(data);
    this.render();
  }

  /**
   * Render the sheet of the token's associated actor.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {ActorSheet}            The rendered actor sheet.
   */
  _onRenderActor(event) {
    const uuid = event.currentTarget.closest("[data-actor-uuid]").dataset.actorUuid;
    return this.actorData[uuid].actor.sheet.render(true);
  }

  /**
   * Handle applying damage to one actor.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {Promise<Actor5e>}
   */
  async _onClickApplyDamage(event) {
    const uuid = event.currentTarget.closest("[data-actor-uuid]").dataset.actorUuid;
    return this._applyDamageToActor(uuid);
  }

  /**
   * Apply damage to all actors in the application.
   * @returns {Promise<Actor5e[]>}
   */
  async _onClickApplyDamageAll() {
    return Promise.all(Object.keys(this.actorData).map(uuid => this._applyDamageToActor(uuid)));
  }

  /**
   * Apply damage to one actor from its uuid.
   * @param {string} uuid     The uuid of an actor in this application.
   * @returns {Promise<Actor5e>}
   */
  async _applyDamageToActor(uuid) {
    const {actor, clone, saved} = this.actorData[uuid];
    const {values, bypasses} = this.model;
    const damage = this.constructor.calculateDamage(clone, values, bypasses);
    return actor.applyDamage(damage, !!saved ? 0.5 : 1);
  }
  /**
   * Perform a saving throw for the selected token's actor, then append the result just below.
   * @param {PointerEvent} event      The initiating click event.
   */
  async _onClickRollSave(event) {
    const uuid = event.currentTarget.closest("[data-actor-uuid]").dataset.actorUuid;
    event.currentTarget.style.pointerEvents = "none";
    const actor = this.actorData[uuid].actor;
    if (!this.constructor.canDamageActor(actor)) return null;
    const saveData = this.saveData;
    const roll = await this.constructor.rollAbilitySave(actor, saveData.ability, saveData.dc, {event});
    if (roll !== null) this.actorData[uuid].saved = roll;
    this.render();
  }

  /**
   * Roll saving throws for all actors in the application.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {Promise<void>}
   */
  async _onClickRollSaveAll(event) {
    const data = this.saveData;
    for (const uuid in this.actorData) {
      const actor = this.actorData[uuid].actor;
      if (!this.constructor.canDamageActor(actor)) continue;
      const roll = await this.constructor.rollAbilitySave(actor, data.ability, data.dc, {event});
      if (roll !== null) this.actorData[uuid].saved = roll;
    }
    this.render();
  }

  /* -------------------------------------- */
  /*                                        */
  /*       DAMAGE ROLL EVENT HANDLERS       */
  /*                                        */
  /* -------------------------------------- */

  /**
   * Helper method to get module data from the chat message of a click event.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {object}                An object with `bypasses`, `saveData`, and `values`.
   */
  static _getDataFromDamageRoll(event) {
    const id = event.currentTarget.closest("[data-message-id]").dataset.messageId;
    const message = game.messages.get(id);
    return message.flags[DamageApplicator.MODULE].damage;
  }

  /**
   * Helper method to get actors from selected or assigned tokens.
   * @returns {Set<Actor5e>}
   */
  static _getActors() {
    const selected = canvas.tokens.controlled;
    let tokens;
    if (game.user.isGM || selected.length) tokens = selected;
    else tokens = game.user.character?.getActiveTokens() ?? [];

    const actors = tokens.reduce((acc, token) => {
      const actor = token.actor;
      if (actor && actor.system.attributes?.hp) acc.add(actor);
      return acc;
    }, new Set());

    return actors;
  }

  /**
   * Quick apply damage normally.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {Promise<void>}
   */
  static async _quickApply(event) {
    const {values, bypasses} = this._getDataFromDamageRoll(event);
    const undo = event.shiftKey;
    const actors = this._getActors();
    const fn = undo ? this.undoDamage : this.applyDamage;
    for (const actor of actors) await fn.call(this, actor, values, bypasses);
  }

  /**
   * Quick apply half the damage.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {Promise<void>}
   */
  static async _quickApplyHalf(event) {
    const {values, bypasses} = this._getDataFromDamageRoll(event);
    const undo = event.shiftKey;
    const actors = this._getActors();
    const fn = undo ? this.undoDamage : this.applyDamage;
    for (const actor of actors) await fn.call(this, actor, values, bypasses, true);
  }

  /**
   * Apply the damage after making a saving throw.
   * It is assumed that all damage will be halved on a success.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {Promise<void>}
   */
  static async _quickSaveAndApply(event) {
    const {bypasses, saveData, values} = this._getDataFromDamageRoll(event);
    const actors = this._getActors();
    for (const actor of actors) {
      const saved = await this.rollAbilitySave(actor, saveData.ability, saveData.dc, {event});
      if (saved === null) continue;
      await this.applyDamage(actor, values, bypasses, saved);
    }
  }

  /**
   * Apply the healing from a 'damage' roll.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {Promise<null|void>}
   */
  static async _quickApplyHealing(event) {
    const healing = this._getDataFromDamageRoll(event)?.values.healing;
    if (!healing) return null;
    const actors = this._getActors();
    const undo = event.shiftKey ? 1 : -1;
    for (const actor of actors) await actor.applyDamage(healing, undo);
  }

  /**
   * Apply the temphp from a 'damage' roll.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {Promise<null|void>}
   */
  static async _quickApplyTempHP(event) {
    const temphp = this._getDataFromDamageRoll(event)?.values.temphp;
    if (!temphp) return null;
    const actors = this._getActors();
    for (const actor of actors) await actor.applyTempHP(healing);
  }

  /* -------------------------------------- */
  /*                                        */
  /*            INTERFACE METHODS           */
  /*                                        */
  /* -------------------------------------- */

  /**
   * Prompt for a saving throw.
   * @param {Actor5e} actor               The actor to make the saving throw.
   * @param {string} ability              The type of saving throw.
   * @param {number} targetValue          The dc of the saving throw.
   * @param {object} [options={}]         Additional options to modify the saving throw.
   * @returns {Promise<boolean|null>}     Whether the actor passed the saving throw, or null if cancelled.
   */
  static async rollAbilitySave(actor, ability, targetValue, options = {}) {
    if (!this.canDamageActor(actor)) return null;
    const token = actor.token?.object ?? actor.getActiveTokens()[0];
    if (token) canvas.animatePan({...token.center, duration: 1000});
    const roll = await actor.rollAbilitySave(ability, {targetValue, ...options});
    if (!roll) return null;
    return roll.total >= targetValue;
  }

  /**
   * Apply damage to an actor, taking into account types, values, trait, bypasses.
   * @param {Actor5e} actor               The actor.
   * @param {object} values               An object with damage types as keys and their totals.
   * @param {string[]} [bypasses=[]]      Strings of bypass weapon properties.
   * @param {boolean} [half=false]        Whether to halve the damage.
   * @returns {Promise<Actor5e|null>}
   */
  static async applyDamage(actor, values, bypasses = [], half = false) {
    if (!this.canDamageActor(actor)) return null;
    const total = this.calculateDamage(actor, values, bypasses);
    return actor.applyDamage(total, half ? 0.5 : 1);
  }

  /**
   * Undo the damage done to an actor, taking into account types, values, traits, bypasses.
   * @param {Actor5e} actor               The actor.
   * @param {object} values               An object with damage types as keys and their totals.
   * @param {string[]} [bypasses=[]]      Strings of bypass weapon properties.
   * @param {boolean} [half=false]        Whether to halve the damage.
   * @returns {Promise<Actor5e>}
   */
  static async undoDamage(actor, values, bypasses = [], half = false) {
    const total = this.calculateDamage(actor, values, bypasses);
    const adjustment = (half && ((total % 2) === 1)) ? -0.5 : 0;
    return actor.applyDamage(total + adjustment, half ? -0.5 : -1);
  }

  /**
   * Calculate the damage taken by an actor, taking into account types, values, traits, and bypasses.
   * @param {Actor5e} actor             The actor.
   * @param {object} values             An object with damage types as keys and their totals.
   * @param {string[]} [passes=[]]      An array of properties that bypass traits.
   * @returns {number}                  The total damage taken (or healing granted).
   */
  static calculateDamage(actor, values, passes = []) {
    values = foundry.utils.deepClone(values);
    const {dr, di, dv} = ["dr", "di", "dv"].reduce((acc, d) => {
      const trait = actor.system.traits[d];
      const types = new Set(trait.value);
      const bypasses = trait.bypasses.filter(b => passes.includes(b));
      if (trait.custom?.length) for (const val of trait.custom.split(";")) {
        const t = val.trim();
        if (t in values) types.add(t);
      }
      for (const type of types) if (type in values) acc[d].push({
        key: type, bypass: !!CONFIG.DND5E.physicalDamageTypes[type] && (bypasses.size > 0)
      });
      return acc;
    }, {dr: [], di: [], dv: []});
    for (const d of dr) if (!d.bypass) values[d.key] *= 0.5;
    for (const d of di) if (!d.bypass) values[d.key] = 0;
    for (const d of dv) if (!d.bypass) values[d.key] *= 2;

    const total = Object.values(values).reduce((acc, v) => acc + v, 0);
    return Math.max(0, total);
  }

  /**
   * Can this actor take damage?
   * @param {Actor5e}
   * @returns {boolean}
   */
  static canDamageActor(actor) {
    const hp = actor.system.attributes?.hp;
    if (!hp) return false;
    const total = hp.value + hp.temp;
    return total > 0;
  }

  /* -------------------------------------- */
  /*                                        */
  /*             EVENT HANDLERS             */
  /*                                        */
  /* -------------------------------------- */

  /**
   * Pan to the relevant token on the canvas. Fade the UI for 5 seconds.
   * @param {PointerEvent} event      The initiating click event.
   */
  async _onPanToken(event) {
    const uuid = event.currentTarget.closest("[data-actor-uuid]").dataset.actorUuid;
    const actor = this.actorData[uuid].actor;
    const token = actor.token?.object ?? actor.getActiveTokens()[0];
    if (!token) return null;
    const app = event.currentTarget.closest(".damage-application.app");
    app.classList.toggle("fade", true);
    await canvas.animatePan({...token.center, scale: 1, duration: 500});
    app.classList.toggle("fade", false);
  }

  /**
   * Toggle the success state of a saving throw.
   * @param {PointerEvent} event      The initiating right-click event.
   */
  _onToggleSuccess(event) {
    const uuid = event.currentTarget.closest("[data-actor-uuid]").dataset.actorUuid;
    const state = this.actorData[uuid].saved;
    if (state === null) return;
    this.actorData[uuid].saved = !state;
    this.render();
  }

  /**
   * Toggle whether a trait should be taken into account for the purpose of applying damage.
   * @param {PointerEvent} event      The initiating click event.
   */
  _onToggleTrait(event) {
    const d = event.currentTarget.dataset.trait;
    const type = event.currentTarget.dataset.key;
    const uuid = event.currentTarget.closest("[data-actor-uuid]").dataset.actorUuid;
    const clone = this.actorData[uuid].clone;
    const value = [...clone.system.traits[d].value];
    if (value.includes(type)) value.findSplice(v => v === type);
    else value.push(type);
    clone.updateSource({[`system.traits.${d}.value`]: value});
    this.render();
  }

  /** @override */
  setPosition(pos = {}) {
    if (!pos.height) pos.height = "auto";
    return super.setPosition(pos);
  }

  /* -------------------------------------- */
  /*                                        */
  /*             SETUP METHODS              */
  /*                                        */
  /* -------------------------------------- */

  /**
   * Append button(s) to damage rolls.
   * @param {ChatMessage} message     The message being rendered.
   * @param {HTMLElement} html        The rendered html element.
   */
  static async _appendToDamageRolls(message, [html]) {
    if (message.flags.dnd5e?.roll?.type !== "damage") return;
    const roll = html.querySelector(".dice-roll");
    const div = document.createElement("DIV");

    const app = DamageApplicator;

    const types = Object.keys(message.flags[app.MODULE].damage.values);
    const data = {
      isTempHP: types.includes("temphp"),
      isHealing: !types.includes("temphp") && types.includes("healing"),
      isDamage: !types.includes("temphp") && !types.includes("healing"),
      save: message.flags[app.MODULE].damage.hasSave,
      isGM: game.user.isGM
    };
    div.innerHTML = await renderTemplate("modules/damage-application/templates/buttons.hbs", data);
    div.querySelectorAll("[data-action]").forEach(n => {
      const action = n.dataset.action;
      if (action === "render") n.addEventListener("click", app.create.bind(app, message));
      else if (action === "quick-apply") n.addEventListener("click", app._quickApply.bind(app));
      else if (action === "save-and-apply") n.addEventListener("click", app._quickSaveAndApply.bind(app));
      else if (action === "quick-apply-half") n.addEventListener("click", app._quickApplyHalf.bind(app));
      else if (action === "quick-apply-temphp") n.addEventListener("click", app._quickApplyTempHP.bind(app));
      else if (action === "quick-apply-healing") n.addEventListener("click", app._quickApplyHealing.bind(app));
    });
    roll.after(div.firstElementChild);
  }

  /**
   * Utility factory method for clearing out old actors when forcibly re-rendering twice from a chat message.
   * @param {ChatMessage} message
   * @returns {DamageApplicator}
   */
  static create(message) {
    const id = `${this.MODULE}-${message.id}`;
    const existing = Object.values(ui.windows).find(w => w.id === id);
    if (existing) for (const actor of existing.actors) delete actor.apps[id];
    return new this(message).render(true);
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
