/**
 * Cloudflare Worker — Proxy for Content Finder
 *
 * Replaces Google Apps Script. Auto-deploys from GitHub on every push.
 *
 * Environment variables (set as secrets in Cloudflare or GitHub):
 *   HUBSPOT_TOKEN  — HubSpot Private App token
 *   GITHUB_TOKEN   — GitHub PAT (repo scope)
 *   GITHUB_REPO    — e.g. halle-hka/sydecar-content-finder (set in wrangler.toml)
 */

// ---------------------------------------------------------------------------
// Deal stage label lookup
// ---------------------------------------------------------------------------
// HubSpot lifecycle stage values -> readable labels
const LIFECYCLE_LABELS = {
  "subscriber": "Subscriber",
  "lead": "Lead",
  "marketingqualifiedlead": "Marketing Qualified Lead",
  "salesqualifiedlead": "Sales Qualified Lead",
  "opportunity": "Opportunity",
  "customer": "Customer",
  "evangelist": "Evangelist",
  "other": "Other",
};

const STAGE_LABELS = {
  "17296960": "SQL",
  "102737501": "Lead",
  "103684772": "Lukewarm",
  "126914314": "Warm Relationship",
  "103684773": "Hot",
  "45448785": "50%",
  "45439091": "25%",
  "45439092": "50%",
  "45448786": "75%",
  "45448787": "90%",
  "45439093": "75%",
  "45439094": "90%",
  "104402864": "Onboarding",
  "closedwon": "Closed won",
  "closedlost": "Closed lost",
  "41708151": "NEXT FUND",
  "17296963": "CLOSED WON",
  "17296964": "CLOSED LOST",
  "17233781": "Keep Warm",
  "134374658": "Reached Out / Seeking Intro",
  "134374659": "NDA",
  "134374660": "In Dialogue",
  "101950501": "Term Sheet / Negotiating Terms",
  "101933157": "Agreement",
  "55623526": "Implementation",
  "45440513": "Client Success",
  "17233787": "Closed lost",
  "101994244": "Appointment Scheduled",
  "101994245": "Qualified To Buy",
  "101994246": "Presentation Scheduled",
  "101994247": "Decision Maker Bought-In",
  "101994248": "Contract Sent",
  "101994249": "Closed Won",
  "101994250": "Closed Lost",
  "987974538": "Appointment Scheduled",
  "987974539": "Qualified To Buy",
  "987974540": "Presentation Scheduled",
  "987974541": "Decision Maker Bought-In",
  "987974542": "Signed",
  "987974543": "Closed Won",
  "987974544": "Closed Lost",
  "988072561": "Appointment Scheduled",
  "988072562": "Qualified To Buy",
  "988072563": "Presentation Scheduled",
  "988072564": "Decision Maker Bought-In",
  "988072565": "Signed",
  "988072566": "Closed Won",
  "988072567": "Closed Lost",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

async function hubspotFetch(path, env, options = {}) {
  const token = env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN not configured");

  const url = "https://api.hubspot.com" + path;
  const resp = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: options.body || undefined,
  });
  return resp.json();
}

// ---------------------------------------------------------------------------
// Search deals
// ---------------------------------------------------------------------------
async function searchDeals(query, env) {
  const data = await hubspotFetch("/crm/v3/objects/deals/search", env, {
    method: "POST",
    body: JSON.stringify({
      query,
      limit: 8,
      properties: ["dealname", "dealstage", "amount", "pipeline"],
    }),
  });

  return (data.results || []).map((d) => ({
    id: d.id,
    type: "deal",
    name: d.properties.dealname || "Untitled Deal",
    dealStage: STAGE_LABELS[d.properties.dealstage] || d.properties.dealstage || "",
    amount: d.properties.amount || null,
  }));
}

// ---------------------------------------------------------------------------
// Search contacts
// ---------------------------------------------------------------------------
async function searchContacts(query, env) {
  const data = await hubspotFetch("/crm/v3/objects/contacts/search", env, {
    method: "POST",
    body: JSON.stringify({
      query,
      limit: 8,
      properties: ["firstname", "lastname", "email", "customer_segment", "company"],
    }),
  });

  return (data.results || []).map((c) => {
    const name = [(c.properties.firstname || ""), (c.properties.lastname || "")].join(" ").trim();
    return {
      id: c.id,
      type: "contact",
      name: name || c.properties.email || "Unknown",
      email: c.properties.email || "",
      company: c.properties.company || "",
      segment: c.properties.customer_segment || "",
    };
  });
}

