import { extractSentenceClaims } from './sentence_extraction.js';
export type RichClaim = {
  subjectName: string | null;
  subjectType?: string | null;
  predicate: string;
  value: unknown;
  confidence: number;
  evidence?: string;
};

function clean(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function uniqueClaims(claims: RichClaim[]) {
  const seen = new Set<string>();
  return claims.filter((claim) => {
    const key = `${claim.predicate}|${JSON.stringify(claim.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function firstMatch(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return clean(match[1]);
  }
  return null;
}

export function extractRichTextClaims(input: {
  rawText: string;
  metadata?: Record<string, unknown>;
  subjectName: string | null;
  subjectType?: string | null;
}) {
  const text = clean(input.rawText).slice(0, 120000);
  if (!text) return [] as RichClaim[];

  const claims: RichClaim[] = [];
  const base = { subjectName: input.subjectName, subjectType: input.subjectType ?? null };

  const labeledPairs = Array.isArray(input.metadata?.labeledPairs)
    ? input.metadata.labeledPairs as Array<{ label?: unknown; value?: unknown }>
    : [];
  const pairMap = labeledPairs
    .map((pair) => ({
      label: clean(String(pair.label ?? '')).toLocaleLowerCase('tr-TR'),
      value: clean(String(pair.value ?? ''))
    }))
    .filter((pair) => pair.label && pair.value);
  const pickPair = (...labels: string[]) => {
    const normalized = labels.map((label) => label.toLocaleLowerCase('tr-TR'));
    return pairMap.find((pair) => normalized.some((label) => pair.label === label || pair.label.includes(label)))?.value ?? null;
  };

  const pairPhone = pickPair('telefon', 'tel', 'phone', 'telephone');
  if (pairPhone && pairPhone.replace(/\D/g, '').length >= 10) {
    claims.push({ ...base, predicate: 'schema:telephone', value: pairPhone, confidence: 0.88, evidence: 'Structured visible label/value pair' });
  }
  const pairAddress = pickPair('adres', 'address');
  if (pairAddress && pairAddress.length >= 8) {
    claims.push({ ...base, predicate: 'schema:address', value: pairAddress, confidence: 0.87, evidence: 'Structured visible label/value pair' });
  }
  const pairHours = pickPair('çalışma saat', 'calisma saat', 'ziyaret saat', 'açılış saat', 'acilis saat', 'opening hours');
  if (pairHours && /\d{1,2}[:.]\d{2}/.test(pairHours)) {
    claims.push({ ...base, predicate: 'schema:openingHours', value: pairHours, confidence: 0.87, evidence: 'Structured visible label/value pair' });
  }
  const pairAdmission = pickPair('giriş ücreti', 'giris ucreti', 'bilet fiyat', 'ücret', 'ucret', 'admission');
  if (pairAdmission && /(?:tl|₺|ücretsiz|ucretsiz|free|\d)/i.test(pairAdmission)) {
    claims.push({ ...base, predicate: 'ab:admission', value: pairAdmission, confidence: 0.84, evidence: 'Structured visible label/value pair' });
  }
  const pairEmail = pickPair('e-posta', 'eposta', 'email', 'e-mail');
  if (pairEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pairEmail)) {
    claims.push({ ...base, predicate: 'schema:email', value: pairEmail, confidence: 0.9, evidence: 'Structured visible label/value pair' });
  }
  const pairCategory = pickPair('kategori', 'category', 'tür', 'tur');
  if (pairCategory) {
    claims.push({ ...base, predicate: 'ab:category', value: pairCategory, confidence: 0.8, evidence: 'Structured visible label/value pair' });
  }

  const phoneMatch = text.match(/(?:telefon|tel\.?|phone)\s*[:\-]?\s*((?:\+?90\s*)?(?:\(?0?\d{3}\)?[\s.-]*)?\d{3}[\s.-]*\d{2}[\s.-]*\d{2})/i);
  const phone = phoneMatch?.[1] ? clean(phoneMatch[1]) : null;
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 12) {
      claims.push({ ...base, predicate: 'schema:telephone', value: phone, confidence: 0.82, evidence: 'Visible page text: phone pattern' });
    }
  }

  const priceRange = firstMatch(text, [
    /(?:fiyat araligi|fiyat aralığı|price range)\s*[:\-]?\s*([^.;|]{2,40})/i
  ]);
  if (priceRange) claims.push({ ...base, predicate: 'schema:priceRange', value: priceRange, confidence: 0.78, evidence: 'Visible page text: labeled price range' });

  const address = firstMatch(text, [
    /(?:adres|address)\s*[:\-]\s*([^|]{8,180}?)(?=\s+(?:telefon|tel\.?|e-?posta|email|web|iletisim|iletişim)\b|$)/i
  ]);
  if (address && /(?:mah\.?|mahalle|cad\.?|caddesi|sok\.?|sokak|bulvar|blv\.?|no\s*[:.]?|ankara|istanbul|izmir|eskisehir|eskişehir)/i.test(address)) {
    claims.push({ ...base, predicate: 'schema:address', value: address, confidence: 0.8, evidence: 'Visible page text: labeled address' });
  }

  const openingHours = firstMatch(text, [
    /(?:calisma saatleri|çalışma saatleri|acilis saatleri|açılış saatleri|ziyaret saatleri|opening hours)\s*[:\-]?\s*([^|]{5,140}?)(?=\s+(?:adres|telefon|tel\.?|iletisim|iletişim|bilet|ucret|ücret)\b|$)/i
  ]);
  if (openingHours && /\b\d{1,2}[:.]\d{2}\b/.test(openingHours)) {
    claims.push({ ...base, predicate: 'schema:openingHours', value: openingHours, confidence: 0.8, evidence: 'Visible page text: labeled opening hours' });
  }

  const admission = firstMatch(text, [
    /(?:giris ucreti|giriş ücreti|bilet fiyati|bilet fiyatı|ucret|ücret)\s*[:\-]?\s*([^.;|]{2,80}?)(?=\s+(?:kurulus|kuruluş|kategori|category|adres|telefon|tel\.?|calisma|çalışma|ziyaret)\b|$)/i
  ]);
  if (admission && /(?:tl|₺|ucretsiz|ücretsiz|free|\d)/i.test(admission)) {
    claims.push({ ...base, predicate: 'ab:admission', value: admission, confidence: 0.76, evidence: 'Visible page text: labeled admission/fee' });
  }

  const established = firstMatch(text, [
    /(?:kurulus tarihi|kuruluş tarihi|kuruldugu yil|kurulduğu yıl|founded|established)\s*[:\-]?\s*((?:18|19|20)\d{2})/i
  ]);
  if (established) claims.push({ ...base, predicate: 'schema:foundingDate', value: established, confidence: 0.78, evidence: 'Visible page text: labeled founding year' });

  const coordinates = text.match(/(?:enlem|latitude)\s*[:\-]?\s*(-?\d{1,2}\.\d+)\s*[,; ]+(?:boylam|longitude)\s*[:\-]?\s*(-?\d{1,3}\.\d+)/i);
  if (coordinates) {
    const latitude = Number(coordinates[1]);
    const longitude = Number(coordinates[2]);
    if (latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
      claims.push({ ...base, predicate: 'schema:geo', value: { latitude, longitude }, confidence: 0.86, evidence: 'Visible page text: labeled coordinates' });
    }
  }

  const category = firstMatch(text, [
    /(?:kategori|category|tur|tür)\s*[:\-]\s*([^.;|]{2,60}?)(?=\s+(?:adres|telefon|tel\.?|calisma|çalışma|bilet|ucret|ücret|kurulus|kuruluş)\b|$)/i
  ]);
  if (category) claims.push({ ...base, predicate: 'ab:category', value: category, confidence: 0.72, evidence: 'Visible page text: labeled category' });

  claims.push(...extractSentenceClaims({ rawText: input.rawText, subjectName: input.subjectName, subjectType: input.subjectType ?? null }));

  return uniqueClaims(claims).slice(0, 60);
}
