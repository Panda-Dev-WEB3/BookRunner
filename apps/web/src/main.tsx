import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { WagmiProvider } from "wagmi";
import { createQueryClient, createTrpcClient, trpc } from "./api/trpc";
import { router } from "./router";
import "./styles.css";
import { wagmiConfig } from "./wallet/chains";
import { ConnectModalProvider } from "./wallet/ConnectModal";
import { WalletProvider } from "./wallet/WalletContext";

function Root() {
  const [queryClient] = useState(createQueryClient);
  const [trpcClient] = useState(createTrpcClient);
  return (
    <WagmiProvider config={wagmiConfig}>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <WalletProvider>
            <ConnectModalProvider>
              <RouterProvider router={router} />
            </ConnectModalProvider>
          </WalletProvider>
        </QueryClientProvider>
      </trpc.Provider>
    </WagmiProvider>
  );
}

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
