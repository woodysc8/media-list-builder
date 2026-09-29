import { buildMediaListRows, buildReporterCoverageIndex, filterReporters, formatReporterSearchSummary, MEDIA_LIST_HEADERS, qualificationDiagnostics, sanitizeMediaList, uniqueMasterReporters } from "/reporter-filter.js";
import { addAllowedSelection, availableSelections, CANONICAL_REPORTER_TYPES, removeSelection } from "/filter-selection.js";

const nativeFetch = window.fetch.bind(window);
let appLoginPromise = null;
let appLoginDismissed = false;
window.fetch = async (input, init) => {
  const response = await nativeFetch(input, init);
  if (response.status !== 401 || response.headers.get("x-app-auth-required") !== "1") return response;
  if (appLoginDismissed) return response;
  if (!appLoginPromise) {
    appLoginPromise = (async () => {
      const password = window.prompt("Enter the Media List Builder access password");
      if (!password) {
        appLoginDismissed = true;
        return false;
      }
      const login = await nativeFetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password })
      });
      if (!login.ok) {
        appLoginDismissed = true;
        window.alert("The application password was not accepted. Reload the page to try again.");
        return false;
      }
      return true;
    })().finally(() => { appLoginPromise = null; });
  }
  return await appLoginPromise ? nativeFetch(input, init) : response;
};

const status = document.querySelector("#status");
const results = document.querySelector("#results");

const fileInput = document.querySelector("#file");
const fileLabel = document.querySelector("#file-label");
const ingestForm = document.querySelector("#ingest-form");
const ingestButton = document.querySelector("#ingest-button");
const ingestStatus = document.querySelector("#ingest-status");

let enrichmentProposals = [];
let reportData = null;
let activeReportTab = "Coverage";
let reportClient = new URLSearchParams(window.location.search).get("client") || "";
let directoryReporters = [];
let filteredReporters = [];
let mediaList = [];
let coverageHistory = [];
let reporterSourceDiagnostics = null;
let selectedTopics = [];
let selectedSimilarClients = [];
let selectedPoolIds = new Set();
let selectedMediaIds = new Set();
let activeFilters = {};
let manualReporterByLabel = new Map();
let canonicalBeatOptions = [];
let similarClientOptions = [];
let selectedReporterTypes = [];

function selectionConfig(kind) {
  if (kind === "topic") return { values: selectedTopics, set: (values) => { selectedTopics = values; }, options: canonicalBeatOptions, select: "#topic-select", chips: "#topic-selected-chips", placeholder: "Select topic", label: (value) => value };
  if (kind === "similarClient") return { values: selectedSimilarClients, set: (values) => { selectedSimilarClients = values; }, options: similarClientOptions, select: "#similar-client-select", chips: "#similar-client-selected-chips", placeholder: "Select similar client", label: (value) => value };
  return { values: selectedReporterTypes, set: (values) => { selectedReporterTypes = values; }, options: CANONICAL_REPORTER_TYPES.map((type) => type.value), select: "#reporter-type-select", chips: "#reporter-type-selected-chips", placeholder: "Select reporter type", label: (value) => CANONICAL_REPORTER_TYPES.find((type) => type.value === value)?.label ?? value };
}

function renderSelectionBuilder(kind) {
  const config = selectionConfig(kind);
  document.querySelector(config.chips).innerHTML = config.values.map((value) => `<span class="filter-chip">${escapeHtml(config.label(value))}<button type="button" data-remove-selection="${kind}" data-selection-value="${escapeAttribute(value)}" aria-label="Remove ${escapeAttribute(config.label(value))}">×</button></span>`).join("");
  const available = availableSelections(config.options, config.values);
  document.querySelector(config.select).innerHTML = `<option value="">${escapeHtml(config.placeholder)}${available.length ? " ▾" : ""}</option>${available.map((value) => `<option value="${escapeAttribute(value)}">${escapeHtml(config.label(value))}</option>`).join("")}`;
  document.querySelector(config.select).disabled = available.length === 0;
}

