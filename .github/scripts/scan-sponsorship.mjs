/**
 * Read each posting and record whether it states a sponsorship barrier.
 *
 * WHY THIS RUNS HERE AND NOT IN THE WORKER.
 *
 * The same reason the mirror does, stated in mirror-listings.mjs: upstream's
 * listings.json is 10.7 MB and a free-plan cron invocation gets 10 ms of CPU, so
 * the parse moved to a runner that has minutes. Fetching job descriptions has
 * the identical shape and is worse — this reads HUNDREDS of third-party pages,
 * each one a network round trip to a host we do not control, some of which time
 * out and some of which answer 403. None of that belongs on a 10 ms budget, and
 * a Worker that spent its cron subrequests on Workday would have none left for
 * the mirror it exists to ingest. So it runs beside the mirror, on the runner,
 * and the ANSWER travels in the mirror file instead of the work.
 *
 * WHY THE FACT HAS TO COME FROM THE POSTING.
 *
 * `listings.sponsorship` carries upstream's note and the Apply tab has a "hide
 * sponsorship barriers" filter that reads it. Measured against production on 21
 * August 2026: 864 listings, ONE distinct value — the literal string "Other",
 * which upstream's Simplify scraper writes for every entry it produces — and all
 * 864 normalise to `open`. Upstream's full 14,495 entries do hold 109 real
 * sponsorship values, and not one of them belongs to a Summer 2027 posting;
 * every one was typed by a human contributor filing an entry by hand. The filter
 * was never broken. It has never had an input.
 *
 * The posting itself is the input. Measured on a sample of 90 live postings from
 * this board: 76 returned readable text and 13 of those carried a real barrier.
 * That is the filter's first non-empty day.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT.
 *
 * WHAT ONE CACHE ENTRY HOLDS, since three questions are now asked of one fetch:
 *
 *   status, evidence              the sponsorship verdict and its sentence
 *                                 (./sponsorship-text.mjs).
 *   injection, injectionSnippets  text addressed to the READER rather than the
 *                                 applicant, and the passages behind it
 *                                 (./injection-text.mjs).
 *   pay                           what the posting says it pays — `{min, max,
 *                                 period, currency, evidence}` or null
 *                                 (./pay-text.mjs). Null is written on every
 *                                 read, including the ones that found nothing,
 *                                 for the reason `injection: false` is: a
 *                                 posting read today and found to state no rate
 *                                 is a different fact from one nobody has read.
 *   scannedAt, checkedAt          when it was last READ, and when it was last
 *                                 TRIED. The pair that tells a clean posting
 *                                 from an unreachable one.
 *
 * All three come out of ONE round trip, which is the whole reason they share a
 * scanner: the fetch is the expensive half, and a second job asking a second
 * question of the same hosts would double the cost of somebody else's bandwidth
 * to learn something we are already holding the bytes for.
 *
 *   The verdict is not ours.   `classifyPostingText` in sponsorship-text.mjs
 *                              owns every rule, and it is deliberately written
 *                              to MISS rather than guess, because a false
 *                              `no_sponsorship` hides a posting from precisely
 *                              the student who needed it. Nothing here loosens
 *                              that; this file only decides WHAT TEXT the rule
 *                              is asked about.
 *
 *   Unread is not open.        A Workday page fetched as HTML is a JavaScript
 *                              shell that strips to about one character, and
 *                              `classifyPostingText("")` is `open` — the same
 *                              answer a posting with no barrier gives. Conflate
 *                              them and the board claims to have checked 864
 *                              postings it never read. Text under
 *                              MIN_READABLE_CHARS is recorded as `unread`, kept
 *                              out of the mirror entirely, and retried.
 *
 *   The door before the        Which is a reason to knock somewhere else, not
 *   fetch.                     to accept the shell. ./posting-readers.mjs maps a
 *                              posting URL to the PUBLIC endpoint that ATS's own
 *                              front end reads — Ashby, Greenhouse, Lever,
 *                              Workday, SmartRecruiters, iCIMS — and everything
 *                              downstream is untouched: same stripper, same
 *                              three classifiers, same readable floor. Measured
 *                              8 September 2026, that shell was 561 of 1,931
 *                              postings and 54 of 54 Ashby rows. A reader that
 *                              fails falls through to the HTML fetch and then to
 *                              `unread`; it can never produce a verdict of its
 *                              own.
 *
 *   Somebody else's server.    A descriptive User-Agent naming the product and a
 *                              way to reach us, a small delay between requests,
 *                              a per-request timeout, four requests in flight at
 *                              once, a whole-run wall clock, and a host that
 *                              answers 429 or 403 is dropped for the rest of the
 *                              run rather than asked again 40 more times.
 *
 *   One bad host is not a      Every failure is caught per request. There is no
 *   bad run.                   path from a timeout, a 500, a redirect loop or an
 *                              unparseable body to a non-zero exit — the cache
 *                              is written with whatever was learned and the
 *                              mirror, which is the thing users actually see, is
 *                              never held hostage to a careers page being down.
 *
 * NO DEPENDENCIES, NOT TYPESCRIPT, for the same reason as the mirror: this runs
 * on a bare `actions/setup-node` with no install step. Everything that does not
 * touch the network is exported so tests can drive it over plain values —
 * apps/mcp/test/a-posting-is-read-before-it-is-believed.test.ts makes no network
 * call at all.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { classifyPostingText } from "./sponsorship-text.mjs";
import { scanForInjection } from "./injection-text.mjs";
import { extractPay } from "./pay-text.mjs";
import { READER_NAMES, isWorkdayHost, postingReader, workdayCxsUrl } from "./posting-readers.mjs";

/**
 * Re-exported so the shape of this module does not change under its callers.
 *
 * Both used to be DEFINED here, back when Workday was the only ATS with a door
 * other than its HTML. It has company now — see ./posting-readers.mjs — and the
 * mapping moved there with the rest, but a test and a reader of this file both
 * reasonably expect to find them where they have always been.
 */
