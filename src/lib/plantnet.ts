import { env } from "./env";

export type PlantNetCandidate = {
  score: number;
  species: {
    scientificName?: string;
    scientificNameWithoutAuthor?: string;
    commonNames?: string[];
    family?: {
      scientificName?: string;
    };
    genus?: {
      scientificName?: string;
    };
  };
  gbif?: {
    id?: string;
  };
  powo?: {
    id?: string;
  };
  images?: Array<{
    url?: {
      o?: string;
      m?: string;
      s?: string;
    };
    organ?: string;
    author?: string;
    license?: string;
  }>;
};

export type PlantNetResponse = {
  bestMatch?: string;
  results?: PlantNetCandidate[];
  predictedOrgans?: Array<{
    filename?: string;
    organ?: string;
    score?: number;
  }>;
  remainingIdentificationRequests?: number;
  version?: string;
};

export async function identifyWithPlantNet(input: {
  files: Array<{
    filename: string;
    mimeType: string;
    buffer: Buffer;
    organ?: "auto" | "leaf" | "flower" | "fruit" | "bark";
  }>;
  lang?: string;
  includeRelatedImages?: boolean;
  nbResults?: number;
}) {
  if (!env.plantnetApiKey) {
    throw new Error("PLANTNET_API_KEY is not configured.");
  }

  const form = new FormData();

  for (const file of input.files) {
    const blob = new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }); form.append("images", blob, file.filename);
    form.append("organs", file.organ || "auto");
  }

  const params = new URLSearchParams({
    "api-key": env.plantnetApiKey,
    "include-related-images": input.includeRelatedImages ? "true" : "false",
    "nb-results": String(input.nbResults ?? 5),
    lang: input.lang || "en",
  });

  const response = await fetch(
    `https://my-api.plantnet.org/v2/identify/all?${params.toString()}`,
    {
      method: "POST",
      body: form,
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pl@ntNet request failed: ${response.status} ${text}`);
  }

  return (await response.json()) as PlantNetResponse;
}