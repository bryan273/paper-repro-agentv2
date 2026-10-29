"""Tests of the parts of the video pipeline that decide things without a model or a renderer.
manim_section.py is a script (it runs a job when imported), so the pure pieces are cut out of its source and run here. No keys, no network."""
import ast
import json
import os
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SRC = (ROOT / "manim_section.py").read_text(encoding="utf-8")


def cut(start, end):
    return SRC[SRC.index(start):SRC.index(end)]


def namespace(extra=None):
    ns = {"re": re, "ast": ast, "os": os, "json": json}
    ns.update(extra or {})
    return ns


GOOD = "class Section(ExplainerScene):\n    def construct(self):\n        with self.beat(0):\n            self.wait(1)\n"


def test_tidy_keeps_valid_code_and_cuts_prose_around_it():
    ns = namespace()
    exec(cut("def tidy(code):", "def strip_imports(code):"), ns)
    tidy = ns["tidy"]
    assert tidy(GOOD) == GOOD
    for messy in ("Here is the scene:\n" + GOOD, GOOD + "\nThis scene works by fading things in.", "Sure!\n" + GOOD + "Hope it helps\nThanks"):
        out = tidy(messy)
        ast.parse(out)
        assert out.startswith("class Section")


def beats_ns(n):
    ns = namespace({"beats": [3.0] * n})
    exec(cut("BANNED = {", "def ask(messages"), ns)
    return ns


def test_gate_accepts_one_beat_block_per_beat():
    ns = beats_ns(1)
    assert ns["check"](GOOD) is None


@pytest.mark.parametrize("bad", [
    "import os\n" + GOOD,
    GOOD.replace("self.wait(1)", "x = MathTex('a')"),
    GOOD.replace("self.wait(1)", "x = open('f')"),
    GOOD.replace("self.wait(1)", "self.camera.frame.scale(2)"),
    GOOD.replace("with self.beat(0):", "with self.beat(5):"),
])
def test_gate_rejects_unsafe_or_wrong_code(bad):
    ns = beats_ns(1)
    assert ns["check"](bad)


def test_gate_rejects_missing_beats():
    ns = beats_ns(2)
    assert "beat" in ns["check"](GOOD)


def captions(lang, words, sentence):
    ns = namespace({"NARR_DELAY": 0.15, "ACC": "#3dff8f", "work": str(ROOT / "tests"), "idx": [0],
                    "sc": {"scenes": [{"en": sentence, "zh": sentence}]}, "words_of": lambda lg, i: words})
    exec(cut("def ass_color(h):", "def subs_and_audio(vid, times):"), ns)
    ns["caption_track"](lang, [0.0], 8.0)
    out = ROOT / "tests" / f"subs_{lang}.ass"
    lines = [l for l in out.read_text(encoding="utf-8").splitlines() if l.startswith("Dialogue")]
    out.unlink()
    return lines


def test_english_captions_light_the_spoken_word_phrase_by_phrase():
    words = [[0.1, 0.5, "Residual"], [0.7, 1.2, "networks"], [1.3, 1.5, "let"], [1.6, 1.9, "very"], [2.0, 2.3, "deep"], [2.4, 2.8, "models"], [2.9, 3.3, "train"], [3.4, 3.8, "well."]]
    lines = captions("en", words, "Residual networks let very deep models train well.")
    assert len(lines) >= len(words) - 1
    assert all("\\c&H008fff3d&" in l for l in lines)                 # one word is lit in every line
    assert "Residual" in lines[0] and "networks" in lines[1]


def test_chinese_captions_have_no_spaces_and_follow_the_words():
    words = [[0.1, 0.5, "残差"], [0.5, 0.9, "网络"], [0.9, 1.1, "让"], [1.1, 1.5, "模型"], [1.5, 2.0, "训练"]]
    lines = captions("zh", words, "残差网络让模型训练。")
    assert lines and all(" " not in l.split(",,")[-1].replace("{\\c&H008fff3d&}", "").replace("{\\c&H00FFFFFF&}", "") for l in lines)


def test_captions_fall_back_to_whole_sentences_without_word_timings():
    lines = captions("en", [], "No timings here.")
    assert len(lines) == 1 and lines[0].endswith("No timings here.")


def test_every_icon_the_prompt_offers_exists_and_is_plain_svg():
    prompt = SRC[SRC.index("Icons: "):SRC.index("Every kit piece")]
    names = prompt.replace("Icons:", "").split()
    missing = [n for n in names if not (ROOT / "icons" / f"{n}.svg").exists()]
    assert not missing, missing
    for n in names:
        assert (ROOT / "icons" / f"{n}.svg").read_text(encoding="utf-8").lstrip().startswith(("<", "<!--")), n   # a Git LFS pointer would not


def test_kit_is_valid_python_and_exports_what_the_prompt_promises():
    tree = ast.parse((ROOT / "kit.py").read_text(encoding="utf-8"))
    defined = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
    promised = {"Heading", "BigNumber", "Counter", "Bars", "HBars", "LinePlot", "Donut", "Compare", "Pipeline", "Timeline", "IconRow", "IconLabel", "Icon",
                "Tokens", "Attention", "NeuralNet", "Heatmap", "Stack", "Equation", "Quote", "Venn", "Callout", "Box", "Lbl", "fit", "wrap"}
    assert promised <= defined, promised - defined
