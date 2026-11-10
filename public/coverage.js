const $ = (id) => document.getElementById(id);
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
    `${state.paused ? "Paused" : "Running"} · ${state.jobs.length} files · ${state.jobs.filter((j) => j.state === "completed").length} completed · ${state.jobs.filter((j) => j.state === "failed").length} failed`;
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
    cell(tr, j.state);
    cell(
      tr,
      `${j.imported} imported · ${j.duplicates} duplicates · ${j.records.length} pending · ${j.errors.length} rejected`,
    );
    cell(tr, j.sync);
    const detail = cell(tr, "");
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Preview / errors";
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
    cell(
      tr,
      state.jobs.filter((j) => j.client === r.clientName).at(-1)?.sync ||
        "pending",
    );
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
$("upload").onsubmit = async (e) => {
  e.preventDefault();
  const files = [...$("files").files];
  let accepted = 0;
  const errors = [];
  const button = $("upload").querySelector("button");
  button.disabled = true;
  try {
    // Transfer sequentially so selecting a large batch does not buffer it all on the server.
    for (const file of files) {
      $("message").textContent =
        `Uploading ${accepted + errors.length + 1}/${files.length}: ${file.name}`;
      const data = new FormData();
      data.append("files", file);
      data.append("client", $("client").value);
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
      `${accepted} files saved. Review the queue, then start processing. ${errors.join(" | ")}`;
    await refresh();
  } finally {
    button.disabled = false;
  }
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
  $("files").files = e.dataTransfer.files;
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
