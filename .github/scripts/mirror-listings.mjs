/**
 * Build the compact listings mirror the Worker's cron reads.
 *
 * WHY THIS EXISTS AT ALL — the constraint, stated once.
 *
 * The Apply board is fed by SimplifyJobs/Summer2027-Internships, whose
 * `listings.json` is 10.7 MB and 14,375 entries. The Worker cannot read that
 * file. Cloudflare's free plan gives a cron invocation 10 ms of CPU, and
 * `JSON.parse` on 10.7 MB is two orders of magnitude past it — the invocation is
 * killed mid-parse, every minute, forever, and the board never fills.
 *
 * The parse has to happen somewhere with a real CPU budget, and a GitHub Action
 * is the cheapest such place this repo already owns. So the work splits:
 *
 *   here (every 15 min, GitHub)   fetch 10.7 MB, filter, compact, commit ~200 KB
 *   the Worker (every minute)     conditional GET of the ~200 KB, parse, upsert
 *
 * 200 KB parses in about a millisecond, and on the overwhelmingly common tick
 * upstream answers 304 and the Worker parses nothing at all.
 *
 * WHERE THE OUTPUT GOES, AND WHY IT IS A BRANCH.
 *
 * `listings-data` — an ORPHAN branch of this same repo, holding one file and no
 * history in common with master. A branch rather than a release asset or a
 * gist because it needs no credential to read, it is versioned, and a bad
 * mirror can be reverted with `git revert`. Orphan because the mirror has
 * nothing to do with the source tree: sharing history would mean every listings
 * commit shows up in `git log` for master's files.
 *
 * It cannot trigger a deploy: .github/workflows/deploy.yml is
 * `on: push: branches: [master]`, so a push to `listings-data` matches nothing.
 * That is load-bearing — this branch is written up to 96 times a day.
 *
 * WHY THE SNAPSHOT CARRIES NO TIMESTAMP.
 *
 * The obvious `generatedAt` field would make every run produce a different file,
 * so every run would commit, so the Worker would re-parse and re-diff 96 times a
 * day to learn nothing. Without it, "did anything change?" is a byte comparison
 * and an unchanged upstream costs one commit that never happens. The commit's
 * own timestamp records when it was built, which is the same fact in the place
 * git already keeps it.
 *
 * For the same reason the listings are SORTED BY ID before writing. Upstream's
 * array order is not stable, and an unsorted mirror would report a change
 * whenever two entries swapped places.
 *
 * NO DEPENDENCIES, AND NOT TYPESCRIPT. This runs on a bare `actions/setup-node`
 * with no `npm install`, so it uses Node built-ins only. That means the compact
 * shape is declared here and again on the consumer side in
 * apps/mcp/src/listings/mirror.ts — a duplication worth naming rather than
 * hiding. It is pinned by a test rather than by discipline:
 * test/the-mirror-writes-what-the-worker-reads.test.ts runs `selectListings`
 * over a fixture and feeds its output to the Worker's own parser, so the two
 * shapes cannot drift without a red suite.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PAY_CURRENCIES, PAY_PERIODS } from "./pay-text.mjs";

/** Where upstream publishes the full board. */
export const UPSTREAM_URL =
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json";

/** The one term this mirror carries. */
export const SEASON = "Summer 2027";

/**
 * Upstream category spellings, folded to the five this board carries.
 *
 * Upstream has renamed its categories at least once and did not backfill, so
 * both the current short names and the legacy long ones are live in the same
 * file. Measured against the real 14,375 entries:
 *
 *   "AI/ML/Data"                           6168
 *   "Software"                             4420
 *   "Hardware"                             2190
 *   "Product"                               968
 *   "Quant"                                 379
 *   "Software Engineering"                  158   <- legacy
 *   "Data Science, AI & Machine Learning"    86   <- legacy
 *   "Hardware Engineering"                    3   <- legacy
 *   "Quantitative Finance"                    2   <- legacy
 *   "Product Management"                      1   <- legacy
 *
 * The legacy spellings are not a rounding error: dropping "Software
 * Engineering" alone would silently lose 158 postings, one of them in Summer
 * 2027 today. A folding map rather than a substring test, because "Quantitative
 * Finance" contains neither of the words a substring test would key on and
 * "Data Science, AI & Machine Learning" contains "Data" — which would also
 * match nothing sensible if the rule were reversed.
 *
 * NOTHING is deliberately absent any more. The board used to carry only the
 * two CS categories and drop Quant, Hardware and Product at mirror time; the
 * exclusion turned out to be the wrong layer. The board carries every category
 * upstream offers for the season, every row keeps its folded category, and the
 * FILTERS — the landing page's category control, the dashboard's category
 * chips — are what narrow the view. A filter can be widened with one click; a
 * mirror-time exclusion cannot.
 */
