// Genere par scripts/apercu-github.py (scripts/agenda-json.ts + src/lib/agenda-rules.ts) : ne pas modifier.

// scripts/agenda-json.ts
import { writeFileSync } from "node:fs";

// src/lib/ics.ts
var parisFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Paris",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});
function toNaive(prop) {
  const v = prop.value.trim();
  if (prop.params.includes("VALUE=DATE") || /^\d{8}$/.test(v)) {
    return { value: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) throw new Error(`Date iCalendar illisible : ${v}`);
  const [, y, mo, d, h, mi, , z] = m;
  if (z) {
    const utc = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
    return { value: parisFmt.format(utc).replace(" ", "T"), allDay: false };
  }
  return { value: `${y}-${mo}-${d}T${h}:${mi}`, allDay: false };
}
function unescapeText(s) {
  return s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();
}
var DAYS = { MO: "mo", TU: "tu", WE: "we", TH: "th", FR: "fr", SA: "sa", SU: "su" };
function parseRrule(rule) {
  const parts = Object.fromEntries(rule.split(";").map((p) => p.split("=")));
  const freq = { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly" }[parts.FREQ];
  if (!freq || parts.COUNT || parts.BYSETPOS || parts.BYMONTHDAY || parts.BYMONTH) return "unsupported";
  const byday = parts.BYDAY ? parts.BYDAY.split(",") : [];
  if (byday.some((d) => !DAYS[d])) return "unsupported";
  if (freq !== "weekly" && byday.length) return "unsupported";
  let until = null;
  if (parts.UNTIL) until = toNaive({ params: "", value: parts.UNTIL }).value.slice(0, 10);
  return { freq, interval: Number(parts.INTERVAL) || 1, byweekday: byday.map((d) => DAYS[d]), until };
}
function parseIcs(text) {
  const unfolded = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const events2 = [];
  const skipped2 = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0];
    const props = /* @__PURE__ */ new Map();
    for (const line of body.split("\n")) {
      const i = line.indexOf(":");
      if (i <= 0) continue;
      const head = line.slice(0, i);
      const name = head.split(";")[0].toUpperCase();
      const list = props.get(name) ?? [];
      list.push({ params: head.slice(name.length), value: line.slice(i + 1) });
      props.set(name, list);
    }
    const get = (n) => props.get(n)?.[0];
    const dtstart = get("DTSTART");
    if (!dtstart) continue;
    const title = unescapeText(get("SUMMARY")?.value ?? "");
    if (get("STATUS")?.value === "CANCELLED") continue;
    const start = toNaive(dtstart);
    const dtend = get("DTEND");
    let end = dtend ? toNaive(dtend).value : null;
    if (start.allDay && !end) end = null;
    let recurrence = null;
    const rrule = get("RRULE");
    if (rrule) {
      const r = parseRrule(rrule.value);
      if (r === "unsupported") {
        skipped2.push(`${title} (r\xE9p\xE9tition non g\xE9r\xE9e : ${rrule.value})`);
        continue;
      }
      recurrence = r;
    }
    const exdates = [];
    for (const ex of props.get("EXDATE") ?? []) {
      for (const v of ex.value.split(",")) exdates.push(toNaive({ params: ex.params, value: v }).value);
    }
    const rid = get("RECURRENCE-ID");
    events2.push({
      uid: get("UID")?.value ?? "",
      title,
      description: unescapeText(get("DESCRIPTION")?.value ?? ""),
      location: unescapeText(get("LOCATION")?.value ?? ""),
      start: start.value,
      end,
      allDay: start.allDay,
      recurrence,
      exdates,
      recurrenceId: rid ? toNaive(rid).value : null
    });
  }
  for (const ev of events2) {
    if (!ev.recurrenceId) continue;
    const master = events2.find((e) => e.uid === ev.uid && e.recurrence && !e.recurrenceId);
    if (master && !master.exdates.includes(ev.recurrenceId)) master.exdates.push(ev.recurrenceId);
  }
  return { events: events2, skipped: skipped2 };
}

