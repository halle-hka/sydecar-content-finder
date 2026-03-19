/**
 * ============================================================================
 * Google Apps Script — Proxy for Content Finder
 * ============================================================================
 *
 * Handles two things:
 *   1. HubSpot deal/contact lookups (so the Private App token stays server-side)
 *   2. Triggering the GitHub Actions "add-asset" workflow
 *
 * SETUP INSTRUCTIONS:
 *
 * 1. Go to https://script.google.com and create a new project
 * 2. Paste this entire file into the editor (replace any existing code)
 * 3. Add your secrets via Project Settings > Script Properties:
 *    - GITHUB_TOKEN  = your GitHub Personal Access Token (repo scope)
 *    - GITHUB_REPO   = halle-hka/sydecar-content-finder
 *    - HUBSPOT_TOKEN = your HubSpot Private App token (crm.objects.contacts.read,
 *                      crm.objects.deals.read scopes)
 * 4. Deploy > New deployment > Web app > Execute as "Me" > Anyone > Deploy
 * 5. Copy the URL and set it as APPS_SCRIPT_URL in index.html
 *
 * IMPORTANT: After updating this code, you must create a NEW deployment
 * (Deploy > Manage deployments > pencil icon > Version: New version > Deploy)
 * for changes to take effect.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function hubspotFetch(path, options) {
  var token = PropertiesService.getScriptProperties().getProperty("HUBSPOT_TOKEN");
  if (!token) throw new Error("HUBSPOT_TOKEN not configured in Script Properties");

  var defaults = {
    method: "get",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    },
    muteHttpExceptions: true
  };

  for (var k in options) defaults[k] = options[k];
  if (options && options.headers) {
    defaults.headers["Authorization"] = "Bearer " + token;
    defaults.headers["Content-Type"] = "application/json";
  }

  var resp = UrlFetchApp.fetch("https://api.hubspot.com" + path, defaults);
  return JSON.parse(resp.getContentText());
}

// ---------------------------------------------------------------------------
// Deal stage label lookup: HubSpot internal IDs -> display labels
// ---------------------------------------------------------------------------
var STAGE_LABELS = {
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
// Action: Search deals by name
// ---------------------------------------------------------------------------
function searchDeals(query) {
  var data = hubspotFetch("/crm/v3/objects/deals/search", {
    method: "post",
    payload: JSON.stringify({
      query: query,
      limit: 8,
      properties: ["dealname", "dealstage", "amount", "pipeline"]
    })
  });

  var results = (data.results || []).map(function(d) {
    var stageLabel = STAGE_LABELS[d.properties.dealstage] || d.properties.dealstage || "";
    return {
      id: d.id,
      type: "deal",
      name: d.properties.dealname || "Untitled Deal",
      dealStage: stageLabel,
      amount: d.properties.amount || null
    };
  });

  return results;
}

// ---------------------------------------------------------------------------
// Action: Search contacts by name or email
// ---------------------------------------------------------------------------
function searchContacts(query) {
  var data = hubspotFetch("/crm/v3/objects/contacts/search", {
    method: "post",
    payload: JSON.stringify({
      query: query,
      limit: 8,
      properties: ["firstname", "lastname", "email", "customer_segment", "company"]
    })
  });

  var results = (data.results || []).map(function(c) {
    var seg = c.properties.customer_segment || "";
    var name = [(c.properties.firstname || ""), (c.properties.lastname || "")].join(" ").trim();
    return {
      id: c.id,
      type: "contact",
      name: name || c.properties.email || "Unknown",
      email: c.properties.email || "",
      company: c.properties.company || "",
      segment: seg
    };
  });

  return results;
}

// ---------------------------------------------------------------------------
// Fetch engagement notes, meetings, and calls for a contact
// ---------------------------------------------------------------------------
function getEngagementNotes(contactId) {
  var allNotes = [];

  // Fetch notes
  try {
    var notesAssoc = hubspotFetch("/crm/v4/objects/contacts/" + contactId + "/associations/notes", {});
    var noteIds = (notesAssoc.results || []).map(function(r) { return r.toObjectId; }).slice(0, 10);
    for (var i = 0; i < noteIds.length; i++) {
      try {
        var note = hubspotFetch("/crm/v3/objects/notes/" + noteIds[i] + "?properties=hs_note_body,hs_timestamp", {});
        var body = note.properties.hs_note_body || "";
        // Strip HTML tags
        body = body.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
        if (body) allNotes.push({ type: "note", date: note.properties.hs_timestamp || "", body: body });
      } catch(e) {}
    }
  } catch(e) {}

  // Fetch meetings
  try {
    var meetingsAssoc = hubspotFetch("/crm/v4/objects/contacts/" + contactId + "/associations/meetings", {});
    var meetingIds = (meetingsAssoc.results || []).map(function(r) { return r.toObjectId; }).slice(0, 10);
    for (var j = 0; j < meetingIds.length; j++) {
      try {
        var meeting = hubspotFetch("/crm/v3/objects/meetings/" + meetingIds[j] + "?properties=hs_meeting_title,hs_meeting_body,hs_meeting_start_time,hs_internal_meeting_notes", {});
        var mBody = (meeting.properties.hs_meeting_body || "") + " " + (meeting.properties.hs_internal_meeting_notes || "");
        mBody = mBody.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
        var mTitle = meeting.properties.hs_meeting_title || "";
        if (mBody || mTitle) allNotes.push({ type: "meeting", date: meeting.properties.hs_meeting_start_time || "", title: mTitle, body: mBody });
      } catch(e) {}
    }
  } catch(e) {}

  // Fetch calls
  try {
    var callsAssoc = hubspotFetch("/crm/v4/objects/contacts/" + contactId + "/associations/calls", {});
    var callIds = (callsAssoc.results || []).map(function(r) { return r.toObjectId; }).slice(0, 5);
    for (var k = 0; k < callIds.length; k++) {
      try {
        var call = hubspotFetch("/crm/v3/objects/calls/" + callIds[k] + "?properties=hs_call_title,hs_call_body,hs_timestamp", {});
        var cBody = (call.properties.hs_call_body || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
        if (cBody) allNotes.push({ type: "call", date: call.properties.hs_timestamp || "", body: cBody });
      } catch(e) {}
    }
  } catch(e) {}

  // Sort by date descending
  allNotes.sort(function(a, b) { return (b.date || "").localeCompare(a.date || ""); });

  // Concatenate into a single text, capped at ~3000 chars to keep response fast
  var combined = "";
  for (var m = 0; m < allNotes.length; m++) {
    var entry = "[" + allNotes[m].type.toUpperCase() + (allNotes[m].date ? " " + allNotes[m].date.substring(0, 10) : "") + "] " +
      (allNotes[m].title ? allNotes[m].title + ": " : "") + allNotes[m].body + "\n\n";
    if (combined.length + entry.length > 3000) break;
    combined += entry;
  }

  return combined.trim();
}

// ---------------------------------------------------------------------------
// Action: Get full context for a deal (deal stage + associated contact segment)
// ---------------------------------------------------------------------------
function getDealContext(dealId) {
  var deal = hubspotFetch("/crm/v3/objects/deals/" + dealId + "?properties=dealname,dealstage,amount,pipeline,description&associations=contacts", {});

  var stageLabel = STAGE_LABELS[deal.properties.dealstage] || deal.properties.dealstage || "";
  var result = {
    dealId: dealId,
    dealName: deal.properties.dealname || "",
    dealStage: stageLabel,
    segment: "",
    contactName: "",
    contactEmail: "",
    competitor: "",
    meetingNotes: "",
    notes: deal.properties.description || ""
  };

  var assocContacts = (deal.associations && deal.associations.contacts &&
    deal.associations.contacts.results) || [];

  if (assocContacts.length > 0) {
    var contactId = assocContacts[0].id;
    var contact = hubspotFetch("/crm/v3/objects/contacts/" + contactId + "?properties=firstname,lastname,email,customer_segment,competitor,lead_qualification_notes", {});
    result.segment = contact.properties.customer_segment || "";
    result.contactName = [(contact.properties.firstname || ""), (contact.properties.lastname || "")].join(" ").trim();
    result.contactEmail = contact.properties.email || "";
    result.competitor = contact.properties.competitor || "";

    var lqNotes = contact.properties.lead_qualification_notes || "";
    if (lqNotes) {
      result.notes = (result.notes ? result.notes + "\n\n" : "") + lqNotes;
    }

    // Fetch engagement notes for this contact
    result.meetingNotes = getEngagementNotes(contactId);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Action: Get contact context (segment + associated deal stage)
// ---------------------------------------------------------------------------
function getContactContext(contactId) {
  var contact = hubspotFetch("/crm/v3/objects/contacts/" + contactId + "?properties=firstname,lastname,email,customer_segment,company,competitor,lead_qualification_notes,lifecyclestage&associations=deals", {});

  var name = [(contact.properties.firstname || ""), (contact.properties.lastname || "")].join(" ").trim();

  var result = {
    contactId: contactId,
    contactName: name,
    contactEmail: contact.properties.email || "",
    company: contact.properties.company || "",
    segment: contact.properties.customer_segment || "",
    dealStage: "",
    dealName: "",
    competitor: contact.properties.competitor || "",
    meetingNotes: "",
    notes: contact.properties.lead_qualification_notes || ""
  };

  var assocDeals = (contact.associations && contact.associations.deals &&
    contact.associations.deals.results) || [];

  if (assocDeals.length > 0) {
    var dealId = assocDeals[0].id;
    var deal = hubspotFetch("/crm/v3/objects/deals/" + dealId + "?properties=dealname,dealstage,description", {});
    result.dealStage = STAGE_LABELS[deal.properties.dealstage] || deal.properties.dealstage || "";
    result.dealName = deal.properties.dealname || "";
    var dealDesc = deal.properties.description || "";
    if (dealDesc) {
      result.notes = (result.notes ? result.notes + "\n\n" : "") + dealDesc;
    }
  } else {
    // No deal — fall back to lifecycle stage
    var lcs = contact.properties.lifecyclestage || "";
    if (lcs) {
      result.dealStage = lcs.charAt(0).toUpperCase() + lcs.slice(1).toLowerCase();
    }
  }

  // Fetch engagement notes for this contact
  result.meetingNotes = getEngagementNotes(contactId);

  return result;
}

// ---------------------------------------------------------------------------
// Action: Trigger GitHub Actions workflow (add-asset)
// ---------------------------------------------------------------------------
function triggerAddAsset(url, title) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty("GITHUB_TOKEN");
  var repo = props.getProperty("GITHUB_REPO") || "halle-hka/sydecar-content-finder";

  if (!token) throw new Error("GITHUB_TOKEN not configured");

  var githubUrl = "https://api.github.com/repos/" + repo + "/actions/workflows/add-asset.yml/dispatches";

  var response = UrlFetchApp.fetch(githubUrl, {
    method: "post",
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github.v3+json",
      "Content-Type": "application/json"
    },
    payload: JSON.stringify({
      ref: "main",
      inputs: { url: url, title: title || "" }
    }),
    muteHttpExceptions: true
  });

  return response.getResponseCode() === 204;
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------
function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var action = payload.action || "add_asset";

    switch (action) {
      case "search":
        var query = payload.query || "";
        if (!query) return jsonResponse({ error: "query is required" });
        var deals = searchDeals(query);
        var contacts = searchContacts(query);
        return jsonResponse({ deals: deals, contacts: contacts });

      case "get_deal":
        var dealId = payload.dealId;
        if (!dealId) return jsonResponse({ error: "dealId is required" });
        return jsonResponse(getDealContext(dealId));

      case "get_contact":
        var contactId = payload.contactId;
        if (!contactId) return jsonResponse({ error: "contactId is required" });
        return jsonResponse(getContactContext(contactId));

      case "add_asset":
        var url = payload.url || "";
        if (!url) return jsonResponse({ error: "url is required" });
        var ok = triggerAddAsset(url, payload.title);
        return jsonResponse(ok ? { success: true } : { error: "GitHub API failed" });

      default:
        return jsonResponse({ error: "Unknown action: " + action });
    }
  } catch (err) {
    return jsonResponse({ error: err.message || String(err) });
  }
}

function doGet(e) {
  return jsonResponse({ status: "ok", message: "POST with action: search | get_deal | get_contact | add_asset" });
}