// ---------------------------------------------------------------------------
// Fetch engagement notes, meetings, and calls for a contact
// ---------------------------------------------------------------------------
async function getEngagementNotes(contactId, env) {
  const allNotes = [];

  // Helper to fetch association IDs
  async function getAssocIds(objectType, limit) {
    try {
      const data = await hubspotFetch(
        `/crm/v4/objects/contacts/${contactId}/associations/${objectType}`, env
      );
      return (data.results || []).map((r) => r.toObjectId).slice(0, limit);
    } catch { return []; }
  }

  // Fetch notes
  const noteIds = await getAssocIds("notes", 10);
  for (const id of noteIds) {
    try {
      const note = await hubspotFetch(`/crm/v3/objects/notes/${id}?properties=hs_note_body,hs_timestamp`, env);
      let body = (note.properties.hs_note_body || "")
        .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      if (body) allNotes.push({ type: "note", date: note.properties.hs_timestamp || "", body });
    } catch {}
  }

  // Fetch meetings
  const meetingIds = await getAssocIds("meetings", 10);
  for (const id of meetingIds) {
    try {
      const meeting = await hubspotFetch(
        `/crm/v3/objects/meetings/${id}?properties=hs_meeting_title,hs_meeting_body,hs_meeting_start_time,hs_internal_meeting_notes`, env
      );
      let mBody = ((meeting.properties.hs_meeting_body || "") + " " + (meeting.properties.hs_internal_meeting_notes || ""))
        .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      const mTitle = meeting.properties.hs_meeting_title || "";
      if (mBody || mTitle) allNotes.push({ type: "meeting", date: meeting.properties.hs_meeting_start_time || "", title: mTitle, body: mBody });
    } catch {}
  }

  // Fetch calls
  const callIds = await getAssocIds("calls", 5);
  for (const id of callIds) {
    try {
      const call = await hubspotFetch(`/crm/v3/objects/calls/${id}?properties=hs_call_title,hs_call_body,hs_timestamp`, env);
      let cBody = (call.properties.hs_call_body || "")
        .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      if (cBody) allNotes.push({ type: "call", date: call.properties.hs_timestamp || "", body: cBody });
    } catch {}
  }

  // Sort by date descending, cap at 3000 chars
  allNotes.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  let combined = "";
  for (const n of allNotes) {
    const entry = `[${n.type.toUpperCase()}${n.date ? " " + n.date.substring(0, 10) : ""}] ${n.title ? n.title + ": " : ""}${n.body}\n\n`;
    if (combined.length + entry.length > 3000) break;
    combined += entry;
  }
  return combined.trim();
}

