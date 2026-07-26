/* @clankImportSource @clank.run/framework */
import { hydrate } from "@clank.run/framework";
import { StarterView } from "./view.tsx";

hydrate(document.getElementById("app")!, <StarterView />);