export const CATEGORY_MAP = new Map([
  ["Software", "software"],
  ["Software Engineering", "software"],
  ["AI/ML/Data", "ai-ml-data"],
  ["Data Science, AI & Machine Learning", "ai-ml-data"],
  ["Product", "product"],
  ["Product Management", "product"],
  ["Quant", "quant"],
  ["Quantitative Finance", "quant"],
  ["Hardware", "hardware"],
  ["Hardware Engineering", "hardware"],
]);

/**
 * Is this upstream entry one this board carries?
 *
 * `terms` is an array because a posting can be open for several terms at once.
 * `includes` rather than `[0] ===` for that reason: a Summer 2026 + Summer 2027
 * posting is a Summer 2027 posting.
 *
 * `active` is NOT part of this test. A closed posting still belongs in the
 * mirror, because the Worker marks vanished listings inactive rather than
 * deleting them — and it can only do that for ids it still sees. Drop the
 * inactive ones here and every closure looks to the Worker like a listing that
 * vanished, which is the same row, reached by a worse path.
 */
export function isWanted(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (!Array.isArray(entry.terms) || !entry.terms.includes(SEASON)) return false;
  if (!CATEGORY_MAP.has(entry.category)) return false;
  // `is_visible` is upstream's own "should anyone see this" flag; a hidden entry
  // is one they are not showing, and mirroring it would show it anyway.
  if (entry.is_visible === false) return false;
  // An entry with no id cannot be diffed, deduplicated or addressed by the API.
  return typeof entry.id === "string" && entry.id.length > 0;
}

