import { describe, expect, it } from "vitest";

import { CELL_ENTRY_SHAPES, CELL_RUNTIME_BINDING_CONTRACT, findCellEntryShape } from "@forguncy-react-workspace/core";

import {
  CELL_ARTIFACT_DEFAULT_ENTRY_KIND,
  CELL_ENTRY_COMPONENT_BINDING,
  CELL_ENTRY_COMPONENT_PLACEHOLDER,
  CELL_ENTRY_LIVE_PROPS_PLACEHOLDER,
  CELL_ENTRY_WRAPPER_HOST_NAMES,
  CELL_ENTRY_WRAPPER_SUPPORT,
  JAVASCRIPT_IDENTIFIER_PATTERN,
  acceptedButNotEmittableCellEntryKinds,
  cellEntryWrapperHostNames,
  cellEntryWrapperNamesAreVerified,
  expressibleCellEntryKinds,
  findCellEntryWrapperSupport,
  renderCellEntryWrapper,
  runtimeContractEmittableCellEntryKinds,
} from "./entry.ts";
import { scanCellArtifactSource } from "./source-guard.ts";

describe("entry wrapper support table", () => {
  // A new entry shape in the runtime contract must force an edit here rather than
  // defaulting to "not emitted because nobody thought about it".
  it("covers every entry shape the runtime contract records, exactly once", () => {
    const supported = CELL_ENTRY_WRAPPER_SUPPORT.map(support => support.kind);
    const recorded = CELL_ENTRY_SHAPES.map(shape => shape.id);

    expect([...supported].sort()).toEqual([...recorded].sort());
    expect(new Set(supported).size).toBe(supported.length);
  });

  it("has exactly one default, and it is expressible", () => {
    const defaults = CELL_ENTRY_WRAPPER_SUPPORT.filter(support => support.isDefault);
    expect(defaults.map(support => support.kind)).toEqual([CELL_ARTIFACT_DEFAULT_ENTRY_KIND]);
    expect(findCellEntryWrapperSupport(CELL_ARTIFACT_DEFAULT_ENTRY_KIND).expressible).toBe(true);
    expect(CELL_ARTIFACT_DEFAULT_ENTRY_KIND).toBe("app-function-declaration");
  });

  it("gives every row a reason, so an omission is a decision and not a gap", () => {
    for (const support of CELL_ENTRY_WRAPPER_SUPPORT) {
      expect(support.note.trim().length, support.kind).toBeGreaterThan(20);
      if (support.expressible) {
        expect(support.template, support.kind).toBeDefined();
        expect(support.template, support.kind).toContain(CELL_ENTRY_COMPONENT_PLACEHOLDER);
      } else {
        expect(support.template, support.kind).toBeUndefined();
      }
    }
  });

  // The asymmetry is the point: this contract may emit a subset of what the
  // runtime accepts, and never anything the runtime records as non-rendering.
  it("only emits shapes the runtime contract says both validate and render", () => {
    const runtimeEmittable = runtimeContractEmittableCellEntryKinds();
    for (const kind of expressibleCellEntryKinds()) {
      expect(runtimeEmittable, kind).toContain(kind);
    }

    // The shapes that validate and then fail are excluded either way.
    expect(expressibleCellEntryKinds()).not.toContain("app-async-function-declaration");
    expect(expressibleCellEntryKinds()).not.toContain("no-entry");
  });

  it("separates an accepted shape it cannot emit from one that breaks the target", () => {
    const accepted = acceptedButNotEmittableCellEntryKinds();
    expect(accepted).toContain("whole-source-expression");

    // Not the same failure: this one renders, it just cannot share a source with
    // a bundled body.
    expect(findCellEntryShape("whole-source-expression").renderedAtRuntime).toBe(true);
    expect(findCellEntryShape("app-async-function-declaration").renderedAtRuntime).toBe(false);
    expect(findCellEntryShape("no-entry").renderedAtRuntime).toBe(false);
  });

  it("rejects an unknown entry shape instead of returning undefined", () => {
    // @ts-expect-error an unknown id must not be accepted at the type level either
    expect(() => findCellEntryWrapperSupport("not-a-shape")).toThrow(/Unknown ReactCellType entry shape/);
  });
});

