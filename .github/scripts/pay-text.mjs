/**
 * What a posting SAYS it pays, or nothing at all.
 *
 * WHY THIS EXISTS. There is no pay data anywhere in this product. The `listings`
 * table carries sponsorship and injection columns and nothing about money, and
 * upstream's listings.json has no pay field of any kind — measured on the live
 * 14,495-entry file: no `salary`, no `compensation`, no `pay`, no `min`/`max`.
 * The only place a number exists is the POSTING, which this Action already
 * fetches once per row for the sponsorship and injection reads. So the third
 * question is asked of the same bytes, in the same pass, and the answer travels
 * in the mirror beside the other two.
 *
 * The question a student is actually asking is "hide the ones that pay badly".
 * That needs a comparable number, and the postings state theirs in every unit
 * anyone has ever used: `$35/hr`, `$6,000 per month`, `$70k - $90k annually`,
 * `1,200 weekly`. The period is kept as the posting stated it — the row prints
 * `$35–45/hr`, not a monthly figure nobody wrote — and a monthly EQUIVALENT is
 * computed once, at write time, so the filter is one comparison. Both halves
 * come from here.
 *
 * ── THE ERROR BUDGET, WHICH IS SPONSORSHIP'S AND NOT INJECTION'S ────────────
 *
 * A number read from this file HIDES A JOB. That is the same shape
 * sponsorship-text.mjs is built around and the opposite of injection-text.mjs's:
 * a false LOW reading takes a well-paid role off the board of the exact student
 * who needed it, and they never learn it existed, while a MISS merely leaves the
 * row unfiltered beside every other row that never stated a rate. So every rule
 * below is written to miss rather than to guess, and every ambiguity — two
 * different period words with nothing tying either to the amount, a figure
 * qualified as a bonus, a number with no currency on it — returns null.
 *
 * ── WHAT COUNTS AS A FIGURE ────────────────────────────────────────────────
 *
 * A currency amount and a period word, in ONE sentence, and the period has to be
 * attributable to that amount:
 *
 *   attached    the period rides the amount — `$35/hr`, `$35 per hour`,
 *               `$35 an hour`, `$5,500 monthly`, `$70k - $90k per year`. This is
 *               unambiguous and is used as-is.
 *   the clause  no marker on the amount, but the sentence names EXACTLY ONE
 *               period — `annual salary of $72,000`, `hourly rate: $38`. One is
 *               the whole condition: "interns work 40 hours per week and receive
 *               a stipend of $6,000" names two, and which one the $6,000 belongs
 *               to is a guess, so it is skipped.
 *
 * A number with no currency marker anywhere near it is never money. "30 hours per
 * week" is the sentence this rule exists for: two period words, a number, and
 * nothing about pay at all.
 *
 * ── WHAT IS NOT PAY, EVEN THOUGH IT IS MONEY AND HAS A PERIOD ──────────────
 *
 *   the perks       relocation, housing, signing/sign-on, bonus, equity, stock,
 *                   benefits, tuition, travel, meals, commuter, wellness. Tested
 *                   against the WINDOW around the amount rather than the whole
 *                   sentence, so "the hourly rate is $40 and there is a $5,000
 *                   relocation bonus" keeps the $40 and drops the $5,000. A
 *                   sentence-wide test would have dropped both, which is a miss
 *                   this file can avoid rather than one it has to accept.
 *   the other job   "full-time base salary", "upon conversion", "new grad" — an
 *                   intern posting routinely prints the salary of the job the
 *                   internship converts INTO, and reading that as the
 *                   internship's pay would put a $180,000 row on a board of
 *                   $6,000 ones. Tested against the SENTENCE, because that is
 *                   where the qualification is stated.
 *
 * A plain "monthly stipend of $5,000" IS pay. `stipend` is what half this board
 * calls an internship salary; only a stipend qualified as being FOR travel,
 * relocation or housing is a perk.
 *
 * ── THE ENDS OF A RANGE, AND A FLOOR THAT IS NOT ONE ───────────────────────
 *
 * The first live pass over 292 postings produced exactly two wrong readings, and
 * both were about where a range STOPS:
 *
 *   a bare second half   "ranges from $1,000 weekly to 2,000 weekly" read as a
 *                        flat $1,000. The currency mark rides the first figure
 *                        only, and " weekly to " is not a dash, so the two ends
 *                        were never seen as one range. A second figure with no
 *                        mark of its own is now the TOP of the range when
 *                        nothing but the first amount's own period word and a
 *                        dash-or-"to" separates them, and any period word on the
 *                        second end agrees with the first's. The join word stays
 *                        the whole gate: `$25/hr for 40 hours` and `$20/hour and
 *                        2 weeks of housing` put a bare number after a rate too,
 *                        and neither is a range.
 *   a floor with no top  "Pay rates begin at $20/hour and increase for each
 *                        undergraduate year completed" read as a MAXIMUM of $20
 *                        — a figure the same sentence denies. A posting naming
 *                        only where pay starts has named no maximum, so it gets
 *                        no verdict at all and the row stays unfiltered. `up to
 *                        $32` is the mirror image and is kept: it names a
 *                        ceiling, and the ceiling is the half the filter reads.
 *
 * ── CURRENCY IS STORED AND SHOWN, AND ONLY USD IS EVER COMPARED ────────────
 *
 * `$` alone is USD unless the sentence says otherwise; `C$`, `CA$` and a `CAD`
 * anywhere in the sentence make it CAD, and `A$`/`AUD`, `€`, `£`, `₹` name
 * themselves. Everything downstream stores and prints whatever comes back, and
 * the threshold filter looks at USD rows only — a C$5,500 month is not a $5,500
 * month, and pretending otherwise to make one comparison work would hide
 * Canadian roles on an exchange rate nobody wrote down.
 *
 * NO DEPENDENCIES, NOT TYPESCRIPT, for the reason scan-sponsorship.mjs and
 * mirror-listings.mjs give: this runs on a bare `actions/setup-node` with no
 * install step. `toProse` is imported from ./injection-text.mjs rather than
 * written again — the entity decoding, the `<script>` stripping and the
 * invisible-character removal are the same job here, and a second copy of them
 * is a second thing to keep in step.
 */