export { isWorkdayHost, postingReader, workdayCxsUrl };

/**
 * How many postings one run is allowed to fetch.
 *
 * 60 against a 15-minute cron. The board carries 864 listings, so a cold cache
 * fills in 864 / 60 ≈ 15 runs ≈ 3h45m, and after that a run has only the
 * postings that are new or stale to look at — typically a handful, often none.
 * Higher would finish the first pass sooner and cost more of somebody else's
 * bandwidth per quarter hour for the rest of time; lower stretches the cold
 * start past a working day. This is the knob to turn if either becomes the
 * complaint.
 */
export const SCAN_LIMIT = 60;

/**
 * The most `--limit` may ask for, however it is dispatched.
 *
 * THE 7-MINUTE STEP CEILING IS NOT HELD BY THIS NUMBER, and that is worth saying
 * first because it is the thing a bigger limit looks like it could break.
 * `scanPostings` checks `SCAN_BUDGET_MS` (5 minutes) BEFORE each fetch and
 * returns what it has, and the longest a request already in flight can add is
 * one `REQUEST_TIMEOUT_MS` — twice that on a Workday row, which spends a request
 * on CXS before falling back to HTML. So the step's worst case is about 5m30s
 * whatever `--limit` says, comfortably inside the `timeout-minutes: 7` in
 * listings-mirror.yml, and a limit larger than the budget can finish simply
 * means the run stops early and writes what it learned. That is already the
 * ordinary path.
 *
 * What the cap is for is HONESTY about the other end of the pipe. Four workers
 * against a 5-minute wall clock, at the delay and timeout above, is somewhere
 * between ~80 postings (the pathological case where every host burns the full
 * 15-second timeout) and ~800 (a fast mix at the 250 ms floor). 400 sits inside
 * that range, so a dispatch asking for it is asking for something a run can
 * plausibly deliver rather than a number that will silently be cut in half every
 * time. Higher would be a request the budget cannot honour; the way to go faster
 * is another dispatch, not a larger number.
 */
export const MAX_SCAN_LIMIT = 400;

/**
 * `--limit N`, clamped, or the scheduled default.
 *
 * Anything unreadable falls back to `SCAN_LIMIT` rather than erroring: this is
 * driven from a `workflow_dispatch` input, where an empty box arrives as an
 * empty string, and a run that refused to scan because somebody left a field
 * blank would be a worse outcome than one that scanned sixty.
 */
export function readLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return SCAN_LIMIT;
  return Math.min(Math.floor(n), MAX_SCAN_LIMIT);
}

/**
 * How long a verdict is trusted before the posting is read again.
 *
 * A job description is edited rarely and a closed posting stops mattering, so
 * re-reading everything on a loop would be hundreds of requests a day to learn
 * nothing. Fourteen days means a posting whose text changed is wrong for at most
 * a fortnight, against a board where the median listing is answered in days.
 */
export const RESCAN_AFTER_SECONDS = 14 * 24 * 60 * 60;

/**
 * How long before a posting we COULD NOT READ is tried again.
 *
 * Shorter than a real verdict's life, because "unread" is not an answer about
 * the posting — it is an answer about the fetch, and fetches recover. A 403 from
 * one tenant, a slow host, a page mid-deploy: three days later is a different
 * roll of the dice. Not shorter still, because a JavaScript shell with no CXS
 * endpoint will never become readable and would otherwise hold a slot forever.
 */
export const RETRY_UNREAD_AFTER_SECONDS = 3 * 24 * 60 * 60;

/**
 * Below this many characters, a fetch did not read the posting.
 *
 * Measured: a Workday page fetched as HTML strips to ~1 character, and the
 * shortest REAL description in the 76-posting sample was several thousand.
 * 400 sits in an empty gulf between the two — nothing plausible is near it — and
 * the failure it prevents is the one that matters, since text this rule cannot
 * read classifies as `open`, which is indistinguishable from a posting that
 * genuinely has no barrier.
 */
export const MIN_READABLE_CHARS = 400;

/**
 * Bumped when the classifier or the extraction changes.
 *
 * A cached verdict records the revision that produced it; a run under a newer
 * revision treats every older entry as never-scanned and reads the board again.
 * Without this, a fixed rule would only ever apply to postings added after the
 * fix, and the board would hold two generations of answer with no way to tell
 * them apart.
 */
