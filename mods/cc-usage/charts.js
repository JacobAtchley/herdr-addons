// Small native charts for cc-usage: bars (stacked), sparkline bars, a
// cumulative line, a 100% stacked strip and a heatmap. All sizes in px.

import { div, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";

// Validated categorical slots (dataviz reference palette), dark/light steps.
// Checked against Catppuccin surfaces #1e1e2e (dark) and #eff1f5 (light).
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
export const series = (dark) => (dark ? SERIES_DARK : SERIES_LIGHT);
export const OTHER = (t) => t.dim;

const hex2 = (n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, "0");
export const alpha = (c, a) => `${c.slice(0, 7)}${hex2(a)}`;

/** Vertical bars, optionally stacked. cols: [{ key, segs: [{ v, color }], tip, highlight }] */
export function bars(t, id, cols, { height = 120, max, labels = [] } = {}) {
  const top = max ?? Math.max(1e-9, ...cols.map((c) => c.segs.reduce((s, x) => s + x.v, 0)));
  const plot = h_flex()
    .h(height)
    .w_full()
    .items_end()
    .gap(2)
    .border_b(1)
    .border_color(t.border)
    .children(
      cols.map((c, i) => {
        const total = c.segs.reduce((s, x) => s + x.v, 0);
        const live = c.segs.filter((s) => s.v > 0);
        const segs = live.map((s, j) => {
          const h = Math.max(total > 0 ? 1 : 0, (s.v / top) * (height - 4));
          let el = div().w_full().h(h).bg(s.color);
          if (j === live.length - 1) el = el.rounded_t(3);
          return el;
        });
        return v_flex()
          .id(`${id}-${i}`)
          .flex_1()
          .min_w(2)
          .h_full()
          .justify_end()
          .rounded_t(3)
          .hover((s) => s.bg(alpha(t.foreground, 0.09)))
          .when(Boolean(c.tip), (el) => el.tooltip(c.tip))
          .when(Boolean(c.onClick), (el) => el.cursor_pointer().on_click(c.onClick))
          // stacked from the baseline up: last seg drawn on top
          .children(segs.reverse());
      }),
    );
  if (!labels.length) return plot;
  // Sparse x labels under the plot.
  const axis = h_flex().w_full().gap(2).children(
    cols.map((_c, i) =>
      div().flex_1().min_w(2).text_size(10).text_color(cols[i]?.highlight ? t.foreground : t.dim).whitespace_nowrap().child(labels[i] ?? ""),
    ),
  );
  return v_flex().w_full().gap(4).child(plot).child(axis);
}

/** Tiny bars for a table row. values: number[] */
export function spark(t, values, color, { w = 84, h = 18 } = {}) {
  const top = Math.max(1e-9, ...values);
  return h_flex()
    .w(w)
    .h(h)
    .flex_none()
    .items_end()
    .gap(1)
    .children(values.map((v) => div().flex_1().h(Math.max(v > 0 ? 1.5 : 0.5, (v / top) * h)).bg(v > 0 ? color : t.border).rounded_t(1)));
}

/** A cumulative line (2px) over an area tint. points: number[] (monotonic) */
export function line(t, points, color, { height = 120 } = {}) {
  const n = points.length;
  const top = Math.max(1e-9, points[n - 1] ?? 0, ...points);
  const xy = points.map((v, i) => [`${n <= 1 ? 0 : (i / (n - 1)) * 100}%`, `${100 - (v / top) * 96}%`]);
  const box = div().relative().w_full().h(height).border_b(1).border_color(t.border);
  if (n < 2) return box;
  let stroke = PathBuilder.stroke(2).move_to(xy[0][0], xy[0][1]);
  let fill = PathBuilder.fill().move_to("0%", "100%");
  for (const [x, y] of xy) {
    stroke = stroke.line_to(x, y);
    fill = fill.line_to(x, y);
  }
  fill = fill.line_to("100%", "100%").close();
  return box
    .child(window.paint_path(fill.build(), alpha(color, 0.16)).absolute().top(0).left(0).size_full())
    .child(window.paint_path(stroke.build(), color).absolute().top(0).left(0).size_full());
}

/** One 100% bar split into parts: [{ v, color, label }] */
export function strip(t, id, parts, { height = 14 } = {}) {
  const total = parts.reduce((s, p) => s + p.v, 0) || 1;
  const live = parts.filter((p) => p.v > 0);
  return h_flex()
    .w_full()
    .h(height)
    .gap(2)
    .children(
      live.map((p, i) =>
        div()
          .id(`${id}-${i}`)
          .h_full()
          .min_w(3)
          .flex_basis(0)
          .flex_grow(p.v / total)
          .bg(p.color)
          .when(i === 0, (el) => el.rounded_l(4))
          .when(i === live.length - 1, (el) => el.rounded_r(4))
          .tooltip(p.tip ?? p.label),
      ),
    );
}

/** Weekday x hour grid. grid[7][24] values (Mon first). */
export function heatmap(t, id, grid, color, fmt) {
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const top = Math.max(1e-9, ...grid.flat());
  const head = h_flex().gap(2).child(div().w(30).flex_none()).children(
    Array.from({ length: 24 }, (_, h) => div().flex_1().min_w(6).text_size(10).text_color(t.dim).child(h % 6 === 0 ? String(h) : "")),
  );
  return v_flex()
    .w_full()
    .gap(2)
    .child(head)
    .children(
      grid.map((row, d) =>
        h_flex().gap(2).items_center()
          .child(div().w(30).flex_none().text_size(10).text_color(t.dim).child(DAYS[d]))
          .children(
            row.map((v, h) =>
              div()
                .id(`${id}-${d}-${h}`)
                .flex_1()
                .min_w(6)
                .h(14)
                .rounded(2)
                .bg(v > 0 ? alpha(color, 0.18 + 0.82 * Math.sqrt(v / top)) : alpha(t.foreground, 0.05))
                .tooltip(`${DAYS[d]} ${String(h).padStart(2, "0")}:00 · ${fmt(v)}`),
            ),
          ),
      ),
    );
}

/** Legend: swatch + label (+ value) in text colors; identity via the swatch. */
export function legend(t, items) {
  return h_flex().flex_wrap().gap_x(14).gap_y(4).children(
    items.map((it) =>
      h_flex().gap(6).items_center()
        .child(div().w(9).h(9).rounded(2).flex_none().bg(it.color))
        .child(div().text_size(11.5).text_color(t.muted).child(it.label))
        .when(it.value != null, (el) => el.child(div().text_size(11.5).text_color(t.foreground).child(it.value))),
    ),
  );
}