function personName(person) { return `${person.firstName || ""} ${person.lastName || ""}`.trim(); }
function escapeAttribute(value) { return escapeHtml(value); }
function normalizedType(value) {
  return String(value ?? "").toLocaleLowerCase().trim().replace(/\s+/g, " ");
}
function compactReporterType(value) {
  const types = { reporter: "Reporter", influencer: "Influencer", podcast: "Podcast", "broadcast tv": "Broadcast TV", "tier 1 media": "Tier 1 Media" };
  const key = normalizedType(value);
  return types[key] || String(value || "—");
}
function evidenceLabel(reason) {
  const value = String(reason ?? "");
  if (/^Insurance: Master Directory Beats|^Insurance: Beats/i.test(value)) return "INSURANCE: BEATS";
  if (/^Insurance: historical coverage/i.test(value)) return "INSURANCE: COVERAGE";
  if (/^Insurance: Outlet evidence/i.test(value)) return "INSURANCE OUTLET";
  const similar = value.match(/^Similar client:\s*([^(:]+)/i);
  if (similar) return `SIMILAR CLIENT: ${similar[1].trim().toLocaleUpperCase()}`;
  const pitch = value.match(/^Pitch client:\s*([^(:]+)/i);
  if (pitch) return `PITCH CLIENT: ${pitch[1].trim().toLocaleUpperCase()}`;
  return value.toLocaleUpperCase();
}
function renderPool() {
  document.querySelector("#pool-count").textContent = `${filteredReporters.length} relevant reporters`;
  document.querySelector("#search-summary").textContent = formatReporterSearchSummary(directoryReporters.length, activeFilters, filteredReporters.length);
  const headers = ["Select", "Outlet", "Reporter", "Reporter Type", "Email", "Clients Covered", "Beats", "Most Recent Article"];
  const rows = filteredReporters.map((person) => {
    const reasons = person.whyRelevant || [];
    const topics = reasons.filter((reason) => !reason.startsWith("Similar client:") && !reason.startsWith("No relevance"));
    const similar = reasons.filter((reason) => reason.startsWith("Similar client:"));
    const recent = reasons.filter((reason) => reason.includes("historical coverage"));
    const recentEvidence = [person.mostRecentArticle, ...recent].filter(Boolean).join("; ");
    const evidenceLabels = reasons.map((reason) => `<span class="evidence-label">${escapeHtml(evidenceLabel(reason))}</span>`).join("");
    return `<tr><td><input type="checkbox" data-pool-select="${escapeAttribute(person.id)}" aria-label="Select ${escapeAttribute(personName(person))}" ${selectedPoolIds.has(person.id) ? "checked" : ""}></td><td>${escapeHtml(person.outlet)}</td><td><div class="reporter-result"><details class="evidence-detail"><summary>${escapeHtml(personName(person)) || "Unknown reporter"}</summary><div class="evidence-content"><strong>Why Relevant</strong><ul>${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("") || "<li>Matches current filters</li>"}</ul><strong>Topic evidence</strong><p>${escapeHtml(topics.join("; ") || "—")}</p><strong>Similar-client evidence</strong><p>${escapeHtml(similar.join("; ") || "—")}</p><strong>Beats</strong><p>${escapeHtml(person.beats || "—")}</p><strong>Notes</strong><p>${escapeHtml(person.notes || "—")}</p><strong>Recent historical coverage</strong><p>${escapeHtml(recentEvidence || "—")}</p></div></details><div class="evidence-labels" aria-label="Qualification evidence">${evidenceLabels}</div></div></td><td>${escapeHtml(compactReporterType(person.reporterType))}</td><td>${escapeHtml(person.email)}</td><td>${escapeHtml(person.clientsCovered)}</td><td>${escapeHtml(person.beats)}</td><td>${escapeHtml(person.mostRecentArticle)}</td></tr>`;
  }).join("");
  document.querySelector("#reporter-pool").innerHTML = rows ? `<table class="dense-table reporter-table"><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>` : `<p class="empty-state">No reporters match these filters.</p>`;
  renderMediaList();
}
function renderMediaList() {
  mediaList = sanitizeMediaList(mediaList, directoryReporters);
  selectedMediaIds = new Set([...selectedMediaIds].filter((id) => mediaList.some((person) => String(person.id) === id)));
  document.querySelector("#media-list-count").textContent = `${mediaList.length} reporters`;
  const fields = ["ownerDatePitched", "outlet", "firstName", "lastName", "email", "reporterType", "clientsCovered", "profile", "notes"];
  const headers = ["Select", "Owner/Date Pitched", "Outlet", "Reporter First Name", "Reporter Last Name", "Email", "Reporter Type", "Clients Covered", "Profile", "Notes", "Action"];
  const rows = mediaList.map((person) => `<tr><td><input type="checkbox" data-media-select="${escapeAttribute(person.id)}" aria-label="Select ${escapeAttribute(personName(person))}" ${selectedMediaIds.has(String(person.id)) ? "checked" : ""}></td>${fields.map((field) => `<td>${["profile", "notes"].includes(field) ? `<textarea data-media-id="${escapeAttribute(person.id)}" data-media-field="${field}" aria-label="${field}" ${field === "notes" ? "readonly" : ""}>${escapeHtml(person[field] ?? "")}</textarea>` : `<input data-media-id="${escapeAttribute(person.id)}" data-media-field="${field}" aria-label="${field}" value="${escapeAttribute(person[field] ?? "")}" ${["outlet", "firstName", "lastName", "email", "reporterType", "clientsCovered"].includes(field) ? "readonly" : ""}>`}</td>`).join("")}<td><button type="button" data-remove-media="${escapeAttribute(person.id)}">Remove</button></td></tr>`).join("");
  document.querySelector("#media-list").innerHTML = rows ? `<table class="dense-table editable-table media-table"><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>` : `<p class="empty-state">Add reporters from the filtered pool to start your media list.</p>`;
}
function buildProfile(person) {
  return person.profile || person.whyRelevant?.[0] || (person.beats ? `Covers ${person.beats}` : person.mostRecentArticle || "");
}
async function loadReporterDirectory() {
  let reporterSourceLoaded = false;
  try {
    const directory = await readResponse(await fetch("/api/reference-data", { cache: "no-store" }));
    const rawReporterRows = directory.reporters || [];
    reporterSourceDiagnostics = directory.reporterSource || null;
    directoryReporters = uniqueMasterReporters(rawReporterRows);
    reporterSourceLoaded = true;
    const source = reporterSourceDiagnostics;
    const sourceSummary = document.querySelector("#reporter-source-summary");
    sourceSummary.classList.add("source-diagnostics");
    sourceSummary.innerHTML = source
      ? `<div class="source-title"><div><span class="source-eyebrow">Master Directory</span><strong>${escapeHtml(source.kind === "google" ? "Google · Master Directory (Cleaned)" : "Local fallback")}</strong></div><span class="source-authority ${source.authoritative ? "is-authoritative" : "is-fallback"}">${source.authoritative ? "Authoritative" : "Non-authoritative"}</span></div><div class="source-counts"><div><span>Raw rows</span><strong>${Number(source.rawReporterRowCount) || 0}</strong></div><div><span>Valid</span><strong>${Number(source.validReporterCount) || 0}</strong></div><div><span>Unique</span><strong>${Number(source.uniqueValidReporterCount) || 0}</strong></div></div>`
      : "Reporter source metadata unavailable";
    const history = await readResponse(await fetch("/api/coverage-data", { cache: "no-store" }));
    coverageHistory = history.coverage || [];
    const { diagnostics } = buildReporterCoverageIndex(directory.reporters || [], coverageHistory);
    console.info("[Media List Builder] Reporter identity pipeline", { ...diagnostics, reporterSource: source, filteredReporters: directoryReporters.length });
    filteredReporters = filterReporters(directoryReporters, {}, coverageHistory).sort((a, b) => String(a.outlet).localeCompare(String(b.outlet)) || personName(a).localeCompare(personName(b)));
    renderPool();
  } catch (error) {
    document.querySelector("#pool-count").textContent = error.message || "Reporter directory unavailable";
    document.querySelector("#reporter-source-summary").textContent = reporterSourceLoaded
      ? "Reporter directory source loaded; Coverage history could not be loaded."
      : "Unable to load the authoritative reporter source; no fallback was used.";
  }
}
document.querySelector("#pitch-filter-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const filters = {
    topics: selectedTopics,
    similarClients: selectedSimilarClients,
    client: document.querySelector('#pitch-filter-form [name="client"]').value.trim(),
    reporterTypes: [...selectedReporterTypes],
    status: String(formData.get("status") || "all")
  };
  activeFilters = filters;
  selectedPoolIds.clear();
  filteredReporters = filterReporters(directoryReporters, filters, coverageHistory).sort((a, b) => String(a.outlet).localeCompare(String(b.outlet)) || personName(a).localeCompare(personName(b)));
  const pipeline = buildReporterCoverageIndex(directoryReporters, coverageHistory).diagnostics;
  const qualification = qualificationDiagnostics(filteredReporters);
  console.info("[Media List Builder] Reporter filter results", { ...pipeline, qualification, activeFilters: { topics: filters.topics, similarClients: filters.similarClients, reporterTypes: filters.reporterTypes, status: filters.status }, filteredReporters: filteredReporters.length });
  renderPool();
});
document.querySelector("#pitch-filter-form").addEventListener("change", (event) => {
  const select = event.target.closest("#topic-select, #similar-client-select, #reporter-type-select");
  if (!select || !select.value) return;
  const kind = select.id === "topic-select" ? "topic" : select.id === "similar-client-select" ? "similarClient" : "reporterType";
  const config = selectionConfig(kind);
  config.set(addAllowedSelection(config.options, config.values, select.value));
  renderSelectionBuilder(kind);
});
document.querySelector("#pitch-filter-form").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-selection]");
  if (!button) return;
  const config = selectionConfig(button.dataset.removeSelection);
  config.set(removeSelection(config.values, button.dataset.selectionValue));
  renderSelectionBuilder(button.dataset.removeSelection);
});
document.querySelector("#reporter-pool").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-pool-select]");
  if (!checkbox) return;
  if (checkbox.checked) selectedPoolIds.add(checkbox.dataset.poolSelect); else selectedPoolIds.delete(checkbox.dataset.poolSelect);
});
document.querySelector("#select-all-pool").addEventListener("click", () => { selectedPoolIds = new Set(filteredReporters.map((person) => person.id)); renderPool(); });
document.querySelector("#deselect-all-pool").addEventListener("click", () => { selectedPoolIds.clear(); renderPool(); });
document.querySelector("#add-selected-pool").addEventListener("click", () => {
  mediaList = sanitizeMediaList(mediaList, directoryReporters);
  const existing = new Set(mediaList.map((person) => String(person.id)));
  const masters = new Map(directoryReporters.map((person) => [String(person.id), person]));
  for (const person of filteredReporters) {
    const id = String(person.id);
    const master = masters.get(id);
    if (selectedPoolIds.has(id) && master && !existing.has(id)) {
      mediaList.push({ ...master, reporterType: compactReporterType(master.reporterType), ownerDatePitched: "", profile: buildProfile(person) });
      existing.add(id);
    }
  }
  selectedPoolIds.clear();
  renderPool();
});
document.querySelector("#media-list").addEventListener("input", (event) => {
  const input = event.target.closest("[data-media-id]");
  const person = mediaList.find((item) => item.id === input?.dataset.mediaId);
  if (person && input) person[input.dataset.mediaField] = input.value;
});
document.querySelector("#media-list").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-media-select]");
  if (!checkbox) return;
  const id = String(checkbox.dataset.mediaSelect);
  if (checkbox.checked) selectedMediaIds.add(id); else selectedMediaIds.delete(id);
});
document.querySelector("#media-list").addEventListener("click", (event) => {
  const remove = event.target.closest("[data-remove-media]");
  if (remove) { mediaList = mediaList.filter((person) => String(person.id) !== remove.dataset.removeMedia); selectedMediaIds.delete(remove.dataset.removeMedia); renderMediaList(); }
});
document.querySelector("#remove-selected-media").addEventListener("click", () => {
  mediaList = mediaList.filter((person) => !selectedMediaIds.has(String(person.id)));
  selectedMediaIds.clear();
  renderMediaList();
});
document.querySelector("#clear-media-list").addEventListener("click", () => {
  mediaList = [];
  selectedMediaIds.clear();
  renderMediaList();
});
document.querySelector("#create-media-sheet").addEventListener("click", async (event) => {
  const button = event.currentTarget, statusNode = document.querySelector("#media-sheet-status");
  const client = document.querySelector('#pitch-filter-form [name="client"]').value.trim();
  if (!client) { statusNode.textContent = "Enter the client this media list is for"; return; }
  mediaList = sanitizeMediaList(mediaList, directoryReporters);
  if (!mediaList.length) { statusNode.textContent = "No valid Master Directory reporters are in the media list"; return; }
  button.disabled = true; statusNode.textContent = "Creating a new Google Sheet…";
  const headers = MEDIA_LIST_HEADERS;
  const rows = buildMediaListRows(mediaList, directoryReporters);
  const date = new Date();
  const dateStamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  try {
    const result = await readResponse(await fetch("/api/media-list/google/sheets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: `Media List - ${client} - ${dateStamp}`, headers, rows }) }));
    statusNode.innerHTML = `Google Sheet created: <a href="${escapeAttribute(result.spreadsheetUrl)}" target="_blank" rel="noreferrer">${escapeHtml(result.title)}</a>`;
  } catch (error) { statusNode.textContent = error instanceof Error ? error.message : "Unable to create Google Sheet"; }
  finally { button.disabled = false; }
});
loadReporterDirectory();

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderReportTable(headers, rows) {
  return `<table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function renderOutletTable(outlets) {
  if (!outlets.length) return `<p class="empty-state">No outlets found for this client.</p>`;
  return `<table><thead><tr><th>Outlet Name</th><th>UVM</th><th>Link</th></tr></thead><tbody>${outlets.map((row) => `<tr><td class="${row.matched ? "" : "unmatched"}">${escapeHtml(row.name)}${row.matched ? "" : " (unmatched)"}${row.masterDataAvailable ? "" : " (master data unavailable)"}</td><td>${escapeHtml(row.uvm ?? "")}</td><td>${row.link ? `<a href="${escapeHtml(row.link)}" target="_blank" rel="noreferrer">${escapeHtml(row.link)}</a>` : ""}</td></tr>`).join("")}</tbody></table>`;
}

function renderCoverageTable(rows) {
  const headers = ["Date", "Title", "Client", "Media Outlet", "Reporter", "Spokesperson", "Coverage Type", "Sentiment", "Status", "Reach", "URL"];
  return `<table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => {
    const cells = [
      row.date, row.title, row.client,
      row.outletMatched ? row.mediaOutlet : `${row.mediaOutlet} (unmatched)`,
      row.reporterMatched ? row.reporter : `${row.reporter} (unmatched)`,
      row.spokesperson, row.coverageType, row.sentiment, row.status,
      row.reach ?? "",
      row.url
        ? /^https?:\/\/\S+$/i.test(String(row.url))
          ? `<a href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">${escapeHtml(row.url)}</a>`
          : escapeHtml(row.url)
        : ""
    ];
    return `<tr>${cells.map((value, index) => `<td class="${index === 3 && !row.outletMatched || index === 4 && !row.reporterMatched ? "unmatched" : ""}">${index === 10 ? value : escapeHtml(value)}</td>`).join("")}</tr>`;
  }).join("")}</tbody></table>`;
}

function renderContacts(kind, contacts) {
  const rows = contacts.map((contact) => `<tr>${[contact.name, contact.title, contact.email, contact.phone, contact.notes].map((value) => `<td>${escapeHtml(value)}</td>`).join("")}<td><button type="button" data-contact-edit="${escapeHtml(contact.id)}">Edit</button><button type="button" data-contact-delete="${escapeHtml(contact.id)}">Delete</button></td></tr>`).join("");
  return `<form class="contact-form" data-contact-kind="${kind}"><input name="id" type="hidden"><input name="name" placeholder="Name" required><input name="title" placeholder="Title"><input name="email" type="email" placeholder="Email"><input name="phone" placeholder="Phone"><input name="notes" placeholder="Notes"><button type="submit">Save contact <span>→</span></button></form>${renderReportTable(["Name", "Title", "Email", "Phone", "Notes", "Actions"], rows ? contacts.map((contact) => [contact.name, contact.title, contact.email, contact.phone, contact.notes, "Edit / Delete"]) : [])}`;
}

function renderActiveReport() {
  const content = document.querySelector("#report-content");
  if (!reportData) return;
  document.querySelectorAll("[data-report-tab]").forEach((button) => button.classList.toggle("active", button.dataset.reportTab === activeReportTab));
  if (activeReportTab === "Coverage") {
    content.innerHTML = renderCoverageTable(reportData.coverage);
  } else if (activeReportTab === "Reporters") {
    content.innerHTML = reportData.reporters.length ? renderReportTable(["Outlet", "First Name", "Last Name", "Email", "Type", "Clients Covered", "Beats", "Notes", "Status"], reportData.reporters.map((row) => [row.outlet, `${row.firstName}${row.matched ? "" : " (unmatched)"}`, row.lastName, row.email, row.reporterType, row.clientsCovered, row.beats, row.notes, row.status])) : `<p class="empty-state">No reporters found for this client.</p>`;
  } else if (activeReportTab === "Outlets") {
    content.innerHTML = renderOutletTable(reportData.outlets);
  } else {
    const kind = activeReportTab === "Client Contact" ? "client" : "team";
    content.innerHTML = renderContacts(kind, kind === "client" ? reportData.clientContacts : reportData.teamContacts);
  }
}

async function refreshReport() {
  const statusNode = document.querySelector("#report-status");
  try {
    if (!reportClient) {
      const local = await readResponse(await fetch("/api/status", { cache: "no-store" }));
      reportClient = local.clients?.find((client) =>
        local.coverage?.some((record) => record.clientName === client.name)
      )?.name || "";
    }
    if (!reportClient) throw new Error("No local client report is available");
    reportData = await readResponse(await fetch(`/api/report?client=${encodeURIComponent(reportClient)}`, { cache: "no-store" }));
    renderActiveReport();
    statusNode.textContent = `${reportData.client} report loaded`;
  } catch (error) {
    statusNode.textContent = error instanceof Error ? error.message : "Report unavailable";
  }
}

async function loadReferenceSelects() {
  try {
    const data = await readResponse(await fetch("/api/reference-data", { cache: "no-store" }));
    document.querySelector('select[name="outlet"]').innerHTML = `<option value="">Select outlet</option>${data.outlets.map((item) => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.name)}${item.uvm === null ? "" : ` (${item.uvm})`}</option>`).join("")}`;
    const validReporters = uniqueMasterReporters(data.reporters || []);
    const clientNames = Array.isArray(data.clients)
      ? data.clients
      : [...new Set(validReporters.flatMap((reporter) => String(reporter.clientsCovered ?? "").split(/[,;|]/).map((name) => name.trim()).filter(Boolean)))];
    const sortedClients = [...new Set(clientNames.map((name) => String(name).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const clientOptions = sortedClients.map((name) => `<option value="${escapeAttribute(name)}">${escapeHtml(name)}</option>`).join("");
    document.querySelector('select[name="client"]').innerHTML = `<option value="">Select pitch client</option>${clientOptions}`;
    document.querySelector('select[name="client"]').disabled = sortedClients.length === 0;
    similarClientOptions = sortedClients;
    canonicalBeatOptions = Array.isArray(data.canonicalBeats) ? data.canonicalBeats : [];
    renderSelectionBuilder("topic");
    renderSelectionBuilder("similarClient");
    renderSelectionBuilder("reporterType");
    if (!canonicalBeatOptions.length) console.error("[Media List Builder] Canonical Beats were not provided by reference data; topic selection is disabled.");
    const canonicalTypeValues = new Set(CANONICAL_REPORTER_TYPES.map(({ value }) => value));
    const unexpectedTypes = [...new Set(validReporters.map((reporter) => String(reporter.reporterType ?? "").trim()).filter((value) => value && !canonicalTypeValues.has(value.toLocaleLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " "))))].sort((a, b) => a.localeCompare(b));
    if (unexpectedTypes.length) {
      const review = document.querySelector("#reporter-type-review");
      review.hidden = false;
      review.textContent = `Master Directory Reporter Type values for review: ${unexpectedTypes.join(", ")}`;
      console.warn("[Media List Builder] Unexpected Master Directory Reporter Type values", unexpectedTypes);
    }
    manualReporterByLabel = new Map(validReporters.map((item) => [`${personName(item)} — ${item.outlet} [${item.id}]`, item]));
    document.querySelector("#manual-reporter-options").innerHTML = [...manualReporterByLabel.keys()].map((label) => `<option value="${escapeAttribute(label)}"></option>`).join("");
  } catch (error) {
    document.querySelector("#manual-coverage-status").textContent = error instanceof Error ? error.message : "Master sources unavailable";
  }
}

/* ============================================================
   GENERIC HELPERS
   ============================================================ */

async function readResponse(response) {
  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Server returned invalid JSON (${response.status}): ${text.slice(0, 500)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.error ||
      data?.message ||
      `Request failed with HTTP ${response.status}`
    );
  }

  return data;
}


