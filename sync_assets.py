"""
Sync new Sydecar content into the Content Finder asset repository.

Fetches the sitemap, finds content URLs not already in index.html,
auto-tags them with Claude, and inserts them into the ASSETS array.
"""

import re
import json
import os
import xml.etree.ElementTree as ET
import requests
import anthropic

SITEMAP_URL = "https://sydecar.io/sitemap.xml"
HTML_FILE = "index.html"

# URL prefixes we care about, mapped to asset types
PREFIX_TYPE = {
    "/blog/": "blog",
    "/learn/": "learn",
    "/glossary/": "glossary",
    "/guides/": "report",
    "/webinars/": "webinar",
}

# Filter patterns — skip index pages, filter pages, /watch, /success, /v2 variants
SKIP_PATTERNS = [
    re.compile(r"^https://sydecar\.io/(blog|learn|glossary|guides|webinars)$"),
    re.compile(r"/filter/"),
    re.compile(r"/watch$"),
    re.compile(r"/success$"),
    re.compile(r"/v2$"),
]

DEAL_STAGES = ["SQL", "Warm Opportunity", "Hot Opportunity"]
PERSONAS = [
    "Fund Manager", "Emerging Manager / Syndicate", "Occasional Deal Lead",
    "Founder", "RIA", "Broker-Dealer",
]
COMPETITORS = [
    "None / not sure", "AngelList", "Carta", "Allocations",
    "Manual / DIY (law firm)",
]
CHALLENGES = [
    "Speed", "Pricing", "Compliance / regulatory questions",
    "Secondary transactions", "Building trust with LPs",
    "Layered SPVs / complex structures",
    "Building a track record / LP base",
    "Sydecar credibility / brand",
]


def fetch_sitemap_urls():
    """Fetch and parse all URLs from the sitemap."""
    resp = requests.get(SITEMAP_URL, timeout=30)
    resp.raise_for_status()
    root = ET.fromstring(resp.content)
    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    return [loc.text for loc in root.findall(".//s:loc", ns)]


def classify_url(url):
    """Return (type, True) if URL is a content page we care about, else (None, False)."""
    for pattern in SKIP_PATTERNS:
        if pattern.search(url):
            return None, False
    for prefix, asset_type in PREFIX_TYPE.items():
        if prefix in url:
            return asset_type, True
    return None, False


def slug_to_title(url):
    """Convert a URL slug into a readable title guess."""
    slug = url.rstrip("/").split("/")[-1]
    slug = slug.replace("-", " ").replace("_", " ")
    # Title-case, but keep short words lowercase
    words = slug.split()
    title_words = []
    small_words = {"a", "an", "the", "and", "or", "of", "in", "on", "for", "to", "vs", "is", "at", "by", "with"}
    for i, w in enumerate(words):
        if i == 0 or w.lower() not in small_words:
            title_words.append(w.capitalize())
        else:
            title_words.append(w.lower())
    return " ".join(title_words)


def get_existing_urls(html):
    """Extract all URLs already in the ASSETS array."""
    return set(re.findall(r'url:\s*"(https?://[^"]+)"', html))


def auto_tag(client, title, asset_type, url):
    """Use Claude to generate tags for a new asset."""
    prompt = f"""You are a content tagging assistant for Sydecar, a private markets infrastructure platform.

Given this new marketing asset, determine the most appropriate tags across these 4 dimensions:

**Asset:**
- Title: "{title}"
- Type: {asset_type}
- URL: {url}

**Tag dimensions (pick all that apply from each):**

Deal Stage: {", ".join(DEAL_STAGES)}
Persona: {", ".join(PERSONAS)}
Competitor: {", ".join(COMPETITORS)}
Challenge: {", ".join(CHALLENGES)}

Return ONLY a JSON object with these 4 keys, each containing an array of matching values:
{{ "dealStage": [...], "persona": [...], "competitor": [...], "challenge": [...] }}

Be selective. Only tag dimensions that genuinely apply based on the title and asset type. If unsure about competitors, use ["None / not sure"]."""

    resp = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=512,
        messages=[{"role": "user", "content": prompt}],
    )
    text = resp.content[0].text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return json.loads(text)


def build_asset_line(title, asset_type, url, tags_obj):
    """Build a JS object literal line for the ASSETS array."""
    all_tags = (
        tags_obj.get("dealStage", [])
        + tags_obj.get("persona", [])
        + tags_obj.get("competitor", [])
        + tags_obj.get("challenge", [])
    )
    tags_str = json.dumps(all_tags)
    title_escaped = title.replace('"', '\\"')
    return f'  {{ title: "{title_escaped}", type: "{asset_type}", url: "{url}", tags: {tags_str} }}'


def main():
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ANTHROPIC_API_KEY not set, skipping.")
        return

    # Read current HTML
    with open(HTML_FILE, "r") as f:
        html = f.read()

    existing_urls = get_existing_urls(html)
    print(f"Existing assets: {len(existing_urls)}")

    # Fetch sitemap and find new content URLs
    sitemap_urls = fetch_sitemap_urls()
    new_assets = []
    for url in sitemap_urls:
        asset_type, is_content = classify_url(url)
        if is_content and url not in existing_urls:
            new_assets.append((url, asset_type))

    if not new_assets:
        print("No new assets found.")
        return

    print(f"Found {len(new_assets)} new asset(s) to add.")

    client = anthropic.Anthropic(api_key=api_key)
    new_lines = []

    for url, asset_type in new_assets:
        title = slug_to_title(url)
        print(f"  Tagging: {title} ({asset_type})")
        try:
            tags = auto_tag(client, title, asset_type, url)
            line = build_asset_line(title, asset_type, url, tags)
            new_lines.append(line)
        except Exception as e:
            print(f"  Error tagging {url}: {e}")
            # Add with minimal tags so it's still in the repo
            line = build_asset_line(
                title, asset_type, url,
                {"dealStage": ["SQL", "Warm Opportunity"], "persona": [], "competitor": ["None / not sure"], "challenge": []}
            )
            new_lines.append(line)

    if not new_lines:
        print("No assets to insert.")
        return

    # Insert new lines before the closing ];
    # Find the last asset entry and the ]; (allow blank lines between)
    match = re.search(r"(  \{ title: [^\n]+)\s*\n\];", html)
    if not match:
        print("Could not find ASSETS array end in index.html")
        return

    insert_point = match.end(1)
    # Remove any trailing whitespace/newlines before ];, then rebuild
    end_bracket = html.index("];", insert_point)
    insert_text = ",\n" + ",\n".join(new_lines) + "\n"
    html = html[:insert_point] + insert_text + html[end_bracket:]

    with open(HTML_FILE, "w") as f:
        f.write(html)

    print(f"Inserted {len(new_lines)} new asset(s) into {HTML_FILE}.")


if __name__ == "__main__":
    main()