// 2: entities decode to a fixed point and invisible characters are stripped.
// The first live run's only citizenship bar carried a literal `&#xa;&#xa;` into
// its evidence; the verdict was right and the sentence was not, and the
// sentence is the half a student reads.
// 3: the same fetched text is now also read for text addressed to an AGENT
// rather than to a person (./injection-text.mjs). A bump rather than a new
// field left to fill in on its own: without it, every posting already scanned
// keeps its entry for up to fourteen days and carries no injection answer at
// all, so the board would ship the warning and show it on nothing. Under the
// bump the whole board is re-read at 60 postings a run — about nine runs, or
// two and a quarter hours — and the flag arrives everywhere at once.
// 4 (8 September 2026): the same fetched text is now also read for what the
// posting SAYS IT PAYS (./pay-text.mjs). A bump for the reason 3 was one, and
// the cost is higher this time because the board has grown: every entry already
// scanned would otherwise keep its verdict for up to fourteen days and carry no
// pay answer at all, so the pay floor would ship and filter on almost nothing —
// and a filter that hides a couple of rows out of 1,300 reads as a broken filter
// rather than an empty one. Under the bump the whole board is re-read: about
// 1,300 postings, which is 22 scheduled runs (~5h30m at 60 a run) or 4 manual
// dispatches at the `scan_limit` this revision also adds. The three fields
// arrive together, because they come out of one fetch.
// 5 (8 September 2026): ./pay-text.mjs read two of the 292 postings in that
// first live pass wrongly, and both errors are the kind this pipe exists to
// avoid — a stated maximum lost. "ranges from $1,000 weekly to 2,000 weekly"
// was cached as a flat $1,000 because the second end carries no currency mark,
// and "begin at $20/hour and increase for each undergraduate year completed"
// was cached as a MAXIMUM of $20, which is the one number that sentence rules
// out. Both are now read, and a floor with no ceiling gets no verdict at all.
// A bump rather than a re-read of the two rows: the cache keys a verdict to the
// revision that produced it, so every other posting whose text takes either
// shape holds the same wrong figure with no way to tell which, and a wrong LOW
// figure hides the row from the student who wanted it. Cost is the same 1,300
// postings as revision 4, at the same 60 a run.
// 6 (8 September 2026): the fetch itself changed. Until now every posting was
// asked for as HTML, which reads a server-rendered careers page and reads
// NOTHING from an ATS whose page is a JavaScript shell. Measured on the board
// that morning — 1,931 listings, 1,368 read, 561 unread — the unread set was
// systematically those ATSs: 54 of 54 Ashby postings, 19 Workday postings under
// the `myworkdaysite.com` domain the Workday mapping did not recognise at all,
// plus thin reads across Greenhouse, Lever, SmartRecruiters and iCIMS. The
// consequence is not a missing field, it is three blind ones: the sponsorship
// bar, the agent-directed-text flag and the stated rate are all read from text
// nobody had. `listings.injection_flagged` was 0 on every row on the board.
// ./posting-readers.mjs now maps a posting URL to the public endpoint that
// ATS's own front end reads — Ashby, Greenhouse, Lever, Workday (both domains),
// SmartRecruiters, and iCIMS through its own iframe URL — and falls back to
// today's HTML fetch for everything else and whenever a reader fails.
// A bump rather than letting the three-day unread retry find them, because the
// readers also change what a posting READ under revision 5 returned: an iCIMS
// row that scraped 500 characters of navigation chrome passed the readable
// floor and was classified on it. Those verdicts were read off the wrong text
// and there is no way to tell which from the cache. Cost is the same full
// re-read as revisions 4 and 5 — ~1,900 postings, 32 scheduled runs at 60 or 5
// dispatches at `scan_limit` 400.
export const SCAN_REVISION = 6;

/** Named so a host can see who we are and tell us to stop. */
export const USER_AGENT =
  "AppwingSponsorshipScanner/1.0 (+https://appwing.us; reads public job postings for a visa-sponsorship filter)";

/** Per-request ceiling. A careers page that has not answered in 15s will not. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** In flight at once. Low on purpose — this is not our infrastructure. */
export const CONCURRENCY = 4;

/** Between one worker's requests. Four workers, so ~16 requests a second peak. */
export const REQUEST_DELAY_MS = 250;

/**
 * The whole run's wall clock.
 *
 * The workflow's concurrency group cancels an in-flight run when the next one
 * starts, 15 minutes later. A scan that ran long would be killed mid-flight and
 * lose everything it learned, so it stops itself with time to spare and writes
 * what it has. Fewer postings this run is not a failure; a cancelled run is.
 */
export const SCAN_BUDGET_MS = 5 * 60_000;

/** HTTP statuses that mean "stop asking this host". */
const BACKOFF_STATUSES = new Set([403, 429, 503]);

/* ────────────────────────────── HTML to lines ────────────────────────────── */

