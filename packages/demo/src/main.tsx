import React from "react";
import { createRoot } from "react-dom/client";
import Director from "./Director";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <React.StrictMode>
    <Director />
  </React.StrictMode>,
);
