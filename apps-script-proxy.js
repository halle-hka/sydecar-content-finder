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
    nonConvertSubreason: "",
    notes: deal.properties.description || ""
  };

  var assocContacts = (deal.associations && deal.associations.contacts &&
    deal.associations.contacts.results) || [];

  if (assocContacts.length > 0) {
    var contactId = assocContacts[0].id;
    var contact = hubspotFetch("/crm/v3/objects/contacts/" + contactId + "?properties=firstname,lastname,email,customer_segment,competitor,non_convert_subreason,lead_qualification_notes", {});
    result.segment = contact.properties.customer_segment || "";
    result.contactName = [(contact.properties.firstname || ""), (contact.properties.lastname || "")].join(" ").trim();
    result.contactEmail = contact.properties.email || "";
    result.competitor = contact.properties.competitor || "";
    result.nonConvertSubreason = contact.properties.non_convert_subreason || "";

    var lqNotes = contact.properties.lead_qualification_notes || "";
    if (lqNotes) {
      result.notes = (result.notes ? result.notes + "\n\n" : "") + lqNotes;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Action: Get contact context (segment + associated deal stage)
// ---------------------------------------------------------------------------
function getContactContext(contactId) {
  var contact = hubspotFetch("/crm/v3/objects/contacts/" + contactId + "?properties=firstname,lastname,email,customer_segment,company,competitor,non_convert_subreason,lead_qualification_notes&associations=deals", {});

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
    nonConvertSubreason: contact.properties.non_convert_subreason || "",
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
  }

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
