/**
 * A sponsorship barrier stated in a posting's own words, or nothing at all.
 *
 * WHY THIS EXISTS. `listings.sponsorship` carries upstream's note, and
 * `normalizeSponsorship` in apps/mcp/src/listings/sponsorship.ts turns that note
 * into the tri-state the Apply tab filters on. Both are correct and both are
 * idle: upstream writes the literal string "Other" for every entry its Simplify
 * scraper produces, and this board is Simplify-sourced. Measured against
 * production on 21 August 2026: 864 listings, one distinct value, 864 of them
 * `open`. Upstream's 14,495 entries hold 109 real sponsorship values and not one
 * belongs to a Summer 2027 posting — every one comes from a human contributor
 * filing an entry by hand. The filter was never broken. It has never had an
 * input.
 *
 * So the fact is read from the posting instead. That is a different KIND of
 * evidence from a curated note, and it needs a different rule.
 *
 * WHY NOT REUSE `normalizeSponsorship`. Because it is calibrated for one
 * sentence a human wrote about sponsorship, and a job description is ten
 * thousand characters of prose that happens to contain the word. Run over the
 * full text of 76 real postings it marked 8 as `citizenship_required`, and 5 of
 * those were wrong: three were equal-opportunity boilerplate naming citizenship
 * as a PROTECTED CLASS ("without regard to ... citizenship status"), one was a
 * sanctions questionnaire, one a restriction on three named nationalities. That
 * error is not symmetric with a miss. A false `no_sponsorship` HIDES a posting
 * from precisely the student who needs sponsorship, and they never learn it
 * existed — so every rule below is written to MISS rather than to guess.
 *
 * THE FOUR THINGS THAT ARE NOT A BARRIER, each of which cost a false positive
 * when it was absent:
 *
 *   boilerplate    "without regard to ... citizenship" is the opposite of a
 *                  requirement, and it is on most postings.
 *   a question     "If you do not require sponsorship, please type N/A" is a
 *                  form field, and "Do you now or in the future require
 *                  sponsorship?" is the screener every ATS asks.
 *   named states   "unable to obtain sponsorship for candidates who have
 *                  citizenship from Russia, Belarus or Iran" bars three
 *                  nationalities. Hiding that posting misleads everyone else.
 *   the candidate  "does not require sponsorship" describes the APPLICANT, not
 *                  what the employer offers, and reads both ways. Skipped: the
 *                  one true positive it would win is not worth the two it lost.
 *
 * EVERY VERDICT CARRIES ITS SENTENCE. `evidence` is the line the status was read
 * from, verbatim, and the row shows it — the same discipline
 * db/migrations/0010 states for upstream's note, that paraphrasing a
 * sponsorship clause is how a user is told they may apply for something they may
 * not. A student can read the sentence and disagree with us; a bare status is a
 * claim nobody can check.
 */

/**
 * The posting as lines a rule can be asked about.
 *
 * Block boundaries survive because the caller keeps them (see `postingText`):
 * a bullet list arrives from HTML as one run-on string, and a rule that reads
 * "no" from one bullet and "sponsor" from the next invents a sentence the
 * posting never contained. That was a real false positive before the split.
 *
 * The lookbehind keeps "U.S." whole — splitting on every period turned
 * "U.S. Person status (U.S. citizen ...) is required" into a fragment starting
 * mid-parenthesis, which is unreadable as evidence even when the verdict is
 * right.
 */
export function postingLines(text) {
  const out = [];
  for (const block of String(text ?? "").split("\n")) {
    for (const piece of block.split(/(?<![A-Z][.!?])(?<=[.!?])\s+/)) {
      const line = piece.trim();
      if (line.length > 12 && line.length <= 400) out.push(line);
    }
  }
  return out;
}

/** Non-discrimination prose. Names citizenship to PROTECT it. */
const BOILERPLATE =
  /without\s+regard\s+to|regardless\s+of|equal\s+(?:employment\s+)?opportunity|protected\s+veteran|affirmative\s+action|discriminat|all\s+qualified\s+applicants|protected\s+class/i;

/** A form asking the candidate, rather than the employer stating a bar. */
const ASKS =
  /\?|\bif\s+you\b|\bare\s+you\b|\bdo\s+you\b|\bwill\s+you\b|please\s+(?:type|select|indicate|answer|note|complete)|check\s+(?:all|one)|\bN\/A\b/i;

/**
 * A bar on named nationalities, or an export-control clause. Real, and not the
 * question this column answers — the filter means "this posting will not
 * sponsor", and these postings will, for almost everyone.
 */
const NATIONALITY_SPECIFIC =
  /\bfrom\s+(?:russia|belarus|iran|cuba|north\s+korea|syria|venezuela|china)\b|citizens?\s+of\s+(?:russia|belarus|iran|cuba|north\s+korea|syria)|sanction|export\s+control|embargo|itar/i;

/**
 * The employer declining to sponsor. The negated verb has to be about
 * PROVIDING sponsorship: "does not include questions related to visa
 * sponsorship" is a sentence about an FAQ, and it matched a looser rule.
 */
const REFUSES =
  /\b(?:do(?:es)?\s+not|cannot|can\s?not|can't|will\s+not|won'?t|unable\s+to|not\s+able\s+to)\s+(?:\w+\s+){0,3}?(?:sponsor\b|provide\s+(?:visa\s+|immigration\s+|employment\s+)?sponsor|offer\s+(?:visa\s+|immigration\s+|employment\s+)?sponsor)/i;

/** The same refusal in the passive, which is how most postings word it. */
const NOT_AVAILABLE =
  /sponsorship\s+is\s+not\s+(?:available|offered|provided|possible)|not\s+eligible\s+for\s+(?:employment\s+|visa\s+|immigration\s+)?(?:visa\s+)?sponsor|no\s+(?:visa\s+|immigration\s+|employment\s+)?sponsorship\s+(?:is\s+)?(?:available|offered|provided)|work\s+(?:in\s+the\s+u\.?s\.?\s+)?without\s+(?:the\s+need\s+for\s+)?(?:visa\s+|immigration\s+)?sponsorship/i;

const CITIZEN_TERM =
  /\bu\.?s\.?\s*citizen|\bcitizenship\b|green\s*card|lawful\s+permanent\s+resident|permanent\s+resident|\bu\.?s\.?\s*person\b/i;

/** Citizenship named as a condition, not merely mentioned. */
const REQUIREMENT =
  /\bmust\s+be\b|\bis\s+required\b|\bare\s+required\b|\brequires\b|\brequired\s+to\b|\bonly\b|\beligibility\b/i;

/**
 * One posting's text, as a status and the sentence it came from.
 *
 * `open` here means exactly what it means in 0010: NO STATED BARRIER. It is not
 * a promise that sponsorship is offered, and for text this rule could not read
 * — a JavaScript shell, a page that would not fetch — it is also what "we did
 * not look" produces. The caller records WHETHER a posting was read separately;
 * see `sponsorshipScanned` in the mirror.
 */
export function classifyPostingText(text) {
  for (const line of postingLines(text)) {
    if (BOILERPLATE.test(line) || ASKS.test(line) || NATIONALITY_SPECIFIC.test(line)) continue;
    if (CITIZEN_TERM.test(line) && REQUIREMENT.test(line)) {
      return { status: "citizenship_required", evidence: line };
    }
    if (REFUSES.test(line) || NOT_AVAILABLE.test(line)) {
      return { status: "no_sponsorship", evidence: line };
    }
  }
  return { status: "open", evidence: null };
}
