import { Bot } from "lucide-react";
import { Page, PageHeader } from "@/components/layout/page";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useT } from "@/i18n";
import { useConnectInfo } from "@/modules/settings/api";
import { AdminTokens } from "./admin-tokens";
import { messages } from "./messages";

/** The knowledge source settings of the Meldgrove Support Agent (HTTP search API). */
function SupportAgentCard() {
  const t = useT(messages);
  const appUrl = useConnectInfo().data?.appUrl ?? window.location.origin;
  const rows: [string, string][] = [
    [t("knowledgeUrl"), `${appUrl}/api/v1/knowledge/search`],
    [t("method"), "POST, Authorization: Bearer <service token>"],
    [t("bodyTemplate"), '{"query": "{{query}}", "limit": "{{limit}}"} (the default)'],
    [t("paths"), "results · title · url · text · section (the defaults)"],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4" aria-hidden />
          {t("supportAgentTitle")}
        </CardTitle>
        <CardDescription>{t("supportAgentText")}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>
                <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs break-all">{value}</code>
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

export function AdminServiceTokensPage() {
  const t = useT(messages);
  return (
    <Page>
      <PageHeader title={t("tokensTitle")} description={t("tokensDescription")} />
      <SupportAgentCard />
      <Card>
        <CardContent>
          <AdminTokens
            kind="service"
            newLabel={t("newToken")}
            createTitle={t("createTokenTitle")}
            createDescription={t("createTokenDescription")}
            nameHint={t("tokenNameHint")}
            empty={t("noTokens")}
            emptyHint={t("noTokensHint")}
          />
        </CardContent>
      </Card>
    </Page>
  );
}
