/**
 * An application that takes selected tokens, and lets you roll saving
 * throws and apply damage correctly via a the interface.
 */
class DamageApplicator {
  /**
   * The module's id.
   * @type {string}
   */
  static MODULE = "damage-application";

  /**
   * Damage colors.
   * @type {object}
   */
  static COLORS = {
    acid: "839D50",
    bludgeoning: "0000A0",
    cold: "ADD8E6",
    fire: "FF4500",
    force: "800080",
    lightning: "1E90FF",
    necrotic: "006400",
    piercing: "C0C0C0",
    poison: "8A2BE2",
    psychic: "FF1493",
    radiant: "FFD700",
    slashing: "8B0000",
    thunder: "708090"
  };

  /** Initialize module. */
  static init() {
    Hooks.on("renderChatMessage", this._appendToDamageRolls);
    game.modules.get(this.MODULE).api = this;
    this._registerSettings();
    Hooks.once("ready", function() {
      if (!game.settings.get(DamageApplicator.MODULE, "colors")) return;
      Hooks.on("updateActor", DamageApplicator._updateActor);
      Hooks.on("dnd5e.calculateDamage", function(actor, damages, options) {
        options[DamageApplicator.MODULE] = {damages, colors: true};
      });
      Hooks.on("dnd5e.preApplyDamage", function(actor, amount, updates, options) {
        const {damages, colors} = options[DamageApplicator.MODULE] ?? {};
        if (!(amount > 0) || !damages || !colors) return;
        actor.update(updates, options);
        return false;
      });
    });
  }

  /* -------------------------------------- */
  /*                                        */
  /*       DAMAGE ROLL EVENT HANDLERS       */
  /*                                        */
  /* -------------------------------------- */

  /**
   * Helper method to get module data from the chat message of a click event.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {object}                An object with `properties`, `saveData`, and `values`.
   */
  static async _getDataFromDamageRoll(event) {
    const id = event.currentTarget.closest("[data-message-id]").dataset.messageId;
    const message = game.messages.get(id);
    return this.retrieveMessageData(message);
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
    const undo = event.shiftKey;
    const {values, properties} = await this._getDataFromDamageRoll(event);
    const actors = this._getActors();
    const fn = undo ? this.undoDamage : this.applyDamage;
    for (const actor of actors) await fn.call(this, actor, values, properties);
  }

  /**
   * Quick apply half the damage.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {Promise<void>}
   */
  static async _quickApplyHalf(event) {
    const undo = event.shiftKey;
    const {values, properties} = await this._getDataFromDamageRoll(event);
    const actors = this._getActors();
    const fn = undo ? this.undoDamage : this.applyDamage;
    for (const actor of actors) await fn.call(this, actor, values, properties, true);
  }

  /**
   * Apply the damage after making a saving throw.
   * It is assumed that all damage will be halved on a success.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {Promise<void>}
   */
  static async _quickSaveAndApply(event) {
    const {properties, saveData, values, isCantrip} = await this._getDataFromDamageRoll(event);
    const actors = this._getActors();
    for (const actor of actors) {
      const saved = await this.rollAbilitySave(actor, saveData.ability, saveData.dc, {event});
      if ((saved === null) || (isCantrip && saved)) continue;
      const mod = saved ? 0.5 : 1;
      await this.applyDamageToActor(actor, values, properties, mod);
    }
  }

  /**
   * Apply the healing from a 'damage' roll.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {Promise<null|void>}
   */
  static async _quickApplyHealing(event) {
    const id = event.currentTarget.closest("[data-message-id]").dataset.messageId;
    const message = game.messages.get(id);
    const value = message.rolls.reduce((acc, roll) => acc + roll.total, 0);
    const actors = this._getActors();
    const undo = event.shiftKey ? 1 : -1;
    for (const actor of actors) await actor.applyDamage(value, {multiplier: undo});
  }

  /**
   * Apply the temphp from a 'damage' roll.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {Promise<null|void>}
   */
  static async _quickApplyTempHP(event) {
    const id = event.currentTarget.closest("[data-message-id]").dataset.messageId;
    const message = game.messages.get(id);
    const value = message.rolls.reduce((acc, roll) => acc + roll.total, 0);
    const actors = this._getActors();
    for (const actor of actors) await actor.applyTempHP(value);
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
    const pan = token && !CONFIG.Dice.D20Roll.determineAdvantageMode(options).isFF;
    if (pan) canvas.animatePan({...token.center, duration: 1000});
    const roll = await actor.rollAbilitySave(ability, {targetValue, ...options});
    if (!roll) return null;
    return roll.total >= targetValue;
  }

  /**
   * Apply damage to an actor, taking into account types, values, trait, properties.
   * @param {Actor5e} actor               The actor.
   * @param {object} values               An object with damage types as keys and their totals.
   * @param {Set<string>} [properties]      Strings of bypass weapon properties.
   * @param {boolean} [half]              Whether to halve the damage.
   * @returns {Promise<Actor5e|null>}
   */
  static async applyDamage(actor, values, properties, half = false) {
    if (!this.canDamageActor(actor)) return null;
    const mod = half ? 0.5 : 1;
    return this.applyDamageToActor(actor, values, properties, mod);
  }

  /**
   * Undo the damage done to an actor, taking into account types, values, traits, properties.
   * @param {Actor5e} actor               The actor.
   * @param {object} values               An object with damage types as keys and their totals.
   * @param {Set<string>} [properties]      Strings of bypass weapon properties.
   * @param {boolean} [half]              Whether to halve the damage.
   * @returns {Promise<Actor5e>}
   */
  static async undoDamage(actor, values, properties, half = false) {
    const mod = half ? -0.5 : -1;
    return this.applyDamageToActor(actor, values, properties, mod);
  }