/** A string, trimmed, or undefined when there is nothing worth carrying. */
function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Unix SECONDS as upstream gives them, or undefined. Not milliseconds — see mirror.ts. */
function seconds(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Hosts that are a job board rather than an employer.
 *
 * Upstream's `company_url` is not the company's website. Measured against the
 * live feed: 356 of the 357 active Summer 2027 entries this mirror selects give
 * a `https://simplify.jobs/c/<slug>` page — upstream's OWN listing for that
 * company, not the employer's. Carried verbatim, that field is what the Apply
 * board hyperlinks every company name to, so the board's most obvious click
 * sends the user to a competing product.
 *
 * The posting `url` is a different field and is fine: those are direct employer
 * application links (greenhouse, lever, workday, careers pages), zero of them
 * simplify.jobs. Only the company link is affected, and only this way.
 *
 * The answer is to DROP the field, not to replace it. There is no employer
 * website in the feed to substitute, and guessing one from the company name
 * would put a link on the row that nobody verified. A company with no link is
 * rendered as plain text, which is the truth: we do not know where their site
 * is.
 *
 * A list rather than a single constant because the same reasoning applies to
 * the next aggregator upstream starts pointing at, and adding one should be one
 * line here plus one in the consumer. It is deliberately SHORT: this is the set
 * of hosts that could never be an employer's own site, not a quality filter.
 */
export const AGGREGATOR_HOSTS = ["simplify.jobs"];

/**
 * Is this host one of the aggregators, or a subdomain of one?
 *
 * Suffix match on a DOT boundary rather than `includes`, for the reason
 * packages/ats' host-detection test spells out: a bare substring test makes
 * `simplify.jobs.evil.com` match and `notsimplify.jobs` match too. Neither is
 * the host we mean.
 */
export function isAggregatorHost(host) {
  const h = String(host ?? "").toLowerCase();
  return AGGREGATOR_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
}

/**
 * A company link worth carrying, or undefined.
 *
 * Non-http(s) and unparseable strings are dropped here as well. They can never
 * be rendered as a company link anyway — the web row gates every href through
 * `isSafeHttpUrl` — and a field the consumer must always re-check is a field
 * that will eventually be used without re-checking.
 */
export function employerUrl(value) {
  const raw = text(value);
  if (!raw) return undefined;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return isAggregatorHost(url.hostname) ? undefined : raw;
}

/**
 * Query parameters that name who sent the click, when the answer is Simplify.
 *
 * Zero of the current 357 postings carry one. This exists so that stays true:
 * upstream owns the file, an attribution parameter is a one-line change on
 * their side, and it would arrive silently — every application our users send
 * would credit another product, and the only evidence would be a query string
 * nobody reads. The test pins it now, while the answer is cheap.
 *
 * Matched by NAME AND VALUE. `ref` is an ordinary parameter that employers use
 * for their own purposes (`ref=careers`, `ref=university`), and stripping every
 * `ref` would corrupt an application URL to fix a problem it does not have.
 */
export const TRACKING_PARAMS = ["utm_source", "ref"];
const TRACKING_VALUE = "simplify";

/**
 * Query parameters that break the page they are carried into.
 *
 * `?mobile=true` on an iCIMS posting (Kimley-Horn, live in the feed) forces
 * the phone layout on a desktop browser — a broken, narrow page behind our own
 * Apply link — and `needsRedirect` is the same vendor's routing flag riding
 * alongside it. Both describe the CLICK that harvested the URL, not the
 * posting, so they are stripped by NAME alone, unlike the tracking pair above.
 *
 * An allowlist of junk, never "all params": a query string is where a
 * posting's identity often lives (`gh_jid`, `token`, plain ids), and stripping
 * one of those would point the row at a different or dead page.
 */
export const JUNK_PARAMS = ["mobile", "needsredirect"];

/**
 * The posting URL, with any Simplify attribution and any junk parameter
 * removed.
 *
 * An unparseable URL is returned UNCHANGED rather than dropped: unlike the
 * company link, the posting link is the whole point of the row, the web layer
 * already refuses to render an unsafe one, and "Apply with Claude" falls back to
 * the role and the company. Losing a posting link to fix a parameter it
 * does not have would be the wrong trade.
 *
 * The URL is only rebuilt when something was actually removed, so an ordinary
 * link crosses this function byte-for-byte — no re-encoding, no reordered
 * parameters, no snapshot churn.
 */
export function cleanPostingUrl(value) {
  const raw = text(value);
  if (!raw) return undefined;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const isTracking = (name, v) =>
    TRACKING_PARAMS.includes(name.toLowerCase()) && v.trim().toLowerCase() === TRACKING_VALUE;
  let removed = false;
  const kept = new URLSearchParams();
  for (const [name, v] of url.searchParams) {
    if (isTracking(name, v) || JUNK_PARAMS.includes(name.toLowerCase())) removed = true;
    else kept.append(name, v);
  }
  if (!removed) return raw;
  // Assigning "" drops the "?" as well, so a URL whose only parameter was the
  // tracking one comes back clean rather than with a dangling question mark.
  url.search = kept.toString();
  return url.toString();
}

/**
 * The audience a posting's `degrees` field restricts it to, as a title tail —
 * "(PhD)", "(Masters)", "(Masters/PhD)" — or undefined for everyone else.
 *
 * The qualifier is REAL INFORMATION THE TITLE WAS SILENTLY LOSING. Upstream's
 * own board renders "…2027 Start (PhD)" by joining the title with `degrees`;
 * this mirror dropped the field, so TikTok's PhD-only research roles read as
 * open internships and a sophomore clicked into a role that would never take
 * them. Measured against the live feed: 54 of the 395 selected rows are
 * restricted to graduate degrees.
 *
 * Appended ONLY when the restriction is total — every named degree is a
 * graduate one. A posting listing Bachelor's at all is open to undergrads,
 * which is this board's default reader, and stamping "(BS/MS)" on the ~300
 * rows that say so would be noise stating the norm. An empty list or an
 * unrecognised value ("Incomplete" occurs) appends nothing: no claim beyond
 * what the feed states. And a title that already names the audience — "PhD
 * Data Scientist Intern" is live in the feed — is left alone rather than
 * told twice.
 *
 * EXPORTED so the consumer side can be pinned against it. Nothing in this file
 * needs the export — apps/mcp/test/the-degrees-nobody-can-enrol-in.test.ts
 * does, to assert that every label this map can stamp onto a title is one the
 * board's "Hide Master's / PhD roles" filter recognises. A fourth graduate
 * degree added here must not reach the board as a qualifier the filter cannot
 * read, which is a posting a student is shown and cannot apply to.
 */
export const GRADUATE_DEGREES = new Map([
  ["Master's", "Masters"],
  ["MBA", "MBA"],
  ["PhD", "PhD"],
]);

export function withDegreeQualifier(title, degrees) {
  if (!title || !Array.isArray(degrees) || degrees.length === 0) return title;
  if (!degrees.every((d) => GRADUATE_DEGREES.has(d))) return title;
  if (/\b(phd|master|mba|doctora)/i.test(title)) return title;
  // Map order, not input order, so the same set of degrees always writes the
  // same title and the snapshot's byte-comparison determinism holds.
  const labels = [...GRADUATE_DEGREES.entries()]
    .filter(([degree]) => degrees.includes(degree))
    .map(([, label]) => label);
  return `${title} (${labels.join("/")})`;
}

/**
 * One upstream entry, reduced to what the board needs.
 *
 * Upstream carries fields this surface has no use for — `degrees` (folded
 * into the title tail above before it goes), `terms` (constant after the
 * filter), `is_visible` (constant after the filter), and a `source` that is
 * always "Simplify". Dropping them is most of the 10.7 MB → 200 KB reduction,
 * and each one dropped is a field the Worker never has to decide what to do
 * with.
 *
 * Keys are omitted rather than set to null when absent. `JSON.stringify` drops
 * an `undefined` value entirely, which is both smaller and unambiguous: the
 * consumer's "is there a URL?" is `url === undefined`, with no second empty-string
 * spelling to remember.
 *
 * The two link fields are the two that are NOT carried verbatim. `company_url`
 * is upstream's own company page for all but one active entry and is dropped
 * (see `employerUrl`); the posting `url` loses any Simplify attribution
 * parameter and any junk parameter (see `cleanPostingUrl`). Both rules are re-stated on the
 * consumer side and pinned by
 * test/the-mirror-writes-what-the-worker-reads.test.ts, so a stale mirror on the
 * `listings-data` branch is not a hole either.
 */
/**
 * What a scanned posting adds to its mirror row, or nothing at all.
 *
 * THREE FIELDS, AND THE RULE BETWEEN THEM.
 *
 *   sponsorshipDerived    "no_sponsorship" | "citizenship_required". Present
 *                         ONLY when the posting states a barrier. Its ABSENCE is
 *                         deliberately ambiguous — it means "no barrier found"
 *                         and "not scanned yet" at once — because the honest
 *                         version of the second is not a status, it is the
 *                         missing timestamp below.
 *   sponsorshipEvidence   The sentence, verbatim. Present if and only if
 *                         `sponsorshipDerived` is, enforced here rather than
 *                         hoped for: a status with no sentence is a claim the
 *                         user cannot check, and this board tells a student they
 *                         may not apply for something. If the evidence went
 *                         missing, the status goes with it.
 *   sponsorshipScannedAt  Unix SECONDS the posting was last successfully READ.
 *                         Absent when it never was. This is what separates "we
 *                         looked and found nothing" from "we never looked", and
 *                         it is the only field that can.
 *
 * `open` is NEVER written as a derived status. It is what a posting with no
 * barrier produces and also what an empty JavaScript shell produces — see
 * MIN_READABLE_CHARS in scan-sponsorship.mjs — so writing it would put the two
 * on the same row. The scanner records shells as `unread`, and an unread posting
 * gets no timestamp here either.
 *
 * Upstream's own `sponsorship` note is untouched by all of this. It is a
 * different fact from a different source, it is what `normalizeSponsorship`
 * reads, and it stays exactly as upstream wrote it — currently the literal
 * string "Other" on all 864 rows, which is the reason this file gained three
 * fields.
 *
 * Seconds, not milliseconds, because every other timestamp in the mirror is —
 * see the MirrorListing docblock in apps/mcp/src/listings/mirror.ts.
 */
export const DERIVED_STATUSES = new Set(["no_sponsorship", "citizenship_required"]);

export function sponsorshipFields(scan) {
  if (!scan || typeof scan !== "object") return {};
  const fields = {};

  const scannedAt = seconds(scan.scannedAt);
  if (scannedAt !== undefined && scan.status !== "unread") fields.sponsorshipScannedAt = scannedAt;

  const evidence = text(scan.evidence);
  if (DERIVED_STATUSES.has(scan.status) && evidence) {
    fields.sponsorshipDerived = scan.status;
    fields.sponsorshipEvidence = evidence;
  }
  return fields;
}

/**
 * What a posting that talks to the reader adds to its mirror row.
 *
 * TWO FIELDS, PRESENT ONLY WHEN THE POSTING IS FLAGGED, and paired the way the
 * sponsorship verdict is paired with its sentence:
 *
 *   injection          `true`, never `false`. A row that is not flagged carries
 *                      no key at all, so the mirror's bytes for the five
 *                      hundred ordinary postings are exactly what they were
 *                      before this feed existed — which is what keeps the
 *                      workflow's "did anything change?" a byte comparison.
 *   injectionSnippets  up to three passages of the posting's own words, each at
 *                      most 200 characters. Written together with the flag and
 *                      never without it: a warning whose text nobody can read
 *                      is a claim nobody can check, and this one asks a user to
 *                      open a posting with suspicion. If the snippets went
 *                      missing the flag goes with them.
 *
 * The scan entry's `injection: false` is deliberately NOT carried. Absence here
 * means "not flagged" and "never read" at once, exactly as `sponsorshipDerived`'s
 * absence does, and for the same reason: neither is a warning, every reader
 * treats them alike, and `sponsorshipScannedAt` beside it is the one field that
 * tells them apart.
 */
export function injectionFields(scan) {
  if (!scan || typeof scan !== "object") return {};
  if (scan.injection !== true) return {};
  const snippets = Array.isArray(scan.injectionSnippets)
    ? scan.injectionSnippets.filter((s) => typeof s === "string" && s.trim()).slice(0, 3)
    : [];
  if (snippets.length === 0) return {};
  return { injection: true, injectionSnippets: snippets };
}

/**
 * What a posting that STATES A RATE adds to its mirror row.
 *
 * FIVE FIELDS, ALL PRESENT OR NONE, and the pairing is the same discipline
 * `sponsorshipFields` keeps for its verdict and its sentence:
 *
 *   payMin, payMax   the amounts exactly as the posting stated them, equal for a
 *                    single figure. Numbers, not strings, because the consumer
 *                    computes a monthly equivalent from them.
 *   payPeriod        "hour" | "week" | "month" | "year" — as WORDED, never
 *                    converted. The row prints "$35–45/hr" because that is what
 *                    the posting says; a monthly figure nobody wrote is a number
 *                    the user cannot check against the page.
 *   payCurrency      an ISO code. Stored and shown for every currency; only USD
 *                    is ever compared against a threshold downstream.
 *   payEvidence      the sentence, verbatim. Present with the numbers or not at
 *                    all, on the argument 0010 and 0027 make about a sponsorship
 *                    clause and which applies exactly here: this figure HIDES a
 *                    job, and a number the student cannot read the sentence
 *                    behind is a claim nobody can check.
 *
 * ABSENT WHEN THE SCAN FOUND NOTHING, exactly as `sponsorshipDerived` is absent,
 * and ambiguous in the same deliberate way: no rate stated, or the posting not
 * read yet. Neither is a low rate, so no reader has to tell them apart — a
 * listing with no pay data is never hidden by a pay floor.
 *
 * The cache entry's `pay: null` is not carried, for the reason `injection:
 * false` is not: writing it would put a key on every one of 1,300 ordinary rows
 * and change the mirror's bytes for nothing, and the workflow's "did anything
 * change?" is a byte comparison.
 */
export function payFields(scan) {
  if (!scan || typeof scan !== "object") return {};
  const pay = scan.pay;
  if (!pay || typeof pay !== "object") return {};

  const min = Number(pay.min);
  const max = Number(pay.max);
  const period = text(pay.period);
  const currency = text(pay.currency);
  const evidence = text(pay.evidence);
  // Every half checked here rather than trusted from the cache: this file reads
  // a JSON file written by a different script on a branch rewritten 96 times a
  // day, and a half-written figure is exactly the shape that would reach the
  // column as a number with no sentence behind it.
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return {};
  if (!PAY_PERIODS.includes(period)) return {};
  if (!PAY_CURRENCIES.includes(currency)) return {};
  if (!evidence) return {};

  return {
    payMin: min,
    payMax: max,
    payPeriod: period,
    payCurrency: currency,
    payEvidence: evidence,
  };
}

export function compact(entry, scan) {
  return {
    id: entry.id,
    company: text(entry.company_name) ?? "",
    title: withDegreeQualifier(text(entry.title) ?? "", entry.degrees),
    category: CATEGORY_MAP.get(entry.category),
    url: cleanPostingUrl(entry.url),
    companyUrl: employerUrl(entry.company_url),
    locations: Array.isArray(entry.locations)
      ? entry.locations.filter((l) => typeof l === "string" && l.trim()).map((l) => l.trim())
      : [],
    sponsorship: text(entry.sponsorship),
    active: entry.active === true,
    postedAt: seconds(entry.date_posted),
    updatedAt: seconds(entry.date_updated),
    // Spread, not assigned, so an unscanned listing's row has no scan keys at
    // all rather than three `undefined` ones. That is not cosmetic: it is what
    // keeps the shape of a row identical to what it was before this feed
    // existed, so a stale mirror and a fresh one parse the same way.
    ...sponsorshipFields(scan),
    // Same spread, same reason: a posting nobody flagged carries no injection
    // key at all rather than two undefined ones.
    ...injectionFields(scan),
    // Same spread, same reason again: a posting that stated no rate carries no
    // pay key at all, so the bytes of the ~1,300 rows that state nothing are
    // exactly what they were before this feed existed.
    ...payFields(scan),
  };
}

/**
 * The whole upstream file, reduced to this board's listings, sorted by id.
 *
 * Sorted for the reason the header gives: upstream's order is not stable, and an
 * unsorted mirror reports a change every time two entries swap places. The sort
 * key is the id rather than the date because the id never changes.
 *
 * A duplicate id keeps the LAST occurrence. Upstream has not produced one, but
 * the alternative is two rows the Worker's upsert would resolve arbitrarily, and
 * "the later entry wins" is at least a rule.
 *
 * `scanCache` is what .github/scripts/scan-sponsorship.mjs read out of the
 * postings themselves, keyed by the same listing id, and it is OPTIONAL. Omit it
 * — as every test that predates the scanner does, and as a run on a branch with
 * no cache file yet does — and the mirror is byte-identical to what it always
 * was. The scan adds fields; it can never take one away.
 */
export function selectListings(raw, scanCache) {
  if (!Array.isArray(raw)) throw new Error("upstream listings.json is not an array");
  const scans = (scanCache && scanCache.entries) || {};
  const byId = new Map();
  for (const entry of raw) {
    if (!isWanted(entry)) continue;
    byId.set(entry.id, compact(entry, scans[entry.id]));
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The file that gets committed.
 *
 * `version` so a future shape change is detectable by the consumer rather than
 * inferred from a missing field; `count` so a truncated file is obvious without
 * parsing the array.
 *
 * One line, no indentation. Indenting 356 objects costs about 40 KB for the
 * benefit of a diff nobody reads — the branch holds one machine-written file and
 * the review surface is this script, not its output.
 */
export function buildSnapshot(listings) {
  return `${JSON.stringify({ version: 1, season: SEASON, count: listings.length, listings })}\n`;
}

/**
 * Should this snapshot be committed?
 *
 * Byte equality, which is only meaningful because the snapshot is deterministic
 * — no timestamp, sorted listings. See the header.
 */
export function isUnchanged(previous, next) {
  return previous === next;
}

/* ─────────────────────────────────── CLI ─────────────────────────────────── */

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * The sponsorship scan cache, or nothing.
 *
 * Read defensively on purpose. This file is written by a different script on a
 * branch that is rewritten 96 times a day, and every way it can be wrong —
 * absent, truncated mid-push, a shape from a future revision — has the same
 * correct answer here: carry no derived sponsorship this run. The mirror is what
 * the board is made of, and it does not get to fail because an optional
 * enrichment did.
 */
function readScanCache(path) {
  if (!path) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed.entries === "object" && parsed.entries ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function readUpstream(url, input) {
  if (input) return JSON.parse(readFileSync(input, "utf8"));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`upstream answered ${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const out = arg("out") ?? "listings.json";
  const raw = await readUpstream(arg("url") ?? UPSTREAM_URL, arg("input"));

  // The scan cache, if the branch has one. A missing or unreadable file is not
  // an error: it is the first run, or the run after a scan that failed, and both
  // must still produce a mirror. Losing three optional fields is a filter that
  // shows fewer barriers for fifteen minutes; failing here is a board with no
  // postings on it.
  const scanCache = readScanCache(arg("scan-cache"));

  const listings = selectListings(raw, scanCache);
  const snapshot = buildSnapshot(listings);
  const bytes = Buffer.byteLength(snapshot, "utf8");

  let previous = "";
  try {
    previous = readFileSync(out, "utf8");
  } catch {
    // No mirror yet — the first run on a fresh branch. Treated as "changed".
  }
  const unchanged = isUnchanged(previous, snapshot);

  const upstreamCount = Array.isArray(raw) ? raw.length : 0;
  const active = listings.filter((l) => l.active).length;
  // `scanned` and `barred` are the two numbers that say whether the sponsorship
  // filter has an input yet. Before this feed existed both were structurally
  // zero — 864 listings, one distinct upstream value, every row `open`.
  const scanned = listings.filter((l) => l.sponsorshipScannedAt !== undefined).length;
  const barred = listings.filter((l) => l.sponsorshipDerived !== undefined).length;
  // The third number the scan produces, and the one the pay floor has an input
  // from. Structurally zero before this feed existed: there is no pay field
  // anywhere upstream.
  const paid = listings.filter((l) => l.payPeriod !== undefined).length;
  console.log(
    `upstream=${upstreamCount} selected=${listings.length} active=${active} ` +
      `scanned=${scanned} barriers=${barred} pay=${paid} bytes=${bytes} unchanged=${unchanged}`,
  );

  if (!unchanged && !dryRun) writeFileSync(out, snapshot);
  if (dryRun) console.log(`dry run — ${out} not written`);

  // Consumed by the workflow's `if:` on the commit step. Without this the job
  // would commit on every run and produce 96 empty commits a day.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `changed=${unchanged ? "false" : "true"}\ncount=${listings.length}\nbytes=${bytes}\n` +
        `scanned=${scanned}\nbarriers=${barred}\npay=${paid}\n`,
    );
  }
}

// Only when run as a program. The test imports this module for the pure
// functions above and must not fetch 10.7 MB to get them — a bare `await main()`
// here would make importing it a network call.
//
// Compared as resolved file URLs rather than by matching the basename: two
// scripts with the same filename in different directories are not the same
// module, and a substring check on argv[1] gets that wrong in the direction that
// runs the program by surprise.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
