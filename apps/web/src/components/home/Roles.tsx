// "Pick your role": allocator (Senior vs Junior), sponsor, BKRN staker, committee member, agent operator,
// each with what the role does in a sentence or two and a link to the page where it happens.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { SERIES_CLASS } from "../../lib/palette";
import { cx } from "../cx";
import { IconArrowRight, IconBook, IconCoin, IconShield } from "../icons";
import { Section, Term, TrancheBadge } from "../ui";
import { IconAgent, IconPeople } from "./art";

interface Role {
  id: string;
  title: string;
  icon: ReactNode;
  iconClass: string;
  body: ReactNode;
  to: string;
  cta: string;
}

const ROLES: Role[] = [
  {
    id: "sponsor",
    title: "Sponsor",
    icon: <IconBook size={18} />,
    iconClass: "bg-accent-soft text-accent-text",
    body: (
      <>
        Charter a new market. File its terms, pay a flat USDC fee (refunded if rejected), lock a BKRN bond and hold at least 10% of its{" "}
        <Term id="junior">Junior</Term> tranche when the subscription window closes.
      </>
    ),
    to: "/charters/new",
    cta: "File a charter",
  },
  {
    id: "staker",
    title: "BKRN staker",
    icon: <IconShield size={18} />,
    iconClass: cx(SERIES_CLASS.bkrn.soft, SERIES_CLASS.bkrn.text),
    body: (
      <>
        <Term id="staking">Stake</Term> BKRN to post the bonds sponsors, committee members and agent operators need. Half of the protocol carry buys BKRN for stakers; the
        other half funds the <Term id="backstop">backstop</Term>. Access and bonding, never a revenue claim: no claim on any book's USDC or fee flow.
      </>
    ),
    to: "/stake",
    cta: "Stake BKRN",
  },
  {
    id: "committee",
    title: "Committee member",
    icon: <IconPeople size={18} />,
    iconClass: "bg-accent-soft text-accent-text",
    body: (
      <>
        Sit on the <Term id="riskCommittee">Risk Committee</Term> with a BKRN bond. Members vote on charters after a model-jury verdict, and can re-mandate or retire a live
        book, two of three.
      </>
    ),
    to: "/committee",
    cta: "Open the committee",
  },
  {
    id: "agent",
    title: "Agent operator",
    icon: <IconAgent size={18} />,
    iconClass: "bg-accent-soft text-accent-text",
    body: (
      <>
        Run a <Term id="bookrunnerAgent">bookrunner agent</Term> that quotes and hedges a book. Above the entry tier its keys are bonded in BKRN, and they can only take the
        actions the mandate allows.
      </>
    ),
    to: "/agents",
    cta: "See the agents",
  },
];

export function Roles() {
  return (
    <Section id="roles" tone="muted" eyebrow="Pick your role" title="Five ways to take part" lead="Most people start as an allocator. The other roles create the books, keep them in bounds and run them.">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <AllocatorCard />
        {ROLES.map((r) => (
          <RoleCard key={r.id} role={r} />
        ))}
      </div>
    </Section>
  );
}

function AllocatorCard() {
  return (
    <article className="flex flex-col rounded-card border border-accent/30 bg-surface p-5 shadow-card sm:p-6 md:col-span-2" aria-labelledby="role-allocator">
      <RoleHead id="role-allocator" title="Allocator" icon={<IconCoin size={18} />} iconClass="bg-accent-soft text-accent-text" tag="Start here" />
      <p className="mt-3 text-[14px] leading-relaxed text-ink-2">
        Fund a book with USDC and hold its tranche shares, valued at <Term id="nav">NAV</Term> at every mark. Choose the place in line that suits you:
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className={cx("rounded-[10px] border p-4", SERIES_CLASS.senior.border, SERIES_CLASS.senior.soft)}>
          <TrancheBadge tranche="senior" />
          <p className="mt-2 text-[13.5px] text-ink">A fixed share of each distribution. Last loss, not no loss.</p>
        </div>
        <div className={cx("rounded-[10px] border p-4", SERIES_CLASS.junior.border, SERIES_CLASS.junior.soft)}>
          <TrancheBadge tranche="junior" />
          <p className="mt-2 text-[13.5px] text-ink">Receives the residual fee flow and takes the first losses. Redeems after a notice period.</p>
        </div>
      </div>
      <div className="mt-auto flex flex-wrap gap-2 pt-5">
        <Link to="/invest" className="btn btn-primary">
          Invest
          <IconArrowRight size={14} />
        </Link>
        <Link to="/learn" className="btn">
          Compare the tranches
        </Link>
      </div>
    </article>
  );
}

function RoleCard({ role }: { role: Role }) {
  return (
    <article className="flex flex-col rounded-card border border-line bg-surface p-5 shadow-card sm:p-6" aria-labelledby={`role-${role.id}`}>
      <RoleHead id={`role-${role.id}`} title={role.title} icon={role.icon} iconClass={role.iconClass} />
      <p className="mt-3 text-[13.5px] leading-relaxed text-ink-2">{role.body}</p>
      <div className="mt-auto pt-5">
        <Link to={role.to} className="btn btn-sm">
          {role.cta}
          <IconArrowRight size={14} />
        </Link>
      </div>
    </article>
  );
}

function RoleHead({ id, title, icon, iconClass, tag }: { id: string; title: string; icon: ReactNode; iconClass: string; tag?: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className={cx("inline-flex size-9 shrink-0 items-center justify-center rounded-[10px]", iconClass)} aria-hidden>
        {icon}
      </span>
      <h3 id={id} className="text-[16px] font-semibold tracking-[-0.01em] text-ink">
        {title}
      </h3>
      {tag && (
        <span className="ml-auto rounded-full bg-accent-soft px-2.5 py-0.5 text-[11.5px] font-semibold text-accent-text">{tag}</span>
      )}
    </div>
  );
}
