// Schichtwünsche anzeigen: gestrichelt, mit „Wunsch“ und der Lage – deutlich anders als eine feste Schicht.
import type { CSSProperties } from "react";
import { fmtLongDay } from "../lib/dates";
import { studioColor } from "../lib/studios";
import { SLOT_LABEL, type SlotTime, slotTime, type Wish, WISH_NOTICE } from "../lib/wishes";
import { Avatar, Notice, Pill, Row } from "./ui";

export function WishNotice() {
  return <Notice tone="warn">{WISH_NOTICE}</Notice>;
}

export function WishRow(props: {
  wish: Wish;
  slots: SlotTime[];
  showDay?: boolean;
  studioName?: string;
  busy?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
  onWithdraw?: () => void;
}) {
  const w = props.wish;
  const t = slotTime(props.slots, w.location_id, w.slot);
  const name = w.user ? `${w.user.first_name} ${w.user.last_name}` : "Wunsch";
  const sub = [
    props.showDay ? fmtLongDay(w.day) : "",
    `${SLOT_LABEL[w.slot]}${t ? ` ${t.starts}–${t.ends}` : ""}`,
    props.studioName ?? "",
    w.status === "rejected" ? "abgelehnt" : "",
  ].filter(Boolean).join(" · ");
  return (
    <Row
      className={`is-wish${w.status === "rejected" ? " is-rejected" : ""}`}
      style={{ "--studio": studioColor(w.location_id) } as CSSProperties}
      leading={<Avatar first={w.user?.first_name ?? "?"} last={w.user?.last_name} color={studioColor(w.user?.home_location_id)} />}
      title={<>{name} <Pill tone="accent">Wunsch</Pill> <Pill tone="muted">{SLOT_LABEL[w.slot]}</Pill></>}
      subtitle={sub}
      trailing={
        (props.onApprove || props.onReject || props.onWithdraw) && (
          <span className="row-actions">
            {props.onReject && <button type="button" className="btn btn-outline btn-sm" disabled={props.busy} onClick={props.onReject}>Ablehnen</button>}
            {props.onApprove && <button type="button" className="btn btn-primary btn-sm" disabled={props.busy} onClick={props.onApprove}>Freigeben</button>}
            {props.onWithdraw && <button type="button" className="btn btn-outline btn-sm" disabled={props.busy} onClick={props.onWithdraw}>Zurückziehen</button>}
          </span>
        )
      }
    />
  );
}
