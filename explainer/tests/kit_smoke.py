"""Renders every piece of the visual kit in one scene and fails if Manim errors or the layout audit finds an overlap. Needs Manim, no keys.
usage: python explainer/tests/kit_smoke.py   (set MANIM_PYTHON to the interpreter that has manim)"""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); EXP = os.path.dirname(HERE)
src = open(os.path.join(EXP, "manim_section.py"), encoding="utf-8").read()
a = src.index("HARNESS_HEAD = f'''"); b = src.index('SYSTEM = f"""')
beats = [3.0] * 16
ns = {"BG": "#04070c", "ACC": "#3dff8f", "ACC2": "#4aa3ff", "TXT": "#e9f3ff", "MUT": "#8aa0b8", "beats": beats, "CUES": {0: [[1.0, "deep"]]}, "os": os, "ROOT": EXP, "d": EXP, "LANGS": ["en"]}
exec(src[a:b], ns)
code = '''
class Section(ExplainerScene):
    def construct(self):
        with self.beat(0):
            h = Heading("Deeper is not always better")
            g = BigNumber("28.4", "BLEU on English to German")
            self.play(FadeIn(h), FadeIn(g, scale=0.9))
            self.until(0, "deep")
            self.play(Indicate(g.number))
        with self.beat(1):
            self.play(FadeOut(g))
            c, t = Counter(3.57, "top-5 error (%)", decimals=2)
            self.add(c); self.play(t.animate.set_value(3.57), run_time=1.5)
        with self.beat(2):
            self.play(FadeOut(c), FadeOut(h))
            g = Bars(["VGG-19", "ResNet-34", "ResNet-152"], [8.43, 5.71, 4.49], highlight=2, unit="BLEU")
            self.play(Create(g.base), LaggedStart(*[GrowFromEdge(x, DOWN) for x in g.bars]), FadeIn(g.values), FadeIn(g.labels))
        with self.beat(3):
            self.play(FadeOut(g))
            g = HBars(["Transformer", "ConvS2S", "GNMT"], [28.4, 25.2, 24.6], highlight=0)
            self.play(LaggedStart(*[GrowFromEdge(x, LEFT) for x in g.bars]), FadeIn(g.labels), FadeIn(g.values))
        with self.beat(4):
            self.play(FadeOut(g))
            g = LinePlot([5.2, 4.1, 3.6, 3.1, 2.9], x_label="layers", y_label="error")
            self.play(Create(g.axes), Create(g.curve), FadeIn(g.x_label, g.y_label))
        with self.beat(5):
            self.play(FadeOut(g))
            g = Compare("Plain network", ["Deeper gets worse", "Signal fades"], "Residual network", ["Deeper gets better", "Shortcut keeps signal"], left_icon="x", right_icon="check")
            self.play(FadeIn(g.left), FadeIn(g.divider), FadeIn(g.right))
        with self.beat(6):
            self.play(FadeOut(g))
            g = Pipeline(["Read the paper", "Write the script", "Check facts", "Record"], icons=["book-open", "file-text", "shield-check", "video"])
            self.play(LaggedStart(*[GrowFromCenter(n) for n in g.nodes]), LaggedStart(*[GrowArrow(x) for x in g.arrows]), FadeIn(g.labels))
        with self.beat(7):
            self.play(FadeOut(g))
            g = Timeline([("2014", "Seq2seq"), ("2015", "Attention"), ("2017", "Transformer"), ("2018", "BERT"), ("2020", "GPT-3")])
            self.play(Create(g.line), LaggedStart(*[FadeIn(e) for e in g.events]))
        with self.beat(8):
            self.play(FadeOut(g))
            tk = Tokens(["The", "animal", "did", "not", "cross", "because", "it", "was", "tired"], highlight=[6])
            arcs = Attention(tk, [(6, 1), (6, 8), (6, 4)], [0.95, 0.5, 0.2])
            self.play(FadeIn(tk)); self.play(LaggedStart(*[Create(x) for x in arcs])); self.play(VGroup(tk, arcs).animate.shift(UP * 2).scale(0.8))
        with self.beat(9):
            self.play(FadeOut(tk), FadeOut(arcs))
            g = NeuralNet((3, 5, 5, 2), labels=["input", "hidden", "hidden", "output"])
            self.play(Create(g.edges), LaggedStart(*[FadeIn(l) for l in g.layers]), FadeIn(g.labels))
        with self.beat(10):
            self.play(FadeOut(g))
            g = Heatmap([[0.9, 0.1, 0.0, 0.2], [0.2, 0.8, 0.1, 0.0], [0.0, 0.3, 0.7, 0.1], [0.1, 0.0, 0.2, 0.9]], ["I", "love", "big", "cats"], ["Ich", "liebe", "grosse", "Katzen"])
            self.play(LaggedStart(*[FadeIn(c) for c in g.cells], lag_ratio=0.03), FadeIn(g.labels))
        with self.beat(11):
            self.play(FadeOut(g))
            g = Stack(["Embedding", "Self-attention", "Feed-forward", "Output"])
            self.play(LaggedStart(*[FadeIn(l, shift=DOWN * 0.3) for l in g.layers]))
        with self.beat(12):
            self.play(FadeOut(g))
            g = Donut(76, "of the compute saved")
            self.play(Create(g.ring), Create(g.arc), FadeIn(g.value), FadeIn(g.label))
        with self.beat(13):
            self.play(FadeOut(g))
            g = Quote("Attention is all you need to model long-range dependencies in text.", "Vaswani et al., 2017")
            self.play(FadeIn(g.mark), Write(g.text), FadeIn(g.source))
        with self.beat(14):
            self.play(FadeOut(g))
            e = Equation(["y", "=", "F(x)", "+", "x"], colors=[None, None, ACCENT, None, ACCENT2])
            self.play(LaggedStart(*[Write(p) for p in e]))
            co = Callout(e[4], "the shortcut", DR)
            self.play(FadeIn(co))
        with self.beat(15):
            self.play(FadeOut(e), FadeOut(co))
            g = IconRow([("brain", "Reasoning"), ("languages", "Translation"), ("code", "Coding"), ("image", "Vision")])
            v = Venn("Speed", "Accuracy", "both").scale(0.6).move_to([0, -1.5, 0])
            self.play(LaggedStart(*[FadeIn(x, shift=UP * 0.3) for x in g]))
'''
import tempfile
work = tempfile.mkdtemp(prefix="kit_smoke_")
open(f"{work}/section.py", "w", encoding="utf-8").write(ns["HARNESS"] + "\n\n" + code + "\n")
for f in ("audit.json", "beat_times.json"):
    try: os.remove(f"{work}/{f}")
    except FileNotFoundError: pass
p = subprocess.run([os.environ.get("MANIM_PYTHON") or sys.executable, "-m", "manim", "render", "-ql", "--disable_caching", "--media_dir", "media", "-o", "section.mp4", "section.py", "Section"], cwd=work, capture_output=True, text=True, timeout=900)
print("manim exit code", p.returncode)
if p.returncode:
    print((p.stdout or "")[-1500:], (p.stderr or "")[-2500:]); sys.exit(1)
issues = json.load(open(f"{work}/audit.json", encoding="utf-8")) if os.path.exists(f"{work}/audit.json") else None
if issues is None:
    print("no audit.json: the harness did not run"); sys.exit(1)
for x in issues: print("LAYOUT ISSUE", x)
bt = json.load(open(f"{work}/beat_times.json"))
print("beats rendered:", len(bt["starts"]), "| layout issues:", len(issues))
sys.exit(1 if issues or len(bt["starts"]) != 16 else 0)