/** Tags whose start or end is a line break in the rendered page. */
const BLOCK_TAG =
  /<\s*\/?\s*(?:p|div|li|ul|ol|dl|dt|dd|tr|td|th|table|thead|tbody|section|article|aside|header|footer|main|nav|figure|figcaption|blockquote|pre|form|fieldset|h[1-6]|br|hr)\b[^>]*>/gi;

/** Tags whose CONTENT is not prose and must go with them. */
const NON_PROSE = /<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

const ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["ndash", "–"],
  ["mdash", "—"],
  ["hellip", "…"],
  ["rsquo", "’"],
  ["lsquo", "‘"],
  ["rdquo", "”"],
  ["ldquo", "“"],
  ["bull", "•"],
]);

/**
 * Zero-width and soft-hyphen characters. Invisible, and they arrive inside real
 * sentences: a live posting produced "security clearance\u200b U.S. citizenship
 * is required". They break nothing in the matching but they travel into the
 * EVIDENCE, which is a sentence a student reads and may paste elsewhere.
 */
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff\u00ad]/g;

/**
 * Entities, decoded to a FIXED POINT rather than once.
 *
 * A single pass is wrong on doubly-encoded markup, which careers pages produce
 * whenever a description was escaped, stored, and escaped again. `&amp;#xa;`
 * matches on `&amp;` first, becomes `&#xa;`, and the global regex has already
 * moved past the character it just wrote — so the literal text `&#xa;` reached
 * the evidence of the first citizenship bar this scanner ever found:
 *
 *   "...only U.S. citizens are eligible for a security clearance&#xa;&#xa;"
 *
 * Bounded at three passes: this runs over text fetched from strangers, and
 * "repeat until it stops changing" over hostile input is how a decoder becomes
 * a denial of service. Three clears the doubly-encoded case that occurs in
 * practice and stops.
 *
 * Safe to iterate here because nothing downstream treats this as markup — the
 * text is matched by regex and rendered by React as a text node, never as HTML.
 */
function decodeEntities(text) {
  let out = text;
  for (let pass = 0; pass < 3; pass++) {
    const next = decodeEntitiesOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

function decodeEntitiesOnce(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES.get(body.toLowerCase()) ?? whole;
  });
}

/**
 * HTML as text WITH ITS BLOCK BOUNDARIES INTACT.
 *
 * The line breaks are the point, not a nicety. `classifyPostingText` reads one
 * line at a time precisely so it cannot invent a sentence — and a bullet list
 * flattened to one string is exactly that invention: a rule that takes "not"
 * from one requirement and "sponsor" from the next produces a refusal the
 * posting never made, against a user who is then never shown the job. That was a
 * real false positive before this function kept the breaks.
 *
 * So closing and opening block tags become newlines BEFORE the remaining tags
 * are dropped. Doing it the other way round — strip tags, then try to guess
 * sentence boundaries — is the version that fails, because by then the evidence
 * of where the bullets were is gone.
 *
 * Entities are decoded LAST, after the tags are gone, so an `&lt;p&gt;` that a
 * posting quoted as text is never mistaken for a tag.
 */
export function htmlToText(html) {
  const source = String(html ?? "");
  if (!source) return "";
  const text = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(NON_PROSE, "\n")
    .replace(BLOCK_TAG, "\n")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(text)
    .replace(INVISIBLE, "")
    .split("\n")
    // Horizontal whitespace only, per line — collapsing across the newline is
    // the same mistake as never having made it.
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/* ─────────────────────────────── The cache ──────────────────────────────── */

/** The shape version of the cache file itself. */
export const CACHE_VERSION = 1;

/** An empty cache — what a first run, or an unreadable file, starts from. */
export function emptyCache() {
  return { version: CACHE_VERSION, entries: {} };
}

/**
 * A cache file's parsed contents, or an empty cache.
 *
 * A cache that cannot be read is not an error. It is one branch file among 96
 * commits a day, the worst case of losing it is that the board re-reads postings
 * it had already read, and failing the run instead would take the LISTINGS
 * mirror down with it — which is the one thing users would notice.
 */
export function parseCache(body) {
  try {
    const parsed = JSON.parse(String(body ?? ""));
    if (!parsed || typeof parsed !== "object") return emptyCache();
    if (parsed.version !== CACHE_VERSION) return emptyCache();
    if (!parsed.entries || typeof parsed.entries !== "object") return emptyCache();
    return { version: CACHE_VERSION, entries: { ...parsed.entries } };
  } catch {
    return emptyCache();
  }
}

/** Only a posting URL we could actually fetch. */
function fetchableUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Is this cached entry still worth believing, for this listing, right now?
 *
 * Four ways it is not: the rule changed under it (`revision`), the posting moved
 * (`url`), a real verdict aged out, or an unread posting is due another try. The
 * URL check is the easy one to leave out and the one that would silently keep a
 * verdict read from a page that no longer exists.
 */
export function isFresh(entry, url, now) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.revision !== SCAN_REVISION) return false;
  if (entry.url !== url) return false;
  const checkedAt = typeof entry.checkedAt === "number" ? entry.checkedAt : 0;
  if (checkedAt <= 0) return false;
  const age = now - checkedAt;
  return entry.status === "unread" ? age < RETRY_UNREAD_AFTER_SECONDS : age < RESCAN_AFTER_SECONDS;
}

