import { defineForguncyViteConfig } from "@forguncy-react-workspace/dev-harness";
import { todoDevTools } from "./devtools.ts";
import config from "./forguncy.config.ts";

export default defineForguncyViteConfig(
  { config },
  {
    devtools: { apply: "serve" },
    plugins: [todoDevTools()],
  },
);
