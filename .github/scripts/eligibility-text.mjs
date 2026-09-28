/**
 * Who a posting says may apply, beyond sponsorship: a graduation window, the
 * degree programmes it takes, the class years or year in school it wants, and
 * any rule about where the student studies.
 *
 * WHY THIS EXISTS. A cloud applying agent working twenty applications on
 * 28 September 2026 reached forms that ended the application on a question the
 * board could have answered first: "graduating between December 2026 and June
 * 2027", "PhD students only", "must be a rising senior", "open to students at
 * universities in Canada". Every one of those sentences was in the posting text
 * the scanner already fetches for the sponsorship read, so this is a fourth
 * question asked of the same bytes in the same pass, exactly as pay-text.mjs
 * was the third.
 *
 * ── THE ERROR BUDGET IS SPONSORSHIP'S ───────────────────────────────────────
 *
 * A rule read here HIDES A JOB from somebody. A false "PhD only" takes a role
 * away from every undergraduate who could have had it, and they never learn it
 * existed; a miss merely leaves the row unfiltered beside every other row that
 * stated nothing. So every rule below is written to MISS rather than guess:
 *
 *   - a line must carry the subject's own context (a graduation word for a
 *     date, an enrolment word for a degree, a school word for a school rule);
 *   - questions and form labels (a "?", "please select") are never read, since
 *     the Greenhouse embed and iCIMS frames carry the application form too;
 *   - a line in a "Preferred" / "Nice to have" section, or one worded as a
 *     preference, is not a requirement;
 *   - a line with a negation near the subject ("not open to PhD students") is
 *     skipped rather than inverted.
 *
 * Deterministic and dependency-free, for the reason every sibling in this
 * directory gives: it runs on a bare `actions/setup-node`. No model, ever.
 * apps/mcp/test/a-posting-says-who-may-apply.test.ts drives it over fixtures.
 */
import { readSections } from "./sponsorship-text.mjs";

/** The longest evidence sentence carried. The contract refuses longer. */
export const MAX_EVIDENCE_CHARS = 300;

/** A form asking the candidate rather than the employer stating a rule. */
const ASKS =
  /\?|\bif\s+you\b|\bare\s+you\b|\bdo\s+you\b|\bwill\s+you\b|please\s+(?:type|select|indicate|answer|note|complete|list|provide|enter)|check\s+(?:all|one)|select\.\.\./i;

/** Non-discrimination and EEO prose names degrees and schools to protect them. */
const BOILERPLATE =
  /without\s+regard\s+to|regardless\s+of|equal\s+(?:employment\s+)?opportunity|protected\s+veteran|affirmative\s+action|discriminat|all\s+qualified\s+applicants/i;

/** Worded as a preference rather than a condition. */
const PREFERENCE =
  /\bprefer(?:red|ably|ence)?\b|\ba\s+plus\b|\bnice\s+to\s+have\b|\bbonus\b|\bdesired\b|\bideally\b|\badvantage(?:ous)?\b|\bencouraged\b/i;

/** A negation that would flip what the line means. Skipped, never inverted. */
const NEGATION = /\bnot\b|\bno\b|n't\b|\bexcept\b|\bexclud(?:e|es|ing)\b|\bineligible\b/i;

function evidence(line) {
  const text = String(line).replace(/\s+/g, " ").trim();
  return text.length <= MAX_EVIDENCE_CHARS ? text : `${text.slice(0, MAX_EVIDENCE_CHARS - 1).trimEnd()}…`;
}

/**
 * The lines worth reading: requirement lines, outside a preferred section, that
 * are not form questions or EEO prose. Also yields the raw line for the school
 * rule, which reads place names and so needs the original capitals.
 */
function requirementLines(text) {
  const out = [];
  for (const { line, preferred } of readSections(text)) {
    if (preferred) continue;
    if (ASKS.test(line) || BOILERPLATE.test(line)) continue;
    out.push(line.replace(PREFERABLY_CLAUSE, ""));
  }
  return out;
}

/* ───────────────────────────── graduation dates ─────────────────────────── */

const MONTH_NUMBERS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const SEASON = String.raw`(spring|summer|fall|autumn|winter)`;
const YEAR = String.raw`(20[2-3]\d)`;

/**
 * One point in time as written: "December 2026", "Dec. 15, 2026", "Fall 2026",
 * "Spring semester 2027", "12/2026", or a bare "2027". Global, so a line is
 * read as the sequence of points it names.
 */
const POINT = new RegExp(
  String.raw`\b(?:${MONTH}\s*(?:\d{1,2}(?:st|nd|rd|th)?,?\s*)?(?:of\s+)?${YEAR}|${SEASON}\s*(?:semester\s*|term\s*|quarter\s*)?(?:of\s+)?${YEAR}|(0?[1-9]|1[0-2])\s*/\s*${YEAR}|${YEAR})\b`,
  "gi",
);

