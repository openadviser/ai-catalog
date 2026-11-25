// MOD-1: a model may state what it accepts as input. Absent means not established; the member is new
// in 1.2.0, so a document that declares 1.0.x or 1.1.x does not have it, and a client that reads the
// catalog without the member prices exactly as before.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AiCatalogError,
  inputModalities,
  load,
  models,
  providers,
  resolveModel,
} from "../src/index.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../../conformance/fixtures/${name}`, import.meta.url), "utf8");
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The accepting fixture, changed by `change` and written as one JSON document. */
interface Doc {
  schemaVersion: string;
  providers: { models: { inputModalities?: unknown }[] }[];
}

/** The first model of the first provider. */
const firstModel = (c: Doc): { inputModalities?: unknown } => {
  const model = c.providers[0]?.models[0];
  if (model === undefined) throw new Error("the fixture has no model");
  return model;
};

/** The first model's `inputModalities` object. */
const modalitiesOf = (c: Doc): Record<string, unknown> =>
  firstModel(c).inputModalities as Record<string, unknown>;

function document(change: (catalog: Doc) => void): Uint8Array {
  const catalog = JSON.parse(fixture("input-modalities.json")) as Doc;
  change(catalog);
  return encode(JSON.stringify(catalog));
}

/** The accepting fixture with the first model's `values` replaced by the JSON text `json`. */
const withValues = (json: string): Uint8Array =>
  document((c) => {
    modalitiesOf(c).values = JSON.parse(json);
  });

async function codeOf(bytes: Uint8Array): Promise<string | undefined> {
  try {
    await load(bytes);
    return undefined;
  } catch (error) {
    if (error instanceof AiCatalogError) return error.code;
    throw error;
  }
}

describe("input modalities", () => {
  it("reads the values a model states, and null where it states none", async () => {
    const catalog = await load(encode(fixture("input-modalities.json")));
    expect(inputModalities(catalog, "anthropic", "vector-text")).toEqual(["text", "image"]);
    expect(inputModalities(catalog, "anthropic", "vector-mini")).toEqual([
      "text",
      "image",
      "audio",
      "video",
      "pdf",
    ]);
    expect(inputModalities(catalog, "anthropic", "vector-effort-only")).toBeNull();
  });

  it("carries the values on the model view next to the effort levels", async () => {
    const catalog = await load(encode(fixture("input-modalities.json")));
    const mini = resolveModel(catalog, "anthropic", "vector-mini");
    expect(mini.inputModalities).toEqual(["text", "image", "audio", "video", "pdf"]);
    expect(mini.effort).not.toBeNull();
    expect(models(catalog, "anthropic").map((m) => m.inputModalities === null)).toEqual([
      false,
      false,
      true,
    ]);
    expect(Object.isFrozen(mini.inputModalities)).toBe(true);
  });

  it("reads a catalog without the member as null for every model", async () => {
    const catalog = await load(encode(fixture("text.json")));
    for (const model of models(catalog, "anthropic")) expect(model.inputModalities).toBeNull();
  });

  it("refuses a value outside the closed set", async () => {
    expect(await codeOf(withValues('["text", "hologram"]'))).toBe("invalid-input-modalities");
    expect(await codeOf(withValues('["TEXT"]'))).toBe("invalid-input-modalities");
    expect(await codeOf(withValues('["document"]'))).toBe("invalid-input-modalities");
  });

  it("refuses a repeated value, a list out of order and an empty list", async () => {
    expect(await codeOf(withValues('["text", "text"]'))).toBe("invalid-input-modalities");
    expect(await codeOf(withValues('["audio", "text"]'))).toBe("invalid-input-modalities");
    expect(await codeOf(withValues('["pdf", "image"]'))).toBe("invalid-input-modalities");
    expect(await codeOf(withValues("[]"))).toBe("invalid-input-modalities");
  });

  it("calls a value that is not a string, or a member of another shape, a structure error", async () => {
    expect(await codeOf(withValues('[5, "text"]'))).toBe("invalid-structure");
    expect(await codeOf(withValues("null"))).toBe("invalid-structure");
    expect(
      await codeOf(
        document((c) => {
          modalitiesOf(c).extra = true;
        }),
      ),
    ).toBe("invalid-structure");
    expect(
      await codeOf(
        document((c) => {
          delete modalitiesOf(c).provenance;
        }),
      ),
    ).toBe("invalid-structure");
    expect(
      await codeOf(
        document((c) => {
          firstModel(c).inputModalities = ["text"];
        }),
      ),
    ).toBe("invalid-structure");
  });

  it("does not know the member in a document that declares 1.0.x or 1.1.x", async () => {
    for (const version of ["1.0.0", "1.1.0", "1.1.3"]) {
      const bytes = document((c) => {
        c.schemaVersion = version;
      });
      expect(await codeOf(bytes), version).toBe("invalid-structure");
    }
    const modern = document((c) => {
      c.schemaVersion = "1.2.4";
    });
    expect(await codeOf(modern)).toBeUndefined();
  });

  it("does not let a refused document change how the next one is read", async () => {
    const old = document((c) => {
      c.schemaVersion = "1.1.0";
    });
    expect(await codeOf(old)).toBe("invalid-structure");
    expect(await codeOf(encode(fixture("input-modalities.json")))).toBeUndefined();
  });

  it("reads a 1.1.0 catalog that has no member exactly as before", async () => {
    const bytes = encode(
      fixture("text.json").replace(/"schemaVersion": "[^"]*"/, '"schemaVersion": "1.1.0"'),
    );
    const catalog = await load(bytes);
    expect(catalog.schemaVersion).toBe("1.1.0");
    expect(inputModalities(catalog, "anthropic", "vector-text")).toBeNull();
  });
});

describe("the published catalog's input modalities", () => {
  const published = async () =>
    load(readFileSync(new URL("../../../data/catalog.json", import.meta.url)));

  it("states audio only for the models whose own page lists audio, and never by analogy", async () => {
    const catalog = await published();
    const audio: string[] = [];
    for (const provider of providers(catalog)) {
      for (const model of models(catalog, provider)) {
        if (model.inputModalities?.includes("audio")) audio.push(`${provider}/${model.id}`);
      }
    }
    expect(audio.sort()).toEqual([
      "google-gemini/gemini-3.8-flash",
      "google-gemini/gemini-4-argon",
      "google-gemini/gemini-4-carbon",
      "google-gemini/gemini-4-hydrogen",
      "google-gemini/gemini-4-neon",
    ]);
  });

  it("leaves a model with no cited page unestablished", async () => {
    const catalog = await published();
    for (const model of models(catalog, "elevenlabs")) expect(model.inputModalities).toBeNull();
    for (const provider of ["anthropic", "openai", "google-gemini"]) {
      for (const model of models(catalog, provider)) expect(model.inputModalities).not.toBeNull();
    }
  });

  it("states text and images, and no audio, for every Claude and GPT-6 model", async () => {
    const catalog = await published();
    for (const provider of ["anthropic", "openai"]) {
      for (const model of models(catalog, provider)) {
        expect(model.inputModalities, `${provider}/${model.id}`).toEqual(["text", "image"]);
      }
    }
  });
});
