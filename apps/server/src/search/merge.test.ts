import { describe, expect, it } from "vitest";
import type { SearchResult } from "@connector/shared/api/search";
import type { Authority } from "@connector/shared/sources";
import { diagnosticOf, mergeResults } from "./federate";

const result = (id: string, authority: Authority): SearchResult => ({
  id,
  title: id,
  url: `https://example.org/${id}`,
  snippet: "",
  type: "page",
  source: { slug: "s", name: "S", kind: "handbook" },
  authority,
  date: null,
  status: null,
});

describe("mergeResults", () => {
  it("takes each source's best first and lets the stronger source win a round", () => {
    const handbook = [result("page-1", "knowledge"), result("policy", "rules")];
    const logbook = [result("decision", "decision"), result("old", "history")];
    const library = [result("note", "library")];
    expect(mergeResults([library, handbook, logbook], 10).map((item) => item.id)).toEqual([
      "decision",
      "page-1",
      "note",
      "policy",
      "old",
    ]);
    expect(mergeResults([handbook, logbook], 3)).toHaveLength(3);
  });
});

describe("diagnosticOf", () => {
  it("keeps Connector's words and drops the app's error text", () => {
    expect(diagnosticOf("Handbook refused the credentials: Unknown token")).toBe(
      "Handbook refused the credentials",
    );
    expect(diagnosticOf("CRM does not allow this: no access to rita@example.org")).toBe(
      "CRM does not allow this",
    );
    expect(diagnosticOf("Handbook answered HTTP 500: boom")).toBe("Handbook answered HTTP 500");
    expect(diagnosticOf("Could not reach Handbook at http://127.0.0.1:9: connection failed")).toBe(
      "Could not reach Handbook at http://127.0.0.1:9: connection failed",
    );
    expect(diagnosticOf("Handbook did not answer in time")).toBe("Handbook did not answer in time");
    expect(diagnosticOf("The sign-in server refused: invalid_grant")).toBe("The sign-in server refused");
    expect(diagnosticOf("The source refused Connector's registration: bad redirect for rita")).toBe(
      "The source refused Connector's registration",
    );
  });
});