import { toProse } from "./injection-text.mjs";

/* ─────────────────────────── the shared arithmetic ───────────────────────── */

/**
 * Hours in a month of work: 40 × 52 ÷ 12, to two places.
 *
 * The figure everyone uses to annualise an hourly rate, and it is a CONVENTION
 * rather than a measurement — an intern working 37.5 hours makes less, one on a
 * 10-week summer makes less again. It is used identically on both sides of the
 * pipe, which is the property that matters: the number that decides whether a
 * row is hidden must be the number the row was written with.
 */
export const HOURS_PER_MONTH = 173.33;

/** Weeks in a month: 52 ÷ 12. Same convention, same reason. */
export const WEEKS_PER_MONTH = 4.333;

/** Months in a year. Not a convention. */
export const MONTHS_PER_YEAR = 12;

/** The periods a posting may state, as the closed set every layer validates against. */
export const PAY_PERIODS = ["hour", "week", "month", "year"];

/**
 * The currencies this file can name, as ISO 4217 codes.
 *
 * Closed, and short on purpose: a code here is a code the mirror parser, the
 * column and the dashboard all have to accept, and a currency nothing can detect
 * is a value that can only arrive by accident.
 */
export const PAY_CURRENCIES = ["USD", "CAD", "EUR", "GBP", "INR", "AUD"];

/**
 * One stated figure as a monthly number, in its own currency.
 *
 * THE ONE PLACE THIS ARITHMETIC LIVES. `pay_monthly_max` is computed with it at
 * write time so the board's filter is a single column comparison, and the Worker
 * imports the constants above through a test rather than restating them — see
 * apps/mcp/test/the-mirror-writes-what-the-worker-reads.test.ts for the pattern
 * and the-two-sides-agree-on-what-a-month-is-worth.test.ts for this one. Two
 * copies of 173.33 is how a row gets hidden by a number that disagrees with the
 * number printed beside it.
 *
 * Takes the MAX, because that is the figure a floor is honestly compared
 * against: a posting advertising $30–$45 an hour is a posting that pays up to
 * $45, and hiding it against a $35 floor on the strength of its bottom end would
 * hide a job the reader could have taken.
 */
