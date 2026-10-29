# Visual kit for the AI-drawn sections: ready-made, well-spaced pieces a video designer would reach for
# (numbers, charts, comparisons, pipelines, timelines, tokens with attention arcs, networks, heatmaps, layer stacks, quotes, icons).
# Pasted into every generated scene after the header that defines BG, ACCENT, ACCENT2, TEXT, MUTED, PALETTE, FONT, ICON_DIR, BEATS, CUES.
import os, re

if FONT:
    Text.set_default(font=FONT)

def wrap(s, n=22):
    """Break a label into lines of at most n characters (on spaces)."""
    words, lines, cur = str(s).split(), [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > n:
            lines.append(cur); cur = w
        else:
            cur = (cur + " " + w).strip()
    if cur: lines.append(cur)
    return "\n".join(lines) or str(s)

def fit(m, w=12.4, h=5.6):
    """Shrink a mobject (never enlarge) so it fits w x h."""
    if m.width > w: m.scale_to_fit_width(w)
    if m.height > h: m.scale_to_fit_height(h)
    return m

def Lbl(s, size=30, color=TEXT, w=None, bold=False):
    t = Text(str(s), font_size=size, color=color, weight=BOLD if bold else NORMAL, line_spacing=0.9)
    if w is not None and t.width > w: t.scale_to_fit_width(w)
    return t

def Heading(s, color=TEXT):
    """The beat's title at the top of the frame."""
    t = Text(str(s), font_size=40, weight=BOLD, color=color)
    fit(t, 12.0, 0.8)
    return t.move_to([0, 3.25, 0])

def Box(s, w=3.0, h=1.3, color=ACCENT, size=32, fill=0.22):
    r = RoundedRectangle(corner_radius=0.14, width=w, height=h, color=color, fill_opacity=fill, stroke_width=3)
    t = Text(wrap(s, 16), font_size=size, color=TEXT, line_spacing=0.9)
    if t.width > w - 0.3: t.scale_to_fit_width(w - 0.3)
    if t.height > h - 0.2: t.scale_to_fit_height(h - 0.2)
    t.move_to(r)
    g = VGroup(r, t); g.rect, g.label = r, t
    return g

def Icon(name, size=1.0, color=ACCENT, stroke=3.5):
    """A line icon (lucide set): brain cpu database file-text image globe zap layers search lock users clock target trending-up
    trending-down eye message-square book-open graduation-cap lightbulb puzzle network git-branch shuffle repeat filter scale gauge
    rocket shield-check sparkles languages type cog box boxes grid-3x3 list-ordered check x alert-triangle sigma function-square
    scan-search workflow microscope flask-conical award timer coins server cloud camera music video bot user code chart-column
    chart-line chart-pie arrow-right split merge. An unknown name gives a dot."""
    p = os.path.join(ICON_DIR, f"{name}.svg")
    try:
        ok = os.path.exists(p) and open(p, encoding="utf-8").read(200).lstrip().startswith("<")
        m = SVGMobject(p) if ok else None
    except Exception:
        m = None
    if m is None:   # missing or unreadable icon: a dot, never a crash
        return Dot(radius=size * 0.3, color=color)
    m.set_fill(opacity=0).set_stroke(color, width=stroke)
    m.scale_to_fit_height(size)
    return m

def IconLabel(name, label, color=ACCENT, size=1.0):
    """An icon in a soft circle with its label under it (an alternative to a box)."""
    c = Circle(radius=size * 0.82, color=color, stroke_width=3, fill_color=color, fill_opacity=0.14)
    i = Icon(name, size, color).move_to(c)
    l = Text(wrap(label, 14), font_size=26, color=TEXT, line_spacing=0.9)
    fit(l, size * 2.6, 1.2).next_to(c, DOWN, buff=0.28)
    g = VGroup(c, i, l); g.circle, g.icon, g.label = c, i, l
    return g

def BigNumber(value, label="", color=ACCENT, size=110):
    n = Text(str(value), font_size=size, weight=BOLD, color=color)
    fit(n, 11, 2.4)
    g = VGroup(n)
    if label:
        g.add(fit(Text(wrap(label, 36), font_size=30, color=MUTED), 11, 1.2).next_to(n, DOWN, buff=0.3))
    g.number = n
    return g

def Counter(target, label="", decimals=1, suffix="", color=ACCENT, size=100):
    """A number that counts up. g, t = Counter(28.4, "BLEU"); self.add(g); self.play(t.animate.set_value(28.4), run_time=1.5)."""
    t = ValueTracker(0)
    anchor = Dot(radius=0.001, fill_opacity=0, stroke_opacity=0)
    num = always_redraw(lambda: Text(f"{t.get_value():.{decimals}f}{suffix}", font_size=size, weight=BOLD, color=color).move_to(anchor.get_center()))
    g = VGroup(anchor, num)
    if label:
        g.add(Text(wrap(label, 36), font_size=30, color=MUTED).next_to(anchor, DOWN, buff=0.95))
    return g, t

def _unit(u):
    """'%' sticks to the number, a word unit gets a space: 25.8 BLEU, 3.5%."""
    u = str(u or "")
    return (" " + u) if u[:1].isalpha() else u

def Bars(labels, values, colors=None, highlight=None, w=8.0, h=3.4, unit="", decimals=None):
    """Vertical bar chart. Animate: Create(g.base), LaggedStart(*[GrowFromEdge(b, DOWN) for b in g.bars]), FadeIn(g.values), FadeIn(g.labels)."""
    n = len(values); vmax = max(abs(float(v)) for v in values) or 1
    slot = w / n; bw = min(1.3, slot * 0.58)
    bars, vals, labs = VGroup(), VGroup(), VGroup()
    for k, (lab, v) in enumerate(zip(labels, values)):
        col = (colors[k] if colors else (ACCENT if highlight is None or k == highlight else MUTED))
        bh = max(0.06, abs(float(v)) / vmax * h)
        x = -w / 2 + slot * (k + 0.5)
        b = Rectangle(width=bw, height=bh, stroke_width=0, fill_color=col, fill_opacity=0.9).move_to([x, bh / 2, 0])
        bars.add(b)
        txt = (f"{float(v):.{decimals}f}" if decimals is not None else str(v)) + _unit(unit)
        vals.add(fit(Text(txt, font_size=28, color=TEXT, weight=BOLD), slot * 0.95, 0.5).next_to(b, UP, buff=0.12))
        labs.add(fit(Text(wrap(lab, 12), font_size=24, color=MUTED, line_spacing=0.85), slot * 0.95, 0.9).next_to([x, 0, 0], DOWN, buff=0.22))
    base = Line([-w / 2, 0, 0], [w / 2, 0, 0], color=MUTED, stroke_width=2)
    g = VGroup(base, bars, vals, labs); g.base, g.bars, g.values, g.labels = base, bars, vals, labs
    return g.move_to([0, 0.1, 0])

def HBars(labels, values, colors=None, highlight=None, w=7.0, unit="", decimals=None):
    """Horizontal bars, good for rankings. Animate: LaggedStart(*[GrowFromEdge(b, LEFT) for b in g.bars]), then FadeIn(g.values)."""
    n = len(values); vmax = max(abs(float(v)) for v in values) or 1
    row = min(0.8, 5.0 / n)
    bars, vals, labs = VGroup(), VGroup(), VGroup()
    for k, (lab, v) in enumerate(zip(labels, values)):
        col = (colors[k] if colors else (ACCENT if highlight is None or k == highlight else MUTED))
        y = (n - 1) / 2 * row - k * row
        bl = max(0.06, abs(float(v)) / vmax * w)
        b = Rectangle(width=bl, height=row * 0.62, stroke_width=0, fill_color=col, fill_opacity=0.9).move_to([bl / 2, y, 0])
        bars.add(b)
        labs.add(fit(Text(str(lab), font_size=26, color=TEXT), 3.6, row * 0.8).next_to([0, y, 0], LEFT, buff=0.25))
        txt = (f"{float(v):.{decimals}f}" if decimals is not None else str(v)) + _unit(unit)
        vals.add(fit(Text(txt, font_size=26, color=TEXT, weight=BOLD), 2, row * 0.8).next_to(b, RIGHT, buff=0.15))
    g = VGroup(bars, vals, labs); g.bars, g.values, g.labels = bars, vals, labs
    fit(g, 12.4, 5.4)
    return g.move_to([0, 0.2, 0])

def LinePlot(ys, xs=None, x_label="", y_label="", w=8.0, h=3.8, color=ACCENT):
    """A line chart without tick numbers. Animate: Create(g.axes), Create(g.curve), FadeIn(g.x_label, g.y_label)."""
    xs = list(xs) if xs is not None else list(range(len(ys)))
    ys = [float(y) for y in ys]
    lo, hi = min(ys), max(ys); pad = (hi - lo) * 0.15 or 1
    ax = Axes(x_range=[min(xs), max(xs), max(1e-9, (max(xs) - min(xs)) / 4)], y_range=[lo - pad, hi + pad, max(1e-9, (hi - lo + 2 * pad) / 4)],
              x_length=w, y_length=h, tips=False, axis_config={"color": MUTED, "include_ticks": False, "stroke_width": 2})
    curve = ax.plot_line_graph(xs, ys, line_color=color, add_vertex_dots=True, vertex_dot_radius=0.07, stroke_width=5, vertex_dot_style={"fill_color": color})
    xl = Text(x_label, font_size=24, color=MUTED).next_to(ax.x_axis, DOWN, buff=0.25) if x_label else VGroup()
    yl = Text(y_label, font_size=24, color=MUTED).next_to(ax.y_axis, UP, buff=0.2) if y_label else VGroup()
    g = VGroup(ax, curve, xl, yl); g.axes, g.curve, g.x_label, g.y_label = ax, curve, xl, yl
    return g.move_to([0, 0.1, 0])

def Compare(left_title, left_items, right_title, right_items, left_color=MUTED, right_color=ACCENT, left_icon=None, right_icon=None):
    """Two columns: before / after, old / new, problem / solution. Bullets are neutral dots; pass left_icon="x", right_icon="check" ONLY when the left really is the bad side and the right the good one. Animate: FadeIn(g.left), then FadeIn(g.right) or item by item (g.left_items, g.right_items)."""
    def col(title, items, color, icon, x):
        t = fit(Text(str(title), font_size=36, weight=BOLD, color=color), 5.6, 0.7)
        rows = VGroup()
        for it in items[:4]:
            ic = Icon(icon, 0.42, color) if icon else Dot(radius=0.07, color=color).shift(UP * 0.1)
            tx = fit(Text(wrap(it, 24), font_size=27, color=TEXT, line_spacing=0.9), 4.9, 1.1)
            rows.add(VGroup(ic, tx).arrange(RIGHT, buff=0.25, aligned_edge=UP))
        rows.arrange(DOWN, aligned_edge=LEFT, buff=0.38)
        g = VGroup(t, rows).arrange(DOWN, buff=0.5, aligned_edge=LEFT).move_to([x, 0.3, 0])
        return g, rows
    lg, lr = col(left_title, left_items, left_color, left_icon, -3.4)
    rg, rr = col(right_title, right_items, right_color, right_icon, 3.4)
    div = DashedLine([0, 2.7, 0], [0, -2.2, 0], color=MUTED, stroke_width=2)
    g = VGroup(lg, div, rg); g.left, g.right, g.divider, g.left_items, g.right_items = lg, rg, div, lr, rr
    return g

def Pipeline(steps, icons=None, color=ACCENT, colors=None):
    """Steps as round nodes (an icon or the step number inside) with labels under them and arrows between.
    Animate: LaggedStart(*[GrowFromCenter(n) for n in g.nodes]), LaggedStart(*[GrowArrow(a) for a in g.arrows]), FadeIn(g.labels)."""
    n = len(steps); gap = min(2.9, 12.0 / n); r = min(0.62, gap * 0.26)
    nodes, labels, arrows = VGroup(), VGroup(), VGroup()
    for k, s in enumerate(steps):
        x = -gap * (n - 1) / 2 + gap * k
        col = colors[k] if colors else color
        c = Circle(radius=r, color=col, stroke_width=4, fill_color=col, fill_opacity=0.16).move_to([x, 0.5, 0])
        inner = Icon(icons[k], r * 1.05, col) if icons and k < len(icons) and icons[k] else Text(str(k + 1), font_size=34, weight=BOLD, color=col)
        inner.move_to(c)
        nodes.add(VGroup(c, inner))
        labels.add(fit(Text(wrap(s, 13), font_size=26, color=TEXT, line_spacing=0.9), gap * 0.94, 1.3).next_to(c, DOWN, buff=0.3))
    for k in range(n - 1):
        arrows.add(Arrow(nodes[k][0].get_right(), nodes[k + 1][0].get_left(), buff=0.12, color=MUTED, stroke_width=4, max_tip_length_to_length_ratio=0.25))
    g = VGroup(nodes, arrows, labels); g.nodes, g.arrows, g.labels = nodes, arrows, labels
    return g

def Timeline(events, color=ACCENT):
    """events = [(when, what), ...] along a line, labels alternating above and below. Animate: Create(g.line), then LaggedStart(*[FadeIn(e) for e in g.events])."""
    n = len(events); w = 11.0
    line = Line([-w / 2, 0, 0], [w / 2, 0, 0], color=MUTED, stroke_width=3)
    evs = VGroup()
    for k, (when, what) in enumerate(events):
        x = -w / 2 + w * (k + 0.5) / n; up = k % 2 == 0
        d = Dot([x, 0, 0], radius=0.11, color=color)
        a = Text(str(when), font_size=28, weight=BOLD, color=color)
        b = fit(Text(wrap(what, 16), font_size=24, color=TEXT, line_spacing=0.9), w / n * 1.6, 1.2)
        lab = VGroup(a, b).arrange(DOWN, buff=0.12)
        lab.next_to(d, UP if up else DOWN, buff=0.35)
        evs.add(VGroup(d, lab))
    g = VGroup(line, evs); g.line, g.events = line, evs
    return g.move_to([0, 0.3, 0])

def Tokens(words, highlight=None, color=ACCENT2, size=30):
    """A sentence as word chips (highlight = indices to colour). Use with Attention(...)."""
    chips = VGroup()
    for k, wd in enumerate(words):
        hl = highlight is not None and k in highlight
        t = Text(str(wd), font_size=size, color=TEXT)
        r = RoundedRectangle(corner_radius=0.12, width=t.width + 0.36, height=t.height + 0.32, color=ACCENT if hl else color, stroke_width=3,
                             fill_color=ACCENT if hl else color, fill_opacity=0.3 if hl else 0.12)
        chips.add(VGroup(r, t.move_to(r)))
    chips.arrange(RIGHT, buff=0.2)
    fit(chips, 12.4, 1.2)
    chips.chips = chips
    return chips.move_to([0, -0.6, 0])

def Attention(tokens, pairs, weights=None, color=ACCENT):
    """Arcs above the chips from word i to word j; weights 0..1 set the thickness. Animate: LaggedStart(*[Create(a) for a in arcs])."""
    arcs = VGroup()
    for k, (i, j) in enumerate(pairs):
        if i == j: continue
        wgt = weights[k] if weights else 0.7
        p, q = tokens[i].get_top() + UP * 0.08, tokens[j].get_top() + UP * 0.08
        arcs.add(ArcBetweenPoints(p, q, angle=-PI * 0.75 if p[0] < q[0] else PI * 0.75, color=color, stroke_width=2 + 7 * wgt, stroke_opacity=0.35 + 0.6 * wgt))
    # the arcs belong to the row: to move, scale or fade the row, do it to VGroup(tokens, arcs)
    return arcs

def NeuralNet(layers=(3, 4, 4, 2), w=7.0, h=3.6, color=ACCENT, labels=None):
    """Circles in layers joined by faint lines. Animate: Create(g.edges), LaggedStart(*[FadeIn(l) for l in g.layers])."""
    lay, edges = VGroup(), VGroup()
    for li, n in enumerate(layers):
        x = -w / 2 + w * li / max(1, len(layers) - 1)
        col = VGroup(*[Circle(radius=0.17, color=color, stroke_width=3, fill_color=color, fill_opacity=0.25).move_to([x, (n - 1) / 2 * min(0.8, h / max(1, n - 1)) - j * min(0.8, h / max(1, n - 1)), 0]) for j in range(n)])
        lay.add(col)
    for a, b in zip(lay[:-1], lay[1:]):
        for p in a:
            for q in b:
                edges.add(Line(p.get_center(), q.get_center(), stroke_width=1.4, color=MUTED, stroke_opacity=0.45, buff=0.17))
    labs = VGroup()
    if labels:
        for li, t in enumerate(labels[:len(layers)]):
            labs.add(fit(Text(str(t), font_size=24, color=MUTED), 2.4, 0.5).next_to(lay[li], DOWN, buff=0.35))
    g = VGroup(edges, lay, labs); g.edges, g.layers, g.labels = edges, lay, labs
    return g.move_to([0, 0.3, 0])

def Heatmap(values, row_labels=None, col_labels=None, size=4.2, color=ACCENT):
    """A grid of cells coloured by value (attention maps, confusion matrices). Animate: LaggedStart(*[FadeIn(c) for c in g.cells], lag_ratio=0.02)."""
    rows, cols = len(values), len(values[0])
    flat = [float(v) for r in values for v in r]; lo, hi = min(flat), max(flat)
    cell = size / max(rows, cols)
    cells = VGroup()
    for i, r in enumerate(values):
        for j, v in enumerate(r):
            a = (float(v) - lo) / ((hi - lo) or 1)
            cells.add(Square(cell * 0.94, stroke_width=0, fill_color=interpolate_color(ManimColor(BG), ManimColor(color), 0.12 + 0.88 * a), fill_opacity=1).move_to([j * cell, -i * cell, 0]))
    labs = VGroup()
    if row_labels:
        for i, t in enumerate(row_labels[:rows]): labs.add(fit(Text(str(t), font_size=22, color=MUTED), 2.2, cell * 0.8).next_to(cells[i * cols], LEFT, buff=0.15))
    if col_labels:
        for j, t in enumerate(col_labels[:cols]): labs.add(fit(Text(str(t), font_size=22, color=MUTED), cell * 1.6, 0.5).next_to(cells[j], UP, buff=0.15))
    g = VGroup(cells, labs); g.cells, g.labels = cells, labs
    return g.move_to([0, 0.2, 0])

def Stack(labels, color=ACCENT, w=4.6, h=0.78, colors=None):
    """Layers stacked bottom to top, slightly offset like a 3D pile (model blocks, a tech stack). Animate: LaggedStart(*[FadeIn(l, shift=DOWN*0.3) for l in g.layers])."""
    layers = VGroup()
    for k, s in enumerate(labels):
        col = colors[k] if colors else color
        r = RoundedRectangle(corner_radius=0.1, width=w, height=h, color=col, stroke_width=3, fill_color=col, fill_opacity=0.18 + 0.06 * k)
        t = fit(Text(str(s), font_size=28, color=TEXT), w - 0.4, h - 0.2).move_to(r)
        layers.add(VGroup(r, t).move_to([0.14 * k, -1.6 + k * (h + 0.16), 0]))
    fit(layers, 12, 5.6)
    g = VGroup(layers); g.layers = layers
    return g.move_to([0, 0.4, 0])

def Donut(percent, label="", color=ACCENT, r=1.4):
    """A ring filled to percent. Animate: Create(g.ring), Create(g.arc), FadeIn(g.value), FadeIn(g.label)."""
    ring = Circle(radius=r, color=MUTED, stroke_width=20, stroke_opacity=0.25)
    arc = Arc(radius=r, start_angle=PI / 2, angle=-TAU * max(0.001, min(1, float(percent) / 100)), color=color, stroke_width=20)
    val = Text(f"{percent}%", font_size=54, weight=BOLD, color=TEXT)
    lab = fit(Text(wrap(label, 24), font_size=28, color=MUTED), 5, 1).next_to(ring, DOWN, buff=0.35) if label else VGroup()
    g = VGroup(ring, arc, val, lab); g.ring, g.arc, g.value, g.label = ring, arc, val, lab
    return g.move_to([0, 0.3, 0])

def Quote(text, source=""):
    """A short quote from the paper, big and centred. Animate: FadeIn(g.mark), Write(g.text), FadeIn(g.source)."""
    mark = Text("“", font_size=150, color=ACCENT).set_opacity(0.7)
    body = fit(Text(wrap(text, 34), font_size=36, color=TEXT, slant=ITALIC, line_spacing=1.0), 11, 3.6)
    src = Text(str(source), font_size=24, color=MUTED) if source else VGroup()
    col = VGroup(body, src).arrange(DOWN, buff=0.4)
    mark.next_to(body, LEFT, buff=0.25, aligned_edge=UP).shift(UP * 0.35)
    g = VGroup(mark, col); g.mark, g.text, g.source = mark, body, src
    return g.move_to([0, 0.4, 0])

def Equation(parts, colors=None, size=52):
    """A formula built from pieces, e.g. ["y", "=", "F(x)", "+", "x"]; Write them one by one and Indicate the key piece."""
    ps = VGroup(*[Text(str(p), font_size=size, color=(colors[k] if colors and k < len(colors) and colors[k] else TEXT)) for k, p in enumerate(parts)])
    ps.arrange(RIGHT, buff=0.25)
    fit(ps, 12, 1.6)
    ps.parts = ps
    return ps.move_to([0, 0.4, 0])

def Callout(target, text, direction=UR, color=ACCENT2):
    """A pointer to part of the picture with a short note, placed away from it."""
    lab = fit(Text(wrap(text, 20), font_size=26, color=color, line_spacing=0.9), 4, 1.2)
    lab.move_to(target.get_center() + np.array(direction) * (max(target.width, target.height) / 2 + 1.3))
    lab.set_x(max(-6.4 + lab.width / 2, min(6.4 - lab.width / 2, lab.get_x()))).set_y(max(-2.2 + lab.height / 2, min(3.5 - lab.height / 2, lab.get_y())))
    d = Dot(target.get_critical_point(direction), radius=0.06, color=color)
    ln = Line(lab.get_critical_point(-np.array(direction)), d.get_center(), color=color, stroke_width=2.5, buff=0.08)
    g = VGroup(ln, d, lab); g.label = lab
    return g

def Venn(a, b, both="", ca=ACCENT, cb=ACCENT2):
    l = Circle(radius=1.6, color=ca, fill_color=ca, fill_opacity=0.18, stroke_width=3).shift(LEFT * 1.0)
    r = Circle(radius=1.6, color=cb, fill_color=cb, fill_opacity=0.18, stroke_width=3).shift(RIGHT * 1.0)
    la = fit(Text(wrap(a, 10), font_size=26, color=TEXT), 1.5, 1.2).move_to(l.get_center() + LEFT * 0.75)
    lb = fit(Text(wrap(b, 10), font_size=26, color=TEXT), 1.5, 1.2).move_to(r.get_center() + RIGHT * 0.75)
    lab = fit(Text(wrap(both, 8), font_size=22, color=TEXT, weight=BOLD), 0.9, 1.0) if both else VGroup()
    g = VGroup(l, r, la, lb, lab); g.left, g.right = VGroup(l, la), VGroup(r, lb); g.both = lab
    return g.move_to([0, 0.3, 0])

def IconRow(items, color=ACCENT, colors=None):
    """[(icon, label), ...] side by side (3 to 5): ingredients, use cases, parts of a system. Animate: LaggedStart(*[FadeIn(x, shift=UP*0.3) for x in g])."""
    g = VGroup(*[IconLabel(ic, lab, (colors[k] if colors else color)) for k, (ic, lab) in enumerate(items)])
    g.arrange(RIGHT, buff=0.7, aligned_edge=UP)
    fit(g, 12.4, 4.6)
    return g.move_to([0, 0.4, 0])
