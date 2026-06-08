// Hand-rolled arg parser for the `comote` client CLI. No dependencies.
//
// Splits a verb-noun command path (up to two levels), collects --flags
// (boolean or value), positionals, and key=value pairs (for `config set`).
// Returns { path, flags, positionals, pairs }.
//
// Conventions, modeled on the daemon's existing surface:
//   --flag value      → flags.flag = "value"
//   --flag=value      → flags.flag = "value"
//   --bool            → flags.bool = true   (when no value follows, or value
//                                            looks like the next token/flag)
//   --no-color        → flags.color = false (--no-X negates X)
//   -- (bare)         → everything after is a positional, never a flag
//   field=value       → pairs.field = "value"  (positional that contains '=')
//
// The command path is the leading run of non-flag, non-pair tokens, capped at
// two segments (verb + noun, e.g. `channels status`, `channel <id> config set`
// — note the <id> is a positional, not a path segment, so the path stays the
// two verbs while ids/fields land in positionals).

// Flags that always take the following token as their value, even when that
// token could itself look flag-ish or empty. Keeps `--text ""` and
// `--name -1` working. Everything else uses look-ahead heuristics.
const VALUE_FLAGS = new Set([
  "token",
  "token-file",
  "base-url",
  "state-path",
  "profile",
  "channel",
  "text",
  "name",
  "domain",
  "bot-token-file",
  "limit",
  "offset",
  "secret-stdin",
]);

// Flags that are always booleans (never consume the next token), so
// `comote status --json status` keeps the trailing `status` as a positional.
const BOOLEAN_FLAGS = new Set([
  "json",
  "plain",
  "probe",
  "follow",
  "background",
  "non-interactive",
  "version",
  "help",
]);

function stripLeadingDashes(token) {
  return token.replace(/^--?/, "");
}

function looksLikeFlag(token) {
  return typeof token === "string" && token.startsWith("-") && token !== "-";
}

export function parseArgs(argv) {
  const tokens = Array.isArray(argv) ? argv.slice() : [];
  const path = [];
  const positionals = [];
  const pairs = {};
  const flags = {};

  let pathClosed = false; // once we hit a flag/pair/positional the path is done
  let onlyPositionals = false; // after a bare `--`

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (!onlyPositionals && token === "--") {
      onlyPositionals = true;
      pathClosed = true;
      continue;
    }

    if (!onlyPositionals && looksLikeFlag(token)) {
      pathClosed = true;
      let name = stripLeadingDashes(token);
      let inlineValue = null;

      const eq = name.indexOf("=");
      if (eq !== -1) {
        inlineValue = name.slice(eq + 1);
        name = name.slice(0, eq);
      }

      // --no-foo negates foo, unless it's an explicitly registered boolean
      // (e.g. --no-color / --no-qr / --no-start are their own canonical names).
      if (name.startsWith("no-") && !BOOLEAN_FLAGS.has(name)) {
        const negated = name.slice("no-".length);
        flags[negated] = false;
        continue;
      }

      if (inlineValue !== null) {
        flags[name] = inlineValue;
        continue;
      }

      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
        continue;
      }

      const next = tokens[i + 1];
      const wantsValue = VALUE_FLAGS.has(name);
      if (wantsValue) {
        // Consume the next token as the value even if absent (→ "").
        flags[name] = next === undefined ? "" : next;
        if (next !== undefined) {
          i += 1;
        }
        continue;
      }

      // Unknown flag: consume a following non-flag token as its value,
      // otherwise treat as a boolean. This keeps the parser permissive for
      // command-specific flags without a central registry.
      if (next !== undefined && !looksLikeFlag(next)) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }

    // key=value pair (e.g. `config set botToken=abc`).
    if (!onlyPositionals && token.includes("=") && !looksLikeFlag(token)) {
      const eq = token.indexOf("=");
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (key) {
        pairs[key] = value;
        pathClosed = true;
        continue;
      }
    }

    // Plain token: extends the command path until the path is closed or full,
    // then becomes a positional.
    if (!pathClosed && path.length < 2) {
      path.push(token);
    } else {
      positionals.push(token);
      pathClosed = true;
    }
  }

  return { path, flags, positionals, pairs };
}
