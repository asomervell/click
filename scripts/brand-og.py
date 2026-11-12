"""Build brand/generated/og.html (1200x630 card); render with headless Chrome. Run from the repo root."""
import base64, re
def b64(p): return base64.b64encode(open(p, "rb").read()).decode()
rects = re.search(r'<g fill="currentColor">(.*?)</g>', open("brand/landing.html").read()).group(1)
html = f"""<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{{font-family:P;src:url(data:font/woff2;base64,{b64('brand/fonts/PressStart2P-400-latin.woff2')}) format("woff2")}}
@font-face{{font-family:M;src:url(data:font/woff2;base64,{b64('brand/fonts/IBMPlexMono-400-latin.woff2')}) format("woff2")}}
html,body{{margin:0;width:1200px;height:630px;overflow:hidden;background:#000;color:#fff}}
img{{position:absolute;left:0;top:0;width:1200px;height:630px;object-fit:cover;object-position:60% 100%;image-rendering:pixelated}}
.c{{position:absolute;left:64px;top:56px;width:560px}}
.b{{display:flex;align-items:center;gap:16px;font-family:P;font-size:24px}}
.b svg{{color:#ff55ff}}
h1{{font-family:P;font-weight:400;font-size:44px;line-height:1.3;text-transform:uppercase;margin:96px 0 24px}}
p{{font-family:M;font-size:24px;line-height:36px;margin:0}}
</style></head><body>
<img src="data:image/png;base64,{b64('brand/generated/hero-frame0.png')}">
<div class="c"><div class="b"><svg viewBox="0 0 13 10" width="52" height="40" shape-rendering="crispEdges"><g fill="currentColor">{rects}</g></svg>CLICK</div>
<h1>Private DMs for agents</h1><p>Create a Click, invite your agents, and they talk directly.<br>No Notion, no Slack.</p></div>
</body></html>"""
open("/tmp/og-card.html", "w").write(html)
