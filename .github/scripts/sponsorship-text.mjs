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
 * A bar on named nationalities, or a sanctions clause. Real, and not the
 * question this column answers — the filter means "this posting will not take
 * a student who is not a US citizen", and these postings will, for almost
 * everyone. A line naming citizenship OF ANOTHER COUNTRY ("citizenship of
 * Australia, Japan, … or a NATO country", measured on an ITAR posting) is in the
 * same class: which nationalities clear it is not ours to decide for anybody.
 *
 * `itar` and `export control` USED TO BE HERE, and that was the one error in
 * this list that ran the expensive way. An export-control line that says
 * "applicants must be U.S. persons" is exactly a citizenship-or-residency gate —
 * the student it bars is the one who reads this board for that answer — and
 * skipping every line that named ITAR skipped the requirement with the
 * boilerplate. They are now read like any other line: a bare mention of ITAR
 * names no requirement and marks nothing (`CITIZEN_TERM` and `REQUIREMENT` must
 * both be present), and a stated US-person requirement is a bar.
 */
const NATIONALITY_SPECIFIC =
  /\bfrom\s+(?:russia|belarus|iran|cuba|north\s+korea|syria|venezuela|china)\b|citizens?\s+of\s+(?:russia|belarus|iran|cuba|north\s+korea|syria)|sanction|embargo|\bcitizens?(?:hip)?\s+(?:of|from)\s+(?!(?:the\s+)?(?:u\.?s\.?a?\b|united\s+states))/i;

/**
 * The employer declining to sponsor. The negated verb has to be about
 * PROVIDING sponsorship: "does not include questions related to visa
 * sponsorship" is a sentence about an FAQ, and it matched a looser rule.
 */
const REFUSES =
  /\b(?:do(?:es)?\s+not|cannot|can\s?not|can't|will\s+not|won'?t|unable\s+to|not\s+able\s+to)\s+(?:\w+\s+){0,3}?(?:sponsor\b|provide\s+(?:visa\s+|immigration\s+|employment\s+)?sponsor|offer\s+(?:visa\s+|immigration\s+|employment\s+)?sponsor)/i;

/** The same refusal in the passive, which is how most postings word it. */
const NOT_AVAILABLE =
  /sponsorship\s+(?:is\s+)?not\s+(?:available|offered|provided|possible)|not\s+eligible\s+for\s+(?:employment\s+|visa\s+|immigration\s+)?(?:visa\s+)?sponsor|no\s+(?:visa\s+|immigration\s+|employment\s+)?sponsorship\s+(?:is\s+)?(?:available|offered|provided)|work\s+(?:in\s+the\s+u\.?s\.?\s+)?without\s+(?:the\s+need\s+for\s+)?(?:visa\s+|immigration\s+)?sponsorship/i;

const CITIZEN_TERM =
  /\bu\.?s\.?\s*citizen|\bcitizenship\b|green\s*card|lawful\s+permanent\s+resident|permanent\s+resident|\bu\.?s\.?\s*person\b/i;

/** Citizenship named as a condition, not merely mentioned. */
const REQUIREMENT =
  /\bmust\s+be\b|\bis\s+required\b|\bare\s+required\b|\brequires\b|\brequired\s+to\b|\bonly\b|\beligibility\b/i;

/**
 * A security clearance, named as a kind of clearance rather than as a word.
 *
 * A clearance is a citizenship requirement in all but name: a US security
 * clearance is granted to US citizens, so "Ability to obtain a Secret
 * clearance" bars every student who is not one exactly as "Must be a U.S.
 * citizen" does. Measured on 27 September 2026: twenty-seven open Booz Allen
 * internships carried that line and nothing else about citizenship, and all of
 * them were on the board as "no barrier found".
 *
 * The qualifier is required. "Clearance" alone is customs, a medical form, a
 * sale — and "Security Clearance Type:" is a HEADING whose answer is often
 * "None/Not Required" on the next line (RTX writes it that way).
 */
const CLEARANCE =
  /\b(?:security|secret|top[\s-]+secret|ts\s*\/\s*sci|ts|sci|dod|doe|q|l|government|federal)\s+(?:security\s+)?clearance\b/i;

/** The clearance is something the applicant must have or be able to get. */
const CLEARANCE_NEEDED =
  /\b(?:able|ability)\s+to\s+(?:obtain|maintain|hold|get|acquire)\b|\bmust\b|\brequired\b|\brequires\b|\brequirement|\beligib(?:le|ility)\b|\b(?:obtain|possess|hold|maintain)\b|\bactive\b|\bcurrent\b/i;

/**
 * Wording that makes a named requirement optional, absent or hypothetical. A
 * clearance that is "a plus", "preferred" or "not required" bars nobody, and
 * "may need to meet eligibility requirements" is a hedge a rule cannot read as
 * a yes.
 */
const OPTIONAL =
  /\bnot\s+(?:required|needed|necessary)\b|\bnone\b|\bprefer|\ba\s+plus\b|\bnice\s+to\s+have\b|\bbonus\b|\bdesired\b|\badvantage|\bmay\s+(?:need|be\s+required|require)\b|\bif\s+(?:needed|required|applicable)\b/i;

/**
 * A heading that opens a list of things the employer would LIKE, not things it
 * requires. Booz Allen lays a posting out as "You Have:" then "Nice If You
 * Have:"; a clearance under the second is a preference.
 *
 * READ FOR THE CLEARANCE RULE ONLY. A posting's sections do not reliably end:
 * Genworth's "Nice To Have" list runs straight into "At this time, Genworth will
 * not sponsor …" under a heading this reader cannot see, and Astranis puts its
 * citizenship requirement after "Bonus". Applied to every rule, the section
 * erased three bars revision 6 had found, so the older rules ignore it and only
 * the new one — whose whole risk is a clearance that was merely welcome — asks.
 */
const PREFERRED_HEADING =
  /\b(?:nice\s+(?:if|to)|prefer|bonus|pluses|a\s+plus|desired|optional|good\s+to\s+have)\b/i;

/** Words a section heading is made of. */
const HEADING_WORDS =
  /\b(?:requirements?|qualifications?|you\s+(?:have|bring|need|are|will)|responsibilities|what\s+(?:you|we)|about\s+(?:you|the\s+(?:role|team|job)|us)|benefits|compensation|skills|experience|education|nice\s+(?:if|to)|preferred|bonus|pluses|desired)\b/i;

/**
 * A heading, never a statement: a short line ending in a colon, or a short
 * title-like line — four words at most, no punctuation — that names a section.
 *
 * The second kind is measured, not guessed. Motorola Solutions writes
 * "Preferred Skills:" WITH a colon and then "Basic Requirements" WITHOUT one,
 * and a reader that only knew the first shape carried "preferred" into the
 * requirements and missed "Must be a US Citizen, permanent resident …" — a bar
 * revision 6 had found.
 */
function isHeading(line) {
  if (line.length <= 80 && /:\s*$/.test(line)) return true;
  return (
    line.split(/\s+/).length <= 4 &&
    /^[A-Z]/.test(line) &&
    !/[.!?;,]/.test(line) &&
    HEADING_WORDS.test(line)
  );
}

/**
 * The posting's lines, each with whether it sits under a "preferred" heading.
 *
 * `postingLines` drops short lines, and a heading is usually one ("You Have:"
 * is nine characters), so the section is tracked over the raw pieces rather than
 * over its output. A heading line is never itself classified.
 */
function readSections(text) {
  const out = [];
  let preferred = false;
  for (const block of String(text ?? "").split("\n")) {
    for (const piece of block.split(/(?<![A-Z][.!?])(?<=[.!?])\s+/)) {
      const line = piece.trim();
      if (!line) continue;
      if (isHeading(line)) {
        preferred = PREFERRED_HEADING.test(line);
        continue;
      }
      if (line.length > 12 && line.length <= 400) out.push({ line, preferred });
    }
  }
  return out;
}

/**
 * One posting's text, as a status and the sentence it came from.
 *
 * `open` here means exactly what it means in 0010: NO STATED BARRIER. It is not
 * a promise that sponsorship is offered, and for text this rule could not read
 * — a JavaScript shell, a page that would not fetch — it is also what "we did
 * not look" produces. The caller records WHETHER a posting was read separately;
 * see `sponsorshipScanned` in the mirror.
 *
 * THE STRICTER BAR WINS ACROSS THE WHOLE POSTING, not merely within a line. A
 * posting that says "we do not sponsor" in one paragraph and "must be able to
 * obtain a Secret clearance" in another bars a non-citizen twice, and the
 * honest summary is the citizenship bar — the same precedence
 * `normalizeSponsorship` applies inside one note. Until revision 7 the first
 * matching line won whichever it was.
 *
 * `citizenship_required` covers every gate only a US citizen (or, for the
 * export-control wording, a permanent resident) can clear: citizenship, a green
 * card, US-person status, and a security clearance. The evidence sentence says
 * which one it was.
 */
export function classifyPostingText(text) {
  let refusal = null;
  for (const { line, preferred } of readSections(text)) {
    if (BOILERPLATE.test(line) || ASKS.test(line) || NATIONALITY_SPECIFIC.test(line)) continue;
    if (CITIZEN_TERM.test(line) && REQUIREMENT.test(line)) {
      return { status: "citizenship_required", evidence: line };
    }
    if (!preferred && CLEARANCE.test(line) && CLEARANCE_NEEDED.test(line) && !OPTIONAL.test(line)) {
      return { status: "citizenship_required", evidence: line };
    }
    if (!refusal && (REFUSES.test(line) || NOT_AVAILABLE.test(line))) refusal = line;
  }
  return refusal
    ? { status: "no_sponsorship", evidence: refusal }
    : { status: "open", evidence: null };
}