/* ============================================================
   STATUS
   ============================================================ */

async function refreshStatus() {
  try {
    const response = await fetch("/api/status", {
      cache: "no-store"
    });

    const data = await readResponse(response);

    status.textContent =
      data.connected
        ? "Google workspace connected"
        : data.configured
          ? "Folder saved; Google authorization pending"
          : "Workspace not connected";

    status.style.borderColor =
      data.connected
        ? "#53776b"
        : "#e37b4d";

  } catch (error) {
    console.error("Status check failed:", error);

    status.textContent = "Unable to check workspace";

    status.style.borderColor = "#e37b4d";
  }
}


/* ============================================================
   GOOGLE DIAGNOSTICS
   ============================================================ */

document
  .querySelector("#diagnostics-button")
  .addEventListener("click", async (event) => {

    const button = event.currentTarget;
    const output = document.querySelector("#diagnostics-output");

    button.disabled = true;
    output.textContent = "Running diagnostics...";

    try {
      const response = await fetch(
        "/api/diagnostics/google",
        {
          cache: "no-store"
        }
      );

      const data = await readResponse(response);

      output.textContent =
        JSON.stringify(data, null, 2);

    } catch (error) {

      console.error(
        "Google diagnostics failed:",
        error
      );

      output.textContent =
        error instanceof Error
          ? error.message
          : "Diagnostics request failed";

    } finally {

      button.disabled = false;

    }
  });


