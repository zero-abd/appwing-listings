/**
 * Which door to knock on to READ a posting, given the URL a student would open.
 *
 * WHY THIS FILE EXISTS. scan-sponsorship.mjs fetches a posting URL as HTML and
 * strips it to prose. That works on a server-rendered careers page and fails
 * completely on an applicant tracking system whose page is a JavaScript shell —
 * the description is not in the document, the strip yields a few hundred
 * characters of navigation chrome, and the posting is recorded `unread`.
 *
 * MEASURED ON THE BOARD, 8 September 2026, over the 1,931 listings then mirrored
 * and the scan cache beside them: 1,368 read, 561 unread, and the unread set is
 * almost entirely one shape of failure. Counted by host family:
 *
 *   201  Workday, http_403     the CXS reader below existed already; these are
 *                              tenants refusing it, not a missing mapping.
 *   167  Oracle Cloud, thin    NOT read by this file. See "what stays unread".
 *    54  Ashby, thin           every Ashby posting on the board. 54 of 54.
 *    39  Workable, thin        NOT read by this file.
 *    33  Workday, thin         CXS answered without a description, HTML shell.
 *    19  myworkdaysite, thin   Workday under its OTHER domain, which
 *                              `isWorkdayHost` did not recognise at all.
 *    15  iCIMS                 10 of them http_410 — genuinely deleted postings.
 *     8  Greenhouse            3 thin, 3 http_404 (closed), 2 timeout.
 *     3  SmartRecruiters, thin
 *
 * Everything downstream of the fetch is blind on those rows: the sponsorship
 * bar, the agent-directed-text flag, and the stated rate. `listings.injection_
 * flagged` was 0 on every row on the board, and an Ashby posting is exactly
 * where that flag was first needed.
 *
 * WHAT A READER IS. A function from a posting URL to the PUBLIC endpoint that
 * ATS's own front end reads, plus how to get the description out of the answer.
 * No authentication, no key, no scraping of a private API: every endpoint here
 * is the one the vendor documents or the one the public job board itself calls,
 * and the description that comes back is the same text the page would render.
 *
 * WHAT A READER IS NOT. It is not a second source of truth and it is not allowed
 * to be a second answer. Whatever comes back goes through the SAME prose
 * stripper and the SAME three classifiers as a page fetched as HTML. A reader
 * that returns nothing, answers non-200, or hands back malformed JSON falls
 * through to the HTML fetch, and from there to `unread` — never to a guess.
 * That fall-through is the whole safety argument: the worst a broken reader can
 * do is cost one extra request and leave the board exactly where it was.
 *
 * CONFIRMED LIVE, 8 September 2026, with the scanner's own User-Agent, one
 * request per vendor: Ashby (primer, notion), Greenhouse (whitewatermidstream,
 * imc via the EU board), Lever (hermeus), Workday CXS under both domains (wf and
 * devonenergy on myworkdaysite.com), SmartRecruiters (WesternDigital), iCIMS
 * (careersen-mackenzieinvestments: 295 prose characters as plain HTML, 6,371
 * with `in_iframe=1`).
 *
 * WHAT STAYS UNREAD, deliberately. Oracle Cloud Recruiting (167 rows, the single
 * biggest bucket) and Workable (39) have their own JSON APIs and neither is in
 * this file: each is a separate URL grammar to get wrong, and a reader nobody
 * has verified against a live posting is a reader that quietly returns the wrong
 * job's description. They are the obvious next two. Company-hosted Greenhouse
 * links (`example.com/jobs/123?gh_jid=123`) stay unread too — the job id is in
 * the URL but the BOARD TOKEN is not, and `boards-api` is addressed by board.
 *
 * NO DEPENDENCIES, NOT TYPESCRIPT, and nothing here opens a socket. Same
 * constraint as the rest of .github/scripts: this runs on a bare
 * `actions/setup-node` with no install step, and every function below is a pure
 * mapping from a string to a string so the tests can drive all of it over
 * recorded fixtures.
 */

/* ────────────────────────────── small helpers ───────────────────────────── */

