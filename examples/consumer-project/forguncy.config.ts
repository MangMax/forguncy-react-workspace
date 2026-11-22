import { defineForguncyConfig } from "@forguncy-react-workspace/core";

/**
 * The project declaration — the one file a consumer edits to say what a Cell is and where it goes.
 *
 * Decision source: GitHub Issue #99
 * (https://github.com/MangMax/forguncy-react-workspace/issues/99), under #26's document contract
 * (https://github.com/MangX/forguncy-react-workspace/issues/26) and #85's project-level
 * `extensions.mappings` input (https://github.com/MangX/forguncy-react-workspace/issues/85).
 *
 * ## One file, four consumers
 *
 * | consumer | reads |
 * | --- | --- |
 * | `vp dev` (#23) | `entry`, `fixture`, `runtime`, and the extension rows below |
 * | `fgc-cell build` / `plan` / `sync` (#99) | `entry`, `output`, `extensions`, and the `target` each Cell goes to |
 * | the dependency Skill (#18) | `cells.<id>.output.codeBudgetCharacters` when a record is Cell-scoped |
 *
 * All four read *this* object, which is why nothing here is duplicated into a second config or a
 * `vite.config.ts` literal.
 *
 * ## The extension row is a project row
 *
 * `@example/chart-panel` is mapped by this file and not by the tool's built-in table: the row says
 * how an `extension` *decision* would compile and never that a decision should be one — the
 * strategy lives in `fgc.lock.json` (Issues #4/#8). The identity below is a declared placeholder,
 * which is what #85's path is for; the real extension is packaged and validated elsewhere, and a
 * mapping alone claims nothing about whether it exists.
 *
 * `sales.overview` deliberately declares no `codeBudgetCharacters`: a cap is a decision about how
 * big this Cell may get, and a project that has not measured its Cell should not invent one. The
 * build reports the actual size either way.
 */
export default defineForguncyConfig({
  runtime: {
    // The version this project targets. Recorded, not checked: nothing here talks to a Forguncy
    // project, and claiming otherwise would be the compatibility claim AGENTS.md rule 6 forbids.
    forguncyVersion: "12.0.101",
    projectAlias: "consumer-example",
  },
  extensions: {
    mappings: [
      {
        packageName: "@example/chart-panel",
        libraryId: "example-chart-panel",
        globalName: "ExampleChartPanel",
        metadataSource: "verified-catalog",
        metadataReference: "MangMax/forguncy-react-library#example-chart-panel",
        verificationRule:
          "The catalog entry indexes the vendor module the extension bundle contains behind one page global. The id and global here are this project's declaration; a real page's `api.app.listFrontendLibraries` is what confirms them, and that has not been run for this example.",
        verifiedBy: ["product-documentation"],
        note: "A project row, not a repository row: the built-in table is unchanged, and this entry exists to show a consumer project supplying a mapping without editing the tool.",
      },
    ],
  },
  cells: {
    salesOverview: {
      entry: "./cells/sales-overview/src/App.tsx",
      fixture: "./cells/sales-overview/fixture.ts",
      target: { pageName: "销售看板", cell: "B2" },
    },
  },
});
