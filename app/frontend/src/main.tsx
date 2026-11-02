import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Tooltip } from "radix-ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import App from "./App";
import { useUi } from "./store";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

function ThemedToaster() {
  const theme = useUi((s) => s.theme);
  return <Toaster position="bottom-center" theme={theme} richColors closeButton duration={3500} toastOptions={{ className: "font-sans" }} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider delayDuration={350} skipDelayDuration={150}>
        <App />
        <ThemedToaster />
      </Tooltip.Provider>
    </QueryClientProvider>
  </StrictMode>,
);
