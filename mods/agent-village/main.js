// Agents as villagers on a pixel-art map. Working agents go to a job (lumber,
// farm, mine, forge, dock) and swing their tools; an agent that needs you waits
// at the notice board with a "!"; done ones celebrate by the campfire; idle
// ones sit on the benches outside their cottages. Click a villager to show its
// terminal below (the `village` layout), right-click to peek.
// Art and stations come from a separate Pillow generator (village_art.py, not in this repo).

import { View, div, image } from "gpui-kit";
import { agents, terminals, focused, run, props, setAgentOrder } from "herdr";
import { STATIONS } from "./stations.js";

const S = 2; // logical px per art px
const ART = "mods/agent-village/art";
const [SW, SH] = STATIONS.map.sprite;
const MAP_W = STATIONS.map.w * S;
const MAP_H = STATIONS.map.h * S;
const HUD = 34;
const FONT = "Pixelated MS Sans Serif";
const DOS = "PxPlus IBM VGA 8x16";
const JOBS = Object.keys(STATIONS.work);
const STATUS = {
  blocked: { word: "NEEDS YOU", color: "#ff5f6d" },
  done: { word: "DONE", color: "#7fc8ff" },
  working: { word: "WORKING", color: "#ffd65a" },
  idle: { word: "IDLE", color: "#b8c0cc" },
};

