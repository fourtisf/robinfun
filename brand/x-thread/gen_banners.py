#!/usr/bin/env python3
import os, subprocess, sys

SC = "/tmp/claude-0/-home-user-robinfun/86abfa8c-b22c-5168-bec6-424d0050a0c1/scratchpad"
OUT = "/home/user/robinfun/brand/x-thread"
os.makedirs(OUT, exist_ok=True)
FONTS = open(SC + "/fonts/embed.css").read()
CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"

# Real Robinfun feather mark (from the site), color-agnostic via currentColor.
FEATHER = '''<svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
<path fill="currentColor" d="M50 8 C 33 9, 20 18, 15 34 C 13.6 38.5, 13.2 43.2, 14 48 L 25.2 36.8 C 25.6 32.2, 27.6 27.9, 31 24.5 C 34.5 21, 38.8 19, 43.4 18.6 L 32.5 29.5 C 36.8 29.2, 41 27.6, 44.7 24.6 C 50.2 20.2, 52.4 13.7, 50 8 Z"/>
<path fill="currentColor" d="M21.6 37.4 L24 39.3 L12 53 L10.9 51.1 Z"/>
<path stroke="#0A0F0A" stroke-width="2.1" stroke-linecap="round" opacity=".9" d="M44.4 14.4 L18.7 40.2"/>
</svg>'''

# Signature ascending candlestick motif — same across every frame (the thread thru-line).
def candles(opacity=0.16, w=560, h=300):
    # (x, open_y, close_y, high_y, low_y) roughly ascending; green=up (lime), a few red
    bars = [
        (0,   250, 230, 218, 262, 1),
        (56,  232, 244, 224, 256, 0),
        (112, 244, 210, 200, 252, 1),
        (168, 212, 188, 176, 224, 1),
        (224, 190, 202, 182, 214, 0),
        (280, 200, 158, 146, 208, 1),
        (336, 160, 132, 120, 170, 1),
        (392, 134, 150, 126, 162, 0),
        (448, 150, 96,  84,  158, 1),
        (504, 98,  60,  48,  108, 1),
    ]
    parts = [f'<svg viewBox="0 0 {w} {h}" width="{w}" height="{h}" style="opacity:{opacity}">']
    for x, o, c, hi, lo, up in bars:
        col = "#C6F23C" if up else "#FF5B4A"
        cx = x + 20
        top = min(o, c); bh = max(6, abs(c - o))
        parts.append(f'<line x1="{cx}" y1="{hi}" x2="{cx}" y2="{lo}" stroke="{col}" stroke-width="2.4"/>')
        parts.append(f'<rect x="{x+6}" y="{top}" width="28" height="{bh}" rx="3" fill="{col}"/>')
    # trend line through closes
    pts = " ".join(f"{x+20},{c}" for x, o, c, hi, lo, up in bars)
    parts.append(f'<polyline points="{pts}" fill="none" stroke="#D8FB5C" stroke-width="2" opacity=".55" stroke-linecap="round" stroke-linejoin="round"/>')
    parts.append('</svg>')
    return "".join(parts)