/**
 * Which postings this run should read, in the order it should read them.
 *
 * NEVER-SCANNED FIRST, and that ordering is the whole cold-start story. With 864
 * listings and a cap of 60, "oldest first" alone would still get there — but it
 * would interleave first reads with re-reads from the moment the first entry
 * ages, so the board would sit at partial coverage for weeks instead of filling
 * in under four hours. A posting nobody has ever read is worth strictly more
 * than one whose answer is merely old.
 *
 * Ties break on id so two runs over the same inputs choose the same postings,
 * which is what makes this testable at all.
 */
export function selectToScan(listings, cache, now, limit = SCAN_LIMIT) {
  const entries = (cache && cache.entries) || {};
  const due = [];
  for (const listing of Array.isArray(listings) ? listings : []) {
    if (!listing || typeof listing.id !== "string" || !listing.id) continue;
    const url = fetchableUrl(listing.url);
    // A listing with no posting link has nothing to read. It is not unread; it
    // is unreadable, and recording an attempt against it would waste a slot
    // every run forever.
    if (!url) continue;
    const entry = entries[listing.id];
    if (isFresh(entry, url, now)) continue;
    const everRead = entry && entry.revision === SCAN_REVISION && entry.url === url
      ? Number(entry.checkedAt) || 0
      : 0;
    due.push({ id: listing.id, url, priority: everRead === 0 ? 0 : 1, checkedAt: everRead });
  }
  due.sort(
    (a, b) =>
      a.priority - b.priority ||
      a.checkedAt - b.checkedAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return due.slice(0, Math.max(0, limit)).map(({ id, url }) => ({ id, url }));
}

/**
 * The cache after a run, given what the run learned.
 *
 * TWO KINDS OF RESULT, and the difference is the reason this is a function
 * rather than an `Object.assign`:
 *
 *   read      The posting was fetched and classified. It replaces whatever was
 *             there.
 *   not read  The fetch failed, or the page was a shell. The previous VERDICT
 *             survives — only `checkedAt` moves. A host that 403s today must not
 *             erase a barrier we read from that posting last week; the barrier is
 *             still in the posting. What the failure updates is our record of
 *             when we last tried, which is what stops the same dead URL being
 *             picked first every run until the end of time.
 *
 * Ids no longer on the board are DROPPED. The cache is keyed by listing id, the
 * board turns over every season, and a cache that only grew would carry dead
 * seasons forever in a file the runner reads on every one of 96 daily runs.
 */
export function mergeScan(cache, results, liveIds) {
  const previous = (cache && cache.entries) || {};
  const keep = liveIds instanceof Set ? liveIds : new Set(liveIds ?? Object.keys(previous));
  const entries = {};
  for (const [id, entry] of Object.entries(previous)) {
    if (keep.has(id)) entries[id] = entry;
  }

  for (const result of Array.isArray(results) ? results : []) {
    if (!result || typeof result.id !== "string") continue;
    if (!keep.has(result.id)) continue;
    const previousEntry = entries[result.id];

    if (result.read) {
      entries[result.id] = {
        status: result.status,
        evidence: result.evidence ?? null,
        // The flag and the text behind it, together or not at all — the same
        // pairing `status`/`evidence` keeps above and for the same reason. A
        // warning nobody can read the words behind is a claim nobody can check,
        // and this one asks a user to look at a posting with suspicion.
        //
        // WRITTEN ON EVERY READ, including the clean ones, and written as
        // `false` rather than omitted: a posting read today and found clean is
        // a different fact from one nobody has read, and `false` is what says
        // so on the entry the mirror is built from.
        injection: result.injection === true,
        injectionSnippets:
          result.injection === true && Array.isArray(result.injectionSnippets)
            ? result.injectionSnippets
            : [],
        // WRITTEN ON EVERY READ, `null` included, on the argument the flag above
        // makes: a posting read today that states no rate is a different fact
        // from one nobody has read, and `null` on the entry is what says so. The
        // MIRROR is where the absence discipline applies — `payFields` writes no
        // key at all for a null — but the cache is a record of what was read.
        pay: result.pay ?? null,
        // WHICH READER PRODUCED THE TEXT. `null` on an entry written before this
        // field existed, and on the plain HTML path it is simply "html" — see
        // ./posting-readers.mjs. Kept on the CACHE and deliberately not carried
        // into the mirror: how we read a posting is our bookkeeping, not a fact
        // about the job, and `sponsorshipFields` in mirror-listings.mjs reads
        // named fields only, so adding it here changes no mirror byte.
        readBy: result.readBy ?? null,
        scannedAt: result.at,
        checkedAt: result.at,
        revision: SCAN_REVISION,
        url: result.url,
      };
      continue;
    }

    // Not read. Keep a prior verdict for THIS url under THIS revision; otherwise
    // the posting is on record as unread and will be tried again.
    const carries =
      previousEntry &&
      previousEntry.revision === SCAN_REVISION &&
      previousEntry.url === result.url &&
      previousEntry.status !== "unread";
    entries[result.id] = carries
      ? { ...previousEntry, checkedAt: result.at }
      : {
          status: "unread",
          evidence: null,
          checkedAt: result.at,
          revision: SCAN_REVISION,
          url: result.url,
          reason: result.reason,
        };
  }

  // Sorted by id so an unchanged cache serialises to identical bytes and the
  // workflow's "did anything change?" stays a byte comparison — the same
  // determinism the listings mirror depends on, for the same reason.
  const sorted = {};
  for (const id of Object.keys(entries).sort()) sorted[id] = entries[id];
  return { version: CACHE_VERSION, entries: sorted };
}

/** The cache file's bytes. One line, sorted keys, no timestamp — see `mergeScan`. */
export function serializeCache(cache) {
  return `${JSON.stringify(cache)}\n`;
}

/* ─────────────────────────────── The network ─────────────────────────────── */

/** A fetch with a timeout and our name on it, or a reason it did not happen. */
async function get(url, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept,
        "accept-language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) return { ok: false, status: res.status, reason: `http_${res.status}` };
    return { ok: true, status: res.status, body: await res.text() };
  } catch (error) {
    // AbortError, DNS failure, TLS failure, redirect loop — every one of them is
    // "we did not read it", and none of them is worth a stack trace in a log
    // that already has 96 runs a day in it.
    return { ok: false, status: 0, reason: error?.name === "AbortError" ? "timeout" : "network" };
  }
  finally {
    clearTimeout(timer);
  }
}

