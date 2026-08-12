// Profile loading and validation.
//
// The schema is the contract that keeps this tool read-only: `actions` is an enum of
// scroll / home / tap:navOnly and nothing else, so there is no representable way to
// ask a run to like, follow, comment, or message. Validating strictly is therefore a
// safety check, not pedantry — a typo that silently disabled a limit would matter.
//
// Supports the subset of JSON Schema draft-07 that profiles/schema.json actually uses.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROFILE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "profiles");

export function listProfiles() {
  return readdirSync(PROFILE_DIR)
    .filter((file) => file.endsWith(".json") && file !== "schema.json")
    .map((file) => file.replace(/\.json$/, ""))
    .sort();
}

/** Load, validate and default-fill a profile. Throws with every problem listed. */
export function loadProfile(name) {
  const path = join(PROFILE_DIR, `${name}.json`);

  let profile;
  try {
    profile = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`no profile "${name}". available: ${listProfiles().join(", ")}`);
    }
    throw new Error(`profile "${name}" is not valid JSON: ${error.message}`);
  }

  const schema = JSON.parse(readFileSync(join(PROFILE_DIR, "schema.json"), "utf8"));
  const errors = [];
  const filled = check(profile, schema, name, errors);

  if (filled.name !== name) {
    errors.push(`declares name "${filled.name}" but lives in ${name}.json — they must match`);
  }
  errors.push(...kindRequirements(filled));

  if (errors.length > 0) {
    throw new Error(`profile "${name}" is invalid:\n  - ${errors.join("\n  - ")}`);
  }
  return filled;
}

/** A mirror profile needs an app and limits; a feed profile needs sources. */
function kindRequirements(profile) {
  const missing = (keys) => keys.filter((key) => !(key in profile));

  if (profile.kind === "mirror") {
    const gaps = missing(["app", "capture", "actions", "abort"]);
    return gaps.map((key) => `kind "mirror" needs "${key}"`);
  }

  if (profile.kind === "feed") {
    if (!profile.sources?.length) return ['kind "feed" needs at least one entry in "sources"'];
    return [];
  }

  return [];
}

function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function typeMatches(value, expected) {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

/** Validate `value` against `schema`, returning a copy with defaults applied. */
function check(value, schema, path, errors) {
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${schema.enum.join(" | ")}, got ${JSON.stringify(value)}`);
    return value;
  }

  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
    return value;
  }

  if (schema.type === "number" || schema.type === "integer") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: ${value} is below the minimum of ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: ${value} is above the maximum of ${schema.maximum}`);
    }
  }

  if (schema.type === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: "${value}" does not match ${schema.pattern}`);
  }

  if (schema.type === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: needs at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: allows at most ${schema.maxItems} item(s)`);
    }
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
      errors.push(`${path}: items must be unique`);
    }
    return schema.items
      ? value.map((item, index) => check(item, schema.items, `${path}[${index}]`, errors))
      : value;
  }

  if (schema.type === "object" || schema.properties) {
    const result = { ...value };

    for (const key of schema.required ?? []) {
      if (!(key in result)) errors.push(`${path}: missing required key "${key}"`);
    }

    const known = schema.properties ?? {};
    for (const [key, entry] of Object.entries(result)) {
      if (known[key]) {
        result[key] = check(entry, known[key], `${path}.${key}`, errors);
      } else if (typeof schema.additionalProperties === "object") {
        result[key] = check(entry, schema.additionalProperties, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unknown key "${key}"`);
      }
    }

    for (const [key, entry] of Object.entries(known)) {
      if (!(key in result) && entry.default !== undefined) {
        result[key] = structuredClone(entry.default);
      } else if (!(key in result) && entry.type === "object" && entry.properties) {
        // Nested optional objects still contribute their own defaults.
        const nested = check({}, entry, `${path}.${key}`, []);
        if (Object.keys(nested).length > 0) result[key] = nested;
      }
    }

    return result;
  }

  return value;
}
