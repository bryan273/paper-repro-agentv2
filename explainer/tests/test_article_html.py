import re
from pathlib import Path
SRC = Path(__file__).resolve().parents[1].joinpath("gen.py").read_text(encoding="utf-8")
m = re.search(r"^def article_html\(h\):.*?(?=^def clean)", SRC, re.S | re.M)
ns = {"re": re}; exec(m.group(0), ns); article_html = ns["article_html"]

def test_article_body_without_menus():
    body = "<p>" + "Real article sentence about the topic. " * 60 + "</p>"
    page = f"<html><nav>Home Sport Weather</nav><header>Site</header><article>{body}</article><footer>Contact us</footer></html>"
    out = article_html(page)
    assert "Real article sentence" in out and "Home Sport" not in out and "Contact us" not in out

def test_short_article_falls_back_to_whole_page():
    page = "<html><article><p>tiny</p></article><div>more text here</div></html>"
    assert "more text here" in article_html(page)