export function monthlyEquivalent(pay) {
  const max = Number(pay?.max);
  if (!Number.isFinite(max)) return null;
  switch (pay?.period) {
    case "hour":
      return max * HOURS_PER_MONTH;
    case "week":
      return max * WEEKS_PER_MONTH;
    case "month":
      return max;
    case "year":
      return max / MONTHS_PER_YEAR;
    default:
      return null;
  }
}

/* ───────────────────────────── the vocabulary ────────────────────────────── */

/** Currency symbols, longest first so `CA$` is never read as `A$`. */
const SYMBOL = String.raw`CA\$|C\$|A\$|US\$|\$|€|£|₹`;

/** ISO codes a posting spells out, beside or instead of a symbol. */
const CODE = String.raw`USD|CAD|EUR|GBP|INR|AUD`;

/**
 * A number as a posting writes one: `35`, `35.00`, `1,200`, `70,000.00`.
 *
 * The grouped form is FIRST in the alternation, because `\d+` would otherwise
 * match `70` out of `70,000` and leave `,000` to be read as another figure.
 */
const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;

/**
 * One amount, with whatever currency marker it happens to carry.
 *
 * Every part but the number is optional here — a bare number is matched so that
 * the range grouping below can see `$35 - 45` as one figure — and the decision
 * about whether a match is MONEY at all is made afterwards, from whether a
 * marker was found on it or on its partner.
 *
 * The lookbehind stops a match starting inside a longer token: without it,
 * `R5049957` in a Workday requisition would yield `5049957`.
 */
const AMOUNT = new RegExp(
  String.raw`(?<![\w$€£₹])(?:(${SYMBOL})\s*|\b(${CODE})\s*)?(${NUMBER})\s*([kK])?(?:\s*\b(${CODE})\b)?`,
  "g",
);

/**
 * The text allowed BETWEEN two amounts of one range.
 *
 * Nothing but a dash or the word "to". `and` is deliberately absent: "we offer
 * $6,000 per month and $2,000 in relocation" is two figures, not a range from
 * six thousand to two, and the sentences that would have needed it ("between $35
 * and $45") are rare enough not to be worth the ones it would break.
 */
const RANGE_JOIN = /^\s*(?:-|–|—|−|to|through)\s*$/i;

/**
 * The word that ANNOUNCES a range, read from the text in front of its first
 * amount.
 *
 * Needed only for the mirrored shape, where the currency mark rides the SECOND
 * figure and the first is a bare number: "the rate ranges from 1,000 to $2,000
 * per week". That is also the shape "Summer 2027 - $6,000 per month" takes, and
 * 2027 is not money, so a bare first half is joined only when the sentence said
 * a range was coming or when both ends carry the same period word.
 */
const RANGE_OPENER = /\bfrom\s*$/i;

/**
 * A period word, as the four values the column holds.
 *
 * Ordered longest-first inside each period so `hourly` is never matched as `hour`
 * with a dangling `ly`, and `month` never as `mo`.
 */
const PERIOD_WORDS = [
  ["hour", /^(?:hourly|hours|hour|hrs|hr)\b/i],
  ["week", /^(?:weekly|weeks|week|wks|wk)\b/i],
  ["month", /^(?:monthly|months|month|mos|mo)\b/i],
  ["year", /^(?:annualized|annualised|annually|annual|annum|yearly|years|year|yrs|yr)\b/i],
];

/** The same words, for asking whether a SENTENCE names a period at all. */
const PERIOD_IN_TEXT = [
  ["hour", /\b(?:hourly|hours?|hrs?)\b/i],
  ["week", /\b(?:weekly|weeks?|wks?)\b/i],
  ["month", /\b(?:monthly|months?)\b/i],
  ["year", /\b(?:annualized|annualised|annually|annual|per\s+annum|yearly|years?)\b/i],
];

/**
 * What may sit between an amount and its period word.
 *
 * `/hr`, ` per hour`, ` an hour`, ` a year`, ` hourly` — and nothing else. A
 * comma is allowed because "$6,000, paid monthly" is a shape postings use.
 */
const PERIOD_LEAD = String.raw`(?:\/\s*|per\s+|an\s+|a\s+|paid\s+|,?\s*)?`;

