import type { Authority, SourceKind } from "@connector/shared/sources";
import type { Item, SearchResult } from "@connector/shared/api/search";
import type { Db } from "../db/client";
import type { sources } from "../db/schema";
import type { Principal } from "../auth/principal";

export type SourceRow = typeof sources.$inferSelect;

/** A result before Connector adds the source's name and slug. */
export type Hit = Omit<SearchResult, "source" | "id"> & { type: string; externalId: string };

/** A fetched item before Connector adds the source. */
export type FetchedItem = Omit<Item, "source" | "id"> & { type: string; externalId: string };

/** What an adapter gets for one request. */
export type AdapterContext = {
  db: Db;
  source: SourceRow;
  config: Record<string, unknown>;
  secret: Record<string, unknown>;
  principal: Principal;
  /** Ends when the source's time is up or the caller went away. */
  signal: AbortSignal;
};

/**
 * One kind of app (docs/sources.md). Live adapters ask the app; webhook
 * adapters read Connector's index of what the app sent.
 */
export type Adapter = {
  kind: SourceKind;
  /** Checks address and credentials; returns a short message, throws `SourceError`. */
  check(context: AdapterContext): Promise<string>;
  search(context: AdapterContext, query: string, limit: number): Promise<Hit[]>;
  /** One item, or null when it does not exist or the caller may not see it. */
  fetch(context: AdapterContext, type: string, externalId: string): Promise<FetchedItem | null>;
  /** What changed since `since`, newest first. */
  recent(context: AdapterContext, since: Date, limit: number): Promise<Hit[]>;
};

/** A source that did not answer as expected; the message is shown to people and agents. */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export type { Authority };
