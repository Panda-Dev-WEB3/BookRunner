// Opt-in browser notification of a liquidation-risk level that gets worse (riskLogic.riskNotice), sent by this page
// only while it is open: no service worker, no backend push, no email. The choice is remembered in this browser.
import { useEffect, useRef, useState } from "react";
import { safeLocalStorage } from "../../lib/safeStorage";
import { type PositionRisk, type RiskLevel, riskNotice } from "./riskLogic";

const KEY = "bkrn:trade:risk-notify";

const supported = () => typeof window !== "undefined" && "Notification" in window;
const permission = (): NotificationPermission | "unsupported" => (supported() ? Notification.permission : "unsupported");

export function useRiskNotifications(risk: PositionRisk | null, label: string) {
  const [on, setOn] = useState(() => safeLocalStorage().getItem(KEY) === "1" && permission() === "granted");
  const [perm, setPerm] = useState(permission);
  const prev = useRef<{ level: RiskLevel; ifClose: RiskLevel | null } | null>(null);

  useEffect(() => {
    if (!risk) {
      prev.current = null;
      return;
    }
    const notice = riskNotice(prev.current, risk, label);
    prev.current = { level: risk.level, ifClose: risk.ifClose };
    if (notice && on && permission() === "granted") {
      try {
        new Notification(notice.title, { body: notice.body, tag: `bkrn-risk-${label}` });
      } catch {
        // some browsers only allow notifications from a service worker: the page's own warning still shows
      }
    }
  }, [risk, label, on]);

  const enable = async () => {
    if (!supported()) return;
    const p = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    setPerm(p);
    const ok = p === "granted";
    setOn(ok);
    safeLocalStorage().setItem(KEY, ok ? "1" : "0");
  };
  const disable = () => {
    setOn(false);
    safeLocalStorage().setItem(KEY, "0");
  };
  return { supported: perm !== "unsupported", on, denied: perm === "denied", enable, disable };
}

export function RiskNotifyToggle({ n }: { n: ReturnType<typeof useRiskNotifications> }) {
  if (!n.supported) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-2">
      {n.on ? (
        <>
          <span>This tab notifies you when the risk level gets worse, while the page stays open.</span>
          <button type="button" className="btn btn-sm" onClick={n.disable}>
            Stop notifications
          </button>
        </>
      ) : n.denied ? (
        <span>Notifications are blocked for this site in your browser settings.</span>
      ) : (
        <>
          <button type="button" className="btn btn-sm" onClick={() => void n.enable()}>
            Notify me in this browser
          </button>
          <span>Only while this page is open; nothing is sent from a server.</span>
        </>
      )}
    </div>
  );
}