describe("rendered entry wrapper", () => {
  it("emits a function App binding by default", () => {
    const rendered = renderCellEntryWrapper();
    expect(rendered.status).toBe("emitted");
    if (rendered.status !== "emitted") return;

    expect(rendered.kind).toBe("app-function-declaration");
    expect(rendered.source).toBe(
      `function App(props) {\n  return React.createElement(${CELL_ENTRY_COMPONENT_BINDING}, props);\n}`,
    );
  });

  // The whole reason this module exists: a wrapper that carries a construct the
  // platform refuses would be rejected at write time, and one that declares no
  // entry would be accepted and render nothing.
  it("emits a wrapper the source guard accepts, for every expressible shape", () => {
    for (const kind of expressibleCellEntryKinds()) {
      const rendered = renderCellEntryWrapper({ entryKind: kind });
      expect(rendered.status, kind).toBe("emitted");
      if (rendered.status !== "emitted") continue;

      expect(scanCellArtifactSource(rendered.source), kind).toEqual([]);

      // The platform resolves an entry from a `render(value)` call, an `App`
      // binding, or a top-level element binding, in that order — so the emitted
      // source has to start with one of those at top level, never nested.
      const [firstLine = ""] = rendered.source.split("\n");
      expect(
        /^(function App|var App|const App|class App|const element|render\()/.test(firstLine),
        `${kind}: ${firstLine}`,
      ).toBe(true);

      expect(rendered.source).not.toContain(CELL_ENTRY_COMPONENT_PLACEHOLDER);
      expect(rendered.source).toContain(CELL_ENTRY_COMPONENT_BINDING);
    }
  });

  // The binding used to be a caller option, which could not work: the bundler
  // never learned the name, so any other value produced a wrapper referencing an
  // identifier nothing declared. It is fixed now, and being fixed is only safe if
  // the one value is actually a usable identifier — which is a property of our
  // constant, so it is a test rather than a runtime branch on caller input.
  it("keeps the single component binding a legal identifier nothing else can shadow", () => {
    expect(JAVASCRIPT_IDENTIFIER_PATTERN.test(CELL_ENTRY_COMPONENT_BINDING)).toBe(true);
    expect(CELL_ENTRY_COMPONENT_BINDING.startsWith("__")).toBe(true);
    // Not a name a generated wrapper may reference from the host, so it cannot be
    // confused with a verified binding.
    expect(CELL_ENTRY_WRAPPER_HOST_NAMES).not.toContain(CELL_ENTRY_COMPONENT_BINDING);
    // Negative cases, so the pattern is known to discriminate rather than accept
    // anything.
    for (const invalid of ["", "has space", "1leading", "has-dash", "a.b"]) {
      expect(JAVASCRIPT_IDENTIFIER_PATTERN.test(invalid), invalid).toBe(false);
    }
    // `$` and `_` are legal identifier characters, so they must be accepted.
    expect(JAVASCRIPT_IDENTIFIER_PATTERN.test("$_ok")).toBe(true);
  });

  it("uses only names the runtime contract verified inside cell source", () => {
    expect(cellEntryWrapperNamesAreVerified()).toBe(true);
    // An invented global is exactly the mistake the guard has to catch, so the
    // check has to be able to fail as well as pass.
    expect(cellEntryWrapperNamesAreVerified(["React", "ReactDOMServer"])).toBe(false);
    expect(cellEntryWrapperNamesAreVerified(["props", "useState"])).toBe(true);
  });

  // The guard above is only meaningful if the declaration it reads is honest, so
  // the declared names are checked against the template text they describe. A
  // declaration is what makes the union derivable; this is what stops it drifting
  // away from the code.
  it("declares exactly the verified names its templates actually reference", () => {
    for (const support of CELL_ENTRY_WRAPPER_SUPPORT) {
      const declared = cellEntryWrapperHostNames(support.kind);

      if (!support.expressible) {
        expect(declared, support.kind).toEqual([]);
        continue;
      }

      expect(declared.length, support.kind).toBeGreaterThan(0);
      for (const name of declared) {
        expect(support.template, `${support.kind} must reference ${name}`).toContain(name);
      }

      // The union is derived from these per-kind declarations, so it must equal
      // the set of everything declared.
      expect(CELL_ENTRY_WRAPPER_HOST_NAMES).toEqual(expect.arrayContaining([...declared]));
    }

    // `render` is the one name only a single shape needs, which is what makes it
    // worth checking that the union is a real union rather than one row's list.
    expect(cellEntryWrapperHostNames("render-call")).toContain("render");
    expect(cellEntryWrapperHostNames("app-function-declaration")).not.toContain("render");
  });

  it("honours an explicitly requested shape", () => {
    const rendered = renderCellEntryWrapper({ entryKind: "render-call" });
    expect(rendered.status).toBe("emitted");
    if (rendered.status !== "emitted") return;
    expect(rendered.kind).toBe("render-call");
    expect(rendered.source).toBe(`render(React.createElement(${CELL_ENTRY_COMPONENT_BINDING}, props));`);
  });

  it("refuses a shape it cannot emit instead of silently substituting one", () => {
    for (const kind of ["app-async-function-declaration", "no-entry", "whole-source-expression"] as const) {
      const rendered = renderCellEntryWrapper({ entryKind: kind });
      expect(rendered.status, kind).toBe("unsupported");
      if (rendered.status !== "unsupported") continue;
      expect(rendered.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["rejected-cell-entry-shape"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Live props (#83)
// ---------------------------------------------------------------------------

describe("the live-props wrapper a façade-importing artifact needs", () => {
  it("publishes this call's props into the binding's variable, for every shape that can", () => {
    // #83's reproduced defect: the provider was built from one `props` snapshot, so every
    // façade call after a property change answered the first evaluation's values. The wrapper
    // is now the place a re-render is met, and it has to carry the assignment — an emitted
    // wrapper without it would leave the binding's reader pointing at a stale value while
    // every façade check kept passing.
    for (const kind of expressibleCellEntryKinds()) {
      const rendered = renderCellEntryWrapper({ entryKind: kind, runtimeBinding: true });
      if (rendered.status === "unsupported") {
        // Only the two expression-only shapes may refuse, and the refusal is checked below.
        expect(["render-call", "top-level-element-variable"], kind).toContain(kind);
        continue;
      }
      expect(rendered.source, kind).toContain(`${CELL_RUNTIME_BINDING_CONTRACT.livePropsVariable} = `);
      // The assignment must precede the element, or the binding would read the previous
      // render's props for exactly the render that changed them.
      const assignment = rendered.source.indexOf(`${CELL_RUNTIME_BINDING_CONTRACT.livePropsVariable} = `);
      const placement = rendered.source.indexOf("React.createElement");
      expect(assignment, kind).toBeLessThan(placement);
      // A shape whose live template refuses to mention it would ship a stale artifact.
      expect(rendered.source, kind).not.toContain(CELL_ENTRY_LIVE_PROPS_PLACEHOLDER);
    }
  });

  it("refuses an expression-only shape for a façade-importing artifact, rather than emitting a stale wrapper", () => {
    // `render-call` and `top-level-element-variable` run once, at artifact evaluation, so
    // there is no per-render entry to publish props through. Emitting the plain template for
    // an artifact that imports the façade would be the #83 defect with nothing failing to
    // reveal it, which is why this is a rejection rather than a silent substitution.
    for (const kind of ["render-call", "top-level-element-variable"] as const) {
      const rendered = renderCellEntryWrapper({ entryKind: kind, runtimeBinding: true });
      expect(rendered.status, kind).toBe("unsupported");
      if (rendered.status !== "unsupported") continue;
      // The wording lands in `message` (the factory appends `detail` to `states`), so the
      // shape is asserted on the value that carries it.
      expect(rendered.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["rejected-cell-entry-shape"]);
      expect(rendered.diagnostics[0]?.message ?? "", kind).toContain("#83");
    }
  });

  it("emits the plain wrapper by default, so a façade-free artifact carries no free identifier", () => {
    // The default is load-bearing: the live template names a variable only the generated
    // binding declares, and a wrapper that assigned to a name nothing declared would throw
    // `ReferenceError` at the first render. A caller that does not know therefore must get
    // the plain wrapper.
    expect(renderCellEntryWrapper()).toEqual(renderCellEntryWrapper({ runtimeBinding: false }));
    for (const kind of expressibleCellEntryKinds()) {
      const plain = renderCellEntryWrapper({ entryKind: kind });
      if (plain.status !== "emitted") continue;
      expect(plain.source, kind).not.toContain(CELL_RUNTIME_BINDING_CONTRACT.livePropsVariable);
    }
  });

  it("keeps the live templates' host names inside the declaration", () => {
    // The live templates add no host name — they add an artifact-scope *variable*, which is
    // not a host address. Asserting it here is what keeps a later edit from reaching for a
    // page global and having the declaration still pass, because the declaration is only
    // checked against the plain templates.
    const liveNames = new Set<string>();
    for (const support of CELL_ENTRY_WRAPPER_SUPPORT) {
      if (support.livePropsTemplate === undefined) continue;
      for (const name of ["React", "props", "render"]) {
        if (new RegExp(`\\b${name}\\b`).test(support.livePropsTemplate.replace(CELL_ENTRY_LIVE_PROPS_PLACEHOLDER, ""))) {
          liveNames.add(name);
        }
      }
    }
    for (const name of liveNames) {
      expect(cellEntryWrapperHostNames("app-function-declaration").includes(name) || cellEntryWrapperHostNames("render-call").includes(name), name).toBe(true);
    }
  });
});