/* ============================================================
   LOCAL -> GOOGLE SYNC
   ============================================================ */

document
  .querySelector("#sync-local-button")
  .addEventListener("click", async (event) => {

    if (
      !confirm(
        "Sync the existing local records to Google across all clients? This will write client coverage rows and global reporter rows."
      )
    ) {
      return;
    }

    const button = event.currentTarget;
    const output = document.querySelector(
      "#sync-local-status"
    );

    button.disabled = true;
    output.textContent = "Syncing...";

    try {

      const response = await fetch(
        "/api/sync/local",
        {
          method: "POST"
        }
      );

      const data = await readResponse(response);

      output.textContent =
        `${data.addedCoverageRows ?? 0} added, ` +
        `${data.skippedCoverageRows ?? 0} skipped, ` +
        `${data.reporterSync?.addedReporterRows ?? 0} reporters added, ` +
        `${data.reporterSync?.updatedReporterRows ?? 0} reporters updated`;

    } catch (error) {

      console.error(
        "Local sync failed:",
        error
      );

      output.textContent =
        error instanceof Error
          ? error.message
          : "Local sync failed";

    } finally {

      button.disabled = false;

    }
  });


/* ============================================================
   POPULATE MASTER REPORTERS
   ============================================================ */

document
  .querySelector("#populate-reporters-button")
  .addEventListener("click", async (event) => {

    if (
      !confirm(
        "Stage local reporter records in Sheet1? Gemini-curated rows in Master Directory (Cleaned) will not be added or overwritten by this action."
      )
    ) {
      return;
    }

    const button = event.currentTarget;
    const output = document.querySelector(
      "#populate-reporters-status"
    );

    button.disabled = true;
    output.textContent = "Staging reporters in Sheet1...";

    try {

      const response = await fetch(
        "/api/sync/reporters",
        {
          method: "POST"
        }
      );

      const data = await readResponse(response);

      output.textContent =
        `${data.addedReporterRows ?? 0} added, ` +
        `${data.updatedReporterRows ?? 0} updated, ` +
        `${data.skippedReporterRows ?? 0} unchanged`;

    } catch (error) {

      console.error(
        "Reporter population failed:",
        error
      );

      output.textContent =
        error instanceof Error
          ? error.message
          : "Reporter population failed";

    } finally {

      button.disabled = false;

    }
  });