/** A parsed URL, or null. Never throws — these arrive from an upstream feed. */
function parse(value) {
  try {
    return new URL(String(value ?? ""));
  } catch {
    return null;
  }
}

/** Path segments with the empties gone: `/a/b/` -> `["a", "b"]`. */
function segments(url) {
  return url.pathname.split("/").filter(Boolean);
}

/** `JSON.parse` that answers null instead of throwing. */
function json(body) {
  try {
    const parsed = JSON.parse(String(body ?? ""));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** A non-empty trimmed string, or null. Guards every `extract` return. */
function nonEmpty(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Fragments joined into one document, empties dropped.
 *
 * `\n` between them and not a space: the stripper downstream reads ONE LINE AT A
 * TIME precisely so it cannot invent a sentence out of two neighbouring bullets,
 * and joining a section heading to the section under it would hand it exactly
 * the run-on it is written to avoid.
 */
function joinBlocks(parts) {
  return parts.map((p) => nonEmpty(p)).filter(Boolean).join("\n");
}

/**
 * Markup that arrived HTML-ESCAPED, put back.
 *
 * Greenhouse's board API is the case: `content` is the description with every
 * `<` written as `&lt;`. Handed to the stripper as-is it has no tags to strip,
 * so the block boundaries are decoded into the TEXT — `<p>` becomes four visible
 * characters in the middle of a sentence and the paragraph breaks are gone. The
 * stripper decodes entities LAST, after tags, and that ordering is right for its
 * own job; this is the one place the order has to be the other way round.
 *
 * ONLY WHEN IT LOOKS ESCAPED, and the test is deliberately narrow: escaped tag
 * openers present AND no real tag anywhere. A description that merely quotes
 * `&lt;` as a literal (a C++ posting writing `std::vector&lt;T&gt;`) alongside
 * real markup is left alone, because unescaping it would turn the quote into a
 * tag and the stripper would delete the text between it and the next `>`.
 *
 * `&amp;` LAST, which is the classic ordering bug: unescape it first and
 * `&amp;lt;` becomes `&lt;` becomes `<`, inventing a tag from text that was
 * never markup.
 */
export function unescapeMarkup(value) {
  const source = String(value ?? "");
  if (!source) return "";
  const looksEscaped = /&lt;\/?[a-z]/i.test(source);
  const hasRealTags = /<[a-z!/][^>]*>/i.test(source);
  if (!looksEscaped || hasRealTags) return source;
  return source
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/g, "&");
}

/* ─────────────────────────────── Workday ────────────────────────────────── */

/** `something.myworkdayjobs.com`, or a subdomain of it. Dot boundary, not `includes`. */
export function isWorkdayHost(host) {
  const h = String(host ?? "").toLowerCase();
  return h === "myworkdayjobs.com" || h.endsWith(".myworkdayjobs.com");
}

/**
 * `something.myworkdaysite.com`, Workday's OTHER domain.
 *
 * Nineteen postings on the board sit here and every one of them was unread,
 * because `isWorkdayHost` is anchored to the domain and this is a different one.
 * The CXS endpoint is identical; only where the TENANT lives in the URL changes
 * — see `workdayCxsUrl`.
 */
export function isWorkdaySiteHost(host) {
  const h = String(host ?? "").toLowerCase();
  return h === "myworkdaysite.com" || h.endsWith(".myworkdaysite.com");
}

/**
 * A locale segment Workday puts in front of the site name — `en-US`, `fr-CA`.
 *
 * Anchored to the two-letter-dash-two-letter shape rather than "any short
 * segment", because a Workday site name can be short too and dropping the site
 * builds a URL for a tenant's default site, which is a different job board.
 */
const LOCALE_SEGMENT = /^[a-z]{2}-[A-Za-z]{2,4}$/;

/**
 * The CXS JSON endpoint for a Workday posting URL, or null when there is not
 * one.
 *
 * WHY THIS EXISTS. A Workday posting fetched as HTML is a JavaScript shell: the
 * description is not in the document, and stripping it yields about one
 * character. Workday's own front end reads the posting from an unauthenticated
 * JSON API on the same host, and so can we.
 *
 *   https://pimco.wd1.myworkdayjobs.com/en-US/PIMCO_External/job/Newport-Beach/Intern_R1
 *   https://pimco.wd1.myworkdayjobs.com/wday/cxs/pimco/PIMCO_External/job/Newport-Beach/Intern_R1
 *
 * TWO DOMAINS, TWO PLACES THE TENANT HIDES. On `myworkdayjobs.com` the tenant is
 * the FIRST LABEL OF THE HOST (`pimco`) and the site is the path segment before
 * `job`. On `myworkdaysite.com` the host is only a shard (`wd1`, `wd5`) shared
 * by every tenant on it, and the tenant is a PATH segment instead, behind
 * `recruiting`:
 *
 *   https://wd1.myworkdaysite.com/recruiting/wf/WellsFargoJobs/job/CHARLOTTE-NC/...
 *   https://wd1.myworkdaysite.com/wday/cxs/wf/WellsFargoJobs/job/CHARLOTTE-NC/...
 *
 * Reading the tenant off the host on that domain would ask `wd1` for every
 * posting and get nothing; that is why all nineteen were unread.
 *
 * Any locale in front is dropped on both — the API is not localised and
 * `.../cxs/pimco/en-US/PIMCO_External/job/...` is a 404.
 *
 * VERIFIED WORKING on pimco and marmon (myworkdayjobs), and on wf and
 * devonenergy (myworkdaysite, the second with an `/en-US/` in front). fmr
 * answered 403, which is why the caller falls back to the HTML path rather than
 * treating a CXS failure as the end of the story.
 */
export function workdayCxsUrl(value) {
  const url = parse(value);
  if (!url) return null;

  const onJobsDomain = isWorkdayHost(url.hostname);
  const onSiteDomain = isWorkdaySiteHost(url.hostname);
  if (!onJobsDomain && !onSiteDomain) return null;

  let path = segments(url);
  // A leading locale belongs to the human-facing page and to nothing else.
  // Stripped here, before either domain's tenant is located, because
  // myworkdaysite.com puts it in front of `recruiting`.
  if (path.length > 1 && LOCALE_SEGMENT.test(path[0])) path = path.slice(1);

  let tenant;
  if (onSiteDomain) {
    // `/recruiting/<tenant>/<site>/job/...`
    if (path[0] !== "recruiting") return null;
    tenant = path[1];
    path = path.slice(2);
  } else {
    tenant = url.hostname.split(".")[0];
  }
  if (!tenant) return null;

  const jobAt = path.indexOf("job");
  // No `/job/` segment, or nothing after it: a search page or a tenant's landing
  // page, not a posting.
  if (jobAt < 1 || jobAt === path.length - 1) return null;

  const site = path.slice(0, jobAt);
  // The site is ONE segment. A second leading locale (already handled above) or
  // an unexpected shape is not something to guess at: a wrong site name reads a
  // different board and returns another posting's description.
  if (site.length !== 1) return null;

  const rest = path.slice(jobAt + 1).join("/");
  return `https://${url.hostname}/wday/cxs/${tenant}/${site[0]}/job/${rest}`;
}

/** The description out of a CXS body. Shape verified against pimco and wf. */
export function workdayDescription(body) {
  return nonEmpty(json(body)?.jobPostingInfo?.jobDescription);
}

/* ──────────────────────────────── Ashby ─────────────────────────────────── */

/** `jobs.ashbyhq.com`, and nothing that merely ends in something like it. */
function isAshbyHost(host) {
  const h = String(host ?? "").toLowerCase();
  return h === "jobs.ashbyhq.com" || h.endsWith(".jobs.ashbyhq.com");
}

/**
 * The public job-board API for an Ashby posting, and the job id to find in it.
 *
 *   https://jobs.ashbyhq.com/notion/3fba1c39-...-1cec4d7e9d0c/application?embed=true
 *   https://api.ashbyhq.com/posting-api/job-board/notion?includeCompensation=true
 *
 * ONE REQUEST RETURNS THE WHOLE BOARD, which is why the caller caches it for the
 * run: Etched has eight postings on this board and Northwood five, and asking
 * for the same 100-job document once per posting would be thirteen requests to
 * learn what two answer. It is also why the id matters — the answer is an array
 * and picking the wrong element attributes another job's description, and
 * another job's sponsorship bar, to this posting.
 *
 * `/application`, `/apply` and any query are dropped: they address the FORM, and
 * the id in front of them is the same posting either way. Every Ashby URL the
 * feed carries has one of those suffixes.
 *
 * `includeCompensation=true` because Ashby holds the stated rate in a structured
 * field rather than in the description, and it is free on this request. See
 * `ashbyDescription`.
 *
 * VERIFIED LIVE against primer and notion. On notion the id from the URL matched
 * `job.id` exactly and returned an 8,169-character description; the same board
 * answered 200 with the job simply absent for two postings that have since
 * closed, which is the case that falls through to HTML and then to `unread`.
 */
export function ashbyBoardUrl(value) {
  const url = parse(value);
  if (!url || !isAshbyHost(url.hostname)) return null;
  const path = segments(url);
  if (path.length < 2) return null;
  const [org, jobId] = path;
  if (!org || !jobId) return null;
  // The id is a UUID. Anchored, because `jobs.ashbyhq.com/<org>/<something>` is
  // also how Ashby addresses a board's own sub-pages, and a board page has no id
  // to look up.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) return null;
  return {
    url: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`,
    org,
    jobId,
  };
}

/** Every distinct compensation summary Ashby states, longest-lived first. */
function ashbyCompensationLines(job) {
  const compensation = job?.compensation;
  if (!compensation || typeof compensation !== "object") return [];
  const lines = [
    compensation.compensationTierSummary,
    compensation.scrapeableCompensationSalarySummary,
    ...(Array.isArray(compensation.compensationTiers)
      ? compensation.compensationTiers.map((tier) => tier?.tierSummary)
      : []),
  ];
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const text = nonEmpty(line);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * One job's description out of a whole board, chosen by id.
 *
 * THE COMPENSATION SUMMARY IS APPENDED AS TEXT and read by the same
 * `extractPay` that reads every other posting — it is NOT a second pay path.
 * Ashby is the one vendor here that states the rate in a field instead of in the
 * prose, so a posting whose page shows "$40 - $50 / hr" above the description
 * carries no rate at all in `descriptionHtml`; pasting the summary onto the end
 * puts it back where the existing reader already looks. What `extractPay` makes
 * of it is entirely `extractPay`'s business, and it declines some of them:
 * "$67.5K • Offers Equity" states no period and gets no verdict, which is the
 * correct outcome for a figure whose unit is a guess.
 *
 * Falls back to `descriptionPlain` when there is no HTML, and returns null when
 * there is neither — a job with an empty description is not a read.
 */
export function ashbyDescription(body, jobId) {
  const jobs = json(body)?.jobs;
  if (!Array.isArray(jobs)) return null;
  const wanted = String(jobId ?? "").toLowerCase();
  const job = jobs.find((candidate) => String(candidate?.id ?? "").toLowerCase() === wanted);
  if (!job) return null;
  const description = nonEmpty(job.descriptionHtml) ?? nonEmpty(job.descriptionPlain);
  if (!description) return null;
  return joinBlocks([description, ...ashbyCompensationLines(job)]);
}

/* ────────────────────────────── Greenhouse ──────────────────────────────── */

/** Greenhouse's own board hosts, including the EU one. */
function isGreenhouseHost(host) {
  const h = String(host ?? "").toLowerCase();
  return (
    h === "boards.greenhouse.io" ||
    h === "job-boards.greenhouse.io" ||
    h === "boards.eu.greenhouse.io" ||
    h === "job-boards.eu.greenhouse.io"
  );
}

/**
 * The public board API for a Greenhouse posting, or null when the BOARD cannot
 * be named.
 *
 *   https://job-boards.greenhouse.io/whitewatermidstream/jobs/5217853007
 *   https://boards-api.greenhouse.io/v1/boards/whitewatermidstream/jobs/5217853007
 *
 * THE ORG IS THE BOARD TOKEN, and it is the half of the address that a
 * company-hosted link does not carry. `sentinelone.com/jobs/7678136003?gh_jid=
 * 7678136003` names the job and not the board, and `boards-api` is addressed by
 * board first — so those are left to the HTML path rather than guessed at from
 * the company's domain, which would ask the wrong board and 404 at best.
 *
 * The embed form carries the board in `for=` when it carries it at all:
 *
 *   https://boards.greenhouse.io/embed/job_app?token=8049938&for=acme
 *
 * Without `for=` there is no board to name and this returns null — which costs
 * nothing, because the embed page is server-rendered and the HTML path already
 * reads it. That was measured: every `embed/job_app` row on the board is read.
 *
 * ONE API HOST, NOT TWO. `boards-api.eu.greenhouse.io` does not resolve; the EU
 * boards answer from `boards-api.greenhouse.io` like every other. Verified live
 * on imc, whose postings live on `job-boards.eu.greenhouse.io`.
 */
export function greenhouseApiUrl(value) {
  const url = parse(value);
  if (!url || !isGreenhouseHost(url.hostname)) return null;
  const path = segments(url);

  // The embed form: the job is a query token and the board is `for=`, or absent.
  if (path[0] === "embed") {
    const token = nonEmpty(url.searchParams.get("token"));
    const org = nonEmpty(url.searchParams.get("for"));
    if (!token || !org || !/^\d+$/.test(token)) return null;
    return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(org)}/jobs/${token}`;
  }

  // `/<org>/jobs/<id>`, the ordinary board link.
  if (path.length < 3 || path[1] !== "jobs") return null;
  const org = path[0];
  const id = path[2];
  if (!org || !/^\d+$/.test(id)) return null;
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(org)}/jobs/${id}`;
}

/**
 * The description out of a Greenhouse job body.
 *
 * `content` arrives HTML-ESCAPED — `&lt;p&gt;` and not `<p>` — so it is put back
 * before the stripper sees it, or the paragraph breaks decode into the middle of
 * the prose instead of separating it. See `unescapeMarkup`.
 */
export function greenhouseDescription(body) {
  const content = nonEmpty(json(body)?.content);
  return content ? unescapeMarkup(content) : null;
}

/* ──────────────────────────────── Lever ─────────────────────────────────── */

/** `jobs.lever.co` and its EU sibling. */
function leverApiHost(host) {
  const h = String(host ?? "").toLowerCase();
  if (h === "jobs.lever.co") return "api.lever.co";
  if (h === "jobs.eu.lever.co") return "api.eu.lever.co";
  return null;
}

/**
 * The public posting API for a Lever posting.
 *
 *   https://jobs.lever.co/hermeus/5b08e2df-c9db-4831-aece-67d89e744796/apply
 *   https://api.lever.co/v0/postings/hermeus/5b08e2df-c9db-4831-aece-67d89e744796
 *
 * Every Lever link the feed carries ends in `/apply`; it addresses the form and
 * the id in front of it is the same posting, so anything past the id is dropped.
 * VERIFIED LIVE on hermeus.
 */
export function leverApiUrl(value) {
  const url = parse(value);
  if (!url) return null;
  const apiHost = leverApiHost(url.hostname);
  if (!apiHost) return null;
  const path = segments(url);
  if (path.length < 2) return null;
  const [org, id] = path;
  if (!org || !id) return null;
  // Lever ids are UUIDs. Anchored for the reason Ashby's is: `/<org>/<word>` is
  // also how a board addresses its own pages, and those have no posting to read.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return `https://${apiHost}/v0/postings/${encodeURIComponent(org)}/${id}`;
}

/**
 * A Lever posting's text, which arrives in FOUR pieces and is worthless in one.
 *
 * `description` is the opening prose, `lists` are the bulleted sections with
 * their headings, and `additional` is the closing block — which is where Lever
 * postings put the pay range and the EEO and sponsorship boilerplate, i.e. two
 * of the three things this scanner reads. Taking `description` alone would read
 * a third of the posting and confidently report no barrier.
 *
 * HTML preferred over the `*Plain` twins wherever both exist, because
 * `lists[].content` is `<li>` markup and the bullets are the boundaries the
 * classifier depends on. The plain fields are the fallback, and they carry their
 * own newlines, so the stripper keeps their lines either way.
 */
export function leverDescription(body) {
  const posting = json(body);
  if (!posting) return null;
  const lists = Array.isArray(posting.lists) ? posting.lists : [];
  const parts = [
    nonEmpty(posting.description) ?? nonEmpty(posting.descriptionPlain),
    ...lists.flatMap((list) => [nonEmpty(list?.text), nonEmpty(list?.content)]),
    nonEmpty(posting.additional) ?? nonEmpty(posting.additionalPlain),
  ];
  return nonEmpty(joinBlocks(parts));
}

/* ───────────────────────────── SmartRecruiters ──────────────────────────── */

/**
 * The public posting API for a SmartRecruiters posting.
 *
 *   https://jobs.smartrecruiters.com/WesternDigital/744000138727213
 *   https://jobs.smartrecruiters.com/WesternDigital/744000138727213-software-intern
 *   https://api.smartrecruiters.com/v1/companies/WesternDigital/postings/744000138727213
 *
 * The id is the LEADING DIGITS of the last segment; the slug behind the first
 * dash is decoration and the API rejects it. VERIFIED LIVE on WesternDigital.
 *
 * READING IS NOT APPLYING. SmartRecruiters' careers pages sit behind DataDome
 * and this repo treats them as human-only for the application itself; that is a
 * statement about a browser filling a form, not about a documented public JSON
 * endpoint, which answered this scanner's User-Agent first time.
 */
export function smartRecruitersApiUrl(value) {
  const url = parse(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (host !== "jobs.smartrecruiters.com" && host !== "careers.smartrecruiters.com") return null;
  const path = segments(url);
  if (path.length < 2) return null;
  const org = path[0];
  const id = /^(\d+)/.exec(path[1])?.[1];
  if (!org || !id) return null;
  return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(org)}/postings/${id}`;
}

/**
 * A SmartRecruiters posting's sections, in the order the vendor returns them.
 *
 * Four of them on a typical posting — companyDescription, jobDescription,
 * qualifications, additionalInformation — and `additionalInformation` is the
 * long one (6,241 characters on the posting this was verified against), holding
 * the pay and the work-authorisation boilerplate. Titles are kept and put on
 * their own line: they are the headings a reader sees, and dropping them would
 * run "Qualifications" into the first requirement under it.
 */
export function smartRecruitersDescription(body) {
  const sections = json(body)?.jobAd?.sections;
  if (!sections || typeof sections !== "object") return null;
  const parts = [];
  for (const section of Object.values(sections)) {
    if (!section || typeof section !== "object") continue;
    parts.push(nonEmpty(section.title), nonEmpty(section.text));
  }
  return nonEmpty(joinBlocks(parts));
}

/* ───────────────────────────────── iCIMS ────────────────────────────────── */

/**
 * The same iCIMS posting, asked for the way its own iframe asks.
 *
 *   https://careersen-mackenzieinvestments.icims.com/jobs/5993/job
 *   https://careersen-mackenzieinvestments.icims.com/jobs/5993/job?mode=job&in_iframe=1
 *
 * NOT JSON — iCIMS has no public posting API, and this is the same HTML door
 * with the chrome turned off. It earns its place on the measurement: the plain
 * URL stripped to 295 characters of navigation and cookie notice, well under the
 * readable floor, and the iframe form to 6,371 characters of description. The
 * outer page loads the description into an iframe, so fetching the outer page
 * fetches the frame around the answer.
 *
 * VERIFIED LIVE on careersen-mackenzieinvestments.
 *
 * IT DOES NOT ALWAYS WORK, and nothing here pretends otherwise: ten of the
 * fifteen unread iCIMS rows answer http_410, which is a deleted posting and no
 * URL shape will bring it back. When the iframe form comes back under the floor
 * the posting stays `unread` — the one thing this must never do is manufacture a
 * read out of a page it could not read.
 *
 * Any `*.icims.com` host, not just `careers-<org>`: the board carries
 * `careersen-`, `careersus-`, `career-`, `campus-globalcareers-` and bare
 * `careers-` prefixes, all with the identical `/jobs/<id>/<slug>` grammar.
 */
export function icimsFrameUrl(value) {
  const url = parse(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (host !== "icims.com" && !host.endsWith(".icims.com")) return null;
  const path = segments(url);
  if (path[0] !== "jobs" || !path[1] || !/^\d+$/.test(path[1])) return null;
  return `https://${url.hostname}/jobs/${path[1]}/job?mode=job&in_iframe=1`;
}

/* ─────────────────────────────── the picker ─────────────────────────────── */

/** What every reader answers with. `accept` is the header the endpoint wants. */
const HTML_ACCEPT = "text/html,application/xhtml+xml";
const JSON_ACCEPT = "application/json";

/**
 * The reader for a posting URL, or null for "fetch it as HTML like always".
 *
 * ORDER IS BY HOST AND THE HOSTS ARE DISJOINT, so this is a lookup and not a
 * priority list — each `*Url` function above answers only for its own vendor and
 * null for everyone else, and the anti-vacuity tests assert exactly that.
 *
 * `sameHost` is the field the caller acts on when the endpoint refuses us. A 403
 * from `api.ashbyhq.com` says nothing about `jobs.ashbyhq.com` and the HTML
 * fetch should still happen; a 403 from a Workday tenant's own CXS path is that
 * tenant refusing us, and there is no point asking the same host for the shell
 * it would have refused too.
 *
 * `shared` marks an endpoint that answers for MANY postings — Ashby's board API
 * is the only one — so the caller can fetch it once per run instead of once per
 * posting.
 */
export function postingReader(value) {
  const url = parse(value);
  if (!url) return null;

  const ashby = ashbyBoardUrl(url.toString());
  if (ashby) {
    return {
      name: "ashby-api",
      url: ashby.url,
      accept: JSON_ACCEPT,
      sameHost: false,
      shared: true,
      extract: (body) => ashbyDescription(body, ashby.jobId),
    };
  }

  const greenhouse = greenhouseApiUrl(url.toString());
  if (greenhouse) {
    return {
      name: "greenhouse-api",
      url: greenhouse,
      accept: JSON_ACCEPT,
      sameHost: false,
      shared: false,
      extract: greenhouseDescription,
    };
  }

  const lever = leverApiUrl(url.toString());
  if (lever) {
    return {
      name: "lever-api",
      url: lever,
      accept: JSON_ACCEPT,
      sameHost: false,
      shared: false,
      extract: leverDescription,
    };
  }

  const workday = workdayCxsUrl(url.toString());
  if (workday) {
    return {
      name: "workday-cxs",
      url: workday,
      accept: JSON_ACCEPT,
      sameHost: true,
      shared: false,
      extract: workdayDescription,
    };
  }

  const smartRecruiters = smartRecruitersApiUrl(url.toString());
  if (smartRecruiters) {
    return {
      name: "smartrecruiters-api",
      url: smartRecruiters,
      accept: JSON_ACCEPT,
      sameHost: false,
      shared: false,
      extract: smartRecruitersDescription,
    };
  }

  const icims = icimsFrameUrl(url.toString());
  if (icims) {
    return {
      name: "icims-iframe",
      url: icims,
      accept: HTML_ACCEPT,
      sameHost: true,
      shared: false,
      // Already HTML. The stripper runs on it exactly as it would on the page
      // this replaced, so there is nothing to extract — only to hand along.
      extract: (body) => nonEmpty(body),
    };
  }

  return null;
}

/** Every reader name this file can produce. The Report step counts by these. */
export const READER_NAMES = [
  "ashby-api",
  "greenhouse-api",
  "lever-api",
  "workday-cxs",
  "smartrecruiters-api",
  "icims-iframe",
];