// A stable number per agent, so a villager keeps its look and its job.
function hash(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

const sprite = (path, w, h) => image(`${ART}/${path}.png`).w(w * S).h(h * S);
const at = (el, x, y) => el.absolute().left(x * S).top(y * S);

export default class Village extends View {
  init(_props, cx) {
    this.width = 0;
    this.height = 0;
    this.clock = new Date();
    cx.timer.every(30000, (cx) => {
      this.clock = new Date();
      cx.notify();
    });
  }

  // Who stands where: each agent a job or a status spot, taken in a stable order.
  place(list) {
    const taken = {};
    const take = (key, slots, seed) => {
      const used = (taken[key] ??= new Set());
      for (let i = 0; i < slots.length; i++) {
        const k = (seed + i) % slots.length;
        if (!used.has(k)) {
          used.add(k);
          return slots[k];
        }
      }
      // Full: crowd in beside a spot.
      const n = used.size;
      used.add(`extra-${n}`);
      const [x, y] = slots[n % slots.length];
      return [x + 9 * Math.ceil(n / slots.length), y + 4];
    };
    return [...list].sort((a, b) => a.seq - b.seq).map((a) => {
      const h = hash(a.address);
      if (a.status === "working") {
        const job = JOBS[h % JOBS.length];
        return { a, job, spot: take(job, STATIONS.work[job].slots, h >>> 3) };
      }
      const pool = STATIONS[a.status] ?? STATIONS.idle;
      return { a, job: null, spot: take(a.status, pool.slots, h >>> 3) };
    });
  }

  select(a) {
    if (props()?.layout) run("agent.focus", { terminal: a.address });
    else run("pane.focus", { pane: a.pane });
  }

  villager({ a, job, spot }, kids, chosen) {
    const look = hash(a.address) % STATIONS.map.outfits;
    const [fx, fy] = spot;
    const x = fx - SW / 2;
    const y = fy - SH + 1;
    const pose = { working: job, blocked: "alert", done: "cheer", idle: "sit" }[a.status] ?? "stand";
    const st = STATUS[a.status] ?? STATUS.idle;
    const tab = /^\d+$/.test(a.tab_name) ? `tab ${a.tab_name}` : a.tab_name;
    const name = (a.space_name || a.program?.name || a.address).slice(0, 12);
    const els = [];

    // Bob: quick for work, a hop for news.
    const bob = { working: [1, 420], blocked: [3, 700], done: [4, 560] }[a.status];
    let body = at(div().id(`v-${a.address}`), x, y)
      .w(SW * S)
      .h(SH * S)
      .cursor_pointer()
      .tooltip(`${a.space_name} · ${tab}\n${a.program?.name ?? a.app ?? "agent"} — ${st.word.toLowerCase()}`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => this.select(a))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        run("terminal.peek", { terminal: a.address });
      })
      .child(sprite(`v/${look}-${pose}`, SW, SH));
    if (bob) body = body.loop("top", { from: y * S, to: (y - bob[0]) * S, period: bob[1] });
    els.push(body);

    // What the job throws up: chips, sparks, dirt, ripples.
    if (a.status === "working") {
      const w = STATIONS.work[job];
      const [cx_, cy_] = w.cast ?? [7, -12];
      els.push(at(div(), fx + cx_, fy + cy_ + 2)
        .child(sprite(w.fx, 5, 5))
        .loop("top", { from: (fy + cy_ + 2) * S, to: (fy + cy_ - 3) * S, period: 420 })
        .loop("opacity", { from: 0, to: 1, period: 420 }));
    }
    if (a.status === "blocked") {
      els.push(at(div(), x + 3, y - 12)
        .w(10 * S).h(10 * S).rounded(3).bg("#fff6d8").border(2).border_color("#2a1f1a")
        .flex().items_center().justify_center()
        .font_family(DOS).text_size(16).text_color("#d8263a").child("!")
        .loop("top", { from: (y - 12) * S, to: (y - 15) * S, period: 700 }));
    }
    if (a.status === "done") {
      els.push(at(div(), x + 4, y - 9).child(sprite("sparkle", 7, 7)).loop("opacity", { from: 0.2, to: 1, period: 500 }));
    }
    if (a.status === "idle") {
      els.push(at(div(), x + 11, y - 2).font_family(DOS).text_size(12).text_color("#e8ecff")
        .frames(["z", "zZ", "zZz", ""], 700));
    }
    // Apprentices: sub-agents tag along.
    kids.slice(0, 3).forEach((k, i) => {
      els.push(at(div().id(`kid-${k.address}`), x + SW - 2 + i * 7, y + SH - 14)
        .cursor_pointer()
        .tooltip(k.name || k.template || k.program?.name || k.address)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => run("terminal.peek", { terminal: k.address }))
        .child(sprite(`v/${hash(k.address) % STATIONS.map.outfits}-kid`, 10, 14)));
    });
    if (chosen) {
      els.push(at(div(), x + 4.5, y - (a.status === "blocked" ? 21 : 9)).child(sprite("arrow", 7, 5))
        .loop("top", { from: (y - (a.status === "blocked" ? 21 : 9)) * S, to: (y - (a.status === "blocked" ? 18 : 6)) * S, period: 600 }));
    }
    // Name plate under the feet.
    els.push(div().absolute().left((fx - 30) * S).top((fy + 2) * S).w(60 * S).flex().justify_center()
      .child(div().px(4).rounded(3).bg(chosen ? "#2a1f1aee" : "#2a1f1aaa")
        .font_family(FONT).text_size(11).text_color(chosen ? "#ffe680" : "#f4ead0").whitespace_nowrap()
        .child(name)));
    return els;
  }

  ambience() {
    const els = [];
    STATIONS.smoke.forEach(([x, y], i) => {
      for (let k = 0; k < 2; k++) {
        const period = 2600 + i * 230 + k * 900;
        els.push(at(div(), x - 2 + k * 2, y - 6).child(sprite("smoke", 8, 8))
          .loop("top", { from: (y - 4) * S, to: (y - 20 - k * 6) * S, period, easing: "linear" })
          .loop("opacity", { from: 0.85, to: 0, period, easing: "linear" }));
      }
    });
    for (const [x, y] of STATIONS.fire) {
      els.push(at(div(), x - 3, y - 8).child(sprite("flame", 7, 9)).loop("opacity", { from: 0.45, to: 1, period: 300 }));
    }
    [[530, 40], [570, 100], [552, 190], [575, 20]].forEach(([x, y], i) => {
      els.push(at(div(), x, y).child(sprite("ripple", 9, 3)).loop("opacity", { from: 0, to: 0.9, period: 1500 + i * 400 }));
    });
    [[-60, 20, 80000], [200, 120, 110000]].forEach(([x, y, period]) => {
      els.push(at(div(), x, y).child(sprite("cloud", 60, 22))
        .loop("left", { from: x * S, to: (x + 420) * S, period, easing: "linear" }));
    });
    return els;
  }

  hud(list, chosen) {
    const count = (s) => list.filter((a) => a.status === s).length;
    const time = this.clock.toTimeString().slice(0, 5);
    const stat = (s, glyph) => div().flex().items_center().gap(5)
      .child(div().text_color(STATUS[s].color).child(glyph))
      .child(div().text_color("#f4ead0").child(String(count(s))));
    return div()
      .absolute().left(0).top(0).w_full().h(HUD)
      .flex().items_center().gap(18).pl(84).pr(16)
      .bg("#1b1530e6").border_b(2).border_color("#e8d6a8")
      .font_family(DOS).text_size(16)
      .child(div().text_color("#ffd65a").child("AGENT VILLAGE"))
      .child(div().text_color("#8a84b0").child(`Day ${Math.floor(Date.now() / 86400000) % 1000} · ${time}`))
      .child(div().flex_1())
      .when(Boolean(chosen), (el) => el.child(div().text_color("#f4ead0").whitespace_nowrap()
        .child(`> ${chosen.space_name} (${(STATUS[chosen.status] ?? STATUS.idle).word})`)))
      .child(stat("blocked", "!"))
      .child(stat("working", "⚒"))
      .child(stat("done", "★"))
      .child(stat("idle", "z"));
  }

  render(cx) {
    const list = agents();
    const all = terminals();
    const shownAddr = props()?.layout ? focused()?.agent : list.find((a) => a.focused)?.address;
    const placed = this.place(list);
    // Agent navigation follows the map: urgent first, then left to right.
    const rank = { blocked: 0, done: 1, working: 2, idle: 3 };
    setAgentOrder([...placed].sort((p, q) => (rank[p.a.status] ?? 4) - (rank[q.a.status] ?? 4) || p.spot[0] - q.spot[0]).map((p) => p.a.address));
    const chosen = list.find((a) => a.address === shownAddr);

    // Villagers further down stand in front.
    const people = [...placed].sort((p, q) => p.spot[1] - q.spot[1]).flatMap((p) =>
      this.villager(p, all.filter((k) => k.parent === p.a.address && k.state === "live"), p.a.address === shownAddr));

    const left = Math.round((this.width - MAP_W) / 2);
    const top = HUD + Math.max(0, Math.round((this.height - HUD - MAP_H) / 2));
    return div()
      .id("root")
      .on_size_change((size, cx) => {
        this.width = size.width;
        this.height = size.height;
        cx.notify();
      })
      .size_full()
      .relative()
      .overflow_hidden()
      .bg("#2c5a22")
      .child(div().absolute().left(left).top(top).w(MAP_W).h(MAP_H)
        .child(image(`${ART}/map.png`).absolute().left(0).top(0).w(MAP_W).h(MAP_H))
        .children(this.ambience())
        .children(people)
        .when(list.length === 0, (el) => el.child(div().absolute().left(MAP_W / 2 - 170).top(MAP_H / 2 - 40).w(340)
          .p(12).rounded(6).bg("#1b1530f0").border(3).border_color("#e8d6a8")
          .font_family(DOS).text_size(16).text_color("#f4ead0")
          .child("The village is quiet. Start an agent and a villager will move in."))))
      .child(this.hud(list, chosen));
  }
}
