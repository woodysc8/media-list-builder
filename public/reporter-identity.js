function normalized(value) {
  return String(value ?? "").toLocaleLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function isPlaceholder(value) {
  const cleaned = String(value ?? "").trim().toLocaleLowerCase().replace(/[.]/g, "");
  return !cleaned || ["n/a", "na", "not available", "unknown", "unassigned", "null", "none", "tbd", "-"].includes(cleaned);
}

function hasMalformedMixedScriptToken(value) {
  return String(value ?? "").split(/\s+/).some((token) => /\p{Script=Latin}/u.test(token) && /\p{Script=Han}/u.test(token));
}

// This is the identity boundary used by both the API diagnostics and browser filter.
export function isValidMasterReporter(reporter) {
  const id = String(reporter?.id ?? "").trim();
  const first = String(reporter?.firstName ?? "").trim();
  const last = String(reporter?.lastName ?? "").trim();
  const fullName = `${first} ${last}`.trim();
  return Boolean(id && !isPlaceholder(fullName) && /\p{L}/u.test(fullName) &&
    !hasMalformedMixedScriptToken(fullName) && !(first && isPlaceholder(first)) && !(last && isPlaceholder(last)));
}

export function uniqueMasterReporters(reporters = []) {
  const seen = new Set();
  const result = [];
  for (const reporter of reporters) {
    if (!isValidMasterReporter(reporter)) continue;
    const id = String(reporter.id).trim();
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(reporter);
  }
  return result;
}