/* ============================================================
   ENRICHMENT RENDERING
   ============================================================ */

function renderEnrichment(
  proposals,
  summary
) {

  enrichmentProposals = proposals ?? [];

  document.querySelector(
    "#enrichment-summary"
  ).innerHTML =
    Object.entries(summary ?? {})
      .filter(
        ([label, value]) =>
          label !== "message" &&
          value !== null &&
          !(label === "providerDailyLimitReached" && value === false)
      )
      .map(
        ([label, value]) => `
          <div>
            <strong>${value}</strong>
            <span>
              ${label.replaceAll(
                /([A-Z])/g,
                " $1"
              )}
            </span>
          </div>
        `
      )
      .join("");

  document.querySelector(
    "#enrichment-rows"
  ).innerHTML =
    enrichmentProposals
      .map(
        (proposal) => `
          <tr
            class="${
              proposal.approvalStatus === "approved"
                ? "approved"
                : ""
            }"
          >

            <td>
              ${proposal.reporterName}
              ${proposal.currentNotes ? `<small class="notes-tag">Notes: ${proposal.currentNotes}</small>` : ""}
            </td>

            <td>${proposal.outlet}</td>

            <td>${proposal.currentReporterType ?? "reporter"}</td>
            <td>${proposal.reporterType ?? "reporter"}</td>
            <td>${proposal.currentBeats || "—"}</td>
            <td>${proposal.beats?.join(", ") || "Needs evidence"}</td>

            <td>
              ${Math.round(
                (proposal.confidence ?? 0) * 100
              )}%
            </td>

            <td>
              ${
                proposal.sources?.length
                  ? proposal.sources
                      .map(
                        (source) => `
                          <a
                            href="${source.url}"
                            target="_blank"
                            rel="noreferrer"
                          >
                            ${source.title || source.url}
                          </a>
                        `
                      )
                      .join("<br>")
                  : "None"
              }
            </td>

            <td>

              <button
                data-enrichment-action="approve"
                data-id="${proposal.proposalId}"
                type="button"
              >
                Approve
              </button>

              <button
                data-enrichment-action="reject"
                data-id="${proposal.proposalId}"
                type="button"
              >
                Reject
              </button>

              <button
                data-enrichment-action="edit"
                data-id="${proposal.proposalId}"
                type="button"
              >
                Edit
              </button>

              <button
                data-enrichment-action="review"
                data-id="${proposal.proposalId}"
                type="button"
              >
                Needs Review
              </button>

            </td>

          </tr>
        `
      )
      .join("");
}

