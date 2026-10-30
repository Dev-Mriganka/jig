import "react-diff-view/style/index.css";
import "./styles.css";

import { createRoot } from "react-dom/client";

import { App } from "./App.js";

const root = document.querySelector("#root");

if (root === null) {
  throw new Error("Unable to find React root element.");
}

createRoot(root).render(<App />);
