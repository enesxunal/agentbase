export type QueryIntent = {
  raw: string;
  normalized: string;
  tokens: string[];
  city?: string;
  typeHints: string[];
  facets: string[];
  intent: 'discover' | 'lookup' | 'recommend' | 'compare' | 'unknown';
  temporal?: { kind: 'today' | 'tomorrow' | 'this_week' | 'this_weekend' | 'upcoming'; from: string; to?: string };
};

const STOPWORDS = new Set([
  'bir','ve','ile','icin','için','mi','mı','mu','mü','ne','nerede','neresi','nereye','nasıl','nasil',
  'en','iyi','guzel','güzel','olan','olarak','var','mi','da','de','ki','ya','veya','bana','bize','ben','biz'
]);

const FACETS: Array<[string, string[]]> = [
  ['family_friendly', ['cocuk','çocuk','cocukla','çocukla','aile','family']],
  ['indoor', ['kapali','kapalı','iceride','içeride','indoor','yagmurlu','yağmurlu','yagmur','yağmur']],
  ['outdoor', ['acik hava','açık hava','outdoor','park','bahce','bahçe']],
  ['history', ['tarih','tarihi','muze','müze','antik','anıt','anit']],
  ['food', ['yemek','restoran','restaurant','kahvalti','kahvaltı','makarna','tatli','tatlı','kahve']],
  ['budget', ['ucuz','uygun fiyat','ekonomik','butce','bütçe']],
  ['premium', ['lüks','luxury','premium','fine dining']],
  ['accessible', ['engelli','erisilebilir','erişilebilir','wheelchair']],
  ['open_now', ['acik','açık','simdi','şimdi','su an','şu an']],
  ['event', ['etkinlik','konser','festival','sergi','tiyatro']]
];

const TYPE_HINTS: Array<[string, string[]]> = [
  ['business', ['restoran','restaurant','kafe','cafe','magaza','mağaza','isletme','işletme','otel','hotel']],
  ['place', ['gezilecek','yer','muze','müze','park','anıt','anit','mekan','mekân']],
  ['food', ['yemek','tat','mutfak','yoresel','yöresel']],
  ['event', ['etkinlik','konser','festival','sergi','tiyatro']],
  ['city', ['sehir','şehir','il','kent']]
];


function istanbulDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function isoIstanbulDate(year: number, month: number, day: number) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

function shiftCalendarDate(year: number, month: number, day: number, delta: number) {
  const value = new Date(Date.UTC(year, month - 1, day + delta, 12));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function temporalIntent(raw: string, normalized: string): QueryIntent['temporal'] {
  const now = new Date();
  const current = istanbulDateParts(now);
  const startOf = (value: { year: number; month: number; day: number }) => `${isoIstanbulDate(value.year, value.month, value.day)}T00:00:00+03:00`;
  const tomorrow = shiftCalendarDate(current.year, current.month, current.day, 1);
  if (/\b(bugun|bugün|today)\b/i.test(raw)) {
    return { kind: 'today', from: startOf(current), to: startOf(tomorrow) };
  }
  if (/\b(yarin|yarın|tomorrow)\b/i.test(raw)) {
    const afterTomorrow = shiftCalendarDate(current.year, current.month, current.day, 2);
    return { kind: 'tomorrow', from: startOf(tomorrow), to: startOf(afterTomorrow) };
  }
  const weekday = new Date(Date.UTC(current.year, current.month - 1, current.day, 12)).getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  const monday = shiftCalendarDate(current.year, current.month, current.day, mondayOffset);
  if (/\b(bu hafta|this week)\b/i.test(raw)) {
    const nextMonday = shiftCalendarDate(monday.year, monday.month, monday.day, 7);
    return { kind: 'this_week', from: startOf(current), to: startOf(nextMonday) };
  }
  if (/\b(hafta sonu|haftasonu|bu weekend|this weekend|weekend)\b/i.test(raw)) {
    const saturday = shiftCalendarDate(monday.year, monday.month, monday.day, 5);
    const nextMonday = shiftCalendarDate(monday.year, monday.month, monday.day, 7);
    const from = now.getTime() > new Date(startOf(saturday)).getTime() ? startOf(current) : startOf(saturday);
    return { kind: 'this_weekend', from, to: startOf(nextMonday) };
  }
  if (/\b(yaklasan|yaklaşan|gelecek etkinlik|gelecek etkinlikler|upcoming|etkinlik|konser|festival|sergi|tiyatro)\b/i.test(raw)) {
    return { kind: 'upcoming', from: now.toISOString() };
  }
  return undefined;
}

export function normalizeQuery(value: string) {
  return value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseQuery(raw: string, knownCities: string[] = []): QueryIntent {
  const normalized = normalizeQuery(raw);
  const padded = ` ${normalized} `;
  const tokens = normalized.split(' ').filter(Boolean).filter((t) => !STOPWORDS.has(t));
  const facets = FACETS.filter(([, terms]) => terms.some((term) => padded.includes(` ${normalizeQuery(term)} `) || normalized.includes(normalizeQuery(term)))).map(([name]) => name);
  const typeHints = TYPE_HINTS.filter(([, terms]) => terms.some((term) => normalized.includes(normalizeQuery(term)))).map(([name]) => name);
  const city = knownCities.find((candidate) => normalized.includes(normalizeQuery(candidate)));

  let intent: QueryIntent['intent'] = 'unknown';
  if (/\b(oner|öner|tavsiye|en iyi|nereye|nerede|gezilecek)\b/i.test(raw)) intent = 'recommend';
  else if (/\b(karsilastir|karşılaştır|versus| vs |hangisi)\b/i.test(raw)) intent = 'compare';
  else if (/\b(nedir|kimdir|hakkinda|hakkında|bilgi)\b/i.test(raw)) intent = 'lookup';
  else if (tokens.length) intent = 'discover';

  return { raw, normalized, tokens, city, typeHints: [...new Set(typeHints)], facets: [...new Set(facets)], intent, temporal: temporalIntent(raw, normalized) };
}

export function facetTerms(facet: string) {
  const row = FACETS.find(([name]) => name === facet);
  return row ? row[1].map(normalizeQuery) : [];
}
