import "@fontsource-variable/inter/wght.css";
import "#src/global.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";

import { queryClient } from "#src/query-client.ts";
import { router } from "#src/router.tsx";

const rootElement = document.querySelector("#root");
if (rootElement === null) {
  throw new Error("index.html must contain the #root element.");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