/**
 * Money that is not pay: the perks a posting lists beside the rate.
 *
 * Tested against the window around ONE amount, not the sentence — see the
 * header. `stipend` is absent on purpose and `stipend for travel|relocation|
 * housing` is present instead: half this board calls an internship salary a
 * stipend, and dropping the word wholesale would drop the pay it is asking for.
 */
const PERK =
  /\b(?:relocation|reloc\b|housing|accommodation|lodging|sign[- ]?on|signing|bonus|bonuses|equity|rsus?\b|stock|options?\s+grant|benefits?|tuition|reimbursement|reimburse|allowance|travel|airfare|flights?|meals?|food|commuter|transit|wellness|referral|retention|401\s?\(?k\)?|matching\s+contribution|scholarship|award|prize)\b/i;

/**
 * The OTHER job's number: the salary of the full-time role this internship
 * converts into, which an intern posting routinely prints beside its own rate.
 *
 * Tested against the SENTENCE, because that is where the qualification is made.
 * Deliberately NOT a bare `full[- ]time`: "this is a full-time internship paying
 * $40/hour" is an ordinary posting, and the words that make it somebody else's
 * salary are the ones that follow.
 */
const OTHER_ROLE =
  /\bfull[- ]?time\s+(?:base\s+)?(?:salary|salaries|pay|compensation|comp\b|offer|employees?|hires?|conversion)\b|\b(?:base\s+)?salar(?:y|ies)\s+(?:for|of|as)\s+(?:a\s+)?full[- ]?time\b|\bupon\s+conversion\b|\bif\s+converted\b|\bpost[- ]conversion\b|\bconversion\s+to\s+full[- ]?time\b|\breturn\s+offer\s+salary\b|\bnew\s+grad(?:uate)?s?\b|\bpost[- ]graduation\s+(?:salary|pay|compensation)\b/i;

/**
 * What a stated figure may plausibly be, per period.
 *
 * A guard against a number that cleared every rule above and is still not a
 * rate: a "$4 per hour" that was really a fee, a "$2,000,000 annually" that was
 * a funding round in a sentence that also named a year. Both ends are far
 * outside anything an internship posting states, so nothing real is near them —
 * and the direction of the error is the one this file is careful about, since a
 * figure rejected here leaves the row UNFILTERED rather than hidden.
 */
const PLAUSIBLE = {
  hour: [5, 500],
  week: [100, 20_000],
  month: [400, 100_000],
  year: [5_000, 1_000_000],
};

/**
 * A floor with no ceiling, named in the words in front of a lone amount.
 *
 * "Pay rates for this position begin at $20/hour and increase for each
 * undergraduate year completed" states a minimum and says in the same breath
 * that the figure paid is higher. Reading the $20 as the maximum prints a number
 * the posting denies and hides the row against every floor above it, which is
 * this file's expensive error. There is no maximum in the sentence, so there is
 * no verdict, and the row goes back to being one of the hundreds that state no
 * rate — the miss this file prefers to a guess.
 *
 * Tested against a SINGLE figure only. A two-ended range has already said where
 * it stops, so the `from` here never touches "ranges from $35 to $45 an hour".
 *
 * `up to $32` is deliberately absent: a ceiling with no floor is a maximum, and
 * a maximum is exactly what the filter compares.
 */
const FLOOR_BEFORE =
  /\b(?:begins?|starts?|starting|commences?|commencing)\s+(?:at|from)\s*$|\bminimum\s+of\s*$|\bat\s+least\s*$|\bno\s+less\s+than\s*$|\bfrom\s*$/i;

/**
 * The same claim made AFTER the amount: `$20+`, `$20 an hour and up`.
 *
 * Read both immediately after the number and again after its period phrase,
 * because a posting writes the qualifier on either side of the unit.
 */
const FLOOR_AFTER = /^\s*(?:\+|and\s+up\b|and\s+(?:above|higher)\b|or\s+(?:more|above|higher)\b)/i;

/** How much of the sentence travels with the verdict. */
export const MAX_EVIDENCE_CHARS = 300;

/* ─────────────────────────────── the reading ─────────────────────────────── */