CSS = """
*{margin:0;padding:0;box-sizing:border-box}
""" + FONTS + """
:root{
  --ink:#080B0A; --ledger:#0F140F; --rule:#1E261B; --rule2:#2A331F;
  --cream:#F2F5EA; --dim:#A6AD98; --mute:#5F6653;
  --lime:#C6F23C; --lime2:#D8FB5C; --seal:#FF5B4A;
  --disp:'Space Grotesk',system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,monospace;
}
.stage{position:absolute;top:0;left:0;width:1600px;height:900px;overflow:hidden;
  background:var(--ink);color:var(--cream);font-family:var(--disp)}
/* textures */
.stage::before{content:"";position:absolute;inset:0;
  background-image:radial-gradient(rgba(198,242,60,.05) 1px,transparent 1px);
  background-size:5px 5px;opacity:.6}
.glow{position:absolute;width:1500px;height:820px;left:50%;top:-420px;transform:translateX(-50%);
  background:radial-gradient(ellipse 50% 60% at 50% 50%,rgba(198,242,60,.16),transparent 70%);pointer-events:none}
.glow2{position:absolute;width:900px;height:900px;right:-260px;bottom:-360px;
  background:radial-gradient(circle,rgba(198,242,60,.08),transparent 68%);pointer-events:none}
.frame{position:absolute;inset:26px;border:1px solid var(--rule);border-radius:22px;pointer-events:none}
.motif{position:absolute;right:70px;bottom:120px;pointer-events:none}
/* chrome */
.top{position:absolute;left:74px;right:74px;top:66px;display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:16px}
.mark{width:46px;height:46px;color:var(--lime);filter:drop-shadow(0 0 12px rgba(198,242,60,.55))}
.word{font-family:var(--disp);font-weight:700;font-size:31px;letter-spacing:-.01em}
.word em{color:var(--lime);font-style:normal}
.idx{font-family:var(--mono);font-weight:500;font-size:15px;color:var(--mute);letter-spacing:.12em}
.idx b{color:var(--lime)}
.bottom{position:absolute;left:74px;right:74px;bottom:60px;display:flex;align-items:center;justify-content:space-between;
  font-family:var(--mono);font-size:15px;color:var(--mute);letter-spacing:.02em;
  padding-top:22px;border-top:1px solid var(--rule)}
.bottom .site{color:var(--dim)}
.bottom .site b{color:var(--lime);font-weight:600}
/* content */
.wrap{position:absolute;left:74px;right:74px;top:170px;bottom:150px;display:flex;flex-direction:column;justify-content:center}
.eyebrow{font-family:var(--mono);font-weight:600;font-size:19px;letter-spacing:.22em;color:var(--lime);text-transform:uppercase;margin-bottom:26px;display:flex;align-items:center;gap:14px}
.eyebrow::before{content:"";width:34px;height:2px;background:var(--lime);display:inline-block}
h1{font-family:var(--disp);font-weight:700;letter-spacing:-.022em;line-height:1.02;color:var(--cream)}
.sub{font-family:var(--disp);font-weight:500;color:var(--dim);line-height:1.4;max-width:1020px}
.lime{color:var(--lime)}
.strike{color:var(--seal);text-decoration:line-through;text-decoration-thickness:3px}
.chips{display:flex;gap:14px;flex-wrap:wrap;margin-top:40px}
.chip{font-family:var(--mono);font-size:19px;color:var(--cream);border:1px solid var(--rule2);
  border-radius:99px;padding:11px 22px;background:rgba(198,242,60,.04)}
.chip b{color:var(--lime);font-weight:600}
.rows{display:flex;flex-direction:column;gap:20px;margin-top:20px}
.row{display:flex;align-items:flex-start;gap:18px;font-family:var(--disp);font-weight:500;font-size:27px;color:var(--dim)}
.row .tk{color:var(--lime);font-size:26px;flex-shrink:0;margin-top:2px}
.row b{color:var(--cream);font-weight:700}
.hero-mark{width:120px;height:120px;color:var(--lime);filter:drop-shadow(0 0 30px rgba(198,242,60,.8));margin-bottom:30px}
.big-word{font-family:var(--disp);font-weight:700;font-size:132px;letter-spacing:-.03em;line-height:.9}
.big-word em{color:var(--lime);font-style:normal}
.cta-pill{display:inline-flex;align-items:center;gap:14px;margin-top:44px;background:var(--lime);color:#0A0F0A;
  font-family:var(--disp);font-weight:700;font-size:30px;padding:20px 40px;border-radius:16px;
  box-shadow:0 0 44px rgba(198,242,60,.45);width:fit-content;letter-spacing:-.01em}
.stat-huge{font-family:var(--disp);font-weight:700;font-size:104px;letter-spacing:-.02em;line-height:1}
"""

def page(body):
    return f"<!doctype html><html><head><meta charset='utf-8'><style>{CSS}</style></head><body>{body}</body></html>"

def frame(idx, eyebrow, content, motif_op=0.16):
    return page(f'''<div class="stage">
      <div class="glow"></div><div class="glow2"></div>
      <div class="frame"></div>
      <div class="motif">{candles(motif_op)}</div>
      <div class="top">
        <div class="brand"><span class="mark">{FEATHER}</span><span class="word">Robin<em>fun</em></span></div>
        <div class="idx"><b>{idx:02d}</b> / 06</div>
      </div>
      <div class="wrap">{eyebrow}{content}</div>
      <div class="bottom">
        <span class="site"><b>robinfun.io</b></span>
        <span>X @robinfunio &nbsp;·&nbsp; t.me/robinfunio</span>
      </div>
    </div>''')

def eb(t):
    return f'<div class="eyebrow">{t}</div>'

banners = {}

# 01 — COVER / HERO
banners[1] = page(f'''<div class="stage">
  <div class="glow"></div><div class="glow2"></div>
  <div class="frame"></div>
  <div class="motif" style="right:64px;bottom:150px">{candles(0.26, 620, 340)}</div>
  <div class="top">
    <div class="brand"><span class="mark">{FEATHER}</span><span class="word">Robin<em>fun</em></span></div>
    <div class="idx"><b>01</b> / 06</div>
  </div>
  <div class="wrap">
    <span class="hero-mark">{FEATHER}</span>
    {eb("Fair-launch bonding curves · Robinhood Chain")}
    <h1 style="font-size:88px;max-width:1180px">Launch a token.<br>Collect the fee <span class="lime">— forever.</span></h1>
    <div class="sub" style="font-size:27px;margin-top:32px">A pump-style launchpad where the creator fee is written into the token
      itself — so it keeps paying you on the curve <b style="color:#F2F5EA;font-weight:700">and</b> long after graduation.</div>
  </div>
  <div class="bottom">
    <span class="site"><b>robinfun.io</b></span>
    <span>X @robinfunio &nbsp;·&nbsp; t.me/robinfunio</span>
  </div>
</div>''')

