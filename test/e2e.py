"""End-to-end check against the local dev server (npm run dev). Uses headless Chromium.
Seeds fake candidates, drives the admin UI, the exit poll and the noticeboard, and saves screenshots
(OUT/*.png for the flow, OUT/gallery/* for every page at 390px and 1280px in light and dark)."""
import json, sys, os, datetime, http.client, urllib.parse, urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:8080")
OUT = sys.argv[1] if len(sys.argv) > 1 else "shots"
os.makedirs(f"{OUT}/gallery", exist_ok=True)

def raw_get(path):
    """GET without following redirects: (status, location)."""
    u = urllib.parse.urlparse(BASE)
    c = http.client.HTTPConnection(u.hostname, u.port)
    c.request("GET", path)
    r = c.getresponse()
    r.read()
    return r.status, r.getheader("location")

def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json", "authorization": "Bearer dev:seed"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

IMPORT = """# Chairperson
Anjali Krishnan | Red Front
Rahul Menon | Blue Union
Fathima Nazar | Independent Alliance
# Vice Chairperson
Arjun Pillai | Red Front
Meera Nair | Blue Union
# General Secretary
Vishnu Das | Red Front
Akhil Thomas | Blue Union
# Magazine Editor
Neha Joseph | Red Front
Sreehari V | Blue Union
# Arts Club Secretary
Gokul Raj | Red Front
Ann Mariya | Blue Union
# University Union Councillors
Adithya S | Red Front
Hari Prasad | Red Front
Nikhil George | Blue Union
Devika R | Blue Union
# Women Representatives
Aparna M | Red Front
Lakshmi Priya | Red Front
Sneha Varghese | Blue Union
# B.Tech Civil Engineering
Ashwin K | Red Front
Joel Mathew | Blue Union
# B.Tech Mechanical Engineering
Sanjay P | Red Front
Karthik Nair | Blue Union
# B.Tech Computer Science & Engineering
Navya S | Red Front
Rohan Varma | Blue Union
# B.Tech Applied Electronics & Instrumentation
Ameen Shah | Blue Union
# B.Tech Electrical & Electronics Engineering
Varun T | Red Front
# M.Tech Structural Engineering
Divya Mohan | Red Front
Sabu K | Blue Union
# MCA Master of Computer Applications
Riya Thomas
# M.Tech Power Systems
Jishnu R | Red Front
"""

errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    st, r = api("POST", "/api/admin/import", {"text": IMPORT})
    assert st == 200, r
    st, s = api("GET", "/api/admin/state")
    parties = s["all"]["parties"]
    colours = {"Red Front": "#c62828", "Blue Union": "#1f5fbf", "Independent Alliance": "#2e7d32"}
    for pt in parties: pt["colour"] = colours.get(pt["name"], pt["colour"])
    api("PUT", "/api/admin/parties", {"parties": parties})
    posts = {p["id"]: p for p in s["all"]["posts"]}
    def cid(post, i): return posts[post]["candidates"][i]["id"]
    # some counts
    api("POST", "/api/admin/posts/chair/batches", {"label": "Booth 1", "votes": {cid("chair", 0): 312, cid("chair", 1): 287, cid("chair", 2): 64}, "invalid": 11})
    api("POST", "/api/admin/posts/chair/batches", {"label": "Booth 2", "votes": {cid("chair", 0): 198, cid("chair", 1): 241, cid("chair", 2): 40}, "invalid": 6})
    api("POST", "/api/admin/posts/uuc/batches", {"label": "Booth 1", "votes": {cid("uuc", 0): 410, cid("uuc", 1): 380, cid("uuc", 2): 402, cid("uuc", 3): 350}, "invalid": 9})
    api("POST", "/api/admin/posts/gensec/batches", {"label": "Round 1", "votes": {cid("gensec", 0): 520, cid("gensec", 1): 430}, "invalid": 4})
    api("POST", "/api/admin/posts/gensec/finalize", {})
    api("POST", "/api/admin/posts/ug-cse/batches", {"label": "CSE", "votes": {cid("ug-cse", 0): 140, cid("ug-cse", 1): 151}})
    api("POST", "/api/admin/posts/ug-cse/finalize", {})
    api("POST", "/api/admin/posts/pg-structural/batches", {"label": "All", "votes": {cid("pg-structural", 0): 22, cid("pg-structural", 1): 17}})

    # open the exit poll now
    now = datetime.datetime.now(datetime.timezone.utc)
    iso = lambda d: d.isoformat()
    st, s = api("GET", "/api/admin/state")
    st, r = api("PUT", "/api/admin/settings", {"settings": {"pollOpensAt": iso(now - datetime.timedelta(minutes=5)), "pollClosesAt": iso(now + datetime.timedelta(hours=1)), "pollRevealAt": iso(now + datetime.timedelta(hours=1)), "notice": "Counting for the main panel starts at 2 pm in the main hall."}, "version": s["all"]["settings"]["version"]})
    assert st == 200, r

    def page(w, h, mobile=False, scheme="light", reduced="no-preference", welcome_seen=True, init=None):
        ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile,
                            color_scheme=scheme, reduced_motion=reduced)
        if welcome_seen:  # the first-visit note would otherwise sit over every page in these tests
            ctx.add_init_script("try { localStorage.setItem('welcome-seen-v1', '1') } catch (e) {}")
        if init:
            ctx.add_init_script(init)
        pg = ctx.new_page()
        pg.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        return pg

    def no_overflow(pg, what):
        over = pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        assert over <= 0, f"{what}: page scrolls sideways by {over}px"

    def gallery(name, path, ready, prep=None):
        """Screenshot one page at 390px and 1280px in light and dark (motion off so shots are settled)."""
        for w, h, mobile in ((390, 844, True), (1280, 900, False)):
            for scheme in ("light", "dark"):
                g = page(w, h, mobile, scheme, "reduce")
                g.goto(BASE + path)
                if prep: prep(g)
                g.wait_for_selector(ready)
                g.wait_for_timeout(400)
                no_overflow(g, f"{name} {w} {scheme}")
                g.screenshot(path=f"{OUT}/gallery/{name}-{w}-{scheme}.png", full_page=True)
                g.context.close()

    # ---- clean URLs and redirects (same function as CloudFront) ----
    for path, want in (("/poll.html", "/poll"), ("/board.html", "/board"), ("/privacy.html", "/privacy"), ("/index.html", "/"),
                       ("/admin.html?code=abc-123&state=x_Y", "/admin?code=abc-123&state=x_Y"), ("/poll/", "/poll")):
        st, loc = raw_get(path)
        assert (st, loc) == (301, want), (path, st, loc)
    for path in ("/", "/poll", "/board", "/privacy", "/admin", "/data/results.json", "/api/health"):
        st, _ = raw_get(path)
        assert st == 200, (path, st)

    # ---- first-visit welcome note ----
    def welcome_open(g): return g.evaluate("!!document.querySelector('#welcome[open]')")
    for scheme in ("light", "dark"):
        g = page(390, 844, True, scheme, welcome_seen=False)
        g.goto(BASE + "/")
        g.wait_for_selector("#welcome[open]")
        g.wait_for_selector(".post")  # results load behind it
        g.wait_for_timeout(500)
        g.screenshot(path=f"{OUT}/gallery/welcome-390-{scheme}.png")
        g.context.close()
    w = page(1280, 900, welcome_seen=False)
    w.goto(BASE + "/admin")
    w.wait_for_selector("#login:not([hidden])")
    assert not welcome_open(w), "no welcome note on /admin"
    w.goto(BASE + "/privacy")
    w.wait_for_selector(".prose")
    assert not welcome_open(w), "no welcome note on /privacy"
    w.goto(BASE + "/")
    w.wait_for_selector("#welcome[open]")
    assert w.get_attribute("#welcome", "aria-labelledby") == "welcome-title"
    assert w.inner_text("#welcome-title") == "Before you start"
    assert w.evaluate("document.activeElement.id") == "welcome-ok", "focus starts on Got it"
    w.click("#welcome-ok")
    assert not welcome_open(w)
    w.reload()
    w.wait_for_selector(".post")
    w.wait_for_timeout(300)
    assert not welcome_open(w), "not again after a reload"
    w.goto(BASE + "/poll")
    w.wait_for_selector("#poll-form-wrap:not([hidden]), #poll-wait:not([hidden])")
    assert not welcome_open(w), "not again on /poll"
    w.context.close()
    for how in ("escape", "backdrop", "privacy"):
        w = page(390, 844, True, welcome_seen=False)
        w.goto(BASE + "/board")
        w.wait_for_selector("#welcome[open]")
        if how == "escape": w.keyboard.press("Escape")
        elif how == "backdrop": w.mouse.click(5, 5)
        else:
            w.click("#welcome-privacy")
            w.wait_for_url(BASE + "/privacy")
            w.wait_for_selector(".prose")
        assert not welcome_open(w), how
        assert w.evaluate("localStorage.getItem('welcome-seen-v1')") == "1", how
        w.goto(BASE + "/")
        w.wait_for_selector(".post")
        w.wait_for_timeout(300)
        assert not welcome_open(w), f"dismissed by {how}, should stay away"
        w.context.close()
    # storage blocked: shows on each load and the page still works
    w = page(390, 844, True, welcome_seen=False, init="Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked') } })")
    w.goto(BASE + "/")
    w.wait_for_selector("#welcome[open]")
    w.click("#welcome-ok")
    w.wait_for_selector(".post")
    w.reload()
    w.wait_for_selector("#welcome[open]")
    w.context.close()

    # ---- public results ----
    pg = page(1280, 900)
    pg.goto(BASE + "/")
    pg.wait_for_selector(".post")
    pg.wait_for_timeout(900)
    pg.screenshot(path=f"{OUT}/results-desktop.png", full_page=True)
    m = page(390, 844, True)
    m.goto(BASE + "/")
    m.wait_for_selector(".post")
    m.wait_for_timeout(900)
    m.screenshot(path=f"{OUT}/results-mobile.png", full_page=False)
    m.screenshot(path=f"{OUT}/results-mobile-full.png", full_page=True)
    # mobile: bottom tab bar, not the top nav; theme toggle cycles system -> light -> dark -> system and persists
    assert m.is_visible(".tab-bar a[aria-current='page']:has-text('Results')") and not m.is_visible(".top-nav")
    assert pg.is_visible(".top-nav a[aria-current='page']") and not pg.is_visible(".tab-bar")
    assert m.get_attribute("html", "data-theme") is None
    m.click("[data-theme-toggle]")
    assert m.get_attribute("html", "data-theme") == "light"
    m.click("[data-theme-toggle]")
    assert m.get_attribute("html", "data-theme") == "dark"
    m.reload()
    m.wait_for_selector(".post")
    assert m.get_attribute("html", "data-theme") == "dark", "theme choice should survive a reload"
    m.click("[data-theme-toggle]")
    assert m.get_attribute("html", "data-theme") is None
    # a post that receives a count update gets a one-off highlight; its numbers count up to the new total
    api("POST", "/api/admin/posts/chair/batches", {"label": "Booth 3", "votes": {cid("chair", 0): 50}, "invalid": 0})
    pg.wait_for_selector("#post-chair.bump", timeout=8000)
    pg.wait_for_timeout(900)
    assert pg.inner_text(f"#post-chair .n[data-key='chair|{cid('chair', 0)}']") == "560"
    # count-update table opens and closes
    pg.click("#post-chair [data-toggle]")
    pg.wait_for_selector("#post-chair .batches")
    pg.click("#post-chair [data-toggle]")
    pg.wait_for_selector("#post-chair .batches", state="detached")
    gallery("results", "/", ".post")

    # ---- exit poll: submit via UI ----
    gallery("poll-form", "/poll", "#poll-form-wrap:not([hidden]) fieldset.q")
    gallery("privacy", "/privacy", ".prose")
    m.goto(BASE + "/poll")
    m.wait_for_selector("#poll-form-wrap:not([hidden])")
    assert m.is_visible(".tab-bar a[aria-current='page']:has-text('Exit poll')")
    m.fill("#uid", "tve23cs045")
    m.select_option("#dept", "ug-cse")
    m.select_option("#year", "3")
    m.check(f"input[name='q-chair'][value='{cid('chair', 1)}']")
    m.check(f"input[name='q-uuc'][value='{cid('uuc', 0)}']")
    m.check(f"input[name='q-uuc'][value='{cid('uuc', 2)}']")
    m.click(f"input[name='q-uuc'][value='{cid('uuc', 3)}']")  # third pick must be refused
    assert not m.is_checked(f"input[name='q-uuc'][value='{cid('uuc', 3)}']")
    m.check(f"input[name='q-ug-cse'][value='{cid('ug-cse', 0)}']")
    m.screenshot(path=f"{OUT}/poll-form-mobile.png", full_page=True)
    m.click("#poll-submit")
    m.wait_for_selector("#poll-done:not([hidden])")
    m.screenshot(path=f"{OUT}/poll-done-mobile.png")

    # more responses via API so groups pass the minimum, then reveal
    import hashlib
    def voter(i): return hashlib.sha256(f"cetunion2026:TVE23ME{i:03d}".encode()).hexdigest()
    import random
    random.seed(4)
    for i in range(1, 60):
        dept = random.choice(["ug-me", "ug-cse", "ug-ce"])
        ch = {"chair": [cid("chair", random.choice([0, 0, 1, 1, 1, 2]))], "uuc": random.sample([cid("uuc", k) for k in range(4)], 2),
              "vice": [cid("vice", random.choice([0, 1]))], dept: [cid(dept, random.choice([0, 1]))]}
        st, r = api("POST", "/api/poll", {"voter": voter(i), "dept": dept, "year": random.randint(1, 4), "choices": ch})
        assert st == 201, r
    st, s = api("GET", "/api/admin/state")
    api("PUT", "/api/admin/settings", {"settings": {"pollOpensAt": iso(now - datetime.timedelta(hours=2)), "pollClosesAt": iso(now - datetime.timedelta(minutes=1)), "pollRevealAt": iso(now - datetime.timedelta(minutes=1))}, "version": s["all"]["settings"]["version"]})
    m.goto(BASE + "/poll")
    m.wait_for_selector("#leaderboard:not([hidden]) .post")
    m.wait_for_timeout(700)
    m.screenshot(path=f"{OUT}/poll-results-mobile.png", full_page=True)
    m.click("#lb-seg button[data-b='dept']")
    m.screenshot(path=f"{OUT}/poll-bydept-mobile.png", full_page=True)
    gallery("poll-results", "/poll", "#leaderboard:not([hidden]) .post")
    pg.goto(BASE + "/")
    pg.wait_for_selector(".poll-tick")
    pg.wait_for_timeout(900)
    pg.screenshot(path=f"{OUT}/results-with-exitpoll.png", full_page=False)

    # ---- noticeboard ----
    m.goto(BASE + "/board")
    m.wait_for_selector("#board")
    m.fill("#title", "Fix the canteen queue first")
    m.fill("#body", "Whoever wins chairperson, please sort out the lunch queue at the main canteen. Forty minutes every day is too long.")
    m.fill("#uid", "TVE24EC101")
    m.click("#post-submit")
    m.wait_for_selector(".slip h3")
    m.fill("#body", "short")
    m.click("#post-submit")
    m.wait_for_selector("#post-msg:not([hidden])")
    assert "at least 5" in m.inner_text("#post-msg")
    m.click(".slip [data-act='comments']")
    m.wait_for_selector(".comment-form input")
    m.fill(".comment-form input", "Seconded. The queue is ridiculous.")
    m.click(".comment-form button")
    m.wait_for_selector("#id-dialog[open]")
    m.click("#dlg-go")
    m.wait_for_selector(".comments li")
    m.screenshot(path=f"{OUT}/board-mobile.png", full_page=True)
    m.click(".slip [data-act='comments']")
    m.wait_for_selector(".slip .comments", state="detached")
    gallery("board", "/board", ".slip h3")

    # ---- admin UI ----
    a = page(1280, 900)
    a.goto(BASE + "/admin")
    a.click("#login-btn")
    a.wait_for_selector("#post-list button")
    a.click("#post-list button[data-post='vice']")
    a.fill("#b-label", "Booth 1")
    a.fill(f"#v-{cid('vice', 0)}", "250")
    a.fill(f"#v-{cid('vice', 1)}", "260")
    a.fill("#v-invalid", "3")
    a.click("#batch-form button[type='submit']")
    a.wait_for_selector("text=Updates entered")
    # running totals mode
    a.select_option("#b-mode", "total")
    a.fill("#b-label", "Booth 2 (totals)")
    a.fill(f"#v-{cid('vice', 0)}", "400")
    a.fill(f"#v-{cid('vice', 1)}", "380")
    a.click("#batch-form button[type='submit']")
    a.wait_for_timeout(500)
    st, s = api("GET", "/api/admin/state")
    vice = next(p for p in s["results"]["posts"] if p["id"] == "vice")
    tot = {c["name"]: c["votes"] for c in vice["candidates"]}
    assert tot == {"Arjun Pillai": 400, "Meera Nair": 380}, tot
    a.screenshot(path=f"{OUT}/admin-count.png", full_page=True)
    def admin_prep(g):
        g.click("#login-btn")
        g.wait_for_selector("#post-list button")
        g.click("#post-list button[data-post='vice']")
    gallery("admin-count", "/admin", "#count-panel .table", admin_prep)
    a.click("#declare")
    a.wait_for_selector("#declare-dialog[open]")
    a.click("#declare-go")
    a.wait_for_selector("#reopen")
    a.click("#admin-tabs button[data-tab='candidates']")
    a.screenshot(path=f"{OUT}/admin-candidates.png")
    a.click("#admin-tabs button[data-tab='moderation']")
    a.click("#mod-seg button[data-f='all']")
    a.wait_for_selector(".mod-item")
    a.screenshot(path=f"{OUT}/admin-moderation.png")
    a.click("#admin-tabs button[data-tab='exitpoll']")
    a.wait_for_selector("#ep-spark span")
    a.screenshot(path=f"{OUT}/admin-exitpoll.png", full_page=True)
    a.click("#admin-tabs button[data-tab='settings']")
    a.screenshot(path=f"{OUT}/admin-settings.png", full_page=True)
    a.click("#admin-tabs button[data-tab='log']")
    a.wait_for_selector("#audit tr")
    # dark mode check
    d = b.new_context(viewport={"width": 1280, "height": 900}, color_scheme="dark").new_page()
    d.goto(BASE + "/")
    d.wait_for_selector(".post")
    d.wait_for_timeout(900)
    d.screenshot(path=f"{OUT}/results-dark.png")
    b.close()

bad = [e for e in errors if "fonts.g" not in e and "net::ERR" not in e]
print("console problems:", json.dumps(bad, indent=1) if bad else "none")
print("all errors:", json.dumps(errors, indent=1))
