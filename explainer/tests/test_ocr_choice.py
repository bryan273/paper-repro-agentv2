"""pdf_text_or_ocr() picks the text a video is made from. A garbled text layer (a slide deck whose fonts map letters to other codes) must lose to the pages read as pictures, even when it is longer."""
import re, pytest

SRC = open(__import__("os").path.join(__import__("os").path.dirname(__file__), "..", "gen.py"), encoding="utf-8").read()
m = re.search(r"^def pdf_text_or_ocr\(data, text\):.*?(?=^def )", SRC, re.S | re.M)
assert m, "pdf_text_or_ocr not found in gen.py"


def load(pages, readable):
    def ensure_readable(text, what="document"):
        if not readable(text): raise RuntimeError("garbled")
    ns = {"re": re, "ensure_readable": ensure_readable, "ocr_pages": lambda data: pages}
    exec(m.group(0), ns)
    return ns["pdf_text_or_ocr"]


def test_garbled_layer_loses_to_the_pictures_even_when_longer():
    garbled = "\x00G\x00X\x00F" * 4000
    fn = load(["Overseas Outreach Training. Education changes people. " * 6], lambda t: "\x00" not in t)
    assert fn(b"pdf", garbled).startswith("Overseas Outreach")


def test_a_good_long_layer_is_kept_without_reading_pictures():
    fn = load(["should not be used"], lambda t: True)
    good = "A clear paragraph. " * 200
    assert fn(b"pdf", good) == good


def test_a_short_clean_layer_takes_the_longer_reading():
    fn = load(["Page one text. " * 300], lambda t: True)
    assert fn(b"pdf", "Title only").startswith("Page one")


def test_garbled_and_nothing_read_keeps_the_layer_for_the_error_message():
    garbled = "\x00G\x00X" * 100
    fn = load(["", ""], lambda t: "\x00" not in t)
    assert fn(b"pdf", garbled) == garbled
