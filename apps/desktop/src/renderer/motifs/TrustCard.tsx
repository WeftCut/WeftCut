// The trust card: a project Motif whose revision is not trusted on this
// machine, in its row's pane (ADR 0174). It shows main's static read of the
// files (`src/main/motif/trustSummary.ts`) and one action, Trust; nothing
// here loads the Motif. Trust names the revision the summary was read from,
// so files changed since are shown again rather than trusted unseen.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { motifTrustSummary, trustMotif, type MotifTrustCard, type MotifTrustSummary } from "../ipc";
import { refusalText } from "../errors/tryMutate";
import { formatBytes } from "../lib/formatBytes";

/** Paths listed per summary line before the rest is counted. */
const LISTED = 5;

export function TrustCard({ motifId }: { motifId: string }) {
  const { t } = useTranslation();
  const [card, setCard] = useState<MotifTrustCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    motifTrustSummary(motifId).then(
      (next) => { if (alive.current) setCard(next); },
      (e) => { if (alive.current) setError(refusalText(e)); },
    );
    return () => { alive.current = false; };
  }, [motifId]);

  const trust = async () => {
    if (!card) return;
    setBusy(true);
    setError(null);
    setChanged(false);
    try {
      // `motifs:changed` follows: the row renders and this card goes.
      await trustMotif(motifId, card.revision);
    } catch (e) {
      const now = await motifTrustSummary(motifId).catch(() => null);
      if (!alive.current) return;
      if (now && now.revision !== card.revision) {
        setCard(now);
        setChanged(true);
      } else setError(refusalText(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <section className="motif-trust" aria-label={t("motif_trust.title")}>
      <h3>{t("motif_trust.title")}</h3>
      <p className="settings-status">{t("motif_trust.lead")}</p>
      {card ? <TrustSummary summary={card.summary} /> : !error && <p className="settings-status">{t("motif_trust.loading")}</p>}
      {changed && <p className="settings-status" role="status">{t("motif_trust.changed")}</p>}
      {error && <p className="settings-error" role="alert">{error}</p>}
      <div className="motif-trust-actions">
        <Button variant="default" size="sm" disabled={!card || busy} onClick={() => void trust()}>
          {busy ? t("motif_trust.trusting") : t("motif_trust.trust")}
        </Button>
      </div>
      <p className="motif-picker-hint">{t("motif_trust.hint")}</p>
    </section>
  );
}

/** One line per finding; a finding the files do not show has no line. */
function TrustSummary({ summary }: { summary: MotifTrustSummary }) {
  const { t, i18n } = useTranslation();
  const chars = new Intl.NumberFormat(i18n.language);
  const listed = (items: string[]) => items.length > LISTED
    ? `${items.slice(0, LISTED).join(", ")} ${t("motif_trust.more", { count: items.length - LISTED })}`
    : items.join(", ");
  const files = t("motif_trust.files_value", { count: summary.files, size: formatBytes(summary.bytes) });
  const lines: [string, string][] = [
    ["files", summary.binary > 0 ? `${files} · ${t("motif_trust.binary", { count: summary.binary })}` : files],
  ];
  if (summary.scripts.length) lines.push(["scripts", listed(summary.scripts.map((s) => `${s.path} (${formatBytes(s.bytes)})`))]);
  if (summary.workers.length) lines.push(["workers", listed(summary.workers)]);
  if (summary.wasm.length) lines.push(["wasm", listed(summary.wasm)]);
  if (summary.minified.length) lines.push(["minified", listed(summary.minified.map((m) =>
    t("motif_trust.minified_item", { path: m.path, chars: chars.format(m.longest_line) })))]);
  if (summary.unscanned.length) lines.push(["unscanned", listed(summary.unscanned)]);
  return (
    <dl className="motif-trust-summary">
      {lines.map(([key, value]) => (
        <div key={key}>
          <dt>{t(`motif_trust.${key}`)}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
