// Stand-in for @minecraft/server-ui. Tests push scripted answers into __answers.
export const FormCancelationReason = { UserBusy: "UserBusy", UserClosed: "UserClosed" };
export const __answers = []; // { selection } | { formValues } | "close"
export const __shown = [];

class Base {
  constructor() { this.parts = []; }
  title(t) { this.t = t; return this; }
  body(b) { this.b = b; return this; }
  button(l) { this.parts.push(l); return this; }
  dropdown(l) { this.parts.push(l); return this; }
  slider(l) { this.parts.push(l); return this; }
  toggle(l) { this.parts.push(l); return this; }
  textField(l) { this.parts.push(l); return this; }
  label() { return this; }
  submitButton() { return this; }
  async show() {
    __shown.push({ title: this.t, body: this.b, parts: this.parts });
    const a = __answers.shift();
    if (!a || a === "close") return { canceled: true, cancelationReason: FormCancelationReason.UserClosed };
    if (typeof a.selection === "string") return { canceled: false, selection: this.parts.findIndex((p) => p.includes(a.selection)) };
    return { canceled: false, ...a };
  }
}
export class ActionFormData extends Base {}
export class ModalFormData extends Base {}
