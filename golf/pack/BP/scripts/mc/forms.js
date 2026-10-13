// Form helpers. Forms can't open while a player has chat or another screen open
// ("UserBusy"), so retry for a few seconds instead of silently doing nothing.

import { system } from "@minecraft/server";
import { ActionFormData, ModalFormData, FormCancelationReason } from "@minecraft/server-ui";

export async function show(p, form, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const res = await form.show(p);
    if (res.canceled && res.cancelationReason === FormCancelationReason.UserBusy) {
      await new Promise((ok) => system.runTimeout(() => ok(undefined), 10));
      continue;
    }
    return res;
  }
  return { canceled: true };
}

/**
 * Button menu. items: [{ label, icon?, run?: () => any, value? }]
 * Returns the chosen item (after running it) or undefined if closed.
 */
export async function menu(p, titleText, body, items) {
  const f = new ActionFormData().title(titleText);
  if (body) f.body(body);
  for (const it of items) f.button(it.label, it.icon);
  const res = await show(p, f);
  if (res.canceled || res.selection === undefined) return undefined;
  const it = items[res.selection];
  if (it?.run) await it.run();
  return it;
}

export async function confirm(p, titleText, body, yes = "Yes", no = "Cancel") {
  const it = await menu(p, titleText, body, [{ label: yes, value: true }, { label: no, value: false }]);
  return !!it?.value;
}

/**
 * Modal form. fields: [{ type: "dropdown"|"slider"|"toggle"|"text", label, ... }]
 * Returns values array, or undefined if closed.
 */
export async function modal(p, titleText, fields, submit = "OK") {
  const f = new ModalFormData().title(titleText);
  for (const fd of fields) {
    if (fd.type === "dropdown") f.dropdown(fd.label, fd.options, { defaultValueIndex: fd.default ?? 0 });
    else if (fd.type === "slider") f.slider(fd.label, fd.min, fd.max, { valueStep: fd.step ?? 1, defaultValue: fd.default ?? fd.min });
    else if (fd.type === "toggle") f.toggle(fd.label, { defaultValue: !!fd.default });
    else if (fd.type === "text") f.textField(fd.label, fd.placeholder ?? "", { defaultValue: fd.default ?? "" });
    else if (fd.type === "label") f.label(fd.label);
  }
  f.submitButton(submit);
  const res = await show(p, f);
  if (res.canceled || !res.formValues) return undefined;
  // labels don't produce values in some versions; map by input fields only
  const inputs = fields.filter((fd) => fd.type !== "label");
  const vals = res.formValues.filter((v) => v !== undefined);
  return inputs.map((_, i) => vals[i]);
}
