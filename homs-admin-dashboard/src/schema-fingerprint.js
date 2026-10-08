// What a HOMS client account's object layer is supposed to look like, and
// whether a given account actually looks like it.
//
// Two jobs, one comparison:
//
//   1. A snapshot load has never been proven to carry the object layer
//      faithfully. DEMO-HOMS was built by hand and Luminara predates objects
//      entirely, so "the snapshot reproduces all 8 objects with every field and
//      every option key" is an assumption, not a tested fact. If an option key
//      arrives renamed, every record written against it is orphaned, quietly.
//
//   2. Labels get translated per account (Spanish clients), and keys must not
//      move when they do. Same comparison answers that: labels may differ,
//      keys may not.
//
// Hence the split that runs through this file: KEYS and SHAPE are integrity,
// LABELS are cosmetic. A difference in the first is a failure; a difference in
// the second is a note, because translation is allowed to cause it.

// Objects deliberately left out of the provisioning snapshot.
//
// ota_channels was dropped on 2026-09-29 once the dashboard stopped displaying
// it. Its absence is correct and must not read as a failed load -- but its
// PRESENCE is worth a note, because that would mean the snapshot changed
// without this list changing with it.
export const EXPECTED_ABSENT = {
  "custom_objects.ota_channels":
    "dropped from the snapshot 2026-09-29, once the dashboard stopped displaying it",
};

const sortedKeys = (opts) =>
  (Array.isArray(opts) ? opts : [])
    .map((o) => (o && typeof o === "object" ? o.key : o))
    .filter((k) => k !== undefined && k !== null && k !== "")
    .map(String)
    .sort();

/**
 * A comparable record of one account's object layer.
 *
 * `objects` is what GET /objects/ returns; `fieldsByObject` maps an object key
 * to that object's GET /custom-fields/object-key/{key} response. Both are
 * passed in rather than fetched here so this stays pure and testable, and so a
 * capture can come from a PIT, from the MCP connector, or from a saved file.
 */
export function fingerprint({ locationId, objects, fieldsByObject, capturedAt = null }) {
  const out = {
    locationId: locationId || null,
    capturedAt: capturedAt || new Date().toISOString(),
    objects: {},
  };

  for (const obj of objects || []) {
    // Only the objects HOMS defines. The three SYSTEM_DEFINED ones (contact,
    // opportunity, business) exist on every GHL account and say nothing about
    // whether a snapshot loaded.
    if (obj?.type !== "USER_DEFINED") continue;
    const key = obj.key;
    if (!key) continue;

    const entry = {
      // Integrity: these decide whether records can be written and found.
      primaryDisplayProperty: obj.primaryDisplayProperty || null,
      requiredProperties: [...(obj.requiredProperties || [])].sort(),
      // Cosmetic: translation is expected to change these.
      labels: { singular: obj.labels?.singular ?? null, plural: obj.labels?.plural ?? null },
      description: obj.description ?? null,
      fields: {},
    };

    for (const f of fieldsByObject?.[key]?.fields || []) {
      if (!f?.fieldKey) continue;
      entry.fields[f.fieldKey] = {
        // Integrity.
        dataType: f.dataType || null,
        options: sortedKeys(f.options),
        // A FILE_UPLOAD field carries its own constraints, and a snapshot does
        // NOT reproduce them. Verified 2026-10-08 on the first real load:
        // receipt_photo arrived on YV with neither acceptedFormats nor
        // maxFileLimit, while DEMO-HOMS has [".jpeg",".jpg",".png",".pdf"] and
        // 5. Without these captured, the check called that account identical
        // when it was not -- this file's own blind spot, found on first use.
        acceptedFormats: Array.isArray(f.acceptedFormats)
          ? [...f.acceptedFormats].sort()
          : f.acceptedFormats ? [String(f.acceptedFormats)] : [],
        maxFileLimit: Number.isFinite(Number(f.maxFileLimit)) ? Number(f.maxFileLimit) : null,
        // Cosmetic.
        name: f.name ?? null,
        description: f.description ?? null,
      };
    }
    out.objects[key] = entry;
  }
  return out;
}

const only = (a, b) => Object.keys(a).filter((k) => !Object.hasOwn(b, k)).sort();

/**
 * Compares an actual account against the expected one.
 *
 * Returns { ok, failures, notes }. `ok` is false only when integrity differs:
 * a missing object or field, a changed dataType, or an option key that moved.
 * Label and description differences are notes, never failures.
 */