/** Sentences, in the order the posting has them. Bullets are their own lines. */
function sentences(prose) {
  const out = [];
  for (const block of prose.split("\n")) {
    // Split after terminal punctuation, but not after an initial — "U.S." and
    // "Ph.D." are one token, and a fragment starting mid-abbreviation is
    // unreadable as evidence even when the number in it is right. The same
    // lookbehind sponsorship-text.mjs's `postingLines` uses, for the same reason.
    for (const piece of block.split(/(?<![A-Z][.!?])(?<=[.!?])\s+/)) {
      const text = piece.trim();
      if (text) out.push(text);
    }
  }
  return out;
}

/** `70,000` -> 70000, `70` with a `k` -> 70000. */
function toNumber(digits, k) {
  const value = Number(String(digits).replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return k ? value * 1000 : value;
}

/** The ISO code a marker names, or null for a bare `$` (which the sentence decides). */
function codeOf(marker) {
  if (!marker) return null;
  const m = marker.toUpperCase();
  if (m === "CA$" || m === "C$" || m === "CAD") return "CAD";
  if (m === "A$" || m === "AUD") return "AUD";
  if (m === "US$" || m === "USD") return "USD";
  if (m === "€" || m === "EUR") return "EUR";
  if (m === "£" || m === "GBP") return "GBP";
  if (m === "₹" || m === "INR") return "INR";
  return null;
}

/**
 * Every amount-shaped token in one sentence, with where it sits.
 *
 * `leading` and `trailing` are kept apart rather than folded into one currency,
 * because the range rule below needs to know WHICH side a marker was on: a
 * trailing code applies to the whole range (`35 - 45 USD`), a leading symbol
 * applies to its own number (`Summer 2027 - $6,000` is not a range).
 */
function amountsIn(sentence) {
  const out = [];
  const re = new RegExp(AMOUNT.source, AMOUNT.flags);
  for (let m = re.exec(sentence); m; m = re.exec(sentence)) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const value = toNumber(m[3], m[4]);
    if (value === null) continue;
    out.push({
      value,
      // A bare `$` is a currency MARKER without being a currency: it makes the
      // token money, and which money it is, is the sentence's to say.
      bareDollar: m[1] === "$",
      leadingSymbol: Boolean(m[1]),
      symbolCode: codeOf(m[1]),
      leadingCode: codeOf(m[2]),
      trailing: codeOf(m[5]),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

/** Does this token carry a currency marker of any kind — symbol, code, bare `$`? */
function hasMarker(amount) {
  return Boolean(
    amount.bareDollar || amount.leadingSymbol || amount.leadingCode || amount.trailing,
  );
}

/**
 * A period word and whatever introduces it, used ONLY to spot a doubled unit.
 *
 * Written out rather than reusing PERIOD_LEAD + PERIOD_WORDS, because that pair
 * answers a different question — what unit rides THIS amount — and its lead
 * swallows the space in front of "per" before the branch that wants it. Here the
 * only question is whether another unit follows, so the leads are spelled with
 * the whitespace in front of them.
 */
const PERIOD_TAIL =
  /^\s*(?:per\s+|an?\s+|each\s+|\/\s*)?(?:hourly|hours?|hrs?|weekly|weeks?|wks?|monthly|months?|mos?|annualized|annualised|annually|annual|annum|yearly|years?|yrs?)\b/i;

/**
 * Is this amount a SCHEDULE — "40 hours per week" — rather than a sum of money?
 *
 * Asked only of an end that carries no currency mark, and only about the shape
 * that gives it away: two period words back to back. A stated rate names its
 * unit once ("2,000 weekly", "20.90 per hour"); a workload names it twice.
 */
function isSchedule(sentence, amount, phrase) {
  if (hasMarker(amount) || !phrase) return false;
  return PERIOD_TAIL.test(sentence.slice(phrase.end));
}

/**
 * Are these two amounts the two ends of ONE stated range?
 *
 * A pair is joined only when nothing but a dash or "to" — and, since the live
 * pass, the first amount's own period word — sits between them, AND the shape is
 * one a range actually takes. That second condition is what keeps "Summer 2027 -
 * $6,000 per month" from being read as a range from 2027 to 6,000.
 */
function joinsAsRange(sentence, first, second) {
  // A period word may ride the FIRST amount and still leave a range behind it.
  // "The pay ranges from $1,000 weekly to 2,000 weekly" was read as a flat
  // $1,000 because " weekly to " is not a dash; step over the phrase, then ask
  // the same question of what is left. The join word is doing all the work here
  // and is the reason `$25/hr for 40 hours` stays one figure — "for" is not a
  // range, and neither is the "and" of "$20/hour and 2 weeks of housing".
  const firstPhrase = periodPhraseAt(sentence, first.end);
  const gap = sentence.slice(firstPhrase ? firstPhrase.end : first.end, second.start);
  if (!RANGE_JOIN.test(gap)) return false;
  // A range runs upwards. Two figures the other way round are two figures.
  if (second.value < first.value) return false;
  // Two period words, both attached, and not the same one: whatever this is, the
  // two numbers are not one quantity stated at two ends.
  const secondPhrase = periodPhraseAt(sentence, second.end);
  if (firstPhrase && secondPhrase && firstPhrase.period !== secondPhrase.period) return false;
  // TWO period words on the BARE end, back to back, is a schedule and not a
  // rate: "40 hours per week" is the shape, and reading it as a ceiling would
  // print "$25 to $40 an hour" on a posting that pays $25 for a 40-hour week. A
  // real end of a range names its unit once.
  if (isSchedule(sentence, first, firstPhrase) || isSchedule(sentence, second, secondPhrase)) {
    return false;
  }

  // The ordinary shape: the mark is on the first half and the second half is a
  // bare number in the same sentence, under the same unit — `$18.00-27.50 per
  // hour`, `$1,000 weekly to 2,000 weekly`, `$18 - 27.50/hour`.
  if (hasMarker(first)) return true;

  // The mirrored shape, where the mark rides the SECOND amount. A trailing ISO
  // code governs both halves ("35 - 45 USD"). Otherwise a bare first half has to
  // earn it — by carrying the same period word as the marked half, or by the
  // sentence having announced a range — because "Summer 2027 - $6,000 per month"
  // is this shape too and 2027 is not the bottom of anything.
  if (second.trailing && !second.leadingSymbol) return true;
  if (firstPhrase && secondPhrase && firstPhrase.period === secondPhrase.period) return true;
  return RANGE_OPENER.test(sentence.slice(0, first.start));
}

/**
 * Amounts folded into the figures they state: singles, and two-ended ranges.
 *
 * The joining rule is `joinsAsRange` above; everything left over is a figure on
 * its own, and only the ones carrying a currency mark survive the filter.
 */
function figuresIn(sentence) {
  const amounts = amountsIn(sentence);
  const figures = [];
  for (let i = 0; i < amounts.length; i += 1) {
    const first = amounts[i];
    const second = amounts[i + 1];
    const joined = Boolean(second) && joinsAsRange(sentence, first, second);
    if (joined) {
      figures.push({ parts: [first, second], min: first.value, max: second.value });
      i += 1;
    } else {
      figures.push({ parts: [first], min: first.value, max: first.value });
    }
  }
  // Only the ones that carry money. A figure with no symbol and no code is a
  // number in a sentence, and the sentence is full of them.
  return figures.filter((f) => f.parts.some(hasMarker));
}

/**
 * The period phrase that starts at `index`, and where it ENDS.
 *
 * The end index is the half that makes a range readable across a unit: the text
 * between the two amounts of "$1,000 weekly to 2,000 weekly" is " weekly to ",
 * which is not a range join until the first amount's own period is stepped over.
 */
function periodPhraseAt(sentence, index) {
  const after = sentence.slice(index);
  const lead = new RegExp(`^${PERIOD_LEAD}`, "i").exec(after);
  const leadLength = lead ? lead[0].length : 0;
  const rest = after.slice(leadLength);
  for (const [period, re] of PERIOD_WORDS) {
    const word = re.exec(rest);
    if (word) return { period, end: index + leadLength + word[0].length };
  }
  return null;
}

/** The period word riding this figure, or null. */
function attachedPeriod(sentence, figure) {
  const phrase = periodPhraseAt(sentence, figure.parts[figure.parts.length - 1].end);
  return phrase ? phrase.period : null;
}

/** The one period this sentence names, or null when it names none or several. */
function clausePeriod(sentence) {
  const named = PERIOD_IN_TEXT.filter(([, re]) => re.test(sentence)).map(([period]) => period);
  return named.length === 1 ? named[0] : null;
}

/**
 * The currency this figure is in.
 *
 * An explicit marker on the figure wins. A bare `$` asks the SENTENCE — a
 * posting that wrote "CAD" or "C$" anywhere in the same sentence is quoting
 * Canadian dollars whichever amount carries the symbol — and defaults to USD,
 * which is what `$` means on a board of US internships.
 */
function currencyOf(sentence, figure) {
  for (const part of figure.parts) {
    const explicit = part.trailing ?? part.symbolCode ?? part.leadingCode;
    if (explicit) return explicit;
  }
  if (/\bCAD\b|CA\$|C\$|\bcanadian\s+dollars?\b/i.test(sentence)) return "CAD";
  if (/\bAUD\b|A\$|\baustralian\s+dollars?\b/i.test(sentence)) return "AUD";
  return "USD";
}

/** The sentence as it travels with the verdict: collapsed, and bounded. */
function evidenceOf(sentence) {
  return sentence.replace(/\s+/g, " ").trim().slice(0, MAX_EVIDENCE_CHARS);
}

/**
 * What one posting says it pays, or null.
 *
 * PURE, and the only function anything else calls. Takes description HTML or
 * plain text and returns `null` or `{ min, max, period, currency, evidence }`
 * with the amounts exactly as stated — `max === min` for a single figure — the
 * period as the posting worded it, an ISO currency code, and the sentence the
 * numbers were read from.
 *
 * WHEN SEVERAL FIGURES QUALIFY, THE HIGHEST MONTHLY EQUIVALENT WINS, keeping its
 * own period. A posting stating both "$35/hr" and "$6,000 per month" has stated
 * one thing twice at different precisions, and the larger is the one a floor
 * should be compared against for the reason `monthlyEquivalent` takes the max of
 * a range: hiding a job the reader could have taken is the expensive error here.
 * Ties break on the FIRST figure in the posting, so the same text always yields
 * the same row.
 */
export function extractPay(input) {
  const prose = toProse(input);
  if (!prose) return null;

  let best = null;
  let bestMonthly = -Infinity;

  for (const sentence of sentences(prose)) {
    // Somebody else's salary. Stated at the sentence level, so it is read there.
    if (OTHER_ROLE.test(sentence)) continue;

    const figures = figuresIn(sentence);
    if (figures.length === 0) continue;
    const fallback = clausePeriod(sentence);

    for (let i = 0; i < figures.length; i += 1) {
      const figure = figures[i];
      // THE WINDOW, not the sentence: from the end of the previous figure to the
      // start of the next, so a perk named beside a rate disqualifies the perk
      // and not the rate. See the header.
      const from = i === 0 ? 0 : figures[i - 1].parts[figures[i - 1].parts.length - 1].end;
      const to = i + 1 < figures.length ? figures[i + 1].parts[0].start : sentence.length;
      if (PERK.test(sentence.slice(from, to))) continue;

      // A floor with no ceiling is not a maximum. Single figures only — a range
      // has already stated where it stops, and its own "from" is not this.
      if (figure.parts.length === 1) {
        const only = figure.parts[0];
        const phrase = periodPhraseAt(sentence, only.end);
        if (FLOOR_BEFORE.test(sentence.slice(from, only.start))) continue;
        if (FLOOR_AFTER.test(sentence.slice(only.end, to))) continue;
        if (phrase && FLOOR_AFTER.test(sentence.slice(phrase.end, to))) continue;
      }

      const period = attachedPeriod(sentence, figure) ?? fallback;
      if (!period) continue;

      const band = PLAUSIBLE[period];
      if (figure.min < band[0] || figure.max > band[1]) continue;

      const currency = currencyOf(sentence, figure);
      const monthly = monthlyEquivalent({ max: figure.max, period });
      if (monthly === null) continue;
      if (monthly > bestMonthly) {
        bestMonthly = monthly;
        best = {
          min: figure.min,
          max: figure.max,
          period,
          currency,
          evidence: evidenceOf(sentence),
        };
      }
    }
  }

  return best;
}