  /**
   * Create the damages and options for Actor5e#applyDamage and execute it.
   * @param {Actor5e} actor               The actor to apply damage to.
   * @param {object} values               An object with damage types as keys and their totals.
   * @param {Set<string>} [properties]      Strings of bypass weapon properties.
   * @param {number} [mod]                A modifier to multiply all damage/healing by.
   * @returns {Promise<Actor5e>}
   */
  static applyDamageToActor(actor, values, properties, mod = 1) {
    const damages = Object.entries(values).map(([k, v]) => ({
      type: k, value: v, properties: properties ?? new Set()
    }));
    const options = {multiplier: mod, ignore: false};
    return actor.applyDamage(damages, options);
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
  /*             SETUP METHODS              */
  /*                                        */
  /* -------------------------------------- */

  /**
   * Append button(s) to damage rolls. Hooks on 'renderChatMessage'.
   * @param {ChatMessage} message     The message being rendered.
   * @param {HTMLElement} html        The rendered html element.
   */
  static async _appendToDamageRolls(message, [html]) {
    if (message.flags.dnd5e?.roll?.type !== "damage") return;
    const div = document.createElement("DIV");

    const app = DamageApplicator;
    const messageData = await app.retrieveMessageData(message);

    const types = Object.keys(messageData.values);
    const data = {
      isTempHP: types.includes("temphp"),
      isHealing: !types.includes("temphp") && types.includes("healing"),
      isDamage: !types.includes("temphp") && !types.includes("healing"),
      save: messageData.hasSave
    };
    div.innerHTML = await renderTemplate("modules/damage-application/templates/buttons.hbs", data);
    div.querySelectorAll("[data-action]").forEach(n => {
      const action = n.dataset.action;
      if (action === "damage") n.addEventListener("click", app._quickApply.bind(app));
      else if (action === "save") n.addEventListener("click", app._quickSaveAndApply.bind(app));
      else if (action === "half") n.addEventListener("click", app._quickApplyHalf.bind(app));
      else if (action === "temphp") n.addEventListener("click", app._quickApplyTempHP.bind(app));
      else if (action === "healing") n.addEventListener("click", app._quickApplyHealing.bind(app));
    });
    html.querySelector(".message-content").appendChild(div.firstElementChild);
  }

  /**
   * Retrieve needed data from a chat message.
   * @param {ChatMessage} message     The message in chat.
   * @returns {Promise<object|null>}
   */
  static async retrieveMessageData(message) {
    if (message.flags.dnd5e?.roll?.type !== "damage") return null;

    return {
      saveData: message.flags[this.MODULE]?.saveData ?? {},
      hasSave: message.flags[this.MODULE]?.hasSave ?? false
    };
  }

  /* -------------------------------------- */
  /*                                        */
  /*             DAMAGE NUMBERS             */
  /*                                        */
  /* -------------------------------------- */

  /**
   * Read whether to display scrolling damage numbers.
   * @param {Actor5e} actor
   * @param {object} updates
   * @param {object} options
   * @param {string} userId
   */
  static _updateActor(actor, updates, options, userId) {
    const {damages, colors} = options[DamageApplicator.MODULE] ?? {};
    if (!damages || !colors) return;
    options.isRest = true;
    DamageApplicator.displayScrollingDamage(actor, damages);
  }

  /**
   * Display damage numbers with typed colors on the tokens of an actor.
   * @param {Actor5e} actor         The actor being damaged.
   * @param {object[]} damages      An object of damage types and their totals.
   * @returns {Promise<void>}
   */
  static async displayScrollingDamage(actor, damages) {
    const tokens = actor.isToken ? [actor.token?.object] : actor.getActiveTokens(true);
    for (const token of tokens) {
      DamageApplicator._displayScrollingDamage(token, damages);
      token.document.flashRing("damage");
    }
  }

  /**
   * Display scrolling damage numbers on one particular token.
   * @param {Token5e} token
   * @param {object} values     Object of damage types and numeric values.
   * @returns {Promise<void>}
   */
  static async _displayScrollingDamage(token, damages) {
    if (!token.visible || !token.renderable) return;
    const px = Math.round(canvas.grid.size * 0.15);
    const hp = token.actor.system.attributes.hp.max;
    const origin = token.center;
    for (const {type, value} of damages) {
      const amt = (value >= 1) ? (-Math.floor(value).signedString()) : "0";
      const pct = Math.clamped(amt / hp, 0, 1);
      canvas.interface.createScrollingText(origin, amt, {
        duration: 2000,
        anchor: CONST.TEXT_ANCHOR_POINTS.TOP,
        fill: DamageApplicator.COLORS[type] ?? CONFIG.DND5E.tokenHPColors.damage,
        stroke: 0x000000,
        strokeThickness: 1,
        jitter: 2,
        fontSize: px + ((2 * px) * pct)
      });
      await new Promise(r => setTimeout(r, 150));
    }
  }

  /* -------------------------------------- */
  /*                                        */
  /*                SETTINGS                */
  /*                                        */
  /* -------------------------------------- */

  static _registerSettings() {
    game.settings.register(DamageApplicator.MODULE, "colors", {
      name: "DAMAGE_APP.SettingsColors",
      hint: "DAMAGE_APP.SettingsColorsHint",
      type: Boolean,
      default: true,
      config: true,
      scope: "world",
      requiresReload: true
    });
  }
}

Hooks.once("init", () => DamageApplicator.init());