function enrichmentRunStatus(summary) {
  if (!summary) return "Dry-run complete; no Google changes made";

  const next = summary.nextEnrichmentAvailableAt
    ? new Date(summary.nextEnrichmentAvailableAt).toLocaleString()
    : null;
  const quota = `${summary.quotaUsed ?? 0}/31 daily enrichment slots used`;
  const message = summary.message ?? "Dry-run complete; no Google changes made";

  return next ? `${message} ${quota}. Next enrichment available: ${next}.` : `${message} ${quota}.`;
}


/* ============================================================
   RUN ENRICHMENT
   ============================================================ */

document
  .querySelector("#enrich-button")
  .addEventListener("click", async (event) => {

    const button = event.currentTarget;

    button.disabled = true;

    document.querySelector(
      "#enrichment-status"
    ).textContent =
      "Researching unique reporters...";

    try {

      const response = await fetch(
        "/api/enrich/reporters",
        {
          method: "POST"
        }
      );

      const data = await readResponse(response);

      renderEnrichment(
        data.proposals,
        data.summary
      );

      document.querySelector(
        "#enrichment-status"
      ).textContent =
        enrichmentRunStatus(data.summary);

    } catch (error) {

      console.error(
        "Reporter enrichment failed:",
        error
      );

      document.querySelector(
        "#enrichment-status"
      ).textContent =
        error instanceof Error
          ? error.message
          : "Enrichment failed";

    } finally {

      button.disabled = false;

    }
  });


/* ============================================================
   INDIVIDUAL ENRICHMENT ACTIONS
   ============================================================ */

