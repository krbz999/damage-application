/**
 * An application that takes selected tokens, and lets you roll saving
 * throws and apply damage correctly via a the interface.
 */
class DamageApplicator extends dnd5e.applications.DialogMixin(Application) {
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
    Hooks.on("renderChatMessage", DamageApplicator._appendToDamageRolls);
    Hooks.on("dnd5e.renderChatMessage", DamageApplicator._appendToAttackRolls);
    Hooks.on("dnd5e.preRollDamage", DamageApplicator._preRollDamage.bind(DamageApplicator));
    Hooks.on("getChatLogEntryContext", DamageApplicator._modifyChatLogContextMenu);
    game.modules.get(DamageApplicator.MODULE).api = DamageApplicator;
    DamageApplicator._registerSettings();
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

  /**
   * Mapping of actor uuids to relevant data.
   * @type {Map}
   */
  actorData = new Map();

  /**
   * @constructor
   * @param {ChatMessage} message     The chat message.
   * @param {object} data             Data retrieved from the chat message.
   * @param {object} [options]        Rendering options.
   */
  constructor(message, data, options = {}) {
    super();
    // The initiating damage roll.
    this.message = message;

    // The damage types and the properties (mgc, ada, sil).
    this.hasSave = data.hasSave;
    this.saveData = data.saveData;
    this.isCantrip = data.isCantrip;
    this.targetTokens = data.targets;

    // Set token actors depending on user status.
    this.actors = this.constructor._getActors(this.targetTokens);

    // Data model.
    this.model = new (class DamageApplicationModel extends foundry.abstract.TypeDataModel {
      /** @override */
      static defineSchema() {
        const fields = foundry.data.fields;
        return {
          values: new fields.SchemaField(Object.keys(CONFIG.DND5E.damageTypes).reduce((acc, key) => {
            acc[key] = new fields.NumberField({integer: true, min: 0, initial: 0})
            return acc;
          }, {undefined: new fields.NumberField({integer: true, min: 0, initial: 0})})),
          properties: new fields.SetField(new fields.StringField())
        };
      }

      /** @override */
      prepareDerivedData() {
        for (const key in this.values) if (!this.values[key]) delete this.values[key];
      }

    })({values: data.values, properties: [...data.properties]});

    this.model.prepareDerivedData();
    this.render = foundry.utils.debounce(this.render, 250);
  }

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: [DamageApplicator.MODULE, "dnd5e2", "dialog"],
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
    data.actors = Array.from(this.actorData.values());

    // Damage roll data.
    data.types = Object.entries(this.model.values).reduce((acc, [type, value]) => {
      const label = CONFIG.DND5E.damageTypes[type]?.label ?? CONFIG.DND5E.healingTypes[type]?.label;
      acc.push({
        type: label ? type : "undefined",
        value: value,
        label: label ? label : game.i18n.localize("DND5E.Unknown")
      });
      return acc;
    }, []);
    data.total = Object.values(this.model.values).reduce((acc, v) => acc + v, 0);

    // Item data.
    data.isCantrip = this.isCantrip;
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

