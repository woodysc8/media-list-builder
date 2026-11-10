const $ = (id) => document.getElementById(id);
const clientKey = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
let state = { jobs: [], records: [] },
  filtered = [];
async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw Error(body.error || "Request failed");
  return body;
}
function cell(row, value) {
  const td = document.createElement("td");
  td.textContent = String(value ?? "");
  row.append(td);
  return td;
}
function render() {
  $("summary").textContent =
    `${state.summary.status} · ${state.summary.totalFiles} files · ${state.summary.completedFiles} completed · ${state.summary.failedFiles} failed · ${state.summary.pendingFiles} processing/pending · ${state.summary.cancelledFiles} cancelled · ${state.summary.importedRecords} imported records · ${state.summary.rejectedRecords} rejected rows · Google: ${state.summary.verifiedCoverageRecords} records verified · ${state.summary.pendingClientDeliveries} client deliveries pending · ${state.summary.failedClientDeliveries} client deliveries failed`;
  $("destinations").replaceChildren();
  for (const delivery of Object.values(state.deliveries ?? {})) {
    const tr = document.createElement("tr");
    const destination = delivery.destination;
    cell(tr, delivery.client);
    cell(tr, delivery.state);
    const sheet = cell(tr, "");
    const id =
      destination?.spreadsheetId ||
      state.destinations?.[clientKey(delivery.client)];
    if (id) {
      const a = document.createElement("a");
      a.href =
        destination?.spreadsheetUrl ||
        `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
      a.textContent =
        destination?.spreadsheetName || "Resolving spreadsheet name…";
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      sheet.append(a);
    } else sheet.textContent = "Waiting for destination";
    const parents = cell(tr, "");
    for (const parent of destination?.parents ?? []) {
      const a = document.createElement("a");
      a.href = parent.url;
      a.textContent = parent.name;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      parents.append(a, document.createElement("br"));
    }
    if (!destination?.parents?.length)
      parents.textContent = "Folder not yet verified";
    cell(tr, destination?.verifiedRecords ?? 0);
    cell(
      tr,
      [
        destination?.verifiedAt
          ? new Date(destination.verifiedAt).toLocaleString()
          : "",
        delivery.error || "",
      ]
        .filter(Boolean)
        .join(" · "),
    );
    $("destinations").append(tr);
  }
  $("resume").hidden = !state.paused;
  $("verification").textContent = JSON.stringify(state.verification, null, 2);
  const clients = new Map();
  for (const j of state.jobs) {
    const counts = clients.get(j.client) || {
      files: 0,
      completed: 0,
      imported: 0,
      duplicates: 0,
      rejected: 0,
    };
    counts.files++;
    counts.completed += Number(j.state === "completed");
    counts.imported += j.imported;
    counts.duplicates += j.duplicates;
    counts.rejected += j.errors.length;
    clients.set(j.client, counts);
  }
  const clientSummary =
    document.getElementById("client-progress") || document.createElement("pre");
  clientSummary.id = "client-progress";
  clientSummary.textContent = [...clients]
    .map(
      ([client, c]) =>
        `${client}: ${c.completed}/${c.files} files complete · ${c.imported} imported · ${c.duplicates} duplicates · ${c.rejected} rejected`,
    )
    .join("\n");
  $("summary").after(clientSummary);
  $("jobs").replaceChildren();
  for (const j of state.jobs) {
    const tr = document.createElement("tr");
    cell(tr, `${j.file} ${j.year}`);
    cell(tr, j.client);
    cell(tr, j.needsAttention ? "Needs attention" : j.state);
    cell(
      tr,
      `${j.imported} imported · ${j.duplicates} duplicates · ${j.records.length} pending · ${j.errors.length} rejected`,
    );
    cell(
      tr,
      j.state === "completed"
        ? state.deliveries?.[clientKey(j.client)]?.state || "pending"
        : j.sync,
    );
    const detail = cell(tr, "");
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Errors / review (optional)";
    details.append(summary);
    const pre = document.createElement("pre");
    pre.textContent = [
      j.error || "",
      ...j.errors.map(
        (e) => `${e.file} / ${e.tab || "CSV"} row ${e.row}: ${e.error}`,
      ),
      ...j.records
        .slice(0, 20)
        .map(
          (r) =>
            `${r.rawFields.sourceTab || "CSV"} row ${r.rawFields.sourceRow}: ${r.articleTitle} | ${r.articleUrl}`,
        ),
    ].join("\n");
    details.append(pre);
    detail.append(details);
    $("jobs").append(tr);
  }
  filtered = state.records
    .filter(
      (r) =>
        r.clientName
          .toLowerCase()
          .includes($("filter-client").value.toLowerCase()) &&
        r.outlet
          .toLowerCase()
          .includes($("filter-outlet").value.toLowerCase()) &&
        r.reporterName
          .toLowerCase()
          .includes($("filter-reporter").value.toLowerCase()) &&
        (!$("from").value || r.publicationDate >= $("from").value) &&
        (!$("to").value || r.publicationDate <= $("to").value),
    )
    .sort((a, b) => b.publicationDate.localeCompare(a.publicationDate));
  $("library-summary").textContent = `${filtered.length} records`;
  $("records").replaceChildren();
  for (const r of filtered) {
    const tr = document.createElement("tr");
    for (const v of [
      r.publicationDate,
      r.articleTitle,
      r.clientName,
      r.outlet,
      r.reporterName,
    ])
      cell(tr, v);
    const td = cell(tr, "");
    const a = document.createElement("a");
    a.href = r.articleUrl;
    a.textContent = r.articleUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    td.append(a);
    cell(tr, state.deliveries?.[clientKey(r.clientName)]?.state || "pending");
    $("records").append(tr);
  }
}
async function refresh() {
  try {
    state = await api("/api/clean-coverage");
    render();
  } catch (e) {
    $("message").textContent = e.message;
  }
}
let uploading = false;
const transfers = [];
async function uploadFiles(files) {
  transfers.push(...files);
  if (uploading) return;
  uploading = true;
  let accepted = 0;
  const errors = [];
  try {
    // Transfer sequentially so selecting a large batch does not buffer it all on the server.
    while (transfers.length) {
      const file = transfers.shift();
      $("message").textContent =
        `Uploading ${file.name} · ${transfers.length} files still transferring`;
      const data = new FormData();
      data.append("files", file);
      try {
        const result = await api("/api/clean-coverage/upload", {
          method: "POST",
          body: data,
        });
        accepted += result.jobs.length;
        errors.push(
          ...result.rejectedFiles.map((e) => `${e.file}: ${e.error}`),
        );
      } catch (e) {
        errors.push(`${file.name}: ${e.message}`);
      }
    }
    $("message").textContent =
      `${accepted} files uploaded. Processing and Google synchronization continue automatically. ${errors.join(" | ")}`;
    await refresh();
  } finally {
    uploading = false;
  }
}
$("upload").onsubmit = (e) => e.preventDefault();
$("files").onchange = () => {
  void uploadFiles([...$("files").files]);
  $("files").value = "";
};
$("controls").onclick = async (e) => {
  if (!e.target.dataset.action) return;
  try {
    await api("/api/clean-coverage/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: e.target.dataset.action }),
    });
    await refresh();
  } catch (e) {
    $("message").textContent = e.message;
  }
};
$("drop").ondragover = (e) => e.preventDefault();
$("drop").ondrop = (e) => {
  e.preventDefault();
  void uploadFiles([...e.dataTransfer.files]);
};
$("filters").oninput = render;
$("export").onclick = () => {
  const quote = (v) => '"' + String(v ?? "").replaceAll('"', '""') + '"';
  const rows = [
    [
      "Date",
      "Title",
      "Client",
      "Media Outlet",
      "Reporter",
      "Spokespersons ID",
      "Coverage Type",
      "Sentiment",
      "Status",
      "Reach",
      "URL",
    ],
    ...filtered.map((r) => [
      r.publicationDate,
      r.articleTitle,
      r.clientName,
      r.outlet,
      r.reporterName,
      r.spokesperson,
      r.coverageType,
      r.sentiment,
      r.status,
      r.reach,
      r.articleUrl,
    ]),
  ];
  const url = URL.createObjectURL(
    new Blob([rows.map((r) => r.map(quote).join(",")).join("\r\n")], {
      type: "text/csv",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "coverage.csv";
  a.click();
  URL.revokeObjectURL(url);
};
await refresh();
setInterval(refresh, 3000);
