"""
Add a single sales enablement asset to the Content Finder.

Accepts ASSET_URL (required) and ASSET_TITLE (optional) from environment.
Resolves the final URL, derives the title, auto-tags with Claude, and
inserts into the ASSETS array in index.html.
"""

import re
import json
import os
import requests
import anthropic

HTML_FILE = "index.html"

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


def resolve_url(url):
    """Follow redirects to get the final URL."""
    url = url.strip()
    if not url.startswith("http"):
        url = "https://" + url
    try:
        resp = requests.head(url, allow_redirects=True, timeout=15)
        return resp.url
    except Exception:
        return url


def guess_type(url):
    """Guess asset type from URL pattern."""
    if "hubs.ly" in url or "hubspot" in url:
        return "enablement"
    if "/blog/" in url:
        return "blog"
    if "/learn/" in url:
        return "learn"
    if "/glossary/" in url:
        return "glossary"
    if "/guides/" in url:
        return "report"
    if "/webinars/" in url:
        return "webinar"
    if "releases.sydecar.io" in url:
        return "update"
    return "enablement"


def title_from_url(url):
    """Derive a readable title from a URL slug."""
    slug = url.rstrip("/").split("/")[-1]
    # Remove query params
    slug = slug.split("?")[0]
    slug = slug.replace("-", " ").replace("_", " ")
    words = slug.split()
    small_words = {"a", "an", "the", "and", "or", "of", "in", "on", "for", "to", "vs", "is", "at", "by", "with"}
    title_words = []
    for i, w in enumerate(words):
        if i == 0 or w.lower() not in small_words:
            title_words.append(w.capitalize())
        else:
            title_words.append(w.lower())
    return " ".join(title_words) if title_words else "Untitled Asset"


def try_fetch_title(url):
    """Try to extract <title> from the page HTML."""
    try:
        resp = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
        match = re.search(r"<title[^>]*>(.*?)</title>", resp.text, re.IGNORECASE | re.DOTALL)
        if match:
            title = match.group(1).strip()
            # Clean up common suffixes
            for suffix in [" | Sydecar", " - Sydecar", " | HubSpot", " - HubSpot"]:
                title = title.replace(suffix, "")
            if title and len(title) > 3:
                return title
    except Exception:
        pass
    return None


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
    asset_url = os.environ.get("ASSET_URL", "").strip()
    asset_title = os.environ.get("ASSET_TITLE", "").strip()

    if not api_key:
        print("ANTHROPIC_API_KEY not set.")
        return
    if not asset_url:
        print("ASSET_URL not set.")
        return

    # Read current HTML
    with open(HTML_FILE, "r") as f:
        html = f.read()

    # Resolve redirects (hubs.ly -> final URL)
    final_url = resolve_url(asset_url)
    print(f"Input URL: {asset_url}")
    print(f"Resolved URL: {final_url}")

    # Check for duplicates (check both input and resolved URL)
    existing = get_existing_urls(html)
    if asset_url in existing or final_url in existing:
        print("Asset already exists in the repository. Skipping.")
        return

    # Use the shorter URL for the asset (hubs.ly links are better for sharing)
    use_url = asset_url if "hubs.ly" in asset_url else final_url

    # Determine title
    if not asset_title:
        asset_title = try_fetch_title(final_url) or title_from_url(final_url)
    print(f"Title: {asset_title}")

    # Determine type
    asset_type = guess_type(use_url)
    print(f"Type: {asset_type}")

    # Auto-tag with Claude
    client = anthropic.Anthropic(api_key=api_key)
    print("Auto-tagging with Claude...")
    try:
        tags = auto_tag(client, asset_title, asset_type, use_url)
    except Exception as e:
        print(f"Error auto-tagging: {e}")
        tags = {
            "dealStage": ["SQL", "Warm Opportunity"],
            "persona": [],
            "competitor": ["None / not sure"],
            "challenge": [],
        }

    print(f"Tags: {json.dumps(tags, indent=2)}")

    # Build and insert
    new_line = build_asset_line(asset_title, asset_type, use_url, tags)

    match = re.search(r"(  \{ title: [^\n]+)\s*\n\];", html)
    if not match:
        print("Could not find ASSETS array end in index.html")
        return

    insert_point = match.end(1)
    end_bracket = html.index("];", insert_point)
    insert_text = ",\n" + new_line + "\n"
    html = html[:insert_point] + insert_text + html[end_bracket:]

    with open(HTML_FILE, "w") as f:
        f.write(html)

    print(f"Added: {asset_title}")


if __name__ == "__main__":
    main()
