/**
 * The project declaration for the #98 resource fixture.
 *
 * Entry and target only; the resource behaviour lives in `cells/static-assets/src/`, so the
 * fixture stays a real project rather than a directory of files a test reads by path.
 */
import { defineForguncyConfig } from "@forguncy-react-workspace/core";

export default defineForguncyConfig({
  cells: {
    staticAssets: {
      entry: "./cells/static-assets/src/index.tsx",
      target: { pageName: "资源", cell: "A1" },
    },
  },
});