// src/lib/agenda-rules.ts
var DEFAULT_ICS_URL = "https://calendar.google.com/calendar/ical/escaladegda%40gmail.com/public/basic.ics";
var EXCLUDE = [/zoom/i, /please rep/i, /^rdv\b/i, /^none$/i, /^\s*$/];
var TITLES = [
  [/^ouverture salle \+ cours adultes$/i, "Ouverture salle + cours adultes"],
  [/^ouverture salle$/i, "Ouverture salle"],
  [/^cours adultes$/i, "Cours adultes"],
  [/^cours perfectionnement adultes$/i, "Cours perfectionnement adultes"],
  [/^cours perf\s*:\s*sortie falaise$/i, "Cours perfectionnement : sortie falaise"],
  [/^sal+e+ ferm[ée]e\s*$/i, "Salle ferm\xE9e"],
  [/^sortie falaise\s*$/i, "Sortie falaise"],
  [/^sortie falaise\s*:\s*viel audon$/i, "Sortie falaise : Viel Audon"],
  [/^sortie falaise\s*:\s*grand charmasson 9:30$/i, "Sortie falaise : Grand Charmasson (9h30)"],
  [/^canyon$/i, "Canyon"],
  [/^we canyon$/i, "Week-end canyon"],
  [/^we falaise adultes$/i, "Week-end falaise adultes"],
  [/^vacances scolaires? \(ouverture salle voir whatsapp\)$/i, "Vacances scolaires : ouvertures annonc\xE9es sur WhatsApp"],
  [/^atelier recyclage ppa \+ test matos$/i, "Atelier recyclage PPA + test du mat\xE9riel"],
  [/^ev[ée]nement t[ée]l[ée]thon$/i, "T\xE9l\xE9thon"]
];
var CATEGORIES = [
  { name: "Fermeture", color: "#a8a29e", test: /ferm/ },
  { name: "Vacances scolaires", color: "#d9cdb4", test: /vacances/ },
  { name: "Cours et ateliers", color: "#b8a1e3", test: /cours|atelier|stage/ },
  { name: "Salle ouverte", color: "#7abfe0", test: /ouverture|salle ouverte/ },
  { name: "Canyon / nature", color: "#5fa98b", test: /canyon/ },
  { name: "Sortie falaise", color: "#e0a458", test: /falaise|grimpe/ },
  { name: "\xC9v\xE9nement", color: "#e2674e", test: /.*/ }
];
var norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
var ACRONYMS = /* @__PURE__ */ new Set(["PPA", "FFCAM", "FFME", "CAF", "CREPS", "SAE", "AG", "EPI", "WE"]);
function sentenceCase(t) {
  if (new RegExp("\\p{Ll}", "u").test(t) || !new RegExp("\\p{Lu}", "u").test(t)) return t;
  let start = true;
  return t.split(/(\s+)/).map((w) => {
    if (/^\s+$/.test(w)) return w;
    const letters = w.replace(/[^\p{L}]/gu, "");
    let out2 = ACRONYMS.has(letters) ? w : w.toLowerCase();
    if (start && letters) out2 = out2.replace(new RegExp("\\p{L}", "u"), (c) => c.toUpperCase());
    if (letters) start = false;
    if (/[:.!?]$/.test(w)) start = true;
    return out2;
  }).join("");
}
function niceTitle(raw) {
  const t = raw.trim().replace(/\s+/g, " ");
  for (const [re, out2] of TITLES) if (re.test(t)) return out2;
  return sentenceCase(t);
}
function seasonStart() {
  const now = /* @__PURE__ */ new Date();
  const y = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return `${y}-08-01`;
}
function categoryFor(title) {
  const n = norm(title);
  return CATEGORIES.find((x) => x.test.test(n));
}
function prepareAgenda(text, since2 = seasonStart()) {
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("Le lien de l'agenda ne renvoie pas un agenda (format iCal attendu)");
  const { events: events2, skipped: skipped2 } = parseIcs(text);
  const out2 = [];
  for (const e of events2) {
    if (EXCLUDE.some((re) => re.test(e.title))) continue;
    const last = e.recurrence ? e.recurrence.until ?? "9999-12-31" : e.end ?? e.start;
    if (last < since2) continue;
    const title = niceTitle(e.title).slice(0, 140);
    const cat = categoryFor(title);
    out2.push({
      externalId: `google:${e.uid}${e.recurrenceId ? `#${e.recurrenceId}` : ""}`,
      title,
      description: e.description.slice(0, 2e3),
      location: e.location.slice(0, 200),
      category: cat.name,
      color: cat.color,
      start: e.start,
      end: e.end,
      allDay: e.allDay,
      recurrence: e.recurrence ? JSON.stringify(e.recurrence) : null,
      exdates: JSON.stringify(e.exdates)
    });
  }
  return { events: out2, skipped: skipped2, since: since2 };
}

// scripts/agenda-json.ts
var [out = "agenda.json", url = DEFAULT_ICS_URL] = process.argv.slice(2);
var res = await fetch(url, { signal: AbortSignal.timeout(2e4) });
if (!res.ok) throw new Error(`Agenda Google inaccessible (HTTP ${res.status})`);
var { events, since, skipped } = prepareAgenda(await res.text());
writeFileSync(out, JSON.stringify({ checkedAt: (/* @__PURE__ */ new Date()).toISOString(), since, events }, null, 1) + "\n");
console.log(`${events.length} cr\xE9neaux depuis le ${since} \xE9crits dans ${out}.`);
if (skipped.length) console.log(`Non repris (r\xE9p\xE9tition non g\xE9r\xE9e) : ${skipped.join(" ; ")}`);