/**
 * How many shared reader bodies one run keeps in memory.
 *
 * Only Ashby's endpoint is shared — one request returns a whole company's board
 * — and the board carries 53 Ashby postings across 34 orgs, so 32 covers a run
 * at the scheduled limit and the cap is what stops a 400-posting dispatch from
 * holding four hundred job boards at once. Past the cap the reader simply
 * fetches again, which is the behaviour it had before the cache existed.
 */
export const MAX_SHARED_BODIES = 32;

/**
 * A reader endpoint that answers for many postings, fetched ONCE per run.
 *
 * The PROMISE is cached, not the body, and that is the point: four workers run
 * concurrently and Etched has eight postings on this board, so caching the
 * result would still let all eight requests leave before the first one landed.
 * Caching the in-flight promise makes the other seven wait on it.
 *
 * A failed fetch is cached too, deliberately. A board that answered 404 will
 * answer 404 for every other posting that names it, and asking seven more times
 * is somebody else's bandwidth spent on an answer we already have.
 */
function sharedGet(cache, reader, request) {
  const hit = cache.get(reader.url);
  if (hit) return hit;
  const pending = request(reader.url, reader.accept);
  if (cache.size < MAX_SHARED_BODIES) cache.set(reader.url, pending);
  return pending;
}

/** The host part of a URL, lowercased, or "" when it does not parse. */
function hostOf(value) {
  try {
    return new URL(String(value ?? "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * One posting's text, by whichever door that host actually opens.
 *
 * THE READER FIRST, WHEN THERE IS ONE. An ATS page is a JavaScript shell — the
 * description is not in the HTML at all — so for those hosts the HTML fetch is a
 * request spent on a page that cannot answer. ./posting-readers.mjs maps the
 * posting URL to the public endpoint that ATS's own front end reads, and the
 * text that comes back goes through the SAME stripper and the same three
 * classifiers as any other page. Nothing about the verdict changes; only which
 * bytes it is asked about.
 *
 * AND THE HTML PATH BEHIND IT, ALWAYS. A reader that answers non-200, returns
 * malformed JSON, or cannot find this posting in what it got falls THROUGH to
 * the ordinary fetch, and from there to `unread` if that is thin too. Measured
 * cases of each: Workday's fmr tenant answers 403 to CXS, Greenhouse answers 404
 * for a job that has closed, and Ashby answers 200 with the posting simply
 * absent from a board it has left. None of those is a reason to stop trying, and
 * none of them is a reason to record a verdict — the worst a broken reader can
 * cost is one extra request.
 *
 * WHOSE HOST GETS BACKED OFF, which is the one thing that is not symmetric. A
 * refusal from `api.ashbyhq.com` says nothing about `jobs.ashbyhq.com` and the
 * HTML fetch should still happen — but it does say to stop asking the API, and
 * the API is shared by every Ashby posting in the run, so the host is recorded
 * and skipped for the rest of it. A refusal from a Workday tenant's own CXS path
 * is that TENANT refusing us; the shell on the same host would have been refused
 * too, so it is reported up and the posting host is dropped. `sameHost` on the
 * reader is which of the two this is.
 */
export async function fetchPostingText(url, deps = {}) {
  const request = deps.get ?? get;
  const backedOff = deps.backedOff instanceof Set ? deps.backedOff : null;
  const shared = deps.readerCache instanceof Map ? deps.readerCache : null;

  const reader = postingReader(url);
  if (reader && !backedOff?.has(hostOf(reader.url))) {
    const res =
      shared && reader.shared
        ? await sharedGet(shared, reader, request)
        : await request(reader.url, reader.accept);
    if (res.ok) {
      try {
        const description = reader.extract(res.body);
        if (typeof description === "string" && description) {
          return { ok: true, text: htmlToText(description), via: reader.name };
        }
      } catch {
        // An endpoint that answered something other than what we expect. Fall
        // through; the HTML path is no worse than it was.
      }
    } else if (BACKOFF_STATUSES.has(res.status)) {
      backedOff?.add(hostOf(reader.url));
      // The posting's OWN host refused us. The shell it serves would have been
      // refused as well, so report the status up and let the host be dropped.
      if (reader.sameHost) return { ok: false, reason: res.reason, status: res.status };
    }
  }

  const res = await request(url, "text/html,application/xhtml+xml");
  if (!res.ok) return { ok: false, reason: res.reason, status: res.status };
  return { ok: true, text: htmlToText(res.body), via: reader ? `html-after-${reader.name}` : "html" };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read as many of the chosen postings as the budget allows.
 *
 * Returns results, never throws, and stops early rather than being killed. The
 * caller merges whatever came back — a run that read 11 of 60 postings is 11
 * postings better than the last one.
 */
export async function scanPostings(targets, deps = {}) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const startedAt = deps.monotonic ? deps.monotonic() : Date.now();
  const elapsed = () => (deps.monotonic ? deps.monotonic() : Date.now()) - startedAt;
  const budget = deps.budgetMs ?? SCAN_BUDGET_MS;
  const delayMs = deps.delayMs ?? REQUEST_DELAY_MS;
  const pause = deps.sleep ?? sleep;
  /**
   * Hosts that told us to go away. Dropped for the rest of THIS run only.
   *
   * SHARED WITH THE READERS, which is why it is declared before `fetchText`
   * rather than after. A reader's endpoint is often a DIFFERENT host from the
   * posting — `api.ashbyhq.com` serves every Ashby row in the run — and four
   * workers that each learn independently that it is refusing them will each ask
   * it another sixty times. One set, one lesson.
   */
  const backedOff = new Set();

  /**
   * Reader bodies that answer for more than one posting, this run only.
   *
   * Ashby's board endpoint returns a whole company's postings, and the board
   * carries eight from Etched and five from Northwood. Without this they are
   * thirteen requests for two documents. See `sharedGet`.
   */
  const readerCache = new Map();

  const fetchText =
    deps.fetchPostingText ?? ((url) => fetchPostingText(url, { ...deps, backedOff, readerCache }));

  const results = [];
  const queue = [...targets];

  async function worker() {
    for (;;) {
      const target = queue.shift();
      if (!target) return;
      if (elapsed() > budget) return;

      let host = "";
      try {
        host = new URL(target.url).hostname.toLowerCase();
      } catch {
        // Selection already filtered these out; belt and braces.
      }
      if (backedOff.has(host)) {
        // Not recorded as an attempt: we never asked. Leaving `checkedAt` alone
        // means this posting keeps its place in the queue for the next run,
        // which is the honest bookkeeping.
        continue;
      }

      let outcome;
      try {
        outcome = await fetchText(target.url);
      } catch (error) {
        outcome = { ok: false, reason: "error", status: 0 };
      }
      const at = now();

      if (!outcome.ok) {
        if (BACKOFF_STATUSES.has(outcome.status)) backedOff.add(host);
        results.push({ id: target.id, url: target.url, read: false, reason: outcome.reason, at });
      } else if ((outcome.text?.length ?? 0) < MIN_READABLE_CHARS) {
        // The JavaScript-shell case, and the reason `open` is not recorded here.
        results.push({ id: target.id, url: target.url, read: false, reason: "thin", at });
      } else {
        const { status, evidence } = classifyPostingText(outcome.text);
        // THE SAME TEXT, READ A SECOND WAY, and that is the whole reason this
        // lives in this loop rather than in a scanner of its own. The expensive
        // part of learning anything about a posting is the round trip to
        // somebody else's careers page — hundreds of them, rate limited, some
        // of which 403. A separate job asking the same question of the same
        // hosts would double that cost to answer a question we are already
        // holding the bytes for.
        const injection = scanForInjection(outcome.text);
        // THE SAME TEXT, READ A THIRD WAY, on the argument the comment above
        // makes and for a question upstream cannot answer at all: its feed
        // carries no pay field of any kind, so the posting is the only place a
        // rate exists. See ./pay-text.mjs.
        const pay = extractPay(outcome.text);
        results.push({
          id: target.id,
          url: target.url,
          read: true,
          status,
          evidence,
          // WHICH DOOR ANSWERED. Not a fact about the job — a fact about the
          // pipe, and the only way to tell a reader that stopped working from
          // an ATS that stopped appearing on the board. The Report step counts
          // by it; nothing user-facing reads it.
          readBy: outcome.via ?? null,
          injection: injection.injection,
          injectionSnippets: injection.snippets,
          pay,
          at,
        });
      }

      if (delayMs > 0) await pause(delayMs);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(deps.concurrency ?? CONCURRENCY, Math.max(1, targets.length)) }, worker),
  );
  return results;
}

/* ─────────────────────────────────── CLI ─────────────────────────────────── */

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readIfPresent(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Listings to scan, read from the mirror the PREVIOUS run committed.
 *
 * Deliberately the previous mirror rather than a fresh upstream fetch: the whole
 * 10.7 MB file is already downloaded and parsed once per run by
 * mirror-listings.mjs, and doing it twice to learn the same id-and-url pairs
 * would double the heaviest thing this workflow does. The cost is that a posting
 * added in this run's mirror is first read fifteen minutes later, and on the
 * very first run of a fresh branch there is no mirror and nothing is scanned.
 * Both are one cycle, against a board where a posting stays open for weeks.
 */
function listingsFrom(body) {
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed?.listings) ? parsed.listings : [];
  } catch {
    return [];
  }
}

/**
 * How many postings each door answered for, this run.
 *
 * THE ONLY WAY A READER'S DEATH IS VISIBLE. Every reader falls back to the HTML
 * fetch and then to `unread`, which is the right behaviour and also a perfect
 * disguise: a vendor that changes its endpoint, or starts refusing this
 * User-Agent, produces no error, no non-zero exit and no red step — just a
 * `read` count that drifts down while `unread` drifts up, spread across 96 runs
 * a day. `readers=ashby-api:12 html:31` in the log is the line where
 * `ashby-api:0` becomes something a person can notice.
 *
 * Every known reader is listed even at zero, for the same reason: a name that
 * vanishes from the output is harder to see than a name showing 0. `html` and
 * the `html-after-*` fallbacks are appended as they occur —
 * `html-after-ashby-api` counts the postings that HAVE that reader and were
 * answered by the page instead, whether the reader failed or was skipped because
 * its API host had already refused us. Against `ashby-api` it is the pair of
 * numbers that says whether a reader is worth the request it spends.
 */
export function countReaders(results) {
  const counts = new Map(READER_NAMES.map((name) => [name, 0]));
  for (const result of Array.isArray(results) ? results : []) {
    const name = typeof result?.readBy === "string" && result.readBy ? result.readBy : "unknown";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/**
 * `ashby-api:12 greenhouse-api:3 html:31` — one token, no spaces inside it.
 *
 * Written to GITHUB_OUTPUT as well as the log, and a GITHUB_OUTPUT value must
 * survive being read back as one line, so the separator is a space and every
 * name here is already free of them.
 */
export function formatReaderCounts(counts) {
  return [...counts.entries()].map(([name, n]) => `${name}:${n}`).join(" ");
}

async function main() {
  const cachePath = arg("cache") ?? "sponsorship-scan.json";
  const listingsPath = arg("listings") ?? "listings.json";
  // `--limit N`, capped — see `MAX_SCAN_LIMIT`. The scheduled run passes none
  // and gets `SCAN_LIMIT`; the workflow's `scan_limit` dispatch input is what
  // fills it, so a cold re-read after a revision bump can be driven at a higher
  // rate by hand without touching the every-15-minutes cadence.
  const limit = readLimit(arg("limit"));
  const dryRun = process.argv.includes("--dry-run");

  const listings = listingsFrom(readIfPresent(listingsPath));
  const before = readIfPresent(cachePath);
  const cache = parseCache(before);
  const now = Math.floor(Date.now() / 1000);

  const targets = selectToScan(listings, cache, now, limit);
  console.log(`listings=${listings.length} cached=${Object.keys(cache.entries).length} due=${targets.length}`);

  const results = targets.length > 0 ? await scanPostings(targets) : [];
  const merged = mergeScan(cache, results, new Set(listings.map((l) => l.id)));
  const next = serializeCache(merged);

  const read = results.filter((r) => r.read);
  const barred = read.filter((r) => r.status !== "open");
  const paid = read.filter((r) => r.pay);
  const changed = next !== before;
  console.log(
    `attempted=${results.length} read=${read.length} unread=${results.length - read.length} ` +
      `barriers=${barred.length} pay=${paid.length} entries=${Object.keys(merged.entries).length} changed=${changed}`,
  );
  console.log(`readers=${formatReaderCounts(countReaders(read))}`);
  for (const hit of barred) console.log(`  ${hit.status}: ${hit.id} — ${hit.evidence}`);

  if (changed && !dryRun) writeFileSync(cachePath, next);
  if (dryRun) console.log(`dry run — ${cachePath} not written`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `scanChanged=${changed ? "true" : "false"}\nscanned=${read.length}\n` +
        `barriers=${barred.length}\npay=${paid.length}\n` +
        `readers=${formatReaderCounts(countReaders(read))}\n`,
    );
  }
}

// Only when run as a program — importing this module for the pure functions
// above must not open a socket. Resolved file URLs rather than a basename match,
// for the reason mirror-listings.mjs gives.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A scan that throws must not fail the run: the listings mirror is committed
  // in the same job and is the thing users actually see. The cache simply does
  // not move.
  try {
    await main();
  } catch (error) {
    console.error(`sponsorship scan failed, cache unchanged: ${error?.message ?? error}`);
  }
}
