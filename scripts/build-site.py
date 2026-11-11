"""Turns the Claude Design standalone exports into the site in public/.

    python3 scripts/build-site.py                        # both pages, from ~/Downloads/standalone
    python3 scripts/build-site.py --from ~/other/folder  # exports kept elsewhere
    python3 scripts/build-site.py --agent https://partners.lyzr.ai/agent \
                                  --assets https://partners.lyzr.ai \
                                  --links https://www.lyzr.ai/emerging-partners

Two exports make the site:

    Lyzr Emerging Partners.html  ->  public/index.html
    Lyzr Partner Directory.html  ->  public/partners.html

Each export is one 2-10MB file: a JSON-escaped page template, a manifest of base64
assets, and a boot script that decodes everything into blob URLs and replaces the
documentElement. Nothing paints until all of it has arrived. So we do that work here,
once: every asset — manifest entries and the `data:` URIs inlined in the markup — is
written to public/assets/ under its content hash, the page points at those files, and
the boot script and its splash go away. The browser then loads the assets the normal
way: in parallel, after first paint, and cached between visits.

The agent embed now lives in the design source itself (it is the script that opens the
overlay over the hero form), so there is nothing left to patch in. The export also
carries a whole copy of the agent page inline, as `window.__AGENT_HTML`, to run the
overlay from a srcdoc. We drop it: the agent is a real page at /agent.html, the overlay
falls back to it on its own, and the landing page is ~900KB lighter for every visitor
who never opens it.

--agent is the one thing that has to be decided at build time. The export opens the
overlay on a *relative* `agent.html`, which is right while the whole site is one
deployment. When the landing page is lifted out — onto lyzr.ai, where it is static HTML
in a CMS and there is no Node to answer /api — the agent stays behind on its own
deployment and the iframe has to name it absolutely. Nothing else about the page
changes, and nothing about the agent does: it keeps talking to the API on its own
origin, so there is no CORS, no third-party cookie, no shared build. Edit the agent,
redeploy it, and the page on lyzr.ai is serving the new one the next time anyone opens
the overlay.

--assets is the same idea for the page's own images and fonts. They are written as
/assets/... , which only resolves if the page sits at the root of its own deployment.
Point --assets at the deployment and the built page references them there instead, which
leaves one self-contained HTML file to paste into the CMS and nothing to upload beside
it. Re-export the design, rebuild, paste again: the architecture does not move.
"""
import base64, gzip, hashlib, io, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
PUBLIC = os.path.join(ROOT, "public")
ASSETS = os.path.join(PUBLIC, "assets")

PAGES = [
    ("Lyzr Emerging Partners.html", "index.html"),
    ("Lyzr Partner Directory.html", "partners.html"),
]

# The two exports link to each other by filename, because side by side in a folder that is
# what they are. On the site they are routes, so the links are rewritten to the routes.
# --links moves them to another origin, the way --agent and --assets do.
ROUTES = {
    "Lyzr Emerging Partners.html": "/",
    "Lyzr Partner Directory.html": "/partners",
}

EXT = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
    "image/svg+xml": ".svg", "image/gif": ".gif", "image/avif": ".avif",
    "font/woff2": ".woff2", "font/woff": ".woff", "font/ttf": ".ttf",
    "text/javascript": ".js", "application/javascript": ".js",
    "text/css": ".css", "application/json": ".json",
}

# The one image above the fold. Everything else is told to load lazily, so a scroll-down
# image never competes with the hero for bandwidth.
EAGER_ALT_HINT = "velodrome"

DATA_URI = re.compile(r"data:([a-zA-Z0-9/+.-]+);base64,([A-Za-z0-9+/=]+)")


def section(s, name):
    m = re.search(r'<script type="__bundler/%s"[^>]*>(.*?)</script>' % name, s, re.S)
    return m.group(1) if m else None


def write_asset(data, mime):
    """One file per distinct payload, named by its hash, so the two pages share."""
    name = hashlib.sha1(data).hexdigest()[:16] + EXT.get(mime, ".bin")
    path = os.path.join(ASSETS, name)
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.write(data)
    return "/assets/" + name