document
  .querySelector("#enrichment-rows")
  .addEventListener("click", async (event) => {

    const button =
      event.target.closest(
        "[data-enrichment-action]"
      );

    if (!button) {
      return;
    }

    const action =
      button.dataset.enrichmentAction;

    const proposal =
      enrichmentProposals.find(
        (item) =>
          item.proposalId ===
          button.dataset.id
      );

    if (!proposal) {
      return;
    }

    let patch;

    if (action === "edit") {

      const beatDescription =
        prompt(
          "Edit the proposed beat description:",
          proposal.beatDescription ?? ""
        );

      if (beatDescription === null) {
        return;
      }

      patch = {
        beatDescription
      };
    }

    try {

      const response = await fetch(
        "/api/enrich/reporters/approval",
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            updates: [
              {
                proposalId:
                  button.dataset.id,

                approvalStatus:
                  action === "approve"
                    ? "approved"
                    : action === "reject"
                      ? "rejected"
                      : action === "edit"
                        ? "edited"
                        : "pending",

                patch
              }
            ]
          })
        }
      );

      await readResponse(response);

      proposal.approvalStatus =
        action === "approve"
          ? "approved"
          : action === "reject"
            ? "rejected"
            : action === "edit"
              ? "edited"
              : "pending";

      if (patch) {
        Object.assign(
          proposal,
          patch
        );
      }

      button
        .closest("tr")
        ?.classList.toggle(
          "approved",
          proposal.approvalStatus ===
            "approved"
        );

    } catch (error) {

      console.error(
        "Enrichment approval failed:",
        error
      );

      alert(
        error instanceof Error
          ? error.message
          : "Approval failed"
      );

    }
  });


/* ============================================================
   APPROVE HIGH CONFIDENCE
   ============================================================ */

document
  .querySelector("#approve-high-button")
  .addEventListener("click", async () => {

    const updates =
      enrichmentProposals
        .filter(
          (proposal) =>
            proposal.confidence >= 0.9 &&
            proposal.authoritativeSource &&
            proposal.status === "verified"
        )
        .map(
          (proposal) => ({
            proposalId:
              proposal.proposalId,
            approvalStatus:
              "approved"
          })
        );

    if (!updates.length) {

      document.querySelector(
        "#enrichment-status"
      ).textContent =
        "No high-confidence verified proposals found";

      return;
    }

    try {

      const response = await fetch(
        "/api/enrich/reporters/approval",
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            updates
          })
        }
      );

      await readResponse(response);

      enrichmentProposals.forEach(
        (proposal) => {

          if (
            updates.some(
              (update) =>
                update.proposalId ===
                proposal.proposalId
            )
          ) {
            proposal.approvalStatus =
              "approved";
          }

        }
      );

      renderEnrichment(
        enrichmentProposals,
        {}
      );

      document.querySelector(
        "#enrichment-status"
      ).textContent =
        `${updates.length} high-confidence proposals approved`;

    } catch (error) {

      console.error(
        "Approve-high failed:",
        error
      );

      document.querySelector(
        "#enrichment-status"
      ).textContent =
        error instanceof Error
          ? error.message
          : "Approval failed";

    }
  });


/* ============================================================
   APPLY ENRICHMENT
   ============================================================ */

document
  .querySelector("#apply-enrichment-button")
  .addEventListener("click", async () => {

    if (
      !confirm(
        "Apply approved reporter changes to Master Directory (Cleaned)?"
      )
    ) {
      return;
    }

    try {

      const response = await fetch(
        "/api/enrich/reporters/apply",
        {
          method: "POST"
        }
      );

      const data =
        await readResponse(response);

      document.querySelector(
        "#enrichment-status"
      ).textContent =
        `${data.googleRowsWritten ?? 0} Google rows updated or added`;

    } catch (error) {

      console.error(
        "Apply enrichment failed:",
        error
      );

      document.querySelector(
        "#enrichment-status"
      ).textContent =
        error instanceof Error
          ? error.message
          : "Apply failed";

    }
  });


/* ============================================================
   GOOGLE CONFIGURATION
   ============================================================ */

document
  .querySelector("#config-form")
  .addEventListener("submit", async (event) => {

    event.preventDefault();

    const form =
      event.currentTarget;

    const button =
      form.querySelector("button");

    button.disabled = true;

    try {

      const body =
        Object.fromEntries(
          new FormData(form)
        );

      const response =
        await fetch(
          "/api/config",
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json"
            },
            body: JSON.stringify(body)
          }
        );

      const data =
        await readResponse(response);

      if (!data.authorizationUrl) {
        throw new Error(
          "The server did not return a Google authorization URL"
        );
      }

      window.location.assign(
        data.authorizationUrl
      );

    } catch (error) {

      console.error(
        "Configuration failed:",
        error
      );

      alert(
        error instanceof Error
          ? error.message
          : "Unable to start Google authorization"
      );

    } finally {

      button.disabled = false;

    }
  });


/* ============================================================
   FILE SELECTION
   ============================================================ */

fileInput.addEventListener(
  "change",
  () => {

    const file =
      fileInput.files?.[0];

    if (!file) {

      fileLabel.textContent =
        "Choose a PRCC file";

      ingestStatus.textContent =
        "Choose a file to begin";

      return;
    }

    fileLabel.textContent =
      file.name;

    const maxSize =
      10 * 1024 * 1024;

    if (file.size > maxSize) {

      ingestStatus.textContent =
        "File is larger than 10 MB";

      return;
    }

    ingestStatus.textContent =
      `Ready to process ${file.name}`;

  }
);


/* ============================================================
   PRCC INGESTION
   ============================================================ */

