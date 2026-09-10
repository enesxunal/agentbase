export type Source = {
  id: string;
  name: string;
  url: string;
  type: "official" | "public" | "editorial";
  retrievedAt: string;
};

export type Fact = {
  id: string;
  predicate: string;
  value: string | number | boolean | string[];
  confidence: number;
  status: "verified" | "observed" | "unknown" | "conflicting";
  sourceIds: string[];
  lastChecked: string;
};

export type Entity = {
  id: string;
  slug: string;
  type: "city" | "place" | "food" | "business" | "event" | "book";
  name: string;
  summary: string;
  location?: { city?: string; country: string };
  facts: Fact[];
  sourceIds: string[];
  updatedAt: string;
};

const now = new Date().toISOString();

export const sources: Source[] = [
  {
    id: "source_official_ankara",
    name: "Ankara resmi turizm kaynağı",
    url: "https://www.ankara.bel.tr/",
    type: "official",
    retrievedAt: now
  },
  {
    id: "source_official_eskisehir",
    name: "Eskişehir resmi şehir kaynağı",
    url: "https://www.eskisehir.bel.tr/",
    type: "official",
    retrievedAt: now
  }
];

export const entities: Entity[] = [
  {
    id: "city_ankara",
    slug: "ankara",
    type: "city",
    name: "Ankara",
    summary: "Türkiye'nin başkenti; tarih, müzeler, kamusal alanlar ve şehir yaşamı için önemli bir merkez.",
    location: { city: "Ankara", country: "TR" },
    sourceIds: ["source_official_ankara"],
    updatedAt: now,
    facts: [
      {
        id: "fact_ankara_country",
        predicate: "country",
        value: "Türkiye",
        confidence: 1,
        status: "verified",
        sourceIds: ["source_official_ankara"],
        lastChecked: now
      },
      {
        id: "fact_ankara_intent",
        predicate: "recommended_for",
        value: ["tarih", "müze", "şehir gezisi"],
        confidence: 0.9,
        status: "observed",
        sourceIds: ["source_official_ankara"],
        lastChecked: now
      }
    ]
  },
  {
    id: "food_ciborek",
    slug: "ciborek",
    type: "food",
    name: "Çibörek",
    summary: "Eskişehir ile güçlü biçimde özdeşleşen, ince hamur ve kıymalı içle hazırlanan geleneksel yemek.",
    location: { city: "Eskişehir", country: "TR" },
    sourceIds: ["source_official_eskisehir"],
    updatedAt: now,
    facts: [
      {
        id: "fact_ciborek_region",
        predicate: "associated_city",
        value: "Eskişehir",
        confidence: 0.96,
        status: "verified",
        sourceIds: ["source_official_eskisehir"],
        lastChecked: now
      }
    ]
  }
];
