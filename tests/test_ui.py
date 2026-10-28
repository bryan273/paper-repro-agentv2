"""End-to-end UI tests in replay mode (no runner, no model calls).

Serves web/ with a static server and drives it with Playwright. Uses the installed Microsoft Edge
(channel="msedge") or Chromium if available; skips if neither is.
  pip install pytest playwright
  python -m pytest tests/test_ui.py -q
"""
import http.server
import socket
import threading
from functools import partial
from pathlib import Path

import pytest

playwright = pytest.importorskip("playwright.sync_api")
WEB = Path(__file__).resolve().parent.parent / "web"


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


@pytest.fixture(scope="module")
def base_url():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), partial(_Quiet, directory=str(WEB)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{port}/"
    srv.shutdown()


@pytest.fixture(scope="module")
def browser():
    with playwright.sync_playwright() as p:
        b = None
        for kw in ({"channel": "msedge"}, {"channel": "chrome"}, {}):
            try:
                b = p.chromium.launch(headless=True, **kw)
                break
            except Exception:
                continue
        if b is None:
            pytest.skip("no Chromium-based browser available")
        yield b
        b.close()


@pytest.fixture
def page(browser):
    pg = browser.new_page(viewport={"width": 1600, "height": 1000}, accept_downloads=True)
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    yield pg
    assert pg.errors == [], pg.errors
    pg.close()


def canvas_has_ink(pg, selector):
    return pg.evaluate("""(sel) => { const c = document.querySelector(sel); if (!c || !c.width) return false;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let dark = 0; for (let i = 0; i < d.length; i += 4 * 17) if (d[i] < 200) dark++; return dark > 50; }""", selector)


def test_home_shows_samples_with_rendered_thumbnails(page, base_url):
    page.goto(base_url)
    page.wait_for_selector(".sample")
    assert page.locator(".sample").count() == 3
    page.wait_for_function("() => document.querySelectorAll('.sample canvas').length === 3")
    page.wait_for_timeout(2500)
    assert canvas_has_ink(page, ".sample[data-id='fasttext'] canvas")
    assert "Replay mode" in page.inner_text("#statusText")
    assert page.locator("#pipeSteps li").count() == 6   # the six-stage pipeline illustration


def finished(pg, url):
    """Open a recorded run at full speed: it lands on the result, with the process details folded."""
    pg.goto(url)
    pg.wait_for_selector("#resBody .vbadge", timeout=20000)


def open_details(pg):
    if pg.is_hidden("#details"):
        pg.click("#detailsBtn")
    pg.wait_for_selector("#details:not([hidden])")


def test_sample_pick_then_replay_to_verdict_with_highlights(page, base_url):
    page.goto(base_url)
    page.click(".sample[data-id='fasttext']")
    page.wait_for_selector("#picked:not([hidden])")
    assert "Bag of Tricks" in page.inner_text("#pickedTitle")
    page.click("[data-act='replay']")
    page.wait_for_selector("#run:not([hidden])")
    assert not page.is_hidden("#details")                       # watching a run shows the process
    page.click("#speedSeg button[data-s='0']")
    page.wait_for_selector("#resBody .vbadge", timeout=20000)
    assert "reproduced" in page.inner_text("#resBody").lower()
    assert page.is_hidden("#details")                           # the finished run leads with its result
    open_details(page)
    page.wait_for_function("() => document.querySelectorAll('.page').length >= 5", timeout=20000)
    page.wait_for_function("() => document.querySelectorAll('.hl').length > 20", timeout=20000)
    tags = page.eval_on_selector_all(".tag", "els => els.map(e => e.textContent)")
    assert "C1" in tags, tags                                    # the target result is highlighted
    assert page.locator(".hl.met").count() > 0                   # verifier colours applied
    assert not page.locator("#reportBtn").is_hidden()


def test_result_first_summary(page, base_url):
    finished(page, base_url + "?replay=mc-dropout-demo-mcdropout-3.jsonl&speed=0")
    assert page.is_hidden("#details")
    assert "Boston Housing" in page.inner_text("#objBody")
    assert "Acceptance criterion" in page.inner_text("#objBody")
    res = page.inner_text("#resBody")
    assert "Partially reproduced" in res and "reduced scale" in res
    assert page.locator("#resBody .kpi").count() == 3
    assert page.locator("#resBody .agree .mk").count() == 2      # reported and reproduced markers
    assert page.locator("#resBody .agree .spread").count() == 1  # standard error across repeats
    assert page.locator("#cmpBody tbody tr").count() == 6
    assert "reduced scale" in page.inner_text("#cmpBody")
    assert page.locator("#stageBar .stagebar span").count() == 5
    assert "What happened" not in page.content()


def test_view_on_paper_opens_details_at_target(page, base_url):
    finished(page, base_url + "?replay=isolation-forest-20260930-131649-58916d.jsonl&speed=0")
    page.click("#objBody [data-show]")
    page.wait_for_function("() => document.querySelectorAll('.hl').length > 10", timeout=30000)
    page.wait_for_timeout(1500)
    assert page.eval_on_selector("#pages", "e => e.scrollTop") > 500   # target is on page 8


def test_ledger_click_scrolls_the_paper(page, base_url):
    finished(page, base_url + "?replay=fasttext-demo-fasttext-3.jsonl&speed=0")
    open_details(page)
    page.wait_for_function("() => document.querySelectorAll('.hl').length > 20", timeout=30000)
    page.wait_for_timeout(800)
    before = page.eval_on_selector("#pages", "e => e.scrollTop")
    page.click("#ledgerCard li.click >> nth=0")
    page.wait_for_timeout(1200)
    after = page.eval_on_selector("#pages", "e => e.scrollTop")
    assert before != after


def test_paper_viewer_does_not_cover_the_panels(page, base_url):
    finished(page, base_url + "?replay=isolation-forest-20260930-131649-58916d.jsonl&speed=0")
    open_details(page)
    page.wait_for_selector("#verdictCard:not([hidden])")
    page.eval_on_selector("#verdictCard", "e => e.scrollIntoView()")
    page.wait_for_timeout(300)
    paper = page.locator(".paper").bounding_box()
    panels = page.locator(".panels").bounding_box()
    assert paper["y"] + paper["height"] <= panels["y"] + 1


def test_stepper_click_scrolls_timeline(page, base_url):
    finished(page, base_url + "?replay=fasttext-demo-fasttext-3.jsonl&speed=0")
    open_details(page)
    page.click("#tlFilter button[data-f='all']")
    page.eval_on_selector("#timeline", "e => e.scrollTop = 0")
    page.click("#stepper li[data-stage='verifier']")
    page.wait_for_timeout(1200)
    assert page.eval_on_selector("#timeline", "e => e.scrollTop") > 0


def test_report_download(page, base_url):
    page.goto(base_url + "?replay=mc-dropout-demo-mcdropout-3.jsonl&speed=0")
    page.wait_for_selector("#reportBtn:not([hidden])", timeout=20000)
    with page.expect_download() as dl:
        page.click("#reportBtn")
    text = Path(dl.value.path()).read_text(encoding="utf-8")
    assert "## Verdict: Partially reproduced" in text and "Measured on a clean re-run" in text


def test_timeline_key_filter_hides_minor_rows(page, base_url):
    finished(page, base_url + "?replay=fasttext-demo-fasttext-3.jsonl&speed=0")
    open_details(page)
    visible_key = page.eval_on_selector_all("#timeline .ev", "els => els.filter(e => e.offsetParent).length")
    page.click("#tlFilter button[data-f='all']")
    visible_all = page.eval_on_selector_all("#timeline .ev", "els => els.filter(e => e.offsetParent).length")
    assert visible_all > visible_key


def test_mobile_has_no_horizontal_scroll(browser, base_url):
    pg = browser.new_page(viewport={"width": 390, "height": 844})
    for url in (base_url, base_url + "?replay=isolation-forest-demo-iforest-1.jsonl&speed=0"):
        pg.goto(url)
        pg.wait_for_timeout(3500)
        over = pg.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
        assert over <= 1, (url, over)
    pg.close()


def test_process_summary_time_split_and_scrollable_run_map(page, base_url):
    finished(page, base_url + "?replay=isolation-forest-20260930-131649-58916d.jsonl&speed=0")
    open_details(page)
    page.wait_for_timeout(800)
    story = page.inner_text("#story")
    for k in ("Paper analysis", "Implementation", "Longest operation", "Independent verification"):
        assert k in story, story
    assert page.locator("#timeSplit .splitlegend > div").count() == 3
    assert page.locator("#runMap .seg-stage").count() == 5          # all five stages drawn
    assert page.locator("#runMap .c-cmd, #runMap .c-cmdfail").count() >= 10
    sc = page.eval_on_selector("#runMap .scroller", "e => [e.scrollWidth, e.clientWidth]")
    assert sc[0] > sc[1] * 1.3, sc                                 # a 32-minute run scrolls, it is not squeezed
    page.eval_on_selector("#runMap .scroller", "e => e.scrollLeft = e.scrollWidth")
    page.click("#runMap .c-cmd >> nth=-1")
    page.wait_for_timeout(900)
    assert page.locator("#timeline .target-flash").count() == 1     # clicking a bar jumps to its step


def fake_runner(pg, search_rows):
    """Answer the runner API in the browser, so the live-only home features can be tested without a server."""
    health = {"ok": True, "resources": {"cpu_cores": 4, "ram_gb": 8, "gpu": "none"}, "global_spend_cny": 0,
              "needs_key": False, "max_active": 2}
    models = {"providers": {"paratera": ["DeepSeek-V4-Flash"]}, "default": {"provider": "paratera", "model": "DeepSeek-V4-Flash"}}
    pg.route("**/api/health", lambda r: r.fulfill(json=health))
    pg.route("**/api/models", lambda r: r.fulfill(json=models))
    pg.route("**/api/runs", lambda r: r.fulfill(json=[]))
    pg.route("**/api/search?*", lambda r: r.fulfill(json=search_rows))


def test_search_by_author_lists_papers_marks_past_runs_and_picks_one(page, base_url):
    rows = [
        {"id": "2510.13311", "title": "Isolation-based Spherical Ensemble Representations", "authors": ["Yang Cao", "Yujiu Yang"],
         "published": "2025-10-15", "category": "cs.LG", "comment": "ICDM 2026", "summary": "ISER abstract.",
         "runs": [{"id": "r-iser", "status": "finished", "verdict": "reproduced"}]},
        {"id": "2601.03664", "title": "Stochastic Voronoi Ensembles for Anomaly Detection", "authors": ["Yang Cao", "Yujiu Yang"],
         "published": "2026-01-07", "category": "cs.LG", "comment": None, "summary": "SVEAD abstract.", "runs": []},
    ]
    fake_runner(page, {"already_run": rows[:1], "papers": rows[1:], "start": 0, "has_more": True})
    page.goto(base_url)
    page.wait_for_selector(".status.live")
    page.click('.tbnav a[data-pane="papers"]')   # arXiv search lives on the Browse papers pane
    page.fill("#searchIn", "Yujiu Yang")
    page.click("#searchForm button[type=submit]")
    page.wait_for_selector(".result")
    assert page.locator(".result").count() == 2
    assert "1 already run here are listed first" in page.inner_text("#searchMsg")
    assert page.locator("#moreResults").count() == 1
    assert page.locator(".result").first.locator(".au b").inner_text() == "Yujiu Yang"   # the searched author stands out
    assert page.locator(".result").first.locator(".badge.reproduced").count() == 1
    page.locator(".result").nth(1).locator("[data-pick]").click()
    assert page.input_value("#paperId") == "2601.03664"
    assert "Stochastic Voronoi" in page.inner_text("#pickedTitle")
    assert page.locator("#pickedActions [data-act=live]").count() == 1
