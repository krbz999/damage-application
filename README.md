# Damage Application

This module, for the dnd5e system enhances the default damage rolls to allow players and GMs to apply damage, healing, and temporary hit points even faster. All damage will respect resistances, immunities, and vulnerabilities.

When a damage roll (including healing roll) is made, the resulting roll in chat is appended with buttons for applying the result of the roll to selected tokens. Note: This does not allow players to apply damage or healing to anyone they do not have ownership of; you are required to be able to select the token.

### Healing
When healing, a single button is present to apply this roll as healing to the actors of your selected tokens. If you shift-click, the same amount is applied as damage instead. Useful if you wish to 'undo'.

### Temporary Hit Points
When rolling temporary hit points, a single button is present to apply this roll as temporary hit points to the actors of your selected tokens. This will not apply to selected tokens that already have more temporary hit points.

### Damage
When rolling damage, several buttons are available.

A primary button, available only to GMs, will render an application where some manual adjustments can be made. You can adjust the damage values, toggle off which traits will affect the application, and roll saving throws and apply damage individually to each of the selected token actors. The remaining buttons are for quick application.

One button simply applies the damage, as is, to the actors of all selected tokens. This will respect resistances, immunities, and vulnerabilities, including special ones like 'Resistance to Slashing from Non-Magical Attacks'. If you shift-click this button, the same amount will be applied as healing instead. The other button does the same as this, but halves all the values.

Lastly, if the item that rolled the damage had a saving throw, a button is available that will perform the relevant saving throw for each selected token's actor in sequence. The damage is then applied depending on the total of the roll; if the total of the roll is equal to or greater than the DC, half damage will be applied, otherwise the full damage will be applied. This again respects resistances, immunities, and vulnerabilities.

### Example
The below example shows the quick-application of a fireball's damage using some of the tools this module has available.

https://github.com/krbz999/damage-application/assets/50169243/da3c9417-dfab-465c-ab75-93639c1a06f6

https://github.com/krbz999/damage-application/assets/50169243/a93a6e0f-5600-42a9-a909-2ed9f21c8365

https://github.com/krbz999/damage-application/assets/50169243/62d0cbed-83b1-4afe-880e-9fcb57b95985
