// Small shared UI pieces for the review view.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

export const ICON = (n) => `mods/ado-prs/${n}.svg`;

const stop = (_e, cx) => cx.stop_propagation();

/** Bordered text button. `active` highlights it (current vote); `tone` colors border/text. */
// `plain`: no press handling (a Popover trigger owns the press).
export function button(t, id, label, onClick, { active = false, tone, tip, disabled = false, primary = false, plain = false } = {}) {
  const fg = primary ? t.background : active ? tone ?? t.foreground : t.foreground;
  return h_flex().id(id).flex_none().gap(6).px(10).py(4).rounded(6).items_center().text_size(12)
    .text_color(fg)
    .when(primary, (el) => el.bg(t.accent))
    .when(!primary, (el) => el.border(1).border_color(active ? tone ?? t.accent : t.border))
    .when(active && !primary, (el) => el.bg(t.selected).font_semibold())
    .when(disabled, (el) => el.opacity(0.5))
    .when(!disabled && !plain, (el) => el.on_click(onClick).on_mouse_down("left", stop))
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .child(label);
}

export function iconButton(t, id, icon, tip, onClick, { spin = false } = {}) {
  let ic = svg(ICON(icon)).size(14).text_color(t.muted);
  if (spin) ic = ic.spin(900);
  return div().id(id).flex_none().p(5).rounded(6).cursor_pointer().tooltip(tip)
    .hover((s) => s.bg(t.hover))
    .on_mouse_down("left", stop)
    .on_click(onClick)
    .child(ic);
}

/** Small link-like text action ("Reply", "Resolve"). */
export function textAction(t, id, label, onClick, { disabled = false, color } = {}) {
  return div().id(id).flex_none().px(4).text_size(11.5).text_color(disabled ? t.dim : color ?? t.accent)
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.75)).on_click(onClick))
    .on_mouse_down("left", stop)
    .child(label);
}

export function badge(t, text, color) {
  return div().flex_none().px(6).rounded(4).text_size(10.5).font_semibold()
    .text_color(color).border(1).border_color(color).child(text);
}

/** A count bubble for list rows (empty string draws nothing). */
export function count(t, n, strong) {
  if (!n) return div().flex_none();
  return div().flex_none().px(6).rounded(8).text_size(10.5).bg(strong ? t.selected : t.raised)
    .text_color(strong ? t.foreground : t.muted).child(String(n));
}

export function section(t, title, extra) {
  return h_flex().gap(8).items_center()
    .child(div().text_size(12).font_semibold().text_color(t.muted).child(title))
    .when(extra != null, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(extra))));
}

export function note(t, text, color) {
  return div().text_size(12).text_color(color ?? t.dim).child(text);
}

export function centered(...kids) {
  return v_flex().flex_1().items_center().justify_center().gap(6).p(24).children(kids);
}