/** A graduation EVENT named in the line, not the adjective "graduate". */
const GRAD_EVENT =
  /\bgraduat(?:ing|ion)\b|\b(?:to|will|who|must|should|expect(?:ed|ing)?\s+to|plan(?:ning)?\s+to)\s+graduate\b|\bgraduates?\s+(?:in|between|by|before|after|no\s+(?:later|earlier)|from\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|spring|summer|fall|autumn|winter|20[2-3]\d))|\bgrad\s+date\b|\bdegree\s+(?:completion|conferral|conferred)\b|\bcomplet(?:e|es|ing)\s+(?:(?:your|their|his|her|a|the)\s+)?(?:degree|studies|program)\b|\bclass\s+of\s+20[2-3]\d\b|\b20[2-3]\d\s+graduates?\b/i;

/** "Summer 2027 internship" names the INTERNSHIP's term, not a graduation. */
const TERM_OF_THE_JOB = /^\s*(?:intern(?:ship)?s?|program(?:me)?|co-?op|cohort|class\s+of\s+interns|start)\b/i;

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * A point as the widest month span it can mean. A season or a bare year is a
 * span: "Winter 2027" is December 2026 on a semester calendar and January to
 * March on a quarter one, so it is read as the whole of 2027's winter reading
 * (January to December would be too wide; January to March plus the December
 * before is what both calendars can mean), and the bound a caller takes is the
 * generous one. Generous is the direction that keeps a job on the board.
 */
function spanOf(match) {
  const [, month, monthYear, season, seasonYear, numMonth, numYear, bareYear] = match;
  if (month) {
    const m = MONTH_NUMBERS[month.slice(0, 3).toLowerCase()];
    const y = Number(monthYear);
    return { start: `${y}-${pad(m)}`, end: `${y}-${pad(m)}`, precision: "month" };
  }
  if (season) {
    const y = Number(seasonYear);
    const s = season.toLowerCase();
    if (s === "spring") return { start: `${y}-01`, end: `${y}-06`, precision: "season" };
    if (s === "summer") return { start: `${y}-05`, end: `${y}-08`, precision: "season" };
    if (s === "fall" || s === "autumn") return { start: `${y}-08`, end: `${y}-12`, precision: "season" };
    // "Winter 2027" is December 2027 on most US semester calendars and January
    // to March 2027 on a quarter calendar, so it spans both readings.
    return { start: `${y}-01`, end: `${y}-12`, precision: "season" };
  }
  if (numMonth) {
    const y = Number(numYear);
    return { start: `${y}-${pad(Number(numMonth))}`, end: `${y}-${pad(Number(numMonth))}`, precision: "month" };
  }
  const y = Number(bareYear);
  return { start: `${y}-01`, end: `${y}-12`, precision: "year", year: y };
}

