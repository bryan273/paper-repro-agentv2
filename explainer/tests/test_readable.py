"""ensure_readable() stops a garbled document at the first step. It is read out of gen.py as source so the test needs none of gen.py's heavy dependencies."""
import os, re, pytest

SRC = open(os.path.join(os.path.dirname(__file__), "..", "gen.py"), encoding="utf-8").read()
m = re.search(r"^def ensure_readable\(.*?(?=^def paper_url)", SRC, re.S | re.M)
assert m, "ensure_readable not found in gen.py"
ns = {"re": re}
exec(m.group(0), ns)
ensure_readable = ns["ensure_readable"]

EN = ("Photosynthesis lets plants make sugar from light, water and carbon dioxide. " * 12) + "The leaf holds chloroplasts that capture sunlight with chlorophyll. " * 6
VI = "Quang hợp giúp thực vật tạo ra đường từ ánh sáng, nước và khí cacbon đioxit. Lá chứa lục lạp để hấp thụ ánh sáng mặt trời. " * 8
ZH = "光合作用让植物利用光、水和二氧化碳制造糖分。叶片中的叶绿体通过叶绿素捕获阳光。" * 12
GARBLED = "ǆȜǭǮǰǳȝȞȟ ȠȡȢ ǆǇǈǉǊ ǋǌǍǎǏǐ ȀȁȂȃȄȅ ǞǟǠǡǢǣ ǤǥǦǧǨǩ " * 60
SYMBOLS = " " * 400


@pytest.mark.parametrize("text", [EN, VI, ZH, EN + VI + ZH])
def test_real_text_passes(text):
    assert ensure_readable(text, "link") == text


@pytest.mark.parametrize("text", [GARBLED, SYMBOLS, "x" * 50, "�" * 500, "1 2 3 4 5 6 7 8 9 0 " * 100])
def test_garbled_text_stops_early(text):
    with pytest.raises(RuntimeError) as e:
        ensure_readable(text, "PDF")
    assert "could not read" in str(e.value).lower()