ingestForm.addEventListener(
  "submit",
  async (event) => {

    event.preventDefault();

    console.log(
      "[PRCC] Process coverage clicked"
    );

    const file =
      fileInput.files?.[0];

    /*
      Do NOT rely on HTML required validation.
      Validate manually so the hidden file input
      can never trigger the browser's
      "invalid form control is not focusable" error.
    */

    if (!file) {

      ingestStatus.textContent =
        "Please choose a CSV file first.";

      fileInput.focus();

      return;
    }

    const maxSize =
      10 * 1024 * 1024;

    if (file.size > maxSize) {

      ingestStatus.textContent =
        "That file is larger than 10 MB.";

      return;
    }

    const lowerName =
      file.name.toLowerCase();

    const allowed =
      lowerName.endsWith(".csv") ||
      lowerName.endsWith(".json") ||
      lowerName.endsWith(".txt");

    if (!allowed) {

      ingestStatus.textContent =
        "Please choose a CSV, JSON, or TXT file.";

      return;
    }

    ingestButton.disabled = true;

    ingestStatus.textContent =
      `Processing ${file.name}...`;

    try {

      const formData =
        new FormData();

      formData.append(
        "file",
        file,
        file.name
      );

      console.log(
        "[PRCC] Sending file:",
        file.name,
        file.size,
        file.type
      );

      const response =
        await fetch(
          "/api/ingest",
          {
            method: "POST",
            body: formData
          }
        );

      console.log(
        "[PRCC] Server response:",
        response.status
      );

      const data =
        await readResponse(response);

      console.log(
        "[PRCC] Ingestion result:",
        data
      );

      results.hidden = false;

      document.querySelector(
        "#added"
      ).textContent =
        data.coverageAdded ?? data.records?.length ?? 0;

      document.querySelector(
        "#duplicates"
      ).textContent =
        data.coverageDuplicates ?? data.duplicates?.length ?? 0;

      document.querySelector(
        "#review"
      ).textContent =
        data.reviewRequired?.length ?? 0;

      document.querySelector(
        "#sync-badge"
      ).textContent =
        data.syncedToGoogle
          ? "SYNCED TO GOOGLE"
          : "LOCAL STRUCTURED STORE";

      document.querySelector(
        "#review-list"
      ).innerHTML =
        (data.reviewRequired ?? [])
          .map(
            (item) =>
              `<li>${item}</li>`
          )
          .join("");

      const reviewRequired = data.reviewRequired ?? [];
      const reviewReasons = [...new Set(reviewRequired)];
      const reviewSummary = reviewRequired.length
        ? `; ${reviewRequired.length} records require review${reviewReasons.length === 1 ? `: ${reviewReasons[0]}` : ` (${reviewReasons.length} issue types; first: ${reviewReasons[0]})`}`
        : "";
      ingestStatus.textContent =
        `Done: ${data.coverageAdded ?? 0} coverage added, ${data.coverageDuplicates ?? 0} duplicates, ${data.reportersDiscovered ?? 0} reporters discovered (${data.reportersAdded ?? 0} added, ${data.reportersSkipped ?? 0} skipped)${reviewSummary}`;
      refreshReport();

    } catch (error) {

      console.error(
        "[PRCC] INGEST FAILED:",
        error
      );

      ingestStatus.textContent =
        error instanceof Error
          ? `Error: ${error.message}`
          : "PRCC ingestion failed";

    } finally {

      ingestButton.disabled = false;

    }
  }
);

document.querySelector("#refresh-report-button").addEventListener("click", refreshReport);
document.querySelector("#report-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-report-tab]");
  if (!button) return;
  activeReportTab = button.dataset.reportTab;
  renderActiveReport();
});
document.querySelector("#app-navigation").addEventListener("click", (event) => {
  const button = event.target.closest("[data-app-view]");
  if (!button) return;
  const selectedView = button.dataset.appView;
  document.querySelectorAll("[data-app-view]").forEach((tab) => {
    const selected = tab === button;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
  });
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== selectedView;
  });
  if (selectedView === "coverage") refreshReport();
});
document.querySelector("#manual-reporter-search").addEventListener("input", (event) => {
  const reporter = manualReporterByLabel.get(event.currentTarget.value);
  document.querySelector('#manual-coverage-form [name="reporterId"]').value = reporter?.id ?? "";
});

document.querySelector("#manual-coverage-button").addEventListener("click", async () => {
  const form = document.querySelector("#manual-coverage-form");
  const statusNode = document.querySelector("#manual-coverage-status");
  const body = Object.fromEntries(new FormData(form));
  try {
    const data = await readResponse(await fetch("/api/coverage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }));
    statusNode.textContent = `${data.coverageAdded ?? 0} coverage record added`;
    form.reset();
    await refreshReport();
  } catch (error) {
    statusNode.textContent = error instanceof Error ? error.message : "Coverage entry failed";
  }
});

document.querySelector("#report-content").addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-contact-kind]");
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.contactKind;
  try {
    await readResponse(await fetch(`/api/contacts/${kind}?client=${encodeURIComponent(reportClient)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    }));
    await refreshReport();
  } catch (error) {
    document.querySelector("#report-status").textContent = error instanceof Error ? error.message : "Contact save failed";
  }
});

document.querySelector("#report-content").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-contact-delete], [data-contact-edit]");
  if (!button) return;
  const kind = activeReportTab === "Client Contact" ? "client" : "team";
  const id = button.dataset.contactDelete ?? button.dataset.contactEdit;
  const contacts = kind === "client" ? reportData.clientContacts : reportData.teamContacts;
  const contact = contacts.find((item) => item.id === id);
  if (button.dataset.contactEdit) {
    const form = document.querySelector("[data-contact-kind]");
    ["name", "title", "email", "phone", "notes"].forEach((field) => { form.elements[field].value = contact?.[field] ?? ""; });
    form.elements.id.value = contact?.id ?? "";
    return;
  }
  if (confirm("Delete this contact?")) {
    await fetch(`/api/contacts/${kind}/${encodeURIComponent(id)}?client=${encodeURIComponent(reportClient)}`, { method: "DELETE" });
    await refreshReport();
  }
});


/* ============================================================
   INITIALIZE
   ============================================================ */

refreshStatus();
loadReferenceSelects();
refreshReport();

console.log(
  "[PRCC] app.js loaded successfully"
);
