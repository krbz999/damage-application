import {DamageApplicator} from "./scripts/damageApplicator.mjs";

Hooks.on("renderChatMessage", DamageApplicator._appendToDamageRolls);
Hooks.on("dnd5e.preRollDamage", DamageApplicator._appendDamageRollData);
Hooks.on("preCreateChatMessage", DamageApplicator._appendMoreDamageRollData);
