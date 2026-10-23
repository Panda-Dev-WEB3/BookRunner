// Margin panel: deposit (approve exactly the amount to the engine, then depositMargin; works off-hours and
// reduce-only) and withdraw (at most the safe maximum the API computes; with a position open, the signed price is
// relayed first). Prepared by the API (trade.deposit / trade.withdraw), verified against the chain's PoolEngine.
import { useState } from "react";
import { trpc } from "../../api/trpc";
import { USDC_DECIMALS, amountIssue, normalizeAmount, parseAmount } from "../../lib/amount";
import type { TradeMarket, TradePositionOut } from "../../lib/api-types";
import { usdRaw } from "../../lib/format";
import { WalletButton } from "../../wallet/WalletButton";
import { IconArrowRight } from "../icons";
import { AmountInput, Card, ErrorState, Spinner, Tabs } from "../ui";
import { Prepared } from "./TradeBits";

type Tab = "deposit" | "withdraw";

function Preparing() {
  return (
    <span className="inline-flex items-center gap-2 text-[12.5px] text-ink-2">
      <Spinner size={14} /> Preparing the transactions…
    </span>
  );
}

function DepositTab(props: { m: TradeMarket; address: string | null; walletUsd: bigint | null }) {
  const [value, setValue] = useState("");
  const dep = trpc.trade.deposit.useMutation();
  const raw = parseAmount(value, USDC_DECIMALS);
  const issue = amountIssue(value, { balance: props.walletUsd });
  const reset = () => dep.reset();
  return (
    <div className="space-y-4">
      <AmountInput
        id="trade-deposit"
        label="Margin to deposit"
        value={value}
        onChange={(v) => {
          setValue(v);
          if (dep.data || dep.error) reset();
        }}
        balance={props.address ? props.walletUsd : undefined}
        balanceLabel="In wallet"
        issue={issue}
        disabled={dep.isPending || !!dep.data}
        help="Isolated to this market. Adding margin is always possible, also off-hours and while the market is reduce-only."
      />
      {dep.error && <ErrorState compact error={dep.error} />}
      {dep.isPending && <Preparing />}
      {dep.data && props.address && (
        <Prepared
          txs={dep.data.txs}
          warnings={dep.data.warnings}
          signer={props.address}
          amount={raw}
          doneText="Margin deposited."
          onDone={() => {
            reset();
            setValue("");
          }}
          onBack={reset}
        />
      )}
      {!dep.data &&
        !dep.isPending &&
        (!props.address ? (
          <WalletButton label="Connect a wallet to deposit" />
        ) : (
          <button
            type="button"
            className="btn btn-primary w-full sm:w-auto"
            disabled={issue !== null || raw === null}
            onClick={() => {
              const amountUsd = normalizeAmount(value);
              if (props.address && amountUsd) dep.mutate({ marketId: props.m.marketId, wallet: props.address, amountUsd });
            }}
          >
            Review deposit
            <IconArrowRight size={14} />
          </button>
        ))}
    </div>
  );
}

function WithdrawTab(props: { m: TradeMarket; address: string | null; position: TradePositionOut | undefined }) {
  const [value, setValue] = useState("");
  const wd = trpc.trade.withdraw.useMutation();
  const raw = parseAmount(value, USDC_DECIMALS);
  const max = usdRaw(props.position?.maxWithdrawUsd);
  const issue = amountIssue(value, { balance: max });
  const open = props.position && props.position.side !== "flat";
  const reset = () => wd.reset();
  return (
    <div className="space-y-4">
      <AmountInput
        id="trade-withdraw"
        label="Margin to withdraw"
        value={value}
        onChange={(v) => {
          setValue(v);
          if (wd.data || wd.error) reset();
        }}
        balance={props.address ? max : undefined}
        balanceLabel={open ? "Withdrawable now" : "Margin"}
        issue={issue}
        error={issue === "exceeds-balance" ? (open ? "Above what can leave while the position is open." : "Above your margin in this market.") : undefined}
        disabled={wd.isPending || !!wd.data}
        help={
          open
            ? props.m.margin.refusesUnholdable
              ? `With a position open, enough margin stays to keep it at or below ${props.m.margin.orderLeverageCap}x, the leverage it can hold through a session close (with room for a 1% move); the session must be open and no split pending. Reduce the position to free more.`
              : "With a position open, initial margin stays (with room for a 1% move), the session must be open and no split pending. Reduce the position to free more."
            : "With no position, all of your margin can be withdrawn at any time."
        }
      />
      {wd.error && <ErrorState compact error={wd.error} />}
      {wd.isPending && <Preparing />}
      {wd.data && props.address && (
        <Prepared
          txs={wd.data.txs}
          warnings={wd.data.warnings}
          signer={props.address}
          amount={raw}
          doneText="Margin withdrawn to your wallet."
          onDone={() => {
            reset();
            setValue("");
          }}
          onBack={reset}
        />
      )}
      {!wd.data &&
        !wd.isPending &&
        (!props.address ? (
          <WalletButton label="Connect a wallet to withdraw" />
        ) : (
          <button
            type="button"
            className="btn btn-primary w-full sm:w-auto"
            disabled={issue !== null || raw === null}
            onClick={() => {
              const amountUsd = normalizeAmount(value);
              if (props.address && amountUsd) wd.mutate({ marketId: props.m.marketId, wallet: props.address, amountUsd });
            }}
          >
            Review withdrawal
            <IconArrowRight size={14} />
          </button>
        ))}
    </div>
  );
}

export function MarginPanel(props: { m: TradeMarket; address: string | null; position: TradePositionOut | undefined }) {
  const [tab, setTab] = useState<Tab>("deposit");
  const walletUsd = usdRaw(props.position?.walletUsd);
  return (
    <Card padding="none" className="overflow-hidden" aria-label="Margin">
      <div className="px-4 pt-2 sm:px-5">
        <Tabs
          ariaLabel="Margin"
          value={tab}
          onChange={(id) => setTab(id as Tab)}
          keepMounted
          panelClassName="pb-5 pt-5"
          items={[
            { id: "deposit", label: "Deposit margin", content: <DepositTab m={props.m} address={props.address} walletUsd={walletUsd} /> },
            { id: "withdraw", label: "Withdraw margin", content: <WithdrawTab m={props.m} address={props.address} position={props.position} /> },
          ]}
        />
      </div>
    </Card>
  );
}
