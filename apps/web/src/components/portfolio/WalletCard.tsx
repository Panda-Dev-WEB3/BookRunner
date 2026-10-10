// The connected wallet at a glance: name, address (copy + explorer), network and ETH / USDC / BKRN
// balances on the app chain.
import type { ReactNode } from "react";
import { BKRN_DECIMALS, ETH_DECIMALS, USDC_DECIMALS, formatAmountDisplay } from "../../lib/amount";
import { gasStatus } from "../../lib/chainConfig";
import { addressUrl, config } from "../../lib/config";
import { shortHex } from "../../lib/format";
import { useWalletBalances } from "../../wallet/balances";
import { appChain, chainName } from "../../wallet/chains";
import { isTestChain } from "../../wallet/network";
import { useSettlementSymbol } from "../../wallet/settlementSymbol";
import { useWallet } from "../../wallet/WalletContext";
import { cx } from "../cx";
import { IconExternal, IconWallet } from "../icons";
import { Term } from "../Term";
import { Badge, Card, CopyButton, ExternalLink } from "../ui";

function Balance(props: { label: ReactNode; value: bigint | null | undefined; decimals: number; dp: number; symbol: string; dot: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <dt className="flex items-center gap-2 text-[13px] text-ink-2">
        <span className={cx("size-2 shrink-0 rounded-full", props.dot)} aria-hidden />
        {props.label}
      </dt>
      <dd className="num text-[14px] font-medium text-ink">
        {props.value === undefined ? <span className="text-muted">Loading…</span> : props.value === null ? <span className="text-muted">unavailable</span> : `${formatAmountDisplay(props.value, props.decimals, props.dp)} ${props.symbol}`}
      </dd>
    </div>
  );
}

export function WalletCard({ className }: { className?: string }) {
  const w = useWallet();
  const bal = useWalletBalances();
  const sym = useSettlementSymbol();
  const a = w.active;
  if (!a) return null;
  const explorer = addressUrl(a.address);
  const gas = gasStatus(bal.eth ?? null);
  const lowGas = bal.eth !== undefined && (gas === "empty" || gas === "low");
  return (
    <Card as="section" aria-label="Your wallet" className={className}>
      <div className="flex items-start gap-3">
        {a.icon ? (
          <img src={a.icon} alt="" width={40} height={40} className="size-10 shrink-0 rounded-[10px]" />
        ) : (
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft text-accent-text" aria-hidden>
            <IconWallet size={20} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold text-ink">{a.label}</h2>
          <div className="mt-0.5 flex items-center gap-1">
            <span className="num truncate text-[12.5px] text-ink-2" title={a.address}>
              {shortHex(a.address, 8, 6)}
            </span>
            <CopyButton value={a.address} label="Copy your address" />
            {explorer && (
              <a
                href={explorer}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex rounded-[5px] p-0.5 text-muted hover:text-ink"
                aria-label="View your address on the block explorer (opens in a new tab)"
                title="View on the explorer"
              >
                <IconExternal size={13} />
              </a>
            )}
          </div>
        </div>
        {w.wrongNetwork ? (
          <Badge tone="critical" dot size="sm" title="Your wallet is on another network">
            {chainName(a.chainId)}
          </Badge>
        ) : (
          <Badge tone="good" dot size="sm">
            {isTestChain ? "Testnet" : appChain.name}
          </Badge>
        )}
      </div>
      <dl className="mt-3 divide-y divide-line border-t border-line">
        <Balance
          label={
            <>
              ETH for <Term id="gas">gas</Term>
            </>
          }
          value={bal.eth}
          decimals={ETH_DECIMALS}
          dp={4}
          symbol="ETH"
          dot="bg-muted"
        />
        <Balance label={isTestChain ? `Test ${sym}` : sym} value={bal.usdc} decimals={USDC_DECIMALS} dp={2} symbol={sym} dot="bg-fee" />
        <Balance
          label={
            <>
              <Term id="bkrn">BKRN</Term> in wallet
            </>
          }
          value={bal.bkrn}
          decimals={BKRN_DECIMALS}
          dp={2}
          symbol="BKRN"
          dot="bg-backstop"
        />
      </dl>
      {lowGas && (
        <p className="mt-2 rounded-control bg-warn/10 px-3 py-2 text-[12.5px] text-ink-2">
          {gas === "empty" ? "No ETH for gas yet: claims and redemption requests need a little." : "Gas is running low: keep a little ETH for claims and redemption requests."}{" "}
          {isTestChain && config.faucetUrl && (
            <ExternalLink href={config.faucetUrl} className="link font-medium">
              Get free testnet ETH
            </ExternalLink>
          )}
        </p>
      )}
      {explorer && (
        <div className="mt-3 border-t border-line pt-3 text-[12.5px]">
          <ExternalLink href={explorer}>Every transaction of this address on the explorer</ExternalLink>
        </div>
      )}
    </Card>
  );
}