// ---------------------------------------------------------------------------
// Get deal context
// ---------------------------------------------------------------------------
async function getDealContext(dealId, env) {
  const deal = await hubspotFetch(
    `/crm/v3/objects/deals/${dealId}?properties=dealname,dealstage,amount,pipeline,description&associations=contacts`, env
  );

  const result = {
    dealId,
    dealName: deal.properties.dealname || "",
    dealStage: STAGE_LABELS[deal.properties.dealstage] || deal.properties.dealstage || "",
    segment: "",
    contactName: "",
    contactEmail: "",
    competitor: "",
    meetingNotes: "",
    notes: deal.properties.description || "",
  };

  const assocContacts = deal.associations?.contacts?.results || [];
  if (assocContacts.length > 0) {
    const contactId = assocContacts[0].id;
    const contact = await hubspotFetch(
      `/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,email,customer_segment,competitor,lead_qualification_notes,lifecyclestage`, env
    );
    result.segment = contact.properties.customer_segment || "";
    result.contactName = [(contact.properties.firstname || ""), (contact.properties.lastname || "")].join(" ").trim();
    result.contactEmail = contact.properties.email || "";
    result.competitor = contact.properties.competitor || "";

    // Use contact lifecycle stage instead of deal stage
    const lcs = (contact.properties.lifecyclestage || "").toLowerCase();
    if (lcs) result.dealStage = LIFECYCLE_LABELS[lcs] || lcs;

    const lqNotes = contact.properties.lead_qualification_notes || "";
    if (lqNotes) result.notes = (result.notes ? result.notes + "\n\n" : "") + lqNotes;

    result.meetingNotes = await getEngagementNotes(contactId, env);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Get contact context
// ---------------------------------------------------------------------------
async function getContactContext(contactId, env) {
  const contact = await hubspotFetch(
    `/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,email,customer_segment,company,competitor,lead_qualification_notes,lifecyclestage&associations=deals`, env
  );

  const name = [(contact.properties.firstname || ""), (contact.properties.lastname || "")].join(" ").trim();

  // Always use lifecycle stage
  const lcs = (contact.properties.lifecyclestage || "").toLowerCase();
  const lifecycleLabel = lcs ? (LIFECYCLE_LABELS[lcs] || lcs) : "";

  const result = {
    contactId,
    contactName: name,
    contactEmail: contact.properties.email || "",
    company: contact.properties.company || "",
    segment: contact.properties.customer_segment || "",
    dealStage: lifecycleLabel,
    dealName: "",
    competitor: contact.properties.competitor || "",
    meetingNotes: "",
    notes: contact.properties.lead_qualification_notes || "",
  };

  // Still fetch deal for notes/context, but not for stage
  const assocDeals = contact.associations?.deals?.results || [];
  if (assocDeals.length > 0) {
    const dealId = assocDeals[0].id;
    const deal = await hubspotFetch(`/crm/v3/objects/deals/${dealId}?properties=dealname,description`, env);
    result.dealName = deal.properties.dealname || "";
    const dealDesc = deal.properties.description || "";
    if (dealDesc) result.notes = (result.notes ? result.notes + "\n\n" : "") + dealDesc;
  }

  result.meetingNotes = await getEngagementNotes(contactId, env);

  return result;
}

// ---------------------------------------------------------------------------
// Create Asana task for content request
// ---------------------------------------------------------------------------
async function sendContentRequest(payload, env) {
  const token = env.ASANA_TOKEN;
  if (!token) throw new Error("ASANA_TOKEN not configured");

  const projectId = "1206803464730868";

  const lines = [];
  if (payload.contentType) lines.push(`Format: ${payload.contentType}`);
  if (payload.dealStage) lines.push(`Deal Stage: ${payload.dealStage}`);
  if (payload.persona) lines.push(`Persona: ${payload.persona}`);
  if (payload.challenges) lines.push(`Challenges: ${payload.challenges}`);
  if (payload.prospectName) lines.push(`Prospect: ${payload.prospectName}`);
  if (payload.gap) lines.push(`\nWhy it's needed:\n${payload.gap}`);

  const notes = lines.join("\n");

  const resp = await fetch("https://app.asana.com/api/1.0/tasks", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        name: payload.topic,
        notes,
        projects: [projectId],
      },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Asana API returned ${resp.status}: ${err}`);
  }

  const result = await resp.json();
  return result.data?.gid ? true : false;
}

// ---------------------------------------------------------------------------
// Trigger GitHub Actions workflow (add-asset)
// ---------------------------------------------------------------------------
async function triggerAddAsset(url, title, env) {
  const token = env.GH_PAT;
  const repo = env.GITHUB_REPO || "halle-hka/sydecar-content-finder";
  if (!token) throw new Error("GITHUB_TOKEN not configured");

  const resp = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/add-asset.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "content-finder-worker",
      },
      body: JSON.stringify({ ref: "main", inputs: { url, title: title || "" } }),
    }
  );
  return resp.status === 204;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method === "GET") {
      return jsonResp({ status: "ok", message: "POST with action: search | get_deal | get_contact | add_asset" });
    }

    if (request.method !== "POST") {
      return jsonResp({ error: "Method not allowed" }, 405);
    }

    try {
      const payload = await request.json();
      const action = payload.action || "add_asset";

      switch (action) {
        case "search": {
          const query = payload.query || "";
          if (!query) return jsonResp({ error: "query is required" });
          const [deals, contacts] = await Promise.all([
            searchDeals(query, env),
            searchContacts(query, env),
          ]);
          return jsonResp({ deals, contacts });
        }

        case "get_deal": {
          if (!payload.dealId) return jsonResp({ error: "dealId is required" });
          return jsonResp(await getDealContext(payload.dealId, env));
        }

        case "get_contact": {
          if (!payload.contactId) return jsonResp({ error: "contactId is required" });
          return jsonResp(await getContactContext(payload.contactId, env));
        }

        case "add_asset": {
          const url = payload.url || "";
          if (!url) return jsonResp({ error: "url is required" });
          const ok = await triggerAddAsset(url, payload.title, env);
          return jsonResp(ok ? { success: true } : { error: "GitHub API failed" });
        }

        case "content_request": {
          if (!payload.topic) return jsonResp({ error: "topic is required" });
          const ok = await sendContentRequest(payload, env);
          return jsonResp(ok ? { success: true } : { error: "Failed to send to Slack" });
        }

        default:
          return jsonResp({ error: "Unknown action: " + action });
      }
    } catch (err) {
      return jsonResp({ error: err.message || String(err) }, 500);
    }
  },
};
