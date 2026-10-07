import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import "./index.css";
import { ApiError } from "./lib/api";
import { AppStateProvider } from "./lib/state";
import { Compare } from "./pages/Compare";
import { Dashboard } from "./pages/Dashboard";
import { ExperimentDetail } from "./pages/ExperimentDetail";
import { Experiments } from "./pages/Experiments";
import { ThreadDetail } from "./pages/ThreadDetail";
import { TraceDetail } from "./pages/TraceDetail";
import { Traces } from "./pages/Traces";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      placeholderData: (prev: unknown) => prev,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppStateProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="traces" element={<Traces />} />
              <Route path="traces/:traceId" element={<TraceDetail />} />
              {/* Threads live under Traces (By thread); old links still land there. */}
              <Route path="threads" element={<Navigate to="/traces" replace />} />
              <Route path="threads/:threadId" element={<ThreadDetail />} />
              <Route path="compare" element={<Compare />} />
              <Route path="experiments" element={<Experiments />} />
              <Route path="experiments/:experimentId" element={<ExperimentDetail />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AppStateProvider>
    </QueryClientProvider>
  </StrictMode>,
);
