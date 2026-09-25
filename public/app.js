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
    document.querySelector('select[name="reporterId"]').innerHTML = `<option value="">Select reporter</option>${data.reporters.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(`${item.firstName} ${item.lastName} - ${item.outlet}`)}</option>`).join("")}`;
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
        "Populate the global Master Reporter List from local records? This will write reporter rows only."
      )
    ) {
      return;
    }

    const button = event.currentTarget;
    const output = document.querySelector(
      "#populate-reporters-status"
    );

    button.disabled = true;
    output.textContent = "Populating...";

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
        "Apply approved reporter changes to the existing Master Reporter List?"
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

      ingestStatus.textContent =
        `Done: ${data.coverageAdded ?? 0} coverage added, ${data.coverageDuplicates ?? 0} duplicates, ${data.reportersDiscovered ?? 0} reporters discovered (${data.reportersAdded ?? 0} added, ${data.reportersSkipped ?? 0} skipped)`;
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