  /** Prepare the internal `actorData` map. */
  _prepareActors() {
    const types = Object.keys(this.model.values);

    for (const actor of this.actors) {
      const uuid = actor.uuid;
      this.actorData ??= new Map();

      const data = this.actorData.get(uuid) ?? {};
      if (!this.actorData.has(uuid)) this.actorData.set(uuid, data);
      const traits = data.clone?.toObject().system.traits ?? {};
      const clone = data.clone = actor.clone({"system.traits": traits}, {keepId: true});
      const hp = actor.system.attributes.hp;
      const curr = hp.value + hp.temp;
      const max = hp.max + hp.tempmax;

      data.actor = actor;
      data.img = actor.img;
      data.name = actor.name.split(" ")[0].trim();
      data.actorName = actor.name;
      data.hasPlayer = game.users.some(user => !user.isGM && user.active && actor.testUserPermission(user, "OWNER"));
      data.isTarget = this.targetTokens.some(id => canvas.scene.tokens.get(id)?.actor?.uuid === uuid);
      data.hp = hp;
      data.healthPct = Math.clamped(Math.round(curr / max * 100), 0, 100);
      data.healthColor = Actor.implementation.getHPColor(curr, max).css;
      data.actorUuid = uuid;
      data.saved ??= null;
      data.savedCssClass = data.saved ? "success" : (data.saved === false) ? "failure" : "";
      data.saveIcon = (data.saved === null) ? "fa-person-falling-burst" : data.saved ? "fa-check" : "fa-times";
      ["dr", "di", "dv"].forEach(d => {
        data[d] = [];
        const itemProps = CONFIG.DND5E.itemProperties;
        for (const value of actor.system.traits[d].value) {
          if (!(value in CONFIG.DND5E.damageTypes) || !types.includes(value)) continue;

          const dtype = CONFIG.DND5E.damageTypes[value];

          // Is this type irrelevant due to being a physical damage type and bypassed?
          const isPhysical = dtype.isPhysical ?? false;
          const actorBypasses = actor.system.traits[d].bypasses.filter(k => itemProps[k]?.isPhysical);
          if (isPhysical && this.model.properties.intersects(actorBypasses)) continue;

          // For display purposes, is this trait conditional?
          const bypass = isPhysical && (actorBypasses.size > 0);

          const label = bypass ? game.i18n.format("DND5E.DamagePhysicalBypasses", {
            damageTypes: dtype.label,
            bypassTypes: [...actorBypasses.map(p => itemProps[p].label)].filterJoin(", ")
          }) : dtype.label;
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
      data.noTraits = !data.hasResistance && !data.hasInvulnerability && !data.hasVulnerability;
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
    html[0].querySelectorAll("INPUT[data-key]").forEach(n => {
      n.addEventListener("focus", event => event.currentTarget.select());
    });
  }

  /** @override */
  render(force = false, options = {}) {
    if (force) options.top = options.left = 150;
    if (!this.actors.size) {
      ui.notifications.warn("DAMAGE_APP.YouHaveNoValidTokens", {localize: true});
      return null;
    }
    for (const actor of this.actors) actor.apps[this.id] = this;
    this.model.prepareDerivedData();
    return super.render(force, options);
  }

  /** @override */
  _saveScrollPositions(html) {
    super._saveScrollPositions(html);
    this._saveHealthPositions(html);
  }

  /**
   * Save the width of health bars.
   * @param {HTMLElement} html      The application's html.
   */
  _saveHealthPositions([html]) {
    this._healthPositions = {};
    for (const actor of html.querySelectorAll("[data-actor-uuid]")) {
      const uuid = actor.dataset.actorUuid;
      const bar = actor.querySelector(".health-bar .bar");
      if (!bar) continue;
      this._healthPositions[uuid] = bar.style.width;
    }
  }

  /** @override */
  _restoreScrollPositions(html) {
    super._restoreScrollPositions(html);
    this._restoreHealthPositions(html);
  }

  /**
   * Animate the width of health bars.
   * @param {HTMLElement} html      The application's html.
   */
  _restoreHealthPositions([html]) {
    const w = this._healthPositions;
    if (!w) return;
    for (const uuid in w) {
      const bar = html.querySelector(`[data-actor-uuid="${uuid}"] .health-bar .bar`);
      if (!bar) continue;
      const frames = [{width: w[uuid], easing: "ease"}, {width: bar.style.width}];
      const duration = 250;
      bar.animate(frames, duration);
    }
  }

  /** @override */
  async close(...args) {
    for (const actor of this.actors) delete actor.apps[this.id];
    return super.close(...args);
  }

  /** @override */
  _onToggleMinimize(event) {
    if (this._minimized) return super._onToggleMinimize(event);
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
    return this.actorData.get(uuid).actor.sheet.render(true);
  }

  /**
   * Handle applying damage to one actor.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {Promise<Actor5e>}
   */
  async _onClickApplyDamage(event) {
    const uuid = event.currentTarget.closest("[data-actor-uuid]").dataset.actorUuid;
    if (event.shiftKey) return this._undoDamageToActor(uuid);
    return this._applyDamageToActor(uuid);
  }

  /**
   * Apply damage to all actors in the application.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {Promise<Actor5e[]>}
   */
  async _onClickApplyDamageAll(event) {
    const uuids = Array.from(this.actorData.keys());
    if (event.shiftKey) return Promise.all(uuids.map(uuid => this._undoDamageToActor(uuid)));
    return Promise.all(uuids.map(uuid => this._applyDamageToActor(uuid)));
  }

  /**
   * Undo the ddmage to one actor from its uuid.
   * @param {string} uuid     The uuid of an actor in this application.
   * @returns {Promise<Actor5e>}
   */
  async _undoDamageToActor(uuid) {
    const {clone, saved} = this.actorData.get(uuid);
    const {values, properties} = this.model;
    const mod = saved ? -0.5 : -1;
    return DamageApplicator.applyDamageToActor(clone, values, properties, mod);
  }

  /**
   * Apply damage to one actor from its uuid.
   * @param {string} uuid     The uuid of an actor in this application.
   * @returns {Promise<Actor5e>}
   */
  async _applyDamageToActor(uuid) {
    const {actor, clone, saved} = this.actorData.get(uuid);
    if (saved && this.isCantrip) return actor;
    const {values, properties} = this.model;
    const mod = saved ? 0.5 : 1;
    return this.constructor.applyDamageToActor(clone, values, properties, mod);
  }
  /**
   * Perform a saving throw for the selected token's actor, then append the result just below.
   * @param {PointerEvent} event      The initiating click event.
   */
  async _onClickRollSave(event) {
    const uuid = event.currentTarget.closest("[data-actor-uuid]").dataset.actorUuid;
    event.currentTarget.style.pointerEvents = "none";
    const actor = this.actorData.get(uuid).actor;
    if (!this.constructor.canDamageActor(actor)) return null;
    const saveData = this.saveData;
    const roll = await this.constructor.rollAbilitySave(actor, saveData.ability, saveData.dc, {event});
    if (roll !== null) this.actorData.get(uuid).saved = roll;
    this.render();
  }

  /**
   * Roll saving throws for all actors in the application.
   * @param {PointerEvent} event      The initiating click event.
   * @returns {Promise<void>}
   */
  async _onClickRollSaveAll(event) {
    const data = this.saveData;
    for (const v of this.actorData.values()) {
      if (!this.constructor.canDamageActor(v.actor)) continue;
      const roll = await this.constructor.rollAbilitySave(v.actor, data.ability, data.dc, {event});
      if (roll !== null) v.saved = roll;
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
   * @returns {object}                An object with `properties`, `saveData`, and `values`.
   */
  static async _getDataFromDamageRoll(event) {
    const id = event.currentTarget.closest("[data-message-id]").dataset.messageId;
    const message = game.messages.get(id);
    return this.retrieveMessageData(message);
  }

  /**
   * Helper method to get actors from selected or assigned tokens.
   * @param {string[]} [tokenIds]     An optional array of token ids.
   * @returns {Set<Actor5e>}
   */
  static _getActors(tokenIds = []) {
    const selected = canvas.tokens.controlled;
    let tokens;
    if (game.user.isGM || selected.length) tokens = selected;
    else tokens = game.user.character?.getActiveTokens() ?? [];

    const actors = tokens.reduce((acc, token) => {
      const actor = token.actor;
      if (actor && actor.system.attributes?.hp) acc.add(actor);
      return acc;
    }, new Set());

    if (game.user.isGM) tokenIds.forEach(id => {
      const actor = canvas.scene.tokens.get(id)?.actor;
      if (actor) actors.add(actor);
    });

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
  /*             EVENT HANDLERS             */
  /*                                        */
  /* -------------------------------------- */

  /**
   * Pan to the relevant token on the canvas. Fade the UI for 5 seconds.
   * @param {PointerEvent} event      The initiating click event.
   */
  async _onPanToken(event) {
    const uuid = event.currentTarget.closest("[data-actor-uuid]").dataset.actorUuid;
    const actor = this.actorData.get(uuid).actor;
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
    const data = this.actorData.get(uuid);
    if (data.saved === null) return;
    data.saved = !data.saved;
    this.render();
  }

  /**
   * Toggle whether a trait should be taken into account for the purpose of applying damage.
   * @param {PointerEvent} event      The initiating click event.
   */
  _onToggleTrait(event) {
    const enabled = event.currentTarget.classList.contains("enabled");
    const d = event.currentTarget.dataset.trait;
    const type = event.currentTarget.dataset.key;
    const uuid = event.currentTarget.closest("[data-actor-uuid]").dataset.actorUuid;
    const clone = this.actorData.get(uuid).clone;
    const value = new Set(clone.system.traits[d].value);
    if (enabled) value.delete(type);
    else value.add(type);
    clone.updateSource({[`system.traits.${d}.value`]: value.toObject()});
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
   * Add listeners to attack rolls to select and pan to targets. Hooks on 'renderChatMessage'.
   * @param {ChatMessage} message     The message being rendered.
   * @param {HTMLElement} html        The rendered html element.
   */
  static async _appendToAttackRolls(message, html) {
    if (message.flags.dnd5e?.roll?.type !== "attack") return;

    const [miss, hit] = Array.from(html.querySelectorAll("ul.dnd5e2.evaluation li.target")).partition(n => {
      return n.classList.contains("hit");
    });
    for (const node of miss.concat(hit)) {
      const uuid = node.dataset.uuid;
      const actor = fromUuidSync(uuid);
      if (!actor) continue;
      node.addEventListener("click", (event) => {
        const token = actor.token?.object ?? actor.getActiveTokens()[0];
        if (!token) return;
        const releaseOthers = !event.shiftKey;
        if (token.controlled) token.release();
        else {
          token.control({releaseOthers});
          canvas.animatePan({...token.center});
        }
      });
    }
  }

  /**
   * Add chat log context menu entries for selecting all tokens if they were hit or missed.
   * @param {jQuery} html           The chat log html element.
   * @param {object[]} options      The context menu options.
   */
  static _modifyChatLogContextMenu(html, options) {
    const isAttack = ([li]) => game.messages.get(li.dataset.messageId)?.flags.dnd5e?.roll?.type === "attack";
    options.push({
      name: game.i18n.localize("DAMAGE_APP.ChatContextTargetHit"),
      icon: "<i class='fa-solid fa-bullseye'></i>",
      condition: isAttack,
      callback: ([li]) => callback(li, "hit")
    }, {
      name: game.i18n.localize("DAMAGE_APP.ChatContextTargetMiss"),
      icon: "<i class='fa-solid fa-bullseye'></i>",
      condition: isAttack,
      callback: ([li]) => callback(li, "miss")
    });

    /**
     * Select some tokens based on whether they were hit or missed.
     * @param {HTMLElement} li      The selected entry in the context menu.
     * @param {string} type         The css class of the type to select ('hit' or 'miss').
     */
    function callback(li, type) {
      const uuids = new Set();
      li.closest("[data-message-id]").querySelectorAll(`ul.dnd5e2.evaluation li.target.${type}`).forEach(n => {
        uuids.add(n.dataset.uuid);
      });
      canvas.tokens.releaseAll();
      uuids.forEach(uuid => {
        const actor = fromUuidSync(uuid);
        const token = actor?.token?.object ?? actor?.getActiveTokens()[0];
        if (token) token.control({releaseOthers: false});
      });
    }
  }

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
      save: messageData.hasSave,
      isGM: game.user.isGM
    };
    div.innerHTML = await renderTemplate("modules/damage-application/templates/buttons.hbs", data);
    div.querySelectorAll("[data-action]").forEach(n => {
      const action = n.dataset.action;
      if (action === "render") n.addEventListener("click", app.create.bind(app, message));
      else if (action === "damage") n.addEventListener("click", app._quickApply.bind(app));
      else if (action === "save") n.addEventListener("click", app._quickSaveAndApply.bind(app));
      else if (action === "half") n.addEventListener("click", app._quickApplyHalf.bind(app));
      else if (action === "temphp") n.addEventListener("click", app._quickApplyTempHP.bind(app));
      else if (action === "healing") n.addEventListener("click", app._quickApplyHealing.bind(app));
    });
    html.querySelector(".message-content").appendChild(div.firstElementChild);
  }

  /**
   * Utility factory method for clearing out old actors when forcibly re-rendering twice from a chat message.
   * @param {ChatMessage} message
   * @returns {DamageApplicator}
   */
  static async create(message) {
    const id = `${this.MODULE}-${message.id}`;
    const existing = Object.values(ui.windows).find(w => w.id === id);
    if (existing) for (const actor of existing.actors) delete actor.apps[id];

    const data = await this.retrieveMessageData(message);
    return new this(message, data).render(true);
  }

  /**
   * Add your current targets to the damage roll message.
   * Hooks on `dnd5e.preRollDamage`.
   * @param {Item5e} [item]     The item making the roll.
   * @param {object} config     The roll config.
   */
  static _preRollDamage(item, config) {
    const targets = game.user.targets.ids;
    const saveData = item?.system?.save || {};
    const hasSave = item?.hasSave ?? false;
    config.messageData[`flags.${this.MODULE}`] = {targets, saveData, hasSave};
  }

  /**
   * Retrieve needed data from a chat message.
   * @param {ChatMessage} message     The message in chat.
   * @returns {Promise<object|null>}
   */
  static async retrieveMessageData(message) {
    if (message.flags.dnd5e?.roll?.type !== "damage") return null;

    const item = await fromUuid(message.flags.dnd5e.roll.itemUuid);
    const values = {};

    const agg = {};
    for (const roll of message.rolls) message._aggregateDamageRoll(roll, agg);
    for (const [k, v] of Object.entries(agg)) values[k] = v.total;

    const properties = message.rolls.reduce((acc, roll) => {
      for (const p of roll.options.properties ?? []) {
        if (CONFIG.DND5E.itemProperties[p]?.isPhysical) acc.add(p);
      }
      return acc;
    }, new Set());

    return {
      properties: properties,
      item: item,
      values: values,
      isCantrip: (item?.type === "spell") && (item.system.level === 0),
      saveData: message.flags[this.MODULE]?.saveData ?? {},
      hasSave: message.flags[this.MODULE]?.hasSave ?? false,
      targets: message.flags[this.MODULE]?.targets ?? []
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
    DamageApplicator.displayScrollingDamage(actor, damages);
  }

  /**
   * Display damage numbers with typed colors on the tokens of an actor.
   * @param {Actor5e} actor         The actor being damaged.
   * @param {object[]} damages      An object of damage types and their totals.
   * @returns {Promise<void>}
   */
  static async displayScrollingDamage(actor, damages) {
    const total = damages.reduce((acc, d) => acc + d.value, 0);
    const tokens = actor.isToken ? [actor.token?.object] : actor.getActiveTokens(true);
    for (const token of tokens) DamageApplicator._displayScrollingDamage(token, damages, total);
  }

  /**
   * Display scrolling damage numbers on one particular token.
   * @param {Token5e} token
   * @param {object} values     Object of damage types and numeric values.
   * @param {number} total      The amount of damage taken.
   * @returns {Promise<void>}
   */
  static async _displayScrollingDamage(token, damages, total) {
    if (!token.visible || !token.renderable) return;
    const px = Math.round(canvas.grid.size * 0.15);
    const hp = token.actor.system.attributes.hp.max;
    const origin = token.center;
    token.document.flashRing({dhp: -total});
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

Hooks.once("init", DamageApplicator.init);