def build(src, out_name, agent_url=None, assets_base=None, links_base=None):
    s = io.open(src, encoding="utf-8").read()

    manifest_raw, template_raw = section(s, "manifest"), section(s, "template")
    if not manifest_raw or not template_raw:
        sys.exit("no bundle in %s — is it a standalone export?" % src)
    pages = json.loads(section(s, "page_order") or "[]")
    if pages:
        sys.exit("%s ships nested page bundles; unbundling those is not implemented" % src)

    template = json.loads(template_raw)
    bytes_out = 0

    # 1. The agent is its own page. The inline copy only exists to feed an iframe srcdoc,
    #    and the overlay already falls back to /agent.html when it is not there.
    before = len(template)
    template = re.sub(r'<script>window\.__AGENT_HTML=".*?";</script>', "", template, flags=re.S)
    if len(template) == before and "__AGENT_HTML" in template:
        sys.exit("found __AGENT_HTML in %s but could not cut it out" % src)

    # 2. Manifest assets, referenced from the markup by bare uuid.
    for uuid, entry in json.loads(manifest_raw).items():
        data = base64.b64decode(entry["data"])
        if entry.get("compressed"):
            data = gzip.decompress(data)
        url = write_asset(data, entry.get("mime", ""))
        bytes_out += len(data)
        template = template.replace(uuid, url)

    # 3. Assets the export inlined into the markup as data: URIs — in this export that is
    #    most of the weight, fonts and photographs both.
    seen = {}

    def extract(m):
        if m.group(0) in seen:
            return seen[m.group(0)]
        try:
            data = base64.b64decode(m.group(2))
        except Exception:
            return m.group(0)
        url = seen[m.group(0)] = write_asset(data, m.group(1))
        return url

    inline = len(DATA_URI.findall(template))
    template = DATA_URI.sub(extract, template)
    bytes_out += sum(os.path.getsize(os.path.join(PUBLIC, u.lstrip("/"))) for u in set(seen.values()))

    # 4. Leftovers from the bundler: SRI hashes computed against CDN copies the export
    #    replaced (the bytes are ours now, and the attributes only make the browser refuse
    #    them), relative asset paths, and a React entry nothing on the page loads.
    template = re.sub(r'\s+(integrity|crossorigin)="[^"]*"', "", template, flags=re.I)
    template = re.sub(r'(?<![/\w])assets/', "/assets/", template)
    template = re.sub(r'"https://unpkg\.com/[^"]*": "[^"]*",? ?', "", template)

    def lazy(m):
        t = m.group(0)
        if "loading=" in t or EAGER_ALT_HINT in t.lower():
            return t
        return t[:4] + ' loading="lazy" decoding="async"' + t[4:]

    template = re.sub(r"<img\b[^>]*>", lazy, template)

    # 5. Where the overlay's iframe points. Relative by default: one deployment, one origin.
    if agent_url:
        before = template
        template = template.replace("var APP = 'agent.html';", "var APP = %s;" % json.dumps(agent_url))
        if template is before and "var APP = " in before:
            sys.exit("the agent embed in %s no longer declares APP the way --agent expects" % src)

    # 6. The link between the two pages: a filename in the export, a route on the site.
    for filename, route in ROUTES.items():
        for href in ('href="%s"' % filename, 'href="%s"' % filename.replace(" ", "%20")):
            template = template.replace(href, 'href="%s"' % ((links_base or "").rstrip("/") + route))

    # 7. And where its own images and fonts are served from.
    if assets_base:
        template = re.sub(r'(?<![\w.])/assets/', assets_base.rstrip("/") + "/assets/", template)

    out = os.path.join(PUBLIC, out_name)
    io.open(out, "w", encoding="utf-8").write(template)
    print("%-14s %6.0f KB  (%d inline assets, %.1f MB written)"
          % (out_name, os.path.getsize(out) / 1024.0, inline, bytes_out / 1048576.0))


def main(folder, agent_url=None, assets_base=None, links_base=None):
    folder = os.path.expanduser(folder)
    os.makedirs(ASSETS, exist_ok=True)
    for stale in os.listdir(ASSETS):
        os.remove(os.path.join(ASSETS, stale))
    for src_name, out_name in PAGES:
        src = os.path.join(folder, src_name)
        if not os.path.exists(src):
            sys.exit("missing export: " + src)
        build(src, out_name, agent_url, assets_base, links_base)
    print("assets -> %s (%d files)" % (ASSETS, len(os.listdir(ASSETS))))
    print("agent   -> %s" % (agent_url or "agent.html (same deployment)"))
    print("served  -> %s/assets/" % (assets_base.rstrip("/") if assets_base else ""))
    print("links   -> %s/ and %s/partners" % ((links_base or "").rstrip("/"), (links_base or "").rstrip("/")))


if __name__ == "__main__":
    args = sys.argv[1:]
    folder, agent, assets, links = "~/Downloads/standalone", None, None, None
    while args:
        a = args.pop(0)
        if a == "--agent":
            agent = args.pop(0) if args else sys.exit("--agent needs a URL")
        elif a == "--assets":
            assets = args.pop(0) if args else sys.exit("--assets needs a URL")
        elif a == "--links":
            links = args.pop(0) if args else sys.exit("--links needs a URL")
        elif a == "--from":
            folder = args.pop(0) if args else sys.exit("--from needs a folder")
        elif a.startswith("-"):
            sys.exit("unknown option: " + a)
        else:
            folder = a
    main(folder, agent, assets, links)
