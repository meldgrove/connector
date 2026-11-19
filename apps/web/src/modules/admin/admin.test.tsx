import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Source } from "@connector/shared/api/sources";
import type { Me, Person } from "@connector/shared/api/users";
import { AdminPeoplePage } from "./people-page";
import { AdminSourcesPage } from "./sources-page";
import { createBody, emptyForm, formOf, slugFrom, updateBody } from "./source-dialog";

const me: Me = {
  id: "0b5a3e5e-3c1f-4d8e-9f3a-555555555555",
  email: "ada@example.org",
  name: "Ada Lovelace",
  image: null,
  isAdmin: true,
  groups: ["/staff/it"],
};

function person(overrides: Partial<Person>): Person {
  return {
    id: "0b5a3e5e-3c1f-4d8e-9f3a-666666666666",
    email: "rita@example.org",
    name: "Rita Reader",
    title: null,
    isAdmin: false,
    adminSource: null,
    blocked: false,
    directory: null,
    groups: [],
    lastSignInAt: null,
    createdAt: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

const handbook: Source = {
  id: "0b5a3e5e-3c1f-4d8e-9f3a-888888888888",
  slug: "handbook",
  kind: "handbook",
  name: "Handbook",
  description: null,
  enabled: true,
  accessGroups: ["/staff"],
  serviceAccess: true,
  position: 0,
  config: { baseUrl: "https://handbook.example.org", ruleSpaces: ["policies"], allowLinking: true },
  secrets: { serviceToken: "…abcd" },
  webhookUrl: null,
  status: { at: "2026-11-19T10:00:00.000Z", ok: true, message: "Reached Handbook: 4 spaces" },
  stats: null,
  createdAt: "2026-11-19T09:00:00.000Z",
  updatedAt: "2026-11-19T09:00:00.000Z",
};

type Reply = unknown | ((init?: RequestInit) => unknown);

function routeFetch(routes: Record<string, Reply>) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const entry = routes[`${init?.method ?? "GET"} ${url.split("?")[0]}`];
    const body = typeof entry === "function" ? (entry as (init?: RequestInit) => unknown)(init) : entry;
    return new Response(JSON.stringify(body ?? { error: { code: "x", message: "No reply" } }), {
      status: body ? 200 : 500,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function renderAt(path: string, Component: () => React.ReactNode) {
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => (
      <Suspense fallback={null}>
        <Component />
      </Suspense>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("source forms", () => {
  it("makes slugs from names", () => {
    expect(slugFrom("Our Handbook")).toBe("our-handbook");
    expect(slugFrom("2026 Logbook")).toBe("logbook");
    expect(slugFrom("Bücherei")).toBe("bucherei");
    expect(slugFrom("A".repeat(60))).toHaveLength(40);
  });

  it("sends the kind's settings and only the secrets that were typed", () => {
    const form = {
      ...emptyForm("crm"),
      name: "CRM",
      slug: "crm",
      baseUrl: "https://crm.example.org",
      apiKey: "crm_secret",
      accessGroups: "/staff, /board",
    };
    expect(createBody(form)).toEqual({
      kind: "crm",
      slug: "crm",
      name: "CRM",
      description: null,
      enabled: true,
      accessGroups: ["/staff", "/board"],
      serviceAccess: false,
      config: {
        baseUrl: "https://crm.example.org",
        types: ["contact", "organization", "deal", "event", "meeting"],
      },
      secret: { apiKey: "crm_secret" },
    });
    const edited = formOf(handbook);
    expect(edited.ruleSpaces).toBe("policies");
    expect(edited.serviceToken).toBe("");
    expect(updateBody(edited)).not.toHaveProperty("secret");
    expect(updateBody({ ...edited, ruleSpaces: "purpose, policies" }).config).toEqual({
      baseUrl: "https://handbook.example.org",
      ruleSpaces: ["purpose", "policies"],
      allowLinking: true,
    });
  });
});

describe("admin sources", () => {
  it("lists sources with access and status, and connects a new one", async () => {
    let posted: unknown;
    const logbook: Source = {
      ...handbook,
      id: "0b5a3e5e-3c1f-4d8e-9f3a-999999999999",
      slug: "logbook",
      kind: "logbook",
      name: "Logbook",
      accessGroups: [],
      serviceAccess: false,
      config: { baseUrl: "https://logbook.example.org" },
      secrets: {},
      webhookUrl: "https://connector.example.org/hooks/logbook",
      status: null,
      stats: { items: 0, lastDeliveryAt: null },
    };
    routeFetch({
      "GET /api/v1/admin/sources": { items: [handbook] },
      "POST /api/v1/admin/sources": (init?: RequestInit) => {
        posted = JSON.parse(String(init?.body));
        return logbook;
      },
      [`POST /api/v1/admin/sources/${logbook.id}/webhook-secret`]: {
        webhookSecret: "generated-secret-1234567890",
      },
    });
    renderAt("/admin/sources", AdminSourcesPage);
    const row = (await screen.findByText("Reached Handbook: 4 spaces")).closest("tr")!;
    expect(within(row).getByText("Members of /staff")).toBeInTheDocument();
    expect(within(row).getByText("Bots too")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Connect a source" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Meldgrove Logbook" }));
    await user.type(within(dialog).getByLabelText("Name"), "Logbook");
    expect(within(dialog).getByLabelText("Short name")).toHaveValue("logbook");
    await user.type(within(dialog).getByLabelText("Address of the app"), "https://logbook.example.org");
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(posted).toEqual({
        kind: "logbook",
        slug: "logbook",
        name: "Logbook",
        description: null,
        enabled: true,
        accessGroups: [],
        serviceAccess: false,
        config: { baseUrl: "https://logbook.example.org" },
        secret: {},
      }),
    );
    // A webhook source opens its webhook setup: the URL, and a secret shown once.
    expect(await screen.findByTestId("webhook-url")).toHaveTextContent(
      "https://connector.example.org/hooks/logbook",
    );
    await user.click(screen.getByRole("button", { name: "Generate webhook secret" }));
    expect(await screen.findByTestId("webhook-secret")).toHaveTextContent("generated-secret-1234567890");
  });
});

describe("admin people", () => {
  it("protects yourself and admins from ADMIN_EMAILS, and shows groups and the directory", async () => {
    routeFetch({
      "GET /api/v1/me": me,
      "GET /api/v1/admin/people": {
        items: [
          person({ id: me.id, email: me.email, name: me.name, isAdmin: true, adminSource: "app" }),
          person({
            id: "0b5a3e5e-3c1f-4d8e-9f3a-777777777777",
            email: "root@example.org",
            name: "",
            isAdmin: true,
            adminSource: "environment",
          }),
          person({ groups: ["/staff", "/teams/Programs"], directory: "scim", title: "Program lead" }),
        ],
      },
    });
    renderAt("/admin/people", AdminPeoplePage);
    const self = (await screen.findByText("(you)")).closest("tr")!;
    expect(within(self).getByRole("switch")).toBeDisabled();
    expect(within(self).queryByRole("button", { name: "Block" })).not.toBeInTheDocument();
    const environment = screen.getByText("root@example.org").closest("tr")!;
    expect(within(environment).getByRole("switch")).toBeDisabled();
    expect(within(environment).getByText("From ADMIN_EMAILS")).toBeInTheDocument();
    const rita = screen.getByText("Rita Reader").closest("tr")!;
    expect(within(rita).getByRole("switch")).toBeEnabled();
    expect(within(rita).getByText("/teams/Programs")).toBeInTheDocument();
    expect(within(rita).getByText("SCIM")).toBeInTheDocument();
    expect(within(rita).getByText("Program lead")).toBeInTheDocument();
  });

  it("removes a person after asking", async () => {
    const rita = person({});
    const fetch = routeFetch({
      "GET /api/v1/me": me,
      "GET /api/v1/admin/people": { items: [rita] },
      [`DELETE /api/v1/admin/people/${rita.id}`]: {},
    });
    renderAt("/admin/people", AdminPeoplePage);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove Rita Reader?" });
    expect(dialog).toHaveTextContent("show them as “Removed person”");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/api/v1/admin/people/${rita.id}`),
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });
});