export function diffSchemas(expected, actual, { expectedAbsent = EXPECTED_ABSENT } = {}) {
  const failures = [];
  const notes = [];
  const exp = expected?.objects || {};
  const act = actual?.objects || {};

  for (const key of only(exp, act)) {
    if (Object.hasOwn(expectedAbsent, key)) {
      notes.push({ kind: "object_absent_as_expected", object: key, why: expectedAbsent[key] });
    } else {
      failures.push({ kind: "object_missing", object: key });
    }
  }

  // An object nobody expected. Not an integrity problem for anything that
  // exists, so a note -- but it means this file and the snapshot disagree.
  for (const key of only(act, exp)) {
    notes.push({
      kind: Object.hasOwn(expectedAbsent, key) ? "object_present_but_listed_absent" : "object_unexpected",
      object: key,
    });
  }

  for (const [key, e] of Object.entries(exp)) {
    const a = act[key];
    if (!a) continue; // already reported above

    if (e.primaryDisplayProperty !== a.primaryDisplayProperty) {
      failures.push({ kind: "primary_display_changed", object: key,
        expected: e.primaryDisplayProperty, actual: a.primaryDisplayProperty });
    }
    if (String(e.requiredProperties) !== String(a.requiredProperties)) {
      failures.push({ kind: "required_properties_changed", object: key,
        expected: e.requiredProperties, actual: a.requiredProperties });
    }
    if (e.labels.singular !== a.labels.singular || e.labels.plural !== a.labels.plural) {
      notes.push({ kind: "label_differs", object: key, expected: e.labels, actual: a.labels });
    }
    if (e.description !== a.description) {
      notes.push({ kind: "description_differs", object: key });
    }

    for (const fk of only(e.fields, a.fields)) {
      failures.push({ kind: "field_missing", object: key, field: fk });
    }
    for (const fk of only(a.fields, e.fields)) {
      notes.push({ kind: "field_unexpected", object: key, field: fk });
    }

    for (const [fk, ef] of Object.entries(e.fields)) {
      const af = a.fields[fk];
      if (!af) continue;

      if (ef.dataType !== af.dataType) {
        failures.push({ kind: "data_type_changed", object: key, field: fk,
          expected: ef.dataType, actual: af.dataType });
      }
      // An upload field that lost its constraints accepts files nothing
      // downstream expects, or stops accepting the five it was built for.
      // Older fingerprints predate these keys, so an undefined expectation is
      // "not captured", not "expected empty" -- otherwise re-capturing the
      // contract would be required before the check could run at all.
      if (ef.acceptedFormats !== undefined &&
          String(ef.acceptedFormats) !== String(af.acceptedFormats ?? [])) {
        failures.push({ kind: "accepted_formats_changed", object: key, field: fk,
          expected: ef.acceptedFormats, actual: af.acceptedFormats ?? [] });
      }
      if (ef.maxFileLimit !== undefined && ef.maxFileLimit !== (af.maxFileLimit ?? null)) {
        failures.push({ kind: "max_file_limit_changed", object: key, field: fk,
          expected: ef.maxFileLimit, actual: af.maxFileLimit ?? null });
      }
      // The one that would be silent and unrecoverable: option keys are stored
      // ON records (paid_by: "owner"). A key that moved orphans every record
      // carrying the old one.
      const missing = ef.options.filter((o) => !af.options.includes(o));
      const added = af.options.filter((o) => !ef.options.includes(o));
      if (missing.length) {
        failures.push({ kind: "option_keys_missing", object: key, field: fk, missing });
      }
      if (added.length) {
        // Added keys break nothing that exists, but an unplanned one means
        // somebody edited options somewhere -- and update-custom-field REPLACES
        // the array, so an edit is exactly how a key goes missing.
        notes.push({ kind: "option_keys_added", object: key, field: fk, added });
      }
      if (ef.name !== af.name) {
        notes.push({ kind: "field_label_differs", object: key, field: fk, expected: ef.name, actual: af.name });
      }
    }
  }

  return { ok: failures.length === 0, failures, notes };
}

/** Human-readable, grouped, failures first. */
export function formatDiff({ ok, failures, notes }, { expectedLabel = "expected", actualLabel = "actual" } = {}) {
  const lines = [];
  lines.push(ok
    ? `PASS — every object, field and option key in ${expectedLabel} is present in ${actualLabel}.`
    : `FAIL — ${failures.length} integrity difference${failures.length === 1 ? "" : "s"}.`);

  if (failures.length) {
    lines.push("", "Integrity (keys and shape — these break data):");
    for (const f of failures) lines.push(`  ${f.kind.padEnd(28)} ${f.object}${f.field ? ` . ${f.field}` : ""}` +
      (f.missing ? `  missing: ${f.missing.join(", ")}` : "") +
      (f.expected !== undefined ? `  expected ${JSON.stringify(f.expected)} got ${JSON.stringify(f.actual)}` : ""));
  }
  if (notes.length) {
    lines.push("", "Notes (labels and extras — translation is allowed to cause these):");
    for (const n of notes) lines.push(`  ${n.kind.padEnd(28)} ${n.object}${n.field ? ` . ${n.field}` : ""}` +
      (n.why ? `  (${n.why})` : "") +
      (n.added ? `  added: ${n.added.join(", ")}` : ""));
  }
  return lines.join("\n");
}