# 02 — THE PROBLEM
banners[2] = frame(2, eb("The problem"),
  '''<h1 style="font-size:70px;max-width:1220px">On every other launchpad, the<br>creator earns <span class="strike">nothing</span> after launch.</h1>
     <div class="sub" style="font-size:26px;margin-top:34px">pump.fun · four.meme · bonk.fun — you deploy, they pocket the fees, and the
       moment your coin graduates, your income stops cold.</div>
     <div class="chips">
       <span class="chip">Deploy → <b>you pay</b></span>
       <span class="chip">Trades → <b>they earn</b></span>
       <span class="chip">Graduate → <b>you get $0</b></span>
     </div>''')

# 03 — THE TWIST / EDGE
banners[3] = frame(3, eb("The Robinfun edge"),
  '''<h1 style="font-size:66px;max-width:1240px">Set a creator fee up to <span class="lime">10%</span>.<br>Every buy &amp; sell pays your wallet.</h1>
     <div class="sub" style="font-size:26px;margin-top:32px">It lives in the <b style="color:#F2F5EA;font-weight:700">token contract</b>, not the platform —
       so it never switches off. On the curve, and after it graduates to Uniswap.</div>
     <div class="chips">
       <span class="chip"><b>0–10%</b> creator fee</span>
       <span class="chip">on-curve <b>+</b> post-graduation</span>
       <span class="chip"><b>90%</b> you / <b>10%</b> stakers</span>
     </div>''')

# 04 — FAIR BY DESIGN
banners[4] = frame(4, eb("Fair launch"),
  '''<h1 style="font-size:70px;max-width:1200px">No presale. No team bags.<br><span class="lime">LP 100% burned.</span></h1>
     <div class="rows">
       <div class="row"><span class="tk">◆</span><span>Start at a <b>$4,000</b> market cap — 1B supply, all on the bonding curve.</span></div>
       <div class="row"><span class="tk">◆</span><span>Price moves deterministically. A flat <b>1% curve fee</b>, no snipers' edge.</span></div>
       <div class="row"><span class="tk">◆</span><span>Graduate at <b>~$44,000</b> to Uniswap — the pool's LP is <b>100% burned</b>.</span></div>
     </div>''')

# 05 — SAFETY / WRITTEN INTO THE CONTRACT
banners[5] = frame(5, eb("Written into the contract"),
  '''<h1 style="font-size:68px;max-width:1180px">Honeypots are <span class="lime">structurally<br>impossible.</span></h1>
     <div class="rows">
       <div class="row"><span class="tk">✓</span><span><b>Hard cap 10 / 10.</b> The factory rejects anything higher.</span></div>
       <div class="row"><span class="tk">✓</span><span><b>Rates can only go down.</b> No function exists to raise a fee.</span></div>
       <div class="row"><span class="tk">✓</span><span><b>No blacklist, no pause, no mint.</b> Transfers can't be blocked or diluted.</span></div>
       <div class="row"><span class="tk">✓</span><span><b>Mandatory dev buy.</b> Every creator holds a launch position — skin in the game.</span></div>
     </div>''')

# 06 — CTA
banners[6] = page(f'''<div class="stage">
  <div class="glow" style="top:-360px"></div><div class="glow2"></div>
  <div class="frame"></div>
  <div class="motif" style="opacity:1;right:70px;bottom:120px">{candles(0.20)}</div>
  <div class="top">
    <div class="brand"><span class="mark">{FEATHER}</span><span class="word">Robin<em>fun</em></span></div>
    <div class="idx"><b>06</b> / 06</div>
  </div>
  <div class="wrap">
    {eb("Live on Robinhood Chain")}
    <div class="big-word">Launch on<br>Robin<em>fun</em>.</div>
    <div class="sub" style="font-size:28px;margin-top:30px">Fair curves. A fee that pays you <span class="lime">forever</span>.</div>
    <span class="cta-pill">robinfun.io &nbsp;→</span>
  </div>
  <div class="bottom">
    <span class="site"><b>robinfun.io</b></span>
    <span>X @robinfunio &nbsp;·&nbsp; t.me/robinfunio</span>
  </div>
</div>''')

titles = {1:"01-cover",2:"02-problem",3:"03-edge",4:"04-fair",5:"05-safety",6:"06-cta"}
for i in range(1,7):
    hp = f"{SC}/banner-{i}.html"
    open(hp,'w').write(banners[i])
    png = f"{OUT}/robinfun-x-{titles[i]}.png"
    subprocess.run([CHROME,"--headless=new","--disable-gpu","--no-sandbox","--hide-scrollbars",
        "--force-device-scale-factor=1","--window-size=1600,900","--default-background-color=00000000",
        "--virtual-time-budget=1200",f"--screenshot={png}",f"file://{hp}"],
        check=True, stderr=subprocess.DEVNULL)
    sz = subprocess.run(["identify","-format","%wx%h",png],capture_output=True,text=True).stdout if False else ""
    print("rendered", png, os.path.getsize(png)//1024,"KB")
print("DONE")