function shift(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

/** Every point the line names that is not the internship's own term. */
function pointsIn(line) {
  const points = [];
  for (const match of line.matchAll(POINT)) {
    const after = line.slice(match.index + match[0].length);
    if (TERM_OF_THE_JOB.test(after)) continue;
    // "returning to school after Summer 2027", "available during Summer 2027":
    // the internship's summer, named as the time of the job.
    if (/^summer/i.test(match[0]) && /\b(?:after|during|for|following|this|the|of)\s*$/i.test(line.slice(0, match.index))) continue;
    // "Summer 2027" right before a word like internship is the job, and so is a
    // season on its own that is the summer the internship is in; a graduation
    // season is almost never the summer. Kept only when the line also says so.
    const point = { ...spanOf(match), text: match[0], index: match.index, stop: match.index + match[0].length };
    // "Spring/Summer 2028", "Fall/Winter 2027": one point that means either
    // season, read as the span of both.
    const pair = /(spring|summer|fall|autumn|winter)\s*\/\s*$/i.exec(line.slice(0, match.index));
    if (pair && point.precision === "season") {
      const other = spanOf([null, null, null, pair[1], String(Number(match[0].match(/20[2-3]\d/)[0])), null, null, null]);
      point.start = other.start < point.start ? other.start : point.start;
      point.end = other.end > point.end ? other.end : point.end;
      point.index = pair.index;
    }
    points.push(point);
  }
  return points;
}

const BETWEEN = /\b(?:between|from)\s*$/i;
const JOINER = /^\s*(?:and|&|to|through|thru|until|-|–|—)\s*$/i;
const UPPER = /\b(?:no\s+later\s+th[ae]n|not\s+later\s+th[ae]n|by|on\s+or\s+before|before|prior\s+to|until|up\s+to)\s*(?:the\s+end\s+of\s+|(?:the\s+)?summer\s+of\s+|(?:the\s+)?spring\s+of\s+)?$/i;
const STRICT_UPPER = /\b(?:before|prior\s+to)\s*$/i;
const LOWER = /\b(?:no\s+earlier\s+th[ae]n|not\s+earlier\s+th[ae]n|on\s+or\s+after|after)\s*$/i;

/** What may stand right before a lone date that states the date itself. */
const PLAIN_DATE = /(?:\bin|\bof|\bon|\bdate|:|\bis|\bbe|\bgraduating|\bgraduate|\bgraduation|\bconferral|\bcompletion|\()\s*$/i;

/** The line says who is NOT eligible; the date in it bounds the other side. */
const INELIGIBLE = /\bnot\s+(?:be\s+)?(?:eligible|considered|open)\b|\bineligible\b|\bcannot\b|\bwill\s+not\b|\bnot\s+(?:be\s+)?graduat|\bmay\s+only\b|\bonly\s+be\s+considered\s+if\b/i;
const STRICT_LOWER = /(?<!\bon\s+or\s+)\bafter\s*$/i;
const OR_LATER = /^\s*(?:or\s+(?:later|after|beyond|thereafter)|and\s+(?:later|after|beyond))\b/i;
const OR_EARLIER = /^\s*(?:or\s+(?:earlier|before|sooner))\b/i;

/**
 * The window one line states, or null.
 *
 *   between A and B / A – B     from A's start to B's end
 *   no later than / by B        to B's end (before B: to the month before B)
 *   no earlier than / after A   from A's start (after A: the month after A)
 *   A or later / A or earlier   the open side
 *   in A (one month or season)  from A's start to A's end
 *
 * Years alone are returned as `years` instead, unless they bound a range: "by
 * 2027" is a window to December 2027, "in 2027 or 2028" is two class years.
 */
function windowIn(line) {
  const points = pointsIn(line);
  if (points.length === 0) return null;

  // A range: two points joined by a range word, optionally after between/from.
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const joiner = line.slice(a.stop, b.index);
    if (!JOINER.test(joiner)) continue;
    if (/^\s*and\s*$/i.test(joiner) && !BETWEEN.test(line.slice(0, a.index))) continue;
    if (a.start > b.end) continue;
    if (a.precision === "year" && b.precision === "year") {
      const years = [];
      for (let y = a.year; y <= b.year && years.length < 6; y++) years.push(y);
      return { years };
    }
    return { from: a.start, to: b.end };
  }

  if (points.length === 1) {
    const p = points[0];
    const before = line.slice(0, p.index);
    const after = line.slice(p.stop);
    if (OR_LATER.test(after)) return { from: p.start, to: null };
    if (OR_EARLIER.test(after)) return { from: null, to: p.end };
    if (UPPER.test(before)) {
      return { from: null, to: STRICT_UPPER.test(before) ? shift(p.start, -1) : p.end };
    }
    if (LOWER.test(before)) {
      return { from: STRICT_LOWER.test(before) ? shift(p.end, 1) : p.start, to: null };
    }
    // A lone date with no bound word: only when the words before it state the
    // date itself ("graduating in May 2028", "graduation date: Spring 2028").
    // Anything else ("no later then December 2028", a typo, a clause this
    // reader does not know) is a miss, not a one-month window.
    if (!PLAIN_DATE.test(before)) return null;
    if (p.precision === "year") return { years: [p.year] };
    return { from: p.start, to: p.end };
  }

  // Several dates listed as alternatives ("in Fall 2027, Spring/Summer of 2028,
  // or Spring/Summer of 2029"): the span from the first to the last, which is
  // the widest reading and so never hides a month the posting listed.
  if (points.some((p) => p.precision !== "year")) {
    const gaps = points.slice(1).map((p, i) => line.slice(points[i].stop, p.index));
    if (gaps.every((g) => /^\s*(?:,|,?\s*or|,?\s*and|\/)\s*,?\s*$/i.test(g))) {
      const starts = points.map((p) => p.start).sort();
      const ends = points.map((p) => p.end).sort();
      const before = line.slice(0, points[0].index);
      if (PLAIN_DATE.test(before)) return { from: starts[0], to: ends[ends.length - 1] };
    }
  }

  // Several years listed ("2027 or 2028", "2026, 2027, and 2028"): class years.
  if (points.every((p) => p.precision === "year")) {
    const listed = line.slice(points[0].index, points[points.length - 1].stop);
    if (/^[\d\s,/&]*(?:(?:or|and)[\d\s,]*)*$/i.test(listed.replace(/20[2-3]\d/g, ""))) {
      return { years: [...new Set(points.map((p) => p.year))].sort() };
    }
  }
  return null;
}

/** "Class of 2027 or 2028", "2027 graduates": years. */
const CLASS_OF =
  /\bclass\s+of\s+(20[2-3]\d(?:\s*(?:,|or|and|&|\/|-|–)\s*20[2-3]\d)*)\b|(?<![A-Za-z]\.?\s)\b(20[2-3]\d)\s+graduates?\b(?!\s+(?:roles?|programs?|programmes?|positions?|schemes?|hires?|opportunit|co-?ops?|jobs?|development))/gi;

/** "2028 Graduate Program", "graduate roles": the job after, not the student. */
const GRADUATE_JOB = /\bgraduate\s+(?:roles?|programs?|programmes?|positions?|schemes?|hires?|opportunit\w*|co-?ops?|jobs?|development\s+program)\b/i;

function yearsIn(text) {
  const years = [];
  const range = /(20[2-3]\d)\s*[-–]\s*(20[2-3]\d)/.exec(text);
  if (range) {
    for (let y = Number(range[1]); y <= Number(range[2]) && years.length < 6; y++) years.push(y);
    return years;
  }
  for (const m of text.matchAll(/20[2-3]\d/g)) years.push(Number(m[0]));
  return years;
}

function graduation(lines) {
  let gradWindow = null;
  let classYears = null;
  for (const line of lines) {
    if (!GRAD_EVENT.test(line)) continue;
    if (PREFERENCE.test(line) || INELIGIBLE.test(line) || NOT_THE_APPLICANT.test(line)) continue;
    // "Graduated no more than a year ago" is a new-grad rule about the past.
    if (/\b(?:recent(?:ly)?\s+graduat|graduated\b|since\s+graduat|after\s+graduation\b|upon\s+graduation\b|post[-\s]graduation\b)/i.test(line)) continue;
    if (GRADUATE_JOB.test(line) || /\$\s?\d|\bpay\s+rate\b|\bsalary\b/i.test(line)) continue;
    const years = [];
    for (const m of line.matchAll(CLASS_OF)) years.push(...yearsIn(m[1] ?? m[2]));
    const window = windowIn(line);
    const found = window && !window.years ? window : years.length > 0 ? { years } : window;
    if (!found) continue;
    if (found.years && !classYears) {
      classYears = { years: [...new Set(found.years)].sort(), evidence: evidence(line) };
    } else if (!found.years && !gradWindow && (found.from || found.to)) {
      gradWindow = { from: found.from ?? null, to: found.to ?? null, evidence: evidence(line) };
    }
    if (gradWindow && classYears) break;
  }
  return { gradWindow, classYears };
}

/* ───────────────────────────── degree programmes ────────────────────────── */

const DEGREE_TERMS = [
  ["phd", /\bph\.?\s?d\.?s?\b|\bdoctoral\b|\bdoctorate\b/i],
  // Not "the MBA Internship": a programme named as a comparison, not a requirement.
  ["mba", /\bm\.?b\.?a\.?s?\b(?!\s+intern)/i],
  ["masters", /\bmaster['’]?s\b|\bmasters\b|\bmaster\s+(?:of|degree)\b/i],
  ["masters", /\bM\.S\.|\bM\.A\.|\bMSc?\b|\bM\.?Eng\b/],
  ["bachelors", /\bbachelor['’]?s?\b|\bbaccalaureate\b|\bundergrad(?:uate)?s?\b|\bfour[-\s]year\s+(?:college|university|degree|program)/i],
  ["bachelors", /\bB\.S\.|\bB\.A\.|\bBSc?\b|\bBA\b|\bB\.?Eng\b|\bB\.?Tech\b/],
  // An undergraduate year in school names an undergraduate: "rising juniors,
  // seniors, or graduate students" takes bachelor's students too.
  ["bachelors", /\b(?:freshm[ae]n|sophomores?|juniors?|seniors?)\b(?!\s+(?:engineers?|developers?|analysts?|managers?|scientists?|leaders?|leadership|level|staff))/i],
  ["associate", /\bassociate['’]?s?\s+degree\b|\bcommunity\s+college\b/i],
  ["high_school", /\bhigh[\s-]school\s+(?:students?|seniors?|juniors?)\b/i],
];

/** "a degree in X", "any degree": no level named, so no level required. */
const GENERIC_DEGREE =
  /\b(?:a|any)\s+(?:(?:university|college|four[-\s]year|full[-\s]time|relevant|related|technical|stem)\s+)?degree\b(?!\s+(?:program(?:me)?\s+)?(?:at\s+the\s+)?(?:bachelor|master|ph|doctor))/i;

/** "or equivalent experience": the degree is one way in, not the only one. */
const OR_EXPERIENCE =
  /\bor\s+(?:have\s+)?(?:equivalent|significant|relevant|comparable)\s+(?:\w+\s+){0,2}experience\b|\bhave\s+attained\b/i;

/**
 * "preferably in Computer Science": a preference about the FIELD, which says
 * nothing about whether the degree or year before it is required. Cut before a
 * line is judged, so the requirement it qualifies is still read.
 */
const PREFERABLY_CLAUSE = /,?\s*\(?\s*\bpreferabl[ye]\b[^.;)]*\)?/gi;

/** "Master's degree or higher": that level and every one above it. */
const OR_HIGHER = /\bor\s+(?:higher|above|greater)\b|\bat\s+(?:a\s+)?minimum\b|\bat\s+least\s+(?:a|an)\b|\bminimum\s+of\s+(?:a|an)\b/i;

/**
 * "Master's and PhD students are also eligible": an ADDITION to a base the
 * posting states elsewhere. On its own it restricts nothing, so it only ever
 * widens what another line said, and a posting with only this line gets null.
 */
const ADDITIVE = /\balso\b|\bas\s+well\b|\bin\s+addition\b|\bwelcome\s+to\s+apply\b/i;

/** A high-school level named as who may apply, not as a customer or a cause. */
const HIGH_SCHOOL_CUE = /\b(?:open\s+to|eligible|must|only|currently|enrolled|applicants?|candidates?)\b/i;

/** Lines about pay, which name student levels to explain a range. */
const PAY_LINE = /\$\s?\d|\bpay\s+(?:rate|range)\b|\bsalary\b|\bcompensation\b|\bthe\s+range\b|\bhourly\s+rate\b/i;

/** "Graduate student", as opposed to "graduating" or "recent graduate". */
const GRADUATE_STUDENT =
  /(?<!under)\bgraduate\s+(?:students?|degrees?|degree\s+(?:program|candidates?|students?)|programs?|school\s+students?|level\s+students?)\b|\bundergraduate\s*(?:,|\/|or|and)\s*graduate\b|\badvanced\s+degrees?\b|\bpost[-\s]?graduate\s+(?:programs?|degrees?|students?)\b/i;

/** The line is about the applicant's current enrolment, not a finished degree. */
const ENROLLED =
  /\b(?:enrolled|enrollment|enrolment|pursuing|working\s+(?:toward|towards)|currently\s+(?:in|attending|completing|studying|a)|students?|candidates?\s+(?:in|for|pursuing)|degree\s+candidates?|studying|in\s+(?:a|an|their|your)\s+(?:\w+\s+){0,3}program)\b/i;

/**
 * A description of the team or the work rather than of the applicant:
 * "work alongside PhD researchers", "our team of PhDs and engineers".
 */
const NOT_THE_APPLICANT =
  /\bwhether\s+you\b|\b(?:help|helps|helping|support|supports|supporting|serve|serves|serving|mentor|mentors|mentoring|coach|coaches|coaching|teach|teaches|teaching|tutor|tutors|tutoring|recruit|recruits|recruiting)\b[^.;]{0,40}\bstudents?\b|\bour\s+(?:platform|product|products|customers|users|clients|app|members)\b|\b(?:our|the)\s+(?:team|researchers|scientists|engineers|staff)\b|\balongside\b|\bmentor(?:ed|s|ship)?\b|\bwork(?:ing)?\s+with\b|\bled\s+by\b|\bpublications?\b/i;

function degreeLevels(lines) {
  const levels = new Set();
  const added = new Set();
  let first = null;
  for (const line of lines) {
    if (!ENROLLED.test(line)) continue;
    if (PREFERENCE.test(line) || NEGATION.test(line) || NOT_THE_APPLICANT.test(line)) continue;
    if (INELIGIBLE.test(line) || GENERIC_DEGREE.test(line) || OR_EXPERIENCE.test(line) || PAY_LINE.test(line)) continue;
    const found = new Set();
    for (const [level, pattern] of DEGREE_TERMS) if (pattern.test(line)) found.add(level);
    if (OR_HIGHER.test(line)) {
      const rank = ["high_school", "associate", "bachelors", "masters", "phd"];
      const lowest = rank.findIndex((l) => found.has(l));
      if (lowest >= 0) for (const l of rank.slice(lowest)) found.add(l);
      if (found.has("masters")) found.add("mba");
    }
    if (GRADUATE_STUDENT.test(line)) {
      found.add("masters");
      found.add("phd");
    }
    if (found.has("high_school") && !HIGH_SCHOOL_CUE.test(line)) found.delete("high_school");
    if (found.size === 0) continue;
    if (ADDITIVE.test(line)) {
      for (const level of found) added.add(level);
      continue;
    }
    for (const level of found) levels.add(level);
    first ??= line;
  }
  if (levels.size === 0) return null;
  for (const level of added) levels.add(level);
  const order = ["high_school", "associate", "bachelors", "masters", "mba", "phd"];
  return { levels: order.filter((l) => levels.has(l)), evidence: evidence(first) };
}

/* ─────────────────────────────── year in school ─────────────────────────── */

/** A standing word used as a job level: "senior engineer", "junior developer". */
const JOB_LEVEL =
  /^\s*(?:software|data|product|research|machine|ml|ai|staff|principal|engineers?|developers?|analysts?|managers?|scientists?|designers?|associates?|consultants?|leaders?|leadership|executives?|management|level|vice|director|members?|partners?|technicians?|accountants?|architects?|roles?|positions?|team|living|citizens?|care|high\s+school|colleagues|stakeholders|professionals|thesis|project|capstone|design)\b/i;

const YEARS = ["freshman", "sophomore", "junior", "senior"];

function yearOf(word) {
  const w = word.toLowerCase();
  if (w.startsWith("freshm")) return "freshman";
  return w.replace(/s$/, "");
}

/**
 * A LIST of years in school with what surrounds it, because the wording that
 * decides what it means sits on the ends: "rising Junior or Senior",
 * "entering their sophomore, junior, or senior year", "completed Sophomore
 * year or greater", "Junior/Senior student", "at least junior standing".
 */
const STANDING_LIST = new RegExp(
  String.raw`(?:\b(rising(?:\s+(?:undergraduate|undergrad|college|university))?|entering\s+(?:their|your|the|his|her)?|going\s+into\s+(?:their|your|the)?|will\s+be\s+(?:an?\s+)?|complet(?:ed|ion\s+of|e)\s+(?:(?:at\s+least|a\s+minimum\s+of)\s+)?(?:the\s+|their\s+|your\s+)?(?:undergraduate\s+|undergrad\s+)?|(?:at\s+least|minimum(?:\s+of)?)\s+(?:a\s+)?)\s*)?` +
    String.raw`\b((?:freshm[ae]n|sophomores?|juniors?|seniors?)(?:\s*(?:,\s*(?:or|and)?|\/|&|\bor\b|\band\b)\s*(?:rising\s+)?(?:freshm[ae]n|sophomores?|juniors?|seniors?)\b)*)` +
    String.raw`(\s+(?:year|standing|status|students?|undergrad\w*|level\s+(?:students?|candidates?)|in\s+(?:college|university|school))\b)?` +
    String.raw`(\s*(?:year\s+|standing\s+)?(?:or\s+(?:higher|above|greater|beyond)))?`,
  "gi",
);

function standingsIn(line) {
  const out = new Set();
  for (const m of line.matchAll(STANDING_LIST)) {
    const [whole, prefix = "", list, suffix = "", stated = ""] = m;
    const next = line.slice(m.index + whole.length);
    // "Junior status (as of Fall 2027) or higher": the bound can trail a clause.
    const orHigher = stated || (/^[^.;]{0,30}?\bor\s+(?:higher|above|greater)\b/i.test(next) ? "or higher" : "");
    if (!suffix && !orHigher && JOB_LEVEL.test(next)) continue;
    const words = list.match(/freshm[ae]n|sophomores?|juniors?|seniors?/gi).map(yearOf);
    const plural = /(?:freshmen|sophomores|juniors|seniors)\b/i.test(list);
    const self = /\b(?:an?|current(?:ly)?(?:\s+an?)?|be\s+an?|as\s+an?|college|undergraduate)\s*$/i.test(line.slice(0, m.index));
    if (!prefix && !suffix && !orHigher && !plural && !self) continue;
    const p = prefix.toLowerCase();
    if (/^(?:rising|entering|going|will)/.test(p)) {
      for (const w of words) if (w !== "freshman") out.add(`rising_${w}`);
    } else if (/^complet/.test(p)) {
      const lowest = Math.min(...words.map((w) => YEARS.indexOf(w)));
      for (const w of YEARS.slice(lowest + 1)) out.add(w);
    } else if (/^(?:at\s+least|minimum)/.test(p) || orHigher) {
      const lowest = Math.min(...words.map((w) => YEARS.indexOf(w)));
      for (const w of YEARS.slice(lowest)) out.add(w);
    } else {
      for (const w of words) out.add(w);
    }
  }
  const years = /\b(first|second|third|fourth)[-\s]year\s+(?:undergraduate\s+|college\s+|university\s+)?students?\b/gi;
  for (const m of line.matchAll(years)) out.add(YEARS[["first", "second", "third", "fourth"].indexOf(m[1].toLowerCase())]);
  for (const m of line.matchAll(/\b(final|penultimate)(?:\s*(?:or|and|\/)\s*(final|penultimate))?[-\s]year\b/gi)) {
    out.add(`${m[1].toLowerCase()}_year`);
    if (m[2]) out.add(`${m[2].toLowerCase()}_year`);
  }
  return out;
}

/** Returning to school after the internship. */
const RETURNING =
  /\breturn(?:ing)?\s+to\s+(?:school|university|college|campus|(?:your|their)\s+(?:studies|program|degree(?:\s+program)?|school|university)|(?:an?\s+)?academic|the\s+program)|\bat\s+least\s+one\s+(?:additional\s+|more\s+|full\s+)?(?:semester|quarter|term|year)\s+(?:of\s+\w+\s+)?(?:remaining|left)\b|\bremaining\s+(?:semester|quarter|term)s?\s+(?:of\s+\w+\s+)?(?:after|following)\b|\benrolled\b[^.;]{0,40}\b(?:semester|term|quarter)\s+(?:following|after)\s+(?:your|the)\s+internship/i;

/** "Returning to school" as a condition, not as a line about relocation or a rotation. */
const RETURNING_CUE =
  /\b(?:must|should|expected\s+to|intent|intend|plan(?:ning)?\s+to|required|eligib\w*|remaining|currently|enrolled|and\s+(?:be\s+)?returning|following\s+the\s+(?:completion|internship))\b|^\W*returning\b/i;
const RETURNING_NOT = /\breimburs|\brelocation\b|\bresponsibilit|\bconclude\b/i;

/** The line is about the applicant's standing, not a date or a job title. */
const STANDING_CONTEXT = /\b(?:students?|year|standing|status|class|undergrad(?:uate)?s?|enrolled|currently|current|must\s+be|open\s+to|eligible|rising|returning|college|university|school|candidates?|applicants?|seeking|designed\s+for|for\s+(?:rising|current))\b/i;

function standing(lines) {
  const values = new Set();
  let first = null;
  for (const line of lines) {
    if (PREFERENCE.test(line) || INELIGIBLE.test(line) || PAY_LINE.test(line) || NOT_THE_APPLICANT.test(line)) continue;
    const found = new Set();
    if (RETURNING.test(line) && RETURNING_CUE.test(line) && !RETURNING_NOT.test(line)) found.add("returning");
    if (STANDING_CONTEXT.test(line) && !/\bnot\b|n't\b/i.test(line)) {
      for (const v of standingsIn(line)) found.add(v);
    }
    if (found.size === 0) continue;
    for (const v of found) values.add(v);
    first ??= line;
  }
  if (values.size === 0) return null;
  const order = [
    "freshman", "sophomore", "junior", "senior",
    "rising_sophomore", "rising_junior", "rising_senior",
    "penultimate_year", "final_year", "returning",
  ];
  return { values: order.filter((v) => values.has(v)), evidence: evidence(first) };
}

/* ─────────────────────────────── school rules ───────────────────────────── */

const SCHOOL = String.raw`(?:universit(?:y|ies)|colleges?|schools?|institutions?|campus(?:es)?)`;

/** Adjectives that name a country, as the country. */
const DEMONYMS = new Map([
  ["canadian", "Canada"],
  ["american", "United States"],
  ["u.s.", "United States"],
  ["us", "United States"],
  ["usa", "United States"],
  ["united states", "United States"],
  ["british", "United Kingdom"],
  ["uk", "United Kingdom"],
  ["indian", "India"],
  ["australian", "Australia"],
  ["irish", "Ireland"],
  ["german", "Germany"],
  ["french", "France"],
  ["singaporean", "Singapore"],
  ["israeli", "Israel"],
  ["mexican", "Mexico"],
]);
const DEMONYM = String.raw`(?:canadian|american|u\.s\.|usa|us|united\s+states|british|uk|indian|australian|irish|german|french|singaporean|israeli|mexican)`;

/**
 * The applicant, then within a short clause a SCHOOL noun: "enrolled at an
 * accredited Canadian university", "student at a university in Raleigh",
 * "attends a college or university in the United States". What follows the
 * noun (a place) or sits inside it (a demonym) is read separately.
 */
const STUDENT_AT_SCHOOL = new RegExp(
  String.raw`\b(?:enrolled|enrollment|studying|attending|attends|attend|students?|candidates?|undergraduates?|applicants?|pursuing)\b[^.;:?]{0,80}?\b(?:(?:at|in|from|with)\s+)?(?:an?\s+|the\s+|one\s+of\s+(?:the\s+)?)((?:(?:accredited|participating|partner|local|full[-\s]time|four[-\s]year|4[-\s]year|top[-\s]tier)[,\s]+)*(?:${DEMONYM}(?:\s*(?:or|and|\/)\s*${DEMONYM})*[-\s]+(?:based\s+)?)?(?:accredited\s+)?${SCHOOL}(?:\s*(?:\/|or|and)\s*${SCHOOL})*)`,
  "gi",
);

/** A place right after the noun: "in the United States", "within the Raleigh area". */
const PLACE_AFTER =
  /^\s*(?:(?:located|based)\s+)?(?:in|within|near|around|across|throughout)\s+(?:the\s+)?(?:state\s+of\s+|province\s+of\s+|greater\s+)?([A-Z][A-Za-z.'’]*(?:[\s,/&-]+(?:and\s+|or\s+)?[A-Z][A-Za-z.'’]*){0,6})/;

/** "within an 80-mile radius of San Francisco, California". */
const RADIUS = /\bwithin\s+(?:an?\s+|the\s+)?(\d+)[-\s]mile\s+radius\s+of\s+([A-Z][A-Za-z.'’]*(?:[\s,]+[A-Z][A-Za-z.'’]*){0,4})/;

/** "studying at a Hong Kong or Singapore based university". */
const BASED_SCHOOL =
  /\b(?:[Ee]nrolled|[Ss]tudying|[Aa]ttending|[Ss]tudents?)\s+(?:at|in)\s+(?:an?\s+)?((?:[A-Z][A-Za-z.'’]*\s*)+(?:(?:or|and|,)\s+(?:[A-Z][A-Za-z.'’]*\s*)+)*)[-\s]based\s+(?:accredited\s+)?(?:universit|college|school|institution)/;

/** "University of South Florida", "Texas Tech University", "Babson College". */
const SCHOOL_NAME =
  /\b(?:University\s+of\s+[A-Z][A-Za-z.'’&-]*(?:\s+(?:at\s+)?[A-Z][A-Za-z.'’&-]*){0,4}|(?:[A-Z][A-Za-z.'’&-]*\s+){1,4}(?:University|College|Institute(?:\s+of\s+Technology)?|Polytechnic))\b/g;
const NAMED_ONLY = /\bonly\b|\bexclusively\b|\blimited\s+to\b|\brestricted\s+to\b|\bmust\s+be\s+(?:enrolled|a\s+student|attending|currently\s+enrolled)\b|\bto\s+qualify\b/i;

/** A capture that is a field of study, not a place: "a university in Computer Science". */
const FIELD_OF_STUDY =
  /\b(?:science|sciences|engineering|studies|mathematics|math|economics|business|informatics|analytics|statistics|systems|finance|accounting|marketing|management|technology|design|physics|chemistry|biology|major|field|discipline|degree|program|energy|geography|cybersecurity|gis|pursuit|good|standing|fall|spring|summer|winter)\b/i;

const PLACE_NAMES = new Map([
  ["U.S", "United States"],
  ["U.S.", "United States"],
  ["US", "United States"],
  ["USA", "United States"],
  ["U.S.A", "United States"],
]);

function places(capture) {
  return String(capture ?? "")
    .replace(/\s+(?:and|or)\s+(?:plan|pursu|study|major|with|who|that|are|is|will|have|in)\b.*$/i, "")
    .split(/\s*(?:\/|,|&|\bor\b|\band\b)\s*/)
    .map((p) => p.trim().replace(/[.'’]+$/, "").replace(/^the\s+/i, ""))
    .map((p) => PLACE_NAMES.get(p) ?? p)
    .filter((p) => p.length > 1 && /^[A-Z]/.test(p) && !/^(?:The|A|An|Our|Any|All|Accredited)$/.test(p));
}

function schoolRule(lines) {
  for (const line of lines) {
    if (PREFERENCE.test(line)) continue;
    // "Candidates from all universities", "any accredited school" restrict nothing.
    if (/\b(?:any|all)\s+(?:accredited\s+)?(?:universit|college|school|institution)/i.test(line)) continue;
    if (/\bnot\b|n't\b|\bwelcome\b|\bcollaborat|\bpartnerships?\s+with\b/i.test(line)) continue;

    const radius = RADIUS.exec(line);
    if (radius && /\b(?:enroll\w*|attend\w*|studying|students?\s+(?:at|from|of|in))\b/i.test(line) && /\b(?:universit|college|school)/i.test(line)) {
      return { text: evidence(line), locations: [`${radius[2].trim()} (within ${radius[1]} miles)`] };
    }

    const based = BASED_SCHOOL.exec(line);
    if (based) {
      const locations = places(based[1]);
      if (locations.length > 0) return { text: evidence(line), locations };
    }

    for (const m of line.matchAll(STUDENT_AT_SCHOOL)) {
      const noun = m[1];
      const countries = [];
      for (const d of noun.matchAll(new RegExp(DEMONYM, "gi"))) {
        const country = DEMONYMS.get(d[0].toLowerCase().replace(/\s+/g, " "));
        if (country && !countries.includes(country)) countries.push(country);
      }
      if (countries.length > 0) return { text: evidence(line), locations: countries };
      const after = PLACE_AFTER.exec(line.slice(m.index + m[0].length));
      if (after && !FIELD_OF_STUDY.test(after[1])) {
        const locations = places(after[1]);
        if (locations.length > 0) return { text: evidence(line), locations };
      }
    }

    if (NAMED_ONLY.test(line) && /\b(?:enrolled|attend|students?|student\s+at)\b/i.test(line)) {
      const names = [...line.matchAll(SCHOOL_NAME)].map((n) => n[0].trim());
      if (names.length > 0) return { text: evidence(line), locations: [...new Set(names)] };
    }
    if (/\bpartner\s+(?:universit|schools?|colleges?|institutions?|campus)/i.test(line) && NAMED_ONLY.test(line)) {
      return { text: evidence(line), locations: [] };
    }
  }
  return null;
}

/* ──────────────────────────────────── API ────────────────────────────────── */

/**
 * Every rule this posting states, each null unless stated.
 *
 * Returns the five keys always, so a cache entry written by this revision can
 * be told from one written before it: an object with five nulls is "read, and
 * the posting states nothing", which is the answer on most of the board.
 */
export function extractEligibility(text) {
  const lines = requirementLines(text);
  const { gradWindow, classYears } = graduation(lines);
  return {
    gradWindow,
    degreeLevels: degreeLevels(lines),
    classYears,
    standing: standing(lines),
    schoolRule: schoolRule(lines),
  };
}
